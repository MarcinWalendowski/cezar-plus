import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLUSTER_OPS_PER_FRAME_MAX,
  type ClusterNodeId,
  type ClusterOp,
  type ClusterProjectKey,
  type ClusterReplicaFrame,
  type StoredClusterNodeIdentity,
} from '@loki-labs/cezar-plus-contract';
import type { TodoItem } from '../todos.ts';
import type { HubOpOutcome } from './hub-ops.ts';
import {
  runHubOutboxTick,
  startHubOutbox,
  type HubOutboxDeps,
  type HubOutboxProject,
  type HubOutboxTickDeps,
} from './hub-outbox.ts';

/**
 * `cluster/hub-outbox.ts` — the hub's own write outbox (D37). Every dep that would otherwise touch
 * disk or a socket is faked here: `readTodos`/`applyOp`/`allocateSeq` against an in-memory store,
 * `connectedNodes`/`readWatermark`/`advanceWatermark`/`sendTo` against an in-memory link. No real fs,
 * no real network, no real timers (fake timers throughout).
 */

// ---- fixtures -------------------------------------------------------------------------------------

function todo(id: string, extra: Partial<TodoItem> = {}): TodoItem {
  return { id, summary: `todo ${id}`, ...extra };
}

/** The exact shape a CLI write produces when clustering is off at write time (`todos.ts#stampPending`
 *  returns early) — the 157-of-159 backfill population D37 names. Neither marker at all. */
function cliBackfillTodo(id: string, extra: Partial<TodoItem> = {}): TodoItem {
  return todo(id, { pendingSince: undefined, pendingFields: undefined, hubSeq: undefined, ...extra });
}

function fullySettledTodo(id: string, hubSeq: number, extra: Partial<TodoItem> = {}): TodoItem {
  return todo(id, { hubSeq, pendingSince: undefined, pendingFields: undefined, ...extra });
}

function pendingTodo(id: string, extra: Partial<TodoItem> = {}): TodoItem {
  return todo(id, { pendingSince: '2026-08-24T00:00:00.000Z', pendingFields: ['summary'], ...extra });
}

// ---- fakes ----------------------------------------------------------------------------------------

class FakeHubStore {
  private byDataDir = new Map<string, TodoItem[]>();

  seed(dataDir: string, rows: TodoItem[]): void {
    this.byDataDir.set(dataDir, rows.map((r) => ({ ...r })));
  }

  rows(dataDir: string): TodoItem[] {
    return this.byDataDir.get(dataDir) ?? [];
  }

  readTodos = async (dataDir: string): Promise<TodoItem[]> => this.rows(dataDir).map((r) => ({ ...r }));

  /** Mirrors `applyOpAtHub`'s observable contract closely enough for THIS file's own logic to be
   *  tested against — merge/tombstone, stamp `hubSeq`, clear `pendingSince`/`pendingFields`. Its own
   *  correctness (D9a claims, staleness ordering, corruption handling) is `hub-apply.test.ts`'s job,
   *  not this file's. */
  applyOp = vi.fn(async (dataDir: string, op: ClusterOp & { hubSeq: number }): Promise<HubOpOutcome> => {
    if (this.throwFor.has(op.opId)) throw new Error(`fake apply threw for ${op.opId}`);
    if (this.rejectFor.has(op.entityId)) return { accepted: false, reason: 'already-started' };

    const rows = this.byDataDir.get(dataDir) ?? [];
    const idx = rows.findIndex((r) => r.id === op.entityId);
    const existing = idx >= 0 ? rows[idx] : undefined;
    const next: TodoItem = existing ? { ...existing } : ({ id: op.entityId, summary: op.entityId } as TodoItem);

    if (op.op === 'tombstone') {
      next.tombstone = { at: new Date().toISOString() };
    } else {
      for (const [key, value] of Object.entries(op.fields ?? {})) {
        (next as Record<string, unknown>)[key] = value;
      }
      for (const key of op.clearedFields ?? []) {
        delete (next as Record<string, unknown>)[key];
      }
    }
    next.hubSeq = op.hubSeq;
    delete next.pendingSince;
    delete next.pendingFields;

    if (idx >= 0) rows[idx] = next;
    else rows.push(next);
    this.byDataDir.set(dataDir, rows);
    return { accepted: true };
  });

  rejectFor = new Set<string>();
  throwFor = new Set<string>();
}

function makeAllocator(seed: Record<string, number> = {}): HubOutboxTickDeps['allocateSeq'] {
  const counters = new Map<string, number>(Object.entries(seed));
  return async (input) => {
    const key = `${input.scope}:${input.projectKey ?? ''}`;
    const base = counters.get(key) ?? 0;
    if (input.count === 0) return { from: base + 1, to: base };
    const to = base + input.count;
    counters.set(key, to);
    return { from: base + 1, to };
  };
}

interface FakeLink {
  connectedNodes: () => readonly ClusterNodeId[];
  readWatermark: (nodeId: ClusterNodeId, projectKey: ClusterProjectKey) => number;
  advanceWatermark: (nodeId: ClusterNodeId, projectKey: ClusterProjectKey, hubSeq: number) => void;
  sendTo: (nodeId: ClusterNodeId, frame: ClusterReplicaFrame) => boolean;
  sent: { nodeId: ClusterNodeId; frame: ClusterReplicaFrame }[];
  watermarkOf: (nodeId: ClusterNodeId, projectKey: ClusterProjectKey) => number;
  failFor: Set<ClusterNodeId>;
}

function makeLink(connected: ClusterNodeId[] = ['node-a']): FakeLink {
  const watermarks = new Map<string, number>();
  const sent: { nodeId: ClusterNodeId; frame: ClusterReplicaFrame }[] = [];
  const failFor = new Set<ClusterNodeId>();
  const key = (nodeId: string, projectKey: string): string => `${nodeId}:${projectKey}`;
  return {
    connectedNodes: () => connected,
    readWatermark: (nodeId, projectKey) => watermarks.get(key(nodeId, projectKey)) ?? 0,
    advanceWatermark: (nodeId, projectKey, hubSeq) => watermarks.set(key(nodeId, projectKey), hubSeq),
    sendTo: (nodeId, frame) => {
      if (failFor.has(nodeId)) return false;
      sent.push({ nodeId, frame });
      return true;
    },
    sent,
    watermarkOf: (nodeId, projectKey) => watermarks.get(key(nodeId, projectKey)) ?? 0,
    failFor,
  };
}

const PROJECT: HubOutboxProject = { projectKey: 'proj-1', dataDir: '/fake/proj-1' };

function baseDeps(store: FakeHubStore, link: FakeLink, projects: HubOutboxProject[] = [PROJECT]): HubOutboxTickDeps {
  return {
    nodeId: 'hub-1',
    listProjects: () => projects,
    allocateSeq: makeAllocator(),
    readTodos: store.readTodos,
    applyOp: store.applyOp,
    connectedNodes: link.connectedNodes,
    readWatermark: link.readWatermark,
    advanceWatermark: link.advanceWatermark,
    sendTo: link.sendTo,
    now: () => new Date('2026-08-24T12:00:00.000Z'),
  };
}

function entityIdsIn(frame: ClusterReplicaFrame): string[] {
  return frame.changes.map((c) => c.entityId);
}

// ---- runHubOutboxTick -------------------------------------------------------------------------

describe('runHubOutboxTick — steady state', () => {
  it('a pending todo gets a hubSeq and appears in a fan-out plan; a fully-settled todo is NOT re-sent', async () => {
    const store = new FakeHubStore();
    const link = makeLink(['node-a']);
    store.seed(PROJECT.dataDir, [pendingTodo('A'), fullySettledTodo('B', 7)]);

    const report = await runHubOutboxTick(baseDeps(store, link));

    expect(report.opsApplied).toBe(1);
    expect(report.opsRejected).toBe(0);
    expect(report.opsFailed).toBe(0);
    expect(report.framesSent).toBe(1);
    expect(report.targetsReached).toBe(1);

    // Only A was applied — B was never even offered to applyOp.
    expect(store.applyOp).toHaveBeenCalledTimes(1);
    expect((store.applyOp.mock.calls[0]![1] as ClusterOp).entityId).toBe('A');

    const [rowA, rowB] = store.rows(PROJECT.dataDir);
    expect(rowA!.id).toBe('A');
    expect(rowA!.hubSeq).toBeGreaterThan(0);
    expect(rowA!.pendingSince).toBeUndefined();
    // B is byte-for-byte untouched.
    expect(rowB).toEqual(fullySettledTodo('B', 7));

    expect(link.sent).toHaveLength(1);
    expect(entityIdsIn(link.sent[0]!.frame)).toEqual(['A']);
  });

  it('a second tick over the same now-settled state sends nothing', async () => {
    const store = new FakeHubStore();
    const link = makeLink(['node-a']);
    store.seed(PROJECT.dataDir, [pendingTodo('A')]);
    const deps = baseDeps(store, link);

    await runHubOutboxTick(deps);
    store.applyOp.mockClear();
    link.sent.length = 0;

    const second = await runHubOutboxTick(deps);
    expect(second.opsApplied).toBe(0);
    expect(second.framesSent).toBe(0);
    expect(store.applyOp).not.toHaveBeenCalled();
  });
});

describe('runHubOutboxTick — the backfill population', () => {
  it('a CLI-created todo carrying NEITHER pendingSince NOR hubSeq is picked up', async () => {
    const store = new FakeHubStore();
    const link = makeLink(['node-a']);
    store.seed(PROJECT.dataDir, [cliBackfillTodo('CLI-1', { summary: 'filed over ssh, no CEZ_CLUSTER' })]);

    const report = await runHubOutboxTick(baseDeps(store, link));

    expect(report.opsApplied).toBe(1);
    const [row] = store.rows(PROJECT.dataDir);
    expect(row!.hubSeq).toBeGreaterThan(0);
    expect(row!.pendingSince).toBeUndefined();

    // pendingFields was undefined, so deriveTodoOps's "send everything" fallback fires — the whole
    // record's content rides the op, not nothing.
    expect(link.sent).toHaveLength(1);
    const op = link.sent[0]!.frame.changes[0]!;
    expect(op.entityId).toBe('CLI-1');
    expect(op.fields?.summary).toBe('filed over ssh, no CEZ_CLUSTER');
  });

  it('a mixed batch of 157 backfill + 2 genuinely-pending todos (the exact measured production shape) all replicate', async () => {
    const store = new FakeHubStore();
    const link = makeLink(['node-a']);
    const backfill = Array.from({ length: 157 }, (_, i) => cliBackfillTodo(`bf-${i}`));
    const pending = [pendingTodo('p-0'), pendingTodo('p-1')];
    store.seed(PROJECT.dataDir, [...backfill, ...pending]);

    const report = await runHubOutboxTick(baseDeps(store, link));

    expect(report.opsApplied).toBe(159);
    const rows = store.rows(PROJECT.dataDir);
    expect(rows.every((r) => typeof r.hubSeq === 'number' && r.hubSeq > 0)).toBe(true);
    expect(rows.every((r) => r.pendingSince === undefined)).toBe(true);
  });
});

describe('runHubOutboxTick — hubSeq ordering', () => {
  it('allocated hubSeq values are strictly increasing within a tick and across ticks', async () => {
    const store = new FakeHubStore();
    const link = makeLink(['node-a']);
    store.seed(PROJECT.dataDir, [pendingTodo('A'), pendingTodo('B'), pendingTodo('C')]);
    const deps = baseDeps(store, link);

    await runHubOutboxTick(deps);
    const rows1 = store.rows(PROJECT.dataDir);
    const seqA = rows1.find((r) => r.id === 'A')!.hubSeq!;
    const seqB = rows1.find((r) => r.id === 'B')!.hubSeq!;
    const seqC = rows1.find((r) => r.id === 'C')!.hubSeq!;
    expect(seqA).toBeLessThan(seqB);
    expect(seqB).toBeLessThan(seqC);
    const firstTickSeqs = [seqA, seqB, seqC];

    store.seed(PROJECT.dataDir, [...store.rows(PROJECT.dataDir), pendingTodo('D'), pendingTodo('E')]);
    await runHubOutboxTick(deps);
    const rows = store.rows(PROJECT.dataDir);
    const dSeq = rows.find((r) => r.id === 'D')!.hubSeq!;
    const eSeq = rows.find((r) => r.id === 'E')!.hubSeq!;

    expect(Math.max(...firstTickSeqs)).toBeLessThan(Math.min(dSeq, eSeq));
    expect(dSeq).not.toBe(eSeq);
  });
});

describe('runHubOutboxTick — an edit to an already-replicated record', () => {
  it('a todo carrying BOTH an existing hubSeq and a freshly-set pendingSince (a local edit after the first sync) is still picked up', async () => {
    const store = new FakeHubStore();
    const link = makeLink(['node-a']);
    store.seed(PROJECT.dataDir, [
      todo('E', { hubSeq: 3, pendingSince: '2026-08-24T01:00:00.000Z', pendingFields: ['priority'], priority: 'high' }),
    ]);
    // The allocator's counter for this project is seeded to 3, matching the hubSeq the record
    // already carries from an earlier sync — a fresh allocator starting at 0 would hand out a
    // hubSeq LOWER than the record's own, which cannot happen in production (one shared, monotonic
    // counter is what stamped the 3 in the first place) and is a fixture bug, not this file's.
    const deps: HubOutboxTickDeps = { ...baseDeps(store, link), allocateSeq: makeAllocator({ 'project:proj-1': 3 }) };

    const report = await runHubOutboxTick(deps);

    expect(report.opsApplied).toBe(1);
    const [row] = store.rows(PROJECT.dataDir);
    expect(row!.hubSeq).toBeGreaterThan(3);
    expect(row!.pendingSince).toBeUndefined();
    expect(link.sent).toHaveLength(1);
    expect(link.sent[0]!.frame.changes[0]!.fields?.priority).toBe('high');
  });
});

describe('runHubOutboxTick — nothing owed', () => {
  it('an empty project sends zero frames', async () => {
    const store = new FakeHubStore();
    const link = makeLink(['node-a']);
    store.seed(PROJECT.dataDir, []);

    const report = await runHubOutboxTick(baseDeps(store, link));
    expect(report).toMatchObject({ opsApplied: 0, framesSent: 0, targetsReached: 0, excluded: 0 });
  });

  it('a project with only fully-settled todos sends zero frames', async () => {
    const store = new FakeHubStore();
    const link = makeLink(['node-a']);
    store.seed(PROJECT.dataDir, [fullySettledTodo('X', 1), fullySettledTodo('Y', 2)]);

    const report = await runHubOutboxTick(baseDeps(store, link));
    expect(report.opsApplied).toBe(0);
    expect(report.framesSent).toBe(0);
    expect(store.applyOp).not.toHaveBeenCalled();
  });
});

describe('runHubOutboxTick — frame bounds with a large backlog', () => {
  it('600 owed records: capped at the contract budget this tick, nothing dropped, nothing duplicated across two ticks', async () => {
    const store = new FakeHubStore();
    const link = makeLink(['node-a']);
    const rows = Array.from({ length: 600 }, (_, i) => cliBackfillTodo(`r-${i}`));
    store.seed(PROJECT.dataDir, rows);
    const deps = baseDeps(store, link);

    const first = await runHubOutboxTick(deps);
    expect(first.opsApplied).toBe(CLUSTER_OPS_PER_FRAME_MAX);
    expect(first.opsDeferred).toBe(600 - CLUSTER_OPS_PER_FRAME_MAX);

    const second = await runHubOutboxTick(deps);
    expect(second.opsApplied).toBe(600 - CLUSTER_OPS_PER_FRAME_MAX);
    expect(second.opsDeferred).toBe(0);

    // count in === count out, and every hubSeq is unique — nothing lost, nothing double-applied.
    const finalRows = store.rows(PROJECT.dataDir);
    expect(finalRows).toHaveLength(600);
    expect(finalRows.every((r) => typeof r.hubSeq === 'number')).toBe(true);
    const seqs = finalRows.map((r) => r.hubSeq!);
    expect(new Set(seqs).size).toBe(600);

    // A third tick over the now fully-settled state sends nothing further.
    const third = await runHubOutboxTick(deps);
    expect(third.opsApplied).toBe(0);
  });
});

describe('runHubOutboxTick — apply outcomes', () => {
  it('a rejected op is durable-no-write and not fanned out; it is reported, not silently dropped', async () => {
    const store = new FakeHubStore();
    const link = makeLink(['node-a']);
    store.rejectFor.add('claimed-elsewhere');
    store.seed(PROJECT.dataDir, [pendingTodo('claimed-elsewhere', { startedTaskId: 'run-1' })]);
    const warn = vi.fn();

    const report = await runHubOutboxTick({ ...baseDeps(store, link), warn });

    expect(report.opsApplied).toBe(0);
    expect(report.opsRejected).toBe(1);
    expect(report.framesSent).toBe(0);
    expect(store.rows(PROJECT.dataDir)[0]!.hubSeq).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('refused'));
  });

  it('an op whose apply throws is left unapplied and re-derived next tick, without taking the rest of the batch down', async () => {
    const store = new FakeHubStore();
    const link = makeLink(['node-a']);
    store.seed(PROJECT.dataDir, [pendingTodo('bad'), pendingTodo('good')]);
    // Throw on whichever opId belongs to "bad" — discover it via a first dry pass through the fake's
    // own call args by throwing based on entityId instead, which the fake does not support directly,
    // so wrap applyOp to translate entityId -> opId at call time.
    const realApply = store.applyOp.getMockImplementation()!;
    store.applyOp.mockImplementation(async (dataDir, op) => {
      if (op.entityId === 'bad') throw new Error('transient disk error');
      return realApply(dataDir, op);
    });

    const report = await runHubOutboxTick(baseDeps(store, link));

    expect(report.opsFailed).toBe(1);
    expect(report.opsApplied).toBe(1);
    const rows = store.rows(PROJECT.dataDir);
    expect(rows.find((r) => r.id === 'good')!.hubSeq).toBeGreaterThan(0);
    expect(rows.find((r) => r.id === 'bad')!.hubSeq).toBeUndefined();
    expect(rows.find((r) => r.id === 'bad')!.pendingSince).toBeDefined();
  });

  it('a project whose readTodos throws is skipped without taking a sibling project down', async () => {
    const store = new FakeHubStore();
    const link = makeLink(['node-a']);
    const other: HubOutboxProject = { projectKey: 'proj-2', dataDir: '/fake/proj-2' };
    store.seed(other.dataDir, [pendingTodo('ok')]);

    const deps = baseDeps(store, link, [PROJECT, other]);
    const brokenReadTodos = async (dataDir: string): Promise<TodoItem[]> => {
      if (dataDir === PROJECT.dataDir) throw new Error('disk gone');
      return store.readTodos(dataDir);
    };

    const report = await runHubOutboxTick({ ...deps, readTodos: brokenReadTodos });
    expect(report.projectsProcessed).toBe(2);
    expect(report.opsApplied).toBe(1);
    expect(store.rows(other.dataDir)[0]!.hubSeq).toBeGreaterThan(0);
  });
});

describe('runHubOutboxTick — fan-out delivery failure', () => {
  it('does not stop the tick and does not lose the record; the target stays owed and the SAME record is not silently resent by an unrelated later batch', async () => {
    const store = new FakeHubStore();
    const link = makeLink(['node-a']);
    link.failFor.add('node-a');
    store.seed(PROJECT.dataDir, [pendingTodo('A')]);
    const deps = baseDeps(store, link);

    const first = await runHubOutboxTick(deps);
    expect(first.opsApplied).toBe(1); // durable at the hub regardless of delivery
    expect(first.framesSent).toBe(0);
    expect(link.watermarkOf('node-a', PROJECT.projectKey)).toBe(0); // left un-advanced

    const rowA = store.rows(PROJECT.dataDir)[0]!;
    expect(rowA.hubSeq).toBeGreaterThan(0); // NOT lost

    // The link recovers and a new, unrelated write comes in for the same project.
    link.failFor.delete('node-a');
    store.seed(PROJECT.dataDir, [...store.rows(PROJECT.dataDir), pendingTodo('B')]);
    const second = await runHubOutboxTick(deps);

    // The second tick's own tick keeps working — it is not wedged by the first failure.
    expect(second.opsApplied).toBe(1); // only B; A already has a hubSeq, is no longer "owed"
    expect(second.framesSent).toBe(1);
    // Known residual (see module docblock): B's delivery does not retroactively re-offer A.
    expect(entityIdsIn(link.sent[0]!.frame)).toEqual(['B']);
    const rowB = store.rows(PROJECT.dataDir).find((r) => r.id === 'B')!;
    expect(link.watermarkOf('node-a', PROJECT.projectKey)).toBe(rowB.hubSeq);
  });
});

describe('runHubOutboxTick — listProjects failure', () => {
  it('never throws; an empty report comes back and nothing is applied', async () => {
    const store = new FakeHubStore();
    const link = makeLink(['node-a']);
    const deps: HubOutboxTickDeps = {
      ...baseDeps(store, link),
      listProjects: () => {
        throw new Error('registry unavailable');
      },
    };
    await expect(runHubOutboxTick(deps)).resolves.toMatchObject({ projectsProcessed: 0, opsApplied: 0 });
  });
});

// ---- startHubOutbox ---------------------------------------------------------------------------

function hubIdentity(): StoredClusterNodeIdentity {
  return {
    nodeId: 'hub-1',
    nodeName: 'hub-node',
    createdAt: '2026-08-01T00:00:00.000Z',
    role: 'hub',
    acceptsDispatch: false,
    labels: [],
  };
}

function spokeIdentity(): StoredClusterNodeIdentity {
  return { ...hubIdentity(), nodeId: 'spoke-1', role: 'spoke', hubUrl: 'https://hub.example' };
}

describe('startHubOutbox — role gate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('on a spoke identity, nothing is armed, a named reason is given, and no tick ever runs', async () => {
    const store = new FakeHubStore();
    const link = makeLink(['node-a']);
    const listProjects = vi.fn(() => [PROJECT]);
    const deps: HubOutboxDeps = { ...baseDeps(store, link), identity: spokeIdentity(), listProjects };

    const handle = startHubOutbox(deps);
    expect(handle.status).toBe('skipped-not-hub');
    expect(handle.reason).toBeTruthy();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(listProjects).not.toHaveBeenCalled();
    expect(() => handle()).not.toThrow(); // disposer is a safe no-op
  });

  it('with no identity on disk yet, nothing is armed, a named reason is given', () => {
    const store = new FakeHubStore();
    const link = makeLink(['node-a']);
    const deps: HubOutboxDeps = { ...baseDeps(store, link), identity: undefined };

    const handle = startHubOutbox(deps);
    expect(handle.status).toBe('skipped-no-identity');
    expect(handle.reason).toBeTruthy();
  });

  it('on a hub identity, the outbox arms: an immediate tick, then one per interval, until disposed', async () => {
    const store = new FakeHubStore();
    const link = makeLink(['node-a']);
    const listProjects = vi.fn(() => [PROJECT]);
    const deps: HubOutboxDeps = {
      ...baseDeps(store, link),
      identity: hubIdentity(),
      listProjects,
      intervalMs: 5_000,
    };

    const handle = startHubOutbox(deps);
    expect(handle.status).toBe('armed');

    await vi.advanceTimersByTimeAsync(0); // the immediate tick
    expect(listProjects).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(listProjects).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(listProjects).toHaveBeenCalledTimes(3);

    handle();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(listProjects).toHaveBeenCalledTimes(3); // disposed — no further ticks

    expect(() => handle()).not.toThrow(); // idempotent dispose
  });
});
