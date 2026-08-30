# Composer review-step toggles

**Status:** Implemented. Gates green: `typecheck:contract`/`typecheck:client`/`typecheck:server`/
`typecheck:web` all clean; full test suites `packages/contract` 25/25, `packages/api-client`
57/57, `packages/web` 4254/4254 (192 files), `packages/cezar` 7967/7971 (458 files, 4 pre-existing
skips unrelated to this change). **No runtime E2E has been executed yet** — starting a real
`spec-to-deploy` task from the composer with a toggle off and watching the step rail omit the
matching step. Ships as **QA needed** until that is run, per this repo's own Definition of Done.
**Date:** 2026-08-30
**Repo:** `cezar`

**Extends:**
`.ai/specs/2026-08-20-split-steps-spec-review-and-approval-gate.md` (introduced `review-spec`),
`.ai/specs/2026-08-29-step-resume-and-two-stage-review.md` (D2, introduced `review-spec-local` as
the same-provider pass in front of it — both steps are unconditional in every default-workflow
run today),
`.ai/specs/2026-08-24-default-workflow-ten-stages.md` (the ten-stage chain these two steps sit
in).

## TLDR

`spec-to-deploy` (and its codex sibling `spec-to-deploy-codex`) unconditionally run two spec
review stages after `spec`: `review-spec-local` (same runner+model as the writer) and
`review-spec` (a different provider). There is no way to turn either off per task. The owner asked
for two independent composer toggles — "same-model review" and "cross-model/provider review" —
that can each be on or off, both defaulting to today's behaviour (on), and that add or remove the
matching step from the workflow that actually runs.

The mechanism: two optional booleans on the run-creation request (`reviewSameModel`,
`reviewCrossModel`), applied by a new pure function, `applyReviewStepToggles`, that drops a step by
id from the resolved `WorkflowDef` before it is frozen onto the run record. It is generic over step
id, not over workflow name, so it applies to `spec-to-deploy`, `spec-to-deploy-codex`, and any
repo's own file override that happens to carry the same two step ids — the same pattern
`inputToTasksPlan` already uses to drop the `dispatch` step of `input-to-tasks` when auto-start is
off (`packages/cezar/src/workflows/types.ts:447-453`).

## Problem

`review-spec-local` (`types.ts:1317-1392`) and `review-spec` (`types.ts:1393-1470`) are two fixed
steps of the built-in `spec-to-deploy` chain. Every run that resolves to that workflow — which is
every run that names no workflow at all, since `spec-to-deploy` is `DEFAULT_WORKFLOW_NAME`
(`.ai/specs/2026-08-19-spec-to-deploy-default-workflow.md` P2) — pays for both review passes,
whether or not the task at hand needs a second (or a cross-provider) opinion on its spec. A trivial
task still gets a same-model review, a cross-provider review at `xhigh`/`high` effort, and a
possible human approval gate on top, none of which the composer offers any way to skip.

Nothing in the current mechanism supports removing a step conditionally per run: `resolveRunWorkflow`
(`server.ts:2792-2809`) picks a `WorkflowDef` whole, by name, inline `steps`, or the default floor,
and hands it unmodified to `guardRunStart`/`manager.startRun`, which freezes it onto the run record.

## Solution

### D1. Filter by step id, at the one place every run's workflow is resolved

A new pure function in `packages/cezar/src/workflows/types.ts`, beside `inputToTasksPlan` (the
existing precedent for dropping a named step from a resolved `WorkflowDef`):

```ts
/** The two step ids the composer's review toggles target. Named so the toggle and the step that
 *  defines self/cross-model review can never drift apart. */
export const REVIEW_SAME_MODEL_STEP_ID = 'review-spec-local';
export const REVIEW_CROSS_MODEL_STEP_ID = 'review-spec';

/**
 * Composer opt-out for `spec-to-deploy`'s two review stages. Both toggles default to `true`
 * (today's unconditional behaviour) — only an EXPLICIT `false` drops the matching step. Generic
 * over step id, not workflow name: applies to `spec-to-deploy`, its codex sibling, and any repo's
 * own file override that happens to carry the same ids. A workflow with neither id (`quick-task`,
 * `note-to-spec`, a skill's one-step inline chain, `input-to-tasks`) is returned unchanged.
 *
 * Safe to call unconditionally: `stepsIssue` is not re-run because neither id is ever an
 * `onFail.retry` TARGET in any built-in (`review-spec-local`/`review-spec` only retry OUT, to
 * `spec`) — removing one cannot leave a dangling backward reference.
 */
export function applyReviewStepToggles(
  def: WorkflowDef,
  opts: { reviewSameModel?: boolean; reviewCrossModel?: boolean },
): WorkflowDef {
  const drop = new Set<string>();
  if (opts.reviewSameModel === false) drop.add(REVIEW_SAME_MODEL_STEP_ID);
  if (opts.reviewCrossModel === false) drop.add(REVIEW_CROSS_MODEL_STEP_ID);
  if (drop.size === 0) return def;
  const steps = def.steps.filter((step) => !drop.has(step.id));
  return steps.length === def.steps.length ? def : { ...def, steps };
}
```

Applied inside `resolveRunWorkflow` (`server.ts:2792-2809`), wrapping every success return (the
inline-`steps` branch, the named-workflow branch, and the default-floor branch) — one choke point,
so every downstream consumer of the resolved `WorkflowDef` (the approval gate, the requirements
gate in `guardRunStart`, the step rail, the persisted `run.workflowDef`) sees the reduced step list
for free. Nothing downstream needs to know the toggles exist.

### D2. The two booleans ride the existing create-run body, default-on, sent only when off

Mirrors `worktree` (default-on, sent only when explicitly `false`) rather than `autonomous`
(default-off, sent only when explicitly `true`) — these two default to *today's* behaviour, which
is "on". An untouched composer therefore sends a byte-identical body to today's, and every
programmatic caller that already posts `workflow: 'spec-to-deploy'` (GitHub automation, the
bookmarklet auto-start, the automations-create default) keeps both review stages exactly as they
run today, with no changes needed at any of those call sites.

Two request bodies carry it, both funnelling through `resolveRunWorkflow`:

- `POST /runs` — the server's own local `startRunSchema` (`server.ts:942-1003`) and the contract's
  `createRunInputBaseSchema` (`packages/contract/src/runs.ts:1034-1069`) are two independent copies
  by design (`packages/api-client/src/create-run-input.test.ts`'s own header names this drift risk
  explicitly) — both gain the two fields.
- `POST /workspace/runs` — `workspaceRunStartInputSchema` is built by *omission* from
  `createRunInputBaseSchema` (`packages/contract/src/workspace-run-start.ts:44-63`), so it inherits
  the two new fields automatically; `workspace-run-routes.ts` only needs to thread them into its
  `deps.resolveWorkflow(...)` call the same way it already threads `workflow`/`steps`.

### D3. The composer shows the toggles only when they would do something

Two new chips in `new-task.tsx`, styled and behaviourally identical to the existing `WorktreeToggle`
(`new-task.tsx:951-987`) — checked = the step runs (the default), unchecked = it is dropped:

- **"Same-model review"** — checked title: *"Adds a review pass on the same model as the spec
  writer before the cross-model review — uncheck to skip it."*
- **"Cross-model review"** — checked title: *"Adds a review pass on a different model/provider
  before implementation begins — uncheck to skip it."*

**Shown only when the currently effective workflow actually carries the matching step id** — the
same "filtered, not disabled" doctrine `workflowsForScope` already applies to the workflow picker
itself (`new-task-form.ts:373-393`: *"a greyed-out control still reads as supported, just not right
now"* is the wrong read when the control would be silently discarded). Concretely: resolve the
effective workflow name (`source?.source === 'workflow' ? source.ref : 'spec-to-deploy'` — the same
fallback `github-task.ts`/`new-task-autostart.ts` already hardcode for "None resolves to the
default"), look its `steps` up in `workflowList` (already fetched via `useWorkflows()`), and check
for `'review-spec-local'`/`'review-spec'` by id. A skill pick (an inline one-step chain) or a named
workflow with neither id (`quick-task`, `note-to-spec`, a repo's own workflow) hides both chips —
exactly the "nothing lost by hiding an inert control" reasoning already used for
`worktreeToggleShown`/`followupsToggleShown` (`new-task.tsx:349-362`, `:392-397`).

### D4. Draft persistence mirrors `worktree`, not a new mechanism

`NewTaskDraft` gains two fields, `reviewSameModel: boolean | null` and `reviewCrossModel: boolean |
null` — `null` = untouched = the default (on). `readDraft`/`writeDraft`/`normalize` in
`new-task-draft.ts` gain the same three-line treatment `worktree`/`autonomous` already get. No new
`resolveComposerRunMode`-style resolution function is needed: unlike autonomy (which interacts with
plan-mode and interactive skills), these two have no cross-control interaction — the effective value
is simply `draft.reviewSameModel ?? true` / `draft.reviewCrossModel ?? true`.

### D5. Explicitly out of scope

- **No workspace-level Settings default.** The ask is a per-task composer control, not a global
  policy; `worktree`/`autonomous` both grew a `composerDefaults` Settings mirror well after they
  shipped as plain per-task toggles, and this can follow the same path later if wanted. Adding one
  now would be scope the task did not ask for.
- **No UI toggle on the Workspace-scoped composer** (`workspaceActive` branch). Its default workflow
  is `input-to-tasks` (`WORKSPACE_WORKFLOW`, `new-task-form.ts:370`), which carries neither step id,
  so D3's visibility rule already keeps both chips hidden there. The contract fields still flow
  through for a caller that names `spec-to-deploy` explicitly at workspace scope (D2), because the
  route is not closed to that per its own comment (`workspace-run-routes.ts:101-104`).
- **Plan-first mode** (`postPlan`/`buildPlannedRunBody`) builds its own ad-hoc `steps` from an
  approved plan, not from a named workflow with these ids — out of scope, unaffected.

## Architecture

```
composer (new-task.tsx)
  reviewSameModelOn = draft.reviewSameModel ?? true      \  shown only when the effective
  reviewCrossModelOn = draft.reviewCrossModel ?? true     /  workflow's steps carry the id

  buildCreateRunBody({ ..., reviewSameModel: on===false?false:undefined, reviewCrossModel: … })
        |
        v
POST /runs  body: { workflow?, steps?, ..., reviewSameModel?, reviewCrossModel? }
        |
        v
resolveRunWorkflow(root, body)                    <-- ONE choke point, both POST /runs and
  pick WorkflowDef (steps | named | default)           POST /workspace/runs funnel through it
  return applyReviewStepToggles(def, body)
        |
        v
guardRunStart(root, workflow, ...)   <-- sees the ALREADY-FILTERED step list, so a disabled
        |                                 review-spec's codex requirement is never gated on
        v
manager.startRun(workflow, input)    <-- freezes the filtered WorkflowDef onto the run record;
                                          step rail, approval gate, spec-review log etc. need no
                                          change — they only ever see the steps that are there
```

## Data models

`packages/contract/src/runs.ts`, inside `createRunInputBaseSchema` (additive, optional, both
default-on by absence):

```ts
/** Composer review-step toggles (`.ai/specs/2026-08-30-composer-review-step-toggles.md`).
 *  Default true (today's behaviour) — an explicit `false` drops the matching step
 *  (`review-spec-local`) from the resolved workflow. No-op on a workflow without that step id. */
reviewSameModel: z.boolean().optional(),
/** Same, for `review-spec` (a different model/provider). */
reviewCrossModel: z.boolean().optional(),
```

`packages/cezar/src/server/server.ts`'s local `startRunSchema` gains the identical two fields, same
doc comments, same position relative to `autonomous`/`generateFollowups` — kept easy to diff against
the contract copy per the file's own stated drift risk.

No `RunRecord` schema change: the effect is entirely captured in the frozen `workflowDef.steps` the
record already persists (the same reason `inputToTasksPlan`'s `dispatch`-step drop needed no record
field of its own) — a reader can always tell a toggle was off by the step's absence.

`NewTaskDraft` (`new-task-draft.ts`) gains `reviewSameModel: boolean | null` and `reviewCrossModel:
boolean | null`, alongside `worktree`/`autonomous`, with matching `EMPTY`/`normalize` entries.

## API contracts

- `POST /api/v1/runs` — body gains `reviewSameModel?: boolean`, `reviewCrossModel?: boolean`.
  Additive; an older client that never sends them gets today's behaviour exactly (both steps run).
- `POST /api/v1/workspace/runs` — inherits both fields from `createRunInputBaseSchema` (the schema
  is built by omission, not by re-listing keys), so no separate schema edit; `workspace-run-routes.ts`
  passes them into `deps.resolveWorkflow(...)`.
- No response shape changes anywhere — the effect is visible only in the returned run's
  `workflowDef.steps`/`workflow` fields, which already exist.

## Phases

1. **Engine.** `applyReviewStepToggles` + the two step-id constants in `workflows/types.ts`, unit
   tested (drops the right step for each toggle combination; no-ops on a workflow with neither id;
   returns the same object reference when nothing changes). Wire it into `resolveRunWorkflow` and
   both request schemas (`server.ts`, `packages/contract/src/runs.ts`). Thread the two fields through
   `workspace-run-routes.ts`'s call to `deps.resolveWorkflow`.
2. **Composer.** `NewTaskDraft` fields + `readDraft`/`writeDraft`/`normalize`; the two new toggle
   chips (mirroring `WorktreeToggle`) gated on the effective workflow's step ids; wire into
   `buildCreateRunBody`/`buildWorkspaceRunBody` in `new-task-form.ts`, sent only when explicitly off.

Each phase leaves the app working: Phase 1 alone is a usable API for a programmatic caller; Phase 2
is inert without Phase 1 (the fields would be validated away as unknown keys by the strict workspace
schema, or simply ignored by the pre-Phase-1 server).

## Risks

- **A run with both toggles off skips spec review entirely** — `spec` goes straight to `implement`
  with no independent check. That is the explicit ask ("both should disable/enable steps"); it is
  the same trust the owner already extends to `quick-task`/`note-to-spec`-derived runs, which never
  had a review step to begin with.
- **Turning off `review-spec` also removes the one step carrying `requiresApproval`** — a run with
  `reviewCrossModel: false` therefore never reaches the human approval gate `approvals.minApprovers`
  configures, even when that setting is >0. This is a direct, intended consequence of removing the
  step the gate lives on, not a separate defect — worth stating so it is not rediscovered as a bug.
- **Two independent copies of the request schema must be kept in sync by hand** (D2) — an existing,
  named risk in this codebase (`create-run-input.test.ts`'s own header), not a new one this spec
  introduces; both are edited in the same phase/commit here.

## Verification

- `packages/cezar/src/workflows/types.test.ts` — `applyReviewStepToggles`: drops
  `review-spec-local` only, `review-spec` only, both, neither (identity return); no-ops on a
  workflow lacking both ids (e.g. `QUICK_TASK_WORKFLOW`).
- `packages/cezar/src/server/run-source-fallback.test.ts` (or a sibling) — `POST /runs` with
  `workflow: 'spec-to-deploy', reviewSameModel: false` starts a run whose `workflowDef.steps` omits
  `review-spec-local` and keeps everything else in order; both flags `false` omits both; absent
  keeps both (byte-identical to today).
  `packages/api-client/src/create-run-input.test.ts` gains the same matrix against the contract copy.
- `packages/web/src/routes/new-task-form.test.ts` — `buildCreateRunBody` sends `reviewSameModel:
  false`/`reviewCrossModel: false` only when explicitly toggled off; omits both when untouched.
- `packages/web/src/routes/new-task.test.tsx` — both chips render and default to checked when the
  effective workflow is `spec-to-deploy`; both are absent for `quick-task`/a skill pick; unchecking
  one and submitting posts the matching `false`.
- Runtime E2E (QA needed until executed): start a real `spec-to-deploy` task from the composer with
  "Same-model review" unchecked and confirm the run's step rail never shows `review-spec-local`
  while `review-spec` still runs; repeat with both unchecked and confirm `spec` is followed directly
  by `implement`.
