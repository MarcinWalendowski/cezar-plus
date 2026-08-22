# Brief: bounded broker retry

**Task:** `9e110775-a190-4d91-94aa-da4791752b7e`  
**Step:** Gather the record only. This is not a spec and contains no implementation.

## Problem in this repository's terms

The remaining defect is not the 5 second broker startup budget and not the scope-unit collision.
Those were conclusively separated. A broker that actually started accepted its control socket at
p50 621 ms and max 716 ms under load 7.68, while the failed brokers had never started. The permanent
scope collision was fixed and production-verified in `8e20dfbf` plus `0883256b`, release
`20260822T102742Z-0883256b` [KB `notion-d660e1080ec2`; KB `notion-8c1963ca2c16`].

What remains is defense in depth at the workflow boundary: when an already-launched broker or its
control channel dies for a genuinely transient reason, the current engine turns the session result
rejection directly into a failed step and failed run. The desired behavior is a bounded retry whose
reason and attempt are visible in the task thread. A permanent launch failure, especially the
structured case where no `meta.json` was ever written, must bypass that budget and fail immediately
with its captured launcher cause.

There is an important checkout mismatch. This worktree is at `2778fd52` and does not contain
`8e20dfbf` or `0883256b` as ancestors. Its checked-out source still has the old per-run scope name,
ignored launcher stdio, and `spawnFailed`-only diagnosis
[`packages/cezar/src/core/broker-isolation.ts:70`; `packages/cezar/src/core/claude-cli-runner.ts:393`;
`packages/cezar/src/core/brokered-session.ts:198`]. The collision fix and its spec are available in
Git history, and the next step must use those commits as the intended baseline rather than designing
against this stale checkout. The spec itself can be read with
`git show 8e20dfbf:.ai/specs/2026-08-22-broker-scope-unit-name-collision.md`.

## What the record already decided

1. **Do not lengthen the startup wait.** The 5 second budget was about eight times the measured
   worst healthy bind time. A timeout cannot reach a process that was never created
   [KB `notion-d660e1080ec2`; historical collision spec, `8e20dfbf`, Problem].

2. **Never-started is permanent for retry classification.** The old unit collision survived every
   later step because a background process kept the scope active. Retrying the generic timeout would
   have hit the same wall repeatedly. The shipped fix distinguishes launch failure through
   `launchFailure`, preserves launcher output in `<runsDir>/<runId>.broker.log`, and reports that no
   `meta.json` was written [KB `notion-d660e1080ec2`; KB `notion-8c1963ca2c16`; commit `8e20dfbf`].
   The collision spec explicitly left step retry out of scope and called it defense in depth
   [historical collision spec, Solution].

3. **Do not widen `spawnFailed` to classify launch refusal.** That hook also feeds terminal result
   construction, and doing so made a clean detach look like a failed step. The separate
   `launchFailure` diagnosis was a deliberate regression-driven decision
   [KB `notion-d660e1080ec2`; KB `notion-8c1963ca2c16`].

4. **One existing automatic step re-entry is narrowly classified and bounded.** A cezar-initiated
   inactivity stop carries `AgentEvent.error.reason`, is surfaced as a note and metrics, resumes the
   same session once, then parks terminally on a second stop
   [`.ai/specs/2026-08-20-agent-step-stopped-is-not-failed.md`, Solution and Decisions;
   commit `62a41d30`; `packages/cezar/src/workflows/run.ts:3872`, `:3934`]. This is a visibility and
   boundedness precedent, not a ready-made cold broker retry.

5. **Generic workflow retry mechanisms are not transport retry.** Post-condition retries rerun the
   same step, while declared `onFail` transitions loop a check step back to an earlier workflow step
   [`packages/cezar/src/workflows/run.ts:3984`, `:4093`, `:5480`;
   `packages/cezar/src/workflows/types.ts:230`]. A broker/session failure currently takes neither
   path.

6. **A missing persisted backend session is already intentionally terminal during recovery.** It is
   failed once and is not retried on every boot
   [`packages/cezar/src/workflows/recover-session-failure.test.ts:46`; commit `373b1b10`]. A new
   transport retry must not weaken that guard or turn restart recovery into a loop.

7. **The spool lifetime correction constrains whether retry can work.** The later record found that
   `runs/<runId>.spool` and ownerless `exit.json` were shared across step and relaunch lifetimes. A
   stale twin exit can kill a healthy session, and a retry against that same stale exit dies on its
   first tick. The related correction requires clean per-launch ownership or stale-exit removal
   before retry can be effective [KB `notion-04ca960e6408`; commit `3a54d156`, historical
   `.ai/specs/2026-08-22-spool-exit-cross-talk.md`, sections "Why step retry cannot save it" and
   Solution P3]. That spec is also absent from this worktree.

## Code actually involved

### Session and broker boundary

- `BrokeredSession` is deliberately an unchanged `AgentSession` seam above the transport
  [`packages/cezar/src/core/brokered-session.ts:6`]. Its control requests retry internally up to
  `PENDING_MAX_ATTEMPTS`, then `giveUp()` rejects `session.result`
  [`packages/cezar/src/core/brokered-session.ts:31`, `:190`, `:226`]. On this checkout the rejection
  exposes only an `Error`, with no transient/permanent discriminator.
- Claude selects the brokered path and creates the session in
  `packages/cezar/src/core/claude-cli-runner.ts:375` and `:446`. The intended baseline in `8e20dfbf`
  adds per-launch identity, launcher logging, and separate `launchFailure` diagnosis here.
- Broker selection or reattachment occurs once per step at
  `packages/cezar/src/workflows/run.ts:4667`. A synchronous `startSession` throw becomes a failed
  step result at `:4740`. A later `session.result` rejection is caught at `:4751` and reduced to its
  message, which discards classification before the execute loop sees it.

### Step and run lifecycle

- The execute loop creates step iteration and stop-retry state at
  `packages/cezar/src/workflows/run.ts:3872`, emits `step-start` at `:3892`, and consumes the step
  result at `:3914`.
- Only a cezar stop with structured `reason` enters the existing same-session retry branch
  [`packages/cezar/src/workflows/run.ts:3934`]. Any ordinary failure immediately calls
  `finishStep(..., 'failed')`, sets `runError`, and breaks the chain
  [`packages/cezar/src/workflows/run.ts:3977`]. `finishStep` persists the error and emits the
  terminal `step-end` event [`packages/cezar/src/workflows/run.ts:5545`].
- The most plausible classification seam is therefore either a typed `AgentSession` result failure
  that survives the catch at `run.ts:4751`, or a classified internal step result that branches near
  `run.ts:3977`. Matching error message text would contradict the collision diagnosis and would be
  brittle across launcher and backend messages.

### Thread visibility

- Runner events are persisted before lifecycle inspection at
  `packages/cezar/src/workflows/run.ts:4483`.
- The thread reducer renders notes and lifecycle messages, errors, v2 session errors, and failed
  step ends [`packages/web/src/features/task/thread-state.ts:576`; rendered through
  `packages/web/src/features/task/thread-items.tsx:240`]. It does not render `step-start`, so an
  incremented iteration alone does not satisfy visible retry reason. The inactivity retry's explicit
  note at `packages/cezar/src/workflows/run.ts:3958` is the closest established pattern.

### Existing verification seams

- `packages/cezar/src/core/brokered-session.test.ts:247` pins bounded no-broker give-up and launch
  error precedence on this checkout. The collision commit extends this area and adds
  `broker-scope-collision.test.ts`.
- `packages/cezar/src/workflows/step-stopped.test.ts` proves a bounded retry at the workflow/session
  seam and visible telemetry for the different inactivity-stop case.
- `packages/cezar/src/workflows/recover-session-failure.test.ts:46` is the permanent-recovery guard.
- No existing test or brief for transient broker/control-channel step retry was found. `cezar todo
  list` reported no todos, and no active retry-named branch or matching brief was found. The
  historical collision spec names todo `c4cd4ab6`, but it is not present in the current tracker.

## Prior decisions this could contradict

- Retrying the message "did not respond" without structured launch evidence would reverse the
  measured collision decision and mask permanent failure.
- Reusing the inactivity-stop branch without separating cold broker replacement from same-session
  resume would assume a session id and live transport that may no longer exist.
- Retrying a shared run-scoped spool without accounting for stale `exit.json` would specify a retry
  that cannot succeed under the recorded cross-talk mechanism.
- Persistently retrying recovery would contradict `373b1b10`, which prevents the same missing
  session from failing again on every boot.
- Weakening the broker/session inactivity bound to make retry easier would remove the existing
  liveness guarantee. The spool correction explicitly preserves that bound
  [KB `notion-04ca960e6408`; commit `3a54d156`, Risks].

## Open questions for the spec

1. What exact structured taxonomy distinguishes a transient, already-started broker/control-channel
   death from never-started launch refusal, genuine backend failure, cezar-initiated stop, and
   recovery of a missing persisted session?
2. Does retry resume an existing backend session, launch a fresh broker around it, or start a fresh
   backend session with a handoff? What evidence proves each option is safe for every brokered
   backend path?
3. Is one retry sufficient, following the inactivity-stop precedent, or does measured production
   evidence justify another bound? The record contains no measurement for a retry count.
4. Must the retry counter survive a server restart? An in-memory set is bounded only within one
   process; persisted state changes the data model and restart semantics.
5. How is clean retry state guaranteed after the spool ownership correction? The spec must resolve
   whether `3a54d156` is already in the landing baseline or make that dependency explicit.
6. Which event carries the reason and attempt so the thread shows the retry without falsely emitting
   a terminal failure? The existing note plus attempt metrics are precedent, but the record does not
   decide the contract.
7. What production E2E can deterministically kill an already-started broker/control channel once,
   prove the step retries and continues, then separately prove a poisoned never-started launch fails
   fast without consuming the retry budget?

## What could not be found

- No current tracker entry corresponding to historical todo `c4cd4ab6`.
- No active duplicate implementation, retry-specific brief, or test for this exact failure class.
- No durable decision for the transient error taxonomy, retry count, fresh versus resumed backend
  session, or restart persistence of attempts.
- No measurement of how often genuinely transient broker/control-channel failures occur or whether
  one retry is enough.
- The two most relevant 2026-08-22 specs and their fixes are not present in this worktree's HEAD;
  they are only reachable through the cited commits and other refs.
