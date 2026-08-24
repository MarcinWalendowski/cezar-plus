# Auto-classify a task into the owner's model row — the codex router for work that is not `spec-to-deploy`

**Status:** Implemented (QA Needed — the prod E2E below has not been run)
**Date:** 2026-08-24
**Repo:** `cezar`
**Extends:** `.ai/specs/2026-08-24-codex-step-model-and-effort.md` (the same table, pinned per
`spec-to-deploy` step; `byRunner`, `effort` on `turn/start`, the escalation ladder).
**Precedent copied:** `planner.ts` (`planChain`) and `notes/processor.ts` (`NoteProcessor.ask`) —
one cheap agent call, no tools, one retry on an unparseable answer, never block the user.

## TLDR

The owner's task→model table was shipped as **per-step pins on `spec-to-deploy`**. That covers
eight steps of one built-in workflow. It covers **nothing else**: a task typed into the composer
runs `QUICK_TASK_WORKFLOW`, whose single step names no model, so on codex it still falls through to
the backend's own default — measured on `prod-host` as **`gpt-5.6-sol` with
`reasoningEffort: null`**, the most expensive model in the catalog at its shallowest setting.

The owner chose *"cezar classifies automatically"* over *"built-in workflows only"*, explicitly
because it is **the only version that works for tasks cezar starts by itself** — notes
continuations, reopen triggers, automations. This spec builds that half.

One cheap agent call reads the task text and answers one of four classes. The class maps to the
same four rows already in `workflows/types.ts`:

| Class | Owner's row | codex |
| --- | --- | --- |
| `tiny` | Commits, renaming, spacing, tiny UI changes | `gpt-5.6-luna` `medium` |
| `scoped` | Normal bug fix or a clearly scoped feature | `gpt-5.6-luna` `xhigh` |
| `explore` | Unclear task that requires exploring several parts of the repo | `gpt-5.6-terra` `medium` |
| `complex` | Complex bug, architecture, auth, payments, migrations | `gpt-5.6-sol` `medium` |

It is the **bottom** layer of the resolution stack, not a new top one. Anything anybody named
already — a `byRunner` pin, a step `model`, a step `effort`, the composer's model picker — wins
untouched. The classifier only fills a hole.

## Problem

### 1. The table reaches one workflow

`resolveStepModel` resolves `step.byRunner?.[backend]` → `step.model` → `input.model`. For
`QUICK_TASK_WORKFLOW` all three are empty, so `stepChoice.model` is `undefined`, `backendModel` is
`undefined`, and codex picks its own default. Every ad-hoc codex task in the cockpit gets
sol-at-null-effort, which is what the previous spec measured and set out to fix — for `spec-to-deploy`
only.

### 2. Tasks cezar starts by itself have no picker at all

The composer's model picker is the only place a human names a codex model. A notes continuation, a
reopen, an automation and a `cezar run` from a script pass whatever `input.model` they were
constructed with, which is usually nothing. There is no UI in that path to extend, which is the
argument the owner accepted for a classifier over presets.

### 3. `undefined` is not a neutral default here

A step that names no model does not get "a reasonable default" — it gets codex's, which is the one
combination the owner's table never selects at any row: frontier model, lowest reasoning. So the
absence of a pin is not neutral, it is the worst cell in the matrix, and it is the state every
non-`spec-to-deploy` codex run is in today.

## Solution

### D1 — The classifier is the LAST resort in `resolveStepModel`, not the first

```
byRunner[backend]        ← the per-step table (spec-to-deploy)
  ?? step.model / step.effort
    ?? input.model       ← the composer's picker
      ?? auto class      ← THIS SPEC
        → escalate()     ← unchanged
```

`autoChoice` applies **only when nothing at all was named** — no `byRunner` entry, no `step.model`,
no `step.effort`, no `input.model`. A step that names an effort ceiling and no model is *not* a
hole: the ceiling is a deliberate source, and letting auto replace it with a different pair is
exactly the mixed-source failure the previous spec's "both halves or neither" rule exists to stop.

### D2 — Codex only, and lazily

`autoChoice` is computed only when `stepBackend === 'codex'`. On Claude the per-step pins are alias
names that already work, and `input.model` empty means "the CLI's default", which for Claude is a
sane default rather than the worst cell. Building a Claude half now would be inventing a policy the
owner never wrote.

The call is made on **first need inside the run**, not at task creation. Three reasons, in order of
weight:

1. **The backend is not known at creation.** `pool:*` picks the provider at dispatch
   (`2026-08-23-pool-route-picks-the-provider-too`), and `rerouteExplicitAccountIfLimited` can move
   a run to another engine after that. Classifying at creation would have to guess which mapping to
   apply, and re-guess on every retarget.
2. **It would put an agent call on the composer's request path.** `planChain` can afford that
   because a human asked for a plan and is watching it. Nobody asked for this one.
3. A run whose codex steps are all pinned never pays for it at all.

### D3 — The unclassifiable task is `explore`, and it says so out loud

When the runner errors, times out, or answers something unparseable twice, the fallback is
**`explore` → `gpt-5.6-terra` `medium`**, and a `note` event is emitted on the thread saying the
classification was unavailable.

`explore` rather than "leave it undefined" or "pick the middle":

- Leaving it undefined restores exactly the defect above — sol at null effort — for every run in
  which the classifier is unavailable, which is precisely when nobody is looking.
- `terra medium` is **cheaper, deeper and recoverable** compared to `sol null`: cheaper model, a
  real reasoning level instead of none, and it is one of the two rungs `escalatable()` recognises,
  so a failure climbs to `sol high` then `sol max` on its own.
- It is also the honest reading of the row. "Unclear task that requires exploring several parts of
  the repo" is what a task cezar could not classify *is*, from cezar's position.

Falling back to `scoped` (luna/xhigh) was rejected for the opposite reason: the Luna rows
deliberately do not escalate, so a misclassified complex task would fail on a cheap model with no
ladder under it.

**The fallback is never silent.** `.claude`-side doctrine and this repo's own record
(`knowledge/sections/257-…-fail-soft-classification-is-a-whitelist-or-it-is-…`) both say a
fail-soft path without a counter is a quieter outage. Every degrade emits its reason on the run
thread, beside the `model:` note the step already emits, so the transcript distinguishes
"classified as explore" from "could not classify, using explore".

### D4 — One call per run, cached in memory

Keyed by `runId` in a `Map` on the runner, populated on first codex step that needs it. Not
persisted: a server restart re-classifies, costing one more cheap call. Deliberately no new field
on the run record or the wire contract — **what actually ran is already persisted per step**
(`2026-08-22-per-step-model-display` writes `model` and `modelIdentity` onto each step before the
spawn), so the auditable fact exists without a schema change.

### D5 — The classify call runs on the cheapest thing available

`claude` → `haiku`. `codex` → `gpt-5.6-luna` at `effort: 'low'` (expressible only because the
previous spec plumbed `effort` into `turn/start`). `allowedTools: []`, 30 s timeout, the project's
own agent profile env so it bills the same account the run bills — `planChain`'s rule, for the same
reason.

## Architecture

```
runAgentStep(step, backend=codex)
   │
   ├─ resolveStepModel(step, 'codex', input.model, priorFailures)          → model undefined?
   │        no → use it, unchanged
   │        yes ↓
   ├─ autoCodexChoice(runId, task)            ← cached Map<runId, StepModelChoice>
   │        │ miss
   │        └─ classifyTask(repoRoot, task)   ← one runner.run(), no tools, 30s
   │                 ok      → CODEX_CLASS_CHOICE[class]
   │                 degrade → CODEX_CLASS_CHOICE['explore'] + note event
   │
   └─ resolveStepModel(…, autoChoice) → { model, effort } → modelForBackend → spawn
```

## Data models

```ts
// workflows/types.ts — pure, no I/O, beside the existing CODEX_* constants
export const TASK_CLASSES = ['tiny', 'scoped', 'explore', 'complex'] as const;
export type TaskClass = (typeof TASK_CLASSES)[number];
export const CODEX_CLASS_CHOICE: Record<TaskClass, StepModelChoice>;
export const UNCLASSIFIABLE_TASK_CLASS: TaskClass; // 'explore'

// task-classifier.ts — the impure half, sibling of planner.ts
export interface TaskClassification {
  taskClass: TaskClass;
  /** false when this is the D3 fallback rather than a model's answer. */
  classified: boolean;
  /** Present only on the fallback: what went wrong, for the thread note. */
  reason?: string;
}
export function classifyTask(repoRoot: string, task: string, deps?): Promise<TaskClassification>;
```

`resolveStepModel` gains a fifth optional parameter, `autoChoice?: StepModelChoice`. The four
existing parameters keep their meaning and every existing call site keeps compiling.

## API contracts

None. No route, no wire-schema field, no client change. The only user-visible surface is two `note`
events on the run thread, through the channel the step's `model:` line already uses.

## Phases

1. `workflows/types.ts`: `CODEX_COMPLEX`, the class table, `resolveStepModel`'s `autoChoice`.
2. `task-classifier.ts`: the cheap call, the schema, the two-attempt retry, the fallback.
3. `workflows/run.ts`: the per-run cache, the lazy call, the two note events.
4. Tests + record (this spec, CHANGELOG, corpus note).

## Risks

- **A wrong class is invisible.** Mitigated by emitting the class on the thread and by the step
  record already persisting the model that ran; a run that went to the wrong row can be read back.
  Not mitigated by anything automatic — no confidence threshold, deliberately, because a threshold
  would need a number nobody has measured.
- **One more thing to go wrong before a run starts.** Bounded by: 30 s timeout, no tools, two
  attempts, and a fallback that is strictly better than today's default. It cannot block a run
  (`2026-08-23-never-block-a-task`).
- **Quota.** One extra tiny turn per codex run with no pinned model. On a `pool:*` run it is spent
  on the same account the run will use, which is the correct account to charge but also means the
  classifier competes with the run for that account's quota.
- **Prompt injection through the task text.** The classifier has no tools and its answer is
  constrained to a four-value enum by zod; anything else falls back. A task that talks the
  classifier into `complex` costs money, not safety.

## Verification

**Automated**

1. `resolveStepModel` **precedence**, one test per layer, asserting `autoChoice` is ignored when
   `byRunner` / `step.model` / `step.effort` / `input.model` is present, and used when none is.
2. `autoChoice` supplies **both halves or neither** — a case proving it never mixes its effort with
   another layer's model.
3. Escalation composes: an auto-chosen `explore` (terra/medium) with `priorFailures = 1` resolves
   to `sol high`; an auto-chosen `tiny` (luna/medium) with `priorFailures = 1` does **not** climb.
4. `classifyTask` against a stub runner: each of the four classes round-trips; an unparseable
   answer retries once then falls back; a throwing runner falls back **without** retrying, and both
   fallbacks report `classified: false` with a reason.
5. **Negative control on the fallback:** a test that fails if the fallback is changed to
   `undefined` — i.e. it asserts the concrete terra/medium pair, not merely "something non-null".
6. **Mutation checks**, run 2026-08-24 — all six killed:

   | | Mutation | Killed by |
   | --- | --- | --- |
   | M1 | `nothingNamed &&` deleted from `resolveStepModel` | **5** precedence tests in `types.test.ts` |
   | M2 | `UNCLASSIFIABLE_TASK_CLASS` `explore` → `tiny` | the concrete-pair test, **and** the end-to-end wiring test (`expected 'gpt-5.6-luna' to be 'gpt-5.6-terra'`) |
   | M3 | `stepBackend === 'codex' &&` removed | the **pre-existing** claude test *"an auto (empty) model persists no identity and pins nothing on the wire"* — the over-reach was caught by a test written before this feature existed |
   | M4 | `!agentModelsLocked(this.repoRoot)` removed | *"does not classify at all when models are locked"* |
   | M5 | the `classified` branch collapsed so a degrade reports as a success | *"says which class it picked, on the thread"* |
   | M6 | the classifier's retry bound `< 2` → `< 1` | **2** tests: the retry case and its negative control |
   | M7 | the per-run cache removed, so every step classifies | *"says which class it picked once per RUN"* (`expected [ …(2) ] to have a length of 1`) |

   **M7 was only a real check after the test was fixed.** As first written it asserted
   `toHaveLength(1)` over a workflow with a *single* agent step, where one classification is what
   you get with no cache at all — the assertion was about the workflow's shape, not about the
   cache, and a per-step classifier paying for eight calls on a `spec-to-deploy` chain would have
   left it green. The case now drives two agent steps and asserts the cached pair reaches the
   second one.

   One thing the table does not claim: `task-classifier.test.ts` did **not** redden under M2,
   because those cases reference `UNCLASSIFIABLE_TASK_CLASS` symbolically and so agree with any
   value it holds. That is deliberate — the concrete pair is asserted in exactly one place — but it
   means those tests are not evidence about *which* class the fallback is.

7. Full gate **on the box**, on the **merged** tree, **run twice**. Expect the standing
   `catalog.test.ts` C18 red plus the known load-sensitive flake pool.

**E2E on prod — the real gate**

Measured on `prod-host` 2026-08-24, before the E2E, because it decides what the E2E should
see: neither `/var/lib/cezar/.cezar/config.json` nor the project's own config sets `defaultRunner`,
and `agentDefaults` is `{}` — so it resolves to the schema default, **`claude`**. The classify call
on production is therefore **one `haiku` turn**. It is fast, it is the cheapest thing on the box, and
it spends **no codex quota at all**, which is a good outcome for a router whose whole purpose is
codex quota discipline. If someone later flips the box's default runner to codex, that call becomes
an app-server spawn instead — still one turn, still `gpt-5.6-luna` at `low`, but heavier to start.

Start an ad-hoc codex task in the cockpit with the model picker on auto, and read the thread:

- a `task class: <class>` note appears before the `model:` note
- the `model:` note names one of the four pairs, never `auto`
- the step rail records that model
- `find /var/lib/cezar -not -user cezar | wc -l` → `0`
