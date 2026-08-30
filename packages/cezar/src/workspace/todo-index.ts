import { basename, join } from 'node:path';
import type {
  FiledPartition,
  FiledSortColumn,
  FiledSortDir,
  FiledViewValue,
  WorkspaceProjectHealth,
  WorkspaceTodosCounts,
  WorkspaceTodosPage,
} from '@loki-labs/cezar-plus-contract';
import {
  DEFAULT_FILED_SORT_COLUMN,
  DEFAULT_FILED_SORT_DIR,
  FILED_ACTIVE_INITIAL_ROWS,
} from '@loki-labs/cezar-plus-contract';
import { isTombstoned, readTodos, type TodoItem } from '../todos.ts';
import { filedPartitionOf, filedStatusOf, orderFiledEntries } from './todo-ordering.ts';

/**
 * `WorkspaceTodoIndex` — the read path behind `GET /api/v1/workspace/todos` (D2 of
 * `.ai/specs/2026-08-15-knowledge-grounded-task-fanout.md`, Phase 1): the cross-project todo
 * board, so a fan-out that wrote into several projects is visible in one place.
 *
 * **READ never instantiates**, the same invariant `WorkspaceRunIndex`/`WorkspaceKnowledgeIndex`
 * hold: this module never imports `../server/project-context.ts`. It does not even need its own
 * fs/zod parsing — `readTodos()` (`../todos.ts`) is already a plain reader keyed on a `dataDir`
 * path, with no `ProjectContext` in sight, so listing every registered project's todos is just
 * deriving each one's `<root>/.ai/cezar` (the same hardcoded join `../workspace/run-index.ts`
 * uses for `runs.json`) and calling it.
 *
 * **`readTodos()` never `mkdirSync`s or writes on a plain read** (see its own doc comment): a
 * project that has never run cezar at all is read here without creating so much as an empty
 * `.ai/cezar` directory. That is what makes calling it, unmodified, safe for a board that walks
 * every registered project on every open.
 *
 * **Per-project degradation matches `readTodos()`'s own contract, not `WorkspaceRunIndex`'s.**
 * `readTodos()` never throws and never distinguishes "empty inbox" from "todos.json failed to
 * parse" — a malformed file degrades to `[]` with a `console.warn`, by design (`todos.ts`'s own
 * doc comment: "malformed ones are skipped with a warning, never fatal"). So `ok: false` here is
 * reported only for a `missing` project root — the one failure this index can see without
 * reading. An unreadable or corrupt `todos.json` still reports `ok: true, total: 0`,
 * indistinguishable from a project with nothing in its inbox; that is the existing contract
 * `readTodos()` gives every caller, not a new one invented for this board.
 *
 * Dependency-injected, not import-wired (the `WorkspaceRunIndex`/`WorkspaceKnowledgeIndex`
 * precedent): the registry lookup is a function the caller supplies, so tests stay hermetic and
 * never touch the real `~/.cezar` registry.
 */

/** One project this index may read from. Structurally a subset of `workspace/projects.ts`'s
 *  `ProjectListEntry` — injected rather than imported so a unit test never has to touch the real
 *  registry file. Mirrors `WorkspaceRunProjectSource`/`WorkspaceKnowledgeProjectSource`. */
export interface WorkspaceTodoProjectSource {
  id: string;
  root: string;
  status: 'ok' | 'missing' | 'not-git' | 'no-commits';
  name: string;
}

export interface WorkspaceTodoIndexDeps {
  /** The registry lookup, e.g. `workspace/projects.ts`'s `listProjects()` — injected so tests
   *  never read `~/.cezar`. A rejected promise degrades to an empty index rather than throwing. */
  listProjects: () => Promise<readonly WorkspaceTodoProjectSource[]>;
  /** Test seam: override the todos reader. Defaults to the real `readTodos()`. */
  readTodos?: (dataDir: string) => Promise<TodoItem[]>;
}

/** One todo, stamped with the registry slug of the project it lives in. */
export interface WorkspaceTodoEntry {
  project: string;
  todo: TodoItem;
}

export interface WorkspaceTodoListResult {
  todos: WorkspaceTodoEntry[];
  projects: WorkspaceProjectHealth[];
  /** Present only on the partitioned path — see {@link WorkspaceTodoIndex.list}. */
  page?: WorkspaceTodosPage;
  /** Present only on the partitioned path. */
  counts?: WorkspaceTodosCounts;
}

/**
 * What a partitioned read asks for (2026-08-25-split-active-backlog-tables.md). **`partition` is
 * the switch**: without it every other field is ignored and `list()` answers exactly what it
 * answered before this interface existed.
 */
export interface WorkspaceTodoListQuery {
  partition?: FiledPartition;
  sort?: FiledSortColumn;
  dir?: FiledSortDir;
  /** The page's Active/Archived tab. Defaults to `active`. */
  view?: FiledViewValue;
  limit?: number;
  /** Status facet. Empty = every status. */
  status?: readonly string[];
  /** Priority facet. Empty = every priority, including entries with none set. */
  priority?: readonly string[];
  /** The page's one search box. Every whitespace-separated token must match somewhere. */
  q?: string;
}

/**
 * Started entries are the audit trail, not a live board row, and a tombstoned one is a deletion
 * that has not been compacted away yet (`../todos.ts`: "Board consumers filter with
 * `isTombstoned`").
 *
 * **Only the partitioned path applies this.** The legacy no-params response still carries
 * tombstoned rows, which is a pre-existing leak (`list()` never called `isTombstoned`) that is
 * deliberately NOT fixed here: removing rows from a §2-protected response is exactly the breaking
 * shape `BACKWARD_COMPATIBILITY.md` forbids. Filed as its own open item on the spec.
 */
function isBoardVisible(todo: TodoItem): boolean {
  return !todo.startedTaskId && !isTombstoned(todo);
}

/** Archived: archived OR done — the two independent ways a filed task leaves the live board. The
 *  server-side twin of `web/src/lib/filed-tasks.ts`'s `matchesFiledView`. */
function matchesView(todo: TodoItem, view: FiledViewValue): boolean {
  const archived = todo.archivedAt !== undefined || filedStatusOf(todo) === 'done';
  return view === 'archived' ? archived : !archived;
}

/** No opinion (nothing selected) matches everything; an ABSENT value never matches a non-empty
 *  selection, because "no priority" is not "any priority". */
function matchesFacet(selected: readonly string[], value: string | undefined): boolean {
  return selected.length === 0 || (value !== undefined && selected.includes(value));
}

/** Summary, context and whatToDo — the three fields the detail dialog renders. Mirrors the
 *  client's `filedHaystack`, so moving the search server-side does not change what it searches. */
function haystack(todo: TodoItem): string {
  return [todo.summary, todo.context ?? '', todo.whatToDo ?? ''].join('\n').toLowerCase();
}

function matchesQuery(todo: TodoItem, tokens: readonly string[]): boolean {
  if (tokens.length === 0) return true;
  const text = haystack(todo);
  return tokens.every((token) => text.includes(token));
}

/** How many rows each facet value would leave, over a set the caller has already narrowed by
 *  every OTHER facet. Entries with no value for that facet are counted under no value at all. */
function countBy(
  entries: readonly WorkspaceTodoEntry[],
  valueOf: (entry: WorkspaceTodoEntry) => string | undefined,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    const value = valueOf(entry);
    if (value === undefined) continue;
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

export class WorkspaceTodoIndex {
  private readonly readTodosFn: (dataDir: string) => Promise<TodoItem[]>;

  constructor(private readonly deps: WorkspaceTodoIndexDeps) {
    this.readTodosFn = deps.readTodos ?? readTodos;
  }

  private async resolveSources(): Promise<WorkspaceTodoProjectSource[]> {
    try {
      return [...(await this.deps.listProjects())];
    } catch {
      return [];
    }
  }

  /**
   * Every registered project's todos, each stamped with its project id, plus one health row per
   * considered project.
   *
   * **Without `query.partition` this is the legacy path**, unchanged since it shipped: no cap, no
   * truncation, no filtering, no ordering, and no `page`/`counts` keys on the result. That payload
   * is a `BACKWARD_COMPATIBILITY.md` §2 protected surface and the composer's own board reads it.
   *
   * **With `query.partition`** the answer is one ordered, filtered page of that partition, plus
   * the `page` envelope and the facet `counts` the client can no longer compute for itself now
   * that it is not sent every row (2026-08-25-split-active-backlog-tables.md, D2/D4).
   */
  async list(query?: WorkspaceTodoListQuery): Promise<WorkspaceTodoListResult> {
    const sources = await this.resolveSources();
    const projects: WorkspaceProjectHealth[] = [];
    const todos: WorkspaceTodoEntry[] = [];

    for (const source of sources) {
      if (source.status === 'missing') {
        projects.push({
          id: source.id,
          name: source.name || basename(source.root),
          status: 'missing',
          ok: false,
          reason: 'project root is missing',
          total: 0,
        });
        continue;
      }
      const dataDir = join(source.root, '.ai', 'cezar');
      const items = await this.readTodosFn(dataDir);
      for (const todo of items) todos.push({ project: source.id, todo });
      projects.push({
        id: source.id,
        name: source.name || basename(source.root),
        status: source.status,
        ok: true,
        total: items.length,
      });
    }

    if (!query?.partition) return { todos, projects };
    return { ...this.paginate(todos, query, query.partition), projects };
  }

  /**
   * The partitioned read, over the rows the registry walk already produced. Pure — split out so
   * the walk above stays one obvious loop and this stays readable as the sequence the spec
   * describes: visible, view, partition, facets, search, order, slice.
   */
  private paginate(
    all: readonly WorkspaceTodoEntry[],
    query: WorkspaceTodoListQuery,
    partition: FiledPartition,
  ): Pick<WorkspaceTodoListResult, 'todos' | 'page' | 'counts'> {
    const view: FiledViewValue = query.view ?? 'active';
    const sort = query.sort ?? DEFAULT_FILED_SORT_COLUMN;
    const dir = query.dir ?? DEFAULT_FILED_SORT_DIR;
    const limit = query.limit ?? FILED_ACTIVE_INITIAL_ROWS;
    const statuses = query.status ?? [];
    const priorities = query.priority ?? [];
    const tokens = (query.q ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);

    // The partition BEFORE any facet or search — the denominator the section header reads, and
    // what makes "3 of 40" honest rather than "3 of 3".
    const inPartition = all.filter(
      (entry) =>
        isBoardVisible(entry.todo) &&
        matchesView(entry.todo, view) &&
        filedPartitionOf(entry.todo) === partition,
    );

    // Each facet's counts exclude ITS OWN selection, so unticking a value shows how many rows
    // would come back rather than a number that already assumes the tick.
    const narrow = (withStatuses: readonly string[], withPriorities: readonly string[]) =>
      inPartition.filter(
        (entry) =>
          matchesFacet(withStatuses, filedStatusOf(entry.todo)) &&
          matchesFacet(withPriorities, entry.todo.priority) &&
          matchesQuery(entry.todo, tokens),
      );

    const matched = narrow(statuses, priorities);
    const counts: WorkspaceTodosCounts = {
      statuses: countBy(narrow([], priorities), (entry) => filedStatusOf(entry.todo)),
      priorities: countBy(narrow(statuses, []), (entry) => entry.todo.priority),
    };

    const ordered = orderFiledEntries(matched, sort, dir);
    const rows = ordered.slice(0, limit);
    const page: WorkspaceTodosPage = {
      partition,
      sort,
      dir,
      limit,
      returned: rows.length,
      total: matched.length,
      partitionTotal: inPartition.length,
      hasMore: matched.length > rows.length,
    };
    return { todos: rows, page, counts };
  }
}
