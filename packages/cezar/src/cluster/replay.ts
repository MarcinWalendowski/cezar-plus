import {
  clusterTodoFieldsSchema,
  type ClusterNodeId,
  type ClusterOp,
  type ClusterOpScope,
  type ClusterProjectKey,
} from '@loki-labs/better-cezar-contract';
import { todoSchema, type TodoItem } from '../todos.ts';
import { newOpId } from './ops.ts';
import {
  planReplicaFanout,
  type ReplicaFanoutExclusion,
  type ReplicaFanoutPlan,
  type ReplicaFanoutTarget,
} from './replica-fanout.ts';

/**
 * Catching a reconnecting (or newly-paired) node up from a watermark, by SCANNING PRESENT STATE —
 * "Design B" in the spec (`.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, "What remains" →
 * Milestone B; D4 · D6 · D7 · D13), chosen over replaying the accumulated op log (Design A) because
 * a log is compactable and a resuming node's gap can span a compaction boundary — state has no such
 * gap, by construction. **Pure — no I/O, no clock beyond the injected `now`.** The caller reads
 * `TodoItem[]` (through `readTodos`, same as every other reader) and sends what this returns; this
 * file decides what to send, never how to fetch or deliver it.
 *
 * `hub-router.ts` is this module's caller — held by another agent finishing F3/F4 at the time this
 * file was written, so this is the engine, built before its wiring. That is a **stated, accepted**
 * risk, not an oversight: a pure module with no caller is exactly what put ~1,500 lines of green,
 * unreachable code on this branch before B3 made `cluster-routes.ts`'s replication wiring real. The
 * wiring is tracked as required, not optional, precisely so this file does not repeat that.
 *
 * **Reuses `replica-fanout.ts#planReplicaFanout` for frame construction — does not re-split.** That
 * file already enforces both `CLUSTER_OPS_PER_FRAME_MAX` and `CLUSTER_FRAME_MAX_BYTES` (D29), reports
 * a per-target unrepresentable op via `excluded` rather than throwing, and defines "no frame when
 * nothing is owed." Writing a second splitter here is exactly how the wire's two halves drifted
 * apart before (D29's own postmortem, in that file's docblock) — this file supplies WHAT is owed, in
 * `applied` shape, and lets that one splitter decide HOW it is framed.
 *
 * ---
 *
 * **Decision 1 — a record with no `hubSeq`.** Scanned, never silently skipped, but excluded from
 * every plan and reported separately, in `unordered`. Two things this can mean: a row that has never
 * reached the hub's own replication ordering at all (a purely local write on the box performing this
 * scan — the hub can carry its own `pendingSince` state exactly like a spoke can, and nothing here
 * assumes it cannot), or a legacy row predating `hubSeq` entirely. Either way it has no defensible
 * position in a `hubSeq`-ordered stream, so it is never shipped AS IF the hub had ordered it — doing
 * so would hand a target a value with no ordering guarantee behind it, which is worse than not
 * sending it. But dropping it with no trace would recreate exactly the failure this module exists to
 * close (an unreplicable record that nobody can see is unreplicable) — see `unordered` on the result.
 * A caller that finds this list non-empty has learned something actionable: those rows need their
 * OWN settlement path (the D35 report's "case 3" family), not a replay, because replay only knows
 * how to reproduce a hub-ordered position, and these do not have one.
 *
 * **Decision 2 — ordering.** `applied` is built in scan order but not assumed sorted; `owedFor`
 * inside `planReplicaFanout` sorts ascending by `hubSeq` before batching, and each frame's own
 * `hubSeq` is the highest among its `changes` — the same contract rule (`clusterReplicaFrameSchema`)
 * the live fan-out path obeys. One scan, one sort, shared with the live path by construction rather
 * than by two implementations agreeing to behave the same way.
 *
 * **Decision 3 — the D29/3b interaction.** An oversized record is excluded from replay exactly as it
 * is excluded from live fan-out, for the same reason (`replica-fanout.ts`'s own docblock): no frame
 * it could occupy exists, split however it likes, and it will be excluded again on every future
 * replay for the same reason, since its size does not change. This file does not loop, retry, or
 * throw for it — `planReplicaFanout`'s `excluded` (never optional) is returned as-is. Closing that
 * gap for real needs the wire change the D35 report already named (a way for the hub to tell a target
 * "accepted, but you will never get this via replica") — out of reach from a pure scan either way,
 * since the wire carries no such signal today.
 *
 * **Decision 4 — whole rows, and why that is safe.** A log can replay a single field's change; a
 * scan of present state cannot reconstruct which field changed WHEN, only what the row holds now —
 * so every op this file builds is a WHOLE-ROW upsert (or a tombstone), never a per-field one. That
 * is safe on the receiver only because of D27: `cluster/replica.ts#applyOpToRecord` resolves
 * `pendingFields` against exactly the keys an incoming op names, so a whole-row op that happens to
 * touch a field the receiver has its own un-sent edit on settles THAT field precisely (hub wins,
 * D27's decision 2) without touching any field the op does not carry — which, for most rows, is
 * none, since a whole-row op carries nearly everything. Before D27, the SAME whole-row op would have
 * cleared `pendingSince` unconditionally regardless of which fields it actually named, silently
 * dropping every other outstanding edit on that record. **Replay's correctness therefore depends on
 * D27 — the two must not be separated**, and a change to D27's resolution rule is a change to what
 * "safe" means here too.
 *
 * A whole row still needs to express a DELETION, and it does that better from state than a log
 * could: `clearedFields` is computed by checking, for every content field this schema declares
 * (`todoSchema.shape`, minus the six cluster-bookkeeping fields and `id` — `CLUSTER_META_KEYS`
 * below, kept in step with `cluster/ops.ts`'s own identically-scoped `CLUSTER_META_TODO_FIELDS` by
 * hand, since that file is not this file's to import a private constant from), whether the record
 * currently carries it. Absent means deleted-or-never-set — replaying state removes the ambiguity a
 * log has to resolve with `pendingFields`, because there is no delete EVENT to interpret, only a
 * present fact. A field this schema does not recognize (D13, a newer peer's addition) is preserved
 * in `unknown` exactly as `ops.ts`/`replica.ts` already do, but — stated plainly, not silently — a
 * field like that, if it was ever deleted on some OTHER node, cannot be retroactively cleared by a
 * scan that has never seen its name: only a schema that knows a field can know its absence means
 * something. That is an existing characteristic of the unknown-field design (`clusterOpShape`'s own
 * `unknown` docblock), not a new gap replay introduces.
 */

/** Mirrors `cluster/ops.ts`'s `CLUSTER_META_TODO_FIELDS` — deliberately NOT
 *  `clusterTodoFieldsSchema.shape`'s full six keys: `placement` is excluded from THIS set on
 *  purpose, because `ops.ts` treats it as ordinary content (a spoke can propose it optimistically),
 *  and this file's whole-row projection has to agree with the outbox's own notion of "content" or a
 *  replayed row would treat `placement` differently depending on which path delivered it. Kept in
 *  step by hand because `ops.ts` does not export its version — see the module docblock, decision 4.
 */
const CLUSTER_META_KEYS: ReadonlySet<string> = new Set<string>([
  'id',
  ...Object.keys(clusterTodoFieldsSchema.shape).filter((key) => key !== 'placement'),
]);

/** Every content field this build's schema declares — `todoSchema.shape` already carries the six
 *  cluster fields too (spread in, `todos.ts`'s own comment: "one definition of one record"), so
 *  `CLUSTER_META_KEYS` is subtracted back out to leave only what a whole-row upsert may legitimately
 *  claim to SET or CLEAR. */
const DECLARED_CONTENT_KEYS: ReadonlySet<string> = new Set<string>(
  Object.keys(todoSchema.shape).filter((key) => !CLUSTER_META_KEYS.has(key)),
);

/** Scanned but excluded from every plan — see module docblock, decision 1. */
export interface ReplayUnorderedRecord {
  readonly entity: 'todo';
  readonly entityId: string;
}

export interface ReplayScanInput {
  /** Attribution for every op this scan synthesizes (`ClusterOp.nodeId`'s own docblock: "the
   *  attribution a correction is rendered with") — there is no per-field author history on disk to
   *  recover, so a replayed row is honestly attributed to the node doing the replaying (the hub),
   *  not to whichever node most recently touched one of its fields. */
  readonly hubNodeId: ClusterNodeId;
  readonly scope: ClusterOpScope;
  readonly projectKey?: ClusterProjectKey;
  /** This project's current records — read through `readTodos` (D5a) by the caller; this file does
   *  no I/O and trusts the healed shape it is handed, same posture as `cluster/ops.ts#deriveTodoOps`
   *  and `cluster/replica.ts#applyReplica`. */
  readonly todos: readonly TodoItem[];
  readonly targets: readonly ReplicaFanoutTarget[];
  readonly now?: () => Date;
}

export interface ReplayScanResult {
  readonly plans: readonly ReplicaFanoutPlan[];
  /** ALWAYS present, never optional — same contract as `planReplicaFanout`'s own `excluded`, for
   *  the same reason: a caller destructuring only `{ plans }` still has this sitting in the result. */
  readonly excluded: readonly ReplicaFanoutExclusion[];
  /** ALWAYS present, never optional, same reasoning — see decision 1. Empty in the overwhelmingly
   *  common case. */
  readonly unordered: readonly ReplayUnorderedRecord[];
}

/** One record → one whole-row `ClusterOp`, hub-ordered by its own `hubSeq` (never called on a record
 *  without one — the caller filters those into `unordered` first). */
function projectWholeRow(todo: TodoItem, input: ReplayScanInput, now: () => Date): ClusterOp & { hubSeq: number } {
  const envelope = {
    opId: newOpId(),
    nodeId: input.hubNodeId,
    ts: now().toISOString(),
    scope: input.scope,
    ...(input.projectKey !== undefined ? { projectKey: input.projectKey } : {}),
    entity: 'todo' as const,
    entityId: todo.id,
    hubSeq: todo.hubSeq!,
  };

  if (todo.tombstone) {
    // A tombstone op never carries `fields` — `op: 'tombstone'` IS the content, same shape
    // `cluster/ops.ts#deriveTodoOps` already emits for a tombstoned record.
    return { ...envelope, op: 'tombstone' };
  }

  const record = todo as unknown as Record<string, unknown>;
  const fields: Record<string, unknown> = {};
  const clearedFields: string[] = [];
  const unknown: Record<string, unknown> = {};

  for (const key of DECLARED_CONTENT_KEYS) {
    const value = record[key];
    if (value !== undefined) fields[key] = value;
    else clearedFields.push(key); // decision 4: absence IS the deletion, read straight off state.
  }
  for (const [key, value] of Object.entries(record)) {
    if (CLUSTER_META_KEYS.has(key) || DECLARED_CONTENT_KEYS.has(key)) continue;
    if (value === undefined) continue;
    unknown[key] = value; // D13: a field this schema does not recognize rides verbatim.
  }

  return {
    ...envelope,
    op: 'upsert',
    fields,
    clearedFields: clearedFields.length > 0 ? clearedFields : undefined,
    unknown: Object.keys(unknown).length > 0 ? unknown : undefined,
  };
}

/**
 * The whole scan. `targets` may be one reconnecting node or several — `planReplicaFanout` already
 * handles either, and replay has no reason to special-case a single target when the primitive it
 * reuses does not.
 */
export function scanForReplay(input: ReplayScanInput): ReplayScanResult {
  const now = input.now ?? (() => new Date());
  const unordered: ReplayUnorderedRecord[] = [];
  const applied: (ClusterOp & { hubSeq: number })[] = [];

  for (const todo of input.todos) {
    if (todo.hubSeq === undefined) {
      unordered.push({ entity: 'todo', entityId: todo.id });
      continue;
    }
    applied.push(projectWholeRow(todo, input, now));
  }

  const { plans, excluded } = planReplicaFanout({
    scope: input.scope,
    ...(input.projectKey !== undefined ? { projectKey: input.projectKey } : {}),
    applied,
    targets: input.targets,
  });

  return { plans, excluded, unordered };
}
