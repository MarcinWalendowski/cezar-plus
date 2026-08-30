import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RunStore } from '../runs/store.ts';
import { localCliAuthor } from '../runs/task-author.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';
import type { PostconditionResult } from './postconditions.ts';
import {
  ACTIVATION_LOCK_TTL_MS,
  activationArgv,
  activationEnv,
  activationInFlight,
  activationLogPath,
  markActivationLaunched,
  readActivationCommands,
  readActivationCommandsFromRef,
  type ActivationHost,
} from './manual-activation.ts';

type Gate = {
  active: Map<string, unknown>;
  awaitHandoff: (
    runId: string,
    state: Record<string, unknown>,
    step: { id: string },
    emit: (event: unknown) => void,
    verdict: PostconditionResult,
    recheck: () => Promise<PostconditionResult>,
  ) => Promise<{ kind: string; verdict?: PostconditionResult }>;
};

const targetsFile = (root: string, targets: unknown): void => {
  mkdirSync(join(root, '.ai'), { recursive: true });
  writeFileSync(join(root, '.ai/deploy-targets.json'), JSON.stringify({ targets }), 'utf8');
};

describe('readActivationCommands — which manual deployments a click may run', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-activate-read-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('takes only manual targets that declare a command AND are among the ones that failed', () => {
    targetsFile(root, [
      { name: 'backend', probe: 'true', manual: true, activate: 'deploy-backend.sh' },
      // Declares a command but is not manual — the automatic path deploys it, and running this
      // from a click would deploy a service nobody parked on.
      { name: 'auto', probe: 'true', activate: 'deploy-auto.sh' },
      // Manual, but PASSING this round: redeploying a live service to satisfy a different one's
      // red is the failure mode a per-target filter exists to prevent.
      { name: 'green-one', probe: 'true', manual: true, activate: 'deploy-green.sh' },
      // Manual and failing, but declares no command — the pre-existing behaviour, unchanged.
      { name: 'no-command', probe: 'true', manual: true },
    ]);

    expect(readActivationCommands(root, ['backend', 'no-command'])).toEqual([
      { name: 'backend', command: 'deploy-backend.sh' },
    ]);
  });

  it('runs ONE command once, however many targets declare it', () => {
    // cezar's own two targets are a single blue-green cutover declared twice. Per-target dispatch
    // would launch it concurrently with itself — the exact double-cutover that flips the symlink
    // mid-stage, and the one destructive outcome this feature can produce.
    targetsFile(root, [
      { name: 'backend', probe: 'true', manual: true, activate: 'scripts/activate-main.sh' },
      { name: 'ui', probe: 'true', manual: true, activate: 'scripts/activate-main.sh' },
      { name: 'other', probe: 'true', manual: true, activate: 'scripts/deploy-other.sh' },
    ]);

    const commands = readActivationCommands(root, ['backend', 'ui', 'other']);
    expect(commands).toHaveLength(2);
    // Merged, so the operator still sees everything the single launch covers.
    expect(commands[0]).toEqual({ name: 'backend, ui', command: 'scripts/activate-main.sh' });
    expect(commands[1]).toEqual({ name: 'other', command: 'scripts/deploy-other.sh' });
  });

  it('reads as "no way to deploy" rather than throwing, for every unreadable shape', () => {
    // Each of these is a live possibility on a real box, and each must degrade to the old
    // re-probe-only behaviour instead of failing the click.
    expect(readActivationCommands(root, ['backend'])).toEqual([]); // absent file
    mkdirSync(join(root, '.ai'), { recursive: true });
    writeFileSync(join(root, '.ai/deploy-targets.json'), '{ not json', 'utf8');
    expect(readActivationCommands(root, ['backend'])).toEqual([]);
    targetsFile(root, [{ name: 'backend' }]); // fails the schema — no probe
    expect(readActivationCommands(root, ['backend'])).toEqual([]);
  });
});

/**
 * The fallback has to read a REF, not the project root's working tree.
 *
 * MEASURED 2026-08-29: on prod-host the project root IS the shared checkout task worktrees
 * fork from, and nothing brings it forward — `activate-main.sh` refuses to `reset --hard` there by
 * design, and agents fetch without pulling. It sat 22 commits behind `origin/main` with 4 dirty
 * files. Its working tree is the LEAST current of the three copies, so a fallback that reads it is
 * a fallback onto a snapshot from whenever someone last touched the box.
 */
describe('readActivationCommandsFromRef — the declaration as origin has it', () => {
  let repo: string;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cez-activate-ref-'));
    const git = async (args: string[]): Promise<void> => {
      await promisify(execFile)('git', ['-c', 'user.name=t', '-c', 'user.email=t@l', ...args], { cwd: repo });
    };
    await git(['init', '-q', '-b', 'main']);
    targetsFile(repo, [{ name: 'backend', probe: 'true', manual: true, activate: 'scripts/activate-main.sh' }]);
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'declare the activation']);
    // A remote-tracking ref pointing at that commit, exactly as a fetched checkout has.
    await git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    // …and then the WORKING TREE goes stale and dirty, which is the production state.
    targetsFile(repo, [{ name: 'backend', probe: 'true', manual: true }]);
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('reads the ref even when the working tree has drifted away from it', () => {
    // The working-tree read is the control: it finds nothing, which is precisely the production
    // failure this replaces. If both returned the same thing the test would prove nothing.
    expect(readActivationCommands(repo, ['backend'])).toEqual([]);
    expect(readActivationCommandsFromRef(repo, 'origin/main', ['backend'])).toEqual([
      { name: 'backend', command: 'scripts/activate-main.sh' },
    ]);
  });

  it('answers "nothing declared" for a ref that does not resolve, rather than throwing', () => {
    // A repo with no remote at all — the caller then falls through to the working tree.
    expect(readActivationCommandsFromRef(repo, 'origin/nonexistent', ['backend'])).toEqual([]);
    expect(readActivationCommandsFromRef(join(tmpdir(), 'cez-not-a-repo'), 'origin/main', ['backend'])).toEqual([]);
  });
});

describe('activationArgv — the command has to outlive the restart it causes', () => {
  const base = {
    unitId: 'activate-abc12345-backend',
    command: 'scripts/activate-main.sh',
    cwd: '/srv/app',
    logPath: '/srv/app/.ai/cezar/activations/activate-abc12345-backend.log',
  };

  it('hands the command to a transient USER unit when systemd-run is there', () => {
    const argv = activationArgv({ ...base, user: true, systemdRun: true });
    expect(argv[0]).toBe('systemd-run');
    // `--user` must precede `--unit`: systemd-run picks its bus from that flag, so the order is
    // load-bearing rather than cosmetic (`buildSystemdRunArgv`'s own comment).
    expect(argv.indexOf('--user')).toBeLessThan(argv.findIndex((a) => a.startsWith('--unit=')));
    // The escape is the entire point — a child inside cezar.service's cgroup is killed by the
    // restart this command performs, potentially with the symlink already flipped.
    expect(argv).toContain('--property=KillMode=process');
    expect(argv.slice(-3)).toEqual(['bash', '-lc', 'scripts/activate-main.sh']);
    // NOT /var/log/cezar. The service account cannot create that directory (`mkdir: Permission
    // denied`, measured on prod-host), and systemd refuses to START a unit whose `append:`
    // target is unwritable — so the default log path alone is enough to make every launch fail.
    expect(argv).toContain(`--property=StandardOutput=append:${base.logPath}`);
    expect(argv.join(' ')).not.toContain('/var/log/cezar');
  });

  it('does not block the click: the transient unit is Type=exec, never Type=oneshot', () => {
    // THE 2026-08-30 REGRESSION, at the call site that paid for it. `registerUnit` runs this argv
    // through `spawnSync` on the POST /handoff/resolve path deliberately, so that a launch which
    // fails is reported rather than silently locked. With `Type=oneshot` the start job completes
    // only when the command EXITS, so that spawnSync blocked node's event loop for the entire
    // ~62 s activation — 4 of 4 Resolve-driven restarts hit TimeoutStopSec and were SIGKILLed,
    // against 0 of 5 restarts driven from an ssh `cez server-deploy`.
    const argv = activationArgv({ ...base, user: true, systemdRun: true });
    expect(argv).toContain('--property=Type=exec');
    expect(argv).not.toContain('--property=Type=oneshot');
    expect(argv).not.toContain('--no-block');
  });

  it('carries the user bus coordinates, which cezar.service does not have', () => {
    // MEASURED 2026-08-29, the first production press: `systemd-run --user` failed with "Failed to
    // connect to user scope bus via local transport: $DBUS_SESSION_BUS_ADDRESS and
    // $XDG_RUNTIME_DIR not defined". The service's own /proc/<pid>/environ has NEITHER. An ssh
    // session HAS them, which is precisely why this is invisible until it runs inside the service.
    const env = activationEnv({ PATH: '/usr/bin' }, true);
    expect(env.XDG_RUNTIME_DIR).toMatch(/^\/run\/user\/\d+$/);
    expect(env.DBUS_SESSION_BUS_ADDRESS).toContain('/bus');
    expect(env.PATH).toBe('/usr/bin'); // the caller's environment is kept, not replaced
    // Root uses the SYSTEM manager, which needs no session bus.
    expect(activationEnv({ PATH: '/usr/bin' }, false)).toEqual({ PATH: '/usr/bin' });
  });

  it('puts the log inside the project, where the service account can actually write', () => {
    expect(activationLogPath('/var/lib/x/.ai/cezar', 'activate-1-backend'))
      .toBe('/var/lib/x/.ai/cezar/activations/activate-1-backend.log');
  });

  it('asks the SYSTEM manager only when it is already root', () => {
    expect(activationArgv({ ...base, user: false, systemdRun: true })).not.toContain('--user');
  });

  it('falls back to a plain shell where there is no systemd-run', () => {
    // On a box with no systemd there is no unit to restart, so the escape buys nothing and
    // refusing would make the feature unreachable off the production host.
    expect(activationArgv({ ...base, user: true, systemdRun: false })).toEqual([
      'bash', '-lc', 'scripts/activate-main.sh',
    ]);
  });
});

describe('the activation lock — a second click must not flip the symlink under the first', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-activate-lock-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('holds for its TTL and then lets go', () => {
    const t0 = 1_000_000;
    expect(activationInFlight(dir, t0)).toBeUndefined();
    markActivationLaunched(dir, t0);
    expect(activationInFlight(dir, t0 + 60_000)).toBe(t0);
    expect(activationInFlight(dir, t0 + ACTIVATION_LOCK_TTL_MS + 1)).toBeUndefined();
  });

  it('is a FILE, because the thing it guards restarts this process', () => {
    // An in-memory flag would be cleared by the very event it exists to survive — which is also
    // the event that makes the operator click again, since the page goes quiet.
    const t0 = 2_000_000;
    markActivationLaunched(dir, t0);
    expect(activationInFlight(dir, t0 + 1_000)).toBe(t0);
    writeFileSync(join(dir, 'activation.lock'), 'not-a-number', 'utf8');
    expect(activationInFlight(dir, t0 + 1_000)).toBeUndefined();
  });
});

/**
 * The wiring, through the real park: a Resolve press on a still-red manual-deploy handoff RUNS the
 * deployment the repo declares, instead of only reporting that it has not happened.
 *
 * Owner decision 2026-08-29. D6 ("a person activates cezar, not an agent") is intact — a person
 * pressing the button IS the activation. What changed is that they no longer have to leave the
 * cockpit and remember a runbook to act on what the card already told them.
 */
describe('a Resolve press runs the manual deployment', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let spawned: Array<{ argv: string[]; cwd: string }>;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-activate-gate-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    manager = new RunManager(store, repoRoot, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 1 } }) });
    spawned = [];
    // NEVER the real host here: its `spawnDetached` runs an actual deploy.
    manager.activationHost = {
      systemdRunAvailable: () => false,
      isRoot: () => false,
      registerUnit: (argv, _env, cwd) => {
        spawned.push({ argv, cwd });
        return { ok: true };
      },
      spawnDetached: (argv, _env, cwd) => {
        spawned.push({ argv, cwd });
      },
    } satisfies ActivationHost;
  });

  afterEach(() => {
    manager.dispose();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const RED: PostconditionResult = {
    ok: false,
    detail: 'manual deployment required for backend; FAIL backend — `probe source`',
    summary: 'backend\nlive=aaa head=bbb — the running server is NOT serving this HEAD',
    handoff: { kind: 'manual-deploy', reason: 'activate it', targets: ['backend'] },
  };

  const park = (): string => {
    const run = store.createRun({
      author: localCliAuthor(),
      title: 'handoff',
      workflow: 'spec-to-deploy',
      task: 'ship it',
      steps: [{ id: 'deploy', name: 'Deploy', kind: 'check' }],
    });
    store.updateRun(run.id, { status: 'running', currentStepId: 'deploy' });
    store.updateStep(run.id, 'deploy', { status: 'running' });
    const state = { cancelled: false, interrupt: () => undefined, cwd: repoRoot };
    (manager as unknown as Gate).active.set(run.id, state);
    void (manager as unknown as Gate).awaitHandoff(run.id, state, { id: 'deploy' }, () => undefined, RED, async () => RED);
    return run.id;
  };

  it('launches the declared command and answers `activating`, not a refusal', async () => {
    targetsFile(repoRoot, [{ name: 'backend', probe: 'false', manual: true, activate: 'scripts/activate-main.sh' }]);
    const id = park();
    await new Promise<void>((r) => setImmediate(r));

    const result = await manager.resolveHandoff(id, 'ada');

    expect(result).toMatchObject({ ok: true, resolved: false, activating: true });
    expect(result.verdict).toContain('deploying backend');
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.argv).toEqual(['bash', '-lc', 'scripts/activate-main.sh']);
    expect(spawned[0]?.cwd).toBe(repoRoot);
    // Still parked: the run is resumed by the post-restart sweep re-probing, never by this click.
    expect(store.getRun(id)?.pendingHandoff).toBeDefined();
    expect(store.getRun(id)?.status).toBe('waiting');
  });

  it('deploys a park whose OWN worktree predates the feature, using the project root', async () => {
    // The runs that need this most are the ones parked longest, and their worktrees carry
    // `.ai/deploy-targets.json` as it was when they were cut — before `activate` existed. Without
    // the root fallback the feature reaches every run EXCEPT the backlog it was built for, which is
    // exactly how the parked-worktree probe repair failed before it.
    const stale = mkdtempSync(join(tmpdir(), 'cez-activate-stale-'));
    targetsFile(stale, [{ name: 'backend', probe: 'false', manual: true }]); // no `activate`
    targetsFile(repoRoot, [{ name: 'backend', probe: 'false', manual: true, activate: 'scripts/activate-main.sh' }]);

    const run = store.createRun({
      author: localCliAuthor(),
      title: 'stale worktree',
      workflow: 'spec-to-deploy',
      task: 'ship it',
      steps: [{ id: 'deploy', name: 'Deploy', kind: 'check' }],
    });
    store.updateRun(run.id, { status: 'running', currentStepId: 'deploy' });
    store.updateStep(run.id, 'deploy', { status: 'running' });
    const state = { cancelled: false, interrupt: () => undefined, cwd: stale };
    (manager as unknown as Gate).active.set(run.id, state);
    void (manager as unknown as Gate).awaitHandoff(run.id, state, { id: 'deploy' }, () => undefined, RED, async () => RED);
    await new Promise<void>((r) => setImmediate(r));

    const result = await manager.resolveHandoff(run.id, 'ada');

    expect(result).toMatchObject({ activating: true });
    expect(spawned).toHaveLength(1);
    // It runs in the RUN's worktree, not the root — the command is about this run's revision.
    expect(spawned[0]?.cwd).toBe(stale);
    rmSync(stale, { recursive: true, force: true });
  });

  it('finds the declaration on origin/main when BOTH working trees are stale', async () => {
    // Production's actual shape on prod-host: the run's worktree predates the feature, and
    // the project root is the shared checkout nothing pulls (22 behind, 4 dirty when measured). The
    // only current copy is the fetched ref. Both working-tree reads below are controls — each finds
    // nothing, so a pass here can only have come from the ref.
    const git = async (args: string[]): Promise<void> => {
      await promisify(execFile)('git', ['-c', 'user.name=t', '-c', 'user.email=t@l', ...args], { cwd: repoRoot });
    };
    await git(['init', '-q', '-b', 'main']);
    targetsFile(repoRoot, [{ name: 'backend', probe: 'false', manual: true, activate: 'scripts/activate-main.sh' }]);
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'declare it']);
    await git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    targetsFile(repoRoot, [{ name: 'backend', probe: 'false', manual: true }]); // root goes stale

    const stale = mkdtempSync(join(tmpdir(), 'cez-activate-stale-ref-'));
    targetsFile(stale, [{ name: 'backend', probe: 'false', manual: true }]); // worktree is stale too

    const run = store.createRun({
      author: localCliAuthor(),
      title: 'stale both',
      workflow: 'spec-to-deploy',
      task: 'ship it',
      steps: [{ id: 'deploy', name: 'Deploy', kind: 'check' }],
    });
    store.updateRun(run.id, { status: 'running', currentStepId: 'deploy', baseBranch: 'main' });
    store.updateStep(run.id, 'deploy', { status: 'running' });
    const state = { cancelled: false, interrupt: () => undefined, cwd: stale };
    (manager as unknown as Gate).active.set(run.id, state);
    void (manager as unknown as Gate).awaitHandoff(run.id, state, { id: 'deploy' }, () => undefined, RED, async () => RED);
    await new Promise<void>((r) => setImmediate(r));

    const result = await manager.resolveHandoff(run.id, 'ada');

    expect(result).toMatchObject({ activating: true });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.argv).toEqual(['bash', '-lc', 'scripts/activate-main.sh']);
    rmSync(stale, { recursive: true, force: true });
  });

  it('changes NOTHING for a repo that declares no activate command', async () => {
    // The load-bearing negative control. Same park, same red, same click — only the declaration is
    // missing. Without it, "Resolve deploys" would be indistinguishable from "Resolve deploys
    // whatever happens to be in the targets file", and every repo would inherit the behaviour.
    targetsFile(repoRoot, [{ name: 'backend', probe: 'false', manual: true }]);
    const id = park();
    await new Promise<void>((r) => setImmediate(r));

    const result = await manager.resolveHandoff(id, 'ada');

    expect(spawned).toHaveLength(0);
    expect(result.activating).toBeUndefined();
    // …and it still reports the probe's own concise verdict, exactly as before.
    expect(result.verdict).toContain('NOT serving this HEAD');
  });

  /**
   * MEASURED on the FIRST production press, 2026-08-29 — the defect this whole feature shipped
   * with, found by the E2E and not by any of the 14 tests that preceded it.
   *
   * `systemd-run --user` failed (no bus coordinates inside `cezar.service`, and an `append:` target
   * under `/var/log/cezar` the service account cannot create). The launcher spawned it detached
   * with `stdio: 'ignore'`, so the failure was invisible, and took the 15-minute lock anyway. The
   * operator was left blocked, with nothing running, and a second press correctly told them to wait
   * for a deploy that did not exist.
   *
   * A guard that fires for an action that never happened is worse than no guard.
   */
  it('takes NO lock when the launch itself fails, and says what failed', async () => {
    targetsFile(repoRoot, [{ name: 'backend', probe: 'false', manual: true, activate: 'scripts/activate-main.sh' }]);
    let attempts = 0;
    manager.activationHost = {
      systemdRunAvailable: () => true,
      isRoot: () => false,
      registerUnit: () => {
        attempts += 1;
        return { ok: false, error: 'Failed to connect to user scope bus via local transport' };
      },
      spawnDetached: () => {
        throw new Error('must not fall back to a detached spawn when systemd-run is available');
      },
    } satisfies ActivationHost;
    const id = park();
    await new Promise<void>((r) => setImmediate(r));

    const first = await manager.resolveHandoff(id, 'ada');

    expect(first.activating).toBeUndefined();
    expect(first.verdict).toContain('did not start');
    expect(first.verdict).toContain('user scope bus');

    // The decisive assertion: a SECOND press tries again rather than being told to wait for a
    // deployment that never started.
    const second = await manager.resolveHandoff(id, 'ada');
    expect(attempts).toBe(2);
    expect(second.verdict).not.toContain('still running');
  });

  it('refuses a second launch while the first is still presumed running', async () => {
    targetsFile(repoRoot, [{ name: 'backend', probe: 'false', manual: true, activate: 'scripts/activate-main.sh' }]);
    const id = park();
    await new Promise<void>((r) => setImmediate(r));

    await manager.resolveHandoff(id, 'ada');
    const second = await manager.resolveHandoff(id, 'ada');

    // Two cutovers at once is the one destructive outcome here — the second flips the symlink
    // under the first, mid-stage. Clicking twice is the EXPECTED behaviour when the page goes
    // quiet, and the page goes quiet because the first click restarted the server.
    expect(spawned).toHaveLength(1);
    expect(second.activating).toBeUndefined();
    expect(second.verdict).toContain('still running');
  });

  /**
   * Owner requirement, 2026-08-29: "if there are multiple tasks waiting for such a deployment — if
   * we press button in one of them, all should be resolved".
   *
   * One deployment settles every run parked on it, so a person must not have to open each task and
   * press Resolve to inform it of something that already happened. The sibling is parked exactly as
   * `allServicesDeployed` parks one, with its OWN worktree — its probe is what decides its fate, not
   * the pressed run's verdict.
   */
  it('settles the OTHER runs parked on the same deployment, from one press', async () => {
    // maxParallel 0: the requeued sibling queues instead of executing a chain, which would spawn a
    // real agent. Same device the existing sweep tests use.
    const frozen = new RunManager(store, repoRoot, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 0 } }) });
    try {
      const siblingTree = mkdtempSync(join(tmpdir(), 'cez-activate-sibling-'));
      targetsFile(siblingTree, [{ name: 'backend', probe: 'exit 0', manual: true, manualReason: 'a person activates it' }]);
      const sibling = store.createRun({
        author: localCliAuthor(),
        title: 'sibling',
        workflow: 'spec-to-deploy',
        task: 'also waiting',
        steps: [{ id: 'deploy', name: 'Deploy', kind: 'agent' }],
      });
      store.updateStep(sibling.id, 'deploy', { status: 'failed', error: 'manual deployment required' });
      store.updateRun(sibling.id, {
        status: 'waiting',
        waitingReason: 'handoff',
        worktreePath: siblingTree,
        pendingHandoff: {
          kind: 'manual-deploy',
          stepId: 'deploy',
          requestedAt: new Date().toISOString(),
          reason: 'activate it',
          targets: ['backend'],
        },
      });

      const run = store.createRun({
        author: localCliAuthor(),
        title: 'pressed',
        workflow: 'spec-to-deploy',
        task: 'ship it',
        steps: [{ id: 'deploy', name: 'Deploy', kind: 'check' }],
      });
      store.updateRun(run.id, { status: 'running', currentStepId: 'deploy' });
      store.updateStep(run.id, 'deploy', { status: 'running' });
      const state = { cancelled: false, interrupt: () => undefined, cwd: repoRoot };
      (frozen as unknown as Gate).active.set(run.id, state);
      const parked = (frozen as unknown as Gate).awaitHandoff(
        run.id, state, { id: 'deploy' }, () => undefined, RED,
        async () => ({ ok: true, detail: 'all services deployed' }),
      );
      await new Promise<void>((r) => setImmediate(r));

      expect(await frozen.resolveHandoff(run.id, 'ada')).toMatchObject({ resolved: true });
      await parked;

      // Fire-and-forget, so the click stays fast even with many parks — poll rather than assert
      // instantly. Without the sweep this never clears and the test times out.
      const deadline = Date.now() + 20_000;
      while (store.getRun(sibling.id)?.pendingHandoff && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(store.getRun(sibling.id)?.pendingHandoff).toBeUndefined();
      rmSync(siblingTree, { recursive: true, force: true });
    } finally {
      frozen.dispose();
    }
  }, 30_000);

  it('does not deploy when the re-probe comes back GREEN', async () => {
    // Ordering: the deployment runs only after the re-probe says red. A service that is already
    // live must never be redeployed to satisfy a click.
    targetsFile(repoRoot, [{ name: 'backend', probe: 'true', manual: true, activate: 'scripts/activate-main.sh' }]);
    const run = store.createRun({
      author: localCliAuthor(),
      title: 'handoff',
      workflow: 'spec-to-deploy',
      task: 'ship it',
      steps: [{ id: 'deploy', name: 'Deploy', kind: 'check' }],
    });
    store.updateRun(run.id, { status: 'running', currentStepId: 'deploy' });
    store.updateStep(run.id, 'deploy', { status: 'running' });
    const state = { cancelled: false, interrupt: () => undefined, cwd: repoRoot };
    (manager as unknown as Gate).active.set(run.id, state);
    const parked = (manager as unknown as Gate).awaitHandoff(
      run.id, state, { id: 'deploy' }, () => undefined, RED,
      async () => ({ ok: true, detail: 'all services deployed' }),
    );
    await new Promise<void>((r) => setImmediate(r));

    const result = await manager.resolveHandoff(run.id, 'ada');
    await parked;

    expect(result).toMatchObject({ ok: true, resolved: true });
    expect(spawned).toHaveLength(0);
  });
});
