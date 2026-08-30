import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SourceProvider } from './provider-types.ts';
import { SourceRuntime, type SourceRuntimeOptions } from './runtime.ts';
import { SourceStore } from './store.ts';

const dirs: string[] = [];
const runtimes: SourceRuntime[] = [];

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cezar-source-runtime-'));
  dirs.push(root);
  return root;
}

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.useRealTimers();
});

const connectionInput = {
  kind: 'notion',
  name: 'Source',
  enabled: true,
  mode: 'mirror' as const,
  intervalSeconds: 300,
  collections: [],
  watchComments: false,
  maxDocuments: 5_000,
  maxBodyBytes: 524_288,
};

function provider(onDetect?: () => void): SourceProvider {
  return {
    kind: 'notion',
    capabilities: { list: true, fetch: true, poll: true, push: false, comments: false },
    detect: async () => {
      onDetect?.();
      return { available: true };
    },
    detectCached: () => ({ available: true }),
    listCollections: async () => [],
    listDocuments: async () => ({ documents: [], nextPageCursor: null, complete: true, truncated: false }),
    fetchDocument: async () => null,
    pollChanges: async () => ({ changes: [], watermark: null, nextPageCursor: null, complete: true, truncated: false }),
    viewUrl: () => null,
  };
}

function runtime(
  root: string,
  resolveProvider: SourceRuntimeOptions['resolveProvider'] = () => provider(),
  emit?: SourceRuntimeOptions['emit'],
): SourceRuntime {
  const instance = new SourceRuntime({
    listProjects: async () => [],
    bootProjectId: 'boot',
    bootRoot: root,
    resolveProvider,
    ...(emit ? { emit } : {}),
  });
  runtimes.push(instance);
  return instance;
}

describe('SourceRuntime', () => {
  it('owns one boot store and joins same-connection kicks while sharing the execution path', async () => {
    const root = await directory();
    let detects = 0;
    const events: unknown[] = [];
    let sourceRuntime!: SourceRuntime;
    sourceRuntime = runtime(root, () => provider(() => { detects += 1; }), (_event, data) => {
      events.push(data);
      expect(sourceRuntime.store('boot')?.state('conn-1')?.syncState).toBe('ok');
    });
    const store = sourceRuntime.store('boot')!;
    store.create(connectionInput, 'conn-1');
    await sourceRuntime.refresh();
    expect(sourceRuntime.coordinator.store('boot')).toBe(store);

    const first = sourceRuntime.kick('boot', 'conn-1');
    const second = sourceRuntime.kick('boot', 'conn-1');

    expect(sourceRuntime.store('boot')).toBe(store);
    expect(second.syncId).toBe(first.syncId);
    await Promise.all([first.promise, second.promise]);
    expect(detects).toBe(1);
    expect(store.state('conn-1')?.syncState).toBe('ok');
    expect(events).toEqual([expect.objectContaining({ project: 'boot', connectionId: 'conn-1', syncState: 'ok', ran: true })]);
  });

  it('serializes two connections in one project and retries a lease-held run', async () => {
    vi.useFakeTimers();
    const root = await directory();
    let active = 0;
    let maximum = 0;
    const sourceRuntime = runtime(root, () => provider(() => {
      active += 1;
      maximum = Math.max(maximum, active);
      active -= 1;
    }));
    const store = sourceRuntime.store('boot')!;
    store.create({ ...connectionInput, name: 'One' }, 'conn-1');
    store.create({ ...connectionInput, name: 'Two' }, 'conn-2');

    const first = sourceRuntime.kick('boot', 'conn-1');
    const second = sourceRuntime.kick('boot', 'conn-2');
    await Promise.all([first.promise, second.promise]);
    expect(maximum).toBe(1);

    const lease = store.acquireLease();
    expect(lease).toBeDefined();
    const retried = sourceRuntime.kick('boot', 'conn-1');
    await vi.advanceTimersByTimeAsync(0);
    lease?.release();
    await vi.advanceTimersByTimeAsync(50);
    await retried.promise;
    expect(store.state('conn-1')?.syncState).toBe('ok');
  });

  it('reloads a sibling process definition before provider selection and the sweep', async () => {
    const root = await directory();
    let detects = 0;
    const sourceRuntime = runtime(root, () => provider(() => { detects += 1; }));
    const store = sourceRuntime.store('boot')!;
    const connection = store.create(connectionInput, 'conn-1');
    const sibling = SourceStore.open(join(root, '.ai/cezar'));
    sibling.update(connection.id, connection.revision, { ...connection, enabled: false });

    const result = await sourceRuntime.kick('boot', connection.id).promise;
    expect(result).toEqual(expect.objectContaining({ ran: false, reason: 'disabled' }));
    expect(detects).toBe(0);
    expect(store.get(connection.id)?.enabled).toBe(false);
  });

  it('stops the workspace timer on shutdown', async () => {
    vi.useFakeTimers();
    const root = await directory();
    const sourceRuntime = runtime(root);
    sourceRuntime.store('boot')!.create(connectionInput, 'conn-1');

    await sourceRuntime.start();
    expect(sourceRuntime.scheduler.hasTimer()).toBe(true);
    await sourceRuntime.stop();
    expect(sourceRuntime.scheduler.hasTimer()).toBe(false);
  });

  it('reloads independently opened stores before each write so concurrent definitions survive', async () => {
    const root = await directory();
    const first = SourceStore.open(join(root, '.ai/cezar'));
    const second = SourceStore.open(join(root, '.ai/cezar'));
    first.create({ ...connectionInput, name: 'First' }, 'conn-1');
    second.create({ ...connectionInput, name: 'Second' }, 'conn-2');

    expect(SourceStore.open(join(root, '.ai/cezar')).list().map((item) => item.id)).toEqual(['conn-1', 'conn-2']);
  });
});
