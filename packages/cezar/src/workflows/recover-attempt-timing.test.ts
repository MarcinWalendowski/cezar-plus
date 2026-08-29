import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunSpec, AgentRunner, AgentSession } from '../core/agent-runner.ts';
import { localCliAuthor } from '../runs/task-author.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * A controlled runner whose session never resolves on its own — `startSession` is asked for
 * exactly once per attempt the loop head opens, so polling `fake.specs.length` is a direct
 * observation of "`execute` passed the loop head", not a guess from timing. `interrupt()` settles
 * the pending session so `manager.cancel()` can tear a test down cleanly.
 */
const fake = vi.hoisted(() => ({
  specs: [] as AgentRunSpec[],
  settlers: [] as Array<() => void>,
}));

vi.mock('../core/runner-factory.ts', (): { createRunner: () => AgentRunner } => ({
  createRunner: (): AgentRunner => ({
    backend: 'claude',
    run: async () => ({ text: '', events: [] }) as never,
    startSession: (spec: AgentRunSpec): AgentSession => {
      fake.specs.push(spec);
      let settle!: () => void;
      const result = new Promise<{ text: string; toolCalls: never[]; tokensUsed: number }>((resolve) => {
        settle = () => resolve({ text: '', toolCalls: [], tokensUsed: 0 });
      });
      fake.settlers.push(settle);
      return { result, sendMessage: () => true, end: () => {}, interrupt: () => settle(), open: true };
    },
    interrupt: async () => {},
  }),
}));

const { RunStore } = await import('../runs/store.ts');
const { RunManager } = await import('./run.ts');
const { BROKER_PROTOCOL, spoolDirFor, writeSpoolMeta } = await import('../core/run-spool.ts');
type Store = ReturnType<typeof RunStore.open>;
type Manager = InstanceType<typeof RunManager>;

/**
 * V6 (spec 2026-08-29-per-retry-step-timing): the two startup-recovery paths behave differently
 * (one is NOT a new attempt, one IS) and must be pinned apart at the step-loop head (`run.ts`
 * around the `pendingReattach` guard this spec adds). Neither is reachable from a bare
 * `updateStep` — both need a run record AND a restart.
 *
 * Both cases need EXECUTION-CAPABLE fixtures: `recover-brokered.test.ts` and
 * `recover-chain.test.ts` both pin `maxParallel: 0` so the recovery DECISION can be asserted with
 * nothing spawned, which is right for what they test but means `execute()`'s step-loop head — the
 * exact seam this spec changes — never runs there. This suite uses the DEFAULT semaphore (real
 * capacity) plus the controlled runner above, so entering `execute()` spawns nothing real but
 * demonstrably reaches the loop head.
 */
describe('recover() attempt timing at the step-loop head (spec 2026-08-29-per-retry-step-timing)', () => {
  let repoRoot: string;
  let dataDir: string;
  let store: Store;
  let manager: Manager;

  const CHAIN = ['implement', 'run-tests'];
  const WORKFLOW = {
    name: 'two-step',
    description: 'x',
    source: 'built-in' as const,
    steps: CHAIN.map((id) => ({ id, name: id, prompt: '{{task}}' })),
  };
  const STARTED_AT = '2026-08-29T00:00:00.000Z';

  beforeEach(async () => {
    fake.specs.length = 0;
    fake.settlers.length = 0;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-recover-attempt-timing-'));
    dataDir = join(repoRoot, '.ai/cezar');
    mkdirSync(join(dataDir, 'runs'), { recursive: true });
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(dataDir, { keepLive: true });
    // The DEFAULT semaphore — real capacity, deliberately not overridden to `maxParallel: 0` (see
    // the module doc comment above for why that would defeat this suite's whole point).
    manager = new RunManager(store, repoRoot, { reapBroker: async () => true });
  });

  afterEach(() => {
    manager.dispose();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /** A run interrupted mid-`implement`, its first attempt already open (the ordinary opening
   *  patch triggers `trackAttempt` exactly as a live engine would). */
  function runningRun(): string {
    const { id } = store.createRun({
      author: localCliAuthor(),
      title: 't',
      workflow: 'two-step',
      task: 'do the thing',
      autonomous: true,
      steps: CHAIN.map((s) => ({ id: s, name: s, kind: 'agent' as const })),
    });
    store.updateRun(id, { workflowDef: WORKFLOW, runner: 'claude' });
    store.updateRun(id, { status: 'running', currentStepId: 'implement' });
    store.updateStep(id, 'implement', {
      status: 'running',
      iterations: 1,
      sessionId: 'sess-implement-1',
      backend: 'claude',
      startedAt: STARTED_AT,
    });
    // The fixtures build their interrupted run with `store.updateStep`, which appends no event at
    // all — seeded explicitly so "the count is still 1" is not vacuously true against an empty
    // stream.
    store.appendEvent(id, { type: 'step-start', stepId: 'implement', name: 'implement', kind: 'agent', iteration: 1 });
    return id;
  }

  /** A spool whose broker is this very process, so `isPidAlive` is true by construction. */
  function liveSpool(runId: string, opts: { stepId?: string; pid?: number } = {}): string {
    const dir = spoolDirFor(join(dataDir, 'runs'), runId, 'test-instance');
    mkdirSync(dir, { recursive: true });
    writeSpoolMeta(dir, {
      schema: 1,
      protocol: BROKER_PROTOCOL,
      runId,
      stepId: opts.stepId ?? 'implement',
      backend: 'claude',
      pid: opts.pid ?? process.pid,
      argv: ['claude'],
      startedAt: new Date().toISOString(),
      instanceId: 'test-instance',
    });
    writeFileSync(join(dir, 'out.ndjson'), '');
    store.updateRun(runId, { spoolDir: relative(dataDir, dir), consumedOffset: 0 });
    return dir;
  }

  const stepStartIterations = (id: string, stepId: string): unknown[] =>
    store
      .readEvents(id)
      .filter((e) => e.type === 'step-start' && (e as { stepId?: string }).stepId === stepId)
      .map((e) => (e as { iteration?: unknown }).iteration);

  it('V6a — a live broker re-attach is NOT a new attempt', async () => {
    const id = runningRun();
    liveSpool(id);

    await manager.recover();
    // Let the queued work actually run: poll until the controlled runner has been asked for a
    // session, so `execute` has demonstrably passed the step-loop head and the live-spool path
    // has had its chance to open a second attempt.
    await vi.waitFor(() => expect(fake.specs.length).toBeGreaterThanOrEqual(1), { timeout: 5_000 });

    const step = store.getRun(id)?.steps.find((s) => s.id === 'implement');
    expect(step?.status).toBe('running');
    expect(step?.iterations).toBe(1);
    expect(step?.startedAt).toBe(STARTED_AT); // byte-identical to the pre-restart value
    expect(step?.attempts).toEqual([{ n: 1, startedAt: STARTED_AT }]); // still exactly one, still open
    expect(stepStartIterations(id, 'implement')).toEqual([1]); // NOT [1, 2]

    // Clean up the still-open session so nothing leaks past this test.
    manager.cancel(id);
    for (const settle of fake.settlers) settle();
  });

  it('V6b — dead-process chain re-entry IS a new attempt', async () => {
    const id = runningRun();
    // No live spool — `reattachBrokeredRun` refuses and `reenterChain` takes it.

    await manager.recover();
    await vi.waitFor(() => expect(fake.specs.length).toBeGreaterThanOrEqual(1), { timeout: 5_000 });

    const step = store.getRun(id)?.steps.find((s) => s.id === 'implement');
    expect(step?.iterations).toBe(2);
    expect(step?.attempts).toHaveLength(2);
    const [attempt1, attempt2] = step!.attempts!;
    expect(attempt1!.startedAt).toBe(STARTED_AT);
    expect(attempt1!.endedAt).toBeDefined(); // closed
    expect(attempt2!.startedAt >= attempt1!.endedAt!).toBe(true); // fresh startedAt, at/after attempt 1's close
    expect(attempt2!.endedAt).toBeUndefined(); // open — the controlled runner never settled
    expect(stepStartIterations(id, 'implement')).toEqual([1, 2]);

    manager.cancel(id);
    for (const settle of fake.settlers) settle();
  });
});
