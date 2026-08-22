# Brief — the run broker stalls a one-shot `cezar run` at its first agent step

**For task d92e6b85. Gather-the-record step only — no spec, no code written here.**

**RESOLVED 2026-08-22.** The mechanism this brief traces (root mechanism section, below) was
confirmed and fixed — see `.ai/specs/2026-08-22-run-broker-cli-keepalive.md` for the spec and
`3e6d1b7e` (`origin/main`) for the shipped commit. Kept here as the discovery record; the spec is
now the current source of truth for this defect.

## The problem, in this repo's own terms

`npm run test:package` (`packages/cezar/test/e2e/package-cli.test.ts:354-432`, "the release
tarball installs and runs the dry-run CLI workflow") installs the packaged tarball into a
clean consumer dir and runs `cezar run mock:done --repo <fixture>` with `CEZ_DRY_RUN=1`. Under
the **default** execution path (brokering on) the process hangs until the test's own 60s
`execFile` timeout kills it; under `CEZ_RUN_BROKER=0` the identical invocation finishes
correctly (`run done`/`review`, `runs.json` shows one `done`/`review` row). This is CLI-only —
brokered runs on the server/cockpit path (`cezar serve`) are unaffected.

Observed at the stall: the run-broker process and the mock `claude` backend are both still
alive, `ctl.sock` is bound, `out.ndjson` contains only the mock's synchronous startup line
(`{"type":"system","subtype":"init"}`), `err.log` is empty, and **the CLI parent process has
already exited 0** — before the run ever reached a terminal status.

## Root mechanism (read from code, not yet runtime-confirmed)

Confirmed by direct code reading in `packages/cezar/src/core/`:

- `claude-cli-runner.ts:375-443` (`spawnBroker`) forks the broker as a **detached**, `stdio:
  'ignore'` child and immediately `proc.unref()`s it (`:434`) — correct and intentional, commented
  as such: the broker must outlive the parent, so nothing in the parent may hold a pipe to it.
- `brokered-session.ts:96-100` then arms the spool-tailing poll loop as an **unref'd**
  `setInterval` (`this.timer.unref?.()`). Unlike every sibling `unref()` in this codebase
  (`claude-cli-runner.ts:213/215/232/272/274/488`, `run-broker.ts:175/237`), **this one carries no
  comment justifying it** — it is the one unref in the whole brokered stack with no stated reason.
- The constructor fires one `pumpPending()` immediately (`:98`), which opens a `net.connect()` to
  `ctl.sock` (`broker-client.ts:30-84`). At that instant the broker has only just been `spawn()`'d
  and has not yet reached `server.listen(paths.ctl)` (`run-broker.ts:227-228`) — a genuine startup
  race — so the connect fails fast (not via the 5s no-reply timeout, via ECONNREFUSED/ENOENT), the
  `catch` in `pumpPending` (`brokered-session.ts:196-202`) swallows it, and the tick returns.
- At that point **every handle in the process is now unref'd or gone**: the broker's `proc` handle
  (deliberately), and this poll timer (apparently by copy-paste, not by design). Node's event loop
  finds nothing left to wait for and fires `beforeExit`/exits with the default code 0 — before the
  50ms interval ever gets a second chance to retry the send — regardless of the still-unsettled
  JS promises in `runCommand` (`index.ts:974-978`) and `BrokeredSession.result`.
- This is safe on the **server** path only because `cezar serve`'s own HTTP listener
  (`server/server.ts:7149`) is a genuinely ref'd handle that keeps that process alive independent
  of anything brokering-related — the one-shot CLI has no such ambient keep-alive.
- `scripts/mock-claude.mjs` has no broker-awareness at all; it just parks on stdin `readline`
  (`:534-566`) waiting for a line that never arrives, because nothing upstream ever got as far as
  writing it (confirms the failure is entirely on the parent/broker-transport side).

This is a **different** bug from the one documented in the comment at `src/index.ts:228-243`
(the `run-broker` subcommand being unreachable inside `parseArgs`, previously caught by this same
test). That prior bug left the spool with no `out.ndjson`/`meta.json` at all, because the broker
CLI errored before ever calling `startRunBroker`. In the *current* failure, `out.ndjson` already
contains the mock's startup line, proving `startRunBroker` ran and its stdout tee worked — so a
spec here must not "fix" the already-fixed unreachable-case bug and declare victory.

## What the record already decided

- **Origin spec:** `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md` (KB
  `specs-594acc539b36`), §"P4 — Runs survive the restart: the detached run broker", commit
  `954c6a55`. Written entirely for the **server/cockpit** restart-survival scenario (a
  `cezar.service` restart SIGKILLs agent children; the broker detaches so a run survives it).
  `brokerAvailable()` gates only on "is this a built tree" (`broker-launch.ts:50-61`) — the
  spec's "Implementation notes (2026-08-21)" section only *afterward* notes this means "production
  gets brokering by default with no flag to set," which silently pulls the one-shot CLI path in
  too. **The one-shot CLI was never named as a use case and is not covered by that spec's own
  Verification section** (server/cockpit scenario only) — this is the prior-decision gap a new
  spec must close explicitly, not just patch around.
- **The exit-code convention this bug violates already exists elsewhere in the same file:**
  `index.ts` sets `process.exitCode = final === 'done' || 'review' ? 0 : 1` for the normal
  one-shot `run` completion, and an equivalent pattern for `server-deploy` — i.e. "exit 0 only
  through the real terminal-status branch." This bug exits 0 via Node's natural empty-loop drain,
  never touching that logic at all.
- **The acceptance criteria are not new** — todo `c895a348-4bee-4a81-89ab-a62788a6a118`
  (`.ai/cezar/todos.json:1718`, status `todo`/`high`, `startedTaskId: d92e6b85-…` — already
  attached to *this* task) states them near-verbatim, including *"the parent no longer exits 0
  while the broker and backend are still alive; if it must give up it fails loudly with a
  non-zero exit."* It folds in two other independently-filed duplicates (`1e8e5266-…`,
  `46dbb850-…`), both archived as superseded. The original todo (`3c6a5aa7-…`) was filed from
  inside task `70f19253`'s worktree and died with it (gitignored, worktree-local
  `.ai/cezar/todos.json`) — the general lesson (`cezar todo add` resolves project from cwd) is
  already captured in this task's own handoff and doesn't need re-deriving.
- **No conflicting or duplicate in-flight work.** No other branch/commit since 2026-08-21 touches
  `attachBroker`/`run-broker*`/`brokered-session.ts` with a fix. Sibling worktree `95d3c6f2`
  documents this bug as a known "trap" in its own not-yet-merged spec draft but explicitly treats
  it as independent and doesn't attempt a code fix (its only touch to `claude-cli-runner.ts` is an
  unrelated `--effort` flag).

## Code actually involved

- `packages/cezar/src/core/claude-cli-runner.ts` — `attachBroker`/`spawnBroker` (`:375-547`),
  the direct-pipe path for comparison (`:135-352`).
- `packages/cezar/src/core/brokered-session.ts` — the poll timer and its unref (`:96-100`),
  `pumpPending`/`dispatch` (`:175-210`), `finish()` (`:147-162`, never reached because `tick()`
  never runs again).
- `packages/cezar/src/core/run-broker.ts` — broker process lifecycle, `ctl.sock` bind
  (`:93-269`, esp. `:227-228`).
- `packages/cezar/src/core/broker-client.ts` — per-request `net.connect()` to `ctl.sock`,
  5s no-reply timeout (`:20`, `:30-84`).
- `packages/cezar/src/core/broker-launch.ts` — `CEZ_RUN_BROKER` gating (`brokerPreference`
  `:34-39`, `brokerAvailable` `:58-61`, "built tree only" check `:50-55`).
- `packages/cezar/src/index.ts` — one-shot `run` command's exit-code convention (`:889-986`,
  status-resolution promise `:974-978`), and the *prior*, already-fixed unreachable-subcommand
  bug at `:228-247` (do not conflate with the live bug).
- `packages/cezar/scripts/mock-claude.mjs` — no broker-awareness; just stdin `readline` (`:25`,
  `:534-566`).
- `packages/cezar/server/server.ts:7149` — the ref'd HTTP listener that is why the identical
  brokered-session code is safe on the server path (comparison/reference only, not to be
  touched).

## Open questions a spec will have to settle

1. **Where does the keep-alive obligation belong?** Options: (a) stop unref'ing
   `brokered-session.ts:100`'s poll timer for as long as the session isn't finished (simplest;
   the server path already has its own ref'd listener so this is free there too, since an extra
   ref'd handle alongside an already-alive process changes nothing observable); (b) have the
   one-shot CLI command itself hold an explicit keep-alive handle for the run's duration,
   independent of `BrokeredSession`'s internals; (c) something else. (a) looks like the minimal,
   most local fix but should be checked against why the unref pattern was applied here at all
   (possibly just copy-paste from the sibling unrefs, per the trace agent's finding of "no
   comment" — worth confirming there's no unstated reason before removing it).
2. **The startup race is real and distinct from the keep-alive bug.** Even with a keep-alive
   fix, the *first* `ctl.sock` connect attempt will almost always fail because the broker hasn't
   called `server.listen` yet — that's fine today only because the poll loop retries every 50ms.
   Should retry/backoff behavior here be hardened (e.g., distinguish "still starting" from "will
   never come up") independent of the ref/unref fix?
3. **What does "fails loudly with a non-zero exit" look like precisely?** Is this a new
   give-up deadline distinct from the existing per-step inactivity `deadline`
   (`claude-cli-runner.ts:274/488`, which already exists and is itself unref'd for a stated,
   correct reason — a wall-clock kill switch must not itself be a keep-alive)? Should the one-shot
   CLI's `runCommand` (`index.ts:974-986`) gain an explicit ceiling after which it sets
   `process.exitCode = 1` and logs/exits rather than relying on the run ever reaching a terminal
   status?
4. **Verification shape.** The existing e2e (`package-cli.test.ts`) is already the regression
   gate and exercises exactly this path (built `dist`, brokering on by default) — does the fix
   just need this test to pass, or does the acceptance criterion "reaches 'run done' ... without
   CEZ_RUN_BROKER=0" call for a second, more targeted unit/integration test at the
   `BrokeredSession`/broker-client layer (so a future regression here is caught faster than a
   120s e2e timeout)?
5. **Scope check:** should the fix also extend `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`
   itself (per this repo's "update the spec when the implementation diverges" rule) to explicitly
   name the one-shot CLI as a covered use case with its own keep-alive invariant, given that the
   original spec's Verification section never tested it?

## Not found

No indexed KB document (as opposed to code comments/todos/handoff notes) discusses
`attachBroker`, `ctl.sock`, or this failure mode as first-class knowledge — it exists only in
code, in the todo, and in this task's own handoff. `.ai/specs/2026-08-21-run-tests-reasoning-ceiling.md`
was referenced by a handoff in a sibling worktree as newly written but does not exist anywhere in
this checkout or any worktree — that step's output apparently never landed on `main`; not relevant
enough to chase further here.

---

**Brief path:** `.ai/specs/briefs/2026-08-22-run-broker-cli-stall.md`

**The facts that most constrain the design:**

1. The stall is caused by `brokered-session.ts:100`'s poll-timer `unref()` combined with
   `spawnBroker`'s (correct) `proc.unref()` — once the first `ctl.sock` connect attempt fails
   fast (a normal startup race, since the broker hasn't bound its socket yet), **nothing in the
   one-shot CLI process is left ref'd**, so Node exits 0 via empty-loop drain, mid-run, with both
   the broker and mock backend still alive.
2. This is safe today only on the server/cockpit path because `cezar serve` has its own,
   unrelated ref'd HTTP listener (`server/server.ts:7149`) keeping that process alive regardless —
   the one-shot CLI has no equivalent, and the origin spec (P4 in
   `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`) was written and verified only for
   that server scenario.
3. The acceptance criteria for this task are not new inventions — they're already stated
   verbatim in canonical todo `c895a348-4bee-4a81-89ab-a62788a6a118`, which is already attached to
   this task; no competing branch or spec is in flight.
4. Do not conflate this with the *different*, already-fixed bug documented at
   `src/index.ts:228-243` (unreachable `run-broker` subcommand) — that one left an empty spool;
   this one has a spool with a valid startup line, proving the broker itself started correctly.
