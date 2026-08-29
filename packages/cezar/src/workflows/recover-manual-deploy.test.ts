import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';
import { localCliAuthor } from '../runs/task-author.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * A restart re-probes every `manual-deploy` park (`.ai/specs/2026-08-26-activate-main-not-worktrees.md` S4).
 *
 * On a blue-green box an ACTIVATION IS A RESTART, so boot is the exact moment such a park may
 * have just been satisfied. Before this, `recover()` only re-announced the wait, and a human
 * pressed Resolve once per parked run even though every one of them was waiting on the same
 * single activation.
 *
 * Two properties carry the design and each is asserted below.
 *
 * 1. It PROBES first and requeues only on green. `requeueHandoff` re-enters the chain at the
 *    deploy step, which is an agent step, so an unconditional requeue would spend a model call
 *    per parked run on every restart — including the crash restarts that changed nothing.
 * 2. It is NOT part of `recover()`, and the last test here exists to keep it that way.
 *    `recover()` is awaited before `startServer()`, and a deploy probe asks the local server
 *    which sha it is serving — from `recover()` it would interrogate a socket that is not
 *    accepting yet, report red for every run, and burn its bounded poll per run on the way.
 *    Moving the sweep back into `recover()` is a one-line change that looks tidier and silently
 *    disables the feature, which is exactly what a regression test is for.
 */
describe('a run parked on a manual deploy, re-probed after the server is listening', () => {
  let repoRoot: string;
  let worktree: string;
  let store: RunStore;

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-recover-deploy-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));

    worktree = mkdtempSync(join(tmpdir(), 'cez-recover-deploy-wt-'));
    mkdirSync(join(worktree, '.ai'), { recursive: true });
    // The post-condition short-circuits green under CEZ_DRY_RUN, which would clear every park
    // regardless of what the probes say and make all three cases below pass for the wrong reason.
    delete process.env.CEZ_DRY_RUN;
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });

  const frozen = () => new WorkspaceSemaphore({ initial: { maxParallel: 0 } });

  /** Declare one manual target whose probe exits 0 (deployed) or 1 (still behind). */
  const declareTarget = (live: boolean): void => {
    writeFileSync(
      join(worktree, '.ai/deploy-targets.json'),
      JSON.stringify({
        targets: [
          {
            name: 'svc',
            manual: true,
            manualReason: 'a person activates it',
            probe: live ? 'exit 0' : 'echo still on the old sha; exit 1',
          },
        ],
      }),
    );
  };

  /** A run parked exactly as `allServicesDeployed` parks one, with a worktree to probe in. */
  const parkedRun = (opts: { worktreePath?: string } = {}): string => {
    const { id } = store.createRun({
      author: localCliAuthor(),
      title: 't',
      workflow: 'spec-to-deploy',
      task: 'ship it',
      steps: [{ id: 'deploy', name: 'Deploy', kind: 'agent' }],
    });
    store.updateStep(id, 'deploy', { status: 'failed', error: 'manual deployment required' });
    store.updateRun(id, {
      status: 'waiting',
      waitingReason: 'handoff',
      worktreePath: 'worktreePath' in opts ? opts.worktreePath : worktree,
      pendingHandoff: {
        kind: 'manual-deploy',
        stepId: 'deploy',
        requestedAt: new Date().toISOString(),
        reason: 'manual deployment required for svc',
        targets: ['svc'],
      },
    });
    return id;
  };

  it('RECHECKS a park whose targets now probe green, so no Resolve press is needed', async () => {
    declareTarget(true);
    const id = parkedRun();

    await new RunManager(store, repoRoot, { semaphore: frozen() }).recheckManualDeployParks();

    const after = store.getRun(id);
    expect(after?.pendingHandoff).toBeUndefined();
    expect(after?.steps.find((s) => s.id === 'deploy')?.status).toBe('pending');
  });

  it('LEAVES a park whose targets are still red exactly as it found it', async () => {
    declareTarget(false);
    const id = parkedRun();

    await new RunManager(store, repoRoot, { semaphore: frozen() }).recheckManualDeployParks();

    // The negative control for the test above: if the sweep requeued unconditionally, that test
    // would pass with no probe running at all, and this one is the only thing that can tell.
    const after = store.getRun(id);
    expect(after?.status).toBe('waiting');
    expect(after?.pendingHandoff?.kind).toBe('manual-deploy');
    expect(after?.steps.find((s) => s.id === 'deploy')?.status).toBe('failed');
  });

  it('LEAVES a park whose worktree is gone — an absent directory is not evidence of a deploy', async () => {
    declareTarget(true); // green targets, but the run cannot reach them
    const id = parkedRun({ worktreePath: join(tmpdir(), 'cez-reclaimed-by-retention-does-not-exist') });

    await new RunManager(store, repoRoot, { semaphore: frozen() }).recheckManualDeployParks();

    const after = store.getRun(id);
    expect(after?.status).toBe('waiting');
    expect(after?.pendingHandoff?.kind).toBe('manual-deploy');
  });

  it('is NOT run by recover(): that runs before the server listens, so the probe could not answer', async () => {
    declareTarget(true);
    const id = parkedRun();

    await new RunManager(store, repoRoot, { semaphore: frozen() }).recover();

    // Green targets and an intact park: recover() must have left it alone. If this ever fails,
    // someone folded the sweep back into recover() and the feature is now dead on the real box
    // while every test that drives it directly still passes.
    const after = store.getRun(id);
    expect(after?.status).toBe('waiting');
    expect(after?.pendingHandoff?.kind).toBe('manual-deploy');
  });

  it('leaves a manual-MERGE park alone: only manual-deploy parks are re-probed', async () => {
    declareTarget(true);
    const id = parkedRun();
    store.updateRun(id, {
      pendingHandoff: {
        kind: 'manual-merge',
        stepId: 'deploy',
        requestedAt: new Date().toISOString(),
        reason: 'manual merge required',
      },
    });

    await new RunManager(store, repoRoot, { semaphore: frozen() }).recheckManualDeployParks();

    const after = store.getRun(id);
    expect(after?.status).toBe('waiting');
    expect(after?.pendingHandoff?.kind).toBe('manual-merge');
  });
});
