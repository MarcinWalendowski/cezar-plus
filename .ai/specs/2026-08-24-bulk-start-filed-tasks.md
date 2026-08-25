# Bulk start filed tasks

- **Status:** Implemented, QA needed
- **Date:** 2026-08-24
- **Owner instruction:** "allow to select multiple tasks and run them all"

## TLDR

The Filed table on `/tasks` gains row selection, select all for rendered rows, and one `Run N
tasks` action. Each selected todo starts against its own project in display order. The page does
not navigate during the batch.

## Problem

Filed tasks can only be started one at a time. Starting one navigates to its run, so processing a
batch requires repeated trips back to the Filed table.

## Solution

Store selected rows as project-qualified todo keys. Intersect selection with the currently visible,
filtered, sorted rows before starting. Submit starts serially, continue after individual failures,
refresh the todos and runs indexes once, report the result count, clear selection, and do not
navigate.

## Architecture

- `packages/web/src/lib/filed-tasks.ts` owns pure selection helpers.
- `packages/web/src/routes/global-tasks.tsx` owns the checkbox controls and batch mutation.
- Existing `POST /p/:projectId/todos/:id/start` remains unchanged.

## Phases

1. Add selection helpers and unit tests.
2. Add responsive selection controls and batch start behavior.
3. Remove the superseded string-contract deploy-probe unit suite. Keep the newer structured-contract
   package E2E suite as the probe's single authoritative coverage.
4. Verify gates and production behavior.

## Data models

No persisted data model changes. Selection is a React `ReadonlySet<string>` keyed as
`<project>:<todo-id>`.

## API contracts

No API changes. The client invokes the existing start endpoint once per selected todo.

## Analytics

The existing todo start and run creation events fire once for every successfully started task. No
new aggregate event is introduced because the server receives independent existing operations.

## Risks

- Hidden selected rows must never start. The action intersects with visible rows.
- A large batch must not create a request burst. Starts are serialized.
- One failure must not abort later starts. The result toast reports successful and total counts.
- Duplicate tests for two incompatible deploy-probe contracts make the release gate permanently
  red. Delete the superseded unit copy and retain the stronger seven-scenario package suite.

## Verification

1. Pure helper tests cover identity, toggle, batch set, visible ordering, and tri-state selection.
2. Route tests cover cross-project starts, no navigation, select all, Clear, hidden rows, and partial
   failure.
3. Run `npm run typecheck`, `npm test`, `npm run test:unit`, `npm run build`, and
   `npm run test:package` successfully.
4. Confirm the deploy-probe package suite covers structured verdicts, missing credentials, project
   scope, reconnect continuity, gaps, expiring credentials, and perimeter redirects.
5. **CORRECTED 2026-08-25:** The production E2E ran on 2026-08-25 at 08:18. Its artifacts are
   preserved at `/var/lib/cezar/e2e-artifacts/bulk-start-480e0282/`; it failed at the post-start
   row-removal assertion, its cleanup failed and left two live runs, so the feature remains
   **QA Needed**.

   > 5. On production, select two disposable filed tasks, run the batch, verify both runs appear and the
   >    browser remains on `/tasks`, then cancel or clean up the disposable runs.
