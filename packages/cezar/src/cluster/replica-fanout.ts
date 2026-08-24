import {
  CLUSTER_FRAME_MAX_BYTES,
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
 *  - **Frame cap — CORRECTED 2026-08-23 (D29): count AND bytes, not count alone.** This bullet used
 *    to read only "more owed ops than `CLUSTER_OPS_PER_FRAME_MAX` for one node means several
 *    frames" — true, but it silently let a batch of ops individually small but numerous stay under
 *    the 500-op cap while blowing well past `CLUSTER_FRAME_MAX_BYTES` (contract:
 *    `packages/contract/src/cluster.ts:100-107`, "a sender that would exceed **either** splits and
 *    resumes from the last `ack`" — both bounds are the contract's, not an implementation detail).
 *    A frame over budget is silently dropped at `link-server.ts:262-267` (a `warn` log, no signal
 *    back to the sender) — from this module's own vantage point, a write that vanishes. No test in
 *    this file ever built ops with realistic byte sizes, only realistic counts, which is what let
 *    this ship as "5 mutations red" against a guard that was never exercised. Splitting now stops a
 *    frame at whichever bound — `CLUSTER_OPS_PER_FRAME_MAX` or `CLUSTER_FRAME_MAX_BYTES` — is hit
 *    first, measuring bytes the way the wire measures them: `Buffer.byteLength(JSON.stringify(frame),
 *    'utf8')` on the FULL encoded frame, envelope included, not a sum over `changes` alone (which is
 *    `ops.ts#packOpsFrame`'s own approach on the other half of this wire, and undercounts by the
 *    envelope's own bytes — small in practice, but the wrong quantity to bind a hard ceiling to).
 *    Each frame's own `hubSeq` is still the highest in THAT frame — the contract's own rule on
 *    `clusterReplicaFrameSchema.hubSeq` ("the highest order in `changes`") — regardless of which
 *    bound caused the split.
 *
 *    **The single-oversized-op case — SUPERSEDED 2026-08-23, same day: EXCLUDED, not thrown.** This
 *    used to throw here, deliberately: the reasoning below is kept because the trade-off it describes
 *    is real and is what the exclusion design (below) still has to answer, not because the throw is
 *    still what happens. ~~An op that, alone, would encode (with its frame envelope) over
 *    `CLUSTER_FRAME_MAX_BYTES` has no frame it can legally occupy... **Decision: throw**, with a
 *    message naming the opId, entity, entityId, hubSeq, target node, and measured size... caught
 *    safely by `link-server.ts`'s own existing `onFrame` try/catch... Cost, stated plainly: because
 *    the throw aborts the whole `planReplicaFanout` call, every OTHER, ordinary-sized op in the same
 *    batch also fails to replicate this round, to every target, not just the one that hit the
 *    oversized op — the origin never receives its `ack` either... A narrower fix... needs a richer
 *    return shape and a `try`/`catch` at the `hub-router.ts` call site, which is exactly the file
 *    this change may not touch~~. That constraint lifted (this file now owns `hub-router.ts` too),
 *    and the cost turned out to be reachable, not hypothetical: `clusterOpShape.fields`/`.unknown`
 *    are unbounded `z.record` (`contract/src/cluster.ts:365,381`) — nothing caps a todo's body, and
 *    this repo's own todos routinely carry prose (Context / What to do / Acceptance criteria) that
 *    can exceed 256 KB. A throw there is not a rare defensive branch; it is a real, permanent wedge
 *    of one project's entire replication behind one oversized record.
 *
 *    **Decision: exclude the op, report it, let everything else through — never throw for an INPUT
 *    condition, only for a genuine internal error (below).** `planReplicaFanout` now returns
 *    `{ plans, excluded }`, `excluded` ALWAYS present (never optional) so a caller destructuring only
 *    `{ plans }` still has the data sitting in the result, not silently discarded for want of an
 *    opt-in callback — see `ReplicaFanoutResult`. For the specific target that owed the
 *    unrepresentable op: that op is skipped (`i` still advances) and the REST of that target's owed
 *    ops keep batching normally around it. The target's watermark is deliberately allowed to advance
 *    PAST the excluded op once a later, representable op is delivered — this is the load-bearing
 *    choice, not an oversight: the excluded op will never become representable by waiting (its size
 *    does not change), so refusing to advance the watermark past it would turn one oversized record
 *    into a permanent per-target stall for every OTHER op behind it too — D29's exact cost, just
 *    scoped to one target instead of the whole batch. A gap this file cannot close by design (see
 *    below) is a worse outcome disguised as caution if it also blocks progress that IS possible.
 *
 *    **What "excluded" means for the target, and the gap this file cannot close.** The op is durably
 *    applied at the hub (D4) — nothing here is a hub-side data loss. What is genuinely lost is that
 *    ONE target's copy of that ONE record: it will never arrive via replication, because its size
 *    does not depend on which target is asking. `hub-router.ts` is what turns `excluded` into a
 *    signal — see its own docblock for what "loud" means there and why no durable, queryable store
 *    for this exists yet. **When the excluded target IS the origin, the consequence is worse and this
 *    file cannot fix it from here**: `pendingSince` on that record clears in exactly one place
 *    (`replica.ts#applyReplicaFrame`'s `changes`, per this module's own docblock above), which the
 *    origin can now never receive for THIS record either. `ops.ts#deriveTodoOps` re-derives the
 *    outbox fresh from still-`pendingSince` records every flush tick — with a NEW `opId` each time
 *    (`newOpId()`) — so the origin will keep deriving and sending a fresh attempt at the same
 *    still-pending record forever, each one durably re-applied at the hub (a new `hubSeq` burned
 *    every time, since a fresh `opId` means `op-history.ts`'s idempotence cache never short-circuits
 *    it) and hitting this same exclusion again on every attempt. Closing that needs a change to
 *    `pendingSince` clearing in `replica.ts`/`todos.ts`, which this file does not own and this change
 *    does not touch — flagged here, not fixed, the same way `resumeFrom: []`'s own gap is flagged
 *    above rather than declared solved.
 *
 *    **Refusing the op at APPLY time instead (so it never becomes durable) was considered and
 *    rejected.** It conflates two different questions: whether the hub can STORE this write locally
 *    (yes — nothing in `todos.ts`/D1 imposes any such ceiling) and whether the hub can TELL OTHER
 *    NODES about it (the actual, narrower constraint). Refusing at apply time would reject a
 *    perfectly valid local write for a replication-layer limit, at the wrong layer, and is also out
 *    of reach from this file (`hub-apply.ts`/`hub-ops.ts` are not owned by this change).
 *
 *    **The genuine-internal-error throw stays.** The defensive per-frame check below (a completed
 *    frame that still measures over budget) is a bug in THIS splitter, not an input condition — it
 *    earned its place catching a real mutation (Mutation A, session transcript) before any test
 *    assertion did, and is kept as a throw on purpose, distinct from the handled case above.
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

/** One op that could not be represented in ANY `ClusterReplicaFrame` for `nodeId` — see module
 *  docblock, "Frame cap" → "The single-oversized-op case". The same `opId` can appear once PER
 *  target that owed it and could not receive it — that is expected, not a duplicate-reporting bug:
 *  each target's gap on this record is independent and is reported once for each. */
export interface ReplicaFanoutExclusion {
  readonly nodeId: ClusterNodeId;
  readonly opId: string;
  readonly entity: string;
  readonly entityId: string;
  readonly hubSeq: number;
  /** What a `ClusterReplicaFrame` containing ONLY this op measures, in bytes — always over
   *  `CLUSTER_FRAME_MAX_BYTES`, which is exactly why this entry exists. */
  readonly bytes: number;
}

export interface ReplicaFanoutResult {
  readonly plans: readonly ReplicaFanoutPlan[];
  /** ALWAYS present, never optional — see module docblock. A caller that destructures only
   *  `{ plans }` still has this sitting in the full result object; it cannot vanish for want of an
   *  opt-in callback the caller never wired up. Empty (`[]`) in the overwhelmingly common case. */
  readonly excluded: readonly ReplicaFanoutExclusion[];
}

/** Ops a target has not yet applied, in hub order — the shared logic behind both the watermark
 *  filter and the ordering requirement, so there is exactly one place either could go wrong. */
function owedFor(
  applied: readonly (ClusterOp & { hubSeq: number })[],
  target: ReplicaFanoutTarget,
): (ClusterOp & { hubSeq: number })[] {
  return applied.filter((op) => op.hubSeq > target.appliedThroughHubSeq).sort((a, b) => a.hubSeq - b.hubSeq);
}

/** Widest a real `hubSeq` could ever encode as — used only to size the envelope's byte estimate
 *  conservatively (below), never as a real value. Keeps the running byte count from ever
 *  UNDER-estimating a frame whose actual `hubSeq` turns out wider than expected. */
const HUBSEQ_WIDTH_PLACEHOLDER = Number.MAX_SAFE_INTEGER;

function buildFrame(
  input: Pick<ReplicaFanoutInput, 'scope' | 'projectKey'>,
  batch: (ClusterOp & { hubSeq: number })[],
): ClusterReplicaFrame {
  return {
    type: 'replica',
    protocol: CLUSTER_PROTOCOL,
    scope: input.scope,
    projectKey: input.projectKey,
    changes: batch,
    // `batch` is drawn from an ascending-sorted `owed` (see `owedFor`) and built in order, so its
    // last element is its own max — the contract's rule for `hubSeq` on this frame type.
    hubSeq: batch[batch.length - 1]!.hubSeq,
  };
}

/** What the wire actually measures — `link-server.ts` checks `Buffer.byteLength(JSON.stringify(frame),
 *  'utf8')` against `CLUSTER_FRAME_MAX_BYTES` on the exact frame object it is about to send. A budget
 *  computed over anything narrower (summing `changes` entries alone, as `ops.ts#packOpsFrame` does on
 *  the wire's other half) drifts from what is actually enforced by the envelope's own bytes. */
function frameBytes(frame: ClusterReplicaFrame): number {
  return Buffer.byteLength(JSON.stringify(frame), 'utf8');
}

function opBytes(op: ClusterOp & { hubSeq: number }): number {
  return Buffer.byteLength(JSON.stringify(op), 'utf8');
}

export function planReplicaFanout(input: ReplicaFanoutInput): ReplicaFanoutResult {
  const plans: ReplicaFanoutPlan[] = [];
  const excluded: ReplicaFanoutExclusion[] = [];

  // Computed once — `scope`/`projectKey` are fixed for the whole call, and this is what an EMPTY
  // frame for this call would encode to (envelope only, worst-case `hubSeq` width). Reused as the
  // running byte count's starting point for every batch below, so deciding where to split an op into
  // the next frame never re-stringifies the whole growing batch (which would be quadratic in a large
  // one) — it tracks a running total instead, one `JSON.stringify` per OP, not per candidate frame.
  const envelopeBytes = frameBytes({
    type: 'replica',
    protocol: CLUSTER_PROTOCOL,
    scope: input.scope,
    projectKey: input.projectKey,
    changes: [],
    hubSeq: HUBSEQ_WIDTH_PLACEHOLDER,
  });

  for (const target of input.targets) {
    const owed = owedFor(input.applied, target);
    if (owed.length === 0) continue; // nothing owed — no plan entry at all, never an empty frame.

    const frames: ClusterReplicaFrame[] = [];
    let i = 0;
    while (i < owed.length) {
      const batch: (ClusterOp & { hubSeq: number })[] = [];
      let runningBytes = envelopeBytes;

      while (i < owed.length && batch.length < CLUSTER_OPS_PER_FRAME_MAX) {
        const op = owed[i]!;
        // +1: conservatively charges every element a leading comma, including the first (which the
        // real encoding does not pay for) — a deliberate 1-byte-per-op overcount, cheaper to reason
        // about than exact separator bookkeeping and never enough to falsely reject a frame that
        // would actually have fit.
        const marginal = opBytes(op) + 1;

        if (batch.length === 0 && runningBytes + marginal > CLUSTER_FRAME_MAX_BYTES) {
          // See module docblock, "Frame cap" → "The single-oversized-op case": this op cannot occupy
          // ANY `ClusterReplicaFrame` for this target, split however it likes. EXCLUDED, not thrown —
          // recorded here so the report can never be swallowed by construction (`excluded` is never
          // optional on the return), then skipped so the rest of this target's owed ops, and every
          // OTHER target's plan, are not collateral damage for one unrepresentable record.
          excluded.push({
            nodeId: target.nodeId,
            opId: op.opId,
            entity: op.entity,
            entityId: op.entityId,
            hubSeq: op.hubSeq,
            bytes: frameBytes(buildFrame(input, [op])),
          });
          i += 1;
          continue;
        }
        if (batch.length > 0 && runningBytes + marginal > CLUSTER_FRAME_MAX_BYTES) break;

        batch.push(op);
        runningBytes += marginal;
        i += 1;
      }

      // Every candidate this pass considered was excluded above (a run of unrepresentable ops with
      // nothing else in between) — nothing to build a frame from. `i` still advanced with each
      // exclusion, so the outer `while (i < owed.length)` makes real progress either way: it will
      // either try the next op fresh or, once `owed` is exhausted, exit on its own. Guarding here is
      // not about avoiding an infinite loop (there is none) — it is to avoid calling `buildFrame` on
      // an empty batch, which would throw on `batch[batch.length - 1]` having no element.
      if (batch.length === 0) continue;

      const frame = buildFrame(input, batch);
      // Defensive, not a decision point: the running estimate above is conservative by construction
      // (over-counts, never under-counts), so this should never fire. Costs one real stringify per
      // COMPLETED frame, not per candidate op, so it stays cheap even for a large batch. Distinct
      // from the exclusion above: THAT is an input condition (this op cannot be represented, ever) —
      // THIS is a bug in this splitter's own estimate, and stays a throw.
      if (frameBytes(frame) > CLUSTER_FRAME_MAX_BYTES) {
        throw new Error(
          `cluster replica-fanout: internal error — a frame built for node "${target.nodeId}" measured ` +
            `${frameBytes(frame)} bytes, over the ${CLUSTER_FRAME_MAX_BYTES}-byte bound the running estimate ` +
            `should have kept it under (batch of ${batch.length} ops)`,
        );
      }
      frames.push(frame);
    }

    // A target every one of whose owed ops was excluded gets no plan entry at all — same invariant
    // as "nothing owed": never a `ClusterReplicaPlan` with an empty `frames` array.
    if (frames.length > 0) plans.push({ nodeId: target.nodeId, frames });
  }

  return { plans, excluded };
}
