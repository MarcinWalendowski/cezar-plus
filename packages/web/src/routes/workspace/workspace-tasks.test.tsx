import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { HealthResponse, WorkspaceRunsResponse, WorkspaceUiState } from '@loki-labs/better-cezar-api-client'

import { WorkspaceTasksRoute } from './workspace-tasks'

/**
 * `/workspace/tasks` (W4.10), `.ai/specs/2026-08-06-workspace-notes-cross-project.md` "UI/UX" —
 * "Workspace Tasks board". Rendered directly (not through `AppRoutes`) since this route mounts
 * OUTSIDE `ProjectScopeRoute` and needs no `:projectId` param to resolve.
 */

interface SentRequest {
  path: string
  method: string
  body?: unknown
}

const CAPABILITIES_ON: HealthResponse['capabilities'] = {
  cluster: false,
  localHandoff: true,
  followups: true,
  singleProject: false,
  automations: false,
  tokenMetrics: true,
  tokenUsageMetrics: true,
  costMetrics: true,
  knowledge: false,
  sources: false,
  notes: false,
  workspaceViews: true,
  notify: false,
  accountUsage: false,
  autoAccounts: false,
  skills: true,
}

function health(overrides: Partial<HealthResponse> = {}): HealthResponse {
  return {
    version: '0.0.0-test',
    repoRoot: '/repo/boot',
    repo: { root: '/repo/boot', branch: 'main' },
    checks: [],
    defaultRunner: 'claude',
    forge: null,
    capabilities: CAPABILITIES_ON,
    projects: [
      { id: 'boot', name: 'boot' },
      { id: 'shop', name: 'Shop' },
    ],
    bootProject: 'boot',
    ...overrides,
  }
}

const RUNS_RESPONSE: WorkspaceRunsResponse = {
  runs: [
    {
      project: 'boot',
      id: 'run-boot-1',
      title: 'Fix the flaky retry test',
      workflow: 'quick-task',
      status: 'done',
      createdAt: '2026-08-01T00:00:00.000Z',
      archived: false,
      tokensUsed: 10,
      costUsd: 0.42,
    },
    {
      project: 'shop',
      id: 'run-shop-1',
      title: 'Ship the storefront',
      workflow: 'quick-task',
      status: 'running',
      createdAt: '2026-08-02T00:00:00.000Z',
      archived: false,
      tokensUsed: 20,
      branch: 'cez/ab12cd34',
    },
  ],
  projects: [
    { id: 'boot', name: 'boot', status: 'ok', ok: true, total: 1 },
    { id: 'shop', name: 'Shop', status: 'ok', ok: true, total: 1 },
  ],
  truncated: false,
  bootProject: 'boot',
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Fetch stub in the house style (`inbox.test.tsx`, `settings/notifications-section.test.tsx`):
 *  records every request and serves the fixtures, with per-test overrides. `uiState` is a
 *  MUTABLE object updated on every PUT, so a restore-then-read round-trips like the real server. */
function stubFetch({
  healthResponse = health(),
  runsResponse = RUNS_RESPONSE,
  uiState = {} as WorkspaceUiState,
  clusterOverview,
  clusterActive,
}: {
  healthResponse?: HealthResponse
  runsResponse?: WorkspaceRunsResponse
  uiState?: WorkspaceUiState
  /** `GET /api/v1/cluster`'s answer, read when `healthResponse.capabilities.cluster` is on
   *  (`global-tasks.test.tsx` precedent — same shape, same default). */
  clusterOverview?: unknown
  /** `GET /api/v1/cluster/active`'s answer — what the Node column joins a row's `run.id`
   *  against. Absent = `{ runs: [] }`, the honest "nothing known elsewhere" default. */
  clusterActive?: unknown
} = {}): SentRequest[] {
  const sent: SentRequest[] = []
  let storedUiState = { ...uiState }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)
      const path = url.split('?')[0]!
      const method = init.method ?? 'GET'
      sent.push({ path: url, method, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) })
      if (method === 'GET' && path === '/api/v1/health') return jsonResponse(healthResponse)
      if (method === 'GET' && path === '/api/v1/workspace/runs') {
        // A minimal stand-in for the real server's own filtering (`workspace-runs-api.test.ts`
        // covers the real thing) — just enough so a test that narrows `projects` or `view` sees
        // a DIFFERENT board than one that doesn't, which is the whole point of these tests.
        const params = new URL(url, 'http://workspace-tasks.test').searchParams
        const projectsParam = params.get('projects')
        const projectIds = projectsParam === null ? null : projectsParam.split(',').filter(Boolean)
        const view = params.get('view') ?? 'active'
        const runs = runsResponse.runs.filter((r) => {
          if (projectIds && !projectIds.includes(r.project)) return false
          return view === 'archived' ? r.archived === true : r.archived !== true
        })
        const projects = projectIds ? runsResponse.projects.filter((p) => projectIds.includes(p.id)) : runsResponse.projects
        return jsonResponse({ ...runsResponse, runs, projects })
      }
      if (method === 'GET' && path === '/api/v1/cluster') {
        return jsonResponse(
          clusterOverview ?? { nodes: [], pairings: [], proposals: [], link: { state: 'disabled' } },
        )
      }
      if (method === 'GET' && path === '/api/v1/cluster/active') {
        return jsonResponse(clusterActive ?? { runs: [] })
      }
      if (method === 'GET' && path === '/api/v1/workspace/ui-state') return jsonResponse(storedUiState)
      if (method === 'PUT' && path === '/api/v1/workspace/ui-state') {
        const patch = JSON.parse(String(init.body)) as Record<string, unknown>
        storedUiState = { ...storedUiState, ...patch } as WorkspaceUiState
        return jsonResponse(storedUiState)
      }
      return jsonResponse({ error: `unmocked ${method} ${url}` }, 404)
    }),
  )
  return sent
}

function LocationProbe() {
  const location = useLocation()
  return (
    <output data-testid="location">
      {location.pathname}
      {location.search}
    </output>
  )
}

function renderAt(entry: string) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <WorkspaceTasksRoute />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const locationText = () => screen.getByTestId('location').textContent

beforeEach(() => {
  // Radix's dropdown positions with floating-ui (ResizeObserver); jsdom ships neither
  // (`project-filter.test.tsx` precedent).
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }))
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function openProjectFilter() {
  fireEvent.pointerDown(screen.getByRole('button', { name: /projects$/i }))
  return await screen.findByRole('menu')
}

/** jsdom does not apply the `md:block`/`md:hidden` responsive classes, so the desktop table AND
 *  the mobile card list are both literally in the DOM at once. Every content assertion below is
 *  scoped to the table so it is not ambiguous between the two renderings of the same row. */
function desktopTable(): HTMLElement {
  const table = document.querySelector('[data-slot="workspace-tasks-table"]')
  if (!table) throw new Error('the workspace tasks table has not rendered yet')
  return table as HTMLElement
}

/** Waits for the table container to exist AND for `text` to appear inside it — two things that
 *  can each still be pending right after a render or a filter change. */
async function findInTable(text: string): Promise<HTMLElement> {
  return await waitFor(() => within(desktopTable()).getByText(text))
}

describe('capability gating', () => {
  it('capability off renders the disabled state and no board affordances', async () => {
    stubFetch({ healthResponse: health({ capabilities: { ...CAPABILITIES_ON, workspaceViews: false } }) })
    renderAt('/workspace/tasks')
    await screen.findByText('The cross-project board is off')
    expect(screen.queryByRole('button', { name: /projects$/i })).toBeNull()
    expect(screen.queryByRole('button', { name: 'active' })).toBeNull()
  })

  it('capability on renders the board, the view tabs and the project filter', async () => {
    stubFetch()
    renderAt('/workspace/tasks')
    await screen.findByRole('button', { name: 'active' })
    expect(screen.getByRole('button', { name: 'All projects' })).toBeTruthy()
    await findInTable('Fix the flaky retry test')
  })
})

describe('the scope trap', () => {
  it('never issues a request to a project-scoped endpoint', async () => {
    const sent = stubFetch()
    renderAt('/workspace/tasks')
    await findInTable('Fix the flaky retry test')
    await findInTable('Ship the storefront')
    expect(sent.some((r) => r.path.startsWith('/api/v1/p/'))).toBe(false)
    // Sanity: it DID talk to the workspace-level surfaces, so the assertion above is not vacuous.
    expect(sent.some((r) => r.path.startsWith('/api/v1/workspace/runs'))).toBe(true)
  })
})

describe('row links', () => {
  it("a non-boot project's row links to /p/<project>/tasks/<id>, never the scope-relative path", async () => {
    stubFetch()
    renderAt('/workspace/tasks')
    await findInTable('Ship the storefront')
    const row = desktopTable().querySelector('[data-run-id="run-shop-1"]')!
    const link = within(row as HTMLElement).getByRole('link', { name: 'Ship the storefront' })
    expect(link.getAttribute('href')).toBe('/p/shop/tasks/run-shop-1')
  })

  it("the boot project's row also links through /p/<id>/tasks/<runId>, not the bare /tasks/<id>", async () => {
    stubFetch()
    renderAt('/workspace/tasks')
    await findInTable('Fix the flaky retry test')
    const row = desktopTable().querySelector('[data-run-id="run-boot-1"]')!
    const link = within(row as HTMLElement).getByRole('link', { name: 'Fix the flaky retry test' })
    expect(link.getAttribute('href')).toBe('/p/boot/tasks/run-boot-1')
  })
})

describe('the project column and dead-project warning', () => {
  it('renders a project chip per row', async () => {
    stubFetch()
    renderAt('/workspace/tasks')
    await findInTable('Fix the flaky retry test')
    const bootRow = desktopTable().querySelector('[data-run-id="run-boot-1"] [data-slot="workspace-run-project"]')
    const shopRow = desktopTable().querySelector('[data-run-id="run-shop-1"] [data-slot="workspace-run-project"]')
    expect(bootRow?.textContent).toBe('boot')
    expect(shopRow?.textContent).toBe('Shop')
  })

  it('an unreadable project renders a warning strip naming it and its reason, without blanking the rest', async () => {
    stubFetch({
      runsResponse: {
        ...RUNS_RESPONSE,
        projects: [
          ...RUNS_RESPONSE.projects,
          { id: 'broken', name: 'Broken', status: 'ok', ok: false, reason: 'runs.json is not valid JSON', total: 0 },
        ],
      },
    })
    renderAt('/workspace/tasks')
    await findInTable('Fix the flaky retry test')
    const warning = screen.getByText('runs.json is not valid JSON', { exact: false })
    expect(warning).toBeTruthy()
    expect(within(desktopTable()).getByText('Ship the storefront')).toBeTruthy()
  })
})

describe('the "no projects match this filter" state', () => {
  it('an explicit empty `projects=` renders the dedicated empty state, distinct from "no tasks yet"', async () => {
    stubFetch()
    renderAt('/workspace/tasks?projects=')
    await screen.findByText('No projects match this filter')
    expect(screen.queryByText('No tasks yet')).toBeNull()
  })

  it('Clear filter restores ALL projects and the board renders again', async () => {
    stubFetch()
    renderAt('/workspace/tasks?projects=')
    await screen.findByText('No projects match this filter')
    fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }))
    await findInTable('Fix the flaky retry test')
    expect(locationText()).toBe('/workspace/tasks?view=active')
  })
})

describe('the project filter and view tabs write through to the URL and ui-state', () => {
  it('picking a project narrows the URL, the request, and mirrors into ui-state', async () => {
    const sent = stubFetch()
    renderAt('/workspace/tasks')
    await findInTable('Fix the flaky retry test')
    const menu = await openProjectFilter()
    fireEvent.click(within(menu).getByRole('menuitemcheckbox', { name: 'boot' }))

    await waitFor(() => expect(locationText()).toBe('/workspace/tasks?projects=shop&view=active'))
    await waitFor(() =>
      expect(
        sent.some((r) => r.method === 'GET' && r.path === '/api/v1/workspace/runs?projects=shop&view=active'),
      ).toBe(true),
    )
    await waitFor(() =>
      expect(
        sent.some(
          (r) =>
            r.method === 'PUT' &&
            r.path === '/api/v1/workspace/ui-state' &&
            JSON.stringify(r.body) === JSON.stringify({ workspaceTasks: { projects: ['shop'], view: 'active' } }),
        ),
      ).toBe(true),
    )
  })

  it('switching to Archived updates the URL and re-queries with view=archived', async () => {
    const sent = stubFetch({ runsResponse: { ...RUNS_RESPONSE, runs: [], projects: [] } })
    renderAt('/workspace/tasks')
    await screen.findByRole('button', { name: 'active' })
    fireEvent.click(screen.getByRole('button', { name: 'archived' }))

    await waitFor(() => expect(locationText()).toBe('/workspace/tasks?view=archived'))
    await waitFor(() =>
      expect(sent.some((r) => r.method === 'GET' && r.path === '/api/v1/workspace/runs?view=archived')).toBe(true),
    )
  })
})

describe('restoring the last-used filter', () => {
  it('a bare URL (no `projects` param) restores the stored selection without rewriting the URL', async () => {
    const sent = stubFetch({ uiState: { workspaceTasks: { projects: ['shop'] } } as unknown as WorkspaceUiState })
    renderAt('/workspace/tasks')
    await findInTable('Ship the storefront')
    expect(within(desktopTable()).queryByText('Fix the flaky retry test')).toBeNull()
    // A bare bookmark stays bare — restoring from storage alone must not rewrite the address bar.
    expect(locationText()).toBe('/workspace/tasks')
    await waitFor(() =>
      expect(
        sent.some((r) => r.method === 'GET' && r.path === '/api/v1/workspace/runs?projects=shop&view=active'),
      ).toBe(true),
    )
  })

  it('an explicit URL always wins over the stored selection', async () => {
    stubFetch({ uiState: { workspaceTasks: { projects: ['shop'] } } as unknown as WorkspaceUiState })
    renderAt('/workspace/tasks?projects=boot')
    await findInTable('Fix the flaky retry test')
    expect(within(desktopTable()).queryByText('Ship the storefront')).toBeNull()
  })

  it('an unknown id in the URL is dropped and the address bar is rewritten (replace)', async () => {
    const sent = stubFetch()
    renderAt('/workspace/tasks?projects=shop,ghost')
    await waitFor(() => expect(locationText()).toBe('/workspace/tasks?projects=shop&view=active'))
    await findInTable('Ship the storefront')
    expect(within(desktopTable()).queryByText('Fix the flaky retry test')).toBeNull()
    await waitFor(() =>
      expect(
        sent.some((r) => r.method === 'GET' && r.path === '/api/v1/workspace/runs?projects=shop&view=active'),
      ).toBe(true),
    )
  })
})

describe('the New task entry point', () => {
  it('links to /workspace/new regardless of the workspaceViews capability', async () => {
    stubFetch()
    renderAt('/workspace/tasks')
    await findInTable('Fix the flaky retry test')
    const link = screen.getByRole('link', { name: /New task/ })
    expect(link.getAttribute('href')).toBe('/workspace/new')
  })

  it('still renders when the cross-project board itself is off', async () => {
    stubFetch({ healthResponse: health({ capabilities: { ...CAPABILITIES_ON, workspaceViews: false } }) })
    renderAt('/workspace/tasks')
    await screen.findByText('The cross-project board is off')
    const link = screen.getByRole('link', { name: /New task/ })
    expect(link.getAttribute('href')).toBe('/workspace/new')
  })
})

/** "Which worker ran/is running this?" (2026-08-24) — the cross-project board's own copy of
 *  `global-tasks.test.tsx`'s "the Runs table — node column" describe block (same fixtures, same
 *  reasoning), against this file's own runs (`run-boot-1`, `run-shop-1`) and row markup
 *  (`[data-slot="workspace-task-row"]`). */
describe('the Node column', () => {
  const CLUSTER_NODE = (overrides: { nodeId: string; nodeName: string; lastSeenAt?: string }) => ({
    role: 'spoke' as const,
    labels: [] as string[],
    acceptsDispatch: true,
    protocol: { major: 1, minor: 0 },
    version: '0.10.0',
    ...overrides,
  })
  const HUB = CLUSTER_NODE({ nodeId: 'hub-1', nodeName: 'Hub' })
  const SPOKE = CLUSTER_NODE({ nodeId: 'spoke-2', nodeName: 'Laptop' })

  const overview = (selfNodeId: string | undefined, spoke = SPOKE) => ({
    self: selfNodeId ? CLUSTER_NODE({ nodeId: selfNodeId, nodeName: 'Hub' }) : undefined,
    nodes: [HUB, spoke],
    pairings: [],
    proposals: [],
    link: { state: 'disabled' },
  })

  const clusterHealth = (cluster: boolean) => health({ capabilities: { ...CAPABILITIES_ON, cluster } })

  const rowFor = (runId: string) =>
    document.querySelector<HTMLElement>(`[data-slot="workspace-task-row"][data-run-id="${runId}"]`)
  const nodeCellIn = (el: HTMLElement | null) => el?.querySelector<HTMLElement>('[data-slot="task-node"]')

  it('renders no Node column at all on a single-node cockpit — clustering off', async () => {
    stubFetch({ healthResponse: clusterHealth(false) })
    renderAt('/workspace/tasks')
    await findInTable('Fix the flaky retry test')

    expect(within(desktopTable()).queryByText('Node')).toBeNull()
    for (const row of desktopTable().querySelectorAll('[data-slot="workspace-task-row"]')) {
      expect(row.querySelector('[data-slot="task-node"]')).toBeNull()
    }
  })

  it('a run not reported in /cluster/active renders as "this node" — local by construction, never blank or "unknown"', async () => {
    stubFetch({
      healthResponse: clusterHealth(true),
      clusterOverview: overview('hub-1'),
      clusterActive: { runs: [] },
    })
    renderAt('/workspace/tasks')
    await findInTable('Fix the flaky retry test')

    // Waits for the RESOLVED kind, not merely "a cell exists" — the roster/active fetches settle
    // after the runs response does, so an early render could show a transient state.
    await waitFor(() => expect(nodeCellIn(rowFor('run-boot-1'))?.dataset.nodeKind).toBe('self'))
    expect(nodeCellIn(rowFor('run-boot-1'))!.textContent).toBe('this node')
  })

  it('a run reported in /cluster/active on another node renders that node — not "self"', async () => {
    stubFetch({
      healthResponse: clusterHealth(true),
      clusterOverview: overview('hub-1'),
      clusterActive: { runs: [{ runId: 'run-shop-1', nodeId: 'spoke-2', summary: 'ship the storefront', paths: [] }] },
    })
    renderAt('/workspace/tasks')
    await findInTable('Ship the storefront')

    await waitFor(() => expect(nodeCellIn(rowFor('run-shop-1'))?.dataset.nodeKind).toBe('known'))
    expect(nodeCellIn(rowFor('run-shop-1'))!.textContent).toBe('Laptop')
    // `run-boot-1`, absent from /cluster/active, still resolves local — the two rows must not agree.
    await waitFor(() => expect(nodeCellIn(rowFor('run-boot-1'))?.dataset.nodeKind).toBe('self'))
  })

  it('negative half: the SAME run/node pair renders "self" when self IS that node', async () => {
    stubFetch({
      healthResponse: clusterHealth(true),
      clusterOverview: overview('spoke-2'),
      clusterActive: { runs: [{ runId: 'run-shop-1', nodeId: 'spoke-2', summary: 'ship the storefront', paths: [] }] },
    })
    renderAt('/workspace/tasks')
    await findInTable('Ship the storefront')

    await waitFor(() => expect(nodeCellIn(rowFor('run-shop-1'))?.dataset.nodeKind).toBe('self'))
    expect(nodeCellIn(rowFor('run-shop-1'))!.textContent).toBe('this node')
  })

  it('a run on a node the roster no longer carries renders "unknown node (id)", never blank or self', async () => {
    stubFetch({
      healthResponse: clusterHealth(true),
      clusterOverview: overview('hub-1'),
      clusterActive: { runs: [{ runId: 'run-shop-1', nodeId: 'ghost-9', summary: 'ship the storefront', paths: [] }] },
    })
    renderAt('/workspace/tasks')
    await findInTable('Ship the storefront')

    await waitFor(() => expect(nodeCellIn(rowFor('run-shop-1'))?.dataset.nodeKind).toBe('unknown'))
    const cell = nodeCellIn(rowFor('run-shop-1'))!
    expect(cell.textContent).not.toBe('')
    expect(cell.textContent).toContain('ghost-9')
  })

  it("a stale node's run renders its own staleness, not the roster-wide asOf", async () => {
    // Computed from the REAL clock (`useNow` is not mockable here — the board calls it with no
    // injection point) rather than a fixed date: 15 minutes ago, whenever "now" happens to be.
    const staleSpoke = { ...SPOKE, lastSeenAt: new Date(Date.now() - 15 * 60_000).toISOString() }
    stubFetch({
      healthResponse: clusterHealth(true),
      // asOf is deliberately RECENT here — if the cell read it instead of the node's own
      // lastSeenAt, this would false-pass as fresh.
      clusterOverview: overview('hub-1', staleSpoke),
      clusterActive: {
        runs: [{ runId: 'run-shop-1', nodeId: 'spoke-2', summary: 'ship the storefront', paths: [] }],
        asOf: new Date().toISOString(),
      },
    })
    renderAt('/workspace/tasks')
    await findInTable('Ship the storefront')

    await waitFor(() => expect(rowFor('run-shop-1')?.querySelector('[data-slot="run-node-stale"]')).not.toBeNull())
    expect(rowFor('run-shop-1')!.querySelector('[data-slot="run-node-stale"]')!.textContent).toBe('· 15m')
  })
})
