import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveServerState } from '../state.ts';
import { StepAborted } from '../steps.ts';
import { createAutoUi } from '../ui.ts';
import { freshServerState, PreflightError, type InstallContext, type Runner, type ServerState, type Ui } from '../types.ts';

/**
 * Unit tests for the `hetzner` platform strategy itself (D4/D10, Fill unit 6) — preflight,
 * step-list branching between the SUPERVISOR and ORG provisioning targets, idempotency, undo and
 * redeploy. Nothing here executes a real command: every `Runner` is a fake object whose `capture`/
 * `interactive` methods return canned data (the exact discipline `ubuntu-vps.test.ts` already
 * uses), and the pure content generators owned by units 2/3/4/7
 * (`./hetzner/{provision-user,systemd-unit,nginx,tls}.ts`) are mocked here to assert THIS file's
 * wiring into them (right args, right branch) without re-asserting their own generated text —
 * each of those already has its own dedicated test file for that.
 */

vi.mock('./hetzner/nginx.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./hetzner/nginx.ts')>();
  return { ...actual, orgVhost: vi.fn(actual.orgVhost), supervisorVhost: vi.fn(actual.supervisorVhost) };
});
vi.mock('./hetzner/systemd-unit.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./hetzner/systemd-unit.ts')>();
  return { ...actual, orgSystemdUnit: vi.fn(actual.orgSystemdUnit), supervisorSystemdUnit: vi.fn(actual.supervisorSystemdUnit) };
});
vi.mock('./hetzner/tls.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./hetzner/tls.ts')>();
  return { ...actual, createTlsStep: vi.fn(actual.createTlsStep) };
});

const { hetzner, SUPERVISOR_PORT_DRY_RUN_FALLBACK } = await import('./hetzner.ts');
const { orgVhost, supervisorVhost } = await import('./hetzner/nginx.ts');
const { orgSystemdUnit, supervisorSystemdUnit } = await import('./hetzner/systemd-unit.ts');
const { createTlsStep } = await import('./hetzner/tls.ts');

const okRunner: Runner = { capture: async () => ({ code: 0, stdout: '', stderr: '' }), interactive: async () => 0 };

/** Answers the preflight OS/privilege probes (`uname`/`apt-get`/`id`) affirmatively so the
 *  org-slug/domain/topology logic below them can be exercised without `dryRun` — every response
 *  is canned, nothing is ever actually spawned. */
function preflightOkRunner(
  overrides: Partial<Record<'uname' | 'apt-get' | 'id', { code: number; stdout: string; stderr: string }>> = {},
): Runner {
  return {
    interactive: async () => 0,
    capture: async (program) => {
      if (program === 'uname') return overrides.uname ?? { code: 0, stdout: 'Linux\n', stderr: '' };
      if (program === 'apt-get') return overrides['apt-get'] ?? { code: 0, stdout: '', stderr: '' };
      if (program === 'id') return overrides.id ?? { code: 0, stdout: '1000\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
  };
}

function ctxWith(over: {
  ui?: Ui;
  runner?: Runner;
  dryRun?: boolean;
  assumeYes?: boolean;
  state?: Partial<ServerState>;
}): InstallContext {
  return {
    state: { ...freshServerState(), primaryPort: 4321, ...over.state },
    ui: over.ui ?? createAutoUi(),
    instance: 'default',
    runner: over.runner ?? okRunner,
    save: async () => {},
    dryRun: over.dryRun ?? false,
    assumeYes: over.assumeYes ?? true,
    reconfigure: new Set(),
    repoRoot: '/repo',
    now: '2026-08-07T00:00:00.000Z',
    prefs: {},
  };
}

function stepById(ctx: InstallContext, id: string) {
  const s = hetzner.steps(ctx).find((x) => x.id === id);
  if (!s) throw new Error(`no step ${id}`);
  return s;
}

/** `findSupervisorInstance()` (private to hetzner.ts) scans every `server-install` record under
 *  `CEZ_HOME` for a `platform: 'hetzner'` record with no `orgSlug` — seed one on disk exactly the
 *  way a real supervisor install would leave it, in a sandboxed temp `CEZ_HOME` (never the real
 *  `~/.cezar`), matching `ubuntu-vps.test.ts`'s own `CEZ_HOME`-sandboxing pattern. */
function withSandboxedCezHome(run: () => void | Promise<void>) {
  return async () => {
    const home = mkdtempSync(join(tmpdir(), 'cez-hetzner-'));
    const original = process.env.CEZ_HOME;
    process.env.CEZ_HOME = home;
    try {
      await run();
    } finally {
      if (original === undefined) delete process.env.CEZ_HOME;
      else process.env.CEZ_HOME = original;
      rmSync(home, { recursive: true, force: true });
    }
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('hetzner preflight — domain and org-slug shape', () => {
  it('requires --domain', async () => {
    await expect(hetzner.preflight(ctxWith({ dryRun: true }))).rejects.toBeInstanceOf(PreflightError);
  });

  it('rejects a non-hostname --domain', async () => {
    await expect(
      hetzner.preflight(ctxWith({ dryRun: true, state: { domain: 'not a host!!' } })),
    ).rejects.toBeInstanceOf(PreflightError);
  });

  it('rejects --org-slug supervisor — reserved for the supervisor\'s own unix user', async () => {
    await expect(
      hetzner.preflight(ctxWith({ dryRun: true, state: { domain: 'acme.cezar.example.com', orgSlug: 'supervisor' } })),
    ).rejects.toThrow(/reserved/);
  });

  it('rejects an invalid --org-slug shape before it ever reaches a shell command', async () => {
    await expect(
      hetzner.preflight(ctxWith({ dryRun: true, state: { domain: 'acme.cezar.example.com', orgSlug: 'Not Valid!' } })),
    ).rejects.toBeInstanceOf(PreflightError);
  });

  it('dry-run skips every OS + supervisor-topology check — safe to preview with nothing provisioned', async () => {
    await expect(
      hetzner.preflight(ctxWith({ dryRun: true, state: { domain: 'acme.cezar.example.com', orgSlug: 'acme' } })),
    ).resolves.toBeUndefined();
  });
});

describe('hetzner preflight — OS/privilege checks (non-dry-run, fake runner, nothing executed)', () => {
  it('refuses non-Linux', async () => {
    const runner = preflightOkRunner({ uname: { code: 0, stdout: 'Darwin\n', stderr: '' } });
    await expect(
      hetzner.preflight(ctxWith({ runner, state: { domain: 'login.cezar.example.com' } })),
    ).rejects.toThrow(/Linux/);
  });

  it('refuses without apt (Debian/Ubuntu only)', async () => {
    const runner = preflightOkRunner({ 'apt-get': { code: 127, stdout: '', stderr: 'not found' } });
    await expect(
      hetzner.preflight(ctxWith({ runner, state: { domain: 'login.cezar.example.com' } })),
    ).rejects.toThrow(/apt/);
  });

  it('refuses running as root', async () => {
    const runner = preflightOkRunner({ id: { code: 0, stdout: '0\n', stderr: '' } });
    await expect(
      hetzner.preflight(ctxWith({ runner, state: { domain: 'login.cezar.example.com' } })),
    ).rejects.toThrow(/root/);
  });

  it('supervisor mode (no --org-slug) needs no pre-existing supervisor record', async () => {
    const runner = preflightOkRunner();
    await expect(
      hetzner.preflight(ctxWith({ runner, state: { domain: 'login.cezar.example.com' } })),
    ).resolves.toBeUndefined();
  });
});

describe('hetzner preflight — org topology (D10: supervisor first, org hostname is its subdomain)', () => {
  it(
    'refuses an org run when no supervisor instance is provisioned on this host',
    withSandboxedCezHome(async () => {
      const runner = preflightOkRunner();
      await expect(
        hetzner.preflight(ctxWith({ runner, state: { domain: 'acme.cezar.example.com', orgSlug: 'acme' } })),
      ).rejects.toThrow(/no supervisor is provisioned/);
    }),
  );

  it(
    'refuses an org hostname that is not a subdomain of the supervisor\'s base domain',
    withSandboxedCezHome(async () => {
      saveServerState(
        { ...freshServerState(), installed: true, primaryPort: 4321, platform: 'hetzner', domain: 'cezar.example.com' },
        'supervisor-instance',
      );
      const runner = preflightOkRunner();
      await expect(
        hetzner.preflight(ctxWith({ runner, state: { domain: 'evil.other.com', orgSlug: 'acme' } })),
      ).rejects.toThrow(/subdomain/);
    }),
  );

  it(
    'refuses the bare base domain itself as an org hostname (must be a SUBdomain, not the same host)',
    withSandboxedCezHome(async () => {
      saveServerState(
        { ...freshServerState(), installed: true, primaryPort: 4321, platform: 'hetzner', domain: 'cezar.example.com' },
        'supervisor-instance',
      );
      const runner = preflightOkRunner();
      await expect(
        hetzner.preflight(ctxWith({ runner, state: { domain: 'cezar.example.com', orgSlug: 'acme' } })),
      ).rejects.toThrow(/subdomain/);
    }),
  );

  it(
    'accepts a proper subdomain of the supervisor\'s base domain',
    withSandboxedCezHome(async () => {
      saveServerState(
        { ...freshServerState(), installed: true, primaryPort: 4321, platform: 'hetzner', domain: 'cezar.example.com' },
        'supervisor-instance',
      );
      const runner = preflightOkRunner();
      await expect(
        hetzner.preflight(ctxWith({ runner, state: { domain: 'acme.cezar.example.com', orgSlug: 'acme' } })),
      ).resolves.toBeUndefined();
    }),
  );

  /**
   * **One org gets one process.** ADDED 2026-08-07 at the repair stage — the guard landed in the
   * same pass and nothing tested it, so mutation testing found `if (sibling) {` → `if (false) {`
   * surviving the whole suite.
   *
   * Instance identity is keyed on `--domain` (`instanceSlug`), so `unitName`/`vhost`/
   * `environmentFilePath` are all domain-keyed — but the unix user, `CEZ_HOME` and
   * `WorkingDirectory` are keyed on `--org-slug`. Provisioning one org on a second hostname
   * therefore produced TWO enabled units, both `User=cez-acme`, both
   * `CEZ_HOME=/home/cez-acme/.cezar`, both `WorkingDirectory=/home/cez-acme/workspace`, on two
   * ports — two processes over one leaseless `.ai/cezar`, which is spec Problem §4 verbatim and
   * exactly the silent run-history loss D4's hard constraint exists to prevent. It arrives from
   * the opposite direction to the shared-`WorkingDirectory` defect, so fixing that one did not
   * close this one.
   */
  it(
    'refuses a SECOND hostname for an org already provisioned on this host (D4: one org, one process)',
    withSandboxedCezHome(async () => {
      saveServerState(
        { ...freshServerState(), installed: true, primaryPort: 4321, platform: 'hetzner', domain: 'cezar.example.com' },
        'supervisor-instance',
      );
      saveServerState(
        { ...freshServerState(), installed: true, primaryPort: 4400, platform: 'hetzner', domain: 'acme.cezar.example.com', orgSlug: 'acme' },
        'acme-instance',
      );
      const runner = preflightOkRunner();
      await expect(
        hetzner.preflight(ctxWith({ runner, state: { domain: 'acme2.cezar.example.com', orgSlug: 'acme' } })),
      ).rejects.toThrow(/already provisioned on this host/);
    }),
  );

  it(
    're-running the SAME org on the SAME hostname is still allowed — that is a resume, not a second process',
    withSandboxedCezHome(async () => {
      // The negative control for the refusal above: keyed on a DIFFERENT domain, never on the slug
      // alone, or `--reconfigure` on an existing org would be refused by its own guard.
      saveServerState(
        { ...freshServerState(), installed: true, primaryPort: 4321, platform: 'hetzner', domain: 'cezar.example.com' },
        'supervisor-instance',
      );
      saveServerState(
        { ...freshServerState(), installed: true, primaryPort: 4400, platform: 'hetzner', domain: 'acme.cezar.example.com', orgSlug: 'acme' },
        'acme-instance',
      );
      const runner = preflightOkRunner();
      await expect(
        hetzner.preflight(ctxWith({ runner, state: { domain: 'acme.cezar.example.com', orgSlug: 'acme' } })),
      ).resolves.toBeUndefined();
    }),
  );

  it(
    'a DIFFERENT org on a different hostname is fine — the refusal is per org, not per host',
    withSandboxedCezHome(async () => {
      saveServerState(
        { ...freshServerState(), installed: true, primaryPort: 4321, platform: 'hetzner', domain: 'cezar.example.com' },
        'supervisor-instance',
      );
      saveServerState(
        { ...freshServerState(), installed: true, primaryPort: 4400, platform: 'hetzner', domain: 'acme.cezar.example.com', orgSlug: 'acme' },
        'acme-instance',
      );
      const runner = preflightOkRunner();
      await expect(
        hetzner.preflight(ctxWith({ runner, state: { domain: 'beta.cezar.example.com', orgSlug: 'beta' } })),
      ).resolves.toBeUndefined();
    }),
  );
});

describe('hetzner steps() — two provisioning targets, one platform', () => {
  it('supervisor mode (no --org-slug): user, auth systemd, nginx, TLS, verify — no dependency-CLI step', () => {
    const ids = hetzner.steps(ctxWith({ state: { domain: 'login.cezar.example.com' } })).map((s) => s.id);
    expect(ids).toEqual(['supervisor-user', 'supervisor-systemd', 'nginx', 'tls', 'identity']);
  });

  it('org mode (--org-slug): deps, org user, org systemd, nginx, TLS, verify', () => {
    const ids = hetzner
      .steps(ctxWith({ state: { domain: 'acme.cezar.example.com', orgSlug: 'acme' } }))
      .map((s) => s.id);
    expect(ids).toEqual(['deps', 'org-user', 'org-systemd', 'org-register', 'nginx', 'tls', 'identity']);
  });

  it('TLS is required in both modes — never `optional: true` like ubuntu-vps.ts\'s sslStep (D10)', () => {
    expect(stepById(ctxWith({ state: { domain: 'login.cezar.example.com' } }), 'tls').optional).toBeFalsy();
    expect(stepById(ctxWith({ state: { domain: 'acme.cezar.example.com', orgSlug: 'acme' } }), 'tls').optional).toBeFalsy();
  });
});

describe('hetzner supervisor-user step', () => {
  it('dry-run derives the reserved supervisor pseudo-slug unix user + CEZ_HOME and records a shared artifact', async () => {
    const ctx = ctxWith({ dryRun: true, state: { domain: 'login.cezar.example.com' } });
    const created = await stepById(ctx, 'supervisor-user').run(ctx);
    const artifact = created?.artifacts.find((a) => a.type === 'unix-user');
    expect(artifact?.kind).toBe('shared');
    expect(artifact?.name).toBe('cez-supervisor');
    expect(artifact?.path).toBe('/home/cez-supervisor');
  });

  it('undo never deletes the supervisor user (it would destroy every org\'s identity/session state) — only notes the removal command', async () => {
    const notes: string[] = [];
    const ui = { ...createAutoUi(), note: (m: string) => notes.push(m) } as Ui;
    const ctx = ctxWith({ dryRun: true, ui, state: { domain: 'login.cezar.example.com' } });
    await stepById(ctx, 'supervisor-user').undo(ctx, {
      artifacts: [{ kind: 'shared', type: 'unix-user', name: 'cez-supervisor', path: '/home/cez-supervisor', removeHint: 'sudo userdel -r cez-supervisor' }],
    });
    expect(notes.some((m) => m.includes('userdel'))).toBe(true);
  });
});

describe('hetzner supervisor-systemd / org-systemd — generator wiring + once-only secret', () => {
  it('supervisor-systemd resolves the picked auth provider and threads the derived unix user/CEZ_HOME/port/publicUrl/cookie-domain into supervisorSystemdUnit', async () => {
    const ctx = ctxWith({ dryRun: true, state: { domain: 'login.cezar.example.com', primaryPort: 4321 } });
    await stepById(ctx, 'supervisor-systemd').run(ctx);
    expect(ctx.state.hetznerAuthProvider).toBe('oidc'); // AUTH_PROVIDER_OPTIONS[0] — the auto-picked default
    expect(supervisorSystemdUnit).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 4321,
        unixUser: 'cez-supervisor',
        cezHome: '/home/cez-supervisor/.cezar',
        publicUrl: 'https://login.cezar.example.com',
        authProvider: 'oidc',
        sessionCookieDomain: '.login.cezar.example.com',
        environmentFile: '/etc/cezar/hetzner-default.env',
      }),
    );
  });

  it('org-systemd threads the org\'s unix user, CEZ_HOME, port and environment file into orgSystemdUnit', async () => {
    const ctx = ctxWith({ dryRun: true, state: { domain: 'acme.cezar.example.com', orgSlug: 'acme', primaryPort: 4322 } });
    await stepById(ctx, 'org-systemd').run(ctx);
    expect(orgSystemdUnit).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 4322,
        unixUser: 'cez-acme',
        cezHome: '/home/cez-acme/.cezar',
        environmentFile: '/etc/cezar/hetzner-default.env',
      }),
    );
  });

  it(
    'org-systemd writes BOTH CEZ_SUPERVISOR_PORT and CEZ_SUPERVISOR_SECRET into the org\'s EnvironmentFile — registry-client.ts requires both and orgSystemdUnit only ever emits the secret\'s path, never the port',
    withSandboxedCezHome(async () => {
      saveServerState(
        { ...freshServerState(), installed: true, primaryPort: 4321, platform: 'hetzner', domain: 'cezar.example.com' },
        'supervisor-instance',
      );
      const inputs: string[] = [];
      // `test -f <envFile>` is probed TWICE in one run: once as the `envAlreadyWritten` pre-check
      // (must report "not there yet", or the write is skipped and `inputs` stays empty) and once as
      // `sudoStep`'s own post-write `verify()` (must report "there now", or `sudoStep` throws
      // `StepAborted` — a stateless mock answering both the same way fails the second probe
      // regardless of which constant it picks). Track call count instead of a fixed answer.
      let testCalls = 0;
      const runner: Runner = {
        capture: async (program) => {
          if (program === 'test') {
            testCalls += 1;
            return { code: testCalls === 1 ? 1 : 0, stdout: '', stderr: '' };
          }
          return { code: 0, stdout: '', stderr: '' };
        },
        interactive: async (_p, _args, o) => {
          if (o?.input) inputs.push(o.input);
          return 0;
        },
      };
      const ctx = ctxWith({ runner, state: { domain: 'acme.cezar.example.com', orgSlug: 'acme', primaryPort: 4322 } });
      await stepById(ctx, 'org-systemd').run(ctx);
      const secretWrite = inputs.find((i) => i.includes('CEZ_SUPERVISOR_SECRET='));
      expect(secretWrite).toContain('CEZ_SUPERVISOR_PORT=4321\n'); // the SUPERVISOR's port, not the org's own 4322
      expect(secretWrite).toMatch(/CEZ_SUPERVISOR_SECRET=[0-9a-f]{64}\n$/);
    }),
  );

  /**
   * **The org's `CEZ_SUPERVISOR_SECRET` never reaches the operator's screen.** CORRECTED
   * 2026-08-07 at the repair stage — this test used to assert the OPPOSITE shape: `org-systemd`
   * printed a "Supervisor registration needed" note listing the fields an operator would POST by
   * hand, `supervisorSecret` among them. D10's Risks entry forbids exactly that ("never
   * `printf %s <content>` into the operator's terminal or a sudo-note transcript"), and the note
   * put the value that signs every forwarded principal for this org into scrollback, `script`/tmux
   * logs and any CI transcript — two lines after `writeRootSecretFileCmd` took care to feed it on
   * stdin so it would not appear. The hand-off is automated now (`org-register`), so there is
   * nothing for a human to copy and nothing to print.
   *
   * Asserted as an ABSENCE across every UI channel, not just `note`: a fix that moved the same
   * string from `note` to `info` would satisfy a narrower assertion and change nothing.
   */
  it('never prints the org\'s CEZ_SUPERVISOR_SECRET — on any UI channel (D10 Risks)', async () => {
    const printed: string[] = [];
    const record = (m: string, title?: string) => printed.push(`${title ?? ''}\n${m}`);
    const ui = {
      ...createAutoUi(),
      note: record,
      info: (m: string) => record(m),
      message: (m: string) => record(m),
      warn: (m: string) => record(m),
      success: (m: string) => record(m),
    } as Ui;
    // `test -f <envfile>` must answer "absent" on the FIRST probe (so the secret really is minted
    // this run — a resumed run mints nothing and would make this test vacuous) and "present"
    // afterwards, which is what the post-write `verify` asks.
    let envProbes = 0;
    const stdin: string[] = [];
    const runner: Runner = {
      interactive: async () => 0,
      capture: async (program) => {
        if (program === 'test') return { code: envProbes++ === 0 ? 1 : 0, stdout: '', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    const ctx = ctxWith({ ui, runner, state: { domain: 'acme.cezar.example.com', orgSlug: 'acme' } });
    // `sudoStep` feeds the secret through `runner.interactive`'s stdin; capture it so the
    // assertion below is compared against the REAL generated value rather than a pattern that
    // might simply never match anything (a vacuous "not.toContain").
    const capturingCtx: InstallContext = {
      ...ctx,
      runner: {
        ...runner,
        interactive: async (_program, _args, opts?: { input?: string }) => {
          if (opts?.input) stdin.push(opts.input);
          return 0;
        },
      } as Runner,
    };
    await stepById(ctx, 'org-systemd').run(capturingCtx);

    const secret = /CEZ_SUPERVISOR_SECRET=([0-9a-f]{64})/.exec(stdin.join('\n'))?.[1];
    expect(secret).toBeDefined(); // the negative assertions below are vacuous without this
    const all = printed.join('\n');
    expect(all).not.toContain(secret!);
    expect(all).not.toMatch(/[0-9a-f]{64}/);
    expect(all).not.toMatch(/CEZ_SUPERVISOR_SECRET=\S/);
    expect(all).not.toContain('Supervisor registration needed');
  });

  it('org mode provisions an `org-register` step that registers with the supervisor automatically', () => {
    // The counterpart to the assertion above: the secret is not printed BECAUSE nobody has to
    // carry it by hand any more, not because the hand-off was dropped.
    const ctx = ctxWith({ state: { domain: 'acme.cezar.example.com', orgSlug: 'acme' } });
    expect(hetzner.steps(ctx).map((s) => s.id)).toContain('org-register');
  });

  it('a resumed run (EnvironmentFile already present) re-derives the SAME unit deterministically and asks no prompts', async () => {
    // Non-dry-run with a fake runner reporting the env file AND unit as already present — this is
    // what `envAlreadyWritten`'s own `test -f`/`systemctl is-enabled` probes see on a real resume.
    // Never a real `test`/`systemctl` invocation: `okRunner` just returns `{code: 0}` for anything.
    const selectCalls: string[] = [];
    const ui = {
      ...createAutoUi(),
      select: async (o: { message: string; options: Array<{ value: unknown }> }) => {
        selectCalls.push(o.message);
        return o.options[0]?.value;
      },
    } as Ui;
    const ctx = ctxWith({ ui, state: { domain: 'login.cezar.example.com', primaryPort: 4321 } });
    await stepById(ctx, 'supervisor-systemd').run(ctx);
    expect(selectCalls).toHaveLength(0); // no "Auth provider…" prompt — envAlreadyWritten short-circuited it
    expect(ctx.state.hetznerAuthProvider).toBeUndefined(); // never set — the credential branch never ran
  });
});

/**
 * **Every step's `check()`, both directions.** ADDED 2026-08-07 at the repair stage.
 *
 * `engine.ts` reads `check()` as the resume/self-heal probe: `if (!forced && await step.check(ctx))`
 * marks the step `done`, prints "(already present)" and **never runs it**. So a `check()` that
 * wrongly answers `true` provisions nothing on a clean box and reports a successful install.
 *
 * Nothing tested any of them. Mutation testing replaced all four `if (ctx.dryRun) return false;`
 * guards with `return true;` — i.e. every step reports done, always — and the entire 6630-test
 * suite stayed green, because every test in this file drives `run()`/`steps()` in `dryRun`, where
 * that first line short-circuits before the probe is ever reached. `provision-user.test.ts` and
 * `tls.test.ts` both exercise their own `check()`; unit 6, which owns four of the six steps,
 * exercised none.
 *
 * Both directions matter: asserting only "false when absent" passes against a `check()` hard-wired
 * to `false`, which would make every step re-run and re-prompt on every resume.
 */
describe('hetzner step check() — the resume/self-heal probe the engine skips a step on', () => {
  /** A runner answering every structural probe (`test -f`, `systemctl is-enabled`, `id -u`,
   *  `stat`) either present or absent — the two states a real host is ever in. */
  function probeRunner(present: boolean): Runner {
    return {
      interactive: async () => 0,
      capture: async (program, args) => {
        if (program === 'sh' && args.join(' ').includes('stat')) {
          return { code: present ? 0 : 1, stdout: present ? '700 cez-acme' : '', stderr: '' };
        }
        if (program === 'sudo' && args[0] === '-n' && args[1] === 'true') return { code: 0, stdout: '', stderr: '' };
        if (program === 'sudo') return { code: present ? 0 : 1, stdout: present ? '{"hostname":"x"}' : '', stderr: '' };
        return { code: present ? 0 : 1, stdout: present ? '1001' : '', stderr: '' };
      },
    };
  }

  const SUPERVISOR = { domain: 'login.cezar.example.com', primaryPort: 4321 };
  const ORG = { domain: 'acme.cezar.example.com', orgSlug: 'acme', primaryPort: 4322 };

  /** `org-register`'s probe reads the SUPERVISOR's EnvironmentFile path out of the recorded
   *  supervisor instance, so every case runs against a seeded one in a sandboxed `CEZ_HOME`. */
  const seedSupervisor = () =>
    saveServerState(
      { ...freshServerState(), installed: true, primaryPort: 4321, platform: 'hetzner', domain: 'cezar.example.com' },
      'supervisor-instance',
    );

  it.each([
    ['supervisor-user', SUPERVISOR],
    ['supervisor-systemd', SUPERVISOR],
    ['org-user', ORG],
    ['org-systemd', ORG],
    ['org-register', ORG],
    ['nginx', SUPERVISOR],
  ] as const)('%s: false when nothing is provisioned, true when everything is', (id, state) =>
    withSandboxedCezHome(async () => {
      seedSupervisor();
      const absent = ctxWith({ runner: probeRunner(false), state });
      expect(await stepById(absent, id).check!(absent)).toBe(false);

      const present = ctxWith({ runner: probeRunner(true), state });
      expect(await stepById(present, id).check!(present)).toBe(true);
    })(),
  );

  it('the verify step never reports done — it creates nothing, so it must always re-run', async () => {
    const ctx = ctxWith({ runner: probeRunner(true), state: SUPERVISOR });
    expect(await stepById(ctx, 'identity').check!(ctx)).toBe(false);
  });

  it('dry-run never reports done — a preview must walk every step', async () => {
    for (const [id, state] of [
      ['supervisor-user', SUPERVISOR],
      ['supervisor-systemd', SUPERVISOR],
      ['org-user', ORG],
      ['org-systemd', ORG],
      ['org-register', ORG],
      ['nginx', SUPERVISOR],
    ] as const) {
      const ctx = ctxWith({ dryRun: true, runner: probeRunner(true), state });
      expect(await stepById(ctx, id).check!(ctx)).toBe(false);
    }
  });
});

describe('hetzner nginx step — mode-based vhost selection + supervisor-port resolution', () => {
  it('supervisor mode calls supervisorVhost with THIS instance\'s own hostname + port', async () => {
    const ctx = ctxWith({ dryRun: true, state: { domain: 'login.cezar.example.com', primaryPort: 4321 } });
    await stepById(ctx, 'nginx').run(ctx);
    expect(supervisorVhost).toHaveBeenCalledWith({ hostname: 'login.cezar.example.com', supervisorPort: 4321 });
  });

  /**
   * **The supervisor's port is LOOKED UP, and this asserts it against a value the fallback cannot
   * produce.** CORRECTED 2026-08-07 at the repair stage. Both this test and the fallback one below
   * used to seed the supervisor at `4321` — which is exactly `SUPERVISOR_PORT_DRY_RUN_FALLBACK`,
   * so the lookup branch and the constant branch produced identical output and neither test could
   * tell them apart. Mutation testing proved it: replacing `resolveSupervisorPort`'s whole body
   * with `return 4321` kept all 242 tests in this suite green.
   *
   * It matters because this value is written into (a) the org vhost's `auth_request` / `/auth/` /
   * `/internal/` `proxy_pass` and (b) that org's `CEZ_SUPERVISOR_PORT`. `nextFreeInstancePort()`
   * hands the supervisor 4321 only when it is the first instance on the host; install anything
   * before it, or pass `--port`, and it is not — at which point a regression that stopped looking
   * it up would point every org's auth subrequest at whatever else occupies 4321.
   */
  it(
    'org mode calls orgVhost with the ORG\'s own port and the SUPERVISOR\'s port looked up from the recorded supervisor instance',
    withSandboxedCezHome(async () => {
      // Deliberately NOT the dry-run fallback: a supervisor that was not the first instance on the
      // box, which is the whole case this lookup exists for.
      const SUPERVISOR_PORT = 4700;
      expect(SUPERVISOR_PORT).not.toBe(SUPERVISOR_PORT_DRY_RUN_FALLBACK);
      saveServerState(
        { ...freshServerState(), installed: true, primaryPort: SUPERVISOR_PORT, platform: 'hetzner', domain: 'cezar.example.com' },
        'supervisor-instance',
      );
      const ctx = ctxWith({ dryRun: true, state: { domain: 'acme.cezar.example.com', orgSlug: 'acme', primaryPort: 4322 } });
      await stepById(ctx, 'nginx').run(ctx);
      expect(orgVhost).toHaveBeenCalledWith({
        hostname: 'acme.cezar.example.com',
        orgPort: 4322,
        supervisorPort: SUPERVISOR_PORT,
      });
    }),
  );

  /**
   * **`findSupervisorInstance` must not match an ORG instance.** ADDED 2026-08-07 — mutation
   * testing survived dropping the `&& !i.state.orgSlug` discriminant, because no test ever
   * recorded a hetzner instance that HAD an `orgSlug`. Without it, `.find()` can return a sibling
   * org (order depends on `listServerInstances()`), and the new org's vhost would `auth_request`
   * against another org's process — which serves no `/internal/auth-check`, so nginx sees a
   * non-2xx and 500s the whole host — while its `CEZ_SUPERVISOR_PORT` pointed the registry client
   * at that same sibling.
   */
  it(
    'a recorded ORG instance is never mistaken for the supervisor',
    withSandboxedCezHome(async () => {
      // An existing org, recorded first so `.find()` would reach it before the supervisor.
      saveServerState(
        { ...freshServerState(), installed: true, primaryPort: 4600, platform: 'hetzner', domain: 'beta.cezar.example.com', orgSlug: 'beta' },
        'beta-instance',
      );
      saveServerState(
        { ...freshServerState(), installed: true, primaryPort: 4700, platform: 'hetzner', domain: 'cezar.example.com' },
        'supervisor-instance',
      );
      const ctx = ctxWith({ dryRun: true, state: { domain: 'acme.cezar.example.com', orgSlug: 'acme', primaryPort: 4322 } });
      await stepById(ctx, 'nginx').run(ctx);
      expect(orgVhost).toHaveBeenCalledWith({
        hostname: 'acme.cezar.example.com',
        orgPort: 4322,
        supervisorPort: 4700, // the SUPERVISOR's, never beta's 4600
      });
    }),
  );

  it(
    'org mode falls back to the conventional port when no supervisor record is found yet (CEZ_DRY_RUN preview only — a real org run is refused first, at preflight)',
    withSandboxedCezHome(async () => {
      const ctx = ctxWith({ dryRun: true, state: { domain: 'acme.cezar.example.com', orgSlug: 'acme', primaryPort: 4322 } });
      await stepById(ctx, 'nginx').run(ctx);
      expect(orgVhost).toHaveBeenCalledWith({
        hostname: 'acme.cezar.example.com',
        orgPort: 4322,
        supervisorPort: SUPERVISOR_PORT_DRY_RUN_FALLBACK,
      });
    }),
  );
});

describe('hetzner nginx step — undo', () => {
  it('removes only this instance\'s vhost — the shared upgrade map and nginx package are left in place for any sibling instance', async () => {
    const commands: string[] = [];
    const runner: Runner = {
      capture: async () => ({ code: 0, stdout: '', stderr: '' }),
      interactive: async (_p, args) => {
        commands.push(args.join(' '));
        return 0;
      },
    };
    const notes: string[] = [];
    const ui = { ...createAutoUi(), note: (m: string) => notes.push(m) } as Ui;
    const ctx = ctxWith({ ui, runner, assumeYes: true, state: { domain: 'login.cezar.example.com' } });
    await stepById(ctx, 'nginx').undo(ctx, {
      artifacts: [
        { kind: 'owned', type: 'file', path: '/etc/nginx/sites-available/cezar-hetzner-default' },
        { kind: 'owned', type: 'symlink', path: '/etc/nginx/sites-enabled/cezar-hetzner-default' },
        { kind: 'shared', type: 'package', name: 'nginx', removeHint: 'sudo apt-get remove -y nginx' },
      ],
    });
    expect(commands.some((c) => c.includes('cezar-hetzner-default'))).toBe(true);
    expect(commands.some((c) => c.includes('cezar-hetzner-upgrade.conf'))).toBe(false);
    expect(notes.some((n) => n.includes('nginx'))).toBe(true); // listed, not removed
  });
});

describe('hetzner tls step wiring', () => {
  it('supervisor mode: role "supervisor", tied to the supervisor unit for the CEZ_PUBLIC_URL renewal-guard hook', () => {
    hetzner.steps(ctxWith({ state: { domain: 'login.cezar.example.com' } }));
    expect(createTlsStep).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: 'login.cezar.example.com',
        vhostPath: '/etc/nginx/sites-available/cezar-hetzner-default',
        role: 'supervisor',
        publicUrlConfigFile: '/etc/systemd/system/cezar-hetzner-default.service',
      }),
    );
  });

  it('org mode: role "org", no publicUrlConfigFile — only the supervisor\'s own unit carries CEZ_PUBLIC_URL', () => {
    hetzner.steps(ctxWith({ state: { domain: 'acme.cezar.example.com', orgSlug: 'acme' } }));
    expect(createTlsStep).toHaveBeenCalledWith(
      expect.objectContaining({ domain: 'acme.cezar.example.com', role: 'org', publicUrlConfigFile: undefined }),
    );
  });
});

describe('hetzner verify step — end-to-end pass/fail, both modes', () => {
  function verifyCtx(opts: { upstream: string; publicCode: string; state?: Partial<ServerState> }): InstallContext {
    const runner: Runner = {
      interactive: async () => 0,
      capture: async (program, args) => {
        if (program !== 'curl') return { code: 0, stdout: '', stderr: '' };
        // the public probe always carries -H "Host: <domain>"; the upstream probe never does.
        return { code: 0, stdout: args.includes('-H') ? opts.publicCode : opts.upstream, stderr: '' };
      },
    };
    return ctxWith({
      runner,
      state: {
        domain: 'login.cezar.example.com',
        primaryPort: 4321,
        // TLS is REQUIRED on this platform and `verifyStep` is where that stops being a claim —
        // an install whose `publicUrl` is not https fails here even when every probe is green.
        // See the dedicated case below.
        publicUrl: 'https://login.cezar.example.com',
        ...opts.state,
      },
    });
  }

  it('supervisor mode passes when upstream is up and the public probe is 2xx/3xx (a real login page answers)', async () => {
    const ctx = verifyCtx({ upstream: '200', publicCode: '302' });
    await expect(stepById(ctx, 'identity').run(ctx)).resolves.toEqual({ artifacts: [] });
  });

  it('supervisor mode fails when the public probe is not 2xx/3xx', async () => {
    const ctx = verifyCtx({ upstream: '200', publicCode: '500' });
    await expect(stepById(ctx, 'identity').run(ctx)).rejects.toBeInstanceOf(StepAborted);
  });

  it('org mode passes when the public probe is 401 — proof auth_request actually reached the supervisor', async () => {
    const ctx = verifyCtx({ upstream: '200', publicCode: '401', state: { orgSlug: 'acme' } });
    await expect(stepById(ctx, 'identity').run(ctx)).resolves.toEqual({ artifacts: [] });
  });

  it('org mode FAILS when the public probe is 200 — an anonymous request reached the app, auth_request is not enforcing', async () => {
    const ctx = verifyCtx({ upstream: '200', publicCode: '200', state: { orgSlug: 'acme' } });
    await expect(stepById(ctx, 'identity').run(ctx)).rejects.toBeInstanceOf(StepAborted);
  });

  it('fails in either mode when nothing is listening upstream (nginx would 502/504)', async () => {
    const ctx = verifyCtx({ upstream: '000', publicCode: '401', state: { orgSlug: 'acme' } });
    await expect(stepById(ctx, 'identity').run(ctx)).rejects.toBeInstanceOf(StepAborted);
  });

  /**
   * **TLS is REQUIRED, and this is the assertion that makes that true rather than claimed.**
   * ADDED 2026-08-07 at the repair stage. `tls.ts` marks the certbot issue sub-step
   * `skippable: true`, and `steps.ts` turns a skip into `StepSkipped` unattended under `--yes` —
   * so a DNS-not-yet-pointed or rate-limited run completed the install on plain HTTP. Every probe
   * below is green; only the scheme is wrong. Before this, `verifyStep` ADAPTED to plain HTTP
   * (`const https = publicUrl?.startsWith('https://') ?? false` chose which URL to curl and
   * nothing else), printed "is live at …", and the operator then discovered at first sign-in that
   * `auth/session.ts` emits `Secure` unconditionally, so no browser would store the session
   * cookie and every login silently failed.
   */
  it.each([
    ['no publicUrl recorded at all', undefined],
    ['a plain-http publicUrl (certbot was skipped)', 'http://login.cezar.example.com'],
  ] as const)('FAILS on %s, even when the process and nginx are both healthy', async (_label, publicUrl) => {
    const ctx = verifyCtx({ upstream: '200', publicCode: '302', state: { publicUrl } });
    await expect(stepById(ctx, 'identity').run(ctx)).rejects.toBeInstanceOf(StepAborted);
  });
});

describe('hetzner redeploy', () => {
  it('dry-run reports intent and never touches confirmListening/verify', async () => {
    const infos: string[] = [];
    const ui = { ...createAutoUi(), info: (m: string) => infos.push(m) } as Ui;
    const ctx = ctxWith({ dryRun: true, ui, state: { domain: 'login.cezar.example.com' } });
    await hetzner.redeploy!(ctx);
    expect(infos.some((m) => m.includes('DRY RUN'))).toBe(true);
  });

  it('refreshes the npx cache before restarting an npx-launched unit — same #696 guard ubuntu-vps.ts uses', async () => {
    // refreshNpxCacheForRedeploy (reused verbatim from ubuntu-vps.ts) only clears the real cache
    // dir when `ctx.dryRun` is false — same guard its own test file exercises directly. Redeploy
    // otherwise proceeds to restart+re-verify, so the fake runner below answers every probe green.
    const cache = mkdtempSync(join(tmpdir(), 'cez-hetzner-npx-'));
    const prevCache = process.env.npm_config_cache;
    process.env.npm_config_cache = cache;
    try {
      mkdirSync(join(cache, '_npx', 'aaaa', 'node_modules', 'cezar-cli'), { recursive: true });
      const runner: Runner = {
        interactive: async () => 0,
        capture: async (program, args) => {
          if (args.includes('ExecStart')) return { code: 0, stdout: '/n/npx --yes cezar-cli serve --no-open --port 4321', stderr: '' };
          if (program === 'curl') return { code: 0, stdout: args.includes('-H') ? '302' : '200', stderr: '' };
          return { code: 0, stdout: '', stderr: '' };
        },
      };
      const ctx = ctxWith({
        runner,
        state: { domain: 'login.cezar.example.com', publicUrl: 'https://login.cezar.example.com' },
      });
      await hetzner.redeploy!(ctx);
      expect(existsSync(join(cache, '_npx', 'aaaa'))).toBe(false);
    } finally {
      if (prevCache === undefined) delete process.env.npm_config_cache;
      else process.env.npm_config_cache = prevCache;
      rmSync(cache, { recursive: true, force: true });
    }
  });

  it('non-dry-run: restarts, waits for listening, and re-verifies through nginx (org mode expects 401)', async () => {
    const runner: Runner = {
      interactive: async () => 0,
      capture: async (program, args) => {
        if (args.includes('ExecStart')) return { code: 0, stdout: '/usr/bin/node /srv/cezar/dist/index.js serve --no-open --port 4321', stderr: '' };
        if (program === 'curl') return { code: 0, stdout: args.includes('-H') ? '401' : '200', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    const ctx = ctxWith({
      runner,
      state: { domain: 'acme.cezar.example.com', orgSlug: 'acme', publicUrl: 'https://acme.cezar.example.com' },
    });
    await expect(hetzner.redeploy!(ctx)).resolves.toBeUndefined();
  });

  it('non-dry-run: throws StepAborted when the deployment is not actually working after the restart', async () => {
    const runner: Runner = {
      interactive: async () => 0,
      capture: async (program, args) => {
        if (args.includes('ExecStart')) return { code: 0, stdout: '/usr/bin/node /srv/cezar/dist/index.js serve --no-open --port 4321', stderr: '' };
        if (program === 'curl') return { code: 0, stdout: '000', stderr: '' }; // nothing listening
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    const ctx = ctxWith({ runner, state: { domain: 'login.cezar.example.com' } });
    await expect(hetzner.redeploy!(ctx)).rejects.toBeInstanceOf(StepAborted);
  });
});
