# The one-shot `cezar run` CLI must not exit while its brokered run is still in flight

**Status: IMPLEMENTED, TESTED and SHIPPED 2026-08-22.** Commit `3e6d1b7e` ("fix: keep a
one-shot brokered run's interval ref'd so the process outlives the session"), pushed to
`origin/main` (fast-forward from `6fdbe35e`) on `prod-host`. P1+P2 both landed in
`packages/cezar/src/core/brokered-session.ts` (unref removed from the poll timer; `giveUp()`
terminal path + `spawnFailed` option wired into `pumpPending`'s attempts-exhausted branch) and
`claude-cli-runner.ts` (threads `mode.spawnFailed` into the `BrokeredSession` constructor). P3
(the doc note on `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`) landed in the same
commit. All three acceptance criteria met and measured, not just gated green — see Verification
§2/§3 below for what was actually run: `npm run test:package` **15/15** (was 1/15 red, the
originally-failing test 5 now passes), 4 new unit tests in `brokered-session.test.ts` (9/9 total)
covering timer ref state and the give-up rejection path, and a direct manual repro of AC2 against
the built `dist/index.js` (`CEZ_DRY_RUN=1 … run mock:done` → `run done`, `runs.json` row
`status: "done"`). AC3's give-up path is covered by the unit tests (P2 tests assert the rejection
message and precedence) but was not additionally forced end-to-end through the CLI in this
session — left as an optional follow-up repro, not a gap in the mechanism itself. Full gate suite
green: `typecheck`, `test:unit` (44/44), `build`; `npm test` (vitest) has one pre-existing,
unrelated failure (`knowledge/catalog.test.ts` C18, a documented host-speed timing trap, 517/518
files / 9573/9575 tests otherwise green) not touched by this change.

**CORRECTED 2026-08-24 by task `9bf5030d`:** the later duplicate report's original hypothesis
named `097d1b15` as the likely regression. Direct commit-content comparison instead identifies
`954c6a55` as the commit that first made the latent timer defect reachable through a real
headless `cezar run`: its parent has no broker construction in `ClaudeCliRunner.startSession`,
while `954c6a55` wires `spawnBroker` and `BrokeredSession` into that path. Commit `097d1b15`
changed the default workflow and explains why the observed first step was "Gather the record",
but it did not create the exit mechanism. **Confirmed 2026-08-24 by the literal `git bisect`** this paragraph
previously said was still owed (~~This attribution is supported by the direct diff, not yet by the
literal `git bisect` required by task `9bf5030d`; that task remains partial.~~): a scoped,
`GIT_*`/`CEZ_*`-scrubbed bisect over `bad=387ba439 good=3f4e9c33` (29 commits, both endpoints
measured by hand first) returns `first bad commit: 954c6a55`. The direct-diff attribution was
right. Transcript and per-probe table:
`.ai/specs/2026-08-22-headless-run-exit0-bisect-and-verify.md` → Verification → "Executed
2026-08-24". The shipping result above is unchanged: `3e6d1b7e` fixed the defect and its own
package, unit, and built-CLI verification remains the authoritative acceptance record — and
task `9bf5030d` has now independently confirmed the fix holds on current `origin/main`
(`c328ec06`): a headless dry run whose provider fails mid-workflow exits **1** with its record at
`"status": "failed"`, never 0-with-`running`.

**CORRECTED 2026-08-24 by `8219c6f0`:** the separate dry-run Codex escape described below is fixed.
Under `CEZ_DRY_RUN=1`, Codex now resolves to the bundled app-server mock, and the integrated
packed-release E2E passed 25/25 without a provider call. The original diagnosis remains below for
history.

**Separate defect found while confirming this, NOT covered by `3e6d1b7e`:** on current main the
release e2e case is red again for an unrelated reason — under `CEZ_DRY_RUN=1` the `spec-to-deploy`
workflow routes its `review-spec` step to **codex**, which the dry-run mock does not cover
(`task-classifier.ts:36`: "the `CEZ_DRY_RUN` mock only exists for claude and pi"), so the packaged
release e2e calls a real paid codex account. Do not read a red `test:package` case 8 on main as a
regression of this spec's fix without first checking which of the two failures it is: this one
names a provider and exits non-zero, the original exited **0** with stdout stopping at `── step:
Gather the record`.

## TLDR

`npm run test:package` is red 1/15 on `prod-host`: the packaged CLI's `cezar run mock:done
--repo <fixture>` (brokering on by default in a built tree) exits 0 after ~50ms, before the run
ever reaches a terminal status, while the run broker and the mock `claude` backend are both still
alive. Root cause, confirmed by reading `packages/cezar/src/core/brokered-session.ts:96-100`: the
poll timer that tails the run's spool is constructed `unref()`'d, and the broker child process is
(correctly) `unref()`'d too — so the moment the first control-socket connect to `ctl.sock` fails
fast (a normal startup race: the broker hasn't called `server.listen` yet), every handle left in
the one-shot CLI process is unref'd, Node's event loop finds nothing to wait for, and the process
exits via the ordinary empty-loop drain — never through the run's actual success/failure branch.
This is invisible on the server (`cezar serve`) path only because that process has its own,
unrelated ref'd HTTP listener keeping it alive regardless.

The fix is two independently-shippable changes to `brokered-session.ts`, both scoped to the
control-channel machinery already in place — no new timers, no change to the existing 5-second
retry budget:

- **P1 — keep the process alive while a brokered session is open.** Stop `unref()`-ing the poll
  timer. It already gets `clearInterval`'d the moment the session reaches a terminal state
  (`finish()`, `detach()`), so this only changes what happens *while a run is genuinely in
  flight* — which, for the one-shot CLI, is exactly the thing that has to hold the process open.
- **P2 — make the existing give-up path actually give up.** `pumpPending`'s attempts-exhausted
  branch (`:198-200`) already detects "the broker never responded" (100 attempts, ~5s) but only
  drops the queue and flips `stdinOpen` — it never terminates the session, so `result` never
  settles. Combined with P1 this turns today's silent wrong-success into a silent hang, which is
  worse. Wire that branch to reject `result` with a real error, routed through the failure path
  `run.ts` already has for a rejected `session.result` (marks the step/run `failed`, appends a
  `lifecycle` event with the message, which `index.ts`'s one-shot `run` command already prints and
  turns into `process.exitCode = 1`).

Both changes are local to `brokered-session.ts` (plus one call-site edit in
`claude-cli-runner.ts` to thread the broker's own spawn-failure reason into P2's error message).
No change to `run-broker.ts`, `broker-client.ts`, `broker-launch.ts`, or the server/re-attach path.

## Problem

### The failure, reproduced from the brief's runtime trace

`packages/cezar/test/e2e/package-cli.test.ts:14-92` ("the release tarball installs and runs the
dry-run CLI workflow") installs the packaged tarball into a clean consumer dir and runs:

```
node dist/index.js run mock:done --repo <fixture-repo>
# env: CEZ_DRY_RUN=1, CEZ_HOME=<tmp>
# timeout: 60_000ms (execFile)
```

Expected: `run.stdout` matches `/run (done|review)/` and `.ai/cezar/runs.json` in the fixture
repo has one row with `status` in `{done, review}` (`:86-92`). Observed on `prod-host`: the
process stalls at step 1 ("Gather the record"), the test's own `execFile` timeout kills it at 60s,
and `runs.json` never gets a terminal row. `CEZ_RUN_BROKER=0` against the identical invocation
passes. This is decisive: the brokered path — which is the DEFAULT for any built tree, per
`brokerAvailable()` (`broker-launch.ts:58-61`) — is the one that fails.

At the moment of the stall (per the record left by this task's own gather-the-record step, task
`d92e6b85`, step 1): the run-broker process and the mock `claude` backend are both still running,
`ctl.sock` is bound, `out.ndjson` holds exactly one line
(`{"type":"system","subtype":"init"}` — the mock's synchronous startup line), `err.log` is empty,
**and the CLI parent process has already exited 0.** The mock backend
(`packages/cezar/scripts/mock-claude.mjs:534-566`) is parked on `readline` waiting for a stdin
line that never arrives — proof the failure is entirely upstream, on the parent/broker-transport
side, not in the mock.

### Root mechanism — read from code, in the order it actually executes

1. `ClaudeCliRunner.startSession` (`claude-cli-runner.ts:134-144`) sees `opts.broker` set and
   calls `spawnBroker`.
2. `spawnBroker` (`:375-440`) forks the broker as a **detached**, `stdio: 'ignore'` child and
   `proc.unref()`s it (`:434`) — correct and intentional: "the broker must not hold a pipe whose
   read end dies with us" (`:423-424`). It then calls `attachBroker` with `mode.seed: true`.
3. `attachBroker` (`:449-547`) constructs a `BrokeredSession` (`brokered-session.ts:88-100`) and,
   because `mode.seed` is true, immediately calls `session.sendMessage([...spec.images,
   {type:'text', text: spec.userPrompt}])` (`:546`) — this is "Gather the record"'s opening
   instruction, the exact place the run is reported stuck.
4. `BrokeredSession`'s constructor (`:88-100`) runs one `tick()` synchronously (pending queue is
   still empty at that point — nothing has called `sendMessage` yet), then arms the poll loop:
   `this.timer = setInterval(() => this.tick(), opts.pollMs ?? SPOOL_POLL_MS); this.timer.unref?.();`
   (`:99-100`, `SPOOL_POLL_MS = 50`). **This `unref()` carries no comment.** Unlike every sibling
   `unref()` in this codebase — `claude-cli-runner.ts:213/215/232/272/274/488`,
   `run-broker.ts:175/237` — each of which states in a comment why an unref'd handle is safe there
   (an EOF grace timer riding on a still-open child pipe; a wall-clock kill switch that must not
   itself be a keep-alive; a broker-internal watchdog whose process is kept alive by its own
   `server.listen()` regardless) — this one has no stated reason. Nothing in the surrounding
   `BrokeredSessionOptions` doc comment (`:5-21`) or the `SPOOL_POLL_MS` doc comment (`:24-27`)
   addresses it either.
5. Back in `attachBroker`, `sendMessage` → `dispatch` (`:175-178`) pushes the seed request onto
   `pending` and fires `pumpPending()` **without awaiting it** (`void this.pumpPending()`). The
   synchronous prefix of `pumpPending` (`:188-210`) runs up to its first `await`: it calls
   `brokerRequest(spoolDir, next)` (`broker-client.ts:29-84`), whose executor synchronously arms a
   **ref'd** 5-second timer (`CONTROL_TIMEOUT_MS`, `broker-client.ts:20`, no `.unref()` there) and
   calls `net.connect(path)`. At this instant there IS a ref'd handle in the process.
6. But the broker has only just been `spawn()`'d (step 2) and has not yet reached
   `server.listen(paths.ctl)` (`run-broker.ts:227-228`) — a genuine, ordinary startup race, not a
   bug in the broker. So the connect fails fast, via `ECONNREFUSED`/`ENOENT` on the socket's
   `error`/`close` event (not the 5s timeout), `broker-client.ts`'s `finish()` clears the 5s timer
   and rejects. `pumpPending`'s `catch` (`brokered-session.ts:196-202`) increments `attempts` and
   `return`s — it does not retry within this call; the next retry is the poll timer's job.
7. **At this point every handle left in the process is unref'd or gone:** the broker's detached
   `proc` (step 2, deliberately), and the poll timer (step 4, apparently unintentionally). Node
   finds nothing left to wait for and drains the event loop — `process.exitCode` was never set, so
   it exits 0 — regardless of the still-pending `session.result` promise (`brokered-session.ts:92`)
   and the still-unsettled `await session.result` inside `RunManager` (`run.ts:3478`), and
   regardless of the one-shot CLI's own still-pending `new Promise<string>((resolveStatus) => ...)`
   in `runCommand` (`index.ts:970-973`). None of those are ref'd handles; unsettled promises alone
   never keep Node's process alive.
8. This is safe **today** only on the server path, because `cezar serve`'s own HTTP listener
   (`server/server.ts:7149`) is a genuinely ref'd handle independent of anything brokering-related.
   The one-shot CLI has no equivalent — it is, by design, a process that should run until the run
   it started finishes and then exit.

### The second, separate defect P2 exists to close

`pumpPending`'s attempts-exhausted branch already exists and already fires on the SAME code path
that causes the observed stall — a real, unrecoverable "the broker never showed up" condition
distinguished from ordinary retryable failures by `PENDING_MAX_ATTEMPTS = 100` attempts at
`SPOOL_POLL_MS = 50` ⇒ a ~5s budget, documented as "generous for … has not bound its socket yet
… short enough that a broker that never came up does not leave the cockpit believing a message is
still on its way" (`:29-34`). But when that budget is exhausted (`:198-200`):

```ts
if (this.attempts >= PENDING_MAX_ATTEMPTS) {
  this.pending.length = 0;
  this.stdinOpen = false;
}
return;
```

this drops the queue and marks the session non-writable, but **never calls `finish()` or rejects
`result`.** `this.closed` stays `false`, so `tick()` keeps polling `readSpoolExit()` forever, which
keeps returning `null` forever (there is no broker to ever write `exit.json`). Today (with the
poll timer unref'd) this is masked by the P1 bug: the process exits 0 anyway, for the wrong
reason, before this branch's effect is ever observable. **Shipping P1 alone would convert today's
silent-wrong-success into a silent-forever-hang** the first time a broker genuinely never starts
(a broken build, a corrupted `dist/index.js`, `resolveBrokerCommand()` finding no entry point at
the wrong moment) — which is exactly the scenario the third acceptance criterion names: *"if it
must give up it fails loudly with a non-zero exit."* P1 and P2 have to ship together.

One more piece of dead code this reconnects: `attachBroker`'s `buildResult` (`:509-514`) already
checks `mode.spawnFailed?.()` — the broker's own OS-level spawn error (`proc.on('error', ...)` at
`:429-431`) — and throws it first, ahead of the exit-code check. But `buildResult` is only ever
invoked from inside `finish()`'s settle path (`:147-162`), and if the broker never spawned at all
there is no `exit.json`, so `finish()` never runs, so this check has never been reachable through
the give-up path. P2 reconnects it (see Solution, P2).

### What this is not

- **Not** the already-fixed `index.ts:228-247` unreachable-`run-broker`-subcommand bug. That one
  left the spool with **no** `out.ndjson`/`meta.json` at all, because the broker CLI errored
  before `startRunBroker` ever ran. Here `out.ndjson` already has the mock's startup line, proving
  `startRunBroker` ran and its stdout tee works — a spec/fix here must not re-describe that bug.
- **Not** an env-scrub or TTY artifact — the brief's task record confirms the stall reproduces
  under every `CEZ_*`-unset combination and under `script -qec` (a real TTY), ruling both out.
- **Not** a server-path regression — `cezar serve`'s brokered runs on this box are unaffected;
  `server/server.ts:7149`'s listener is untouched by this spec.
- **Out of scope:** `reattachSession` (`claude-cli-runner.ts:355-367`, used by the server's boot
  re-attach sweep, `mode.seed: false`) can construct a `BrokeredSession` whose `pending` queue is
  *never* populated if nobody calls `sendMessage`/`end`/`interrupt` on it — P2's give-up path,
  which lives inside `pumpPending`, does not cover a broker that dies silently mid-tail with no
  pending send. That is a real, distinct gap (a dead re-attached broker could poll forever), but
  it is not what the acceptance criteria describe (they name the one-shot CLI's first agent step,
  i.e. the seeded-send path), no evidence in the brief or this reading suggests it is live on the
  server today, and closing it would mean inventing a drain-side watchdog with its own tuning
  question that the acceptance criteria don't ask for. Named here as a follow-up, not silently
  dropped — see Risks.

## Solution

### P1 — the poll timer must hold the one-shot CLI open while its session is live

In `brokered-session.ts`, remove the `.unref()` call at `:100`. `setInterval` handles are ref'd by
default; nothing else changes about the timer's lifecycle — it is already `clearInterval`'d in
both places a session ends: `finish()` (`:147-162`, now also reached by P2) and `detach()`
(`:230-236`, the "stop tailing without touching the backend" graceful-shutdown path). So the
window this keeps the process alive for is exactly "a `BrokeredSession` exists and has not yet
reached a terminal state" — which is precisely the invariant a one-shot CLI needs (it must run
until its run finishes) and a no-op on the server (which is already kept alive by its own
listener; one more ref'd handle on a process that was never going to exit changes nothing
observable there).

Add a one-line comment at the call site recording *why* it's ref'd now, matching the standard this
file already sets for every unref'd timer elsewhere in the codebase — so the next reader has the
same "is this deliberate?" answer this bug's absence of one made expensive to reconstruct.

### P2 — the exhausted-retry branch must actually end the session

Two edits, both in `brokered-session.ts` plus one call-site edit in `claude-cli-runner.ts`:

1. **New option**, alongside `buildResult` in `BrokeredSessionOptions` (`:5-70`):

   ```ts
   /**
    * The broker child's own OS-level spawn error, if any (`proc.on('error', …)` in `spawnBroker`).
    * Consulted only when the control channel gives up after `PENDING_MAX_ATTEMPTS` — lets a
    * broker that failed to spawn at all surface its real cause instead of the generic
    * "did not respond" message that's all the connect-retry loop can see on its own.
    */
   spawnFailed?: () => Error | null;
   ```

   `attachBroker` already computes this exact closure today (`mode.spawnFailed`, threaded in from
   `spawnBroker`'s `proc.on('error', ...)` at `:429-431`) and already passes it into `buildResult`
   (`:511`) — this is one more field on the same `new BrokeredSession({...})` call
   (`claude-cli-runner.ts:491-517`) reusing the same closure, not new machinery.

2. **A `giveUp` terminal path**, next to `finish()`:

   ```ts
   private giveUp(err: Error): void {
     if (this.closed) return;
     this.closed = true;
     this.stdinOpen = false;
     if (this.timer) clearInterval(this.timer);
     this.failWith(err);
   }
   ```

   Deliberately does **not** call `opts.onExit` — there is no real backend exit to report (the
   backend may never even have started), and `attachBroker`'s `onExit` handler
   (`emitBrokeredTerminalEvents`, `:499-503`) has no vocabulary for "we gave up before anything
   happened" that wouldn't read as a misleading `done`/`note` event ahead of the `failed` status
   the rejected `result` produces. `onExit` today is only ever called with a real `SpoolExit`
   object read from `exit.json` (`tick()` guards `if (!exit) return;` before calling `finish(exit)`
   at `:141-145`) — `giveUp` does not change that invariant, it just never reaches `onExit` at all.

3. **Wire the exhausted-retry branch** (`:198-200`) to call it:

   ```ts
   if (this.attempts >= PENDING_MAX_ATTEMPTS) {
     this.pending.length = 0;
     const waitedMs = this.attempts * (this.opts.pollMs ?? SPOOL_POLL_MS);
     this.giveUp(
       this.opts.spawnFailed?.() ??
         new Error(`run broker for ${this.spoolDir} did not respond after ${waitedMs}ms — giving up`),
     );
   }
   ```

**Why this is sufficient without touching `run.ts` or `index.ts`.** `RunManager`'s step-execution
`await session.result` is already wrapped in a `try { … } catch (err) { … status: 'failed' … }`
(`run.ts:3478`, catch at `:3533-3541`) that sets both the step and the run to `failed`, records
`error: message` on the step, and appends a `lifecycle` event
(`` `continue failed — ${message}` ``, `:3541`) — which the one-shot CLI's own event listener
already prints (`index.ts`'s `store.on('event', …)`, `case 'lifecycle': console.log('  · ' +
message)`). `runCommand`'s terminal-status promise (`:970-978`) already includes `'failed'` in its
resolution set, and its exit-code line (`:986`,
`` process.exitCode = final === 'done' || final === 'review' ? 0 : 1; ``) already turns a `failed`
run into exit code 1. **A rejected `session.result` was always going to be handled correctly —
the bug was that P2's give-up branch never rejected it.** No new deadline, no new promise, no
change to the one-shot command's own control flow.

### Why not add a third, CLI-level ceiling instead

The brief's open question 3 asks whether `runCommand` should grow its own explicit give-up ceiling
independent of the run ever reaching a terminal status. It should not, once P1+P2 ship: P1
guarantees the process stays alive exactly as long as a `BrokeredSession` is genuinely open (no
more, no less — it's the same handle that already knows when the session ends), and P2 guarantees
that "genuinely open" cannot mean "silently stuck forever" for the one failure mode this bug
report identifies (the seeded first send never landing). A second, independent ceiling at the
`runCommand` layer would duplicate that exact boundary with its own separately-tuned timeout,
reintroducing the two-sources-of-truth problem `emitBrokeredTerminalEvents` already exists to
avoid for the event vocabulary. The pre-existing per-step inactivity `deadline`
(`claude-cli-runner.ts:463-474`, `DEFAULT_RUN_IDLE_TIMEOUT_MS = 30 * 60_000`,
`claude-cli-runner.ts:52`) remains as the correct backstop for a DIFFERENT failure shape — a
broker that started fine and then went silent mid-run — and is intentionally 30 minutes, not
5 seconds; conflating it with P2's ~5s connect-retry give-up would either make routine startup
jitter fail a run or make a truly silent broker take 30 minutes to report failure. They stay two
mechanisms because they answer two different questions ("did the control channel ever come up?"
vs. "has a live channel gone quiet?").

## Architecture

No component boundaries move. This is entirely inside the existing P4 seam
(`.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`, "P4 — Runs survive the restart: the
detached run broker"): `BrokeredSession` still implements `AgentSession`
(`agent-runner.ts:183-198`) byte-for-byte, still the only thing between the run engine and the
transport, still invisible to everything above `claude-cli-runner.ts`. The change is confined to
two private mechanics inside `BrokeredSession` — a handle's `ref`/`unref` state, and one dead
branch's control flow — plus threading one already-computed closure (`spawnFailed`) one call
further than it goes today.

```
one-shot `cezar run` process
│
├─ RunManager.execute()/continue…() — run.ts (unchanged)
│    await session.result   ───────────────┐
│                                           │ (was: unsettled forever, process exits 0 anyway)
├─ ClaudeCliRunner.startSession()          │ (now: settles — done via finish(), or
│    → spawnBroker() → attachBroker()      │  rejected via giveUp())
│         → new BrokeredSession({...})     │
│              ├─ this.timer (setInterval) │  ← P1: no longer unref()'d;
│              │    tick() → pumpPending() │     the ONE thing keeping this
│              │    → drain() → finish()   │     process alive while a run
│              │                           │     is genuinely in flight
│              └─ pumpPending() catch      │
│                   attempts >= 100  ──────┘  ← P2: now calls giveUp(err),
│                                                 which settles `result` too
└─ runBrokerCommand (detached child, unaffected) — run-broker.ts, unref'd proc (unchanged)
```

## Data models

None. No persisted schema changes — `meta.json`, `exit.json`, `runs.json` and the run/step record
shapes are untouched. The only new "data" is the `Error` message P2 constructs, which flows
through the existing `error: string` field already on a failed run/step record
(`run.ts:3536/3539`) and the existing `lifecycle` event shape.

## API / interface contracts

- `BrokeredSessionOptions` gains one new optional field: `spawnFailed?: () => Error | null`. Purely
  additive — every existing caller (the vitest unit tests in `brokered-session.test.ts`, which
  construct `BrokeredSession` without it) keeps working unchanged; `this.opts.spawnFailed?.()`
  degrades to `undefined` and falls through to the generic message.
- `BrokeredSession.result`'s contract does not change shape (`Promise<AgentRunResult>`) — it
  changes from "sometimes never settles" to "always eventually settles" for the specific failure
  this spec closes. No consumer needs new handling: `run.ts:3478`'s `await session.result` inside
  a `try/catch` already handles rejection correctly today (proven by the existing `mode.spawnFailed
  → buildResult` throw path, which already flows through the identical catch — P2 makes that path
  reachable, it doesn't add a new one).
- No public CLI flag, env var, or HTTP contract changes.

## Phases

### P1 — stop unref'ing the poll timer (independently shippable, fixes AC1 + AC2)
- Remove `this.timer.unref?.()` at `brokered-session.ts:100`; add the one-line "why ref'd" comment.
- This alone should turn `npm run test:package` green, since the bug report's stall is the seeded
  first send succeeding on a LATER retry once the broker binds (well within the 5s budget) — the
  process just needs to survive long enough to see that. Confirms AC1 and AC2.

### P2 — repair the exhausted-retry give-up path (independently shippable, fixes AC3)
- Add `spawnFailed` to `BrokeredSessionOptions`; thread it through in `claude-cli-runner.ts`'s
  `new BrokeredSession({...})` call (`:491-517`) from the existing `mode.spawnFailed` closure.
- Add `giveUp()`; wire the `attempts >= PENDING_MAX_ATTEMPTS` branch (`:198-200`) to call it.
- P1 must land first (or in the same change) — P2 alone does not fix the reported stall (the
  reported stall never reaches the exhausted-retry branch; the retry that would have succeeded is
  the one P1's premature exit cuts off), and P2 is what stops P1 from turning a genuinely-dead
  broker into a silent hang. Ship as one commit if that's simpler; listed as two phases because
  they are independently reviewable and each has its own test.

### P3 — close the spec gap this bug exposed (documentation, no code)
- `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`'s P4 section and its Verification
  section were written and tested for the server/cockpit restart-survival scenario only; its
  "Implementation notes (2026-08-21)" section already flags, in passing, that gating brokering on
  "is this a built tree" rather than an explicit flag means "production gets brokering by default
  with no flag to set" — but never draws the conclusion that this pulls the one-shot CLI path in
  too, and its own Verification section has no CLI-path assertion. Add a short note there (per this
  repo's CLAUDE.md: "update the spec when the implementation diverges") naming the one-shot CLI as
  a covered use case, pointing at this spec for the keep-alive invariant, and pointing at
  `package-cli.test.ts` as (part of) that scenario's regression coverage. Out of scope for this
  spec's own code changes — a documentation-only follow-up, not gated on P1/P2 landing first.

## Risks

- **P1 changes when the process legitimately stays alive.** A caller that constructs a
  `BrokeredSession` and then abandons it without ever calling `end()`/`interrupt()`/reaching a
  terminal spool state would now hold the process open indefinitely instead of leaking silently.
  Checked: the only production call site (`claude-cli-runner.ts:491`, one per `attachBroker` call)
  always reaches a terminal state — either `finish()` via a real `exit.json` from `run-broker.ts`'s
  `child.on('exit', …)` handler (which fires unconditionally once the backend exits, including
  on interrupt/kill), or (after P2) `giveUp()`. `detach()` (server graceful shutdown) also
  `clearInterval`s. No path leaves a `BrokeredSession` alive with nothing left to end it.
- **P2's generic give-up message could fire on a broker that is just very slow to bind** (cold
  start on a loaded box) rather than one that will never come up, since the 5s/100-attempt budget
  is unchanged by this spec. This is a pre-existing tuning choice — already documented at
  `brokered-session.ts:29-34` as a deliberate tradeoff — not something P1/P2 make worse; today that
  same 5s exhaustion already silently abandons the send (`stdinOpen = false`), it just never told
  anyone. If this proves too tight in practice, raising `PENDING_MAX_ATTEMPTS` or making it
  configurable is a follow-up, not part of this fix.
- **The `reattachSession`/unseeded-session gap** (Problem → "What this is not," last bullet):
  a `BrokeredSession` constructed with nothing ever queued to `pending` has no path into `giveUp`
  at all, so a broker that dies mid-tail with no pending send would — after P1 — poll forever with
  the process now correctly kept alive by the (now-ref'd) timer, i.e. a hang where today (unref'd)
  it would eventually happen to exit via some other unrelated drain. Not covered by the acceptance
  criteria (server/re-attach path is explicitly out of scope — "The SERVER path is unaffected" per
  the bug report), not evidenced as live today, and deliberately left as a named follow-up rather
  than solved speculatively in this spec. File a todo when this lands.
- **Vitest's own process already keeps `brokered-session.test.ts` alive** regardless of ref state
  (it's a long-running test runner process, not a one-shot CLI), so that suite could not have
  caught this bug and its passing today is not evidence against the defect. New unit coverage
  (Verification, below) has to assert `hasRef()` state directly rather than relying on process
  exit behavior to prove the point.

## Verification

### 1. Unit — prove the mechanism, not just the symptom

New tests in `packages/cezar/src/core/brokered-session.test.ts` (vitest, same harness the file
already uses — a real `startRunBroker`, not a fake spool, per that file's own stated reason: "a
fake would let them agree with each other while both being wrong").

- **P1, timer ref state:** construct a `BrokeredSession` against a live broker; assert
  `session['timer']?.hasRef() === true` immediately after construction (Node's public
  `Timeout.hasRef()`, available since Node 11; this package requires Node ≥20 per
  `packages/cezar/package.json:24`). Drive it to `end()`/completion; assert the timer is cleared
  (`hasRef()` throws/returns false, or simply assert `clearInterval` was called via a spy — pick
  whichever this file's existing style favors once written).
- **P1, red-without-the-fix:** the most direct proof available without spawning a real detached
  subprocess in a unit test — assert the specific line `this.timer.unref?.()` is gone; **the real
  red-without-the-fix proof is §4 below**, since the actual failure mode (a whole process's event
  loop draining) is a subprocess-boundary phenomenon a same-process vitest test cannot observe
  (see the Risks note on why `brokered-session.test.ts` couldn't have caught this to begin with).
- **P2, give-up settles `result`:** construct a `BrokeredSession` pointed at a spool directory
  with **no broker running** (nothing bound to `ctl.sock`); call `sendMessage(...)`; assert
  `await session.result` rejects within ~`PENDING_MAX_ATTEMPTS * pollMs` (use a short `pollMs`,
  e.g. 5ms, to keep the test fast — `PENDING_MAX_ATTEMPTS` is attempt-counted, not wall-clock, so
  scaling `pollMs` down scales the test's real time down with it) with a message matching
  `/did not respond/`.
- **P2, `spawnFailed` takes precedence:** same setup, but pass `spawnFailed: () => new
  Error('boom: broker exec failed')`; assert the rejection message is exactly that error, not the
  generic one.

### 2. Prove the fix is necessary — run the existing e2e red, then green

1. On a clean checkout at the commit before this fix (or `git stash` the fix), run:
   `cd packages/cezar && npm run build && npm run test:package` — confirm test 1 of 15 fails with
   the `execFile` 60s timeout, matching the bug report.
2. Apply P1+P2, rebuild, rerun `npm run test:package` — confirm **15/15 pass**, satisfying AC1
   verbatim ("`npm run test:package` passes 15/15 on `prod-host` without
   `CEZ_RUN_BROKER=0`").

### 3. AC2 — direct manual reproduction of the exact scenario named

From a built tree, without setting `CEZ_RUN_BROKER`:

```bash
cd packages/cezar && npm run build
mkdir -p /tmp/cez-fixture && cd /tmp/cez-fixture && git init -q && \
  git commit -q --allow-empty -m init
CEZ_DRY_RUN=1 CEZ_HOME=/tmp/cez-home node <path-to-dist>/index.js run mock:done --repo /tmp/cez-fixture
```

Assert: the process prints `run (done|review)` and exits, `.ai/cezar/runs.json` under the fixture
repo has one row with `status` in `{done, review}`. This is AC2 verbatim, run directly rather than
only through the packaged-tarball wrapper `test:package` uses.

### 4. AC3 — the give-up path, forced

Reproduce a broker that never comes up (e.g., temporarily rename/chmod the built entry point so
`resolveBrokerCommand()`'s sibling-file check fails after the parent has already committed to
brokering, or point `CEZ_CLAUDE_BIN`/the broker's own resolved command at something that exits
immediately) and run the same `cezar run mock:done --repo ...` invocation. Assert: the process
does **not** exit 0 within the connect-retry budget's window while nothing has happened, it prints
a `failed` outcome (via the CLI's own `lifecycle`/`error` console output) within a few seconds
(bounded by `PENDING_MAX_ATTEMPTS * SPOOL_POLL_MS ≈ 5s`, not the 30-minute inactivity deadline),
and `process.exitCode` is non-zero (`echo $?` after the shell command). This is AC3 verbatim: "the
parent no longer exits 0 while the broker and backend are still alive [P1]; if it must give up it
fails loudly with a non-zero exit [P2]."

### 5. Regression check — parity and re-attach are untouched

Run `packages/cezar/src/core/brokered-parity.test.ts` and the rest of `brokered-session.test.ts`
unmodified (aside from the new cases in §1) — both must stay green, since neither P1 nor P2 touch
`emitBrokeredTerminalEvents`, the consumer wiring, or `finish()`'s existing settle path.

### 6. Gates

`npm run typecheck`, `npm run lint`, `npm run test` (vitest, repo root and/or
`packages/cezar` per this repo's existing per-package scripts) must all be green before this is
considered done, per this repo's own Definition of Done — `test:package` passing is necessary but,
per CLAUDE.md, "gates green is necessary, not sufficient."

## Sources read

- Brief: `.ai/specs/briefs/2026-08-22-run-broker-cli-stall.md` (this task's own gather-the-record
  output).
- `packages/cezar/src/core/brokered-session.ts` (full file read: constructor `:88-100`, `drain`
  `:110-124`, `tick`/`finish` `:126-165`, `dispatch`/`pumpPending` `:167-210`, `sendMessage`/`end`/
  `interrupt`/`detach` `:212-236`).
- `packages/cezar/src/core/claude-cli-runner.ts` (`:1-280` for the pipe path's unref sites and the
  inactivity `deadline`/`bump` pattern; `:375-547` for `spawnBroker`/`attachBroker` in full).
- `packages/cezar/src/core/run-broker.ts` (`:80-269`, `startRunBroker` in full — `server.listen`,
  the watchdog, `child.on('exit', …)` writing `exit.json`).
- `packages/cezar/src/core/broker-client.ts` (full file — `brokerRequest`'s ref'd 5s timer,
  `brokerResponds`).
- `packages/cezar/src/core/broker-launch.ts` (full file — `brokerPreference`, `resolveBrokerCommand`,
  `brokerAvailable`).
- `packages/cezar/src/index.ts` (`:220-247` for the already-fixed unreachable-subcommand comment;
  `:888-987` for `runCommand`'s terminal-status promise and exit-code convention).
- `packages/cezar/src/workflows/run.ts` (`:3460-3545`, the `continue…()` step's `session.result`
  await/catch and the `failed` status + `lifecycle` event it produces).
- `packages/cezar/test/e2e/package-cli.test.ts` (`:1-92`, the failing scenario in full, current
  line numbers — differ slightly from the brief's `:354-432`/`:86`, which cited an older revision
  of this file; content and assertions confirmed unchanged in substance).
- `packages/cezar/src/core/brokered-session.test.ts` and `brokered-parity.test.ts` (existing
  coverage shape and stated rationale, to match style for new tests and confirm neither could have
  caught this bug — see Risks).
- `packages/cezar/scripts/mock-claude.mjs` (`:534-566`, confirms it has no broker-awareness and is
  not implicated).
- `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md` (`:421-484` P4 in full, `:684-745`
  Verification section, `:780-830` "Implementation notes (2026-08-21)" — confirms the one-shot CLI
  was never named as a covered scenario).
- `packages/cezar/package.json` (`:24`, `"node": ">=20"`, for `Timeout.hasRef()` availability).
- `.ai/specs/2026-08-20-agent-step-inactivity-timeout.md`,
  `.ai/specs/2026-08-20-chain-integrity-restart-and-continuation.md`,
  `.ai/specs/2026-08-21-npm-test-gate-environment-scrub.md` — read for this repo's spec section
  conventions (TLDR / Problem / Solution / Architecture / Phases / Data models / API contracts /
  Risks / Verification / Sources read), not for content relevant to this bug.
- **Not found / not chased:** no indexed KB document treats `attachBroker`/`ctl.sock`/this failure
  as first-class knowledge outside code, the todo, and this task's own handoff (confirmed by the
  brief). `.ai/cezar/todos.json` (canonical todo `c895a348-4bee-4a81-89ab-a62788a6a118`) is
  gitignored and not present in this worktree checkout — its acceptance-criteria text is taken
  from the brief's verbatim quote and from this task's own handoff file, not re-read directly.
