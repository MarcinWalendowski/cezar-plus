# Codex-only default workflow

**Status:** Proposed
**Date:** 2026-08-24
**Repo:** `cezar`
**Read at:** `e38cb619` (worktree `a15215ef`, clean, tracking `origin/main`)
**Brief:** `.ai/specs/briefs/2026-08-24-default-workflow-codex-only.md` (KB `specs-1787e9a431da`)

**Extends:**
`.ai/specs/2026-08-19-spec-to-deploy-default-workflow.md` (the chain, and its promotion to default),
`.ai/specs/2026-08-21-per-step-model-policy.md` (per-step model on `spec-to-deploy`),
`.ai/specs/2026-08-24-codex-step-model-and-effort.md` (`byRunner`, `effort` on codex, the owner's task-to-model table),
`.ai/specs/2026-08-23-never-block-a-task.md` (availability outranks the pin),
`.ai/specs/2026-08-22-failed-turn-reads-as-done.md` (`modelForBackend`, and the "no cross-runner routing" follow-up this closes),
`.ai/specs/2026-08-23-step-runner-account-resolution.md` (per-step backend and account binding).

**Corrects, in place, three stale doc comments:** `packages/cezar/src/workflows/types.ts:836-845`
still says *"both of those pin `SPEC_AUTHORING_RUNNER = 'claude'`, so on a codex run they never reach
a codex model at all"*, about `spec` and `review-spec`. That was true when written and is false now:
`review-spec` pins `runner: 'codex'` (`types.ts:1120`), landed by
`.ai/specs/2026-08-24-default-workflow-ten-stages.md` D1. The same stale claim is repeated at
`types.ts:741-769` (*"`spec` and `review-spec` pin the RUNNER as well as the model"*, and *"the
other six steps carry no runner"*, which is now seven of nine) and at
`packages/cezar/src/workflows/run.ts:6294-6302` (*"`spec-to-deploy` pins `runner: claude` + `opus` on
`spec`/`review-spec`"*). Phase 1 amends all three. The brief this spec is
written against inherited the first half of that error and reported `spec` and `review-spec` as
two pins to be undone; direct reads of `types.ts` at `e38cb619` say otherwise, and this spec
follows the code.

## TLDR

The owner's task: *"add a way to run our default workflow only via codex (as different variant?)
(every step via codex)"*.

Measured at `e38cb619`, `spec-to-deploy` has nine agent steps and its DEFINITION carries **exactly
one explicit off-codex pin**: `spec`, via `runner: SPEC_AUTHORING_RUNNER` where that constant is
`'claude'` (`types.ts:769,1073`). `review-spec` already pins `runner: 'codex'` (`types.ts:1120`).
The other seven name no runner at all and follow the run's own backend (`run.ts:6303-6304`).

**That is a statement about the definition, not about a run.** Picking codex does not make eight of
nine steps codex, because `input.runner` is not the last word on the run's backend either:
`run.ts:5054-5068` resolves a pool route first and then takes
`chosen?.provider ?? input.runner ?? config.defaultRunner`, giving the pool-resolved provider
precedence over the pill. A `pool:*` route that names no provider of its own resolves to whichever
account the balancer picks, and when that account is a Claude one, **all seven unpinned steps run on
Claude even though the user picked codex**. So there are two ways an intended all-codex run is not
one: the one authored pin, and the provider that a wildcard pool can substitute underneath the pill.

The same fix closes both, and it is why this spec pins every agent step rather than only undoing
`spec`. Concretely the feature is two things:

1. **One pin to undo** (`spec`), and
2. **a thing a user can SELECT**, which does not exist: the composer's runner pill sets
   `input.runner`, and `input.runner` loses to BOTH the pool-resolved provider above it
   (`run.ts:5068`) and any step pin below it (`run.ts:6304`). Nothing today can express "all codex,
   including the pinned step".

**The solution is a derived built-in workflow, `spec-to-deploy-codex`, computed from
`SPEC_TO_DEPLOY_WORKFLOW` by a pure function that stamps `runner: 'codex'` onto every agent step.**
It changes no schema, no contract, and no run-level field. Because `loadWorkflows()` is the single
catalog and every surface reads it, the new entry reaches `GET /api/v1/workflows`, the composer's
source picker, `POST /runs {workflow}`, `POST /workspace/runs` and `cezar run --workflow` with no
per-surface work.

Two deliberate non-goals, stated here so they are not read as oversights: the **default workflow is
not changed**, and **codex-pinned stays a preference with a fallback**, not a hard guarantee,
because `.ai/specs/2026-08-23-never-block-a-task.md` is a standing ruling that availability outranks
a pin.

On the first of those, be precise about what the current default IS, because the obvious summary of
it is stale. It is **not** "spec and spec review by opus always". That 2026-08-22 owner instruction
was later corrected in code for one of its two steps. At `e38cb619` the default is **mixed**: `spec`
on Claude `opus` (`types.ts:751,769,1070-1073`), `review-spec` on **codex** `gpt-5.6-sol` at
`xhigh` (`types.ts:848,1116-1121`, with Claude `opus` kept only as `byRunner.claude`), landed by
`.ai/specs/2026-08-24-default-workflow-ten-stages.md` D1. This spec leaves that current mixed
default byte-for-byte as it stands; every change below happens inside the explicitly selected
sibling.

## Problem

### P1. One pin, not nine, but that pin is the one that matters

Direct read of `SPEC_TO_DEPLOY_WORKFLOW` (`types.ts:999-1489`), step by step:

| # | step id | `runner` | `model` | `byRunner.codex` |
| --- | --- | --- | --- | --- |
| 1 | `context` | none | `sonnet` | `CODEX_EXPLORE` |
| 2 | `spec` | **`'claude'`** (`:1073`) | `opus` | `CODEX_COMPLEX` (`:1074`) |
| 3 | `review-spec` | **`'codex'`** (`:1120`) | `gpt-5.6-sol` | n/a (`byRunner.claude` is the fallback) |
| 4 | `implement` | none | `sonnet` | `CODEX_BUILD` |
| 5 | `run-tests` | none | `sonnet` | `CODEX_MECHANICAL` |
| 6 | `commit-push` | none | `sonnet` | `CODEX_MECHANICAL` |
| 7 | `merge` | none | `sonnet` | `CODEX_MECHANICAL` |
| 8 | `document` | none | `sonnet` | `CODEX_WRITE` |
| 9 | `deploy` | none | `sonnet` | `CODEX_MECHANICAL` |

`spec` is the single step a codex run cannot reach. It is also the step whose `byRunner.codex`
already names what it *would* run as on codex: `CODEX_COMPLEX = { model: 'gpt-5.6-sol', effort:
'medium' }` (`types.ts:845`), the owner's "complex bug, architecture, auth, payments, migrations"
row. That override is dead code today, unreachable behind the runner pin. The ingredient exists;
only the path to it is missing.

### P2. Nothing can express "all codex", because the pill is squeezed from BOTH sides

The engine pill's value, `input.runner`, is the middle term of two separate precedence rules, and it
loses to each of them.

**Above it, pool resolution can replace the provider** (`run.ts:5054-5068`):

```ts
const pooled = await resolvePoolForDispatch({ agentProfile: input.agentProfile, fallbackProvider: (input.runner ?? config.defaultRunner) as ProviderId, ... });
const rerouted = pooled ?? (await this.rerouteExplicitAccountIfLimited(runId, input, config.defaultRunner));
const chosen  = pooled ?? rerouted;
const taskBackend: RunnerId = chosen?.provider ?? input.runner ?? config.defaultRunner;
```

`input.runner` is only the *fallback* provider handed to the pool. The comment above the call says
it outright: *"`pool:*` picks the PROVIDER too, which is why this sits above `taskBackend`"*. So a
run on a wildcard pool that resolves to a Claude account gets `taskBackend === 'claude'` however the
pill was set, and every unpinned step follows it.

**Below it, a step pin overrides whatever survived** (`run.ts:6303-6304`):

```ts
const pinned  = step.runner ?? undefined;
const backend = (pinned ? await this.downgradePinnedRunner(runId, step, pinned) : undefined) ?? step.runner ?? taskBackend;
```

`taskBackend` is the last term, so a pinned step ignores the pill by construction.

A user picking codex in `EnginePills` (`packages/web/src/components/engine-pills.tsx:190-198`) is
therefore setting the one term that can be overruled from either direction. There is no run-level
override of a step pin anywhere in the codebase, and adding one would be a new precedence rule
fighting an existing one.

**Pinning every step is what makes the sibling independent of both layers.** With `step.runner ===
'codex'` on all nine, `taskBackend` is never consulted, so neither the pill nor a provider-changing
wildcard pool can move the chain. The one thing that can still move it is `downgradePinnedRunner`,
the quota fallback of P5, which announces itself. That is the exact and only residual, and D6 owns
it.

The other escape hatch, an inline chain on `POST /runs`, cannot express this either:
`steps` is capped at eight (`packages/contract/src/runs.ts:898`, `.max(8)`, and the same cap on
`saveWorkflowSchema` at `server.ts:984`) and `spec-to-deploy` has nine steps. A nine-step
codex-pinned chain is not a body the API accepts.

### P3. "Variant" is a taken word

The composer's `draft.variants` and its `x2 / x3` pill mean parallel re-runs of the *same* task,
each in its own worktree (`packages/web/src/routes/new-task.tsx`). A second, unrelated meaning of
"variant" one control away from it would be read wrong on sight. The task text itself asks the
question ("as different variant?"), so this spec answers it: not a variant, a sibling workflow.

### P4. There is an owner instruction pointing the other way, and HALF of it has already been corrected

Owner, 2026-08-22, quoted in `types.ts:741-750`: *"writing spec + spec review should be by opus
always, the rest can be load balanced by codex or claude sonnet"*. The comment at `types.ts:753-768`
is explicit that the runner pin, not the model pin, is what makes "always opus" true rather than
aspirational.

**That instruction is not the current policy in full.** A later owner-directed change moved
`review-spec` to codex `gpt-5.6-sol` at `xhigh`
(`types.ts:848` `CODEX_REVIEW`, applied at `types.ts:1116-1121`), keeping Claude `opus` only as its
`byRunner.claude` fallback, per `.ai/specs/2026-08-24-default-workflow-ten-stages.md` D1. So of the
two steps the instruction named, only the `spec` WRITER is still Claude/Opus. The current default is
a mixed-provider chain, and any reading of this spec that treats "both judgement steps are opus" as
live state is reading a superseded record. The stale claim survives verbatim in three code comments
(`types.ts:741-769`, `types.ts:836-845`, `run.ts:6294-6302`) and in two KB entries
(`notion-4f2df2939b43`, `notion-9a809f12b937`); Phase 1 and Phase 5 correct them in place.

**So what is the actual policy change this spec proposes?** Precisely one, and only inside the
sibling: **`spec` moves from Claude `opus` to codex `CODEX_COMPLEX`**. `review-spec` is already
codex, and the other seven were never pinned. That is the whole delta.

And it is an opt-in delta. The existing `spec-to-deploy` is not edited, so the current default keeps
governing every run that does not deliberately pick the sibling by name. That is the fork the brief
flagged, resolved without needing a new owner ruling: an opt-in sibling is not an override of a
default. The one thing this spec does **not** claim to have settled is whether the owner wants
`spec` on codex at all when they pick the sibling; that is the literal reading of *"every step via
codex"*, and it is flagged again under "What this spec could not establish".

### P5. A hard "codex only, no exceptions" contradicts a standing ruling

`downgradePinnedRunner` (`run.ts:3141-3176`) moves a pinned step to another provider when **every**
account of the pinned provider is out of quota, emits a `note` event saying so, and is on by
default since `.ai/specs/2026-08-23-never-block-a-task.md`. Pinning nine steps to codex means nine
steps subject to that fallback rather than the current two.

So "codex only" is, by the existing rules of this codebase, "codex unless codex is wholly
unavailable, and it will say so." Anything stronger is a new policy, not a new workflow.

### P6. `spec-to-deploy` is under active revision right now

`.ai/specs/2026-08-24-default-workflow-ten-stages.md` reads **Partial**, yet part of it (the
`review-spec` move to codex SOL xhigh, and the `merge` stage at `types.ts:1326`) is already landed
at `e38cb619`. A design that *copies* the nine-step list into a second constant would fork on the
next edit to either. This is the single strongest argument for derivation over duplication, and D1
is written for it.

## Solution

### D1. A derived workflow, never a copied step list

Add to `packages/cezar/src/workflows/types.ts`:

```ts
/** Every agent step of `base`, pinned to one runner. A `check` step has no runner to pin and
 *  passes through untouched. Pure: the input workflow is not mutated. */
export function pinWorkflowRunner(base: WorkflowDef, runner: RunnerId, over: Partial<Pick<WorkflowDef, 'name' | 'description'>>): WorkflowDef

export const CODEX_ONLY_WORKFLOW_SUFFIX = '-codex';
export const SPEC_TO_DEPLOY_CODEX_NAME = `${SPEC_TO_DEPLOY_WORKFLOW.name}${CODEX_ONLY_WORKFLOW_SUFFIX}`;
```

The derived workflow is `pinWorkflowRunner(SPEC_TO_DEPLOY_WORKFLOW, 'codex', { name: SPEC_TO_DEPLOY_CODEX_NAME, description: ... })`.

Why derivation and not a second `WorkflowDef` literal:

- **P6.** Every future edit to the nine steps (prompts, post-conditions, `allowedTools`,
  `bashAllowlist`, the tenth stage) reaches both, automatically, or reaches neither.
- The property "the codex workflow is the default workflow, minus the provider choice" becomes
  **testable as an identity** (V2: same step ids, same prompts, differing only in `runner`) rather
  than a claim maintained by hand.
- It costs one function. A copy costs a review rule that nobody will remember to apply.

### D2. Pin EVERY step, not only `spec`

The minimal change is to drop `spec`'s pin, which would make a codex-*started* run all-codex. That
is rejected: it makes the guarantee depend on a second, unrelated control (the engine pill), so
"the codex workflow" started on a claude default would silently be a claude run with a codex
`review-spec`. Pinning all nine makes the workflow's name true on its own terms, regardless of
`input.runner`, `config.defaultRunner` (`packages/cezar/src/config.ts:104`) or which account pool
resolved (`run.ts:5053-5066`).

This also means the derived workflow answers the task's literal wording, "every step via codex",
and not a weaker reading of it.

### D3. The models are already correct, and come for free

`resolveStepModel(step, backend, ...)` (`types.ts:274-289`) prefers `step.byRunner[backend]` over
`step.model`. With `backend === 'codex'` on every step, every step of the derived workflow resolves
to its authored codex row from `.ai/specs/2026-08-24-codex-step-model-and-effort.md` D2:

| step | model, effort on the codex workflow |
| --- | --- |
| `context` | `CODEX_EXPLORE` |
| `spec` | `CODEX_COMPLEX` = `gpt-5.6-sol`, `medium` |
| `review-spec` | `gpt-5.6-sol`, `xhigh` |
| `implement` | `CODEX_BUILD` |
| `run-tests`, `commit-push`, `merge`, `deploy` | `CODEX_MECHANICAL` |
| `document` | `CODEX_WRITE` |

No Claude alias survives to be dropped by `modelForBackend` (`run.ts:1413`, `:6534`), which is the
failure mode `.ai/specs/2026-08-24-codex-step-model-and-effort.md` was written for: a step whose
model is dropped falls through to codex's own default, measured on `prod-host` as
`gpt-5.6-sol` with `reasoningEffort: null`. This spec adds no new model policy; it makes the
existing one reachable for `spec`.

Escalation is unchanged and applies as authored: `CODEX_ESCALATION` (`types.ts:303-306`) climbs
only from `terra`/`sol` at `medium`, so `spec` (now `sol medium`) can climb to `sol high` then
`sol max` on repeated failure, and the Luna rows do not climb at all.

### D4. Derive inside `loadWorkflows`, from the RESOLVED base

`loadWorkflows()` (`packages/cezar/src/workflows/load.ts:27-77`) already lets a repo override any
built-in by shipping `.ai/cezar/workflows/<name>.yaml` (`:67-73`, file names win). Derivation
therefore happens **after** that resolution, off whichever `spec-to-deploy` won:

```
fromFiles  ->  builtins minus file-shadowed names  ->  base = catalog.find('spec-to-deploy')
           ->  if no file already claims 'spec-to-deploy-codex', append pinWorkflowRunner(base, 'codex', ...)
```

Consequences, all intended:

- A repo that customises `spec-to-deploy.yaml` gets a codex sibling of **its own** chain, not of the
  built-in it replaced.
- A repo may still ship an explicit `spec-to-deploy-codex.yaml` and have it win, same rule as every
  other name.
- Sorting is unchanged (`load.ts:75`, `localeCompare`), so the two sit adjacent in every picker.

**Metadata is NOT inherited, and this is a real trap.** `pinWorkflowRunner` takes `steps` and the
authored content from the resolved base, but the derived entry is a **generated** workflow and must
always report itself as one:

```ts
{ ...base, name: SPEC_TO_DEPLOY_CODEX_NAME, description: <D5>, steps: <pinned>, source: 'built-in', path: undefined }
```

`source: 'built-in'` and **no `path`**, unconditionally, even when the base was resolved from a
file. A naive `{ ...base }` spread carries the base's `source: 'file'` and its `path:
.ai/cezar/workflows/spec-to-deploy.yaml` straight through, and the catalog would then present the
generated sibling as being that YAML file. It is not: nothing on disk holds it, editing that file
does not edit it in the way the path implies, and any surface that offers "open the file" for it
would open the wrong workflow. `pinWorkflowRunner` therefore sets both fields itself rather than
inheriting them, and **V3 asserts it** for the file-overridden base case.

The one case that IS `source: 'file'` with its own `path` is a repo shipping an explicit
`spec-to-deploy-codex.yaml`: that entry is not derived at all, it comes from `fromFiles` and wins by
name, so it keeps the ordinary file metadata. V3(c) asserts that too, so the two paths are pinned
apart rather than by accident.

### D5. Name and label

- Workflow **name** (the identity on the wire, in `RunRecord.workflow`, in the CLI flag):
  `spec-to-deploy-codex`.
- Workflow **description**: `The default chain with every agent step pinned to codex; falls back when every codex account is quota-limited.`
- Display **label** in the web UI: `default (codex)`, by adding one entry to
  `WORKFLOW_DISPLAY_NAMES` (`packages/web/src/lib/tasks-table.ts:131`), which already maps
  `spec-to-deploy` to `default` and passes every other name through (`:133-137`).

Two things the description deliberately does **not** say, and why:

- **No model name.** `Every step on codex (gpt-5.6)` was the earlier draft and is wrong twice over.
  It names a version the derived workflow does not choose (the models come from each step's
  `byRunner.codex`, and `.ai/specs/2026-08-24-codex-step-model-and-effort.md` owns them), so a future
  model-policy change silently falsifies this string in a place nobody will think to edit. The whole
  point of D1 is that the sibling INHERITS policy changes; its description must inherit them too, by
  not restating them.
- **No unqualified "only".** The fallback of D6 is real, so a description promising codex with no
  caveat is a claim the code does not keep.

"Variant" appears nowhere (P3). **In code comments, prefer "codex-pinned" over "codex-only"**
wherever the sentence is about runtime behaviour, since the pin is what is true and "only" is what
is not. "codex-only" survives as the spec's filename and title, where it names the feature rather
than asserting a runtime guarantee.

### D6. Quota fallback still applies

This feature adds **no strict mode**, and it changes nothing about failure paths in either
direction: it preserves the existing **recorded-quota** fallback and inherits, unchanged, the
pre-existing hard failures that sit in front of a run. Being precise about which is which matters,
because "codex-only never blocks" is broader than what the code does.

**What the fallback covers.** A codex-only run reaching a step whose pinned provider has *every*
account recorded as `limited` downgrades through `downgradePinnedRunner` (`run.ts:3141-3176`) per
`.ai/specs/2026-08-23-never-block-a-task.md`, and announces it with a `note` on the run record —
exactly what `spec`/`review-spec` do today. The workflow's description says "every step on codex";
the never-block ruling is what the product means by a pin everywhere else, and inventing a second
meaning here would be the inconsistency, not the safety.

**What it does not cover, and this spec does not fix.** Three paths still hard-fail, all of them
pre-existing and none introduced here:

1. **Disabled or uncredentialed codex, before the run exists.** The API create path calls
   `providerActionError(providersRequiredByWorkflow(workflow, fallback), root)` in `guardRunStart`
   (`server/server.ts:2571`) and answers 409; the CLI performs the same check before starting
   (`index.ts:1026-1039`, via `unavailableProviderMessage` over `applyProviderEnablement`) and exits
   non-zero. A provider explicitly disabled in settings short-circuits without even re-probing
   (`server.ts:1527-1531`). No run record is created, so `downgradePinnedRunner` never gets a turn.
   The codex sibling makes this **more likely to be hit, not differently implemented**: today
   `providersRequiredByWorkflow` on the default chain already returns codex (two steps pin it), so
   the class of failure is identical — the sibling merely leaves codex as the only pinned provider
   in the set.
2. **A model rejection with no recorded quota limit.** `downgradePinnedRunner` keys strictly on
   `isLimited(...)` over the recorded usage store, and returns `undefined` (keeping the pin) when the
   pinned provider still has any open account. A model that is unavailable, renamed, or refused for a
   reason that never wrote a limit entry therefore fails the step rather than downgrading.
3. **Nothing open anywhere.** When no account on any provider is open, the function deliberately
   keeps the pin and lets the turn fail honestly (`run.ts:3163-3165`) — the documented bottom rung of
   the ladder, not a bug.

This is a **residual gap against the broader wording** of the never-block ruling, recorded here
rather than papered over. Closing it would mean changing the pre-run provider gate for every
workflow, which is a separate decision and out of this spec's scope.

What this spec *does* add is that the announcement now matters more, because nine steps can
downgrade instead of two. V5 asserts the `note` fires for a derived step, so the promise is
degraded loudly rather than silently.

### D7. `quick-task` and `note-to-spec` need nothing

`QUICK_TASK_WORKFLOW` (`types.ts:413`) and `NOTE_TO_SPEC_WORKFLOW` (`types.ts:443`) carry **zero**
runner pins. Picking codex in the composer already runs them entirely on codex today. Deriving
codex siblings for them would add two picker entries that duplicate the engine pill, so they are
deliberately out of scope. `pinWorkflowRunner` is generic and takes any `WorkflowDef`, so adding one
later is a one-line registration, not a redesign.

### D8. When the engine pill and the workflow disagree, the workflow wins, visibly

A user can pick `default (codex)` and then pick `claude` in the runner pill. The step pin wins
(`run.ts:6304`), which is correct and is the whole point of D2, but it renders as a contradiction.
Phase 3 handles it in the cheapest honest way: the picker's description line states the override in
words. A control that disables the runner pill on a pinned workflow is explicitly **not** in scope
here, because the pill also selects the ACCOUNT within a provider (`engine-pills.tsx:190-198`), and
that choice is still meaningful for the claude side of a downgrade.

## Architecture

```
packages/cezar/src/workflows/types.ts
  pinWorkflowRunner(base, runner, over)        NEW, pure
  SPEC_TO_DEPLOY_CODEX_NAME                    NEW, const
        |
        v
packages/cezar/src/workflows/load.ts
  loadWorkflows(repoRoot)                      CHANGED: derive after file-override resolution
        |
        +--> GET /api/v1/workflows            server.ts:4595            (no change)
        +--> resolveRunWorkflow()             server.ts:2537-2553       (no change)
        +--> cezar run --workflow <name>      index.ts:1015-1027        (no change)
        |
        v
packages/cezar/src/workflows/run.ts
  step.runner = 'codex' on all nine
        -> downgradePinnedRunner()            run.ts:3141               (unchanged behaviour)
        -> backend                            run.ts:6304
        -> resolveStepModel(step,'codex')     types.ts:274              (picks byRunner.codex)
        |
        v
packages/web/src/lib/tasks-table.ts
  WORKFLOW_DISPLAY_NAMES                       CHANGED: + 'spec-to-deploy-codex': 'default (codex)'
        -> composer picker    new-task.tsx:1387-1410
        -> tasks table column / filter  global-tasks.tsx:1559
```

The whole feature is two source edits plus a display map entry. Everything else is an existing seam
doing its job.

## Data models

**No schema changes.** `workflowStepSchema` (`types.ts:26`) already carries `runner?: RunnerId` and
`byRunner?`, and `workflowDefSchema` (`types.ts:183`) is `{ name, description?, steps, source, path? }`.
A derived workflow is an ordinary `WorkflowDef` with `source: 'built-in'` and no `path`, so:

- `RunRecord.workflowDef` (`packages/contract/src/runs.ts:473`) persists it unchanged. A run
  FREEZES its workflow, so a run started on the codex workflow keeps its pins across restart and
  continuation, and a later edit to the derivation does not retro-change a live run.
- `contract-parity.workflows.test.ts` needs no update, because no shape moved.

The derived shape, for one step, is exactly:

```ts
// base
{ id: 'spec', name: 'Write the spec', model: 'opus', runner: 'claude', byRunner: { codex: { model: 'gpt-5.6-sol', effort: 'medium' } }, ... }
// derived
{ id: 'spec', name: 'Write the spec', model: 'opus', runner: 'codex',  byRunner: { codex: { model: 'gpt-5.6-sol', effort: 'medium' } }, ... }
```

`model: 'opus'` is deliberately left in place rather than stripped: `resolveStepModel` never reads
it when `byRunner.codex` names a model (`types.ts:281-285`), and keeping it means the derived def
stays a pure `runner` rewrite that V2 can assert as an identity. A step with no `byRunner.codex`
would fall to `step.model` and be dropped by `modelForBackend` with the existing announcement; all
nine have one today, and V1 pins that.

## API contracts

**No contract changes.** The three request shapes already accept everything needed:

- `POST /api/v1/runs` and `POST /api/v1/workspace/runs`: `{ workflow: 'spec-to-deploy-codex' }`.
  `createRunInputSchema` takes `workflow: z.string().min(1).optional()`
  (`packages/contract/src/runs.ts:895`), and `resolveRunWorkflow` looks it up by name in the catalog
  (`server.ts:2546-2550`), so an unknown name is the existing 404 and a known one needs no new branch.
- `GET /api/v1/workflows` returns `{ workflows, issues }` straight from `loadWorkflows`
  (`server.ts:4595`), so the entry appears with no route change.
- CLI: `cezar run "<task>" --workflow spec-to-deploy-codex` (`packages/cezar/src/index.ts:1015-1027`).

One documentation-only change: the `--workflow` help line at `index.ts:146` names the default; it
gains a mention of the codex sibling.

`POST /api/v1/workflows` (the builder's save, `server.ts:978-990`) is untouched and still caps
authored chains at eight steps. That cap is why the codex chain is a derived built-in and not
something a user can save from the builder.

### Analytics

The house rule is that a feature ships with its events named at design time, not bolted on after.
This feature has exactly two questions worth answering with data, and neither can be answered today:
**is anyone picking the codex chain**, and **how often does the pin it promises actually hold**.

The surface already exists and needs no new plumbing: a `metric` event on the run's own NDJSON,
emitted through the same `emit({ type: 'metric', name, runId, workflow, ... })` shape as
`run.step.stopped` (`run.ts:5456-5462`), `run.step.resumed_after_missing_session` (`:5517`) and
`run.step.retried_cold_broker` (`:5544`). The comment at `run.ts:5453-5455` states the convention
this follows: *"Name the numbers now, so 'how often does this fire, and how far in?' has an answer
next time instead of a grep. The run's own NDJSON is the analytics surface."*

**`run.workflow.selected`**, emitted once per **created** run from `startRun` (`run.ts:1493-1570`) —
immediately after the frozen-workflow persistence
(`this.store.updateRun(run.id, { workflowDef: workflow })`, `run.ts:1543`) and **before** the run is
queued (`this.pendingJobs.set` / `this.queue.push`, `run.ts:1568-1569`) — for **every** run and not
only codex ones (a rate needs its denominator):

Creation, not execution, is the correct seam, and this is not a stylistic preference. `execute()` is
re-entered: `pump` calls it at dequeue (`run.ts:1876`), and `reattachBrokeredRun` calls it a second
time after a cezar restart to re-adopt a still-live broker and re-enter the chain at the surviving
step (`run.ts:2675`, with a `resumeAt`). An event emitted beside the `lifecycle` line inside
`execute` (`run.ts:5109`) would therefore fire again on every reattachment and chain recovery, which
turns a metric documented as once-per-run into a silent overcount — and it would overcount exactly
the long, interrupted, restart-surviving runs, i.e. not at random. Emitting at creation also counts a
workflow the user really did select but whose run was cancelled or killed while still queued; that
selection happened and belongs in the denominator. `startRun` holds no `emit` closure, so it writes
the way `recordResourceKill` already does:
`this.store.appendEvent(run.id, { type: 'metric', … })` (`run.ts:2581`).

Stated explicitly, because V9 asserts it: each **variant** of `startVariants` (`run.ts:1582-1592`)
reaches `startRun` and so emits its own event, one per created run; **resume, broker reattachment,
chain re-entry and every other re-execution emit nothing additional.** The count of
`run.workflow.selected` on any single run's NDJSON is exactly 1, for the life of that run.

| field | type | meaning |
| --- | --- | --- |
| `runId` | `string` | the run |
| `workflow` | `string` | resolved workflow name, e.g. `spec-to-deploy-codex` |
| `requestedRunner` | `RunnerId \| undefined` | `input.runner`, the engine pill, BEFORE pool resolution overrides it (P2) |
| `stepCount` | `number` | `workflow.steps.length`, so a repo-overridden chain is distinguishable from the built-in |

`requestedRunner` is deliberately the pre-resolution value, because the interesting comparison is
against the run's actual `taskBackend`: the two disagreeing is exactly the wildcard-pool substitution
of P2, and this is the first event that makes it countable.

**`run.step.runner_downgraded`**, emitted from `downgradePinnedRunner` (`run.ts:3141-3176`) at the
same point as the existing `note`, i.e. only when the substitution actually happens:

| field | type | meaning |
| --- | --- | --- |
| `runId`, `stepId` | `string` | the step that moved |
| `workflow` | `string` | so codex-chain downgrades separate from default-chain ones |
| `plannedRunner` | `RunnerId` | the pin, `'codex'` here |
| `actualRunner` | `RunnerId` | what it ran on instead |
| `reason` | `string` | `'quota'` today, the only condition the function fires on (*every* account of the pinned provider `isLimited`) |

`reason` is a named field rather than an implied constant so a future second downgrade cause does not
silently merge into the quota number.

The existing human-readable `note` (*"this step asks for … and every codex account is out of quota,
running on … instead"*) **stays exactly as it is**. It is what a person reading the run sees, and the
metric is what a query counts; neither replaces the other. V9 asserts both events, and V5 continues
to assert the `note`.

## Phases

Phases 1 through 3 are **logical slices, not separate commits.** Each is independently reviewable
and leaves the tree green on its own, which is how they should be built and how a reviewer should
read the diff. They **land together as ONE feature commit** after the complete gate of V6, per the
repo's one-commit-per-feature rule. Nothing here should be read as licence for intermediate commits.

**Phase 1 (no user-visible change).** `pinWorkflowRunner` + `SPEC_TO_DEPLOY_CODEX_NAME` in
`types.ts`, with unit tests. Nothing is registered, so the catalog is unchanged. Verified by V1, V2.

Phase 1 also **corrects three stale doc comments in place**, all of them asserting the superseded
"both judgement steps pin claude" state (P4):

| location | the stale claim |
| --- | --- |
| `types.ts:741-769` | *"`spec` and `review-spec` pin the RUNNER as well as the model"*; *"The other six steps carry no runner"* (it is seven of nine now). |
| `types.ts:836-845` | *"both of those pin `SPEC_AUTHORING_RUNNER = 'claude'`, so on a codex run they never reach a codex model at all"*, and *"No `spec-to-deploy` step names `CODEX_COMPLEX`"*, which this spec's sibling makes false. |
| `run.ts:6294-6302` | *"`spec-to-deploy` pins `runner: claude` + `opus` on `spec`/`review-spec`"*. |

Each gets the house correction form, **not** a rewrite: a bolded `**CORRECTED 2026-08-24
(`.ai/specs/2026-08-24-codex-only-default-workflow.md`):** …` lead-in stating what is true now and
where to look, with the **original text left below it unchanged**. Deleting the original is what
makes the next reader unable to tell what changed, and the standing rule is to mark, not erase.

**Phase 2 (the feature).** Register the derived workflow in `loadWorkflows` per D4, including the
`source: 'built-in'` / no-`path` metadata rule. From here the workflow is reachable from the CLI,
both run-creation routes and the composer picker (which renders whatever the catalog returns).
Verified by V3, V4, V5.

**Phase 3 (the label and the events).** `WORKFLOW_DISPLAY_NAMES` entry and the picker description
line per D5/D8; `--workflow` help text per API contracts; the two `metric` events of the analytics
contract. Verified by V7, V9.

**Phase 4 (the gate and the commit).** V6, the five gates in documented order, then ONE commit
carrying Phases 1 through 3 together.

**Phase 5 (the record, and it is not optional).** In the same session as the code:

1. Set this spec's own **Status** line: `Implemented / QA Needed` on commit, and `Implemented` only
   once V8 has actually run and passed. Not before.
2. Append to `CEZ_KB_WRITE_FILE` (NDJSON, never a direct edit of a mounted doc): one `upsert` for
   the durable decision (*a derived codex-pinned sibling of the default chain, opt-in, with the
   never-block fallback intact*) and one `upsert` for the changelog entry.
3. Append `supersede` / correction proposals for the two current records that still assert the
   superseded `review-spec` state: **`notion-4f2df2939b43`** (*"opus WRITES AND reviews the spec"*,
   whose body says *"The current table: `spec` and `review-spec` on opus/claude"*) and
   **`notion-9a809f12b937`** (*"`Write the spec` and `Review the spec` are untouched, they pin
   `runner: claude`"*). Both read as current today and both are what the next session finds first.
   Note the constraint from the record: a `supersede` op cannot rewrite the read-only `notion`
   mount, so these land as **proposals**, and the correction is only real once applied through the
   cockpit or `cez kb proposals`.
4. **Confirm by search, not by having written.** After the proposals are applied,
   `cez kb search "codex-pinned default workflow"` must return the new entry, and
   `cez kb search "review-spec opus"` must surface the corrected text rather than the stale claim.
   A proposal that was never applied is not the record.

**Phase 6 (QA, not code).** The runtime E2E, V8. Until it has run, this spec is Implemented / QA
Needed and must say so in its own Status line rather than Implemented.

**Deferred, explicitly not in this spec:** a generic "run this workflow all on provider X" control
that applies to any catalog entry, and a strict codex-only mode that refuses to downgrade. Both are
one function call away from `pinWorkflowRunner` and neither is asked for by the task. This also does
not attempt the broader "make the whole model table configurable in global settings" follow-up filed
at `types.ts:762-767`; it closes the narrower half of it (a way to route a whole chain to one
provider), and that item stays open.

## Risks

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Nine pinned steps means nine `downgradePinnedRunner` calls per run, each loading the accounts and usage files (`run.ts:3147`). | Low | Two steps already do this; nine is the same order. Both files are small local JSON reads and the call is already `await`ed once per step. If it ever matters, memoise per run; not done pre-emptively. |
| "codex only" is not literally guaranteed (D6), so a user could believe a run was all-codex when one step downgraded. | Medium | The existing per-step `note` event names the substitution. V5 asserts it fires. The steps table on the run record shows each step's actual `backend` (`packages/contract/src/runs.ts:94`), so the record is truthful even when the name is aspirational. |
| The in-flight `.ai/specs/2026-08-24-default-workflow-ten-stages.md` lands a tenth stage and the codex chain drifts. | Low | This is exactly what D1's derivation prevents: a tenth stage appears in both, pinned, with no edit here. V2 asserts step-id identity, so a divergence is a red test rather than a silent fork. |
| Two adjacent picker entries, `default` and `default (codex)`, read as a duplicate. | Low | Distinct descriptions; they sort adjacent on purpose (D4) so the relationship is legible rather than accidental. |
| The engine pill and the workflow can contradict each other (D8). | Low | The workflow wins, which is the documented intent; the picker description says so. |
| A repo ships `.ai/cezar/workflows/spec-to-deploy-codex.yaml` capped at eight steps and shadows a nine-step chain with a shorter one. | Low | Same rule and same failure mode as shadowing any other built-in; the catalog reports the file's own chain honestly, and it is the repo's deliberate act. |
| `spec` on `gpt-5.6-sol medium` writes a worse spec than opus. | Medium | This is the price the task asks to pay, and the workflow is opt-in (P4). `CODEX_COMPLEX` is the highest non-escalated row the owner's table names, and escalation to `sol high`/`sol max` on failure is already wired (D3). |

## Verification

Concrete, executable. Every command runs from the repo root of `cezar`.

**V1 (unit, Phase 1).** `packages/cezar/src/workflows/types.test.ts`: for the derived workflow,
`resolveStepModel(step, 'codex')` for each of the nine steps equals the D3 table, and in particular
`spec` resolves to `{ model: 'gpt-5.6-sol', effort: 'medium' }` and never `opus`.
`npm test -- packages/cezar/src/workflows/types.test.ts`

**V2 (unit, Phase 1, the identity).** Same file: the derived workflow's `steps.map(s => s.id)`
deep-equals `SPEC_TO_DEPLOY_WORKFLOW.steps.map(s => s.id)`, every derived step has
`runner === 'codex'`, and for every step, the derived step with `runner` deleted deep-equals the
base step with `runner` deleted. That last assertion is what keeps derivation from silently becoming
a copy. Also assert `SPEC_TO_DEPLOY_WORKFLOW.steps[1].runner === 'claude'` still, so Phase 1 proves
it did not mutate the base.
`npm test -- packages/cezar/src/workflows/types.test.ts`

**V3 (unit, Phase 2, the catalog and its metadata).** New
`packages/cezar/src/workflows/load.test.ts` over a tmpdir repo root:

- (a) with no `.ai/cezar/workflows`, `loadWorkflows` returns four entries including
  `spec-to-deploy-codex`;
- (b) with a `spec-to-deploy.yaml` naming two steps, the derived codex entry has those same two step
  ids, both pinned to codex (D4, derive off the RESOLVED base);
- (c) **the metadata assertion, and it is the one a spread implementation fails**: in case (b), the
  derived entry has `source === 'built-in'` and `path === undefined`, even though its base came from
  a file. A `{ ...base }` that leaks `source: 'file'` and the base YAML's `path` presents the
  generated sibling as that file and must be a red test, not a code review catch;
- (d) with a `spec-to-deploy-codex.yaml` present, the FILE wins, and that entry does have
  `source === 'file'` with its own `path` (the opposite of (c), on purpose).

`npm test -- packages/cezar/src/workflows/load.test.ts`

**V4 (server, Phase 2).** Extend `packages/cezar/src/server/run-source-fallback.test.ts`, which
already owns `POST /api/v1/runs` workflow resolution and captures the resolved `WorkflowDef`: a body
`{ task: '...', workflow: 'spec-to-deploy-codex' }` answers 201, and the captured `workflowDef.steps`
all carry `runner: 'codex'`. A body naming a nonexistent `spec-to-deploy-codexx` still answers 404
(`server.ts:2549`), and a body with neither key still resolves to `spec-to-deploy`, unchanged.
`npm test -- packages/cezar/src/server/run-source-fallback.test.ts`

**V5 (unit, Phase 2, the honest degradation).** Two files, because the behaviour spans both:

- `packages/cezar/src/workflows/account-fallback.test.ts`: with every codex account marked limited
  and `fallbackAcrossAccountsWhenLimited()` on, a derived step resolves its backend to claude AND
  appends the `note` event naming the substitution. This is the assertion that keeps D6 from being a
  silent lie.
- `packages/cezar/src/workflows/step-runner-account.test.ts`, which already owns "a step that pins
  its own runner resolves its own ACCOUNT"
  (`.ai/specs/2026-08-23-step-runner-account-resolution.md`): a derived step pinned to codex binds a
  codex account, and does so for a step that carried NO pin in the base chain. Nine pinned steps mean
  nine account resolutions where there used to be two, and that path is this file's subject.

`npm test -- packages/cezar/src/workflows/account-fallback.test.ts packages/cezar/src/workflows/step-runner-account.test.ts`

**V6 (the complete gate, Phase 4, before the single commit).** The five commands
`.ai/agentic.config.json` lists, **in the documented order** (`AGENTS.md:227-234`):

```bash
npm run typecheck    # tsc --noEmit (contract + api-client + server + web)
npm test             # vitest: server + cockpit unit suites
npm run test:unit    # node:test: packages/cezar/test/unit/
npm run build        # tsc → dist/, vite → web/dist/, then check:pack
npm run test:package # packs the tarball and exercises the built CLI (needs the build above)
```

**There is no `npm run lint` in this repo** (an earlier draft of this spec named one; `package.json`
has no such script), so the gate is these five and nothing else. Run them with the environment scrub
that `AGENTS.md:262-300` requires, because an unscrubbed `CEZ_*`/`NODE_ENV` environment makes the
gates lie:

```bash
scrub=$(env | sed -n 's/^\(CEZ_[A-Z0-9_]*\)=.*/\1/p' \
        | grep -vxE 'CEZ_(HANDOFF_FILE|TASK_ID)' | sed 's/^/-u /')
tmp=/tmp/cez-gate-$$ && mkdir -p $tmp   # TMPDIR must be OUTSIDE any git repo
env -u NODE_ENV $scrub TMPDIR=$tmp TMP=$tmp TEMP=$tmp npm run typecheck
env -u NODE_ENV $scrub TMPDIR=$tmp TMP=$tmp TEMP=$tmp npm test
```

(`npm run test:unit` and `npm run test:package` are `node --test` and load no vitest setup, so the
scrub applies to them in full as well.) Green is the precondition for commit-push per `AGENTS.md:11`.
Any pre-existing red must be reproduced on a clean `origin/main` checkout and named as baseline
before it is dismissed, per the baseline rule `.ai/specs/2026-08-24-default-workflow-ten-stages.md`
had to invoke, and `AGENTS.md:398` already records `npm run test:package` failing 1/15 under the run
broker for reasons that predate this branch.

**V7 (web unit, Phase 3).** In `packages/web/src/lib/tasks-table.test.ts`, the existing home of this
module's unit tests: `displayWorkflowName('spec-to-deploy-codex')` is `'default (codex)'`,
`displayWorkflowName('spec-to-deploy')` is still `'default'`, and an unmapped name still passes
through verbatim.
`npm test -- packages/web/src/lib/tasks-table.test.ts`

**V8 (runtime E2E, Phase 6, the one that decides QA Needed vs done).** This one **mutates a real
repository and starts a real, billed agent run, so it needs explicit owner approval before it is
run.** Do not run it as part of the gate.

Set-up, chosen so nothing can escape onto anything that matters:

- A **disposable registered project**: a fresh `git init` repo with **no remote**, registered with
  cezar for this test and unregistered afterwards. No remote means `commit-push` cannot push
  anywhere, and the run cannot touch a real branch.
- An explicit **empty deploy-target list**: `.ai/deploy-targets.json` containing `{"targets": []}`.
  A repo with no such file gets a RED `deploy` step by design (`AGENTS.md:11`), which would abort the
  chain before the last steps ever execute and make the assertion below unreachable.
- At least one codex account open, and (for the D8 case) the engine pill deliberately left on
  **claude**.

Then:

1. Start the run: `cezar run "<trivial task>" --workflow spec-to-deploy-codex`, or the same task via
   the composer picking `default (codex)` with the pill on claude, which is the D8 case and the more
   interesting one.
2. **Wait until all nine agent steps have EXECUTED.** This is the correction that makes V8 an actual
   test: a pending step carries no `backend` and no `model` at all. Both fields are written when the
   step runs (`run.ts:6305`, `this.store.updateStep(runId, step.id, { sessionId, backend })`) and are
   `optional()` on the contract (`packages/contract/src/runs.ts:94-97`). "Let it reach `implement`"
   asserts over six absent fields and passes vacuously. Block on the run reaching a terminal state,
   with an until-loop on the record rather than a guessed sleep.
3. Assert on the finished record:
   ```bash
   curl -s localhost:<port>/api/v1/runs/<runId> | jq '{
     workflow,
     steps:   [.steps[]     | {id, backend, model, modelIdentity}],
     pinned:  [.workflowDef.steps[] | {id, runner}]
   }'
   ```
   - every EXECUTED step reports `backend: "codex"`, and `spec` reports a `gpt-5.6-sol` identity;
   - the frozen `workflowDef.steps` pins **every agent step** to `runner: 'codex'` (this is the
     assertion that holds even if a step was skipped, and it is what proves the derivation reached
     the run rather than the catalog only);
   - `workflow === 'spec-to-deploy-codex'`;
   - if any step downgraded, its `note` and its `run.step.runner_downgraded` metric are both present
     and name the reason. A downgrade does not fail V8; an UNEXPLAINED non-codex step does.
4. **The two UI surfaces are verified separately, through the cockpit**, not from the JSON: the
   composer's workflow picker offers `default (codex)` next to `default` with the D5 description, and
   the tasks table's Workflow column renders `default (codex)` for this run. Keep the **screenshot
   and video artifacts** per run, so a failure can be watched rather than guessed at.
5. Finish with the ownership audit the house rules require:
   `find /var/lib/cezar -not -user cezar | wc -l` must be `0`. Then unregister and delete the
   disposable repo.

A `CEZ_DRY_RUN=1` run proves the SHAPE only and is not a substitute: post-conditions short-circuit
green under it (`AGENTS.md:11`), so a green dry run says nothing about which provider served a turn.
It is still worth running first as a cheap shape check:
`CEZ_DRY_RUN=1 cezar run "shape check" --workflow spec-to-deploy-codex`.

**V9 (unit, Phase 3, the analytics contract).** The two `metric` events of the Analytics subsection,
asserted where the existing metric events already are:

- `run.workflow.selected` is asserted in **two moments of the same run**, and the test is written so
  that an emission from `execute()` or any other re-entry path fails it:
  1. Call `manager.startRun(codexWorkflow, …)` and, **before letting the run execute**, read the
     run's events and assert the event is present **exactly once**, carrying `workflow:
     'spec-to-deploy-codex'`, the `requestedRunner` passed in `input.runner`, and
     `stepCount: 9`. Emitting from `execute` fails here with a count of 0, because nothing has
     executed yet.
  2. Then let that same run execute to completion (the fixture's stubbed agent), and re-read its
     events: the count must still be **exactly 1**. A second `execute()` entry (the fixture drives
     one reattach/chain re-entry, as `recover-brokered.test.ts` already does) must not add a
     second event. Emitting from `execute` fails here with a count of 2.
- The denominator assertion stays: the same event, with the same exactly-once shape, fires for a
  run started on the **default** `spec-to-deploy` workflow too, not only for the codex sibling.
- `run.step.runner_downgraded` fires from the same branch as the existing quota `note`, carrying
  `plannedRunner: 'codex'`, the substituted `actualRunner`, and `reason: 'quota'`. Its natural home
  is `account-fallback.test.ts`, alongside V5's `note` assertion, so both are asserted against the
  same simulated quota exhaustion rather than in two unrelated fixtures.

`npm test -- packages/cezar/src/workflows/account-fallback.test.ts packages/cezar/src/workflows/run.test.ts`

## What this spec could not establish

- **Whether the owner wants the codex chain to keep `review-spec` on `sol xhigh` or move it to
  Claude opus for a "one provider" purity.** The derived workflow pins it to codex, which is both
  the literal reading of the task and a no-op (it already is codex). Flagged, not guessed.
- **Whether `gpt-5.6-sol medium` is adequate for `spec`.** No measurement exists: no codex run has
  ever executed the `spec` step, because the pin has always prevented it. V8 produces the first data
  point. This is a stated unknown, not a claim.
- **The true current status of `.ai/specs/2026-08-24-default-workflow-ten-stages.md`.** Its header
  says Partial with commit and push blocked, yet `review-spec` and the `merge` stage from it are
  present at `e38cb619`. This spec re-verified only the parts of `types.ts` it depends on and did not
  reconcile that spec's status; whoever lands this should not treat that header as current.
- **Whether any surface outside the ones listed in Architecture reads the built-in trio directly and
  would need the fourth.** The grep over `packages/**` for `QUICK_TASK_WORKFLOW|NOTE_TO_SPEC_WORKFLOW|SPEC_TO_DEPLOY_WORKFLOW`
  (excluding `dist/`) found only `load.ts`, `notes/approve.ts` (note-to-spec only) and tests, so the
  answer appears to be no; that grep is the whole evidence for it.
