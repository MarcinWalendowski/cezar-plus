import type {
  ClusterActiveRun,
  ClusterCapacity,
  ClusterNodeId,
  ClusterNodeLabel,
  ClusterPlacementResult,
  ClusterProjectKey,
  ClusterQueuedReason,
  ClusterTodoPlacement,
} from '@loki-labs/better-cezar-contract';

/**
 * Where a run goes — label matching, headroom, and **queue-with-reason** (spec
 * `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, D12 · D19 rung 3). Pure: no I/O, no clock, no
 * ambient state, so every rule below is testable without a second machine.
 *
 * **Least-loaded is the default, and the authoring node gets no preference.** The first draft
 * defaulted to the node that filed the todo, to guarantee "nothing changes on day one" — which is
 * the wrong goal, because spreading the work IS the change being asked for, and that default leaves
 * the 16-core / 128 GB machine idle while the 8 vCPU one queues. Resolution order: an explicit
 * `node` pins; else `requires` narrows the eligible set; else the eligible node with the most
 * headroom (`maxParallel − active`, then `maxHeavySteps − heavyActive`, then a stable tiebreak on
 * `nodeId` so placement is deterministic in tests).
 *
 * **Four queued reasons, four distinct strings, and collapsing them is the bug.** *No node carries
 * this label* / *every eligible node is at capacity* / *the node it needs is offline* / *this
 * project has no `origin` and may only run where it lives*. They look identical from the board and
 * are not: rendering them as one "queued" is what sends a person to buy a node when the real fix was
 * opening a laptop lid. It **never silently runs somewhere else.**
 *
 * **One eligibility rule is not about labels or headroom at all** (D12): a project with no `origin`
 * may only run on the node that holds it. Four of the box's twelve registered projects have none. A
 * run's durable output is a pushed branch; where there is nothing to push to, the output lives only
 * on that node's disk — precisely the thing a disposable worker is allowed to destroy. The
 * cattle/pet split is a property of the DATA, not of the hardware, and this is where the two
 * disagree.
 *
 * **The negative controls are the test** (PLAN P10): the same fixture *with* an `origin` must get
 * placed on the peer, or the remote-less assertion passes because placement did nothing at all; and
 * non-overlapping paths in one project must still dispatch, or the overlap rule is just "one run per
 * project", which is not what was asked for.
 */

export interface PlacementCandidate {
  nodeId: ClusterNodeId;
  labels: readonly ClusterNodeLabel[];
  /** D11: the SPOKE enforces this too, regardless of what the hub sends. Honouring it here is what
   *  turns a refusal into a visible queued reason instead of a rejected dispatch. */
  acceptsDispatch: boolean;
  /** Linked right now. An asleep Mac is a state, not an error — and not a placement target. */
  online: boolean;
  capacity: ClusterCapacity;
  /**
   * How old the `capacity` claim above is, in ms — `undefined` means UNKNOWN, and unknown means
   * **STALE**, never fresh (spec item 25). It is data rather than a clock read because this module
   * commits to being pure; the age is measured by whoever builds the candidate
   * (`hub-candidates.ts`), against one instant for the whole set.
   *
   * **Nothing reads it yet.** The rule it exists for is a DE-RANK — a leading sort key in
   * `rankByHeadroom` at a 90_000 ms threshold (`3 × DEFAULT_HEARTBEAT_MS`, which is also
   * `DEFAULT_DISPATCH_TIMEOUT_MS`, so a node can never be both fresh enough to place on and
   * already timed out for its last dispatch) — deliberately not an EXCLUDE: an emptied pool routes
   * to `all-eligible-at-capacity`, which would be a manufactured lie about a node whose claim is
   * merely old, and one hub clock jump would make every node stale in the same window. That change
   * is its own decision and has not landed; this field is the input it will read.
   */
  capacityAgeMs?: number;
  /** Whether this node actually holds the project. Pairing is confirmed per node, so this is not
   *  derivable from the roster alone. */
  holdsProject: boolean;
  /** How far behind its bound this node's corpus mirror is, in ms; `undefined` when it holds no
   *  mirror. Stale knowledge has no natural error (D8a), so it is an input here rather than a
   *  discovery at dispatch time. */
  corpusStalenessMs?: number;
}

export interface PlacementRequest {
  projectKey: ClusterProjectKey;
  placement?: ClusterTodoPlacement;
  /** False pins the run to whichever candidate holds the project (D12). */
  projectHasOrigin: boolean;
  /** Repo-relative paths this run is expected to touch, from `collectChanges` on the owning node —
   *  one git call at dispatch. Absent means the overlap check cannot run and must not pretend it
   *  did. */
  touchedPaths?: readonly string[];
  /** Every run in flight across the cluster. One definition of "active", shared with
   *  `GET /cluster/active`, so the refusal and the read cannot disagree. */
  activeRuns?: readonly ClusterActiveRun[];
}

export function placeRun(
  request: PlacementRequest,
  candidates: readonly PlacementCandidate[],
): ClusterPlacementResult {
  // D19 rung 3: checked BEFORE any node is considered. A collision is a project-level fact, not a
  // capacity question, so it preempts placement entirely rather than being folded into "queued".
  const blockedBy = overlappingRun(request, request.activeRuns ?? []);
  if (blockedBy) {
    return { status: 'blocked', blockedBy };
  }

  const pool = eligibleCandidates(request, candidates);
  const best = rankByHeadroom(pool)[0];

  if (best && headroom(best.capacity).parallel > 0) {
    return { status: 'placed', nodeId: best.nodeId };
  }

  const reason = queuedReasonFor(request, candidates);
  return { status: 'queued', reason, detail: detailFor(reason, request) };
}

export interface Headroom {
  parallel: number;
  heavy: number;
}

/** `maxParallel − active`, then `maxHeavySteps − heavyActive`. An absent `maxHeavySteps` is
 *  unbounded (today's behaviour), not zero — reading it as zero would silently stop placing on every
 *  node that predates D14. */
export function headroom(capacity: ClusterCapacity): Headroom {
  return {
    parallel: capacity.maxParallel - capacity.active,
    heavy:
      capacity.maxHeavySteps === undefined
        ? Number.POSITIVE_INFINITY
        : capacity.maxHeavySteps - capacity.heavyActive,
  };
}

/**
 * D19 rung 3: an ACTIVE run already holding this project with overlapping paths. Returns it so the
 * caller can name it — "queued" without the conflicting run is a dead end for whoever reads the
 * board. A **finished** overlapping run must not match, or the check leaks and the board wedges.
 *
 * `ClusterActiveRun` carries no status field by design: presence in `activeRuns` IS "active" (the
 * same list `GET /cluster/active` reports, D19 rung 4), so a finished run simply is not passed in —
 * there is nothing here to filter on.
 *
 * **Overlap is path-segment-prefix, not exact string equality.** A run touching
 * `packages/cezar/src/cluster/` and a run touching `packages/cezar/src/cluster/ops.ts` are
 * unambiguously fighting over the same code — exact-string intersection would miss that entirely
 * and let both start. `pathsOverlap` below is what closes it, and it compares at a `/`-segment
 * boundary specifically so `src/cluster` does not false-positive against the sibling
 * `src/cluster-section.tsx`, which would wedge the board by refusing dispatches that should proceed.
 */
export function overlappingRun(
  request: PlacementRequest,
  activeRuns: readonly ClusterActiveRun[],
): ClusterActiveRun | undefined {
  if (!request.touchedPaths || request.touchedPaths.length === 0) {
    // Absent means the check cannot run — must not pretend it did (module header, PlacementRequest).
    return undefined;
  }
  const touchedPaths = request.touchedPaths;
  return activeRuns.find(
    (run) =>
      run.projectKey === request.projectKey &&
      run.paths.some((path) => touchedPaths.some((touched) => pathsOverlap(touched, path))),
  );
}

/** Segment-boundary comparison: `a`/`b` overlap when they are equal or one is an ancestor
 *  directory of the other. Splitting on `/` (and dropping empty segments, so a trailing slash
 *  cannot change the answer) is what keeps `src/cluster` from matching `src/cluster-section.tsx` —
 *  a naive `startsWith` would treat that textual prefix as containment, and a false positive here
 *  is a dispatch refused for no reason. */
function pathsOverlap(a: string, b: string): boolean {
  const segA = a.split('/').filter(Boolean);
  const segB = b.split('/').filter(Boolean);
  const [shorter, longer] = segA.length <= segB.length ? [segA, segB] : [segB, segA];
  return shorter.every((segment, i) => segment === longer[i]);
}

/** The eligible set after `node`/`requires`/`origin`/`acceptsDispatch`/`online` — exported so the
 *  queued reason can say which filter emptied it, rather than reporting the last one that ran.
 *
 *  Filter order matters: `acceptsDispatch`/`online` first (a node that opted out or is asleep is
 *  simply not a candidate), then `origin` (D12 — "not about labels or headroom at all", so it is
 *  applied ahead of and overrides an explicit `node`/`requires` narrowing), then the todo's own
 *  `node` pin or `requires` labels. */
export function eligibleCandidates(
  request: PlacementRequest,
  candidates: readonly PlacementCandidate[],
): PlacementCandidate[] {
  let pool = candidates.filter((c) => c.acceptsDispatch && c.online);

  if (!request.projectHasOrigin) {
    pool = pool.filter((c) => c.holdsProject);
  }

  const explicitNode = request.placement?.node;
  if (explicitNode !== undefined) {
    return pool.filter((c) => c.nodeId === explicitNode);
  }

  const requires = request.placement?.requires ?? [];
  if (requires.length > 0) {
    pool = pool.filter((c) => requires.every((label) => c.labels.includes(label)));
  }

  return pool;
}

/** Descending by headroom — most `parallel` first, `heavy` as the tiebreak, then `nodeId` ascending
 *  so the choice is deterministic in tests (D12). Does not filter; an empty or capacity-starved
 *  input is the caller's problem to notice via `headroom(result[0].capacity)`. */
function rankByHeadroom(pool: readonly PlacementCandidate[]): PlacementCandidate[] {
  return [...pool].sort((a, b) => {
    const ha = headroom(a.capacity);
    const hb = headroom(b.capacity);
    if (hb.parallel !== ha.parallel) return hb.parallel - ha.parallel;
    if (hb.heavy !== ha.heavy) return hb.heavy - ha.heavy;
    return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
  });
}

/**
 * Which of the four reasons (D12) explains a non-`placed` result. Priority, deliberately not the
 * same as "which filter step emptied the pool":
 *
 * 1. `project-has-no-origin` — checked first and wins outright whenever the todo's project has no
 *    `origin`. D12 describes this rule as "not about labels or headroom at all", so ANY queued
 *    outcome for such a project is reported under this reason even when the holding node is also,
 *    separately, out of headroom — the reader needs to see "may only run where it lives", not that
 *    a downstream check also happened to fail (Verification 6a: assert the remote-less reason, not
 *    "at capacity").
 * 2. An explicit `node` pin that is missing, offline, or not accepting dispatch → `pinned-node-offline`.
 *    A pinned node that IS reachable but simply full is `all-eligible-at-capacity` — it is not
 *    offline, it is busy.
 * 3. `requires` that no online, dispatching node satisfies → `no-node-with-label`.
 * 4. Nothing at all has `acceptsDispatch` → `no-node-accepts-dispatch`, checked BEFORE the label
 *    branch so a consent gap never masquerades as a missing label.
 * 5. Otherwise the eligible set was non-empty but every member lacked headroom →
 *    `all-eligible-at-capacity`, the catch-all.
 */
function queuedReasonFor(
  request: PlacementRequest,
  candidates: readonly PlacementCandidate[],
): ClusterQueuedReason {
  if (!request.projectHasOrigin) {
    return 'project-has-no-origin';
  }

  const explicitNode = request.placement?.node;
  if (explicitNode !== undefined) {
    const pinned = candidates.find((c) => c.nodeId === explicitNode);
    if (!pinned || !pinned.online || !pinned.acceptsDispatch) {
      return 'pinned-node-offline';
    }
    return 'all-eligible-at-capacity';
  }

  // Checked BEFORE `requires`, and the order is the whole point. If nobody has opted in, the label
  // question was never reached — answering `no-node-with-label` would send an operator to add a
  // label to a node that already carries it, while the real cause is a consent bit that has never
  // been set on ANY node. Report the cause that comes first in the pipeline.
  // CONSENT only — deliberately NOT `&& c.online`. "Nobody has opted in" is a claim about the
  // operator never having run the command; a cluster whose nodes all opted in and are merely
  // asleep is a different fact, and answering this reason there would be a new lie replacing the
  // old one. That case keeps the pre-existing catch-all, which this change does not widen.
  const optedIn = candidates.filter((c) => c.acceptsDispatch);
  if (optedIn.length === 0) {
    return 'no-node-accepts-dispatch';
  }

  const requires = request.placement?.requires ?? [];
  if (requires.length > 0) {
    const dispatchable = optedIn.filter((c) => c.online);
    const hasLabel = dispatchable.some((c) => requires.every((label) => c.labels.includes(label)));
    if (!hasLabel) {
      return 'no-node-with-label';
    }
  }

  return 'all-eligible-at-capacity';
}

/** Bounded to 200 chars by `clusterPlacementResultSchema`'s `detail` field — never prose the UI has
 *  to parse, just the node/label/project name a render can drop straight into a sentence. */
function detailFor(reason: ClusterQueuedReason, request: PlacementRequest): string | undefined {
  switch (reason) {
    case 'project-has-no-origin':
      return request.projectKey;
    case 'pinned-node-offline':
      return request.placement?.node;
    case 'no-node-accepts-dispatch':
      // Deliberately no detail. Every other reason names the ONE thing to look at; this one is a
      // property of the whole cluster (nobody has run `cez cluster accept-dispatch --on`), so any
      // node named here would read as "this node is the problem" and send the fix to the wrong
      // place. The reason string is already the specific answer.
      return undefined;
    case 'no-node-with-label':
      return (request.placement?.requires ?? []).join(', ').slice(0, 200) || undefined;
    case 'all-eligible-at-capacity':
      // Pinned-and-full is still worth naming; the general "every eligible node is full" case has
      // no single node to point at without re-deriving the pool, which this function does not have.
      return request.placement?.node;
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}
