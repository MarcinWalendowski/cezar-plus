# A run's spool is shared by every broker launch, so one dead twin's exit kills the live agent

**Status:** Proposed
**Date:** 2026-08-22

## TLDR

`spoolDirFor()` keys the spool on the **run id alone** (`runs/<runId>.spool`), but a run spawns
**one broker per step**, and a restart spawns another for the step it could not re-attach to. Every
one of them writes into the same directory, and `exit.json` has no owner: `BrokeredSession.tick()`
ends the session the instant that file exists, without checking whose exit it is. So when an
abandoned twin dies — normally its own 30-minute `ORPHAN_TIMEOUT_MS` watchdog SIGTERMing it, and
`claude` handles SIGTERM and exits **143** — the broker writes 143 into the shared spool and the
**live, healthy** sibling is reported dead with a stranger's exit code. The step fails, the run
fails, the worktrees are discarded, and the agent that was blamed is still running.

This is `2026-08-22-broker-scope-unit-name-collision` one layer down: run-scoped identity where
launch-scoped identity is required. That spec fixed the systemd unit name. The spool path, and the
exit record inside it, still carry the same defect.

## Problem

Owner-reported 2026-08-22, two runs, same signature:

| run | step | cezar said | reality |
|---|---|---|---|
| `232ad6d4` (workspace) | `run-tests` | failed 12:53:03, "claude CLI exited with code 143" | agent alive at 13:14, 23 min later |
| `bde0ec40` (cezar) | `review-spec` | failed 12:55:45, same message | agent alive at 13:14, 19 min later |

### The agent that "exited" was still working

`232ad6d4`'s `run-tests` agent (pid 2885497) was still emitting heartbeats into its spool 23
minutes after cezar declared it exited, waiting on the poll loop it had opened over three
background gate suites:

```
{"type":"tool_progress","tool_use_id":"toolu_01PVbNhd…-heartbeat-37",
 "tool_name":"Bash","elapsed_time_seconds":1140,"heartbeat":true,
 "session_id":"f6a4b2df-3729-497a-afe0-2b38253c5298"}
```

That spool held exactly one `session_id`, so nothing about the transcript was ambiguous. Its
`exit.json` read `{"code":143,"signal":null,"exitedAt":"2026-08-22T13:01:47.997Z"}` while
`meta.json` in the same directory named `childPid: 2885497` — a process that was alive. **A
different broker wrote that exit into this run's spool.**

### Two live agents per run, observed directly

At 13:14, `systemctl --user list-units 'cezar-run-*'` plus `/proc/<pid>/cgroup` for every live
`claude`:

```
49a5aea3  pid 2808906  cezar-run-49a5aea3-…-mt4cnz7s-12.scope   (abandoned)
49a5aea3  pid 2995374  cezar-run-49a5aea3-…-mt4dkf3r-15.scope   (the one meta.json names)
eb9f65aa  pid 2818676  cezar-run-eb9f65aa-…-mt4cnz7s-17.scope   (abandoned)
eb9f65aa  pid 3044942  cezar-run-eb9f65aa-….scope               (the one meta.json names)
```

`mt4cnz7s` / `mt4dkf3r` are `PROCESS_STARTED_AT` prefixes: different **server generations**. Two
brokers, from two different cezar processes, one spool directory each pair.

### The chain

1. **The spool is run-scoped.** `run-spool.ts:128` — `spoolDirFor(runsDir, runId)` →
   `runs/<runId>.spool`. The doc comment above it says "one per agent session", which is what the
   rest of the code assumes and what the path does not deliver: it is one per **run**, shared by
   every step and every relaunch.
2. **Nothing clears a previous life's exit.** `ensureSpoolDir` (`run-spool.ts:132`) only
   `mkdirSync`s. An `exit.json` from an earlier broker is still there when the next one starts.
3. **The exit record has no owner.** `spoolExitSchema` (`run-spool.ts:52`) is
   `{code, signal, exitedAt}`. No pid, no instance id, no step id.
4. **The reader trusts it unconditionally.** `BrokeredSession.tick()`
   (`brokered-session.ts:171`) polls every `SPOOL_POLL_MS` (50 ms), and any `exit.json` at all
   ends the session. `brokeredExitFailure` (`claude-cli-runner.ts:1007`) then turns a non-zero
   code into the step's error unless `terminatedByCezar` is set — and it is not set, because
   *this* session signalled nothing.
5. **A deploy manufactures the twin.** `reattachBrokeredRun` (`workflows/run.ts:1806`) refuses to
   adopt a survivor when the spool holds any `exit.json` (`isSpoolLive`, `run-spool.ts:238`,
   returns false) or when `meta.stepId` is not where the chain resumes. When it refuses, the run
   restarts with a **fresh broker in the same directory** and nothing stops or reaps the old
   agent. The comment in that function says guessing between record and spool "is precisely how a
   run ends up with two live agents" — the guard prevents the wrong *attach*, not the second
   *agent*.
6. **The twin's death is scheduled.** The abandoned broker's orphan watchdog
   (`run-broker.ts:231`, `ORPHAN_TIMEOUT_MS` = 30 min at `run-broker.ts:61`) fires 30 minutes
   after its last control connection or output and calls `interrupt()` → SIGTERM. `claude`
   installs a SIGTERM handler and exits 143 rather than dying from it (the comment at
   `run-broker.ts:51` says so). The broker writes that 143 into the shared spool.
7. **The live sibling dies within 50 ms**, holding someone else's exit code.

### The 30-minute clock lands on the timestamps

Deploy activations that day: 12:20:41, 12:23:56, 12:47:48, 12:49:10, 13:11:26 — five restarts in
51 minutes with roughly ten agents in flight.

| abandoned broker | last activity | +30 min | what happened then |
|---|---|---|---|
| `232ad6d4` `continue-5` (abandoned by the 12:23:56 restart) | ~12:23:03 | **12:53:03** | `run-tests` reported "exited with code 143" |
| `232ad6d4` `continue-6` | ~12:31:47 | **13:01:47** | `exitedAt` of the `exit.json` found in that spool |
| `bde0ec40` `continue-1` | ~12:25:45 | **12:55:45** | `review-spec` reported "exited with code 143" |

Two of the three are exact to the second against timestamps recorded by different code paths.

### Why the step retry cannot save it

Nothing on the broker-start path unlinks `exit.json`, so a retry attaches to a directory whose exit
is already on disk and dies on its first `tick()`. Both failures burned more than one attempt
before the step gave up (the operator saw `✗ claude CLI exited with code 143` printed twice).
Step `iterations` accumulate across a run's restarts, so the counter itself is not a per-pass rate.

### Cost

`232ad6d4` reached **$82** and `49a5aea3` **$119**; `232ad6d4`'s `implement` step recorded $28.74
against 63 seconds of wall clock, which is two sessions billing one run. At cleanup there were ten
live agent sessions against six genuinely running runs, load average 11-13 on 8 vCPU, and thirteen
`cezar-run-*.scope` units, one of them from the previous day. `232ad6d4`'s spool had already been
swept by `sweepSpools` (`workflows/run.ts:1949`) while its agent kept writing to the unlinked file,
and its worktree was "discarded" while three gate suites still ran inside it.

## Solution

Make an exit record identify its writer, and give each broker launch its own directory. Both, not
either: the identity check is what makes a shared directory safe today, and the per-launch
directory is what stops the sharing from being load-bearing at all.

### P1 — an exit belongs to a broker (the fix that stops the bleeding)

- Add `brokerPid` and `instanceId` to `spoolExitSchema` and to `writeSpoolExit`'s caller in
  `run-broker.ts` (both already in scope there: `process.pid`, and the `instanceId` the launcher
  passes for the scope unit name).
- `BrokeredSession` records the `meta.pid` it attached to and **ignores an `exit.json` whose
  `brokerPid` is not that pid**, treating it as a foreign file rather than as its own exit.
- Back-compat: an exit with no `brokerPid` (written by a broker from before this change) is
  accepted only when `meta.pid` is dead. A live `meta.pid` plus an anonymous exit is the
  cross-talk case, and the live process wins.

### P2 — one directory per broker launch

- `spoolDirFor(runsDir, runId, instanceId)` → `runs/<runId>.spool/<instanceId>/`, keeping the run
  id as the prefix so an operator can still group a run's spools with one glob (the same shape
  `brokerScopeUnitName` settled on).
- `run.spoolDir` on the record already exists and is what re-attach resolves through
  (`workflows/run.ts:1732`), so the re-attach path needs the instance directory persisted, not a
  new lookup.
- `sweepSpools` sweeps the run directory and its instance children together.

### P3 — `ensureSpoolDir` unlinks a pre-existing `exit.json`

An exit from a previous life is never the child about to be spawned. Cheap, independently correct,
and it is what makes a retry able to succeed. Keep it after P2, because P2 makes it rare rather
than impossible (a re-used instance id, a restored backup, a manual copy).

### P4 — reap the twin when re-attach is refused

Every `return false` in `reattachBrokeredRun` leaves a live agent nobody owns. Before restarting
the chain, if `isPidAlive(meta.pid)`, stop that broker: SIGTERM the broker pid, or
`systemctl --user stop 'cezar-run-<runId>-*'` under `scope` isolation. Log it as a lifecycle
event ("adopted-out agent stopped") so the token spend is attributable rather than silent.

### P5 — do not deploy into live runs at this cadence

Five restarts in 51 minutes with ten agents in flight is the load that produced this. A deploy
should either drain (refuse to activate while any run has an open broker, with an override) or
adopt every survivor. Out of scope for the fix, in scope for the runbook.

## Data models

```ts
// run-spool.ts
export const spoolExitSchema = z.object({
  code: z.number().int().nullable().catch(null),
  signal: z.string().nullable().catch(null),
  exitedAt: z.string().optional().catch(undefined),
  brokerPid: z.number().int().positive().optional().catch(undefined),   // NEW
  instanceId: z.string().optional().catch(undefined),                   // NEW
}).passthrough();
```

`spoolDirFor(runsDir, runId, instanceId?)` — `instanceId` optional so the re-attach path and the
tests that launch once keep working, exactly as `brokerScopeUnitName` did it.

## Risks

- **A broker that dies without writing `exit.json`** (SIGKILL, OOM, power loss) leaves a session
  waiting on a file that will never appear. That is true today and P1 does not change it; the
  inactivity bound (`DEFAULT_RUN_IDLE_TIMEOUT_MS`) is what covers it, and P1 must not weaken it.
  Add a liveness check: if `meta.pid` is dead and no `exit.json` has appeared, finish the session
  rather than wait out the full 30 minutes.
- **P2 changes an on-disk layout that a running broker and a new server must straddle.** That is
  what `BROKER_PROTOCOL` is for. Bump it, and let a server that finds a protocol-1 flat spool read
  it read-only through the old path rather than refusing the run.
- **P4 kills agent work.** It is work nothing was going to collect — no server is reading that
  spool — but it is still tokens already spent, so the lifecycle event matters.

## Verification

1. **Unit — a foreign exit is ignored.** Two brokers over one spool dir; broker A writes
   `exit.json` with its own `brokerPid`; a `BrokeredSession` attached to broker B keeps running
   and settles only on B's exit. Negative control: with `brokerPid` stripped from A's exit and
   B's `meta.pid` alive, the session still keeps running; with B's `meta.pid` dead, it finishes.
2. **Unit — a stale exit does not poison a fresh broker.** Pre-seed `exit.json`, start a broker
   through `ensureSpoolDir`, assert the file is gone and the session runs to a real exit. This
   test fails on today's code.
3. **Unit — per-launch directories.** Two `spawnBroker` calls for one run produce two directories
   and two `meta.json`s; neither `exit.json` is visible to the other session.
4. **Integration — the reported failure, reproduced.** Start a brokered step; spawn a second
   broker for the same run; SIGTERM the second; assert the first is still running and its step is
   not `failed`. On today's code this fails with "claude CLI exited with code 143", which is the
   regression oracle.
5. **Runtime on `prod-host`** (the only place the deploy race is real): start a run, deploy
   mid-step, then assert (a) exactly one `claude` per run id across
   `systemctl --user list-units 'cezar-run-*'` and `/proc/<pid>/cgroup`, and (b) the run reaches a
   terminal state with no 143 attributed to a live pid. The one-agent-per-run count is the check
   that would have caught this before an operator did; it belongs on `/api/v1/health` next to
   `runtime.runBrokerIsolation`.
