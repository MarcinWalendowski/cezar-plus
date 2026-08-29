import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { __flushAnalyticsForTests, __resetAnalyticsForTests, track } from './analytics'

/**
 * `lib/analytics.ts` (`.ai/specs/2026-08-25-split-active-backlog-tables.md`, D7, verification
 * step 7). What is worth pinning is not that events reach the server — it is that NOTHING a
 * caller does can make a component wait on, or fail because of, the sink.
 */

let posted: { events: { name: string; props: Record<string, unknown> }[] }[] = []

const captureFetch = () =>
  vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
    posted.push(JSON.parse(String(init.body)))
    return new Response(JSON.stringify({ accepted: 1 }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    })
  })

beforeEach(() => {
  posted = []
  __resetAnalyticsForTests()
  // `requestIdleCallback` is absent under jsdom, so `track` already falls back to a macrotask;
  // the tests drive the flush explicitly rather than waiting on either.
  vi.stubGlobal('fetch', captureFetch())
})

afterEach(() => {
  vi.unstubAllGlobals()
  __resetAnalyticsForTests()
})

describe('track', () => {
  it('batches several events into ONE request', async () => {
    track('todo.filed_sorted', { partition: 'active', column: 'task', dir: 'asc' })
    track('todo.filed_show_more', { partition: 'backlog', from: 30, to: 40 })
    expect(posted).toHaveLength(0) // nothing has left the buffer yet — `track` returns immediately

    await __flushAnalyticsForTests()
    expect(posted).toHaveLength(1)
    expect(posted[0]?.events.map((event) => event.name)).toEqual([
      'todo.filed_sorted',
      'todo.filed_show_more',
    ])
    expect(posted[0]?.events[0]?.props).toEqual({ partition: 'active', column: 'task', dir: 'asc' })
  })

  it('sends an empty props object rather than omitting the key the sink requires', async () => {
    track('todo.filed_sorted')
    await __flushAnalyticsForTests()
    expect(posted[0]?.events[0]?.props).toEqual({})
  })

  it('never stamps a client timestamp — the server owns `ts`', async () => {
    track('todo.filed_sorted', { partition: 'active' })
    await __flushAnalyticsForTests()
    expect(Object.keys(posted[0]?.events[0] ?? {}).sort()).toEqual(['name', 'props'])
  })

  it('splits a batch over the sink cap and sends the rest next time', async () => {
    for (let i = 0; i < 25; i += 1) track(`todo.filed_e${i}`)
    await __flushAnalyticsForTests()
    expect(posted[0]?.events).toHaveLength(20)
    await __flushAnalyticsForTests()
    expect(posted[1]?.events).toHaveLength(5)
  })

  it('drops a failed POST silently and never throws — and the next batch still goes out', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      }),
    )
    track('todo.filed_lost')
    await expect(__flushAnalyticsForTests()).resolves.toBeUndefined()

    // Recovery: a later event is not held hostage by the dropped one.
    vi.stubGlobal('fetch', captureFetch())
    track('todo.filed_kept')
    await __flushAnalyticsForTests()
    expect(posted.at(-1)?.events.map((event) => event.name)).toEqual(['todo.filed_kept'])
  })

  it('a server error status is dropped just as silently as a network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'nope' }), { status: 500 })),
    )
    track('todo.filed_boom')
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
    for (let i = 0; i < 1_000; i += 1) track(`todo.filed_e${i}`)
    // Newest-wins: the events a reader would be asking about are the recent ones.
    vi.stubGlobal('fetch', captureFetch())
    await __flushAnalyticsForTests()
    expect(posted[0]?.events[0]?.name).toBe('todo.filed_e920') // 1000 - (20 * 4)
  })
})
