# Per-step model AND reasoning effort for codex — the owner's task→model table, on `spec-to-deploy`

**Status:** Implemented (QA Needed — V7, the prod E2E, has not been run)
**Date:** 2026-08-24
**Repo:** `cezar`
**Extends:** `.ai/specs/2026-08-21-per-step-model-policy.md` (per-step model on `spec-to-deploy`),
`.ai/specs/2026-08-21-run-tests-reasoning-ceiling.md` (`step.effort`, Claude-only),
`.ai/specs/2026-08-22-failed-turn-reads-as-done.md` (`modelForBackend`, the drop-and-announce),
`.ai/specs/2026-08-23-codex-resume-explicit-model.md` (a resumed thread must restate its model).

## TLDR

Owner instruction, 2026-08-24, as a table of task class → model:

| Task | Model |
| --- | --- |
| Commits, renaming, spacing, tiny UI changes | Luna Medium/High or GPT-5.4 |
| Normal bug fix or a clearly scoped feature | Luna XHigh |
| Unclear task that requires exploring several parts of the repo | Terra Medium |
| Complex bug, architecture, auth, payments, migrations | Sol Medium |
| Terra/Sol Medium failed | Sol High/Max |
| Sol Ultra | Basically never |

`spec-to-deploy` already expresses exactly this shape for Claude — `spec`/`review-spec` on `opus`,
the other six on `sonnet`. **On a codex run it expresses nothing**, because every one of those pins
is a Claude alias, `modelForBackend` drops it, and the step falls through to codex's own default.
Measured on `prod-host`: that default is **`gpt-5.6-sol` with `reasoningEffort: null`**, i.e.
the frontier model at its *lowest* reasoning level — for commits, deploys and documentation alike.
It is simultaneously the most expensive model in the catalog and the shallowest setting on it.

Three pieces:

1. **A step can name a model per runner**, so one step says `sonnet` for Claude and
   `gpt-5.6-luna` for codex instead of naming one and losing the other.
2. **`effort` reaches codex.** It is Claude-only today — the schema says so in its own docblock and
   the codex runner has no plumbing for it — and the table is *half* effort, so without this the
   mapping cannot be expressed at all. Measured: the app-server's own generated JSON Schema
   (`codex app-server generate-json-schema`, `v2/TurnStartParams.json`) carries
   `effort: ReasoningEffort | null`, *"Override the reasoning effort for this turn and subsequent
   turns"* — in the same params object cezar already sends `summary` in.
3. **Escalation**, exactly as the table writes it: a step that fails on `terra`/`sol` at `medium`
   retries on `sol` `high`, then `sol` `max`. Luna classes do not climb.

## Problem

### What a codex `spec-to-deploy` run does today

`workflows/types.ts` sets `SPEC_TO_DEPLOY_STEP_MODEL = 'sonnet'` on six steps and
`SPEC_AUTHORING_MODEL = 'opus'` on `spec` and `review-spec`, the latter two also pinning
`SPEC_AUTHORING_RUNNER = 'claude'`. `run.ts:5973` resolves `step.model ?? input.model` and hands it
to `modelForBackend`, which drops a model that `modelConflictsWithRunner` says belongs to another
runner — announcing it on the thread, deliberately, because a silently-ignored pin is a lie.

So on a run started on codex, six of the eight steps emit
`model "sonnet" is not a codex model — running on codex's default instead`, and then run on it.

**Read straight off the production run store, 2026-08-24** (`spec-to-deploy` runs in
`/var/lib/cezar/loki-labs/cezar/.ai/cezar/runs.json`), where the per-step model column
(`2026-08-22-per-step-model-display`) records what each step actually resolved:

```
run c3e15b6d   context      backend=codex   model=None     ← the sonnet pin, dropped
               spec         backend=claude  model=opus     ← the runner pin holding
               review-spec  backend=claude  model=opus
               implement    backend=claude  model=sonnet   ← the policy, on the backend it works on
               run-tests    backend=codex   model=None     ← dropped
```

`model=None` on a codex step is the defect, in production, on the record. Every step that ran on
Claude names its model; every step that ran on codex names nothing, because the only thing it was
given was another runner's alias.

### What that default is, measured

`thread/start` against the authenticated app-server on the box, 2026-08-24:

```json
{"model":"gpt-5.6-sol","modelProvider":"openai","reasoningEffort":null, …}
```

and `models_cache.json` (client 0.147.0) gives `gpt-5.6-sol` a `default_reasoning_level` of **low**.
`gpt-5.6-sol` is `priority: 1` in the catalog — *"Latest frontier agentic coding model."*

That is the worst of both ends at once. A `Commit & push / merge` step gets the most expensive model
in the catalog; and the `Implement the spec` step gets it at the shallowest reasoning level it
offers. Neither is a choice anyone made; both are the absence of one.

### `effort` cannot express the table today

`workflowStepSchema.effort` is documented in place as *"Claude-only … the codex and opencode runners
never read it"*, and that is accurate: `codex-app-server-runner.ts` sends `turn/start` with
`summary` and nothing else about reasoning. Four of the table's six rows differ from another row
**only** by effort (Luna Medium vs Luna XHigh; Sol Medium vs Sol High/Max), so a model-only mapping
collapses the table to three distinct choices and loses the escalation row entirely.

### The catalog is per account, which the mapping must survive

`.codex-secondary` (Pro) advertises `gpt-5.3-codex-spark`; `.codex` (Plus) does not. Both advertise
sol/terra/luna. Since 2026-08-24 the pool can send a step to either account
(`.ai/specs/2026-08-24-second-codex-account-balancing.md`), so a model this table names must be one
**both** accounts serve — and an effort must be one the *model* advertises: `supportedReasoningEfforts`
gives sol and terra `low…ultra` but luna only `low…max`, with **no `ultra`**.

## Solution

### D1 — `byRunner` on a step: one field, not two parallel maps

```ts
byRunner: z.record(z.enum(RUNNER_IDS), z.object({
  model: z.string().optional(),
  effort: z.enum(EFFORTS).optional(),
})).optional(),
```

`step.byRunner?.[backend]` wins over `step.model` / `step.effort`, which stay exactly as they are for
every step and every workflow that does not need to differ. Chosen over widening `model` to
`string | Record<RunnerId,string>` because the table pairs a model **with** an effort: a union on
each field independently would let a step name codex's model and Claude's effort and typecheck.

`spec` and `review-spec` are untouched: they pin `runner: 'claude'`, so they are opus-on-Claude on a
codex run already, and the 2026-08-22 owner instruction (*"writing spec + spec review should be by
opus always"*) is what that pin exists for.

### D2 — the codex mapping

| step | class from the owner's table | codex | effort |
| --- | --- | --- | --- |
| `context` (Gather the record) | *unclear, requires exploring several parts of the repo* | `gpt-5.6-terra` | `medium` |
| `spec` (Write the spec) | — pinned opus-on-Claude | — | — |
| `review-spec` (Review the spec) | — pinned opus-on-Claude | — | — |
| `implement` | *normal bug fix or a clearly scoped feature* | `gpt-5.6-luna` | `xhigh` |
| `run-tests` | scoped, and already capped | `gpt-5.6-luna` | `medium` |
| `commit` (Commit & push / merge) | *commits* | `gpt-5.6-luna` | `medium` |
| `document` (Document the decision) | *tiny changes* — but it is prose about a decision | `gpt-5.6-luna` | `high` |
| `deploy` | *commits* | `gpt-5.6-luna` | `medium` |

`context` is the one step that is genuinely exploratory — it reads the corpus and the specs to
decide what already exists — which is the table's Terra row verbatim.

`implement` is Luna XHigh and **not** Sol, even for an auth or migration task, because by the time it
runs the architecture decision has already been made and reviewed by opus two steps earlier. The
table's Sol row is about *deciding*, and `spec`/`review-spec` are where that happens. This is the
same judgement-vs-construction split the Claude side already encodes.

`run-tests` keeps `RUN_TESTS_STEP_EFFORT = 'medium'` rather than inheriting `implement`'s `xhigh`:
that ceiling was set on a measurement (a 43,583-output-token outlier at `high`) and the reason for it
is runner-independent.

**`gpt-5.4` is not used.** The table offers it as an alternative for the tiny-changes row, but the
2026-08-22 owner instruction *"in codex use only 5.6"* is why `KNOWN_PRESETS_BY_RUNNER.codex` lists
the 5.6 family only. Nothing here blocks it — an id absent from every runner's preset list fails
open — so typing it still works; it is simply not what the built-in workflow names. Flagged for the
owner rather than resolved silently, because the two instructions genuinely disagree.

### D3 — effort reaches codex through `turn/start`

Measured from the app-server's own schema generator, not inferred:

```
codex app-server generate-json-schema --out <dir>   →   v2/TurnStartParams.json
  effort:  ReasoningEffort | null   "Override the reasoning effort for this turn and subsequent turns."
  model:   string | null            "Override the model for this turn and subsequent turns."
  summary: ReasoningSummary | null  ← cezar already sends this one
```

So this is one more key in an object cezar already builds. **`thread/start` is the wrong place** and
that was measured too: `thread/start` accepts `reasoningEffort`, `effort`, `modelReasoningEffort`,
`model_reasoning_effort` and `reasoning_effort` **without error and without applying any of them** —
the result comes back `reasoningEffort: null` every time, because unknown params are tolerated. A
change made there would look exactly like a change that worked.

"…and subsequent turns" means the override is sticky on the thread, so a **resume** must restate it,
for the same reason `2026-08-23-codex-resume-explicit-model.md` makes resume restate the model.

### D4 — escalation, only where the table puts it

A step whose codex pin is `terra`/`medium` or `sol`/`medium` and which fails retries on
`gpt-5.6-sol` at `high`, and on a second failure at `max`. Luna rows do not climb: a failing tiny
task must not end up on the most expensive model, which is precisely what the table declines to do.
`ultra` is never sent — *"Sol Ultra: basically never"* — and luna does not advertise it at all.

### D5 — an effort the model does not advertise is dropped, not sent

~~Same shape as `modelForBackend`: check the effort against the model's `supportedReasoningEfforts`
from the discovered catalog, and on a mismatch drop it with a note on the thread rather than send a
value that 400s. Fail open on an unknown model, exactly as the model guard does.~~

**RESOLVED WITHOUT THE GUARD, 2026-08-24 — the enum already is it.** Measured
`supported_reasoning_levels` from `models_cache.json` on both production accounts:

| model | levels |
| --- | --- |
| `gpt-5.6-sol` | low, medium, high, xhigh, max, **ultra** |
| `gpt-5.6-terra` | low, medium, high, xhigh, max, **ultra** |
| `gpt-5.6-luna` | low, medium, high, xhigh, max |
| `gpt-5.5` / `gpt-5.4` / `gpt-5.4-mini` | low, medium, high, xhigh |

The `effort` enum is `low|medium|high|xhigh|max`, and **`ultra` — the one level it omits — is also
the only level any 5.6 model lacks.** So every value that can be authored is served by every model
this workflow names, and a catalog round-trip on the spawn path would spend a `model/list` call to
re-derive a fact the type system already carries. Building it would have been the shape where a
guard's tests pass because the guard can never fire.

**The residual, stated rather than guarded:** `max` is *not* advertised by `gpt-5.4`/`gpt-5.5`, so a
hand-authored `byRunner: { codex: { model: 'gpt-5.4', effort: 'max' } }` could be refused by the
app-server. Nothing built-in can reach that combination, the refusal is visible rather than silent
(since `2026-08-22-failed-turn-reads-as-done.md`), and a catalog check is the fix if it ever bites.

## Architecture

```
step (byRunner.codex = {model, effort})
   │
   ├─ runAgentStep: step.byRunner?.[backend] ?? {step.model, step.effort}
   │        │
   │        ├─ modelForBackend(...)      ← existing: drops another runner's model, announces
   │        └─ effortForModel(...)       ← D5: drops an effort the model does not advertise
   │
   └─ CodexAppServerRunner
            thread/start { model }                   ← already
            turn/start   { summary, model, effort }  ← effort is new; model made explicit
```

## Phases

1. `byRunner` on the step schema + resolution in `runAgentStep`. Claude behaviour byte-identical.
2. `effort` through the codex runner's `turn/start`, and restated on resume. D5's guard.
3. The `spec-to-deploy` table (D2).
4. Escalation (D4).
5. Record: this spec, the corpus note + changelog, `BACKWARD_COMPATIBILITY.md`.

## Data models

```ts
interface StepRunnerOverride { model?: string; effort?: Effort }
type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'   // 'ultra' deliberately absent
```

`ultra` is not added to the enum. The schema is what a user authors, and the owner's instruction for
it is "basically never" — leaving it unauthorable is the cheapest possible enforcement, and the
escalation ladder tops out at `max` by construction rather than by a comment.

## API contracts

No route changes. `workflowStepSchema` gains one optional key, which is additive for every stored
`workflowDef` and every authored YAML.

## Risks

- **R1 — an effort the account's model does not serve.** Luna has no `ultra`; a future model may drop
  a level. D5's catalog check is the guard, and it fails open, so an unknown model is never blocked.
- **R2 — the sticky override.** `turn/start`'s effort persists for subsequent turns on that thread.
  A resumed step that does not restate it inherits whatever the last turn set. Phase 2 restates it,
  and the resume test is the negative control.
- **R3 — the two owner instructions about `gpt-5.4` disagree.** Resolved by not using it and saying
  so, rather than by picking a side quietly.
- **R4 — this makes a codex `spec-to-deploy` run cost more, not less, on the two judgement steps.**
  It does not: those steps stay on Claude. It makes the six construction steps *cheaper*, because
  they move off `gpt-5.6-sol` onto luna/terra. The one that gets more expensive is `implement`,
  which moves from sol-at-`low` to luna-at-`xhigh` — a cheaper model at deeper reasoning, which is
  the trade the table is asking for.

## Verification

**V1 (unit, Phase 1).** A step with `byRunner.codex` resolves to the codex pair on a codex backend
and to `step.model`/`step.effort` on a Claude one. Negative control: a step with **no** `byRunner`
resolves identically before and after the change, on both backends — without it, "the table applies"
is provable by a resolver that always returns the codex pair.

**V2 (unit, Phase 2).** The `turn/start` params object contains `effort` when one is resolved and
**omits the key** when none is. Negative control against the measured trap: a test asserting that
setting effort on `thread/start` does *not* change the thread's `reasoningEffort` would pass against
both the right and the wrong implementation, so the assertion is on the `turn/start` payload cezar
actually writes.

**V3 (unit, Phase 2).** A resumed step restates `effort`. Fails if the restate is removed.

**V4 (unit, Phase 3).** The eight-step table, asserted as a whole (`toEqual` over every step's
resolved pair for `backend: 'codex'`), so a step added later without a codex pin reddens this rather
than silently inheriting the default. `spec` and `review-spec` assert `runner: 'claude'` and **no**
codex pin.

**V5 (unit, Phase 4).** A `terra`/`medium` failure retries `sol`/`high` then `sol`/`max`; a
`luna`/`xhigh` failure does not climb. Both directions, or "escalates" is provable by a ladder that
escalates everything.

**V5a — the mutation that survived, and what it changed.** `escalate` was first written with **two**
guards on the attempt count: `priorFailures <= 0 ||` at the top and a `?? choice` on the array
lookup. Deleting the first one left the whole 62-test suite **green**, because the `??` absorbed the
out-of-range index and produced byte-identical behaviour. Two mechanisms enforcing one property
means neither is provably the one that works, and the next person to simplify either deletes the
live one at random. Collapsed to one guard plus an `unreachable` throw; the same mutation now
reddens two tests.

**V5b (wiring — the seam, not the function).** `resolveStepModel` being right proves nothing if
`runAgentStep` reads it and then ignores it. A dry-run test drives the real engine and asserts the
**argv the agent was spawned with**: a step whose `byRunner.claude` differs from its own
`model`/`effort` must spawn with the override's pair, and a step with no override must spawn with
its own. Driven on **Claude** because that is the backend whose model and effort both appear in
argv and can be observed from outside; the codex leg differs only in which runner consumes
`AgentRunSpec.effort`, and `codex-app-server-runner.test.ts` pins that end against the mock
app-server's real `turn/start` payload. The two halves meet at `AgentRunSpec`. Both wiring
mutations (reverting each substitution in `run.ts` independently) redden it.

**V6 (gates).** `npm run typecheck`, `npm run build`, full vitest — **on the box**, twice, because
this repo has a load-sensitive flake pool. The standing `catalog.test.ts` C18 red is expected.

**Result, `/var/lib/cezar/gate-codex2` on `prod-host`:** typecheck 0, build 0, and the suite
run twice with **identical** totals — `11404 passed / 1 failed of 11409`, the one red being C18's
host-budget ratio, both times. No non-C18 red in either run.

An earlier run on an intermediate tree carried two extra reds and both were timing, not logic:
`cli-wiring.test.ts` failed with `Test timed out in 5000ms` and `add-project-dialog.test.tsx` with
a router race (`expected '/p/cezar/' to be '/p/added/'`). Neither reappeared in either final run.
`workspace-parallel.test.ts` behaved the same way — green in both full runs, red once in a
narrower re-run, green alone. That is the flake pool this bullet's "twice" exists for; the tell is
that the red **moves**, and the fix is never to lower a floor over it.

One change landed after those two runs: a comment block and the `stepChoice` declaration moved
above a pre-existing comment inside `runAgentStep`, so the older comment no longer reads as
documenting the new line. Statement reorder within one function, no behaviour: re-verified on the
box with `typecheck` (0) and the whole `workflows/` + codex-runner suites (487 passed).

**V7 (production E2E, the one that decides Done).** Start a real `spec-to-deploy` run on codex on
`prod-host` and read the step rail: every step shows its own model, no step emits
`model "sonnet" is not a codex model`, and the rollout for the `implement` step records
`gpt-5.6-luna` at `xhigh`. Then `find /var/lib/cezar -not -user cezar | wc -l` → 0.

**V7a — done: the SHIPPED ARTIFACT carries the table.** Release `20260824T133306Z-b2c3aa79`,
resolved out of `/opt/cezar/packages/cezar/dist/workflows/types.js` on the box itself:

```
context      codex: gpt-5.6-terra  medium   | claude: sonnet
spec         codex: opus                    | claude: opus          ← runner-pinned, unchanged
review-spec  codex: opus                    | claude: opus
implement    codex: gpt-5.6-luna   xhigh    | claude: sonnet
run-tests    codex: gpt-5.6-luna   medium   | claude: sonnet medium
commit-push  codex: gpt-5.6-luna   medium   | claude: sonnet
document     codex: gpt-5.6-luna   high     | claude: sonnet
deploy       codex: gpt-5.6-luna   medium   | claude: sonnet
context @ priorFailures 0/1/2/5 → terra/medium, sol/high, sol/max, sol/max
```

This is the deployed build answering, not the source — it rules out "green in the repo, not in the
release", which is the gap between a passing suite and a live system. Ownership audit 0.

**V7b — NOT done, and deliberately not self-served.** The remaining half is a real run: only a
**new** run picks the table up, because a run persists its `workflowDef` at creation and the four
codex runs on the box today were created before this shipped. Starting one is not a read — a
`spec-to-deploy` chain commits, pushes and deploys — so it is the owner's call rather than
something to fire off as verification. What it would add over V7a is the wire evidence: no step
emitting `model "sonnet" is not a codex model`, and the `implement` rollout recording
`gpt-5.6-luna` at `xhigh`.

Until V7b has run this is **QA Needed**, not Done.
