import type { StepAttempt, StepState, StepStatus } from '@loki-labs/better-cezar-api-client'
import { formatDuration } from '@/lib/format'

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
 * **SUPERSEDED 2026-08-29 by spec 2026-08-29-per-retry-step-timing.** The paragraph below
 * described a real gap: this function alone cannot see past the current attempt. It no longer
 * describes the rail as a whole — `stepAttempts`/`stepTotalElapsed` below now read every attempt
 * from `StepState.attempts`, and `StepClock`'s `total` branch renders their sum. `stepElapsed`
 * itself is unchanged and is still what a single-attempt step, and any step with no covering
 * `attempts` array, renders.
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

/**
 * One attempt, resolved for rendering (spec 2026-08-29-per-retry-step-timing). Returned only by
 * `stepAttempts`, which has already validated `startedAt`/`endedAt` and checked contiguity — a
 * `ResolvedAttempt` is never handed back unvalidated.
 */
export interface ResolvedAttempt {
  /** 1-based, and equal to index + 1; the predicate below has already checked contiguity. */
  n: number
  /** This attempt's own `startedAt`, VALIDATED (it parsed through `instant()`) and passed through
   *  unchanged, so the open attempt's row can hand it straight to `<LiveDuration/>`. */
  startedAt: string
  /** Elapsed ms, clamped at 0: `endedAt − startedAt` when closed, `now − startedAt` when open. */
  ms: number
  /** Open, therefore ticking. True for at most the LAST entry, and only on an active step. */
  live: boolean
}

/**
 * The per-attempt rows a retried step's tree renders, or `undefined` to render exactly today's
 * flat row. FAILS CLOSED: every clause below must hold, or this returns `undefined` — a partial or
 * malformed `attempts` array is a bug, not a fallback case, and summing one would silently
 * under-report rather than visibly break (spec 2026-08-29-per-retry-step-timing).
 */
export function stepAttempts(step: StepState, now: number): readonly ResolvedAttempt[] | undefined {
  const attempts = step.attempts
  if (!attempts || attempts.length === 0) return undefined
  // A drift check, not the mid-deploy handler: the store's eligibility gate stops a partial array
  // from ever being written, so a mismatch here means a bug shipped, not a routine legacy record.
  if (attempts.length !== step.iterations) return undefined
  const resolved: ResolvedAttempt[] = []
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt: StepAttempt | undefined = attempts[index]
    if (!attempt || attempt.n !== index + 1) return undefined
    const startedAt = instant(attempt.startedAt)
    if (startedAt === undefined) return undefined
    const isLast = index === attempts.length - 1
    if (attempt.endedAt === undefined) {
      // An open attempt in the middle of the array cannot be timed at all: `now` is the wrong end
      // for it, and treating it as zero would under-report.
      if (!isLast) return undefined
      // A terminal step with an open final attempt is a store bug, not a running clock — timing it
      // against `now` would print an interval that grows for as long as the page stays open and
      // then freezes wherever the last render happened to be.
      if (!ACTIVE_STEP_STATUSES.has(step.status)) return undefined
      resolved.push({ n: attempt.n, startedAt: attempt.startedAt, ms: Math.max(0, now - startedAt), live: true })
    } else {
      const endedAt = instant(attempt.endedAt)
      if (endedAt === undefined) return undefined
      resolved.push({ n: attempt.n, startedAt: attempt.startedAt, ms: Math.max(0, endedAt - startedAt), live: false })
    }
  }
  return resolved
}

/**
 * The step's headline clock once it has more than one attempt: the sum across attempts, live on
 * the open one. Defined ON TOP OF `stepAttempts`, not beside it — returns `undefined` for exactly
 * the inputs `stepAttempts` rejects, so the tree and the headline can never disagree about whether
 * this step has a readable history (spec 2026-08-29-per-retry-step-timing).
 */
export function stepTotalElapsed(
  step: StepState,
  now: number,
): { ms: number; closedMs: number; live: boolean; openStartedAt?: string } | undefined {
  const attempts = stepAttempts(step, now)
  if (!attempts || attempts.length === 0) return undefined
  const last = attempts[attempts.length - 1] as ResolvedAttempt
  const live = last.live
  const closedMs = attempts.reduce((sum, a) => sum + (a.live ? 0 : a.ms), 0)
  const ms = closedMs + (live ? last.ms : 0)
  return { ms, closedMs, live, openStartedAt: live ? last.startedAt : undefined }
}

/**
 * The `format` prop for the live aggregate clock: `<LiveDuration since={openStartedAt}
 * format={liveStepTotal(closedMs)}/>`. Clamps the OPEN attempt's own elapsed at zero before
 * adding it to the frozen `closedMs`, so the headline is monotonic by construction — it can stall
 * at `closedMs`, never dip below it (spec 2026-08-29-per-retry-step-timing).
 *
 * `LiveDuration` computes `format(now - start)` with no clamp of its own: `now` is the browser's
 * clock and `start` is a server-stamped instant, so a browser trailing the server makes `ms`
 * negative. `formatDuration`'s own clamp runs on the value it is HANDED, which is `closedMs + ms`
 * — after the addition — so it cannot protect a positive `closedMs` from a negative `ms`. Hoisted
 * into a named helper so the clamp cannot be dropped at one call site while the other keeps it.
 */
export function liveStepTotal(closedMs: number): (ms: number) => string {
  return (ms: number) => formatDuration(closedMs + Math.max(0, ms))
}
