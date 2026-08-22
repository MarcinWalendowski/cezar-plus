# Missing session resume verification

**Status: spec written 2026-08-22. The code fix is already shipped; this spec covers what is
not done.** Gathered in `.ai/specs/briefs/2026-08-22-missing-session-resume.md`, whose central
claim was re-verified against the repository rather than taken on trust (see Problem).

## TLDR

The task this spec was opened for asks for a fix that **already exists on `origin/main`**.
Commit `373b1b10` ("fix: never-persisted resumed session fails its step permanently")
implements spec `.ai/specs/2026-08-22-resume-fresh-session-fallback.md` in full: both helpers
are wired at all four call sites, the fallback is visible as durable `note` events, and three
regression tests drive it. `git merge-base --is-ancestor 373b1b10 origin/main` returns 0, and
the code is still present at the current tip `c1ccbe79`. The task's context line ("its worktree
has `isMissingSessionRejection` and `claudeSessionTranscriptExists` written but UNWIRED and
unused, Phases 2-4 unimplemented") is **stale**; it described the branch mid-implementation, and
this worktree is 71 commits behind, so its own files still show the defect.

So this spec does not re-specify the fix. It specifies the four things that are genuinely
outstanding, each of which is a real gate the prior work did not pass:

1. This worktree is stale at `2778fd52` and must be brought current, or shipping this branch
   would revert the fix.
2. The prior commit's own gate was **not literally green**: 5660 passed / 1 skipped / **1
   failed**. Green must be measured, not inherited as an assumed flake.
3. The regression tests have never been proven to **fail without the fix**. A test that passes
   in both directions proves nothing, and this is exactly what the task's fourth acceptance
   criterion asks for.
4. **No runtime E2E has ever run.** The prior spec flagged this itself as its Verification item
   7 and marked the work QA-needed. That is still true, and it is the only reason this defect
   cannot be called closed.

Plus record cleanup: no KB entry closes this defect, the domain index does not mention it, and
the tracker rows are in an inconsistent state.

## Problem

### What was measured, twice

Cezar mints a session id with `randomUUID()` and persists it **before** the backend has created
any conversation for it. A mid-step kill therefore leaves a persisted id with nothing on the
other end, and the next resume hands it to `--resume`, which the CLI rejects.

- Workspace run `232ad6d4-58a5-421e-941f-5c24bd5a8452` lost its `commit-push` step this way
  after a restart resumed an id whose transcript never existed.
- Owner-reported run `b3b5719c-ccf6-445c-9b97-39dd7eaf077e` hit the continuation path:
  session `4d357600-6bde-493c-a7bf-f6057f469e40` timed out, then `continue-1` and `continue-2`
  both failed with `claude CLI exited with code 1 - No conversation found with session ID:
  4d357600-…`, and the session failed for good.

### Why this spec is not a re-implementation

The brief's claim that the fix is already delivered was checked directly against the code, not
inferred. Every one of the task's four acceptance criteria is satisfied in source on
`origin/main`:

| Acceptance criterion | Where it is satisfied on `origin/main` |
| --- | --- |
| Existence checked before resume; a miss starts fresh | `run.ts:5113` (chain step) and `run.ts:3684` (continuation), both calling `claudeSessionTranscriptExists` (`claude-cli-runner.ts:825`) |
| Rejection classified as recoverable, retried once as fresh, visible on the thread | `isMissingSessionRejection` (`agent-runner.ts:129`) at `run.ts:4338` (chain loop) and `run.ts:3831` (continuation); each emits a `note` plus a `run.step.resumed_after_missing_session` metric |
| The two helpers WIRED into `run.ts` continuation, or deleted | Wired, not deleted. Imported at `run.ts:11` and `run.ts:22`; the continuation path uses both (`run.ts:3684`, `run.ts:3831`) |
| A regression test drives it | `packages/cezar/src/workflows/resume-missing-session.test.ts:140` (proactive), `:203` (reactive Claude), `:251` (reactive Codex) |

Reading the implementation confirms it is not a stub. The proactive check is deliberately gated
on `resumeFrom.verifyTranscript === true` rather than `resumeFrom !== undefined`
(`run.ts:5113`), because the same parameter also carries the stop-retry handle from
`.ai/specs/2026-08-20-agent-step-stopped-is-not-failed.md`; the literal gate broke
`step-stopped.test.ts`. A downgrade rebuilds `userPrompt` from the step's own template rather
than reusing the frozen restart-continuation prompt (`run.ts:5122-5126`), which is what stops a
recovered step from running contextlessly. `claudeSessionTranscriptExists` scans every project
directory after the slug fast path misses and **fails open** on an unreadable projects dir
(`claude-cli-runner.ts:836-853`), because a false "exists" reproduces the bug while a false
"missing" only costs a needless fresh session. The one-shot bound on the continuation retry is
explicit: the re-entry passes `retriedMissingSession = true` positionally (`run.ts:3877`).

**Nothing here needs rewriting.** What follows is what the prior work did not do.

### The four real gaps

**Gap 1: the worktree is stale.** `HEAD` is `2778fd52`, 71 commits behind `origin/main`. The
files in this worktree still contain the pre-fix code. Any commit made from here without
updating first ships a revert of `373b1b10`.

**Gap 2: the gate was not green.** `373b1b10`'s own commit message records `5660 passed / 1
skipped / 1 failed`. The failure is `packages/cezar/src/knowledge/catalog.test.ts:270`, "stays
under 40ms CPU and 2MiB resident per MiB of scanned corpus" (the C18 performance budget). The
test itself already argues it uses CPU time precisely to drop scheduler wait
(`catalog.test.ts:293-319`), which weakens, though does not refute, the "ambient load" excuse
the commit gives. This is untouched by the fix, but "gates green" was claimed while one test
was red, and per AGENTS.md a red gate is red until measured otherwise.

**Gap 3: the regression tests were never proven red without the fix.** The task's fourth
acceptance criterion is explicit that the test must distinguish the two states. That
red/green proof was never recorded.

**Gap 4: no runtime E2E.** The prior spec's Verification item 7 says so in its own words: "no
live re-run of `232ad6d4` itself", "Mark this QA-needed against a real kill". Nothing has run
since. Critically, classification is **string-matched** against free-text CLI output, with no
machine-readable code on either backend (`agent-runner.ts:117-121` says so). If a `claude` or
`codex` release rewords its rejection, the fallback silently stops working and this defect
returns in exactly its measured form. Nothing currently detects that.

## Solution

Four independently shippable phases, none of which changes the shipped recovery logic:

1. **Rebase and re-baseline.** Bring the worktree current so the branch adds to the fix instead
   of reverting it, and confirm the wiring is present after the update.
2. **Gates to literal green.** Run the full suite and settle `catalog.test.ts` C18 with a
   measurement rather than an assertion of flakiness.
3. **Prove the regression coverage, then run the runtime E2E.** Revert-and-rerun for red/green,
   then drive the real engine end to end through the mock CLI, then probe the **real** installed
   `claude` and `codex` binaries for the exact rejection strings the classifier depends on.
4. **Close the record.** Update the prior spec's status in place, write the durable KB entry,
   correct the domain index, and reconcile the tracker.

Phase 3 also adds the one piece of **new code** this spec justifies: a contract test that pins
the rejection strings against the installed CLIs, so a future reword can be caught instead of
silently disabling the fallback. That is the single genuine hole in the shipped work. The test
is **opt-in behind `CEZ_LIVE_CLI_CONTRACT=1` and skipped by default** — it spawns real vendor
processes, and `AGENTS.md:24`/`:237` forbid putting that in the fast unit gate — so it is a
one-command check plus a cadence, **not** CI coverage. See Phase 3c.

## Architecture

No architectural change. For the reader's orientation, the shipped design has two independent
defenses, and this spec verifies each separately:

```
  restart / continue
        |
        v
  [ proactive ]  claude only, gated on resume.verifyTranscript
   transcript?  --- no --> mint fresh id, rebuild step prompt,
        |                  note "no transcript for the recorded session"
       yes
        |
        v
   spawn CLI with --resume
        |
        v
  [ reactive ]   claude + codex, one shot per step
   rejected? --- isMissingSessionRejection --> fresh id, note + metric
        |                                      run.step.resumed_after_missing_session
        no
        |
        v
     normal turn
```

The proactive layer is Claude-only by prior decision: Codex overwrites its placeholder id after
a real session event, and OpenCode never resumes by id at all
(`opencode-server-runner.ts` bootstrap always issues `POST /session`), so it is characterized
rather than changed. **Codex proactive parity is explicitly out of scope here** and is named in
Risks; the reactive layer already covers Codex at the cost of one wasted spawn.

## Phases

### Phase 1: Rebase this worktree onto `origin/main`

Independently shippable: leaves the tree at the shipped fix with no behavior change.

1. **Clear the tree first, then rebase.** `git rebase` refuses to start here: the two local
   `.ai/specs/` files are staged but uncommitted, and the bare command fails with `error: cannot
   rebase: You have unstaged changes. error: additionally, your index contains uncommitted
   changes.` (measured on this worktree, 2026-08-22). So either `git add -A .ai/specs && git
   commit -m 'docs: spec for missing-session resume verification'` and then `git fetch origin &&
   git rebase origin/main`, or `git stash push -u -- .ai/specs`, rebase, and `git stash pop`.
   Committing first is preferred — it is the commit this branch ships anyway. Conflicts are not
   expected either way, since only `.ai/specs/briefs/…` and this spec are local.
2. Confirm the wiring survived the update by grep, not by memory:
   `rg -n 'isMissingSessionRejection|claudeSessionTranscriptExists|verifyTranscript' packages/cezar/src`
   must show the four call sites listed in Problem.
3. Record the resolved AC #3 answer explicitly: the helpers are **wired**, so the "or deleted"
   branch of that criterion does not apply.

**Done when:** `git merge-base --is-ancestor 373b1b10 HEAD` returns 0 and the grep shows all
four sites.

### Phase 2: Gates to literal green

1. Run **all five** gates AGENTS.md → "Validation" (`AGENTS.md:225-237`) prescribes before any
   commit or PR, in this order. Phase 3c adds a committed test file and the downstream steps
   commit, push and deploy, so the abbreviated two-command list is not enough:

   ```bash
   npm run typecheck    # tsc --noEmit (api-client + server + web)
   npm test             # vitest: server + cockpit unit suites
   npm run test:unit    # node:test: packages/cezar/test/unit/
   npm run build        # tsc → dist/, vite → web/dist/, then the check:pack tarball gate
   npm run test:package # packs/installs the tarball and exercises the built CLI
   ```

   `test:package` requires a completed `build` (it packs the tarball), so the order is load-bearing.
   Run all five under the scrubbed environment AGENTS.md prescribes (see
   `.ai/specs/2026-08-21-npm-test-gate-environment-scrub.md`). Note that `test:unit` and
   `test:package` are `node --test` runs (`packages/cezar/package.json:39-40`) and load no
   `vitest.setup.ts`, so the manual env scrub applies to them in full rather than being handled
   for you. There is no lint config in this repo; say so rather than reporting a lint pass that
   did not happen.
2. If `catalog.test.ts:270` (C18) fails again, do **not** wave it through a second time. Run
   that file alone on an otherwise idle box:
   `npm test -- packages/cezar/src/knowledge/catalog.test.ts`, never `npx vitest`, which fetches
   an unpinned version off the registry (`AGENTS.md:239-242`). Record the measured ms/MiB.
   Then one of:
   - it passes in isolation: record the number and the load condition that reproduces the
     failure, and leave the budget alone;
   - it fails in isolation: that is a real regression in index build cost and gets its own todo,
     with this run reporting the suite as red and saying so plainly.
3. Quote the actual pass/fail/skip counts in the handoff. Do not restate the prior commit's
   numbers as if freshly measured.

**Done when:** a suite result measured in this session is reported verbatim, green or red.

### Phase 3: Prove the coverage, then run the E2E

**3a. Red/green proof (satisfies AC #4).** A regression test that never fails without the fix
is not a regression test. On a scratch commit that is discarded afterwards, disable each defense
in turn and confirm the matching case goes red:

- Force `claudeSessionTranscriptExists` to `return true` unconditionally, then run
  `resume-missing-session.test.ts -t '(a) proactive'`. Expect **fail**.
- Force `isMissingSessionRejection` to `return false`, then run the same file's `(b)` and `(c)`.
  Expect **fail**.
- Restore, rerun, expect all three green.

Record the observed failure messages. `git stash`/`git checkout --` the scratch changes; nothing
from this step is committed.

**3b. Runtime E2E through the real engine.** The lever already exists and was never used:
`MOCK_CLAUDE_REJECT_RESUME=1` (`packages/cezar/scripts/mock-claude.mjs:25-35`, added by
`373b1b10`) makes the mock CLI emit `No conversation found with session ID: <id>` on stderr
before any turn starts, and `MOCK_CODEX_REJECT_RESUME=1` is the Codex-side equivalent. Under
`CEZ_DRY_RUN=1` this exercises the real cezar engine, real process spawn, real store and real
event rail, which is what the vitest cases do not fully cover.

**Two preconditions, both of which silently produce a vacuous pass if skipped.** Neither is
optional; get them wrong and the run goes green having never triggered a single rejection.

- **`CEZ_DRY_RUN=1` swaps in a mock for `claude` only** (`claude-cli-runner.ts:127-131`) and for
  `pi` (`pi-runner.ts:52`). **There is no codex dry-run branch**: `resolveCodexExecutable` is
  `override ?? process.env.CEZ_CODEX_BIN ?? 'codex'` (`codex-app-server-transport.ts:19-21`, and
  the same fallback in `backend-detect.ts:68`), so under `CEZ_DRY_RUN=1` the Codex leg spawns the
  **real** `codex` binary, which does not know `MOCK_CODEX_REJECT_RESUME` and ignores it. The
  Codex leg therefore additionally requires
  `CEZ_CODEX_BIN=<repo>/packages/cezar/src/core/__fixtures__/codex/mock-codex-app-server.mjs`,
  the same fixture path `resume-missing-session.test.ts:16-23` and `run.test.ts:2315` already use.
  That fixture rejects **`thread/resume` only, never `thread/start`**
  (`mock-codex-app-server.mjs:48-54`), which is what makes a fresh-session fallback able to
  succeed after the rejection.
- **Neither `MOCK_` flag reaches the spawned child on its own.** `buildChildEnv`
  (`agent-env.ts:365-391`) is an allowlist: `MOCK_CLAUDE_REJECT_RESUME` is not `CEZ_`-prefixed,
  not a backend or cloud prefix, and appears in neither `BASE_ALLOW_NAMES` nor
  `BASE_ALLOW_PREFIXES`, so both flags are **dropped** unless explicitly named in
  `CEZ_ENV_PASSTHROUGH`. Set
  `CEZ_ENV_PASSTHROUGH=MOCK_CLAUDE_REJECT_RESUME,MOCK_CODEX_REJECT_RESUME` for both legs. This is
  exactly what `recover-session-failure.test.ts:33-34` does, and what the prior spec called out at
  its lines 464-465.

Drive a real two-step workflow through the cockpit or `cezar` CLI, not vitest:

- **Reactive:** run with `MOCK_CLAUDE_REJECT_RESUME=1`, seeding a decoy transcript so the
  proactive check passes and the rejection is what fires. The **primary** assertion is that
  exactly one `run.step.resumed_after_missing_session` metric event was emitted. A run that
  reaches terminal success with **zero** such events is a **failed** E2E, not a pass, because it
  means the lever never fired (a dropped env var, a real binary, a decoy transcript that was
  never read) and nothing was actually exercised. Only once that event is present do the
  secondary assertions mean anything: terminal status is not `failed`; the `note` "the session
  was never confirmed to exist; retrying with a fresh session" is visible on the thread; the
  step's `sessionId` changed; the remaining step still ran.
- **Proactive:** kill a run mid-step (`SIGKILL` the agent process), confirm no
  `<sessionId>.jsonl` exists under `~/.claude/projects`, then `cezar` restart-recover it.
  Assert the note "no transcript for the recorded session - starting fresh", a changed
  `sessionId`, and that the delivered prompt is the step's own template rather than the
  restart-continuation prompt.
- **Isolation requirement:** run against a scratch project and a dedicated
  `CEZ_DATA_DIR`/`CLAUDE_CONFIG_DIR`, never the live cockpit data dir. This box has real runs
  in flight; a `SIGKILL` aimed at the wrong pid ends someone's work.

**3c. Real-CLI string contract (new code).** Because classification is string-matched, add a
test that pins it against the installed binaries and skips cleanly when they are absent. **The
two halves are not symmetric, and the obvious invocation is wrong for both**. The classifier
matches what cezar's *own* spawns produce (`agent-runner.ts:129-133`), not what an interactive
session prints:

- **Claude half.** `claude --resume <uuid>` is the *interactive* form; cezar never spawns it that
  way. Reproduce the headless argv `buildClaudeArgs` actually builds
  (`claude-cli-runner.ts:730-752`): `--input-format stream-json --output-format stream-json
  --verbose --permission-mode bypassPermissions --resume <random-uuid>`, in a throwaway cwd, with
  **stdin closed** and a **hard per-invocation timeout**. Both matter: a headless claude with an
  open stdin waits for input and will hang the gate.
- **Codex half.** There is **no codex CLI "resume equivalent"** to invoke. `no rollout found for
  thread id` is a **JSON-RPC error message** the `codex app-server` returns in response to a
  `thread/resume` request (`codex-app-server-runner.ts:368-370`; the fixture mirrors it at
  `mock-codex-app-server.mjs:52`). So this half must spawn the real app-server via
  `resolveCodexExecutable` / `spawnCodexAppServer` (`codex-app-server-transport.ts:19-31`) and
  send `thread/resume` with an impossible `threadId`, asserting against `error.message`, not
  against process stderr.
- Assert `isMissingSessionRejection(backend, capturedMessage) === true` for each.

**Where it lands, and why it must be off by default.** The file is
`packages/cezar/src/core/missing-session-string-contract.test.ts`, next to the classifier it
pins (`agent-runner.ts:129`) and inside the same `packages/cezar/vitest.config.ts` project as
the other `src/core/*.test.ts` runner suites.

It is gated `describe.skipIf(process.env.CEZ_LIVE_CLI_CONTRACT !== '1')` and is therefore
**skipped in a default `npm test`**. Two repo rules make that mandatory, not stylistic:

- `AGENTS.md:237` — "`npm test` and `npm run test:unit` are the fast unit gate: **no server, no
  browser. They must stay that way.**" The Codex half spawns a real `codex app-server`, which is
  literally a server.
- `AGENTS.md:24` — "Features that widen exposure or cost (network, other processes) are
  **opt-in behind a `CEZ_*` flag, off by default**."

There is also **no precedent** to lean on: every `spawn`/`execFile` in the vitest suite today
targets a mock, a fixture, or `process.execPath` (`claude-cli-runner.test.ts:31`,
`codex-app-server-runner.test.ts:19`, the `*-cli-wiring.test.ts` family). Nothing in this repo
shells out to a vendor binary under test, and this spec is not the place to establish that as a
default. A binary-presence guard alone does **not** substitute for the flag: both
`/usr/bin/claude` and `/usr/bin/codex` are present on this box **and logged in** (codex OAuth
completed 2026-08-22, per `domains/cezar.md`), so `skipIf(binary missing)` would never fire here
and the default gate would really spawn both vendors. `CEZ_LIVE_CLI_CONTRACT` is a new `CEZ_*`
var, so per `AGENTS.md:29` it must be added to `.env.example` in the same commit.

**Neither invocation costs tokens**, which is the concrete answer to the quota worry: the claude
half passes `--resume <random-uuid>` for an id that has no transcript, and the CLI rejects it
during session load, before any turn is started or any model request is made; the codex half
sends `thread/resume` for an impossible `threadId`, which the app-server answers as a local
JSON-RPC error from its own rollout store, again with no model call. Both failures are the exact
strings under test, so a run that *did* reach the model would be a failing test, not a silent
cost.

**Phase 3c runs it explicitly**, once, with `CEZ_LIVE_CLI_CONTRACT=1 npm test --
packages/cezar/src/core/missing-session-string-contract.test.ts`, and records the literal output
in the handoff. Log any skip and its reason rather than passing silently: a silent pass on a
skipped contract is the failure mode this whole spec exists to catch.

This is the only new production-adjacent artifact this spec adds, and its mitigation of "a
future release could reword either string and silently disable the fallback" is **partial, not
complete**. Being opt-in is what keeps it out of the fast gate, and the price of that is that it
detects a reword only when somebody runs it. Nothing here schedules it. What it buys is a
one-command check that did not exist before, so the closing move is a cadence, not CI coverage:
run it as part of any `claude` or `codex` version bump, and Phase 4 files a follow-up for a
scheduled job that runs it on a timer. Until that job exists, treat the risk as live between
runs.

**If 3b or 3c comes back red, stop here.** The shipped fix would then be broken at runtime
despite green unit tests, which is a new defect and not a verification result: report it plainly
with the run ids and event excerpts, and do **not** proceed to the commit/push/deploy steps that
follow this spec.

**Done when:** 3a shows red-then-green, 3b's two runs are recorded with their run ids and event
excerpts (each showing a non-zero `run.step.resumed_after_missing_session` count), and 3c is
committed and passing (or explicitly recorded as skipped, with the reason).

### Phase 4: Close the record

1. **Correct in place**, per the house rule. Edit the header of
   `.ai/specs/2026-08-22-resume-fresh-session-fallback.md`: its "gates green, QA needed" line is
   now wrong in two ways (the gate was not green, and the QA state has changed). Add a bolded
   `CORRECTED 2026-08-22` lead-in with the measured result, leaving the original text below it
   unchanged, and point at this spec.
2. **KB entry.** No entry closes this defect. `cez kb search "No conversation found with session
   ID"` returns only this task's own brief (`specs-29d520a8b772`) among 2102 lexical hits. Write
   the durable decision via `CEZ_KB_WRITE_FILE`: a persisted session id is a **hint**, not proof
   of a conversation, and both a proactive existence check and a one-shot reactive fallback are
   required because neither alone covers both paths.
3. **Domain index.** `/var/lib/cezar/loki-labs/notion-export/domains/cezar.md` "Current state"
   lists the 2026-08-22 spool defect but not this one. Add this defect with its resolved status.
   Do **not** conflate the two: the spool/exit-cross-talk defect (KB `notion-04ca960e6408`,
   `cezar.md:12`, exit code 143) is a distinct same-day failure on the same run `232ad6d4` and
   remains open.
4. **Tracker.** The brief found source delivered while todo `84861218-03fd-47fa-8312-722543cd6e63`
   (the task context cites `84624218`; both were reported open) stayed open, and `cezar todo list`
   reports **"no todos filed"** in this environment, which was re-confirmed in this session. Close
   the rows if they can be reached; if the CLI still cannot see them, say so plainly in the
   handoff rather than reporting a sync that did not happen.
5. **Changelog entry** for the corpus, dated, describing the verification rather than a new fix.
6. **File the follow-up that closes the Phase 3c gap.** The contract test is opt-in and nothing
   runs it on a schedule, so the reword risk stays live between runs (see Risks). File it with
   `cezar todo add "run the missing-session CLI string contract on a schedule" --project cezar
   --context "…" --acceptance "…"`, naming the two triggers that should fire it: any `claude` or
   `codex` version bump, and a periodic job. Filing it is what keeps "partial mitigation" from
   quietly reading as "mitigated".

**Done when:** a fresh `cez kb search` finds the new entry (a corpus write only counts once it
is findable) and the prior spec header no longer claims an unqualified green gate.

## Data models

No new persisted models. Restated for the reviewer, all existing:

- `ChainResumePoint.resume` (`run.ts:848`):
  `{ sessionId: string; profileId?: string; prompt: string; verifyTranscript?: true }`.
  `verifyTranscript` is set **only** by `chainResumeAt` (`run.ts:2102`) and never by
  `stopResume`. This discriminant is load-bearing and must not be widened to all resumes.
- `RunStep.sessionId` is rewritten in place on a downgrade
  (`store.updateStep(runId, stepId, { sessionId: spawnSessionId })`), because Claude emits no
  session event to correct the record later.
- The chain-loop reactive path resets the step to
  `{ sessionId: undefined, status: 'pending', error: undefined }` before retrying the same index.

## API contracts

No HTTP surface changes. The observable contracts this spec verifies:

- `isMissingSessionRejection(backend: RunnerId, message: string): boolean`
  (`agent-runner.ts:129`). `claude` matches `/No conversation found with session ID/i`; `codex`
  matches `/no rollout found for thread id/i`; every other backend returns `false`.
- `claudeSessionTranscriptExists(claudeHome: string, cwd: string, sessionId: string):
  Promise<boolean>` (`claude-cli-runner.ts:825`). Fails **open** (returns `true`) when the
  projects directory cannot be read.
- Event rail, which is what "visible on the thread rather than silent" means concretely:
  - `note` "no transcript for the recorded session - starting fresh" (proactive downgrade);
  - `note` "<message> - the session was never confirmed to exist; retrying with a fresh session"
    (reactive retry);
  - `metric` `run.step.resumed_after_missing_session`, carrying `runId` and `backend` (and
    `workflow` on the chain-loop path).

Any change to those two strings or the metric name breaks dashboards and the tests above, so
they are treated as a contract, not as log text.

## Risks

- **String matching is the whole classifier.** A CLI reword disables the fallback silently and
  the defect returns exactly as measured. Phase 3c is a **partial** mitigation only: it pins
  both strings and gives a one-command check, but it is opt-in behind `CEZ_LIVE_CLI_CONTRACT=1`
  (it must be — it spawns vendor processes, and `AGENTS.md:24`/`:237` keep those out of the fast
  gate), so it detects a reword only when somebody runs it, and nothing in this spec schedules
  it. **Between runs the risk stays live.** Closing it is a cadence: run 3c on every `claude` or
  `codex` version bump, and the Phase 4 follow-up for a scheduled job is what would make the
  detection automatic. Do not read 3c as CI coverage.
- **A dangerous E2E.** Phase 3b's proactive case requires killing an agent mid-step on a box
  that runs real work. Wrong pid, or a shared `CEZ_DATA_DIR`, destroys someone's run. The
  isolation requirement in 3b is not optional.
- **Inheriting the flake.** Waving C18 through a second time is how a real performance
  regression gets laundered into a known flake. Phase 2 forces a measurement instead.
- **Rebase reverting the fix.** Committing from this stale worktree without Phase 1 ships a
  revert of `373b1b10`. Phase 1 is first for that reason.
- **Codex has no proactive check**, so a Codex resume of a never-created rollout still costs one
  failed spawn before recovering. Accepted, not fixed here: the reactive layer covers it, and
  adding a rollout-existence probe is new scope this task did not ask for.
- **Fail-open on an unreadable projects dir** means a doomed resume can still reach the CLI.
  Deliberate, and the reactive layer is the second net underneath it.
- **A false "already done" reading.** The task context says the helpers are unwired; the code
  says otherwise. Anyone reading the task text without checking `origin/main` will either
  re-implement a shipped fix or revert it. This spec exists partly to stop that.

## Verification

Concrete and executable. Each item names what is run and what answer counts.

1. **Rebase proof.** `git merge-base --is-ancestor 373b1b10 HEAD; echo $?` prints `0`, and
   `rg -n 'isMissingSessionRejection|claudeSessionTranscriptExists' packages/cezar/src/workflows/run.ts`
   lists the continuation sites (`3684`, `3831`) and the chain sites (`4338`, and the
   `claudeSessionTranscriptExists` chain check — `5113` is the `verifyTranscript` gate, `5115`
   the call it guards; the AC table above cites the gate line, so read the two as one site).
2. **The five gates, from the repo root.** Not from `packages/cezar` — the workspace scripts are
   not the same command, and running the narrow one is how a type error ships. Root
   `npm run typecheck` is `typecheck:contract && typecheck:client && typecheck:server &&
   typecheck:web`; inside `packages/cezar` it is only `tsc --noEmit -p tsconfig.test.json`, so a
   `packages/web` or `api-client` break passes the narrow one silently. Same for `npm test`:
   root is `vitest run` across the `cezar` + `api-client` + `web` projects
   (`vitest.config.ts`), the package-local one covers `cezar` alone. Run all five of
   `AGENTS.md:225-235` **from the repo root**, in order, each exiting 0:
   `npm run typecheck`, `npm test`, `npm run test:unit`, `npm run build`, `npm run test:package`
   (the last needs the completed `build`, which packs the tarball).
3. **Full suite counts.** For the root `npm test` above, run it under the scrubbed environment
   and report the literal counts. Green means 0 failed, not "0 failed excluding the known one".
4. **C18 in isolation.** `npm test -- packages/cezar/src/knowledge/catalog.test.ts` on an idle
   box; record the measured ms/MiB against the 40 ms budget. Through `npm`, never `npx vitest`
   (`AGENTS.md:239-242`): vitest is a pinned devDependency here and `npx` reaches past it to an
   unpinned registry copy, making the measurement a different run than the gate's.
5. **Red/green proof (AC #4).** With `claudeSessionTranscriptExists` stubbed to `true`,
   `resume-missing-session.test.ts -t '(a) proactive'` **fails**; with
   `isMissingSessionRejection` stubbed to `false`, `(b)` and `(c)` **fail**; unstubbed, all
   three pass. Capture the failure output for each.
6. **Reactive E2E.** A real `CEZ_DRY_RUN=1` run with `MOCK_CLAUDE_REJECT_RESUME=1` against an
   isolated data dir, with `CEZ_ENV_PASSTHROUGH=MOCK_CLAUDE_REJECT_RESUME,MOCK_CODEX_REJECT_RESUME`
   set so the flag survives `buildChildEnv`. **The load-bearing assertion is exactly one
   `run.step.resumed_after_missing_session` event**. Check it first and treat its absence as a
   failure. "Terminal status is not `failed`" passes **vacuously** when the flag never arrived and
   no rejection ever happened, so it counts only alongside that event; a clean green run with zero
   such events is a failed E2E, not a pass. Then confirm the retry `note` in the persisted rail.
   Repeat with `MOCK_CODEX_REJECT_RESUME=1` **plus**
   `CEZ_CODEX_BIN=<repo>/packages/cezar/src/core/__fixtures__/codex/mock-codex-app-server.mjs`,
   since `CEZ_DRY_RUN=1` does not mock codex and the real binary ignores the flag. Record both
   run ids.
7. **Proactive E2E.** `SIGKILL` an agent mid-step in the isolated environment, confirm
   `find ~/.claude/projects -name '<sessionId>.jsonl'` is empty, restart-recover, and observe
   the downgrade note, a changed `sessionId`, and the step's own prompt (not the
   restart-continuation prompt) in the delivered message.
8. **Real-CLI contract.** `CEZ_LIVE_CLI_CONTRACT=1 npm test --
   packages/cezar/src/core/missing-session-string-contract.test.ts` passes against the installed
   `claude` and `codex`, or reports an explicit skip with the reason. A silent pass on a missing
   binary does not count. Separately confirm the default is safe: a plain root `npm test` (item
   2) reports that file's tests as **skipped**, never as run. And `grep -n CEZ_LIVE_CLI_CONTRACT
   .env.example` matches, since `AGENTS.md:29` requires a new `CEZ_*` var to be documented in the
   same commit.
9. **Record.** `cez kb search` finds the new entry; the prior spec's header carries the
   `CORRECTED 2026-08-22` lead-in; `domains/cezar.md` names this defect separately from the
   spool defect.

**Not covered, flagged rather than skipped:** no reproduction against the original production
runs `232ad6d4` or `b3b5719c` themselves. Their worktrees are gone and their workspace NDJSON is
not present in this project's run directory (the brief could not find it either). Items 6 and 7
reconstruct the failure shape deterministically instead; that substitution is deliberate and is
the closest thing to an in-the-wild confirmation available now.

## Sources read

Verified in this session, not inherited from the brief:

- Brief: `.ai/specs/briefs/2026-08-22-missing-session-resume.md`
- Prior spec: `.ai/specs/2026-08-22-resume-fresh-session-fallback.md` (header, Phases,
  Verification) and its brief `.ai/specs/briefs/2026-08-22-resume-fresh-session-fallback.md`
- Commits: `373b1b10` (the fix, 10 files, +1581/-33), `c1ccbe79` (current `origin/main` tip, the
  retry-context fix, spec `.ai/specs/2026-08-22-failed-turn-reads-as-done.md`), `2778fd52` (this
  worktree's stale HEAD)
- Code on `origin/main`: `packages/cezar/src/core/agent-runner.ts:110-133`,
  `packages/cezar/src/core/claude-cli-runner.ts:796-855`,
  `packages/cezar/src/workflows/run.ts:839-848, 2085-2105, 3302-3330, 3676-3700, 3826-3880,
  4330-4356, 5099-5145`, `packages/cezar/scripts/mock-claude.mjs:25-35`,
  `packages/cezar/src/knowledge/catalog.test.ts:250-330`
- Tests: `packages/cezar/src/workflows/resume-missing-session.test.ts:43, 140, 203, 251`,
  `packages/cezar/src/workflows/recover-session-failure.test.ts:46, 92`,
  `packages/cezar/src/core/claude-cli-runner.test.ts:601-680`
- Adjacent decisions: `.ai/specs/2026-08-20-agent-step-stopped-is-not-failed.md`,
  `.ai/specs/2026-08-20-chain-integrity-restart-and-continuation.md`,
  `.ai/specs/2026-08-21-npm-test-gate-environment-scrub.md`
- Corpus: `/var/lib/cezar/loki-labs/notion-export/domains/cezar.md` (Current state, lines 12-20);
  `cez kb search` for this defect and for the rejection string

**Could not find:** no KB decision entry closing this defect (the only match is this task's own
brief, `specs-29d520a8b772`); no machine-readable provider error code for a missing session on
either backend; no runtime E2E artifact from any prior run; no todos visible to
`cezar todo list`, which reports "no todos filed" despite the brief recording two open rows.
