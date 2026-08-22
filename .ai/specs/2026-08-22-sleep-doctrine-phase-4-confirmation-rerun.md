# Sleep doctrine Phase 4 — this run (`bde0ec40`) is a duplicate dispatch of an already-finished task

**Status:** ABANDONED, 2026-08-22 (`document` step, same dispatch's later steps). `review-spec`
rejected the design in § Phases item 3 as unexecutable — `computeRunStats` buckets a run's stats
cumulatively per `stepId`, not per dispatch, so a re-run of `run-tests` cannot produce an
addressable delta against the pre-pass baseline this spec's Phase 5/Verification-4 depended on;
its Phase 6 also assigned writing the addendum to `commit-push`, which has neither `Write`/`Edit`
nor `cez run stats` in its `bashAllowlist`. The chain never revised this spec to fix either issue
and never re-ran `implement`/`run-tests` a third time — confirmed by re-reading `cez run stats`
from `document`: totals are byte-identical to the reading already recorded before this spec was
written (§ Problem, Phase 3 baseline). **No second data point was produced.** Phase 4 of the
governing spec rests on the single measurement in its revision 8 / § Verification §4, which this
abandoned pass neither weakens nor corroborates. The addendum this spec called for is written
instead as `.ai/specs/2026-08-21-wait-on-the-process-not-a-guess.md` § Verification §6, recording
this outcome rather than a delta that was never available. A todo is filed for the recurring-
redispatch question this spec's own Risks section flagged and left open.
**Date:** 2026-08-22

## TLDR

Run `bde0ec40-06da-4628-8410-06a6a42694c7` was handed, verbatim, the Phase-4 measurement task it
already completed in a prior pass through this same run id. That prior pass is fully recorded:
commit `b6a28ab7` measured `blindSleepCalls: 0` / `sleepCalls: 5` / `sleepExecMs: 16505` /
`repeatedExpensiveCalls: 0` (at measurement time), merged as `fb325ff8`, and
`.ai/specs/2026-08-21-wait-on-the-process-not-a-guess.md`'s Status line already reads "IMPLEMENTED,
SHIPPED, DEPLOYED AND NOW MEASURED (revision 8)". There is no code to write and no Phase 4 to
re-open. This spec does not redo the measurement or touch the shipped doctrine text; it records the
duplicate-dispatch finding, and defines the one thing this pass can legitimately still produce — a
second, independent data point for the same claim, captured from *this* pass's own `run-tests`
execution rather than invented or copy-pasted from the first pass.

## Problem

The task text handed to this run's `context`/`spec` steps this pass is identical to the task that
produced `b6a28ab7`. Re-verified fresh, from this step, against primary sources (not re-derived
from the brief alone):

- `git log --oneline -3` (main checkout, `/var/lib/cezar/loki-labs/cezar`): `HEAD` is now `d992c296`,
  two commits past `351626f5` ("docs: mark the run-broker CLI keepalive spec implemented..."). The
  main checkout is shared across concurrently-running tasks and has moved since the brief was
  written 12 minutes earlier (it recorded `HEAD` as `fb325ff8`) — expected, and irrelevant to this
  finding: `fb325ff8` (the measurement merge) is still an ancestor.
- `git merge-base --is-ancestor ada8f376 HEAD` → **yes, ancestor**. Phases 1-3 (the doctrine rewrite)
  are still in the history this pass would build on.
- `git diff ada8f376 -- packages/cezar/src/workflows/run.ts | grep TOOL_BUDGET_DOCTRINE` → **no
  hits**. The file has changed since `ada8f376` (162 insertions / 10 deletions — unrelated work,
  e.g. `loadWorkspaceGrant` and a feedback-wrapping helper for spec-step re-entry), but the
  `TOOL_BUDGET_DOCTRINE` string constant itself (`run.ts:541`) is byte-identical to what `ada8f376`
  shipped. **The measured doctrine text is still exactly what was measured.**
- `/opt/cezar` → `/opt/cezar-releases/20260822T122351Z-fb325ff8` (verified `ls -la`, this step) —
  the deployed release is still the one built from the commit that recorded the measurement.
- `cez run stats bde0ec40-06da-4628-8410-06a6a42694c7 --json` (main checkout — the worktree's own
  `.ai/cezar/runs/` does not carry this run's transcript), re-run fresh this step: **7 steps**
  (`context, spec, review-spec, implement, run-tests, commit-push, continue-1`), totals
  `blindSleepCalls: 0`, `sleepCalls: 5`, `sleepExecMs: 16505`, `repeatedExpensiveCalls: 3`,
  `batchFactor: 1`. Identical to what the brief and the spec's own Verification §4 already recorded
  — this is the *same* stored step list, not new data; this pass has not yet appended a step.
- `.ai/specs/2026-08-21-wait-on-the-process-not-a-guess.md` lines 1-30 (this worktree): Status line
  reads "IMPLEMENTED, SHIPPED, DEPLOYED AND NOW MEASURED (revision 8, 2026-08-22)", names this run
  id and these exact numbers, and its `~~superseded~~` chain shows four prior revisions retracted in
  place (never silently deleted) — consistent with this repo's correction convention.
- The `context` step's own brief this pass,
  `.ai/specs/briefs/2026-08-22-sleep-doctrine-phase-4-rerun-already-complete.md`, reaches the same
  conclusion independently and flags the one thing it could not resolve: **why step 1 is executing
  again is a harness/orchestration question, not a code or spec question**, and this spec does not
  attempt to answer it — it treats the re-dispatch as a fact to design around, not a bug to fix.

So: nothing is broken, nothing needs building, and the acceptance criteria as literally stated
(`blindSleepCalls == 0` on a run composed by the deployed doctrine) are already satisfied by
`b6a28ab7`/`fb325ff8`. Re-opening Phase 4 as "outstanding" or authoring a second, competing spec
that reproduces the same claim from scratch would misrepresent the record this repo has already
committed to.

## Solution

Treat this pass as a **confirmation pass**, not a fresh Phase 4:

1. **No prompt or code change.** `TOOL_BUDGET_DOCTRINE` is unchanged and still deployed; there is
   nothing for `implement` to write.
2. **This spec file is the only new artifact from this step.** It documents the duplicate-dispatch
   finding so a later reader (or the next accidental re-dispatch) doesn't have to re-derive it.
3. **The remaining chain steps (`run-tests` onward) still execute** — that is a harness fact, not
   something this spec can or should suppress — so their execution is repurposed as a legitimate
   second, independent data point: does the deployed doctrine still produce `blindSleepCalls == 0`
   under a *second* live `run-tests` execution, on a checkout that has moved on since the first
   measurement? That is a stronger claim than "it happened once."
4. **The addendum goes on the governing spec, not a Status-line rewrite.** The existing
   `.ai/specs/2026-08-21-wait-on-the-process-not-a-guess.md` Status line and its
   `~~superseded~~` chain are the historical record of revisions 1-8; this pass appends a dated
   "Confirmation pass #2" note under its Verification §4 (new subsection), citing this spec, rather
   than editing the Status line or the existing revision-8 text. The original claim stays exactly as
   it was recorded; the addendum adds corroboration, it does not supersede anything (nothing in
   revision 8 is being retracted).
5. **No duplicate KB proposal.** `.ai/cezar/runs/bde0ec40-....knowledge.ndjson` already holds an
   unapplied `seq 0` upsert for `knowledge/notes/sleep-doctrine-phase-4-measured.md`. Before this
   pass's `document` step writes anything KB-side, it must check `cez kb proposals` for that pending
   entry and either update the *same* seq-0 note in place (if this pass's `document` step runs first
   and the file is still an open proposal) or fold the confirmation numbers into it — never author a
   second upsert for the same path.

## Architecture

No architectural change. This is a process/documentation-only pass over the same three components
Phase 1-4 already touched:

```
packages/cezar/src/workflows/run.ts   TOOL_BUDGET_DOCTRINE constant   ← unchanged, confirmed byte-identical to ada8f376
packages/cezar/src/runs/stats.ts      computeRunStats                ← unchanged, source of the numbers below
.ai/specs/2026-08-21-wait-on-the-process-not-a-guess.md   governing spec   ← gets an addendum, not a rewrite
.ai/specs/2026-08-22-sleep-doctrine-phase-4-confirmation-rerun.md   (this file)   ← new, records the duplicate-dispatch finding
```

## Phases

Each phase below is one step of this run's chain. Phases 1-2 already happened this pass; 3-7 are
what remains.

1. **`context` (done, this pass).** Brief written:
   `.ai/specs/briefs/2026-08-22-sleep-doctrine-phase-4-rerun-already-complete.md`. Established the
   duplicate-dispatch finding.
2. **`spec` (this step, done).** This file. No code touched.
3. **`review-spec`.** Confirm this spec proposes no code/prompt change, cites primary sources (not
   just the brief) for the duplicate-dispatch claim, and that the addendum plan in § Solution item 4
   does not ask any later step to edit the Status line or retract revision 8. Approve if so —
   there is no implementation risk to review here, only a documentation-scope check.
4. **`implement`.** No functional change expected. Verify (don't re-derive from scratch — cite this
   spec's own diff commands) that `TOOL_BUDGET_DOCTRINE` is still byte-identical to `ada8f376` and
   that `ada8f376` is still an ancestor of `HEAD`. If either check fails (doctrine text drifted, or
   history was rewritten), stop and escalate — the confirmation-pass premise breaks.
5. **`run-tests`.** Execute the standard gates the same way every `run-tests` step does under the
   deployed doctrine (`npm ci`, `typecheck`, `test:unit`, `npm test`), using tier-2/tier-3 waiting
   per `TOOL_BUDGET_DOCTRINE`. Immediately **before** this step runs, capture the pre-pass baseline
   via `cez run stats bde0ec40-06da-4628-8410-06a6a42694c7 --json` (7 steps, totals as recorded in
   § Problem above) so the post-pass read can be diffed against it rather than read as a raw
   cumulative total.
6. **`commit-push`.** Commit this spec file plus the Verification §4 addendum on
   `2026-08-21-wait-on-the-process-not-a-guess.md` (§ Solution item 4) in one commit; push to
   `origin/main` per this repo's standing authorization (`chat/CLAUDE.md` grant extended to
   `cezar/`, `origin` remote only).
7. **`document`/`deploy`.** No functional diff to deploy — `implement` (phase 4) made no code
   change. If the harness always redeploys on chain completion, that redeploy is expected to be a
   no-op (same commit hash, no bundle change from Phase 4-6 work beyond the doctrine addendum and
   this spec file, both markdown). Confirm the deployed `TOOL_BUDGET_DOCTRINE` string still matches
   post-deploy, and reconcile the KB proposal per § Solution item 5.

## Data models

None. No schema, route, or run-protocol change.

## API contracts

None. `cez run stats <runId> --json`'s shape (`stats.ts`) is unchanged; this spec only reads it.

## Risks

- **Cumulative-counter misread.** `cez run stats` reports totals across *all* stored steps for a
  run id. If this pass's `run-tests` appends a new step (or a new `continueN`) to the *same* stored
  step list rather than starting a fresh one, reading the post-pass total naively would double-count
  the first pass's `sleepCalls: 5` / `sleepExecMs: 16505` as if they belonged to this pass.
  Mitigation: Phase 5 captures the pre-pass baseline first; the confirmation addendum reports the
  **delta** (new step id(s) only), not the raw post-pass total.
- **Second KB upsert for the same fact.** Addressed in § Solution item 5 — check
  `cez kb proposals` before writing, fold into the existing seq-0 entry rather than duplicating it.
- **Status-line churn.** Editing `2026-08-21-wait-on-the-process-not-a-guess.md`'s Status line again
  (a fifth "supersedes" entry) for a pass that changes nothing about the claim would make the
  `~~superseded~~` chain read as if something new were being decided. Mitigation: § Solution item 4
  — addendum only, Status line untouched.
- **The root question stays unanswered.** This spec does not determine why step 1 dispatched again
  for a run whose handoff said "TASK COMPLETE." If it happens a third time, that is a
  harness/orchestration defect worth its own investigation outside this task's scope — flagged, not
  fixed, here (consistent with the `context` step's brief).
- **Gate flakiness already on file.** Todo `90b00d11-b564-42ec-ae10-08bf057e5813` (catalog.test.ts
  C18 index-build budget, 59-68 ms/MiB vs a 40 ms/MiB line, reproducible on this box, pre-existing
  on `origin/main`) may fire again in Phase 5's `npm test`. That is expected and already tracked;
  it does not indicate a new defect in this pass.

## Verification

1. **Doctrine text unchanged (Phase 4 gate).**
   `git -C /var/lib/cezar/loki-labs/cezar diff ada8f376 -- packages/cezar/src/workflows/run.ts | grep TOOL_BUDGET_DOCTRINE`
   → must return no hits. Already run this step: **passes** (no hits; see § Problem).
2. **Ancestry intact.**
   `git -C /var/lib/cezar/loki-labs/cezar merge-base --is-ancestor ada8f376 HEAD && echo yes`
   → must print `yes`. Already run this step: **passes**.
3. **Pre-pass baseline (run before Phase 5's `run-tests` executes).**
   `cez run stats bde0ec40-06da-4628-8410-06a6a42694c7 --json` (from the main checkout, not this
   worktree) → record the step id list and totals. As of this step: 7 steps
   (`context, spec, review-spec, implement, run-tests, commit-push, continue-1`),
   `blindSleepCalls: 0`, `sleepCalls: 5`, `sleepExecMs: 16505`, `repeatedExpensiveCalls: 3`,
   `batchFactor: 1`.
4. **Post-pass delta (run after Phase 5's `run-tests` executes).** Re-run the same command; diff
   the step list against item 3's baseline. For every step id absent from item 3's list:
   - dump the Bash tool calls that contain `sleep` in that step's transcript (per this task's
     acceptance criterion 2 — every surviving sleep must be visibly inside a
     `until grep -q "^EXIT="; do sleep N; done`-shaped early-exit loop, or a similar tier-3 poll,
     not a bare `sleep N`);
   - confirm the delta's `blindSleepCalls` contribution is `0`;
   - read (not assert) the delta's `repeatedExpensiveCalls` and classify each occurrence as
     "after a code change" or "defect," per this task's acceptance criterion 3.
5. **Addendum written, Status line untouched.** After item 4, confirm
   `git -C /var/lib/cezar/loki-labs/cezar diff -- .ai/specs/2026-08-21-wait-on-the-process-not-a-guess.md`
   touches only a new dated subsection under Verification §4 (a "Confirmation pass #2" heading),
   and that the file's existing Status line (top of file) and its `~~superseded~~` chain are
   byte-identical before and after.
6. **No duplicate KB proposal.** `cez kb proposals` (or the equivalent listing) shows at most one
   open or applied entry for `knowledge/notes/sleep-doctrine-phase-4-measured.md`.

Items 1-3 are executed and recorded above, this step. Items 4-6 are QA-pending — they depend on
Phase 5 (`run-tests`) executing later in this same chain, which this step (`spec`) does not run.
