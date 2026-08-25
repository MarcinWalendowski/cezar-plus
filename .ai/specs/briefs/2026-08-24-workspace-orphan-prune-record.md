# Workspace orphan prune record

**Date:** 2026-08-24
**Task:** `b3b5719c-ccf6-445c-9b97-39dd7eaf077e`
**Finding:** this exact defect is already implemented, shipped, and runtime-verified. The next
step must reconcile with the accepted record, not write or implement a second fix.

## Problem in repository terms

A parallel workspace run stores its `RunRecord`, including `workspaceWorktrees`, in the run-owning
workspace or project data directory. Each granted target repository holds the corresponding
worktree under its own `.ai/cezar/worktrees/<runId>`. Before the fix, a target
`ProjectContexts.build()` passed only that target project's `store.listRuns()` ids into
`pruneOrphans`. The workspace run therefore looked unowned to the project containing its worktree.
During task `232ad6d4`, target-project context construction on cockpit restarts removed the same
live worktree twice, including its branch and about 40 minutes of uncommitted work.

The accepted diagnosis is recorded in KB entry `specs-91633925b646` and
`.ai/specs/2026-08-22-cross-project-worktree-orphan-prune-safety.md:40-176`. The original context
brief is `.ai/specs/briefs/2026-08-22-workspace-run-worktree-orphan-prune.md` (KB
`specs-517c2fd1a554`).

## What the record decided

- Parallel workspace runs intentionally own one record while materializing worktrees in several
  repositories. That topology comes from
  `.ai/specs/2026-08-19-parallel-workspace-runs-worktrees.md` (KB `specs-b031a8bc53a9`). Its W7
  assumption that the existing per-project prune would safely reclaim those trees was false and
  was corrected by the accepted orphan-prune spec
  (`.ai/specs/2026-08-22-cross-project-worktree-orphan-prune-safety.md:178-205`).
- Finished-run retention is a separate mechanism. It already walked `workspaceWorktrees`, removed
  directories only for finished owning runs, and kept branches. See
  `.ai/specs/2026-08-20-workspace-run-worktree-isolation.md` (KB `specs-f647a4038e21`) and the
  distinction at `.ai/specs/2026-08-22-cross-project-worktree-orphan-prune-safety.md:188-200`.
- The accepted fix reads every other registered project's run index plus the unregistered boot
  root, and treats an exact `{root, worktreePath}` claim as ownership. It does not filter by run
  status because cold index reconciliation can change a live-looking status while leaving the
  ownership entry intact. Current implementation:
  `packages/cezar/src/runs/worktree-ownership.ts:50-68,84-112`.
- An existing non-empty but unparsable foreign `runs.json` fails closed. It is marked unreadable
  rather than interpreted as no owner
  (`packages/cezar/src/runs/worktree-ownership.ts:23-38,58-66`).
- The boot root must be added explicitly because it is not a registered project. Production wires
  `deps.repoRoot` into `ProjectContexts`; a structural regression test pins that dependency at
  `packages/cezar/src/server/server-boot-root-wiring.test.ts:19-28`.
- Ownership is sampled when the delayed sweep fires, not when the project context is built. The
  current target-project call site builds the candidate roots, loads foreign indexes, declines on
  ownership or unreadability, and records every outcome at
  `packages/cezar/src/server/project-context.ts:451-483`.
- The creation-side write-ordering gap is closed by persisting the current deduplicated
  `workspaceWorktrees` snapshot after each materialized worktree. The active wiring is at
  `packages/cezar/src/workflows/run.ts:4156-4163,4877-4887`.

## Current prune behavior

Commit `5ffa383c` shipped the cross-project ownership fix and regression coverage. It is an
ancestor of `origin/main`. Later spec `.ai/specs/2026-08-22-live-worktree-reaped-mid-run.md` (KB
`specs-1470bd6c6779`) and commits `362865ec` plus `32379c34` strengthened the destructive
backstop. They supersede only the accepted spec's original ancestry-gated branch-deletion layer,
not its cross-project ownership decision.

Today `pruneOrphans`:

1. declines candidates protected by a fresh or unreadable lease;
2. declines all candidates when the ownership check is unavailable;
3. declines a candidate claimed by a foreign workspace run;
4. autosaves a candidate before directory removal;
5. keeps the directory if autosave refuses or fails; and
6. always keeps the recovery branch.

Those contracts are visible in `packages/cezar/src/git-worktree.ts:571-599,635-707`. The project
context writes a durable outcome row to `.ai/cezar/worktree-reaps.jsonl` and logs removed, kept,
and declined ids with their reasons at
`packages/cezar/src/server/project-context.ts:474-481`. Removal is therefore no longer silent.

## Existing verification

- The exact requested regression shape is present at
  `packages/cezar/src/server/project-context.test.ts:534-586`: a workspace-owned worktree under a
  target project survives target `ProjectContexts` construction and its prune pass.
- Pure cross-project source loading and ownership matching are covered in
  `packages/cezar/src/runs/worktree-ownership.test.ts`.
- Real-git prune outcomes, including foreign ownership, unreadable ownership, leases, autosave,
  directory removal, and branch preservation, are covered from
  `packages/cezar/src/git-worktree.test.ts:543-715`.
- The accepted spec records green typecheck, build, unit, and package gates and shipment in its
  status at `.ai/specs/2026-08-22-cross-project-worktree-orphan-prune-safety.md:8`.
- The rolling handoff records a production timing E2E on 2026-08-24 at 20:01 UTC. A live workspace
  run `da9033bd-a4d3-43c9-9fdf-2102109556ef` retained both its directory and branch across a cold
  restart and an authenticated target-project request that forced `ProjectContexts.build()`.
  Evidence was `/tmp/cezar-orphan-e2e-b3b5719c.log` with `E2E_EXIT=0`. Production journal text was
  unavailable to the service user, so the runtime E2E did not observe the console wording; the
  automated tests cover the reason-bearing outcome contract.

## Duplicate and contradiction record

Two 2026-08-22 runs investigated the same bug. The accepted spec records todos `4227ba55` and
`4a2e865e`, plus older duplicate `918a0d09`, at lines 10-38. Run `43ab17aa` started seven seconds
first and its design shipped as `5ffa383c`. This run's competing
`.ai/specs/2026-08-22-workspace-run-worktree-orphan-prune.md` is explicitly superseded at lines
3-6; its helper, unchanged prune signature, and three-arm dirty-worktree design did not land.
Commit `32e9549a` records that reconciliation. `cezar todo list` currently reports no todos filed,
so there is no remaining duplicate in flight.

The only prior decision contradicted by the accepted fix was W7's assumption that project-local
orphan pruning could safely reason about workspace-owned trees. That assumption has already been
corrected in the record. The later safety spec additionally corrected the accepted fix's original
proposal to sometimes delete branches.

## Questions for the next spec step

There is no unresolved product or architecture question for the task as stated. A new spec would
duplicate an implemented and verified feature. The next step should record a no-op reconciliation
against the accepted spec and current implementation.

If the workflow nevertheless requires evaluating residual gaps, it must keep them out of this
task's scope unless separately filed:

- Runtime journal permissions prevented direct observation of the console log wording, although
  durable `worktree-reaps.jsonl` outcomes and automated coverage exist.
- The later live-worktree safety spec has broader concurrent-load verification history of its own;
  that is not evidence that this task's exact production timing E2E remains open, because the
  handoff records that E2E as passed on 2026-08-24.

## Sources not found

`cezar todo list` returned no open todos. No GitHub issue or pull request is the subject of this
task. No newer decision was found that supersedes cross-project ownership visibility itself.
