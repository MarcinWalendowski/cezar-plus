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

/** What `resolveGetRequest` (`server/static-ui.ts`) answers for ANY unmatched GET — still what a
 *  HOSTED, unauthenticated deployment (`CEZ_ALLOW_UNAUTHENTICATED=1`, D9) answers for
 *  `/auth/teams`, since D13 (spec phase 9) never mounts local mode's `/auth/teams` there either.
 *  The npm zero-config default (loopback, `CEZ_AUTH` unset) answers real JSON now, once the local
 *  user has an org (see the `describe('D13 local mode …')` blocks below) — the exact shape
 *  `teams-api.ts#probeTeams` reads as `{ kind: 'unavailable' }` (renamed from `auth-off`, FIX C4 —
 *  a hosted-unauthenticated deployment mounts no `/auth/*` surface at all, `CEZ_AUTH` on or off
 *  makes no difference there) is therefore reachable only on that one narrower, hosted topology
 *  now. */
const spaShellResponse = () =>
  new Response('<!doctype html><html><body>cezar</body></html>', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })

const TEAM_ENG: Team = { id: 'team-eng', orgId: 'org-1', name: 'Engineering', slug: 'engineering' }
const TEAM_MKT: Team = { id: 'team-mkt', orgId: 'org-1', name: 'Marketing', slug: 'marketing' }

type Answers = {
  /** A fixed list answer, overriding the mutable default entirely (used for unavailable/no-org/
   *  error/401 cases, where no create/rename in the same test needs to see a persisted change). */
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

describe('no onboarding surface at all (hosted, unauthenticated) — the pane is inert', () => {
  it('renders the unavailable explainer and never asks for anything past the one probe', async () => {
    const sent = stubFetch({ list: spaShellResponse })
    renderTeams()

    await screen.findByText("Sign-in isn't set up on this deployment", {}, { timeout: 5000 })

    // No sign-in link, no create form, no table — none of the pane's machinery mounted at all.
    expect(screen.queryByRole('link', { name: 'Sign in' })).toBeNull()
    expect(screen.queryByLabelText('Name')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Create workspace' })).toBeNull()

    // Give any errant follow-up request a chance to land before asserting none did.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sent).toEqual([{ path: '/auth/teams', method: 'GET', body: undefined }])
  })
})

describe('signed out', () => {
  it('shows a real <a href> to /auth/login, not a client-side navigation', async () => {
    stubFetch({ list: () => jsonResponse({ error: 'unauthenticated' }, 401) })
    renderTeams()

    await screen.findByText('Sign in to manage workspaces', {}, { timeout: 5000 })
    const link = screen.getByRole('link', { name: 'Sign in' })
    expect(link.getAttribute('href')).toBe('/auth/login')
  })
})

/**
 * ADDED 2026-08-07 (D13 cockpit pass). Before D13, `GET /auth/teams` with `CEZ_AUTH` unset always
 * fell through to the SPA shell (the `describe` above) — there was no local-org state to reach.
 * D13 mounts a real `/auth/teams` for the npm zero-config default once a local org exists (or is
 * still missing), so the pane now has two more REAL states to reach on that exact topology: the
 * ordinary "an org with teams" case (already covered below, wire-shape-identical to an
 * authenticated deployment's) and the local "no organization exists yet" precondition
 * (`team-routes.ts`'s own D13 branch: 400, never 401 — invariant 1, no 401 in local mode, ever).
 *
 * **CORRECTED 2026-08-07 (second adversarial review, FIX C3): the paragraph this replaces said
 * `probeTeams` "has no THIRD state for that precondition" and folds it into the pane's generic
 * error state — that was the bug, not a documented limitation.** A 400 that means "no org exists
 * yet" is not a fetch failure: it is the ordinary, expected shape of the zero-config default, so
 * folding it into `tone="danger"` "Could not load workspaces" put a RED ERROR CARD on the
 * product's default deployment mode. `TeamsProbe` (`teams-api.ts`) now has a real third state,
 * `no-org`, and the pane renders it as a neutral empty state.
 *
 * **CORRECTED AGAIN 2026-08-07 (D14, owner decision): the "way back into the wizard" this
 * paragraph used to describe is gone.** FIX C1's "Create an organization" link existed only
 * because D13's now-deleted "decline" behaviour (`onboarding-decline.ts`) could otherwise strand a
 * browser on this state forever. D14 reverses that — the cockpit is gated on onboarding
 * (`app-shell-container.tsx`'s `chromeless`), so Settings cannot render at all while no org
 * exists; `routes.tsx#OnboardingEntryGate` gets there first. This state is now defensive rather
 * than ordinarily reachable, and the test below pins its NEW shape: no link, still no danger card.
 */
describe('D13 local mode: the pane is real, not inert, once /auth/teams is mounted', () => {
  it('a local org with teams renders exactly like an authenticated one — same wire shape, same component', async () => {
    stubFetch()
    renderTeams()

    await waitFor(() => expect(document.querySelectorAll('[data-slot="team-row"]')).toHaveLength(2), {
      timeout: 5000,
    })
    const eng = document.querySelector('[data-slot="team-row"][data-team="team-eng"]')!
    expect(eng.textContent).toContain('Engineering')
  })

  it('no local org yet: a neutral, actionless empty state — never the danger card, never the sign-in screen, and no re-entry link (D14)', async () => {
    stubFetch({ list: () => jsonResponse({ error: 'no organization exists yet' }, 400) })
    renderTeams()

    await screen.findByText('No organization yet', {}, { timeout: 5000 })
    // Not the generic fetch-failure card this precondition used to fall into.
    expect(screen.queryByText('Could not load workspaces')).toBeNull()
    // Not the sign-in screen either: this caller genuinely is who they say they are (D13 invariant 1).
    expect(screen.queryByText('Sign in to manage workspaces')).toBeNull()
    // D14: no link back into `/onboarding` — the cockpit-level gate is what routes a user there
    // now, not a Settings affordance that made a deleted "decline" reversible.
    expect(screen.queryByRole('link', { name: 'Create an organization' })).toBeNull()
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
    await screen.findByText('No workspaces yet.', {}, { timeout: 5000 })
  })

  it('surfaces a genuine fetch failure distinctly from auth-off', async () => {
    stubFetch({ list: () => jsonResponse({ error: 'boom' }, 500) })
    renderTeams()
    // A 500 retries once (`query-client.ts`'s default retry policy) before settling into the
    // error state, the same reason `onboarding.test.tsx`'s equivalent test widens this timeout.
    await screen.findByText('Could not load workspaces', {}, { timeout: 5000 })
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
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }))

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

    const submit = screen.getByRole('button', { name: 'Create workspace' }) as HTMLButtonElement
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
    fireEvent.click(screen.getByRole('button', { name: 'Create workspace' }))

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
