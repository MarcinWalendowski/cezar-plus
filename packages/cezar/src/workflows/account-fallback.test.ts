import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore, type WorkspaceResourceLimits } from '../workspace/semaphore.ts';
import {
  mergeWriteAgentAccountUsage,
  recordLimited,
  loadAgentAccountUsage,
} from '../workspace/agent-account-usage.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';
import { localCliAuthor } from '../runs/task-author.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/**
 * Out-of-quota fallback (spec `2026-08-23-retarget-task-to-another-engine.md`, Phase 4) — when the
 * account a task NAMED is limited, start it somewhere else rather than waiting.
 *
 * The load-bearing case in this file is the **default-off** one. A setting that ships off is only
 * off if something asserts it, and the failure it guards against is invisible: overriding a
 * provider the user deliberately picked would look like the feature working.
 */
describe('out-of-quota fallback', () => {
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

  function managerWith(fallback: boolean): RunManager {
    const limits = (): WorkspaceResourceLimits => ({
      maxParallel: 2,
      memoryLimitMb: null,
      fallbackAcrossAccountsWhenLimited: fallback,
    });
    return new RunManager(store, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: limits(), load: async () => limits() }),
    });
  }

  beforeEach(async () => {
    savedEnv.CEZ_DRY_RUN = process.env.CEZ_DRY_RUN;
    savedEnv.CEZ_HOME = process.env.CEZ_HOME;
    process.env.CEZ_DRY_RUN = '1';
    home = mkdtempSync(join(tmpdir(), 'cez-fallback-home-'));
    process.env.CEZ_HOME = home;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-fallback-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    // The state this feature reacts to: the login the task will name is out of quota.
    await mergeWriteAgentAccountUsage((s) =>
      recordLimited(s, 'claude:default', { source: 'usage-limit', until: new Date(Date.now() + 3_600_000).toISOString() }),
    );
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

  it('is OFF by default — an explicit account pick is a requirement, not a preference', () => {
    const plain = new RunManager(store, repoRoot);
    manager = plain;
    expect(
      (plain as unknown as { semaphore: WorkspaceSemaphore }).semaphore.fallbackAcrossAccountsWhenLimited(),
    ).toBe(false);
  });

  it('reads absent as OFF, so a config predating the key does not start overriding picks', () => {
    const semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 2, memoryLimitMb: null } });
    expect(semaphore.fallbackAcrossAccountsWhenLimited()).toBe(false);
  });

  it('with it OFF, the run does not start — it waits for the account it was given', async () => {
    manager = managerWith(false);
    const record = manager.startRun(workflow, {
      author: localCliAuthor(),
      task: 'mock:done ship it',
      runner: 'claude',
      worktree: false,
    });
    // No hold exists here (no failed run with an autoResumeAt), so what keeps this queued is not
    // the usage-limit hold — it is that nothing reroutes it. The point of the case is the pairing
    // with the ON test below: same fixture, same limit, opposite outcome.
    // Wait for it to actually FINISH, not just for a quiet second. Asserting "it did not move" on
    // a run that never started would pass for the wrong reason — the limit alone does not stop a
    // run when the fallback is off (that is the HOLD, a different feature), so this run is
    // expected to complete, on the account it was given.
    await expect
      .poll(() => store.getRun(record.id)?.status, { timeout: 20_000 })
      .toMatch(/^(done|review|failed)$/);
    expect(store.getRun(record.id)?.runner).toBe('claude');
    expect(store.getRun(record.id)?.steps.find((s) => s.id === 'work')?.backend).toBe('claude');
    const events = store.readEvents(record.id).map((e) => String(e.message ?? ''));
    expect(events.some((m) => m.includes('out of quota, so this task starts on'))).toBe(false);
  }, 30_000);

  it('with it ON, moves the task to a login that is not limited, and says which', async () => {
    // The candidate set is `PROFILE_CAPABLE_PROVIDERS` — claude and codex — each contributing its
    // discovered default login. With `claude:default` limited, the only non-limited candidate is
    // `codex:default`, so the reroute crosses providers. That is the same reach `pool:*` already
    // has (`poolCandidates` on a provider-less route returns every provider's logins) and is
    // deliberately not narrowed here: two different answers to "which accounts are available"
    // would drift the moment either changed.
    manager = managerWith(true);
    const record = manager.startRun(workflow, {
      author: localCliAuthor(),
      task: 'mock:done ship it',
      runner: 'claude',
      worktree: false,
    });
    await expect
      .poll(
        () => store.readEvents(record.id).map((e) => String(e.message ?? '')).some((m) => m.includes('out of quota, so this task starts on')),
        { timeout: 15_000 },
      )
      .toBe(true);
    const note = store.readEvents(record.id).map((e) => String(e.message ?? '')).find((m) => m.includes('out of quota'));
    // Both accounts named: the one that could not take it and the one that did. A note that says
    // only "moved" leaves the reader unable to check the decision.
    expect(note).toContain('claude:default');
    expect(note).toContain('codex:default');
    await expect.poll(() => store.getRun(record.id)?.runner, { timeout: 15_000 }).toBe('codex');
  }, 40_000);

  it('with EVERY candidate limited, does not move it — a closed account is no better than waiting', async () => {
    // `selectPoolAccount` deliberately still answers when every candidate is limited (its docblock
    // explains why for the pool case). Reusing it without filtering first would therefore move the
    // run onto another closed login: a burnt turn, and the account the user chose lost for nothing.
    await mergeWriteAgentAccountUsage((s) =>
      recordLimited(s, 'codex:default', { source: 'usage-limit', until: new Date(Date.now() + 3_600_000).toISOString() }),
    );
    manager = managerWith(true);
    const record = manager.startRun(workflow, {
      author: localCliAuthor(),
      task: 'mock:done ship it',
      runner: 'claude',
      worktree: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const events = store.readEvents(record.id).map((e) => String(e.message ?? ''));
    expect(events.some((m) => m.includes('out of quota, so this task starts on'))).toBe(false);
    expect(store.getRun(record.id)?.runner).not.toBe('codex');
  }, 30_000);

  it('admission stops holding when the setting is on', () => {
    // The gate half. With the setting off a held account keeps a queued run out of the queue; with
    // it on, admission answers "nothing is holding this" so the run reaches dispatch, which is the
    // only place allowed to resolve an account. If dispatch finds nowhere better the spawn gate
    // parks it again, so admitting it costs at most one dequeue.
    const on = managerWith(true);
    manager = on;
    const record = on.startRun(workflow, { author: localCliAuthor(), task: 'mock:done ship it', worktree: false });
    const held = (on as unknown as {
      heldAccountFor: (r: unknown, h: unknown, d: string) => string | undefined;
    }).heldAccountFor(
      store.getRun(record.id),
      { deadline: new Set(['claude:default']), inFlight: new Set<string>() },
      'claude',
    );
    expect(held).toBeUndefined();
  }, 30_000);

  it('with it OFF, admission still holds — the same call, the opposite answer', () => {
    const off = managerWith(false);
    manager = off;
    const record = off.startRun(workflow, { author: localCliAuthor(), task: 'mock:done ship it', worktree: false });
    const held = (off as unknown as {
      heldAccountFor: (r: unknown, h: unknown, d: string) => string | undefined;
    }).heldAccountFor(
      store.getRun(record.id),
      { deadline: new Set(['claude:default']), inFlight: new Set<string>() },
      'claude',
    );
    expect(held).toBe('claude:default');
  }, 30_000);

  it('leaves the usage store alone when it does not reroute', async () => {
    manager = managerWith(true);
    const before = (await loadAgentAccountUsage()).accounts['claude:default']?.dispatch?.count ?? 0;
    const record = manager.startRun(workflow, { author: localCliAuthor(), task: 'mock:done ship it', worktree: false });
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(store.getRun(record.id)).toBeDefined();
    // No reroute happened, so no dispatch was recorded BY the reroute path. (The ordinary pool
    // path does not fire here either: this run names an explicit account, not a pool.)
    expect((await loadAgentAccountUsage()).accounts['claude:default']?.dispatch?.count ?? 0).toBe(before);
  }, 30_000);
});
