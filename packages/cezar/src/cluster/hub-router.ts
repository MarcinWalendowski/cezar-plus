import {
  CLUSTER_PROTOCOL,
  type ClusterDownlinkFrame,
  type ClusterFreshnessFrame,
  type ClusterNodeId,
  type ClusterAckResult,
  type ClusterOp,
  type ClusterOpScope,
  type ClusterProjectKey,
  type ClusterReplicaFrame,
  type ClusterUplinkFrame,
  type ClusterWatermark,
  type StoredClusterNodeIdentity,
} from '@loki-labs/cezar-plus-contract';
import type { TodoItem } from '../todos.ts';
import type { ClusterHomeOptions } from './node-identity.ts';
import { toNodeWire, toPairingWire } from './wire.ts';
import { markNodeSeen, readPeers } from './peers.ts';
import { applyOpsFrame, type HubOpAllocation, type HubOpOutcome } from './hub-ops.ts';
import { planReplicaFanout } from './replica-fanout.ts';
import { scanForReplay } from './replay.ts';
// TYPE-ONLY, erased at build: the reply contract `link-server.ts` defines for `onFrame` (D28). The
// module doc below still holds — this file knows the SHAPE of a reply, never that a socket exists,
// and imports no value from that module, so there is no runtime edge and no import cycle.
import type { ClusterFrameReplies } from './link-server.ts';

/**
 * The hub-side `onFrame` handler `ClusterLinkServer` (`cluster/link-server.ts`) calls for every
 * admitted, schema-parsed, protocol-checked uplink frame (spec
 * `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, "API contracts" → link frames).
 * `link-server.ts` owns the socket, the upgrade auth, the send budget and the heartbeat; it has no
 * opinion on what any frame MEANS. This is that opinion, and only that — routing is a pure function
 * of `(authenticated nodeId, frame)`, so the socket bookkeeping never has to know a frame type
 * exists, and this file never has to know a socket exists.
 *
 * **This increment makes a node LINKED AND VISIBLE, not REPLICATED.** `hello` gets a real roster
 * and pairing snapshot back; `presence` updates the roster's liveness claim. `freshness` and `ops`
 * are OBSERVED AND LOGGED ONLY — nothing here persists a freshness claim or applies an op. Ops
 * replication (spoke outbox → hub oplog → `hubSeq` → `ack` → `replica` fan-out) and dispatch are the
 * next milestones, not this one; each case below says explicitly what it does and does not do, so
 * "the frame is routed" is never mistaken for "the frame's effect is durable".
 *
 * **The identity guard on `hello` is the one thing here that is a security boundary, not a stub.**
 * A `hello` whose own claimed `nodeId` disagrees with the id the link's upgrade authenticated is
 * refused outright, never merged or trusted — the socket's authenticated identity always wins over
 * the frame body, or a node that authenticated as A could claim to be B in its `hello` and receive
 * B's roster view.
 */

/**
 * Everything the `ops` case needs to do real work, and the reason it is OPTIONAL rather than
 * required: a hub with no replication wired is a legitimate state (this package landed before
 * `hub-apply.ts` and `op-history.ts` existed), and the honest behaviour there is the pre-existing
 * one — warn, apply nothing, and send NO ack, so the spoke keeps every op in its outbox. Making
 * this required would have forced every caller and every existing test to supply a replication
 * stub, and a stub is exactly the thing that turns "not implemented" into a fabricated ack.
 *
 * Every member is injected rather than imported. `hub-apply.ts` and `op-history.ts` are separate
 * packages built concurrently with this wiring; depending on their INTERFACES rather than their
 * modules is what let this file be written and tested before they landed, and is what keeps this
 * router a pure function of `(nodeId, frame)` with no filesystem of its own.
 */
export interface HubReplicationDeps {
  /** `cluster/hub-seq.ts#HubSeqAllocator.allocate`, with scope/projectKey closed over by the
   *  caller — this router hands it only a count, matching `HubOpsDeps#allocateSeq`. */
  readonly allocate: (input: {
    scope: ClusterOpScope;
    projectKey?: ClusterProjectKey;
    count: number;
  }) => Promise<HubOpAllocation>;
  /** `cluster/hub-apply.ts` — applies ONE op through the todos store API under the lease (D7) and
   *  returns a per-op verdict. A RETURNED `{accepted:false}` is a durable decision; a THROW is
   *  transient and makes `hub-ops.ts` stop the watermark rather than fabricate one. */
  readonly applyOp: (op: ClusterOp & { hubSeq: number }) => Promise<HubOpOutcome>;
  /** `cluster/op-history.ts` — the durable per-`opId` verdict cache that makes a retransmit
   *  idempotent. Durable, never a Map: this hub blue-green deploys several times a day. */
  readonly findAppliedOp: (opId: string) => Promise<ClusterAckResult | undefined>;
  readonly recordAppliedOp: (opId: string, result: ClusterAckResult) => Promise<void>;
  /**
   * `ClusterLinkServer.send`. Fan-out CANNOT ride this router's return value: that array goes only
   * to the node whose frame we are answering, and a replica has to reach every OTHER linked node.
   * Returns false for a node that is not connected, which is not an error — it will re-seed its
   * watermark from its own `hello` when it reconnects.
   */
  readonly sendTo: (nodeId: ClusterNodeId, frame: ClusterDownlinkFrame) => boolean;
  /** `ClusterLinkServer.connectedNodes`. */
  readonly connectedNodes: () => ClusterNodeId[];
  /**
   * B4 — CONNECT-TIME REPLAY, Design B (scan present state; the engine is `cluster/replay.ts`).
   * This project's CURRENT records as the hub holds them, or **`undefined` when `nodeId` is not
   * confirmed-paired with `projectKey` both ways** — D20/D21's gate, which in production is
   * `server/cluster-routes.ts#resolveHubTodosRoot(projectKey, nodeId, env)` followed by
   * `readTodos(todosDataDir(root))`. Called once per candidate project per `hello`.
   *
   * **`undefined` and `[]` mean different things and must stay distinguishable.** `undefined` is a
   * REFUSAL — this node may not resume on this project, and it gets no `resumeFrom` entry for it at
   * all. `[]` is an ENTITLEMENT with nothing in it — an empty project, which does get a
   * `resumeFrom` entry stating the position it resumed from. Answering a refusal with `[]` would
   * put "paired, nothing owed" on the wire for a project the hub actually refuses, which is exactly
   * the "computed, and there are none" ambiguity the `welcome`'s `proposals` field is omitted to
   * avoid. See the `hello` case for what the node actually receives, and for the one thing the wire
   * still cannot say.
   *
   * **Project-scoped only, deliberately.** There is no workspace-scoped todo store anywhere in this
   * build — `buildHubReplication`'s own `applyOp` throws for `scope !== 'project'`, and
   * `spoke-runtime.ts` ignores a workspace-scoped `replica` frame outright. A `scope` parameter here
   * would be a shape with exactly one legal value and a second, untested branch waiting to be
   * fabricated.
   *
   * **OPTIONAL, and its absence is a real, named state — not a default to be quietly assumed.** A
   * hub with `replication` wired but no `readTodosFor` still replicates LIVE and still cannot
   * replay; `hello` says so in a warning and keeps `resumeFrom: []`, which is the honest "this hub
   * cannot replay" the empty value has always meant. It is optional for the same reason
   * `HubReplicationDeps` itself is: this router is built and tested ahead of its wiring, and a
   * required member forces every caller to fabricate one, which is how a fake becomes the only
   * thing ever exercised.
   *
   * **Why "give me the records" and not "give me a dataDir".** This router does no I/O and has no
   * filesystem (see the module doc), and deciding whether a node may be replayed a project is an
   * AUTHORIZATION question that already has exactly one home. Handing this router a path would move
   * that decision into a file that cannot see `peers.json`; handing it this function keeps the link
   * path's replay gate and its apply gate as the SAME call, rather than two implementations of one
   * rule that agree today.
   */
  readonly readTodosFor?: (
    projectKey: ClusterProjectKey,
    nodeId: ClusterNodeId,
  ) => Promise<readonly TodoItem[] | undefined>;
}

/**
 * Everything the `freshness` case needs to route a reply into Milestone C's dispatch correlation
 * store (`cluster/hub-dispatch.ts#createHubDispatcher`, decision C-f), and why it is OPTIONAL
 * rather than required: a hub built before that package existed is a legitimate state, and the
 * honest behaviour there is the pre-existing one — observe, warn, never persist. Injected as a
 * narrow interface rather than importing `hub-dispatch.ts` directly, for the same reason
 * `HubReplicationDeps` is (see that interface's own docblock): the two packages are built and
 * tested independently, and this file should not gain a dependency on placement/dispatch-building
 * it has no use for beyond the one method this case calls.
 */
export interface HubDispatchCorrelationDeps {
  /** `HubDispatcher#recordFreshnessReply`. Resolves a pending dispatch this hub sent, or is a
   *  no-op (returns `[]`) for a routine freshness beat unrelated to any dispatch. Never throws. */
  readonly recordFreshnessReply: (nodeId: ClusterNodeId, frame: ClusterFreshnessFrame) => readonly unknown[];
}

export interface HubFrameRouterDeps {
  /** The hub's own identity — `hubNodeId` on every `welcome`. */
  identity: StoredClusterNodeIdentity;
  /** Omit to keep the pre-replication behaviour: observe, warn, never ack. See `HubReplicationDeps`. */
  replication?: HubReplicationDeps;
  /** Omit to keep the pre-Milestone-C `freshness` behaviour: observe, warn, never persist. See
   *  `HubDispatchCorrelationDeps`. */
  dispatchCorrelation?: HubDispatchCorrelationDeps;
  env?: NodeJS.ProcessEnv;
  warn?: (message: string) => void;
}


/** A bounded, deterministic sample for a warning that could otherwise name hundreds of records —
 *  see the REPLAY-UNORDERED warning's own comment for why "all of them" is not an option there. The
 *  COUNT is always stated in full by the caller; this only bounds the illustration. */
function sampleIds(ids: readonly string[], limit = 5): string {
  const shown = ids.slice(0, limit).join(', ');
  return ids.length > limit ? `${shown}, … (+${ids.length - limit} more)` : shown;
}


export function createHubFrameRouter(
  deps: HubFrameRouterDeps,
): (nodeId: ClusterNodeId, frame: ClusterUplinkFrame) => Promise<ClusterFrameReplies> {
  const homeOptions: ClusterHomeOptions = { env: deps.env, warn: deps.warn };

  /**
   * Nodes whose CONNECT-TIME REPLAY is in flight — held out of live fan-out until their replay
   * frames have been written (D30, F3's first half).
   *
   * **This is an ordering gate, not an authorization one, and the ordering is what makes replay
   * correct at all.** Replay (Design B) synthesizes ops from PRESENT state, so a replayed row
   * carries the record's own stored `hubSeq` — a number BELOW whatever the hub is allocating right
   * now. A receiver's `appliedThroughHubSeq` is monotonic and `cluster/replica.ts` drops anything at
   * or below it. So if a live batch for another node's write (hubSeq 12) reaches this node before
   * its replay frames (hubSeq 6-11), the node applies 12, and every replayed row is then silently
   * discarded on arrival — replay would appear to run and repair nothing. Holding the node out of
   * live fan-out until its replay is on the wire is what stops that reordering; the ops it misses
   * during the hold are not lost, because they are in the hub's own store and are what the NEXT
   * replay reads.
   *
   * Released in `onWritten` once every frame of that `hello`'s reply has a verdict — deliberately
   * after the WRITE, not before the return, because a `sendTo` from a concurrently-handled `ops`
   * frame can land in the gap between this handler resolving and `link-server.ts` writing its
   * replies. A hold that leaks (a caller that returns without ever reporting, which
   * `ClusterLinkServer` never does) degrades to "this node replicates only on reconnect", never to
   * data loss: the next `hello` re-takes the hold and replay ships the whole scope again.
   */
  const replayHold = new Set<ClusterNodeId>();

  /**
   * Per-node replica watermarks, IN MEMORY and deliberately not persisted.
   *
   * The asymmetry is what makes that safe: replica application is idempotent and a receiver drops
   * anything at or below its own watermark (`cluster/replica.ts`), so **over-sending costs
   * bandwidth while under-sending loses a write**. A hub restart forgets every entry, each spoke
   * reconnects, its own `hello` re-seeds the truth from the only place that actually knows it, and
   * the worst case is a resend the spoke discards.
   *
   * Persisting it would buy nothing `hello` does not already provide, and would introduce a real
   * hazard in exchange: a stored watermark that outlives the node's actual state claims the node is
   * caught up when it is not — and that error is the silent, unrecoverable direction.
   *
   * Keyed `nodeId -> watermarkKey -> appliedThroughHubSeq`, where the inner key pairs scope with
   * projectKey so a project's order never shadows the workspace's.
   */
  const watermarks = new Map<ClusterNodeId, Map<string, number>>();
  const watermarkKey = (scope: ClusterOpScope, projectKey?: ClusterProjectKey): string =>
    scope === 'workspace' ? 'workspace' : `project:${projectKey ?? ''}`;

  const readWatermark = (node: ClusterNodeId, key: string): number => watermarks.get(node)?.get(key) ?? 0;

  /** Advancing WITHIN a live session, as frames go out. Monotonic: a late or duplicate frame
   *  carrying a lower number must not walk the watermark backwards and re-send history.
   *
   *  **Only called where a write's success is known synchronously** — the `sendTo`-pushed branch
   *  of the `ops` case's fan-out loop. The origin's OWN replica frames ride a different, unconfirmed
   *  channel and deliberately never call this function at all; see that branch's own comment (D28 /
   *  F4) for why advancing on an unconfirmed write was the bug. */
  const advanceWatermark = (node: ClusterNodeId, key: string, to: number): void => {
    const forNode = watermarks.get(node) ?? new Map<string, number>();
    if (to > (forNode.get(key) ?? 0)) forNode.set(key, to);
    watermarks.set(node, forNode);
  };

  /**
   * Seeding from a `hello`, which is a SET and deliberately not the monotonic advance above.
   *
   * The distinction is load-bearing and was nearly got wrong here. The hub advances a watermark
   * when it SENDS a frame, which is a claim about delivery, not about application. If the node dies
   * between receiving and applying, the hub's number is too high. On reconnect the node reports what
   * it has ACTUALLY applied — a LOWER, truthful value — and that is precisely the case that must
   * win. A monotonic seed would discard it as stale and the hub would never resend those ops: the
   * node is permanently missing writes that everyone believes it has.
   *
   * Taking the node's word on `hello` is safe in the other direction too, because over-sending is
   * free: replica application is idempotent and the receiver drops anything at or below its own
   * watermark. So a spoke that under-reports costs one redundant frame; a hub that over-remembers
   * costs a silent, permanent gap.
   */
  const seedWatermark = (node: ClusterNodeId, key: string, to: number): void => {
    const forNode = watermarks.get(node) ?? new Map<string, number>();
    forNode.set(key, to);
    watermarks.set(node, forNode);
  };

  return async (nodeId, frame) => {
    switch (frame.type) {
      case 'hello': {
        // THE LOAD-BEARING GUARD. `nodeId` is what `authenticateLinkUpgrade` verified against this
        // node's own HMAC secret at upgrade time (`link-server.ts`); `frame.nodeId` is whatever the
        // frame BODY claims. They must agree, or an authenticated node could name a different id in
        // its `hello` and receive that other node's roster view back. This is checked here, not in
        // the schema — no schema constraint can express "equal to a value carried on a different
        // layer (the upgrade), not on the frame itself".
        if (frame.nodeId !== nodeId) {
          // **D40b, 2026-08-23: `closeAfterWrite` is the load-bearing half of this refusal, not a
          // tidy-up.** Returning the frame alone refused the CONTENT and left the SOCKET open, and
          // an open socket is a `connectedNodes()` entry, which is a `planReplicaFanout` target — so
          // a peer that simply ignored the refusal went on being served. Worse, this `return`
          // precedes the `watermarks.delete(nodeId)` below, so the forged hello reseeded nothing and
          // the hub kept whatever stale, possibly too-high watermark a previous session left: D30
          // root cause 1, reopened by the one frame a hub has the most reason to distrust. Measured
          // by retransmitting an op below the stale mark — not re-sent after a forged hello, re-sent
          // after a legitimate one.
          //
          // `unknown-node` rather than `bad-signature`: the signature on the UPGRADE was valid (that
          // is how this socket exists at all), and it is the id named in the BODY that answers to
          // nobody. `link-client.ts` retries every reason but `protocol-major`, which is right here
          // — a spoke misconfigured into claiming the wrong id should keep trying and start working
          // the moment it is fixed, with `refusedReason` rendered in the cockpit throughout.
          return {
            frames: [
              {
                type: 'refuse',
                protocol: CLUSTER_PROTOCOL,
                reason: 'unknown-node',
                message: `hello claimed nodeId "${frame.nodeId}", the link authenticated as "${nodeId}"`,
              },
            ],
            closeAfterWrite: 'unknown-node',
          };
        }

        // A `hello` from a DISABLED node cannot reach this branch at all, so there is no matching
        // check here. `disableNode` (D22) deletes the node's stored secret, so
        // `authenticateLinkUpgrade` already refuses the UPGRADE with `unknown-node` before a socket
        // exists to carry a `hello` on. Re-checking `disabledAt` in this handler would be dead code
        // guarding a path `link-server.ts` has already closed — see `peers.ts#disableNode`'s own
        // docblock for the two-sided revoke this depends on. (Exercised by
        // `hub-router.test.ts`'s "does not itself gate on disabledAt" case, so a reader does not
        // have to take the claim on faith.)
        // Seed from what the node says it has APPLIED — the only place that knows. A `hello` is a
        // fresh connection, so this SETS rather than advances: a node reporting less than the hub
        // last sent it is reporting reality (delivered is not applied), and that lower number must
        // win or the hub never resends and the node is permanently missing writes. See
        // `seedWatermark` for the full argument.
        //
        // **The DELETE before the seed is D30's third root cause, fixed 2026-08-23.** Seeding alone
        // only overwrites the keys THIS frame happens to mention, so a key it does not mention keeps
        // whatever the previous session left there — and nothing else ever clears it (the hub's
        // `watermarks` are in-memory and there is no disconnect signal in this file). A `hello` is by
        // definition a new session, and the frame is the node's COMPLETE statement of where it
        // stands, so anything absent from it means "I have applied nothing for that scope", not
        // "unchanged". Getting this backwards is the silent-permanent-gap direction: an unmentioned,
        // too-high leftover makes the hub believe the node holds ops it was never sent.
        //
        // **CORRECTED 2026-08-23, same day (D38 + D44) — the paragraph below is no longer true, and
        // what replaced it is a KNOWN GAP, not an improvement to celebrate.** Original text:
        // ~~"This matters more than it looks right now, because as of 2026-08-23
        // `ClusterLinkClient#sendHello` hardcodes `watermarks: []` — so EVERY real hello mentions
        // nothing at all, and without this delete the hub's watermark for a node would never be
        // corrected by anything, for the life of the process. Reported separately (it is a spoke-side
        // file); this fix does not depend on it changing, and gets more precise if it does."~~
        //
        // D38 wired `sendHello` to report real watermarks, so holds now seed from what the node
        // asserts. "Gets more precise if it does" was right about the mechanism and wrong about the
        // consequence: while every hello said `[]`, this delete-then-seed made EVERY RECONNECT replay
        // the full scope from zero — an unnamed, accidental anti-entropy pass that healed any
        // divergence below the watermark from any cause, including a `todos.json` write that reports
        // success without durably landing. `spoke-runtime.ts:621` advances the spoke's watermark to
        // `frame.hubSeq` regardless of what the on-disk apply actually did, and `replay.ts:160` can
        // only ship records ABOVE a target's watermark — so once the position is asserted, anything
        // that diverged below it is unreachable. Do NOT "fix" this by reverting D38 or by capping
        // frame `hubSeq` in `replica-fanout.ts` (an excluded op is unrepresentable at any time, so
        // replay never repaired that case either). Repair has to become deliberate — digest-at-hello
        // is the recommendation. See D44 in `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`.
        watermarks.delete(nodeId);
        for (const mark of frame.watermarks) {
          seedWatermark(nodeId, watermarkKey(mark.scope, mark.projectKey), mark.appliedThroughHubSeq);
        }

        // B4 — connect-time replay. The hold is taken HERE, synchronously, before the first `await`
        // below: from this instant until this hello's replies are written, this node is not a live
        // fan-out target, so nothing can reorder a higher `hubSeq` ahead of the replay (see
        // `replayHold`). Not taken at all when replay is unwired — holding a node out of live
        // fan-out with nothing to catch it up afterwards would turn a bounded over-send into a real
        // loss, which is the wrong trade in the one direction this design refuses to get wrong.
        const readTodosFor = deps.replication?.readTodosFor;
        if (readTodosFor) replayHold.add(nodeId);

        let peers: Awaited<ReturnType<typeof readPeers>>;
        try {
          peers = await readPeers(homeOptions);
        } catch (err) {
          // A held node that never gets its replay must not stay held: it would silently receive no
          // live fan-out until its next reconnect. Release, then rethrow — `link-server.ts` catches
          // and warns, and the spoke retries the whole handshake.
          replayHold.delete(nodeId);
          throw err;
        }

        // What the node itself reported for each scope — echoed back on `resumeFrom` unchanged,
        // because `ackedThroughHubSeq` is a fact about the node's OWN outbox that this hub does not
        // track per node. Fabricating a number here would put a hub opinion on the wire in a field
        // that means "what you told me", which is exactly the shape of lie `resumeFrom: []` was kept
        // honest to avoid.
        const reportedAcked = new Map<string, number>(
          frame.watermarks.map((mark) => [watermarkKey(mark.scope, mark.projectKey), mark.ackedThroughHubSeq]),
        );

        const replayFrames: ClusterReplicaFrame[] = [];
        const resumeFrom: ClusterWatermark[] = [];
        /** frame → the watermark advance it earns, applied only once the write is CONFIRMED. */
        const advanceOnDelivery = new Map<ClusterDownlinkFrame, { key: string; hubSeq: number }>();

        /**
         * **WHICH projects get replayed — the hub's own roster, never the node's claim about
         * itself.** Every pairing in `peers.json` that MENTIONS this node is a candidate —
         * `byNode[nodeId] !== undefined`, a membership test and deliberately not an entitlement
         * one. `readTodosFor` is the sole authority on whether each candidate is actually allowed,
         * and nothing here inspects `confirmedAt` to second-guess it. That split is why the D20/D21
         * both-ways gate stays in exactly one place instead of being half-reimplemented here and
         * drifting: the roster decides only which projects are worth ASKING about, and asking about
         * one that is refused costs a refusal, not a leak.
         *
         * The two alternatives were `frame.watermarks` and `frame.projects`, and both are wrong:
         *
         *  - **They are the NODE's claim about its own entitlements**, which is the same class of
         *    frame-body assertion both load-bearing guards in this file exist to refuse. Where a
         *    node may resume is the hub's fact.
         *  - **A NEWLY PAIRED node has neither.** It has never seen the project, so it carries no
         *    watermark for it and advertises nothing about it — and shipping a node its first full
         *    copy of a project it has just been paired with is precisely what this milestone is
         *    for. Driving off either field would skip exactly the case that motivates the feature.
         *  - **Both are hardcoded `[]` today** by `ClusterLinkClient#sendHello` ("Phase 1 is
         *    inert"), so a replay keyed on either would ship nothing, forever, while looking
         *    implemented — the same `resumeFrom: []` failure shape this whole increment exists to
         *    end, rebuilt with code behind it.
         *
         * `frame.watermarks` is still used, for the other half of the question: the node decides
         * WHERE it resumes within each scope (and supplies the `ackedThroughHubSeq` echo); the hub
         * decides WHAT it may resume on.
         */
        const candidates = readTodosFor ? peers.pairings.filter((pairing) => pairing.byNode[nodeId] !== undefined) : [];
        /**
         * Candidates `readTodosFor` refused. Reported as ONE class, not split by cause, because
         * this router cannot tell the causes apart and must not pretend to: `resolveHubTodosRoot`
         * returns the same bare `undefined` for a pairing this hub has not confirmed its own side
         * of, one confirmed only by the node, and one whose `projectId` its registry no longer has
         * — deliberately, on D20's rule that every refusal looks identical from outside. Splitting
         * these here would mean re-deriving the gate's reasoning from the roster, which is exactly
         * the duplication the `candidates` note above refuses.
         */
        const refusedProjects: string[] = [];

        for (const pairing of candidates) {
          const sourceKey = watermarkKey('project', pairing.projectKey);
          let todos: readonly TodoItem[] | undefined;
          try {
            todos = await readTodosFor!(pairing.projectKey, nodeId);
          } catch (err) {
            replayHold.delete(nodeId);
            throw err;
          }
          if (todos === undefined) {
            // A REFUSAL, never an empty replay. No `resumeFrom` entry is emitted for this project —
            // an entry with `appliedThroughHubSeq: 0` and no frames behind it would read as "paired,
            // and you are caught up", which is the opposite of what happened.
            refusedProjects.push(pairing.projectKey);
            continue;
          }

          // Read AFTER the seed above, so this is the node's own truth for this session, never a
          // leftover. This is also the number `resumeFrom` states, and it is captured BEFORE any
          // frame is planned — reading it again later would risk reading a value the fan-out for a
          // concurrently-handled `ops` frame had moved, which is D30's second root cause.
          const from = readWatermark(nodeId, sourceKey);
          const scan = scanForReplay({
            hubNodeId: deps.identity.nodeId,
            scope: 'project',
            projectKey: pairing.projectKey,
            todos,
            targets: [{ nodeId, appliedThroughHubSeq: from }],
          });

          resumeFrom.push({
            scope: 'project',
            projectKey: pairing.projectKey,
            appliedThroughHubSeq: from,
            ackedThroughHubSeq: reportedAcked.get(sourceKey) ?? 0,
          });

          for (const plan of scan.plans) {
            for (const replayFrame of plan.frames) {
              replayFrames.push(replayFrame);
              advanceOnDelivery.set(replayFrame, { key: sourceKey, hubSeq: replayFrame.hubSeq });
            }
          }

          // `excluded` and `unordered` are BOTH non-optional on the scan's result, for the stated
          // reason that a caller destructuring only `{ plans }` would silently discard them — so
          // this is where they stop being data and become a signal. One line per SOURCE with a
          // count and a bounded sample, never one per record: on a hub that has never replicated,
          // every row is `unordered` (no stored `hubSeq`), and a per-row warning would be hundreds
          // of lines on a single ordinary handshake.
          if (scan.excluded.length > 0) {
            deps.warn?.(
              `cluster hub: REPLAY-EXCLUDED — ${scan.excluded.length} record(s) cannot be replayed to "${nodeId}" for ` +
                `project "${pairing.projectKey}": each is, alone with its frame ` +
                `envelope, over CLUSTER_FRAME_MAX_BYTES, so no split can represent it and no future replay will ` +
                `either — its size does not change. Entities: ${sampleIds(scan.excluded.map((x) => x.entityId))}`,
            );
          }
          if (scan.unordered.length > 0) {
            deps.warn?.(
              `cluster hub: REPLAY-UNORDERED — ${scan.unordered.length} of ${todos.length} record(s) in ` +
                `project "${pairing.projectKey}" carry no hubSeq, so they have no ` +
                `position in the replicated order and are NOT replayed to "${nodeId}". A record only gets a hubSeq by ` +
                `passing through this hub's own apply path, so a large count here means this scope has never ` +
                `replicated — these rows need a first write, not a replay. Entities: ` +
                sampleIds(scan.unordered.map((u) => u.entityId)),
            );
          }
        }

        // The refused set, said out loud HUB-SIDE because the wire cannot say it. A node whose
        // pairing is refused gets no `resumeFrom` entry for that project — and no entry is also
        // what a project with nothing owed produces, and what a hub with replay unwired produces
        // for every project. `clusterWelcomeFrameSchema` is `.strict()` with no field for "these
        // scopes were refused", so the three are genuinely indistinguishable to the node until the
        // contract grows one. That is a real gap, stated here rather than papered over: an entry
        // with `appliedThroughHubSeq: 0` would be worse, because it asserts "paired, and you are
        // caught up" about a project the hub is refusing outright.
        //
        // One line with a count and a bounded sample, on the same rule as REPLAY-EXCLUDED above: a
        // hub mid-onboarding refuses every pairing a human has not finished confirming, and that is
        // an ordinary state, not an incident — it should be one visible line, not a page of them.
        if (refusedProjects.length > 0) {
          deps.warn?.(
            `cluster hub: REPLAY-REFUSED — this hub's roster pairs "${nodeId}" on ${refusedProjects.length} ` +
              `project(s) it will not replay: ${sampleIds(refusedProjects)}. D21 needs the pairing confirmed BOTH ways ` +
              "and the hub's own projectId still present in its registry; any one of those missing refuses, and the " +
              'refusals are deliberately not told apart (D20). No resumeFrom entry is sent for these, and the node ' +
              'cannot learn it from the welcome — this line is the only record.',
          );
        }

        if (deps.replication && !readTodosFor) {
          // The honest name for the state this hub is in, said out loud on every handshake rather
          // than inferred from an empty `resumeFrom` — which is indistinguishable on the wire from
          // "you are caught up", and is exactly the ambiguity this warning exists to remove.
          deps.warn?.(
            `cluster hub: no connect-time replay wired (HubReplicationDeps.readTodosFor is absent) — "${nodeId}" ` +
              'is welcomed with an empty resumeFrom and receives NOTHING it missed while it was away; only live ' +
              'fan-out reaches it from here on.',
          );
        }

        // `clusterWelcomeFrameSchema` caps `resumeFrom` at 500 entries, and a truncated list the
        // spoke reads as complete is the same silent-loss bug in a new place. Refuse to send a
        // partial one: the empty value already MEANS "this hub cannot replay", which is true of a
        // hub with more scopes than one frame can describe. The replay FRAMES are unaffected — they
        // are separate frames and are still sent.
        const resumeFromOverflowed = resumeFrom.length > 500;
        if (resumeFromOverflowed) {
          deps.warn?.(
            `cluster hub: ${resumeFrom.length} replay scopes for "${nodeId}" exceed clusterWelcomeFrameSchema's ` +
              '500-entry resumeFrom cap — sending an EMPTY resumeFrom rather than a truncated one a spoke would ' +
              'read as complete. The replica frames themselves are unaffected.',
          );
        }

        // `proposals` is deliberately OMITTED here, not sent as `[]`. Computing one needs BOTH
        // sides of a pairing signal — this node's `hello.projects` compared against every OTHER
        // currently linked node's own adverts (`peers.ts#proposePairings`'s `advertsByNode`
        // parameter) — and the hub has no store of another node's adverts to compare against:
        // `peers.json` only ever records a pairing once a human has CONFIRMED it
        // (`byNode[...].confirmedAt`), never the raw proposal inputs that led there. Building that
        // store — either an in-memory accretion across `hello`s that a hub restart would lose, or a
        // persisted one — is a real design decision this router's fixed three-field
        // `HubFrameRouterDeps` (no clock, no cross-call state) was not given room for.
        // `server/cluster-routes.ts`'s `GET /cluster` handler already carries a comment expecting
        // proposals to "arrive with the link" — that is here, but not yet. The field is
        // `.optional()` on `clusterWelcomeFrameSchema`, which is exactly what makes omitting it the
        // honest answer rather than a `[]` that reads as "computed, and there are none".
        const welcome: ClusterDownlinkFrame = {
          type: 'welcome',
          protocol: CLUSTER_PROTOCOL,
          hubNodeId: deps.identity.nodeId,
          roster: peers.nodes.map(toNodeWire),
          pairings: peers.pairings.map(toPairingWire),
          // **FILLED IN 2026-08-23 (B4), and the empty value now means what it always claimed to.**
          // The history, because the distinction is the whole point of this field: `resumeFrom: []`
          // was hardcoded through two increments — first meaning "nothing replicates at all", then
          // "ops replicate LIVE but this hub cannot replay what you missed while away" — and both
          // times the comment insisted the value must NOT be quietly treated as correct, because an
          // empty list is indistinguishable on the wire from "you are caught up". Connect-time
          // replay (Design B, `cluster/replay.ts`) has now landed and is wired above, so this states
          // the position each scope is being resumed FROM, and the `replica` frames that carry the
          // catch-up ride immediately behind this frame in the same reply. It is still `[]` — and
          // still means "this hub cannot replay" — in exactly two cases, both of which say so in a
          // warning rather than leaving the reader to infer it: `readTodosFor` is not wired, or
          // there are more scopes than the schema's 500-entry cap can honestly describe.
          resumeFrom: resumeFromOverflowed ? [] : resumeFrom,
        };

        const frames: ClusterDownlinkFrame[] = [welcome, ...replayFrames];
        // Counted rather than compared against the last element: identity comparison would be wrong
        // the moment two frames in one reply were the same object, and a count cannot be.
        let awaitingVerdicts = frames.length;
        return {
          frames,
          onWritten: (writtenFrame, delivered) => {
            const advance = advanceOnDelivery.get(writtenFrame);
            if (advance) {
              if (delivered) advanceWatermark(nodeId, advance.key, advance.hubSeq);
              else
                deps.warn?.(
                  `cluster hub: replay frame through hubSeq ${advance.hubSeq} for "${nodeId}" (${advance.key}) was ` +
                    'not delivered — its watermark is deliberately left where it was, so the rest is owed again on ' +
                    "this node's next hello rather than being recorded as received",
                );
            }
            // Released only once EVERY frame of this reply has a verdict, delivered or not — the
            // hold's job is to keep live fan-out from overtaking the replay on the wire, and an
            // undelivered frame is still a frame that is no longer racing anything.
            if (--awaitingVerdicts <= 0) replayHold.delete(nodeId);
          },
        };
      }

      case 'presence': {
        const updated = await markNodeSeen(nodeId, frame, homeOptions);
        if (!updated) {
          // `markNodeSeen` never fabricates a roster row (`peers.ts`'s own contract) — a heartbeat
          // from a node this hub has no roster entry for is not the routine case a silent `[]`
          // would suggest; it is either a race with enrollment or a node this hub has never heard
          // of, and either is worth seeing.
          deps.warn?.(`cluster hub: presence from unrostered node "${nodeId}" — not recorded`);
        }
        return { frames: [] };
      }

      case 'freshness': {
        const refusedDetail = frame.refused
          ? ` — refused dispatch ${frame.refused.dispatchId}: ${frame.refused.reason}${
              frame.refused.detail ? ` (${frame.refused.detail})` : ''
            }`
          : '';
        // **CORRECTED 2026-08-23 (C-f) — no longer true unconditionally.** This case used to say
        // "OBSERVED AND LOGGED, NOT PERSISTED: nothing here writes `frame` anywhere, and nothing
        // downstream (dispatch, placement, the cockpit) can read a freshness claim this handler
        // received." That is still exactly true when `deps.dispatchCorrelation` is absent — the
        // pre-Milestone-C posture, and still the production default until a run-start trigger
        // wires one in (see `hub-dispatch.ts`'s own module docblock for what remains undone). When
        // it IS wired, the reply is routed to `HubDispatcher#recordFreshnessReply`, which is where
        // `dispatchId` — minted in `buildDispatch` "precisely to correlate an attempt that never
        // became a run" — finally has somewhere to land.
        const correlated = deps.dispatchCorrelation?.recordFreshnessReply(nodeId, frame) ?? [];
        deps.warn?.(
          `cluster hub: freshness from "${nodeId}" for project "${frame.projectKey}" ` +
            `(headSha ${frame.headSha}, ahead ${frame.ahead}, behind ${frame.behind}, dirty ${frame.dirty}, merging ${frame.merging})` +
            `${refusedDetail}` +
            (correlated.length > 0
              ? ` — routed to ${correlated.length} pending dispatch record(s)`
              : ' — observed only, no hub-side store yet'),
        );
        return { frames: [] };
      }

      case 'ops': {
        // No replication wired => the pre-Milestone-B posture, unchanged and still correct.
        // Returning `[]` — never a fabricated `ack` — means the sending node keeps every op in its
        // outbox until it sees a real one, so nothing here can make a write look durable when it
        // was only received. An outbox that never drains looks worse than acking ops nobody
        // applied; it is the far better failure.
        if (!deps.replication) {
          deps.warn?.(
            `cluster hub: ops from "${nodeId}" (scope ${frame.scope}${
              frame.projectKey ? `, project ${frame.projectKey}` : ''
            }, ${frame.ops.length} op(s)) — no replication wired on this hub, not applied, no ack sent`,
          );
          return { frames: [] };
        }
        const replication = deps.replication;
        const key = watermarkKey(frame.scope, frame.projectKey);

        /**
         * THE SECOND LOAD-BEARING GUARD IN THIS FILE, and it is the `hello` guard's principle
         * applied one layer down: the socket's authenticated identity always wins over the frame
         * body. `nodeId` is what `authenticateLinkUpgrade` verified against this node's own HMAC
         * secret at upgrade time (`link-server.ts`); `op.nodeId` is whatever the OP body claims.
         * Checked here rather than in the schema for the identical reason `hello`'s guard is — no
         * schema constraint can express "equal to a value carried on a different layer".
         *
         * **Without this, the hub's per-project authorization is decorative.**
         * `server/cluster-routes.ts` resolves each op's dataDir through
         * `resolveHubTodosRoot(op.projectKey, op.nodeId, env)` — D20/D21's both-ways-confirmed
         * pairing gate, the same one the HTTP `/cluster/todos/*` family enforces. It authorizes
         * against `op.nodeId`, so a node that forges that field borrows another node's pairings and
         * writes into a project this hub would refuse it over HTTP. `op.nodeId` is also what
         * `hub-apply.ts` stamps an accepted D9a claim's `startedOn` from, so a forgery is a claim
         * attributed to a machine that never made it — and `startedOn` is what the cockpit renders
         * as "started on <node>".
         *
         * Nothing honest produces a mismatch. `cluster/ops.ts#deriveTodoOps` stamps every op with
         * `input.nodeId`, this node's own identity, and `spoke-runtime.ts` re-derives that from disk
         * on every flush tick (`discoverOutboxProjects` → `loadNodeIdentity`). The outbox is
         * RE-DERIVED and never replayed out of a stored log (D5), so there is no path by which a
         * truthful sender carries an op authored under an id it no longer holds. **If op RELAYING is
         * ever introduced** — one node forwarding another's ops — this guard is the first thing that
         * has to change, and so are the verdicts it durably caches (see `applyOp` below).
         */
        const forgesAuthor = (op: ClusterOp): boolean => op.nodeId !== nodeId;

        // ONE warning per FRAME, never one per op. A frame may legally carry
        // `CLUSTER_OPS_PER_FRAME_MAX` (500) ops, so a per-op line would let a single misbehaving
        // node flood the log 500 entries at a time — denial of the record, by a sender that is
        // already misbehaving. This is a security event, so the message names BOTH sides: that IS
        // the content of the event — which credential sent the frame, and whose name it wrote under.
        const forged = frame.ops.filter(forgesAuthor);
        if (forged.length > 0) {
          const claimed = [...new Set(forged.map((op) => op.nodeId))].map((id) => `"${id}"`).join(', ');
          deps.warn?.(
            `cluster hub: REFUSED-FORGED-AUTHOR — ${forged.length} of ${frame.ops.length} op(s) on this ` +
              `${frame.scope} frame${frame.projectKey ? ` (project ${frame.projectKey})` : ''} claim author ` +
              `${claimed}, but the link authenticated as "${nodeId}". Refused, never applied; the rest of ` +
              'the frame is unaffected.',
          );
        }

        // Allocation, application, idempotence and the ack's own shape are entirely
        // `hub-ops.ts#applyOpsFrame`'s job — including the part that matters most here, that a
        // REJECTED op still gets a result (with the winner's `fields`) while a THROWN one gets no
        // ack at all and is left for the outbox to resend. This case deliberately re-derives none
        // of that; it only closes `allocateSeq` over THIS frame's scope, which the allocator needs
        // and the frame knows.
        const ack = await applyOpsFrame(frame, {
          allocateSeq: (count) =>
            replication.allocate({
              scope: frame.scope,
              ...(frame.projectKey !== undefined ? { projectKey: frame.projectKey } : {}),
              count,
            }),
          // The guard fires HERE, at the one seam where a verdict can actually be RETURNED, rather
          // than by filtering the frame's ops up front — and the difference is the whole design.
          // Refusing here lets `applyOpsFrame` do its normal bookkeeping: the op gets its `hubSeq`,
          // its verdict is persisted through `recordAppliedOp`, it lands in `ack.results` WITH its
          // reason, and `throughHubSeq` advances past it. Filtering it out instead would leave it
          // with no `results` entry at all, which `hub-ops.ts` defines as a GAP — the spoke keeps it
          // owed and resends it every flush tick, forever, for a verdict that can never change.
          //
          // A RETURNED rejection (never a throw) is the right kind, by `hub-ops.ts`'s own test:
          // "retrying does not change the state that produced it". The state here is the op's own
          // immutable `nodeId` weighed against this socket's authenticated identity, and neither
          // moves. A retransmit does not even reach this closure — `findAppliedOp` answers it from
          // the cached verdict first (`hub-ops.ts`, "Idempotence"), which is the same reason a
          // future op-relay design would have to invalidate those cached verdicts, not just relax
          // the guard.
          //
          // `reason` is bounded at 200 chars by `clusterAckResultSchema`, and both ids at 64 by
          // `clusterNodeIdSchema`, so this string is at most 178 — checked, not assumed, because an
          // over-long `reason` would fail the SPOKE's parse of the whole downlink frame and take
          // every OTHER op's verdict in this ack down with it.
          applyOp: (op) =>
            forgesAuthor(op)
              ? Promise.resolve({
                  accepted: false,
                  reason: `forged-author: op claims "${op.nodeId}", link authenticated "${nodeId}"`,
                })
              : replication.applyOp(op),
          findAppliedOp: replication.findAppliedOp,
          recordAppliedOp: replication.recordAppliedOp,
          ...(deps.warn ? { warn: deps.warn } : {}),
        });

        // Only ACCEPTED ops fan out. A rejected op was not applied to the hub's store, so
        // replicating it would push a value the hub itself refused — every other node would end up
        // holding a write the hub does not have. The origin still learns of the rejection, with the
        // winner's values, through this same ack's `results[].fields` (D4).
        const verdicts = new Map((ack.results ?? []).map((result) => [result.opId, result]));
        const applied = frame.ops.flatMap((op) => {
          const verdict = verdicts.get(op.opId);
          return verdict && verdict.accepted ? [{ ...op, hubSeq: verdict.hubSeq }] : [];
        });
        if (applied.length === 0) return { frames: [ack] };

        // Every CONNECTED node is a target, the origin included — `replica-fanout.ts` documents at
        // length why excluding the author is wrong (it is the only thing that ever clears
        // `pendingSince` for an ordinary field write). A node that is not connected right now gets
        // nothing and is not queued: it re-reads from its `hello` watermark when it comes back, and
        // a hub-side backlog is exactly the unbounded queue D6 refuses to grow.
        //
        // `connectedNodes()` is read ONCE and reused below for both the prune sweep and the target
        // list, rather than called twice, so the two cannot observe different connection states.
        const connected = replication.connectedNodes();

        // D30 (F3), the HYGIENE half — not the fix for D30's actual race. That race is: a node
        // that looks connected but has not re-seeded its watermark via `hello` yet gets read as a
        // fan-out target anyway, and if its watermark entry is a STALE, too-high one left over from
        // a previous session, the hub silently believes it holds ops it was never sent. THIS sweep
        // does not close that — `link-server.ts`'s `connectedNodes()` closes it structurally, by
        // excluding a socket from this list until it has attempted a `hello` on THIS connection, and
        // `seedWatermark` (below, in the `hello` case) always overwrites before that gate opens. So
        // by the time a reconnecting node can appear in `connected`, its watermark is already fresh.
        // What THIS sweep buys, on its own: `watermarks` is otherwise monotonically growing — a node
        // that disconnects and never reconnects (decommissioned, renamed) leaves a permanent entry
        // for the life of this hub process. Bound it to the currently-connected set, on the same
        // cadence `connected` is already read.
        //
        // Deliberately NOT mutation-tested: `owedFor` (`replica-fanout.ts`) only ever compares a
        // BATCH's freshly-allocated hubSeqs (always higher than anything a past watermark recorded)
        // against a target's watermark, so whether a stale, unread entry sits in this Map or was
        // pruned from it produces byte-identical output for every test that can observe this router
        // from the outside. Asserting on it would mean asserting on nothing.
        for (const trackedNodeId of watermarks.keys()) {
          if (!connected.includes(trackedNodeId)) watermarks.delete(trackedNodeId);
        }

        const { plans, excluded } = planReplicaFanout({
          scope: frame.scope,
          ...(frame.projectKey !== undefined ? { projectKey: frame.projectKey } : {}),
          applied,
          // D30 (F3), the ORDERING half. A node whose connect-time replay is still in flight is not
          // a target for this batch — see `replayHold` for why delivering a higher `hubSeq` ahead of
          // its replay would make the receiver discard the whole replay on arrival. It is not left
          // behind by being skipped: this batch's ops are already durable in the hub's own store,
          // which is the very thing the in-flight replay is scanning.
          targets: connected
            .filter((target) => !replayHold.has(target))
            .map((target) => ({ nodeId: target, appliedThroughHubSeq: readWatermark(target, key) })),
          originNodeId: nodeId,
        });

        // `excluded` is never optional on `planReplicaFanout`'s return (see its own docblock) —
        // this loop is what turns that data into the only loud signal this increment has for it.
        // The op IS durably applied at the hub (D4); what this reports is that ONE target will never
        // receive it via replication, because it alone (with its frame envelope) is over
        // `CLUSTER_FRAME_MAX_BYTES` — see `replica-fanout.ts`'s own docblock, "Frame cap" → "The
        // single-oversized-op case", for the full argument against silently dropping or throwing for
        // it instead. No durable, queryable "replication gap" registry exists anywhere in this
        // codebase yet — B4's connect-time replay, its natural home, is itself unbuilt — so `warn` is
        // the loudest signal available without this increment inventing storage it does not own.
        // Flagged, not fixed, the same way `resumeFrom: []`'s own gap is flagged above rather than
        // declared solved.
        for (const exclusion of excluded) {
          const forOrigin = exclusion.nodeId === nodeId;
          deps.warn?.(
            `cluster hub: REPLICATION-EXCLUDED — op "${exclusion.opId}" (entity ${exclusion.entity} ` +
              `${exclusion.entityId}, hubSeq ${exclusion.hubSeq}, ${exclusion.bytes} bytes) cannot be ` +
              `replicated to "${exclusion.nodeId}" — alone, with its frame envelope, it is over the ` +
              `CLUSTER_FRAME_MAX_BYTES bound, so no split can represent it. Durably applied at the hub; this ` +
              `target will never receive it via replication.` +
              (forOrigin
                ? ' This IS the origin of the op: its own pendingSince for this record cannot clear via ' +
                  "replica apply either, so deriveTodoOps will keep re-deriving and resending a fresh " +
                  'attempt (a new opId every time) for the same still-pending record on every flush tick, ' +
                  'each one durably re-applied at the hub — this does not self-heal until the content shrinks.'
                : ''),
          );
        }

        // The origin's own frames are RETURNED rather than sent, so they ride the router's natural
        // return channel behind the ack — which is what puts the ack first for the node that is
        // waiting on it. Everyone else is pushed. A push that fails is warned about and its
        // watermark deliberately NOT advanced, so the frame is owed again on the next batch; that is
        // the safe direction, since over-sending costs one idempotent re-apply and under-sending
        // loses the write silently.
        const downlink: ClusterDownlinkFrame[] = [ack];
        /** frame → the `hubSeq` it earns the ORIGIN, applied only once the write is CONFIRMED. */
        const advanceOnDelivery = new Map<ClusterDownlinkFrame, number>();
        for (const plan of plans) {
          for (const replicaFrame of plan.frames) {
            if (plan.nodeId === nodeId) {
              // D28 (F4) — THE FIX. This frame rides the RETURN channel, not `sendTo`, deliberately
              // (see above: it is what puts the ack first on the wire for the node waiting on it).
              // The write therefore happens in `link-server.ts`'s `onMessage`, strictly AFTER this
              // function has returned, so there is no delivery answer available on this line. The
              // bug: this branch used to call `advanceWatermark` right here, UNCONDITIONALLY, while
              // `link-server.ts` discarded whether that later write ever succeeded — recording as
              // delivered a frame that a closed socket, an oversized encoding or (routinely) the
              // per-node send budget may have dropped. Three lines below, the `sendTo` branch has
              // always checked. Same file, same batch, opposite postures, on the ONE direction the
              // design says must never lose a write.
              //
              // **SUPERSEDED 2026-08-23 (same day) — the first fix here was "never advance the
              // origin's watermark at all", and it is not enough.** That was safe (it can only
              // over-send) and it is genuinely almost free for LIVE fan-out, because `owedFor`
              // compares a batch's freshly-allocated `hubSeq`s, which are above any watermark a past
              // batch could have recorded — so a permanently-zero origin watermark and a correct one
              // select the same ops. What it is NOT free for is everything that reads the watermark
              // as a POSITION rather than as a filter: a retransmit of the same `opId` (answered
              // from `op-history`'s cache with the same `hubSeq`) re-sends the origin a duplicate,
              // and B4's connect-time replay would resume the origin from 0 and re-ship the whole
              // scope. "Never claim it" answered the wrong question; the right one is "claim it when
              // it is true", which is now answerable — `ClusterFrameReplies#onWritten` reports
              // `writeFrame`'s own boolean back here for every returned frame.
              downlink.push(replicaFrame);
              advanceOnDelivery.set(replicaFrame, replicaFrame.hubSeq);
              continue;
            }
            if (replication.sendTo(plan.nodeId, replicaFrame)) {
              advanceWatermark(plan.nodeId, key, replicaFrame.hubSeq);
            } else {
              deps.warn?.(
                `cluster hub: could not push replica through hubSeq ${replicaFrame.hubSeq} to "${plan.nodeId}" — ` +
                  'left owed, it will be re-sent on the next batch or replayed from its next `hello`',
              );
            }
          }
        }
        return {
          frames: downlink,
          onWritten: (writtenFrame, delivered) => {
            const hubSeq = advanceOnDelivery.get(writtenFrame);
            if (hubSeq === undefined) return; // the ack, and any frame this map does not own
            if (delivered) advanceWatermark(nodeId, key, hubSeq);
            else
              deps.warn?.(
                `cluster hub: the origin "${nodeId}" was not delivered its own replica through hubSeq ${hubSeq} — ` +
                  'watermark left where it was, so the frame is owed again on the next batch rather than being ' +
                  'recorded as received (D28)',
              );
          },
        };
      }

      case 'relay': {
        // Same posture as `ops`: not implemented in this increment, dropped with a named reason
        // rather than silently. There is no hub-side run relay/fan-out to feed.
        deps.warn?.(
          `cluster hub: relay from "${nodeId}" for run "${frame.runId}" (${frame.events.length} event(s)) — ` +
            'hub-side relay fan-out not implemented yet, dropped',
        );
        return { frames: [] };
      }

      default: {
        const _exhaustive: never = frame;
        return _exhaustive;
      }
    }
  };
}
