import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunRecord } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';
import { localCliAuthor } from '../runs/task-author.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * Invariant I1 at the one place a run becomes terminal
 * (spec 2026-08-20-chain-integrity-restart-and-continuation, P0).
 *
 * The recorded incident: run `be31d9e9` (workflow `spec-to-deploy`, 2026-08-20 09:58–10:04Z)
 * was marked `done` after step 1 of 6. `implement`, `run-tests`, `commit-push`, `document` and
 * `deploy` never ran, twelve project worktrees were applied back to their checkouts and the task
 * closed. `settleSuccess` read `worktreePath`, `baseBranch` and `autonomous` — and never once
 * read `steps`. Its record shape is reconstructed here so the incident is a permanent regression
 * test, alongside the three shapes that must keep settling exactly as they always did.
 *
 * Harness per `recover-autonomous.test.ts`: a real (tiny) git repo, a store, and a workspace
 * semaphore capped at 0 so nothing the guard re-queues can ever spawn.
 */
describe('a run cannot finish while its chain still has pending steps (P0)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;

  const CHAIN = ['spec', 'implement', 'run-tests', 'commit-push', 'document', 'deploy'];
  const SPEC_TO_DEPLOY = {
    name: 'spec-to-deploy',
    description: 'x',
    source: 'built-in' as const,
    steps: CHAIN.map((id) => ({ id, name: id, prompt: '{{task}}' })),
  };

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-chain-p0-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 0 } }),
    });
  });

  afterEach(() => {
    manager.dispose();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const settle = (id: string) =>
    (manager as unknown as { settleSuccess(id: string): Promise<void> }).settleSuccess(id);

  /** Exactly the record be31d9e9 held at 10:04:21Z, minus the parts settleSuccess never reads. */
  function incidentRecord(): RunRecord {
    const { id } = store.createRun({ author: localCliAuthor(),
      title: 'the reported bug',
      workflow: 'spec-to-deploy',
      task: 'there is a critical bug somewhere',
      autonomous: true,
      steps: CHAIN.map((s) => ({ id: s, name: s, kind: 'agent' as const })),
    });
    store.updateRun(id, {
      workflowDef: SPEC_TO_DEPLOY,
      // Twelve project worktrees, exactly what `applyWorkspaceRun` merged back and cleared.
      workspaceWorktrees: Array.from({ length: 12 }, (_, n) => ({
        root: `/tmp/project-${n}`,
        worktreePath: `/tmp/project-${n}/.wt`,
        branch: `cez/be31d9e9`,
        baseBranch: 'main',
      })),
    });
    store.updateStep(id, 'spec', { status: 'done' });
    // The synthetic continuation restart recovery created mid-chain, already closed.
    store.addStep(id, { id: 'continue-1', name: 'Continue', kind: 'agent' });
    store.updateStep(id, 'continue-1', { status: 'done' });
    return store.getRun(id) as RunRecord;
  }

  it('the incident: a mid-chain settle does NOT finish the run and does NOT apply worktrees back', async () => {
    const record = incidentRecord();
    await settle(record.id);

    const after = store.getRun(record.id);
    expect(after?.status).not.toBe('done');
    expect(after?.status).not.toBe('review');
    expect(after?.status).toBe('waiting');
    expect(after?.finishedAt).toBeUndefined();
    // R5: the work is still isolated and still recoverable — nothing was merged, nothing cleared.
    expect(after?.workspaceWorktrees).toHaveLength(12);
    // And the five steps are still there to run.
    expect(after?.steps.filter((s) => s.status === 'pending').map((s) => s.id)).toEqual([
      'implement',
      'run-tests',
      'commit-push',
      'document',
      'deploy',
    ]);
    const messages = store
      .readEvents(record.id)
      .filter((e) => e.type === 'lifecycle')
      .map((e) => e.message);
    expect(messages).toContain('chain incomplete — 5 step(s) still pending; the run was not finished');
    expect(messages).not.toContain('run finished');
  });

  it('a COMPLETED six-step chain still settles done', async () => {
    const record = incidentRecord();
    for (const id of CHAIN) store.updateStep(record.id, id, { status: 'done' });
    await settle(record.id);
    expect(store.getRun(record.id)?.status).toBe('done');
    expect(store.getRun(record.id)?.finishedAt).toBeDefined();
  });

  it('a chain whose remaining steps are failed/cancelled/skipped still settles', async () => {
    const record = incidentRecord();
    store.updateStep(record.id, 'implement', { status: 'failed' });
    store.updateStep(record.id, 'run-tests', { status: 'cancelled' });
    for (const id of ['commit-push', 'document', 'deploy']) {
      store.updateStep(record.id, id, { status: 'skipped' });
    }
    await settle(record.id);
    expect(store.getRun(record.id)?.status).toBe('done');
  });

  it('a single-step quick-task still settles done (the no-regression pin)', async () => {
    const { id } = store.createRun({ author: localCliAuthor(),
      title: 't',
      workflow: 'quick-task',
      task: 'do it',
      steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
    });
    store.updateRun(id, {
      workflowDef: { name: 'quick-task', description: 'x', source: 'built-in', steps: [{ id: 'work', name: 'Work' }] },
    });
    store.updateStep(id, 'work', { status: 'done' });
    await settle(id);
    expect(store.getRun(id)?.status).toBe('done');
  });

  it('a record with no workflowDef still settles done (R1, fail open)', async () => {
    const { id } = store.createRun({ author: localCliAuthor(),
      title: 't',
      workflow: 'spec-to-deploy',
      task: 'do it',
      steps: CHAIN.map((s) => ({ id: s, name: s, kind: 'agent' as const })),
    });
    store.updateStep(id, 'spec', { status: 'done' }); // five still pending, but no def to read
    await settle(id);
    expect(store.getRun(id)?.status).toBe('done');
  });
});
