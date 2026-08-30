import type {
  ClusterNode,
  ClusterPairing,
  StoredClusterNode,
  StoredClusterPairing,
} from '@loki-labs/cezar-plus-contract';

/**
 * Stored cluster rows → their wire shapes. **One definition, imported by both callers** —
 * `cluster/hub-router.ts` (the link's `nodes`/`pairings` replies) and
 * `server/cluster-routes.ts` (the cockpit's HTTP mirror of the same data).
 *
 * **Why this file exists (B5, 2026-08-23).** These two functions were duplicated, byte-for-byte, in
 * exactly those two places. There was no drift to repair — the copies agreed — and that is precisely
 * what made it worth closing: **drift here was unpinnable, not merely unfixed.** Neither copy was
 * exported, so no test could compare them; `clusterNodeSchema`/`clusterPairingSchema` are `.strict()`,
 * so each copy rebuilds field-by-field; and therefore adding a field to `StoredClusterNode` +
 * `ClusterNode` and updating only one copy **typechecks cleanly while one of the two routes silently
 * serves a node without that field**. A missing optional field on a wire object is not a type error
 * anywhere, so nothing would have gone red.
 *
 * The duplication's original justification was a PROCESS artifact, not a layering constraint:
 * `hub-router.ts` carried *"this file may only touch `cluster/hub-router.ts` and
 * `cluster/hub-router.test.ts` (package boundary for this increment)"* — a past increment's
 * file-ownership rule, now ended. `server/cluster-routes.ts` already imports `allocate`,
 * `applyOpAtHub`, `createHubFrameRouter`, `acquireLease`, `ClusterLinkClient` and more from
 * `cluster/`, so a shared mapper here adds **no new dependency direction whatsoever**.
 *
 * An import rather than a parity test, deliberately, and for the same reason `cluster/replay.ts`'s
 * fourth copy of the meta-field set became an import: a parity test DETECTS drift, an import makes it
 * IMPOSSIBLE. Adding a field is now one edit, in one place, or it does not compile.
 *
 * **The specific regression this file exists to prevent is a LOCAL RE-IMPLEMENTATION.** Not a wrong
 * mapping — a second correct one. If you are about to write a `toNodeWire` next to its caller because
 * importing from `cluster/` feels like reaching across a boundary, that is exactly how the previous
 * two copies were born, and the reason given at the time (a package boundary) was real when it was
 * written and stale within the increment. Import it or change it here; do not restate it.
 *
 * **And deduplicating only made drift OBSERVABLE — `hub-router.test.ts` is where it is OBSERVED.**
 * That test seeds every optional and asserts the whole wire object with `toEqual`, verified by a
 * sweep deleting each of the 14 field lines in turn (14 red, 0 green). It has to seed every optional:
 * six of these fields are `...(x !== undefined ? { x } : {})`, and a fixture that leaves one absent
 * cannot pin its line — the field is missing from the output either way. If you add a field here,
 * add it to that fixture too, or it ships unpinned while the suite stays green.
 */

/** Corpus-relative, always. `.strict()` on the wire means a stored row's `.passthrough()` extras
 *  must be dropped by an explicit mapping rather than spread through — the omission is the
 *  mechanism that keeps an unexpected on-disk key off the wire. */
export function toNodeWire(node: StoredClusterNode): ClusterNode {
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
export function toPairingWire(pairing: StoredClusterPairing): ClusterPairing {
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
