import {
  CLUSTER_PROTOCOL,
  type ClusterDownlinkFrame,
  type ClusterNode,
  type ClusterNodeId,
  type ClusterPairing,
  type ClusterUplinkFrame,
  type StoredClusterNode,
  type StoredClusterNodeIdentity,
  type StoredClusterPairing,
} from '@loki-labs/better-cezar-contract';
import type { ClusterHomeOptions } from './node-identity.ts';
import { markNodeSeen, readPeers } from './peers.ts';

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

export interface HubFrameRouterDeps {
  /** The hub's own identity — `hubNodeId` on every `welcome`. */
  identity: StoredClusterNodeIdentity;
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
            // Nothing replicates yet (see the module docblock) — there is no hub oplog to resume
            // from, so every watermark the spoke sent is answered with "nothing to resume", not
            // "you are fully caught up". The two read identically on the wire; they stop being the
            // same claim the moment ops replication lands, which is why this line will need to
            // change then and not before.
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
        // Replication is NOT implemented in this increment. Returning `[]` — never a fabricated
        // `ack` — is the correct conservative behaviour: the sending node keeps every op in its
        // outbox until it sees a real `ack`, so nothing here can cause a write to be believed
        // durable when it was only received. An outbox that never drains looks worse than acking
        // ops nobody applied, but the alternative is silent data loss dressed as success.
        deps.warn?.(
          `cluster hub: ops from "${nodeId}" (scope ${frame.scope}${
            frame.projectKey ? `, project ${frame.projectKey}` : ''
          }, ${frame.ops.length} op(s)) — replication not implemented yet, not applied, no ack sent`,
        );
        return [];
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
