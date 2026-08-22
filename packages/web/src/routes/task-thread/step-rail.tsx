import {
  ChevronDownIcon,
  CircleCheckIcon,
  CircleIcon,
  CirclePauseIcon,
  CircleXIcon,
  LoaderCircleIcon,
} from 'lucide-react'
import { useState } from 'react'

import type { StepState, StepStatus } from '@loki-labs/better-cezar-api-client'
import { LiveDuration } from '@/components/live-duration'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { formatDuration } from '@/lib/format'
import { cn } from '@/lib/utils'

import { ACTIVE_STEP_STATUSES, TERMINAL_STEP_STATUSES, stepElapsed } from './step-timing'

/**
 * The WORKFLOW step rail (spec §"Task thread" — steps ≠ plan: these are the run's own
 * `RunRecord.steps`, not the agent's todo checklist). Mercato startup-checklist style
 * (mockup `.step-rail`): one row per step — emerald check / amber spinner / faint circle /
 * danger X — over a thin amber progress bar. Check-step OUTPUT renders in the thread as
 * command cards (`thread-state.ts` `check-output`); this rail is only the state summary.
 */

/** The rail glyphs. Pure so the status → glyph table is testable without rendering. */
export type RailVisual = 'done' | 'active' | 'pending' | 'failed' | 'stopped'

/** What the glyph table reads. A STEP, not a bare status: a step cezar stopped is persisted
 *  `status: 'failed'` — `StepStatus` is a published union and widening it would break every
 *  exhaustive consumer — and `stopReason` is the only thing that says nothing errored. A bare
 *  status is still accepted, for the callers that genuinely only have one. */
export type RailStep = Pick<StepState, 'status'> & { stopReason?: StepState['stopReason'] }

/**
 * A step CEZAR stopped is not a step that failed. The run that motivated this had two steps whose
 * code was written, gates green and commit made, and whose rail showed a red X — the owner had to
 * hand-annotate the handoff to say the kills were not failures. An amber pause glyph is what makes
 * the rail say it instead.
 */
export function railVisual(step: RailStep | StepStatus): RailVisual {
  const status = typeof step === 'string' ? step : step.status
  const stopReason = typeof step === 'string' ? undefined : step.stopReason
  if (status === 'failed') return stopReason ? 'stopped' : 'failed'
  switch (status) {
    case 'done':
      return 'done'
    case 'running':
    case 'waiting': // the agent paused mid-step — the step is still the live one
    case 'review': // parked at the review gate — same: in flight until accepted
      return 'active'
    // `failed` is handled above, where `stopReason` splits a stop from a real failure — so the
    // narrowed union here no longer contains it.
    case 'cancelled':
      return 'failed'
    case 'pending':
    case 'skipped': // never ran — an empty circle is the honest glyph
      return 'pending'
  }
}

/** Mercato's bar formula, `(done + 0.5·running) / total`, generalized over the real status
 *  set: any TERMINAL step counts 1 (the bar measures progress through the workflow, not
 *  success), any ACTIVE one ½, pending 0. */
export function railProgress(steps: ReadonlyArray<Pick<StepState, 'status'>>): number {
  if (steps.length === 0) return 0
  let score = 0
  for (const step of steps) {
    if (TERMINAL_STEP_STATUSES.has(step.status)) score += 1
    else if (ACTIVE_STEP_STATUSES.has(step.status)) score += 0.5
  }
  return score / steps.length
}

export function StepRail({ steps, planned }: { steps: StepState[]; planned?: PlannedSteps }) {
  if (steps.length === 0) return null
  const pct = railProgress(steps) * 100
  return (
    <div data-slot="step-rail" className="flex min-w-0 flex-col gap-1">
      {steps.map((step, index) => (
        <div
          key={step.id}
          data-slot="step-row"
          data-visual={railVisual(step)}
          className="flex min-h-[22px] min-w-0 items-center gap-2 text-[13px] text-muted-foreground"
        >
          <RailIcon visual={railVisual(step)} />
          <span className="min-w-0 truncate font-medium text-foreground">{step.name}</span>
          {step.stopReason ? (
            <span data-slot="step-stop-reason" className="shrink-0 text-xs text-pending-strong">
              stopped — no output
            </span>
          ) : null}
          {step.iterations > 1 ? (
            <span data-slot="step-iterations" className="shrink-0 text-xs text-soft-foreground tabular-nums">
              ×{step.iterations}
            </span>
          ) : null}
          <StepModel step={step} planned={planned} />
          <span className="ml-auto shrink-0 pl-2 text-[11.5px] text-soft-foreground tabular-nums">
            {step.kind} · step {index + 1} of {steps.length}
          </span>
          <StepClock step={step} />
        </div>
      ))}
      <div data-slot="step-progress" className="mt-1 h-0.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-pending" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

/** The run's own frozen `workflowDef.steps` — the model each step was PLANNED to use, which is the
 *  only thing that can answer for a step that has not run yet. `StepState` alone cannot: a
 *  `pending` step has no execution facts. Optional everywhere, so the bare `<StepRail steps={…}/>`
 *  call sites (tests, and any future caller without a def in hand) keep compiling. */
export type PlannedSteps = ReadonlyArray<{ id: string; model?: string | undefined }>

/**
 * Which LLM model ran this step (spec 2026-08-22-per-step-model-display).
 *
 * Three-way, deliberately — a single `auto` fallback would be a lie on the common case. The rail
 * renders `pending` steps too, and a run's frozen `workflowDef` already names a model for several
 * of them (`spec-to-deploy` puts `review-spec` on opus and its other steps on sonnet), so `auto`
 * next to a not-yet-run `review-spec` would contradict the run's own definition:
 *
 *  1. the EXECUTED model, when the step has resolved one — what actually ran;
 *  2. else the PLANNED model from the def, rendered dimmed and marked as planned, so it can never
 *     be mistaken for what ran;
 *  3. else `auto` — the same word `AgentBadge` uses at the run level for the true no-data case.
 *
 * `check` steps never reach `runAgentStep` and never resolve a model; they get no chip at all
 * rather than an `auto` that suggests an agent was involved.
 *
 * The identity (`provider/model`) stays in the tooltip rather than inline, mirroring how
 * `AgentBadge` keeps `modelIdentity` out of its own truncating summary — the rail is already a
 * dense single line, and the free-text ask (`opus`, `sonnet`) is the part a reader scans.
 */
function StepModel({ step, planned }: { step: StepState; planned?: PlannedSteps }) {
  if (step.kind !== 'agent') return null
  const executed = step.model
  // Only when it says something `model` does not — the same `identity !== model` guard AgentBadge
  // applies, for the same reason: repeating the ask back is noise, a different provider is not.
  const identity = step.modelIdentity && step.modelIdentity !== executed ? step.modelIdentity : undefined
  if (executed !== undefined) {
    return (
      <span
        data-slot="step-model"
        data-source="executed"
        title={identity ? `Model this step ran on — ${identity}` : 'Model this step ran on.'}
        className="min-w-0 shrink truncate font-mono text-[11px] text-soft-foreground"
      >
        {executed}
      </span>
    )
  }
  // An identity with no free-text ask is what a run under the agent-model LOCK looks like: nothing
  // was asked for, but something concrete still served the turn. Show what served it.
  if (identity !== undefined) {
    return (
      <span
        data-slot="step-model"
        data-source="executed"
        title="Model this step ran on."
        className="min-w-0 shrink truncate font-mono text-[11px] text-soft-foreground"
      >
        {identity}
      </span>
    )
  }
  const plannedModel = planned?.find((def) => def.id === step.id)?.model
  if (plannedModel !== undefined) {
    return (
      <span
        data-slot="step-model"
        data-source="planned"
        title="Planned by this workflow — this step has not resolved a model yet."
        className="min-w-0 shrink truncate font-mono text-[11px] text-soft-foreground/70 italic"
      >
        {plannedModel}
      </span>
    )
  }
  return (
    <span
      data-slot="step-model"
      data-source="none"
      title="No model recorded for this step — the agent's own default."
      className="shrink-0 font-mono text-[11px] text-soft-foreground/70"
    >
      auto
    </span>
  )
}

/** The interval every step clock measures, said in the one place a reader can hover.
 *  `iterations > 1` overwrites `startedAt` per attempt, so it is the CURRENT attempt (risk R3),
 *  and a step parked on an ask keeps counting because it is still the live step (risk R4). */
const STEP_CLOCK_TITLE = 'Elapsed since this step started (the current attempt).'

/**
 * How long this step has been going, or how long it took — right-aligned at the end of the row
 * (spec 2026-08-20-step-and-tool-call-durations §Phase 1).
 *
 * A MEASUREMENT, never a verdict: no threshold, no colour change, no "slow". Silence is the
 * liveness signal (spec 2026-08-20-agent-step-inactivity-timeout), and a long step is not a hung
 * one. A pending step renders nothing rather than a zero.
 *
 * The live case delegates to `<LiveDuration/>` so the 1s tick stays inside one `<time>`; owning
 * a `useNow` here would re-render all six rows every second (spec risk R2, pinned by the design
 * guardian's `no-tick-in-thread-containers` rule).
 */
function StepClock({ step, className }: { step: StepState; className?: string }) {
  const elapsed = stepElapsed(step, Date.now())
  if (elapsed === undefined) return null
  const tone = cn('shrink-0 text-[11.5px] text-soft-foreground tabular-nums', className)
  if (elapsed.live) {
    return <LiveDuration since={step.startedAt} label="Running for" title={STEP_CLOCK_TITLE} className={tone} />
  }
  return (
    <time
      data-slot="step-duration"
      dateTime={step.finishedAt}
      title={STEP_CLOCK_TITLE}
      className={tone}
    >
      {formatDuration(elapsed.ms)}
    </time>
  )
}

function RailIcon({ visual }: { visual: RailVisual }) {
  const base = 'size-[13px] shrink-0'
  switch (visual) {
    case 'done':
      return <CircleCheckIcon aria-hidden className={cn(base, 'text-success')} />
    case 'active':
      return (
        <LoaderCircleIcon
          role="status"
          aria-label="Step running"
          // stroke-pending, not text-*: amber is a dot & spinner color only (guardian rule).
          className={cn(base, 'animate-spin stroke-pending motion-reduce:animate-none')}
        />
      )
    case 'failed':
      return <CircleXIcon aria-hidden className={cn(base, 'text-danger')} />
    case 'stopped':
      // A pause glyph, not an X: cezar stopped this step at a bound, nothing errored.
      return <CirclePauseIcon aria-hidden className={cn(base, 'text-pending-strong')} />
    case 'pending':
      return <CircleIcon aria-hidden className={cn(base, 'text-soft-foreground')} />
  }
}

/** The step the summary line speaks for: the first ACTIVE step (running/waiting/review); else the
 *  next step still to run (first pending), so a not-yet-started or between-steps run reads honestly;
 *  else the last step, so a finished workflow reads "step N of N". */
export function activeStepIndex(steps: ReadonlyArray<RailStep>): number {
  const active = steps.findIndex((step) => railVisual(step) === 'active')
  if (active >= 0) return active
  const pending = steps.findIndex((step) => railVisual(step) === 'pending')
  if (pending >= 0) return pending
  // `steps.length - 1` would hand an empty list back a -1 that indexes nothing; 0 keeps every
  // caller's `steps[index]` honest (undefined for an empty list, never a silent wrong element).
  return Math.max(0, steps.length - 1)
}

/** One status dot in the collapsed summary — the rail's four glyphs compressed to a color.
 *  Amber (`bg-pending`) stays a dot-only color per the guardian rule. */
function StepDot({ visual }: { visual: RailVisual }) {
  const tone =
    visual === 'done'
      ? 'bg-success'
      : visual === 'failed'
        ? 'bg-danger'
        : // amber, like `active` — a stopped step is a decision waiting, not an outcome
        visual === 'active' || visual === 'stopped'
          ? 'bg-pending'
          : 'bg-soft-foreground'
  return (
    <span
      aria-hidden
      data-slot="step-dot"
      data-visual={visual}
      className={cn('size-1.5 rounded-full', tone, visual === 'active' && 'animate-pulse motion-reduce:animate-none')}
    />
  )
}

/** Expand memory per run id — the same module-level map the Agents dock keeps (`openByRun` in
 *  agents-dock.tsx), for the same reason: `RunHeader` is rendered separately by each of the four
 *  task routes, so without it a Session → Changes → Commits hop would throw the reader's explicit
 *  expand away every time. Session-lifetime only; no server persistence invented for it. */
const openByRun = new Map<string, boolean>()

/**
 * The step rail as it sits in the run header: a ONE-LINE summary by default — a dot per step,
 * the current step's name, its position, and the progress bar — so the sticky header stays
 * shallow and the thread gets the vertical room. Clicking it expands the full `StepRail`.
 * Collapsed by default because the summary already answers "where is this run?" at a glance;
 * an explicit expand is remembered for that run across tab switches.
 */
export function WorkflowSteps({
  runId,
  steps,
  planned,
}: {
  runId: string
  steps: StepState[]
  planned?: PlannedSteps
}) {
  const [open, setOpen] = useState(() => openByRun.get(runId) ?? false)
  if (steps.length === 0) return null
  const toggle = (next: boolean) => {
    openByRun.set(runId, next)
    setOpen(next)
  }
  const index = activeStepIndex(steps)
  const current = steps[index]!
  const pct = railProgress(steps) * 100
  return (
    <Collapsible data-slot="workflow-steps" open={open} onOpenChange={toggle} className="min-w-0">
      <CollapsibleTrigger
        aria-label={`Workflow: ${current.name}, step ${index + 1} of ${steps.length}`}
        className="group flex min-h-[30px] w-full items-center gap-2.5 text-left text-xs text-muted-foreground hover:text-foreground"
      >
        <span data-slot="step-dots" className="flex shrink-0 items-center gap-1">
          {steps.map((step) => (
            <StepDot key={step.id} visual={railVisual(step)} />
          ))}
        </span>
        <span className="min-w-0 max-w-[45%] shrink truncate font-semibold text-foreground">{current.name}</span>
        <span className="shrink-0 text-soft-foreground tabular-nums">
          step {index + 1} of {steps.length}
        </span>
        {/* The current step's model and clock, so the common (collapsed) case answers "what is
            this running on, and for how long" without an expand. Current step only — one chip per
            dot would drown the summary line the dots exist to keep terse. */}
        <StepModel step={current} planned={planned} />
        <StepClock step={current} />
        <span data-slot="step-summary-progress" className="h-0.5 min-w-[36px] flex-1 overflow-hidden rounded-full bg-muted">
          <span className="block h-full rounded-full bg-pending" style={{ width: `${pct}%` }} />
        </span>
        <ChevronDownIcon
          aria-hidden
          className="size-4 shrink-0 text-soft-foreground transition-transform group-data-[state=open]:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="pt-2">
          <StepRail steps={steps} planned={planned} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
