import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContentBlock } from './core/agent-runner.ts';
import { RunStore } from './runs/store.ts';
import type { ProjectContext, ProjectContexts } from './server/project-context.ts';
import { startServer, type ServerProjectAccess } from './server/server.ts';
import type { RunManager } from './workflows/run.ts';
import {
  appendReopenRequests,
  readReopenRequests,
  reopenRequestsPath,
  type ReopenRequest,
} from './reopen-requests.ts';
import { reconcileReopenRequests, watchReopenRequests, type ReopenWatchProject } from './reopen-watch.ts';

/**
 * Phase 2 of `.ai/specs/2026-08-20-reopen-finished-tasks-merge-audit.md` — the cockpit watcher.
 * A capturing `RunManager` stub is all this boundary needs (the `todo-autostart.test.ts` /
 * `todos-start.test.ts` pattern); the real engine is exercised by `reopen-integration.test.ts`.
 */

type ContinueCall = {
  runId: string;
  opts: { text?: string; images?: ContentBlock[] };
  deferForCapacity: boolean | undefined;
};

async function waitFor(assertion: () => void, timeoutMs = 4000, intervalMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      assertion();
      return;
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

describe('reconcileReopenRequests', () => {
  let root: string;
  let dataDir: string;
  let calls: ContinueCall[];
  let project: ReopenWatchProject;
  let result: { ok: boolean; error?: string };

  const stubManager = (
    fn?: (runId: string) => { ok: boolean; error?: string },
  ): RunManager =>
    ({
      continueRun: (
        runId: string,
        opts: { text?: string; images?: ContentBlock[] } = {},
        deferForCapacity?: boolean,
      ) => {
        calls.push({ runId, opts, deferForCapacity });
        return fn ? fn(runId) : result;
      },
    }) as unknown as RunManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-reopen-watch-'));
    dataDir = join(root, '.ai/cezar');
    calls = [];
    result = { ok: true };
    project = { dataDir, manager: stubManager() };
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('continues a pending request and stamps startedAt on disk', async () => {
    await appendReopenRequests(dataDir, [{ runId: 'run-1', prompt: 'did it land?' }]);
    await reconcileReopenRequests(project);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.runId).toBe('run-1');
    expect(calls[0]?.opts.text).toBe('did it land?');

    const [request] = await readReopenRequests(dataDir);
    expect(request?.startedAt).toBeTruthy();
    expect(request?.error).toBeUndefined();
  });

  /**
   * The third argument is the whole capacity story: a bulk sweep must queue its continuations
   * rather than spawn one agent process per request at once. Asserted explicitly, and asserted as
   * `true` rather than merely truthy, because `continueRun` defaults it to `false`.
   */
  it('always defers for capacity — continueRun(runId, {text}, true)', async () => {
    await appendReopenRequests(dataDir, [{ runId: 'run-1' }]);
    await reconcileReopenRequests(project);
    expect(calls[0]?.deferForCapacity).toBe(true);
  });

  it('a request with no prompt hands the engine no text, so it uses its own default', async () => {
    await appendReopenRequests(dataDir, [{ runId: 'run-1' }]);
    await reconcileReopenRequests(project);
    expect(calls[0]?.opts.text).toBeUndefined();
  });

  it('stamps error — not startedAt — when continueRun refuses, and never retries the row', async () => {
    result = { ok: false, error: 'no agent session to resume' };
    await appendReopenRequests(dataDir, [{ runId: 'run-1' }]);
    await reconcileReopenRequests(project);

    const [request] = await readReopenRequests(dataDir);
    expect(request?.error).toBe('no agent session to resume');
    expect(request?.startedAt).toBeUndefined();

    // Terminal: a second pass must not call the manager again.
    await reconcileReopenRequests(project);
    expect(calls).toHaveLength(1);
  });

  it('skips a row already carrying startedAt, and one already carrying error', async () => {
    mkdirSync(dataDir, { recursive: true });
    const rows: ReopenRequest[] = [
      { id: 'a', runId: 'run-a', createdAt: '2026-08-20T00:00:00.000Z', startedAt: '2026-08-20T01:00:00.000Z' },
      { id: 'b', runId: 'run-b', createdAt: '2026-08-20T00:00:00.000Z', error: 'run is still active' },
      { id: 'c', runId: 'run-c', createdAt: '2026-08-20T00:00:00.000Z' },
    ];
    writeFileSync(reopenRequestsPath(dataDir), JSON.stringify(rows), 'utf8');
    await reconcileReopenRequests(project);
    expect(calls.map((c) => c.runId)).toEqual(['run-c']);
  });

  it('a throwing row is logged and the remaining rows still reconcile', async () => {
    await appendReopenRequests(dataDir, [{ runId: 'boom' }, { runId: 'fine' }]);
    const manager = stubManager((runId) => {
      if (runId === 'boom') throw new Error('manager exploded');
      return { ok: true };
    });
    await reconcileReopenRequests({ dataDir, manager });

    expect(calls.map((c) => c.runId)).toEqual(['boom', 'fine']);
    const requests = await readReopenRequests(dataDir);
    // The thrower stays pending (a throw is not a verdict — the next pass retries it); the row
    // after it is started regardless.
    expect(requests.find((r) => r.runId === 'boom')?.startedAt).toBeUndefined();
    expect(requests.find((r) => r.runId === 'fine')?.startedAt).toBeTruthy();
  });

  it('two concurrent passes over one dataDir produce exactly one continueRun per request', async () => {
    await appendReopenRequests(dataDir, [{ runId: 'run-1' }, { runId: 'run-2' }]);
    // Neither call is awaited before the second fires — the per-dataDir tail is what has to keep
    // both from reading the file before either's markReopenStarted lands.
    await Promise.all([reconcileReopenRequests(project), reconcileReopenRequests(project)]);
    expect(calls.map((c) => c.runId)).toEqual(['run-1', 'run-2']);
  });

  it('an inbox that was never written is a no-op, not an error', async () => {
    await expect(reconcileReopenRequests(project)).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});

describe('watchReopenRequests', () => {
  let root: string;
  let dataDir: string;
  let calls: ContinueCall[];
  const cleanups: Array<() => void> = [];

  const fakeProject = (): ReopenWatchProject => ({
    dataDir,
    manager: {
      continueRun: (
        runId: string,
        opts: { text?: string; images?: ContentBlock[] } = {},
        deferForCapacity?: boolean,
      ) => {
        calls.push({ runId, opts, deferForCapacity });
        return { ok: true };
      },
    } as unknown as RunManager,
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-reopen-watch-live-'));
    dataDir = join(root, '.ai/cezar');
    calls = [];
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    for (const off of cleanups.splice(0)) off();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('the boot pass applies a request already sitting in the file at subscribe time', async () => {
    await appendReopenRequests(dataDir, [{ runId: 'run-1' }]);
    cleanups.push(watchReopenRequests(fakeProject()));
    await waitFor(() => expect(calls).toHaveLength(1));
  });

  it('a later write to reopen-requests.json is picked up live', async () => {
    mkdirSync(dataDir, { recursive: true });
    await fs.writeFile(reopenRequestsPath(dataDir), '[]', 'utf8');
    cleanups.push(watchReopenRequests(fakeProject()));
    await waitFor(() => expect(calls).toHaveLength(0)); // settle the boot pass first
    await appendReopenRequests(dataDir, [{ runId: 'run-later' }]);
    await waitFor(() => expect(calls.map((c) => c.runId)).toEqual(['run-later']), 6000);
  });

  it('re-subscribing the same dataDir replaces the old watch rather than stacking a second one', async () => {
    mkdirSync(dataDir, { recursive: true });
    await fs.writeFile(reopenRequestsPath(dataDir), '[]', 'utf8');
    const first = watchReopenRequests(fakeProject());
    const second = watchReopenRequests(fakeProject());
    cleanups.push(second);
    // The superseded subscription's own unsubscribe must be a safe no-op.
    expect(() => first()).not.toThrow();
  });
});

describe('cold-project reopen discovery', () => {
  it('boots the real server path and wakes a non-resident project only after a pending request', async () => {
    const bootRoot = mkdtempSync(join(tmpdir(), 'cez-reopen-cold-boot-'));
    const targetRoot = mkdtempSync(join(tmpdir(), 'cez-reopen-cold-target-'));
    const home = mkdtempSync(join(tmpdir(), 'cez-reopen-cold-home-'));
    const bootDataDir = join(bootRoot, '.ai/cezar');
    const targetDataDir = join(targetRoot, '.ai/cezar');
    mkdirSync(bootDataDir, { recursive: true });
    const bootStore = RunStore.open(bootDataDir);
    const calls: ContinueCall[] = [];
    const listeners = new Set<(ctx: ProjectContext) => void>();
    let targetStore: RunStore | undefined;
    let targetContext: ProjectContext | undefined;
    let builds = 0;
    let loadCalls = 0;
    let resident = false;
    const manager = {
      continueRun: (
        runId: string,
        opts: { text?: string; images?: ContentBlock[] } = {},
        deferForCapacity?: boolean,
      ) => {
        calls.push({ runId, opts, deferForCapacity });
        return { ok: true };
      },
    } as unknown as RunManager;
    const contexts = {
      ids: () => resident ? ['cold-reopen'] : [],
      peek: (id: string) => id === 'cold-reopen' && resident ? targetContext : undefined,
      onStoreCreated: () => () => undefined,
      onContextBuilt: (listener: (ctx: ProjectContext) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      context: async (id: string) => {
        if (id !== 'cold-reopen') throw new Error(`unexpected project ${id}`);
        builds += 1;
        mkdirSync(targetDataDir, { recursive: true });
        targetStore = RunStore.open(targetDataDir);
        const built = {
          id,
          root: targetRoot,
          dataDir: targetDataDir,
          store: targetStore,
          manager,
        } as unknown as ProjectContext;
        targetContext = built;
        resident = true;
        // Deliberately does NOT arm the watcher itself, see the twin comment in
        // `todo-autostart.test.ts`. The only path from a woken context to a live
        // `reopen-requests.json` watch must be `createApp`'s `contexts.onContextBuilt(...)`.
        for (const listener of listeners) listener(built);
        return built;
      },
    } as unknown as ProjectContexts;
    const projectAccess: ServerProjectAccess = {
      resolveBootProject: async () => 'boot',
      listVisibleProjects: async () => {
        loadCalls += 1;
        return [{
          id: 'cold-reopen',
          root: targetRoot,
          name: 'cold-reopen',
          addedAt: '',
          lastOpenedAt: '',
          source: 'local',
          status: 'not-git',
        }];
      },
    };
    const savedHome = process.env.CEZ_HOME;
    const savedCluster = process.env.CEZ_CLUSTER;
    const savedAutomations = process.env.CEZ_AUTOMATIONS;
    const savedBackup = process.env.CEZ_BACKUP;
    process.env.CEZ_HOME = home;
    delete process.env.CEZ_CLUSTER;
    delete process.env.CEZ_AUTOMATIONS;
    delete process.env.CEZ_BACKUP;
    const server = startServer({
      repoRoot: bootRoot,
      store: bootStore,
      manager: {} as RunManager,
      version: '0.0.0-test',
      bootProjectId: 'boot',
      contexts,
      projectAccess,
      lazyProjectIntentIntervalMs: 10,
    }, 0);
    const stopBootWatch = watchReopenRequests({ dataDir: bootDataDir, manager });
    try {
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      await waitFor(() => expect(loadCalls).toBeGreaterThan(0));
      expect(contexts.ids()).toEqual([]);
      expect(existsSync(targetDataDir)).toBe(false);

      await appendReopenRequests(targetDataDir, [{ runId: 'run-cold', prompt: 'read only' }]);
      await waitFor(() => expect(builds).toBe(1), 6000);
      await waitFor(() => expect(calls.map((call) => call.runId)).toEqual(['run-cold']), 6000);
      const [request] = await readReopenRequests(targetDataDir);
      expect(request?.startedAt).toBeTruthy();
      expect(builds).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // Same teardown-by-resubscribe as the autostart twin: one subscription per dataDir, so
      // re-subscribing stops what `onContextBuilt` armed and stopping the replacement leaves none.
      if (targetContext) watchReopenRequests({ dataDir: targetDataDir, manager })();
      stopBootWatch();
      bootStore.flush();
      targetStore?.flush();
      rmSync(bootRoot, { recursive: true, force: true });
      rmSync(targetRoot, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      if (savedHome === undefined) delete process.env.CEZ_HOME;
      else process.env.CEZ_HOME = savedHome;
      if (savedCluster === undefined) delete process.env.CEZ_CLUSTER;
      else process.env.CEZ_CLUSTER = savedCluster;
      if (savedAutomations === undefined) delete process.env.CEZ_AUTOMATIONS;
      else process.env.CEZ_AUTOMATIONS = savedAutomations;
      if (savedBackup === undefined) delete process.env.CEZ_BACKUP;
      else process.env.CEZ_BACKUP = savedBackup;
    }
  });
});
