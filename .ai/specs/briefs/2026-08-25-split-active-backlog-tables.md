# Brief: Split tasks into sortable Active and Backlog tables

**Task id:** `265c2695-f524-4a40-b0e8-d613cf1a31fd` · **Step:** 1/9 — Gather the record (brief only; no spec or code written here) · **Date:** 2026-08-25

## The problem, in this repository's own terms

The `/tasks` page's Filed section is a single unified table (`FiledTasks()`,
`packages/web/src/routes/global-tasks.tsx:727-950`) with an `Active | Archived` tab split
that keys on `archivedAt`/`status === 'done'`, **not** on TODO-vs-not-TODO status
(`matchesFiledView()`, `packages/web/src/lib/filed-tasks.ts:86-89`). All filtering, sorting
and paging for that table happen entirely **client-side** in
`packages/web/src/lib/filed-tasks.ts` (`filterFiledTasks`, `sortFiledTasks`), fed by
`GET /api/v1/workspace/todos`, which takes **zero query parameters**
(`packages/contract/src/workspace-todos.ts:37-41`) and returns every todo unsorted,
unpaged, uncapped (`WorkspaceTodoIndex.list()`, `packages/cezar/src/workspace/todo-index.ts:83-100`,
comment: "No cap, no truncation").

The task asks for a new, orthogonal split — **Active = every non-TODO-status filed task**,
**Backlog = TODO-status filed tasks** — each its own sortable table, with **server-side**
deterministic ordering, a stable tie-breaker, and independent pagination (Active starts at
20 rows, Backlog at 30, each "Show more" adds exactly 10, and expansion must not disturb the
other table's partition). None of that server-side sort/paging machinery exists today; it is
new ground for this route.

## What the record already decided (with citations)

- **Base table this extends:** `specs-fc81f822fe2d` / `.ai/specs/2026-08-17-filed-tasks-table-statuses.md`
  — shipped in `c65ca0bf`, gave todos `status`/`priority`/`archivedAt`, the `Active|Archived`
  tab split, a 100-row cap with "Show 100 more" (`FILED_ROW_PAGE_SIZE = 100`,
  `packages/web/src/lib/filed-tasks.ts:210`), and the pure-logic-in-`lib/filed-tasks.ts`
  pattern the new split should follow.
- **Pagination footgun already hit once, must not repeat it:** the bulk-start trilogy
  (`.ai/specs/2026-08-24-bulk-start-filed-tasks.md`, `-ship-...md`, `2026-08-25-verify-bulk-start-release.md`)
  shipped a bug where a batch action was computed from the full `sorted` array instead of the
  rendered `rows` slice, so hidding-by-pagination didn't hide from action — fixed at
  `global-tasks.tsx:782-799`, regression test `global-tasks.test.tsx:1515-1574`. The new
  independent per-table `shown` state must be derived-from-rendered-rows by construction, and
  reset-on-filter/sort-change the same way the existing `shown` state is
  (`global-tasks.tsx:782-786`).
- **"Backlog" already names something else in this codebase — real naming collision.**
  `.ai/specs/2026-08-22-backlog-add-without-starting.md` and
  `.ai/specs/2026-08-24-land-the-backlog-composer.md` (landed `c406f2fa`) define **Backlog as
  the third submit-mode on the `/new` composer** (`Start | Plan first | Backlog`,
  `NewTaskDraft.runMode: 'backlog'`, `data-slot="mode-backlog"`). A backlog-composer todo does
  end up `status: 'todo'`, so it's a subset of what this task calls "Backlog," but the word
  currently means a **composer action**, not a **table partition**. The spec must pick
  non-colliding `data-slot`/test-id names (e.g. `backlog-tasks-table` vs the existing
  `mode-backlog`) and flag this collision explicitly rather than silently reusing the word in
  a way that breaks existing selectors or confuses a reviewer.
- **No analytics sink exists anywhere in `packages/web/src`** — confirmed by grep
  (`analytics|telemetry|posthog|logEvent|emitEvent` → no hits). The one precedent is aspirational
  `TODO(analytics): emit ...` markers left in specs (e.g.
  `.ai/specs/2026-08-20-reopen-sweep-execution.md:576`). "Analytics ship" in this task's
  acceptance criteria is therefore a real gap the spec must resolve (build minimal
  event-emission infra) — it cannot defer to an existing mechanism because none exists.
- **No Playwright config; E2E is a custom harness.** `packages/web/e2e/*.e2e.ts` via
  `AgentBrowser` (`packages/web/e2e/agent-browser.ts`), dispatched by `.ai/scripts/e2e.sh`,
  artifacts under `.ai/qa/artifacts_e2e`. No existing spec targets `/tasks` or Filed
  specifically; closest precedent is `task-changes.e2e.ts` (boots a real dry-run
  project/session, drives the real UI). The bulk-start verify pass
  (`2026-08-25-verify-bulk-start-release.md`) is the closest precedent for *production*
  Playwright E2E with a verdict-JSON + screenshot/video artifact convention, and for
  cancelling any spawned run immediately after proving existence.
- **No conflicting in-flight work.** Confirmed clean: `cezar todo list` has nothing matching;
  no branch/worktree name matches; no commit newer than `7932cf4d`/`dc64b741` touches
  `global-tasks.tsx`/`filed-tasks.ts`/`workspace-todos-routes.ts` in this area; no KB spec or
  existing brief targets this exact feature.
- **`dc64b741`** (2026-08-25, "workspace scope routes tasks into projects") touched
  `todos.ts`, `todo-cli.ts`, `new-task.tsx`, `workflows/run.ts`, `granted-roots.ts` — does
  **not** touch `global-tasks.tsx`/`filed-tasks.ts`, so no direct code conflict, but it added
  fields to `todos.ts` recently; the spec step should re-read the current schema before
  finalizing the sort/tie-breaker design rather than trusting this brief's schema snapshot
  verbatim.

## Which code is actually involved

- **Route:** `/tasks` → `GlobalTasksRoute` (`packages/web/src/routes.tsx:793`) →
  `packages/web/src/routes/global-tasks.tsx`. (`workspace-tasks.tsx` is a *different* route,
  `/workspace/tasks`, a cross-project runs board — not this page. `tasks-overview.tsx` is the
  per-project index route — also not this page. Do not touch either by mistake.)
- **Contract:** `packages/contract/src/workspace-todos.ts` (currently no input schema on
  `GET /workspace/todos` — will need query-param additions), `packages/contract/src/skills.ts:73-157`
  (`todoItemSchema`: `status` enum `['todo','in-progress','blocked','done']` optional line 92,
  `priority` optional line 93, `archivedAt` optional line 95, `ts` optional line 75, `id`
  required line 74 — **no field is used as an explicit sort tie-breaker today**; `id` is the
  only unique, always-present candidate).
- **Server:** `packages/cezar/src/server/workspace-todos-routes.ts:55-59` (handler, currently
  just calls `index.list()`, no params consumed) and
  `packages/cezar/src/workspace/todo-index.ts:83-100` (`WorkspaceTodoIndex.list()` — where
  server-side sort/filter/partition/limit logic would need to live).
- **Web pure logic:** `packages/web/src/lib/filed-tasks.ts` — `FiledView` type (`:32`),
  `matchesFiledView()` (`:86-89`), `filedStatus()` (`:66-68`, absent status reads `'todo'`),
  `FILED_ROW_PAGE_SIZE = 100` (`:210`) — the new Active/Backlog partition and independent
  20/30-initial, +10-increment pagination is a new dimension alongside (not a replacement for)
  today's `Active | Archived` tab concept, since Archived keys on `archivedAt`/`done` while the
  new split keys on `status === 'todo'` — **how these two dimensions compose is unresolved,
  see open questions**.
- **Web rendering:** `FiledTasks()` (`global-tasks.tsx:727-950`), table headers (`:897-916`),
  `shown` state + "Show more" button (`:756, 782-786, 883, 942`), `FiledControlsRow` sort
  dropdown (`:815-823, 971+`, `FILED_SORT_OPTIONS` `:699-704` — today only `created-desc` /
  `created-asc`, no per-column click-sort).
- **Sort UI precedent (not directly reusable):** `packages/web/src/routes/task-thread/sortable-table.tsx`
  — click-to-sort for markdown-rendered GFM tables (asc→desc→unsorted cycle), built for
  Streamdown's table components, not a plain `<table>`. The Filed table's own header cells
  (`Th`, `global-tasks.tsx:1882-1894`) are static `<th>` with no `onClick`/`aria-sort` — a new
  per-column sortable header affordance is needed, informed by but not copied from this file.

## Any prior decision this would contradict

None found outright, but two things the spec must reconcile rather than silently override:

1. The existing `Active | Archived` view split (keyed on archived/done) vs. the new
   Active/Backlog split (keyed on todo-status) — these are different axes over the same data
   and the spec has to define how they nest (e.g. does "Active" in the new sense exclude
   archived/done entries too, or is Archived now a third concept alongside both?).
2. Reusing the word "Backlog" for a table when the codebase already uses it for the composer's
   third submit-mode (`c406f2fa`) — not a hard contradiction, but shipping it without
   disambiguating selectors/test names risks confusion and possible selector collisions in
   E2E scripts that already grep for `mode-backlog`.

## Open questions a spec will have to settle

1. **Server-side sort contract shape.** `GET /workspace/todos` has zero query params today.
   Does the new endpoint take one param set with a `partition` discriminator, or two
   independent parameter groups (e.g. `activeSort`/`activeLimit` and
   `backlogSort`/`backlogLimit`) so "expansion must preserve status partitions" and
   independent Show-more per table are both satisfiable server-side? What's the stable
   tie-breaker — `id` is the only always-present unique field found; confirm nothing else
   (e.g. a monotonic sequence) exists after re-checking `todos.ts` post-`dc64b741`.
2. **Which columns become sortable** — the acceptance criteria says "every sortable column"
   without enumerating them; today's columns are Status, Task, Project, Author, Node,
   Priority, Age (`global-tasks.tsx:897-916`). Decide the sortable subset and how status
   (an enum, not a natural order) and priority (high/medium/low) sort deterministically.
3. **Row-count semantics** — Active initial 20, Backlog initial 30, +10 per Show-more, is a
   sharp departure from today's shared `FILED_ROW_PAGE_SIZE = 100`; needs new named constants,
   likely one pair per table, and the bulk-start pagination bug (acting on `sorted` instead of
   rendered `rows`) must not recur for either table independently.
4. **Analytics events** — must be designed from scratch (naming convention, what fires on:
   partition view, per-column sort, each Show-more click) since no sink exists at all.
5. **Composition with the existing Active/Archived tabs** — resolve before writing schema/UI
   code, not during implementation.

## What could not be confirmed

- Whether `dc64b741`'s new `todos.ts` fields (added same day as this brief) interact with the
  planned sort/tie-breaker — flagged for the spec step to re-verify against the live file
  rather than trusting this snapshot.
- Whether any analytics *infrastructure* decision (a lightweight event log, a KV sink, etc.)
  has been discussed anywhere outside specs (e.g. verbally with the owner) — none found in KB
  or specs; treat as fully open.
