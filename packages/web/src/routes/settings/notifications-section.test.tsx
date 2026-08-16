import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { NotificationsResponse, TransportView } from '@loki-labs/better-cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { NotificationsSection } from './notifications-section'

/**
 * Settings → Notifications (R6 Step 1.7): the toggle's persistence round-trip against a stubbed
 * ui-state API, enable-only permission requests, and the denied/unsupported degradations.
 * The trigger itself (what actually fires) is pinned in components/run-notifications.test.tsx.
 * Since step 3.5 this is a GLOBAL section: every read and write below is asserted against
 * `/api/v1/workspace/ui-state`, and a write to the per-repo `/api/v1/ui-state` would fail the stub's
 * URL match outright.
 *
 * From "the notifications section" describe block down: W4.9's second pane, the machine-wide
 * outbound transport registry (`/api/v1/workspace/notifications*`, F4 `CEZ_NOTIFY=1`). It shares
 * nothing with the toggle above — a different query key, a different set of routes — so `serve()`
 * below stubs both families and each block only asserts the one it owns.
 */

let requests: Array<{ method: string; url: string; body?: unknown }> = []

const EMPTY_NOTIFICATIONS: NotificationsResponse = {
  configured: false,
  cockpitUrl: { value: '', source: 'loopback' },
  defaults: {
    coalesceMs: 20_000,
    urgentCoalesceMs: 5_000,
    maxAgeMs: 21_600_000,
    quietHours: null,
    quietHoursAllowUrgent: true,
    rate: { perHour: 10, burst: 4, perMinute: 2 },
  },
  events: [],
  transports: [],
}

/** GET/PUT the GLOBAL ui-state (`/api/v1/workspace/ui-state`) — the store this section has
 *  written since the step-3.5 settings split — AND the notifications family this pane reads/
 *  writes; everything else stays honestly pending. `notifications` defaults to the flag-off empty
 *  shape (D19) so a test that only cares about the toggle above never has to think about it. */
function serve(uiState: Record<string, unknown> = {}, notifications: NotificationsResponse = EMPTY_NOTIFICATIONS) {
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
      if (url === '/api/v1/workspace/ui-state' && method === 'GET') return json(uiState)
      if (url === '/api/v1/workspace/ui-state' && method === 'PUT')
        return json({ ...uiState, ...(body as Record<string, unknown>) })
      if (url === '/api/v1/workspace/notifications' && method === 'GET') return json(notifications)
      if (url.startsWith('/api/v1/workspace/notifications/transports') || url.endsWith('/test')) {
        return json({ error: 'notifications are disabled — set CEZ_NOTIFY=1 to enable them' }, 409)
      }
      return new Promise<never>(() => {})
    }),
  )
}

/** A Notification stand-in with a controllable permission + requestPermission spy. */
function stubNotification(permission: NotificationPermission, answer: NotificationPermission = permission) {
  const requestPermission = vi.fn(async () => {
    ;(FakeNotification as unknown as { permission: string }).permission = answer
    return answer
  })
  function FakeNotification() {}
  ;(FakeNotification as unknown as { permission: string }).permission = permission
  ;(FakeNotification as unknown as { requestPermission: unknown }).requestPermission = requestPermission
  vi.stubGlobal('Notification', FakeNotification)
  return requestPermission
}

function renderSection() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <NotificationsSection />
    </QueryClientProvider>,
  )
}

const toggle = () => screen.getByRole('switch', { name: 'Notify when an agent needs you' })
const putBody = () => requests.find((r) => r.method === 'PUT' && r.url === '/api/v1/workspace/ui-state')?.body

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the notifications section', () => {
  it('is OFF by default — an empty ui-state renders the switch unchecked', async () => {
    serve()
    stubNotification('default')
    renderSection()
    await waitFor(() => expect(requests.some((r) => r.method === 'GET')).toBe(true))
    expect(toggle().getAttribute('aria-checked')).toBe('false')
  })

  it('a persisted true checks the switch at boot — server truth wins', async () => {
    serve({ notifications: { enabled: true } })
    stubNotification('granted')
    renderSection()
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('true'))
  })

  it('enabling asks for permission (enable only!) and PUTs the additive notifications key', async () => {
    serve()
    const requestPermission = stubNotification('default', 'granted')
    renderSection()

    // Mounting alone must never prompt — that is the "on enable only" contract.
    expect(requestPermission).not.toHaveBeenCalled()

    fireEvent.click(toggle())
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    expect(requestPermission).toHaveBeenCalledOnce()
    await waitFor(() => expect(putBody()).toEqual({ notifications: { enabled: true } }))
  })

  it('enabling with permission already granted does not re-ask', async () => {
    serve()
    const requestPermission = stubNotification('granted')
    renderSection()
    fireEvent.click(toggle())
    expect(requestPermission).not.toHaveBeenCalled()
    await waitFor(() => expect(putBody()).toEqual({ notifications: { enabled: true } }))
  })

  it('permission denied degrades: the preference still persists and the section says the browser blocks delivery', async () => {
    serve()
    stubNotification('denied')
    renderSection()

    expect(document.querySelector('[data-slot="notifications-denied"]')).toBeNull()
    fireEvent.click(toggle())

    await waitFor(() => expect(putBody()).toEqual({ notifications: { enabled: true } }))
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    expect(document.querySelector('[data-slot="notifications-denied"]')?.textContent).toContain(
      'blocking notifications',
    )
  })

  it('a denial GIVEN AT the enable prompt surfaces the same warning', async () => {
    serve()
    stubNotification('default', 'denied')
    renderSection()
    fireEvent.click(toggle())
    await waitFor(() =>
      expect(document.querySelector('[data-slot="notifications-denied"]')).not.toBeNull(),
    )
  })

  it('disabling PUTs enabled:false and never touches the permission API', async () => {
    serve({ notifications: { enabled: true } })
    const requestPermission = stubNotification('granted')
    renderSection()
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('true'))

    fireEvent.click(toggle())
    expect(toggle().getAttribute('aria-checked')).toBe('false')
    expect(requestPermission).not.toHaveBeenCalled()
    await waitFor(() => expect(putBody()).toEqual({ notifications: { enabled: false } }))
  })

  it('no Notification API at all: the switch is disabled and the section says so', async () => {
    serve()
    vi.stubGlobal('Notification', undefined)
    renderSection()
    await waitFor(() => expect(requests.some((r) => r.method === 'GET')).toBe(true))
    expect(toggle().hasAttribute('disabled')).toBe(true)
    expect(
      document.querySelector('[data-slot="notifications-unsupported"]')?.textContent,
    ).toContain('does not support')
  })
})

/**
 * W4.9's second pane: the machine-wide outbound transport registry. Every mutating case below
 * exercises a REAL fetch against the routes' current (flag-off/unbuilt) answer — a 409 — because
 * that is what this checkout's `notifications-routes.ts` actually returns today (W4.7 has not
 * landed). What's under test is the REQUEST this pane sends, which is checked byte-for-byte
 * against the frozen contract (`packages/contract/src/notifications.ts`) regardless of what the
 * stub answers back with.
 */
function transport(overrides: Partial<TransportView> = {}): TransportView {
  return {
    id: 'relay',
    kind: 'webhook',
    label: 'Relay Push',
    enabled: true,
    endpointHost: 'relay.example.test',
    endpointPath: '/notify/v1/events',
    auth: { source: 'env', envVar: 'CEZ_NOTIFY_TOKEN', present: true },
    events: { 'run.failed': true },
    projects: null,
    quietHours: null,
    rate: null,
    capabilities: {
      maxTitleChars: 80,
      maxBodyChars: 1200,
      links: 'inline',
      markdown: false,
      batch: true,
      idempotencyKey: true,
    },
    health: {
      status: 'ok',
      consecutiveFailures: 0,
      counters: { sent: 0, failed: 0, dropped: 0, suppressed: 0, leaseReclaimed: 0, requeued: 0 },
    },
    ...overrides,
  }
}

const EVENT_CATALOG: NotificationsResponse['events'] = [
  { id: 'run.failed', label: 'Run failed', severity: 'urgent', defaultEnabled: true },
  { id: 'run.finished', label: 'Run finished', severity: 'info', defaultEnabled: true },
  { id: 'test', label: 'Test', severity: 'info', defaultEnabled: true },
]

const transportsPane = () => document.querySelector('[data-slot="server-transports-section"]')!

describe('the server transports pane', () => {
  it('shows the exact empty-state copy and the flag-off hint when nothing is configured', async () => {
    serve()
    renderSection()
    await waitFor(() =>
      expect(document.querySelector('[data-slot="notifications-transports-empty"]')?.textContent).toBe(
        'No transports configured. cezar sends nothing.',
      ),
    )
    expect(transportsPane().textContent).toContain('Set CEZ_NOTIFY=1 and restart cezar to turn it on.')
  })

  it('renders a configured row: label, kind, endpoint host and its health chip', async () => {
    serve({}, { ...EMPTY_NOTIFICATIONS, configured: true, transports: [transport()], events: EVENT_CATALOG })
    renderSection()
    await waitFor(() => expect(screen.getByText('Relay Push')).toBeTruthy())
    const row = document.querySelector('[data-transport-id="relay"]')!
    expect(row.textContent).toContain('webhook')
    expect(row.textContent).toContain('relay.example.test')
    expect(row.querySelector('[data-slot="transport-health"]')?.getAttribute('data-status')).toBe('ok')
    // Off (D19) never applies once configured is true — the hint must not leak into an "on" render.
    expect(transportsPane().textContent).not.toContain('CEZ_NOTIFY=1')
  })

  it('displays the discovered cockpit URL and its source', async () => {
    serve(
      {},
      { ...EMPTY_NOTIFICATIONS, configured: true, cockpitUrl: { value: 'http://127.0.0.1:4321', source: 'loopback' } },
    )
    renderSection()
    await waitFor(() =>
      expect(document.querySelector('[data-slot="notifications-cockpit-url"]')?.textContent).toContain(
        '127.0.0.1:4321',
      ),
    )
    expect(document.querySelector('[data-slot="notifications-cockpit-url"]')?.textContent).toContain(
      'probably unreachable from a phone',
    )
  })

  it('flipping the enable switch PUTs exactly {enabled: false} to that transport', async () => {
    serve({}, { ...EMPTY_NOTIFICATIONS, configured: true, transports: [transport()] })
    renderSection()
    await waitFor(() => expect(screen.getByText('Relay Push')).toBeTruthy())
    fireEvent.click(screen.getByRole('switch', { name: 'Enable Relay Push' }))
    await waitFor(() =>
      expect(
        requests.some(
          (r) =>
            r.method === 'PUT' &&
            r.url === '/api/v1/workspace/notifications/transports/relay' &&
            JSON.stringify(r.body) === JSON.stringify({ enabled: false }),
        ),
      ).toBe(true),
    )
  })

  it('Send test POSTs to the transport-specific /test route', async () => {
    serve({}, { ...EMPTY_NOTIFICATIONS, configured: true, transports: [transport()] })
    renderSection()
    await waitFor(() => expect(screen.getByText('Relay Push')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Send test' }))
    await waitFor(() =>
      expect(
        requests.some(
          (r) => r.method === 'POST' && r.url === '/api/v1/workspace/notifications/transports/relay/test',
        ),
      ).toBe(true),
    )
  })

  it('Remove DELETEs that transport', async () => {
    serve({}, { ...EMPTY_NOTIFICATIONS, configured: true, transports: [transport()] })
    renderSection()
    await waitFor(() => expect(screen.getByText('Relay Push')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() =>
      expect(
        requests.some(
          (r) => r.method === 'DELETE' && r.url === '/api/v1/workspace/notifications/transports/relay',
        ),
      ).toBe(true),
    )
  })

  it('the event matrix reflects transport.events, falls back to defaultEnabled, and excludes "test"', async () => {
    serve(
      {},
      {
        ...EMPTY_NOTIFICATIONS,
        configured: true,
        transports: [transport({ events: { 'run.failed': false } })],
        events: EVENT_CATALOG,
      },
    )
    renderSection()
    await waitFor(() => expect(screen.getByText('Relay Push')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Show Relay Push event settings' }))
    expect(screen.getByRole('switch', { name: 'Run failed notifications' }).getAttribute('aria-checked')).toBe(
      'false',
    )
    expect(screen.getByRole('switch', { name: 'Run finished notifications' }).getAttribute('aria-checked')).toBe(
      'true',
    )
    expect(screen.queryByRole('switch', { name: 'Test notifications' })).toBeNull()
  })

  it('Add transport POSTs id/label/url/capabilities with no auth key when left unset', async () => {
    serve()
    renderSection()
    await waitFor(() => expect(document.querySelector('[data-slot="notifications-transports-empty"]')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Add transport' }))
    fireEvent.change(screen.getByLabelText('Transport id'), { target: { value: 'ntfy' } })
    fireEvent.change(screen.getByLabelText('Transport label'), { target: { value: 'ntfy.sh' } })
    fireEvent.change(screen.getByLabelText('Webhook URL'), { target: { value: 'https://ntfy.sh/my-topic' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add transport' }))

    await waitFor(() =>
      expect(requests.some((r) => r.method === 'POST' && r.url === '/api/v1/workspace/notifications/transports'))
        .toBe(true),
    )
    const created = requests.find(
      (r) => r.method === 'POST' && r.url === '/api/v1/workspace/notifications/transports',
    )?.body as Record<string, unknown>
    expect(created.id).toBe('ntfy')
    expect(created.label).toBe('ntfy.sh')
    expect((created.webhook as Record<string, unknown>).url).toBe('https://ntfy.sh/my-topic')
    expect((created.webhook as Record<string, unknown>).payload).toBe('envelope')
    expect((created.webhook as Record<string, unknown>).auth).toBeUndefined()
    expect(created.capabilities).toBeTruthy()
  })

  it('Add transport with an env-var auth mode sends {scheme: bearer, envVar}', async () => {
    serve()
    renderSection()
    await waitFor(() => expect(document.querySelector('[data-slot="notifications-transports-empty"]')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Add transport' }))
    fireEvent.change(screen.getByLabelText('Transport id'), { target: { value: 'relay' } })
    fireEvent.change(screen.getByLabelText('Webhook URL'), {
      target: { value: 'https://relay.example.test/notify/v1/events' },
    })
    fireEvent.change(screen.getByLabelText('Auth mode'), { target: { value: 'env' } })
    fireEvent.change(screen.getByLabelText('Environment variable name'), {
      target: { value: 'CEZ_NOTIFY_TOKEN' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add transport' }))

    await waitFor(() =>
      expect(requests.some((r) => r.method === 'POST' && r.url === '/api/v1/workspace/notifications/transports'))
        .toBe(true),
    )
    const created = requests.find(
      (r) => r.method === 'POST' && r.url === '/api/v1/workspace/notifications/transports',
    )?.body as { webhook: { auth: unknown } }
    expect(created.webhook.auth).toEqual({ scheme: 'bearer', envVar: 'CEZ_NOTIFY_TOKEN' })
  })

  it('never renders a stored secret, and editing without touching auth sends the "__unchanged__" sentinel', async () => {
    serve({}, { ...EMPTY_NOTIFICATIONS, configured: true, transports: [transport()] })
    renderSection()
    await waitFor(() => expect(screen.getByText('Relay Push')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(document.querySelector('[data-slot="transport-dialog-auth-current"]')?.textContent).toContain(
      'CEZ_NOTIFY_TOKEN',
    )
    expect(document.querySelector('[data-slot="transport-dialog-auth-current"]')?.textContent).toContain(
      'present',
    )
    // No inline/env value box is ever pre-filled with a secret — the field simply does not exist
    // until the user opts into changing auth.
    expect(document.querySelector('[data-slot="transport-dialog-auth-inline"]')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(
        requests.some(
          (r) => r.method === 'PUT' && r.url === '/api/v1/workspace/notifications/transports/relay',
        ),
      ).toBe(true),
    )
    const patched = requests.find(
      (r) => r.method === 'PUT' && r.url === '/api/v1/workspace/notifications/transports/relay',
    )?.body as { webhook?: { auth?: unknown; url?: unknown }; label?: unknown }
    expect(patched.webhook?.auth).toEqual({ scheme: 'bearer', inline: '__unchanged__' })
    // URL was never touched, so it must be omitted rather than sent as an empty string.
    expect(patched.webhook?.url).toBeUndefined()
    expect(patched.label).toBeUndefined()
  })

  it('subscribes to the "notifications" WS topic while mounted, and unsubscribes on unmount', async () => {
    serve()
    const listeners: Array<() => void> = []
    const unsubscribe = vi.fn()
    const subscribeTopic = vi.fn((topic: string, listener: () => void) => {
      if (topic === 'notifications') listeners.push(listener)
      return unsubscribe
    })
    vi.doMock('@/api/ws', () => ({ subscribeTopic }))
    vi.resetModules()
    const { NotificationsSection: FreshSection } = await import('./notifications-section')

    const { unmount } = render(
      <QueryClientProvider client={createQueryClient()}>
        <FreshSection />
      </QueryClientProvider>,
    )
    await waitFor(() => expect(subscribeTopic).toHaveBeenCalledWith('notifications', expect.any(Function)))
    expect(listeners.length).toBe(1)

    unmount()
    expect(unsubscribe).toHaveBeenCalled()
    vi.doUnmock('@/api/ws')
    vi.resetModules()
  })
})
