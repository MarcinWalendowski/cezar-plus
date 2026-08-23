import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore, type WorkspaceResourceLimits } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';
import { localCliAuthor } from '../runs/task-author.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * Moving a QUEUED task to another engine (spec
 * `.ai/specs/2026-08-23-retarget-task-to-another-engine.md`, Phase 2).
 *
 * The assertion that matters throughout is **where the run actually STARTS**, not what the record
 * says. `execute()` resolves its backend from `input.runner`, never from the record, so a retarget
 * that updated only the record would leave every record-shaped assertion green while the task
 * dispatched to the old engine — the most expensive shape of wrong, because it looks like it
 * worked from every surface a person can see.
 *
 * Runs are parked with `maxParallel: 0` so they stay queued deterministically, without needing a
 * usage limit or a real hold to hold them there.
 */
describe('retargetQueuedRun', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager | undefined;
  const savedDryRun = process.env.CEZ_DRY_RUN;

  const workflow: WorkflowDef = {
    name: 'quick-task',
    source: 'built-in',
    steps: [{ id: 'work', name: 'Work', prompt: '{{task}}' }],
  };

  /**
   * A manager whose queue admits nothing until `release()` is awaited.
   *
   * The cap is served by an injected `load` stub rather than by `initial` alone, because
   * `refresh()` takes no arguments — it re-reads through `load`. Passing a limit to `refresh()`
   * type-checks as an ignored extra argument in plain JS and does nothing, so the release would
   * silently fall through to whatever the real workspace config says (2, by default) and the test
   * would pass for a reason it never stated.
   */
  function parked(): { manager: RunManager; release: () => Promise<void> } {
    let maxParallel = 0;
    const limits = (): WorkspaceResourceLimits => ({ maxParallel, memoryLimitMb: null });
    const semaphore = new WorkspaceSemaphore({ initial: limits(), load: async () => limits() });
    const made = new RunManager(store, repoRoot, { semaphore });
    return {
      manager: made,
      release: async () => {
        maxParallel = 4;
        await semaphore.refresh();
      },
    };
  }

  beforeEach(async () => {
    process.env.CEZ_DRY_RUN = '1';
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-retarget-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
  });

  afterEach(() => {
    manager?.dispose();
    manager = undefined;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  it('starts the run on the NEW engine, not merely relabels the record', async () => {
    const parkedManager = parked();
    manager = parkedManager.manager;
    const record = manager.startRun(workflow, {
      author: localCliAuthor(),
      task: 'mock:done ship it',
      runner: 'claude',
      worktree: false,
    });
    expect(store.getRun(record.id)?.status).toBe('queued');

    expect(await manager.retargetQueuedRun(record.id, { runner: 'codex' })).toEqual({ ok: true });
    expect(store.getRun(record.id)?.runner).toBe('codex');

    // The real assertion. Let the queue go and read the backend stamped on the STEP that ran —
    // that is written by the dispatch, from the pending input, and is the only thing here that
    // distinguishes a rewritten work item from a rewritten label.
    await parkedManager.release();
    await expect
      .poll(() => store.getRun(record.id)?.steps.find((step) => step.id === 'work')?.backend, { timeout: 20_000 })
      .toBe('codex');
  }, 40_000);

  it('drops the spawn memo, so the retarget is not delayed by a verdict about the old account', async () => {
    const parkedManager = parked();
    manager = parkedManager.manager;
    const record = manager.startRun(workflow, {
      author: localCliAuthor(),
      task: 'mock:done ship it',
      runner: 'claude',
      worktree: false,
    });
    // What `requeueWhileHeld` leaves behind when a spawn refuses a run: admission consults it and
    // keeps the run out of the queue. It names the OLD account, so a retarget that left it in
    // place would appear to do nothing until that account's hold expired.
    (manager as unknown as { heldAtSpawn: Map<string, string> }).heldAtSpawn.set(record.id, 'claude:default');
    (manager as unknown as { heldNotified: Map<string, string> }).heldNotified.set(record.id, 'claude:default');

    await manager.retargetQueuedRun(record.id, { runner: 'codex' });

    expect((manager as unknown as { heldAtSpawn: Map<string, string> }).heldAtSpawn.has(record.id)).toBe(false);
    expect((manager as unknown as { heldNotified: Map<string, string> }).heldNotified.has(record.id)).toBe(false);
  }, 30_000);

  /**
   * An EMPTY target is a real action, not a no-op. It is what the dock hint posts when a person
   * presses the button without touching a pill, and it means "keep the engine, but stop waiting":
   * the held memos go, the appointment goes, and the queue is pumped. Documented in the spec's API
   * Contracts, so it needs a test or the next refactor is free to make it a no-op.
   */
  it('re-admits a held task on an EMPTY target, keeping the engine it already had', async () => {
    const parkedManager = parked();
    manager = parkedManager.manager;
    const record = manager.startRun(workflow, {
      author: localCliAuthor(),
      task: 'mock:done ship it',
      runner: 'claude',
      worktree: false,
    });
    const memos = manager as unknown as { heldAtSpawn: Map<string, string>; heldNotified: Map<string, string> };
    memos.heldAtSpawn.set(record.id, 'claude:default');
    memos.heldNotified.set(record.id, 'claude:default');

    const result = await manager.retargetQueuedRun(record.id, {});

    expect(result.ok).toBe(true);
    expect(memos.heldAtSpawn.has(record.id)).toBe(false);
    expect(memos.heldNotified.has(record.id)).toBe(false);
    // The engine is untouched — an omitted field means "keep what the run has", never "reset".
    expect(store.getRun(record.id)?.runner).toBe('claude');
    expect(store.getRun(record.id)?.autoResumeAt).toBeUndefined();
  }, 30_000);

  it('refuses a run that is not queued, naming the status', async () => {
    manager = new RunManager(store, repoRoot);
    const record = manager.startRun(workflow, { author: localCliAuthor(), task: 'mock:done ship it', worktree: false });
    await expect.poll(() => store.getRun(record.id)?.status, { timeout: 20_000 }).toBe('done');
    const result = await manager.retargetQueuedRun(record.id, { runner: 'codex' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('done');
  }, 40_000);

  it('refuses an unknown run', async () => {
    manager = new RunManager(store, repoRoot);
    expect(await manager.retargetQueuedRun('nope', { runner: 'codex' })).toEqual({ ok: false, error: 'not found' });
  });

  it('refuses a queued record with no work item behind it', async () => {
    // The wedge `reviveQueuedRun` exists to repair. Retargeting it would write a new engine onto a
    // record that still has nothing to execute — a 200 that changes nothing.
    const parkedManager = parked();
    manager = parkedManager.manager;
    const record = manager.startRun(workflow, { author: localCliAuthor(), task: 'mock:done ship it', worktree: false });
    (manager as unknown as { pendingJobs: Map<string, unknown> }).pendingJobs.delete(record.id);
    const result = await manager.retargetQueuedRun(record.id, { runner: 'codex' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no queued work item');
  }, 30_000);

  it('rejects a model the target runner cannot serve', async () => {
    const parkedManager = parked();
    manager = parkedManager.manager;
    const record = manager.startRun(workflow, { author: localCliAuthor(), task: 'mock:done ship it', worktree: false });
    const result = await manager.retargetQueuedRun(record.id, { runner: 'codex', model: 'opus' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not a codex model');
    // And nothing moved — a refusal must not half-apply.
    expect(store.getRun(record.id)?.runner).not.toBe('codex');
  }, 30_000);

  it('clears an inherited pin the new runner cannot serve, rather than carrying it over', async () => {
    // The `2026-08-22-failed-turn-reads-as-done` rule: DROPPED, not substituted. Dropping falls
    // through to the new backend's own default, which does not rot; swapping in "the equivalent
    // id" trades today's wrong model for tomorrow's stale one.
    const parkedManager = parked();
    manager = parkedManager.manager;
    const record = manager.startRun(workflow, {
      author: localCliAuthor(),
      task: 'mock:done ship it',
      runner: 'claude',
      model: 'opus',
      worktree: false,
    });
    expect(store.getRun(record.id)?.model).toBe('opus');
    expect(await manager.retargetQueuedRun(record.id, { runner: 'codex' })).toEqual({ ok: true });
    expect(store.getRun(record.id)?.model).toBeUndefined();
  }, 30_000);

  it('keeps a model the caller did not mention when the runner does not change', async () => {
    const parkedManager = parked();
    manager = parkedManager.manager;
    const record = manager.startRun(workflow, {
      author: localCliAuthor(),
      task: 'mock:done ship it',
      runner: 'claude',
      model: 'opus',
      worktree: false,
    });
    expect(await manager.retargetQueuedRun(record.id, { agentProfile: 'second' })).toEqual({ ok: true });
    expect(store.getRun(record.id)?.model).toBe('opus');
    expect(store.getRun(record.id)?.agentProfile).toBe('second');
    expect(store.getRun(record.id)?.runner).toBe('claude');
  }, 30_000);

  it('carries the account into the rebuilt input a restart produces', async () => {
    // `reviveQueuedRun` rebuilds a queued run's executable half from the record after a restart.
    // It dropped `agentProfile` until 2026-08-23, so every retarget (and every explicit account
    // pick) was silently undone by the next restart while the record went on showing the choice.
    const first = parked();
    manager = first.manager;
    const record = manager.startRun(workflow, { author: localCliAuthor(), task: 'mock:done ship it', worktree: false });
    await manager.retargetQueuedRun(record.id, { runner: 'codex', agentProfile: 'second' });
    manager.dispose();

    const second = new RunManager(store, repoRoot, {
      semaphore: new WorkspaceSemaphore({
        initial: { maxParallel: 0, memoryLimitMb: null },
        load: async () => ({ maxParallel: 0, memoryLimitMb: null }),
      }),
    });
    manager = second;
    await second.recover();
    const job = (second as unknown as { pendingJobs: Map<string, { input: { runner?: string; agentProfile?: string } }> })
      .pendingJobs.get(record.id);
    expect(job?.input.runner).toBe('codex');
    expect(job?.input.agentProfile).toBe('second');
  }, 40_000);
});
