import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { WorkspaceTodoEntry } from '@loki-labs/cezar-plus-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'

import { FiledTaskDetailRoute } from './filed-task-detail'

/**
 * `/p/:projectId/todos/:todoId` (`.ai/specs/2026-08-29-filed-task-detail-page.md`) — the page's
 * own derived-state, field-completeness and action tests. Route REGISTRATION (that this component
 * is actually reachable through `routes.tsx`) is asserted separately in `routes.test.tsx`'s
 * `ROUTE_CASES` and `nav-items.test.ts` — a component test here proves nothing about a mistyped
 * path in the router, which is why that split exists.
 */

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  resetToasts()
})

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const RICH_ENTRY: WorkspaceTodoEntry = {
  project: 'api',
  todo: {
    id: 'todo-1',
    ts: '2026-07-14T09:00:00Z',
    summary: 'Add a rate limit to /checkout',
    status: 'done',
    priority: 'high',
    archivedAt: '2026-07-20T10:00:00Z',
    context: 'Checkout is getting hammered by one client.',
    whatToDo: 'Add a token-bucket limiter in front of /checkout.',
    acceptanceCriteria: ['429s under load', 'no false positives'],
    knowledgeRefs: [{ project: 'api', slug: 'rate-limit-notes', title: 'Rate limit notes' }],
    author: { kind: 'user', id: 'local', via: 'cli-todo-add', at: '2026-07-14T09:00:00Z', label: 'Marcin' },
  },
}

const SPARSE_ENTRY: WorkspaceTodoEntry = {
  project: 'api',
  todo: { id: 'todo-2', ts: '2026-07-14T09:00:00Z', summary: 'A bare filed task' },
}

function LocationProbe() {
  const location = useLocation()
  return (
    <>
      <span data-testid="pathname">{location.pathname}</span>
    </>
  )
}

function stubFetch({
  todos = [] as WorkspaceTodoEntry[],
  projects = [] as unknown[],
  todosStatus = 200,
  cluster = false,
  clusterOverview,
  patchStatus = 200,
}: {
  todos?: WorkspaceTodoEntry[]
  projects?: unknown[]
  todosStatus?: number
  cluster?: boolean
  clusterOverview?: unknown
  patchStatus?: number
} = {}) {
  let todoBoard = todos.map((entry) => ({ ...entry, todo: { ...entry.todo } }))
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input)
      const method = init.method ?? 'GET'
      if (path === '/api/v1/health') return jsonResponse({ capabilities: { cluster } })
      if (path === '/api/v1/cluster') {
        return jsonResponse(clusterOverview ?? { nodes: [], pairings: [], proposals: [], link: { state: 'disabled' } })
      }
      if (path === '/api/v1/cluster/active') return jsonResponse({ runs: [] })
      if (path === '/api/v1/workspace/todos') {
        if (todosStatus !== 200) return jsonResponse({ error: 'workspace unreadable' }, todosStatus)
        return jsonResponse({ todos: todoBoard, projects })
      }
      const start = /^\/api\/v1\/p\/([^/]+)\/todos\/([^/]+)\/start$/.exec(path)
      if (start && method === 'POST') {
        return jsonResponse({ run: { id: `run-from-${start[2]}` } }, 201)
      }
      const patch = /^\/api\/v1\/p\/([^/]+)\/todos\/([^/]+)$/.exec(path)
      if (patch && method === 'PATCH') {
        if (patchStatus !== 200) return jsonResponse({ error: 'lease held elsewhere' }, patchStatus)
        const [, projectId, id] = patch
        const body = JSON.parse(String(init.body)) as { archived?: boolean }
        let patched: WorkspaceTodoEntry | undefined
        todoBoard = todoBoard.map((entry) => {
          if (entry.project !== projectId || entry.todo.id !== id) return entry
          const todo = { ...entry.todo }
          if (body.archived === true) todo.archivedAt = '2026-07-21T00:00:00Z'
          else if (body.archived === false) delete todo.archivedAt
          patched = { ...entry, todo }
          return patched
        })
        if (!patched) return jsonResponse({ error: 'not found' }, 404)
        return jsonResponse({ todo: patched.todo })
      }
      return jsonResponse({ error: `unexpected ${path}` }, 404)
    }),
  )
}

function renderRoute(path: string) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/p/:projectId/todos/:todoId" element={<FiledTaskDetailRoute />} />
        </Routes>
        <Toaster />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('FiledTaskDetailRoute — derived state', () => {
  it('is honestly loading while the query has not answered — never not-found', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<never>(() => {})))
    renderRoute('/p/api/todos/todo-1')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Loading task…')
    expect(screen.queryByText(/task not found/i)).toBeNull()
  })

  it('a rejected request renders the error state, never "task not found"', async () => {
    // A 4xx — `createQueryClient`'s `retry` treats it as the server's considered answer and does
    // not retry, so the query settles to `isError` on the first failure.
    stubFetch({ todosStatus: 400 })
    renderRoute('/p/api/todos/todo-1')
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Could not load this task'))
    expect(screen.getByText('workspace unreadable')).toBeTruthy()
    expect(screen.queryByText(/task not found/i)).toBeNull()
  })

  it('a healthy response with no matching pair is not-found', async () => {
    stubFetch({ todos: [RICH_ENTRY] })
    renderRoute('/p/api/todos/does-not-exist')
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Task not found'))
  })

  it('an unreadable project health row is project-unavailable, naming the reason', async () => {
    stubFetch({ todos: [], projects: [{ id: 'api', name: 'API', status: 'not-git', ok: false, reason: 'not a git repo', total: 0 }] })
    renderRoute('/p/api/todos/todo-1')
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('This project could not be read'),
    )
    expect(screen.getByText('not a git repo')).toBeTruthy()
  })

  it('a todoId that exists in ANOTHER project is not-found for this one — the scope assertion', async () => {
    stubFetch({ todos: [{ ...RICH_ENTRY, project: 'web' }] })
    renderRoute('/p/api/todos/todo-1')
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Task not found'))
  })

  it('a matching pair renders found, with the page-root data attributes', async () => {
    stubFetch({ todos: [RICH_ENTRY] })
    renderRoute('/p/api/todos/todo-1')
    await screen.findByText('Add a rate limit to /checkout')
    const root = document.querySelector('[data-route="filed-task-detail"]')
    expect(root).not.toBeNull()
    expect(root?.getAttribute('data-slot')).toBe('filed-task-detail')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Add a rate limit to /checkout')
  })
})

describe('FiledTaskDetailRoute — field completeness', () => {
  it('renders every section a rich entry carries', async () => {
    stubFetch({ todos: [RICH_ENTRY] })
    renderRoute('/p/api/todos/todo-1')
    await screen.findByText('Add a rate limit to /checkout')

    expect(screen.getByText('Checkout is getting hammered by one client.')).toBeTruthy()
    expect(screen.getByText('Add a token-bucket limiter in front of /checkout.')).toBeTruthy()
    expect(document.querySelector('[data-slot="filed-task-acceptance-criteria"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="filed-task-knowledge-refs"]')).not.toBeNull()
    const author = document.querySelector('[data-slot="filed-task-author"]')
    expect(author?.textContent).toContain('Marcin')
    expect(document.querySelector('[data-slot="filed-task-archived"]')).not.toBeNull()
  })

  it('an entry with no acceptance criteria and no knowledge refs renders neither section', async () => {
    stubFetch({ todos: [SPARSE_ENTRY] })
    renderRoute('/p/api/todos/todo-2')
    await screen.findByText('A bare filed task')

    expect(document.querySelector('[data-slot="filed-task-acceptance-criteria"]')).toBeNull()
    expect(document.querySelector('[data-slot="filed-task-knowledge-refs"]')).toBeNull()
  })

  it('no author renders the unattributed label rather than nothing', async () => {
    stubFetch({ todos: [SPARSE_ENTRY] })
    renderRoute('/p/api/todos/todo-2')
    await screen.findByText('A bare filed task')

    const author = document.querySelector('[data-slot="filed-task-author"]')
    expect(author).not.toBeNull()
    expect(author?.textContent).toBe('—')
  })

  it('a done entry with NO archivedAt renders no archived stamp — the stamp is the view, not the status', async () => {
    const done: WorkspaceTodoEntry = { project: 'api', todo: { id: 'todo-3', summary: 'Finished, never archived', status: 'done' } }
    stubFetch({ todos: [done] })
    renderRoute('/p/api/todos/todo-3')
    await screen.findByText('Finished, never archived')

    expect(document.querySelector('[data-slot="filed-task-archived"]')).toBeNull()
  })

  it('an entry with neither startedOn nor placement.node renders no node cell at all', async () => {
    stubFetch({ todos: [SPARSE_ENTRY], cluster: true })
    renderRoute('/p/api/todos/todo-2')
    await screen.findByText('A bare filed task')

    expect(document.querySelector('[data-slot="task-node"]')).toBeNull()
  })

  it('a node claim renders even with clustering OFF — ungated, unlike the board column', async () => {
    const withNode: WorkspaceTodoEntry = {
      project: 'api',
      todo: { id: 'todo-4', summary: 'Running somewhere', startedOn: 'ghost-node' },
    }
    stubFetch({ todos: [withNode], cluster: false })
    renderRoute('/p/api/todos/todo-4')
    await screen.findByText('Running somewhere')

    await waitFor(() => {
      const cell = document.querySelector<HTMLElement>('[data-slot="task-node"]')
      expect(cell?.dataset.nodeKind).toBe('unknown')
    })
    expect(document.querySelector('[data-slot="task-node"]')?.textContent).toContain('ghost-node')
  })

  it('a node claim resolves to "known" once clustering is on and the roster has it', async () => {
    const withNode: WorkspaceTodoEntry = {
      project: 'api',
      todo: { id: 'todo-5', summary: 'Running on the hub', startedOn: 'hub-1' },
    }
    const node = {
      nodeId: 'hub-1',
      nodeName: 'Hub',
      role: 'hub' as const,
      labels: [] as string[],
      acceptsDispatch: true,
      protocol: { major: 1, minor: 0 },
      version: '0.10.0',
    }
    stubFetch({
      todos: [withNode],
      cluster: true,
      clusterOverview: { self: undefined, nodes: [node], pairings: [], proposals: [], link: { state: 'disabled' } },
    })
    renderRoute('/p/api/todos/todo-5')
    await screen.findByText('Running on the hub')

    await waitFor(() => {
      const cell = document.querySelector<HTMLElement>('[data-slot="task-node"]')
      expect(cell?.dataset.nodeKind).toBe('known')
    })
    expect(document.querySelector('[data-slot="task-node"]')?.textContent).toBe('Hub')
  })
})

describe('FiledTaskDetailRoute — actions', () => {
  it('Start POSTs to the URL project and navigates to the new run', async () => {
    stubFetch({ todos: [RICH_ENTRY] })
    renderRoute('/p/api/todos/todo-1')
    await screen.findByText('Add a rate limit to /checkout')

    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await waitFor(() => expect(screen.getByTestId('pathname').textContent).toBe('/p/api/tasks/run-from-todo-1'))
  })

  it('Archive PATCHes {archived: true} and flips the pill optimistically', async () => {
    const active: WorkspaceTodoEntry = { project: 'api', todo: { id: 'todo-6', summary: 'Not archived yet', status: 'blocked' } }
    stubFetch({ todos: [active] })
    renderRoute('/p/api/todos/todo-6')
    await screen.findByText('Not archived yet')

    expect(screen.getByRole('button', { name: 'Archive' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Restore' })).toBeTruthy())
  })

  it('a rejected PATCH rolls the pill back and toasts the server’s own words', async () => {
    const active: WorkspaceTodoEntry = { project: 'api', todo: { id: 'todo-7', summary: 'Stays put', status: 'blocked' } }
    stubFetch({ todos: [active], patchStatus: 409 })
    renderRoute('/p/api/todos/todo-7')
    await screen.findByText('Stays put')

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('lease held elsewhere'))
    expect(screen.getByRole('button', { name: 'Archive' })).toBeTruthy()
  })
})
