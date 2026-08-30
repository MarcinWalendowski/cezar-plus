# Brief: Open archived tasks as full pages

**Task:** "Open archived tasks as full pages" (`cc25d636-8412-4cff-afa5-568021a40cf9`, workflow `spec-to-deploy`, step 1/9 "Gather the record")
**Step:** Gather the record only, 2026-08-26. No spec written, no code changed.

## Problem, in this repository's own terms

The Cezar web cockpit's global Tasks board (`/tasks`, unscoped route) lists **filed tasks**
(todos, not agent runs) in a `FiledTasks` table, including Done/archived entries. Clicking a
row's title opens `FiledDetailDialog`, a modal, regardless of the row's status. Separately,
**run-backed** tasks (actual agent-run threads) already render at a dedicated,
project-scoped URL — `/p/:projectId/tasks/:id` — as a full page, not a modal, and that page
survives a hard refresh because the server serves the SPA shell for any non-`/api` GET and the
page hydrates itself from the URL param.

The owner wants the same "real page" treatment for a **Done/archived filed task**: clicking its
title in the Archived view should navigate to a dedicated, project-scoped full-detail URL
instead of opening the modal, without touching any other project's task views, and the new page
must carry everything the modal currently shows (metadata, context, requested work, acceptance
criteria, available actions) plus a new analytics event for "opened filed-task detail page."

## What the record already decided — with citations

- **The task's own citation is a mis-citation.** `.ai/specs/2026-08-17-notion-export-cezar-import.md`
  is the Notion→cezar corpus-export/KB-mount spec (Status: "Implemented... no cezar code
  changes"). It says nothing about filed-task detail views, dialogs, or routing; its only
  relevant thread is that it explains why the Tasks board reads `todos.json` rather than the
  Notion-export KB mount, and it explicitly records that its own v1 migration approach was
  **"superseded same evening by `2026-08-17-filed-tasks-table-statuses.md`."** Confirmed by a
  dedicated research pass — do not treat it as governing this feature.
- **The actual governing decision is `.ai/specs/2026-08-17-filed-tasks-table-statuses.md`**
  (KB `notion-7bb302edff13`, `specs-fc81f822fe2d`; shipped `c65ca0bf`, 2026-08-17). This is
  where `FiledDetailDialog` was introduced, in direct answer to the owner's QA complaint
  *"I can't open task to see details or to archive it"* — the modal **is** the prior decision
  this new feature partially supersedes for archived/Done rows. Its acceptance criteria
  ("Open a filed task and see its details — dialog with markdown body ✓") are exactly the
  criteria this new feature must keep satisfying, just via a page instead of a dialog, and only
  for the Archived/Done case per the task's own acceptance criteria.
- **`.ai/specs/2026-08-25-workspace-scope-routes-tasks.md` is a name collision, not prior art.**
  Its "routes tasks into projects" is about a *workspace-scoped agent run* filing one todo per
  project (`cez todo add --project <id>`) instead of editing every project's checkout — dispatch
  semantics, not browser routing/URLs. Confirmed by direct read; do not cite it in the spec as
  related routing work.
- **No spec proposes a dedicated route/page for a filed task's detail, and no spec documents an
  analytics/event-naming convention anywhere in `.ai/specs/`.** Both are genuinely new spec
  territory. No brief in `.ai/specs/briefs/` overlaps this feature.
- **No duplicate in-flight work.** Checked branch/worktree history (~70 `cez/*` branches, ~20
  worktrees), `git log --all` on `global-tasks`/`FiledDetailDialog` paths, and the workspace
  `todos.json`. The only matching todo (`12dc1ac0-a989-43bd-b012-711f85bb7b01`, filed
  2026-08-26T09:34:10.946Z, "Open archived tasks as full pages") is this same run's own filed
  record, not a separate parallel effort.

## Code actually involved

- **Filed-task UI, entirely in one file:** `packages/web/src/routes/global-tasks.tsx` (2586
  lines). `FiledTasks` (727–966) owns dialog state (`detail`/`setDetail`, line 755) and renders
  `FiledDetailDialog` (952–963). Title-click triggers: `FiledRow` (1103–1229, button at
  1146–1156) and `FiledCard` (1237–1334, button at 1276–1284), both wired via
  `onOpenDetail={() => setDetail(entry)}` (870, 925). Row/card type is `WorkspaceTodoEntry`
  (`@loki-labs/cezar-plus-api-client`), keyed `${entry.project}:${entry.todo.id}` — the
  project is already known at click time.
- **`FiledDetailDialog`, same file, 1347–1502.** Renders status/priority pills, project link,
  filed date (1406–1419); `context` (1421–1428), `whatToDo` (1430–1439),
  `acceptanceCriteria[]` (1441–1458), `knowledgeRefs[]` links (1460–1478); footer Start
  (1481–1489) and Archive/Restore (1490–1498). It does **no project-scoping of its own** — it
  trusts the `entry.project` string passed in. Calls `useStartFiledTask` (1506–1520, navigates
  via scoped `useNavigate`) and `useUpdateFiledTodo` (1560–1592, `PATCH` via
  `updateWorkspaceTodo`) — both reusable by a page.
- **Run-backed precedent route:** `packages/web/src/routes.tsx:502–513`, registered inside the
  `/p/:projectId` (`ProjectScopeRoute`) layout as `tasks/:id` → lazy `TaskThreadRoute`. Actual
  page: `packages/web/src/routes/task-thread/task-thread.tsx:71+`, reads `useParams().id`,
  fetches via `useRun(id)`/`useRunHistory(id)`. Flat `/tasks/:id` bookmarks redirect via
  `LegacyPathRedirect` (routes.tsx:309–371) into the scoped form. Direct load/refresh works
  because the server returns the SPA shell for any non-`/api` GET and the page re-fetches by id
  from the URL — no reliance on router navigation state.
- **Router:** React Router (component-based `<Routes>/<Route>`, not a data router), centrally
  registered in `packages/web/src/routes.tsx`. Project scoping is layered via
  `packages/web/src/lib/project-router.tsx` (`scopeTo(projectId, to)`, scoped
  `Link`/`useNavigate`, lines 65–127) — anything the new page/links use must go through this,
  not raw `react-router` exports.
- **Data model:** `todoItemSchema` in `packages/contract/src/skills.ts:73–157` (`status`,
  `priority`, `archivedAt`, `context`, `whatToDo`, `acceptanceCriteria[]`, `knowledgeRefs[]`,
  etc.); cross-project wrapper `workspaceTodoEntrySchema` in
  `packages/contract/src/workspace-todos.ts:31–34`. Server routes in
  `packages/cezar/src/server/server.ts` (~6101–6190): `GET /:projectId/todos` (list only —
  **no single-item GET exists**), `PATCH /:projectId/todos/:id`, `DELETE`, `POST .../start`.
  Client wrappers in `packages/web/src/api/client.ts` (`startWorkspaceTodo`,
  `updateWorkspaceTodo`, workspace list).
- **Blast radius is naturally contained.** `FiledTasks`/`FiledRow`/`FiledCard`/
  `FiledDetailDialog` exist only in `global-tasks.tsx` and are used only by the `/tasks` route.
  The per-project `TasksOverview` (`packages/web/src/routes/tasks-overview.tsx`) renders only
  run-backed rows, no todos, no dialog. `/workspace/tasks`
  (`packages/web/src/routes/workspace/workspace-tasks.tsx`) is a separate runs-only board.
  Neither is touched by this change — matches the task's "without changing other projects"
  constraint by construction, not by extra care needed in the spec.
- **Tests:** `packages/web/src/routes/global-tasks.test.tsx` has a detail-dialog test at
  ~1684–1710 that will need to change or split. `task-thread.test.tsx` is the pattern for
  testing a full-page task route. **No e2e file exists for `global-tasks`/`FiledDetailDialog`/
  filed-task flows** (existing e2e under `packages/web/e2e/` covers only run-backed
  `task-thread`, `task-changes`, `task-files`, `new-task`) — the runtime browser E2E the
  acceptance criteria demand is new e2e territory, not an extension of an existing spec.

## Contradictions and open questions the spec must settle

1. **Scope of the toggle.** The task's acceptance criteria name only the Archived view + Done
   status. Does the modal stay for active/todo/in-progress/blocked rows, or does every filed
   task now navigate to the page? The brief's code map shows both code paths (dialog and a new
   page) would coexist unless the spec kills the dialog outright — that's a real design
   decision, not implementation detail. Given this repo's no-backward-compatibility default,
   killing the dialog entirely (for all statuses) is worth considering explicitly rather than
   defaulting to a status-conditional fork, which is closer to a compatibility shim.
2. **URL shape and collision.** The run-backed page already owns `/p/:projectId/tasks/:id`
   keyed by run id. A filed todo's id is a different id space but the path segment is identical,
   so the new route needs its own segment (e.g. `/p/:projectId/tasks/filed/:id` or
   `/p/:projectId/todos/:id`) to avoid ambiguity with `TaskThreadRoute`'s matcher — the spec must
   pick one and check it doesn't collide with the "acknowledged, unreconciled duplication"
   between `/tasks` and `/workspace/tasks` noted at `routes.tsx:780–791`.
3. **Refresh/direct-load without a single-item endpoint.** There is no `GET
   /:projectId/todos/:id`. Options: add one, or hydrate from the existing per-project/workspace
   todo list fetch by filtering for the id client-side (works on refresh too, since the page
   would trigger its own list fetch, same pattern the modal doesn't need today because it's only
   ever opened from an already-loaded row). The spec needs to pick one and justify it against the
   acceptance criteria's explicit "survives direct load or browser refresh" requirement.
4. **Analytics has no existing mechanism to extend.** A repo-wide search of `packages/web/src`
   found zero product-analytics module (no `track()`, no PostHog/Segment/Amplitude/Mixpanel/
   GA). Cezar's own doctrine (`AGENTS.md`) describes it as fully local — "no accounts, no
   database, no cloud" — so a conventional analytics SDK would be a doctrine violation, not a
   gap to fill the usual way. The spec needs to decide what "analytics" means here: a local
   NDJSON event log (consistent with how the rest of cezar's state is stored), a console/log
   line, or something else — and should confirm there's no existing local event-log mechanism
   elsewhere in the server (`packages/cezar/src/server/`) before inventing one, since this
   research pass scoped its analytics search to `packages/web/src` only.
5. **Actions parity.** The modal's footer actions (Start, Archive/Restore) call
   `useStartFiledTask`/`useUpdateFiledTodo`, which are hooks, not dialog-specific — they should
   be directly reusable on a page. The spec should confirm whether "Start" is even a valid action
   on an already-Done/archived task (semantically odd — starting a task that's already done), or
   whether the page's action set for archived rows is narrower than the dialog's (e.g. only
   Restore, no Start) per the acceptance criteria's "available task actions" being described as a
   preserved set, not necessarily an identical one.

## What I could not find

- No existing local analytics/event-log mechanism was located anywhere in `packages/web/src`;
  the server package (`packages/cezar/src/server/`) was not searched for one in this pass — the
  next step should check there before assuming this is fully greenfield.
- No spec or KB entry states explicitly whether the owner wants the dialog removed entirely or
  kept for non-archived rows — this is inferred from the acceptance criteria's narrow wording,
  not a stated decision.

## Facts that most constrain the design

1. The task's cited spec (`2026-08-17-notion-export-cezar-import.md`) is not the governing
   decision — `2026-08-17-filed-tasks-table-statuses.md` (KB `notion-7bb302edff13`) is, and it's
   the dialog UX this feature partially replaces.
2. `FiledDetailDialog`/`FiledTasks`/`FiledRow`/`FiledCard` live only in
   `packages/web/src/routes/global-tasks.tsx`, used only by the unscoped `/tasks` route — other
   project task views (`tasks-overview.tsx`, `workspace-tasks.tsx`) are structurally unaffected.
3. There is no single-item `GET /:projectId/todos/:id` endpoint and no analytics mechanism
   anywhere in the web package — both are new surface, not extensions of something existing.
4. The run-backed precedent (`/p/:projectId/tasks/:id`, `task-thread.tsx`) is a real, refresh-safe
   full-page pattern to copy, but its URL segment (`tasks/:id`) is already taken by run ids and
   cannot be reused verbatim for todo ids without a collision.
