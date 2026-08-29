import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { analyticsEventSchema } from '@loki-labs/better-cezar-api-client'
import { postAnalyticsEvents } from '@/api/client'
import { track } from './analytics'

// spec 2026-08-29-step-retry-timing §Analytics — `track()` delegates to `postAnalyticsEvents`,
// the typed `hc` wrapper, rather than a raw `fetch` at a hand-written URL. Stubbing the global
// `fetch` the `hc` client itself uses is what proves the wrapper — and not a URL this feature
// built on its own — is the thing being exercised.
const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

function reply(body: unknown, init: ResponseInit = {}): void {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
      ...init,
    }),
  )
}

function lastCall(): { path: string; method: string; body: unknown; headers: Headers } {
  const call = fetchMock.mock.calls.at(-1)
  if (!call) throw new Error('fetch was never called')
  const [path, init = {}] = call as [string, RequestInit]
  return {
    path,
    method: String(init.method),
    body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    headers: new Headers(init.headers),
  }
}

describe('track() (spec 2026-08-29-step-retry-timing §Analytics)', () => {
  it('sends { events: [{ name, props }] } to /api/v1/workspace/analytics/events with a JSON content type', async () => {
    reply({ accepted: 1 })
    track('step.attempts_expanded', { runId: 'run-1', stepId: 'ship', iterations: 3 })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())

    const call = lastCall()
    expect(call.path).toBe('/api/v1/workspace/analytics/events')
    expect(call.method).toBe('POST')
    expect(call.headers.get('content-type')).toContain('application/json')
    expect(call.body).toEqual({
      events: [{ name: 'step.attempts_expanded', props: { runId: 'run-1', stepId: 'ship', iterations: 3 } }],
    })
    // Satisfies the contract schema — parsed directly, not hand-checked against the regex.
    for (const event of (call.body as { events: unknown[] }).events) {
      expect(analyticsEventSchema.safeParse(event).success).toBe(true)
    }
  })

  it('failure is swallowed: a rejecting transport leaves track() resolved and throws nothing', async () => {
    fetchMock.mockRejectedValue(new TypeError('network down'))
    // track() itself is fire-and-forget (void), so the assertion is that calling it never throws
    // synchronously and the underlying promise it started settles without an unhandled rejection.
    expect(() => track('step.attempts_expanded', { runId: 'run-1', stepId: 'ship', iterations: 1 })).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  it('failure is swallowed: a resolving 500 also leaves track() resolved', async () => {
    reply({ error: 'boom' }, { status: 500 })
    expect(() => track('step.attempts_expanded', { runId: 'run-1', stepId: 'ship', iterations: 1 })).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
})

describe('postAnalyticsEvents() does not throw on a non-2xx (spec 2026-08-29-step-retry-timing §Analytics)', () => {
  it('a 500 response resolves rather than raising — the one deviation from every unwrap-based sibling', async () => {
    reply({ error: 'boom' }, { status: 500 })
    await expect(postAnalyticsEvents([{ name: 'step.attempts_expanded', props: { runId: 'run-1' } }])).resolves
      .toBeUndefined()
  })

  it('a rejecting transport still rejects — only the HTTP-status half is swallowed, not the network half', async () => {
    fetchMock.mockRejectedValue(new TypeError('network down'))
    await expect(postAnalyticsEvents([{ name: 'step.attempts_expanded', props: { runId: 'run-1' } }])).rejects
      .toThrow()
  })
})
