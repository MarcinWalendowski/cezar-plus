import { cleanup, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import type { ApiRun } from '@loki-labs/cezar-plus-api-client'

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

afterEach(() => cleanup())

const renderCard = (run: ApiRun) => render(
  <MemoryRouter initialEntries={['/p/launch/tasks/run-1']}><FiledTodosCard run={run} /></MemoryRouter>,
)

describe('FiledTodosCard', () => {
  it('renders an explicit empty receipt', () => {
    expect(filedTodosHeading(0, 0)).toBe('Filed 0 tasks')
    renderCard(runWith([]))
    expect(screen.getByText('Filed nothing')).toBeTruthy()
  })

  it('links every filed todo to its target project detail route and distinguishes partial marking', () => {
    renderCard(runWith([
      { project: 'api', todoId: 'todo-1', summary: 'Add the API change' },
      { project: 'web', todoId: 'todo-2', summary: 'Add the web change', autostart: true },
      { project: 'infra', todoId: 'todo-3', summary: 'Add the infra change', startedTaskId: 'run-3' },
    ]))
    expect(screen.getByText('Filed 3 tasks, marked 2 of 3 to start')).toBeTruthy()
    const links = [...document.querySelectorAll<HTMLAnchorElement>('[data-slot="filed-todo-link"]')]
    expect(links).toHaveLength(3)
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/p/api/todos/todo-1',
      '/p/web/todos/todo-2',
      '/p/infra/todos/todo-3',
    ])
    expect(screen.getByText('todo-2')).toBeTruthy()
    const firstRow = document.querySelector<HTMLElement>('[data-slot="filed-todo"]')!
    expect(within(firstRow).queryByText('Started')).toBeNull()
    expect(screen.getAllByText('Started')).toHaveLength(2)
  })

  it('escapes each target segment so reserved characters cannot become route or query syntax', () => {
    renderCard(runWith([
      { project: 'api/preview?x=1#team', todoId: 'todo/42?#% snow ☃', summary: 'Escaped target task' },
    ]))
    const link = screen.getByRole('link', { name: 'Escaped target task' }) as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('/p/api%2Fpreview%3Fx%3D1%23team/todos/todo%2F42%3F%23%25%20snow%20%E2%98%83')
    const target = new URL(link.href)
    expect(target.search).toBe('')
    expect(target.hash).toBe('')
  })

  it('describes an all-marked receipt', () => {
    expect(filedTodosHeading(1, 1)).toBe('Filed 1 task and marked them all to start')
  })
})
