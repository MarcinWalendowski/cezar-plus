import { describe, expect, it, vi } from 'vitest';
import {
  agentCredentialLoginCommands,
  createCezHomeCommand,
  createOrgUserCommand,
  orgCezHome,
  orgHomeDir,
  orgUnixUsername,
  orgUserProvisioningStep,
  trustProjectRootCommand,
} from './provision-user.ts';
import { StepAborted } from '../../steps.ts';
import { createAutoUi } from '../../ui.ts';
import type { InstallContext, Runner, Ui } from '../../types.ts';

/**
 * Every assertion below is on GENERATED STRINGS (commands, or the argv a fake
 * `Runner` recorded) — nothing here creates a unix user, writes outside a
 * fake in-memory runner, or touches this machine. `Runner.capture`/
 * `.interactive` are plain functions that record what they were asked to run
 * and return a canned result; `sudoStep` calls them exactly as it would call
 * real `child_process.spawn`, but nothing here IS `child_process.spawn`.
 */

function ctxWith(over: {
  ui?: Ui;
  runner?: Runner;
  dryRun?: boolean;
  assumeYes?: boolean;
  repoRoot?: string;
}): InstallContext {
  const okRunner: Runner = { capture: async () => ({ code: 0, stdout: '', stderr: '' }), interactive: async () => 0 };
  return {
    state: { schema: 1, installed: false, primaryPort: 4321, steps: {} },
    ui: over.ui ?? createAutoUi(),
    instance: 'default',
    runner: over.runner ?? okRunner,
    save: async () => {},
    dryRun: over.dryRun ?? false,
    assumeYes: over.assumeYes ?? true,
    reconfigure: new Set(),
    repoRoot: over.repoRoot ?? '/srv/acme-app',
    now: '2026-08-07T00:00:00.000Z',
    prefs: {},
  };
}

describe('orgUnixUsername', () => {
  it('prefixes a short slug verbatim', () => {
    expect(orgUnixUsername('acme')).toBe('cez-acme');
  });

  it('is deterministic — same slug, same username, every call', () => {
    expect(orgUnixUsername('acme-corp')).toBe(orgUnixUsername('acme-corp'));
  });

  it('rejects a slug that is not DNS-label-shaped', () => {
    expect(() => orgUnixUsername('Acme')).toThrow(StepAborted);
    expect(() => orgUnixUsername('acme corp')).toThrow(StepAborted);
    expect(() => orgUnixUsername('-acme')).toThrow(StepAborted);
    expect(() => orgUnixUsername('acme-')).toThrow(StepAborted);
    expect(() => orgUnixUsername('acme; rm -rf /')).toThrow(StepAborted);
    expect(() => orgUnixUsername('')).toThrow(StepAborted);
  });

  it('stays within the 32-char utmp limit for a long slug, deterministically', () => {
    const slug = 'a'.repeat(63); // the max a DNS-label slug allows (auth/types.ts#slugSchema)
    const username = orgUnixUsername(slug);
    expect(username.length).toBeLessThanOrEqual(32);
    expect(username).toBe(orgUnixUsername(slug)); // deterministic
  });

  it('two long slugs sharing a truncation-length prefix never collide', () => {
    const base = 'x'.repeat(40);
    const a = orgUnixUsername(`${base}-alpha-team`);
    const b = orgUnixUsername(`${base}-bravo-team`);
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(32);
    expect(b.length).toBeLessThanOrEqual(32);
  });
});

describe('orgHomeDir / orgCezHome', () => {
  it('composes the standard paths', () => {
    expect(orgHomeDir('cez-acme')).toBe('/home/cez-acme');
    expect(orgCezHome('cez-acme')).toBe('/home/cez-acme/.cezar');
  });
});

describe('createOrgUserCommand', () => {
  it('guards useradd behind an existence check (idempotent) and locks the home to 0700', () => {
    const cmd = createOrgUserCommand('cez-acme', 'acme');
    expect(cmd).toContain('id -u cez-acme >/dev/null 2>&1 ||');
    expect(cmd).toContain('useradd --create-home --home-dir /home/cez-acme --user-group --shell /bin/bash');
    expect(cmd).toContain("--comment 'cezar org: acme'");
    expect(cmd).toContain('chown cez-acme:cez-acme /home/cez-acme');
    expect(cmd).toContain('chmod 0700 /home/cez-acme');
  });

  it('never adds the user to a privileged group', () => {
    const cmd = createOrgUserCommand('cez-acme', 'acme');
    expect(cmd).not.toMatch(/\bsudo\b.*-G/);
    expect(cmd).not.toContain('adm');
    expect(cmd).not.toContain('docker');
  });
});

describe('createCezHomeCommand', () => {
  it('creates and locks CEZ_HOME in one atomic install -d', () => {
    expect(createCezHomeCommand('cez-acme')).toBe('install -d -m 0700 -o cez-acme -g cez-acme /home/cez-acme/.cezar');
  });
});

describe('trustProjectRootCommand', () => {
  it('is idempotent — checks before it adds, so a re-run never grows a duplicate entry', () => {
    const cmd = trustProjectRootCommand('cez-acme', '/srv/acme-app');
    expect(cmd).toContain("git config --global --get-all safe.directory 2>/dev/null | grep -qxF '/srv/acme-app'");
    expect(cmd).toContain("|| sudo -u cez-acme -H git config --global --add safe.directory '/srv/acme-app'");
  });

  it('runs as the org user via sudo -u -H, not as whoever provisioned it', () => {
    const cmd = trustProjectRootCommand('cez-acme', '/srv/acme-app');
    expect(cmd).toContain('sudo -u cez-acme -H git config');
  });

  it('single-quotes a repo root containing a space so a copy-paste runs exactly what we run', () => {
    const cmd = trustProjectRootCommand('cez-acme', '/srv/my app');
    expect(cmd).toContain("'/srv/my app'");
  });
});

describe('agentCredentialLoginCommands', () => {
  it('covers all three agent CLIs, each dropping into the org uid', () => {
    const logins = agentCredentialLoginCommands('cez-acme');
    expect(logins.map((l) => l.agent)).toEqual(['claude', 'codex', 'opencode']);
    for (const l of logins) expect(l.command).toContain('sudo -u cez-acme -H');
  });

  it('matches each CLI’s real login subcommand (core/provider-auth.ts#DESCRIPTORS)', () => {
    const logins = agentCredentialLoginCommands('cez-acme');
    expect(logins.find((l) => l.agent === 'claude')?.command).toBe('sudo -u cez-acme -H claude auth login');
    expect(logins.find((l) => l.agent === 'codex')?.command).toBe('sudo -u cez-acme -H codex login');
    expect(logins.find((l) => l.agent === 'opencode')?.command).toBe('sudo -u cez-acme -H opencode auth login');
  });
});

describe('orgUserProvisioningStep', () => {
  it('rejects an invalid org slug synchronously, before any step is built', () => {
    expect(() => orgUserProvisioningStep('Not A Slug')).toThrow(StepAborted);
  });

  it('id is stable ("org-user") and the step is required, not optional', () => {
    const step = orgUserProvisioningStep('acme');
    expect(step.id).toBe('org-user');
    expect(step.optional).toBeFalsy();
  });

  it('dry-run produces the unix-user artifact without touching the runner', async () => {
    const capture = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const interactive = vi.fn(async () => 0);
    const ctx = ctxWith({ dryRun: true, runner: { capture, interactive } });
    const created = await orgUserProvisioningStep('acme').run(ctx);
    const artifact = created?.artifacts.find((a) => a.type === 'unix-user');
    expect(artifact?.kind).toBe('shared');
    expect(artifact?.name).toBe('cez-acme');
    expect(interactive).not.toHaveBeenCalled();
  });

  it('happy path: emits useradd, CEZ_HOME creation and the safe.directory trust, in order, via sudo', async () => {
    const commands: string[] = [];
    const runner: Runner = {
      capture: async (program, args) => {
        if (program === 'sudo' && args[0] === '-n' && args[1] === 'true') return { code: 0, stdout: '', stderr: '' }; // passwordless sudo
        if (program === 'sudo' && args.includes('bash')) return { code: 0, stdout: '', stderr: '' }; // root read-back probes
        if (program === 'sh') return { code: 0, stdout: '700 cez-acme', stderr: '' }; // stat probes
        if (program === 'test') return { code: 0, stdout: '', stderr: '' };
        if (program === 'id') return { code: 0, stdout: '1001', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
      interactive: async (program, args) => {
        if (program === 'sudo') commands.push(args.join(' '));
        return 0;
      },
    };
    const ctx = ctxWith({ runner, repoRoot: '/srv/acme-app' });
    const created = await orgUserProvisioningStep('acme').run(ctx);

    expect(commands.some((c) => c.includes('useradd') && c.includes('cez-acme'))).toBe(true);
    expect(commands.some((c) => c.includes('install -d -m 0700 -o cez-acme -g cez-acme /home/cez-acme/.cezar'))).toBe(
      true,
    );
    // The org's OWN project root, created 0700 inside the 0700 home.
    expect(
      commands.some((c) => c.includes('install -d -m 0700 -o cez-acme -g cez-acme /home/cez-acme/workspace')),
    ).toBe(true);
    expect(
      commands.some((c) => c.includes('sudo -u cez-acme -H git config') && c.includes('/home/cez-acme/workspace')),
    ).toBe(true);

    /**
     * NEGATIVE CONTROL for the phase-6 verification row ("no shared path; org A cannot read org
     * B's runs"). `ctx.repoRoot` is the OPERATOR's checkout — the git root of wherever they ran
     * `server-install` — and it is the SAME value for every org provisioned on one host. This step
     * used to hand it to `trustProjectRootCommand`, and `hetzner.ts` used to hand it to
     * `WorkingDirectory=`, so two orgs' processes both opened `<operator checkout>/.ai/cezar` —
     * one leaseless `RunStore`, two writers, silent history loss (spec Problem §4).
     *
     * Asserting only the positive (`/home/cez-acme/workspace` appears) would still pass if the
     * operator's root were ALSO trusted, which is most of the damage. This asserts the absence.
     */
    expect(commands.some((c) => c.includes('/srv/acme-app'))).toBe(false);

    const artifact = created?.artifacts.find((a) => a.type === 'unix-user');
    expect(artifact?.kind).toBe('shared');
    expect(artifact?.name).toBe('cez-acme');
    expect(artifact?.path).toBe('/home/cez-acme');
    expect(artifact?.removeHint).toContain('userdel');
  });

  it('prints the three agent-login commands and names why OpenCode needs the uid switch', async () => {
    const notes: Array<{ message: string; title?: string }> = [];
    const ui = { ...createAutoUi(), note: (message: string, title?: string) => notes.push({ message, title }) } as Ui;
    const runner: Runner = {
      capture: async () => ({ code: 0, stdout: '700 cez-acme', stderr: '' }),
      interactive: async () => 0,
    };
    await orgUserProvisioningStep('acme').run(ctxWith({ ui, runner }));

    const credNote = notes.find((n) => n.title?.includes('Agent credentials'));
    expect(credNote).toBeDefined();
    expect(credNote?.message).toContain('sudo -u cez-acme -H claude auth login');
    expect(credNote?.message).toContain('sudo -u cez-acme -H codex login');
    expect(credNote?.message).toContain('sudo -u cez-acme -H opencode auth login');
    expect(credNote?.message).toContain('OpenCode has no such variable');
    // D4's "within-org is shared, and said out loud" — restated at provisioning time too.
    expect(credNote?.message).toContain('Invite accordingly');
  });

  it('refuses to run without a repo root to trust', async () => {
    const ctx = ctxWith({ repoRoot: '' });
    await expect(orgUserProvisioningStep('acme').run(ctx)).rejects.toBeInstanceOf(StepAborted);
  });

  it('check() is unprivileged-readable (stat/test/id never need root) and reports satisfied only when all three hold', async () => {
    const calls: string[] = [];
    const satisfied: Runner = {
      capture: async (program, args) => {
        calls.push([program, ...args].join(' '));
        if (program === 'id') return { code: 0, stdout: '1001', stderr: '' };
        if (program === 'sh') return { code: 0, stdout: '700 cez-acme', stderr: '' };
        if (program === 'test') return { code: 0, stdout: '', stderr: '' };
        return { code: 1, stdout: '', stderr: '' };
      },
      interactive: async () => 0,
    };
    expect(await orgUserProvisioningStep('acme').check(ctxWith({ runner: satisfied, assumeYes: true }))).toBe(true);
    // none of the probes escalate to sudo
    expect(calls.some((c) => c.includes('sudo'))).toBe(false);

    const notYet: Runner = {
      capture: async (program) => (program === 'id' ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: '', stderr: '' }),
      interactive: async () => 0,
    };
    expect(await orgUserProvisioningStep('acme').check(ctxWith({ runner: notYet }))).toBe(false);
  });

  it('check() is always false in dry-run (matches every other step in this codebase)', async () => {
    expect(await orgUserProvisioningStep('acme').check(ctxWith({ dryRun: true }))).toBe(false);
  });

  it('undo lists the removal command and NEVER deletes the user (shared artifact, real credentials live there)', async () => {
    const notes: string[] = [];
    const ui = { ...createAutoUi(), note: (m: string) => notes.push(m) } as Ui;
    const capture = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const interactive = vi.fn(async () => 0);
    const ctx = ctxWith({ ui, runner: { capture, interactive } });

    await orgUserProvisioningStep('acme').undo(ctx, {
      artifacts: [{ kind: 'shared', type: 'unix-user', name: 'cez-acme', path: '/home/cez-acme', removeHint: 'sudo userdel -r cez-acme' }],
    });

    expect(notes.some((n) => n.includes('userdel -r cez-acme'))).toBe(true);
    expect(capture).not.toHaveBeenCalled();
    expect(interactive).not.toHaveBeenCalled();
  });

  it('undo does nothing when no unix-user artifact was recorded', async () => {
    const note = vi.fn();
    const ui = { ...createAutoUi(), note } as Ui;
    await orgUserProvisioningStep('acme').undo(ctxWith({ ui }), { artifacts: [] });
    expect(note).not.toHaveBeenCalled();
    await orgUserProvisioningStep('acme').undo(ctxWith({ ui }), null);
    expect(note).not.toHaveBeenCalled();
  });
});

/**
 * `label` vs `orgSlug`: `hetzner.ts` reuses this ONE step, unmodified, for its cluster worker's
 * own identity under the reserved `WORKER_PSEUDO_SLUG` ('worker') — a real slug, but not a real
 * org. Before this test existed, every string below was built from `orgSlug` alone, so the worker
 * case rendered "org \"worker\"" — literally false, since 'worker' is a pseudo-slug for a single
 * cluster worker process, not an organization. `git diff` against the commit before this change
 * confirms the floor: `orgUserProvisioningStep('worker').title` there reads
 * `... for org "worker" (D4 process isolation)`. Every assertion below is on the RENDERED string,
 * for BOTH call shapes this step is actually invoked with (`hetzner.ts`'s org and worker modes),
 * not just the one case named in the bug — a fix that only covered 'worker' could not catch the
 * same mistake reappearing in a future third mode.
 */
describe('orgUserProvisioningStep — label describes who this is for, independent of the slug', () => {
  /** Same shape as the "happy path" runner above, parameterized by username so it fits both the
   *  org and the worker-mode unix user. */
  function fullRunner(username: string): Runner {
    return {
      capture: async (program, args) => {
        if (program === 'sudo' && args[0] === '-n' && args[1] === 'true') return { code: 0, stdout: '', stderr: '' };
        if (program === 'sudo' && args.includes('bash')) return { code: 0, stdout: '', stderr: '' };
        if (program === 'sh') return { code: 0, stdout: `700 ${username}`, stderr: '' };
        if (program === 'test') return { code: 0, stdout: '', stderr: '' };
        if (program === 'id') return { code: 0, stdout: '1001', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
      interactive: async () => 0,
    };
  }

  it('with no label, defaults to `org "<slug>"` — unchanged from before this parameter existed', () => {
    const step = orgUserProvisioningStep('acme');
    expect(step.title).toBe('Dedicated unix user + CEZ_HOME + project root for org "acme" (D4 process isolation)');
  });

  it('with an explicit label, the title reads correctly for a caller whose slug is not an org name', () => {
    const step = orgUserProvisioningStep('worker', 'this worker');
    expect(step.title).toBe('Dedicated unix user + CEZ_HOME + project root for this worker (D4 process isolation)');
    expect(step.title).not.toContain('org "worker"');
  });

  it('threads the label into the create-user command description, for both modes', async () => {
    const orgInfo: string[] = [];
    const orgUi = { ...createAutoUi(), info: (m: string) => orgInfo.push(m) } as Ui;
    await orgUserProvisioningStep('acme').run(ctxWith({ ui: orgUi, runner: fullRunner('cez-acme') }));
    expect(orgInfo.some((m) => m.includes('for org "acme" and lock its home to 0700'))).toBe(true);

    const workerInfo: string[] = [];
    const workerUi = { ...createAutoUi(), info: (m: string) => workerInfo.push(m) } as Ui;
    await orgUserProvisioningStep('worker', 'this worker').run(
      ctxWith({ ui: workerUi, runner: fullRunner('cez-worker') }),
    );
    expect(workerInfo.some((m) => m.includes('for this worker and lock its home to 0700'))).toBe(true);
    expect(workerInfo.some((m) => m.includes('org "worker"'))).toBe(false);
  });

  it('threads the label into the agent-credentials note title and body, for both modes', async () => {
    const orgNotes: Array<{ message: string; title?: string }> = [];
    const orgUi = {
      ...createAutoUi(),
      note: (message: string, title?: string) => orgNotes.push({ message, title }),
    } as Ui;
    await orgUserProvisioningStep('acme').run(ctxWith({ ui: orgUi, runner: fullRunner('cez-acme') }));
    const orgNote = orgNotes.find((n) => n.title?.startsWith('Agent credentials'));
    expect(orgNote?.title).toBe('Agent credentials for org "acme"');
    expect(orgNote?.message).toContain('member of org "acme". Invite accordingly.');

    const workerNotes: Array<{ message: string; title?: string }> = [];
    const workerUi = {
      ...createAutoUi(),
      note: (message: string, title?: string) => workerNotes.push({ message, title }),
    } as Ui;
    await orgUserProvisioningStep('worker', 'this worker').run(
      ctxWith({ ui: workerUi, runner: fullRunner('cez-worker') }),
    );
    const workerNote = workerNotes.find((n) => n.title?.startsWith('Agent credentials'));
    expect(workerNote?.title).toBe('Agent credentials for this worker');
    expect(workerNote?.message).toContain('member of this worker. Invite accordingly.');
    // The negative half: the bug this test guards against is specifically the word "org"
    // showing up next to the pseudo-slug, not just SOME wrong string.
    expect(workerNote?.title).not.toContain('org "worker"');
    expect(workerNote?.message).not.toContain('org "worker"');
  });
});
