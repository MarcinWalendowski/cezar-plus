# A workspace run's per-project worktree is invisible to that project's own orphan prune, and gets destroyed — directory and branch

- Date: 2026-08-22
- Category: workspace runs / worktree lifecycle / data loss
- Priority signal: high — confirmed data loss already occurred; every workspace run on a
  self-deploying box (cezar deploys itself on every green change, AGENTS.md) is unsafe today.
- Risk signal: high — the fix touches the boot-path prune that runs synchronously before a
  project serves any traffic; getting it wrong either reopens the leak or blocks legitimate
  reclaim forever.
- **Routing: STOP before writing a spec — a duplicate task is already running this exact
  investigation. See "In-flight conflict" below; this is the most important fact in this brief.**

## In-flight conflict — read this first

Run **`b3b5719c-ccf6-445c-9b97-39dd7eaf077e`** (workflow `spec-to-deploy`, currently at the
`context` step, status `running`, started 2026-08-22T06:51:53Z) is investigating the **same
bug**, titled *"A workspace run's per-project worktree is reclaimed as an orphan by that
project's own cockpit on restart."* It was started from todo `4227ba55-0b7c-4985-bf4c-4a9dabb0dc4e`
(filed 2026-08-21T22:11Z). This task (`43ab17aa`) was started from a separate, near-duplicate
todo `4a2e865e-f3aa-4f15-880e-0136b552ec9f` (filed 2026-08-21T22:37Z, 26 minutes later).

There is also a **third**, older todo on the same mechanism that predates the 232ad6d4
incident and was never actioned: `918a0d09-f13d-49fe-922e-75f7d6e9e791` (2026-08-20T13:45Z,
first observed on run `202d099e` — a day before the data-loss incident this task was filed
from). Nothing has shipped a fix for any of the three.

**Before a spec gets written from this brief, the two running tasks (`43ab17aa` and
`b3b5719c`) need to be reconciled** — either one is stopped and the other proceeds, or the
work is explicitly split. Writing two independent specs for the same fix risks two
independent, possibly conflicting edits to `packages/cezar/src/git-worktree.ts`.

## The problem, in this repository's terms

cezar's **per-project boot** runs a synchronous orphan-worktree prune before serving that
project: `pruneOrphans(repoRoot, validIds)` in `packages/cezar/src/git-worktree.ts:572-590`,
called from `packages/cezar/src/index.ts:710-726` (the boot project, at `serveCommand`) and
`packages/cezar/src/server/project-context.ts:444-453` (every other project, on first
context access — sidebar open, workspace SSE subscribe, etc.). `validIds` is built purely
from `store.listRuns().map(r => r.id)` — **that project's own `RunStore`/`runs.json`**. Any
`.ai/cezar/worktrees/<id>` directory whose name isn't in that set is deleted:

```ts
// git-worktree.ts:239-248 — removeWorktree, called by pruneOrphans WITH a branch arg
await git(repoRoot, ['worktree', 'remove', '--force', worktreePath]);
await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
await git(repoRoot, ['worktree', 'prune']);
if (branch) await git(repoRoot, ['branch', '-D', branch]);
```

No safety check runs before either call — no ancestor/reachability check against the
worktree's base, no unpushed-commit check, no `git cherry`/`git log` diff. `git branch -D`
(force) deletes regardless of merge status.

**Cross-project workspace runs never register with the target project.** A workspace run
records its per-project worktrees only on its *own* run record, on the *workspace's own*
store: `workspaceWorktreeSchema` (`packages/contract/src/runs.ts:160-173,377`) — `{ root,
worktreePath, branch, baseBranch, reclaimedAt? }` — written by `materializeWorkspaceWorktrees`
(`packages/cezar/src/workspace/workspace-worktrees.ts`, called from
`packages/cezar/src/workflows/run.ts:3659-3662`) via `this.store.updateRun(runId, {
workspaceWorktrees })`, where `this.store` is the **workspace's** `RunStore`. `createWorktree`
(`git-worktree.ts:136-216`) only ever runs `git worktree add` inside the target repo — no
marker, lock, or `runs.json` entry is written into the **target** project. So when the target
project boots (which happens independently of whether the workspace run is still active — a
prod restart/deploy, not something the workspace run controls), its own `pruneOrphans` has no
way to know the worktree belongs to a live run elsewhere, and reclaims it: directory removed,
branch force-deleted.

**Confirmed data loss, not just directory removal.** During run `232ad6d4-58a5-421e-941f-5c24bd5a8452`,
the official worktree at `/var/lib/cezar/loki-labs/cezar/.ai/cezar/worktrees/232ad6d4-...` was
reclaimed twice (21:53 and 21:57) by cezar's own boot-time prune firing on prod
cockpit restarts/deploys. `git reflog cez/232ad6d4` in that repo has exactly one entry —
`branch: Created from origin/main` — meaning the branch carrying the run's commits was
deleted and silently recreated fresh. The run survived only because a continuation had
already copied its work to a stable worktree outside the pruned tree
(`/var/lib/cezar/workspace/.ai/cezar/runs/232ad6d4-recovery/README.txt` — the only record of
this incident anywhere; **it is not written into `.ai/specs/` or the KB corpus** — see "What
could not be found").

## What the record already decided

- **`.ai/specs/2026-08-19-parallel-workspace-runs-worktrees.md`** (KB `specs-b031a8bc53a9`),
  Status: `draft — implementing`. Decision **W7** assumed the gap didn't exist: *"Orphans are
  reclaimed by the existing per-project prune on next boot of that project's manager."* A
  2026-08-20 header note on the same file already retracts this for the *retention* half of
  the problem: *"The per-project prune this spec's Risks section relied on never reclaimed
  these. Retention now walks `workspaceWorktrees` too."* — but that retraction is about
  **retention** (see next item), not about **orphan-prune becoming unsafe**, which remains
  unaddressed.
- **`.ai/specs/2026-08-20-workspace-run-worktree-isolation.md`** (KB `specs-f647a4038e21`),
  Status: `IMPLEMENTED and SHIPPED — QA NEEDED, not done` (commit `a23aa9bf`/`e9293b12`). Its
  §3 fixed a **different** bug: `reclaimWorktrees` (finished-run retention) ignored
  `workspaceWorktrees` entirely, leaking them unbounded. The fix — directory-only reclaim,
  branch always kept, gated on the run being finished — lives in
  `packages/cezar/src/runs/retention.ts:43-45,69-75` (`isWorkspaceReclaimable` /
  `selectReclaimableWorkspaceRuns`), and correctly reads the **workspace run's own** record,
  so it can never touch an active run's tree. **This is the one place in the codebase that
  already threads workspace-run worktrees safely** — it's a template, not a fix for this bug:
  it solves "the owning process doesn't clean up," not "a foreign process destroys it."
- **`.ai/specs/2026-07-18-worktree-retention.md`** ("Worktree Retention & Management #483",
  KB `specs-ad856d31abc8`) — the general (non-workspace) retention spec. Count-based, keeps
  newest N finished runs, **directory-only reclaim, branch always kept** ("the `cez/<id8>`
  branch, and every autosave commit on it, survives" — retention explicitly rejected deleting
  branches, Q2 in that spec). `pruneOrphans` is a **different, older, harsher** mechanism:
  single-repo, directory-name-membership only, and it deletes the branch. No mention of
  unmerged-commit checks anywhere in this file (verified: zero hits for "unmerged").
- **`.ai/specs/2026-08-21-workspace-boot-repo-and-always-worktrees.md`** — Status:
  `implemented (phases 1–4), deployed, V7 confirmed on disk`. Its §V6 states retention
  "already covers it — nothing new to build," relying on the same local
  `runs/retention.ts:112` reclaimer. No cross-project ownership/visibility discussion.
- **Nowhere in `.ai/specs/` or the KB corpus** does any spec make `pruneOrphans` aware of
  another project's or the workspace's `runs.json`, and nowhere is a
  branch-reachability/unmerged-commit check specified before a branch delete. This is a
  genuine, previously undocumented gap — not a decision this brief reverses.

## Which code is actually involved

| Concern | Location |
| --- | --- |
| Orphan prune (the deleter) | `packages/cezar/src/git-worktree.ts:572-590` (`pruneOrphans`) |
| Deletion primitive (dir + branch) | `packages/cezar/src/git-worktree.ts:239-248` (`removeWorktree`) |
| Worktree creation (target side, no marker written) | `packages/cezar/src/git-worktree.ts:136-216` (`createWorktree`) |
| Boot call site — boot project | `packages/cezar/src/index.ts:710-726` (`serveCommand`, awaited before `manager.recover()`) |
| Boot call site — every other project | `packages/cezar/src/server/project-context.ts:444-453` (`ProjectContexts.build()`, on first access) |
| `workspaceWorktrees` schema | `packages/contract/src/runs.ts:160-173,377` |
| Where it's written (workspace's own store) | `packages/cezar/src/workspace/workspace-worktrees.ts` (`materializeWorkspaceWorktrees`), called from `packages/cezar/src/workflows/run.ts:3659-3662` |
| Existing safe reclaimer to model the fix on | `packages/cezar/src/runs/retention.ts:43-45,69-75,112` (`isWorkspaceReclaimable`, `selectReclaimableWorkspaceRuns`, finished-only gate) |

Both boot call sites wrap `pruneOrphans`/`reclaimWorktrees` in `.catch(() => [])` — best
effort, never fails boot — but the deletions inside already happened before the catch fires,
so that wrapper is not a safety net for this bug.

## Open questions a spec will have to settle

1. **Ownership signal.** The acceptance criteria ask for "something a project-local boot can
   actually see" — options actually available in the current architecture: (a) a marker file
   written into the target project's `.ai/cezar/worktrees/<id>/` at `createWorktree` time
   (cheap, local, but is new state that must be cleaned up on every exit path — success,
   failure, cancel, crash); (b) reading the **workspace's** `runs.json` directly from the
   target project's boot (requires knowing where the workspace data dir is — is that
   discoverable from the target project today, or does it require a new pointer?); (c) both,
   with the marker as the fast local check and the workspace runs.json as the authority when
   the marker is stale/missing (crash recovery). The brief does not resolve which — that's a
   spec decision, not a research one.
2. **Symmetry with the existing safe reclaimer.** `retention.ts`'s workspace-aware reclaim
   already solves "how do I check a workspace run's status safely" for the *retention* path
   by reading `run.workspaceWorktrees`/`reclaimedAt` off the **workspace's own** store — but
   that code runs *inside the workspace's own process*, where it already has that store
   open. `pruneOrphans` runs inside the **target project's** process, which has no handle on
   the workspace's store at all. Does the fix give the target project a way to open/read a
   *foreign* project's (the workspace's) `runs.json`, and if so, is that a new general
   capability ("read another registered project's run store") or a narrow one-off for this
   check?
3. **Branch-safety-before-delete, independent of the ownership fix.** The acceptance criteria
   also want: "when it does reclaim, it never deletes a branch that has commits not reachable
   from its base." This is a second, orthogonal safety net (protects against the ownership
   signal being wrong or absent, e.g. a workspace run whose marker was never written because
   it crashed before `createWorktree` finished writing it). Needs: what's "the base" for an
   orphaned worktree with no run record — `origin/main`? the branch's own merge-base with
   whatever HEAD was at creation? Should this check apply to `pruneOrphans` only, or also
   retire the current "retention never deletes branches" invariant in `retention.ts` in favor
   of a single shared safety check?
4. **Logging on decline.** Criterion 3 wants a logged reason when the prune declines to
   reclaim. No existing logging convention for `pruneOrphans` was found in this pass (it
   returns a string array of removed ids, called under `.catch(() => [])`) — the spec should
   pick where this goes (stdout at boot, a structured log line, surfaced in the cockpit?).
5. **Regression test shape.** Criterion 4 wants a test that "boots a project context while a
   workspace run holds a worktree in that project." That's two process/store contexts
   interacting (workspace's `RunStore` + target project's boot) — worth checking whether
   `ProjectContexts.build()` and workspace run creation are already unit-testable in
   isolation, or whether this needs a heavier integration-style test harness that doesn't
   exist yet for cross-project scenarios. Not investigated in this pass.

## What could not be found

- **No spec or KB entry documents the 232ad6d4 incident itself.** The only record is
  `/var/lib/cezar/workspace/.ai/cezar/runs/232ad6d4-recovery/README.txt`. Zero hits for
  "reflog", "orphan prune" (as an incident), "git branch -D", or "232ad6d4" anywhere under
  `.ai/specs/` or in the KB/notion corpus.
- **No prior decision on how a target project's boot would read a foreign (workspace)
  project's `runs.json`** — no existing cross-project store-reading capability was found in
  this pass; open question 2 above is genuinely unresolved by the record.
- **Not independently re-verified in this pass:** exact current status of duplicate run
  `b3b5719c` (only its metadata — title, step, start time — was read, not its own findings so
  far); whether todos `918a0d09` / `4227ba55` / `4a2e865e` have since been consolidated by a
  human.
