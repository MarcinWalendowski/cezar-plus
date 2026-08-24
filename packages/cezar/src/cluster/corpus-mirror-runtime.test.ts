import type { StoredClusterNodeIdentity } from '@loki-labs/better-cezar-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CezarHubSourceProviderOptions } from '../sources/cezar-hub/provider.ts';
import type { SourceProvider } from '../sources/provider-types.ts';
import type { SourceStore } from '../sources/store.ts';
import type { SourceSyncResult } from '../sources/sync.ts';
import type { SourceConnection, SourceSink } from '../sources/types.ts';
import { startCorpusMirrorRuntime, type CorpusMirrorRuntimeDeps } from './corpus-mirror-runtime.ts';

/**
 * The keystone this package closes (spec `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, item
 * 56/D8a/S5, cadence item 57): a spoke that provisions a `cezar-hub` connection but never sweeps
 * it. Every test here injects `ensureConnection`, `runSync`, `openStore`, `createProvider` and
 * `createSink` — no test touches real fs, real network, or waits on real timers
 * (`vi.useFakeTimers()` throughout, `vi.advanceTimersByTimeAsync` to drive both the timer AND the
 * promise microtask chain a sweep pass is built from).
 */

function spokeIdentity(overrides: Partial<StoredClusterNodeIdentity> = {}): StoredClusterNodeIdentity {
  return {
    nodeId: 'node-1',
    nodeName: 'worker-1',
    createdAt: new Date(0).toISOString(),
    role: 'spoke',
    hubUrl: 'https://hub.example',
    secret: 'shh',
    acceptsDispatch: false,
    labels: [],
    ...overrides,
  };
}

function hubIdentity(overrides: Partial<StoredClusterNodeIdentity> = {}): StoredClusterNodeIdentity {
  return {
    nodeId: 'hub-1',
    nodeName: 'the-hub',
    createdAt: new Date(0).toISOString(),
    role: 'hub',
    acceptsDispatch: false,
    labels: [],
    ...overrides,
  };
}

const CONNECTION = {
  id: 'cezar-hub-corpus-mirror',
  kind: 'cezar-hub',
  name: 'cezar hub — corpus mirror',
  enabled: true,
  mode: 'mirror',
  intervalSeconds: 60,
  collections: [],
  watchComments: false,
  maxDocuments: 5_000,
  maxBodyBytes: 524_288,
  revision: 1,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
} as unknown as SourceConnection;

const SYNC_RESULT: SourceSyncResult = {
  ran: true,
  syncState: 'ok',
  documentCount: 0,
  conflictCount: 0,
  tombstoneCount: 0,
  complete: true,
};

function fakeStore(connection: SourceConnection = CONNECTION): SourceStore {
  return { get: (id: string) => (id === connection.id ? connection : undefined) } as unknown as SourceStore;
}

/** Every dep defaults to a fake that never touches fs/network. `runSync` and `ensureConnection`
 *  are the two the brief calls out by name; `openStore`/`createProvider`/`createSink` are faked
 *  too so nothing downstream of them can accidentally reach real disk either. */
function baseDeps(overrides: Partial<CorpusMirrorRuntimeDeps> = {}): CorpusMirrorRuntimeDeps {
  return {
    identity: spokeIdentity(),
    listProjects: () => ['/proj/.ai/cezar'],
    ensureConnection: vi.fn(() => ({ status: 'created' as const, connectionId: CONNECTION.id })),
    runSync: vi.fn(async () => SYNC_RESULT),
    openStore: vi.fn(() => fakeStore()),
    createProvider: vi.fn(() => ({}) as unknown as SourceProvider),
    createSink: vi.fn(() => ({}) as unknown as SourceSink),
    warn: () => {},
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startCorpusMirrorRuntime — interval sweep, the floor (item 57)', () => {
  it('fires exactly once at 60s — and zero at 59s (negative half)', async () => {
    const runSync = vi.fn(async () => SYNC_RESULT);
    const handle = startCorpusMirrorRuntime(baseDeps({ runSync })); // default intervalMs = 60_000

    await vi.advanceTimersByTimeAsync(59_000);
    expect(runSync).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000); // now at 60s total
    expect(runSync).toHaveBeenCalledTimes(1);

    handle.dispose();
  });

  it('keeps firing on every interval, not just once', async () => {
    const runSync = vi.fn(async () => SYNC_RESULT);
    const handle = startCorpusMirrorRuntime(baseDeps({ runSync, intervalMs: 1_000 }));

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runSync).toHaveBeenCalledTimes(3);

    handle.dispose();
  });

  it('does not sweep at all before start — no immediate sweep, only the armed interval', async () => {
    const runSync = vi.fn(async () => SYNC_RESULT);
    const handle = startCorpusMirrorRuntime(baseDeps({ runSync, intervalMs: 60_000 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(runSync).not.toHaveBeenCalled();
    handle.dispose();
  });
});

describe('startCorpusMirrorRuntime — the push trigger (corpus-changed hint)', () => {
  it('sweeps immediately on triggerSweep(), without waiting for the interval', async () => {
    const runSync = vi.fn(async () => SYNC_RESULT);
    const handle = startCorpusMirrorRuntime(baseDeps({ runSync, intervalMs: 60_000 }));

    // No `vi.advanceTimersByTimeAsync` call anywhere in this test — if this needed the interval to
    // elapse, `runSync` would still read 0 calls below.
    await handle.triggerSweep();

    expect(runSync).toHaveBeenCalledTimes(1);
    handle.dispose();
  });

  it('is safe to call on a refused (non-armed) handle — resolves, does nothing', async () => {
    const runSync = vi.fn(async () => SYNC_RESULT);
    const handle = startCorpusMirrorRuntime(baseDeps({ identity: hubIdentity(), runSync }));
    await expect(handle.triggerSweep()).resolves.toBeUndefined();
    expect(runSync).not.toHaveBeenCalled();
  });
});

describe('startCorpusMirrorRuntime — coalescing (constraint 4)', () => {
  it('5 rapid pushes during an in-flight sweep cost exactly ONE follow-up, never five, never zero', async () => {
    const deferred: Array<() => void> = [];
    const runSync = vi.fn(async () => {
      await new Promise<void>((resolve) => deferred.push(resolve));
      return SYNC_RESULT;
    });
    const handle = startCorpusMirrorRuntime(baseDeps({ runSync }));

    const first = handle.triggerSweep();
    await vi.advanceTimersByTimeAsync(0); // let sweep #1 start and reach its controlled await
    expect(runSync).toHaveBeenCalledTimes(1);

    // 4 more pushes arrive while sweep #1 is still in flight.
    const rest = [handle.triggerSweep(), handle.triggerSweep(), handle.triggerSweep(), handle.triggerSweep()];
    await vi.advanceTimersByTimeAsync(0);
    // Still exactly ONE pass in flight — a follow-up has been requested but not started (proves no
    // stacking): a design that started a new pass per push would read 5 here.
    expect(runSync).toHaveBeenCalledTimes(1);

    deferred[0]!(); // let sweep #1 finish
    await vi.advanceTimersByTimeAsync(0);
    // Exactly ONE follow-up pass started — proves the 4 coalesced pushes were not dropped (a design
    // that relied on `runSourceSync`'s lease alone, with no coalescing layer, would stay at 1 here).
    expect(runSync).toHaveBeenCalledTimes(2);
    expect(deferred).toHaveLength(2); // no THIRD pass was ever started, either

    deferred[1]!(); // let the follow-up finish
    await Promise.all([first, ...rest]);

    expect(runSync).toHaveBeenCalledTimes(2);
    handle.dispose();
  });

  it('an interval tick arriving mid-sweep also coalesces into one follow-up, not a stacked run', async () => {
    const deferred: Array<() => void> = [];
    const runSync = vi.fn(async () => {
      await new Promise<void>((resolve) => deferred.push(resolve));
      return SYNC_RESULT;
    });
    const handle = startCorpusMirrorRuntime(baseDeps({ runSync, intervalMs: 1_000 }));

    const push = handle.triggerSweep();
    await vi.advanceTimersByTimeAsync(0);
    expect(runSync).toHaveBeenCalledTimes(1);

    // The interval fires while the push-triggered sweep is still in flight.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runSync).toHaveBeenCalledTimes(1); // the tick coalesced, it did not start a second run

    deferred[0]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(runSync).toHaveBeenCalledTimes(2); // the coalesced tick's follow-up ran

    deferred[1]!();
    await push;
    handle.dispose();
  });
});

describe('startCorpusMirrorRuntime — a sweep failure never stops the timer (constraint 6)', () => {
  it('the next interval tick still fires after a rejected runSync', async () => {
    const warn = vi.fn();
    const runSync = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(SYNC_RESULT);
    const handle = startCorpusMirrorRuntime(baseDeps({ runSync, warn, intervalMs: 60_000 }));

    await vi.advanceTimersByTimeAsync(60_000);
    expect(runSync).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('boom'));

    await vi.advanceTimersByTimeAsync(60_000);
    expect(runSync).toHaveBeenCalledTimes(2); // the timer is still alive after the failure

    handle.dispose();
  });

  it('a thrown listProjects() also does not stop the timer', async () => {
    const warn = vi.fn();
    const runSync = vi.fn(async () => SYNC_RESULT);
    const listProjects = vi.fn().mockImplementationOnce(() => {
      throw new Error('registry unreadable');
    });
    listProjects.mockImplementation(() => ['/proj/.ai/cezar']);
    const handle = startCorpusMirrorRuntime(baseDeps({ runSync, warn, listProjects, intervalMs: 1_000 }));

    await vi.advanceTimersByTimeAsync(1_000);
    expect(runSync).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('registry unreadable'));

    await vi.advanceTimersByTimeAsync(1_000);
    expect(runSync).toHaveBeenCalledTimes(1); // second tick recovered

    handle.dispose();
  });
});

describe('startCorpusMirrorRuntime — spoke only (constraint 7)', () => {
  it('on a hub: no timer armed, no sweep ever runs, a named reason', async () => {
    const runSync = vi.fn(async () => SYNC_RESULT);
    const listProjects = vi.fn(() => ['/proj/.ai/cezar']);
    const handle = startCorpusMirrorRuntime(baseDeps({ identity: hubIdentity(), runSync, listProjects }));

    expect(handle.status).toBe('refused-hub-node');
    expect(handle.reason).toBeTruthy();

    await vi.advanceTimersByTimeAsync(10 * 60_000); // well past several intervals
    expect(runSync).not.toHaveBeenCalled();
    expect(listProjects).not.toHaveBeenCalled();

    handle.dispose(); // no-op, must not throw
  });

  it('refuses with no identity at all (never joined a cluster)', () => {
    const handle = startCorpusMirrorRuntime(baseDeps({ identity: undefined }));
    expect(handle.status).toBe('refused-no-identity');
    expect(handle.reason).toBeTruthy();
  });

  it('refuses when a spoke identity is missing hubUrl (corrupt/hand-edited)', () => {
    const identity = spokeIdentity();
    delete (identity as { hubUrl?: string }).hubUrl;
    const handle = startCorpusMirrorRuntime(baseDeps({ identity }));
    expect(handle.status).toBe('refused-no-hub-url');
    expect(handle.reason).toBeTruthy();
  });
});

describe('startCorpusMirrorRuntime — dispose()', () => {
  it('stops the timer: after disposal, advancing the clock triggers nothing', async () => {
    const runSync = vi.fn(async () => SYNC_RESULT);
    const handle = startCorpusMirrorRuntime(baseDeps({ runSync, intervalMs: 1_000 }));

    await vi.advanceTimersByTimeAsync(1_000);
    expect(runSync).toHaveBeenCalledTimes(1);

    handle.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runSync).toHaveBeenCalledTimes(1); // unchanged

    handle.dispose(); // idempotent, must not throw
  });

  it('a push after dispose() does nothing', async () => {
    const runSync = vi.fn(async () => SYNC_RESULT);
    const handle = startCorpusMirrorRuntime(baseDeps({ runSync }));
    handle.dispose();
    await handle.triggerSweep();
    expect(runSync).not.toHaveBeenCalled();
  });
});

describe('startCorpusMirrorRuntime — scope forwarding (S4)', () => {
  it('forwards the STORED connection scope to the constructed provider, not the default', async () => {
    const connection = { ...CONNECTION, scope: ['knowledge', 'domains'] } as SourceConnection;
    const createProvider = vi.fn((_connection: SourceConnection, _options: CezarHubSourceProviderOptions) => ({}) as unknown as SourceProvider);
    const handle = startCorpusMirrorRuntime(
      baseDeps({
        openStore: vi.fn(() => fakeStore(connection)),
        ensureConnection: vi.fn(() => ({ status: 'created' as const, connectionId: connection.id })),
        createProvider,
      }),
    );

    await handle.triggerSweep();

    expect(createProvider).toHaveBeenCalledTimes(1);
    const [, options] = createProvider.mock.calls[0]!;
    expect(options).toMatchObject({ scope: ['knowledge', 'domains'], hubUrl: 'https://hub.example', nodeId: 'node-1', secret: 'shh' });
    handle.dispose();
  });
});

describe('an empty project list is LOUD, not silent (item 64)', () => {
  it('warns, and sweeps nothing, when there are no projects to mirror', async () => {
    // The measured production failure: armed, on time, and mirroring nothing — with no log line
    // anywhere saying so, so `loadKnowledgeSummary` returned undefined and the agent ran
    // knowledge-blind while reporting success.
    const warn = vi.fn();
    const runSync = vi.fn(async () => SYNC_RESULT);
    const handle = startCorpusMirrorRuntime(baseDeps({ listProjects: () => [], runSync, warn, intervalMs: 1_000 }));

    await vi.advanceTimersByTimeAsync(1_000);

    expect(runSync).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('no projects to mirror');
    handle.dispose();
  });

  it('warns ONCE across many empty sweeps, not once per 60s tick forever', async () => {
    const warn = vi.fn();
    const handle = startCorpusMirrorRuntime(baseDeps({ listProjects: () => [], warn, intervalMs: 1_000 }));

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(warn).toHaveBeenCalledTimes(1);
    handle.dispose();
  });

  it('warns AGAIN if the list recovers and then goes empty a second time', async () => {
    // The negative half of the throttle: a boolean that latched on would silence a REAL later
    // regression (a project deregistered months after boot), which is the same silence this
    // guard exists to break.
    const warn = vi.fn();
    let projects: readonly string[] = [];
    const handle = startCorpusMirrorRuntime(baseDeps({ listProjects: () => projects, warn, intervalMs: 1_000 }));

    await vi.advanceTimersByTimeAsync(1_000);
    expect(warn).toHaveBeenCalledTimes(1);

    projects = ['/proj/.ai/cezar'];
    await vi.advanceTimersByTimeAsync(1_000);
    expect(warn).toHaveBeenCalledTimes(1); // recovered — nothing new to say

    projects = [];
    await vi.advanceTimersByTimeAsync(1_000);
    expect(warn).toHaveBeenCalledTimes(2); // regressed — said again
    handle.dispose();
  });

  it('a non-empty list never triggers the warning', async () => {
    const warn = vi.fn();
    const handle = startCorpusMirrorRuntime(baseDeps({ listProjects: () => ['/proj/.ai/cezar'], warn, intervalMs: 1_000 }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(warn).not.toHaveBeenCalled();
    handle.dispose();
  });
});
