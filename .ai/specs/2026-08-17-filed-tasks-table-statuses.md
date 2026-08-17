# Filed tasks: table, statuses, detail view, archive

- **Status:** Implemented + Done — shipped in `c65ca0bf`, deployed to cockpit.example.com same
  evening; Phase 3 executed: all 631 tasks migrated as v2 todos (chat 589 / cezar 33 / aside 8 /
  career-kit 1; 539 done+archived, 49 todo, 27 in-progress, 16 blocked; payload validated 631/631
  through the real `readTodos()`, identical ids on both cockpits), and the Verification item 5
  runtime E2E passed in a real browser on prod: newest-first table with status pills and no
  summary prefixes, detail dialog with markdown body + acceptance checklist, status filter counts
  49/27/16/0 with `?fstatus=blocked` → 16 rows, Archived tab 539, archive round-trip
  92→91/540 with the archived to-do keeping its status pill, restore back to 92/539
- **Date:** 2026-08-17
- **Owner instructions (verbatim, three messages same evening):** "I can't open task to see
  details or to archive it instead of starting. migrate DONE tasks as well and 'blocked' as
  well" · "all tasks should be migrated" · "tasks view should be improved: we should see this
  a tabled, sroted with createdAt, way to filter, sort, or even query"

## TLDR

The Tasks page's "Filed" section is a flat `<ul>` of `project + summary + Start`. Todos gain
first-class `status` and `priority` fields plus an `archivedAt` stamp; the Filed section
becomes a real table (status pill, title, project, priority, age) with its own status/priority
filters, a created-date sort toggle, the page query applied, a detail dialog (context /
what-to-do / acceptance criteria as markdown), and Archive/Restore per row. Active shows open
filed work; the Archived tab shows archived + done entries. Data migration (not part of the
code change): all 631 workspace-record tasks land as todos with real statuses and original
creation timestamps.

## Problem

1. A filed todo cannot be opened — `context`/`whatToDo`/`acceptanceCriteria` exist in the
   schema (2026-08-15-knowledge-grounded-task-fanout.md D2) but no surface renders them.
2. The only affordance is Start. There is no way to dismiss/archive a filed entry (the
   per-project Inbox's check-off is a hard DELETE, and the Inbox is gated off by default).
3. Todos have no status: blocked/in-progress/done distinctions ride as summary-text prefixes
   (the 2026-08-17 migration's stopgap), and done work cannot exist on the board at all.
4. No ordering/filter/query: entries render in file order, ungrouped, unfiltered.

## Solution

### Schema (contract `skills.ts` `todoItemSchema` + server `todos.ts` `todoSchema` — twins, change both)

Three additive optional fields (legacy entries — agent appends, existing files — validate
unchanged; absent `status` reads as `'todo'`):

```ts
status: z.enum(['todo', 'in-progress', 'blocked', 'done']).optional(),
priority: z.enum(['high', 'medium', 'low']).optional(),
/** Set by the archive action; an archived entry leaves the Active board. Server-stamped. */
archivedAt: z.string().optional(),
```

`createTodoInputSchema` keeps its `.omit()` derivation — `archivedAt` joins the omit list
(server-stamped, never client-supplied on create); `status`/`priority` are creatable.
`ts` keeps its meaning "when the work item was created" — the migration backfills original
creation times into it; no second date field.

### Server

- `todos.ts`: `updateTodo(dataDir, id, patch: { status?; priority?; archived?: boolean })`
  under the same `todos.lock` lease every writer takes. `archived: true` stamps
  `archivedAt` = now; `false` deletes the key (rest-destructure, the `seenAt` precedent —
  readers key on ABSENT). Returns the updated item or undefined for an unknown id.
- New route `PATCH /api/v1/p/:projectId/todos/:id` (project-scoped, beside the existing
  GET/POST/DELETE/start): zod body `updateTodoInputSchema = { status?, priority?,
  archived?: boolean }` (all optional, at least one required — `.refine`), 404 unknown id,
  200 with the stored todo. Wire twin in contract `skills.ts`. Start flow untouched
  (`startedTaskId` still hides an entry from every board view, unchanged).
- `GET /workspace/todos` unchanged — it already returns every entry; visibility is a view
  concern (the `startedTaskId` precedent: filtered in `inbox.tsx`, not the route).

### Web (`global-tasks.tsx` — Filed section rewrite; new `lib/filed-tasks.ts` for the pure logic)

- **Table**, same visual grammar as the runs table below it (`Th`/`TD_BASE` idioms): columns
  Status (Pill; todo=neutral, in-progress=violet, blocked=amber/danger tone, done=success),
  Task (title button → detail dialog), Project (link, as today), Priority (dim chip or —),
  Age (from `ts`, `shortAge`, tooltip = full date), Actions (Start · Archive/Restore).
  Started entries stay hidden (adopt `inbox.tsx`'s `!startedTaskId` filter — today the board
  shows them forever, a latent bug this fixes in passing).
- **Views:** Active tab → `!archivedAt && status !== 'done'`; Archived tab → `archivedAt ||
  status === 'done'` (the Filed section now renders on BOTH tabs; empty section renders
  nothing, as today). Archive/Restore per row: PATCH `{archived: true|false}`, optimistic
  against `workspaceQueryKeys.workspaceTodos`, rollback + toast on error (the
  `useIndexedRunMutation` shape, but for the todos cache).
- **Controls row** above the table, URL-state per the page doctrine (`replace`, decoded in
  the updater): `fstatus` (multi, chips with counts), `fpriority` (multi), `fsort`
  (`created-desc` default | `created-asc`). The page's existing `?q=` query also narrows
  filed rows (summary + context + whatToDo, case-insensitive) — one search box, both lists.
- **Detail dialog** (`components/ui/dialog.tsx`, scrollable content): header = summary +
  status/priority pills + project link + created date; body = `context`, `whatToDo`,
  `acceptanceCriteria` (checklist), each through the `Markdown` component
  (`@/routes/task-thread/markdown`, the `skill-detail.tsx` precedent); `knowledgeRefs` as
  links to `/workspace/knowledge?project=&doc=` when present; footer = Start +
  Archive/Restore. Absent fields render nothing (legacy entries are summary-only).
- **Row cap:** render 100 rows + "Show N more" increments of 100 (the Archived view holds
  ~540 entries; no virtualization dependency).
- Section count shows `visible of total` when filters narrow it.

### Data migration (operational step, no cezar code; runs after deploy)

Regenerate every migrated todo from the workspace task record: all 631 tasks (Notion export
+ local), `status`/`priority` as real fields, summaries WITHOUT the old `[In Progress]`/
`[Blocked]` prefixes, `ts` = original creation time, done entries `archivedAt` = migration
time + trimmed bodies (provenance + pointer to the knowledge doc carries the full record).
Existing migrated entries (identified by their provenance context prefix) are replaced;
entries from any other origin are preserved. Same ids on both cockpits; lease-respecting
writes; payload validated through the real `readTodos()` before writing.

## Architecture

Unchanged: todos stay per-project `.ai/cezar/todos.json`; the workspace board stays a
read-only aggregation (`WorkspaceTodoIndex`); writes stay project-scoped routes. The one
new write is PATCH beside the existing POST/DELETE. Upstream purity: nothing in the code
names the workspace's products or Notion — statuses/priorities are generic.

## Phases

1. **Schema + server:** contract fields, `updateTodo`, PATCH route, api-client
   `updateWorkspaceTodo(projectId, id, patch)`, tests.
2. **Web:** `lib/filed-tasks.ts` (filter/sort/query pure functions + URL codec),
   FiledTasks table + controls + detail dialog + archive mutation, tests.
3. **Migration + deploy + E2E** (operator-run, not implementer scope).

## Data models

`TodoItem` gains `status? / priority? / archivedAt?` as above. No storage migration:
additive optional fields over existing JSON.

## API contracts

- `PATCH /api/v1/p/:projectId/todos/:id` body `{status?, priority?, archived?}` (≥1 key) →
  200 `{todo}` | 404 `{error}` | 400 zod. Registered in route-parity.
- `GET /workspace/todos` shape unchanged (entries simply carry the new optional fields).

## Risks

- **Two schema twins drift** (contract vs server zod): change both in one commit; the
  existing twin tests (`todo-task-text` fixture pattern) plus a new parity test if none
  covers field sets.
- **Board payload growth** (~631 entries): mitigated by trimmed done bodies at migration
  time; the route itself stays uncapped (documented inbox contract).
- **Optimistic cache patch on a keyed list**: patch by `(project, id)` pair — two projects
  can hold the same uuid only theoretically, but the pair is what the row key already uses.

## Verification

1. Unit (`todos.test.ts`): `updateTodo` round-trip (status set, archive stamps ISO
   `archivedAt`, restore removes the KEY — assert `'archivedAt' in item === false`), 404
   unknown id, lease respected (lock file held → retries/blocks), legacy entry without new
   fields still validates and updates.
2. Route tests: PATCH validation (empty body 400, bad enum 400, unknown id 404, happy 200
   persists to disk), scoping (project A's PATCH cannot touch project B's file).
3. Web component tests (`global-tasks.test.tsx` + `lib/filed-tasks.test.ts`): active/archived
   split (done and archived entries only under Archived; `startedTaskId` hidden in both),
   sort default created-desc + toggle asc, status/priority filters narrow + counts, page
   query narrows filed rows, detail dialog renders markdown sections + absent fields render
   nothing, archive click optimistically moves the row and rolls back on error.
4. Gates: `npm run typecheck && npm test && npm run test:unit && npm run build &&
   npm run test:package` — all green.
5. Runtime E2E on cockpit.example.com after deploy + migration: Filed table sorted newest
   first with real statuses (no `[Blocked]` prefixes anywhere); open a done task's detail
   from the Archived tab and see its body; archive an open task → it moves to Archived;
   restore it back; filter by blocked → 16 rows; query narrows.

## Implementation notes (post-implementation)

**Phases 1 and 2 implemented** (schema + server, then web). **Phase 3 (data migration,
deploy, runtime E2E on cockpit.example.com) is explicitly out of scope for this pass** —
not run, per the orchestrator's split.

### What was built

**Schema (twins kept in lockstep):**
- `packages/contract/src/skills.ts` — `todoItemSchema` gained `status`, `priority`,
  `archivedAt` (all optional); `createTodoInputSchema` omits `archivedAt` (server-stamped).
  Added `updateTodoInputSchema` (`.refine()` requiring at least one of
  `status`/`priority`/`archived`) and `updateTodoResponseSchema`.
- `packages/cezar/src/todos.ts` — `todoSchema` carries the identical three fields (parity
  asserted at runtime by a new test, see below). Added `updateTodo(dataDir, id, patch)`,
  routed through the existing `withTodosLease` helper like every other writer.

**Server:**
- `packages/cezar/src/server/server.ts` — `PATCH /todos/:id` added to the `todosRoutes`
  chain (between POST and DELETE), validated with `jsonZodValidator(updateTodoInputSchema)`.
  404 on unknown id, 200 with `{ todo }` on success.
- `packages/cezar/src/server/route-parity.test.ts` — new route added to the manifest and
  to the mutating-route-rejection check.
- `packages/cezar/src/server/todos-patch.test.ts` (new) — HTTP-level happy path,
  validation (empty body, bad enum), 404s, and cross-project scoping (a PATCH against
  project B never touches project A's file, even on a colliding id).
- `packages/cezar/src/todos.test.ts` — added `updateTodo` unit tests (status/priority set,
  archive stamps an ISO `archivedAt`, restore deletes the key —
  `'archivedAt' in item === false` — 404 on unknown id, lease respected via a held lock
  file) plus the schema-field-set parity test against `todoItemSchema`.
- `packages/cezar/src/handoff.test.ts` — `archivedAt` added to `SERVER_MANAGED`;
  `status`/`priority` added to `CLIENT_WRITTEN` (written via POST/PATCH, never an agent's
  plain append).

**Web:**
- `packages/web/src/lib/filed-tasks.ts` (new) — the pure half: `FiledStatus`/
  `FiledPriority`/`FiledSort`/`FiledView` types, `filedStatus` (absent → `'todo'`),
  `isVisibleFiledEntry` (hides `startedTaskId` on both views, adopted from `inbox.tsx`),
  `matchesFiledView` (archived OR done → Archived), `filterFiledTasks`/
  `filedTasksExcludingFacet`/`filedFacetCounts`, `sortFiledTasks` (created-desc default,
  missing/unparseable `ts` sorts last in both directions), `applyFiledPatch` (rest-destructure
  removes `archivedAt` on restore), `FILED_ROW_PAGE_SIZE = 100`, and the `fstatus`/
  `fpriority`/`fsort` param-name constants.
- `packages/web/src/lib/global-tasks.ts` — `SEARCH_PARAMS` extended with explicitly-named
  `filedStatus`/`filedPriority`/`filedSort` keys (NOT spread from `FILED_SEARCH_PARAMS`,
  to avoid colliding with the runs facet's own `status` key); `GlobalTasksUrlState`/
  `DEFAULT_URL_STATE`/`urlStateToSearchParams`/`urlStateFromSearchParams` extended;
  `toggleFacetValue` made generic so both facet spaces share one implementation.
- `packages/web/src/api/client.ts` — `updateWorkspaceTodo(projectId, id, patch)`, following
  `startWorkspaceTodo`'s hono-client idiom against `/p/:projectId/todos/:id`.
- `packages/web/src/routes/global-tasks.tsx` — `FiledTasks` rewritten from a flat list into
  a table, rendered on **both** Active and Archived tabs (previously Active-only), with a
  controls row (status/priority `FacetFilter`s + sort `SegmentedControl`), a 100-row cap
  with "Show 100 more", row actions (Start / Archive-Restore), and a detail dialog
  (`FiledDetailDialog`/`FiledDetailBody`) rendering `context`/`whatToDo` via the shared
  `Markdown` component, an acceptance-criteria checklist, and `knowledgeRefs` links into
  `/workspace/knowledge`. `useUpdateFiledTodo` mirrors `useIndexedRunMutation`'s optimistic
  pattern, keyed by the `(project, id)` pair per the spec's Risks note.

### Tests added

- `packages/cezar/src/todos.test.ts` — 3 new `describe` blocks (schema fields, schema
  parity with the contract twin, `updateTodo`).
- `packages/cezar/src/server/todos-patch.test.ts` — new file, HTTP + scoping tests.
- `packages/cezar/src/server/route-parity.test.ts` — 1 new manifest entry + 1 assertion.
- `packages/cezar/src/handoff.test.ts` — exemption-set updates (no new test, existing one
  now passes with the new fields documented).
- `packages/web/src/lib/filed-tasks.test.ts` — new file: `filedStatus`,
  `isVisibleFiledEntry`, `matchesFiledView`, `filterFiledTasks` (active/archived split,
  started-hidden-on-both, status/priority narrowing, query), `filedTasksExcludingFacet`/
  `filedFacetCounts`, `sortFiledTasks` (default + reverse, missing/unparseable `ts` last in
  both directions), the `isFiledStatus`/`isFiledPriority`/`isFiledSort` guards, and
  `applyFiledPatch` (set fields, archive stamps, restore deletes the key).
- `packages/web/src/lib/global-tasks.test.ts` — 4 new tests in the "URL state" describe
  block: Filed facet/sort round-trip, no collision with the runs facets sharing the same
  param *names* internally, default `fsort` omitted from the URL, unknown values dropped
  rather than passed through.
- `packages/web/src/routes/global-tasks.test.tsx` — the pre-existing "the Filed section"
  describe block's two tests that queried the old flat-list markup (`data-slot="filed-task"`
  / `"filed-task-start"`) were rewritten against the new table markup
  (`data-slot="filed-task-row"`, `data-action="start-filed-task"`); the row-order
  assertions were corrected to match the real default sort (`created-desc`, so `todo-2`
  sorts before `todo-1` given their timestamps a second apart — the original assertions
  predated any sorting and were insertion-order artifacts). Added: a both-tabs-render test
  (a row's own archived/done state — not which tab it's clicked from — decides where it
  sits), an archive-success test, an archive-rollback test (mirroring the runs table's own
  "puts a refused archive back" test — see divergence below), and a detail-dialog test
  (renders `context`/`whatToDo`, omits `acceptanceCriteria`/`knowledgeRefs` sections when
  absent). `stubFetch`'s `todos` fixture type was widened to `WorkspaceTodoEntry[]` and made
  stateful with a `PATCH /todos/:id` handler (mirroring the existing `index`/archive-run
  pattern), plus a `todoPatchStatus` option for the rollback test.

Test counts: 465 test files / 8682 tests passing before this change's edits settled to
465 files / 8682 tests passing (1 pre-existing skip) after — the file count is unchanged
because no file was added to the *server* or *web* project counts beyond the ones listed
above, all of which are included in that final total (`todos-patch.test.ts` and
`filed-tasks.test.ts` are both new files, each counted once).

### Gate results (verbatim final lines, each run with its own real exit code checked)

```
$ npm run typecheck   → exit 0 (contract, client, server, web all clean)
$ npm test            → exit 0
 Test Files  465 passed (465)
      Tests  8682 passed | 1 skipped (8683)
$ npm run test:unit    → exit 0
# fail 0
# cancelled 0
# skipped 1
# todo 0
$ npm run build        → exit 0
check:pack ok — 990 files, 222 under web/dist (shell + assets present)
$ npm run test:package → exit 0
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

All five gates green.

### Divergences from the spec (both considered, neither a behavioral gap)

1. **`delete` vs. rest-destructure for the restore semantics.** The spec's prose said
   "rest-destructure" and cited the `seenAt` precedent, but the actual precedent code
   (`runs/store.ts`'s `setUnread`) uses the `delete` operator, not a rest-destructure.
   Server-side `updateTodo` uses `delete item.archivedAt` (matching the literal precedent
   and producing the identical `'archivedAt' in item === false` outcome the Verification
   section demands). Client-side `applyFiledPatch` uses an actual rest-destructure,
   matching the ALREADY-EXISTING client precedent (`useReadIndexedRun`'s `seenAt` patch in
   `global-tasks.tsx`). Both read on the resulting object identically; this is a reading of
   an underspecified instruction, not a behavior change.
2. **"Blocked" tone mapped to `pending`, not `danger`.** The codebase's own vocabulary
   (`lib/attention.ts`: "waiting → amber/pending") equates "amber" with the `pending`
   `StatusDotTone`, so `FiledStatusPill` maps `blocked` → `pending` rather than `danger`.
   Documented inline in `global-tasks.tsx`.
3. **Archive test split into two (success + rollback) rather than one test asserting both
   the optimistic frame and the rollback.** The mock server's `PATCH` rejects with no
   artificial delay, so the optimistic patch and its own error-triggered rollback can land
   within the same `waitFor` poll, making an assertion on the transient "row already gone"
   state racy. Split to mirror the existing runs-table precedent
   (`'puts a refused archive back and shows the server's reason'`), which asserts only the
   toast and the final settled row set for the rollback case, and a separate test asserts
   the row leaving Active for the success case.

### What was not done (Phase 3, explicitly out of scope here)

- Data migration of the ~631 existing todo entries (trimming done bodies, etc.).
- Deploy to production.
- The runtime E2E on cockpit.example.com (Verification item 5): sort order with real data,
  opening a done task's detail from Archived, archive/restore round-trip, blocked-filter
  row count, query narrowing. Status stays **QA Needed** until that pass runs.
