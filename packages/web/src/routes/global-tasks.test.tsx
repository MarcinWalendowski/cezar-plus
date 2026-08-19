import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type {
  ProjectListEntry,
  RunIndexEntry,
  WorkspaceTodoEntry,
} from '@loki-labs/better-cezar-api-client'
import { ListViewProvider, useListView } from '@/components/list-view'
import { __clearRememberedStatusesForTests, workspaceQueryKeys } from '@/api/queries'
import { Toaster, resetToasts } from '@/components/ui/toaster'

import { GlobalTasksRoute } from './global-tasks'

/**
 * The global Tasks page, wired to stubbed `/api/v1/projects` + `/api/v1/workspace/runs-index`.
 *
 * The behaviors worth a DOM test rather than a unit one: the rows link into each task's OWN
 * project (this page renders outside every scope, so a scoped link would silently point at the
 * wrong repo), the tag chips are a real multi-select, and the truncation notice is not silent.
 */

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
  // Reference statuses are remembered for the LIFETIME OF THE TAB, deliberately (a re-keyed batch
  // must not blank the chips) — which in vitest means one case's statuses would otherwise be
  // remembered by the next one in this file.
  __clearRememberedStatusesForTests()
})

const PROJECTS: ProjectListEntry[] = [
  {
    id: 'api',
    name: 'API',
    root: '/repos/api',
    addedAt: '2026-07-01T10:00:00Z',
    lastOpenedAt: '2026-07-01T10:00:00Z',
    source: 'local',
    status: 'ok',
    tags: ['storefront'],
    repoUrl: 'https://github.com/acme/api',
  },
  {
    id: 'web',
    name: 'Web',
    root: '/repos/web',
    addedAt: '2026-07-01T10:00:00Z',
    lastOpenedAt: '2026-07-01T10:00:00Z',
    source: 'local',
    status: 'ok',
    tags: ['storefront'],
  },
  {
    id: 'infra',
    name: 'Infra',
    root: '/repos/infra',
    addedAt: '2026-07-01T10:00:00Z',
    lastOpenedAt: '2026-07-01T10:00:00Z',
    source: 'local',
    status: 'ok',
  },
]

const RUNS: RunIndexEntry[] = [
  {
    projectId: 'api',
    id: 'a1',
    title: 'Add checkout endpoint',
    status: 'running',
    createdAt: '2026-07-14T10:00:00Z',
    archived: false,
    workflow: 'quick-task',
    branch: 'feat/checkout',
    // Several at once: opened on an issue, about one PR, having created another.
    pullRequestUrl: 'https://github.com/acme/api/pull/42',
    referencedPullRequestUrl: 'https://github.com/acme/api/pull/40',
    referencedIssueUrl: 'https://github.com/acme/api/issues/12',
    markerRefs: { pr: 40, issue: 12 },
  },
  {
    projectId: 'web',
    id: 'w1',
    title: 'Checkout page',
    status: 'review',
    createdAt: '2026-07-14T09:00:00Z',
    archived: false,
    workflow: 'plan-first',
    issueNumber: 7,
    referencedIssueUrl: 'https://github.com/acme/web/issues/7',
  },
  {
    projectId: 'infra',
    id: 'i1',
    title: 'Bump the runner',
    status: 'done',
    createdAt: '2026-07-14T08:00:00Z',
    archived: false,
    workflow: 'quick-task',
  },
]

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

let sent: { method: string; path: string; body?: unknown }[] = []

function stubFetch({
  runs = RUNS,
  projects = PROJECTS,
  truncated = [] as string[],
  indexStatus = 200,
  archiveStatus = 200,
  costMetrics = true,
  refStatus,
  indexStatuses,
  todos = [],
  todoPatchStatus = 200,
}: {
  runs?: RunIndexEntry[]
  projects?: ProjectListEntry[]
  truncated?: string[]
  indexStatus?: number
  archiveStatus?: number
  costMetrics?: boolean
  /** Per-project chip status, as the forge would answer it. Absent = the forge is unreachable,
   *  which is the only honest default here: no `gh`, no statuses, neutral chips. */
  refStatus?: Record<string, { prs?: Record<number, string>; issues?: Record<number, string> }>
  /** What the runs-index itself already knew — the free, no-round-trip path. */
  indexStatuses?: Record<string, { prs: Record<number, string>; issues: Record<number, string> }>
  /** Filed-but-unstarted todos, as `GET /workspace/todos` answers them. */
  todos?: WorkspaceTodoEntry[]
  /** What `PATCH /todos/:id` answers with — 200 by default, or a status the mutation must roll
   *  back from (the same shape `archiveStatus` gives the runs side). */
  todoPatchStatus?: number
} = {}) {
  sent = []
  seenAt = undefined
  // Stateful, like the real server: an archive really flips the flag, so the invalidation
  // refetch answers with the moved row rather than putting the old one back.
  let index = runs.map((run) => ({ ...run }))
  let todoBoard = todos.map((entry) => ({ ...entry, todo: { ...entry.todo } }))
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input)
      const method = init.method ?? 'GET'
      sent.push({
        method,
        path,
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      })
      if (path === '/api/v1/health') {
        // Only the slice `usageMetricVisibility` reads — the host's cost/token gate.
        return jsonResponse({ capabilities: { costMetrics, tokenUsageMetrics: true } })
      }
      if (path === '/api/v1/projects') {
        return jsonResponse({ projects, bootProject: 'api', projectsDir: '/repos' })
      }
      if (path === '/api/v1/workspace/runs-index') {
        if (indexStatus !== 200) return jsonResponse({ error: 'workspace unreadable' }, indexStatus)
        return jsonResponse({
          runs: index.map((run) => (seenAt === undefined ? run : { ...run, seenAt })),
          perProjectLimit: 200,
          truncated,
          // Statuses the server already had, riding along with the rows — see `indexedStatuses`.
          referenceStatuses: indexStatuses ?? {},
        })
      }
      if (path === '/api/v1/workspace/todos') {
        // Note what the health stub above does NOT carry: `followups` and `workspaceViews` are
        // both absent, i.e. off — the default install. The Filed section must still render, which
        // is the whole point of this route being ungated (D7a on the client).
        return jsonResponse({ todos: todoBoard, projects: [] })
      }
      const startTodo = /^\/api\/v1\/p\/([^/]+)\/todos\/([^/]+)\/start$/.exec(path)
      if (startTodo && method === 'POST') {
        return jsonResponse({ run: { id: `run-from-${startTodo[2]}` } }, 201)
      }
      // PATCH .../todos/:id — never `/start`, which is matched (and returned) above first.
      const patchTodo = /^\/api\/v1\/p\/([^/]+)\/todos\/([^/]+)$/.exec(path)
      if (patchTodo && method === 'PATCH') {
        if (todoPatchStatus !== 200) return jsonResponse({ error: 'lease held elsewhere' }, todoPatchStatus)
        const [, projectId, id] = patchTodo
        const patch = JSON.parse(String(init.body)) as {
          status?: string
          priority?: string
          archived?: boolean
        }
        let patched: WorkspaceTodoEntry | undefined
        todoBoard = todoBoard.map((entry) => {
          if (entry.project !== projectId || entry.todo.id !== id) return entry
          const todo = { ...entry.todo }
          if (patch.status !== undefined) todo.status = patch.status as WorkspaceTodoEntry['todo']['status']
          if (patch.priority !== undefined) {
            todo.priority = patch.priority as WorkspaceTodoEntry['todo']['priority']
          }
          if (patch.archived === true) todo.archivedAt = '2026-07-14T12:00:00Z'
          else if (patch.archived === false) delete todo.archivedAt
          patched = { ...entry, todo }
          return patched
        })
        if (!patched) return jsonResponse({ error: 'not found' }, 404)
        return jsonResponse({ todo: patched.todo })
      }
      const status = /^\/api\/v1\/p\/([^/]+)\/github\/ref-status/.exec(path)
      if (status) {
        const answer = refStatus?.[status[1]!]
        // `recheckAfterMs` is the server's call on when to ask again — part of the shape, so the
        // fixture carries it.
        if (!answer) return jsonResponse({ available: false, reason: 'gh CLI not found', recheckAfterMs: 300_000 })
        return jsonResponse({
          available: true,
          prs: answer.prs ?? {},
          issues: answer.issues ?? {},
          recheckAfterMs: null,
        })
      }
      // The workspace spelling, not `/p/:projectId` (spec 2026-08-14-cross-project-run-mutations):
      // the board's row actions moved off the project-scoped prefix because its `use('*')` resolver
      // BUILDS the named project's context, resuming every interrupted run in it. The path is the
      // fix, so these fixtures pin it.
      const receipt = /^\/api\/v1\/workspace\/runs\/([^/]+)\/([^/]+)\/(read|unread)$/.exec(path)
      if (receipt && method === 'POST') {
        const [, projectId, id, route] = receipt
        index = index.map((run) => {
          if (run.projectId !== projectId || run.id !== id) return run
          if (route === 'unread') {
            const { seenAt: _dropped, ...rest } = run
            return rest
          }
          return { ...run, seenAt: '2026-07-14T12:00:00Z' }
        })
        return jsonResponse(index.find((run) => run.id === id))
      }
      const archive = /^\/api\/v1\/workspace\/runs\/([^/]+)\/([^/]+)\/archive$/.exec(path)
      if (archive && method === 'POST') {
        if (archiveStatus !== 200) return jsonResponse({ error: 'still running' }, archiveStatus)
        const [, projectId, id] = archive
        const archived = (JSON.parse(String(init.body)) as { archived: boolean }).archived
        index = index.map((run) =>
          run.projectId === projectId && run.id === id ? { ...run, archived } : run,
        )
        return jsonResponse(index.find((run) => run.id === id))
      }
      return jsonResponse({ error: `unexpected ${path}` }, 404)
    }),
  )
}

function renderPage(client = createQueryClient(), entry = '/tasks') {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <ListViewProvider>
          <GlobalTasksRoute />
          <Toaster />
          <LocationProbe />
        </ListViewProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** Makes the URL assertable — the filters ARE the URL, so this is the state under test. */
function LocationProbe() {
  const location = useLocation()
  return <span data-testid="search">{location.search}</span>
}

const search = () => screen.getByTestId('search').textContent ?? ''

/** Reads the SHARED Active/Archived context — the one the sidebar and the per-project table use. */
function SharedViewProbe() {
  const [view] = useListView()
  return <span data-testid="shared-view">{view}</span>
}

/** Set by the receipt test: what the index answers as `seenAt` on its NEXT read. */
let seenAt: string | undefined

const unreadMarkers = () => [...document.querySelectorAll('[aria-label="unread"]')]

const rowIds = () =>
  [...document.querySelectorAll('[data-slot="global-task-row"]')].map(
    (row) => row.getAttribute('data-run-id') ?? '',
  )

describe('global tasks page', () => {
  it('lists every project’s tasks and links each into its OWN project', async () => {
    stubFetch()
    renderPage()

    await screen.findByText('Add checkout endpoint')
    expect(rowIds()).toEqual(['a1', 'w1', 'i1'])
    // The whole reason this page cannot use the scope-aware Link: each row leaves for a
    // different project.
    expect(screen.getByRole('link', { name: 'Add checkout endpoint' }).getAttribute('href')).toBe(
      '/p/api/tasks/a1',
    )
    expect(screen.getByRole('link', { name: 'Checkout page' }).getAttribute('href')).toBe(
      '/p/web/tasks/w1',
    )
  })

  it('shows a workspace run as a chip with no project link, and still reaches its thread', async () => {
    // A WORKSPACE run (`.ai/specs/2026-08-15-cross-project-workspace-run.md`) is stored in the boot
    // project because a `RunManager` must be bound to a repository — a storage fact, not a scoping
    // claim. Every other row's project name leads to that project's home; this one spans them all,
    // so `/p/cockpit-boot/` would be a destination that means nothing.
    //
    // The mutation: restore the unconditional `<Link to={scopeTo(run.projectId, '/')}>`. The chip
    // becomes a link to a project the run is not about — and, because it would then be found by
    // role `link`, `getByRole` below turns red rather than merely reading differently.
    stubFetch({
      runs: [
        {
          projectId: 'cockpit-boot',
          id: 'ws1',
          title: 'Bump the lint rule everywhere',
          status: 'done',
          createdAt: '2026-07-14T11:00:00Z',
          archived: false,
          workflow: 'quick-task',
          workspace: true,
        },
        // The control: an ordinary run in the SAME repo. It keeps its project link, so the chip is
        // about the run's kind and not about which folder the record happens to sit in.
        {
          projectId: 'cockpit-boot',
          id: 'boot1',
          title: 'Tidy the scaffold',
          status: 'done',
          createdAt: '2026-07-14T10:30:00Z',
          archived: false,
          workflow: 'quick-task',
        },
      ],
    })
    renderPage()

    await screen.findByText('Bump the lint rule everywhere')
    const chip = document.querySelector('[data-slot="workspace-chip"]')!
    expect(chip.textContent).toBe('Workspace')
    expect(chip.closest('a')).toBeNull()
    // Exactly one project link in the table, and it belongs to the ordinary row.
    expect(screen.getByRole('link', { name: 'cockpit-boot' }).getAttribute('href')).toBe(
      '/p/cockpit-boot/',
    )
    // The row's own link is untouched — the thread is where the work is.
    expect(
      screen.getByRole('link', { name: 'Bump the lint rule everywhere' }).getAttribute('href'),
    ).toBe('/p/cockpit-boot/tasks/ws1')
  })

  it('prints quick-task as `default`, in the cell and on the facet chip, without renaming it', async () => {
    // `quick-task` is the server's fallback when a run names no workflow, so it is what nearly
    // every row carries and reads as a choice nobody made. Display only — the mutation is
    // reverting the cell to `{run.workflow}` or the facet option's label to the raw name.
    stubFetch()
    renderPage()
    await screen.findByText('Add checkout endpoint')

    // Two of the three fixture runs are quick-task; `w1` is plan-first and must show itself.
    const table = document.querySelector('[data-slot="global-tasks-table"]')!
    expect(table.textContent).toContain('default')
    expect(table.textContent).not.toContain('quick-task')
    expect(table.textContent).toContain('plan-first')

    // The facet option reads `default` while its VALUE stays `quick-task` — the split that keeps a
    // shared `?workflow=quick-task` URL working. Both are on the same element, so one assertion
    // catches a rename of either half.
    //
    // Opening the popover needs two jsdom gaps filled, exactly as `command-palette.test.tsx`
    // fills them: cmdk sizes its list with a ResizeObserver and scrolls the selected item into
    // view. Scoped to this case rather than the file, since nothing else here opens a popover.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
    Element.prototype.scrollIntoView = vi.fn()
    fireEvent.click(screen.getByLabelText('Filter by workflow'))
    const option = await waitFor(() => {
      const found = document.querySelector('[data-facet-value="quick-task"]')
      if (!found) throw new Error('workflow option not rendered')
      return found
    })
    expect(option.textContent).toContain('default')
    expect(option.textContent).not.toContain('quick-task')

    fireEvent.click(option)
    await waitFor(() => expect(search()).toBe('?workflow=quick-task'))
    await waitFor(() => expect(rowIds()).toEqual(['a1', 'i1']))
  })

  it('restores a `?workflow=quick-task` link — the name in every existing bookmark', async () => {
    // The compatibility half, entered from the URL alone as a reload would. The mutation: rename
    // the facet VALUE along with the label, and this link silently matches nothing.
    stubFetch()
    renderPage(createQueryClient(), '/tasks?workflow=quick-task')
    await screen.findByText('Add checkout endpoint')

    expect(rowIds()).toEqual(['a1', 'i1'])
    // The trigger summarises the active filter by LABEL, so it reads `default` for a URL that
    // says `quick-task` — the two spellings meeting exactly where they should.
    const trigger = screen.getByLabelText('Filter by workflow')
    expect(trigger.getAttribute('data-active')).toBe('true')
    expect(trigger.textContent).toContain('default')
  })

  it('filters by tag across projects, and toggles back off', async () => {
    stubFetch()
    renderPage()
    await screen.findByText('Add checkout endpoint')

    const storefront = screen.getByRole('button', { name: /storefront/ })
    fireEvent.click(storefront)
    // One tag, two repos — which is the entire point of tagging connected repositories.
    await waitFor(() => expect(rowIds()).toEqual(['a1', 'w1']))
    expect(storefront.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(storefront)
    await waitFor(() => expect(rowIds()).toEqual(['a1', 'w1', 'i1']))
  })

  it('finds the repos nobody has tagged yet', async () => {
    stubFetch()
    renderPage()
    await screen.findByText('Add checkout endpoint')

    fireEvent.click(screen.getByRole('button', { name: /Untagged/ }))
    await waitFor(() => expect(rowIds()).toEqual(['i1']))
  })

  it('ORs two tag chips rather than intersecting them', async () => {
    stubFetch({
      projects: [
        { ...PROJECTS[0]!, tags: ['storefront'] },
        { ...PROJECTS[1]!, tags: ['frontend'] },
        PROJECTS[2]!,
      ],
    })
    renderPage()
    await screen.findByText('Add checkout endpoint')

    fireEvent.click(screen.getByRole('button', { name: /storefront/ }))
    fireEvent.click(screen.getByRole('button', { name: /frontend/ }))
    await waitFor(() => expect(rowIds()).toEqual(['a1', 'w1']))
  })

  it('searches across title, project and branch', async () => {
    stubFetch()
    renderPage()
    await screen.findByText('Add checkout endpoint')

    const search = screen.getAllByLabelText('Search tasks across projects')[0]!
    fireEvent.change(search, { target: { value: 'web checkout' } })
    await waitFor(() => expect(rowIds()).toEqual(['w1']))

    // Branch has no column here — dropping it gave the width to the task title — but pasting a
    // branch name to find the task that made it still works, exactly as it does in the
    // per-project table whose Branch column is folded by default.
    expect(document.querySelector('[data-slot="global-tasks-table"]')!.textContent).not.toContain(
      'feat/checkout',
    )
    fireEvent.change(search, { target: { value: 'feat/checkout' } })
    await waitFor(() => expect(rowIds()).toEqual(['a1']))
  })

  it('groups by tag, fanning a task out under every tag its project carries', async () => {
    stubFetch({
      projects: [{ ...PROJECTS[0]!, tags: ['backend', 'storefront'] }, PROJECTS[1]!, PROJECTS[2]!],
    })
    renderPage()
    await screen.findByText('Add checkout endpoint')

    fireEvent.click(within(screen.getByRole('group', { name: 'Group tasks by' })).getByText('Tag'))

    await waitFor(() => {
      const keys = [...document.querySelectorAll('[data-slot="task-group"]')].map((group) =>
        group.getAttribute('data-group-key'),
      )
      expect(keys).toEqual(['storefront', 'backend', ' untagged'])
    })
    const storefront = document.querySelector('[data-group-key="storefront"]')!
    expect(
      [...storefront.querySelectorAll('[data-slot="global-task-row"]')].map((row) =>
        row.getAttribute('data-run-id'),
      ),
    ).toEqual(['a1', 'w1'])
  })

  describe('filters live in the URL', () => {
    it('restores a filtered, grouped view from the query string alone', async () => {
      // The refresh case: a reload re-enters the route with only the URL to go on.
      stubFetch()
      renderPage(createQueryClient(), '/tasks?tag=storefront&status=running&group=tag')
      await screen.findByText('Add checkout endpoint')

      expect(rowIds()).toEqual(['a1'])
      expect(
        screen.getByRole('button', { name: /storefront/ }).getAttribute('aria-pressed'),
      ).toBe('true')
      expect(
        within(screen.getByRole('group', { name: 'Group tasks by' }))
          .getByText('Tag')
          .getAttribute('aria-pressed'),
      ).toBe('true')
    })

    it('writes each facet into the URL as it is picked', async () => {
      stubFetch()
      renderPage()
      await screen.findByText('Add checkout endpoint')
      expect(search()).toBe('')

      fireEvent.click(screen.getByRole('button', { name: /storefront/ }))
      await waitFor(() => expect(search()).toBe('?tag=storefront'))

      fireEvent.click(
        within(screen.getByRole('group', { name: 'Group tasks by' })).getByText('Project'),
      )
      await waitFor(() => expect(search()).toBe('?tag=storefront&group=project'))

      // Releasing the grouping drops the key rather than spelling out a default.
      fireEvent.click(
        within(screen.getByRole('group', { name: 'Group tasks by' })).getByText('Project'),
      )
      await waitFor(() => expect(search()).toBe('?tag=storefront'))
    })

    it('carries the search box into the URL, debounced', async () => {
      stubFetch()
      renderPage()
      await screen.findByText('Add checkout endpoint')

      const box = screen.getAllByLabelText('Search tasks across projects')[0]!
      fireEvent.change(box, { target: { value: 'checkout' } })
      // Typed immediately, in the URL a beat later — a history write per keystroke is what
      // browsers rate-limit.
      expect((box as HTMLInputElement).value).toBe('checkout')
      await waitFor(() => expect(search()).toBe('?q=checkout'))
      expect(rowIds()).toEqual(['a1', 'w1'])
    })

    it('counts the grouping in the Clear badge, not just the facets', async () => {
      stubFetch()
      renderPage()
      await screen.findByText('Add checkout endpoint')

      fireEvent.click(screen.getByRole('button', { name: /storefront/ }))
      await waitFor(() => expect(screen.getByRole('button', { name: /^Clear/ }).textContent).toContain('(1)'))

      fireEvent.click(
        within(screen.getByRole('group', { name: 'Group tasks by' })).getByText('Tag'),
      )
      // One tag plus a grouping is two things applied — the badge said (1) before.
      await waitFor(() => expect(screen.getByRole('button', { name: /^Clear/ }).textContent).toContain('(2)'))
    })

    it('clears the grouping too — Clear is the one way back to a plain list', async () => {
      stubFetch()
      renderPage()
      await screen.findByText('Add checkout endpoint')

      const groupBy = () => within(screen.getByRole('group', { name: 'Group tasks by' }))
      // Grouping alone, no filters: the button must still be offered.
      fireEvent.click(groupBy().getByText('Project'))
      await waitFor(() => expect(search()).toBe('?group=project'))
      const clear = await screen.findByRole('button', { name: /^Clear/ })

      fireEvent.click(clear)
      await waitFor(() => expect(search()).toBe(''))
      await waitFor(() => {
        const groups = document.querySelectorAll('[data-slot="task-group"]')
        expect(groups).toHaveLength(1)
        expect(groups[0]!.getAttribute('data-group-key')).toBe('all')
      })
    })

    it('empties the URL when the filters are cleared', async () => {
      stubFetch()
      renderPage()
      await screen.findByText('Add checkout endpoint')

      fireEvent.click(screen.getByRole('button', { name: /storefront/ }))
      await waitFor(() => expect(search()).toBe('?tag=storefront'))

      fireEvent.click(screen.getByRole('button', { name: /^Clear/ }))
      await waitFor(() => expect(search()).toBe(''))
      expect(rowIds()).toEqual(['a1', 'w1', 'i1'])
    })

    it('adds and removes the archived flag, leaving active as the bare default', async () => {
      stubFetch({ runs: RUNS.map((run) => (run.id === 'i1' ? { ...run, archived: true } : run)) })
      renderPage()
      await screen.findByText('Add checkout endpoint')
      // Active is the default, so a normal link carries no key for it.
      expect(search()).toBe('')

      fireEvent.click(screen.getByRole('button', { name: 'Archived' }))
      await waitFor(() => expect(search()).toBe('?archived=1'))
      await waitFor(() => expect(rowIds()).toEqual(['i1']))

      fireEvent.click(screen.getByRole('button', { name: 'Active' }))
      await waitFor(() => expect(search()).toBe(''))
      await waitFor(() => expect(rowIds()).toEqual(['a1', 'w1']))
    })

    it('restores the archived view from the URL alone', async () => {
      stubFetch({ runs: RUNS.map((run) => (run.id === 'i1' ? { ...run, archived: true } : run)) })
      renderPage(createQueryClient(), '/tasks?archived=1')
      await screen.findByText('Bump the runner')

      expect(rowIds()).toEqual(['i1'])
      expect(screen.getByRole('button', { name: 'Archived' }).getAttribute('aria-pressed')).toBe(
        'true',
      )
    })

    it('keeps the view alongside the filters rather than dropping one for the other', async () => {
      stubFetch()
      renderPage(createQueryClient(), '/tasks?archived=1')
      // The chips come from the registry, so wait for it rather than for the URL, which is
      // already what it will be.
      const storefront = await screen.findByRole('button', { name: /storefront/ })
      expect(search()).toBe('?archived=1')

      // A filter change re-encodes the whole state; the view must survive it, and vice versa.
      fireEvent.click(storefront)
      await waitFor(() => expect(search()).toBe('?tag=storefront&archived=1'))

      fireEvent.click(screen.getByRole('button', { name: 'Active' }))
      await waitFor(() => expect(search()).toBe('?tag=storefront'))
    })

    it('publishes the view to the shared filter context, so other surfaces agree', async () => {
      // The context is what keeps this page, the per-project table and the sidebar quick-list
      // answering one question. Here the URL is the authority and the context follows it.
      stubFetch()
      render(
        <QueryClientProvider client={createQueryClient()}>
          <MemoryRouter initialEntries={['/tasks?archived=1']}>
            <ListViewProvider>
              <GlobalTasksRoute />
              <SharedViewProbe />
            </ListViewProvider>
          </MemoryRouter>
        </QueryClientProvider>,
      )

      await waitFor(() => expect(screen.getByTestId('shared-view').textContent).toBe('archived'))
    })

    it('keeps the untagged bucket readable in a shared link', async () => {
      stubFetch()
      renderPage()
      await screen.findByText('Add checkout endpoint')

      fireEvent.click(screen.getByRole('button', { name: /Untagged/ }))
      await waitFor(() => expect(search()).toBe('?untagged=1'))
      expect(rowIds()).toEqual(['i1'])
    })
  })

  it('releases the grouping when its button is pressed again', async () => {
    stubFetch()
    renderPage()
    await screen.findByText('Add checkout endpoint')

    const groupBy = () => within(screen.getByRole('group', { name: 'Group tasks by' }))
    // No "None" button to hunt for — the pressed one is the off switch.
    expect(groupBy().queryByText('None')).toBeNull()

    fireEvent.click(groupBy().getByText('Project'))
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="task-group"]').length).toBeGreaterThan(1),
    )
    expect(groupBy().getByText('Project').getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(groupBy().getByText('Project'))
    await waitFor(() => {
      const groups = document.querySelectorAll('[data-slot="task-group"]')
      expect(groups).toHaveLength(1)
      expect(groups[0]!.getAttribute('data-group-key')).toBe('all')
    })
    expect(groupBy().getByText('Project').getAttribute('aria-pressed')).toBe('false')
  })

  it('clears every facet at once', async () => {
    stubFetch()
    renderPage()
    await screen.findByText('Add checkout endpoint')

    fireEvent.click(screen.getByRole('button', { name: /storefront/ }))
    await waitFor(() => expect(rowIds()).toEqual(['a1', 'w1']))

    fireEvent.click(screen.getByRole('button', { name: /^Clear/ }))
    await waitFor(() => expect(rowIds()).toEqual(['a1', 'w1', 'i1']))
  })

  it('shows the PR / issue chip each task actually references', async () => {
    stubFetch()
    renderPage()
    await screen.findByText('Add checkout endpoint')

    // `a1` carries several — the plural case has its own test; here, the strongest leads.
    const prs = screen.getAllByRole('link', { name: /pull request for Add checkout endpoint/ })
    expect(prs[0]!.getAttribute('href')).toBe('https://github.com/acme/api/pull/42')
    expect(prs[0]!.textContent).toContain('#42')

    const issue = screen.getByRole('link', { name: /issue for Checkout page/ })
    expect(issue.getAttribute('href')).toBe('https://github.com/acme/web/issues/7')
    expect(issue.textContent).toContain('#7')
  })

  it('shows every reference a task has, not just the strongest', async () => {
    stubFetch()
    renderPage()
    await screen.findByText('Add checkout endpoint')

    const row = document.querySelector('[data-slot="global-task-row"][data-run-id="a1"]')!
    // The row itself paints the STRONGEST one — the width belongs to the task title — and the
    // rest are one hover away behind the `+N`.
    expect([...row.querySelectorAll('a[data-slot$="-chip"]')].map((chip) => chip.getAttribute('href'))).toEqual([
      'https://github.com/acme/api/pull/42',
    ])
    expect(row.querySelector('[data-slot="reference-overflow"]')?.textContent).toBe('+2')
  })

  it('collapses a pathological pile of references into a named +N', async () => {
    stubFetch({
      runs: [
        {
          ...RUNS[0]!,
          // Four distinct references — one past what the cell paints.
          pullRequestUrl: 'https://github.com/acme/api/pull/42',
          referencedPullRequestUrl: 'https://github.com/acme/api/pull/40',
          referencedIssueUrl: 'https://github.com/acme/api/issues/12',
          issueNumber: 99,
          markerRefs: { pr: 40, issue: 12 },
        },
      ],
    })
    renderPage()
    await screen.findByText('Add checkout endpoint')

    expect(document.querySelectorAll('a[data-slot$="-chip"]')).toHaveLength(1)
    const overflow = screen.getByRole('button', { name: /Show all 4 references/ })
    expect(overflow.textContent).toBe('+3')

    // Collapsed, never unreachable: opening it lists EVERY reference as a real link.
    fireEvent.click(overflow)
    const list = await screen.findByText('References')
    const chips = [...list.parentElement!.querySelectorAll('[data-slot$="-chip"]')]
    expect(chips.map((chip) => chip.textContent?.trim())).toEqual([
      '#42',
      '#40',
      'Issue #12',
      'Issue #99',
    ])
    expect(chips[2]!.getAttribute('href')).toBe('https://github.com/acme/api/issues/12')
    // Known only by number, but the project's own repo makes it a real link too — every
    // reference in the list is clickable.
    expect(chips[3]!.getAttribute('href')).toBe('https://github.com/acme/api/issues/99')
  })

  it('links a reference known only by number, from the project’s own repo', async () => {
    stubFetch({ runs: [{ ...RUNS[0]!, pullRequestUrl: undefined, referencedPullRequestUrl: undefined, referencedIssueUrl: undefined, markerRefs: undefined, prNumber: 5127 }] })
    renderPage()
    await screen.findByText('Add checkout endpoint')

    const chip = document.querySelector('[data-slot="pr-chip"]')!
    expect(chip.tagName).toBe('A')
    expect(chip.getAttribute('href')).toBe('https://github.com/acme/api/pull/5127')
  })

  it('leaves a number-only reference inert when its project has no known repo', async () => {
    // Inert text beats a link that goes somewhere invented.
    stubFetch({
      projects: PROJECTS.map((project) => ({ ...project, repoUrl: undefined })),
      runs: [{ ...RUNS[0]!, pullRequestUrl: undefined, referencedPullRequestUrl: undefined, referencedIssueUrl: undefined, markerRefs: undefined, prNumber: 5127 }],
    })
    renderPage()
    await screen.findByText('Add checkout endpoint')

    expect(document.querySelector('[data-slot="pr-chip"]')!.tagName).toBe('SPAN')
  })

  it('paints chips from the INDEX, without waiting on a ref-status answer', async () => {
    // The statuses ride along with the rows that carry the references, so the chips are coloured
    // in the same paint as the table rather than a round trip later. `refStatus` is deliberately
    // left unset: the lazy route answers "gh CLI not found" here, so a coloured chip can ONLY
    // have come from the index. (The refresh request still goes out — this removes the wait
    // before first paint, not the cadence that keeps a status current.)
    stubFetch({ indexStatuses: { api: { prs: { 42: 'merged' }, issues: {} } } })
    renderPage()
    await screen.findByText('Add checkout endpoint')

    await waitFor(() =>
      expect(document.querySelector('[data-slot="pr-chip"]')?.getAttribute('data-status')).toBe('merged'),
    )
  })

  it('still asks about references the index had nothing warm for', async () => {
    // Cache-only on the server means a cold reference is simply absent — the lazy route stays the
    // thing that actually goes and looks.
    stubFetch({
      indexStatuses: { api: { prs: { 42: 'merged' }, issues: {} } },
      refStatus: { web: { issues: { 7: 'open' } } },
    })
    renderPage()
    await screen.findByText('Checkout page')

    await waitFor(() =>
      expect(
        document.querySelector('[data-run-id="w1"] [data-slot="issue-chip"]')?.getAttribute('data-status'),
      ).toBe('open'),
    )
  })

  it('paints each chip with the state of the thing it points at', async () => {
    // The whole point of the feature: a row's `#42` says whether that PR is merged, red, or
    // waiting on a human — without opening it.
    stubFetch({
      refStatus: {
        api: { prs: { 42: 'merged', 40: 'checks-failing' }, issues: { 12: 'completed' } },
        web: { issues: { 7: 'open' } },
      },
    })
    renderPage()
    await screen.findByText('Add checkout endpoint')

    await waitFor(() => {
      expect(document.querySelector('[data-slot="pr-chip"]')?.getAttribute('data-status')).toBe('merged')
    })
    // The web row's issue belongs to ANOTHER project — its status must come from that project's
    // answer, not from whichever one the page happens to be standing in.
    const webRow = document.querySelector('[data-run-id="w1"]')
    expect(webRow?.querySelector('[data-slot="issue-chip"]')?.getAttribute('data-status')).toBe('open')
  })

  it('asks each project once, for both kinds at a time', async () => {
    stubFetch({ refStatus: { api: { prs: { 42: 'ready' } } } })
    renderPage()
    await screen.findByText('Add checkout endpoint')

    await waitFor(() => {
      expect(sent.filter((request) => request.path.includes('/github/ref-status')).length).toBeGreaterThan(0)
    })
    const asked = sent.filter((request) => request.path.includes('/github/ref-status'))
    // Two projects hold references (api, web); infra's row has none, so it is never asked.
    expect(asked.length).toBe(2)
    const api = asked.find((request) => request.path.includes('/p/api/'))!
    // Sorted, so re-sorting or re-filtering the table hits the same cache entry.
    expect(api.path).toContain('prs=40%2C42')
    expect(api.path).toContain('issues=12')
  })

  it('leaves every chip neutral when the forge cannot be reached', async () => {
    // "We could not ask" must never be paintable as "nothing is wrong".
    stubFetch()
    renderPage()
    await screen.findByText('Add checkout endpoint')

    expect(document.querySelector('[data-slot="pr-chip"]')?.getAttribute('data-status')).toBeNull()
  })

  describe('the +N reference list', () => {
    const manyRefs = () => [
      {
        ...RUNS[0]!,
        pullRequestUrl: 'https://github.com/acme/api/pull/42',
        referencedPullRequestUrl: 'https://github.com/acme/api/pull/40',
        referencedIssueUrl: 'https://github.com/acme/api/issues/12',
        markerRefs: { pr: 40, issue: 12 },
      },
    ]
    const overflow = () => screen.getByRole('button', { name: /Show all 3 references/ })
    const listed = () =>
      [...document.querySelectorAll('[data-slot="reference-overflow-list"] [data-slot$="-chip"]')]

    it('opens on hover, and stays open while the pointer travels into it', async () => {
      stubFetch({ runs: manyRefs() })
      renderPage()
      await screen.findByText('Add checkout endpoint')

      fireEvent.pointerEnter(overflow(), { pointerType: 'mouse' })
      await waitFor(() => expect(listed()).toHaveLength(3))

      // Leaving the trigger starts a close; entering the list cancels it, which is the only way
      // the links are reachable at all.
      fireEvent.pointerLeave(overflow(), { pointerType: 'mouse' })
      const list = document.querySelector('[data-slot="reference-overflow-list"]')!
      fireEvent.pointerEnter(list, { pointerType: 'mouse' })
      await new Promise((resolve) => setTimeout(resolve, 350))
      expect(listed()).toHaveLength(3)
    })

    it('closes once the pointer leaves both', async () => {
      stubFetch({ runs: manyRefs() })
      renderPage()
      await screen.findByText('Add checkout endpoint')

      fireEvent.pointerEnter(overflow(), { pointerType: 'mouse' })
      await waitFor(() => expect(listed()).toHaveLength(3))

      fireEvent.pointerLeave(overflow(), { pointerType: 'mouse' })
      await waitFor(() => expect(listed()).toHaveLength(0))
    })

    it('ignores the hover a TAP fires, so touch gets one clean open from the click', async () => {
      // A tap fires `pointerenter` before `click`. Without the guard the list would open under
      // the finger and then be toggled shut again by the click that follows.
      stubFetch({ runs: manyRefs() })
      renderPage()
      await screen.findByText('Add checkout endpoint')

      fireEvent.pointerEnter(overflow(), { pointerType: 'touch' })
      expect(listed()).toHaveLength(0)

      fireEvent.click(overflow())
      await waitFor(() => expect(listed()).toHaveLength(3))
    })

    it('opens on click for the keyboard too', async () => {
      stubFetch({ runs: manyRefs() })
      renderPage()
      await screen.findByText('Add checkout endpoint')

      fireEvent.click(overflow())
      await waitFor(() => expect(listed()).toHaveLength(3))
    })
  })

  describe('cost, CPU and memory', () => {
    it('shows a running task’s live sample and its cost', async () => {
      stubFetch({
        runs: [
          {
            ...RUNS[0]!,
            status: 'running',
            costUsd: 0.31,
            usage: { cpuPct: 84, rssBytes: 612 * 1024 * 1024, procCount: 3 },
          },
        ],
      })
      renderPage()
      await screen.findByText('Add checkout endpoint')

      expect(screen.getByText('$0.31')).toBeTruthy()
      const cpu = document.querySelector('[data-usage="cpu"]')!
      expect(cpu.textContent).toBe('84%')
      expect(cpu.getAttribute('data-usage-kind')).toBe('live')
      expect(document.querySelector('[data-usage="mem"]')!.textContent).toBe('612 MB')
    })

    it('falls back to the persisted peak once the run is finished', async () => {
      // The live sample stops existing with the process tree; without the peaks a finished row
      // could say nothing at all about what it took to run.
      stubFetch({
        runs: [{ ...RUNS[2]!, peakRssBytes: 900 * 1024 * 1024, peakProcCount: 4 }],
      })
      renderPage()
      await screen.findByText('Bump the runner')

      const mem = document.querySelector('[data-usage="mem"]')!
      expect(mem.textContent).toBe('peak 900 MB')
      expect(mem.getAttribute('data-usage-kind')).toBe('peak')
      // CPU has no persisted peak, so it says nothing rather than inventing one.
      expect(document.querySelector('[data-usage="cpu"]')!.getAttribute('data-usage-kind')).toBe(
        'none',
      )
    })

    it('never paints a finished run’s stale sample as live', async () => {
      stubFetch({
        runs: [
          {
            ...RUNS[2]!,
            status: 'done',
            usage: { cpuPct: 99, rssBytes: 1024, procCount: 1 },
          },
        ],
      })
      renderPage()
      await screen.findByText('Bump the runner')

      expect(document.querySelector('[data-usage="cpu"]')!.getAttribute('data-usage-kind')).toBe(
        'none',
      )
    })

    it('drops the Cost column when the host hides cost metrics', async () => {
      stubFetch({ costMetrics: false, runs: [{ ...RUNS[0]!, costUsd: 0.31 }] })
      renderPage()
      await screen.findByText('Add checkout endpoint')

      expect(screen.queryByText('Cost')).toBeNull()
      expect(screen.queryByText('$0.31')).toBeNull()
    })
  })

  describe('read / unread', () => {
    // A finished, unopened task — the state the marker exists for.
    const unreadRun = () => [
      { ...RUNS[2]!, status: 'done' as const, finishedAt: '2026-07-14T09:00:00Z' },
    ]

    it('marks a task read in its OWN project, clearing the unread marker', async () => {
      stubFetch({ runs: unreadRun() })
      renderPage()
      await screen.findByText('Bump the runner')
      expect(document.querySelectorAll('[aria-label="unread"]')).toHaveLength(1)

      fireEvent.click(screen.getByRole('button', { name: /Mark Bump the runner read/ }))

      await waitFor(() =>
        expect(sent.find((request) => request.method === 'POST')?.path).toBe(
          '/api/v1/workspace/runs/infra/i1/read',
        ),
      )
      await waitFor(() => expect(document.querySelectorAll('[aria-label="unread"]')).toHaveLength(0))
    })

    it('takes the receipt back again', async () => {
      stubFetch({
        runs: [{ ...unreadRun()[0]!, seenAt: '2026-07-14T09:00:01Z' }],
      })
      renderPage()
      await screen.findByText('Bump the runner')
      expect(document.querySelectorAll('[aria-label="unread"]')).toHaveLength(0)

      fireEvent.click(screen.getByRole('button', { name: /Mark Bump the runner unread/ }))

      await waitFor(() =>
        expect(sent.find((request) => request.method === 'POST')?.path).toBe(
          '/api/v1/workspace/runs/infra/i1/unread',
        ),
      )
      await waitFor(() => expect(document.querySelectorAll('[aria-label="unread"]')).toHaveLength(1))
    })

    it('is absent where there is no read state to change', async () => {
      // `a1` is still running — nothing to have read yet, and a button that did nothing would
      // say otherwise.
      stubFetch()
      renderPage()
      await screen.findByText('Add checkout endpoint')

      const running = document.querySelector('[data-slot="global-task-row"][data-run-id="a1"]')!
      expect(running.querySelector('[data-action^="mark-"]')).toBeNull()
    })
  })

  it('archives a finished task in its OWN project and drops it from Active', async () => {
    stubFetch()
    renderPage()
    await screen.findByText('Bump the runner')

    // `i1` is done; `a1` is running, so it has no archive button at all.
    const row = document.querySelector('[data-slot="global-task-row"][data-run-id="a1"]')!
    expect(row.querySelector('[data-action="archive-run"]')).toBeNull()

    fireEvent.click(
      document
        .querySelector('[data-slot="global-task-row"][data-run-id="i1"]')!
        .querySelector<HTMLButtonElement>('[data-action="archive-run"]')!,
    )

    // The request names the run's own project, not the boot one.
    await waitFor(() =>
      expect(sent.find((request) => request.method === 'POST')).toEqual({
        method: 'POST',
        path: '/api/v1/workspace/runs/infra/i1/archive',
        body: { archived: true },
      }),
    )
    await waitFor(() => expect(rowIds()).toEqual(['a1', 'w1']))
  })

  it('restores an archived task from the Archived tab', async () => {
    stubFetch({ runs: RUNS.map((run) => (run.id === 'i1' ? { ...run, archived: true } : run)) })
    renderPage()
    await screen.findByText('Add checkout endpoint')

    fireEvent.click(screen.getByRole('button', { name: 'Archived' }))
    await waitFor(() => expect(rowIds()).toEqual(['i1']))

    fireEvent.click(document.querySelector<HTMLButtonElement>('[data-action="unarchive-run"]')!)
    await waitFor(() =>
      expect(sent.find((request) => request.method === 'POST')?.body).toEqual({ archived: false }),
    )
    await waitFor(() => expect(rowIds()).toEqual([]))
  })

  it('puts a refused archive back and shows the server’s reason', async () => {
    stubFetch({ archiveStatus: 409 })
    renderPage()
    await screen.findByText('Bump the runner')

    fireEvent.click(
      document
        .querySelector('[data-slot="global-task-row"][data-run-id="i1"]')!
        .querySelector<HTMLButtonElement>('[data-action="archive-run"]')!,
    )

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('still running'))
    // Rolled back: the row is still in the Active list.
    await waitFor(() => expect(rowIds()).toEqual(['a1', 'w1', 'i1']))
  })

  it('picks up a read receipt made elsewhere, without a page refresh', async () => {
    // The reported bug: open an unread task from here, come back, and it was still bold until a
    // refresh. `useMarkRunSeen` invalidates the workspace index (queries.test.tsx pins that);
    // this is the other half — an invalidated index really is re-read when the page remounts.
    const unread: RunIndexEntry = {
      ...RUNS[2]!,
      status: 'done',
      finishedAt: '2026-07-14T09:00:00Z',
    }
    stubFetch({ runs: [unread] })
    const client = createQueryClient()
    const { unmount } = renderPage(client)
    await waitFor(() => expect(unreadMarkers()).toHaveLength(1))

    // The thread stamps the receipt server-side and invalidates the index.
    seenAt = '2026-07-14T09:00:01Z'
    await act(async () => {
      await client.invalidateQueries({ queryKey: workspaceQueryKeys.runsIndex })
    })
    unmount()

    renderPage(client)
    await waitFor(() => expect(unreadMarkers()).toHaveLength(0))
  })

  it('offers no project filter — a project name is a link to its own page', async () => {
    stubFetch()
    renderPage()
    await screen.findByText('Add checkout endpoint')

    expect(document.querySelector('[data-slot="facet-project"]')).toBeNull()
    expect(screen.getByRole('link', { name: 'API' }).getAttribute('href')).toBe('/p/api/')

    // Grouping by project turns each heading into the same door.
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Group tasks by' })).getByText('Project'),
    )
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="group-project-link"]')?.getAttribute('href'),
      ).toBe('/p/api/'),
    )
  })

  it('says which projects the index had to cap instead of showing a short list silently', async () => {
    stubFetch({ truncated: ['api'] })
    renderPage()

    const notice = await screen.findByText(/Showing the newest 200 tasks per project/)
    // Named by its registry name, not its slug.
    expect(notice.textContent).toContain('API')
  })

  it('points at Settings when the workspace has no tags at all', async () => {
    stubFetch({ projects: PROJECTS.map((project) => ({ ...project, tags: undefined })) })
    renderPage()

    const hint = await screen.findByText(/Tag connected repositories in/)
    // …and it is a real door, not a sentence naming a place the reader has to go find.
    expect(
      hint.querySelector('a[href="/settings/global/projects"]')?.textContent,
    ).toBe('Settings → Projects')
  })

  it('renders the server’s error rather than an empty table', async () => {
    stubFetch({ indexStatus: 500 })
    renderPage()

    // The query retries a 5xx once with a backoff, so this settles later than the happy paths.
    expect(
      await screen.findByText('Tasks across projects did not load', {}, { timeout: 5000 }),
    ).toBeTruthy()
  })
})

/**
 * Filed-but-unstarted tasks (2026-08-15).
 *
 * The composer's All / Auto submit writes todos across projects and starts nothing. Until this
 * section existed they had no reachable surface anywhere in the cockpit — this page listed runs,
 * `/workspace/tasks` listed runs, and `/inbox` is hidden from the nav (and says the inbox is off)
 * unless `CEZ_FOLLOWUPS=1`. So filing twelve tasks and filing none looked identical, which is how
 * the bug was reported: "I just tried to add a task and nothing happened."
 */
/**
 * The Running section (`.ai/specs/2026-08-19-tasks-page-and-start-grounding.md`, D1).
 *
 * Asserted on DOCUMENT ORDER, not on both sections merely existing: "Running is above Filed" is
 * the entire owner-facing change, and a test that only checks both are on the page passes just as
 * happily with them the other way round — which is the state this spec was written to fix.
 */
describe('the Running section', () => {
  const TODOS: WorkspaceTodoEntry[] = [
    { project: 'api', todo: { id: 'todo-1', ts: '2026-07-14T09:00:00Z', summary: 'Add a rate limit to /checkout' } },
  ]

  const positionOf = (slot: string) => {
    const node = document.querySelector(`[data-slot="${slot}"]`)
    return node ? [...document.querySelectorAll('[data-slot]')].indexOf(node) : -1
  }

  it('renders above the Filed section', async () => {
    stubFetch({ todos: TODOS })
    renderPage()
    await screen.findByText('Add a rate limit to /checkout')

    const running = document.querySelector('[data-slot="running-tasks"]')!
    const filed = document.querySelector('[data-slot="filed-tasks"]')!
    expect(running).toBeTruthy()
    expect(filed).toBeTruthy()
    // `DOCUMENT_POSITION_FOLLOWING` = filed comes after running in the document.
    expect(running.compareDocumentPosition(filed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(positionOf('running-tasks')).toBeLessThan(positionOf('filed-tasks'))
  })

  it('holds the work in flight and nothing that has finished', async () => {
    stubFetch()
    renderPage()
    await screen.findByText('Add checkout endpoint')

    const running = document.querySelector('[data-slot="running-tasks"]') as HTMLElement
    // a1 is `running`, w1 is `review` — both in flight. i1 is `done` and belongs below.
    expect(within(running).getByText('Add checkout endpoint')).toBeTruthy()
    expect(within(running).getByText('Checkout page')).toBeTruthy()
    expect(within(running).queryByText('Bump the runner')).toBeNull()
    expect(document.querySelector('[data-slot="running-tasks-count"]')?.textContent).toBe('2')
  })

  /**
   * Lifted, not copied — the correction this section's first cut needed.
   *
   * Rendering the running rows in BOTH places turned 39 existing cases red with "found multiple
   * elements", which is the same thing a reader would see: one task, twice, on one screen. This
   * pins the fix, and `getByText` (which throws on more than one match) is doing the real work —
   * a `queryBy` here would pass against the duplicated version.
   */
  it('lifts its rows OUT of the table below rather than duplicating them', async () => {
    stubFetch()
    renderPage()
    await screen.findByText('Add checkout endpoint')

    expect(screen.getByText('Add checkout endpoint')).toBeTruthy()
    expect(screen.getAllByText('Add checkout endpoint')).toHaveLength(1)
    // The settled row is below, in the grouped table, and appears exactly once there too.
    const groups = document.querySelector('[data-slot="task-group"]') as HTMLElement
    expect(within(groups).getByText('Bump the runner')).toBeTruthy()
    expect(within(groups).queryByText('Add checkout endpoint')).toBeNull()
  })

  it('leaves no empty-state claim when every visible row is running', async () => {
    // `settled` is empty here but the page is emphatically not: "no tasks" over a table of live
    // work would be the worst possible answer.
    stubFetch({ runs: RUNS.filter((run) => run.id !== 'i1') })
    renderPage()
    await screen.findByText('Add checkout endpoint')
    expect(document.querySelector('[data-slot="running-tasks"]')).toBeTruthy()
    expect(document.querySelector('[data-slot="tasks-empty"]')).toBeNull()
    expect(screen.queryByText(/no tasks/i)).toBeNull()
  })

  it('renders nothing at all when nothing is in flight', async () => {
    stubFetch({ runs: RUNS.map((run) => ({ ...run, status: 'done' as const })) })
    renderPage()
    await screen.findByText('Add checkout endpoint')
    expect(document.querySelector('[data-slot="running-tasks"]')).toBeNull()
  })

  it('renders nothing on the Archived tab, where a "Running" heading would be a lie', async () => {
    stubFetch({ runs: RUNS.map((run) => ({ ...run, archived: true })) })
    renderPage(createQueryClient(), '/tasks?archived=1')
    await screen.findByText('Add checkout endpoint')
    expect(document.querySelector('[data-slot="running-tasks"]')).toBeNull()
  })

  it('steps aside when a grouping is chosen, handing its rows back to the groups', async () => {
    stubFetch()
    renderPage(createQueryClient(), '/tasks?group=project')
    await screen.findByText('Add checkout endpoint')

    expect(document.querySelector('[data-slot="running-tasks"]')).toBeNull()
    // Handed BACK, not lost: the running row is under its project heading again. Without this the
    // "steps aside" assertion above is satisfied just as well by dropping the rows on the floor.
    const apiGroup = document.querySelector('[data-slot="task-group"][data-group-key="api"]') as HTMLElement
    expect(within(apiGroup).getByText('Add checkout endpoint')).toBeTruthy()
  })

  /**
   * Reference chips are painted from React context, so a section rendered OUTSIDE
   * `ReferenceStatusProvider` shows neutral chips forever while the identical row below is
   * coloured. The first cut of this section did exactly that.
   *
   * `a1` (running, PR #42) now lives in the Running section, so this asserts the colour INSIDE it
   * — scoped with `within`, or the chip in the table below would satisfy it just as well.
   */
  it('paints reference chips inside the section, not only in the table below', async () => {
    stubFetch({ indexStatuses: { api: { prs: { 42: 'merged' }, issues: {} } } })
    renderPage()
    await screen.findByText('Add checkout endpoint')

    const running = document.querySelector('[data-slot="running-tasks"]') as HTMLElement
    await waitFor(() =>
      expect(running.querySelector('[data-slot="pr-chip"]')?.getAttribute('data-status')).toBe('merged'),
    )
  })
})

describe('the Filed section', () => {
  const TODOS: WorkspaceTodoEntry[] = [
    { project: 'api', todo: { id: 'todo-1', ts: '2026-07-14T09:00:00Z', summary: 'Add a rate limit to /checkout' } },
    { project: 'web', todo: { id: 'todo-2', ts: '2026-07-14T09:00:01Z', summary: 'Ship the storefront banner' } },
  ]

  const filedRows = () => [...document.querySelectorAll('[data-slot="filed-task-row"]')]
  const filedRowIds = () => filedRows().map((row) => row.getAttribute('data-todo-id'))

  it('lists filed tasks above the runs, with the project each one belongs to', async () => {
    stubFetch({ todos: TODOS })
    renderPage()

    const section = await screen.findByText('Add a rate limit to /checkout')
    expect(section).toBeTruthy()
    expect(screen.getByText('Ship the storefront banner')).toBeTruthy()
    // Each row names its own repository: these come from different projects and the page stands
    // in none of them. Newest-first (the default sort): todo-2 was filed a second after todo-1.
    expect(filedRows().map((row) => row.getAttribute('data-project'))).toEqual(['web', 'api'])
    expect(document.querySelector('[data-slot="filed-tasks-count"]')?.textContent).toBe('2')
  })

  it('renders with no capability flag set — the default install is the case that needs it', async () => {
    // The health stub carries neither `followups` nor `workspaceViews`. Re-gating the section on
    // either turns this red, which is exactly the regression: filed tasks invisible on the very
    // installs the fan-out serves.
    stubFetch({ todos: TODOS })
    renderPage()
    expect(await screen.findByText('Add a rate limit to /checkout')).toBeTruthy()
  })

  it('starts a filed task in ITS OWN project and follows it to the run', async () => {
    stubFetch({ todos: TODOS })
    renderPage()
    await screen.findByText('Ship the storefront banner')

    const webRow = document.querySelector('[data-slot="filed-task-row"][data-project="web"]')!
    fireEvent.click(webRow.querySelector('[data-action="start-filed-task"]')!)

    await waitFor(() =>
      expect(
        sent.some((r) => r.method === 'POST' && r.path === '/api/v1/p/web/todos/todo-2/start'),
      ).toBe(true),
    )
    // Never against `api` (the boot project, and the first row) — the row's project is the truth.
    expect(sent.some((r) => r.path.startsWith('/api/v1/p/api/todos/'))).toBe(false)
  })

  it('renders nothing at all when nothing is filed', async () => {
    // No empty header hovering above the runs table: a workspace that never files is the common
    // case, and permanent furniture advertising an unused feature is its own kind of noise.
    stubFetch({ todos: [] })
    renderPage()
    await screen.findByText('Add checkout endpoint')
    expect(document.querySelector('[data-slot="filed-tasks"]')).toBeNull()
  })

  it('renders on BOTH tabs now, and a row’s own state — not the tab it lands on — decides which one it sits under', async () => {
    // 2026-08-17-filed-tasks-table-statuses.md: the section used to be gated on `view === 'active'`
    // outright, so switching to Archived hid it regardless of content. It is now unconditional,
    // and `matchesFiledView` alone decides: archived-or-done sits under Archived, everything else
    // under Active — independent of whether the row was ever explicitly archived.
    const mixed: WorkspaceTodoEntry[] = [
      ...TODOS,
      {
        project: 'api',
        todo: {
          id: 'todo-3',
          ts: '2026-07-13T09:00:00Z',
          summary: 'Retire the legacy webhook',
          status: 'done',
        },
      },
      {
        project: 'web',
        todo: {
          id: 'todo-4',
          ts: '2026-07-12T09:00:00Z',
          summary: 'Draft the pricing page',
          archivedAt: '2026-07-13T00:00:00Z',
        },
      },
    ]
    stubFetch({ todos: mixed })
    renderPage()
    await screen.findByText('Add a rate limit to /checkout')
    // Newest-first: todo-2 was filed a second after todo-1.
    expect(filedRowIds()).toEqual(['todo-2', 'todo-1'])

    fireEvent.click(screen.getByRole('button', { name: 'Archived' }))
    await waitFor(() => expect(search()).toBe('?archived=1'))
    // `todo-3` (done, never archived) and `todo-4` (archived, still `todo`) both qualify.
    await waitFor(() => expect(filedRowIds()).toEqual(['todo-3', 'todo-4']))
  })

  it('stays off the Archived view when nothing filed qualifies for it', async () => {
    // Arrives on Active and WAITS for the rows first. Landing straight on `?archived=1` and
    // asserting the section is absent passes whether the view hides it or the query simply had
    // not answered yet — absence is the loading state too. Seeing the rows, then switching, is
    // what makes this assertion mean anything. Neither TODOS entry is archived or done, so —
    // unlike the mixed fixture above — Archived has nothing to show.
    stubFetch({ todos: TODOS })
    renderPage()
    await screen.findByText('Add a rate limit to /checkout')

    fireEvent.click(screen.getByRole('button', { name: 'Archived' }))
    await waitFor(() => expect(search()).toBe('?archived=1'))
    expect(document.querySelector('[data-slot="filed-tasks"]')).toBeNull()
  })

  it('archives a filed task from the row action, and the row leaves Active', async () => {
    stubFetch({ todos: TODOS })
    renderPage()
    await screen.findByText('Add a rate limit to /checkout')

    const apiRow = document.querySelector('[data-slot="filed-task-row"][data-project="api"]')!
    fireEvent.click(apiRow.querySelector('[data-action="archive-filed-task"]')!)

    await waitFor(() =>
      expect(sent.some((r) => r.method === 'PATCH' && r.path === '/api/v1/p/api/todos/todo-1')).toBe(
        true,
      ),
    )
    expect(sent.find((r) => r.method === 'PATCH')?.body).toEqual({ archived: true })
    await waitFor(() => expect(filedRowIds()).toEqual(['todo-2']))
  })

  it('puts a refused archive back and shows the server’s reason', async () => {
    // Same shape as the runs table's own "puts a refused archive back" test: the assertion is on
    // the settled toast and the restored row set, not on the transient optimistic frame — the
    // mock's PATCH rejects with no artificial delay, so the optimistic patch and its own rollback
    // can land within the same microtask turn `waitFor`'s first poll would observe.
    stubFetch({ todos: TODOS, todoPatchStatus: 409 })
    renderPage()
    await screen.findByText('Add a rate limit to /checkout')

    const apiRow = document.querySelector('[data-slot="filed-task-row"][data-project="api"]')!
    fireEvent.click(apiRow.querySelector('[data-action="archive-filed-task"]')!)

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('lease held elsewhere'))
    // Rolled back: both rows are still on Active, in the default sort's order.
    await waitFor(() => expect(filedRowIds()).toEqual(['todo-2', 'todo-1']))
  })

  it('opens the detail dialog and renders only the sections the entry actually carries', async () => {
    const rich: WorkspaceTodoEntry[] = [
      {
        project: 'api',
        todo: {
          id: 'todo-1',
          ts: '2026-07-14T09:00:00Z',
          summary: 'Add a rate limit to /checkout',
          context: 'Checkout is getting hammered by one client.',
          whatToDo: 'Add a token-bucket limiter in front of /checkout.',
        },
      },
      TODOS[1]!,
    ]
    stubFetch({ todos: rich })
    renderPage()
    await screen.findByText('Add a rate limit to /checkout')

    fireEvent.click(screen.getByText('Add a rate limit to /checkout'))
    const dialog = await screen.findByRole('dialog')

    expect(within(dialog).getByText('Checkout is getting hammered by one client.')).toBeTruthy()
    expect(within(dialog).getByText('Add a token-bucket limiter in front of /checkout.')).toBeTruthy()
    // No acceptance criteria and no knowledge refs on this entry — no section for either.
    expect(dialog.querySelector('[data-slot="filed-task-acceptance-criteria"]')).toBeNull()
    expect(dialog.querySelector('[data-slot="filed-task-knowledge-refs"]')).toBeNull()
  })
})
