# Silent Filed Play Starts

> **Status:** Implemented, QA Needed
> **Date:** 2026-08-29
> **Task:** `561c8954-8c0c-4974-8010-ba93ae2b09dc`

## TLDR

Clicking a Filed-board play control starts that task and refreshes task data without routing the
user into the new run's detail page. The standalone filed-task detail page retains its explicit
Start action and its existing follow-the-run behavior.

## Problem

The Filed board's compact play control uses the shared single-task start mutation. On success that
mutation currently routes to `/p/:projectId/tasks/:runId`. A board user loses their place and the
active board context even though their only request was to start the filed task.

## Solution

Give `useStartFiledTask` an explicit `followRun` option, defaulting to `true` for the standalone
detail page. Each Filed-board caller opts out with `followRun: false`. Successful starts still
invalidate the workspace todo and runs queries, so the board refreshes its state without a route
change. Failures retain the existing danger toast.

## Architecture

The change is confined to the web client:

- `packages/web/src/api/filed-task-mutations.ts` owns the option and shared cache invalidation.
- `packages/web/src/routes/global-tasks.tsx` opts all Filed-board play controls into in-place starts.
- `packages/web/src/routes/global-tasks.test.tsx` proves the project-scoped POST happens and the
  pathname stays `/tasks`.

No HTTP contract, persisted data, analytics event, or backend behavior changes.

## Phases

1. Add the `followRun` option to the shared mutation and set all Filed-board consumers to false.
2. Update the Filed-board start regression test.
3. Tests and typecheck were explicitly declined by the user. Commit the spec and code together.

## Data models

No persisted data model changes. `followRun` is an in-memory hook option only.

## API contracts

No API change. The existing project-scoped `POST /api/v1/p/:projectId/todos/:todoId/start` request
and response remain unchanged.

## Risks

The shared mutation also drives the standalone task-detail page. Defaulting `followRun` to true and
requiring the board to opt out prevents this focused UI behavior from changing that page.

## Verification

1. Focused regression: click a Filed-row play control, observe the correct project-scoped POST, and
   assert the pathname remains `/tasks`.
2. `npm run test -w @loki-labs/better-cezar-web -- src/routes/global-tasks.test.tsx` was not run,
   at the user's instruction.
3. `npm run typecheck -w @loki-labs/better-cezar-web` was not run, at the user's instruction.
4. Runtime browser E2E is required before calling this user-facing change fully verified. It is QA
   Needed if that browser pass is not run.
