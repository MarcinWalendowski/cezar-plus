import type {
  ClusterCapacity,
  ClusterNodeId,
  ClusterProjectKey,
  StoredClusterNode,
  StoredClusterNodeIdentity,
} from '@loki-labs/cezar-plus-contract';
import type { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { detectCapacityEnforcement, type ClusterHomeOptions } from './node-identity.ts';
import { readPeers } from './peers.ts';
import type { PlacementCandidate } from './placement.ts';

/**
 * The roster → `PlacementCandidate[]` builder (spec
 * `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, D11 · D12 · D14 · D14a, and B11's census).
 * `placement.ts` is pure and fully tested; `hub-dispatch.ts` takes candidates as an input and
 * refuses to resolve them itself. **This is the function that was missing between them** — before
 * it, `PlacementCandidate` was constructed by nothing in production (B11: "every non-test
 * occurrence is a type annotation"), and the only object of that shape in the tree was an E2E's
 * hand-written literal.
 *
 * **Nothing calls this yet, and that is deliberate.** It is Phase 3 of a five-phase plan, landed
 * ahead of the dispatch trigger so it can be reviewed and mutation-tested on its own. Wiring it is
 * a behavioural change to a production hub and is a later phase's decision — see B12 on why the
 * gate belongs on the TRIGGER rather than on any of the pieces it composes.
 *
 * **`online` comes from the LINK, never from `lastSeenAt`, and that is the whole hazard this module
 * exists to keep straight.** A wedged node — one whose `collectPresence` is stuck behind a
 * never-settling git call — keeps a socket open and keeps looking recently-seen while being
 * incapable of doing any work at all. `lastSeenAt` and `capacityAt` are the same instant written
 * twice (`peers.ts#markNodeSeen` writes one `now` into both), so neither can ever contradict the
 * other and neither is evidence of liveness. `linkServer.connectedNodes()` is: it reflects a socket
 * this process is holding right now.
 *
 * **An unreadable freshness stamp is UNKNOWN, and unknown is STALE, never fresh.** `capacityAt` is
 * `z.string().optional()` and NOT `.datetime()`, so `"yesterday"` is a legal roster value,
 * `Date.parse("yesterday")` is `NaN`, and `NaN > bound` is `false` — arithmetic that never guards
 * the parse reads garbage as *fresh* and hands a frozen claim a ranking advantage. The posture
 * copied here rather than re-derived is `dispatch.ts#isCorpusStale`'s: *"An unparsable fetch stamp
 * cannot be proven fresh."*
 *
 * **The hub is always a candidate, built from live state rather than from the roster.** The hub has
 * no row in its own `peers.json` — only redeemed spokes get one (`enrollment.ts`), and
 * `GET /cluster` reflects that split by rendering `self` separately from `nodes`. So its capacity
 * cannot be read; it is MEASURED, off this process's own `WorkspaceSemaphore`, with
 * `capacityAgeMs: 0`. Omit the hub and `dispatch()` can never return a LOCAL placement, and every
 * todo leaves the box.
 *
 * **What this module deliberately does NOT do.** It does not rank, filter or place — that is
 * `placeRun`'s job, and it applies `acceptsDispatch`/`online`/`origin`/`requires` itself. It does
 * not fold in this hub's own pending dispatches either; `hub-dispatch.ts#dispatch` already adjusts
 * `capacity.active` for those between beats, and doing it twice would double-count.
 */

/**
 * The both-ways-confirmed pairing gate, INJECTED rather than re-derived — the same shape and the
 * same reason as `hub-router.ts`'s `readTodosFor` dep, which `cluster-routes.ts#buildHubReplication`
 * fills with `resolveHubTodosRoot(projectKey, nodeId, env) !== undefined`. That function's own
 * comment states the rule this follows: *"Not a second implementation of that gate that happens to
 * agree today — one rule, one call site, so a change to who may be replayed a project cannot drift
 * from who may write it."* Who may have a run PLACED on them is the third member of that set.
 *
 * `resolveHubTodosRoot` is private to `server/cluster-routes.ts` and cannot be imported here, so
 * injection is also the only way to reach it without standing up a second copy of D20/D21.
 *
 * **Required, never optional.** A defaulted-to-`true` gate would place remote-less projects
 * (D12) on nodes that do not hold them; a defaulted-to-`false` one would queue every such project
 * forever, silently, with `placeRun` reporting `project-has-no-origin` as though a human had
 * failed to confirm a pairing. Same reasoning `spoke-runtime.ts` gives for
 * `resolveDispatchManager` being required: an optional field here would let a caller forget it and
 * get a hub that looks healthy and cannot place.
 */
export type HoldsProjectResolver = (
  projectKey: ClusterProjectKey,
  nodeId: ClusterNodeId,
) => Promise<boolean>;

export interface BuildPlacementCandidatesInput {
  /** The project the run belongs to — passed to `holdsProject` verbatim, per candidate. */
  projectKey: ClusterProjectKey;
  /** This hub's own identity (`node.json`), the source of the hub candidate's `nodeId`, `labels`
   *  and `acceptsDispatch`. D11's default is OFF: a hub that has never run `setAcceptsDispatch`
   *  is a candidate here and is then filtered out by `eligibleCandidates`, which is correct and is
   *  also the most likely reason a freshly clustered box places nothing locally. Never overridden
   *  to `true` here — a node runs only work it has opted into, and the hub is a node. */
  hubIdentity: StoredClusterNodeIdentity;
  /** `linkServer.connectedNodes()` — sockets this hub is holding RIGHT NOW. The ONLY source of
   *  `online`. The hub's own id is not expected here (a hub holds no socket to itself) and is
   *  ignored if present. */
  connectedNodeIds: readonly ClusterNodeId[];
  /** ONE instant for the whole build, so two candidates' ages are comparable. Deliberately a
   *  `Date` on the input rather than `options.now`: this function never calls `options.now`, and a
   *  per-candidate clock read would let the last node in the roster be measured against a later
   *  moment than the first. */
  now: Date;
  /** This process's live workspace semaphore — the hub candidate's capacity is measured off it
   *  (`busy()`/`heavyActive()` and the two caps it enforces), never claimed. Deliberately the
   *  workspace-wide semaphore and not a `RunManager`, the same distinction
   *  `spoke-runtime.ts#semaphore` draws: this is THIS NODE's overall load for placement fairness
   *  (D14), not any one project's admission answer. */
  semaphore: WorkspaceSemaphore;
  /** See `HoldsProjectResolver`. */
  holdsProject: HoldsProjectResolver;
}

/**
 * Every placement target this hub can see for `projectKey`, in no meaningful order — the hub
 * first, then roster rows in file order. `placeRun` sorts, so order carries no information and
 * nothing may come to depend on it.
 *
 * Four kinds of roster row are NOT candidates, and each is a deliberate answer rather than an
 * oversight:
 *
 *  - **the hub's own id**, if a hand-edited `peers.json` carries one. The live row wins; two rows
 *    for one node would let `placeRun` rank a stale claim against a measurement, and could send
 *    this hub a dispatch frame addressed to itself.
 *  - **a revoked node** (`disabledAt`). `disableNode` deletes the node's secret but does not close
 *    an already-open socket, so a revoked node can still appear in `connectedNodeIds` for as long
 *    as that socket lives. Dropping it here is what stops a dispatch being placed on a credential
 *    that has been revoked.
 *  - **a node that has never claimed a capacity** (`capacity` absent — the row exists because the
 *    node enrolled, but no `presence` beat has ever reached `markNodeSeen`). `PlacementCandidate`
 *    requires a capacity and there is none to report; synthesising `{maxParallel: 0}` would be a
 *    fabricated claim that reads downstream as *"every eligible node is at capacity"* — which
 *    sends an operator to buy hardware for a machine that has never linked. Absent, the node is
 *    reported as offline/unavailable instead, which is what it is. Costs a ~30s window on a node
 *    that has just connected and not yet beaten; that window closes itself.
 *  - **a duplicate nodeId**. First row wins. `upsertNode` full-replaces so this cannot arise from
 *    cezar's own writes, but `peers.json` is `.passthrough()` and hand-editable.
 */
export async function buildPlacementCandidates(
  input: BuildPlacementCandidatesInput,
  options?: ClusterHomeOptions,
): Promise<PlacementCandidate[]> {
  const [peers, hubEnforcement] = await Promise.all([
    readPeers(options),
    detectCapacityEnforcement(options),
  ]);

  const connected = new Set(input.connectedNodeIds);
  const candidates: PlacementCandidate[] = [];

  // The hub, first and unconditionally. `online: true` is not a lookup — this process is running,
  // which is the whole of the question. Deriving it from `connectedNodeIds` instead would make the
  // hub permanently offline (a hub holds no socket to itself), i.e. never placeable, i.e. every
  // todo leaves the box.
  candidates.push({
    nodeId: input.hubIdentity.nodeId,
    labels: input.hubIdentity.labels,
    acceptsDispatch: input.hubIdentity.acceptsDispatch,
    online: true,
    capacity: hubCapacity(input.semaphore, hubEnforcement),
    holdsProject: await input.holdsProject(input.projectKey, input.hubIdentity.nodeId),
    // Measured this instant off the live semaphore, not read off a beat — so it is exactly as
    // fresh as the read, and it is the one candidate whose age is a fact rather than a claim.
    capacityAgeMs: 0,
    // No `corpusStalenessMs`: the hub holds the corpus, it does not mirror one (D8a's mirror is a
    // spoke-side thing), and `undefined` on this field means "holds no mirror" — the accurate
    // answer here, not a missing measurement.
  });

  const seen = new Set<ClusterNodeId>([input.hubIdentity.nodeId]);
  for (const node of peers.nodes) {
    if (seen.has(node.nodeId)) continue;
    if (node.disabledAt !== undefined) continue;
    if (node.capacity === undefined) continue;
    seen.add(node.nodeId);
    candidates.push({
      nodeId: node.nodeId,
      labels: node.labels,
      // D11 as the HUB recorded it. The spoke re-enforces its own copy regardless of what is
      // written here, so this is the hub's best knowledge and never the last word.
      acceptsDispatch: node.acceptsDispatch,
      online: connected.has(node.nodeId),
      capacity: node.capacity,
      holdsProject: await input.holdsProject(input.projectKey, node.nodeId),
      ...ageFields(node, input.now),
    });
  }

  return candidates;
}

/** The hub's own two D14 numbers and the two caps they are measured against, straight off the
 *  object that actually enforces them. `maxHeavySteps()` answers `Infinity` for "no gate" — the
 *  one place in the codebase that turns absent into unbounded — and `ClusterCapacity.maxHeavySteps`
 *  spells that same state as the field being ABSENT (`z.number().int()`, so `Infinity` is not even
 *  a legal value there). The mapping below is what keeps the round trip exact: absent is read back
 *  as `Number.POSITIVE_INFINITY` by `placement.ts#headroom`, which is where it started. */
function hubCapacity(
  semaphore: WorkspaceSemaphore,
  enforcement: ClusterCapacity['enforcement'],
): ClusterCapacity {
  const maxHeavySteps = semaphore.maxHeavySteps();
  return {
    maxParallel: semaphore.maxParallel(),
    active: semaphore.busy(),
    ...(Number.isFinite(maxHeavySteps) ? { maxHeavySteps } : {}),
    heavyActive: semaphore.heavyActive(),
    enforcement,
  };
}

/**
 * The two age fields, together, because they are the same parse with **opposite meanings for
 * `undefined`** and that is exactly the kind of thing that drifts when it is written in two places:
 *
 *  - `capacityAgeMs` — `undefined` means UNKNOWN, which means STALE (spec item 25). There is no
 *    competing meaning: a node with no capacity claim at all is not a candidate.
 *  - `corpusStalenessMs` — `undefined` means "holds no mirror", which is explicitly NOT stale
 *    (`dispatch.ts#isCorpusStale`: refusing both would refuse every node that never opted in). So
 *    an unreadable `fetchedAt` cannot degrade to `undefined` here without flipping its meaning from
 *    *unprovable* to *fine*. It degrades to `Number.POSITIVE_INFINITY` instead — the one value that
 *    makes every `> bound` comparison true, matching `isCorpusStale` returning `true` for the same
 *    input. (`PlacementCandidate` is a hub-local TS interface with no schema and no wire
 *    representation, so `Infinity` is safe here; it would not survive `JSON.stringify`, and putting
 *    this field on a wire frame would need a different sentinel.)
 */
function ageFields(
  node: StoredClusterNode,
  now: Date,
): Pick<PlacementCandidate, 'capacityAgeMs' | 'corpusStalenessMs'> {
  const capacityAgeMs = stampAgeMs(node.capacityAt, now);
  const corpusStalenessMs =
    node.corpus === undefined ? undefined : (stampAgeMs(node.corpus.fetchedAt, now) ?? Number.POSITIVE_INFINITY);
  return {
    ...(capacityAgeMs !== undefined ? { capacityAgeMs } : {}),
    ...(corpusStalenessMs !== undefined ? { corpusStalenessMs } : {}),
  };
}

/**
 * `now − stamp`, or `undefined` for any stamp whose age cannot be established: absent, unparsable
 * (`capacityAt`/`fetchedAt` are `z.string()`, not `.datetime()` — `"yesterday"` is a legal roster
 * value), or in the FUTURE.
 *
 * The future case is not clock skew and is not tolerated as such: `capacityAt` is stamped by THIS
 * hub's own clock inside `markNodeSeen`, never by the node it describes, so a stamp ahead of `now`
 * means the hub's clock moved or the roster was hand-edited. Neither can be proven fresh, and a
 * negative age would read as *fresher than now* to every `age > bound` test downstream — the same
 * fail-open the `NaN` guard exists to close, arriving by a different route.
 *
 * Exported for its own test: this is the one function on the module's hot path where a guard can
 * be deleted and every field still populate with a plausible-looking number.
 */
export function stampAgeMs(stamp: string | undefined, now: Date): number | undefined {
  if (stamp === undefined) return undefined;
  const at = Date.parse(stamp);
  if (!Number.isFinite(at)) return undefined;
  const age = now.getTime() - at;
  if (age < 0) return undefined;
  return age;
}
