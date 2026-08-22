# A run's transient scope is named per RUN, so its second step can never start a broker

**Status:** Implemented
**Date:** 2026-08-22

## TLDR

`systemd-run --scope --unit=cezar-run-<runId>` names the broker's cgroup after the **run**, but a
run spawns **one broker per step**. A scope stays active while any process remains in its cgroup —
including a background process the agent left behind (a dev server, `op daemon`, a test fixture) —
so the name is still taken when the next step launches. `systemd-run` exits 1, `stdio: 'ignore'`
throws the reason away, no broker is ever created, and the session times out with *"run broker …
did not respond after 5000ms — giving up"*, blaming a broker that never existed. The run fails,
and **every subsequent step of that run fails the same way, permanently**. Name the scope per
broker instance, and stop discarding the launcher's stderr.

## Problem

Owner-reported 2026-08-22: five `cezar` runs dead in one morning — `9bf5030d`, `f3ab054c`,
`3ee1ebf0` (step `commit-push`), `29c070f0`, `b3b5719c` — all with the same error, always at a
step boundary, never on the first step.

### What the message says, and what was actually true

`brokered-session.ts` gives up after `PENDING_MAX_ATTEMPTS` (100) failed control round-trips at
`SPOOL_POLL_MS` (50 ms) — a flat 5 s budget — and reports that the broker "did not respond".

**The budget is not the problem.** Measured on `prod-host` at load average 7.68, spawning a
broker exactly as `spawnBroker` does (detached, `stdio: 'ignore'`, `/bin/sleep` as the backend),
10 rounds:

| | min | p50 | p90 | max |
|---|---|---|---|---|
| `meta.json` written | 511 ms | 612 ms | — | 712 ms |
| control socket accepts | 515 ms | 621 ms | 666 ms | 716 ms |

Zero rounds over 5 s; the budget is ~8× the observed worst case. A broker that is started answers
in well under a second even on a busy box. **The brokers in the failed runs were never started.**

### The chain, each link measured

1. Isolation on this box is `scope` (since `fde2dae8`, 2026-08-21, which fixed the probe that had
   been silently degrading to `delegated`). The first failures are from 21:37 that evening.
2. `buildBrokerLaunchArgv` passes `--unit=${brokerScopeUnitName(runId)}` → `cezar-run-<runId>`.
   **One name per run**, while `spawnBroker` is called **once per step**.
3. A systemd scope is active for as long as its cgroup is non-empty. Three scopes were still
   `active running` hours after their runs had failed — and the process holding each one open was
   not the broker, it was something the agent had started and left:

   ```
   cezar-run-29c070f0….scope  (04:37 UTC)  └─ node /tmp/manual-fixture.mjs
   cezar-run-e3851a57….scope  (04:11 UTC)  └─ op daemon
   cezar-run-fd1f214d….scope  (21:20 UTC)  └─ node …/index.js --port 43037 --repo …
   ```

   A dev server, the 1Password daemon, a test fixture. Exactly what a `run-tests` or
   `commit-push` step starts — which is why those are the steps that die.
4. The next step re-uses the name. Run verbatim on the box:

   ```
   $ systemd-run --user --scope --slice=cezar-runs.slice \
       --unit=cezar-run-29c070f0-f5f3-480c-939b-329fde6924e5 --quiet --collect -- /bin/echo hello
   Failed to start transient scope unit: Unit cezar-run-….scope was already loaded
     or has a fragment file.
   EXIT=1
   ```

   `--collect` does not help: it reaps *failed* units, and this one is active.
5. `spawnBroker` spawns with `stdio: 'ignore'`, so that message goes nowhere. The `proc.on('error')`
   hook catches only OS-level spawn failures — `systemd-run` started fine and *exited* 1, which is
   not an `error` event. `spawnFailed()` is therefore null.
6. `BrokeredSession` polls a socket that will never exist, burns 100 attempts, and reports the
   generic timeout. The step fails; `run.ts` fails the run.

**It is permanent, not transient.** The lingering process outlives the run, so the name stays taken
and every later step of that run fails identically. A retry policy written against the timeout
message would have retried three times into the same wall and reported the same lie.

### The second defect, which is why this took a morning to find

`stdio: 'ignore'` means a launcher that fails to start anything leaves **no trace on the box at
all** — not in the journal, not in the spool, nowhere. The only artefact is a message that names
the wrong subject ("the broker did not respond" when there is no broker). The spool's `err` file
is the *backend's* stderr, written by the broker; it does not exist when the broker never ran.

## Solution

1. **Name the scope per broker instance, not per run.** `brokerScopeUnitName(runId, instanceId)`
   appends a process-unique discriminator, so two brokers of one run can never collide. The run id
   stays the prefix, so `systemctl --user list-units 'cezar-run-<runId>*'` still groups a run's
   scopes for an operator.
2. **Stop discarding the launcher's output.** The broker's own stdout/stderr go to
   `<runsDir>/<runId>.broker.log` (append). A file descriptor is not a pipe, so the property
   `stdio: 'ignore'` was protecting — *no pipe whose read end dies with the server* — is preserved.
3. **Tell the truth when giving up.** If no `meta.json` was ever written, the broker was never
   started: say that, and quote the tail of the launcher log instead of claiming a non-existent
   process failed to answer.

Deliberately NOT done here: a step-level retry. It is filed (`c4cd4ab6`) and it is defence in
depth, but it is not this bug's fix — against this cause a retry re-enters a permanently poisoned
name and merely fails slower. Sizing a longer timeout is likewise rejected: the measurement above
shows the timeout was never the constraint.

Also observed, filed separately: agent-started background processes outlive their run and keep a
cgroup (and a `claude`-spawned tree) alive indefinitely.

## Architecture

```
claude-cli-runner.spawnBroker
  instanceId = nextBrokerInstanceId()        ← unique per spawn, per process
  argv = buildBrokerLaunchArgv({ isolation, runId, instanceId, command })
       → systemd-run --scope --unit=cezar-run-<runId>-<instanceId> -- <broker>
  stdio = ['ignore', log, log]               ← <runsDir>/<runId>.broker.log, appended
  spawnFailed = () => osSpawnError ?? launcherNeverStartedABroker()
                                             ← reads meta.json + the log tail
BrokeredSession.giveUp
  uses spawnFailed()'s message when it has one, else the generic timeout
```

## Data models

None. One new file per run, `<runId>.broker.log`, beside the existing `<runId>.ndjson` — inside
`.ai/cezar/runs`, which release staging already excludes.

## API contracts

No wire change. `brokerScopeUnitName` gains an optional second parameter and
`BrokerLaunchOptions` an optional `instanceId`; both default to today's behaviour.

## Risks

- **A discriminator that is not unique** would reintroduce the collision. It is a monotonic
  per-process counter combined with the process start time, so it is unique within a machine's
  lifetime, and the run id already separates runs.
- **Unit-name length.** `cezar-run-<uuid>-<token>` is ~60 characters, far below systemd's limit.
- **The log file grows** across a run's steps. It holds launcher diagnostics only — normally
  empty — not the transcript.
- **Poisoned scopes already on the box** keep blocking the *old* run ids until their lingering
  process ends. New runs get new ids and are unaffected; the five dead runs are re-runnable once
  their scope is stopped.

## Verification

Automated:

- `broker-isolation.test.ts` — two launches for the SAME run id produce DIFFERENT `--unit`
  values (red before the fix: they were identical, which is the bug); the run id is still the
  prefix; the no-instance form is unchanged.
- `brokered-session.test.ts` — when the give-up reason says a broker was never started, that
  message is what the session rejects with, not the generic timeout.
- Full gates: `npm run typecheck`, `npm test`.

On the box, after deploy:

1. `systemctl --user list-units 'cezar-run-*'` shows distinct unit names for two steps of one run.
2. A run passes a step boundary that previously failed (`run-tests` after `implement`).
3. Provoke the old collision: with a scope of the run's name alive, a new step still starts — its
   unit name differs, so `systemd-run` has nothing to collide with.
