# A plain turn end must carry its question

**Status (current, 2026-08-29):** Implemented in `d811d34c` (2026-08-24) and **Done**, not QA
Needed. All three defects the 2026-08-24 review found below (the mid-chain decision-table row,
`pendingAsk` widening `reenterChain` on restart, and the clearing choke point missing five call
sites) are verified **closed** at `HEAD` `0a46010b`, by direct read this session
(`.ai/specs/2026-08-29-plain-end-question-verification.md`'s table has the full file:line
evidence): `run.ts:2571`'s wide `pendingAttention` no longer gates `reenterChain` (R10 below is
stale the same way), and `store.ts:961-968` is the single transition-keyed choke point, not an
enumeration. **V8, the runtime E2E, is closed** by `packages/web/e2e/plain-end-question.e2e.ts`
(task `eba6cb05-f995-4fc3-9cf1-0852977296d1`): `npm run test:e2e`'s focused run reported
`TEST_E2E_STATUS=passed` for all three cases (question fallback, nudge-to-chips, report park),
and the discriminating-mutation check (V5 of that spec — gut `task-thread.tsx`'s
`hasWaitingQuestion` to `false`, rebuild, rerun) reproduced exactly the failure it predicts: case
A red, case C still green. Full detail, including the record of what was NOT run (a full
`npm run typecheck && npm test` pass in this same session), is in that spec.

**SUPERSEDED 2026-08-29 by the status block above.** The block below was written on 2026-08-24 and
is preserved verbatim as the record of what was true and believed then — including its own
embedded "V8 ... has never run" line, which is stale in the same way as the rest of this file's
2026-08-24 layer. Do not read anything below this line as current.

**Status:** Implemented and pushed to `origin/main` in `d811d34c` on 2026-08-24,
**verification incomplete**, QA Needed, not Done. The final feature commit includes P1-P5, the
reviewed store-transition, restart-predicate, report-markup and run-index projection corrections,
and their named regressions. Green: `npm ci`, `npm run typecheck`, the focused runs-index
regression (20/20), `npm run test:unit` (44/44), the production build and `check-pack`,
`npm run test:package` (18/18), both release-package dry runs and `git diff --check`. This repo has
no `lint` script. The required root `npm test` gate is not green: 10,774 passed, 1 failed and 4
skipped. The sole failure is the C18 knowledge-catalog host-speed budget, reproduced on clean
detached baseline `116c3ee1`, so it is not evidence against this feature but still prevents a
green-gate claim. **V8, the runtime/browser E2E, has never run**, so the feature remains QA Needed.

**RESOLVED 2026-08-29:** all three items this nested stack tracks were verified closed by direct
read at `HEAD` `0a46010b`, this session — see the current status block at the top of this file and
`.ai/specs/2026-08-29-plain-end-question-verification.md`'s table for the file:line evidence. The
stack below (what was open, what a corrective patch fixed, and a 2026-08-24 re-confirmation) is
left in place as the record of that day's back-and-forth; none of it is current.

**CORRECTED 2026-08-24:** the three defects below were open against autosave `116c3ee1`, then were
implemented in the following implement step. The original review finding remains below as the
record of what the corrective patch invalidated:
- **the decision table's "mid-chain step" row** was twin-A-only (corrected in the table below);
- **P5's widened `pendingAsk` also gates chain re-entry** at `run.ts:1854`, so a false-positive
  prose verdict stalls on restart a chain that today resumes (corrected in P5; the landed code
  still carries the wide form);
- **the two new fields are cleared at only some of the sites that clear `activity`** (corrected in
  P2 step 2 — one choke point in the store, not N call sites; the landed code enumerates call sites
  and misses five).

**SUPERSEDED 2026-08-24 by `d811d34c`:** the audit below was true against autosave `116c3ee1`.
The final feature commit closed the transition-keyed clearing, split recovery predicate and
report-markup gaps. The original finding remains below as the record of what the corrective patch
invalidated.

**All three re-confirmed open on 2026-08-24**, by reading the code rather than trusting this list.
(1) The mid-chain row is a spec-text fix and is applied below. (2) `run.ts:1841` still reads
`this.runHasPendingAsk(run.id) || run.waitingReason === 'question'` and `:1854` still gates
`reenterChain` on that single wide variable. (3) The `updateRun` choke point that clears
`waitingReason`/`waitingQuestion` landed in `d47ec1e6` but fires **only on a terminal status**
(`!['running','waiting','queued'].includes(status)`, `store.ts:876-884`), so all five enumerated
sites (`run.ts:2430` writing `status: 'queued'`, and `:4084`, `:4916`, `:4986`, `:5681` all writing
`status: 'waiting'`) still write `activity: undefined` with no `waitingReason` key and are not
reached by it. P2 step 2b's transition-keyed rule is still the work to do.

**Date:** 2026-08-23 · **last revised** 2026-08-24 (record refresh: the motivating run's NDJSON,
three stale `runHasPendingAsk` line numbers, and the commit state above)
**Task:** `183740fe-df08-4bb6-a46e-5f266354537c` · todo `c19d9d4a-4ce1-48dd-b92a-58dfb9e878f2`
**Brief:** `.ai/specs/briefs/2026-08-23-plain-end-structured-question.md` (step 1 of this run,
re-gathered 2026-08-24)
**Owner instruction, 2026-08-22:** *"why this is 'The agent is paused, waiting for your reply' — if
agent needs any reply it needs to be done in interactive way with predefined questions and some
suggest answer (like we already do for question)"*

## TLDR

A cezar agent turn ends four ways. Three of them are marked and guarded; the fourth — **no marker
at all** — is the only one that asks the user for something, and it has no check whatsoever. The
handoff contract actively sanctions it (`packages/cezar/src/handoff.ts:146`: *"If you are waiting
on the user (a question, a decision, missing input), just end your message normally"*), so an agent
that buries a real question in prose is following the contract as written. The cockpit then renders
the identical dead-end banner — *"The agent is paused, waiting for your reply"*
(`packages/web/src/routes/task-thread/task-thread.tsx:426-434`) — whether a question was asked or
the agent simply stopped. The user is told to reply and given nothing to reply *to*.

The fix is four layers, smallest first, none of which ever invents a question:

1. **The contract stops sanctioning it.** `handoff.ts` pairs the plain end with `CEZ:ASK` as a
   rule, not a convention; `BACKWARD_COMPATIBILITY.md` §8 gains `CEZ:ASK` (a pre-existing
   omission) and the pairing rule.
2. **The engine classifies the plain end** with a pure, deterministic detector over the assembled
   turn text — `question` or `report` — and records the verdict plus the agent's *own* trailing
   sentence on the run record.
3. **The cockpit renders the verdict.** A `question` park shows what is being asked, above the
   composer. A `report` park is byte-identical to today.
4. **One bounded nudge upgrades it.** A `question` park sends `ASK_STRUCTURE_NUDGE` — once per
   run, never on an autonomous run, via the same seam `MONITORING_WAKE_NUDGE` already uses — asking
   the agent to re-send it as `CEZ:ASK`. The agent, not the detector, decides whether there really
   was a question.

The detector is a **spend gate, not an oracle**. A false positive costs one short turn, one
step-budget unit and one extra line of dock text; it can never fabricate a question, because the
only text ever shown is the agent's own and the only thing that mints an ask card is the agent
re-emitting one.

A precondition the phases carry: the bundled dry-run mock cannot currently produce three of the
four turn shapes this spec is about, so it changes with P2/P4 — see Architecture → "The mock has to
change first".

## Problem

### The four endings, and the asymmetry

All four are decided from the same accumulated turn text, at two near-identical call sites:
`runAgentStep`'s `onEvent` (`packages/cezar/src/workflows/run.ts:5235-5395`) and
`runContinuation`'s (`run.ts:3691-3860`).

| Ending | Detected by | Guard |
|---|---|---|
| `CEZ:DONE` | `DONE_MARKER_RE`, `run.ts:162` | **Yes** — `interactive` (`run.ts:4584`) confines it to the chain's last agent step (#410); `runContinuation` gained the chain guard in `.ai/specs/2026-08-20-chain-integrity-restart-and-continuation.md` |
| `CEZ:ASK <json>` | `parseAskMarkerResult`, `packages/cezar/src/core/ask.ts:151-172` | **Yes** — zod-validated (`ask.ts:43-53`), rejected payloads become a `note` via `askMarkerRejection` (`run.ts:203-213`) |
| `CEZ:MONITORING` | `MONITORING_MARKER_RE`, `run.ts:173` | **Yes** — a liveness bound: `armMonitoringWakeTimer` (`run.ts:6273-6317`), capped at `MAX_AUTO_CONTINUES` = 40 (`run.ts:349`) |
| **nothing** | the `else` of all three | **None** |

The unguarded one is the only ending whose whole meaning is *"I need something from you."*

### What the user actually sees

**Citations in this section are to `origin/main` (`84fb8237`), not to this worktree** — it describes
what ships today, and P2 has since moved the same write into `parkPlainEnd` (`run.ts:6363-6368`) in
the unmerged autosaves.

`run.ts:5290` (and its twin `run.ts:3782`) writes `status: 'waiting', activity: undefined`
with no record of *why*. `threadFooter` maps that to an undifferentiated `{ state: 'waiting' }`
(`packages/web/src/routes/task-thread/thread-state.ts:168-171`), and the dock renders one fixed
string (`task-thread.tsx:426-434`):

```tsx
{run.status === 'waiting' ? (
  <div data-slot="paused-hint" …>
    <StatusDot tone="pending" pulse />
    The agent is paused, waiting for your reply
  </div>
) : null}
```

No `ThreadAsk` entry exists on this path — `AskCard` renders only off an `ask.requested` event
(`thread-state.ts:674-689`). So the user scrolls the transcript hunting for a question that may or
may not be there. The notification is no better: `mapRunTransition` fires `run.needs-you` on entry
to `waiting` (`packages/cezar/src/notifications/decider.ts:93-94`) and the body falls back to the
literal string `'Waiting on you.'` when there is no `askText` (`decider.ts:120-121`), because
`readLastAskText` only reads `ask.requested` events (`notifications/observer.ts:130-146`).

Both surfaces are pinned by tests, so this is the shipped behaviour, not a theory:
`packages/cezar/src/workflows/run.test.ts:1456-1461` (*"a markerless turn-end still parks as
waiting with no activity"*) and `packages/web/src/routes/task-thread/task-thread.test.tsx:227-238`
(asserts the exact banner text).

### This was a known, deliberate non-fix

`.ai/specs/2026-07-18-askuser-across-runners.md` ("AskUser — structured questions across claude,
codex & opencode", #473, KB `specs-38aca129d002`) shipped the whole `CEZ:ASK` mechanism: schema,
parser, `ask.requested` event, `AskCard`, and an answer path that reuses the existing
`POST /api/runs/:id/messages` / `/continue` seams. Its "Edge Cases & Failure Scenarios" section
names this exact gap and declines it:

> "Agent ignores the marker and asks in prose → unchanged: `waiting`, no card, composer works."

with the governing bar: *"The feature never makes the current behavior worse."* That was defensible
when `CEZ:ASK` was new and the fallback was the status quo. What changed is that the plain end is
now the **contractually sanctioned** way to ask (`handoff.ts:146`), so agents land there by
following instructions rather than by ignoring them. This spec reopens that decision deliberately
and keeps the same bar: **every path below either improves the surface or is byte-identical to
today.**

That spec's Open Question Q1 also foreclosed a native-`AskUserQuestion`-bridge design as "a future
enhancement, not this spec" — cezar spawns claude headless with `--permission-mode dontAsk`, so the
built-in tool is suppressed and no permission-prompt-tool bridge exists anywhere in the codebase.
**This spec does not reopen that.** The marker is the mechanism.

### Why it must land at both turn-end sites

`.ai/specs/2026-08-20-chain-integrity-restart-and-continuation.md` (KB `specs-172ddd891dd0`,
implemented and deployed 2026-08-20, `ee74a158` → `5774bf95`, live at `e3f542df`) exists because a
guard landed at `runAgentStep`'s turn-end and not at `runContinuation`'s. Its Defect B is verbatim
the hazard here. Its rule — *"the chain owns completion; a session only owns its own turn… guard
placed identically at both turn-end sites"* — is a hard constraint on every phase below.

### Not in scope

- **Todo `751e69fb-d663-438e-a407-fdc4b9eee4e4`** ("CEZ:ASK marker rejected as invalid JSON
  although the emitted payload is valid") is a parsing bug on an *emitted* marker. Different
  defect. See R7 — this spec interacts with it favourably and does not fix it.
- **A native `AskUserQuestion` bridge** — foreclosed above.
- **Changing what `CEZ:ASK` renders.** `AskCard` (`packages/web/src/routes/task-thread/ask-card.tsx`)
  is untouched.

### The motivating run is evidence, not anecdote

**CORRECTED 2026-08-24.** This section was headed *"What I could not find"* and said the run
`232ad6d4` cited in the task context was **"treated here as anecdotal owner observation, not as a
documented incident"**. That was wrong, and it was wrong in the direction that matters: it
understated the evidence for the defect this spec fixes. The original claim is kept below the rule
because the half of it about the *curated* record is still true and still worth knowing.

The run's own transcript is on this box, and I read it directly:
`/var/lib/cezar/workspace/.ai/cezar/runs/232ad6d4-58a5-421e-941f-5c24bd5a8452.ndjson` (5.4 MB, run
on 2026-08-22, all of it inside `stepId: continue-4`). Seven events carry the whole reported
interaction, and each lines up with a phase of this spec:

| NDJSON seq | Event | What it proves |
|---|---|---|
| 1892 | `ask.requested`, header `"Next step"`, 06:38:02Z | The decision **was** asked correctly once, as a structured `CEZ:ASK`: *"The author work is committed and pushed as a green branch. How should I proceed, given that deploying fires the prune bug…"* |
| 1900 | `user-message`, *"I think prune is done - so just implement logic for this task"*, 11:52:59Z | The owner's redirect, which **answers** seq 1892. Everything after this point has a resolved ask in its history and no live one. |
| (no marker) | the park itself | Between 1900 and 2347 the agent finished that work and ended a turn with the same merge/deploy decision as trailing prose and no marker. That is the defect: a `waiting` park indistinguishable from a report. |
| 2347 | `user-message`, 12:16:29Z | The owner's report, unparaphrased: *"why this is \"The agent is paused, waiting for your reply\" - if agent needs any replay it needs to be done in interactive way with predefined questions and some suggest answer (like we already do for question)"*. |
| 2352, 2353, 2354 | assistant message `item_24` (`item.started`, `item.completed`, v1 `text`) | The agent's own diagnosis, which is this spec's problem statement: *"I did have a real pending question (merge and deploy, or not), but I left it as a sentence of prose instead of emitting `CEZ:ASK`… I used `CEZ:ASK` correctly earlier in this session for the same decision. When you redirected me to Phase 4, I answered that turn and never re-asked, so the decision quietly degraded from a structured question into a trailing remark."* It then states the rule this spec makes executable: *"if ending plainly, there must be a `CEZ:ASK`, those are the same thing."* That is **P1**. |
| 2360 | `ask.requested`, header `"Ship it?"` | The re-emitted structured ask, produced by a human complaint. **P4's bounded nudge automates exactly this prompt.** |
| 2361 | `user-message`, `"Ship it?: Merge and deploy\nGuardrail: File it"`, 12:18:03Z | Answered **by chip**, in one tap, 94 seconds after the complaint. This is the owner's requested outcome, reached the slow way. |
| 2370 to 2373 | `Bash` call + result | `cezar todo add` filed `c19d9d4a-4ce1-48dd-b92a-58dfb9e878f2`, the todo this task descends from. |

Two things in that sequence are load-bearing for the design, not merely corroborating:

1. **P4's nudge is a known-good intervention, not a guess.** Seq 2347 to 2360 is a human doing by
   hand what P4 does automatically: telling the agent its prose question should have been
   `CEZ:ASK`, and getting a valid marker back on the next turn. The agent complied immediately and
   without argument, which is the behaviour a one-shot cap (D6) assumes.
2. **P2 step 4's inverted notification precedence is proven necessary here.** At the markerless
   park, `readLastAskText` (`observer.ts:130-146`) scans backward for the last `ask.requested` with
   **no check that it was answered**, so it would have found **seq 1892** and pushed the owner a
   `run.needs-you` reading *"How should I proceed, given that deploying fires the prune bug…"*, a
   question the owner had already answered at seq 1900 and which had nothing to do with what the
   agent was actually stuck on. `askText`-first is not merely unhelpful on this run, it is wrong.

> **Superseded 2026-08-23 draft, kept because its narrower claim holds:** no KB entry, spec,
> changelog row or incident note describes this run. The only KB hits for
> `232ad6d4-58a5-421e-941f-5c24bd5a8452` describe an unrelated session-resume failure
> (`specs-32f212ac5410`), and other records naming the same run id concern separate resume, spool
> and worktree-prune incidents: **none of those may be cited as evidence for this defect.** The
> error was concluding from a silent *curated* record that the *primary* record was silent too.
> The run NDJSON is the primary record, and nobody had opened it.

Nothing in the design *depends* on the run (every phase is justified by the code), but the design
is no longer arguing from an owner's recollection.

## Solution

### Decisions

**D1 — Classify, don't interrogate.** A model call on every plain end would tax the common case
(a genuine final report) with latency and cost on every single run. A pure regex detector over the
tail of the turn text costs nothing and is exactly good enough for a *spend gate*.

**D2 — The detector never speaks for the agent.** Its two outputs are (a) a boolean deciding
whether to spend a nudge, and (b) the agent's own trailing sentence, verbatim and clipped, for
display. It never synthesises a question, never invents options, and never converts prose into an
`ask.requested` event. This is what satisfies acceptance criterion 3: a report-only turn is either
classified `report` (today's park, unchanged) or, on a false positive, nudged once and told
explicitly not to invent anything.

**D3 — The verdict is persisted on the run record, not derived client-side.** Three consumers need
it — the dock, the notification body, and restart recovery — and one of them (recovery) runs when
no client is attached. Persisting also means it survives a restart, which is precisely when the
"needs you" signal is easiest to lose.

**D4 — Both layers ship, and the UI layer is the floor.** The nudge is the outcome the owner asked
for (tappable options). The dock text is what covers a declined nudge, a spent cap, a dead session,
and a run recorded before the nudge existed. Neither replaces the other.

**D5 — The nudge fires *instead of* parking, not after it.** A nudged session is running, so
parking first would write a `waiting` the next turn immediately retracts — churning the run status,
the dock, and a `run.needs-you` notification whose body would be the useless default. Delivering
the nudge through `deliverMessage(runId, …, /* userAuthored */ false)` (`run.ts:3254`) is the same
seam `armMonitoringWakeTimer` uses at `run.ts:6230`, and it already sets `status: 'running'`, clears
the idle and wake timers, and appends **no** user-message event.

**D6 — One nudge per run.** `MAX_ASK_STRUCTURE_NUDGES = 1`. An agent that declined once has
answered the question. A cap of one cannot loop by construction, which is a stronger property than
the counter-based caps elsewhere in this file.

**D7 — The heuristic may cost attention, never progress.** `waitingReason` is a regex verdict;
`runHasPendingAsk` (`run.ts:6170`) is a fact about a marker the agent actually emitted. Where both
could feed one decision, only the fact may decide whether work continues. Concretely, at
`recover()`: a prose verdict may keep an already-finished run in the attention-bearing `review`
gate instead of `done`, because the worst case there is a run the owner glances at and dismisses;
it may **not** block chain re-entry, because the worst case there is a six-step pipeline that stops
at step two on a false positive, which is strictly worse than today and violates the AskUser spec's
"never makes the current behavior worse" bar this spec adopted. Same principle as D2: the detector
decides how loudly to ask for attention, never what the engine does next. P5 implements it.

### Decision table — what happens at a plain turn end

| Condition | Outcome |
|---|---|
| detector → `report` | `status: 'waiting'`, `waitingReason: 'report'`. Dock, notification and lifecycle **identical to today**. |
| detector → `question`, nudge available, session open | `ASK_STRUCTURE_NUDGE` delivered; run stays `running`. No park, no notification, no dock change *this* turn. |
| …and the agent replies with a valid `CEZ:ASK` | Today's ask path: `ask.requested`, `AskCard`, chips. **The owner's requested outcome.** |
| …and the agent replies plainly again | Park with `waitingReason: 'question'` + `waitingQuestion`. Dock shows the question; notification body carries it. |
| …and the agent replies `CEZ:DONE` | Today's completion path. The false positive resolved itself. |
| detector → `question`, nudge spent or session closed | Park with `waitingReason: 'question'` + `waitingQuestion` directly. |
| autonomous run, **twin B** (`runContinuation`) | Unreachable — `AUTONOMOUS_NUDGE` claims the branch first (the `autoContinued` IIFE, `run.ts:3782-3797`). |
| autonomous run, **twin A** (`runAgentStep`) | **Reachable — this is not symmetric, and an earlier draft of this table said it was.** `runAgentStep` has no autonomous branch at all: `waiting = interactive && sessionOpen` (`run.ts:5318`) is the only gate, `state.autonomous` / `state.autoContinues` / `AUTONOMOUS_NUDGE` exist only in `runContinuation`, and `run.test.ts:1279-1303` drives an `autonomous: true` `SINGLE_STEP` run straight through this branch. So: record `waitingReason`/`waitingQuestion` as normal, but **never spend a nudge** — the guard in P4 step 2 carries `!state.autonomous`. Nudging here would contradict `AUTONOMOUS_NUDGE`'s own *"Do not ask me for confirmation or clarification"* (`run.ts:350-351`). |
| budget exceeded | Unreachable — `budgetJustExceeded` claims the branch first (twin B `run.ts:3764`, twin A `run.ts:5319`). |
| mid-chain step, **twin A** (`runAgentStep`) | Unreachable — `waiting = interactive && sessionOpen` (`run.ts:5318`, the same line the autonomous row cites), and `interactive` (`run.ts:4584`) is false on a non-final step, so it never parks for the user. |
| mid-chain step, **twin B** (`runContinuation`) | **Reachable — an earlier draft of this table said "unreachable" flat, and that was twin-A reasoning applied to a site that does not share it.** Twin B's park gate is a bare `else if (sessionOpen)` (`run.ts:3781`) with no `interactive` and no chain gate at all — the same asymmetry `.ai/specs/2026-08-20-chain-integrity-restart-and-continuation.md` had to fix for `CEZ:DONE`. Mid-chain continuations demonstrably exist: `state.chainHandBack` is set at `run.ts:3753` and consumed at `:4096`/`:4215`, and `reenterChain` creates them at `:1854`, `:3444` and `:5136`. So a mid-chain continuation **does** reach the plain end: it records `waitingReason`/`waitingQuestion` and may spend the nudge, exactly like a final step. That is the intended behaviour (the agent is genuinely asking, and the chain is stalled until it is answered either way) — but it is the reason P5 must not let a *heuristic* verdict block chain re-entry. See P5. |

## Architecture

### The detector

New module `packages/cezar/src/core/turn-question.ts` — pure, total, no I/O, sibling of `ask.ts`:

```ts
export interface TrailingQuestion {
  /** The agent's own sentence, verbatim and clipped. Never synthesised. */
  text: string;
}
export function detectTrailingQuestion(turnText: string): TrailingQuestion | null;
```

Pipeline, in order:

1. **Strip fenced code blocks** (```` ``` ```` … ```` ``` ````). A `?` inside a shell snippet or a
   JSON payload is not a question to the user.
2. **Strip trailing protocol lines** — any line matching `^\s*CEZ:[A-Z_]+` (`CEZ:PR=`, `CEZ:ISSUE=`,
   `CEZ:TITLE=`, and any residual/malformed `CEZ:` line). These are noise, and `CEZ:TITLE=` in
   particular already caused a marker-absorption bug once (#623, `appendTurnText`, `run.ts:180-184`).
3. **Take the tail window** — the last non-empty paragraph, hard-capped at
   `QUESTION_SCAN_TAIL_CHARS = 1200`. A question to the user lives at the end of a turn; scanning
   the whole transcript would make a mid-report rhetorical `?` decide the outcome.
4. **Positive on either signal:**
   - a sentence terminating in `?` (a `?` followed by end-of-text or whitespace), or
   - `DECISION_CUE_RE` — a small, closed, second-person list: `let me know`, `do you want`,
     `would you like`, `should I`, `shall I`, `your call`, `please confirm`, `can you confirm`,
     `waiting (on|for) (you|your)`, `tell me which`, `which (do|would) you`. Deliberately tight:
     bare `confirm` matches *"I'll confirm the deploy"* and is excluded.
5. **`text`** = the last matching sentence, clipped to `TRAILING_QUESTION_MAX_CHARS = 280` with an
   ellipsis — the same shape `observer.ts:141-143` applies to `askText` (at its own bound,
   `ASK_TEXT_MAX_CHARS = 500`; 280 here matches the ask schema's own `description` bound,
   `ask.ts:21`, because this string renders in the dock rather than in a notification body).
6. **Otherwise `null`**, and every downstream path is byte-identical to today.

### Touch points

| Concern | File:line | Change |
|---|---|---|
| Marker contract prose | `packages/cezar/src/handoff.ts:146`, `:150` | P1 — pairing rule |
| Marker vocabulary doc | `BACKWARD_COMPATIBILITY.md` §8, lines 192-205 | P1 — add `CEZ:ASK`, add the pairing rule |
| Detector | `packages/cezar/src/core/turn-question.ts` *(new)* | P2 |
| Turn-end, twin A | **two sites, one commit.** Marker computation — the detector runs *here*, **before** `turnText = ''` (post-implementation: verdict at `run.ts:5304`, reset at `:5305`); then the `else if (waiting)` branch in `runAgentStep` (`:5335`), which calls `parkPlainEnd` at `:5371` with the already-computed verdict | P2 detect + record, P4 nudge |
| Turn-end, twin B | **two sites, one commit.** Same shape in `runContinuation`: verdict at `run.ts:3738`, reset at `:3739`; park/nudge inside `else if (sessionOpen)` → `if (!autoContinued)`, `parkPlainEnd` at `:3833` | P2 detect + record, P4 nudge |
| The shared method | `parkPlainEnd`, `run.ts:6339` | P2 + P4 — one method, both twins (R3) |
| Run record | `packages/cezar/src/runs/store.ts:335` (beside `activity`) | P2 — two optional fields |
| Record clearing | `store.ts:737-742` (open-time normalize, terminal statuses) and **one new choke point** in `updateRun`, `store.ts:870-884` | P2 step 2b — a status write clears them unless the patch is the park itself. **Not** a list of call sites: the landed code enumerated and missed five (`run.ts:2430`, `:4084`, `:4916`, `:4986`, `:5681`). |
| Cleared on reply | `run.ts:3302-3313` (`deliverMessage` success) | P2 — redundant once the choke point lands; harmless to keep |
| Wire contract | `packages/contract/src/runs.ts` — detail schema beside `activity` (`:325`), **landed** at `:327`/`:329`; summary schema `runIndexEntrySchema` beside `activity` (`:521`), **not landed** — see V3b | P2 |
| Notification body | `notifications/decider.ts:50-61` (`RunSnapshot`), `:120-121`; `observer.ts:92-110` (`toRunSnapshot`) | P2 — and the precedence **inverts** when `waitingReason === 'question'`: `waitingQuestion` outranks `askText`, because `readLastAskText` (`observer.ts:132-148`) does not check whether that ask was answered. See P2 step 4. |
| Nudge constant | `run.ts:348-353` (beside `MAX_AUTO_CONTINUES` `:349`, `AUTONOMOUS_NUDGE` `:350-351`, `MONITORING_WAKE_NUDGE` `:352-353`); landed as `MAX_ASK_STRUCTURE_NUDGES` `:356` + `ASK_STRUCTURE_NUDGE` `:360` | P4 |
| Nudge counter | `ActiveRun`, `run.ts:242-…` (beside `monitoringWakeups`) | P4 |
| Dock hint | `packages/web/src/routes/task-thread/task-thread.tsx:426-442` | P3 — nested `data-slot="waiting-question"` inside the existing `paused-hint`; the no-question branch keeps today's element tree |
| Restart recovery | `run.ts:1841` (the predicate), `run.ts:1854` (chain re-entry — **must keep the narrow one**), `run.ts:1861` (`settleSuccess`), `runHasPendingAsk` `run.ts:6170-6178` | P5 |
| **Dry-run mock** | `packages/cezar/scripts/mock-claude.mjs:91-143` (verb dispatch), `:514` (first-turn text), `:534` (follow-up text) | **P2/P4 — three new verbs + one fixture change; without them nothing below is executable.** See "The mock has to change first". |
| Tests pinning today | `run.test.ts:1456-1461`, `task-thread.test.tsx:227-238` | P2/P3 — extended, not weakened |

### The mock has to change first

Every test below runs against the bundled dry-run mock, `packages/cezar/scripts/mock-claude.mjs`,
and **as it stands the mock cannot produce three of the four turn shapes this spec needs.** I read
it: `:514` makes *every* first-turn reply end `"…Anything to adjust? (dry-run mock)"`, and `:534`
makes every follow-up reply `` `Follow-up #N received: "${userText.slice(0,100)}".${imgNote} Applied (dry run).` ``.
So, unchanged:

- there is **no plain-report turn at all** — the default reply is question-shaped, so the detector
  fires on it and V3's `waitingReason === 'report'` case is unproducible;
- a `runContinuation` turn **cannot end on a question** — the echoed user text is wrapped in
  quotes, so the tail reads `?".` and never matches step 4's "`?` followed by whitespace or
  end-of-text";
- the nudge **cannot be answered with a `CEZ:ASK`** — the mock emits one only when `userText`
  contains `mock:ask`, and `ASK_STRUCTURE_NUDGE` does not contain that string, so V5's upgrade
  path is undrivable.

Four changes, shipped with P2 (first two) and P4 (last two):

| Change | Effect |
|---|---|
| **Fixture:** drop `Anything to adjust?` from `:514`, so the default first-turn reply ends on a statement (`"…opened a draft PR: … (dry-run mock)"`). | The default dry-run turn becomes a **report**, not a question. This is what keeps every existing markerless park at one turn — see R9. Nothing asserts on that sentence: `grep -rn "Anything to adjust"` outside `node_modules` returns exactly one hit, `mock-claude.mjs:514` itself. |
| **`mock:question`** → append `\n\nSo: merge and deploy now, or hold for review?` to the reply, outside the quoted echo. **Sticky**, like `mock:ask-on-nudge` below: armed on the turn that names it and applied to every later turn too. | The one verb that drives the `question` branch, at either twin. Sticky because the decline path (V5 bullet 3) needs the *nudge* turn to end on a question as well, and the nudge text is cezar's, not the test's — a non-sticky verb could never reach that turn. |
| **`mock:report`** → force the plain statement ending even if other verbs are present; it **overrides** an armed `mock:question`. | An explicit, non-default-dependent report case for V3 and V6, and the only way to disarm stickiness mid-run. |
| **`mock:ask-on-nudge`** → sticky: recorded in a module-level `armed` set on the turn that names it; on any **later** turn whose `userText` contains the `ASK_STRUCTURE_NUDGE` sentinel, the reply carries the same valid `CEZ:ASK` payload `mock:ask` emits. | Drives V5's upgrade path. It must be **sticky and opt-in**, not "any turn carrying the nudge", or the decline path (V5 bullet 3) would become undrivable in the same breath. |

The sentinel is the nudge's own first clause (`You ended that turn with no marker`), living in
`run.ts` as `ASK_STRUCTURE_NUDGE` and imported nowhere by the mock — the mock is a separate process
and matches the literal substring, the same way it already matches `mock:` verbs.

**One existing verb has to get stricter for any of this to work.** The mock dispatches `CEZ:ASK` on
`userText.includes('mock:ask')` (`mock-claude.mjs:134`), and `'mock:ask-on-nudge'.includes('mock:ask')`
is `true` — so arming the nudge verb would make turn 1 emit a `CEZ:ASK` immediately, and the plain
end this spec is about would never happen. Tighten that one test to a word boundary
(`/(?:^|\s)mock:ask(?:\s|$)/`) in the same commit. It is not a behaviour change for any existing
caller: every current use passes `mock:ask` as a standalone token.

### State transitions this adds

```
turn-end, no marker
   │
   ├─ detect → report ──────────────────────► waiting  (waitingReason: 'report')     [today]
   │
   └─ detect → question
        ├─ nudge available & session open ──► running  (ASK_STRUCTURE_NUDGE sent)
        │      └─ next turn: CEZ:ASK ───────► waiting + ask.requested + AskCard
        │      └─ next turn: plain ─────────► waiting  (waitingReason: 'question')
        │      └─ next turn: CEZ:DONE ──────► done                                    [today]
        └─ nudge spent / session closed ────► waiting  (waitingReason: 'question')
```

Exits from `waitingReason: 'question'`, all of them enforced in **one** place — see P2 step 2:
any `updateRun` patch that writes a `status` and does not itself set `waitingReason`. That covers a
user reply (`deliverMessage`, `run.ts:3302-3313`), a continuation start (`run.ts:3649-3655`), a
`CEZ:ASK` or `CEZ:MONITORING` park on a later turn, a chain re-queue (`run.ts:2430`), an idle park
(`run.ts:4084`, `:4916`), an approval park (`run.ts:4986`), a native runner-emitted
`ask.requested` park (`run.ts:5681`), and every terminal status. A patch with no `status` key at all
(`{ autoResumeAttempts: undefined }`, `run.ts:3850`) leaves the park intact, which is what makes the
rule safe to state so broadly. A restart is the one exit that keeps the attention rather than the
text — P5's "Known limit".

## Data models

Additive, optional, `.catch`-degrading — the house rule for `RunRecord`
(`BACKWARD_COMPATIBILITY.md` §3). An older cezar reading a newer record ignores both keys; a newer
cezar reading an older record sees them absent, which resolves to today's dock hint.

`packages/cezar/src/runs/store.ts`, beside `activity` (`:335`):

```ts
/**
 * Why this run is parked at `waiting`, when it parked with NO turn-end marker
 * (spec 2026-08-23-plain-end-structured-question). `'question'` = the agent's
 * last turn ends on something addressed to the user; `'report'` = it does not.
 * Classified by `detectTrailingQuestion`, never by a model. Absent on every run
 * recorded before this shipped, and on every marked ending (`CEZ:ASK` owns its
 * own event). Cleared exactly where `activity` is.
 */
waitingReason: z.enum(['question', 'report']).optional(),
/**
 * The agent's OWN trailing sentence, verbatim and clipped to 280 chars — what
 * the dock and the `run.needs-you` body show. Never generated: absent whenever
 * `waitingReason !== 'question'`.
 */
waitingQuestion: z.string().max(280).optional().catch(undefined),
```

`packages/contract/src/runs.ts` mirrors both on the run detail schema (beside `activity`, `:325`)
and the summary schema `runIndexEntrySchema`, beside its own `activity` (`:521`) — the summary
carries it because the cross-project boards derive attention from it, the same argument `stopReason`
records at `:522-527`. **Only the detail half has landed** (`:327`, `:329`); `runIndexEntrySchema`
still carries `activity` and neither new field, so the summary mirror is work the implement step
still owes. V3b is its check.

`ActiveRun` (`run.ts:242`), beside `monitoringWakeups`:

```ts
/** Bounded re-emit nudges spent on this run (cap `MAX_ASK_STRUCTURE_NUDGES`).
 *  Process-local by design, like `monitoringWakeups`: a restart is a fresh epoch. */
askStructureNudges?: number;
```

Note the asymmetry in the two field declarations above: `waitingQuestion` carries
`.catch(undefined)` and `waitingReason` does not. That is deliberate and matches the `activity`
precedent (`store.ts:335`, itself an unguarded enum) — a `z.enum` of two literals has no partial
form to degrade *to*, so a `.catch` would silently rewrite a future third value into `undefined`
rather than surfacing it; the free-text field is the one where a malformed value is worth
swallowing. The §3 rule is satisfied by both being **optional**.

`RunSnapshot` (`notifications/decider.ts:50-61`) gains `waitingReason?: 'question' | 'report'` and
`waitingQuestion?: string`, populated by `observer.ts`'s snapshot builder (`:95-108`) straight off
the run record — no tail scan needed, unlike `askText`. Both are needed, not just the text: the
body precedence in P2 step 4 keys on `waitingReason` to decide whether `askText` is stale.

## API contracts

**No new endpoints, no new events.** Deliberate, and the same choice the AskUser spec made:

- The two new fields ride the existing `GET /api/runs/:id` / `/api/runs` payloads via
  `packages/contract/src/runs.ts`. `contract-parity*.test.ts` checks each schema against the route
  it describes, so no hand-mirror edit is needed (`packages/cezar/src/server/api-types.test.ts:1-40`
  explains why that file no longer pins these shapes).
- The nudge uses the in-process session seam (`deliverMessage`), not an HTTP route.
- A successful re-emit produces an ordinary `ask.requested` v2 event — already in the protocol
  (`BACKWARD_COMPATIBILITY.md` §7, `packages/cezar/src/core/ui-events.ts`), already replayed by
  `event-history.ts:109`. **No protocol version change, no golden-fixture churn, no parity-matrix
  entry.**

The one vocabulary change is the marker *contract* in `handoff.ts` — prose, not wire — which §8
governs. P1 states the pairing rule there; no marker is added, removed or renamed, so §8's
"required path" (parse the old spelling for a minor release) does not bind.

## Phases

Five, each independently shippable and independently valuable. P1 ships alone. P2 ships without
P3/P4 (better notifications, no UI change). P3 needs P2. P4 needs P2. P5 needs P2.

### P1 — the contract says it, as a rule

Docs only. Zero code risk, immediate effect on every session that starts afterwards.

1. `packages/cezar/src/handoff.ts:146` — replace the bare sanction
   (*"just end your message normally"*) with the pairing rule: ending plainly is for a turn the
   user only reads; **a turn that needs an answer ends with `CEZ:ASK`**, and a plain end that
   contains a question is a defect the engine will nudge you to fix. Keep the sentence short — this
   string is prepended to every agent step's system prompt.
2. `handoff.ts:150` (the `CEZ:ASK` paragraph) — state the same rule from the other side, and drop
   the "Prefer sensible defaults over asking" framing's ambiguity: preferring a default means *not
   asking at all*, never *asking in prose*.
3. `BACKWARD_COMPATIBILITY.md` §8 (lines 192-205) — add `CEZ:ASK` (#473) to the enumerated
   vocabulary. **This is a pre-existing omission**, independent of this task: §8 lists `CEZ:DONE`
   (#347), `CEZ:MONITORING` (#490) and the `CEZ:PR`/`CEZ:ISSUE`/`CEZ:TITLE` family, and `CEZ:ASK`
   shipped after §8 was last touched. Then record the pairing rule as part of the contract's
   meaning.
4. Extend `packages/cezar/src/workflows/system-prompt.test.ts` — its `describe('handoff contract
   markers')` block at `:163-170` already imports `HANDOFF_ONLY_INSTRUCTIONS` (`:7`) and already
   asserts `expect(HANDOFF_ONLY_INSTRUCTIONS).toContain('CEZ:ASK')` (`:165`), so the pairing rule
   belongs in exactly that block. `packages/cezar/src/handoff.test.ts` is the second place handoff
   prose is pinned; check it for an assertion on the bare-sanction sentence and update it in the
   same commit if one exists.

**Done when:** the three files agree, and a reader of §8 alone can enumerate all four endings.

### P2 — the engine classifies the plain end and records why

1. New `packages/cezar/src/core/turn-question.ts` + `turn-question.test.ts` (Architecture → The
   detector).
2. Two optional fields on `RunRecord`; mirror on both contract schemas.
2b. **Clearing is ONE choke point in the store, not a list of call sites.** This is the review
   defect the first draft shipped: "clear them exactly where `activity` is cleared" reads like a
   rule but is really an instruction to find ~12 sites, and the landed code found seven and missed
   five — `run.ts:2430` (chain re-queue to `queued`), `:4084` and `:4916` (idle parks), `:4986`
   (approval park) and `:5681` (a runner-emitted `ask.requested` park). All five write a status
   that is still in the live keep-list (`running|waiting|queued`), so `updateRun`'s existing
   terminal-status normalize (`store.ts:877-884`) does not save them, and a stale prose question
   survives into a state it does not describe. `:5681` is the worst of them: the dock would show
   last turn's prose question underneath a *fresh* `AskCard`, and P2 step 4's inverted precedence
   would prefer that stale text over the new ask's own `askText` in the notification body.

   So put the rule where it cannot be missed, in `RunStore.updateRun` (`store.ts:870`), beside the
   normalize that is already there:

   ```ts
   // A parked prose question describes ONE park. A patch that moves the run to a DIFFERENT status
   // is a new state, so the question does not carry into it — unless the patch is the park itself,
   // which says so by setting `waitingReason` in the same patch (spec
   // 2026-08-23-plain-end-structured-question, P2 step 2b).
   if (
     normalized.status &&
     normalized.status !== run.status &&
     !Object.prototype.hasOwnProperty.call(patch, 'waitingReason')
   ) {
     normalized.waitingReason = undefined;
     normalized.waitingQuestion = undefined;
   }
   ```

   **The `!== run.status` clause is load-bearing, and a choke point without it deletes the question
   in the one case the user needs it most.** Keyed on a status *write*, the rule also fires on a
   write that changes nothing, and there is one that matters: the idle park. After a run has sat at
   `waiting` for 15 minutes the idle timer closes the backend session to free the process
   (`state.idleParked`, set at `run.ts:6248`), and the wrap-up re-writes
   `{ status: 'waiting', activity: undefined, currentStepId: undefined }` at `run.ts:4916` (twin A)
   and `run.ts:4084` (twin B), with no `waitingReason` key. That is `waiting` to `waiting`: not a
   new state, the same park with its process reclaimed, and a user coming back after a quarter of an
   hour needs the question more than one who never left. Keyed on a *transition*, the idle park
   keeps it, and every hazard R11 enumerates still clears, because all of them cross a status
   boundary: `running` to `waiting` for the native-ask (`run.ts:5681`) and approval (`:4986`) parks,
   `waiting` to `queued` for the chain re-queue (`:2430`), `waiting` to `running` for a reply
   (`:3310`).

   `parkPlainEnd` is the only writer that sets `waitingReason` in a status patch, so it is the only
   thing exempt. Patches with no `status` key are untouched. With this in place the explicit
   `waitingReason: undefined` / `waitingQuestion: undefined` pairs the landed code added to
   `deliverMessage`, the continuation start and the four marked-ending park branches become
   redundant; keep them or drop them, but the choke point is what the tests assert against, because
   it is the only version that also covers the site nobody has thought of yet.
   `reconcileLoadedRun` (`store.ts:737-742`) keeps its own copy of the terminal-status clear — it
   runs on load, not through `updateRun`.
2a. The mock's fixture change and `mock:question` / `mock:report` (Architecture → "The mock has to
   change first"). This lands **in the same commit as the detector**, because the fixture change is
   what stops every pre-existing markerless dry-run park from gaining a turn (R9).
3. **At both turn-end sites, in the same commit — and at each site, in TWO places.**

   **Run the detector where the markers are computed, not where the run parks.** Both twins do
   `turnText = ''` *immediately* after computing `done`/`ask`/`monitoring` and before
   `spendBudgetUnit` — twin A at `run.ts:5305`, twin B at `run.ts:3739` (line numbers post-P2; the
   verdict now sits one line above each reset, at `:5304` and `:3738`). The park blocks are far
   below that reset (`:5335`, `:3781`), so a `parkPlainEnd(runId, stepId, turnText, state)` called at the
   park site would receive the **empty string** and the detector would return `null` on every run —
   the whole spec silently no-ops. So, alongside the three marker constants and above the reset:

   ```ts
   const trailingQuestion =
     !done && !ask && !monitoring ? detectTrailingQuestion(turnText) : null;
   ```

   (twin B's guard is the same three, since `ask`/`monitoring`/`done` are computed identically
   there.) Hoisting it here is also why it must sit next to the markers rather than be recomputed:
   the same reason the file already hoists `backendModel` — two copies of one expression is how the
   twins drift.

   Then, in the plain-end branch of the park block, call the shared private method
   `parkPlainEnd(runId, stepId, trailingQuestion, state)` — it takes the **verdict**, never the raw
   text — which writes `waitingReason` / `waitingQuestion` alongside the existing
   `status: 'waiting'` update. One method, called from both sites, so the twins cannot drift again;
   the chain-integrity spec's lesson is that two copies is the bug.
4. `RunSnapshot` gains `waitingReason` **and** `waitingQuestion`, populated by `observer.ts`'s
   snapshot builder, and `decider.ts:120-121`'s `run.needs-you` body becomes:

   ```ts
   body: (run.waitingReason === 'question' ? run.waitingQuestion : undefined)
     ?? run.askText ?? 'Waiting on you.'
   ```

   **The precedence inverts deliberately, and this spec's own motivating run is why.** The naive
   order (`askText` first) is wrong because `readLastAskText` (`observer.ts:130-146`) returns the
   last `ask.requested` in the scanned tail with **no check that it was answered** — unlike
   `runHasPendingAsk` (`run.ts:6170-6178`), which compares the `ask.requested` seq against the later
   `user-message` seq. Run `232ad6d4` is exactly that shape, and its own NDJSON says so rather than
   the owner's recollection: it asked correctly with `CEZ:ASK` earlier, the owner answered, and it
   *then* degraded into a prose park. The stale ask is seq 1892, its answer seq 1900, and the
   agent's own account of the degradation seq 2352-2354, all quoted in Problem → "The motivating
   run is evidence, not anecdote". Under `askText`-first the
   notification would carry the stale, already-answered question. A markerless park is by definition
   a turn that emitted no ask marker, so any `askText` present is necessarily from a superseded
   earlier turn — `waitingQuestion` is the only one describing what is being asked *now*. Outside
   `waitingReason === 'question'` (including `'report'`, where `waitingQuestion` is absent anyway)
   the order is unchanged: `askText`, then `'Waiting on you.'`.

**Ships without any UI change.** Visible value on its own: `run.needs-you` push/desktop
notifications stop saying "Waiting on you." and start saying what was asked.

### P3 — the cockpit stops being a dead end

`task-thread.tsx:426-442` — the question goes **inside** today's `data-slot="paused-hint"` block, as
a nested `data-slot="waiting-question"` panel, rather than forking the dock into two top-level
blocks:

- `run.waitingReason === 'question' && run.waitingQuestion` → the existing pulsing-dot line
  *"The agent is paused, waiting for your reply"* is kept, and the agent's own question renders
  under it in a bordered `bg-muted/40` panel at `text-sm text-foreground`. The composer is already
  directly underneath and already enabled, so the question and its reply affordance are adjacent.
- everything else (including every run recorded before P2) → today's markup and text, unchanged.

Two notes on this, both corrections to the first draft:

**One selector, not two.** The draft specified a separate top-level `data-slot="paused-question"`
block headed "The agent is asking". Nesting is better: everything that already keys on
`[data-slot="paused-hint"]` (`task-thread.test.tsx:227-238`, and the e2e specs that assert the
paused dock) keeps working, and there is exactly one answer to "is this run parked for the user",
which is the property the acceptance criteria are about.

**The `report` path must stay byte-identical, and the landed code does not quite manage it.** It
switched the shared wrapper from `items-center` to `items-start` and wrapped `StatusDot` in a
`<span className="pt-0.5">` for *every* `waiting` run, including report parks and pre-P2 records —
which is a (cosmetic) change to a path acceptance criterion 3 says must not change. Apply the
alignment change only on the branch that actually renders a question: compute the wrapper class
from `hasQuestion`, and leave the no-question branch emitting the same element tree it emits today.

**No fabrication is possible here:** the block renders `run.waitingQuestion` verbatim or renders
nothing at all.

### P4 — one bounded nudge, and the owner gets tappable options

1. `MAX_ASK_STRUCTURE_NUDGES = 1` and `ASK_STRUCTURE_NUDGE` beside the two existing nudge constants
   (`run.ts:344-349`). Draft text:

   > You ended that turn with no marker, which parks the task and tells the user to reply — but the
   > cockpit has nothing for them to tap. If you were asking them something, send it again now as a
   > single `CEZ:ASK <json>` line with 2–4 concrete options. If you were NOT asking anything, end
   > plainly again, or with CEZ:DONE if the goal is achieved — do not invent a question.

2. In `parkPlainEnd(runId, stepId, trailingQuestion, state)`, before writing `waiting`: when
   `trailingQuestion !== null` (the verdict computed at the marker site in P2 step 3 — the method
   never sees the turn text, which is already `''` by the time it is called),
   `(state.askStructureNudges ?? 0) < MAX_ASK_STRUCTURE_NUDGES`, `state.session?.open`,
   `!state.cancelled`, **and `!state.autonomous`** (the decision table's twin-A row: an autonomous
   run records the fields but is never asked to ask) → increment the counter, append a `note` event
   naming the spend (the shape `armMonitoringWakeTimer` uses, `run.ts:6220-6224`), and
   `this.deliverMessage(runId, [{ type: 'text', text: ASK_STRUCTURE_NUDGE }], false)`. On a `false`
   return, fall through to the park.

3. **What a `true` return skips, exactly — and what it must NOT skip.** "Return without parking" is
   only true of the park block itself. Both twins run more code *after* `else if (waiting)`, and
   jumping over it is a real regression:

   | Statement | On a nudge turn |
   |---|---|
   | `updateRun({status:'waiting', activity: undefined})` | **skipped** — `deliverMessage` already set `status: 'running'` |
   | `updateStep({status:'waiting'})` | **skipped** — the step is running |
   | `this.waiting.add(runId)` | **skipped** — the run is not waiting on the user |
   | `armIdleTimer(runId, state)` | **skipped** — a turn is in flight; the timer re-arms at the next turn end |
   | `releaseSlot()` | **skipped** — the run still holds its slot for the nudge turn |
   | `autoResumeAttempts` retirement (`run.ts:5383` twin A, `:3850` twin B) | **still runs.** This is what "releases the account hold for every other task queued behind it", and a completed turn is the evidence it keys on. Skipping it strands every run queued behind this one. |
   | `appendHandoffHeartbeat` (`run.ts:5392` twin A, `:3857` twin B) | **still runs**, reporting `status=running`. **The two twins do not share this expression** — twin A is `monitoring ? 'monitoring' : waiting ? 'waiting' : 'running'` (`run.ts:5392`) and twin B is `monitoring ? 'monitoring' : sessionOpen ? 'waiting' : 'running'` (`run.ts:3857`), keyed on different variables. The nudge path must not let either log `waiting` for a turn that is actually running, so **both** ternaries take the nudge result as a third input — two separate expressions to patch, not one. |

   Concretely: `parkPlainEnd` returns a boolean `nudged`, the caller guards **only** the park block
   with `if (!nudged)`, and the two trailing statements stay outside that guard.

4. Same code, one method, both twins — it is the shared method from P2, with the P2 step 3
   signature `parkPlainEnd(runId, stepId, trailingQuestion, state)`. The mock's
   `mock:ask-on-nudge` verb ships here, since V5's upgrade path is what proves this phase works.

### P5 — a restart does not drop a prose question either

`recover()` (`run.ts:1841`) computes `pendingAsk = this.runHasPendingAsk(run.id)` to keep a run with
an unanswered `CEZ:ASK` in the attention-bearing `review` gate instead of settling it to `done`
(`recover-pending-ask.test.ts:14-22`). A prose question is the same kind of unanswered attention and
must not settle either.

**But `pendingAsk` is used for two different things at that site, and only one of them may be
widened** (D7). This is the second review defect against the landed code, which widened the single
variable:

```ts
const pendingAsk = this.runHasPendingAsk(run.id) || run.waitingReason === 'question';  // WRONG
```

`pendingAsk` gates `settleSuccess` (`run.ts:1861`) — the attention decision, which this spec wants
widened — **and also** chain re-entry six lines earlier (`run.ts:1854`,
`if (!pendingAsk && (await this.reenterChain(settled, 'cezar restarted'))) continue;`). Widening
both means a **heuristic** prose verdict can stop a multi-step chain from resuming after a restart.
Per the decision table above, twin B parks mid-chain continuations, so that is reachable, not
theoretical: one `let me know` in a mid-chain turn and a six-step run that resumes today would sit
in `review` instead. That is strictly worse than today's behaviour, which is the one bar this spec
inherited from the AskUser spec and may not break.

The two decisions get two names:

```ts
/** An explicit, unanswered `CEZ:ASK` — the agent stated it cannot proceed. Strong enough to
 *  outrank chain re-entry. */
const pendingAsk = this.runHasPendingAsk(run.id);
/** …plus a heuristically-classified prose question. Strong enough to keep the run in `review`
 *  rather than settling it `done`, and deliberately NOT strong enough to stall the chain:
 *  `detectTrailingQuestion` guesses, and a guess must not outrank queued work (spec
 *  2026-08-23-plain-end-structured-question, P5). */
const pendingAttention = pendingAsk || run.waitingReason === 'question';
```

`run.ts:1854` keeps `!pendingAsk`; `settleSuccess(run.id, { pendingAsk: pendingAttention })` and the
lifecycle message above it take the wide one. Widen `runHasPendingAsk`'s doc comment
(`run.ts:6170`, post-P2 line number) to say the prose case is handled *beside* it, not inside it.
`waitingReason` survives
the restart because `waiting` is in the keep-list at `store.ts:737-742`, and because `recover()` only
ever runs against a store opened with `keepLive: true` (`index.ts:775`, `project-context.ts:428`),
so the `waiting` status is not reconciled to `failed` on the way in.

**Known limit, stated rather than fixed:** the `review` write that follows *clears* both fields, via
the same `updateRun` normalize (`store.ts:877-884`) our fields opt into, and under P2 step 2b's
choke point as well (`waiting` to `review` is a transition). So after a restart the run
keeps the owner's **attention** (`review`, not `done`) but loses the **question** — the dock reverts
to "Session closed — waiting for your review", which names no question. That is outside the
acceptance criteria (they scope the `waiting` dock, not the post-restart `review` gate), and
carrying the question into `review` would mean exempting these fields from a normalize rule the
spec otherwise leans on for its clearing semantics. Left as follow-up, named here so the next
session does not read the P5 test as covering it.

## Risks

| # | Risk | Mitigation |
|---|---|---|
| **R1** | **Detector false positive** — a report ending in a rhetorical `?` gets nudged. **The rate will be higher than "rhetorical `?`" suggests:** `let me know` is the single most common polite sign-off on a *finished* report ("Let me know if you want me to…"), so it is the cue most likely to fire on prose that needs no answer. | Costs one short turn, once per run — and the cost is not only latency: `spendBudgetUnit` runs once per turn (`run.ts:5250`, `:3715`; PLAN D27), so **each false positive also spends one step-budget unit**, which on a tight `stepBudgetOverride` can be the unit that trips the bound. Accepted because the failure is bounded at 1/run and self-correcting: the nudge text explicitly forbids inventing a question, and the agent can end plainly or `CEZ:DONE`. No fake ask card can result — only a valid `CEZ:ASK` mints one. If field data shows `let me know` dominating the false positives, drop that single cue; the list is designed to be edited one entry at a time. |
| **R2** | **Detector false negative** — a question with no `?` and no cue still dead-ends. | The floor is exactly today's behaviour, so the AskUser spec's bar ("never makes the current behavior worse") holds. P1 attacks the incidence at source, where the contract creates it. |
| **R3** | **The twin-site hazard** (`specs-172ddd891dd0`, Defect B). | One shared private method called from both sites, not two copies. V4 drives each path separately and would go red if only one were wired. |
| **R4** | **Notification timing** — the nudge delays `run.needs-you` by one turn. | Argued as an improvement (D5): the delayed notification carries a real question instead of `'Waiting on you.'`. If the nudged turn dies, the run lands `failed` and fires `run.failed`, which is correct and louder, not quieter. |
| **R5** | **New wire fields.** | Additive optional with `.catch` per §3/§5. Old cezars ignore them; old records read absent → today's dock hint. No protocol version bump (no new event type). |
| **R6** | **Detector cost / robustness** — it runs on every plain turn end. | Pure regex over ≤1200 chars of tail. Total by construction (returns `null` rather than throwing); `turn-question.test.ts` includes empty, whitespace-only, fence-only, and marker-only inputs. |
| **R7** | **Interaction with todo `751e69fb`** — a malformed `CEZ:ASK` leaves raw JSON in the turn text, which the detector might read as question-shaped (the payload contains `"question":"…?"`). **Narrower than it first looks:** the contract requires the payload on ONE line, and the detector's pipeline step 2 strips every line matching `^\s*CEZ:[A-Z_]+`, so a single-line rejected marker is stripped before step 4 ever sees it. The premise only holds for a **multi-line** malformed payload, where the continuation lines survive the strip. | Where it does fire, it is welcome rather than merely tolerated: nudging the agent to re-send the marker is the right response to a rejected payload, and `askMarkerRejection` already logs a `note` beside it. But it is an **incidental** benefit on a narrow input shape, not a mitigation this spec relies on, and it does **not** fix the parser bug — `751e69fb` stays separate work. |
| **R8** | **Prompt bloat** — P1 lengthens a string prepended to every agent step. | Net change is a rewrite of one sentence plus a clause, not a new paragraph. Keep it under the current paragraph's length; V1 asserts on the text. |
| **R9** | **Every existing dry-run park gains a turn.** The mock's default first-turn reply ends `"Anything to adjust?"` (`mock-claude.mjs:514`), which the detector reads as a question — so `run.test.ts:1459`, `:1486`, `:1595`, `:1602`, `:1619`, `:2350`, `:2437`, `:2466`, `:2545` and the `workspace-semaphore.test.ts` parks (`:230`, `:260`, `:436`, `:461`, `:471`) would each spend a nudge turn before reaching `waiting`. **The browser E2Es drive the same live mock and wait on the same status** — `packages/web/e2e/new-task.e2e.ts:198`, `ios-sweep.e2e.ts:93-95`, `review-gate.e2e.ts:130`, `task-thread.e2e.ts:197`, `composer.e2e.ts:106`/`:179`, `plan-mode.e2e.ts:256` — so they are exposed identically. Their `waitFor(status === 'waiting')` would still pass, but slower and for the wrong reason, and the semaphore tests time slot handoff. | **Chosen mitigation: change the fixture, not the tests.** Drop `Anything to adjust?` from `:514` so the default reply is a report, and move the question behind the explicit `mock:question` verb (Architecture → "The mock has to change first"). Nothing asserts on that sentence — one grep hit, the mock itself — so no test is rewritten and no park gains a turn — the browser E2Es above are covered by the same change, unchanged (I checked the one that reads reply text: `task-thread.e2e.ts:197` asserts on `prHref`, which survives dropping the sentence, and the golden fixture `__fixtures__/claude/bash-and-screenshot.expected.json:129` already carries the sentence-free text). The rejected alternative was widening every affected `waitFor`, which would have left the extra turn in place and made the slot-timing tests quietly less meaningful. |
| **R10** | **CORRECTED 2026-08-29: no longer the landed shape — `run.ts:2571`'s `pendingAttention` does not gate `reenterChain` at `HEAD` `0a46010b`; verified by direct read, see `.ai/specs/2026-08-29-plain-end-question-verification.md`.** The original 2026-08-24 finding follows unchanged: **A heuristic verdict stalls a real chain.** `waitingReason: 'question'` is a guess. If it also gates chain re-entry on restart, one `let me know` in a mid-chain continuation (reachable — see the decision table's twin-B row) leaves a multi-step run in `review` that today would have resumed. **The landed code has exactly this shape** (`run.ts:1841` widens the single `pendingAsk`, and `:1854` gates `reenterChain` on it). | P5's split predicate: `pendingAsk` (narrow, an explicit unanswered `CEZ:ASK`) keeps the chain gate; `pendingAttention` (wide) only decides `review`-vs-`done`. The rule generalises past this site, and is stated as D7: **a detector verdict may raise attention, never withhold work.** V7's second case is the executable form of it and is red against the landed code. |
| **R11** | **The clearing choke point over-clears.** A single rule in `updateRun` is only safe if no legitimate caller writes a `status` while intending to keep the park. | Checked every `updateRun` call that writes a live status (`running`/`waiting`/`queued`) — `run.ts:2430`, `:3310`, `:3649`, `:3809`, `:3823`, `:4084`, `:4916`, `:4986`, `:5347`, `:5361`, `:5681`, `:6365`. **Three** want the park kept, not one. The park itself (`parkPlainEnd`, `:6365`) is exempt by construction, because it is the patch that sets `waitingReason`. The other two are the idle parks (`:4084`, `:4916`), which write `waiting` over an existing `waiting` and are exempt only because of the `!== run.status` clause in P2 step 2b — an early draft of this rule omitted that clause and would have erased a live question after fifteen minutes of the user not answering it. Patches with no `status` key are untouched, so the "clear on reply" behaviour does not depend on this rule alone. V3a pins all three directions — and note the idle park is a **keep**, asserted as one: it is `waiting → waiting`, so a V that asserted it clears would be asserting against the clause this row exists to defend. |

## Verification

Run from the repo root, `/var/lib/cezar/loki-labs/cezar` (or this task's worktree). Gates are
`npm run typecheck` and `npm test` (root `package.json` scripts) — **there is no `lint` script in
this repo**, so do not report one as green.

**What has actually run, as of this revision:** the final gate pass exercised the named feature
regressions after the corrective patch. `npm run typecheck`, `npm run test:unit`, the production
build and `check-pack`, `npm run test:package`, both release-package dry runs and the focused
runs-index regression are green. Per V:

| V | In the tree? |
|---|---|
| V1 contract | **yes**: `system-prompt.test.ts`, *"pairs the plain end with CEZ:ASK as a rule, not a bare sanction"*, green |
| V2 detector unit | **yes**: `core/turn-question.test.ts`, 12 cases, green |
| V3 record | **yes, exercised**: report and question parks plus reply clearing are covered |
| V3a choke point | **yes, exercised**: direct store cases cover transitions, same-status idle park, no-status patch, and explicit replacement |
| V3b contract summary mirror | **yes, exercised**: both fields are in `runIndexEntrySchema`, the server projection, and the 20/20 workspace index regression |
| V4 both twins | **yes, exercised**: twin A and continuation twin cases cover the shared transition |
| V5 nudge bounded | **yes, exercised**: one-shot cap, no fabricated user message, upgrade, and autonomous exemption are covered |
| V5a stale-ask precedence | **yes**: `notifications/decider.test.ts:141`, *"a current prose question outranks stale ask text in run.needs-you"*, green |
| V6 dock | **yes**: `task-thread.test.tsx:241` and `:249`, both directions, green |
| V7 restart | **yes, exercised**: single-step attention and multi-step chain re-entry cases cover the split recovery predicates |
| V2a mock verbs | **yes, exercised**: report, question and sticky ask-on-nudge shapes are explicit |
| V8 runtime E2E | **no**, never run |
| V8 runtime E2E (2026-08-29) | **yes**: `packages/web/e2e/plain-end-question.e2e.ts`, `TEST_E2E_STATUS=passed`, all 3 cases; V5's discriminating mutation confirmed case A red / case C green — task `eba6cb05-f995-4fc3-9cf1-0852977296d1`, see `.ai/specs/2026-08-29-plain-end-question-verification.md` |

The root suite is red: 10,774 passed, 1 failed and 4 skipped. The sole failure is the C18
knowledge-catalog host-speed budget, reproduced on clean detached baseline `116c3ee1`. It is not
evidence against this feature, but the required full gate is still not green.

**CORRECTED 2026-08-29:** V8 ran and closed this gate — see the new table row above and the
current status block at the top of this file (task `eba6cb05-f995-4fc3-9cf1-0852977296d1`). The
sentence below is left as written on 2026-08-24, when it was true:

Per repo doctrine, gates green is necessary and not sufficient: **V8 is what makes this Done rather
than QA Needed, and V8 has never run.**

The named automated regressions were run after the three corrections landed. V8 remains the
unexecuted runtime gate.

**V1 — the contract change is pinned (P1).** `npm test -- system-prompt`. The assertions go in
`packages/cezar/src/workflows/system-prompt.test.ts:163-170` — the existing `describe('handoff
contract markers')` block, which already imports `HANDOFF_ONLY_INSTRUCTIONS` (`:7`) and already
asserts `toContain('CEZ:ASK')` (`:165`). Add: `HANDOFF_ONLY_INSTRUCTIONS` contains the pairing rule
and **no longer contains** the bare sanction *"just end your message normally"*; and the same for
`HANDOFF_INSTRUCTIONS`, the combined string every agent step receives (`:169` already tests it that
way). Also run `npm test -- handoff` for `packages/cezar/src/handoff.test.ts`, the second file that
pins handoff prose. Assert `BACKWARD_COMPATIBILITY.md` §8 names `CEZ:ASK` — a
`grep -n "CEZ:ASK" BACKWARD_COMPATIBILITY.md` returning a §8 line is the check.

**V2 — the detector, unit (P2).** New `packages/cezar/src/core/turn-question.test.ts`:
- positive: trailing `?`; each `DECISION_CUE_RE` cue in isolation; a question followed by a
  `CEZ:PR=12` line (stripping works); a question 400 chars long (clipped to 280 + ellipsis).
- negative: a report with no `?`; a `?` **inside** a fenced block only; a `?` in the first
  paragraph of a 3000-char turn with a plain closing paragraph (tail window works); `"I'll confirm
  the deploy."` (the excluded bare-`confirm` case); empty string; whitespace only; a turn that is
  nothing but `CEZ:TITLE=…`.
- totality: none of the above throws.

**V2a — the mock's own verbs (P2/P4).** Before anything below can be trusted, prove the fixture
change landed: `grep -n "Anything to adjust" packages/cezar/scripts/mock-claude.mjs` returns
nothing, and `node packages/cezar/scripts/mock-claude.mjs` driven with each of `mock:report`,
`mock:question` and `mock:ask-on-nudge` emits, respectively, a reply with no `?` and no cue, a reply
whose last sentence is a bare question, and (on a second turn carrying the nudge sentinel) a reply
ending in a valid `CEZ:ASK` line. Quote the three replies.

**V3 — the record (P2).** Extend `run.test.ts:1456-1461` rather than replacing it. Three cases,
`SINGLE_STEP` with the mock runner:
- `task: 'mock:report just do the thing'` → `status: 'waiting'`, `activity` undefined **and**
  `waitingReason === 'report'`, `waitingQuestion` undefined. The original assertion survives
  verbatim. (After the R9 fixture change the bare `'just do the thing'` task at `:1457` also lands
  here — `mock:report` is the explicit, default-independent form.)
- `task: 'mock:question ship it?'` → `waitingReason === 'question'` and `waitingQuestion` equal to
  the mock's own trailing sentence, verbatim.
- a reply via `manager.sendMessage(...)` → both fields undefined again (the `deliverMessage`
  clearing rule).

**V3a: the clearing choke point, unit (P2 step 2b). Implemented, not run in this step.** In
`packages/cezar/src/runs/store.test.ts`, against `RunStore` directly, so it tests the rule and not
one caller's use of it. Every case starts from the same park: `updateRun(id, { status: 'waiting',
waitingReason: 'question', waitingQuestion: 'Merge or hold?' })`.

**Drive real transitions, not a repeated write of the status the record already has.** The rule is
keyed on `normalized.status !== run.status`, so after that park the record *is* `waiting`, and a
bare `updateRun(id, { status: 'waiting' })` is `waiting → waiting` — the case the clause
deliberately exempts. An earlier draft of this V asserted that write *clears*, which is
unsatisfiable against the rule P2 step 2b specifies and would have pushed an implementer to delete
the clause R11 calls load-bearing. It also mis-described the site: the runner-emitted
`ask.requested` park (`run.ts:5681`) fires **mid-turn**, from `running`, never from `waiting`.

**Clears** — assert both fields `undefined` after each, from a fresh park:
- `updateRun(id, { status: 'queued' })` — the chain re-queue, `run.ts:2430` (`waiting → queued`).
- `updateRun(id, { status: 'running' })` — a reply, `run.ts:3310` (`waiting → running`).
- `updateRun(id, { status: 'done' })` — terminal; belt-and-braces, since `store.ts:877-883`'s
  existing terminal clear covers it too.
- **the `run.ts:5681` / `:4986` shape, driven as it actually happens**: `updateRun(id, { status:
  'running' })` to leave the park, *then* `updateRun(id, { status: 'waiting' })` — the native-ask
  and approval parks. Assert both fields are still `undefined` after the second write, i.e. the
  first transition cleared them and the second did not resurrect them.

**Keeps** — assert both fields survive intact:
- `updateRun(id, { status: 'waiting', activity: undefined, currentStepId: undefined })` — the idle
  park's re-write (`run.ts:4084`, `:4916`), `waiting → waiting`. **This is the case the `!==
  run.status` clause exists for**, and the one R11 says an early draft would have erased after
  fifteen minutes of the user not answering.
- `updateRun(id, { autoResumeAttempts: undefined })` — no `status` key at all.
- a patch that carries `waitingReason` alongside a status keeps **what it sets** (the
  `parkPlainEnd` exemption): `updateRun(id, { status: 'waiting', waitingReason: 'report',
  waitingQuestion: undefined })` leaves `waitingReason === 'report'`.

Those clearing cases are exactly the shapes the landed enumeration missed, which is why this is one
store test rather than five more engine tests.

**V3b: the summary schema carries both fields (P2). Implemented, not run in this step.** `grep -n 'waitingReason' packages/contract/src/runs.ts`
must return a hit inside `runIndexEntrySchema` (`:499-…`), not only the detail schema's `:327`.
Then `npm test -- contract-parity`, which checks each schema against the route it describes, so the
`GET /api/runs` payload and the summary schema cannot drift apart. Without this, a cross-project
board sees `status: 'waiting'` with no reason and reproduces the dead end one level up from the
thread the dock already fixed.

**V4 — both twins, separately (P2/P4). This is the test R3 exists for.**
- `runAgentStep` path: `startRun(SINGLE_STEP, { task: 'mock:question ship it?' })` — the first turn
  ends plainly with a question.
- `runContinuation` path: park a run on `mock:report`, then
  `sendMessage([{ text: 'mock:question and now?' }])` — because `mock:question` appends its sentence
  *outside* the quoted echo at `:534`, the continuation turn ends on a real trailing question. (This
  is precisely what the unmodified mock could not do: the echo wraps user text in quotes, so the
  tail reads `?".` and the detector's step-4 rule never matches.)
Assert the same `waitingReason`/nudge outcome on both. **Then prove it discriminates:** revert the
call at one site only, re-run, and confirm exactly one of the two goes red. Quote both outputs. A
pair of tests that stay green with one site reverted does not satisfy R3 and blocks the merge.

**V5 — the nudge is bounded and does not fabricate (P4).** Modelled on the existing
`run.test.ts:1438-1453` monitoring-wake test, whose assertions are the right ones:
- the `note` event naming the nudge appears exactly once;
- **no `user-message` event is appended** (`events.some(e => e.type === 'user-message')` is `false`)
  — the nudge is not a fabricated user turn;
- **the decline path** — `task: 'mock:question ship it?'`: the mock answers the nudge with more
  prose, so the run parks with `waitingReason: 'question'`, and a second plain question end on the
  same run appends **no** second nudge note (cap of 1 holds);
- **the upgrade path** — `task: 'mock:ask-on-nudge mock:question ship it?'`: the verb arms on turn
  1, the nudge arrives, and turn 2 carries a valid `CEZ:ASK`. Assert an `ask.requested` event and no
  `waitingReason` on the record — i.e. the owner's requested outcome, tappable chips, actually
  reached. Without this verb the mock can never emit `CEZ:ASK` in response to the nudge
  (`ASK_STRUCTURE_NUDGE` contains no `mock:ask` substring), and this bullet is untestable;
- **the autonomous exemption** — `startRun(SINGLE_STEP, { task: 'mock:question ship it?',
  autonomous: true })` reaches twin A (`run.test.ts:1279-1303` proves that branch is live for
  autonomous runs) and must park with `waitingReason: 'question'` and **zero** nudge notes.

**V5a — the stale-ask precedence (P2 step 4). This is the case run `232ad6d4` actually hit.** Drive,
in order, on one run: `task: 'mock:ask ship it?'` → wait for `ask.requested` → answer it with
`manager.sendMessage(...)` → send `mock:question and now?` → wait for `waiting`. Build the
notification through the real path (`observer.ts`'s snapshot builder + `decider.ts`, the same seam
the existing notification tests use) and assert the `run.needs-you` body is the **prose** question
the last turn ended on, **not** the earlier ask's text — which is still what `readLastAskText`
returns, since it does not check for an answer. A naive `askText ?? waitingQuestion` ordering makes
this bullet go red; that is the point of it. Also assert the negative control: with no
`waitingReason` at all (a `mock:report` park on a run that has a pending, *unanswered* `CEZ:ASK`),
the body is still `askText` — the inversion must not swallow the legitimate case.

**V6 — the cockpit surface (P3), and the acceptance criterion that names it.**
`packages/web/src/routes/task-thread/task-thread.test.tsx`:
- `run('waiting', { waitingReason: 'question', waitingQuestion: 'Merge and deploy, or hold?' })`
  → `[data-slot="waiting-question"]` exists **inside** `[data-slot="paused-hint"]`, contains that
  text, and the reply textarea is enabled. **The dead-end assertion:** the dock contains the
  question text, so a passing test is proof the user is not told to reply with nothing to reply to.
- `run('waiting', { waitingReason: 'report' })` and `run('waiting')` (no fields at all — the
  pre-P2 record) → the existing test at `:227-238` passes **unchanged**, and
  `[data-slot="waiting-question"]` is absent. This is acceptance criterion 3, executable. Assert
  the wrapper's `className` too, per P3's second note: the report path must not pick up the
  question path's `items-start` alignment.

**V7 — restart recovery, and the chain it must not stall (P5).** Extend
`packages/cezar/src/workflows/recover-pending-ask.test.ts` with two cases:
- a **single-step** run parked at `waiting` carrying `waitingReason: 'question'` and **no**
  `ask.requested` event: after `recover()`, assert `review`, not `done`. **Implemented in the
  2026-08-24 step**, correcting an earlier draft of this section: `recover-pending-ask.test.ts` covers
  the unanswered ask, the answered ask and a plain `waiting` run with no ask at all, and none of
  the three sets `waitingReason`.
- **the regression the split predicate exists for, implemented in the 2026-08-24 step:** a *multi-step* run
  whose current step is parked at `waiting` with `waitingReason: 'question'`, later steps still
  pending, and no `ask.requested` event — after `recover()`, assert the chain **re-entered** (the
  next step is `queued`/`running`, a `chain re-queued at step` lifecycle event is present) and the
  run is **not** in `review`. Against the landed wide predicate this goes red; against P5's split
  it passes. Then the twin control: the same shape with a real unanswered `ask.requested` **does**
  stay parked and does not re-enter — an explicit ask still outranks the chain
  (`recover-pending-ask.test.ts` already covers the settle half of that).

**SUPERSEDED 2026-08-29 by `packages/web/e2e/plain-end-question.e2e.ts`.** This manual runbook was
never run — a manual gate in a spec is a gate that does not run — and is replaced by an automated
E2E covering the same three cases plus the NDJSON `note` assertion below, executed under task
`eba6cb05-f995-4fc3-9cf1-0852977296d1` (`TEST_E2E_STATUS=passed`). Do not follow the runbook below;
it is left as the record of what V8 originally asked for.

**V8 — runtime E2E on `prod-host`. Until this has actually run, this is QA Needed, not Done.**
Start a real task whose agent is instructed to end a turn with a question in prose and no marker.
Confirm, in order: (a) the `note` event recording the nudge appears in `.ai/cezar/runs/<id>.ndjson`;
(b) the follow-up turn carries a `CEZ:ASK` and the cockpit renders tappable chips; (c) tapping one
resumes the run. Then repeat with an agent instructed to refuse to re-emit, and confirm the dock
shows the quoted question above an enabled composer. Then repeat with a genuine final report and
confirm the park is visually identical to today. Capture screenshots into the run's handoff.

## Sources read

Read directly for this spec, at the paths and lines cited above:

- `packages/cezar/src/handoff.ts:131-158` — the marker contract, all four endings.
- `packages/cezar/src/workflows/run.ts` — `:155-213` (marker regexes, `appendTurnText`,
  `emitAskRequested`, `askMarkerRejection`), `:242-300` (`ActiveRun`), `:344-349` (the two nudge
  constants), `:1820-1851` (`recover`), `:3254-3300` (`deliverMessage`), `:3660-3790`
  (`runContinuation` turn-end), `:4520-4540` (`interactive`), `:5200-5300` (`runAgentStep`
  turn-end), `:6017-6095` (`settleSuccess`, `runHasPendingAsk`), `:6180-6240`
  (`armMonitoringWakeTimer`).
- `packages/cezar/src/core/ask.ts` — whole file (schema, `ASK_MARKER_RE`, `parseAskMarkerResult`,
  `stripAskMarker`).
- `packages/cezar/src/runs/store.ts:325-345`, `:715-735`, `:855-870` — the run record and both
  clearing sites.
- `packages/contract/src/runs.ts:110-114`, `:304`, `:325-329`, `:510-530` — the wire schemas.
- `packages/cezar/src/notifications/decider.ts:37-130` and `observer.ts:95-146` — `run.needs-you`
  and the `askText` tail scan.
- `packages/web/src/routes/task-thread/` — `thread-state.ts:40-95`, `:150-200`, `:650-690`;
  `task-thread.tsx:380-450`; `ask-card.tsx` (whole file).
- Tests pinning current behaviour: `run.test.ts:1279-1305` (the autonomous `SINGLE_STEP` run that
  proves twin A has no autonomous branch), `:1430-1490`, `:1555-1625`,
  `workflows/system-prompt.test.ts:150-172` (the `handoff contract markers` block),
  `task-thread.test.tsx:215-245`, `recover-pending-ask.test.ts:1-60`, `core/ask.test.ts` (case
  list), `server/api-types.test.ts:1-40`. `packages/cezar/src/handoff.test.ts` — existence and
  marker greps only, not the whole file.
- `packages/cezar/scripts/mock-claude.mjs:80-150` (verb dispatch), `:495-545` (both reply emitters)
  — read in full for the fixture and verb changes in "The mock has to change first".
- Everything else that drives that mock and waits on `waiting`, checked for exposure to the fixture
  change (R9): `packages/web/e2e/new-task.e2e.ts:198`, `ios-sweep.e2e.ts:93-95`,
  `review-gate.e2e.ts:130`, `task-thread.e2e.ts:197`, `composer.e2e.ts:106`/`:179`,
  `plan-mode.e2e.ts:256`, and the golden fixture
  `__fixtures__/claude/bash-and-screenshot.expected.json:129`.
- `BACKWARD_COMPATIBILITY.md` §7-§8, lines ~180-205.
- Specs: `.ai/specs/2026-07-18-askuser-across-runners.md` (KB `specs-38aca129d002`),
  `.ai/specs/2026-08-20-chain-integrity-restart-and-continuation.md` (KB `specs-172ddd891dd0`),
  and, via the brief, `specs-d950199213ce` / `specs-4be0b8284bab` / `specs-320f8ce97e1a`
  (monitoring's liveness bounds) and `specs-96d29b2df507`.
- `.ai/specs/briefs/2026-08-23-plain-end-structured-question.md` — this run's step-1 brief.

Not read, and flagged as such rather than assumed: `recover-pending-ask.test.ts` beyond line 60,
the body of `handoff.test.ts`, and `ui-parity.test.ts` (no parity entry is added, so it should not
be affected — V-gates will say).

**Read for this revision, on top of the list above** — the code that has since landed, re-read
rather than assumed: `git show --stat d47ec1e6` and the full `git diff 84fb8237` for
`workflows/run.ts`, `runs/store.ts`, `contract/src/runs.ts`, `handoff.ts`, `BACKWARD_COMPATIBILITY.md`,
`notifications/decider.ts`, `notifications/observer.ts`, `web/.../task-thread.tsx` and
`scripts/mock-claude.mjs`; `core/turn-question.ts` and `core/turn-question.test.ts` in full; the
twelve `activity: undefined` call sites in `run.ts` and the status each writes, which is where P2
step 2b's five missed sites and R11's exemption list come from; `recover()` at `run.ts:1830-1900`,
where P5's two uses of one variable are visible six lines apart; and twin B's park gate at
`run.ts:3781` plus the `chainHandBack`/`reenterChain` sites (`:3753`, `:4096`, `:4215`, `:1854`,
`:3444`, `:5136`) that make the decision table's twin-B row reachable.

**Read for the 2026-08-24 revision, on top of both lists above:**

- `/var/lib/cezar/workspace/.ai/cezar/runs/232ad6d4-58a5-421e-941f-5c24bd5a8452.ndjson`, the
  motivating run's primary record, read at seq 1892, 1900, 2347, 2352, 2353, 2354, 2360, 2361 and
  2370-2373, plus a full `grep` for `ask.requested` (three hits: 1892, 2360, 3126). This is the
  file the "What I could not find" section had never opened; see the correction in Problem.
- The refreshed step-1 brief, `.ai/specs/briefs/2026-08-23-plain-end-structured-question.md`
  (re-gathered 2026-08-24), which carries that correction and the current-code location table.
- `git log --format='%h %ci %s' -3`, `git diff --stat HEAD -- packages/` (empty), and
  `git log -L 870,890:packages/cezar/src/runs/store.ts`, used to establish that the tree is exactly
  `d47ec1e6` + `116c3ee1`, that the `updateRun` normalize our fields opt into landed in `d47ec1e6`,
  and therefore that P2 step 2b's defect is still open rather than already fixed by the second
  autosave.
- Re-verified, line by line rather than assumed current: `run.ts:1841`, `:1854`, `:1861`, `:3781`,
  `:3833`, `:5304`, `:5371`, `:6339`, `:356`, `:360`; `store.ts:330-352` and the `updateRun` body at
  `:870`; `contract/src/runs.ts:320-332`; `task-thread.tsx:420-452`; `handoff.ts:146-150`;
  `BACKWARD_COMPATIBILITY.md` §8; and `core/turn-question.ts` in full. All matched except
  `runHasPendingAsk`, cited three times as `run.ts:6086-6094/6095`, a pre-P2 line number the
  previous revision missed. It is at `run.ts:6170-6178`; all three are corrected.

**Corrected in this revision (2nd review pass):** the three defects listed under **Status** —
the decision table's mid-chain row, P5's single widened predicate, and P2's call-site-enumeration
approach to clearing. Also reconciled to what landed rather than what was drafted: P3 nests
`data-slot="waiting-question"` inside `paused-hint` instead of adding a second top-level block,
`mock:question` is sticky and `mock:report` overrides it, and the mock's `mock:ask` test needed a
word boundary so `mock:ask-on-nudge` would not fire it on turn 1.

**Corrected in review (1st pass):** an earlier draft cited `packages/cezar/src/core/system-prompt.test.ts` and
hedged that its contents were unread. That path does not exist — the file is
`packages/cezar/src/workflows/system-prompt.test.ts`, it has been read, and V1/P1 now name it
directly. An earlier draft also called the autonomous branch unreachable at both turn-end twins; it
is reachable at `runAgentStep`, which is why P4 carries `!state.autonomous`.

**Corrected in the second review pass**, both against re-read code:

- An earlier draft called the detector from the park block, passing `turnText`. **`turnText` is
  already `''` there** — both twins reset it right after the marker constants and before
  `spendBudgetUnit` (twin A `run.ts:5247`, twin B `run.ts:3712`), so the detector would have
  returned `null` on every run and this spec would have shipped as a silent no-op. P2 step 3 now
  computes the verdict at the marker site and `parkPlainEnd` takes the verdict, not the text.
- An earlier draft ordered the notification body `askText` first. That is backwards for this
  spec's own motivating run: `readLastAskText` (`observer.ts:130-146`) does **not** check whether
  the ask was answered, unlike `runHasPendingAsk` (`run.ts:6170-6178`), so an
  ask-then-answer-then-prose-park run would have been notified with the stale earlier question. P2
  step 4 inverts the precedence when `waitingReason === 'question'`; V5a is the test.
