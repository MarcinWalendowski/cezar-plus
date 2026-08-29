import { describe, expect, it } from 'vitest'

import type { WorkspaceTodoEntry } from '../workspace/todo-index.ts'
import { filedTodoEntriesForRun } from './run.ts'

const entry = (
  project: string,
  todoId: string,
  ts: string,
  summary: string,
  parentTaskId: string,
  options: { autostart?: true; startedTaskId?: string } = {},
): WorkspaceTodoEntry => ({
  project,
  todo: {
    id: todoId,
    ts,
    summary,
    author: {
      kind: 'agent',
      id: parentTaskId,
      via: 'cli-todo-add',
      at: ts,
      parentTaskId,
      agentSessionId: 'session-1',
      parentStepId: 'file',
    },
    ...options,
  },
})

describe('filedTodoEntriesForRun', () => {
  it('returns an empty ledger when the file step filed nothing', () => {
    expect(filedTodoEntriesForRun('run-1', [])).toEqual([])
  })

  it('returns one matching todo with its project and start mark', () => {
    expect(filedTodoEntriesForRun('run-1', [entry('api', 'todo-1', '2026-08-29T00:00:00Z', 'Fix API', 'run-1', { autostart: true })])).toEqual([
      { project: 'api', todoId: 'todo-1', summary: 'Fix API', autostart: true },
    ])
  })

  it('filters other runs, sorts by filing time then id, and bounds summaries', () => {
    const longSummary = 'x'.repeat(501)
    expect(filedTodoEntriesForRun('run-1', [
      entry('web', 'todo-z', '2026-08-29T00:00:02Z', 'Web', 'run-1', { startedTaskId: 'child-z' }),
      entry('other', 'todo-0', '2026-08-29T00:00:00Z', 'Ignore', 'run-2'),
      entry('api', 'todo-a', '2026-08-29T00:00:02Z', longSummary, 'run-1'),
    ])).toEqual([
      { project: 'api', todoId: 'todo-a', summary: `${'x'.repeat(497)}…` },
      { project: 'web', todoId: 'todo-z', summary: 'Web', startedTaskId: 'child-z' },
    ])
  })
})
