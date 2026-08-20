import type { StepState, StepStatus } from '@loki-labs/better-cezar-api-client'

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
 * The number is elapsed wall-clock for the CURRENT ATTEMPT. `run.ts` overwrites `startedAt` on
 * every retry, so a step wearing an `×3` badge shows attempt 3, not the three summed —
 * cumulative cost would need a persisted field that does not exist (spec risk R3).
 */
export function stepElapsed(step: StepState, now: number): { ms: number; live: boolean } | undefined {
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

/** Epoch ms for an ISO instant, or `undefined` for absent/unparseable — never `NaN` onward. */
function instant(iso: string | undefined): number | undefined {
  if (iso === undefined) return undefined
  const ms = new Date(iso).getTime()
  return Number.isNaN(ms) ? undefined : ms
}
