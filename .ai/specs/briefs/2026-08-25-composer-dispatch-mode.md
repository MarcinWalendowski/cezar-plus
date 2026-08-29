# Brief: Composer dispatch mode

**Task:** Make input-to-tasks honor composer dispatch mode  
**Date:** 2026-08-25  
**Scope:** record and code investigation only. No spec, code, build, or test was written or run.

## The problem, in this repository's own terms

Workspace composer submissions default to the built-in `input-to-tasks` workflow. Its file step deliberately files todos without `--start`; its third `dispatch` step is nevertheless always part of the persisted workflow definition. When the workspace composer toggle is off, that agent receives `{{autoStart}} = false`, reports a no-op, and still consumes a session and tokens. Production run `ed71bbd9` proved exactly that: a toggle-off submit filed todo `1da9c2bb`, then ran a green `dispatch` step that started nothing. [commit `eb9c033d`; `.ai/specs/2026-08-25-workspace-scope-routes-tasks.md:610-647`]

The task intentionally tightens the earlier design. Filing-only must have a two-step frozen plan, not a three-step plan whose last prompt declines to act. A filed-and-dispatched run must retain the third step and mark every todo it filed for autostart. The completion surface must turn each created todo into a direct cockpit link qualified by project and todo ID, rather than depending on unstructured agent prose.

## What the record already decided

- Workspace work is routed into existing project boards, never performed in project worktrees. `input-to-tasks` is the default workspace workflow and was intentionally designed as context, file, optional dispatch, with the composer toggle defaulting off. [`.ai/specs/2026-08-25-workspace-scope-routes-tasks.md:1-51,483-505`; commit `dc64b741`; KB `specs-92903f1ea91f`]
- The composed `autoStart` choice is already persisted on the run and re-read from the record on restart. This establishes the required deterministic decision source, but current code applies it only while templating the always-present dispatch prompt. [`.ai/specs/2026-08-25-workspace-scope-routes-tasks.md:485-530`; `packages/contract/src/workspace-run-start.ts:44-64`; `packages/cezar/src/workflows/run.ts:1540-1555,6417-6422,6799-6809,7875-7890`]
- The former verification expressly expected a third-step no-op when false. That statement conflicts with this task's no-session/no-token acceptance criterion and must be corrected in place by the future spec, leaving the original text beneath the correction. [`.ai/specs/2026-08-25-workspace-scope-routes-tasks.md:417-420,522-548,690-725`]
- The Backlog composer is distinct: it is a single-project filing-only UI feature, already landed. It must not be repurposed as the workspace solution. [KB `specs-e2c7601d0487`; `.ai/specs/2026-08-24-land-the-backlog-composer.md`; commit `48f9892c`]
- A prior filing design establishes that `cezar todo add --start` carries autostart intent and that filing and starting are observable separate acts. [KB `specs-431b083f99d4`; `packages/cezar/src/todos.ts:666-674`; `packages/cezar/src/todo-cli.ts:231-237`]
- The product domain record says cold-project intent discovery is now on `origin/main` as `e8a2b1d6`, but remains QA Needed. This task must not duplicate or undo that ON-path watcher work. [KB `notion-711b57ca383e`; `.ai/specs/2026-08-25-lazy-project-watchers.md`]

## Code actually involved

- `packages/web/src/routes/new-task.tsx:177-183,517-549,874-878` and `packages/web/src/routes/new-task-form.ts:346-364`: workspace-only, off-by-default toggle; false is omitted and true is sent.
- `packages/contract/src/workspace-run-start.ts:44-77` and `packages/cezar/src/server/workspace-run-routes.ts:98-161`: request contract and route transport for the optional flag and default workflow.
- `packages/cezar/src/workflows/types.ts:441-523`: built-in `input-to-tasks`; the `file` step prohibits `--start`, while `dispatch` is unconditional workflow topology and merely prompt-optional.
- `packages/cezar/src/runs/store.ts:428-434,833-866` and `packages/cezar/src/workflows/run.ts:1540-1555,6417-6422,6799-6809`: persisted run decision and restart reconstruction.
- `packages/cezar/src/workflows/load.test.ts:114-148`, `packages/cezar/src/workflows/auto-start-template.test.ts:95-134`, and `packages/cezar/src/server/workspace-run-routes.test.ts:193-251`: current topology, template, and transport coverage, all narrower than the new acceptance criteria.
- `packages/web/src/routes/new-task-project.test.tsx:521-554`, `packages/web/src/routes/new-task-form.test.ts:442-466`, and `packages/web/src/routes/new-task-draft.test.ts:351-369`: existing composer mode coverage.

No structured created-todo result was found on `workspaceRunStartResponse` or `RunRecord`; the file prompt only asks the agent to report project and ID. No input-to-tasks completion-link parser/component, completion analytics event, or browser E2E was found. Existing `/tasks` precedent keys rows as `<project>:<todo-id>` and calls `POST /p/:projectId/todos/:id/start`. [`.ai/specs/2026-08-24-bulk-start-filed-tasks.md`; commit `7932cf4d`]

## Duplicate and in-flight work check

This task is present once in `/var/lib/cezar/loki-labs/cezar/.ai/cezar/todos.json:3986-3993`; the CLI's default list showed no todos, and no second matching active task or worktree was found. The working tree was clean before this brief. The immediate predecessor is `dc64b741`, not a duplicate.

The only adjacent work is cold-project autostart consumption: it is already landed as `e8a2b1d6` and QA Needed. It overlaps the ON path after todos are marked, not dispatch-plan elision or completion links. Bulk-start filed tasks (`7932cf4d`) is related UI precedent, not duplicate work.

## Open questions the spec must settle

1. Where does plan shaping live so the persisted `workflowDef` contains only `context` and `file` when false, and all three steps when true, without changing custom workflow semantics?
2. What durable, structured record captures zero, one, or many todos created by the file step, including project identity, todo ID, title, and any partial failure, so completion links do not parse prose?
3. What exact cockpit route is the direct destination for a project-qualified todo, and what contract/API projection exposes it to the completion summary?
4. Which two analytics events or one event with a `dispatchMode` dimension distinguish `filed-only` from `filed-and-dispatched`, and where is completion emitted so restarts cannot double-count?
5. How will tests control the filing boundary for zero, one, and many todos in each mode, prove the false plan has no `dispatch` spawn/session/token record, prove restarts reuse the frozen topology, and prove true marks every filed todo?
6. What browser fixture can safely prove navigation links and the absent third step, with screenshots/video retained, without vacuous assertions against the boot project or a different run scope? The prior composer E2E warns that an unregistered boot project and unscoped runs endpoint can both yield false passes. [`.ai/specs/2026-08-24-land-the-backlog-composer.md:1-70`]

## Constraints for the next step

The next spec must include verification and analytics before implementation. It must amend the old no-op-dispatch claim in `.ai/specs/2026-08-25-workspace-scope-routes-tasks.md` in place, preserve the existing frozen-run restart principle while moving it from prompt data to workflow topology, and explicitly exclude the already-landed cold-project watcher change.
