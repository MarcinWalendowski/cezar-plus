# Brief: default workflow revision

**Task id:** 171c8647-0335-4a07-beb4-2d6a61246602
**Step:** Gather the record only. No spec, code, or tests were written or run.
**Date:** 2026-08-24

## The problem, in this repository's own terms

`spec-to-deploy` is cezar's default for both user-initiated and unattended runs. Its current eight-step chain is already close to the requested workflow, but does not express all of its required operational boundaries: an explicit Opus-first spec-authoring fallback, a SOL xhigh automated review, a separate mandatory merge to the target base branch, and an exception that prevents an agent from deploying the cezar service while clearly parking the task for a human deployment.

The requested sequence is ten stages: gather record, write spec, auto-review, optional manual review, implement, test, commit/push, merge to the repository base branch, update knowledge, then deploy. The current chain is `context → spec → review-spec → implement → run-tests → commit-push → document → deploy`, so manual approval is an attribute of automated review, commit/push/merge are one stage, and documentation is already before deployment. [packages/cezar/src/workflows/types.ts:973-1423](../../packages/cezar/src/workflows/types.ts) is the current source of truth.

## What the record already decided

1. `spec-to-deploy` is the default everywhere, not merely in the composer. `DEFAULT_WORKFLOW_NAME` points to this built-in and the code documents that unattended fallbacks use it too. This was landed in `097d1b15`. [packages/cezar/src/workflows/types.ts:1425-1446](../../packages/cezar/src/workflows/types.ts). The original default-workflow decision is `.ai/specs/2026-08-19-spec-to-deploy-default-workflow.md` (KB `specs-e01401118cd2`).

2. The record sweep is already an isolated first agent step. It writes exactly one cited brief, then a fresh spec-writing session consumes it. This was the core decision of `.ai/specs/2026-08-20-split-steps-spec-review-and-approval-gate.md` (KB `specs-9a01e3bf2eeb`), implemented in `e9ed8f5a`. [packages/cezar/src/workflows/types.ts:979-1041](../../packages/cezar/src/workflows/types.ts).

3. Automated review and optional human approval are already separate mechanisms on the same `review-spec` step. The review is read-only, returns `CEZ:REVIEW=pass|revise`, and a revise verdict loops to `spec` at most twice. `requiresApproval: true` only parks when `approvals.minApprovers` is positive; its shipped default is zero, meaning auto-approved. [packages/cezar/src/workflows/types.ts:1088-1151](../../packages/cezar/src/workflows/types.ts), [packages/cezar/src/config.ts:115-136](../../packages/cezar/src/config.ts), and `.ai/specs/2026-08-20-split-steps-spec-review-and-approval-gate.md`.

4. The original per-step policy said Claude Opus reviews the spec and Sonnet does the remainder, but the current code has since pinned both `spec` and `review-spec` to Claude Opus. KB `notion-5e72103be90f` and `notion-4f2df2939b43` record the correction. The current Codex router maps explore to Terra medium, construction to Luna xhigh, mechanical work to Luna medium, and writing to Luna high. [packages/cezar/src/workflows/types.ts:736-766](../../packages/cezar/src/workflows/types.ts), [packages/cezar/src/workflows/types.ts:818-831](../../packages/cezar/src/workflows/types.ts). The requested SOL xhigh reviewer is a deliberate new policy, not the present behavior. KB `notion-9a809f12b937`, commit `b2c3aa79`.

5. The no-blocking policy already makes a model/runner preference advisory when its provider is unavailable. Therefore "Opus, fallback if unavailable" must reuse or explicitly tighten that resolver behavior, rather than adding a second availability mechanism. KB `notion-5ce876561d8f`; `.ai/specs/2026-08-23-never-block-a-task.md`.

6. Tests are a dedicated pre-shipping step. Its prompt tells the agent not to rerun a completed gate unless code changed, and it cannot commit or push. [packages/cezar/src/workflows/types.ts:1184-1257](../../packages/cezar/src/workflows/types.ts). There is no durable machine-readable test-attestation consumed by a later stage, so the spec must decide how "do not rerun tests if passed previous one" remains true across commit and merge.

7. The current `commit-push` can commit, push, open a PR, or merge according to repository convention. It is green only after the tree is clean and any configured upstream is caught up, but it does not require a merge to the target base branch. [packages/cezar/src/workflows/types.ts:1260-1310](../../packages/cezar/src/workflows/types.ts), [packages/cezar/src/workflows/postconditions.ts:117-182](../../packages/cezar/src/workflows/postconditions.ts). The user-confirmed UI merge precedent intentionally excluded auto-merge: `.ai/specs/2026-07-25-github-pr-merge.md`.

8. `document` already updates the KB, spec status, and tracker before deployment, then commits and pushes the record. [packages/cezar/src/workflows/types.ts:1313-1387](../../packages/cezar/src/workflows/types.ts). It and `commit-push` are protected by the `everything-committed` postcondition, while deploy requires every declared deploy-target probe to pass. `.ai/specs/2026-08-20-steps-green-only-when-verified.md`, commit `57fc8807`.

9. Deployment is currently intentionally unrestricted, discovers each repository's documented deployment mechanism, and fails closed if all declared probes do not pass. [packages/cezar/src/workflows/types.ts:1389-1420](../../packages/cezar/src/workflows/types.ts), [packages/cezar/src/workflows/postconditions.ts:184-310](../../packages/cezar/src/workflows/postconditions.ts). For cezar itself, repository instructions instead require automatic self-deploy, with a blue-green path designed to survive the service restart. [packages/cezar/src/server-install/self-safe-deploy.ts:4-20](../../packages/cezar/src/server-install/self-safe-deploy.ts); `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`. The requested cezar-service exception directly supersedes this decision and must be recorded as such.

10. A new public run-status value is risky. Published run status is currently `queued | running | waiting | review | done | failed | cancelled`, and the earlier approval design deliberately reused `waiting` rather than widening the contract. [packages/contract/src/runs.ts:30-59](../../packages/contract/src/runs.ts), `.ai/specs/2026-08-20-split-steps-spec-review-and-approval-gate.md:113-125`. An "await manual deployment" presentation should first be designed as `waiting` plus a persisted reason and terminal transition, unless the spec makes and records a released-contract case for a new status.

## Code actually involved

- `packages/cezar/src/workflows/types.ts`: built-in sequence, prompts, tools, model and runner selections, `requiresApproval`, and default constant.
- `packages/cezar/src/workflows/run.ts`: step execution, review revision loop, approval parking/recovery, model and account resolution, and KB-write environment injection.
- `packages/cezar/src/runs/approvals.ts`, `packages/cezar/src/runs/store.ts`, and `packages/contract/src/runs.ts`: distinct approvals, persisted run state, and published status contract.
- `packages/cezar/src/workflows/postconditions.ts`: commit and deployment proof conditions that must survive any stage split.
- `packages/cezar/src/config.ts`, relevant server routes, and cockpit task-thread views: approval settings and any new manual-deployment reason/action presentation.
- `packages/cezar/src/server-install/self-safe-deploy.ts` plus deployment CLI code: cezar service detection and the existing self-deploy mechanism to suppress only for cezar-service deployment.
- Workflow and server unit/E2E tests surrounding the files above, especially `packages/cezar/src/workflows/types.test.ts`, `approval-gate.test.ts`, `postconditions.test.ts`, and web review-gate/workflow E2Es.

## Duplicate and in-flight check

`cezar todo list` reported `no todos filed`; no worktree was found for this workflow revision. The working tree is clean at `7c41ab0e`. This is nevertheless a high-collision area: recent commits `b2c3aa79` and `3b62db40` changed the model-routing portions of `packages/cezar/src/workflows/types.ts`. The implementation step should integrate current `main` immediately before editing that file.

## Prior decisions this change would contradict

- The standing cezar self-deploy instruction in `AGENTS.md` and the self-safe deployment design must be explicitly superseded for agent-run workflow deployment of the cezar service.
- The existing decision to let `commit-push` follow per-repository push/PR/merge convention becomes incompatible if merge to the base branch is mandatory and a separate stage.
- The implemented Opus review policy becomes incompatible with SOL xhigh review, and current code's Opus spec-author pin needs an explicit fallback contract.
- The published-status compatibility policy argues against simply adding `await manual deployment` as a new enum member.

## Open questions the spec must settle

1. What exact provider/model is "SOL xhigh", and does it replace only review-spec while spec remains Opus-first? What exact fallback order applies when Opus or SOL is unavailable?
2. How is an unavailable model detected and recorded without silently changing a frozen workflow definition?
3. Does the separate merge stage always create and merge a PR, or may it fast-forward/direct-push where the repository allows it? How do protected branches, required reviews, merge conflicts, and post-merge verification settle the stage?
4. What evidence proves the tested revision is the one committed and merged, and what changes invalidate it and require tests again?
5. Is KB/spec/tracker documentation an actual separate `update-knowledge` step after merge, or is the existing `document` step renamed and retained before deploy? How is its commit merged if knowledge changes occur after the main code merge?
6. What exact scope identifies "cezar service required to be deployed" in a multi-package repository, and how does its manual deployment state resume after a human deploys and supplies proof?
7. Can `waiting` plus a persisted reason represent `await manual deployment` without a new public status? What are all exits: confirmed manual deployment, request changes/retry, cancel, restart recovery, and failed verification?
8. Should non-cezar deployments remain automatic only when a documented mechanism and `.ai/deploy-targets.json` exist, preserving today's fail-closed probes?

## Facts that constrain the next step most

1. The current default already has separate record, spec, review and optional approval stages, so the spec should reshape rather than rebuild them.
2. Manual cezar-service deployment directly conflicts with a current automatic self-deploy rule and needs an explicit corrected decision.
3. Separate commit/push, merge, and knowledge stages require new ownership and postcondition boundaries so the existing fail-closed checks are not weakened.
4. `await manual deployment` should avoid widening the released status union unless the spec establishes a compatibility-safe contract change.
