import { Link } from 'react-router'

import type { ApiRun } from '@loki-labs/cezar-plus-api-client'
import { Pill } from '@/components/pill'

function taskWord(count: number): string {
  return count === 1 ? 'task' : 'tasks'
}

export function filedTodosHeading(total: number, marked: number): string {
  if (marked === 0) return `Filed ${total} ${taskWord(total)}`
  if (marked === total) return `Filed ${total} ${taskWord(total)} and marked them all to start`
  return `Filed ${total} ${taskWord(total)}, marked ${marked} of ${total} to start`
}

/** The run-thread receipt for todos filed by input-to-tasks. */
export function FiledTodosCard({ run }: { run: ApiRun }) {
  const filed = run.filedTodos
  if (!filed) return null
  const marked = filed.items.filter((item) => item.autostart === true || item.startedTaskId !== undefined).length

  return (
    <section data-slot="filed-todos-card" className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 shadow-xs">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[13px] font-semibold">{filedTodosHeading(filed.items.length, marked)}</h2>
        <span className="text-[11px] text-soft-foreground">{new Date(filed.at).toLocaleString()}</span>
      </div>
      {filed.items.length === 0 ? (
        <p data-slot="filed-todos-empty" className="text-[12.5px] text-soft-foreground">
          Filed nothing
        </p>
      ) : (
        <ul data-slot="filed-todos-list" className="flex flex-col gap-1.5">
          {filed.items.map((item) => {
            const isMarked = item.autostart === true || item.startedTaskId !== undefined
            const key = `${item.project}:${item.todoId}`
            return (
              <li key={key} data-slot="filed-todo" data-todo-id={item.todoId} className="flex items-center gap-2 text-[12.5px]">
                <Link
                  to={`/tasks?fdetail=${encodeURIComponent(key)}`}
                  data-slot="filed-todo-link"
                  className="min-w-0 flex-1 truncate font-medium hover:underline"
                >
                  {item.summary}
                </Link>
                <span className="shrink-0 text-soft-foreground">{item.project}</span>
                <span data-slot="filed-todo-id" className="shrink-0 font-mono text-[10.5px] text-soft-foreground">
                  {item.todoId}
                </span>
                {isMarked ? <Pill dot="success">Started</Pill> : null}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
