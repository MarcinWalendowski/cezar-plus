import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  EyeIcon,
  EyeOffIcon,
  LayersIcon,
  ListChecksIcon,
  PlayIcon,
  SearchIcon,
  SearchXIcon,
  XIcon,
} from 'lucide-react'
import * as React from 'react'
import { Link, useLocation, useSearchParams } from 'react-router'

import { archiveProjectRun, setProjectRunRead, startWorkspaceTodo } from '@/api/client'
import { useStartFiledTask, useUpdateFiledTodo } from '@/api/filed-task-mutations'
import {
  queryKeys,
  rememberReferenceStatuses,
  useHealth,
  useProjects,
  useRunsIndex,
  useWorkspaceTodoPage,
  useWorkspaceTodos,
  workspaceQueryKeys,
} from '@/api/queries'
import type {
  FiledSortColumn,
  ProjectListEntry,
  RunIndexEntry,
  RunsIndexResponse,
  WorkspaceTodoEntry,
  WorkspaceTodosPage,
} from '@loki-labs/better-cezar-api-client'
import {
  FILED_ACTIVE_INITIAL_ROWS,
  FILED_BACKLOG_INITIAL_ROWS,
  FILED_SHOW_MORE_INCREMENT,
} from '@loki-labs/better-cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { FacetFilter, SegmentedControl, ToggleChip } from '@/components/facet-filter'
import { FILED_PRIORITY_LABEL, FILED_STATUS_LABEL, FiledPriorityChip, FiledStatusPill } from '@/components/filed-task-detail'
import { HostUsageStat } from '@/components/host-usage-stat'
import { useListView } from '@/components/list-view'
import { Pill } from '@/components/pill'
import { ReferenceChip } from '@/components/reference-chip'
import { ReferenceStatusProvider } from '@/components/reference-status'
import { StatusDot } from '@/components/status-dot'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { toast } from '@/components/ui/toaster'
import { AuthorCell, TaskLocationProvider } from '@/components/author-cell'
import {
  RunNodeCell,
  TaskNodeCell,
  useRunNodeRoster,
  useTaskNodeRoster,
  type RunNodeRoster,
  type TaskNodeRoster,
} from '@/components/task-node-cell'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { track } from '@/lib/analytics'
import { deriveAttention } from '@/lib/attention'
import {
  FILED_PRIORITY_VALUES,
  FILED_ROW_PAGE_SIZE,
  FILED_STATUS_VALUES,
  NO_FILED_FILTERS,
  filedFacetCounts,
  filedSelectionState,
  filedStatus,
  filedTaskKey,
  filedTasksExcludingFacet,
  filterFiledTasks,
  parseFiledDetailKey,
  cycleFiledTableSort,
  filedAriaSort,
  selectedFiledEntries,
  setFiledSelection,
  sortFiledTasks,
  toggleFiledSelection,
  type FiledFacetId,
  type FiledSort,
  type FiledStatus,
  type FiledTableSort,
  type FiledTaskFilters,
} from '@/lib/filed-tasks'
import { shortAge } from '@/lib/format'
import {
  contextCell,
  displayWorkflowName,
  formatCost,
  taskReferences,
  usageCells,
  type ContextCell,
  type TaskReference,
  type UsageCell,
} from '@/lib/tasks-table'
import {
  GROUP_BY_OPTIONS,
  NO_FILTERS,
  UNTAGGED,
  allStatuses,
  canReset,
  allWorkflows,
  facetCounts,
  filterGlobalTasks,
  urlStateFromSearchParams,
  urlStateToSearchParams,
  groupGlobalTasks,
  hasActiveFilters,
  inFlightGlobalTasks,
  tagValuesOf,
  tasksExcludingFacet,
  resetCount,
  toGlobalTasks,
  toggleFacetValue,
  toggleGroupBy,
  truncatedProjectNames,
  type FacetId,
  type GlobalTask,
  type GlobalTaskFilters,
  type GlobalTasksUrlState,
  type GroupBy,
} from '@/lib/global-tasks'
import { scopeTo } from '@/lib/project-router'
import { allProjectTags } from '@/lib/project-tags'
import { canBeUnread, isReadDoneItem, isUnread } from '@/lib/read-state'
import { runTitle, type ListView } from '@/lib/task-groups'
import { usageMetricVisibility } from '@/lib/token-metrics'
import { useIsDesktop } from '@/lib/use-desktop'
import { useNow } from '@/lib/use-now'
import { cn } from '@/lib/utils'

/**
 * The global Tasks page at `/tasks` — every registered project's work in one table.
 *
 * It is deliberately NOT under `/p/:projectId`, for the same reason `/settings/global` is not:
 * "all projects" scoped to one project is a contradiction. That also decides its data. The page
 * reads the workspace-level cross-project index (`GET /api/v1/workspace/runs-index`) — one
 * request for the whole registry — rather than N per-project run lists, which would ship a full
 * `RunRecord` (`steps[]` and all) per run times the registry to paint a title and a dot.
 *
 * The trade that buys: the index is a slim row and a capped one, and it names any project the cap
 * bit rather than presenting a short list as a complete one. It is not stale, though: the one
 * `/workspace/events` stream carries every project's run news, and any of it invalidates this
 * index (`global-events.tsx`) — the interval below is the backstop for what a stream cannot
 * promise, not the mechanism.
 *
 * **Filters and grouping live in the URL** (`?q=&tag=&status=&workflow=&group=`), which makes a
 * filtered view survive a refresh, paste into a colleague's chat, and sit in a bookmark. The URL
 * is the state rather than a mirror of it — there is no second copy to drift — and every write is
 * a `replace`, so Back leaves the page instead of undoing one chip at a time.
 *
 * The Active/Archived split is in there too, as `archived=1` present-or-absent: Active is the
 * default and the common case, so a normal link carries no key for it. The shared
 * `useListView()` context still exists and this page publishes to it, so walking from an
 * archived view into a project keeps answering the same question — but here the URL is the
 * authority and the context follows, not the reverse.
 *
 * Presentational logic lives in `lib/global-tasks.ts`; what is here is markup, the router and the
 * local filter state.
 */

/** How often the page re-reads the cross-project index ON TOP of the stream's invalidations —
 *  the cover for a dropped socket, a frozen tab, or a run that ended while the connection was
 *  down. Slow enough that a forty-project workspace is not re-scanned every few seconds. */
const RUNS_INDEX_POLL_MS = 15_000

/** How long the search box waits before writing the URL. Long enough that a typed word is one
 *  history write rather than eight, short enough that a paste-and-share feels immediate. */
const QUERY_DEBOUNCE_MS = 250

/** How many reference chips a row paints before the rest collapse into a `+N`.
 *
 *  ONE. Two fit on a line but cost ~90px of a column that Task wants more, and nothing is lost
 *  by folding the rest: the `+N` opens on HOVER and lists every reference as a real link, so the
 *  second one is a pointer-move away rather than a click. The strongest reference — the PR a task
 *  created, else the one it is about, else its issue — is the one worth the row's own space. */
const MAX_VISIBLE_REFERENCES = 1

/** How long the `+N` list survives the pointer leaving it. The trigger and the list are separate
 *  elements with a gap between them, so closing instantly would make the list unreachable. */
const HOVER_CLOSE_DELAY_MS = 220

/** What "finished" means for the archive affordance — outcomes, not gates. A `review` run still
 *  wants a human, so it is not swept away, exactly as the per-project broom decides it. */
const ARCHIVABLE_STATUSES: ReadonlySet<string> = new Set(['done', 'failed', 'cancelled'])

/** Archive (or restore) one indexed run, in its own project. */
function useArchiveIndexedRun() {
  return useIndexedRunMutation({
    request: ({ task, archived }: { task: GlobalTask; archived: boolean }) =>
      archiveProjectRun(task.run.projectId, task.run.id, archived),
    patch: ({ archived }) => (run) => ({ ...run, archived }),
  })
}

/**
 * Mark one indexed run read or unread — the same cross-project shape as the archive above.
 *
 * The receipt matters more here than anywhere else: this page is where you notice that something
 * finished while you were not looking, and "I have dealt with that one" needs somewhere to go
 * that is not archiving it. Reading a thread already stamps it; this is the manual half, and its
 * inverse (#775) is what makes an accidental stamp recoverable.
 */
function useReadIndexedRun() {
  return useIndexedRunMutation({
    request: ({ task, read }: { task: GlobalTask; read: boolean }) =>
      setProjectRunRead(task.run.projectId, task.run.id, read),
    patch:
      ({ read }) =>
      (run) => {
        if (read) return { ...run, seenAt: new Date().toISOString() }
        // Cleared as a rest-destructure, not `seenAt: undefined`: the reader is `isUnread`, which
        // keys on the field being ABSENT, and the server never writes an explicit undefined.
        const { seenAt: _dropped, ...rest } = run
        return rest
      },
  })
}

/**
 * The shape both row actions share: act on a run in ITS OWN project, move the row optimistically
 * so the click lands immediately, reconcile afterwards, and roll back with the server's reason if
 * it refused.
 *
 * Two things are cross-project rather than scoped, and both follow from standing outside every
 * `/p/:projectId`: the request names the project explicitly (`queryScope()` would answer with the
 * BOOT project, so an action on another project's row would 404 or — with a colliding id — land
 * on the wrong task), and the cache patched is the workspace index rather than the project's own
 * run list, which may not even be loaded here.
 */
function useIndexedRunMutation<V extends { task: GlobalTask }>({
  request,
  patch,
}: {
  request: (variables: V) => Promise<unknown>
  patch: (variables: V) => (run: RunIndexEntry) => RunIndexEntry
}) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: request,
    onMutate: async (variables: V) => {
      await queryClient.cancelQueries({ queryKey: workspaceQueryKeys.runsIndex })
      const previous = queryClient.getQueryData<RunsIndexResponse>(workspaceQueryKeys.runsIndex)
      const apply = patch(variables)
      const { task } = variables
      queryClient.setQueryData<RunsIndexResponse>(workspaceQueryKeys.runsIndex, (current) =>
        current === undefined
          ? current
          : {
              ...current,
              runs: current.runs.map((run) =>
                run.projectId === task.run.projectId && run.id === task.run.id ? apply(run) : run,
              ),
            },
      )
      return { previous }
    },
    onError: (error: Error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(workspaceQueryKeys.runsIndex, context.previous)
      }
      toast(error.message, { tone: 'danger' })
    },
    onSettled: (_data, _error, { task }) => {
      void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.runsIndex })
      // The run's own project may be the active scope (its list is `queryKeys.runs.all`) or a
      // sidebar group's explicit key — invalidate both spellings so neither shows a row this
      // page has just changed.
      void queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
      void queryClient.invalidateQueries({ queryKey: [task.run.projectId, 'runs', 'list'] })
    },
  })
}

export function GlobalTasksRoute() {
  const projects = useProjects()
  // The same host gate the per-project table honours: `CEZ_HIDE_COST` and friends turn these
  // columns off everywhere, and a cross-project view is not an exception.
  const metrics = usageMetricVisibility(useHealth().data)
  // Always enabled here — unlike the ⌘K palette, which parks it in a single-project workspace:
  // this page IS the index, so there is nothing else for it to fall back to. The interval is this
  // page's alone (see `useRunsIndex`), and it is now a BACKSTOP rather than the mechanism: any
  // project's run event invalidates this index through the one workspace stream, so a task that
  // is renamed or finishes while you watch updates on its own.
  const index = useRunsIndex(true, RUNS_INDEX_POLL_MS)
  // The URL is the state, not a mirror of it: read here, written by the setters below. One
  // source of truth means a refresh, a pasted link and the Back button all land on the same
  // filtered view, with no effect syncing two copies that can disagree.
  const [searchParams, setSearchParams] = useSearchParams()
  // The board's own `location.search` carries the exact filtered view into Filed detail links.
  const location = useLocation()
  const { filters, groupBy, view, filedFilters, filedSort, filedActiveSort, filedBacklogSort, filedDetail } = React.useMemo(
    () => urlStateFromSearchParams(searchParams),
    [searchParams],
  )
  // …and the Active/Archived split is published to the SHARED filter context, one way. That
  // context is what keeps this page, the per-project table and the sidebar quick-list answering
  // one question; here the URL is the authority, so the context follows it rather than the other
  // way round. Nothing else on this route can change it — the multi-project sidebar's groups
  // only READ the view — so there is no loop to break.
  const [sharedView, setSharedView] = useListView()
  React.useEffect(() => {
    if (sharedView !== view) setSharedView(view)
  }, [view, sharedView, setSharedView])
  const now = useNow(30_000)
  // "Which worker is processing this?" for the RUNS side of the page (`.ai/specs/2026-08-22-
  // multi-node-cezar-cluster.md`) — one roster fetch for both the pinned Running section and the
  // table below, same reasoning `FiledTasks`' own `nodeRoster` gives for the Filed section: a
  // single fetch, `.clusterOn` gating the column/cell everywhere it is threaded.
  const runNodeRoster = useRunNodeRoster(now)

  /**
   * `replace`, always: filtering is one continuous gesture, and a history entry per click would
   * turn Back into "undo one chip" instead of "leave this page".
   *
   * The whole state is re-decoded from the params INSIDE the updater rather than read from this
   * render's closure, so two changes landing in one tick compose instead of the second silently
   * reverting the first.
   */
  const commit = (next: (current: GlobalTasksUrlState) => GlobalTasksUrlState) =>
    setSearchParams((current) => urlStateToSearchParams(next(urlStateFromSearchParams(current))), {
      replace: true,
    })
  const setFilters = (next: (current: GlobalTaskFilters) => GlobalTaskFilters) =>
    commit((state) => ({ ...state, filters: next(state.filters) }))
  const setGroupBy = (groupBy: GroupBy) => commit((state) => ({ ...state, groupBy }))
  const setView = (nextView: ListView) => commit((state) => ({ ...state, view: nextView }))
  const setFiledFilters = (next: (current: FiledTaskFilters) => FiledTaskFilters) =>
    commit((state) => ({ ...state, filedFilters: next(state.filedFilters) }))
  const setFiledSort = (nextSort: FiledSort) => commit((state) => ({ ...state, filedSort: nextSort }))
  // One setter per table. A sort change in Active is not a state change in Backlog — which is why
  // they are two URL keys and two setters rather than one shared `filedSort` with a partition
  // argument, and why expanding one table cannot reset the other's row count.
  const setFiledActiveSort = (nextSort: FiledTableSort) =>
    commit((state) => ({ ...state, filedActiveSort: nextSort }))
  const setFiledBacklogSort = (nextSort: FiledTableSort) =>
    commit((state) => ({ ...state, filedBacklogSort: nextSort }))

  /**
   * The search box types locally and reaches the URL on a delay.
   *
   * Every other control writes the URL on the click that changed it, which is exactly right for
   * a discrete gesture. A text field is not discrete: writing per keystroke means a
   * `history.replaceState` per keystroke, and browsers rate-limit that (Safari drops calls past
   * ~100 in 30s) — so a fast typist's URL would silently stop tracking the box.
   *
   * The guard is what keeps two copies of one string honest: the URL is adopted back into the
   * draft only when it changed for a reason that is NOT this input — Back, a pasted link, Clear
   * filters — never when it is simply catching up to what was typed. Without it, a flush landing
   * mid-word would overwrite the characters typed since.
   */
  const [queryDraft, setQueryDraft] = React.useState(filters.query)
  const sentQuery = React.useRef(filters.query)
  React.useEffect(() => {
    if (filters.query !== sentQuery.current) setQueryDraft(filters.query)
    sentQuery.current = filters.query
  }, [filters.query])
  React.useEffect(() => {
    if (queryDraft === sentQuery.current) return
    const timer = setTimeout(() => {
      sentQuery.current = queryDraft
      setFilters((current) => ({ ...current, query: queryDraft }))
    }, QUERY_DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // `setFilters` is re-created every render (it closes over `setSearchParams` only, which is
    // stable) — depending on it would restart the timer on every render and never fire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryDraft])

  // Statuses the server already had, riding along with the rows that carry the references — so
  // the chips are coloured in the SAME paint as the table rather than a round trip later. Cold
  // references are simply absent here; `ReferenceStatusProvider` below still asks for those.
  const indexedStatuses = index.data?.referenceStatuses
  React.useEffect(() => {
    if (indexedStatuses) rememberReferenceStatuses(indexedStatuses)
  }, [indexedStatuses])
  const registry = React.useMemo(() => projects.data?.projects ?? [], [projects.data])
  const tasks = React.useMemo(
    () => toGlobalTasks(index.data?.runs ?? [], registry),
    [index.data, registry],
  )
  const visible = React.useMemo(
    () => filterGlobalTasks(tasks, filters, view),
    [tasks, filters, view],
  )
  /**
   * The page splits in two (`.ai/specs/2026-08-19-tasks-page-and-start-grounding.md`, D1): work in
   * flight is LIFTED into the Running section at the top, and the grouped table below holds
   * everything else.
   *
   * Lifted, not copied. The first cut of this rendered running rows in both places, on the theory
   * that the table below should stay the complete record — and 39 DOM tests went red with "found
   * multiple elements", which is the machine saying out loud what a reader would have hit: the
   * same task, twice, on one screen. The header's `N of M` still counts `visible`, and it is still
   * honest, because every one of those rows is on the page — once.
   *
   * A consequence worth naming: with `groupBy: 'status'` there is no longer a `running` group
   * below. That is the intent, not a casualty — the whole point of pinning is that live work is
   * not scattered across group boxes.
   */
  const running = React.useMemo(() => inFlightGlobalTasks(visible, view, groupBy), [visible, view, groupBy])
  const settled = React.useMemo(() => {
    if (running.length === 0) return visible
    const lifted = new Set<GlobalTask>(running)
    return visible.filter((task) => !lifted.has(task))
  }, [visible, running])
  const groups = React.useMemo(() => groupGlobalTasks(settled, groupBy), [settled, groupBy])
  /**
   * Every tracker reference on screen, asked about ONCE.
   *
   * Collected here rather than per row for the obvious reason — a row-level hook would be a
   * request per chip, and this page routinely paints hundreds — and for a less obvious one: the
   * batching is per PROJECT, and only this level can see that forty rows belong to six repos.
   * A row that arrives after the cap, or whose forge is unreachable, keeps the neutral chip it
   * had before statuses existed.
   */
  const referenceRequests = React.useMemo(
    () =>
      visible.flatMap((task) =>
        taskReferences(task.run, task.project?.repoUrl).map((reference) => ({
          projectId: task.run.projectId,
          kind: reference.kind,
          number: reference.number,
        })),
      ),
    [visible],
  )
  const truncated = truncatedProjectNames(index.data?.truncated ?? [], registry)

  const toggle = (facet: FacetId, value: string) =>
    setFilters((current) => ({ ...current, [facet]: toggleFacetValue(current[facet], value) }))
  const clearFacet = (facet: FacetId) => setFilters((current) => ({ ...current, [facet]: [] }))
  // Where each task lives, for the Author column's parent link. Built from the rows this page
  // already loaded, because a run id alone does not say which project holds it — see
  // `TaskLocationProvider`'s doc comment. A parent that is not on the board (archived away,
  // beyond the per-project limit) simply resolves to `undefined` and renders unlinked.
  const locateTask = React.useMemo(() => {
    const byId = new Map(tasks.map((t) => [t.run.id, t.run.projectId]))
    return (taskId: string) => {
      const projectId = byId.get(taskId)
      return projectId ? scopeTo(projectId, `/tasks/${taskId}`) : undefined
    }
  }, [tasks])

  const archive = useArchiveIndexedRun()
  const setRead = useReadIndexedRun()

  if (index.isError || projects.isError) {
    return (
      <div data-route="global-tasks" className="flex min-h-full flex-col">
        <CenteredState
          icon={<LayersIcon />}
          tone="danger"
          title="Tasks across projects did not load"
          subtitle={(index.error ?? projects.error)?.message}
        />
      </div>
    )
  }

  const search = (
    <div className="relative w-full md:w-60">
      <SearchIcon
        className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-soft-foreground"
        aria-hidden="true"
      />
      <input
        type="text"
        value={queryDraft}
        onChange={(event) => setQueryDraft(event.target.value)}
        placeholder="Search every project…"
        aria-label="Search tasks across projects"
        className="h-9 w-full rounded-md border border-input bg-card pr-3 pl-8 text-[13px] text-foreground outline-none placeholder:text-soft-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
      />
    </div>
  )

  return (
    <TaskLocationProvider locate={locateTask}>
    <div data-route="global-tasks" className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 hidden h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-5 md:flex">
        <h1 className="text-base font-semibold">All tasks</h1>
        <div className="inline-flex gap-0.5 rounded-md bg-muted p-[3px]">
          <ViewTab view="active" current={view} onSelect={setView}>
            Active
          </ViewTab>
          <ViewTab view="archived" current={view} onSelect={setView}>
            Archived
          </ViewTab>
        </div>
        <div className="flex-1" />
        <HostUsageStat />
        <span data-slot="global-tasks-count" className="text-[12.5px] text-soft-foreground tabular-nums">
          {visible.length} of {tasks.length}
        </span>
        {search}
      </header>

      <div className="flex flex-1 flex-col gap-3 p-3 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-5 md:pb-5">
        {/* Below `md` the header above is hidden, so the search box rides here instead. */}
        <div className="md:hidden">{search}</div>

        <FilterBar
          filters={filters}
          onToggle={toggle}
          onClearFacet={clearFacet}
          onClearAll={() => {
            setQueryDraft('')
            // Filters AND grouping — "Clear" is the one way back to a plain list.
            commit((state) => ({ ...state, filters: NO_FILTERS, groupBy: 'none' }))
          }}
          groupBy={groupBy}
          onGroupByChange={setGroupBy}
          projects={registry}
          tasks={tasks}
          view={view}
        />

        {truncated.length > 0 ? (
          <p data-slot="global-tasks-truncated" className="text-[11.5px] text-soft-foreground">
            Showing the newest {index.data?.perProjectLimit} tasks per project — older ones in{' '}
            {truncated.join(', ')} are only in that project&rsquo;s own Tasks page.
          </p>
        ) : null}

        {/* One provider over every section that paints a reference chip. It has to sit ABOVE the
            Running section, not only around the grouped list: the chips are painted from context,
            so a section rendered outside it shows neutral chips forever while the identical row
            below it is coloured — which is what the first cut of this shipped, and what three
            reference-chip cases caught. Filed carries no chips and is simply inside it. */}
        <ReferenceStatusProvider requests={referenceRequests}>
        {/* Work in flight, pinned to the top (2026-08-19-tasks-page-and-start-grounding.md, D1).
            LIFTED out of the list below rather than duplicated into a second copy — see the
            `settled` memo above for why that was the wrong first answer. */}
        <RunningTasks
          tasks={running}
          now={now}
          onArchive={(task, archived) => archive.mutate({ task, archived })}
          onSetRead={(task, read) => setRead.mutate({ task, read })}
          busy={archive.isPending || setRead.isPending}
          showCost={metrics.cost}
          runNodeRoster={runNodeRoster}
        />

        {/* Filed work — table, statuses, detail dialog, archive (2026-08-17-filed-tasks-table-
            statuses.md).

            **Superseded 2026-08-19 by 2026-08-19-tasks-page-and-start-grounding.md (D1):** Filed
            is no longer the top of the page. The original reasoning is kept below because it is
            still true about Filed vs. the RUNS TABLE — it is only wrong about Filed vs. work in
            flight, which now has its own section above this one. What changed is scale: the
            argument was written when Filed was a short list, and after the 2026-08-17 migration
            it is 49 active rows with its own controls row, so a running task sat below a
            screenful of backlog.

            ~~Above the runs (2026-08-15): this page is where a user looks after filing something
            — it is called Tasks — and answering with runs only made a fan-out that had written
            twelve tasks look identical to one that had done nothing.~~

            Renders on BOTH tabs now (it used to be Active-only): Active shows open filed work,
            Archived shows archived-or-done filed work, the same split the runs table below it
            uses for its own rows. */}
        <FiledTasks
          view={view}
          query={filters.query}
          filedFilters={filedFilters}
          filedSort={filedSort}
          filedDetail={filedDetail}
          onCloseDetail={() => commit((state) => ({ ...state, filedDetail: undefined }))}
          search={location.search}
          filedActiveSort={filedActiveSort}
          filedBacklogSort={filedBacklogSort}
          onToggleFacet={(facet, value) =>
            setFiledFilters((current) => ({ ...current, [facet]: toggleFacetValue(current[facet], value) }))
          }
          onClearFacet={(facet) => setFiledFilters((current) => ({ ...current, [facet]: [] }))}
          onSortChange={setFiledSort}
          onActiveSortChange={setFiledActiveSort}
          onBacklogSortChange={setFiledBacklogSort}
        />

        {/* The empty state keys on `visible`, not on `settled`: a page whose only rows are in the
            Running section is not empty, and telling the reader "nothing here" over a table of
            live work would be plainly false. */}
        {index.data === undefined ? null : visible.length === 0 ? (
          <GlobalTasksEmptyState view={view} filtered={hasActiveFilters(filters)} />
        ) : (
          // No `projectId` on the provider, uniquely on this page: every chip under it names its
          // own, because the rows next to each other belong to different repositories.
          //
          // It wraps the Running section too, and must: the chips are painted by context, so a
          // section rendered OUTSIDE this provider gets neutral chips forever while the identical
          // row below it is coloured — which is exactly what the first cut shipped, and what
          // three reference-chip cases caught.
          <>{groups.map((group) => (
              <section key={group.key} data-slot="task-group" data-group-key={group.key}>
                {groupBy === 'none' ? null : (
                  <h2 className="mb-1.5 flex items-center gap-2 text-[12px] font-semibold tracking-[0.04em] text-soft-foreground uppercase">
                    {/* A project heading is a DOOR, not a label: that project's own Tasks page is
                        the better version of "just this project" (live SSE, the full column set,
                        the composer), which is why there is no project filter here at all. */}
                    {groupBy === 'project' ? (
                      <Link
                        to={scopeTo(group.key, '/')}
                        data-slot="group-project-link"
                        className="hover:text-foreground hover:underline"
                      >
                        {group.label}
                      </Link>
                    ) : (
                      group.label
                    )}
                    <span className="font-mono text-[11px] font-medium tabular-nums">
                      {group.tasks.length}
                    </span>
                  </h2>
                )}
                <TaskTable
                  tasks={group.tasks}
                  now={now}
                  showProject={groupBy !== 'project'}
                  onArchive={(task, archived) => archive.mutate({ task, archived })}
                  onSetRead={(task, read) => setRead.mutate({ task, read })}
                  busy={archive.isPending || setRead.isPending}
                  showCost={metrics.cost}
                  runNodeRoster={runNodeRoster}
                />
              </section>
            ))}</>
        )}
        </ReferenceStatusProvider>
      </div>
    </div>
    </TaskLocationProvider>
  )
}

/**
 * The "Running" section: work in flight, pinned to the top of the page
 * (`.ai/specs/2026-08-19-tasks-page-and-start-grounding.md`, D1).
 *
 * Reuses `TaskTable` outright rather than growing a second row grammar. There is one visual
 * difference from the table below and it is the point of the section, not decoration: `showProject`
 * is always on here, because these rows are read as a set ("what is my machine doing right now?")
 * across repositories, whereas the table below may already be grouped by project.
 *
 * Renders NOTHING for an empty list — which covers both "nothing is running" and the Archived tab,
 * because `inFlightGlobalTasks` (the caller's one source for this set) answers `[]` for archived
 * by construction. No second condition here means no second place for "is anything running?" to
 * be answered differently.
 *
 * Presentational: the caller passes the rows, already filtered and lifted out of the table below,
 * so the two lists cannot disagree about which rows this section owns.
 */
function RunningTasks({
  tasks,
  now,
  onArchive,
  onSetRead,
  busy,
  showCost,
  runNodeRoster,
}: {
  tasks: readonly GlobalTask[]
  now: number
  onArchive: (task: GlobalTask, archived: boolean) => void
  onSetRead: (task: GlobalTask, read: boolean) => void
  busy: boolean
  showCost: boolean
  runNodeRoster: RunNodeRoster
}) {
  if (tasks.length === 0) return null

  return (
    <section data-slot="running-tasks">
      <h2 className="mb-1.5 flex items-center gap-2 text-[12px] font-semibold tracking-[0.04em] text-soft-foreground uppercase">
        Running
        <span data-slot="running-tasks-count" className="font-mono text-[11px] font-medium tabular-nums">
          {tasks.length}
        </span>
      </h2>
      <TaskTable
        tasks={tasks}
        now={now}
        showProject
        onArchive={onArchive}
        onSetRead={onSetRead}
        busy={busy}
        showCost={showCost}
        runNodeRoster={runNodeRoster}
      />
    </section>
  )
}

// `FILED_STATUS_LABEL`/`FILED_PRIORITY_LABEL` and the `FiledStatusPill`/`FiledPriorityChip` that
// paint them moved to `@/components/filed-task-detail` (`.ai/specs/2026-08-29-filed-task-detail-
// page.md`, Phase 1): the standalone task detail page needs the same pill/chip the filter controls
// below read labels from, so both live in the one shared module rather than drifting apart.

const FILED_SORT_OPTIONS: readonly { value: FiledSort; label: string }[] = [
  { value: 'created-desc', label: 'Newest' },
  { value: 'created-asc', label: 'Oldest' },
]

/**
 * The "Filed" section: a real table now (2026-08-17-filed-tasks-table-statuses.md) of tasks that
 * exist on the board but have never run — status pill, title (a link to the task's own detail
 * page, `.ai/specs/2026-08-29-filed-task-detail-page.md`), project, priority, age, and
 * Start/Archive per row.
 *
 * **Why it is here at all.** The composer's All / Auto submit writes todos across projects and
 * starts nothing (D5, `.ai/specs/2026-08-15-knowledge-grounded-task-fanout.md`). Before this,
 * those todos had no reachable surface anywhere in the cockpit: this page and `/workspace/tasks`
 * both list runs, and `/inbox` is hidden from the nav — and tells you the inbox is off — unless
 * `CEZ_FOLLOWUPS=1`. So filing worked, and looked identical to filing failing.
 *
 * **Deliberately ungated.** No `capabilities.followups` / `workspaceViews` check: those flags are
 * off on a default install, and gating the read here would put the bug straight back. D7a already
 * drew this line on the server; `useWorkspaceTodos` carries it to the client.
 *
 * **Renders on BOTH tabs now** (it used to be Active-only): `view` is the SAME Active/Archived
 * split the page and the runs table below it already read, so this section answers the one
 * question the tab asks rather than needing a tab of its own. Renders nothing at all when there
 * is nothing filed for the CURRENT view (before facet/query narrowing) — a permanent section
 * header advertising a feature most workspaces never use would be worse than silence; once
 * something is filed, a search/filter that narrows it to zero still shows the section with an
 * inline "no match" message, since the section itself is not what emptied it.
 */
function FiledTasks({
  view,
  query,
  filedFilters,
  filedSort,
  filedDetail,
  onCloseDetail,
  search,
  filedActiveSort,
  filedBacklogSort,
  onToggleFacet,
  onClearFacet,
  onSortChange,
  onActiveSortChange,
  onBacklogSortChange,
}: {
  view: ListView
  /** The page's own search box (`?q=`) — one box narrows both the runs table and this one. */
  query: string
  filedFilters: FiledTaskFilters
  filedSort: FiledSort
  filedDetail: string | undefined
  onCloseDetail: () => void
  /** The board's own `location.search` — carried onto every title link's history state
   *  (Risk 1), so the detail page's back link can restore this exact filtered view. */
  search: string
  filedActiveSort: FiledTableSort
  filedBacklogSort: FiledTableSort
  onToggleFacet: (facet: FiledFacetId, value: string) => void
  onClearFacet: (facet: FiledFacetId) => void
  onSortChange: (sort: FiledSort) => void
  onActiveSortChange: (sort: FiledTableSort) => void
  onBacklogSortChange: (sort: FiledTableSort) => void
}) {
  const todos = useWorkspaceTodos()
  const nodeRoster = useTaskNodeRoster()
  const start = useStartFiledTask()
  const update = useUpdateFiledTodo()
  const requested = React.useMemo(() => parseFiledDetailKey(filedDetail), [filedDetail])
  const detail = React.useMemo(
    () => (requested ? (todos.data?.todos ?? []).find((entry) => entry.project === requested.project && entry.todo.id === requested.todoId) ?? null : null),
    [requested, todos.data],
  )
  const deepLink = filedDetail !== undefined
  const detailSurface = todos.data !== undefined && deepLink && detail === null ? (
    <section data-slot="filed-task-detail-missing" className="rounded-lg border border-border bg-card p-3 text-[12.5px] text-soft-foreground">
      That task is no longer on this board.
    </section>
  ) : (
    <FiledDetailDialog
      entry={detail}
      nodeRoster={nodeRoster}
      onClose={onCloseDetail}
      onStart={(entry) => start.mutate({ projectId: entry.project, todoId: entry.todo.id })}
      onArchive={(entry, archived) => update.mutate({ entry, patch: { archived } })}
      startPending={start.isPending}
      archivePending={update.isPending}
    />
  )
  // The two splits COMPOSE (D1): the tab asks "has this left the live board", the Active/Backlog
  // partition asks "is it in flight or waiting". Only the live board is partitioned — an archived
  // `todo`-status row is dismissed work, not backlog, and a `done` row is neither.
  if (view === 'archived') {
    return (
      <>
        <FiledArchivedSection
          view={view}
          query={query}
          filedFilters={filedFilters}
          filedSort={filedSort}
          search={search}
          onToggleFacet={onToggleFacet}
          onClearFacet={onClearFacet}
          onSortChange={onSortChange}
        />
        {detailSurface}
      </>
    )
  }
  return (
    <>
      <FiledActiveSection
        query={query}
        filedFilters={filedFilters}
        activeSort={filedActiveSort}
        backlogSort={filedBacklogSort}
        search={search}
        onToggleFacet={onToggleFacet}
        onClearFacet={onClearFacet}
        onActiveSortChange={onActiveSortChange}
        onBacklogSortChange={onBacklogSortChange}
      />
      {detailSurface}
    </>
  )
}

/**
 * The Archived tab's Filed section: **one unsplit table, on the legacy client-side path**, byte
 * for byte what shipped in `2026-08-17-filed-tasks-table-statuses.md`.
 *
 * Left alone on purpose (D1). Partitioning it would be meaningless, and it is the half of the
 * board carrying ~540 migrated rows that the 2026-08-17 production pass signed off on — so the
 * server-paging change keeps its blast radius off it. It still reads `GET /workspace/todos` with
 * no query parameters, which is exactly why that payload had to stay byte-identical.
 */
function FiledArchivedSection({
  view,
  query,
  filedFilters,
  filedSort,
  search,
  onToggleFacet,
  onClearFacet,
  onSortChange,
}: {
  view: ListView
  /** The page's own search box (`?q=`) — one box narrows both the runs table and this one. */
  query: string
  filedFilters: FiledTaskFilters
  filedSort: FiledSort
  /** The board's own `location.search` — carried onto every title link's history state
   *  (Risk 1), so the detail page's back link can restore this exact filtered view. */
  search: string
  onToggleFacet: (facet: FiledFacetId, value: string) => void
  onClearFacet: (facet: FiledFacetId) => void
  onSortChange: (sort: FiledSort) => void
}) {
  const todos = useWorkspaceTodos()
  const start = useStartFiledTask()
  const startMany = useStartFiledTasks()
  const update = useUpdateFiledTodo()
  const now = useNow(30_000)
  const isDesktop = useIsDesktop()
  // "Which worker is processing this?" (2026-08-22-multi-node-cezar-cluster.md). One roster
  // fetch for the whole section — `nodeRoster.clusterOn` gates the Node column/cell everywhere
  // below, so a single-node cockpit never grows a column that is always empty.
  const nodeRoster = useTaskNodeRoster()
  const [shown, setShown] = React.useState(FILED_ROW_PAGE_SIZE)
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(() => new Set())

  const all = todos.data?.todos ?? []
  // Unfiltered-by-facet/query, so the section's own "is there anything filed at all" question and
  // the count badge's denominator both answer against the same set the tab itself defines.
  const viewEntries = React.useMemo(() => filterFiledTasks(all, NO_FILED_FILTERS, view, ''), [all, view])
  const filtered = React.useMemo(
    () => filterFiledTasks(all, filedFilters, view, query),
    [all, filedFilters, view, query],
  )
  const sorted = React.useMemo(() => sortFiledTasks(filtered, filedSort), [filtered, filedSort])

  // One `filedFacetCounts` per facet, counted against the list as filtered by the OTHER facet —
  // the same discipline the runs `FilterBar` above uses, so unticking a value shows how many rows
  // would return rather than a number that already assumes the tick.
  const counts = React.useMemo(() => {
    const per = (except: FiledFacetId, valueOf: (entry: WorkspaceTodoEntry) => string | undefined) =>
      filedFacetCounts(filedTasksExcludingFacet(all, filedFilters, view, query, except), valueOf)
    return {
      statuses: per('statuses', (entry) => filedStatus(entry)),
      priorities: per('priorities', (entry) => entry.todo.priority),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, filedFilters, view, query])

  // A filter/sort/search change re-narrows the set; a stale "300 shown" carried over from a wider
  // set would otherwise dump every row of a brand-new, unrelated filter onto the screen at once.
  React.useEffect(() => {
    setShown(FILED_ROW_PAGE_SIZE)
  }, [view, filedFilters, filedSort, query])

  if (viewEntries.length === 0) return null

  const rows = sorted.slice(0, shown)
  const hasMore = sorted.length > rows.length
  const rowKeys = rows.map(filedTaskKey)
  const selectAllState = filedSelectionState(rowKeys, selected)
  const batch = selectedFiledEntries(rows, selected)
  const clearSelection = () => setSelected(new Set())
  const runSelected = () => {
    if (batch.length === 0 || startMany.isPending) return
    startMany.mutate(batch, { onSettled: () => setSelected(new Set()) })
  }
  const selectRow = (entry: WorkspaceTodoEntry) =>
    setSelected((current) => toggleFiledSelection(current, filedTaskKey(entry)))
  const selectAll = (on: boolean) => setSelected((current) => setFiledSelection(current, rowKeys, on))

  return (
    <section data-slot="filed-tasks" data-view={view}>
      <h2 className="mb-1.5 flex items-center gap-2 text-[12px] font-semibold tracking-[0.04em] text-soft-foreground uppercase">
        Filed
        <span data-slot="filed-tasks-count" className="font-mono text-[11px] font-medium tabular-nums">
          {filtered.length === viewEntries.length
            ? viewEntries.length
            : `${filtered.length} of ${viewEntries.length}`}
        </span>
      </h2>

      <FiledControlsRow
        filedFilters={filedFilters}
        filedSort={filedSort}
        counts={counts}
        onToggleFacet={onToggleFacet}
        onClearFacet={onClearFacet}
        onSortChange={onSortChange}
      />

      {batch.length > 0 ? (
        <div
          data-slot="filed-selection-bar"
          className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 shadow-xs"
        >
          <span data-slot="filed-selection-count" className="text-[12.5px] font-medium">
            {batch.length} selected
          </span>
          <span className="flex-1" aria-hidden="true" />
          <button
            type="button"
            data-action="start-selected-filed-tasks"
            disabled={startMany.isPending}
            onClick={runSelected}
            className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-border px-3 text-[12.5px] font-medium hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-wait disabled:opacity-50"
          >
            <PlayIcon className="size-3.5" aria-hidden="true" />
            {startMany.isPending
              ? 'Starting...'
              : `Run ${batch.length} task${batch.length === 1 ? '' : 's'}`}
          </button>
          <button
            type="button"
            data-action="clear-filed-selection"
            onClick={clearSelection}
            className="inline-flex min-h-8 items-center rounded-md px-2.5 text-[12.5px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            Clear
          </button>
        </div>
      ) : null}

      {filtered.length === 0 ? (
        <p data-slot="filed-tasks-empty" className="mt-2 text-[12.5px] text-soft-foreground">
          No filed tasks match these filters.
        </p>
      ) : !isDesktop ? (
        // Below `md` the six-column filed table sideways-scrolls, so its rows render as cards.
        // `useIsDesktop` (not a CSS pair) keeps exactly one copy in the DOM — see `TaskTable`.
        <div data-slot="filed-tasks-cards" className="mt-2 flex flex-col gap-2.5">
          {rows.map((entry) => (
            <FiledCard
              key={`${entry.project}:${entry.todo.id}`}
              entry={entry}
              now={now}
              nodeRoster={nodeRoster}
              search={search}
              onStart={() => start.mutate({ projectId: entry.project, todoId: entry.todo.id })}
              onArchive={(archived) => update.mutate({ entry, patch: { archived } })}
              selected={selected.has(filedTaskKey(entry))}
              onToggleSelect={() => selectRow(entry)}
              startBusy={start.isPending}
              archiveBusy={update.isPending}
            />
          ))}
          {hasMore ? (
            <button
              type="button"
              data-action="filed-tasks-show-more"
              onClick={() => setShown((current) => current + FILED_ROW_PAGE_SIZE)}
              className="self-center rounded-md px-3 py-2.5 text-[12.5px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Show {Math.min(FILED_ROW_PAGE_SIZE, sorted.length - rows.length)} more
            </button>
          ) : null}
        </div>
      ) : (
        <div
          data-slot="filed-tasks-table"
          className="mt-2 overflow-x-auto rounded-lg border border-border bg-card shadow-xs"
        >
          <TooltipProvider>
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th className="w-[40px]">
                    <SelectAllCheckbox
                      state={selectAllState}
                      onChange={selectAll}
                      label="Select every filed task shown"
                    />
                  </Th>
                  <Th className="w-[104px]">Status</Th>
                  <Th>Task</Th>
                  <Th className="w-[124px]">Project</Th>
                  <Th className="hidden w-[104px] lg:table-cell">Author</Th>
                  {nodeRoster.clusterOn ? <Th className="hidden w-[110px] xl:table-cell">Node</Th> : null}
                  <Th className="w-[84px]">Priority</Th>
                  <Th className="w-[64px] text-right">Age</Th>
                  <Th className="w-[64px] text-right">
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </thead>
              <tbody className="[&>tr:last-child>td]:border-b-0">
                {rows.map((entry) => (
                  <FiledRow
                    key={`${entry.project}:${entry.todo.id}`}
                    entry={entry}
                    now={now}
                    nodeRoster={nodeRoster}
                    search={search}
                    onStart={() => start.mutate({ projectId: entry.project, todoId: entry.todo.id })}
                    onArchive={(archived) => update.mutate({ entry, patch: { archived } })}
                    selected={selected.has(filedTaskKey(entry))}
                    onToggleSelect={() => selectRow(entry)}
                    startBusy={start.isPending}
                    archiveBusy={update.isPending}
                  />
                ))}
              </tbody>
            </table>
          </TooltipProvider>
          {hasMore ? (
            <div className="flex justify-center border-t border-border p-2">
              <button
                type="button"
                data-action="filed-tasks-show-more"
                onClick={() => setShown((current) => current + FILED_ROW_PAGE_SIZE)}
                className="rounded-md px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                Show {Math.min(FILED_ROW_PAGE_SIZE, sorted.length - rows.length)} more
              </button>
            </div>
          ) : null}
        </div>
      )}
    </section>
  )
}

/**
 * The Active tab's Filed section: **two tables, server-ordered and server-paged**
 * (`.ai/specs/2026-08-25-split-active-backlog-tables.md`).
 *
 * **Active above Backlog**, 20 rows and 30 rows to start, each with its own Show more (+10
 * exactly) and its own per-column sort. `Backlog` here is a table of `status: 'todo'` rows; it is
 * NOT the `/new` composer's Backlog submit mode (`data-slot="mode-backlog"`), which is a related
 * but different object — hence every slot below is namespaced `filed-`.
 *
 * **Two requests, not one.** That is what makes "expansion preserves status partitions"
 * structural rather than merely tested: each partition has its own React Query key, so expanding
 * Active mutates only the Active key and the Backlog request is never re-issued. A single request
 * carrying both partitions would leave the same property resting on the determinism of the
 * ordering alone, and a regression there would silently reshuffle the table nobody touched.
 *
 * **One controls row for both tables.** The page has one search box by design, and per-table
 * facets would let a reader put the two halves of one board into contradictory states. The chips'
 * counts are the two responses' `counts` summed — the server computes each with its own facet
 * lifted, so unticking a value still shows what would come back.
 */
function FiledActiveSection({
  query,
  filedFilters,
  activeSort,
  backlogSort,
  search,
  onToggleFacet,
  onClearFacet,
  onActiveSortChange,
  onBacklogSortChange,
}: {
  query: string
  filedFilters: FiledTaskFilters
  activeSort: FiledTableSort
  backlogSort: FiledTableSort
  /** The board's own `location.search` — carried onto every title link's history state
   *  (Risk 1), so the detail page's back link can restore this exact filtered view. */
  search: string
  onToggleFacet: (facet: FiledFacetId, value: string) => void
  onClearFacet: (facet: FiledFacetId) => void
  onActiveSortChange: (sort: FiledTableSort) => void
  onBacklogSortChange: (sort: FiledTableSort) => void
}) {
  const start = useStartFiledTask()
  const startMany = useStartFiledTasks()
  const update = useUpdateFiledTodo()
  const now = useNow(30_000)
  const isDesktop = useIsDesktop()
  const nodeRoster = useTaskNodeRoster()
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(() => new Set())
  const [activeLimit, setActiveLimit] = React.useState(FILED_ACTIVE_INITIAL_ROWS)
  const [backlogLimit, setBacklogLimit] = React.useState(FILED_BACKLOG_INITIAL_ROWS)

  const statuses = filedFilters.statuses
  const priorities = filedFilters.priorities
  const activeQuery = useWorkspaceTodoPage({
    partition: 'active',
    view: 'active',
    sort: activeSort.column,
    dir: activeSort.dir,
    limit: activeLimit,
    status: statuses,
    priority: priorities,
    q: query,
  })
  const backlogQuery = useWorkspaceTodoPage({
    partition: 'backlog',
    view: 'active',
    sort: backlogSort.column,
    dir: backlogSort.dir,
    limit: backlogLimit,
    status: statuses,
    priority: priorities,
    q: query,
  })

  // A narrowing change re-scopes both tables, so both row counts go back to their own initial
  // value — a stale "50 shown" carried over from a wider set would dump every row of a brand-new
  // filter onto the screen at once (the same reasoning the single-table reset carried).
  //
  // **The deps are PRIMITIVES, deliberately.** The URL state object is rebuilt whenever any query
  // param changes, so depending on `filedFilters` or on the sort OBJECT would make a Backlog
  // re-sort reset the Active table's row count — the exact cross-table coupling this split exists
  // to remove. Each table depends on the narrowing inputs plus ITS OWN sort, spelled as strings.
  const facetKey = `${[...statuses].sort().join(',')}|${[...priorities].sort().join(',')}|${query}`
  React.useEffect(() => {
    setActiveLimit(FILED_ACTIVE_INITIAL_ROWS)
  }, [facetKey, activeSort.column, activeSort.dir])
  React.useEffect(() => {
    setBacklogLimit(FILED_BACKLOG_INITIAL_ROWS)
  }, [facetKey, backlogSort.column, backlogSort.dir])

  const activeRows = activeQuery.data?.todos ?? []
  const backlogRows = backlogQuery.data?.todos ?? []
  const activePage = activeQuery.data?.page
  const backlogPage = backlogQuery.data?.page

  // The section's own "is there anything filed at all" question, and the count badge's
  // denominator, both answer against the partition totals BEFORE facets and search — the same set
  // the tab itself defines.
  const settled = activeQuery.data !== undefined && backlogQuery.data !== undefined
  const viewTotal = (activePage?.partitionTotal ?? 0) + (backlogPage?.partitionTotal ?? 0)
  const matchedTotal = (activePage?.total ?? 0) + (backlogPage?.total ?? 0)

  const counts = React.useMemo(() => {
    const sum = (pick: (source: { statuses: Record<string, number>; priorities: Record<string, number> }) => Record<string, number>) => {
      const merged = new Map<string, number>()
      for (const source of [activeQuery.data?.counts, backlogQuery.data?.counts]) {
        if (source === undefined) continue
        for (const [value, count] of Object.entries(pick(source))) {
          merged.set(value, (merged.get(value) ?? 0) + count)
        }
      }
      return merged
    }
    return { statuses: sum((c) => c.statuses), priorities: sum((c) => c.priorities) }
  }, [activeQuery.data?.counts, backlogQuery.data?.counts])

  // The batch is the RENDERED rows of both tables and nothing wider. On this path there is no
  // wider in-memory array to reach for by accident — `rows` IS the response — which is what makes
  // the 2026-08-24 bulk-start bug (a batch computed from the full sorted list, starting rows the
  // reader could not see) structurally unreachable rather than merely fixed.
  const renderedRows = [...activeRows, ...backlogRows]
  const batch = selectedFiledEntries(renderedRows, selected)
  const clearSelection = () => setSelected(new Set())
  const runSelected = () => {
    if (batch.length === 0 || startMany.isPending) return
    startMany.mutate(batch, { onSettled: () => setSelected(new Set()) })
  }
  const selectRow = (entry: WorkspaceTodoEntry) =>
    setSelected((current) => toggleFiledSelection(current, filedTaskKey(entry)))
  const selectKeys = (keys: readonly string[], on: boolean) =>
    setSelected((current) => setFiledSelection(current, keys, on))

  if (!settled || viewTotal === 0) return null

  const rowProps = {
    now,
    nodeRoster,
    isDesktop,
    selected,
    search,
    onStart: (entry: WorkspaceTodoEntry) => start.mutate({ projectId: entry.project, todoId: entry.todo.id }),
    onArchive: (entry: WorkspaceTodoEntry, archived: boolean) => update.mutate({ entry, patch: { archived } }),
    onToggleSelect: selectRow,
    onSelectKeys: selectKeys,
    startBusy: start.isPending,
    archiveBusy: update.isPending,
  }

  return (
    <section data-slot="filed-tasks" data-view="active">
      <h2 className="mb-1.5 flex items-center gap-2 text-[12px] font-semibold tracking-[0.04em] text-soft-foreground uppercase">
        Filed
        <span data-slot="filed-tasks-count" className="font-mono text-[11px] font-medium tabular-nums">
          {matchedTotal === viewTotal ? viewTotal : `${matchedTotal} of ${viewTotal}`}
        </span>
      </h2>

      <FiledControlsRow
        filedFilters={filedFilters}
        counts={counts}
        onToggleFacet={onToggleFacet}
        onClearFacet={onClearFacet}
      />

      {batch.length > 0 ? (
        <div
          data-slot="filed-selection-bar"
          className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 shadow-xs"
        >
          <span data-slot="filed-selection-count" className="text-[12.5px] font-medium">
            {batch.length} selected
          </span>
          <span className="flex-1" aria-hidden="true" />
          <button
            type="button"
            data-action="start-selected-filed-tasks"
            disabled={startMany.isPending}
            onClick={runSelected}
            className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-border px-3 text-[12.5px] font-medium hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-wait disabled:opacity-50"
          >
            <PlayIcon className="size-3.5" aria-hidden="true" />
            {startMany.isPending ? 'Starting...' : `Run ${batch.length} task${batch.length === 1 ? '' : 's'}`}
          </button>
          <button
            type="button"
            data-action="clear-filed-selection"
            onClick={clearSelection}
            className="inline-flex min-h-8 items-center rounded-md px-2.5 text-[12.5px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            Clear
          </button>
        </div>
      ) : null}

      {matchedTotal === 0 ? (
        <p data-slot="filed-tasks-empty" className="mt-2 text-[12.5px] text-soft-foreground">
          No filed tasks match these filters.
        </p>
      ) : (
        <>
          <FiledPartitionTable
            partition="active"
            heading="Active"
            rows={activeRows}
            page={activePage}
            sort={activeSort}
            onSortChange={onActiveSortChange}
            onShowMore={() => {
              track('todo.filed_show_more', {
                partition: 'active',
                from: activeLimit,
                to: activeLimit + FILED_SHOW_MORE_INCREMENT,
                increment: FILED_SHOW_MORE_INCREMENT,
              })
              setActiveLimit((current) => current + FILED_SHOW_MORE_INCREMENT)
            }}
            {...rowProps}
          />
          <FiledPartitionTable
            partition="backlog"
            heading="Backlog"
            rows={backlogRows}
            page={backlogPage}
            sort={backlogSort}
            onSortChange={onBacklogSortChange}
            onShowMore={() => {
              track('todo.filed_show_more', {
                partition: 'backlog',
                from: backlogLimit,
                to: backlogLimit + FILED_SHOW_MORE_INCREMENT,
                increment: FILED_SHOW_MORE_INCREMENT,
              })
              setBacklogLimit((current) => current + FILED_SHOW_MORE_INCREMENT)
            }}
            {...rowProps}
          />
        </>
      )}
    </section>
  )
}

/** Which columns carry a sortable header, and what each one is called. Order matches the `<th>`
 *  order below, so the table and the URL vocabulary cannot drift apart silently. */
const FILED_COLUMN_LABEL: Record<FiledSortColumn, string> = {
  status: 'Status',
  task: 'Task',
  project: 'Project',
  author: 'Author',
  priority: 'Priority',
  age: 'Age',
}

/**
 * One partition's table, heading and Show more control. Rendered twice by
 * {@link FiledActiveSection} — the row components (`FiledRow`, `FiledCard`) are the ones the
 * single table already used, moved intact rather than rewritten.
 *
 * `rows` IS the server's answer for this partition. There is deliberately no wider array in
 * scope: every "which rows are on screen" question — select-all, the batch, the row keys the
 * expansion assertions compare — can only be answered from what is rendered.
 */
function FiledPartitionTable({
  partition,
  heading,
  rows,
  page,
  sort,
  onSortChange,
  onShowMore,
  now,
  nodeRoster,
  isDesktop,
  selected,
  search,
  onStart,
  onArchive,
  onToggleSelect,
  onSelectKeys,
  startBusy,
  archiveBusy,
}: {
  partition: 'active' | 'backlog'
  heading: string
  rows: readonly WorkspaceTodoEntry[]
  page: WorkspaceTodosPage | undefined
  sort: FiledTableSort
  onSortChange: (sort: FiledTableSort) => void
  onShowMore: () => void
  now: number
  nodeRoster: TaskNodeRoster
  isDesktop: boolean
  selected: ReadonlySet<string>
  /** The board's own `location.search` — carried onto every title link's history state
   *  (Risk 1), so the detail page's back link can restore this exact filtered view. */
  search: string
  onStart: (entry: WorkspaceTodoEntry) => void
  onArchive: (entry: WorkspaceTodoEntry, archived: boolean) => void
  onToggleSelect: (entry: WorkspaceTodoEntry) => void
  onSelectKeys: (keys: readonly string[], on: boolean) => void
  startBusy: boolean
  archiveBusy: boolean
}) {
  const rowKeys = rows.map(filedTaskKey)
  const selectAllState = filedSelectionState(rowKeys, selected)
  const hasMore = page?.hasMore ?? false
  const remaining = Math.max(0, (page?.total ?? 0) - rows.length)
  const showMoreCount = Math.min(FILED_SHOW_MORE_INCREMENT, remaining)
  const sortable = (column: FiledSortColumn) => ({
    sortColumn: column,
    sort,
    onSort: () => {
      // Before the request, not after: the event is about what the reader asked for, and an
      // answer that never arrives is still a sort somebody performed.
      const next = cycleFiledTableSort(sort, column)
      track('todo.filed_sorted', { partition, column: next.column, dir: next.dir })
      onSortChange(next)
    },
  })

  // `todo.filed_partition_viewed` — once per partition per DISTINCT PARAMETER SET, after its
  // rows render. The signature is the dep, and a ref of what has already been sent guards the
  // case a dep array cannot: a remount (a tab switch, a filter that empties and refills the
  // section) would otherwise re-announce a view the reader never returned to.
  const seenViews = React.useRef<Set<string>>(new Set())
  const viewSignature =
    page === undefined ? null : `${page.partition}|${page.sort}|${page.dir}|${page.limit}|${page.total}`
  React.useEffect(() => {
    if (viewSignature === null || page === undefined) return
    if (seenViews.current.has(viewSignature)) return
    seenViews.current.add(viewSignature)
    track('todo.filed_partition_viewed', {
      partition: page.partition,
      rows: page.returned,
      total: page.total,
      sort: page.sort,
      dir: page.dir,
    })
    // `page` is read only through `viewSignature`, which is the value that decides whether this
    // is a new view at all; adding the object itself would fire on every refetch that changed
    // nothing a reader can see.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewSignature])
  const showMoreButton = (className: string) => (
    <button
      type="button"
      data-action={`filed-${partition}-show-more`}
      onClick={onShowMore}
      className={className}
    >
      Show {showMoreCount} more
    </button>
  )

  return (
    <div data-slot={`filed-${partition}-section`} className="mt-3">
      <h3 className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold tracking-[0.04em] text-soft-foreground uppercase">
        {heading}
        <span
          data-slot={`filed-${partition}-count`}
          className="font-mono text-[11px] font-medium tabular-nums"
        >
          {page?.total ?? 0}
        </span>
      </h3>

      {rows.length === 0 ? (
        <p
          data-slot={`filed-${partition}-empty`}
          className="rounded-lg border border-border bg-card px-3 py-2.5 text-[12.5px] text-soft-foreground"
        >
          Nothing here.
        </p>
      ) : !isDesktop ? (
        // Below `md` the filed table sideways-scrolls, so its rows render as cards — the same
        // `useIsDesktop` (not a CSS pair) choice `TaskTable` makes, keeping one copy in the DOM.
        <div data-slot={`filed-${partition}-cards`} className="flex flex-col gap-2.5">
          {rows.map((entry) => (
            <FiledCard
              key={filedTaskKey(entry)}
              entry={entry}
              now={now}
              nodeRoster={nodeRoster}
              search={search}
              onStart={() => onStart(entry)}
              onArchive={(archived) => onArchive(entry, archived)}
              selected={selected.has(filedTaskKey(entry))}
              onToggleSelect={() => onToggleSelect(entry)}
              startBusy={startBusy}
              archiveBusy={archiveBusy}
            />
          ))}
          {hasMore
            ? showMoreButton(
                'self-center rounded-md px-3 py-2.5 text-[12.5px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground',
              )
            : null}
        </div>
      ) : (
        <div
          data-slot={`filed-${partition}-table`}
          className="overflow-x-auto rounded-lg border border-border bg-card shadow-xs"
        >
          <TooltipProvider>
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <Th className="w-[40px]">
                    <SelectAllCheckbox
                      state={selectAllState}
                      onChange={(on) => onSelectKeys(rowKeys, on)}
                      label={`Select every ${heading.toLowerCase()} filed task shown`}
                    />
                  </Th>
                  <Th className="w-[104px]" {...sortable('status')} />
                  <Th {...sortable('task')} />
                  <Th className="w-[124px]" {...sortable('project')} />
                  <Th className="hidden w-[104px] lg:table-cell" {...sortable('author')} />
                  {/* Node is deliberately not sortable: it renders only on a clustered cockpit,
                      so a URL naming it would mean something on one install and nothing on the
                      next. */}
                  {nodeRoster.clusterOn ? <Th className="hidden w-[110px] xl:table-cell">Node</Th> : null}
                  <Th className="w-[84px]" {...sortable('priority')} />
                  <Th className="w-[64px] text-right" {...sortable('age')} />
                  <Th className="w-[64px] text-right">
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </thead>
              <tbody className="[&>tr:last-child>td]:border-b-0">
                {rows.map((entry) => (
                  <FiledRow
                    key={filedTaskKey(entry)}
                    entry={entry}
                    now={now}
                    nodeRoster={nodeRoster}
                    search={search}
                    onStart={() => onStart(entry)}
                    onArchive={(archived) => onArchive(entry, archived)}
                    selected={selected.has(filedTaskKey(entry))}
                    onToggleSelect={() => onToggleSelect(entry)}
                    startBusy={startBusy}
                    archiveBusy={archiveBusy}
                  />
                ))}
              </tbody>
            </table>
          </TooltipProvider>
          {hasMore ? (
            <div className="flex justify-center border-t border-border p-2">
              {showMoreButton(
                'rounded-md px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}

/** The Filed table's controls row: status/priority multi-select facets (with counts) and the
 *  created-date sort toggle, all URL-state — the page's `commit()` is the only writer, this row
 *  only ever calls the setters handed down from it. */
function FiledControlsRow({
  filedFilters,
  filedSort,
  counts,
  onToggleFacet,
  onClearFacet,
  onSortChange,
}: {
  filedFilters: FiledTaskFilters
  /** The Archived table's created-date dropdown. **Omitted on the Active tab**, where each table
   *  sorts from its own column headers instead — a dropdown that could only drive one of two
   *  tables would be a control whose target the reader has to guess. */
  filedSort?: FiledSort
  counts: { statuses: Map<string, number>; priorities: Map<string, number> }
  onToggleFacet: (facet: FiledFacetId, value: string) => void
  onClearFacet: (facet: FiledFacetId) => void
  onSortChange?: (sort: FiledSort) => void
}) {
  return (
    <div
      data-slot="filed-tasks-filters"
      className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-card p-2"
    >
      {/* The full closed enum, always — unlike the runs `FilterBar`'s workflow/status facets
          (derived from the data on screen), status and priority here are a small, fixed
          vocabulary the reader should always be able to reach, even at a count of zero. */}
      <FacetFilter
        slot="filed-status"
        label="Status"
        selected={filedFilters.statuses}
        onToggle={(value) => onToggleFacet('statuses', value)}
        onClear={() => onClearFacet('statuses')}
        options={FILED_STATUS_VALUES.map((status) => ({
          value: status,
          label: FILED_STATUS_LABEL[status],
          count: counts.statuses.get(status) ?? 0,
        }))}
        emptyLabel="No filed tasks to filter"
      />
      <FacetFilter
        slot="filed-priority"
        label="Priority"
        selected={filedFilters.priorities}
        onToggle={(value) => onToggleFacet('priorities', value)}
        onClear={() => onClearFacet('priorities')}
        options={FILED_PRIORITY_VALUES.map((priority) => ({
          value: priority,
          label: FILED_PRIORITY_LABEL[priority],
          count: counts.priorities.get(priority) ?? 0,
        }))}
        emptyLabel="No filed tasks to filter"
      />
      {filedSort !== undefined && onSortChange !== undefined ? (
        <>
          <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
          <span className="text-[11px] font-medium text-soft-foreground">Sort</span>
          <SegmentedControl
            slot="filed-sort"
            label="Sort filed tasks by creation date"
            value={filedSort}
            options={FILED_SORT_OPTIONS}
            onChange={onSortChange}
          />
        </>
      ) : null}
    </div>
  )
}

function SelectAllCheckbox({
  state,
  onChange,
  label,
}: {
  state: 'none' | 'some' | 'all'
  onChange: (on: boolean) => void
  label: string
}) {
  const ref = React.useRef<HTMLInputElement>(null)
  React.useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'some'
  }, [state])
  return (
    <input
      ref={ref}
      type="checkbox"
      data-slot="filed-select-all"
      aria-label={label}
      checked={state === 'all'}
      onChange={(event) => onChange(event.target.checked)}
      className="size-3.5 shrink-0 cursor-pointer align-middle"
    />
  )
}

function FiledRowCheckbox({
  entry,
  checked,
  onChange,
}: {
  entry: WorkspaceTodoEntry
  checked: boolean
  onChange: () => void
}) {
  return (
    <input
      type="checkbox"
      data-slot="filed-select"
      data-todo-id={entry.todo.id}
      aria-label={`Select ${entry.todo.summary}`}
      checked={checked}
      onChange={onChange}
      className="size-3.5 shrink-0 cursor-pointer align-middle"
    />
  )
}

/** One filed row: status, a title LINK to the task's own detail page
 *  (`.ai/specs/2026-08-29-filed-task-detail-page.md`), project link, priority, age with a
 *  tooltip carrying the full date, and Start / Archive-or-Restore. */
function FiledRow({
  entry,
  now,
  nodeRoster,
  search,
  onStart,
  onArchive,
  selected,
  onToggleSelect,
  startBusy,
  archiveBusy,
}: {
  entry: WorkspaceTodoEntry
  now: number
  nodeRoster: TaskNodeRoster
  search: string
  onStart: () => void
  onArchive: (archived: boolean) => void
  selected: boolean
  onToggleSelect: () => void
  startBusy: boolean
  archiveBusy: boolean
}) {
  const status = filedStatus(entry)
  // Archived is the STAMP, not the tab: a `done` row visible under Archived only because of its
  // status (never explicitly archived) still offers "Archive" — clicking it adds the stamp — not
  // a "Restore" that would be a no-op (the row stays Archived either way, since `status === 'done'`
  // is the OTHER, independent reason it is there). See `matchesFiledView` in `lib/filed-tasks.ts`.
  const archived = entry.todo.archivedAt !== undefined
  return (
    <tr
      data-slot="filed-task-row"
      data-project={entry.project}
      data-todo-id={entry.todo.id}
      className="hover:bg-muted"
      data-selected={selected ? '' : undefined}
    >
      <td className={TD_BASE}>
        <FiledRowCheckbox entry={entry} checked={selected} onChange={onToggleSelect} />
      </td>
      <td className={TD_BASE}>
        <FiledStatusPill status={status} />
      </td>
      <td className={cn(TD_BASE, 'min-w-[320px] max-w-0')}>
        <Link
          to={scopeTo(entry.project, `/todos/${entry.todo.id}`)}
          state={{ from: { pathname: '/tasks', search, surface: 'table' } }}
          data-slot="filed-task-title"
          title={entry.todo.summary}
          className="min-w-0 max-w-full truncate text-left text-[13px] font-medium hover:underline"
        >
          {entry.todo.summary}
        </Link>
      </td>
      <td className={cn(TD_BASE, 'text-[12.5px] text-muted-foreground')}>
        <Link to={scopeTo(entry.project, '/')} className="truncate hover:text-foreground">
          {entry.project}
        </Link>
      </td>
      <td className={cn(TD_BASE, 'hidden lg:table-cell')}>
        <AuthorCell author={entry.todo.author} />
      </td>
      {nodeRoster.clusterOn ? (
        <td className={cn(TD_BASE, 'hidden xl:table-cell')}>
          <TaskNodeCell info={nodeRoster.resolve(entry.todo)} />
        </td>
      ) : null}
      <td className={TD_BASE}>
        {entry.todo.priority ? <FiledPriorityChip priority={entry.todo.priority} /> : <Dash />}
      </td>
      <td className={cn(TD_BASE, 'text-right text-xs text-soft-foreground tabular-nums')}>
        {entry.todo.ts ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span>{shortAge(entry.todo.ts, now)}</span>
            </TooltipTrigger>
            <TooltipContent side="left">{new Date(entry.todo.ts).toLocaleString()}</TooltipContent>
          </Tooltip>
        ) : (
          <Dash />
        )}
      </td>
      <td className={cn(TD_BASE, 'text-right')}>
        <span className="inline-flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                data-action="start-filed-task"
                aria-label={`Start ${entry.todo.summary}`}
                disabled={startBusy}
                onClick={onStart}
                className="inline-flex size-7 items-center justify-center rounded-md text-soft-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-wait disabled:opacity-50"
              >
                <PlayIcon className="size-3.5" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left">Start</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                data-action={archived ? 'restore-filed-task' : 'archive-filed-task'}
                aria-label={
                  archived
                    ? `Restore ${entry.todo.summary} to the active list`
                    : `Archive ${entry.todo.summary}`
                }
                disabled={archiveBusy}
                onClick={() => onArchive(!archived)}
                className="inline-flex size-7 items-center justify-center rounded-md text-soft-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-wait disabled:opacity-50"
              >
                {archived ? (
                  <ArchiveRestoreIcon className="size-3.5" aria-hidden="true" />
                ) : (
                  <ArchiveIcon className="size-3.5" aria-hidden="true" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="left">{archived ? 'Restore' : 'Archive'}</TooltipContent>
          </Tooltip>
        </span>
      </td>
    </tr>
  )
}

/**
 * One filed task as a card — the `<md` framing of `FiledRow`.
 *
 * Same detail-page title link and the same Start / Archive handlers, only reshaped for a
 * phone: a stacked card with ≥44px labelled actions where the row offers 28px icons.
 */
function FiledCard({
  entry,
  now,
  nodeRoster,
  search,
  onStart,
  onArchive,
  selected,
  onToggleSelect,
  startBusy,
  archiveBusy,
}: {
  entry: WorkspaceTodoEntry
  now: number
  nodeRoster: TaskNodeRoster
  search: string
  onStart: () => void
  onArchive: (archived: boolean) => void
  selected: boolean
  onToggleSelect: () => void
  startBusy: boolean
  archiveBusy: boolean
}) {
  const status = filedStatus(entry)
  const archived = entry.todo.archivedAt !== undefined
  return (
    <div
      data-slot="filed-task-card"
      data-project={entry.project}
      data-todo-id={entry.todo.id}
      className="rounded-lg border border-border bg-card px-3.5 py-3 shadow-xs"
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 shrink-0">
          <FiledRowCheckbox entry={entry} checked={selected} onChange={onToggleSelect} />
        </span>
        <span className="mt-px shrink-0">
          <FiledStatusPill status={status} />
        </span>
        <Link
          to={scopeTo(entry.project, `/todos/${entry.todo.id}`)}
          state={{ from: { pathname: '/tasks', search, surface: 'card' } }}
          data-slot="filed-task-title"
          title={entry.todo.summary}
          className="min-w-0 flex-1 text-left text-[13.5px] font-medium leading-[1.35] hover:underline"
        >
          {entry.todo.summary}
        </Link>
        <span className="mt-0.5 shrink-0 text-[11.5px] text-soft-foreground tabular-nums">
          {entry.todo.ts ? shortAge(entry.todo.ts, now) : '—'}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11.5px] text-muted-foreground">
        <Link to={scopeTo(entry.project, '/')} className="truncate font-mono hover:text-foreground">
          {entry.project}
        </Link>
        {entry.todo.priority ? (
          <>
            <Sep />
            <FiledPriorityChip priority={entry.todo.priority} />
          </>
        ) : null}
        {nodeRoster.clusterOn ? (
          <>
            <Sep />
            <TaskNodeCell info={nodeRoster.resolve(entry.todo)} />
          </>
        ) : null}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-2">
        <button
          type="button"
          data-action="start-filed-task"
          aria-label={`Start ${entry.todo.summary}`}
          disabled={startBusy}
          onClick={onStart}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-border px-3 text-[12.5px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-wait disabled:opacity-50"
        >
          <PlayIcon className="size-3.5" aria-hidden="true" />
          Start
        </button>
        <button
          type="button"
          data-action={archived ? 'restore-filed-task' : 'archive-filed-task'}
          aria-label={
            archived ? `Restore ${entry.todo.summary} to the active list` : `Archive ${entry.todo.summary}`
          }
          disabled={archiveBusy}
          onClick={() => onArchive(!archived)}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-border px-3 text-[12.5px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-wait disabled:opacity-50"
        >
          {archived ? (
            <ArchiveRestoreIcon className="size-3.5" aria-hidden="true" />
          ) : (
            <ArchiveIcon className="size-3.5" aria-hidden="true" />
          )}
          {archived ? 'Restore' : 'Archive'}
        </button>
      </div>
    </div>
  )
}

/** The Filed table's bulk-selection Start (2026-08-24-bulk-start-filed-tasks.md) — the ONE mutation
 *  that stays here rather than moving to `api/filed-task-mutations.ts` with its single-task
 *  sibling: nothing outside the board's own selection bar starts more than one task at a time. */
function useStartFiledTasks() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (entries: readonly WorkspaceTodoEntry[]) => {
      const failures: string[] = []
      let started = 0
      for (const entry of entries) {
        try {
          await startWorkspaceTodo(entry.project, entry.todo.id)
          started += 1
        } catch (error: unknown) {
          failures.push(error instanceof Error ? error.message : String(error))
        }
      }
      return { started, total: entries.length, failures }
    },
    onSuccess: ({ started, total, failures }) => {
      void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.workspaceTodos })
      void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.runsIndex })
      if (failures.length > 0) {
        toast(`Started ${started} of ${total}: ${failures[0]}`, { tone: 'danger' })
        return
      }
      toast(`Started ${started} task${started === 1 ? '' : 's'}`)
    },
    onError: (error) => toast(error.message, { tone: 'danger' }),
  })
}

// `useStartFiledTask` and `useUpdateFiledTodo` moved to `@/api/filed-task-mutations`
// (`.ai/specs/2026-08-29-filed-task-detail-page.md`, Phase 1): the standalone task detail page
// needs both, and a route module importing another route module would be a cycle once the board
// links straight to that page. `useUpdateFiledTodo` there also carries the partitioned-page
// removal (`.ai/specs/2026-08-25-split-active-backlog-tables.md`, Risks) that this file's copy
// grew independently before the two branches converged.

function ViewTab({
  view,
  current,
  onSelect,
  children,
}: {
  view: ListView
  current: ListView
  onSelect: (view: ListView) => void
  children: React.ReactNode
}) {
  const isActive = view === current
  return (
    <button
      type="button"
      data-slot="overview-tab"
      data-view={view}
      // Same rationale as the per-project table's tabs: these filter one list in place, they do
      // not switch panels — `aria-pressed` is what that actually is.
      aria-pressed={isActive}
      onClick={() => onSelect(view)}
      className={cn(
        'flex h-7 items-center justify-center rounded-[7px] px-3 text-[12.5px] font-medium text-muted-foreground',
        isActive && 'bg-card font-semibold text-foreground shadow-xs',
      )}
    >
      {children}
    </button>
  )
}

/**
 * The filter row.
 *
 * Two shapes, chosen by what the facet IS rather than for variety:
 *
 *  - **Tags are laid out flat**, as one-click toggle chips. They are the reason this page exists
 *    ("show me the storefront work"), there are rarely more than a dozen, and seeing the whole
 *    set is most of the value — a popover would hide exactly what the user came to look at.
 *  - **Everything else is a searchable multi-select pill.** A workspace can hold forty projects
 *    and a dozen workflows; those do not lay out flat, and they do not need to.
 *
 * Every option carries the number of rows it would leave, counted against the list as the OTHER
 * facets narrow it — so a filter that would empty the table says so before it is clicked. And
 * every option list except the tags is derived from the tasks ACTUALLY on the page: an option
 * that can only ever produce an empty table is a dead end wearing a control's clothes. Tags are
 * the deliberate exception, taken from the registry, because a tag on a project with no tasks
 * yet is still the answer to "which repos are in this group?".
 */
function FilterBar({
  filters,
  onToggle,
  onClearFacet,
  onClearAll,
  groupBy,
  onGroupByChange,
  projects,
  tasks,
  view,
}: {
  filters: GlobalTaskFilters
  onToggle: (facet: FacetId, value: string) => void
  onClearFacet: (facet: FacetId) => void
  onClearAll: () => void
  groupBy: GroupBy
  onGroupByChange: (next: GroupBy) => void
  projects: readonly ProjectListEntry[]
  tasks: readonly GlobalTask[]
  view: ListView
}) {
  const tags = React.useMemo(() => allProjectTags(projects), [projects])

  // One `tasksExcludingFacet` per facet: the counts a facet shows must not already assume that
  // facet's own ticks, or unticking a value would promise fewer rows than it delivers.
  const counts = React.useMemo(() => {
    const per = (facet: FacetId, valueOf: (task: GlobalTask) => readonly string[]) =>
      facetCounts(tasksExcludingFacet(tasks, filters, view, facet), valueOf)
    return {
      tags: per('tags', tagValuesOf),
      statuses: per('statuses', (task) => [task.run.status]),
      workflows: per('workflows', (task) => [task.run.workflow]),
    }
  }, [tasks, filters, view])

  const withCount = (map: Map<string, number>) => (option: { value: string; label: string }) => ({
    ...option,
    count: map.get(option.value) ?? 0,
  })

  return (
    <div
      data-slot="global-tasks-filters"
      className="flex flex-col gap-2 rounded-lg border border-border bg-card p-2.5 shadow-xs"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {/* No project facet, deliberately — see the note in `lib/global-tasks.ts`. Narrowing to
            one project is that project's own Tasks page, which every project name here links to. */}
        <FacetFilter
          slot="status"
          label="Status"
          selected={filters.statuses}
          onToggle={(value) => onToggle('statuses', value)}
          onClear={() => onClearFacet('statuses')}
          options={allStatuses(tasks)
            .map((status) => ({ value: status, label: status }))
            .map(withCount(counts.statuses))}
          emptyLabel="No tasks to filter"
        />
        <FacetFilter
          slot="workflow"
          label="Workflow"
          selected={filters.workflows}
          onToggle={(value) => onToggle('workflows', value)}
          onClear={() => onClearFacet('workflows')}
          options={allWorkflows(tasks)
            // `value` stays the identity — it is what `filters.workflows` matches on and what
            // rides the URL as `?workflow=quick-task`, so a shared link keeps working and the
            // label can change again tomorrow without invalidating anyone's bookmark.
            .map((workflow) => ({ value: workflow, label: displayWorkflowName(workflow) }))
            .map(withCount(counts.workflows))}
          emptyLabel="No tasks to filter"
        />
        <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
        <span className="text-[11px] font-medium text-soft-foreground">Group by</span>
        {/* Pressing the pressed one releases it — see `toggleGroupBy`, which is why there is
            no "None" button to hunt for. */}
        <SegmentedControl
          slot="group-by"
          label="Group tasks by"
          value={groupBy}
          options={GROUP_BY_OPTIONS}
          onChange={(picked) => onGroupByChange(toggleGroupBy(groupBy, picked))}
        />
        {canReset({ filters, groupBy }) ? (
          <button
            type="button"
            data-action="clear-filters"
            onClick={onClearAll}
            className="ml-auto inline-flex h-7 items-center gap-1 rounded-full px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <XIcon className="size-3" aria-hidden="true" />
            Clear
            {` (${resetCount({ filters, groupBy })})`}
          </button>
        ) : null}
      </div>

      {tags.length > 0 ? (
        <div data-slot="tag-filters" className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-medium text-soft-foreground">Tags</span>
          {tags.map((tag) => (
            <ToggleChip
              key={tag}
              slot="tag-filter"
              tone="tag"
              label={tag}
              count={counts.tags.get(tag) ?? 0}
              selected={filters.tags.some((picked) => picked.toLowerCase() === tag.toLowerCase())}
              onToggle={() => onToggle('tags', tag)}
            />
          ))}
          {/* Last, and named as the leftovers it is: "which repos still need labelling?" is a
              real question, and it is the one this chip answers. */}
          <ToggleChip
            slot="tag-filter"
            label="Untagged"
            count={counts.tags.get(UNTAGGED) ?? 0}
            selected={filters.tags.includes(UNTAGGED)}
            onToggle={() => onToggle('tags', UNTAGGED)}
          />
        </div>
      ) : (
        // Not silence: a workspace with no tags anywhere is the ONE state where the feature is
        // invisible, and the sentence that fixes it is one line long — with the door in it,
        // since the pane that fixes it is two clicks away and outside this page.
        <p data-slot="no-tags-hint" className="text-[11px] text-soft-foreground">
          Tag connected repositories in{' '}
          <Link to="/settings/projects" className="font-medium text-violet hover:underline">
            Settings → Projects
          </Link>{' '}
          to group their tasks together here.
        </p>
      )}
    </div>
  )
}

/** The rows. One table per group, so a group heading owns its own header row rather than
 *  floating above a shared one that would scroll away from it. */
function TaskTable({
  tasks,
  now,
  showProject,
  onArchive,
  onSetRead,
  busy,
  showCost,
  runNodeRoster,
}: {
  tasks: readonly GlobalTask[]
  now: number
  showProject: boolean
  onArchive: (task: GlobalTask, archived: boolean) => void
  onSetRead: (task: GlobalTask, read: boolean) => void
  busy: boolean
  showCost: boolean
  runNodeRoster: RunNodeRoster
}) {
  // Below `md` the table's ~700px minimum row is a sideways-scroll on a phone, so the same rows
  // render as stacked cards instead (mobile-ux spec 2026-08-19). Gated on `useIsDesktop` rather
  // than a CSS `md:hidden`/`hidden md:block` pair so exactly one of the two is in the DOM — the
  // page's unit tests query rows by role/text without scoping, and a second copy would make every
  // such query ambiguous. jsdom has no `matchMedia`, so it counts as desktop and tests see only
  // the table (`use-desktop.ts`).
  const isDesktop = useIsDesktop()

  if (!isDesktop) {
    return (
      <div data-slot="global-tasks-cards" className="flex flex-col gap-2.5">
        {tasks.map((task) => (
          <GlobalTaskCard
            key={`${task.run.projectId}/${task.run.id}`}
            task={task}
            now={now}
            showProject={showProject}
            onArchive={onArchive}
            onSetRead={onSetRead}
            busy={busy}
            showCost={showCost}
            runNodeRoster={runNodeRoster}
          />
        ))}
      </div>
    )
  }

  return (
    <div
      data-slot="global-tasks-table"
      className="overflow-x-auto rounded-lg border border-border bg-card shadow-xs"
    >
      <TooltipProvider>
        <table className="w-full border-collapse">
          <thead>
            {/* Every other column is pinned as narrow as its content allows, because Task is the
                only one with NO width and therefore the only one that grows on what they give
                up. A cross-project list is scanned by title; everything else is the answer to a
                question you ask about a row you already found. */}
            <tr>
              <Th className="w-[104px]">Status</Th>
              <Th>Task</Th>
              {showProject ? <Th className="w-[124px]">Project</Th> : null}
              <Th className="hidden w-[120px] xl:table-cell">Tags</Th>
              <Th className="w-[84px]">Ref</Th>
              <Th className="hidden w-[104px] xl:table-cell">Author</Th>
              {runNodeRoster.clusterOn ? <Th className="hidden w-[124px] xl:table-cell">Node</Th> : null}
              <Th className="hidden w-[108px] xl:table-cell">Workflow</Th>
              {showCost ? <Th className="hidden w-[64px] text-right lg:table-cell">Cost</Th> : null}
              <Th className="hidden w-[56px] text-right xl:table-cell">CPU</Th>
              <Th className="hidden w-[84px] text-right xl:table-cell">Mem</Th>
              <Th className="hidden w-[104px] text-right xl:table-cell">Context</Th>
              <Th className="w-[56px] text-right">Age</Th>
              <Th className="w-[64px] text-right">
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </thead>
          <tbody className="[&>tr:last-child>td]:border-b-0">
            {tasks.map((task) => (
              <TaskRow
                key={`${task.run.projectId}/${task.run.id}`}
                task={task}
                now={now}
                showProject={showProject}
                onArchive={onArchive}
                onSetRead={onSetRead}
                busy={busy}
                showCost={showCost}
                runNodeRoster={runNodeRoster}
              />
            ))}
          </tbody>
        </table>
      </TooltipProvider>
    </div>
  )
}

/**
 * A header cell, optionally SORTABLE (2026-08-25-split-active-backlog-tables.md, D6).
 *
 * Pass `sortColumn` + `sort` + `onSort` and the cell renders its label as a `<button>`, carries
 * `aria-sort` (`ascending` / `descending` / `none`) and takes its text from
 * `FILED_COLUMN_LABEL` — one place the column's name is spelled, shared with the URL vocabulary.
 * Pass `children` alone and it is the plain cell every other table on this page uses.
 *
 * `aria-sort="none"` is set on every sortable column rather than left off the unsorted ones, so a
 * screen reader can tell "sortable, not currently sorted" from "not sortable at all".
 */
function Th({
  children,
  className,
  sortColumn,
  sort,
  onSort,
}: {
  children?: React.ReactNode
  className?: string
  sortColumn?: FiledSortColumn
  sort?: FiledTableSort
  onSort?: () => void
}) {
  const sortable = sortColumn !== undefined && sort !== undefined && onSort !== undefined
  return (
    <th
      scope="col"
      aria-sort={sortable ? filedAriaSort(sort, sortColumn) : undefined}
      className={cn(
        'h-[38px] border-b border-border px-2.5 text-left text-[11px] font-semibold tracking-[0.05em] whitespace-nowrap text-soft-foreground uppercase first:pl-4 last:pr-4',
        className,
      )}
    >
      {sortable ? (
        <button
          type="button"
          data-slot="filed-sort-header"
          data-column={sortColumn}
          onClick={onSort}
          className="inline-flex items-center gap-1 rounded-sm uppercase hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          {FILED_COLUMN_LABEL[sortColumn]}
          {sort.column === sortColumn ? (
            sort.dir === 'asc' ? (
              <ChevronUpIcon className="size-3" aria-hidden="true" />
            ) : (
              <ChevronDownIcon className="size-3" aria-hidden="true" />
            )
          ) : null}
        </button>
      ) : (
        children
      )}
    </th>
  )
}

const TD_BASE = 'h-11 border-b border-border px-2.5 whitespace-nowrap first:pl-4 last:pr-4'

/**
 * One cross-project run.
 *
 * The title is a real `<Link>` — a plain router one, explicitly scoped with `scopeTo`: this page
 * renders outside every `/p/:projectId`, so the scope-aware `Link` would have no project to
 * prefix with, and each row points at a DIFFERENT project anyway.
 */
function TaskRow({
  task,
  now,
  showProject,
  onArchive,
  onSetRead,
  busy,
  showCost,
  runNodeRoster,
}: {
  task: GlobalTask
  now: number
  showProject: boolean
  onArchive: (task: GlobalTask, archived: boolean) => void
  onSetRead: (task: GlobalTask, read: boolean) => void
  busy: boolean
  showCost: boolean
  runNodeRoster: RunNodeRoster
}) {
  const { run } = task
  const attention = deriveAttention(run)
  const to = scopeTo(run.projectId, `/tasks/${run.id}`)
  const unread = isUnread(run)
  const readDone = isReadDoneItem(run)
  // The SAME rule every other surface applies (#407, #526) — the index carries the six inputs
  // rather than a pre-resolved chip precisely so this is one function, not two. Plural here
  // because a task genuinely has several: opened on an issue, about one PR, having created
  // another. The surfaces with one slot take the first; this one has room for the truth.
  //
  // The project's own repo root is what makes a reference known only by NUMBER clickable. A
  // project-scoped view can use the one repo it is standing in; this page has a different repo
  // per row, which is why the registry entry carries `repoUrl`.
  const references = taskReferences(run, task.project?.repoUrl)
  // The SAME live/peak rule the per-project table applies. The live sample rides the index row
  // itself (`run.usage`, attached server-side per poll) rather than the run event stream, which
  // is project-scoped and so cannot reach forty projects at once.
  const usage = usageCells(run, run.usage)

  return (
    <tr data-slot="global-task-row" data-run-id={run.id} data-project={run.projectId} className="hover:bg-muted">
      <td className={TD_BASE}>
        <Pill dot={attention.tone} pulse={attention.pulse}>
          {attention.label}
        </Pill>
      </td>
      {/* The one column with no fixed width, so every pixel the others give up lands here — and
          dropping Branch gave up 140 of them. A cross-project list is read by TITLE. */}
      <td className={cn(TD_BASE, 'min-w-[320px] max-w-0')}>
        <span className="flex min-w-0 items-center gap-1.5">
          <Link
            to={to}
            title={runTitle(run)}
            className={cn(
              'min-w-0 truncate text-[13px]',
              unread
                ? 'font-semibold text-foreground'
                : readDone
                  ? 'font-medium text-muted-foreground'
                  : 'font-medium',
            )}
          >
            {runTitle(run)}
          </Link>
          {unread ? (
            <StatusDot
              tone="violet"
              role="img"
              aria-label="unread"
              title="Unread — not opened since it finished"
              className="shrink-0"
            />
          ) : null}
        </span>
      </td>
      {showProject ? (
        <td className={cn(TD_BASE, 'text-[12.5px] text-muted-foreground')}>
          {run.workspace ? (
            // A chip, deliberately NOT a link. Every other row's project name leads to that
            // project's home; a workspace run spans all of them, so there is no home to lead to
            // and `/p/cockpit-boot/` would be a destination that means nothing — the boot repo is
            // where the record is stored, not what the run is about. The row's title link still
            // opens the run thread, which is where the work is.
            <span
              data-slot="workspace-chip"
              title="Workspace run — granted every registered project"
              className="inline-flex max-w-full items-center gap-1 truncate rounded-full bg-muted px-1.5 py-px text-[10.5px] font-medium text-muted-foreground"
            >
              <LayersIcon className="size-3 shrink-0" aria-hidden="true" />
              {task.projectName}
            </span>
          ) : (
            <Link to={scopeTo(run.projectId, '/')} className="truncate hover:text-foreground">
              {task.projectName}
            </Link>
          )}
        </td>
      ) : null}
      <td className={cn(TD_BASE, 'hidden xl:table-cell')}>
        {task.tags.length > 0 ? (
          <span className="flex flex-wrap items-center gap-1">
            {task.tags.map((tag) => (
              <TagChip key={tag} tag={tag} />
            ))}
          </span>
        ) : (
          <Dash />
        )}
      </td>
      <td className={TD_BASE}>
        {references.length > 0 ? (
          <ReferenceChips references={references} run={run} />
        ) : (
          <Dash />
        )}
      </td>
      <td className={cn(TD_BASE, 'hidden xl:table-cell')}>
        <AuthorCell author={run.author} />
      </td>
      {runNodeRoster.clusterOn ? (
        <td className={cn(TD_BASE, 'hidden xl:table-cell')}>
          <RunNodeCell roster={runNodeRoster} runId={run.id} />
        </td>
      ) : null}
      <td className={cn(TD_BASE, 'hidden text-[12.5px] text-muted-foreground xl:table-cell')}>
        {displayWorkflowName(run.workflow)}
      </td>
      {showCost ? (
        <td
          className={cn(
            TD_BASE,
            'hidden text-right font-mono text-xs text-muted-foreground tabular-nums lg:table-cell',
          )}
        >
          {formatCost(run.costUsd) || <Dash />}
        </td>
      ) : null}
      <UsageTd column="cpu" cell={usage.cpu} />
      <UsageTd column="memory" cell={usage.mem} />
      <ContextTd cell={contextCell(run)} />
      <td className={cn(TD_BASE, 'text-right text-xs text-soft-foreground tabular-nums')}>
        {shortAge(run.startedAt ?? run.createdAt, now)}
      </td>
      <td className={cn(TD_BASE, 'text-right')}>
        <span className="inline-flex items-center gap-0.5">
          <ReadToggle task={task} busy={busy} onSetRead={onSetRead} />
          <ArchiveToggle task={task} busy={busy} onArchive={onArchive} />
        </span>
      </td>
    </tr>
  )
}

/**
 * One cross-project run as a card — the `<md` framing of `TaskRow`.
 *
 * Same data, same links, same status/reference grammar; only the box and the touch targets
 * change. The desktop table stays the source of truth for row shape (mobile-ux spec 2026-08-19),
 * so this deliberately mirrors it rather than inventing a second layout — status pill + title +
 * unread dot + age on top, a wrapping mono meta line (project · workflow · cost · context ·
 * refs) below, and full-width ≥44px Read/Archive actions where the row offers its 28px icons.
 */
function GlobalTaskCard({
  task,
  now,
  showProject,
  onArchive,
  onSetRead,
  busy,
  showCost,
  runNodeRoster,
}: {
  task: GlobalTask
  now: number
  showProject: boolean
  onArchive: (task: GlobalTask, archived: boolean) => void
  onSetRead: (task: GlobalTask, read: boolean) => void
  busy: boolean
  showCost: boolean
  runNodeRoster: RunNodeRoster
}) {
  const { run } = task
  const attention = deriveAttention(run)
  const to = scopeTo(run.projectId, `/tasks/${run.id}`)
  const unread = isUnread(run)
  const readDone = isReadDoneItem(run)
  const references = taskReferences(run, task.project?.repoUrl)
  const context = contextCell(run)
  const cost = formatCost(run.costUsd)
  const title = runTitle(run)
  const canRead = canBeUnread(run)
  const archived = run.archived
  const canArchive = archived || ARCHIVABLE_STATUSES.has(run.status)

  // Project (when shown) · workflow · cost · context — the same order the table reads left to
  // right, interleaved with the middot separators. Built as a list so an absent piece leaves no
  // stray separator behind it.
  const parts: React.ReactNode[] = []
  if (showProject) {
    parts.push(
      run.workspace ? (
        <span
          key="project"
          data-slot="workspace-chip"
          title="Workspace run — granted every registered project"
          className="inline-flex max-w-full items-center gap-1 truncate rounded-full bg-muted px-1.5 py-px text-[10.5px] font-medium text-muted-foreground"
        >
          <LayersIcon className="size-3 shrink-0" aria-hidden="true" />
          {task.projectName}
        </span>
      ) : (
        <Link key="project" to={scopeTo(run.projectId, '/')} className="truncate hover:text-foreground">
          {task.projectName}
        </Link>
      ),
    )
  }
  const workflow = displayWorkflowName(run.workflow)
  if (workflow) parts.push(<span key="workflow">{workflow}</span>)
  if (runNodeRoster.clusterOn) {
    parts.push(<RunNodeCell key="node" roster={runNodeRoster} runId={run.id} />)
  }
  if (showCost && cost) parts.push(<span key="cost">{cost}</span>)
  if (context.text) {
    parts.push(
      <span key="context" data-slot="card-context" title="Context window used / max">
        {context.text}
      </span>,
    )
  }

  return (
    <div
      data-slot="global-task-card"
      data-run-id={run.id}
      data-project={run.projectId}
      className="rounded-lg border border-border bg-card px-3.5 py-3 shadow-xs"
    >
      <div className="flex items-start gap-2.5">
        <Pill dot={attention.tone} pulse={attention.pulse} className="mt-px shrink-0">
          {attention.label}
        </Pill>
        <Link
          to={to}
          title={title}
          className={cn(
            'min-w-0 flex-1 text-[13.5px] leading-[1.35]',
            unread ? 'font-semibold text-foreground' : readDone ? 'font-medium text-muted-foreground' : 'font-medium',
          )}
        >
          {title}
        </Link>
        {unread ? (
          <StatusDot
            tone="violet"
            role="img"
            aria-label="unread"
            title="Unread — not opened since it finished"
            className="mt-1.5 shrink-0"
          />
        ) : null}
        <span className="mt-0.5 shrink-0 text-[11.5px] text-soft-foreground tabular-nums">
          {shortAge(run.startedAt ?? run.createdAt, now)}
        </span>
      </div>

      {parts.length > 0 || references.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 font-mono text-[11.5px] font-medium text-muted-foreground tabular-nums">
          {parts.map((node, index) => (
            <React.Fragment key={index}>
              {index > 0 ? <Sep /> : null}
              {node}
            </React.Fragment>
          ))}
          {references.length > 0 ? <ReferenceChips references={references} run={run} /> : null}
        </div>
      ) : null}

      {canRead || canArchive ? (
        <div className="mt-2.5 flex flex-wrap gap-2">
          {canRead ? (
            <button
              type="button"
              data-action={unread ? 'mark-read' : 'mark-unread'}
              aria-label={unread ? `Mark ${title} read` : `Mark ${title} unread`}
              disabled={busy}
              onClick={() => onSetRead(task, unread)}
              className={cn(
                'inline-flex min-h-11 items-center gap-1.5 rounded-md border border-border px-3 text-[12.5px] font-medium hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-wait disabled:opacity-50',
                unread ? 'text-violet' : 'text-muted-foreground',
              )}
            >
              {unread ? (
                <EyeIcon className="size-3.5" aria-hidden="true" />
              ) : (
                <EyeOffIcon className="size-3.5" aria-hidden="true" />
              )}
              {unread ? 'Mark read' : 'Mark unread'}
            </button>
          ) : null}
          {canArchive ? (
            <button
              type="button"
              data-action={archived ? 'unarchive-run' : 'archive-run'}
              aria-label={archived ? `Restore ${title} to the active list` : `Archive ${title}`}
              disabled={busy}
              onClick={() => onArchive(task, !archived)}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-border px-3 text-[12.5px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-wait disabled:opacity-50"
            >
              {archived ? (
                <ArchiveRestoreIcon className="size-3.5" aria-hidden="true" />
              ) : (
                <ArchiveIcon className="size-3.5" aria-hidden="true" />
              )}
              {archived ? 'Restore' : 'Archive'}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/**
 * Mark one row read or unread — an open eye to stamp the receipt, a closed one to take it back.
 *
 * Offered only where a read state EXISTS: `canBeUnread` is the same decider behind the unread dot
 * itself, so the button appears on exactly the rows that can wear one — finished, not archived,
 * not a task merely waiting out a usage limit. A running task has nothing to have read yet, and a
 * button that did nothing would say otherwise.
 *
 * The icon shows the ACTION, not the state: unread rows offer the open eye ("mark read"), read
 * ones the closed eye ("mark unread"). The state is already visible a few columns left, as the
 * violet dot beside the title.
 */
function ReadToggle({
  task,
  busy,
  onSetRead,
}: {
  task: GlobalTask
  busy: boolean
  onSetRead: (task: GlobalTask, read: boolean) => void
}) {
  if (!canBeUnread(task.run)) return null
  const unread = isUnread(task.run)
  const title = runTitle(task.run)
  const label = unread ? `Mark ${title} read` : `Mark ${title} unread`
  const Icon = unread ? EyeIcon : EyeOffIcon
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-action={unread ? 'mark-read' : 'mark-unread'}
          aria-label={label}
          disabled={busy}
          onClick={() => onSetRead(task, unread)}
          className={cn(
            'inline-flex size-7 items-center justify-center rounded-md transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-wait disabled:opacity-50',
            unread ? 'text-violet' : 'text-soft-foreground',
          )}
        >
          <Icon className="size-3.5" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="left">{unread ? 'Mark read' : 'Mark unread'}</TooltipContent>
    </Tooltip>
  )
}

/**
 * Archive / restore one row, without leaving the page.
 *
 * Per-row rather than the per-project table's count-gated "Archive finished" broom: a sweep that
 * crossed project boundaries would be one click firing N writes into N repos, and "finished" is a
 * judgement each project's own page is better placed to make. One row, one deliberate click.
 *
 * The button only exists for a run that is actually FINISHED (or already archived). Archiving
 * something still running would be answered by the server anyway, but offering it invites the
 * question of whether it also cancels — which it does not.
 */
function ArchiveToggle({
  task,
  busy,
  onArchive,
}: {
  task: GlobalTask
  busy: boolean
  onArchive: (task: GlobalTask, archived: boolean) => void
}) {
  const archived = task.run.archived
  if (!archived && !ARCHIVABLE_STATUSES.has(task.run.status)) return null
  const label = archived
    ? `Restore ${runTitle(task.run)} to the active list`
    : `Archive ${runTitle(task.run)}`
  const Icon = archived ? ArchiveRestoreIcon : ArchiveIcon
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-action={archived ? 'unarchive-run' : 'archive-run'}
          aria-label={label}
          disabled={busy}
          onClick={() => onArchive(task, !archived)}
          className="inline-flex size-7 items-center justify-center rounded-md text-soft-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-wait disabled:opacity-50"
        >
          <Icon className="size-3.5" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="left">{archived ? 'Restore' : 'Archive'}</TooltipContent>
    </Tooltip>
  )
}

/**
 * A task's tracker references — all of them.
 *
 * Bounded rather than unbounded: `taskReferences` reads only real fields (never the transcript
 * candidate lists, see #526) so three is already a lot, but a table cell must not be able to
 * grow without limit on one odd record. Past the cap the rest collapse into a `+N` that NAMES
 * them in its tooltip, so nothing becomes invisible — it only stops taking vertical space.
 */
function ReferenceChips({
  references,
  run,
}: {
  references: readonly TaskReference[]
  run: RunIndexEntry
}) {
  const shown = references.slice(0, MAX_VISIBLE_REFERENCES)
  const hidden = references.length - shown.length
  const title = runTitle(run)
  return (
    // `flex-nowrap` and `shrink-0`, both load-bearing: wrapping put the chips on two lines AND
    // broke `Issue #5119` across its own fixed-height pill, so the text sat outside the border.
    // A reference is one atom — it either fits on the row or it moves into the `+N` popover.
    <span className="flex flex-nowrap items-center gap-1">
      {shown.map((reference) => (
        <ReferenceChip
          key={`${reference.kind}#${reference.number}`}
          reference={reference}
          taskTitle={title}
          // Named per chip HERE and nowhere else: this page's rows come from different projects,
          // and two of them may each have a #42.
          projectId={run.projectId}
          className="shrink-0"
        />
      ))}
      {hidden > 0 ? (
        <ReferenceOverflow
          references={references}
          taskTitle={title}
          hidden={hidden}
          projectId={run.projectId}
        />
      ) : null}
    </span>
  )
}

/**
 * The `+N`, opened.
 *
 * A tooltip listing the hidden references told you they existed and then refused to let you go
 * to them — which is worse than not mentioning them. This is a popover of real links instead.
 *
 * It opens on HOVER where hovering exists and on click everywhere — including touch, which has no
 * hover, and the keyboard, where the trigger is a real button. Radix's HoverCard would have given
 * the first for free but not the other two: it is explicitly not a touch affordance. So this is a
 * Popover (click-and-keyboard by construction) with hover layered on, which is the combination
 * that leaves no input method without a way in.
 *
 * It lists EVERY reference, not only the hidden ones: at the moment you open it you are asking
 * "what does this task point at?", and answering with the leftovers would make you reassemble
 * the set from two places. The rows are `ReferenceChip`s, so the http-only guard, the accessible
 * names and the `target`/`rel` handling are the same ones every other reference link uses rather
 * than a second, subtly different implementation.
 */
function ReferenceOverflow({
  references,
  taskTitle,
  hidden,
  projectId,
}: {
  references: readonly TaskReference[]
  taskTitle: string
  hidden: number
  projectId: string
}) {
  const [open, setOpen] = React.useState(false)
  // How it was opened decides whether focus moves into the list. A CLICK should hand the keyboard
  // the links; a hover must not yank focus out of whatever the reader was doing.
  const openedByHover = React.useRef(false)
  const closeTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  React.useEffect(() => () => clearTimeout(closeTimer.current), [])

  // Touch has no hover: a tap fires `pointerenter` first, so without this guard the list would
  // open under the finger and then be toggled shut again by the click that follows. Excluded
  // rather than allow-listing `mouse`, so a pen (which does hover) and any device that reports
  // nothing still get the hover behaviour.
  const isHover = (event: React.PointerEvent) => event.pointerType !== 'touch'
  const cancelClose = () => clearTimeout(closeTimer.current)
  const onPointerEnter = (event: React.PointerEvent) => {
    if (!isHover(event)) return
    cancelClose()
    openedByHover.current = true
    setOpen(true)
  }
  // On a DELAY, and the same handler on the trigger and the content: the two are separate
  // elements with a 4px gap between them, so an instant close would make the list impossible to
  // reach with the pointer.
  const onPointerLeave = (event: React.PointerEvent) => {
    if (!isHover(event)) return
    cancelClose()
    closeTimer.current = setTimeout(() => setOpen(false), HOVER_CLOSE_DELAY_MS)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-slot="reference-overflow"
          aria-label={`Show all ${references.length} references for ${taskTitle}`}
          onPointerEnter={onPointerEnter}
          onPointerLeave={onPointerLeave}
          // A real press — mouse, tap or keyboard — is not a hover, whatever happened before it.
          onPointerDown={() => {
            openedByHover.current = false
          }}
          onClick={() => {
            openedByHover.current = false
          }}
          className="shrink-0 rounded-full px-1 text-[11px] font-medium text-soft-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          +{hidden}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-auto min-w-40 p-1.5"
        data-slot="reference-overflow-list"
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onOpenAutoFocus={(event) => {
          if (openedByHover.current) event.preventDefault()
        }}
        onCloseAutoFocus={(event) => {
          if (openedByHover.current) event.preventDefault()
        }}
      >
        <p className="px-1 pb-1.5 text-[10.5px] text-soft-foreground">References</p>
        <span className="flex flex-col items-start gap-1">
          {references.map((reference) => (
            <ReferenceChip
              key={`${reference.kind}#${reference.number}`}
              reference={reference}
              taskTitle={taskTitle}
              projectId={projectId}
            />
          ))}
        </span>
      </PopoverContent>
    </Popover>
  )
}

/**
 * A project's tag, in a table cell.
 *
 * Deliberately QUIET — muted, like the branch chip beside it. Tags repeat on every row of a
 * project, so painting them in the accent turned a whole column into the loudest thing on the
 * page while saying the least: they are context for the row, not its status. The violet is spent
 * where it earns attention instead — the status dot, the reference chips, and a tag chip in the
 * FILTER bar, where being selected is a state worth seeing.
 */
export function TagChip({ tag, className }: { tag: string; className?: string }) {
  return (
    <span
      data-slot="project-tag"
      className={cn(
        'inline-flex max-w-full items-center truncate rounded-full bg-muted px-1.5 py-px text-[10.5px] font-medium text-muted-foreground',
        className,
      )}
    >
      {tag}
    </span>
  )
}

/**
 * One CPU or Mem cell — the per-project table's exact grammar, so the two read alike: a LIVE
 * sample is emphasized, a finished run's persisted peak is dimmed and says so, and anything
 * else is an honest em dash rather than an invented zero.
 */
function UsageTd({ column, cell }: { column: 'cpu' | 'memory'; cell: UsageCell }) {
  return (
    <td
      data-usage={column === 'memory' ? 'mem' : column}
      data-usage-kind={cell.kind}
      title={cell.title}
      className={cn(
        TD_BASE,
        'hidden text-right font-mono tabular-nums xl:table-cell',
        cell.kind === 'live' && 'bg-violet/5 text-xs font-medium text-foreground',
        cell.kind === 'peak' && 'text-[11.5px] text-soft-foreground',
        cell.kind === 'none' && 'text-xs text-soft-foreground',
      )}
    >
      {cell.text || '—'}
    </td>
  )
}

/** The cross-project Context cell (`45k / 200k`): current window occupancy over the model's max,
 *  tinted amber past 75% and danger past 90%. Hidden below `xl` like the CPU/Mem cells, and
 *  reading straight off the index row (`run.contextTokens`/`contextWindow`). */
function ContextTd({ cell }: { cell: ContextCell }) {
  const tint =
    cell.ratio === undefined
      ? 'text-muted-foreground'
      : cell.ratio >= 0.9
        ? 'text-danger'
        : cell.ratio >= 0.75
          ? 'text-pending-strong'
          : 'text-muted-foreground'
  return (
    <td
      data-context-ratio={cell.ratio !== undefined ? cell.ratio.toFixed(2) : undefined}
      className={cn(TD_BASE, 'hidden text-right font-mono text-xs tabular-nums xl:table-cell', tint)}
    >
      {cell.text || '—'}
    </td>
  )
}

function Dash() {
  return <span className="text-xs text-soft-foreground">—</span>
}

/** The middot between a card's meta pieces — decorative, so hidden from the a11y tree. */
function Sep() {
  return (
    <span className="text-soft-foreground" aria-hidden="true">
      ·
    </span>
  )
}

/** What an empty global list honestly means, given how it got empty. */
function GlobalTasksEmptyState({ view, filtered }: { view: ListView; filtered: boolean }) {
  if (filtered) {
    return (
      <CenteredState
        heading="h2"
        icon={<SearchXIcon />}
        tone="neutral"
        title="No matching tasks"
        subtitle="No task in any project matches these filters."
      />
    )
  }
  return view === 'archived' ? (
    <CenteredState
      heading="h2"
      icon={<ArchiveIcon />}
      tone="neutral"
      title="Nothing archived yet"
      subtitle="Finished tasks you archive land here, from every project."
    />
  ) : (
    <CenteredState
      heading="h2"
      icon={<ListChecksIcon />}
      tone="neutral"
      title="No tasks yet"
      subtitle="Start a task in any project and it shows up here."
    />
  )
}
