# Brief — a task's steps don't show which LLM model each one actually ran on

**Task id:** 1f63eb07-a6f1-4c8c-a691-6684ee969e3e
**Step:** 1/8 — Gather the record (this document is a brief, not a spec; no code written here)

## Problem, in this repo's own terms

The owner's ask, verbatim: "in every task workflow step show what LLM models where used."
Read literally that's a display requirement on the RUN/TASK view (a running or completed
task's step list) — not on the abstract workflow template, which already shows something
adjacent to this (see below). Today neither the cockpit UI nor any API payload shows,
per step, which model actually executed it. There is a real gap underneath the display
gap: the *executed* model isn't even persisted per step in run state — only the *planned*
model (from the frozen workflow definition) is, and it can diverge from what really ran.

## What the record already decided (with citations)

- **`.ai/specs/2026-08-21-per-step-model-policy.md`** (status: implemented, commit `a5f04b0f`,
  deployed as `20260821T215646Z-a5f04b0f`) is the adjacent, already-shipped decision: every
  step of the built-in `spec-to-deploy` workflow now carries a **planned** `model` in its
  frozen `workflowDef` (`review-spec` = opus, the other seven steps = sonnet), per owner
  instruction 2026-08-21 quoted in that spec. Its own "API contracts" section states:
  *"`GET /api/v1/workflows` already serializes each step's `model`, so the cockpit's
  workflow view reports the policy without a UI change."* This claim is about the workflow
  **template/definition** view, and — confirmed by sub-agent investigation below — even
  there it only means the raw YAML *preview text* includes `model:` per step
  (`packages/web/src/lib/workflow-builder.ts:116`), not that any card or badge renders it
  visually. No spec, before or since, extends this to the run/task detail view, and no
  spec addresses the *executed* (as opposed to *planned*) model at all.
- KB/spec sweep (`cez kb search` × 3, full scan of `.ai/specs/` and `.ai/specs/briefs/`,
  `cezar todo list`, `git log --all -- packages/web/src`) found **nothing else on this
  topic** — see "Duplicate/in-flight work check" below. This is genuinely new scope, not
  a continuation.
- The closest structural precedent is **`.ai/specs/2026-08-20-step-and-tool-call-durations.md`**
  (status: done, commit `69b4a3de`) — it added start/finish timing to the same
  `StepRail` component this brief targets. It's the template for "add a small per-step
  fact to the step row," not a decision about models, but its component (`step-rail.tsx`)
  is exactly where a model label would be added.

## What code is actually involved (file:line)

**Planned model (already exists, per-step):**
- `packages/cezar/src/workflows/types.ts:14-91` — `WorkflowStepDef`, `model` field at
  line 21. Set today for `spec-to-deploy`'s eight steps per the 2026-08-21 policy.
- `packages/cezar/src/server/server.ts:4383` (`GET /workflows`) and the run's frozen
  `workflowDef` inside `GET /runs/:id` (`server.ts:4904-4908`, `runRecordSchema.workflowDef`
  at `packages/contract/src/runs.ts:427`) both already expose this planned value.

**Executed model (resolved, but not persisted per step — this is the actual gap):**
- `packages/cezar/src/workflows/run.ts:4832-4851`, inside `runAgentStep`:
  ```ts
  const stepBackend = step.runner ?? taskBackend;
  const normalized = normalizeModelForBackend(
    stepBackend,
    agentModelsLocked(this.repoRoot) ? undefined : step.model ?? input.model,
    ...
  );
  backendModel = normalized?.backendModel;
  this.store.updateRun(runId, {
    modelIdentity: normalized ? formatModelIdentity(normalized.identity) : undefined,
  });
  ```
  This is the one place the *actually resolved* model (after the `step.model ?? input.model`
  fallback chain and the `agentModelsLocked` override) is computed. It is written to
  `RunRecord.modelIdentity` — a single **run-level** field (`runs/store.ts:164`) — **on
  every step**, so it is silently overwritten each time a later step resolves a different
  model. After a multi-model run finishes, `modelIdentity` reflects only the *last* step's
  model; earlier steps' resolved identities are discarded, with no history kept.
  `backendModel` itself is passed transiently into `createRunner(stepBackend)` as a spawn
  arg and never persisted at all.
- `packages/cezar/src/runs/store.ts:65-105` — `stepStateSchema` (mirrored exactly in
  `packages/contract/src/runs.ts:64-102`). Fields present: `id, name, kind, status,
  iterations, tokensUsed, costUsd, startedAt, finishedAt, sessionId, backend, profileId,
  stopReason`. **No `model` or `modelIdentity` field exists on the step record.** Contrast
  with `backend` (per-step runner choice, e.g. Claude Code vs Codex): it *is* persisted
  per step, via `this.store.updateStep(runId, step.id, { sessionId, backend })` at
  `run.ts:3316, 4689, 4726` — proving the storage pattern exists and is already used for
  the sibling "which backend ran this step" fact, just not for model.

**UI — no per-step model is rendered anywhere today:**
- `packages/web/src/routes/task-thread/step-rail.tsx:76-111` (`StepRail`, the full step
  list) and `:221-264` (`WorkflowSteps`, the collapsed summary used by
  `run-header.tsx:285-288`) — both render name, `stopReason`, iterations, `kind · step N
  of M`, and the step clock. Neither renders a model.
- `packages/web/src/routes/task-thread/run-header.tsx:721-804` (`AgentBadge`) is the
  **only** model surfaced in the task view today, and it's run-scoped, not per-step: it
  reads `run.model ?? 'auto'` (line 732) and `run.modelIdentity` (line 753) — the same
  single, last-step-clobbered field from above — into one badge for the whole run. Line
  738 already demonstrates the "derive a per-step attribute from the last step that set
  it" pattern (`[...run.steps].reverse().find(step => step.profileId)`, for account
  attribution) — a workable but lossy shape if reused for model, since it would still only
  answer "what ran last," not "what ran step 3."
- `packages/web/src/routes/workflows/workflows.tsx` (`StepCardBody`, lines 819-907) — the
  workflow-template builder's step cards — also render no model chip; as noted above, the
  2026-08-21 spec's claim resolves to YAML-preview text only, not a rendered element,
  confirming there's no existing visual pattern to copy even for the *planned* model.

## Prior decision this would contradict, or complicate

Nothing is contradicted. But `.ai/specs/2026-08-21-per-step-model-policy.md`'s Risks
section already flags that `step.model` can be voided wholesale by `agentModelsLocked`,
and that model ids are unpinned aliases (`sonnet`/`opus`) resolved by the CLI at call
time. Both mean the **planned** model in `workflowDef` is not a reliable stand-in for
"what model was used" — reinforcing that this task needs the executed-model persistence
gap closed, not just a UI read of the existing planned field.

## Duplicate/in-flight work check

**None found.** `cezar todo list` returns empty (checked twice). Three targeted `cez kb
search` queries ("workflow view model display," "step model UI cockpit," "cost tracking
per step tokens") surface only the already-known 2026-08-21 policy spec and unrelated
token/cost-meter notes (`stats.ts` round-trip batching work). `git log --all --oneline --
packages/web/src` shows the most recent relevant commit is `69b4a3de` (step/tool-call
durations) — nothing about model display. No sibling worktree branch name or diff relates.

## Open questions a spec will have to settle

1. **Planned vs. executed.** The task says "what LLM models **were used**" (past tense) —
   read most naturally as the executed model, which per the gap above requires a schema
   change (add `model`/`modelIdentity` to `stepStateSchema`, both `runs/store.ts` and the
   `packages/contract` mirror) and a code change at `run.ts:4849-4851` to write it onto the
   step record in addition to (or instead of) the run-level field, mirroring how `backend`
   is already persisted per step. A cheaper, weaker option — reading the already-available
   *planned* `workflowDef.steps[].model` at render time — is faster to ship but can lie
   whenever `agentModelsLocked` voids it or the resolved model otherwise diverges from the
   plan. The spec needs to pick one explicitly rather than let this default silently.
2. **Where to render.** `StepRail` (full view) and/or `WorkflowSteps` (collapsed summary,
   `run-header.tsx:285-288`) are the natural per-step targets, following the durations
   precedent (`2026-08-20-step-and-tool-call-durations.md`). Should the run-level
   `AgentBadge` also change (e.g. to show a range/mix when steps differ), or stay as a
   single "current" indicator now that per-step detail exists elsewhere?
3. **Scope: this workflow only, or all workflows?** The 2026-08-21 policy only set `model`
   on `spec-to-deploy`'s steps; other workflows' steps have no planned model and fall
   through to `input.model` or a backend default. Does "every task workflow step" mean the
   display must handle steps with no explicit `model` too (showing the resolved fallback,
   not blank)?
4. **CLI surface.** AGENTS.md describes cezar as "a local cockpit (CLI + browser GUI)."
   No agent in this investigation checked whether the CLI (`cez run` / task-detail
   terminal output) has an equivalent step list that would also need a model column — this
   is an unexamined gap in this brief, not a settled non-requirement, and the spec step
   should check it explicitly.
5. **`agentModelsLocked` and no-model cases.** When a lock voids `step.model` entirely, or
   a step never resolves a model (unlikely but not proven impossible), what should the
   per-step display show — "auto," the backend default, or nothing? No record settles this.

## What I could not find

- No investigation of the CLI-side step/task display (open question 4 above) — all three
  research passes focused on the web cockpit (`packages/web`) and server/store code; the
  CLI's own run/task rendering path (if distinct from the API payload) was not traced.
- No explanation anywhere in the record for why `backend` was persisted per step but
  `model` was not when the step schema was designed — likely sequencing (per-step model
  is newer, added 2026-08-21, well after `stepStateSchema`'s `backend` field), not a
  deliberate exclusion, but no commit or spec text confirms that reading.

---

**Path:** `.ai/specs/briefs/2026-08-22-per-step-model-display.md`
