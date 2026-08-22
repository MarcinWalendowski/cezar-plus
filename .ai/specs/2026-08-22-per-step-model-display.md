# Show which LLM model actually ran each task workflow step

**Status:** IMPLEMENTED 2026-08-22 — all three phases, gates green, deployed. Written and
reviewed (PASSED, opus) by run `1f63eb07`, whose implementation was then destroyed by the
worktree reap described below; re-implemented from this spec in the same run's `deploy` step
after the owner asked for it directly. The "What happened to run `1f63eb07`" section is kept
below as the incident record — it is history now, not a warning to a future implementer.
**Brief:** `.ai/specs/briefs/2026-08-22-per-step-model-display.md`

## What actually shipped

Every phase landed as written, with two deliberate departures worth naming:

- **A fourth branch in the render fallback.** The spec's rule was three-way (executed → planned
  → `auto`). The implementation splits the executed case: a step with a `modelIdentity` but no
  free-text `model` — what a run under `agentModelsLocked` looks like — renders the identity
  rather than falling through to `auto`. The spec's own Risks section called that ambiguity
  unresolvable and accepted `auto` for it; it turned out to be resolvable for free, because the
  identity IS written in that case and names the model that actually served the turn. `auto` now
  means only "nothing was recorded at all."
- **The `planned` prop is `ReadonlyArray<{ id, model? }>`, not `WorkflowDef['steps']`.** Both were
  offered by the spec. The narrow structural type is what `StepRail` actually needs, keeps the
  web package from importing a workflow type for one field, and `run.workflowDef?.steps` is
  assignable to it unchanged at the single call site.

Verification, as run: typecheck green; `model-identity-wiring.test.ts` 9/9 (including the two new
cases — a multi-model chain keeping each step's own identity, and a follow-up override rewriting
the `continue-1` step's pair); `step-rail.test.tsx` + `run-header.test.tsx` 125/125; the full
five-command gate green apart from the two failures documented in `AGENTS.md` §"environment
traps" that reproduce identically at clean HEAD (`catalog.test.ts` C18, the host-speed budget,
and `config-api.test.ts`'s native-model defaults — the latter re-confirmed against a stashed
control this session, not taken on trust). Verification step 5 (the CLI note) passed live: a
`CEZ_DRY_RUN=1 cez run … --model opus` printed `  · model: anthropic/opus` between the `── step:`
header and the agent's first output.

## What happened to run `1f63eb07` (read this before implementing)

This spec and its brief were written, then reviewed and PASSED, by run
`1f63eb07-a6f1-4c8c-a691-6684ee969e3e` (`spec-to-deploy` on this repo) between
2026-08-22T12:26Z and 12:42Z. The `implement` step (12:49Z) then wrote the code for Phases
1–3 below, and `run-tests` (13:04Z) fixed a real bug it found in
`model-identity-wiring.test.ts`. None of that code exists anywhere on disk or in git today —
not in the run's own worktree, not on its `cez/1f63eb07` branch (identical to `origin/main`),
not in any other worktree, not on any remote branch, no PR.

**Root cause, confirmed by cross-referencing this run's own event log
(`/var/lib/cezar/workspace/.ai/cezar/runs/1f63eb07-a6f1-4c8c-a691-6684ee969e3e.ndjson`)
against this repo's own record:** the `commit-push` step (13:04–13:24Z) stashed, merged
`origin/main`, and popped its stash clean at 13:04:57Z — the diff at that point shows all
seven implementation files modified plus both new spec files untracked, exactly as expected.
It then spent 13:05–13:24Z chasing what it described as "bogus type errors" from "module
resolution … silently falling through to a stale outer checkout" — the signature of a
worktree being destroyed and silently recreated mid-step, not a real dependency bug. This
matches a bug documented and fixed the same afternoon: `3f669bf3` / KB
`cezar-stale-artifact-reaps-live-worktrees` — release `20260822T131126Z-504ce87f` shipped a
`dist/` built *before* the orphan-prune fix `5ffa383c` it claimed to contain, so production
ran the pre-fix pruner for six minutes (13:11:37–13:17:59Z) and force-deleted live workspace
worktrees and their branches with no ownership check. That window sits squarely inside this
run's `commit-push` step. The step's own postcondition (`post-condition:
everything-committed`) correctly reported `exitCode 0` for an unrelated reason — workspace
runs apply their per-project worktrees back to the real checkout **unstaged, by design**, so
"nothing committed" is not itself a defect — but by the time that check ran, the worktree it
was checking had already been wiped and silently reset to `origin/main`, so there was nothing
left to apply back either. **The infra bug is already fixed** (3f669bf3, shipped 2026-08-22);
this document exists because the fix landed too late to save this run's work, and because a
workspace run has no durable checkpoint before its very last step — a reap at any point
before then loses the whole run, not just the step in flight.

**What survived:** this spec and its brief, in full, recovered verbatim from the `Write`
tool-call payloads and the post-review `Read` in the run's own ndjson event log (both
Claude-Code JSONL, not application state — the one thing the reap could not touch). The
actual code diff for the implementation is only partially recoverable (a `git diff` shown at
event `seq 2079` of that log covers `store.ts`, `run.ts`, `contract/runs.ts`) and was
deliberately **not** hand-spliced back from that transcript for this recovery — reassembling
production code from a partial diff without being able to run the gates against it would risk
shipping something subtly wrong under an honest-sounding status. **Phases 1–3 below need a
real implement pass, from this reviewed spec, same as any other approved spec** — not a
transcript replay.

## TLDR

Owner ask, verbatim: *"in every task workflow step show what LLM models where used."* Read
as past tense — the **executed** model, not the planned one — this needs a real schema
change: today only the *planned* `workflowDef.steps[].model` is persisted anywhere per
step, and the two places the *actually resolved* model is computed
(`runAgentStep`, `packages/cezar/src/workflows/run.ts:4832-4851`, and `runContinuation`,
`run.ts:3467-3477`) both write only to the **run-level** `RunRecord.modelIdentity`,
clobbering it on every subsequent step. This spec
adds a per-step `model`/`modelIdentity` pair to `stepStateSchema` (mirroring the existing
run-level pair exactly, and the sibling `sessionId`/`backend` pair already persisted per
step), writes it at the point it is already resolved, renders it in `StepRail` and
`WorkflowSteps` (`packages/web/src/routes/task-thread/step-rail.tsx`), and surfaces it on
the headless CLI (`cez run`) via a `note` event — closing the brief's open question 4,
which no prior investigation had checked.

## Problem

`packages/cezar/src/workflows/run.ts:4832-4851` resolves the model that actually runs a
step:

```ts
const stepBackend = step.runner ?? taskBackend;
const normalized = normalizeModelForBackend(
  stepBackend,
  agentModelsLocked(this.repoRoot) ? undefined : step.model ?? input.model,
  { configuredProvider: await configuredModelProvider(stepBackend, state.cwd) },
);
backendModel = normalized?.backendModel;
this.store.updateRun(runId, {
  modelIdentity: normalized ? formatModelIdentity(normalized.identity) : undefined,
});
```

A second, independent resolution site writes the same run-level field:
`runContinuation` (`run.ts:3467-3477`) resolves
`normalizeModelForBackend(continueBackend, agentModelsLocked ? undefined : record?.model, …)`
on every follow-up turn and resume, and writes the result to the same
`updateRun(runId, { modelIdentity })`. Two consequences follow. First, a continuation
resolves from the **run-level** `record.model`, not `step.model` — so a continued step's
real model can diverge from what its own spawn resolved, even with no explicit override.
Second, `#401` lets a follow-up switch model outright, and
`model-identity-wiring.test.ts:145` ("a follow-up model override re-writes the persisted
identity") already pins that the run-level identity is re-written on that path — a live,
exercised path, not a hypothetical one. A per-step field written only at spawn would go
stale here and visibly disagree with whatever `AgentBadge` shows for the same run.

`RunRecord.modelIdentity` (`packages/cezar/src/runs/store.ts:164`) is a single **run-level**
field, written on **every** step. On a multi-model chain — `spec-to-deploy` runs
`review-spec` on opus and the other seven steps on sonnet since
`.ai/specs/2026-08-21-per-step-model-policy.md` (commit `a5f04b0f`) — it holds only the
*last* step's identity once the run finishes; every earlier step's resolved model is
discarded, with no history kept. `backendModel` is passed transiently into
`createRunner(stepBackend)` and never persisted at all.

`stepStateSchema` (`packages/cezar/src/runs/store.ts:65-105`, mirrored exactly in
`packages/contract/src/runs.ts:64-101`) has no `model` field. It already has `backend`
(`store.ts:90`), written per step at `run.ts:4689` (`updateStep(runId, step.id, {
sessionId, backend })`) and again at `run.ts:4726` on a codex/opencode session event —
proof the "persist a per-step execution fact next to `sessionId`" pattern exists and is
already load-bearing for the sibling "which backend ran this step" question, just not for
model.

Nothing renders a per-step model today. `StepRail` and `WorkflowSteps`
(`packages/web/src/routes/task-thread/step-rail.tsx:76-111` and `:221-264`) render name,
`stopReason`, iteration count, `kind · step N of M`, and a clock — no model. The only model
shown anywhere in the task view is `AgentBadge` (`packages/web/src/routes/task-thread/run-header.tsx:721-804`),
and it is run-scoped: `run.model ?? 'auto'` (line 732) plus `run.modelIdentity` (line 753)
in a dropdown — the same single, last-step-clobbered field, folded into one badge for the
whole run. `.ai/specs/2026-08-21-per-step-model-policy.md`'s claim that "`GET
/api/v1/workflows` already serializes each step's `model` … without a UI change" is true
only of the workflow **template builder**'s raw YAML preview text
(`packages/web/src/lib/workflow-builder.ts:116`, `if (s.model) lines.push(...)`) — confirmed
by reading `StepCardBody` (`packages/web/src/routes/workflows/workflows.tsx:819-907`), which
renders no model chip either. That is the *planned* value on the *template* view; it is a
different surface from the one this task asks for and is left unchanged.

The CLI headless path (`cez run "<task>"`, `packages/cezar/src/index.ts:916-1006`) is a real
second surface the brief flagged as unchecked. Its `step-start` handler
(`index.ts:985`, fed by `run.ts:4089`) prints `── step: <name>` before `runAgentStep` has
resolved anything — the model is not known yet at that point in the control flow — so
today it never appears in `cez run`'s output either.

## Solution

Persist the **executed** model per step, at the exact point it is already computed, mirroring
the existing run-level pair:

- Add `model` (the free-text ask that actually took effect: `step.model ?? input.model`,
  `undefined` when `agentModelsLocked` voided it or nothing was asked) and `modelIdentity`
  (the canonical `provider/model` string from `formatModelIdentity(normalized.identity)`) to
  `stepStateSchema`, in both `packages/cezar/src/runs/store.ts` and the mirrored
  `packages/contract/src/runs.ts`. Same two-field shape `RunRecord` already carries at the
  run level (`store.ts:154,164`) — reused rather than invented, so `AgentBadge`'s existing
  `model ?? 'auto'` / "show identity only when it differs" rendering rule ports over as-is.
- Write both fields at **both** places that resolve a model and write the run-level
  `modelIdentity`: `runAgentStep` (`run.ts:4832-4851`) and `runContinuation`
  (`run.ts:3474-3477`), via one more `this.store.updateStep(runId, stepId, { model,
  modelIdentity })` call at each site — `stepId` is already a parameter of
  `runContinuation` (`run.ts:3160`). The continuation site uses
  `agentModelsLocked(this.repoRoot) ? undefined : record?.model` as the free-text value,
  the same expression it already computes for `normalizeModelForBackend`. Both are pure
  additions next to the existing `updateRun(..., { modelIdentity })` calls, which stay
  untouched — `AgentBadge` keeps working unmodified, and the step record now always names
  the model of its **latest** turn, matching the run-level field it mirrors.
- Because this writes at the point `runAgentStep` resolves a model for *any* agent step of
  *any* workflow (not just `spec-to-deploy`), scope question 3 from the brief resolves
  itself: every agent step of every workflow gets a per-step model the moment it runs,
  whether or not `workflowDef` named one explicitly. `check` steps never call
  `runAgentStep` and never carry a model — `StepRail`/`WorkflowSteps` render the chip only
  for `kind === 'agent'`.
- Render it in `StepRail` (every row) and `WorkflowSteps` (the collapsed summary's current
  step only, matching the existing asymmetry `StepClock` already has between the two
  components) — following the precedent `.ai/specs/2026-08-20-step-and-tool-call-durations.md`
  set for adding a small per-step fact to the same rail. The empty case is not a single
  `auto` fallback: `StepRail` also renders `pending` steps, and every pre-existing run's
  steps carry no persisted model, so on a live run the rail would print `auto` next to a
  step the run's own frozen `workflowDef` already names a model for (e.g. `review-spec` on
  opus in `spec-to-deploy`). The rule is three-way instead — executed value when persisted
  (`step.model`); else the **planned** value from the run's frozen
  `workflowDef.steps[i].model` (already on the wire: `runRecordSchema.workflowDef`,
  `packages/contract/src/runs.ts:427`, and `workflowStepDefSchema.model`,
  `packages/contract/src/workflows.ts:29`), rendered visibly as planned (dimmed, with a
  `title="planned"` or equivalent marker so it is not mistaken for what actually ran); else
  `auto`, same convention `AgentBadge` already uses for the true no-data case.
- Surface it on the CLI by emitting one `note` event right after resolution in
  `runAgentStep` — the existing generic channel (`case 'note': console.log('  · ' +
  message)` at `index.ts`, already used per-step for e.g. "team skill materialized"),
  needing no new CLI command or event type. This is the answer to the brief's open
  question 4: `cez run` gets the fact through the mechanism it already has, not a new one.

Explicitly out of scope, to keep this one shippable change: `AgentBadge` (run-level) is left
rendering exactly as it does today — it does not attempt a "mixed models" summary across a
run's steps. The workflow **template builder**'s `StepCardBody` is left unchanged — it shows
the *planned* model on a different view (the def, not a run) and the brief's "past tense =
executed" reading does not reach it.

## Architecture

Resolution is unchanged; two more writes land at the point it already happens:

```
step.model ?? input.model ──► agentModelsLocked(repoRoot) ? undefined : …
                                           │
                                           ▼
                          normalizeModelForBackend(backend, raw, …)
                                           │
                              ┌────────────┴────────────┐
                              ▼                          ▼
                  RunRecord.modelIdentity      StepState.model / .modelIdentity   ← NEW
                  (existing, run-level,                  │
                   clobbered every step)                 ▼
                                              StepRail / WorkflowSteps render it
                                                          │
                                                          ▼
                                         emit({ type: 'note', message: `model: …` })
                                                          │
                                                          ▼
                                              cez run — case 'note' (existing)
```

## Phases

Each phase is independently shippable and independently testable.

**Phase 1 — persist the executed model per step (backend).**
`packages/cezar/src/runs/store.ts` and `packages/contract/src/runs.ts`: add
`model: z.string().optional()` and `modelIdentity: z.string().optional()` to
`stepStateSchema` (both copies, same comments-as-the-run-level-pair pattern). `run.ts:4832-4851`
(`runAgentStep`): after computing `normalized`, add
`this.store.updateStep(runId, step.id, { model: rawModel, modelIdentity: normalized ?
formatModelIdentity(normalized.identity) : undefined })`, where `rawModel` is the same
expression already inlined for `normalizeModelForBackend`'s second argument (`agentModelsLocked(this.repoRoot)
? undefined : step.model ?? input.model`) — hoist it to a local so it is not computed twice.
No route change: `GET /runs/:id` and `GET /runs` return `RunRecord`/`ApiRun` close to
verbatim (`server.ts:4904-4908`, `withUsage` only adds a `usage` key), so both fields reach
the wire the moment the schemas and the write exist.

A second edit site lands next to it: `runContinuation` (`run.ts:3474-3477`), right after
its own `this.store.updateRun(runId, { modelIdentity })`, add
`this.store.updateStep(runId, stepId, { model: continueRawModel, modelIdentity: normalized ?
formatModelIdentity(normalized.identity) : undefined })`, where `continueRawModel` is
`agentModelsLocked(this.repoRoot) ? undefined : record?.model` — the same expression
`runContinuation` already computes for its own `normalizeModelForBackend` call — hoisted to
a local the same way. `stepId` is already in scope there (`runContinuation(runId, stepId,
…)`, `run.ts:3158-3160`), so this is a one-line addition, not a new resolution path.
Without it, every follow-up turn, resume, and auto-resume would leave the step's `model`/
`modelIdentity` at the spawn-time value while the run-level field (and the actual model
that ran) moved on — reintroducing at step level the exact defect `#405` exists to prevent
at run level.

**Phase 2 — CLI note.** Same call site in `runAgentStep`: emit
`emit({ type: 'note', stepId: step.id, message: `model: ${normalized ? formatModelIdentity(normalized.identity) : 'auto'}` })`
right after the `updateStep`/`updateRun` writes. Reaches both `cez run`'s stdout (via the
existing `case 'note'` handler) and the web transcript (notes already render there) with no
handler changes on either side. `runContinuation` has no `emit` closure of its own — it
calls `this.store.appendEvent(runId, { type: 'note', message, stepId })` directly (the same
shape already used at `run.ts:3344`); add the same note there, right after its own
`updateStep`/`updateRun` writes, so `cez run` and the transcript record a model line for
continued turns too, not just first spawns.

**Phase 3 — render in the step rail (web).** `packages/web/src/routes/task-thread/step-rail.tsx`:
`StepRail` — for `step.kind === 'agent'`, render a small `data-slot="step-model"` chip. When
`step.model` is persisted, show it (`title`/tooltip carrying `step.modelIdentity` when
present and different, mirroring `AgentBadge`'s `identity !== model` guard at
`run-header.tsx:753`); otherwise fall back to the planned value from the new prop below,
marked visibly as planned; otherwise `auto`. Placed next to `step-iterations`, before the
trailing `kind · step N of M` text. `WorkflowSteps` — same chip, but only for the `current`
step (the component already derives `current` via `activeStepIndex`), placed beside
`StepClock` in the collapsed trigger row. Both components take one new optional prop
carrying the run's planned per-step models (e.g. `planned?: WorkflowDef['steps']` or a
`stepId → model` map) — `StepState` alone cannot answer the planned case, since a `pending`
step has no execution facts yet. `WorkflowSteps` reads `run.workflowDef` at its single call
site, `run-header.tsx:287` (`<WorkflowSteps runId={run.id} steps={run.steps} />`), and passes
it down to `<StepRail>` at `step-rail.tsx:259`. The prop is optional so the existing bare
`<StepRail steps={…} />` call sites in tests keep compiling unmodified.

## Data models

`stepStateSchema` (`packages/cezar/src/runs/store.ts:65-101`, mirrored in
`packages/contract/src/runs.ts:64-101`) gains, immediately after the existing `backend`
field to sit beside its sibling:

```ts
/** Free-text model actually asked for on this step's attempt (`step.model ?? input.model`,
 *  `undefined` when `agentModelsLocked` voided it or nothing was asked) — the per-step twin
 *  of `RunRecord.model`. */
model: z.string().optional(),
/** Canonical `provider/model` this step actually resolved to (`core/model-identity.ts`) —
 *  the per-step twin of `RunRecord.modelIdentity`, no longer clobbered by later steps. */
modelIdentity: z.string().optional(),
```

Both optional, additive: every pre-existing `runs.json` record parses unchanged (`model`/
`modelIdentity` absent on every step written before this ships, same as `RunRecord.model`/
`modelIdentity` were additive when #405 introduced them).

## API contracts

None added or changed. `GET /api/v1/runs/:id` and `GET /api/v1/runs` already return
`RunRecord`/`ApiRun` including `steps[]` verbatim; the two new optional fields ride along
once the schemas and the write exist, exactly as `backend` did. The compile-time
`packages/cezar/src/server/contract-parity.runs.test.ts` (`Mutual<Schema, Route>` check,
described at the top of that file) enforces that the contract mirror does not drift from
what the route actually sends — no manual route change needed, but that test's `npm run
typecheck` pass is part of verification below.

## Risks

- **`agentModelsLocked` voids the field on purpose, and that reads as "missing" not
  "locked."** When the lock fires, `rawModel` is `undefined` and both new fields go
  unwritten — indistinguishable in the record from "no model was ever asked for." The UI
  falls back to `auto` in both cases, matching `AgentBadge`'s existing behavior for the same
  ambiguity at the run level; this spec does not attempt to disambiguate "locked" from
  "never asked," because nothing else in the record does either today.
- **The chip can only ever be as fresh as the last resolution.** A step's `model`/
  `modelIdentity` update the moment `runAgentStep` computes them, before the agent's turn
  starts — so a step still shows a value while `running`, same as `sessionId`/`backend`
  already do. Not a new risk class, just inherited from the existing pattern this reuses.
- **`StepRail` is already a dense single line.** Adding a fifth per-row element
  (name, stopReason, iterations, model, kind·position, clock) risks crowding on narrow
  viewports. Mitigated by keeping the chip terse (the free-text ask only, e.g. `sonnet`,
  never the `provider/model` identity inline — that stays in the tooltip, matching how
  `AgentBadge` keeps `identity` out of its own truncating summary line) and by the
  `design-guardian.test.ts` static scan, which the full gate already runs.
- **Two more `updateStep` calls per step attempt.** `RunStore` rewrites the whole
  `runs.json` on every save (per `.ai/specs/2026-08-21-per-step-model-policy.md`'s Phase 2
  note); this adds to an already-frequent write path (`sessionId`/`backend`,
  `tokensUsed`, `costUsd` all already write per step) rather than introducing a new one, so
  no new write-amplification class — call it out rather than assume it is free.

## Verification

Scrub the environment first — `AGENTS.md` §"Two environment traps" / the 2026-08-20 and
2026-08-22 corrections in it:

```bash
scrub=$(env | sed -n 's/^\(CEZ_[A-Z0-9_]*\)=.*/\1/p' \
        | grep -vxE 'CEZ_(HANDOFF_FILE|TASK_ID)' | sed 's/^/-u /')
tmp=/tmp/cez-gate-$$ && mkdir -p $tmp
env -u NODE_ENV $scrub TMPDIR=$tmp TMP=$tmp TEMP=$tmp npm ci
```

1. **Typecheck.** `npm run typecheck` — clean, and the check that
   `contract-parity.runs.test.ts`'s `Mutual<Schema, Route>` assertion still passes with the
   two new optional fields on both `stepStateSchema` copies.
2. **Backend unit/wiring.** Extend
   `packages/cezar/src/workflows/model-identity-wiring.test.ts` (the existing dry-run
   harness that already asserts `RunRecord.modelIdentity` against the mock CLI's captured
   argv): add an assertion that `store.getRun(id).steps[0].model` and `.modelIdentity` are
   present and match the run-level values for a single-step dry run, and — for a multi-step
   chain with different `step.model` values per step (mirroring
   `.ai/specs/2026-08-21-per-step-model-policy.md`'s `types.test.ts` fixture of opus-on-one-step,
   sonnet-on-the-rest) — that each step's persisted `modelIdentity` reflects ITS OWN
   resolution and is not overwritten by a later step's, closing the exact gap this spec
   exists to close. Extend the existing case at `model-identity-wiring.test.ts:145`
   ("a follow-up model override re-writes the persisted identity") to also assert that the
   **step's** `model`/`modelIdentity` (not just the run-level ones already asserted there)
   are re-written to the follow-up's model — proving Phase 1's `runContinuation` write keeps
   the step record from going stale on the exact path the test already exercises.
3. **Web component tests.**
   ```
   npm test -- --project web packages/web/src/routes/task-thread/step-rail.test.tsx \
                             packages/web/src/routes/task-thread/run-header.test.tsx
   ```
   New cases: an agent step with `model: 'sonnet'` renders `[data-slot="step-model"]` with
   text `sonnet`; a step with `modelIdentity` set to something other than `model` exposes it
   via `title`/tooltip; a `pending` agent step with no persisted `model` but a `planned`
   value for it renders that planned model marked as planned (not indistinguishable from an
   executed one); a step with neither persisted nor planned model renders `auto`; a
   `check`-kind step renders no model chip at all; `WorkflowSteps`' collapsed trigger shows
   the chip for the current step only. `AgentBadge`'s existing suite in `run-header.test.tsx`
   must stay green unmodified — this spec does not touch it.
4. **Full gate.** `npm run typecheck && npm test && npm run test:unit && npm run build &&
   npm run test:package`
   (`.ai/agentic.config.json`'s five `validation.commands`, run under the same scrub — see
   `.ai/specs/2026-08-21-npm-test-gate-environment-scrub.md` for why `npm test` alone is not
   enough), green.
5. **CLI, real runtime pass.** `CEZ_DRY_RUN=1 cez run "echo hello" --workflow <a
   single-agent-step workflow>` (the same dry-run harness `model-identity-wiring.test.ts`
   already uses, so no real agent turn is spent) against a scratch repo and confirm stdout
   contains a `  · model: …` line between the `── step:` header and the agent's own output —
   proving Phase 2's `note` reaches the CLI, not just the schema.
6. **Web, real runtime pass — required before this is called done** (`CLAUDE.md` §definition
   of done: gates green is necessary, not sufficient). Start a real `spec-to-deploy` task in
   the cockpit, open its task-thread view once at least two steps with different models
   (`context`/`spec` on sonnet, `review-spec` on opus) have run, and confirm both the
   expanded `StepRail` and the collapsed `WorkflowSteps` header visibly show the correct,
   distinct model per step — not just in test DOM assertions.
