# A long step is not a hung step: bound agent runs by SILENCE, not total duration

**Status: IMPLEMENTED and DEPLOYED 2026-08-20 — one verification step still open (§ 4),
and PARTIALLY CORRECTED the same day by `62a41d30` (see the correction notice below).**

> **Corrected 2026-08-20 by commit `62a41d30`
> (`.ai/specs/2026-08-20-agent-step-stopped-is-not-failed.md`).** Three claims this spec makes
> were false when it was written, and are marked at each site below rather than only here:
>
> 1. **"all three runners" was not all of them.** `pi-runner.ts` was never converted, so a `pi`
>    step kept the original 30-minute WALL CLOCK — the exact defect this spec exists to remove,
>    surviving on the one backend nobody enumerated. Converted in `62a41d30`; there are FOUR
>    runners.
> 2. **"same SIGTERM → SIGKILL escalation" was not the same.** The deadline handler destroyed
>    `stdout` immediately, so the 10s grace window bought nothing and the CLI's parting frames
>    (final message, handoff write, `CEZ:SPEC_PATH`) were dropped exactly when they mattered
>    most. It now drains until the stream really ends. The "One note on the tests as built" at
>    the end of § Verification, executed described that destruction as a property to work
>    around; it was a defect.
> 3. **The CONSEQUENCE of a stop was left wrong.** This spec removed the false positive but not
>    the false LABEL: a genuinely stopped step was still recorded `failed`, still failed the
>    whole run, and still abandoned the chain's remaining steps into `continue-N` chat.
>    `62a41d30` gives the stop a `stopReason`, parks the run at `review`, leaves later steps
>    `pending`, and re-enters the stopped step once.
>
> The deployed commit has also moved on: `/opt/cezar/.deployed-commit` is now `62a41d30`
> (swapped 13:26–13:27 UTC, service restarted 13:28:09 UTC), not `e3f542df`. § 4 below is still
> open and is tracked by todo `e1a111a1`.

Commit `e3f542df`, pushed to `origin/main`, built and swapped into `/opt/cezar` at 12:47:07 UTC
(`/opt/cezar/.deployed-commit` = `e3f542df9bf586bcd76ac830d0870a661bd095be`;
`DEFAULT_RUN_IDLE_TIMEOUT_MS` and the new "produced no output for" message are present in all three
deployed runners — ~~all~~ **three of the four**, see the correction above). §§ 1–3 of Verification
executed and recorded below, including the red-without-the-fix proof. **§ 4 — the in-the-wild
confirmation that a chain step actually survives past 30 minutes — has NOT been observed yet**,
because no step has run that long since the swap. Until it
has, the fix is verified by unit test and by inspection of the deployed artifact, not by a live
long step. What to look for: `produced no output for 30m` must appear only for a genuinely silent
agent, never for one that is streaming. Do not upgrade this line without that observation.

Fixes a defect exposed by run
`9d09795a-bd71-40a5-9ff7-badd97023b59`, whose `implement` and `run-tests` steps were both killed
at exactly 30 minutes and recorded as `failed` while doing real work. Sibling of
`.ai/specs/2026-08-20-chain-integrity-restart-and-continuation.md` (implemented, deployed): that
one stopped a stalled chain from reading as `done`; this one stops the chain's steps from being
killed for taking their time.

## TLDR

Every agent step that is NOT the chain's last step carries a hard 30-minute wall clock. It starts
when the process spawns and never resets, so a step is killed for DURATION regardless of whether
it is actively working. `implement` and `run-tests` in a `spec-to-deploy` chain routinely exceed
30 minutes of legitimate work, and both are killed mid-flight and marked `failed`.

Replace the wall clock with an INACTIVITY bound: the deadline resets on every line the agent
emits. A step that is streaming is alive and runs as long as it needs; a step that has produced
nothing for the limit is wedged and is killed exactly as before.

## Problem

`runAgentStep` passes `timeoutMs: interactive ? 0 : undefined` (`workflows/run.ts:3742`), and each
runner does `this.timeoutMs = opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS` where
`DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000` (`core/claude-cli-runner.ts:32`, imported by the codex and
opencode runners too). The timer is a plain `setTimeout(..., limitMs)` armed once at spawn
(`claude-cli-runner.ts:219`, `codex-app-server-runner.ts:163`, `opencode-server-runner.ts:164`).
Nothing resets it.

So only the chain's LAST step — the interactive one, which passes `timeoutMs: 0` — may run longer
than 30 minutes.

### Why it was invisible until now

While `quick-task` was the default, almost every run had exactly one agent step, and that step IS
the last step, so it always got `timeoutMs: 0`. The cap existed and was unreachable. Commit
`097d1b15` made the six-step `spec-to-deploy` the default for every run path, and four of its six
steps became timed. This is the SAME shape as the chain-integrity bug: a latent assumption that
was true under the old default and became a defect under the new one.

### Evidence

From `runs/9d09795a-bd71-40a5-9ff7-badd97023b59.ndjson`:

```
10:25:40  step-start  implement
10:55:43  step-end    implement  failed   ← "claude CLI timed out after 30m and was killed"
11:55:18  step-start  run-tests
12:25:21  step-end    run-tests  failed   ← "claude CLI timed out after 30m and was killed"
```

Both steps completed real work; neither failed. `implement` produced the entire chain-integrity
fix. The label is false, and — because a failed step stops the chain through `runError` — a
30-minute step now ends the run.

> **Note added 2026-08-20 (`62a41d30`).** This spec fixes only the first half of that sentence:
> the false positive. The second half — a stop ending the run and killing the chain — stayed true
> after `e3f542df` and is fixed in
> `.ai/specs/2026-08-20-agent-step-stopped-is-not-failed.md`.

## Solution

**One idea: the deadline measures SILENCE.** Arm it at spawn as today, and re-arm it every time a
stream line arrives from the agent. Nothing else changes: same constant, ~~same SIGTERM → SIGKILL
escalation~~, same `timeoutMs: 0` opt-out, same event shape.

> **Corrected 2026-08-20 by `62a41d30`.** "Same SIGTERM → SIGKILL escalation" was not true of the
> code this spec shipped into: the deadline handler called `stdout.destroy()` and the read loop
> broke on the flag, so the grace window drained nothing. The escalation is real only after
> `62a41d30`, which drains until the stream ends. The event shape also changed there — `error`
> now carries `reason: AgentStopReason` when cezar initiated the stop.

### Why not simply `timeoutMs: 0` for every step

AGENTS.md § "Name what the old mechanism was load-bearing FOR". A non-interactive step has no
other liveness bound: `IDLE_TIMEOUT_MS` only governs a session parked at `waiting`, which a
non-interactive step never is. Remove the wall clock outright and a wedged CLI holds a
`maxParallel` slot forever with nothing to reap it — the #661 `monitoring`-with-no-exit failure,
rebuilt. The inactivity timer keeps that guarantee and drops only the false positive.

### Naming

`DEFAULT_RUN_TIMEOUT_MS` → `DEFAULT_RUN_IDLE_TIMEOUT_MS`, and the `timeoutMs` option's doc changes
from "wall-clock timeout for a run" to "inactivity timeout". A name that still says wall clock
after the meaning changed is the stale-heading problem in code. The user-facing message changes
from `claude CLI timed out after 30m and was killed` to `... produced no output for 30m and was
killed`, which is the difference between a false accusation and a diagnosis.

## Architecture

```
spawn ──► arm(limitMs) ──┐
                         │
   every stream line ────┼──► re-arm(limitMs)      ← the whole change
                         │
   limitMs of silence ───┴──► interrupt() → SIGTERM ─(KILL_GRACE_MS)→ SIGKILL
```

| File | Change |
| --- | --- |
| `core/claude-cli-runner.ts` | rename the constant; `bump()` re-arms; re-arm in the NDJSON loop |
| `core/codex-app-server-runner.ts` | same re-arm on each decoded message |
| `core/opencode-server-runner.ts` | same re-arm on each event |
| `workflows/run.ts` | unchanged — `timeoutMs: interactive ? 0 : undefined` now means the right thing |
| ~~(missing)~~ `core/pi-runner.ts` | **NOT converted by this spec — the omission was the bug.** Same re-arm added later by `62a41d30` |

No config, no persisted field, no contract change.

> **Corrected 2026-08-20 by `62a41d30`.** This table is the whole reason `pi` kept the wall clock:
> it enumerated the runners by hand and stopped at three. `62a41d30` adds `CEZ_RUN_IDLE_TIMEOUT_MS`
> (config), `stopReason` on step and run (persisted), and a `reason` field on the runner error
> event (contract) — so "no config, no persisted field, no contract change" describes `e3f542df`
> only, not the mechanism as it stands today.

## Risks

| # | Risk | Mitigation |
| --- | --- | --- |
| R1 | A chatty-but-wedged agent (heartbeats, no progress) never trips the bound. | Accepted: it is strictly better than today, and the step budget (`spendBudgetUnit`) still bounds turns. A liveness bound cannot distinguish work from noise; that is what the budget is for. |
| R2 | Removing the total cap lets one step hold a slot for hours. | It always could — the last step of every chain has `timeoutMs: 0` today. The budget and the user's cancel remain. |
| R3 | The re-arm leaks a timer or fires after exit. | `clearTimeout` on exit is already there; `bump()` is a no-op once `timedOut` is set. Pinned by a test that the timer does not fire after a clean finish. |

## Verification

1. `npm run typecheck` + the `core` and `workflows` suites.
2. New tests, per runner where the harness allows:
   - a stream that emits a line every `limit/2` for longer than `limit` is NOT killed;
   - a stream that goes silent for `limit` IS killed, with the new message;
   - `timeoutMs: 0` disables the bound entirely (unchanged).
3. Prove red without the fix (the "stays alive while streaming" case must fail against the
   fixed-deadline implementation).
4. Runtime: this run's own next chain step must survive past 30 minutes. **NOT YET EXECUTED** —
   see the Status line. The two steps that have run since the deploy (`commit-push` 12:47–13:02,
   `document` from 13:02) both finished under 30 minutes, so neither exercises the bound.


## Verification, executed

- `npm run typecheck`: clean across contract, client, server and web.
- `npx vitest run packages/cezar/src/core packages/cezar/src/workflows packages/cezar/src/runs`:
  **1132 passed, 1 failed** — `agent-profile-wiring.test.ts`, which is red at baseline in this
  sandbox and unrelated.
- Red without the fix (§ 3), `git stash`ing `claude-cli-runner.ts` only:

```
  × never fires while the agent keeps producing output, however long the step runs
  × still fires once the agent goes quiet for a full limit, even after a busy spell
AssertionError: expected [ 'SIGTERM' ] to deeply equal []
```

  The old wall clock kills a streaming agent — the production failure, reproduced in a unit test.

~~One note on the tests as built: the "goes quiet" case asserts SIGTERM and `child.killed`, not the
SIGTERM→SIGKILL escalation. Consuming stdout means the destroyed stream ends the read loop, whose
`finally` clears the kill timer before fake time reaches it. Escalation is pinned by the
pre-existing `timeoutMs: 20` case, which writes no output.~~

> **Corrected 2026-08-20 by `62a41d30`.** The paragraph above rationalised a DEFECT as a test
> constraint. "The destroyed stream ends the read loop" was not an artefact of consuming stdout in
> a test — it was the production grace window failing to drain, throwing away the agent's final
> frames on every stop. The destroy is gone; the loop now drains to real end-of-stream, and
> `claude-cli-runner.test.ts` pins it with a case that goes red if either the `destroy()` or the
> early break is restored.

## Deployment, executed

- `e3f542df` pushed to `origin/main`; `packages/cezar` server + web built from that tree.
- Old `dist` / `web/dist` copied aside as `dist.bak.20260820-124616` before the swap (one rollback
  generation, same convention the box already used).
- Restart triggered without root by `kill -9 $(systemctl show cezar.service -p MainPID --value)`;
  `Restart=on-failure` + `User=cezar` brings it back. Service up since 12:47:07 UTC, PID 2746138,
  running `/opt/cezar/packages/cezar/dist/index.js`.
- Rollback, no sudo required:

```bash
S=20260820-124616
cd /opt/cezar/packages/cezar
rm -rf dist && mv dist.bak.$S dist
rm -rf web/dist && mv web/dist.bak.$S web/dist
echo "5774bf95b0439de5eedd2993cde8ad68847eb8a6 (rolled back)" > /opt/cezar/.deployed-commit
kill -9 $(systemctl show cezar.service -p MainPID --value)
```

  The earlier `20260820-115346` generation rolls all the way back to `097d1b15`.
