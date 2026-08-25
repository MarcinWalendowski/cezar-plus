# Brief — Commit and ship workspace revision attestations

**Written by:** gather-the-record step (step 1 of 9) of `spec-to-deploy` on task `7d982c23`,
branch `cez/7d982c23`. Read-only reconnaissance only — no spec, no code, no commit made.

**CORRECTED 2026-08-25, iteration 2 of this same step.** This is a re-run of step 1 on the same
task. The chain's own transcript (`.ai/cezar/runs/7d982c23-e2f5-4416-b02d-8adfd067195c.ndjson`)
shows two `cezar` service restarts (08:11:46 and 08:20:52/08:21:07); the second restart's own
lifecycle message promised "re-queued at step 'review-spec'" (step 3) but the chain actually
re-entered at `context` (step 1) instead — a resume/rewind bug in the orchestrator, not a
failure of any step's work. Steps 1 and 2 had already completed and their artifacts —
this brief and `.ai/specs/2026-08-25-ship-workspace-revision-attestation.md` — were intact and
undamaged on disk. This rewrite **keeps everything from iteration 1 that still holds**, and
folds in three things iteration 1 didn't have: the finished spec's own plan (now part of "the
record" this step must report), two live-fact corrections to that spec's resume notes found by
re-verification this iteration, and confirmation there is no duplicate in-flight work.

## The problem, in this repo's own terms

The parent run `2914e8d5` (worktree
`/var/lib/cezar/loki-labs/cezar/.ai/cezar/worktrees/2914e8d5-492e-4754-942e-1680725aff0d`,
branch `cez/2914e8d5`) implemented and backend-verified a fix for
`tested-revision-shipped`: that post-condition used to snapshot and check only the *run cwd*,
which for a workspace run is the shared scratch repo, not the real per-project worktrees where
the actual change lives. Run `2914e8d5` itself hit this: it attested four untracked scratch
control files and then rejected its own valid `cezar` commit because those files were absent
from scratch `HEAD`.

The fix (spec `.ai/specs/2026-08-25-workspace-revision-attestation.md`, readable only inside the
parent's worktree, at commit `8a4b6a3c`) adds an optional `projects: TestAttestationProject[]`
array to `TestAttestation` (`packages/contract/src/runs.ts`). For a workspace run,
`recordTestAttestation` now snapshots every persisted, unreclaimed `workspaceWorktree`
individually (`packages/cezar/src/workflows/run.ts`), and `testedRevisionShipped`
(`packages/cezar/src/workflows/postconditions.ts:397-430`) verifies each project's tree against
its own worktree `HEAD` when `projects` is present, aggregating failures by project root. Legacy
single-tree attestations (no `projects`) keep the old cwd-only path unchanged — additive, not a
schema break.

**This step's own job is narrower than the fix itself.** The parent run's work exists only as one
commit, `8a4b6a3c` ("cezar autosave (run finalize)"), on branch `cez/2914e8d5` — **confirmed this
iteration: `git branch -a --contains 8a4b6a3c` returns only `cez/2914e8d5`**, so it is not pushed
anywhere and not merged into anything. The actual task for this chain is to get that payload into
the **real, shared cezar checkout** at `/var/lib/cezar/loki-labs/cezar` (branch `main`, tracking
`origin/main`), reconciled with current `origin/main`, as one clean feature commit, pushed to
`origin main` explicitly. Both deploy targets are `manual: true`, so this job stops at a clean
push; a human activates.

## The record already decided this, twice: what step 2 (spec) already resolved

Iteration 1 of this brief left four open questions for the spec step. **The spec,
`.ai/specs/2026-08-25-ship-workspace-revision-attestation.md`, already exists, is fully written
(282 lines), and resolves all four** — full content re-read this iteration, verbatim substance
below rather than re-derived:

1. **Stale staged changes: preserve, do not discard.** The spec's Phase 0 dumps two patch files
   (`staged-vs-HEAD.patch`, `worktree-vs-HEAD.patch`) to
   `.ai/cezar/runs/7d982c23-preserved/` (gitignored, outside the tree that gets committed), then
   `git stash push --include-untracked` with a named message and a recorded stash SHA. Neither
   body is discarded; Phase 5 files a todo for each so a human decides Body A's (superseded
   draft) fate.
2. **Reconcile via cherry-pick, not reset+reapply.** `git merge-base origin/main 8a4b6a3c` ==
   `8a4b6a3c^`, so `8a4b6a3c` sits exactly one commit off current `origin/main`'s history —
   `git cherry-pick --no-commit 8a4b6a3c` onto a freshly fast-forwarded `main` is the plan, with
   a `git write-tree` assertion as a checkpoint (**see correction below — the specific hash the
   spec hard-codes for that assertion is now stale and must be recomputed, not trusted**).
3. **CORRECTED 2026-08-25 — the todo EXISTS. The last two sentences of the original item below
   are false and must not be acted on.** `.ai/cezar/todos.json` (183 items) holds
   `1d8922bb-339e-49d1-b8ee-359a1dfd1db7`, *"Fix broken test:unit suite: deploy-e2e-probe.test.ts
   (8/9 failing)"*, status `todo`, priority `medium`, filed `2026-08-24T23:52:14Z` by parent run
   `2914e8d5` from its own `run-tests` step, with the repro command in its context field. The
   `cezar todo list` reading of 89 items was **filtering, not contradicting** a 183-item store, so
   "still has no `1d8922bb`" was a wrong read, and "the id doesn't need to exist" is wrong twice
   over — it exists and it is cited by the parent spec. The **conclusion** survives for a different
   reason: the todo is **moot, not missing**, because `7932cf4d` deleted the very file it asks
   someone to fix (`packages/cezar/test/unit/deploy-e2e-probe.test.ts`) six minutes after it was
   filed, so the work cannot be done and the failure cannot reproduce. Phase 5 of the shipping spec
   therefore closes it citing `7932cf4d` **if** a supported close operation exists; measured
   2026-08-25, `cezar todo --help` exposes only `add` and `list`, so the likely outcome is that
   Phase 5 reports it as explicitly pending and moot in the handoff and leaves it alone. Never
   hand-edit `todos.json`. Original item, left unchanged below:

   **The `1d8922bb` todo is a dead end — moot, not missing.** The spec's Correction 2 traces the
   8-of-53 `deploy-e2e-probe.test.ts` failures the parent worktree reported to a file that
   `origin/main`'s commit `7932cf4d` **deliberately deleted** (Phase 3 of
   `.ai/specs/2026-08-24-bulk-start-filed-tasks.md`: "Remove the superseded string-contract
   deploy-probe unit suite"), replaced by `packages/cezar/test/e2e/deploy-e2e-probe.test.ts`
   (added by `587db317`, runs under `test:package` not `test:unit`). After reconciliation,
   `npm run test:unit` is expected **clean**; a red there is a new regression, not this baseline.
   Re-confirmed this iteration: `cezar todo list` (89 items, ran clean this time — iteration 1's
   "no todos filed" was a transient/wrong read) still has no `1d8922bb` and nothing matching
   "attestation" or "revision-shipped" by grep. Nothing to file; the id doesn't need to exist.
4. **One commit, message and scope specified.** Spec Phase 4: commit message
   `fix: attest every workspace project tree, not just the scratch cwd`, body naming the shipped
   spec and noting the two riding status-line corrections. Verification item explicitly checks
   `rev-list --count origin/main..HEAD == 1` and subject matches `^fix: `.

The spec also surfaced and resolved a hazard iteration 1 didn't know about: the real checkout's
staged **Body B** (`.ai/specs/2026-08-24-workspace-tasks-ship-themselves.md` +
`packages/cezar/src/workflows/run.ts` (small `shipped`-outcome hunk) +
`packages/cezar/src/workspace/{granted-roots,workspace-worktrees}.{ts,test.ts}` + `AGENTS.md`) is
a **second, unrelated, unshipped feature** — not a draft of the attestation fix, not a draft of
anything on `origin/main` (`git log --all` on its spec path is empty; it exists nowhere else).
Its staged `AGENTS.md` hunk asserts cezar is now the one repo a task must NOT self-push/deploy,
contradicting `origin/main`'s current `AGENTS.md:7` (reaffirmed six hours earlier by `ea40c7a1`).
The spec's resolution: that hunk stays **out of this commit** entirely (it's a doctrine change,
not this task's payload) — stash it with the rest of Body B, file a todo for the owner, and
proceed with the push this task's own text explicitly instructs, since published (committed)
doctrine — not unshipped staged bytes — governs.

## Two live-fact corrections to the spec, found by re-verification this iteration

The spec was written against a snapshot of `origin/main` that has since moved. Re-running its own
checkpoint commands now gives different numbers. **Both are re-verification issues, not defects
in the spec's plan** — the plan (cherry-pick, assert-tree-sha, gate, commit, push) still holds;
only two hard-coded values in it are stale and must be recomputed live during implementation, not
copy-pasted:

1. **The Phase 2 tree-sha checkpoint is stale.** The spec asserts
   `git merge-tree --write-tree --messages origin/main 8a4b6a3c` writes tree
   `b3d48e32f37f811a70efafa2e7cca0686fa61af0`. Re-run this iteration (`origin/main` now at
   `d217ab2e`, 31 commits ahead of the checkout's `b3d3a44c` vs. the spec's 28): it now writes
   tree **`53b9f093f0d7ef931b0f49df1b0ce9d4fd8f7e76`** — still 0 conflicts, still clean
   (`merge-base origin/main 8a4b6a3c` is still exactly `8a4b6a3c^`, i.e. `ea40c7a1`), just a
   different resulting hash because `origin/main` grew three more commits (`fe4287c2`,
   `f153b537`, `d217ab2e`) since the spec was written. **Implementation must recompute this
   assertion fresh immediately before Phase 2, not reuse either hash.**
2. **The untracked-collider diagnosis names the wrong file.** The spec says untracked
   `.ai/specs/briefs/2026-08-24-ship-bulk-start-filed-tasks.md` collides with a tracked file at
   the same path on `origin/main`. It doesn't — `origin/main` has no file at that `briefs/` path
   at all. The actual blocker to a plain merge (verified via `git read-tree -n -m HEAD
   origin/main`) is the **already-staged** `.ai/specs/2026-08-24-bulk-start-filed-tasks.md`
   (no `briefs/` in the path — Body A's spec file), which collides with the same path added by
   already-merged `7932cf4d`. The untracked briefs-directory file is not the problem; it's
   independently fine to move aside or leave stashed. Net effect on the plan is small (Phase 0's
   stash-everything-staged-and-untracked approach still resolves this regardless of which
   specific path is "the" blocker), but Phase 0 should not hard-code the spec's stated
   file-and-reason if asked to explain the conflict.

## Confirmed this iteration: parent run is done, no duplicate in-flight work

- `cez/2914e8d5`'s working tree is clean at `8a4b6a3c`; nothing is still running in it.
- `git branch -a --contains 8a4b6a3c` → only `cez/2914e8d5`. No other branch, worktree, or commit
  anywhere in `git log --all` touches the attestation feature's files
  (`postconditions.ts`'s `projects` branch, `contract/src/runs.ts`'s `testAttestationProjectSchema`).
- Two other worktrees currently share this task's own HEAD (`a3dd8f5f`, `ae7bd42f`) but are
  unrelated disposable E2E-fixture tasks, not siblings of this chain.
- `7932cf4d` (superseding Body A) is confirmed merged into `origin/main`
  (`merge-base --is-ancestor 7932cf4d origin/main` → yes) and does delete
  `packages/cezar/test/unit/deploy-e2e-probe.test.ts` as the spec claims.

## Code actually involved (payload commit `8a4b6a3c`, confirmed by direct `git show --stat`/diff)

- `packages/contract/src/runs.ts` (+11) / `.test.ts` (new, +26) — `testAttestationProjectSchema`,
  optional `projects` field.
- `packages/cezar/src/workflows/run.ts` (+69/-7) / `.test.ts` (new, +108) — per-project tree
  capture in `recordTestAttestation`, per-project ship-time HEAD recording.
- `packages/cezar/src/workflows/postconditions.ts` (+40) / `.test.ts` (new, +50) —
  `testedRevisionShipped`'s new per-project branch.
- `CHANGELOG.md` (+9) — one `🛠 Fixed` entry under `# Unreleased`.
- `.ai/specs/2026-08-25-workspace-revision-attestation.md` (new, +176) — the feature's own design
  spec.
- Two status-line-only riders: `.ai/specs/2026-08-24-default-workflow-ten-stages.md` (+/-1),
  `.ai/specs/2026-08-24-manual-deploy-not-a-bug.md` (+/-1) — record `ea40c7a1` landed.
- **Confirmed NOT touched by `8a4b6a3c`:** `granted-roots.ts`, `workspace-worktrees.ts`,
  `AGENTS.md` — these are exclusively Body B (the second, unrelated, unshipped feature staged in
  the real checkout), never the attestation payload. Do not conflate the two when scoping Phase 2
  or checking the final staged path set.

## The state of the real checkout (re-verified this iteration)

`/var/lib/cezar/loki-labs/cezar` (branch `main`) is still not clean and still behind
`origin/main`:

- `git status`: **31 commits behind `origin/main`** (was 28 at spec-writing time; `origin/main`
  moved from `00a202b8` to `d217ab2e`), fast-forwardable — `git fetch origin --dry-run` reports
  nothing new to fetch, so the refs are already local; only the working branch needs to move.
- 12 files staged (735 insertions / 15 deletions) + 1 untracked, unchanged in composition from
  iteration 1 — same two bodies (Body A: superseded `bulk-start-filed-tasks` draft, disposable
  per the spec's inference but not to be destroyed without owner sign-off; Body B: unshipped
  `workspace-tasks-ship-themselves`, unique, must be preserved). Ownership `cezar:cezar`
  throughout, 0 mismatches.
- Both deploy targets confirmed still `manual: true` in `.ai/deploy-targets.json:26,32`, each
  with a human-activation `manualReason`. Blue-green machinery lives in
  `packages/cezar/src/server-install/{deploy-strategy,release-deploy}.ts`; `deploy.sha` is
  reported by the backend's `/api/v1/ready` probe embedded in `.ai/deploy-targets.json`'s probe
  script.

## Prior decision this would sit in tension with, if handled wrong

- **One commit per session/feature; "exactly one feature commit"** (this task's own acceptance
  criteria) — the autosave message `8a4b6a3c` carries must not ship verbatim; spec Phase 4 already
  supplies the replacement message.
- **`cezar` is the sole repo excluded from "push without asking" in the global Loki Labs
  CLAUDE.md**, but cezar's own `AGENTS.md:7` (as currently committed on `origin/main`, reaffirmed
  by `ea40c7a1`) grants standing self-push/deploy authorization for changes to cezar itself — this
  task is exactly that case. The **staged but uncommitted** Body B hunk that tries to supersede
  that authorization does not apply; only committed, published doctrine governs, and the spec
  already resolved to keep that hunk out of this commit.
- **Never take a spec number from `ls`.** Not directly triggered (the attestation spec already has
  its number), but Body B's untracked spec sitting only in the index is exactly the kind of state
  that rule exists to prevent racing against — flagged here only as a reminder, not this step's
  problem to fix.

## Gates required

Live-read from `/var/lib/cezar/loki-labs/cezar/.ai/agentic.config.json` `validation.commands` and
confirmed against actual `package.json` scripts this iteration: `npm run typecheck`, `npm test`,
`npm run test:unit`, `npm run build`, `npm run test:package`. Root `typecheck` chains
contract/client/server/web sub-checks; `test:unit` runs
`packages/cezar/test/unit/*.test.ts` via `node --test`; `test:package` runs
`packages/cezar/test/e2e/*.test.ts`. No `lint` script exists in this repo — these five are the
whole gate set, matching the spec's own Phase 3. **Must be re-run fresh in the real checkout
after reconciliation** — the parent worktree's green run was against its own stale base and does
not carry over.

## What I could NOT find

- No KB entry besides `specs-6075b87dbdfe` (the ten-stage-workflow spec naming this gap as its P3)
  addresses this exact reconciliation problem — new territory, not a repeat of a documented
  incident. (Note: the two KB doc IDs `specs-9ae029076eec`/`specs-21fbce1fa0cc` given to earlier
  iterations of this step do not resolve via `cez kb show` and are absent from the live catalog —
  either the writes never landed or were never reindexed. The brief/spec files on disk, read
  directly, are the authoritative source regardless.)
- **CORRECTED 2026-08-25 — this bullet is false and is the second place this brief states it.**
  There **is** a todo entry for `1d8922bb`: `1d8922bb-339e-49d1-b8ee-359a1dfd1db7`, status `todo`,
  filed `2026-08-24T23:52:14Z` by parent run `2914e8d5`, in `.ai/cezar/todos.json` (183 items). It
  belongs under "what I found", not under "what I could NOT find". It is **moot** — `7932cf4d`
  deleted the file it names — but moot is not absent, and the difference matters: the shipping
  spec's Phase 5 acts on this id. See the corrected item 3 above for the full record and for what
  Phase 5 does with it. Original bullet, left unchanged below:

- No todo/task-tracker entry for `1d8922bb` — confirmed moot, not something to file (see above).
- No evidence anywhere in `origin/main`'s history of a prior attempt to ship this attestation fix.
- No tracked item for the orchestrator's step-cursor rewind bug (promised "review-spec", actually
  resumed at "context") — closest existing todo (`64fe3d70`) covers a different STOP/re-entry
  scenario. Out of scope for this task to fix; noted for awareness only.

## The four facts that most constrain the next step

1. The feature is **fully implemented, tested, and a complete implementation spec already
   exists** (`.ai/specs/2026-08-25-ship-workspace-revision-attestation.md`, Phases 0-5, all four
   of iteration 1's open questions resolved) — remaining work is executing that spec's plan, with
   two stale checkpoint values recomputed live, not re-planning from scratch.
2. The real checkout is **31 commits behind `origin/main`** (moved from 28 since the spec was
   written) **and still carries two unrelated staged bodies of work** that must be preserved
   (patch dump + named stash), never destroyed.
3. **Both deploy targets remain `manual: true`** — the job stops at a clean, pushed `origin main`
   commit plus reporting the exact revision; must not attempt to deploy.
4. **The spec's hard-coded tree-sha assertion (`b3d48e32f3...`) is now wrong** (current value
   `53b9f093f0...`) purely because `origin/main` advanced three more commits since it was
   written — recompute `git merge-tree --write-tree --messages origin/main 8a4b6a3c` live
   immediately before trusting it as a Phase 2 checkpoint.
