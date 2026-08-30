# Ship the Workspace Revision Attestation

**Status:** written 2026-08-25 for run `7d982c23-e2f5-4416-b02d-8adfd067195c`, step 2 of 9. **Revised 2026-08-25, same day, same step:** the orchestrator rewound the chain to step 1 and re-ran steps 1 and 2, so this spec is amended in place rather than rewritten. Three of its own factual claims were wrong and are corrected below, marked in place. **Revised again 2026-08-25 (fourth iteration), after review:** the payload was found to fail **open** as well as under-tested, so Phase 3a now closes a behaviour defect and not only a coverage gap, the `supersede` proposed against `specs-6075b87dbdfe` was found unapplyable and is replaced by an in-place correction, and two verification steps that could pass on no evidence were made fail-closed. Executed
2026-08-25 for run 7d982c23; this revision is the tree the five repository gates ran against. The
pushed SHA is recorded in the run report and in git log, not here.
**Date:** 2026-08-25
**Repo:** `cezar` (spec authored in worktree `.ai/cezar/worktrees/7d982c23-…`, HEAD `b3d3a44c`; the work it describes happens in the real checkout `/var/lib/cezar/loki-labs/cezar`, branch `main`).
**Brief:** `.ai/specs/briefs/2026-08-25-ship-workspace-revision-attestation.md`, written by step 1 of this run and itself rewritten in its own second iteration. Every claim it makes was re-derived here from the repository itself; four of them are corrected below. The brief's own two corrections *to this spec* were re-checked live: one holds (the tree sha moved), one is right about the diagnosis and is folded into Correction 4, and one claim it repeats from this spec's first draft — that todo `1d8922bb` does not exist — is **false**, see Correction 2.

**Ships, does not supersede:** `.ai/specs/2026-08-25-workspace-revision-attestation.md`, currently readable only in worktree `.ai/cezar/worktrees/2914e8d5-…` at commit `8a4b6a3c`. That spec owns the design, the data model and the feature's own verification. This spec owns exactly one thing that spec does not: getting its 10 files out of an isolated worktree and into `origin/main` without destroying the unrelated, unshipped work sitting in the shared checkout.

**Reads against:** `.ai/specs/2026-08-20-steps-green-only-when-verified.md` (post-conditions are machine-checked gates), `.ai/specs/2026-08-24-manual-deploy-not-a-bug.md` (commit `ea40c7a1`, on `origin/main`: a parked `deploy` step is the expected terminal state), `.ai/specs/2026-08-24-bulk-start-filed-tasks.md` (commit `7932cf4d`, on `origin/main`), `AGENTS.md:7` on `origin/main` (standing `git push origin main` authorization), KB `specs-6075b87dbdfe` (names this gap as its P3).

## TLDR

The feature is built, tested and committed already, as `8a4b6a3c` on branch `cez/2914e8d5`, unpushed. This run is a reconciliation job, not a build job. Three things stand between that commit and `origin/main`:

1. The shared checkout at `/var/lib/cezar/loki-labs/cezar` is **31 commits behind `origin/main`** (`d217ab2e`; the first draft of this spec measured 28 behind `00a202b8` hours earlier), fast forwardable (`merge-base HEAD origin/main` == `HEAD` == `b3d3a44c`). Treat that number as a reading, not a constant: `origin/main` moves under this spec.
2. It carries **13 dirty paths of unrelated work**, and the brief treats them as one body. They are **two**, and only one is disposable. One is a superseded draft of work already merged as `7932cf4d`. The other, "workspace tasks ship themselves", exists **nowhere else in the repository**: `git log --oneline --all -- .ai/specs/2026-08-24-workspace-tasks-ship-themselves.md` returns empty, and no branch or worktree holds it. Discarding it destroys unshipped work.
3. A **staged** file, `.ai/specs/2026-08-24-bulk-start-filed-tasks.md`, sits at a path that `7932cf4d` already added on `origin/main`. `git read-tree -n -m HEAD origin/main` refuses: `error: Entry '.ai/specs/2026-08-24-bulk-start-filed-tasks.md' would be overwritten by merge. Cannot merge.` A fast forward aborts before doing anything. (The first draft blamed an *untracked* file at `.ai/specs/briefs/2026-08-24-ship-bulk-start-filed-tasks.md` instead; `origin/main` tracks nothing at that path. See Correction 4.)

The plan: dump every dirty byte to a patch outside the repo, stash it under a named message, fast forward to `origin/main`, cherry pick `8a4b6a3c`, close the payload's own two-project coverage gap **and its fail-open capture path** (Phase 3a — as committed, a git failure in any project worktree erases the attestation, leaves `run-tests` green and makes `commit-push` unconditionally pass), run the focused gate and all five repository gates — every one of them environment-scrubbed — on the exact tree to be committed, make one `fix:` commit, push with an explicit refspec to `origin main`, and stop. Both deploy targets are `manual: true`, so this run reports a revision and parks. The feature is **QA Needed** until Verification 7a — the payload's own two-project runtime fixture, still unexecuted — passes.

## Problem

### What the feature fixes, in one paragraph

`tested-revision-shipped` snapshots and verifies only the run cwd. For a workspace run that cwd is the shared scratch repo, not the per project worktrees where the change actually lives. Run `2914e8d5` attested four untracked scratch control files (`.cezar-control-path`, `.cezar-gate-path`, `cezar-control-171c8647.log`, `cezar-gates-171c8647.log`) and then rejected its own valid `cezar` commit because those files were absent from scratch `HEAD`. The fix adds an optional `projects` array to `TestAttestation` and verifies each project against its own worktree `HEAD`. Full design: `.ai/specs/2026-08-25-workspace-revision-attestation.md`.

### What this run has to solve

The payload is `8a4b6a3c` ("cezar autosave (run finalize)"), 10 files, +488/-7:

```
.ai/specs/2026-08-24-default-workflow-ten-stages.md      |   2 +-   (status line only)
.ai/specs/2026-08-24-manual-deploy-not-a-bug.md          |   4 +-   (status line only)
.ai/specs/2026-08-25-workspace-revision-attestation.md   | 176 +++  (the feature spec)
CHANGELOG.md                                             |   9 ++
packages/cezar/src/workflows/postconditions.test.ts      |  50 ++
packages/cezar/src/workflows/postconditions.ts           |  40 ++
packages/cezar/src/workflows/run.test.ts                 | 108 ++
packages/cezar/src/workflows/run.ts                      |  69 +-
packages/contract/src/runs.test.ts                       |  26 ++
packages/contract/src/runs.ts                            |  11 ++
```

It must land in the shared checkout as **one** properly named commit, not as an autosave message, and not as many small commits (global CLAUDE.md, "one commit per session/feature"; this task's own acceptance criteria, "exactly one feature commit").

### The dirty state, measured

`git status --short` in `/var/lib/cezar/loki-labs/cezar`, 2026-08-25:

```
A  .ai/specs/2026-08-24-bulk-start-filed-tasks.md
A  .ai/specs/2026-08-24-workspace-tasks-ship-themselves.md
M  AGENTS.md
M  packages/cezar/src/workflows/run.ts
M  packages/cezar/src/workspace/granted-roots.test.ts
M  packages/cezar/src/workspace/granted-roots.ts
M  packages/cezar/src/workspace/workspace-worktrees.test.ts
M  packages/cezar/src/workspace/workspace-worktrees.ts
M  packages/web/src/lib/filed-tasks.test.ts
M  packages/web/src/lib/filed-tasks.ts
M  packages/web/src/routes/global-tasks.test.tsx
M  packages/web/src/routes/global-tasks.tsx
?? .ai/specs/briefs/2026-08-24-ship-bulk-start-filed-tasks.md
```

`git diff --cached --stat HEAD` reports 12 files, 735 insertions, 15 deletions. For every one of the 12, the working tree blob equals the index blob (checked per path with `git hash-object` against `git rev-parse :<path>`), so there is no third, unstaged layer to lose.

**Body A, superseded and disposable.** `.ai/specs/2026-08-24-bulk-start-filed-tasks.md`, `packages/web/src/lib/filed-tasks.{ts,test.ts}`, `packages/web/src/routes/global-tasks.{tsx,test.tsx}`. `origin/main` carries commit `7932cf4d` ("feat: bulk start filed tasks"), which adds a further developed version of the same spec (71 lines) and the same four source files. The staged copy is an older draft of merged work.

**Body B, unshipped and unique.** `.ai/specs/2026-08-24-workspace-tasks-ship-themselves.md` (+101), `AGENTS.md` (+4), `packages/cezar/src/workflows/run.ts` (+5, a `shipped` apply outcome note), `packages/cezar/src/workspace/granted-roots.{ts,test.ts}`, `packages/cezar/src/workspace/workspace-worktrees.{ts,test.ts}`. `git log --oneline --all` on that spec path is **empty**. `git worktree list` shows 29 worktrees and none holds it. This is the only copy.

## Corrections to the brief

Four claims in `.ai/specs/briefs/2026-08-25-ship-workspace-revision-attestation.md` are settled or wrong. Recording them here so the implement step does not re-derive them, and so nobody acts on the stale versions.

**1. Open question 2 is settled: cherry pick, and it applies cleanly.** The brief calls the conflict risk "real and unverified from here". It is verified now, non destructively. `git merge-base origin/main 8a4b6a3c` is `ea40c7a1`, which is exactly `8a4b6a3c^`, so a three way merge of `origin/main` with `8a4b6a3c` *is* the cherry pick. `git merge-tree --write-tree --messages origin/main 8a4b6a3c` exits 0, reports only `Auto-merging packages/cezar/src/workflows/run.ts` and `Auto-merging packages/cezar/src/workflows/run.test.ts`, and reports no conflicts. Re-verified against `origin/main` at `d217ab2e`: still exit 0, still those two auto-merges, still no conflicts, and `merge-base` is still exactly `ea40c7a1` == `8a4b6a3c^`. No `reset --hard` and re-apply is needed; commit provenance is preserved.

**The invariant is the command, not its output.** The first draft of this spec hard-coded the resulting tree as **`b3d48e32f37f811a70efafa2e7cca0686fa61af0`**. Three commits later on `origin/main` (`fe4287c2`, `f153b537`, `d217ab2e`) the same clean merge writes **`53b9f093f0d7ef931b0f49df1b0ce9d4fd8f7e76`** instead. Nothing is wrong with the merge: the *base* moved, so the result moved with it. A quoted hash is therefore a trap in a spec that outlives one fetch. Phase 2 recomputes the expected tree live, in the same shell, seconds before comparing it. **Neither hash written above may be used as the expected value.**

**2. The `1d8922bb` baseline failure is moot, and must not be reported as a live baseline.** The feature spec's Executed log says `npm run test:unit` "failed 8 of 53 in `deploy-e2e-probe.test.ts`", reproduced on clean `e38cb619`, "tracked by todo `1d8922bb`". Two facts:

- **CORRECTED 2026-08-25 — the todo is real, and it is obsolete rather than absent.** ~~`cezar todo list` does not contain `1d8922bb`, and the only files on this box matching that string are this run's own transcript and the brief. The id is unverifiable. Do not cite it as tracking anything.~~ That was wrong, and both iterations of the brief repeated it. `.ai/cezar/todos.json` (183 items) holds `1d8922bb-339e-49d1-b8ee-359a1dfd1db7`, *"Fix broken test:unit suite: deploy-e2e-probe.test.ts (8/9 failing)"*, status `todo`, priority `medium`, filed `2026-08-24T23:52:14Z` by the parent run `2914e8d5` from its own `run-tests` step, with the exact repro command in its context field. A `cezar todo list` reporting 89 items was filtering, not contradicting. So the id does track something — it tracks a file `origin/main` deleted six minutes later. It is **moot, not missing**, and Phase 5 closes it with that reason instead of ignoring it.
- The failing file is `packages/cezar/test/unit/deploy-e2e-probe.test.ts`, added by autosave `83ddbdd2` (2026-08-23 19:26) and **deleted on `origin/main` by `7932cf4d`** (2026-08-24 23:58), deliberately: Phase 3 of `.ai/specs/2026-08-24-bulk-start-filed-tasks.md` on `origin/main` reads "Remove the superseded string-contract deploy-probe unit suite. Keep the newer structured-contract…", and its verification says "Delete the superseded unit copy and retain the stronger seven-scenario package suite." The replacement is `packages/cezar/test/e2e/deploy-e2e-probe.test.ts` (407 lines, added by `587db317`), which runs under `test:package` (`node --import tsx --test test/e2e/*.test.ts`), not `test:unit` (`test/unit/*.test.ts`).

So the parent measured that baseline at `e38cb619`, which predates the deletion. **After reconciliation `npm run test:unit` must be expected clean**, and a red there is a new regression, not the known baseline. The file will vanish from disk when the checkout fast forwards. That is correct. Do not restore it.

**3. There is a doctrine contradiction inside Body B, and it points the opposite way from this task.** The staged `AGENTS.md` edit inserts, above the standing authorization paragraph:

> **SUPERSEDED 2026-08-24 by the owner's workspace shipping correction.** `cezar` is now the one repository a task does not commit, merge, push or deploy by itself. Cezar work remains isolated for protected settlement.

and the staged `.ai/specs/2026-08-24-workspace-tasks-ship-themselves.md` says the same: "every task may commit, merge, push and deploy its own work in every repository except `cezar`". The workspace level `/var/lib/cezar/loki-labs/CLAUDE.md` agrees, naming `cezar/` as the sole exclusion. Read literally, that forbids what this task instructs.

It does not block this run, for three reasons that should be stated rather than assumed:

- **It is unshipped.** Neither the `AGENTS.md` edit nor that spec exists on `origin/main` or on any branch. The published doctrine is `origin/main`'s `AGENTS.md:7`, reaffirmed six hours before `7932cf4d` by `ea40c7a1`: "The commit and `git push origin main` authorization below is current and unchanged; only the deploy claim is stale."
- **The exclusions are about different subjects.** The workspace rule governs a *workspace run* self shipping *another* project's worktree; cezar's own `AGENTS.md` governs *developing cezar*. This run is the second case: a project run on `cezar`, in an isolated worktree, shipping a change to cezar itself.
- **The task text is an explicit current owner instruction** to "make one feature commit, and push explicitly to origin main". An explicit instruction outranks an ambient default.

Consequence for scope: the `AGENTS.md` hunk in Body B is a **doctrine change and is out of scope for this commit**. It stays stashed. Phase 5 files it for the owner rather than shipping or dropping it.

**4. A fast forward will abort before doing anything — but not for the reason the first draft gave.** ~~The untracked `.ai/specs/briefs/2026-08-24-ship-bulk-start-filed-tasks.md` (203 lines, blob `41bf79ab`) collides with a tracked 1330 line file at the same path on `origin/main`, added by `7932cf4d`. Git refuses to overwrite an untracked working tree file.~~ **Wrong, corrected 2026-08-25.** `origin/main` tracks 51 files under `.ai/specs/briefs/` and **none of them is `2026-08-24-ship-bulk-start-filed-tasks.md`** — `git ls-tree origin/main -- .ai/specs/briefs/2026-08-24-ship-bulk-start-filed-tasks.md` prints nothing. That untracked file collides with nothing and would survive a fast forward untouched.

The real blocker is one directory up, and it is **staged**, not untracked. `git read-tree -n -m HEAD origin/main` fails with:

```
error: Entry '.ai/specs/2026-08-24-bulk-start-filed-tasks.md' would be overwritten by merge. Cannot merge.
```

That is Body A's spec file, sitting in the index at the same path `7932cf4d` adds on `origin/main`. Git refuses to discard a staged entry, which is a stronger and more useful refusal than the untracked-file one: it is protecting work that was deliberately staged.

The consequence for the plan is nil, which is why this is a correction and not a redesign — Phase 0 stashes everything staged *and* untracked, clearing the real blocker and the imagined one alike. It matters for two things only: what the implement step should *say* when it hits or pre-empts the abort, and not sending it hunting for an untracked-file problem that does not exist.

## Solution

Five ordered, independently checkable steps, each leaving the checkout in a state a human can inspect:

1. **Preserve** every dirty byte twice: as patch files under `.ai/cezar/runs/` (gitignored, outside the commit) and as one named stash entry whose commit sha is recorded.
2. **Reconcile** the checkout to `origin/main` by fast forward, with the tree otherwise clean.
3. **Apply** `8a4b6a3c` by `cherry-pick --no-commit`, verify the resulting tree against the pre computed sha, then add this spec and this run's brief, and correct the three stale status lines in place (Phase 2 step 5) so the commit does not publish a status that was false when it landed.
3a. **Repair the payload** before gating it: it is not only under-tested with one project, it fails **open** — a git failure in any granted worktree erases the attestation, leaves `run-tests` green and hands `commit-push` an unconditional pass. Fix that seam, unify the three hand-written copies of the `projects` shape onto the contract type, and cover both with tests, all inside the same commit.
4. **Gate** on the exact tree that will be committed, recording the tree sha before and after so nothing moved between testing and committing. This is the property the feature itself exists to enforce, so this run should honour it by hand.
5. **Commit once, push with an explicit refspec, stop.** Report the pushed sha for human blue-green activation. No deploy.

Preservation is patch plus stash rather than `git stash` alone because a stash lives in the repo reflog and can be pruned or clobbered by a concurrent task in this shared checkout. Nothing is discarded, including Body A, whose supersession is an inference this spec makes and not an owner decision.

## Architecture

### The three git states, and the transitions between them

```
  S0  shared checkout, as found
      HEAD = b3d3a44c (31 behind origin/main d217ab2e, and still moving)
      index = HEAD + 12 modified/added paths (Body A + Body B)
      worktree = index, plus 1 untracked collider
                 |
                 |  Phase 0: patch dump -> .ai/cezar/runs/ ; git stash push -u -m "preserve: ..."
                 v
  S1  clean at b3d3a44c, stash@{0} holds Body A + Body B + collider
                 |
                 |  Phase 1: git fetch origin ; git merge --ff-only origin/main
                 v
  S2  clean at origin/main (d217ab2e or later)
                 |
                 |  Phase 2: EXPECTED=first line of `git merge-tree --write-tree --messages …`
                 |           git cherry-pick --no-commit 8a4b6a3c   -> write-tree == $EXPECTED
                 |           + git add this spec + this run's brief + status corrections
                 v
  S3  staged feature tree, uncommitted            <-- Phase 3 gates run HERE (scrubbed)
                 |
                 |  Phase 4: one commit ; git push origin HEAD:refs/heads/main
                 v
  S4  clean, pushed, ahead 0 / behind 0 ; stash@{0} still present
```

`S4` is the terminal state for this run. Production is untouched. A human then deploys **from a fresh detached worktree checked out at the pushed sha**, never from this shared checkout and never from this task's worktree, and requires `/api/v1/ready` to report that exact sha — the full procedure and the measured reason are in Phase 5 step 1 (KB `notion-8d2aa351272c`: `--sha` labels the release, it does not check anything out).

### Why the gates run at S3 and not at S4

`tested-revision-shipped`, the post-condition this very feature repairs, is green only when the tested tree equals the shipped tree. Committing and then testing inverts that. Testing at S3 and committing an unchanged tree makes the property true by construction, and Phase 3 records both tree shas so it is provable rather than assumed.

`packages/cezar/dist/` and `.ai/cezar/` are gitignored (`.gitignore:11`), so `npm run build` writing `dist/.build-stamp.json` and the Phase 0 patch dump both leave the tree sha untouched.

### Where the patches live

`.ai/cezar/runs/` is one of this run's granted additional working directories and is gitignored, so artifacts written there are durable, outside the commit, and outside settlement.

## Phases

### Phase 0: preserve the dirty state, and unblock the merge

Independently shippable: after it, the checkout is clean at `b3d3a44c` and every byte is recoverable two ways.

1. Re-measure first, because this is a shared checkout and another task may have moved it: `git -C <repo> status --porcelain` and `git -C <repo> rev-parse HEAD`. If the path set differs from the 13 listed in Problem, stop and re-derive rather than stashing a set nobody looked at.
2. `mkdir -p /var/lib/cezar/loki-labs/cezar/.ai/cezar/runs/7d982c23-preserved`
3. `git -C <repo> diff --cached HEAD > …/7d982c23-preserved/staged-vs-HEAD.patch`
4. `git -C <repo> diff HEAD > …/7d982c23-preserved/worktree-vs-HEAD.patch` (expected identical to the above; capture it anyway rather than trusting the equality measured today).
5. `cp <repo>/.ai/specs/briefs/2026-08-24-ship-bulk-start-filed-tasks.md …/7d982c23-preserved/untracked-brief-2026-08-24-ship-bulk-start-filed-tasks.md`. This file is untracked and, per Correction 4, collides with nothing on `origin/main` — it is copied to preserve it, not to unblock the merge. The path that actually blocks the merge is the **staged** `.ai/specs/2026-08-24-bulk-start-filed-tasks.md`, and step 3's patch dump already holds it.
6. `git -C <repo> stash push --include-untracked --message "preserve: unrelated staged work before shipping workspace revision attestation (task 7d982c23)"`, limited by an explicit pathspec listing exactly the paths from step 1 so no unrelated untracked file elsewhere in the shared checkout is swept in.
7. Record `git -C <repo> stash list` and `git -C <repo> rev-parse stash@{0}` into `…/7d982c23-preserved/stash.txt`. The sha survives a `stash drop`; the name does not.
8. Assert `git -C <repo> status --porcelain` is empty.

**Never** `git checkout .`, `git reset --hard`, or `git stash drop` in this phase.

### Phase 1: reconcile to `origin/main`

1. `git -C <repo> fetch origin`
2. `git -C <repo> merge --ff-only origin/main`
3. Assert `git -C <repo> rev-parse HEAD` equals `git -C <repo> rev-parse origin/main`, and `git -C <repo> status --porcelain` is empty.
4. Assert `packages/cezar/test/unit/deploy-e2e-probe.test.ts` is now **absent**. Its disappearance is the deliberate deletion from `7932cf4d`, not damage.

`origin/main` **has already advanced twice while this spec was being written** (`00a202b8` → `d217ab2e`, three commits, within hours). Expect it to have advanced again. That is fine: the cherry pick is a three way merge, and Phase 2 derives its tree assertion from whatever `origin/main` is at that moment rather than from a hash quoted here (see its step 0). Record the sha actually fast forwarded to, and use that same sha in the Phase 3 and Phase 4 reports.

### Phase 2: apply the feature as one staged tree

0. **Compute the expected tree first, from the base you actually landed on — and parse it, do not swallow it.** `merge-tree --messages` prints **more than a tree id**. Measured 2026-08-25 against `origin/main` `d217ab2e`, its stdout is four lines: the 40-character tree id, a blank line, then `Auto-merging packages/cezar/src/workflows/run.test.ts` and `Auto-merging packages/cezar/src/workflows/run.ts`. Assigning that whole output to `EXPECTED` guarantees the later `[ "$(git write-tree)" = "$EXPECTED" ]` fails, on a merge that is perfectly clean. Capture the output, check the exit status and the conflict lines separately, then extract the first line and validate its shape:

   ```bash
   MT=$(git -C <repo> merge-tree --write-tree --messages origin/main 8a4b6a3c); MT_RC=$?
   printf '%s\n' "$MT"                              # keep the whole thing in the report
   [ "$MT_RC" -eq 0 ] || { echo "merge-tree exit $MT_RC — STOP, do not cherry-pick"; exit 1; }
   printf '%s\n' "$MT" | grep -q '^CONFLICT' && {
     echo "merge-tree reported CONFLICT — STOP, do not cherry-pick"; exit 1; }
   EXPECTED=$(printf '%s\n' "$MT" | head -1)
   printf '%s' "$EXPECTED" | grep -qE '^[0-9a-f]{40}$' || {
     echo "first line of merge-tree output is not a tree id: '$EXPECTED' — STOP"; exit 1; }
   echo "expected tree: $EXPECTED"
   ```

   A non-zero exit or any `CONFLICT` line means the clean-apply premise of Correction 1 no longer holds; stop and re-derive rather than forcing it. The `Auto-merging` lines are informational and are **not** a failure — expect exactly those two, and say so if the set differs. Record both `$MT` and `$EXPECTED` in the report. Do **not** substitute `b3d48e32…` or `53b9f093…` from this document — both are historical readings against bases that have moved.
1. `git -C <repo> cherry-pick --no-commit 8a4b6a3c`. The object is reachable from the shared checkout (all worktrees share one object database), so no fetch or format-patch is needed.
2. Assert no conflict markers and no unmerged paths: `git -C <repo> diff --name-only --diff-filter=U` is empty.
3. Assert `[ "$(git -C <repo> write-tree)" = "$EXPECTED" ]`. A mismatch here means the working tree was not what `merge-tree` modelled — another task wrote to the shared checkout between step 0 and step 1. Re-measure and re-derive; do not `reset --hard` to make the hashes agree.
4. Copy this spec (`.ai/specs/2026-08-25-ship-workspace-revision-attestation.md`) and this run's brief (`.ai/specs/briefs/2026-08-25-ship-workspace-revision-attestation.md`) from this worktree into the checkout and `git add` them.
5. **Correct the stale status lines in place, before the final staged tree is recorded.** The commit this run publishes must not carry a status that was already false when it landed. Three files, all already in the staged set, so none adds a path:

   - **The parent feature spec**, `.ai/specs/2026-08-25-workspace-revision-attestation.md`. Its lead currently reads *"Four of five repository gates are green. `npm run typecheck` … `npm run test:unit` retains the eight pre-existing `deploy-e2e-probe.test.ts` failures reproduced on clean `e38cb619`"*. That baseline is obsolete: `7932cf4d` deleted the file (Correction 2), so `test:unit` is expected clean on `origin/main` and the "four of five" count is wrong going forward. Replace it with what is true at the moment the tree is sealed and nothing more — that the obsolete baseline was deleted from `origin/main` by `7932cf4d`, and that this revision is gated on all five repository gates on the reconciled base — using an in-place `**CORRECTED 2026-08-25**` lead-in that leaves the original sentence below it unchanged, per the workspace correction doctrine. It must **not** say the gates passed, and must not name a sha: at the time these bytes are written neither is known.
   - **This spec's own header**, which says `Not implemented.` A commit that permanently publishes that sentence about itself is a defect. But the replacement cannot claim a push either: these bytes are written *before* the gates run and long before the push, so any sentence asserting an outcome is a lie at the moment it is committed and stays one if the run stops. Write only what the commit itself makes true: `Executed 2026-08-25 for run 7d982c23; this revision is the tree the five repository gates ran against. The pushed SHA is recorded in the run report and in git log, not here.` Nothing about gate results, nothing about `origin/main`, no sha.
   - **`.ai/specs/2026-08-24-default-workflow-ten-stages.md`**, whose heading *"P3. Nothing proves the tested revision is the shipped revision"* and body status *"Partial 2026-08-24 … commit and push are blocked"* stop being true for workspace runs with this commit. This is the correction Phase 5 step 5 would otherwise have proposed as a KB `supersede`, which **cannot be applied** — the document is on the read-only `specs` mount, see that step for the measurement. It is corrected here instead, with an editor, because it must ride inside the tested tree rather than arrive after the commit. The file is already one of the payload's 10 paths, so this adds nothing to the staged set. Amend the heading, since the falsehood is in the heading and every session scans headings; leave the original body text below a dated bolded lead-in; point at `.ai/specs/2026-08-25-workspace-revision-attestation.md`; name no sha.

   **Stage the corrections, or they do not exist.** All three files were `git add`ed moments ago — the parent spec and the ten-stages spec by the cherry-pick in step 1, this spec by step 4 — so editing them now writes the worktree and leaves the **index** holding the old text. Left there, `write-tree` in step 0 of Phase 4 hashes the stale index, the gates run against the stale index, the commit publishes the stale index, and `git status` ends the phase with three unstaged files nobody looked at. So, immediately after the edits:

   ```bash
   CORRECTED=(.ai/specs/2026-08-25-workspace-revision-attestation.md
              .ai/specs/2026-08-25-ship-workspace-revision-attestation.md
              .ai/specs/2026-08-24-default-workflow-ten-stages.md)
   git -C <repo> add "${CORRECTED[@]}"
   [ -z "$(git -C <repo> diff --name-only)" ] || { echo "unstaged changes remain — STOP"; exit 1; }
   ```

   That unstaged-empty assertion is the one that makes `T0` mean anything, and it must hold again after Phase 3a's amendments, immediately before `T0` is taken.

   **All three edits are wording written before the state exists, so all three are conditional — and none may name a sha.** They go in here, ahead of Phase 3's `T0`, because the tested tree must be the committed tree; writing them after the gates would break that property. The commit sha is unknowable at this point and must **not** be guessed or back-filled: the sha lives in the Phase 5 report and in `git log`, not in a status line.

   **Rollback needs the pre-correction bytes recorded first, because `git checkout --` will not produce them.** If execution stops anywhere before the push — a red gate, a mismatched tree, a rejected push — these edits must not be left behind. `git checkout -- <path>` restores the worktree **from the index**, and after the `git add` above the index holds the *corrected* text, so it restores exactly what it was meant to undo. `git checkout HEAD -- <path>` is no better: for this spec there is no `HEAD` version at all, since the file is new in this commit, and for the other two `HEAD` is the pre-cherry-pick blob, which would silently revert the payload as well. So snapshot the originals before editing and restore both layers explicitly:

   ```bash
   PRES=/var/lib/cezar/loki-labs/cezar/.ai/cezar/runs/7d982c23-preserved
   for p in "${CORRECTED[@]}"; do cp "<repo>/$p" "$PRES/precorrection-$(basename "$p")"; done
   # …edits, then git add "${CORRECTED[@]}", as above…
   # on any stop before the push — restores worktree AND index, and nothing else:
   for p in "${CORRECTED[@]}"; do cp "$PRES/precorrection-$(basename "$p")" "<repo>/$p"; done
   git -C <repo> add "${CORRECTED[@]}"
   [ "$(git -C <repo> write-tree)" = "$T_PRECORRECTION" ] || echo "rollback did not restore the pre-correction tree — inspect before doing anything else"
   ```

   Take `T_PRECORRECTION=$(git -C <repo> write-tree)` immediately before the first edit, so the rollback has something to prove itself against rather than being trusted. Both copies go under `.ai/cezar/runs/`, which is gitignored, so they never enter the tree they are protecting. A status claiming gates and a push that did not happen is worse than the stale one it replaced; a rollback that silently restores the corrected text is the same defect wearing a cleanup's clothes.
6. Assert the staged path set is exactly the 10 files of `8a4b6a3c` plus those 2, and that **`AGENTS.md` is not among them**. Body B's doctrine edit must not ride along. Record it for the Phase 4 re-check: `git -C <repo> diff --cached --name-only origin/main | sort > /tmp/staged-at-phase2.txt`, and copy that file into `…/7d982c23-preserved/` so it outlives `/tmp`.

### Phase 3: gates, on the exact tree to be committed

#### 3a. Close the payload's own coverage gap and its fail-open capture path first

The payload's Verification section (in `.ai/specs/2026-08-25-workspace-revision-attestation.md`, item 2 and item 4) promises *"a workspace run with **two** project worktrees records two trees"* and *"changing source after testing in **either** project fails and **names that project** and path"*. The tests as committed in `8a4b6a3c` do not deliver that. Read directly from the commit:

- `packages/cezar/src/workflows/run.test.ts` — `'records project worktrees and excludes scratch control files from their trees'` sets **one** `workspaceWorktrees` entry and asserts `toHaveLength(1)` and the note `tests attested 1 project trees`.
- `packages/cezar/src/workflows/postconditions.test.ts` — `'checks workspace project trees instead of scratch runner artifacts'` builds **one** project, and `'fails closed when an attested workspace worktree is gone'` names **one** root.

With one project, the two properties that matter most cannot fail: the implementation's deterministic ordering, `[...(run?.workspaceWorktrees ?? [])].filter(w => !w.reclaimedAt).sort((a, b) => a.root.localeCompare(b.root))` (`run.ts`, added by `8a4b6a3c`), is unobservable, and the per-project attribution in `failures.push(\`${project.root}: ${outside.join(', ')}\`)` (`postconditions.ts`, same commit) is trivially satisfied because there is only one candidate root. Amend the two existing test files for items 1 to 3, and the two implementation files plus the contract for items 4 to 6 — **no new paths**: every file named below is already one of the payload's 10, and all of it rides in the same commit:

1. **Runner, two projects, deterministic order.** Give the run two `workspaceWorktrees` entries whose roots sort in the opposite order to the array order (register `z-…` before `a-…`). Assert `projects` has length 2, that `projects.map(p => p.root)` is the `localeCompare` order and not the insertion order, that neither tree contains the scratch-only `.cezar-control-path`, and that the emitted note reads `tests attested 2 project trees`.
2. **Post-condition, a change in *either* project names *that* project.** Build two real project repos, attest both, assert `ok: true`. Then commit a source change in project **A** only and assert `ok: false` with `detail` containing A's root and its path and **not** B's; reset, commit a change in **B** only, and assert the mirrored result. One-sided coverage is what lets a mis-indexed loop pass.
3. **Record-only control, unchanged.** The existing `pathIsShippingRecord` behaviour (a post-test spec or changelog edit stays green) must still hold with two projects — assert it for a record-only change in each.

**The payload also fails open, and that is a behaviour defect rather than a coverage one.** It is not reachable by the two-project tests above, so it is listed separately and must be fixed in the same commit. Read from the commit, not from memory (`git show 8a4b6a3c:packages/cezar/src/workflows/run.ts`):

4. **A failed capture must make `run-tests` red.** `recordTestAttestation` opens by *erasing* the prior evidence — `this.store.updateRun(runId, { testAttestation: undefined })`, with the comment "A failed fresh capture must not leave an older green tree authorizing this test attempt" — and then `return`s on **two** failure paths without writing any replacement: the pre-existing scratch `add -A` / `write-tree` failure at the top, and, new in this commit, a per-project `write-tree` failure inside the worktree loop that emits `could not record test attestation for ${worktree.root}` and returns from the whole method. Both call sites, `run.ts:5674` and `run.ts:5716` in the payload, are

   ```ts
   if (step.id === 'run-tests') await this.recordTestAttestation(runId, state, step.id, emit);
   if (step.id === 'commit-push') await this.recordShippedAttestation(runId, state, step.id, emit);
   this.finishStep(runId, step.id, 'done', undefined, emit);
   ```

   — the capture returns `Promise<void>`, so `'done'` is unconditional. And `testedRevisionShipped` opens with `if (!attestation) return { ok: true, detail: 'no test attestation was recorded, so no earlier revision can be contradicted' }`. The three compose into a fail-open: a git failure in **any** granted worktree deletes the previous attestation, leaves `run-tests` green, and hands `commit-push` an unconditional pass. That inverts the property the feature exists to enforce, and it is strictly worse than the bug being fixed, which at least attested *something*. The payload's own spec calls itself fail-closed; as committed, it is not.

   Change the capture to return a structured result instead of `void`:

   ```ts
   type AttestationCapture = { ok: true } | { ok: false; reason: string };
   ```

   Route **both** call sites through one shared helper so the duplicated pair cannot drift — they are already byte-identical two-line blocks in two branches of the same step loop. On `ok: false`, `run-tests` finishes `'failed'` with that reason (the project root included in it, where a project caused it), `runError` is set the way a failed post-condition sets it, and the loop breaks so `commit-push` and every later step are never reached. Give `recordShippedAttestation` the same treatment: today a project whose `rev-parse HEAD` fails is silently kept **without** `shippedSha` (the `: project` arm of its `Promise.all` map) while the step still emits `shipped revision attested at …`, so a half-attested workspace reports success. It must report failure and name the project root.

   **Preserve the allowance for genuinely old records.** `if (!attestation) return { ok: true, … }` in `testedRevisionShipped` stays, because runs persisted before this field existed must still resume. What changes is that a *failed capture in this run* can no longer reach that branch: the step is already red, so nothing downstream consults the attestation at all. Do not swap the post-condition to fail-closed on absence — that would break resume for old records, which is a compatibility surface this repo does keep (`@loki-labs/cezar-plus` is published).

   Tests, in the two files already being amended: scratch capture failure leaves `run-tests` red with no attestation stored; an attested-but-vanished active project worktree, and a worktree path that exists but is not a git repository, each leave `run-tests` red **and name that project root in the failure text**; a stale attestation from an earlier attempt is cleared *and* the step goes red rather than green-with-nothing; `commit-push` and the steps after it are left `pending`, never `done`. Assert the step status and the absence of the later steps, not only the emitted note — the note is what already exists and it is not what made the run green.

5. **Delete the hand-written `WorkspaceTestAttestation` copy before this ships.** The payload adds it at `run.ts:152` with the comment *"The additive workspace fields are local too, so an isolated worktree can typecheck before its sibling contract package has been applied back to the shared checkout used by node resolution."* That justification expires at Phase 2. Once the cherry-pick lands, the same tree carries `packages/contract/src/runs.ts` with `testAttestationProjectSchema` and `projects: z.array(testAttestationProjectSchema).min(1).optional()` inside `testAttestationSchema`, and `run.ts:126` already imports the inferred `TestAttestation` from `@loki-labs/cezar-plus-contract`. Use that type directly and delete the local alias, the `NonNullable<WorkspaceTestAttestation['projects']>` annotation at `run.ts:5925`, and the `as WorkspaceTestAttestation | undefined` cast at `run.ts:5979` — a cast that would otherwise sit permanently on top of a type that already has the field, and that suppresses exactly the errors typecheck exists to raise.

6. **Type `PostconditionContext.attestation` from the contract too.** The payload grows that inline interface in `postconditions.ts` by hand-copying the same five-field `projects` shape into it, making a **third** copy of one schema. Replace the inline object with the inferred contract type. The repository's invariant is one Zod schema per shape with the TypeScript type inferred from it; three hand-written copies is precisely how the runtime validation and the compile-time type drift apart, and after that a red `npm run typecheck` is the only thing that would notice. `npm run typecheck` in Phase 3b is what proves the unification is complete.

These amendments are part of the tree that Phase 3b gates and Phase 4 commits. If they cannot be made green, that is a red on the payload and the run stops; it is not a reason to ship the weaker coverage and file a follow-up.

`git add` every file amended above before taking `T0` — the two test files, `packages/cezar/src/workflows/run.ts`, `packages/cezar/src/workflows/postconditions.ts` and `packages/contract/src/runs.ts` — then assert `git -C <repo> diff --name-only` (unstaged) is **empty**, and re-assert that the staged path set still matches `/tmp/staged-at-phase2.txt`. All five are already in the payload, so amending them must change **blobs, not paths**. A new path here means something else was picked up; an unstaged leftover means `T0` is about to certify a tree that is not the one on disk.

#### 3b. Run every gate under the scrubbed environment

**The environment must be scrubbed, and the reason is measured, not precautionary.** `AGENTS.md:285-296` on `origin/main` records that **only root `npm test` scrubs itself** — `packages/cezar/vitest.setup.ts` unsets ambient `CEZ_*` except `CEZ_HANDOFF_FILE`/`CEZ_TASK_ID` and repoints `TMPDIR`/`TMP`/`TEMP`, but it is wired into the `server` vitest project only. `typecheck`, `test:unit`, `build` and `test:package` have **no scrub at all**, and a live agent environment produces plausible failures there that read as "this suite cannot run here" (trap 4, `TMPDIR` inside a git repo, was worth 17 of 19 failures on a docs-only branch). Build the scrub once and use it for the focused command and all five gates:

```bash
scrub=$(env | sed -n 's/^\(CEZ_[A-Z0-9_]*\)=.*/\1/p' \
        | grep -vxE 'CEZ_(HANDOFF_FILE|TASK_ID)' | sed 's/^/-u /')
tmp=/tmp/cez-gate-7d982c23-$$ && mkdir -p "$tmp"   # OUTSIDE every git repo, on real /tmp
G() { env -u NODE_ENV $scrub TMPDIR="$tmp" TMP="$tmp" TEMP="$tmp" "$@"; }
```

Then, in the shared checkout, in this order. There is no `lint` script in this repo; the five gates below are the whole set from `.ai/agentic.config.json` `validation.commands`.

1. `T0 = git -C <repo> write-tree`
2. **Focused gate, before the repository gates** — the task's own acceptance criteria name it first, and it fails in seconds rather than in the ~20 minutes a full `npm test` costs:
   `G npm test -- packages/contract/src/runs.test.ts packages/cezar/src/workflows/run.test.ts packages/cezar/src/workflows/postconditions.test.ts`
   This is the gate on 3a's amendments. A red here stops the run before anything expensive.
3. `G npm run typecheck` (runs `build:server` via `pretypecheck`, then contract, client, server, web)
4. `G npm test` (vitest, roughly 628 files / 11,783 tests at the parent's measurement)
5. `G npm run test:unit` (`test/unit/*.test.ts`): **expected clean**, see Correction 2
6. `G npm run build` (includes `check:pack` and the build stamp)
7. `G npm run test:package` (`test/e2e/*.test.ts`, 25 tests at the parent's measurement)
8. `T1 = git -C <repo> write-tree`; assert `T0 == T1`

Report every failure verbatim, with the command and the count, and state explicitly that each was run scrubbed. A failure in `npm test` under concurrent load is a real risk here (see Risks) and must be distinguished from a real red by re-running the failing file alone **under the same scrub**, not by assuming flake. An unscrubbed re-run is not evidence either way.

### Phase 4: one commit, one explicit push

0. **Re-assert the index immediately before `git commit`, not after.** The gates just ran for tens of minutes in a checkout other tasks write to, so `T1` is a reading with a shelf life. In the same shell, in this order, with no command between the last check and the commit:

   ```bash
   T2=$(git -C <repo> write-tree)
   [ "$T2" = "$T1" ] || { echo "index moved after the gates: T1=$T1 T2=$T2 — STOP"; exit 1; }
   git -C <repo> diff --cached --name-only origin/main | sort > /tmp/staged-now.txt
   diff /tmp/staged-now.txt /tmp/staged-at-phase2.txt || { echo "staged path set changed — STOP"; exit 1; }
   ```

   Phase 2 step 6 writes `/tmp/staged-at-phase2.txt`. On **any** mismatch, do not commit: a concurrent task staged bytes that were never tested, and committing them creates exactly the untested-revision-shipped defect this feature exists to prevent. Re-derive the state and re-run Phase 3 in full. Verification item 8 catches this too, but only *after* the bad commit exists — this check is what keeps it from being created.
1. Commit once, imperative and lowercase per repo convention:
   `fix: attest every workspace project tree, not just the scratch cwd`
   with a body naming `.ai/specs/2026-08-25-workspace-revision-attestation.md`, and noting that the two status line edits to `2026-08-24-default-workflow-ten-stages.md` and `2026-08-24-manual-deploy-not-a-bug.md` ride inside it as record corrections (they do, and Question 4 of the brief is answered yes: one commit, per the acceptance criteria's "its spec/changelog/tests").
2. **Before pushing, assert the commit is the tested tree:** `[ "$(git -C <repo> rev-parse HEAD^{tree})" = "$T1" ]`. If it is not, the commit picked up something the gates never saw — `git reset --soft HEAD^`, re-derive, and re-run Phase 3. Do not push it.
3. `git -C <repo> push origin HEAD:refs/heads/main`. Explicit refspec. Never a bare `git push`, never `upstream`.
4. Verify: `git -C <repo> rev-parse HEAD` equals the sha in `git -C <repo> ls-remote origin refs/heads/main`, and `git -C <repo> status -sb` shows no ahead/behind.
5. Assert `git -C <repo> status --porcelain` is empty. A dirty tree here means something else wrote to the shared checkout during the gates; investigate before reporting a revision.

### Phase 5: record, report, and hand off what is not shipping

1. Report the exact pushed sha, and the fact that both targets in `.ai/deploy-targets.json` are `"manual": true` with `manualReason` "cezar service deployment requires a human to activate the service safely" / "cezar UI deployment requires a human to activate the service safely". Hand over the **exact** procedure below, not a bare `cezar server-deploy --strategy=blue-green`.

   **`--sha` is a label, not a checkout instruction.** KB `notion-8d2aa351272c` (`knowledge/sections/324-2026-08-22-blue-green-source-sha-is-a-label-not-a-checkout.md`) records the measured incident: `server-deploy` builds whatever `--source`'s working tree currently has checked out and never materializes `--sha` inside it. On 2026-08-22 a deploy run with `--source=/var/lib/cezar/loki-labs/cezar --sha=504ce87f` completed, logged `[deploy.cutover]`, and served `{"deploy":{"sha":"504ce87f"}}` while **running the pre-`504ce87f` build** — caught only by grepping the live bundle. That shared checkout is exactly the one this run just pushed from, it carries in-flight autosave commits from other tasks, and its local `main` is not guaranteed to track `origin/main`. So **never deploy from it, and never from this task's worktree either.** The reusable pattern from that KB entry, parameterized for the pushed sha:

   ```bash
   SHA=<the exact sha this run pushed>
   git -C /var/lib/cezar/loki-labs/cezar worktree add /var/lib/cezar/deploy-ws-attest "$SHA" --detach
   cd /var/lib/cezar/deploy-ws-attest
   [ "$(git rev-parse HEAD)" = "$SHA" ] || { echo "worktree is not at $SHA — STOP"; exit 1; }
   [ -z "$(git status --porcelain)" ] || { echo "deploy worktree is dirty — STOP"; exit 1; }
   npm ci && npm run build
   node /opt/cezar/packages/cezar/dist/index.js server-deploy --strategy=blue-green \
     --source="$PWD" --sha="$SHA"
   ```

   Then verify, and **require the exact sha**: `curl -fsS http://127.0.0.1:4321/api/v1/ready` must report `deploy.sha` equal to `$SHA`. An ancestor result does **not** count here. The `--is-ancestor` allowance in `.ai/deploy-targets.json`'s backend probe exists so a task whose HEAD was overtaken by a concurrent deploy still reads green; it is not evidence that *this* revision was activated, which is the only question this handoff asks. Finish as that KB entry prescribes — confirm the live bundle carries a distinctive symbol from the change rather than trusting the deploy's own metadata, e.g. `grep -c 'tests attested' /opt/cezar/packages/cezar/dist/workflows/run.js` (adjust the path to the emitted file) — because `deploy.sha` is precisely the signal that lied in the 2026-08-22 incident.
2. File a todo for **Body B**: "workspace tasks ship themselves is stashed and unshipped", citing `stash@{0}`'s recorded sha and `…/7d982c23-preserved/staged-vs-HEAD.patch`. Note that its `AGENTS.md` hunk asserts cezar tasks may not self push, which contradicts published `AGENTS.md:7`, and that the owner should settle which is current before it lands.
3. File a todo for **Body A**: superseded draft of `7932cf4d`, preserved in the same stash, probably discardable, nobody's call to make silently.
4. **Close todo `1d8922bb-339e-49d1-b8ee-359a1dfd1db7`** — "Fix broken test:unit suite: deploy-e2e-probe.test.ts (8/9 failing)", filed by the parent run `2914e8d5` at `2026-08-24T23:52:14Z`, still `status: todo`. The file it asks someone to fix was deleted from `origin/main` by `7932cf4d` six minutes after it was filed, so the work it describes cannot be done and the failure it reports cannot reproduce. Close it naming `7932cf4d` as the reason. **Measured 2026-08-25: `cezar todo --help` exposes exactly two verbs, `add` and `list`** — there is no close, done, or dismiss. Re-check at execution time in case the CLI has gained one; if it has not, report the todo as **explicitly pending and moot** in the handoff, naming `7932cf4d`, and leave it alone. Do **not** hand-edit `.ai/cezar/todos.json` in a checkout several tasks are writing to, and do not report it as closed.
5. **Synchronise the corpus, in this session, and prove it is searchable.** Workspace doctrine: a corpus write only counts once `cez kb search` finds it. Search **before** writing, so a correction lands in place rather than as a duplicate:

   ```bash
   cd /var/lib/cezar/loki-labs/cezar
   CEZ_KB=1 cez kb search "workspace revision attestation"
   CEZ_KB=1 cez kb search "tested-revision-shipped"
   ```

   Measured 2026-08-25, before this run: the **only** entry either query returns on this topic is `specs-6075b87dbdfe` ("The default workflow becomes ten stages"), whose heading *"P3. Nothing proves the tested revision is the shipped revision"* names this gap as still open, and whose status reads `Partial 2026-08-24 … commit and push are blocked`. There is **no** applied workspace-attestation decision in the corpus. Re-run the searches at execution time before concluding that is still true.

   **The `supersede` op cannot reach `specs-6075b87dbdfe`, so do not propose one.** Measured 2026-08-25: `CEZ_KB=1 cez kb show specs-6075b87dbdfe` reports `root: specs`, and `applySupersede` (`packages/cezar/src/knowledge/proposals.ts:183`) refuses anything outside the two writable mounts — `if (entry.root !== 'project' && entry.root !== 'workspace') return { ok: false, reason: 'target is on a read-only mount' }`. A `supersede` line aimed there is guaranteed to be rejected at apply time, which is the worst failure shape available: the proposal file looks complete, the stale P3 heading stays live, and nobody finds out until a human runs `cez kb proposals`. The `specs` root is a repository directory, so **that document is corrected the ordinary way, with an editor — and it already was, back in Phase 2 step 5.**

   Its file is `.ai/specs/2026-08-24-default-workflow-ten-stages.md`, which the payload **already touches** (a status-line change, one of the 10 paths), so it adds no path and needs no scope exception. The correction happens in Phase 2 rather than here for the same reason every other record edit does: it must be inside the tested tree, and Phase 5 runs after the commit, where a new edit would either be lost or force a second commit. Verify here, do not re-edit: `git -C <repo> show HEAD -- .ai/specs/2026-08-24-default-workflow-ten-stages.md` shows the amended P3 heading and the dated lead-in above the preserved original.

   Then append NDJSON proposals to `$CEZ_KB_WRITE_FILE` (this run's is `.ai/cezar/runs/7d982c23-….knowledge.ndjson`; it does **not** exist yet, so `seq` starts at `0` and counts up across every line appended this run — read the file first if an earlier turn already appended to it). Every line carries `op`, `scope`, `path`, `title`, `type`, `tags`, `body`, `seq`, `runId` = `CEZ_TASK_ID`, and an ISO-8601 `createdAt`; `scope: "project"` resolves to this repo's `.ai/cezar/knowledge`, which is where a cezar decision belongs. Three writes, and no more — one line each, no pretty-printing, since the file is NDJSON:

   ```jsonl
   {"op":"upsert","scope":"project","path":"decisions/workspace-runs-attest-every-project-tree.md","title":"Workspace runs attest every project tree, not the scratch cwd","type":"note","tags":["cezar","workflows","verification-doctrine"],"body":"…decision text; cite the pushed SHA and .ai/specs/2026-08-25-workspace-revision-attestation.md…","seq":0,"runId":"7d982c23-e2f5-4416-b02d-8adfd067195c","createdAt":"2026-08-25T00:00:00.000Z"}
   {"op":"upsert","scope":"project","path":"decisions/tested-revision-shipped-is-per-project.md","title":"tested-revision-shipped compares each project worktree HEAD, and names the offender","type":"note","tags":["cezar","workflows","verification-doctrine"],"body":"…invariant text, including that a failed capture makes run-tests red rather than leaving an absent attestation to read as green…","seq":1,"runId":"7d982c23-e2f5-4416-b02d-8adfd067195c","createdAt":"2026-08-25T00:00:00.000Z"}
   {"op":"upsert","scope":"project","path":"changelog/2026-08-25-workspace-revision-attestation.md","title":"Changelog 2026-08-25 — workspace revision attestation","type":"note","tags":["cezar","notion-changelog"],"body":"Fixed. Area Cezar. …","seq":2,"runId":"7d982c23-e2f5-4416-b02d-8adfd067195c","createdAt":"2026-08-25T00:00:00.000Z"}
   ```

   Fill `body` and the real `createdAt` at execution time; the placeholders above are shape, not content. A line missing any of those keys is rejected by the proposal reader, and a rejected line is indistinguishable from one nobody wrote.

   **A proposal is not the record.** Proposals are reviewed and applied later through the cockpit or `cez kb proposals` — never automatically. So after appending, search for the **exact new titles**, not for the topic:

   ```bash
   CEZ_KB=1 cez kb search "Workspace runs attest every project tree"
   CEZ_KB=1 cez kb search "tested-revision-shipped compares each project worktree HEAD"
   ```

   The generic query from the top of this step is useless as proof here: `cez kb search "workspace revision attestation"` already matches this spec and its brief the moment they are committed, so it returns hits whether or not a single proposal was applied. Only a hit on a title that exists **nowhere but the proposal** distinguishes applied from appended. If they do not resolve, report corpus sync as **pending**, naming the proposal file and the exact lines written; do **not** report the record as current.

   Two KB ids handed to earlier iterations of this chain, `specs-9ae029076eec` and `specs-21fbce1fa0cc`, are the precedent for that check. **Re-measured 2026-08-25 for this revision:** neither resolves — `CEZ_KB=1 cez kb show <id>` prints `no such document` from both `/var/lib/cezar/loki-labs/cezar` and `/var/lib/cezar/loki-labs`, and `grep -c` finds neither string in any `catalog.ndjson` under `/var/lib/cezar/loki-labs`. The third review of this spec asserted that both resolve now; that is not what this box reports, and the commands above are recorded so the next reader can settle it in one run rather than by argument. Either way the lesson is unchanged, and it is the reason the exact-title search exists: an id can be cited as if it were the record long before anything applied it.
6. `find /var/lib/cezar -not -user cezar | wc -l` must return `0`.

## Data Models

No new model. The feature's model is owned by `.ai/specs/2026-08-25-workspace-revision-attestation.md` and reproduced here only so a reviewer of this spec can check the payload without opening the other worktree:

```ts
interface TestAttestationProject {
  root: string;
  worktreePath: string;
  treeSha: string;
  headSha?: string;
  shippedSha?: string;
}

interface TestAttestation {
  stepId: string;
  treeSha: string;
  headSha?: string;
  shippedSha?: string;
  projects?: TestAttestationProject[];   // new, optional
  at: string;
}
```

Additive and optional throughout, which matters because cezar is published (`@loki-labs/cezar-plus`) and persisted older runs must still parse and resume. No migration, no dual write, no reset of stored state.

## API Contracts

Unchanged by this spec. The feature adds one optional field, `testAttestation.projects`, to the run response. No route, request or command changes, so no client, no `.env.example` entry and no README table is affected.

Two operational contracts this spec does depend on, both already published:

- `.ai/deploy-targets.json`: both targets `"manual": true`. The `deploy` step of `spec-to-deploy` therefore parks with "Awaiting manual deployment" and a handoff a person resolves. Per `.ai/specs/2026-08-24-manual-deploy-not-a-bug.md`, that parked state is the expected terminal state, not a defect, and flipping `manual` back to `false` is off the table.
- `AGENTS.md:7` on `origin/main`: standing authorization to `git commit` and `git push origin main` for changes to cezar itself, explicitly reaffirmed as current by `ea40c7a1`.

## Risks

- **The shared checkout is genuinely shared.** 29 worktrees exist and other cezar tasks run concurrently against the same repo and the same `node_modules`. The state measured for this spec can move between now and Phase 0. Mitigation: Phase 0 step 1 re-measures and stops on any difference; Phase 3 brackets the gates with tree shas; Phase 4 step 0 re-asserts the tree and the staged path set in the same shell as the commit, and Phase 4 step 5 asserts cleanliness again before reporting a revision.
- **`npm test` flakes under concurrency.** Both `.ai/specs/2026-08-24-workspace-tasks-ship-themselves.md` (17 failures, 12 on a scrubbed control) and `.ai/specs/2026-08-24-default-workflow-ten-stages.md` ("9 reproduced baseline-failure files and 20 tests") record full suite reds caused by concurrent runs, nested runner binaries disappearing, and shared capture returning another task's prompt. Mitigation: re-run any failing file in isolation before calling it flake, and report the isolated result, not the aggregate. Do not commit on a red that reproduces in isolation.
- **`npm run build` rewrites `packages/cezar/dist/` in the shared checkout.** A concurrent `server-deploy` stages from that source tree and is gated on `dist/.build-stamp.json` agreeing with the checkout HEAD (`release-deploy.ts:90-128`). Building at Phase 3 while HEAD is still at S3's parent leaves a stamp whose sha is the pre commit HEAD. Mitigation: this run does not deploy; the human activation in Phase 5 runs its own build. Flag it if a concurrent deploy is observed mid gate.
- **The stash is not durable storage.** A stash entry is a reflog entry in a repo several tasks write to. Mitigation: the Phase 0 patch dump plus the recorded `stash@{0}` commit sha, both under `.ai/cezar/runs/`, either of which reconstructs Body A and Body B without the stash.
- **Body A's supersession is an inference.** `7932cf4d` contains a further developed version of the same four source files and the same spec, so the staged copy reads as an older draft. That was concluded from content and history, not from an owner statement. Mitigation: nothing is discarded; Phase 5 step 3 files it as a decision for a human.
- **`origin/main` may advance between Phase 1 and Phase 4.** Mitigation: the push in Phase 4 uses `HEAD:refs/heads/main` without `--force`, so a non fast forward is rejected rather than overwriting anyone. On rejection, fetch, rebase the single feature commit, re-run Phase 3, and push again. Never `--force`.
- **Expecting the wrong baseline.** If the implement step carries the parent's "8 of 53 in deploy-e2e-probe" expectation forward, a genuinely clean `test:unit` reads as suspicious and a genuinely new failure reads as known. Correction 2 exists to prevent exactly that.
- **A hash quoted in a spec goes stale the moment `origin/main` moves, and a stale hash reads as corruption.** This already happened to this document within hours of it being written: its Phase 2 checkpoint was `b3d48e32…` and the same clean merge now yields `53b9f093…`, purely because three commits landed. An implement step that pastes the stale value, sees a mismatch, and concludes the cherry pick is broken may "repair" it by resetting — destroying a correct result to satisfy a wrong expectation. Mitigation: Phase 2 step 0 computes the expected tree in the same shell seconds before comparing, Verification 5 forbids using any hash from this document, and every sha in this spec is dated to the reading that produced it.
- **This spec was itself wrong three times, which is the argument for re-measuring rather than re-reading.** The commit distance (28, now 31), the merge-conflict blocker (an untracked file that collides with nothing, rather than the staged file that does), and the existence of todo `1d8922bb` were all stated confidently and all wrong. Every one was caught by running the command again, and none by re-reading the prose. The implement step should treat each numeric claim here as a prior to check, not a fact to cite, and should report what it measured next to what this spec predicted.

## Verification

Concrete and executable, in order. `<repo>` is `/var/lib/cezar/loki-labs/cezar`.

1. **Preservation is real, checked against the recorded sha and including the untracked path.** `test -s <runs>/7d982c23-preserved/staged-vs-HEAD.patch`, and `git -C <repo> stash list | grep -c 'preserve: unrelated staged work'` returns `1`. Then, with `S` = the stash **commit sha** Phase 0 step 7 wrote to `…/7d982c23-preserved/stash.txt`: `git -C <repo> stash show --include-untracked --stat "$S"` lists all **13** paths from Problem. Two reasons this is not `git stash show --stat stash@{0}`: without `--include-untracked` the summary omits the thirteenth path, the untracked `.ai/specs/briefs/2026-08-24-ship-bulk-start-filed-tasks.md`, so a 12-path summary would read as a pass; and `stash@{0}` is a moving reference in a shared checkout — another task stashing during this run displaces it, and the check would then be verifying someone else's work. The sha is stable, which is why Phase 0 records it.
2. **Checkout is clean before the merge.** `git -C <repo> status --porcelain` prints nothing.
3. **Reconciled.** `[ "$(git -C <repo> rev-parse HEAD)" = "$(git -C <repo> rev-parse origin/main)" ]` and `git -C <repo> status --porcelain` empty.
4. **The deliberate deletion took effect.** `test ! -e <repo>/packages/cezar/test/unit/deploy-e2e-probe.test.ts` and `test -e <repo>/packages/cezar/test/e2e/deploy-e2e-probe.test.ts`.
5. **The cherry pick is byte exact, and `$EXPECTED` was parsed rather than swallowed.** Phase 2 step 0's `merge-tree --messages` invocation exited 0, printed no `CONFLICT` line, and `$EXPECTED` is its **first line only**, matching `^[0-9a-f]{40}$` — not the whole multi-line output, which also carries a blank line and the two `Auto-merging` notices. `git -C <repo> write-tree`, taken immediately after `cherry-pick --no-commit` and before the two spec files are added, equals that parsed `$EXPECTED`, computed moments earlier from the same `origin/main`. The full `merge-tree` output and the parsed value both appear in the report. **No hash printed in this spec is used as the expected value** — see Correction 1. `git -C <repo> diff --name-only --diff-filter=U` is empty.
6. **Scope is exactly right.** `git -C <repo> diff --cached --name-only origin/main | sort` equals the 10 payload paths plus `.ai/specs/2026-08-25-ship-workspace-revision-attestation.md` and `.ai/specs/briefs/2026-08-25-ship-workspace-revision-attestation.md`, and contains neither `AGENTS.md` nor any `packages/web/` or `packages/cezar/src/workspace/` path. `git -C <repo> diff --name-only` (unstaged) is empty, so the three in-place status corrections from Phase 2 step 5 and the five amended files from Phase 3a are in the **index**, not only on disk. `git -C <repo> show HEAD -- .ai/specs/2026-08-24-default-workflow-ten-stages.md` shows the amended P3 heading with the original preserved beneath a dated lead-in, and no sha named in either — this is the correction that replaces the unapplyable KB `supersede`, so if it is missing from the commit, nothing corrected that record at all.
7. **Gates, focused first, all scrubbed.** `npm test -- packages/contract/src/runs.test.ts packages/cezar/src/workflows/run.test.ts packages/cezar/src/workflows/postconditions.test.ts` exits 0 **before** the repository gates are started, and its output shows the Phase 3a assertions: project count 2, `localeCompare` root order, a per-project failure detail naming A but not B and then B but not A, and the fail-closed cases — a scratch capture failure and a non-git project worktree each leaving `run-tests` **red** with `commit-push` **pending**, and the offending project root present in the failure text. Then all five of `npm run typecheck`, `npm test`, `npm run test:unit`, `npm run build`, `npm run test:package` exit 0. Every one of those six commands ran through the Phase 3b `G` wrapper — `CEZ_*` unset except `CEZ_HANDOFF_FILE`/`CEZ_TASK_ID`, `NODE_ENV` unset, `TMPDIR`/`TMP`/`TEMP` pointed at a fresh directory outside every git repo — and the report says so explicitly. `npm run test:unit` is expected **clean**; any failure there is reported as new, with the file and the assertion text quoted. Any `npm test` failure is re-run in isolation **under the same scrub**, and both results reported.
7a. **The parent spec's two-project runtime fixture, actually executed.** Item 10 of the payload's own Verification section asks for *"a temporary scratch repo with two linked project worktrees, place the four incident artifact names only in scratch, invoke the real capture and verification path, and retain the command log"*. It has **not** been done. The payload's `Executed 2026-08-25` log reports instead that *"the direct `RunManager` capture test used real git repositories, placed `.cezar-control-path` only in scratch, captured the project tree, and proved the artifact absent from that tree"* — one project, and the private helpers called directly. Calling `recordTestAttestation` and `testedRevisionShipped` in isolation cannot observe the defect that matters most, because that defect lives in the seam **between** them: the capture returns `void`, the step loop marks `run-tests` done anyway, and the post-condition then reads an absent attestation as green. No test that invokes either helper on its own can see that. Phase 3a item 4 fixes the seam; this fixture is what proves it.

    So build it, and drive the **workflow**, not the helpers: a scratch repo with two linked project worktrees registered as `workspaceWorktrees`, run the real `run-tests` → `commit-push` chain, and assert (a) both projects attest, in `localeCompare` root order rather than registration order; (b) the four incident artifact names — `.cezar-control-path`, `.cezar-gate-path`, `cezar-control-<id>.log`, `cezar-gates-<id>.log` — placed only in scratch appear in no project tree and do not turn the run red; (c) a committed source change in one project fails the chain with that project's root and path in the detail and **not** the other's, mirrored for the second project; (d) a capture failure in either project leaves `run-tests` **red** and `commit-push` **pending**, never done-and-green. Retain the command log under `…/7d982c23-preserved/` as the payload's item 10 asks. This is backend-only, so no screenshot or video is meaningful.

    **Until 7a passes, the feature is reported as QA Needed, not verified**, even with every gate below green. Gates green is necessary and not sufficient (workspace `AGENTS.md`), and this is the one check that exercises the path a real workspace run takes. If it cannot be made green, that is a red on the payload and the run stops at Phase 3 — it is not a reason to push and file a follow-up.

8. **Tested tree equals shipped tree.** The tree sha recorded before the gates equals the one recorded after, and equals `git -C <repo> rev-parse HEAD^{tree}` after the commit.
9. **Exactly one commit.** `git -C <repo> rev-list --count origin/main..HEAD` returns `1` immediately before the push, and `git -C <repo> log -1 --format=%s` matches `^fix: `.
10. **Push landed, on the right remote.** `[ "$(git -C <repo> rev-parse HEAD)" = "$(git -C <repo> ls-remote origin refs/heads/main | cut -f1)" ]`, and the transcript shows `git push origin HEAD:refs/heads/main` with no bare `git push` and no `upstream` anywhere.
11. **Production is unchanged — the same sha, not merely a different one, and proved rather than assumed.** Capture it **before Phase 0** and again after the push, and require exact equality. The obvious one-liner (`curl … | grep -o '"sha":"[0-9a-f]*"' | head -1`) is **fail-open** and must not be used: `curl -f` failing, the server being down, `deploy` being absent from the payload, or the key being renamed all yield an empty `D0` *and* an empty `D1`, and `[ "$D0" = "$D1" ]` then passes — reporting "production is unchanged" on the strength of having learned nothing about it twice. A truncated or partial sha passes it too. Parse the JSON, validate the shape, and treat a probe failure as a stop:

    ```bash
    PRES=/var/lib/cezar/loki-labs/cezar/.ai/cezar/runs/7d982c23-preserved
    ready_sha() {   # $1 = file to save the FULL response into; prints a validated 40-char deploy.sha
      local body rc
      body=$(curl -fsS --max-time 10 http://127.0.0.1:4321/api/v1/ready); rc=$?
      [ "$rc" -eq 0 ] || { echo "ready probe failed: curl exit $rc" >&2; return 1; }
      printf '%s' "$body" > "$1"
      printf '%s' "$body" | node -e '
        let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
          let sha; try { sha = JSON.parse(s)?.deploy?.sha } catch { process.exit(2); }
          if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) process.exit(3);
          process.stdout.write(sha);
        })' || { echo "ready response has no valid 40-char deploy.sha" >&2; return 1; }
    }

    D0=$(ready_sha "$PRES/deploy-before.json") || { echo "no production baseline — STOP before Phase 0"; exit 1; }
    …
    D1=$(ready_sha "$PRES/deploy-after.json")  || { echo "cannot re-read production — report UNVERIFIED, not unchanged"; exit 1; }
    [ "$D0" = "$D1" ] && echo "production unchanged at $D0" \
                      || echo "production moved during this task: $D0 -> $D1"
    ```

    A failure of either probe is reported as **unverified**, never as unchanged. Both full responses are saved, not just the extracted shas, so a shape change is diagnosable after the fact rather than only visible as an exit code. `D0` is taken at Phase 0 time and both values go in the report. Testing only that `deploy.sha != <newly pushed sha>` is not an unchanged-state check: it passes just as happily if a concurrent task activated some *other* revision mid-run, which is a real event on this box (the `.ai/deploy-targets.json` `$comment` records a concurrent activation of `7e8f2938` over a run's own `2438b6d7`). A `D0 != D1` is not this run's failure, but it must be reported rather than absorbed, because it changes what the human is activating over. Reading taken 2026-08-25 for reference only: `deploy.sha` `d217ab2e9526e68248cad06c089fb887dff7c48b`, release `20260825T082047Z-d217ab2e`, `dirty:false` — re-measure, do not cite.
12. **Ownership doctrine holds.** `find /var/lib/cezar -not -user cezar | wc -l` returns `0`.
13. **Handoff carries the revision.** The final report states the pushed sha, that both deploy targets are manual, the exact activation procedure from Phase 5 step 1 (isolated detached worktree at the pushed sha, `npm ci && npm run build` there, `--source="$PWD" --sha=<sha>`, exact-sha `ready` check), and the two filed follow up todos for Body A and Body B. It states the feature's status as **QA Needed** unless Verification 7a was executed and green, and says which of the two it is rather than rounding up.
14. **The corpus is synchronised, or it is reported pending.** `$CEZ_KB_WRITE_FILE` exists and contains the proposals from Phase 5 step 5, with `seq` running `0,1,2,…` and every line carrying `runId` and `createdAt`. `CEZ_KB=1 cez kb search "workspace revision attestation"` was re-run afterwards and its output is quoted in the report. If the new entries do not resolve, the report says **corpus sync pending, proposals appended but not applied**, and names the file — it does not claim the record is current. Applying proposals is a human step through the cockpit or `cez kb proposals`; this run never applies its own.

No screenshot or video applies: every step here is git and shell, and the feature itself is backend only.
