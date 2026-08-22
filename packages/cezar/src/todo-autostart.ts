import type { ClusterNodeId } from '@loki-labs/better-cezar-contract';
import { isTombstoned, markStarted, onTodosChanged, readTodos, todoTaskText, type TodoItem } from './todos.ts';
import { resolveTodoWorkflow, type RunManager } from './workflows/run.ts';
import { inheritAuthor } from './runs/task-author.ts';
import { mayStartWithoutHub } from './cluster/dispatch.ts';
import type { ClusteredTodoItem } from './cluster/replica.ts';

/**
 * Phase 2 — `cezar todo add --start` (`.ai/specs/2026-08-19-file-tasks-from-a-running-task.md`).
 *
 * The running cockpit, never a second headless manager (Solution, "Rejected alternative"), is
 * what turns an `autostart: true` todo into a run: only it owns this project's concurrency cap
 * and single-workspace-run lease (`RunManager.startRun`), and only it can stream the result live.
 * This module is that hook — one `todos.json` watch per project context, wired the same way
 * `ProviderRuntimeAuthObserver` covers the boot context, every already-built context and every
 * later-built one (`server.ts`, next to that wiring).
 *
 * ---
 *
 * **Phase 3 of the cluster (`.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, PLAN 3.2) added
 * TWO things here, not one, and they are worth naming separately:**
 *
 * **(a) A guard** — `mayAutostartTodo`: start only once the hub has acknowledged the claim. **When
 * clustering is off it is a no-op that allows**, on its first line, having touched nothing.
 *
 * **(b) D9a's confirm-before-start ordering, on the cluster path only** — the claim is confirmed
 * before `startRun`, so the failure mode of a crash is a *visible pending start*, never a
 * duplicate. The existing act-then-stamp order (resolve → start → `markStarted`) is exactly what
 * runs when clustering is off; nothing about a cezar install with `CEZ_CLUSTER` unset moves.
 *
 * **The durable key is the replicated stamp, not a lease** — nothing in this file reads
 * `cluster/leases.ts`, and that is the point. The hub blue-green self-deploys ~10 times a day
 * (D15b), so a lease store is wiped ~10 times a day; a guard that consulted one would hand the same
 * work to a second node on a routine deploy. `leases.ts`'s own docblock says the same from the
 * other side: *"todo claims are no longer a lease at all … for claims, losing this file changes
 * nothing, because this file was never in that path."*
 */

/** The subset of a project context this module needs — matches (a slice of)
 *  `server/project-context.ts`'s `ProjectContext`, duck-typed so this module carries no
 *  dependency on the server layer. */
export interface TodoAutostartProject {
  repoRoot: string;
  dataDir: string;
  manager: RunManager;
  /**
   * **Absent means clustering is off, and that is the whole of the switch** (spec
   * `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, D4 · D9a · D15a; PLAN 3.2).
   *
   * Deliberately ONE condition rather than two. The guard below is gated on nothing else — no
   * second `CEZ_CLUSTER` read here — because a rule enforced at two points drifts silently, and
   * because "there is no port object" makes the off path structurally unable to fire rather than
   * merely configured not to. `server.ts` is the single place that decides, from
   * `clusterModeFromEnv` (`cluster/node-identity.ts`, D1's own and only home for hub-ness).
   *
   * With it absent this module behaves exactly as it did before the cluster existed: resolve the
   * workflow, start the run, THEN stamp — the local act-then-stamp order, untouched.
   */
  cluster?: TodoAutostartCluster;
  /**
   * Where a refusal is RENDERED. D15a: *"the refusal is a stated, rendered state — never a silent
   * skip"*, so a refused autostart has to reach a surface, not only a log line. Optional because
   * the cockpit surface that consumes it lands in a later package; the console warning below is
   * the floor that exists either way.
   */
  onRefused?: (refusal: AutostartRefusal) => void;
}

/**
 * The hub's verdict on a claim. Shaped on the wire's own `clusterAckResultSchema`
 * (`packages/contract/src/cluster.ts`), whose doc comment settles what a losing claim carries:
 * *"a claim another node already won comes back `accepted: false` with the winner's `startedOn`."*
 * So `startedOn` — the node — is the claim's identity, not a run id.
 */
export type TodoClaimResult =
  | { accepted: true; startedOn: ClusterNodeId }
  | { accepted: false; reason: string; startedOn?: ClusterNodeId };

/**
 * The cluster seam this module needs, and nothing more. It **decides**; the transport lives in
 * `cluster/link-client.ts` and the write-down in `todos.ts`'s replica path — the same
 * decision/start split `cluster/dispatch.ts` already draws for itself (*"this module decides; it
 * never starts a run, and it never mints a run id"*).
 *
 * **Why `claimStart` does not carry a proposed run id.** D9a's prose says the ack carries "the
 * applied `startedTaskId`/`startedOn`", which would need a run id minted before the run exists.
 * `RunManager.startRun` → `RunStore.createRun` self-mints (`runs/store.ts`), and `dispatch.ts`
 * records why a second mint is a live bug rather than a convenience: *"minting a second id here
 * would give one run two identities; a consumer that keys on run id … would subscribe to a run
 * that never existed, silently and forever."* A pre-minted id written into `startedTaskId` would
 * also hand the cancel path (`clearStartedTaskId`, keyed on the run id) and the Inbox's "Started"
 * link a run that does not exist. So the claim's durable key is `startedOn`, exactly as the landed
 * contract encodes it, and `startedTaskId` is stamped afterwards with the run's own id.
 */
export interface TodoAutostartCluster {
  /** This node. Compared against a record's replicated `startedOn`. */
  nodeId: ClusterNodeId;
  /** Is the hub reachable right now? Only ever consulted to pick between the two D15a scopes. */
  hubReachable(): boolean;
  /**
   * Did THIS node author the todo? Required, with no default, on purpose: provenance lives in the
   * cluster layer (the op log and the replica push), not on the record this module can see, and a
   * defaulted `true` would make an offline node autostart every foreign todo — the exact
   * double-start D15a scopes away. A wrong answer here can only ever matter while the hub is
   * unreachable; with the link up every claim goes through the hub regardless of authorship (D4).
   */
  authoredHere(todo: ClusteredTodoItem): boolean;
  /** Send the claim op and WAIT for the hub's acknowledgement (D9a). Never optimistic. */
  claimStart(todo: ClusteredTodoItem): Promise<TodoClaimResult>;
}

/** `{ allowed: true }` is the no-op answer clustering-off always gives. A refusal always carries a
 *  reason — the same shape `cluster/dispatch.ts#mayStartWithoutHub` returns, so the two compose
 *  without translation. */
export type AutostartDecision = { allowed: true } | { allowed: false; reason: string };

export interface AutostartRefusal {
  dataDir: string;
  todoId: string;
  summary: string;
  reason: string;
}

/**
 * **(a) The guard.** Start only once the hub has acknowledged the claim.
 *
 * **With clustering off this is a no-op that allows, on the first line, having touched nothing.**
 * Every guard here is gated on a flag most installs never set, and one that fired when off would
 * break single-node autostart for every existing user of the published package.
 *
 * With clustering on, in order:
 *
 * 1. **`startedTaskId` — the durable key** (Verification 10). A hub blue-green deploy wipes the
 *    lease store ~10 times a day (D15b), so a guard that consulted a lease would hand the same
 *    work to a second node on a routine deploy. This consults the *replicated record* instead, and
 *    a wiped hub is never asked at all.
 * 2. **`startedOn` from another node** — the same durable key one step earlier: a node that has
 *    been acknowledged but has not started yet (the Verification 11 crash window). The failure
 *    mode is a visible pending start, never a duplicate.
 * 3. **`startedOn` is us** — we already hold the hub's acknowledgement; resume rather than claim a
 *    second time.
 * 4. **Hub unreachable** — D15a's scope split, delegated verbatim to
 *    `cluster/dispatch.ts#mayStartWithoutHub` rather than re-decided here. Two rules that pull in
 *    opposite directions get scopes, not an ordering, and one copy of the scope.
 * 5. Otherwise **claim, and wait**.
 */
export async function mayAutostartTodo(
  project: TodoAutostartProject,
  todo: TodoItem,
): Promise<AutostartDecision> {
  const cluster = project.cluster;
  if (!cluster) return { allowed: true };

  // `TodoItem` now carries the five cluster fields (package 2.3 spread `clusterTodoFieldsSchema`
  // into `todoSchema`), so this reads them directly. The cast is only to `cluster/replica.ts`'s
  // `ClusteredTodoItem`, which is the same record plus the contract's `.passthrough()` index —
  // the type the cluster seam speaks, so a port implementation needs no translation.
  const record = todo as ClusteredTodoItem;

  if (record.startedTaskId) {
    return { allowed: false, reason: `already started as run ${record.startedTaskId}` };
  }

  const startedOn = record.startedOn;
  if (startedOn !== undefined && startedOn !== cluster.nodeId) {
    return { allowed: false, reason: `already claimed by node ${startedOn}` };
  }
  // Ours already. Re-claiming would be harmless at the hub (it is idempotent per node) but it
  // would also be a round trip on every reconcile pass for a start that crashed mid-flight, and
  // this node is the only one entitled to finish it.
  if (startedOn === cluster.nodeId) return { allowed: true };

  if (!cluster.hubReachable()) {
    return mayStartWithoutHub({ trigger: 'autostart', authoredHere: cluster.authoredHere(record) });
  }

  const claim = await cluster.claimStart(record);
  if (claim.accepted) return { allowed: true };
  return {
    allowed: false,
    reason:
      claim.startedOn !== undefined
        ? `${claim.reason} (claimed by node ${claim.startedOn})`
        : claim.reason,
  };
}

/** Last reason warned per todo, so a permanently-refused replicated todo does not warn once per
 *  `todos.json` write — the Inbox writes that file often. The refusal still reaches `onRefused`
 *  every pass; only the log line is deduped, and a CHANGED reason always warns again. */
const lastRefusalReason = new Map<string, string>();

const refusalKey = (dataDir: string, todoId: string) => `${dataDir} ${todoId}`;

function reportRefusal(project: TodoAutostartProject, todo: TodoItem, reason: string): void {
  const refusal: AutostartRefusal = {
    dataDir: project.dataDir,
    todoId: todo.id,
    summary: todo.summary,
    reason,
  };
  project.onRefused?.(refusal);
  const key = refusalKey(project.dataDir, todo.id);
  if (lastRefusalReason.get(key) === reason) return;
  lastRefusalReason.set(key, reason);
  console.warn(`[cez] todo autostart refused for "${todo.summary}" (${todo.id}): ${reason}`);
}

/**
 * Turn ONE todo into a run: resolve its workflow the same way `POST /todos/:id/start` does
 * (`resolveTodoWorkflow`), build the exact task text "▶ Run" would (`todoTaskText` — autostart
 * never carries the route's optional extra `prompt`), start it through THIS project's own
 * manager, then stamp `startedTaskId` and clear `autostart` (`markStarted`).
 *
 * No provider-availability / `agentModelsLocked` pre-check here, unlike the HTTP route: those
 * exist to show an interactive caller a reason before refusing to spawn anything, and autostart
 * has no caller to show one to — a provider that genuinely can't run fails loudly INSIDE the
 * spawned run instead, the same precedent `RunManager.recover()` already sets for a revived run
 * (never re-gated on providers either).
 */
async function startAutostartTodo(project: TodoAutostartProject, todo: TodoItem): Promise<void> {
  const workflow = await resolveTodoWorkflow(project.repoRoot, todo);

  // **(b) D9a's confirm-before-start ordering, on the CLUSTER path only.** This file and
  // `reopen-watch.ts` both act-then-stamp on one host and both explain why: *"a crash between the
  // two leaves the row pending, so the next pass continues the run a second time (a visible
  // `continue-2`); stamping first would instead lose the reopen silently."* That trade is right on
  // one host, where the duplicate is visible in the same cockpit to the same person. It is the
  // wrong trade across nodes — a cross-node duplicate is two agents in two worktrees on two
  // machines, neither able to see the other, spending one subscription twice, and the first symptom
  // is a merge conflict hours later. So the hub-confirmed claim comes FIRST here and the failure
  // mode becomes a visible pending start.
  //
  // The window between the acknowledged claim and `startRun` below is deliberately as small as it
  // can be made: resolving the workflow (a local read with no side effect, so it is not "acting")
  // happens above, before anything is claimed, and nothing else sits between the two. A crash
  // inside that window leaves the record stamped `startedOn: <this node>` and un-started, which
  // this node's next pass resumes (`mayAutostartTodo` step 3) and no other node will touch.
  //
  // With clustering off `mayAutostartTodo` allows on its first line, so the order below is exactly
  // what it has always been: resolve → start → stamp.
  const decision = await mayAutostartTodo(project, todo);
  if (!decision.allowed) {
    reportRefusal(project, todo, decision.reason);
    return;
  }

  const run = project.manager.startRun(workflow, {
    task: todoTaskText(todo),
    // INHERITED, not re-derived (spec 2026-08-21-task-author-provenance): no human acted here, so
    // the agent that filed the todo is the author of the run it caused. `via` becomes this door;
    // `at` stays the moment that agent acted. A legacy todo with no author degrades to `system`,
    // which is the honest answer rather than a guess.
    author: inheritAuthor(todo.author, 'todo-autostart'),
  });
  // TODO(analytics): emit `todo.autostarted` (project, queuedBehindLease) here once an event sink
  // exists — see `todo-cli.ts`'s matching TODO for `todo.filed`. No such mechanism exists in this
  // codebase today (grepped for analytics/telemetry/trackEvent — none), so this is left as a TODO
  // rather than inventing one.
  await markStarted(project.dataDir, todo.id, run.id);
  // The run exists and is stamped; any refusal this todo accumulated is history, so a later
  // refusal for the same id warns again rather than being deduped against a dead reason.
  lastRefusalReason.delete(refusalKey(project.dataDir, todo.id));
}

/** Serializes reconcile passes per `dataDir` (the boot-pass call in `watchTodoAutostart` below and
 *  a `todos.json` change landing moments later must never run concurrently): each pass re-reads
 *  `todos.json` fresh, so a todo `markStarted` by an earlier pass has already lost its `autostart`
 *  flag by the time a later pass reads the file, which is what makes two of OUR OWN triggers
 *  double-start safe against each other. Mirrors `RunManager`'s own `repoRootTail` idiom. */
const reconcileTail = new Map<string, Promise<void>>();

/**
 * One reconcile pass over `project.dataDir`'s `todos.json`: start every todo with
 * `autostart: true && !startedTaskId`, in file order. A single failing todo (a workflow that
 * fails to resolve, a store write that throws) is logged and skipped — never lets one bad entry
 * stop the rest of the file from reconciling.
 */
export function reconcileAutostartTodos(project: TodoAutostartProject): Promise<void> {
  const prior = reconcileTail.get(project.dataDir) ?? Promise.resolve();
  const next = prior.then(() => reconcileAutostartTodosOnce(project)).catch(() => undefined);
  reconcileTail.set(project.dataDir, next);
  return next;
}

async function reconcileAutostartTodosOnce(project: TodoAutostartProject): Promise<void> {
  const todos = await readTodos(project.dataDir);
  for (const todo of todos) {
    if (!todo.autostart || todo.startedTaskId) continue;
    // A delete is a TOMBSTONE, never a removal (D6), and `readTodos` deliberately returns
    // tombstoned rows so the replicator can see them. Without this line, deleting a not-yet-started
    // `autostart` todo on ANOTHER node would replicate down here as a row that still carries
    // `autostart: true` — and this loop would start the work somebody just deleted. Free when
    // clustering is off: nothing writes `tombstone` then.
    if (isTombstoned(todo)) continue;
    try {
      await startAutostartTodo(project, todo);
    } catch (err) {
      console.warn(
        `[cez] todo autostart failed for "${todo.summary}" (${todo.id}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** Live subscriptions, keyed by `dataDir` — at most one per project at a time. Replaced, not
 *  stacked, on re-subscribe (see `watchTodoAutostart`'s own comment for why: a project context
 *  can be disposed and rebuilt with a fresh `manager`, and an old subscription pointed at a
 *  disposed one must not linger). */
const watched = new Map<string, () => void>();

/**
 * Wire a project's `todos.json` to autostart: one immediate reconcile pass (the "boot pass" —
 * covers a project whose context was built, or rebuilt, while an `autostart` todo was already
 * sitting in the file) plus a live `fs.watch` subscription for every change after that
 * (`onTodosChanged`, the SAME watch the Inbox's own live updates use — same debounce, same
 * "degrades to no live updates, never a crash" fallback per the Risks section: a missed
 * `fs.watch` event is caught at the NEXT reconcile, whether that is a later file change or this
 * project's next boot).
 *
 * Safe to call more than once for the same `dataDir` (a disposed-and-rebuilt project context):
 * a prior subscription is torn down first, so exactly one watch — pointed at the current
 * `manager` — is ever live per project.
 */
export function watchTodoAutostart(project: TodoAutostartProject): () => void {
  watched.get(project.dataDir)?.();
  void reconcileAutostartTodos(project);
  const unsubscribe = onTodosChanged(project.dataDir, () => void reconcileAutostartTodos(project));
  const stop = () => {
    unsubscribe();
    if (watched.get(project.dataDir) === stop) watched.delete(project.dataDir);
  };
  watched.set(project.dataDir, stop);
  return stop;
}
