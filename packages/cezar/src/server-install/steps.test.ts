import { describe, expect, it, vi } from 'vitest';
import { createAutoUi } from './ui.ts';
import {
  depCheckStep,
  generatePassword,
  requireManualLogin,
  StepAborted,
  StepCancelled,
  StepSkipped,
  sudoStep,
  verifyCommand,
} from './steps.ts';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import type { BackendCheck } from '../core/backend-detect.ts';
import type { CommandResult, InstallContext, Runner, Ui } from './types.ts';

function makeCtx(over: {
  ui?: Ui;
  runner?: Partial<Runner>;
  dryRun?: boolean;
  assumeYes?: boolean;
  reconfigure?: Set<string>;
}): InstallContext {
  const runner: Runner = {
    capture: over.runner?.capture ?? (async (): Promise<CommandResult> => ({ code: 0, stdout: '', stderr: '' })),
    interactive: over.runner?.interactive ?? (async () => 0),
  };
  return {
    state: { schema: 1, installed: false, primaryPort: 4321, steps: {} },
    ui: over.ui ?? createAutoUi(),
    instance: 'default',
    runner,
    save: async () => {},
    dryRun: over.dryRun ?? false,
    assumeYes: over.assumeYes ?? false,
    reconfigure: over.reconfigure ?? new Set(),
    repoRoot: '/repo',
    now: '2026-07-16T00:00:00.000Z',
    prefs: {},
  };
}

/** A Ui whose select/confirm answers come from queues, consumed in order. */
function scriptedUi(select: string[], confirm: boolean[]): Ui {
  const base = createAutoUi();
  const selects = [...select];
  const confirms = [...confirm];
  return {
    ...base,
    async select() {
      return selects.shift() as never;
    },
    async confirm() {
      return confirms.shift() ?? true;
    },
  };
}

describe('sudoStep', () => {
  it('dry-run performs no exec and no verify', async () => {
    const interactive = vi.fn(async () => 0);
    const capture = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const verify = vi.fn(async () => true);
    const ctx = makeCtx({ dryRun: true, runner: { interactive, capture } });
    await sudoStep(ctx, { description: 'x', command: 'apt-get install -y nginx', verify });
    expect(interactive).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });

  it('run-via-sudo then verify-fail loops to redo until verify passes', async () => {
    const interactive = vi.fn(async () => 0);
    const verify = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const ui = scriptedUi(['sudo', 'sudo'], [true]); // 2 sudo runs, 1 redo=yes
    const ctx = makeCtx({ ui, runner: { interactive, capture: async () => ({ code: 1, stdout: '', stderr: '' }) } });
    await sudoStep(ctx, { description: 'install nginx', command: 'apt-get install -y nginx', verify });
    expect(interactive).toHaveBeenCalledTimes(2);
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('delegate path does not shell out to sudo but still verifies', async () => {
    const interactive = vi.fn(async () => 0);
    const verify = vi.fn(async () => true);
    const ui = scriptedUi(['delegate'], [true]); // choose delegate, confirm done
    const ctx = makeCtx({ ui, runner: { interactive, capture: async () => ({ code: 1, stdout: '', stderr: '' }) } });
    await sudoStep(ctx, { description: 'write vhost', command: 'tee /etc/nginx/x', verify });
    expect(interactive).not.toHaveBeenCalled();
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('--yes aborts when verification fails (never loops forever)', async () => {
    const verify = vi.fn(async () => false);
    // passwordless sudo available so it runs non-interactively
    const ctx = makeCtx({
      assumeYes: true,
      runner: { capture: async () => ({ code: 0, stdout: '', stderr: '' }), interactive: async () => 0 },
    });
    await expect(sudoStep(ctx, { description: 'x', command: 'true', verify })).rejects.toBeInstanceOf(
      StepAborted,
    );
  });

  it('defaults the mode prompt to delegate and reuses the choice for later steps', async () => {
    const select = vi.fn(async (_o: { initialValue?: string }) => 'delegate' as never);
    const verify = vi.fn(async () => true);
    const ui = { ...createAutoUi(), select, confirm: async () => true } as Ui;
    const ctx = makeCtx({ ui });
    await sudoStep(ctx, { description: 'a', command: 'true', verify });
    await sudoStep(ctx, { description: 'b', command: 'true', verify });
    expect(select).toHaveBeenCalledTimes(1); // asked once, remembered after (issue #6)
    expect(select.mock.calls[0]?.[0]?.initialValue).toBe('delegate'); // issue #1
    expect(ctx.prefs.sudoMode).toBe('delegate');
  });

  it('skippable step offers Skip on repeated failure and throws StepSkipped', async () => {
    const verify = vi.fn(async () => false);
    const ui = scriptedUi(['delegate', 'skip'], [true]); // pick delegate, confirm run, then skip
    const ctx = makeCtx({ ui, runner: { interactive: async () => 0, capture: async () => ({ code: 1, stdout: '', stderr: '' }) } });
    await expect(
      sudoStep(ctx, { description: 'ssl', command: 'certbot ...', skippable: true, skipHint: 'later', verify }),
    ).rejects.toBeInstanceOf(StepSkipped);
  });

  it('--yes on a skippable step skips (not aborts) when verification fails', async () => {
    const verify = vi.fn(async () => false);
    const ctx = makeCtx({
      assumeYes: true,
      runner: { capture: async () => ({ code: 0, stdout: '', stderr: '' }), interactive: async () => 0 },
    });
    await expect(
      sudoStep(ctx, { description: 'ssl', command: 'certbot', skippable: true, verify }),
    ).rejects.toBeInstanceOf(StepSkipped);
  });
});

describe('generatePassword', () => {
  it('is strong: default length, every character class, and crypto-varied', () => {
    const p = generatePassword();
    expect(p.length).toBe(16);
    expect(/[a-z]/.test(p)).toBe(true);
    expect(/[A-Z]/.test(p)).toBe(true);
    expect(/[0-9]/.test(p)).toBe(true);
    expect(/[!@#$%^&*\-_=+]/.test(p)).toBe(true);
    expect(generatePassword()).not.toBe(generatePassword());
  });

  it('never drops below 8 characters even when asked for fewer', () => {
    expect(generatePassword(4).length).toBe(8);
  });
});

describe('verifyCommand', () => {
  it('returns false in dry-run without running anything', async () => {
    const capture = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const ctx = makeCtx({ dryRun: true, runner: { capture } });
    expect(await verifyCommand(ctx, 'gh', ['--version'])).toBe(false);
    expect(capture).not.toHaveBeenCalled();
  });

  it('applies the matcher to captured output', async () => {
    const ctx = makeCtx({ runner: { capture: async () => ({ code: 0, stdout: 'nginx/1.24', stderr: '' }) } });
    expect(await verifyCommand(ctx, 'nginx', ['-v'], (r) => r.stdout.includes('nginx/'))).toBe(true);
  });
});

describe('sudoStep secret channel (stdin, never argv)', () => {
  it('sudo mode pipes `input` to stdin and keeps it out of the command argv', async () => {
    const interactive = vi.fn(async (_p: string, _a: string[], _o?: { input?: string }) => 0);
    const ctx = makeCtx({
      assumeYes: true,
      runner: {
        interactive,
        capture: async () => ({ code: 0, stdout: '', stderr: '' }), // passwordless sudo
      },
    });
    await sudoStep(ctx, {
      description: 'write credentials',
      command: 'cat > /etc/cezar/htpasswd && chmod 0640 /etc/cezar/htpasswd',
      input: 'ops:$apr1$secret-hash\n',
      inputLabel: 'credential line',
      verify: async () => true,
    });
    expect(interactive).toHaveBeenCalledWith(
      'sudo',
      ['bash', '-lc', 'cat > /etc/cezar/htpasswd && chmod 0640 /etc/cezar/htpasswd'],
      { input: 'ops:$apr1$secret-hash\n' },
    );
    const argv = interactive.mock.calls[0]?.[1] ?? [];
    expect(argv.join(' ')).not.toContain('secret-hash'); // the leak the review flagged
  });

  it('delegate mode shows the payload on screen (not argv) for a paste + Ctrl-D', async () => {
    const shown: string[] = [];
    const ui: Ui = {
      ...scriptedUi(['delegate'], [true]),
      message: (m) => shown.push(m),
      info: (m) => shown.push(m),
    };
    const ctx = makeCtx({ ui });
    await sudoStep(ctx, {
      description: 'write credentials',
      command: 'cat > /etc/cezar/htpasswd',
      input: 'ops:$apr1$secret-hash\n',
      inputLabel: 'credential line',
      verify: async () => true,
    });
    expect(shown.some((m) => m.includes('Ctrl-D'))).toBe(true);
    expect(shown.some((m) => m.includes('ops:$apr1$secret-hash'))).toBe(true);
    // the displayed command itself must not embed the payload
    const displayed = shown.find((m) => m.startsWith('sudo bash -lc'));
    expect(displayed).toBeDefined();
    expect(displayed).not.toContain('secret-hash');
  });

  /**
   * **UNATTENDED delegate mode prints nothing of the payload.** ADDED 2026-08-07 at the phase 6/7
   * repair stage. `--yes` on a host without passwordless sudo falls back to delegate — a CI or IaC
   * run, with no human watching to paste anything — and the old code echoed the payload anyway,
   * straight into that job's log, before failing its own `verify` because nobody ran the command.
   * Pure disclosure, zero benefit.
   *
   * It matters more since phase 6/7: `ubuntu-vps.ts`'s only stdin payload is an apr1 hash on a
   * single-tenant box, while `hetzner.ts` pushes `CEZ_SUPERVISOR_SECRET` (the key that signs one
   * org's forwarded principals) and the supervisor's OIDC client secret through this same seam.
   *
   * The interactive case above is the control: this is a change to the unattended branch only, not
   * "sudoStep stopped showing secrets", which would break the operator flow that needs to see one.
   */
  it('UNATTENDED delegate mode (--yes, no passwordless sudo) never echoes the payload', async () => {
    const shown: string[] = [];
    const record = (m: string) => shown.push(m);
    const ui: Ui = { ...createAutoUi(), message: record, info: record, warn: record, error: record };
    const ctx = makeCtx({
      ui,
      assumeYes: true,
      // `sudo -n true` fails ⇒ no passwordless sudo ⇒ `--yes` falls back to delegate.
      runner: { capture: async () => ({ code: 1, stdout: '', stderr: 'a password is required' }) },
    });
    await expect(
      sudoStep(ctx, {
        description: 'write credentials',
        command: 'cat > /etc/cezar/hetzner-acme.env',
        input: 'CEZ_SUPERVISOR_SECRET=deadbeefcafebabe\n',
        inputLabel: 'CEZ_SUPERVISOR_PORT / CEZ_SUPERVISOR_SECRET',
        // nobody ran it, so it genuinely did not take effect — the honest outcome
        verify: async () => false,
      }),
    ).rejects.toBeInstanceOf(StepAborted);

    const all = shown.join('\n');
    expect(all).not.toContain('deadbeefcafebabe');
    expect(all).not.toContain('CEZ_SUPERVISOR_SECRET=');
    // …and it says why, rather than failing mutely.
    expect(all).toMatch(/deliberately NOT printed/);
  });
});

/**
 * The "at least one agent CLI" gate (#387 review). `BackendCheck['name']` mixes agent CLIs with
 * the non-agent tools (`gh`, `git`), so the gate must filter — and the literal `['claude',
 * 'codex', 'opencode']` it used to filter with was a runtime string array typecheck could not
 * guard, so a pi-only host reported "no agent CLI" while pi sat right there in the checks.
 * These cases pin the gate to RUNNER_IDS: every runner satisfies it alone, no non-runner does.
 */
describe('depCheckStep — the agent-CLI gate', () => {
  const check = (name: BackendCheck['name'], available: boolean): BackendCheck => ({ name, available });

  const runGate = (checks: BackendCheck[]) =>
    depCheckStep({ detect: async () => checks }).check!(makeCtx({}));

  it.each(RUNNER_IDS)('is satisfied by %s alone — no runner is second-class', async (runner) => {
    await expect(runGate([check(runner, true), check('gh', false), check('git', true)])).resolves.toBe(true);
  });

  it('is NOT satisfied when every agent CLI is missing, however many other tools are present', async () => {
    const checks: BackendCheck[] = [
      ...RUNNER_IDS.map((r) => check(r, false)),
      check('gh', true),
      check('git', true),
    ];
    await expect(runGate(checks)).resolves.toBe(false);
  });

  it('never counts a non-agent tool as an agent CLI', async () => {
    await expect(runGate([check('gh', true), check('git', true)])).resolves.toBe(false);
  });

  it('stays unsatisfied in dry-run — the step must still be offered', async () => {
    const step = depCheckStep({ detect: async () => [check('claude', true)] });
    await expect(step.check!(makeCtx({ dryRun: true }))).resolves.toBe(false);
  });
});

describe('requireManualLogin — stop for an interactive, unscriptable step', () => {
  it('prints the commands and every one is shown, exactly as given', async () => {
    const messages: string[] = [];
    const ui = { ...scriptedUi([], [true]), message: (m: string) => messages.push(m) } as Ui;
    const ctx = makeCtx({ ui });
    await requireManualLogin(ctx, {
      description: 'needs its own agent CLI credentials',
      commands: ['sudo -u cez-worker -H claude auth login', 'sudo -u cez-worker -H codex login'],
    });
    expect(messages.some((m) => m.includes('sudo -u cez-worker -H claude auth login'))).toBe(true);
    expect(messages.some((m) => m.includes('sudo -u cez-worker -H codex login'))).toBe(true);
  });

  it('--yes always throws StepAborted — it cannot supply a human at an interactive login', async () => {
    const ctx = makeCtx({ assumeYes: true });
    await expect(
      requireManualLogin(ctx, { description: 'x', commands: ['sudo -u cez-worker -H claude auth login'] }),
    ).rejects.toBeInstanceOf(StepAborted);
  });

  it('interactive + confirmed true: resolves without throwing', async () => {
    const ctx = makeCtx({ assumeYes: false, ui: scriptedUi([], [true]) });
    await expect(
      requireManualLogin(ctx, { description: 'x', commands: ['sudo -u cez-worker -H claude auth login'] }),
    ).resolves.toBeUndefined();
  });

  it('interactive + confirmed false: throws StepAborted, naming that the commands still need running', async () => {
    const ctx = makeCtx({ assumeYes: false, ui: scriptedUi([], [false]) });
    await expect(
      requireManualLogin(ctx, { description: 'x', commands: ['sudo -u cez-worker -H claude auth login'] }),
    ).rejects.toThrow(/re-run/);
  });

  it('cancel (CANCEL sentinel from confirm) throws StepCancelled, not StepAborted', async () => {
    const { CANCEL } = await import('./types.ts');
    const ui = { ...createAutoUi(), confirm: async () => CANCEL } as Ui;
    const ctx = makeCtx({ assumeYes: false, ui });
    await expect(
      requireManualLogin(ctx, { description: 'x', commands: ['sudo -u cez-worker -H claude auth login'] }),
    ).rejects.toBeInstanceOf(StepCancelled);
  });
});
