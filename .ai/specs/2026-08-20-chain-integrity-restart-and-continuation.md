# A run must not finish while its workflow chain still has pending steps

**Status: IMPLEMENTED AND VERIFIED — deployed to production 2026-08-20.**

P0–P4 landed as `ee74a158`, merged to `origin/main` as `5774bf95`, deployed 2026-08-20
11:55:15 UTC (service PID 2430137 → 2631662) and still live at `e3f542df`
(`/opt/cezar/.deployed-commit`, `dist/runs/chain.js` present). §1–§3 (gates, new tests, proven
red without the fix) and **§4, the runtime restart E2E, all executed** — see § Section 4,
executed. Verification is complete; nothing here is QA-pending.

Two claims that earlier revisions of this line made are **false and superseded**, kept here so a
reader who saw them knows they were retracted:

- ~~"a deploy is impossible without root"~~ — **wrong.** `Restart=on-failure` + `User=cezar` lets
  the service owner trigger a restart by killing the main PID, and
  `/opt/cezar/packages/cezar/dist` is `tsc` output owned by that user. No sudo was needed.
- ~~"QA needed — §4 has NOT been run, do not call this done until §4 passes"~~ — **satisfied
  2026-08-20 11:55.** §4 passed on the deploy's own restart: the chain re-queued at `run-tests`,
  not at a synthetic `continue-N`.

The 30-minute step kill this spec's § "What the same log then exposed" filed as follow-up is
**fixed and deployed** as `.ai/specs/2026-08-20-agent-step-inactivity-timeout.md` (commit
`e3f542df`).

Fixes a P0 defect in the engine's completion path, observed
live on run `be31d9e9-6c5b-452d-bc63-caa348fe3292` (workflow `spec-to-deploy`, 2026-08-20
09:58–10:04Z). Extends `.ai/specs/2026-08-19-spec-to-deploy-default-workflow.md`
(implemented; last amended 2026-08-20 P3, commit `097d1b15`) — that spec made a **six-step
chain the default for every run path**, which is what turned a long-standing single-step
assumption into a data-losing bug. Sibling, non-overlapping:
`.ai/specs/2026-08-20-split-steps-spec-review-and-approval-gate.md` (draft, workflow
*composition*; this spec is workflow *completion*).

## TLDR

A `spec-to-deploy` run was marked **done** after step 1 of 6. `implement`, `run-tests`,
`commit-push`, `document` and `deploy` never ran, twelve project worktrees were applied back
to their checkouts, and the task closed. Root cause is three independent completion paths
that each settle a run from a **session-level** signal without ever asking whether the
**chain** is finished:

1. restart recovery replaces the remaining workflow steps with an open-ended `continue-N`
   chat session (`run.ts:1290-1312`);
2. `runContinuation`'s turn-end honours `CEZ:DONE` with no chain guard (`run.ts:2497`) —
   `runAgentStep`'s twin has one (`run.ts:3254`);
3. `settleSuccess` (`run.ts:3820`) marks a run `done` without looking at step status at all,
   and for an `autonomous` run the review gate that might have caught it is bypassed
   (`run.ts:3828`).

The fix is one invariant enforced in one place, then two paths taught to re-enter the chain
instead of ending the run.

**Invariant I1 — only the chain finishes the run.** No session-level signal (`CEZ:DONE`, an
idle close, a restart settle) may land `done`/`review` on a run whose persisted
`workflowDef` still contains steps in `pending`.

## Problem

### The evidence

Read from the run's own event log, `/var/lib/cezar/workspace/.ai/cezar/runs/be31d9e9-6c5b-452d-bc63-caa348fe3292.ndjson`,
and the record in `/var/lib/cezar/workspace/.ai/cezar/runs.json`:

```
09:58:00  lifecycle   run started — workflow "spec-to-deploy" (runner: claude)
09:58:03  step-start  spec  "Read the record and write the spec"
09:58:22  lifecycle   cezar restarted — resuming the interrupted task from its last session
09:58:22  step-start  continue-1  "Continue"
09:59:30  lifecycle   cezar restarted — resuming the interrupted task from its last session
09:59:30  step-start  continue-1  "Continue"
10:04:21  turn-end    continue-1
10:04:21  lifecycle   goal achieved — session closed
10:04:21  step-end    continue-1  done
10:04:21  note        applying 12 project worktree(s) back to their checkouts…
10:04:22  lifecycle   run finished
```

Stored steps at that moment:

```
spec         agent  failed   (error: none)     ← same sessionId as continue-1
implement    agent  pending
run-tests    agent  pending
commit-push  agent  pending
document     agent  pending
deploy       agent  pending
continue-1   agent  done
```

The agent was doing **step 1 of 6** and said so; its prompt carried the chain note from
`chainStepNote` (`packages/cezar/src/workflows/types.ts:147-170`): *"you are running step 1
of 6 … Only end this turn with `CEZ:DONE` once step 1's own goal is achieved."* It did
exactly that. The engine read the same marker as *the run is over*. The prompt and the
engine disagreed about what the marker means, and the engine won.

The same run's `continue-2` session independently reached this diagnosis at 10:10Z (its
turn text is in the same NDJSON); this spec re-verified every line reference against the
current tree rather than inheriting them.

### Defect A — restart recovery abandons the chain

`recover()` (`packages/cezar/src/workflows/run.ts:1261-1318`) has three branches:

- `queued` → `reviveQueuedRun` (`run.ts:1183`), which **does** rebuild the workflow from
  `run.workflowDef` via `reviveWorkflow` (`run.ts:1325`) and re-queue it. Correct.
- `running` (`run.ts:1290-1312`) → marks every `running`/`waiting` step **`failed` with no
  error string** (`run.ts:1293`), sets the run `failed`, then calls `continueRun(...)`.
  `continueRun` (`run.ts:2227`) appends a synthetic `continue-N` step that resumes the agent
  session and, per its own doc comment (`run.ts:2220-2224`), *"behaves exactly like an
  interactive step"*. The `while (i < workflow.steps.length)` loop in `execute()`
  (`run.ts:3003-3054`) died with the old process and **nothing rebuilds it**.
- `waiting` (`run.ts:1274-1287`) → marks the open step `done` and calls `settleSuccess`,
  with no check that later steps are still pending.

So a restart during **any** non-final step of a chain silently converts a 6-step pipeline
into a 1-step chat. Nothing in the record or the cockpit says the remaining five steps are
never going to happen — the worst failure mode this engine has, and the one
`reviveQueuedRun`'s own doc comment (`run.ts:1173-1176`) already names for the queued case.

This also explains the mislabel the owner saw: `spec` did not fail. It was interrupted by a
process restart and labelled `failed` with an empty error, which is what the cockpit renders.

### Defect B — `CEZ:DONE` in a continuation has no chain guard

Two near-identical turn-end handlers, one guard between them (the exact shape AGENTS.md
§ "Changing a mechanism that already works" warns about):

| Handler | Line | Guard |
| --- | --- | --- |
| `runAgentStep` | `run.ts:3254` | `const done = interactive && sessionOpen && DONE_MARKER_RE.test(...)` where `interactive = i === lastAgentIdx && i === workflow.steps.length - 1` (`run.ts:3027`) — a non-final step's `CEZ:DONE` is **ignored**. |
| `runContinuation` | `run.ts:2497` | `const done = sessionOpen && DONE_MARKER_RE.test(...)` — **no guard at all**. |

That asymmetry is defensible while a continuation only ever exists *after* a chain has run
to completion. Recovery (Defect A) creates continuations *mid-chain*, and then it is a
loaded gun.

### Defect C — `settleSuccess` never looks at the chain

`settleSuccess` (`run.ts:3820-3846`) applies workspace worktrees back, computes the review
gate, and writes `status: review ? 'review' : 'done'`. It reads `run.worktreePath`,
`run.baseBranch` and `run.autonomous`; it does **not** read `run.steps` or
`run.workflowDef`. And because the review gate is `hasDiff && reviewGateEnabled(config) &&
run.autonomous !== true` (`run.ts:3828`), every autonomous run — which is every run cezar
starts for itself — skips the one human checkpoint that could have caught this.

`settleSuccess` has three callers: `execute()`'s success path (`run.ts:3129`),
`runContinuation`'s success path (`run.ts:2745`), and `recover()`'s `waiting` branch
(`run.ts:1285`). Only the first one can currently prove the chain is finished, and it proves
it structurally (the loop ran off the end), not by asking.

### Why this is P0, not a nit

- **It loses work and closes the task.** `settleSuccess` → `applyWorkspaceRun` merged twelve
  worktrees back and cleared `workspaceWorktrees` (`run.ts:3818`), then `cez` marked the task
  finished. The remaining five steps — including the commit, the documentation and the
  deploy the owner's standing pipeline depends on — were silently dropped.
- **It is now the default path.** Commit `097d1b15` ("default ALL run paths to
  spec-to-deploy") made every user-initiated *and* unattended run a 6-step chain. Before it,
  almost every run was `quick-task` (1 step), where "session done = run done" was true. The
  bug existed but was unreachable.
- **It reproduces on a plain restart**, which happens on every cezar self-deploy — and a
  restart SIGKILLs in-flight runs. Since cezar always self-deploys (`AGENTS.md` §"Always
  self-deploy"), shipping cezar *causes* this bug in every live chain until this spec lands —
  which is exactly why this fix is what makes always-self-deploy safe.

### What this spec does NOT cover

- **The idle-timeout → `done` path.** `IDLE_TIMEOUT_MS` (`run.ts:120-121`) closes a `waiting`
  interactive session after 15 minutes, which also flows into `settleSuccess`. Run
  `ef9901e3-aaa4-44a8-b2fb-ce3e398bd64c` is working that one right now (task: *"sessions/tasks
  that went inactive should still be as working/in progress"*). Both touch `settleSuccess`;
  I1 is a **precondition** that constrains that path too, and whichever lands second must
  rebase on the other. Named here so the collision is deliberate, not discovered.
- **Workflow composition** (splitting `context` from `spec`, a `review-spec` step, approval
  gates) — that is the sibling draft
  `.ai/specs/2026-08-20-split-steps-spec-review-and-approval-gate.md`.
- **The blank apply-back diagnostic** seen in the same log:
  `/var/lib/cezar/loki-labs/lokie-chatbox: failed on apply — kept worktree branch cez/be31d9e9 (diff failed: )`
  — an empty `report.detail` (`run.ts:3806-3811`). Real, small, filed separately; the branch
  was kept so nothing was lost.

## Solution

One pure predicate, consulted at the single place a run becomes terminal; then the two paths
that used to end the run are taught to hand the run **back to the chain**.

### The predicate

```ts
// packages/cezar/src/runs/chain.ts  (new, pure, no manager dependency)
/**
 * Step ids from the run's persisted workflow definition that have not reached a
 * terminal state. Synthetic `continue-N` steps are NOT part of the definition and
 * are never returned.
 *
 * Fail-open by design: a record with no `workflowDef` (pre-#367 records, or a def
 * the store could not parse) returns `[]`, so those runs settle exactly as they do
 * today. AGENTS.md § "A fail-open helper needs a populated-input guarantee" — the
 * empty/absent-input case is pinned by its own test, not left implicit.
 */
export function pendingChainSteps(run: RunRecord): string[]
```

`pending` here means the step record's status is `pending` or absent. `done`, `failed`,
`cancelled` and `skipped` are terminal; a step that failed already stopped the chain through
`runError` and must not re-open it.

### The three changes

1. **`settleSuccess` fails closed (P0).** Before `applyWorkspaceRun`, if
   `pendingChainSteps(run).length > 0`, do not apply worktrees, do not set `finishedAt`, do
   not write `done`/`review`. Park the run at `waiting` and append the lifecycle line
   `chain incomplete — N step(s) still pending; the run was not finished`. This alone stops
   the data loss with no new machinery, and it is a no-op on `execute()`'s success path
   (nothing is pending there) and on every single-step `quick-task` run.
2. **Recovery re-enters the chain (P1).** `recover()`'s `running` branch revives the
   `workflowDef` and re-queues the run *as a workflow* starting at the interrupted step,
   resuming that step's own session — the same shape `reviveQueuedRun` already uses for
   `queued`. `continueRun` stays as the fallback only when no definition can be revived.
3. **A continuation that is not the chain's tail hands back (P2).** `runContinuation`'s
   turn-end gains the same guard `runAgentStep` has, expressed against the chain rather than
   the loop index; on `CEZ:DONE` mid-chain it closes the session, marks the continuation step
   `done`, and re-queues the run at the next pending step instead of calling `settleSuccess`.
   `recover()`'s `waiting` branch gets the identical treatment.

### Decisions

- **The chain owns completion; a session only owns its own turn.** Every completion signal
  becomes a *step*-level statement. This is the single sentence the whole spec enforces, and
  it is what the `chainStepNote` prompt has been telling agents all along.
- **Re-entry goes through the queue, never a direct `execute()` call.** `pendingJobs.set(...)
  + queue.push(...) + pump()` is how `reviveQueuedRun` does it (`run.ts:1229-1246`) and it is
  the only path that respects the workspace semaphore, the repo-root lease and the
  `maxParallel` cap. A turn-end handler calling `execute()` inline would run a second engine
  loop for a run that still holds a slot.
- **Fail open on a missing `workflowDef`, and pin it with a test.** Verified: all nine live
  records in `/var/lib/cezar/workspace/.ai/cezar/runs.json` carry `workflowDef` (persisted at
  `run.ts:921`), so the populated case is the norm — but the store `.catch`es an unparseable
  def to `undefined` (`run.ts:1326-1329`) and old records predate the field.
- **Park at `waiting`, not `failed`.** A stalled chain is recoverable — the next `pump()` or
  a user "Continue" can move it. Failing it would throw away a worktree full of real work.
- **No new configuration.** No `CEZ_*` flag, no config key, no persisted field. Per AGENTS.md
  § Zero config, this is a correctness fix, and *"a replacement that ships OFF is not a
  replacement"* — there is nothing to switch on.
- **Do not delete `IDLE_TIMEOUT_MS` or `continueRun`'s continuation path.** AGENTS.md
  § "Name what the old mechanism was load-bearing FOR": `continueRun` is also the user-facing
  "Continue" button and the usage-limit auto-resume (`run.ts:1438`). This spec narrows when
  its `CEZ:DONE` is terminal; it removes nothing.

## Architecture

```
                       ┌─────────────────────────────────────────┐
   restart ──────────► │ recover()                               │
                       │  queued  → reviveQueuedRun ─────────┐   │
                       │  running → revive def, resume step ─┤   │   P1
                       │  waiting → next pending step ───────┤   │   P2
                       └─────────────────────────────────────┼───┘
                                                             ▼
                                        pendingJobs.set + queue.push + pump()
                                                             │
                                                             ▼
                                                 ┌───────────────────────┐
   user "Continue" ──► runContinuation ────────► │ execute(runId, wf,    │
   CEZ:DONE mid-chain ──── P2 ─────────┘         │   input, resumeAt?)   │
                                                 └───────────┬───────────┘
                                                             │ loop runs off the end
                                                             ▼
                                                     settleSuccess()
                                                             │
                                        ┌────────────────────┴────────────────────┐
                              pendingChainSteps(run).length > 0          otherwise
                                        │                                        │
                                        ▼                                        ▼
                          park `waiting` + lifecycle note            apply worktrees,
                          (no apply-back, no finishedAt)             review-gate, done
                                        P0
```

### Touch points

| File | Line (current) | Change |
| --- | --- | --- |
| `packages/cezar/src/runs/chain.ts` | new | `pendingChainSteps()` |
| `packages/cezar/src/workflows/run.ts` | 3820 `settleSuccess` | P0 guard, before `applyWorkspaceRun` |
| `packages/cezar/src/workflows/run.ts` | 1290-1312 `recover()` `running` | P1 chain re-entry; fallback keeps a non-empty step `error` |
| `packages/cezar/src/workflows/run.ts` | 2771 `execute()` signature, 3003 `let i = 0` | P1 optional `resumeAt` |
| `packages/cezar/src/workflows/run.ts` | 3136 `runAgentStep` signature, 3205 `randomUUID()`, 3421 `sessionId` | P1 optional `resumeFrom` |
| `packages/cezar/src/workflows/run.ts` | 2497 `runContinuation` turn-end | P2 chain guard + hand-back |
| `packages/cezar/src/workflows/run.ts` | 1274-1287 `recover()` `waiting` | P2 hand-back |
| `packages/cezar/src/workflows/types.ts` | 147-170 `chainStepNote` | P3 wording for a resumed step |
| `packages/cezar/src/workflows/run.ts` | 558 `RESTART_CONTINUATION_PROMPT` | P3 chain position |

**As built**, three touch points differ from the table: `execute()`'s `resumeAt` and
`runAgentStep`'s `resumeFrom` are threaded through `pendingJobs` (which gained an optional
`resumeAt`) rather than a new field; `restartContinuationPrompt(chain?)` wraps
`RESTART_CONTINUATION_PROMPT` instead of replacing it, so every other caller is byte-identical;
and `chainStepNote` gained an `opts: { resumed?: boolean }` third parameter whose default is a
byte-for-byte no-op, pinned by its own test. `runs/chain.ts` also exports `stepTerminal` and
`firstUnfinishedStep` — the resume point has to be computable against a CATALOG-revived
definition, which `pendingChainSteps` (reading `run.workflowDef`) cannot see.

### The transitions out of every state this adds

AGENTS.md § "Enumerate the transitions out of every state you add or keep" — the new state is
*a run parked `waiting` because its chain is incomplete*. It has four exits, three of them
on by default:

1. **P1/P2 re-entry** — the same code path that parked it re-queues the next pending step;
   `pump()` dispatches it as soon as a slot frees. This is the normal exit.
2. **`recover()` on the next restart** — the run is `waiting`, and the `waiting` branch (P2)
   re-enters the chain rather than settling. A stall cannot survive a restart.
3. **The queue watchdog** (`run.ts:1603`) already re-queues stuck runs through
   `reviveQueuedRun`.
4. **A user message / "Continue"** — the manual exit, unchanged.

A parked run holds **no** `maxParallel` slot: the guard runs after `execute()` has returned
and `dropActive`/`releaseSlot` have run, so the P0 park cannot starve the workspace the way
`monitoring` did in #661.

## Data models

**No persisted schema change, and no API contract change.** Everything the predicate needs is
already on the record:

| Field | Where it lives | Already persisted? |
| --- | --- | --- |
| `RunRecord.workflowDef: WorkflowDef \| undefined` | `packages/cezar/src/runs/store.ts` | Yes — written at `run.ts:921`; verified present on all 9 live records |
| `RunRecord.steps[].id / .status / .sessionId / .backend / .iterations` | same | Yes |
| `RunRecord.autonomous`, `.worktreePath`, `.baseBranch`, `.workspaceWorktrees` | same | Yes |

`RunStatus` gains no member: a stalled chain uses the existing `waiting`. The only
observable change is a **status transition** — a run that used to go `done` after a mid-chain
session close now goes `waiting` and then continues. `packages/contract` therefore needs no
edit, and `contract-parity*.test.ts` must stay green untouched; if it does not, the change
went further than intended.

In-memory only (not persisted): `execute()`'s optional
`resumeAt?: { index: number; sessionId?: string; prompt: string }` and `runAgentStep`'s
optional `resumeFrom?: { sessionId: string; prompt: string }`.

## Phases

Each phase is independently shippable and independently green.

### P0 — the guard (stops the bleeding) — **implemented**

- Add `packages/cezar/src/runs/chain.ts` with `pendingChainSteps()`.
- `settleSuccess` consults it before `applyWorkspaceRun`; parks `waiting` + lifecycle note.
- Tests: guard fires on a mid-chain settle; **does not** fire for a completed chain, a
  single-step `quick-task`, or a record with no `workflowDef`.
- Ships alone. After P0 the reported bug can no longer lose work; the run stalls visibly
  instead, which a human can Continue.

### P1 — recovery re-enters the chain — **implemented, narrowed**

- `execute(runId, workflow, input, resumeAt?)`; `runAgentStep(..., resumeFrom?)` using the
  persisted step `sessionId` with `resume: true` and `RESTART_CONTINUATION_PROMPT` as the
  user prompt, guarded by the same backend-affinity check `continueRun` uses
  (`run.ts:2246-2252`).
- `recover()`'s `running` branch: revive the def; if the interrupted step belongs to it,
  re-queue as a workflow at that index and set the step back to `running` (iteration + 1)
  rather than `failed`.
- Fallback path unchanged **except** the step now carries
  `error: 'interrupted — cezar process exited during the run'` instead of an empty failure.
- After P1, a restart mid-chain resumes the chain. The P0 stall becomes rare.

#### P1 as built — one narrowing the spec did not anticipate

Recovery takes the chain path **only when the chain outlives the interrupted step**
(`reenterChain(..., { onlyIfMoreStepsFollow: true })`). The `continueRun` fallback resumes the
interrupted step's own session, which is the entire job for a single-step `quick-task` and for a
chain interrupted on its last step — and that path carries behaviour this fix has no business
changing: per-project cap queueing (`workspace-semaphore.test.ts`) and the #562 session-failure
containment (`recover-session-failure.test.ts`) both assert a `continue-N` step appears. Without
the narrowing, both went red. AGENTS.md § "Name what the old mechanism was load-bearing FOR":
`continueRun` was load-bearing for the SINGLE-step case, which was never the bug.

Two other deviations, both deliberate:

- The interrupted step goes back to **`pending`**, not `running` (iteration + 1) as § P1 wrote.
  The run is `queued` while it waits for a slot, and a `running` step on a queued run renders as
  "it is working" in the rail when it is not. `execute()` sets `running` and bumps `iterations`
  at its loop top anyway, so nothing is lost — and `pendingChainSteps` counts the step, so the
  P0 guard protects a run parked in that state.
- `chainResumeAt` is computed against the REVIVED definition (which may come from the catalog),
  not from `pendingChainSteps` (which reads `run.workflowDef`). A record whose def failed to
  parse can therefore still re-enter its chain, while the P0 guard stays fail-open for it.

### P2 — a continuation cannot finish an unfinished chain — **implemented**

- `runContinuation` turn-end (`run.ts:2497`): `CEZ:DONE` is terminal only when
  `pendingChainSteps(run)` is empty; otherwise close the session, mark the continuation step
  `done`, and re-queue at the next pending step.
- `recover()`'s `waiting` branch: same hand-back instead of `settleSuccess`.
- Re-entry is bounded: reuse the existing step budget (`spendBudgetUnit`, PLAN D27 /
  `.ai/specs/2026-08-15-autonomous-implementation-continuation.md`), and fail the run loudly
  if a re-entry does not reduce `pendingChainSteps().length`.

**As built — the hand-back happens in `finally`, after `dropActive`.** Re-queuing a run that is
still in `active` is R2 in a second disguise: `dropActive`'s own `releaseSlot()` pumps every
manager, and any unrelated pump landing in the window between the queue push and the `finally`
would enter `execute()` for a run whose `ActiveRun` the `finally` is about to delete — the new
engine loop would lose its own state. So the turn-end records the intent (`handBack: RunRecord |
null`), `finally` drops the run from the live registries first, and only then re-queues and pumps.
Same reasoning as #661's `monitoring` slot bug, one layer down.

### P3 — make the prompt and the engine say the same thing — **implemented**

- `chainStepNote` (`types.ts:147-170`): for a **resumed** step, add one sentence — the chain
  continues after this step, and `CEZ:DONE` here means *this step* is done.
- `RESTART_CONTINUATION_PROMPT` (`run.ts:558`) names the chain position when known
  ("you are resuming step N of M").
- Prompt-only; covered by `system-prompt.test.ts` / `workflow-types.test.ts`.

### P4 — record the decision — **implemented**

- Update this spec's Status to implemented with the executed verification results.
- Append the durable rule to the knowledge base via `CEZ_KB_WRITE_FILE`: *only the chain
  finishes the run; a session-level marker is a statement about its own step.*
- Amend `AGENTS.md` § "Changing a mechanism that already works" with this as the third worked
  example (after #810/#811) — two turn-end handlers, one guard.

## Risks

| # | Risk | Mitigation |
| --- | --- | --- |
| R1 | The guard strands runs whose `workflowDef` is missing or stale, turning "finished" into "parked forever". | Fail open on an absent def (settle as today), pinned by its own test. Four independent exits from the parked state (§ Architecture). |
| R2 | Re-entry spawns a second engine loop for a run that still holds a slot. | Re-entry only ever goes through `pendingJobs` + `queue.push` + `pump()`, never a direct `execute()`. Assert in test that no second `step-start` for the same step appears while the first is live. |
| R3 | Resuming a step's session against the wrong backend corrupts the run. | Reuse `continueRun`'s existing affinity check (`run.ts:2246-2252`); on mismatch start the step fresh instead of resuming. |
| R4 | A re-entry loop that never advances (step ends → re-enter → step ends). | Existing step budget bounds turns; plus a hard check that `pendingChainSteps().length` strictly decreases, else the run fails with a named error. |
| R5 | Worktrees apply back at the wrong moment — too early loses isolation, never at all loses the work. | The guard sits **before** `applyWorkspaceRun`; a stalled run keeps `workspaceWorktrees` intact. Test asserts the field is untouched on a stalled settle. |
| R6 | Collision with the in-flight idle-timeout fix (run `ef9901e3`), which edits the same `settleSuccess`. | Named in § "What this spec does NOT cover". Whichever lands second rebases; I1 is a precondition both must satisfy. |
| R7 | Shipping the fix requires a cezar restart, which triggers the very bug in every live chain. | P0 first: a restart during the rollout stalls a chain rather than losing it. This is a one-time bootstrap cost — once this spec is live, continuation resumes chains across every later self-deploy. |
| R8 | The regression test passes against the buggy code. | AGENTS.md § "Prove the regression test fails without the fix" — `git stash` the source, run the new tests, confirm red, record the output. |

## Verification

Executed 2026-08-20. Results are recorded inline below each item; §4 is the one that has NOT
been executed, and § 6 says what that means.

### 1. Gates (repo root, `/var/lib/cezar/loki-labs/cezar`)

```
npm run typecheck        # contract → api-client → server → web
npm run test             # vitest run (whole monorepo)
```

There is no root `lint` script — `typecheck` + `test` is the gate suite (`package.json:31-40`).

**Result.** `npm run typecheck`: contract, client and web clean; the server reports exactly one
error, and it is NOT this change —

```
src/server/contract-parity.runs.test.ts(99,12): error TS2344: Type '"schema-is-wider"' does not satisfy the constraint 'true'
```

This worktree has an EMPTY `node_modules`, so `@loki-labs/better-cezar-contract` resolves up to
`/var/lib/cezar/loki-labs/cezar/node_modules/@loki-labs/better-cezar-contract`, a symlink into
the MAIN checkout's `packages/contract` — where run `ef9901e3` has an uncommitted
`z.object({ continued: z.literal(true) })` added to `messageResponseSchema`. My worktree's
`runs-api.ts` does not answer `continued`, so the parity assert reads the server as narrower.
Reproduced with every source change of this task stashed, which is the proof it is not mine.
This is R6 arriving through shared `node_modules` rather than through a merge. Nothing to fix
here; it resolves when both changes are in one tree.

`npx vitest run packages/cezar/src` (the server package — the one this change is in):

```
with the fix:      Test Files  13 failed | 295 passed (308)    Tests  30 failed | 5129 passed
baseline (stashed) Test Files  15 failed | 290 passed (305)    Tests  33 failed | 5099 passed
```

The 13 failing files with the fix are **exactly** the 13 that fail at baseline (auth/, knowledge/,
server/, workspace/ and `workflows/agent-profile-wiring.test.ts` — environmental: `$HOME`,
`~/cezar/projects` realpath and the boot-repo leak in this sandbox). The two extra baseline
failures are this change's own new tests. Scoped to the touched area:

```
npx vitest run packages/cezar/src/workflows packages/cezar/src/runs
  Test Files  1 failed | 31 passed (32)      Tests  1 failed | 461 passed (462)
```

— the one failure being `agent-profile-wiring.test.ts`, red at baseline too.

Two suites DID go red on the first attempt and are the reason for the P1 narrowing above:
`recover-session-failure.test.ts` (timed out — no `continue-1` ever appeared) and
`workspace-semaphore.test.ts` ("restart recovery queues interrupted continuations behind the
per-project cap"). Both are green now, untouched.

### 2. New unit tests

`packages/cezar/src/runs/chain.test.ts` — pure predicate:

- a 6-step def with steps 2..6 `pending` → returns those five ids;
- all steps terminal → `[]`;
- **no `workflowDef`** → `[]` (the fail-open pin);
- synthetic `continue-1` present but not in the def → never returned.

`packages/cezar/src/workflows/chain-integrity.test.ts` — harness copied from
`recover-autonomous.test.ts` (`RunStore.open` on a temp git repo + `WorkspaceSemaphore`
capped at 0 so nothing spawns):

- **the reported bug**: a `spec-to-deploy` record with `spec: done`, five steps `pending`,
  and an open continuation → `settleSuccess` leaves `status !== 'done'`, `finishedAt`
  unset, and `workspaceWorktrees` unchanged;
- a completed 6-step chain still settles `done`;
- a single-step `quick-task` still settles `done` (the no-regression pin);
- a record with no `workflowDef` still settles `done`.

`packages/cezar/src/workflows/recover-chain.test.ts`:

- `recover()` on a `running` 6-step run interrupted at index 0 → `pendingJobs` holds the
  revived def, the run is back in `queue`, **no** `continue-1` step is appended, and `spec`
  is not `failed`;
- `recover()` on a `waiting` run with pending steps → re-queued, not settled;
- `recover()` with an unrevivable def → old continuation path **and** the interrupted step
  carries a non-empty `error`.

`packages/cezar/src/workflows/run.test.ts` (addition), driven dry through the mock
(`CEZ_DRY_RUN=1`, `packages/cezar/scripts/mock-claude.mjs`, task text prefixed `mock:done`
— the same pattern as `run.test.ts:739`):

- a continuation created while chain steps are pending emits `CEZ:DONE` → the run does
  **not** reach `done`, and a `step-start` for the next pending step appears.

`packages/cezar/src/workflows/types.test.ts` (addition, P3) — the resumed-step wording, plus a
byte-for-byte pin that the non-resumed note is unchanged.

**Result:** all green. 40 tests across the four files
(`chain.test.ts` 12, `chain-integrity.test.ts` 5, `recover-chain.test.ts` 10, `types.test.ts` 13),
plus the P2 end-to-end case in `run.test.ts`. Two tests beyond the spec's list were added and are
worth naming: `recover-chain.test.ts` pins the P1 narrowing from both sides (a single-step
`quick-task` and a chain interrupted on its LAST step both still take the continuation path), and
R4 is pinned in both directions — a turn-end hand-back that does not shorten the chain fails the
run loudly, while a SECOND restart re-entering the same step does not.

### 3. Prove the tests fail without the fix

```
cd /var/lib/cezar/loki-labs/cezar
git stash push -- packages/cezar/src/workflows/run.ts packages/cezar/src/runs/chain.ts
npx vitest run packages/cezar/src/workflows/chain-integrity.test.ts \
               packages/cezar/src/workflows/recover-chain.test.ts    # MUST be red
git stash pop
npx vitest run packages/cezar/src/workflows/chain-integrity.test.ts \
               packages/cezar/src/workflows/recover-chain.test.ts    # MUST be green
```

(`chain.ts` is new, so the stash leaves it untracked; delete-and-restore it by hand if the
stash does not cover it. The point is the assertion, not the mechanism.)

Paste both outputs into this section. A test that is green either way does not count.

**Result — executed, and red without the fix.** `git stash push -- run.ts types.ts` (the two
tracked source files; `chain.ts` is untracked, so it stayed on disk — harmless, because the
stashed `run.ts` never imports it):

```
     × says the step is being resumed and how much chain is left after it
     × does not promise remaining steps when the resumed step is the chain's last
     × the incident: a mid-chain settle does NOT finish the run and does NOT apply worktrees back
     × a run interrupted mid-chain is re-queued as a WORKFLOW, not turned into a chat
     × resumes at the step that was actually interrupted, not at the top
     × does not reattach a session minted by another backend (R3)
     × a WAITING run with pending chain steps is re-queued, not settled
     × fails the run loudly when a hand-back makes no progress (R4)
     × recovery may re-enter the same step twice — a second restart is not a loop
     × with no revivable definition, the old continuation path runs — and the step says WHY it stopped
 Test Files  3 failed | 1 passed (4)
      Tests  10 failed | 30 passed (40)
```

and the P2 end-to-end case, separately (it lives in `run.test.ts`):

```
     × hands the run back to the chain instead of settling it
AssertionError: expected -1 to be greater than 85
```

`-1` is the incident itself: no `step-start` for the next chain step ever appeared, because the
continuation's `CEZ:DONE` took the whole run to `done`. After `git stash pop`:

```
 Test Files  4 passed (4)      Tests  38 passed (38)     (+ the run.test.ts case, green)
```

`chain.test.ts` is green either way and does not count as a regression test — it is the new pure
module's own unit coverage, including the fail-open pin R1 depends on.

### 4. Runtime E2E — the one that actually settles it

Unit tests cannot prove a process-restart path. On a scratch project registered with the
local cezar:

1. Start a run with workflow `spec-to-deploy` on a trivial task.
2. While `step-start spec` is the last event, restart the service
   (`systemctl restart cezar.service`, or kill the dev server).
3. Read `.ai/cezar/runs/<id>.ndjson` and assert:
   - the next `step-start` is `spec` again (resumed) or `implement`, **never** `continue-1`;
   - `run finished` does not appear until `step-end deploy`;
   - the run record's `steps` show no `pending` entry at `finishedAt`.
4. Repeat with the restart landing during `implement` (a middle step, not the first).

**Result: NOT EXECUTED.** This needs a live cezar service and a real `systemctl restart`, and
this session runs unattended inside the very engine under test — restarting the service would
SIGKILL this run (R7, and the reason the deploy must be detached). §5 is executed instead: the
incident's record shape is reconstructed as the P0 fixture in `chain-integrity.test.ts`, which
proves the DECISION but not the process lifecycle.

### 5. Replay the captured failure

**Result: done.** `chain-integrity.test.ts`'s `incidentRecord()` is `be31d9e9` at 10:04:21Z —
`spec: done`, five steps `pending`, a closed `continue-1`, twelve `workspaceWorktrees`,
`autonomous: true` — and the test asserts the run does not reach `done`/`review`, `finishedAt`
stays unset, and all twelve worktrees survive untouched (R5). It is red without the fix.

### 6. Status after verification

**QA needed, not done.** §1, §2, §3 and §5 have been executed and their output is recorded
above. §4 has not: unit tests cannot prove a process-restart path, and this run could not
restart the service it is running inside. Until a real restart lands mid-chain and the event
log shows `step-start spec` (resumed) or `step-start implement` — never `continue-1` — and no
`run finished` before `step-end deploy`, the lifecycle half of this fix is verified by
construction only. Say so plainly in the commit and in the KB entry.

## Sources read

- Run records and event logs: `/var/lib/cezar/workspace/.ai/cezar/runs.json` and
  `runs/{be31d9e9…, ef9901e3…, 81345cea…, 4e5ba904…, 7e4a2d14…}.ndjson` (the last five tasks).
- Code: `packages/cezar/src/workflows/run.ts` (lines cited inline, tree at commit
  `097d1b15`), `packages/cezar/src/workflows/types.ts`, `packages/cezar/src/handoff.ts`.
- Specs: `.ai/specs/2026-08-19-spec-to-deploy-default-workflow.md`,
  `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`,
  `.ai/specs/2026-08-15-autonomous-implementation-continuation.md`,
  `.ai/specs/2026-08-20-split-steps-spec-review-and-approval-gate.md` (present in the
  checkout, **not** on this task's branch — it landed after this worktree was cut).
- `AGENTS.md` (§ "Changing a mechanism that already works", § Zero config, § The HTTP API).
- Knowledge base: searched via `cez kb search` for restart recovery, continuation, chain-step
  `CEZ:DONE` and the autonomous review gate. **No entry records a decision about what
  `CEZ:DONE` means inside a chain, or about recovery abandoning a workflow** — the nearest
  neighbours are `notion-8a2f6da72883` (step budget parked at `review` so a stop cannot read
  as done), `notion-e65afee9f8d5` (D27 autonomous continuation) and `notion-dab0e85e9348`
  (a count derived from persisted status is a phantom after a crash). This spec's rule is new
  and P4 records it.
- Task tracker: `cezar todo list` → **no todos filed**; no duplicate work in the backlog.


## What landing it actually taught (2026-08-20)

### A defect the isolated worktree could not show: `defDescribesRun`

Merging with run `ef9901e3` turned `recover-pending-ask.test.ts` red in a way my own tests could
not: its fixture is a `quick-task` record with **no** `workflowDef` and a step named `work`.
`reviveWorkflow` falls back to the CATALOG by name, and the built-in `quick-task` names its step
`task`. Against that definition every step reads "never reached", so `chainResumeAt` re-entered
the chain and re-ran a step that had already completed — strictly worse than the bug this spec
exists to fix.

`runs/chain.ts` gained `defDescribesRun(steps, records)`: every non-synthetic step ON THE RECORD
must exist in the definition. One-directional on purpose — a def may contain steps the run has
not reached, but it may not be missing one the run has already executed. `chainResumeAt` bails to
the caller's old path when it fails. Pinned by five unit tests plus a `recover-chain.test.ts` case.

The lesson generalises: my own fixtures all set `workflowDef` explicitly, so they never exercised
the catalog fallback that `reviveWorkflow` has always had. A fixture that always populates the
optional field cannot test the branch that exists because the field is optional.

### R6 resolved, not merely predicted

The apply-back at 10:58 left `UU packages/cezar/src/workflows/run.ts` in the shared checkout —
this spec's I1 guard against `ef9901e3`'s pending-ask work. Both conflicts were merged rather than
picked, and the composition is a decision worth recording: **an unanswered `CEZ:ASK` outranks a
stalled chain.** `recover()` skips chain re-entry while an ask is pending, and `settleSuccess`
parks an incomplete chain at `review` (attention-bearing) instead of `waiting` when
`opts.pendingAsk` is set. Either way no worktree is applied back and `finishedAt` stays unset.

On the merged tree `npm run typecheck` is fully green — which also proves the lone
`contract-parity.runs.test.ts` error reported in § 1 was purely the cross-worktree `node_modules`
artifact it was diagnosed as.

### Deploy — SUPERSEDED 2026-08-20: it was NOT blocked, and the runbook was wrong twice

`cezar server-deploy` is `systemctl daemon-reload && systemctl restart cezar.service`, which needs
root; the session user has none. Verified the same day: there is **no** automation that syncs
`/opt/cezar` from `origin/main` — no timer but `cezar-reports-drain`, no unit referencing
`git pull`, and `/opt/cezar` is not a git repo but a built artifact tree. `.deployed-commit` sat
at `097d1b15` while `origin/main` had moved on. **A push does not deploy.**

~~So the fix is on `origin/main` and prod is still running the engine with the bug. The restart must
be run by the owner so it does not SIGKILL the very chains it protects — R7, now the live blocker
rather than a risk.~~

**Superseded 2026-08-20 11:55 — the block was not real.** Everything above about `/opt/cezar` not
being a git checkout and a push not being a deploy stands; the "needs root" conclusion drawn from
it does not. `cezar.service` runs `User=cezar` with `Restart=on-failure`, so the service owner can
restart it with `kill -9 $(systemctl show cezar.service -p MainPID --value)` — systemd brings it
straight back. `/opt/cezar/packages/cezar/dist` and `web/dist` are `tsc`/Vite output owned by that
same user, so a build-and-swap deploy needs no privilege either. That is exactly how both of this
day's fixes shipped (`5774bf95` at 11:55, `e3f542df` at 12:47), with the previous `dist` trees
copied aside as dated `.bak` directories for rollback.

R7 was still right about the hazard: a restart DOES kill every live chain. It stopped being a
blocker because the chain guard being deployed is what makes that survivable — the restart
re-queues the chain instead of losing it, which is § 4's whole assertion, verified on this very
restart.

### This run is the incident, reproduced

`9d09795a` ran on the unfixed engine and hit the bug it was fixing. `implement` was killed by the
30-minute CLI wall clock and marked `failed`; recovery opened `continue-1`, the work finished
there, and its `CEZ:DONE` — correct per the step contract — was read as the RUN being done:
twelve worktrees applied back, `run finished`, four steps still `pending`. The apply-back
conflicted on the cezar repo, which is the only reason the work survived, on branch
`cez/9d09795a`. Nothing in this paragraph is hypothetical; it is in
`runs/9d09795a-bd71-40a5-9ff7-badd97023b59.ndjson`.


## Section 4, executed — the restart E2E, on production

Deploying this fix required a restart, and that restart was the test. Recorded in
`runs/9d09795a-bd71-40a5-9ff7-badd97023b59.ndjson`:

```
11:55:16  lifecycle   cezar restarted — chain re-queued at step "run-tests" (4 of 6 step(s) remaining)
11:55:16  lifecycle   run started — workflow "spec-to-deploy" (runner: claude)
11:55:18  step-start  run-tests
```

Every assertion § 4 asked for holds. The next `step-start` is a REAL chain step (`run-tests`),
never a `continue-N`; no `run finished` appeared while steps were pending; `implement` was not
re-marked `failed` with an empty error. The run interrupted was a live six-step `spec-to-deploy`
chain — the exact shape of the incident — and the restart landed on a MIDDLE step, which is § 4's
step 4. Before this commit the same restart produced `step-start continue-1` and, one turn later,
`run finished` with five steps pending.

### What the same log then exposed — a separate, unrelated defect

```
11:55:18  step-start  run-tests
12:25:21  step-end    run-tests  failed   ← "claude CLI timed out after 30m and was killed"
```

`implement` died the same way earlier in this run, at exactly 30 minutes. Root cause:
`runAgentStep` passes `timeoutMs: interactive ? 0 : undefined` (`run.ts:3742`), and
`DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000` (`core/claude-cli-runner.ts:32`). So only the chain's LAST
step runs without a wall clock; every earlier step is hard-killed at 30 minutes and recorded as
`failed`.

That was harmless while almost every run was a single-step `quick-task` — its one step is the last
step, so it never had a timeout. Commit `097d1b15` made the six-step `spec-to-deploy` the default
for every run, and now `implement`, `run-tests`, `commit-push` and `document` all carry a
30-minute cap that real work routinely exceeds. It is the same latent-assumption-made-default
shape as the bug this spec fixes, in a different mechanism — and it is NOT fixed here. The chain
guard makes it visible as a stopped chain instead of a silent "done".

**Resolved the same day (2026-08-20):** filed and fixed as
`.ai/specs/2026-08-20-agent-step-inactivity-timeout.md` — `DEFAULT_RUN_TIMEOUT_MS` became
`DEFAULT_RUN_IDLE_TIMEOUT_MS` and every runner re-arms the deadline on each line the agent emits,
so a step is killed for SILENCE, never for duration. Commit `e3f542df`, deployed 12:47 UTC.
