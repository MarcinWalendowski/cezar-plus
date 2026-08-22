# Brief — a resumed session cezar never confirmed existed fails its step permanently

**For task 3dbf68c1. Gather-the-record step only — no spec, no code written here.**

## The problem, in this repo's own terms

Run `232ad6d4-58a5-421e-941f-5c24bd5a8452` (`spec-to-deploy`, workspace run) died permanently at
`commit-push`. Read straight from
`/var/lib/cezar/workspace/.ai/cezar/runs/232ad6d4-58a5-421e-941f-5c24bd5a8452.ndjson`:

- `commit-push` iteration 1 starts at `22:13:33.711Z` (line 1492) and emits **nothing** — no
  `session.started`, no tool/text event — before line 1493, `22:16:20.249Z`: `"cezar restarted —
  chain re-queued at step \"commit-push\""`. No literal `SIGKILL` string appears anywhere in the
  ndjson; the gap is consistent with, but not directly proof of, the box's documented
  SIGKILL-on-deploy-restart mechanism (AGENTS.md § "Always self-deploy").
- Iteration 2 starts 2.5s later (line 1497, `22:16:22.800Z`) and fails 4s after that. Lines
  1503–1506, all within 3ms of `22:16:27.34xZ`: `session.error` / `session.ended` / `step-end` /
  `lifecycle`, each carrying `"claude CLI exited with code 1 — No conversation found with session
  ID: cb916c71-974d-4fca-9aaa-f4c89b871b80"`. The step ends `status: 'failed'`; the run ends
  `status: 'failed'`.
- The string `cb916c71-...` appears **only** in those 4 failure lines — no `session.started` for
  it exists anywhere in the file. Backend is `claude` throughout (run-level lifecycle line 1494,
  every `session.started`'s `backend` field).

## What the record already decided (citations)

- No existing spec or KB entry addresses this failure mode directly. `cez kb search "session
  resume No conversation found"` and `"commit-push step failure"` returned no on-point hits (1798
  / 717 results, all tangential — SPEC-474 session resume is a Delio/Kitesurf browser-automation
  concern, unrelated).
- The handoff's own citation, `.ai/specs/2026-08-21-task-author-provenance.md` (Risks 2), **does
  not exist in this repo.** It exists only in an orphaned worktree,
  `/var/tmp/232ad6d4-author-work/.ai/specs/2026-08-21-task-author-provenance.md` — left over from
  the very run this bug killed — and as commit `12340a17` on branch `feat/task-author-provenance`
  (local + `origin/feat/task-author-provenance`), which is **not an ancestor of `HEAD`** (verified:
  `git merge-base --is-ancestor 12340a17 HEAD` fails; current HEAD is `c73c8a2d`). It was written
  and even committed, but never merged to `main` — flag this as a separate loose end for the
  owner, not something this spec should assume is live.
- That orphaned spec's Risk 2, quoted verbatim: *"`CEZ_SESSION_ID` drifts on Codex/OpenCode. Those
  backends mint their own session id after the child env is built (`run.ts:4110`, `:2862`), so a
  task filed by a Codex step records cezar's pre-mint id... Not fixed here — fixing it means
  re-exporting the env mid-step, which is a bigger change than the value it buys."* This is the
  **same root mechanism** (cezar mints a placeholder id before the backend confirms its real one)
  but a **different consequence**: there it corrupts provenance metadata handed to a spawned
  sub-task; here it kills the step outright on resume. The orphaned spec explicitly declared its
  version out of scope — this spec is not duplicating decided work, it's a different manifestation
  nobody has scoped yet.
- `packages/cezar/src/workflows/recover-session-failure.test.ts` (describe block *"recover()
  contains backend session failures (#562)"*, test at line 46) already **codifies the opposite of
  the acceptance criteria** as current intended behavior for Codex: it seeds a step with
  `sessionId: 'missing-thread'`, `status: 'running'`, forces the mock app-server to reject the
  resume (`MOCK_CODEX_REJECT_RESUME=1` →
  `packages/cezar/src/core/__fixtures__/codex/mock-codex-app-server.mjs:51-52`, `"no rollout found
  for thread id ..."`), and asserts the run ends `status: 'failed'` with that error — proving only
  that `recover()` doesn't retry-storm on the *next* boot (`run.ts:1591-1594` skips non-`running`
  runs), not that the step should ever succeed. **A spec here isn't just adding a new test
  alongside this one — it has to explicitly invert/amend an existing test that currently asserts
  "permanent failure is correct."**
- Adjacent, already-shipped mechanisms this spec sits next to (must extend, not contradict):
  - `.ai/specs/2026-08-20-chain-integrity-restart-and-continuation.md` — this is the exact
    mechanism that fired at ndjson line 1493 ("chain re-queued at step..."). Restart recovery
    revives the interrupted step and resumes it; it does not know or care whether the session it's
    resuming ever actually existed.
  - `.ai/specs/2026-08-20-agent-step-stopped-is-not-failed.md` — the closest existing analog in
    shape to the fix this needs: on a cezar-initiated stop, the step is re-entered **once**,
    resuming the **same session id**, before giving up (`run.ts:3954-3971`, "stop-retry"). This
    bug needs the same one-shot-retry shape, but triggered by a *backend-rejected resume* instead
    of a *cezar-initiated stop*, and probably falling back to a **fresh** session rather than
    retrying the same dead id.
  - `.ai/specs/2026-08-20-inactive-sessions-stay-in-progress.md` — `continueRun` also resumes via
    `--resume <sessionId>` for idle interactive sessions; same exposure, different trigger.

## Which code is actually involved

All under `packages/cezar/src/`. Line numbers below are current HEAD (`c73c8a2d`); the task
context's cited lines (4071/4073/2624/3569) have drifted and are superseded by these.

- **Mint + persist, before any confirmation** — `workflows/run.ts:4470-4472`, inside
  `runAgentStep`:
  ```
  const sessionId = resumeFrom?.sessionId ?? randomUUID();
  const backend = step.runner ?? taskBackend;
  this.store.updateStep(runId, step.id, { sessionId, backend });
  ```
  This runs **before** `runner.startSession`/`reattachSession` (`run.ts:4685-4739`). For Codex,
  a later `session` event overwrites this placeholder with the backend-confirmed id
  (`run.ts:4507-4509`) — but only if the process survives long enough to emit it. **For Claude
  there is no such confirmation event at all**: the id minted at 4472 is the same id passed
  straight to `--session-id` on the CLI's first run, and nothing ever separately confirms the CLI
  actually created that conversation. This asymmetry matters for design: "persist only after
  confirmed" (AC #2, option 1) has no signal to wait for on Claude's fresh-start path; only
  "treat as a hint validated before `--resume`" (AC #2, option 2) is viable there.
- **Resume gating (all backends, same predicate)** — `resume: resumeFrom !== undefined`
  (`runAgentStep`, `run.ts:4728-4729`) / `resume: sessionId !== undefined` (`runContinuation`,
  `run.ts:3457-3458`).
- **Per-backend resume construction:**
  - Claude — `core/claude-cli-runner.ts:708-716` (`--resume <id>` vs `--session-id <id>`); generic
    exit-code handling at `:324-330` treats any non-zero exit identically — no special-casing of
    "No conversation found" text, no fallback.
  - Codex — `core/codex-app-server-runner.ts:358-364`: `spec.resume && spec.sessionId` →
    `thread/resume` RPC; else `thread/start`, capturing whatever id codex mints. Codex **does**
    honor cezar's externally-minted id on resume (it doesn't silently re-mint) — it rejects it if
    unknown, which is what the existing test above exercises.
  - OpenCode — `core/opencode-server-runner.ts:329-333`: bootstrap **always** `POST /session`,
    unconditionally. `spec.resume`/`spec.sessionId` are never read there — OpenCode never actually
    attempts a resume-by-id at the transport level, so it cannot hit "No conversation found" the
    same way. Its own file-header doc comment (line 43, "reusing the session id resumes for
    'Continue'") describes same-process multi-turn reuse, not cross-restart resume. **This means
    AC #4's premise ("verified for codex/opencode, whose ids drift by construction") doesn't hold
    symmetrically** — Codex validates-and-can-reject an externally-supplied id; OpenCode has no
    resume path to validate at all, and instead silently starts over with zero continuity on every
    process restart, which is a related but distinct defect not covered by this acceptance
    criterion as written.
- **Retry/iteration paths and whether they reuse the session id** (explains "iterations=2" in
  general, though 232ad6d4's iteration 2 came from restart-continuation, not these):
  - stop-retry (`run.ts:3954-3971`) — reuses the same `sessionId`, one shot.
  - post-condition retry (`run.ts:5485-5505`, invoked `:3987`) — no `resumeFrom` carried, mints a
    **fresh** id on re-entry.
  - spec-review/approval loop-back (`run.ts:3822-3831`, invoked `:4012`/`:4044`) — also mints
    fresh.
- **No existing helper anywhere in the repo** (`tools/`, `scripts/`, `packages/cezar/src/`) checks
  whether a Claude `.jsonl` transcript, a Codex rollout, or an OpenCode session actually exists on
  disk/server before a resume is attempted — confirmed by grep for `.claude/projects`, `.jsonl`,
  `sessionExists`, `hasTranscript` (only spec/test/doc references, no implementation). Any
  "validate before resume" design is new code, not a wire-up of something that already exists.

## Open questions a spec will have to settle

1. **Where does the fallback live?** Inside `runAgentStep`'s own error handling (catch the
   specific rejection, retry once in-process with a fresh session, mirroring the stop-retry
   shape at `run.ts:3954-3971`) — or lower, in each backend runner, or in `recover()`? The
   existing codex test asserts today's behavior is a hard `recover()`-level failure; the fix
   likely needs to intercept **before** the step ever reaches `failed`, which argues for
   `runAgentStep`, but that needs to be a decision, not a default.
2. **How is "rejected because the session doesn't exist" distinguished from any other CLI/RPC
   failure?** Claude's error surface is free-text stderr (`claude-cli-runner.ts:324-330`, "No
   conversation found with session ID: ..."); Codex's is a JSON-RPC error message string ("no
   rollout found for thread id ..."). Both are string-matched, not typed — fragile across CLI
   version drift. Is there a more robust signal (a distinguishable exit code, an RPC error code)
   for either backend? Not found in this pass; worth checking CLI/RPC docs or `--help` output.
3. **Does "written only after confirmed" apply to Claude at all**, given it has no separate
   confirmation event on a fresh start? If not, AC #2 for Claude reduces entirely to "validate
   as a hint before `--resume`" — the spec should say so explicitly rather than leave both options
   open only for backends where the second one doesn't apply.
4. **What does "verified for codex/opencode" mean for OpenCode**, given OpenCode's runner never
   attempts a resume-by-id at all? Options: (a) treat AC #4 as claude+codex only and flag OpenCode's
   silent-restart-loses-continuity behavior as a separate, later fix; (b) fold a minimal OpenCode
   fix (attempt reuse, else warn-and-continue-fresh, which is arguably what already happens) into
   this spec's scope. This needs an explicit decision, not a guess.
5. **Does the fix change what `recover-session-failure.test.ts`'s existing test asserts?** If the
   fallback is one-shot-in-step, that test's scenario (`status: 'running'`, `sessionId:
   'missing-thread'`, then `recover()` on next boot) may be a *different* code path than "resume
   rejected live, mid-step" — worth confirming whether `recover()`'s job (don't retry-storm across
   process restarts) and the new fallback's job (survive one resume rejection within a step) are
   the same call site or two, before deciding whether the existing test needs inversion or simply
   coexists unchanged.

## What I could not find

- No KB entry, spec, or todo already scoping this exact fix (searched KB for the failure text and
  for "commit-push step failure"; `cezar todo list` returned no todos at all).
- No literal `SIGKILL` evidence in the run's own ndjson — the kill is inferred from the "cezar
  restarted" lifecycle line and the box's documented deploy-restart behavior, not measured
  directly in this log.
- No distinguishable machine-readable error code for either backend's "session not found" — only
  free-text messages, per backend, confirmed by reading the runner source (not CLI/RPC docs, which
  weren't consulted this pass).
