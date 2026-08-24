import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import {
  loadAgentAccountUsage,
  mergeWriteAgentAccountUsage,
  recordLimited,
  type AccountLimited,
} from '../workspace/agent-account-usage.ts';
import { WorkspaceSemaphore, type WorkspaceResourceLimits } from '../workspace/semaphore.ts';
import {
  AUTO_RESUME_GRACE_MS,
  AUTO_RESUME_MISSED_WINDOW_MS,
  MAX_AUTO_RESUMES,
  RunManager,
} from './run.ts';
import type { WorkflowDef } from './types.ts';
import { localCliAuthor } from '../runs/task-author.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * Auto-resume after a provider usage limit, end to end through the real engine
 * (spec 2026-08-03-auto-resume-after-usage-limit).
 *
 * The trigger is the bundled mock's `mock:limit` reply — the exact `is_error` result envelope
 * Claude Code emits when the subscription window is exhausted — so what is proven here is the
 * whole chain the feature actually depends on: the CLI's wire shape reaching the record's `error`,
 * the parse, the schedule, and the restart re-arm. Asserting on a hand-written record would prove
 * only the last two, and the first two are where this can silently stop working.
 *
 * The FIRE is exercised through `recover()` with an elapsed deadline rather than by waiting out a
 * real timer: same code path, no 30-second test.
 */
describe('a run stopped by a usage limit resumes itself', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;
  const savedEnv: Record<string, string | undefined> = {};

  const workflow: WorkflowDef = {
    name: 'quick-task',
    source: 'built-in',
    steps: [{ id: 'work', name: 'Work', prompt: '{{task}}' }],
  };

  /**
   * A manager configured the way THIS FILE's subject requires: the account hold on, and the
   * out-of-quota fallback OFF.
   *
   * ADDED 2026-08-23 by `.ai/specs/2026-08-23-never-block-a-task.md`, which flipped that fallback
   * to ON by default. Every test below is about the HOLD — a run parked because the account it
   * needs is out of quota — and on a default host the fallback now answers first, moving the run
   * to another login (in this sandbox, the discovered `codex:default`) so the hold is never
   * reached. 22 of these went red on the flip and every one of them was right about the hold.
   *
   * So this is not a workaround: the hold is a real mechanism that a host can still choose, and a
   * test of it has to configure the host that has it. The NEW default's behaviour in the same
   * scenario is pinned separately, at the bottom of this file, so neither contract is left
   * unasserted.
   */
  function heldManager(initial: Partial<WorkspaceResourceLimits> = {}): RunManager {
    return new RunManager(store, repoRoot, {
      semaphore: new WorkspaceSemaphore({
        initial: { fallbackAcrossAccountsWhenLimited: false, ...initial },
      }),
    });
  }

  /** Drive one real run to a terminal status. */
  async function settle(runId: string): Promise<void> {
    const terminal = new Set(['done', 'review', 'failed', 'cancelled']);
    const deadline = Date.now() + 20_000;
    while (!terminal.has(store.getRun(runId)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error('run did not finish in time');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  beforeEach(async () => {
    savedEnv.CEZ_DRY_RUN = process.env.CEZ_DRY_RUN;
    savedEnv.CEZ_MOCK_LIMIT_RESET_SECONDS = process.env.CEZ_MOCK_LIMIT_RESET_SECONDS;
    process.env.CEZ_DRY_RUN = '1';
    // Far enough out that the schedule is unambiguous and the timer never fires mid-test.
    process.env.CEZ_MOCK_LIMIT_RESET_SECONDS = '3600';
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-auto-resume-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
  });

  afterEach(() => {
    manager?.dispose();
    manager = undefined;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('schedules the resume for the provider\'s reset instant plus the grace', async () => {
    manager = heldManager();
    const record = manager.startRun(workflow, { author: localCliAuthor(), task: 'mock:limit ship it', worktree: false });
    await settle(record.id);

    const failed = store.getRun(record.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toContain('Claude AI usage limit reached|');
    // Read the reset instant back out of the message the provider actually sent, and require the
    // schedule to be exactly that plus the grace. Anchoring on the message rather than on
    // wall-clock windows is both the real contract and the only stable assertion — how long the
    // run itself took is a property of the machine, not of this feature.
    const epochSeconds = Number(/usage limit reached\|(\d+)/.exec(failed?.error ?? '')?.[1]);
    expect(Number.isFinite(epochSeconds)).toBe(true);
    expect(Date.parse(failed?.autoResumeAt ?? '')).toBe(epochSeconds * 1_000 + AUTO_RESUME_GRACE_MS);
    // The transcript says so too — the cockpit is not the only place this is auditable.
    const events = store.readEvents(record.id);
    expect(events.some((event) => String(event.message ?? '').includes('resuming automatically at'))).toBe(true);
  }, 30_000);

  it('leaves the run plainly failed when the setting is off', async () => {
    manager = new RunManager(store, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: { fallbackAcrossAccountsWhenLimited: false, autoResumeOnUsageLimit: false } }),
    });
    const record = manager.startRun(workflow, { author: localCliAuthor(), task: 'mock:limit ship it', worktree: false });
    await settle(record.id);

    expect(store.getRun(record.id)?.status).toBe('failed');
    expect(store.getRun(record.id)?.autoResumeAt).toBeUndefined();
  }, 30_000);

  it('schedules the next window when the resumed turn hits the limit again, and counts up', async () => {
    const first = heldManager();
    const record = first.startRun(workflow, { author: localCliAuthor(), task: 'mock:limit ship it', worktree: false });
    await settle(record.id);
    first.dispose();

    // The task text stays `mock:limit`, so the resumed turn walks straight back into a limit —
    // the pathological shape the cap exists for. It must schedule the NEXT window rather than
    // give up or spin.
    store.updateRun(record.id, { autoResumeAt: new Date(Date.now() - 1_000).toISOString() });
    manager = heldManager();
    await manager.recover();

    await expect
      .poll(() => store.getRun(record.id)?.autoResumeAttempts, { timeout: 20_000 })
      .toBe(1);
    await expect
      .poll(() => store.getRun(record.id)?.autoResumeAt, { timeout: 20_000 })
      .toBeDefined();
    expect(store.getRun(record.id)?.status).toBe('failed');
  }, 40_000);

  it('never leaves a deadline behind: a record with no armed timer heals on the next sweep', async () => {
    // The shape every "timer lost" case reduces to — a restart between the write and the arm, a
    // rebuilt project context, a manager disposed mid-wait. The record is the durable half, so
    // an elapsed deadline nobody is holding must not sit in the cockpit promising a resume.
    const first = heldManager();
    const record = first.startRun(workflow, { author: localCliAuthor(), task: 'mock:limit ship it', worktree: false });
    await settle(record.id);
    first.dispose(); // drops the timer, keeps the record

    store.updateRun(record.id, {
      autoResumeAt: new Date(Date.now() - 1_000).toISOString(),
      task: 'mock:done ship it',
    });
    // A manager that never runs `recover()` — the reconcile rides the ordinary pump.
    manager = heldManager();
    manager.startRun(workflow, { author: localCliAuthor(), task: 'mock:done unrelated', worktree: false });

    await expect
      .poll(
        () => store.getRun(record.id)?.steps.find((step) => step.id === 'continue-1')?.status,
        { timeout: 20_000 },
      )
      .toBe('done');
    expect(store.getRun(record.id)?.autoResumeAt).toBeUndefined();
  }, 40_000);

  it('retires the deadline when the resume is refused, instead of promising a past time', async () => {
    const first = heldManager();
    const record = first.startRun(workflow, { author: localCliAuthor(), task: 'mock:limit ship it', worktree: false });
    await settle(record.id);
    first.dispose();

    // A due deadline on a run with no session left to resume: the reconcile arms it from the
    // record, `continueRun` refuses with "no agent session to resume", and the promise has to go
    // — a hint counting down to an instant that has passed is worse than no hint.
    for (const step of store.getRun(record.id)?.steps ?? []) {
      store.updateStep(record.id, step.id, { sessionId: undefined });
    }
    store.updateRun(record.id, { autoResumeAt: new Date(Date.now() - 1_000).toISOString() });
    manager = heldManager();
    await manager.recover();

    await expect
      .poll(() => store.getRun(record.id)?.autoResumeAt, { timeout: 20_000 })
      .toBeUndefined();
  }, 40_000);

  it('holds the queue while the account is limited — the rest never start', async () => {
    // The reported scenario: five tasks, two slots. The two that start hit the limit and become
    // `scheduled`; the other three must not be walked into the same wall just to be marked
    // scheduled too. Before the hold existed this drained the whole queue in ~500 ms.
    manager = new RunManager(store, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: { fallbackAcrossAccountsWhenLimited: false, maxParallel: 2 } }),
    });
    // Isolated worktrees — the default, and the shape that matters here: an in-place run parks
    // on the repo-root lease (#438) instead of holding a slot, which is a different queue rule
    // altogether and would mask what this test is about.
    const runs = [1, 2, 3, 4, 5].map((n) =>
      manager!.startRun(workflow, { author: localCliAuthor(), task: `mock:limit task ${n}` }),
    );

    // Two schedules is the whole story: exactly the two that had slots ever ran.
    await expect
      .poll(
        () => runs.filter((r) => store.getRun(r.id)?.autoResumeAt !== undefined).length,
        { timeout: 20_000 },
      )
      .toBe(2);
    // Give a stampede every chance to happen before asserting it did not.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const started = runs.filter((r) => store.getRun(r.id)?.startedAt !== undefined);
    expect(started).toHaveLength(2);
    expect(runs.filter((r) => store.getRun(r.id)?.status === 'queued')).toHaveLength(3);

    // …and the hold is exactly as wide as the limit, with no restart and no timer needed:
    // cancelling both schedules releases the queue, the next pair takes their slots — and then
    // promptly holds it again by hitting the same limit, which is the mechanism working rather
    // than failing. One task never runs at all, which is the entire point.
    for (const run of started) manager.cancelAutoResume(run.id);
    await expect
      .poll(
        () => runs.filter((r) => store.getRun(r.id)?.startedAt !== undefined).length,
        { timeout: 20_000 },
      )
      .toBe(4);
    expect(runs.filter((r) => store.getRun(r.id)?.status === 'queued')).toHaveLength(1);
  }, 60_000);

  it('holds in-place runs too, which dequeue long before they spawn', async () => {
    // The reported case. A `worktree: false` run parks on the exclusive repo-root lease (#438),
    // and a run parked there holds no slot (#347) — so the queue advances behind it and the
    // dequeue-time gate is long past by the time it spawns. Measured before the spawn-time
    // check: four of five started. In-place runs serialize on that lease, so exactly ONE gets
    // as far as the limit and the rest never start.
    manager = new RunManager(store, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: { fallbackAcrossAccountsWhenLimited: false, maxParallel: 2 } }),
    });
    const runs = [1, 2, 3, 4, 5].map((n) =>
      manager!.startRun(workflow, { author: localCliAuthor(), task: `mock:limit inplace ${n}`, worktree: false }),
    );

    await expect
      .poll(
        () => runs.filter((r) => store.getRun(r.id)?.autoResumeAt !== undefined).length,
        { timeout: 20_000 },
      )
      .toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(runs.filter((r) => store.getRun(r.id)?.startedAt !== undefined)).toHaveLength(1);
    // Handed back untouched — plain `queued`, no half-started record left behind.
    expect(runs.filter((r) => store.getRun(r.id)?.status === 'queued')).toHaveLength(4);

    // …and every one of them SAYS why, once. A held run is otherwise indistinguishable from an
    // ordinary queued one — same status, same queue position, no movement for hours — which is
    // what read as a wedged workspace before this note existed. Many pumps ran in the second
    // above, so the count is also the dedupe assertion.
    for (const record of runs.filter((r) => store.getRun(r.id)?.status === 'queued')) {
      const notes = store
        .readEvents(record.id)
        .filter((event) => typeof event.message === 'string' && event.message.startsWith('held in the queue'));
      expect(notes).toHaveLength(1);
      expect(notes[0]?.message).toContain('claude:default');
      expect(notes[0]?.message).toContain('waiting out a usage limit until');
    }
  }, 60_000);

  it('holds the account the STEP was refused on, not the one the run record names', async () => {
    // The production shape (prod-host, 2026-08-23, run 76680e19): the run was created with
    // `runner: codex`, but `spec-to-deploy` pins `review-spec` to claude, so the step that hit the
    // weekly limit ran on claude. Keying the hold off the RUN put a Claude limit on `codex:default`
    // and left `claude:default` unheld — blocking an unrelated codex task for hours while a real
    // claude task would have walked straight into the closed window.
    manager = heldManager();
    const record = manager.startRun(workflow, { author: localCliAuthor(), task: 'mock:limit pinned step', worktree: false });
    await settle(record.id);
    const failed = store.getRun(record.id)?.steps.find((step) => step.status === 'failed');
    expect(failed?.backend).toBe('claude');
    expect(failed?.profileId ?? 'default').toBe('default');

    // Only the RUN-level fields move — exactly what a task started on codex whose pinned step ran
    // on claude leaves behind. The step record is untouched.
    store.updateRun(record.id, { runner: 'codex', agentProfile: 'default' });
    const holds = manager.accountHolds();
    expect([...holds.deadline]).toEqual(['claude:default']);
    expect([...holds.deadline]).not.toContain('codex:default');
  }, 30_000);

  it('does not ping-pong a run the queue admits and the spawn refuses', async () => {
    // The two gates ask about DIFFERENT accounts. `pump()` admits on the account the run RECORD
    // names; `execute()` refuses on the account the dispatch actually resolves — a pool route
    // picks the provider too, and a workflow step may pin its own runner. When they disagree the
    // run is dequeued, bounced back, admitted again… Measured on `prod-host` on 2026-08-23
    // at roughly eleven round trips a second: 2626 transcript notes in four minutes, on a task
    // that was simply waiting for a window to reopen.
    manager = heldManager();
    const limited = manager.startRun(workflow, { author: localCliAuthor(), task: 'mock:limit ship it', worktree: false });
    await settle(limited.id);
    expect([...manager.accountHolds().deadline]).toEqual(['claude:default']);

    // A second task whose RECORD says codex while its pending job still dispatches to claude —
    // the production shape, reproduced without needing a configured account pool. Admission reads
    // the record and lets it through; the spawn resolves claude and hands it straight back.
    const bounced = manager.startRun(workflow, { author: localCliAuthor(), task: 'mock:done ship it', worktree: false });
    store.updateRun(bounced.id, { runner: 'codex' });

    // A full second of real pump sweeps, including at least one watchdog-shaped forced sweep.
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    expect(store.getRun(bounced.id)?.status).toBe('queued');
    expect(store.getRun(bounced.id)?.startedAt).toBeUndefined();
    const notes = store
      .readEvents(bounced.id)
      .filter((event) => typeof event.message === 'string' && event.message.startsWith('held in the queue'));
    // ONE note is the whole assertion: it is also the bounce counter, because the spawn path
    // writes one every time it hands the run back.
    expect(notes).toHaveLength(1);
    expect(notes[0]?.message).toContain('claude:default');
  }, 40_000);

  it('keeps the account held while a resume is in flight, until a turn proves the window', async () => {
    manager = heldManager();
    const record = manager.startRun(workflow, { author: localCliAuthor(), task: 'mock:limit ship it', worktree: false });
    await settle(record.id);
    const account = `claude:default`;
    expect([...manager.accountHolds().deadline]).toContain(account);

    // The moment the resume fires, `autoResumeAt` is gone — and if the hold ended there, every
    // queued task would dequeue and walk to the lease on EVERY cycle. That churn is what the
    // in-flight clause exists to stop, so the hold has to survive this state.
    store.updateRun(record.id, {
      status: 'queued',
      autoResumeAt: undefined,
      autoResumeAttempts: 1,
    });
    // …now an IN-FLIGHT hold rather than a deadline one: it blocks fresh work, but not another
    // resume (see `accountHeldFor`).
    expect([...manager.accountHolds().inFlight]).toContain(account);
    store.updateRun(record.id, { status: 'running' });
    expect([...manager.accountHolds().inFlight]).toContain(account);

    // A completed turn is the only evidence the window reopened — that clears the counter and
    // the hold with it. (The engine does this at every turn end; done here as the state change.)
    store.updateRun(record.id, { status: 'waiting', autoResumeAttempts: undefined });
    const settled = manager.accountHolds();
    expect(settled.deadline.size + settled.inFlight.size).toBe(0);
  }, 30_000);

  it('lets two resumes on one account both run — they must not hold each other', async () => {
    // The deadlock this exists to prevent, seen live: two tasks hit the limit together, both
    // schedule, both fire — and if a resume in flight holds the account, each waits for the
    // other to prove a window neither will ever get to test. Everything in the workspace stops.
    const semaphore = new WorkspaceSemaphore({ initial: { fallbackAcrossAccountsWhenLimited: false, maxParallel: 2 } });
    const first = new RunManager(store, repoRoot, { semaphore });
    const runs = [1, 2].map((n) => first.startRun(workflow, { author: localCliAuthor(), task: `mock:limit pair ${n}` }));
    for (const run of runs) await settle(run.id);
    expect(runs.every((r) => store.getRun(r.id)?.autoResumeAt !== undefined)).toBe(true);
    first.dispose();

    // Both windows reopen together — the exact state the live deadlock started from. The task
    // text is swapped so the resumed turns can finish instead of re-limiting (that loop is
    // covered above); what is under test is whether they run AT ALL.
    for (const run of runs) {
      store.updateRun(run.id, {
        autoResumeAt: new Date(Date.now() - 1_000).toISOString(),
        task: 'mock:done pair',
      });
    }
    manager = new RunManager(store, repoRoot, { semaphore });
    await manager.recover();

    await expect
      .poll(
        () =>
          runs.filter((r) => store.getRun(r.id)?.steps.some((s) => s.id === 'continue-1' && s.status === 'done'))
            .length,
        { timeout: 25_000 },
      )
      .toBe(2);
  }, 60_000);

  it('watchdog: an idle queue with no appointment behind the hold starts work anyway', async () => {
    manager = new RunManager(store, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: { fallbackAcrossAccountsWhenLimited: false, maxParallel: 1 } }),
    });
    const limited = manager.startRun(workflow, { author: localCliAuthor(), task: 'mock:limit holder' });
    await settle(limited.id);
    const waiting = manager.startRun(workflow, { author: localCliAuthor(), task: 'mock:done work' });
    await expect.poll(() => store.getRun(waiting.id)?.status, { timeout: 10_000 }).toBe('queued');

    // While a real appointment is ahead, sitting still is CORRECT and the watchdog must not
    // touch it — otherwise the failsafe becomes the stampede.
    await manager.rescueStalledQueue();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(store.getRun(waiting.id)?.startedAt).toBeUndefined();

    // Now the wedge: the holder keeps holding but has no deadline anyone is waiting for, and
    // nothing is running. Whatever caused it, the queue must not be stuck there.
    store.updateRun(limited.id, {
      status: 'queued',
      autoResumeAt: undefined,
      autoResumeAttempts: 1,
    });
    expect(manager.accountHolds().inFlight.size).toBe(1);

    await manager.rescueStalledQueue();
    await expect
      .poll(() => store.getRun(waiting.id)?.startedAt, { timeout: 20_000 })
      .toBeDefined();
  }, 60_000);

  it('watchdog: one run it cannot re-adopt neither aborts the sweep nor rejects into the interval', async () => {
    // The watchdog is driven by `setInterval(() => this.rescueStalledQueue().catch(...))`. Before
    // that `.catch` existed the callback was `() => void this.rescueStalledQueue()`, and `void` on
    // a promise DISCARDS its rejection — which Node treats as an unhandled rejection and
    // terminates the process for. So one run whose record cannot be written (its project
    // directory deleted under us, a permissions change, a full disk) killed the whole cockpit,
    // and would kill it again on the very next tick. Found via the test suite under parallel
    // load, where a torn-down temp dir reproduces exactly that write failure.
    //
    // Two things are asserted together, and the second is what makes this non-vacuous:
    //   1. the sweep RESOLVES rather than rejecting, and
    //   2. the healthy run BEHIND the broken one is still re-adopted.
    // Mutation that must turn this red: move the try/catch from around the single
    // `reviveQueuedRun` call to around the whole `for` loop. The sweep still resolves, so (1)
    // stays green on its own — only (2) catches it.
    const unrecoverable = {
      title: 't',
      workflow: 'no-such-workflow',
      task: 'mock:done',
      steps: [],
      author: localCliAuthor(),
    };
    store.createRun(unrecoverable);
    store.createRun(unrecoverable);
    // Sabotage whichever the sweep reaches FIRST, in the store's own order, so the test does not
    // depend on `listRuns()` ordering. A directory sitting where the event log's file belongs
    // makes `appendEvent`'s `appendFileSync` throw EISDIR — a real write failure at the real call
    // site, not a stubbed rejection.
    const ids = store.listRuns().map((r) => r.id);
    expect(ids).toHaveLength(2);
    const [brokenId, healthyId] = ids as [string, string];
    mkdirSync(join(repoRoot, '.ai/cezar/runs', `${brokenId}.ndjson`), { recursive: true });

    manager = new RunManager(store, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: { fallbackAcrossAccountsWhenLimited: false, maxParallel: 1 } }),
    });

    await expect(manager.rescueStalledQueue()).resolves.toBeUndefined();

    // The broken one still got as far as the status write that precedes the failing append.
    expect(store.getRun(brokenId)?.status).toBe('failed');
    // …and the sweep carried on to the next run instead of dying on the first.
    expect(store.getRun(healthyId)?.status).toBe('failed');
    expect(
      store.readEvents(healthyId).some((e) => String(e.message ?? '').includes('queue watchdog')),
    ).toBe(true);
  }, 30_000);

  it('watchdog: an in-place run it forces through is not handed back at the repo-root gate', async () => {
    // The same wedge as above, but the rescued run is `worktree: false` — and that is the case
    // the spawn path asks the hold question TWICE for: once at the top of `execute`, and again
    // after the exclusive repo-root lease is granted. A force override consumed by the first gate
    // leaves the second one to hand the run straight back, `dropActive` releases the slot, an
    // ordinary pump starts nothing, and sixty seconds later the watchdog repeats the whole cycle
    // — the queue never unwedges and the transcript fills with identical held-in-the-queue notes.
    manager = new RunManager(store, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: { fallbackAcrossAccountsWhenLimited: false, maxParallel: 1 } }),
    });
    const limited = manager.startRun(workflow, { author: localCliAuthor(), task: 'mock:limit holder', worktree: false });
    await settle(limited.id);
    const waiting = manager.startRun(workflow, { author: localCliAuthor(), task: 'mock:done work', worktree: false });
    await expect.poll(() => store.getRun(waiting.id)?.status, { timeout: 10_000 }).toBe('queued');

    // Wedge it: the holder holds with no deadline anyone is waiting for, and nothing is running.
    store.updateRun(limited.id, {
      status: 'queued',
      autoResumeAt: undefined,
      autoResumeAttempts: 1,
    });
    expect(manager.accountHolds().inFlight.size).toBe(1);

    await manager.rescueStalledQueue();
    await expect.poll(() => store.getRun(waiting.id)?.startedAt, { timeout: 20_000 }).toBeDefined();
    // …and it STAYS started. A bounce at the second gate shows up as a return to `queued` with
    // `startedAt` cleared, which is exactly what the first assertion alone would miss.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(store.getRun(waiting.id)?.status).not.toBe('queued');
    expect(
      store
        .readEvents(waiting.id)
        .some((event) => String(event.message ?? '').includes('held in the queue')),
    ).toBe(false);
  }, 60_000);

  it('retires a deadline no timer is holding when the setting is off', async () => {
    // The population `reconcileAutoResumes` exists for — a record promising a resume that no
    // timer is holding — met by the setting being off: cezar restarted while it was off, the
    // config was hand-edited, or the project context was disposed mid-wait. Sweeping only the
    // armed timers leaves the deadline on the record, and a live `autoResumeAt` is not cosmetic:
    // `accountHolds()` reads it as a hold, so nothing new starts on that account, and the cockpit
    // shows a `scheduled` row for a resume that will never come.
    const first = heldManager();
    const record = first.startRun(workflow, { author: localCliAuthor(), task: 'mock:limit ship it', worktree: false });
    await settle(record.id);
    expect(store.getRun(record.id)?.autoResumeAt).toBeDefined();
    first.dispose(); // the timer is gone; the deadline is not

    manager = new RunManager(store, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: { fallbackAcrossAccountsWhenLimited: false, autoResumeOnUsageLimit: false } }),
    });
    await manager.recover();

    await expect
      .poll(() => store.getRun(record.id)?.autoResumeAt, { timeout: 5_000 })
      .toBeUndefined();
    expect(manager.accountHolds().deadline.size).toBe(0);
    expect(
      store
        .readEvents(record.id)
        .some((event) => String(event.message ?? '').includes('automatic resume cancelled')),
    ).toBe(true);
  }, 40_000);

  it('watchdog: re-adopts a queued record the engine has no work item for', async () => {
    // The worst shape a queue can be in — and the one a live workspace ended up in: every record
    // says `queued`, several with a pending `continue-N` step, and the engine holds nothing for
    // any of them. `pump()` iterates its own queue, so such a run is invisible to it and would
    // sit there for good: neither running, nor failed, nor ever going to happen.
    const first = heldManager();
    const record = first.startRun(workflow, { author: localCliAuthor(), task: 'mock:done orphan', worktree: false });
    await settle(record.id);
    first.dispose();
    // Back to `queued` with nobody holding the work item — exactly what the engine sees after
    // losing one, and what a restart would otherwise be the only cure for.
    store.updateRun(record.id, { status: 'queued', finishedAt: undefined, startedAt: undefined });

    manager = heldManager(); // deliberately NO recover()
    await manager.rescueStalledQueue();

    await expect
      .poll(() => store.getRun(record.id)?.status, { timeout: 20_000 })
      .not.toBe('queued');
  }, 60_000);

  it('a re-limited resume holds the other resumes back', async () => {
    // What the live workspace showed: several windows reopen together, every resume is let
    // through, and each one re-limits — four `scheduled` where two was the answer. The moment one
    // probe meets the limit again its DEADLINE hold binds everyone on that account, resumes
    // included; only an IN-FLIGHT hold (nothing proven yet) leaves other resumes alone.
    //
    // One slot, so "who got to spawn" is unambiguous. Two scheduled runs have to be built in
    // sequence, because the hold — correctly — stops the second from ever starting otherwise.
    const semaphore = new WorkspaceSemaphore({ initial: { fallbackAcrossAccountsWhenLimited: false, maxParallel: 1 } });
    const first = new RunManager(store, repoRoot, { semaphore });
    const a = first.startRun(workflow, { author: localCliAuthor(), task: 'mock:limit probe a' });
    await settle(a.id);
    first.cancelAutoResume(a.id); // release the hold so b can take its turn
    const b = first.startRun(workflow, { author: localCliAuthor(), task: 'mock:limit probe b' });
    await settle(b.id);
    first.dispose();

    const runs = [a, b];
    for (const run of runs) {
      store.updateRun(run.id, { autoResumeAt: new Date(Date.now() - 1_000).toISOString() });
    }
    manager = new RunManager(store, repoRoot, { semaphore });
    await manager.recover();

    // Exactly one probe spawns and meets the limit; the other's continuation never runs.
    const spawned = () =>
      runs.filter((r) =>
        store.getRun(r.id)?.steps.some((s) => s.id.startsWith('continue-') && s.status === 'failed'),
      ).length;
    await expect.poll(spawned, { timeout: 30_000 }).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(spawned()).toBe(1);
  }, 90_000);

  it('holds only the limited account — other accounts keep running', async () => {
    manager = new RunManager(store, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: { fallbackAcrossAccountsWhenLimited: false, maxParallel: 1 } }),
    });
    const limited = manager.startRun(workflow, { author: localCliAuthor(), task: 'mock:limit claude work', worktree: false });
    await settle(limited.id);
    expect(store.getRun(limited.id)?.autoResumeAt).toBeDefined();

    // A second login on the same backend is a second budget (spec 2026-07-29-agent-profiles), so
    // a limit on one must not stall the other. Same shape as a different backend entirely.
    const other = manager.startRun(workflow, { author: localCliAuthor(),
      task: 'mock:done other account',
      worktree: false,
      agentProfile: 'second',
    });
    await expect
      .poll(() => store.getRun(other.id)?.startedAt, { timeout: 20_000 })
      .toBeDefined();
  }, 60_000);

  it('never resumes a task the user resigned from — archived is archived', async () => {
    manager = heldManager();
    const resigned = manager.startRun(workflow, { author: localCliAuthor(), task: 'mock:limit ship it', worktree: false });
    await settle(resigned.id);
    expect(store.getRun(resigned.id)?.autoResumeAt).toBeDefined();

    // What the archive route does, and what `cancelAutoResume` guarantees on its own.
    expect(manager.cancelAutoResume(resigned.id)).toBe(true);
    store.setArchived(resigned.id, true);
    expect(store.getRun(resigned.id)?.autoResumeAt).toBeUndefined();

    // …and no later sweep may bring it back, however the deadline got there.
    store.updateRun(resigned.id, { autoResumeAt: new Date(Date.now() - 1_000).toISOString() });
    const second = heldManager();
    await second.recover();
    await expect
      .poll(() => store.getRun(resigned.id)?.autoResumeAt, { timeout: 10_000 })
      .toBeUndefined();
    expect(store.getRun(resigned.id)?.steps.some((step) => step.id === 'continue-1')).toBe(false);
    second.dispose();
  }, 40_000);

  it('lets a long-missed deadline expire instead of reviving a task from another era', async () => {
    const first = heldManager();
    const record = first.startRun(workflow, { author: localCliAuthor(), task: 'mock:limit ship it', worktree: false });
    await settle(record.id);
    first.dispose();

    // Overnight is the case the feature is for and still resumes (covered above); a deadline
    // this old is not that promise any more.
    store.updateRun(record.id, {
      autoResumeAt: new Date(Date.now() - AUTO_RESUME_MISSED_WINDOW_MS - 60_000).toISOString(),
    });
    manager = heldManager();
    await manager.recover();

    expect(store.getRun(record.id)?.autoResumeAt).toBeUndefined();
    expect(store.getRun(record.id)?.steps.some((step) => step.id === 'continue-1')).toBe(false);
    const events = store.readEvents(record.id);
    expect(events.some((event) => String(event.message ?? '').includes('automatic resume expired'))).toBe(true);
  }, 40_000);

  it('cancels one task without touching another that is waiting out the same window', async () => {
    manager = heldManager();
    const kept = manager.startRun(workflow, { author: localCliAuthor(), task: 'mock:limit keep this one', worktree: false });
    await settle(kept.id);
    // A second ACCOUNT, so the first one's hold does not park this run in the queue — the two
    // mechanisms are independent and this test is about the per-task cancel.
    const dropped = manager.startRun(workflow, { author: localCliAuthor(),
      task: 'mock:limit drop this one',
      worktree: false,
      agentProfile: 'second',
    });
    await settle(dropped.id);
    expect(store.getRun(kept.id)?.autoResumeAt).toBeDefined();
    expect(store.getRun(dropped.id)?.autoResumeAt).toBeDefined();

    manager.cancelAutoResume(dropped.id);

    expect(store.getRun(dropped.id)?.autoResumeAt).toBeUndefined();
    expect(store.getRun(kept.id)?.autoResumeAt).toBeDefined();
  }, 40_000);

  it('cancels an armed resume when the setting is switched off mid-wait', async () => {
    // The real seam: a config PUT refreshes the shared semaphore, which pumps every manager.
    let enabled = true;
    const semaphore = new WorkspaceSemaphore({
      initial: { fallbackAcrossAccountsWhenLimited: false, autoResumeOnUsageLimit: true },
      load: async () => ({ maxParallel: 2, memoryLimitMb: null, autoResumeOnUsageLimit: enabled }),
    });
    manager = new RunManager(store, repoRoot, { semaphore });
    const record = manager.startRun(workflow, { author: localCliAuthor(), task: 'mock:limit ship it', worktree: false });
    await settle(record.id);
    expect(store.getRun(record.id)?.autoResumeAt).toBeDefined();

    enabled = false;
    await semaphore.refresh();
    expect(semaphore.autoResumeOnUsageLimit()).toBe(false);

    // The deadline is gone from the record too — leaving it would keep the thread promising a
    // resume that will never come.
    await expect.poll(() => store.getRun(record.id)?.autoResumeAt, { timeout: 5_000 }).toBeUndefined();
    const events = store.readEvents(record.id);
    expect(events.some((event) => String(event.message ?? '').includes('automatic resume cancelled'))).toBe(true);
  }, 30_000);

  it('stops scheduling once the consecutive-resume cap is spent, and says why', async () => {
    manager = heldManager();
    const record = manager.startRun(workflow, { author: localCliAuthor(), task: 'mock:limit ship it', worktree: false });
    // Pre-load the counter so THIS failure is the one past the cap.
    store.updateRun(record.id, { autoResumeAttempts: MAX_AUTO_RESUMES });
    await settle(record.id);

    expect(store.getRun(record.id)?.autoResumeAt).toBeUndefined();
    const events = store.readEvents(record.id);
    expect(events.some((event) => String(event.message ?? '').includes('automatic resume cap reached'))).toBe(true);
  }, 30_000);

  it('re-arms across a restart and resumes the task from its last session', async () => {
    const first = heldManager();
    const record = first.startRun(workflow, { author: localCliAuthor(), task: 'mock:limit ship it', worktree: false });
    await settle(record.id);
    expect(store.getRun(record.id)?.autoResumeAt).toBeDefined();
    first.dispose();

    // cezar was down when the window reopened — the deadline is already in the past, which the
    // re-arm floors to "fire now". The task text is swapped because a continuation carries the
    // run's own task back into the prompt (`hydrateQueuedContinuation`), and the mock replies to
    // `mock:limit` wherever it appears — this test is about the resume completing, not looping
    // (which the case below covers).
    store.updateRun(record.id, {
      autoResumeAt: new Date(Date.now() - 1_000).toISOString(),
      task: 'mock:done ship it',
    });
    manager = heldManager();
    await manager.recover();

    // Not just "a continuation was enqueued": a deferred continuation sits at `queued` until
    // something pumps the manager, so the resume is only real once its step RUNS and settles.
    await expect
      .poll(
        () => store.getRun(record.id)?.steps.find((step) => step.id === 'continue-1')?.status,
        { timeout: 20_000 },
      )
      .toBe('done');
    expect(['done', 'review']).toContain(store.getRun(record.id)?.status);
    const events = store.readEvents(record.id);
    expect(events.some((event) => String(event.message ?? '').includes('resuming automatically (1/12)'))).toBe(true);
  }, 40_000);
});

/**
 * The limit is WRITTEN DOWN, so the account pool can route around it
 * (spec `2026-08-23-retarget-task-to-another-engine.md`, Phase 1).
 *
 * `selectPoolAccount` has ranked "skip a limited account" as signal 1 since the routing spec
 * landed on 2026-08-16, and `agent-route-select.test.ts` covers that ranking from three angles.
 * None of it ran in production: `recordLimited()` had no caller outside its own tests, so
 * `AccountUsageEntry.limited` was never written and `isLimited()` answered `false` for an account
 * a provider had just refused.
 *
 * **So the ranking tests are not the negative control for this change and cannot be** — the pure
 * function was never broken, and every one of them is green on both sides of this commit. What
 * these cases assert is the CALL: that the limit path reaches the store at all, under the right
 * key, and that a completed turn takes it back off.
 *
 * `CEZ_HOME` is pinned per test rather than leaning on the suite-wide sandbox in
 * `vitest.setup.ts`: that home is one directory per WORKER, so an entry written by one case would
 * still be there for the next, and "the pool skipped it" would be indistinguishable from "the
 * previous test left it behind".
 */
describe('a usage limit is recorded against the account it was refused on', () => {
  let repoRoot: string;
  let home: string;
  let store: RunStore;
  let manager: RunManager | undefined;
  const savedEnv: Record<string, string | undefined> = {};

  const workflow: WorkflowDef = {
    name: 'quick-task',
    source: 'built-in',
    steps: [{ id: 'work', name: 'Work', prompt: '{{task}}' }],
  };

  async function settle(runId: string): Promise<void> {
    const terminal = new Set(['done', 'review', 'failed', 'cancelled']);
    const deadline = Date.now() + 20_000;
    while (!terminal.has(store.getRun(runId)?.status ?? '')) {
      if (Date.now() > deadline) throw new Error('run did not finish in time');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /**
   * Same rule as the sibling describe's helper: these cases are about WRITING the limit, and the
   * out-of-quota fallback — ON by default since `2026-08-23-never-block-a-task.md` — would move
   * the run to `codex:default` before the claude limit was ever recorded. It is the mechanism
   * under test that decides the configuration, not the host default.
   */
  function heldManager(initial: Partial<WorkspaceResourceLimits> = {}): RunManager {
    return new RunManager(store, repoRoot, {
      semaphore: new WorkspaceSemaphore({
        initial: { fallbackAcrossAccountsWhenLimited: false, ...initial },
      }),
    });
  }

  /** The `limited` entry for a key, once the fire-and-forget write has landed. */
  async function limitedEntry(key: string): Promise<AccountLimited | undefined> {
    return (await loadAgentAccountUsage()).accounts[key]?.limited;
  }

  beforeEach(async () => {
    savedEnv.CEZ_DRY_RUN = process.env.CEZ_DRY_RUN;
    savedEnv.CEZ_MOCK_LIMIT_RESET_SECONDS = process.env.CEZ_MOCK_LIMIT_RESET_SECONDS;
    savedEnv.CEZ_HOME = process.env.CEZ_HOME;
    process.env.CEZ_DRY_RUN = '1';
    process.env.CEZ_MOCK_LIMIT_RESET_SECONDS = '3600';
    home = mkdtempSync(join(tmpdir(), 'cez-limit-home-'));
    process.env.CEZ_HOME = home;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-limit-record-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
  });

  afterEach(() => {
    manager?.dispose();
    manager = undefined;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('writes `limited` for the refused account, with the provider\'s own reset instant', async () => {
    manager = heldManager();
    const record = manager.startRun(workflow, { author: localCliAuthor(), task: 'mock:limit ship it', worktree: false });
    await settle(record.id);
    const failed = store.getRun(record.id);
    expect(failed?.status).toBe('failed');

    // The write is fire-and-forget (a JSON write must never delay the failure path), so poll.
    await expect.poll(() => limitedEntry('claude:default'), { timeout: 10_000 }).toBeDefined();
    const limited = await limitedEntry('claude:default');
    expect(limited?.source).toBe('usage-limit');
    // Not "some future date": the exact instant the provider stated, read back out of the message
    // it sent. `until` is what `isLimited` gates on, so a value that merely looks plausible is the
    // one failure this cannot afford — an hour's drift either way silently changes routing.
    const epochSeconds = Number(/usage limit reached\|(\d+)/.exec(failed?.error ?? '')?.[1]);
    expect(Number.isFinite(epochSeconds)).toBe(true);
    expect(Date.parse(limited?.until ?? '')).toBe(epochSeconds * 1_000);
  }, 30_000);

  it('keys it on the STEP that was refused, not on the run record', async () => {
    // The same split `accountHolds()` was fixed for on 2026-08-23, applied to the balancer. A run
    // created on codex whose step ran on claude must limit `claude:default`; keying it off the
    // record would exclude a healthy codex login from the pool AND leave the closed claude one
    // eligible — both halves wrong, from one wrong key.
    manager = heldManager();
    const record = manager.startRun(workflow, { author: localCliAuthor(), task: 'mock:limit pinned step', worktree: false });

    // Move only the RUN-level fields, and do it BEFORE the failure lands: this key is computed on
    // the failure path, so a record mutated afterwards would prove nothing about what was read.
    store.updateRun(record.id, { runner: 'codex', agentProfile: 'default' });
    await settle(record.id);
    expect(store.getRun(record.id)?.steps.find((step) => step.status === 'failed')?.backend).toBe('claude');

    await expect.poll(() => limitedEntry('claude:default'), { timeout: 10_000 }).toBeDefined();
    expect(await limitedEntry('codex:default')).toBeUndefined();
  }, 30_000);

  it('records it even when auto-resume is switched off', async () => {
    // The placement assertion, and the reason this case exists as its own test: whether THIS run
    // will resume itself and whether THAT account is exhausted are different questions. Every
    // early return in `scheduleAutoResumeIfLimited` below the record call answers only the first.
    // Move the call under any of them and this goes red while everything else here stays green.
    manager = new RunManager(store, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: { fallbackAcrossAccountsWhenLimited: false, maxParallel: 1, autoResumeOnUsageLimit: false } }),
    });
    const record = manager.startRun(workflow, { author: localCliAuthor(), task: 'mock:limit ship it', worktree: false });
    await settle(record.id);
    // The setting is genuinely off — no schedule was made, so this is not a vacuous pass.
    expect(store.getRun(record.id)?.autoResumeAt).toBeUndefined();
    await expect.poll(() => limitedEntry('claude:default'), { timeout: 10_000 }).toBeDefined();
  }, 30_000);

  it('clears it when a later turn on that account completes', async () => {
    manager = heldManager();
    const limited = manager.startRun(workflow, { author: localCliAuthor(), task: 'mock:limit ship it', worktree: false });
    await settle(limited.id);
    await expect.poll(() => limitedEntry('claude:default'), { timeout: 10_000 }).toBeDefined();

    // Retire the per-run HOLD first, or nothing can run on this account to prove anything — the
    // queue would park the second task behind the first run's `autoResumeAt` and `settle` would
    // time out. That is the hold working, and it is also the clearest statement of why these are
    // two mechanisms: the hold is one run's appointment and dies with it, while `limited` is a
    // fact about the LOGIN that outlives every run on it. Cancelling one must not clear the other.
    expect(manager.cancelAutoResume(limited.id)).toBe(true);
    expect(await limitedEntry('claude:default')).toBeDefined();

    // A turn that COMPLETED is the only honest proof the window reopened — `isLimited` would
    // otherwise keep skipping a working login until the stated reset arrived. This second run goes
    // through `finishStep`, the workflow-step seam, which is the path every ordinary agent step
    // takes and the one a continuation-only fix would miss.
    const ok = manager.startRun(workflow, { author: localCliAuthor(), task: 'mock:done back to work', worktree: false });
    await settle(ok.id);
    expect(store.getRun(ok.id)?.steps.find((step) => step.id === 'work')?.status).toBe('done');
    await expect.poll(() => limitedEntry('claude:default'), { timeout: 10_000 }).toBeUndefined();
  }, 60_000);
});

/**
 * The OTHER contract, on a DEFAULT host — the one the two describes above deliberately configure
 * away (`.ai/specs/2026-08-23-never-block-a-task.md`).
 *
 * Both of those pin `fallbackAcrossAccountsWhenLimited: false`, because the hold is the mechanism
 * they test and the fallback now answers first. That is legitimate, and it is also exactly how a
 * shipped default ends up with no coverage at all: every test opts out of it for a good local
 * reason and nobody asserts what a real host does. This describe is that assertion, driven by a
 * REAL `mock:limit` rather than a hand-written usage entry, so the whole chain is exercised —
 * the CLI's refusal, the `limited` write, and the next run routing around it.
 *
 * `CEZ_HOME` is pinned per test, for the reason the sibling describe gives: the suite-wide sandbox
 * is one directory per WORKER, so an entry left by another case would make "it routed around the
 * limit" indistinguishable from "the limit was already there".
 */
describe('on a default host, a limit routes the next task around it instead of parking it', () => {
  let repoRoot: string;
  let home: string;
  let store: RunStore;
  let manager: RunManager | undefined;
  const savedEnv: Record<string, string | undefined> = {};

  const workflow: WorkflowDef = {
    name: 'quick-task',
    source: 'built-in',
    steps: [{ id: 'work', name: 'Work', prompt: '{{task}}' }],
  };

  async function settle(runId: string): Promise<void> {
    const terminal = new Set(['done', 'review', 'failed', 'cancelled']);
    const deadline = Date.now() + 30_000;
    while (!terminal.has(store.getRun(runId)?.status ?? '')) {
      if (Date.now() > deadline) {
        // Name the run's actual state. "did not finish in time" is a fact about the WAIT; a parked
        // run and a slow one look identical from the outside and need opposite fixes.
        const r = store.getRun(runId);
        const ev = store.readEvents(runId).slice(-6).map((e) => `${e.type}:${String(e.message ?? '').slice(0, 90)}`);
        throw new Error(
          `run did not finish: status=${r?.status} runner=${r?.runner} ` +
            `steps=${JSON.stringify(r?.steps?.map((x) => [x.id, x.status, x.backend, x.profileId]))} events=${JSON.stringify(ev)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  beforeEach(async () => {
    savedEnv.CEZ_DRY_RUN = process.env.CEZ_DRY_RUN;
    savedEnv.CEZ_MOCK_LIMIT_RESET_SECONDS = process.env.CEZ_MOCK_LIMIT_RESET_SECONDS;
    savedEnv.CEZ_HOME = process.env.CEZ_HOME;
    process.env.CEZ_DRY_RUN = '1';
    process.env.CEZ_MOCK_LIMIT_RESET_SECONDS = '3600';
    home = mkdtempSync(join(tmpdir(), 'cez-neverblock-home-'));
    process.env.CEZ_HOME = home;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-neverblock-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
  });

  afterEach(() => {
    manager?.dispose();
    manager = undefined;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('starts the next task on another account, and says which, with NOTHING configured', async () => {
    // No semaphore argument at all — the point is what a host that has configured nothing does.
    manager = new RunManager(store, repoRoot);

    const limited = manager.startRun(workflow, {
      author: localCliAuthor(),
      task: 'mock:limit first',
      runner: 'claude',
      worktree: false,
    });
    await settle(limited.id);
    await expect
      .poll(() => loadAgentAccountUsage().then((u) => u.accounts['claude:default']?.limited), { timeout: 10_000 })
      .toBeDefined();

    const next = manager.startRun(workflow, {
      author: localCliAuthor(),
      task: 'mock:done second',
      runner: 'claude',
      worktree: false,
    });
    // Wait for the run to be DISPATCHED onto another provider, NOT for it to finish. What is under
    // test is where the work went, and that fact is complete the moment the step starts; waiting
    // for terminal status additionally waits out a codex turn, which is slow enough under a
    // full-suite run to time out on a run that had already done everything this test asserts.
    // Measured: `status=running runner=codex`, reroute note present, at 30 s. A timeout is a fact
    // about the WAIT, and it took a diagnostic that printed the run's real state to tell the two
    // apart — the same trap `step-runner-account.test.ts` documents.
    //
    // Under the OLD default this sat `queued` behind the first run's `autoResumeAt`, which is what
    // the hold describe above asserts — same fixture, opposite host.
    await expect.poll(() => store.getRun(next.id)?.runner, { timeout: 20_000 }).toBe('codex');
    await expect
      .poll(() => store.getRun(next.id)?.steps.find((x) => x.id === 'work')?.backend, { timeout: 20_000 })
      .toBe('codex');
    // Announced, always. A silent override of a provider the user named is the failure this whole
    // decision is a trade against, so the note is the mitigation and has to be asserted.
    const note = store
      .readEvents(next.id)
      .map((e) => String(e.message ?? ''))
      .find((m) => m.includes('out of quota, so this task starts on'));
    expect(note).toContain('claude:default');
    expect(note).toContain('codex:default');
  }, 60_000);

  it('still parks when there is nowhere else to go — never-blocked is not never-waits', async () => {
    // The control, and the part of the ladder that is easiest to get wrong. With EVERY candidate
    // limited there is no "next available provider", and the honest answer is the appointment the
    // hold already provides — a visible `autoResumeAt` at the provider's real reset, costing no
    // quota — not a burnt turn on a login that just refused.
    //
    // It also pins that the fix to the spawn gate was to give it the RESOLVED account, not to
    // switch it off: a version that simply skipped the hold whenever this setting is on reddens
    // this case, and reddened 22 others.
    manager = new RunManager(store, repoRoot);

    const first = manager.startRun(workflow, {
      author: localCliAuthor(), task: 'mock:limit claude', runner: 'claude', worktree: false,
    });
    await settle(first.id);
    // Wait for the claude limit to actually LAND before writing the codex one. `settle` waits for a
    // terminal STATUS; `scheduleAutoResumeIfLimited` writes the usage entry fire-and-forget, so the
    // two are not ordered. Both writes are read-modify-write on the same file, so a codex merge
    // that reads before the claude write lands silently drops it — measured, as
    // `['codex:default']` where both were expected.
    await expect
      .poll(() => loadAgentAccountUsage().then((u) => u.accounts['claude:default']?.limited), { timeout: 10_000 })
      .toBeDefined();
    // The claude side is REAL — `mock:limit` reproduces the CLI's own refusal envelope, so the
    // parse, the `limited` write and the hold are all exercised rather than assumed.
    //
    // The codex side is hand-written, and deliberately: the bundled codex mock answers
    // `mock:limit` with a revoked-refresh-token error, not a usage-limit envelope, so driving it
    // would assert a codex limit that was never recorded. Measured — the first version of this
    // test did exactly that and failed with `['claude:default']`. Writing the entry states what
    // the fixture needs (every candidate closed) without pretending to prove a parse that did not
    // happen.
    await mergeWriteAgentAccountUsage((usage) =>
      recordLimited(usage, 'codex:default', {
        source: 'usage-limit',
        until: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
    await expect
      .poll(() => loadAgentAccountUsage().then((u) => Object.keys(u.accounts).filter((k) => u.accounts[k]?.limited).sort()), { timeout: 10_000 })
      .toEqual(['claude:default', 'codex:default']);

    const parked = manager.startRun(workflow, {
      author: localCliAuthor(), task: 'mock:done nowhere to go', runner: 'claude', worktree: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(store.getRun(parked.id)?.status).toBe('queued');
    expect(store.getRun(parked.id)?.startedAt).toBeUndefined();
    // The queue must be QUIET, not merely stopped. `requeueWhileHeld` parks the run and the park
    // releases a slot, which pumps, which dequeues it again — a loop that looks identical to a
    // correctly parked run from the outside, and whose only symptom is the transcript. Measured
    // before the spawn memo was exempted from the admission bypass: **37 identical notes in these
    // same 1.5 seconds**, the shape of the 2626-note storm rolled back earlier the same day. One
    // note is the whole contract: say it once, then be silent.
    const held = store
      .readEvents(parked.id)
      .filter((e) => String(e.message ?? '').includes('held in the queue'));
    expect(held).toHaveLength(1);
  }, 60_000);
});
