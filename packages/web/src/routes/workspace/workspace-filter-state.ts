import type { WorkspaceUiState } from '@loki-labs/cezar-plus-api-client'

/**
 * Pure filter-state logic for `/workspace/tasks` (W4.10,
 * `.ai/specs/2026-08-06-workspace-notes-cross-project.md` "UI/UX" — "Filter state lives in the
 * URL"). No React here on purpose, the `lib/last-location.ts` precedent: this is the behavior
 * worth testing directly, and it is testable as a table because nothing here touches the DOM,
 * the router or a query client.
 *
 * The contract, in order:
 *  - **Absent `projects` means ALL projects, never none** — the same rule the server route
 *    (`workspace-runs-routes.ts`) and `WorkspaceRunIndex` share.
 *  - **The URL's own value always wins**, field by field (the `lastLocation` rule: "an explicit
 *    link always wins"). A field the URL is silent about falls back to the last-used selection
 *    mirrored into `~/.cezar/ui-state.json`.
 *  - **Unknown or removed project ids are dropped on read.** A stale bookmark or a since-deleted
 *    project must never render an unexplained empty board.
 *
 * `workspaceTasks` is not (yet) a named key on `workspaceUiStateSchema`
 * (`packages/contract/src/workspace.ts`) — that file sits outside this package's ownership in
 * the PLAN's package table (`.ai/runs/2026-08-06-cezar-central-hub/PLAN.md`, W4.10's row), so
 * this module reads and writes it through the existing OPEN bag instead of a typed field.
 * `workspaceUiStateSchema` is `z.looseObject(...)` precisely so an unlisted key round-trips
 * untouched (`BACKWARD_COMPATIBILITY.md` §3), which is the mechanism this relies on.
 */

export type WorkspaceTasksView = 'active' | 'archived'

/** The effective filter for one render. `projects: undefined` is ALL projects — never `[]`,
 *  which is a real, deliberate "nothing selected" the caller renders as its own empty state. */
export interface WorkspaceTasksFilter {
  projects: string[] | undefined
  view: WorkspaceTasksView
}

/** The shape mirrored into `~/.cezar/ui-state.json`'s `workspaceTasks` bag. */
export interface StoredWorkspaceTasksFilter {
  projects?: string[]
  view?: WorkspaceTasksView
}

function isView(value: unknown): value is WorkspaceTasksView {
  return value === 'active' || value === 'archived'
}

/** Reads the stored last-used selection off the open ui-state bag. Anything malformed (wrong
 *  type, corrupt entry from a hand-edited file) degrades to "nothing stored" rather than
 *  throwing — the same salvage discipline `workspace/config.ts` applies to the registry. */
export function readStoredWorkspaceTasksFilter(
  uiState: WorkspaceUiState | undefined,
): StoredWorkspaceTasksFilter | undefined {
  // `workspaceUiStateSchema` is `z.looseObject(...)`, so its inferred type already admits an
  // unlisted key like `workspaceTasks` directly — no cast needed to read it.
  const raw = uiState?.workspaceTasks
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const projects =
    Array.isArray(record.projects) && record.projects.every((id) => typeof id === 'string')
      ? (record.projects as string[])
      : undefined
  const view = isView(record.view) ? record.view : undefined
  if (projects === undefined && view === undefined) return undefined
  return { ...(projects !== undefined ? { projects } : {}), ...(view !== undefined ? { view } : {}) }
}

/** The URL's own half of the filter — `null` on a field the URL is silent about, so the caller
 *  can fall back to the stored preference for that field only. A PRESENT-but-empty `projects`
 *  param is a deliberate "no projects" and parses to `[]`, never `null` — mirrored from the
 *  server's own `parseProjectsFilter` (`server/workspace-runs-routes.ts`). */
export function parseWorkspaceTasksSearch(search: URLSearchParams): {
  projects: string[] | null
  view: WorkspaceTasksView | null
} {
  const rawProjects = search.get('projects')
  const projects =
    rawProjects === null
      ? null
      : rawProjects
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean)
  const rawView = search.get('view')
  return { projects, view: isView(rawView) ? rawView : null }
}

export interface ResolvedWorkspaceTasksFilter {
  filter: WorkspaceTasksFilter
  /** Requested ids that are not in `registry` — either from the URL or from storage. */
  droppedIds: string[]
  /** True only when the URL's OWN `projects` param needs correcting (some of its ids were
   *  unknown). Restoring silently from storage into a bare `/workspace/tasks` does not, on its
   *  own, force a rewrite — a plain link stays a plain link. */
  needsUrlRewrite: boolean
}

/**
 * The effective filter for one render, resolved field by field: the URL wins where it speaks,
 * the stored preference fills what it is silent about, and `registry` (the currently registered
 * project ids) drops anything neither side can point at. `registry === undefined` (the project
 * list has not loaded yet) skips the drop pass entirely rather than treating "not loaded" as
 * "nothing is registered" — that would flash every id as unknown for one render.
 */
export function resolveWorkspaceTasksFilter(
  search: URLSearchParams,
  stored: WorkspaceUiState | undefined,
  registry: readonly string[] | undefined,
): ResolvedWorkspaceTasksFilter {
  const url = parseWorkspaceTasksSearch(search)
  const storedFilter = readStoredWorkspaceTasksFilter(stored)

  const view = url.view ?? storedFilter?.view ?? 'active'
  const rawProjects = url.projects ?? storedFilter?.projects

  if (rawProjects === undefined) {
    return { filter: { projects: undefined, view }, droppedIds: [], needsUrlRewrite: false }
  }

  const known = registry ? new Set(registry) : undefined
  const droppedIds: string[] = []
  const projects = known
    ? rawProjects.filter((id) => {
        if (known.has(id)) return true
        droppedIds.push(id)
        return false
      })
    : [...rawProjects]

  return {
    filter: { projects, view },
    droppedIds,
    // Only the URL's OWN value can be "wrong" in a way worth correcting the address bar for —
    // a value that arrived from storage was never claimed by this URL in the first place.
    needsUrlRewrite: url.projects !== null && droppedIds.length > 0,
  }
}

/** The canonical `?projects=...&view=...` for a filter. `projects: undefined` omits the param
 *  entirely (ALL, never none); an explicit `[]` is written as `projects=` so a shared link keeps
 *  meaning "nothing selected" rather than silently reverting to ALL. `view` is always written so
 *  a shared link stays unambiguous even after the stored default changes later. */
export function workspaceTasksSearchParams(filter: WorkspaceTasksFilter): URLSearchParams {
  const params = new URLSearchParams()
  if (filter.projects !== undefined) params.set('projects', filter.projects.join(','))
  params.set('view', filter.view)
  return params
}

/** Same-value check so a caller can skip a `setSearchParams`/PUT that would change nothing. */
export function sameWorkspaceTasksFilter(a: WorkspaceTasksFilter, b: WorkspaceTasksFilter): boolean {
  if (a.view !== b.view) return false
  if (a.projects === undefined || b.projects === undefined) return a.projects === b.projects
  if (a.projects.length !== b.projects.length) return false
  return a.projects.every((id, index) => id === b.projects![index])
}

/** What to PUT into `~/.cezar/ui-state.json` to remember this filter as the last-used one. The
 *  PUT merges SHALLOWLY at the top level (spec, "Data Models"), so this is always the WHOLE
 *  `workspaceTasks` bag, never a leaf — a caller sends `{ workspaceTasks: ... }` and nothing
 *  else it does not also intend to touch. */
export function workspaceTasksUiStatePatch(
  filter: WorkspaceTasksFilter,
): { workspaceTasks: StoredWorkspaceTasksFilter } {
  return {
    workspaceTasks: {
      ...(filter.projects !== undefined ? { projects: filter.projects } : {}),
      view: filter.view,
    },
  }
}
