import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { isRunnerId } from '../core/agent-runner.ts';
import { detectEnvironment, type BackendCheck } from '../core/backend-detect.ts';
import {
  CANCEL,
  type InstallContext,
  type InstallStep,
  type Runner,
  type StepArtifact,
} from './types.ts';

/**
 * Platform-agnostic step helpers. The star is `sudoStep`: the wizard runs as a
 * normal account and never escalates silently. It prints the exact command,
 * lets the operator run it via `sudo` or run it themselves, then proves the box
 * is actually in the expected state with `verify()` before advancing — and
 * offers a redo when verification fails.
 */

/** Real command runner (Node child_process). */
export const defaultRunner: Runner = {
  capture(program, args, opts) {
    // spawn (not execFile) so a secret can be fed via stdin instead of argv.
    return new Promise((resolve) => {
      const child = spawn(program, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d) => (stdout += String(d)));
      child.stderr?.on('data', (d) => (stderr += String(d)));
      child.on('error', () => resolve({ code: 127, stdout, stderr }));
      child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
      // A child that exits before draining stdin makes the write emit EPIPE;
      // swallow it so `capture` never crashes the CLI.
      child.stdin?.on('error', () => {});
      if (opts?.input != null) child.stdin?.end(opts.input);
      else child.stdin?.end();
    });
  },
  interactive(program, args, opts) {
    return new Promise((resolve) => {
      // With `input`, stdin is piped (sudo still prompts on /dev/tty, not stdin).
      // `env` adds variables for in-child `$VAR` expansion — the other secret
      // channel besides stdin that keeps values out of argv.
      const child = spawn(program, args, {
        stdio: [opts?.input != null ? 'pipe' : 'inherit', 'inherit', 'inherit'],
        env: opts?.env ? { ...process.env, ...opts.env } : undefined,
      });
      child.on('error', () => resolve(127));
      child.on('close', (code) => resolve(code ?? 0));
      if (opts?.input != null) {
        child.stdin?.on('error', () => {}); // EPIPE if the child exits early
        child.stdin?.end(opts.input);
      }
    });
  },
};

/** Run a probe and assert its result. Returns false in dry-run (nothing is verifiably present). */
export async function verifyCommand(
  ctx: InstallContext,
  program: string,
  args: string[],
  matcher: (r: { code: number; stdout: string; stderr: string }) => boolean = (r) => r.code === 0,
): Promise<boolean> {
  if (ctx.dryRun) return false;
  return matcher(await ctx.runner.capture(program, args));
}

/**
 * True when `sudo -n true` succeeds — the box grants passwordless sudo, OR a
 * sudo timestamp from an earlier command in this session is still cached.
 * Both mean "sudo will run right now without prompting", which is exactly the
 * question `--yes` mode needs answered before choosing sudo over delegate.
 */
export async function hasPasswordlessSudo(ctx: InstallContext): Promise<boolean> {
  if (ctx.dryRun) return false;
  return (await ctx.runner.capture('sudo', ['-n', 'true'])).code === 0;
}

/** A bare DNS hostname — no scheme, no path, no shell/nginx metacharacters. */
export const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9](-?[a-z0-9])*\.)+[a-z]{2,}$/i;

export class StepCancelled extends Error {}
export class StepAborted extends Error {}
/** Thrown from an optional step's `run()` to record it as `skipped` (e.g. certbot DNS not ready). */
export class StepSkipped extends Error {}

export interface SudoStepOpts {
  /** One-line description of what/why (shown above the command). */
  description: string;
  /** The privileged shell command (without a leading `sudo`). May use pipes/redirects. */
  command: string;
  /**
   * Optional human-readable context (e.g. the file contents being written) shown
   * in its own box before the raw command — keeps big base64 file-writes legible.
   */
  note?: string;
  /**
   * Optional step: when verification keeps failing the operator can *skip* it
   * (thrown as `StepSkipped`) instead of aborting the whole install. Used by SSL
   * (certbot can legitimately fail on external DNS / rate limits).
   */
  skippable?: boolean;
  /** Shown next to the "Skip" choice — how to finish this step by hand later. */
  skipHint?: string;
  /**
   * Secret payload fed to the command's stdin (`cat > file` style) so it never
   * appears in the process argv (`ps`-readable) or in root's shell history.
   * Sudo mode pipes it; delegate mode shows it once, on screen only, for the
   * operator to paste after the command.
   */
  input?: string;
  /** Human name for the stdin payload, e.g. "credential line". */
  inputLabel?: string;
  /** Prove the command actually took effect. Runs after every attempt. */
  verify: (ctx: InstallContext) => Promise<boolean>;
}

/**
 * A strong random cockpit password: guaranteed to mix lower/upper letters, a
 * digit and a symbol, drawn from a crypto RNG, with visually-ambiguous glyphs
 * (0/O/1/l/I) removed. Offered by the identity step so operators don't fall back
 * to a weak hand-picked password.
 */
export function generatePassword(length = 16): string {
  const lower = 'abcdefghijkmnpqrstuvwxyz'; // no l
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I, O
  const digits = '23456789'; // no 0, 1
  const symbols = '!@#$%^&*-_=+';
  const all = lower + upper + digits + symbols;
  const pick = (set: string) => set.charAt(randomInt(set.length));
  const chars = [pick(lower), pick(upper), pick(digits), pick(symbols)];
  while (chars.length < Math.max(length, 8)) chars.push(pick(all));
  // Fisher–Yates shuffle so the guaranteed-class chars aren't always in front.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    const tmp = chars[i] as string;
    chars[i] = chars[j] as string;
    chars[j] = tmp;
  }
  return chars.join('');
}

/**
 * Execute one privileged command with the operator in the loop:
 * print → run-via-sudo OR delegate → verify → redo-on-mismatch.
 *
 * - Dry-run: prints the intended command and returns (no exec, no verify).
 * - `--yes` with passwordless sudo: runs non-interactively.
 * - `--yes` without passwordless sudo: falls back to delegate (never blocks on a hidden prompt).
 *
 * Throws `StepCancelled` if the user cancels, `StepAborted` if they give up after a failed verify.
 */
/** Single-quote a shell string so a copy-paste of `display` runs exactly what we run. */
export function shquote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export async function sudoStep(ctx: InstallContext, opts: SudoStepOpts): Promise<void> {
  const { ui } = ctx;
  // What we actually run — and what the operator copy-pastes in the delegate path.
  const display = `sudo bash -lc ${shquote(opts.command)}`;

  if (ctx.dryRun) {
    ui.info(
      opts.input != null
        ? `DRY RUN — would run: ${display} (with the ${opts.inputLabel ?? 'payload'} on stdin)`
        : `DRY RUN — would run: ${display}`,
    );
    return;
  }

  const passwordless = await hasPasswordlessSudo(ctx);

  for (;;) {
    ui.info(opts.description);
    if (opts.note) ui.message(opts.note);
    ui.message(display);

    let mode: 'sudo' | 'delegate';
    if (ctx.assumeYes) {
      mode = passwordless ? 'sudo' : 'delegate';
    } else if (ctx.prefs.sudoMode) {
      // Remembered from an earlier answer — don't ask again this run (issue #6).
      mode = ctx.prefs.sudoMode;
    } else {
      // Default to "I'll run it myself as root" — the safe, no-surprise choice
      // for operators who prefer to paste privileged commands into a root shell.
      const choice = await ui.select<'sudo' | 'delegate'>({
        message: 'How should this privileged command run?',
        options: [
          { value: 'delegate', label: "I'll run it myself as root", hint: 'paste & run as root, then confirm' },
          { value: 'sudo', label: 'Run it now via sudo', hint: 'streams output here' },
        ],
        initialValue: 'delegate',
      });
      if (choice === CANCEL) throw new StepCancelled();
      mode = choice;
      ctx.prefs.sudoMode = choice; // reuse this choice for every later privileged command
    }

    if (mode === 'sudo') {
      const code = await ctx.runner.interactive(
        'sudo',
        ['bash', '-lc', opts.command],
        opts.input != null ? { input: opts.input } : undefined,
      );
      if (code !== 0) ui.warn(`command exited with code ${code}`);
    } else {
      ui.info('Copy the command above and run it as root on the server (paste into a root shell, or prefix with sudo), then confirm below.');
      if (opts.input != null) {
        if (ctx.assumeYes) {
          /**
           * **Unattended delegate mode prints NOTHING of the payload.** ADDED 2026-08-07
           * (phase 6/7 repair stage). `--yes` on a box without passwordless sudo lands here — a CI
           * or IaC run — where there is by definition no human watching to paste anything, so the
           * only effect of echoing the payload is to write it into a job log, a `script`/tmux
           * transcript and scrollback. The step then fails its own `verify` a few lines below
           * regardless, because nobody ran the command. So this branch traded a real disclosure
           * for zero benefit.
           *
           * That matters more since phase 6/7 than it did before: `ubuntu-vps.ts`'s only stdin
           * payload is an apr1 htpasswd hash on a single-tenant box, while `hetzner.ts` feeds
           * `CEZ_SUPERVISOR_SECRET` — the key that signs every forwarded principal for one org —
           * and the supervisor's OIDC client secret through the same seam. D10's Risks entry names
           * this exact channel: "never `printf %s <content>` into the operator's terminal or a
           * sudo-note transcript."
           *
           * The INTERACTIVE delegate path below still shows it, and must: the operator is being
           * asked to paste it, and a secret they cannot see is a step they cannot complete.
           */
          ui.warn(
            `This command needs the ${opts.inputLabel ?? 'payload'} on stdin, and --yes cannot supply it without ` +
              `passwordless sudo. The value is deliberately NOT printed here (it would land in this job's log). ` +
              `Re-run interactively, or grant passwordless sudo, to complete this step.`,
          );
        } else {
          // Screen-only: pasted as stdin it stays out of argv AND shell history.
          ui.info(`The command reads from stdin — after starting it, paste this ${opts.inputLabel ?? 'line'} and press Ctrl-D:`);
          ui.message(opts.input);
        }
      }
      if (!ctx.assumeYes) {
        const done = await ui.confirm({ message: 'Have you run it as root?', initialValue: true });
        if (done === CANCEL) throw new StepCancelled();
      }
    }

    if (await opts.verify(ctx)) {
      ui.success('Verified.');
      return;
    }

    ui.error('That did not take effect — the verification check still fails.');
    if (ctx.assumeYes) {
      throw opts.skippable
        ? new StepSkipped(`verification failed for: ${opts.command}`)
        : new StepAborted(`verification failed for: ${opts.command}`);
    }
    if (opts.skippable) {
      const next = await ui.select<'retry' | 'skip'>({
        message: 'That did not verify. What now?',
        options: [
          { value: 'retry', label: 'Try again' },
          { value: 'skip', label: 'Skip this step', hint: opts.skipHint },
        ],
        initialValue: 'retry',
      });
      if (next === CANCEL) throw new StepCancelled();
      if (next === 'skip') throw new StepSkipped(`skipped: ${opts.command}`);
      continue;
    }
    const redo = await ui.confirm({ message: 'Try again?', initialValue: true });
    if (redo === CANCEL || redo === false) throw new StepAborted(`gave up on: ${opts.command}`);
  }
}

export interface ManualStepOpts {
  /** One-line description of what/why (shown above the commands). */
  description: string;
  /** The exact command(s) the operator runs themselves, on the host, as-is — no `sudo`/delegate
   *  wrapper. Unlike `sudoStep`, these are commands ONE runs interactively (a login flow reads
   *  from a real TTY, writes a browser URL, waits on a code) — there is no "run it via sudo
   *  non-interactively" mode for them to offer. */
  commands: string[];
  /** Optional context shown once, above the commands. */
  note?: string;
}

/**
 * Stop the install for something genuinely unscriptable — an interactive agent CLI login being
 * the motivating case (spec `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, Phase 4: "the run
 * must stop and say so rather than half-provisioning silently"). Prints the exact commands, then:
 *
 * - `--yes` (unattended: CI, IaC, a `npx … --join …` one-liner with no human watching) can never
 *   supply a human at a login prompt, so this ALWAYS throws `StepAborted` here — naming the
 *   commands still to run and that re-running this install resumes past this step. A half-open
 *   agent login recorded as "done" would be the exact silent half-provisioning this exists to
 *   prevent.
 * - Interactive: the wizard pauses at a confirm, exactly the shape `sudoStep`'s own delegate mode
 *   already uses for every privileged command in this codebase — the operator runs the printed
 *   command(s) themselves, in another window, then answers here. Defaults to **false**: a
 *   yes/no this easy to rubber-stamp should never default toward "done".
 */
export async function requireManualLogin(ctx: InstallContext, opts: ManualStepOpts): Promise<void> {
  const { ui } = ctx;
  ui.info(opts.description);
  if (opts.note) ui.message(opts.note);
  for (const command of opts.commands) ui.message(`  ${command}`);

  if (ctx.assumeYes) {
    throw new StepAborted(
      `${opts.description} — this cannot be completed unattended (--yes). Run the command(s) above ` +
        'interactively, then re-run this install to continue past this step.',
    );
  }

  const done = await ui.confirm({ message: 'Have you completed the login(s) above?', initialValue: false });
  if (done === CANCEL) throw new StepCancelled();
  if (done !== true) {
    throw new StepAborted('Login not confirmed — re-run this install once the command(s) above are done.');
  }
}

/** Convenience: an `owned` file/service/etc. artifact. */
export function owned(type: string, fields: Omit<StepArtifact, 'kind' | 'type'>): StepArtifact {
  return { kind: 'owned', type, ...fields };
}
/** Convenience: a `shared` artifact (listed, not removed, on uninstall). */
export function shared(type: string, fields: Omit<StepArtifact, 'kind' | 'type'>): StepArtifact {
  return { kind: 'shared', type, ...fields };
}

/**
 * The dependency step, built from `detectEnvironment()` (reused verbatim). It
 * shows the missing tools as a checkbox, installs the selected ones, and prints
 * the per-tool authorization instruction (agent CLIs need an interactive login
 * a wizard cannot fully automate). `detect` is injectable for tests.
 */
/** How a given platform installs one missing tool. Platform-agnostic seam. */
export type ToolInstaller = (ctx: InstallContext, name: string) => Promise<void>;

export interface DepStepOpts {
  detect?: () => Promise<BackendCheck[]>;
  /** Per-platform installer; defaults to the apt/npm (Ubuntu) one. */
  installTool?: ToolInstaller;
  /** Per-tool manual-removal hint shown by uninstall. */
  removeHint?: (name: string) => string;
}

export function depCheckStep(opts: DepStepOpts = {}): InstallStep {
  const detect = opts.detect ?? detectEnvironment;
  const install = opts.installTool ?? aptInstallTool;
  const hintFor = opts.removeHint ?? removeHintFor;
  return {
    id: 'deps',
    title: 'Dependencies (agent CLIs + gh)',
    async check(ctx) {
      if (ctx.dryRun) return false;
      const checks = await detect();
      // Satisfied when at least one agent CLI is present and authed. Derived from RUNNER_IDS,
      // never a literal list: `BackendCheck['name']` also carries the non-agent tools (`gh`,
      // `git`), so the gate has to filter — and a hand-written array silently under-counts the
      // moment a runner is added (a pi-only host reporting "no agent CLI", #387 review).
      return checks.some((c) => isRunnerId(c.name) && c.available);
    },
    async run(ctx) {
      const checks = await detect();
      const missing = checks.filter((c) => !c.available && c.name !== 'git');
      if (missing.length === 0) {
        ctx.ui.success('All dependencies present.');
        return { artifacts: [] };
      }
      const pick = await ctx.ui.multiselect<string>({
        message: 'Missing tools — select the ones to install',
        options: missing.map((c) => ({ value: c.name, label: c.name, hint: c.hint })),
        required: false,
      });
      if (pick === CANCEL) throw new StepCancelled();

      const installed: StepArtifact[] = [];
      for (const name of pick) {
        const check = missing.find((c) => c.name === name);
        await install(ctx, name);
        installed.push(shared('package', { name, removeHint: hintFor(name) }));
        if (check?.hint) ctx.ui.note(check.hint, `Authorize ${name}`);
      }
      return { artifacts: installed };
    },
    async undo(ctx, created) {
      // Dependencies are `shared` — never auto-removed. List them for the operator.
      const pkgs = created?.artifacts ?? [];
      if (pkgs.length === 0) return;
      ctx.ui.note(
        pkgs.map((a) => a.removeHint ?? a.name ?? '').filter(Boolean).join('\n'),
        'These tools were installed for cezar-plus but may be used elsewhere — remove manually if you want them gone',
      );
    },
  };
}

const NPM_GLOBAL: Record<string, string> = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
};

/** Ubuntu/Debian installer: apt for gh, sudo npm -g for the agent CLIs (system node). */
export const aptInstallTool: ToolInstaller = async (ctx, name) => {
  if (name === 'gh') {
    await sudoStep(ctx, {
      description: 'Install the GitHub CLI (only needed for PR creation).',
      command: 'apt-get update && apt-get install -y gh',
      verify: (c) => verifyCommand(c, 'gh', ['--version']),
    });
    return;
  }
  await installViaNpmOrNote(ctx, name, true);
};

/** macOS installer: brew (no sudo) for gh, npm -g for the agent CLIs. */
export const brewInstallTool: ToolInstaller = async (ctx, name) => {
  if (name === 'gh') {
    if (ctx.dryRun) {
      ctx.ui.info('DRY RUN — would run: brew install gh');
      return;
    }
    await ctx.runner.interactive('brew', ['install', 'gh']);
    return;
  }
  await installViaNpmOrNote(ctx, name, false);
};

async function installViaNpmOrNote(ctx: InstallContext, name: string, sudo: boolean): Promise<void> {
  if (name === 'opencode') {
    ctx.ui.note('Install OpenCode from https://opencode.ai, then re-run.', 'opencode');
    return;
  }
  const pkg = NPM_GLOBAL[name];
  if (!pkg) {
    ctx.ui.warn(`no known installer for ${name} — install it manually`);
    return;
  }
  if (sudo) {
    await sudoStep(ctx, {
      description: `Install ${name} globally via npm.`,
      command: `npm install -g ${pkg}`,
      verify: (c) => verifyCommand(c, name, ['--version']),
    });
    return;
  }
  if (ctx.dryRun) {
    ctx.ui.info(`DRY RUN — would run: npm install -g ${pkg}`);
    return;
  }
  await ctx.runner.interactive('npm', ['install', '-g', pkg]);
}

function removeHintFor(name: string): string {
  const npm: Record<string, string> = {
    claude: 'npm rm -g @anthropic-ai/claude-code',
    codex: 'npm rm -g @openai/codex',
  };
  if (name === 'gh') return 'sudo apt-get remove -y gh';
  return npm[name] ?? `# remove ${name} manually`;
}

/** macOS-flavored removal hints (brew instead of apt). */
export function brewRemoveHint(name: string): string {
  const npm: Record<string, string> = {
    claude: 'npm rm -g @anthropic-ai/claude-code',
    codex: 'npm rm -g @openai/codex',
  };
  if (name === 'gh') return 'brew uninstall gh';
  return npm[name] ?? `# remove ${name} manually`;
}
