# Per-retry step timing

- **Status:** **CORRECTED 2026-08-29 (same run) — implemented, not "not implemented."** All three
  phases (P1 store-owned `attempts[]`, P2 cumulative `stepElapsed`, P3 `StepRow` breakdown UI +
  the `step.attempts_expanded` analytics event) are built and gate-tested: `npm run typecheck`
  green, targeted suites green (`store.test.ts`, `run.test.ts`'s two new engine cases,
  `step-timing.test.ts`, `step-rail.test.tsx`, `live-duration.test.tsx`, `analytics.test.ts`), all
  9 Verification-4b negative controls reverted-and-confirmed-red then restored, and the full repo
  suite green post-merge (`packages/web` 4179/4179, `packages/cezar` 7824 passed/4 skipped/0
  failed). Committed as `20690834` ("feat: aggregate step retries into total time, show each retry
  in tree UI"), merged with `origin/main` as `a560b873` (dropping this branch's own
  `postAnalyticsEvents`/`analytics.ts` duplicate in favour of origin's already-converged canonical
  sink; `step-rail.tsx`'s one `track()` call site is compatible with it), and pushed to
  `origin/main` (fast-forward). **QA Needed, not Done:** Verification 5, the Playwright runtime
  E2E against `/tasks/:id`, has not been executed — tracked as todo
  `da65120d-670e-47e0-baf8-ddbef6ab0bd4`. Do not close that todo or call this spec Done until it
  has actually run. Original text, kept for the record below.
  ~~Specified, not implemented. Written 2026-08-29 by step 2 of run
  `872b396a-0672-4e05-a806-e83c4e5c4743` (`spec-to-deploy`), from the brief left by step 1 at
  `.ai/specs/briefs/2026-08-29-step-retry-timing.md`. Nothing below has been built, tested or
  deployed.~~
- **REVISED 2026-08-29 after review**, in the same run. The first draft's design would have
  shipped wrong numbers, and the changes are load-bearing rather than editorial — each is marked
  *"Corrected during review"* in the section it lands in, with the withdrawn claim left visible
  next to it:
  1. §"The retry paths, enumerated" — **nine** paths, not five; six leave an attempt unclosed, not
     three. The two post-condition retries, the human-changes loop-back, the manual-handoff
     requeue and restart re-entry were all missing.
  2. D3 + §"The writer, precisely" — an attempt closes when the step **leaves the active
     statuses**, not merely when the next one starts, which could never arrive.
  3. §"The writer, precisely" — attempt identity is the **iteration transition**, never a
     `startedAt` comparison: two attempts can share a millisecond.
  4. §"The writer, precisely" — an **upgrade boundary**, so a step that was mid-flight when P1
     ships never gains a partial `attempts` array the UI would then believe.
  5. §Data models — **no partial sum is ever displayed as a total**; one unmeasurable interval
     suppresses the whole clock.
  6. §Phases P2 — the live total is `offsetMs + Math.max(0, now - start)`; the missing clamp let
     clock skew shrink already-banked duration.
  7. §Analytics — the event **ships in P3** rather than being deferred, with the `CEZ_ANALYTICS`
     documentation debt paid alongside it.
  8. §Risks R8 — the unmeasured "single digits" claim withdrawn, replaced with the actual absence
     of bounds and the byte arithmetic.
  9. §Verification — the full five-command gate, mandatory **negative controls**, and an E2E
     fixture that `recover()` does not destroy before it can be read.
- **Date:** 2026-08-29
- **Owner instruction, verbatim:** *"if there are multiple retries of workflow step: show time of
  each retry in 'tree UI' and total time as step time (aggregated sum of each retry)."*
- **REVISED A SECOND TIME 2026-08-29 after a second review**, in the same run. Twelve further
  items, each marked *"Corrected during review"* where it lands: the parent spec's R3 must be
  corrected in place (below); the step clock's `title` must stop promising "the current attempt";
  the store clock is injected through `RunStore.open`, not the private constructor; `runId` has to
  be threaded to `StepRail`; analytics goes through the typed `hc` client, not a raw `fetch`; the
  analytics route is **already** in `BACKWARD_COMPATIBILITY.md`; two swapped
  `workflows/types.ts` citations; the withdrawn per-`verify`-entry ledger claim; the withdrawn
  `test:package` flake; four missing negative controls; a corpus-record phase; and two off-by-one
  `run.ts` line numbers.
- **Completes a named, declined gap in:** `.ai/specs/2026-08-20-step-and-tool-call-durations.md`
  (KB `specs-055be85ab716`, status DONE, shipped as `69b4a3de`), whose **Risk R3** deferred
  exactly this.

  **Corrected during review: the earlier claim that "nothing in that spec is superseded" was
  false, and it is the kind of false that survives.** That spec's R3 mitigation cell
  (`.ai/specs/2026-08-20-step-and-tool-call-durations.md:339`) reads, verbatim: *"Cumulative-across-attempts
  would need a new persisted field — out of the web-only class, and not asked for."* Both halves
  stop being true when this ships: the persisted field exists (P1), and it **was** asked for, in
  the owner instruction quoted above. R3 is that spec's own record of why this was declined, so
  leaving it unmarked leaves the next reader a live "not asked for" sitting beside a shipped
  feature — exactly the failure the house "correct in place" rule names.

  **Phase 2 therefore adds a bolded `CORRECTED 2026-08-29` lead-in inside R3's mitigation cell**,
  naming `.ai/specs/2026-08-29-step-retry-timing.md` as what closes the deferral, and leaves the
  original mitigation text below it unchanged. The heading is not amended — the falsehood is in
  the cell, not in the risk's own statement, which is still an accurate description of the
  pre-P1 behaviour. Nothing else in that spec is touched: its R4, R6 and R8 all still hold and
  are carried forward here.
- **"Tree UI"** is the owner's name for the workflow step list on `/tasks/:id`: `StepRail`
  (expanded, one row per step) and `WorkflowSteps` (the collapsed one-line summary), both in
  `packages/web/src/routes/task-thread/step-rail.tsx`. Verified: there is no component named
  "tree" in the cockpit; the only `tree` hits are the unrelated git file tree under
  `routes/task-git/`.
- **A "retry" here is an ITERATION** — `StepState.iterations`
  (`packages/contract/src/runs.ts:69`), the user-visible "this step ran N times" counter rendered
  as `×N`. It is **not** the broker/session-transport relaunch of
  `.ai/specs/2026-08-22-bounded-transient-broker-retry.md`. See D5: those relaunches turn out to
  already *be* iterations, so the two meanings converge rather than needing to be separated.

## TLDR

A step that retried shows a `×3` badge and a clock that reads **attempt 3 only**, because
`run.ts` overwrites `startedAt` on every re-entry. The two hours the first two attempts burned
are unrecoverable from the record — nothing persists them.

Fix it at the store, not at the renderer: `RunStore.updateStep` already sees every `startedAt`
and `finishedAt` patch, so it can accumulate an optional `attempts: [{startedAt, finishedAt?}]`
array on `StepState` with **zero changes to the 50 `updateStep` call sites** in `run.ts`. The web
then sums it: the step clock becomes cumulative on both surfaces, and the `×N` badge becomes a
disclosure that expands into one row per attempt with its own duration.

Three shippable phases: **P1** backend field + single writer (restart-class deploy); **P2**
web-only cumulative clock; **P3** web-only per-attempt breakdown, plus its `step.attempts_expanded`
event and the `CEZ_ANALYTICS` documentation the analytics sink has owed since `abe83105`. Records
written before P1 keep rendering exactly what they render today — no backfill, no invention, and
no partial `attempts` array on a step that was already running when P1 landed.

## Problem

### What the rail shows now

`step-rail.tsx:104-108` — the badge, which is the only surviving trace that a step retried:

```tsx
{step.iterations > 1 ? (
  <span data-slot="step-iterations" className="shrink-0 text-xs text-soft-foreground tabular-nums">
    ×{step.iterations}
  </span>
) : null}
```

It is inert: no click target, no title, no drill-down anywhere in the app. Beside it,
`<StepClock step={step} />` (`step-rail.tsx:113`, defined `:263`) calls `stepElapsed(step, now)`
(`step-timing.ts:38`), which has one `startedAt`/`finishedAt` pair to work with.

### Why the clock is wrong for a retried step

`packages/cezar/src/workflows/run.ts:5756-5766`, the top of `stepLoop`:

```ts
const record = this.store.getRun(runId)?.steps.find((s) => s.id === step.id);
const iteration = (record?.iterations ?? 0) + 1;
this.store.updateRun(runId, { currentStepId: step.id });
this.store.updateStep(runId, step.id, {
  status: 'running',
  iterations: iteration,
  startedAt: new Date().toISOString(),
  error: undefined,
});
emit({ type: 'step-start', stepId: step.id, name: step.name ?? step.id, kind, iteration });
```

`RunStore.updateStep` (`packages/cezar/src/runs/store.ts:981-993`) is `Object.assign(step, patch)`
on the single `StepState` object. The previous attempt's `startedAt` is gone the moment the next
one begins. `finishedAt` is overwritten the same way at each attempt's end (`run.ts:8283-8288` in
`finishStep`, plus `:5197`, `:5218`, `:5223`, and 14 other terminal sites).

`step-timing.ts:34-36` already documents the consequence in code:

> The number is elapsed wall-clock for the CURRENT ATTEMPT. `run.ts` overwrites `startedAt` on
> every retry, so a step wearing an `×3` badge shows attempt 3, not the three summed — cumulative
> cost would need a persisted field that does not exist (spec risk R3).

**That doc comment is correct, and this spec makes the second half of it obsolete rather than
disproving it.** The brief asked whether the NDJSON event log could be mined instead (D1 below
settles it: no).

### The retry paths, enumerated

**Corrected during review: an earlier draft of this section claimed there were exactly five
paths, and there are nine.** It omitted both post-condition retries, the human "request changes"
loop-back, the manual-handoff requeue and restart re-entry — four of which are `finishStep`-less,
which is precisely the shape the writer design has to survive. The list below was re-derived by
reading every `continue` in `stepLoop` and every `reenterChain` caller that rewinds a step.

The one thing all nine share: they re-enter `stepLoop` and land back on `run.ts:5756-5766`, which
takes a fresh `startedAt` and writes `iterations + 1` in the **same patch**. That common landing
is what D2's writer keys on; the differences below are only about what state the *previous*
attempt was left in.

| # | Path | `run.ts` | Leaves the previous attempt… |
| --- | --- | --- | --- |
| 1 | `onFail.retry` loop-back after a **check step failed** | `:6093-6101` (`loopBackTo`, defined `:5679`) | **closed** — `finishStep(… 'failed' …)` at `:6094` |
| 2 | `onFail.retry` loop-back after a reviewer voted **revise** | `:5981-5996` | **closed** — `finishStep(… 'done' …)` at `:5985` |
| 3 | `onFail.retry` loop-back after a **human requested changes** at the approval gate | `:6015-6027` | **closed** — `finishStep(… 'done' …)` at `:6018` |
| 4 | **Agent** step whose **post-condition** failed, retried | `:5961-5966` → `retryAfterFailedPostcondition` `:8212`, which patches `{status:'pending'}` at `:8230` | **open** |
| 5 | **Check** step whose **post-condition** failed, retried | `:6076-6077` → the same helper, the same `:8230` patch | **open** |
| 6 | Re-entry after cezar **stopped** the step (`resumedAfterStop`) | `:5853` patches `{status:'pending'}`, `continue` at `:5860` | **open** |
| 7 | Re-entry after a **missing-session** resume rejection | `:5887` patches `{status:'pending'}`, `continue` at `:5901` | **open** |
| 8 | Re-entry after a **cold broker** never answered | `:5910-5914` patches `{status:'pending'}`, `continue` at `:5931` | **open** |
| 9 | **Manual-handoff requeue** and **restart / chain re-entry** | `requeueHandoff` `:6630-6636` (patches `{status:'pending', error:undefined, finishedAt:undefined}` at `:6631`, then `reenterChain(…, {resetTo})` at `:6632`); `recover()` `:2338` → `reenterChain` `:2898`, whose `resetTo` branch rewinds steps to `pending` | **open, and explicitly un-closed** |

Rows 4-9 leave an attempt with no `finishedAt` and then open the next one. **Six of the nine, not
three** — including the two post-condition retries, which are the paths `spec-to-deploy` itself
takes most often (`everything-committed`, `tested-revision-shipped`, `all-services-deployed`
post-conditions, `workflows/types.ts:1432`, `:1465`, `:1581`). Any design that assumes attempts
are always explicitly closed is wrong on two thirds of the engine's retry surface. D3 handles it.

Two details from row 9 that the writer must not trip on:

- `requeueHandoff` patches `finishedAt: undefined` — the key is *present* and the value is not a
  string. The close rule keys on `typeof patch.finishedAt === 'string'`, so this patch clears the
  step's latest-attempt timestamp without closing anything on that value. The status rule (D3)
  is what closes it.
- `loopBackTo` (`:5684-5686`) resets **every** step from the retry target through the failing
  step to `pending`, including steps whose attempts are already closed. Closing on a status
  transition must therefore be a no-op when nothing is open.

One more writer worth naming: `loopBackTo` (`:5679-5688`) resets every step from the retry target
through the failing step to `status: 'pending'` and **leaves their timestamps intact**. Today
that makes their clocks vanish (`stepElapsed` returns `undefined` for `pending`); after this
change, a step reset to `pending` mid-run still has recorded attempts and should still show what
they cost. See D4.

### What is NOT the problem

- **Continuations.** `runContinuation` (`run.ts:4785-4791`) writes `iterations: 1` unconditionally,
  but every continuation is a *new* step: `continue-${continuations + 1}`, minted by
  `store.addStep` at `run.ts:4539`. It never resets a real step's counter. Checked directly.
- **A missing rendering surface.** `RunRecord.steps` already reaches the rail through
  `run-header.tsx:294` → `<WorkflowSteps steps={run.steps} …/>`, on every `run` SSE frame. A new
  field on `StepState` arrives at the renderer with no plumbing at all.

## Solution

Six decisions.

### D1 — Persist it. Do not derive it from the event log.

The brief's open question 1, settled against the code: **the transcript cannot answer this in the
browser.**

The data is genuinely there on disk — `step-start` carries `iteration`, and `appendEvent`
(`store.ts:1151-1157`) stamps every event with `ts` — and the event schema is deliberately open to
it (`packages/contract/src/events.ts:22-27`). That is the trick
`.ai/specs/2026-08-20-step-and-tool-call-durations.md` used for tool-call chips. It does not
transfer here, for three independent reasons:

1. **The browser does not hold the events.** History is bounded:
   `packages/web/src/api/run-history.ts:10` sets `MAX_HISTORY_PAGES = 5`, and a page is
   `RUN_HISTORY_PAGE_ITEMS = 100` (`contract/src/events.ts:29`) — at most ~500 of the newest
   events are retained, reverse-paged. On a long run, attempt 1's `step-start` is simply not in
   the client. That is the same hazard the durations spec already wrote a rule for
   ("A start is only ever taken from a frame that opens an item"), and here it would silently
   *undercount a total*, which is worse than an absent chip.
2. **The rail is not fed from events at all.** It reads the `RunRecord` snapshot;
   `thread-state.ts:701-707` lists `step-start` in the deliberate no-op sweep, with the comment
   at `:693` naming `step-rail.tsx` as the steps surface. Feeding it events would mean threading
   `history.visibleEvents` from `task-thread.tsx` into `run-header.tsx` — a real architectural
   change to buy worse data.
3. **The tasks table has no transcript.** `RunRecord` is what the workspace runs index serves. A
   derivation that only works on `/tasks/:id` cannot ever be reused.

Server-side derivation-on-read (parse the NDJSON per record read) is rejected too: `listRuns` is
served from memory and the index is read on every workspace poll; re-parsing every run's
transcript to answer it is not a trade worth making for a timing display.

**So: an additive optional persisted field.** This moves P1 out of the web-only hot-swap deploy
class into the restart class (`AGENTS.md` §"Always self-deploy", as corrected 2026-08-24 —
a deploy of cezar on this box is manual). P2 and P3 stay web-only. That cost is named, not hidden;
it is the price of the only design that is correct on a long run.

### D2 — `RunStore.updateStep` is the single writer. `run.ts` changes not at all.

`updateStep` already receives every `startedAt` and `finishedAt` patch a step ever gets — there
are exactly **three** `startedAt` writers (`run.ts:4788`, `:5763`, and the run-level `:5453` which
is `updateRun`, not a step) and ~17 `finishedAt` writers, and all of them go through this one
function. So the accumulation belongs there:

```
patch carries a `finishedAt` string        → close the open attempt with it
patch moves the step OUT of the active set → close the open attempt at the store clock
patch carries an ITERATION INCREMENT       → close anything still open, then push a new attempt
```

All three rules are evaluated **before** the `Object.assign`, following the precedent already in
this function for `contextWindow` (`store.ts:986-990`: *"Captured BEFORE the merge below"*).

Why not at the call sites: 50 `updateStep` calls in `run.ts`, across the **nine** retry paths
enumerated above, of which six close nothing. Every one of them would be a place to forget. The
store sees all of them by construction. The exact rules are in §"The writer, precisely".

`attempts` is **store-owned**: the signature narrows to
`Partial<Omit<StepState, 'id' | 'attempts'>>`, so a caller writing it is a typecheck failure
rather than a silent corruption.

### D3 — An attempt closes when the step leaves the active statuses, not when the next one starts.

**Corrected during review.** This decision originally read *"an attempt cezar never closed ends
when the next one begins"*, and closure-on-next-start alone is not safe: six of the nine retry
paths patch `{status:'pending'}` and then `continue`, and the very next thing `stepLoop` does at
the top of the iteration is the **budget check** (`run.ts:5750-5753`), which `break`s the loop
when `stepBudget` is spent. A step can therefore go `running → pending → run over` with **no next
start ever arriving**, leaving an attempt permanently open — no `finishedAt`, no successor to
borrow one from. Cancellation (`state.cancelled`, checked at `:5960`, `:6069` and elsewhere) and
the manual-handoff requeue (row 9) reach the same shape.

So the primary rule is a **status transition**, which every one of those paths does emit:

> When a patch moves the step **out of** the active status set (`running` / `waiting` / `review`)
> and an attempt is open, close it — at `patch.finishedAt` when the patch supplies one, and at
> the store's own clock (`new Date().toISOString()`) when it does not.

That covers `finishStep` (rows 1-3, which supply `finishedAt`), every `{status:'pending'}` retry
patch (rows 4-9, which do not), cancellation, and `recover()`'s settle sweep. The store owns a
clock read here, which is a deliberate exception to its otherwise-pure `updateStep`: the
alternative is a permanently-open attempt, and §Data models makes an unmeasurable interval
suppress the whole total, so one open attempt would silently blank a retried step's clock.

**Closure-at-next-start is kept, as a fallback only.** If a start patch arrives while an attempt
is still open — a status transition the store never saw, e.g. a record restored from a file
written by an older build — that attempt is closed at the new attempt's `startedAt` before the
new one is pushed. It should be unreachable after P1; it is retained because the failure it
prevents (one open attempt suppressing a whole step's total) is worse than the imprecision it
introduces.

Rejected alternative: leave an unclosed attempt open and exclude it from the sum. That undercounts
by an entire attempt, and §Data models rules that a partial sum must never be displayed as a
total — so the honest version of that alternative shows *nothing*, on the commonest retry shape
in the engine.

The one case where this is a real overcount is a cezar restart mid-attempt: the downtime lands
inside that attempt. It is recorded as **R2** rather than fixed, because it is exactly what the
live clock does today (a `running` step whose process died keeps ticking until reconcile), so it
introduces no *new* dishonesty — and because there is nothing to anchor a better answer on:
`RunRecord` has `createdAt` / `startedAt` / `finishedAt` / `seenAt` / `archivedAt` and **no
last-seen-alive timestamp** (`store.ts:368-370`, `:560`, `:566`; `touch()` at `:1449` only
schedules a save and emits — it stamps nothing). Deferred to Phase 4.

### D4 — `stepElapsed` becomes cumulative; the surfaces do not choose.

`stepElapsed` (`step-timing.ts:38`) is already the single function both `StepRail` rows and the
collapsed `WorkflowSteps` summary call. Changing *it* fixes both, and keeps its documented
contract intact: `undefined` still means render nothing, `live` still means hand the tick to a
`<LiveDuration/>` leaf.

Its meaning changes from "the current attempt" to "every recorded attempt, summed" — which is the
bug being fixed. Its doc comment's `R3` paragraph is rewritten in the same edit, per the
"correct in place" rule; the old sentence must not survive as a description of behaviour that no
longer exists.

**The tooltip has to change with the number, and it is not one string but two.** *Corrected
during review: the previous draft changed the clock's meaning and left its own label contradicting
it.* `STEP_CLOCK_TITLE` (`step-rail.tsx:249`) reads *"Elapsed since this step started (the current
attempt)."*, it is applied to **both** branches of `StepClock` (`:268` live, `:274` frozen), and
`step-rail.test.tsx:406` pins it with `toMatch(/current attempt/i)`. That sentence is the parent
durations spec's own R3/R4 mitigation — the rule there is that *"the clock's `title` says what
interval it measures"* — so shipping a cumulative number under it would not merely leave a stale
string, it would break the invariant the string exists to hold.

Because the fallback survives, **the promise is now record-dependent and the title must be too.**
Phase 2 replaces the single constant with a function of the same fact `stepElapsed` switches on —
the presence of `attempts`:

| Record | Title |
| --- | --- |
| `attempts` present (post-P1) | *"Total elapsed across all N attempts at this step."* |
| `attempts` absent (pre-P1, and the mid-flight upgrade case) | **unchanged** — *"Elapsed since this step started (the current attempt)."* |

The old constant therefore stays in the file rather than being deleted: it is still the honest
label for every record written before P1, and those records render forever. A single title, either
way round, would be a lie on half the board. Both cases are asserted in Verification 4, and the
existing `:406` assertion keeps passing unmodified on a no-`attempts` fixture — which is the
cheapest available proof that the fallback path was not disturbed.

Whenever `attempts` is absent, it falls back to **exactly today's math**. That covers both cases
the upgrade boundary produces: a record written entirely before P1, and a step that was already
mid-flight (`iterations > 0`) when P1 landed, which never gains the field at all. Old runs keep
rendering what they render now. No backfill; the timestamps a backfill would need were overwritten
and are gone.

The corollary matters for reading the code: **presence of `attempts` is the switch**, and the
web prefers the array unconditionally when it is there. That is exactly why the writer must never
create a partial one — a two-element array on a step that ran five times would be believed.

Two consequences worth stating:

- **The collapsed summary's number changes meaning.** `WorkflowSteps` shows the current step's
  clock (`step-rail.tsx:393`); for a retrying step it starts reading the cumulative total. That is
  the ask, applied at the surface the owner sees most.
- **A step reset to `pending` by `loopBackTo` gets its clock back.** Today `undefined`; after P2,
  it shows what its attempts cost so far. `live: false` — it is not running.

### D5 — Every iteration is shown. No filtering.

The brief's open question 5. Measured, not assumed: the broker-relaunch and missing-session
re-entries `continue` with the same `i` (`run.ts:5900`, `:5931`), so they land on `:5757` and
**already increment `iterations`** — the `×N` badge counts them today. Filtering them out of the
breakdown would make the list shorter than the badge, which is a defect, not a nicety.

This makes `attempts.length === iterations` an invariant — **qualified**, per the upgrade boundary
in §"The writer, precisely": it holds for every step whose *first* `startedAt` was written after
P1, and it is worth a test (Verification 3). Known divergences, all three deliberate: a record
written before P1 has no `attempts` at all; a step that was mid-flight (`iterations > 0`) when P1
landed **never** gains the field, so the invariant is vacuous rather than violated there; and a
`check` step that never spawned an agent still gets one attempt per entry, which is correct.

Per-attempt **outcome** (which attempt failed, which was stopped) is deliberately out of scope —
see §Out of scope.

### D6 — The breakdown lives in the expanded rail only; the summary stays terse.

The brief's open questions 2 and 4. The `×N` badge becomes the disclosure — it is already the
"this retried" affordance, it is already where a reader's eye goes, and making the existing inert
mark do the obvious thing beats inventing a second control. Expanding it inserts one indented row
per attempt directly under that step's row.

`WorkflowSteps`'s collapsed trigger gets **nothing new**, per the precedent its own comment sets
(`step-rail.tsx:388-390`: *"Current step only — one chip per dot would drown the summary line the
dots exist to keep terse"*). The reader expands the rail; the rail has the detail.

## Architecture

```
run.ts  (unchanged — 50 call sites, 0 edits)
   │  updateStep({ startedAt })            updateStep({ status, finishedAt })
   ▼
RunStore.updateStep  ── accumulates ──►  StepState.attempts[]  ──► runs.json
   │                                                             └─► `run` SSE frame
   ▼
RunRecord.steps ─► run-header.tsx ─► WorkflowSteps ─► StepRail
                                          │              │
                                          │              ├─ StepRow (new): ×N disclosure
                                          │              │     └─ StepAttempts (new)
                                          │              │           └─ <LiveDuration/> leaf
                                          └──────────────┴─ StepClock ─► stepElapsed(step, now)
                                                                          └─ live → <LiveDuration
                                                                               since offsetMs/>
```

| File | Change | Phase |
| --- | --- | --- |
| `packages/contract/src/runs.ts` | **new** `stepAttemptSchema`; optional `attempts` on `stepStateSchema` (after `finishedAt`, `:88-89`) | 1 |
| `packages/cezar/src/runs/store.ts` | mirror the field on the local `stepStateSchema` (`:65-131`); accumulate in `updateStep` (`:981`); narrow the patch type | 1 |
| `packages/cezar/src/runs/store.test.ts` | attempt-accumulation cases | 1 |
| `packages/cezar/src/workflows/run.test.ts` | end-to-end: a looped-back run records one attempt per iteration | 1 |
| `packages/web/src/components/live-duration.tsx` | additive optional `offsetMs?: number` (default 0); the live term gains the `Math.max(0, …)` clamp | 2 |
| `packages/web/src/components/live-duration.test.tsx` | **new file** — the component has no direct test today; fixed-clock coverage of `offsetMs` | 2 |
| `packages/web/src/routes/task-thread/step-timing.ts` | `stepElapsed` sums attempts and returns `since`/`offsetMs`; **new** `stepAttempts`; R3 doc comment rewritten in place | 2 |
| `packages/web/src/routes/task-thread/step-timing.test.ts` | cumulative, live-with-offset, fallback and degradation cases | 2 |
| `packages/web/src/routes/task-thread/step-rail.tsx` | `StepClock` passes the offset; the clock `title` becomes record-dependent (D4); `WorkflowSteps` threads `runId` into `StepRail`; extract `StepRow`; `×N` becomes a disclosure; **new** `StepAttempts` | 2, 3 |
| `packages/web/src/routes/task-thread/step-rail.test.tsx` | both `title` cases (D4); disclosure + breakdown rendering; the `step.attempts_expanded` emit with its `runId` | 2, 3 |
| `.ai/specs/2026-08-20-step-and-tool-call-durations.md` | in-place bolded `CORRECTED 2026-08-29` lead-in inside **R3's mitigation cell** (`:339`), naming this spec as what closes the deferral; original text preserved below it | 2 |
| `packages/web/src/api/client.ts` | **new** `postAnalyticsEvents(events)` — the typed `hc` wrapper `.ai/specs/2026-08-26-filed-task-detail-page.md:507-509` specifies and nobody wrote, deliberately **without** `unwrap` | 3 |
| `packages/web/src/lib/analytics.ts` | **new** fail-open `track(name, props)` — delegates to `postAnalyticsEvents` and swallows the rejection | 3 |
| `packages/web/src/lib/analytics.test.ts` | **new** — delivery shape, and that a rejecting and a `500`-resolving transport are both swallowed | 3 |
| `BACKWARD_COMPATIBILITY.md` | §3 bullet for the additive `attempts` field (P1); **§1 only** for `CEZ_ANALYTICS` (P3). **The analytics ROUTE is already inventoried at `:78` (`a04cda25`) — do not re-add it to §2** | 1, 3 |
| `.env.example`, `README.md` | `CEZ_ANALYTICS` — the doc debt `AGENTS.md:31` requires and `abe83105` never paid | 3 |
| `.ai/specs/2026-08-26-filed-task-detail-page.md` | in-place `CORRECTED` lead-in on its "no caller" / "doc surfaces did not land" Status claims (`:1-18`) | 3 |
| `$CEZ_KB_WRITE_FILE` (`.ai/cezar/runs/<task>.knowledge.ndjson`) | changelog + decision proposals, then `cez kb search` for their exact titles (Phase 5) | 5 |

Nothing is added to `packages/api-client/src` — it re-exports the contract wholesale
(`api-client/src/index.ts:27`), so `StepState` in the web widens automatically, and
`server/api-types.test.ts` keeps the mirror pinned.

**The tick stays in leaves.** `design-guardian.test.ts`'s `no-tick-in-thread-containers` rule
already covers `step-rail.tsx` (`:113-119`), so no `useNow` may enter that file. `StepRow`'s
expansion state is `useState`, which the rule does not and should not cover. The live attempt row
and the live total both render `<LiveDuration/>`. The guardian rule needs **no widening** for this
spec — the files it already names are the files being touched.

## Data models

### Contract — `packages/contract/src/runs.ts`

```ts
/** One ATTEMPT at a workflow step — the timing half of `iterations` (spec
 *  2026-08-29-step-retry-timing). Written only by `RunStore.updateStep`, which is the one
 *  function that sees every `startedAt`/`finishedAt` patch a step ever gets. */
export const stepAttemptSchema = z.object({
  /** ISO instant this attempt was entered — the `startedAt` that used to be overwritten. */
  startedAt: z.string(),
  /** ISO instant it ended. Absent while the attempt is in flight; also absent, briefly, for an
   *  attempt a crash interrupted before the next one opened (risk R2). */
  finishedAt: z.string().optional(),
});
export type StepAttempt = z.infer<typeof stepAttemptSchema>;
```

and, on `stepStateSchema`, immediately after `finishedAt`:

```ts
  /** Every attempt at this step, oldest first — `startedAt`/`finishedAt` above hold only the
   *  LATEST one, which is why a retried step's clock used to read attempt N rather than the sum
   *  (spec 2026-08-20-step-and-tool-call-durations risk R3). `attempts.length` equals
   *  `iterations` for every step whose FIRST `startedAt` was written under spec
   *  2026-08-29-step-retry-timing. ABSENT, and PERMANENTLY absent, otherwise: a record written
   *  before that spec, and a step that was already mid-flight (`iterations > 0`) when it landed,
   *  both keep this field unset for life, because a partial array would read as authoritative
   *  and silently omit every earlier attempt. The cockpit reads absent as "fall back to the
   *  single startedAt/finishedAt pair", never as zero attempts. There is no backfill: the
   *  timestamps one would need were overwritten and are gone. Written only by
   *  `RunStore.updateStep`, keyed on the ITERATION increment — never on a `startedAt` comparison,
   *  since two attempts can share a millisecond. Starts are nondecreasing, not strictly
   *  increasing. */
  attempts: z.array(stepAttemptSchema).optional(),
```

`packages/cezar/src/runs/store.ts` carries its own copy of `stepStateSchema` (`:65`); the field is
mirrored there with a one-line comment pointing at the contract, matching how `contextTokens` and
`nameOrigin` are already documented across the pair.

**Compatibility (`BACKWARD_COMPATIBILITY.md` §3, `runs.json`).** Additive and optional, so
pre-existing records `safeParse` unchanged — the required-field trap §3 warns about does not
apply. A consumer that ignores `attempts` reads exactly the pre-existing shape, and
`startedAt`/`finishedAt` keep their current meaning (the latest attempt) rather than being
repurposed. **Growth is genuinely unbounded** — neither `onFail.max` (`workflows/types.ts:95`) nor
a post-condition's `verify … max` (`workflows/types.ts:9`) carries an upper bound, and
`stepBudget` defaults to unlimited — and no cap is imposed here, because a cap would silently drop
the oldest attempt from a sum that claims to be a total. (*Corrected during review: those two
citations were swapped in the previous draft. `verify`'s `max` is at line 9, inside
`verifyEntrySchema`; `onFail.max` is at line 95, inside the step schema. R8 carried the same swap
and is corrected there too.*) R8 shows the byte arithmetic that makes that affordable, and withdraws the earlier
draft's unmeasured claim that real runs hold single digits.

### The writer, precisely

**Rewritten during review.** Three defects in the first draft, each of which would have shipped a
wrong number: an attempt could be left permanently open, two attempts could be collapsed into one
by a millisecond collision, and a pre-P1 step could acquire a partial `attempts` array that the UI
would then prefer over the truth. Each is fixed below and each has a named regression test.

Inside `updateStep`, before `Object.assign`:

```
ACTIVE := { 'running', 'waiting', 'review' }        // the store's own copy; see the note below

prevIterations := step.iterations                   // all three captured BEFORE the merge
prevStatus     := step.status
open()         := last element of step.attempts with no finishedAt, else none

// (1) explicit close — `finishStep` and every other terminal patch
if typeof patch.finishedAt === 'string' and open() exists:
    open().finishedAt := patch.finishedAt

// (2) implicit close — the step left the active set with nothing to close on   [D3]
if typeof patch.status === 'string'
   and ACTIVE.has(prevStatus) and not ACTIVE.has(patch.status)
   and open() exists:
    open().finishedAt := new Date().toISOString()

// (3) a NEW attempt is an ITERATION INCREMENT, never a timestamp comparison
if typeof patch.iterations === 'number' and patch.iterations > prevIterations
   and typeof patch.startedAt === 'string':
    if prevIterations === 0 or step.attempts !== undefined:              // the upgrade boundary
        if open() exists: open().finishedAt := patch.startedAt           // fallback close
        step.attempts := (step.attempts ?? []) ++ [{ startedAt: patch.startedAt }]
```

Order matters and is fixed: (1), then (2), then (3). A patch carrying `finishedAt` and a status
exit together (`finishStep` does exactly this) closes on the explicit timestamp and rule (2) then
finds nothing open, so the two never fight.

**Rule (2) reads the clock, and the store is otherwise pure.** That is a deliberate, named
exception. The alternative — leave it open and hope a next start arrives — is the defect this
rule exists to fix: `stepLoop`'s budget check (`run.ts:5750-5753`), a cancellation, and
`requeueHandoff` (`:6630`) can all end a run between the `{status:'pending'}` patch and the next
start, and §Data models makes one unmeasurable interval suppress the step's entire total. A
permanently-open attempt would therefore blank a retried step's clock rather than merely lose a
row.

`updateStep` has no injected clock today; the implementation adds one, **and the seam is
`RunStore.open`, not the constructor.** *Corrected during review: the previous draft said the
clock was "overridable in the constructor", which is not something a test can reach.* `RunStore`'s
constructor is **private** — `private constructor(private readonly dataDir: string)`
(`store.ts:783`) — and every caller, production and test alike, goes through the static factory
`RunStore.open(dataDir, opts?: { keepLive?: boolean })` (`store.ts:789`). A constructor-only
override would compile and be untestable, leaving Verification 1's rule-(2) cases racing the wall
clock, which is the exact thing the injection exists to prevent.

So:

- the private constructor takes a second parameter,
  `private readonly now: () => string = () => new Date().toISOString()`;
- `RunStore.open`'s existing options object gains `now?: () => string` and forwards it through;
- omitting it — which every production call site does, unchanged — yields the real clock, so the
  change is additive and invisible outside tests.

Rule (2) calls `this.now()` rather than `new Date().toISOString()` directly. Verification 1 opens
its store as `RunStore.open(dir, { now: () => FIXED })` and asserts that exact value; no test
reaches the private constructor, and none needs to.

**A new attempt is identified by the iteration transition, never by `patch.startedAt !==
step.startedAt`.** `run.ts:5760-5765` sends `iterations` and `startedAt` in the **same patch**, so
the transition is always available; and the timestamp comparison is unsafe, because
`new Date().toISOString()` has millisecond resolution and two iterations of a fast-failing step
can legitimately land on the same millisecond — a cold-broker relaunch (row 8) does almost nothing
between the failure and the next start. On a collision the timestamp test is false, no attempt is
pushed, and the step silently records N-1 attempts for N iterations. **Attempt `startedAt` values
are therefore nondecreasing, not strictly increasing**, and no test may assert otherwise.

The same rule makes replay safe for free: `recover()` and any idempotent re-patch write the *same*
`iterations`, which is not an increment, so nothing is minted.

**The upgrade boundary** — the `prevIterations === 0 or step.attempts !== undefined` guard in
rule (3). Without it, a run that was mid-flight when P1 shipped behaves like this: the step has
`iterations: 4` and no `attempts`; its fifth attempt appends a **one-element** array; the UI (which
prefers `attempts` whenever the array is present) then reports attempt 5's duration as the total
for a step that ran five times, and shows one breakdown row under an `×5` badge. That is worse
than the bug being fixed, because it *looks* authoritative. The guard makes it impossible:

- a step with `iterations: 0` may initialize `attempts` (a step created by `addStep`
  (`store.ts:972-979`) with `iterations: 0` and no `attempts` key, and a pre-P1 step that was
  never started, are the same shape — both are correct from attempt 1 onward);
- a step with `iterations > 0` and `attempts === undefined` **never gains the field**, on any
  later patch, for the life of that record. It renders exactly as it does today, forever;
- a step that already has `attempts` keeps accumulating normally.

There is no backfill and no `attempts: []` sentinel — an empty array and an absent field would
have to mean different things, and one of the two would eventually be written by accident.

**So the `attempts.length === iterations` invariant is qualified**, and D5's statement of it is
qualified in the same way: it holds for every step whose **first** `startedAt` was written after
P1. It does not hold, and must not be asserted, for a step that already had `iterations > 0` when
P1 landed — there `attempts` is absent, which the UI reads as "fall back to today's math".

### Web-local derivations — `step-timing.ts`

```ts
export interface StepElapsed {
  /** Total ms across every recorded attempt, including the live one measured at `now`. */
  ms: number
  live: boolean
  /** Live only: the ISO instant the ticking leaf counts from (the open attempt's start). */
  since?: string
  /** Live only: ms already banked by the closed attempts, added on top of the leaf's tick. */
  offsetMs?: number
}

export interface StepAttemptElapsed {
  /** 1-based, matching the `iteration` the engine emits on `step-start`. */
  index: number
  startedAt: string
  /** `undefined` = UNMEASURABLE — unparseable timestamps, or an attempt left open with no honest
   *  end (the pending-plus-open case below). Render an em-space, never `NaN:0-3`. The same
   *  condition makes `stepElapsed` return `undefined` for the whole step: the row still appears,
   *  the total does not. */
  ms: number | undefined
  live: boolean
}

export function stepElapsed(step: StepState, now: number): StepElapsed | undefined
export function stepAttempts(step: StepState, now: number): StepAttemptElapsed[]
```

**A partial sum is never displayed as a total.** Corrected during review: the first draft had an
invalid attempt contribute `0` and a terminal-with-open attempt silently dropped from the sum,
which contradicts both the parent rule (R6, *render nothing over render a lie*) and D1's own
argument for rejecting the event log — that **silently undercounting a total is worse than
having no number**. A total that quietly omits an attempt is exactly the failure D1 refused to
ship. So:

> If **any** attempt's interval is unmeasurable, `stepElapsed` returns `undefined` and the step
> renders no clock at all. `stepAttempts` still returns every row, with `ms: undefined` on the
> unmeasurable ones — the breakdown is where the reader sees *which* attempt lost its timing, and
> a blank duration on one row is honest in a way that a confident wrong total is not.

An attempt is **measurable** when its `startedAt` parses and it has a parseable end — its own
`finishedAt`, or (for the single live attempt of an ACTIVE step) `now`, or (for the last attempt
of a TERMINAL step that was left open) `step.finishedAt`.

`stepElapsed` rules, in order, all total:

| Case | Result |
| --- | --- |
| `attempts` absent or empty | **today's math, unchanged** (`step-timing.ts:39-47`) |
| **any** attempt unmeasurable, in any status | `undefined` — render nothing |
| status ACTIVE, last attempt open, all earlier closed | `ms` = Σ closed + `max(0, now − lastStart)`; `live: true`; `since` = last start; `offsetMs` = Σ closed |
| status ACTIVE, last attempt closed (unexpected) | `ms` = Σ all; `live: false` |
| status TERMINAL, last attempt open, `step.finishedAt` parseable | close it at `step.finishedAt`; `ms` = Σ all; `live: false` |
| status TERMINAL, last attempt open, `step.finishedAt` absent/unparseable | `undefined` — the interval is unmeasurable |
| status TERMINAL or `pending`, all closed | `ms` = Σ all; `live: false` |
| **`pending` (or any non-active, non-terminal status) with an OPEN last attempt** | `undefined` — see below |

**The pending-plus-open case**, which the first draft did not define at all. After P1 it should
not occur: D3's rule (2) closes the attempt on the `running → pending` transition. It can still
be read from a record written by an older build, or from one whose process died between the two
patches. There is nothing honest to close it at — the step is not running, so `now` is not an end,
and `step.finishedAt` belongs to a previous attempt — so the total is `undefined` and the
breakdown row shows a blank duration with `live: false`. This is also why D3 closes on the status
transition rather than waiting for a next start: without rule (2) this case would be the *common*
one, and every retried step's clock would go blank.

Each measurable attempt contributes `max(0, end − start)`, which is the clamp `step-timing.ts:44`
and `:47` already apply — a clock behind the server never counts backwards.

`stepAttempts` returns `[]` when `attempts` is absent — which is what keeps the `×N` badge on a
pre-P1 record an inert `<span>`, exactly as it is today, instead of a button that expands into
nothing.

## API contracts

**No new route. No changed route.** `attempts` rides existing responses because it is part of
`StepState`:

- `GET /api/v1/runs/:id` and the workspace runs index — widened response, additively.
- The `run` SSE frame — the record the rail already re-renders from.

`packages/cezar/src/server/contract-parity.runs.test.ts` and `api-types.test.ts` cover the
widening with no new assertions authored by hand; both will fail if the contract schema and the
server's declaration disagree, which is the check that matters.

## Phases

Each phase is independently shippable and independently useful. P1 must land first — P2 has
nothing to read without it.

### Phase 1 — persist the attempts (backend; restart-class deploy)

1. `stepAttemptSchema` + optional `attempts` in `packages/contract/src/runs.ts`.
2. Mirror it on `store.ts`'s `stepStateSchema`.
3. Accumulate in `updateStep` per §"The writer, precisely"; narrow the patch type to
   `Partial<Omit<StepState, 'id' | 'attempts'>>`.
4. Store unit tests (Verification 1) and the engine test (Verification 3).
5. One `BACKWARD_COMPATIBILITY.md` §3 bullet.

Ships alone with **no visible change**: records begin accumulating the truth that the UI phases
need. Shipping it early is worth doing on its own — every run between P1 and P3 becomes
retroactively readable.

### Phase 2 — the clock becomes cumulative (web-only)

1. `offsetMs?: number` on `LiveDuration` (default `0`); render
   **`format(offsetMs + Math.max(0, now - start))`**.

   **Corrected during review: the clamp is not optional and it goes INSIDE.** The draft said
   `format(offsetMs + (now − start))`, which lets a browser clock behind the server's produce a
   negative live term that *subtracts from already-banked duration* — a three-attempt step whose
   first two took 15 minutes would render less than 15 minutes, i.e. a cumulative total that goes
   backwards as it ticks. `Math.max(0, …)` must wrap the live term alone, not the sum: clamping
   the sum instead would hide the same skew while still under-reporting. This is the identical
   clamp `step-timing.ts:44` and `:47` already apply, moved to where the addition happens.

   The existing behaviour is preserved exactly for every current caller, because `offsetMs`
   defaults to `0` and `Math.max(0, now - start)` equals `now - start` whenever the current code
   was correct. The `if (!since) return null` and `Number.isNaN(start)` guards
   (`live-duration.tsx:41-43`) are untouched — `offsetMs` never rescues a missing `since`, since
   a step with banked attempts and no open one is not `live` and never reaches this leaf.
2. `stepElapsed` per §Data models; rewrite its R3 doc paragraph in place.
3. `StepClock` (`step-rail.tsx:263`) passes `since`/`offsetMs` to the live leaf; the frozen branch
   is unchanged apart from reading the new `ms`. **The `title` becomes record-dependent** per D4 —
   the cumulative sentence when `attempts` is present, `STEP_CLOCK_TITLE`'s existing
   current-attempt sentence (`step-rail.tsx:249`) when it is not. The constant is kept, not
   deleted: it is still the honest label for every pre-P1 record.
   **3a. Correct the parent spec in place.** Add a bolded `CORRECTED 2026-08-29` lead-in inside
   Risk **R3's mitigation cell** in `.ai/specs/2026-08-20-step-and-tool-call-durations.md:339`,
   naming this spec as what closes the deferral, with the original *"would need a new persisted
   field … not asked for"* text preserved unchanged below it. The heading is not amended — the
   falsehood is in the cell. This lands **in Phase 2's commit, inside the tested tree**, not in a
   later record phase, for the same reason every other in-place correction does: a record edit
   made after the commit is either lost or forces a second one. Nothing else in that spec is
   touched.
4. **New `packages/web/src/components/live-duration.test.tsx`.** `LiveDuration` has no component
   test today — it is exercised only indirectly through `run-header.test.tsx`,
   `thread-items.test.tsx` and `step-rail.test.tsx`, none of which would notice a wrong
   `offsetMs`. Adding a prop with no direct coverage is how the skew above ships unnoticed. Pin
   the clock with `vi.useFakeTimers()` + `vi.setSystemTime()`, the precedent
   `packages/web/src/lib/use-now.test.tsx` already sets for this component's `useNow(1000)`.
5. Tests (Verification 2).

Visible result: both the expanded row and the collapsed summary report the sum. This alone
satisfies the second half of the owner's ask ("total time as step time").

### Phase 3 — the per-attempt breakdown (web-only)

1. Extract the `StepRail` map body into a `StepRow` component (it needs `useState` for expansion;
   the rail must stay a pure map).
   **1a. Thread `runId` down to the row, because it does not reach there today.** *Corrected
   during review: step 4 below requires `runId` on the event, and `StepRail` has no such prop.*
   Its current signature is exactly `{ steps, planned, runRunner }` (`step-rail.tsx:77-85`).
   `WorkflowSteps`, one component above it, **already takes `runId`** (`:354-361`) — it uses it to
   key the `openByRun` map — and it is the only caller that renders the expanded rail. So the
   whole propagation path is three additive props, no new data fetch and no context:

   `WorkflowSteps({ runId, … })` → `<StepRail runId={runId} …/>` → `<StepRow runId={runId} …/>` →
   `track('step.attempts_expanded', { runId, stepId, iterations })`.

   `runId` is **required** on `StepRail`, not optional. An optional prop would let the event ship
   `undefined` and make the analytics silently unattributable — the failure mode that is
   indistinguishable from working. That makes it a compile-time change at every direct call site,
   which is the point: `npm run typecheck` names them. **`step-rail.test.tsx` renders `StepRail`
   directly in several cases** (e.g. `:399-405`), so each such render gains an explicit
   `runId="run-1"`-style value, and Verification 4a asserts **that exact string** in the emitted
   event rather than merely asserting a string is present.
2. `×N` becomes a `<button data-slot="step-iterations" aria-expanded={…}>` — the text stays
   `×{iterations}`, so the existing assertion at `step-rail.test.tsx:88-91` holds. It is a button
   only when `stepAttempts(step, now).length > 1`; otherwise the current inert `<span>`.
3. New `StepAttempts` list, rendered under the row when expanded:
   `data-slot="step-attempts"`, one `data-slot="step-attempt"` per attempt, reading
   `attempt 1 · 4:12` / `attempt 3 · 2:40` with the open one as a `<LiveDuration/>`. Muted,
   indented to the row's text column, `tabular-nums`. An unmeasurable attempt renders an em-space
   where its duration would be, never `NaN:0-3` (R6).
4. **Analytics** (§Analytics), **two files**: `postAnalyticsEvents(events)` in
   `packages/web/src/api/client.ts` — the typed `hc` wrapper
   `.ai/specs/2026-08-26-filed-task-detail-page.md:507-509` specifies, without `unwrap` — and a
   new `packages/web/src/lib/analytics.ts` whose `track()` delegates to it and swallows the
   rejection. `step.attempts_expanded` with `{ runId, stepId, iterations }`, emitted on the
   closed → open transition only. *Corrected during review: the previous draft had `analytics.ts`
   issue a raw `fetch`, bypassing the typed client and contradicting that spec.*
5. **The `CEZ_ANALYTICS` documentation debt**, in the same commit as its first caller:
   `.env.example`, the README "Useful environment variables" table, and
   `BACKWARD_COMPATIBILITY.md` **§1's `CEZ_*` env-var list only**; plus the in-place `CORRECTED`
   lead-in on `.ai/specs/2026-08-26-filed-task-detail-page.md`'s two now-false Status claims.
   **The analytics ROUTE is not part of this** — `a04cda25` added it to
   `BACKWARD_COMPATIBILITY.md:78` earlier today, and adding it again would put two inventory
   bullets on one route.
6. Tests (Verification 4).

First half of the ask ("show time of each retry"). `WorkflowSteps`'s collapsed trigger is
untouched (D6). Still deploy-class **web-only**: steps 5's files are documentation and a spec, and
the analytics route and sink they document already run in production.

### Phase 4 — deferred, not scheduled

Per-attempt outcome, and closing a restart-interrupted attempt at a real last-alive instant. Both
need something that does not exist yet; see §Out of scope.

### Phase 5 — the record (after the commit; not optional, and not the same as the gates)

**Added during review: the previous draft had no corpus phase at all.** Workspace doctrine is that
a durable decision and a changelog entry land **in the same session as the code**, and that a
corpus write only counts once `cez kb search` finds it. The precedent this follows verbatim is
`.ai/specs/2026-08-25-ship-workspace-revision-attestation.md` §Phase 5 step 5.

1. **Search before writing**, so a correction lands in place rather than as a duplicate:

   ```bash
   cd /var/lib/cezar/loki-labs/cezar
   CEZ_KB=1 cez kb search "step retry timing"
   CEZ_KB=1 cez kb search "cumulative step duration attempts"
   ```

   Measured 2026-08-29, before this run: the only entry either query surfaces on this topic is
   `specs-055be85ab716` (the parent durations spec), whose R3 records the deferral. Re-run the
   searches at execution time before concluding that is still true — and note that the **R3
   correction itself is NOT a KB proposal**: that document lives on the read-only `specs` mount,
   so `applySupersede` (`packages/cezar/src/knowledge/proposals.ts:183`) would reject a
   `supersede` op aimed at it. It is corrected with an editor, in Phase 2 step 3a, inside the
   tested tree. Verify here rather than re-editing:
   `git show HEAD -- .ai/specs/2026-08-20-step-and-tool-call-durations.md`.

2. **Append NDJSON proposals to `$CEZ_KB_WRITE_FILE`** (this run's is
   `.ai/cezar/runs/<task-id>.knowledge.ndjson`). `seq` starts at `0` and counts up across every
   line appended this run — **read the file first**, since an earlier turn may already have
   appended. Every line carries `op`, `scope`, `path`, `title`, `type`, `tags`, `body`, `seq`,
   `runId` = `CEZ_TASK_ID`, and an ISO-8601 `createdAt`; a line missing any of them is rejected by
   the proposal reader, and a rejected line is indistinguishable from one nobody wrote. Two lines,
   one-per-line, no pretty-printing:

   - `scope: "project"`, `path: "decisions/step-attempts-are-persisted-and-summed.md"`,
     `type: "note"`, `tags: ["cezar","runs","step-timing"]` — the durable decision: the store is
     the single writer of `attempts[]`, attempt identity is the iteration transition and never a
     `startedAt` comparison, the upgrade boundary means a mid-flight step never gains a partial
     array, one unmeasurable interval suppresses the whole total rather than showing a partial
     sum, and the clock's `title` is record-dependent because the fallback survives forever.
   - `scope: "project"`, `path: "changelog/2026-08-29-step-retry-timing.md"`,
     `type: "note"`, `tags: ["cezar","notion-changelog"]` — `Added`, Area `Cezar`, citing the
     pushed sha and this spec path.

   Fill `body` and the real `createdAt` at execution time.

3. **Prove it, or say it is pending.** A proposal is **not** the record — proposals are reviewed
   and applied later through the cockpit or `cez kb proposals`, never automatically, and this run
   must not apply its own. So after appending, search for the **exact new titles**, not the topic,
   and quote the output in the implementation report. If they do not resolve, the report says
   **"corpus sync pending — proposals appended but not applied"** and names the file. It does not
   claim the record is current, and the task is not reported Done on the strength of a file
   nobody has applied.

## Analytics

**Corrected during review: this ships an event, in Phase 3.** The first draft deferred analytics
on the grounds that becoming the sink's first caller was "its own change". That is not a call this
spec gets to make — the house rule is that *every feature ships with events, named while designing
the feature* — and the deferral's own premise was the reason to act, not to wait: a sink with no
caller is a sink nobody has proven works end to end.

**Everything the server needs already exists**, verified by direct read:

- `POST /api/v1/workspace/analytics/events` — `packages/cezar/src/server/workspace-analytics-routes.ts`,
  mounted at `server.ts:7381-7383`. It answers `202`, never awaits the disk, and swallows both a
  synchronous throw and a rejection from the sink (`:41-47`), so a client cannot be made to care.
- The contract — `packages/contract/src/analytics.ts`: `analyticsEventSchema` (`:16-28`) with a
  `name` regex `^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$` and `props` limited to ≤16 flat scalar keys
  (strings ≤200 chars); `analyticsEventsRequestSchema` batches 1-20 (`:31-33`).
- The sink — `packages/cezar/src/workspace/analytics-log.ts`, appending
  `<CEZ_HOME>/analytics/events.ndjson`; only the exact string `CEZ_ANALYTICS=0` turns it off
  (`:58-62`).

**What is missing is the browser half and the documentation**, and this spec ships both.

### The event

`step.attempts_expanded`, `{ runId, stepId, iterations }` — three props, well inside the 16-key
bound; `iterations` is a number, the other two strings well under 200 chars. The name satisfies
the schema regex (`step` + `attempts_expanded`). It answers the one open question about this
feature's value: **is the breakdown ever opened?** A disclosure nobody expands is a disclosure to
delete.

Emitted on the **closed → open transition only** — not on collapse, not on re-render, not on
mount. An expand-and-collapse pair must produce exactly one line, or "how often is it read" turns
into "how often did someone fidget".

### The client

**Two files, not one, and the request goes through the typed client.** *Corrected during review:
the previous draft had `analytics.ts` issue a raw `fetch` at a hand-written URL. That is a
contract violation twice over.* The cockpit's rule is that **every** call goes through the typed
`hc` client, which checks the route against the contract at compile time
(`packages/web/src/api/client.ts:200`); and `.ai/specs/2026-08-26-filed-task-detail-page.md:507-509`
already specifies, by name, what this call site is supposed to be:

> **`postAnalyticsEvents(events)`** in `packages/web/src/api/client.ts`, the typed `hc` wrapper,
> spelled like `updateWorkspaceTodo` (`client.ts:1690-1702`) but **without** `unwrap`'s throw on a
> non-2xx: this one call site swallows.

That wrapper was specified there and never written — verified: `analytics` does not appear
anywhere in `client.ts` (0 hits). A raw `fetch` would have made this feature the one call in the
cockpit whose URL and body nothing typechecks, against a spec that had already decided otherwise.
So Phase 3 ships both halves:

1. **`postAnalyticsEvents(events)` in `packages/web/src/api/client.ts`** — the typed wrapper the
   filed-task spec specifies. `cez.api.v1.workspace.analytics.events.$post({ json: { events } })`,
   returning the raw `Response` (or nothing) **without** `unwrap`: `unwrap` throws on a non-2xx
   (`client.ts:371`), and this is the one call site in the cockpit that must not. Placed beside
   its workspace neighbours, spelled like `updateWorkspaceTodo`.
2. **`track(name, props)` in a new `packages/web/src/lib/analytics.ts`** — the fire-and-forget
   façade the UI calls. It delegates to `postAnalyticsEvents([{ name, props }])` and **swallows
   the rejection** (`.catch(() => {})`, no await, no retry, no queue, no return value a caller can
   block on). It is the mirror image of the route's own fail-open contract: neither side may let
   analytics break the thing it measures.

The split is deliberate: `client.ts` owns "what the route is", `analytics.ts` owns "failure is not
the caller's problem". Putting the swallow in `client.ts` would make one wrapper behave unlike
every one of its neighbours; putting the URL in `analytics.ts` would put it outside the typed
client. No batching and no beacon — one event on one deliberate click needs neither, and a queue
would be state to get wrong.

### The documentation debt, paid here

**Corrected during review: the route is no longer part of this debt, and re-adding it would
duplicate an inventory entry.** The previous draft told Phase 3 to add
`POST /api/v1/workspace/analytics/events` to `BACKWARD_COMPATIBILITY.md` §2. It is **already
there** — `BACKWARD_COMPATIBILITY.md:78`, added by `a04cda25` (2026-08-29, this same day), whose
entry records that it shipped in `abe83105` without one and that `bc-route-inventory.test.ts` had
been red on `main` ever since. It documents the `{events: [...]}` body, the `202 {accepted}`
answer, the single-mount workspace scoping and the fail-open contract — everything the previous
draft proposed to write. Nothing there needs changing, and a second entry is worse than none,
because two inventory bullets for one route is precisely the drift the inventory exists to catch.

**What is genuinely still owed is the environment variable, on three surfaces.** `AGENTS.md:31`
requires a `CEZ_*` var to reach `.env.example` in the same commit as the var. `CEZ_ANALYTICS` has
shipped code since `abe83105` and is absent from all three — verified by grep:

- **`.env.example`** — a commented `# CEZ_ANALYTICS=0` carrying the prose the filed-task spec
  already specifies (`.ai/specs/2026-08-26-filed-task-detail-page.md:489-515`), including that
  analytics is **on** by default and only the exact value `0` turns the sink off.
- **The README "Useful environment variables" table** — one row, beside `CEZ_FOLLOWUPS` and
  `CEZ_AUTOMATIONS`, in the style of its neighbours.
- **`BACKWARD_COMPATIBILITY.md` §1**, the `CEZ_*` env-var list (`BACKWARD_COMPATIBILITY.md:13`) —
  the off-switch semantics alongside the other opt-outs, since §1 is where a later rename or
  removal has to be justified. **§1 only; §2 is done.**

### Correct the filed-task spec in place

`.ai/specs/2026-08-26-filed-task-detail-page.md`'s Status block (`:1-18`) currently states that
the sink "has no caller yet" and that the `CEZ_ANALYTICS` doc surfaces "did not land". Both cease
to be true when Phase 3 ships, and that Status is the first thing anyone reads about the sink. Per
the house "correct in place" rule, the implementing commit adds a bolded `CORRECTED <date>`
lead-in to those two claims, naming this spec as what changed them, and leaves the original text
below unchanged. **Do not** mark the rest of that Status superseded — Phases 1-3 of that spec are
still genuinely unshipped, and this change does not touch them.

### Already covered without this

The engine emits `run.step.retried_cold_broker` and `run.step.resumed_after_missing_session`
metric events (`run.ts:5915-5928`, `:5893-5900`), so the *rate* of transient retries is already
measurable. `step.attempts_expanded` measures readership of the display, which nothing does.

## Risks

**R1 — `attempts` and `iterations` could drift.** The writer mints an attempt only on a patch
carrying **both** an `iterations` increment and a `startedAt` string. A future writer that bumps
one without the other makes the badge disagree with the list — silently, since neither side
validates the other. None exists today; verified: the only two step-level `startedAt` writers are
`run.ts:4788` and `:5763`, and both set `iterations` in the same patch. Requiring both is
deliberate over requiring either: `iterations` alone has no timestamp to open an attempt with, and
`startedAt` alone is the millisecond-collision trap. Mitigation: the invariant is a test
(Verification 3), and it is stated in the contract doc comment so the next writer reads it.

**R2 — a cezar restart inflates the interrupted attempt.** A crash reaches no patch at all, so the
attempt is closed later — by `recover()`'s settle sweep, or by the fallback at the next start —
and the downtime lands inside the interrupted attempt either way. This
introduces no new dishonesty — the live clock already counts that interval today for a `running`
step whose process died — and it cannot be fixed better right now: `RunRecord` has no last-alive
timestamp to anchor a close on (checked: `createdAt`/`startedAt`/`finishedAt`/`seenAt`/`archivedAt`
only). Accepted; Phase 4.

**R3 — a total is a measurement, never a verdict.** No threshold, no colour, no "slow" on a step
that retried three times. This is the standing rule from
`.ai/specs/2026-08-20-step-and-tool-call-durations.md` §Solution 4 and
`.ai/specs/2026-08-20-agent-step-inactivity-timeout.md` R1, and a cumulative number makes it
*more* tempting to violate, not less: three attempts sum to a big number and a big number reads
as a problem. It is not one. Silence is the liveness signal.

**R4 — `stepElapsed` changing meaning is a silent behaviour change on two surfaces.** Every
existing caller gets cumulative numbers the moment P2 ships, including the collapsed summary,
without opting in. That is intended (D4) and is the fix; it is listed here because a reviewer
seeing "web-only, small diff" should know the *number on the screen changes* for retried steps.

**R5 — `pending` steps now render a clock.** After `loopBackTo` resets a step, it has attempts and
no longer renders an empty slot. Correct, but it is new behaviour in a status that has always
shown nothing, and it will be visible during any `onFail` loop. Verification 2 pins it so it is a
decision rather than a surprise.

**R6 — render nothing over render a lie, still.** Unparseable timestamps must not become `NaN`
anywhere: `stepElapsed` returns `undefined`, `stepAttempts` returns `ms: undefined` for that row.
The existing `instant()` helper (`step-timing.ts:51-55`) is the only parser and stays the only
parser. This is R6 of the parent spec, carried forward unchanged.

**R7 — a per-row `useState` in the rail.** `StepRow` holds expansion state, so an expanded
breakdown collapses whenever the rows remount. Acceptable: unlike `WorkflowSteps`'s module-level
`openByRun` map (`step-rail.tsx:344`, which exists because `RunHeader` is re-rendered by four
separate task routes), a `StepRail` row is not re-mounted by a tab hop while its parent stays
expanded. If it proves annoying, the same `Map<runId+stepId, boolean>` trick applies; not built
speculatively.

**R8 — unbounded `attempts` growth, accepted with the arithmetic shown.**

**Corrected during review: the claim that "a real run holds single digits" was unsupported and is
withdrawn.** Nothing bounds these counters. `onFail.max` is
`z.number().int().positive().default(2)` (`workflows/types.ts:95`) — no `.max()`. A
post-condition entry's `max` is `z.number().int().nonnegative().default(1)`
(`workflows/types.ts:9`, inside `verifyEntrySchema`) — also no upper bound. The step budget that
would otherwise stop a runaway defaults to **unlimited** (`stepBudget: 0`, `config.ts:46`). So the
ceiling is whatever a workflow YAML author writes, and **no distribution of real attempt counts
was measured** — the runs on this box were not sampled, and this spec does not claim a typical
value.

**Corrected during review, twice over.** The previous draft swapped those two definitions
(`nonnegative().default(1)` and `positive().default(2)` were attributed to the wrong schemas), and
it also asserted that a step's up-to-four `verify` entries (`workflows/types.ts:15`) each carry
"its own retry ledger". They do not. `stepLoop` holds **one** `verifyRetries` map keyed by step id
(`run.ts:5659`), `evaluatePostconditions` returns `retryMax: first.max` — the **first failed**
entry's maximum, not a per-entry budget (`run.ts:8202`) — and `retryAfterFailedPostcondition`
increments that single per-step counter (`run.ts:8219-8222`). Four entries therefore share one
budget rather than multiplying it. **The unbounded-growth conclusion is unchanged**, because it
never rested on that multiplier: no `.max()` on either number is what makes the ceiling
author-defined.

What *is* known is the cost per attempt. One closed attempt serializes as
`{"startedAt":"2026-08-29T12:00:00.000Z","finishedAt":"2026-08-29T12:04:12.000Z"}` — **~80 bytes**
of `runs.json`, including its separating comma. That gives, per step:

| Attempts | Added bytes |
| --- | --- |
| 3 (the shipped `spec-to-deploy` defaults: `onFail.max: 2`, `verify … max: 1`) | ~240 B |
| 10 | ~0.8 KB |
| 100 | ~8 KB |
| 1,000 (a deliberately pathological `onFail.max`) | ~80 KB |

**Uncapped anyway, deliberately.** A cap would drop the oldest attempts from a number this spec
labels a *total*, which is the silent-undercount failure D1 rejected the event log for and
§Data models forbids outright. The arithmetic says the honest option is affordable: even the
pathological row costs less than one long agent turn's transcript, and the same record already
grows without bound in ways nobody caps — `RunRecord.steps` per continuation, and the NDJSON event
log per event. The bound is authored, not adversarial: workflow YAML is repo-local and read by the
person who wrote it. If a real distribution ever contradicts this, the fix is a bound on
`onFail.max` in `workflows/types.ts`, not truncation of a total.

## Verification

Executable, in order.

**Gates first, and all five of them.** Corrected during review: the draft listed three and called
that the pre-commit gate, which it is not. `AGENTS.md:228-240` is explicit that the sequence is
run **in order** and that `npm run test:package` needs a completed `npm run build` (it packs the
tarball):

```bash
npm run typecheck    # tsc --noEmit (api-client + server + web)
npm test             # vitest — server + cockpit unit suites
npm run test:unit    # node:test — packages/cezar/test/unit/
npm run build        # tsc → dist/, vite → packages/cezar/web/dist/, then the check:pack gate
npm run test:package # pack/install the tarball and exercise the built CLI
```

All five green before any commit, per the fail-closed rule. `npm run build` is not optional here
for a second reason: P1 changes `packages/cezar/src`, and `server-deploy` refuses to stage without
a fresh `.build-stamp.json` (`release-deploy.ts:90-128`).

**All five must be green before any commit or push. There is no known-red gate to write off.**

One real trap remains, recorded in `AGENTS.md`: `npm test` needs the environment scrub
(`AGENTS.md:253-299`) or it lies. Run it exactly as documented there.

**Corrected during review: the previous draft told the implementer to expect a pre-existing
`npm run test:package` failure under the run broker, citing `AGENTS.md:401`. That entry is past
tense and the draft quoted the superseded half of it.** `AGENTS.md:380-389` records the trap
CLOSED by `.ai/specs/2026-08-24-codex-dry-run-mock.md` (commit `03a16af3`, merged at `c25d8ee5`):
the bundled codex app-server mock ships at `packages/cezar/scripts/mock-codex-app-server.mjs`,
`resolveCodexExecutable()` has the three-tier `CEZ_DRY_RUN` resolution the other runners already
had, and the package gate is green at **25/25**. That entry says it in as many words: *"If this
case is red again, that is new information, not a re-confirmation of either correction below."*
So a red `test:package` on this branch is **a finding to investigate and report**, never a known
flake to wave through — reproduce it on clean `main` and say which it is, but do not commit on it.

**1. Store accumulation (Phase 1)** — `packages/cezar/src/runs/store.test.ts`:

```bash
npm test -- packages/cezar/src/runs/store.test.ts
```

Cases, each driving `store.updateStep` directly, with the store's clock injected so rule (2)'s
timestamp is asserted rather than raced. Patches are written in the exact shape `run.ts:5760-5765`
sends — `{status, iterations, startedAt}` together — because a case that omits `iterations` is
testing a patch the engine never emits.

**Open the store through the public factory, which is the only way a test can.** *Corrected during
review: an earlier draft implied a constructor override.* `RunStore`'s constructor is private
(`store.ts:783`) and the existing suite already builds every store through `RunStore.open`, so the
clock rides in on that call's options object (§"The writer, precisely"):

```ts
const FIXED = '2026-08-29T12:00:00.000Z'
const store = RunStore.open(dir, { now: () => FIXED })
```

Rule (2)'s cases then assert `attempts[0].finishedAt === FIXED` **exactly**, not merely that it is
a string — an assertion that only holds if the store actually consulted the injected clock, which
is what makes it a test of rule (2) rather than of `Date`.

*Minting and closing:*

- a first `{ status:'running', iterations:1, startedAt:T1 }` on a step with `iterations:0` mints
  `attempts: [{startedAt: T1}]`;
- `{ status:'done', finishedAt:T2 }` closes it, and `attempts[0].finishedAt === T2`;
- `{ status:'running', iterations:2, startedAt:T3 }` appends a second attempt and does **not**
  touch the first;
- `addStep` creates a step with `attempts` **absent**, not `[]`.

*Attempt identity (item 3 — the millisecond collision):*

- two patches carrying the **identical** `startedAt` string but `iterations:1` then `iterations:2`
  create **two** attempts. This is the regression test for the withdrawn
  `patch.startedAt !== step.startedAt` rule, which would have created one;
- replaying the same patch (same `iterations`, same `startedAt`) creates **none** — idempotent, as
  `recover()` and any re-patch require;
- a patch with `startedAt` and **no** `iterations` key creates none;
- a patch with an `iterations` increment and no `startedAt` creates none, and does not corrupt the
  existing array.

*Closing on the status exit (item 2 — D3 rule (2)):*

- **pending with no re-entry**: `{status:'running',iterations:1,startedAt:T1}` then
  `{status:'pending'}` and *nothing further* — the post-condition-retry / cold-broker shape
  followed by a spent step budget. `attempts[0].finishedAt` is the injected clock's value, and the
  array is closed. Under the withdrawn next-start-only rule this attempt stayed open forever;
- **cancellation**: `{status:'cancelled'}` from `running` closes the open attempt at the clock;
- **manual requeue**: `{status:'pending', error:undefined, finishedAt:undefined}` — the literal
  `requeueHandoff` patch (`run.ts:6631`) — closes on the status exit and **not** on the
  `finishedAt` key, whose value is not a string;
- `waiting` → `review` does **not** close anything: both are active;
- `finishStep`'s shape (`{status:'done', finishedAt:T2}`) closes on the explicit timestamp, and
  rule (2) then finds nothing open — `attempts[0].finishedAt === T2`, never the clock;
- `loopBackTo`'s `{status:'pending'}` on an intermediate step whose attempts are all already
  closed is a **no-op**;
- the fallback: a start patch arriving while an attempt is still open closes it at the new
  `startedAt` (should be unreachable post-P1; kept per D3).

*The upgrade boundary (item 4):*

- **an old started step**: a `runs.json` fixture with `iterations:4`, a `startedAt`/`finishedAt`
  pair and **no** `attempts` key parses, and a fifth attempt patch
  (`{status:'running',iterations:5,startedAt:T}`) leaves `attempts` **still absent**. Asserted
  again after two further attempts — the field never appears for the life of that record. This is
  the test that would have caught the partial-array undercount;
- **an old never-started pending step**: a fixture with `iterations:0` and no `attempts`; its
  first attempt patch mints attempt 1, and from there it behaves exactly like a fresh step;
- a step that already has `attempts` keeps accumulating normally.

**2. `stepElapsed` / `stepAttempts` (Phase 2)** —
`packages/web/src/routes/task-thread/step-timing.test.ts`, extending the existing suite and
keeping its `step()` helper and injected `NOW` (the module is pure and `now`-injected precisely so
tests do not race the clock):

```bash
npm test -- packages/web/src/routes/task-thread/step-timing
```

- **the headline case**: three closed attempts of 4:12 / 11:03 / 2:40 on a `done` step sum to
  17:55 with `live: false`;
- a `running` step with two closed attempts and one open returns `live: true`, `since` = the open
  attempt's start, `offsetMs` = the two closed ones, and `ms` = offset + (now − since);
- **the degradation case**: a step with `attempts` absent returns byte-identical results to
  today's behaviour — the whole existing `stepElapsed` suite (`step-timing.test.ts:40-99`) must
  pass **unmodified**, which is the strongest available proof that old records are unaffected;
- a `pending` step with recorded, **all-closed** attempts returns their sum, `live: false` (R5);
- a `pending` step with no attempts still returns `undefined` (unchanged);
- a terminal step whose last attempt is open closes at `step.finishedAt`;
- `stepAttempts` on a record with no `attempts` returns `[]`.

**No partial sum is ever returned as a total** (item 5) — these are the cases the first draft got
wrong, and each is a separate assertion:

- **mixed valid and invalid**: three attempts of which the middle one has an unparseable
  `startedAt`. `stepElapsed` returns **`undefined`** — not the other two summed. `stepAttempts`
  returns **three** rows, the middle with `ms: undefined`, the outer two with their real
  durations. Asserted together, because the point is that the row survives while the total does
  not;
- **the pending-plus-open case**: a `pending` step whose last attempt has no `finishedAt`.
  `stepElapsed` → `undefined`; that attempt's row → `ms: undefined`, `live: false`. This is the
  case the first draft left undefined entirely;
- **terminal with an open last attempt and no usable `step.finishedAt`**: `undefined`, not the
  closed attempts' sum;
- nothing in any of the above is ever `NaN`, on either function (R6).

**2a. `LiveDuration`'s offset (Phase 2)** — **new file**
`packages/web/src/components/live-duration.test.tsx`. The component has no direct test today
(verified: it is referenced only by `run-header.test.tsx`, `thread-items.test.tsx`,
`step-rail.test.tsx` and `design-guardian.test.ts`, none of which would notice a wrong `offsetMs`),
and a prop added without direct coverage is how the skew below ships unnoticed. Pin the clock with
`vi.useFakeTimers()` + `vi.setSystemTime()`, following `packages/web/src/lib/use-now.test.tsx`.

```bash
npm test -- packages/web/src/components/live-duration
```

- with no `offsetMs`, the rendered text is byte-identical to today's for the same `since` and
  clock — the default must not move an existing caller;
- `offsetMs: 900_000` with `since` 10 s ago renders `15:10`, not `0:10`;
- **the clock-skew case**: `since` **in the future** (a browser behind the server) with
  `offsetMs: 900_000` renders `15:00` — the banked duration, unreduced. Under the draft's
  `offsetMs + (now − start)` it renders *less* than 15:00, i.e. a cumulative total that shrinks as
  it ticks. This is the regression test for that formula;
- an absent or unparseable `since` still renders `null`, even with a non-zero `offsetMs` — the
  offset never resurrects a clock that has no start (`live-duration.tsx:41-43`).

**3. The invariant, end to end (Phase 1)** — `packages/cezar/src/workflows/run.test.ts`, which
already drives the engine with a dry-run/fixture workflow. Add a case with an `onFail.retry` step
that fails twice, then assert on the settled record, **for every step whose `attempts` is present**
(the qualification from §"The writer, precisely" — a step that entered the run with
`iterations > 0` legitimately has no array, and asserting on it would fail the upgrade boundary
that exists on purpose): `attempts.length === iterations`, every attempt closed, and the attempts
**nondecreasing** by `startedAt`. Not *strictly* increasing — two attempts can share a millisecond,
which is the whole reason attempt identity is the iteration and not the timestamp. This is D5's
claim and R1's guard in one test.

Add a second engine case for a step whose **post-condition** fails once and retries (path 4 of the
nine): it never calls `finishStep`, so it is the end-to-end proof that D3's rule (2) fires from
inside the real engine and not just from a direct `updateStep` call.

```bash
npm test -- packages/cezar/src/workflows/run.test.ts
```

**4. The rail renders it (Phase 3)** — `packages/web/src/routes/task-thread/step-rail.test.tsx`,
asserting on `data-slot` attributes rather than text or classes, per `AGENTS.md` §"Verifying a
cockpit UI change":

```bash
npm test -- packages/web/src/routes/task-thread/step-rail
```

- `[data-slot="step-iterations"]` still reads `×3` (the existing assertion at `:88-91`, unchanged);
- it is a `<button>` with `aria-expanded="false"` when the step has >1 attempt, and a `<span>`
  when it has none recorded;
- clicking it renders `[data-slot="step-attempts"]` with exactly 3
  `[data-slot="step-attempt"]` children, in `startedAt` order;
- the open attempt's row renders a `[data-slot="live-duration"]`, the closed ones render frozen
  `<time>`;
- `WorkflowSteps`'s collapsed trigger renders **no** `[data-slot="step-attempts"]` (D6);
- the design guardian still passes: `npm test -- packages/web/src/design-guardian` — no `useNow`
  entered `step-rail.tsx`.

**Both `title` cases (D4), because a cumulative clock under a current-attempt label is a lie the
tests must catch.** *Added during review: the previous draft changed the number and never asserted
the sentence beside it.* Two assertions, one per branch of the switch:

- a step **with** `attempts` — its `[data-slot="step-duration"]` (and the live
  `[data-slot="live-duration"]`) `title` names the **cumulative** interval and, specifically, does
  **not** match `/current attempt/i`. That negative half is the load-bearing one: without it the
  test passes on a title that merely *mentions* a total while still promising the current attempt;
- a step **without** `attempts` — the existing assertion at `step-rail.test.tsx:406`
  (`toMatch(/current attempt/i)`) passes **unmodified**, on a fixture with no `attempts` key. Do
  not edit that test to accommodate the new title; if it needs editing, the fallback broke.

**4a. The analytics event (Phase 3)** — `packages/web/src/lib/analytics.test.ts`, plus two
assertions in `step-rail.test.tsx`:

```bash
npm test -- packages/web/src/lib/analytics
```

*Corrected during review: these cases were written against a raw `fetch`. The call goes through
`postAnalyticsEvents` in the typed client (§Analytics), so the transport is stubbed at the global
`fetch` the `hc` client uses, and the assertion is on the URL and body that client produces — not
on a string this feature built itself.*

- `track()` sends `{ events: [{ name, props }] }` to `/api/v1/workspace/analytics/events` with a
  JSON content type — the shape `analyticsEventsRequestSchema` accepts
  (`packages/contract/src/analytics.ts:31-33`). Asserting the route **through** the typed wrapper
  is the point: `postAnalyticsEvents` is what pins the path against the contract at compile time,
  and this case proves the wrapper is the one being called;
- **`postAnalyticsEvents` does not throw on a non-2xx.** A `500` response resolves rather than
  raising, which is what distinguishes it from every `unwrap`-based sibling (`client.ts:371`) and
  is the single deviation `.ai/specs/2026-08-26-filed-task-detail-page.md:507-509` asks for. Assert
  it on the wrapper directly, not only through `track()`, or the swallow in `analytics.ts` would
  hide a wrapper that throws;
- **failure is swallowed**: a transport that rejects, and one that resolves `500`, both leave
  `track()` resolved and throw nothing into the caller. Analytics must never break the feature it
  measures, mirroring the route's own fail-open contract
  (`workspace-analytics-routes.ts:41-47`);
- the event name and props satisfy the contract schema — assert by parsing the emitted payload
  with `analyticsEventSchema` directly, rather than hand-checking the regex;
- in `step-rail.test.tsx`: expanding the disclosure emits **exactly one**
  `step.attempts_expanded`, whose `runId` equals **the exact string that render passed to
  `StepRail`** (Phase 3 step 1a) — not merely a defined value — alongside `stepId` and
  `iterations`; collapsing it again emits **none**; a second expand emits one more.

**4b. Negative controls — every regression test must be proven to fail without its fix.** A test
written after the code it covers passes for reasons that may have nothing to do with the fix. For
each item below, after the test is green: temporarily revert **only** the corresponding source
change, run that one test file, **record the failure output in the implementation report**, then
restore the fix and confirm green again. A test that still passes with its fix removed is not a
regression test and must be rewritten before the phase ships.

**Corrected during review: the previous table controlled only the five secondary guards and left
the feature itself uncontrolled.** Every entry below the rule was a defence against a *wrong*
number; none proved the number is produced at all. A rail that renders no breakdown, or a total
that is still the last attempt's, would have passed the whole list. The four core controls come
first, and all nine are mandatory.

**Core — the feature is actually the reason its tests pass:**

| # | Revert this | Expect this to fail |
| --- | --- | --- |
| C1 | writer rule (3) — attempt accumulation (do not push the new attempt) | Verification 1's headline, "a first `{running, iterations:1, startedAt:T1}` mints `attempts:[{startedAt:T1}]`", and the second-attempt append after it |
| C2 | the cumulative branch of `stepElapsed` (return today's single-pair math even when `attempts` is present) | Verification 2's headline — three closed attempts of 4:12 / 11:03 / 2:40 no longer sum to 17:55 |
| C3 | the `StepAttempts` disclosure (leave `×N` the inert `<span>`) | Verification 4 — clicking emits no `[data-slot="step-attempts"]`, and the three `[data-slot="step-attempt"]` children are absent |
| C4 | the `track()` call at the expand site | Verification 4a — expanding emits no `step.attempts_expanded` |

**Secondary — the five defects this spec was revised to fix:**

| # | Revert this | Expect this to fail |
| --- | --- | --- |
| 1 | the upgrade-boundary guard in writer rule (3) | Verification 1, "an old started step" — `attempts` gains a one-element array |
| 2 | iteration-transition identity, back to `patch.startedAt !== step.startedAt` | Verification 1, "identical `startedAt`, iterations 1 then 2" — one attempt instead of two |
| 3 | D3 rule (2), the status-exit close | Verification 1, "pending with no re-entry" — the attempt stays open |
| 4 | the all-attempts-measurable check in `stepElapsed` | Verification 2, "mixed valid and invalid" — a partial sum is returned instead of `undefined` |
| 5 | the `Math.max(0, …)` clamp inside `LiveDuration` | Verification 2a, the clock-skew case — the total renders below its banked duration |

**Nine reverts, nine recorded red results** — the failure output of each quoted in the
implementation report, not summarized as "confirmed". This is cheap (each is a one-line change or
a single deleted call) and it is the only evidence that the feature is doing the work its tests
credit it with, rather than passing on a fixture.

**5. Runtime E2E — the one that decides Done.** Gates green is necessary, not sufficient
(`AGENTS.md` §Validation, house §"Gates are necessary"). This is a cockpit UI change on data only
a real run produces, so it needs a throwaway cezar with a seeded fixture, per `AGENTS.md:614`
§"Verifying a cockpit UI change — boot a throwaway cezar on a spare port". Do **not** attempt to
drive `cockpit.example.com`; it is behind Cloudflare Access and loopback answers 401.

**The fixture must survive `recover()`, and a `status: 'running'` run does not.** Corrected during
review: the draft's board would have been mutated before it could be read. `manager.recover()` is
awaited by `ProjectContext.build()` **before the server listens**
(`project-context.ts:514`, `run.ts:2338`); it selects runs whose status is `queued`, `waiting` or
`running` (`run.ts:2340-2342`) and, for a `waiting` run, settles every `waiting`/`running` **step**
to `{status:'done', finishedAt: now}` (`:2396-2400`). A seeded `running` run is worse still: it is
resumed, i.e. cezar tries to relaunch an agent against a session that never existed. Either way the
live step under test is gone before Playwright loads the page.

**Seed a `review` run instead**, whose current step is also `review`. That status is in neither
set: `runStatusSchema` includes `review` (`contract/src/runs.ts:30-34`) but `recover()`'s filter
does not, so the run is not touched at all — and `review` **is** in the web's
`ACTIVE_STEP_STATUSES` (`step-timing.ts:16`), so the step is live for timing and renders a ticking
clock. That is the coherent pairing: a run cezar leaves alone, holding a step the cockpit
considers running.

Seed `$B/proj/.ai/cezar/runs.json` with one `status: 'review'` run whose steps cover, in a single
board, the four states a happy-path fixture forgets:

- a `done` step with **three closed attempts** (the headline: badge `×3`, cumulative total, three
  breakdown rows);
- the **current** step, `status: 'review'`, with **two closed attempts and one open** whose
  `startedAt` is a few minutes in the past (ticking total = banked + live);
- a `pending` step with **two closed attempts**, all closed (R5 — it now shows a frozen total);
- a step with `iterations: 1` and **no `attempts` key at all** (the pre-P1 record: clock behaves
  exactly as today).

Run the **locally built** server — `node packages/cezar/dist/index.js` from this worktree after
`npm run build`, not `/opt/cezar`, which is the deployed release and does not contain this change.
The rest of the recipe is `AGENTS.md:614`'s verbatim: scratch `HOME`, the `env -u` scrub of the
hosted-mode vars, a spare port, `projects add`, then the first-run wizard
(`[data-slot="onboarding-org-name"]` → `[data-slot="onboarding-org-submit"]`).

Then, with Playwright (`AGENTS.md:503` §"Headless browser on prod-host"), asserting on
`data-slot` attributes:

1. load `/tasks/:id`, expand `WorkflowSteps`, screenshot;
2. read the `review` step's `[data-slot="live-duration"]` text, wait ~5 s, read it again:
   it must have **advanced**, and at no point may it fall **below** that step's banked closed-attempt
   total. This is the live-offset assertion, and it is the one thing no unit test can prove;
3. click the `×3` badge and assert Verification 4's `data-slot` expectations against the live DOM;
4. screenshot again; confirm the pre-P1 step shows no breakdown affordance.

**Record screenshots and Playwright video into a retained artifact directory** (`$B/artifacts/`,
copied out before `$B` is deleted) — house rule: a failure must be watchable rather than guessed
at. Then stop the instance and remove the scratch directory. Both cleanup steps run even on
failure; the artifacts are what survive.

**Until step 5 has actually been executed, this ships as QA Needed, not Done** — and if the
executing step has no browser available, it must say so plainly and carry the visual pass as an
open todo rather than rounding up. **Done: filed as todo `da65120d-670e-47e0-baf8-ddbef6ab0bd4`**
by the document step (2026-08-29), the same way the parent durations spec still carries its own
open visual pass as todo `1f74df2b-9428-4e84-a983-870b00cbdcf2`
(`.ai/specs/2026-08-20-step-and-tool-call-durations.md` §Status); do not repeat it silently.

**6. Deployment.** P1 touches `packages/cezar/src` and needs a service restart; P2 and P3 are
web-only and are live on the next request after the asset swap. On `prod-host` the path is
`cezar server-deploy --strategy=blue-green` after a real `npm run build` (the build-stamp gate at
`release-deploy.ts:90-128` will refuse a stale `dist/`). Per the 2026-08-24 correction in
`AGENTS.md` §"Shipping cezar itself", both targets in `.ai/deploy-targets.json` are
`"manual": true`, so an agent-run `spec-to-deploy` will **park** at its deploy step — that is the
expected terminal state, not a defect to route around.

## Out of scope (recorded, not forgotten)

- **Per-attempt outcome.** Which attempt failed, which cezar stopped, which succeeded. The data is
  in the transcript (`step-end` carries `status`/`error`/`stopReason`, `run.ts:8294-8300`) but not
  in the record, and the owner asked for *time*. Adding `status` to `stepAttemptSchema` later is
  additive and costs nothing to defer.
- **Closing a restart-interrupted attempt honestly** (R2). Needs a last-alive timestamp on
  `RunRecord` that does not exist today; `touch()` (`store.ts:1449`) stamps nothing. Would be a
  separate additive field with its own justification.
- **Per-attempt token and cost split.** `tokensUsed`, `inputTokens`, `outputTokens` and `costUsd`
  are overwritten across attempts in exactly the way `startedAt` was, so the same store-level
  accumulation would work. Genuinely useful, genuinely a different question, and it would double
  this spec. Not asked for.
- ~~**The `step.attempts_expanded` analytics event**, pending the workspace analytics sink getting
  its first caller and its `CEZ_ANALYTICS` doc surfaces.~~ **Removed during review — it ships in
  Phase 3.** Deferring it was wrong on the house rule (every feature ships with events) and wrong
  on its own premise: an uncalled sink is a reason to become its first caller, not to wait. See
  §Analytics, which also pays the `CEZ_ANALYTICS` documentation debt and corrects
  `.ai/specs/2026-08-26-filed-task-detail-page.md`'s Status in place.
- **Analytics on the cumulative clock itself.** No event fires when a step's total is merely
  *rendered*: every task page renders every step, so it would measure page views, not this
  feature. Only the deliberate expand is instrumented.
- **Retry timing anywhere but `/tasks/:id`.** The tasks table and the workspace runs index show no
  per-step timing at all today; that is unchanged.
