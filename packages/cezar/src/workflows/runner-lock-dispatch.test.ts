import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { LockableRunner } from '@loki-labs/better-cezar-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentAccountUsagePath } from '../paths.ts';
import { RunStore } from '../runs/store.ts';
import { localCliAuthor } from '../runs/task-author.ts';
import {
  accountUsageKey,
  defaultAgentAccountUsageStore,
  recordLimited,
} from '../workspace/agent-account-usage.ts';
import { WorkspaceSemaphore, type WorkspaceResourceLimits } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const exec = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const LIMIT_UNTIL = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

/**
 * The workspace provider lock, AT DISPATCH
 * (`.ai/specs/2026-08-29-global-provider-toggle.md`, D4/D5).
 *
 * This is the wiring suite, and it is the one that would have caught the production failure.
 * `runner-lock.test.ts` unit-tests `applyRunnerLock` in complete isolation — three cases, no
 * `RunManager`, no dispatch — and a pure function nothing calls passes every one of those, which
 * is exactly what shipped: the spec's own "Known implementation gap" section records the feature
 * landing green with the import present and the call absent.
 *
 * The measured failure, on `prod-host` 2026-08-30, run
 * `2ac77920-d5e5-4695-97da-70bba72c87a4`: the composer sent `requestedRunner: 'codex'`, the shell
 * bar's lock was `codex`, and the run executed every step on `claude:secondary` at
 * `anthropic/sonnet`. The mechanism was `pool:*` — the shipped per-provider default on that host —
 * which picks the PROVIDER as well as the login and therefore discarded both. That behaviour was
 * known: `step-runner-account.test.ts`'s fixture comment names it in as many words ("a wildcard
 * pool picks the PROVIDER as well as the login ... That is a real bug, but it is a different
 * one"), and left it standing.
 *
 * Every case here is a PAIR: the same fixture, run with and without the lock. Without that
 * control, "it ran on codex" proves nothing about the lock — the fixture could simply prefer
 * codex on its own.
 */
describe('the workspace provider lock at dispatch', () => {
  let repoRoot: string;
  let home: string;
  let store: RunStore;
  let manager: RunManager | undefined;
  const savedDryRun = process.env.CEZ_DRY_RUN;

  const quickTask: WorkflowDef = {
    name: 'quick-task',
    source: 'built-in',
    steps: [{ id: 'work', name: 'Work', prompt: '{{task}}' }],
  };

  /** A chain whose first step pins CLAUDE — the shape `spec-to-deploy` ships. */
  const pinnedChain: WorkflowDef = {
    name: 'pinned-chain',
    source: 'built-in',
    steps: [{ id: 'spec', name: 'Spec', prompt: '{{task}}', runner: 'claude' }],
  };

  /**
   * The production fixture, reproduced: `pool:*` is the stored default for BOTH providers, and
   * there is one extra claude login. That is `/var/lib/cezar/.cezar/agent-accounts.json` on
   * `prod-host` as of 2026-08-30.
   */
  function writeAccounts(defaults: Record<string, string> = { claude: 'pool:*', codex: 'pool:*' }): void {
    writeFileSync(
      join(home, 'agent-accounts.json'),
      JSON.stringify({
        version: 1,
        accounts: [
          { id: 'secondary', provider: 'claude', label: 'Secondary', configDir: join(home, 'claude-secondary') },
        ],
        selections: {},
        defaults,
      }),
      'utf8',
    );
  }

  function limitAccounts(...keys: string[]): void {
    const usage = defaultAgentAccountUsageStore();
    for (const key of keys) recordLimited(usage, key, { source: 'usage-limit', until: LIMIT_UNTIL() });
    writeFileSync(agentAccountUsagePath(), JSON.stringify(usage), 'utf8');
  }

  function managerWith(runnerLock?: LockableRunner, fallback = true): RunManager {
    const limits = (): WorkspaceResourceLimits => ({
      maxParallel: 2,
      memoryLimitMb: null,
      fallbackAcrossAccountsWhenLimited: fallback,
      ...(runnerLock ? { runnerLock } : {}),
    });
    return new RunManager(store, repoRoot, {
      semaphore: new WorkspaceSemaphore({ initial: limits(), load: async () => limits() }),
    });
  }

  const stepOf = (runId: string, id: string) => store.getRun(runId)?.steps.find((s) => s.id === id);
  const messages = (runId: string) => store.readEvents(runId).map((e) => String(e.message ?? ''));

  /** Wait for a step to be DISPATCHED, keyed on `profileId` — the later of the two stamps, so it
   *  is the safe barrier for `backend` too ("not there" would otherwise be "not arrived yet"). */
  async function dispatched(runId: string, stepId: string): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (stepOf(runId, stepId)?.profileId === undefined) {
      if (Date.now() > deadline) {
        const r = store.getRun(runId);
        throw new Error(
          `step ${stepId} never dispatched. status=${r?.status} ` +
            `steps=${JSON.stringify(r?.steps?.map((s) => [s.id, s.status, s.backend, s.profileId]))} ` +
            `events=${JSON.stringify(messages(runId).slice(-8))}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  beforeEach(async () => {
    process.env.CEZ_DRY_RUN = '1';
    home = mkdtempSync(join(tmpdir(), 'cez-lock-home-'));
    vi.stubEnv('CEZ_HOME', home);
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-lock-repo-'));
    await exec('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await exec('git', ['add', '-A'], { cwd: repoRoot });
    await exec('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
  });

  afterEach(() => {
    manager?.dispose();
    manager = undefined;
    vi.unstubAllEnvs();
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  // ---- the production case, both halves --------------------------------------------------------

  it('NEGATIVE CONTROL: with no lock, a `pool:*` default still discards an explicit codex pick', async () => {
    // This is the bug as measured, and it is asserted rather than fixed on purpose: D5 rules that
    // the lock NARROWS a pool, and explicitly "does not make `pool:*` mean something different"
    // unlocked (todo `81ab4ebd` decided that separately, in favour of the wildcard). If this case
    // ever starts answering `codex`, the pair below stops proving anything about the lock — it
    // would be passing because the fixture changed its mind.
    writeAccounts();
    manager = managerWith(undefined);
    const record = manager.startRun(quickTask, {
      author: localCliAuthor(),
      task: 'mock:done ship it',
      runner: 'codex',
      worktree: false,
    });
    await dispatched(record.id, 'work');
    expect(stepOf(record.id, 'work')?.backend).toBe('claude');
    expect(store.getRun(record.id)?.runner).toBe('claude');
  }, 40_000);

  it('with the lock set, the same fixture and the same request execute on the locked provider', async () => {
    writeAccounts();
    manager = managerWith('codex');
    const record = manager.startRun(quickTask, {
      author: localCliAuthor(),
      task: 'mock:done ship it',
      runner: 'codex',
      worktree: false,
    });
    await dispatched(record.id, 'work');
    expect(stepOf(record.id, 'work')?.backend).toBe('codex');
    expect(store.getRun(record.id)?.runner).toBe('codex');
  }, 40_000);

  // ---- rank 5: the composer's engine pill ------------------------------------------------------

  it('overrides the composer engine pill, and says so in the run', async () => {
    writeAccounts({ claude: 'default', codex: 'default' });
    manager = managerWith('codex');
    const record = manager.startRun(quickTask, {
      author: localCliAuthor(),
      task: 'mock:done ship it',
      runner: 'claude',
      worktree: false,
    });
    await dispatched(record.id, 'work');
    expect(store.getRun(record.id)?.runner).toBe('codex');
    // Overriding a choice the user made IN SILENCE is the failure the whole toggle is a decision
    // about, so the note is asserted, not the flag alone.
    expect(messages(record.id).some((m) => m.includes('this workspace is locked to codex'))).toBe(true);
    const metric = store
      .readEvents(record.id)
      .find((e) => (e as { name?: string }).name === 'run.runner_locked') as
      | { lockedRunner?: string; wouldHaveBeen?: string; actualRunner?: string }
      | undefined;
    expect(metric).toMatchObject({ lockedRunner: 'codex', wouldHaveBeen: 'claude', actualRunner: 'codex' });
  }, 40_000);

  it('CONTROL: with no lock the same pill is honoured', async () => {
    writeAccounts({ claude: 'default', codex: 'default' });
    manager = managerWith(undefined);
    const record = manager.startRun(quickTask, {
      author: localCliAuthor(),
      task: 'mock:done ship it',
      runner: 'claude',
      worktree: false,
    });
    await dispatched(record.id, 'work');
    expect(store.getRun(record.id)?.runner).toBe('claude');
    expect(messages(record.id).some((m) => m.includes('locked to'))).toBe(false);
  }, 40_000);

  // ---- rank 2: a workflow step's own pin -------------------------------------------------------

  it('overrides a workflow step pin — the whole `spec-to-deploy-codex` sibling with it', async () => {
    writeAccounts({ claude: 'default', codex: 'default' });
    manager = managerWith('codex');
    const record = manager.startRun(pinnedChain, {
      author: localCliAuthor(),
      task: 'mock:done ship it',
      runner: 'codex',
      worktree: false,
    });
    await dispatched(record.id, 'spec');
    expect(stepOf(record.id, 'spec')?.backend).toBe('codex');
  }, 40_000);

  it('CONTROL: with no lock the step pin still wins over the run', async () => {
    writeAccounts({ claude: 'default', codex: 'default' });
    manager = managerWith(undefined);
    const record = manager.startRun(pinnedChain, {
      author: localCliAuthor(),
      task: 'mock:done ship it',
      runner: 'codex',
      worktree: false,
    });
    await dispatched(record.id, 'spec');
    expect(stepOf(record.id, 'spec')?.backend).toBe('claude');
  }, 40_000);

  // ---- rank 0: availability outranks the lock (D3) ---------------------------------------------

  it('D3: every account of the locked provider being out of quota still moves the work, loudly', async () => {
    // `never-block-a-task` is UPHELD: nobody SET a quota exhaustion and it clears itself, so it is
    // not the kind of thing the lock beats. What changes is that the note names the LOCK as what
    // was overridden — under a lock every step is effectively pinned, so the unamended wording
    // would tell the user the STEP asked for something the WORKSPACE asked for.
    writeAccounts({ claude: 'default', codex: 'default' });
    limitAccounts(accountUsageKey('codex'));
    manager = managerWith('codex');
    const record = manager.startRun(quickTask, {
      author: localCliAuthor(),
      task: 'mock:done ship it',
      runner: 'codex',
      worktree: false,
    });
    await dispatched(record.id, 'work');
    expect(stepOf(record.id, 'work')?.backend).toBe('claude');
    // TWO notes are written here, by two different sites, and they are asserted SEPARATELY on
    // purpose: matching "locked to codex" alone passed with either one of them lock-aware, so one
    // assertion was silently covering two mechanisms and a mutation of either stayed green.
    //
    // The run-level reroute (`rerouteExplicitAccountIfUnavailable`, D4a) —
    const notes = messages(record.id);
    expect(
      notes.some(
        (m) => m.includes('this workspace is locked to codex') && m.includes('so this task starts on claude'),
      ),
    ).toBe(true);
    // — and the step-level downgrade (`downgradePinnedRunner`, D3), which fires because under a
    // lock EVERY agent step is effectively pinned to it.
    expect(
      notes.some(
        (m) =>
          m.includes('this workspace is locked to codex') &&
          m.includes('every codex account is out of quota'),
      ),
    ).toBe(true);
  }, 40_000);

  // ---- D6a: an account id is provider-scoped ---------------------------------------------------

  it('D6a: a lock that moves the provider drops the task account rather than carrying it across', async () => {
    // `secondary` is a CLAUDE login. Carried onto a codex-locked run it would satisfy
    // `agentEnvForStep`'s `backend === runRunner` guard, reach
    // `resolveProfileEnvForRoot(root, 'codex', 'secondary')`, resolve to nothing, and degrade to
    // codex's DEFAULT login with no pool ranking — the shape production already measured for a
    // dangling id, arrived at through the lock instead.
    writeAccounts({ claude: 'default', codex: 'default' });
    manager = managerWith('codex');
    const record = manager.startRun(quickTask, {
      author: localCliAuthor(),
      task: 'mock:done ship it',
      runner: 'claude',
      agentProfile: 'secondary',
      worktree: false,
    });
    await dispatched(record.id, 'work');
    expect(store.getRun(record.id)?.runner).toBe('codex');
    expect(store.getRun(record.id)?.agentProfile).not.toBe('secondary');
  }, 40_000);

  // ---- D3b item 3 / D3c: the gates above dispatch ----------------------------------------------

  it('D3b: admission stops holding a locked run on the account the RECORD names', () => {
    // The record's account is the PRE-LOCK routing decision, so a hold on it is a hold on a stale
    // decision — and this branch is reached only when `fallbackAcrossAccountsWhenLimited` is OFF,
    // which is why the control below shares its fixture exactly.
    writeAccounts({ claude: 'default', codex: 'default' });
    const locked = managerWith('codex', false);
    manager = locked;
    const record = locked.startRun(quickTask, { author: localCliAuthor(), task: 'mock:done x', worktree: false });
    const held = (locked as unknown as {
      heldAccountFor: (r: unknown, h: unknown, d: string) => string | undefined;
    }).heldAccountFor(
      store.getRun(record.id),
      { deadline: new Set(['claude:default']), inFlight: new Set<string>() },
      'claude',
    );
    expect(held).toBeUndefined();
  }, 30_000);

  it('CONTROL: with no lock and the fallback off, the same call still holds', () => {
    writeAccounts({ claude: 'default', codex: 'default' });
    const open = managerWith(undefined, false);
    manager = open;
    const record = open.startRun(quickTask, { author: localCliAuthor(), task: 'mock:done x', worktree: false });
    const held = (open as unknown as {
      heldAccountFor: (r: unknown, h: unknown, d: string) => string | undefined;
    }).heldAccountFor(
      store.getRun(record.id),
      { deadline: new Set(['claude:default']), inFlight: new Set<string>() },
      'claude',
    );
    expect(held).toBe('claude:default');
  }, 30_000);
});
