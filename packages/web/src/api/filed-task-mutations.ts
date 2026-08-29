import { useMutation, useQueryClient } from '@tanstack/react-query'

import { startWorkspaceTodo, updateWorkspaceTodo } from '@/api/client'
import { workspaceQueryKeys } from '@/api/queries'
import type {
  UpdateTodoInput,
  WorkspaceTodoEntry,
  WorkspaceTodosResponse,
} from '@loki-labs/better-cezar-api-client'
import { toast } from '@/components/ui/toaster'
import { applyFiledPatch } from '@/lib/filed-tasks'
import { scopeTo, useNavigate } from '@/lib/project-router'

/**
 * The Filed table's Start and Archive/Restore mutations for ONE task — moved out of
 * `routes/global-tasks.tsx` (`.ai/specs/2026-08-29-filed-task-detail-page.md`, Phase 1) so both the
 * board and the standalone `/p/:projectId/todos/:todoId` page can use them without a route module
 * importing another route module (the cycle this file exists to avoid). The board's own bulk
 * `useStartFiledTasks` and every runs-table mutation stay in `global-tasks.tsx` — nothing outside
 * the Filed table needs those.
 */

/** Start one filed task in its own project and follow it into the run — the `startTodo` mutation
 *  the Inbox card already uses, with the project named explicitly rather than taken from scope. */
export function useStartFiledTask() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  return useMutation({
    mutationFn: ({ projectId, todoId }: { projectId: string; todoId: string }) =>
      startWorkspaceTodo(projectId, todoId),
    onSuccess: (result, { projectId }) => {
      // The todo is now a run: it leaves this list and joins the table below it.
      void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.workspaceTodos })
      void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.runsIndex })
      void navigate(scopeTo(projectId, `/tasks/${result.run.id}`))
    },
    onError: (error) => toast(error.message, { tone: 'danger' }),
  })
}

/** Every partitioned page of the Filed board, by prefix — `['workspace','todos','page', …]`.
 *  Both partitions and every `(sort, dir, limit, facet)` combination sit under it, which is what
 *  lets one `setQueriesData` reach the row wherever it is cached. */
const FILED_PAGE_KEY_PREFIX = ['workspace', 'todos', 'page'] as const

/**
 * The status/priority edit and Archive/Restore action for one filed row
 * (2026-08-17-filed-tasks-table-statuses.md) — patches the WORKSPACE TODOS cache.
 *
 * Optimistic, keyed by the `(project, id)` PAIR: two projects could only theoretically share a
 * uuid, but that pair is what the row key (`${entry.project}:${entry.todo.id}`) already uses, so
 * it is what the cache patch keys on too (the spec's own Risks note).
 */
export function useUpdateFiledTodo() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ entry, patch }: { entry: WorkspaceTodoEntry; patch: UpdateTodoInput }) =>
      updateWorkspaceTodo(entry.project, entry.todo.id, patch),
    onMutate: async ({ entry, patch }) => {
      await queryClient.cancelQueries({ queryKey: workspaceQueryKeys.workspaceTodos })
      const previous = queryClient.getQueryData<WorkspaceTodosResponse>(workspaceQueryKeys.workspaceTodos)
      queryClient.setQueryData<WorkspaceTodosResponse>(workspaceQueryKeys.workspaceTodos, (current) =>
        current === undefined
          ? current
          : {
              ...current,
              todos: current.todos.map((row) =>
                row.project === entry.project && row.todo.id === entry.todo.id
                  ? { ...row, todo: applyFiledPatch(row.todo, patch) }
                  : row,
              ),
            },
      )
      // On the PARTITIONED pages the optimistic move is a REMOVAL, not a patch
      // (2026-08-25-split-active-backlog-tables.md, Risks). A status change can move a row from
      // Active to Backlog or back, and no client-side patch can place it at its server-decided
      // rank in the other table — but removal is always correct: archive removes it, and a
      // partition-crossing change removes it from where it was. The visible half keeps the
      // instant-archive feel; the arrival side is settled by the invalidation below.
      const previousPages = queryClient.getQueriesData<WorkspaceTodosResponse>({
        queryKey: FILED_PAGE_KEY_PREFIX,
      })
      queryClient.setQueriesData<WorkspaceTodosResponse>({ queryKey: FILED_PAGE_KEY_PREFIX }, (current) =>
        current === undefined
          ? current
          : {
              ...current,
              todos: current.todos.filter(
                (row) => !(row.project === entry.project && row.todo.id === entry.todo.id),
              ),
            },
      )
      return { previous, previousPages }
    },
    onError: (error: Error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(workspaceQueryKeys.workspaceTodos, context.previous)
      }
      for (const [key, data] of context?.previousPages ?? []) {
        queryClient.setQueryData(key, data)
      }
      toast(error.message, { tone: 'danger' })
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.workspaceTodos })
    },
  })
}
