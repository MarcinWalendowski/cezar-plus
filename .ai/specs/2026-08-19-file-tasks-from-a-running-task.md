# Filing (and optionally auto-starting) a workspace task from a running task

**Status:** implemented — Phase 1 + 2 (Phase 3 deferred). QA needed: backend deploy (cezar.service
restart) pending, so the agent-prompt doc and the auto-start watcher are not yet live on prod;
the `cezar todo add` CLI works after a dist sync without a restart. Analytics left as
`TODO(analytics)` markers (no telemetry sink exists in the codebase). typecheck + new tests green.
**Date:** 2026-08-19
**Owner ask:** "let's allow adding tasks to workspace tasks from another task — e.g. from this
task, file 'implement the non-disruptive-deploy spec'." Decision: **also allow auto-start.**

## TLDR

Give a running agent a first-class way to file a **workspace task**: `cezar todo add`. By
default it files a lightweight backlog **todo** that appears in the tasks list and starts on
demand; with `--start` the running cockpit picks it up and executes it. No new task type — this
reuses cezar's existing todo → run machinery.

## Problem

A running task cannot cleanly create another task today:

- The UI path (`/workspace/new`) files a **note** and triage-processes it (`workspace-new-task.tsx:131`);
  `POST /workspace/runs` (`workspace-run-routes.ts:71`) starts a run **immediately** with no draft
  state. Neither is agent-reachable.
- Agents can append to `CEZ_TODOS_FILE` (`.ai/cezar/todos.json`) — but only when `CEZ_FOLLOWUPS=1`
  (`handoff.ts:127-162`), and only into the current project's inbox. It's a file convention, not a
  named "add a task" affordance.
- The loopback API (`POST /api/v1/todos`, `server.ts:5489`, ungated by capability) still sits behind
  the `/api/v1` principal perimeter — a headless agent gets 401 (same wall host-metrics hit).
- **Auto-start has no path at all:** queued runs are revived only at **boot**
  (`run.ts:1114 reviveQueuedRun`, `:1195-1203`); there is no runtime watcher for a run added to the
  store externally, and no CLI→running-server channel. So "start it now" must be done *by the running
  cockpit's own manager*, not by the CLI spawning a second one.

## Solution

### Phase 1 — `cezar todo add` (file a backlog task)

A new CLI subcommand, sibling to `cezar kb`, that writes a todo straight to the target project's
`.ai/cezar/todos.json` on the filesystem (bypassing the HTTP auth wall, exactly as `cezar kb write`
does):

```
cezar todo add "<summary>" [--project <id|path>] [--context <text>] \
     [--acceptance <text> ...] [--priority low|normal|high] [--skill <name>] \
     [--spec <path>] [--json]
```

- Defaults `--project` to the current repo; a bare id/path targets any registered project (so
  this task, running in the workspace, can file into the `cezar` project).
- Writes `origin: 'agent'`, `status: 'todo'`; `--spec` becomes a `knowledgeRefs[]` pointer.
- Reuses the `todos.ts` store helpers + `createTodoInputSchema`, so the record is identical to a
  composer-filed one and shows in the `/tasks` **Filed** board and `/workspace/todos` with no
  restart (both read `todos.json` per request).
- **Documented in the agent system prompt** (`handoff.ts`) next to `cezar kb`, available whenever
  todos exist — not gated behind `CEZ_FOLLOWUPS`. This is what makes "add a task from a task" real.

### Phase 2 — `--start` (auto-start via the running cockpit)

`cezar todo add --start` files the todo **and marks it for auto-start** (`autostart: true` on the
todo record). The **running cockpit** — the one process that already owns the manager, the
concurrency cap and the single-workspace-run lease — is what starts it:

- A lightweight runtime hook in the server watches `todos.json` (the same `fs.watch` pattern the
  knowledge/reports indexes already use, e.g. `workspace-reports-routes.ts:43`) and, for any todo
  with `autostart: true && !startedTaskId`, calls the **existing** start logic
  (`POST /todos/:id/start` internals, `server.ts:5531`) through its own manager, then clears the flag
  and stamps `startedTaskId`.
- Double-start safe (the `startedTaskId` guard, `server.ts:5543`), concurrency-capped, and it obeys
  the single-workspace-run lease — a started task queues behind a busy workspace rather than fighting
  for the working tree.
- **Rejected alternative:** the CLI running the agent itself (a second, headless manager). Two
  managers on one repo fight the working-tree lease and the cockpit can't live-stream a run it didn't
  start — so the run would show as a static row, not a live task. The cockpit-as-executor model is the
  only one that yields a real, streamed task in the UI.

### Phase 3 (optional) — surface filed todos in `/workspace/tasks`

`/workspace/tasks` lists **runs** only today (`workspace-tasks.tsx:134`). Add the Filed todos there
too (they already show on `/tasks`), each with the ▶ Start action, so "workspace tasks" literally
lists everything a task filed.

## Data model / API

- Todo record: unchanged except one additive field `autostart?: boolean` (`skills.ts todoItemSchema`
  + `todos.ts todoSchema`), cleared once started. Additive, so old readers ignore it.
- `cezar todo add` / `cezar todo list` (read is a bonus) — CLI only; no new HTTP route required
  (the write is filesystem, the start reuses the existing route's logic in-process).

## Risks

- **Auto-start runaway.** A loop that files+starts tasks could spawn many runs. Mitigate: the start
  path already respects the concurrency cap and workspace lease; add a per-source rate note in logs
  and keep `--start` explicit (never the default).
- **`fs.watch` reliability** (missed events on some FS): reconcile flagged todos on the same boot
  pass that already revives queued runs (`run.ts:1195`), so a missed event is caught at the next
  natural checkpoint.
- **Cross-project targeting** writes another project's `todos.json`; keep it within the registered
  set and honor the same containment as `fs/browse`.

## Verification (plan the test up front)

- **Unit:** `cezar todo add` writes a schema-valid todo to the right project's `todos.json`
  (summary-only and fully-specified); `--project` targeting; `autostart` set only with `--start`.
- **Integration:** a filed todo appears in `GET /workspace/todos` and the `/tasks` Filed board.
- **E2E (the acceptance test):** from a running task, `cezar todo add "…" --project cezar --start`;
  assert a new run appears in the cockpit **and streams live** (proves the cockpit, not the CLI,
  executed it), guarded against double-start.
- Gates: typecheck / lint / test green.

## Analytics

`todo.filed` (`origin`, `project`, `hasSpec`), `todo.autostarted` (`project`, `queuedBehindLease`).

## Out of scope

- A general agent-callable HTTP API (the filesystem CLI is enough and dodges the auth wall).
- Changing how runs themselves are stored or executed.
