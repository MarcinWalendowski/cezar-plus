import { AlertTriangleIcon, ArrowLeftIcon, SearchXIcon } from 'lucide-react'
import * as React from 'react'
import { Link, useLocation, useParams } from 'react-router'

import { useWorkspaceTodos } from '@/api/queries'
import { useStartFiledTask, useUpdateFiledTodo } from '@/api/filed-task-mutations'
import type { WorkspaceTodoEntry } from '@loki-labs/better-cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { FiledTaskActions, FiledTaskDetailContent } from '@/components/filed-task-detail'
import { useTaskNodeRoster } from '@/components/task-node-cell'
import { filedStatus } from '@/lib/filed-tasks'
import { trackEvent } from '@/lib/analytics'

import { FiledTaskDetailLoading } from './filed-task-detail-loading'

/**
 * `/p/:projectId/todos/:todoId` — the standalone filed-task detail page
 * (`.ai/specs/2026-08-29-filed-task-detail-page.md`), replacing the old detail dialog. Every filed
 * row, in both board views, at every status, links here instead of opening a modal.
 *
 * Reads the SAME `useWorkspaceTodos()` query the board reads (no new endpoint — see the spec's
 * "Where the page's data comes from"), which is what makes a warm click-through instant, a cold
 * direct load and a refresh work by construction, and Archive/Restore optimistic for free: the
 * moved `useUpdateFiledTodo` patches this exact cache key.
 */

type FiledTaskDetail =
  | { state: 'loading' }
  | { state: 'found'; entry: WorkspaceTodoEntry }
  | { state: 'error'; message: string }
  | { state: 'project-unavailable'; projectId: string; reason?: string }
  | { state: 'not-found'; projectId: string; todoId: string }

/**
 * Resolution is an ORDER, not a set of independent checks (Data models): pending before anything
 * else, a failed request before the match (a settled-but-failed query must never read as
 * "this task does not exist"), then the match itself, then a project health row, then genuinely
 * not found.
 */
function resolveFiledTaskDetail(
  query: ReturnType<typeof useWorkspaceTodos>,
  projectId: string,
  todoId: string,
): FiledTaskDetail {
  if (query.isPending) return { state: 'loading' }
  if (query.isError) return { state: 'error', message: query.error.message }
  const entry = query.data.todos.find((row) => row.project === projectId && row.todo.id === todoId)
  if (entry) return { state: 'found', entry }
  const project = query.data.projects.find((row) => row.id === projectId)
  if (project?.ok === false) return { state: 'project-unavailable', projectId, reason: project.reason }
  return { state: 'not-found', projectId, todoId }
}

/** Caller-supplied history state — validated before use. An unvalidated `pathname` out of
 *  `location.state` is an in-app open redirect (Risk 1), so anything that does not match exactly
 *  falls back to `undefined`, which the caller reads as "no state, treat as a direct visit". */
type FiledDetailFrom = { pathname: '/tasks'; search: string; surface: 'table' | 'card' }

function validFrom(state: unknown): FiledDetailFrom | undefined {
  if (typeof state !== 'object' || state === null) return undefined
  const from = (state as { from?: unknown }).from
  if (typeof from !== 'object' || from === null) return undefined
  const { pathname, search, surface } = from as Record<string, unknown>
  if (pathname !== '/tasks') return undefined
  if (typeof search !== 'string' || (search !== '' && !search.startsWith('?'))) return undefined
  if (surface !== 'table' && surface !== 'card') return undefined
  return { pathname, search, surface }
}

export function FiledTaskDetailRoute() {
  const { projectId = '', todoId = '' } = useParams<{ projectId: string; todoId: string }>()
  const location = useLocation()
  const query = useWorkspaceTodos()
  // Ungated on purpose (see `components/filed-task-detail.tsx`'s own doc): this page shows a node
  // claim whenever the entry carries one, whatever `capabilities.cluster` currently says — unlike
  // the board's Node column, which stays behind `nodeRoster.clusterOn`.
  const nodeRoster = useTaskNodeRoster()
  const start = useStartFiledTask()
  const update = useUpdateFiledTodo()

  const detail = resolveFiledTaskDetail(query, projectId, todoId)
  const from = validFrom(location.state)
  const backHref = from ? `/tasks${from.search}` : '/tasks'
  const surface = from?.surface ?? 'direct'
  const foundEntry = detail.state === 'found' ? detail.entry : undefined

  // Emitted once per resolved task (Analytics — "Emitted once, after the entry resolves"): the ref
  // key, not the dependency array, is what makes it once. StrictMode double-mounts this effect in
  // development and an optimistic Archive re-renders `found` with a new `archived` value — both
  // would otherwise double-count. Navigating to a different task changes the key and emits again.
  const emitted = React.useRef<string | null>(null)
  React.useEffect(() => {
    if (!foundEntry) return
    const key = `${projectId}:${todoId}`
    if (emitted.current === key) return
    emitted.current = key
    trackEvent('todo.detail_opened', {
      project: projectId,
      todo: todoId,
      status: filedStatus(foundEntry),
      archived: foundEntry.todo.archivedAt !== undefined,
      surface,
    })
  }, [foundEntry, projectId, todoId, surface])

  if (detail.state === 'loading') return <FiledTaskDetailLoading />

  if (detail.state === 'error') {
    return (
      <PageShell backHref={backHref}>
        <CenteredState
          icon={<AlertTriangleIcon />}
          tone="danger"
          title="Could not load this task"
          subtitle={detail.message}
        />
      </PageShell>
    )
  }

  if (detail.state === 'project-unavailable') {
    return (
      <PageShell backHref={backHref}>
        <CenteredState
          icon={<AlertTriangleIcon />}
          tone="danger"
          title="This project could not be read"
          subtitle={detail.reason ?? `${detail.projectId} is registered but unreadable right now.`}
        />
      </PageShell>
    )
  }

  if (detail.state === 'not-found') {
    return (
      <PageShell backHref={backHref}>
        <CenteredState
          icon={<SearchXIcon />}
          tone="neutral"
          title="Task not found"
          subtitle={`No filed task ${detail.todoId} exists in ${detail.projectId}.`}
        />
      </PageShell>
    )
  }

  const { entry } = detail
  // Ungated node claim (see above): rendered only when the entry actually carries one, so a todo
  // with neither field adds no empty cell — `TaskNodeCell`'s own dash is for the board's gated
  // column, not for this page.
  const nodeInfo =
    entry.todo.startedOn || entry.todo.placement?.node ? nodeRoster.resolve(entry.todo) : undefined

  return (
    <PageShell backHref={backHref}>
      <FiledTaskDetailContent entry={entry} nodeInfo={nodeInfo} />
      <FiledTaskActions
        entry={entry}
        onStart={(entry) => start.mutate({ projectId: entry.project, todoId: entry.todo.id })}
        onArchive={(entry, archived) => update.mutate({ entry, patch: { archived } })}
        startPending={start.isPending}
        archivePending={update.isPending}
      />
    </PageShell>
  )
}

/**
 * The header + back link every one of the five states shares.
 *
 * `Link` here is the RAW `react-router` one, never the scoped `@/lib/project-router` wrapper:
 * `/tasks` is an UNSCOPED route (Risk 1) — the scoped `Link` prefixes any `/`-leading target with
 * the active project, which would turn `/tasks` into `/p/<id>/tasks`, a path that matches no
 * child of `ProjectScopeRoute` and falls to the 404. `global-tasks.tsx` follows the identical
 * discipline for the same reason.
 */
function PageShell({ backHref, children }: { backHref: string; children: React.ReactNode }) {
  return (
    <div data-route="filed-task-detail" data-slot="filed-task-detail" className="flex min-h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <Link
          to={backHref}
          className="inline-flex items-center gap-1 text-[12.5px] font-medium text-muted-foreground hover:text-foreground"
        >
          <ArrowLeftIcon className="size-3.5" aria-hidden="true" />
          Tasks
        </Link>
      </header>
      <div className="flex-1 overflow-y-auto p-4 md:p-6">{children}</div>
    </div>
  )
}
