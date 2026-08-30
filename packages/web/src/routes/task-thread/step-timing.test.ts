import { describe, expect, it } from 'vitest'

import type { StepState, StepStatus } from '@loki-labs/cezar-plus-api-client'

import { railVisual } from './step-rail'
import { ACTIVE_STEP_STATUSES, TERMINAL_STEP_STATUSES, stepAttempts, stepElapsed } from './step-timing'

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

// spec 2026-08-29-step-retry-timing — `stepElapsed` and `stepAttempts` become cumulative when
// `StepState.attempts` is present, and degrade byte-identically to the suites above when it is
// absent (which the unmodified assertions above already prove).
describe('stepElapsed / stepAttempts — cumulative across attempts (spec 2026-08-29-step-retry-timing)', () => {
  const at = (offsetMs: number) => new Date(Date.parse(START) + offsetMs).toISOString()

  it('the headline case: three closed attempts of 4:12 / 11:03 / 2:40 sum to 17:55, live: false', () => {
    // Deliberately gapped, not contiguous: a 100s idle gap between each attempt (the loop-back
    // overhead a real retry has) means the naive `finishedAt - startedAt` span (21:15) does NOT
    // equal the sum of the three attempts (17:55) — a regression to "today's math" on a present
    // `attempts` array would read the wrong number here, which is the point of this fixture.
    const attempts = [
      { startedAt: at(0), finishedAt: at(252_000) }, // 4:12
      { startedAt: at(352_000), finishedAt: at(352_000 + 663_000) }, // 11:03, after a 100s gap
      { startedAt: at(1_115_000), finishedAt: at(1_115_000 + 160_000) }, // 2:40, after another 100s gap
    ]
    const done = step('done', { startedAt: attempts[0]!.startedAt, finishedAt: attempts[2]!.finishedAt, attempts })
    expect(stepElapsed(done, NOW)).toEqual({ ms: 1_075_000, live: false })
    expect(stepAttempts(done, NOW).map((r) => r.ms)).toEqual([252_000, 663_000, 160_000])
  })

  it('a running step with two closed attempts and one open returns the live shape', () => {
    const attempts = [
      { startedAt: at(0), finishedAt: at(100_000) },
      { startedAt: at(100_000), finishedAt: at(150_000) },
      { startedAt: at(150_000) }, // open
    ]
    const running = step('running', { startedAt: attempts[2]!.startedAt, attempts })
    const elapsed = stepElapsed(running, NOW)
    expect(elapsed).toEqual({ ms: 150_000 + (NOW - Date.parse(attempts[2]!.startedAt)), live: true, since: attempts[2]!.startedAt, offsetMs: 150_000 })
  })

  it('degradation: attempts absent returns exactly the fallback shape (unmodified existing suite is the strongest proof)', () => {
    const done = step('done', { startedAt: START, finishedAt: '2026-08-20T14:26:58.939Z' })
    expect(stepElapsed(done, NOW)).toEqual({ ms: 132_000, live: false })
    expect(stepAttempts(done, NOW)).toEqual([])
  })

  it('a pending step with all-closed recorded attempts returns their sum, live: false (R5)', () => {
    const attempts = [
      { startedAt: at(0), finishedAt: at(60_000) },
      { startedAt: at(60_000), finishedAt: at(120_000) },
    ]
    const pending = step('pending', { attempts, startedAt: undefined })
    expect(stepElapsed(pending, NOW)).toEqual({ ms: 120_000, live: false })
  })

  it('a pending step with no attempts still returns undefined (unchanged)', () => {
    expect(stepElapsed(step('pending'), NOW)).toBeUndefined()
  })

  it('a terminal step whose last attempt is open closes at step.finishedAt', () => {
    const attempts = [{ startedAt: at(0), finishedAt: at(60_000) }, { startedAt: at(60_000) }]
    const done = step('done', { attempts, startedAt: attempts[0]!.startedAt, finishedAt: at(100_000) })
    expect(stepElapsed(done, NOW)).toEqual({ ms: 60_000 + 40_000, live: false })
    expect(stepAttempts(done, NOW).map((r) => r.ms)).toEqual([60_000, 40_000])
  })

  it('stepAttempts on a record with no attempts returns []', () => {
    expect(stepAttempts(step('done'), NOW)).toEqual([])
  })

  describe('no partial sum is ever returned as a total', () => {
    it('mixed valid and invalid: the middle attempt has an unparseable startedAt', () => {
      const attempts = [
        { startedAt: at(0), finishedAt: at(60_000) },
        { startedAt: 'not-a-date', finishedAt: at(120_000) },
        { startedAt: at(120_000), finishedAt: at(180_000) },
      ]
      const done = step('done', { attempts, startedAt: attempts[0]!.startedAt, finishedAt: attempts[2]!.finishedAt })
      expect(stepElapsed(done, NOW)).toBeUndefined()
      const rows = stepAttempts(done, NOW)
      expect(rows.map((r) => r.ms)).toEqual([60_000, undefined, 60_000])
    })

    it('the pending-plus-open case: a pending step whose last attempt has no finishedAt', () => {
      const attempts = [{ startedAt: at(0), finishedAt: at(60_000) }, { startedAt: at(60_000) }]
      const pending = step('pending', { attempts, startedAt: undefined })
      expect(stepElapsed(pending, NOW)).toBeUndefined()
      const rows = stepAttempts(pending, NOW)
      expect(rows[1]).toEqual({ index: 2, startedAt: attempts[1]!.startedAt, ms: undefined, live: false })
    })

    it('terminal with an open last attempt and no usable step.finishedAt: undefined, not the closed sum', () => {
      const attempts = [{ startedAt: at(0), finishedAt: at(60_000) }, { startedAt: at(60_000) }]
      const done = step('done', { attempts, startedAt: attempts[0]!.startedAt, finishedAt: undefined })
      expect(stepElapsed(done, NOW)).toBeUndefined()
    })

    it('nothing above is ever NaN', () => {
      const attempts = [{ startedAt: 'garbage', finishedAt: 'also-garbage' }]
      const broken = step('done', { attempts, startedAt: 'garbage', finishedAt: 'also-garbage' })
      expect(stepElapsed(broken, NOW)).toBeUndefined()
      expect(stepAttempts(broken, NOW)[0]?.ms).toBeUndefined()
    })
  })
})
