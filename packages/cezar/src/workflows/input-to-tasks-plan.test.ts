import { describe, expect, it } from 'vitest'

import {
  INPUT_TO_TASKS_DISPATCH_STEP,
  INPUT_TO_TASKS_WORKFLOW,
  inputToTasksPlan,
  isBuiltInInputToTasks,
} from './types.ts'

describe('inputToTasksPlan', () => {
  it.each([
    [false, 2, false],
    [true, 3, true],
  ])('freezes auto-start=%s into the built-in step topology', (autoStart, count, hasDispatch) => {
    const plan = inputToTasksPlan(INPUT_TO_TASKS_WORKFLOW, autoStart)
    expect(plan.steps).toHaveLength(count)
    expect(plan.steps.some((step) => step.id === INPUT_TO_TASKS_DISPATCH_STEP)).toBe(hasDispatch)
  })

  it('returns the enabled plan unchanged', () => {
    expect(inputToTasksPlan(INPUT_TO_TASKS_WORKFLOW, true)).toBe(INPUT_TO_TASKS_WORKFLOW)
  })

  it('does not shape a same-named file workflow or another built-in', () => {
    const fileWorkflow = { ...INPUT_TO_TASKS_WORKFLOW, source: 'file' as const }
    const otherWorkflow = { ...INPUT_TO_TASKS_WORKFLOW, name: 'quick-task' }
    expect(isBuiltInInputToTasks(fileWorkflow)).toBe(false)
    expect(inputToTasksPlan(fileWorkflow, false)).toBe(fileWorkflow)
    expect(inputToTasksPlan(otherWorkflow, false)).toBe(otherWorkflow)
  })
})
