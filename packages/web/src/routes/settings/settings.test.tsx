import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import { AppearanceProvider } from '@/components/appearance-provider'
import { ThemeProvider } from '@/components/theme-provider'
import { AppRoutes } from '@/routes'
import { SETTINGS_SECTIONS, visibleSettingsSections } from './registry'

/**
 * The Settings shell + Appearance section (R6 Step 1.3): registry rendering, hidden gating, the
 * appearance round-trip against a stubbed ui-state API, and boot application of persisted values.
 * The URL map itself (including hidden sections 404ing, and both legacy redirect families) lives
 * in routes.test.tsx.
 *
 * **Rewritten for `.ai/specs/2026-08-21-one-settings-area.md`.** The previous version of this file
 * said, in its own header, "the scope split is what most of this file now pins" — and it pinned it
 * the RIGHT way, by asserting which STORE a section writes rather than which component rendered.
 * That property is kept; only the split is gone. There is one nav listing every section now, and
 * what a `per-project` section writes is decided by `?project=`, not by which of two areas the URL
 * was in.
 *
 * So the central assertion is still WHICH STORE: Appearance and Notifications must reach
 * `/api/v1/workspace/ui-state`, Agents with *All projects* must reach `/api/v1/workspace/config`,
 * and Agents with `?project=chat` must reach `/api/v1/p/chat/config`. The stub below answers all
 * of them and records every request, so a section writing the wrong one shows up as a wrong URL
 * rather than as a passing test.
 */

let requests: Array<{ method: string; url: string; body?: unknown }> = []

/** Every store a settings section can reach, so a section writing to the WRONG one fails loudly
 *  on the recorded URL instead of hanging on an unstubbed fetch. */
function serve(uiState: Record<string, unknown> = {}) {
  requests = []
  const json = (payload: unknown) =>
    new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  const projectUiState: Record<string, unknown> = {}
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined
      requests.push({ method, url, body })
      if (url === '/api/v1/workspace/ui-state' && method === 'GET') return json(uiState)
      if (url === '/api/v1/workspace/ui-state' && method === 'PUT')
        return json({ ...uiState, ...(body as Record<string, unknown>) })
      if (url === '/api/v1/ui-state' && method === 'GET') return json(projectUiState)
      if (url === '/api/v1/ui-state' && method === 'PUT')
        return json({ ...projectUiState, ...(body as Record<string, unknown>) })
      if (url === '/api/v1/workspace/config' && method === 'GET') return json(WORKSPACE_CONFIG)
      if (url === '/api/v1/workspace/config' && method === 'PUT')
        return json({
          ...WORKSPACE_CONFIG,
          projectDefaults: {
            ...WORKSPACE_CONFIG.projectDefaults,
            ...((body as { projectDefaults?: Record<string, unknown> })?.projectDefaults ?? {}),
          },
        })
      // Both spellings of the per-repo config: unscoped (the boot project) and explicitly scoped
      // (what `?project=chat` addresses). Serving both is the point — a section reaching for the
      // wrong one must produce a wrong URL, not a pending promise.
      if (url === '/api/v1/config' || /^\/api\/v1\/p\/[^/]+\/config$/.test(url)) return json(AGENTS_CONFIG)
      if (url === '/api/v1/providers/status')
        return json({
          providers: [
            { provider: 'claude', status: 'connected', enabled: true },
            { provider: 'codex', status: 'connected', enabled: true },
            { provider: 'opencode', status: 'connected', enabled: true },
          ],
        })
      if (url === '/api/v1/models?runner=codex') return json({ runner: 'codex', models: [], source: 'unavailable', stale: false })
      return new Promise<never>(() => {})
    }),
  )
}

/** Enough of `GET /api/v1/config` for the Agents section to render its project form. */
const AGENTS_CONFIG = {
  baseBranch: null,
  defaultRunner: 'claude',
  systemPrompt: null,
  defaultModels: {},
  maxParallel: 2,
  memoryLimitMb: null,
  worktreeRetention: 10,
  liveTitleUpdates: null,
  reviewGate: null,
  inherited: { systemPrompt: null, liveTitleUpdates: null, reviewGate: null, stepBudget: null },
  overridden: [],
}

/** Enough of `GET /api/v1/workspace/config` for the Agents section's MACHINE-tier form. */
const WORKSPACE_CONFIG = {
  browseRoot: '~/',
  projectsDir: '~/cezar/projects',
  composerDefaults: {
    autonomous: null,
    worktree: null,
    inheritedAutonomous: 'source-dependent',
    inheritedWorktree: true,
  },
  resources: {
    maxParallel: 2,
    maxMonitoringSessions: 2,
    monitoringWakeIntervalMinutes: null,
    autoResumeOnUsageLimit: true,
    fallbackAcrossAccountsWhenLimited: false,
    memoryLimitMb: null,
    worktreeRetentionDefault: 10,
  },
  agentDefaults: {},
  projectDefaults: { systemPrompt: null, liveTitleUpdates: null, reviewGate: null, stepBudget: null },
}

const PROJECTS = [
  { id: 'boot', name: 'cezar', root: '/home/u/cezar', status: 'ok', addedAt: '2026-01-01T00:00:00Z', lastOpenedAt: '2026-01-01T00:00:00Z', source: 'local' },
  { id: 'chat', name: 'chat', root: '/home/u/chat', status: 'ok', addedAt: '2026-01-01T00:00:00Z', lastOpenedAt: '2026-01-01T00:00:00Z', source: 'local' },
]

/** Seeds the step-3.2 route gates — boot id (legacy redirect) + registry (known-check) — so a
 *  flat entry URL resolves immediately. */
function gateSeededClient(singleProject = false) {
  const client = createQueryClient()
  client.setQueryData(queryKeys.health, {
    bootProject: 'boot',
    capabilities: { cluster: false, localHandoff: true, followups: true, singleProject },
  })
  client.setQueryData(workspaceQueryKeys.projects, {
    projects: PROJECTS,
    bootProject: 'boot',
    projectsDir: '~/cezar/projects',
  })
  return client
}

function renderAt(entry: string, { singleProject = false }: { singleProject?: boolean } = {}) {
  render(
    <QueryClientProvider client={gateSeededClient(singleProject)}>
      <ThemeProvider>
        <AppearanceProvider>
          <MemoryRouter initialEntries={[entry]}>
            <AppRoutes />
          </MemoryRouter>
        </AppearanceProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => serve())

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
  delete document.documentElement.dataset.accent
  delete document.documentElement.dataset.density
  delete document.documentElement.dataset.width
  document.documentElement.classList.remove('light')
})

/**
 * One list, one order, one nav. The old file kept two — PROJECT_SECTIONS and GLOBAL_SECTIONS —
 * and asserted that no id appeared in both. That invariant is meaningless now and its replacement
 * is stronger: every visible section is in the ONE list, which is the report this change answers.
 */
const ALL_SECTIONS = [
  'project',
  'agents',
  'providers',
  'agent-config',
  'worktrees',
  'bookmarklets',
  'prompt-templates',
  'appearance',
  'notifications',
  'resources',
  // Agent accounts (spec 2026-07-29-agent-profiles) sit beside Projects: both describe the
  // machine and the person at it, not any one repo.
  'accounts',
  'projects',
  // Teams (spec 2026-08-06-org-team-auth-onboarding, D2/D12, Phase 5c) — org-wide, like Accounts
  // and Projects, and NOT gated by `singleProject`: a single-project deployment can still belong
  // to an org with more than one team.
  'teams',
  // Account (D14, same spec) — logout. Declared unconditionally: visibility is an async probe
  // inside the panel (`account-section.tsx`), not a registry-level gate, so it is never absent
  // from THIS list (which reflects only the synchronous `hidden`/`capability` gates).
  'account',
  // Backup (spec 2026-08-16-provider-agnostic-platform-backup) — declared unconditionally like
  // `account`/`teams`: `CEZ_BACKUP` is deliberately not a health capability, so visibility is an
  // async probe inside `backup-section.tsx`.
  'backup',
]

/** The half that answers per repo. Every one of these was unreachable from the address the
 *  sidebar pointed at — which is the whole report. */
const PER_PROJECT = ['project', 'agents', 'agent-config', 'worktrees', 'bookmarklets', 'prompt-templates']

describe('the section registry', () => {
  it('declares every spec §Settings section, later ones hidden', () => {
    const byId = new Map(SETTINGS_SECTIONS.map((s) => [s.id, s]))
    for (const id of ALL_SECTIONS) {
      expect(byId.get(id as never)?.hidden).toBeUndefined()
    }
    // Listed in the registry but hidden until implemented (later phase).
    for (const id of ['keyboard']) {
      expect(byId.get(id as never)?.hidden).toBe(true)
    }
  })

  it('is ONE list — no scope argument, nothing filtered out by area', () => {
    expect(visibleSettingsSections().map((s) => s.id)).toEqual(ALL_SECTIONS)
    // `sources` is capability-gated, not area-gated: it appears exactly when `CEZ_SOURCES=1` does.
    expect(
      visibleSettingsSections({ singleProject: false, sources: true, cluster: false }).map((s) => s.id),
    ).toContain('sources')
    expect(
      visibleSettingsSections({ singleProject: false, sources: false, cluster: false }).map((s) => s.id),
    ).toEqual(ALL_SECTIONS)
    // `cluster` the same way (`CEZ_CLUSTER=1`,
    // `.ai/specs/2026-08-22-multi-node-cezar-cluster.md` Verification 12). Both directions, because
    // the gate drops the ROUTE as well as the nav entry: `visibleSettingsSections` is what the
    // shell builds its route table from, so a section missing here is a 404 at
    // `/settings/cluster` — and asserting only the nav would pass against a reachable orphan
    // route.
    expect(
      visibleSettingsSections({ singleProject: false, sources: false, cluster: true }).map((s) => s.id),
    ).toContain('cluster')
    expect(
      visibleSettingsSections({ singleProject: false, sources: false, cluster: false }).map((s) => s.id),
    ).not.toContain('cluster')
    // Unknown health reads as off, like every other gate here.
    expect(visibleSettingsSections().map((s) => s.id)).not.toContain('cluster')
  })

  it('marks scope as a FIELD: appliesTo, not a routing area', () => {
    for (const section of visibleSettingsSections()) {
      expect(section.appliesTo).toBe(PER_PROJECT.includes(section.id) ? 'per-project' : 'workspace')
    }
    // Providers is the sharpest case (spec Phase 2): its switch writes workspace state, so it is
    // a workspace section rather than something reached through one arbitrary project's URL.
    expect(SETTINGS_SECTIONS.find((s) => s.id === 'providers')?.appliesTo).toBe('workspace')
    // Only Agents can answer for *All projects*: the other five edit a folder, a branch, a
    // checkout's worktrees or that repo's own files, and have no machine tier to fall back on.
    expect(visibleSettingsSections().filter((s) => s.machineTier === true).map((s) => s.id)).toEqual([
      'agents',
    ])
  })

  it('hides Projects only when the single-project capability is active', () => {
    // Accounts, Teams and Account all survive: a single-project cockpit still runs on ONE of
    // possibly several logins in an org with more than one team, and can still have a session to
    // sign out of — none of that is "how many projects".
    expect(
      visibleSettingsSections({ singleProject: true, sources: false, cluster: false }).map((s) => s.id),
    ).toEqual(ALL_SECTIONS.filter((id) => id !== 'projects'))
  })
})

describe('the settings shell', () => {
  it('renders ONE nav from the registry — every section, in one list', () => {
    renderAt('/settings/agents')
    const nav = document.querySelector('[data-slot="settings-nav"]')!
    const ids = [...nav.querySelectorAll('[data-section]')].map((el) => el.getAttribute('data-section'))
    expect(ids).toEqual(ALL_SECTIONS)
    // The area split is gone from the DOM too, not just from the list: no nav carries a scope.
    expect(nav.getAttribute('data-scope')).toBeNull()
    // The active section is marked for assistive tech, not just by color.
    expect(nav.querySelector('[aria-current="page"]')?.getAttribute('data-section')).toBe('agents')
    // The mobile pill row renders through the same registry — the two can never disagree.
    const pills = document.querySelector('[data-slot="settings-nav-mobile"]')!
    expect([...pills.querySelectorAll('[data-section]')].length).toBe(ALL_SECTIONS.length)
  })

  it('every nav link is flat and unprefixed — there is no project in a settings URL', () => {
    renderAt('/settings/worktrees')
    const nav = document.querySelector('[data-slot="settings-nav"]')!
    expect(nav.querySelector('[data-section="resources"]')?.getAttribute('href')).toBe('/settings/resources')
    expect(nav.querySelector('[data-section="agents"]')?.getAttribute('href')).toBe('/settings/agents')
    expect(nav.querySelector('[data-section="projects"]')?.getAttribute('href')).toBe('/settings/projects')
  })

  it('carries the selected project across a nav click', () => {
    // Switching sections while standing on one project must not silently re-target the machine
    // tier — the user picked a subject, and a nav click is not a change of subject.
    renderAt('/settings/worktrees?project=chat')
    const nav = document.querySelector('[data-slot="settings-nav"]')!
    expect(nav.querySelector('[data-section="agents"]')?.getAttribute('href')).toBe(
      '/settings/agents?project=chat',
    )
  })

  it('every section keeps a way BACK to the index: the "All settings" nav entry', () => {
    renderAt('/settings/worktrees')
    expect(
      document.querySelector('[data-slot="settings-nav"] [data-slot="settings-nav-index"]')?.getAttribute('href'),
    ).toBe('/settings')
    // The mobile pill row carries it too — the index is the ONLY place small screens see it.
    expect(
      document.querySelector('[data-slot="settings-nav-mobile"] [data-slot="settings-nav-index"]')?.getAttribute('href'),
    ).toBe('/settings')
    // A section is open, so the index is not the current page.
    expect(document.querySelector('[data-slot="settings-nav-index"][aria-current="page"]')).toBeNull()
  })

  it('/settings is the registry as an index — one card per visible section', () => {
    renderAt('/settings')
    expect(
      document.querySelector('[data-slot="settings-nav"] [data-slot="settings-nav-index"]')?.getAttribute('aria-current'),
    ).toBe('page')
    const index = document.querySelector('[data-slot="settings-index"]')!
    const ids = [...index.querySelectorAll('[data-section]')].map((el) => el.getAttribute('data-section'))
    expect(ids).toEqual(ALL_SECTIONS)
    expect(index.querySelector('[data-section="bookmarklets"]')?.getAttribute('href')).toBe(
      '/settings/bookmarklets',
    )
    // No cross-link to a second area, because there is no second area. The old file asserted the
    // opposite (`settings-global-link`), which is exactly the invariant this change removes.
    expect(document.querySelector('[data-slot="settings-global-link"]')).toBeNull()
  })

  it('single-project mode removes Projects from the index and the navigation', () => {
    renderAt('/settings', { singleProject: true })
    expect(document.querySelector('[data-slot="settings-index"] [data-section="projects"]')).toBeNull()
    expect(document.querySelector('[data-slot="settings-nav"] [data-section="projects"]')).toBeNull()
    expect(document.querySelector('[data-section="resources"]')).not.toBeNull()
  })

  it('a per-project section shows the project selector; a workspace one does not', () => {
    renderAt('/settings/worktrees')
    expect(document.querySelector('[data-slot="settings-project-selector"]')).not.toBeNull()
    cleanup()

    renderAt('/settings/appearance')
    expect(document.querySelector('[data-slot="settings-project-selector"]')).toBeNull()
    expect(document.querySelector('[data-slot="settings-applies-to"]')?.textContent).toBe('All projects')
  })

  it('a per-project section with no machine tier asks for a project instead of faking one', async () => {
    // The honest half of the design: a checkout's worktrees have no all-projects answer, so the
    // pane says so and offers the pick rather than rendering a control that would write somewhere
    // arbitrary — which is what the old area did by borrowing the project from the URL.
    renderAt('/settings/worktrees')
    const required = await waitFor(() => {
      const el = document.querySelector('[data-slot="settings-project-required"]')
      expect(el).not.toBeNull()
      return el!
    })
    expect([...required.querySelectorAll('[data-slot="settings-project-pick"]')].map((el) =>
      el.getAttribute('data-project'),
    )).toEqual(['boot', 'chat'])
  })

  it('unfinished sections say so through the shared CenteredState template', () => {
    // Hidden sections are not routed (their URLs 404) — render the registry component
    // directly to pin the placeholder contract itself.
    const Keyboard = SETTINGS_SECTIONS.find((s) => s.id === 'keyboard')!.component
    render(<Keyboard />)
    const state = document.querySelector('[data-slot="centered-state"]')
    expect(state?.textContent).toContain('later phase')
  })
})

describe('the appearance section', () => {
  it('persisted values apply at boot: server ui-state stamps the root and the controls', async () => {
    serve({ appearance: { accent: 'violet', density: 'compact' } })
    renderAt('/settings/appearance')

    await waitFor(() => {
      expect(document.documentElement.dataset.accent).toBe('violet')
    })
    expect(document.documentElement.dataset.density).toBe('compact')
    expect(screen.getByRole('radio', { name: 'Violet' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('radio', { name: 'Compact' }).getAttribute('aria-checked')).toBe('true')
    // The mirror follows the server, so the next cold load pre-paints the truth.
    expect(localStorage.getItem('cez-accent')).toBe('violet')
    expect(localStorage.getItem('cez-density')).toBe('compact')
  })

  it('accent round-trip: apply immediately, PUT the FULL appearance object', async () => {
    serve({ appearance: { density: 'compact' } })
    renderAt('/settings/appearance')
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'Compact' }).getAttribute('aria-checked')).toBe('true')
    })

    fireEvent.click(screen.getByRole('radio', { name: 'Violet' }))
    expect(document.documentElement.dataset.accent).toBe('violet')

    // The whole object, not a partial — the server's ui-state merge is shallow, so a bare
    // `{ accent }` would silently drop the stored density.
    await waitFor(() => {
      expect(requests.find((r) => r.method === 'PUT' && r.url === '/api/v1/workspace/ui-state')?.body).toEqual({
        appearance: { accent: 'violet', density: 'compact', width: 'narrow' },
      })
    })
    expect(localStorage.getItem('cez-accent')).toBe('violet')
  })

  it('density flips back to the default and the attribute comes OFF the root', async () => {
    serve({ appearance: { density: 'compact' } })
    renderAt('/settings/appearance')
    await waitFor(() => {
      expect(document.documentElement.dataset.density).toBe('compact')
    })

    fireEvent.click(screen.getByRole('radio', { name: 'Comfortable' }))
    expect(document.documentElement.hasAttribute('data-density')).toBe(false)
    await waitFor(() => {
      expect(requests.find((r) => r.method === 'PUT' && r.url === '/api/v1/workspace/ui-state')?.body).toEqual({
        appearance: { accent: 'lime', density: 'comfortable', width: 'narrow' },
      })
    })
  })

  it('reading width round-trip: Wide stamps the root and PUTs the full object; back to Narrow clears it', async () => {
    serve({ appearance: { accent: 'violet' } })
    renderAt('/settings/appearance')
    // Wait for the server value to settle (Violet is server-provided; Narrow is the default and
    // would report "checked" from the mirror before the GET even lands), so the pending load
    // can't clobber the width write we're about to make.
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'Violet' }).getAttribute('aria-checked')).toBe('true')
    })
    expect(screen.getByRole('radio', { name: 'Narrow' }).getAttribute('aria-checked')).toBe('true')

    fireEvent.click(screen.getByRole('radio', { name: 'Wide' }))
    expect(document.documentElement.dataset.width).toBe('wide')
    await waitFor(() => {
      expect(requests.find((r) => r.method === 'PUT' && r.url === '/api/v1/workspace/ui-state')?.body).toEqual({
        appearance: { accent: 'violet', density: 'comfortable', width: 'wide' },
      })
    })

    // Narrow is the default — the attribute must come OFF the root, not be written as data-width="narrow".
    fireEvent.click(screen.getByRole('radio', { name: 'Narrow' }))
    await waitFor(() => {
      expect(document.documentElement.hasAttribute('data-width')).toBe(false)
    })
  })

  it('theme rides the existing theme system: class + localStorage, no ui-state write', async () => {
    renderAt('/settings/appearance')

    fireEvent.click(screen.getByRole('radio', { name: 'Light' }))
    expect(document.documentElement.classList.contains('light')).toBe(true)
    expect(localStorage.getItem('cez-theme')).toBe('light')
    expect(screen.getByRole('radio', { name: 'Light' }).getAttribute('aria-checked')).toBe('true')

    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }))
    expect(document.documentElement.classList.contains('light')).toBe(false)
    expect(localStorage.getItem('cez-theme')).toBe('dark')

    // Theme is per-browser by design (pre-paint) — it must never leak into ui-state.json.
    await waitFor(() => {
      expect(requests.some((r) => r.url === '/api/v1/workspace/ui-state' && r.method === 'GET')).toBe(true)
    })
    expect(requests.some((r) => r.method === 'PUT' && r.url.endsWith('ui-state'))).toBe(false)
  })
})

/**
 * The acceptance test, stated as bluntly as the spec states it. It used to read "the settings
 * SPLIT writes the right store"; the split is gone and the property it protected is not. Each
 * assertion checks BOTH halves — the right URL was written AND the other stores were left alone —
 * because a section wired to both would satisfy a one-sided check.
 */
describe('one settings area, still writing the right store', () => {
  const putsTo = (url: string) => requests.filter((r) => r.method === 'PUT' && r.url === url)

  it('appearance → /api/v1/workspace/ui-state, never the per-repo one', async () => {
    renderAt('/settings/appearance')
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Violet' })).toBeTruthy())

    fireEvent.click(screen.getByRole('radio', { name: 'Violet' }))

    await waitFor(() => expect(putsTo('/api/v1/workspace/ui-state')).toHaveLength(1))
    expect(putsTo('/api/v1/workspace/ui-state')[0]?.body).toEqual({
      appearance: { accent: 'violet', density: 'comfortable', width: 'narrow' },
    })
    expect(putsTo('/api/v1/ui-state')).toHaveLength(0)
  })

  it('notifications → /api/v1/workspace/ui-state, never the per-repo one', async () => {
    // `Notification` is absent in jsdom; the section only needs it to decide whether to ask for
    // permission, and "already granted" is the path that persists without any prompt.
    function FakeNotification() {}
    ;(FakeNotification as unknown as { permission: string }).permission = 'granted'
    vi.stubGlobal('Notification', FakeNotification)

    renderAt('/settings/notifications')
    const toggle = await screen.findByRole('switch', { name: 'Notify when an agent needs you' })
    fireEvent.click(toggle)

    await waitFor(() => expect(putsTo('/api/v1/workspace/ui-state')).toHaveLength(1))
    expect(putsTo('/api/v1/workspace/ui-state')[0]?.body).toEqual({ notifications: { enabled: true } })
    expect(putsTo('/api/v1/ui-state')).toHaveLength(0)
  })

  it('agents with a project → THAT project’s /api/v1/p/<id>/config, never a workspace route', async () => {
    // `?project=chat` is the whole mechanism: the section sits outside `/p/:projectId` and still
    // addresses chat's own config, because the shell mounts a scope provider around its body.
    renderAt('/settings/agents?project=chat')
    const runner = await waitFor(() => {
      const el = document.querySelector<HTMLButtonElement>('[data-slot="agents-runner"] [data-value="codex"]')
      expect(el).not.toBeNull()
      return el!
    })

    fireEvent.click(runner)

    await waitFor(() => expect(putsTo('/api/v1/p/chat/config')).toHaveLength(1))
    expect(putsTo('/api/v1/p/chat/config')[0]?.body).toEqual({ defaultRunner: 'codex' })
    expect(requests.some((r) => r.method === 'PUT' && r.url.startsWith('/api/v1/workspace/'))).toBe(false)
    // …and never some OTHER project's copy, which is the failure a bare `/api/v1/config` would be.
    expect(putsTo('/api/v1/config')).toHaveLength(0)
  })

  it('agents with All projects → /api/v1/workspace/config, never any repo’s config', async () => {
    renderAt('/settings/agents')
    const prompt = await screen.findByLabelText('System prompt')
    fireEvent.change(prompt, { target: { value: 'be brief' } })
    fireEvent.click(screen.getByRole('button', { name: /Save for all projects/ }))

    await waitFor(() => expect(putsTo('/api/v1/workspace/config')).toHaveLength(1))
    expect(putsTo('/api/v1/workspace/config')[0]?.body).toEqual({
      projectDefaults: { systemPrompt: 'be brief' },
    })
    // The machine tier must never touch a committable repo file — that is the reason the two
    // files stay separate, and the one thing this page could plausibly get wrong.
    expect(requests.some((r) => r.method === 'PUT' && /^\/api\/v1(\/p\/[^/]+)?\/config$/.test(r.url))).toBe(
      false,
    )
  })
})
