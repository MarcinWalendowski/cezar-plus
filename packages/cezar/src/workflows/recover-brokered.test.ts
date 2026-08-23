import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';
import { BROKER_PROTOCOL, spoolDirFor, writeSpoolExit, writeSpoolMeta } from '../core/run-spool.ts';
import { localCliAuthor } from '../runs/task-author.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * `recover()`'s re-attach branch — P4 of
 * `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`.
 *
 * The acceptance criterion this serves is "a deploy mid-run leaves the run alive and streaming",
 * and the failure it guards against is subtler than the criterion sounds. `recover()` already
 * handles a restart well: it marks the interrupted step failed and force-resumes the task in a
 * fresh session. That is CRASH recovery, and it is correct for a crash. A deploy is not a crash —
 * the agent is still running, still producing output into its spool — and treating it as one costs
 * the live context, adds an `interrupted` error to the transcript and injects a restart prompt on
 * every single deploy.
 *
 * So the branch must fire when the agent really is alive, and — much more importantly — must NOT
 * fire in every other case. A missed re-attach costs a restart. A WRONG re-attach orphans a live
 * agent that nothing is reading, which is strictly worse than the behaviour it replaced. Every
 * test below the first is about a way it must decline.
 */
describe('recover() re-attaches a run whose broker is still alive (P4)', () => {
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let manager: RunManager;

  const CHAIN = ['implement', 'run-tests'];
  const WORKFLOW = {
    name: 'two-step',
    description: 'x',
    source: 'built-in' as const,
    steps: CHAIN.map((id) => ({ id, name: id, prompt: '{{task}}' })),
  };

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-reattach-'));
    dataDir = join(repoRoot, '.ai/cezar');
    mkdirSync(join(dataDir, 'runs'), { recursive: true });
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(dataDir, { keepLive: true });
    // maxParallel 0 so nothing actually spawns: this tests the recovery DECISION.
    manager = new RunManager(store, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 0 } }),
      reapBroker: async () => true,
    });
  });

  afterEach(() => {
    manager.dispose();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /** A run interrupted mid-`implement`, exactly as a restart leaves it. */
  function runningRun(): string {
    const { id } = store.createRun({ author: localCliAuthor(),
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
    });
    return id;
  }

  /** A spool whose broker is this very process, so `isPidAlive` is true by construction. */
  function liveSpool(runId: string, opts: { stepId?: string; pid?: number; protocol?: number } = {}): string {
    const dir = spoolDirFor(join(dataDir, 'runs'), runId, 'test-instance');
    mkdirSync(dir, { recursive: true });
    writeSpoolMeta(dir, {
      schema: 1,
      protocol: opts.protocol ?? BROKER_PROTOCOL,
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

  const events = (id: string): string[] =>
    store.readEvents(id).map((e) => (typeof e.message === 'string' ? e.message : e.type));

  it('keeps the run RUNNING and does not force-continue it', async () => {
    const id = runningRun();
    liveSpool(id);

    await manager.recover();

    const record = store.getRun(id);
    // The whole point: no `queued`, no `failed`, no restart-continuation. The agent never stopped,
    // so neither does the run.
    expect(record?.status).toBe('running');
    expect(record?.error).toBeUndefined();
    expect(record?.steps.find((s) => s.id === 'implement')?.status).toBe('running');
    expect(events(id).join('\n')).toContain('cezar restarted — this run kept going');
    expect(events(id).join('\n')).not.toContain('interrupted — cezar process exited during the run');
  });

  it('falls through to the legacy path when the broker pid is DEAD', async () => {
    const id = runningRun();
    // pid 2 is the kernel's kthreadd on Linux and is never ours; what matters is that it is not a
    // broker we started. A pid we know to be gone is the common real case (the box rebooted).
    liveSpool(id, { pid: 999_999_999 });

    await manager.recover();

    const record = store.getRun(id);
    expect(record?.status).not.toBe('running');
    expect(events(id).join('\n')).not.toContain('this run kept going');
  });

  it('falls through when the broker recorded an EXIT — the agent finished while we were gone', async () => {
    const id = runningRun();
    const dir = liveSpool(id);
    writeSpoolExit(dir, { code: 0, signal: null, exitedAt: new Date().toISOString(), instanceId: 'test-instance' });

    await manager.recover();

    expect(store.getRun(id)?.status).not.toBe('running');
  });

  it('falls through on a PROTOCOL mismatch rather than tailing a spool it may misread', async () => {
    const id = runningRun();
    liveSpool(id, { protocol: BROKER_PROTOCOL + 1 });

    await manager.recover();

    expect(store.getRun(id)?.status).not.toBe('running');
  });

  it('falls through when the spool belongs to a DIFFERENT step than the chain would resume', async () => {
    const id = runningRun();
    // The spool says the live agent is on `run-tests`; the record says `implement` is the open
    // step. The two disagree about where this run is, and guessing between them is how a run ends
    // up with two live agents.
    liveSpool(id, { stepId: 'run-tests' });

    await manager.recover();

    expect(store.getRun(id)?.status).not.toBe('running');
  });

  it('falls through when there is no spool at all — every pre-P4 run', async () => {
    const id = runningRun();

    await manager.recover();

    expect(store.getRun(id)?.status).not.toBe('running');
    expect(events(id).join('\n')).not.toContain('this run kept going');
  });

  it('sweeps spools whose runs are over, and never a live one', async () => {
    const liveId = runningRun();
    const liveDir = liveSpool(liveId);
    const doneDir = spoolDirFor(join(dataDir, 'runs'), 'a-finished-run', 'done-instance');
    mkdirSync(doneDir, { recursive: true });
    // A finished run's spool always has its meta.json — only a broker mid-launch (still within
    // SPOOL_ORPHAN_GRACE_MS) lacks one, which is the race the sweep's grace period protects.
    writeSpoolMeta(doneDir, {
      schema: 1,
      protocol: BROKER_PROTOCOL,
      runId: 'a-finished-run',
      stepId: 'implement',
      backend: 'claude',
      pid: 999_999_999,
      argv: ['claude'],
      startedAt: new Date().toISOString(),
      instanceId: 'done-instance',
    });
    writeFileSync(join(doneDir, 'out.ndjson'), 'x\n');

    await manager.recover();

    const { existsSync } = await import('node:fs');
    expect(existsSync(doneDir)).toBe(false);
    expect(existsSync(liveDir)).toBe(true);
  });
});

/**
 * A second, independent way to miss the re-attach branch — `.ai/specs/2026-08-22-brokered-run-
 * survive-bluegreen-cutover.md` Phase 1. `RunStore.updateRun`/`updateStep` schedule a 300ms
 * DEBOUNCED, `.unref()`'d save; a process that exits before the timer fires loses that mutation
 * from `runs.json` even though the broker (outside this process entirely) has already moved on.
 * The next boot's `RunManager.recover()` then reads a STALE record — one whose `run.steps` no
 * longer names the step the live spool says is open — and, correctly, declines to guess: the
 * pid is genuinely alive, but the record and the spool disagree about *where* the run is, so
 * re-attaching would be exactly the "guess between them" `reattachBrokeredRun`'s own comment
 * warns against. That decline can land the run on either the legacy `interrupted`-and-failed
 * path or `reenterChain`'s `queued`-for-reentry path (both are "not re-attached"; which one
 * depends on how many chain steps remain) — this test asserts the shared, load-bearing half:
 * `recover()` does not re-attach at all while the on-disk record is stale, and does once the
 * mutation is flushed before the next `RunStore.open()` — the exact ordering
 * `contexts.disposeAll()` now guarantees at shutdown, before `store.flush()`, for every
 * non-boot project.
 */
describe('recover() re-attach across an unflushed run-record mutation (flush-on-shutdown gap, Phase 1)', () => {
  let repoRoot: string;
  let dataDir: string;

  const CHAIN = ['implement', 'run-tests'];
  const WORKFLOW = {
    name: 'two-step',
    description: 'x',
    source: 'built-in' as const,
    steps: CHAIN.map((id) => ({ id, name: id, prompt: '{{task}}' })),
  };

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-flush-gap-'));
    dataDir = join(repoRoot, '.ai/cezar');
    mkdirSync(join(dataDir, 'runs'), { recursive: true });
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /** The baseline every reader in this test agrees really made it to disk: mid-`implement`,
   *  flushed immediately — exactly `recover-brokered`'s own `runningRun()`, but on a store the
   *  test controls so it can choose whether the NEXT mutation gets flushed too. */
  function seedRunningRun(seedStore: RunStore): string {
    const { id } = seedStore.createRun({
      title: 't',
      workflow: 'two-step',
      task: 'do the thing',
      autonomous: true,
      steps: CHAIN.map((s) => ({ id: s, name: s, kind: 'agent' as const })),
    });
    seedStore.updateRun(id, { workflowDef: WORKFLOW, runner: 'claude' });
    seedStore.updateRun(id, { status: 'running', currentStepId: 'implement' });
    seedStore.updateStep(id, 'implement', {
      status: 'running',
      iterations: 1,
      sessionId: 'sess-implement-1',
      backend: 'claude',
    });
    seedStore.flush();
    return id;
  }

  /** The broker really did move to `run-tests` — this mutates the SAME in-memory `RunStore`, but
   *  deliberately does not flush it: the 300ms debounce is what a process exit before the timer
   *  fires loses, which is the gap this test exists to reproduce. */
  function advanceToRunTests(advanceStore: RunStore, id: string): void {
    advanceStore.updateStep(id, 'implement', { status: 'done', finishedAt: new Date().toISOString() });
    advanceStore.updateRun(id, { currentStepId: 'run-tests' });
    advanceStore.updateStep(id, 'run-tests', {
      status: 'running',
      iterations: 1,
      sessionId: 'sess-run-tests-1',
      backend: 'claude',
    });
  }

  /** A spool whose broker is this very process (`isPidAlive` true by construction), already on
   *  `run-tests` — matching the in-memory advance above, not whatever is (or isn't) on disk.
   *  Also records `spoolDir`/`consumedOffset` on the run, exactly as `brokerFor()` does before a
   *  real spawn (`run.ts:1749`) — this task's own criterion 3 requires both be present. */
  function liveSpoolForRunTests(spoolStore: RunStore, id: string): string {
    const dir = spoolDirFor(join(dataDir, 'runs'), id);
    mkdirSync(dir, { recursive: true });
    writeSpoolMeta(dir, {
      schema: 1,
      protocol: BROKER_PROTOCOL,
      runId: id,
      stepId: 'run-tests',
      backend: 'claude',
      pid: process.pid,
      argv: ['claude'],
      startedAt: new Date().toISOString(),
    });
    writeFileSync(join(dir, 'out.ndjson'), '');
    spoolStore.updateRun(id, { spoolDir: relative(dataDir, dir), consumedOffset: 42 });
    return dir;
  }

  const events = (readStore: RunStore, id: string): string[] =>
    readStore.readEvents(id).map((e) => (typeof e.message === 'string' ? e.message : e.type));

  it('does not re-attach when the advance never made it to disk before the next open', async () => {
    const store1 = RunStore.open(dataDir, { keepLive: true });
    const id = seedRunningRun(store1);
    advanceToRunTests(store1, id); // in-memory only — store1 never flushes again
    liveSpoolForRunTests(store1, id); // the broker really is alive and really is on `run-tests`

    // "next boot": a fresh RunStore reads only what actually reached `runs.json` — the flushed
    // baseline (`implement` still open), not the advance above.
    const store2 = RunStore.open(dataDir, { keepLive: true });
    const manager2 = new RunManager(store2, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 0 } }),
    });
    try {
      await manager2.recover();

      const record = store2.getRun(id);
      // The stale record still names `implement`; the live spool says `run-tests`. That
      // disagreement is real from this process's point of view — recover() cannot see the
      // in-memory advance store1 made — so it must not guess by re-attaching anyway.
      expect(record?.status).not.toBe('running');
      expect(events(store2, id).join('\n')).not.toContain('this run kept going');
    } finally {
      manager2.dispose();
      store2.flush();
      store1.flush();
    }
  });

  it('re-attaches once the advance is flushed before the next open — the fix', async () => {
    const store1 = RunStore.open(dataDir, { keepLive: true });
    const id = seedRunningRun(store1);
    advanceToRunTests(store1, id);
    liveSpoolForRunTests(store1, id);
    store1.flush(); // what `contexts.disposeAll()` now guarantees runs before `store.flush()`

    const store2 = RunStore.open(dataDir, { keepLive: true });
    const manager2 = new RunManager(store2, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 0 } }),
    });
    try {
      await manager2.recover();

      const record = store2.getRun(id);
      expect(record?.status).toBe('running');
      expect(record?.error).toBeUndefined();
      expect(record?.steps.find((s) => s.id === 'run-tests')?.status).toBe('running');
      expect(events(store2, id).join('\n')).toContain('cezar restarted — this run kept going');
    } finally {
      manager2.dispose();
      store2.flush();
    }
  });
});
