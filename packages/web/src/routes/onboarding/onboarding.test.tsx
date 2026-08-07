import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { FsBrowseResponse, Org, Role, Team } from '@open-mercato/cezar-api-client'

import { OnboardingRoute } from './onboarding'

/**
 * `/onboarding` (D8, spec `.ai/specs/2026-08-06-org-team-auth-onboarding.md`, phase 4). Driven
 * through a stubbed `fetch`, in the house style (`workspace-tasks.test.tsx`,
 * `add-project-dialog.test.tsx`): the request the wizard actually puts on the wire is half of
 * what each step is, and a mocked client would only assert the component's intent.
 */

interface SentRequest {
  path: string
  method: string
  body?: unknown
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** What `resolveGetRequest` (`server/static-ui.ts`) answers for ANY unmatched GET, including
 *  `/auth/onboarding` when `CEZ_AUTH` is unset and the `/auth/*` family was never registered —
 *  the exact shape `onboarding-api.ts` reads as the auth-off signal. */
const spaShellResponse = () =>
  new Response('<!doctype html><html><body>cezar</body></html>', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })

const ORG: Org = { id: 'org-1', name: 'Acme', slug: 'acme', createdAt: '2026-08-07T00:00:00.000Z' }
const TEAM: Team = { id: 'team-1', orgId: 'org-1', name: 'General', slug: 'general' }
const ROLE: Role = 'owner'

const HOME: FsBrowseResponse = {
  path: '/home/me',
  parent: null,
  dirs: [{ name: 'proj', path: '/home/me/proj', isRepo: true }],
  truncated: false,
}

type Answers = {
  onboarding?: () => Response
  createOrg?: (body: unknown) => Response
  renameTeam?: (body: unknown) => Response
  /** Keyed by the `path` query value, `''` is the browse root — a FUNCTION per path, called
   *  fresh on every request, since a `Response` body can only be read once (`Response.clone()`
   *  is what `add-project-dialog.test.tsx`'s own stub relies on for the same reason). */
  browse?: Record<string, () => Response>
  register?: (body: unknown) => Response
}

/** Records every request and serves the fixtures, with per-test overrides — same shape as
 *  `workspace-tasks.test.tsx#stubFetch`. */
function stubFetch({
  onboarding = () => jsonResponse({ error: 'unauthenticated' }, 401),
  createOrg,
  renameTeam,
  browse = { '': () => jsonResponse(HOME) },
  register,
}: Answers = {}): SentRequest[] {
  const sent: SentRequest[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)
      const path = url.split('?')[0]!
      const method = init.method ?? 'GET'
      const body = init.body === undefined ? undefined : JSON.parse(String(init.body))
      sent.push({ path: url, method, body })

      if (method === 'GET' && path === '/auth/onboarding') return onboarding()
      if (method === 'POST' && path === '/auth/onboarding/org') {
        return createOrg
          ? createOrg(body)
          : jsonResponse({ org: ORG, team: TEAM, role: ROLE })
      }
      if (method === 'PATCH' && path === '/auth/onboarding/team') {
        return renameTeam
          ? renameTeam(body)
          : jsonResponse({ team: { ...TEAM, name: (body as { name: string }).name } })
      }
      if (method === 'GET' && path === '/api/v1/fs/browse') {
        const answer = browse[new URL(url, 'http://onboarding.test').searchParams.get('path') ?? '']
        return answer ? answer() : jsonResponse({ error: 'unexpected browse path' }, 500)
      }
      if (method === 'GET' && path === '/api/v1/projects') {
        return jsonResponse({ projects: [], bootProject: 'cezar', projectsDir: '~/cezar/projects' })
      }
      if (method === 'POST' && path === '/api/v1/projects') {
        return register
          ? register(body)
          : jsonResponse({ project: { id: 'added', name: 'proj', root: '/home/me/proj', addedAt: '', lastOpenedAt: '', source: 'local', status: 'ok' } })
      }
      return jsonResponse({ error: `unmocked ${method} ${url}` }, 404)
    }),
  )
  return sent
}

function LocationProbe() {
  return <output data-testid="location">{useLocation().pathname}</output>
}

function renderAt(entry = '/onboarding') {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <OnboardingRoute />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  // AddProjectDialog renders through Radix Dialog; same jsdom shims `add-project-dialog.test.tsx`
  // and `workspace-tasks.test.tsx` already establish for their own Radix surfaces.
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

describe('CEZ_AUTH unset — the surface is inert', () => {
  it('renders the auth-off explainer and never asks for anything past the one probe', async () => {
    const sent = stubFetch({ onboarding: spaShellResponse })
    renderAt()

    await screen.findByText("Sign-in isn't set up on this deployment")

    // No sign-in link, no org form, no team form, no add-project affordance — none of the
    // wizard's step machinery mounted at all.
    expect(screen.queryByRole('link', { name: 'Sign in' })).toBeNull()
    expect(screen.queryByLabelText('Organization name')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add project' })).toBeNull()

    // Give any errant follow-up request a chance to land before asserting none did.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sent).toEqual([{ path: '/auth/onboarding', method: 'GET', body: undefined }])
  })
})

describe('signed out', () => {
  it('shows a real <a href> to /auth/login, not a client-side navigation', async () => {
    stubFetch({ onboarding: () => jsonResponse({ error: 'unauthenticated' }, 401) })
    renderAt()

    await screen.findByText('Sign in to set up your organization')
    const link = screen.getByRole('link', { name: 'Sign in' })
    expect(link.getAttribute('href')).toBe('/auth/login')
  })
})

describe('needs-org: name → accept team → add projects', () => {
  it('pre-fills the suggested name, creates the org, and accepting the team unchanged makes no PATCH call', async () => {
    const sent = stubFetch({
      onboarding: () =>
        // `bootstrapTokenRequired: false` is the CEZ_AUTH_BOOTSTRAP_OPEN deployment — the
        // single-field form. The required-code variant has its own test below.
        jsonResponse({ state: 'needs-org', suggestedOrgName: 'Acme', bootstrapTokenRequired: false }),
    })
    renderAt()

    const nameInput = await screen.findByLabelText('Organization name')
    expect((nameInput as HTMLInputElement).value).toBe('Acme')

    fireEvent.click(screen.getByRole('button', { name: 'Create organization' }))
    await waitFor(() =>
      expect(sent.some((r) => r.method === 'POST' && r.path === '/auth/onboarding/org')).toBe(true),
    )
    expect(sent.find((r) => r.path === '/auth/onboarding/org')?.body).toEqual({ name: 'Acme' })

    // 5s, not `findBy*`'s 1000ms default: this step is reached only after the POST resolves and
    // two state transitions render, and under a loaded full-suite run that budget was not
    // reliably met — the test flaked 1 in 24 full-suite runs at review, failing here with the
    // create-org screen still on screen. A longer wait for the SAME assertion, not a weaker one.
    const teamInput = await screen.findByLabelText('Team name', {}, { timeout: 5000 })
    expect((teamInput as HTMLInputElement).value).toBe('General')

    fireEvent.click(screen.getByRole('button', { name: 'Accept and continue' }))
    await screen.findByText('Add your first project')

    // The whole point of "one click": an unedited accept never touches the network.
    expect(sent.some((r) => r.path === '/auth/onboarding/team')).toBe(false)
  })

  it('renaming the team before accepting sends the PATCH and carries the new name forward', async () => {
    const sent = stubFetch({
      onboarding: () => jsonResponse({ state: 'needs-org', bootstrapTokenRequired: false }),
    })
    renderAt()

    const nameInput = await screen.findByLabelText('Organization name')
    fireEvent.change(nameInput, { target: { value: 'Widgets Inc' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create organization' }))

    const teamInput = await screen.findByLabelText('Team name', {}, { timeout: 5000 })
    fireEvent.change(teamInput, { target: { value: 'Engineering' } })
    fireEvent.click(screen.getByRole('button', { name: 'Accept and continue' }))

    await waitFor(() =>
      expect(sent.some((r) => r.method === 'PATCH' && r.path === '/auth/onboarding/team')).toBe(true),
    )
    expect(sent.find((r) => r.path === '/auth/onboarding/team')?.body).toEqual({ name: 'Engineering' })
    await screen.findByText(/Engineering/)
  })
})

describe('the bootstrap claim (who may be first)', () => {
  it('asks for the code the server said it wants, refuses to submit without it, and sends it', async () => {
    const sent = stubFetch({
      onboarding: () => jsonResponse({ state: 'needs-org', suggestedOrgName: 'Acme', bootstrapTokenRequired: true }),
    })
    renderAt()

    await screen.findByLabelText('Organization name')
    const code = screen.getByLabelText('Bootstrap code')
    const submit = screen.getByRole('button', { name: 'Create organization' }) as HTMLButtonElement
    // A pre-filled org name is not enough on its own — the point of the code is that arriving
    // first is not permission to own the deployment's shell.
    expect(submit.disabled).toBe(true)

    fireEvent.change(code, { target: { value: 'c0de-from-the-boot-log' } })
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)

    await waitFor(() =>
      expect(sent.some((r) => r.method === 'POST' && r.path === '/auth/onboarding/org')).toBe(true),
    )
    expect(sent.find((r) => r.path === '/auth/onboarding/org')?.body).toEqual({
      name: 'Acme',
      bootstrapToken: 'c0de-from-the-boot-log',
    })
  })

  it('assumes a code IS required when the server says nothing — the safe default, not the convenient one', async () => {
    stubFetch({ onboarding: () => jsonResponse({ state: 'needs-org' }) })
    renderAt()

    await screen.findByLabelText('Organization name')
    expect(screen.queryByLabelText('Bootstrap code')).not.toBeNull()
  })

  it('surfaces the server’s 403 verbatim rather than a generic failure', async () => {
    stubFetch({
      onboarding: () => jsonResponse({ state: 'needs-org', bootstrapTokenRequired: true }),
      createOrg: () =>
        jsonResponse(
          { error: 'this deployment needs its bootstrap code to create the first organization — it is printed in the server log at startup' },
          403,
        ),
    })
    renderAt()

    fireEvent.change(await screen.findByLabelText('Organization name'), { target: { value: 'Acme' } })
    fireEvent.change(screen.getByLabelText('Bootstrap code'), { target: { value: 'wrong' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create organization' }))

    await screen.findByText(/printed in the server log at startup/, {}, { timeout: 5000 })
  })
})

describe('needs-invite: the second user is told the truth, not shown a form they cannot submit', () => {
  it('renders the invite explainer and offers no org-creation field at all', async () => {
    const sent = stubFetch({ onboarding: () => jsonResponse({ state: 'needs-invite' }) })
    renderAt()

    await screen.findByText('You need an invite to join this deployment')
    // The defect this replaces: `needs-org` was reported to EVERY membership-less user, so the
    // second person to sign in was shown "Name your organization", typed a name, and was told
    // they needed an invite.
    expect(screen.queryByLabelText('Organization name')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Create organization' })).toBeNull()

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sent.filter((r) => r.method !== 'GET')).toEqual([])
  })
})

describe('ready: resumes straight to add-projects, and the team threads through registration', () => {
  it('sends an already-onboarded user straight on to / — hasProjects is what makes /auth/callback → /onboarding safe for everyone', async () => {
    stubFetch({
      onboarding: () => jsonResponse({ state: 'ready', org: ORG, team: TEAM, role: ROLE, hasProjects: true }),
    })
    renderAt()

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/'))
    // Not even a flash of the wizard's last step on the way out.
    expect(screen.queryByText('Add your first project')).toBeNull()
  })

  it('skips the org/team steps entirely when they already exist', async () => {
    stubFetch({ onboarding: () => jsonResponse({ state: 'ready', org: ORG, team: TEAM, role: ROLE }) })
    renderAt()

    await screen.findByText('Add your first project')
    expect(screen.queryByLabelText('Organization name')).toBeNull()
    expect(screen.queryByLabelText('Team name')).toBeNull()
  })

  it('"Skip for now" leaves without registering a project', async () => {
    stubFetch({ onboarding: () => jsonResponse({ state: 'ready', org: ORG, team: TEAM, role: ROLE }) })
    renderAt()

    await screen.findByRole('button', { name: 'Skip for now' })
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }))
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/'))
  })

  it('registering a project from the wizard sends the resolved team id, reusing AddProjectDialog', async () => {
    const sent = stubFetch({
      onboarding: () => jsonResponse({ state: 'ready', org: ORG, team: TEAM, role: ROLE }),
      browse: { '': () => jsonResponse(HOME) },
    })
    renderAt()

    fireEvent.click(await screen.findByRole('button', { name: 'Add project' }))
    // The same folder-browser dialog every other "Add project" entry point uses.
    await screen.findByText('Open local folder')
    const confirm = document.querySelector('[data-slot="add-project-confirm"]') as HTMLButtonElement
    await waitFor(() => expect(confirm.disabled).toBe(false))
    fireEvent.click(confirm)

    await waitFor(() =>
      expect(sent.some((r) => r.method === 'POST' && r.path === '/api/v1/projects')).toBe(true),
    )
    expect(sent.find((r) => r.method === 'POST' && r.path === '/api/v1/projects')?.body).toEqual({
      root: '/home/me',
      teamId: 'team-1',
    })
  })
})

describe('a genuine server error is not mistaken for auth-off', () => {
  it('shows a retry state rather than the inert explainer', async () => {
    stubFetch({ onboarding: () => jsonResponse({ error: 'auth is misconfigured: bad issuer' }, 500) })
    renderAt()

    // A 5xx retries once under `createQueryClient`'s default retry policy (`query-client.ts`)
    // before the query settles into its error state, which outlasts `findByText`'s default
    // 1000ms — a longer timeout here, not a shorter retry policy borrowed from elsewhere.
    await screen.findByText('Could not check sign-in status', {}, { timeout: 5000 })
    expect(screen.queryByText("Sign-in isn't set up on this deployment")).toBeNull()
  })
})
