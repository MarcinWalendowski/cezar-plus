# Step resume and two-stage spec review

**Status:** implemented
**Date:** 2026-08-29
**Repo:** `cezar`
**Measured against:** run `872b396a-0672-4e05-a806-e83c4e5c4743` (`spec-to-deploy`, project `cezar`)

## TLDR

`spec-to-deploy`'s `review-spec` step took **14:02** on run `872b396a`, and the `spec` step it
sent back took **11:39 and $5.92** — more than the 9:24/$3.74 original it was reworking. Neither
number is I/O: tool execution was 33.5s of the 843s review, and a regression of per-turn latency
on per-turn output tokens gives `latency = 4.8s + 24.5s per 1k output tokens` (R² = 0.947). It is
token generation, at ~41 tok/s, on a step that generated 30,390 output tokens of which 21,284
were reasoning.

Four changes, in descending order of measured effect:

1. **`onFail.resume`** — a loop-back re-enters the target step's OWN session instead of starting
   cold. Today `spec` iteration 2 re-derives from zero: it re-read 373k tokens of file dumps that
   iteration 1 already had in its window.
2. **A second review step, `review-spec-local`**, on the same runner+model as `spec`, running
   BEFORE the external reviewer. Cheap defects die in the cheap loop; the 14-minute external pass
   sees a spec that already survived a round, so it issues fewer `revise` verdicts.
3. **`CODEX_REVIEW.effort` `xhigh` → `high`.** Directly targets the 70%-reasoning share.
4. **The external reviewer is pointed at the brief and the local review** instead of re-sweeping
   the record — 14 of the 34 files it opened had already been read by `context`.

## Problem

### P1. Every step is a cold session, and the cache cannot cross a step boundary

Measured on run `872b396a`:

| step | model | wall | out tok | reasoning | tok/s | cost |
|---|---|---|---|---|---|---|
| `context` | claude-sonnet-5 | 4:18 | 12,858 | n/a | 50 | $1.45 |
| `spec` #1 | claude-opus-5 | 9:24 | 38,687 | n/a | 69 | $3.74 |
| `review-spec` #1 | gpt-5.6-sol xhigh | **14:03** | 30,390 | 21,284 | 36 | — |
| `spec` #2 | claude-opus-5 | **11:39** | 53,618 | n/a | 77 | **$5.92** |

`review-spec` #1 pulled **1.49 MB ≈ 373k tokens** of `sed`/`rg` output through 19 commands into a
258,400-token window, ending at 229,226 — 89% full. Two single results were 255 KB and 241 KB.
Of the 34 distinct files it opened, **14 had already been read by `context`**: `AGENTS.md`,
`CLAUDE.md`, `run.ts`, `store.ts`, `events.ts`, `step-timing.ts` and the three specs it cites.

### P2. "Same provider" is not what a prompt cache is keyed on

An Anthropic prompt cache hit needs the same **provider, the same model, and an identical
prefix**. `context` is sonnet and `spec` is opus, so those two can never share one however they
are scheduled; `spec` is claude and `review-spec` is codex, so those two cannot either. The only
mechanism that actually carries a warm prefix across a step boundary in cezar today is
**resuming the same session** — `runAgentStep`'s `resumeFrom`, which already exists and is used
for restart re-entry (`chainResumeAt`) and for the stop-and-continue retry (`stopResume`).

It is not wired to the one place it is worth the most: the `onFail.retry` loop-back.

### P3. `spec` #2 is a cold rewrite of a document it wrote 14 minutes earlier

`loopBackTo` sets `checkFailure` and resets the intervening steps to `pending`. The looped-back
step then runs through `runAgentStep` with **no `resumeFrom`**, so it mints a fresh `randomUUID()`
session. Everything iteration 1 read is gone; the review feedback arrives as prose appended to a
freshly templated prompt, and the step re-opens the brief, the spec and the code to act on it.

That is the $5.92.

### P4. One reviewer, on the far side of a provider hop, is the only quality gate

`review-spec` is the only thing between the spec and `implement` → `commit-push` → `deploy`. It
runs on a different provider from the writer, so it starts at 38% cache occupancy and climbs to
90% inside its own step, and every `revise` it issues costs a full cold `spec` re-run. There is
no cheap pass in front of it to absorb the ordinary defects (a missing verification step, a
citation that does not resolve, a phase that is not independently shippable).

### P5. Why `spec` reports no reasoning tokens, and it is not that opus did not think

`core/codex-ui-mapper.ts:888` maps codex's `reasoningOutputTokens` into `TokenUsage.reasoning`.
`core/claude-ui-mapper.ts#rawTokenUsage` maps `input_tokens`, `output_tokens`,
`cache_read_input_tokens` and `cache_creation_input_tokens` — **Anthropic's `result.usage`
carries no reasoning split at all**, because thinking tokens are counted inside `output_tokens`.

So the table's blank is a reporting asymmetry, not a fact about the model. The proof is already
in the run log: the claude steps emitted `blockCounts.thinkingWithheld` of 12, 21, 23 and 29 —
Anthropic's documented blank-`thinking`-block shape for reasoning that happened and was billed
but whose text is withheld. `spec` #1's 38,687 "output" tokens already include its thinking.

No change is made here. It is recorded because the number reads as "opus does not reason" and
that reading would send the next person optimizing the wrong step.

## Solution

### D1. `onFail.resume` — a loop-back re-enters the target step's own session

New optional boolean on the existing `onFail` object, in `workflows/types.ts` **and**
`packages/contract/src/workflows.ts` (both by hand: `contract-parity.workflows.test.ts` compares
the two with a MUTUAL assignability check, and an added optional property stays assignable in
both directions, so the guard is silent on a one-sided add — its own docblock says so).

Default `false`, so every workflow YAML already on disk keeps today's cold-restart behaviour.
`spec-to-deploy`'s two review steps opt in.

When it is set, `loopBackTo` builds a resume handle for the target step from the run record:

```ts
{ sessionId: record.sessionId, profileId?: record.profileId, prompt: <continuation>, verifyTranscript: true }
```

delivered through the existing `stopResume` channel, which `runAgentStep` already consumes as
`resumeFrom`. `checkFailure` is untouched and still appends the review, so the resumed session
receives a short continuation prompt plus the feedback — which is the whole point: the model
keeps what it read and is told what to change.

**Four guards, all of which fall back to a cold session rather than failing:**

1. The target step must be an **agent** step (`stepKind(target) === 'agent'`). A check step has
   no session.
2. The record must actually carry a `sessionId` for it.
3. The recorded `backend` must equal what the target would run on now (`target.runner ??
   taskBackend`). A step whose pinned runner was downgraded for quota
   (`downgradePinnedRunner`) ran somewhere else, and resuming across providers is not a thing.
4. `verifyTranscript: true`, so a Claude session whose transcript never landed is caught by
   `claudeSessionTranscriptExists` before `--resume` is sent.

`resumedAfterMissingSession` already covers the reactive case — a backend that rejects the resume
gets exactly one fresh-session retry — so a resume that goes wrong at run time degrades to
today's behaviour rather than to a failure.

**`sessionId` and `profileId` are a pair** and are carried as one, the same way `chainResumeAt`
carries them.

### D2. `review-spec-local` — the cheap pass, in front of the expensive one

A tenth step between `spec` and `review-spec`:

- `runner: SPEC_AUTHORING_RUNNER` (`claude`), `model: SPEC_AUTHORING_MODEL` (`opus`), `effort:
  'high'` — the same provider and model as the writer, so the run does not cross a provider
  boundary to get its first opinion.
- **Read-only by construction**, same as `review-spec`: no `Write`, no `Edit`. The property that
  makes a reviewer a reviewer is not relaxed because this one is cheaper.
- A **fresh session**, deliberately NOT a resume of `spec`. Resuming the writer's own session to
  review its own work produces agreement, not review. The cache win here comes from D1 on its
  loop-back, not from sharing the writer's window.
- `onFail: { retry: 'spec', max: 1, resume: true }` — **one** cheap round. `retriesUsed` is keyed
  by step id, so this budget is its own and does not spend `review-spec`'s two.
- **No `requiresApproval`.** The human gate stays on exactly one step; `types.test.ts`'s
  "only the review step is gated" assertion keeps its meaning.

It emits the same `CEZ:REVIEW=pass|revise` vocabulary, so `parseReviewVerdict` and the engine's
verdict branch need no change at all.

### D3. `CODEX_REVIEW.effort`: `xhigh` → `high`

`xhigh` bought 21,284 reasoning tokens on a step whose job is checking a document written 30
seconds earlier against code it can open. At 24.5s per 1k output tokens, reasoning alone was
~8.7 minutes of the 14:02.

`high` is not `low`: this is still the last checkpoint before `implement`/`commit-push`/`deploy`,
and D2 now puts a full opus pass in front of it, so the total judgement applied to a spec goes
**up** while the wall clock of the expensive step goes down.

### D4. The external reviewer reads the brief and the local review, not the whole record again

Added to `review-spec`'s prompt: the `context` step's brief and the local review are named as its
starting point, with the instruction to open only what it needs to CHECK rather than re-deriving
the record, and to read in bounded slices.

Advisory, and named as advisory: nothing in cezar can cap a codex `sed -n` result from here. It
is worth writing anyway because the measured behaviour — 19 mega-commands, two over 240 KB — is
the model choosing to batch, and the prompt is the only channel that reaches that choice.

### D5. What is deliberately NOT done

- **No cross-model prefix sharing.** P2: it cannot work, and building something that looks like
  it does would be worse than the honest absence.
- **No context cap on the resumed step.** A resumed `spec` starts at whatever iteration 1 ended
  at, which is the point; a cap would discard the thing being reused. The risk is real and is in
  Risks below.
- **`CODEX_BUILD`'s `xhigh` is left alone.** `implement` writes code, which is where depth pays.

## Architecture

```
  before                                   after
  ──────                                   ─────
  context   sonnet                         context          sonnet
  spec      opus      ◄──┐                 spec             opus     ◄──┬──┐
  review    sol/xhigh ───┘ cold restart    review-spec-local opus/high ──┘  │ resume
  implement                                review-spec      sol/high ──────┘
                                           implement
```

The loop-back arrow is the change: it now carries a session id.

## Data models

`onFail` gains one optional key, in both schema copies:

```ts
onFail: z.object({
  retry: z.string().min(1),
  max: z.number().int().positive().default(2),
  resume: z.boolean().optional(),   // NEW — absent === false === today's behaviour
}).optional()
```

Neither object is `.strict()`, so a persisted `workflowDef` written by an older cezar parses
unchanged, and one written by a newer cezar parses on an older one (the key is ignored).

## API contracts

No route changes. `GET /workflows` serves the server's own `WorkflowDef` verbatim, so `resume`
appears on the wire for the two built-in review steps; the contract copy is what keeps a
round-trip through `POST /workflows` from dropping it.

## Analytics

One new metric, on the run's own NDJSON, so "how often does a loop-back actually get a warm
session?" has an answer next time instead of a grep:

- `run.step.looped_back` — `{ runId, workflow, stepId (the reviewer), target, attempt, resumed:
  boolean, reason: 'resumed' | 'no-session' | 'backend-changed' | 'not-agent' | 'disabled' }`

`resumed: false` with a reason is the load-bearing half: a `resume: true` that silently never
fires is exactly the shape this spec exists to remove elsewhere.

## Phases

1. **P1** — `onFail.resume` in both schemas; `loopBackTo` builds and hands over the handle; the
   metric. Tests: resume fires, and each guard falls back cold.
2. **P2** — `review-spec-local`; `CODEX_REVIEW.effort` → `high`; `review-spec` prompt. Tests: the
   step-list, model, runner, effort and gate matrices in `types.test.ts`.

## Risks

- **A resumed `spec` inherits iteration 1's context occupancy.** It starts warm but full. Bounded
  in practice by the same `max` that bounds the loop, and a context-window error surfaces as a
  step failure with the existing fresh-session retry underneath it. Watch
  `run.step.looped_back{resumed:true}` against step failures on the next runs.
- **Ten steps is a longer chain**, so the floor cost of a `spec-to-deploy` run rises by one opus
  review even when nothing is wrong. Accepted: D3 removes more from the expensive step than D2
  adds to the cheap one, and the failure it prevents (a cold $5.92 rewrite) costs more than it.
- **`resume: true` on a step whose target ran on a downgraded runner** silently gets a cold
  session. That is correct, and guard 3 plus the metric's `backend-changed` reason is what keeps
  it from reading as "resume is broken".
- **D4 is advisory.** If the reviewer keeps batching 250 KB commands, the prompt did not take;
  the metric to watch is the step's own `tokensUsed`, not anything this spec adds.

## Verification

Automated (`npm test`, `packages/cezar`):

1. `workflows/loop-back-resume.test.ts` — a `revise` verdict with `onFail.resume` re-runs the
   target with `resumeFrom.sessionId` equal to the target's recorded session, and the review text
   still arrives via `checkFailure`.
2. Same file — each guard independently produces a COLD run plus its named metric reason: no
   recorded `sessionId`; recorded `backend` different from the step's own runner; target is a
   check step; `resume` absent.
3. Same file — with `resume` absent the handle is `undefined`, i.e. the default is today's
   behaviour and the test would fail if the feature defaulted on.
4. `workflows/types.test.ts` — the ten-step list, the model/runner/effort/gate matrices, and
   `review-spec-local`'s read-only tools + `onFail`.
5. `contract-parity.workflows.test.ts` — unchanged and still green, with the key added to both
   sides by hand (it cannot see a one-sided add; see D1).

Runtime E2E: a real `spec-to-deploy` run on this box, checked for `run.step.looped_back` in its
NDJSON and for `session.started` reusing the prior `sessionId` on the looped-back step. Until
that has been observed on a run that actually took a `revise` verdict, this ships as **QA
needed**, not verified.
