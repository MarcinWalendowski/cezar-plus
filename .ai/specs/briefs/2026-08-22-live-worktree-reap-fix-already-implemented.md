# Brief — the live-worktree-reap fix is already built, reviewed and gate-tested in THIS worktree; it has not been merged, pushed, or deployed

**Task id:** `b34867ee-be6d-4275-9b14-0d3fdd62e78d` **Step:** 1/8 — Gather the record (this is a
brief; no spec or code written here)

## Headline finding — read this before doing anything else

The task prompt says: *"RETRY... There is no prior work to build on — start this task from
scratch."* **That is stale.** It describes an *earlier, different* dispatch of this same task
(via codex, which HTTP-400'd on every turn and produced nothing — fixed generally in `c1ccbe79`,
spec `.ai/specs/2026-08-22-failed-turn-reads-as-done.md`). This task id was then retried as a
fresh 8-step chain, and — measured directly in this worktree, right now — **that retry already
ran all the way through `context → spec (×3 revision passes) → review-spec (×3 passes) →
implement → run-tests`**, per `$CEZ_HANDOFF_FILE`'s own progress log (21:19Z–22:41Z today). The
work is sitting in this exact worktree as a real commit:

```
362865ec fix: pruneOrphans autosaves before removing, releases carry a build stamp, and
          worktree leases stop live-tree reaping
```

`git status` → clean, nothing uncommitted. The commit message enumerates P0/P1/P2/P3 essentially
verbatim against this task's own acceptance criteria, and cites both specs named in this task's
"Knowledge" section. **This is very likely why the chain is being retried a second time as a
fresh "step 1 of 8"** — something restarted the orchestration (crash, redispatch) after
`run-tests` finished but before `commit-push`, and the git state survived because it lives in the
worktree, not in the orchestrator's own memory.

**What this means for the next 7 steps:** the job is not "design and build the fix." It is
"verify the existing fix is still correct against a `main` that has moved, merge it forward,
ship it, and run the E2E that was never run." Re-deriving the spec or re-implementing P0–P3 from
zero would be redoing already-reviewed work and risks silently regressing a fix that took three
review-spec passes to get right.

## The problem, in this repository's own terms

Confirmed still true by reading the code fresh (not trusting the handoff's narrative):
`packages/cezar/src/server-install/release-deploy.ts`'s `stage()` was `rsync -a`, never a build,
so the release id / `deploy.json.sha` / `/api/v1/ready`'s `deploy.sha` / the two probes in
`.ai/deploy-targets.json` all derived their sha from the *source checkout's* `git rev-parse HEAD`
— nothing read the artifact. Combined with `pruneOrphans` in `packages/cezar/src/git-worktree.ts`
being fail-open (no autosave, `git branch -D`, no removal log), a stale pre-fix binary running
under a fresh sha swept every live workspace worktree and branch on the box on 2026-08-22
13:12:02Z, mid-run, unrecoverably. Full incident detail: `.ai/specs/2026-08-22-live-worktree-reaped-mid-run.md`
(the canonical spec, status line: **"implemented, QA needed"** — already reflects that code
landed, not that it's still to design).

## What the record already decided (with citations)

- **KB `specs-1470bd6c6779`** — the live spec doc itself, states "Status: implemented, QA needed"
  and "Amended 2026-08-22 (task `b34867ee`, brief `.ai/specs/briefs/2026-08-22-stale-artifact-live-prune.md`)."
  That brief is this same task's OWN step-1 output from the run that already executed — read it
  for the original problem framing; this document supersedes it only in reporting what happened
  *after* that brief, not in re-deriving the problem.
- **KB `specs-91633925b646`** (`2026-08-22-cross-project-worktree-orphan-prune-safety.md`) —
  status "implemented — gates green ... shipped 2026-08-22," commit `5ffa383c` (07:58:54Z),
  already on `origin/main`. This is the *earlier* fix (cross-project ownership check) that the
  current task extends; it closed the cross-project blindness but left prune fail-open, which is
  exactly what this task's P0 closes. Do not re-touch Layer 1/2 of that spec.
- **KB `notion-23363acb2719`** — the Notion-side mirror of the same incident, corroborates the
  "concurrency is the trigger" framing and the six-minute window.
- **`.ai/specs/2026-08-22-rollback-readiness-gate.md`** (status: IMPLEMENTED, QA Needed, already
  on `origin/main` as `190cf588`) — a **distinct but adjacent** fix: it added a readiness probe to
  `runRollback` in `deploy-strategy.ts`. This task's P2 gate in `release-deploy.ts` calls
  `runRollback` on the rollback path, so the merge (below) brings this in; verified no direct file
  overlap between the two diffs (see "Code actually involved").

## Which code is actually involved, and what state it's in (verified by reading, not by trusting the commit message)

Read directly at `HEAD` of this worktree (`cez/b34867ee` @ `65a3945b`, commit `362865ec` is 3
commits back):

- **`packages/cezar/src/git-worktree.ts`** `pruneOrphans` (~line 667): confirmed — every
  removal path first calls `autosaveCommit(worktreePath, 'run finalize')` (line ~709); on
  `refused`/`failed` it keeps the directory and reports `outcome: 'kept'` (~711-713); every
  candidate object literal sets `branchKept: true as const` (no code path calls `git branch -D`
  at all); outcomes are reported via `opts.onOutcome?.()` the same way for `removed`/`kept`/
  `declined`. **P0 confirmed implemented as described.**
- **`packages/cezar/src/workspace/worktree-lease.ts`** (new file, 59 lines): lease read/write/
  remove under `<repoRoot>/.ai/cezar/worktree-leases/<runId>.json`, atomic write via
  `rename()`, `LEASE_HEARTBEAT_MS = 90_000`. **P3 lease mechanism confirmed present.**
- **`scripts/write-build-stamp.mjs`** (new file, 18 lines) + `package.json:17,20`
  (`"build": "... && npm run build:stamp"`): writes
  `packages/cezar/dist/.build-stamp.json {stampVersion, sha, builtAt, dirty, version}`.
  **P1 stamp-writing confirmed wired into the real build script**, not just described.
- **`packages/cezar/src/server-install/release-deploy.ts`** `runReleaseDeploy` (line 373+):
  confirmed order is (1) symlink structural check, **unconditional**, first; (2)
  `if (!rollback) { ...stamp/ancestor gates... }` — so rollback is fully exempted from the P1/P2
  forward-artifact and ancestry gates, matching the acceptance criterion and matching the fix the
  handoff's `run-tests` step described applying. `gitRelation` distinguishes
  `ancestor` (exit-0 no-op) / `divergent` / `unresolved` (both refused without
  `--allow-unrelated`) — **satisfies "fail closed when either sha cannot be resolved."** **P1/P2
  confirmed correctly implemented, including the exact ordering defect review-spec pass 3
  flagged.**
- **`packages/cezar/src/server-install/releases.ts`**: `releaseEntrySchema` gained `dirty` and
  `stale` fields — `deploy.json` now carries stamp provenance.
- **`packages/cezar/src/server/runtime-info.ts`**: `DeployInfo` gained `builtAt`/`dirty`,
  surfaced through `currentRelease()` — so `/api/v1/ready`'s `deploy` field now transitively
  reports stamp-derived data, not raw source `git rev-parse HEAD`.
- **`.env.example`** and **`README.md`**: both updated with `CEZ_SWEEP_DELAY_MS` (default
  300000ms) and `CEZ_LEASE_STALE_MS` (default 900000ms) — satisfies this repo's rule that a new
  `CEZ_*` var must be documented in the same commit.
- **Tests touched**: `git-worktree.test.ts`, `release-deploy.test.ts`,
  `project-context.test.ts` — per the handoff, `npm run typecheck` and `npm test` were run twice;
  final state "`Test Files 5 failed | 528 passed (533)`" with all 5 failures individually
  re-verified as pre-existing/host-load noise, not caused by this diff (isolated reruns passed,
  and a disposable control worktree at the same base showed the same flake under the same load).
  **I have not independently re-run the tests in this step** — this is the handoff's claim,
  cross-checked only by reading the diff, not by executing anything.

## What this brief could NOT verify (open items for later steps)

1. **`origin/main` has moved.** `git rev-list --left-right --count origin/main...HEAD` → `10 3`.
   This branch merged `origin/main` at `c31af208`; ten more commits have landed since (rollback-
   readiness-gate docs `190cf588`, spool-exit-crosstalk docs, a "bounded broker retry" fix
   `2258aee0`, merge scaffolding). **Exactly one file overlaps between the two sides:
   `packages/cezar/src/workflows/run.ts`** — this branch added ~30 lines there (the P3 deferred-
   sweep scheduling), and `origin/main`'s `2258aee0` added ~106 lines there (unrelated broker-retry
   logic). `git merge-tree` on the two sides produced no `CONFLICT` markers, but that is not the
   same as a verified clean three-way merge — **the commit-push step must actually perform the
   merge and re-run gates before pushing**, not assume it's clean from this check alone.
2. **The E2E acceptance criterion has not run.** "3 concurrent workspace runs survive a forward
   deploy with zero live worktrees/branches removed; an ancestor deploy and a not-rebuilt deploy
   are both refused; a genuinely orphaned directory is still removed AND logged" — nothing in the
   handoff or git history shows this executed on `prod-host`. This is real production
   verification, not a unit test, and per this repo's own doctrine (`AGENTS.md` → "Gates are
   necessary, not sufficient") the fix is **QA Needed, not Done**, until it runs.
3. **No re-review after the two `run-tests`-step fixes.** The `implement` step's code was reviewed
   three times as a *spec*; the two bug fixes applied during `run-tests` (gate ordering, test
   timing) were applied ad hoc during that step, not run back through a `review-spec` pass. I
   independently re-read the resulting code (above) and it matches the acceptance criteria and
   the review pass 3 finding it was meant to fix — but this is my own read, not a second
   reviewer's.
4. **I did not execute `npm ci` / `npm run typecheck` / `npm test` myself in this step** — running
   builds/tests is explicitly out of scope for step 1, and the global instruction is "don't build
   or run anything without asking." The handoff's claim that gates are green is second-hand.

## Duplicate/in-flight work check

- `cezar todo list` → no todos filed (none to collide with).
- No other spec or brief references task `b34867ee` doing this work differently.
- The two adjacent, already-shipped specs (`5ffa383c` cross-project ownership check,
  `190cf588` rollback readiness gate) are complete and distinct — nothing here should re-touch
  their code paths beyond the calling convention already accounted for above.

## What most constrains the next step

1. **The fix is written, reviewed three times, and (per the handoff, unverified by me) gate-green
   — the remaining work is merge, verify, ship, and run the E2E, not redesign.**
2. **`git status` is clean and `HEAD` is 3 commits ahead / 10 behind `origin/main`** — a real
   merge (with one overlapping file, `workflows/run.ts`) is required before push; do not assume
   `git merge-tree`'s silence proves it's conflict-free.
3. **`pruneOrphans` (P0), the build stamp + forward-artifact/ancestry gates (P1/P2), and the
   worktree lease (P3) are all independently confirmed present in the code, correctly ordered
   (symlink check unconditional, rollback exempts the forward gates)** — verified by direct
   reading, not by trusting the commit message.
4. **The production E2E (the task's own acceptance-criteria bullet) has not run anywhere** — this
   is the one acceptance criterion that is unambiguously still open, and it requires the box
   (`prod-host`), not just gates.
