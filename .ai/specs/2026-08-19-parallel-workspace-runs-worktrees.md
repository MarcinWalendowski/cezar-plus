# Parallel workspace runs via per-project worktrees

> **Status:** draft — implementing. · **Date:** 2026-08-19
> **Amends in place:** `2026-08-15-cross-project-workspace-run.md` decisions **D2, D4, D7**. Those
> said a workspace run executes *in place* in the boot repo, takes the boot repo's exclusive
> working-tree lease so **one runs at a time**, and **never commits** (edits land in the real
> checkouts). This spec replaces that model: a workspace run now isolates each granted project in
> its own `cez/<id8>` worktree, runs **up to `maxParallel`**, and **auto-applies** each worktree
> back into the real checkout when it finishes, removing the worktree after the merge. D1/D3/D5/D6
> (record home, containment, persisted grant, prompt names the grant) are kept.

## TLDR

The owner runs everything as **Workspace** tasks, and they were serialized to one at a time even
with `maxParallel: 10`. Two independent gates caused it, both anchored on the boot repo
(`/var/lib/cezar/workspace`, a non-git scratch dir): the `pump()` non-git cap and the in-place
repo-root lease. This spec removes both **for workspace runs** and makes them safe to parallelize
by giving each granted project its own git worktree. When the run ends, each worktree's diff is
applied back into that project's real working tree (serialized per project root), and the worktree
is removed.

## Problem

On the owner's prod install the boot/workspace manager root is `/var/lib/cezar/workspace` — a
scratch dir that holds none of the work and is **not** a git repo. Every "Workspace" task runs
there. Two things pin it to one concurrent run, and neither honors `maxParallel: 10`:

1. **Non-git degradation** — `pump()` (`workflows/run.ts`): `repo !== null || busySlots() < 1`.
   A non-git root is capped at a single concurrent run. This is the "agents says no git" the owner
   observed.
2. **Repo-root exclusive lease** — a workspace run is forced `worktree:false`, so `state.cwd`
   stays the boot root and it takes the one-at-a-time lease (`acquireRepoRoot`, spec 2026-08-15
   **D4**).

Confirmed empirically: a workspace run submitted at 20:37 did not begin executing until 20:59,
after the previous one finished at 20:58 (`runs.json`). The lease held it for ~21 min.

The D4 serialization was deliberate — *"two agents editing the same checkouts concurrently is a
hazard, not throughput"* — but it is a **coarse global lock on a scratch dir**. It never protected
the actual files (those live in the granted project dirs, not the boot tree); it just prevented any
two workspace runs from overlapping at all. The owner wants throughput and accepts the trade, but
better: isolate the edits so parallelism is *safe*, not just permitted.

## Solution

A workspace run stops editing the real checkouts directly. Instead:

1. **Per-project worktrees.** At run start, for every granted project whose root is a git repo,
   create a `cez/<id8>` worktree (`.ai/cezar/worktrees/<runId>` inside that project, same mechanism
   as an ordinary per-project run). A project that is missing or non-git contributes no worktree
   and is granted its real root as before (rare; the owner's are all git).
2. **The grant points at the worktrees.** `--add-dir` and the system-prompt grant block name the
   worktree paths, not the real roots, and the prompt tells the agent to work there. The cwd stays
   the boot scratch repo (neutral).
3. **No lease, no non-git cap.** A workspace run neither takes the boot repo-root lease nor counts
   against the non-git single-slot cap, so N of them run concurrently up to `maxParallel`.
4. **Auto-apply at end, then remove.** When the run reaches a settled/finished state, for each
   worktree that holds changes: commit them, then apply the diff back into the project's real
   working tree — **serialized per project root** so two runs finishing at once cannot interleave —
   then remove the worktree and its branch. A patch that will not apply cleanly (a real conflict
   with the user's in-progress work or with another run's just-applied change) leaves that
   project's worktree/branch in place and is reported; the others still apply.

### Decisions

| # | Decision | Why |
|---|---|---|
| **W1** | Worktree **every granted git project**, every workspace run | The owner's explicit choice over composer-selection. Simple and predictable; cost noted in Risks. |
| **W2** | Grant = worktree paths (not real roots); cwd stays boot scratch | Isolation only works if the agent writes into the worktrees. cwd stays neutral so no project is privileged, matching the original D2 intent. |
| **W3** | Workspace runs are exempt from the repo-root lease and the non-git `busySlots()<1` cap | Both gates guard the boot scratch tree, which a workspace run no longer edits. The real per-project trees are protected by isolation instead. This is what delivers "up to the limit". |
| **W4** | Auto-apply via `git apply --3way --binary` of `base..HEAD`, into the real tree, unstaged | Lands changes **beside** the user's in-progress work without committing (preserves the original D7 "no commits in your tree" feel — the merge result is uncommitted). 3-way uses the shared object db and leaves the tree usable on a clean apply. |
| **W5** | Apply is **serialized per real project root** | The only remaining collision point is two runs applying to the same repo at the same instant. A per-root apply mutex on the boot manager closes it (all workspace runs share that one manager). |
| **W6** | Worktree removed **after** a successful apply; kept on conflict | The owner's instruction. A conflict is the one case where the branch is the recovery artifact, so it survives for manual resolution and is named in the transcript. |
| **W7** | Apply happens on **success** only; a failed/cancelled run leaves its worktrees | Applying a half-finished or aborted run's partial edits is worse than leaving them in a branch. Orphans are reclaimed by the existing per-project prune on next boot of that project's manager. |
| **W8** | The worktree map is **persisted** on the record (`workspaceWorktrees`), like the grant (D5) | A restart/resume must re-apply to the same worktrees, and the apply-back step must find them after the process that created them is gone. |

## Architecture

```
POST /workspace/runs                       (unchanged: grant = every registered project)
  └─ bootContext.manager.startRun(worktree:false, workspaceProjects: grant.projects)
       └─ execute(): isWorkspaceRun?  →  materializeWorkspaceWorktrees(record)
            ├─ for each granted git project: createWorktree(projectRoot, runId, base)
            ├─ persist record.workspaceWorktrees = [{ root, worktreePath, branch, baseBranch }]
            ├─ grant roots  → worktree paths → --add-dir
            ├─ prompt block → worktree paths (workspaceGrantSystemPrompt over the worktree map)
            └─ NO acquireRepoRoot, NOT counted by the non-git cap
       ── run executes, up to maxParallel concurrently ──
       └─ settleSuccess(): applyWorkspaceWorktrees(record)
            └─ per project (serialized by root):
                 autosaveCommit(worktree,'run finalize')
                 → git -C real apply --3way --binary (diff base..HEAD)
                 → ok:  removeWorktree(root, path, branch)
                   conflict: keep, note "applied N/M; <project> conflicted — branch cez/<id8> kept"
```

`pump()` gains an `isWorkspaceRun(id)`-aware capacity check: the `busySlots() < 1` non-git clause
counts only **non-workspace** in-place runs. `execute()` skips `acquireRepoRoot` when the run is a
workspace run.

## Data Models

```ts
// contract/src/runs.ts — runRecordSchema
workspaceWorktrees: z.array(z.object({
  root: z.string(),          // the real project root
  worktreePath: z.string(),
  branch: z.string(),        // cez/<id8>
  baseBranch: z.string(),    // fork ref / starting commit
})).optional()                // present only on workspace runs that materialized worktrees
```

`workspace/granted-roots.ts`: `buildWorkspaceGrant` / `workspaceGrantSystemPrompt` gain a variant
that, given the worktree map, emits the worktree paths in `roots` and in the prompt text. A missing
project still contributes nothing; a non-git granted project falls back to its real root.

New `workspace/workspace-worktrees.ts` (pure-ish, git-shelling): `materialize`, `applyBack`
(per-root serialized), tested against a temp git repo.

## Phases

1. Contract: `workspaceWorktrees` on the record + regenerate.
2. `workspace/workspace-worktrees.ts`: materialize + apply-back (`git apply --3way --binary`),
   per-root serialize, conflict reporting. Unit-tested against temp repos.
3. `granted-roots.ts`: worktree-aware grant roots + prompt block.
4. `run.ts`: materialize on `execute` for workspace runs; skip lease; exempt from non-git cap in
   `pump()`; apply-back + remove in `settleSuccess`; re-materialize on resume.
5. Tests + gates + runtime E2E on the live cockpit.

## Risks

- **Disk / time.** 12 git worktrees per run × up to 10 parallel = up to 120 checkouts. `git
  worktree add` copies the tracked tree; `loki-labs` is large. Mitigation: the owner chose this
  (W1); `maxParallel` and a future composer-select bound it. Flagged, not silently absorbed.
- **Apply conflicts.** Two runs touching the same file in the same repo conflict at apply time
  (W5 serializes, it does not merge divergent edits). The losing run keeps its branch (W6) and
  says so. This is strictly better than the old model, which forbade the overlap entirely, and than
  raw parallel in-place edits, which would corrupt silently.
- **Reversing a documented safety decision.** D4 is amended in place in the 2026-08-15 spec so the
  next reader does not act on the stale "one at a time / no worktree" rule.

## Verification

Planned — each guard names the mutation that turns it red.

| Guard | File | Mutation |
|---|---|---|
| A workspace run materializes one worktree per granted git project | `workspace/workspace-worktrees.test.ts` | Return `[]` from materialize |
| Apply lands the worktree diff in the real tree, unstaged, beside a pre-existing dirty file | same | Skip the `git apply` |
| A conflicting patch keeps the branch and reports; siblings still apply | same | Remove-on-conflict |
| Apply is serialized per root (two applies do not interleave) | same | Drop the per-root tail |
| Worktree removed after a clean apply | same | Skip `removeWorktree` |
| Grant roots + prompt name the worktree paths, not the real roots | `granted-roots.test.ts` | Emit `project.root` |
| `pump()` runs N workspace runs on a non-git boot root | `workflows/*run*.test.ts` | Restore `repo!==null || busySlots()<1` for workspace runs |
| A workspace run does not take the repo-root lease | same | Reinstate `acquireRepoRoot` for it |
| An ordinary in-place run is unchanged (still leased, still non-git-capped) | same | — |

Gates: `npm run typecheck`, `npm test`, `npm run test:unit`, `npm run build`, `npm run
test:package`. Runtime E2E: submit two Workspace tasks at once on the live cockpit, confirm both
run concurrently, land changes in the real checkouts, and leave no `cez/*` worktree behind.
