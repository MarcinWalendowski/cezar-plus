import { describe, expect, it } from 'vitest';
import type { ClusterOp } from '@loki-labs/better-cezar-contract';
import type { TodoItem } from '../todos.ts';
import { applyOpToRecord, applyReplica, applyReplicaFrame, diffCorrections } from './replica.ts';

/**
 * Package 2.2 (`.ai/runs/2026-08-22-multi-node-cezar-cluster/PLAN.md`) — the five automated
 * verifications named for this package in `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`
 * (Verification → Automated 1, 2, 3, 4, 5a), rewritten with D4: there is no HLC and no per-field
 * LWW merge to test any more, only hub-order application and the corrections it produces.
 */

function makeTodo(fields: Partial<TodoItem> & { id: string; summary: string }): TodoItem {
  return fields as TodoItem;
}

let opSeq = 0;
function makeOp(fields: {
  opId?: string;
  entityId: string;
  op: 'upsert' | 'tombstone';
  hubSeq?: number;
  nodeId?: string;
  ts?: string;
  fields?: Record<string, unknown>;
  clearedFields?: string[];
  unknown?: Record<string, unknown>;
}): ClusterOp {
  opSeq += 1;
  return {
    opId: fields.opId ?? `op-${opSeq}`,
    nodeId: fields.nodeId ?? 'node-remote',
    ts: fields.ts ?? '2026-08-22T00:00:00.000Z',
    scope: 'project',
    entity: 'todo',
    entityId: fields.entityId,
    op: fields.op,
    fields: fields.fields,
    clearedFields: fields.clearedFields,
    unknown: fields.unknown,
    hubSeq: fields.hubSeq,
  };
}

// ---- 1. Hub order is respected, and the apply is idempotent ------------------------------------

describe('verification 1 — hub order respected; apply is order-declared and idempotent', () => {
  it('two ops applied in hub sequence produce the sequenced result', () => {
    const local: TodoItem[] = [makeTodo({ id: 't1', summary: 'ship it' })];
    const opLow = makeOp({ entityId: 't1', op: 'upsert', hubSeq: 10, fields: { priority: 'low' } });
    const opHigh = makeOp({ entityId: 't1', op: 'upsert', hubSeq: 11, fields: { priority: 'high' } });

    const result = applyReplica({ local, pending: [], changes: [opLow, opHigh], appliedThroughHubSeq: 0 });

    expect(result.todos.find((t) => t.id === 't1')?.priority).toBe('high');
    expect(result.appliedThroughHubSeq).toBe(11);
  });

  it('replaying the same ops out of order produces the same result — order-declared, not order-sensitive', () => {
    const local: TodoItem[] = [makeTodo({ id: 't1', summary: 'ship it' })];
    const opLow = makeOp({ opId: 'op-low', entityId: 't1', op: 'upsert', hubSeq: 10, fields: { priority: 'low' } });
    const opHigh = makeOp({ opId: 'op-high', entityId: 't1', op: 'upsert', hubSeq: 11, fields: { priority: 'high' } });

    const inOrder = applyReplica({ local, pending: [], changes: [opLow, opHigh], appliedThroughHubSeq: 0 });
    const scrambled = applyReplica({ local, pending: [], changes: [opHigh, opLow], appliedThroughHubSeq: 0 });

    expect(scrambled.todos).toEqual(inOrder.todos);
    expect(scrambled.appliedThroughHubSeq).toBe(inOrder.appliedThroughHubSeq);
  });

  it('is idempotent: replaying already-applied ops (a resumed link) changes nothing and counts as skipped', () => {
    const local: TodoItem[] = [makeTodo({ id: 't1', summary: 'ship it' })];
    const opLow = makeOp({ opId: 'op-low', entityId: 't1', op: 'upsert', hubSeq: 10, fields: { priority: 'low' } });
    const opHigh = makeOp({ opId: 'op-high', entityId: 't1', op: 'upsert', hubSeq: 11, fields: { priority: 'high' } });

    const first = applyReplica({ local, pending: [], changes: [opLow, opHigh], appliedThroughHubSeq: 0 });
    const replay = applyReplica({
      local: first.todos,
      pending: [],
      changes: [opLow, opHigh],
      appliedThroughHubSeq: first.appliedThroughHubSeq,
    });

    expect(replay.todos).toEqual(first.todos);
    expect(replay.skipped).toBe(2);
    expect(replay.corrections).toEqual([]);
  });
});

// ---- 2. Per-field ops, with the mandatory negative control --------------------------------------

describe('verification 2 — per-field ops let two spokes edit different fields of one todo, both survive', () => {
  it('two spokes queue edits to different fields; the hub applies both and both survive', () => {
    const local: TodoItem[] = [
      makeTodo({ id: 't1', summary: 'ship it', context: 'old context', whatToDo: 'old plan' }),
    ];
    const opContext = makeOp({
      entityId: 't1',
      op: 'upsert',
      hubSeq: 20,
      nodeId: 'node-a',
      fields: { context: 'new context from A' },
    });
    const opPlan = makeOp({
      entityId: 't1',
      op: 'upsert',
      hubSeq: 21,
      nodeId: 'node-b',
      fields: { whatToDo: 'new plan from B' },
    });

    const result = applyReplica({ local, pending: [], changes: [opContext, opPlan], appliedThroughHubSeq: 0 });
    const t1 = result.todos.find((t) => t.id === 't1');

    expect(t1?.context).toBe('new context from A');
    expect(t1?.whatToDo).toBe('new plan from B');
  });

  it('NEGATIVE CONTROL: the same two edits sent as whole-record ops lose one, proving the property depends on per-field op shape, not on the merge function alone', () => {
    const base = { id: 't1', summary: 'ship it', context: 'old context', whatToDo: 'old plan' };
    const local: TodoItem[] = [makeTodo(base)];

    // Node A's snapshot of the WHOLE record at the moment it wrote `context`.
    const opContextWholeRecord = makeOp({
      entityId: 't1',
      op: 'upsert',
      hubSeq: 20,
      nodeId: 'node-a',
      fields: { ...base, context: 'new context from A' },
    });
    // Node B's snapshot of the WHOLE record, taken before it ever saw A's change — still carries
    // the old `context`. This is the shape D4 replaced; ops in this repo never look like this.
    const opPlanWholeRecord = makeOp({
      entityId: 't1',
      op: 'upsert',
      hubSeq: 21,
      nodeId: 'node-b',
      fields: { ...base, whatToDo: 'new plan from B' },
    });

    const result = applyReplica({
      local,
      pending: [],
      changes: [opContextWholeRecord, opPlanWholeRecord],
      appliedThroughHubSeq: 0,
    });
    const t1 = result.todos.find((t) => t.id === 't1');

    // B's later whole-record snapshot clobbers A's context change back to the stale value it was
    // computed from — the exact loss the per-field op shape exists to prevent. If this assertion
    // ever starts failing, whole-record ops have stopped losing data and this test is wrong, not
    // the fix it is meant to reject.
    expect(t1?.whatToDo).toBe('new plan from B');
    expect(t1?.context).toBe('old context');
    expect(t1?.context).not.toBe('new context from A');
  });
});

// ---- 3. Tombstone and resurrection, both directions ---------------------------------------------

describe('verification 3 — tombstone and resurrection, both directions', () => {
  it('a tombstone at a later hubSeq wins over an earlier upsert', () => {
    const upsert = makeOp({ entityId: 't1', op: 'upsert', hubSeq: 30, fields: { summary: 'a todo' } });
    const tombstone = makeOp({ entityId: 't1', op: 'tombstone', hubSeq: 31, fields: {} });

    // Fed scrambled too, so this also leans on order-declared application (verification 1).
    const result = applyReplica({ local: [], pending: [], changes: [tombstone, upsert], appliedThroughHubSeq: 0 });
    const t1 = result.todos.find((t) => t.id === 't1');

    expect(t1?.tombstone).toBeDefined();
  });

  it('an upsert at a later hubSeq un-tombstones an earlier tombstone', () => {
    const tombstone = makeOp({ entityId: 't1', op: 'tombstone', hubSeq: 40, fields: {} });
    const upsert = makeOp({ entityId: 't1', op: 'upsert', hubSeq: 41, fields: { summary: 'resurrected' } });

    const result = applyReplica({ local: [], pending: [], changes: [upsert, tombstone], appliedThroughHubSeq: 0 });
    const t1 = result.todos.find((t) => t.id === 't1');

    expect(t1?.tombstone).toBeUndefined();
    expect(t1?.summary).toBe('resurrected');
  });

  it('a later upsert never un-tombstones an even-later tombstone (not just "any upsert wins")', () => {
    const upsertFirst = makeOp({ entityId: 't1', op: 'upsert', hubSeq: 50, fields: { summary: 'a todo' } });
    const tombstoneLast = makeOp({ entityId: 't1', op: 'tombstone', hubSeq: 52, fields: {} });
    const upsertMiddle = makeOp({ entityId: 't1', op: 'upsert', hubSeq: 51, fields: { summary: 'edited' } });

    const result = applyReplica({
      local: [],
      pending: [],
      changes: [tombstoneLast, upsertMiddle, upsertFirst],
      appliedThroughHubSeq: 0,
    });
    const t1 = result.todos.find((t) => t.id === 't1');

    expect(t1?.tombstone).toBeDefined();
  });
});

// ---- 4. Unknown fields round-trip through an older reader unchanged (D13) -----------------------

describe('verification 4 — an op carrying an unknown field round-trips through an older reader unchanged (D13)', () => {
  it('preserves a field this node does not recognize, on first apply and on a later idempotent replay', () => {
    const changeOp = makeOp({
      entityId: 't1',
      op: 'upsert',
      hubSeq: 60,
      fields: { summary: 'from a newer node' },
      unknown: { futureField: 'v2-only-value' },
    });

    const first = applyReplica({ local: [], pending: [], changes: [changeOp], appliedThroughHubSeq: 0 });
    const t1First = first.todos.find((t) => t.id === 't1') as (TodoItem & { futureField?: string }) | undefined;

    expect(t1First?.summary).toBe('from a newer node');
    expect(t1First?.futureField).toBe('v2-only-value');

    // "An older reader" seeing the exact same op again (a resumed link) must not drop it either.
    const replay = applyReplica({
      local: first.todos,
      pending: [],
      changes: [changeOp],
      appliedThroughHubSeq: first.appliedThroughHubSeq,
    });
    const t1Replay = replay.todos.find((t) => t.id === 't1') as (TodoItem & { futureField?: string }) | undefined;

    expect(t1Replay?.futureField).toBe('v2-only-value');
    expect(replay.skipped).toBe(1);
  });

  it('applyOpToRecord merges `unknown` the same way as `fields`, directly', () => {
    const before: TodoItem = makeTodo({ id: 't1', summary: 'x' });
    const op = makeOp({ entityId: 't1', op: 'upsert', hubSeq: 61, unknown: { anotherFutureField: 42 } });

    const after = applyOpToRecord(before, op) as (TodoItem & { anotherFutureField?: number }) | undefined;

    expect(after?.anotherFutureField).toBe(42);
    expect(after?.summary).toBe('x');
  });
});

// ---- field DELETION (clearedFields) -------------------------------------------------------------

/**
 * A field deletion is not expressible as a value, so `cluster/ops.ts` names it in `clearedFields`
 * and this file has to act on it. Before the paired delete loop existed, `applyOpToRecord` only
 * `Object.assign`'d `fields` and `unknown`, so a key removed on the sender was indistinguishable
 * from one that had never been set: `updateTodo({ archived: false })`, `clearStartedTaskId` and
 * `markStarted`'s `delete autostart` all replicated as no-ops and the peer kept the stale value
 * forever, with nothing anywhere reporting a failure.
 */
describe('clearedFields — a deletion crosses the link, and only the keys it names', () => {
  it('removes exactly the keys the op lists', () => {
    const before = makeTodo({ id: 't1', summary: 'x', archivedAt: '2026-08-22T00:00:00.000Z', priority: 'high' });
    // Floor: the record HAS the key, so "absent afterwards" is not vacuously true.
    expect(before?.archivedAt).toBe('2026-08-22T00:00:00.000Z');

    const after = applyOpToRecord(before, makeOp({ entityId: 't1', op: 'upsert', hubSeq: 5, clearedFields: ['archivedAt'] }));

    expect(after).toBeDefined();
    expect(Object.hasOwn(after!, 'archivedAt')).toBe(false);
    // A key the op never named survives — this deletes what is LISTED, never what is merely absent
    // from `fields`, which would be the whole-record clobber in a second costume.
    expect(after?.priority).toBe('high');
    // hubSeq still lands: the loop runs before the bookkeeping fields are written, so a peer can
    // never clear the hub's own statement about the record.
    expect(after?.hubSeq).toBe(5);
  });

  it('does not mutate the record handed to it', () => {
    const before = makeTodo({ id: 't1', summary: 'x', archivedAt: '2026-08-22T00:00:00.000Z' });
    applyOpToRecord(before, makeOp({ entityId: 't1', op: 'upsert', hubSeq: 6, clearedFields: ['archivedAt'] }));
    // `applyReplica` diffs local against applied afterwards; a mutating apply would make every
    // correction read as "they agree".
    expect(before?.archivedAt).toBe('2026-08-22T00:00:00.000Z');
  });

  it('an op with no clearedFields removes nothing — the negative control for the case above', () => {
    const before = makeTodo({ id: 't1', summary: 'x', archivedAt: '2026-08-22T00:00:00.000Z' });
    const after = applyOpToRecord(before, makeOp({ entityId: 't1', op: 'upsert', hubSeq: 7, fields: { summary: 'y' } }));
    expect(after?.archivedAt).toBe('2026-08-22T00:00:00.000Z');
    expect(after?.summary).toBe('y');
  });

  it('a clear beats an `unknown` passthrough carrying the same key', () => {
    // `unknown` (D13) copies keys this schema does not recognise verbatim. `ops.ts` never puts a
    // key in both, but the merge order still has to state an answer: "this key is gone" is the
    // more specific claim and must not be undone by a passthrough copy, so the clear runs last.
    const before = makeTodo({ id: 't1', summary: 'x' });
    const after = applyOpToRecord(
      before,
      makeOp({ entityId: 't1', op: 'upsert', hubSeq: 8, unknown: { futureField: 1 }, clearedFields: ['futureField'] }),
    );
    expect(Object.hasOwn(after!, 'futureField')).toBe(false);
  });

  it('diffCorrections reports a cleared field whose local value differed, and stays silent when it did not', () => {
    const op = makeOp({ entityId: 't1', op: 'upsert', hubSeq: 9, clearedFields: ['archivedAt'] });
    const local = makeTodo({ id: 't1', summary: 'x', archivedAt: '2026-08-22T00:00:00.000Z' });
    const applied = applyOpToRecord(local, op)!;

    const corrections = diffCorrections(local, applied, op, () => new Date('2026-08-23T00:00:00.000Z'));
    expect(corrections).toHaveLength(1);
    expect(corrections[0]?.field).toBe('archivedAt');
    expect(corrections[0]?.localValue).toBe('2026-08-22T00:00:00.000Z');
    expect(corrections[0]?.hubValue).toBeUndefined();

    // The other direction: a node that never had the key gets no correction, because nothing of
    // its own was overruled. Without this, "reports a correction" would be satisfied by a function
    // that reported one for every named field unconditionally.
    const untouched = makeTodo({ id: 't1', summary: 'x' });
    expect(diffCorrections(untouched, applyOpToRecord(untouched, op)!, op, () => new Date())).toEqual([]);
  });
});

// ---- 5a. Optimistic write, then contradiction: replaced AND flagged -----------------------------

describe('verification 5a — optimistic write, then contradiction: replaced and flagged, never silently swapped', () => {
  it('a local optimistic value the hub applied result disagrees with is replaced and a correction is emitted', () => {
    const local: TodoItem[] = [
      makeTodo({
        id: 't1',
        summary: 'ship it',
        status: 'blocked',
        pendingSince: '2026-08-22T00:00:00.000Z',
        hubSeq: 5,
      }),
    ];
    // This node's own outstanding proposal — the hub has not echoed it back in this push.
    const ownPendingOp = makeOp({
      opId: 'op-local-1',
      entityId: 't1',
      op: 'upsert',
      nodeId: 'node-a',
      fields: { status: 'blocked' },
    });
    // A DIFFERENT node's op, already applied by the hub for the SAME field.
    const foreignChange = makeOp({
      opId: 'op-foreign-1',
      entityId: 't1',
      op: 'upsert',
      hubSeq: 6,
      nodeId: 'node-b',
      fields: { status: 'done' },
    });

    const result = applyReplica({
      local,
      pending: [ownPendingOp],
      changes: [foreignChange],
      appliedThroughHubSeq: 5,
    });

    const t1 = result.todos.find((t) => t.id === 't1');
    // Replaced ...
    expect(t1?.status).toBe('done');
    expect(t1?.pendingSince).toBeUndefined();
    // ... and FLAGGED, not silently swapped. Asserting the flag (not just the value) is the point.
    expect(result.corrections).toHaveLength(1);
    expect(result.corrections[0]).toMatchObject({
      entity: 'todo',
      entityId: 't1',
      field: 'status',
      localValue: 'blocked',
      hubValue: 'done',
      hubSeq: 6,
    });
  });

  it('does NOT report a correction for a pending write the hub has not seen at all', () => {
    const local: TodoItem[] = [
      makeTodo({ id: 't1', summary: 'ship it', priority: 'high', pendingSince: '2026-08-22T00:00:00.000Z' }),
      makeTodo({ id: 't2', summary: 'unrelated' }),
    ];
    const ownPendingOp = makeOp({
      opId: 'op-local-2',
      entityId: 't1',
      op: 'upsert',
      fields: { priority: 'high' },
    });
    // A change for a DIFFERENT entity — the hub has said nothing about t1 in this push.
    const unrelatedChange = makeOp({
      entityId: 't2',
      op: 'upsert',
      hubSeq: 7,
      fields: { summary: 'still unrelated' },
    });

    const result = applyReplica({
      local,
      pending: [ownPendingOp],
      changes: [unrelatedChange],
      appliedThroughHubSeq: 0,
    });

    expect(result.corrections).toEqual([]);
    expect(result.todos.find((t) => t.id === 't1')?.priority).toBe('high');
    expect(result.todos.find((t) => t.id === 't1')?.pendingSince).toBeDefined();
  });

  it('diffCorrections agrees when local and applied match on every proposed field — the common case costs nothing', () => {
    const local = makeTodo({ id: 't1', summary: 'x', status: 'blocked' });
    const applied = makeTodo({ id: 't1', summary: 'x', status: 'blocked' });
    const op = makeOp({ entityId: 't1', op: 'upsert', hubSeq: 8, fields: { status: 'blocked' } });

    expect(diffCorrections(local, applied, op, () => new Date('2026-08-22T00:00:00.000Z'))).toEqual([]);
  });
});

// ---- applyReplicaFrame: changes/hubSeq can never be paired wrongly -------------------------------

describe('applyReplicaFrame', () => {
  it('applies the frame\'s changes and advances the watermark to at least the frame\'s own hubSeq', () => {
    const changeOp = makeOp({ entityId: 't1', op: 'upsert', hubSeq: 70, fields: { summary: 'framed' } });

    const result = applyReplicaFrame(
      { type: 'replica', protocol: { major: 1, minor: 0 }, scope: 'project', changes: [changeOp], hubSeq: 70 },
      { local: [], pending: [], appliedThroughHubSeq: 0 },
    );

    expect(result.todos.find((t) => t.id === 't1')?.summary).toBe('framed');
    expect(result.appliedThroughHubSeq).toBe(70);
  });

  it('an empty-changes keepalive frame still advances the watermark to the frame\'s hubSeq', () => {
    const result = applyReplicaFrame(
      { type: 'replica', protocol: { major: 1, minor: 0 }, scope: 'project', changes: [], hubSeq: 99 },
      { local: [], pending: [], appliedThroughHubSeq: 90 },
    );

    expect(result.appliedThroughHubSeq).toBe(99);
    expect(result.todos).toEqual([]);
  });
});
