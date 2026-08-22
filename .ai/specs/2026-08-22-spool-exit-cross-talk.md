# A run's spool is shared by every broker launch, so one dead twin's exit kills the live agent

**Status:** Implemented and shipped 2026-08-22. Code for P1-P4 is on `origin/main` at `ab63bcfa`
(fix commit `30e266e2`, "a dead twin's exit no longer kills the live broker's run", merged with
`origin/main` `75c7f1c0`). `npm run typecheck` is clean across all four packages and the full
`npm run test` gate passes for every file the diff touches or exercises (broker-launch,
brokered-session, run-spool, broker-scope-collision, brokered-parity, run-broker, runtime-info,
recover-brokered, missing-session-string-contract) as well as the regression test named in
Verification; the 5-6 flaky/pre-existing failures seen across two full-suite runs (perf-budget
timing, a `claude`-CLI-presence test, a KB-store timeout, and rotating `packages/web` component
tests) touch none of this diff and are not new. **The runtime acceptance criterion — exactly one
live `claude` per run id on `prod-host`, surfaced at `/api/v1/health`'s `runtime.runBrokers`
— is still QA Needed**: it can only be measured after this ships to that box, per the five steps
under "Runtime, on `prod-host`" below. Written 2026-08-22 for task
`f73115a0-f2d2-445d-9f23-559946796d97` against brief
`.ai/specs/briefs/2026-08-22-run-spool-exit-crosstalk.md`.
**Date:** 2026-08-22 (first draft committed as `3a54d156`; this revision settles the open questions
that draft left, and corrects two claims in it that a re-read of the code did not support, see
"Corrections to the first draft").

**Which tree this was read against.** Every file and line number below was read from
`origin/main` (`c1ccbe79`, 2026-08-22), not from the task worktree, which is 71 commits behind it
and therefore does not contain `nextBrokerInstanceId` (`0883256b`), the per-launch scope-unit fix
(`8e20dfbf`), or this spec's own first draft (`3a54d156`). **The implementation step must rebase
onto `origin/main` before writing code**, or it will build P1 and P2 on top of a
`brokerScopeUnitName(runId)` that has no `instanceId` to reuse, and will re-collide with
`8e20dfbf`. `run-spool.ts` and `run-broker.ts` are byte-identical in both trees, so their line
numbers hold either way.

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
2. **The clearing that does happen is aimed at the wrong moment.** `ensureSpoolDir`
   (`run-spool.ts:132`) only `mkdirSync`s, but `spawnBroker` (`claude-cli-runner.ts:401`) does
   `rmSync(request.spoolDir, { recursive: true, force: true })` before every launch. So a stale
   `exit.json` is in fact removed **at spawn time**, and the first draft's "nothing clears a
   previous life's exit" is wrong as a statement about the spawn path. It is right about the
   failure, for a different reason: the poisonous exit is written **after** the new broker starts,
   by a twin that is still alive, so no amount of clearing at spawn time can reach it. See
   "Corrections to the first draft".
3. **The exit record has no owner.** `spoolExitSchema` (`run-spool.ts:52`) is
   `{code, signal, exitedAt}`. No pid, no instance id, no step id.
4. **The reader trusts it unconditionally.** `BrokeredSession.tick()`
   (`brokered-session.ts:171`) polls every `SPOOL_POLL_MS` (50 ms), and any `exit.json` at all
   ends the session. `brokeredExitFailure` (`claude-cli-runner.ts:1007`) then turns a non-zero
   code into the step's error unless `terminatedByCezar` is set — and it is not set, because
   *this* session signalled nothing.
5. **A deploy manufactures the twin.** `reattachBrokeredRun` (`workflows/run.ts:1982`) refuses to
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

### Three more shared-path collisions the first draft did not name

A re-read of `run-broker.ts` and `claude-cli-runner.ts` on `origin/main` found that `exit.json` is
not the only file in that directory with two writers. All three are fixed by P2 and none of them
are fixed by P1 alone, which is the argument for doing both.

8. **A new broker deletes the live twin's control socket, at startup.** `run-broker.ts:227` does
   `rmSync(paths.ctl, { force: true })` before `server.listen(paths.ctl)`, justified by a comment
   that says "the spool is per-run and single-owner, so removing it is safe rather than a race".
   That premise is exactly the one this spec is retracting. The twin keeps running with a socket
   file that no longer exists at its path, so no server can ever send it a `send`, an `end` or an
   `interrupt` again: it is unreachable by anything except a signal, which is one reason cleaning
   one up by hand is so awkward (KB `notion-04ca960e6408`, lesson 4).
9. **A dying broker deletes the live sibling's control socket, at exit.** `run-broker.ts:248`
   does the same `rmSync(paths.ctl)` on the child-exit path, immediately after writing the
   poisonous `exit.json`. So the twin's death both kills the live session and, had the session
   survived, would have severed its stdin.
10. **A new broker deletes the live twin's whole transcript.** `spawnBroker`'s
    `rmSync(request.spoolDir, { recursive: true, force: true })` unlinks `out.ndjson` while the
    twin still holds an open append fd to that inode. The twin goes on writing into an unlinked
    file that no operator can find. This is the mechanism behind the observation already in this
    spec's Cost section, where `232ad6d4`'s agent kept writing after the spool was gone; the first
    draft attributed it to `sweepSpools`, and `sweepSpools` can do it too, but the per-step
    `rmSync` reaches it first and far more often.
11. **`brokeredExitFailure` re-reads the file rather than using the exit its session accepted.**
    `claude-cli-runner.ts:1007` calls `readSpoolExitSafe(spoolDir)` inside `buildResult`, so even a
    session that correctly ignored a foreign exit at `tick()` can pick that same foreign exit back
    up at the moment it builds its result, if the twin's write landed after its own. P1 is
    therefore not complete until the accepted exit is **threaded through** rather than re-read.

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

**Corrected from the first draft.** That draft said "nothing on the broker-start path unlinks
`exit.json`, so a retry attaches to a directory whose exit is already on disk". `spawnBroker`
does unlink it, with the whole directory (`claude-cli-runner.ts:401`), so a retry that goes
through `spawnBroker` starts clean. The retry still fails, for the reason the whole spec is about:
the twin is alive and on a 30-minute clock that has nothing to do with the retry, so it writes its
143 into the retried step's fresh directory too. Both failures burned more than one attempt before
the step gave up (the operator saw `✗ claude CLI exited with code 143` printed twice). Step
`iterations` accumulate across a run's restarts, so the counter itself is not a per-pass rate.

The one path where a pre-existing `exit.json` genuinely is read is **re-attach**, which never calls
`spawnBroker`: `reattachSession` goes straight to `attachBroker` (`claude-cli-runner.ts:372-382`),
and `isSpoolLive` (`run-spool.ts:238`) refuses the re-attach outright if any `exit.json` is present.
That is why P3 is still worth doing and why it is small: it closes the case where a directory is
re-entered without a spawn.

### Cost

`232ad6d4` reached **$82** and `49a5aea3` **$119**; `232ad6d4`'s `implement` step recorded $28.74
against 63 seconds of wall clock, which is two sessions billing one run. At cleanup there were ten
live agent sessions against six genuinely running runs, load average 11-13 on 8 vCPU, and thirteen
`cezar-run-*.scope` units, one of them from the previous day. `232ad6d4`'s spool had already been
swept by `sweepSpools` (`workflows/run.ts:2039`) while its agent kept writing to the unlinked file,
and its worktree was "discarded" while three gate suites still ran inside it.

## Corrections to the first draft

The first draft (`3a54d156`) is the basis of this one and its Problem section stands. Three things
in it are changed here rather than appended to, because a reader who acts on them would build the
wrong thing.

1. **"Nothing clears a previous life's exit" is wrong about the spawn path.** `spawnBroker` already
   removes the entire spool directory before every launch (`claude-cli-runner.ts:401`). The
   consequence for the design is that P3 is a small completeness fix on the re-attach path, not the
   thing that makes a retry able to succeed, and the acceptance criterion's phrasing should be read
   that way. It also means finding 10 above: that same `rmSync` is itself a cross-talk vector.
2. **`spoolDirFor`'s new `instanceId` parameter must NOT be optional.** The draft made it optional
   "so the re-attach path and the tests that launch once keep working". An optional discriminator
   defaults straight back to the flat, shared directory this spec exists to remove, silently, at
   every call site anyone forgets. Decided instead: the launch signature requires it, and reading a
   pre-existing flat spool is a separate, explicitly named function.
3. **P4's "SIGTERM the broker pid, **or** `systemctl --user stop 'cezar-run-<runId>-*'`" is unsafe
   as written, in both halves.** SIGTERM lets the broker's `child.on('exit')` handler run, which is
   the code that writes the poisonous `exit.json`; and the `cezar-run-<runId>-*` glob matches the
   healthy sibling's scope as well as the twin's. KB `notion-04ca960e6408` lesson 4 records both,
   measured during the 2026-08-22 cleanup, where getting it wrong cost run `49a5aea3` its in-flight
   `spec` step. The exact, ordered algorithm is specified in P4 below and the alternative is
   removed.

## Solution

Make an exit record identify its writer, and give each broker launch its own directory. Both, not
either: the identity check is what makes a shared directory safe today and on every spool written
before this ships, and the per-launch directory is what stops the sharing from being load-bearing
at all (and is the only thing that fixes findings 8, 9 and 10, which P1 does not touch).

### P1 — an exit belongs to a broker (the fix that stops the bleeding)

- Add `brokerPid` and `instanceId` to `spoolExitSchema`, and `instanceId` to `spoolMetaSchema`.
  `writeSpoolExit`'s caller in `run-broker.ts:246` has both in scope: `process.pid`, and the
  `instanceId` the launcher now passes down (see API contracts).
- **The launcher supplies the owner; it is never inferred from disk at attach.**
  `BrokeredSessionOptions` (`brokered-session.ts:46`) gains
  `owner?: { instanceId?: string; brokerPid?: number }`. `spawnBroker` passes the `instanceId` it
  just launched, the same one `brokerFor` generated and `spoolDirFor` was built from, and
  `reattachSession` → `attachBroker` (`claude-cli-runner.ts:372-382`, `:486`) seeds it from the
  `SpoolMeta` it is adopting: `meta.instanceId` when present, else `{ brokerPid: meta.pid }`.
  `BrokeredSession` then **ignores any `exit.json` that is not its owner's**, treating it as a
  foreign file rather than as its own exit.

  **The rule, stated exactly.** When the session has a known `owner.instanceId`, accept only an
  exit whose `instanceId` equals it. **An anonymous exit and a differing one are both ignored, and
  whether `meta.json` exists is irrelevant.** No filesystem read, no liveness probe, no startup
  race. This is every session created after this ships.

  **Why not "the `SpoolMeta` captured at attach", which is what the first draft of this section
  said.** There is no meta at attach on the spawn path, and the spawn path is the only one the bug
  occurs on. `spawnBroker` `rmSync`s the spool directory (`claude-cli-runner.ts:401`), spawns the
  broker as a detached child, and calls `attachBroker` in the same tick; `BrokeredSession`'s
  constructor calls `tick()` synchronously (`brokered-session.ts:132`). The broker writes
  `meta.json` from another process, measured at p50 621 ms and max 716 ms to bind on a loaded box
  (`PENDING_MAX_ATTEMPTS`' doc comment, `brokered-session.ts:32-44`), and `launchFailure`'s comment
  states the rule outright: "no `meta.json` yet" means nothing at t=0. A `readSpoolMeta()` at
  attach returns `null` there, so a meta-captured-at-attach gate would have no defined behaviour
  precisely where it is needed.
- **`isSpoolLive` must consult ownership too**, and this is not optional.
  `isSpoolLive` (`run-spool.ts:238`) does `if (readSpoolExit(spoolDir)) return false` at `:243`,
  which is the same unowned-exit defect as `tick()`, one layer up. It is today's behaviour, not a
  hypothetical: once a twin drops a foreign `exit.json` into the shared directory, that run's spool
  is permanently "not live", so the next restart's `reattachBrokeredRun` refuses to adopt a
  genuinely **healthy** run. Under this spec's own recommended ship order (phases 1 and 2 first,
  flat directory, no protocol bump) that refusal outlives phase 1, and once phase 4 lands
  `reapAbandonedBroker` **SIGKILLs the live, healthy broker** that refusal names. So `isSpoolLive`
  returns false only for an exit that `exitBelongsTo(meta, exit)` attributes to the spool's own
  meta; a foreign exit no longer disqualifies a live broker. **Prerequisite for P4**, which is why
  phase 4 depends on phase 1 and not only on phase 3. **Its doc comment changes with it**: the
  comment at `run-spool.ts:236-237` states the very semantics this bullet narrows ("and it has not
  recorded an exit"), so it must be rewritten to "and it has not recorded an exit **of its own**",
  the same way `brokerLaunchLogPath`'s comment is rewritten under P2.
- The accepted exit is **threaded through** to `buildResult` instead of being re-read from disk, so
  `brokeredExitFailure` cannot pick a foreign exit back up after `tick()` correctly rejected it
  (finding 11).

**Ownership test, in order.** This is `exitBelongsTo(meta, exit)`, a pure function over an on-disk
`SpoolMeta`, and it is the **fallback** for the two callers that have no launcher-supplied
identity: `isSpoolLive`, which by construction always has a meta, and a session seeded from a
protocol-1 re-attach, whose adopted meta carries no `instanceId` and which therefore reads the meta
at the moment it tests an exit rather than at attach. It settles brief questions 1 to 3.

| meta | exit | verdict |
|---|---|---|
| has `instanceId` | has `instanceId` | accept iff equal. **`instanceId` wins outright; `brokerPid` is not consulted.** |
| has `instanceId` | no `instanceId`, has `brokerPid` | accept iff `brokerPid === meta.pid` |
| has `instanceId` | anonymous | **reject, always.** A protocol-2 broker never writes an anonymous exit, so this file belongs to someone else or to a hand-run broker. |
| no `instanceId` (protocol 1) | any owned form | accept iff `brokerPid === meta.pid` |
| no `instanceId` (protocol 1) | anonymous | accept iff `!isPidAlive(meta.pid)` |
| **no meta on disk at all** | any | **reject, always.** No owner was supplied and there is nothing to compare against, which is the startup race (`brokered-session.ts:132`), not a terminal state. Wait for a meta rather than adopt an unattributable exit. |

`instanceId` beats `brokerPid` because it is the only one of the two that cannot repeat:
`nextBrokerInstanceId()` (`broker-isolation.ts:107`) is `PROCESS_STARTED_AT` plus a monotonic
counter, while a pid is recycled by the kernel. Under protocol 2 the launcher-supplied rule above
decides every session and this table is reached only by `isSpoolLive`; within it row 1 is the only
row that runs in practice, and the pid comparisons are dead weight kept for the migration window
and for `isSpoolLive` over a protocol-1 spool.

**Why pid reuse cannot cause a false accept (brief question 3).** The only row that consults
liveness is the protocol-1 anonymous row, and it accepts on `meta.pid` being **dead**. A recycled pid makes a dead
broker look alive, which pushes that row to *reject*, so the failure direction is a session that
waits rather than a session that swallows a stranger's exit. That wait is bounded by the existing
inactivity contract (`DEFAULT_RUN_IDLE_TIMEOUT_MS`, `claude-cli-runner.ts:62`), which P1 must not
weaken, plus the new "dead broker, no exit" liveness rule in Risks. The row is also reachable only
on a spool written before this ships, and `spawnBroker` replaces every such directory at the next
step boundary, so its lifetime is one step per run in flight at deploy time.

### P2 — one directory per broker launch

- `spoolDirFor(runsDir, runId, instanceId)` → `runs/<runId>.spool/<instanceId>/`, keeping the run
  id as the prefix so an operator can still group a run's spools with one glob (the same shape
  `brokerScopeUnitName` settled on in `8e20dfbf`). **`instanceId` is required**, per correction 2.
  Reading a pre-existing flat spool is `legacySpoolDirFor(runsDir, runId)`, and it has **two**
  callers, not one. `spoolDirFor` has exactly two production call sites on `origin/main`:
  `brokerFor` (`run.ts:1922`), which gains the instance id, and **`spoolDirOf` (`run.ts:1907-1909`)**,
  whose fallback `run.spoolDir ? join(dataDir, run.spoolDir) : spoolDirFor(join(dataDir,'runs'), run.id)`
  fires when the record carries no `spoolDir` at all — which per `runs.ts:449-451` means "this run
  was never brokered", **not** "protocol-1 re-attach". So `spoolDirOf`'s fallback takes
  `legacySpoolDirFor` (it is computing a path for a run that has no recorded spool, and guessing an
  instance id there would be a fabrication), and so does the protocol-1 branch of re-attach.
  `run.ts:1907-1909` is a site the implementation changes.
- **Four test call sites pin the old two-argument signature** and must be updated with it:
  `run-spool.test.ts:55`, `brokered-parity.test.ts:82`, and `recover-brokered.test.ts:91` and
  `:183`. Missing any of them is a typecheck failure, not a silent one.
- `BROKER_PROTOCOL` goes to **2**. A protocol-2 server meeting a protocol-1 spool takes today's
  path: `isSpoolLive` already returns false on a protocol mismatch (`run-spool.ts:242`), so the
  re-attach is refused and the chain restarts, now with P4 reaping the survivor first. The first
  draft asked instead for a read-only legacy attach; that is **rejected**, because attaching to a
  flat spool means trusting an anonymous exit written into a directory with more than one writer,
  which is the defect.
- `run.spoolDir` on the record already exists and is what re-attach resolves through
  (`workflows/run.ts:1907-1909`), so the instance directory is persisted there
  (`runs/<runId>.spool/<instanceId>`) and the re-attach path needs no new lookup. `consumedOffset`
  stays a single number and stays correct: only one instance is ever the run's active spool.
- **`spawnBroker`'s pre-launch `rmSync` is narrowed to the instance directory.** This is required,
  not cosmetic: today it deletes the run directory and with it a live twin's `out.ndjson` and
  `ctl.sock` (findings 8 and 10). Against a fresh `<instanceId>` the removal is a no-op that keeps
  the original guarantee, that `isSpoolLive` never observes a half-replaced spool.
- **The launch log moves with it.** `brokerLaunchLogPath` (`claude-cli-runner.ts:1074`) derives
  `<runId>.broker.log` from `dirname(spoolDir)`, which under the nested layout would resolve to
  `<runId>.spool/<instanceId>.broker.log`. Both spellings are acceptable once nothing deletes the
  run directory per launch; the decision is to **keep the log at `runs/<runId>.broker.log`**, one
  file per run appended across its steps, exactly as `8e20dfbf` designed it, by deriving it from
  the run id rather than from the spool path. **Its doc comment must be rewritten with it**: the
  comment at `claude-cli-runner.ts:1066-1072` justifies the log's location by the very `rmSync`
  this phase narrows ("`spawnBroker` deletes `<runId>.spool` before every launch"), so leaving it
  in place would document a mechanism that no longer exists. The location is still correct; the
  reason becomes "one file per run, appended across its steps, and the run directory now outlives
  every individual launch".
- `sweepSpools` becomes two-level: see P2b.

### P2b: a sweep proves each instance is dead before removing it

This settles brief question 5, and it is the direct fix for the observation in Cost, where a live
agent kept writing into a spool `sweepSpools` had already unlinked.

- Never remove `<runId>.spool/<instanceId>/` whose `meta.pid` is alive, **regardless of whether the
  run is live**. Run liveness is the wrong question: the whole incident is a live process under a
  dead run.
- Remove the parent `<runId>.spool/` only when the run is not in `liveRunIds` **and** every child
  was removable.
- A child with no parseable `meta.json` is removable only once its directory mtime is older than
  `SPOOL_ORPHAN_GRACE_MS` (defined as `ORPHAN_TIMEOUT_MS`, 30 min), so a directory created
  microseconds before its broker writes `meta.json` can never be swept out from under itself.
- A flat protocol-1 `<runId>.spool/` (a directory containing `meta.json` rather than instance
  children) keeps today's rule plus the liveness guard: skip if the run is live, skip if
  `meta.pid` is alive, else remove.

### P3 — `ensureSpoolDir` unlinks a pre-existing `exit.json`

An exit from a previous life is never the child about to be spawned. `ensureSpoolDir`
(`run-spool.ts:132`) `mkdirSync`s and then `rmSync(paths.exit, { force: true })`. Cheap and
independently correct. Scoped honestly per correction 1: `spawnBroker` already removes the whole
directory, so this closes the paths that do not go through `spawnBroker` (a broker started by hand
via `cezar run-broker`, a restored backup, a re-used instance id) rather than being the thing that
unblocks a step retry.

### P4 — reap the twin when re-attach is refused

Every refusal in `reattachBrokeredRun` (`workflows/run.ts:1982-1998`) that abandons an existing
broker leaves a live agent nobody owns. Before the chain restarts, reap it. **Not every `return
false` in that function is such a refusal**: the first two (`:1984`, a non-brokered backend;
`:1986`, `!isSpoolLive` — which covers no spool at all, but also a protocol mismatch, a foreign
exit and a dead pid) may have no broker behind them, and the algorithm's opening
`if (!meta) return 'none'` is what handles them, so the call is unconditional and the decision is
made from the meta rather than from the call site. This settles brief question 4, and the ordering
below is load-bearing rather than stylistic.

```
reapAbandonedBroker(runId, spoolDir, isolation) →
  meta = readSpoolMeta(spoolDir);        if (!meta) return 'none'
  if (!isPidAlive(meta.pid))             return 'already-dead'

  1. kill(meta.pid, 'SIGKILL')           ← SIGKILL, never SIGTERM
  2. poll isPidAlive(meta.pid) every 100 ms up to BROKER_REAP_TIMEOUT_MS (2 000)
  3. isolation === 'scope' && meta.instanceId
       ? systemctl --user stop <brokerScopeUnitName(runId, meta.instanceId)>   ← EXACT unit
       : kill(meta.childPid, 'SIGTERM'), then SIGKILL after INTERRUPT_KILL_GRACE_MS
  4. store.appendEvent(runId, { type: 'lifecycle', message: … })
```

- **SIGKILL, not SIGTERM, and this is the entire point of the phase.** SIGTERM leaves the broker's
  `child.on('exit')` handler (`run-broker.ts:240-258`) alive to run, and that handler is the code
  that writes `exit.json`. Reaping a twin politely is how you fire the gun the spec is about.
  SIGKILL has no handler to run, so no exit record is written and the sibling is untouched.
- **The exact unit name, never the `cezar-run-<runId>-*` glob.** The glob matches the healthy
  sibling's scope too. `brokerScopeUnitName(runId, meta.instanceId)` names one launch, which is
  precisely what `8e20dfbf` made possible.
- **Step 3 is ordered after step 1 for the same reason**: stopping the scope first SIGTERMs
  everything in the cgroup including the broker.
- **Protocol-1 spools have no `meta.instanceId`,** so no exact unit name can be derived. In that
  case do steps 1 and 2 and the `childPid` kill only, stop no scope at all, and say so in the
  event. Leaving a scope active is a leak an operator can see; stopping the wrong one is a live
  agent killed.
- **The lifecycle event** is
  `adopted-out agent stopped: broker <pid>, instance <id or "unknown">, step <stepId>; its output was not collected`,
  appended before `execute()` is called, so the token spend is attributable rather than silent
  (KB `notion-04ca960e6408`, lesson 3: two sessions attributing to one run is what an impossible
  cost number looks like).

### P5: the one-agent-per-run invariant, reported

The check that would have caught this before an operator did is **exactly one live broker per run
id**. It is additive on `runtime` in `/api/v1/health` and `/api/v1/ready`, beside
`runBrokerIsolation`, and it is derived from the **spool tree**, not from systemd, so it reports
the same thing on a box with isolation `none` (brief question 6). Shape and collection are in
API contracts below.

Two things it deliberately does not do. It does not alarm on a brief overlap: a run legitimately
has two live brokers for the milliseconds between one step's broker exiting and the next binding,
so the field reports an instantaneous count and the invariant is asserted by the runtime check with
a settle window, not by the server. And it counts only instance directories whose `meta.pid` is
alive, so a historical run with twenty swept-but-present spools contributes zero.

### Out of scope: a deploy that drains or adopts

Five restarts in 51 minutes with ten agents in flight is the load that produced this. A deploy
should either drain (refuse to activate while any run has an open broker, with an override) or
adopt every survivor. **Explicitly not in this task** (brief question 7): the acceptance criteria
stop at P4 plus the runtime invariant, and P1 to P5 above make an abandoned twin harmless rather
than lethal, which is the part that is urgent. File it as its own todo and record it in the runbook.
Note that until it exists, P4 converts every refused re-attach into killed agent work, which is the
trade-off the lifecycle event exists to make visible.

## Architecture

The identity that already exists at launch time is carried all the way down to the terminal record,
and the directory is keyed on it. Nothing new is invented: `instanceId` is `8e20dfbf`'s, reused.

```
RunManager.brokerFor(runId, stepId, backend)              workflows/run.ts:1919
  instanceId  = nextBrokerInstanceId()                    broker-isolation.ts:107   ← moved UP to here
  spoolDir    = spoolDirFor(runsDir, runId, instanceId)   runs/<runId>.spool/<instanceId>/
  store.updateRun(runId, { spoolDir: <relative>, consumedOffset: 0 })
        │
        ▼
ClaudeCliRunner.spawnBroker(request)                      claude-cli-runner.ts:385
  rmSync(request.spoolDir)                                ← the INSTANCE dir only, never the run dir
  argv = buildBrokerLaunchArgv({ runId, instanceId, … })  --unit=cezar-run-<runId>-<instanceId>
  brokerArgs({ …, instanceId })                           --instance <instanceId>
  launchLog = runs/<runId>.broker.log                     ← derived from runId, not from spoolDir
  attachBroker(…, { owner: { instanceId } })              ← the OWNER travels from the launcher,
                                                            because no meta.json exists yet here
        │
        ▼
startRunBroker({ spoolDir, runId, instanceId, … })        run-broker.ts:93
  ensureSpoolDir(spoolDir)                                + unlink a stale exit.json          (P3)
  writeSpoolMeta({ protocol: 2, pid: process.pid, instanceId, … })
  child.on('exit') → writeSpoolExit({ code, signal, exitedAt, brokerPid: process.pid, instanceId })
        │
        ▼
BrokeredSession.tick()                                    brokered-session.ts:171
  owner = opts.owner                                      ← supplied at construction; NOT a
  exit  = readSpoolExit(spoolDir)                            SpoolMeta read at attach
  owner.instanceId ? accept iff exit.instanceId === it   ← the foreign-exit gate               (P1)
                   : exitBelongsTo(readSpoolMeta(), exit)   (fallback: protocol-1 re-attach)
  finish(exit)  →  buildResult(exit)                      ← accepted exit threaded, not re-read

RunManager.recover → reattachBrokeredRun                  workflows/run.ts:1982
  isSpoolLive(spoolDir)                                   run-spool.ts:238
    a FOREIGN exit.json no longer makes a live spool dead                                      (P1)
  every refusal → reapAbandonedBroker(...)                SIGKILL broker, then exact scope     (P4)
                → lifecycle event
RunManager.sweepSpools                                    workflows/run.ts:2039
  two levels; never removes an instance whose meta.pid is alive                               (P2b)
GET /api/v1/health, /api/v1/ready → runtime.runBrokers    server/runtime-info.ts:32            (P5)
```

The one structural move is `nextBrokerInstanceId()` from `spawnBroker` up into `brokerFor`. It has
to happen there because the spool path is decided there, and the record's `spoolDir` is written
before the spawn on purpose (`run.ts:1923-1925`: a crash in the same millisecond must still leave
the next process a path to probe). The re-attach path calls neither, which is correct: it resolves
the instance directory from the record.

## Phases

Each phase is independently shippable and independently valuable; each has its own gate.

| Phase | Delivers | Acceptance criterion | Depends on |
|---|---|---|---|
| **1** | Owned exits: schema fields, broker writes them, launcher-supplied `owner` gate in `BrokeredSession`, `exitBelongsTo` in `isSpoolLive`, accepted exit threaded to `buildResult`. `instanceId` plumbed from `brokerFor` through `brokerArgs`/`--instance` to `writeSpoolMeta`. | P1 | none |
| **2** | `ensureSpoolDir` unlinks a stale `exit.json`. | P3 | none (do it with phase 1; it is four lines) |
| **3** | Nested layout: `spoolDirFor(runsDir, runId, instanceId)`, `legacySpoolDirFor`, `BROKER_PROTOCOL = 2`, narrowed `spawnBroker` `rmSync`, launch-log path pinned to the run id, two-level `sweepSpools`. | P2 | phase 1 (needs `instanceId` already plumbed) |
| **4** | `reapAbandonedBroker` on every refused re-attach, with the lifecycle event. | P4 | **phase 1, hard** (the `isSpoolLive` ownership fix: without it a foreign `exit.json` makes a healthy spool read as dead and phase 4 SIGKILLs the live broker), plus phase 3 (needs `meta.instanceId` for the exact unit name; degrades safely without it) |
| **5** | `runtime.runBrokers` on `/api/v1/health` and `/api/v1/ready`, plus the runtime check on `prod-host`. | runtime check | phase 3 (counts instance dirs) |
| **6** | *Out of scope, filed separately:* a deploy that drains or adopts. | none | phases 1-5 |

**Ship phases 1 and 2 together and first.** They stop the bleeding on their own, without an on-disk
layout change and without a protocol bump, so they can go out during a period with runs in flight.
Phase 3 costs every in-flight brokered run a re-attach refusal at the deploy that ships it (see
Risks), so it wants a quiet window.

## Data models

```ts
// packages/cezar/src/core/run-spool.ts

/** 2: exit records name their writer, and each broker launch owns its own directory. */
export const BROKER_PROTOCOL = 2;

export const spoolMetaSchema = z.object({
  // …unchanged…
  /** The launch this spool belongs to (`nextBrokerInstanceId()`). Written by every protocol-2
   *  broker; absent only on a protocol-1 spool, where the directory was shared. */
  instanceId: z.string().min(1).optional().catch(undefined),            // NEW
}).passthrough();

export const spoolExitSchema = z.object({
  code: z.number().int().nullable().catch(null),
  signal: z.string().nullable().catch(null),
  exitedAt: z.string().optional().catch(undefined),
  brokerPid: z.number().int().positive().optional().catch(undefined),   // NEW
  instanceId: z.string().min(1).optional().catch(undefined),            // NEW
}).passthrough();

/** `<dataDir>/runs/<runId>.spool/<instanceId>` — one per broker LAUNCH. */
export function spoolDirFor(runsDir: string, runId: string, instanceId: string): string;

/** `<dataDir>/runs/<runId>.spool` — the pre-protocol-2 flat layout. Read-only, one caller. */
export function legacySpoolDirFor(runsDir: string, runId: string): string;

/** The ownership test in the P1 table. Pure; no filesystem access except the last row's
 *  `isPidAlive`, which is injected so a test can drive it. */
export function exitBelongsTo(
  meta: SpoolMeta | null,          // null = the last table row: nothing on disk yet, so reject
  exit: SpoolExit,
  alive: (pid: number) => boolean = isPidAlive,
): boolean;

export const SPOOL_ORPHAN_GRACE_MS = ORPHAN_TIMEOUT_MS;   // 30 min, for the sweep's meta-less case
export const BROKER_REAP_TIMEOUT_MS = 2_000;              // P4 step 2
```

```ts
// packages/cezar/src/core/brokered-session.ts

export interface BrokeredSessionOptions {
  // …unchanged…
  /**
   * Whose `exit.json` this session is allowed to accept, SUPPLIED BY THE LAUNCHER.
   *
   * Not read from `meta.json`: on the spawn path there is no meta yet (the constructor ticks
   * synchronously and the broker binds at p50 621 ms from another process), so an identity read
   * at attach is `null` exactly where the gate is needed. `spawnBroker` passes the `instanceId`
   * it launched; `attachBroker` on the re-attach path seeds it from the adopted `SpoolMeta`
   * (`instanceId` when present, else `{ brokerPid: meta.pid }`).
   *
   * With an `instanceId`: accept only an equal one, and ignore anonymous and differing exits
   * alike. Without one (a protocol-1 re-attach): fall back to `exitBelongsTo` against a meta
   * read at test time. Absent entirely: today's unowned behaviour, kept only so an embedder
   * constructing a session by hand does not silently stop settling.
   */
  owner?: { instanceId?: string; brokerPid?: number };                  // NEW

  /**
   * CHANGED — today `() => AgentRunResult` (`brokered-session.ts:65`).
   *
   * The accepted exit is threaded through rather than re-read from disk (P1's last bullet):
   * `finish()` passes the exit it accepted, `detach()` passes `null`. Re-reading is finding 11 —
   * `tick()` correctly rejects a foreign `exit.json` and then `buildResult` picks the same file
   * back up off the filesystem.
   */
  buildResult?: (exit: SpoolExit | null) => AgentRunResult;             // CHANGED
}
```

The matching change on the runner side: **`brokeredExitFailure` (`claude-cli-runner.ts:1007`)
takes the accepted exit, not a directory to re-read.**

```ts
// packages/cezar/src/core/claude-cli-runner.ts

// before: (spoolDir: string, timedOut, terminatedByCezar) → readSpoolExitSafe(spoolDir) inside
function brokeredExitFailure(
  exit: SpoolExit | null,          // CHANGED — the exit `BrokeredSession` accepted
  spoolDir: string,                // kept, but ONLY for `spooledStderrTail` in the message
  timedOut: boolean,
  terminatedByCezar: boolean,
): Error | null;
```

`spoolDir` stays a parameter because `brokeredExitMessage` appends `spooledStderrTail(spoolDir)`,
which is a different file (`err.log`) and has no ownership problem. The call site at
`claude-cli-runner.ts:551` passes the exit its enclosing `buildResult` was handed.

Both new fields are `.optional().catch(undefined)` in the **read** schema and mandatory in the
**write** path, which is the asymmetry correction 2 is about: optionality exists to parse an old
record, never to let a new writer omit it.

On-disk layout, before and after:

```
before                                   after
runs/                                    runs/
  <runId>.spool/                           <runId>.spool/
    meta.json                                <instanceId-a>/     ← step 1's broker
    out.ndjson                                 meta.json  out.ndjson  err.log  ctl.sock  exit.json
    err.log                                  <instanceId-b>/     ← step 2's broker
    ctl.sock                                   meta.json  out.ndjson  err.log  ctl.sock  exit.json
    exit.json                              <runId>.broker.log    ← unchanged, one per run
  <runId>.broker.log                       <runId>.ndjson        ← unchanged
  <runId>.ndjson
```

`controlSocketPath` (`run-spool.ts:109`) needs no change and its fallback matters more now: the
nested path adds `/<instanceId>` (about 12 characters) to a budget that is already ~98 characters
from a short project root, so more spools will land on the hashed `/tmp` socket. That path is
deterministic and derived from the resolved spool dir, so it stays unique per instance. Worth an
explicit test rather than an assumption.

**Run record.** No schema change. `runRecordSchema.spoolDir` (`packages/contract/src/runs.ts:453`)
is already `z.string().optional()` holding a `dataDir`-relative path; its **meaning** narrows from
"this run's spool" to "this run's *active* spool", and its doc comment must say so.
`consumedOffset` (`:462`) stays one number per run and stays exact, because a run reads exactly one
instance at a time.

## API contracts

**`GET /api/v1/health` and `GET /api/v1/ready`** gain one additive, optional field under the
existing `runtime` object (`packages/contract/src/health.ts:160`). Additive-only, per
`BACKWARD_COMPATIBILITY.md` §2, which governs this payload.

```ts
export const runtimeInfoSchema = z.object({
  socketActivated: z.boolean(),
  runBrokerIsolation: z.enum(['scope', 'delegated', 'none']),
  brokeredBackends: z.array(z.string()),
  brokerAvailable: z.boolean(),
  /**
   * Live broker processes, counted from the spool tree rather than from systemd so the answer is
   * the same under every isolation mode. Absent when the scan was skipped (see below).
   */
  runBrokers: z.object({
    /** Instance directories whose `meta.pid` is alive, across every run. */
    live: z.number().int().nonnegative(),
    /** Run ids with more than one. Non-empty is the invariant this spec restores, violated. */
    runsWithMultipleBrokers: z.array(z.string()),
  }).optional(),                                                        // NEW
});
```

**Two declarations change, not one.** `runtimeInfoSchema` above is the contract; the **local**
`RuntimeInfo` interface at `server/runtime-info.ts:18` is a separate hand-written declaration that
the route's inferred DTO is checked against, and it gains the same optional `runBrokers` field.
Changing one without the other does not compile.

**`runtimeInfo()` gains a `dataDir` parameter, because today it cannot reach one.** Its signature
(`server/runtime-info.ts:32`) is `{ socketActivated, isolation, env }`: no `dataDir`, no store, no
manager, so there is nothing to scan. Add `dataDir?: string` (the runs directory is
`join(dataDir, 'runs')`, the same join every other caller uses, e.g. `server.ts:4921`). The single
construction site is `describeRuntime()` (`server.ts:2008`), which both `/api/v1/health` (via
`healthSnapshot`) and `/api/v1/ready` (`server.ts:2209`) call, so passing `bootDataDir`
(`server.ts:1403`) there covers both endpoints in one place. **When `dataDir` is absent the field
is omitted, never guessed** from `process.cwd()` or from the module's own location: an embedder
that assembles `ServerDeps` by hand is a shape that reaches this code in practice, and health is
not allowed to be the thing that breaks. The count is therefore scoped to the **boot project's**
`dataDir`, which is where `prod-host` runs its runs; a lazily-built non-boot project's spools
are out of scope for this field, and the runtime check's step 2 (from the box, via cgroups) is what
covers the whole machine.

Collection: `readdirSync(<dataDir>/runs)` for `*.spool`, one level down for instance children,
`readSpoolMeta` plus `isPidAlive` on each. No `systemctl`, no `ps`, no spawn, consistent with
`probeIsolationCapabilities`'s existing "filesystem checks only" rule
(`broker-isolation.ts:183`). Bounded: if the tree holds more than `HEALTH_SPOOL_SCAN_MAX` (256)
instance directories the field is **omitted** rather than computed, so a box that has stopped
sweeping cannot make its own health endpoint slow. `/health` is CORS-open and cached, so the field
carries run ids only, which are already in that payload's neighbourhood via the runs API and are
opaque uuids.

**`cezar run-broker`** gains `--instance <id>` (`ParsedBrokerArgv`, `run-broker-cli.ts:19-27`;
parsed in `parseBrokerArgv`, `:36`; emitted by `brokerArgs` in `broker-launch.ts:75`). Optional at
the CLI so a hand-started broker still works; when absent the broker writes a protocol-1-shaped
meta with no `instanceId` and its exits are anonymous, which the P1 table already handles.
`RunBrokerOptions` (`run-broker.ts:63`) gains `instanceId?: string`.

`BrokerSessionRequest` (`broker-launch.ts:96`) gains **`instanceId?: string`** — optional in the
type, mandatory in practice on the spawn path: `brokerFor` (`run.ts:1919-1925`) always sets it,
and `spawnBroker` throws if it is absent, because the spool path it was handed was built from it.
It is optional because **the re-attach construction site cannot supply one**: `run.ts:5088-5096`
builds a `BrokerSessionRequest` object literal from `takeReattach()` — `{spoolDir, runId, stepId,
startOffset, isolation, onOffset}` — and on a protocol-1 spool there is no instance id in
existence to put there. Making the field required would turn that literal into a type error with
no correct value to fix it with. That literal deliberately leaves `instanceId` unset;
`attachBroker` seeds the session's owner from the adopted `SpoolMeta` instead (P1). Name
`run.ts:5088-5096` as a call site the implementation touches, even though the touch is a comment
saying why the field stays unset.

**No other wire change.** No REST route, request body, SSE event or CLI output changes.

## Risks

- **A broker that dies without writing `exit.json`** (SIGKILL, OOM, power loss) leaves a session
  waiting on a file that will never appear. That is true today and P1 does not change it; the
  inactivity bound (`DEFAULT_RUN_IDLE_TIMEOUT_MS`, `claude-cli-runner.ts:62`) is what covers it,
  and P1 must not weaken it. **P4 makes this strictly more common**, because SIGKILL is exactly the
  death that writes no exit record. So the liveness check is a requirement of this spec, not a
  nice-to-have: in `tick()`, once a meta has been read at least once, if `meta.pid` is dead and no
  acceptable `exit.json` is present, end the session rather than wait out the full 30 minutes.

  **It must end as a FAILURE, and getting this wrong ships a silent bug.** The obvious spelling,
  "call `finish(null)`", settles the run as a **success**: `finish` settles with
  `buildResult()` (`brokered-session.ts:195`), which on the runner path is
  `brokeredExitFailure(spoolDir, …)` (`claude-cli-runner.ts:547-554`); with no `exit.json` that
  reads `exit = null` → `code = null` → `if (code === 0 || code === null) return null`
  (`:1011`), so nothing is thrown, and `emitBrokeredTerminalEvents` emits `{type:'done'}` for a
  null code (`:987-1003`). The step would be marked **done** with a truncated transcript and the
  chain would proceed on it. That path is unreachable today — `finish()` is only ever called from
  `tick()` with a real `SpoolExit` (`brokered-session.ts:171-183`) — so this spec is what makes it
  reachable, and P4 is what makes it common, by SIGKILLing brokers on purpose.

  The required behaviour: the session's `result` **rejects**, with an explicit message such as
  `run broker <pid> died without recording an exit (instance <id>)`. Two acceptable
  implementations, either is fine as long as the reject is real: a `brokerVanished` branch in
  `attachBroker`'s `buildResult` (`claude-cli-runner.ts:547-554`) that throws before
  `brokeredExitFailure` is consulted, or a synthetic `SpoolExit` threaded into `finish` carrying a
  non-zero code and a marker the runner turns into that message. **It must NOT go through
  `giveUp`** (`brokered-session.ts:261`): that path's own comment (`:255-260`) reserves it for "the
  control channel never came up" and deliberately skips `onExit`, so routing a died-mid-run broker
  through it would suppress the terminal events the run's transcript needs.

  The liveness read is a **per-tick** read, not the owner: the owner comes from the launcher (P1)
  and never touches the filesystem, while this liveness probe reads `meta.json` fresh each poll
  precisely because it is allowed to be absent. Guard it against the startup race, where
  `meta.json` does not exist yet and there is no pid to test: only apply the rule once a meta has
  been read at least once, which is the same reason the P1 table's last row rejects rather than
  accepts.
- **P2 changes an on-disk layout that a running broker and a new server must straddle**, and the
  deploy that ships it therefore refuses to re-attach to every in-flight brokered run (protocol 1
  versus 2) and reaps it under P4. That is a one-time cost of one killed agent per brokered run in
  flight, and it is the honest one: the alternative the first draft proposed, a read-only legacy
  attach, means trusting an anonymous exit in a shared directory. Mitigation is scheduling, not
  code: ship phases 1 and 2 first, and land phase 3 when few runs are in flight. Phase 3's own
  verification must include watching a run in flight across that deploy and confirming the reap
  event rather than a silent orphan.
- **P4 kills agent work.** It is work nothing was going to collect (no server is reading that
  spool), but it is still tokens already spent, so the lifecycle event matters. Whenever
  `reattachBrokeredRun` refuses for a *recoverable* reason, P4 turns that refusal into a killed
  agent. **One such reason exists today** and is fixed in phase 1, not deferred: a foreign
  `exit.json` making `isSpoolLive` report a healthy spool as dead. That is the ordering constraint
  in the phase table, and every new refusal path added to that function must be reviewed against
  this the same way.
- **`instanceId` is trusted as unique.** It is `PROCESS_STARTED_AT` plus a monotonic counter
  (`0883256b`), unique within a machine's lifetime. Two cezar servers started in the same
  millisecond on one box, both writing into one `dataDir`, would collide; that is already true of
  the scope unit name `8e20dfbf` settled on, and cezar does not support two servers over one
  `dataDir` for reasons that predate this.
- **Socket path length.** The nested layout lengthens every spool path by `/<instanceId>`, pushing
  more spools past the 107-byte `sun_path` budget onto `controlSocketPath`'s hashed `/tmp`
  fallback. That fallback exists and is deterministic, but it is now on the common path rather than
  the rare one, so it must be tested at the new depth rather than assumed.
- **The health scan touches the filesystem on a cached, CORS-open endpoint.** Bounded by
  `HEALTH_SPOOL_SCAN_MAX`, and the field is omitted rather than partial when the bound is hit, so a
  degraded box reports nothing rather than a wrong number.
- **The worktree this task runs in is 71 commits behind `origin/main`** and lacks
  `nextBrokerInstanceId`, so an implementation written against it would reinvent the launch
  identity instead of reusing it. Rebase first. See the note under Status.

## Verification

The regression oracle is test 4: **it must be written first and must fail on today's code with
`claude CLI exited with code 143`.** A phase-1 patch that does not turn that test from red to green
has not fixed this bug, whatever else it does.

### Automated

New file `packages/cezar/src/core/spool-exit-crosstalk.test.ts` unless noted. Every test uses the
existing `mkdtempSync` scratch-dir pattern from `run-spool.test.ts:30`. Where a "broker" is needed,
use a real `startRunBroker` over a trivial child (`node -e`), as `run-broker.test.ts` already does,
not a mock: the thing under test is what the process writes on exit.

1. **`exitBelongsTo`, one case per row of the P1 table** (in `run-spool.test.ts`). Six cases, with
   `alive` injected so the pid-liveness row is deterministic. Red before phase 1: the function does
   not exist and `tick()` has no gate.
2. **A foreign exit is ignored** (`brokered-session.test.ts`). One spool directory; a session
   constructed with `owner: { instanceId: 'B' }` and **no `meta.json` on disk at all**, which is
   the production spawn path and the case a meta-at-attach design cannot serve; write an
   `exit.json` carrying `instanceId: 'A'`; advance the poll timer and assert `session.result` is
   still pending and `onExit` never fired. Then write B's own exit and assert it settles with B's
   code. Controls: (a) an anonymous exit is ignored by an owner-bearing session even though
   `meta.json` is absent; (b) a session with `owner: { brokerPid }` only (the protocol-1 re-attach
   seed) plus a protocol-1 meta and a dead `meta.pid` accepts an anonymous exit and finishes.
3. **The accepted exit is not re-read** (`brokered-session.test.ts` plus a runner-level case).
   Session accepts B's exit `{code: 0}`; before `buildResult` runs, overwrite `exit.json` with A's
   `{code: 143}`; assert the result is success. Red today: `brokeredExitFailure`
   (`claude-cli-runner.ts:1007`) re-reads the file and throws.
4. **The reported failure, reproduced end to end.** Two `startRunBroker` calls for one run id.
   **The twin is the OLDER broker**, matching production, where the abandoned broker predates the
   live sibling: start twin `A` first, then the watched broker `B`, and attach the
   `BrokeredSession` to `B`.

   **B's session must be built with a `buildResult`, or the test cannot be red.** A bare
   `BrokeredSession` with `buildResult` unset settles with `{text:'',toolCalls:[],tokensUsed:0}`
   (`brokered-session.ts:195`) when it swallows A's foreign exit — so on today's code it would
   settle **successfully** and the test would fail with "expected pending, got settled", not with
   the message the acceptance criterion names. That message exists only where `attachBroker` wires
   `buildResult` to `brokeredExitFailure` (`claude-cli-runner.ts:547-554`). Pick one, explicitly:
   **either** drive B through `ClaudeCliRunner`'s brokered path so the red is the real production
   message, **or** construct B's session with
   `buildResult: () => { const f = brokeredExitFailure(spoolB, false, false); if (f) throw f; return totals; }`
   (today's 4-argument signature; after P1 it takes the accepted exit — see Data models). The
   runner-level construction is preferred, because it is the path the incident happened on.

   **Drive A's own watchdog; do not signal the broker.** Give A `orphanTimeoutMs: 300`
   (`RunBrokerOptions.orphanTimeoutMs`, `run-broker.ts:72`, already injectable) so its watchdog
   (`run-broker.ts:231`) calls `interrupt()`, which SIGTERMs **A's child** (`:164`). Give that
   child `claude`'s disposition so the 143 is real rather than asserted:
   `node -e "process.on('SIGTERM', () => process.exit(143)); setInterval(() => {}, 1000)"`.
   A's `child.on('exit')` handler (`:240-258`) then writes `{code: 143}` into the run's spool while
   B stays alive. Give B a child that sleeps and then exits 0.

   **`process.kill(brokerA.pid, 'SIGTERM')` would not work and must not be used.** The broker
   installs no signal handler of its own (verified across all 269 lines of `run-broker.ts` on
   `origin/main`), so SIGTERM kills the broker outright and the exit handler that writes `exit.json`
   never runs; the child is `detached: true` (`:110`) in its own process group, so the signal does
   not reach it either. Nothing would be written and the test could not be red.

   Assert: while A is dying and after it has died, B's session `result` is still pending and its
   `open` is true; then let B's child exit 0 and assert the session settles with code 0.
   **On today's code this rejects with "claude CLI exited with code 143".**
4b. **A foreign exit does not make a live spool dead** (`run-spool.test.ts`). A spool whose
   `meta.pid` is `process.pid` (alive) and `meta.instanceId` is `i1`, plus an `exit.json` carrying
   `instanceId: 'i2'`: assert `isSpoolLive` is **true**. Controls: the same spool with an
   `exit.json` carrying `i1` is false, and a protocol-1 meta with an anonymous exit and a dead
   `meta.pid` is false. Red today, because `run-spool.ts:243` returns false for any exit at all.
   This test is what keeps phase 4 from SIGKILLing healthy brokers.
5. **A stale exit does not survive `ensureSpoolDir`** (`run-spool.test.ts`). Pre-seed `exit.json`,
   call `ensureSpoolDir`, assert the file is gone and `readSpoolExit` returns null. Red today.
6. **Per-launch directories** (`run-spool.test.ts`). `spoolDirFor('/d/runs','abc','i1')` is
   `/d/runs/abc.spool/i1`; two launches for one run produce two directories, two `meta.json`s and
   two independent `exit.json`s; `legacySpoolDirFor` still returns the flat path. Update the
   existing assertion at `run-spool.test.ts:53-60`, which pins the old layout.
7. **The control socket is not shared** (`run-spool.test.ts`). Two instance dirs under one run
   produce two distinct `controlSocketPath` values, including at a path deep enough to trigger the
   `/tmp` hashed fallback for both (build the scratch dir with a >107-byte prefix).
8. **`sweepSpools` refuses to remove a live instance** (`workflows/recover-brokered.test.ts` or a
   new `sweep-spools.test.ts`). Instance dir with `meta.pid = process.pid` under a run id absent
   from `liveRunIds`: assert the directory still exists after a sweep. Second case: a meta-less
   directory younger than `SPOOL_ORPHAN_GRACE_MS` survives, older is removed. Third: the parent
   `<runId>.spool` is removed only when every child was.
9. **`reapAbandonedBroker` sends SIGKILL, and stops the exact unit** (new
   `reap-abandoned-broker.test.ts`). With a fake `kill` and a fake `systemctl` runner, assert the
   signal is `SIGKILL` and not `SIGTERM`, the order is kill-then-stop, and the unit argument is
   `brokerScopeUnitName(runId, meta.instanceId)` with no `*` in it. Assert a protocol-1 meta stops
   no unit at all. This is the test that pins correction 3, and it should carry a comment saying
   why: a polite SIGTERM here fires the bug.
10. **A refused re-attach reaps and logs** (`workflows/recover-brokered.test.ts`). A run whose spool
    is live but whose `meta.stepId` is not the chain's resume point: assert `reattachBrokeredRun`
    returns false, the broker pid was killed, and a `lifecycle` event matching
    `/adopted-out agent stopped/` is on the run.
11. **A dead broker with no exit fails the session** (`brokered-session.test.ts`). Meta with a
    pid that is not alive and no `exit.json`: the session's `result` **rejects** with
    `/died without recording an exit/` and the step is **failed**, not done — asserting that it
    "settles" would assert exactly the wrong thing, because `settle` is the success path (see the
    first Risks bullet). Assert the rejection, not merely that it stopped hanging to the idle
    timeout. Guard case: no `meta.json` at all does **not** finish it.
12. **`runtime.runBrokers`** (`runtime-info` test). Two live instance dirs under one run id put that
    run id in `runsWithMultipleBrokers`; dead metas count zero; more than `HEALTH_SPOOL_SCAN_MAX`
    directories omits the field.

Gates, from the repo root: `npm run typecheck` (which fans out to contract, client, server and web)
then `npm test`. **There is no lint gate in this repo** and no eslint config anywhere in it, so an
earlier draft's "`--max-warnings 0` applies" was wrong; those are the two gates. Run `npm test`
through the scrubbed invocation `AGENTS.md` specifies (`env -u NODE_ENV $scrub TMPDIR=$tmp …`),
never `npx vitest`.

### Runtime, on `prod-host`

This is the only place the deploy race is real, so it is the only place the acceptance criterion can
be met. Steps 1 and 2 are the criterion; 3 and 4 are the proof the mechanism is gone rather than
merely unobserved.

1. **The invariant, from the endpoint.**
   `curl -s localhost:<port>/api/v1/health | jq '.runtime.runBrokers'` while at least two runs are
   in flight. Expect `runsWithMultipleBrokers: []`. Sample it every 10 s for the length of a
   multi-step run so a step boundary is covered; a single sample proves nothing.
2. **The invariant, from the box, independently.** For every live `claude`
   (`pgrep -f '^claude --input-format'`), read `/proc/<pid>/cgroup` and extract the
   `cezar-run-<runId>-<instanceId>.scope` name; group by run id; assert every group has size 1.
   Cross-check against `systemctl --user list-units 'cezar-run-*'`. The two counts must agree with
   each other and with step 1; a disagreement is a finding, not noise.
3. **Deploy into a live run and watch the seam.** Start a multi-step run, wait for an agent step,
   run the self-deploy, then confirm within the next 60 s: the run either re-attaches (a
   `cezar restarted — this run kept going` lifecycle event) or is reaped (an
   `adopted-out agent stopped` event naming a broker pid), **never neither**, and the count in step
   2 is still 1 per run afterwards.
4. **The failure signature is absent.** For 24 hours after the deploy,
   `grep -c 'exited with code 143' <run store>` against runs whose agent pid was alive at the
   recorded failure time: expect 0. A 143 attributed to a pid that is dead is a genuine agent
   termination and does not count.
5. **The spool tree is nested and swept.** `ls <dataDir>/runs/*.spool/` shows instance directories,
   `<runId>.broker.log` is still one file per run beside the spool rather than inside it, and after
   a run finishes its whole `<runId>.spool` tree is gone while no live `claude` remains.

Until steps 1 to 5 have actually been executed on the box, this ships as **QA Needed**, not Done.

## Record

- KB `notion-04ca960e6408`, *A shared spool and an exit record with no owner*: the incident, the
  clock, the two-live-agents observation, and lesson 4, which correction 3 comes from. Update it
  when this lands: its "Not fixed yet" paragraph and the domain entry at
  `notion-export/domains/cezar.md:17` both need the status change and the correction to their
  five-phase description (P5 there is the deploy work, which this task does not do).
- KB `notion-d660e1080ec2`, *A per-run name for a per-step resource*: the precedent, and the source
  of the "name a resource after its unit of lifetime, keep the run id as the prefix" rule this spec
  applies a second time.
- `.ai/specs/2026-08-22-broker-scope-unit-name-collision.md` (commit `8e20dfbf`): the same defect
  class one layer up; `instanceId` is its artifact, reused here rather than reinvented.
- `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`: P4 of that spec is the broker and
  spool this one modifies. Nothing here contradicts it: the spool stays the server-independent
  durability boundary, only its ownership scope narrows.
- `3f4e9c33` (the broker machinery), `954c6a55` (persisted spool paths, offsets, re-attach),
  `0883256b` (`PROCESS_STARTED_AT` computed once), `3a54d156` (this spec's first draft).
- Brief: `.ai/specs/briefs/2026-08-22-run-spool-exit-crosstalk.md`.
- **Not found, and not invented:** no GitHub issue exists for this in the repo (the `143` in the
  task title is the exit code, not an issue number), and `cezar todo list` reported no open todo,
  although KB `notion-04ca960e6408` names a high-priority todo `1b21b153`. File one for the
  out-of-scope deploy drain/adopt work rather than assuming `1b21b153` covers it.
