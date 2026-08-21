import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * The human approval gate (spec
 * `.ai/specs/2026-08-20-split-steps-spec-review-and-approval-gate.md`, P3).
 *
 * These cases pin the two things that would make the gate dangerous rather than merely broken:
 *
 *  1. **A restart must not grant the approval.** `recover()`'s `waiting` branch settles every open
 *     step to `done` — which for a gated step would silently supply the "yes" a human never gave.
 *     Run `be31d9e9` is why this file distrusts restarts: two SIGKILLs during one step is what
 *     started this whole spec.
 *  2. **A decision that arrives with no live `execute()` still moves the chain.** The parked
 *     promise dies with the process, so the persisted record has to be enough on its own.
 *
 * The semaphore is capped at 0 so a re-queued run stays queued and no agent spawns — these are
 * tests of the gate's bookkeeping, not of a model.
 */
describe('the approval gate survives a restart', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;

  const CHAIN = ['context', 'spec', 'review-spec', 'implement', 'deploy'];
  const DEF = {
    name: 'spec-to-deploy',
    description: 'x',
    source: 'built-in' as const,
    steps: CHAIN.map((id) => ({
      id,
      name: id,
      prompt: '{{task}}',
      ...(id === 'review-spec'
        ? { requiresApproval: true, onFail: { retry: 'spec', max: 2 } }
        : {}),
    })),
  };

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-approval-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    manager = new RunManager(store, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 0 } }),
    });
  });

  afterEach(() => {
    manager.dispose();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const internals = () =>
    manager as unknown as {
      queue: string[];
      pendingJobs: Map<
        string,
        { workflow: { steps: { id: string }[] }; resumeAt?: { index: number; feedback?: string } }
      >;
    };

  /** A run parked on `review-spec`'s gate, exactly as `awaitApproval` leaves the record. */
  function parkedRun(approvals: { by: string; at: string }[] = [], minApprovers = 1): string {
    const { id } = store.createRun({
      title: 't',
      workflow: 'spec-to-deploy',
      task: 'do the thing',
      autonomous: true,
      steps: CHAIN.map((s) => ({ id: s, name: s, kind: 'agent' as const })),
    });
    store.updateRun(id, { workflowDef: DEF });
    for (const done of ['context', 'spec']) store.updateStep(id, done, { status: 'done' });
    store.updateRun(id, {
      status: 'waiting',
      currentStepId: 'review-spec',
      declaredSpecPath: '.ai/specs/x.md',
      pendingApproval: {
        stepId: 'review-spec',
        requestedAt: new Date().toISOString(),
        minApprovers,
        approvals,
        specPath: '.ai/specs/x.md',
      },
    });
    store.updateStep(id, 'review-spec', { status: 'waiting', sessionId: 'sess-review' });
    return id;
  }

  it('a restart leaves the run parked instead of settling the gated step to done', async () => {
    const id = parkedRun();

    await manager.recover();

    const after = store.getRun(id);
    // The failure this guards: `waiting` steps being marked `done` would BE the approval.
    expect(after?.status).toBe('waiting');
    expect(after?.steps.find((s) => s.id === 'review-spec')?.status).toBe('waiting');
    expect(after?.pendingApproval?.minApprovers).toBe(1);
    expect(after?.pendingApproval?.approvals).toEqual([]);
    // And it must not have run off the end of the chain either.
    expect(after?.steps.find((s) => s.id === 'implement')?.status).toBe('pending');
    expect(after?.finishedAt).toBeUndefined();
  });

  it('approving with no live execute() marks the step done and re-enters at the NEXT step', async () => {
    const id = parkedRun();

    const result = await manager.approveRun(id, 'ada', 'looks right');
    expect(result.ok).toBe(true);

    const after = store.getRun(id);
    expect(after?.pendingApproval).toBeUndefined();
    expect(after?.steps.find((s) => s.id === 'review-spec')?.status).toBe('done');
    // Re-entry lands on `implement` — the reviewer is NOT re-run, which would waste a session and
    // re-ask a question already answered.
    const job = internals().pendingJobs.get(id);
    expect(job?.resumeAt?.index).toBe(CHAIN.indexOf('implement'));
  });

  it('holds the gate until enough DISTINCT approvers have signed off', async () => {
    const id = parkedRun([], 2);

    const first = await manager.approveRun(id, 'ada');
    expect(first.ok).toBe(true);
    expect(store.getRun(id)?.pendingApproval?.approvals).toHaveLength(1);
    // Same person again is a correction, not a second vote — the gate must still hold.
    const again = await manager.approveRun(id, 'ada', 'still yes');
    expect(again.ok).toBe(true);
    expect(store.getRun(id)?.pendingApproval?.approvals).toHaveLength(1);
    expect(store.getRun(id)?.steps.find((s) => s.id === 'review-spec')?.status).toBe('waiting');

    await manager.approveRun(id, 'grace');
    expect(store.getRun(id)?.pendingApproval).toBeUndefined();
    expect(store.getRun(id)?.steps.find((s) => s.id === 'review-spec')?.status).toBe('done');
  });

  it('requesting changes with no live execute() rewinds to the spec step and carries the notes', async () => {
    const id = parkedRun();

    const result = await manager.requestChanges(id, 'ada', 'the API contract section is wrong');
    expect(result.ok).toBe(true);

    const after = store.getRun(id);
    expect(after?.pendingApproval).toBeUndefined();
    // Rewound: both the gated step and the step it loops back to are runnable again.
    expect(after?.steps.find((s) => s.id === 'spec')?.status).toBe('pending');
    expect(after?.steps.find((s) => s.id === 'review-spec')?.status).toBe('pending');
    // `context` is BEFORE the retry target and must not be re-run — the record was already read.
    expect(after?.steps.find((s) => s.id === 'context')?.status).toBe('done');

    const job = internals().pendingJobs.get(id);
    expect(job?.resumeAt?.index).toBe(CHAIN.indexOf('spec'));
    // The notes are the instructions. A rewind that dropped them would re-run `spec` blind.
    expect(job?.resumeAt?.feedback).toContain('the API contract section is wrong');
    expect(job?.resumeAt?.feedback).toContain('ada');
  });

  it('refuses a decision on a run that is not parked, and says so distinctly from "not found"', async () => {
    const { id } = store.createRun({
      title: 't',
      workflow: 'spec-to-deploy',
      task: 'x',
      steps: [{ id: 'context', name: 'context', kind: 'agent' as const }],
    });
    expect(await manager.approveRun(id, 'ada')).toMatchObject({ ok: false });
    expect((await manager.approveRun(id, 'ada')).error).toMatch(/not waiting for an approval/);
    expect((await manager.approveRun('nope-not-a-run', 'ada')).error).toBe('not found');
    expect(await manager.requestChanges(id, 'ada', 'x')).toMatchObject({ ok: false });
  });
});
