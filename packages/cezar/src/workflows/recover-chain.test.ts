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
 * Restart recovery re-enters the CHAIN
 * (spec 2026-08-20-chain-integrity-restart-and-continuation, P1/P2).
 *
 * Before this, `recover()`'s `running` branch marked the interrupted step `failed` with an EMPTY
 * error and replaced the remaining workflow steps with a synthetic `continue-N` chat session —
 * so a restart during ANY non-final step silently converted a six-step pipeline into a one-step
 * conversation, and nothing in the record said the other five were never going to happen. The
 * `waiting` branch settled the run outright. Both now hand the run back to its own definition.
 *
 * The workspace semaphore is capped at 0 so the re-queued run stays queued and nothing spawns —
 * this is a test of the recovery decision, not of the agent.
 */
describe('recover() re-enters the workflow chain (P1/P2)', () => {
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
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-chain-p1-'));
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
      pendingJobs: Map<string, { workflow: { steps: { id: string }[] }; resumeAt?: { index: number; resume?: { sessionId: string; prompt: string } } }>;
      pendingContinuations: Map<string, unknown>;
    };

  /** A six-step chain interrupted mid-`spec`, exactly as a SIGKILL leaves it. */
  function interruptedRun(opts: { status: 'running' | 'waiting'; withDef?: boolean; sessionId?: string } = { status: 'running' }): string {
    const { id } = store.createRun({
      title: 't',
      workflow: 'spec-to-deploy',
      task: 'fix the bug',
      autonomous: true,
      steps: CHAIN.map((s) => ({ id: s, name: s, kind: 'agent' as const })),
    });
    if (opts.withDef !== false) store.updateRun(id, { workflowDef: SPEC_TO_DEPLOY });
    store.updateRun(id, { status: opts.status, currentStepId: 'spec' });
    store.updateStep(id, 'spec', {
      status: opts.status,
      iterations: 1,
      sessionId: opts.sessionId ?? 'sess-spec-1',
      backend: 'claude',
    });
    return id;
  }

  it('a run interrupted mid-chain is re-queued as a WORKFLOW, not turned into a chat', async () => {
    const id = interruptedRun({ status: 'running' });

    await manager.recover();

    const after = store.getRun(id);
    expect(after?.status).toBe('queued');
    // The bug's signature: a synthetic continuation replacing the remaining five steps.
    expect(after?.steps.map((s) => s.id)).toEqual(CHAIN);
    expect(after?.steps.some((s) => s.id.startsWith('continue-'))).toBe(false);
    expect(internals().pendingContinuations.has(id)).toBe(false);
    // `spec` did NOT fail — it was interrupted, and it is about to be resumed.
    expect(after?.steps.find((s) => s.id === 'spec')?.status).toBe('pending');
    expect(after?.error).toBeUndefined();
    // Re-entry goes through the queue (never a direct execute()) — R2.
    expect(internals().queue).toContain(id);
    const job = internals().pendingJobs.get(id);
    expect(job?.workflow.steps.map((s) => s.id)).toEqual(CHAIN);
    expect(job?.resumeAt?.index).toBe(0);
    // …resuming the interrupted step's own session, with the restart prompt naming the position.
    expect(job?.resumeAt?.resume?.sessionId).toBe('sess-spec-1');
    expect(job?.resumeAt?.resume?.prompt).toContain('resuming step 1 of 6');
  });

  it('resumes at the step that was actually interrupted, not at the top', async () => {
    const id = interruptedRun({ status: 'running' });
    store.updateStep(id, 'spec', { status: 'done' });
    store.updateStep(id, 'implement', { status: 'running', sessionId: 'sess-impl', backend: 'claude' });
    store.updateRun(id, { currentStepId: 'implement' });

    await manager.recover();

    const job = internals().pendingJobs.get(id);
    expect(job?.resumeAt?.index).toBe(1);
    expect(job?.resumeAt?.resume?.sessionId).toBe('sess-impl');
    expect(job?.resumeAt?.resume?.prompt).toContain('resuming step 2 of 6');
    expect(store.getRun(id)?.steps.find((s) => s.id === 'spec')?.status).toBe('done');
  });

  it('does not reattach a session minted by another backend (R3)', async () => {
    const id = interruptedRun({ status: 'running' });
    store.updateStep(id, 'spec', { backend: 'codex' }); // run.runner is claude
    await manager.recover();
    const job = internals().pendingJobs.get(id);
    expect(job?.resumeAt?.index).toBe(0);
    expect(job?.resumeAt?.resume).toBeUndefined(); // starts fresh instead of corrupting the run
  });

  it('a WAITING run with pending chain steps is re-queued, not settled', async () => {
    const id = interruptedRun({ status: 'waiting' });

    await manager.recover();

    const after = store.getRun(id);
    expect(after?.status).toBe('queued');
    expect(after?.finishedAt).toBeUndefined();
    // The open step really was finished — the CHAIN was not.
    expect(after?.steps.find((s) => s.id === 'spec')?.status).toBe('done');
    expect(internals().pendingJobs.get(id)?.resumeAt?.index).toBe(1);
    // A settled step is not resumed: the next step is new work and opens a fresh session.
    expect(internals().pendingJobs.get(id)?.resumeAt?.resume).toBeUndefined();
  });

  it('a WAITING run whose chain is finished still settles (the no-regression pin)', async () => {
    const id = interruptedRun({ status: 'waiting' });
    for (const s of CHAIN.slice(1)) store.updateStep(id, s, { status: 'done' });

    await manager.recover();

    expect(store.getRun(id)?.status).toBe('done');
    expect(internals().queue).not.toContain(id);
  });

  // The narrowing: recovery only TAKES OVER from `continueRun` when the chain outlives the
  // interrupted step. The continuation path resumes that step's own session — which is the whole
  // job for a single-step workflow — and it carries behaviour this fix has no business changing
  // (per-project cap queueing, #562 session-failure containment).
  it('a single-step quick-task still takes the continuation path', async () => {
    const { id } = store.createRun({
      title: 't',
      workflow: 'quick-task',
      task: 'do it',
      runner: 'claude',
      steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
    });
    store.updateRun(id, {
      workflowDef: { name: 'quick-task', description: 'x', source: 'built-in', steps: [{ id: 'work', name: 'Work' }] },
      status: 'running',
      currentStepId: 'work',
    });
    store.updateStep(id, 'work', { status: 'running', sessionId: 'sess-work', backend: 'claude' });

    await manager.recover();

    expect(store.getRun(id)?.steps.some((s) => s.id.startsWith('continue-'))).toBe(true);
    expect(internals().pendingJobs.has(id)).toBe(false);
  });

  it('a chain interrupted on its LAST step takes the continuation path — nothing would be dropped', async () => {
    const id = interruptedRun({ status: 'running' });
    for (const s of CHAIN.slice(0, 5)) store.updateStep(id, s, { status: 'done' });
    store.updateStep(id, 'spec', { status: 'done' });
    store.updateStep(id, 'deploy', { status: 'running', sessionId: 'sess-deploy', backend: 'claude' });
    store.updateRun(id, { currentStepId: 'deploy' });

    await manager.recover();

    expect(store.getRun(id)?.steps.some((s) => s.id.startsWith('continue-'))).toBe(true);
    expect(internals().pendingJobs.has(id)).toBe(false);
  });

  // The catalog-fallback hazard: a record with NO `workflowDef` revives `quick-task` from the
  // catalog, whose step is named `task` — while this record's step is named `work`. Every def
  // step then reads as "never reached", and an unguarded re-entry would re-run a finished step.
  it('does not re-enter against a catalog def that does not describe this run', async () => {
    const { id } = store.createRun({
      title: 't',
      workflow: 'quick-task',
      task: 'do it',
      steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
    });
    store.updateStep(id, 'work', { status: 'waiting', sessionId: 'sess-1', backend: 'claude' });
    store.updateRun(id, { status: 'waiting' }); // no workflowDef → catalog fallback

    await manager.recover();

    // Settled as it always was — NOT re-queued to run `work` a second time.
    expect(store.getRun(id)?.status).toBe('done');
    expect(internals().pendingJobs.has(id)).toBe(false);
    expect(internals().queue).not.toContain(id);
  });

  // R4: a hand-back that does not shorten the chain is a loop (step ends → re-enter → step ends),
  // and a loop that never advances is worse than a stall — it burns the budget silently. Only the
  // turn-end hand-back asks for progress; recovery may legitimately re-enter the SAME step twice.
  it('fails the run loudly when a hand-back makes no progress (R4)', async () => {
    const id = interruptedRun({ status: 'running' });
    store.updateStep(id, 'spec', { status: 'done' });
    const reenter = (opts: { requireProgress?: boolean }) =>
      (
        manager as unknown as {
          reenterChain(run: unknown, reason: string, opts: { requireProgress?: boolean }): Promise<boolean>;
        }
      ).reenterChain(store.getRun(id), 'step goal achieved', opts);

    expect(await reenter({ requireProgress: true })).toBe(true);
    expect(store.getRun(id)?.status).toBe('queued');

    // Same record, nothing advanced — the second hand-back is the loop.
    expect(await reenter({ requireProgress: true })).toBe(true);
    const after = store.getRun(id);
    expect(after?.status).toBe('failed');
    expect(after?.error).toContain('chain re-entry made no progress');
    expect(after?.error).toContain('implement');
  });

  it('recovery may re-enter the same step twice — a second restart is not a loop', async () => {
    const id = interruptedRun({ status: 'running' });
    await manager.recover();
    expect(store.getRun(id)?.status).toBe('queued');

    // A second crash before the resumed step got anywhere.
    store.updateRun(id, { status: 'running' });
    store.updateStep(id, 'spec', { status: 'running' });
    await manager.recover();

    expect(store.getRun(id)?.status).toBe('queued');
    expect(store.getRun(id)?.error).toBeUndefined();
    expect(internals().pendingJobs.get(id)?.resumeAt?.index).toBe(0);
  });

  it('with no revivable definition, the old continuation path runs — and the step says WHY it stopped', async () => {
    const id = interruptedRun({ status: 'running', withDef: false });
    // `spec-to-deploy` is a real catalog workflow, so make the name unresolvable too.
    store.updateRun(id, { workflow: 'a-workflow-that-no-longer-exists' });

    await manager.recover();

    const after = store.getRun(id);
    expect(after?.steps.some((s) => s.id.startsWith('continue-'))).toBe(true);
    // The mislabel the owner saw: `failed` with an EMPTY error, which the cockpit rendered as a
    // bare failure. It did not fail; it was interrupted, and now it says so.
    expect(after?.steps.find((s) => s.id === 'spec')?.error).toBe(
      'interrupted — cezar process exited during the run',
    );
  });
});
