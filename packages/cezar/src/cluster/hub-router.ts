import {
  CLUSTER_PROTOCOL,
  type ClusterDownlinkFrame,
  type ClusterNode,
  type ClusterNodeId,
  type ClusterPairing,
  type ClusterAckResult,
  type ClusterOp,
  type ClusterOpScope,
  type ClusterProjectKey,
  type ClusterUplinkFrame,
  type StoredClusterNode,
  type StoredClusterNodeIdentity,
  type StoredClusterPairing,
} from '@loki-labs/better-cezar-contract';
import type { ClusterHomeOptions } from './node-identity.ts';
import { markNodeSeen, readPeers } from './peers.ts';
import { applyOpsFrame, type HubOpAllocation, type HubOpOutcome } from './hub-ops.ts';
import { planReplicaFanout } from './replica-fanout.ts';

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
}

export interface HubFrameRouterDeps {
  /** The hub's own identity — `hubNodeId` on every `welcome`. */
  identity: StoredClusterNodeIdentity;
  /** Omit to keep the pre-replication behaviour: observe, warn, never ack. See `HubReplicationDeps`. */
  replication?: HubReplicationDeps;
  env?: NodeJS.ProcessEnv;
  warn?: (message: string) => void;
}

/**
 * `.strict()` on the wire means a stored row's `.passthrough()` extras must be dropped by an
 * explicit mapping rather than spread through — the same reasoning, and the same field list, as
 * `server/cluster-routes.ts`'s own `toNodeWire`. Not imported from there: this file may only touch
 * `cluster/hub-router.ts` and `cluster/hub-router.test.ts` (package boundary for this increment),
 * and the mapping is straight field-copying, not an abstraction worth a cross-file dependency for.
 */
function toNodeWire(node: StoredClusterNode): ClusterNode {
  return {
    nodeId: node.nodeId,
    nodeName: node.nodeName,
    role: node.role,
    labels: node.labels,
    acceptsDispatch: node.acceptsDispatch,
    protocol: node.protocol,
    version: node.version,
    ...(node.lastSeenAt !== undefined ? { lastSeenAt: node.lastSeenAt } : {}),
    ...(node.capacity !== undefined ? { capacity: node.capacity } : {}),
    ...(node.capacityAt !== undefined ? { capacityAt: node.capacityAt } : {}),
    ...(node.hostMetrics !== undefined ? { hostMetrics: node.hostMetrics } : {}),
    ...(node.repoDrift !== undefined ? { repoDrift: node.repoDrift } : {}),
    ...(node.corpus !== undefined ? { corpus: node.corpus } : {}),
    ...(node.disabledAt !== undefined ? { disabledAt: node.disabledAt } : {}),
  };
}

/** Same reasoning as `toNodeWire` — `clusterPairingSchema` is `.strict()`, so each member is
 *  rebuilt field-by-field rather than spread from the stored (`.passthrough()`) shape. */
function toPairingWire(pairing: StoredClusterPairing): ClusterPairing {
  const byNode: ClusterPairing['byNode'] = {};
  for (const [nodeId, member] of Object.entries(pairing.byNode)) {
    byNode[nodeId] = {
      nodeId: member.nodeId,
      projectId: member.projectId,
      ...(member.confirmedAt !== undefined ? { confirmedAt: member.confirmedAt } : {}),
    };
  }
  return { projectKey: pairing.projectKey, byNode };
}

export function createHubFrameRouter(
  deps: HubFrameRouterDeps,
): (nodeId: ClusterNodeId, frame: ClusterUplinkFrame) => Promise<ClusterDownlinkFrame[]> {
  const homeOptions: ClusterHomeOptions = { env: deps.env, warn: deps.warn };

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
   *  carrying a lower number must not walk the watermark backwards and re-send history. */
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
          return [
            {
              type: 'refuse',
              protocol: CLUSTER_PROTOCOL,
              reason: 'unknown-node',
              message: `hello claimed nodeId "${frame.nodeId}", the link authenticated as "${nodeId}"`,
            },
          ];
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
        for (const mark of frame.watermarks) {
          seedWatermark(nodeId, watermarkKey(mark.scope, mark.projectKey), mark.appliedThroughHubSeq);
        }

        const peers = await readPeers(homeOptions);

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
        return [
          {
            type: 'welcome',
            protocol: CLUSTER_PROTOCOL,
            hubNodeId: deps.identity.nodeId,
            roster: peers.nodes.map(toNodeWire),
            pairings: peers.pairings.map(toPairingWire),
            // **The VALUE is still `[]`; the REASON has changed** (2026-08-23, when the `ops` case
            // below started replicating). It is no longer "nothing replicates, so there is nothing
            // to resume". Ops now replicate LIVE: a node connected when a batch lands is pushed its
            // `replica` frames straight away. What does not exist yet is CONNECT-TIME REPLAY —
            // reading `oplog.ts#readOps` from each `hello` watermark and shipping what a node
            // missed while it was away. So a spoke that was offline for a batch gets nothing here
            // and stays behind until the next write to that project touches the same records.
            //
            // That is a real gap, tracked as Milestone B's remaining item, and it is the reason
            // this line must not be quietly "correct" — an empty `resumeFrom` is currently the
            // honest "this hub cannot replay", not "you are caught up", and the two are
            // indistinguishable on the wire. Fill it in when replay lands, not before.
            resumeFrom: [],
          },
        ];
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
        return [];
      }

      case 'freshness': {
        const refusedDetail = frame.refused
          ? ` — refused dispatch ${frame.refused.dispatchId}: ${frame.refused.reason}${
              frame.refused.detail ? ` (${frame.refused.detail})` : ''
            }`
          : '';
        // OBSERVED AND LOGGED, NOT PERSISTED. There is no hub-side freshness store in this
        // increment: nothing here writes `frame` anywhere, and nothing downstream (dispatch,
        // placement, the cockpit) can read a freshness claim this handler received. Do not read
        // "the router handles freshness" as "the hub remembers it".
        deps.warn?.(
          `cluster hub: freshness from "${nodeId}" for project "${frame.projectKey}" ` +
            `(headSha ${frame.headSha}, ahead ${frame.ahead}, behind ${frame.behind}, dirty ${frame.dirty}, merging ${frame.merging})` +
            `${refusedDetail} — observed only, no hub-side store yet`,
        );
        return [];
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
          return [];
        }
        const replication = deps.replication;
        const key = watermarkKey(frame.scope, frame.projectKey);

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
          applyOp: replication.applyOp,
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
        if (applied.length === 0) return [ack];

        // Every CONNECTED node is a target, the origin included — `replica-fanout.ts` documents at
        // length why excluding the author is wrong (it is the only thing that ever clears
        // `pendingSince` for an ordinary field write). A node that is not connected right now gets
        // nothing and is not queued: it re-reads from its `hello` watermark when it comes back, and
        // a hub-side backlog is exactly the unbounded queue D6 refuses to grow.
        const plans = planReplicaFanout({
          scope: frame.scope,
          ...(frame.projectKey !== undefined ? { projectKey: frame.projectKey } : {}),
          applied,
          targets: replication
            .connectedNodes()
            .map((target) => ({ nodeId: target, appliedThroughHubSeq: readWatermark(target, key) })),
          originNodeId: nodeId,
        });

        // The origin's own frames are RETURNED rather than sent, so they ride the router's natural
        // return channel behind the ack — which is what puts the ack first for the node that is
        // waiting on it. Everyone else is pushed. A push that fails is warned about and its
        // watermark deliberately NOT advanced, so the frame is owed again on the next batch; that is
        // the safe direction, since over-sending costs one idempotent re-apply and under-sending
        // loses the write silently.
        const downlink: ClusterDownlinkFrame[] = [ack];
        for (const plan of plans) {
          for (const replicaFrame of plan.frames) {
            if (plan.nodeId === nodeId) {
              downlink.push(replicaFrame);
              advanceWatermark(plan.nodeId, key, replicaFrame.hubSeq);
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
        return downlink;
      }

      case 'relay': {
        // Same posture as `ops`: not implemented in this increment, dropped with a named reason
        // rather than silently. There is no hub-side run relay/fan-out to feed.
        deps.warn?.(
          `cluster hub: relay from "${nodeId}" for run "${frame.runId}" (${frame.events.length} event(s)) — ` +
            'hub-side relay fan-out not implemented yet, dropped',
        );
        return [];
      }

      default: {
        const _exhaustive: never = frame;
        return _exhaustive;
      }
    }
  };
}
