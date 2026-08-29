import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { __flushAnalyticsForTests, __resetAnalyticsForTests, track } from './analytics'

/**
 * `lib/analytics.ts` (`.ai/specs/2026-08-25-split-active-backlog-tables.md`, D7, verification
 * step 7). What is worth pinning is not that events reach the server — it is that NOTHING a
 * caller does can make a component wait on, or fail because of, the sink.
 */

let posted: { events: { event: string; ts: string; props?: Record<string, unknown> }[] }[] = []

beforeEach(() => {
  posted = []
  __resetAnalyticsForTests()
  // `requestIdleCallback` is absent under jsdom, so `track` already falls back to a macrotask;
  // the tests drive the flush explicitly rather than waiting on either.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      posted.push(JSON.parse(String(init.body)))
      return new Response(JSON.stringify({ accepted: 1 }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  __resetAnalyticsForTests()
})

describe('track', () => {
  it('batches several events into ONE request', async () => {
    track('filed_tasks.sorted', { partition: 'active', column: 'task', dir: 'asc' })
    track('filed_tasks.show_more', { partition: 'backlog', from: 30, to: 40 })
    expect(posted).toHaveLength(0) // nothing has left the buffer yet — `track` returns immediately

    await __flushAnalyticsForTests()
    expect(posted).toHaveLength(1)
    expect(posted[0]?.events.map((event) => event.event)).toEqual([
      'filed_tasks.sorted',
      'filed_tasks.show_more',
    ])
    expect(posted[0]?.events[0]?.props).toEqual({ partition: 'active', column: 'task', dir: 'asc' })
  })

  it('stamps each event with its own time, so a batched flush does not collapse them', async () => {
    track('a')
    track('b')
    await __flushAnalyticsForTests()
    for (const event of posted[0]?.events ?? []) {
      expect(Number.isNaN(Date.parse(event.ts))).toBe(false)
    }
  })

  it('splits a batch over 50 events and sends the rest next time', async () => {
    for (let i = 0; i < 60; i += 1) track(`e${i}`)
    await __flushAnalyticsForTests()
    expect(posted[0]?.events).toHaveLength(50)
    await __flushAnalyticsForTests()
    expect(posted[1]?.events).toHaveLength(10)
  })

  it('drops a failed POST silently and never throws — and the next batch still goes out', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      }),
    )
    track('lost')
    await expect(__flushAnalyticsForTests()).resolves.toBeUndefined()

    // Recovery: a later event is not held hostage by the dropped one.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
        posted.push(JSON.parse(String(init.body)))
        return new Response(JSON.stringify({ accepted: 1 }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )
    track('kept')
    await __flushAnalyticsForTests()
    expect(posted.at(-1)?.events.map((event) => event.event)).toEqual(['kept'])
  })

  it('a server error status is dropped just as silently as a network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'nope' }), { status: 500 })),
    )
    track('boom')
    await expect(__flushAnalyticsForTests()).resolves.toBeUndefined()
  })

  it('flushing an empty buffer sends nothing', async () => {
    await __flushAnalyticsForTests()
    expect(posted).toHaveLength(0)
  })

  it('the buffer is bounded — a cockpit that can never reach its server does not grow forever', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      }),
    )
    for (let i = 0; i < 1_000; i += 1) track(`e${i}`)
    // Newest-wins: the events a reader would be asking about are the recent ones.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
        posted.push(JSON.parse(String(init.body)))
        return new Response(JSON.stringify({ accepted: 1 }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )
    await __flushAnalyticsForTests()
    expect(posted[0]?.events[0]?.event).toBe('e800') // 1000 - (50 * 4)
  })
})
