# Missing Session Resume

## Problem

Cezar can persist a session id before its backend has confirmed that a conversation exists. On a restart or Continue, that placeholder is treated as resumable state. Claude then receives `--resume <id>` and rejects it with `No conversation found with session ID`, which the engine treats as an ordinary terminal backend failure.

This was measured twice. Workspace run `232ad6d4-58a5-421e-941f-5c24bd5a8452` lost its `commit-push` step after a restart resumed an id for which no Claude transcript existed. Owner-reported run `b3b5719c-ccf6-445c-9b97-39dd7eaf077e` independently exercised the continuation path: session `4d357600-6bde-493c-a7bf-f6057f469e40` timed out, then `continue-1` and `continue-2` both failed with the same rejection (workspace `runs.json`, run entry around lines 5178-5366; task run NDJSON contains the exact error).

The task context is now stale in one important respect. The earlier run did not stop at two unwired helpers. Commit `373b1b10` fully implemented and tested the fallback, and `git merge-base --is-ancestor 373b1b10 origin/main` succeeds. This worktree is stale at `2778fd52`, so its files still show the defect even though `origin/main` contains the fix. The branch tip `cez/3dbf68c1` also contains the implementation, followed by unrelated merge `cb7c3e7f`; the atomic implementation is commit `373b1b10`, not the branch tip.

## What the record decided

- The existing implementation record is `.ai/specs/2026-08-22-resume-fresh-session-fallback.md` from commit `373b1b10`, with its gathered brief at `.ai/specs/briefs/2026-08-22-resume-fresh-session-fallback.md`. The spec chooses two defenses: a proactive Claude transcript check before a restart-derived resume, plus a one-shot reactive fresh-session retry when Claude or Codex rejects a resume (spec lines 25-42, 125-173).
- Immediate session-id persistence remains intentional. Claude has no fresh-session confirmation event, and the persisted id supports interactive takeover. The id is therefore a hint that must be validated before restart resume, not delayed until confirmation. Codex overwrites its placeholder after a successful session event (spec lines 125-145).
- A classified missing-session rejection retries exactly once with a fresh id. The fallback must be visible as a durable thread `note`, and a second rejection remains terminal. OpenCode is characterized rather than changed because its transport always creates a fresh session instead of resuming by id (spec lines 147-180, 183-207).
- Proactive transcript validation applies only to chain-restart resumes through `ChainResumePoint.resume.verifyTranscript`. Applying it to every `resumeFrom` contradicts the shipped stop-retry guarantee: a just-observed live session may not have flushed its transcript yet. The literal broad gate broke `step-stopped.test.ts` during implementation (spec lines 9-23; adjacent decision `.ai/specs/2026-08-20-agent-step-stopped-is-not-failed.md`).
- Filesystem lookup failures fail open to the existing resume path. A missing transcript after a successful scan is evidence; an unreadable or unresolved Claude projects directory is not evidence that the session is absent (spec lines 245-257).
- The adjacent KB entry `notion-04ca960e6408`, `A shared spool and an exit record with no owner`, concerns a distinct same-day code 143 failure on run `232ad6d4`. It must not be conflated with this code 1 missing-conversation defect. The curated product record also marks that spool defect open (`/var/lib/cezar/loki-labs/notion-export/domains/cezar.md:12`). No direct KB entry closing the missing-session defect was found.

## Code involved

On this stale worktree, `packages/cezar/src/workflows/run.ts:1895` derives a restart resume point from a persisted non-pending step without checking backend existence. `runAgentStep` mints and persists the id before spawn at `packages/cezar/src/workflows/run.ts:4469`, and the chain loop makes an ordinary failure terminal at `packages/cezar/src/workflows/run.ts:3977`. Claude turns `spec.resume` into `--resume` at `packages/cezar/src/core/claude-cli-runner.ts:708` and flattens a nonzero exit into an error at `packages/cezar/src/core/claude-cli-runner.ts:324`.

The parallel continuation construction site selects and forwards the latest persisted id at `packages/cezar/src/workflows/run.ts:2984`, starts with `resume: sessionId !== undefined` around `packages/cezar/src/workflows/run.ts:3426`, and converts any rejection into permanent step/run failure at `packages/cezar/src/workflows/run.ts:3533`. Durable visibility already exists through the continuation event append path at `packages/cezar/src/workflows/run.ts:3214`.

Commit `373b1b10` wires both previously named helpers. `isMissingSessionRejection` is added to `packages/cezar/src/core/agent-runner.ts:110` for Claude and Codex. `claudeSessionTranscriptExists` is added at `packages/cezar/src/core/claude-cli-runner.ts:756`. The commit wires proactive checks into both chain restart and continuation, wires reactive one-shot recovery into both terminal failure sites, emits notes and `run.step.resumed_after_missing_session`, and rebuilds the original step prompt when starting fresh. Its regression coverage is `packages/cezar/src/workflows/resume-missing-session.test.ts:139` for proactive Claude, `:202` for reactive Claude, and `:250` for reactive Codex. It also reverses the obsolete contract in `packages/cezar/src/workflows/recover-session-failure.test.ts:46`, which previously asserted that a missing Codex rollout must fail permanently.

## Contradictions and unresolved record

- Source delivery and task tracking disagree. `origin/main` contains `373b1b10`, but both the original todo `84861218-03fd-47fa-8312-722543cd6e63` (the task context says `84624218`) and the duplicate todo remain open. `cezar todo list` reported no todos even though the underlying tracker contains them.
- The implementation spec says `gates green`, but its own header and commit message report `5660 passed / 1 skipped / 1 failed`, with `src/knowledge/catalog.test.ts` failing its CPU-budget assertion. Typecheck passed and no lint config exists. Whatever the assessment of that flaky test, the recorded full gate was not literally green.
- No real killed-Claude or killed-Codex runtime E2E was run. The implementation is explicitly QA Needed, even though source is on `origin/main`.
- No machine-readable provider error code was found. Reactive classification still depends on backend-specific error text.

## Questions the next step must settle

1. Is any new code or spec justified after updating this worktree from `origin/main`, or is the remaining task solely verification and record cleanup?
2. What exact runtime E2E will prove both proactive restart recovery and reactive continuation recovery without risking unrelated live runs?
3. Must the full suite be rerun until literally green before closing, rather than inheriting the prior CPU-budget failure as an accepted flake?
4. Which tracker entries should be corrected in place once verification establishes the final status, and should a durable KB entry record the shipped behavior?

## Could not find

No direct KB decision entry for this defect, no machine-readable Claude missing-session error, and no completed runtime E2E artifact were found. The workspace-owned NDJSON for run `232ad6d4` was not present in this project run directory; its evidence survives in the prior brief/spec and todo record.
