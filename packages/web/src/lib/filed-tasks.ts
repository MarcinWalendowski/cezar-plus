import {
  DEFAULT_FILED_SORT_COLUMN,
  DEFAULT_FILED_SORT_DIR,
  filedSortColumnSchema,
  type FiledPartition,
  type FiledSortColumn,
  type FiledSortDir,
  type TodoItem,
  type UpdateTodoInput,
  type WorkspaceTodoEntry,
} from '@loki-labs/better-cezar-api-client'

/**
 * The pure half of the global Tasks page's "Filed" section (2026-08-17-filed-tasks-table-
 * statuses.md): filtering, sorting and searching the cross-project todo board
 * (`GET /workspace/todos`), plus the query-param names its slice of the URL owns. The route only
 * paints what these say — same split as `lib/global-tasks.ts`, which this module sits beside
 * rather than inside, so the two facet spaces (runs vs. filed todos) stay independently testable.
 *
 * Upstream purity: nothing here names a product, a workspace or Notion — statuses and priorities
 * are the generic vocabulary the spec defines, not anything specific to this deployment.
 */

/** The four statuses a filed todo can carry. Absent on the wire reads as `'todo'` — see
 *  {@link filedStatus} — because most existing entries (and every legacy agent append) predate
 *  the field and are not, in fact, done or blocked. */
export type FiledStatus = 'todo' | 'in-progress' | 'blocked' | 'done'

export const FILED_STATUS_VALUES: readonly FiledStatus[] = ['todo', 'in-progress', 'blocked', 'done']

export type FiledPriority = 'high' | 'medium' | 'low'

export const FILED_PRIORITY_VALUES: readonly FiledPriority[] = ['high', 'medium', 'low']

export type FiledSort = 'created-desc' | 'created-asc'

/** Newest first — the same default every other list in this cockpit opens on. */
export const DEFAULT_FILED_SORT: FiledSort = 'created-desc'

/** Active vs. Archived — the same two-value split `lib/task-groups.ts`'s `ListView` uses,
 *  spelled locally so this module has no import of its own back into the runs side. */
export type FiledView = 'active' | 'archived'

export function isFiledStatus(value: string): value is FiledStatus {
  return (FILED_STATUS_VALUES as readonly string[]).includes(value)
}

export function isFiledPriority(value: string): value is FiledPriority {
  return (FILED_PRIORITY_VALUES as readonly string[]).includes(value)
}

export function isFiledSort(value: string): value is FiledSort {
  return value === 'created-desc' || value === 'created-asc'
}

/** Which Filed facets exist — the `keyof FiledTaskFilters` spelled as a name, so the control row
 *  can name the one it edits without a stringly-typed key. Mirrors `lib/global-tasks.ts`'s
 *  `FacetId`. */
export type FiledFacetId = 'statuses' | 'priorities'

export interface FiledTaskFilters {
  /** `FiledStatus` values, kept as plain strings — the same reasoning
   *  `GlobalTaskFilters.statuses` uses: a status a newer server invents passes through rather
   *  than being silently dropped by a narrowed union. Empty = every status. */
  statuses: readonly string[]
  /** `FiledPriority` values, same reasoning. Empty = every priority — including entries with
   *  none set. */
  priorities: readonly string[]
}

export const NO_FILED_FILTERS: FiledTaskFilters = { statuses: [], priorities: [] }

/** A filed entry's effective status — absent reads as `'todo'`, the same default the Filed table
 *  paints and the same one every status filter and sort has to agree with. Never written back to
 *  the entry itself; this is a read-time default only. */
export function filedStatus(entry: WorkspaceTodoEntry): FiledStatus {
  return entry.todo.status ?? 'todo'
}

/**
 * Started entries are the audit trail, not a live board row — the `inbox.tsx` `visibleTodos`
 * rule (`!todo.startedTaskId`), adopted here for the Filed table's BOTH views. Today's flat list
 * only hides them on Active, which is a latent bug this closes in passing: a started entry has no
 * further action to offer on Archived either, since Start already turned it into a run.
 */
export function isVisibleFiledEntry(entry: WorkspaceTodoEntry): boolean {
  return !entry.todo.startedTaskId
}

/**
 * Active: not archived and not done. Archived: archived OR done — the two independent ways a
 * filed task leaves the live board (Archive/Restore, and finishing the work without ever
 * clicking Archive). A row can be both at once (a done task someone also archived); either
 * condition alone is enough to place it under Archived.
 */
export function matchesFiledView(entry: WorkspaceTodoEntry, view: FiledView): boolean {
  const archived = entry.todo.archivedAt !== undefined || filedStatus(entry) === 'done'
  return view === 'archived' ? archived : !archived
}

/** A facet value matches when nothing is selected (no opinion) or the entry's own value — which
 *  may be absent, e.g. an unset priority — is one of the selected ones. An absent value never
 *  matches a non-empty selection: "no priority" is not "any priority". */
function matchesFacet(selected: readonly string[], value: string | undefined): boolean {
  return selected.length === 0 || (value !== undefined && selected.includes(value))
}

/** Search text for one filed row: summary, context and whatToDo — the three fields the detail
 *  dialog renders as markdown. Case-insensitive, joined with a separator no field itself
 *  contains, matching `lib/global-tasks.ts`'s own `haystack`. */
function filedHaystack(entry: WorkspaceTodoEntry): string {
  return [entry.todo.summary, entry.todo.context ?? '', entry.todo.whatToDo ?? ''].join('\n').toLowerCase()
}

/**
 * The list a set of filters, a view and a query leave. Every whitespace-separated token of the
 * query must match somewhere, the same every-token rule `filterGlobalTasks` uses — the page's one
 * search box narrows both lists by the same discipline.
 */
export function filterFiledTasks(
  entries: readonly WorkspaceTodoEntry[],
  filters: FiledTaskFilters,
  view: FiledView,
  query: string,
): WorkspaceTodoEntry[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return entries.filter((entry) => {
    if (!isVisibleFiledEntry(entry)) return false
    if (!matchesFiledView(entry, view)) return false
    if (!matchesFacet(filters.statuses, filedStatus(entry))) return false
    if (!matchesFacet(filters.priorities, entry.todo.priority)) return false
    if (tokens.length === 0) return true
    const text = filedHaystack(entry)
    return tokens.every((token) => text.includes(token))
  })
}

/** The list as every facet EXCEPT `except` narrows it — what a facet's own option counts are
 *  computed over, so unticking one of its values shows how many rows would return rather than a
 *  number that already assumes the tick. Mirrors `lib/global-tasks.ts`'s `tasksExcludingFacet`. */
export function filedTasksExcludingFacet(
  entries: readonly WorkspaceTodoEntry[],
  filters: FiledTaskFilters,
  view: FiledView,
  query: string,
  except: FiledFacetId,
): WorkspaceTodoEntry[] {
  return filterFiledTasks(entries, { ...filters, [except]: [] }, view, query)
}

/** How many of `entries` a facet value would leave. Entries with no value for that facet
 *  (an unset priority) are simply not counted under any value — the same "no opinion" rule
 *  `matchesFacet` reads on the other side. */
export function filedFacetCounts(
  entries: readonly WorkspaceTodoEntry[],
  valueOf: (entry: WorkspaceTodoEntry) => string | undefined,
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    const value = valueOf(entry)
    if (value === undefined) continue
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return counts
}

/**
 * Sort by creation time (`todo.ts`). `created-desc` (the default) is newest first; `created-asc`
 * reverses it. An entry with no `ts` at all — or an unparseable one, which should not happen but
 * must not crash the page if it does — sorts LAST regardless of direction: it is not "very old",
 * it is unknown, and burying unknown-age rows at the bottom is honest in both readings while
 * always pushing them to the front on one of the two would not be.
 */
export function sortFiledTasks(
  entries: readonly WorkspaceTodoEntry[],
  sort: FiledSort,
): WorkspaceTodoEntry[] {
  const time = (entry: WorkspaceTodoEntry): number | undefined => {
    if (!entry.todo.ts) return undefined
    const parsed = Date.parse(entry.todo.ts)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  const direction = sort === 'created-asc' ? 1 : -1
  return [...entries].sort((a, b) => {
    const ta = time(a)
    const tb = time(b)
    if (ta === undefined && tb === undefined) return 0
    if (ta === undefined) return 1 // missing ts always sorts last…
    if (tb === undefined) return -1 // …whichever side it is on
    return (ta - tb) * direction
  })
}

/**
 * Apply a PATCH's effect to a todo IN THE CACHE — the same semantics the server's `updateTodo`
 * (`packages/cezar/src/todos.ts`) applies on disk, mirrored here so an optimistic row and a
 * server-confirmed one are indistinguishable to every reader.
 *
 * `archived: false` REMOVES the `archivedAt` key via a rest-destructure rather than writing an
 * explicit `undefined` — the `seenAt` precedent this page already follows for run read receipts
 * (`useReadIndexedRun`'s patch, `routes/global-tasks.tsx`): every reader (`matchesFiledView`
 * above included) keys on the field being ABSENT.
 */
export function applyFiledPatch(todo: TodoItem, patch: UpdateTodoInput): TodoItem {
  let next: TodoItem = { ...todo }
  if (patch.status !== undefined) next.status = patch.status
  if (patch.priority !== undefined) next.priority = patch.priority
  if (patch.archived === true) {
    next.archivedAt = new Date().toISOString()
  } else if (patch.archived === false) {
    const { archivedAt: _dropped, ...rest } = next
    next = rest
  }
  return next
}

/** How many rows the Filed table paints before "Show 100 more" — the Archived view alone can
 *  hold ~540 migrated entries, and this is the floor against rendering all of them at once with
 *  no virtualization dependency. */
export const FILED_ROW_PAGE_SIZE = 100

// ---- URL state (composed into `lib/global-tasks.ts`'s one codec) ----------------------------

/**
 * The query-param names this section owns. Prefixed `f` so they read as the Filed table's own
 * facets beside the runs table's `status`/`tag`/`workflow` on the SAME `/tasks` URL, without
 * colliding with them (`status=running&fstatus=blocked` narrows two different lists at once).
 *
 * These are consumed by `lib/global-tasks.ts`'s `urlStateToSearchParams`/`urlStateFromSearchParams`
 * rather than by a second `URLSearchParams` writer of their own — the page doctrine is ONE codec
 * per URL, and `GlobalTasksRoute`'s `commit()` is the only place that ever calls
 * `setSearchParams`. This module supplies the value types and the parse/validate primitives
 * (`isFiledStatus` etc.); the encode/decode wiring itself lives where the rest of the URL state
 * already does, so there is exactly one function that reads the address bar and one that writes
 * it.
 */
export const FILED_SEARCH_PARAMS = {
  status: 'fstatus',
  priority: 'fpriority',
  /** The ARCHIVED table's created-date sort, unchanged. A bookmarked `?fsort=created-desc` was
   *  verified in the 2026-08-17 prod pass and keeps working exactly as it did. */
  sort: 'fsort',
  detail: 'fdetail',
  /** The Active table's per-column sort, `<column>:<dir>` (2026-08-25). */
  activeSort: 'fasort',
  /** The Backlog table's per-column sort, same grammar. */
  backlogSort: 'fbsort',
} as const

// ---- per-table sorting (2026-08-25-split-active-backlog-tables.md, D3/D6) --------------------

/**
 * One table's sort. The vocabulary itself (`FiledSortColumn`, `FiledSortDir`, the defaults) is
 * the CONTRACT's, not this module's: the server decides the order now, so the column names have
 * to be one definition rather than a client copy that can drift out of step with the enum the
 * API validates against.
 */
export interface FiledTableSort {
  column: FiledSortColumn
  dir: FiledSortDir
}

export const DEFAULT_FILED_TABLE_SORT: FiledTableSort = {
  column: DEFAULT_FILED_SORT_COLUMN,
  dir: DEFAULT_FILED_SORT_DIR,
}

/** Every column a header may sort by. `node` is absent on purpose — it renders only on a
 *  clustered cockpit, so a URL naming it would mean something on one install and nothing on the
 *  next. */
export const FILED_SORTABLE_COLUMNS: readonly FiledSortColumn[] = filedSortColumnSchema.options

export function isFiledSortColumn(value: string): value is FiledSortColumn {
  return (FILED_SORTABLE_COLUMNS as readonly string[]).includes(value)
}

export function isFiledSortDir(value: string): value is FiledSortDir {
  return value === 'asc' || value === 'desc'
}

/** `age:desc`. Both halves always present, so a hand-edited URL is either valid or falls back
 *  whole rather than half-applying. */
export function formatFiledTableSort(sort: FiledTableSort): string {
  return `${sort.column}:${sort.dir}`
}

/**
 * Parse `<column>:<dir>`, FORGIVINGLY — anything unrecognised is the default, never a throw and
 * never a blank table, the same discipline `urlStateFromSearchParams` applies to every other key.
 *
 * The legacy `created-desc` / `created-asc` spellings are accepted as aliases for `age:desc` /
 * `age:asc`, so a URL hand-edited from muscle memory (or copied off the Archived table's own
 * `fsort`) resolves instead of silently falling back to something else.
 */
export function parseFiledTableSort(raw: string | null | undefined): FiledTableSort {
  if (!raw) return DEFAULT_FILED_TABLE_SORT
  if (raw === 'created-desc') return { column: 'age', dir: 'desc' }
  if (raw === 'created-asc') return { column: 'age', dir: 'asc' }
  const [column = '', dir = ''] = raw.split(':')
  if (!isFiledSortColumn(column) || !isFiledSortDir(dir)) return DEFAULT_FILED_TABLE_SORT
  return { column, dir }
}

export function isDefaultFiledTableSort(sort: FiledTableSort): boolean {
  return sort.column === DEFAULT_FILED_TABLE_SORT.column && sort.dir === DEFAULT_FILED_TABLE_SORT.dir
}

/**
 * What a header click does: **asc → desc → asc** on the column already sorted, and `asc` on any
 * other column.
 *
 * Deliberately NOT the asc → desc → unsorted cycle of `routes/task-thread/sortable-table.tsx`.
 * That component sorts a markdown table whose file order is meaningful, so "unsorted" is a real
 * third state; here the server must always be asked for SOME order, so a third click would have
 * to mean "back to age:desc" — which the Age header already says, more clearly.
 */
export function cycleFiledTableSort(current: FiledTableSort, column: FiledSortColumn): FiledTableSort {
  if (current.column !== column) return { column, dir: 'asc' }
  return { column, dir: current.dir === 'asc' ? 'desc' : 'asc' }
}

/** `aria-sort`'s value for one header cell. `none` on every column that is not the sorted one —
 *  the attribute is on every sortable `<th>`, so a reader can tell "sortable, not sorted" from
 *  "not sortable at all". */
export function filedAriaSort(sort: FiledTableSort, column: FiledSortColumn): 'ascending' | 'descending' | 'none' {
  if (sort.column !== column) return 'none'
  return sort.dir === 'asc' ? 'ascending' : 'descending'
}

/** Which table a row belongs to. The client twin of the server's `filedPartitionOf` — used for
 *  the optimistic cache patch, never to decide what to render (the server decides that). */
export function filedPartitionOf(entry: WorkspaceTodoEntry): FiledPartition {
  return filedStatus(entry) === 'todo' ? 'backlog' : 'active'
}

// Selection for 2026-08-24-bulk-start-filed-tasks.md.

export function filedTaskKey(entry: WorkspaceTodoEntry): string {
  return `${entry.project}:${entry.todo.id}`
}

/** Parse the global Tasks deep-link key, splitting only at the project/id boundary. */
export function parseFiledDetailKey(value: string | null | undefined): { project: string; todoId: string } | null {
  if (!value) return null
  const separator = value.indexOf(':')
  if (separator <= 0 || separator === value.length - 1) return null
  return { project: value.slice(0, separator), todoId: value.slice(separator + 1) }
}

export function toggleFiledSelection(selected: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(selected)
  if (!next.delete(key)) next.add(key)
  return next
}

export function setFiledSelection(
  selected: ReadonlySet<string>,
  keys: readonly string[],
  on: boolean,
): Set<string> {
  const next = new Set(selected)
  for (const key of keys) {
    if (on) next.add(key)
    else next.delete(key)
  }
  return next
}

export function selectedFiledEntries(
  entries: readonly WorkspaceTodoEntry[],
  selected: ReadonlySet<string>,
): WorkspaceTodoEntry[] {
  return entries.filter((entry) => selected.has(filedTaskKey(entry)))
}

export function filedSelectionState(
  keys: readonly string[],
  selected: ReadonlySet<string>,
): 'none' | 'some' | 'all' {
  if (keys.length === 0) return 'none'
  let hit = 0
  for (const key of keys) if (selected.has(key)) hit += 1
  if (hit === 0) return 'none'
  return hit === keys.length ? 'all' : 'some'
}
