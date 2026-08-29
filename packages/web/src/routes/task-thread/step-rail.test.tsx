import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { StepState, StepStatus } from '@loki-labs/better-cezar-api-client'

import { activeStepIndex, railProgress, railVisual, StepRail, WorkflowSteps, type RailVisual } from './step-rail'

// spec 2026-08-29-step-retry-timing, Verification 4a — the disclosure's analytics call goes
// through `@/lib/analytics`'s `track()`; mocked here so the assertions are on what `StepRow`
// itself calls, independent of `track()`'s own delivery (covered by `lib/analytics.test.ts`).
const trackMock = vi.fn()
vi.mock('@/lib/analytics', () => ({ track: (...args: unknown[]) => trackMock(...args) }))

afterEach(() => {
  cleanup()
  trackMock.mockClear()
})

/** A store-shaped step (`RunRecord.steps` entry) with sensible defaults. */
const step = (id: string, status: StepStatus, extra: Partial<StepState> = {}): StepState => ({
  id,
  name: id,
  kind: 'agent',
  status,
  iterations: 1,
  tokensUsed: 0,
  ...extra,
})

describe('railVisual — the full StepStatus → glyph table', () => {
  it.each<[StepStatus, RailVisual]>([
    ['done', 'done'],
    ['running', 'active'],
    ['waiting', 'active'], // paused mid-step: still the live one
    ['review', 'active'], // parked at the gate: in flight until accepted
    ['failed', 'failed'],
    ['cancelled', 'failed'],
    ['pending', 'pending'],
    ['skipped', 'pending'], // never ran — the empty circle is honest
  ])('%s → %s', (status, visual) => {
    expect(railVisual(status)).toBe(visual)
  })
})

describe('railProgress — (terminal + 0.5·active) / total', () => {
  it.each<[string, StepStatus[], number]>([
    ['no steps', [], 0],
    ['all pending', ['pending', 'pending'], 0],
    ['one running of two (the mockup state)', ['running', 'pending'], 0.25],
    ['done + running + pending', ['done', 'running', 'pending'], 0.5],
    ['waiting and review are active too', ['done', 'waiting', 'review', 'pending'], 0.5],
    ['terminal failures still advance the bar', ['done', 'failed'], 1],
    ['skipped and cancelled are terminal', ['skipped', 'cancelled'], 1],
    ['all done', ['done', 'done'], 1],
  ])('%s → %d', (_name, statuses, fraction) => {
    expect(railProgress(statuses.map((status, i) => step(`s${i}`, status)))).toBe(fraction)
  })
})

describe('StepRail', () => {
  it('renders nothing without steps (worktree-less oddities stay honest)', () => {
    render(<StepRail runId="run-1" steps={[]} />)
    expect(document.querySelector('[data-slot="step-rail"]')).toBeNull()
  })

  it('one row per step with the mapped glyph, name, kind and position', () => {
    render(
      <StepRail runId="run-1"
        steps={[
          step('implement', 'done', { name: 'Do the task' }),
          step('verify', 'running', { name: 'Verify', kind: 'check' }),
          step('review', 'pending', { name: 'Review' }),
        ]}
      />,
    )
    const rows = [...document.querySelectorAll('[data-slot="step-row"]')]
    expect(rows.map((row) => row.getAttribute('data-visual'))).toEqual(['done', 'active', 'pending'])
    expect(rows[0]!.textContent).toContain('Do the task')
    expect(rows[0]!.textContent).toContain('agent · step 1 of 3')
    expect(rows[1]!.textContent).toContain('check · step 2 of 3')
    // The amber spinner announces itself; done/pending rows carry no live status.
    expect(screen.getAllByRole('status', { name: 'Step running' })).toHaveLength(1)
  })

  it('a failed step wears the danger X', () => {
    render(<StepRail runId="run-1" steps={[step('t', 'failed', { name: 'Do the task' })]} />)
    expect(document.querySelector('[data-slot="step-row"]')?.getAttribute('data-visual')).toBe('failed')
    expect(document.querySelector('[data-slot="step-row"] svg')?.getAttribute('class')).toContain('text-danger')
  })

  it('shows ×N only when a step actually iterated', () => {
    render(
      <StepRail runId="run-1"
        steps={[step('a', 'done', { iterations: 3 }), step('b', 'done')]}
      />,
    )
    const marks = [...document.querySelectorAll('[data-slot="step-iterations"]')]
    expect(marks).toHaveLength(1)
    expect(marks[0]!.textContent).toBe('×3')
  })

  it('draws the thin progress bar at the formula width', () => {
    render(<StepRail runId="run-1" steps={[step('a', 'done'), step('b', 'running'), step('c', 'pending'), step('d', 'pending')]} />)
    const bar = document.querySelector<HTMLElement>('[data-slot="step-progress"] > div')!
    expect(bar.style.width).toBe('37.5%') // (1 + 0.5) / 4
  })
})

/**
 * Which model ran each step (spec 2026-08-22-per-step-model-display). The owner ask this whole
 * feature exists for is "in every task workflow step show what LLM models were used" — PAST tense,
 * so these pin the EXECUTED value first and treat the planned one as a clearly-marked stand-in.
 */
describe('per-step model chip', () => {
  const modelOf = (row: Element) => row.querySelector('[data-slot="step-model"]')

  it('shows the model a step actually ran on', () => {
    render(<StepRail runId="run-1" steps={[step('a', 'done', { model: 'sonnet' })]} />)
    const chip = document.querySelector('[data-slot="step-model"]')!
    expect(chip.textContent).toBe('sonnet')
    expect(chip.getAttribute('data-source')).toBe('executed')
  })

  it('a multi-model chain shows each step its OWN model — the defect this spec exists to close', () => {
    render(
      <StepRail runId="run-1"
        steps={[
          step('spec', 'done', { model: 'sonnet' }),
          step('review-spec', 'done', { model: 'opus' }),
          step('implement', 'running', { model: 'sonnet' }),
        ]}
      />,
    )
    const rows = [...document.querySelectorAll('[data-slot="step-row"]')]
    expect(rows.map((row) => modelOf(row)?.textContent)).toEqual(['sonnet', 'opus', 'sonnet'])
  })

  it('keeps the canonical identity in the tooltip, not inline (the rail is one dense line)', () => {
    render(<StepRail runId="run-1" steps={[step('a', 'done', { model: 'opus', modelIdentity: 'anthropic/claude-opus-5' })]} />)
    const chip = document.querySelector('[data-slot="step-model"]')!
    expect(chip.textContent).toBe('opus')
    expect(chip.getAttribute('title')).toContain('anthropic/claude-opus-5')
  })

  it('an identity that merely repeats the ask adds no tooltip noise', () => {
    render(<StepRail runId="run-1" steps={[step('a', 'done', { model: 'opus', modelIdentity: 'opus' })]} />)
    expect(document.querySelector('[data-slot="step-model"]')?.getAttribute('title')).not.toContain('—')
  })

  it('under the model lock, an identity with no free-text ask still names what served the turn', () => {
    render(<StepRail runId="run-1" steps={[step('a', 'done', { modelIdentity: 'anthropic/claude-sonnet-5' })]} />)
    const chip = document.querySelector('[data-slot="step-model"]')!
    expect(chip.textContent).toBe('anthropic/claude-sonnet-5')
    expect(chip.getAttribute('data-source')).toBe('executed')
  })

  it("a pending step falls back to the run's PLANNED model, visibly marked as planned", () => {
    render(
      <StepRail runId="run-1"
        steps={[step('review-spec', 'pending')]}
        planned={[{ id: 'review-spec', model: 'opus' }]}
      />,
    )
    const chip = document.querySelector('[data-slot="step-model"]')!
    expect(chip.textContent).toBe('opus')
    expect(chip.getAttribute('data-source')).toBe('planned')
    expect(chip.getAttribute('title')).toMatch(/planned/i)
  })

  it("does not plan a model the run's backend cannot serve", () => {
    // Reported from production 2026-08-23 on run `da0119ec`: `spec-to-deploy` pins `sonnet`, a
    // Claude alias, on its six construction steps. Moved to codex, the engine drops the pin at
    // dispatch and says so on the transcript — while the rail went on rendering `sonnet`, so the
    // two surfaces disagreed and the rail is the one a reader scans.
    render(
      <StepRail runId="run-1" steps={[step('implement', 'pending')]} planned={[{ id: 'implement', model: 'sonnet' }]} runRunner="codex" />,
    )
    const chip = document.querySelector('[data-slot="step-model"]')!
    expect(chip.textContent).toBe('auto')
    expect(chip.getAttribute('data-source')).toBe('planned-dropped')
    // The plan is still a true fact about the WORKFLOW, so it is named rather than swallowed.
    expect(chip.getAttribute('title')).toMatch(/sonnet/)
  })

  it("keeps a planned model the STEP's own runner pin can serve", () => {
    // The negative control, and the whole reason this keys on the step rather than the run: a fix
    // that blanked every pin on a codex run would pass the case above and destroy this one.
    // `spec-to-deploy` pins `runner: claude` on `spec`/`review-spec` precisely so `opus` survives a
    // codex run — that chip is TRUE and must stay.
    render(
      <StepRail runId="run-1"
        steps={[step('review-spec', 'pending')]}
        planned={[{ id: 'review-spec', model: 'opus', runner: 'claude' }]}
        runRunner="codex"
      />,
    )
    const chip = document.querySelector('[data-slot="step-model"]')!
    expect(chip.textContent).toBe('opus')
    expect(chip.getAttribute('data-source')).toBe('planned')
  })

  it('a planned model on a matching runner is untouched', () => {
    // The pre-existing behaviour, pinned so the new branch cannot swallow the ordinary case.
    render(
      <StepRail runId="run-1" steps={[step('implement', 'pending')]} planned={[{ id: 'implement', model: 'sonnet' }]} runRunner="claude" />,
    )
    const chip = document.querySelector('[data-slot="step-model"]')!
    expect(chip.textContent).toBe('sonnet')
    expect(chip.getAttribute('data-source')).toBe('planned')
  })

  it('the executed model wins over the planned one — the def is only a stand-in', () => {
    render(<StepRail runId="run-1" steps={[step('s', 'done', { model: 'opus' })]} planned={[{ id: 's', model: 'sonnet' }]} />)
    const chip = document.querySelector('[data-slot="step-model"]')!
    expect(chip.textContent).toBe('opus')
    expect(chip.getAttribute('data-source')).toBe('executed')
  })

  it('neither executed nor planned reads auto, the same word the run-level badge uses', () => {
    render(<StepRail runId="run-1" steps={[step('a', 'pending')]} />)
    const chip = document.querySelector('[data-slot="step-model"]')!
    expect(chip.textContent).toBe('auto')
    expect(chip.getAttribute('data-source')).toBe('none')
  })

  it('a check step carries no chip at all — no agent, so no model to name', () => {
    render(<StepRail runId="run-1" steps={[step('gates', 'done', { kind: 'check' })]} planned={[{ id: 'gates', model: 'opus' }]} />)
    expect(document.querySelector('[data-slot="step-model"]')).toBeNull()
  })

  it('the collapsed summary carries the CURRENT step\'s model only', () => {
    render(
      <WorkflowSteps
        runId="model-summary"
        steps={[step('spec', 'done', { model: 'sonnet' }), step('review-spec', 'running', { model: 'opus' })]}
      />,
    )
    const chips = [...document.querySelectorAll('[data-slot="step-model"]')]
    expect(chips).toHaveLength(1)
    expect(chips[0]!.textContent).toBe('opus')
  })

  it('expanding the summary passes the planned models down to every row', () => {
    render(
      <WorkflowSteps
        runId="model-planned-passthrough"
        steps={[step('spec', 'running', { model: 'sonnet' }), step('review-spec', 'pending')]}
        planned={[
          { id: 'spec', model: 'sonnet' },
          { id: 'review-spec', model: 'opus' },
        ]}
      />,
    )
    fireEvent.click(screen.getByRole('button'))
    const rows = [...document.querySelectorAll('[data-slot="step-row"]')]
    expect(rows.map((row) => modelOf(row)?.textContent)).toEqual(['sonnet', 'opus'])
    expect(modelOf(rows[1]!)?.getAttribute('data-source')).toBe('planned')
  })
})

describe('activeStepIndex — who the summary speaks for', () => {
  it('points at the first in-flight step, else the last (a finished run reads "N of N")', () => {
    expect(activeStepIndex([step('a', 'done'), step('b', 'running'), step('c', 'pending')])).toBe(1)
    expect(activeStepIndex([step('a', 'done'), step('b', 'done')])).toBe(1)
    expect(activeStepIndex([step('a', 'pending'), step('b', 'pending')])).toBe(0)
    // An empty list has no index to point at; 0 keeps `steps[index]` undefined rather than
    // handing back a -1 that would silently address the wrong element.
    expect(activeStepIndex([])).toBe(0)
  })
})

describe('WorkflowSteps — the collapsible header summary', () => {
  const steps = [
    step('implement', 'done', { name: 'Do the task' }),
    step('verify', 'running', { name: 'Verify', kind: 'check' }),
    step('review', 'pending', { name: 'Review' }),
  ]
  /** Unique per test — the expand memory below is module-level and keyed by run id. */
  let seq = 0
  const freshRun = () => `run-steps-${(seq += 1)}`

  it('renders nothing without steps', () => {
    render(<WorkflowSteps runId={freshRun()} steps={[]} />)
    expect(document.querySelector('[data-slot="workflow-steps"]')).toBeNull()
  })

  it('collapsed by default: names the active step, one dot per step, and hides the full rows', () => {
    render(<WorkflowSteps runId={freshRun()} steps={steps} />)
    const summary = document.querySelector('[data-slot="workflow-steps"]')!
    expect(summary.textContent).toContain('Verify')
    expect(summary.textContent).toContain('step 2 of 3')
    const dots = [...document.querySelectorAll('[data-slot="step-dot"]')]
    expect(dots.map((dot) => dot.getAttribute('data-visual'))).toEqual(['done', 'active', 'pending'])
    // The full rows are not mounted until the user expands.
    expect(document.querySelector('[data-slot="step-row"]')).toBeNull()
  })

  it('expands to the full rail on click', () => {
    render(<WorkflowSteps runId={freshRun()} steps={steps} />)
    fireEvent.click(screen.getByRole('button'))
    const rows = [...document.querySelectorAll('[data-slot="step-row"]')]
    expect(rows.map((row) => row.getAttribute('data-visual'))).toEqual(['done', 'active', 'pending'])
    expect(rows[1]!.textContent).toContain('check · step 2 of 3')
  })

  it('remembers an explicit expand per run across remounts — a tab switch must not collapse it', () => {
    const runId = freshRun()
    const first = render(<WorkflowSteps runId={runId} steps={steps} />)
    fireEvent.click(screen.getByRole('button'))
    expect(document.querySelector('[data-slot="step-row"]')).not.toBeNull()
    first.unmount()

    // Same run, remounted by another task route's RunHeader: still expanded.
    render(<WorkflowSteps runId={runId} steps={steps} />)
    expect(document.querySelector('[data-slot="step-row"]')).not.toBeNull()
  })

  it('does not leak that choice to a different run — a fresh run opens collapsed', () => {
    const first = render(<WorkflowSteps runId={freshRun()} steps={steps} />)
    fireEvent.click(screen.getByRole('button'))
    first.unmount()

    render(<WorkflowSteps runId={freshRun()} steps={steps} />)
    expect(document.querySelector('[data-slot="step-row"]')).toBeNull()
  })
})

/**
 * The step clock (spec 2026-08-20-step-and-tool-call-durations §Phase 1). A MEASUREMENT, never a
 * verdict: these assert a number is present and correct, and there is deliberately no threshold,
 * colour or "slow" label to assert on.
 */
describe('step clocks', () => {
  const clocks = () => Array.from(document.querySelectorAll('[data-slot="step-duration"], [data-slot="live-duration"]'))

  it('a running step ticks — a LEAF <time>, not a number frozen at render', () => {
    render(<StepRail runId="run-1" steps={[step('a', 'running', { startedAt: new Date(Date.now() - 62_000).toISOString() })]} />)
    const live = document.querySelector('[data-slot="live-duration"]')
    expect(live).not.toBeNull()
    expect(live!.textContent).toBe('1:02')
    expect(document.querySelector('[data-slot="step-duration"]')).toBeNull()
  })

  it('a finished step is frozen at finishedAt − startedAt', () => {
    render(
      <StepRail runId="run-1"
        steps={[step('a', 'done', { startedAt: '2026-08-20T14:24:46.939Z', finishedAt: '2026-08-20T14:28:58.939Z' })]}
      />,
    )
    const total = document.querySelector('[data-slot="step-duration"]')
    expect(total?.textContent).toBe('4:12')
    expect(document.querySelector('[data-slot="live-duration"]')).toBeNull()
  })

  it('a pending step renders no clock at all — an empty slot is honest, 0:00 is not', () => {
    render(<StepRail runId="run-1" steps={[step('a', 'pending')]} />)
    expect(clocks()).toHaveLength(0)
  })

  it('a step CEZAR stopped keeps its duration next to the pause glyph', () => {
    render(
      <StepRail runId="run-1"
        steps={[
          step('a', 'failed', {
            startedAt: '2026-08-20T14:24:46.939Z',
            finishedAt: '2026-08-20T14:26:58.939Z',
            stopReason: 'inactivity',
          }),
        ]}
      />,
    )
    expect(document.querySelector('[data-slot="step-duration"]')?.textContent).toBe('2:12')
    expect(document.querySelector('[data-slot="step-stop-reason"]')).not.toBeNull()
  })

  it('a six-step run: finished steps frozen, the active one ticking, pending ones blank', () => {
    render(
      <StepRail runId="run-1"
        steps={[
          step('spec', 'done', { startedAt: '2026-08-20T14:24:46.939Z', finishedAt: '2026-08-20T14:28:58.939Z' }),
          step('implement', 'running', { startedAt: new Date(Date.now() - 5_000).toISOString() }),
          step('tests', 'pending'),
          step('commit', 'pending'),
          step('document', 'pending'),
          step('deploy', 'pending'),
        ]}
      />,
    )
    expect(document.querySelectorAll('[data-slot="step-duration"]')).toHaveLength(1)
    expect(document.querySelectorAll('[data-slot="live-duration"]')).toHaveLength(1)
    expect(clocks()).toHaveLength(2)
  })

  it('the collapsed summary carries the CURRENT step\'s clock, so the common case needs no expand', () => {
    render(
      <WorkflowSteps
        runId="clock-summary"
        steps={[
          step('spec', 'done', { startedAt: '2026-08-20T14:24:46.939Z', finishedAt: '2026-08-20T14:28:58.939Z' }),
          step('implement', 'running', { startedAt: new Date(Date.now() - 90_000).toISOString() }),
        ]}
      />,
    )
    // Collapsed: exactly one clock, and it is the running step's.
    expect(clocks()).toHaveLength(1)
    expect(document.querySelector('[data-slot="live-duration"]')?.textContent).toBe('1:30')
  })

  it('every clock says what interval it measures', () => {
    render(
      <StepRail runId="run-1"
        steps={[step('a', 'done', { startedAt: '2026-08-20T14:24:46.939Z', finishedAt: '2026-08-20T14:28:58.939Z' })]}
      />,
    )
    expect(document.querySelector('[data-slot="step-duration"]')?.getAttribute('title')).toMatch(/current attempt/i)
  })

  // spec 2026-08-29-step-retry-timing, D4 + Verification 4 — the clock's `title` is
  // record-dependent: cumulative when `attempts` is present, the unchanged current-attempt
  // sentence when it is not. The case above (no `attempts`) is the fallback half and is left
  // unmodified — the strongest available proof that this spec did not disturb it.
  it("names the cumulative interval when attempts is present, and never claims 'current attempt'", () => {
    const attempts = [
      { startedAt: '2026-08-20T14:00:00.000Z', finishedAt: '2026-08-20T14:04:12.000Z' },
      { startedAt: '2026-08-20T14:10:00.000Z', finishedAt: '2026-08-20T14:12:40.000Z' },
    ]
    render(
      <StepRail runId="run-1"
        steps={[step('a', 'done', { startedAt: attempts[0]!.startedAt, finishedAt: attempts[1]!.finishedAt, attempts })]}
      />,
    )
    const title = document.querySelector('[data-slot="step-duration"]')?.getAttribute('title')
    expect(title).toContain('2 attempts')
    // The load-bearing half: a title that merely mentions a total while still promising the
    // current attempt must fail this.
    expect(title).not.toMatch(/current attempt/i)
  })
})

/**
 * The `×N` disclosure and per-attempt breakdown (spec 2026-08-29-step-retry-timing, Verification
 * 4). `data-slot` attributes throughout, per `AGENTS.md` §"Verifying a cockpit UI change".
 */
describe('the ×N disclosure and per-attempt breakdown (spec 2026-08-29-step-retry-timing)', () => {
  const CLOSED_ATTEMPTS = [
    { startedAt: '2026-08-20T14:00:00.000Z', finishedAt: '2026-08-20T14:04:12.000Z' },
    { startedAt: '2026-08-20T14:04:12.000Z', finishedAt: '2026-08-20T14:15:15.000Z' },
    { startedAt: '2026-08-20T14:15:15.000Z', finishedAt: '2026-08-20T14:17:55.000Z' },
  ]

  it('×3 stays a <span> when the step has no recorded attempts (pre-P1 shape)', () => {
    render(<StepRail runId="run-1" steps={[step('a', 'done', { iterations: 3 })]} />)
    const badge = document.querySelector('[data-slot="step-iterations"]')!
    expect(badge.tagName).toBe('SPAN')
    expect(badge.textContent).toBe('×3')
  })

  it('×3 is a <button aria-expanded="false"> when the step has >1 recorded attempt', () => {
    render(
      <StepRail runId="run-1" steps={[step('a', 'done', { iterations: 3, attempts: CLOSED_ATTEMPTS })]} />,
    )
    const badge = document.querySelector('[data-slot="step-iterations"]')!
    expect(badge.tagName).toBe('BUTTON')
    expect(badge.getAttribute('aria-expanded')).toBe('false')
    expect(badge.textContent).toBe('×3')
  })

  it('clicking it renders exactly 3 step-attempt rows, in startedAt order, then collapses on a second click', () => {
    render(
      <StepRail runId="run-1" steps={[step('a', 'done', { iterations: 3, attempts: CLOSED_ATTEMPTS })]} />,
    )
    expect(document.querySelector('[data-slot="step-attempts"]')).toBeNull()

    fireEvent.click(document.querySelector('[data-slot="step-iterations"]')!)
    expect(document.querySelector('[data-slot="step-iterations"]')?.getAttribute('aria-expanded')).toBe('true')
    const rows = [...document.querySelectorAll('[data-slot="step-attempt"]')]
    expect(rows).toHaveLength(3)
    expect(rows.map((r) => r.textContent)).toEqual(['attempt 1 · 4:12', 'attempt 2 · 11:03', 'attempt 3 · 2:40'])

    fireEvent.click(document.querySelector('[data-slot="step-iterations"]')!)
    expect(document.querySelector('[data-slot="step-attempts"]')).toBeNull()
  })

  it("the open attempt's row renders a live-duration, closed ones render a frozen <time>", () => {
    const attempts = [
      { startedAt: '2026-08-20T14:00:00.000Z', finishedAt: '2026-08-20T14:04:12.000Z' },
      { startedAt: new Date(Date.now() - 30_000).toISOString() },
    ]
    render(<StepRail runId="run-1" steps={[step('a', 'running', { iterations: 2, attempts })]} />)
    fireEvent.click(document.querySelector('[data-slot="step-iterations"]')!)

    const rows = [...document.querySelectorAll('[data-slot="step-attempt"]')]
    expect(rows).toHaveLength(2)
    expect(rows[0]!.querySelector('time')).not.toBeNull()
    expect(rows[0]!.querySelector('[data-slot="live-duration"]')).toBeNull()
    expect(rows[1]!.querySelector('[data-slot="live-duration"]')).not.toBeNull()
  })

  it("WorkflowSteps's collapsed trigger renders no step-attempts — the summary stays terse (D6)", () => {
    render(
      <WorkflowSteps
        runId="collapsed-no-breakdown"
        steps={[step('a', 'done', { name: 'Do the task', iterations: 3, attempts: CLOSED_ATTEMPTS })]}
      />,
    )
    expect(document.querySelector('[data-slot="step-attempts"]')).toBeNull()
    // Expanding the rail is what surfaces the disclosure — the collapsed header never gets one.
    fireEvent.click(screen.getByRole('button', { name: /Workflow:/ }))
    expect(document.querySelector('[data-slot="step-iterations"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="step-attempts"]')).toBeNull()
  })
})

/**
 * The `step.attempts_expanded` analytics event (spec 2026-08-29-step-retry-timing, Verification
 * 4a). `track()` itself is mocked at the top of this file — these assertions are on what
 * `StepRow` calls it WITH, not on delivery (`lib/analytics.test.ts` covers that).
 */
describe('step.attempts_expanded analytics (spec 2026-08-29-step-retry-timing)', () => {
  const attempts = [
    { startedAt: '2026-08-20T14:00:00.000Z', finishedAt: '2026-08-20T14:04:12.000Z' },
    { startedAt: '2026-08-20T14:04:12.000Z', finishedAt: '2026-08-20T14:15:15.000Z' },
  ]

  it('expanding emits exactly one event, with the exact runId the render passed to StepRail', () => {
    render(<StepRail runId="run-exact-42" steps={[step('ship', 'done', { iterations: 2, attempts })]} />)
    fireEvent.click(document.querySelector('[data-slot="step-iterations"]')!)

    expect(trackMock).toHaveBeenCalledTimes(1)
    expect(trackMock).toHaveBeenCalledWith('step.attempts_expanded', {
      runId: 'run-exact-42',
      stepId: 'ship',
      iterations: 2,
    })
  })

  it('collapsing emits none, and a second expand emits one more', () => {
    render(<StepRail runId="run-exact-42" steps={[step('ship', 'done', { iterations: 2, attempts })]} />)
    const badge = () => document.querySelector('[data-slot="step-iterations"]')!

    fireEvent.click(badge()) // expand — 1
    expect(trackMock).toHaveBeenCalledTimes(1)
    fireEvent.click(badge()) // collapse — no new call
    expect(trackMock).toHaveBeenCalledTimes(1)
    fireEvent.click(badge()) // expand again — 2
    expect(trackMock).toHaveBeenCalledTimes(2)
  })
})

