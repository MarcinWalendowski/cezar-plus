import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { Team } from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'

import { TeamsSection } from './teams-section'

/**
 * Global settings → Teams (D2/D12, spec `.ai/specs/2026-08-06-org-team-auth-onboarding.md`,
 * Phase 5c). Driven through a stubbed `fetch`, same house style as `onboarding.test.tsx` — the
 * request each action actually puts on the wire is half of what the action is.
 *
 * `TeamsSection` is rendered directly (not through `registry.tsx`/`routes.tsx`'s own routing), the
 * same choice `onboarding.test.tsx` makes for `OnboardingRoute`: it is the real, public component,
 * dynamic `import()` and all — `Suspense`'s fallback resolves before any assertion needs it, via
 * `findBy*`'s built-in wait.
 */

interface SentRequest {
  path: string
  method: string
  body?: unknown
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** What `resolveGetRequest` (`server/static-ui.ts`) answers for ANY unmatched GET, including
 *  `/auth/teams` when `CEZ_AUTH` is unset and the `/auth/*` family was never registered — the
 *  exact shape `teams-api.ts#probeTeams` reads as the auth-off signal. */
const spaShellResponse = () =>
  new Response('<!doctype html><html><body>cezar</body></html>', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })

const TEAM_ENG: Team = { id: 'team-eng', orgId: 'org-1', name: 'Engineering', slug: 'engineering' }
const TEAM_MKT: Team = { id: 'team-mkt', orgId: 'org-1', name: 'Marketing', slug: 'marketing' }

type Answers = {
  /** A fixed list answer, overriding the mutable default entirely (used for auth-off/error/401
   *  cases, where no create/rename in the same test needs to see a persisted change). */
  list?: () => Response
  create?: (body: unknown) => Response
  rename?: (teamId: string, body: unknown) => Response
}

/**
 * Records every request and serves the fixtures, with per-test overrides — same shape as
 * `onboarding.test.tsx#stubFetch`. Unlike that one, `GET /auth/teams`'s DEFAULT answer reads from
 * a mutable roster that `POST`/`PATCH` write into, so a refetch after create/rename (this pane
 * invalidates the list query on both) actually reflects the change — a server round-trip, not a
 * frozen fixture.
 */
function stubFetch({ list, create, rename }: Answers = {}): SentRequest[] {
  const sent: SentRequest[] = []
  const roster: Team[] = [{ ...TEAM_ENG }, { ...TEAM_MKT }]
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)
      const path = url.split('?')[0]!
      const method = init.method ?? 'GET'
      const body = init.body === undefined ? undefined : JSON.parse(String(init.body))
      sent.push({ path: url, method, body })

      if (method === 'GET' && path === '/auth/teams') return list ? list() : jsonResponse({ teams: roster })
      if (method === 'POST' && path === '/auth/teams') {
        if (create) return create(body)
        const team: Team = { id: 'team-new', orgId: 'org-1', ...(body as Omit<Team, 'id' | 'orgId'>) }
        roster.push(team)
        return jsonResponse({ team })
      }
      if (method === 'PATCH' && path.startsWith('/auth/teams/')) {
        const teamId = decodeURIComponent(path.slice('/auth/teams/'.length))
        if (rename) return rename(teamId, body)
        const existing = roster.find((t) => t.id === teamId)
        if (!existing) return jsonResponse({ error: `unknown team: ${teamId}` }, 404)
        Object.assign(existing, body as Partial<Team>)
        return jsonResponse({ team: existing })
      }
      return jsonResponse({ error: `unmocked ${method} ${url}` }, 404)
    }),
  )
  return sent
}

function renderTeams() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <TeamsSection />
      <Toaster />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

describe('CEZ_AUTH unset — the surface is inert', () => {
  it('renders the auth-off explainer and never asks for anything past the one probe', async () => {
    const sent = stubFetch({ list: spaShellResponse })
    renderTeams()

    await screen.findByText("Sign-in isn't set up on this deployment", {}, { timeout: 5000 })

    // No sign-in link, no create form, no table — none of the pane's machinery mounted at all.
    expect(screen.queryByRole('link', { name: 'Sign in' })).toBeNull()
    expect(screen.queryByLabelText('Name')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Create team' })).toBeNull()

    // Give any errant follow-up request a chance to land before asserting none did.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sent).toEqual([{ path: '/auth/teams', method: 'GET', body: undefined }])
  })
})

describe('signed out', () => {
  it('shows a real <a href> to /auth/login, not a client-side navigation', async () => {
    stubFetch({ list: () => jsonResponse({ error: 'unauthenticated' }, 401) })
    renderTeams()

    await screen.findByText('Sign in to manage teams', {}, { timeout: 5000 })
    const link = screen.getByRole('link', { name: 'Sign in' })
    expect(link.getAttribute('href')).toBe('/auth/login')
  })
})

describe('listing teams', () => {
  it('renders every team with its name and slug', async () => {
    stubFetch()
    renderTeams()

    // Widened past the default 1000ms: `TeamsSection` adds a dynamic `import()` hop
    // (`teams-section.tsx`'s own doc comment) ahead of the query itself, and a busy test run can
    // make that hop alone take longer than the default.
    await waitFor(() => expect(document.querySelectorAll('[data-slot="team-row"]')).toHaveLength(2), {
      timeout: 5000,
    })
    const eng = document.querySelector('[data-slot="team-row"][data-team="team-eng"]')!
    expect(eng.textContent).toContain('Engineering')
    expect(eng.textContent).toContain('engineering')
  })

  it('shows the empty state when the org has no teams', async () => {
    stubFetch({ list: () => jsonResponse({ teams: [] }) })
    renderTeams()
    await screen.findByText('No teams yet.', {}, { timeout: 5000 })
  })

  it('surfaces a genuine fetch failure distinctly from auth-off', async () => {
    stubFetch({ list: () => jsonResponse({ error: 'boom' }, 500) })
    renderTeams()
    // A 500 retries once (`query-client.ts`'s default retry policy) before settling into the
    // error state, the same reason `onboarding.test.tsx`'s equivalent test widens this timeout.
    await screen.findByText('Could not load teams', {}, { timeout: 5000 })
    expect(screen.getByText('boom')).not.toBeNull()
  })
})

describe('creating a team', () => {
  it('POSTs name and slug, clears the form, and refreshes the list', async () => {
    const sent = stubFetch({
      create: (body) => jsonResponse({ team: { id: 'team-design', orgId: 'org-1', ...(body as object) } }),
    })
    renderTeams()
    // Widened past the default 1000ms: `TeamsSection` adds a dynamic `import()` hop
    // (`teams-section.tsx`'s own doc comment) ahead of the query itself, and a busy test run can
    // make that hop alone take longer than the default.
    await waitFor(() => expect(document.querySelectorAll('[data-slot="team-row"]')).toHaveLength(2), {
      timeout: 5000,
    })

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Design' } })
    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'design' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create team' }))

    await waitFor(() =>
      expect(sent.filter((r) => r.method === 'POST' && r.path === '/auth/teams')).toEqual([
        { path: '/auth/teams', method: 'POST', body: { name: 'Design', slug: 'design' } },
      ]),
    )
    // The list refetches — a second GET after the one on mount.
    await waitFor(() => expect(sent.filter((r) => r.method === 'GET' && r.path === '/auth/teams').length).toBe(2))
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('Slug') as HTMLInputElement).value).toBe('')
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Design'))
  })

  it('the Create button stays disabled until both fields are non-empty', async () => {
    stubFetch()
    renderTeams()
    // Widened past the default 1000ms: `TeamsSection` adds a dynamic `import()` hop
    // (`teams-section.tsx`'s own doc comment) ahead of the query itself, and a busy test run can
    // make that hop alone take longer than the default.
    await waitFor(() => expect(document.querySelectorAll('[data-slot="team-row"]')).toHaveLength(2), {
      timeout: 5000,
    })

    const submit = screen.getByRole('button', { name: 'Create team' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Design' } })
    expect(submit.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'design' } })
    expect(submit.disabled).toBe(false)
  })

  it('a non-admin gets the server 403 verbatim, inline, and the form keeps its values', async () => {
    stubFetch({ create: () => jsonResponse({ error: 'only an owner or admin may create a team' }, 403) })
    renderTeams()
    // Widened past the default 1000ms: `TeamsSection` adds a dynamic `import()` hop
    // (`teams-section.tsx`'s own doc comment) ahead of the query itself, and a busy test run can
    // make that hop alone take longer than the default.
    await waitFor(() => expect(document.querySelectorAll('[data-slot="team-row"]')).toHaveLength(2), {
      timeout: 5000,
    })

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Design' } })
    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'design' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create team' }))

    await waitFor(() =>
      expect(document.querySelector('[data-slot="teams-create-error"]')?.textContent).toBe(
        'only an owner or admin may create a team',
      ),
    )
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Design')
  })
})

describe('renaming a team', () => {
  it('PATCHes the new name and shows it without a page reload', async () => {
    const sent = stubFetch()
    renderTeams()
    // Widened past the default 1000ms: `TeamsSection` adds a dynamic `import()` hop
    // (`teams-section.tsx`'s own doc comment) ahead of the query itself, and a busy test run can
    // make that hop alone take longer than the default.
    await waitFor(() => expect(document.querySelectorAll('[data-slot="team-row"]')).toHaveLength(2), {
      timeout: 5000,
    })

    const row = document.querySelector('[data-slot="team-row"][data-team="team-eng"]')!
    fireEvent.click(row.querySelector('[data-action="team-rename"]')!)
    const input = row.querySelector('[data-slot="team-rename-name"]') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Core Engineering' } })
    fireEvent.click(row.querySelector('[data-action="team-rename-save"]')!)

    await waitFor(() =>
      expect(sent.filter((r) => r.method === 'PATCH')).toEqual([
        { path: '/auth/teams/team-eng', method: 'PATCH', body: { name: 'Core Engineering' } },
      ]),
    )
    await waitFor(() => expect(row.textContent).toContain('Core Engineering'))
    // Editing closed — no lingering Save/Cancel affordance on this row.
    expect(row.querySelector('[data-action="team-rename-save"]')).toBeNull()
  })

  it('Cancel discards the edit and fires no request', async () => {
    const sent = stubFetch()
    renderTeams()
    // Widened past the default 1000ms: `TeamsSection` adds a dynamic `import()` hop
    // (`teams-section.tsx`'s own doc comment) ahead of the query itself, and a busy test run can
    // make that hop alone take longer than the default.
    await waitFor(() => expect(document.querySelectorAll('[data-slot="team-row"]')).toHaveLength(2), {
      timeout: 5000,
    })

    const row = document.querySelector('[data-slot="team-row"][data-team="team-eng"]')!
    fireEvent.click(row.querySelector('[data-action="team-rename"]')!)
    fireEvent.change(row.querySelector('[data-slot="team-rename-name"]')!, { target: { value: 'Whatever' } })
    fireEvent.click(row.querySelector('[data-action="team-rename-cancel"]')!)

    expect(row.textContent).toContain('Engineering')
    expect(sent.filter((r) => r.method === 'PATCH')).toEqual([])
  })

  it('same-name save closes editing without a request', async () => {
    const sent = stubFetch()
    renderTeams()
    // Widened past the default 1000ms: `TeamsSection` adds a dynamic `import()` hop
    // (`teams-section.tsx`'s own doc comment) ahead of the query itself, and a busy test run can
    // make that hop alone take longer than the default.
    await waitFor(() => expect(document.querySelectorAll('[data-slot="team-row"]')).toHaveLength(2), {
      timeout: 5000,
    })

    const row = document.querySelector('[data-slot="team-row"][data-team="team-eng"]')!
    fireEvent.click(row.querySelector('[data-action="team-rename"]')!)
    fireEvent.click(row.querySelector('[data-action="team-rename-save"]')!)

    expect(sent.filter((r) => r.method === 'PATCH')).toEqual([])
    expect(row.querySelector('[data-action="team-rename-save"]')).toBeNull()
  })
})
