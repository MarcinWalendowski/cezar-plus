import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'

import { AccountSection } from './account-section'

/**
 * Global settings → Account (D14, spec `.ai/specs/2026-08-06-org-team-auth-onboarding.md`) — same
 * house style as `teams-section.test.tsx`: `AccountSection` rendered directly (not through
 * `registry.tsx`/`routes.tsx`), a stubbed `fetch`, `findBy*`'s built-in wait absorbing the dynamic
 * `import()` hop ahead of `account-panel.tsx`'s query.
 *
 * The task's "Test both" is the two `probeAccountAvailable` outcomes named explicitly in D14: local
 * mode, where `authRoutes` (and so `/auth/me`) stay unmounted and the section must be absent, and a
 * hosted/authenticated deployment, where it is mounted and the section renders with a working
 * Sign out control that POSTs `/auth/logout`.
 */

interface SentRequest {
  path: string
  method: string
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** What `resolveGetRequest` (`server/static-ui.ts`) answers for ANY unmatched GET — local mode's
 *  shape for `/auth/me`, since D13 never mounts `authRoutes` there at all. */
const spaShellResponse = () =>
  new Response('<!doctype html><html><body>cezar</body></html>', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })

type Answers = {
  me?: () => Response
  logout?: () => Response
}

function stubFetch({ me, logout }: Answers = {}): SentRequest[] {
  const sent: SentRequest[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)
      const path = url.split('?')[0]!
      const method = init.method ?? 'GET'
      sent.push({ path, method })

      if (method === 'GET' && path === '/auth/me') return me ? me() : jsonResponse({ id: 'user-1' })
      if (method === 'POST' && path === '/auth/logout') return logout ? logout() : jsonResponse({ ok: true })
      return jsonResponse({ error: `unmocked ${method} ${url}` }, 404)
    }),
  )
  return sent
}

function renderAccount() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <AccountSection />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('local mode (no /auth/* mounted): no session to end', () => {
  // CORRECTED 2026-08-07 (same day this file was written). This block asserted the panel renders
  // NOTHING here, on the premise that "the section is absent". It is not absent: `registry.tsx`
  // declares it unconditionally, because `visibleSettingsSections`'s gates are synchronous and
  // there is no `auth` capability key to gate on (`capabilities.test.ts:213` forbids adding one).
  // So `null` left a live nav entry titled *Account* opening a blank pane — on the npm zero-config
  // default, i.e. every local user. The panel now explains itself instead; what must still never
  // appear is the sign-out ACTION, which is what this block really exists to pin.
  it('offers no Sign out control, and says why instead of rendering blank', async () => {
    const sent = stubFetch({ me: spaShellResponse })
    const { container } = renderAccount()

    // Give the probe every chance to resolve before asserting.
    await waitFor(() => expect(sent).toEqual([{ path: '/auth/me', method: 'GET' }]))
    await new Promise((resolve) => setTimeout(resolve, 20))

    // The load-bearing half: no way to invoke logout on a deployment with no session.
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull()
    // And no loading text left behind — the pending state must have resolved, not stalled.
    expect(container.querySelector('[data-slot="account-loading"]')).toBeNull()
    // The pane is explained rather than blank.
    expect(container.querySelector('[data-slot="account-unavailable"]')).not.toBeNull()
  })
})

describe('hosted/authenticated (/auth/me mounted): the section renders', () => {
  it('shows a working Sign out button that POSTs /auth/logout', async () => {
    const sent = stubFetch()
    renderAccount()

    const button = await screen.findByRole('button', { name: 'Sign out' }, { timeout: 5000 })
    fireEvent.click(button)

    await waitFor(() =>
      expect(sent.filter((r) => r.method === 'POST')).toEqual([{ path: '/auth/logout', method: 'POST' }]),
    )
  })

  it('still renders (session-surface mounted) even when the caller is currently signed out — a 401 body is still JSON', async () => {
    stubFetch({ me: () => jsonResponse({ error: 'unauthenticated' }, 401) })
    renderAccount()

    await screen.findByRole('button', { name: 'Sign out' }, { timeout: 5000 })
  })

  it('surfaces a failed sign-out inline instead of losing it silently', async () => {
    stubFetch({ logout: () => jsonResponse({ error: 'boom' }, 500) })
    renderAccount()

    const button = await screen.findByRole('button', { name: 'Sign out' }, { timeout: 5000 })
    fireEvent.click(button)

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('boom'))
  })
})
