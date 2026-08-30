/**
 * **The seam between "a todo wants to autostart" and "this cluster decides where it runs".**
 *
 * `todo-autostart.ts` owns the decision logic and deliberately owns no transport and no identity;
 * `cluster-routes.ts#startClusterRuntime` owns the identity and the link but is not wired into
 * autostart. This module is the one place the two meet, and it exists because of an ORDERING fact
 * that no amount of dependency injection removes: `watchTodoAutostart` is wired in `createApp`,
 * and the cluster runtime is armed later, in `startServer`. **The dispatcher does not exist when
 * the autostart project is built.** So the seam has to be asked at DECISION time, not captured at
 * wiring time — which is why `TodoAutostartProject`'s two cluster fields are functions rather than
 * values.
 *
 * **One process is one node, so at most one policy is ever armed.** That is why a module-level
 * holder is the right shape here rather than a smell: it mirrors a physical fact, it is the same
 * scope `todo-autostart.ts` already keeps `watched`/`reconcileTail`/`pendingStamp` at, and
 * `armClusterAutostart` returns a disposer so a test (or a `stop()`) can put it back.
 *
 * **With nothing armed, both answers are the single-node ones** — `CLUSTERING_OFF` and
 * `DISPATCH_LOCAL`. That is not "absence means off" in the D43 sense the codebase was burned by:
 * the fields on `TodoAutostartProject` stay REQUIRED, `server.ts` still has to name these functions
 * out loud, and nothing is defaulted at the seam a caller could forget to fill.
 */
import {
  CLUSTERING_OFF,
  DISPATCH_LOCAL,
  type TodoAutostartCluster,
  type TodoAutostartDispatch,
  type TodoClaimResult,
} from '../todo-autostart.ts';
import type { TodoItem, TodoStartOptions } from '../todos.ts';

// `DISPATCH_LOCAL` and the dispatch types are defined in `todo-autostart.ts`, beside
// `CLUSTERING_OFF`, and imported here rather than the other way round. Both constants are compared
// by IDENTITY, so neither erases at runtime — declaring them here would make this a genuine
// runtime import cycle rather than a types-only one.

interface ArmedPolicy {
  cluster: TodoAutostartCluster | typeof CLUSTERING_OFF;
  dispatch: TodoAutostartDispatch | typeof DISPATCH_LOCAL;
}

let armed: ArmedPolicy | undefined;

/**
 * Arm this process's cluster autostart policy. Returns a disposer that puts the previous value
 * back — LIFO, so a test that arms and disposes inside another arm cannot strand the outer one.
 * Arming twice without disposing is a wiring bug and warns rather than silently winning.
 */
export function armClusterAutostart(policy: ArmedPolicy, warn?: (m: string) => void): () => void {
  if (armed) {
    warn?.(
      'cluster: a second autostart policy was armed while one was already live — one process is ' +
        'one node, so this is a wiring bug; the newer policy wins and the older is restored on dispose',
    );
  }
  const previous = armed;
  armed = policy;
  return () => {
    if (armed === policy) armed = previous;
  };
}

/** `TodoAutostartProject#cluster`. Named, not inlined, so the wiring line in `server.ts` reads as
 *  a decision rather than as a lambda. */
export function currentClusterAutostart(): TodoAutostartCluster | typeof CLUSTERING_OFF {
  return armed?.cluster ?? CLUSTERING_OFF;
}

/** `TodoAutostartProject#dispatch`. */
export function currentAutostartDispatch(): TodoAutostartDispatch | typeof DISPATCH_LOCAL {
  return armed?.dispatch ?? DISPATCH_LOCAL;
}

/**
 * **The HUB's claim policy: it is the authority, so it does not ask itself for permission — but it
 * still reads the record.**
 *
 * `claimStart` accepting unconditionally is correct here and is NOT the guard being disabled. The
 * value of routing a hub through `mayAutostartTodo` at all is steps 1-3, which run BEFORE any
 * claim: a todo already carrying `startedTaskId`, or a `startedOn` naming another node, is refused
 * without asking anybody. **That is what closes the hub-restart gap** — `HubDispatcher`'s
 * duplicate-dispatch guard is in-memory (its own docblock: "a hub restart forgets the outstanding
 * dispatch and the guard lapses with it"), so after a restart the only thing standing between a
 * hub and re-dispatching work a spoke is already running is the replicated `startedOn` on the
 * record. Arming `CLUSTERING_OFF` on a hub would skip all three checks on the first line.
 *
 * The real serialization of one todo onto one node is the placement decision that follows, not this
 * function.
 */
export function createHubAutostartCluster(nodeId: string): TodoAutostartCluster {
  return {
    nodeId,
    // This process IS the hub. Not "the link is up" — there is no link to oneself, and answering
    // `false` here would send every hub todo down `mayStartWithoutHub`'s partition path.
    hubReachable: () => true,
    // Never consulted: `mayAutostartTodo` reaches `authoredHere` only when `hubReachable()` is
    // false, which the line above makes unreachable on a hub. Stated as `true` rather than left to
    // a default because the interface deliberately has none.
    authoredHere: () => true,
    claimStart: (): Promise<TodoClaimResult> => Promise.resolve({ accepted: true, startedOn: nodeId }),
  };
}

/**
 * **The SPOKE's claim policy: a worker does not self-start work the master owns.**
 *
 * This is the production `claimStart` whose absence `server.ts` recorded as the reason the whole
 * D9a guard stayed dead code — and it needs no hub round trip and no new frame type, because the
 * honest answer for a spoke is a REFUSAL rather than a request. In the topology this cluster is
 * built for (one hub that places, N workers that execute), a spoke autostarting a replicated todo
 * is never correct: the hub is already going to place that todo, so a local start is precisely the
 * cross-node duplicate D9a exists to prevent — two agents, two worktrees, two machines, one todo,
 * neither able to see the other.
 *
 * **Why this is not merely "disable autostart on spokes".** The refusal is scoped, and the scope is
 * the part that matters:
 *
 *  - **Hub reachable** — refuse. The hub sees this same todo in its own `todos.json` and will
 *    dispatch it, possibly back to this very node. Waiting costs a round trip; starting costs a
 *    duplicate.
 *  - **Hub unreachable** — NOT refused here. `mayAutostartTodo` never reaches `claimStart` in that
 *    case: it delegates to `dispatch.ts#mayStartWithoutHub`, which decides by AUTHORSHIP (D15a).
 *    So a disconnected worker still runs the todos its own operator filed on it, and still refuses
 *    foreign ones. That split is exactly why `authoredHere` is a required member with no default.
 *
 * So the spoke's rule is: *execute what you are dispatched; self-start only what you authored, and
 * only when nobody is there to place it for you.*
 */
export function createSpokeAutostartCluster(input: {
  nodeId: string;
  hubReachable: () => boolean;
  /**
   * **There is no authorship field on a replicated todo, so this cannot be derived from the record
   * — which is exactly why the interface requires it with no default.** The six replicated cluster
   * fields are `pendingSince`, `pendingFields`, `hubSeq`, `tombstone`, `placement`, `startedOn`
   * (`clusterTodoFieldsSchema`); none of them says who wrote the row. Real provenance lives in the
   * op log, which this layer does not read.
   *
   * The production wiring therefore passes `() => false`, and that is a POLICY, stated here rather
   * than buried: *a worker self-starts nothing.* It is the fail-closed direction — a wrong `true`
   * makes a partitioned node autostart every foreign todo, which is the cross-node duplicate this
   * whole design exists to prevent, while a wrong `false` costs a visible, rendered refusal and a
   * wait. Tightening it means reading the op log for the record's origin; until then, do not
   * "improve" this to a heuristic over `pendingSince`/`hubSeq`, which has false POSITIVES (a local
   * edit to a replicated row sets `pendingSince` too).
   */
  authoredHere: (todo: TodoItem) => boolean;
}): TodoAutostartCluster {
  return {
    nodeId: input.nodeId,
    hubReachable: input.hubReachable,
    authoredHere: input.authoredHere,
    claimStart: (_todo: TodoItem): Promise<TodoClaimResult> =>
      Promise.resolve({
        accepted: false,
        reason:
          'this node is a cluster worker and the hub places its work — waiting for the hub to ' +
          'dispatch this todo rather than starting a second copy of it here',
      }),
  };
}

/**
 * **What claim a start that a PERSON asked for on this host should make** —
 * `.ai/specs/2026-08-30-run-button-claim-options.md` S2. Asked by `POST /todos/:id/start`, the one
 * `markStarted` call site that reaches the write directly instead of through a placement.
 *
 * Two branches, each naming its rule:
 *
 *  - **A placement policy is armed** — this node is a hub, and it is the thing that would
 *    acknowledge its own claim. Ask it (`localStartOptions`), which answers `{clustered: false}` for
 *    a project this hub has no confirmed pairing for and a self-confirmed clustered claim when it
 *    does.
 *  - **Nothing armed** — D15a row 1: *"a person clicks the Run button, or `cez run` — **proceeds**,
 *    a human is asserting intent on this host."* Right for a **spoke** (optimistic, stamped
 *    pending, reconciled when the link returns) and inert on **single-node** cezar, where
 *    `clusteringOn()` reads the environment as off and never consults the flag. Deliberately not
 *    `{clustered: false}`: on a spoke that would be a single-node lie, asserting a claim nobody
 *    serialized.
 *
 * **Named for the human case, and autostart must not call it.** D15a row 3 says a *replicated*
 * todo's autostart REFUSES while the link is down; a helper that answers "proceed" would erase that
 * row. `startAutostartTodo` gets its options from `place()`, which is the only thing that knows
 * whether the todo is this node's to start.
 */
export async function startOptionsForHumanStart(repoRoot: string): Promise<TodoStartOptions> {
  const dispatch = currentAutostartDispatch();
  if (dispatch !== DISPATCH_LOCAL) return dispatch.localStartOptions({ repoRoot });
  return { humanIntent: true };
}
