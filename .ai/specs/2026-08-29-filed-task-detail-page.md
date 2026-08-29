# Filed task detail page

- **Status:** Implemented, QA Needed. **Corrected 2026-08-29 (same day, step 8 "Document the
  decision")** — this read "Specified, not implemented" through step 2; that is now stale. Phases
  1-4 (BROAD scope, including the Active/Backlog port folded in during the merge) landed in
  `d15e26f9`, merged into `main` via PR #13 (`5c5de5eb`) at 2026-08-29T16:38:24Z, confirmed by
  `git merge-base --is-ancestor` against `origin/main` and by `gh pr view 13` reporting
  `state: MERGED`. `FiledDetailDialog` no longer exists anywhere in the tree. QA Needed, not Done,
  for two reasons named in full in "Phase 5" and "Phase 6" below: no recorded runtime/production
  browser E2E exists (this box has no ffmpeg and no Playwright), and Phase 6 item 4 (marking todos
  `33bee966`/`12dc1ac0` done) needs a signed-in person and remains PENDING as of this writing —
  `cezar todo list --project cezar --json` still prints `status: todo` for both.
- **Date:** 2026-08-29
- **Task:** `1909f34e-3560-4622-9178-72b7b9724944`, workflow `spec-to-deploy`, step 2 "Write the spec".
- **Brief this was written against:** `.ai/specs/briefs/2026-08-29-open-archived-tasks-full-page.md`
  (step 1 of this same run). Every claim it makes about the current tree was re-read directly and
  is re-cited below with the line it was read at.
- **Owner instruction:** "Open archived tasks as full pages", restated 2026-08-29 as "archived
  Done tasks still open only their notes/details inside FiledDetailDialog. This is not implemented
  yet."
- **Second attempt.** `.ai/specs/2026-08-26-filed-task-detail-page.md` designed this feature three
  days ago and shipped only its Phase 4 (the analytics backend, `abe83105`, merged via
  `bc9e0908`; status corrected in `ef9d7990`). This document **supersedes that spec in full**: it
  keeps its route shape, its component-extraction plan, its five-branch derived-state model and
  its back-link mechanics, and it **reverses its scope decision**. See "The scope decision" below,
  which is the one thing in here that is genuinely new.
- **Supersedes:** `.ai/specs/2026-08-26-filed-task-detail-page.md` (whole document), and
  partially `.ai/specs/2026-08-17-filed-tasks-table-statuses.md` (KB `notion-7bb302edff13`,
  shipped `c65ca0bf`), which introduced `FiledDetailDialog`. That spec's detail-view acceptance
  criteria stay satisfied, through a page rather than a dialog, for every filed row.
- **Two mis-citations in the task's own stated record, re-confirmed by direct read.**
  `.ai/specs/2026-08-17-notion-export-cezar-import.md` (named in this task's `knowledgeRefs`) is
  the Notion-to-corpus export and KB-mount spec; it says nothing about filed-task detail views,
  routing or dialogs, and records its own v1 approach as superseded the same evening by
  `2026-08-17-filed-tasks-table-statuses.md`. It does not govern here.
  `.ai/specs/2026-08-25-workspace-scope-routes-tasks.md` is a name collision: its "routes tasks
  into projects" is `cez todo add --project` CLI dispatch, not browser routing.

## TLDR

Every filed task gets a real URL: `/p/:projectId/todos/:todoId`, registered inside the existing
`ProjectScopeRoute` layout, rendering the entry's complete stored detail (summary, status,
priority, project, author, filed time, archived state, cluster node, context, what to do,
acceptance criteria, knowledge refs) plus its Start and Archive/Restore actions, hydrated from the
workspace todos query so it survives a direct load and a refresh. Desktop rows and mobile cards
both link to it. `FiledDetailDialog` is deleted: no filed row opens a modal any more. Opening the
page emits one `todo.detail_opened` event through the analytics route that already shipped. No
change to the todo record's schema.

## Problem

1. **A filed task has no address.** `FiledTasks` holds the open entry in React state
   (`packages/web/src/routes/global-tasks.tsx:755`,
   `const [detail, setDetail] = React.useState<WorkspaceTodoEntry | null>(null)`) and renders
   `FiledDetailDialog` (`global-tasks.tsx:952`, defined at `:1347`). Both entry points are plain
   buttons: the desktop row title at `global-tasks.tsx:1148-1156` and the mobile card title at
   `:1277-1285`, each `<button type="button" data-slot="filed-task-title" onClick={onOpenDetail}>`.
   The row's own doc comment at `:1100-1101` calls it "a title BUTTON (not a link)" precisely
   because "there is no run yet to navigate to". So a filed task cannot be linked, bookmarked,
   pasted to someone, reopened after a refresh, or reached by the back button.
2. **Archived work is read work, and a modal is the wrong container for it.** A Done entry is
   opened to read: context, what to do, acceptance criteria, what grounded it. Today that happens
   inside a `max-h-[80dvh]` scroll box (`global-tasks.tsx:1366`) layered over the table it came
   from.
3. **The modal does not even show the whole record.** `FiledDetailBody` (`global-tasks.tsx:1382`)
   renders summary, status pill, priority chip, project link, filed date, the cluster node cell
   when clustering is on, then `context`, `whatToDo`, `acceptanceCriteria`, `knowledgeRefs`. It
   renders **no author**, although the row beside it does (`AuthorCell` at `global-tasks.tsx:1163`,
   from `components/author-cell.tsx:50`), and **no archived stamp**, although it computes
   `archived` at `:1396` and uses it only to pick the button label. The owner's 2026-08-29 wording
   ("open only their notes/details") is describing exactly this partial view.
4. **The asymmetry is already visible in the product.** A run-backed task is a full page at
   `/p/:projectId/tasks/:id` (`routes.tsx:507-513`, into `routes/task-thread/task-thread.tsx`)
   with its own changes / files / commits sub-pages. A filed task, the thing that becomes that
   run, is a modal. Same board, two grammars.
5. **The previous attempt left the sink with no caller.** `POST /api/v1/workspace/analytics/events`
   exists and works (`packages/cezar/src/server/workspace-analytics-routes.ts`,
   `packages/cezar/src/workspace/analytics-log.ts`, `packages/contract/src/analytics.ts`, mounted
   at `server.ts:56` and `:7386`), and nothing in the tree calls it: `grep -rn 'trackEvent('
   packages/web/src` and `grep -rn 'postAnalyticsEvents' packages/web/src` both return zero lines.
   `todo.detail_opened` has never been emitted.

## The scope decision

**This is the one open question the brief asked the spec step to settle, and it is settled here in
favour of the broader scope: every filed row navigates, and `FiledDetailDialog` is deleted.**

Two todos describe this same feature and disagree:

| todo | filed | priority | scope |
| --- | --- | --- | --- |
| `12dc1ac0-a989-43bd-b012-711f85bb7b01` | 2026-08-26T09:34 | medium | Archived view, Done rows only. Every other filed row keeps the dialog. |
| `33bee966-0a0e-4e63-8c02-74df06c48cda` | 2026-08-29T12:30 | **high** | "Clicking any filed task title or card, including an archived Done task, navigates ... no FiledDetailDialog opens." |

Both were read directly out of `/var/lib/cezar/loki-labs/cezar/.ai/cezar/todos.json` (there is no
`cezar todo show` subcommand; `cezar todo` supports `add`, `start`, `list` only). This task's own
`CEZ_HANDOFF` context and acceptance criterion are **verbatim** `12dc1ac0`, so the run was
dispatched from the narrower todo. `33bee966` states in its own context that `12dc1ac0` "must be
treated as superseded by this clearer task, not implemented alongside it".

The broader scope wins, for four reasons, stated so the next session does not have to re-derive
them:

1. **It is the later instruction from the same owner, at higher priority, and it explicitly names
   the earlier one as superseded.** Choosing the older todo means knowingly shipping against a
   three-hour-newer correction and leaving a high-priority todo open on the board this very
   feature renders.
2. **It is a strict superset.** Every acceptance criterion of `12dc1ac0`, which is this task's own
   acceptance criterion word for word, is satisfied by the broader implementation: an Archived-view
   Done title navigates to a project-scoped full-detail URL, renders all stored detail and actions
   without a modal, and survives direct load and refresh. Nothing in this task's stated deliverable
   is dropped, narrowed or transformed. What is added is that the same is true of every other row.
3. **The 2026-08-26 objection does not survive scrutiny.** That spec reversed its own first draft
   on the grounds that deleting the dialog "would un-answer" the owner's 2026-08-17 complaint ("I
   can't open task to see details or to archive it") for rows that request never mentioned. It
   would not. The page renders the same content component, offers the same two actions, and adds
   an address. The complaint stays answered for every row; only the container changes, and it
   changes to the better one. The 2026-08-26 reasoning was sound as caution and is wrong as fact.
4. **Two containers for one record is exactly the hedge this repo's doctrine forbids.** The
   2026-08-26 spec's own Risk 5 is "two containers for one record could drift", mitigated by care
   and a guard test. Deleting the dialog removes the risk instead of managing it, and removes the
   guard test with it.

**What this costs, stated rather than glossed:** an Active-view triage session now leaves the
board to read a task. That cost is real and is carried in Risk 5 below with its mitigation.

**Todo bookkeeping when this ships:** `12dc1ac0` is subsumed, not abandoned, and closes as done
alongside `33bee966`. Neither is silently closed: Phase 6 records both with a note naming this
spec.

**Analytics field reconciliation.** The 2026-08-26 spec's event carried
`{project, status, archived, source}` with `source: 'board' | 'direct'`. `33bee966` asks for
`{project id, todo id, status, archived state, entry surface}`. They are reconciled into one prop
set of five in "Analytics" below: `todo` is added, and `surface` replaces `source` because
`surface: 'direct'` carries exactly the fact `source: 'direct'` carried while `'table'` and
`'card'` refine what `'board'` used to flatten. One prop, so the two can never disagree about
where a visit came from.

## Solution

### The route

`/p/:projectId/todos/:todoId`, registered inside the `/p/:projectId` `ProjectScopeRoute` layout
(`routes.tsx:502`), beside the `tasks/:id` family at `routes.tsx:507-513`.

**`todos/`, not `tasks/filed/`.** Todo ids and run ids are different id spaces, and the server
already spells this one `/api/v1/p/:projectId/todos/:id` (`server.ts:6395`, `:6425`). Mirroring the
API's own segment keeps one vocabulary for one id, and it cannot rank-compete with the `tasks/*`
family at all (different first segment), whereas `tasks/filed/:id` would sit in the same family as
`tasks/:id/changes` and depend on React Router's static-over-dynamic ranking to stay unambiguous.
The segment is free: `grep -n "todos" packages/web/src/routes.tsx` returns nothing today.

**Project scope is structural, from the URL.** `:projectId` is the authority for which project's
todo is shown, and the page passes it explicitly to every mutation, the same discipline
`startWorkspaceTodo` (`client.ts:1674`) and `updateWorkspaceTodo` (`client.ts:1702`) already
follow. Their doc comments say why in as many words: the workspace board lists todos from every
project at once, so reusing the scope-derived variant would act on whatever project you happened
to be looking at.

### Where the page's data comes from: no new read endpoint

The page reads `useWorkspaceTodos()` (`queries.ts:2480`, `GET /workspace/todos`, query key
`workspaceQueryKeys.workspaceTodos`) and selects the entry whose
`entry.project === projectId && entry.todo.id === todoId`. `workspaceTodoEntrySchema` carries
`project` alongside the todo (`packages/contract/src/workspace-todos.ts:31-34`), so the pair is
directly matchable.

Four properties follow from picking the query the board already uses:

- **Refresh and direct load work by construction.** The page depends on the URL and a query, not on
  navigation state. The server returns the SPA shell for any non-`/api` GET, so a cold load mounts
  the page, which fetches the same list. This is the mechanism `task-thread.tsx` already relies on.
- **Click-through is instant.** Arriving from `/tasks` the cache is warm, so no second fetch and no
  loading flash.
- **Archive/Restore is optimistic for free.** The moved `useUpdateFiledTodo` patches
  `workspaceQueryKeys.workspaceTodos` in `onMutate`, keyed on the `(project, id)` pair
  (`global-tasks.tsx:1560-1592`). The page reads that same key, so the status pill updates with no
  new cache plumbing.
- **The route is never flag-gated off.** `GET /workspace/todos` answers with the real todos
  regardless of `CEZ_FOLLOWUPS` / `CEZ_WORKSPACE_VIEWS` and never 404s;
  `useWorkspaceTodos` takes no `enabled` gate for the same reason, and says so at
  `queries.ts:2469-2478`.

**Alternative considered and rejected: adding `GET /api/v1/p/:projectId/todos/:id`.** Tidier
looking (honest 404, one record on the wire) and additive, so `BACKWARD_COMPATIBILITY.md`'s general
rule permits it. Rejected because cezar is a published CLI whose HTTP API is a protected surface
(`BACKWARD_COMPATIBILITY.md` §2): a route added here is permanent, must be hand-listed in the §2
inventory, and is enforced by `packages/cezar/src/server/bc-route-inventory.test.ts`. Minting a
permanent public endpoint to render one page, for data already on the wire on the page you
navigated from, buys a payload saving the board already pays on every `/tasks` load. Not-found is
derived instead, and derived carefully: see the five branches in Data models, which separate a
failed request and an unreadable project from a genuinely absent task.

### One content component, one container

New file `packages/web/src/components/filed-task-detail.tsx`, following
`components/skill-detail.tsx`'s pattern of a neutral content component in a shared module. It
exports:

- **`FiledTaskDetailContent`**: today's `FiledDetailBody` (`global-tasks.tsx:1382-1502`, its
  content half ending where the action div opens at `:1480`), moved,
  with three additions and two substitutions (below). All four existing `data-slot` hooks are
  preserved verbatim (`filed-task-context`, `filed-task-what-to-do`,
  `filed-task-acceptance-criteria`, `filed-task-knowledge-refs`), so existing assertions keep
  working against the new container.
- **`FiledTaskActions`**: the Start and Archive/Restore pair from `global-tasks.tsx:1480-1500`,
  with its `data-action` attributes carried over unchanged (`filed-task-detail-start`,
  `filed-task-detail-archive`, `filed-task-detail-restore`).
- **`FiledStatusPill`** and **`FiledPriorityChip`** (`global-tasks.tsx:1083`, `:1089`). They have to
  move: leaving them behind would make the shared module import the route module that imports it
  back.
- **`FILED_STATUS_LABEL`** and **`FILED_PRIORITY_LABEL`** (`global-tasks.tsx:680`, `:693`), which
  the board's Filed status and priority filter controls read a second time (`:1002`, `:1015`) and
  which stay in `global-tasks.tsx` only as imports. `FILED_STATUS_TONE` (`:686`) moves too but
  stays unexported: its only consumer is `FiledStatusPill`.

**Why the maps move rather than staying put.** All three are file-local `const`s with no `export`,
so moving only the components does not compile, and two of the three have a consumer that is not
moving. Leaving them behind gives exactly two bad outcomes: the shared module imports them back out
of a **route** module (the cycle this extraction exists to avoid), or they get duplicated and the
detail pill and the filter chip drift apart, one status renamed in one place. Moving them and
exporting the two with a second consumer gives one definition each, which
`grep -rc 'const FILED_STATUS_LABEL' packages/web/src` returning `1` states as a checkable fact.

**The `DialogTitle` substitution.** `FiledDetailBody` renders its title through
`DialogTitle`/`DialogDescription` (`global-tasks.tsx:1401-1404`), components that throw outside a
`Dialog`. With the dialog gone there is no `Dialog` anywhere in this path, so the content renders a
plain `<h1>` and the `sr-only` `DialogDescription` disappears with its container. Nothing replaces
it: a page's own heading is its accessible name.

**Level 1, not 2, and that is load-bearing.** `routes.test.tsx`'s `ROUTE_CASES` table asserts
`screen.getByRole('heading', { level: 1 }).textContent` for every route in the map (`:259-262`), so
the registration test in Verification step 1 only exists if this page's heading is an `<h1>`, in
every one of its five states. During Phase 1 the `<h1>` sits inside the still-present dialog
alongside that wrapper's own `sr-only` `DialogTitle`, which is harmless and temporary: Phase 3
deletes the wrapper.

**Three additions, all required by `33bee966`'s field-completeness criterion** ("the page must not
collapse this content into a Notes-only section"), and each already solved elsewhere in the tree:

- **Author.** `<AuthorCell author={todo.author} />` from `components/author-cell.tsx:50`, inside a
  `data-slot="filed-task-author"` wrapper. It renders bare, with no provider: it mounts its own
  `TooltipProvider` (corrected 2026-08-22 in its own docblock, after a missing ancestor provider
  white-screened the cockpit), and `TaskLocationProvider` is optional, an absent one yielding an
  unlinked parent id rather than a wrong link. `routes/task-thread/run-header.tsx:610` already
  renders it bare for exactly this reason. `author` is on `todoItemSchema`
  (`packages/contract/src/skills.ts`, `author: taskAuthorSchema.optional()`), server-stamped and
  never client-settable, and absent on any entry filed before 2026-08-21, which `AuthorCell`
  already renders as the unattributed label.
- **Archived state.** A `data-slot="filed-task-archived"` element rendered only when
  `todo.archivedAt !== undefined`, reading `Archived <localised date>`. The body already computes
  this boolean at `global-tasks.tsx:1398` and spends it only on the button label. The distinction
  matters and is the reason it is displayed rather than inferred: `matchesFiledView`
  (`lib/filed-tasks.ts:86-89`) puts a row under Archived when it is archived **or** done, so a
  `done` row with no stamp is on the Archived board while carrying no archived state, and
  `FiledRow`'s own comment at `:1127-1130` turns on exactly that difference.
- **Node metadata, ungated.** This is the second substitution. The body being moved renders its
  node cell behind the roster flag (`{nodeRoster.clusterOn ? <TaskNodeCell … /> : null}`,
  `global-tasks.tsx:1418`); the page drops that gate and renders `TaskNodeCell` whenever the entry
  actually carries a node, i.e. whenever `todo.startedOn` or `todo.placement?.node` is set,
  whatever `capabilities.cluster` currently says. The criterion is that every stored field the
  record carries is shown, and a todo carrying a `startedOn` on a cockpit whose clustering has
  since been switched off is precisely the case the flag hides: the field is in `todos.json`, the
  page is the place you go to read what is stored, and a gate on an unrelated capability makes it
  invisible. Safe because `resolveTaskNode` (`lib/task-node.ts:57-70`) needs no roster to answer
  honestly: with `useClusterOverview(false)` never fetching, `nodes` is `[]` and `selfNodeId` is
  `undefined`, so a set node id falls to the function's last branch and returns
  `{kind: 'unknown', nodeId}`, which `taskNodeLabel` renders as `unknown node (<id>)` over a
  "Pinned to / Running on a node not on the current roster" tooltip. That is the id itself, never
  a blank and never a guessed "this node", which the function's own docblock forbids in as many
  words. A todo with neither field resolves to `undefined`, and the page then renders **nothing**
  rather than `TaskNodeCell`'s dash, so a single-node cockpit (every todo in production carries
  `startedOn: null`, measured 2026-08-24 and recorded in that docblock) gains no new empty cell.
  The BOARD keeps its `clusterOn` column gate untouched: a whole column of dashes across every row
  is a different judgement from one page showing one field it holds.

### The board after the change

`FiledRow` and `FiledCard` render the title as a `<Link>` instead of a `<button>`, keeping
`data-slot="filed-task-title"` so every existing selector and the e2e harness keep resolving:

```tsx
<Link
  to={scopeTo(entry.project, `/todos/${entry.todo.id}`)}
  state={{ from: { pathname: '/tasks', search, surface: 'table' } }}   // 'card' in FiledCard
  data-slot="filed-task-title"
  title={entry.todo.summary}
  className={/* unchanged */}
>
  {entry.todo.summary}
</Link>
```

`scopeTo` is `lib/project-router.tsx:65`, already imported and already used by both components for
the project link. `search` is the board's own `location.search`, so every URL-backed filter comes
back with the user (Risk 1).

Deleted in the same phase, none of it replaced: `FiledDetailDialog` (`global-tasks.tsx:1347`),
`FiledDetailBody` (`:1382`, moved not deleted), the `detail` state (`:755`), the `onOpenDetail`
prop on both components (`:1107`, `:1118`, `:1241`, `:1252`) and both call sites (`:870`, `:925`),
and the dialog render (`:952`). The `Dialog` imports go with them if nothing else in the file uses
them.

**Not a compatibility question.** There is no old shape kept alive beside a new one; there is one
container where there were two, which is the direction this repo's doctrine points.

### Actions on the page

The same set the dialog's footer offers today, Start and Archive/Restore, since "preserve available
task actions" is read as identical rather than narrowed.

They cannot be reused where they are. `useStartFiledTask` (`global-tasks.tsx:1506`) and
`useUpdateFiledTodo` (`:1560`) are file-local, neither carries `export`, and importing them from a
route module into another route module would create a cycle once the board links at the page. Both
move to `packages/web/src/api/filed-task-mutations.ts`, and `global-tasks.tsx` imports them back:

| moves | stays in `global-tasks.tsx` |
| --- | --- |
| `useStartFiledTask` (single task) | `useStartFiledTasks` (the bulk selection mutation, `:1522`) |
| `useUpdateFiledTodo` (single task) | every runs-table mutation (`useArchiveIndexedRun` and friends) |

Both already take an explicit project, so the page passes `:projectId` from the URL and inherits
the discipline unchanged. `applyFiledPatch`, the optimistic patch's helper, already lives in the
neutral `lib/filed-tasks.ts:194` and moves nowhere.

Start on an already-Done entry stays available, deliberately. It is semantically odd, the dialog
offers it today, the server permits it (`POST /todos/:id/start` 409s only on `startedTaskId`,
`server.ts:6436`), and re-running a finished task is a real thing to want. Narrowing it would be a
behaviour change nobody asked for in a change whose job is parity. `useStartFiledTask` navigates to
the new run on success (`scopeTo(projectId, '/tasks/<id>')`), so Start leaves the page;
Archive/Restore stays on it with the pill updating optimistically.

## Architecture

```
/tasks?archived=1&fstatus=...   (unscoped, GlobalTasksRoute; filters and view are URL state)
  └── FiledTasks ── FiledRow (desktop) / FiledCard (mobile)
        title = <Link to={scopeTo(project, `/todos/${id}`)}
                      state={{from:{pathname:'/tasks', search, surface:'table'|'card'}}}>
                                        │
                                        ▼
/p/:projectId/todos/:todoId   (inside ProjectScopeRoute, routes.tsx:502)
  └── FiledTaskDetailRoute
        ├── useParams()                → projectId, todoId   (the authority for scope)
        ├── useWorkspaceTodos()        → ['workspace','todos']   same key the board reads
        │     └── select (project,id)  → loading | found | error | project-unavailable | not-found
        ├── useLocation().state        → validated back target + surface; else '/tasks' + 'direct'
        ├── trackEvent('todo.detail_opened')  → POST /api/v1/workspace/analytics/events (202)
        └── useStartFiledTask / useUpdateFiledTodo   ← api/filed-task-mutations.ts

packages/web/src/components/filed-task-detail.tsx    the ONE content module
  ├── FiledTaskDetailContent   summary, status, priority, project, author, filed, archived,
  │                            node, context, what to do, acceptance criteria, knowledge refs
  ├── FiledTaskActions         Start · Archive/Restore
  ├── FiledStatusPill · FiledPriorityChip
  └── FILED_STATUS_LABEL · FILED_PRIORITY_LABEL   (re-imported by the board's filter controls)

POST /api/v1/workspace/analytics/events            ALREADY SHIPPED (abe83105)
  └── server/workspace-analytics-routes.ts → workspace/analytics-log.ts
        └── append one line to <CEZ_HOME>/analytics/events.ndjson   (0600, fail-open, rotating)
```

Unchanged: todos stay per-project `.ai/cezar/todos.json`; the workspace board stays a read-only
aggregation; writes stay on the existing project-scoped `PATCH` and `POST .../start`. The analytics
log is a file in the per-user home and touches no project state.

**Upstream purity.** Nothing in the new code names this workspace's products, projects or corpus. A
todo detail page is generic cockpit surface, same as the table it came from.

## Phases

Each phase is shippable on its own and leaves the cockpit working. The ordering rule: **no phase
removes a way in before the way in that replaces it is finished.** Phase 3 is the only phase that
deletes anything, and it runs after Phase 2 has put the page at its URL.

**Phase 1: extract the shared modules. No behaviour change at all.**
Move `FiledDetailBody` to `FiledTaskDetailContent`, its action pair to `FiledTaskActions`,
`FiledStatusPill`, `FiledPriorityChip` and the three label maps into
`packages/web/src/components/filed-task-detail.tsx`. Swap the content's
`DialogTitle`/`DialogDescription` for a plain `<h1>` and keep the `sr-only` pair inside the
still-present `FiledDetailDialog` wrapper, which stays in `global-tasks.tsx` for this phase only.
Move `useStartFiledTask` and `useUpdateFiledTodo` into
`packages/web/src/api/filed-task-mutations.ts`. `global-tasks.tsx` imports all of it back. Proof
this phase changed nothing: `packages/web/src/routes/global-tasks.test.tsx`'s
"opens the detail dialog and renders only the sections the entry actually carries" test
(`global-tasks.test.tsx:1684-1710`) passes **unchanged**.

**Phase 2: the page exists at its URL, complete, with actions.**
Add `packages/web/src/routes/filed-task-detail.tsx` exporting `FiledTaskDetailRoute`: read
`useParams()`, select from `useWorkspaceTodos()`, render all five states from Data models, render
`FiledTaskDetailContent` (with the author and archived-state additions) and `FiledTaskActions`
wired through the two moved hooks, and a header with a back link that falls back to `/tasks` (no
board change yet, so there is no return state to read). Register `todos/:todoId` in `routes.tsx`
under `ProjectScopeRoute`, lazily, like its run-backed neighbours. Add `/todos` to the Tasks nav
`match` list (`components/nav-items.ts:96`, currently `['/', '/tasks', '/compare']`). Carry
`data-slot="filed-task-detail"` onto the page root, the attribute the dialog's `DialogContent`
holds today (`global-tasks.tsx:1366`), so existing selectors keep resolving, **and
`data-route="filed-task-detail"` beside it**, which is what `routes.test.tsx`'s `routeName()`
reads. The board is untouched and still opens the dialog; the page is reachable by typing or
pasting the URL, and it is complete when it is reachable. Tests for this phase: the registration
rows in `routes.test.tsx` and `nav-items.test.ts` (Verification step 1, which is what proves the
`routes.tsx` and `match`-list edits above actually landed), then route-state, field-completeness
and action tests in the page's own file.

**Phase 3: the board navigates, and the dialog is deleted.**
`FiledRow` and `FiledCard` render `<Link>` titles carrying
`state={{from:{pathname:'/tasks', search, surface}}}`; the page's back link prefers that validated
state. Delete `FiledDetailDialog`, the `detail` state, both `onOpenDetail` props and both call
sites, and the dialog render. Update the board's own comments that describe the button
(`global-tasks.tsx:1100-1101`). Rewrite the existing dialog test as a navigation test: it becomes
the assertion that a click lands on the page and renders the same sections. Add the no-dialog
assertion and the mobile-card assertion.

**Phase 4: analytics, delivered, and the env var documented.**
`postAnalyticsEvents(events)` in `packages/web/src/api/client.ts` (the typed `hc` wrapper, spelled
like `updateWorkspaceTodo` at `client.ts:1702` but **without** `unwrap`'s throw on a non-2xx: this
one call site swallows); `packages/web/src/lib/analytics.ts` exporting `trackEvent`; the page's
once-per-resolved-task effect. Ships after the page because the page is already correct without it.
The documentation this drags in lands in the same commit: `.env.example`, the README env table
(`README.md:567` is the `CEZ_AUTOMATIONS` row this one sits beside) and the
`BACKWARD_COMPATIBILITY.md` §1 env-var list (`BACKWARD_COMPATIBILITY.md:14`). See "Documentation
debt" below for why this is repayment of an existing bug, not new work.

**Phase 5: verification.** New e2e spec, gates, and the recorded production run, whose
`walkthrough.mp4` this box cannot produce and which therefore either arrives from a capture-capable
run before the commit or is carried as a named post-deploy QA blocker. Section below.

**Phase 6: the record, in the same session as the code.** Three corpus writes, proposed through
`CEZ_KB_WRITE_FILE` (`.ai/cezar/runs/<taskId>.knowledge.ndjson`), never by editing a mounted corpus
document by hand, **plus a fourth item that is not a corpus write at all**: the tracker sync. The
earlier draft of this spec said all four went through `CEZ_KB_WRITE_FILE`, and that is false. A KB
proposal writes documents; it cannot change a todo's status, which lives in `todos.json` behind its
own route. Item 4 below is separated for that reason and carries its own mechanism and its own
completion test.

1. **Upsert a current decision note** stating the behaviour without halves: every filed task, in
   both views and at every status, opens as a project-scoped page at `/p/:projectId/todos/:todoId`,
   and `FiledDetailDialog` no longer exists. Name the route, the shared
   `components/filed-task-detail.tsx` extraction, the `todo.detail_opened` event with its five
   props, its `<CEZ_HOME>/analytics/events.ndjson` sink, its relationship to the run-scoped
   `metric` events, the `CEZ_ANALYTICS=0` opt-out, and this spec's path.
2. **Supersede `notion-7bb302edff13`**
   (`notion-export/tasks/local-2026-08-17-filed-tasks-table-statuses.md`), whose detail-dialog
   sentence is the first thing a reader finds and is now false. A `supersede` op naming the new
   note as `by`, with a dated lead-in saying the dialog is gone and the same content is a page.
   The original text stays below it, unchanged. `cez kb show notion-7bb302edff13` returns the
   unmarked 2026-08-17 text today: the 2026-08-26 spec's Phase 6 specified this write and never
   performed it, so it is outstanding twice over.
3. **A changelog entry** in the corpus changelog, following the existing
   `notion-export/changelog/<date>-<slug>--local.md` convention, Type `Changed`, Area `Cezar`.
4. **Resolve both todos. Tracker mutation, not a KB proposal, and not something this run can
   execute.** `33bee966-0a0e-4e63-8c02-74df06c48cda` and `12dc1ac0-a989-43bd-b012-711f85bb7b01`
   both need `status: 'done'`. Three facts decide how, all measured on this box on 2026-08-29:

   - **The only writer is the HTTP route.** `PATCH /api/v1/p/:projectId/todos/:id`
     (`server.ts:6395`), body `updateTodoInputSchema` (`packages/contract/src/skills.ts:205-215`),
     which carries `status`, `priority` and `archived` **and nothing else**. There is no note
     field, so the "subsumed rather than dropped" sentence the earlier draft promised to attach to
     `12dc1ac0` has nowhere on the record to live. It goes into the KB decision note (write 1) and
     the changelog entry (write 3) instead, both of which name both todo ids explicitly so the
     subsumption is findable from either end.
   - **The CLI cannot do it.** `cezar todo` accepts exactly `add`, `list` and `start`
     (`KNOWN_SUBCOMMANDS`, `packages/cezar/src/todo-cli.ts:49`); none of the three sets a status,
     and `start` only stamps `startedTaskId`/`autostart`. Nothing else in the tree marks a todo
     done either: a run finishing does not resolve the todo it came from
     (`grep -rn "startedTaskId" packages/cezar/src` finds `markStarted` and the cancel path, no
     completion path).
   - **An unauthenticated loopback PATCH will not land on production.** The server binds
     `127.0.0.1:4321`; measured 2026-08-29, `GET /api/v1/health` there answers **200** while
     `GET /api/v1/workspace/todos` answers **401**. The todo routes sit behind the same wall.

   So the executable mechanism is **a signed-in person**: mark both entries Done from the
   cockpit's Filed table (the same PATCH, carrying a session), or PATCH with a session cookie.
   Whoever does it verifies the result with the command below, which is this item's completion
   test:

   ```bash
   cezar todo list --project cezar --json \
     | jq -r '.todos[] | select(.id|startswith("33bee966") or startswith("12dc1ac0")) | "\(.id) \(.status)"'
   # want both ids printing `done`
   ```

   Measured 2026-08-29, before any of this work: both print `todo`. **Until that command prints
   `done` twice, this item is PENDING and must be reported as pending** in the handoff and the
   final message, never folded into a "record synced" claim. Filing the request is the agent's
   part; flipping the status is the owner's.

A KB proposal (writes 1 to 3) is reviewed and applied later, through the cockpit or
`cez kb proposals`, never automatically. The corpus half of this phase is complete only when the
**applied** record is findable:

```bash
cd /var/lib/cezar/loki-labs && CEZ_KB=1 cez kb reindex
cez kb search "filed task detail page"
grep -ac "filed-task-detail-page" \
  /var/lib/cezar/loki-labs/.ai/cezar/knowledge-index/catalog.ndjson   # want 1
```

Grep the slug or the path, never the document's prose: the catalog stores an `excerpt`, so a
phrase-grep returns `0` even for a correctly indexed document. The reindex is not ceremony: the
`loki-labs` project holds the corpus and nothing keeps a `KnowledgeStore` open for it, so its
watcher never fires, and the failure is silent in both directions.

## Data models

**The todo record does not change.** `todoItemSchema` (`packages/contract/src/skills.ts:73-157`)
and `workspaceTodoEntrySchema` (`packages/contract/src/workspace-todos.ts:31-34`) are read exactly
as they are. Nothing about the page is persisted onto the todo: no `viewedAt`, no `openedAt`.
Adding a stamp would mean a write on every read, on a record whose `todos.lock` every other writer
shares, to serve a display change. The analytics event is a separate append-only file and never
touches `todos.json`.

### The page's derived state

Derived, not stored, and it needs five branches. `useWorkspaceTodos()` is a plain `useQuery` with
no `enabled` gate (`queries.ts:2480-2485`), so it has a real failure mode, and the response carries
a per-project health array (`workspaceTodosResponseSchema.projects`, `workspace-todos.ts:36-41`,
rows of `{id, name, status, ok, reason?, total}`) precisely because a registered project can be
missing, not-git or no-commits and contribute no todos at all.

```ts
type FiledTaskDetail =
  | { state: 'loading' }
  | { state: 'found'; entry: WorkspaceTodoEntry }
  | { state: 'error'; message: string }                                   // the GET itself failed
  | { state: 'project-unavailable'; projectId: string; reason?: string }  // health row, ok === false
  | { state: 'not-found'; projectId: string; todoId: string }
```

Resolution is an **order**, not a set of independent checks:

1. `query.isPending` to `loading`. `not-found` is only reachable once the query has settled, or a
   cold direct load flashes "no such task" before its own data arrives.
2. `query.isError` to `error`, rendering the query's message plus a retry. Without this branch a
   settled but failed request falls to the final `else` and a transport failure is rendered as
   "this task does not exist", which is the one branch that lies.
3. a matching `(project, id)` pair to `found`.
4. no match, and `projects.find(p => p.id === projectId)?.ok === false` to `project-unavailable`,
   naming the health row's `reason`. The todo may well exist; this cockpit could not read the
   project it lives in.
5. otherwise `not-found`: a successful, healthy response that genuinely has no such pair. This is
   also what a real cross-project mismatch renders (`/p/a/todos/<id-that-lives-in-b>`), which is
   the scope assertion in Verification.

Each of the five gets its own test.

### The back-link state

Caller-supplied history state, so it is validated before it is used:

```ts
type FiledDetailFrom = { pathname: '/tasks'; search: string; surface: 'table' | 'card' }
```

`validFrom(state)` accepts it only when `pathname === '/tasks'` exactly, `search` is a string that
is empty or starts with `?`, and `surface` is one of the two literals. Anything else, including a
direct load with no state at all, yields `undefined`: the back target falls back to `/tasks` and
the event's `surface` becomes `'direct'`. An unvalidated pathname out of history state is an in-app
open redirect, and this is the cheap way to not have one.

## API contracts

### Three existing routes, unchanged

Rendering the page adds no route. All three are already in the `BACKWARD_COMPATIBILITY.md` §2
inventory:

| route | used for | source |
| --- | --- | --- |
| `GET /api/v1/workspace/todos` | hydrate the page (the board's own query key) | `workspace-todos-routes.ts:55`, mounted `server.ts:7380`; `queries.ts:2480` |
| `PATCH /api/v1/p/:projectId/todos/:id` | Archive / Restore | `server.ts:6395`, `client.ts:1702` |
| `POST /api/v1/p/:projectId/todos/:id/start` | Start | `server.ts:6425`, `client.ts:1674` |

### One route that already exists, and now gets its caller

`POST /api/v1/workspace/analytics/events` shipped in `abe83105`. Verified present and mounted:
`server.ts:56` imports `createWorkspaceAnalyticsRoutes`, `server.ts:7386` mounts it. Its contract,
from `packages/contract/src/analytics.ts` as shipped:

```
POST /api/v1/workspace/analytics/events
  body    analyticsEventsRequestSchema   {events: [{name, props}]}, 1..20 events
  202     {accepted: n}                  the normal answer: accepted, not yet fsynced
  400     the standard zod error body    a malformed name or props shape
```

`name` matches `/^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/`, max 64. `props` is a flat record of at
most 16 scalar values, string values capped at 200 characters. The server stamps `ts` and `v: 1`
itself; the client cannot set either. The route is fail-open by contract: a sink that throws
synchronously or rejects cannot turn an accepted request into a failed one.

**Nothing about the route or the sink changes in this work.** No new schema, no new handler, no
§2 edit. `BACKWARD_COMPATIBILITY.md:78` already carries the route's inventory line, added
2026-08-29 in commit `a04cda25` after `bc-route-inventory.test.ts` had been red on `main` since
`abe83105`. That correction is done and is not this change's to make.

### Documentation debt this change repays

`CEZ_ANALYTICS` is live in the shipped sink (`analytics-log.ts`, `isAnalyticsDisabled`, exact
string `'0'` only) and appears in **none** of its three required documentation surfaces:
`grep -rn "CEZ_ANALYTICS" .env.example README.md BACKWARD_COMPATIBILITY.md` returns zero lines.
`AGENTS.md:31` is explicit that adding a `CEZ_*` env var must update `.env.example` in the same
commit, and the README env table when the var is user-facing, and that an undocumented env var is a
bug. It has been outstanding since `abe83105`. Phase 4 closes it, in the commit that finally gives
the variable a user-visible effect:

- **`.env.example`**: a commented-out entry in that file's house style (a section comment, a short
  paragraph, then `# CEZ_ANALYTICS=0`), spelled like the `CEZ_AUTOMATIONS` entry at
  `.env.example:194`.
- **The README "Useful environment variables" table**: one row beside `CEZ_AUTOMATIONS`
  (`README.md:567`).
- **The `BACKWARD_COMPATIBILITY.md` §1 env-var list** (`BACKWARD_COMPATIBILITY.md:14`), which
  enumerates every `CEZ_*` name and is where a later rename or removal has to be justified.

All three say the same thing in the same words: analytics is **on by default**, the sink is a plain
file on the user's own disk that leaves the machine never, and **only the exact value
`CEZ_ANALYTICS=0` turns it off**. `false`, `off` and an empty `CEZ_ANALYTICS=` do not, the same
exact-value discipline every other switch in §1 uses. With it off the route still answers 202 (a
client must not have to care whether the operator kept the log) and the sink drops the line.

## Analytics

**What exists already.** cezar persists `type: 'metric'` events onto a run's own NDJSON through
`RunStore.appendEvent()`: `run.workflow.selected`, `run.step.stopped`,
`run.step.resumed_after_stop`, `run.step.retried_cold_broker`, `run.step.runner_downgraded`, each
with its own test. `.ai/specs/2026-08-24-codex-only-default-workflow.md` names that mechanism as
the analytics surface in as many words. What that mechanism cannot carry is this event: **a filed
task has no run**, so there is no `runs/<id>.ndjson` for the line to go on, and opening a filed
task's page is precisely the thing that happens when no run exists. The workspace log is a
companion to the run-scoped mechanism, not a replacement and not a competing second one.

**No SDK, and that is not a compromise.** `AGENTS.md` says everything is local: no accounts, no
database, no cloud, with state as plain JSON, NDJSON and Markdown. A hosted analytics SDK would
ship a person's workspace activity to a third party from a tool whose entire premise is that it
does not.

### The event

`todo.detail_opened`, in the `noun.verb_past` grammar the existing metrics and the two orphan
`TODO(analytics)` markers (`todo-cli.ts:212`, `reopen-watch.ts:67`) already use:

| prop | value | source |
| --- | --- | --- |
| `project` | the registry slug | `:projectId` from the URL, never the entry: the URL is the scope authority |
| `todo` | the todo id | `:todoId` from the URL. A uuid, 36 chars, well inside the 200-char cap |
| `status` | `todo` / `in-progress` / `blocked` / `done` | `filedStatus(entry)` (`lib/filed-tasks.ts:66`) |
| `archived` | boolean | `entry.todo.archivedAt !== undefined`, the stamp, not the view |
| `surface` | `table` / `card` / `direct` | the validated `state.from.surface`, or `direct` when there is no valid state |

Five props, all scalar, none of them free text: no summary, no context, no body. That is enforced
by the shipped `props` schema, not only by this table.

**`surface` replaces the 2026-08-26 spec's `source`, and answers `33bee966`'s "entry surface" in
the same prop.** `direct` carries exactly what `source: 'direct'` carried, a history entry with no
in-app router state: a pasted URL, a bookmark, a typed address, or a link followed from outside the
app. `table` and `card` refine what `source: 'board'` flattened, and answer which of the two board
entry points was clicked. One prop derived from the same validated `state.from` the back link uses,
so the two can never disagree about where a visit came from.

**A refresh is `table`/`card`, not `direct`.** The history entry's `state` is serialized into
session history by `pushState`, and a reload restores the same entry, so `location.state` survives
F5, cmd-R and a restored tab. That is the honest reading of the measurement: the question is which
surface created this history entry, and a reload of that entry does not change the answer. If "was
this a reload" is ever wanted it is a separate prop from a separate mechanism
(`performance.getEntriesByType('navigation')[0].type === 'reload'`), deliberately not built here.
Verification splits the two checks apart accordingly.

**Emitted once, after the entry resolves.** The effect runs only in the `found` state (an event for
a task that turned out not to exist measures nothing) and de-duplicates on a ref keyed by
`${projectId}:${todoId}`:

```ts
const emitted = React.useRef<string | null>(null)
React.useEffect(() => {
  if (detail.state !== 'found') return
  const key = `${projectId}:${todoId}`
  if (emitted.current === key) return
  emitted.current = key
  trackEvent('todo.detail_opened', { project: projectId, todo: todoId, status, archived, surface })
}, [detail.state, projectId, todoId, status, archived, surface])
```

The ref, not the dependency array, is what makes it once: React StrictMode mounts an effect twice
in development, and an optimistic Archive re-renders `found` with a new `archived` value. Both
would otherwise double-count. Navigating to a different task changes the key and emits again, which
is correct.

### The client half

`packages/web/src/lib/analytics.ts` exports `trackEvent(name, props)`: build the event, call
`postAnalyticsEvents([event])`, `.catch(() => {})`. **Fail-open and silent**: no toast, no retry,
no queue. An analytics failure must never be a thing the user is told about, and must never block
the render it describes; the page is on screen by the time this fires.

## Risks

1. **The back link must not be scoped, and must not throw away the board's URL state.** Two traps
   in one link. *Scoping*: `Link` from `lib/project-router.tsx` prefixes any `/`-leading target
   (`scopePathname`), so `<Link to="/tasks">` on a page under `/p/x/` emits `/p/x/tasks`, which
   matches no child of `ProjectScopeRoute` (`tasks/:id` needs a second segment) and falls to
   `NotFoundRoute`. The back link uses the raw `react-router` `Link`/`useNavigate`, which is what
   `global-tasks.tsx:16` itself does (it imports `Link` from `react-router` and applies `scopeTo`
   by hand at each call site). *State*: a back link hard-coded to `/tasks` returns to the Active
   view with every filter cleared, because view and filters are URL state
   (`archived=1` present-or-absent; `fstatus` / `fpriority` / `fsort` from
   `FILED_SEARCH_PARAMS`, `lib/filed-tasks.ts:227`). So the board's link carries its own
   `location.search` forward and the page resolves its back target as
   `validFrom(location.state) ?? '/tasks'`.
2. **The Tasks nav item goes inactive without a match entry.** `nav-items.ts:96` matches
   `['/', '/tasks', '/compare']`; a `/todos/:id` page matches none, so the sidebar would
   de-highlight Tasks while reading a task. Phase 2 adds `/todos` to that list.
3. **A flat `/todos/:id` paste lands in the wrong project.** `LegacyPathRedirect` sends any
   unmatched flat path to `/p/<boot>/...`, so an unscoped todo URL resolves against the boot
   project and renders not-found for another project's todo. Accepted: every link the cockpit emits
   is scoped, and this is the existing behaviour of every flat path. The not-found state names the
   project and the id so the failure is legible rather than blank.
4. **Cold direct load fetches the whole workspace todo list** to render one entry. Accepted and
   bounded: `/tasks` already pays exactly this on every load, so the page adds no new worst case,
   and the warm-cache click-through path pays nothing.
5. **The cost of the broad scope: Active-view triage now leaves the board, and two pieces of local
   state do not survive the round trip.** `selected` (`global-tasks.tsx:757`, the bulk-selection
   set) and `shown` (`:756`, the pagination cursor, `FILED_ROW_PAGE_SIZE = 100`) are React state,
   not URL state, so opening a task and coming back resets a multi-row selection and collapses a
   scrolled-past-100 list. This is the real price of deleting the modal and it is named rather than
   glossed. Accepted, with three mitigations, none of which is new code: the row keeps its own
   checkbox, Start and Archive/Restore controls, so triage never has to open the detail view at
   all; the back link restores every URL-backed filter, sort and view; and Back is a real browser
   Back, because the board writes its own filter changes with `replace` while this navigation is a
   `push`. Promoting `selected`/`shown` into the URL is a separate change and is listed under Out
   of scope.
6. **Reversing a reasoned prior decision.** `.ai/specs/2026-08-26-filed-task-detail-page.md`
   deliberately kept the dialog for non-Done rows, after reversing its own first draft. This spec
   reverses that again, on the owner's 2026-08-29 restatement. If the owner in fact wanted the
   dialog kept for active rows, this is wrong. Mitigation is disclosure plus reversibility: the
   decision, its four reasons and its cost are written above and go into the KB note in Phase 6,
   and undoing it is one `detailHref`-shaped conditional at the two title call sites, since the
   content component is shared either way.
7. **Not-found must not flash on a cold load, and a failed request must not read as not-found.**
   Both are the resolution order in Data models: `isPending` before anything, `isError` before the
   match. Tests for both, and a fifth for the `project-unavailable` health row.
8. **A dropped analytics event is invisible by design.** Fail-open means a broken sink looks
   exactly like a working one from the page. Accepted (the alternative is a toast about telemetry)
   and bounded by the e2e assertion that lines actually land in `events.ndjson` under a pinned
   `CEZ_HOME`, plus the sink's own `console.warn`.
9. **The event writes to the operator's disk.** One line per opened task, carrying a project slug,
   a todo id, a status, a boolean and one enum: no summary, no context, no body, enforced by the
   shipped bounded `props` schema. `CEZ_ANALYTICS=0` turns it off, the file is `0600` in a `0700`
   directory, it rotates at 5 MB with one generation, and nothing ever leaves the machine.
10. **A todo id colliding across projects.** Two projects could theoretically share a uuid. The
    `(project, id)` pair is already the row key on the board and the key the optimistic cache patch
    uses. The page selects on the same pair, from the URL, so it inherits that discipline rather
    than re-deciding it.

## Verification

Gates are necessary, not sufficient: this is **QA Needed** until steps 8 and 9 have actually run
**and** step 9's video artifact exists. See step 9's "On 'recorded', and video" for why the video
is a blocker rather than a nicety, and what produces it.

1. **First, the URL map and the nav, in the REAL router.** The new page's own tests mount the
   route component directly, exactly as `global-tasks.test.tsx` mounts `GlobalTasksRoute` today.
   That proves the component and proves nothing about registration: a route added to `routes.tsx`
   under a mistyped path passes every component test in this repo and still 404s in the browser,
   and a cold pasted URL is half of this task's acceptance criterion. So the registration is
   asserted where the real router is exercised, in two existing files:

   - `packages/web/src/routes.test.tsx`, which renders the real `<AppRoutes/>` (`:13`, `:341`).
     Add a `ROUTE_CASES` row (`:222-253`) of the shape `['/todos/todo-1', 'filed-task-detail',
     'Loading task…']`: the harness renders it at `/p/${BOOT}/todos/todo-1` with `fetch` never
     answering and asserts `routeName()` (`:172`, the `data-route` attribute on the page root) and
     the `<h1>` its loading state renders. Two consequences for the page, both deliberate: it
     carries `data-route="filed-task-detail"` alongside the `data-slot` of the same name, and each
     of its five states renders an `<h1>`, matching every other route in that table. Add
     `'/todos'` (no id) to the same file's `unknown` list (`:290-297`), beside the bare `'/tasks'`
     already there, so an id-less URL lands on the 404 rather than on a page with no task.
   - `packages/web/src/components/nav-items.test.ts`: add `['/todos/abc123', '/']` to
     `activeNavPath`'s case table (`:8-42`), so Tasks stays lit on the new surface. This is the
     assertion behind Phase 2's one-line `match` change (`nav-items.ts:96`), and the table's
     existing `/tasks/abc123` and `/compare/grp-1` rows are the precedent for asserting it here
     rather than in a component test.

   Together these two prove what no component test can: a cold scoped URL reaches this route, and
   the Tasks nav item owns it.

2. **Route and state tests, new `packages/web/src/routes/filed-task-detail.test.tsx`:** a direct
   load at `/p/api/todos/todo-1` renders the summary, the status pill, the priority chip, the
   project link, the author cell, the filed date and every content section the entry carries; an
   entry with no `acceptanceCriteria` and no `knowledgeRefs` renders neither `data-slot` (the
   assertion moved from `global-tasks.test.tsx:1684-1710`). Then one test per derived state: query
   in flight to `loading` (never not-found); query rejected to `error` with the message and a retry
   (never not-found); a `projects` health row with `ok: false` for `:projectId` to
   `project-unavailable` naming its `reason`; a healthy response with an unknown `todoId` to
   `not-found`; a `todoId` that exists **in another project** to `not-found` (the scope assertion).
3. **Field-completeness tests, same file, one per field `33bee966` names**, since "must not
   collapse this content into a Notes-only section" is the criterion: an entry carrying `author`
   renders `[data-slot="filed-task-author"]` with the author's label, and an entry with no author
   renders the unattributed label rather than nothing; an entry with `archivedAt` renders
   `[data-slot="filed-task-archived"]`, and a `done` entry **without** `archivedAt` does not
   (the stamp-versus-view distinction). Then the node field, asserted **twice**, because the page
   drops the board's `clusterOn` gate (see "One content component, one container"): an entry with
   `startedOn` (or `placement.node`) renders `[data-slot="task-node"]` **with
   `capabilities.cluster` false**, carrying `data-node-kind="unknown"` and the label
   `unknown node (<id>)`, which is the honest answer `resolveTaskNode` gives with no roster
   fetched; the same entry with clustering on and a matching roster row renders
   `data-node-kind="known"` and the node's name. An entry with neither field renders no
   `[data-slot="task-node"]` element at all, clustering on or off, so the ungating adds no empty
   cell to the common case.
4. **Action tests, same file:** Start POSTs to the URL's project and navigates to the new run;
   Archive PATCHes `{archived: true}` and flips the pill optimistically; a rejected PATCH rolls the
   pill back and toasts the server's own words.
5. **Board tests, `packages/web/src/routes/global-tasks.test.tsx`:**
   - a **desktop row** title is an anchor whose href is `/p/<project>/todos/<id>`; clicking it
     navigates and the page renders the same sections. This replaces the current dialog test.
   - a **mobile card** title is an anchor with the same href (the shared-navigation-contract
     criterion; today both are buttons with identical `data-slot`s, so both need asserting).
   - **the no-dialog assertion:** after clicking any filed title, in either view, at any status,
     `screen.queryByRole('dialog')` is `null`, and
     `grep -rc 'FiledDetailDialog' packages/web/src` returns `0`.
   - a Done archived row's link carries `state.from = {pathname: '/tasks', search: '?archived=1',
     surface: 'table'}`, and the page's back link href is exactly `/tasks?archived=1`, never
     `/p/<project>/tasks` and never bare `/tasks` when the state is present.
   - with no `state`, the back link href is exactly `/tasks`.
   - a row's own checkbox, Start and Archive controls still work without navigating (Risk 5's
     mitigation, asserted rather than asserted-in-prose).
6. **Analytics tests:**
   - `packages/web/src/lib/analytics.test.ts`: `trackEvent` POSTs the built event once; a rejected
     POST resolves and throws nothing (fail-open) and toasts nothing.
   - `filed-task-detail.test.tsx`: exactly **one** POST for one resolved task across a StrictMode
     double-mount and an optimistic Archive re-render; **zero** POSTs while loading or in any
     non-`found` state; the body carries all five props with `project` and `todo` taken from the
     URL; `surface: 'table'` with a table-originated state, `'card'` with a card-originated one,
     `'direct'` with none; a state whose `pathname` is not `/tasks` is rejected by `validFrom` and
     yields `'direct'` plus the `/tasks` fallback (the open-redirect guard).
7. **Gates:** `npm run typecheck`, `npm test`, `npm run test:unit`, `npm run test:package`,
   `npm run build`, all green. **`npm run lint` is deliberately absent from this list**: neither
   the root `package.json` nor any workspace defines a `lint` script. Verified for this spec:
   the root scripts block has none (`build`, `test`, `test:unit`, `test:package`, `test:e2e`,
   `typecheck` and their variants only), and
   `grep -rl '"lint"' --include=package.json .` returns nothing. Naming a gate that cannot run is
   how a spec claims verification it never had.
8. **Local browser e2e, new `packages/web/e2e/filed-task-detail.e2e.ts`**, following
   `packages/web/e2e/task-thread.e2e.ts`'s boot-own-server doctrine (`fixtureServeEnv`,
   `CEZ_DRY_RUN=1`, a pinned `CEZ_HOME`, a throwaway `dataRoot`). Fixture: a `todos.json` carrying
   one `status: 'done'` entry with `archivedAt`, `author`, `context`, `whatToDo`,
   `acceptanceCriteria` and `knowledgeRefs`, plus one active entry. Steps, each with a
   `screenshot()` into `.ai/qa/artifacts_e2e`, numbered so the sequence reads as a filmstrip:
   1. open `/tasks`, switch to the Archived view; assert the URL is `/tasks?archived=1`; screenshot.
   2. click the Done row's title; assert the URL is `/p/<boot>/todos/<id>`, that
      `[data-slot="filed-task-detail"]` is present, that **no dialog element is anywhere in the
      DOM**, and that context, what-to-do, acceptance-criteria, knowledge-refs, author and archived
      slots all render; screenshot.
   3. hard-refresh that URL (a reload of the same history entry); assert every assertion from step
      2 still holds and the back link is still `/tasks?archived=1`. This is the refresh-survival
      criterion, and deliberately not the `direct` check: the router state survives a reload;
      screenshot.
   4. click back; assert the URL is `/tasks?archived=1` and the Archived view still renders its
      rows; screenshot.
   5. switch to the **Active** view and click the active row's title; assert it navigates to that
      task's page and that **no dialog opens**; screenshot. The view switch is not housekeeping:
      after step 4 the board is on Archived, where `matchesFiledView` keeps every non-archived,
      non-done row off screen (`lib/filed-tasks.ts:87`), so the active fixture row is not in the
      DOM until the view changes.
   6. a separate, genuinely state-less navigation: open a page URL cold, the way a pasted link
      arrives, with nothing on `location.state`. Assert the page renders the same stored detail and
      that its back link href is exactly `/tasks`, not `/tasks?archived=1`. This is the `direct`
      check; screenshot.
   7. **poll** `<CEZ_HOME>/analytics/events.ndjson` until the expected records are present or a
      **10 s** deadline expires, re-reading every 250 ms. A single immediate read is a race and is
      forbidden here: the route answers 202 **before** awaiting the append, and `trackEvent` is
      fire-and-forget on the client. The condition: at least four `todo.detail_opened` lines whose
      `props.project` is the boot project, with `surface: 'table'` present (steps 2, 3 and 5) and
      `surface: 'direct'` present (step 6), each line carrying all five props and no free text. On
      timeout the step fails and prints the file's actual contents, so a real regression is
      distinguishable from a slow disk.
   Run with `npm run test:e2e`. `TEST_E2E_STATUS=skipped` is **not** a pass (`.ai/scripts/e2e.sh`);
   a skip means this step has not been done.
9. **Recorded runtime E2E on production** (`https://cockpit.example.com`). On the real Archived
   board: click a genuinely archived Done task's title, confirm the full page renders its stored
   detail with no modal, hard-refresh the URL and confirm it still renders and Back still returns
   to `/tasks?archived=1`, navigate back and confirm the Archived view returns, then switch to the
   Active view, open an active filed task, and confirm it too opens as a page and no dialog
   appears. Artifacts preserved under
   `/var/lib/cezar/e2e-artifacts/filed-task-detail-<sha>/`, owned by `cezar`, the convention set by
   `.ai/specs/2026-08-24-bulk-start-filed-tasks.md` §5. The run is done only when that directory
   holds the per-step PNGs **and** a `NOTES.md` naming the commit, the URL of the task used, and
   the pass or fail of each step. Record the result honestly: if it fails, the feature stays
   **QA Needed** and the failure is quoted back into this document.

   **On "recorded", and video. This is a QA blocker, not an optional extra.** `33bee966` asks in
   as many words to "keep screenshots and video artifacts", and the standing agent doctrine this
   workspace runs under says the same thing for anything user facing: "e2e tests record.
   screenshots and video recording on, artifacts kept per run, so a failure can be watched instead
   of guessed at." A numbered PNG sequence does not satisfy that. Neither would stitching those
   PNGs into an `.mp4`: a slideshow of frames the harness chose to take is not a capture of the
   session, it cannot show what happened between two `screenshot()` calls, and there is no
   `ffmpeg` on this box in any case (`which ffmpeg` exits 1, measured 2026-08-29). **The earlier
   draft's optional-slideshow clause is withdrawn.**

   Re-verified for this spec rather than carried forward from the 2026-08-26 one:
   `.ai/browsers/agent-browser.md` documents exactly eight operations (`ensure-installed`,
   `doctor`, `open`, `snapshot`, `interact`, `assert`, `screenshot`, `close`), with no screencast,
   no video and no trace among them; `packages/web/e2e/agent-browser.ts:233` wraps `screenshot` as
   the only artifact-producing call on the whole class; and there is no Playwright anywhere in
   this repo (no `playwright` dependency in the root or any workspace `package.json`), so there is
   no `recordVideo` path to fall back on either. The harness cannot produce a video, and no spec
   wording changes that.

   **So the video comes from a capture-capable run, not from the harness.** A screen recording of
   this step's browser walkthrough, taken on a machine that can record its own screen (the owner's
   Mac driving `https://cockpit.example.com`, or any capture-capable representative browser
   session), saved as `walkthrough.mp4` beside the PNGs in the artifacts directory, with `NOTES.md`
   naming the machine and the tool that made it. The PNGs and the retained `snapshot` JSON stay as
   well: they are the per-step evidence, and the video is the session.

   **Order, and what happens when it cannot be made.** The local step 8 run and the gates are what
   gate the commit; the recording cannot, because this box cannot make one. Two acceptable
   sequences, and no third:

   - A capture-capable representative run supplies `walkthrough.mp4` **before** the commit. The
     criterion is met at commit time and this step confirms the same behaviour against production.
   - Otherwise the deploy proceeds on green gates and a passing step 8, and **the production video
     is a named post-deploy manual QA blocker**: the task ships as **QA Needed**, the handoff, the
     changelog entry and the final message each say "walkthrough.mp4 outstanding" in those words,
     and nothing calls this Done until that file exists in
     `/var/lib/cezar/e2e-artifacts/filed-task-detail-<sha>/`.

   Claiming a video the harness never took would be the same defect as claiming a lint gate it
   cannot run.
10. **Ownership check for any session that touched the box:**
   `find /var/lib/cezar -not -user cezar | wc -l` must print `0`.

## Out of scope (recorded, not forgotten)

- **Sub-pages for a filed task** (`/todos/:id/changes` and friends). A filed task has no worktree.
- **Editing `context` / `whatToDo` / `acceptanceCriteria` from the page.** The only mutations are
  the two that exist today; `updateTodoInputSchema` carries `status`, `priority` and `archived` and
  nothing else (`packages/contract/src/skills.ts`).
- **Re-pinning a todo's `placement` from the page.** A real gap, already recorded at its own schema
  field's doc comment, belonging to the cluster board work rather than here.
- **Promoting the board's `selected` and `shown` state into the URL.** The fix for Risk 5's
  residual cost, and a change to `lib/global-tasks.ts`'s single URL codec that has nothing to do
  with this page. Worth filing once someone actually reports losing a selection.
- **A second analytics event, a reader for the sink, or any aggregation UI over it.** This change
  wires exactly one event to a sink that already exists; nothing reads `events.ndjson` back except
  a human with `tail`. The two existing `TODO(analytics)` markers (`todo-cli.ts:212`,
  `reopen-watch.ts:67`) stay where they are: the sink they were waiting for exists now, but wiring
  them is their own change.
