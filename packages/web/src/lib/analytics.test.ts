import { afterEach, describe, expect, it, vi } from 'vitest'

import { trackEvent } from '@/lib/analytics'

/**
 * `trackEvent` (`.ai/specs/2026-08-29-filed-task-detail-page.md`): the one client entry point for
 * `POST /workspace/analytics/events`. Fail-open and silent is the whole contract — these tests
 * exist to prove a broken sink can never surface as a thrown error or a toast.
 */

afterEach(() => {
  vi.unstubAllGlobals()
})

const jsonResponse = (body: unknown, status = 202) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('trackEvent', () => {
  it('POSTs the built event once, to the analytics route', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ accepted: 1 }))
    vi.stubGlobal('fetch', fetchMock)

    trackEvent('todo.detail_opened', { project: 'api', todo: 'todo-1', status: 'todo', archived: false, surface: 'direct' })
    // Fire-and-forget: give the microtask queue a turn to let the request go out.
    await Promise.resolve()
    await Promise.resolve()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [input, init] = fetchMock.mock.calls[0]!
    expect(String(input)).toBe('/api/v1/workspace/analytics/events')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({
      events: [
        {
          name: 'todo.detail_opened',
          props: { project: 'api', todo: 'todo-1', status: 'todo', archived: false, surface: 'direct' },
        },
      ],
    })
  })

  it('a rejected POST resolves and throws nothing — fail-open, no toast, no retry', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down')
    })
    vi.stubGlobal('fetch', fetchMock)

    expect(() =>
      trackEvent('todo.detail_opened', { project: 'api', todo: 'todo-1', status: 'todo', archived: false, surface: 'direct' }),
    ).not.toThrow()

    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a non-2xx answer is swallowed the same way as a rejection', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'bad request' }, 400))
    vi.stubGlobal('fetch', fetchMock)

    expect(() =>
      trackEvent('todo.detail_opened', { project: 'api', todo: 'todo-1', status: 'todo', archived: false, surface: 'direct' }),
    ).not.toThrow()

    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
