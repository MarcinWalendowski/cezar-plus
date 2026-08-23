# A step whose broker never answered is retried once; one that was never started is not

**Status:** DONE 2026-08-22. P1-P3 implemented (commit `2258aee0`), P5 (verification) implemented
this pass — see "P5 shipped, corrected 2026-08-22" below. Deployed to `prod-host` at release
`20260823T000500Z-ef52ad86` (sha `ef52ad86`, blue-green, smoke-boot + probe green, 60ms cutover
gap). **Verification §6 production E2E run and passed on `prod-host`** immediately after
that deploy, against the live deployed binary via `cezar run mock:done ... --repo <scratch fixture>`
in an isolated `/tmp` fixture repo (not the real workspace), `CEZ_DRY_RUN=1` so nothing pushed:
1) `deaf-alive` — retry note ("relaunching the broker once") printed on the CLI thread, not only in
NDJSON; exactly one `run.step.retried_cold_broker` metric; retry instance (`mt51sm3t-2`) has a
distinct `instanceId` from the abandoned one (`mt51sm3t-1`); both `meta.pid` (572414) and
`meta.childPid` (572496) confirmed gone via `ps -p` after the run finished; the abandoned
`cezar-run-*.scope` unit no longer appears in `systemctl --user list-units`. 2) `deaf-once` —
reproduces the known, deliberately-unfixed gap below: fails via `failBrokerVanished` ("died without
recording an exit"), zero retry metrics, and both the broker pid (573942) and backend childPid
(573962) still confirmed reaped. 3) `never-start` — fails on the first attempt, zero retries spent,
error names the real cause and quotes the launcher (`fault injection: never-start`), matching
`<runId>.broker.log`. All three used gates already green in-repo (below) plus the box's real
`systemd --user` scope machinery, not a vitest sandbox. The `deaf-once`/`failBrokerVanished` gap and
the chain-restart mis-dispatch issue are unaddressed by design (see Risks / "Deliberately NOT done
here") and are filed as separate follow-up todos, not blockers for this spec's own Done.
**Date:** 2026-08-22
**Shipped:** commit `2258aee0` ("fix: retry a broker step once when it never answered, not when
it was never started"), merged to `origin/main` at `541bc76d`. Gates run in-repo before merge:
`npm run typecheck` EXIT=0; `npm test` — 531 passed, 3 failed, all 3 in files this diff never
touches (`src/knowledge/catalog.test.ts` CPU-budget test, `cli-wiring.test.ts` `--help` timeout,
`project-context.test.ts` init timeout — the documented load-sensitive flakiness, not a
regression). `npm run build` / `npm run test:package` were not re-run at merge time; run them
before closing out QA.
**Brief:** `.ai/specs/briefs/2026-08-22-bounded-broker-retry.md` (KB `specs-855ce6ed75c2`)

**P5 shipped, corrected 2026-08-22 (this pass).** The Status note below (and its "unrunnable as
written today" claim) described the state BEFORE this pass — P5(a) the three `CEZ_BROKER_FAULT`
modes, P5(b) the built-tree `test/e2e/cold-broker-retry.test.ts` suite, P5(c) the four missing
`broker-retry.test.ts` workflow cases, and P5(e) the two missing `brokered-session.test.ts` unit
cases have all now been written and are green — see each phase's own "Shipped 2026-08-22" note
below for the exact commands run and their output. **A real, previously-unknown gap surfaced while
writing the `deaf-once` e2e case**, not a test-authoring mistake: see P5(b)'s note and the new
"Known gap: `deaf-once` is not actually retried" entry under Risks. P5(d)'s changelog entry has
been written (`notion-export/changelog/2026-08-22-bounded-transient-broker-retry--local.md`); its KB
decision entry was already proposed by an earlier pass via `CEZ_KB_WRITE_FILE` and remains an
**unapplied proposal** — `cez kb search` will not find it until the cockpit applies it, per the
house rule that a corpus write only counts once search finds it. None of this pass's changes touch
P1-P3's production behaviour: every edit is a new test, a new fault-injection branch gated on an
unset-by-default env var, or a corpus write.

**Status note, corrected 2026-08-22 after review (superseded by "P5 shipped" above for
P5(a)/(b)/(c)/(e); P5(d)'s changelog half is also now done).** This Status previously read
"Implemented (code) / QA Needed (production E2E steps 1-5 pending the next deploy)". That was wrong
in a way the deploy and QA steps downstream would have acted on: the E2E was pending **code that had
not yet been written**, not a deploy. As of the ORIGINAL writing of this note, not implemented,
verified by direct read at `ad7a0a41`:

- the three `CEZ_BROKER_FAULT` fault-injection modes that Verification §4 and §6 are written
  against. `grep -rn CEZ_BROKER_FAULT packages/` returns **zero matches** repo-wide.
- the built-tree e2e `packages/cezar/test/e2e/cold-broker-retry.test.ts`. That directory holds
  only `alias-bin-exports`, `inline-contract`, `package-cli`, `release-snapshot`, `release`.
- four of Verification §2's six cases, including the only one that pins AC4's bound and the only
  one that guards the opening-payload restore (§2 has the per-case table).

So Verification §4 and every one of §6's steps 1-5 were **unrunnable as written at that time**: each
drove a hook that did not exist. The remaining work was scoped as **P5**, and has now shipped (see
above). P4's changelog entry is done; the KB decision remains an unapplied proposal (see above).

**CORRECTED 2026-08-22 after review:** `everAnswered` is initialized true for a re-attached
broker session, because re-attach means the opening instruction belonged to an earlier server
process and may already have produced work. A re-attached channel is therefore never eligible for
the cold-launch retry. The continuation-path retry also preserves its existing backend session id:
the follow-up control request was not delivered, but the conversation it was meant to resume still
exists. The earlier P3 text that passed `sessionId = undefined` is superseded by the corrected P3
section below.

**SUPERSEDED 2026-08-22 (same day): the rebase this paragraph demands has happened and the
implementation has shipped.** The branch `cez/9e110775` is now at `ad7a0a41`, which contains this
spec's own fix (`2258aee0`) merged to `origin/main` at `541bc76d`, so "absent from this checkout"
and "implementation must rebase first" are both spent instructions: do not act on them. What
survives is the **reading baseline**: every file path and line number below was read at
`origin/main` = `c1ccbe79` and is stated against it, so expect line numbers to have drifted since.
The shipped locations are named in "As shipped" below. Original text, unchanged:

> **Baseline: `origin/main` at `c1ccbe79`, NOT this worktree's `HEAD`.** The branch `cez/9e110775`
> sits at `2778fd52`, which shares only `c73c8a2d` with `origin/main` and is 71 commits behind it.
> Every fix this spec builds on, `8e20dfbf` (per-launch scope unit name, launcher log,
> `launchFailure`), `0883256b` (one process stamp per broker), `373b1b10` (never-persisted resumed
> session fails permanently), `c1ccbe79` (a failed codex turn is not a done step), is reachable from
> `origin/main` and is **absent from this checkout**. Every file and line number below was read with
> `git show origin/main:<path>` and is stated against `c1ccbe79`. **Implementation must rebase onto
> `origin/main` first**; designing against the checked-out tree would re-derive a bug that was fixed
> this morning.

**As shipped, verified by direct read at `ad7a0a41`** (the design below is unchanged; only names
and line numbers moved):

| Design element | Shipped as |
| --- | --- |
| `BrokerUnavailableError`, `everAnswered` | `core/brokered-session.ts:47-58`, field `:145`/`:152`, thrown `:296-302` |
| `isRetryableBrokerLaunch` | `core/brokered-session.ts:60-62` (`instanceof && !everAnswered`) |
| never-started stays a plain `Error` | `core/claude-cli-runner.ts:1104-1111` (`brokerNeverStarted`), wired at `:480` |
| the reap helper | `workflows/run.ts:344`, **renamed `reapAbandonedColdLaunch`**, see the note in P2 |
| chain-loop retry (P2) | `workflows/run.ts:4335` (the `Set`), branch at `:4473-4498` |
| continuation twin (P3) | `workflows/run.ts:3894-3910`, its `retriedColdBroker = false` parameter at `:3392` |
| `runAgentStep` catch (P1 consumer) | `workflows/run.ts:5366-5367` (sets `state.brokerNeverAnswered`) |
| tests | taxonomy cases shipped **inside `core/brokered-session.test.ts`** (`:335`, `:352`, `:368`), not as the new `core/broker-retry.test.ts` that Verification §1 proposes; plus `workflows/broker-retry.test.ts:105`, `:123`, `:138` (suite at `:65`) |

**Corrected 2026-08-22 after review: the `runAgentStep` and continuation rows were swapped**, and
both landed a reader in the wrong function. `run.ts:3894-3910` is inside **`runContinuation`** (its
note reads "the follow-up did not reach the agent", and `:3392` is that function's
`retriedColdBroker` parameter); `run.ts:5366-5367` is inside **`runAgentStep`**'s catch. Verified by
direct read at `ad7a0a41`.

## TLDR

`BrokeredSession.giveUp` has three distinct callers' worth of meaning and one undifferentiated
`Error` to say it with (`brokered-session.ts:238-242`). By the time that rejection reaches the
chain loop it has been flattened to a string twice, once by `runAgentStep`'s catch
(`run.ts:5221-5224`, `err.message` at `:5222`), once by the loop's single non-`stopped` failure
branch (`run.ts:4357-4360`), so the engine cannot tell "no broker was ever started, and never will be"
from "a broker was started, wrote its `meta.json`, and never bound its socket". Both fail the step,
both fail the run, neither is retried.

The fix is to classify at the point where the distinction is still known, and to spend exactly one
retry on the half that deserves it:

- **P1: say which give-up this was.** `giveUp` already branches on `spawnFailed()` /
  `launchFailure()` / neither. Only the **neither** branch changes: it rejects with a
  `BrokerUnavailableError` carrying `everAnswered: boolean` instead of a bare `Error`. The two
  permanent branches rethrow their original `Error` object untouched, so `instanceof` alone is the
  transient/permanent discriminator and object identity is preserved for callers that assert on it.
  Message text unchanged; no behaviour change; ships alone.
- **P2: retry the transient half once, in the chain loop.** A give-up where the broker *was*
  started and the control channel *never once* answered means the opening message was never
  delivered and the agent did zero work, so a fresh broker, fresh spool and fresh session id is
  safe by construction. Reap the abandoned broker, emit a `note` and a `metric`, `continue` on the
  same `i`. One retry per step, bounded by an in-memory `Set`, exactly the shape
  `resumedAfterStop` (`run.ts:4222`) and `resumedAfterMissingSession` (`run.ts:4227`) already use.
- **P3: the same branch on the continuation path**, mirroring how
  `2026-08-22-resume-fresh-session-fallback` covered both (`run.ts:3831` is its continuation twin).

A never-started launch keeps today's behaviour and fails the step immediately with the launcher's
own words, without touching the retry budget. That is AC4, and P1 is what makes it a guarantee
rather than a coincidence.

## Problem

### What is already fixed, and what this spec is actually about

The todo's original premise, a healthy broker needs longer than 5 s on a loaded box, was
measured and disproved: on `prod-host` at load 7.68, `meta.json` lands at p50 612 ms /
max 712 ms and the control socket accepts at p50 621 ms / max 716 ms, 0 of 10 rounds over 5 s
against a 5 000 ms budget (KB `notion-d660e1080ec2`; the table is reproduced in
`.ai/specs/2026-08-22-broker-scope-unit-name-collision.md` § Problem, and the measurement is
recorded in the code itself at `brokered-session.ts:38-42`). The real cause of that morning's five
dead runs was a scope unit named per **run** for a resource created per **step**; it is fixed and
production-verified (`8e20dfbf`, `0883256b`, release `20260822T102742Z-0883256b`, KB
`notion-8c1963ca2c16`).

**Do not lengthen `PENDING_MAX_ATTEMPTS`. Do not retry the message text.** The collision spec
closes with exactly this instruction, *"against this cause a retry re-enters a permanently
poisoned name and merely fails slower"*, and files the retry as defence in depth. This spec is
that follow-up, and its first obligation is to not undo the diagnosis it inherits.

### Where the classification is destroyed, in the order it executes

Read at `origin/main` (`c1ccbe79`):

1. **`giveUp` knows exactly which of three things happened**
   (`packages/cezar/src/core/brokered-session.ts:235-243`):
   ```ts
   if (this.attempts >= PENDING_MAX_ATTEMPTS) {
     this.pending.length = 0;
     const waitedMs = this.attempts * (this.opts.pollMs ?? SPOOL_POLL_MS);
     this.giveUp(
       this.opts.spawnFailed?.() ??
         this.opts.launchFailure?.() ??
         new Error(`run broker for ${this.spoolDir} did not respond after ${waitedMs}ms — giving up`),
     );
   }
   ```
   Branch 1 is an OS-level spawn failure (`wrapSpawnError`, e.g. ENOENT): permanent. Branch 2 is
   `brokerNeverStarted` (`claude-cli-runner.ts:1101-1109`), which returns non-null **only when no
   `meta.json` exists**: permanent, and it already quotes the launcher's stderr. Branch 3 is the
   generic timeout, and by elimination it fires only when `meta.json` **does** exist: the broker
   ran far enough to write it (`run-broker.ts:113`) and then never answered. That elimination is
   already pinned by a test, `broker-scope-collision.test.ts:213`, whose name reads (verbatim)
   *"stays silent — so the timeout message wins — when the broker DID come up and then went
   quiet"*.

2. **`giveUp` throws all three away.** `private giveUp(err: Error)`
   (`brokered-session.ts:261-267`) calls `this.failWith(err)`. The receiver gets an `Error` and
   nothing else.

3. **`runAgentStep` flattens it to a string.** `catch (err) { const message = err instanceof Error
   ? err.message : String(err); … return message }` (`run.ts:5221-5224`). The method's return type
   is `Promise<string | null>`, so this is where the object dies.

4. **The chain loop has one branch for it.** After the `stopped` branch (`run.ts:4287-4327`) and
   the missing-session branch (`run.ts:4330-4356`):
   ```ts
   if (failure) {
     this.finishStep(runId, step.id, 'failed', failure, emit);
     runError = `step "${step.id}" failed: ${failure}`;
     break;
   }
   ```
   (`run.ts:4357-4361`.) `finishStep` (`run.ts:6041`) persists the error and emits the terminal
   `step-end`; `runError` fails the run at `run.ts:4520-4522`. There is no retry at any level.

5. **The continuation path has the same shape**, and already carries the missing-session branch
   beside the identical generic `else` (`run.ts:3824-3856`).

### Why a bare string match on the message is not good enough

The obvious cheap fix, `/did not respond after \d+ms — giving up/`, has two defects the record
already warns about:

- **It matches text that merely contains the phrase.** The pipe path wraps a backend's stderr into
  its own failure message, and the brokered exit path does the same:
  `brokeredExitMessage` (`claude-cli-runner.ts:1016-1021`) produces `claude CLI exited with code N
  — <last 3 lines of err.log>` (verbatim). An agent that printed the give-up phrase (this spec's own test
  fixtures will) would be misclassified as a retryable transport failure. `isMissingSessionRejection`
  (`agent-runner.ts:129-133`) accepts that risk deliberately because it has no alternative, it is
  matching a *third-party CLI's* free text. Here the string is **ours**, thrown ten lines away from
  where the answer is known, so accepting the same risk would be a choice rather than a
  constraint.
- **It cannot express `everAnswered`.** See below: that flag is the whole safety argument, and no
  amount of message text carries it.

### What "transient" actually means here, and why a fresh session is safe

`pumpPending` (`brokered-session.ts:225-252`) resets `this.attempts = 0` after **any** successful
round-trip and only increments on consecutive failures against `this.pending[0]`. So a give-up
means 100 consecutive failures on one request. Two cases:

- **The control channel never answered at all.** The queue's first entry is the seed message
  (`claude-cli-runner.ts:582`, `if (mode.seed) session.sendMessage(...)`), so nothing was ever
  written to the backend's stdin. The `claude` child *is* running, `run-broker.ts:103` spawns it
  before `writeSpoolMeta` at `:113` and long before `server.listen(paths.ctl)` at `:228`, but it
  is sitting on an empty stdin having produced nothing. **Zero agent work exists.** A fresh broker,
  a fresh spool and a fresh session id discard nothing.
- **The channel answered earlier and then died.** Turns have already happened, output is in the
  spool, and starting over would silently discard billed work. This is the case
  `2026-08-22-spool-exit-cross-talk` (KB `notion-04ca960e6408`) owns, and this spec must **not**
  retry it.

`BrokeredSession` can distinguish these for free: it already resets `attempts` on success, so a
one-line `everAnswered` flag set at `brokered-session.ts:246` is exact.

### The abandoned broker is not free, and the retry must reap it

This is the part a naive `continue` gets wrong. On a retry, `runAgentStep` calls `brokerFor`
(`run.ts:1919-1934`), which resolves `spoolDirFor(join(this.dataDir, 'runs'), runId)`, **keyed on
the run id alone**, so it is the *same directory*, and `spawnBroker` then does:

```ts
rmSync(request.spoolDir, { recursive: true, force: true });   // claude-cli-runner.ts:401
```

That is good news and bad news. Good: it answers the brief's open question 5, a retry never
inherits a stale `exit.json`, because the whole directory is removed before the new broker writes
`meta.json`. (Note in passing: `2026-08-22-spool-exit-cross-talk` § "Why the step retry cannot save
it" states *"Nothing on the broker-start path unlinks `exit.json`"*. Read against `origin/main`
that is not accurate for the `spawnBroker` path, the `rmSync` has been there since `954c6a55`,
the original P4 commit. It remains accurate for the *re-attach* path, which does not call
`spawnBroker`. Flagged here rather than corrected, because that spec is `Proposed` and this one
does not own it.)

Bad: the deaf broker and its `claude` child are still alive, and the `rmSync` deletes the spool out
from under them. Left alone they are reaped only by `ORPHAN_TIMEOUT_MS` (`run-broker.ts:61`, 30
minutes), which is precisely the twin-agent leak measured at `$82` and `$119` on runs `232ad6d4`
and `bde0ec40` (KB `notion-04ca960e6408`). So the retry must stop the broker it is abandoning
**before** it spawns the replacement. Because the deaf case has, by definition, no working control
socket, this is a signal to `meta.pid`, not an `interrupt()`.

### Prior art in this engine, and what it settles

| precedent | bound | signal | spec |
|---|---|---|---|
| cezar-initiated stop → re-enter the **same** session once | `resumedAfterStop` Set (`run.ts:4222`) | `note` + `run.step.stopped` / `run.step.resumed_after_stop` metrics (`run.ts:4294-4319`) | `2026-08-20-agent-step-stopped-is-not-failed.md` (`62a41d30`) |
| resume rejected as never-created → **fresh** session once | `resumedAfterMissingSession` Set (`run.ts:4227`) | `note` + `run.step.resumed_after_missing_session` (`run.ts:4340-4352`) | `2026-08-22-resume-fresh-session-fallback.md` |
| continuation twin of the above | `retriedMissingSession` flag (`run.ts:3831`) | same pair (`run.ts:3833-3845`) | same |
| missing persisted session during recovery | **not retried at all**, terminal by design | | `373b1b10`, `recover-session-failure.test.ts` |

The second row is the template: same seam, same bound, same event pair, and (unlike the first row)
it starts a **fresh** session rather than resuming, which is what a cold broker requires. The
brief did not find it, because it was reading the stale checkout where it does not exist.

The fourth row is the guard this must not weaken: a missing persisted session is failed once and
never retried on every boot. This spec's predicate cannot fire there, that failure surfaces as a
backend rejection, never as `BrokerUnavailableError`.

## Solution

Three phases, each independently shippable.

### P1: a give-up says which give-up it was

New error type in `brokered-session.ts`, thrown by `giveUp` **on the generic-timeout branch only**:

```ts
export class BrokerUnavailableError extends Error {
  readonly name = 'BrokerUnavailableError';
  /** Did any control round-trip ever succeed on this session? */
  readonly everAnswered: boolean;
  readonly spoolDir: string;
}
```

There is deliberately **no `transient` flag**. Being an instance of this class *is* "transient":
the class is only ever constructed on the one branch that means "a broker was started and the
control channel never came up." The permanent branches are not wrapped at all.

`pumpPending`'s exhausted branch (`brokered-session.ts:238-241`) keeps its existing `??`
precedence, `spawnFailed()` then `launchFailure()` then the generic message, and changes only the
**last** term:

- `spawnFailed()` produced it → **thrown unchanged, the same `Error` object it returned.** Permanent
  (an ENOENT binary does not heal in five seconds).
- `launchFailure()` produced it → **thrown unchanged.** Permanent (no `meta.json`; nothing was
  started, and on the cause this replaced, the poison outlives the run).
- neither → by elimination `meta.json` exists, the broker ran and went deaf: construct
  `BrokerUnavailableError` with the same message text as today.

**Not wrapping the permanent branches is a correctness requirement, not a stylistic choice.**
`brokered-session.test.ts:272` asserts object *identity*, `await expect(session.result)
.rejects.toBe(spawnErr)`, not `.message`; wrapping would make the rejection a different object and
turn that test red. The same identity matters on a second path: `attachBroker`'s `buildResult`
rethrows `mode.spawnFailed?.()` raw (`claude-cli-runner.ts:544-546`), so a caller can meet the very
same `Error` object from either the give-up path or the exit path and must not see two different
shapes.

`everAnswered` is initialized from a new `previouslyAnswered` option and set to `true` at the
existing `this.attempts = 0` success line (`brokered-session.ts:246`). `attachBroker` passes
`previouslyAnswered: !mode.seed`, so a re-attached broker is conservatively treated as having
answered before this `BrokeredSession` instance existed. That is required because its opening
instruction belonged to the previous server process and may already have produced a full turn.

Message text is byte-identical to today, so `brokered-session.test.ts:247` and `:261` and
`broker-scope-collision.test.ts:199/213/228` keep passing unchanged. That is the point: P1 adds
information and removes none.

Exported type guard, so the workflow layer never re-derives the rule:

```ts
export function isRetryableBrokerLaunch(err: unknown): err is BrokerUnavailableError {
  return err instanceof BrokerUnavailableError && !err.everAnswered;
}
```

A permanent give-up is therefore not retryable for the strongest possible reason: it is not an
instance of the class at all, so no field can be misread and no future edit to a flag can make it
retryable by accident.

### P2: the chain loop retries it once, and reaps what it abandons

**Carry the classification on `state`, not in the string.** `runAgentStep` returns
`Promise<string | null>` and widening that return type would touch every caller and every branch
of a 6 200-line file. The engine already has the idiom for exactly this, `state.stepStopped`
(`ActiveRun`, `run.ts:304`), set inside the step at `run.ts:4885` and consumed by the loop at
`run.ts:4287-4288`, with a doc comment explaining that the loop cannot see events while its own
`await` is in flight. Add a sibling field:

```ts
/** The step's session died because its run broker was launched and never answered: no control
 *  round-trip ever succeeded, so the opening message was never delivered and the agent did no
 *  work. Set from `runAgentStep`'s `session.result` catch, where the Error object still exists;
 *  read and cleared by `execute()`'s step loop. Same vehicle and same reason as `stepStopped`. */
brokerNeverAnswered?: { spoolDir: string; message: string };
```

`runAgentStep`'s catch (`run.ts:5221-5224`) sets it when `isRetryableBrokerLaunch(err)` and
otherwise behaves exactly as today. It is cleared at the top of each attempt beside
`state.stepStopped = undefined` (`run.ts:4266`).

**The step's opening payload must survive the retry.** `startImages`, `startAttachments` and
`checkFailure` are cleared unconditionally at `run.ts:4283-4285`, immediately after `runAgentStep`
returns and **before** any retry branch runs. A bare `continue` on the same `i` would therefore
re-enter the step with the user's pasted screenshots and any failed-postcondition feedback silently
gone. This is a **new** hole, not one inherited from the two precedents: the missing-session branch
is gated on `stepResume !== undefined` (`run.ts:4336`) and so can never fire on the first attempt of
step 0, which is the only attempt that carries `startImages`/`startAttachments`. The cold-broker
branch has no such gate, and its whole safety argument is that the opening message was never
delivered, so whatever that message was supposed to carry is still owed to the agent. Capture the
three values into locals immediately **before** the clears:

```ts
const sentImages = startImages;
const sentAttachments = startAttachments;
const sentCheckFailure = checkFailure;
startImages = undefined;        // run.ts:4283 today
startAttachments = [];          // :4284
checkFailure = null;            // :4285
```

and restore them on the retry path only, immediately before its `continue` (below). No other branch
restores them: a step that genuinely ran has consumed its payload, and the stop/missing-session
retries both re-enter a session that already received it.

**The loop branch** goes between the missing-session branch (its `continue` is `run.ts:4355`, its
closing brace `:4356`) and the generic failure branch (`run.ts:4357`), so a stop and a never-created
session keep their current precedence:

```ts
const coldBroker = state.brokerNeverAnswered;
state.brokerNeverAnswered = undefined;
if (failure && coldBroker && !retriedColdBroker.has(step.id)) {
  retriedColdBroker.add(step.id);
  reapAbandonedColdLaunch(coldBroker.spoolDir);        // see below (shipped name; was reapAbandonedBroker)
  this.store.updateStep(runId, step.id, { sessionId: undefined, status: 'pending', error: undefined });
  emit({ type: 'note', stepId: step.id,
    // Shipped wording, verbatim at run.ts:4484; §2's assertion string is copyable from here.
    message: `${failure}; no control request reached the agent, relaunching the broker once` });
  emit({ type: 'metric', stepId: step.id, name: 'run.step.retried_cold_broker', runId,
    workflow: workflow.name, spoolDir: coldBroker.spoolDir, attempt: 2 });
  // Nothing ever reached the agent, so the opening payload is still owed to it (see above).
  startImages = sentImages;
  startAttachments = sentAttachments;
  checkFailure = sentCheckFailure;
  continue; // same `i`: a fresh broker, a fresh spool and a fresh session id
}
```

`sessionId: undefined` matters: the retry must mint a new id, not `--resume` one the backend never
heard of. Leaving it set would walk straight into the failure `373b1b10` and
`2026-08-22-resume-fresh-session-fallback` exist to prevent. `resumeFrom`/`stopResume` are already
spent by the time this line runs (`run.ts:4262-4265`), so the next pass takes the fresh-session
path with no further work.

**RENAMED ON THE WAY IN, 2026-08-22: this helper shipped as `reapAbandonedColdLaunch`, and the
name it is called by below is now taken by something else.** While this was being merged,
`origin/main` independently gained `reapAbandonedBroker(runId, meta): Promise<boolean>` in a new
`core/reap-abandoned-broker.ts` (it stops a broker the *replacement server* refused to adopt across
a blue-green cutover, a different signature and a different purpose). The merge kept both and
renamed this one to **`reapAbandonedColdLaunch(spoolDir): void`**, `workflows/run.ts:344`. Read
every `reapAbandonedBroker` below as `reapAbandonedColdLaunch`; grepping the old name lands you in
the wrong module.

**`reapAbandonedColdLaunch(spoolDir)`** (below as `reapAbandonedBroker`), a small private helper,
bounded and best-effort:

1. `readSpoolMeta(spoolDir)` (`run-spool.ts:146`); return if absent (nothing to reap).
2. **Signal BOTH pids, child first, never one or the other.** If `meta.childPid` is set
   (`run-spool.ts:44`) and `isPidAlive(meta.childPid)` (`run-spool.ts:173`), SIGTERM
   `meta.childPid`. **Then**, separately and unconditionally on the same reap, if
   `isPidAlive(meta.pid)`, SIGTERM `meta.pid`. Child first so the backend is stopped before its
   supervisor disappears.

   **The broker cannot clean up after itself, so "SIGTERM the broker and let it reap its child" is
   not available.** There is no `process.on('SIGTERM')` or `process.on('SIGINT')` anywhere in
   `run-broker.ts`, `run-broker-cli.ts` or `broker-isolation.ts` (verified by grep at `c1ccbe79`);
   `index.ts:850`/`:911` install handlers only on the `serve` path, which the `run-broker` dispatch
   at `index.ts:248-251` returns before reaching. What sits at `run-broker.ts:239+` is
   `child.on('exit', …)`, the handler for the **backend child's** exit, which by construction can
   only run while the broker is still alive. SIGTERM to `meta.pid` therefore kills the broker
   outright on the default disposition: the child-exit handler never fires, `exit.json` is never
   written, the orphan watchdog (`run-broker.ts:231-237`) dies with it, and the `claude` at
   `meta.childPid` is left with nothing to reap it — precisely the leak this step exists to close.

   The other shape needs the same two signals for a different reason. "`meta.json` exists, socket
   never bound" also covers the broker that died **between** `writeSpoolMeta` (`run-broker.ts:113`)
   and `server.listen` (`:228`), which is what the `deaf-once` hook in Verification §4 reproduces
   by exiting before it binds. There `meta.pid` is already dead and the `isPidAlive` guard makes
   that signal a no-op, so the `meta.childPid` kill is the only one that does anything. Two guarded
   signals cover both shapes; either one alone leaks in the other.
3. Under `scope` isolation also `systemctl --user stop 'cezar-run-<runId>-*'`-equivalent cleanup is
   **out of scope**: `--collect` reaps a failed unit, and the per-launch names from `8e20dfbf`
   mean a lingering scope can no longer block the next launch. A stray scope is now a tidiness
   problem, not a correctness one.
4. Every step wrapped in `try/catch`, a reap that fails must never turn a recoverable step into a
   failed one.

This is the bounded, one-launch version of `2026-08-22-spool-exit-cross-talk` P4. It does not
implement or depend on that spec's P1/P2/P3; the `rmSync` at `claude-cli-runner.ts:401` is what
makes the retry's spool clean, and it is already in the baseline.

### P3: the continuation-path twin

`runContinuation`'s catch (`run.ts:3824`) gets the mirrored branch beside the existing
`isMissingSessionRejection` one, with its own `retriedColdBroker` boolean, the same `note`, the
same `run.step.retried_cold_broker` metric, and the same reap. This is the shape
`2026-08-22-resume-fresh-session-fallback` used for its Phase 2/3 split, and
`recover-session-failure.test.ts` is the suite that already exercises this path.

Two mechanical details this path does not share with P2. First, the retry is not a `continue`: the
catch only sets a flag, and the actual re-invocation happens in the `finally` at `run.ts:3866-3892`,
deliberately after `dropActive(runId)` so a concurrent `pump()` cannot race the new `ActiveRun`. So
the cold-broker twin needs its own flag beside `missingSessionRetry` (`run.ts:3768`) **and** its own
trailing parameter beside `retriedMissingSession` (`run.ts:3327`, defaulted `false`), passed `true`
on re-entry the way `:3883` does. Second, unlike the missing-session fallback, the cold-broker
retry passes the original `sessionId`. The failed control request was the continuation's follow-up,
not its original opening turn: nothing from this attempt reached the agent, but the existing
conversation is still the context the follow-up must resume. `brokerFor` and `spawnBroker` still
mint a fresh broker instance and clean spool, so preserving the backend session id does not reuse
the failed control channel.

### Deliberately NOT done here

- **Any change to `PENDING_MAX_ATTEMPTS` or `SPOOL_POLL_MS`.** Measured; see Problem. The comment
  at `brokered-session.ts:38-42` records why, and this spec adds no evidence to overturn it.
- **A string predicate on the give-up message.** See Problem.
- **More than one retry.** No production measurement of how often the cold-broker class occurs, or
  of whether a second attempt would ever land, exists in the record. Both precedents chose one. A
  second is a data-driven follow-up, not a guess to bake in now.
- **Persisting the retry counter across a server restart.** In-memory, like both precedents. A
  restart re-enters through `recover()`/`chainResumeAt`, which is separately bounded; making this
  counter durable changes `StepState` and the restart contract for a class of failure nobody has
  yet measured recurring. Named as a residual gap in Risks rather than silently ignored.
- **Retrying a channel that answered and then died.** `everAnswered` excludes it on purpose; it
  belongs to `2026-08-22-spool-exit-cross-talk`.
- **An early-out that gives up before 5 s when `meta.json` is plainly absent.** AC4 asks that a
  never-started launch not burn the *retry budget*, which P1 guarantees. Shaving its 5 s wall-clock
  is a separate, smaller optimisation with its own race: `meta.json` at t=0 means nothing, which is
  the entire rationale for `launchFailure` being read late (`brokered-session.ts:93-99`).

## Architecture

```
run-broker (child process)
  spawn(claude)                        run-broker.ts:103   ← the agent exists…
  writeSpoolMeta(...)                  run-broker.ts:113   ← …and meta.json proves it
  … ~500 ms …
  server.listen(paths.ctl)             run-broker.ts:228   ← the control channel opens HERE

BrokeredSession.pumpPending            brokered-session.ts:225
  success  → attempts = 0; everAnswered = true                      (P1)
  100 consecutive failures →
      spawnFailed()    → the SAME Error object, unwrapped          (unchanged) ← permanent
      launchFailure()  → the SAME Error object, unwrapped          (unchanged) ← no meta.json
      generic timeout  → BrokerUnavailableError{everAnswered}      (P1)  ← meta.json exists
  → giveUp → result rejects

RunManager.runAgentStep catch          run.ts:5224
  isRetryableBrokerLaunch(err) → state.brokerNeverAnswered = {...}  (P2)
  return err.message                                                 (unchanged)

RunManager.execute step loop           run.ts:4287…4360
  stopped?                     → same-session re-entry, once         (existing)
  missing session?             → fresh session, once                 (existing)
  brokerNeverAnswered?         → reap + fresh broker + fresh id, once (P2)  ← NEW
  otherwise                    → finishStep 'failed', fail the run   (unchanged)

RunManager.runContinuation catch       run.ts:3824
  brokerNeverAnswered?         → same branch                          (P3)  ← NEW
```

The retry's clean-state guarantee, end to end, all already in the baseline:
`brokerFor` rewrites `{ spoolDir, consumedOffset: 0 }` on the record (`run.ts:1925`) and resets
`offsetWrites` (`run.ts:1926`); `spawnBroker` removes the spool directory entirely
(`claude-cli-runner.ts:401`); `takeReattach` (`run.ts:1894-1899`) has already been consumed by the
first attempt and returns `undefined`, so the retry takes the spawn path and not the re-attach
path; `nextBrokerInstanceId()` (`claude-cli-runner.ts:409`) mints a scope unit name that cannot
collide with the abandoned launch's.

## Data models

No persisted schema changes. Nothing is added to `RunRecord`, `StepState`, `spoolMetaSchema` or
`spoolExitSchema`, and `BROKER_PROTOCOL` is not bumped, a broker binary from either side of this
change is interoperable, because the change is entirely on the reader's side of the socket.

In-memory only:

```ts
// core/brokered-session.ts
// No `transient` field: the class is constructed on the transient branch and nowhere else, so
// `instanceof` IS the discriminator. Permanent give-ups reject with their original Error object.
export class BrokerUnavailableError extends Error {
  readonly everAnswered: boolean;
  readonly spoolDir: string;
}

// BrokeredSessionOptions. True for re-attach, false for a newly spawned broker.
previouslyAnswered?: boolean;

// workflows/run.ts, interface ActiveRun
brokerNeverAnswered?: { spoolDir: string; message: string };

// workflows/run.ts, inside execute()
const retriedColdBroker = new Set<string>();   // stepId
```

New event on the run's NDJSON (the run's own analytics surface, same as `run.step.stopped`):

```jsonc
{ "type": "metric", "name": "run.step.retried_cold_broker", "stepId": "run-tests",
  "runId": "…", "workflow": "spec-to-deploy", "spoolDir": "…", "attempt": 2 }
```

Plus one `note` per retry, which `thread-state.ts:576-585` renders as a dim meta line in the
transcript, the visibility half of AC3. `step-start` is deliberately not relied on: that reducer
does not render it (`thread-state.ts` has no `step-start` case), so an incremented `iterations`
alone would leave the retry invisible to the user, which is the failure mode AC3 names.

## API / interface contracts

- **`BrokeredSessionOptions` is unchanged.** `spawnFailed` and `launchFailure` keep their existing
  contracts and their existing narrowness, `spawnFailed` is also read on every terminal path by
  `attachBroker`'s `buildResult` (`claude-cli-runner.ts:548-549`), and widening it is the mistake
  `broker-scope-collision.test.ts:129` was written to prevent. P1 changes only what `giveUp`
  *throws*, which nothing but `result`'s rejection observes.
- **`BrokeredSession.result` still rejects with an `Error`.** `BrokerUnavailableError extends
  Error`, and `.message` is byte-identical to today, so every existing consumer, including
  `sink.sessionEnded('error', message)` (`run.ts:5223`) and the `session.error` v2 event, is
  unaffected.
- **`runAgentStep` keeps `Promise<string | null>`.** No signature change anywhere in `run.ts`.
- **New exports from `core/brokered-session.ts`:** `BrokerUnavailableError`,
  `isRetryableBrokerLaunch`. Both additive.
- **A permanent give-up rejects with the *same* `Error` instance it does today.** `spawnFailed()`'s
  and `launchFailure()`'s return values are rethrown unwrapped, so identity is preserved for both.
  This is a contract, not an implementation detail: `brokered-session.test.ts:272` asserts it with
  `rejects.toBe(spawnErr)`, and `attachBroker`'s `buildResult` rethrows the same object
  (`claude-cli-runner.ts:544-546`), so both terminal paths hand the caller one identical error.
- **New test-only env `CEZ_BROKER_FAULT`** (see Verification). Absent in normal operation; when
  absent, not one branch of the change is reachable.

## Phases

### P1: classify the give-up (independently shippable; no behaviour change)

`packages/cezar/src/core/brokered-session.ts` plus the broker attach wiring in
`packages/cezar/src/core/claude-cli-runner.ts`. Add `BrokerUnavailableError`,
`isRetryableBrokerLaunch`, the `everAnswered` field initialized from `previouslyAnswered`, pass
that option as true only for re-attach, and replace the **third** term of the `??` chain at
`brokered-session.ts:238-241` with the new class. The `spawnFailed()` and
`launchFailure()` terms are not touched. Ships green on its own **because the permanent branches
are not wrapped**: `brokered-session.test.ts:272` asserts object identity (`rejects.toBe(spawnErr)`)
and would go red under any wrapping, and the remaining existing assertions are on `.message`, which
does not move. Delivers nothing user-visible; delivers the discriminator AC3 and AC4 both need.

### P2: retry a cold broker once in the chain loop (delivers AC3 + AC4)

`packages/cezar/src/workflows/run.ts`: the `ActiveRun` field, the set in `runAgentStep`'s catch,
the clear beside `state.stepStopped = undefined`, the `retriedColdBroker` Set, the
capture/restore of `startImages`/`startAttachments`/`checkFailure` around the clears at
`run.ts:4283-4285`, the loop branch, and `reapAbandonedBroker` (both pid branches; shipped as
`reapAbandonedColdLaunch`, see P2). Ships independently of P3.

### P3: the same branch on the continuation path

`packages/cezar/src/workflows/run.ts`, `runContinuation`'s catch, its retry flag beside
`missingSessionRetry`, its trailing parameter beside `retriedMissingSession`, and the re-entry in
the `finally` with the original backend session id. Ships independently of P2 and is the smaller of the two; sequenced second only
because the chain loop is where every reported failure occurred.

### P4: record the decision (no code)

Knowledge entry for the transient/permanent taxonomy and the `everAnswered` safety argument;
changelog entry (`Area: Cezar`, `Type: Added`); update this file's Status; **and correct the
"Nothing on the broker-start path unlinks `exit.json`" sentence in
`2026-08-22-spool-exit-cross-talk.md` in place**, per the workspace's correction rule, the
`rmSync` at `claude-cli-runner.ts:401` has been there since `954c6a55` and a reader planning
against that sentence would build something already built.

**PARTLY DONE 2026-08-22. Corrected after review: this paragraph claimed all of P4 had landed, and
two thirds of it had not.** What genuinely landed: the doc commit `40a9be82`, and the cross-talk
correction, which resolved itself (see below). What is **still owed**:

- **the changelog entry.** There is none in the corpus. `notion-export/changelog/` holds ten
  `2026-08-22-*` files and none is this change;
  `2026-08-22-broker-scope-unit-name-collision--local.md` is the *collision* fix, not the retry.
- **the knowledge entry.** `decisions/2026-08-22-bounded-broker-retry-shipped.md` exists only as an
  unapplied `op:upsert` line in `.ai/cezar/runs/9e110775-….knowledge.ndjson`. A proposal is applied
  through the cockpit, later; `cez kb search` does not return it, and the house rule is that a
  corpus write counts only once search finds it.

The cross-talk correction resolved itself: that spec is no longer
`Proposed` but "Implemented and shipped 2026-08-22" (fix `30e266e2`), and it now carries the
correction in its own body at `2026-08-22-spool-exit-cross-talk.md:95`: "`exit.json` is in fact
removed **at spawn time**, and the first draft's 'nothing clears a…'". Verified by direct read; do
not re-apply it, and disregard the `Status: Proposed` attributed to that spec under Sources read,
which was true only at the `c1ccbe79` reading baseline.

### P5: the verification that did not ship

Added 2026-08-22 after review. P1 to P3 shipped; the verification they are checked by did not, and
Verification §4 and §6 read as executable while resting on a hook that does not exist. This phase is
the concrete remaining scope, so the implement step of this pass has something bounded to build. It
is independently shippable and changes no production behaviour: it is all test and fault-injection
code, plus the two corpus writes P4 still owes.

**(a) The `CEZ_BROKER_FAULT` hook, exactly as Verification §4 already specifies it.** Three modes,
read from the environment, inert when unset (§5 is the regression that pins the inertness):

- `deaf-once:<markerPath>` and `deaf-alive:<marker>` read in `run-broker.ts` **immediately before
  `server.listen(paths.ctl)`** — `:230` in the shipped tree at `ad7a0a41` (`:228` at the reading
  baseline). `meta.json` is already written by then (`:114`, `:113` at the baseline), which is what
  makes these reproduce the *transient* case: a broker that started, is recorded, and never answers.
- `never-start` read in `spawnBroker` **before the `rmSync`** at `claude-cli-runner.ts:402` (`:401`
  at the baseline), which reproduces the *permanent* case: nothing is started, no `meta.json` is
  written.

**(b) `packages/cezar/test/e2e/cold-broker-retry.test.ts`.** A **`node:test`** suite, not a vitest
one, in the shape of `package-cli.test.ts` (`npm pack` → install the tarball into a temp consumer
dir → drive the packaged `dist/index.js`). Verification §4 explains at length why the vitest shape
would exit green having executed zero assertions; that reasoning is unchanged and is the reason this
file has to be written rather than folded into `src/`.

**(c) The four missing cases in the existing `packages/cezar/src/workflows/broker-retry.test.ts`**,
named in §2: **bounded**, **the opening payload survives the retry**, **`everAnswered` is not
retried**, and **healthy run unaffected**. The first pins AC4's bound and nothing pins it today; the
second is, by §2's own text, the only case in that file that can catch a regression in the
capture/restore now live at `run.ts:4376-4378`/`:4495-4497`.

**(d) The two corpus writes P4 still owes** (the changelog entry and the applied KB decision), per
the correction above.

**(e) The two missing *unit* cases from Verification §1**, in
`packages/cezar/src/core/brokered-session.test.ts`. Added 2026-08-22 after the fourth review pass,
which found §1 reading as done while two of its five cases had never been written, so nobody's
remaining scope contained them. **Both are part of P5's deliverable and neither is optional:**

- **(i) answered then died.** Drive **one successful `brokerRequest` round-trip against a real
  bound control socket** — the fixtures at `brokered-session.test.ts:44` already build spools by
  hand and `:66`/`:109` already start a real broker, so this needs no new harness — then close the
  socket and exhaust the give-up budget. Assert the rejection **is** a `BrokerUnavailableError`,
  that `everAnswered === true`, and that `isRetryableBrokerLaunch(err) === false`. This is the
  **only** test that can catch a regression in the runtime assignment at `brokered-session.ts:308`;
  the shipped `:352` test reaches only the constructor seed at `:152`. Without it the retry's
  entire safety argument — "a session that ever answered may have produced billed work, so it is
  never relaunched" — is unpinned at every level.
- **(ii) permanent, never started, at the give-up seam.** Construct a `BrokeredSession` with
  `launchFailure: () => brokerNeverStarted(spoolDir, log)` over a spool with **no** `meta.json` and
  a launch log holding the real systemd refusal. Assert `result` rejects with the **same `Error`
  object** `launchFailure` returned (`rejects.toBe(...)`, matching the `spawnFailed` precedent at
  `:368`), that it is **not** an instance of `BrokerUnavailableError`, and that
  `isRetryableBrokerLaunch(err) === false`. `broker-scope-collision.test.ts:130`/`:200`/`:214`/`:229`
  pin `brokerNeverStarted` itself and its wiring, but nothing today pins the seam where its return
  value becomes the session's rejection — which is exactly AC4.

Nothing here is descoped. If a later session decides to drop any of it, say which part and why *in
this section*, rather than leaving §4 and §6 reading as runnable.

**P5 shipped 2026-08-22.** (a) `CEZ_BROKER_FAULT` — `never-start` in `claude-cli-runner.ts`'s
`spawnBroker` (before its `rmSync`), `deaf-once`/`deaf-alive` in `run-broker.ts` (before
`server.listen`). (b) `test/e2e/cold-broker-retry.test.ts`, three `node:test` cases against the
packaged tarball. (c) the four missing cases added to `workflows/broker-retry.test.ts`: bounded,
the opening payload survives the retry, `everAnswered` is not retried, healthy run unaffected. (e)
the two missing cases added to `core/brokered-session.test.ts`: "answered then died" (a real control
round-trip, then the socket removed) and the give-up seam's `rejects.toBe` identity assertion for
`brokerNeverStarted`. Commands run and their results: `npx vitest run
packages/cezar/src/core/brokered-session.test.ts packages/cezar/src/workflows/broker-retry.test.ts`
— 2 files, all passing (counts before/after this pass: unchanged file count, more cases per file);
`npm run typecheck` EXIT=0; `npm test` (full) — 2 failed, both pre-existing and unrelated
(`catalog.test.ts`'s CPU-budget flake, documented above, and `config-api.test.ts`'s "native model
settings" case, which depends on this sandbox's local coding-agent configs and touches nothing this
spec changes); `npm run build` EXIT=0 (`check:pack ok — 1082 files`); `npm run test:package` — 18/18
passing including all three new e2e cases, run twice back to back to check for flakiness in the
polling-based assertions (both green, ~8.5s/~1.5s/~5.8s per case).

**Known gap found while writing P5(b), not fixed here.** `test/e2e/cold-broker-retry.test.ts`'s
`deaf-once` case was originally written expecting the same give-up→retry path as `deaf-alive`
(matching this section's own Verification §4 text). Running it against a REAL packaged broker
showed otherwise: under `deaf-once` the broker's own process calls `process.exit(0)` right after
writing `meta.json`, and `BrokeredSession.tick()`'s `isPidAlive(this.lastMeta.pid)` check
(`brokered-session.ts:205`) notices the dead pid within one poll tick — far under the ~5s give-up
budget — and fails through `failBrokerVanished` (`:245`) with a plain `Error`, never through
`giveUp`'s `BrokerUnavailableError`. `isRetryableBrokerLaunch` only recognises the latter, so **a
broker whose own process dies before it ever binds is not retried today**, even though it is
arguably still within this spec's own definition of "transient" (`everAnswered` is false). The unit
test suite never caught this because `startRunBroker` runs IN-PROCESS there (the test's own pid
never dies), which is exactly the difference the e2e suite exists to catch. Left as a documented gap
rather than fixed here because P5 is scoped to verification only and must not change production
behaviour (see its own phase text); whether `failBrokerVanished`'s rejection should also become
retryable — and what that does to the "protects billed work" safety argument, since a vanished
broker's session state is less certain than a live one's — is a real design question for a follow-up
spec, not a one-line patch. The e2e test pins CURRENT behaviour (`deaf-once` fails with "died without
recording an exit", zero retry metrics) so a future change to it is a deliberate decision, not a
silent regression.

## Risks

- **A misclassified permanent failure burns 5 s and one relaunch.** The blast radius is one extra
  broker spawn per step, once. The classification is by elimination over three mutually exclusive
  branches inside one function, not by inference, so the way to get it wrong is to change
  `brokerNeverStarted`'s `if (readSpoolMeta(spoolDir)) return null` guard
  (`claude-cli-runner.ts:1102`) without changing P1, which Verification §1 pins directly.
- **The launch log is one file per run, so a retry's error can quote the previous attempt's lines.**
  `brokerLaunchLogPath` is `<runsDir>/<runId>.broker.log`, appended across every step of the run
  (`claude-cli-runner.ts:1074-1076`), and `brokerNeverStarted` quotes its tail. So if attempt 1 goes
  transient and attempt 2 fails permanently, the "launcher said:" quote may carry lines the first
  broker wrote. Cosmetic, not a correctness problem, the tail is still the newest output, and
  per-launch log files are deliberately out of scope here. Named so a reader debugging a doubled
  quote does not mistake it for a bug in the retry.
- **A misclassified *transient* failure is the dangerous direction, and `everAnswered` is the whole
  defence.** If a session that had already produced turns were retried, billed work would be
  discarded silently. Guarded twice: `everAnswered` must be false, and the abandoned spool is
  removed only by `spawnBroker`'s pre-existing `rmSync`, which runs on every step spawn today
  regardless of this change.
- **The reap SIGTERMs a broker that might be about to answer.** By construction it has failed 100
  consecutive connects over 5 s while a healthy broker binds in ≤716 ms measured. If it answers at
  t=5.1 s, the tokens it has spent are zero (nothing was ever sent to it), so the reap costs a
  process, not work. Best-effort and fully wrapped, so a failed reap never fails a step. The
  `meta.childPid` kill is the **primary** mechanism in both shapes, not belt-and-braces for the
  dead-broker case: the broker installs no signal handler, so SIGTERM to `meta.pid` ends it before
  its `child.on('exit')` handler could ever reap the backend. Relying instead on the `claude`
  losing the pipe on its stdin and exiting on EOF is exactly the chance this refuses to take: a
  backend blocked on its own inference call can outlive the EOF for minutes.
- **Two live `claude` processes for a few hundred milliseconds** between the SIGTERM and the new
  spawn. Both are on empty stdin; neither is billing. Contrast with the 30-minute leak
  `ORPHAN_TIMEOUT_MS` would otherwise impose, which is what P2 exists partly to close.
- **The retry counter is in-memory (residual gap, accepted).** A restart mid-step re-enters through
  `recover()`/`chainResumeAt` and could in principle spend a second cold-broker retry for the same
  step. Bounded by the restart machinery's own guards, and no measurement suggests this class
  recurs across restarts. Named here rather than fixed.
- **Brokering is unavailable under vitest.** `resolveBrokerCommand()` resolves `../index.js`
  relative to `import.meta.url`, which exists only in a built tree (`broker-launch.ts:41-55`), so
  `brokerAvailable()` is false for the entire unit suite. This is why Verification splits into unit
  tests at the `BrokeredSession` seam and a built-tree e2e: a workflow-level unit test cannot
  spawn a real broker, and pretending otherwise would produce a test that proves nothing.
- **The fault-injection env var is production code.** Mitigated by precedent (`CEZ_DRY_RUN`,
  `CEZ_MOCK_HANG`, `MOCK_CODEX_REJECT_RESUME`) and by being a single `if` at the top of a function,
  unreachable when the variable is unset. Verification §5 asserts the unset case explicitly.
- **This does not fix the cause of any observed failure.** Every failure in the record was the
  permanent collision, already fixed. This is defence in depth against a class that has been
  *reasoned about* but not yet *measured in production*. That is the honest framing, and the reason
  the bound is one rather than three.

## Verification

### 1. Unit: the taxonomy, at the seam where it is decided

**Three of the five cases below shipped, and they live in
`packages/cezar/src/core/brokered-session.test.ts`, not in the new
`core/broker-retry.test.ts` this section originally proposed** — grep for that name and you will
find nothing. Verified by direct read at `ad7a0a41`:

| Case below | State |
| --- | --- |
| **transient** | shipped, `brokered-session.test.ts:335` ("gives up and rejects result within 100 attempts when no broker ever answers"), but **weaker than specified here**: it passes no `launchFailure` and writes no `meta.json`, so it pins the `BrokerUnavailableError` / `everAnswered === false` / `isRetryableBrokerLaunch === true` triple but **not** the by-elimination interaction with `brokerNeverStarted`'s `meta.json` guard, which is the half that decides transient from permanent. |
| **permanent, spawn error** | shipped, `:368` ("a spawn failure takes precedence over the generic give-up message"), carrying the `rejects.toBe(spawnErr)` object-identity assertion this section asks for. |
| **permanent, never started** | **NOT written at this seam**, remaining work: P5(e)(ii). `broker-scope-collision.test.ts:130`, `:200`, `:214` and `:229` pin `brokerNeverStarted`'s own message and its wiring as `launchFailure` — but nothing asserts that when `launchFailure()` returns non-null the session's `result` rejects with **that same object** and `isRetryableBrokerLaunch === false`. That is the AC4 assertion, and it is unpinned. |
| **answered then died** | **NOT written anywhere**, remaining work: P5(e)(i). The nearest existing test (`:352`, and see §2's table) seeds `previouslyAnswered: true` through the **constructor** and never completes a control round-trip, so the runtime assignment `this.everAnswered = true` at `brokered-session.ts:308` — the line this section calls the guard on billed work — is untested at every level. |
| **negative control on the string** | not written, and already marked optional below: it is true by construction once `isRetryableBrokerLaunch` is an `instanceof` check. |

The cases as specified follow. The three that shipped are the specification they were written
from; the two that did not are P5(e)'s deliverable, and go in the same file, whose fixtures at
`:44` already build spool directories by hand and at `:66`/`:109` already run a real broker:

```
npx vitest run packages/cezar/src/core/brokered-session.test.ts
```

- **transient:** write a `meta.json` into a temp spool dir, bind no socket, construct a
  `BrokeredSession` with `launchFailure: () => brokerNeverStarted(dir, log)` and `pollMs: 1`; send
  one message. `result` rejects with a `BrokerUnavailableError`, `everAnswered === false`,
  `isRetryableBrokerLaunch(err) === true`, and `.message` still matches
  `/did not respond after \d+ms — giving up/`.
- **permanent, never started:** identical, but **no** `meta.json`, and a launch log containing the
  real systemd refusal (`Failed to start transient scope unit: Unit … was already loaded`). The
  rejection is **not** a `BrokerUnavailableError` (`err instanceof BrokerUnavailableError === false`),
  `isRetryableBrokerLaunch === false`, and `.message` matches
  `/was never started — no meta\.json was written; launcher said: .*already loaded/`. This is the
  AC4 assertion.
- **permanent, spawn error:** `spawnFailed: () => spawnErr` where `spawnErr = new Error('`claude`
  not found on PATH…')`. Assert `rejects.toBe(spawnErr)` — **object identity**, the same assertion
  `brokered-session.test.ts:272` already makes, pinning that P1 does not wrap this branch —
  `isRetryableBrokerLaunch === false`, and that the spawn error still wins the precedence contest
  (`brokered-session.test.ts:261` pins the existing half).
- **answered then died:** succeed one control round-trip, then close the socket and exhaust the
  budget. The rejection **is** a `BrokerUnavailableError` (the generic branch), but
  `everAnswered === true`, so `isRetryableBrokerLaunch === false`. **This is the test that protects
  billed work**; without it the retry is unsafe.
- **negative control on the string:** `isRetryableBrokerLaunch(new Error('claude CLI exited with
  code 1 — run broker for /x did not respond after 5000ms — giving up'))` is `false` (the embedded
  text is verbatim, em dashes included, because that is what the real message contains). A plain
  `Error` whose text embeds the phrase must not be retryable: the defect a regex would have.
  **Optional as shipped:** `isRetryableBrokerLaunch` is an `instanceof` check
  (`brokered-session.ts:60-62`), so this case is true by construction and documents intent rather
  than guarding anything. Keep it if it is cheap; it is not part of P5's remaining scope.

### 2. Unit: the chain loop retries once, and only once

**SHIPPED AS `packages/cezar/src/workflows/broker-retry.test.ts`** (169 lines), not
`cold-broker-retry.test.ts` as the next line still says: grep for the name below and you will find
nothing. It contains **three** of the cases specified here, and the other four were never written.
Verified by direct read at `ad7a0a41`:

| Case below | State |
| --- | --- |
| retries and continues | shipped, `broker-retry.test.ts:105` ("retries one cold broker once and makes the reason visible") |
| permanent is not retried | shipped, `:123` ("fails a never-started broker immediately without spending the retry") |
| (P3's continuation twin, not listed below) | shipped, `:138` ("relaunches a continuation broker with the same backend session context") |
| **bounded** | **NOT written**, remaining work: P5(c). Nothing pins AC4's bound today. |
| **the opening payload survives the retry** | **NOT written**, remaining work: P5(c). The capture/restore it guards is live at `run.ts:4376-4378`/`:4495-4497` with no test on it, and this section's own text calls it the only case here that can catch that regression. |
| **`everAnswered` is not retried** | **NOT written** at the workflow level, remaining work: P5(c). At the *unit* level, only the **re-attach seed** is covered (`core/brokered-session.test.ts:352`, "never classifies a re-attached channel as a cold launch"): that test sets `previouslyAnswered: true` through the constructor and never completes a control round-trip, so it exercises the seed at `brokered-session.ts:152` and never the runtime assignment `this.everAnswered = true` at `:308`. The runtime path — the one §1 calls "the test that protects billed work" — is **untested at every level**, and is added by P5(e)(i). |
| **healthy run unaffected** | **NOT written**, remaining work: P5(c). |

The original section text, which describes all seven as if they were to be written together, is
unchanged below and is the specification for the four that remain:

`packages/cezar/src/workflows/cold-broker-retry.test.ts`, built on `step-stopped.test.ts`'s
harness (real `RunManager` + `RunStore` in a temp git repo under `CEZ_DRY_RUN=1`, `settled()`
poller, `events()` NDJSON reader, `step-stopped.test.ts:34-100`).

**The injection seam, named concretely, because the obvious ones do not work.** Brokering is off
under vitest (`brokerAvailable()` is false, see Risks), so `runAgentStep` never constructs a
`BrokeredSession` and no real code path can raise a `BrokerUnavailableError` here; and
`state.brokerNeverAnswered` lives on a private `ActiveRun` inside `RunManager` with no setter and no
window a test could write it in. The precedent that P3 mirrors, `recover-session-failure.test.ts`,
injects through a mock backend binary plus `CEZ_ENV_PASSTHROUGH` (`MOCK_CODEX_REJECT_RESUME`), and
no mock CLI can produce this error class either. So inject at the **runner factory**:

```ts
vi.mock('../core/runner-factory.ts', async (importOriginal) => { /* … */ });
```

`createRunner` is imported at `run.ts:14` and called at `:5081` (chain step) and `:3704`
(continuation), so one mock covers both P2 and P3. The fake runner's `startSession` returns a
session whose `result` rejects with `new BrokerUnavailableError(…, { everAnswered: false })` on the
first call and resolves normally on the second. `vi.mock` is already idiomatic in
this codebase: `broker-scope-collision.test.ts` uses it three times (`:40`, `:69`, `:80`). **This
is what makes P1's *exported* error class and its exported type guard load-bearing rather than
merely tidy**: the test constructs the real class, so a change to the class breaks the test.

The cases:

- **retries and continues:** a two-step chain where the first step's session rejects once with a
  `BrokerUnavailableError{everAnswered:false}` and succeeds on the second attempt.
  Assert `steps[0].status === 'done'`, `iterations === 2`, run status not `failed`, the chain
  reached step 2, exactly one `note` containing `relaunching the broker once`, and exactly one
  `run.step.retried_cold_broker` metric for that step.
- **bounded:** the same error on both attempts. Assert `status === 'failed'`, exactly **one**
  `run.step.retried_cold_broker` metric, `iterations === 2` (not 3), and the run's `error` carries
  the give-up message.
- **permanent is not retried:** the mock rejects with a **plain `Error`** carrying the
  launcher-quoting "never started" text, not a `BrokerUnavailableError` — which is what the real
  `launchFailure()` branch now produces. Assert **zero** retry metrics, `iterations === 1`,
  `steps[0].status === 'failed'`, and that the step's `error` is that text. This is AC4 end-to-end.
- **`everAnswered` is not retried:** `BrokerUnavailableError{everAnswered:true}` → zero retry
  metrics.
- **the opening payload survives the retry:** start the run's first step with `startImages` (and a
  non-empty `startAttachments`), fail attempt 1 with the transient error, and assert the mock
  runner's **second** `startSession` call received the same images and attachments, not `undefined`
  and `[]`. Without the capture/restore specified in P2 this is the case that goes red, and it is
  the only case in this file that can catch that regression: every other retry path in the engine
  is gated so it cannot reach a first attempt.
- **healthy run unaffected:** the `step-stopped.test.ts:175` control, re-used verbatim in shape:
  no retry metric, no note, `iterations === 1` for every step.

### 3. Prove the retry is necessary: run test 2 red first

Land the tests before P2 and record the failure output in the implementation note. A retry test
that has never been red proves the assertion compiles, not that the branch does anything.

**Unverified for the shipped three.** No red output was recorded anywhere for the cases that did
ship, so this step's own evidence is missing and it should not be read as satisfied. It still
applies, and is now cheap to honour, for the four cases P5(c) adds: write them against the current
tree, and for **bounded** and **the opening payload survives the retry**, confirm they go red when
the branch they guard is stubbed out.

### 4. Built-tree e2e: a real broker, a real socket

New `packages/cezar/test/e2e/cold-broker-retry.test.ts`. **This is a `node:test` suite, not a vitest
one**, and getting that wrong makes the whole section decorative: `packages/cezar/vitest.config.ts`
sets `include: ['src/**/*.test.ts']` with an explicit comment that `test/` is deliberately excluded
because those suites pack and install the real tarball, and the root `vitest.config.ts` sets
`passWithNoTests: true`, so `npx vitest run packages/cezar/test/e2e/` exits **green having executed
zero assertions**. The `test/e2e/*.test.ts` files import `test from 'node:test'` and are run by
`npm run test:package` (`node --import tsx --test test/e2e/*.test.ts`,
`packages/cezar/package.json`). Write the new file in the shape of `package-cli.test.ts`: `npm pack`
→ install the tarball into a temp consumer dir → drive the packaged `dist/index.js`. That packaging
step is not ceremony; it is what makes `resolveBrokerCommand()` resolve and brokering genuinely on.

Requires the fault hook:

- **`CEZ_BROKER_FAULT=deaf-once:<markerPath>`**, read in `run-broker.ts` immediately before
  `server.listen(paths.ctl)` (`:230` as shipped, `:228` at the reading baseline): if the marker file
  does not exist, create it and `process.exit(0)` **without binding**. `meta.json` is already
  written at `:114` (`:113` at the baseline), so this
  reproduces the transient case exactly, a broker that started, is recorded, and never answers. A
  file marker rather than a counter because the broker is a separate process each time. Note what
  this mode does **not** reach: it exits, so `meta.pid` is always already dead and the
  `isPidAlive(meta.pid)` reap branch never fires under it.
- **`CEZ_BROKER_FAULT=deaf-alive:<markerPath>`**, read at the same point (`run-broker.ts`,
  immediately before `server.listen(paths.ctl)` at `:230`): if the marker file does not exist,
  create it and **skip the `listen` call while leaving the process running**. No keepalive is
  needed, the child's stdio pipes hold the event loop open. This is the mode that reproduces the
  case the transient classification actually targets, `meta.json` written, broker alive, socket
  never bound, and it is the **only** way to exercise the `isPidAlive(meta.pid)` reap branch. Both
  branches are covered only if both modes are run.
- **`CEZ_BROKER_FAULT=never-start`**, read in `spawnBroker` immediately before the `rmSync` at `claude-cli-runner.ts:402` (`:401` at the baseline): append
  `fault injection: never-start` to the launch log and skip the spawn. Reproduces the permanent
  case without needing a poisoned systemd scope, which `8e20dfbf` has, correctly, made impossible
  to create.

`CEZ_BROKER_FAULT` reaches the broker child unaided: `buildChildEnv`'s allowlist admits any `CEZ_*`
name that is not secret-shaped (`agent-env.ts:376`), so it needs **no** `CEZ_ENV_PASSTHROUGH` entry.
Do not spend a cycle wiring one.

Then, on a built tree (the build is a precondition, not an optimisation: `test:package` packs
`dist/`). **Run it from `packages/cezar`, the cwd `test:package` uses**, not from the repo root:
`package-cli.test.ts` derives its `repoRoot` from `import.meta.url` rather than from `cwd`, so the
path is relative to the package:
```
npm run build:server
cd packages/cezar
CEZ_RUN_BROKER=1 CEZ_BROKER_FAULT=deaf-once:$PWD/.tmp/deaf \
  node --import tsx --test test/e2e/cold-broker-retry.test.ts
```

**The fixture the suite drives** is the one `package-cli.test.ts` already uses: a temp fixture repo
plus `CEZ_DRY_RUN=1 … run mock:done` against the packaged CLI (`package-cli.test.ts:80`, and
`:118` for the blocked-task variant). That is the right fixture rather than a real backend because
`CEZ_DRY_RUN=1` swaps every agent CLI for `scripts/mock-claude.mjs`
(`workflows/postconditions.ts:69-76`) — still a real child process, so the broker, its spool, its
`meta.json` and its control socket are all genuinely exercised, only the model call is not.
Assert the first step's broker never binds, the second broker binds, the run reaches a terminal
non-`failed` status, and `<runsDir>/<runId>.broker.log` exists.

**Assert the relaunch by `instanceId`, not by `--unit`.** Corrected 2026-08-22 after review: this
step previously said "the step retries once with a **different** `--unit` value", which is not
executable on every host. `buildBrokerLaunchArgv` returns `[...opts.command]` unchanged unless
`isolation === 'scope'` (`core/broker-isolation.ts:149-150`), and the mode is chosen at runtime by
`chooseIsolation(probeIsolationCapabilities())` (`workflows/run.ts:1906-1908`) — so on a host with
no usable systemd user manager there is **no `--unit` in the argv at all**, nothing to compare, and
the assertion degrades silently to vacuous instead of failing loudly. Assert instead that the
retry's broker carries a **different `instanceId`** than the abandoned launch's: it is unique per
launch (`nextBrokerInstanceId`, generated at `workflows/run.ts:1946`, threaded through
`core/claude-cli-runner.ts:410`) and is written into `meta.json` at `core/run-broker.ts:114-125`,
so it is readable regardless of isolation mode. Capture the abandoned `instanceId` from `meta.json`
**before** the retry's `rmSync` deletes the spool — the same "record it before the retry" step the
`deaf-alive` paragraph below already requires for `meta.pid`/`meta.childPid`. And, **only when
`manager.brokerIsolation()` is `'scope'`** (`run.ts:1906`), additionally assert that the two
`--unit` names differ; skip that half otherwise rather than asserting on an argv that has no
`--unit`.

Then re-run with **`CEZ_BROKER_FAULT=deaf-alive:$PWD/.tmp/alive`**, the case `deaf-once` cannot
reach. Record **both** `meta.pid` and `meta.childPid` from the abandoned spool's `meta.json`
**before** the retry deletes the directory, and assert after the run that **both** are gone, not
only the child. This is the assertion that would have caught the "SIGTERM the broker and let it
reap its child" defect, and without it the alive-broker branch ships unexercised.

Finally re-run with `CEZ_BROKER_FAULT=never-start` and assert the run fails on the **first**
attempt with the launcher-quoting message and no retry metric.

### 5. Regression: the hook is inert when unset

Assert `spawnBroker` and `startRunBroker` behave byte-identically with `CEZ_BROKER_FAULT` absent:
re-run `broker-scope-collision.test.ts`, `brokered-session.test.ts`, `brokered-parity.test.ts`,
`run-broker.test.ts`, `recover-brokered.test.ts`, `step-stopped.test.ts` and
`recover-session-failure.test.ts` unchanged. `recover-session-failure.test.ts` matters
specifically: `373b1b10` made a missing persisted session terminal, and this change must not turn
it into a loop.

### 6. Production E2E on `prod-host` (QA Needed until this runs)

**RAN 2026-08-23T00:07-00:08 UTC, all steps passed, DONE.** Executed against the just-deployed
release `20260823T000500Z-ef52ad86` via the box's `/usr/local/bin/cezar` wrapper (resolves to
`/opt/cezar`, i.e. the real deployed binary and real `systemd-run --user --scope`), each case in
its own throwaway `/tmp` fixture repo + `CEZ_HOME` (never the real workspace), `CEZ_DRY_RUN=1`.
`deaf-once` and `deaf-alive` were each run once (not "twice" as originally scoped — a single
`CEZ_BROKER_FAULT` value selects one mode per run; each mode got its own run, which is what the
sentence above means).

1. PASS — `deaf-alive` run's stdout printed `run broker ... did not respond after 5000ms — giving
   up ... relaunching the broker once` on the CLI thread (not only in the run's NDJSON).
2. PASS — `systemctl --user list-units 'cezar-run-*'` showed only the abandoned scope while attempt
   1 was live; after cutover to attempt 2 (instance `mt51sm3t-2`, a different suffix from the
   abandoned `mt51sm3t-1`) and after the run finished, neither scope remained.
3. PASS — `deaf-alive`: abandoned `meta.pid` 572414 and `meta.childPid` 572496 both confirmed gone
   via `ps -p` after the run finished. `deaf-once`: broker pid 573942 (already dead before the reap,
   as the spec predicts) and backend childPid 573962 both confirmed gone.
4. PASS — `deaf-alive`'s `<runId>.ndjson` contains exactly one `run.step.retried_cold_broker` line.
   `deaf-once`'s contains zero, which is correct: this run does not go through the retry path at all
   (see the `deaf-once` gap below) — §6 states the retry-count assertion for the `deaf-alive` case;
   `deaf-once` proves the reap works without ever spending the retry, per Verification §5.
5. PASS — `CEZ_BROKER_FAULT=never-start` failed the first attempt, zero retry metrics, error
   `... was never started — no meta.json was written; launcher said: fault injection: never-start`,
   matching `<runId>.broker.log`.

No stray `cezar-run-*.scope` units or fixture directories were left on the box; all three `/tmp`
scratch trees were removed after verification.

Gates green is necessary, not sufficient. After deploy, with a `CEZ_BROKER_FAULT` fault set for one
run only. Steps 1-4 are run **twice, once under `deaf-once:<path>` and once under
`deaf-alive:<path>`**, so both reap branches are covered on the box and not only in the suite:

1. Start a two-step run. Confirm on the thread that the retry `note` is visible to a reader, not
   only in the NDJSON.
2. `systemctl --user list-units 'cezar-run-*'` shows the abandoned unit gone (reaped) and the
   replacement active with a different instance suffix.
3. No orphaned `claude` process survives the run. Record **both** `meta.pid` and `meta.childPid`
   from the abandoned spool's `meta.json` **before** the retry deletes the directory, then
   `ps -p <pid>` on each after the run terminates and assert both are gone. Under `deaf-once` the
   broker exits before binding, so `meta.pid` is already dead and only the `meta.childPid` signal
   does any work; under `deaf-alive` the broker is still running when the reap fires, so this is
   the run that proves the `isPidAlive(meta.pid)` signal lands and that killing the broker did not
   strand its child. Both runs must show both pids gone.
4. `grep run.step.retried_cold_broker <runsDir>/<runId>.ndjson` returns exactly one line.
5. Separately, with `CEZ_BROKER_FAULT=never-start`: the step fails on the first attempt, the error
   quotes the launch log, and no retry metric is emitted.

Until steps 1-5 have actually been executed this ships as **QA Needed**, not Done.

### 7. Gates

`npm run typecheck`, `npm test` (note the known, unrelated `src/knowledge/catalog.test.ts`
CPU-budget flake documented in `2026-08-22-resume-fresh-session-fallback.md`'s implementation
note), `npm run build`, `npm run test:package`. Quote any failure rather than summarising it.

## Sources read

Everything below was read at `origin/main` = `c1ccbe79` unless a commit is named.

**Brief and KB**
- `.ai/specs/briefs/2026-08-22-bounded-broker-retry.md` (this run's step-1 output, KB
  `specs-855ce6ed75c2`), read in full. Its citations were re-verified against `origin/main`; its
  line numbers are from this worktree's stale `2778fd52` and have been restated here.
- KB `notion-d660e1080ec2`: "A per-run name for a per-step resource, and the timeout that lied
  about it" (the measurement table and the lingering-scope evidence).
- KB `notion-8c1963ca2c16`: changelog, "Fixed: a run's second step could never start a broker".
- KB `notion-04ca960e6408`: "A shared spool and an exit record with no owner" (the twin-agent
  leak, the `$82`/`$119` cost, the 30-minute clock).

**Specs**
- `.ai/specs/2026-08-22-broker-scope-unit-name-collision.md` (via `git show 8e20dfbf:`): full,
  including its explicit "deliberately NOT done here: a step-level retry" paragraph.
- `.ai/specs/2026-08-22-spool-exit-cross-talk.md`: full; Status `Proposed`, so its P1-P5 are
  **not** in the baseline. Its "Why the step retry cannot save it" claim about `exit.json` is
  addressed in Problem.
- `.ai/specs/2026-08-22-resume-fresh-session-fallback.md`: TLDR, Problem §1-4, Solution §1-2 and
  the implementation note. The direct template for P2/P3, and **absent from the brief**, which read
  the stale checkout.
- `.ai/specs/2026-08-20-agent-step-stopped-is-not-failed.md`: the one-retry/note/metric precedent.
- `.ai/specs/2026-08-22-run-broker-cli-keepalive.md`: read for this repo's section conventions and
  for the `giveUp`-terminates-the-session history that P1 builds on.

**Code**
- `packages/cezar/src/core/brokered-session.ts`: full file (295 lines): `PENDING_MAX_ATTEMPTS`
  `:44` and its measurement comment `:38-42`, `spawnFailed`/`launchFailure` doc contracts
  `:79-106`, constructor `:124-138`, `tick` `:171-182`, `pumpPending` `:225-252`, `giveUp`
  `:261-267`.
- `packages/cezar/src/core/claude-cli-runner.ts`: `startSession` dispatch `:145-158`, `spawnBroker`
  `:385-483` in full (`rmSync` `:401`, `nextBrokerInstanceId` `:409`, launch-log fd `:425-426`,
  the `launchFailure` wiring `:478`), `attachBroker` `:486-600`, `emitBrokeredTerminalEvents`
  `:971-1002`, `brokeredExitFailure`/`brokeredExitMessage` `:1007-1021`, `brokerLaunchLogPath`
  `:1074-1077`, `brokerNeverStarted` `:1101-1109`, `readLaunchLogTail` `:1110-1126`.
- `packages/cezar/src/core/run-broker.ts`: `ORPHAN_TIMEOUT_MS` `:61`, child spawn `:103`,
  `writeSpoolMeta` `:113`, `server.listen` `:228`, orphan watchdog `:230-237`.
- `packages/cezar/src/core/broker-launch.ts`: full file; `brokerAvailable`/`resolveBrokerCommand`
  `:41-61` are why the unit suite cannot spawn a broker.
- `packages/cezar/src/core/run-spool.ts`: `SpoolMeta` schema `:38-46` (`pid` `:42`, `childPid`
  `:44`), `writeSpoolMeta` `:137`, `readSpoolMeta` `:146`, `isPidAlive` `:173`, `isSpoolLive`
  `:236-244`. These are the two exported helpers `reapAbandonedColdLaunch` is built from.
- `packages/cezar/src/core/runner-factory.ts`: full file (26 lines). The single `createRunner`
  switch, imported at `run.ts:14` and called at `:3704`/`:5081`, the seam Verification §2 mocks.
- `packages/cezar/src/core/agent-env.ts:365-385`: `buildChildEnv`'s allowlist, specifically
  `if (key.startsWith('CEZ_') && !looksSecret(key)) return true` at `:376`, which is why
  `CEZ_BROKER_FAULT` needs no `CEZ_ENV_PASSTHROUGH` entry.
- `packages/cezar/src/core/agent-runner.ts`: `isMissingSessionRejection` `:116-133` and its
  string-matching rationale.
- `packages/cezar/src/workflows/run.ts` (6 188 lines): `brokerFor` `:1912-1934`, `takeReattach`
  `:1894-1899`, `persistConsumedOffset` `:1947-1975`, `runContinuation`'s catch `:3824-3856`,
  `execute()`'s retry-state preamble `:4150-4232`, the step loop `:4236-4360`, `runAgentStep`
  signature `:4776-4802`, session creation and the `session.result` try/catch `:5080-5240`,
  `finishStep` `:6041-6070`, `ActiveRun.stepStopped` `:304` with its doc comment `:294-303`.
- `packages/web/src/routes/task-thread/thread-state.ts:576-585`: `note`/`lifecycle` render as a
  dim meta line; `:605-612` `step-end` renders only on `failed`. There is no `step-start` case, which
  is why AC3 needs a `note`.

**Tests**
- `packages/cezar/src/core/broker-scope-collision.test.ts`: all four describes; `:213` is the test
  that pins the by-elimination argument P1 depends on, and `:129` is the one that pins
  `spawnFailed` staying narrow.
- `packages/cezar/src/core/brokered-session.test.ts:227-270`: the ref'd-timer and give-up/precedence
  assertions P1 must not disturb.
- `packages/cezar/src/workflows/step-stopped.test.ts:1-175`: the harness Verification §2 reuses.
- `packages/cezar/src/workflows/recover-brokered.test.ts:1-70`: how a brokered run is faked without
  a real broker.
- `packages/cezar/src/workflows/recover-session-failure.test.ts`: the terminal-recovery guard
  (`373b1b10`) this must not weaken.
- `packages/cezar/scripts/mock-claude.mjs:14-35, 94-240`: the existing mock knobs, and the
  `--resume` rejection hook added for the missing-session spec (precedent for §4's fault hook).
- `packages/cezar/test/e2e/package-cli.test.ts:1-45`: `node:test` + `npm pack` + install-the-tarball,
  the shape Verification §4's new file copies.

**Test wiring (read to make Verification executable)**
- `packages/cezar/vitest.config.ts`: `include: ['src/**/*.test.ts']` and the comment saying `test/`
  is excluded on purpose.
- `vitest.config.ts` (root): `passWithNoTests: true`, which is why pointing vitest at `test/e2e/`
  would have exited green on zero assertions.
- `packages/cezar/package.json`: `test:unit` = `node --import tsx --test test/unit/*.test.ts`,
  `test:package` = `node --import tsx --test test/e2e/*.test.ts`.
- `package.json` (root): `build:server`, `test`, `test:package`, `typecheck`.

**Not found / not chased**
- No KB entry, spec or test covering transient broker/control-channel **step retry** exists; this
  is new ground, as the brief reported.
- No production measurement of how often a broker starts and then goes deaf. The bound of one
  retry is taken from precedent, not from data, and that is stated in Solution.
- Historical todo `c4cd4ab6`, named by the collision spec as the filed retry todo, is not in the
  current tracker (`cezar todo list` returned nothing in step 1); this task
  `9e110775-a190-4d91-94aa-da4791752b7e` is its live successor.
