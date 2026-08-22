import type { TaskAuthor } from '@loki-labs/better-cezar-api-client'
import { createContext, useContext, type ReactNode } from 'react'
import { Link, type To } from 'react-router'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { UNATTRIBUTED_LABEL, authorLabel, authorTitle } from '@/lib/task-author'

/**
 * Who made this task, as one narrow cell (`.ai/specs/2026-08-21-task-author-provenance.md`,
 * Phase 4). Shared by the runs table and the Filed table, which carry the same `author` object on
 * two different records.
 *
 * Must be rendered inside a `TooltipProvider` — both call sites already open one for the whole
 * table, which is why this does not mount its own.
 */

/**
 * How to reach the task that spawned this one.
 *
 * A run id alone does not say which project holds it: a workspace run's parent sits in the
 * workspace's own store, not in the project the child landed in. So the LINK is resolved by
 * whoever knows the rows on screen — the cross-project board already loaded every task and can
 * answer, a project-scoped view can answer for its own project, and anything else returns
 * `undefined` and gets a cell that shows the parent without linking to it. That is deliberate: an
 * unlinked parent id is honest, whereas a link to `/p/<wrong-project>/tasks/<id>` is a 404 that
 * looks like a feature.
 *
 * The provider shape follows `ReferenceStatusProvider` in `global-tasks.tsx` — the same problem
 * (a row-level detail only the page can resolve) solved the same way, rather than drilling a
 * function through three components.
 */
const TaskLocationContext = createContext<((taskId: string) => To | undefined) | undefined>(undefined)

export function TaskLocationProvider({
  locate,
  children,
}: {
  locate: (taskId: string) => To | undefined
  children: ReactNode
}) {
  return <TaskLocationContext.Provider value={locate}>{children}</TaskLocationContext.Provider>
}

export function AuthorCell({
  author,
  parentTo,
  className,
}: {
  author: TaskAuthor | undefined
  /** An explicit destination, for callers that already know the scope. Wins over the provider. */
  parentTo?: To
  className?: string
}) {
  const locate = useContext(TaskLocationContext)
  const label = authorLabel(author)
  const title = authorTitle(author)

  if (!author) {
    return (
      <span data-slot="task-author" data-author-kind="none" className={cn('text-soft-foreground', className)}>
        {UNATTRIBUTED_LABEL}
      </span>
    )
  }

  const to = parentTo ?? (author.parentTaskId ? locate?.(author.parentTaskId) : undefined)
  const body =
    to && author.kind === 'agent' ? (
      <Link
        to={to}
        data-slot="task-author-parent-link"
        className="truncate font-mono text-[11.5px] hover:text-foreground hover:underline"
      >
        {label}
      </Link>
    ) : (
      <span className={cn('truncate', author.kind === 'agent' && 'font-mono text-[11.5px]')}>{label}</span>
    )

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-slot="task-author"
          data-author-kind={author.kind}
          data-author-via={author.via}
          className={cn('inline-flex max-w-full min-w-0 items-center text-[12.5px] text-muted-foreground', className)}
        >
          {body}
        </span>
      </TooltipTrigger>
      <TooltipContent side="left">{title}</TooltipContent>
    </Tooltip>
  )
}
