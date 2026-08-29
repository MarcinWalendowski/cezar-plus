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
 * A parked worktree must be able to ANSWER its deploy probe, not merely be asked.
 *
 * THE BUG, measured on prod-host 2026-08-29. A manual-deploy park is satisfied by
 * activating `origin/main`. The commits that activation makes live did not exist when the parked
 * worktree was cut, and nothing fetches into a parked worktree — so the live sha is not in its
 * object db, and every git question about it errors "unknown object" instead of answering "no".
 * The probe every worktree cut before 2026-08-26 carries folds those two together
 * (`git merge-base --is-ancestor "$head" "$live" 2>/dev/null`) and prints "the running server is
 * NOT serving this HEAD" — so a CORRECT activation reads as a red, permanently. Production had
 * sat on one release for four days and an operator had pressed Resolve five times.
 *
 * WHY THE FIX CANNOT LIVE IN THE PROBE, which is where it looks like it belongs. The probe WAS
 * taught to fetch (`.ai/deploy-targets.json`, 2026-08-26). But that repair ships in the REPO,
 * while the probe that runs for a parked run is the copy inside the run's OWN worktree — cut
 * before the fix existed and never updated. A worktree-side fix reaches every run except the ones
 * already parked, and the ones already parked are the entire population it was written for.
 *
 * So the engine refreshes the worktree before probing, and this file pins that. The fixture uses
 * the OLD probe shape on purpose: it is what the stuck runs actually carry, and a test written
 * against the fixed probe would pass with the engine fix reverted.
 */
describe('a manual-deploy park whose worktree has never seen the deployed commit', () => {
  let repoRoot: string;
  let originRepo: string;
  let worktree: string;
  let liveSha: string;
  let store: RunStore;

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-parked-fetch-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));

    // The remote the activation deploys from.
    originRepo = mkdtempSync(join(tmpdir(), 'cez-parked-fetch-origin-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: originRepo });
    writeFileSync(join(originRepo, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: originRepo });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'the commit the run was cut at'], { cwd: originRepo });

    // The run's worktree: a clone taken BEFORE the activation's commit existed.
    worktree = mkdtempSync(join(tmpdir(), 'cez-parked-fetch-wt-'));
    rmSync(worktree, { recursive: true, force: true });
    await run('git', ['clone', '-q', originRepo, worktree]);
    mkdirSync(join(worktree, '.ai'), { recursive: true });

    // ...and then main moves on, exactly as it does while a run sits parked.
    writeFileSync(join(originRepo, 'b.txt'), 'two\n');
    await run('git', ['add', '-A'], { cwd: originRepo });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'what the operator activates'], { cwd: originRepo });
    liveSha = (await run('git', ['rev-parse', 'HEAD'], { cwd: originRepo })).stdout.trim();

    // The post-condition short-circuits green under CEZ_DRY_RUN, which would clear the park with
    // no probe running at all and make every assertion below pass for the wrong reason.
    delete process.env.CEZ_DRY_RUN;
  });

  afterEach(() => {
    store.flush();
    for (const dir of [repoRoot, originRepo, worktree]) rmSync(dir, { recursive: true, force: true });
  });

  const frozen = () => new WorkspaceSemaphore({ initial: { maxParallel: 0 } });

  /**
   * The probe as the stuck production runs carry it: HEAD is green when it is an ancestor of the
   * live sha, and `2>/dev/null` means an unresolvable live sha is reported as "not deployed".
   */
  const declareOldShapeProbe = (): void => {
    writeFileSync(
      join(worktree, '.ai/deploy-targets.json'),
      JSON.stringify({
        targets: [
          {
            name: 'svc',
            manual: true,
            manualReason: 'a person activates it',
            probe: [
              'set -u',
              `live=${liveSha}`,
              'head=$(git rev-parse HEAD)',
              'git merge-base --is-ancestor "$head" "$live" 2>/dev/null && { echo "live=$live contains HEAD"; exit 0; }',
              'echo "live=$live head=$head — the running server is NOT serving this HEAD"',
              'exit 1',
            ].join('\n'),
          },
        ],
      }),
    );
  };

  const parkedRun = (): string => {
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
      worktreePath: worktree,
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

  it('cannot resolve the deployed commit before the recheck — the precondition this all rests on', async () => {
    // Without this the whole file could pass against a worktree that happened to know the sha,
    // which is the one thing that makes the bug disappear.
    await expect(run('git', ['cat-file', '-e', `${liveSha}^{commit}`], { cwd: worktree })).rejects.toThrow();
  });

  it('REFRESHES the worktree, so an activation of main clears the park instead of reading red', async () => {
    declareOldShapeProbe();
    const id = parkedRun();

    await new RunManager(store, repoRoot, { semaphore: frozen() }).recheckManualDeployParks();

    const after = store.getRun(id);
    expect(after?.pendingHandoff).toBeUndefined();
    expect(after?.steps.find((s) => s.id === 'deploy')?.status).toBe('pending');
    // And the reason it went green is the fetch, not luck: the object is present now.
    await expect(run('git', ['cat-file', '-e', `${liveSha}^{commit}`], { cwd: worktree })).resolves.toBeTruthy();
  });

  it('still leaves a park red when the deployed commit is NOT this HEAD’s descendant', async () => {
    // The negative control. Fetching must make the probe ABLE to answer, never make it say yes:
    // a divergent line is still a red after the object arrives. Without this, "refresh then
    // probe" could be replaced by "refresh then assume green" and the test above would not care.
    await run('git', ['checkout', '-q', '-b', 'sideline'], { cwd: worktree });
    writeFileSync(join(worktree, 'c.txt'), 'three\n');
    await run('git', ['add', '-A'], { cwd: worktree });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'a commit that never landed on main'], { cwd: worktree });
    declareOldShapeProbe();
    const id = parkedRun();

    await new RunManager(store, repoRoot, { semaphore: frozen() }).recheckManualDeployParks();

    const after = store.getRun(id);
    expect(after?.status).toBe('waiting');
    expect(after?.pendingHandoff?.kind).toBe('manual-deploy');
  });
});
