import { CheckIcon } from 'lucide-react'
import { Link } from 'react-router'

import type { FiledPriority, FiledStatus } from '@/lib/filed-tasks'
import { filedStatus } from '@/lib/filed-tasks'
import type { WorkspaceTodoEntry } from '@loki-labs/cezar-plus-api-client'
import { AuthorCell } from '@/components/author-cell'
import { Pill } from '@/components/pill'
import type { StatusDotTone } from '@/components/status-dot'
import { TaskNodeCell } from '@/components/task-node-cell'
import type { TaskNodeInfo } from '@/lib/task-node'
import { scopeTo } from '@/lib/project-router'
import { Markdown } from '@/routes/task-thread/markdown'

/**
 * The ONE filed-task detail rendering (`.ai/specs/2026-08-29-filed-task-detail-page.md`, Phase 1):
 * moved out of `routes/global-tasks.tsx`'s old `FiledDetailBody` content and its detail-dialog
 * wrapper (now deleted) so the dedicated
 * `/p/:projectId/todos/:todoId` page and the Filed table's own pill/chip can never drift apart —
 * same reasoning as `skill-detail.tsx`'s split for the skills catalog and its preview dialog.
 *
 * `FILED_STATUS_LABEL`/`FILED_PRIORITY_LABEL` live here too: the Filed table's own filter
 * controls (`global-tasks.tsx`) read them a second time, so they moved with the pill/chip that
 * paint them rather than being duplicated.
 */

/** Human labels + dot tones for the closed status enum. `pending` reads as amber in this design
 *  system — `lib/attention.ts`'s own "waiting → amber/pending" note — the closest existing tone to
 *  "needs attention" for a blocked task, without inventing a new dot color for one status. */
export const FILED_STATUS_LABEL: Record<FiledStatus, string> = {
  todo: 'To do',
  'in-progress': 'In progress',
  blocked: 'Blocked',
  done: 'Done',
}

/** Unexported: `FiledStatusPill` below is its only consumer. */
const FILED_STATUS_TONE: Record<FiledStatus, StatusDotTone> = {
  todo: 'neutral',
  'in-progress': 'violet',
  blocked: 'pending',
  done: 'success',
}

export const FILED_PRIORITY_LABEL: Record<FiledPriority, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}

/** A closed-enum status pill — `todo`/`in-progress`/`blocked`/`done` painted in the design
 *  system's dot grammar, same idiom `TaskRow`'s attention pill uses. */
export function FiledStatusPill({ status }: { status: FiledStatus }) {
  return <Pill dot={FILED_STATUS_TONE[status]}>{FILED_STATUS_LABEL[status]}</Pill>
}

/** A dim, quiet chip — priority is context for the row, not its status, so it does not compete
 *  with the status pill for attention. Absent priority renders `—` at the call site instead. */
export function FiledPriorityChip({ priority }: { priority: FiledPriority }) {
  return (
    <span
      data-slot="filed-priority-chip"
      className="inline-flex items-center rounded-full bg-muted px-1.5 py-px text-[10.5px] font-medium text-muted-foreground"
    >
      {FILED_PRIORITY_LABEL[priority]}
    </span>
  )
}

/**
 * The full stored record for one filed task — summary, status, priority, project, author, filed
 * date, archived stamp, node claim, context, what to do, acceptance criteria, knowledge refs.
 *
 * Renders a plain `<h1>` rather than a dialog's `DialogTitle`/`DialogDescription` pair
 * (`.ai/specs/2026-08-29-filed-task-detail-page.md` "The `DialogTitle` substitution"): the page
 * this renders inside has no `Dialog` ancestor, and a page's own heading is its accessible name.
 *
 * `nodeInfo` is resolved by the CALLER and passed in already-ungated: unlike the Filed table
 * (which hides the whole Node column behind `capabilities.cluster`), this page shows a node claim
 * whenever the entry actually carries one (`todo.startedOn` or `todo.placement?.node`), whatever
 * clustering is currently switched to — see `routes/filed-task-detail.tsx` for why that is safe.
 * `undefined` renders no cell at all, not `TaskNodeCell`'s dash — the entry made no claim to show.
 */
export function FiledTaskDetailContent({
  entry,
  nodeInfo,
}: {
  entry: WorkspaceTodoEntry
  nodeInfo?: TaskNodeInfo
}) {
  const { todo } = entry
  const archived = todo.archivedAt !== undefined
  return (
    <div className="min-w-0">
      <h1 className="text-lg font-semibold break-words">{todo.summary}</h1>

      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <FiledStatusPill status={filedStatus(entry)} />
        {todo.priority ? <FiledPriorityChip priority={todo.priority} /> : null}
        <Link
          to={scopeTo(entry.project, '/')}
          className="font-mono text-[11px] text-soft-foreground hover:text-foreground hover:underline"
        >
          {entry.project}
        </Link>
        {todo.ts ? (
          <span className="text-[11px] text-soft-foreground">Filed {new Date(todo.ts).toLocaleString()}</span>
        ) : null}
        <span data-slot="filed-task-author">
          <AuthorCell author={todo.author} />
        </span>
        {archived ? (
          <span data-slot="filed-task-archived" className="text-[11px] text-soft-foreground">
            Archived {new Date(todo.archivedAt!).toLocaleString()}
          </span>
        ) : null}
        {nodeInfo ? <TaskNodeCell info={nodeInfo} /> : null}
      </div>

      {todo.context ? (
        <section className="mt-4">
          <h4 className="text-[11px] font-semibold tracking-[.04em] text-soft-foreground uppercase">Context</h4>
          <div data-slot="filed-task-context" className="mt-1.5 text-sm">
            <Markdown>{todo.context}</Markdown>
          </div>
        </section>
      ) : null}

      {todo.whatToDo ? (
        <section className="mt-4">
          <h4 className="text-[11px] font-semibold tracking-[.04em] text-soft-foreground uppercase">
            What to do
          </h4>
          <div data-slot="filed-task-what-to-do" className="mt-1.5 text-sm">
            <Markdown>{todo.whatToDo}</Markdown>
          </div>
        </section>
      ) : null}

      {todo.acceptanceCriteria && todo.acceptanceCriteria.length > 0 ? (
        <section className="mt-4">
          <h4 className="text-[11px] font-semibold tracking-[.04em] text-soft-foreground uppercase">
            Acceptance criteria
          </h4>
          <ul data-slot="filed-task-acceptance-criteria" className="mt-1.5 flex flex-col gap-1">
            {todo.acceptanceCriteria.map((item, index) => (
              // Index keys are safe here: this list is never reordered or edited in place, only
              // ever rendered whole from the entry the page was loaded with.
              // eslint-disable-next-line react/no-array-index-key
              <li key={index} className="flex items-start gap-1.5 text-sm">
                <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-soft-foreground" aria-hidden="true" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {todo.knowledgeRefs && todo.knowledgeRefs.length > 0 ? (
        <section className="mt-4">
          <h4 className="text-[11px] font-semibold tracking-[.04em] text-soft-foreground uppercase">
            Grounded in
          </h4>
          <ul data-slot="filed-task-knowledge-refs" className="mt-1.5 flex flex-col gap-1">
            {todo.knowledgeRefs.map((ref) => (
              <li key={`${ref.project}/${ref.slug}`}>
                <Link
                  to={`/workspace/knowledge?project=${encodeURIComponent(ref.project)}&doc=${encodeURIComponent(ref.slug)}`}
                  className="text-sm font-medium text-violet hover:underline"
                >
                  {ref.title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}

/** The Start / Archive-or-Restore action pair — the same two actions the old dialog's footer
 *  offered, unchanged in behaviour (`.ai/specs/2026-08-29-filed-task-detail-page.md` "Actions on
 *  the page": Start on an already-Done entry stays available, deliberately). */
export function FiledTaskActions({
  entry,
  onStart,
  onArchive,
  startPending,
  archivePending,
}: {
  entry: WorkspaceTodoEntry
  onStart: (entry: WorkspaceTodoEntry) => void
  onArchive: (entry: WorkspaceTodoEntry, archived: boolean) => void
  startPending: boolean
  archivePending: boolean
}) {
  const archived = entry.todo.archivedAt !== undefined
  return (
    <div className="mt-5 flex items-center gap-2">
      <button
        type="button"
        data-action="filed-task-detail-start"
        onClick={() => onStart(entry)}
        disabled={startPending}
        className="rounded-md border border-border px-2.5 py-1.5 text-[12.5px] font-medium transition-colors hover:bg-muted disabled:opacity-50"
      >
        Start
      </button>
      <button
        type="button"
        data-action={archived ? 'filed-task-detail-restore' : 'filed-task-detail-archive'}
        onClick={() => onArchive(entry, !archived)}
        disabled={archivePending}
        className="rounded-md border border-border px-2.5 py-1.5 text-[12.5px] font-medium transition-colors hover:bg-muted disabled:opacity-50"
      >
        {archived ? 'Restore' : 'Archive'}
      </button>
    </div>
  )
}
