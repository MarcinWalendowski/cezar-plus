import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClusterOp, ClusterTodoFields } from '@loki-labs/better-cezar-contract';
import {
  CLUSTER_META_TODO_FIELDS,
  DEFAULT_OP_SEND_BUDGET,
  compactOps,
  deriveTodoOps,
  newOpId,
  packOpsFrame,
  salvageOps,
  type DeriveTodoOpsInput,
} from './ops.ts';
import { applyOpToRecord } from './replica.ts';
import { createTodo, readTodos, todosPath, updateTodo, type TodoClusterOptions, type TodoItem } from '../todos.ts';
import { localCliAuthor } from '../runs/task-author.ts';

/**
 * Package 2.1 (`.ai/runs/2026-08-22-multi-node-cezar-cluster/PLAN.md`), covering spec Verification
 * **5** and **5b**. `ops.ts` is pure — no filesystem here; the file-backed half (`appendOps` /
 * `readOps` / `compactOpLog`) is covered in `oplog.test.ts`, including 5b's own re-derive scenario
 * end to end.
 */

/** `TodoItem` widened with the cluster fields `todos.ts` does not carry yet (package 2.0/2.3's job
 *  — see the module header in `ops.ts` for why this package reads through a local widening rather
 *  than editing `todos.ts`). Fixtures below are built against this type directly instead of
 *  casting object literals to `TodoItem`, which is what makes them safe under excess-property
 *  checking. */
type PendingTodoFixture = TodoItem & Partial<ClusterTodoFields>;

function todo(overrides: Partial<PendingTodoFixture> & Pick<TodoItem, 'id'>): PendingTodoFixture {
  return { summary: 'a todo', ...overrides };
}

function baseInput(overrides: Partial<DeriveTodoOpsInput> = {}): DeriveTodoOpsInput {
  return {
    nodeId: 'node-a',
    projectKey: 'proj-1',
    todos: [],
    ackedThroughHubSeq: 0,
    ...overrides,
  };
}

describe('cluster/ops — newOpId', () => {
  it('mints distinct, non-empty ids', () => {
    const a = newOpId();
    const b = newOpId();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });
});

/**
 * The set is DERIVED (`clusterTodoFieldsSchema.shape` minus `placement`, plus `id`) rather than
 * typed out, so that a seventh cluster bookkeeping field added to the contract is un-sendable by
 * default instead of by someone remembering to update a literal — a field that should have been
 * content merely fails to replicate (visible), whereas a bookkeeping field stamped as owed loops
 * forever (D36). A derivation can also silently SHRINK, which is why its exact membership is pinned
 * here against the hand-written list this set replaced.
 */
describe('cluster/ops — CLUSTER_META_TODO_FIELDS', () => {
  it('is exactly the six keys no op may carry — the literal it was derived from, member for member', () => {
    expect([...CLUSTER_META_TODO_FIELDS].sort()).toEqual(
      ['hubSeq', 'id', 'pendingFields', 'pendingSince', 'startedOn', 'tombstone'].sort(),
    );
  });

  it('excludes placement on purpose — "run this one on the box" is ordinary content a spoke may propose', () => {
    expect(CLUSTER_META_TODO_FIELDS.has('placement')).toBe(false);
    const placement = { node: 'node-box' };
    const pending = { ...todo({ id: 't1', placement }), pendingSince: '2026-08-22T10:00:00.000Z', pendingFields: ['placement'] };
    expect(deriveTodoOps(baseInput({ todos: [pending] }))[0]?.fields).toEqual({ placement });
  });
});

describe('cluster/ops — deriveTodoOps', () => {
  it('produces nothing for a todo with no pendingSince', () => {
    const todos = [todo({ id: 't1', status: 'todo' })];
    expect(deriveTodoOps(baseInput({ todos }))).toEqual([]);
  });

  it('derives one upsert per pending record, entityId/scope/entity/projectKey/nodeId set', () => {
    const pending = { ...todo({ id: 't1', summary: 'x', status: 'in-progress' }), pendingSince: '2026-08-22T10:00:00.000Z' };
    const ops = deriveTodoOps(baseInput({ todos: [pending], nodeId: 'node-b', projectKey: 'proj-9' }));
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      nodeId: 'node-b',
      projectKey: 'proj-9',
      scope: 'project',
      entity: 'todo',
      entityId: 't1',
      op: 'upsert',
      ts: '2026-08-22T10:00:00.000Z',
    });
  });

  it('the op ts is the local edit time (pendingSince), not the derive-call time', () => {
    const pending = { ...todo({ id: 't1' }), pendingSince: '2020-01-01T00:00:00.000Z' };
    const ops = deriveTodoOps(
      baseInput({ todos: [pending], now: () => new Date('2030-01-01T00:00:00.000Z') }),
    );
    expect(ops[0]?.ts).toBe('2020-01-01T00:00:00.000Z');
  });

  it('fields carries the record content, minus id and the cluster-transport meta fields — no pendingFields here, so this also pins the documented fallback (send everything)', () => {
    const pending = {
      ...todo({ id: 't1', summary: 'do the thing', priority: 'high', status: 'todo' }),
      pendingSince: '2026-08-22T00:00:00.000Z',
      hubSeq: undefined,
    };
    const ops = deriveTodoOps(baseInput({ todos: [pending] }));
    const fields = ops[0]?.fields ?? {};
    expect(fields).toMatchObject({ summary: 'do the thing', priority: 'high', status: 'todo' });
    expect(fields).not.toHaveProperty('id');
    expect(fields).not.toHaveProperty('pendingSince');
    expect(fields).not.toHaveProperty('hubSeq');
    expect(fields).not.toHaveProperty('pendingFields');
  });

  it('pendingFields, when present, narrows fields to exactly the named keys — everything else on the record is dropped even though it changed too', () => {
    const pending = {
      ...todo({ id: 't1', summary: 'do the thing', priority: 'high', status: 'todo' }),
      pendingSince: '2026-08-22T00:00:00.000Z',
      pendingFields: ['status'],
    };
    const ops = deriveTodoOps(baseInput({ todos: [pending] }));
    expect(ops[0]?.fields).toEqual({ status: 'todo' });
  });

  it('pendingFields missing on a pendingSince record — the documented decision is send-everything, not drop-silently or empty-send', () => {
    const withoutPendingFields = {
      ...todo({ id: 't1', summary: 'legacy row', priority: 'low' }),
      pendingSince: '2026-08-22T00:00:00.000Z',
      // pendingFields intentionally absent — a record from before this field existed, or written
      // by an older node's `stampPending` that has never heard of it.
    };
    const ops = deriveTodoOps(baseInput({ todos: [withoutPendingFields] }));
    // Pinned as a DECISION: not `{}` (which would be "empty send", never chosen) and not `[]` ops
    // (which would be "drop silently", never chosen either) — the whole record, same as the
    // pre-amendment behaviour, on the reasoning in `deriveTodoOps`'s own docblock.
    expect(ops).toHaveLength(1);
    expect(ops[0]?.fields).toEqual({ summary: 'legacy row', priority: 'low' });
    // Nothing is CLEARED either — without the marker there is no way to tell a genuine deletion
    // from a field nobody touched, and guessing would manufacture a deletion that never happened.
    expect(ops[0]?.clearedFields).toBeUndefined();
  });

  it('pendingFields naming a key the record no longer HAS produces a deletion — clearedFields, not a missing entry from fields', () => {
    const deleted = {
      ...todo({ id: 't1', summary: 'still here', status: 'todo' }),
      pendingSince: '2026-08-22T00:00:00.000Z',
      // `priority` was deleted locally (e.g. `updateTodo({ archived: false })`'s pattern) — the key
      // is genuinely absent from the record, not present-with-undefined.
      pendingFields: ['status', 'priority'],
    };
    const ops = deriveTodoOps(baseInput({ todos: [deleted] }));
    expect(ops[0]?.fields).toEqual({ status: 'todo' });
    expect(ops[0]?.fields).not.toHaveProperty('priority');
    expect(ops[0]?.clearedFields).toEqual(['priority']);
  });

  it('a key never named in pendingFields appears in neither fields nor clearedFields — "untouched" and "deleted" are different facts', () => {
    const pending = {
      // `priority` is absent here too, but it is NOT in pendingFields — nobody ever touched it.
      ...todo({ id: 't1', summary: 'do the thing', status: 'todo' }),
      pendingSince: '2026-08-22T00:00:00.000Z',
      pendingFields: ['status'],
    };
    const ops = deriveTodoOps(baseInput({ todos: [pending] }));
    expect(ops[0]?.fields).toEqual({ status: 'todo' });
    expect(ops[0]?.clearedFields).toBeUndefined();
  });

  it('pendingFields present but empty — narrows to nothing, never silently reinterpreted as "everything" (the `undefined` vs `[]` distinction actually matters)', () => {
    const pending = {
      ...todo({ id: 't1', summary: 'do the thing', priority: 'high' }),
      pendingSince: '2026-08-22T00:00:00.000Z',
      pendingFields: [] as string[],
    };
    const ops = deriveTodoOps(baseInput({ todos: [pending] }));
    expect(ops[0]?.fields).toEqual({});
  });

  it('D9a: startedOn never rides as upsert content, even when present on the record', () => {
    const pending = {
      ...todo({ id: 't1', summary: 'x' }),
      pendingSince: '2026-08-22T00:00:00.000Z',
      startedOn: 'node-that-claimed-it',
    };
    const ops = deriveTodoOps(baseInput({ todos: [pending] }));
    expect(ops[0]?.fields).not.toHaveProperty('startedOn');
  });

  it('D9a holds even if pendingFields names startedOn by mistake — the meta-field filter is a floor pendingFields cannot punch through', () => {
    const pending = {
      ...todo({ id: 't1', summary: 'x' }),
      pendingSince: '2026-08-22T00:00:00.000Z',
      pendingFields: ['summary', 'startedOn'],
      startedOn: 'node-that-claimed-it',
    };
    const ops = deriveTodoOps(baseInput({ todos: [pending] }));
    expect(ops[0]?.fields).toEqual({ summary: 'x' });
  });

  it('D6: a tombstoned pending record derives a tombstone op, not an upsert, and carries no fields', () => {
    const pending = {
      ...todo({ id: 't1', summary: 'gone' }),
      pendingSince: '2026-08-22T00:00:00.000Z',
      tombstone: { at: '2026-08-22T00:00:00.000Z' },
    };
    const ops = deriveTodoOps(baseInput({ todos: [pending] }));
    expect(ops).toHaveLength(1);
    expect(ops[0]?.op).toBe('tombstone');
    expect(ops[0]?.fields).toBeUndefined();
  });

  it('a record already durably applied at the hub (hubSeq <= ackedThroughHubSeq) is not owed, even if pendingSince is still set', () => {
    const pending = { ...todo({ id: 't1' }), pendingSince: '2026-08-22T00:00:00.000Z', hubSeq: 5 };
    const ops = deriveTodoOps(baseInput({ todos: [pending], ackedThroughHubSeq: 5 }));
    expect(ops).toEqual([]);
  });

  it('a record whose hubSeq is still ahead of ackedThroughHubSeq remains owed', () => {
    const pending = { ...todo({ id: 't1' }), pendingSince: '2026-08-22T00:00:00.000Z', hubSeq: 5 };
    const ops = deriveTodoOps(baseInput({ todos: [pending], ackedThroughHubSeq: 4 }));
    expect(ops).toHaveLength(1);
  });

  it('derives one op per pending record across several todos, leaving non-pending ones out', () => {
    const todos = [
      { ...todo({ id: 't1' }), pendingSince: '2026-08-22T00:00:00.000Z' },
      todo({ id: 't2' }), // not pending
      { ...todo({ id: 't3' }), pendingSince: '2026-08-22T00:00:01.000Z' },
    ];
    const ops = deriveTodoOps(baseInput({ todos }));
    expect(ops.map((op) => op.entityId).sort()).toEqual(['t1', 't3']);
  });

  it('is a pure re-derive: called twice over the same state, it produces the same set of (entity, op-kind, fields) — a re-derive after a crash is a no-op, not a duplicate flush', () => {
    const todos = [
      { ...todo({ id: 't1', summary: 'a', status: 'todo' }), pendingSince: '2026-08-22T00:00:00.000Z' },
      { ...todo({ id: 't2' }), pendingSince: '2026-08-22T00:00:01.000Z', tombstone: { at: '2026-08-22T00:00:01.000Z' } },
    ];
    const input = baseInput({ todos });
    const first = deriveTodoOps(input);
    const second = deriveTodoOps(input);
    const strip = (ops: ClusterOp[]) => ops.map(({ opId: _opId, ...rest }) => rest).sort((a, b) => a.entityId.localeCompare(b.entityId));
    expect(strip(second)).toEqual(strip(first));
  });
});

describe('cluster/ops — packOpsFrame', () => {
  function op(entityId: string, extra: Partial<ClusterOp> = {}): ClusterOp {
    return {
      opId: newOpId(),
      nodeId: 'node-a',
      ts: '2026-08-22T00:00:00.000Z',
      scope: 'project',
      projectKey: 'proj-1',
      entity: 'todo',
      entityId,
      op: 'upsert',
      fields: { summary: 'x' },
      ...extra,
    };
  }

  it('packs everything under budget into one frame with an empty remainder', () => {
    const ops = [op('t1'), op('t2'), op('t3')];
    const { frame, sent, remaining } = packOpsFrame(ops, { scope: 'project', projectKey: 'proj-1' });
    expect(sent).toEqual(ops);
    expect(remaining).toEqual([]);
    expect(frame.ops).toEqual(ops);
    expect(frame.scope).toBe('project');
    expect(frame.projectKey).toBe('proj-1');
  });

  it('bounds a burst by maxOps and preserves the remainder for the next flush (negative control 2)', () => {
    const ops = Array.from({ length: 5000 }, (_, i) => op(`t${i}`));
    const budget = { ...DEFAULT_OP_SEND_BUDGET, maxOps: 500 };
    const first = packOpsFrame(ops, { scope: 'project', budget });
    expect(first.sent).toHaveLength(500);
    expect(first.remaining).toHaveLength(4500);
    expect(first.remaining[0]?.entityId).toBe('t500');

    // The remainder genuinely survives to drain across further flushes — not just "not zero".
    let remaining = first.remaining;
    let flushes = 1;
    const drained: ClusterOp[] = [...first.sent];
    while (remaining.length > 0) {
      const next = packOpsFrame(remaining, { scope: 'project', budget });
      drained.push(...next.sent);
      remaining = next.remaining;
      flushes += 1;
    }
    expect(drained.map((o) => o.entityId)).toEqual(ops.map((o) => o.entityId));
    expect(flushes).toBe(10);
  });

  it('bounds a burst by maxBytes, splitting before maxOps when payloads are large', () => {
    const big = 'x'.repeat(100_000);
    const ops = [op('t1', { fields: { whatToDo: big } }), op('t2', { fields: { whatToDo: big } }), op('t3', { fields: { whatToDo: big } })];
    const { sent, remaining } = packOpsFrame(ops, { scope: 'project', budget: { ...DEFAULT_OP_SEND_BUDGET, maxBytes: 150_000 } });
    expect(sent).toHaveLength(1);
    expect(remaining).toHaveLength(2);
  });

  it('always sends at least one op even if it alone exceeds the byte budget, so an oversized op cannot stall the outbox forever', () => {
    const huge = op('t1', { fields: { whatToDo: 'y'.repeat(500_000) } });
    const small = op('t2');
    const { sent, remaining } = packOpsFrame([huge, small], { scope: 'project', budget: { ...DEFAULT_OP_SEND_BUDGET, maxBytes: 1000 } });
    expect(sent).toEqual([huge]);
    expect(remaining).toEqual([small]);
  });

  it('clamps a caller-supplied budget to the wire schema hard bounds (CLUSTER_OPS_PER_FRAME_MAX)', () => {
    const ops = Array.from({ length: 600 }, (_, i) => op(`t${i}`));
    const { sent } = packOpsFrame(ops, { scope: 'project', budget: { ...DEFAULT_OP_SEND_BUDGET, maxOps: 10_000 } });
    expect(sent.length).toBeLessThanOrEqual(500);
  });
});

describe('cluster/ops — salvageOps', () => {
  function validOp(entityId: string): Record<string, unknown> {
    return {
      opId: newOpId(),
      nodeId: 'node-a',
      ts: '2026-08-22T00:00:00.000Z',
      scope: 'project',
      projectKey: 'proj-1',
      entity: 'todo',
      entityId,
      op: 'upsert',
      fields: { summary: 'x' },
    };
  }

  it('parses a batch of valid entries with nothing dropped', () => {
    const entries = Array.from({ length: 5 }, (_, i) => validOp(`t${i}`));
    const { ops, dropped } = salvageOps(entries);
    expect(ops).toHaveLength(5);
    expect(dropped).toBe(0);
  });

  it('negative control 1 — one corrupt entry among nine good ones yields nine ops, not zero', () => {
    const good = Array.from({ length: 9 }, (_, i) => validOp(`t${i}`));
    const corrupt = { nodeId: 'node-a' }; // missing every other required field
    const { ops, dropped } = salvageOps([...good.slice(0, 4), corrupt, ...good.slice(4)]);
    expect(ops).toHaveLength(9);
    expect(dropped).toBe(1);
  });

  it('drops non-object junk entries without throwing', () => {
    const { ops, dropped } = salvageOps([validOp('t1'), 'a string', 42, null, ['array']]);
    expect(ops).toHaveLength(1);
    expect(dropped).toBe(4);
  });

  it('D13 — an op carrying an unknown top-level field round-trips unchanged (a newer node wrote it)', () => {
    const withUnknownTop = { ...validOp('t1'), fromAFutureVersion: 'keep me' };
    const { ops, dropped } = salvageOps([withUnknownTop]);
    expect(dropped).toBe(0);
    expect(ops[0]).toMatchObject({ entityId: 't1', fromAFutureVersion: 'keep me' });
  });

  it("D13 — the op's own `unknown` escape-hatch payload round-trips unchanged", () => {
    const withUnknownPayload = { ...validOp('t1'), unknown: { futureField: 42 } };
    const { ops } = salvageOps([withUnknownPayload]);
    expect(ops[0]?.unknown).toEqual({ futureField: 42 });
  });
});

describe('cluster/ops — compactOps', () => {
  function upsert(entityId: string, fields: Record<string, unknown>, ts: string, hubSeq?: number): ClusterOp {
    return {
      opId: newOpId(),
      nodeId: 'node-a',
      ts,
      scope: 'project',
      projectKey: 'proj-1',
      entity: 'todo',
      entityId,
      op: 'upsert',
      fields,
      hubSeq,
    };
  }

  function tombstone(entityId: string, ts: string, hubSeq?: number): ClusterOp {
    return {
      opId: newOpId(),
      nodeId: 'node-a',
      ts,
      scope: 'project',
      projectKey: 'proj-1',
      entity: 'todo',
      entityId,
      op: 'tombstone',
      hubSeq,
    };
  }

  /** An upsert whose deletions matter, not just its sets — the `clearedFields` counterpart of
   *  `upsert` above, for the last-write-wins-per-key tests below. */
  function clear(entityId: string, clearedFields: string[], ts: string, hubSeq?: number): ClusterOp {
    return {
      opId: newOpId(),
      nodeId: 'node-a',
      ts,
      scope: 'project',
      projectKey: 'proj-1',
      entity: 'todo',
      entityId,
      op: 'upsert',
      clearedFields,
      hubSeq,
    };
  }

  it('drops a fully-acked upsert', () => {
    const ops = [upsert('t1', { summary: 'x' }, '2026-08-22T00:00:00.000Z', 1)];
    const out = compactOps(ops, { ackedThroughHubSeq: 1, tombstoneRetentionMs: 60_000 });
    expect(out).toEqual([]);
  });

  it('never drops an op still owed (unacked), regardless of age', () => {
    const old = tombstone('t1', '2000-01-01T00:00:00.000Z'); // ancient, no hubSeq => not acked
    const out = compactOps([old], {
      ackedThroughHubSeq: 999,
      tombstoneRetentionMs: 1,
      now: () => new Date('2030-01-01T00:00:00.000Z'),
    });
    expect(out).toEqual([old]);
  });

  it('keeps an acked tombstone inside its retention window, drops it once the window has passed', () => {
    const t = tombstone('t1', '2026-08-22T00:00:00.000Z', 1);
    const within = compactOps([t], {
      ackedThroughHubSeq: 1,
      tombstoneRetentionMs: 3_600_000,
      now: () => new Date('2026-08-22T00:30:00.000Z'), // 30 min later, inside a 1h window
    });
    expect(within).toEqual([t]);

    const after = compactOps([t], {
      ackedThroughHubSeq: 1,
      tombstoneRetentionMs: 3_600_000,
      now: () => new Date('2026-08-22T02:00:00.000Z'), // 2h later, past the window
    });
    expect(after).toEqual([]);
  });

  it('collapses repeated owed upserts of one entity into one, unioning fields (later key wins)', () => {
    const ops = [
      upsert('t1', { summary: 'first' }, '2026-08-22T00:00:00.000Z'),
      upsert('t1', { priority: 'high' }, '2026-08-22T00:00:01.000Z'),
      upsert('t1', { summary: 'second' }, '2026-08-22T00:00:02.000Z'),
    ];
    const out = compactOps(ops, { ackedThroughHubSeq: 0, tombstoneRetentionMs: 60_000 });
    expect(out).toHaveLength(1);
    expect(out[0]?.fields).toEqual({ summary: 'second', priority: 'high' });
  });

  it('two owed ops for one entity with DISJOINT field sets collapse to one op owing the union of both — the pendingFields amendment requires this, not just permits it', () => {
    const ops = [
      upsert('t1', { status: 'in-progress' }, '2026-08-22T00:00:00.000Z'),
      upsert('t1', { archivedAt: '2026-08-22T00:00:01.000Z' }, '2026-08-22T00:00:01.000Z'),
    ];
    const out = compactOps(ops, { ackedThroughHubSeq: 0, tombstoneRetentionMs: 60_000 });
    expect(out).toHaveLength(1);
    expect(out[0]?.fields).toEqual({ status: 'in-progress', archivedAt: '2026-08-22T00:00:01.000Z' });
    // The floor: "union" must never quietly become "everything". Neither input op owed `summary`
    // or `priority`, so the collapsed op must not carry them either.
    expect(out[0]?.fields).not.toHaveProperty('summary');
    expect(out[0]?.fields).not.toHaveProperty('priority');
    expect(Object.keys(out[0]?.fields ?? {}).sort()).toEqual(['archivedAt', 'status']);
  });

  it('set-then-delete collapses to a delete — the later op wins, per key', () => {
    const ops = [
      upsert('t1', { archivedAt: '2026-08-22T00:00:00.000Z' }, '2026-08-22T00:00:00.000Z'),
      clear('t1', ['archivedAt'], '2026-08-22T00:00:01.000Z'),
    ];
    const out = compactOps(ops, { ackedThroughHubSeq: 0, tombstoneRetentionMs: 60_000 });
    expect(out).toHaveLength(1);
    expect(out[0]?.fields).not.toHaveProperty('archivedAt');
    expect(out[0]?.clearedFields).toEqual(['archivedAt']);
  });

  it('delete-then-set collapses to a set — the later op wins, per key, in the OTHER direction', () => {
    const ops = [
      clear('t1', ['archivedAt'], '2026-08-22T00:00:00.000Z'),
      upsert('t1', { archivedAt: '2026-08-22T00:00:01.000Z' }, '2026-08-22T00:00:01.000Z'),
    ];
    const out = compactOps(ops, { ackedThroughHubSeq: 0, tombstoneRetentionMs: 60_000 });
    expect(out).toHaveLength(1);
    expect(out[0]?.fields).toEqual({ archivedAt: '2026-08-22T00:00:01.000Z' });
    expect(out[0]?.clearedFields).toBeUndefined();
  });

  it('a key never ends up in both fields and clearedFields, across an unrelated set and an unrelated delete in the same run', () => {
    const ops = [
      upsert('t1', { status: 'in-progress' }, '2026-08-22T00:00:00.000Z'),
      clear('t1', ['priority'], '2026-08-22T00:00:01.000Z'),
    ];
    const out = compactOps(ops, { ackedThroughHubSeq: 0, tombstoneRetentionMs: 60_000 });
    expect(out).toHaveLength(1);
    expect(out[0]?.fields).toEqual({ status: 'in-progress' });
    expect(out[0]?.clearedFields).toEqual(['priority']);
    const fieldKeys = new Set(Object.keys(out[0]?.fields ?? {}));
    const clearedKeys = new Set(out[0]?.clearedFields ?? []);
    expect([...fieldKeys].some((k) => clearedKeys.has(k))).toBe(false);
  });

  it('drops stale acked history for an entity that has a newer owed edit, regardless of what the acked op was', () => {
    const ackedTombstone = tombstone('t1', '2000-01-01T00:00:00.000Z', 1);
    const newerOwed = upsert('t1', { summary: 'resurrected' }, '2026-08-22T00:00:00.000Z');
    const out = compactOps([ackedTombstone, newerOwed], {
      ackedThroughHubSeq: 1,
      tombstoneRetentionMs: 60_000,
      now: () => new Date('2026-08-22T00:00:00.000Z'),
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.op).toBe('upsert');
    expect(out[0]?.fields).toEqual({ summary: 'resurrected' });
  });

  it("D13 — an unknown payload survives collapsing (a foreign node's op relayed through this cache)", () => {
    const ops = [
      { ...upsert('t1', { summary: 'a' }, '2026-08-22T00:00:00.000Z'), unknown: { fromNewer: 1 } },
      upsert('t1', { priority: 'low' }, '2026-08-22T00:00:01.000Z'),
    ];
    const out = compactOps(ops, { ackedThroughHubSeq: 0, tombstoneRetentionMs: 60_000 });
    expect(out[0]?.unknown).toEqual({ fromNewer: 1 });
  });

  describe('test 5 — compaction preserves the applied result exactly (property-style, randomised)', () => {
    // Small seeded PRNG (mulberry32) — deterministic across runs, no new dependency.
    function mulberry32(seed: number): () => number {
      let a = seed >>> 0;
      return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    /** Mirrors `collapseOwed`'s own semantics: start empty, and for each op in chronological
     *  order, tombstone (clearing fields — a later upsert is a fresh recreation, not a patch onto
     *  pre-delete content) or merge fields on top of whatever has accumulated since. */
    function applyChronologically(ops: readonly ClusterOp[]): { deleted: boolean; fields: Record<string, unknown> } {
      let deleted = false;
      let fields: Record<string, unknown> = {};
      for (const op of [...ops].sort((a, b) => a.ts.localeCompare(b.ts))) {
        if (op.op === 'tombstone') {
          deleted = true;
          fields = {};
        } else {
          deleted = false;
          if (op.fields) Object.assign(fields, op.fields);
        }
      }
      return { deleted, fields };
    }

    function randomOpSequence(rand: () => number, entityIds: string[], count: number): ClusterOp[] {
      const fieldNames = ['summary', 'priority', 'status', 'whatToDo'];
      const ops: ClusterOp[] = [];
      for (let i = 0; i < count; i += 1) {
        const entityId = entityIds[Math.floor(rand() * entityIds.length)]!;
        const isTombstone = rand() < 0.15;
        const ts = new Date(2026, 0, 1, 0, 0, i).toISOString(); // strictly increasing, one per index
        ops.push(
          isTombstone
            ? { opId: newOpId(), nodeId: 'node-a', ts, scope: 'project', projectKey: 'proj-1', entity: 'todo', entityId, op: 'tombstone' }
            : {
                opId: newOpId(),
                nodeId: 'node-a',
                ts,
                scope: 'project',
                projectKey: 'proj-1',
                entity: 'todo',
                entityId,
                op: 'upsert',
                fields: { [fieldNames[Math.floor(rand() * fieldNames.length)]!]: `v${i}` },
              },
        );
      }
      return ops;
    }

    it('applying the compacted sequence matches applying the original, across many random trials', () => {
      const entityIds = ['t1', 't2', 't3'];
      for (let trial = 0; trial < 200; trial += 1) {
        const rand = mulberry32(trial + 1);
        const ops = randomOpSequence(rand, entityIds, 1 + Math.floor(rand() * 20));
        const compacted = compactOps(ops, { ackedThroughHubSeq: 0, tombstoneRetentionMs: 60_000 });

        for (const entityId of entityIds) {
          const originalForEntity = ops.filter((op) => op.entityId === entityId);
          const compactedForEntity = compacted.filter((op) => op.entityId === entityId);
          if (originalForEntity.length === 0) continue;
          expect(applyChronologically(compactedForEntity)).toEqual(applyChronologically(originalForEntity));
        }
      }
    });
  });
});

/**
 * Verification 2, AMENDED 2026-08-22: "the ops must come from `deriveTodoOps`, not be hand-built."
 * As first written, verification 2 was satisfiable by a fixture the test author typed, which
 * proves the APPLY side and says nothing about whether anything ever EMITS such an op — and
 * nothing did, because `pendingSince` alone cannot say which fields are owed. So this drives the
 * whole thing end to end: two real spokes, each editing a DIFFERENT field of the SAME shared todo
 * through `todos.ts`'s own write path (never a hand-constructed record literal), ops derived by
 * `deriveTodoOps`, applied in sequence via `replica.ts`'s `applyOpToRecord` — the same per-field
 * reducer the hub and a spoke's own replica apply share — standing in for "the hub applies ops in
 * arrival order" (D4).
 */
describe('cluster/ops — end to end: derive from real writes, apply in sequence (Verification 2, AMENDED)', () => {
  let root: string;
  let dirA: string;
  let dirB: string;

  const CLUSTERED: TodoClusterOptions = { clustered: true };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-ops-e2e-'));
    dirA = join(root, 'spoke-a');
    dirB = join(root, 'spoke-b');
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('two spokes edit DIFFERENT fields of one todo while partitioned — both survive when the hub applies both ops in sequence', async () => {
    // A shared baseline, already synced to both spokes (no pendingSince) — simulating a replica
    // push that landed on both before the partition. No `hubSeq` here so the "already applied at
    // the hub" guard in `deriveTodoOps` never fires — irrelevant to what this test checks.
    const baseline: TodoItem = { id: 't-shared', summary: 'Ship it', status: 'todo', priority: 'low' };
    writeFileSync(todosPath(dirA), JSON.stringify([baseline]), 'utf8');
    writeFileSync(todosPath(dirB), JSON.stringify([baseline]), 'utf8');

    // Spoke A edits `status` ONLY, through todos.ts's real write path.
    await updateTodo(dirA, 't-shared', { status: 'in-progress' }, CLUSTERED);
    // Spoke B edits `priority` ONLY, through todos.ts's real write path — it never saw A's edit.
    await updateTodo(dirB, 't-shared', { priority: 'high' }, CLUSTERED);

    const itemsA = await readTodos(dirA, CLUSTERED);
    const itemsB = await readTodos(dirB, CLUSTERED);

    const opA = deriveTodoOps({ nodeId: 'node-a', projectKey: 'proj-1', todos: itemsA, ackedThroughHubSeq: 0 })[0];
    const opB = deriveTodoOps({ nodeId: 'node-b', projectKey: 'proj-1', todos: itemsB, ackedThroughHubSeq: 0 })[0];
    // pendingFields narrowed each op to exactly what its own spoke touched.
    expect(opA?.fields).toEqual({ status: 'in-progress' });
    expect(opB?.fields).toEqual({ priority: 'high' });

    // The hub applies both ops in arrival order, onto the shared baseline.
    const afterA = applyOpToRecord(baseline, opA!);
    const afterBoth = applyOpToRecord(afterA, opB!);
    expect(afterBoth?.status).toBe('in-progress');
    expect(afterBoth?.priority).toBe('high');
  });

  it('negative control — the SAME scenario with whole-record ops (pendingFields stripped, forcing the documented fallback) loses one edit', async () => {
    const baseline: TodoItem = { id: 't-shared', summary: 'Ship it', status: 'todo', priority: 'low' };
    writeFileSync(todosPath(dirA), JSON.stringify([baseline]), 'utf8');
    writeFileSync(todosPath(dirB), JSON.stringify([baseline]), 'utf8');

    await updateTodo(dirA, 't-shared', { status: 'in-progress' }, CLUSTERED);
    await updateTodo(dirB, 't-shared', { priority: 'high' }, CLUSTERED);

    const itemsA = await readTodos(dirA, CLUSTERED);
    const itemsB = await readTodos(dirB, CLUSTERED);

    // Force the pre-amendment shape by stripping `pendingFields` before deriving — this is
    // exactly the documented `deriveTodoOps` fallback ("pendingFields missing → send everything"),
    // driven for real rather than hand-built, so the loss below is the actual code path, not a
    // simulation of it.
    const wholeA = deriveTodoOps({
      nodeId: 'node-a',
      projectKey: 'proj-1',
      todos: itemsA.map((t) => ({ ...t, pendingFields: undefined })),
      ackedThroughHubSeq: 0,
    })[0];
    const wholeB = deriveTodoOps({
      nodeId: 'node-b',
      projectKey: 'proj-1',
      todos: itemsB.map((t) => ({ ...t, pendingFields: undefined })),
      ackedThroughHubSeq: 0,
    })[0];
    // Each spoke's local snapshot only ever saw its OWN edit — B's snapshot still carries the
    // baseline `status`, A's snapshot still carries the baseline `priority`. This is the
    // whole-record content D4 says would clobber.
    expect(wholeA?.fields).toMatchObject({ status: 'in-progress', priority: 'low' });
    expect(wholeB?.fields).toMatchObject({ status: 'todo', priority: 'high' });

    const wholeAfterA = applyOpToRecord(baseline, wholeA!);
    const wholeAfterBoth = applyOpToRecord(wholeAfterA, wholeB!);
    // B's whole-record op, applied second, clobbers A's status edit back to the baseline value —
    // the loss this change exists to prevent. Assert the loss, not just a difference from the
    // positive case above, so this cannot pass against the shape it exists to reject.
    expect(wholeAfterBoth?.priority).toBe('high'); // B's own edit survives (applied last)
    expect(wholeAfterBoth?.status).toBe('todo'); // A's edit is LOST, clobbered by B's stale snapshot
    expect(wholeAfterBoth?.status).not.toBe('in-progress');
  });

  /**
   * `fields` can only express a key being SET — before `clearedFields`, a key deleted locally
   * (`updateTodo({ archived: false })`, `clearStartedTaskId`, `markStarted`'s `delete autostart`)
   * was simply absent from every op and the deletion never reached any other node.
   *
   * **Rewritten 2026-08-23, once `replica.ts` gained its paired delete loop.** This case was first
   * written as a demonstration of the gap: it applied a correctly-shaped op through the real
   * `applyOpToRecord` and asserted the key WRONGLY SURVIVED, because the receiving half was out of
   * that package's scope. It is now the end-to-end proof of the whole path — real write, real
   * derivation, real apply — and the "survives" assertion has become its own opposite. The two
   * controls it grew are what keep it honest: the receiver is shown to have HAD the key (so "gone"
   * is not vacuous), and the same op with `clearedFields` stripped is shown to leave the key alone
   * (so the deletion is attributable to `clearedFields` and not to apply dropping unknown keys).
   */
  it('a real deletion (archived: false) is NAMED as clearedFields by deriveTodoOps and ACTED ON by the real applyOpToRecord', async () => {
    const baseline: TodoItem = { id: 't-shared', summary: 'Ship it', archivedAt: '2026-08-22T00:00:00.000Z' };
    writeFileSync(todosPath(dirA), JSON.stringify([baseline]), 'utf8');

    // The real write path: `archived: false` DELETES the key (todos.ts's updateTodo, not a
    // hand-built record literal).
    await updateTodo(dirA, 't-shared', { archived: false }, CLUSTERED);
    const items = await readTodos(dirA, CLUSTERED);
    expect(items[0]?.archivedAt).toBeUndefined();
    expect(items[0]?.pendingFields).toEqual(['archivedAt']);

    const op = deriveTodoOps({ nodeId: 'node-a', projectKey: 'proj-1', todos: items, ackedThroughHubSeq: 0 })[0]!;
    // The op correctly NAMES the deletion — this is the fix.
    expect(op.clearedFields).toEqual(['archivedAt']);
    expect(op.fields).not.toHaveProperty('archivedAt');

    // Apply this exact, correctly-shaped op through the REAL `applyOpToRecord` — no wrapper, no
    // simulation.
    const receiverBaseline: TodoItem = {
      id: 't-shared',
      summary: 'Ship it',
      archivedAt: '2026-08-22T00:00:00.000Z',
      priority: 'high',
    };
    // FLOOR. "gone after apply" is satisfied by a receiver that never had the key, so say plainly
    // that this one did.
    expect(receiverBaseline.archivedAt).toBe('2026-08-22T00:00:00.000Z');

    const applied = applyOpToRecord(receiverBaseline, op);
    expect(applied?.archivedAt).toBeUndefined();
    // A key the op never named is untouched — the delete loop clears what is LISTED, not whatever
    // the sender happens not to be carrying.
    expect(applied?.priority).toBe('high');
    // And the input is not mutated: `applyOpToRecord` shallow-copies before it writes, which is
    // what lets a caller diff local against applied afterwards.
    expect(receiverBaseline.archivedAt).toBe('2026-08-22T00:00:00.000Z');

    // NEGATIVE CONTROL: the same op with `clearedFields` stripped must leave the key in place.
    // Without this, the assertion above would also pass against an `applyOpToRecord` that dropped
    // every key absent from `fields` — a receiver that deletes by omission, which is exactly the
    // whole-record clobber this design exists to prevent.
    const withoutCleared: ClusterOp = { ...op, clearedFields: undefined };
    expect(applyOpToRecord(receiverBaseline, withoutCleared)?.archivedAt).toBe('2026-08-22T00:00:00.000Z');
  });

  /**
   * **D36 — the resend loop, expressed directly.** Found 2026-08-23 by the first two-process E2E
   * (hub + spoke, real socket): the spoke's replicated row settled at `pendingFields: ["id"]` and
   * stayed there, and `hub-seq.json` climbed ~1 every 5 seconds with the cluster idle (~17,280
   * ops/day) because `deriveTodoOps` re-derived that record on every flush tick, forever.
   *
   * The assertion that matters is NOT "pendingFields is empty" — that is the mechanism, and a fix
   * could satisfy it while still owing an op. It is that **a record the hub has fully
   * acknowledged produces no further ops on the next derive.** That is the loop itself.
   *
   * The floor below is what keeps it non-vacuous: a second derive trivially returns nothing if the
   * first one never produced anything, so the first pass is asserted non-empty before the second
   * is believed.
   */
  it('D36 — a record the hub has fully acknowledged derives NO further ops on the next pass (the every-tick resend loop)', async () => {
    // The real create path, not a record literal: `createTodo` stamps `pendingFields` from
    // `Object.keys(todo)`, which is where `id` — a key no op can ever carry — enters the owed set.
    const created = await createTodo(dirA, { summary: 'Ship it', status: 'todo' }, localCliAuthor('cli-todo-add'), CLUSTERED);
    const items = await readTodos(dirA, CLUSTERED);

    const first = deriveTodoOps({ nodeId: 'node-a', projectKey: 'proj-1', todos: items, ackedThroughHubSeq: 0 });
    // FLOOR — the first pass really did owe something, so "0 on the second pass" means the record
    // settled rather than never having been owed at all.
    expect(first).toHaveLength(1);
    expect(first[0]!.entityId).toBe(created.id);

    // The hub applies the op and echoes it back with its allocated order — the same
    // `applyOpToRecord` reducer the hub and every spoke's replica share.
    const acked: ClusterOp = { ...first[0]!, hubSeq: 7 };
    const settled = applyOpToRecord(items.find((t) => t.id === created.id)!, acked)!;

    // Second derive over post-ack state, at a watermark that covers the hub's own order.
    const second = deriveTodoOps({ nodeId: 'node-a', projectKey: 'proj-1', todos: [settled], ackedThroughHubSeq: 7 });
    expect(second).toEqual([]);
  });

  it('a key that was never touched appears in neither fields nor clearedFields end to end, so a real edit cannot manufacture a phantom deletion of some OTHER field', async () => {
    const baseline: TodoItem = { id: 't-shared', summary: 'Ship it', priority: 'low', status: 'todo' };
    writeFileSync(todosPath(dirA), JSON.stringify([baseline]), 'utf8');

    // Only `status` is touched — `priority` is never named in the patch.
    await updateTodo(dirA, 't-shared', { status: 'done' }, CLUSTERED);
    const items = await readTodos(dirA, CLUSTERED);

    const op = deriveTodoOps({ nodeId: 'node-a', projectKey: 'proj-1', todos: items, ackedThroughHubSeq: 0 })[0]!;
    expect(op.fields).toEqual({ status: 'done' });
    expect(op.clearedFields).toBeUndefined();
  });
});
