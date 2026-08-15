import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type {
  HealthResponse,
  ProjectsResponse,
  ProviderStatusResponse,
  RepoResponse,
  Skill,
  TaskFanoutResponse,
  WorkflowsResponse,
} from '@open-mercato/cezar-api-client'
import { resetToasts, Toaster } from '@/components/ui/toaster'
import { AppRoutes } from '@/routes'

import { resetDraft } from './new-task-draft'

/**
 * The composer's project pill (multi-project spec, step 3.4).
 *
 * Rendered through the REAL `AppRoutes`, not the route component alone: the whole point of the
 * pill is that picking a project navigates, and everything downstream — the `/p/:projectId`
 * scope gate, the API prefix, the query keys, the per-project remount — hangs off that
 * navigation. Mounting `NewTaskRoute` directly would test a scope swap that never happens.
 *
 * The mocked server answers BOTH surfaces: the boot project's unscoped `/api/v1/*` (the step-3.1
 * invariant) and the second project's `/api/v1/p/other/*`. Each serves different skills, workflows
 * and config, so "re-resolves against the selected project" is provable from the UI, not just
 * from the request log.
 */

const BOOT = 'boot'
const OTHER = 'other'

beforeAll(() => {
  // cmdk scrolls the selected item into view; jsdom has no scrollIntoView.
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  resetDraft()
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
  resetToasts()
  resetDraft()
  vi.unstubAllGlobals()
})

// ---- fixtures --------------------------------------------------------------------------------

const HEALTH: HealthResponse = {
  version: '0.1.3',
  repoRoot: '/home/u/cezar',
  repo: { root: '/home/u/cezar', branch: 'main' },
  defaultRunner: 'claude',
  checks: [
    { name: 'claude', available: true, version: '2.0.44' },
    { name: 'git', available: true, version: '2.43.0' },
  ],
  forge: null,
  capabilities: { localHandoff: true, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: true, singleProject: false, knowledge: false, sources: false, notes: false, workspaceViews: false, notify: false, skills: true, automations: false },
  projects: [
    { id: BOOT, name: 'cezar' },
    { id: OTHER, name: 'shop-frontend' },
  ],
  bootProject: BOOT,
}

const REGISTRY: ProjectsResponse = {
  projects: [
    {
      id: BOOT,
      name: 'cezar',
      root: '/home/u/cezar',
      addedAt: '',
      lastOpenedAt: '2026-07-20T10:00:00.000Z',
      source: 'local',
      status: 'ok',
      branch: 'main',
    },
    {
      id: OTHER,
      name: 'shop-frontend',
      root: '/home/u/shop-frontend',
      addedAt: '',
      lastOpenedAt: '2026-07-19T10:00:00.000Z',
      source: 'local',
      status: 'ok',
      branch: 'develop',
    },
  ],
  bootProject: BOOT,
  projectsDir: '~/cezar/projects',
}

const PROVIDERS: ProviderStatusResponse = {
  providers: [
    { provider: 'claude', status: 'connected', enabled: true },
    { provider: 'codex', status: 'disconnected', enabled: true },
    { provider: 'opencode', status: 'not-installed', enabled: true },
  ],
}

/** Each project ships its OWN skills — the pill's whole promise. */
const BOOT_SKILLS: Skill[] = [
  { name: 'om-fix', description: 'Fix an issue end to end', body: '', path: '/p/om-fix.md', source: 'ai' },
]
const OTHER_SKILLS: Skill[] = [
  { name: 'ship-storefront', description: 'Deploy the storefront', body: '', path: '/p/ship.md', source: 'ai' },
]

const BOOT_WORKFLOWS: WorkflowsResponse = {
  workflows: [{ name: 'quick-task', description: 'Single step', source: 'built-in', steps: [] }],
  issues: [],
}
const OTHER_WORKFLOWS: WorkflowsResponse = {
  workflows: [{ name: 'release-train', description: 'Cut a release', source: 'file', steps: [] }],
  issues: [],
}

const REPO: RepoResponse = {
  info: { root: '/home/u/cezar', branch: 'main' },
  status: [],
  log: [],
  branches: ['main'],
  baseBranch: null,
}
const OTHER_REPO: RepoResponse = {
  info: { root: '/home/u/shop-frontend', branch: 'develop' },
  status: [],
  log: [],
  branches: ['develop'],
  baseBranch: null,
}

/** One grounded item, one ungrounded item, one unassigned item, and truncated — a single
 *  fixture that exercises every "renders as X" guard the spec's Verification table names. */
const FANOUT_RESULT: TaskFanoutResponse = {
  items: [
    {
      projectId: BOOT,
      projectName: 'cezar',
      todoId: 'todo-1',
      title: 'Fix the cezar flake',
      knowledgeRefs: [{ project: BOOT, slug: 'flake-notes', title: 'Flake notes' }],
    },
    {
      projectId: OTHER,
      projectName: 'shop-frontend',
      todoId: 'todo-2',
      title: 'Ship the storefront',
      knowledgeRefs: [],
    },
  ],
  unassigned: [{ title: 'unclear scope item', reason: 'could not determine a project' }],
  truncated: true,
}

// ---- harness ---------------------------------------------------------------------------------

type Recorded = { method: string; url: string; body?: unknown }
let requests: Recorded[]

/** The two-project workspace, served on both the unscoped and the `/api/v1/p/other` surface.
 *  `registry` narrows to a one-project workspace for the hidden-pill case. */
function serve({
  registry = REGISTRY,
  health = HEALTH,
  fanout = FANOUT_RESULT,
}: {
  registry?: ProjectsResponse
  health?: HealthResponse
  fanout?: TaskFanoutResponse
} = {}) {
  requests = []
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined
      requests.push({ method, url, body })

      // Workspace-level: never scoped (project-scope.ts `WORKSPACE_LEVEL`).
      if (url === '/api/v1/projects') return json(registry)
      if (url === '/api/v1/health') return json(health)
      if (url === '/api/v1/providers/status') return json(PROVIDERS)
      // Workspace-level too (D1/D6): unaffected by which project's scope is currently active,
      // never prefixed with `/p/<id>` — the fan-out spans the whole workspace by design.
      if (url === '/api/v1/workspace/task-fanout' && method === 'POST') return json(fanout)

      // Split the scope off the path so each route is written once.
      const scoped = url.startsWith(`/api/v1/p/${OTHER}/`)
      const path = scoped ? `/api/v1${url.slice(`/api/v1/p/${OTHER}`.length)}` : url
      const pick = <T,>(boot: T, other: T): T => (scoped ? other : boot)

      if (path === '/api/v1/health') return json(health)
      if (path === '/api/v1/skills') return json(pick(BOOT_SKILLS, OTHER_SKILLS))
      if (path === '/api/v1/workflows' && method === 'GET') return json(pick(BOOT_WORKFLOWS, OTHER_WORKFLOWS))
      if (path === '/api/v1/repo') return json(pick(REPO, OTHER_REPO))
      if (path === '/api/v1/ui-state' && method === 'GET') return json({})
      if (path === '/api/v1/ui-state' && method === 'PUT') return json(body ?? {})
      if (path === '/api/v1/config' && method === 'GET')
        return json({
          baseBranch: null,
          defaultRunner: 'claude',
          systemPrompt: null,
          // The Model pill's label is config-driven, so it proves the CONFIG re-resolved too.
          defaultModels: pick({ claude: 'sonnet' }, { claude: 'opus' }),
        })
      if (path === '/api/v1/runs' && method === 'POST') return json({ id: 'run-1' }, 201)
      return json({ error: `unmocked ${method} ${url}` }, 404)
    }),
  )
}

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{location.pathname}</output>
}

function renderAt(entry: string) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <AppRoutes />
        <LocationProbe />
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const textarea = () => screen.getByLabelText('Describe a task for the agent') as HTMLTextAreaElement
const projectPill = () => screen.getByRole('button', { name: 'Project' })
const sourcePill = () => screen.getByRole('button', { name: 'Choose a skill or workflow' })
const pathname = () => screen.getByTestId('location').textContent

/** The composer is only settled once the pickers resolved against the mounted scope. */
async function composerReady(sourceLabel: string) {
  await waitFor(() => {
    expect(sourcePill().textContent).toContain(sourceLabel)
    expect(textarea().disabled).toBe(false)
  })
}

/** Open the project pill and pick a project by id. */
async function switchProject(projectId: string) {
  fireEvent.click(projectPill())
  await screen.findByPlaceholderText('search projects…')
  fireEvent.click(document.querySelector(`[data-slot="project-option"][data-project-id="${projectId}"]`)!)
}

// Excludes the None item (2026-08-15) — it carries data-slot="source-option" too but no
// data-source-ref, and this helper is about the project's own skill/workflow catalog.
const sourceRefs = () =>
  [...document.querySelectorAll('[data-slot="source-option"]:not([data-source-kind="none"])')].map(
    (o) => o.getAttribute('data-source-ref'),
  )

// ---- the pill itself -------------------------------------------------------------------------

describe('the new-task project pill', () => {
  it('is preselected from the URL scope and lists the registry with branches', async () => {
    serve()
    renderAt(`/p/${OTHER}/new`)
    await composerReady('None')

    expect(projectPill().textContent).toContain('shop-frontend')
    fireEvent.click(projectPill())
    await screen.findByPlaceholderText('search projects…')
    const options = [...document.querySelectorAll(String.raw`[data-slot="project-option"]`)]
    // All / Auto (knowledge-grounded-task-fanout.md D1) leads the list, ahead of the registry.
    expect(options.map((o) => o.getAttribute('data-project-id'))).toEqual(['all', BOOT, OTHER])
    expect(options[2]!.textContent).toContain('develop')
  })

  it('stays hidden when single-project mode pins the registry to the boot project', async () => {
    serve({
      // Health advertises the mode, but the composer deliberately has no capability gate: the
      // ordinary pinned registry response is enough to collapse a choice with one option.
      health: {
        ...HEALTH,
        capabilities: { ...HEALTH.capabilities, singleProject: true },
      },
      registry: { ...REGISTRY, projects: [REGISTRY.projects[0]!] },
    })
    renderAt(`/p/${BOOT}/new`)
    await composerReady('None')
    expect(screen.queryByRole('button', { name: 'Project' })).toBeNull()
    expect(document.querySelector('[data-slot="source-pill"]')).not.toBeNull()
  })
})

// ---- scope swap ------------------------------------------------------------------------------

describe('switching project', () => {
  it('re-resolves the skills, workflows and config pickers against the new project', async () => {
    serve()
    renderAt(`/p/${BOOT}/new`)
    await composerReady('None')

    // The boot project reads the unscoped legacy surface (step 3.1) …
    fireEvent.click(sourcePill())
    await screen.findByPlaceholderText('search skills & workflows…')
    expect(sourceRefs()).toEqual(['om-fix', 'quick-task'])
    fireEvent.keyDown(document.body, { key: 'Escape' })

    await switchProject(OTHER)
    await waitFor(() => expect(pathname()).toBe(`/p/${OTHER}/new`))
    await composerReady('None')

    // … and the second project reads its own, through the `/api/v1/p/<id>` prefix.
    for (const path of ['/skills', '/workflows', '/config', '/repo']) {
      expect(requests.some((r) => r.url === `/api/v1/p/${OTHER}${path}`)).toBe(true)
    }
    fireEvent.click(sourcePill())
    await screen.findByPlaceholderText('search skills & workflows…')
    expect(sourceRefs()).toEqual(['ship-storefront', 'release-train'])

    // Config too: the Model pill's preset comes from the project's `defaultModels`.
    await waitFor(() =>
      expect(document.querySelector('[data-slot="model-pill"]')!.textContent).toContain('opus'),
    )
  })

  it('keeps drafts isolated per project — one composer never leaks into the other', async () => {
    serve()
    renderAt(`/p/${BOOT}/new`)
    await composerReady('None')
    fireEvent.change(textarea(), { target: { value: 'fix the cezar flake' } })

    await switchProject(OTHER)
    await composerReady('None')
    // The arriving project starts from ITS draft, which is empty — not the departing text.
    expect(textarea().value).toBe('')
    fireEvent.change(textarea(), { target: { value: 'ship the storefront' } })

    // The boot project keeps the bare legacy key (unscoped invariant); the second project
    // gets the spec's suffixed one.
    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem('cez-new-task-draft')!).text).toBe('fix the cezar flake')
      expect(JSON.parse(localStorage.getItem(`cez-new-task-draft:${OTHER}`)!).text).toBe(
        'ship the storefront',
      )
    })

    // Switching back restores what was typed there, untouched by the detour.
    await switchProject(BOOT)
    await waitFor(() => expect(pathname()).toBe(`/p/${BOOT}/new`))
    await composerReady('None')
    expect(textarea().value).toBe('fix the cezar flake')
  })

  it('submits to the SELECTED project and clears only that project’s draft text', async () => {
    serve()
    renderAt(`/p/${BOOT}/new`)
    await composerReady('None')
    fireEvent.change(textarea(), { target: { value: 'left behind in cezar' } })

    await switchProject(OTHER)
    await composerReady('None')
    fireEvent.change(textarea(), { target: { value: 'Ship the storefront' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }))

    await waitFor(() =>
      expect(requests.some((r) => r.method === 'POST' && r.url === `/api/v1/p/${OTHER}/runs`)).toBe(true),
    )
    // The unscoped legacy endpoint must never see it — that would run the task in the wrong repo.
    expect(requests.some((r) => r.method === 'POST' && r.url === '/api/v1/runs')).toBe(false)
    // A named-project pick keeps today's exact behavior — the fan-out route is All / Auto only.
    expect(requests.some((r) => r.url === '/api/v1/workspace/task-fanout')).toBe(false)
    const posted = requests.find((r) => r.method === 'POST' && r.url === `/api/v1/p/${OTHER}/runs`)
    expect((posted?.body as { task?: string }).task).toBe('Ship the storefront')

    // Started runs land on the selected project's thread URL, and the other draft is intact.
    await waitFor(() => expect(pathname()).toBe(`/p/${OTHER}/tasks/run-1`))
    expect(JSON.parse(localStorage.getItem('cez-new-task-draft')!).text).toBe('left behind in cezar')
    expect(JSON.parse(localStorage.getItem(`cez-new-task-draft:${OTHER}`)!).text).toBe('')
  })
})

// ---- All / Auto (knowledge-grounded-task-fanout.md, Phase 4) ---------------------------------

describe('All / Auto', () => {
  it('is the default pill selection when arriving via ?scope=auto', async () => {
    serve()
    renderAt(`/p/${BOOT}/new?scope=auto`)
    await composerReady('None')
    expect(projectPill().textContent).toContain('All / Auto')
  })

  it('leads the pill list, and picking it is local — no navigation, unlike picking a project', async () => {
    serve()
    renderAt(`/p/${BOOT}/new`)
    await composerReady('None')
    // A bare `/p/<id>/new` (no `?scope=auto`) still defaults to the named project, unchanged.
    expect(projectPill().textContent).toContain('cezar')

    fireEvent.click(projectPill())
    await screen.findByPlaceholderText('search projects…')
    fireEvent.click(document.querySelector('[data-slot="project-option"][data-project-id="all"]')!)
    expect(projectPill().textContent).toContain('All / Auto')
    // Composer-local state, not a route (D1): picking it never navigates.
    expect(pathname()).toBe(`/p/${BOOT}/new`)

    // Picking a named project back out of it behaves exactly as it always did.
    await switchProject(OTHER)
    await waitFor(() => expect(pathname()).toBe(`/p/${OTHER}/new`))
    expect(projectPill().textContent).toContain('shop-frontend')
  })

  it('fans a submit out across the workspace instead of starting a run', async () => {
    serve()
    renderAt(`/p/${BOOT}/new?scope=auto`)
    await composerReady('None')
    expect(projectPill().textContent).toContain('All / Auto')

    fireEvent.change(textarea(), { target: { value: 'fix the flake and ship the storefront' } })
    fireEvent.click(screen.getByRole('button', { name: 'File tasks' }))

    await waitFor(() =>
      expect(
        requests.some((r) => r.method === 'POST' && r.url === '/api/v1/workspace/task-fanout'),
      ).toBe(true),
    )
    // D5/the spec's own guard: nothing starts a run on submit — no run record may exist after.
    expect(requests.some((r) => r.method === 'POST' && /\/runs$/.test(r.url))).toBe(false)
    const posted = requests.find(
      (r) => r.method === 'POST' && r.url === '/api/v1/workspace/task-fanout',
    )
    expect((posted?.body as { input?: string }).input).toBe('fix the flake and ship the storefront')

    // A dialog, not a navigation — the composer stays put.
    expect(pathname()).toBe(`/p/${BOOT}/new`)
    expect(await screen.findByText('Fix the cezar flake')).toBeTruthy()
    expect(screen.getByText('Ship the storefront')).toBeTruthy()
    // Grounded item shows its citation …
    expect(screen.getByText('Flake notes')).toBeTruthy()
    // … an empty knowledgeRefs[] renders as "not grounded", never as nothing (Verification table).
    expect(screen.getByText('not grounded — no matching knowledge found')).toBeTruthy()
    // Unassigned work is surfaced, not silently dropped.
    expect(screen.getByText('unclear scope item', { exact: false })).toBeTruthy()
    // A truncated batch says so out loud rather than truncating silently.
    expect(screen.getByText(/more work than one pass could file/)).toBeTruthy()
  })
})
