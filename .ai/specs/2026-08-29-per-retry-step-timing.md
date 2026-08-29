# Retry Step Timing

**Status:** **SUPERSEDED 2026-08-29 by `main`'s independently-landed
`.ai/specs/2026-08-29-step-retry-timing.md`.** This branch (`cez/6ed5bc42`) built the same
feature — per-retry attempt times plus an aggregated step total in the tree UI — from the
same original request, in parallel with another task. `main` shipped its version first:
commit `20690834` ("feat: aggregate step retries into total time, show each retry in tree
UI", 2026-08-29 14:06:36Z), merged to `origin/main` as `a560b873`, closed
Implemented/QA-Needed at `2095597b` (15:24:36Z). This branch's own commit, `278e0691`
("feat: track per-retry step attempt timing in tree UI"), landed over 3 hours later
(17:37:47Z), against a differently-scoped `attempts[]`/tree-UI-total design reviewed
independently below.

Landing step 7 (`Workflow: land the change`) found real, non-mechanical conflicts against
`main` in `store.ts`, `store.test.ts`, `runs.ts`/`runs.test.ts`, `step-timing.ts`,
`step-rail.tsx`/`step-rail.test.tsx`, and this spec's counterpart — not a stale-branch
rebase, but two independent implementations of the same feature. Forcing a merge would
either duplicate the mechanism or silently discard one side's tests, so this branch was
**left unmerged, parked at `278e0691`, pushed to `origin/cez/6ed5bc42` only** — `main` is
already correct and untouched. If a future session wants the union of both designs (this
branch also adds the `retry-step-timing.e2e.ts` Playwright fixture main's version lacks),
diff the two `store.ts`/`step-timing.ts`/`step-rail.tsx` changes by hand; don't re-attempt
an automatic merge.

Original text, kept for the record below.

**Status:** SPEC, written 2026-08-29 by step 2 of run `6ed5bc42-b99d-4f6d-a346-de794980718c`
(`spec-to-deploy`). Not implemented. No file outside this one was changed by the spec step, which
matters for §Phase 3: the two in-place corrections this spec calls for (spec
`2026-08-20-step-and-tool-call-durations.md` risk R3, and the doc comment on `stepElapsed`) are
**still outstanding** and belong to the implementation phases, not to this document's authorship.
**Date:** 2026-08-29
**Revision 2, 2026-08-29,** after a read-only review checkpoint returned `revise`. Seven
current-code claims were wrong and are corrected **in place**, each marked where it sits rather
than appended: the second `StepState` schema in `store.ts` (§Data models), the re-entry count and
the live-broker `running → running` path (§Problem, §Architecture), the `loopBackTo` lifecycle and
the `retried` outcome mapping (§Problem, §Architecture), the `StepClock` fallback branch and the
open attempt's clock (§Architecture), the response-shape claim (§API contracts), and two
unexecutable verification steps, `npm run lint` (which does not exist here) and a `CEZ_RUN_FAULT`
loop-back (which `stall-step` cannot produce) (§Verification). Phase 1 and §Solution were adjusted
to match, and §Verification gained V6.
**Revision 3, 2026-08-29,** after a second read-only review returned `revise`. Two blocking gaps and
five narrower ones, again corrected **in place**:

1. **`runContinuation` is a second retry seam**, and revision 2 missed it entirely. `continueRun`
   creates a fresh `continue-N` step (`run.ts:4537-4539`), but the cold-broker (`:5298`) and
   missing-session (`:5326`) branches then re-invoke `runContinuation` for the **same** `stepId`,
   and it re-writes `iterations: 1` at `:4785-4791` every time. Revision 2's rule
   "`iterations === 1` means replace the attempts array" would therefore have **erased** the earlier
   attempt on exactly the path this spec exists to measure. The replace rule is gone (§Architecture),
   and Phase 1 plus the new V7 cover both continuation retries.
2. **`outcome` is removed from this feature.** Revision 2 claimed exactly four sites patch an OPEN
   attempt straight to `pending`. Measured at `d3b2cd1a` at least seven do (revision 4 re-measured
   the full closing set at **nineteen**, see §Architecture), and three of them
   (`reenterChain` `:2979`, its `resetTo` slice `:2939`, `requeueHandoff` `:6631`) are crash
   recovery, an approval decision and a human resolving a handoff, not retries. An attempt is now
   `{ n, startedAt, endedAt? }` and a row reads `attempt N · duration`. §Architecture says why the
   label cannot be derived honestly from a status transition.
3. §API contracts: the live-re-attach guard must suppress the duplicate `step-start` **event**
   (`run.ts:5766`) as well as the store patch, or the record says one attempt while the NDJSON says
   two.
4. §Architecture, the web side: `stepAttempts` fails **closed**, its completeness predicate is
   spelled out rather than implied, and `StepClock` keys on the same predicate the rows do.
5. The `step-timing.ts` comment and `STEP_CLOCK_TITLE` corrections moved from Phase 3 to **Phase 2**:
   they become false the moment the aggregate UI lands, so they cannot sit in a later phase.
6. V3e no longer claims a component test can observe whether a parent re-rendered; the executable
   guard is the existing `packages/web/src/design-guardian.test.ts` rule.
7. V5's fixture is deterministic (`sleep`-timed check steps with known durations) and its assertions
   are `jq -e` rather than prints.

Sections not named in the review that changed for internal consistency, disclosed rather than
smuggled: §TLDR and §Solution items 1 and 3 (the dropped `outcome`), §Problem's re-entry table (the
three newly measured active→`pending` sites), §Risks R6 (it cited the deleted replace rule), and the
line numbers `:5891`/`:5911`, which were off by a few and are now `:5887`/`:5912` as measured.
**Revision 4, 2026-08-29,** after a third read-only review returned `revise`. Eight items, all
corrected **in place**, and three of them were correctness defects in the proposed design rather
than in its prose:

1. **The mid-deploy rule was corrupting, not merely partial.** Revision 3's store rule would have
   appended `{ n: 1 }` to a legacy step already carrying `iterations: 2`, then rewritten
   `patch.iterations` from the array, **overwriting a real count of 2 with 1**. `trackAttempt` now
   gates on `step.iterations === 0` at the first opening patch and leaves an in-flight legacy step
   untracked forever (§Architecture, R5/R6, V1i).
2. **The continuation attempts now close at their abandonment**, with a `status: 'pending'` patch
   in each of `runContinuation`'s two retry branches (`run.ts:5240`, `:5261`), because `finally`
   runs `autosaveCommit` and the rest of teardown *before* the next attempt opens, so closing at the
   next open charged all of it to the failed attempt (§Architecture, V1d, V7).
3. **The continuation `step-start` event's `iteration` is corrected too**, not only
   `StepState.iterations`. `run.ts:4785-4792` hard-codes `1` in both; fixing only the store would
   have left the second event claiming attempt 1 while the record claimed attempt 2 (§API
   contracts, V7a/V7b).
4. **The collapsed summary clock aggregates as well.** Revision 3 deliberately left the commonest
   clock on screen showing the latest attempt, which is not what the task asked for (§The web side,
   V3d).
5. **`ResolvedAttempt` carries a validated `startedAt`, and the total exposes `closedMs` plus the
   open attempt's `startedAt`.** Revision 3's `{ n, ms, live }` / `{ ms, live }` could not have
   implemented the live clocks the same section promised (§The web side, V2c).
6. **`finishedAt` is not written in one place.** Revision 3 said it was `finishStep` alone; nine
   more `updateStep` sites stamp a terminal step timestamp directly (§Problem). Every derived
   "eight closing sites" claim is corrected to the measured **nineteen**.
7. **V5's fixture repository could not have run.** `cezar run` isolates in a worktree by default
   and the fixture created an unborn repository; `git worktree add` on one produces an EMPTY tree
   (`checkout.ts:183`, `boot-repo.ts:34`). It now creates `main` and an empty commit, and pins
   `pipefail` (§Verification V5).
8. **V5 step 5 named an `onFail` that does not exist** on the `work` step. It is now a complete
   second check-only workflow with its own invocation, exit-status assertion and `jq -e` gates.

**Revision 5, 2026-08-29,** after a fourth read-only review returned `revise`. Nine items, all
corrected **in place**. The review confirmed the core design against `d3b2cd1a` and found no
defect in it; these are verification, phasing and record problems:

1. **§Verification claimed this box has no browser. It is not true, and it excused the one gate
   that matters for a UI change.** This repository ships a self-provisioning real-browser harness
   (`.ai/scripts/test-env-up.sh`, `.ai/browsers/agent-browser.md`, thirty-plus specs in
   `packages/web/e2e/`), and both the `agent-browser` binary and a real Chrome are already cached
   on this box. The visual pass is now **V5b**, an automated E2E with named selectors, retained
   screenshots and video, and a `TEST_E2E_STATUS=passed` requirement.
2. **Phase 2 gained that E2E**, its captured fixture, and the browser-provider **recording support
   the repository does not have yet**: `AgentBrowser` exposes `screenshot` alone, so Phase 2 adds a
   `record` operation to the descriptor and a `startRecording` / `stopRecording` pair to the
   wrapper (§Phase 2 item 8).
3. **V5 step 1's expected exit status is now asserted**, not printed. `echo "cezar exit=…"` is a
   diagnostic; it is now `rc=${PIPESTATUS[0]}` plus an explicit gate before `runs.json` is read.
4. **V1e's expectation contradicted itself** ("exactly the first four have an `endedAt` and so does
   the fifth"). It now states that all five are closed, and by which transition.
5. **Phase 1 is no longer described as invisible.** It changes continuation `iterations`, the
   `step-start` `iteration`, the CLI's `(attempt 2)` line, and a duplicate reattach event, all on
   the day it ships.
6. **The `stepAttemptSchema` doc comment no longer bakes in a count** ("all nineteen closing
   paths"). Current code has nineteen matching sites and this spec's Phase 1 adds two, so the
   comment would have shipped false; it now speaks of every qualifying transition through
   `RunStore.updateStep`.
7. **Phase 3 item 11 followed the retired procedure.** A corpus write is now a proposal appended to
   `CEZ_KB_WRITE_FILE`, never a direct edit of the mounted corpus, and the run reports corpus sync
   pending until the proposal is applied and `cez kb search` finds it. A reindex cannot promote an
   unapplied proposal.
8. **The title is now three words** (`Retry Step Timing`), per the workspace rule. The allocated
   file path is unchanged.
9. **Every em dash is gone**, per the house rule. Two blockquotes of existing source text are
   rendered with a `[...]` elision instead, so no quotation was altered to satisfy the rule
   (§Problem).

One thing measured while doing item 9 and worth recording: §Verification cited `run.ts:5560` for
the isolated-worktree note; the emit is at **`run.ts:5554`** at `d3b2cd1a`, and the line is
corrected there.

**Brief this was written against:** `.ai/specs/briefs/2026-08-29-retry-attempt-timing-tree-ui.md`
(step 1 of the same run). Every file it cites was re-opened at `d3b2cd1a`; where the brief and the
code disagreed, §Problem says so.

## TLDR

A workflow step that was retried wears a bare `×3` badge in the rail
(`packages/web/src/routes/task-thread/step-rail.tsx:104-108`) and a clock that shows **attempt 3
only** (`step-timing.ts:38-48`). The two other attempts are not merely unshown, their durations
do not exist anywhere the cockpit can reach. The engine overwrites `StepState.startedAt` on every
re-entry (`packages/cezar/src/workflows/run.ts:5762-5763`) and never stamps a `finishedAt` on an
attempt it retried away, so the record keeps exactly one attempt's worth of timing no matter how
many there were.

Give `StepState` an additive, optional `attempts: StepAttempt[]`, one `{ n, startedAt, endedAt? }`
per attempt, maintained inside `RunStore.updateStep` off the status transition, which is the one
seam every retry path in the engine already passes through. Then the expanded rail renders **a
child row per attempt with its own duration** (the "tree UI" the task asks for) and the step's
headline clock becomes **the sum across attempts** instead of the last one, on the collapsed
summary line as well as the expanded row, since that is the clock most users actually see. An
attempt records
**when it ran, not why it ended**: §Architecture measures why an outcome label cannot be derived
honestly from a status transition, and this spec does not ship one.

Three phases, each shippable alone: backend+contract (data starts accruing, no visible change),
web (the tree and the total), record (supersede R3 and the stale doc comments it planted).

## Problem

### What the cockpit shows today

`RunHeader` renders `<WorkflowSteps runId={run.id} steps={run.steps} …/>`
(`packages/web/src/routes/task-thread/run-header.tsx:294`). Collapsed, that is a dot strip plus the
**current** step's model and clock (`step-rail.tsx:380-393`). Expanded, `StepRail` renders one flat
row per step (`step-rail.tsx:77-121`): glyph, name, an optional `stopReason`, the `×N` iterations
badge when `iterations > 1` (`:104-108`), the model chip, `kind · step i of n`, and `StepClock`
(`:113`).

`StepClock` (`step-rail.tsx:263-280`) calls `stepElapsed(step, Date.now())`
(`step-timing.ts:38-48`), which is `now − startedAt` while the step is active and
`finishedAt − startedAt` once it is terminal. Its own doc comment already names the defect:

> The number is elapsed wall-clock for the CURRENT ATTEMPT. `run.ts` overwrites `startedAt` on
> every retry, so a step wearing an `×3` badge shows attempt 3, not the three summed [...]
> cumulative cost would need a persisted field that does not exist (spec risk R3).

Source: `packages/web/src/routes/task-thread/step-timing.ts:34-36`. Quotations in this spec elide a
clause break at `[...]`, which is also how the second quotation below (of spec
`2026-08-20-step-and-tool-call-durations.md` risk R3) is rendered. The elision is punctuation only:
no word of either original is changed, added or dropped.

and the clock's hover text says the same to the user: `'Elapsed since this step started (the
current attempt).'` (`step-rail.tsx:249`). So the current number is *honest*, and that is exactly
the problem: it is honestly answering a question nobody asked. A reader looking at `×3` wants to
know what the three attempts cost, and gets the third one's stopwatch with a disclaimer.

### Why the data is not merely unshown but destroyed

Every attempt of every step begins at the top of `stepLoop`:

```ts
const record = this.store.getRun(runId)?.steps.find((s) => s.id === step.id);
const iteration = (record?.iterations ?? 0) + 1;
this.store.updateRun(runId, { currentStepId: step.id });
this.store.updateStep(runId, step.id, {
  status: 'running',
  iterations: iteration,
  startedAt: new Date().toISOString(),   // ← run.ts:5763, overwrites attempt N−1's start
  error: undefined,
});
emit({ type: 'step-start', stepId: step.id, name: step.name ?? step.id, kind, iteration });
```
Source: `packages/cezar/src/workflows/run.ts:5754-5766`

**Corrected in revision 4.** This paragraph said `finishedAt` is written "in exactly one place,
`finishStep` (`run.ts:8272-8288`)". That is false, and it matters because the whole §Architecture
argument for instrumenting the *store* rather than the call sites rests on how many sites there
really are. Measured at `d3b2cd1a`, `finishStep` (`:8287`) is one of **ten** `updateStep` calls in
`run.ts` that stamp a step's terminal `finishedAt` directly: `:2398` (restart settles an open step
`done`), `:2436` (restart marks it `failed` with an "interrupted" error), `:5003` (`failBeforeSpawn`), `:5186`
(continuation cancelled), `:5195` (continuation `done` at a budget stop), `:5221` (continuation
`done`), `:5278` (continuation `failed`), `:6620` (handoff skipped), `:6764` (approval granted with
no live waiter), and `finishStep` itself.

The narrower claim, which is the true one and the only one the design needs:

- **An attempt that was retried away has no separate interval at all.** No retry path stamps a
  `finishedAt` for the attempt it abandons: the chain-loop retries patch the step back to `pending`
  and re-enter the loop, and `retryAfterFailedPostcondition` does the same (`run.ts:8230`).
- **The continuation retry branches do not close their attempt in any way.** `runContinuation`'s
  `catch` sets a retry flag and appends a `note` plus a `metric` and patches the step *not at all*
  (`run.ts:5240-5262`), so the abandoned attempt is left `running` with no end mark of any kind.
  Revision 4 fixes this at the source (§Architecture).

So after three attempts the record holds attempt 3's `startedAt`, attempt 3's `finishedAt` (if it
ended, from whichever of the ten sites ended it), and `iterations: 3`. Attempts 1 and 2 left no
interval behind.

`stepElapsed` even has to defend against the wreckage: an ACTIVE step ignores `finishedAt`
entirely, because a re-run step keeps the *previous* attempt's finish while `startedAt` is
rewritten, and trusting both would print a negative duration (`step-timing.ts:41-44`, spec risk
R5).

### Every retry source funnels through `RunStore.updateStep`: verified, not assumed

**Heading amended after the second review.** It read "…funnels through that one site", where "that
one site" was `run.ts:5762-5767`. That is false: there are **two** opening sites, because
`runContinuation` (`run.ts:4785-4791`) opens attempts on the continuation path and never touches
the chain loop's head. What is true, and what the design actually depends on, is that both openings
and every abandonment pass through the same `RunStore.updateStep`.

The brief flagged this as open question 2 (does `onFail.retry`/`max` hit the same overwrite?). It
does. **Corrected twice against the code at `d3b2cd1a`:** the first draft counted **five**
re-entries and called all five retries; revision 2 counted **seven** and called one of them a
non-retry. Both undercounted. The measured set is below, and it is the set the design has to
survive, not a representative sample.

| Source | Code | What it does before re-entering |
| --- | --- | --- |
| Missing-session retry (one per step) | `run.ts:5887` | `updateStep({ sessionId: undefined, status: 'pending', error: undefined })` directly from the ACTIVE step, then `continue` on the same `i`. No `finishStep` |
| Cold-broker retry (one per step) | `run.ts:5912` | same active→`pending` patch, `reapAbandonedColdLaunch`, then `continue`. No `finishStep` |
| Stop re-entry (one per step) | `resumedAfterStop`, `run.ts:5853` | active→`pending`, then re-enters with a `stopResume` handle. No `finishStep` |
| Check-fail / reviewer `revise` loop-back | `loopBackTo`, `run.ts:5679-5687`; callers at `:5982-5987`, `:6019`, `:6091-6095` | **`finishStep` closes the source step FIRST**: `done` for a reviewer `revise` and for an approval-gate `changes` request, `failed` for a check step that failed, and only then does `loopBackTo` bump `retriesUsed` and patch every step from `onFail.retry` through `from` to `pending` (`:5685`) |
| Failed post-condition re-run | `retryAfterFailedPostcondition`, `run.ts:8230` | bumps `verifyRetries`, `updateStep({ status: 'pending', error: undefined })` directly from the active step. No `finishStep` |
| Dead-process chain re-entry | `reenterChain`, `run.ts:2979` | the process died mid-turn. Every non-terminal step in the remaining slice is patched active→`pending` with `finishedAt: undefined`, the run is re-queued, and `execute` relaunches or resumes. A real new attempt, but **crash recovery**, not a retry the workflow asked for |
| Approval "request changes" with no live `execute` | `reenterChain`'s `resetTo` slice, `run.ts:2939` | the same active→`pending` patch across the retry slice, reached when the approving user's request arrives after the engine loop for that run is gone (`run.ts:2919-2921`). The *same user action* that would have taken `loopBackTo` |
| Handoff requeue | `requeueHandoff`, `run.ts:6631` | the parked step is `waiting`; a human resolves the handoff and it goes straight to `pending` with `finishedAt: undefined`. No `finishStep` |
| **Continuation retry, same step** | `runContinuation` re-invoking itself at `run.ts:5298` (cold broker) and `:5326` (missing session) | **added in revision 3, and it was the largest gap.** The `catch` sets a retry flag, appends a `note` and a `metric`, and does **not** patch the step at all; the `finally` then calls `runContinuation` again with the **same `stepId`**, which re-writes `{ status: 'running', iterations: 1, startedAt: now }` (`:4785-4791`) and re-appends `step-start` (`:4792`) over a step that is still `running` with its previous attempt still open |
| **Live broker re-attach (NOT a retry)** | `reattachBrokeredRun`, `run.ts:2419` and `:2717-2766` | the agent is still alive behind a broker. The step is deliberately left **`running`** (`stepTerminal(openStep.status)` is the refusal guard, `:2734`), `pendingReattach` is set, and `execute` is called at the surviving step |

Three consequences worth stating plainly, because all three bear on the design:

1. **The engine needs almost no per-retry-site instrumentation.** Two sites open an attempt
   (`run.ts:5762-5767` and `:4785-4791`) and every abandonment is an `updateStep` patch.
   Instrumenting the *store* covers all of the above by construction, including any site added
   later. The **one** exception is the live broker re-attach, which is not a retry and needs a
   guard at the loop head rather than in the store (§Architecture).
2. **`iterations` is not a reliable attempt counter today, and on one path it is simply wrong.**
   The chain loop derives it (`(record?.iterations ?? 0) + 1`, `run.ts:5757`), but
   `runContinuation` hard-codes `iterations: 1` on every invocation, so a continuation that retried
   its cold broker reports **one** iteration for **two** attempts. The comment at `run.ts:5320-5325`
   asserts the opposite, that "the record ends up looking like a step that took two iterations",
   and it is describing an intent the code does not implement. §Architecture makes the claim true
   rather than leaving the comment wrong.
3. **Only some paths are capped at one retry.** `loopBackTo` is bounded by the step author's
   `onFail.max` (`packages/contract/src/workflows.ts:70-73`, `canLoopBack` at `run.ts:5664-5665`)
   and `retryAfterFailedPostcondition` by `verdict.retryMax`, so `iterations > 2` is reachable in
   normal operation, and this is not a two-attempt-shaped problem.

`loopBackTo` resets the intervening steps to `pending` **without touching `iterations`**
(`run.ts:5684-5686`), so those steps' counters keep climbing correctly when they re-run. That is
also why a design must tolerate a `pending` patch arriving for a step whose last attempt is
already closed (§Architecture, the idempotence guard).

**Two of the re-entries need naming separately, and the second is why this spec touches `run.ts` at
all.**

1. **`runContinuation` wears two hats, and revision 2 saw only the harmless one.** When the user
   Continues a finished interactive step, `continueRun` calls `addStep` for a brand-new
   `continue-N` step (`run.ts:4537-4539`) and `runContinuation` opens attempt 1 on it. That case is
   trivial: a new step has no attempts to collide with. But the **same function re-invokes itself
   for the same step** on a cold-broker or missing-session failure (`:5298`, `:5326`), writing
   `iterations: 1` and a fresh `startedAt` over a still-open attempt. Revision 2 read only the
   first hat and concluded that `iterations === 1` should **replace** the attempts array; on the
   second hat that rule deletes attempt 1 the instant attempt 2 opens, which is precisely the
   timing the task asked to see. The replace rule is withdrawn in §Architecture and the same-step
   re-entry is handled by the store's open-attempt branch.
2. **`reattachBrokeredRun` re-enters `execute` with the step still `running` and the same agent
   still working.** An earlier draft of this spec asserted that a `running → running` patch "is not
   a path in the engine today". **That is false**, and it is false on every cezar restart that
   finds a live brokered agent. `reattachBrokeredRun` refuses only when the step is *terminal*
   (`run.ts:2734`), so a `running` step is precisely the case it accepts; it then calls
   `this.execute(run.id, workflow, input, resumeAt)` (`:2755`) at that same step. The loop head it
   lands on is unconditional (`run.ts:5760-5767`): it reads
   `iteration = (record?.iterations ?? 0) + 1`, writes `status: 'running'`, and **replaces
   `startedAt` with `new Date()`**, for an attempt that never ended.

   Left alone, the store bookkeeping below would close the live attempt at the restart instant and
   open a second one, so **one agent turn interrupted by a cezar restart would render as two
   attempts**: the tree would show a spurious row, and the pre-restart interval would be split
   across two entries whose sum is right only by accident (the `iterations` bump is itself already
   wrong today, and this spec would make it visible rather than latent).

   The live re-attach is distinguishable, cheaply and exactly: `pendingReattach` is set for the run
   before `execute` is called (`run.ts:2744-2748`) and names the surviving `stepId`, and **no other
   path sets it**. Its dead-process sibling `reenterChain` (`run.ts:2423`) sets nothing, re-queues
   the run and relaunches or resumes the work, and **is** a genuine new attempt.

   So the loop head gains a guard, and this is a **behaviour change to `run.ts`, not only to the
   store**: when `pendingReattach` names this run and this step, skip the **entire** attempt-start
   operation, which is three things and not one, the `iterations` bump, the `startedAt`
   replacement, and the `step-start` emit at `run.ts:5766`. Suppressing only the store patch would
   leave the persisted record saying one attempt while the run's own NDJSON says a second one
   began, and the two disagreeing is a worse record than either mistake alone (§API contracts).
   `takeReattach`
   (`run.ts:2556-2566`) cannot serve as the read, because it is documented as a *consuming* read
   ("One read, then gone, either way") and is called later, from inside the agent-step path, long
   after the loop head has already written the patch. Read `this.pendingReattach.get(runId)`
   non-destructively at the loop head and leave the consuming read exactly where it is.

### What the record already decided, and what this spec changes

`.ai/specs/2026-08-20-step-and-tool-call-durations.md` (status DONE, shipped `69b4a3de`, "feat:
every step and every tool call says how long it took") introduced both clocks. Its **Risk R3**
identified this exact gap and disposed of it:

> `iterations > 1`: `startedAt` is overwritten on each attempt, so the rail shows the current
> attempt, not the cumulative cost… Cumulative-across-attempts would need a new persisted field
> [...] out of the web-only class, and **not asked for**.

It has now been asked for. This spec **reopens R3 and reverses its disposition**, and does not
re-litigate the analysis behind it, R3 was right about the mechanism and right about the cost
(a persisted field, therefore not web-only). What changed is the requirement, not the facts.

Two adjacent decisions this touches without contradicting:

- `.ai/specs/2026-08-22-bounded-transient-broker-retry.md` (commit `2258aee0`) deliberately kept
  the cold-broker retry's visibility to a dim transcript `note` plus a
  `run.step.retried_cold_broker` metric, and declined a >1 retry policy. Neither is disturbed here:
  this spec adds no retry, changes no bound, and adds a *timing* surface beside the note rather
  than replacing it.
- `thread-state.ts:693-706` deliberately suppresses `step-start` and non-failed `step-end` from
  the transcript, on the stated ground that "the run header's step rail (step-rail.tsx) is the
  steps surface." This spec keeps that division: the tree stays in the rail, and the transcript
  stays free of step frames.

### Why the field is worth its cost (the alternative, weighed)

The brief's central open question was persisted field vs. reconstruction from the `step-start` /
`step-end` NDJSON frames, which do carry per-attempt timestamps (`appendEvent` stamps `ts`/`seq`,
`store.ts`; the frames carry `iteration`, `run.ts:5766`). Reconstruction is genuinely attractive 
it is the pattern the prior spec used for tool-call durations, and it needs no contract change.
It was rejected on four measured grounds:

1. **The rail has no events in scope.** It renders from `run.steps`
   (`run-header.tsx:294`). Feeding it events means either lifting `thread-state`'s derived data up
   into the header or issuing a second fetch, a structural change larger than the field.
2. **History is reverse-paged at `RUN_HISTORY_PAGE_ITEMS = 100`**
   (`packages/contract/src/events.ts:31`). The early attempts of a long, chatty step are precisely
   the frames that have fallen off the loaded page. A total that grows as the user scrolls up is
   worse than no total.
3. **The collapsed summary line renders on screens the transcript is not mounted on**
   (`step-rail.tsx:393`). It would have to degrade to today's number anyway.
4. **It would reverse `thread-state.ts:701`'s suppression** of `step-start`, or duplicate the
   parse beside it.

The field costs one optional array on a schema that is already 30-odd fields
(`packages/contract/src/runs.ts:64-116`), and it is additive, which
`BACKWARD_COMPATIBILITY.md`'s general rule and §3 (`.ai/cezar/` state files) both permit without a
deprecation path. Note that cezar **is** on the compatibility list (it is a published npm CLI), so
"no backward compatibility" from the house rules does not apply here: additive-only is a real
constraint, not a preference.

## Solution

1. **`StepState.attempts`**: an optional array of `{ n, startedAt, endedAt? }`, one entry per
   attempt, in order. Absent on every record written before this ships, and on any step that has
   not started. **No outcome label:** the status transition cannot tell a retry from a crash
   recovery, an approval decision or a handoff resumption, so the array records timing only
   (§Architecture).
2. **Maintained in `RunStore.updateStep`**, driven by the status transition the patch describes 
   not by edits at the retry sites. One seam, structurally un-missable, unit-testable without
   booting a workflow. **One exception, and only one:** a live broker re-attach re-enters a step
   that never stopped running, and the store cannot tell it from a real new attempt, so it is
   suppressed by a guard at the step-loop head in `run.ts` (§Architecture).
3. **The rail grows a child level.** A step whose `attempts` array is complete and holds more than
   one entry renders indented `attempt N · <duration>` rows beneath its own row. That is the tree
   the task asks for. Anything short of complete coverage renders today's flat row (§Architecture,
   the web side).
4. **`StepClock` shows the sum** across attempts once there is more than one, live-ticking on the
   open attempt, with hover text that says what it is measuring, **on both of its call sites, the
   expanded row and the collapsed summary line**, so the default (collapsed) surface answers the
   task's "total time as step time" rather than deferring it to an expand. One attempt:
   byte-identical to today.
5. **No backfill, and no synthesis.** A step with `iterations > 1` and no covering `attempts`
   array renders exactly as it does today. §Risks R5 explains why a synthesized single entry would
   be a lie rather than a partial truth.

## Architecture

### The one seam

```
OPENS an attempt
  run.ts:5762  updateStep({status:'running', iterations:N, startedAt})  ─┐  ← SKIPPED ENTIRELY (patch
               (guarded on pendingReattach naming this run+step)         │    AND step-start emit) on a
  run.ts:4785  updateStep({status:'running', iterations:1, startedAt})   │    live broker re-attach
               (runContinuation; RE-INVOKED for the SAME stepId at       │
                :5298 cold broker / :5326 missing session, over a        ├─→ RunStore.updateStep
                still-open attempt → close attempt N, open N+1)          │     └─ trackAttempt(step, patch, now)
CLOSES an attempt: NINETEEN sites, every one an updateStep patch whose  │
  status leaves running/waiting/review. Ten of them stamp finishedAt      │
  directly (§Problem); nine patch straight to pending. Representative:    │
  run.ts:8287  updateStep({status, error, finishedAt})  (finishStep)      │
  run.ts:5887  updateStep({status:'pending', …})   (missing session)      │
  run.ts:5912  updateStep({status:'pending', …})   (cold broker)          │
  run.ts:5853  updateStep({status:'pending', …})   (stop re-entry)        │
  run.ts:8230  updateStep({status:'pending', …})   (post-condition)       │
  run.ts:2979  updateStep({status:'pending', …})   (reenterChain)         │
  run.ts:2939  updateStep({status:'pending', …})   (resetTo slice)        │
  run.ts:6631  updateStep({status:'pending', …})   (requeueHandoff)       │
  run.ts:5240  updateStep({status:'pending', …})   (continuation cold     │
  run.ts:5261  updateStep({status:'pending', …})    broker / missing      │
               ADDED BY THIS SPEC, see below                             │
  + :2398 :2436 :5003 :5186 :5195 :5221 :5278 :6118 :6620 :6764           │
NO-OP (idempotence guard: the attempt is already closed)                  │
  run.ts:5685  updateStep({status:'pending'})      (loop-back COLLATERAL, │
               always AFTER finishStep closed the source step)           ─┘
```

**How the nineteen were counted, so the number is reproducible rather than asserted.** `run.ts` at
`d3b2cd1a` holds 50 `this.store.updateStep(` calls. Filtering to those whose patch carries a
`status` that is not `running`/`waiting`/`review` leaves exactly nineteen: `:2398`, `:2436`,
`:2939`, `:2979`, `:5003`, `:5186`, `:5195`, `:5221`, `:5278`, `:5685`, `:5853`, `:5887`, `:5912`,
`:6118`, `:6620`, `:6631`, `:6764`, `:8230`, and `finishStep`'s own at `:8287`. Two more (`:5240`,
`:5261`) are added by Phase 1, making twenty-one. The point of the count is not the number: it is
that hand-editing twenty-one sites is not a plan, and one store helper is.

Three things the diagram is now saying that earlier drafts of it got wrong, all confirmed by
re-reading `run.ts` at `d3b2cd1a`:

- **`loopBackTo` is not an abandonment site.** Every caller closes the step through `finishStep`
  *before* calling it (`run.ts:5982-5987` reviewer `revise` → `done`; `:6017-6019` approval-gate
  `changes` → `done`; `:6091-6095` check failed → `failed`). By the time the `pending` patches at
  `run.ts:5685` arrive, the source step's attempt is **already closed**, and so are the attempts of
  every completed step in the slice between the retry target and the failing step. All of those
  `pending` patches are therefore collateral, and the idempotence guard is what absorbs them: it is
  load-bearing, not garnish.
- **A `running → running` patch does occur, from two different places, and revision 4 removes one
  of them.** The live broker re-attach is one, and the correct response is to stop it before it
  reaches the store, not to "defensively close" in the store. The continuation retry
  (`run.ts:5298`, `:5326`) was the other; Phase 1 now patches the step to `pending` in the `catch`
  that decides to retry, so that path arrives as an ordinary close-then-open and the store's
  open-over-open branch becomes a defence against a future site rather than the handler for a live
  one.
- **The closing list is nineteen sites, not eight and not four.** Revision 2 listed four and
  attached a `retried` label to them; revision 3 said eight. See the count above and "Why an
  attempt carries no `outcome`" below.

`trackAttempt` is a small private helper called from `updateStep`
(`packages/cezar/src/runs/store.ts:982-991`) **before** the `Object.assign` merge, so it can see
the transition rather than only the result:

- **Eligibility, checked first, and it is what makes the field safe to deploy under a running
  engine.** `trackAttempt` tracks a step iff **either** `step.attempts !== undefined` (already
  tracked) **or** `step.attempts === undefined && step.iterations === 0` (this is the first opening
  patch this step has ever seen, so its attempt 1 really is attempt 1). Otherwise it returns having
  touched neither `step` nor `patch`, and it will keep returning for that step forever: an in-flight
  legacy step stays `attempts`-less and keeps the engine's own `iterations`.

  **Revision 3 had no such gate, and the result was corrupting rather than merely partial.** Take
  the mid-deploy case the spec has cited since revision 1: a step on attempt 2 when the backend
  swapped, carrying `iterations: 2` and no `attempts`. Its next retry would have appended
  `{ n: 1 }` and then had `patch.iterations` rewritten from `attempts.length`, **replacing a true
  count of 2 with 1**. The `×2` badge would disappear from the rail, and the record would claim a
  step that ran three times ran once. Falling back to today's flat row was supposed to be the
  fail-closed behaviour; silently rewriting the counter is not fail-closed in any direction.

  The gate is also what turns `attempts.length === iterations` from a hope into a fact the cockpit
  may rely on: either the store has owned that counter since attempt 1, or it never touched it.
  `addStep` seeds `iterations: 0` (`store.ts:978`), and both opening sites write `iterations: 1`
  while the **pre-merge** `step.iterations` is still `0`; `trackAttempt` runs before the
  `Object.assign` at `store.ts:993` precisely so it can read the pre-merge value. So every step born
  under the new code is tracked, and every step already in flight under the old code is not.
- **Open.** `patch.status === 'running'` and `patch.startedAt !== undefined`.
  - **No attempt open** (the ordinary case, and every first attempt): append
    `{ n: attempts.length + 1, startedAt: patch.startedAt }`.
  - **An attempt still open**, a same-step re-entry whose previous attempt was never closed.
    Stamp that attempt `endedAt = patch.startedAt`, **not `nowIso`**, then append the next one.
    The boundary matters: `nowIso` is read inside `updateStep`, which runs *after* the incoming
    `startedAt` was minted at the call site, so it can be strictly later than the instant the next
    attempt began. The two attempts would then overlap, and the aggregate would double-count the
    overlap, a total larger than the step's own span, which is the one arithmetic error a reader
    would notice and could not explain. `patch.startedAt` makes back-to-back attempts abut exactly.

    **This branch is now defensive only.** Revision 3 named `runContinuation`'s two retry paths
    (`run.ts:5298`, `:5326`) as its live producer; Phase 1 closes those at their real abandonment
    instead (below), and the live broker re-attach is stopped in `run.ts` before it can reach here.
    Keep the branch anyway, for a site added later, and let V1d′ pin its boundary.
  - **`patch.iterations` is corrected, not trusted.** After appending, `trackAttempt` sets
    `patch.iterations = attempts.length` on the patch it is about to merge, so the counter and the
    array can never disagree, which is the equality the whole read path keys on (§Data models).
    This is a deliberate, user-visible change on the continuation path: a continuation that retried
    its cold broker will wear `×2` and show two attempt rows, where today it wears no badge at all
    and shows one clock covering only the second try. `runContinuation` writes a literal
    `iterations: 1` on every invocation (`:4787`), so without this correction the two fields
    disagree on exactly the path this spec exists to measure. It also makes the comment at
    `run.ts:5320-5325` true for the first time.
  - **The `step-start` EVENT's `iteration` is corrected with it, at the call site.** Added in
    revision 4. `runContinuation` hard-codes the literal `1` **twice**, once in the store patch
    (`run.ts:4787`) and once in the event it appends a line later (`:4792`). Correcting only the
    store leaves the second `step-start` frame claiming `iteration: 1` while the record says
    `iterations: 2`, which is the same record-versus-NDJSON contradiction §API contracts refuses to
    ship on the re-attach path, arriving by a different door. The store cannot fix this one: it
    never sees the event. So `runContinuation` derives the next value from the record itself
    (`(this.store.getRun(runId)?.steps.find((s) => s.id === stepId)?.iterations ?? 0) + 1`) instead
    of writing `1`, and then emits the value the store **actually settled on** (re-read after
    `updateStep` returns, because `trackAttempt` may have corrected it) rather than the one it
    asked for. Reading it back is not belt-and-braces: a legacy step that failed the eligibility
    gate above keeps the engine's own counter, and an event derived from the pre-patch guess would
    disagree with the record for exactly the steps the gate exists to leave alone.
  - **There is no "replace the array" rule.** Revision 2 had one, keyed on `patch.iterations === 1`,
    meant to keep a fresh `continue-N` step's counter reset in step with its attempts. It was
    wrong, and dangerously so: the two continuation retries above write `iterations: 1` for the
    *second* and *third* attempts of the same step, so the rule would have deleted attempt 1 the
    moment attempt 2 opened. A fresh `continue-N` step needs no special case, because `continueRun`
    calls `addStep` (`run.ts:4537-4539`) and `addStep` seeds `iterations: 0` with no `attempts`
    key (`store.ts:978`), so there is nothing to collide with.
- **Close.** `patch.status` moves the step out of `running`/`waiting`/`review` → stamp the last
  open attempt with `endedAt = patch.finishedAt ?? nowIso`. **Nothing else about the attempt is
  recorded**, see the next subsection.
- **Idempotence guard.** Closing when there is no open attempt is a no-op. This is the common case
  for `loopBackTo`, not an edge: every step in the reset slice that has already run has a closed
  attempt, and the steps ahead of the failing one never ran at all.

**The continuation retries must close themselves, in `run.ts`, at the instant they give up.** This
is the second correctness fix of revision 4, and it is measurable rather than stylistic. Revision 3
left `runContinuation`'s two retry branches patching nothing and relied on the open-over-open branch
to close attempt N when attempt N+1 opened. But look at what runs in between. The `catch` sets
`coldBrokerRetry` (`run.ts:5240-5241`) or `missingSessionRetry` (`:5261-5262`) and returns; then
`finally` runs, in order, `recordUsagePeaks`, `clearIdleTimer`, `clearAutosaveTimer`,
**`autosaveCommit(state.cwd, 'turn end')`** (a real `git commit` over the whole worktree),
`discardWorkspaceRun` and `dropActive`, and only after all of it re-invokes `runContinuation`
(`:5287-5296` cold broker, `:5320-5343` missing session). Closing at the next open therefore charges
every millisecond of that teardown to the attempt that already failed. On a large worktree the
autosave commit alone is seconds, and it would land inside the number the tree presents as "how long
attempt 1 took".

So Phase 1 adds one line to each branch, in the `catch`, beside the `note` and the `metric` each
already appends:

```ts
this.store.updateStep(runId, stepId, { status: 'pending', error: undefined });
```

That is byte-for-byte the patch the chain loop's own cold-broker and missing-session retries already
write (`run.ts:5887`, `:5912`), so the store's close branch sees the shape it was designed for, the
attempt is stamped at the moment the failure was decided, and the rail reads
`running → pending → running` on the continuation path exactly as it does on the chain path.
Nothing else about the branches changes: the run stays `running`, the `note` and `metric` stay, and
the `finally` re-invocation is untouched. With both patches in place **no live path produces an
open-over-open patch**, which is why the branch above is described as a defence and why V7 asserts
the three-state transition rather than the two-state one.

### Why an attempt carries no `outcome`

**Revision 2 gave `StepAttempt` an `outcome` enum and this revision removes it.** The proposed rule
mapped a `pending` patch arriving at an OPEN attempt to `retried`, on the stated claim that exactly
four sites produce that shape. Re-measured at `d3b2cd1a`, **nineteen** sites close an attempt (the
count above), and the eight below are only the ones a reader is most likely to meet. They are not
the same kind of event:

| Site | Code | What it really is |
| --- | --- | --- |
| Missing session | `run.ts:5887` | a retry |
| Cold broker | `run.ts:5912` | a retry |
| Stop re-entry | `run.ts:5853` | a retry |
| Failed post-condition | `run.ts:8230` | a retry |
| Dead-process chain re-entry | `reenterChain`, `run.ts:2979` | **crash recovery** |
| `resetTo` slice | `reenterChain`, `run.ts:2939` | **an approval decision** |
| Handoff requeue | `requeueHandoff`, `run.ts:6631` | **a human resolving a handoff** |
| Terminal end | `finishStep`, `run.ts:8283` | the step finished |

The last three are why the label has to go rather than merely be narrowed. Take the approval that
requests changes: it reaches `loopBackTo` when an `execute()` loop is live for the run, and
`reenterChain`'s `resetTo` slice when it is not (`run.ts:2919-2921` says so in as many words). Under
revision 2's mapping the first spelling closes the attempt `done` and the second closes it
`retried`. **The same user action, on the same step, would be labelled two different things
depending on whether cezar happened to have restarted.** `reenterChain` has the same problem for
crash recovery, which a reader would read as "the workflow retried this step" when nothing about the
workflow did anything.

A label that changes with the process lifecycle is worse than no label, because a reader cannot tell
which of the two they are looking at. Timing does not have that problem: an interval is an interval
however the attempt ended, and the arithmetic in the headline total is identical either way.

The task asked for per-attempt time and a total. `{ n, startedAt, endedAt? }` answers exactly that
and nothing it cannot answer honestly. An outcome remains a reasonable later addition, but it has to
be built the other way round: each site declaring its own reason on the patch, rather than the store
guessing one from a status it cannot disambiguate. That is a separate spec, and §Deliberately not in
scope records it as such.

**Why close at the abandonment, not at the next open.** The tempting simplification, close
attempt N when attempt N+1 opens, is wrong for `loopBackTo`. That path sends the chain back to an
*earlier* step and re-runs every step in between before returning; attempt N of the failing step
would then absorb all of that intervening work. The close has to happen where the attempt actually
ends, which is what makes the status transition (rather than the next `startedAt`) the right
trigger.

**Why not close in `finishStep` and at each retry site instead.** Nineteen closing call sites is
nineteen chances to miss one, and a missed one produces an attempt with no `endedAt` that silently
drops out of the sum. The store sees all nineteen for free, which is also why Phase 1's two new
`pending` patches in `runContinuation` are cheap: they add a *transition*, and the store already
knows what to do with one. Note what this does *not* buy: the **opening** side
still needs the one `run.ts` guard, because the store cannot tell a live re-attach from a real new
attempt: by the time the patch arrives, both look identical.

### The web side

`step-timing.ts` gains two pure, `now`-injected functions beside `stepElapsed`, which is left
alone (the collapsed summary and any single-attempt step keep calling it):

- `stepAttempts(step, now)` → `readonly ResolvedAttempt[] | undefined`. **It fails closed**:
  `undefined` means *render exactly today's flat row*, and it is returned unless **every** clause
  below holds.

  **`ResolvedAttempt`, spelled out, because revision 3's `{ n, ms, live }` could not implement the
  live rows this same section promises.** The renderer needs `<LiveDuration since={a.startedAt}/>`
  for the open attempt, and `LiveDuration` takes an ISO string
  (`live-duration.tsx:26-27`, `:42`), not a number. A shape carrying only `ms` would have forced the
  row back into re-parsing `step.attempts` itself, which is exactly the timestamp handling this
  function exists to centralize.

  ```ts
  export interface ResolvedAttempt {
    /** 1-based, and equal to index + 1; the predicate below has already checked contiguity. */
    n: number
    /** This attempt's own `startedAt`, VALIDATED (it parsed through `instant()`) and passed
     *  through unchanged, so the open attempt's row can hand it straight to `<LiveDuration/>`. */
    startedAt: string
    /** Elapsed ms, clamped at 0: `endedAt − startedAt` when closed, `now − startedAt` when open. */
    ms: number
    /** Open, therefore ticking. True for at most the LAST entry, and only on an active step. */
    live: boolean
  }
  ```

  | Clause | Why it is not optional |
  | --- | --- |
  | `step.attempts` present and non-empty | the pre-ship record, and any step that never ran |
  | `attempts.length === step.iterations` | a drift check, not the mid-deploy handler. Revision 4 stops the store creating a partial array at all (the eligibility gate, §Architecture), so a mid-deploy step arrives here with **no** `attempts` and is caught by the clause above. This clause is what remains: a length that disagrees with the counter means a bug shipped, and summing such an array would under-report by whole attempts with no visible error |
  | `n` values are exactly `1..length`, in order | a gap means an attempt was lost; the sum would be a silent floor |
  | every `startedAt`, and every present `endedAt`, parses via the existing `instant()` helper (`step-timing.ts:50-55`) | `new Date('nonsense').getTime()` is `NaN`, and `NaN` propagates through the sum into `0:00` rather than into a visible error (prior spec risk R6) |
  | every **non-final** attempt has an `endedAt` | an open attempt in the middle of the array cannot be timed at all: `now` is the wrong end for it, and treating it as zero under-reports |
  | the **final** attempt is either closed, **or** open with `step.status` in `ACTIVE_STEP_STATUSES` | a terminal step with an open final attempt is a store bug, not a running clock. Timing it against `now` would print an interval that grows for as long as the page stays open and then freezes at whatever the last render happened to be, a confidently wrong number attached to a finished step |

  The last clause is the one that changes behaviour versus revision 2, which would have rendered
  such a step. It now falls back, and `stepElapsed` prints the honest single-attempt number
  instead.
- `stepTotalElapsed(step, now)` → `{ ms, closedMs, live, openStartedAt? } | undefined`. Defined
  **on top of** `stepAttempts`, not beside it: it returns `undefined` for exactly the inputs
  `stepAttempts` rejects, so the rows and the headline can never disagree about whether this step
  has a readable tree.

  | Field | What it is |
  | --- | --- |
  | `ms` | the whole total at `now`: `closedMs` plus the open attempt's elapsed, clamped per attempt. What a **frozen** headline renders |
  | `closedMs` | the sum of the CLOSED attempts alone, which does not move. Added in revision 4: the live headline is `<LiveDuration since={openStartedAt} format={(ms) => formatDuration(closedMs + Math.max(0, ms))}/>` (the clamp is required, and why is spelled out below this table), and revision 3's `{ ms, live }` exposed no such constant: the caller had no frozen base to add to, and `ms` itself moves with `now`, so back-dating `since` was the only shape left, which R4 rejects because it re-derives the anchor on every tick |
  | `live` | true iff the final attempt is open, which by the predicate above already implies the step is in `ACTIVE_STEP_STATUSES`, the same guard `stepElapsed` applies for the same reason (`step-timing.ts:41-44`) |
  | `openStartedAt` | present iff `live`: the open attempt's validated `startedAt`, i.e. the `since` the live headline counts from. Absent on a finished step, where there is nothing to tick |

  `ms === closedMs` exactly when `live` is false, which is the invariant V2b and V2c assert from
  both ends.

`StepRail` (`step-rail.tsx:88-118`) keeps its flat `<div data-slot="step-row">` and, when
`stepAttempts` returns a list **whose length is greater than 1**, renders sibling
`<div data-slot="step-attempt-row">` children after it, indented, one line each,
`attempt N · <duration>`. A single-attempt step renders no children, which is the same condition
`StepClock` uses for the aggregate, so the tree and the total appear and disappear together. The
`×N` badge stays (it is the affordance that says there is a tree to read) and gains a `title`
naming the total.

**Each attempt row owns a real clock, not a render-time snapshot.** A closed attempt renders a
frozen `<time data-slot="step-attempt-duration">` from `endedAt − startedAt`. The **open** attempt
(there is at most one, and only on the live step) renders `<LiveDuration since={a.startedAt}/>`,
so it ticks in step with the headline clock instead of freezing at whatever `Date.now()` happened
to be when the rail last re-rendered. Without this the last row of a running step's tree would sit
visibly stale beside a headline total that keeps moving, which reads as a bug.

**`StepClock`'s branch, stated exactly, because this is where a wrong guard silently changes
historical records.** `StepClock` takes an explicit `total?: boolean`.

- It uses the aggregate **only when both** hold: it was passed `total`, **and**
  `stepAttempts(step, now)` returns a list whose **length is greater than 1**. That is the identical
  predicate the attempt rows use, deliberately: one function, one answer, so a step can never show
  a tree with a last-attempt headline or an aggregate headline with no tree.
- **In every other case it falls through to today's code path unchanged**: `stepElapsed(step, …)`,
  the existing `STEP_CLOCK_TITLE`, the existing `<time data-slot="step-duration">` / `LiveDuration`
  markup. That covers every fallback with one condition: a pre-ship record with no `attempts`; a
  partial record (mid-deploy, or a step still mid-first-attempt under an older backend); a
  malformed one (unparseable stamp, gap in `n`, an interior attempt left open); a terminal step
  carrying an open final attempt; a single-attempt step; and the collapsed summary. The `length > 1`
  half is what makes the single-attempt claim in §Solution literally true rather than approximately
  true: a one-attempt step never enters the new branch at all, so its markup, its `title` and its
  `dateTime` are byte-identical to today by construction, not by the two paths happening to agree.
- **The collapsed summary (`step-rail.tsx:393`) IS passed `total` too. Changed in revision 4.**
  Revision 3 deliberately withheld it, on the ground that there is no room on that line for a tree.
  That reasoning holds for the *tree* and does not transfer to the *clock*: the task asks for "total
  time as step time (aggregated sum of each retry)", and the collapsed line is the clock most users
  see most of the time, because the rail defaults to closed (`openByRun.get(runId) ?? false`,
  `step-rail.tsx:365`). Leaving it on the latest attempt would have shipped the requested total to
  the surface behind a disclosure triangle while the default surface kept showing the number this
  spec exists to replace, and the two would have disagreed with no way for a user to tell which was
  which.

  So `<StepClock step={current} total/>` on the summary line. Nothing else about that line changes,
  and the change is inert unless the aggregate predicate holds: a single-attempt current step, a
  legacy step, or a partial record all fall through to today's `stepElapsed` number exactly as
  before, because `StepClock`'s branch is one condition and both call sites now share it. The tree
  stays expanded-only; only the number is reconciled.

The live case still delegates to `<LiveDuration/>` (`packages/web/src/components/live-duration.tsx`)
so the 1s tick stays inside one `<time>` leaf, spec `2026-08-20-step-and-tool-call-durations`
risk R2 and the design guardian's `no-tick-in-thread-containers` rule. Back-dating the anchor
(passing a synthetic `now − closedMs − openMs`) would recompute it on every tick, so instead pass
`since = total.openStartedAt` unchanged plus a `format` that adds the frozen `total.closedMs`
before formatting, **clamping the interval `LiveDuration` hands in, at zero, before it is added**:

```tsx
<LiveDuration since={total.openStartedAt} format={(ms) => formatDuration(total.closedMs + Math.max(0, ms))} … />
```

**The clamp is load-bearing, not defensive tidiness.** `LiveDuration` computes `format(now - start)`
with no clamp of its own (`live-duration.tsx:40-44`): `now` is the browser's `Date.now()` (via
`useNow`, `use-now.ts:10-16`), while `start` is `openStartedAt`, an instant stamped by the
**server**. A browser clock trailing the server's, or an open attempt stamped a moment in the future
by an unsynchronised box, makes `ms` negative, and `closedMs + ms` then prints a total **below** the
completed attempts' own sum: the headline ticks *backwards* past a number the expanded rows show as
already banked, and keeps doing so until real time catches up with the skew. `formatDuration` does
clamp, but its clamp is `Math.max(0, …)` applied to the value it is *handed* (`format.ts:46-54`),
which lands after the addition and therefore cannot protect a `closedMs` that is itself positive.
That is exactly why the single-attempt clock has never shown this and the aggregate one could.
Clamping each attempt's interval at zero *before* summing it, the same thing the frozen
`stepTotalElapsed.ms` already does per attempt, makes the live headline monotonic by construction:
it can stall at `closedMs`, never dip below it. Prefer hoisting the expression into a named helper
beside `stepTotalElapsed`, `liveStepTotal(closedMs) => (ms: number) => formatDuration(closedMs + Math.max(0, ms))`,
so the clamp cannot be dropped at one call site alone once the collapsed summary and the expanded
row both use it. **V3f asserts this from the future-dated side.** The attempt *rows* need no such
care: they pass the default `format`, i.e. `formatDuration` itself, whose own clamp is sufficient
when nothing is added to the value first.

Both fields come from `stepTotalElapsed` for this reason and no other. `LiveDuration` already takes
a `format` prop for exactly this kind of substitution (`live-duration.tsx:33-40`, where the tool chip
passes `formatToolDuration`), so this needs no change to that component: the attempt rows use the
same component with the default `format`, which is the other half of why it needs no change.

## Data models

### There are TWO `StepState` schemas, and the field must land in both

**Corrected after review.** An earlier draft named only `packages/contract/src/runs.ts`. That is
half the owners. The server has its **own, separate** `stepStateSchema` at
`packages/cezar/src/runs/store.ts:65`, and `store.ts:593` does
`export type StepState = z.infer<typeof stepStateSchema>` from *that* local one, which is the type
`updateStep(runId, stepId, patch: Partial<Omit<StepState, 'id'>>)` (`store.ts:982`) is written
against, and the schema `runRecordSchema` (`store.ts:569`) parses `.ai/cezar/runs.json` through on
load. The two are kept in step by a parity test, not by an import.

So adding `attempts` to the contract alone does not merely leave the mirror stale, it makes the
feature a **no-op that does not even typecheck**: `trackAttempt` could not read `step.attempts`,
could not write it (excess-property on the `Partial<StepState>` patch), and anything it did manage
to set would be **stripped on the next load**, because `runRecordSchema.safeParse` is what
re-materializes every record and a Zod object drops unknown keys. The bug would look like "the
field works until you restart cezar".

Required, therefore, in **both** files, with matching optional shapes:

| File | What lands there |
| --- | --- |
| `packages/contract/src/runs.ts` (`stepStateSchema`, `:64`) | `stepAttemptSchema` and `attempts` (the wire/client-facing declarations below) |
| `packages/cezar/src/runs/store.ts` (`stepStateSchema`, `:65`) | the same schema (local, as the file already keeps local copies of `usageCounterSchema` etc.) and the same `attempts: z.array(stepAttemptSchema).optional()` on the persisted shape |

Gates for the pair, none of which may be edited around:

- `packages/cezar/src/server/contract-parity.runs.test.ts`: mutual assignability between the two
  shapes. Note its known blind spot, documented at length in `packages/contract/src/workflows.ts`
  (the `heavy` comment): a mutual-assignability check is **silent about an added OPTIONAL property
  on one side only**, which is exactly the shape of this change. So parity alone will not catch
  the omission, and the tests below are not redundant with it.
- `packages/contract/src/runs.test.ts`: a step record with **no** `attempts` key still parses
  (the pre-ship record), and a record **with** `attempts` round-trips through
  `stepStateSchema.parse` unchanged.
- `packages/cezar/src/runs/store.test.ts`: the same two cases against the *store's* schema, via a
  `runs.json` fixture loaded through `runRecordSchema`, so the strip-on-reload failure above is
  pinned by a test rather than by a comment.

### The declarations

New, in `packages/contract/src/runs.ts` beside `stepStateSchema` (`:64`), and mirrored verbatim in
`packages/cezar/src/runs/store.ts` beside its own (`:65`):

```ts
/** One attempt at a step, and WHEN it ran, not why it ended
 *  (spec 2026-08-29-per-retry-step-timing). The engine overwrites `StepState.startedAt` on every
 *  re-entry (run.ts:5763, and run.ts:4787 on the continuation path) and only ever stamps
 *  `finishedAt` on a TERMINAL end (run.ts:8283), so before this existed a retried step's earlier
 *  attempts left no interval behind at all.
 *
 *  Written by `RunStore.updateStep` off the status transition, never by the retry sites, which is
 *  why EVERY qualifying status transition through this method is covered for free, however many
 *  call sites `run.ts` grows or loses. Deliberately not a number: `run.ts` held nineteen such sites
 *  when this was written and the same spec's Phase 1 adds two more, so a count baked in here is
 *  false the day it lands. The one thing the store CANNOT
 *  see is a live broker re-attach (`reattachBrokeredRun`), which re-enters `execute` on a
 *  still-running step; `run.ts`'s loop head suppresses that patch, and its `step-start` event,
 *  before either gets here.
 *
 *  PRESENT OR ABSENT, NEVER PARTIAL. The store starts tracking a step only on its FIRST opening
 *  patch (`iterations === 0` pre-merge) and never adopts one already in flight, so a step that was
 *  mid-retry when this shipped keeps `attempts` absent and keeps its own `iterations`, rather than
 *  gaining a one-entry array that would rewrite a true count of 2 down to 1.
 *
 *  DELIBERATELY no `outcome` field. The obvious mapping (a `pending` patch over an open attempt
 *  means "retried") is not derivable from the status: `reenterChain` (run.ts:2979, :2939) and
 *  `requeueHandoff` (:6631) write the same patch for crash recovery, an approval decision and a
 *  human resolving a handoff. An approval requesting changes even takes `loopBackTo` or
 *  `reenterChain` depending only on whether an `execute()` loop happens to be live, so the same
 *  user action would carry two different labels across a restart. Adding an outcome means each
 *  SITE declaring its own reason on the patch; that is a later spec, not this one. */
export const stepAttemptSchema = z.object({
  /** 1-based and contiguous: attempt k is at index k-1. The cockpit checks this rather than
   *  trusting it (`stepAttempts`), because a gap would make the total a silent floor. */
  n: z.number().int().positive(),
  startedAt: z.string(),
  /** Absent while the attempt is open. At most the LAST entry may be open, and only while the
   *  step itself is active. */
  endedAt: z.string().optional(),
});
export type StepAttempt = z.infer<typeof stepAttemptSchema>;
```

Added to `stepStateSchema`, next to `startedAt`/`finishedAt` (`runs.ts:88-89`):

```ts
  /** Every attempt at this step, in order (spec 2026-08-29-per-retry-step-timing). ADDITIVE and
   *  optional: absent on every record written before it shipped, and on a step that never ran.
   *  `startedAt`/`finishedAt` above are unchanged in BEHAVIOUR, but they are NOT a matched pair and
   *  must not be read as one. `startedAt` is overwritten on every re-entry, so it does describe the
   *  LATEST attempt. `finishedAt` is stamped only on a TERMINAL end (run.ts:8283), and the
   *  step-loop head that reopens a step rewrites `status`, `iterations`, `startedAt` and `error`
   *  but NOT `finishedAt` (run.ts:5760-5765), so while a retry is in flight `finishedAt` is a
   *  leftover from the PREVIOUS terminal attempt and is older than `startedAt`. Some abandonment
   *  sites do clear it (`reenterChain` at run.ts:2979/:2985 and `requeueHandoff` at :6631 write
   *  `finishedAt: undefined`); the ordinary retry loop does not, which is why the skew cannot be
   *  assumed away. That skew is pre-existing and this spec neither introduces nor repairs it:
   *  `stepElapsed` already ignores `finishedAt` on an active step for exactly this reason
   *  (`2026-08-20-step-and-tool-call-durations` risk R5). **`attempts` is the authoritative record
   *  of per-attempt timing**: it is the only place the earlier attempts exist at all, and the only
   *  place both ends of any attempt other than the latest can be read.
   *  Invariant the store MAINTAINS rather than assumes:
   *  `attempts.length === iterations` for any step whose FIRST attempt opened under a cezar new
   *  enough to write it, which is why `trackAttempt` rewrites `patch.iterations` from the array
   *  rather than taking the engine's word for it (`runContinuation` hard-codes `iterations: 1` on
   *  every invocation, including its own retries), and why it declines to track a step that was
   *  already past attempt 1 when it shipped, where rewriting the counter would LOSE a real count
   *  rather than correct a wrong one. The cockpit uses exactly that equality, plus the
   *  contiguity and closed-interval checks in `stepAttempts`, to tell a covered record from a
   *  partial or malformed one. */
  attempts: z.array(stepAttemptSchema).optional(),
```

Persistence is free: `RunStore` serializes the whole record with
`JSON.stringify(this.listRuns(), null, 2)` (`store.ts:1486`), and `redactStepPatch`
(`store.ts:965-969`) only ever touches `patch.error`, so the new field passes through untouched. An
old `.ai/cezar/runs.json` parses unchanged, the field is optional.

**Bound.** In practice `attempts.length` is `onFail.max` (author-set, single digits in every
in-repo workflow) plus at most one each from the three single-retry `Set`s. At ~90 bytes per entry,
even a pathological 100-attempt step adds ~9 KB to a record file that is rewritten whole on every
touch. No cap is imposed: a runaway retry loop is a bigger problem than its record size, and a cap
would make the sum a silent floor. Stated here so the arithmetic is on the record rather than
discovered later.

## API contracts

**No new route. Every run-returning response is additively widened.** *(Corrected after review: an
earlier draft said "no route shape changes", which understates it: the response bodies do change
shape, additively.)* `attempts` rides on `StepState`, which is serialized inside `steps` by every
run-returning route: `GET /api/v1/runs`, `GET /api/v1/runs/:id`, the project-scoped
`/api/v1/p/<projectId>/…` mirrors, and the SSE `run` snapshots `touch()` fans out. All of them gain
one optional array per step, and no existing field changes type, name or meaning. The api-client
re-exports the contract wholesale (`packages/api-client/src/index.ts:27`), so the web gets the type
with no client edit.

**The two required mirrors** (see §Data models) are the contract's `stepStateSchema`
(`packages/contract/src/runs.ts:64`) and the server's own persisted `stepStateSchema`
(`packages/cezar/src/runs/store.ts:65`). Both must carry the field; the wire type comes from the
first and the stored record from the second, and a change to only one is the failure mode §Data
models describes.

Guards that must stay green rather than be edited around, and the mutual contract-parity tests are
the gate:
`packages/cezar/src/server/contract-parity.runs.test.ts` (the two `StepState` shapes, mutually
assignable, with the optional-property blind spot §Data models names, which is why the parse tests
sit beside it), `packages/cezar/src/server/api-types.test.ts` (holds the api-client mirror
type-exact against the server's declaration), `packages/cezar/src/server/bc-route-inventory.test.ts`,
and `packages/contract/src/runs.test.ts`.

**SSE/NDJSON event SCHEMAS: unchanged. Two event STREAMS change, on two paths.** *(Revision 4: it
was one. The continuation's `iteration` VALUE is the second, and it is not optional.)* `step-start`
already carries `iteration` (`run.ts:5766`) and `step-end` already carries `status`
(`run.ts:8294-8300`); neither gains, loses or renames a field, so per `BACKWARD_COMPATIBILITY.md`
§7 the append-only event vocabulary is untouched and this spec appends nothing to it.

**Change 1: `step-start.iteration` on the continuation path stops lying.** `runContinuation` writes
the literal `1` in two adjacent statements (the store patch at `run.ts:4787` and the event at
`:4792`), and it re-invokes itself for the **same** `stepId` on a cold-broker (`:5298`) or
missing-session (`:5326` ) failure. So a continuation that retried once emits two `step-start`
frames for one step, **both saying `iteration: 1`**, and the CLI's own console printer suppresses
its `(attempt N)` suffix on exactly that basis (`index.ts:1144`, `Number(event.iteration) > 1`), so
the second attempt is invisible at the terminal today as well as in the record.

§Architecture corrects the store side. Correcting only the store would make the disagreement worse
rather than better: the record would say `iterations: 2` while the second frame still said
`iteration: 1`, and a consumer reconciling the two would have to guess which lied. So the fix is at
the call site and covers both writes:

| Today (`run.ts:4785-4792`) | After |
| --- | --- |
| `updateStep(…, { status:'running', iterations: 1, startedAt, … })` | `iterations` derived from the record: `(store.getRun(runId)?.steps.find((s) => s.id === stepId)?.iterations ?? 0) + 1` |
| `appendEvent(…, { type:'step-start', …, iteration: 1 })` | `iteration` **re-read from the step after `updateStep` returns**, so the event always carries the value the store settled on |

The re-read is load-bearing rather than defensive. `trackAttempt` may *correct* the value it was
handed (it rewrites `patch.iterations` from `attempts.length`), and it may *decline* to touch it at
all for a legacy step that failed the eligibility gate. Only the post-patch record knows which
happened, so an event derived from the pre-patch computation would disagree with the record for
precisely the steps the gate exists to leave alone. V7a and V7b assert the frame sequence
`[1, 2]` rather than today's `[1, 1]`.

**Change 2: a live broker re-attach no longer emits a duplicate `step-start` frame.**

The guard §Architecture puts at the loop head suppresses the *whole* attempt-start operation, not
only the store patch: today a cezar restart that reattaches a still-live agent emits a second
`step-start` for a turn that never restarted, with `iteration: 2`. Suppressing the store patch
alone would leave the persisted record saying "one attempt" while the run's own NDJSON says a
second one began, so the tree and the transcript would disagree about a step neither of them
should have doubted. A consumer counting `step-start` frames per `stepId` will therefore see one
fewer frame than before on exactly that path; that is the correction, not a regression, and V6a
asserts it. No other emit site is touched, and `runContinuation`'s own re-emit at `run.ts:4792`
**stays**, because there a real second attempt genuinely began; it merely stops calling that
second attempt the first one (change 1).

## Phases

Three phases, in implementation order. **They are checkpoints, not three releases.** This repo
ships **one commit per session/feature** (workspace `CLAUDE.md`; `AGENTS.md` §"Shipping cezar
itself"), so all three land together in the session's single feature commit, made only after
§Verification has actually been executed. What "each phase stands on its own" means here is
narrower and still worth holding: each one compiles, keeps the five gates in §Verification V4
green, and leaves nothing false in the product, so a phase boundary is a safe place to stop and
have the work reviewed. It is not a licence to push three times.

### Phase 1: the field and the store bookkeeping (backend + contract)

Backend-first and compatible, but **not invisible**. The tree UI waits for Phase 2, so no rail
gains attempt rows and no clock aggregates yet. Four things do change the moment this ships, all of
them on the continuation path and all of them user-observable: a step that retried its broker or
its session reports `iterations` equal to its real attempt count instead of a fixed `1`, so the
`×N` badge appears where none did before; its second `step-start` frame carries `iteration: 2`,
which makes the CLI print `(attempt 2)` (`index.ts:1144`); it now passes briefly through `pending`
between attempts, as the chain path already does; and a live broker re-attach stops emitting a
duplicate `step-start` frame. Those are the four changes §API contracts documents and §Phase 3
item 10 puts in the changelog, which is why "no visible change" was the wrong summary of this
phase. Data also starts accruing the moment the engine runs under this code, which is the reason
Phase 1 comes first: it is **the first implementation checkpoint, and Phase 2 consumes its
output**. By the time Phase 2's rendering is written there are real multi-attempt records to build
its fixtures from rather than hand-imagined ones, which §Verification V5b item 1 depends on
outright ("captured, not invented"). Both phases still land in the session's single feature commit,
per §Phases: this ordering is about what is buildable when, not about shipping twice.

1. **Both** schema owners, in one change (§Data models): `packages/contract/src/runs.ts` and
   `packages/cezar/src/runs/store.ts` each get `stepAttemptSchema` and the `attempts` field on
   their own `stepStateSchema`, with the doc comments above. Contract-only does not compile and
   does not persist.
2. `packages/cezar/src/runs/store.ts`, private `trackAttempt(step, patch, nowIso)` called from
   `updateStep` before the `Object.assign` at `:993`; the **eligibility gate** (`attempts` present,
   or `iterations === 0` pre-merge, the mid-deploy corruption guard), the open branch (including
   the defensive close-and-reopen at `patch.startedAt` and the `patch.iterations` correction), the
   close branch, and the idempotence guard, exactly as §Architecture describes. **No replace rule**,
   and no `outcome`.
   Also in this item, because the store cannot do it: `packages/cezar/src/workflows/run.ts`, the
   live-re-attach guard at the step-loop head (`:5756-5766`): when
   `this.pendingReattach.get(runId)?.stepId === step.id`, skip the `iterations` bump, the
   `startedAt` replacement **and the `step-start` emit at `:5766`**, and therefore open no attempt.
   A non-consuming read; `takeReattach` (`:2556-2566`) stays exactly as it is.
3. **`runContinuation`'s two retry seams, also in `run.ts`** (added in revision 4, §Architecture):
   (i) `this.store.updateStep(runId, stepId, { status: 'pending', error: undefined })` in **each**
   retry branch of the `catch` (`run.ts:5240-5241` cold broker, `:5261-5262` missing session),
   beside the `note` and `metric` each already appends, so the abandoned attempt is closed where it
   actually ends rather than after `finally`'s `autosaveCommit` and teardown; and (ii) at the
   opening site (`:4785-4792`), derive `iterations` from the current record instead of writing the
   literal `1`, and emit the `step-start` `iteration` **re-read from the step after `updateStep`
   returns** (§API contracts, change 1). Neither half is optional: without (i) the tree over-reports
   the failed attempt by the whole teardown, and without (ii) the NDJSON and the record disagree
   about which attempt just started.
4. Tests: `packages/cezar/src/runs/store.test.ts` (§Verification V1, plus the load/reparse case),
   `packages/contract/src/runs.test.ts` (an old record with no `attempts` still parses; a new one
   round-trips), the recovery regressions in §Verification V6, and the continuation regressions in
   §Verification V7, which extend `packages/cezar/src/workflows/broker-retry.test.ts` (it already
   drives `continueRun` through a cold-broker relaunch at `:143-174`) and
   `packages/cezar/src/workflows/recover-session-failure.test.ts` (its first case, `:55-110`,
   already drives `runContinuation` through the missing-session retry: it seeds `work` with
   `sessionId: 'missing-thread'`, sets `MOCK_CODEX_REJECT_RESUME=1`, calls `recover()`, and asserts
   the single `continue-1` step ends with a fresh session id and a
   `run.step.resumed_after_missing_session` metric). Revision 5 said that path had **no test
   today**; that was wrong, and V7b now extends that existing case instead of adding an unnecessary
   sibling of V7a. (`resume-missing-session.test.ts:250` really is the chain-loop path, as revision
   5 said, but it was never the only candidate.)

   **The V6 recovery regressions cannot be bolted onto `recover-brokered.test.ts` and
   `recover-chain.test.ts` as they stand**, which revision 5 also got wrong. Both suites construct
   their `RunManager` with `semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 0 } })`
   (`recover-brokered.test.ts:57-60`, whose own comment says "maxParallel 0 so nothing actually
   spawns: this tests the recovery DECISION"; `recover-chain.test.ts:49-51`). With no capacity the
   recovered run is queued and `execute` is never entered, so the step-loop head at
   `run.ts:5756-5766`, the exact seam this phase changes, never runs. V6 therefore needs
   **execution-capable** fixtures: available semaphore capacity (the default, i.e. no
   `maxParallel: 0` override) plus a controlled runner or broker, so that entering `execute` spawns
   nothing real. The pattern already exists in this repo: `broker-retry.test.ts:13-46` mocks
   `../core/runner-factory.ts` so `createRunner` returns a fake `AgentSession` whose outcome the
   test scripts. §Verification V6 says where those cases live and what the fixture must reach.

### Phase 2: the tree and the total (web only)

Web-only, so it swaps into `/opt/cezar` without a service restart (`AGENTS.md` §"Always
self-deploy", as corrected 2026-08-24 for the manual-deploy parking).

5. `packages/web/src/routes/task-thread/step-timing.ts`, `stepAttempts` and `stepTotalElapsed`,
   with the `ResolvedAttempt` and `{ ms, closedMs, live, openStartedAt? }` shapes §The web side
   spells out; `stepElapsed` itself untouched.
6. `packages/web/src/routes/task-thread/step-rail.tsx`, `data-slot="step-attempt-row"` children,
   the `×N` badge's new `title`, `StepClock`'s `total?` prop, and a `STEP_CLOCK_TOTAL_TITLE`
   beside the existing `STEP_CLOCK_TITLE` (`:249`). **Both `StepClock` call sites pass `total`**:
   the expanded row (`:113`) and the collapsed summary line (`:394`), the second added in
   revision 4, because the collapsed clock is the one most users see and the task asked for the
   total as the step time (§The web side).
7. **The two stale assertions, corrected in this phase and not a later one.** The R3 paragraph in
   `step-timing.ts:34-36` ("cumulative cost would need a persisted field that does not exist") and
   the `STEP_CLOCK_TITLE` hover string at `step-rail.tsx:249` ("Elapsed since this step started
   (the current attempt)") both become **false the moment item 6 lands**, and the hover string is
   false *to a user*, not only to a reader of the source. They were assigned to Phase 3 in revision
   2, which was wrong: a phase that is supposed to be independently shippable cannot ship a UI
   whose own tooltip contradicts it. `STEP_CLOCK_TITLE` keeps its exact current text for the
   single-attempt fallback, which is still the current attempt; the new
   `STEP_CLOCK_TOTAL_TITLE` is what the aggregate branch renders, on **both** call sites.
8. Tests, in this phase and not a later one, because this is the user-facing half and §Verification
   requires a real-browser pass on it:
   - `packages/web/src/routes/task-thread/step-timing.test.ts` and
     `packages/web/src/routes/task-thread/step-rail.test.tsx` (§Verification V2, V3). Both are
     jsdom, and jsdom is not evidence that a browser renders this.
   - **`packages/web/e2e/retry-step-timing.e2e.ts`** (§Verification V5b), a real-browser spec
     against a real cezar serving a recorded multi-attempt run. New file, plus its fixture
     `packages/web/e2e/fixtures/retry-timing-run.record.json` and a paragraph in
     `packages/web/e2e/fixtures/README.md` recording how the fixture was captured and what was
     normalized in it.
   - **Browser-provider recording support, which this repository does not have yet.** The
     `AgentBrowser` wrapper exposes `screenshot` and nothing else
     (`packages/web/e2e/agent-browser.ts:233-241`), and the provider descriptor
     `.ai/browsers/agent-browser.md` documents `ensure-installed`, `doctor`, `open`, `snapshot`,
     `interact`, `assert`, `screenshot` and `close`, with no recording operation, so no e2e spec in
     this repository can retain video today. The installed CLI does support it: `record start
     <path> [url]` and `record stop`, WebM, listed under Debug in `agent-browser --help` (verified
     against the cached binary at
     `~/.cache/agent-tools/agent-browser/agent-browser-linux-x64` while writing this spec). So this
     phase adds a `### record` operation to `.ai/browsers/agent-browser.md` and a matching
     `startRecording(path)` / `stopRecording()` pair on `AgentBrowser`, built on the same private
     `run()` helper as `screenshot` and gating on a non-empty file the same way.
     Two honest caveats, neither of which may be quietly dropped. First, **nobody has run `record`
     headless on this box**, so if it cannot produce a non-empty WebM here the E2E still fails on a
     missing screenshot and the run reports the video as unavailable, rather than skipping the
     assertion. Second, `agent-browser.md` opens by calling itself an implementation of "the
     browser-provider contract in `TEMPLATE.md`", and **`TEMPLATE.md` does not exist in this
     repository**: `.ai/browsers/` contains `agent-browser.md` alone. There is therefore no
     contract file to extend alongside it, and the descriptor is the only place the operation can
     be written down.

### Phase 3: correct the record in place

Documentation and the corpus only. No source file is edited in this phase, which is why it can
land after Phase 2 without leaving anything false in the product.

9. `.ai/specs/2026-08-20-step-and-tool-call-durations.md`, **two** corrections, both edited in
   place, both keeping the original text below a bolded lead-in.

   **9a, the mechanism.** A `**SUPERSEDED 2026-08-29 by .ai/specs/2026-08-29-per-retry-step-timing.md**`
   lead-in on **Risk R3**, naming this spec as where the mechanism now lives. R5's note about
   `stepElapsed` ignoring `finishedAt` on an active step stays true, is not touched, and is now
   cited by §Data models as the precedent for the same skew.

   **9b, the browser claims, which are stale rather than merely superseded.** That spec justifies
   its one unexecuted verification by asserting there is no browser on this host, and the assertion
   is false: `packages/web/e2e/*.e2e.ts` under `npm run test:e2e` drives real Chrome through
   `AgentBrowser` (`packages/web/e2e/agent-browser.ts`), and
   `packages/web/e2e/task-thread.e2e.ts:60-90` already loads `/tasks/:id` against a fixture
   `dataRoot`. This spec's V5b runs on exactly that harness, which is what makes the claim worth
   correcting now rather than leaving for whoever next reads that spec's Status line and concludes
   a browser pass is impossible here. A `**CORRECTED 2026-08-29**` lead-in goes on each of the
   three places the claim is load-bearing, original text preserved beneath:
   1. the **Status** paragraph at the top, both clauses: "this box has no browser", and lower down
      "a headless step cannot open `/tasks/:id`";
   2. the sentence introducing §Verification 8, "§7 needs a browser";
   3. **verification row 7** of the results table, whose reason column reads "no browser on this
      host; todo `1f74df2b`".

   **Amend the reason, never the verdict.** The correction says only that the pass is now
   *possible and unblocked*. Row 7 stays **NOT EXECUTED** and todo
   `1f74df2b-9428-4e84-a983-870b00cbdcf2` stays open until someone actually runs §7's a-e
   checklist. Shipping this spec's V5b does **not** discharge it: V5b asserts retry-attempt rows
   and aggregate clocks against a captured multi-attempt fixture, and covers none of a-e. If a-e is
   genuinely executed in the same session, record it as its own dated result beside the corrected
   row rather than rounding row 7 up off this feature's E2E.
10. `CHANGELOG.md` under `# Unreleased` (Added), and `BACKWARD_COMPATIBILITY.md` §3 noting
    `attempts` as an additive optional field on the run record. **Four** behaviour changes go in
    the changelog beside it, because none is covered by "additive field": a continuation step that
    retried its broker or its session now reports `iterations` equal to its real attempt count
    rather than a fixed `1`; its second `step-start` frame now carries `iteration: 2` rather than a
    second `iteration: 1` (which also makes the CLI print `(attempt 2)`, `index.ts:1144`); that
    same step now passes briefly through `pending` between attempts, as the chain path already
    does; and a live broker re-attach no longer emits a duplicate `step-start` frame (§API
    contracts).
11. Corpus + KB, **as a reviewed proposal, not a direct write.** A changelog entry and, if the
    persisted-vs-derived reasoning proves reusable, a knowledge note, both appended as NDJSON
    `upsert` operations to the file named by the `CEZ_KB_WRITE_FILE` environment variable (for this
    run, `.ai/cezar/runs/<taskId>.knowledge.ndjson`, which does not exist until the first line is
    appended). Each line carries its own `seq`, an integer counting up from 0 across every line
    appended to that file during the run, plus `runId` (the task id) and an ISO-8601 `createdAt`;
    read the file first if an earlier turn already appended to it, so the sequence continues rather
    than restarting. **Never edit the mounted corpus under
    `/var/lib/cezar/loki-labs/notion-export/` directly.**
    A proposal is reviewed and applied later, through the cockpit or `cez kb proposals`, never
    automatically, so the implementing run must report **corpus sync pending** until the proposal
    has been applied and `cez kb search` actually returns it. **Reindexing cannot substitute for
    that**, and this is the trap worth naming: `CEZ_KB=1 cez kb reindex` only indexes documents
    already on disk, and an unapplied proposal has written none, so no reindex can turn it into a
    corpus write. (Corrected in revision 5. This item previously instructed a direct corpus write
    followed by a reindex, which is the pre-proposal procedure.)

### Deliberately not in scope

- **Any change to how many times a step retries.** `onFail.max` and the three single-retry `Set`s
  are untouched; `2026-08-22-bounded-transient-broker-retry.md`'s "one retry, both precedents chose
  one" stands.
- **Per-attempt token or cost attribution.** `tokensUsed` is a running total on the step and
  splitting it per attempt is a separate, larger change with its own accounting questions.
- **A per-attempt `outcome` label.** Removed in revision 3 for the reason §Architecture measures:
  it is not derivable from the status transition, and a guessed one would read differently across a
  cezar restart for the same user action. Adding it honestly means every abandonment site declaring
  its own reason on the patch it already writes, which is a change to nineteen call sites rather
  than to one store helper, and it is a separate spec.
- **Backfill of historical records.** §Risks R5.
- **A per-attempt surface in the transcript.** `thread-state.ts:693-706` gives the steps surface to
  the rail; this spec does not take it back.

## Risks

**R1, a missed close leaves an attempt open forever, and it silently under-reports.** An attempt
with no `endedAt` that is not the last one contributes nothing to the sum, so the total reads low
with no visible error. Mitigated structurally (the store sees every transition, not five hand-edited
sites) and caught by V1e, which drives a full five-attempt lifecycle through `updateStep` and
asserts every non-final attempt closed.

**R2, `loopBackTo` absorbing intervening work into an attempt.** The failure this design exists to
avoid; see §Architecture. Pinned by V1c, which interleaves another step's attempt between two
attempts of the step under test and asserts the gap is excluded from both.

**R3, clock skew and negative intervals.** `endedAt − startedAt` can go negative if the process
clock steps backward mid-run. Both existing formatters already clamp (`formatDuration`
(`packages/web/src/lib/format.ts:46-54`) clamps at zero, and `stepElapsed` wraps in `Math.max(0, …)`
for exactly this reason). The sum clamps per attempt, not only on the total, so one bad interval
cannot cancel out a good one.

**R4, a ticking total re-rendering the rail.** Every row of a six-step rail could own a `useNow`
and repaint the whole header every second (the prior spec's risk R2, and the guardian rule
`no-tick-in-thread-containers`). Mitigated by keeping the tick inside `<LiveDuration/>` and passing
the frozen closed-attempt sum through its existing `format` prop, no `useNow` enters `StepRail`
or `StepClock`.

**R5, the asymmetry between old and new records is visible and permanent.** A step that was
retried three times last week will keep showing a bare `×3` and one attempt's clock forever, beside
a step retried three times tomorrow that shows a tree and a total. This is deliberate. The
alternative, synthesizing a one-entry `attempts` array from `startedAt`/`finishedAt` when
`iterations > 1`, would print the *last* attempt's duration under the label "total", which is a
confidently wrong number rather than a missing one. The `attempts.length === iterations` predicate
makes the fallback exact.

**The mid-deploy case is handled at the WRITER, not only at the reader. Corrected in revision 4.**
Revision 3 said the reader's predicate "covers the mid-deploy case with the same rule", and it does
cover the *reading* of one. It does not stop the store from creating one: a step already on attempt
2 when the backend swapped would have had `{ n: 1 }` appended on its next retry and its
`iterations` rewritten from `attempts.length` to `1`, destroying a true count in the name of
maintaining an invariant. The eligibility gate in §Architecture is the fix, and it makes the
asymmetry cleaner than revision 3 described it: a step's `attempts` array is **present and complete
or absent entirely**, never partial, so the reader's `length === iterations` clause is a check
against a bug rather than the routine handler for a common state. A run that spans the deploy keeps
today's rail for its in-flight steps and gets the tree for every step that starts afterwards, which
is the same rule as the historical records above and needs no separate explanation to a user.

**R6, `attempts` and `iterations` drifting apart.** The whole read path keys on their equality, so
a drift silently disables the feature rather than showing something wrong, the safe direction, but
still worth pinning. **Revision 2 mitigated this the wrong way**, with a "replace the array when
`patch.iterations === 1`" rule that would have deleted real attempts on the continuation retry
path (§Architecture). The mitigation is now the opposite direction: the store treats the array as
authoritative and **rewrites `patch.iterations` from it**, so the only writer that can move the
counter is the one that appends to the array. V1d and V7a cover the case that motivated the wrong
rule.

**Revision 4 adds the bound that makes "authoritative" safe: the store only claims the counter for
a step it has owned since attempt 1.** Rewriting `iterations` from `attempts.length` is correct
exactly when the array is the complete history, and catastrophic when it is not: on a step already
carrying `iterations: 2` with no array, the same rule reports `1`. So the eligibility gate
(§Architecture) decides ownership once, at the first opening patch, and never revisits it: either
the store owns both fields or it owns neither. That also removes the drift this risk is about from
the legacy population entirely, rather than merely making it fail closed there. V1i is the
regression.

**R7, record size on a runaway retry loop.** Quantified in §Data models: ~9 KB at 100 attempts, on
a file rewritten whole per touch. Accepted, and stated rather than capped so the total never
becomes a silent floor.

## Verification

Executable steps, in the order a shipping run should take them. Nothing here has been executed:
this is the spec step.

**V0, the prerequisite that gates every item below: ASK BEFORE RUNNING ANYTHING.** The owner's
standing instruction for this workspace is *"don't build or run anything without asking"*, and it
covers every command in this section without exception: the five gates in V4 (`npm run typecheck`,
`npm test`, `npm run test:unit`, `npm run build`, `npm run test:package`), the V5 runtime fixture
and the `cez` invocations that drive it, and `npm run test:e2e` for V5b. The implementing run must
have the user's **explicit approval** before the first of them, and this spec's phases are not that
approval.

There is a genuine tension here, and this spec names it rather than picking a side quietly, per the
workspace `CLAUDE.md`'s own rule about contradictions between doctrine files: that file's
§"Working Agreement" pre-authorizes "running the gates …, the deploy command, and the push" as part
of the commit-and-deploy flow for `cezar/`, while the global instruction says to ask. The
resolution that satisfies both, and the one this spec requires: **ask once, up front, naming the
whole list**, and treat a yes as covering the entire verification pass, so no per-command
round-trips follow. Do not start a gate on the strength of the deploy grant alone, and do not treat
the browser E2E as covered by an approval that named only the gates: V5b spawns a packaged CLI and
drives real Chrome, which is a larger action than `npm test` and worth naming separately when
asking.

If approval is withheld or given only in part, ship as **QA Needed** with each unrun item named
individually (V4's closing note, V5, V5b), never as Done, and never with a gate reported as green
that was not run.

**V1, store bookkeeping (`packages/cezar/src/runs/store.test.ts`), `npm test`.** Drive
`updateStep` directly; no workflow boot required. Note which shape each case is driving, because
four distinct engine paths collapse onto this one method: a `running → pending` patch is the
**direct abandonment** shape (missing-session, cold-broker, stop, failed post-condition,
`reenterChain`, `requeueHandoff`); a `running → done`/`failed` patch followed by a `pending` patch
is the **`loopBackTo`** shape, and the second patch must be a no-op; `running → pending → running`
with a fresh `startedAt` on the third is the **`runContinuation` same-step retry** shape as Phase 1
makes it arrive (V1d); and a bare `running → running` carrying a fresh `startedAt` is the
**defensive** shape no live path produces after Phase 1, which must still close and reopen at the
incoming `startedAt` (V1d′). A fifth shape, a step the store must decline to adopt at all, is
V1i.

- **V1a** `{status:'running', iterations:1, startedAt}` on a fresh step → `attempts` is
  `[{n:1, startedAt}]`, no `endedAt`, and **no `outcome` key on any entry, in this or any other
  case in V1**: the field does not exist on the schema, so a test that asserts one would not
  typecheck, and that is the intended guard.
- **V1b** …then `{status:'done', finishedAt}` → attempt 1 closed with `endedAt === finishedAt`.
  `startedAt`/`finishedAt` on the step itself are unchanged from today.
- **V1c (R2), an interleaved step must not be absorbed into A's total.** Six patches at named
  instants from an injected clock, because the boundary this case turns on is **A's own close**,
  not B's open: `tA1` open A attempt 1 → `tA1end` close A to `pending` → `tB` open B attempt 1 →
  `tBend` close B `done` → `tA2` open A attempt 2 → `tA2end` close A `done`, with
  `tA1 < tA1end < tB < tBend < tA2 < tA2end`. Assert: `A.attempts.length === 2`;
  **`A.attempts[0].endedAt === tA1end`**, the instant of A's own `pending` transition, which is
  where the store closes the attempt and is *earlier* than B's start rather than equal to it (an
  earlier revision called it "B's start-side boundary", which holds only when nothing separates the
  two and is not what the store computes); `A.attempts[0].endedAt <= B.attempts[0].startedAt`;
  `A.attempts[1].startedAt >= B.attempts[0].endedAt`; and `stepTotalElapsed(A)` equals
  `(tA1end - tA1) + (tA2end - tA2)` exactly, so B's whole `[tB, tBend]` interval is excluded.
- **V1d (R6), the continuation retry as it will actually arrive after Phase 1.** Three patches, not
  two: open attempt 1 at `t1`; `{status:'pending', error: undefined}` at `t2` (the line Phase 1
  adds to each retry branch of `runContinuation`'s `catch`); then
  `{status:'running', iterations:1, startedAt: t3}` at `t3`. Assert: `attempts.length === 2`;
  attempt 1 is closed with **`endedAt === t2`, the abandonment instant, NOT `t3`**, and this is the
  assertion that fails if someone "simplifies" the close back to the next open, and with a real
  `autosaveCommit` between `t2` and `t3` the difference is seconds, not noise; attempt 2 is open
  with `startedAt === t3`; and **`step.iterations === 2`, not the `1` the patch asked for**. A
  regression to the withdrawn replace rule fails this on the first assertion, with
  `attempts.length === 1`.
- **V1d′, the defensive open-over-open branch, which no live path produces after Phase 1.** Apply
  the same two `running` patches with **no** intervening `pending`. Assert `attempts.length === 2`
  and, specifically, **`attempts[0].endedAt === t3`**, the incoming `patch.startedAt`, not a
  `nowIso` read later inside `updateStep`. The two attempts must abut exactly: assert
  `attempts[0].endedAt === attempts[1].startedAt`, so no overlap can be double-counted by
  `stepTotalElapsed`. Drive it with an injected/frozen clock whose `nowIso` is strictly later than
  `t3`, or the assertion passes for the wrong reason.
- **V1e (R1)** A five-attempt sequence (`pending`-close × 4, then `failed`) → `attempts.length === 5`
  and every `n` is `1..5` in order. **All five attempts have an `endedAt`, and none is left open**:
  attempts 1 through 4 are closed by the four `pending` transitions, and attempt 5 is closed by the
  terminal `failed` transition. (Rewritten in revision 5. It read "exactly the first four have an
  `endedAt` **and so does the fifth**", which asserts and denies the same thing in one clause and
  cannot be turned into a test as written.)
- **V1f** A `pending` patch to a step with no attempts, and to a step whose last attempt is already
  closed → both no-ops, no phantom entry (the `loopBackTo` collateral case).
- **V1g** An `updateStep` patch with no `status` (a token-usage patch) → `attempts` untouched, and
  `iterations` untouched, so the correction in V1d fires only on an actual attempt open.
- **V1h** A `{status:'running', …}` patch with **no** `startedAt` (a patch that merely re-asserts
  the status) → no attempt opened, nothing closed. The open branch is keyed on the pair, not on
  the status alone.
- **V1i (R5/R6), the legacy step retried after deployment, the mid-deploy corruption regression.**
  Seed a step directly into the record in the shape an older cezar leaves behind: `status:
  'running'`, **`iterations: 2`**, a `startedAt`, and **no `attempts` key at all**. Then drive a
  full retry through the new store: `{status:'pending', error: undefined}`, then
  `{status:'running', iterations: 3, startedAt: t}`. Assert, in this order because the second is
  the one that matters:
  1. `step.attempts` is **still `undefined`**: the store declined to adopt a step it did not open.
  2. **`step.iterations === 3`**, the value the engine computed, *not* `1`. Revision 3's rule
     produced `1` here (append `{n:1}`, then rewrite the counter from `attempts.length`), silently
     turning a step that had run three times into one that claims to have run once and erasing its
     `×3` badge. This assertion is the whole point of the case.
  3. `stepAttempts` / `stepTotalElapsed` return `undefined` for the resulting record, so the rail
     falls back to today's flat row (the V2a "no `attempts` key" row, reached from a realistic
     record rather than a hand-built one).

  Then the control, in the same test, so the gate cannot be satisfied by a helper that never tracks
  anything: a step seeded with `iterations: 0` and no `attempts`, driven through the same two
  patches, **is** tracked and ends with `attempts.length === 1`.

**V2, timing maths (`packages/web/src/routes/task-thread/step-timing.test.ts`), `npm run test`.**
Pure and `now`-injected, like the existing tests in that file.

**`stepAttempts` fails closed, so every rejection case gets its own assertion.** Each of V2a's rows
must return `undefined` from **both** `stepAttempts` and `stepTotalElapsed`, since the second is
defined on the first and a divergence is the bug that would put a tree above a last-attempt clock.

- **V2a** `undefined` for every one of: no `attempts` key; `attempts: []`;
  `attempts.length !== iterations` (a drift the store should never produce after revision 4's
  eligibility gate; asserted in both directions, too few and too many, because this clause is now
  the guard against a *bug* rather than the routine mid-deploy handler; the mid-deploy record
  itself is the "no `attempts` key" row, reached realistically in V1i); `n` values `[1, 3]` (a
  gap); `n` values `[2, 1]` (out of order); a `startedAt` of
  `'not-a-date'`; an `endedAt` of `'not-a-date'`; an **interior** attempt with no `endedAt` while a
  later one is closed; and an **open final** attempt on a step whose status is terminal (`done`).
  That last row is the one revision 2 would have rendered: assert explicitly that it returns
  `undefined` rather than an interval measured against `now`, because that interval would grow for
  as long as the page stayed open and then freeze wherever the last render left it.
- **V2b** `stepTotalElapsed` over three closed attempts of 4:12 / 0:38 / 12:05 → the exact sum in
  `ms`, `live: false`, **`closedMs === ms`**, and **`openStartedAt` absent** (a finished step has
  nothing to tick, and a stray anchor here would make the headline start counting again).
- **V2c** Two closed attempts plus one open, status `running`, injected `now` → `ms` is closed sum
  + open elapsed, `live: true`, and the two fields the live renderer actually consumes are asserted
  by value, not merely by presence: **`closedMs` equals the sum of the two CLOSED attempts only**
  (it must not move with `now`: assert it is identical for two different injected `now` values),
  and **`openStartedAt === attempts[2].startedAt`**, the third attempt's own start. Together they
  are the contract `<LiveDuration since={openStartedAt} format={(ms) => formatDuration(closedMs +
  ms)}/>` depends on; revision 3's `{ ms, live }` exposed neither.
  In the same case, from `stepAttempts`: each `ResolvedAttempt` carries a **`startedAt` string
  equal to the record's**, the first two have `live: false`, the third `live: true`, and
  `attempts[2].startedAt` is what the row would hand to `<LiveDuration/>`. A shape without it
  cannot render the live attempt row this spec promises.
- **V2d** The same three-attempt fixture as V2c but with the step's status flipped to `done` →
  `undefined` from both functions (the fail-closed rule above), **not** `live: false` with a
  `now`-derived number. This is the executable form of the V2a row and of the prior spec's R5
  reasoning, kept separate because it is the case a well-meaning refactor is most likely to
  "simplify" back into existence.
- **V2e** A negative interval (`endedAt` before `startedAt`) clamps to 0 and does not reduce the
  total below the other attempts' sum. Clamping is per attempt, so one bad interval cannot cancel a
  good one.
- **V2f** `stepElapsed` is byte-for-byte unchanged in behaviour for a single-attempt step, the same
  assertions the file already makes still pass untouched.
- **V2g** A well-formed two-attempt fixture returns a list of length 2 from `stepAttempts` and a
  sum from `stepTotalElapsed`, so V2a's wall of `undefined`s is not vacuously satisfied by a
  function that always returns `undefined`.

**V3, rendering (`packages/web/src/routes/task-thread/step-rail.test.tsx`), `npm run test`.** Uses
the file's existing `step(id, status, extra)` helper (`step-rail.test.tsx:11-19`).

- **V3a** A step with three covering attempts → exactly three `[data-slot="step-attempt-row"]`
  nodes, in order, each reading `attempt N · <duration>` with its own duration text and **no
  outcome word**.
- **V3b** A single-attempt step → **no** `step-attempt-row` nodes and no `×N` badge, i.e. the
  current rail markup unchanged.
- **V3c** A step with `iterations: 3` and no `attempts` (the historical record) → no attempt rows,
  the `×3` badge still present, `[data-slot="step-duration"]` still showing the single-attempt
  number. This is R5 made executable.
- **V3d, the two headline clocks agree. Rewritten in revision 4, and it now asserts the opposite of
  what it asserted before.** Render `WorkflowSteps` for a run whose current step has three covering
  attempts, once collapsed and once expanded, and assert **the same total string** in both: the
  collapsed summary clock (`step-rail.tsx:393`) and the expanded row's `StepClock` (`:113`) read
  identically, and both read the sum rather than the last attempt. Revision 3 asserted that the two
  deliberately disagree, which contradicted the task ("total time as step time") on the surface
  users see by default, since the rail opens collapsed (`step-rail.tsx:365`).
  Two controls in the same test, because "they always match" is trivially satisfiable by a clock
  that never aggregates: a **single-attempt** current step shows the same string in both places
  *and* that string is `stepElapsed`'s number; and a **legacy** current step (`iterations: 3`, no
  `attempts`) likewise shows today's number in both places.
- **V3f, an ACTIVE multi-attempt step: closed rows hold still, the open row and both totals
  advance, and nothing can tick backwards.** Every other V3 row renders a finished step, so none of
  them exercises the live headline at all, and the `closedMs + Math.max(0, ms)` arithmetic in
  §The web side is currently asserted nowhere. Drive it under controlled time, the pattern
  `use-now.test.tsx:12-33` already establishes in this repo: `vi.useFakeTimers()`,
  `vi.setSystemTime(T0)`, `act(() => vi.advanceTimersByTime(…))`. `LiveDuration` reads the clock
  only through `useNow(1000)` (`live-duration.tsx:40`), so a fake clock makes every string below
  deterministic rather than timing-dependent.

  **Fixture**, built with the file's existing `step(id, status, extra)` helper: `status: 'running'`,
  `iterations: 3`, three attempts, attempts 1 and 2 **closed** with exact 2000 ms intervals, attempt
  3 **open** with `startedAt: T0` and no `endedAt`. So `closedMs` is 4000 and the aggregate at `T0`
  is `0:04`.

  1. **At `T0`.** Three `[data-slot="step-attempt-row"]` nodes; rows 1 and 2 read `0:02` each; row 3
     reads `0:00`; the expanded row's `StepClock` reads `0:04`; and the same run rendered collapsed
     (`WorkflowSteps`, the `> button` summary clock) also reads `0:04`. This is V3d's
     collapsed-equals-expanded invariant held at a *live* instant, which V3d itself cannot check.
  2. **`act(() => vi.advanceTimersByTime(3000))`.** Rows 1 and 2 are **still exactly `0:02`**,
     asserted as unchanged strings, which is what proves a closed attempt frozen rather than merely
     small; row 3 now reads `0:03`; the expanded clock reads `0:07`; the collapsed clock reads
     `0:07`. Both totals moved by the same 3 s the open row moved, which is the arithmetic
     `closedMs + openMs` claims and the reason the tree and the headline can be read together.
  3. **The future-dated open attempt, which is the clamp's only executable proof.** `cleanup()`,
     `vi.setSystemTime(T0)` again, and render the same fixture with the open attempt's `startedAt`
     set to **`T0 + 5000`**, five seconds ahead of the clock, the shape a browser trailing the
     server produces. Assert both totals read **`0:04`**, exactly `closedMs`, and assert explicitly
     that the total is **not less than** the sum the rows above it show. Without the
     `Math.max(0, ms)` this renders `formatDuration(4000 + -5000)`, and `formatDuration`'s own
     clamp (`format.ts:46-54`) turns that into **`0:00`**: a step with two banked attempts
     reporting no time at all, *while the two rows directly above it still read `0:02` and `0:02`*.
     Assert those two rows are unchanged in this render too, so the case pins the visible
     contradiction and not just a number.
  4. **`act(() => vi.advanceTimersByTime(6000))`** on that skewed fixture. The open interval is now
     a real `+1000`, so both totals read `0:05`, and each must be **greater than or equal to** its
     value at every earlier assertion in this case. Asserting monotonicity as an ordering, not only
     as a literal, is what keeps the case honest if the fixture constants are ever retuned.

  Add `vi.useRealTimers()` to this file's `afterEach` beside the existing `cleanup()`
  (`step-rail.test.tsx:8`), or the fake clock leaks into every later case in the file.
- **V3e (R4), moved out of this file, because a component test cannot make this assertion.**
  Revision 2 proposed rendering a live multi-attempt rail under fake timers and asserting "the
  parent row did not re-render". React does not expose that: a component test can observe output,
  not whether a re-render occurred, and any proxy for it (a render counter wired into the
  component, a mutation-observer heuristic) tests the instrument rather than the code. The
  executable guard is the one this repo already runs, `packages/web/src/design-guardian.test.ts`,
  whose `no-tick-in-thread-containers` rule (`:108-116`) matches `/\buseNow\b/` against a fixed
  file list that **already includes `src/routes/task-thread/step-rail.tsx`** (`:114`). Two
  assertions, both cheap and both real:
  1. The rule still lists `step-rail.tsx` after this change. `StepClock` and the attempt rows live
     in that file, so nothing new needs adding to the list, and this asserts nobody removed it to
     make a `useNow` fit.
  2. The guardian passes, i.e. `step-rail.tsx` contains no `useNow`. The tick stays inside
     `<LiveDuration/>`, which is the leaf the rule exists to protect.

  If the attempt rows are ever factored into their own file, that file must be added to the rule's
  `applies` list in the same change; the guardian is a fixed list and says nothing about a file it
  has never heard of.

**V4, gates.** *(Corrected after review: an earlier draft listed `npm run lint`, which **does not
exist** in this repo: `package.json` has no `lint` script, and the command exits non-zero as an
unknown script. These are the five gates this repo actually has.)* From the repo root, in this
order:

| Command | What it is |
| --- | --- |
| `npm run typecheck` | contract → client → server → web (`package.json:38`); `pretypecheck` builds the server first |
| `npm test` | the `vitest run` suite (`package.json:31`); V1, V2, V3, V6 and V7 all land here, as does the `design-guardian.test.ts` rule V3e now leans on |
| `npm run test:unit` | `-w @loki-labs/better-cezar` (`package.json:33`) |
| `npm run build` | server + web + `check:pack` + build stamp (`package.json:16`) |
| `npm run test:package` | `-w @loki-labs/better-cezar` (`package.json:34`); the packaged-artifact pass |

**All five must pass before the commit.** None of them, and not all five together, is sufficient
for Done: the runtime E2E in V5 **and the browser E2E in V5b** are both separately required, and
until each has actually run this ships as **QA Needed** (`AGENTS.md`, workspace `CLAUDE.md` →
"Definition of Done").

**V5, real runtime E2E, the record half of the Done gate.** Gates green does not prove a
retried step renders. Force a real multi-attempt run and read the record and the screen:

*(Corrected twice. The first draft said "run any workflow with `CEZ_RUN_FAULT` … so a step exercises
`loopBackTo` at least twice": `CEZ_RUN_FAULT` has exactly one value, `stall-step[:<stepId>]`
(`run.ts:5767-5772`, `.env.example:405`), which parks a step forever and cannot loop back.
Revision 2 replaced it with a counter-driven fixture, but that fixture was **not timed**: a
`CEZ_DRY_RUN` agent step and a two-line shell check both finish in well under a second, so all
three attempt rows would have rendered `0:00` and step 5's "three different durations" could not
have been observed, let alone the aggregate. The fixture below gives every attempt a **known,
distinct, asserted duration**, and every assertion is `jq -e` so the shell's exit status carries
the verdict.)*

1. **Build the fixture.** Two check steps, so the timing is `sleep`, not a language model. `gate`
   counts its invocations in a file and sleeps for as many seconds as the invocation number, so its
   three attempts take ~1s, ~2s and ~3s and are told apart on sight; `work`, the retry target,
   sleeps a flat 2s so the gaps between `gate`'s attempts have a known size too:

   ```bash
   set -o pipefail            # or the `| tail -40` below swallows a failed run's exit status
   REPO=$(mktemp -d) && CEZ_HOME=$(mktemp -d) && cd "$REPO"
   # `git init` ALONE IS NOT ENOUGH, and this is the correction revision 4 made to this step.
   # `cezar run` isolates in a worktree by DEFAULT (run.ts:5554 emits a note that it is using an isolated task worktree, by default),
   # and on a commitless repository `git worktree add` SUCCEEDS while producing an EMPTY TREE
   # (measured on git 2.50.1; `server/checkout.ts:183`, `workspace/boot-repo.ts:34` and `:190` all
   # say so in as many words). `createWorktree` is handed `repo.branch` as its base, and an unborn
   # `main` does not resolve, so in practice the run fails with `worktree creation failed: …`
   # (run.ts:5599) and the task stops before workflow execution, never executing a single step.
   # Either way the fixture
   # measures nothing. So: a named branch, a local identity (a box with no global user.email cannot
   # commit), and one empty commit to fork from.
   git init -q -b main .
   git config user.email cezar-fixture@localhost
   git config user.name  'cezar fixture'
   git commit -q --allow-empty --no-verify -m 'fixture base'
   mkdir -p .ai/cezar/workflows
   cat > .ai/cezar/workflows/retry-timing-fixture.yaml <<'YAML'
   name: retry-timing-fixture
   steps:
     - id: work
       name: Work
       command: sleep 2; echo "work ran"
     - id: gate
       name: Gate
       command: |
         n=$(cat .cez-gate-count 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > .cez-gate-count
         echo "gate invocation $n"; sleep "$n"; test "$n" -ge 3
       onFail: { retry: work, max: 2 }
   YAML
   rm -f .cez-gate-count
   CEZ_DRY_RUN=1 CEZ_HOME="$CEZ_HOME" node <checkout>/packages/cezar/dist/index.js \
     run "per-retry timing fixture" --workflow retry-timing-fixture --repo "$REPO" 2>&1 | tail -40
   rc=${PIPESTATUS[0]}
   [ "$rc" -eq 0 ] || { echo "A0 FAILED: expected exit 0 (run done), got $rc"; exit 1; }
   RUNS="$REPO/.ai/cezar/runs.json"
   ```

   **Read the exit status, do not eyeball the tail.** `cezar run` sets
   `process.exitCode = final === 'done' || final === 'review' ? 0 : 1` (`index.ts:1213`), so a
   fixture that never executed a step (the worktree failure above, an unknown workflow, a provider
   preflight refusal) exits **1**, and a bare `node … | tail -40` reports `tail`'s status, which is
   0 no matter what happened upstream. Without `pipefail` or `PIPESTATUS[0]` a broken fixture reads
   as a passing one right up to the `jq` gates, which then fail for a reason that has nothing to do
   with the code under test. This run must exit **0** (`gate` succeeds on its third attempt); the
   run in step 5 below must exit **1**.

   `--repo` is a real global flag (`index.ts:325`), and `repoRoot` resolves from it
   (`index.ts:378`), so the fixture repository does not have to be the shell's cwd, though the
   `cd "$REPO"` above keeps the two aligned and the `git config` calls need it.

   The invocation shape is `cezar run "<task>" [--workflow name]` with `--repo` defaulting to the
   cwd (`packages/cezar/src/index.ts:390` and the usage string it prints); the task text is
   positional and the workflow is a flag, not the other way round. `loadWorkflows` picks the
   fixture up from `<repo>/.ai/cezar/workflows/*.yaml` (`workflows/load.ts:17`, `:30-60`), where a
   file workflow wins a name collision with a built-in. A step carrying `command` is a **check**
   step (`stepKind`, `workflows/types.ts:240-242`), so neither step spawns an agent and the run
   costs nothing; `CEZ_DRY_RUN=1` and the pinned `CEZ_HOME` are kept anyway, following the reason
   the `fixture-serve-must-pin-cez-home` guardian rule exists (`design-guardian.test.ts:99-106`,
   which itself only applies to e2e sources), so the fixture cannot append a dead `/tmp` project to
   a real registry.

   `test "$n" -ge 3` is false on invocations 1 and 2 and true on 3, so `gate` runs three times and
   `work` runs three times, with `onFail.max: 2` allowing exactly the two loop-backs
   (`canLoopBack`, `run.ts:5664-5665`).

   **Expected wall-clock, which is what the assertions pin:** `gate` attempts of 1s / 2s / 3s
   summing to ~6s; `work` attempts of 2s / 2s / 2s summing to ~6s; and a `gate` span from its first
   `startedAt` to its last `endedAt` of ~10s, because two `work` re-runs of 2s sit inside it. The
   whole run takes ~13s.

2. **Assert the record's shape** (attempt counts, contiguity, full timestamp coverage). All three
   assertions below use `jq -e`, which exits non-zero on `false` or `null`, so each is a gate and
   not a print:

   ```bash
   jq -e '
     ([ .[] | select(.workflow=="retry-timing-fixture") ] | last) as $r
     | ["gate","work"] | all(
         . as $id
         | ($r.steps[] | select(.id==$id)) as $s
         | ($s.attempts // []) as $a
         | ($a|length) == 3
           and $s.iterations == 3
           and ([$a[].n] == [1,2,3])
           and ($a | all(.startedAt != null and .endedAt != null))
       )' "$RUNS" >/dev/null || { echo "A1 FAILED: attempt shape"; exit 1; }
   ```

   `work` is asserted alongside `gate` deliberately: the `pending` patches `loopBackTo` sprays over
   the slice (`run.ts:5685`) land on an already-closed attempt, so if the idempotence guard is
   broken `work` grows phantom entries and `[$a[].n] == [1,2,3]` fails.

3. **Assert each attempt's duration, which is also its displayed value.** `formatDuration` floors
   to whole seconds (`packages/web/src/lib/format.ts:46-54`), so pinning each interval to its
   one-second bucket pins exactly what the rail will render:

   ```bash
   jq -e '
     def epochms:
       capture("^(?<t>[^.]+)(\\.(?<f>[0-9]+))?Z$")
       | ((.t + "Z") | fromdateiso8601) * 1000 + (((.f // "0") + "000")[0:3] | tonumber);
     def secs: [ .attempts[] | ((.endedAt|epochms) - (.startedAt|epochms)) / 1000 ];
     ([ .[] | select(.workflow=="retry-timing-fixture") ] | last) as $r
     | (($r.steps[] | select(.id=="gate")) | secs) as $g
     | (($r.steps[] | select(.id=="work")) | secs) as $w
     | ($g[0] >= 1 and $g[0] < 2)
       and ($g[1] >= 2 and $g[1] < 3)
       and ($g[2] >= 3 and $g[2] < 4)
       and ($w | all(. >= 2 and . < 3))' "$RUNS" >/dev/null \
     || { echo "A2 FAILED: per-attempt durations"; exit 1; }
   ```

   The `epochms` helper is not decoration: `new Date().toISOString()` emits milliseconds, and jq's
   `fromdateiso8601` **rejects** a fractional-seconds stamp outright, so the naive one-liner
   revision 2 printed would have errored rather than measured. Each bucket is `[n, n+1)`, so
   per-attempt shell and step overhead of up to a second is tolerated while the *displayed* value
   stays exactly `0:0n`. If this box is slow enough to blow a bucket, raise every `sleep` and every
   bound together; do not widen a bucket, because the point of the fixture is that the three rows
   differ visibly.

   **Expected visible values:** `gate` renders `attempt 1 · 0:01`, `attempt 2 · 0:02`,
   `attempt 3 · 0:03`; `work` renders `0:02` three times.

4. **Assert the aggregate, and that it excludes the retry-target gaps** (the production-side check
   for R2). The identity `span = sum + gaps` must hold to the millisecond, `sum` must land in the
   bucket that renders `0:06`, and `gaps` must account for the two 2s `work` re-runs:

   ```bash
   jq -e '
     def epochms:
       capture("^(?<t>[^.]+)(\\.(?<f>[0-9]+))?Z$")
       | ((.t + "Z") | fromdateiso8601) * 1000 + (((.f // "0") + "000")[0:3] | tonumber);
     ([ .[] | select(.workflow=="retry-timing-fixture") ] | last) as $r
     | (($r.steps[] | select(.id=="gate")).attempts) as $a
     | ([ $a[] | (.endedAt|epochms) - (.startedAt|epochms) ] | add) as $sum
     | (($a[-1].endedAt|epochms) - ($a[0].startedAt|epochms)) as $span
     | ([ range(0; ($a|length)-1)
          | ($a[.+1].startedAt|epochms) - ($a[.].endedAt|epochms) ] | add) as $gaps
     | ($sum >= 6000 and $sum < 7000)
       and ($gaps >= 4000 and $gaps < 6000)
       and (($span - $gaps - $sum) | fabs) < 50' "$RUNS" >/dev/null \
     || { echo "A3 FAILED: aggregate excludes the retry-target gaps"; exit 1; }
   ```

   **Expected visible aggregate:** `gate`'s headline clock reads `0:06`, against a `gate` span of
   ~10s. **Tolerance:** the sum is accepted anywhere in `[6.0s, 7.0s)`, which is the range that
   still renders `0:06`; the gaps are accepted in `[4.0s, 6.0s)`, loose because they include the
   engine's own between-step work as well as the two `sleep 2`s; and the `span = sum + gaps`
   identity is held to 50ms because it is arithmetic, not timing. A `loopBackTo` regression that
   let attempt 1 absorb the intervening `work` runs pushes `$sum` toward `$span` and fails the
   first clause.

5. **The direct-abandonment path, as a SECOND fixture with its own invocation**, because step 1
   exercises only `loopBackTo`. *(Rewritten in revision 4. It said "replace `work`'s `onFail`", but
   `work` has no `onFail`; the `onFail` in the step-1 fixture is on `gate`. Editing a field that
   does not exist is not an executable instruction, so here is the whole thing.)*

   `retryAfterFailedPostcondition` (`run.ts:8230`) patches the **ACTIVE** step straight to
   `pending` with no `finishStep` at all, which is the shape the store's close branch has to catch
   unaided. A check step reaches it: `run.ts:6076` calls it from the check branch on a failed
   post-condition, exactly as `:5962` does from the agent branch, so this stays agent-free and free.

   ```bash
   set -o pipefail
   REPO2=$(mktemp -d) && CEZ_HOME2=$(mktemp -d) && cd "$REPO2"
   git init -q -b main . && git config user.email cezar-fixture@localhost \
     && git config user.name 'cezar fixture' \
     && git commit -q --allow-empty --no-verify -m 'fixture base'
   mkdir -p .ai/cezar/workflows
   cat > .ai/cezar/workflows/postcondition-timing-fixture.yaml <<'YAML'
   name: postcondition-timing-fixture
   steps:
     - id: work
       name: Work
       command: sleep 2; echo "work ran"
       verify: { command: "test -f .cez-never", max: 1 }
   YAML
   # No CEZ_DRY_RUN: this workflow spawns no agent (a step carrying `command` is a CHECK step,
   # workflows/types.ts:240-242), so the backend mocks buy nothing here, and this is the run whose
   # EXIT STATUS is an assertion, and `env -u` makes that independent of whatever the shell inherited
   # from step 1.
   env -u CEZ_DRY_RUN CEZ_HOME="$CEZ_HOME2" node <checkout>/packages/cezar/dist/index.js \
     run "post-condition timing fixture" --workflow postcondition-timing-fixture --repo "$REPO2" \
     2>&1 | tail -40
   rc=${PIPESTATUS[0]}
   [ "$rc" -eq 1 ] || { echo "A4 FAILED: expected exit 1 (run failed), got $rc"; exit 1; }
   RUNS2="$REPO2/.ai/cezar/runs.json"
   ```

   **Exit 1 is the expected outcome, and asserting it is not pedantry.** `.cez-never` never exists,
   so the post-condition fails both times; `max: 1` allows exactly one re-run
   (`retryAfterFailedPostcondition` returns `undefined` once `used >= max`), after which
   `finishStep(…, 'failed', <the post-condition message>)` (`run.ts:6079`) runs and the run ends `failed` → exit 1
   (`index.ts:1213`). An exit of **0** here means the post-condition passed, i.e. the fixture never
   exercised the path it exists for, and the `jq` gate below would then be asserting over a
   one-attempt step for the wrong reason.

   ```bash
   jq -e '
     def epochms:
       capture("^(?<t>[^.]+)(\\.(?<f>[0-9]+))?Z$")
       | ((.t + "Z") | fromdateiso8601) * 1000 + (((.f // "0") + "000")[0:3] | tonumber);
     ([ .[] | select(.workflow=="postcondition-timing-fixture") ] | last) as $r
     | (($r.steps[] | select(.id=="work"))) as $s
     | ($s.attempts // []) as $a
     | ($a|length) == 2
       and $s.iterations == 2
       and ([$a[].n] == [1,2])
       and ($a | all(.endedAt != null))
       and ([ $a[] | ((.endedAt|epochms) - (.startedAt|epochms)) / 1000 ]
            | all(. >= 2 and . < 3))' "$RUNS2" >/dev/null \
     || { echo "A5 FAILED: direct-abandonment attempts"; exit 1; }
   ```

   Two closed attempts, contiguous, each in the `[2s, 3s)` bucket that renders `0:02`, and a step
   total of `0:04`. The first attempt is the one no `finishStep` ever touched, so if the store's
   close branch keys on `finishedAt` being present rather than on the status transition, `$a[0]`
   has no `endedAt` and the `all(.endedAt != null)` clause fails. (No outcome is asserted, here or
   anywhere: the field does not exist, see §Architecture.)

6. **Then read it on a screen.** Open `/tasks/<runId>` and confirm, in this order because the first
   is the surface the user lands on: **collapsed**, the summary line's clock for `gate` reads
   `0:06`, not `0:03`; then **expanded**, three indented `gate` rows reading `0:01`, `0:02` and
   `0:03`, and a headline clock on `gate`'s own row also reading `0:06`. The two `0:06`s agreeing is
   the visual form of V3d. This is not a manual-only step: **V5b below is these exact assertions,
   automated in a real browser, and V5b is the required form.** Doing it by hand against the fixture
   run above is a useful sanity check, not a substitute for it.

**CORRECTED in revision 5: this box is NOT browserless, and what stood here was wrong.** The
previous paragraph said "Step 6 cannot be executed by a headless agent step, this box has no
browser", and cited spec `2026-08-20-step-and-tool-call-durations.md` §Verification 7/8, which
carried its visual pass as an open todo (`1f74df2b-9428-4e84-a983-870b00cbdcf2`) and disproved the
failure mode from production data instead. That precedent does not transfer, because this
repository ships a **self-provisioning real-browser harness**, and the correct move is to run the
visual pass rather than to file it:

- `.ai/scripts/test-env-up.sh` installs, builds, boots the app on a free port, health-checks it, and
  records the resolved browser provider in `.ai/qa/test-env.json`.
- `.ai/browsers/agent-browser.md` is that provider's descriptor, and its `ensure-installed`
  operation downloads the native release and Chrome for Testing, escalating for Linux libraries
  where it can, with **no operator step**.
- `packages/web/e2e/` already holds more than thirty real-browser specs driven through
  `packages/web/e2e/agent-browser.ts`, and `.ai/runs/2026-07-14-cockpit-ui-r1-platform-shell/final-gate-checks.md:13`
  records a 40/40 `TEST_E2E_STATUS=passed` on real Chrome in this repository.
- Measured on this box while writing this spec, so provisioning is warm rather than cold: the
  `agent-browser` release binary is already cached at
  `~/.cache/agent-tools/agent-browser/agent-browser-linux-x64`, and a real Chrome is already cached
  at `~/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`.

**V5b, the browser E2E (`packages/web/e2e/retry-step-timing.e2e.ts`), `npm run test:e2e`.** The
required, automated form of step 6, and the second half of the Done gate. It follows
`packages/web/e2e/task-thread.e2e.ts:60-90` exactly, because that file already solves this shape:
write the run record into a temp `dataRoot` **before** boot (the store reads `runs.json` once at
startup, and a terminal status keeps `recover()` off it), `spawn` the packaged CLI with
`fixtureServeEnv(dataRoot)`, wait for `/api/v1/health`, then drive a real Chrome at it. Artifacts go
to `.ai/qa/artifacts_e2e/`, the directory every other spec in that suite already writes to.

1. **The fixture is captured, not invented.**
   `packages/web/e2e/fixtures/retry-timing-run.record.json` is the `gate`/`work` run produced by V5
   step 1, lifted verbatim out of that run's `runs.json`, with exactly two documented edits (recorded
   in `packages/web/e2e/fixtures/README.md` beside the existing fixtures' provenance notes): a
   terminal `done` run status, the same reason `thread-run.record.json` carries one; and the
   `attempts` stamps normalized to exact intervals, 1000 / 2000 / 3000 ms on `gate` and 2000 ms on
   each `work` attempt, so the rendered strings are pinned by arithmetic instead of by how loaded
   the box was when V5 ran. Capturing rather than hand-writing it is the point: a hand-written
   record proves the renderer reads a shape someone imagined, while a captured one proves the store
   really writes it.
   **Assert the fixture parses before touching the browser**: `GET /api/v1/runs` (or the scoped
   per-run route) returns `gate` with an `attempts` array of length 3 and `iterations: 3`. A schema
   drift then fails as a schema error, at the first assertion, rather than as an unexplained missing
   DOM node forty lines later.
2. **Collapsed first**, because `openByRun.get(runId) ?? false` makes collapsed the default
   (`step-rail.tsx:365`) and therefore the surface most users see:

   ```ts
   browser.goto(`${baseUrl}${scoped(`/tasks/${RUN_ID}`)}`)
   browser.waitForFunction(`document.querySelector('[data-slot="workflow-steps"]') !== null`)
   const collapsed = browser.evaluate(
     `document.querySelector('[data-slot="workflow-steps"] > button [data-slot="step-duration"]')?.textContent?.trim() ?? null`,
   )
   expect(collapsed).toBe('0:06')
   browser.screenshot(join(artifactsDir, 'retry-timing-collapsed.png'))
   ```

   **The scoped selector is required, not cosmetic.** Both `StepClock` call sites render the same
   `<time data-slot="step-duration">` element (`step-rail.tsx:272`), so a bare
   `[data-slot="step-duration"]` matches the summary clock *and* every expanded row's clock once the
   rail opens. Scoping to the `CollapsibleTrigger` (`> button`) is what makes this assertion about
   the collapsed headline specifically.
3. **Expand**, by clicking that same trigger, and wait for the rail rather than for a timeout:

   ```ts
   browser.click('[data-slot="workflow-steps"] > button')
   browser.waitForFunction(`document.querySelector('[data-slot="step-rail"]') !== null`)
   ```
4. **The three attempt rows.** `step-row` carries no step id, so find `gate` by its visible name.
   This deliberately adds no test-only attribute to the component:

   ```ts
   const rows = browser.evaluate(`(() => {
     const kids = Array.from(document.querySelector('[data-slot="step-rail"]').children)
     const i = kids.findIndex((el) => el.matches('[data-slot="step-row"]') && el.textContent.includes('Gate'))
     const out = []
     for (const el of kids.slice(i + 1)) {
       if (!el.matches('[data-slot="step-attempt-row"]')) break
       out.push(el.textContent.trim().replace(/\\s+/g, ' '))
     }
     return out
   })()`)
   expect(rows).toHaveLength(3)
   expect(rows).toEqual(['attempt 1 · 0:01', 'attempt 2 · 0:02', 'attempt 3 · 0:03'])
   ```

   The `break` on the first non-attempt sibling is what bounds the read to `gate`'s own rows: the
   attempt rows are emitted as siblings immediately after their step's row (§The web side), so the
   next `step-row` terminates the group. Asserting the length separately from the contents means a
   selector that swept up a later step's rows fails on the count, with a legible message, instead of
   on an opaque array diff.
5. **The expanded headline agrees with the collapsed one.** This is V3d on a real screen, and it is
   the assertion the task's "total time as step time" ultimately reduces to:

   ```ts
   const expanded = browser.evaluate(`(() => {
     const row = Array.from(document.querySelectorAll('[data-slot="step-row"]'))
       .find((el) => el.textContent.includes('Gate'))
     return row?.querySelector('[data-slot="step-duration"]')?.textContent?.trim() ?? null
   })()`)
   expect(expanded).toBe('0:06')
   expect(expanded).toBe(collapsed)
   browser.screenshot(join(artifactsDir, 'retry-timing-expanded.png'))
   ```
6. **Artifacts are retained, both kinds.** Two screenshots,
   `.ai/qa/artifacts_e2e/retry-timing-collapsed.png` and `retry-timing-expanded.png`, which
   `AgentBrowser.screenshot` already gates on being non-empty
   (`packages/web/e2e/agent-browser.ts:233-241`); plus a WebM at
   `.ai/qa/artifacts_e2e/retry-timing.webm`, from the `startRecording` / `stopRecording` pair Phase 2
   item 8 adds to the wrapper and to the provider descriptor.

   **Start the recording after the first navigation, not after `AgentBrowser.open`.** `open`
   (`agent-browser.ts:89-95`) starts no browser: it reads `.ai/qa/test-env.json`, throws unless
   `browser.installed`, and returns a wrapper holding the binary path and a session name. The first
   call that actually drives anything is `goto` (`:118-120`, which shells out to
   `agent-browser open <url>`), so a `record start` issued straight after the constructor has no
   active page to record. The order inside step 2 is therefore: `goto` → `waitForFunction` on
   `[data-slot="workflow-steps"]` → `startRecording(join(artifactsDir, 'retry-timing.webm'))` → the
   collapsed assertion and screenshot → step 3's expansion. Stop it in `afterAll` before `close`,
   and assert the resulting file exists and is non-empty (`statSync(path).size > 0`), the same gate
   `screenshot` already applies to its PNGs. **If `record` turns out not to work headless on this
   box**, say so in the run's gate notes and keep the two screenshots as the retained evidence. Do
   not delete the assertion, and do not report the pass as though video existed.
7. **The printed status is the verdict, not the exit code.** `npm run test:e2e` must print
   **`TEST_E2E_STATUS=passed`**. `.ai/scripts/e2e.sh` exits **0** for `TEST_E2E_STATUS=skipped` too
   (`:32-33`), which is what it emits when the browser provider could not be provisioned, so exit 0
   alone is not a pass and **`skipped` is QA Needed, never Done**. Grep the output for the literal
   `TEST_E2E_STATUS=passed` rather than reading `$?`. Precedent for this exact trap, in this
   repository: `.ai/specs/2026-08-24-land-the-backlog-composer.md:794` and `:872`, and
   `.ai/specs/2026-08-06-external-source-connectors-notion.md:579`.

**What V5 still carries on its own.** Steps 1 to 5 remain fully executable headless and are not
made redundant by V5b: they are what proves the *record* is right (A2, that the three intervals
differ; A3, that the aggregate is the sum and not the span; A5, the direct-abandonment path), and
V5b's fixture is captured from them. V5b proves the *screen* is right. Neither substitutes for the
other, and both must have run before this leaves QA Needed.

**V6, the two startup-recovery paths, which behave differently and must be pinned apart.** Added
after review; this is the coverage the `running → running` correction demands, and neither case is
reachable from V1 (they need a run record and a restart, not a bare `updateStep`).

**Both cases need an execution-capable fixture, and revision 5's "extend the existing suites" was
wrong.** `recover-brokered.test.ts:57-60` and `recover-chain.test.ts:49-51` both pin
`maxParallel: 0`, deliberately, so that recovery's *decision* can be asserted with nothing spawned.
But the seam this spec changes is the step-loop head (`run.ts:5756-5766`), which runs only inside
`execute`, which a zero-capacity semaphore never reaches: V6a would pass with the guard deleted, and
V6b could never observe attempt 2 opening at all. Each case therefore needs (i) **available
capacity** (the default semaphore, no `maxParallel: 0` override), and (ii) a **controlled runner or
broker**, so that entering `execute` spawns no real agent. Build (ii) with the pattern
`broker-retry.test.ts:13-46` already uses: `vi.mock('../core/runner-factory.ts')` returning a
`createRunner` whose `startSession` resolves a scripted `AgentSession`. Because that mock is
module-scoped, the cheapest home is a focused new file,
`packages/cezar/src/workflows/recover-attempt-timing.test.ts`, carrying both cases and rebuilding
the `runningRun` / `liveSpool` helpers those suites already demonstrate
(`recover-brokered.test.ts:69-105`). Adding a second `describe` to one of the existing files is
acceptable only if the runner mock can be scoped so it does not change that file's existing cases.

Both cases also share one setup step that must be explicit: **seed exactly one `step-start` event
for the interrupted step before recovering**, e.g. `store.appendEvent(id, { type: 'step-start',
stepId: 'implement', name: 'implement', kind: 'agent', iteration: 1 })`. The fixtures build their
interrupted run with `store.updateStep`, which appends no event at all, so "the count is still 1"
would be vacuously true against an empty stream and V6a's event assertion would pass for the wrong
reason.

- **V6a, live broker re-attach is NOT a new attempt.** Record: a `running` run whose step has
  `iterations: 1`, one open attempt, one seeded `step-start`, and a live spool whose `meta.stepId`
  matches (`liveSpool` writes `pid: process.pid`, so `isPidAlive` is true by construction). Recover
  with capacity available, then **let the queued work actually run**: poll until the controlled
  runner has been asked for a session (`fake.specs.length === 1`) or the step reaches a terminal
  status, so `execute` has demonstrably passed the step-loop head and the live-spool path has had
  its chance to open a second attempt. Assert: `reattachBrokeredRun` returned true; the step is
  still `running`; `iterations` is **still 1**; `startedAt` is **byte-identical** to the pre-restart
  value; `attempts` still has exactly one entry with **no `endedAt`**; and the count of `step-start`
  events for that `stepId` is **still 1**. The event assertion is separate from the store ones and
  not implied by them (§API contracts): a guard that patches the store but leaves the `emit` at
  `run.ts:5766` in place passes all of them and still ships a record whose two halves contradict
  each other.
- **V6b, dead-process chain re-entry IS a new attempt.** The same record and the same seeded
  `step-start`, but with **no live spool**, so `reattachBrokeredRun` refuses and `reenterChain`
  takes it. The same capacity, the same controlled runner, and the same wait for the step loop to
  reopen the step. Assert: `iterations` becomes 2; `attempts.length` becomes 2; attempt 1 is closed;
  attempt 2 is open with a fresh `startedAt` at or after attempt 1's `endedAt`; and the `step-start`
  events for that `stepId` now number 2, with `iteration` values `[1, 2]`.
- **Both cases must be shown to fail when the guard changes, and that demonstration is part of the
  deliverable.** Delete the `pendingReattach` check at the step-loop head and re-run: V6a must go
  red (a second attempt and a second `step-start` appear). Widen the guard so it skips the opening
  unconditionally and re-run: V6b must go red (no second attempt). Record both red runs in the
  implementing run's notes. A pair that stays green under either mutation is not testing the guard,
  which is exactly the defect the zero-capacity fixture had.
- **V6c, the field survives a reload** (`packages/cezar/src/runs/store.test.ts`). Write a record
  with a multi-attempt step, re-instantiate the store so `runRecordSchema.safeParse` re-materializes
  it from `runs.json`, and assert `attempts` is still there. This is the test that fails loudly if
  only the contract schema learned the field and `store.ts`'s did not (§Data models).

**V7, the continuation retry seam, which revision 2 missed entirely.** `runContinuation` re-invokes
itself for the **same** `stepId` on a cold-broker (`run.ts:5298`) or missing-session (`:5326`)
failure, writing `iterations: 1` and a fresh `startedAt` each time (`:4785-4791`). This is where the
withdrawn "replace the attempts array" rule would have destroyed real timing, so it needs a
regression at the engine level and not only the `updateStep`-level V1d. **Revision 4 also makes it
the only place three separate Phase 1 changes can be observed together**: the `catch`'s new
`pending` patch, the derived `iterations`, and the derived `step-start` `iteration`, none of which
V1 can see, because V1 drives the store with hand-written patches and these three are all decisions
`run.ts` makes before the store is called.

- **V7a, cold-broker continuation retry** (`packages/cezar/src/workflows/broker-retry.test.ts`).
  **The fixture already exists**: `'relaunches a continuation broker with the same backend session
  context'` (`:143-174`) drives `continueRun` through exactly one cold-broker relaunch. Extend it,
  do not add a file. Assert on the `continue-1` step afterwards: `attempts.length === 2`; attempt 1
  is closed and its `endedAt` is at or before attempt 2's `startedAt`; attempt 2 is closed with the
  step's own `finishedAt`; the two intervals do not overlap; and **`iterations === 2`, not the
  literal `1` the code writes**, which is the `patch.iterations` correction from §Architecture
  observed end to end. A regression to the replace rule yields `attempts.length === 1` here.

  **Plus two assertions added in revision 4, neither implied by the five above:**
  1. **The status went `running → pending → running`, proved by the patch sequence and not by a
     clock gap.** Attempt 1's `endedAt` must be stamped at the `catch`'s new `pending` patch, not at
     the next `startedAt`. Do **not** assert `attempts[0].endedAt < attempts[1].startedAt`: this
     fixture continues a run created with `worktree: false` (`:132`) and runs in place, so
     `state.cwd === this.repoRoot`, the `autosaveCommit` at `run.ts:5292` is skipped outright, and
     nothing but a few synchronous store writes separates the abandonment from the next open. Both
     ISO stamps can land in the same millisecond, and a strict `<` would flake.
     Assert instead: (a) the **`updateStep` patch sequence** for `continue-1` reads
     `running, pending, running`, captured with a spy (`vi.spyOn(store, 'updateStep')`, or the
     store's own captured calls if the suite already keeps them) and read as the ordered list of
     `patch.status` values with statusless patches ignored (V1g's shape); and (b) non-overlap under
     the **inclusive** bound `attempts[0].endedAt <= attempts[1].startedAt`, together with
     `stepTotalElapsed` equal to the sum of the two intervals rather than to their span. If a strict
     gap is wanted anyway it must be manufactured, not hoped for: inject a clock the test advances
     deterministically between the two patches. Note what changes about the failure signature:
     equal stamps no longer indict the withdrawn close-at-next-open rule, because they are expected
     here; the **missing `pending` entry in the captured sequence** is what indicts it.
  2. **The `step-start` event stream reads `[1, 2]`, not `[1, 1]`.** Filter the run's events to
     `type === 'step-start' && stepId === 'continue-1'` and assert the `iteration` values in order.
     This is the half the store cannot fix (§API contracts, change 1); every store-side assertion
     above passes with the event still hard-coded to `1` at `run.ts:4792`, and the record and the
     NDJSON would then contradict each other about a step this spec is specifically making legible.
- **V7b, missing-session continuation retry** (extend the existing case in
  `packages/cezar/src/workflows/recover-session-failure.test.ts`, `:55-110`, `'retries once with a
  fresh session instead of failing the run outright'`). **Revision 5 claimed nothing covered this
  path and called `recover-session-failure.test.ts` a chain-loop suite; both were wrong.** That case
  seeds `work` with `sessionId: 'missing-thread'`, sets `MOCK_CODEX_REJECT_RESUME=1`, calls
  `recover()`, and asserts a single `continue-1` step whose session id is fresh plus the
  `run.step.resumed_after_missing_session` metric, which *is* `runContinuation`'s missing-session
  retry (`run.ts:5261-5262`, `:5326`, `:5340`) driven end to end. Extend that case; do not build a
  sibling of V7a.

  **And assert what the fixture actually produces, which is not all of V7a.** It parks the run at
  `waiting` (the codex mock's scripted turn never emits a completion marker), so attempt 2 is still
  **open**: it has no `endedAt`, the step has no `finishedAt`, and V7a's "attempt 2 is closed with
  the step's own `finishedAt`" must not be copied over. Assert exactly: `continue-1` has
  `attempts.length === 2`; attempt 1 is **closed** (`endedAt` present); attempt 2 is **open**
  (`startedAt` present, **no `endedAt`**) while the run sits at `waiting`; the captured `updateStep`
  status sequence for `continue-1` reads `running, pending, running` (V7a's method, same spy, same
  inclusive `attempts[0].endedAt <= attempts[1].startedAt` bound); `iterations === 2`, not the
  literal `1` the code writes; and the `step-start` events for `continue-1` carry `iteration` values
  `[1, 2]`.

  Why it earns a case beside V7a: the two retry branches are separate code (`run.ts:5240-5241` cold
  broker, `:5261-5262` missing session), each needs its own `pending` patch, and a fix applied to
  one branch only is precisely what this catches. Note also that `missingSessionRetry` re-invokes
  `runContinuation` with `sessionId: undefined` (`run.ts:5340`), so attempt 2 opens against a
  different session than attempt 1, and the attempts array must still read as one step's two
  attempts rather than as two steps. Keep the fixture's existing teardown (`firstManager.cancel` /
  `dispose`, `:108-109`), which is what stops the parked session leaking past the test.
- **V7c, a fresh `continue-N` step is NOT a retry.** A plain `continueRun` with no failure →
  the new `continue-2` step has `attempts.length === 1` and `iterations === 1`, and the **previous**
  `continue-1` step's attempts array is untouched. This is V7a's control: a store that closed and
  reopened on every `iterations: 1` patch regardless of whether an attempt was open would pass V7a
  and fail here.

## Analytics

No new metric event. The existing `run.step.retried_cold_broker` and
`run.step.resumed_after_missing_session` (`run.ts:5896-5903`, `:5920-5928`) already count *that* a
retry happened; this spec makes the *cost* of one legible in the record, which is the missing half.
Once `attempts` is populated, per-attempt duration becomes answerable from `runs.json` by `jq`
alone (V5 steps 2-4 are exactly that query) with no instrumentation, worth noting so nobody adds a
metric to answer a question
the record already answers.

## Deployment

Phase 1 touches the server, so it needs a restart; Phase 2 is web-only and swaps live. Per
`AGENTS.md` (corrected 2026-08-24, spec `.ai/specs/2026-08-24-manual-deploy-not-a-bug.md`) both
targets in `.ai/deploy-targets.json` are `"manual": true`, so an agent-run `spec-to-deploy` on
cezar **parks** at the deploy step with a handoff for a person to resolve. That parked state is the
expected terminal state of the run implementing this spec, not a defect.
