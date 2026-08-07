import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import type { ProjectListEntry, ProjectsResponse, WorkspaceConfigResponse } from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { AppRoutes } from '@/routes'

/**
 * Global settings → Projects (multi-project spec, step 4.4; mockup `settings-global.html`).
 *
 * The two contracts the spec names for this pane, plus the one the CODE promises:
 *
 * - the checkout-root field renders the server's own 400 reason INLINE (the step-2.7 writability
 *   probe is the only thing that can decide this, so a client-side paraphrase would be a
 *   guess presented as a fact);
 * - a project with running tasks is refused with a 409 whose message reaches the user;
 * - "Remove" deregisters and says so — the confirm copy must never let a reader believe the
 *   folder is about to be deleted. The server-side half of that guarantee (no file on disk is
 *   touched) is pinned in src/server/projects-api.test.ts.
 */

let requests: Array<{ method: string; url: string; body?: unknown }> = []

const PROJECTS: ProjectListEntry[] = [
  {
    id: 'cezar',
    name: 'cezar',
    root: '/home/piotr/Projects/cezar',
    addedAt: '2026-07-20T09:00:00.000Z',
    lastOpenedAt: '2026-07-20T09:00:00.000Z',
    source: 'local',
    status: 'ok',
    branch: 'main',
  },
  {
    id: 'shop-backend',
    name: 'shop-backend',
    root: '/home/piotr/cezar/projects/shop-backend',
    addedAt: '2026-07-20T09:00:00.000Z',
    lastOpenedAt: '2026-07-20T09:00:00.000Z',
    source: 'checkout',
    status: 'ok',
  },
  {
    id: 'old-spike',
    name: 'old-spike',
    root: '/home/piotr/tmp/old-spike',
    addedAt: '2026-06-02T09:00:00.000Z',
    lastOpenedAt: '2026-06-02T09:00:00.000Z',
    source: 'local',
    status: 'missing',
  },
]

type Answers = {
  /** What `PUT /api/v1/workspace/config` answers — a 400 stands in for the writability probe. */
  putConfig?: { status: number; payload: unknown }
  /** What `DELETE /api/v1/projects/:id` answers. */
  del?: { status: number; payload: unknown }
  /** Overrides `GET /api/v1/projects`' entries — default `PROJECTS`, carries no `teamId`. */
  projects?: ProjectListEntry[]
}

function serve(answers: Answers = {}) {
  requests = []
  const registry: ProjectsResponse = {
    // Copies, not the shared source objects: the PATCH handler mutates entries.
    projects: (answers.projects ?? PROJECTS).map((p) => ({ ...p })),
    bootProject: 'cezar',
    projectsDir: '~/cezar/projects',
  }
  const config: WorkspaceConfigResponse = {
    agentDefaults: {},
    browseRoot: '~/',
    projectsDir: '~/cezar/projects',
    skillsAutoUpdate: null,
    effectiveSkillsAutoUpdate: true,
    composerDefaults: {
      autonomous: null,
      worktree: null,
      inheritedAutonomous: 'source-dependent',
      inheritedWorktree: false,
    },
    resources: {
      maxParallel: 2,
      maxMonitoringSessions: 2,
      monitoringWakeIntervalMinutes: null,
      autoResumeOnUsageLimit: true,
      memoryLimitMb: null,
      worktreeRetentionDefault: 10,
    },
  }
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined
      requests.push({ method, url, body })
      if (url === '/api/v1/projects' && method === 'GET') return json(registry)
      if (url === '/api/v1/workspace/config' && method === 'GET') return json(config)
      if (url === '/api/v1/workspace/config' && method === 'PUT') {
        if (answers.putConfig) return json(answers.putConfig.payload, answers.putConfig.status)
        config.browseRoot = String(body?.browseRoot ?? config.browseRoot)
        config.projectsDir = String(body?.projectsDir ?? config.projectsDir)
        return json(config)
      }
      if (url.startsWith('/api/v1/projects/') && method === 'PATCH') {
        const id = url.split('/').pop() ?? ''
        const entry = registry.projects.find((p) => p.id === id)
        if (!entry) return json({ error: `unknown project: ${id}` }, 404)
        const mp = body?.maxParallel
        if (mp === null) delete entry.maxParallel
        else entry.maxParallel = mp as number
        return json({ project: entry })
      }
      if (url.startsWith('/api/v1/projects/') && method === 'DELETE') {
        const answer = answers.del ?? { status: 200, payload: { removed: true, id: url.split('/').pop() } }
        if (answer.status === 200) {
          registry.projects = registry.projects.filter((p) => !url.endsWith(`/${p.id}`))
        }
        return json(answer.payload, answer.status)
      }
      return new Promise<never>(() => {})
    }),
  )
}

/**
 * Seeds the step-3.2 route gates so the (unscoped) global settings shell renders immediately.
 * The default `staleTime` (query-client.ts) is 5 minutes, so this seed — not `serve()`'s mock
 * fetch — is what the FIRST render shows; a test that wants custom entries (e.g. with a `teamId`)
 * must pass the SAME array here that it passes to `serve({ projects })`, or the initial paint
 * shows the unseeded default instead.
 */
function gateSeededClient(projects: ProjectListEntry[] = PROJECTS) {
  const client = createQueryClient()
  client.setQueryData(queryKeys.health, { bootProject: 'cezar' })
  client.setQueryData(workspaceQueryKeys.projects, {
    projects,
    bootProject: 'cezar',
    projectsDir: '~/cezar/projects',
  })
  return client
}

function renderProjects(projects: ProjectListEntry[] = PROJECTS) {
  const client = gateSeededClient(projects)
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/settings/global/projects']}>
        <AppRoutes />
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return client
}

const rows = () => document.querySelectorAll('[data-slot="project-row"]')
const row = (id: string) => document.querySelector<HTMLElement>(`[data-slot="project-row"][data-project="${id}"]`)
const removeButton = (id: string) => row(id)?.querySelector<HTMLButtonElement>('[data-action="project-remove"]')
const rootInput = () => document.querySelector<HTMLInputElement>('[data-slot="projects-checkout-root"]')
const saveRoot = () => document.querySelector<HTMLButtonElement>('[data-action="projects-save-checkout-root"]')
const inlineError = () => document.querySelector<HTMLElement>('[data-slot="projects-checkout-root-error"]')
const browseInput = () => document.querySelector<HTMLInputElement>('[data-slot="projects-browse-root"]')
const saveBrowse = () => document.querySelector<HTMLButtonElement>('[data-action="projects-save-browse-root"]')
const browseError = () => document.querySelector<HTMLElement>('[data-slot="projects-browse-root-error"]')
const confirmButton = () => document.querySelector<HTMLButtonElement>('[data-action="projects-confirm-remove"]')
const deletes = () => requests.filter((r) => r.method === 'DELETE')
const patches = () => requests.filter((r) => r.method === 'PATCH')
const maxParallelSelect = (id: string) =>
  row(id)?.querySelector<HTMLSelectElement>('[data-slot="project-max-parallel"]')
const teamFilterSelect = () => document.querySelector<HTMLSelectElement>('[data-slot="project-team-filter"]')
const teamBadge = (id: string) => row(id)?.querySelector<HTMLElement>('[data-slot="project-team"]')

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

describe('Global settings → Projects', () => {
  it('lists every registered project with its status, source and path', async () => {
    serve()
    renderProjects()
    await waitFor(() => expect(rows()).toHaveLength(3))
    expect(row('shop-backend')?.textContent).toContain('/home/piotr/cezar/projects/shop-backend')
    expect(row('shop-backend')?.textContent).toContain('checkout')
    // The `missing` row (step 3.3 greys it out in the sidebar) is actionable HERE.
    expect(row('old-spike')?.textContent).toContain('folder not found')
    expect(removeButton('old-spike')?.disabled).toBe(false)
  })

  it('renders the 400 reason from the writability probe INLINE, verbatim', async () => {
    // The exact shape `PUT /api/v1/workspace/config` answers with when the probe fails (step 2.7).
    const reason = 'not writable: EACCES: permission denied, mkdir \'/opt/checkouts\''
    serve({ putConfig: { status: 400, payload: { error: reason } } })
    renderProjects()
    await waitFor(() => expect(rootInput()).not.toBeNull())
    fireEvent.change(rootInput()!, { target: { value: '/opt/checkouts' } })
    fireEvent.click(saveRoot()!)

    await waitFor(() => expect(inlineError()).not.toBeNull())
    // Verbatim — no paraphrase, no generic "invalid path": the server's sentence is the only
    // one that tells the user what to fix.
    expect(inlineError()!.textContent).toContain(reason)
    expect(inlineError()!.textContent).toContain('setting unchanged')
    // Inline, NOT a toast that scrolls away from the field it is about.
    expect(screen.queryByRole('status')?.textContent ?? '').not.toContain('not writable')
    // The field keeps what the user typed, and the input is flagged for assistive tech.
    expect(rootInput()!.value).toBe('/opt/checkouts')
    expect(rootInput()!.getAttribute('aria-invalid')).toBe('true')
    // A rejected save changed no authoritative data, so it must not refresh the registry.
    expect(requests.filter((r) => r.method === 'GET' && r.url === '/api/v1/projects')).toHaveLength(0)
  })

  it('clears the inline error as soon as the value changes again', async () => {
    serve({ putConfig: { status: 400, payload: { error: 'not writable: /opt/checkouts' } } })
    renderProjects()
    await waitFor(() => expect(rootInput()).not.toBeNull())
    fireEvent.change(rootInput()!, { target: { value: '/opt/checkouts' } })
    fireEvent.click(saveRoot()!)
    await waitFor(() => expect(inlineError()).not.toBeNull())
    // The message names a path that is no longer in the field — leaving it up would be a lie.
    fireEvent.change(rootInput()!, { target: { value: '~/code' } })
    await waitFor(() => expect(inlineError()).toBeNull())
  })

  it('shows a missing browse-folder warning inline and keeps the typed path', async () => {
    const reason = 'browse folder does not exist: ~/missing'
    serve({ putConfig: { status: 400, payload: { error: reason } } })
    renderProjects()
    await waitFor(() => expect(browseInput()).not.toBeNull())
    fireEvent.change(browseInput()!, { target: { value: '~/missing' } })
    fireEvent.click(saveBrowse()!)

    await waitFor(() => expect(browseError()?.textContent).toContain(reason))
    expect(browseInput()!.value).toBe('~/missing')
    expect(browseInput()!.getAttribute('aria-invalid')).toBe('true')
  })

  it('saves a valid checkout root through PUT /api/v1/workspace/config', async () => {
    serve()
    renderProjects()
    await waitFor(() => expect(rootInput()).not.toBeNull())
    expect(saveRoot()!.disabled).toBe(true) // unchanged
    fireEvent.change(rootInput()!, { target: { value: '~/code' } })
    fireEvent.click(saveRoot()!)
    await waitFor(() =>
      expect(requests.filter((r) => r.method === 'PUT' && r.url === '/api/v1/workspace/config')).toEqual([
        { method: 'PUT', url: '/api/v1/workspace/config', body: { projectsDir: '~/code' } },
      ]),
    )
    // The clone dialog reads projectsDir from this response, not workspace/config. Refreshing
    // it here keeps the next Add project opening coherent without a whole-app reload (#567).
    await waitFor(() =>
      expect(requests.filter((r) => r.method === 'GET' && r.url === '/api/v1/projects')).toHaveLength(1),
    )
    expect(inlineError()).toBeNull()
  })

  it('saves the browse folder independently without refreshing the clone destination', async () => {
    serve()
    const client = renderProjects()
    client.setQueryData(workspaceQueryKeys.fsBrowse(null), {
      path: '/home/piotr',
      parent: null,
      dirs: [],
    })
    await waitFor(() => expect(browseInput()).not.toBeNull())
    expect(browseInput()!.value).toBe('~/')
    fireEvent.change(browseInput()!, { target: { value: '~/source' } })
    fireEvent.click(saveBrowse()!)
    await waitFor(() =>
      expect(requests.filter((r) => r.method === 'PUT' && r.url === '/api/v1/workspace/config')).toEqual([
        { method: 'PUT', url: '/api/v1/workspace/config', body: { browseRoot: '~/source' } },
      ]),
    )
    expect(rootInput()!.value).toBe('~/cezar/projects')
    expect(requests.filter((r) => r.method === 'GET' && r.url === '/api/v1/projects')).toHaveLength(0)
    await waitFor(() => expect(client.getQueryState(workspaceQueryKeys.fsBrowse(null))?.isInvalidated).toBe(true))
  })

  it('removes a project only after a confirm that promises no files are deleted', async () => {
    serve()
    renderProjects()
    await waitFor(() => expect(rows()).toHaveLength(3))
    fireEvent.click(removeButton('shop-backend')!)
    await waitFor(() => expect(confirmButton()).not.toBeNull())

    // The copy is the guarantee: a user must not be able to read this as "delete my repo".
    const dialog = document.querySelector('[role="alertdialog"]')!
    expect(dialog.textContent).toContain('only unregisters')
    expect(dialog.textContent).toContain('nothing on disk is deleted')
    expect(confirmButton()!.textContent).toContain('Remove from list')
    expect(deletes()).toEqual([])

    fireEvent.click(confirmButton()!)
    await waitFor(() => expect(deletes().map((r) => r.url)).toEqual(['/api/v1/projects/shop-backend']))
    await waitFor(() => expect(row('shop-backend')).toBeNull())
  })

  it('dismissing the confirm never calls the route', async () => {
    serve()
    renderProjects()
    await waitFor(() => expect(rows()).toHaveLength(3))
    fireEvent.click(removeButton('old-spike')!)
    await waitFor(() => expect(confirmButton()).not.toBeNull())
    fireEvent.click(screen.getByText('Keep it'))
    await waitFor(() => expect(confirmButton()).toBeNull())
    expect(deletes()).toEqual([])
  })

  it('surfaces the running-tasks 409 and keeps the project', async () => {
    const error = 'shop-backend has 2 running tasks — cancel or finish them before removing the project'
    serve({ del: { status: 409, payload: { error, runningTasks: 2 } } })
    renderProjects()
    await waitFor(() => expect(rows()).toHaveLength(3))
    fireEvent.click(removeButton('shop-backend')!)
    await waitFor(() => expect(confirmButton()).not.toBeNull())
    fireEvent.click(confirmButton()!)

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain(error))
    // Refused means untouched — the row is still there.
    expect(row('shop-backend')).not.toBeNull()
  })

  it('pins a per-project max-parallel and can clear it back to inherit (2026-07-22)', async () => {
    serve()
    renderProjects()
    await waitFor(() => expect(rows()).toHaveLength(3))
    const select = maxParallelSelect('shop-backend')
    expect(select).not.toBeNull()
    // Unset projects show the inherit option carrying the live workspace cap (2).
    expect(select!.value).toBe('')
    expect(select!.textContent).toContain('Inherit workspace (2)')

    // Choosing a number PATCHes the per-project ceiling…
    fireEvent.change(select!, { target: { value: '1' } })
    await waitFor(() =>
      expect(patches()).toEqual([
        { method: 'PATCH', url: '/api/v1/projects/shop-backend', body: { maxParallel: 1 } },
      ]),
    )
    // …and the row reflects the persisted value after the query refreshes.
    await waitFor(() => expect(maxParallelSelect('shop-backend')!.value).toBe('1'))

    // Selecting "Inherit" clears the override with an explicit null.
    fireEvent.change(maxParallelSelect('shop-backend')!, { target: { value: '' } })
    await waitFor(() =>
      expect(patches().at(-1)).toEqual({
        method: 'PATCH',
        url: '/api/v1/projects/shop-backend',
        body: { maxParallel: null },
      }),
    )
    await waitFor(() => expect(maxParallelSelect('shop-backend')!.value).toBe(''))
  })

  it('disables Remove for the project cezar is serving', async () => {
    serve()
    renderProjects()
    await waitFor(() => expect(rows()).toHaveLength(3))
    // The server refuses it too (it re-registers at every start); disabling explains it first.
    expect(removeButton('cezar')?.disabled).toBe(true)
    expect(removeButton('cezar')?.title).toContain('re-registers')
  })

  describe('team filtering (D5 — grouping/filtering metadata, never a scope)', () => {
    it('shows no filter and no team badges when CEZ_AUTH is unset — the board is unchanged', async () => {
      // The default PROJECTS fixture carries no `teamId` at all, which is exactly the shape
      // every project has with `CEZ_AUTH` unset: no `project_teams` row was ever written.
      serve()
      renderProjects()
      await waitFor(() => expect(rows()).toHaveLength(3))
      expect(teamFilterSelect()).toBeNull()
      expect(document.querySelectorAll('[data-slot="project-team"]')).toHaveLength(0)
      // Same three rows, same text, as the unfiltered baseline test above — the board itself is
      // untouched by this feature existing in the code.
      expect(row('shop-backend')?.textContent).toContain('/home/piotr/cezar/projects/shop-backend')
      expect(row('old-spike')?.textContent).toContain('folder not found')
    })

    it('filters the board by team once projects carry one, and clears back to "All teams"', async () => {
      const withTeams = [
        { ...PROJECTS[0], teamId: 'team-eng', teamName: 'Engineering' },
        { ...PROJECTS[1], teamId: 'team-mkt', teamName: 'Marketing' },
        { ...PROJECTS[2] }, // no team assigned — visible under "All teams", hidden by either filter
      ] as ProjectListEntry[]
      serve({ projects: withTeams })
      renderProjects(withTeams)
      await waitFor(() => expect(rows()).toHaveLength(3))

      const select = teamFilterSelect()
      expect(select).not.toBeNull()
      expect(Array.from(select!.options).map((o) => o.textContent)).toEqual([
        'All teams',
        'Engineering',
        'Marketing',
      ])
      expect(teamBadge('cezar')?.textContent).toContain('Engineering')
      expect(teamBadge('shop-backend')?.textContent).toContain('Marketing')
      expect(teamBadge('old-spike')).toBeNull()

      fireEvent.change(select!, { target: { value: 'team-eng' } })
      await waitFor(() => expect(rows()).toHaveLength(1))
      expect(row('cezar')).not.toBeNull()
      expect(row('shop-backend')).toBeNull()
      expect(row('old-spike')).toBeNull()

      fireEvent.change(select!, { target: { value: '' } })
      await waitFor(() => expect(rows()).toHaveLength(3))
    })

    it('clears a stale team selection instead of filtering everything away', async () => {
      // 'cezar' is the boot project — Remove stays disabled for it — so only 'shop-backend'
      // carries the team being removed here, and the filter has no OTHER team to fall back to.
      const withTeams = [
        { ...PROJECTS[0] }, // cezar — no team
        { ...PROJECTS[1], teamId: 'team-eng', teamName: 'Engineering' }, // shop-backend
      ] as ProjectListEntry[]
      serve({ projects: withTeams })
      renderProjects(withTeams)
      await waitFor(() => expect(rows()).toHaveLength(2))

      fireEvent.change(teamFilterSelect()!, { target: { value: 'team-eng' } })
      await waitFor(() => expect(rows()).toHaveLength(1))
      expect(row('shop-backend')).not.toBeNull()

      fireEvent.click(removeButton('shop-backend')!)
      await waitFor(() => expect(confirmButton()).not.toBeNull())
      fireEvent.click(confirmButton()!)

      // The removed project was the only one on 'team-eng': the filter option (and the select
      // itself) disappears, and the stale selection falls back to "All teams" rather than
      // rendering a "no projects" message for a team the reader can no longer even pick.
      await waitFor(() => expect(teamFilterSelect()).toBeNull())
      expect(rows()).toHaveLength(1)
      expect(row('cezar')).not.toBeNull()
      expect(document.querySelector('[data-slot="projects-empty"]')).toBeNull()
    })
  })
})
