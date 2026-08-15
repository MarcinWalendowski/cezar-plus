# Autonomous implementation continuation

> **Status:** specified, not implemented · **Date:** 2026-08-15
> **Extends:** `2026-08-14-note-to-spec-pipeline.md`, which built capture → split → route → approve
> → a spec run that deliberately **stops** at the spec. This spec is the decision to let it carry
> on into implementation, and the bound that keeps that from running away.
> **Owner decision, 2026-08-15:** asked whether an approved proposal should stop at the spec or
> continue into code, the owner chose **continue automatically**, bounded by a **step budget per
> run** — and explicitly declined a concurrency cap, a halt-on-first-failure rule, and a
> never-auto-push rule as additional bounds. The blast radius was named before the choice was made
> and the choice was reaffirmed; this file records it as a deliberate position, not an oversight.
> **Recorded as PLAN D27**, in `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md`, whose decision table
> outranks this file — read that row first if the two ever disagree.

## TLDR

Today an approved note proposal runs `note-to-spec`, which investigates inside the target repo,
writes a spec, and stops. A person then presses **Start implementation**. This spec removes that
second press for notes marked autonomous: when the spec run finishes cleanly, cezar starts an
implementation run in the same project, against the spec that run just wrote.

The whole risk of the feature is that it is unattended, so the design is mostly about the stop
condition — and specifically about making a run that was *stopped* impossible to mistake for a run
that *finished*.

## Problem

`2026-08-14-note-to-spec-pipeline.md` shipped the pipeline with a review gate at exactly the point
where work becomes expensive: the spec exists, and starting implementation is one click. That gate
is right for a first release and wrong for the use the owner actually described — a note typed on a
phone that should come back as finished work, not as homework.

Two things make the naive version dangerous, and both have to be answered here rather than
discovered at runtime:

1. **`note-to-spec` is deliberately sandboxed and an implementation step cannot be.** That
   workflow's own docblock says its `allowedTools` excludes general `Bash` on purpose, granting
   exactly `git log`, `git show`, `git status` through `bashAllowlist`, because "an agent asked to
   'investigate and write a spec' with a general shell is an agent that can install dependencies,
   run migrations and push branches while nobody is watching, on the strength of a note somebody
   typed on their phone." An agent that implements needs a real shell to run the repo's gates.
   So autonomy is a genuine privilege escalation over what ships today, and pretending otherwise
   would be the failure mode that docblock was written to prevent.

2. **A budget stop looks exactly like finishing.** An agent halted at its ceiling mid-edit and an
   agent that completed its work both end with "the run is over". If they share a terminal state,
   an autonomous note that half-built a feature in four repos presents as four successes, and the
   damage is discovered by reading the code weeks later. This is the single defect most likely to
   make the feature actively harmful rather than merely limited.

## Solution

**Continuation is a property of the note, decided at capture, and it changes nothing about triage.**
The triage pass still only reads. Autonomy is consumed after approval, at the point a spec run
reaches a terminal state.

**The trigger.** When a spec run for proposal *P* reaches `done`, and *P*'s note is autonomous, and
*P* has no implementation run already recorded, start one implementation run in *P*'s project with
the spec the first run wrote as its task. The claim discipline is the one `approve.ts` already
uses and documents: take the claim **before** starting, so a double-trigger cannot produce two
implementation runs in one repo; release it if the start throws, so the row is retryable rather
than stuck.

**The bound.** Every autonomous implementation run carries a step budget. On exhaustion the run
stops and lands in **`review`**, never `done`, and records `stopReason: 'budget'`.

**What the budget counts, and why the obvious answer is wrong.** A unit of budget is **one check-step
attempt OR one agent turn** — not one entry into `execute()`'s step loop.

The first implementation counted loop entries, which is the reading "step budget" invites, and it was
**close to decorative for the shape this feature will actually use.** `execute()` iterates
`workflow.steps`, a **fixed-length** array. A single-step workflow — which `QUICK_TASK_WORKFLOW`
already is, and which `AUTONOMOUS_IMPLEMENTATION_WORKFLOW` will be — enters that loop exactly once,
so the counter reaches 1 and stops. Meanwhile the agent inside that one step can take unbounded
further turns: follow-ups via `sendMessage`, `CEZ:MONITORING` self-continuation, and monitoring
wake-ups all reuse the **same open session** through the `turn-end` handler, code the outer loop
never re-enters. A budget of 3 would not have tripped while an agent took fifty turns.

So the counter is a persisted `RunRecord.stepsUsed`, spent at three call sites against one shared
helper: the loop top, and the `turn-end` handlers in `runAgentStep` and `runContinuation`. A
budget-exceeded turn ends the session directly rather than parking `waiting`/`monitoring` or taking
the autonomous self-nudge, because the outer loop cannot see into an in-flight `await`.

**The lesson, which generalises past this feature:** the enforcement code was correct as written —
the counter incremented exactly where it said it did. It was counting the wrong *thing*. Reading
the diff confirms a counter is right; only asking "what can happen without passing this line?"
confirms it is counting work.

**Why `review` and a new field, rather than a new status.** `RunStatus` is published
(`queued | running | waiting | review | done | failed | cancelled`) and cezar is a released npm
package where backward compatibility wins, so widening the union would break consumers that switch
exhaustively over it. `review` already means "stopped, a human must look", which is precisely the
truth about a budget-stopped run, and no existing reader treats it as success. `stopReason` is a
new **optional** field, so an older build round-trips it untouched — the same reasoning
`notes/types.ts` gives for its `.passthrough()`.

`failed` is deliberately **not** used: an agent that errored and an agent we stopped are different
facts, and collapsing them would make "did this need a bigger budget or a bug fix?" unanswerable
from the record.

**What is NOT bounded, on the owner's instruction.** No cap on how many projects one note may
continue into; no halt of sibling runs when one fails. Both were offered and declined. A note that
fans out to eight projects starts eight implementation runs, each independently budgeted.

**Push stays manual, and this is the one place I am not simply following the answer above.** The
owner declined *never-auto-push* as a bound, which is a decision not to add a constraint — it is
not an instruction that unattended agents should push to remotes. Pushing is outward-facing and
irreversible in a way a local commit is not, and no standing authorization covers an agent
triggered by a phone note. So the built-in implementation workflow commits locally and does not
push, and that posture is a one-line change in `AUTONOMOUS_IMPLEMENTATION_WORKFLOW` whenever the
owner wants it flipped. **Flagged, not quietly narrowed** — it is called out here and in the
handoff so the decision is visible rather than buried in a workflow definition.

## Architecture

```
note (autonomous: true)
   │
   ▼  triage pass — unchanged, still READ-ONLY, still builds no ProjectContext
proposals[]
   │
   │  [approve, as today]
   ▼
spec run  ── note-to-spec ──►  writes the spec, stops        kind: 'spec'
   │
   │  run reaches `done`  ─────────────────────────────┐
   │                                                    │  note.autonomous?
   │                                                    │  no implementation run yet?
   ▼                                                    ▼
   └──────────────────────────────────► claim, then start
                                              │
                                              ▼
                          implementation run ── budgeted ──►  kind: 'implementation'
                                              │
                        ┌─────────────────────┼─────────────────────┐
                        ▼                     ▼                     ▼
                   status `done`      status `review`          status `failed`
                   agent finished     stopReason: 'budget'     the agent errored
                                      NOT success              NOT a budget stop
```

**The context asymmetry from `approve.ts` still holds and still matters.** The triage pass may
never build a `ProjectContext`, because doing so calls `manager.recover()` and resumes interrupted
agent runs in every registered repository as a side effect of someone typing a note. Continuation
lives on the approval side of that line, where building the target project's context is what
starting a run there *means*. Autonomy must not move any work across it: the trigger reads a run's
status and a note's flag, and touches only the one project already approved.

## Phases

1. **The bound, alone.** `stopReason` on the run record + contract (optional), step-budget
   enforcement, and the `review`-not-`done` landing. Shippable and useful on its own: it bounds
   *manually* started implementation runs too, which today have no ceiling at all.
2. **The workflow.** `AUTONOMOUS_IMPLEMENTATION_WORKFLOW` as a built-in beside
   `NOTE_TO_SPEC_WORKFLOW` — takes the spec path as its task, implements, runs the repo's gates,
   commits locally, does not push.
3. **The trigger.** Continuation on spec-run completion, with the claim-before-start discipline.
   **Load-bearing precondition, discovered building Phase 1:** `config.stepBudget` defaults to
   **0, meaning unlimited**, and that default is correct for Phase 1 — a nonzero repo-wide ceiling
   would have changed the behaviour of every existing manual and retry-heavy run the moment it
   shipped. But it means an autonomous run started under the default is **unbounded**, and the
   step budget is the *only* bound the owner chose. So Phase 3 may not simply inherit the config
   value: an autonomous continuation must either refuse to start when no budget is set, or carry
   its own non-zero default. **Whichever is chosen, "autonomous and unbounded" must be
   unreachable.** A guard for this belongs in Phase 3's verification, not here.
4. **The switch and its surface.** Restore the composer's autonomous toggle — cut in
   `2026-08-14-project-less-task-composer.md` D3 as "a control wired to nothing", which is exactly
   what this spec stops being true — and show a budget-stopped run distinctly in the notes UI.

Phase 1 is worth landing even if 2–4 slip, because an unbounded implementation run is a live
hazard today.

## Data models

```ts
// runs/store.ts — RunRecord
stopReason?: 'budget';   // optional; only ever set alongside status 'review'

// notes — StoredNote (contract is closed; storage passes through)
autonomous?: boolean;    // decided at capture, read after the spec run
```

`kind: 'spec' | 'implementation'` on `recordResultingTask` already exists and needs no change —
the data model anticipated this, which is why continuation is a trigger rather than a schema
migration.

## API contracts

No new route. Continuation is internal: it fires off a run reaching a terminal state, and its
result is visible through the existing note and run reads. `stopReason` rides the existing run
payloads as an optional field.

## Risks

| Risk | Mitigation |
|---|---|
| **A budget stop reads as success** — the defect that makes the feature harmful rather than limited | `review` + `stopReason`, never `done`; a test asserts the distinction and a mutation collapsing them must go red |
| **Privilege escalation past `note-to-spec`'s sandbox** | Recorded here as a knowing trade, not inherited silently; no push; gates run inside the run |
| A double trigger starts two implementation runs in one repo | Claim before start, release on throw — `approve.ts`'s existing, documented discipline |
| Continuation drags context-building onto the read path | Trigger reads status + flag only; the structural guard that the triage path imports neither `server/project-context.ts` nor `workflows/run.ts` stays green |
| One bad note fans out across every project | **Accepted, on the owner's instruction.** Per-run budget is the only bound; no concurrency cap |
| A budget too small silently truncates everything | `review` makes truncation visible per run, so a too-small budget shows up as a pile of reviews rather than as quiet damage |

## Verification

Every guard names the mutation that must turn it red. A guard never seen red has not been tested.

| Guard | Mutation that must turn it red |
|---|---|
| A run stopped at its budget has status `review` and `stopReason: 'budget'` | Land it in `done` |
| A run stopped at its budget is **not** reported as successful by any note-level read | Treat `review` as success in the aggregation |
| A run that finished on its own has **no** `stopReason` | Set `stopReason` unconditionally |
| An agent error lands `failed`, not `review` | Route errors through the budget path |
| A non-autonomous note's spec run reaching `done` starts **no** implementation run | Drop the `autonomous` check |
| An autonomous note starts exactly **one** implementation run under a double trigger | Take the claim after `startRun` instead of before |
| A failed spec run starts no implementation run | Trigger on any terminal state instead of `done` |
| The triage path still builds no `ProjectContext` across a full autonomous cycle (structural + behavioural, `contexts.ids()` unchanged) | Add the import / build a context |
| The implementation workflow does not push | Add a push to its `bashAllowlist` and assert the guard catches it |

**Runtime E2E — the gate on Done, and nothing here is Done without it.** With `CEZ_NOTES=1` and at
least two registered projects: capture an autonomous note naming work in both. Confirm each spec
run writes its spec and then, unprompted, an implementation run starts in that same repo against
that spec. Confirm a deliberately tiny budget produces a run in `review` with `stopReason: 'budget'`
that the notes UI does **not** present as finished. Confirm nothing was pushed to any remote.

Gates, in order, and **`npm test -- <path>` never `npx vitest`** (PLAN.md D21): `npm run typecheck`,
`npm test`, `npm run test:unit`, `npm run build`, `npm run test:package`.
