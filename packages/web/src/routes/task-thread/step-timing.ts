import type { StepAttempt, StepState, StepStatus } from '@loki-labs/cezar-plus-api-client'

/**
 * Step clocks and the status sets they share with the rail (spec
 * 2026-08-20-step-and-tool-call-durations §Phase 1).
 *
 * This module sits BELOW `step-rail.tsx` in the import graph on purpose: the rail renders the
 * clock, so the clock cannot import the rail without a cycle. The two status sets live here
 * instead, and `railProgress` reads them from here — which also deletes the copy it used to
 * keep inline.
 */

/** In flight. Exactly the statuses `railVisual` maps to `'active'` — a step paused mid-work
 *  (`waiting`, on an unanswered ask) or parked at a review gate is still the live step, and a
 *  clock that stopped while the glyph kept spinning would read as a bug (spec risk R4). */
export const ACTIVE_STEP_STATUSES: ReadonlySet<StepStatus> = new Set(['running', 'waiting', 'review'])

/** Ran and is over, however it ended. `failed` is terminal whether it errored or cezar stopped
 *  it at a bound — a stopped step still ran, and still has a duration worth showing. */
export const TERMINAL_STEP_STATUSES: ReadonlySet<StepStatus> = new Set(['done', 'failed', 'cancelled', 'skipped'])

export interface StepElapsed {
  /** Total ms across every recorded attempt, including the live one measured at `now`. */
  ms: number
  live: boolean
  /** Live only: the ISO instant the ticking leaf counts from (the open attempt's start). */
  since?: string
  /** Live only: ms already banked by the closed attempts, added on top of the leaf's tick. */
  offsetMs?: number
}

export interface StepAttemptElapsed {
  /** 1-based, matching the `iteration` the engine emits on `step-start`. */
  index: number
  startedAt: string
  /** `undefined` = UNMEASURABLE — unparseable timestamps, or an attempt left open with no honest
   *  end (the pending-plus-open case below). Render an em-space, never `NaN:0-3`. The same
   *  condition makes `stepElapsed` return `undefined` for the whole step: the row still appears,
   *  the total does not. */
  ms: number | undefined
  live: boolean
}

/**
 * How long a workflow step has been going, or how long it took. Pure and `now`-injected so the
 * tests are not racing the clock, exactly like `shortAge`.
 *
 * `live: true` means the clock is still counting and the caller should render a ticking
 * `<LiveDuration/>` LEAF rather than a frozen number — never a `useNow` in the rail's own body,
 * which would re-render every row once a second (spec risk R2).
 *
 * `undefined` means RENDER NOTHING: a pending or skipped step, a record written before
 * `startedAt` existed, an unparseable timestamp, or a terminal step that somehow never got its
 * `finishedAt`. An empty slot is honest; `NaN:0-3` is not (spec risk R6).
 *
 * **CORRECTED 2026-08-29 by spec 2026-08-29-step-retry-timing, which closes the deferral this
 * paragraph used to record.** It used to read: *"The number is elapsed wall-clock for the
 * CURRENT ATTEMPT. `run.ts` overwrites `startedAt` on every retry, so a step wearing an `×3`
 * badge shows attempt 3, not the three summed — cumulative cost would need a persisted field
 * that does not exist (spec risk R3)."* That field now exists (`StepState.attempts`, spec
 * 2026-08-29-step-retry-timing), so when it is present the number is the SUM of every recorded
 * attempt, not just the latest. A record with no `attempts` — every one written before that spec
 * landed, and any step that was already mid-flight when it shipped — falls back to exactly the
 * math above: elapsed wall-clock for the current (only-recorded) attempt. Presence of `attempts`
 * is the switch; see `stepAttempts` for the per-attempt breakdown this powers.
 *
 * A partial sum is never returned as a total: if any recorded attempt's interval is
 * unmeasurable, this returns `undefined` for the whole step rather than silently omitting it —
 * `stepAttempts` is where the reader sees which attempt lost its timing.
 */
export function stepElapsed(step: StepState, now: number): StepElapsed | undefined {
  const attempts = step.attempts
  if (!attempts || attempts.length === 0) {
    // Today's math, unchanged — the fallback every pre-P1 record, and every step that was
    // mid-flight when P1 landed, renders forever (the upgrade boundary in the writer).
    const start = instant(step.startedAt)
    if (start === undefined) return undefined
    // An ACTIVE step ignores `finishedAt` entirely: a re-run step keeps the previous attempt's
    // finish while `startedAt` is rewritten, so trusting it here would print a negative — or
    // absurd — duration for a step that is plainly running (spec risk R5).
    if (ACTIVE_STEP_STATUSES.has(step.status)) return { ms: Math.max(0, now - start), live: true }
    const end = instant(step.finishedAt)
    if (end === undefined) return undefined
    return { ms: Math.max(0, end - start), live: false }
  }

  const rows = stepAttempts(step, now)
  if (rows.some((row) => row.ms === undefined)) return undefined

  const active = ACTIVE_STEP_STATUSES.has(step.status)
  const lastAttempt = attempts[attempts.length - 1] as StepAttempt
  const lastOpen = lastAttempt.finishedAt === undefined

  if (active && lastOpen) {
    const closedMs = rows.slice(0, -1).reduce((sum, row) => sum + (row.ms ?? 0), 0)
    const lastRow = rows[rows.length - 1]
    return { ms: closedMs + (lastRow?.ms ?? 0), live: true, since: lastAttempt.startedAt, offsetMs: closedMs }
  }

  const totalMs = rows.reduce((sum, row) => sum + (row.ms ?? 0), 0)
  return { ms: totalMs, live: false }
}

/**
 * Per-attempt breakdown for the expanded rail (spec 2026-08-29-step-retry-timing, Phase 3).
 * Returns `[]` when `attempts` is absent — which is what keeps the `×N` badge on a pre-P1 record
 * an inert element instead of a disclosure that expands into nothing.
 */
export function stepAttempts(step: StepState, now: number): StepAttemptElapsed[] {
  const attempts = step.attempts
  if (!attempts || attempts.length === 0) return []
  const active = ACTIVE_STEP_STATUSES.has(step.status)
  const terminal = TERMINAL_STEP_STATUSES.has(step.status)
  const stepEnd = instant(step.finishedAt)
  return attempts.map((attempt, i) => {
    const index = i + 1
    const isLast = i === attempts.length - 1
    const start = instant(attempt.startedAt)
    if (start === undefined) return { index, startedAt: attempt.startedAt, ms: undefined, live: false }

    if (attempt.finishedAt !== undefined) {
      const end = instant(attempt.finishedAt)
      if (end === undefined) return { index, startedAt: attempt.startedAt, ms: undefined, live: false }
      return { index, startedAt: attempt.startedAt, ms: Math.max(0, end - start), live: false }
    }

    // An open attempt: measurable only as the LAST attempt of an ACTIVE step (the live tick), or
    // the last attempt of a TERMINAL step a crash left open (closed at `step.finishedAt`). Any
    // other shape — including the pending-plus-open case D3 exists to make unreachable — has
    // nothing honest to close at.
    if (isLast && active) return { index, startedAt: attempt.startedAt, ms: Math.max(0, now - start), live: true }
    if (isLast && terminal && stepEnd !== undefined) {
      return { index, startedAt: attempt.startedAt, ms: Math.max(0, stepEnd - start), live: false }
    }
    return { index, startedAt: attempt.startedAt, ms: undefined, live: false }
  })
}

/** Epoch ms for an ISO instant, or `undefined` for absent/unparseable — never `NaN` onward. */
function instant(iso: string | undefined): number | undefined {
  if (iso === undefined) return undefined
  const ms = new Date(iso).getTime()
  return Number.isNaN(ms) ? undefined : ms
}
