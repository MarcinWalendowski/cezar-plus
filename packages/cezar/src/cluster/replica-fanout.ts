import {
  CLUSTER_OPS_PER_FRAME_MAX,
  CLUSTER_PROTOCOL,
  type ClusterNodeId,
  type ClusterOp,
  type ClusterOpScope,
  type ClusterProjectKey,
  type ClusterReplicaFrame,
} from '@loki-labs/better-cezar-contract';

/**
 * Deciding what each node must be told, once the hub has applied a batch of ops — the SENDING half
 * of replication (spec `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, "What remains" →
 * Milestone B; D4 · D6 · D7).
 *
 * `cluster/replica.ts#applyReplicaFrame` is the RECEIVING half and is complete: handed a
 * `ClusterReplicaFrame`, a spoke applies it, clears the settled records' `pendingSince`, and
 * surfaces corrections. But nothing anywhere BUILDS one — `hub-router.ts`'s `ops` case still "warns
 * and returns `[]`" (Milestone B's own table: "hub fans out `replica` — not built"). This file is
 * that decision: given the ops the hub just applied and where every node's replica watermark
 * stands, which node gets which frames, in what order. **Pure — no I/O, no network, no clock.** The
 * caller (which also owns `hubSeq` allocation and the `ack` reply, neither of which is this file's
 * job) sends what this returns.
 *
 * **Whether the ORIGIN node is also a recipient — decided, not assumed.** The node that authored
 * these ops is about to get an `ack` for the `ops` frame it sent, which makes it tempting to skip it
 * here as redundant. That is wrong, for a reason grounded in the code, not just in D4's principle:
 * `pendingSince` — the marker that says "this record still has an unconfirmed local write" — is
 * cleared in exactly one place, `applyOpToRecord` in `cluster/replica.ts`, which only ever runs on a
 * `ClusterReplicaFrame`'s `changes`. The `ack`-driven settlement in `todos.ts` (~908–939) is narrowly
 * scoped to `markStarted`'s claim path (D9a) — it stamps `startedOn`/`hubSeq` for that one field and
 * nothing else. An ordinary field write (status, priority, archive, …) has no other settlement path
 * at all. So excluding the origin here would strand every ordinary optimistic write on the very node
 * that made it: `pendingSince` would never clear, the outbox would re-derive and resend it forever,
 * and — the D4 framing — a hub correction to that write would never become visible, which "is the
 * same failure as no correction". **Decision: the origin gets no special treatment.** It is filtered
 * by its own watermark exactly like every other target (below); `originNodeId` is accepted so a
 * caller can be explicit about who sent the batch and so this decision is testable, but it plays no
 * role in which frames get built.
 *
 * The remaining requirements are mechanical and are what the tests pin:
 *
 *  - **Frame cap.** More owed ops than `CLUSTER_OPS_PER_FRAME_MAX` for one node means several
 *    frames, ascending, each frame's own `hubSeq` the highest in THAT frame — the contract's own
 *    rule on `clusterReplicaFrameSchema.hubSeq` ("the highest order in `changes`").
 *  - **Watermark filter.** An op at or below a target's `appliedThroughHubSeq` is not resent —
 *    idempotence exists on the receiving side (`applyReplica` skips it too), but resending it is
 *    waste, and a target already ahead of an op receiving it anyway would be a symptom worth seeing,
 *    not masking here.
 *  - **No frame when nothing is owed.** A target with nothing above its watermark gets no entry in
 *    the returned plan at all — never a `ClusterReplicaFrame` with an empty `changes`, which is a
 *    real bug (a phantom "something changed" push) dressed up as liveness.
 *  - **Order.** Frames per node are ascending by `hubSeq`; splitting never reorders or drops an op —
 *    the concatenation of one node's frames' `changes` equals exactly the ops it was owed, in hub
 *    order.
 */

export interface ReplicaFanoutTarget {
  readonly nodeId: ClusterNodeId;
  /** What this node has already applied. Anything at or below it is dropped, not resent. */
  readonly appliedThroughHubSeq: number;
}

export interface ReplicaFanoutInput {
  readonly scope: ClusterOpScope;
  readonly projectKey?: ClusterProjectKey;
  /** Ops the hub has APPLIED, each already stamped with its `hubSeq`. Not assumed to already be in
   *  hub order — this file sorts before batching, the same "order-declared, not order-sensitive"
   *  posture `replica.ts#applyReplica` takes on the receiving side. */
  readonly applied: readonly (ClusterOp & { hubSeq: number })[];
  readonly targets: readonly ReplicaFanoutTarget[];
  /** The node the ops came from. See the module docblock for why this does not change which frames
   *  get built. */
  readonly originNodeId?: ClusterNodeId;
}

export interface ReplicaFanoutPlan {
  readonly nodeId: ClusterNodeId;
  readonly frames: readonly ClusterReplicaFrame[];
}

/** Ops a target has not yet applied, in hub order — the shared logic behind both the watermark
 *  filter and the ordering requirement, so there is exactly one place either could go wrong. */
function owedFor(
  applied: readonly (ClusterOp & { hubSeq: number })[],
  target: ReplicaFanoutTarget,
): (ClusterOp & { hubSeq: number })[] {
  return applied.filter((op) => op.hubSeq > target.appliedThroughHubSeq).sort((a, b) => a.hubSeq - b.hubSeq);
}

export function planReplicaFanout(input: ReplicaFanoutInput): ReplicaFanoutPlan[] {
  const plans: ReplicaFanoutPlan[] = [];

  for (const target of input.targets) {
    const owed = owedFor(input.applied, target);
    if (owed.length === 0) continue; // nothing owed — no plan entry at all, never an empty frame.

    const frames: ClusterReplicaFrame[] = [];
    for (let i = 0; i < owed.length; i += CLUSTER_OPS_PER_FRAME_MAX) {
      const batch = owed.slice(i, i + CLUSTER_OPS_PER_FRAME_MAX);
      frames.push({
        type: 'replica',
        protocol: CLUSTER_PROTOCOL,
        scope: input.scope,
        projectKey: input.projectKey,
        changes: batch,
        // `owed` is sorted ascending, so the batch's last element is its own max — the contract's
        // rule for `hubSeq` on this frame type. `batch` is never empty: the loop only ever starts a
        // slice at an index below `owed.length`.
        hubSeq: batch[batch.length - 1]!.hubSeq,
      });
    }

    plans.push({ nodeId: target.nodeId, frames });
  }

  return plans;
}
