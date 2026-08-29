# Lazy project watchers

**Date:** 2026-08-25  
**Task:** `1f5aa96e-1254-4b78-a603-0307ff0fee94`, step 1 of 9, Gather the record  
**Finding:** the reported gap is present at HEAD `2fd01a16`. It is one shared lazy-context
problem with two affected intent files, not two independent bugs. No code, spec, or test was
written in this step.

## Problem in repository terms

`ProjectContexts` deliberately does not build a registered project's `RunManager` until that
project is accessed. That is normally the correct zero-config and recovery boundary. The server
currently attaches both the todo-autostart and reopen-request watchers only to the boot context,
contexts already in the in-memory map, and contexts built later. Thus a registered project which
has not been opened since server boot is neither watched nor reconciled. Its on-disk pending intent
is inert until some unrelated API access happens to make it resident.

This is now directly exposed by `input-to-tasks`: its optional dispatch step calls `cez todo start
<id> --project <project>`, but that CLI intentionally only sets `autostart: true`. It explicitly
leaves execution to the running cockpit, which is the owner of the target project's concurrency cap
and run manager. See `packages/cezar/src/todo-cli.ts:229-240,299-310` and
`.ai/specs/2026-08-25-workspace-scope-routes-tasks.md:277-280,483-493` (shipped in `dc64b741`).

## What the record already decided

- The accepted autostart architecture is file intent plus the running cockpit, not a second
  headless manager. A second manager would race the working-tree lease and would not stream through
  the cockpit. `.ai/specs/2026-08-19-file-tasks-from-a-running-task.md:58-70` records that decision;
  its missed-event mitigation was only a later boot reconciliation (`:95-99`).
- Reopen deliberately reused that exact ownership model: the CLI writes inert
  `reopen-requests.json`, while the target project's cockpit watcher calls that project's
  `RunManager.continueRun`. `.ai/specs/2026-08-20-reopen-finished-tasks-merge-audit.md:212-229,
  281-305`.
- The reopen record originally described the three-arm wiring as sufficient for every context, but
  the production execution record corrects that premise: it observed inotify watches for
  `workspace` and `cezar`, but not `chat`, because `chat` was non-resident. It says a project API
  read was only a workaround, that chat's subsequent residency was luck rather than a fix, and
  files todo `503195a8`. `.ai/specs/2026-08-20-reopen-sweep-execution.md:629-646,798-801,
  1051-1054,1085-1089`.
- The new dispatcher makes the analogous autostart half urgent. The record states that
  `--start` merely marks a todo and hands it to the cockpit watcher, so its success cannot be
  inferred from the flag appearing in `todos.json`. `.ai/specs/2026-08-25-workspace-scope-routes-tasks.md:254-280`.
- This repository is a public 0.x CLI with plain `.ai/cezar` state. Existing file shapes and CLI
  behavior are protected surfaces. An internal discovery mechanism that leaves those shapes and
  commands unchanged is compatible; changing them requires the documented deprecation path.
  `BACKWARD_COMPATIBILITY.md:1-5`.

## Code actually involved

- `packages/cezar/src/server/server.ts:1734-1755` contains both identical subscriptions: boot
  context, `contexts.ids()` plus `contexts.peek(id)`, then `contexts.onContextBuilt`. `peek` cannot
  reveal a project that has not already been constructed.
- `packages/cezar/src/server/project-context.ts:246-251,303-320,367-375` documents and implements
  lazy construction. Its test demonstrates an empty context map before access and a single
  materialized project after access: `packages/cezar/src/server/project-context.test.ts:88-104`.
- Calling `contexts.context(id)` to scan every registry entry is not safe. Construction opens the
  stores and manager, establishes a launch key, schedules orphan pruning and retention work, then
  performs `manager.recover()`: `packages/cezar/src/server/project-context.ts:409-496`.
- `watchTodoAutostart` makes an immediate reconciliation and subscribes to `todos.json`; pending
  means `autostart && !startedTaskId`: `packages/cezar/src/todo-autostart.ts:521-583`.
  Its existing tests are module-level watcher tests only, at `todo-autostart.test.ts:164-226`.
- `watchReopenRequests` is its twin: immediate reconciliation and subscription, with pending rows
  reconciled through the manager: `packages/cezar/src/reopen-watch.ts:70-125`. Its existing module
  tests are `packages/cezar/src/reopen-watch.test.ts:163-221`.
- A broad reopen subscription is expressly unsafe as a scanner. `onReopenRequestsChanged` starts a
  watcher, and `startWatch` calls `mkdirSync(dataDir, {recursive:true})` before `fs.watch`:
  `packages/cezar/src/reopen-requests.ts:286-312`. A scan must instead use a pure read. The reopen
  read contract says a missing file is read as empty without materializing state:
  `packages/cezar/src/reopen-requests.ts:209-214`. The equivalent todo read contract is
  `packages/cezar/src/todos.ts:423-453`.

## Current status and duplicate check

The defect is not already fixed. At `2fd01a16`, both watcher blocks retain the old shape unchanged;
the latest relevant product commit, `dc64b741`, adds the dependency on the autostart watcher but
does not change either subscription. History attributes the original autostart wiring to `4c0c0118`
and the reopen wiring to `b99317c5`. No later implementation was found after `dc64b741`.

The board supplied two halves of the same root cause: `f09bf585` for autostart and `503195a8` for
reopen. The installed `cezar todo list` returned no rows and offers no `show` subcommand, so the
exact tracker payload for `f09bf585` could not be independently read in this checkout. The open
reopen todo is independently recorded in the execution spec above. No GitHub issue or pull request
is the subject of this task.

Knowledge access caveat: `cez kb search` was disabled by default in this session; rerunning with
`CEZ_KB=1` located the relevant accepted specs, including KB records `specs-431b083f99d4` (file and
autostart) and `specs-27e66a48ddd6` (reopen sweep). No knowledge entry specifically indexed
`f09bf585`.

## Design constraints for the next spec

1. Do not eagerly construct every registered project. Build a context only after a pure inspection
   finds a pending autostart todo or reopen request for that project.
2. Do not call the reopen watch subscription merely to inspect candidates, because it creates a
   missing `.ai/cezar` directory.
3. Fix both watcher paths through one coherent design. Retaining separate discovery behavior would
   recreate the same asymmetric failure.
4. Preserve the existing context-built subscriptions for future live updates and the existing
   per-dataDir serialization and idempotence rules.
5. Regression coverage must exercise server-level registry discovery with a truly non-resident
   project. It must show that the pending file causes context construction and execution, while an
   absent or non-pending file causes neither context construction nor directory creation. Extend
   `reopen-watch.test.ts` for reopen and add the matching autostart coverage.
6. Production verification must name the project used and demonstrate non-residency before the
   pending flag is written or discovered. A context created beforehand does not test this defect.

## Open questions for the spec step

- What single server-level helper should enumerate registry roots and perform the pure pending-file
  inspection, and when should it run at boot and after a registry change?
- Is a one-time cold scan sufficient, or must registry additions receive the same pending-intent
  discovery path without subscribing every project directory?
- How should inspection failures for a missing, corrupt, or inaccessible project state be logged and
  degraded so a healthy project is never blocked by another project's bad state?
- Where should the server-level regression tests live so they can prove `createApp` wiring without
  duplicating the watcher modules' existing filesystem-watch tests?
