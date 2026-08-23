import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { HealthResponse, WorkspaceGitResponse } from '@loki-labs/better-cezar-api-client'

import { WorkspaceGitRoute } from './workspace-git'

/**
 * `/workspace/git` (`.ai/specs/2026-08-14-cross-project-git-overview.md`, Phase 2). Rendered
 * directly (not through `AppRoutes`) since this route mounts OUTSIDE `ProjectScopeRoute` and
 * needs no `:projectId` param to resolve — the same reasoning `workspace-tasks.test.tsx` states
 * for its own board.
 */

interface SentRequest {
  path: string
  method: string
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

const GIT_RESPONSE: WorkspaceGitResponse = {
  projects: [
    {
      id: 'boot',
      name: 'boot',
      ok: true,
      branch: 'main',
      dirty: { staged: 0, unstaged: 0, untracked: 0 },
      head: { hash: 'abc1234', subject: 'Fix the flaky retry test', author: 't', when: '2 hours ago' },
    },
    {
      id: 'shop',
      name: 'Shop',
      ok: true,
      branch: 'feature/checkout',
      upstream: 'origin/feature/checkout',
      ahead: 2,
      behind: 0,
      dirty: { staged: 1, unstaged: 2, untracked: 3 },
      head: { hash: 'def5678', subject: 'Ship the storefront', author: 't', when: '1 day ago' },
    },
  ],
  bootProject: 'boot',
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Fetch stub in the house style (`workspace-tasks.test.tsx`): records every request and serves
 *  the fixtures, with per-test overrides. */
function stubFetch({
  healthResponse = health(),
  gitResponse = GIT_RESPONSE,
}: {
  healthResponse?: HealthResponse
  gitResponse?: WorkspaceGitResponse
} = {}): SentRequest[] {
  const sent: SentRequest[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)
      const path = url.split('?')[0]!
      const method = init.method ?? 'GET'
      sent.push({ path, method })
      if (method === 'GET' && path === '/api/v1/health') return jsonResponse(healthResponse)
      if (method === 'GET' && path === '/api/v1/workspace/git') return jsonResponse(gitResponse)
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

function renderAt(entry = '/workspace/git') {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <WorkspaceGitRoute />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function list(): HTMLElement {
  const el = document.querySelector('[data-testid="workspace-git-list"]')
  if (!el) throw new Error('the workspace git list has not rendered yet')
  return el as HTMLElement
}

async function findInList(text: string): Promise<HTMLElement> {
  return await waitFor(() => within(list()).getByText(text))
}

function rowFor(projectId: string): HTMLElement {
  const row = list().querySelector(`[data-project-id="${projectId}"]`)
  if (!row) throw new Error(`no row for project ${projectId}`)
  return row as HTMLElement
}

describe('capability gating', () => {
  it('capability off renders the disabled state, never a crash and never a fake "no repos" claim', async () => {
    stubFetch({ healthResponse: health({ capabilities: { ...CAPABILITIES_ON, workspaceViews: false } }) })
    renderAt()
    await screen.findByText('The workspace git overview is off')
    expect(screen.queryByTestId('workspace-git-list')).toBeNull()
  })

  it('capability on renders the row list', async () => {
    stubFetch()
    renderAt()
    await findInList('boot')
    await findInList('Shop')
  })
})

describe('the scope trap', () => {
  it('never issues a request to a project-scoped endpoint', async () => {
    const sent = stubFetch()
    renderAt()
    await findInList('boot')
    await findInList('Shop')
    expect(sent.some((r) => r.path.startsWith('/api/v1/p/'))).toBe(false)
    // Sanity: it DID talk to the workspace-level surface, so the assertion above is not vacuous.
    expect(sent.some((r) => r.path.startsWith('/api/v1/workspace/git'))).toBe(true)
  })

  /**
   * The `/api/v1/p/` prefix check above is necessary but not sufficient: a project-scoped client
   * call made with NO `ProjectScopeProvider` mounted (this page's real situation — it lives
   * outside `ProjectScopeRoute`) does not go out as `/api/v1/p/<id>/…`. `apiPath()`
   * (`api-client/src/utils/project-scope.ts`) only adds the `/p/<id>` segment when a scope
   * provider has written one; with none mounted the request goes out UNSCOPED — e.g. `useRepo()`
   * calls `/api/v1/repo`, no `/p/` anywhere in it — and the server's own "no prefix" convention
   * answers with the BOOT project's data. That is the scope trap in its actual client-side shape:
   * a plain, unprefixed project route hit from a page that never named which project it meant.
   * So the real contract is an ALLOWLIST of the two workspace-level paths this page is permitted
   * to call, not a blocklist of one URL shape a scoped call happens to sometimes take.
   */
  it('requests only the workspace-level surface — an allowlist, not a `/p/` blocklist', async () => {
    const sent = stubFetch()
    renderAt()
    await findInList('boot')
    await findInList('Shop')
    const paths = new Set(sent.map((r) => r.path))
    const allowed = new Set(['/api/v1/health', '/api/v1/workspace/git'])
    for (const path of paths) expect(allowed.has(path)).toBe(true)
    // Sanity: the allowlist itself was exercised, so the loop above is not vacuously true.
    expect(paths.has('/api/v1/workspace/git')).toBe(true)
  })
})

describe('a failed project', () => {
  it('renders as a visible row carrying its reason — never filtered out, never a footnote', async () => {
    stubFetch({
      gitResponse: {
        projects: [
          { id: 'boot', name: 'boot', ok: true, branch: 'main', dirty: { staged: 0, unstaged: 0, untracked: 0 } },
          { id: 'gone', name: 'Gone Repo', ok: false, reason: 'root not found' },
        ],
        bootProject: 'boot',
      },
    })
    renderAt()
    await findInList('boot')
    // The row itself must exist and must carry its reason — not be absent, not be summarized
    // into a count elsewhere.
    const row = rowFor('gone')
    expect(row.getAttribute('data-ok')).toBe('false')
    expect(within(row).getByText('Gone Repo')).toBeTruthy()
    expect(within(row).getByText('root not found')).toBeTruthy()
    // And it must not have quietly shrunk the rest of the list.
    expect(list().querySelectorAll('[data-project-id]')).toHaveLength(2)
  })
})

describe('ahead/behind: absent renders differently from 0', () => {
  it('no upstream at all renders no sync status', async () => {
    stubFetch({
      gitResponse: {
        projects: [{ id: 'boot', name: 'boot', ok: true, branch: 'main', dirty: { staged: 0, unstaged: 0, untracked: 0 } }],
        bootProject: 'boot',
      },
    })
    renderAt()
    await findInList('boot')
    const row = rowFor('boot')
    expect(row.querySelector('[data-slot="workspace-git-sync"]')).toBeNull()
  })

  it('an upstream that is level (0/0) renders "up to date" — not nothing, not the no-upstream case', async () => {
    stubFetch({
      gitResponse: {
        projects: [
          {
            id: 'boot',
            name: 'boot',
            ok: true,
            branch: 'main',
            upstream: 'origin/main',
            ahead: 0,
            behind: 0,
            dirty: { staged: 0, unstaged: 0, untracked: 0 },
          },
        ],
        bootProject: 'boot',
      },
    })
    renderAt()
    await findInList('boot')
    const row = rowFor('boot')
    const sync = row.querySelector('[data-slot="workspace-git-sync"]')
    expect(sync).not.toBeNull()
    expect(sync!.textContent).toBe('up to date')
  })

  it('a nonzero ahead renders the count, distinct from both other states', async () => {
    stubFetch()
    renderAt()
    await findInList('Shop')
    const row = rowFor('shop')
    const sync = row.querySelector('[data-slot="workspace-git-sync"]')
    expect(sync).not.toBeNull()
    expect(sync!.textContent).toBe('↑2')
    expect(sync!.textContent).not.toBe('up to date')
  })

  it('an upstream reported [gone] (upstream named, no counts) renders no sync status, same as no upstream', async () => {
    stubFetch({
      gitResponse: {
        projects: [
          {
            id: 'boot',
            name: 'boot',
            ok: true,
            branch: 'main',
            upstream: 'origin/main',
            dirty: { staged: 0, unstaged: 0, untracked: 0 },
          },
        ],
        bootProject: 'boot',
      },
    })
    renderAt()
    await findInList('boot')
    const row = rowFor('boot')
    expect(row.querySelector('[data-slot="workspace-git-sync"]')).toBeNull()
  })
})

describe('dirty summary', () => {
  it('a clean tree renders "clean"', async () => {
    stubFetch()
    renderAt()
    await findInList('boot')
    const row = rowFor('boot')
    expect(row.querySelector('[data-slot="workspace-git-dirty"]')?.textContent).toBe('clean')
  })

  it('staged/unstaged/untracked render as separate counts, not one collapsed total', async () => {
    stubFetch()
    renderAt()
    await findInList('Shop')
    const row = rowFor('shop')
    const text = row.querySelector('[data-slot="workspace-git-dirty"]')?.textContent
    expect(text).toBe('1 staged · 2 unstaged · 3 untracked')
  })
})

describe('row links', () => {
  it("an ok row links into that project's own git tab, never a bare /git", async () => {
    stubFetch()
    renderAt()
    await findInList('Shop')
    const row = rowFor('shop')
    const link = within(row).getByRole('link')
    expect(link.getAttribute('href')).toBe('/p/shop/git')
  })

  it('a failed row is not a link — nothing on the other side is worth a click', async () => {
    stubFetch({
      gitResponse: {
        projects: [{ id: 'gone', name: 'Gone Repo', ok: false, reason: 'root not found' }],
        bootProject: 'boot',
      },
    })
    renderAt()
    await findInList('Gone Repo')
    const row = rowFor('gone')
    expect(within(row).queryByRole('link')).toBeNull()
  })
})

describe('empty registry', () => {
  it('renders an honest empty state when the flag is on but nothing is registered', async () => {
    stubFetch({ gitResponse: { projects: [], bootProject: 'boot' } })
    renderAt()
    await screen.findByText('No projects registered')
  })
})
