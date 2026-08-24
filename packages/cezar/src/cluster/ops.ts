import { randomUUID } from 'node:crypto';
import {
  CLUSTER_FRAME_MAX_BYTES,
  CLUSTER_OPS_PER_FRAME_MAX,
  CLUSTER_PROTOCOL,
  clusterTodoFieldsSchema,
  storedClusterOpSchema,
  type ClusterNodeId,
  type ClusterOp,
  type ClusterOpKind,
  type ClusterOpScope,
  type ClusterOpsFrame,
  type ClusterProjectKey,
  type ClusterTodoFields,
} from '@loki-labs/better-cezar-contract';
import type { TodoItem } from '../todos.ts';

/**
 * Deriving the write outbox, and packing it into `ops` frames within the link's stated bounds
 * (spec `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, D4 · D5 · D5a · D6 · D13).
 *
 * **The outbox is DERIVED, not appended to.** `ops.ndjson` (`./oplog.ts`) is a compactable cache;
 * the truth is the set of records still carrying `pendingSince`, which is written inside the same
 * `O_EXCL` lease as the value it marks (D5). So a crash that loses the log's tail loses nothing —
 * `deriveTodoOps` re-derives the unsent ops from the records themselves, against the last hub
 * acknowledgement. Under D4 the hub is the only writer, which makes a lost outbox entry a LOST
 * WRITE rather than a merge that resolves later; deriving is what makes that impossible by
 * construction rather than by careful flushing.
 *
 * **Read through `readTodos`, never by parsing `todos.json`** (D5a). Not every todo arrives through
 * `createTodo` — `handoff.ts`'s `FOLLOWUP_INSTRUCTIONS` tells an agent to append a raw object with
 * no `id` — and `readTodos` heals that on read, under the lock. Id assignment has to happen before
 * an op is derived, or two nodes mint two different ids for the same raw entry and produce a
 * duplicate no ordering can reconcile. `deriveTodoOps` therefore takes `TodoItem[]` and never a
 * path: its caller has already gone through the healing reader.
 *
 * There is no merge half here and there never was one under this design: the hub linearizes, so
 * nothing in this file decides an order.
 *
 * **On `TodoItem` not (yet) carrying the six cluster fields.** Package 2.0/2.3 extends
 * `todos.ts`'s schema with `pendingSince`/`pendingFields`/`hubSeq`/`tombstone`/`placement`/
 * `startedOn` (`ClusterTodoFields` in the contract) — this package does not own `todos.ts` and
 * must not edit it. Every read of those fields below goes through a local
 * `TodoItem & Partial<ClusterTodoFields>` widening rather than assuming the exported `TodoItem`
 * type already carries them: once 2.3 lands the widening is a no-op (the fields are already
 * there), so nothing here needs to change.
 *
 * **`pendingFields` narrows an upsert's `fields` to what actually changed** (2026-08-22
 * amendment). `pendingSince` alone can only say THAT a record is owed, never WHICH keys — see
 * `todoContentFields` below for the derivation and the documented decision on what happens when
 * `pendingFields` is missing.
 */

type PendingTodo = TodoItem & Partial<ClusterTodoFields>;

/** Uuid v4. Ids are already cluster-safe (D3), which is the single biggest reason this merge is
 *  tractable — no remapping, no node-prefixing, no collisions. */
export function newOpId(): string {
  return randomUUID();
}

export interface DeriveTodoOpsInput {
  nodeId: ClusterNodeId;
  projectKey: ClusterProjectKey;
  /** Read through `readTodos` — see the module header. */
  todos: readonly TodoItem[];
  /** Everything at or below this is durably applied at the hub and is not owed. */
  ackedThroughHubSeq: number;
  now?: () => Date;
}

/** Fields carried on every `ClusterOp` for a todo entity, everything else being op-kind-specific. */
function todoOpEnvelope(
  input: DeriveTodoOpsInput,
  todo: PendingTodo,
  clock: () => Date,
): Pick<ClusterOp, 'opId' | 'nodeId' | 'ts' | 'scope' | 'projectKey' | 'entity' | 'entityId'> {
  return {
    opId: newOpId(),
    nodeId: input.nodeId,
    // The moment the LOCAL edit happened, not the moment we happen to be deriving — so a re-derive
    // after a crash reports the same `ts` it would have on the first pass (see the docblock on
    // determinism), and the cockpit's "changed on <node>" render reflects when it actually changed.
    ts: todo.pendingSince || clock().toISOString(),
    scope: 'project',
    projectKey: input.projectKey,
    entity: 'todo',
    entityId: todo.id,
  };
}

/**
 * **The keys that can never ride an op — and therefore must never be recorded as owed.**
 *
 * Never sent as upsert content (D9a): the hub-confirmed-only claim field would let a spoke propose
 * its own idea of who holds a run, which is exactly the optimistic start D4 forbids. `tombstone` is
 * excluded because it drives the op KIND (`op: 'tombstone'`), never rides as a content field on an
 * upsert. `pendingFields` is excluded because it is the transport's own bookkeeping about what is
 * owed, not content the hub has any use for. `id` is the entity's identity, carried in the
 * envelope (`entityId`), never as a field.
 *
 * **EXPORTED, and read by `todos.ts#stampPending`, since 2026-08-23 (D36).** It used to be private
 * to this file, and that was the whole defect: "which keys can ride an op" lived here while "which
 * keys are still owed" lived in `todos.ts#stampPending`, and the two never agreed. `stampPending`
 * stamped `Object.keys(todo)` — including `id` — into `pendingFields`; `partitionTodoFields` below
 * skipped `id`, so it reached neither `op.fields` nor `op.clearedFields`; and D27's narrowing in
 * `cluster/replica.ts` clears `pendingSince` only once every `pendingFields` entry has been named
 * by an op. A key that can never be named can never be narrowed away, so `pendingSince` never
 * cleared and `deriveTodoOps` re-derived that record on **every flush tick, forever** — measured on
 * the first two-process E2E as `hub-seq.json` climbing ~1 every 5 seconds with the cluster idle
 * (~17,280 ops/day), on the happy path, for every replicated row.
 *
 * The invariant, stated once so both sides can be read off it: **a key in this set is invisible to
 * an op, so it must never enter `pendingFields`.** One set, three readers — `partitionTodoFields`
 * (what may ride), `todos.ts#stampPending` (what may be owed), `cluster/replica.ts#applyOpToRecord`
 * (what may remain owed). Two lists that must agree forever is exactly how D36 arose.
 *
 * **Derived from the contract, not typed out.** `clusterTodoFieldsSchema.shape` is the one
 * definition of the cluster bookkeeping fields, so a seventh field added there is un-sendable by
 * default rather than by someone remembering to add it here — failing closed (a new field simply
 * does not replicate, which is visible) rather than open (a new field is stamped as owed and loops,
 * which is D36 again). `placement` is the one deliberate exception: "run this one on the box" is
 * ordinary content a spoke may propose, so it is excluded from the set and rides as a field.
 * `cluster/replay.ts#CLUSTER_META_KEYS` derives its own identically-scoped copy the same way; it
 * can now import this one instead (that file was out of scope for this change).
 */
export const CLUSTER_META_TODO_FIELDS: ReadonlySet<string> = new Set<string>([
  'id',
  ...Object.keys(clusterTodoFieldsSchema.shape).filter((key) => key !== 'placement'),
]);

/** What one upsert op emits: keys to SET (`fields`) and keys to CLEAR (`clearedFields`) — never
 *  the same key in both (see the contract's `clearedFields` docblock on `clusterOpShape`). */
interface TodoFieldPartition {
  fields: Record<string, unknown>;
  clearedFields: string[] | undefined;
}

/**
 * Partitions the record's content by `pendingFields` — see `deriveTodoOps`'s own docblock for what
 * `pendingFields` being `undefined` means and why (the send-everything fallback). Within that
 * fallback nothing is ever cleared: without the marker there is no way to tell a genuine deletion
 * from a field nobody ever touched, and guessing would manufacture deletions that never happened.
 *
 * With `pendingFields` present, each named key lands in exactly one side: present and defined on
 * the record → `fields`; anything else (the key was `delete`d, e.g. `updateTodo({ archived: false
 * })`, `clearStartedTaskId`, `markStarted`'s `delete autostart`) → `clearedFields`. A key never
 * named in `pendingFields` appears in neither — "absent because untouched" and "absent because
 * deleted" are different facts, and only the second is a `clearedFields` entry.
 */
function partitionTodoFields(todo: PendingTodo, pendingFields: readonly string[] | undefined): TodoFieldPartition {
  if (!pendingFields) {
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(todo)) {
      if (CLUSTER_META_TODO_FIELDS.has(key)) continue;
      if (value === undefined) continue;
      fields[key] = value;
    }
    return { fields, clearedFields: undefined };
  }

  const fields: Record<string, unknown> = {};
  const clearedFields: string[] = [];
  for (const key of pendingFields) {
    if (CLUSTER_META_TODO_FIELDS.has(key)) continue;
    const value = (todo as Record<string, unknown>)[key];
    if (value !== undefined) fields[key] = value;
    else clearedFields.push(key);
  }
  return { fields, clearedFields: clearedFields.length ? clearedFields : undefined };
}

/**
 * One op per record still marked `pendingSince`, carrying **only the fields that changed** (D4) and
 * a `tombstone` op rather than a removal for a deleted row (D6).
 *
 * **CORRECTED 2026-08-23 — the determinism claim below is FALSE, and it is load-bearing.** `opId:
 * newOpId()` is `randomUUID()`, so calling this twice over identical state produces ops that differ
 * in the one field the hub deduplicates on. `op-history.ts#findAppliedOp` keys on `opId`, so a
 * re-derive is **not** a no-op — it is a duplicate flush the dedupe cannot recognise, durably
 * re-applied at the hub. This is the engine behind D35/D36: a record that stays `pendingSince`
 * re-derives every 5 s with a fresh id, and op history grows without bound (~17,280/day, measured).
 * Fixing the leak at its source (D36) removes the usual trigger but does not make this sentence
 * true. Do not rely on a crash re-derive being free. The original text is kept below, unchanged:
 *
 * Deterministic: called twice over
 * the same state it produces the same ops, so a re-derive after a crash is a no-op rather than a
 * duplicate flush.
 *
 * **`pendingFields` missing on a `pendingSince` record — decided, not defaulted.** Two ways this
 * happens: a record written before this field existed, or a genuinely OLDER node in the cluster
 * whose own `stampPending` has never heard of `pendingFields` and never sets it (D13's
 * inter-version compatibility case, not a hypothetical one). Three options, only one safe to
 * default into:
 *
 *  - **Drop the op silently.** The record stays `pendingSince` forever with nothing ever sent — a
 *    permanent, invisible lost write. Worse than the bug this closes. Never chosen.
 *  - **Send everything** (the pre-amendment behaviour). This CAN clobber a concurrent
 *    different-field edit at the hub — the exact failure D4 exists to prevent — so it is chosen
 *    deliberately, not by omission, and only because it is bounded rather than ongoing: it fires
 *    only for a record this build (or an older peer) never had field-level tracking for, and the
 *    very next local edit through `todos.ts`'s writers stamps `pendingFields` fresh
 *    (`stampPending`'s "fresh cycle" branch), so the gap self-heals after one cycle per record
 *    instead of persisting. A one-time, bounded resend of a pre-existing (already-accepted) risk,
 *    not a new one.
 *  - **A todos.ts-side heal-on-read**, mirroring D5a's id backfill, was considered and rejected
 *    for this package: it would need to write `pendingFields` back into `todos.json` under the
 *    lease, which is `todos.ts`'s write surface, not this (read-only, derive-only) package's.
 *    Send-everything gets the same self-healing property for free, from the write paths
 *    `todos.ts` already has, with no new write path here.
 *
 * So `todo.pendingFields` narrows the op's `fields` when present, and is `undefined` (send
 * everything) when absent — never an empty send.
 *
 * **`clearedFields` is the other half (2026-08-22 amendment).** `fields` can only express a key
 * being SET; a key a spoke DELETED locally (`updateTodo({ archived: false })`,
 * `clearStartedTaskId`, `markStarted`'s `delete autostart`) was, before this, simply absent from
 * every op and the deletion never reached any other node — a whole-record op could not express it
 * either, so this is not a regression, it is the first shape able to fix it. See
 * `partitionTodoFields` below for how a `pendingFields`-named key that is now absent on the record
 * becomes a `clearedFields` entry instead of silently vanishing from the op.
 */
export function deriveTodoOps(input: DeriveTodoOpsInput): ClusterOp[] {
  const clock = input.now ?? (() => new Date());
  const ops: ClusterOp[] = [];

  for (const raw of input.todos) {
    const todo = raw as PendingTodo;
    if (!todo.pendingSince) continue;
    // Defensive: a record whose OWN hubSeq already covers what the hub has acked is durably
    // applied even if `pendingSince` was somehow left set (a bug elsewhere, a race) — it is not
    // owed, so it must not be re-sent forever.
    //
    // CORRECTED 2026-08-23 (D27) — gated on `todo.pendingFields === undefined` too, now that
    // `pendingFields` exists. Before this, `cluster/replica.ts#applyOpToRecord` cleared
    // `pendingSince` on ANY hub-applied touch to a record, so this second gate was genuinely only
    // ever reached as the defensive backstop the comment above describes. D27 made `pendingSince`
    // survive a hub push that resolves only SOME of a record's `pendingFields` — and this node's
    // own `hubSeq` still advances to the pushed op's `hubSeq` on the very next FULL resolution
    // (`replica.ts`), which can easily be `<= ackedThroughHubSeq` once this node's watermark has
    // caught up to that push, the normal case one tick later. Left ungated, THIS check would then
    // silently drop the very record D27 exists to keep in the outbox — the same bug, reachable
    // through the sibling gate instead of `pendingSince` itself. Once `pendingFields` is tracked
    // (defined, even if it later narrows to empty and is deleted alongside `pendingSince` — see
    // `replica.ts`), it is the precise, per-field answer to "is this record still owed", and this
    // hubSeq-only proxy must defer to it rather than override it. The proxy still applies exactly
    // where it always was needed: a record with no `pendingFields` list to be precise with.
    if (
      todo.hubSeq !== undefined &&
      todo.pendingFields === undefined &&
      todo.hubSeq <= input.ackedThroughHubSeq
    )
      continue;

    const envelope = todoOpEnvelope(input, todo, clock);
    if (todo.tombstone) {
      ops.push({ ...envelope, op: 'tombstone' });
    } else {
      const { fields, clearedFields } = partitionTodoFields(todo, todo.pendingFields);
      ops.push({ ...envelope, op: 'upsert', fields, clearedFields });
    }
  }

  return ops;
}

/** Bounds are part of the contract (`CLUSTER_FRAME_MAX_BYTES`, `CLUSTER_OPS_PER_FRAME_MAX`), plus a
 *  per-tick send budget so one node's backlog cannot monopolise the link. */
export interface OpSendBudget {
  maxOps: number;
  maxBytes: number;
  /** Frames this tick. The backlog is not a race to be won. */
  maxFramesPerTick: number;
}

export const DEFAULT_OP_SEND_BUDGET: OpSendBudget = {
  maxOps: CLUSTER_OPS_PER_FRAME_MAX,
  maxBytes: CLUSTER_FRAME_MAX_BYTES,
  maxFramesPerTick: 4,
};

export interface PackedOpsFrame {
  frame: ClusterOpsFrame;
  /** What went into the frame, in order. */
  sent: ClusterOp[];
  /** What did not fit. The sender resumes from the last `ack`, so this is a retransmit queue, never
   *  a gap. */
  remaining: ClusterOp[];
}

export function packOpsFrame(
  ops: readonly ClusterOp[],
  input: { scope: ClusterOpScope; projectKey?: ClusterProjectKey; budget?: OpSendBudget },
): PackedOpsFrame {
  const budget = input.budget ?? DEFAULT_OP_SEND_BUDGET;
  // The send budget throttles; the wire schema's own bound is the hard ceiling it may never
  // exceed, no matter what a caller passes.
  const maxOps = Math.min(budget.maxOps, CLUSTER_OPS_PER_FRAME_MAX);
  const maxBytes = Math.min(budget.maxBytes, CLUSTER_FRAME_MAX_BYTES);

  const sent: ClusterOp[] = [];
  let bytes = 0;
  for (const op of ops) {
    if (sent.length >= maxOps) break;
    const opBytes = Buffer.byteLength(JSON.stringify(op), 'utf8');
    // Always let at least one op through even if it alone exceeds the byte budget — otherwise an
    // oversized single op could never be sent and the outbox would stall forever on it.
    if (sent.length > 0 && bytes + opBytes > maxBytes) break;
    sent.push(op);
    bytes += opBytes;
  }

  const frame: ClusterOpsFrame = {
    type: 'ops',
    protocol: CLUSTER_PROTOCOL,
    scope: input.scope,
    projectKey: input.projectKey,
    ops: sent,
  };

  return { frame, sent, remaining: ops.slice(sent.length) };
}

export interface SalvagedOps {
  ops: ClusterOp[];
  /** Entries that failed to parse. Counted and warned once, never allowed to evict their siblings —
   *  the per-entry salvage house rule (`agent-accounts.ts`, `sources/types.ts`, `auth/types.ts`). */
  dropped: number;
}

/** Per-entry salvage over a received or re-read batch. This is what makes the `.strict()` op
 *  envelope survivable: one unparseable op costs one op.
 *
 *  Validated against the `.passthrough()` on-disk/relay shape rather than the wire's `.strict()`
 *  one: a `.strict()`-valid entry is trivially valid here too, and a stored or relayed entry may
 *  legitimately carry passthrough keys a newer node wrote (D13) — rejecting those on read would be
 *  the exact truncation D13 exists to prevent. */
export function salvageOps(entries: readonly unknown[]): SalvagedOps {
  const ops: ClusterOp[] = [];
  let dropped = 0;
  for (const entry of entries) {
    const result = storedClusterOpSchema.safeParse(entry);
    if (result.success) {
      ops.push(result.data);
    } else {
      dropped += 1;
    }
  }
  return { ops, dropped };
}

export interface CompactOpsInput {
  ackedThroughHubSeq: number;
  /** Tombstones are compacted only AFTER the retention window (D6): compact one early and the row
   *  resurrects from any node that had not yet applied it. */
  tombstoneRetentionMs: number;
  now?: () => Date;
}

function opGroupKey(op: ClusterOp): string {
  return `${op.scope} ${op.projectKey ?? ''} ${op.entity} ${op.entityId}`;
}

function isAcked(op: ClusterOp, ackedThroughHubSeq: number): boolean {
  return op.hubSeq !== undefined && op.hubSeq <= ackedThroughHubSeq;
}

/** Collapses a chronological run of still-owed ops for ONE entity into a single representative op.
 *  Consistent with an "apply" reducer that starts empty and, per op in order, either tombstones
 *  (clearing the accumulated fields — a later upsert after a delete is a fresh recreation, not a
 *  patch onto content the entity had before it was deleted) or merges `fields`/`clearedFields` onto
 *  whatever has accumulated since the last tombstone: replaying just the collapsed op from empty
 *  produces exactly the same accumulated state as replaying the whole original run, which is what
 *  test 5 checks. `unknown` is the one exception — it accumulates across the whole run regardless
 *  of any tombstone in between, since it is opaque passthrough state this node does not interpret,
 *  not content a delete should be able to erase.
 *
 *  **A key never ends up in both `fields` and `clearedFields`** (2026-08-22 amendment). Each op in
 *  the run never carries a key in both (the contract's invariant, kept by `partitionTodoFields`),
 *  but two DIFFERENT ops in the same run can disagree about one key over time — set it, then a
 *  later op deletes it, or the reverse. This is "last write wins", per key, independently of which
 *  side it lands on: a SET evicts that key from the accumulated `clearedFields`, and a CLEAR
 *  evicts it from the accumulated `fields`, so whichever happened LAST for that key is the only
 *  trace of it left in the collapsed op. */
function collapseOwed(chronological: readonly ClusterOp[]): ClusterOp {
  let kind: ClusterOpKind = 'upsert';
  let fields: Record<string, unknown> = {};
  let clearedFields = new Set<string>();
  let unknownFields: Record<string, unknown> | undefined;
  let last: ClusterOp | undefined;

  for (const op of chronological) {
    last = op;
    kind = op.op;
    if (op.op === 'tombstone') {
      fields = {};
      clearedFields = new Set();
    } else {
      if (op.fields) {
        for (const [key, value] of Object.entries(op.fields)) {
          fields[key] = value;
          clearedFields.delete(key);
        }
      }
      if (op.clearedFields) {
        for (const key of op.clearedFields) {
          delete fields[key];
          clearedFields.add(key);
        }
      }
    }
    if (op.unknown) unknownFields = { ...(unknownFields ?? {}), ...op.unknown };
  }

  if (!last) {
    // Callers only ever pass a non-empty group (see compactOps below); this is an invariant, not
    // a reachable runtime state.
    throw new Error('[cez] collapseOwed called with an empty op group');
  }

  return {
    ...last,
    op: kind,
    fields: kind === 'upsert' ? fields : undefined,
    clearedFields: kind === 'upsert' && clearedFields.size > 0 ? [...clearedFields] : undefined,
    unknown: unknownFields,
  };
}

/** Drops what the hub has acknowledged and collapses repeated upserts of one entity to the latest.
 *  Never drops an op still owed, and never drops a tombstone inside its window. */
export function compactOps(ops: readonly ClusterOp[], input: CompactOpsInput): ClusterOp[] {
  const clock = input.now ?? (() => new Date());
  const nowMs = clock().getTime();

  const groups = new Map<string, ClusterOp[]>();
  for (const op of ops) {
    const key = opGroupKey(op);
    const group = groups.get(key);
    if (group) group.push(op);
    else groups.set(key, [op]);
  }

  const result: ClusterOp[] = [];
  for (const group of groups.values()) {
    const chronological = [...group].sort((a, b) => a.ts.localeCompare(b.ts));
    const owed = chronological.filter((op) => !isAcked(op, input.ackedThroughHubSeq));

    if (owed.length > 0) {
      // A newer local edit exists that the hub has not confirmed — it fully explains this
      // entity's pending state, so any older ACKED entries in the same group are stale and are
      // dropped along with it (never kept just because they happen to be a tombstone: the tombstone
      // retention window protects against loss while nothing newer supersedes it, not against a
      // node's own later edit).
      result.push(collapseOwed(owed));
      continue;
    }

    // Every op for this entity is already durably applied at the hub. Only the latest is worth
    // even considering keeping, and only if it is a tombstone still inside its retention window —
    // an acked upsert carries nothing a re-derivable cache needs to hold onto.
    let latest: ClusterOp | undefined;
    for (const op of chronological) latest = op;
    if (!latest) continue; // unreachable: groups are never created empty

    if (latest.op === 'tombstone') {
      const parsedTs = Date.parse(latest.ts);
      const ageMs = Number.isNaN(parsedTs) ? 0 : nowMs - parsedTs;
      // An unparseable timestamp fails safe: treat it as fresh rather than risk an early drop.
      if (ageMs < input.tombstoneRetentionMs) {
        result.push(latest);
      }
    }
  }

  return result;
}
