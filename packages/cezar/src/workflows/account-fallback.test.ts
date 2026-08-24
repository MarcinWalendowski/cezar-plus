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
 * CORRECTED 2026-08-23 the same day, by `2026-08-23-never-block-a-task.md`: this said "the
 * load-bearing case in this file is the **default-off** one". The default is now ON. What was
 * load-bearing about it survives the flip, and is why those two cases were inverted rather than
 * deleted — nobody writes this key, so what they assert is what every host actually does, in
 * whichever direction. The failure they guard against is still the invisible one: a default that
 * has quietly drifted from the schema's, the semaphore stub's, or the settings pane's looks
 * exactly like the feature working.
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

  // FLIPPED 2026-08-23 by `.ai/specs/2026-08-23-never-block-a-task.md`. These two read `false`
  // when the setting shipped that morning; the owner's ruling that afternoon — "task should never
  // be blocked ... always automatically proceed on next available provider & model" — made ON the
  // product default. They are kept rather than deleted because the DEFAULT is the whole behaviour
  // here: nobody sets this key, so whatever these assert is what every host does.
  it('is ON by default — an explicit account pick is a preference, not a requirement', () => {
    const plain = new RunManager(store, repoRoot);
    manager = plain;
    expect(
      (plain as unknown as { semaphore: WorkspaceSemaphore }).semaphore.fallbackAcrossAccountsWhenLimited(),
    ).toBe(true);
  });

  // The stub `load` path, which is a DIFFERENT default from the parsed config's: `resourcesSchema`
  // fills the key in, this constructor is handed a partial object that never had it. They must
  // agree, or the engine and the settings screen answer differently on the same host.
  it('reads absent as ON, so a config predating the key still never blocks a task', () => {
    const semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 2, memoryLimitMb: null } });
    expect(semaphore.fallbackAcrossAccountsWhenLimited()).toBe(true);
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

  it('a dangling agentProfile that names no stored account is checked against the DEFAULT login, not the phantom id', async () => {
    // No account named 'ghost-secondary' exists for claude in this fixture — `loadAgentAccounts()`
    // returns no stored accounts here, only each provider's discovered default (the file-level
    // `beforeEach` above already limits `claude:default`, which is the whole point: a task pinned to
    // 'ghost-secondary' resolves to `claude:default` downstream, `selectProfile`'s own fallback, so
    // the hold that matters is `claude:default`'s, not a key nothing was ever recorded under).
    manager = managerWith(true);
    const record = manager.startRun(workflow, {
      author: localCliAuthor(),
      task: 'mock:done ship it',
      runner: 'claude',
      agentProfile: 'ghost-secondary',
      worktree: false,
    });
    await expect
      .poll(
        () => store.readEvents(record.id).map((e) => String(e.message ?? '')).some((m) => m.includes('out of quota, so this task starts on')),
        { timeout: 15_000 },
      )
      .toBe(true);
    const note = store.readEvents(record.id).map((e) => String(e.message ?? '')).find((m) => m.includes('out of quota'));
    // Before the fix, `accountUsageKey('claude', 'ghost-secondary')` had no usage entry, read as
    // "not limited", and this returned before ever building a note — so this line is the actual
    // regression check, not just documentation.
    expect(note).toContain('claude:default');
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
    // only place allowed to resolve an account.
    //
    // CORRECTED 2026-08-23 (`2026-08-23-never-block-a-task.md`): this used to end "If dispatch
    // finds nowhere better the spawn gate parks it again, so admitting it costs at most one
    // dequeue." The spawn gate no longer parks under this setting — see the pair below, which is
    // the test that made the sentence false.
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

  /**
   * The SPAWN gate, which is where the fallback used to lose the run it had just saved.
   *
   * Admission (`heldAccountFor`) and this gate ask about DIFFERENT accounts on purpose, and this
   * one rebuilt its key from the run RECORD. `rerouteExplicitAccountIfLimited` stamps its choice
   * on the pending INPUT and deliberately leaves the record saying what the user asked for — so a
   * run just moved `claude:default` -> `codex:default` arrived here, was measured against
   * `claude:default`, and was parked on the very key it had moved off. Admission would then let it
   * straight back through, which is the bounce shape this file's sibling spec measured at eleven
   * round trips a second in production.
   *
   * The fix is that dispatch's resolved account is PASSED IN, so the gate measures where the work
   * is actually going. **Note what that makes these two cases: they no longer turn on the setting
   * at all.** The first version keyed them on `fallbackAcrossAccountsWhenLimited` and simply
   * skipped the gate when it was on — which reddened 23 tests in `auto-resume.test.ts`, correctly,
   * because it disabled the account hold outright on a default host. Never-blocked is not
   * never-waits: when nothing is open anywhere, an appointment is the honest answer.
   *
   * Called directly rather than through a live run because the two cases must differ in ONE thing.
   * Driving it through `startRun` would also vary which account the reroute picked, when the pump
   * swept, and whether a step had begun — and then "did not park" could be true for a reason that
   * has nothing to do with what is under test.
   */
  function holdClaudeDefault(): void {
    // What `accountHolds()` reads as a deadline hold: a `failed` run with a live `autoResumeAt`,
    // whose refused account resolves to `claude:default`. Created straight on the store so the
    // manager never pumps it — this record is scenery, not a run under test.
    const blocker = store.createRun({
      title: 'blocker',
      workflow: 'quick-task',
      task: 'mock:done blocked',
      runner: 'claude',
      worktree: false,
      steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
      author: localCliAuthor(),
    });
    store.updateRun(blocker.id, {
      status: 'failed',
      autoResumeAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
  }

  function spawnGate(
    mgr: RunManager,
    runId: string,
    resolved?: { provider: string; accountId: string },
  ): boolean {
    return (mgr as unknown as {
      requeueWhileHeld: (
        id: string,
        wf: WorkflowDef,
        input: unknown,
        runner: string,
        state?: unknown,
        resolved?: unknown,
      ) => boolean;
    }).requeueWhileHeld(
      runId,
      workflow,
      { author: localCliAuthor(), task: 'mock:done ship it', runner: 'claude', worktree: false },
      'claude',
      undefined,
      resolved,
    );
  }

  function runUnderTest(): string {
    const record = store.createRun({
      title: 'work',
      workflow: 'quick-task',
      task: 'mock:done ship it',
      runner: 'claude',
      worktree: false,
      steps: [{ id: 'work', name: 'Work', kind: 'agent' }],
      author: localCliAuthor(),
    });
    // `running` so that being parked is VISIBLE: `createRun` mints a record already `queued`, and
    // asserting "it is queued" on a record that was born queued would pass with the gate deleted.
    store.updateRun(record.id, { status: 'running' });
    return record.id;
  }

  it('does not park a run dispatch has already moved to an open account', () => {
    const on = managerWith(true);
    manager = on;
    holdClaudeDefault();
    const runId = runUnderTest();
    // `claude:default` is held; dispatch resolved `codex:default`, which is not. The record still
    // says claude — that is the point, and it is why the gate has to be TOLD.
    expect(spawnGate(on, runId, { provider: 'codex', accountId: 'default' })).toBe(false);
    expect(store.getRun(runId)?.status).toBe('running');
    expect(
      store.readEvents(runId).map((e) => String(e.message ?? '')).some((m) => m.includes('held')),
    ).toBe(false);
  }, 30_000);

  it('still parks when dispatch resolved nothing — the negative control for the gate above', () => {
    // Identical fixture, identical call, `resolved` omitted. Without this the test above passes
    // just as well against a hold that was never established, which is the more likely mistake:
    // `accountHolds()` reads a record shape, and a fixture that got the shape wrong holds nothing.
    // It also pins the half of the ladder that is easiest to lose — nowhere open means wait.
    const on = managerWith(true);
    manager = on;
    holdClaudeDefault();
    const runId = runUnderTest();
    expect(spawnGate(on, runId)).toBe(true);
    expect(store.getRun(runId)?.status).toBe('queued');
    expect(
      store.readEvents(runId).map((e) => String(e.message ?? '')).some((m) => m.includes('held')),
    ).toBe(true);
  }, 30_000);

  it('parks a run dispatch moved to an account that is ALSO held', () => {
    // The third case, and the one a "was `resolved` passed?" implementation gets wrong: being
    // rerouted is not itself a licence to start. The gate asks about the account, whichever way it
    // arrived. Here the reroute landed back on the held key, so the answer is still wait.
    const on = managerWith(true);
    manager = on;
    holdClaudeDefault();
    const runId = runUnderTest();
    expect(spawnGate(on, runId, { provider: 'claude', accountId: 'default' })).toBe(true);
    expect(store.getRun(runId)?.status).toBe('queued');
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

/**
 * The twin gap in the SAME feature, on the RESUME side (extends
 * `.ai/specs/2026-08-24-reroute-checks-dangling-account-key.md`). Everything above drives
 * `execute()` — a fresh dispatch — through `rerouteExplicitAccountIfLimited`. Nothing drove a
 * CONTINUATION through it: `runContinuation` resolved the account a resume is pinned to
 * (`resumedProfileId ?? run.agentProfile`) directly, with no hold check at all, so a manual
 * Continue and every unattended auto-resume (`fireAutoResume` calls `continueRun`, nothing else)
 * kept re-failing on the same held login forever, re-arming the next appointment days out on
 * repeat, while a second account of the same provider sat idle.
 *
 * A separate `describe` because the fixture needs the OPPOSITE initial condition from the one
 * above: the account has to be OPEN when the run starts (so a real session gets minted on it) and
 * only becomes held partway through — the sibling suite's shared `beforeEach` pre-limits
 * `claude:default` before anything runs, which would foreclose that.
 */
describe('out-of-quota fallback — a resume pinned to a now-held account', () => {
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
    savedEnv.CEZ_CODEX_BIN = process.env.CEZ_CODEX_BIN;
    process.env.CEZ_DRY_RUN = '1';
    // Codex doesn't gate on `CEZ_DRY_RUN` (only claude-cli-runner does) — it always shells out to
    // whatever `CEZ_CODEX_BIN` names, `codex` by default. The reroute here can land on codex, so
    // this suite needs its own mock too, same fixture `run.test.ts`'s codex tests use.
    process.env.CEZ_CODEX_BIN = join(import.meta.dirname, '../core/__fixtures__/codex/mock-codex-app-server.mjs');
    home = mkdtempSync(join(tmpdir(), 'cez-fallback-resume-home-'));
    process.env.CEZ_HOME = home;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-fallback-resume-'));
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

  it('a resume pinned to an account that went into a usage-limit hold starts fresh on an unlimited one, instead of re-failing on repeat', async () => {
    manager = managerWith(true);
    const record = manager.startRun(workflow, {
      author: localCliAuthor(),
      task: 'mock:limit',
      runner: 'claude',
      worktree: false,
    });
    // The mock's `mock:limit` turn fails with the same "usage limit reached|<epoch>" envelope the
    // real CLI emits — `scheduleAutoResumeIfLimited` reads that off `run.error` and records the
    // hold against the account the failed step actually ran on (`recordAccountLimit`), same as
    // production. Waiting for `autoResumeAt` specifically, not just `status`: a `failed` run with
    // no scheduled resume is a different state (an ordinary failure) this case is not about.
    await expect.poll(() => store.getRun(record.id)?.autoResumeAt, { timeout: 20_000 }).toBeDefined();
    const before = store.getRun(record.id);
    expect(before?.status).toBe('failed');
    const originalSessionId = before?.steps.find((s) => s.id === 'work')?.sessionId;
    expect(originalSessionId).toBeDefined();
    // `recordAccountLimit` writes through `mergeWriteAgentAccountUsage`, fire-and-forget — wait for
    // it to actually land, or the reroute below races its own precondition.
    await expect
      .poll(async () => (await loadAgentAccountUsage()).accounts['claude:default']?.limited?.until, { timeout: 10_000 })
      .toBeDefined();

    // The manual "Continue" button and the unattended auto-resume (`fireAutoResume`) both call
    // exactly this, with no account-aware path of their own — that pairing is the bug.
    const resumed = await manager.continueRun(record.id, { text: 'mock:done' });
    expect(resumed.ok).toBe(true);
    // `waiting`, not `done`: the codex mock (`__fixtures__/codex/mock-codex-app-server.mjs`) plays
    // one fixed scripted turn regardless of the prompt text — it has no `mock:done`-style scripting
    // like the claude mock — and a codex session parks at `waiting` after a turn the same way a
    // live one would. The fact under test is which ACCOUNT the continuation reached, not how that
    // fixture's turn ends, so this waits for the step to leave `pending`/`running` rather than for
    // a specific terminal status.
    await expect
      .poll(() => store.getRun(record.id)?.steps.find((s) => s.id.startsWith('continue-'))?.status, {
        timeout: 20_000,
      })
      .toMatch(/^(waiting|done|review)$/);

    const after = store.getRun(record.id);
    // Moved off the held login — and onto a different PROVIDER here, since claude:default was the
    // only claude candidate and codex:default is the only other one in this fixture (the same
    // cross-provider reach the fresh-dispatch suite's "moves the task" case exercises).
    expect(after?.runner).toBe('codex');
    expect(after?.agentProfile).toBe('default');
    const events = store.readEvents(record.id).map((e) => String(e.message ?? ''));
    expect(
      events.some((m) => m.includes('claude:default') && m.includes('out of quota') && m.includes('codex:default')),
    ).toBe(true);
    // Cannot have resumed the OLD session — it lives inside the held account's own config dir — so
    // the continuation step must carry a freshly minted id, not the original.
    const continueStep = after?.steps.find((s) => s.id.startsWith('continue-'));
    expect(continueStep?.sessionId).toBeDefined();
    expect(continueStep?.sessionId).not.toBe(originalSessionId);
  }, 45_000);

  it('a resume pinned to an account that is NOT held resumes it normally — unchanged by the fix', async () => {
    manager = managerWith(true);
    const record = manager.startRun(workflow, {
      author: localCliAuthor(),
      task: 'mock:done ship it',
      runner: 'claude',
      worktree: false,
    });
    await expect.poll(() => store.getRun(record.id)?.status, { timeout: 20_000 }).toBe('done');
    const resumed = await manager.continueRun(record.id, { text: 'mock:done keep going' });
    expect(resumed.ok).toBe(true);
    await expect.poll(() => store.getRun(record.id)?.status, { timeout: 20_000 }).toBe('done');
    const events = store.readEvents(record.id).map((e) => String(e.message ?? ''));
    expect(events.some((m) => m.includes('out of quota'))).toBe(false);
    expect(store.getRun(record.id)?.agentProfile).toBeUndefined();
    expect(store.getRun(record.id)?.runner).toBe('claude');
  }, 40_000);
});
