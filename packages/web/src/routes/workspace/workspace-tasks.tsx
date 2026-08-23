import { useQueryClient } from '@tanstack/react-query'
import { ListChecksIcon, PlusIcon, SearchIcon, SearchXIcon, TriangleAlertIcon } from 'lucide-react'
import * as React from 'react'
import { Link as RouterLink, useSearchParams } from 'react-router'

import { putWorkspaceUiState } from '@/api/client'
import { useHealth, useProjects, useWorkspaceRuns, useWorkspaceUiState, workspaceQueryKeys } from '@/api/queries'
import { workspaceViewsOffSubtitle } from '@/lib/capability-copy'
import type { RunRecord, Runner, WorkspaceRunSummary } from '@loki-labs/better-cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { DiffStatLabel } from '@/components/diff-stat'
import { HostUsageStat } from '@/components/host-usage-stat'
import { Pill } from '@/components/pill'
import { ProjectFilter } from '@/components/project-filter'
import { ReferenceChip } from '@/components/reference-chip'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { deriveAttention } from '@/lib/attention'
import { shortAge } from '@/lib/format'
import { isReadDoneItem, isUnread } from '@/lib/read-state'
import { queueHold, usageLimitHolds } from '@/lib/account-hold'
import { queuePositions, runTitle, sortRuns } from '@/lib/task-groups'
import { filterRuns, formatCost, scheduledResume, taskReference, workflowLabel } from '@/lib/tasks-table'
import { useNow } from '@/lib/use-now'
import { cn } from '@/lib/utils'
import {
  resolveWorkspaceTasksFilter,
  sameWorkspaceTasksFilter,
  workspaceTasksSearchParams,
  workspaceTasksUiStatePatch,
  type WorkspaceTasksFilter,
  type WorkspaceTasksView,
} from './workspace-filter-state'

/**
 * `/workspace/tasks` (F3 feature A, `CEZ_WORKSPACE_VIEWS=1`).
 * `.ai/specs/2026-08-06-workspace-notes-cross-project.md` ("UI/UX" → "Workspace Tasks board").
 *
 * Workspace-level — mounted OUTSIDE `ProjectScopeRoute` (`routes.tsx`), reached from the
 * `[ This project | All projects ]` switch `tasks-overview.tsx` renders in its header
 * (scaffold-owned, PLAN D22c). **This file reads only `useHealth`, `useProjects`,
 * `useWorkspaceRuns`, `useWorkspaceUiState` and `putWorkspaceUiState` — never a scope-led query or
 * client function** (the "scope trap": with no `ProjectScopeRoute` above it, `queryScope()`
 * silently resolves to the boot project's `'default'` sentinel, so a project-local call here would
 * read data for the wrong repo with no error). `useProjects()` (`GET /api/v1/projects`) is safe
 * here despite the rule: it is workspace-level by construction, "one registry no matter which
 * project is active" (its own doc comment), so it never touches `queryScope()` either — it is
 * added (multi-project spec, foreign-number guard phase) so each cross-project ROW can resolve
 * its OWN project's `repoUrl`, never the boot project's. `workspace-tasks.test.tsx` asserts the
 * scope-led rule by request log (no `/api/v1/p/*` request), which this does not violate.
 *
 * **Divergence from the spec's literal wording, recorded here because the spec's "UI/UX" section
 * says "Reuses TasksOverview" and separately describes a row-href edit "inside the component":**
 * that edit — a row's `to` becoming `/p/<project>/tasks/<id>` instead of the scope-relative
 * `/tasks/<id>` — never landed in `tasks-overview.tsx` (checked: `git diff HEAD -- ...
 * tasks-overview.tsx` shows only the `showWorkspaceSwitch` prop and header switch; nothing about
 * row hrefs or a project column). That file is scaffold-owned and PLAN-listed as "edited once, by
 * the scaffold ... no package in this spec touches [it] afterwards", and it is not in this
 * package's file list, so it stays untouched here. Reusing `<TasksOverview>` as-is would send
 * every row through the scope-relative `Link`, which is exactly the wrong-project navigation the
 * scope trap warns about, and its `onArchiveFinished`/`onMarkAllRead`/`onRename` callbacks have
 * no project-aware implementation to wire them to from a workspace-level route. So this file
 * builds its own presentational board instead — the same visual grammar (status pill, attention,
 * age, diff stat, reference chip) by importing the SAME pure deciders `TasksOverview` uses
 * (`lib/attention.ts`, `lib/task-groups.ts`, `lib/tasks-table.ts`, `lib/read-state.ts`) through a
 * small adapter (`toWorkspaceRunRow`, below), never a second, drifting copy of that grammar — but
 * read-only (no archive/mark-all-read/rename), matching the server route family it renders,
 * which is itself read-only by design (no mutator to 409 in "feature A").
 */

/** `WorkspaceRunSummary` widened with the one field every row here actually needs beyond
 *  `RunRecord`: which project it came from. */
type WorkspaceRunRow = RunRecord & { project: string }

/**
 * Adapts the aggregate's deliberately-narrow `WorkspaceRunSummary` (Q10: NOT a narrowing of
 * `runRecordSchema`) into the full `RunRecord` shape the shared presentational `lib/*` deciders
 * are typed against. Every field `RunRecord` requires that the summary does not carry gets an
 * inert default — `task: ''`, `steps: []` — and nothing this board renders reads either: the
 * summary excludes them for exactly that reason (the "megabytes for a table" argument, Q10). The
 * one honest cost: `runTitle`'s "malformed auto-summary" fallback and `workflowLabel`'s
 * `(planned)`/`(inbox)` step-name lookup both key off fields the summary never carried
 * (`titleOrigin`, `steps`), so those two edge cases degrade to their un-narrowed default reading
 * here — the same limitation every consumer of `WorkspaceRunSummary` has, not one this adapter
 * introduces.
 */
function toWorkspaceRunRow(run: WorkspaceRunSummary): WorkspaceRunRow {
  return {
    ...run,
    task: '',
    steps: [],
    tokensUsed: run.tokensUsed ?? 0,
    archived: run.archived ?? false,
  }
}

/** The URL/ui-state filter controller, wired to real hooks on top of the pure
 *  `workspace-filter-state.ts` module. */
function useWorkspaceTasksFilter(registryIds: readonly string[] | undefined) {
  const [searchParams, setSearchParams] = useSearchParams()
  const uiState = useWorkspaceUiState()
  const queryClient = useQueryClient()
  const resolved = resolveWorkspaceTasksFilter(searchParams, uiState.data, registryIds)
  const filter = resolved.filter

  // Self-heal a stale bookmark: an id the URL named that is no longer registered is dropped from
  // what renders, AND the address bar is corrected (`replace`, not `push` — this is not a new
  // navigation entry) so the stale id does not keep surviving copy-paste.
  const rewriteKey = `${resolved.needsUrlRewrite}:${filter.projects?.join(',') ?? ''}:${filter.view}`
  React.useEffect(() => {
    if (!resolved.needsUrlRewrite) return
    setSearchParams(workspaceTasksSearchParams(filter), { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rewriteKey])

  const setFilter = React.useCallback(
    (next: WorkspaceTasksFilter) => {
      if (sameWorkspaceTasksFilter(next, filter)) return
      setSearchParams(workspaceTasksSearchParams(next), { replace: false })
      // Mirror as the last-used selection — one discrete PUT per pick (not a text field, so no
      // debounce is needed, unlike `LastLocationController`'s per-keystroke navigation writes).
      void putWorkspaceUiState(workspaceTasksUiStatePatch(next))
        .then((merged) => queryClient.setQueryData(workspaceQueryKeys.uiState, merged))
        .catch(() => void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.uiState }))
    },
    [filter, queryClient, setSearchParams],
  )

  return { filter, setFilter }
}

export function WorkspaceTasksRoute() {
  const health = useHealth()
  const workspaceViewsAvailable = health.data?.capabilities?.workspaceViews === true
  const workspaceViewsOff = health.data !== undefined && !workspaceViewsAvailable
  const registry = health.data?.projects

  const { filter, setFilter } = useWorkspaceTasksFilter(registry?.map((p) => p.id))
  const projectsQuery = filter.projects === undefined ? undefined : filter.projects.join(',')
  const runsQuery = useWorkspaceRuns({ projects: projectsQuery, view: filter.view })
  // Called ONCE here, in the route's body — never per-row. Each row resolves ITS OWN project's
  // repo out of this map (multi-project spec Phase 5): unlike a project-scoped page, this board
  // has no single on-screen project, so `useProjectRepoBase()` does not apply here.
  const projects = useProjects()
  const repoByProject = React.useMemo(() => {
    const map = new Map<string, string>()
    for (const project of projects.data?.projects ?? []) {
      if (project.repoUrl) map.set(project.id, project.repoUrl)
    }
    return map
  }, [projects.data])

  return (
    <div data-route="workspace-tasks" className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 hidden h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-5 md:flex">
        <h1 className="text-base font-semibold">Tasks — all projects</h1>
        {workspaceViewsAvailable ? (
          <>
            <ViewTabs view={filter.view} onChange={(view) => setFilter({ ...filter, view })} />
            <ProjectFilter
              options={registry ?? []}
              selected={filter.projects}
              onChange={(projects) => setFilter({ ...filter, projects })}
            />
          </>
        ) : null}
        {/* The entry point onto `/workspace/new` (spec Phase 3,
            `.ai/specs/2026-08-14-project-less-task-composer.md`) — an action, not a nav row
            (`nav-items.ts` stays untouched, per the spec's Architecture section). Unconditional:
            it is gated by `CEZ_WORKSPACE_VIEWS`, not `CEZ_NOTES`, and the destination already
            renders its own honest "off" state when notes is off (D19's pattern), never a 404. */}
        <HostUsageStat className="ml-auto" />
        <Button asChild size="sm">
          <RouterLink to="/workspace/new">
            <PlusIcon />
            New task
          </RouterLink>
        </Button>
      </header>

      <div className="flex flex-1 flex-col p-3 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-5 md:pb-5">
        {workspaceViewsOff ? (
          <CenteredState
            icon={<ListChecksIcon />}
            tone="neutral"
            title="The cross-project board is off"
            subtitle={workspaceViewsOffSubtitle(health.data?.capabilities?.singleProject)}
            heading="h2"
          />
        ) : !workspaceViewsAvailable ? null : (
          <WorkspaceTasksBoard
            filter={filter}
            onClearFilter={() => setFilter({ projects: undefined, view: filter.view })}
            runsQuery={runsQuery}
            repoByProject={repoByProject}
            defaultRunner={health.data?.defaultRunner}
          />
        )}
      </div>
    </div>
  )
}

function ViewTabs({ view, onChange }: { view: WorkspaceTasksView; onChange: (view: WorkspaceTasksView) => void }) {
  return (
    <div className="inline-flex gap-0.5 rounded-md bg-muted p-[3px]">
      {(['active', 'archived'] as const).map((tab) => (
        <button
          key={tab}
          type="button"
          data-slot="workspace-view-tab"
          data-view={tab}
          aria-pressed={tab === view}
          onClick={() => onChange(tab)}
          className={cn(
            'flex h-7 items-center justify-center rounded-[7px] px-3 text-[12.5px] font-medium text-muted-foreground capitalize',
            tab === view && 'bg-card font-semibold text-foreground shadow-xs',
          )}
        >
          {tab}
        </button>
      ))}
    </div>
  )
}

/** The body: the dead-project warning strip, the "filter matches nothing" state, the empty
 *  state, and the table/cards — split from the route component so the loading/data-shape logic
 *  is one readable block. `runsQuery` is the raw `useWorkspaceRuns` result (kept as a prop rather
 *  than re-derived) so a test can drive this in isolation from the URL/ui-state plumbing above. */
function WorkspaceTasksBoard({
  filter,
  onClearFilter,
  runsQuery,
  repoByProject,
  defaultRunner,
}: {
  filter: WorkspaceTasksFilter
  onClearFilter: () => void
  runsQuery: ReturnType<typeof useWorkspaceRuns>
  /** Registered project id -> its own repo, from `useProjects()` (read once by
   *  `WorkspaceTasksRoute`) — the only authority a row's numeric-only PR/Issue chip may
   *  synthesize a link against (#526), and it must be THAT row's project, never the boot one. */
  repoByProject: ReadonlyMap<string, string>
  /** The workspace's configured default runner — names the account a queued task will take when
   *  its own record does not. See `queueHold`. */
  defaultRunner?: Runner
}) {
  const [query, setQuery] = React.useState('')
  const now = useNow(30_000)

  // An explicit "nothing selected" is a real answer, distinct from "no tasks yet" — it needs no
  // network read at all to explain itself.
  if (filter.projects !== undefined && filter.projects.length === 0) {
    return (
      <CenteredState
        heading="h2"
        icon={<SearchXIcon />}
        tone="neutral"
        title="No projects match this filter"
        subtitle="The project filter is set to nothing."
        actions={
          <Button variant="outline" size="sm" onClick={onClearFilter}>
            Clear filter
          </Button>
        }
      />
    )
  }

  if (runsQuery.isError) {
    return (
      <CenteredState
        heading="h2"
        icon={<TriangleAlertIcon />}
        tone="danger"
        title="Could not load the board"
        subtitle={runsQuery.error.message}
      />
    )
  }

  const data = runsQuery.data
  const unhealthy = data?.projects.filter((p) => !p.ok) ?? []
  // `runs === undefined` while the aggregate has not answered yet — the header renders, the body
  // stays empty rather than flashing "no tasks yet" (the same "an empty state before we know
  // there are no runs would be a lie" rule `tasks-overview.tsx` follows for `useRuns()`).
  const runs = data === undefined ? undefined : data.runs.map(toWorkspaceRunRow)
  // `sortRuns`/`filterRuns` are typed against `RunRecord[]` (they predate this feature and are
  // shared with the single-project table) and so widen their return type back to it — the cast
  // is safe because both only filter and reorder the SAME elements, never construct new ones, so
  // every element handed back is still the `WorkspaceRunRow` this module built.
  const visible =
    runs === undefined ? undefined : (filterRuns(sortRuns(runs, filter.view), query) as WorkspaceRunRow[])
  const positions = runs === undefined ? undefined : queuePositions(runs)
  // A usage limit closes an ACCOUNT, and one account drives tasks in several projects at once —
  // so this is derived from the whole aggregate, exactly like the engine's workspace-scoped hold.
  const holds = usageLimitHolds(runs ?? [])
  const projectNames = new Map((data?.projects ?? []).map((p) => [p.id, p.name] as const))

  return (
    <>
      {unhealthy.length > 0 ? (
        <div
          data-slot="workspace-runs-warning"
          className="mb-3 flex flex-col gap-1 rounded-lg border border-danger/25 bg-danger/10 px-3.5 py-2.5 text-[12.5px] text-danger"
        >
          {unhealthy.map((project) => (
            <div key={project.id} className="flex items-center gap-1.5">
              <TriangleAlertIcon className="size-3.5 shrink-0" aria-hidden="true" />
              <span>
                <strong className="font-semibold">{project.name || project.id}</strong>
                {project.reason ? ` — ${project.reason}` : ' — could not be read'}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {runs !== undefined ? (
        <div className="relative mb-3 w-60">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-soft-foreground"
            aria-hidden="true"
          />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search tasks…"
            aria-label="Search tasks"
            className="h-9 w-full rounded-md border border-input bg-card pr-3 pl-8 text-[13px] text-foreground outline-none placeholder:text-soft-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          />
        </div>
      ) : null}

      {visible === undefined ? null : visible.length === 0 ? (
        <WorkspaceTasksEmptyState view={filter.view} query={query} />
      ) : (
        <>
          <div
            data-slot="workspace-tasks-table"
            className="hidden overflow-x-auto rounded-lg border border-border bg-card shadow-xs md:block"
          >
            <table className="w-full min-w-[1080px] border-collapse">
              <thead>
                <tr>
                  <Th>Status</Th>
                  <Th>Task</Th>
                  <Th>Project</Th>
                  <Th>Workflow</Th>
                  <Th>Branch</Th>
                  <Th>±</Th>
                  <Th>Ref</Th>
                  <Th right>Cost</Th>
                  <Th right>Started</Th>
                </tr>
              </thead>
              <tbody className="[&>tr:last-child>td]:border-b-0">
                {visible.map((run) => (
                  <WorkspaceTaskRow
                    key={`${run.project}/${run.id}`}
                    run={run}
                    projectName={projectNames.get(run.project)}
                    queuePosition={run.status === 'queued' ? (positions?.get(run.id) ?? null) : null}
                    hold={queueHold(run, holds, defaultRunner)}
                    now={now}
                    repoBase={repoByProject.get(run.project)}
                  />
                ))}
              </tbody>
            </table>
          </div>

          <div data-slot="workspace-task-cards" className="flex flex-col gap-2.5 md:hidden">
            {visible.map((run) => (
              <WorkspaceTaskCard
                key={`${run.project}/${run.id}`}
                run={run}
                projectName={projectNames.get(run.project)}
                hold={queueHold(run, holds, defaultRunner)}
                now={now}
                repoBase={repoByProject.get(run.project)}
              />
            ))}
          </div>
        </>
      )}
    </>
  )
}

function WorkspaceTasksEmptyState({ view, query }: { view: WorkspaceTasksView; query: string }) {
  const needle = query.trim()
  return (
    <div data-slot="workspace-tasks-empty" data-empty-kind={needle ? 'search-miss' : 'no-tasks'}>
      {needle ? (
        <CenteredState
          heading="h2"
          icon={<SearchXIcon />}
          tone="neutral"
          title="No matching tasks"
          subtitle={`No tasks match “${needle}”.`}
        />
      ) : (
        <CenteredState
          heading="h2"
          icon={<ListChecksIcon />}
          tone="neutral"
          title={view === 'archived' ? 'Nothing archived yet' : 'No tasks yet'}
          subtitle={
            view === 'archived'
              ? 'Finished tasks archived across your registered projects land here.'
              : 'Tasks across your registered projects will show up here.'
          }
        />
      )}
    </div>
  )
}

function Th({ children, right = false }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th
      className={cn(
        'h-[38px] border-b border-border px-2.5 text-left text-[11px] font-semibold tracking-[0.05em] whitespace-nowrap text-soft-foreground uppercase first:pl-4 last:pr-4',
        right && 'text-right',
      )}
    >
      {children}
    </th>
  )
}

const TD_BASE = 'h-11 border-b border-border px-2.5 whitespace-nowrap first:pl-4 last:pr-4'

/** The project chip — every row's one addition over the single-project table. Shows the
 *  registered name; the id rides the tooltip so `chat` vs `chat-fork` is checkable on hover. */
function ProjectChip({ id, name }: { id: string; name: string | undefined }) {
  return (
    <span
      data-slot="workspace-run-project"
      title={id}
      className="inline-flex h-[22px] items-center rounded-full border border-border bg-muted px-2 text-[11px] font-medium text-muted-foreground"
    >
      {name ?? id}
    </span>
  )
}

function WorkspaceTaskRow({
  run,
  projectName,
  queuePosition,
  hold,
  now,
  repoBase,
}: {
  run: WorkspaceRunRow
  projectName: string | undefined
  queuePosition: number | null
  /** Why this queued run is not starting, when the answer is a held agent account. */
  hold: ReturnType<typeof queueHold>
  now: number
  /** This row's OWN project's repo, resolved by the board from `run.project` — see
   *  `WorkspaceTasksBoard`'s doc comment on `repoByProject`. */
  repoBase: string | undefined
}) {
  const attention = deriveAttention(run)
  const scheduled = scheduledResume(run)
  const to = `/p/${run.project}/tasks/${run.id}`
  const cost = formatCost(run.costUsd)
  const reference = taskReference(run, repoBase)
  const unread = isUnread(run)
  const readDone = isReadDoneItem(run)
  const title = runTitle(run)

  return (
    <tr data-slot="workspace-task-row" data-run-id={run.id} data-project={run.project} className="hover:bg-muted">
      <td className={TD_BASE}>
        <Pill dot={attention.tone} pulse={attention.pulse} title={scheduled?.title ?? hold?.title}>
          {attention.label}
          {scheduled ? <span className="tabular-nums">{scheduled.label}</span> : null}
          {hold ? <span className="tabular-nums">held {hold.label}</span> : null}
        </Pill>
      </td>
      <td className={cn(TD_BASE, 'w-[28%] max-w-0')}>
        <span className="flex min-w-0 items-center gap-1.5">
          {/* Unscoped on purpose — `RouterLink`, never the project-scoped `Link`: a row here can
              belong to ANY registered project, not the ambient (boot) scope. See the module
              doc's divergence note. */}
          <RouterLink
            to={to}
            title={title}
            className={cn(
              'min-w-0 truncate text-[13px]',
              unread ? 'font-semibold text-foreground' : readDone ? 'font-medium text-muted-foreground' : 'font-medium',
            )}
          >
            {title}
          </RouterLink>
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
      <td className={TD_BASE}>
        <ProjectChip id={run.project} name={projectName} />
      </td>
      <td className={cn(TD_BASE, 'text-[12.5px] text-muted-foreground')}>{workflowLabel(run)}</td>
      <td className={TD_BASE}>{run.branch ? <BranchChip branch={run.branch} /> : <Dash />}</td>
      <td className={TD_BASE}>{run.diffStat ? <DiffStatLabel stat={run.diffStat} /> : <Dash />}</td>
      <td className={TD_BASE}>{reference ? <ReferenceChip reference={reference} taskTitle={title} /> : <Dash />}</td>
      {queuePosition !== null ? (
        <td
          data-slot="queue-note"
          className={cn(TD_BASE, 'text-right font-mono text-[11.5px] text-soft-foreground')}
          title={hold?.title}
        >
          {/* `#1 in queue` alone reads as "next to start", which a held run is not. */}
          #{queuePosition} {hold ? 'held' : 'in queue'}
        </td>
      ) : (
        <td className={cn(TD_BASE, 'text-right font-mono text-xs text-muted-foreground tabular-nums')}>
          {cost || <Dash />}
        </td>
      )}
      <td className={cn(TD_BASE, 'text-right text-xs text-soft-foreground tabular-nums')}>
        {shortAge(run.startedAt ?? run.createdAt, now)}
      </td>
    </tr>
  )
}

function WorkspaceTaskCard({
  run,
  projectName,
  hold,
  now,
  repoBase,
}: {
  run: WorkspaceRunRow
  projectName: string | undefined
  /** Why this queued run is not starting — see `WorkspaceTaskRow`. */
  hold: ReturnType<typeof queueHold>
  now: number
  /** This card's OWN project's repo — see `WorkspaceTaskRow`'s doc comment on the prop. */
  repoBase: string | undefined
}) {
  const attention = deriveAttention(run)
  const scheduled = scheduledResume(run)
  const to = `/p/${run.project}/tasks/${run.id}`
  const reference = taskReference(run, repoBase)
  const unread = isUnread(run)
  const readDone = isReadDoneItem(run)
  const cost = formatCost(run.costUsd)
  const title = runTitle(run)

  return (
    <div
      data-slot="workspace-task-card"
      data-run-id={run.id}
      data-project={run.project}
      className="rounded-lg border border-border bg-card px-3.5 py-3 shadow-xs"
    >
      <div className="flex items-start gap-2.5">
        <Pill dot={attention.tone} pulse={attention.pulse} className="mt-px shrink-0" title={scheduled?.title ?? hold?.title}>
          {attention.label}
          {scheduled ? <span className="tabular-nums">{scheduled.label}</span> : null}
          {hold ? <span className="tabular-nums">held {hold.label}</span> : null}
        </Pill>
        <RouterLink
          to={to}
          className={cn(
            'min-w-0 flex-1 text-[13.5px] leading-[1.35]',
            unread ? 'font-semibold text-foreground' : readDone ? 'font-medium text-muted-foreground' : 'font-medium',
          )}
        >
          {title}
        </RouterLink>
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
          {shortAge(run.finishedAt ?? run.createdAt, now)}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 font-mono text-[11.5px] font-medium text-muted-foreground tabular-nums">
        <ProjectChip id={run.project} name={projectName} />
        <Sep />
        <span>{workflowLabel(run)}</span>
        {run.branch ? (
          <>
            <Sep />
            <span>{run.branch}</span>
          </>
        ) : null}
        {run.diffStat ? (
          <>
            <Sep />
            <DiffStatLabel stat={run.diffStat} className="text-[11.5px]" />
          </>
        ) : null}
        {cost ? (
          <>
            <Sep />
            <span>{cost}</span>
          </>
        ) : null}
        {reference ? <ReferenceChip reference={reference} taskTitle={title} className="h-5" /> : null}
      </div>
    </div>
  )
}

function Dash() {
  return <span className="text-xs text-soft-foreground">—</span>
}

function Sep() {
  return (
    <span className="text-soft-foreground" aria-hidden="true">
      ·
    </span>
  )
}

function BranchChip({ branch }: { branch: string }) {
  return (
    <span className="rounded-[6px] bg-muted px-1.5 py-0.5 font-mono text-[11.5px] font-medium text-muted-foreground">
      {branch}
    </span>
  )
}
