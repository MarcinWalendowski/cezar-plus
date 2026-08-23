import { isDeepStrictEqual } from 'node:util';
import type {
  ClusterOp,
  ClusterReplicaCorrection,
  ClusterReplicaFrame,
  ClusterTodoFields,
} from '@loki-labs/better-cezar-contract';
import type { TodoItem } from '../todos.ts';

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
 * **`TodoItem` does not carry the five cluster fields yet** — package 2.0 (contract + `todos.ts`
 * schema) lands separately and this file must not touch `todos.ts`. `ClusteredTodoItem` below is
 * this file's own typed view of a record that DOES carry them; every record that flows through this
 * module is treated as one. Once 2.0 merges `clusterTodoFieldsSchema` into `todoSchema`, `TodoItem`
 * itself will structurally satisfy `ClusteredTodoItem` and the internal casts become redundant
 * rather than wrong.
 */

export type ClusteredTodoItem = TodoItem & ClusterTodoFields;

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

  const byId = new Map<string, ClusteredTodoItem>(
    input.local.map((t) => [t.id, t as ClusteredTodoItem]),
  );
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
      else byId.set(change.entityId, after as ClusteredTodoItem);
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
  const base: ClusteredTodoItem = record
    ? { ...(record as ClusteredTodoItem) }
    : // A tombstone or upsert for an entity this node has never seen (e.g. it joined after the
      // create op was compacted away). `summary` is required by `todoSchema`; an empty shell is
      // the defensible placeholder for a row whose whole point, at this moment, is a tombstone.
      ({ id: op.entityId, summary: '' } as ClusteredTodoItem);

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

  if (op.hubSeq !== undefined) base.hubSeq = op.hubSeq;

  // Any hub-applied change settles this record: the `pendingSince` marker describes outstanding
  // LOCAL work, and the hub has now spoken for whatever it held. `applyReplica` is the one that
  // decides, from `pending`, whether that outstanding work was confirmed or corrected — either
  // way, it is no longer "pending" once the hub has an opinion.
  delete base.pendingSince;

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

  const localRec = local as ClusteredTodoItem | undefined;
  const appliedRec = applied as ClusteredTodoItem | undefined;
  const corrections: ClusterReplicaCorrection[] = [];

  for (const field of fieldNames) {
    const localValue = localRec?.[field as keyof ClusteredTodoItem];
    const hubValue = appliedRec?.[field as keyof ClusteredTodoItem];
    if (isDeepStrictEqual(localValue, hubValue)) continue;

    corrections.push({
      entity: op.entity,
      entityId: op.entityId,
      field,
      localValue,
      hubValue,
      hubSeq: appliedRec?.hubSeq ?? op.hubSeq ?? 0,
      at: now().toISOString(),
    });
  }

  return corrections;
}
