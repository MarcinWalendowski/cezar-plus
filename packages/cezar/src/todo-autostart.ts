import { markStarted, onTodosChanged, readTodos, todoTaskText, type TodoItem } from './todos.ts';
import { resolveTodoWorkflow, type RunManager } from './workflows/run.ts';
import { inheritAuthor } from './runs/task-author.ts';

/**
 * Phase 2 — `cezar todo add --start` (`.ai/specs/2026-08-19-file-tasks-from-a-running-task.md`).
 *
 * The running cockpit, never a second headless manager (Solution, "Rejected alternative"), is
 * what turns an `autostart: true` todo into a run: only it owns this project's concurrency cap
 * and single-workspace-run lease (`RunManager.startRun`), and only it can stream the result live.
 * This module is that hook — one `todos.json` watch per project context, wired the same way
 * `ProviderRuntimeAuthObserver` covers the boot context, every already-built context and every
 * later-built one (`server.ts`, next to that wiring).
 */

/** The subset of a project context this module needs — matches (a slice of)
 *  `server/project-context.ts`'s `ProjectContext`, duck-typed so this module carries no
 *  dependency on the server layer. */
export interface TodoAutostartProject {
  repoRoot: string;
  dataDir: string;
  manager: RunManager;
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
