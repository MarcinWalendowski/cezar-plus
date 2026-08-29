# Brief: Open archived tasks as full pages (second attempt)

**Task:** "Open archived tasks as full pages" (`1909f34e-3560-4622-9178-72b7b9724944`, workflow
`spec-to-deploy`, step 1/9 "Gather the record"), 2026-08-29. No spec written, no code changed.

**This is a redo, not a fresh feature.** The identical owner instruction was attempted three
days ago under task `cc25d636-8412-4cff-afa5-568021a40cf9` (2026-08-26). That attempt produced a
complete, reasoned design (`.ai/specs/2026-08-26-filed-task-detail-page.md`, 834 lines) but
shipped only its analytics-backend phase. Everything below is written against that fact: what
already exists, what still doesn't, and one real scope contradiction the record now contains
that the spec step must resolve explicitly rather than pick a side on silently.

## Problem, in this repository's own terms

The Cezar web cockpit's global Tasks board (`/tasks`, unscoped route) lists **filed tasks**
(todos, not agent runs) via `FiledTasks` in `packages/web/src/routes/global-tasks.tsx`, including
Done/archived entries. Clicking a row's title opens `FiledDetailDialog`, a modal, for every row
regardless of status. Run-backed tasks already get a real, project-scoped, bookmarkable page at
`/p/:projectId/tasks/:id`. The owner wants the same treatment for filed tasks, at minimum for a
Done row in the Archived view: click the title, land on a dedicated URL, get everything the
modal shows (metadata, context, requested work, acceptance criteria, actions), survive a
refresh, and emit an analytics event when opened.

## What the record already decided — with citations

- **A full design for this exact feature already exists and is still current in its
  reasoning.** `.ai/specs/2026-08-26-filed-task-detail-page.md` specifies: a route
  `/p/:projectId/todos/:todoId` registered inside `ProjectScopeRoute` beside `tasks/:id`
  (rejected `tasks/filed/:id` — different id space, would compete with the `tasks/*` route
  family); a shared content module `packages/web/src/components/filed-task-detail.tsx`
  exporting `FiledTaskDetailContent`, `FiledDetailDialog`, `FiledStatusPill`,
  `FiledPriorityChip`, and the three label maps (`FILED_STATUS_LABEL`, `FILED_STATUS_TONE`,
  `FILED_PRIORITY_LABEL`), following the existing `components/skill-detail.tsx` pattern of one
  neutral content component plus a dialog wrapper around it; a shared
  `packages/web/src/api/filed-task-mutations.ts` holding `useStartFiledTask` and
  `useUpdateFiledTodo` (moved out of `global-tasks.tsx`, which currently keeps them file-local);
  no new READ endpoint (the page reads `useWorkspaceTodos()`, the same query key the board
  already warms); and one new write route, `POST /api/v1/workspace/analytics/events`, for a
  `todo.detail_opened` event. It explicitly rejected a first draft that deleted
  `FiledDetailDialog` for every row status, on the grounds that the 2026-08-17 decision it
  partially supersedes (below) answered the "I can't open a task's details" complaint for **all**
  filed rows, and narrowing that to only Archived+Done rows "would un-answer it for the rows that
  request never mentioned." This reasoning has not been revisited since — see the contradiction
  below.
- **Only its Phase 4 (analytics backend) shipped, nothing else, and that is still true today.**
  Commit `abe83105` (2026-08-26, merged to `origin/main` via `bc9e0908`) added
  `packages/contract/src/analytics.ts`, `packages/cezar/src/server/workspace-analytics-routes.ts`,
  and `packages/cezar/src/workspace/analytics-log.ts`; `server.ts:56` imports
  `createWorkspaceAnalyticsRoutes` and `server.ts:7386` mounts it — confirmed live in the current
  tree. Commit `ef9d7990` (same day) corrected the spec's status line to "Partial" and recorded
  that Phases 1-3 (the page, the route, the component extraction, the board's link change) did
  not ship. **A fresh read of the current tree today (2026-08-29) confirms nothing has changed
  since**: no `packages/web/src/components/filed-task-detail.tsx`, no
  `packages/web/src/routes/filed-task-detail.tsx`, no `packages/web/src/api/filed-task-mutations.ts`,
  no `packages/web/src/lib/analytics.ts`, no `postAnalyticsEvents` in `client.ts`, zero
  `trackEvent(` call sites anywhere in the tree, and `git log --all` on all three
  never-created file paths returns nothing — these files have never existed on any branch. In
  `global-tasks.tsx`: dialog state at line 755, `FiledDetailDialog` rendered at line 952
  (defined at line 1347), the desktop row title still a plain `<button onClick={onOpenDetail}>`
  at lines 1147-1155, the mobile card title the same at lines 1276-1284 — no row anywhere renders
  a `<Link>` to a todo. `routes.tsx` has the `tasks/:id` family at lines 507-513 under
  `ProjectScopeRoute` (line 502) and no `todos` segment at all (`grep -n "todos"
  packages/web/src/routes.tsx` returns nothing). `nav-items.ts:96`'s match list is still `['/',
  '/tasks', '/compare']`, no `/todos`.
- **The Phase 4 backend that did ship is undocumented, a real gap against this repo's own
  rule.** `CEZ_ANALYTICS` (the opt-out env var the 2026-08-26 spec's Phase 4 specified) appears
  nowhere in `.env.example`, `README.md`, or `BACKWARD_COMPATIBILITY.md` — confirmed by grep
  against all three, zero matches. `AGENTS.md` (this repo's own root instructions) requires any
  user-facing `CEZ_*` env var to be documented in `.env.example` "in the same commit" it's
  introduced. This has been outstanding since `abe83105`.
- **The governing 2026-08-17 decision this feature partially supersedes:**
  `.ai/specs/2026-08-17-filed-tasks-table-statuses.md` (KB `notion-7bb302edff13`, shipped
  `c65ca0bf`) introduced `FiledDetailDialog` in direct answer to the owner's complaint "I can't
  open task to see details or to archive it." **This KB decision record has never been corrected
  or superseded, despite the 2026-08-26 spec's own Phase 6 instructing exactly that.**
  `cez kb show notion-7bb302edff13` today returns the original 2026-08-17 text unchanged: no
  supersession note, no correction. Whatever ships this time must actually do the KB write the
  last attempt specified but never performed.
- **Two mis-citations in the task's own stated record, both re-confirmed today:**
  `.ai/specs/2026-08-17-notion-export-cezar-import.md` (cited in this task's own context) is the
  Notion→corpus export/KB-mount spec; it says nothing about filed-task detail views or routing,
  and records its own v1 approach as "superseded same evening by
  `2026-08-17-filed-tasks-table-statuses.md`." `.ai/specs/2026-08-25-workspace-scope-routes-tasks.md`
  is a name collision — its "routes tasks into projects" is `cez todo add --project` CLI
  dispatch, not browser routing.
- **No other in-flight or duplicate implementation exists anywhere.** Checked `git log --all`
  on the three never-created file paths (empty), commits since 2026-08-26 (only `abe83105` /
  `ef9d7990` / one unrelated doc commit touch this area), no matching branch or open PR
  referencing the spec.

## The contradiction the spec step must resolve — new since 2026-08-26

Two todos exist for this same feature, filed three days apart by the same generic
`cli-todo-add` agent identity, and they disagree on scope:

- **`12dc1ac0-a989-43bd-b012-711f85bb7b01`** (filed 2026-08-26T09:34, priority medium, still
  `status: todo`) — text is **verbatim identical** to this task's own `CEZ_HANDOFF` context and
  acceptance criteria: scope is the **Archived view, Done rows only**; every other filed row
  keeps the dialog. This matches the 2026-08-26 spec's explicit, reasoned design.
- **`33bee966-0a0e-4e63-8c02-74df06c48cda`** (filed 2026-08-29T12:30, priority **high**,
  `status: todo`) — explicitly states "the earlier todo 12dc1ac0 ... must be treated as
  superseded by this clearer task, not implemented alongside it," and its acceptance criteria
  ask for something **broader**: *"Clicking any filed task title or card, including an archived
  Done task ... no FiledDetailDialog opens"* — i.e. remove the modal entirely, for every filed
  row, not just Archived+Done. This directly reopens the exact design question the 2026-08-26
  spec already answered and reversed once ("exceeded what was asked").

**This task's own literal acceptance criteria (given in its `CEZ_HANDOFF` and task description)
match the narrower, older todo — Archived-view, Done rows only.** I could not determine from
`todos.json` which todo (if either) actually dispatched this task run; both todos' `author`/
`parentTaskId` fields point to the same generic agent identity, not to this task's own id. The
spec step must decide, explicitly and in writing, whether to honor this task's own stated
acceptance criteria (narrow scope, consistent with the accepted prior design) or the newer,
higher-priority todo's broader ask (remove the dialog everywhere) — and if choosing narrow scope,
say so and leave `33bee966` open as a distinct, separately-scoped follow-up rather than silently
closing it.

A secondary, smaller mismatch: the two todos also describe the analytics event slightly
differently. The 2026-08-26 spec's event carries `{project, status, archived, source}`; the newer
todo's acceptance criteria ask for `{project id, todo id, status, archived state, entry
surface}` — "todo id" and "entry surface" (desktop-table vs. mobile-card, presumably) are not in
the original spec's schema. Needs reconciling if the newer todo's criteria govern.

## Code actually involved

All in `packages/web/src` and (for the already-shipped backend) `packages/cezar/src/server` +
`packages/cezar/src/workspace` + `packages/contract/src`:

- `packages/web/src/routes/global-tasks.tsx` — the entire current filed-task UI. Dialog state
  (755), `FiledDetailDialog` render (952) and definition (1347), desktop button (1147-1155),
  mobile button (1276-1284), `useStartFiledTask` (1506), `useStartFiledTasks` (1522, the bulk
  mutation that stays put per the prior spec), `useUpdateFiledTodo` (1560), call sites
  (746-748). All mutation hooks are file-local, unexported.
- `packages/web/src/routes.tsx` — `ProjectScopeRoute` at line 502, `tasks/:id` family at
  507-513/515/523/531/539; no `todos` segment.
- `packages/web/src/components/nav-items.ts:96` — Tasks nav `match` list, missing `/todos`.
- Backend already live and reusable as-is: `packages/cezar/src/server/server.ts:56,7386`,
  `packages/cezar/src/server/workspace-analytics-routes.ts`,
  `packages/cezar/src/workspace/analytics-log.ts`, `packages/contract/src/analytics.ts`. This
  work does not need to be redone, only wired to a caller and documented.
- Nothing in `packages/web/src/api/client.ts` posts to the analytics route yet (`postAnalyticsEvents`
  confirmed absent); nothing in the tree calls `trackEvent(`.

## Prior decisions this would extend or contradict

- Extends `.ai/specs/2026-08-17-filed-tasks-table-statuses.md` (`notion-7bb302edff13`): partial
  supersession for whichever rows the spec step scopes this to.
- Directly reopens the 2026-08-26 spec's own reversed first-draft decision (delete the dialog for
  every status) if the broader `33bee966` scope is chosen — see contradiction above.
- Does not touch `.ai/specs/2026-08-25-workspace-scope-routes-tasks.md` (unrelated, name
  collision only).

## Open questions the spec must settle

1. **Scope**: Archived-view + Done-only link (this task's own literal acceptance criteria, and
   the already-reasoned 2026-08-26 design), or all filed rows / dialog removed entirely (the
   newer, higher-priority `33bee966` todo that claims to supersede the older one)? State the
   choice and its reasoning explicitly; do not let one silently overwrite the other.
2. Reuse the 2026-08-26 spec's design wholesale (route shape, component-extraction plan,
   mutation-hook move, five-branch derived-state model, `Link`/back-state mechanics) since
   nothing has invalidated it — or does the scope decision in (1) force material changes to its
   "dialog stays for non-Done rows" section?
3. Reconcile the analytics event's field set between the original spec's
   `{project, status, archived, source}` and the newer todo's
   `{project, todo id, status, archived, entry surface}`.
4. Close the outstanding `AGENTS.md`-required documentation gap for `CEZ_ANALYTICS`
   (`.env.example`, README env table, `BACKWARD_COMPATIBILITY.md` §1/§2) as part of this work,
   since the env var already shipped undocumented in `abe83105`.
5. Perform the KB correction to `notion-7bb302edff13` that the 2026-08-26 spec's Phase 6
   specified but never executed, and resolve/retire `12dc1ac0` (and, depending on (1), `33bee966`)
   once shipped.

## What I could not find

- No `cezar todo show <id>` subcommand exists (confirmed: `cezar todo` only supports `add`,
  `start`, `list`); the two todos above were read directly from
  `packages/cezar/.ai/cezar/todos.json`, formatted for `cezar todo list`'s eyes only.
- No way to trace, from `todos.json` alone, which of the two open todos (if either) actually
  dispatched this task run — both name the same generic agent author identity, not this task's
  own id.
- No GitHub PR or branch anywhere containing any of the three never-created files.
- Did not independently re-verify the e2e harness mechanics (`agent-browser.md`,
  `e2e/agent-browser.ts`) beyond what the 2026-08-26 spec's Verification section already
  describes; took that description at face value since nothing in this pass contradicts it.
