# Inactive interactive sessions park as in-progress, never as `done`

> Status: **implemented** 2026-08-20 (engine + server + contract + tests green; runtime device e2e
> qa-needed). Extends: `2026-07-24-long-running-waiting-sessions.md` (#654). Owner instruction
> 2026-08-20:
> "sessions/tasks that went inactive should still be as 'working/in progress' — don't mark them
> as done autonomously."

## TLDR

When an interactive session parks at `waiting` (or a structured `CEZ:ASK`) and the user does not
reply, cezar closes the backend session after `IDLE_TIMEOUT_MS` (15 min) and the close settles the
run through `settleSuccess` → **`done`** (or `review` if the worktree holds a diff). That reports an
*unfinished* task — one that never emitted `CEZ:DONE` — as successfully finished. #654 fixed exactly
this for `CEZ:MONITORING` epochs but deliberately left ordinary `waiting`/`ASK` on the old path
(its Q1). This change closes that gap: the idle timer still fires and still frees the backend
process (its **memory bound is preserved** — see AGENTS.md "name what the old mechanism was
load-bearing FOR"), but an idle close now **parks the run at `waiting`**, not `done`. The task stays
"needs you"/in-progress, and the next user message resumes it in-process via `--resume`.

## Problem

`packages/cezar/src/workflows/run.ts`:

- Both turn-end park sites (`execute` ~L2557-2568, `runAgentStep` ~L3308-3315) arm the idle timer
  for the non-monitoring branch: `if (!monitoring) this.armIdleTimer(runId, state)`.
- `armIdleTimer` (~L3905) fires after 15 min and calls `state.session.end()`.
- `session.end()` resolves `session.result`; the wrap-up (`execute` ~L2721 / `runContinuation`
  ~L3109) calls `settleSuccess` (~L3820), which sets `status: 'done'` (or `'review'` with a diff).

Net: an interactive handoff the user simply hasn't answered yet is recorded as `done`. In the Tasks
UI (`deriveAttention`, `packages/web/src/lib/attention.ts`) `done` is the green success outcome with
no attention — the task looks finished. This is the same defect class #654's production evidence
documented for monitoring (its Problem Statement item 2), now for the ordinary-wait path.

### What `IDLE_TIMEOUT_MS` is load-bearing FOR (per AGENTS.md)

Before changing it, name its dependencies:

1. **Memory bound.** It is the only thing that closes a parked *interactive* backend process. It
   must NOT be deleted (that is the #810/#811 trap: unbounded live processes, "a state with no
   exit"). This change keeps the close.
2. **Terminal settle → resumability.** Today the close lands a terminal status, and the cockpit
   offers "Continue" (`--resume`) from terminal statuses only (`run-actions.ts`, `continueRun`
   allows `done|failed|cancelled|review`). Parking at `waiting` instead means the resume path must
   now also work from `waiting`-with-no-live-session — handled below.
3. It is NOT load-bearing for a `maxParallel` slot: `waiting` runs are already subtracted in
   `busySlots()` regardless of the timer. No slot accounting changes.

## Solution

Keep the timer and the process close; change only what the close settles to, and make a
parked-`waiting` run resumable.

1. **Idle close parks, not completes.** The idle callback marks the close as a *park*
   (`state.idleParked = true`) before `state.session.end()`. The post-`session.result` wrap-up, when
   `idleParked` is set, leaves `status: 'waiting'` in place and skips `settleSuccess` (no
   `done`/`review`, no `applyWorkspaceRun`, no "run finished" lifecycle). It appends a lifecycle note
   ("session parked after 15m of inactivity — reply to resume") and clears activity. The backend
   process is gone (memory freed); the worktree is retained for resume, exactly as for any live
   `waiting` session.
2. **Resume from parked `waiting`.** `continueRun` accepts `waiting` (add to its allowed set); its
   existing `--resume <sessionId>` path (last step's `sessionId`) reopens the conversation. The
   `POST /runs/:id/messages` ladder gains one rung: when `sendMessage` returns false (no live
   session) and the run is a parked `waiting` (status `waiting`, not active), fall through to
   `continueRun` with the message text/images instead of `409 session closed`. The web needs no
   change — `isRunActive('waiting')` is already true, so the composer already shows the message box;
   resume is transparent.
3. **CEZ:ASK too.** A structured ask is also a user-blocked wait; it parks identically. (The
   native-backend ask path `handleRunnerUiEvent` already parks `waiting` without an idle timer, so
   this makes the two ask paths consistent.)
4. **No terminal record ever carries a live-wait as `done` by inactivity.** The only inactivity
   transition is now `waiting → (process closed) → waiting`.

### Non-goals / unchanged

- `CEZ:DONE`, user Finish, Cancel, budget (`review`), and real backend disconnect/failure paths are
  unchanged. A user Finish on a parked `waiting` run still completes it as `done` (intended — that is
  an explicit human "it's done").
- Monitoring lifecycle (#654) is untouched.
- No new `RunStatus`. `activity` stays `'monitoring' | undefined`.

## Data model

No schema change. `idleParked` is in-memory `ActiveRun` state only; it never persists (a parked run
is out of the active map). A restarted cezar treats a persisted `waiting` run per existing recovery
(`runs/store.ts` interrupt reconcile → `failed`, still resumable via Continue) — unchanged, and
acceptable: #654 Q5 already declined cross-process session resurrection.

## Edge cases

- **User Finishes a parked `waiting` run** → `finish()` finds no open session; extend it to settle a
  parked `waiting` the same way it settles a `review` accept (→ `done`). Explicit human completion.
- **Cancel on a parked `waiting` run** → no active state; `cancel()` currently returns false (409).
  Extend to mark the persisted record `cancelled` when the run is a non-active `waiting`.
- **Usage cell** for a parked `waiting` run: `USAGE_LIVE_STATUSES` includes `waiting`, but no live
  sample arrives (process gone) so the cell falls back to peak — cosmetic, acceptable.
- **Message arrives during the close race** (idle fired, `session.end()` in flight): the existing
  `deferMessage`/`starting` ladder and the new `continueRun` fallback both converge on a resume; a
  double-resume is prevented by `continueRun`'s `this.active.has(runId)` guard.
- **Idle callback races a real turn** (user replied just as the timer fired): `deliverMessage`
  already `clearIdleTimer`s on delivery; the callback re-checks `state.session?.open` before ending.

## Verification

- **Unit (`workflows/run.test.ts`):** with fake timers, a plain `waiting` session advanced past
  `IDLE_TIMEOUT_MS` ends the backend session AND leaves `store.getRun(id).status === 'waiting'`
  (NOT `done`), with no `run finished`/`step-end: done` events; a subsequent `POST messages`/
  `continueRun` resumes it to `running` and it can later reach `done` via `CEZ:DONE`. Mirror for a
  `CEZ:ASK` park. Keep the #654 monitoring assertions green.
- **Unit:** `continueRun` accepts `waiting`; `finish`/`cancel` on a parked `waiting` settle
  `done`/`cancelled`.
- **Server (`server.ts` messages route test):** posting to a parked `waiting` run returns
  `{ continued: true }`, not `409`.
- **Gates:** full typecheck + lint + package tests (this touches the shipped run-lifecycle surface).
- **Runtime e2e (qa-needed):** open a task, let the agent hand back (`waiting`), advance past idle in
  a dev build, confirm the Tasks row stays "needs you" (amber) not "done" (green), then reply and
  confirm it resumes. Keep `needs-qa` until this passes.

## Record-keeping

- Amend #654's Q1 disposition in place with a `superseded 2026-08-20 by
  2026-08-20-inactive-sessions-stay-in-progress` note: ordinary waiting no longer expires to `done`;
  it parks as in-progress and resumes.
- Update the `AGENTS.md` `IDLE_TIMEOUT_MS` example and the `2026-07-17-permission-modes.md` mention
  to reflect that an idle close now parks rather than completes.
- Record the decision in the cezar KB.
