import type { FiledPartition, FiledSortColumn, FiledSortDir } from '@loki-labs/better-cezar-contract';
import type { TodoItem } from '../todos.ts';

/**
 * The Filed board's total order and its partition rule — the pure half of
 * `.ai/specs/2026-08-25-split-active-backlog-tables.md` (D3), extracted so it is unit-testable
 * with no fs, no registry and no `ProjectContext` in sight (the same discipline
 * `./todo-index.ts` states for itself, which is why this is a separate file rather than three
 * more functions in it).
 *
 * ## Two rules make the order deterministic
 *
 * 1. **Codepoint compare, never `localeCompare`.** `localeCompare` resolves through ICU, so its
 *    answer can differ between the Node build serving a request and the one running the test —
 *    which would make the page's order depend on which machine answered. Every string column
 *    lowercases and then compares with `<`, and nothing else.
 * 2. **Every comparator falls through to the `project:id` composite key ASCENDING, regardless of
 *    `dir`.** That key is already the React row key on the client (`filedTaskKey`), is unique
 *    across projects, and is always present on the wire (ids are backfilled on read,
 *    `../todos.ts`). Because the tie-break direction does not flip with `dir`, the order for a
 *    given `(column, dir, filters)` is one fixed sequence.
 *
 * From (2) follows the property the acceptance criteria calls stability:
 *
 * > **Prefix property.** For a fixed `(partition, sort, dir, filters, q)`, the rows returned for
 * > `limit = N` are exactly the first `N` rows returned for `limit = N + k`, for every `k >= 0`.
 *
 * So a Show more can only append. It can never reorder or drop a row already on screen — which is
 * what "preserves status partitions during expansion" has to mean to be testable.
 *
 * ## Absent values sort LAST in BOTH directions
 *
 * `ts`, `priority` and `author` may be absent. An absent value is *unknown*, not extreme: sorting
 * it as "very old" or "lowest priority" would push a wall of unknowns to the top on exactly one
 * of the two directions. This preserves verbatim the rule the shipped client-side sort already
 * applies to `ts` (`web/src/lib/filed-tasks.ts`'s `sortFiledTasks`).
 *
 * `status` is never absent here: absent reads as `'todo'`, the same read-time default the board
 * has always painted (`filedStatus`).
 */

/** One row this module can order. Structurally what `WorkspaceTodoIndex` holds. */
export interface OrderableTodoEntry {
  project: string;
  todo: TodoItem;
}

/** The workflow order the status enum already declares (`../todos.ts`, `contract/src/skills.ts`)
 *  — NOT alphabetical, which would put `blocked` before `in-progress` and read as nonsense. */
const STATUS_RANK: Record<string, number> = {
  todo: 0,
  'in-progress': 1,
  blocked: 2,
  done: 3,
};

const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

/** A filed entry's effective status — absent reads as `'todo'`. Read-time only; never written
 *  back. The server-side twin of `web/src/lib/filed-tasks.ts`'s `filedStatus`. */
export function filedStatusOf(todo: Pick<TodoItem, 'status'>): string {
  return todo.status ?? 'todo';
}

/**
 * Which table a row belongs to. **Backlog is `todo` (including absent); Active is everything
 * else.** Note this is a different question from the page's Active/Archived tab, which keys on
 * `archivedAt` or `done` — the two splits compose (D1) rather than competing.
 */
export function filedPartitionOf(todo: Pick<TodoItem, 'status'>): FiledPartition {
  return filedStatusOf(todo) === 'todo' ? 'backlog' : 'active';
}

/** The composite row key, and the tie-breaker. Matches `web/src/lib/filed-tasks.ts`'s
 *  `filedTaskKey` exactly, so the server's tie-break and the client's React key are one string. */
export function filedRowKey(entry: OrderableTodoEntry): string {
  return `${entry.project}:${entry.todo.id ?? ''}`;
}

/** Epoch ms, or `undefined` for absent AND for unparseable — which should not happen but must not
 *  reorder the board if it does. */
function ageOf(todo: Pick<TodoItem, 'ts'>): number | undefined {
  if (!todo.ts) return undefined;
  const parsed = Date.parse(todo.ts);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Display name, `label` before `id` — the same precedence the Author cell renders
 *  (`contract/src/task-author.ts`: `label` is display only). */
function authorOf(todo: TodoItem): string | undefined {
  const author = todo.author;
  if (!author) return undefined;
  return author.label ?? author.id;
}

/** The sort key for one column. `undefined` means "unknown", which sorts last both ways. */
function sortKey(entry: OrderableTodoEntry, column: FiledSortColumn): number | string | undefined {
  switch (column) {
    case 'age':
      return ageOf(entry.todo);
    case 'status':
      return STATUS_RANK[filedStatusOf(entry.todo)] ?? STATUS_RANK.todo;
    case 'priority':
      return entry.todo.priority === undefined ? undefined : PRIORITY_RANK[entry.todo.priority];
    case 'task':
      return entry.todo.summary.toLowerCase();
    case 'project':
      return entry.project.toLowerCase();
    case 'author': {
      const label = authorOf(entry.todo);
      return label === undefined ? undefined : label.toLowerCase();
    }
  }
}

/**
 * `-1 | 0 | 1` for two keys of the same column, with `undefined` last in BOTH directions.
 *
 * Only comparable keys reach `<`: `sortKey` returns a number for every numeric column and a
 * string for every string one, so the two sides are always the same type.
 */
function compareKeys(
  a: number | string | undefined,
  b: number | string | undefined,
  dir: FiledSortDir,
): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1; // unknown always last…
  if (b === undefined) return -1; // …whichever side it is on
  const raw = a < b ? -1 : a > b ? 1 : 0;
  return dir === 'asc' ? raw : -raw;
}

/**
 * The comparator for one `(column, dir)`. **Total**: it returns 0 only for a row compared with
 * itself, because the fall-through is the unique `project:id` key.
 */
export function compareFiledEntries(
  column: FiledSortColumn,
  dir: FiledSortDir,
): (a: OrderableTodoEntry, b: OrderableTodoEntry) => number {
  return (a, b) => {
    const primary = compareKeys(sortKey(a, column), sortKey(b, column), dir);
    if (primary !== 0) return primary;
    // Ascending regardless of `dir` — see rule (2) above. Flipping it with the direction would
    // give two different total orders for the same page, and the prefix property with it.
    const ka = filedRowKey(a);
    const kb = filedRowKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  };
}

/** A new array in the total order for `(column, dir)`. Never mutates its input. */
export function orderFiledEntries<T extends OrderableTodoEntry>(
  entries: readonly T[],
  column: FiledSortColumn,
  dir: FiledSortDir,
): T[] {
  return [...entries].sort(compareFiledEntries(column, dir));
}
