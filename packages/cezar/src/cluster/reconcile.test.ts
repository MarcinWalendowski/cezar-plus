import { promises as fsp } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readTodos, todosPath, type TodoItem } from '../todos.ts';
import {
  classify,
  reconcileAll,
  reconcileProject,
  startPeriodicReconcile,
  type ReconcileOptions,
  type RemoteReconcileTransport,
} from './reconcile.ts';

/**
 * Package 2.4 (`.ai/runs/2026-08-22-multi-node-cezar-cluster/PLAN.md`) — the reconcile classifier
 * and the periodic full reconcile. Verifies spec `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`
 * automated 7/8 (the closest faithful analogue reachable from this module alone — see the report
 * for why a genuine two-server-over-loopback harness is out of scope here) plus the four negative
 * controls named for this package.
 */

/** `todo-autostart.test.ts`'s own polling helper, same shape: real timers, bounded retries. */
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

async function writeJson(dataDir: string, todos: TodoItem[]): Promise<void> {
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.writeFile(todosPath(dataDir), JSON.stringify(todos, null, 2), 'utf8');
}

async function readBackup(dataDir: string): Promise<TodoItem[] | undefined> {
  try {
    const raw = await fsp.readFile(`${todosPath(dataDir)}.bak`, 'utf8');
    return JSON.parse(raw) as TodoItem[];
  } catch {
    return undefined;
  }
}

/** A `RemoteReconcileTransport` backed by real second (and third, …) temp directories — the
 *  closest in-process analogue to "a peer reachable over the cluster link".
 *
 *  **Corrected 2026-08-23:** this said the dir transport existed because `link-client.ts` /
 *  `link-server.ts` / `cluster/ops.ts` / `cluster/replica.ts` were "still `not implemented` as this
 *  package was written". They are implemented now, and the transport still has no route to swap to
 *  — `cez cluster reconcile` has no request/response primitive for "fetch a peer's todo list" at
 *  all (see PLAN.md → "Found during implementation"). So this remains the only way to drive the
 *  classifier, and it is honest about it rather than implying a link-backed path exists. It uses
 *  the exact same `readTodos`/`todosPath` primitives production code will, so the merge logic under
 *  test is identical to what a real link-backed transport would drive. */
function makeDirTransport(dirsByProject: Map<string, string>): RemoteReconcileTransport {
  const dirFor = (projectKey: string): string => {
    const dir = dirsByProject.get(projectKey);
    if (!dir) throw new Error(`no remote dir registered for project "${projectKey}"`);
    return dir;
  };
  return {
    listProjects: async () => [...dirsByProject.keys()],
    list: async (projectKey) => readTodos(dirFor(projectKey)),
    backup: async (projectKey) => {
      const dir = dirFor(projectKey);
      const file = todosPath(dir);
      const backupFile = `${file}.bak`;
      let raw: string;
      try {
        raw = await fsp.readFile(file, 'utf8');
      } catch {
        raw = '[]';
      }
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(backupFile, raw, 'utf8');
      return backupFile;
    },
    apply: async (projectKey, adds) => {
      const dir = dirFor(projectKey);
      const existing = await readTodos(dir);
      const ids = new Set(existing.map((t) => t.id));
      const next = [...existing, ...adds.filter((a) => !ids.has(a.id))];
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(todosPath(dir), JSON.stringify(next, null, 2), 'utf8');
    },
  };
}

const PROJECT = 'cezar';

describe('classify', () => {
  it('present on one side only', () => {
    const t: TodoItem = { id: 'a', summary: 'x' };
    expect(classify(t, undefined)).toBe('local-only');
    expect(classify(undefined, t)).toBe('remote-only');
  });

  it('throws when neither side is present', () => {
    expect(() => classify(undefined, undefined)).toThrow();
  });

  it('present on both, identical content -> identical', () => {
    const local: TodoItem = { id: 'a', summary: 'x', priority: 'high' };
    const remote: TodoItem = { id: 'a', summary: 'x', priority: 'high' };
    expect(classify(local, remote)).toBe('identical');
  });

  it('present on both, differing, neither carries hubSeq -> divergent-unclocked (refused)', () => {
    const local: TodoItem = { id: 'a', summary: 'local version' };
    const remote: TodoItem = { id: 'a', summary: 'remote version' };
    expect(classify(local, remote)).toBe('divergent-unclocked');
  });

  it('present on both, differing, but the hub has already ordered one side -> not a conflict', () => {
    // Once either side carries a hubSeq the hub has established order for this record; a residual
    // difference is the replica pipeline's job (D4/D7), not this bootstrap tool's — see the
    // classify() doc comment for why this is not reported as `divergent-unclocked`.
    const local = { id: 'a', summary: 'local version', hubSeq: 3 } as TodoItem;
    const remote: TodoItem = { id: 'a', summary: 'remote version' };
    expect(classify(local, remote)).toBe('identical');
  });
});

describe('reconcileProject', () => {
  let localDataDir: string;
  let remoteDataDir: string;
  let remoteRoot: string;
  let localRoot: string;

  const optionsFor = (dryRun: boolean): ReconcileOptions => ({
    dryRun,
    peerNodeId: 'peer-1',
    resolveLocalDataDir: () => localDataDir,
    remote: makeDirTransport(new Map([[PROJECT, remoteDataDir]])),
  });

  beforeEach(() => {
    localRoot = mkdtempSync(join(tmpdir(), 'cez-reconcile-local-'));
    remoteRoot = mkdtempSync(join(tmpdir(), 'cez-reconcile-remote-'));
    localDataDir = join(localRoot, '.ai/cezar');
    remoteDataDir = join(remoteRoot, '.ai/cezar');
  });

  afterEach(() => {
    rmSync(localRoot, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  });

  it('classifies local-only, remote-only and identical, and reports counts', async () => {
    await writeJson(localDataDir, [
      { id: 'l1', summary: 'local only' },
      { id: 'same', summary: 'shared', priority: 'low' },
    ]);
    await writeJson(remoteDataDir, [
      { id: 'r1', summary: 'remote only' },
      { id: 'same', summary: 'shared', priority: 'low' },
    ]);

    const report = await reconcileProject(PROJECT, optionsFor(true));

    expect(report.counts).toEqual({
      'local-only': 1,
      'remote-only': 1,
      identical: 1,
      'divergent-unclocked': 0,
    });
    expect(report.dryRun).toBe(true);
    expect(report.backupPaths).toEqual([]);
  });

  it('negative control: identical records are not counted as adds, and nothing is written', async () => {
    const shared: TodoItem = { id: 'same', summary: 'shared', priority: 'low', status: 'todo' };
    await writeJson(localDataDir, [shared]);
    await writeJson(remoteDataDir, [{ ...shared }]);

    const report = await reconcileProject(PROJECT, optionsFor(false));

    expect(report.counts.identical).toBe(1);
    expect(report.counts['local-only']).toBe(0);
    expect(report.counts['remote-only']).toBe(0);
    expect(report.backupPaths).toEqual([]); // nothing to write -> no backup taken either

    const local = await readTodos(localDataDir);
    const remote = await readTodos(remoteDataDir);
    expect(local).toHaveLength(1);
    expect(remote).toHaveLength(1);
    expect(await readBackup(localDataDir)).toBeUndefined();
    expect(await readBackup(remoteDataDir)).toBeUndefined();
  });

  it('negative control: a differing pair is refused, not merged, and neither side is modified', async () => {
    const localBefore: TodoItem[] = [{ id: 'conflict', summary: 'local wins here', priority: 'high' }];
    const remoteBefore: TodoItem[] = [{ id: 'conflict', summary: 'remote wins here', priority: 'low' }];
    await writeJson(localDataDir, localBefore);
    await writeJson(remoteDataDir, remoteBefore);

    const report = await reconcileProject(PROJECT, optionsFor(false));

    expect(report.counts['divergent-unclocked']).toBe(1);
    const entry = report.entries.find((e) => e.entityId === 'conflict');
    expect(entry?.class).toBe('divergent-unclocked');
    expect(entry?.fields).toContain('summary');
    expect(entry?.fields).toContain('priority');

    // Assert the refusal AND that neither side was touched — the class alone is not proof.
    expect(await readTodos(localDataDir)).toEqual(localBefore);
    expect(await readTodos(remoteDataDir)).toEqual(remoteBefore);
    expect(report.backupPaths).toEqual([]); // a refused pair alone triggers no write, no backup
  });

  it('negative control: .bak exists on both sides, and its CONTENT is the pre-mutation state', async () => {
    const localOnly: TodoItem = { id: 'a', summary: 'only local has this' };
    const remoteOnly: TodoItem = { id: 'b', summary: 'only remote has this' };
    await writeJson(localDataDir, [localOnly]);
    await writeJson(remoteDataDir, [remoteOnly]);

    const report = await reconcileProject(PROJECT, optionsFor(false));

    expect(report.backupPaths).toHaveLength(2);
    const localBackup = await readBackup(localDataDir);
    const remoteBackup = await readBackup(remoteDataDir);
    // The whole point of the control: the backup holds what was there BEFORE this run, not the
    // merged result. If backups were taken after writing, these would already contain both rows.
    expect(localBackup).toEqual([localOnly]);
    expect(remoteBackup).toEqual([remoteOnly]);

    // And both sides did converge, past the backup.
    const localAfter = await readTodos(localDataDir);
    const remoteAfter = await readTodos(remoteDataDir);
    expect(localAfter.map((t) => t.id).sort()).toEqual(['a', 'b']);
    expect(remoteAfter.map((t) => t.id).sort()).toEqual(['a', 'b']);
  });

  it('dry run: reports the same shape but writes nothing on either side', async () => {
    await writeJson(localDataDir, [{ id: 'a', summary: 'local only' }]);
    await writeJson(remoteDataDir, [{ id: 'b', summary: 'remote only' }]);

    const report = await reconcileProject(PROJECT, optionsFor(true));

    expect(report.counts['local-only']).toBe(1);
    expect(report.counts['remote-only']).toBe(1);
    expect(report.backupPaths).toEqual([]);
    expect(await readTodos(localDataDir)).toHaveLength(1);
    expect(await readTodos(remoteDataDir)).toHaveLength(1);
    expect(await readBackup(localDataDir)).toBeUndefined();
    expect(await readBackup(remoteDataDir)).toBeUndefined();
  });

  it('is idempotent: reconciling an already-converged pair a second time adds nothing further', async () => {
    await writeJson(localDataDir, [{ id: 'a', summary: 'local only' }]);
    await writeJson(remoteDataDir, [{ id: 'b', summary: 'remote only' }]);

    await reconcileProject(PROJECT, optionsFor(false));
    const second = await reconcileProject(PROJECT, optionsFor(false));

    expect(second.counts).toEqual({
      'local-only': 0,
      'remote-only': 0,
      identical: 2,
      'divergent-unclocked': 0,
    });
    expect(await readTodos(localDataDir)).toHaveLength(2);
    expect(await readTodos(remoteDataDir)).toHaveLength(2);
  });

  it('automated 7 (convergence analogue): 200 interleaved local/remote-only rows converge to byte-identical state', async () => {
    const local: TodoItem[] = [];
    const remote: TodoItem[] = [];
    for (let i = 0; i < 100; i++) local.push({ id: `l${i}`, summary: `local row ${i}` });
    for (let i = 0; i < 100; i++) remote.push({ id: `r${i}`, summary: `remote row ${i}` });
    await writeJson(localDataDir, local);
    await writeJson(remoteDataDir, remote);

    const report = await reconcileProject(PROJECT, optionsFor(false));

    expect(report.counts['local-only']).toBe(100);
    expect(report.counts['remote-only']).toBe(100);

    const localAfter = await readTodos(localDataDir);
    const remoteAfter = await readTodos(remoteDataDir);
    const sortById = (items: TodoItem[]) => [...items].sort((a, b) => a.id.localeCompare(b.id));
    expect(sortById(localAfter)).toEqual(sortById(remoteAfter));
    expect(localAfter).toHaveLength(200);
  });

  it('automated 8 (partition analogue): writes made while unreconciled are visible on the OTHER side afterwards', async () => {
    // "Link down": nothing calls reconcile while both sides accept local writes independently.
    await writeJson(localDataDir, [{ id: 'during-partition-local', summary: 'written while apart' }]);
    await writeJson(remoteDataDir, [{ id: 'during-partition-remote', summary: 'written while apart' }]);

    // "Reconnect": the outbox drains via a reconcile pass.
    const report = await reconcileProject(PROJECT, optionsFor(false));
    expect(report.counts['local-only']).toBe(1);
    expect(report.counts['remote-only']).toBe(1);

    // The thing actually asked for: each write is visible on the OTHER side, not just "it
    // converged locally".
    const localAfter = await readTodos(localDataDir);
    const remoteAfter = await readTodos(remoteDataDir);
    expect(localAfter.map((t) => t.id)).toContain('during-partition-remote');
    expect(remoteAfter.map((t) => t.id)).toContain('during-partition-local');
  });

  it(
    'regression: appendLocalTodos must not deadlock when local gains an id-less entry mid-pass (PLAN "Found during implementation" row)',
    async () => {
      // Floor: prove the pre-state before acting, so this cannot pass vacuously.
      await writeJson(localDataDir, []);
      await writeJson(remoteDataDir, [{ id: 'r1', summary: 'remote only' }]);
      expect(await readTodos(localDataDir)).toEqual([]);
      expect((await readTodos(remoteDataDir)).map((t) => t.id)).toEqual(['r1']);

      // A transport whose `backup()` — called after the initial classification read and BEFORE
      // reconcile copies remote-only rows onto local — writes a fresh id-LESS entry onto the
      // LOCAL side. This is the real-world trigger: a raw agent append (`CEZ_TODOS_FILE`) landing
      // on this node's todos.json during a reconcile pass. `readTodos` reports `needsRewrite` for
      // that shape, which is exactly the condition `appendLocalTodos`'s own inner `readTodos` call
      // deadlocks on while it still holds the outer lease.
      const transport: RemoteReconcileTransport = {
        listProjects: async () => [PROJECT],
        list: async () => readTodos(remoteDataDir),
        backup: async () => {
          await fsp.writeFile(
            todosPath(localDataDir),
            JSON.stringify([{ summary: 'raw agent append landed mid-pass' }], null, 2),
            'utf8',
          );
          const file = todosPath(remoteDataDir);
          const backupFile = `${file}.bak`;
          let raw: string;
          try {
            raw = await fsp.readFile(file, 'utf8');
          } catch {
            raw = '[]';
          }
          await fsp.mkdir(remoteDataDir, { recursive: true });
          await fsp.writeFile(backupFile, raw, 'utf8');
          return backupFile;
        },
        apply: async () => undefined,
      };

      const options: ReconcileOptions = {
        dryRun: false,
        peerNodeId: 'peer-1',
        resolveLocalDataDir: () => localDataDir,
        remote: transport,
      };

      const startedAt = Date.now();
      await reconcileProject(PROJECT, options);
      const elapsedMs = Date.now() - startedAt;

      // The deadlock stalls for the full 5s lease timeout before the swallowed throw lets this
      // continue; a correct append completes in milliseconds.
      expect(elapsedMs).toBeLessThan(2_000);

      // And the id the caller was handed ('r1') is the id that actually lands in the file.
      const localAfter = await readTodos(localDataDir);
      expect(localAfter.map((t) => t.id)).toContain('r1');
    },
    10_000,
  );
});

describe('reconcileAll', () => {
  let roots: string[];

  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  it('reports one entry per paired project', async () => {
    const rootLocalA = mkdtempSync(join(tmpdir(), 'cez-reconcile-all-local-a-'));
    const rootLocalB = mkdtempSync(join(tmpdir(), 'cez-reconcile-all-local-b-'));
    const rootRemoteA = mkdtempSync(join(tmpdir(), 'cez-reconcile-all-remote-a-'));
    const rootRemoteB = mkdtempSync(join(tmpdir(), 'cez-reconcile-all-remote-b-'));
    roots = [rootLocalA, rootLocalB, rootRemoteA, rootRemoteB];
    const localA = join(rootLocalA, '.ai/cezar');
    const localB = join(rootLocalB, '.ai/cezar');
    const remoteA = join(rootRemoteA, '.ai/cezar');
    const remoteB = join(rootRemoteB, '.ai/cezar');

    await writeJson(localA, [{ id: 'a1', summary: 'in project a' }]);
    await writeJson(remoteA, []);
    await writeJson(localB, []);
    await writeJson(remoteB, [{ id: 'b1', summary: 'in project b' }]);

    const localDirs: Record<string, string> = { 'proj-a': localA, 'proj-b': localB };
    const options: ReconcileOptions = {
      dryRun: true,
      peerNodeId: 'peer-1',
      resolveLocalDataDir: (projectKey) => localDirs[projectKey] as string,
      remote: makeDirTransport(
        new Map([
          ['proj-a', remoteA],
          ['proj-b', remoteB],
        ]),
      ),
    };

    const reports = await reconcileAll(options);
    expect(reports.map((r) => r.projectKey).sort()).toEqual(['proj-a', 'proj-b']);
    const byKey = Object.fromEntries(reports.map((r) => [r.projectKey, r]));
    expect(byKey['proj-a']?.counts['local-only']).toBe(1);
    expect(byKey['proj-b']?.counts['remote-only']).toBe(1);
  });

  it('one project failing does not abort the others', async () => {
    const rootOkLocal = mkdtempSync(join(tmpdir(), 'cez-reconcile-all-ok-local-'));
    const rootOkRemote = mkdtempSync(join(tmpdir(), 'cez-reconcile-all-ok-remote-'));
    roots = [rootOkLocal, rootOkRemote];
    const okLocal = join(rootOkLocal, '.ai/cezar');
    const okRemote = join(rootOkRemote, '.ai/cezar');
    await writeJson(okLocal, [{ id: 'ok1', summary: 'fine' }]);
    await writeJson(okRemote, []);

    const warnings: string[] = [];
    const options: ReconcileOptions = {
      dryRun: true,
      peerNodeId: 'peer-1',
      warn: (m) => warnings.push(m),
      resolveLocalDataDir: (projectKey) => (projectKey === 'ok' ? okLocal : '/does/not/matter'),
      remote: {
        listProjects: async () => ['broken', 'ok'],
        list: async (projectKey) => {
          if (projectKey === 'broken') throw new Error('peer unreachable');
          return readTodos(okRemote);
        },
        backup: async () => 'unused',
        apply: async () => undefined,
      },
    };

    const reports = await reconcileAll(options);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.projectKey).toBe('ok');
    expect(warnings.some((w) => w.includes('broken'))).toBe(true);
  });
});

describe('startPeriodicReconcile', () => {
  // Real, short timers + polling here rather than fake timers: `startPeriodicReconcile`'s boot
  // pass runs OUTSIDE the timer system (a bare promise chain, not a `setTimeout`), and the pass
  // itself does real filesystem I/O (`reconcileProject`) that fake timers do not, and must not,
  // control. `waitFor` mirrors `todo-autostart.test.ts`'s own polling idiom for the same reason.

  it('negative control: recovers on the SCHEDULED tick with no watcher wired at all (E7 shape)', async () => {
    const localRoot = mkdtempSync(join(tmpdir(), 'cez-periodic-local-'));
    const remoteRoot = mkdtempSync(join(tmpdir(), 'cez-periodic-remote-'));
    const localDataDir = join(localRoot, '.ai/cezar');
    const remoteDataDir = join(remoteRoot, '.ai/cezar');
    try {
      await writeJson(localDataDir, []);
      await writeJson(remoteDataDir, []);

      const run = vi.fn(async () => {
        await reconcileProject(PROJECT, {
          dryRun: false,
          peerNodeId: 'peer-1',
          resolveLocalDataDir: () => localDataDir,
          remote: makeDirTransport(new Map([[PROJECT, remoteDataDir]])),
        });
      });
      const onSuccess = vi.fn();

      const stop = startPeriodicReconcile({ intervalMs: 200, run, onSuccess });
      await waitFor(() => expect(run).toHaveBeenCalledTimes(1)); // the boot pass — nothing to reconcile yet

      // Simulate "asleep with pending ops on both sides": no watcher of any kind is ever wired up
      // in this test — the only thing that can pick this up is the scheduled interval.
      await writeJson(localDataDir, [{ id: 'while-asleep', summary: 'written during the gap' }]);

      // The boot pass alone cannot explain a call 2 — only the SCHEDULED tick, ~200ms later, can.
      await waitFor(() => expect(run.mock.calls.length).toBeGreaterThanOrEqual(2));
      await waitFor(() => expect(onSuccess.mock.calls.length).toBeGreaterThanOrEqual(2));

      const remoteAfter = await readTodos(remoteDataDir);
      expect(remoteAfter.map((t) => t.id)).toContain('while-asleep');

      stop();
      const callsAtStop = run.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(run.mock.calls.length).toBe(callsAtStop); // stop() actually stops scheduling
    } finally {
      rmSync(localRoot, { recursive: true, force: true });
      rmSync(remoteRoot, { recursive: true, force: true });
    }
  });

  it('never runs two passes concurrently', async () => {
    vi.useFakeTimers();
    try {
      let inFlight = 0;
      let maxInFlight = 0;
      const run = vi.fn(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5_000)); // slower than the interval below
        inFlight--;
      });

      const stop = startPeriodicReconcile({ intervalMs: 1_000, run });
      await vi.advanceTimersByTimeAsync(30_000);
      stop();

      expect(maxInFlight).toBe(1);
      expect(run.mock.calls.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stamps onSuccess only when run resolves, never when it throws', async () => {
    let calls = 0;
    const run = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('boom');
    });
    const onSuccess = vi.fn();
    const warnings: string[] = [];

    const stop = startPeriodicReconcile({ intervalMs: 200, run, onSuccess, warn: (m) => warnings.push(m) });
    await waitFor(() => expect(warnings).toHaveLength(1)); // boot pass: throws
    expect(onSuccess).not.toHaveBeenCalled();

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1)); // next tick: succeeds

    stop();
  });
});
