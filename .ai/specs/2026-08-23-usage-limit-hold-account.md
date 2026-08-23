# A usage limit holds the account it was refused on, and the cockpit says so

**Status:** Implemented — QA Needed until V5 (a real held row in the deployed cockpit) is seen on
the box. Deployed to `prod-host` at 12:23 UTC, **rolled back at 12:27** on the note storm
described in TLDR item 4, and redeployed with the memo fix.
**Date:** 2026-08-23
**Reported:** the owner, from production: *"I added a task on custom model codex, but it's queued
for some reason, when all the rest of tasks is scheduled: scheduled tasks shouldn't be counted as
currently running I think"* — task `7c01e21d-49af-416a-bbe5-4be681b6ac9a` on `prod-host`.
**Extends:** `.ai/specs/2026-08-03-auto-resume-after-usage-limit.md`. It reverses nothing there:
the hold, the schedule and the in-flight rule all stand. This fixes the KEY the hold is filed
under, the DATE shape the schedule is read from, and the silence around both.

## TLDR

Three defects, one report. A codex task sat `queued` for hours with a free slot and nothing
running:

1. **The hold named the wrong account.** `RunManager.accountHolds()` built its key from the RUN
   record (`runner` + `agentProfile`) while the account a provider actually refused is on the
   STEP that ran. A run's steps do not all run on the run's own backend: `spec-to-deploy` pins
   `spec` and `review-spec` to `claude`, and the account pool routes freely. So a Claude weekly
   limit was filed under `codex:default` — blocking every codex task, and leaving `claude:default`
   unheld so a real Claude task would have walked straight into the closed window. One wrong key
   broke the gate in both directions.
2. **The wake time was three days early.** `parseUsageLimit` had no shape for a named date, so
   `resets Aug 26, 11pm (UTC)` fell through to the clock tier, which skips whatever sits between
   the reset word and the clock. It read "11pm" and scheduled TODAY at 23:00.
3. **Nothing said any of this.** A held run is byte-identical to an ordinary queued one: status
   `queued`, `#1 in queue`, no movement. The only existing note fires on the spawn path
   (`requeueWhileHeld`), which a run held at dequeue never reaches.

4. **A fourth defect, found by deploying the first three.** With the hold keyed correctly, the
   codex task was admitted by the queue and refused by the spawn — and bounced between them at
   about eleven round trips a second, writing a transcript note on every one. 2626 notes in the
   four minutes the fix was live, which is what the rollback below was for. The two gates ask
   about different accounts: `pump()` reads the run RECORD, `execute()` reads what the dispatch
   actually resolves (a `pool:` route picks the PROVIDER too, which is how a codex task comes to
   run every step on claude accounts). That disagreement predates this spec; keying the hold
   correctly is simply what made it reachable, because before it the run never got past admission.

The reporter's own hypothesis — that scheduled tasks are counted as running — is not what
happened. `maxParallel` was 5, nothing was running, and a scheduled run correctly holds no slot.
The blocker was the account hold, misfiled.

## Problem

### Measured, on the box (2026-08-23, `prod-host`)

`/var/lib/cezar/workspace/.ai/cezar/runs.json`, two runs:

| run | status | run-level | the step that ran |
| --- | --- | --- | --- |
| `76680e19` | `failed`, `autoResumeAt: 2026-08-23T23:00:30Z` | `runner: codex`, `agentProfile: default` | `review-spec` on **`claude` / `default`** |
| `7c01e21d` | `queued` since 11:28:17Z | `runner: codex`, no profile | never started |

`76680e19`'s error, verbatim:

```
step "review-spec" failed: You've hit your weekly limit · resets Aug 26, 11pm (UTC)
```

Its steps show the split plainly — `context` and `spec` on `claude:secondary`, `review-spec` on
`claude:default` — because the built-in `spec-to-deploy` workflow carries `runner: claude` on the
`spec` and `review-spec` steps regardless of what the task was started on.

So the workspace state was:

- hold computed: `codex:default` (from the run record)
- account actually closed: `claude:default` (from the step)
- queued task's account: `codex:default` → **held**, until 23:00:30Z, by a limit that was not on
  its account and did not lift until Aug 26.

`workspace/semaphore.ts` and `workflows/run.ts` both state the invariant this violated: *"a Claude
limit must never stall a Codex task"*.

### Why the date was wrong

`RESET_AT_RE` requires an ISO date, so `Aug 26` never matched it. `RESET_CLOCK_RE` then matched,
because its `[^\n]{0,24}?` skip steps over `Aug 26,` and finds `11pm (UTC)`. `nextClockInTimeZone`
answers with the next occurrence of 23:00 UTC, which was that same evening.

The cost is not one early wake. At 23:00 the run resumes, hits the still-shut weekly window, spends
one of `MAX_AUTO_RESUMES` (12), re-arms for the next 23:00, and repeats nightly until Aug 26 —
holding the mis-keyed `codex:default` block the whole time.

### Why nobody could see it

`pump()` skips a held run with `this.queue.findIndex(...)` and writes nothing. The record keeps
`status: 'queued'`; `queuePositions()` still counts it `#1`; `deriveAttention()` returns the plain
`queued` pill. The cockpit's only account-aware surface is the Agents panel, which reports usage,
not who is waiting on it.

## Solution

### 1. Key the hold on the account that was refused

New `packages/contract/src/usage-hold.ts` holds all three key functions, and the split is the fix:

- `runAccountKey(run, fallbackRunner)` — where this run's work WILL go. The admission side, used
  by `accountHeldFor` and by the cockpit. Moved from `workflows/run.ts` unchanged.
- `usageHoldAccountKey(run, fallbackRunner)` — which account was REFUSED. Reads the newest failed
  step that names a backend, then the newest stamped step (the in-flight resume), then the run
  record as a floor for pre-backend-affinity records.
- `accountUsageKey(provider, accountId)` — moved here from `workspace/agent-account-usage.ts`,
  which now re-exports it. It had to move because the browser cannot import that module (it reads
  `node:fs/promises`), and a second spelling of the key in the web package would silently match
  nothing.

`accountHolds()` calls `usageHoldAccountKey`. Nothing else changes: the deadline/in-flight split,
the resume exemption and the watchdog all read the same set they always did.

### 2. Teach the parser the named-date shape

A third tier in `parseUsageLimit`, between the ISO timestamp and the clock: `RESET_NAMED_DATE_RE`
matches a month name and day (either order, optional year) anchored on the same reset words. The
clock is then read from the text immediately AFTER the date, so a long date cannot push its own
clock past the anchor's 24-character skip window. No clock behind the date reads as local midnight
on that day, exactly as a date-only ISO reset already does.

**A recognized date that cannot be turned into an instant returns `null` instead of falling
through to the clock tier.** That is the whole point: falling through is what produced the
three-day-early schedule, and no schedule (the run stays `failed` with its Continue button) beats a
schedule that is wrong in the early direction.

### 3. Say why, in both places a person looks

- **Transcript:** `noteHeldRuns()` runs at the top of every pump sweep and writes one note per held
  run naming the account and the instant it reopens. Deduped per account, so a long hold does not
  repeat on every sweep and a hold that moves to a different account speaks again.
  `requeueWhileHeld`'s existing spawn-path note now goes through the same helper, so the two say
  the same thing in the same words and cannot double up.
- **List rows:** `packages/web/src/lib/account-hold.ts` derives the held accounts from the runs the
  cockpit already has, using the engine's own key functions. A held queued row's status pill gains
  `held <when>` with the full explanation on hover, and its queue cell reads `#1 held` rather than
  `#1 in queue`, which claims it is next.

  The row stays **silent when the run names no runner and the workspace default is unknown**: the
  account would be a guess, and a confident wrong sentence is worse than none.

### 4. Stop the two gates trading a run back and forth

`heldAtSpawn` (run id -> the account key `requeueWhileHeld` refused it on) is consulted by
`pump()`'s admission predicate through `heldAccountFor`. It is a MEMO of the spawn gate's verdict,
not a second source of truth: the remembered account must still be held at the moment it is read,
and a stale one is dropped on read, so the memo can only ever delay a start the spawn gate was
about to refuse anyway. A hold that moves to another account costs one more bounce, which records
the new account and settles — bounded by the number of accounts, not by time.

Admission deliberately does NOT resolve the pool itself. `resolvePoolForDispatch` advances the
round-robin cursor as a side effect (that is what stops a burst of dispatches stacking onto one
least-recently-used account), so asking it per sweep would corrupt the balancer. The memo learns
the answer from the one place allowed to compute it.

Two smaller repairs in the same area, both found by the same production run:

- **The forced sweep no longer runs the note pass.** A watchdog sweep reads `NO_HOLDS` by
  construction — an instruction to ignore the holds, never evidence that none exist — and letting
  it through the note pass cleared the dedupe state on every tick, so the next ordinary sweep said
  everything again. That is why two idle queued runs each carried exactly two notes.
- **`requeueWhileHeld` computes its account once** and reuses it for the gate, the memo and the
  note, so the three cannot disagree about which account refused the run.

### 5. Run the contract package's tests

`packages/contract` had test files and no vitest project, so `npm test` never ran them —
`agent-route.test.ts` had been green by absence, and `usage-hold.test.ts` would have been too. Now
registered in `vitest.config.ts`, with `maxWorkers` derived exactly as every other project derives
it (vitest 4 refuses a mixed cap).

## Architecture

```
   provider refuses a step
            │
            ▼
  RunRecord.steps[n] { backend, profileId }      ← the fact
            │
            │  usageHoldAccountKey()             ← contract, one definition
            ▼
   accountHolds() → { deadline, inFlight }
            │                    │
            │                    └────────────► noteHeldRuns() → run transcript
            ▼
   accountHeldFor(queued, holds, defaultRunner)
            │        ▲
            │        └── runAccountKey()         ← same contract module
            ▼
   pump() starts it, or leaves it in place
                     │
                     └──► cockpit: usageLimitHolds(runs) + queueHold(run)
                          (the same two key functions, imported through the
                           api-client barrel — never re-spelled)
```

## Phases

One change, shipped together — the parts are not independently useful: fixing the key without the
date leaves a task parked three days early on the right account, and fixing either without the note
leaves the next person reading a silent queue.

## Data Models

**No stored shape changes.** `usageHoldAccountKey` reads `RunRecord.steps[].backend` and
`.profileId`, which have been persisted since backend affinity, and falls back to the run-level
fields for records that predate them. No migration, no backfill: the next pump re-derives every
hold from the records as they stand.

The one behavioral change to stored data is the transcript note's text, which now names the
account and the reopening instant.

## API Contracts

`@loki-labs/better-cezar-contract` gains three exports (`accountUsageKey`, `runAccountKey`,
`usageHoldAccountKey`) and they reach the cockpit through the api-client barrel, which re-exports
the contract wholesale. `packages/cezar/src/workspace/agent-account-usage.ts` re-exports
`accountUsageKey` so no importer in the service changed.

No HTTP route, request or response shape changes.

## Risks

- **CORRECTED 2026-08-23, after the first deploy: this was measured, and it cost more than a
  step.** This bullet originally read *"a workflow step pinned to a different backend can still
  start on a closed account one step later… it costs one step, not a whole queue"*. What actually
  happens is that the run never starts at all: the spawn gate refuses it and hands it back to the
  queue, which admits it again immediately. Eleven round trips a second, 2626 transcript notes,
  until the release was rolled back. Fixed by the `heldAtSpawn` memo in Solution 4. What remains
  open is only the narrow original claim — a run whose LATER step pins a different backend can
  still reach that step and be refused there, which costs one bounce and one note, not a loop.
- **A queued row stays silent for a run dispatched through an account POOL.** The cockpit derives
  its rows from the run record, and a pool route resolves the provider at dispatch — server-side,
  once, with a cursor side effect. So the exact production run renders no `held` pill while its
  transcript names the account plainly. Silence, not a wrong account, and the surface the reporter
  actually opened (the task thread) is the one that answers. Persisting the held account on the
  record is the follow-up that would close it; it touches `RunRecord` plus five summary
  projections, which is a wider change than this fix should carry.
- **The single-project list sees only its own runs.** The engine's hold is workspace-wide, so a
  row in project A held by a limit a project-B run is carrying shows nothing there. The workspace
  board, fed the whole aggregate, answers completely. Silence again, never a wrong account.
- **The cockpit's fallback runner.** `queueHold` uses `health.defaultRunner` when a run names none.
  If that read is stale the row can be silent for a genuinely held task — silence, never a wrong
  account.
- **Found while auditing, NOT fixed here: `recordLimited()` has no production caller.** Every
  reference to it outside its own definition is a test (`agent-account-usage.test.ts`,
  `agent-route-select.test.ts`). So `AccountUsageEntry.limited` is never written by the limit path,
  `isLimited()` answers `false` for an account a provider just refused, and the pool balancer in
  `agent-route-select.ts` will happily route to it. The queue hold fixed above is what actually
  stops that work today, which is why the gap has been survivable. Wiring it is a behavior change
  to routing (which `source`, what `until`, how it interacts with the hold) and deserves its own
  decision rather than a quiet ride along with this fix.
- **Named-date parsing is anchored, but `may` is both a month and a common word.** The anchor plus
  the required day digits make a false positive unlikely; a false NEGATIVE simply falls back to the
  older tiers, which is the pre-change behavior.

## Verification

Automated (all executed):

- V1 `packages/cezar/src/core/usage-limit.test.ts` — the exact production string parses to
  `2026-08-26T23:00:00Z` as `named-date`; day-first and spelled-out months; a named date with no
  clock; an explicit year and the new-year rollover; **a recognized-but-impossible date returns
  null rather than the clock tier's nearer answer**; clock-only prose still reads as `clock`.
  Confirmed to FAIL pre-fix by reverting only `usage-limit.ts` to its parent revision: **6 of
  the 8 new cases go red** (`Tests 6 failed | 13 passed`). The two that stay green are the
  negative controls, which assert the OLD tiers still answer — they are meant to pass on both
  sides, and a green there is the evidence the new tier did not swallow them.
- V2 `packages/cezar/src/workflows/auto-resume.test.ts` — a run whose failed step ran on `claude`
  while the record says `codex` holds `claude:default` and NOT `codex:default`. Confirmed to FAIL
  pre-fix with exactly the production symptom: `expected [ 'codex:default' ] to deeply equal
  [ 'claude:default' ]`.
- V3 same file — every run held behind a limit carries exactly ONE `held in the queue` note naming
  the account and the reopening instant, across a second of real pump sweeps (the count is the
  dedupe assertion).
- V4 `packages/contract/src/usage-hold.test.ts` and `packages/web/src/lib/account-hold.test.ts` —
  the three tiers of the hold key, and the cockpit's derivation over the production record shape.

- V6 `packages/cezar/src/workflows/auto-resume.test.ts` — a run the queue admits and the spawn
  refuses settles after ONE note instead of ping-ponging. Confirmed to FAIL pre-fix by pointing
  the admission predicate back at `accountHeldFor`: `expected [ … ] to have a length of 1 but got
  25` in a one-second window, the same shape as production.

Manual, on the box (QA):

- V5 with a live hold, a queued row on the held account shows `held <when>` and its queue cell
  reads `#N held`; a queued row on any OTHER account shows neither. **Not yet run** — it needs a
  real limit, which is why this ships as QA Needed.
