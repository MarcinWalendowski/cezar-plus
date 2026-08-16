import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RunManager } from '../workflows/run.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { accountUsageKey } from '../workspace/agent-account-usage.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';
import { resetAccountUsageRefreshForTests } from './agent-account-usage-routes.ts';

/**
 * Where the in-flight count comes from
 * (`.ai/specs/2026-08-16-agent-account-usage-routing.md`, Phase B/C).
 *
 * This file exists because the count shipped wrong TWICE, in two different ways, and both times it
 * read as a plain number that looked completely plausible:
 *
 * 1. **It enumerated the project-context map**, which structurally cannot contain the boot project —
 *    `resolveProjectScope` short-circuits both of its spellings — and the boot repo is where
 *    workspace runs live. Measured 0 through an entire real `running` step. `0` is also what
 *    "nothing is running" looks like, which is why 8367 green tests said nothing.
 * 2. **It derived from record status.** Stores open with `keepLive: true`, so a SIGKILLed cockpit's
 *    `running` steps come back from disk still saying `running`. Measured 1 after a crash, forever,
 *    for a run no process was executing — the balancer would route away from that login for good.
 *
 * Both fixes are structural rather than careful: the count is asked of the shared semaphore, which
 * every manager REGISTERS with (registration cannot forget a participant the way enumeration can),
 * and each manager answers from its in-memory `active` map (which a dead process cannot leave
 * behind). The tests below pin those two properties, not the arithmetic — `countInflight` already
 * has its own.
 */

describe('a manager counts what it is EXECUTING, not what its records say', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-inflight-active-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(() => {
    manager.dispose();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /** A crashed process's leftovers, exactly as `keepLive: true` hands them back: the run and its
   *  step both still claim `running`, and nothing is executing them. */
  function leaveCrashedRun(): void {
    const run = store.createRun({
      title: 't',
      workflow: 'quick-task',
      task: 't',
      steps: [{ id: 'task', name: 'Do the task', kind: 'agent' }],
    });
    store.updateRun(run.id, { status: 'running' });
    store.updateStep(run.id, 'task', { status: 'running', backend: 'claude', profileId: 'default' });
  }

  it('reports nothing for a `running` record it is not executing', () => {
    // THE test. Mutation: derive from `store.listRuns()` and this reads 1 — reproducing the phantom
    // measured after a real SIGKILL, which never clears because nothing will move that step again.
    leaveCrashedRun();
    expect(manager.accountInflight()).toEqual({});
  });

  it('reports nothing at all on a store with no runs', () => {
    // The negative control for the case above: {} there has to mean "not executing", not "this
    // method always answers {}".
    expect(manager.accountInflight()).toEqual({});
  });
});

describe('the semaphore aggregates every participant', () => {
  const participant = (counts: Record<string, number>) => ({
    busySlots: () => 0,
    pump: () => undefined,
    oldestQueuedAt: () => null,
    accountInflight: () => counts,
  });

  it('sums the same account across projects rather than unioning it', () => {
    // Two projects each running one task on one login is TWO runs on it. `accountHolds` unions
    // because a hold is a boolean fact about an account; this is a quantity, and the difference
    // decides whether the balancer sees a saturated login as busy or as merely occupied.
    const semaphore = new WorkspaceSemaphore();
    semaphore.register(participant({ [accountUsageKey('claude')]: 1 }));
    semaphore.register(participant({ [accountUsageKey('claude')]: 1 }));
    expect(semaphore.accountInflight()).toEqual({ [accountUsageKey('claude')]: 2 });
  });

  it('includes a participant that no project-context map would list', () => {
    // The boot manager's stand-in. It reaches the count by REGISTERING, which is the whole fix for
    // bug 1 — there is no list to leave it off.
    const semaphore = new WorkspaceSemaphore();
    semaphore.register(participant({ [accountUsageKey('codex')]: 3 }));
    expect(semaphore.accountInflight()).toEqual({ [accountUsageKey('codex')]: 3 });
  });

  it('ignores a participant that reports nothing, rather than throwing', () => {
    const semaphore = new WorkspaceSemaphore();
    semaphore.register({ busySlots: () => 0, pump: () => undefined, oldestQueuedAt: () => null });
    expect(semaphore.accountInflight()).toEqual({});
  });

  it('drops a participant that unregisters', () => {
    const semaphore = new WorkspaceSemaphore();
    const off = semaphore.register(participant({ [accountUsageKey('claude')]: 2 }));
    off();
    expect(semaphore.accountInflight()).toEqual({});
  });
});

describe('the route answers from the semaphore it was given', () => {
  let repoRoot: string;
  let store: RunStore;

  beforeEach(() => {
    resetAccountUsageRefreshForTests();
    vi.stubEnv('CEZ_ACCOUNT_USAGE', '1');
    vi.stubEnv('CEZ_REMOTE', '');
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-inflight-route-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const inflightOf = async (semaphore: WorkspaceSemaphore, accountId: string) => {
    const app = createApp({
      repoRoot,
      store,
      manager: {} as RunManager,
      version: '0.0.0-test',
      providerAuth: connectedProviderAuth(),
      semaphore,
      // Probes only — never the count. See `ServerDeps.accountUsageProbes`.
      accountUsageProbes: { probeQuota: async () => undefined, probeIdentity: async () => undefined },
    });
    const res = await apiRequest(app, '/api/v1/workspace/agent-accounts/usage');
    const body = (await res.json()) as { accounts: Array<{ id: string; inflight: number }> };
    return body.accounts.find((account) => account.id === accountId)?.inflight;
  };

  it('surfaces a registered participant\'s count on the matching row', async () => {
    // The wiring guard. Mutation: hand the route anything other than the semaphore — a store walk,
    // `{}` — and this reads 0, which is what both shipped bugs looked like.
    const semaphore = new WorkspaceSemaphore();
    semaphore.register({
      busySlots: () => 0,
      pump: () => undefined,
      oldestQueuedAt: () => null,
      accountInflight: () => ({ [accountUsageKey('claude')]: 2 }),
    });
    expect(await inflightOf(semaphore, 'default:claude')).toBe(2);
  });

  it('reads zero on the same row when nothing is registered', async () => {
    expect(await inflightOf(new WorkspaceSemaphore(), 'default:claude')).toBe(0);
  });

  it('does not attribute one provider\'s runs to another', async () => {
    const semaphore = new WorkspaceSemaphore();
    semaphore.register({
      busySlots: () => 0,
      pump: () => undefined,
      oldestQueuedAt: () => null,
      accountInflight: () => ({ [accountUsageKey('claude')]: 2 }),
    });
    expect(await inflightOf(semaphore, 'default:codex')).toBe(0);
  });
});
