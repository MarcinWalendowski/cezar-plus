# Filed task detail page

- **Status:** Partial. **Corrected 2026-08-26 (same day):** this read "Specified, not
  implemented" until the implement step ran; that is now stale in the other direction too.
  Only Phase 4 (the analytics backend companion) shipped, in `abe83105` (merged to `origin/main`
  via `bc9e0908`): the contract schema (`packages/contract/src/analytics.ts`), the
  `POST /api/v1/workspace/analytics/events` route (`packages/cezar/src/server/workspace-analytics-routes.ts`)
  and the `<CEZ_HOME>/analytics/events.ndjson` sink (`packages/cezar/src/workspace/analytics-log.ts`).
  **Phases 1-3 (the actual feature) did not ship**: no `components/filed-task-detail.tsx`
  extraction, no `todos/:todoId` route, no `FiledTaskDetailRoute`, and no Archived-view link
  change in `global-tasks.tsx` — every filed row, Done/archived included, still opens
  `FiledDetailDialog`. The task's own acceptance criterion ("clicking a Done filed-task title
  navigates to a dedicated full-detail URL") is **unmet**. The shipped sink also has no caller
  yet, so `todo.detail_opened` is never emitted in production. Phase 5 (e2e) and the
  `CEZ_ANALYTICS` doc surfaces (`.env.example`, README env table, `BACKWARD_COMPATIBILITY.md`
  §1/§2) required by Phase 4 also did not land — a real gap against `AGENTS.md:31` ("adding a
  `CEZ_*` env var MUST update `.env.example` in the same commit"). Do **not** treat
  `notion-7bb302edff13` below as superseded: the dialog-only behaviour it records is still
  exactly what ships today. Follow-up filed; see the KB note this correction points to.
- **Date:** 2026-08-26
- **Owner instruction:** "Open archived tasks as full pages". Clicking an archived Done filed
  task should navigate to a full-detail page instead of opening the existing modal.
- **Supersedes (partially, not yet — see Status correction above):** `.ai/specs/2026-08-17-filed-tasks-table-statuses.md`
  (KB `notion-7bb302edff13`, shipped `c65ca0bf`), which introduced `FiledDetailDialog`. That
  spec's detail-view acceptance criteria stay satisfied, through a page rather than a dialog,
  **once Phases 1-3 below actually ship.**
- **The task's own cited spec is a mis-citation.** `.ai/specs/2026-08-17-notion-export-cezar-import.md`
  is the Notion→corpus export/KB-mount spec; it says nothing about filed-task detail views,
  routing or dialogs, and it records that its own v1 approach was "superseded same evening by
  `2026-08-17-filed-tasks-table-statuses.md`". Verified by direct read. It does not govern here.
- **`.ai/specs/2026-08-25-workspace-scope-routes-tasks.md` is a name collision, not prior art.**
  Its "routes tasks into projects" is `cez todo add --project` dispatch, not browser routing.

## TLDR

A filed task gets a real URL: `/p/:projectId/todos/:todoId`, registered inside the existing
`ProjectScopeRoute` layout, rendering everything `FiledDetailDialog` renders today plus its
actions, hydrated from the workspace todos query so it survives a direct load and a refresh.
In the **Archived view**, a **Done** row's title becomes a link to that page; every other filed
row keeps the dialog, and the two render one shared content component. Opening the page emits
one `todo.detail_opened` event, delivered to a local NDJSON sink under `CEZ_HOME` through one new
additive route. No change to the todo record's schema.

## Problem

1. A filed task has no address. `FiledTasks` holds the open entry in React state
   (`global-tasks.tsx:755`, `const [detail, setDetail] = React.useState<WorkspaceTodoEntry | null>`)
   and renders `FiledDetailDialog` (`global-tasks.tsx:952-963`). The row title is a `<button>`,
   deliberately. Its own comment at `global-tasks.tsx:1100-1102` calls it "a title BUTTON (not a
   link)", precisely because "there is no run yet to navigate to; it opens the detail
   dialog". So a filed task
   cannot be linked, bookmarked, pasted to someone, reopened after a refresh, or reached by the
   back button.
2. **Archived work is read work, and a modal is the wrong container for it.** The Archived view
   holds the bulk of the record: 539 entries at the 2026-08-17 migration, per that spec's own
   status line. A Done entry is opened to *read* (context, what-to-do, acceptance criteria, what
   grounded it), inside a `max-h-[80dvh]` scroll box (`global-tasks.tsx:1366`) layered over the
   table it came from.
3. The asymmetry is already visible in the product: a **run-backed** task is a full page at
   `/p/:projectId/tasks/:id` (`routes.tsx:506-513` → `routes/task-thread/task-thread.tsx`), with
   its own `changes` / `files` / `commits` sub-pages. A **filed** task, the thing that becomes
   that run, is a modal. Same board, two grammars.

## Solution

### The route

`/p/:projectId/todos/:todoId`, registered inside the `/p/:projectId` `ProjectScopeRoute` layout
(`routes.tsx:502`), beside `tasks/:id`.

**`todos/`, not `tasks/filed/`.** Todo ids and run ids are different id spaces, and the server
already spells this one `/api/v1/p/:projectId/todos/:id` (`server.ts:6134`, `:6144`). Mirroring
the API's own segment keeps one vocabulary for one id. It also cannot rank-compete with the
`tasks/*` family at all (different first segment), whereas `tasks/filed/:id` would sit in the
same family as `tasks/:id/changes` and rely on React Router's static-over-dynamic ranking to
stay unambiguous. No `todos` path exists in the web router today (checked every `path="` in
`routes.tsx`; the follow-up inbox is `inbox`), so the segment is free.

**Project scope is structural, from the URL.** `:projectId` is the authority for which project's
todo is being shown, and the page passes it explicitly to every mutation, the same discipline
`startWorkspaceTodo` / `updateWorkspaceTodo` already follow (`client.ts:1656-1700`: "the
workspace Tasks board lists todos from every project at once, so starting the row … in whatever
project you happened to be looking at" is the bug those wrappers exist to prevent).

### Where the page's data comes from: no new READ endpoint

*(Scope of "no new endpoint", narrowed since this section was first written: it is about the
page's data. Delivering the analytics event does add one write route, see API contracts.)*

The page reads `useWorkspaceTodos()` (`queries.ts:2480`, `GET /workspace/todos`, query key
`workspaceQueryKeys.workspaceTodos` = `['workspace','todos']`) and selects the entry whose
`project === projectId && todo.id === todoId`. `workspaceTodoEntrySchema` already carries
`project` alongside the todo (`packages/contract/src/workspace-todos.ts:31-34`), so the pair is
directly matchable.

Four properties come free from picking the query the board already uses:

- **Refresh and direct load work by construction.** The page depends on the URL and a query, not
  on navigation state. The server returns the SPA shell for any non-`/api` GET, so a cold load of
  the URL mounts the page, which fetches the same list. This is the exact mechanism
  `task-thread.tsx` relies on.
- **Click-through is instant.** Arriving from `/tasks`, the cache is already warm (the board
  populated it), so there is no second fetch and no loading flash.
- **The page's Archive/Restore is optimistic for free.** `useUpdateFiledTodo`
  (`global-tasks.tsx:1560-1592`) patches `workspaceQueryKeys.workspaceTodos` in `onMutate`,
  keyed on the `(project, id)` pair. The page reads that same key, so a status pill updates
  without any new cache plumbing.
- **The route is never flag-gated off.** `GET /workspace/todos` answers with the real todos
  regardless of `CEZ_FOLLOWUPS` / `CEZ_WORKSPACE_VIEWS`, and never 404s. The corrected header
  comment in `packages/contract/src/workspace-todos.ts` records exactly this, and
  `useWorkspaceTodos` takes no `enabled` gate for the same reason (`queries.ts:2470-2479`).

**Alternative considered and rejected: adding `GET /api/v1/p/:projectId/todos/:id`.** It is the
tidier-looking option (honest 404, one record on the wire) and it is additive, so
`BACKWARD_COMPATIBILITY.md`'s general rule permits it. It is rejected because cezar is a
published CLI whose HTTP API is a **protected surface** (`BACKWARD_COMPATIBILITY.md` §2): a route
added here is permanent, must be hand-listed in the §2 inventory, and is enforced against the
built app by `packages/cezar/src/server/bc-route-inventory.test.ts` plus the
`contract-parity.workspace-todos` suite. Minting a permanent public endpoint to render one page,
for data already on the wire on the page you navigated from, buys a payload saving the board
already pays on every `/tasks` load. Not-found is derived instead, and derived carefully: a
settled query with no matching `(project, id)` is only *one* of the five branches in Data models,
which separates a failed request and an unreadable project from a genuinely absent task rather
than rendering all three as "no such task".

### One content component, two containers

The detail body is **not** moved into the page; it is extracted to a neutral module both the page
and the surviving dialog import. New file `packages/web/src/components/filed-task-detail.tsx`,
following `components/skill-detail.tsx` exactly: that file already holds a neutral `SkillDetail`
content component *and* the `SkillPreviewDialog` (`skill-detail.tsx:104`) that wraps it. It
exports:

- `FiledTaskDetailContent`: today's `FiledDetailBody` (`global-tasks.tsx:1382-1502`), unchanged
  in what it renders: summary heading, status pill, priority chip, project link, filed date,
  cluster node cell when clustering is on, then `context`, `whatToDo`, `acceptanceCriteria`,
  `knowledgeRefs`, each absent field rendering nothing. The `data-slot` hooks
  (`filed-task-context`, `filed-task-what-to-do`, `filed-task-acceptance-criteria`,
  `filed-task-knowledge-refs`) are preserved verbatim, so the existing assertions keep working
  against both containers.
- `FiledDetailDialog`: the wrapper, moved here from `global-tasks.tsx:1347-1379`, unchanged in
  behaviour and still imported by `FiledTasks`.
- `FiledStatusPill` and `FiledPriorityChip` (`global-tasks.tsx:1083`, `:1089`), which have to
  move with the content: leaving them behind would make the shared module import a **route**
  module that imports it back, which is the cycle this extraction exists to avoid.
- `FILED_STATUS_LABEL`, `FILED_STATUS_TONE` and `FILED_PRIORITY_LABEL` (`global-tasks.tsx:680`,
  `:686`, `:693`), for the reason below.

**The three label maps move too, and two of them have a second consumer that stays behind.**
`FiledStatusPill` reads `FILED_STATUS_TONE` and `FILED_STATUS_LABEL`; `FiledPriorityChip` reads
`FILED_PRIORITY_LABEL`. All three are file-local `const`s with no `export`, so moving only the two
components does not compile. And the two *label* maps are read a second time by code that is not
moving: the Filed status and priority filter controls (`global-tasks.tsx:1002`, `:1015`). That
leaves exactly two bad outcomes if the maps are left where they are, which is why this is called
out rather than left to the implementer: the shared module imports the maps back out of the
**route** module (the cycle this extraction exists to avoid), or the maps get duplicated and the
pill and the filter chip begin drifting apart, one status renamed in one place.

The resolution: the maps move into `components/filed-task-detail.tsx` with the components, and the
two label maps are **exported** from it. `global-tasks.tsx` imports `FILED_STATUS_LABEL` and
`FILED_PRIORITY_LABEL` back for its filter controls, alongside the components it already imports
back. `FILED_STATUS_TONE` has a single consumer (`FiledStatusPill`) and stays unexported inside the
new module. Nothing is copied, and there is exactly one definition of each map in the tree, which
`grep -rc 'const FILED_STATUS_LABEL' packages/web/src` returning `1` states as a checkable fact.

**One dialog-specific detail this forces.** `FiledDetailBody` currently renders its title through
`DialogTitle`/`DialogDescription` (`global-tasks.tsx:1401-1404`), components that throw outside a
`Dialog`. The neutral content renders a plain `<h2>`, and `FiledDetailDialog` adds the `sr-only`
`DialogTitle`/`DialogDescription` pair itself. That is not an invention: it is what
`skill-detail.tsx:114-115` already does, and what the code comment at `global-tasks.tsx:1401`
already names as its own precedent.

### The page

New file `packages/web/src/routes/filed-task-detail.tsx`, lazily routed like its run-backed
neighbours. It renders `FiledTaskDetailContent`, the shared actions component, and two things that
are genuinely page-only: a header with a back link (Risk 1: it carries the board's own
`?archived=1`), and the page-level states of the derived model in Data models (loading, found,
not-found, error, project-unavailable).

**The actions are not page-only, and an earlier draft was wrong to call them that.** That claim
contradicted this section's own requirement that `FiledTaskDetailContent` is today's
`FiledDetailBody` unchanged, and Risk 5's statement that only the container chrome differs between
the two containers. Start and Archive/Restore are rendered by one shared `FiledTaskActions`
component, exported from the same `components/filed-task-detail.tsx`, and **both** containers
render it: the page below the content, the dialog in the footer where it already lives. One
definition, so the page and the dialog cannot offer a different action set, and cannot drift when
one of them changes. See "Actions on the page" below for what that component holds and which hooks
it calls.

### The dialog stays; only Archived-view Done titles navigate

**Corrected from this spec's first draft, which deleted `FiledDetailDialog` for every status.**
That exceeded what was asked and contradicted this document's own "Supersedes (partially)" line:
`2026-08-17-filed-tasks-table-statuses.md` answered the owner's complaint *"I can't open task to
see details or to archive it"* for **every** filed row, so removing the modal for active rows
would un-answer it for the rows that request never mentioned. The scope is the acceptance
criterion's: the Archived view, Done rows.

The mechanism, so "only these rows" is structural rather than a second copy of the rule. `FiledTasks`
computes one optional href per entry and passes it down:

```ts
// FiledTasks, once per entry. `view` and `filedStatus` are the board's own vocabulary
// (`lib/filed-tasks.ts:66`, `:86`), not a new predicate.
const detailHref =
  view === 'archived' && filedStatus(entry) === 'done'
    ? scopeTo(entry.project, `/todos/${entry.todo.id}`)
    : undefined
```

`FiledRow` and `FiledCard` render a `<Link>` when `detailHref` is set and today's `<button
onClick={onOpenDetail}>` when it is not. One expression decides it, in one place, and a row that
is Done-but-viewed-under-Active (impossible today: `matchesFiledView` puts every `done` entry
under Archived, `lib/filed-tasks.ts:87`) still falls to the dialog rather than to an accident.

Not a compatibility shim, which is what the first draft called it: nothing here keeps an old shape
alive beside a new one. Both containers render the same component, the same actions, the same
`data-slot`s. The only difference is what wraps them, and there are two wrappers because there are
two entry points, only one of which the owner asked to change.

### Actions on the page

The same set the dialog's footer offers (Start, and Archive/Restore), since "preserve available task
actions" in the acceptance criterion is read as *identical*, not *narrowed*.

**They cannot be reused as-is, and the first draft was wrong to say so.** `useStartFiledTask`
(`global-tasks.tsx:1506-1520`) and `useUpdateFiledTodo` (`:1560-1592`) are **file-local**: neither
carries `export`. Importing them from `global-tasks.tsx` into the new route module would also
create a route-module cycle once the board links at the page. So both move to a shared non-route
module, `packages/web/src/api/filed-task-mutations.ts`, and `global-tasks.tsx` imports them back:

| moves | stays in `global-tasks.tsx` |
| --- | --- |
| `useStartFiledTask` (single task) | `useStartFiledTasks` (the bulk selection mutation, `:1522-1552`) |
| `useUpdateFiledTodo` (single task) | every runs-table mutation (`useArchiveIndexedRun` and friends) |

Both already take an explicit project (the discipline `client.ts:1681-1689` exists to enforce),
so the page passes `:projectId` from the URL and inherits it unchanged. `applyFiledPatch`, the
optimistic patch's helper, already lives in the neutral `lib/filed-tasks.ts:194`, so it moves
nowhere.

Start on an already-Done entry is left available deliberately. It is semantically odd, but the
dialog offers it today, the server permits it (`POST /todos/:id/start` 409s only on
`startedTaskId`, `server.ts:6175`), and re-running a finished task is a real thing to want.
Narrowing it would be a behaviour change nobody asked for, in a spec whose job is parity.

`useStartFiledTask` navigates to the new run on success (`scopeTo(projectId, /tasks/${id})`), so
Start leaves the page, and Archive/Restore stays on it with the pill updating optimistically.

## Architecture

```
/tasks?archived=1  (unscoped, GlobalTasksRoute)
  └── FiledTasks ── FiledRow / FiledCard
        detailHref = archived-view && done ? scopeTo(project, `/todos/${id}`) : undefined
              ├── href set    → <Link to={href} state={{from:{pathname:'/tasks',search}}}>
              └── href unset  → <button onClick={onOpenDetail}>  → FiledDetailDialog (unchanged)
                                        │
                                        ▼
/p/:projectId/todos/:todoId  (inside ProjectScopeRoute, routes.tsx:502)
  └── FiledTaskDetailRoute
        ├── useParams()                 → projectId, todoId   (the authority for scope)
        ├── useWorkspaceTodos()         → ['workspace','todos']  ← same key the board reads
        │     └── select (project, id)  → loading | found | not-found | error | project-unavailable
        ├── useLocation().state.from    → the back target, validated; else '/tasks'
        ├── trackEvent('todo.detail_opened')  → POST /api/v1/workspace/analytics/events (202)
        └── useStartFiledTask / useUpdateFiledTodo   ← from api/filed-task-mutations.ts

packages/web/src/components/filed-task-detail.tsx   ← the ONE content component
  ├── FiledTaskDetailContent      → used by the page (plain <h2>)
  └── FiledDetailDialog           → used by FiledTasks (adds the sr-only Dialog a11y pair)

POST /api/v1/workspace/analytics/events
  └── server/workspace-analytics-routes.ts → workspace/analytics-log.ts
        └── append one line to <CEZ_HOME>/analytics/events.ndjson   (0600, fail-open)
```

Unchanged: todos stay per-project `.ai/cezar/todos.json`; the workspace board stays a read-only
aggregation; writes stay on the existing project-scoped `PATCH` / `POST …/start`. The analytics
log is a new file in the per-user home and touches no project state.

**Upstream purity.** Nothing in the new code names this workspace's products, projects or
corpus. A todo detail page is generic cockpit surface, same as the table it came from.

## Phases

Each phase is shippable on its own and leaves the cockpit working. The ordering rule the first
draft broke: **no phase may remove a way in before the way in that replaces it is finished.**

**Phase 1: extract the shared modules. No behaviour change at all.** Move
`FiledDetailBody` → `FiledTaskDetailContent`, `FiledDetailDialog`, `FiledStatusPill` and
`FiledPriorityChip` into `packages/web/src/components/filed-task-detail.tsx`; swap the content's
`DialogTitle`/`DialogDescription` for a plain `<h2>` and add the `sr-only` pair inside the dialog
wrapper. Move `useStartFiledTask` and `useUpdateFiledTodo` into
`packages/web/src/api/filed-task-mutations.ts`. `global-tasks.tsx` imports all six back. The
board behaves identically, and `global-tasks.test.tsx:1684-1710` passes **unchanged**, which is
this phase's own proof it changed nothing.

**Phase 2: the page exists at its URL, actions and all.** Add `FiledTaskDetailRoute` reading
`useParams()` and selecting from `useWorkspaceTodos()`; register `todos/:todoId` in `routes.tsx`
under `ProjectScopeRoute`; render every state in Data models; wire Start and Archive/Restore
through the two moved hooks, carrying the `data-action` attributes over verbatim
(`filed-task-detail-start`, `filed-task-detail-archive` / `-restore`); add `/todos` to the Tasks
nav `match` list (`nav-items.ts:96`); back link falls back to `/tasks` (no board change yet, so
there is no return state to read). The board is still untouched and still opens the dialog; the
page is reachable by typing or pasting the URL, and it is complete when it is reachable. Route,
state and action tests.

**Phase 3: the Archived view's Done titles navigate.** `FiledTasks` computes `detailHref`;
`FiledRow`/`FiledCard` render a `<Link>` when it is set, carrying
`state={{ from: { pathname: '/tasks', search } }}`; the page's back link prefers that validated
state. `FiledDetailDialog`, `onOpenDetail` and the `detail` state all **stay**: every non-Done
row and every Active-view row still opens the modal. Tests: the navigation test for a Done
archived row, and the guard test that an active filed task still opens `role="dialog"`.

**Phase 4: analytics, delivered.** Contract schema, `POST /api/v1/workspace/analytics/events`,
the `<CEZ_HOME>/analytics/events.ndjson` sink, the typed client wrapper, the `trackEvent` helper
and the page's once-per-resolved-task effect. Ships last because it is the only phase that
touches the server, and the page is already correct without it. The documentation this drags in
lands in this same commit, all four surfaces: `BACKWARD_COMPATIBILITY.md` §2 (the route) and §1
(the env var), plus `.env.example` and the README env table, which `AGENTS.md:31` requires for any
new user-facing `CEZ_*` variable.

**Phase 5: verification.** New e2e spec, gates, and the recorded production run.

**Phase 6: the record, in the same session as the code.** House rule: a decision is not recorded
until `cez kb search` finds it, and a correction that does not mark what it invalidates leaves the
stale entry reading as current. Three writes, all proposed through `CEZ_KB_WRITE_FILE`
(`.ai/cezar/runs/<taskId>.knowledge.ndjson`), never by editing a mounted corpus document by hand:

1. **Upsert a current decision note** stating **both** behaviours, so the next session cannot read
   half of it: Archived-view Done filed tasks open as a full project-scoped page at
   `/p/:projectId/todos/:todoId`, **and** every other filed row (the whole Active view, and any
   non-Done row) still opens `FiledDetailDialog`. Name the route, the shared
   `components/filed-task-detail.tsx` extraction, the `todo.detail_opened` event, its
   `<CEZ_HOME>/analytics/events.ndjson` sink and its relationship to the existing run-scoped
   `metric` events, the `CEZ_ANALYTICS=0` opt-out, and this spec's path.
2. **Supersede/correct `notion-7bb302edff13`** (`notion-export/tasks/local-2026-08-17-filed-tasks-table-statuses.md`),
   the 2026-08-17 record whose "detail dialog (context / what-to-do / acceptance criteria …)"
   sentence is the first thing a reader finds and is now true of only some rows. A `supersede` op
   naming the new note as `by`, with a dated note saying the dialog survives for Active-view and
   non-Done rows while Archived-view Done rows navigate to a page. Corrected in place per the
   house rule: the original text stays below the lead-in, unchanged.
3. **A changelog entry** in the corpus changelog, following the existing
   `notion-export/changelog/<date>-<slug>--local.md` convention (e.g.
   `2026-08-25-account-fallback-instead-of-blocking-dispatch--local.md`), Type `Added`, Area
   `Cezar`.

A KB proposal is reviewed and applied later, through the cockpit or `cez kb proposals`, never
automatically. So this phase is complete only when the **applied** record is findable, which means
running the reindex and checking:

```bash
cd /var/lib/cezar/loki-labs && CEZ_KB=1 cez kb reindex
cez kb search "filed task detail page"    # must return the new note
grep -ac "filed-task-detail-page" \
  /var/lib/cezar/loki-labs/.ai/cezar/knowledge-index/catalog.ndjson   # want 1
```

Grep the slug or the path, never the document's prose: the catalog stores an `excerpt`, so a
phrase-grep returns `0` even for a correctly indexed document. And the reindex is not optional
ceremony: a corpus write is not a KB write until it runs, because the `loki-labs` project holds
the corpus and nothing keeps a `KnowledgeStore` open for it, so its watcher never fires and the
failure is silent in both directions (the file is on disk, and `cez kb search` cannot see it).

## Data models

**The todo record does not change.** `todoItemSchema` (`packages/contract/src/skills.ts:73-157`)
and `workspaceTodoEntrySchema` (`packages/contract/src/workspace-todos.ts:31-34`) are read exactly
as they are. Nothing about the page is persisted onto the todo: no `viewedAt`, no `openedAt`.
Adding a stamp would mean a write on every read, on a record whose lock every other writer shares
(`todos.lock`), to serve a display change. (The analytics event below is a separate append-only
file and never touches `todos.json`.)

### The page's derived state

Derived, not stored, and it needs five branches, not three. `useWorkspaceTodos()` is a plain
`useQuery` with no `enabled` gate (`queries.ts:2480-2485`), so it has a real failure mode, and the
response carries a per-project health array (`workspaceTodosResponseSchema.projects`,
`workspace-todos.ts:36-41`, rows of `workspaceProjectHealthSchema`: `{id, name, status, ok,
reason?, total}`, `workspace-runs.ts:76-83`) precisely because a registered project can be
`missing` / `not-git` / `no-commits` and contribute no todos at all.

```ts
type FiledTaskDetail =
  | { state: 'loading' }
  | { state: 'found'; entry: WorkspaceTodoEntry }
  | { state: 'error'; message: string }                                   // the GET itself failed
  | { state: 'project-unavailable'; projectId: string; reason?: string }  // health row, ok === false
  | { state: 'not-found'; projectId: string; todoId: string }
```

Resolution order, and it is an order rather than a set of independent checks:

1. `query.isPending` → `loading`. `not-found` is only reachable once the query has **settled**,
   or a cold direct load would flash "no such task" before its own data arrived.
2. `query.isError` → `error`, rendering the query's own message plus a retry. Without this branch
   a settled, *failed* request falls through to the final `else` and a transport failure is
   rendered as "this task does not exist". That is the reviewer's finding, and the worst of the five
   because it is the one that lies.
3. a matching `(project, id)` pair → `found`.
4. no match, and `projects.find(p => p.id === projectId)?.ok === false` → `project-unavailable`,
   naming the health row's `reason`. The todo may well exist; this cockpit could not read the
   project it lives in.
5. otherwise → `not-found`: a successful, healthy response that genuinely has no such pair. This
   is also what a real cross-project mismatch renders (`/p/a/todos/<id-that-lives-in-b>`), which
   is the scope assertion in Verification.

Each of the five gets its own test.

### The analytics event record

One NDJSON line per event, in `<CEZ_HOME>/analytics/events.ndjson`. Schema in
`packages/contract/src/analytics.ts`, so the client, the route and the file all agree on one
definition:

```ts
export const analyticsEventSchema = z.object({
  /** `noun.verb_past`, the grammar `todo.filed` / `run.reopened` already use. Bounded so a
   *  malformed client can never write an unbounded key into the log. */
  name: z.string().min(1).max(64).regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/),
  /** Flat, scalar-only, at most 16 keys, never free text, never a task summary. */
  props: z.record(z.string().max(64), z.union([z.string().max(200), z.number(), z.boolean()]))
    .refine((p) => Object.keys(p).length <= 16, 'at most 16 props'),
});
export const analyticsEventsRequestSchema = z.object({
  events: z.array(analyticsEventSchema).min(1).max(20),
});
export const analyticsEventsResponseSchema = z.object({ accepted: z.number().int() });
```

The server stamps `ts` (ISO, server clock) and `v: 1` on each line itself; the client cannot set
either. `props` is deliberately scalar-and-bounded rather than `z.unknown()`: this file is written
by a browser and read by a human, and an unbounded value is how a task's own body ends up in a log
nobody meant to keep.

## API contracts

### Three existing routes, unchanged

Rendering the page adds no route. All three are already in the `BACKWARD_COMPATIBILITY.md` §2
inventory:

| route | used for | source |
| --- | --- | --- |
| `GET /api/v1/workspace/todos` | hydrate the page (board's own query key) | `server.ts:7107`, `queries.ts:2480` |
| `PATCH /api/v1/p/:projectId/todos/:id` | Archive / Restore | `server.ts:6134`, `client.ts:1690` |
| `POST /api/v1/p/:projectId/todos/:id/start` | Start | `server.ts:6164`, `client.ts:1662` |

### One new route, for the event

**Corrected from this spec's first draft, which claimed "no new HTTP route".** That claim was only
true while the analytics requirement was being answered with a comment, and the task asks for an
event, not a marker. A browser cannot append to a file, so delivering one costs exactly one route:

```
POST /api/v1/workspace/analytics/events
  body    analyticsEventsRequestSchema   {events: [{name, props}]}   (zod, at the boundary)
  200     {accepted: n}                  (never used; see below)
  202     {accepted: n}                  the normal answer: queued for append, not yet fsynced
  400     the standard zod error body    a malformed name/props shape
```

**202, not 200 or 204.** The handler validates, hands the line to the sink and returns; it does
not await the disk. 202 is the honest code for that (accepted, not yet done), and it keeps the
client's fire-and-forget contract from depending on write latency. `accepted` is the count the
route validated, so a caller can tell "you sent 3, I took 3" without learning anything about the
filesystem.

**Workspace-level and single-mount**, never mirrored under `/api/v1/p/:projectId`, the rule every
sibling workspace family follows (`BACKWARD_COMPATIBILITY.md` §2, and
`workspace-todos-routes.ts:27-28` states it in the same words). The project is a *prop* on the
event, not a URL segment, because one sink serves the whole workspace.

Registered as its own chained family, `createWorkspaceAnalyticsRoutes()` in
`packages/cezar/src/server/workspace-analytics-routes.ts`, mounted beside
`createWorkspaceTodosRoutes()` (`server.ts:7107`). A chained builder rather than a loose
`app.post`, because that is the only registration Hono can infer types from and the only one
`bc-route-inventory.test.ts` can see (`bc-route-inventory.test.ts:26-33`: a loose route would
"quietly stop being seen", which that guard names as the one thing it must never do).

Work this route drags in, none of it optional:

- **§2 inventory line**, in the workspace-family list beside the workspace-todos bullet
  (`BACKWARD_COMPATIBILITY.md:117`). Additive per §2's own general rule ("new route … fine"), but
  additive is not exempt from being listed: `bc-route-inventory.test.ts` fails the build if the
  route exists and the prose does not name it.
- **`CEZ_ANALYTICS` gets all three of its documentation surfaces**, because this repo requires all
  three and the backward-compatibility inventory alone does not satisfy it. `AGENTS.md:31` is
  explicit: *"Adding, renaming, or removing a `CEZ_*` env var … MUST update `.env.example` in the
  same commit (and the README env table when the var is user-facing). `.env.example` is the env
  contract's single documentation surface; an undocumented env var is a bug."* This variable is
  user-facing, so all three land in the Phase 4 commit:
  - **`.env.example`**: a commented-out entry in that file's own house style (a `# ---- section`
    comment, a short prose paragraph, then `# CEZ_ANALYTICS=0`), spelled like the
    `CEZ_AUTOMATIONS` entry at `.env.example:194`.
  - **The README "Useful environment variables" table** (`README.md:559` and the rows below it):
    one row, beside `CEZ_FOLLOWUPS` and `CEZ_AUTOMATIONS`.
  - **The `BACKWARD_COMPATIBILITY.md` §1 env-var list** (`BACKWARD_COMPATIBILITY.md:13`), which
    enumerates every `CEZ_*` name and is where a removal or rename later has to be justified.
- **`contract-parity.analytics.test.ts`**, a copy of
  `contract-parity.workspace-todos.test.ts`'s compile-time `Mutual`/`Exact` guard, extended to the
  request body as well as the response, since this family has a mutator. Enforced by
  `npm run typecheck`.
- **`packages/contract/src/index.ts`** gains `export * from './analytics.ts'`.
- **`postAnalyticsEvents(events)`** in `packages/web/src/api/client.ts`, the typed `hc` wrapper,
  spelled like `updateWorkspaceTodo` (`client.ts:1690-1702`) but **without** `unwrap`'s throw on a
  non-2xx: this one call site swallows.

**Analytics is ON by default, and only the exact value `CEZ_ANALYTICS=0` turns the sink off.** On
by default because the sink is a plain file on the user's own disk that leaves the machine never,
and because an opt-in nobody sets measures nothing. Only the **exact** string `0` disables it, the
same "exact value" discipline every other switch in the §1 list already uses (`CEZ_AUTOMATIONS=1`,
`CEZ_AGENT_TMPDIR=0`): `CEZ_ANALYTICS=false`, `CEZ_ANALYTICS=off` and an empty `CEZ_ANALYTICS=` do
**not** disable it, and all three documentation surfaces above say that in those words rather than
leaving a reader to guess which spellings count. With it set to `0` the route still exists and
still answers `202` (a client must not have to care whether the operator kept the log), and the
sink drops the line instead of appending. Writing a record of what a person opened, with no way to
say no, is not something to ship by default silence. Off is one variable, the variable is
documented in all three places, and a unit test asserts both directions.

## Analytics

**Corrected from this spec's first draft, which specified a `TODO(analytics)` comment and no
delivery.** The task says "Add analytics for opening the filed-task detail page"; a marker adds
nothing and answers nothing. This phase builds the smallest sink that is real.

**What is actually there today, and what is missing.** Corrected from this spec's earlier draft,
which claimed cezar has no product-analytics mechanism at all and only two orphan markers. That is
wrong. cezar already persists real analytics: `type: 'metric'` events written onto a run's own
NDJSON through `RunStore.appendEvent()`. Live at HEAD: `run.workflow.selected` (`run.ts:1564-1565`),
`run.step.stopped` (`run.ts:5508-5510`), `run.step.resumed_after_stop` (`run.ts:5527`),
`run.step.retried_cold_broker` and `run.step.runner_downgraded`, each asserted by its own test
(`run.test.ts:1254`, `step-stopped.test.ts:168`, `broker-retry.test.ts:124`,
`account-fallback.test.ts:614`). `.ai/specs/2026-08-24-codex-only-default-workflow.md:468-479`
names that mechanism as the analytics surface in as many words: *"The run's own NDJSON is the
analytics surface."*

**What is missing is the two things this page needs.** First, there is no workspace-scoped
ingestion surface a browser can reach: every existing metric is emitted server-side, from inside a
workflow run, and nothing in `packages/web` posts one. Second, and decisively, **a filed task has
no run**, so there is no `runs/<id>.ndjson` for a `todo.detail_opened` line to be appended to.
Opening a filed task's page is precisely the event that happens when no run exists. The two orphan
markers say the same thing from the other side: `packages/cezar/src/todo-cli.ts:212`
(`TODO(analytics): emit todo.filed …`) and `packages/cezar/src/reopen-watch.ts:51`
(`TODO(analytics): emit run.reopened …`) both wait for *"once an event sink exists"*, and both
describe a fact about a todo rather than about a run.

So the workspace log below is a **companion** to the run-scoped metric mechanism, not a
replacement for it and not a competing second one. Run-scoped facts keep going onto the run's own
NDJSON, untouched by this change; workspace-scoped facts, which have no run to belong to, go to
`<CEZ_HOME>/analytics/events.ndjson`. The naming is taken from the existing metrics rather than
invented: `run.workflow.selected` and `run.step.stopped` are the precedent for
`todo.detail_opened`, same `noun.verb_past` grammar, same lowercase dotted key.

**No SDK, and that is not a compromise.** `AGENTS.md`: "Everything is local: no accounts, no
database, no cloud", with state as "plain JSON, NDJSON and Markdown". A hosted analytics SDK would
ship a person's workspace activity to a third party from a tool whose entire premise is that it
does not. A local NDJSON log is what every other stream of facts in this repo already is
(`runs/<id>.ndjson`, `cluster/ops.ndjson`, `worktree-reaps.jsonl`).

### The event

`todo.detail_opened`, in the `noun.verb_past` grammar the two markers already use
(`todo.filed`, `run.reopened`):

| prop | value | source |
| --- | --- | --- |
| `project` | the registry slug | `:projectId` from the URL, never the entry; the URL is the scope authority |
| `status` | `todo` \| `in-progress` \| `blocked` \| `done` | `filedStatus(entry)` (`lib/filed-tasks.ts:66`) |
| `archived` | boolean | `entry.todo.archivedAt !== undefined`, the stamp, not the view |
| `source` | `board` \| `direct` | **deterministic**: `board` iff the validated return state from Risk 1 is present on `location.state`, i.e. this history entry was created by an in-app board link; `direct` when there is no router state at all, which is a pasted URL, a bookmark, a typed address, or a link followed from outside the app |

`source` is the one thing this whole feature makes newly answerable, and it is derived from the
same `location.state.from` the back link uses: one fact, two consumers, so the two can never
disagree about where the visit came from.

**A refresh is `board`, not `direct`, and an earlier draft of this table got that wrong** by
listing "refresh" beside paste and bookmark. That is not how the platform behaves: the history
entry's `state` is serialized into session history by `pushState`, and a reload restores the
**same** entry, so `history.state` (and therefore React Router's `location.state`) survives F5,
cmd-R and a restored tab. Under the implementation specified here, a refreshed board-originated
visit still finds a validated `state.from` and is therefore still `board`. That is also the honest
reading of the measurement: the question is "did this history entry come from the board", and a
reload of that entry did. `direct` means genuinely state-less navigation and nothing else. If
"was this a reload" is ever wanted, it is a **separate** prop from a separate mechanism
(`performance.getEntriesByType('navigation')[0].type === 'reload'`), deliberately not built here
and not implied by `source`. Verification splits the two checks apart accordingly.

**Emitted once, after the entry resolves.** The effect runs only in the `found` state (an event
for a task that turned out not to exist measures nothing), and de-duplicates on a ref keyed by
`${projectId}:${todoId}`:

```ts
const emitted = React.useRef<string | null>(null)
React.useEffect(() => {
  if (detail.state !== 'found') return
  const key = `${projectId}:${todoId}`
  if (emitted.current === key) return
  emitted.current = key
  trackEvent('todo.detail_opened', { project: projectId, status, archived, source })
}, [detail.state, projectId, todoId, status, archived, source])
```

The ref, not the effect's dependency array, is what makes it once: React 19 StrictMode mounts an
effect twice in development, and an optimistic Archive re-renders `found` with a new `archived`
value. Both would otherwise double-count. Navigating to a *different* task changes the key and
emits again, which is correct.

### The client half

`packages/web/src/lib/analytics.ts` exports `trackEvent(name, props)`: build the event, call
`postAnalyticsEvents([event])`, `.catch(() => {})`. **Fail-open and silent**: no toast, no retry,
no queue. An analytics failure must never be a thing the user is told about, and must never block
the render it describes; the page is already on screen by the time this fires.

### The sink

`packages/cezar/src/workspace/analytics-log.ts`, path from a new
`analyticsLogPath()` helper in `packages/cezar/src/paths.ts` (the file that owns every
`CEZ_HOME`-derived path and says so: *"Do not duplicate this homedir logic elsewhere"*,
`paths.ts:14`):

```
<CEZ_HOME>/analytics/events.ndjson     0600, in a 0700 directory
```

Per-user, not per-project. A todo detail page is workspace surface reached from a cross-project
board, and writing into whichever project the todo belongs to would scatter one stream across N
repos and put a personal usage log inside a shared checkout.

Five properties, each with a reason and a test:

1. **Append-only NDJSON, one JSON object per line.** `fs.appendFile(path, line, {mode: 0o600})`
   after `fs.mkdir(dirname, {recursive: true, mode: 0o700})`, the exact shape of
   `cluster/oplog.ts:44-52`'s `appendOps`, which is the repo's existing NDJSON-append precedent.
2. **Serialized appends.** One module-level promise chain (`queue = queue.then(...)`) so
   concurrent requests in this process append in order and never interleave a partial line. No
   cross-process lease, unlike `todos.ts`'s `withTodosLease`: `O_APPEND` makes a single
   sub-`PIPE_BUF` write atomic on POSIX, and the file is a log, not a source of truth: a lost or
   torn line costs one measurement, and there is no reader to corrupt (`oplog.ts:21-24` makes the
   same trade for the same reason).
3. **Fail-open.** Every error is caught, warned once through `console.warn` in the
   `[cez] …` form `oplog.ts:36-38` uses, and swallowed. A read-only home, a full disk, or an
   `EACCES` degrades analytics to nothing; it never fails a request and never reaches the page.
4. **Bounded retention**, because an append-only file with no bound is a slow disk leak.
   `ANALYTICS_LOG_MAX_BYTES = 5_000_000` (~30k events at ~160 bytes/line): before appending, if
   `statSync(path).size >= MAX`, `rename` it to `events.1.ndjson` (replacing any previous
   generation) and start a fresh file. One generation, so the ceiling is 2×MAX ≈ 10 MB, forever.
   No repo precedent for log rotation exists (checked); every other NDJSON here is
   run-scoped and bounded by the run, so this scheme is stated in full rather than borrowed.
5. **Sandbox-guarded.** The write calls `assertCezarHomeWriteIsSandboxed()` (`paths.ts:36`) like
   every other `CEZ_HOME` writer, so a suite whose `CEZ_HOME` pin has been dropped fails loudly
   instead of appending to the developer's real `~/.cezar`.

## Risks

1. **The back link must not be scoped, and must not throw away `?archived=1`.** Two traps in one
   link.

   *Scoping.* `Link` from `lib/project-router.tsx` prefixes any `/`-leading target
   (`scopePathname`, `:56-62`), so `<Link to="/tasks">` on a page under `/p/x/` emits
   `/p/x/tasks`, which matches **no** child route of `ProjectScopeRoute` (`tasks/:id` needs a
   second segment) and therefore falls to `NotFoundRoute` (`routes.tsx:696`). The back link uses
   the raw `react-router` `Link`/`useNavigate`, which is what `global-tasks.tsx:16` itself does
   (it imports `Link` from `react-router` and applies `scopeTo` by hand at each call site), and
   what `new-task.tsx:558` (`routerNavigate('/tasks')`) and `command-palette.tsx:446`
   (`goGlobal('/tasks')`) do for this same target.

   *State.* A back link hard-coded to `/tasks` returns to the **Active** view, because the
   Active/Archived split is URL-backed as `archived=1` present-or-absent
   (`global-tasks.tsx:148-152`; written by `urlStateToSearchParams`, `lib/global-tasks.ts:495`;
   read back at `:522`). Coming from the Archived view and landing on Active is both a bad
   return and a direct contradiction of Verification step 5, which asserts the Archived view is
   still there. So the board's link carries its own location forward:

   ```tsx
   <Link to={detailHref} state={{ from: { pathname: '/tasks', search: location.search } }}>
   ```

   and the page resolves its back target as `validFrom(location.state) ?? '/tasks'`. `validFrom`
   accepts the state **only** when `pathname === '/tasks'` exactly and `search` is a string
   starting with `?` or empty: history state is caller-supplied, and an unvalidated pathname out
   of it is an in-app open redirect. A direct load has no state and falls back to `/tasks`, which
   is right: there is no view to return to. The same validated value decides the event's
   `source`, so the two cannot disagree.
2. **The Tasks nav item goes inactive without a match entry.** `nav-items.ts:96` matches
   `['/', '/tasks', '/compare']`; a `/todos/:id` page matches none, so the sidebar would
   de-highlight Tasks while reading a task. Phase 1 adds `/todos` to that list. Segment-aware
   matching is already the rule there (`nav-items.ts:217`).
3. **A flat `/todos/:id` paste lands in the wrong project.** `LegacyPathRedirect`
   (`routes.tsx:309-371`) sends any unmatched flat path to `/p/<boot>/…`, so an unscoped todo URL
   resolves against the boot project and renders not-found for another project's todo. Accepted:
   every link the cockpit emits is scoped, and this is the existing behaviour of every flat path.
   The not-found state names the project and id so the failure is legible rather than blank.
4. **Cold direct load fetches the whole workspace todo list.** ~631 entries at the last migration
   count, to render one. Accepted, and bounded: `/tasks` already pays exactly this on every load,
   so the page adds no new worst case, and the warm-cache click-through path pays nothing.
5. **Two containers for one record could drift.** The dialog stays for non-Done rows, so a future
   edit could land in one and not the other. Mitigated structurally rather than by care: there is
   exactly one `FiledTaskDetailContent`, and both containers render it with the same props. The
   only thing either owns alone is its chrome (the dialog's `sr-only` a11y pair, the page's
   header and back link). A guard test asserts an active filed task still opens `role="dialog"`,
   so removing the dialog by accident is a red test rather than a silent regression.
6. **Not-found must not flash on a cold load, and a failed request must not read as not-found.**
   Both are the resolution order in Data models: `isPending` → `loading` before anything else,
   `isError` → `error` before the match. Tests for both, and a fifth for the
   `project-unavailable` health row.
6a. **A dropped analytics event is invisible by design.** Fail-open means a broken sink looks
   exactly like a working one from the page. Accepted (the alternative is a toast about
   telemetry), and bounded by the test that asserts one line actually lands in
   `events.ndjson` under a pinned `CEZ_HOME`, plus the `console.warn` on the server side. If the
   number ever matters operationally, `wc -l` on the file is the check.
6b. **The event writes to the operator's disk.** One line per opened task, carrying a project
   slug, a status and a boolean: no summary, no context, no body, enforced by the bounded
   `props` schema. `CEZ_ANALYTICS=0` turns it off, the file is `0600` in a `0700` directory, and
   nothing ever leaves the machine.
7. **A todo id colliding across projects.** Two projects could theoretically share a uuid. The
   `(project, id)` pair is already the row key on the board and the key
   `useUpdateFiledTodo`'s cache patch uses (its own doc comment, `global-tasks.tsx:1554-1558`).
   The page selects on the same pair, from the URL, so it inherits that discipline rather than
   re-deciding it.

## Verification

Gates are necessary, not sufficient: this is **QA Needed** until step 6 has actually run.

1. **Unit / route tests, new `packages/web/src/routes/filed-task-detail.test.tsx`:**
   direct load at `/p/api/todos/todo-1` renders summary, status pill, project link, and every
   section the entry carries; an entry with no `acceptanceCriteria` / `knowledgeRefs` renders
   neither `data-slot` (the assertion moved from `global-tasks.test.tsx:1684-1710`). Then one
   test per derived state: query in flight → loading (never not-found); query rejected → `error`
   with the message and a retry (never not-found); a `projects` health row with `ok: false` for
   `:projectId` → `project-unavailable` naming its `reason`; a healthy response with an unknown
   `todoId` → `not-found`; a `todoId` that exists **in another project** → `not-found` (the scope
   assertion).
2. **Action tests, same file:** Start POSTs to the URL's project and navigates to the new run;
   Archive PATCHes `{archived: true}` and flips the pill optimistically; a rejected PATCH rolls
   the pill back and toasts the server's own words.
3. **Board tests, `packages/web/src/routes/global-tasks.test.tsx`:**
   - an Archived-view **Done** row's title is an anchor whose href is `/p/<project>/todos/<id>`;
     clicking it navigates and renders the page;
   - **the guard test:** an **active** filed row's title is still a `<button>`, and clicking it
     opens `role="dialog"` with the same `data-slot`s (the dialog is preserved, not deleted);
   - a Done row's link carries `state.from = {pathname: '/tasks', search: '?archived=1'}`, and
     the page's back link href is exactly `/tasks?archived=1`, never `/p/<project>/tasks`, never
     bare `/tasks` when the state is present;
   - with no `state`, the back link href is exactly `/tasks`.
4. **Analytics tests:**
   - `packages/web/src/lib/analytics.test.ts`: `trackEvent` POSTs the built event once; a
     rejected POST resolves and throws nothing (fail-open), and toasts nothing.
   - `filed-task-detail.test.tsx`: exactly **one** POST for one resolved task across a
     StrictMode double-mount and an optimistic Archive re-render; **zero** POSTs while loading or
     in any non-`found` state; `source: 'board'` with the return state present and `'direct'`
     without it.
   - `packages/cezar/src/workspace/analytics-log.test.ts`: an append lands one parseable line
     with a server-stamped `ts`; twenty concurrent appends land twenty whole lines (serialization);
     a file at `MAX_BYTES` rotates to `events.1.ndjson` and the new file holds only the new line;
     an unwritable directory warns and resolves rather than throwing (fail-open);
     `CEZ_ANALYTICS=0` appends nothing.
   - `packages/cezar/src/server/workspace-analytics-api.test.ts`: a valid body answers `202
     {accepted: 1}`; a malformed `name` answers `400`; a sink that throws still answers `202`.
5. **Gates:** `npm run typecheck`, `npm test`, `npm run test:unit`, `npm run test:package`,
   `npm run build`, all green. **`npm run lint` is deliberately absent from this list**: neither
   the root `package.json` nor any workspace defines a `lint` script (verified: the root's
   scripts block has none, and `grep '"lint"'` across every `package.json` returns nothing), and
   `bc-route-inventory.test.ts:12` says so in its own words ("the repo has no linter, no markdown
   check and no link checker"). Naming a gate that cannot run is how a spec claims verification it
   never had.
   `bc-route-inventory.test.ts` and `contract-parity.*` **must go red first** if the §2 entry is
   missing, and green once it lands: that is this change's proof the new route was inventoried
   rather than smuggled in.
6. **Local browser e2e, new `packages/web/e2e/filed-task-detail.e2e.ts`**, following
   `task-thread.e2e.ts`'s boot-own-server doctrine (`fixtureServeEnv`, `CEZ_DRY_RUN=1`,
   pinned `CEZ_HOME`, a throwaway `dataRoot`). Fixture: a `todos.json` carrying one
   `status: 'done'` + `archivedAt` entry with `context`, `whatToDo`, `acceptanceCriteria` and
   `knowledgeRefs`, plus one **active** entry (the guard row). Steps, each with a `screenshot()`
   into `.ai/qa/artifacts_e2e`, numbered so the sequence reads as a filmstrip:
   1. open `/tasks`, switch to the Archived view; assert the URL is now `/tasks?archived=1`;
      screenshot;
   2. click the Done row's title; assert the URL is `/p/<boot>/todos/<id>`, that
      `[data-slot="filed-task-detail"]` is present, that no dialog element is in the DOM, and
      that all four content `data-slot`s render; screenshot;
   3. **hard-refresh that URL** (a reload of the same history entry, not a fresh navigation);
      assert every assertion from step 2 still holds, that the back link is still
      `/tasks?archived=1`, and that this visit is still counted as `board` and not `direct`,
      because the entry's `state.from` survives a reload. This is the refresh-survival criterion
      and it is deliberately **not** the `direct` check; screenshot;
   4. click back; assert the URL is **`/tasks?archived=1`** and the Archived view still renders
      its rows; screenshot;
   5. **switch to the Active view**, then click the **active** row's title; assert `role="dialog"`
      opens (the dialog survives); screenshot, then close it. The view switch is not optional
      housekeeping: after step 4 the board is on Archived, where `matchesFiledView` keeps every
      non-archived, non-done row off screen (`lib/filed-tasks.ts:87`), so the active fixture row
      is not present in the DOM and the click cannot be performed until the view changes;
   6. **a separate, genuinely state-less navigation:** open the same page URL cold, the way a
      pasted link or a bookmark arrives, with nothing on `location.state`. Assert the page renders
      the same stored detail, and that its back link href is exactly `/tasks` (the fallback), not
      `/tasks?archived=1`. This is the `direct` check; screenshot;
   7. **poll** `<CEZ_HOME>/analytics/events.ndjson` until the expected records are present or a
      **10 s** deadline expires, re-reading every 250 ms. A single immediate read is a race and is
      forbidden here: the route deliberately answers `202` **before** awaiting the append, and
      `trackEvent` is fire-and-forget on the client, so the line is legitimately not on disk yet
      when the browser step returns. The condition is: at least three `todo.detail_opened` lines
      whose `props.project` is the boot project, with `source: 'board'` present (steps 2 and 3)
      **and** `source: 'direct'` present (step 6). On timeout the step fails and prints the file's
      actual contents, so a real regression is distinguishable from a slow disk.
   Run with `npm run test:e2e`. `TEST_E2E_STATUS=skipped` is **not** a pass
   (`.ai/scripts/e2e.sh`); a skip means this step has not been done.
7. **Recorded runtime E2E on production** (`https://cockpit.example.com`). On the real Archived
   board: click a genuinely archived Done task's title, confirm the full page renders its stored
   detail with no modal, hard-refresh the URL and confirm it still renders (and that Back still
   returns to `/tasks?archived=1`, the reload having preserved the router state), navigate back
   and confirm the Archived view returns, **then switch to the Active view** and open an active
   filed task and confirm the dialog still opens. The view switch is required for the same reason
   as locally: the Back step leaves the board on Archived, which filters every active row out, so
   without it there is no active row on screen to click. Artifacts preserved under `/var/lib/cezar/e2e-artifacts/filed-task-detail-<sha>/`, owned
   by `cezar`, the convention set by `.ai/specs/2026-08-24-bulk-start-filed-tasks.md` §5
   (`/var/lib/cezar/e2e-artifacts/bulk-start-480e0282/`). The run is done only when that directory
   holds the per-step PNGs **and** a `NOTES.md` naming the commit, the URL of the task used, and
   the pass/fail of each step. Record the result honestly: if it fails, the feature stays **QA
   Needed** and the failure is quoted here.

   **On "recorded", and video.** The requested artifact set was "video as well as screenshots".
   The provider this repo drives cannot do it: `.ai/browsers/agent-browser.md` §Operations
   documents exactly eight operations: `ensure-installed`, `doctor`, `open`, `snapshot`,
   `interact`, `assert`, `screenshot`, `close`, with no screencast, no video and no trace, and
   `e2e/agent-browser.ts:233` wraps `screenshot` as the only artifact-producing call. So the
   recording is the numbered per-step PNG sequence above plus the retained `snapshot` JSON, both
   preserved per run rather than overwritten. **Optional, and only if `ffmpeg` is on the box:**
   assemble those PNGs into `walkthrough.mp4` in the same directory
   (`ffmpeg -framerate 1 -pattern_type glob -i '*.png' …`). It is a slideshow of the same frames,
   not a capture of the session, and it is labelled that way in `NOTES.md`: claiming a video the
   harness never took would be the same defect as claiming a lint gate it cannot run.
8. **Ownership check for any session that touched the box:**
   `find /var/lib/cezar -not -user cezar | wc -l` must print `0`.

## Out of scope (recorded, not forgotten)

- Sub-pages for a filed task (`/todos/:id/changes` and friends). A filed task has no worktree.
- Editing `context` / `whatToDo` / `acceptanceCriteria` from the page. The only mutations are the
  two that exist today; `updateTodoInputSchema` carries `status` / `priority` / `archived` and
  nothing else (`skills.ts:205-215`).
- Re-pinning a todo's `placement` from the page, a real gap, already recorded at its own schema
  (`skills.ts:144-150`), belonging to the cluster board work, not here.
- A second analytics event, a *reader* for the sink, or any aggregation UI over it. Phase 4 builds
  the write path for exactly one event; nothing reads `events.ndjson` back except a human with
  `tail`. The two existing `TODO(analytics)` markers (`todo-cli.ts:212`, `reopen-watch.ts:51`) are
  left where they are: the sink they were waiting for now exists, but wiring them is their own
  change, not this one.
