import type { TodoItem, UpdateTodoInput, WorkspaceTodoEntry } from '@loki-labs/better-cezar-api-client'

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
  sort: 'fsort',
} as const
