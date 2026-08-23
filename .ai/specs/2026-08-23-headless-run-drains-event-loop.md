# Headless Run Event Liveness

**Status: IMPLEMENTED, VERIFICATION PENDING 2026-08-23.** The pre-implementation resource
probe confirmed the diagnosis: brokered execution spent 97.4% of 19,991 sampled ms on exactly
one ref'd handle (54 windows, narrowest 10 ms), while `CEZ_RUN_BROKER=0` spent 0.6% of 16,238
sampled ms there (6 windows, narrowest 12 ms). Both completed all eight steps and neither trace
contained an empty transition. P1 through P4 are implemented; gates, post-fix probes, runtime
repetition, package E2E, and P0 bisect remain pending.

Written 2026-08-23 for task `eeceb869` against HEAD
`84fb8237`. The diagnosis below is **measured on this box**, not inferred: see Problem
§"The measurement" for the instrumented run, and Problem §"What this is not" for the five
candidate mechanisms this session ruled out with citations so the implementation step does
not re-tread them.

Supersedes nothing. It **narrows** `.ai/specs/2026-08-22-run-broker-cli-keepalive.md`, whose
own status line claims the class was closed — it closed one instance of it. See
"Prior decisions this touches".

## TLDR

`npm run test:package`'s tarball case ("the release tarball installs and runs the dry-run CLI
workflow", `packages/cezar/test/e2e/package-cli.test.ts:14` — call it by name; the handoff's
"case 5" is a stale ordinal, see Verification §5) is red: the packaged CLI's
`node dist/index.js run mock:done --repo <fixture>` prints `run started` / `worktree ready` /
`── step: Gather the record` and then **exits 0**, leaving `.ai/cezar/runs.json` at
`status: "running"` with no `error`. Exit 0 is what makes it lethal — no caller can tell it
from a success.

Root cause, measured: **the one-shot CLI has no handle of its own that represents "a run is in
flight."** `runCommand` (`src/index.ts:989`) starts the run fire-and-forget
(`manager.startRun`, `:1073`; the engine is entered through `void this.pump()`,
`src/workflows/run.ts:1417`) and then awaits a promise that is resolved by a
`store.on('run')` listener (`src/index.ts:1076-1080`). An EventEmitter listener refs nothing,
and a pending promise refs nothing. So the process stays alive **only** for as long as the
run's *current* piece of work happens to own a libuv handle — a child-process pipe, an fs
request, or the `BrokeredSession` poll timer. Instrumenting a healthy 8-step dry run at HEAD
with `process.getActiveResourcesInfo()` shows the process spent **97.1% of its 20.1 s on
exactly ONE ref'd handle**, with 56 single-handle windows, the narrowest 7 ms, and 110 ms in
which the only thing keeping `cez run` alive was an in-flight `FSReqPromise`. Any instant
where the hand-off from one handle to the next has a gap is an instant where Node's ordinary
empty-loop drain exits the process with `process.exitCode` never set — i.e. 0.

That is why this is load-sensitive (found by a *gate run* on a loaded box, and it does not
reproduce on a quiet one), and why fixing one such gap — commit `3e6d1b7e`, which ref'd the
broker poll timer — moved the failure rather than removing it.

The fix is to stop relying on the hand-off chain:

- **P0** — the bisect AC1 asks for, run **last** (after P1-P4) and on a *deterministic*
  predicate: which commit made the CLI's default workflow multi-step. The load-based
  confirmation is secondary and time-boxed, because a bisect whose test never goes red marks
  every candidate good and terminates on noise.
- **P1** — a `beforeExit` guard in `runCommand`: never exit 0 while the record is
  non-terminal. Small, independently shippable, and it makes every *future* member of this
  class loud instead of silent. The hook is measured to fire with an empty ref-set — the probe
  recorded `BEFORE-EXIT code=0 refd=[]`. Stated precisely: that sample was taken at normal
  end-of-process on a run that *completed*, not at a mid-run drain. The mechanism is identical
  (`beforeExit` fires whenever the loop empties, whatever emptied it), so the conclusion holds;
  the trace shows the hook firing, not the bug firing.
- **P2** — a **run-lifetime keep-alive** owned by `runCommand`, ref'd from `startRun` until
  the record reaches a terminal status. This removes the class rather than one instance.
- **P3** — a stall detector on the same tick, so P2 can never trade a silent exit-0 for a
  silent hang: if the manager reports the run is not in flight anywhere while the record is
  still non-terminal, fail the record loudly and exit non-zero.
- **P4** — deterministic fault injection (`CEZ_RUN_FAULT=stall-step`) plus the tests, so this
  class is covered by something that does not depend on a loaded box to go red.

## Problem

### The failure, as reported

From the handoff (task `eeceb869`), reproduced by hand against the built CLI:

```
# node dist/index.js run mock:done --repo <fixture>
# env: CEZ_DRY_RUN=1
run started
worktree ready
── step: Gather the record
# exit 0, immediately, no further output
# <fixture>/.ai/cezar/runs.json  →  [{ status: "running", error: undefined }]
```

Proven pre-existing at clean `a5f04b0f` and clean `387ba439` with no diff applied and a full
`CEZ_*` env scrub, so it is not caused by task `737eba99`'s change.

The e2e that catches it asserts `run.stdout` matches `/run (done|review)/`
(`test/e2e/package-cli.test.ts:86`) and that the single `runs.json` row is `done`/`review`.
Both fail, and `execFile` resolves rather than rejecting, because the exit code is 0.

The handoff and root `AGENTS.md` both call this test **"case 5"**. That ordinal was correct at
`3e6d1b7e` and is stale at HEAD — `test:package` now has 18 cases and this one is the 8th
(Verification §5 has the arithmetic). Refer to it as
`packages/cezar/test/e2e/package-cli.test.ts:14`, by name.

### The measurement

The brief (`.ai/specs/briefs/2026-08-23-headless-run-exits-mid-workflow.md`, open question 1)
left "get a real runtime repro" unresolved — one quiet local attempt passed. This session did
not get the failure to reproduce either, and that is itself the finding: **the healthy path
is the evidence.** Run at HEAD `84fb8237` against the already-built `packages/cezar/dist`,
with a preloaded probe that samples `process.getActiveResourcesInfo()` (the list of resources
*currently keeping the event loop alive*) every 5 ms from an `unref()`'d timer, so the
sampler itself never appears in the list and never prevents the drain it is looking for:

```
env -u CEZ_TASK_ID … CEZ_DRY_RUN=1 CEZ_HOME=<tmp> \
  node --import file://<tmp>/probe.mjs dist/index.js run 'mock:done' --repo <fixture>
```

Result: the run **completed** (`run done — 11640 tokens`, `runs.json` → `done`) in 20.6 s
across all 8 spec-to-deploy steps. The resource trace:

| measure | value |
| --- | --- |
| distinct ref-set transitions | 122 over 20 113 ms |
| time held open by **exactly one** ref'd handle | **19 535 ms — 97.1%** |
| single-handle windows | 56, narrowest **7 ms** |
| time where the only ref'd handle was an fs request | 110 ms |
| most common ref-set | `[Timeout]` (47 windows) |
| terminal sample | `BEFORE-EXIT code=0 refd=[]` |

The recurring step-boundary shape, verbatim from the trace, is a three-hop hand-off in which
no two handles are ever alive together:

```
+3123ms refd=[PipeWrap,PipeWrap,PipeWrap,ProcessWrap,Timeout]   step N's session + a git child
+3143ms refd=[Timeout]                                          child gone; only the poll timer
+3159ms refd=[FSReqPromise]                                     timer cleared; only an fs read
+3167ms refd=[Timeout]                                          step N+1's poll timer armed
```

That 8 ms `[FSReqPromise]` window is the whole safety margin at a step boundary, and it exists
only because `loadWorkspaceConfig()` is genuinely uncached (see below). A slower or
differently-ordered tick — which is what a loaded box produces — puts a zero-handle instant in
that chain, and the process is gone.

### Root mechanism, read from code in the order it executes

1. `runCommand` (`src/index.ts:989`) builds the store, semaphore (`:1040`) and `RunManager`
   (`:1042`), then calls `manager.startRun(...)` (`:1073`), which returns a `RunRecord`
   **synchronously** and enters the engine through `void this.pump()`
   (`src/workflows/run.ts:1417`) — fire-and-forget by design.
2. `runCommand` then awaits `new Promise<string>` resolved from a `store.on('run')` listener
   (`src/index.ts:1076-1080`), and sets `process.exitCode` from the result (`:1087`).
   **Neither the listener nor the pending promise refs the event loop.** `process.exitCode`
   is left at its default 0 unless that line runs.
3. Every handle the process actually has belongs to the run's current work: the broker's
   `BrokeredSession` poll interval (`src/core/brokered-session.ts:158-162`, deliberately ref'd
   by `3e6d1b7e`), a spawned `git`/backend child's pipes, or an fs request. The broker child
   itself is `detached: true` + `proc.unref()` (`src/core/claude-cli-runner.ts:492,498`) — on
   purpose, so the launcher never holds a pipe to a process meant to outlive it.
4. The poll timer is cleared the instant *one step's* session reaches a terminal state —
   `finish()` (`brokered-session.ts:227`) and `detach()` (`:351-356`) both `clearInterval`.
   Every other timer in the engine is `unref()`'d and therefore contributes nothing: the queue
   watchdog (`run.ts:1081`), the auto-resume timer (`:2512`), the approval-timeout timer
   (`:4971`), the per-run idle timer (`:6172`), and the store's debounced save timer
   (`src/runs/store.ts:1424`).

So the invariant the CLI currently runs on is: *"at every instant of a multi-minute,
eight-step run, some piece of the engine happens to own a ref'd handle."* Nothing enforces
it, nothing tests it, and the measurement above shows it holds by a margin of single-digit
milliseconds at each of the 56 hand-offs.

### What this is not — ruled out this session, with citations

Recording these so the implementation step does not re-derive them:

- **Not a swallowed exception.** Both floating `execute()` calls catch and *fail the record*:
  `run.ts:1666-1679` (`engine crashed: …`) and `run.ts:2190-2199` (`re-attach crashed: …`).
  A throw would leave `status: 'failed'` with an error, not `running` with none.
- **Not an unhandled rejection.** There is no `unhandledRejection`/`uncaughtException` handler
  anywhere in `src/` (grepped), so a floating rejection would print a stack and exit **1**,
  not exit 0 silently.
- **Not an explicit exit.** No `process.exit()` on the `run` path — the only non-test call
  sites are the `serve` shutdown (`src/index.ts:920,981`), `:1916`, and the broker's own
  `src/core/run-broker.ts:266`.
- **Not `loadWorkspaceConfig()` caching.** The brief flagged this as unverified (open question
  2). Settled: it is **never cached** — `src/workspace/config.ts:372` says so explicitly and
  `loadWorkspaceConfig` (`:388`) does a real `readFile` (`:391`) on every call. That is why `await this.runResourceLimits()`
  inside `brokerFor` (`run.ts:2033`) shows up in the trace as a ref'd `FSReqPromise`. The
  brief's hypothesis that *this specific await* is the gap is therefore **wrong** — it is one
  of the few things holding the gap shut. Correct that when citing the brief.
- **Not the heavy-step gate — for this test, but it is the same latent hazard.**
  `WorkspaceSemaphore.acquireHeavyStep()` (`src/workspace/semaphore.ts:269-281`) queues into
  `heavyWaiters` (`:197`) and is resolved only by an in-process `releaseHeavyStep()` (`:285`).
  That promise refs **nothing**. It cannot be the cause here: only `run-tests` declares
  `heavy: true` (`src/workflows/types.ts:910`), `maxHeavySteps` is `.optional()` with no
  default (`src/workspace/config.ts:120`, `?? Infinity` at `semaphore.ts:232`), and the e2e
  runs under a fresh temp `CEZ_HOME`. But on a box where the key **is** set — `config.ts:120`'s
  own docblock records `prod-host` as having it written to 2 — a one-shot `cez run` that
  queues at that gate has zero ref'd handles and drains exactly the same way. P2 covers it;
  the eventual fix must not be so narrow that it doesn't.
- **Not the dry-run postconditions.** `src/workflows/postconditions.ts:70-87,334` short-circuit
  every `verify:` to a green `dryRunVerdict` under `CEZ_DRY_RUN=1`, so no later gate can be
  the blocker.

**And one entry that is the opposite of a rule-out — the strongest recorded datum about this
bug, and it *supports* the drain theory.** Root `AGENTS.md:371-372` (trap 5) records the
decisive control from the original investigation: **"`CEZ_RUN_BROKER=0` makes the identical run
finish; the default brokered path stalls."** The flag is live and reaches
`brokerPreference()` (`src/core/broker-launch.ts:26,35`); `0` forces the in-process path.

That is exactly what the drain theory predicts, and it is not a coincidence: the in-process
path holds a child's stdio pipes (a ref'd `PipeWrap`/`ProcessWrap` set) for the *whole* duration
of a step, so it has no hand-off gaps to fall through. The brokered path detaches
(`claude-cli-runner.ts:492,498`) and survives only on the poll `Timeout` that `finish()`/
`detach()` clear at every step boundary (`brokered-session.ts:158-162,351-356`). Same run, same
workflow, different number of zero-handle instants.

It is also a **free, falsifiable prediction**, which is why Verification §2 runs it as an A/B
before P2 lands: under the resource probe, `CEZ_RUN_BROKER=0` must show **no single-handle
`[Timeout]` windows at step boundaries**, while the default path must show them. If the
in-process path shows the same 7-20 ms single-handle hand-offs, this diagnosis is wrong and P2
is being built on a coincidence — stop and re-diagnose before writing the keep-alive.

### Why `3e6d1b7e` did not close this

`.ai/specs/2026-08-22-run-broker-cli-keepalive.md` diagnosed the identical symptom in the
identical test and fixed it by making **one** handle ref'd: the `BrokeredSession` poll timer,
for exactly as long as one session is open. That was correct and it is on HEAD
(`git merge-base --is-ancestor 3e6d1b7e HEAD` → yes, per the brief). What it could not do is
change the *shape*: the process is still alive only while some step-scoped handle exists, and
`finish()`/`detach()` still clear that handle at every step boundary. Its verification passed
15/15 at the time — on a quiet box, where, as measured above, the healthy path survives its
hand-offs by 7-20 ms.

The commit that made this reachable eight times per run instead of once is **`5e388ccf`**
(2026-08-20 10:00:24, an autosave), which flipped the CLI's default from `quick-task` to
`DEFAULT_WORKFLOW_NAME` at `src/index.ts:1003`. Before it, `cez run mock:done` ran the 1-step
`QUICK_TASK_WORKFLOW` (`src/workflows/types.ts:283`) — no step boundary at all. The handoff's
own hypothesis named `097d1b15`; that commit never touches `index.ts` (brief, verified).
`5e388ccf` bundles 52 unrelated files, so it is a lead, not a verdict — P0 runs the real
bisect.

## Solution

Four changes, each independently shippable, in increasing order of how much of the class they
close. P1 alone already satisfies the weaker half of AC3 and is worth landing on its own.

### P1 — `beforeExit`: never exit 0 with a non-terminal record

Register, inside `runCommand` and only for the lifetime of the awaited run, a
`process.on('beforeExit')` handler. `beforeExit` fires precisely when the loop has emptied and
the process is about to exit normally — which is the drain, and nothing else (it does not fire
for `process.exit()` or an uncaught throw). The handler:

1. Guards against re-entry with a one-shot flag (a `beforeExit` handler that does only
   synchronous work leaves the loop empty again and would otherwise fire in a loop).
2. Reads the record. Terminal (`done` / `review` / `failed` / `cancelled`) → do nothing; the
   normal path is finishing.
3. Non-terminal → `store.updateRun(runId, { status: 'failed', error: 'cezar exited before the
   run finished — the process ran out of work while the run was still <status> (no step, no
   session and no queued job held the event loop open)', finishedAt })`, `store.flush()` (both
   synchronous — `runs/store.ts`), print the message to stderr, and set `process.exitCode = 1`.

This is a pure backstop: on a healthy run it never fires, because the loop is not empty.

### P2 — a run-lifetime keep-alive owned by the CLI

The correct owner of "a run is in flight" is the thing that is waiting for the run, not the
step that happens to be executing. `runCommand` arms one ref'd `setInterval` immediately
before `manager.startRun(...)` and clears it in a `finally` around the `final` await. Cadence
is a liveness tick, not a poll of anything expensive — `RUN_KEEPALIVE_MS = 1000` — and the
callback body is P3's check.

Scoped to `runCommand` deliberately, **not** to `RunManager`: the server path already has a
ref'd HTTP listener and does not want a second always-on interval per manager, and the CLI is
the only process whose lifetime is supposed to equal one run's. `RunManager` gains only the
read-only predicate P3 needs.

With P2 in place, the 56 hand-off windows measured above stop mattering: the keep-alive is
ref'd across all of them, so a gap in the chain is no longer an exit.

### P3 — the stall detector, so P2 cannot buy a hang

A keep-alive that is unconditionally ref'd converts "silent exit 0" into "silent hang forever"
whenever the run genuinely will not progress. AC3 forbids both, so the keep-alive tick must be
able to answer *"is this run actually in flight?"* — and the manager already holds every piece
of that answer in memory. Add a read-only predicate:

```ts
// src/workflows/run.ts (RunManager)
runLiveness(runId: string): { live: boolean; reason: string }
```

`live` is true if any of these holds, and `reason` names which:

| source | meaning | anchor |
| --- | --- | --- |
| `this.active.has(runId)` | the step chain is executing | `run.ts:927` |
| `this.starting.has(runId)` | admitted, about to execute | `run.ts:932` |
| `this.queue.includes(runId)` | waiting for a slot | `run.ts:931` |
| `this.waiting.has(runId)` | parked on approval / message | `run.ts:938` |
| `this.monitoring.has(runId)` | durable monitoring session | `run.ts:940` |
| `this.autoResumeTimers.has(runId)` | scheduled resume | `run.ts:982` |
| `this.pendingJobs.has(runId)` | job accepted, not yet dequeued | `run.ts:941` |

**These seven do NOT cover every state the engine models, and the uncovered one is on the
healthy path.** An earlier draft of this spec claimed the six-source union was total. That claim
was false, and correcting it is why the seventh row exists.

The chain hand-back at the end of **every** step drops a perfectly healthy run out of the
registry sets before it puts it back. `runContinuation` calls `this.dropActive(runId)`
(`run.ts:4107`), which deletes the run from `active`, `waiting` and `monitoring`
(`run.ts:2430-2445`), and only *then* awaits
`this.reenterChain(handBack, 'step goal achieved', { requireProgress: true })` (`run.ts:4161`).
`reenterChain` (`run.ts:2322`) opens with `await this.reviveWorkflow(run)` (`run.ts:2352`, a
real fs read) before it does anything observable, then sets `pendingJobs` (`run.ts:2393`),
writes the record to `status: 'queued'` (non-terminal, so P1's guard would fire on it), and
pushes to `queue` (`run.ts:2413-2421`). The default workflow crosses that window **7 times per
run**, and it is precisely the `[Timeout] → [FSReqPromise] → [Timeout]` boundary that Problem
§"The measurement" recorded.

Adding `pendingJobs` shrinks the uncovered span to exactly one gap: `dropActive`
(`run.ts:4107`) to `pendingJobs.set` (`run.ts:2393`), whose entire content is the
`reviveWorkflow` fs read plus synchronous bookkeeping. `pendingJobs` is also set by `startRun`
(`run.ts:1415`) immediately before its `queue.push`, so the same row covers the pre-queue
instant at run start, and it is the same set the engine's own `isQueued()` already treats as
authoritative for "is this run still pre-dequeue" (`run.ts:3062-3069`, whose comment explains
why the record's own `status` cannot answer that question).

So the wedge predicate is: in none of the seven **and** the record is non-terminal. That is a
strong signal, not a proof, with one known false-positive window bounded by a single fs read.
`RUN_WEDGE_TICKS = 3` (about 3 s, below) is sized against **that** window, not against the
length of a step: a step can occupy 40 minutes and never leave `active`.

**Relation to the existing `RunManager.isActive()`** (`run.ts:2944`, `active || starting ||
queue`): `runLiveness` does not supersede it, and must not replace it. `isActive` answers a
deliberately narrower, server-side question, "may an HTTP caller mutate, cancel or merge this
run right now?" (`server/server.ts:5064,5548,5589,5598,5654,5683`), where counting a parked,
monitoring or merely-accepted run as active would wrongly reject a legitimate call.
`runLiveness` answers "could this run still make progress?", which is wider on purpose. Two
predicates, two questions; both stay, and `runLiveness` carries a comment saying so, so the
next session does not "consolidate" them.

**The terminal branch must be total, not a bare `return`.** The obvious tick body opens
`record = store.getRun(runId); if (terminal) return` — and with P2 armed, that branch is the one
case where the keep-alive is never cleared *and* `beforeExit` can never fire, so a terminal
record whose `store.on('run')` resolution was missed becomes an **unbounded hang**: precisely
the outcome this spec says it will not trade for. Today that same case exits (wrongly, but it
exits), so a careless P3 would make it strictly worse.

The window is real in shape even if not currently reachable: the listener is registered *after*
`startRun` returns (`src/index.ts:1073`, then `:1076-1080`) and `emit('run')` is fully
synchronous (`src/runs/store.ts:872-874`, `:1394-1397`), so any status write inside `pump()`'s
synchronous prefix (`src/workflows/run.ts:1562-1572`, before the first `await` at `:1576`) would
be emitted into a void. I did not find a path that does this at HEAD — but P2 is exactly what
converts a missed resolution from "exits" into "never exits", so the branch must be closed
regardless of whether it is reachable today.

So on a terminal record the tick **settles, it does not return**: resolve the awaited `final`
with `record.status` (one-shot and idempotent, sharing a single settle function with the
`store.on('run')` listener so whichever fires first wins), clear the keep-alive, and return. The
CLI's existing exit-code path (`src/index.ts:1087`) then runs unchanged and maps the status to
0 or 1 as it always has. Verification §3 case 7 tests this branch directly.

The keep-alive tick requires the wedge condition to hold for `RUN_WEDGE_TICKS = 3` consecutive
ticks (≈3 s) before acting, to tolerate any single-tick window where a run is momentarily
between sets. On the third, it takes P1's failure path (same message, with `reason` appended)
and clears the keep-alive so the process exits 1.

**This does not add a wall-clock stall heuristic.** A long agent turn, a 40-minute test step
and a parked session are all `live` by the table above, so nothing here can kill slow-but-
healthy work — which is the failure mode a naive "no events for N minutes" watchdog would have.

### P4 — make the class reproducible without a loaded box

Follow the precedent already in this codebase: `CEZ_BROKER_FAULT`
(`src/core/claude-cli-runner.ts:418`, `src/core/run-broker.ts:80-86`) is an inert-unless-set
fault injector that exists purely so a spec's verification can force a race. Add the same
shape for this one:

- `CEZ_RUN_FAULT=stall-step[:<stepId>]` — in `execute()`, immediately after the `step-start`
  event is emitted (`run.ts:4525`) for the named step (default: the first agent step), `await`
  a promise that is never resolved and holds no handle: `await new Promise(() => {})`.

That is not a simulation of the bug; it *is* the bug, in its purest form — the run's async
chain pending with zero ref'd handles behind it. On unfixed code it reproduces the report
exactly (exit 0, `runs.json` at `running`, no error). On fixed code, P2 holds the loop, P3
sees `active.has(runId)` stay true with no progress… and here is the one honest limitation to
state up front:

**With `stall-step`, `runLiveness` returns `live: true`** (the chain is still inside
`execute()`, so the run is in `active`). P3 therefore does **not** fire, and the fixed CLI
**hangs** rather than exiting 1. That is the correct and intended trade: an engine bug that
parks the chain forever is not something the CLI can distinguish from a legitimately long
step, and AC3's guarantee is about never reporting success falsely. So the P4 test asserts
**"does not exit 0 with a running record"** — it kills the process after a bounded wait and
asserts no exit-0 occurred — rather than asserting a specific non-zero code. The
exit-non-zero path is tested separately by P3's own unit test, which drives the predicate
directly. Say this in the test's comment; a reader who expects exit 1 here and finds a hang
will otherwise "fix" it back.

## Architecture

```
  cez run  (one process, one run, no HTTP listener)
  ─────────────────────────────────────────────────────────────────────
  runCommand()                                       src/index.ts:989
    ├─ keepAlive = setInterval(tick, 1000)   ← P2, ref'd  ─────────┐
    ├─ manager.startRun(...)          :1073  (returns sync)        │  held for the
    │     └─ void this.pump()   run.ts:1417  (fire and forget)     │  WHOLE run,
    ├─ await new Promise(store.on('run'))    :1076                 │  independent of
    │        ↑ refs NOTHING — this is the defect                   │  any step
    └─ finally { clearInterval(keepAlive) }                     ───┘

  tick():                                                  ← P3
    record = store.getRun(runId)
    if (terminal) { settleFinal(record.status)   ← one-shot, idempotent,
                    clearInterval(keepAlive)        SHARED with the
                    return }                        store.on('run') listener
        ^ never a bare `return`: with P2 armed, that is the ONE branch
          that can hang forever (keep-alive uncleared, beforeExit unreachable)
    if (manager.runLiveness(runId).live) { misses = 0; return }
    if (++misses < 3) return
    fail the record loudly · flush · exitCode = 1 · clear keepAlive

  process.on('beforeExit')                                 ← P1 backstop
    fires only if the loop empties anyway (P2 not yet armed,
    an early return, or a future path nobody thought about)
    → same failure write, exitCode = 1, never a silent 0

  ── today, without P2, the loop is held by whatever the STEP owns ──
  step N:  [PipeWrap×3, ProcessWrap, Timeout]  →  [Timeout]
  gap:     [FSReqPromise]                 ← 8 ms, measured
  step N+1:[Timeout]
           ^ any zero-handle instant in this chain = silent exit 0
```

## Data models

No persisted schema change. One new run-record *value* on an existing field:

| field | type | written by | value |
| --- | --- | --- | --- |
| `status` | existing enum | P1 / P3 | `'failed'` |
| `error` | existing `string \| undefined` | P1 / P3 | `cezar exited before the run finished — <reason>` |
| `finishedAt` | existing ISO string | P1 / P3 | write time |

Constants (new, in the module that uses them):

| name | value | where |
| --- | --- | --- |
| `RUN_KEEPALIVE_MS` | `1000` | `src/runs/run-exit-guard.ts` |
| `RUN_WEDGE_TICKS` | `3` | `src/runs/run-exit-guard.ts` |

Both live in the new module rather than in `src/index.ts` so they are reachable from a test:
see Verification §3 for why importing `src/index.ts` is not an option.

Environment (new, inert unless set):

| variable | values | effect |
| --- | --- | --- |
| `CEZ_RUN_FAULT` | `stall-step` / `stall-step:<stepId>` | Verification-only. Parks the step chain with no ref'd handle after `step-start`. |

## API / interface contracts

**New, `RunManager`** — read-only, no side effects, safe to call on any tick:

```ts
/** Is this run in flight anywhere in this process? `reason` names the source, or why not. */
runLiveness(runId: string): { live: boolean; reason: string };
```

`live: false` with a non-terminal record is a wedge by definition — the caller decides what to
do about it. This method must not mutate `active`/`queue`/`waiting`, must not `pump()`, and
must not read the filesystem.

**Behavioural contract, `cez run` (this is AC3, stated as a testable invariant):**

> `cez run` exits 0 **iff** the run record it started has reached `done` or `review`. It exits
> non-zero for `failed`/`cancelled`, and for any exit taken while the record is non-terminal,
> in which case the record is left `failed` with an `error` explaining the exit. It never exits
> 0 with a non-terminal record.

Unchanged: exit codes for the existing terminal statuses (`src/index.ts:1087`), stdout format,
`review` messaging, and every non-`run` subcommand.

## Phases

Each phase is independently shippable and independently verifiable.

**Order: P1 → P2 → P3 → P4, then P0 last.** P0 is numbered 0 because it answers AC1 and owns no
code, not because it runs first. It is scheduled last deliberately: its load-based form is the
one step here that can consume unbounded time without converging (a `git bisect run` whose test
never goes red marks every candidate `good` and terminates on noise, after paying a full
`npm run build` plus N loaded runs *per candidate*), and none of P1-P4 depends on its answer.
Running it first is how the phases that must land get eaten by a race that has not reproduced
on a quiet box in three attempts.

### P1 — `beforeExit` guard (closes AC3's weaker branch)

`src/index.ts` only. ~20 lines, no new dependency, no behaviour change on a healthy run.
Shippable alone: even with nothing else, the reported failure becomes a red exit with an
explanatory error on the record instead of a silent success.

### P2 — run-lifetime keep-alive (closes the class)

`src/index.ts` only: arm before `startRun` (`:1073`), clear in a `finally` around the `final`
await (`:1076-1086`). At this point the measured 7-20 ms hand-off windows stop being able to
end the process.

### P3 — `runLiveness` + wedge detection (stops P2 buying a hang)

`src/workflows/run.ts` (new predicate) + `src/runs/run-exit-guard.ts` (the tick body, extracted
there rather than left inline in `src/index.ts` so Verification §3 can test it). Depends on P2.

### P4 — fault injection, tests, and the e2e (AC2)

`src/workflows/run.ts` (`CEZ_RUN_FAULT`), new unit tests, and the `test:package` re-run. Also
re-time `package-cli.test.ts:14`: it is asserted with an inner `execFile` timeout of `60_000` ms and an outer
test timeout of `120_000` ms (`test/e2e/package-cli.test.ts:14,84`), while the 8-step
spec-to-deploy dry run measured **20.6 s on an idle box**. That is a ~3× margin against a
loaded gate box that also runs `npm pack` + `npm install` inside the same 120 s. Raise the
inner timeout to 120 s and the test timeout to 240 s **and record the measured number in a
comment**, so the next person reading a red knows whether they are looking at this defect or
at a box that was simply slow. Do not switch `package-cli.test.ts:14` to
`--workflow quick-task`: the CLI's default workflow is exactly what this test exists to smoke,
and pinning it would hide the next regression of this kind.

### P0 — bisect (AC1), no code — runs LAST

Two predicates, in this order. The first is the one that actually answers AC1.

**Endpoints, named.** `bad = e9d77657`, `good = 5e388ccf^` (= `67e93cca`, "feat: host CPU/mem %
+ per-task context usage in tasks table"). The earlier draft of this spec said "between the last
known-good base and `e9d77657`" and never named the good end — which is unrunnable, because the
handoff records that base as a **deleted worktree base** and `git bisect` cannot start without a
good commit. `5e388ccf` is confirmed an ancestor of `e9d77657`
(`git merge-base --is-ancestor 5e388ccf e9d77657` → true), so its parent is a valid good
endpoint under the `5e388ccf` prior. If the bisect walks past `5e388ccf` and lands elsewhere,
that is a real finding: report it, do not force the prior.

**Primary — deterministic, always names a commit.** AC1 asks which commit turned this red, and
the reachability change *is* the answer being sought: which commit made the default `cez run`
drive a multi-step workflow, and therefore made a step boundary exist at all. That is a pure
static predicate with no race in it:

```bash
git bisect start e9d77657 5e388ccf^
git bisect run sh -c '
  npm run build --workspace @loki-labs/better-cezar >/dev/null 2>&1 || exit 125
  node -e "…assert: cez run <task> with no --workflow selects a workflow with >1 step…"
'
git bisect log > /tmp/bisect-primary.log && git bisect reset
```

The assertion targets `src/index.ts:1003` (`const name = workflowName ?? DEFAULT_WORKFLOW_NAME`)
resolved against `loadWorkflows()`, so it is testable without running a run at all. `exit 125`
skips a commit that will not build. This terminates on a named commit **every time**, and it is
the honest answer to AC1: the commit that made the failure reachable.

**Secondary — load-based confirmation, TIME-BOXED to 30 minutes.** Only after the primary has
named a commit, and only as corroboration. Script `bisect-probe.sh`: at each candidate,
`npm run build`, then `node dist/index.js run mock:done --repo <fresh fixture>` **N=10 times
under artificial load** (the portable busy-loop form in Verification §5; `stress-ng` is not
installed on this box), failing the commit if *any* iteration exits 0 with a non-terminal
record. **Stop at 30 minutes of wall clock regardless of where it is.** The failure has not
reproduced in any of the three attempts so far, so the expected outcome is that this predicate
stays green everywhere; that is information, not a bisect.

**Record whichever happened, plainly**, in this spec's status line: the primary's named commit,
plus either the secondary's agreement or "the load predicate never went red in N runs across M
candidates in 30 minutes — the race did not reproduce on this box, so the commit named above is
named on the reachability predicate, not on an observed failure." A race that is green on a
quiet bisect runner is a finding about the test, not an absence of a cause. Do not pick a
plausible commit.

## Risks

| risk | severity | mitigation |
| --- | --- | --- |
| **P3 false-positives and kills a healthy run.** A run momentarily in none of the seven sets gets failed. | high — worse than the bug | The predicate unions seven sources covering every state the engine models **except one named window**: the chain hand-back's `dropActive` (`run.ts:4107`) to `pendingJobs.set` (`run.ts:2393`) span, crossed 7× per default run and bounded by a single `reviveWorkflow` fs read (see P3, which states this rather than claiming completeness). `RUN_WEDGE_TICKS = 3` (about 3 s) is sized against that window specifically. Verification §4 runs a full healthy 8-step dry run 5× with the detector armed and asserts zero misses: that run is the evidence the window really is sub-tick in practice, and if it is not, P3 does not ship as written. |
| **P2 turns a genuine engine wedge into an indefinite hang** where today it exits (wrongly) fast. | medium | Accepted and documented (P4). A hang is loud (CI timeout, visible terminal, Ctrl-C) where exit 0 is silent; the whole point of AC3 is that a false success is the worst outcome. P3 catches every wedge the manager can see. |
| **P1's `beforeExit` handler re-fires or does async work**, either looping or resurrecting the loop. | medium | One-shot flag; handler body is strictly synchronous (`store.updateRun` and `store.flush` both are — `runs/store.ts`). Unit-tested. |
| **A ref'd 1 s interval delays exit** after the run settles. | low | Cleared in a `finally` on the same tick the `final` promise resolves, before the summary line is printed. Verification §4 measures total wall clock before/after. |
| **The bisect (P0) is inconclusive** because the race is load-sensitive, and burns the session's time getting there. | medium — it is an acceptance criterion | P0's **primary** predicate is deterministic (does a no-`--workflow` run select a multi-step workflow?), so it names a commit every time regardless of whether the race reproduces. The load-based predicate is secondary, time-boxed to 30 minutes, and P0 runs **after** P1-P4 so an inconclusive race cannot consume the phases that must land. If the secondary never goes red, that is recorded as the finding rather than dressed up as confirmation. Flagged to the reviewer now, not at the end. |
| **`CEZ_RUN_FAULT` leaks into a real run.** | low | Same shape as the existing `CEZ_BROKER_FAULT` (`claude-cli-runner.ts:418`): inert unless the exact string is set, and never set outside a test. |
| **The heavy-step gate wedge** (`semaphore.ts:269-281`) is a second, independent instance of this class that P2 covers only because P2 is generic. | low | Called out explicitly in Problem §"What this is not"; a narrower fix (e.g. ref'ing one more timer) must be rejected in review for exactly this reason. |

## Verification

Every step below is executable as written, from `packages/cezar`, with two substitutions the
reader must make: `<fixture>` / `<fresh git fixture>` is a throwaway repo built exactly as
`test/e2e/package-cli.test.ts:65-73` builds one (`git init --initial-branch=main`, one committed
`README.md`, `user.name`/`user.email` supplied inline), and `dist/index.js` assumes
`npm run build` has been run. §7 is the exception and runs from the **repo root**, for the
reason given there.

### 1. Prove the mechanism, not the symptom — the resource probe

Re-run the instrumented run from Problem §"The measurement" **before and after P2**:

```bash
cat > /tmp/probe.mjs <<'EOF'
const t0 = Date.now(); let last = null;
const s = setInterval(() => {
  const now = process.getActiveResourcesInfo().slice().sort().join(',');
  if (now !== last) { process._rawDebug(`[probe +${Date.now()-t0}ms] refd=[${now}]`); last = now; }
}, 5);
s.unref();
process.on('beforeExit', c => process._rawDebug(`BEFORE-EXIT code=${c} refd=[${process.getActiveResourcesInfo()}]`));
EOF
CEZ_DRY_RUN=1 CEZ_HOME=$(mktemp -d) node --import file:///tmp/probe.mjs \
  dist/index.js run 'mock:done' --repo <fresh git fixture> 2>/tmp/probe.log
```

- **Before P2 (baseline, already measured at `84fb8237`):** 97.1% of wall clock on a single
  ref'd handle; 56 single-handle windows; narrowest 7 ms.
- **After P2, primary assertion (the one that actually discriminates):** every sampled
  *transition* ref-set contains the keep-alive `Timeout`, and the count of single-entry ref-sets
  drops from **56 to 0**. That is the direct proof the class is closed, and it does not depend
  on reproducing the race.
- **Secondary, and note the filter:**
  `grep 'probe +' /tmp/probe.log | grep -c 'refd=\[\]'` is 0. The `grep 'probe +'` prefilter is
  not cosmetic. A bare `grep -c 'refd=\[\]' /tmp/probe.log` can never be 0 on fixed *or* broken
  code, because the probe's own terminal line is `BEFORE-EXIT code=0 refd=[]` (quoted as the
  baseline's last sample in Problem §"The measurement") and it prints on every normal exit,
  including a healthy post-P2 one. Nor can the 5 ms `unref()`'d sampler ever observe a
  zero-handle instant on the broken path: the process is gone before its next tick fires. So
  this grep is a lint over the transition trace only, and on its own it proves nothing either
  way.

### 1a. Confirm the theory before building on it — the `CEZ_RUN_BROKER` A/B

**Run this before P2.** Root `AGENTS.md:371-372` records the decisive control from the original
investigation: `CEZ_RUN_BROKER=0` makes the identical run finish while the default brokered path
stalls. Probe the same 8-step dry run both ways, with the §1 probe attached:

```bash
for mode in 0 ''; do
  CEZ_DRY_RUN=1 CEZ_HOME=$(mktemp -d) ${mode:+CEZ_RUN_BROKER=$mode} \
    node --import file:///tmp/probe.mjs dist/index.js run 'mock:done' \
    --repo <fresh git fixture> 2>/tmp/probe-broker-${mode:-default}.log
done
```

**Compare within-step occupancy, not the step boundaries.** At a boundary the two modes execute
the *same* code, `dropActive` (`run.ts:4107`) to `reenterChain` (`:4161`) to `pump()` to
`execute()`, held open only by fs reads and `getRepoInfo`'s git child, regardless of broker
mode. So a boundary comparison cannot discriminate, and stating the criterion there would read
as a failure on correct code. What genuinely differs is what each mode holds **during** a step:
brokered holds one ref'd poll `Timeout` (`brokered-session.ts:158-162`) for the step's whole
duration, while in-process holds the runner child's `ProcessWrap` plus three `PipeWrap`s
(`claude-cli-runner.ts:492,498`).

The prediction, therefore, is a statistic over the whole run:

| metric | default (brokered), measured | `CEZ_RUN_BROKER=0`, predicted |
| --- | --- | --- |
| fraction of wall clock on exactly **one** ref'd handle | **97.1%** | well under 50% |
| count of single-handle windows | 56 | few, and only at boundaries |
| narrowest single-handle window | 7 ms | boundary-only, same order |

**Falsification condition:** the two traces are statistically indistinguishable on the first two
rows. It is *not* "the in-process trace shows any single-handle window at all", because it will
show boundary ones, and those are expected.

If the prediction fails, the root-cause narrative in Problem §"Root mechanism" is wrong:
re-diagnose, and record the corrected mechanism in this spec before building further on it. A
failed prediction does **not** block P1 or P2. A `beforeExit` guard and a run-lifetime keep-alive
satisfy AC3 whichever window is draining the loop. What it blocks is shipping them under a story
the measurement contradicts, which is how the *next* session inherits a wrong prior (see
§"Why `3e6d1b7e` did not close this"). Quote both handle traces and both statistics in the
status line.

### 2. Force the failure deterministically — `CEZ_RUN_FAULT` (P4)

```bash
CEZ_DRY_RUN=1 CEZ_RUN_FAULT=stall-step CEZ_HOME=$(mktemp -d) \
  node dist/index.js run 'mock:done' --repo <fixture>; echo "exit=$?"
cat <fixture>/.ai/cezar/runs.json
```

- **On unfixed code:** `exit=0`, record `status: "running"`, no error — i.e. the report,
  reproduced on demand, on a quiet box.
- **After P1:** `exit=1`, record `status: "failed"` with the `cezar exited before the run
  finished` error, message on stderr.
- **After P2:** the process no longer exits; the run parks. Bound it with `timeout 30` and
  assert only `exit != 0` (`timeout` yields 124) — see P4's stated limitation for why this
  case is a hang and not a 1.

### 3. Unit tests

`src/workflows/run.test.ts` (or a new `run-liveness.test.ts`):

1. `runLiveness` returns `live: true` with the right `reason` for each of the seven sources
   (queued, starting, active, waiting, monitoring, auto-resume, pending-job) — seven cases,
   driven by putting a run into each state directly.
2. `runLiveness` returns `live: false` for an unknown run id and for a run whose record is
   `running` but which is in none of the sets.
3. The predicate mutates nothing: snapshot `active`/`queue`/`waiting` sizes before and after.

**Do not import `src/index.ts` from a test, and do not add exports to it.** It has **zero**
`export` statements at HEAD (`grep -c '^export ' src/index.ts` → 0) and calls `main()` at module
scope (`src/index.ts:1914`, whose `.catch` runs `process.exit(1)`), so importing it runs the
whole CLI against the test runner's own `argv` and can hard-exit the worker. Instead, P1 to P3
extract the two testable bodies, `runExitGuard` (the `beforeExit` handler) and `runWedgeTick`
(the keep-alive tick), into a **new module**, `packages/cezar/src/runs/run-exit-guard.ts`, which
`index.ts` imports and wires into `runCommand`. Cases 4 to 7 then live in
`src/runs/run-exit-guard.test.ts`:

4. Terminal record → handler is a no-op, `process.exitCode` untouched.
5. Non-terminal record → record failed with the message, `exitCode = 1`, handler is one-shot
   (second invocation does nothing).
6. Wedge detector: two consecutive misses do nothing; the third fails the run.
7. **Terminal-branch totality** (the branch P2 makes dangerous): the record is already terminal
   and the `store.on('run')` listener never fired → the tick settles `final` with
   `record.status`, clears the keep-alive, and the process **finishes** with the correct exit
   code (`done` → 0; repeat with `failed` → 1). Assert it does **not** hang and does **not**
   rewrite the record. Without this branch the tick returns, the keep-alive is never cleared,
   `beforeExit` is unreachable, and the process runs forever — which is worse than today's
   wrong-but-fast exit. Say that in the test's comment.

**Which runner picks these up, because it is not the obvious one.** Both new files live under
`src/`, and `packages/cezar/vitest.config.ts` has `include: ['src/**/*.test.ts']` while
deliberately excluding `test/`. So `run-liveness.test.ts` and `run-exit-guard.test.ts` run under
**`npm test`** (vitest), *not* under `npm run test:unit`, which is
`node --import tsx --test test/unit/*.test.ts` (`packages/cezar/package.json:39`). §7's gate
line therefore does not cover these cases on its own: `npm test` must be run alongside it, as §7
already says. Do not place them in `test/unit/` to "make the gate cover them", because that
directory is node:test with a different assertion API.

### 4. Healthy-path regression — the detector must not fire

Full 8-step dry run with P2+P3 armed and a debug counter exposed:

```bash
CEZ_DRY_RUN=1 CEZ_HOME=$(mktemp -d) node dist/index.js run 'mock:done' --repo <fixture>
```

Assert: `run done`, `runs.json` → `done`, **zero** wedge misses recorded across all 8 steps,
and total wall clock within +1 s of the 20.6 s baseline. Repeat 5× — a detector that fires
once in five healthy runs is not shippable.

### 5. AC2 — the actual gate

```bash
npm run test:package     # from packages/cezar
```

**The gate is 18/18 at `84fb8237`, not 15/15.** `test:package` is
`node --import tsx --test test/e2e/*.test.ts` (`packages/cezar/package.json:40`), and HEAD has
**18** top-level cases: `alias-bin-exports` 1, `cold-broker-retry` 3, `inline-contract` 3,
`package-cli` 1, `release-snapshot` 5, `release` 5. AC2's "15/15" and root `AGENTS.md`'s
"case 5" were the count and the ordinal at `3e6d1b7e`; `3336ac15` (2026-08-22, "test: cover the
transient broker retry path with fault-injected e2e cases") then added
`cold-broker-retry.test.ts` with 3 cases, and because it sorts second alphabetically the tarball
case is now the **8th**, not the 5th. **Name it, do not number it:** the case that matters is
`packages/cezar/test/e2e/package-cli.test.ts:14`, by name. And **quote the runner's own count
line** (`# pass`/`# fail` from `node --test`) in the status line rather than a remembered number
— this spec exists partly because a stale green claim about this very test was believed once
already.

Run it **twice**: once idle, once under load, since a quiet green is exactly the evidence that
was already recorded once here and did not hold. `stress-ng` is **not installed on this box**
(`command -v stress-ng` → not found; `nproc` → 8), so use the portable form:

```bash
for i in $(seq "$(nproc)"); do (while :; do :; done) & done
trap 'kill $(jobs -p)' EXIT
npm run test:package
```

Use `stress-ng --cpu $(nproc) --timeout 300s` instead if it happens to be present on the box
you run this on. Quote both results, with their counts, in the status line.

### 6. AC1 — the bisect

Per P0, and **after** P1-P4 have landed. Run the deterministic primary predicate
(`git bisect start e9d77657 5e388ccf^`, asserting that a no-`--workflow` `cez run` selects a
workflow with more than one step) — it names a commit every time. Then the load-based secondary,
time-boxed to 30 minutes. Record the named commit **and** which predicate named it, plus the
secondary's outcome, in this spec's status line and in the task's handoff. If the secondary
never went red, say exactly that with its numbers rather than implying the commit was confirmed
by an observed failure.

**Second honesty note, on the primary predicate itself.** `git bisect` trusts its endpoints
rather than testing them, and the `good` endpoint here (`5e388ccf^` = `67e93cca`) is *chosen
from the prior*, not measured. So the primary bisect can only ever land on `5e388ccf` or later:
it confirms and dates the workflow-default flip, it does not independently discover it. That is
still worth running, because it rules out a *later* commit having moved the default again, but
report it as "confirmed and dated `5e388ccf`", never as "bisect independently found".

### 7. Gates

**Run these from the repo ROOT, not from `packages/cezar`.** The root `typecheck` fans out to
four workspaces (`typecheck:contract`, `:client`, `:server`, `:web` — root `package.json`), and
`packages/cezar`'s own `typecheck` is only the `:server` quarter of that. Running the gate from
the package therefore skips the contract, api-client and web checks entirely, which is exactly
the green-looking gate this spec is about. Root `.ai/agentic.config.json:8-15` names the five
validation commands, all root-relative.

```bash
npm run typecheck && npm run test:unit && npm run build     # from the repo root
```

**There is no `lint` script** — not in `packages/cezar/package.json` and not in the root
`package.json` (verified at HEAD). A chained `npm run lint` therefore aborts the whole command
with `Missing script: lint` before `test:unit` and `build` ever run, which is a green-looking
gate that ran nothing. Root `AGENTS.md:284` names this repo's five validation commands:
`typecheck`, `test`, `test:unit`, `build`, `test:package`.

Plus `npm test` (vitest), noting the pre-existing unrelated `knowledge/catalog.test.ts` C18
timing failure documented in `.ai/specs/2026-08-22-run-broker-cli-keepalive.md`'s status line —
if it is still the only red there, say so rather than claiming a clean sweep.

## Prior decisions this touches

- **`.ai/specs/2026-08-22-run-broker-cli-keepalive.md`** — its status line records
  `npm run test:package` **15/15** and "the originally-failing test 5 now passes". That was
  true, measured, for the mechanism it fixed. It does not hold as a durable guarantee for the
  one-shot CLI path, because it fixed one hand-off in a chain of 56. **When P2 lands, add a
  dated `CORRECTED 2026-08-2x` lead-in to that spec's status line** pointing here, leaving the
  original text below it — per the workspace rule that a correction marks what it invalidates
  in place. Do not delete or rewrite its claim.
- **Root `AGENTS.md` → `### Five environment traps that make the gates LIE` (`AGENTS.md:250`),
  item 5 (`:367-383`).** There is no section called "sharp edges" in that file; this is the real
  anchor. Item 5 already carries a 2026-08-22 correction (`:379-383`) saying that if this red
  recurs, "that is new information, not a re-confirmation of this entry." **This spec is that
  new information**, so item 5's own `**Do not re-diagnose this one**` directive (`:375`) is
  *satisfied* by this spec rather than violated by it: the red recurred, the correction opened
  the door, and the entry's canonical todo `c895a348` is already closed. When P2 lands, item 5
  should point here, and its "fails 1/15" heading needs the same treatment as the 15/15 claim
  above — the count is now 18 and the ordinal is 8 (Verification §5). Item 5 is also where the
  `CEZ_RUN_BROKER=0` control lives (`:371-372`), which Problem §"What this is not" now uses as
  positive evidence and Verification §1a turns into a test.
- **`5e388ccf`** (CLI default → `spec-to-deploy`) is not reverted and should not be: the
  default is a product decision (`.ai/specs/2026-08-19-spec-to-deploy-default-workflow.md`).
  It only made an existing latent defect eight times more likely to be hit.

## Sources read

Read directly at HEAD `84fb8237` for this spec (not taken from the brief):

- `packages/cezar/test/e2e/package-cli.test.ts:14,80-100` — the tarball case (the handoff's
  "case 5"; 8th of 18 at HEAD), its assertions and timeouts
- `packages/cezar/package.json:28,37,39-41` — the actual script names behind the gates (there is
  no `lint`); root `package.json` scripts block, same check
- `packages/cezar/test/e2e/` (all six files) — counted the top-level `test(` cases: 18
- Root `AGENTS.md:250` (`### Five environment traps that make the gates LIE`), `:284` (the five
  validation commands), `:367-383` (trap 5, the `CEZ_RUN_BROKER=0` control at `:371-372`, "do
  not re-diagnose" at `:375`, the 2026-08-22 correction at `:379-383`)
- `packages/cezar/src/core/broker-launch.ts:26,35` — `CEZ_RUN_BROKER` / `brokerPreference()`
- `git log`/`git merge-base` at HEAD — `3336ac15`, `5e388ccf`, `5e388ccf^` = `67e93cca`,
  `e9d77657`, and `5e388ccf` confirmed an ancestor of `e9d77657`
- `packages/cezar/src/index.ts:989-1087` — `runCommand`: workflow selection, `startRun`, the
  `store.on('run')` await, `process.exitCode`; `:920,981,1916` — the only `process.exit()` sites
- `packages/cezar/src/workflows/run.ts:1339-1350` (`startRun`), `:1417` (`void this.pump()`),
  `:1666-1679` + `:2190-2199` (floating `execute()` catches), `:1073-1081` (queue watchdog,
  unref'd), `:2013-2036` (`brokerFor`), `:2510-2512`, `:4525` (`step-start`), `:4955-4971`,
  `:5395-5445` (per-step broker decision), `:6155-6172`, `:927-982` (the state sets)
- `packages/cezar/src/core/brokered-session.ts:130-240` (constructor, `tick`, `finish`),
  `:351-356` (`detach`)
- `packages/cezar/src/core/claude-cli-runner.ts:401-521` (`spawnBroker`, `detached`/`unref` at
  `:492,498`, `CEZ_BROKER_FAULT` at `:418`)
- `packages/cezar/src/workspace/semaphore.ts:1-80,197,230-290,320-430` (`runHeavyStep`,
  `acquireHeavyStep`, `heavyWaiters`, `release`)
- `packages/cezar/src/workspace/config.ts:100-160` (`maxHeavySteps` docblock and schema),
  `:372-400` (`loadWorkspaceConfig` — "never cached")
- `packages/cezar/src/workflows/types.ts:283` (`QUICK_TASK_WORKFLOW`), `:910` (`heavy: true`),
  `:1152` (`DEFAULT_WORKFLOW_NAME`)
- `packages/cezar/src/runs/store.ts:1417-1428` (debounced save timer, unref'd)
- `/var/lib/cezar/loki-labs/cezar/.ai/specs/briefs/2026-08-23-headless-run-exits-mid-workflow.md`
  — step 1's brief (its open question 2 is settled above, and its `runResourceLimits` hypothesis
  corrected). **Absolute path on purpose:** the brief exists only in the main checkout, not in
  the `eeceb869` worktree where the implementation runs, so a repo-relative path resolves to
  nothing there.
- `.ai/specs/2026-08-22-run-broker-cli-keepalive.md` — the prior fix and its verification

Measured for this spec, on this box: the `getActiveResourcesInfo` trace summarised in Problem
§"The measurement" (raw log `/tmp/cez-drainprobe-IYIQ/probe.log`, 122 transitions over
20 113 ms; that path is scratch and will not survive a reboot — the numbers are quoted here
because of it).

**Not found / not done in this step:** no runtime reproduction of the *failure* itself (it did
not trigger on a quiet box, twice now — once in step 1's Explore run, once here); the bisect
(P0) was not run; `npm run test:package` was not run in this step. All three are the
implementation step's work and are written into Phases and Verification as such.
