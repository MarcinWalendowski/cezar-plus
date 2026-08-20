import { describe, expect, it } from 'vitest'

import type { StepState, StepStatus } from '@loki-labs/better-cezar-api-client'

import { railVisual } from './step-rail'
import { ACTIVE_STEP_STATUSES, TERMINAL_STEP_STATUSES, stepElapsed } from './step-timing'

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
