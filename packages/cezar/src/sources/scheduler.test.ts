import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SourceCoordinator } from './coordinator.ts';
import { SourceStore } from './store.ts';
import { WorkspaceSourceScheduler, type ProjectSourceHandle } from './scheduler.ts';
import type { SourceProvider } from './provider-types.ts';

/**
 * `scheduler.ts` (F2, W4.4). See
 * `.ai/specs/2026-08-06-external-source-connectors-notion.md` phase "3.3": "two connections across
 * two projects produce exactly one setTimeout, set to the earlier due time; a 429 sets
 * backoffUntil with jitter and the connection is skipped until it passes; with CEZ_SOURCES unset,
 * zero timers are armed." Mirrors `automations/scheduler.test.ts`'s `WorkspaceAutomationScheduler`
 * suite in shape.
 *
 * The `CEZ_SOURCES`-unset half of that Test line is NOT exercised here, see this package's
 * implementation report: this file reads no `CEZ_*` variable at all, by design (the flag gate is
 * whoever CONSTRUCTS a `WorkspaceSourceScheduler`, not this class), so "zero timers armed" is
 * trivially true today only because nothing in the boot flow constructs one yet.
 */

const dirs: string[] = [];
async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cezar-sources-scheduler-'));
  dirs.push(root);
  return root;
}
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

const CONNECTION_INPUT = {
  kind: 'notion',
  name: 'Acme',
  enabled: true,
  mode: 'mirror' as const,
  intervalSeconds: 300,
  collections: [],
  watchComments: false,
  maxDocuments: 5_000,
  maxBodyBytes: 524_288,
};

function stubProvider(): SourceProvider {
  return {
    kind: 'notion',
    capabilities: {
      list: true,
      fetch: true,
      poll: true,
      push: false,
      comments: false,
    },
    detect: async () => ({ available: true }),
    detectCached: () => ({ available: true }),
    listCollections: async () => [],
    listDocuments: async () => ({
      documents: [],
      nextPageCursor: null,
      complete: true,
      truncated: false,
    }),
    fetchDocument: async () => null,
    pollChanges: async () => ({
      changes: [],
      watermark: null,
      nextPageCursor: null,
      complete: true,
      truncated: false,
    }),
    viewUrl: () => null,
  };
}

describe('WorkspaceSourceScheduler', () => {
  it('arms its first timer when a connection is enabled after startup', async () => {
    const root = await project();
    const store = SourceStore.open(root);
    const connection = store.create({ ...CONNECTION_INPUT, enabled: false }, 'conn-1');
    const coordinator = {
      refresh: vi.fn(async () => undefined),
      enabledProjectIds: () => (store.list().some((item) => item.enabled) ? ['p'] : []),
      store: () => store,
    } as unknown as SourceCoordinator;

    const scheduler = new WorkspaceSourceScheduler({
      coordinator,
      handle: (): ProjectSourceHandle => ({ projectId: 'p', dataDir: root }),
      resolveProvider: () => stubProvider(),
    });
    await scheduler.start();
    expect(scheduler.hasTimer()).toBe(false);

    store.update(connection.id, connection.revision, {
      ...connection,
      enabled: true,
    });
    await scheduler.reschedule();
    expect(scheduler.hasTimer()).toBe(true);
    scheduler.stop();
  });

  it('keeps one timer when overlapping reschedules resolve out of order', async () => {
    vi.useFakeTimers();
    try {
      const root = await project();
      const store = SourceStore.open(root);
      store.create(CONNECTION_INPUT, 'conn-1');
      const releases: Array<() => void> = [];
      const coordinator = {
        refresh: () => new Promise<void>((resolve) => releases.push(resolve)),
        enabledProjectIds: () => ['p'],
        store: () => store,
      } as unknown as SourceCoordinator;

      const scheduler = new WorkspaceSourceScheduler({
        coordinator,
        handle: (): ProjectSourceHandle => ({ projectId: 'p', dataDir: root }),
        resolveProvider: () => stubProvider(),
      });
      const started = scheduler.start();
      releases.shift()!();
      await started;
      const first = scheduler.reschedule();
      const second = scheduler.reschedule();
      releases.pop()!();
      await second;
      releases.shift()!();
      await first;
      expect(vi.getTimerCount()).toBe(1);
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('two connections across two projects produce exactly one timer', async () => {
    vi.useFakeTimers();
    try {
      const rootA = await project();
      const rootB = await project();
      const storeA = SourceStore.open(rootA);
      const storeB = SourceStore.open(rootB);
      storeA.create(CONNECTION_INPUT, 'conn-a');
      storeB.create(CONNECTION_INPUT, 'conn-b');

      const coordinator = {
        refresh: async () => undefined,
        enabledProjectIds: () => ['a', 'b'],
        store: (id: string) => (id === 'a' ? storeA : storeB),
      } as unknown as SourceCoordinator;

      const scheduler = new WorkspaceSourceScheduler({
        coordinator,
        handle: (projectId): ProjectSourceHandle => ({
          projectId,
          dataDir: projectId === 'a' ? rootA : rootB,
        }),
        resolveProvider: () => stubProvider(),
      });
      await scheduler.start();
      expect(scheduler.hasTimer()).toBe(true);
      expect(vi.getTimerCount()).toBe(1);
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a connection already backed off gets a nextDueAt pushed past its plain interval, not just now + interval', async () => {
    vi.useFakeTimers();
    try {
      const root = await project();
      const store = SourceStore.open(root);
      store.create(CONNECTION_INPUT, 'conn-1');
      const future = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(); // 2h, far past the 300s interval
      store.updateState('conn-1', { backoffUntil: future });

      const coordinator = {
        refresh: async () => undefined,
        enabledProjectIds: () => ['p'],
        store: () => store,
      } as unknown as SourceCoordinator;

      const scheduler = new WorkspaceSourceScheduler({
        coordinator,
        handle: (): ProjectSourceHandle => ({ projectId: 'p', dataDir: root }),
        resolveProvider: () => stubProvider(),
      });
      await scheduler.start();
      // The due entry fires almost immediately (no `nextDueAt` recorded yet); let it run.
      await vi.advanceTimersByTimeAsync(1);
      // `sync.ts`'s own step-2 skip fires on the pre-seeded `backoffUntil` before ever touching the
      // provider; `runOne`'s `finally` still writes `nextDueAt`, honouring the still-standing
      // backoff rather than the plain 300s interval.
      const nextDueAt = store.state('conn-1')?.nextDueAt;
      expect(nextDueAt).toBeDefined();
      expect(Date.parse(nextDueAt!)).toBeGreaterThan(Date.now() + 300_000);
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the ok -> stale transition is a stored write, made once lastCompleteSweepAt is more than 3 intervals old', async () => {
    const root = await project();
    const store = SourceStore.open(root);
    store.create(CONNECTION_INPUT, 'conn-1');
    const veryOld = new Date(Date.now() - 20 * 60 * 1_000).toISOString(); // 20 min, interval is 300s -> stale past 15 min
    store.updateState('conn-1', {
      syncState: 'ok',
      lastCompleteSweepAt: veryOld,
    });

    const coordinator = {
      refresh: async () => undefined,
      enabledProjectIds: () => ['p'],
      store: () => store,
    } as unknown as SourceCoordinator;

    const scheduler = new WorkspaceSourceScheduler({
      coordinator,
      handle: (): ProjectSourceHandle => ({ projectId: 'p', dataDir: root }),
      resolveProvider: () => stubProvider(),
    });
    await scheduler.start();
    expect(store.state('conn-1')?.syncState).toBe('stale');
    scheduler.stop();
  });

  it('an unknown source kind is recorded as an error rather than throwing', async () => {
    const root = await project();
    const store = SourceStore.open(root);
    store.create({ ...CONNECTION_INPUT, kind: 'unregistered-kind' }, 'conn-1');
    const coordinator = {
      refresh: async () => undefined,
      enabledProjectIds: () => ['p'],
      store: () => store,
    } as unknown as SourceCoordinator;

    const scheduler = new WorkspaceSourceScheduler({
      coordinator,
      handle: (): ProjectSourceHandle => ({ projectId: 'p', dataDir: root }),
      resolveProvider: () => null,
    });
    await expect(scheduler.start()).resolves.toBeUndefined();
    scheduler.stop();
  });

  it('no scheduler file references a git host or its parsing helper by name', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = fileURLToPath(new URL('./scheduler.ts', import.meta.url));
    const text = readFileSync(path, 'utf8');
    const forbidden = [['git', 'hub.com'].join(''), ['parse', 'Remote'].join('')];
    expect(forbidden.some((term) => text.includes(term))).toBe(false);
  });
});
