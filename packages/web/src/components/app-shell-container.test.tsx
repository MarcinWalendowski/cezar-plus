import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { workspaceQueryKeys } from '@/api/queries'
import type {
  HealthResponse,
  ProviderStatusResponse,
  RunRecord,
} from '@loki-labs/better-cezar-api-client'
import {
  AppShellContainer,
  repoChipOf,
} from '@/components/app-shell-container'
import { ThemeProvider } from '@/components/theme-provider'

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  document.title = 'cezar'
  vi.stubGlobal('fetch', fetchMock)
  // jsdom ships no matchMedia; the shell's breakpoint effect and the theme toggle need one.
  vi.stubGlobal(
    'matchMedia',
    () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  )
})

afterEach(() => {
  cleanup()
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

const HEALTH: HealthResponse = {
  version: '0.1.3',
  projects: [],
  bootProject: 'default',
  repoRoot: '/home/me/Projects/cezar',
  repo: { root: '/home/me/Projects/cezar', branch: 'feat/cockpit', remote: 'origin' },
  checks: [],
  defaultRunner: 'claude',
  forge: null,
  capabilities: { cluster: false, localHandoff: true, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: true, singleProject: false, knowledge: false, sources: false, notes: false, workspaceViews: false, notify: false, accountUsage: false, skills: true, automations: false },
}

/** One registered project — the degenerate workspace every existing install upgrades into. */
const PROJECT = {
  id: 'cezar',
  name: 'cezar',
  root: '/home/me/Projects/cezar',
  addedAt: '2026-07-01T00:00:00.000Z',
  lastOpenedAt: '2026-07-20T12:00:00.000Z',
  source: 'local' as const,
  status: 'ok' as const,
  branch: 'main',
}

const TODOS = [
  { id: 't1', summary: 'Review the PR' },
  { id: 't2', summary: 'Rebase the branch' },
]

const PROVIDERS: ProviderStatusResponse = {
  providers: [
    { provider: 'claude', status: 'connected', enabled: true },
    { provider: 'codex', status: 'disconnected', enabled: true },
    { provider: 'opencode', status: 'not-installed', enabled: true },
  ],
}

/** Answer each endpoint the shell reads; anything else 404s loudly rather than silently
 *  resolving to `{}` and making a broken wiring look fine. */
function serve(routes: Record<string, unknown>): void {
  fetchMock.mockImplementation(async (input) => {
    const path = String(input)
    const response =
      path === '/api/v1/providers/status'
        ? (routes[path] ?? PROVIDERS)
        : path === '/api/v1/workspace/ui-state'
          ? (routes[path] ?? {})
          : routes[path]
    if (response === undefined) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
    if (response instanceof Response) return response
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
}

function renderShell(entry = '/', client: QueryClient = createQueryClient()) {
  return {
    client,
    ...render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[entry]}>
          <AppShellContainer>
            <p>route content</p>
          </AppShellContainer>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
    ),
  }
}

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1',
    title: 'Raw task prompt',
    titleSummary: 'Implement page titles',
    workflow: 'quick-task',
    task: 'Implement page titles',
    status: 'running',
    createdAt: '2026-07-21T12:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...overrides,
  }
}

const repoChip = () => document.querySelector('[data-slot="repo-chip"]')
const versionChip = () => document.querySelector('[data-slot="version-chip"]')
const navBadge = () => document.querySelector('[data-slot="nav-badge"]')

describe('repoChipOf', () => {
  it.each([
    { name: 'a plain root', root: '/home/me/Projects/cezar', expected: 'cezar' },
    { name: 'a trailing slash', root: '/home/me/cezar/', expected: 'cezar' },
    { name: 'a windows path', root: 'C:\\Users\\me\\cezar', expected: 'cezar' },
    { name: 'the filesystem root as a repo', root: '/', expected: null },
  ])('takes the basename of $name', ({ root, expected }) => {
    const chip = repoChipOf({ ...HEALTH, repo: { root, branch: 'main' } })
    expect(chip?.name ?? null).toBe(expected)
  })

  it('is null while health is unknown, and outside a git repo', () => {
    expect(repoChipOf(undefined)).toBeNull()
    expect(repoChipOf({ ...HEALTH, repo: null })).toBeNull()
  })
})

describe('sidebar wiring', () => {
  it('renders the repo and version chips from /api/v1/health', async () => {
    serve({ '/api/v1/health': HEALTH, '/api/v1/todos': [] })
    renderShell()

    await waitFor(() => expect(repoChip()).not.toBeNull())
    // Basename of the root, then the branch — not the whole path.
    expect(repoChip()?.textContent).toBe('cezar / feat/cockpit')
    expect(versionChip()?.textContent).toBe('v0.1.3')
  })

  it('renders the inbox badge from /api/v1/todos', async () => {
    serve({ '/api/v1/health': HEALTH, '/api/v1/todos': TODOS })
    renderShell()

    await waitFor(() => expect(navBadge()).not.toBeNull())
    expect(navBadge()?.textContent).toBe('2')
    expect(screen.getByRole('link', { name: /Inbox/ })).toBeTruthy()
  })

  // #471 — the global inbox is opt-in; the shell must not offer what the server cannot fill.
  it('drops the Inbox nav item and its badge when the server has follow-ups off', async () => {
    serve({
      '/api/v1/health': { ...HEALTH, capabilities: { cluster: false, localHandoff: true, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: false } },
      '/api/v1/todos': TODOS,
    })
    renderShell()

    await waitFor(() => expect(versionChip()).not.toBeNull())
    expect(screen.queryByRole('link', { name: /Inbox/ })).toBeNull()
    expect(navBadge()).toBeNull()
    // Every other view is untouched — the gate owns exactly one item. Scoped to the NAV since
    // `.ai/specs/2026-08-21-one-settings-area.md`: the sidebar footer's icon link is named
    // "Settings" too now (it used to say "Global settings", because it led to the other area),
    // so an unscoped name query matches two real links.
    const nav = screen.getByRole('navigation', { name: 'Main' })
    expect(within(nav).getByRole('link', { name: /Tasks/ })).toBeTruthy()
    expect(within(nav).getByRole('link', { name: /Settings/ })).toBeTruthy()
  })

  it('never asks for todos on a server with the inbox off', async () => {
    serve({
      '/api/v1/health': { ...HEALTH, capabilities: { cluster: false, localHandoff: true, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: false } },
      '/api/v1/todos': TODOS,
    })
    renderShell()

    await waitFor(() => expect(versionChip()).not.toBeNull())
    // The badge query is keyed on the capability, so it never runs — unlike the /inbox route,
    // nothing here needs the list before health has spoken.
    const asked = fetchMock.mock.calls.map((call) => String(call[0]))
    expect(asked).not.toContain('/api/v1/todos')
  })

  // #801 — the same honesty rule for the opt-in automations capability. Both cases carry a
  // reachable forge, so the ONLY thing deciding the Automations item here is the capability:
  // before the flag, every project with a GitHub remote saw that tab.
  const WITH_FORGE = { ...HEALTH, forge: { kind: 'github' as const, available: true } }

  it('drops the Automations nav item when the server has automations off', async () => {
    serve({ '/api/v1/health': WITH_FORGE, '/api/v1/todos': [] })
    renderShell()

    await waitFor(() => expect(versionChip()).not.toBeNull())
    expect(screen.queryByRole('link', { name: /Automations/ })).toBeNull()
    // The gate owns exactly one item, and this asserted the OTHER forge-gated row (GitHub) was
    // still there. GitHub is hidden from the nav since 2026-08-14 (`nav-items.ts`), so the
    // surviving statement of "the automations gate removed one item, not the forge's whole
    // family" is that a forge-carrying row unrelated to automations — Git — is untouched.
    expect(screen.getByRole('link', { name: /Git$/ })).toBeTruthy()
    expect(screen.queryByRole('link', { name: /GitHub/ })).toBeNull()
  })

  it('shows the Automations nav item once health reports the capability', async () => {
    serve({
      '/api/v1/health': { ...WITH_FORGE, capabilities: { ...HEALTH.capabilities, automations: true } },
      '/api/v1/todos': [],
    })
    renderShell()

    await waitFor(() => expect(versionChip()).not.toBeNull())
    expect(screen.getByRole('link', { name: /Automations/ })).toBeTruthy()
  })

  it('renders no badge for an empty inbox', async () => {
    serve({ '/api/v1/health': HEALTH, '/api/v1/todos': [] })
    renderShell()

    await waitFor(() => expect(versionChip()).not.toBeNull())
    // Zero follow-ups is not "0 follow-ups" — a badge reading 0 is noise the spec's chrome
    // rules do not want.
    expect(navBadge()).toBeNull()
  })

  it('shows no chips at all while health has not answered', () => {
    // A never-resolving fetch: the pending state, held.
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}))
    renderShell()

    expect(repoChip()).toBeNull()
    expect(versionChip()).toBeNull()
    expect(navBadge()).toBeNull()
    // …and the app itself is up. The chips being empty is not a loading screen.
    expect(screen.getByText('route content')).toBeTruthy()
    expect(document.querySelector('[data-slot="sidebar"]')).not.toBeNull()
  })

  it('shows no chips when the server is unreachable, and still renders the app', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    renderShell()

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    // The honest empty state: cezar cannot answer what repo it is on, so it says nothing.
    // It does not invent one, and it does not take the whole cockpit down with it.
    expect(repoChip()).toBeNull()
    expect(versionChip()).toBeNull()
    expect(screen.getByText('route content')).toBeTruthy()
  })

  // CEZ_SINGLE_PROJECT pins this response to the boot row even when the saved registry has more.
  // The shell must collapse from that ordinary one-row response, not grow a second capability
  // branch for navigation: flat nav, one quick-list, repo chip, no group headers.
  it('keeps the sidebar flat when single-project mode pins the registry to the boot project', async () => {
    serve({
      '/api/v1/health': {
        ...HEALTH,
        capabilities: { ...HEALTH.capabilities, singleProject: true },
      },
      '/api/v1/todos': [],
      '/api/v1/projects': { projects: [PROJECT], bootProject: 'cezar', projectsDir: '/home/me/cezar/projects' },
      '/api/v1/runs': [],
    })
    renderShell()

    await waitFor(() => expect(repoChip()).not.toBeNull())
    expect(document.querySelector('[data-slot="project-groups"]')).toBeNull()
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy()
    expect(document.querySelector('[data-slot="task-quick-list"]')).not.toBeNull()
    expect(repoChip()?.textContent).toBe('cezar / feat/cockpit')
  })

  it('hides add-project chrome when health reports single-project mode', async () => {
    serve({
      '/api/v1/health': {
        ...HEALTH,
        capabilities: { ...HEALTH.capabilities, singleProject: true },
      },
      '/api/v1/todos': [],
      '/api/v1/projects': { projects: [PROJECT], bootProject: 'cezar', projectsDir: '/home/me/cezar/projects' },
      '/api/v1/runs': [],
    })
    renderShell()

    await waitFor(() => expect(versionChip()).not.toBeNull())
    expect(screen.queryByRole('button', { name: 'Add project' })).toBeNull()
    expect(screen.getByRole('link', { name: /New task/ })).toBeTruthy()
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy()
  })

  it('renders one collapsible group per project once the workspace has two', async () => {
    serve({
      '/api/v1/health': HEALTH,
      '/api/v1/todos': [],
      '/api/v1/projects': {
        projects: [PROJECT, { ...PROJECT, id: 'shop', name: 'shop', lastOpenedAt: '2026-07-19T00:00:00.000Z' }],
        bootProject: 'cezar',
        projectsDir: '/home/me/cezar/projects',
      },
      '/api/v1/workspace/ui-state': {},
      '/api/v1/p/cezar/runs': [],
    })
    renderShell()

    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="project-group"]')).toHaveLength(2),
    )
    // The flat nav and the shared quick-list step aside — each group brings its own.
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull()
    expect(document.querySelector('[data-slot="task-quick-list"]')).toBeNull()
    // …and so does the repo chip, which the boot project's own group header now carries.
    expect(repoChip()).toBeNull()
  })

  it('shows the version chip even outside a git repo', async () => {
    serve({ '/api/v1/health': { ...HEALTH, repo: null }, '/api/v1/todos': [] })
    renderShell()

    // Running cezar outside a repo is supported: no repo chip, but the rest of the chrome is
    // real and must not vanish with it.
    await waitFor(() => expect(versionChip()).not.toBeNull())
    expect(versionChip()?.textContent).toBe('v0.1.3')
    expect(repoChip()).toBeNull()
  })

  it('wires the provider query into the AppShell banner slot', async () => {
    serve({
      '/api/v1/health': HEALTH,
      '/api/v1/todos': [],
      '/api/v1/providers/status': {
        providers: [
          { provider: 'claude', status: 'disconnected', enabled: true },
          { provider: 'codex', status: 'not-installed', enabled: true },
          { provider: 'opencode', status: 'disconnected', enabled: true },
        ],
      },
    })
    renderShell('/p/cezar/')

    const banner = await screen.findByRole('status')
    expect(banner.textContent).toContain('No agent provider credentials were found.')
    expect(document.querySelector('[data-slot="banner-slot"]')?.contains(banner)).toBe(true)
  })

  it('shows a runtime authentication incident in the global banner slot', async () => {
    serve({
      '/api/v1/health': HEALTH,
      '/api/v1/todos': [],
      '/api/v1/providers/status': {
        providers: [
          { provider: 'claude', status: 'disconnected', enabled: true },
          { provider: 'codex', status: 'connected', enabled: true },
          { provider: 'opencode', status: 'disconnected', enabled: true, authFailureId: 'open-1' },
        ],
      },
    })
    renderShell('/p/cezar/')

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(
      'Provider authentication failed during a task: OpenCode.',
    )
    expect(document.querySelector('[data-slot="banner-slot"]')?.contains(alert)).toBe(true)
  })

  it('keeps the shell and route content when provider status fails', async () => {
    serve({
      '/api/v1/health': HEALTH,
      '/api/v1/todos': [],
      '/api/v1/providers/status': new Response(JSON.stringify({ error: 'unavailable' }), { status: 500 }),
    })
    const client = createQueryClient()
    client.setDefaultOptions({
      queries: { ...client.getDefaultOptions().queries, retry: false },
    })
    renderShell('/', client)

    await waitFor(() =>
      expect(client.getQueryState(workspaceQueryKeys.providerStatus)?.status).toBe('error'),
    )
    expect(screen.getByText('route content')).toBeTruthy()
    expect(document.querySelector('[data-slot="app-shell"]')).not.toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('keeps the shell and route content when a successful provider response is malformed', async () => {
    const secret = 'unexpected-provider-payload'
    serve({
      '/api/v1/health': HEALTH,
      '/api/v1/todos': [],
      '/api/v1/providers/status': { providers: [null, { provider: 'future', status: secret }] },
    })
    const client = createQueryClient()
    client.setDefaultOptions({
      queries: { ...client.getDefaultOptions().queries, retry: false },
    })
    renderShell('/', client)

    await waitFor(() =>
      expect(client.getQueryState(workspaceQueryKeys.providerStatus)?.status).toBe('error'),
    )
    expect(screen.getByText('route content')).toBeTruthy()
    expect(document.querySelector('[data-slot="app-shell"]')).not.toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByText(secret)).toBeNull()
  })
})

describe('document title wiring', () => {
  const REGISTRY = {
    projects: [PROJECT],
    bootProject: 'cezar',
    projectsDir: '/home/me/cezar/projects',
  }
  const HEALTH_WITH_BOOT = { ...HEALTH, bootProject: 'cezar' }

  it('combines the selected project with scoped page context', async () => {
    serve({
      '/api/v1/health': HEALTH_WITH_BOOT,
      '/api/v1/todos': [],
      '/api/v1/projects': {
        ...REGISTRY,
        projects: [{ ...PROJECT, id: 'shop', name: 'Storefront' }],
      },
      '/api/v1/runs': [],
    })
    renderShell('/p/shop/git')

    await waitFor(() => expect(document.title).toBe('Storefront — Git · cezar'))
  })

  it('falls back to the boot repository name when the registry is unavailable', async () => {
    serve({ '/api/v1/health': HEALTH_WITH_BOOT, '/api/v1/todos': [], '/api/v1/runs': [] })
    renderShell('/p/cezar/')

    await waitFor(() => expect(document.title).toBe('cezar — Tasks · cezar'))
  })

  it('keeps global settings and a no-repo task route free of invented project context', async () => {
    serve({
      '/api/v1/health': { ...HEALTH_WITH_BOOT, repo: null },
      '/api/v1/todos': [],
      '/api/v1/projects': REGISTRY,
      '/api/v1/runs': [],
    })
    const global = renderShell('/settings/global/projects')

    await waitFor(() => expect(document.title).toBe('Settings · cezar'))
    global.unmount()

    renderShell('/tasks/missing')
    await waitFor(() => expect(document.title).toBe('cezar'))
  })

  it('updates after in-app navigation without remounting the shell', async () => {
    serve({
      '/api/v1/health': HEALTH_WITH_BOOT,
      '/api/v1/todos': [],
      '/api/v1/projects': REGISTRY,
      '/api/v1/runs': [],
    })
    renderShell('/p/cezar/')

    await waitFor(() => expect(document.title).toBe('cezar — Tasks · cezar'))
    fireEvent.click(screen.getByRole('link', { name: 'Git' }))
    await waitFor(() => expect(document.title).toBe('cezar — Git · cezar'))
  })

  it('reacts to live project and task title cache updates', async () => {
    const initialRun = run()
    serve({
      '/api/v1/health': HEALTH_WITH_BOOT,
      '/api/v1/todos': [],
      '/api/v1/projects': {
        ...REGISTRY,
        projects: [{ ...PROJECT, id: 'shop', name: 'Storefront' }],
      },
      '/api/v1/runs': [],
      '/api/v1/p/shop/runs': [initialRun],
    })
    const { client } = renderShell('/p/shop/tasks/run-1')

    await waitFor(() =>
      expect(document.title).toBe('Storefront — Implement page titles · cezar'),
    )

    act(() => {
      client.setQueryData(workspaceQueryKeys.projects, {
        ...REGISTRY,
        projects: [{ ...PROJECT, id: 'shop', name: 'Renamed storefront' }],
      })
      client.setQueryData(['shop', 'runs', 'list'], [
        { ...initialRun, titleSummary: 'Rename browser titles' },
      ])
    })

    await waitFor(() =>
      expect(document.title).toBe('Renamed storefront — Rename browser titles · cezar'),
    )
  })
})

/**
 * D14 (`.ai/specs/2026-08-06-org-team-auth-onboarding.md`, owner decision): "no dashboard element
 * renders before the first organization exists" — `AppShellContainer` reads the shared onboarding
 * probe (`onboarding-gate.ts`) and passes `chromeless` to `<AppShell>` accordingly. `AppShell`'s
 * own test file (`app-shell.test.tsx`) pins what `chromeless` does presentationally; these tests
 * pin the WIRING — which live probe answers actually flip it, and which never do.
 */
describe('D14 onboarding gate (chromeless)', () => {
  it('needs-org: hides the sidebar (and the rest of the chrome), still renders children', async () => {
    serve({
      '/api/v1/health': HEALTH,
      '/api/v1/todos': [],
      '/auth/onboarding': { state: 'needs-org', suggestedOrgName: 'Acme', bootstrapTokenRequired: false },
    })
    renderShell()

    await waitFor(() =>
      expect(document.querySelector('[data-slot="app-shell"]')?.getAttribute('data-chromeless')).toBe(''),
    )
    expect(document.querySelector('[data-slot="sidebar"]')).toBeNull()
    expect(document.querySelector('[data-slot="mobile-top-bar"]')).toBeNull()
    // The content passed to `AppShellContainer` still renders — the wizard IS the surface, not a
    // blank page.
    expect(screen.getByText('route content')).toBeTruthy()
  })

  /** THE constraint D14 spells out explicitly: this topology must NEVER gate. Hosted, `CEZ_AUTH`
   *  unset, `CEZ_ALLOW_UNAUTHENTICATED=1` mounts no `/auth/*` surface at all, so `GET
   *  /auth/onboarding` falls through to the SPA catch-all — the exact shape `onboarding-api.ts`
   *  reads as `unavailable`, never `needs-org`. Gating that deployment would brick it behind a
   *  wizard it can never satisfy. */
  it('unavailable (hosted, no /auth/* mounted at all): never gates — the sidebar renders normally', async () => {
    serve({
      '/api/v1/health': HEALTH,
      '/api/v1/todos': [],
      '/auth/onboarding': new Response('<!doctype html><html><body>cezar</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    })
    renderShell()

    await waitFor(() => expect(repoChip()).not.toBeNull())
    // Give the probe every chance to resolve and the gate every chance to (wrongly) fire before
    // asserting it never does.
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(document.querySelector('[data-slot="sidebar"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="app-shell"]')?.getAttribute('data-chromeless')).toBeNull()
  })

  /**
   * **INVERTED 2026-08-19** (`.ai/specs/2026-08-19-signed-out-cockpit-reauth.md`, test 2). This
   * case used to be named `'signed-out never gates'` and asserted the sidebar rendered — it was
   * pinning the bug. An owner report against a hosted deployment: clearing site data left the
   * whole cockpit on screen with every `/api/*` query 401ing behind it, and no way to sign in.
   *
   * `signed-out` is reachable only from the `oidc`/`google` boot branch, which mounts
   * `/auth/login` in the same breath, so gating here can never brick a topology — the hazard the
   * `unavailable` case above exists for, and the reason these two must NOT be tested as one.
   */
  it('signed-out gates: no cockpit renders to a caller with no session', async () => {
    serve({
      '/api/v1/health': HEALTH,
      '/api/v1/todos': [],
      '/auth/onboarding': new Response(JSON.stringify({ error: 'unauthenticated' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    })
    renderShell()

    await waitFor(() =>
      expect(document.querySelector('[data-slot="app-shell"]')?.getAttribute('data-chromeless')).toBe(''),
    )
    expect(document.querySelector('[data-slot="sidebar"]')).toBeNull()
    expect(document.querySelector('[data-slot="mobile-top-bar"]')).toBeNull()
    // `children` still renders — the sign-in screen IS the surface, not a blank page (the same
    // rule the `needs-org` case above holds).
    expect(screen.getByText('route content')).toBeTruthy()
  })

  it('ready (an org already exists) never gates', async () => {
    serve({
      '/api/v1/health': HEALTH,
      '/api/v1/todos': [],
      '/auth/onboarding': {
        state: 'ready',
        org: { id: 'org-1', name: 'Acme', slug: 'acme', createdAt: '2026-08-07T00:00:00.000Z' },
        team: { id: 'team-1', orgId: 'org-1', name: 'General', slug: 'general' },
        role: 'owner',
        hasProjects: true,
      },
    })
    renderShell()

    await waitFor(() => expect(repoChip()).not.toBeNull())
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(document.querySelector('[data-slot="sidebar"]')).not.toBeNull()
  })
})
