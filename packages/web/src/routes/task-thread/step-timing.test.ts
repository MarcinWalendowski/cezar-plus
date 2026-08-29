import { describe, expect, it } from 'vitest'

import type { StepState, StepStatus } from '@loki-labs/better-cezar-api-client'

import type { StepAttempt } from '@loki-labs/better-cezar-api-client'
import { railVisual } from './step-rail'
import {
  ACTIVE_STEP_STATUSES,
  TERMINAL_STEP_STATUSES,
  liveStepTotal,
  stepAttempts,
  stepElapsed,
  stepTotalElapsed,
} from './step-timing'

/** A store-shaped step (`RunRecord.steps` entry) with sensible defaults. */
const step = (status: StepStatus, extra: Partial<StepState> = {}): StepState => ({
  id: 'implement',
  name: 'Implement',
  kind: 'agent',
  status,
  iterations: 1,
  tokensUsed: 0,
  ...extra,
})

/** Every StepStatus, kept by hand so the union growing shows up here as a failure. */
const ALL_STATUSES: StepStatus[] = ['pending', 'running', 'waiting', 'review', 'done', 'failed', 'cancelled', 'skipped']

const START = '2026-08-20T14:24:46.939Z'
const NOW = Date.parse('2026-08-20T14:29:46.939Z') // start + 5:00

describe('the status sets the rail and the clock share', () => {
  // The whole reason these live in step-timing.ts rather than beside railVisual is the import
  // cycle it would create (the rail renders the clock). This pins the invariant that keeping
  // them apart risks: the clock counts for EXACTLY the steps the rail draws a spinner on.
  it.each<StepStatus>(ALL_STATUSES)('%s: ACTIVE_STEP_STATUSES agrees with railVisual', (status) => {
    expect(ACTIVE_STEP_STATUSES.has(status)).toBe(railVisual(status) === 'active')
  })

  it('active and terminal are disjoint, and only `pending` is in neither', () => {
    for (const status of ACTIVE_STEP_STATUSES) expect(TERMINAL_STEP_STATUSES.has(status)).toBe(false)
    const uncounted = ALL_STATUSES.filter((s) => !ACTIVE_STEP_STATUSES.has(s) && !TERMINAL_STEP_STATUSES.has(s))
    expect(uncounted).toEqual(['pending'])
  })
})

describe('stepElapsed — nothing to show', () => {
  it('a pending step has no startedAt, so it renders no clock at all', () => {
    expect(stepElapsed(step('pending'), NOW)).toBeUndefined()
  })

  it('a skipped step never ran — an empty slot, not a zero', () => {
    expect(stepElapsed(step('skipped'), NOW)).toBeUndefined()
  })

  it('an unparseable startedAt yields undefined rather than a NaN clock', () => {
    expect(stepElapsed(step('running', { startedAt: 'not-a-date' }), NOW)).toBeUndefined()
    expect(stepElapsed(step('done', { startedAt: 'not-a-date', finishedAt: START }), NOW)).toBeUndefined()
  })

  it('a terminal step that somehow never got its finishedAt shows nothing', () => {
    expect(stepElapsed(step('done', { startedAt: START }), NOW)).toBeUndefined()
    expect(stepElapsed(step('done', { startedAt: START, finishedAt: 'garbage' }), NOW)).toBeUndefined()
  })
})

describe('stepElapsed — counting', () => {
  it.each<StepStatus>(['running', 'waiting', 'review'])('%s counts from startedAt to now', (status) => {
    expect(stepElapsed(step(status, { startedAt: START }), NOW)).toEqual({ ms: 300_000, live: true })
  })

  it('an active step IGNORES a finishedAt left over from a previous attempt (risk R5)', () => {
    // run.ts overwrites startedAt per attempt but the old finishedAt survives; believing it
    // here would print a negative — or absurdly large — duration for a step that is running.
    const stale = step('running', { startedAt: START, finishedAt: '2026-08-20T14:00:00.000Z', iterations: 2 })
    expect(stepElapsed(stale, NOW)).toEqual({ ms: 300_000, live: true })
  })

  it('a clock behind the server clamps to zero rather than counting backwards', () => {
    const behind = Date.parse('2026-08-20T14:24:40.000Z')
    expect(stepElapsed(step('running', { startedAt: START }), behind)).toEqual({ ms: 0, live: true })
  })
})

describe('stepElapsed — frozen totals', () => {
  it('a done step freezes at finishedAt − startedAt', () => {
    const done = step('done', { startedAt: START, finishedAt: '2026-08-20T14:26:58.939Z' })
    expect(stepElapsed(done, NOW)).toEqual({ ms: 132_000, live: false })
  })

  it('a step CEZAR stopped still ran, so it still has a duration (the pause glyph carries the meaning)', () => {
    const stopped = step('failed', { startedAt: START, finishedAt: '2026-08-20T14:26:58.939Z', stopReason: 'inactivity' })
    expect(railVisual(stopped)).toBe('stopped')
    expect(stepElapsed(stopped, NOW)).toEqual({ ms: 132_000, live: false })
  })

  it.each<StepStatus>(['failed', 'cancelled'])('a %s step keeps the time it burned before it ended', (status) => {
    const ended = step(status, { startedAt: START, finishedAt: '2026-08-20T14:25:46.939Z' })
    expect(stepElapsed(ended, NOW)).toEqual({ ms: 60_000, live: false })
  })

  it('a finishedAt before startedAt clamps to zero rather than printing a negative total', () => {
    const skewed = step('done', { startedAt: START, finishedAt: '2026-08-20T14:20:00.000Z' })
    expect(stepElapsed(skewed, NOW)).toEqual({ ms: 0, live: false })
  })
})

// spec 2026-08-29-per-retry-step-timing, §Verification V2.
const attempt = (n: number, startedAt: string, endedAt?: string): StepAttempt =>
  endedAt === undefined ? { n, startedAt } : { n, startedAt, endedAt }

describe('stepAttempts / stepTotalElapsed — fails closed (V2a)', () => {
  const closed3 = [
    attempt(1, '2026-08-20T14:00:00.000Z', '2026-08-20T14:04:12.000Z'), // 4:12
    attempt(2, '2026-08-20T14:05:00.000Z', '2026-08-20T14:05:38.000Z'), // 0:38
    attempt(3, '2026-08-20T14:06:00.000Z', '2026-08-20T14:18:05.000Z'), // 12:05
  ]

  function expectUndefinedFromBoth(s: ReturnType<typeof step>) {
    expect(stepAttempts(s, NOW)).toBeUndefined()
    expect(stepTotalElapsed(s, NOW)).toBeUndefined()
  }

  it('no `attempts` key at all', () => {
    expectUndefinedFromBoth(step('done', { iterations: 3 }))
  })

  it('an empty `attempts` array', () => {
    expectUndefinedFromBoth(step('done', { iterations: 0, attempts: [] }))
  })

  it('`attempts.length !== iterations` — too few', () => {
    expectUndefinedFromBoth(step('done', { iterations: 3, attempts: closed3.slice(0, 2) }))
  })

  it('`attempts.length !== iterations` — too many', () => {
    expectUndefinedFromBoth(step('done', { iterations: 2, attempts: closed3 }))
  })

  it('a gap in `n`: [1, 3]', () => {
    const gapped = [attempt(1, closed3[0]!.startedAt, closed3[0]!.endedAt), attempt(3, closed3[1]!.startedAt, closed3[1]!.endedAt)]
    expectUndefinedFromBoth(step('done', { iterations: 2, attempts: gapped }))
  })

  it('`n` out of order: [2, 1]', () => {
    const outOfOrder = [attempt(2, closed3[0]!.startedAt, closed3[0]!.endedAt), attempt(1, closed3[1]!.startedAt, closed3[1]!.endedAt)]
    expectUndefinedFromBoth(step('done', { iterations: 2, attempts: outOfOrder }))
  })

  it('a `startedAt` of "not-a-date"', () => {
    const bad = [attempt(1, 'not-a-date', closed3[0]!.endedAt)]
    expectUndefinedFromBoth(step('done', { iterations: 1, attempts: bad }))
  })

  it('an `endedAt` of "not-a-date"', () => {
    const bad = [attempt(1, closed3[0]!.startedAt, 'not-a-date')]
    expectUndefinedFromBoth(step('done', { iterations: 1, attempts: bad }))
  })

  it('an INTERIOR attempt with no `endedAt` while a later one is closed', () => {
    const interior = [attempt(1, closed3[0]!.startedAt), attempt(2, closed3[1]!.startedAt, closed3[1]!.endedAt)]
    expectUndefinedFromBoth(step('done', { iterations: 2, attempts: interior }))
  })

  it('an OPEN final attempt on a TERMINAL step — the case revision 2 would have rendered', () => {
    const openOnDone = [attempt(1, closed3[0]!.startedAt, closed3[0]!.endedAt), attempt(2, closed3[1]!.startedAt)]
    expectUndefinedFromBoth(step('done', { iterations: 2, attempts: openOnDone }))
  })
})

describe('stepTotalElapsed — closed totals (V2b)', () => {
  it('sums three closed attempts exactly, with no live anchor', () => {
    const s = step('done', {
      iterations: 3,
      attempts: [
        attempt(1, '2026-08-20T14:00:00.000Z', '2026-08-20T14:04:12.000Z'), // 252_000ms
        attempt(2, '2026-08-20T14:05:00.000Z', '2026-08-20T14:05:38.000Z'), // 38_000ms
        attempt(3, '2026-08-20T14:06:00.000Z', '2026-08-20T14:18:05.000Z'), // 725_000ms
      ],
    })
    const total = stepTotalElapsed(s, NOW)
    expect(total?.ms).toBe(252_000 + 38_000 + 725_000)
    expect(total?.live).toBe(false)
    expect(total?.closedMs).toBe(total?.ms)
    expect(total?.openStartedAt).toBeUndefined()
  })
})

describe('stepTotalElapsed / stepAttempts — a live final attempt (V2c)', () => {
  const OPEN_START = '2026-08-20T14:29:00.000Z'
  const fixture = () =>
    step('running', {
      iterations: 3,
      attempts: [
        attempt(1, '2026-08-20T14:00:00.000Z', '2026-08-20T14:00:10.000Z'), // 10_000ms
        attempt(2, '2026-08-20T14:01:00.000Z', '2026-08-20T14:01:20.000Z'), // 20_000ms
        attempt(3, OPEN_START), // open — 46_000ms at NOW
      ],
    })

  it('`ms` is the closed sum plus the open elapsed, and `live` is true', () => {
    const total = stepTotalElapsed(fixture(), NOW)
    expect(total?.live).toBe(true)
    expect(total?.ms).toBe(10_000 + 20_000 + (NOW - Date.parse(OPEN_START)))
  })

  it('`closedMs` is exactly the two CLOSED attempts and does not move with `now`', () => {
    const a = stepTotalElapsed(fixture(), NOW)
    const b = stepTotalElapsed(fixture(), NOW + 60_000)
    expect(a?.closedMs).toBe(30_000)
    expect(b?.closedMs).toBe(30_000)
  })

  it('`openStartedAt` is the open attempt\'s own startedAt', () => {
    expect(stepTotalElapsed(fixture(), NOW)?.openStartedAt).toBe(OPEN_START)
  })

  it('stepAttempts resolves each row, live only on the last', () => {
    const rows = stepAttempts(fixture(), NOW)
    expect(rows).toHaveLength(3)
    expect(rows?.map((r) => r.live)).toEqual([false, false, true])
    expect(rows?.[2]?.startedAt).toBe(OPEN_START)
  })
})

describe('stepAttempts / stepTotalElapsed — fail closed on a finished step (V2d)', () => {
  it('the same three-attempt fixture as V2c, but `done`, renders nothing rather than a frozen now-derived number', () => {
    const s = step('done', {
      iterations: 3,
      attempts: [
        attempt(1, '2026-08-20T14:00:00.000Z', '2026-08-20T14:00:10.000Z'),
        attempt(2, '2026-08-20T14:01:00.000Z', '2026-08-20T14:01:20.000Z'),
        attempt(3, '2026-08-20T14:29:00.000Z'),
      ],
    })
    expect(stepAttempts(s, NOW)).toBeUndefined()
    expect(stepTotalElapsed(s, NOW)).toBeUndefined()
  })
})

describe('stepAttempts — a negative interval clamps per attempt (V2e)', () => {
  it('clamps the bad interval at 0 without reducing the total below the good attempts', () => {
    const s = step('done', {
      iterations: 2,
      attempts: [
        attempt(1, '2026-08-20T14:05:00.000Z', '2026-08-20T14:00:00.000Z'), // endedAt BEFORE startedAt
        attempt(2, '2026-08-20T14:10:00.000Z', '2026-08-20T14:10:30.000Z'), // 30_000ms
      ],
    })
    const rows = stepAttempts(s, NOW)
    expect(rows?.[0]?.ms).toBe(0)
    expect(rows?.[1]?.ms).toBe(30_000)
    expect(stepTotalElapsed(s, NOW)?.ms).toBe(30_000)
  })
})

describe('a well-formed multi-attempt step is NOT vacuously undefined (V2g)', () => {
  it('a two-attempt fixture returns a length-2 list and a real sum', () => {
    const s = step('done', {
      iterations: 2,
      attempts: [
        attempt(1, '2026-08-20T14:00:00.000Z', '2026-08-20T14:00:05.000Z'),
        attempt(2, '2026-08-20T14:01:00.000Z', '2026-08-20T14:01:07.000Z'),
      ],
    })
    expect(stepAttempts(s, NOW)).toHaveLength(2)
    expect(stepTotalElapsed(s, NOW)?.ms).toBe(5_000 + 7_000)
  })
})

describe('liveStepTotal — the live headline is monotonic under clock skew', () => {
  it('clamps a negative open interval at the frozen closedMs rather than dipping below it', () => {
    const format = liveStepTotal(4_000)
    expect(format(-5_000)).toBe('0:04')
    expect(format(0)).toBe('0:04')
    expect(format(1_000)).toBe('0:05')
  })
})
