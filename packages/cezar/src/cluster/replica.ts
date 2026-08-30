import { isDeepStrictEqual } from 'node:util';
import type { ClusterOp, ClusterReplicaCorrection, ClusterReplicaFrame } from '@loki-labs/cezar-plus-contract';
import type { TodoItem } from '../todos.ts';
import { CLUSTER_META_TODO_FIELDS } from './ops.ts';

/**
 * Applying a hub replica push over local + pending state — **pure**, no I/O, no clock beyond the
 * injected `now` (spec `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, D4 · D5 · D6 · D7 · D13).
 *
 * The hub linearizes, so there is no merge here and nothing to get right about ordering: `changes`
 * arrive in hub order and are applied in it. What this file owes is four properties, and they are
 * the ones package 2.2's tests pin:
 *
 *  1. **Idempotent.** A change at or below `appliedThroughHubSeq` is skipped, not re-applied — the
 *     link resumes ~10 times a day around the hub's blue-green deploys, and a resumed frame overlaps
 *     by design.
 *  2. **Per-field.** An op carries only what changed, so two spokes that edited *different* fields
 *     of one todo while partitioned both survive. Applying a whole record would clobber the first,
 *     which is the failure the superseded CRDT design existed to avoid, reached by another route.
 *  3. **Tombstones, both directions.** A delete is a tombstone (D6); a later upsert at a higher
 *     `hubSeq` resurrects the row, and an earlier one does not.
 *  4. **Unknown fields round-trip.** An op field this node's schema does not know is preserved
 *     verbatim, so an older node in the cluster cannot truncate everyone's history (D13).
 *
 * **The corrections are the point of the return value.** When the hub's applied result differs from
 * the optimistic local value, the cockpit must SHOW that it changed rather than swapping the value
 * under the reader (D4). A silent correction is indistinguishable from the local write never having
 * happened.
 *
 * The caller writes the result through `todos.ts`'s `applyHubReplica`, under the existing
 * `withTodosLease` (D7) — never by writing the file — so the existing `fs.watch` fires and the board
 * updates with no new read path anywhere. That is the caller's job, not this file's: this file
 * computes and returns.
 *
 * **CORRECTED 2026-08-23 — the merge landed, and this file's own casts are gone.** This paragraph
 * used to say `TodoItem` does not carry the cluster fields yet, and that `ClusteredTodoItem` below
 * is this file's own typed view of a record that DOES carry them (it also said "five" fields;
 * `pendingFields` was added after this note was written, making six — see the contract's
 * `clusterTodoFieldsSchema`). Package 2.3 spread `clusterTodoFieldsSchema.shape` verbatim into
 * `todoSchema` (`todos.ts`), so `TodoItem` now carries all six — `pendingSince`, `pendingFields`,
 * `hubSeq`, `tombstone`, `placement`, `startedOn` — with the exact same zod definitions, and
 * `TodoItem` structurally satisfies `ClusterTodoFields` on its own. The intersection below is gone;
 * every function in this file now reads and builds a plain `TodoItem`, with no cast needed anywhere
 * a `ClusteredTodoItem` used to be threaded through.
 *
 * `ClusteredTodoItem` itself is now gone. It was kept a while longer than the intersection above,
 * as a plain alias, because `todo-autostart.ts` imported it by name and sat outside this
 * package's scope for that change. It has since been switched to `TodoItem` directly — the last
 * caller keeping the name alive — so there is no second spelling of this record's type left
 * anywhere in this package.
 */

export interface ReplicaApplyInput {
  /** This node's records as they stand, including optimistic writes still marked `pendingSince`. */
  local: readonly TodoItem[];
  /** This node's own ops the hub has not acknowledged. A local optimistic value the hub has not
   *  seen must not be reported as a correction — it has not been decided yet. */
  pending: readonly ClusterOp[];
  /** The hub's push, in hub order. */
  changes: readonly ClusterOp[];
  /** The highest hub order this node has already applied. */
  appliedThroughHubSeq: number;
  now?: () => Date;
}

export interface ReplicaApplyResult {
  todos: TodoItem[];
  corrections: ClusterReplicaCorrection[];
  appliedThroughHubSeq: number;
  /** Changes dropped as already-applied. A resumed link makes this routinely non-zero, so it is a
   *  number, not a warning. */
  skipped: number;
}

export function applyReplica(input: ReplicaApplyInput): ReplicaApplyResult {
  const now = input.now ?? (() => new Date());

  // "Order-declared, not order-sensitive" (property 1): the hub's `hubSeq` IS the order, so this
  // sorts before applying rather than trusting the caller's array order. A resumed link, or a
  // frame relayed through an intermediary, is not guaranteed to preserve arrival order — the
  // number is what is guaranteed.
  const ordered = [...input.changes].sort((a, b) => (a.hubSeq ?? 0) - (b.hubSeq ?? 0));

  const byId = new Map<string, TodoItem>(input.local.map((t) => [t.id, t]));
  // Entities the hub has spoken about in THIS push (applied or skipped-as-already-applied both
  // count: either way, the hub has an opinion as of some `hubSeq`).
  const spoken = new Set<string>();

  let appliedThroughHubSeq = input.appliedThroughHubSeq;
  let skipped = 0;

  for (const change of ordered) {
    // This module owns todos only (Phase 2's scope). A 'run' or 'triage' op still advances the
    // watermark below — the watermark is per SCOPE, shared across entity kinds — but it has no
    // record here to apply onto.
    if (change.entity === 'todo') spoken.add(change.entityId);

    if (change.hubSeq !== undefined && change.hubSeq <= input.appliedThroughHubSeq) {
      skipped++;
      if (change.hubSeq > appliedThroughHubSeq) appliedThroughHubSeq = change.hubSeq;
      continue;
    }

    if (change.entity === 'todo') {
      const before = byId.get(change.entityId);
      const after = applyOpToRecord(before, change);
      if (after === undefined) byId.delete(change.entityId);
      else byId.set(change.entityId, after);
    }

    if (change.hubSeq !== undefined && change.hubSeq > appliedThroughHubSeq) {
      appliedThroughHubSeq = change.hubSeq;
    }
  }

  // Corrections: for every entity this node still has an outstanding (unacknowledged) local
  // write on, compare what we were optimistically showing BEFORE this push against what the hub
  // push settled it to. Fields the hub never touched in this push produce no difference (before
  // === after for them), so an op the hub "has not seen" is correctly never reported — nothing in
  // `spoken`/`byId` moved for it.
  const corrections: ClusterReplicaCorrection[] = [];
  for (const pendingOp of input.pending) {
    if (pendingOp.entity !== 'todo' || !spoken.has(pendingOp.entityId)) continue;
    const before = input.local.find((t) => t.id === pendingOp.entityId);
    const after = byId.get(pendingOp.entityId);
    corrections.push(...diffCorrections(before, after, pendingOp, now));
  }

  return {
    todos: Array.from(byId.values()),
    corrections,
    appliedThroughHubSeq,
    skipped,
  };
}

/** Convenience over `applyReplica` for the whole frame, so the link handler never has to unpack
 *  `changes`/`hubSeq` itself and the two can never be paired wrongly. */
export function applyReplicaFrame(
  frame: ClusterReplicaFrame,
  input: Omit<ReplicaApplyInput, 'changes'>,
): ReplicaApplyResult {
  const result = applyReplica({ ...input, changes: frame.changes });
  // `frame.hubSeq` is "the highest order in `changes`" per the contract — taking the max with
  // whatever `applyReplica` itself computed means an empty `changes` array (a keepalive push)
  // still advances the watermark to what the frame declares.
  return {
    ...result,
    appliedThroughHubSeq: Math.max(result.appliedThroughHubSeq, frame.hubSeq),
  };
}

/**
 * One op over one record. `undefined` in means the record does not exist locally; `undefined` out
 * means the op removed it — which happens only after a tombstone has aged past its retention
 * window, never as the direct result of a tombstone op (a tombstone is a value, not an absence).
 *
 * Neither `upsert` nor `tombstone` ever produces `undefined` here — compaction (which is what ages
 * a tombstone out) is `cluster/ops.ts`'s job, not this file's (PLAN 2.1 owns verification 5/5b).
 * The `TodoItem | undefined` return type is kept because callers (including `applyReplica`) treat
 * "removed" as a real, reachable case once compaction exists.
 */
export function applyOpToRecord(record: TodoItem | undefined, op: ClusterOp): TodoItem | undefined {
  const base: TodoItem = record
    ? { ...record }
    : // A tombstone or upsert for an entity this node has never seen (e.g. it joined after the
      // create op was compacted away). `summary` is required by `todoSchema`; an empty shell is
      // the defensible placeholder for a row whose whole point, at this moment, is a tombstone.
      { id: op.entityId, summary: '' };

  // D4: `fields` carries only what changed. D13: `unknown` rides alongside it, verbatim, for a
  // field this node's schema does not recognize — merged the same way, so it round-trips through
  // an older reader unchanged instead of being dropped.
  if (op.fields) Object.assign(base, op.fields);
  if (op.unknown) Object.assign(base, op.unknown);

  // A field DELETION is not expressible as a value, so it rides in its own list. Without this
  // loop, `todoContentFields` built `fields` from the keys present on the record and a removed key
  // was indistinguishable from one that had never been set — so `updateTodo({archived: false})`,
  // `clearStartedTaskId` and `markStarted`'s `delete autostart` replicated as no-ops and the peer
  // kept the stale value forever, silently. `ops.ts` guarantees a key is in `fields` or in
  // `clearedFields`, never both.
  //
  // Applied LAST of the three merges on purpose. `unknown` (D13) carries keys this schema does not
  // recognise, verbatim; if a key ever appeared in both, the sender saying "this key is gone" is
  // the more specific statement and must not be undone by a passthrough copy. The three cluster
  // bookkeeping fields below (`hubSeq`, `pendingSince`, `tombstone`) are set after this loop and so
  // are unreachable by it, which is correct — they are the hub's to state, not a peer's to clear.
  if (op.clearedFields) {
    for (const key of op.clearedFields) delete (base as Record<string, unknown>)[key];
  }

  // D27 — CORRECTED 2026-08-23. This used to read `if (op.hubSeq !== undefined) base.hubSeq =
  // op.hubSeq; delete base.pendingSince;`, unconditionally, on the theory that "any hub-applied
  // change settles this record... it is no longer pending once the hub has an opinion." That
  // theory is FALSE: `pendingSince` is a per-RECORD marker but the work it stands for is tracked
  // per-FIELD, in `pendingFields` — this op may speak to only SOME of them. Deleting the marker
  // for a field the op never touched loses the only signal `cluster/ops.ts#deriveTodoOps`
  // (`if (!todo.pendingSince) continue;`) reads to know the record is still owed, so the
  // receiver's own un-sent edit on every OTHER field is silently dropped from its outbox forever
  // — no error, no trace, just a write that never leaves the node. (The old comment's "`pending`
  // decides" was never true either: `input.pending`, below in `applyReplica`, is read in exactly
  // one place — `diffCorrections` — only to compute what to SHOW the cockpit, never to guard what
  // this function keeps.)
  //
  // The fix: narrow `pendingFields` to whatever this op does NOT name, and only clear the
  // per-record `pendingSince` marker once nothing remains un-spoken-for. A field the op DOES
  // touch is resolved either way it turns out — confirmed, if it matches what this node already
  // had pending, or overruled, if the hub applied a different value for it (D4: the hub is the
  // only writer, so its value wins outright rather than being queued to re-send). Telling a
  // confirmation from a correction apart is `diffCorrections`'s job, from `input.pending`,
  // computed independently of this function — so that distinction costs this function nothing,
  // and a genuine field-level conflict resolves the same way a claim's does (below).
  //
  // A tombstone resolves EVERY pending field unconditionally: once the hub has deleted the row
  // there is nothing left to send an edit for, matching `cluster/ops.ts#collapseOwed`'s own rule
  // that a tombstone wipes whatever the outbox had accumulated for that record.
  const touchedFieldNames = new Set<string>([
    ...(op.fields ? Object.keys(op.fields) : []),
    ...(op.clearedFields ?? []),
    ...(op.unknown ? Object.keys(op.unknown) : []),
  ]);
  //
  // **D36 (2026-08-23) — a meta key is never "still pending" either.** `CLUSTER_META_TODO_FIELDS`
  // names the keys `cluster/ops.ts` can never put on an op, so no op can ever appear in
  // `touchedFieldNames` for one, so a record that has such a key in `pendingFields` can never
  // resolve here and is re-derived on every flush tick forever. `todos.ts#stampPending` is the fix
  // — it no longer records them — and this filter is the HEAL for the records already on disk when
  // that landed: they arrive here carrying `pendingFields: ['id']`, and the very resend loop they
  // are stuck in is what delivers the push that now settles them. Deriving from the same imported
  // set as `partitionTodoFields` is the point: this is not a second list to keep in step, it is the
  // same one, read where `pendingFields` is written.
  const stillPending =
    op.op === 'tombstone'
      ? []
      : (base.pendingFields ?? []).filter(
          (field) => !touchedFieldNames.has(field) && !CLUSTER_META_TODO_FIELDS.has(field),
        );
  // `base.pendingFields === undefined` — a record from before per-field tracking existed, or one
  // an older peer wrote without it (`cluster/ops.ts`'s own "missing pendingFields" fallback) — has
  // no field list to narrow BY, so this op settles the whole record, same as before this fix. That
  // is a deliberate, not an oversight: there is nothing more precise to be with here.
  const resolved = base.pendingFields === undefined || stillPending.length === 0;

  if (resolved) {
    delete base.pendingFields;
    delete base.pendingSince;
  } else {
    base.pendingFields = stillPending;
  }

  // Bumped unconditionally, resolved or not: `hubSeq` tracks the highest hub order this record has
  // received ANY authoritative content for, independent of what remains owed — matching how it is
  // read everywhere else (`applyReplica`'s own idempotence skip above; `hub-apply.ts`'s parallel
  // check on the hub's own copy of the record). It used to be tempting to gate this the same way
  // `todos.ts#markStartedWithClaim` guards `item.hubSeq = ack.hubSeq` with `if (!item.pendingSince)`
  // (`todos.ts:912`/`:936`) — withholding it while something remains pending, so a stale `hubSeq`
  // could never look "caught up" to `cluster/ops.ts#deriveTodoOps`'s own defensive per-record gate.
  // That is backwards here: withholding it leaves the record's `hubSeq` BELOW where the project
  // watermark has already moved to (that watermark advances on this same push, resolved or not),
  // which trips that exact gate the other way instead. The correct fix was in that gate, not here —
  // see its own `pendingFields`-aware CORRECTED note (D27) — leaving this bump free to be simple.
  if (op.hubSeq !== undefined) base.hubSeq = op.hubSeq;

  if (op.op === 'tombstone') {
    base.tombstone = { at: op.ts };
  } else {
    // D6: an upsert at a later hubSeq resurrects a tombstoned row. The tombstone is a value like
    // any other field, cleared by a later write, never a hole a later write must route around.
    delete base.tombstone;
  }

  return base;
}

/** The fields on which the hub's applied value differs from this node's optimistic one. Empty when
 *  they agree, which is the common case and must cost nothing to render. */
export function diffCorrections(
  local: TodoItem | undefined,
  applied: TodoItem | undefined,
  op: ClusterOp,
  now: () => Date,
): ClusterReplicaCorrection[] {
  // Cleared fields are corrections too, and for the same reason values are: the local record may
  // still be carrying the value this node optimistically wrote, and the hub has just said the
  // field is gone. Reading `op.fields` alone made a clear invisible to the cockpit's correction
  // notice — the same root gap as the missing delete loop in `applyOpToRecord` above, one layer up.
  const fieldNames = [...(op.fields ? Object.keys(op.fields) : []), ...(op.clearedFields ?? [])];
  if (fieldNames.length === 0) return [];

  const corrections: ClusterReplicaCorrection[] = [];

  for (const field of fieldNames) {
    const localValue = local?.[field as keyof TodoItem];
    const hubValue = applied?.[field as keyof TodoItem];
    if (isDeepStrictEqual(localValue, hubValue)) continue;

    corrections.push({
      entity: op.entity,
      entityId: op.entityId,
      field,
      localValue,
      hubValue,
      hubSeq: applied?.hubSeq ?? op.hubSeq ?? 0,
      at: now().toISOString(),
    });
  }

  return corrections;
}
