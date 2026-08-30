import { describe, expect, it } from 'vitest'

import { createRunInputSchema } from '@loki-labs/better-cezar-contract'

/**
 * `createRunInputSchema` — the CONTRACT half of "at most one of workflow/steps" (spec
 * 2026-08-15-composer-stops-forcing-choices, D3). `packages/cezar/src/server/server.ts` keeps
 * its own private duplicate of this same refine for the route it actually validates against —
 * a known drift risk this codebase names explicitly. Exercising this schema directly (not just
 * through an HTTP round-trip against the server's copy) is what makes a regression in EITHER
 * spelling fail on its own: `run-source-fallback.test.ts` (packages/cezar) covers the server's
 * copy, this file covers the contract's.
 */
describe('createRunInputSchema — at most one of workflow/steps', () => {
  const base = { task: 'do the thing' }

  it('validates with neither workflow nor steps present', () => {
    expect(createRunInputSchema.safeParse(base).success).toBe(true)
  })

  it('validates with only workflow', () => {
    expect(createRunInputSchema.safeParse({ ...base, workflow: 'quick-task' }).success).toBe(true)
  })

  it('validates with only steps', () => {
    expect(
      createRunInputSchema.safeParse({
        ...base,
        steps: [{ id: 'task', prompt: '{{task}}' }],
      }).success,
    ).toBe(true)
  })

  it('rejects a body naming BOTH workflow and steps', () => {
    const result = createRunInputSchema.safeParse({
      ...base,
      workflow: 'quick-task',
      steps: [{ id: 'task', prompt: '{{task}}' }],
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message).join('; ')).toContain('not both')
    }
  })
})

/**
 * Composer review-step toggles (`.ai/specs/2026-08-30-composer-review-step-toggles.md`). The
 * filtering itself is server-side (`applyReviewStepToggles`); this only pins that the contract
 * accepts the two fields, matching the server's own duplicate schema per this file's own header.
 */
describe('createRunInputSchema — review-step toggles', () => {
  const base = { task: 'do the thing' }

  it('validates with neither field present', () => {
    expect(createRunInputSchema.safeParse(base).success).toBe(true)
  })

  it('validates with either or both booleans', () => {
    expect(createRunInputSchema.safeParse({ ...base, reviewSameModel: false }).success).toBe(true)
    expect(createRunInputSchema.safeParse({ ...base, reviewCrossModel: false }).success).toBe(true)
    expect(
      createRunInputSchema.safeParse({ ...base, reviewSameModel: false, reviewCrossModel: false })
        .success,
    ).toBe(true)
  })
})
