import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContentBlock } from './core/agent-runner.ts';
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
