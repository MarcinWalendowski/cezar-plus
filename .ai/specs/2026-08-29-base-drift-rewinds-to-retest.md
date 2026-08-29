# A moving base rewinds the chain to run-tests, instead of killing the run

**Status:** Implemented (2026-08-29)
**Extends** `.ai/specs/2026-08-20-steps-green-only-when-verified.md` (the post-condition gate) and
`.ai/specs/2026-08-29-step-resume-and-two-stage-review.md` (D1's warm loop-back, reused here).
**Supersedes nothing.** No gate is weakened: every case below still fails, and the merged tree is
still tested before anything ships. What changes is *which step is asked to fix it*.

## TLDR

`tested-revision-shipped` compares HEAD against the tree `run-tests` attested. Merging a base that
moved is not optional when six runs are landing on `main` at once — and the gate read that merge as
untested edits, then spent its one retry re-entering the step that cannot change the comparison.
Two runs died of it on 2026-08-29, both *after* their work was already on `origin/main`, and both
with `document` and `deploy` never run. That is why a feature sat on `main`, undeployed, looking to
its owner like nothing had happened.

## Problem

Measured on `prod-host`, 2026-08-29:

| Run | Died at | Verdict | Its work |
| --- | --- | --- | --- |
| `872b396a` | `commit-push` | `HEAD changed outside the tested revision in …` (38 files) | **already on `origin/main`** (`20690834`, `a560b873`; `git log origin/main..HEAD` empty) |
| `1909f34e` | `merge` | `base origin/main moved by 17 commit(s) since the tested revision; re-run the tests on the merged tree` | committed and pushed |

Three separate things were wrong, and each one alone was enough:

1. **The verdict could not tell a merge from an edit.** A tree diff shows both identically, and
   they have opposite remedies. 36 of `872b396a`'s 38 named files belonged to other runs.
2. **The retry was spent where it could not help.** `retryAfterFailedPostcondition` re-enters the
   SAME step. Re-running `commit-push` recomputes the identical diff by construction.
3. **An agent step's post-condition was terminal.** A *check* step has consulted `onFail` since it
   existed; the agent arm never did, so no workflow configuration could have rescued either run.
   `merge`'s verdict has printed the correct remedy — "re-run the tests on the merged tree" — since
   the day it was written, with no way to reach it.

A fourth, found on the way: the aggregate returned `retryMax: first.max`, discarding each verdict's
own budget. The `merge` branch's `retryMax: 1` had been dead code since it was written.

## Solution

**S1 — the gate tells base drift from an edit.** `baseMovedUnderTest()` answers only when
`origin/<base>` is contained in HEAD **now** and was **not** contained in the revision the tests ran
against. That asymmetry is the whole signal: true exactly for "upstream arrived after my tests",
false for an edit, a cherry-pick, or a base already merged when the suite ran. Every probe failing
reads as "not drift", so an unresolvable ref degrades to the original strict verdict, never to a
pass. The drift verdict names the distance, asks for a re-test, and declares `retryMax: 0`.

**S2 — a verdict's own retry budget is believed.** `combineVerdicts()` (extracted from
`runStepVerify`, exported for test) returns `first.retryMax ?? first.max`: the gate wins when it
states a budget, the workflow governs when it stays silent.

**S3 — an agent step's failed post-condition may rewind.** After its own retry budget is spent, the
agent arm consults `canLoopBack(step)` and calls the existing `loopBackTo()` — the same one the
reviewer's `revise` verdict and a failing check step already use. Ordering is deliberate: the step's
own attempt comes first, because most post-condition failures *are* its own job.

**S4 — both shipping steps name `run-tests` as their rewind target.**
`onFail: { retry: 'run-tests', max: 1, resume: true }` on `commit-push` and on `merge`. `run-tests`
is the attesting step, so re-entering it is what produces a fresh `treeSha` for the merged tree.

## Architecture

```
commit-push / merge post-condition fails
   │
   ├─ gate says retryMax: 0 (base drift)  ─┐        S1 + S2
   ├─ gate silent → workflow's max          ├─▶ same-step retry, if budget remains
   │                                        └─▶ spent?
   └────────────────────────────────────────────▶ canLoopBack? ─▶ loopBackTo('run-tests')   S3 + S4
                                                                    └─▶ re-test the MERGED tree,
                                                                        re-attest, ship
```

## Data models

None. `PostconditionResult.retryMax` already existed and is now read.

## API contracts

Unchanged on the wire. `WorkflowStepDef.onFail` already round-trips through
`packages/contract/src/workflows.ts`; only the built-in workflow's default value changes.

## Risks

- **A rewind is expensive** — it re-runs the whole suite. Bounded at `max: 1`, and reached only
  after the step's own attempt. A base that moves *again* during the re-test is a queueing problem,
  not something to spend a second suite on.
- **"Drift" must not become "assume green".** It does not: the drift branch is still `ok: false`,
  and the third test below pins that an edit made after an already-merged base reads as an edit.
- **`resume: true` on shipping steps** reuses D1's warm path, which falls back cold on every guard.

## Verification

Executed 2026-08-29.

1. `base-drift-retest.test.ts` — four cases over real `mkdtemp` git repos with a bare origin and a
   second clone standing in for a concurrent run: drift asks for a re-test and sets `retryMax: 0`
   while staying `ok: false`; a post-test edit with no base movement keeps the strict verdict and
   an untouched budget; an edit after an **already-merged** base reads as an edit (the asymmetry
   control); a record-only merge stays green. **Mutation-checked**: never detecting drift → 1 red;
   dropping `retryMax: 0` → 1 red; deleting the `wasAlreadyTested` early return → 2 red; treating
   everything as drift → 3 red. ✅
2. `postcondition-loop-back.test.ts` — the engine end to end (`CEZ_DRY_RUN=1`, real `RunManager`,
   bundled mock CLI): a chain whose post-condition passes only on its Nth evaluation rewinds and
   finishes; the **identical chain without `onFail` still dies** (negative control, without which
   the first case cannot tell a rescue from a counter that would have passed anyway); and the
   step's own retry still comes first. That last case needed an explicit **event-ORDER** assertion
   — both orders spend the same budgets and produce identical spawn counts and evaluation counts,
   so every other assertion passed under the swap. **Mutation-checked**: removing the `canLoopBack`
   branch → 2 red; rewinding before the same-step retry → 1 red (only via the order assertion). ✅
3. `combineVerdicts` unit cases — the gate's `retryMax: 0` beats the workflow's 1; a silent gate
   keeps the workflow's budget; the FIRST failure's budget governs; handoffs survive aggregation.
   Reached directly because the branch that matters fires only for a **built-in** post-condition,
   and every built-in passes under `CEZ_DRY_RUN=1` — the flag the engine tests need. **Mutation-
   checked**: restoring `retryMax: first.max` → 1 red. ✅
4. `types.test.ts` — both shipping steps carry `tested-revision-shipped` and rewind to `run-tests`,
   asserted as whole objects, with the step order pinned so the target is the ATTESTING step. ✅
5. Full gates: `npm run typecheck` clean; `npm test` **639 files / 12,043 passed, 0 failed**. ✅
6. **Production E2E — pending.** The acceptance test is a run surviving a base that moves under it:
   `run.step.looped_back` with `target: "run-tests"` on a shipping step, and the run reaching
   `deploy`. Not observable until this is deployed and `main` moves under an in-flight run.
