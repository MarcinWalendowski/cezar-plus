import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clusterRemoteRunSchema, type ClusterRemoteRun } from '@loki-labs/better-cezar-contract';
import { RunStore } from '../runs/store.ts';
import { localCliAuthor } from '../runs/task-author.ts';
import {
  ClusterRunProjectionObserver,
  applyRemoteRuns,
  markNodeUnreachable,
  projectRun,
  readRemoteRuns,
  readRemoteRunsFile,
  remoteRunsPath,
  watchRunProjection,
  type ClusterRunProjectionSink,
} from './run-projection.ts';

function recordingSink(): ClusterRunProjectionSink & {
  published: ClusterRemoteRun[];
  removed: string[];
} {
  const published: ClusterRemoteRun[] = [];
  const removed: string[] = [];
  return {
    published,
    removed,
    publish: (run) => {
      published.push(run);
    },
    remove: (runId) => {
      removed.push(runId);
    },
  };
}

/** The arrival stamp of the frame that carried the rows. A fixed literal, never `new Date()`:
 *  `reportedAt` is a claim about when a node SPOKE, so a test that lets the clock supply it can
 *  only ever prove the clock moved. */
const AT = '2026-08-22T11:04:00.000Z';

/** A ready-to-write `ClusterRemoteRun` row, for tests that exercise the on-disk file directly
 *  rather than through `projectRun`. */
function remoteRun(overrides: Partial<ClusterRemoteRun> = {}): ClusterRemoteRun {
  return {
    projectId: 'proj-1',
    nodeId: 'node-a',
    id: 'run-1',
    title: 'a run',
    status: 'running',
    createdAt: '2026-08-22T00:00:00.000Z',
    archived: false,
    workflow: 'w',
    ...overrides,
  };
}

describe('cluster/run-projection: projectRun', () => {
  let root: string;
  let store: RunStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-run-projection-pure-'));
    store = RunStore.open(join(root, '.ai/cezar'));
  });

  afterEach(() => {
    store.flush();
    store.removeAllListeners();
    rmSync(root, { recursive: true, force: true });
  });

  it('maps the required fields and stamps nodeId/projectId, validating against the strict wire schema', () => {
    const run = store.createRun({
      author: localCliAuthor(),
      title: 'a task',
      workflow: 'default',
      task: 'do the thing',
      steps: [],
    });
    const projected = projectRun(store.getRun(run.id)!, { id: 'proj-1' }, 'node-a');
    expect(() => clusterRemoteRunSchema.parse(projected)).not.toThrow();
    expect(projected.projectId).toBe('proj-1');
    expect(projected.nodeId).toBe('node-a');
    expect(projected.id).toBe(run.id);
    expect(projected.title).toBe('a task');
    expect(projected.status).toBe('queued');
    expect(projected.workflow).toBe('default');
    expect(projected.archived).toBe(false);
  });

  it('carries projectKey only when the project has one', () => {
    const run = store.createRun({
      author: localCliAuthor(),
      title: 'a task',
      workflow: 'default',
      task: 't',
      steps: [],
    });
    const withKey = projectRun(store.getRun(run.id)!, { id: 'proj-1', projectKey: 'pk-1' }, 'node-a');
    expect(withKey.projectKey).toBe('pk-1');
    const withoutKey = projectRun(store.getRun(run.id)!, { id: 'proj-1' }, 'node-a');
    expect(withoutKey).not.toHaveProperty('projectKey');
  });

  it('never carries a local-machine field — the strict schema is the backstop', () => {
    const run = store.createRun({
      author: localCliAuthor(),
      title: 'a task',
      workflow: 'default',
      task: 't',
      steps: [],
    });
    const projected = projectRun(store.getRun(run.id)!, { id: 'proj-1' }, 'node-a') as Record<string, unknown>;
    expect(projected.worktreePath).toBeUndefined();
    expect(projected.sessionId).toBeUndefined();
    expect(projected.spoolDir).toBeUndefined();
    // `.strict()` throws on any key the schema does not declare, which is the structural version
    // of the same assertion — belt and suspenders.
    expect(() => clusterRemoteRunSchema.parse({ ...projected, worktreePath: '/Users/x/repo' })).toThrow();
  });
});

describe('cluster/run-projection: watchRunProjection', () => {
  let root: string;
  let store: RunStore;
  const unwatchers: Array<() => void> = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-run-projection-observer-'));
    store = RunStore.open(join(root, '.ai/cezar'));
  });

  afterEach(() => {
    for (const unwatch of unwatchers.splice(0)) unwatch();
    store.flush();
    store.removeAllListeners();
    rmSync(root, { recursive: true, force: true });
  });

  it('a context built before the observer was registered is still covered', () => {
    // The run exists BEFORE `watchRunProjection` is ever called — the boot-context case: a store
    // opened (and loaded from disk) ahead of `onContextBuilt` firing. A test that registers first
    // and creates the store after cannot see this gap (see the module doc on `watchRunProjection`).
    const run = store.createRun({
      author: localCliAuthor(),
      title: 'pre-existing',
      workflow: 'w',
      task: 't',
      steps: [],
    });
    const sink = recordingSink();
    unwatchers.push(watchRunProjection(store, sink, { id: 'proj-1' }, { nodeId: 'node-a' }));
    expect(sink.published.map((r) => r.id)).toContain(run.id);
    expect(sink.published.find((r) => r.id === run.id)?.status).toBe('queued');
  });

  it('a later run touch after the initial sync republishes', () => {
    const run = store.createRun({
      author: localCliAuthor(),
      title: 'will change',
      workflow: 'w',
      task: 't',
      steps: [],
    });
    const sink = recordingSink();
    unwatchers.push(watchRunProjection(store, sink, { id: 'proj-1' }, { nodeId: 'node-a' }));
    const beforeCount = sink.published.filter((r) => r.id === run.id).length;
    store.updateRun(run.id, { status: 'running' });
    const after = sink.published.filter((r) => r.id === run.id);
    expect(after.length).toBeGreaterThan(beforeCount);
    expect(after.at(-1)?.status).toBe('running');
  });

  it('deleted is honoured — a removed run leaves the projection rather than lingering', () => {
    const run = store.createRun({
      author: localCliAuthor(),
      title: 'to delete',
      workflow: 'w',
      task: 't',
      steps: [],
    });
    const sink = recordingSink();
    unwatchers.push(watchRunProjection(store, sink, { id: 'proj-1' }, { nodeId: 'node-a' }));
    store.deleteRun(run.id);
    expect(sink.removed).toContain(run.id);
  });

  it('does not mutate the store', () => {
    const run = store.createRun({
      author: localCliAuthor(),
      title: 'stable',
      workflow: 'w',
      task: 't',
      steps: [],
    });
    const before = JSON.parse(JSON.stringify(store.getRun(run.id)));
    const sink = recordingSink();
    // The initial sync is where a projection would be most tempted to stamp something back onto
    // the record it just read — assert the store is byte-identical right after that pass runs.
    unwatchers.push(watchRunProjection(store, sink, { id: 'proj-1' }, { nodeId: 'node-a' }));
    const after = store.getRun(run.id);
    expect(after).toEqual(before);
  });

  it('returns an unsubscribe that stops all future delivery', () => {
    const run = store.createRun({
      author: localCliAuthor(),
      title: 'will unsubscribe',
      workflow: 'w',
      task: 't',
      steps: [],
    });
    const sink = recordingSink();
    const unwatch = watchRunProjection(store, sink, { id: 'proj-1' }, { nodeId: 'node-a' });
    const countAfterSync = sink.published.length;
    unwatch();
    store.updateRun(run.id, { status: 'running' });
    store.deleteRun(run.id);
    expect(sink.published).toHaveLength(countAfterSync);
    expect(sink.removed).toHaveLength(0);
  });
});

describe('cluster/run-projection: ClusterRunProjectionObserver (WeakSet dedupe)', () => {
  let root: string;
  let store: RunStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-run-projection-dedupe-'));
    store = RunStore.open(join(root, '.ai/cezar'));
  });

  afterEach(() => {
    store.flush();
    store.removeAllListeners();
    rmSync(root, { recursive: true, force: true });
  });

  it('watching the same store twice yields exactly one initial sync', () => {
    const run = store.createRun({
      author: localCliAuthor(),
      title: 'deduped',
      workflow: 'w',
      task: 't',
      steps: [],
    });
    const sink = recordingSink();
    const observer = new ClusterRunProjectionObserver(sink, { nodeId: 'node-a' });
    observer.watch(store, { id: 'proj-1' });
    observer.watch(store, { id: 'proj-1' });
    expect(sink.published.filter((r) => r.id === run.id)).toHaveLength(1);
  });

  it('watching two different stores yields one listener each, tagged with the SAME node id', () => {
    const otherRoot = mkdtempSync(join(tmpdir(), 'cez-run-projection-dedupe-2-'));
    const otherStore = RunStore.open(join(otherRoot, '.ai/cezar'));
    try {
      const sink = recordingSink();
      const observer = new ClusterRunProjectionObserver(sink, { nodeId: 'node-a' });
      const runA = store.createRun({ author: localCliAuthor(), title: 'a', workflow: 'w', task: 't', steps: [] });
      const runB = otherStore.createRun({ author: localCliAuthor(), title: 'b', workflow: 'w', task: 't', steps: [] });

      observer.watch(store, { id: 'proj-a' });
      observer.watch(otherStore, { id: 'proj-b' });

      const byId = new Map(sink.published.map((r) => [r.id, r]));
      expect(byId.get(runA.id)?.projectId).toBe('proj-a');
      expect(byId.get(runB.id)?.projectId).toBe('proj-b');
      expect(byId.get(runA.id)?.nodeId).toBe('node-a');
      expect(byId.get(runB.id)?.nodeId).toBe('node-a');
    } finally {
      otherStore.flush();
      otherStore.removeAllListeners();
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });
});

describe('cluster/run-projection: remoteRunsPath', () => {
  it('resolves under <CEZ_HOME>/cluster/runs-remote.json', () => {
    expect(remoteRunsPath({ CEZ_HOME: '/tmp/xyz-home' })).toBe(join('/tmp/xyz-home', 'cluster', 'runs-remote.json'));
  });
});

describe('cluster/run-projection: readRemoteRuns / applyRemoteRuns / markNodeUnreachable', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-run-projection-disk-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('a missing file reads as empty', async () => {
    const rows = await readRemoteRuns({ env: { CEZ_HOME: root } });
    expect(rows).toEqual([]);
  });

  it('round-trips through applyRemoteRuns', async () => {
    const options = { env: { CEZ_HOME: root } };
    await applyRemoteRuns('node-a', [remoteRun({ id: 'r1' }), remoteRun({ id: 'r2' })], AT, options);
    const rows = await readRemoteRuns(options);
    expect(rows.map((r) => r.id).sort()).toEqual(['r1', 'r2']);
  });

  it("replaces one node's rows wholesale — never merges — and leaves other nodes untouched", async () => {
    const options = { env: { CEZ_HOME: root } };
    await applyRemoteRuns('node-a', [remoteRun({ id: 'a1' }), remoteRun({ id: 'a2' })], AT, options);
    await applyRemoteRuns('node-b', [remoteRun({ id: 'b1', nodeId: 'node-b' })], AT, options);
    // Re-push node-a with a DIFFERENT single row — a1/a2 must be gone, not merged with this push.
    await applyRemoteRuns('node-a', [remoteRun({ id: 'a3' })], AT, options);
    const rows = await readRemoteRuns(options);
    expect(rows.map((r) => r.id).sort()).toEqual(['a3', 'b1']);
    expect(rows.find((r) => r.id === 'b1')?.nodeId).toBe('node-b');
  });

  it('corrupt JSON degrades to empty with one warning, never a throw', async () => {
    mkdirSync(join(root, 'cluster'), { recursive: true });
    writeFileSync(join(root, 'cluster', 'runs-remote.json'), '{ not json');
    const warn = vi.fn();
    const rows = await readRemoteRuns({ env: { CEZ_HOME: root }, warn });
    expect(rows).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('per-entry salvage: a malformed row is skipped, a good sibling survives', async () => {
    mkdirSync(join(root, 'cluster'), { recursive: true });
    const good = remoteRun({ id: 'good' });
    writeFileSync(
      join(root, 'cluster', 'runs-remote.json'),
      JSON.stringify({ runs: [good, { id: 'bad-missing-required-fields' }] }),
    );
    const warn = vi.fn();
    const rows = await readRemoteRuns({ env: { CEZ_HOME: root }, warn });
    expect(rows.map((r) => r.id)).toEqual(['good']);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('marks only the live rows of the named node unreachable', async () => {
    const options = { env: { CEZ_HOME: root } };
    await applyRemoteRuns(
      'node-a',
      [
        remoteRun({ id: 'live-running', status: 'running' }),
        remoteRun({ id: 'live-queued', status: 'queued' }),
        remoteRun({ id: 'finished', status: 'done' }),
      ],
      AT,
      options,
    );
    await applyRemoteRuns('node-b', [remoteRun({ id: 'other', nodeId: 'node-b', status: 'running' })], AT, options);

    const at = new Date('2026-08-22T12:00:00.000Z');
    const changed = await markNodeUnreachable('node-a', at, options);
    expect(changed).toBe(2);

    const rows = await readRemoteRuns(options);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get('live-running')?.unreachable).toBe(true);
    expect(byId.get('live-running')?.unreachableSince).toBe(at.toISOString());
    expect(byId.get('live-queued')?.unreachable).toBe(true);
    // A finished run's truth does not change because the node went quiet.
    expect(byId.get('finished')?.unreachable).toBeUndefined();
    // A different node's rows are never touched by this call.
    expect(byId.get('other')?.unreachable).toBeUndefined();
  });

  it('is idempotent: a second call touches nothing and preserves the first unreachableSince', async () => {
    const options = { env: { CEZ_HOME: root } };
    await applyRemoteRuns('node-a', [remoteRun({ id: 'r1', status: 'running' })], AT, options);
    const first = new Date('2026-08-22T12:00:00.000Z');
    expect(await markNodeUnreachable('node-a', first, options)).toBe(1);
    const second = new Date('2026-08-22T13:00:00.000Z');
    expect(await markNodeUnreachable('node-a', second, options)).toBe(0);
    const rows = await readRemoteRuns(options);
    expect(rows.find((r) => r.id === 'r1')?.unreachableSince).toBe(first.toISOString());
  });
});

describe('cluster/run-projection: applyRemoteRuns concurrency', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-run-projection-race-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('two nodes reporting at once — neither loses its rows', async () => {
    const options = { env: { CEZ_HOME: root } };
    // The first call is deliberately NOT awaited: node-b enters while node-a is still suspended
    // on the `await readFile` inside `readRemoteRuns`, so node-b's `existing` predates node-a's
    // write and its `kept` filter drops rows that are already on disk.
    //
    // This fixture is two-node ON PURPOSE. With a single node "replace the whole file" and
    // "replace that node's rows" are the same operation, so a one-node version of this test
    // cannot fail no matter how broken the read-modify-write is.
    const a = applyRemoteRuns('node-a', [remoteRun({ id: 'a1' }), remoteRun({ id: 'a2' })], AT, options);
    const b = applyRemoteRuns('node-b', [remoteRun({ id: 'b1', nodeId: 'node-b' })], AT, options);
    await Promise.all([a, b]);

    const rows = await readRemoteRuns(options);
    expect(rows.map((r) => r.id).sort()).toEqual(['a1', 'a2', 'b1']);
  });

  it('a bystander node already on disk survives two concurrent reports', async () => {
    const options = { env: { CEZ_HOME: root } };
    await applyRemoteRuns('node-c', [remoteRun({ id: 'c1', nodeId: 'node-c' })], AT, options);

    const a = applyRemoteRuns('node-a', [remoteRun({ id: 'a1' })], AT, options);
    const b = applyRemoteRuns('node-b', [remoteRun({ id: 'b1', nodeId: 'node-b' })], AT, options);
    await Promise.all([a, b]);

    const rows = await readRemoteRuns(options);
    expect(rows.map((r) => r.id).sort()).toEqual(['a1', 'b1', 'c1']);
  });

  it('markNodeUnreachable interleaved with a report does not lose the report', async () => {
    const options = { env: { CEZ_HOME: root } };
    await applyRemoteRuns('node-a', [remoteRun({ id: 'a1', status: 'running' })], AT, options);

    // Same hazard, different pair of writers: both read-modify-write the one file.
    const mark = markNodeUnreachable('node-a', new Date('2026-08-22T12:00:00.000Z'), options);
    const report = applyRemoteRuns('node-b', [remoteRun({ id: 'b1', nodeId: 'node-b' })], AT, options);
    await Promise.all([mark, report]);

    const rows = await readRemoteRuns(options);
    expect(rows.map((r) => r.id).sort()).toEqual(['a1', 'b1']);
    // The id set alone is not the assertion that matters: `markNodeUnreachable` reported it
    // touched a row, and without serialisation the report's write puts the pre-mark `a1` straight
    // back — a call that returned 1 whose effect vanished.
    expect(rows.find((r) => r.id === 'a1')?.unreachable).toBe(true);
  });
});

describe('cluster/run-projection: the per-node report envelope', () => {
  let root: string;
  const LATER = '2026-08-22T11:09:00.000Z';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-run-projection-envelope-'));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  });

  it('tells "never reported" apart from "reported and had nothing"', async () => {
    const options = { env: { CEZ_HOME: root } };
    await applyRemoteRuns('node-idle', [], AT, options);
    await applyRemoteRuns('node-busy', [remoteRun({ id: 'r1', nodeId: 'node-busy' })], AT, options);
    const file = await readRemoteRunsFile(options);

    const observe = (nodeId: string) => ({
      rows: file.runs.filter((r) => r.nodeId === nodeId),
      report: file.nodes[nodeId],
    });
    const untracked = observe('node-silent');
    const reportedIdle = observe('node-idle');

    // The half the old file could see is IDENTICAL for the two — that is the defect, stated as an
    // assertion. What separates them is the envelope, and nothing else.
    expect(untracked.rows).toEqual(reportedIdle.rows);
    expect(untracked).not.toEqual(reportedIdle);

    expect(untracked.report).toBeUndefined();
    expect(reportedIdle.report).toEqual({ reportedAt: AT });
    expect(observe('node-busy').report).toEqual({ reportedAt: AT });
  });

  it('stamps the reportedAt it was GIVEN, never the clock it was written at', async () => {
    const options = { env: { CEZ_HOME: root } };
    // Frozen, and deliberately far from `AT`. An implementation that computed this field itself
    // would stamp the frozen now; asserting mere INEQUALITY between two reports would not catch
    // it, because two `new Date()` calls a millisecond apart differ too — that is green for
    // jitter, not for honesty. So this asserts the exact string.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-23T23:59:00.000Z'));
    await applyRemoteRuns('node-a', [remoteRun({ id: 'a1' })], AT, options);
    const file = await readRemoteRunsFile(options);
    expect(file.nodes['node-a']?.reportedAt).toBe(AT);
    expect(file.nodes['node-a']?.reportedAt).not.toBe(new Date().toISOString());
  });

  it('a node that reports nothing after being busy keeps its entry — rows go, the report stays', async () => {
    const options = { env: { CEZ_HOME: root } };
    await applyRemoteRuns('node-a', [remoteRun({ id: 'a1' })], AT, options);
    await applyRemoteRuns('node-a', [], LATER, options);
    const file = await readRemoteRunsFile(options);
    expect(file.runs).toEqual([]);
    // Pruning the entry here would collapse "reported, and had nothing" back into "never heard
    // from" — the exact state this field exists to keep apart.
    expect(file.nodes['node-a']).toEqual({ reportedAt: LATER });
  });

  it('each node carries its own stamp — one node reporting does not refresh another', async () => {
    const options = { env: { CEZ_HOME: root } };
    await applyRemoteRuns('node-a', [remoteRun({ id: 'a1' })], AT, options);
    await applyRemoteRuns('node-b', [remoteRun({ id: 'b1', nodeId: 'node-b' })], LATER, options);
    const file = await readRemoteRunsFile(options);
    expect(file.nodes).toEqual({ 'node-a': { reportedAt: AT }, 'node-b': { reportedAt: LATER } });
  });

  it('markNodeUnreachable leaves the envelope alone, stale stamp and all', async () => {
    const options = { env: { CEZ_HOME: root } };
    await applyRemoteRuns('node-a', [remoteRun({ id: 'a1', status: 'running' })], AT, options);
    expect(await markNodeUnreachable('node-a', new Date('2026-08-22T12:00:00.000Z'), options)).toBe(1);
    const file = await readRemoteRunsFile(options);
    // Refreshing it here would claim the node just spoke; clearing it would erase the only record
    // that it ever did. The staleness is what makes the unreachable row readable as history.
    expect(file.nodes['node-a']).toEqual({ reportedAt: AT });
    expect(file.runs.find((r) => r.id === 'a1')?.unreachable).toBe(true);
  });

  it('a file written before the envelope existed reads as "no node heard from", silently', async () => {
    mkdirSync(join(root, 'cluster'), { recursive: true });
    writeFileSync(join(root, 'cluster', 'runs-remote.json'), JSON.stringify({ runs: [remoteRun({ id: 'a1' })] }));
    const warn = vi.fn();
    const file = await readRemoteRunsFile({ env: { CEZ_HOME: root }, warn });
    expect(file.runs.map((r) => r.id)).toEqual(['a1']);
    // Never synthesised from the rows: a row's presence says nothing about WHEN it arrived.
    expect(file.nodes).toEqual({});
    expect(warn).not.toHaveBeenCalled();
  });

  it('per-node salvage: a malformed report is skipped, a good sibling survives', async () => {
    mkdirSync(join(root, 'cluster'), { recursive: true });
    writeFileSync(
      join(root, 'cluster', 'runs-remote.json'),
      JSON.stringify({ runs: [], nodes: { 'node-a': { reportedAt: AT }, 'node-b': { reportedAt: 7 } } }),
    );
    const warn = vi.fn();
    const file = await readRemoteRunsFile({ env: { CEZ_HOME: root }, warn });
    expect(file.nodes).toEqual({ 'node-a': { reportedAt: AT } });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a non-object nodes envelope degrades to empty with one warning, never a throw', async () => {
    mkdirSync(join(root, 'cluster'), { recursive: true });
    writeFileSync(join(root, 'cluster', 'runs-remote.json'), JSON.stringify({ runs: [], nodes: ['node-a'] }));
    const warn = vi.fn();
    const file = await readRemoteRunsFile({ env: { CEZ_HOME: root }, warn });
    expect(file.nodes).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("a newer node's extra report field survives this node's read (D13 passthrough)", async () => {
    mkdirSync(join(root, 'cluster'), { recursive: true });
    writeFileSync(
      join(root, 'cluster', 'runs-remote.json'),
      JSON.stringify({ runs: [], nodes: { 'node-a': { reportedAt: AT, cezarVersion: '0.99.0' } } }),
    );
    const warn = vi.fn();
    const file = await readRemoteRunsFile({ env: { CEZ_HOME: root }, warn });
    expect(file.nodes['node-a']).toEqual({ reportedAt: AT, cezarVersion: '0.99.0' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('readRemoteRuns still answers rows only — the envelope is not smuggled into the runs list', async () => {
    const options = { env: { CEZ_HOME: root } };
    await applyRemoteRuns('node-a', [remoteRun({ id: 'a1' })], AT, options);
    const rows = await readRemoteRuns(options);
    expect(rows.map((r) => r.id)).toEqual(['a1']);
    expect(rows.every((r) => !('reportedAt' in r))).toBe(true);
  });
});
