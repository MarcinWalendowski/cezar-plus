import { describe, expect, it } from 'vitest'

import type { StepState } from '@loki-labs/better-cezar-api-client'
import record from '../../../e2e/fixtures/retry-timing-run.record.json'
import { stepAttempts, stepElapsed } from './step-timing'

/**
 * Guards the E2E's fixture, in jsdom, because the E2E itself cannot be relied on to do it.
 *
 * `retry-step-timing.e2e.ts` asserts three exact strings — `attempt 1 · 0:01`, and a `0:06`
 * aggregate — but `.ai/scripts/e2e.sh` exits 0 with `TEST_E2E_STATUS=skipped` on any machine that
 * cannot launch a browser, which is most of them. So on a normal `npm test` run nothing reads
 * this fixture at all, and a drift in it (or in the readers) would surface only on the one box
 * that runs the browser suite.
 *
 * That matters more than usual here: the record was captured against a different, dropped
 * implementation of this feature and rewritten field by field to `main`'s stored shape
 * (`endedAt` → `finishedAt`, per-attempt `n` removed) — see `e2e/fixtures/README.md`. A
 * hand-edited record is exactly the kind that starts producing different numbers with nothing red.
 *
 * It asserts the two things the E2E's strings are computed from — the stored shape, and what the
 * pure readers make of it — not the rendering, which `step-rail.test.tsx` already covers against
 * its own fixtures. The `web` package deliberately does not depend on `@loki-labs/better-cezar-contract`,
 * so the shape is checked structurally rather than by running the zod schema.
 */
describe('the retry-timing E2E fixture, checked where the E2E cannot run', () => {
  const steps = (record as { steps: StepState[] }).steps
  const gate = steps.find((step) => step.id === 'gate')!
  const NOW = Date.parse('2026-08-29T00:01:00.000Z')

  it("carries main's attempt shape after the rewrite, with no `endedAt` left anywhere", () => {
    // The rename is the whole risk, and it fails QUIETLY: `endedAt` is not an ignored extra field,
    // it is simply not read — so a missed one leaves an attempt that reads as still OPEN, which
    // `stepAttempts` reports as unmeasurable rather than as invalid.
    expect(JSON.stringify(record)).not.toContain('endedAt')
    expect(gate.attempts).toHaveLength(3)
    for (const attempt of gate.attempts ?? []) {
      expect(typeof attempt.startedAt).toBe('string')
      expect(typeof attempt.finishedAt).toBe('string')
    }
    // Both steps, not just the one the E2E reads: `work` sharing the defect would make the next
    // assertion someone adds silently wrong.
    expect(steps.flatMap((step) => step.attempts ?? []).every((a) => a.finishedAt !== undefined)).toBe(true)
  })

  it('yields the exact per-attempt intervals the E2E asserts as strings', () => {
    const attempts = stepAttempts(gate, NOW)
    expect(attempts.map((attempt) => attempt.ms)).toEqual([1_000, 2_000, 3_000])
    // Never live: every attempt is closed and the step is terminal. A live one would render a
    // ticking node instead of a frozen `<time>`, and the E2E's exact string would race it.
    expect(attempts.map((attempt) => attempt.live)).toEqual([false, false, false])
  })

  it('yields the 0:06 aggregate the collapsed summary shows', () => {
    // The SUM — not the last attempt (3s), and not the outer startedAt→finishedAt span (also 3s).
    // Two wrong answers that are easy to produce, and that a 1s/2s/3s fixture tells apart on sight.
    expect(stepElapsed(gate, NOW)?.ms).toBe(6_000)
  })
})
