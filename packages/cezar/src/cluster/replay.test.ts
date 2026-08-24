import { CLUSTER_FRAME_MAX_BYTES, CLUSTER_PROTOCOL, clusterOpSchema } from '@loki-labs/better-cezar-contract';
import { describe, expect, it } from 'vitest';
import type { TodoItem } from '../todos.ts';
import type { ReplicaFanoutTarget } from './replica-fanout.ts';
import { applyOpToRecord } from './replica.ts';
import { scanForReplay, type ReplayScanInput } from './replay.ts';

/**
 * `cluster/replay.ts` — Design B's engine (its module docblock states four decisions; each is a
 * claim, and each is pinned here). Built before its caller (`hub-router.ts`), so every case drives
 * `scanForReplay` directly rather than through wiring that does not exist yet.
 *
 * **Every test in this file was proven capable of failing** by mutating the specific line of
 * `replay.ts` it covers and observing RED — the mutation ids in the comments (M1, M5, …) are the
 * session's mutation log. Two limits stated rather than papered over:
 *
 *  - The watermark filter and the ascending sort both live in `replica-fanout.ts#owedFor`, not in
 *    `replay.ts`. The cases below pin them as INTEGRATION — that `scanForReplay` hands that
 *    splitter ops in the shape it needs — and are mutation-proven through `replay.ts`'s own lines
 *    (what it stamps as `hubSeq`, what it passes as `targets`/`applied`). Mutating
 *    `replica-fanout.ts` itself was deliberately not done: that file carries another agent's
 *    uncommitted work in this shared checkout, and a restore racing their write would destroy it.
 *  - "Never shipped in a plan" for a record with no `hubSeq` is, on today's code, enforced twice:
 *    once by the `continue` in `scanForReplay` and once — incidentally — by `owedFor`'s
 *    `undefined > W` being false. The `unordered` assertions are what actually hold the guard up;
 *    see the note on that describe block.
 */

const FIXED_NOW = () => new Date('2026-08-23T00:00:00.000Z');
const FIXED_TS = '2026-08-23T00:00:00.000Z';

function makeTodo(fields: Partial<TodoItem> & { id: string; summary: string }): TodoItem {
  return fields as TodoItem;
}

function target(nodeId: string, appliedThroughHubSeq: number): ReplicaFanoutTarget {
  return { nodeId, appliedThroughHubSeq };
}

/** Every case shares one envelope so a test body says only what it is actually about. */
function scan(over: Partial<ReplayScanInput> & Pick<ReplayScanInput, 'todos' | 'targets'>) {
  return scanForReplay({
    hubNodeId: 'hub-1',
    scope: 'project',
    projectKey: 'proj-1',
    now: FIXED_NOW,
    ...over,
  });
}

function shippedIds(result: ReturnType<typeof scanForReplay>): string[] {
  return result.plans.flatMap((p) => p.frames.flatMap((f) => f.changes.map((c) => c.entityId)));
}

function changesFor(result: ReturnType<typeof scanForReplay>, nodeId: string) {
  const plan = result.plans.find((p) => p.nodeId === nodeId);
  return (plan?.frames ?? []).flatMap((f) => f.changes);
}

// ---- watermark semantics -----------------------------------------------------------------------

describe('watermark — a target is owed exactly the records above it, and W=0 means everything', () => {
  it('a target at 0 gets every record; a target already current gets NO plan entry, in the SAME call', () => {
    const result = scan({
      todos: [
        makeTodo({ id: 't1', summary: 'a', priority: 'high', hubSeq: 5 }),
        makeTodo({ id: 't2', summary: 'b', priority: 'low', hubSeq: 8 }),
      ],
      targets: [target('behind', 0), target('current', 8)],
    });

    // FLOOR — the non-vacuous half. A `scanForReplay` hardcoded to return
    // `{ plans: [], excluded: [], unordered: [] }` would satisfy "current gets nothing" below; it
    // cannot satisfy this, which demands a real, populated plan in the very same call.
    const behind = result.plans.find((p) => p.nodeId === 'behind');
    expect(behind).toBeDefined();
    expect(behind!.frames).toHaveLength(1);
    expect(behind!.frames[0]!.changes.map((c) => c.entityId)).toEqual(['t1', 't2']);
    expect(behind!.frames[0]!.hubSeq).toBe(8);

    // "Nothing owed" is the ABSENCE of a plan entry — never a frame with empty `changes`, which is
    // a phantom "something changed" push dressed up as liveness.
    expect(result.plans.find((p) => p.nodeId === 'current')).toBeUndefined();
  });

  it('a record whose hubSeq is exactly AT the watermark is not resent; the one above it is', () => {
    const result = scan({
      todos: [
        makeTodo({ id: 'at', summary: 'a', hubSeq: 5 }),
        makeTodo({ id: 'above', summary: 'b', hubSeq: 6 }),
      ],
      targets: [target('spoke', 5)],
    });

    expect(changesFor(result, 'spoke').map((c) => c.entityId)).toEqual(['above']);
  });

  it('W=0 (a never-seen or freshly-reseeded node) is owed EVERY ordered record, not a suffix', () => {
    const todos = [1, 2, 3, 4, 5].map((n) => makeTodo({ id: `t${n}`, summary: `s${n}`, hubSeq: n }));

    const fresh = scan({ todos, targets: [target('reseeded', 0)] });
    const partial = scan({ todos, targets: [target('partial', 3)] });

    expect(changesFor(fresh, 'reseeded').map((c) => c.hubSeq)).toEqual([1, 2, 3, 4, 5]);
    // CONTROL for the above: the same five records against a non-zero watermark yield a strict
    // subset, so "got everything" is a fact about W=0 and not about the fixture being tiny.
    expect(changesFor(partial, 'partial').map((c) => c.hubSeq)).toEqual([4, 5]);
  });

  it('nothing owed to ANY target means no plan at all — and the same fixture DOES produce one when the watermark drops', () => {
    const todos = [
      makeTodo({ id: 't1', summary: 'a', hubSeq: 2 }),
      makeTodo({ id: 't2', summary: 'b', hubSeq: 3 }),
    ];

    const allCurrent = scan({ todos, targets: [target('a', 3), target('b', 99)] });
    expect(allCurrent.plans).toEqual([]);
    expect(allCurrent.excluded).toEqual([]);
    expect(allCurrent.unordered).toEqual([]);

    // FLOOR — proves the empty result above came from the WATERMARK and not from a fixture that
    // never built any work. Identical `todos`; only the watermarks move.
    const behind = scan({ todos, targets: [target('a', 0), target('b', 0)] });
    expect(behind.plans).toHaveLength(2);
    expect(shippedIds(behind)).toEqual(['t1', 't2', 't1', 't2']);
  });
});

// ---- decision 2 — ordering ---------------------------------------------------------------------

describe('decision 2 — ordering is by hubSeq, not by scan order', () => {
  it('an out-of-scan-order input still produces changes ascending by hubSeq', () => {
    const result = scan({
      // Deliberately shuffled, and deliberately NOT already ascending in any prefix.
      todos: [
        makeTodo({ id: 'd', summary: 'd', hubSeq: 9 }),
        makeTodo({ id: 'a', summary: 'a', hubSeq: 2 }),
        makeTodo({ id: 'c', summary: 'c', hubSeq: 7 }),
        makeTodo({ id: 'b', summary: 'b', hubSeq: 4 }),
      ],
      targets: [target('spoke', 0)],
    });

    const changes = changesFor(result, 'spoke');
    expect(changes.map((c) => c.hubSeq)).toEqual([2, 4, 7, 9]);
    expect(changes.map((c) => c.entityId)).toEqual(['a', 'b', 'c', 'd']);
  });

  it("each frame's own hubSeq is the highest among its changes, across a real multi-frame split", () => {
    // ~90 KB of body each against a 256 KB frame bound — three records cannot share one frame, so
    // this exercises the split rather than asserting over a single frame that never split.
    const body = 'x'.repeat(90 * 1024);
    const result = scan({
      todos: [
        makeTodo({ id: 'third', summary: 'c', whatToDo: body, hubSeq: 30 }),
        makeTodo({ id: 'first', summary: 'a', whatToDo: body, hubSeq: 10 }),
        makeTodo({ id: 'second', summary: 'b', whatToDo: body, hubSeq: 20 }),
      ],
      targets: [target('spoke', 0)],
    });

    const frames = result.plans.find((p) => p.nodeId === 'spoke')!.frames;
    // FLOOR — if this were 1 the "across frames" claims below would be vacuously true.
    expect(frames.length).toBeGreaterThan(1);

    for (const frame of frames) {
      expect(frame.hubSeq).toBe(Math.max(...frame.changes.map((c) => c.hubSeq!)));
    }
    // Frames themselves ascend, and the concatenation is exactly what was owed, in hub order —
    // splitting never reorders or drops.
    expect(frames.map((f) => f.hubSeq)).toEqual([...frames.map((f) => f.hubSeq)].sort((a, b) => a - b));
    expect(frames.flatMap((f) => f.changes.map((c) => c.hubSeq))).toEqual([10, 20, 30]);
  });
});

// ---- decision 1 — a record with no hubSeq ------------------------------------------------------

describe('decision 1 — a record with no hubSeq is surfaced in `unordered`, never shipped as ordered', () => {
  // NOTE on what actually holds this guard up. "Not shipped" is currently true for TWO independent
  // reasons: `scanForReplay`'s `continue`, and `owedFor` dropping an op whose `hubSeq` is
  // `undefined` (`undefined > W` is false). So a `shipped).not.toContain(...)` assertion alone is
  // NOT load-bearing — deleting the `continue` leaves it green. The `unordered` assertions are the
  // ones that fail when the guard goes (mutation M1/M2), which is why every case here asserts both
  // halves and never only the negative one.

  it('reports it in `unordered` and ships every ordered record around it', () => {
    const result = scan({
      todos: [
        makeTodo({ id: 'no-seq', summary: 'never reached the hub' }),
        makeTodo({ id: 'ordinary', summary: 'ordinary', hubSeq: 3 }),
      ],
      targets: [target('spoke', 0)],
    });

    expect(result.unordered).toEqual([{ entity: 'todo', entityId: 'no-seq' }]);
    // FLOOR — the scan did real work; `unordered` is not just "everything failed".
    expect(shippedIds(result)).toEqual(['ordinary']);
  });

  it('is reported ONCE regardless of how many targets there are, and reaches none of them', () => {
    const result = scan({
      todos: [
        makeTodo({ id: 'no-seq', summary: 'unordered' }),
        makeTodo({ id: 'ordinary', summary: 'ordinary', hubSeq: 3 }),
      ],
      targets: [target('a', 0), target('b', 0), target('c', 0)],
    });

    // `unordered` is a property of the RECORD, not of a target pairing — unlike `excluded`, which
    // is per-target by design (see the oversized block below).
    expect(result.unordered).toEqual([{ entity: 'todo', entityId: 'no-seq' }]);
    // FLOOR — all three targets really were served, so "reached none of them" is not "there were
    // no targets".
    expect(result.plans.map((p) => p.nodeId)).toEqual(['a', 'b', 'c']);
    expect(shippedIds(result)).toEqual(['ordinary', 'ordinary', 'ordinary']);
  });

  it('is reported even when there are NO targets — it is not a by-product of fan-out', () => {
    const result = scan({
      todos: [makeTodo({ id: 'no-seq', summary: 'unordered' }), makeTodo({ id: 'ordinary', summary: 'x', hubSeq: 3 })],
      targets: [],
    });

    expect(result.unordered).toEqual([{ entity: 'todo', entityId: 'no-seq' }]);
    expect(result.plans).toEqual([]);
  });

  it('a TOMBSTONED record with no hubSeq is also unordered — the tombstone shortcut does not bypass the guard', () => {
    const result = scan({
      todos: [
        makeTodo({ id: 'gone-unordered', summary: 'y', tombstone: { at: FIXED_TS } }),
        makeTodo({ id: 'gone-ordered', summary: 'z', tombstone: { at: FIXED_TS }, hubSeq: 4 }),
      ],
      targets: [target('spoke', 0)],
    });

    expect(result.unordered).toEqual([{ entity: 'todo', entityId: 'gone-unordered' }]);
    // FLOOR + control: an otherwise identical tombstone that DOES have a hubSeq ships normally, so
    // the exclusion is about the missing hubSeq and not about tombstones.
    expect(shippedIds(result)).toEqual(['gone-ordered']);
  });
});

// ---- decision 3 — the D29/3b interaction -------------------------------------------------------

describe('decision 3 — an oversized record is excluded and surfaced, never thrown', () => {
  it('reports it in `excluded` with its real measured size, and still ships everything else', () => {
    const huge = 'x'.repeat(2_000_000); // alone, far over CLUSTER_FRAME_MAX_BYTES
    const result = scan({
      todos: [
        makeTodo({ id: 'big', summary: 'oversized', whatToDo: huge, hubSeq: 1 }),
        makeTodo({ id: 'small', summary: 'ordinary', hubSeq: 2 }),
      ],
      targets: [target('spoke', 0)],
    });

    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0]).toMatchObject({ nodeId: 'spoke', entity: 'todo', entityId: 'big', hubSeq: 1 });
    expect(result.excluded[0]!.bytes).toBeGreaterThan(CLUSTER_FRAME_MAX_BYTES);
    expect(result.excluded[0]!.opId).toBeTruthy();

    // FLOOR — the rest of the scan is not collateral damage, and the target still gets a plan.
    expect(shippedIds(result)).toEqual(['small']);
  });

  it('is reported once PER target that owed it — each target gap is independent', () => {
    const huge = 'x'.repeat(2_000_000);
    const result = scan({
      todos: [
        makeTodo({ id: 'big', summary: 'oversized', whatToDo: huge, hubSeq: 5 }),
        makeTodo({ id: 'small', summary: 'ordinary', hubSeq: 6 }),
      ],
      // 'ahead' is past the oversized record and must NOT get an exclusion entry for it.
      targets: [target('a', 0), target('b', 0), target('ahead', 5)],
    });

    expect(result.excluded.map((e) => e.nodeId)).toEqual(['a', 'b']);
    // FLOOR + control: 'ahead' really was in the call and really was served, so its absence from
    // `excluded` is the watermark filter working, not the target being missing.
    expect(changesFor(result, 'ahead').map((c) => c.entityId)).toEqual(['small']);
  });

  it('a target whose ONLY owed record is oversized gets no plan entry, not an empty one', () => {
    const huge = 'x'.repeat(2_000_000);
    const result = scan({
      todos: [
        makeTodo({ id: 'big', summary: 'oversized', whatToDo: huge, hubSeq: 9 }),
        makeTodo({ id: 'small', summary: 'ordinary', hubSeq: 2 }),
      ],
      targets: [target('only-big', 8), target('gets-both', 0)],
    });

    expect(result.plans.find((p) => p.nodeId === 'only-big')).toBeUndefined();
    expect(result.excluded.map((e) => e.nodeId)).toContain('only-big');
    // FLOOR — the fixture does produce a plan for a target that can be served.
    expect(changesFor(result, 'gets-both').map((c) => c.entityId)).toEqual(['small']);
  });
});

// ---- decision 4 — the whole-row projection -----------------------------------------------------

describe('decision 4 — whole-row projection: fields, clearedFields, unknown', () => {
  it('a present declared field lands in `fields`; an absent one lands in `clearedFields`; never both', () => {
    const result = scan({
      todos: [makeTodo({ id: 't1', summary: 'x', priority: 'high', hubSeq: 1 })], // `status` absent
      targets: [target('spoke', 0)],
    });

    const op = changesFor(result, 'spoke')[0]!;
    expect(op.fields).toMatchObject({ summary: 'x', priority: 'high' });
    expect(op.clearedFields).toContain('status');
    expect(op.clearedFields).toContain('context');
    expect(op.clearedFields).not.toContain('priority');
    expect(op.clearedFields).not.toContain('summary');

    // The contract's own invariant, asserted over EVERY key rather than the two spot-checked above
    // — a key in both would make "set" and "delete" of the same field arrive in one op.
    const inBoth = (op.clearedFields ?? []).filter((k) => k in (op.fields ?? {}));
    expect(inBoth).toEqual([]);
    // FLOOR — both sides are actually populated, so "no overlap" is not "one side is empty".
    expect(Object.keys(op.fields ?? {}).length).toBeGreaterThan(0);
    expect((op.clearedFields ?? []).length).toBeGreaterThan(0);
  });

  it('never projects a cluster bookkeeping field or `id` as content — in `fields` or in `clearedFields`', () => {
    // The set `replay.ts` keeps in step with `ops.ts#CLUSTER_META_TODO_FIELDS` BY HAND. This pins
    // it so a drift in either direction is a red test rather than a field that silently starts (or
    // stops) replicating.
    const META = ['id', 'pendingSince', 'pendingFields', 'hubSeq', 'tombstone', 'startedOn'];
    const result = scan({
      todos: [
        makeTodo({
          id: 't1',
          summary: 'x',
          hubSeq: 7,
          startedOn: 'node-b',
          pendingSince: FIXED_TS,
          pendingFields: ['summary'],
        }),
      ],
      targets: [target('spoke', 0)],
    });

    const op = changesFor(result, 'spoke')[0]!;
    for (const key of META) {
      expect({ key, inFields: key in (op.fields ?? {}) }).toEqual({ key, inFields: false });
      expect({ key, inCleared: (op.clearedFields ?? []).includes(key) }).toEqual({ key, inCleared: false });
    }
    // FLOOR — this record really did carry `startedOn`/`pendingSince`/`pendingFields` values, so
    // "not in fields" is a projection decision and not an empty record.
    expect(op.fields).toMatchObject({ summary: 'x' });
    expect(op.hubSeq).toBe(7);
  });

  it('a record carrying EVERY declared content field emits no `clearedFields` key at all', () => {
    // The other side of the ternary, and the only input that reaches it. It doubles as a drift pin
    // on the projected field set: adding a field to `todoSchema` without adding it here turns this
    // red, which is the point — `CLUSTER_META_KEYS` is kept in step with `ops.ts` BY HAND, and a
    // hand-kept set that nothing checks is how a field silently stops replicating.
    const everyField: Record<string, unknown> = {
      id: 't1',
      hubSeq: 1,
      ts: FIXED_TS,
      taskId: 'task-1',
      summary: 'x',
      action: 'do it',
      prUrl: 'https://example.invalid/pr/1',
      suggestedSkill: 'skill',
      suggestedArgs: '--flag',
      suggestedPrompt: 'prompt',
      runnable: true,
      startedTaskId: 'started-1',
      status: 'todo',
      priority: 'high',
      archivedAt: FIXED_TS,
      context: 'why',
      whatToDo: 'the work',
      acceptanceCriteria: ['it works'],
      knowledgeRefs: [{ project: 'p', slug: 's', title: 't' }],
      origin: 'agent',
      autostart: false,
      author: { kind: 'user', id: 'local', via: 'composer', at: FIXED_TS },
      placement: { node: 'node-a' },
    };

    const result = scan({ todos: [everyField as unknown as TodoItem], targets: [target('spoke', 0)] });
    const op = changesFor(result, 'spoke')[0]!;

    expect(op.clearedFields).toBeUndefined();
    expect('clearedFields' in op && op.clearedFields !== undefined).toBe(false);
    // FLOOR — the fixture really did cover every declared content key, so "nothing cleared" is
    // completeness and not a projection that quietly stopped emitting `clearedFields`.
    expect(Object.keys(op.fields ?? {}).sort()).toEqual(
      Object.keys(everyField)
        .filter((k) => k !== 'id' && k !== 'hubSeq')
        .sort(),
    );
    expect(Object.keys(op.fields ?? {})).toHaveLength(21);
  });

  it('`placement` rides as ordinary content — the deliberate divergence from the full cluster field set', () => {
    const result = scan({
      todos: [makeTodo({ id: 't1', summary: 'x', hubSeq: 1, placement: { node: 'node-pin' } })],
      targets: [target('spoke', 0)],
    });

    expect(changesFor(result, 'spoke')[0]!.fields).toMatchObject({ placement: { node: 'node-pin' } });
  });

  it('a field this schema does not recognize (D13) rides in `unknown`, and an ordinary record has no `unknown` at all', () => {
    const result = scan({
      todos: [
        makeTodo({ id: 'newer', summary: 'x', hubSeq: 1, futureField: 'from-a-newer-node' } as Partial<TodoItem> & {
          id: string;
          summary: string;
        }),
        makeTodo({ id: 'ordinary', summary: 'y', hubSeq: 2 }),
      ],
      targets: [target('spoke', 0)],
    });

    const [newer, ordinary] = changesFor(result, 'spoke');
    expect(newer!.unknown).toEqual({ futureField: 'from-a-newer-node' });
    expect((newer!.fields as Record<string, unknown>).futureField).toBeUndefined();
    expect(newer!.clearedFields ?? []).not.toContain('futureField');
    // CONTROL — `unknown` is omitted entirely when there is nothing unrecognized, so the assertion
    // above is about the extra key and not about `unknown` always being set.
    expect(ordinary!.unknown).toBeUndefined();
  });

  it('a tombstoned record replays as `op: "tombstone"` carrying no content at all', () => {
    const result = scan({
      todos: [
        makeTodo({ id: 'gone', summary: 'deleted', priority: 'high', tombstone: { at: FIXED_TS }, hubSeq: 12 }),
        makeTodo({ id: 'alive', summary: 'kept', hubSeq: 13 }),
      ],
      targets: [target('spoke', 0)],
    });

    const [gone, alive] = changesFor(result, 'spoke');
    expect(gone!.op).toBe('tombstone');
    expect(gone!.fields).toBeUndefined();
    expect(gone!.clearedFields).toBeUndefined();
    // CONTROL — an ordinary record in the same scan takes the other branch, so `op: 'tombstone'`
    // is a decision about this record rather than what every op gets.
    expect(alive!.op).toBe('upsert');
    expect(alive!.fields).toMatchObject({ summary: 'kept' });
  });

  it('every op it emits validates against the wire contract (`clusterOpSchema`, which is .strict())', () => {
    const result = scan({
      todos: [
        makeTodo({ id: 'up', summary: 'x', priority: 'low', hubSeq: 1 }),
        makeTodo({ id: 'gone', summary: 'y', tombstone: { at: FIXED_TS }, hubSeq: 2 }),
        makeTodo({ id: 'weird', summary: 'z', hubSeq: 3, futureField: 1 } as Partial<TodoItem> & {
          id: string;
          summary: string;
        }),
      ],
      targets: [target('spoke', 0)],
    });

    const changes = changesFor(result, 'spoke');
    expect(changes).toHaveLength(3); // FLOOR — the loop below is not iterating an empty list.
    for (const op of changes) {
      const parsed = clusterOpSchema.safeParse(op);
      expect({ entityId: op.entityId, ok: parsed.success, issues: parsed.error?.issues }).toMatchObject({
        entityId: op.entityId,
        ok: true,
      });
    }
  });
});

// ---- D27, the receiving half replay's correctness is declared to depend on ----------------------

describe('D27 integration — a whole-row replay op settles fields by NAME on the receiver', () => {
  it("resolves a receiver's pending field the op speaks to, and leaves one it does not name alone", () => {
    const result = scan({
      todos: [makeTodo({ id: 't1', summary: 'hub-summary', priority: 'high', hubSeq: 9 })],
      targets: [target('spoke', 0)],
    });
    const op = changesFor(result, 'spoke')[0]!;

    // The receiver has its own un-sent edits on `summary` (which the op DOES name) and on
    // `futureField` (which this build's schema does not declare, so the whole-row projection never
    // named it — the gap decision 4 states plainly rather than claims to close).
    const receiver = makeTodo({
      id: 't1',
      summary: 'local-summary',
      priority: 'high',
      pendingSince: '2026-08-22T00:00:00.000Z',
      pendingFields: ['summary', 'futureField'],
    });

    const applied = applyOpToRecord(receiver, op)!;
    expect(applied.summary).toBe('hub-summary'); // hub wins on the field the op names (D27 dec. 2)
    // `futureField` was never named, so the record is still owed and the marker must survive —
    // clearing it here is precisely the silent write-loss D27 exists to prevent.
    expect(applied.pendingFields).toEqual(['futureField']);
    expect(applied.pendingSince).toBe('2026-08-22T00:00:00.000Z');
  });

  it("CHARACTERIZATION — a record with a STALE hubSeq and its own un-acked edit IS shipped, at that stale position", () => {
    // NOT an endorsement. This pins observed behaviour so the gap is visible in the suite rather
    // than only in a report, and so a deliberate change to it shows up as a red test.
    //
    // Decision 1 excludes a record with NO `hubSeq` because shipping it "would hand a target a
    // value with no ordering guarantee behind it, which is worse than not sending it". The guard is
    // `todo.hubSeq === undefined` — a PRESENCE check. A record the hub confirmed at hubSeq 5 and
    // then edited LOCALLY (the docblock's own case: "the hub can carry its own `pendingSince` state
    // exactly like a spoke can") still has a hubSeq, so it is shipped — carrying the post-edit
    // value, stamped at 5, a position the hub never ordered THAT value at.
    //
    // This is NOT a narrow race window. `pendingSince` is set in one place (`todos.ts#stampPending`)
    // and deleted in exactly ONE (`replica.ts:234`, inside `applyOpToRecord`), which runs only on a
    // RECEIVED replica frame — and `hub-router.ts` builds replica targets from peer pairings, so the
    // hub is never its own target. A hub-local edit to an already-ordered record therefore keeps
    // `pendingSince` set and `hubSeq` stale indefinitely, and `hub-router.ts:426` re-ships it to
    // every reconnecting node on every handshake.
    //
    // Note the inconsistency this sits in: `todos.ts:912`/`:936` guard the ack path with
    // `if (!item.pendingSince) item.hubSeq = ack.hubSeq` — refusing to advance `hubSeq` for exactly
    // the records this projection happily stamps AT their stale `hubSeq`. Two places, opposite
    // readings of the same marker.
    const hubRecord = {
      id: 'T',
      summary: 's',
      priority: 'low', // the hub's OPTIMISTIC local value — not yet hub-ordered
      hubSeq: 5, // …but the record still carries its last CONFIRMED order
      pendingSince: FIXED_TS,
      pendingFields: ['priority'],
    } as unknown as TodoItem;

    const result = scan({ todos: [hubRecord], targets: [target('S', 4)] });
    const op = changesFor(result, 'S')[0]!;

    expect(result.unordered).toEqual([]); // the presence check does not catch this record
    expect(op.hubSeq).toBe(5);
    expect(op.fields).toMatchObject({ priority: 'low' });

    // The consequence on the receiver, which is what makes this worth pinning: a spoke's OWN
    // pending edit to the same field is resolved away by that unordered value — D27 narrows by
    // NAME and the whole-row op names `priority`, so the spoke's edit is dropped from its outbox
    // (`deriveTodoOps` reads `pendingSince`) with no error and no trace.
    const spoke = {
      id: 'T',
      summary: 's',
      priority: 'high', // the spoke's own un-sent edit
      pendingSince: '2026-08-22T00:00:00.000Z',
      pendingFields: ['priority'],
    } as unknown as TodoItem;

    const after = applyOpToRecord(spoke, op)!;
    expect(after.priority).toBe('low');
    expect(after.pendingSince).toBeUndefined();
    expect(after.pendingFields).toBeUndefined();
  });

  it('a replayed tombstone reaches a node that has never seen the record and lands as a deletion', () => {
    const result = scan({
      todos: [makeTodo({ id: 'gone', summary: 'deleted', tombstone: { at: FIXED_TS }, hubSeq: 12 })],
      targets: [target('spoke', 0)],
    });

    const applied = applyOpToRecord(undefined, changesFor(result, 'spoke')[0]!);
    expect(applied?.tombstone).toBeDefined();
  });
});

// ---- the envelope: attribution, scope, clock ---------------------------------------------------

describe('envelope — attribution, scope/projectKey, and the injected clock', () => {
  it('attributes every synthesized op to the hub doing the replaying, not to the record', () => {
    const result = scan({
      hubNodeId: 'the-hub',
      todos: [
        makeTodo({ id: 't1', summary: 'x', hubSeq: 1, startedOn: 'some-other-node' }),
        makeTodo({ id: 't2', summary: 'y', hubSeq: 2 }),
      ],
      targets: [target('spoke', 0)],
    });

    const changes = changesFor(result, 'spoke');
    expect(changes).toHaveLength(2); // FLOOR
    expect(changes.map((c) => c.nodeId)).toEqual(['the-hub', 'the-hub']);
  });

  it('carries the scope and projectKey it was given, on the op and on the frame', () => {
    const result = scan({
      scope: 'workspace',
      projectKey: 'a-specific-project',
      todos: [makeTodo({ id: 't1', summary: 'x', hubSeq: 1 })],
      targets: [target('spoke', 0)],
    });

    const frame = result.plans[0]!.frames[0]!;
    expect(frame.type).toBe('replica');
    expect(frame.protocol).toBe(CLUSTER_PROTOCOL);
    expect(frame.scope).toBe('workspace');
    expect(frame.projectKey).toBe('a-specific-project');
    expect(frame.changes[0]!.scope).toBe('workspace');
    expect(frame.changes[0]!.projectKey).toBe('a-specific-project');
  });

  it('omits projectKey entirely when none was given, rather than sending it as undefined', () => {
    const result = scanForReplay({
      hubNodeId: 'hub-1',
      scope: 'workspace',
      todos: [makeTodo({ id: 't1', summary: 'x', hubSeq: 1 })],
      targets: [target('spoke', 0)],
      now: FIXED_NOW,
    });

    const op = result.plans[0]!.frames[0]!.changes[0]!;
    expect('projectKey' in op).toBe(false);
    // FLOOR — the op is otherwise fully built, so the missing key is the spread and not a dead scan.
    expect(op.fields).toMatchObject({ summary: 'x' });
  });

  it('stamps `ts` from the INJECTED clock — no clock beyond `now`, as the docblock claims', () => {
    const calls: string[] = [];
    const injected = () => {
      calls.push('called');
      return new Date('1999-12-31T23:59:59.000Z');
    };

    const result = scan({
      now: injected,
      todos: [
        makeTodo({ id: 't1', summary: 'x', hubSeq: 1 }),
        makeTodo({ id: 't2', summary: 'y', hubSeq: 2 }),
      ],
      targets: [target('spoke', 0)],
    });

    const changes = changesFor(result, 'spoke');
    expect(changes).toHaveLength(2); // FLOOR — two ops, so `every` below is not vacuous.
    // A hardcoded date, deliberately in the past: a `new Date()` slipping in anywhere would produce
    // a 2026 timestamp and fail this outright.
    expect(changes.map((c) => c.ts)).toEqual(['1999-12-31T23:59:59.000Z', '1999-12-31T23:59:59.000Z']);
    expect(calls.length).toBeGreaterThan(0);
  });

  it('is pure — it does not mutate the todos or targets it was handed', () => {
    const todos = [
      Object.freeze(makeTodo({ id: 't1', summary: 'x', hubSeq: 1 })),
      Object.freeze(makeTodo({ id: 'no-seq', summary: 'y' })),
    ];
    const targets = [Object.freeze(target('spoke', 0))];
    Object.freeze(todos);
    Object.freeze(targets);

    // Frozen inputs: any write to them throws in ESM strict mode, so a mutation is a thrown error
    // here rather than a silent one a snapshot comparison might miss.
    const result = scan({ todos, targets });

    expect(shippedIds(result)).toEqual(['t1']); // FLOOR — it really ran and really produced work.
    expect(result.unordered).toEqual([{ entity: 'todo', entityId: 'no-seq' }]);
    expect(todos.map((t) => t.id)).toEqual(['t1', 'no-seq']);
  });
});

// ---- idempotence ------------------------------------------------------------------------------

describe('idempotence — two scans from the same watermark plan the same work', () => {
  /** Everything a scan produces except `opId`, which is a fresh `randomUUID()` per op — see the
   *  case below, which pins that nondeterminism rather than hiding it inside this helper. */
  const withoutOpIds = (r: ReturnType<typeof scanForReplay>) =>
    JSON.parse(
      JSON.stringify(r, (key, value) => (key === 'opId' ? undefined : value)),
    ) as unknown;

  it('produces an identical plan, frame-for-frame and field-for-field, apart from opId', () => {
    const input = {
      todos: [
        makeTodo({ id: 'c', summary: 'c', hubSeq: 30 }),
        makeTodo({ id: 'a', summary: 'a', priority: 'high', hubSeq: 10 }),
        makeTodo({ id: 'no-seq', summary: 'u' }),
        makeTodo({ id: 'b', summary: 'b', tombstone: { at: FIXED_TS }, hubSeq: 20 }),
      ],
      targets: [target('spoke', 5), target('other', 20)],
    };

    const first = scan(input);
    const second = scan(input);

    // FLOOR — both scans did real, non-trivial work across two targets and all three buckets.
    expect(shippedIds(first)).toEqual(['a', 'b', 'c', 'c']);
    expect(first.unordered).toHaveLength(1);
    expect(withoutOpIds(second)).toEqual(withoutOpIds(first));
  });

  it('DOES mint a fresh opId on every scan — the one thing about it that is not deterministic', () => {
    // Not a bug report dressed as a test: this pins observed behaviour so a future change to it is
    // visible. `scanForReplay`'s docblock claims "no clock beyond the injected `now`" and offers
    // `now` as the determinism seam — but `projectWholeRow` also calls `ops.ts#newOpId()`
    // (`randomUUID()`), so an identical input cannot produce an identical output, injected clock or
    // not. See this session's report for why that is worth knowing at the call site.
    const input = { todos: [makeTodo({ id: 't1', summary: 'x', hubSeq: 1 })], targets: [target('spoke', 0)] };

    const a = changesFor(scan(input), 'spoke')[0]!;
    const b = changesFor(scan(input), 'spoke')[0]!;

    expect(a.opId).toBeTruthy();
    expect(b.opId).not.toBe(a.opId);
    expect(a.entityId).toBe(b.entityId); // the rest of the op IS stable
  });
});

// ---- the mixed scan ----------------------------------------------------------------------------

describe('a mixed scan routes every record to exactly one bucket', () => {
  it('ordered, unordered, oversized and tombstoned records together, across two watermarks', () => {
    const huge = 'x'.repeat(2_000_000);
    const result = scan({
      todos: [
        makeTodo({ id: 'no-seq', summary: 'never reached the hub' }),
        makeTodo({ id: 'ordinary', summary: 'x', hubSeq: 3 }),
        makeTodo({ id: 'gone', summary: 'y', tombstone: { at: FIXED_TS }, hubSeq: 4 }),
        makeTodo({ id: 'big', summary: 'z', whatToDo: huge, hubSeq: 5 }),
      ],
      targets: [target('far-behind', 0), target('mid', 3)],
    });

    expect(result.unordered).toEqual([{ entity: 'todo', entityId: 'no-seq' }]);
    expect(changesFor(result, 'far-behind').map((c) => c.entityId)).toEqual(['ordinary', 'gone']);
    expect(changesFor(result, 'mid').map((c) => c.entityId)).toEqual(['gone']);
    expect(result.excluded.map((e) => `${e.nodeId}:${e.entityId}`)).toEqual(['far-behind:big', 'mid:big']);
  });
});
