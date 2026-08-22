# Context-window denominator resolved per step, not per run

**Status: implemented, tested and shipped 2026-08-22.** Commit `7b1680a3` ("fix: resolve
context-window denominator per step, not per run"), on `origin/main`. Amends
`.ai/specs/2026-08-19-context-usage-in-tasks-table.md`'s "Roll up" bullet and `contextWindow`
field description in place (same commit) — see that file's two "Superseded 2026-08-22"
notices. Gates green: targeted vitest for the touched files (203 passed), contract-parity
(1 passed), and the full gate suite (`npm run typecheck`, `npm test`, `test:unit`, `build`,
`test:package`) per the `run-tests` step of this same run. **Not yet observed in
production**: no `review-spec` (opus) step has been watched live crossing 200k tokens since
this deploys — the Context cell rendering the bare figure with no denominator is verified by
unit test only until that runtime case is actually seen. This file itself did not survive
this run's earlier `spec`/`review-spec` steps (a known worktree-reap issue silently drops
untracked edits mid-session, see `cezar/workspace-run-worktree-isolation.md`); it is
reconstructed here, in the `document` step, from the shipped commit and the run's own
handoff log so the citation to it (already live in the shipped code comments and the
2026-08-19 doc) resolves to a real file instead of a dangling spec id.

## TLDR

The tasks list and task detail showed a Context cell like `245k / 200k` — a used figure
bigger than its own stated max. The denominator was being guessed once per RUN from the
run's current model string; it is now resolved once per STEP, paired 1:1 with the same
step's own `contextTokens`, and withdrawn the instant that step's own observed tokens
disprove the guess.

## Problem

Owner report, 2026-08-22: "Context in tasks view list, and task details still shows eg
245k/200k so maximum content is incorrectly read." A used-over-max reading that exceeds its
own max is not a rendering bug, it is a wrong max.

## Root cause

Two independent defects, both inside `contextWindowForModel()` and the single call site
`.ai/specs/2026-08-19-context-usage-in-tasks-table.md`'s "Roll up" bullet had it recomputed
from:

- **(A) The guess had no escape hatch.** `contextWindowForModel` flat-buckets every Claude
  tier (opus/sonnet/haiku) to 200,000 with no branch for a real bigger window. Its only
  stated escape — a `[1m]` marker in the model string — is dead code: nothing in
  `model-identity.ts` ever emits that marker, so the 1M branch can never fire.
- **(B) Per-step model policy pairs the wrong denominator with the wrong numerator.**
  `.ai/specs/2026-08-21-per-step-model-policy.md` runs `review-spec` on **opus** while every
  other step of `spec-to-deploy` runs sonnet. `RunStore.updateStep` recomputed
  `run.contextWindow` from the RUN's CURRENT model on every patch, so a run's roll-up could
  pair one step's real `contextTokens` with a guess derived from a *different* step's model
  — numerator and denominator were never guaranteed to come from the same step, and opus's
  real window is evidently larger than the flat 200k guess (per the owner's report and the
  commit trailer of `7b1680a3`).

## What shipped

Three phases, one commit:

1. **Per-step resolution — `resolveContextWindow()` (new, `core/context-window.ts`).** A
   real backend-reported window wins outright, even over evidence that looks contradictory.
   Absent a report, the model-string guess (`contextWindowForModel`) is used UNLESS the
   step's own `observedTokens` already exceeds it, in which case the guess is provably wrong
   and withdrawn (`undefined`) rather than asserted anyway — this is the change that stops
   `245k / 200k` from ever rendering, including for a model whose real window nobody has
   modelled yet.
2. **Per-step storage.** New optional `contextWindow` on `StepState` (both the contract's
   `stepStateSchema` in `contract/src/runs.ts` and the internal schema in `runs/store.ts`),
   resolved once per `updateStep` patch. `reportedWindow` is read from the RAW incoming
   `patch.contextWindow` *before* the `Object.assign` merge — reading it from the
   already-merged `step.contextWindow` would let a stale stored guess masquerade as a fresh
   report on every subsequent call and permanently short-circuit the clamp. The run-level
   roll-up (`run.contextWindow`) now copies that SAME latest step's own resolved value
   instead of recomputing independently; a `resolveContextWindow` fallback is kept only for
   step records persisted before this field existed, and goes inert the first time that step
   is patched again under this code.
3. **Codex's real signal wired through.** `usage.updated` (already emitted by codex's
   `thread/tokenUsage/updated`, previously reached `handleRunnerUiEvent` and was silently
   dropped) is now cached per invocation as `reportedContextWindow` on `ActiveRun`'s usage
   state, persisted immediately so the record is current before the next tick, and threaded
   into every later `contextTokens`-bearing patch for that invocation (`context.updated` and
   the `turn.completed`-derived usage record) — reset at each `beginUsageInvocation` because
   a fresh backend process may report a different figure next time.

## Data model

| field | where | meaning |
|---|---|---|
| `StepState.contextWindow` | persisted per step | this step's own resolved max: real report, model-string guess, or withdrawn |
| `RunRecord.contextWindow` | persisted per run | copied from the latest agent step's own `StepState.contextWindow` |

Both fields are additive/optional, matching the 2026-08-19 fields (`contextTokens`) they sit
beside — an absent value means "predates this" or "not modelled", never zero.

## Risks

- **Codex is the only runner that reports a real window today.** Claude and opencode still
  run on the model-string guess — now honest about withdrawing itself when disproved, rather
  than asserting a number known to be wrong.
- **The withdrawal is a floor, not a full fix.** A step whose guess is wrong but whose
  `contextTokens` never happens to exceed it keeps showing the wrong (if plausible) number.
  Only a real per-runner report closes that gap fully; Claude reporting its own window, if
  the CLI ever exposes one, is the natural follow-up (see `cezar: show Claude's real usage
  windows` for the precedent of pulling a real number from a CLI instead of guessing one).

## Verification

- Unit — `context-window.test.ts`: `resolveContextWindow` matrix (report wins over guess;
  guess withdrawn once `observedTokens` disproves it; guess kept when not disproved; absent
  stays absent when nothing is known).
- Unit — `store.test.ts`: per-step resolution on `updateStep` (reportedWindow read from the
  pre-merge patch, `touchesContext` gate so an unrelated patch doesn't recompute), roll-up
  copies the latest step's own value rather than the run's current model, legacy fallback
  exercised for a step record with no stored `contextWindow`.
- Unit — `run.test.ts`: `usage.updated` caches `reportedContextWindow` on the invocation and
  threads it into both `context.updated` and the turn-completed usage record; confirmed reset
  on the next `beginUsageInvocation`.
- Contract parity: `contextWindow` on `stepStateSchema` round-trips both directions.
- Gates: targeted vitest for the four touched source files, 203 passed; contract-parity,
  1 passed; full gate suite (`typecheck`, `npm test`, `test:unit`, `build`, `test:package`)
  green, run by this run's own `run-tests` step.
- **Not run — stays open post-deploy.** The runtime check this run's own resume notes asked
  for: find or produce a live `review-spec` (opus) step whose `contextTokens` genuinely
  exceeds 200k, and confirm the Context cell in both the tasks list and task detail shows
  the bare figure with no denominator, rather than a division against a wrong guess. This is
  a production observation, not a gate, and cannot happen before `deploy` (this run's next
  step) ships the change.

## Sources

- `.ai/specs/2026-08-19-context-usage-in-tasks-table.md` — the spec this corrects (amended
  in place, same commit).
- `.ai/specs/2026-08-21-per-step-model-policy.md` — why `review-spec` is the step most likely
  to expose the bug (the one step pinned to opus while its siblings run sonnet).
- `packages/cezar/src/core/context-window.ts`, `packages/cezar/src/runs/store.ts`,
  `packages/cezar/src/workflows/run.ts`, `packages/contract/src/runs.ts` — the four changed
  source files (`context-window.test.ts`, `store.test.ts`, `run.test.ts` also touched, tests
  only).
- Commit `7b1680a3e7f66f0cf30c36a5f389d395b1be23d5`.
