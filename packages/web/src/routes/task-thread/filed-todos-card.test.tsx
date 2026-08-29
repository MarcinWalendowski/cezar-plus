import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'

import type { ApiRun } from '@loki-labs/better-cezar-api-client'

import { FiledTodosCard, filedTodosHeading } from './filed-todos-card'

const runWith = (items: NonNullable<ApiRun['filedTodos']>['items']): ApiRun => ({
  id: 'run-1',
  title: 'Route the work',
  workflow: 'input-to-tasks',
  task: 'Route the work',
  status: 'done',
  createdAt: '2026-08-29T00:00:00.000Z',
  tokensUsed: 0,
  archived: false,
  steps: [],
  filedTodos: { at: '2026-08-29T00:00:00.000Z', items },
})

const renderCard = (run: ApiRun) => render(<MemoryRouter><FiledTodosCard run={run} /></MemoryRouter>)

describe('FiledTodosCard', () => {
  it('renders an explicit empty receipt', () => {
    expect(filedTodosHeading(0, 0)).toBe('Filed 0 tasks')
    renderCard(runWith([]))
    expect(screen.getByText('Filed nothing')).toBeTruthy()
  })

  it('links every filed todo to the global detail route and distinguishes partial marking', () => {
    renderCard(runWith([
      { project: 'api', todoId: 'todo-1', summary: 'Add the API change' },
      { project: 'web', todoId: 'todo-2', summary: 'Add the web change', autostart: true },
      { project: 'infra', todoId: 'todo-3', summary: 'Add the infra change', startedTaskId: 'run-3' },
    ]))
    expect(screen.getByText('Filed 3 tasks, marked 2 of 3 to start')).toBeTruthy()
    const links = [...document.querySelectorAll<HTMLAnchorElement>('[data-slot="filed-todo-link"]')]
    expect(links).toHaveLength(3)
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/tasks?fdetail=api%3Atodo-1',
      '/tasks?fdetail=web%3Atodo-2',
      '/tasks?fdetail=infra%3Atodo-3',
    ])
    expect(screen.getByText('todo-2')).toBeTruthy()
    const firstRow = document.querySelector<HTMLElement>('[data-slot="filed-todo"]')!
    expect(within(firstRow).queryByText('Started')).toBeNull()
    expect(screen.getAllByText('Started')).toHaveLength(2)
  })

  it('describes an all-marked receipt', () => {
    expect(filedTodosHeading(1, 1)).toBe('Filed 1 task and marked them all to start')
  })
})
