import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationStore } from '../automations/store.ts';
import { emitUsageForTest } from '../core/process-usage.ts';
import { KnowledgeStore } from '../knowledge/store.ts';
import { NotificationOutbox } from '../notifications/outbox.ts';
import { SourceStore } from '../sources/store.ts';
import {
  ProjectContextError,
  ProjectContexts,
  type ProjectContextDeps,
  type ProjectContextSource,
} from './project-context.ts';

/**
 * Lazy per-project context map (spec 2026-07-20-multi-project-workspace,
 * step 2.1): nothing instantiated until first access, one instance per id,
 * missing roots never built, and a disposed context's manager stops
 * receiving usage-sampler ticks. The registry is injected as a plain
 * `listProjects` resolver so nothing here touches `~/.cezar`.
 */
describe('ProjectContexts', () => {
  let rootA: string;
  let rootB: string;

  beforeEach(() => {
    rootA = mkdtempSync(join(tmpdir(), 'cez-ctx-a-'));
    rootB = mkdtempSync(join(tmpdir(), 'cez-ctx-b-'));
  });

  afterEach(() => {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  });

  function makeContexts(projects: ProjectContextSource[]): ProjectContexts {
    return new ProjectContexts({ listProjects: async () => projects });
  }

  it('builds lazily: nothing on construction, first access builds, second returns the same instance', async () => {
    const contexts = makeContexts([
      { id: 'a', root: rootA, status: 'not-git' },
      { id: 'b', root: rootB, status: 'not-git' },
    ]);

    // Construction instantiated nothing — no store dir, no launch-key.
    expect(existsSync(join(rootA, '.ai/cezar'))).toBe(false);
    expect(existsSync(join(rootB, '.ai/cezar'))).toBe(false);
    expect(contexts.ids()).toEqual([]);

    const first = await contexts.context('a');
    expect(first.id).toBe('a');
    expect(first.dataDir).toBe(join(rootA, '.ai/cezar'));
    expect(first.launchKey).not.toBe('');
    expect(existsSync(join(rootA, '.ai/cezar', 'launch-key'))).toBe(true);
    // Only the accessed project was built.
    expect(existsSync(join(rootB, '.ai/cezar'))).toBe(false);
    expect(contexts.ids()).toEqual(['a']);

    const second = await contexts.context('a');
    expect(second).toBe(first);
  });

  it('dedupes concurrent builds of the same project into one instance', async () => {
    const contexts = makeContexts([{ id: 'a', root: rootA, status: 'not-git' }]);
    const [one, two] = await Promise.all([contexts.context('a'), contexts.context('a')]);
    expect(one).toBe(two);
  });

  it('uses the injected coordinator-owned automation store', async () => {
    const automationStore = AutomationStore.open(join(rootA, '.ai/cezar'));
    const resolveAutomationStore = vi.fn(() => automationStore);
    const contexts = new ProjectContexts({
      listProjects: async () => [{ id: 'a', root: rootA, status: 'not-git' }],
      automationStore: resolveAutomationStore,
    });
    const context = await contexts.context('a');
    expect(context.automationStore).toBe(automationStore);
    expect(resolveAutomationStore).toHaveBeenCalledWith('a', rootA);
    contexts.disposeAll();
  });

  it('never instantiates a missing-root project (even when the directory happens to exist)', async () => {
    const contexts = makeContexts([{ id: 'gone', root: rootA, status: 'missing' }]);
    await expect(contexts.context('gone')).rejects.toMatchObject({
      name: 'ProjectContextError',
      reason: 'missing-root',
      projectId: 'gone',
    });
    // Not built, and nothing written under the root.
    expect(contexts.peek('gone')).toBeUndefined();
    expect(existsSync(join(rootA, '.ai/cezar'))).toBe(false);
  });

  it('throws unknown-project for an id the registry does not hold', async () => {
    const contexts = makeContexts([{ id: 'a', root: rootA, status: 'not-git' }]);
    await expect(contexts.context('nope')).rejects.toMatchObject({
      name: 'ProjectContextError',
      reason: 'unknown-project',
      projectId: 'nope',
    });
    expect(contexts.ids()).toEqual([]);
  });

  it('exposes the failure as a typed error instance', async () => {
    const contexts = makeContexts([]);
    const err = await contexts.context('x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProjectContextError);
  });

  it('dispose(): the manager receives no further usage ticks and the index is flushed', async () => {
    const contexts = makeContexts([{ id: 'a', root: rootA, status: 'not-git' }]);
    const ctx = await contexts.context('a');
    // The constructor's onUsage listener calls `this.enforceMemoryLimit` —
    // spy on the instance and drive the fan-out directly, the way the shared
    // `ps` sampler would. An empty snapshot keeps the real method a sync no-op.
    const spy = vi.spyOn(
      ctx.manager as unknown as { enforceMemoryLimit: (s: Record<string, never>) => Promise<void> },
      'enforceMemoryLimit',
    );

    emitUsageForTest({});
    expect(spy).toHaveBeenCalledTimes(1);

    expect(contexts.dispose('a')).toBe(true);
    emitUsageForTest({});
    expect(spy).toHaveBeenCalledTimes(1); // unsubscribed — no further ticks
    // Store closed: the index landed on disk despite the debounced save.
    expect(existsSync(join(rootA, '.ai/cezar', 'runs.json'))).toBe(true);
    expect(ctx.store.listenerCount('event')).toBe(0);

    // Disposed id is gone from the map; the next access builds a fresh context.
    expect(contexts.peek('a')).toBeUndefined();
    const rebuilt = await contexts.context('a');
    expect(rebuilt).not.toBe(ctx);
    contexts.dispose('a');
  });

  it('onContextBuilt: fires once per build (not cached hits), unsubscribes cleanly, and a throwing listener never fails the build', async () => {
    const contexts = makeContexts([
      { id: 'a', root: rootA, status: 'not-git' },
      { id: 'b', root: rootB, status: 'not-git' },
    ]);
    const built: string[] = [];
    const off = contexts.onContextBuilt((ctx) => built.push(ctx.id));
    contexts.onContextBuilt(() => {
      throw new Error('subscriber boom');
    });

    await contexts.context('a');
    expect(built).toEqual(['a']); // the throwing listener didn't fail the build
    await contexts.context('a');
    expect(built).toEqual(['a']); // cached hit — no re-notify

    off();
    const b = await contexts.context('b');
    expect(b.id).toBe('b'); // built fine with only the throwing listener left
    expect(built).toEqual(['a']); // unsubscribed — not notified for b
    contexts.disposeAll();
  });

  it('dispose() of a never-built project is a no-op returning false', () => {
    const contexts = makeContexts([{ id: 'a', root: rootA, status: 'not-git' }]);
    expect(contexts.dispose('a')).toBe(false);
  });

  it('disposeAll() tears down every built context', async () => {
    const contexts = makeContexts([
      { id: 'a', root: rootA, status: 'not-git' },
      { id: 'b', root: rootB, status: 'not-git' },
    ]);
    const a = await contexts.context('a');
    const b = await contexts.context('b');
    const spyA = vi.spyOn(
      a.manager as unknown as { enforceMemoryLimit: (s: Record<string, never>) => Promise<void> },
      'enforceMemoryLimit',
    );
    const spyB = vi.spyOn(
      b.manager as unknown as { enforceMemoryLimit: (s: Record<string, never>) => Promise<void> },
      'enforceMemoryLimit',
    );

    contexts.disposeAll();
    expect(contexts.ids()).toEqual([]);
    emitUsageForTest({});
    expect(spyA).not.toHaveBeenCalled();
    expect(spyB).not.toHaveBeenCalled();
  });
});

/**
 * Central-hub activation (`.ai/runs/2026-08-06-cezar-central-hub/PLAN.md`, W3.1, D22a):
 * `knowledgeStore` / `sourceStore` hung on `ProjectContext`, and the workspace-level `runIndex`
 * plus notification runtime on `ProjectContexts` itself. Every flag defaults off, and "off" here
 * means zero I/O, proven with a spy on the underlying store's own construction call, not just an
 * `undefined` check on the result (a mutation that built the store but discarded the reference
 * would still pass an `undefined`-only assertion).
 */
describe('ProjectContexts, central-hub activation (W3.1)', () => {
  let root: string;
  const extraDirs: string[] = [];
  const built: ProjectContexts[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-ctx-hub-'));
  });

  afterEach(() => {
    for (const contexts of built.splice(0)) contexts.disposeAll();
    rmSync(root, { recursive: true, force: true });
    for (const dir of extraDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    extraDirs.push(dir);
    return dir;
  }

  function buildHub(overrides: Partial<ProjectContextDeps> = {}): ProjectContexts {
    const contexts = new ProjectContexts({
      listProjects: async () => [{ id: 'a', root, status: 'not-git' }],
      env: {},
      ...overrides,
    });
    built.push(contexts);
    return contexts;
  }

  async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('waitFor: timed out');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it('every central-hub flag unset: knowledgeStore, sourceStore and notifications() are all absent, and neither store is even constructed', async () => {
    const createSpy = vi.spyOn(KnowledgeStore, 'create');
    const openSpy = vi.spyOn(SourceStore, 'open');
    const contexts = buildHub();

    const ctx = await contexts.context('a');

    expect(ctx.knowledgeStore).toBeUndefined();
    expect(ctx.sourceStore).toBeUndefined();
    expect(contexts.notifications()).toBeUndefined();
    // The gate is "never constructed", not "constructed then discarded" (a mutation that
    // dropped the flag check but kept `?? undefined` somewhere would still read as absent above).
    expect(createSpy).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
    // No on-disk trace of either feature: this project context does exactly what it did before
    // this package existed.
    expect(existsSync(join(root, '.ai/cezar/knowledge-index'))).toBe(false);
    expect(existsSync(join(root, '.ai/cezar/sources.json'))).toBe(false);

    createSpy.mockRestore();
    openSpy.mockRestore();
  });

  it('knowledgeStore is built only under CEZ_KB=1, initializes without context() waiting on the scan, and is disposed on dispose()', async () => {
    const contexts = buildHub({ env: { CEZ_KB: '1' } });

    const ctx = await contexts.context('a');
    expect(ctx.knowledgeStore).toBeDefined();

    // Fire-and-forget: nobody awaited the scan to resolve context(), so it finishes on its own.
    await waitFor(() => ctx.knowledgeStore!.isInitialized());
    expect(ctx.knowledgeStore!.getRoots().find((r) => r.id === 'project')).toMatchObject({
      indexed: true,
    });

    const disposeSpy = vi.spyOn(ctx.knowledgeStore!, 'dispose');
    expect(contexts.dispose('a')).toBe(true);
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it('knowledgeStore.hosted follows CEZ_REMOTE and bindHost the same way resolveCapabilities() does', async () => {
    const createSpy = vi.spyOn(KnowledgeStore, 'create');

    const loopback = buildHub({ env: { CEZ_KB: '1' }, listProjects: async () => [{ id: 'a', root: tempDir('cez-ctx-hub-hosted-a-'), status: 'not-git' }] });
    await loopback.context('a');
    expect(createSpy.mock.calls[0]?.[2]).toMatchObject({ hosted: false });
    createSpy.mockClear();

    const remote = buildHub({
      env: { CEZ_KB: '1', CEZ_REMOTE: '1' },
      listProjects: async () => [{ id: 'a', root: tempDir('cez-ctx-hub-hosted-b-'), status: 'not-git' }],
    });
    await remote.context('a');
    expect(createSpy.mock.calls[0]?.[2]).toMatchObject({ hosted: true });
    createSpy.mockClear();

    const boundExternally = buildHub({
      env: { CEZ_KB: '1' },
      bindHost: '0.0.0.0',
      listProjects: async () => [{ id: 'a', root: tempDir('cez-ctx-hub-hosted-c-'), status: 'not-git' }],
    });
    await boundExternally.context('a');
    expect(createSpy.mock.calls[0]?.[2]).toMatchObject({ hosted: true });

    createSpy.mockRestore();
  });

  it('sourceStore is built only under CEZ_SOURCES=1, and a failure to open it degrades to undefined rather than failing the whole project context', async () => {
    const ok = buildHub({ env: { CEZ_SOURCES: '1' } });
    const okCtx = await ok.context('a');
    expect(okCtx.sourceStore).toBeDefined();

    const openSpy = vi.spyOn(SourceStore, 'open').mockImplementation(() => {
      throw new Error('boom');
    });
    const broken = buildHub({
      env: { CEZ_SOURCES: '1' },
      listProjects: async () => [{ id: 'a', root: tempDir('cez-ctx-hub-src-broken-'), status: 'not-git' }],
    });
    const brokenCtx = await broken.context('a');
    expect(brokenCtx.sourceStore).toBeUndefined();
    // The REST of the context still came up: a sources-only failure must not take down the run
    // store, the manager or the launch key with it.
    expect(brokenCtx.launchKey).not.toBe('');
    expect(brokenCtx.store).toBeDefined();

    openSpy.mockRestore();
  });

  it('runIndex is a workspace-level singleton reachable without building any project, and its list() reflects listProjects() with a basename() name fallback', async () => {
    const contexts = buildHub();
    const before = contexts.runIndex;

    await contexts.context('a'); // building a project must not replace or touch runIndex
    expect(contexts.runIndex).toBe(before);

    const result = await contexts.runIndex.list();
    expect(result.projects).toEqual([
      { id: 'a', name: basename(root), status: 'not-git', ok: true, total: 0 },
    ]);
  });

  it('notifications() is undefined under CEZ_NOTIFY unset', () => {
    const contexts = buildHub();
    expect(contexts.notifications()).toBeUndefined();
  });

  it('notifications() is wired under CEZ_NOTIFY=1 with zero registered transports (idle, no timer), and disposeAll() truly releases the cross-process outbox lease', async () => {
    const home = tempDir('cez-ctx-hub-home-');
    const lockPath = join(home, 'notifications', 'outbox.lock');

    const contexts1 = buildHub({ env: { CEZ_NOTIFY: '1', CEZ_HOME: home } });
    const runtime1 = contexts1.notifications();
    expect(runtime1).toBeDefined();
    // D4 "no background timer": zero registered transports means dispatch() is never invoked by
    // anything yet, so the demand-driven sender has nothing due.
    expect(runtime1!.sender.hasTimer()).toBe(false);
    // sender.start() really acquired the lease, not a no-op construction.
    expect(existsSync(lockPath)).toBe(true);

    contexts1.disposeAll();
    expect(existsSync(lockPath)).toBe(false);

    // Negative control: prove the release was real, not vacuous, by having a second runtime
    // against the SAME CEZ_HOME successfully acquire the lease afterward. This fails if
    // `disposeAll()` stopped calling `sender.stop()`.
    buildHub({ env: { CEZ_NOTIFY: '1', CEZ_HOME: home } });
    expect(existsSync(lockPath)).toBe(true);
  });

  it('a broken notification runtime degrades to notifications() === undefined rather than failing ProjectContexts construction', () => {
    const openSpy = vi.spyOn(NotificationOutbox, 'open').mockImplementation(() => {
      throw new Error('boom');
    });

    let contexts: ProjectContexts | undefined;
    expect(() => {
      contexts = buildHub({ env: { CEZ_NOTIFY: '1', CEZ_HOME: tempDir('cez-ctx-hub-home-broken-') } });
    }).not.toThrow();
    expect(contexts!.notifications()).toBeUndefined();

    openSpy.mockRestore();
  });
});
