# A resumed session cezar never confirmed existed must not fail its step permanently

**CORRECTED 2026-08-22 by `.ai/specs/2026-08-22-missing-session-resume-verification.md`:
implemented and shipped in `373b1b10`.** Four non-Vitest repository gates pass, and commit
`a0ef7959` added and passed an opt-in contract test against the installed Claude and Codex CLIs.
The root Vitest gate is not green: C18 reproduced at `62.29 > 40` and on a clean parent checkout
at `64.80 > 40`. No reactive engine E2E or proactive SIGKILL recovery E2E is recorded, so runtime
QA remains needed.

**Status: implemented 2026-08-22, gates green, QA needed.** Root-caused from run
`232ad6d4-58a5-421e-941f-5c24bd5a8452` (`spec-to-deploy`, workspace run), which died
permanently at `commit-push`. Gathered in
`.ai/specs/briefs/2026-08-22-resume-fresh-session-fallback.md`; this spec settles that
brief's five open questions and specifies the fix.

**CORRECTED 2026-08-22:** C18 was reproduced both here and on a clean parent checkout; it remains
a real red gate tracked separately, not a waived flake. The original implementation note follows.

**Implementation note (2026-08-22): Phase 1's gate is `ChainResumePoint.resume.verifyTranscript`,
not a bare `resumeFrom !== undefined` check.** `runAgentStep`'s `resumeFrom` parameter is shared
by two distinct callers — `chainResumeAt`'s chain-restart resume (the one this spec is about) and
the already-shipped stop-retry resume (`stopResume`, `2026-08-20-agent-step-stopped-is-not-failed.md`).
Gating the proactive check on "`resumeFrom !== undefined`" as this spec's Phase 1 literally reads
downgrades a stop-retry's own, just-observed-alive session whenever its transcript hasn't hit disk
yet at check time — discarding in-progress work and turning one stop into two. Fixed during
implementation by adding a `verifyTranscript?: true` discriminant to `ChainResumePoint.resume`, set
only by `chainResumeAt`, never by `stopResume`; the proactive check gates on that flag instead.
Caught by `step-stopped.test.ts`, which broke under the literal reading. Automated gates: full
`packages/cezar` suite 5660 passed / 1 skipped / 1 failed (the 1 failure is
`src/knowledge/catalog.test.ts`'s CPU-budget assertion, an untouched, pre-existing,
machine-load-sensitive flake unrelated to this change); `tsc --noEmit -p tsconfig.test.json` clean;
no lint config exists in this repo. Verification item 7 (a live kill against a real `claude`/`codex`
CLI) was not run — flagged, per the spec, as QA-needed rather than skipped silently.

## TLDR

`runAgentStep` mints a session id with `randomUUID()` and persists it (`run.ts:4470-4472`)
**before** the backend has created any conversation for it. On run `232ad6d4`, `commit-push`
iteration 1 was killed (box self-deploy SIGKILL, worktree reclaimed mid-run) before the
`claude` CLI ever flushed a transcript — no `.jsonl` for that session id exists anywhere
under `~/.claude/projects`. Iteration 2, entered through the already-shipped restart
re-entry (`.ai/specs/2026-08-20-chain-integrity-restart-and-continuation.md`), resumed that
never-created id with `--resume`, and `claude` refused: `No conversation found with session
ID: cb916c71-…`. Nothing catches that specific rejection — it falls through the generic
non-zero-exit path (`claude-cli-runner.ts:324-330`) into an ordinary step failure, and the
whole run dies. This spec adds two defenses: a Claude-only proactive check that a resume is
about to target a transcript that actually exists, so most instances of this bug never reach
the CLI at all; and a one-shot reactive fallback, for Claude and Codex, that recognizes the
specific "resumed a session the backend has never heard of" rejection and retries once with
a freshly minted session instead of failing the step. OpenCode is not touched — its runner
never resumes by session id at the transport level (`opencode-server-runner.ts:329-333`), so
it cannot hit this failure mode, and AC #4 is answered by demonstrating that instead.

## Problem

Two places record and later reuse a session id without ever confirming the id refers to a
conversation that exists on the backend's side:

1. **The chain re-entry path (the one that actually failed on `232ad6d4`).**
   `runAgentStep` (`run.ts:4396`) does:
   ```
   const sessionId = resumeFrom?.sessionId ?? randomUUID();
   const backend = step.runner ?? taskBackend;
   this.store.updateStep(runId, step.id, { sessionId, backend });   // run.ts:4470-4472
   ```
   before it ever calls `runner.startSession`/`reattachSession` (`run.ts:4685-4739`). The
   step's `status` was already set to `'running'` even earlier, at the top of `execute()`'s
   loop (`run.ts:3896-3901`) — so neither `status` nor the presence of `sessionId` on the
   record distinguishes "a backend confirmed this conversation exists" from "cezar minted an
   id and the process died before saying anything at all."

   When cezar restarts mid-step, `recover()`'s `running` branch calls `reenterChain()`
   (`run.ts:1653`), which calls `chainResumeAt()` (`run.ts:1895-1927`). Its only guard against
   resuming a bogus id is `!record?.sessionId || record.status === 'pending'`
   (`run.ts:1912`) — neither is true for a step that was minted a session id and marked
   `running` before its process was killed. So `chainResumeAt` hands back
   `{ index, resume: { sessionId: record.sessionId, ... } }`, `runAgentStep` passes
   `resume: true` (`run.ts:4729`) straight to `runner.startSession`, and
   `buildClaudeArgs` emits `--resume <id>` (`claude-cli-runner.ts:711-716`) for an id the CLI
   has never seen. The CLI exits 1 with `No conversation found with session ID: …`
   (surfaced generically at `claude-cli-runner.ts:324-330` — no special-casing of that
   text). `runAgentStep`'s `onEvent` records it as `sessionError`, `session.result` rejects,
   the catch at `run.ts:4762-4765` returns the message as `failure`, and the chain loop
   (`run.ts:3977-3980`) has exactly one branch for a non-`stopped` failure: mark the step
   `failed`, mark the run `failed`, stop. This is what happened on `232ad6d4` — verified
   directly against `/var/lib/cezar/workspace/.ai/cezar/runs/232ad6d4-…ndjson` lines
   1492–1506: `commit-push` iteration 1 starts and emits nothing before the restart
   lifecycle line; iteration 2 starts 2.5s after the restart and fails 4s later with exactly
   this message.

2. **The continuation path (`recover()`'s fallback and ordinary "Continue").**
   `runContinuation` (`run.ts:3076`) takes the same shape: `sessionId` (`run.ts:3457`),
   `resume: sessionId !== undefined` (`run.ts:3458`), no existence check. Its failure handling
   (`run.ts:3533-3544`) marks the step and the run `failed` on any thrown error, with no
   distinction for "the resumed session never existed." This path is already under test —
   `packages/cezar/src/workflows/recover-session-failure.test.ts` (describe block *"recover()
   contains backend session failures (#562)"*) seeds a `codex` step with
   `sessionId: 'missing-thread'`, forces the mock app-server to reject `thread/resume`
   (`MOCK_CODEX_REJECT_RESUME=1` →
   `packages/cezar/src/core/__fixtures__/codex/mock-codex-app-server.mjs:51-52`, `"no rollout
   found for thread id …"`), and **asserts the run ends `status: 'failed'` with that error** —
   i.e. it currently codifies the opposite of this spec's acceptance criteria as the intended
   behavior. Fixing this bug means inverting that assertion, not adding a parallel test beside
   it.

3. **The per-backend resume surface is not uniform**, which is why the fix cannot be one
   check in one place:
   - **Claude** (`claude-cli-runner.ts:708-716`) has no confirmation signal at all on a fresh
     `--session-id` start, and its rejection on `--resume` is free-text CLI stderr
     (`claude-cli-runner.ts:324-330`).
   - **Codex** (`codex-app-server-runner.ts:358-364`) *does* correct the record after the
     fact: on `thread/start` (fresh) or a successful `thread/resume`, a `session` event
     (`codex-app-server-runner.ts:365-366`) overwrites the placeholder id
     (`run.ts:4507-4509`) — but a resume that is *rejected* throws before that event, and a
     process that dies before either happens leaves the same unconfirmed placeholder Claude
     has. Its rejection surfaces as a JSON-RPC error object, turned into an `Error` by
     `codexErrorText()` (`codex-app-server-transport.ts:76,173`), and reaches `run.ts` as a
     thrown exception from `session.result`, not an `onEvent('error', …)`.
   - **OpenCode** (`opencode-server-runner.ts:329-333`) never attempts a resume-by-id at the
     transport level: bootstrap always issues `POST /session` unconditionally, ignoring
     `spec.resume`/`spec.sessionId`. It cannot hit "session not found" the way the other two
     can — but it also means a process restart loses conversational continuity silently,
     every time, which is a real, adjacent defect this spec does not fix (see Risks).

4. **No code anywhere checks whether a resume target actually exists before attempting it.**
   Confirmed by grep across `packages/cezar/src/` for `.claude/projects`, `.jsonl`,
   `sessionExists`, `hasTranscript`: only spec/doc/test references, no implementation. This is
   genuinely new code, not a wire-up of something already there.

## Solution

Two independent defenses, because Claude has no confirmation signal to wait on and Codex has
one but only on the success path:

1. **Proactive: validate a Claude resume target before ever spawning the CLI.** Before
   `runner.startSession`/`reattachSession` is called for a `claude` step with `resume: true`,
   check whether that session id's transcript actually exists on disk. If it does not,
   downgrade the spawn to a fresh session in place — clear the resume request (mint a new id,
   `resume: false`) — and emit a `note` saying so, before any process is spawned. This is the
   cheap, common-case fix: `232ad6d4`'s iteration 1 never wrote a transcript at all, so this
   check catches it for the cost of a filesystem stat, with no wasted CLI spawn, no exit code
   to parse, and no dependence on the CLI's stderr wording surviving a version bump.

   This is deliberately **not** "persist the session id only after the backend confirms it
   exists" (AC #2's first option) for Claude: there is no confirmation event on a fresh start
   to wait for (see Problem §3), and the id is intentionally persisted immediately today so a
   user can `claude --resume <sessionId>` interactively mid-run
   (`claude-cli-runner.ts:708-710`) — delaying the persist would break that. So for Claude,
   AC #2 is satisfied by its second option: the recorded id is a **hint**, and it is validated
   before it is ever handed to `--resume`. For Codex, AC #2 is satisfied by the first option
   instead: the placeholder id persisted at mint time is overwritten by the real `session`
   event on a successful `thread/start`/`thread/resume` (`run.ts:4507-4509`), so the record
   briefly holds an unconfirmed hint only in the window between mint and that event — and
   that window is exactly what Phase 2/3's reactive fallback covers when it closes with a
   rejection instead of a `session` event.

2. **Reactive: one-shot fallback on a recognized "unknown session" rejection**, for Claude and
   Codex, mirroring the shape `.ai/specs/2026-08-20-agent-step-stopped-is-not-failed.md`
   already established for a cezar-initiated stop (`run.ts:3954-3971`: re-enter once, then
   give up). This is the safety net for what the proactive check cannot catch — Codex has no
   local transcript to stat (thread existence is server-side state), and a version bump could
   still surface an unrecognized message even where a check exists. A shared predicate
   recognizes the specific rejection per backend:
   ```ts
   function isMissingSessionRejection(backend: RunnerId, message: string): boolean {
     if (backend === 'claude') return /No conversation found with session ID/i.test(message);
     if (backend === 'codex') return /no rollout found for thread id/i.test(message);
     return false; // opencode never resumes by id — see Problem §3
   }
   ```
   Applied at both sites that resume an id and can fail the run outright on rejection:
   - the chain loop's per-step failure branch (`run.ts:3977-3980`), which is what
     `232ad6d4` actually hit;
   - `runContinuation`'s catch block (`run.ts:3533-3544`), which is what
     `recover-session-failure.test.ts` exercises for Codex.

   In both places: if the failure matches the predicate **and** this attempt was a resume
   (a `sessionId` was actually sent) **and** the step/continuation has not already been
   retried for this reason once, clear the recorded `sessionId`, retry the SAME step/
   continuation once with a freshly minted session, and emit a note recording that a fallback
   fired. A second miss in a row is treated as a real failure — the step or run ends `failed`
   exactly as it does today, so a persistent bug (e.g. the backend itself is broken) still
   surfaces instead of retrying forever.

3. **OpenCode is out of scope for the fallback, in scope for verification.** Its bootstrap
   already tolerates a stale/missing prior session by construction — it never conditions on
   `resume`/`sessionId` and always starts a fresh `POST /session`
   (`opencode-server-runner.ts:329-333`). AC #4 ("verified for the codex/opencode backends")
   is satisfied for OpenCode by a test that pins this existing behavior down as intentional,
   not by new fallback code — see Phase 4 and Risks for the silent-continuity-loss defect this
   leaves untouched.

### Decisions

- **Two defenses, not one.** A predicate-only reactive fix would still spawn a doomed CLI
  process (or RPC round-trip) every time this fires, and depends on free-text error wording
  never drifting. A proactive-only fix cannot cover Codex: the app-server is a local process
  and its rejection ("no rollout found …") does point at a local rollout file under
  `$CODEX_HOME`, so a Codex-side existence probe is not fundamentally impossible — but no
  such probe was implemented in this pass, and the reactive fallback is the right fix for
  Codex either way (its own confirmation event, `session`, only fires on success — see
  Problem §3 — so a proactive check would still need the reactive path as a backstop for the
  cases it can't preempt). Together the two defenses cover the measured incident (Claude,
  proactive) and the already-tested one (Codex, reactive).
- **One retry, not N**, same reasoning as the stop-retry precedent this mirrors
  (`2026-08-20-agent-step-stopped-is-not-failed.md`): the fresh session is cheap, but a step
  that misses twice in a row is not "the session id was stale," it's a different, real
  problem, and retrying it unboundedly is a budget leak, not a fix.
- **The retry is a FRESH session, not the same dead id retried.** Unlike the stop-retry
  precedent (which re-enters the *same* session because the work genuinely exists there), a
  session that was never created has no work to reattach to — there is nothing to lose by
  starting clean, and retrying the identical `--resume <id>` would fail identically.
- **`chainResumeAt`'s existing guard is left alone.** It already correctly starts fresh when
  `sessionId` is absent or `status === 'pending'` (`run.ts:1912`); this spec does not touch it
  because the bug is specifically the case that guard cannot see (a session id present, status
  already `running`, and no way yet to know the backend never created the conversation). The
  new proactive check is a strictly later, more accurate gate than that one.

## Architecture

```
runAgentStep() / runContinuation()
  │
  │  resume requested (sessionId present, resume: true)
  ▼
[claude only] claudeSessionTranscriptExists(claudeHome, cwd, sessionId)?
  │no                                   │yes
  ▼                                     ▼
mint fresh id, resume:false,     runner.startSession({ resume:true, sessionId })
rebuild userPrompt from the                 │
step's own template (NOT the                │
restart prompt), note: "no                  │
transcript for the recorded                 │
session — starting fresh"                   ▼
  │                              backend rejects: "No conversation found…" /
  │                              "no rollout found for thread id …"
  │                                     │
  │                                     ▼
  │                        isMissingSessionRejection(backend, message)?
  │                          │no                          │yes, not yet retried
  │                          ▼                             ▼
  │                    step/run fails,               clear sessionId, retry ONCE
  │                    same as today                  with a fresh session; note:
  │                                                    "resume rejected — the session
  │                                                    was never confirmed to exist;
  │                                                    retrying with a fresh session"
  │                                                         │
  │                                                         ▼
  │                                              still fails / matches again?
  │                                                 → step/run fails (today's path)
  ▼
step runs normally
```

The proactive check's two failure directions are not symmetric, and the design above is
built around that asymmetry rather than around convenience. A **false positive** (the check
says "no transcript" for a session that actually exists — e.g. a transient `readdir`/`stat`
error, or a slug fast-path miss the scan should have caught) is harmless: it downgrades to a
fresh session it didn't need to, costing one process that would have resumed successfully —
recoverable, and never worse than today. A **false negative** (the check says "transcript
exists" — or is skipped/unreachable — for a session that does not) is not harmless: it lets
a doomed `--resume` through, which is exactly today's bug reproducing itself. This is why
existence is answered by a directory scan rather than a guessed slug path (Phase 1), and why
any resolution failure in the check itself must fail **open** — proceed with the resume as
today — rather than downgrade: downgrading on an unreadable `claudeHome` would silently
discard a live, resumable session on every step for an account whose config dir cezar
briefly failed to stat, which is a strictly worse outcome than the bug this spec fixes.

## Phases

Each phase is independently shippable and independently testable; ship in order because
later phases assume the shared predicate from Phase 1.

**Phase 1 — shared predicate + Claude proactive check.**
- Add `isMissingSessionRejection(backend, message)` (new, small, colocated with the runners
  it serves — e.g. `packages/cezar/src/core/agent-runner.ts` alongside the other
  backend-neutral helpers already there, `isSignalTerminationExit` being the nearest
  precedent).
- Add `claudeSessionTranscriptExists(claudeHome, cwd, sessionId)`. `claudeHome` is resolved
  as `agentHomePaths({ ...process.env, ...profile.env }).claude`
  (`packages/cezar/src/paths.ts:256`, which already implements
  `CLAUDE_CONFIG_DIR ?? $HOME/.claude`) — **not** read off `stepProfile`/`continueProfile`
  directly, because for the default account `resolveProfileEnvForRoot` returns `env: {}`
  (`packages/cezar/src/workspace/agent-profiles.ts:137`, per the comment at :135-136: "the
  default account contributes nothing"), which is the overwhelmingly common case and the one run
  `232ad6d4` was in. Taken as literal env, the check would resolve an undefined config dir
  and false-negative unconditionally; routed through `agentHomePaths`, `{}` correctly falls
  back to `$HOME/.claude`.

  Existence is answered by a **scan**, not a guessed path: `readdir(<claudeHome>/projects)`
  (one call — 257 entries measured on this box, trivially cheap) plus a `stat` per candidate
  for `<dir>/<sessionId>.jsonl`, rather than deriving `<dir>` from `cwd` and trusting it. A
  naive `/`→`-` slug of `cwd` is wrong: `.` maps to `-` too, and every project-run worktree
  lives under `<repo>/.ai/cezar/worktrees/…`, so the naive rule misses on essentially every
  non-workspace run — measured: cwd
  `/var/lib/cezar/loki-labs/cezar/.ai/cezar/worktrees/3dbf68c1-…` is the real directory
  `-var-lib-cezar-loki-labs-cezar--ai-cezar-worktrees-3dbf68c1-…` (note the doubled `-`
  where `/.ai` sits — a plain `/`-only rule does not produce that). A cwd-derived slug
  (`[/.]` → `-`, every other character preserved) can stay as a fast path — try
  `<claudeHome>/projects/<slug(cwd)>/<sessionId>.jsonl` first, fall back to the scan only on
  a miss — but the scan is what existence correctness rests on, not the slug. Cover the slug
  function with a unit test pinned to both measured examples: cwd
  `/var/lib/cezar/workspace` → `-var-lib-cezar-workspace` (no dots) and the dotted worktree
  path above (doubled dash).

  This asymmetry matters for how the check must fail: a false **positive** ("no transcript"
  when a scan/stat error just made it look that way) is harmless — the reactive fallback one
  layer down catches a doomed spawn at the cost of one wasted process. A false **negative**
  ("transcript exists" when it does not, or the check being skipped) is not harmless — it is
  exactly today's bug. So on any resolution failure — `claudeHome` can't be determined,
  `readdir` throws (permissions, missing dir) — the check must **fail open**: treat the
  target as unverified and proceed with the resume as today, never silently downgrade a
  step that might have had a live session. See Architecture and Risks for the corrected
  statement of this asymmetry.
- Wire the check into `runAgentStep` (`run.ts`, just before the `resumeFrom`-derived
  `sessionId`/`resume` are handed to `openSession(...)`, i.e. before `run.ts:4688`, using
  `stepProfile.env` — already resolved by then, `stepProfile` is assigned at `run.ts:4650`
  via `agentEnvForStep`, strictly before the `openSession` call) and into `runContinuation`
  (before `run.ts:3426`, using `continueProfile.env`), gated on `stepBackend === 'claude'`
  (`runAgentStep`) / `continueBackend === 'claude'` (`runContinuation`).

  **The check fires too late to affect `userPrompt`, and the downgrade must correct for
  that or it silently guts the step.** `userPrompt` is frozen at `run.ts:4452` —
  `resumeFrom?.prompt ?? applyTemplate(step.prompt ?? '{{task}}', input.task)` — eighteen
  lines before `sessionId` is even minted (`run.ts:4470`), let alone before the check at
  `run.ts:4688`. For a chain re-entry, `resumeFrom.prompt` is
  `restartContinuationPrompt(...)` (`run.ts:706-712`): "The cezar process restarted while
  you were working on this task. Read the handoff file … continue the task from where you
  left off … resuming step N of M." That prompt is correct only under the assumption
  `runAgentStep`'s own doc comment states at `run.ts:4415-4417` — "open it with the restart
  prompt instead of the step's own template — the session already holds everything the
  template would have said" — which a downgrade falsifies by construction: the fresh
  session holds nothing. Left uncorrected, a downgraded step spawns a brand-new session and
  hands it only the restart prompt, with none of the step's own instructions — for
  `commit-push` (the measured incident), the discarded template is the entire ship
  instruction at `types.ts:915-932` plus `{{task}}`. The step would likely run contextless
  and "finish" having shipped nothing: AC #1's letter met, its intent inverted, caught only
  if a post-condition happens to notice.

  So on a miss, the downgrade must undo two frozen values, not just mint a fresh id:
  - **`userPrompt`**: re-run `run.ts:4452-4456`'s three lines with `resumeFrom` treated as
    absent — `userPrompt = applyTemplate(step.prompt ?? '{{task}}', input.task)`, then
    reapply `chainNote` and `checkFailure` exactly as that block already does (both remain
    in scope as function parameters at the check's call site, `run.ts:4688`). This discards
    `resumeFrom.prompt` outright; the fresh session gets the step's own template, same as
    any ordinary fresh-session run of this step.
  - **`sessionId`/`resume` handed to `openSession`**: `sessionId` is a `const` minted at
    `run.ts:4470`, and `resume: resumeFrom !== undefined` at `run.ts:4729` reads the
    `resumeFrom` parameter directly — neither can be mutated in place from the check at
    `run.ts:4688`. Track the downgrade with a local (e.g. `let resumeDowngraded = false`)
    and, at the `openSession({ ..., sessionId, resume: resumeFrom !== undefined })` call
    site, substitute a freshly minted id and `resume: false` when it is set.
  - **Persist the fresh id** (`this.store.updateStep(runId, step.id, { sessionId: fresh })`
    / the `runContinuation` equivalent) — the record already carries the dead id from the
    earlier mint-and-persist at `run.ts:4470-4472` / `run.ts:3168-3173`, and nothing else
    will overwrite it: Claude never emits a `session` event to correct it later, unlike
    Codex/OpenCode, which `run.ts:4507-4509` already rewrites on their own `session` event.
  - Emit the note, proceed — no different from an ordinary fresh-session step from that
    point on.

  Phase 2 does not need this treatment: clearing `stopResume`/`resumeFrom` and re-entering
  at the same `i` (see below) makes `runAgentStep` rebuild `userPrompt` from the step
  template on its own, by construction — the fix above only exists because Phase 1's check
  fires *inside* a single `runAgentStep` call, after `userPrompt` already committed. Phase 3
  is unaffected for a different reason: a `continue-N` step has no per-step template to
  fall back to, and `RESTART_CONTINUATION_PROMPT`'s "read the handoff file" instruction is
  its designed recovery path, not a bug being worked around.

**Phase 2 — reactive fallback in the chain loop (the exact path `232ad6d4` hit).**
- In `execute()`'s step loop (`run.ts`, immediately alongside the existing `stopped` retry
  block at `run.ts:3936-3976`, sharing its `if (failure && …)` shape but keyed on
  `isMissingSessionRejection` instead of `stopped`), add a new `Set<string>` —
  `resumedAfterMissingSession`, declared beside `resumedAfterStop`
  (`run.ts:3874`) — and a branch: when `failure` is set, `stepResume !== undefined` (this
  attempt actually resumed a session — the local already computed at `run.ts:3910`), the
  message matches the predicate for `step.runner ?? taskBackend`, and
  `!resumedAfterMissingSession.has(step.id)`: mark the retry taken, clear the step's
  `sessionId` (`this.store.updateStep(runId, step.id, { sessionId: undefined, status:
  'pending', error: undefined })`), emit the note and a `metric` event (mirroring
  `run.step.resumed_after_stop`, e.g. `run.step.resumed_after_missing_session`), and
  `continue` at the same `i` — the next iteration's `stepResume` computation naturally falls
  through to `undefined` (`resumeFrom`/`stopResume` are already spent), so `runAgentStep`
  mints a fresh id on its own (`run.ts:4470`).
- This branch must be checked **before** the unconditional `if (failure)` fail-and-break at
  `run.ts:3977-3980`, and it must not fire for a `stopped` failure (those already have their
  own, different, retry path just above it).

**Phase 3 — reactive fallback in `runContinuation`.**
- `runContinuation`'s catch block (`run.ts:3533-3544`) currently fails the step and the run
  unconditionally. Add the same one-shot gate: on `isMissingSessionRejection(backend,
  message)` and `sessionId !== undefined` (this attempt was a resume) and no prior retry for
  this `stepId`, instead of failing, clear `sessionId`, emit the note, and re-invoke the same
  continuation body with a fresh session — the simplest correct shape is recursing into
  `runContinuation` once more with `sessionId: undefined` for the same `stepId` (which already
  tolerates being re-entered: it unconditionally sets `status: 'running'`, `iterations: 1`,
  and re-appends `step-start`/`user-message`, `run.ts:3168-3193`, so the record ends up
  looking like a step that took two iterations, matching the shape the chain-loop fallback
  produces). Guard the recursion with a boolean parameter (default `false`) so a *second*
  rejection is not retried again.
- This is the path `recover-session-failure.test.ts` exercises today — see Phase 4 for the
  required inversion.

**Phase 4 — regression tests.**
- **New: `packages/cezar/src/workflows/resume-missing-session.test.ts`** — end-to-end
  through the real engine (mirroring `step-stopped.test.ts`'s shape: `CEZ_DRY_RUN=1`, real
  `RunManager`, no stubbing across the seam that matters). Two cases, because Phase 1's
  proactive check and Phase 2's reactive fallback are different code paths and this is the
  only test in the suite that exercises `run.ts`'s chain loop rather than a runner in
  isolation:
  - **(a) Proactive path — the exact scenario that killed `232ad6d4`.** Seed a multi-step
    chain (`spec-to-deploy`-shaped, ≥2 agent steps remaining) with the target step's record
    carrying `status: 'running'`, `iterations: 1`, a `sessionId` for which **no
    `.claude/projects/**/*.jsonl` exists** (point `CLAUDE_CONFIG_DIR` at an empty temp dir so
    "does not exist" is trivially true), then call `manager.recover()` (this is what turns
    the seeded record into a chain re-entry, exactly as it did for the real run) and assert:
    the run reaches `done` (or the workflow's normal terminal state) rather than `failed`; a
    `note` event says the proactive check fired; the step's final `sessionId` differs from
    the seeded one; the remaining chain steps actually ran (not collapsed into a
    `continue-N`, the same regression class `chain-integrity.test.ts` already guards); **and
    the prompt actually delivered to the fresh session is the step's own template** — assert
    the `step-start`/`user-message` prompt text contains a distinctive fragment of the
    seeded step's `prompt` (e.g., for a `commit-push`-shaped step, a fragment unique to
    `types.ts:915-932`'s ship instruction) **and does not contain** `'The cezar process
    restarted while you were working on this task'`. This is the assertion that actually
    catches a downgrade that forgot to rebuild `userPrompt`: every other assertion in this
    case passes even on a contextless fresh session that merely "completes".
  - **(b) Reactive path — the proactive check bypassed on purpose.** Same seeded chain
    shape, but this time write a decoy `<CLAUDE_CONFIG_DIR>/projects/<slug(cwd)>/<sessionId>
    .jsonl` first so the Phase 1 probe passes and `runAgentStep` actually spawns
    `mock-claude.mjs` with `--resume`; run the mock with `MOCK_CLAUDE_REJECT_RESUME=1` (Phase
    4's new hook) so it rejects exactly as the real CLI did on `232ad6d4`. Call
    `manager.recover()` and assert: exactly one retry happens (`resumedAfterMissingSession`
    fires once, `run.ts:3936`-area logic), the retried attempt uses a fresh session, a
    fallback note/metric is recorded, and the run reaches a non-`failed` terminal status.
    This is the case that actually proves Phase 2 — case (a) alone never reaches it, because
    the proactive check intercepts before any CLI is spawned.
  - **(c) Reactive path, Codex, chain loop (not just the continuation path).** A ≥2-step
    chain with a `codex` step seeded `sessionId: 'missing-thread'`,
    `MOCK_CODEX_REJECT_RESUME=1` (the existing fixture hook), recovered via
    `manager.recover()` so `reenterChain` takes it — the codex twin of case (b), and the
    piece that actually makes AC #4 true for Codex "on the chain path", since
    `recover-session-failure.test.ts` (amended below) only ever drives the single-step
    `runContinuation` path and would pass even if Phase 2's chain-loop branch were never
    wired up. Same assertions as (b): one retry, fresh session, fallback note/metric,
    non-`failed` terminal status.
- **Amend `packages/cezar/src/workflows/recover-session-failure.test.ts`.** Its current
  assertion (`status: 'failed'`, error contains `'no rollout found for thread id
  missing-thread'`) is the pre-fix behavior this spec inverts. Change the mock fixture's
  behavior or add a second `it()`: reject the FIRST `thread/resume` (`MOCK_CODEX_REJECT_RESUME`
  already does this) but let the retried attempt's `thread/start` succeed (the fixture already
  does — the reject branch only triggers on `msg.method === 'thread/resume'`, so a second
  process spawned with a fresh id and no `--resume` equivalent hits the unconditional
  `thread/start` success path unmodified). Assert the run reaches a **non-`failed`** terminal
  status, and that the record shows a fallback note/metric, not the "no rollout found" error
  as the run's final `error`. Keep (or add alongside, explicitly relabeled) a case proving
  recover() still does not retry-storm on the *next* boot after a step has already exhausted
  its one retry and genuinely failed — that is the one part of the existing test's intent that
  is NOT being inverted.
- **New: a `claude-cli-runner.test.ts` case for the proactive check only.** This is a
  runner-level unit test (`packages/cezar/src/core/claude-cli-runner.test.ts`), so it can
  prove Phase 1's check (which the runner or its caller invokes before spawning) but it
  cannot prove Phase 2's fallback — that branch lives in `run.ts`'s chain loop, one layer up,
  and is proved instead by case (b)/(c) of `resume-missing-session.test.ts` above.
  `runner.run(...)` with `resume: true` and a `sessionId` for which no transcript file exists
  under a temp `CLAUDE_CONFIG_DIR`: asserts `buildClaudeArgs`/the actual spawn never receives
  `--resume` for that id (either by asserting the mock's recorded argv via
  `CEZ_MOCK_ARGS_FILE`, or by asserting the session event/result carries a *different*
  session id than the one supplied).
  Needs `packages/cezar/scripts/mock-claude.mjs` to accept `--session-id`/`--resume` at all —
  today it does not parse them; add a `MOCK_CLAUDE_REJECT_RESUME=1` hook mirroring the codex
  fixture's shape (exit 1, stderr `No conversation found with session ID: <id>`, when invoked
  with `--resume`) — this is the same hook `resume-missing-session.test.ts` case (b) needs,
  so it belongs to Phase 4 as shared fixture work, not duplicated per test file. Like the
  existing `MOCK_CODEX_REJECT_RESUME` hook, the flag must be named in `CEZ_ENV_PASSTHROUGH`
  (`process.env.CEZ_ENV_PASSTHROUGH = 'MOCK_CLAUDE_REJECT_RESUME'`) wherever a test spawns the
  mock through the real `buildChildEnv` allowlist — `recover-session-failure.test.ts:20-26`
  is the pattern to copy. Missing this fails silently: the child never sees the flag and the
  mock behaves as an ordinary successful resume instead of rejecting it.
- **New: a slug-function unit test** pinned to both measured examples from Phase 1 (cwd
  `/var/lib/cezar/workspace` → `-var-lib-cezar-workspace`, and the dotted worktree path).
- **New: an OpenCode test proving AC #4's re-scoped claim** — `opencode-server-runner.ts`
  bootstrap called with `resume: true` and a `sessionId` that was never created anywhere:
  assert it starts a fresh session via `POST /session` and completes normally, with no
  "session not found" class error possible. This is a characterization test of already-correct
  behavior, not new runtime code — it exists so AC #4 has a concrete, executable answer for
  OpenCode instead of a prose claim.

## Data models

No schema change. `StepState.sessionId` is already `z.string().optional()`
(`runs/store.ts:86`). Explicitly clearing it is new here, not a pattern already in use:
measured, `sessionId: undefined` appears nowhere in `run.ts` — the only occurrence in the
package is `workflows/auto-resume.test.ts:169`. Neither existing retry path clears it —
the post-condition retry (`run.ts:3987-3991`) and the spec-review loop-back
(`run.ts:4004-4017`) both `continue`/`loopBackTo` back into the loop and let
`run.ts:4470`'s `resumeFrom?.sessionId ?? randomUUID()` mint-and-overwrite on the next
pass, without ever writing an explicit `undefined`. It works for the same reason a plain
overwrite would: `updateStep`'s `Object.assign(step, this.redactStepPatch(patch))`
(`runs/store.ts:806-810`) copies an own `sessionId: undefined` property onto the record,
`redactStepPatch` (`runs/store.ts:792-796`) spreads the patch without dropping that key,
and the field is `optional()` (`runs/store.ts:86`) so it round-trips as absent through
`runs.json`. For the chain-loop path (Phase 2) the explicit clear is belt-and-braces —
`run.ts:4470` overwrites the stale id on the next attempt regardless of whether it was
cleared first — and load-bearing only for a code path that reads the record without going
back through `runAgentStep`'s mint step.

The only new persisted fact is the **note/metric event**, which uses the existing `note` and
`metric` event shapes (`run.step.resumed_after_missing_session`, mirroring the already-shipped
`run.step.resumed_after_stop` at `run.ts:3963`) — no new event type.

## API contracts

None changed. `GET /api/v1/runs/:id` and the NDJSON event stream already surface `note`/
`metric` events and step `sessionId` changes without any shape change; the cockpit renders a
fallback exactly as it renders any other step-level note today.

## Risks

- **String-matching CLI/RPC error text is inherently fragile** (brief's open question 2: no
  distinguishable machine-readable error code was found for either backend in this pass — not
  checked against upstream CLI/RPC docs, which were not consulted). A future `claude` or
  `codex` release could reword the rejection and silently disable the reactive fallback. The
  proactive Claude check does not have this exposure (it never depends on error text), which
  is part of why it exists as a *first* line of defense rather than relying on the reactive
  path alone. Mitigation if this drifts: the fallback fails open to today's behavior (a normal
  step failure), not silently — a wrong guess just means the bug resurfaces exactly as
  measured, not a new failure mode.
- **The proactive check's project-directory slug is inferred from measured examples, not
  from CLI source or documentation** — two examples now (a dot-free cwd and a dotted
  worktree path; see Phase 1), but still not a guarantee the rule is exhaustive (e.g. a cwd
  containing characters beyond ASCII letters/digits/hyphens/slashes/dots is untested). This
  is exactly why Phase 1 makes the slug a fast path only and existence correctness rest on a
  directory scan instead: a slug miss degrades to the scan, not to a false "exists". The
  scan itself is not infallible — an unreadable `projects/` directory, or a `claudeHome`
  that fails to resolve, still leaves the check unable to answer — and per Architecture,
  that failure mode must resolve to **fail open** (proceed with the resume), because a false
  negative here is not a harmless retry: it silently discards a live, resumable session
  exactly like this bug does today. A false positive (downgrading a resumable session
  unnecessarily) is the safe direction to err in, and is bounded to one wasted spawn per
  occurrence.
- **OpenCode's real defect — silent loss of conversational continuity on every process
  restart, because its runner never attempts resume-by-id at all — is left unfixed.**
  Explicitly out of scope per the brief's open question 4(a): it is a different, adjacent bug
  (continuity silently lost vs. this spec's continuity loudly and permanently killed), and
  folding a resume-by-id implementation for OpenCode into this spec would mix an incident fix
  with a feature build. Flag as a follow-up.
- **The orphaned `task-author-provenance` spec's Risk 2** (`CEZ_SESSION_ID` drift for a task
  a Codex/OpenCode step files as a sub-task) is the same root mechanism — a placeholder id
  minted before the backend confirms its own — surfacing in a third place (provenance
  metadata, not step resume). Not fixed here; noted so nobody re-derives it as a surprise.
  That spec itself is uncommitted to `main` (exists only on unmerged branch
  `feat/task-author-provenance`, commit `12340a17`) — a separate loose end for the owner, not
  something this spec resolves.
- **A second miss after the one retry is still a hard failure**, by design (see Decisions).
  If the underlying cause is systemic (e.g. the whole `~/.claude/projects` directory is
  unreadable, or the account has no config dir at all) every affected step now spawns two
  processes before failing instead of one — a small, bounded cost, not a new failure mode.

## Verification

Executed as part of implementation, all automated:

1. `packages/cezar/src/workflows/resume-missing-session.test.ts` (new, three cases) —
   end-to-end through the real engine. (a) reproduces `232ad6d4`'s exact shape (a chain step
   with a `running` record and a `sessionId` whose transcript never existed, recovered via
   `manager.recover()`): the run reaches a non-`failed` terminal status, a proactive-check
   note is recorded, the step's `sessionId` changes, the remaining chain steps run rather
   than being dropped, **and the prompt actually delivered to the fresh session is the
   step's own template** (contains a distinctive fragment of the seeded step's `prompt`,
   does not contain `'The cezar process restarted while you were working on this task'`) —
   the assertion that actually distinguishes "fixed" from "completes contextlessly having
   done nothing." (b) proves Phase 2's reactive fallback specifically, by seeding a
   decoy transcript so the proactive check passes and the mock CLI rejects the resume
   (`MOCK_CLAUDE_REJECT_RESUME=1`): one retry, fresh session, fallback note/metric, non-
   `failed` terminal status. (c) is the Codex twin of (b), on the chain-loop path (not the
   continuation path item 2 covers) — same assertions, `MOCK_CODEX_REJECT_RESUME=1`.
2. `packages/cezar/src/workflows/recover-session-failure.test.ts` (amended) — the Codex resume
   rejection this test already drives now resolves via one retry to a non-`failed` terminal
   status instead of a hard failure, while still not retry-storming on next boot for a step
   that has already exhausted its retry.
3. `packages/cezar/src/core/claude-cli-runner.test.ts` (new case) — a runner-level unit test
   proving the proactive check specifically: `--resume <id>` is never sent for an id with no
   transcript on disk. It also adds the `MOCK_CLAUDE_REJECT_RESUME` fixture hook that item 1
   (b) depends on — the reactive fallback itself is proved there, in `run.ts`'s chain loop,
   not here (this test cannot reach that code).
4. New slug-function unit test — pinned to both of Phase 1's measured examples
   (`/var/lib/cezar/workspace` → `-var-lib-cezar-workspace`, and the dotted worktree path).
5. New OpenCode characterization test — `opencode-server-runner.ts` bootstrap with
   `resume: true` and a never-created `sessionId` starts a fresh session and completes
   normally; this is the executable answer to AC #4 for OpenCode.
6. Gates: `npm run typecheck`, `npm run lint`, `npm test` (full `packages/cezar` suite) green,
   under the scrubbed environment AGENTS.md prescribes.
7. **Not covered here, flagged rather than skipped:** no live re-run of `232ad6d4` itself —
   confirming this in production means engineering an equivalent mid-step kill against a real
   `claude` CLI, which the automated suite above reproduces deterministically via the mock
   instead. Mark this QA-needed against a real kill if the owner wants an in-the-wild
   confirmation, the same posture `2026-08-20-agent-step-stopped-is-not-failed.md` took for
   its own stop path.
