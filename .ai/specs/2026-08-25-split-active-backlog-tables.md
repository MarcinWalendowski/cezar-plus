# Split filed tasks into sortable Active and Backlog tables

- **Status:** Specified, not implemented
- **Date:** 2026-08-25
- **Task:** `265c2695-f524-4a40-b0e8-d613cf1a31fd`, workflow `spec-to-deploy`, branch `cez/265c2695`
- **Brief:** `.ai/specs/briefs/2026-08-25-split-active-backlog-tables.md` (step 1 of this run;
  every file it cites was re-opened while writing this spec, and the two places it was out of
  date are corrected inline below)
- **Extends:** `.ai/specs/2026-08-17-filed-tasks-table-statuses.md` (shipped `c65ca0bf`),
  `.ai/specs/2026-08-24-bulk-start-filed-tasks.md` +
  `.ai/specs/2026-08-24-ship-bulk-start-filed-tasks.md` +
  `.ai/specs/2026-08-25-verify-bulk-start-release.md`
- **Task statement (verbatim):** "On /tasks, Active appears above Backlog with 20 and 30 rows
  initially. Independent Show more controls add exactly 10 rows. Every sortable column requests
  deterministic backend ordering with a stable tie-breaker and preserves status partitions during
  expansion. Contract, server, and UI tests cover columns, partitions, limits, increments, and
  invalid queries. Analytics ship, and browser E2E artifacts prove both sections, one sort in
  each, and both expansions."

## TLDR

The Filed section of `/tasks` becomes two tables on the Active tab: **Active** (every filed task
whose status is not `todo`) above **Backlog** (status `todo`), each with its own initial row
count (20 and 30), its own Show more control (+10 exactly), and its own sort. Ordering and paging
move off the client and onto `GET /api/v1/workspace/todos`, which gains optional
`partition` / `sort` / `dir` / `limit` / filter query parameters. The wire contract gains a
per-partition page envelope; a request with no parameters keeps answering exactly what it answers
today, because cezar is a published package and that payload is a protected surface
(`BACKWARD_COMPATIBILITY.md` §2). Ordering is deterministic by construction: every column
comparator falls through to the `project:id` composite row key ascending, which gives the
**prefix property** the acceptance criteria calls stability. Analytics infrastructure does not
exist anywhere in this repo yet, so this spec builds the minimum honest version of it (a local
NDJSON sink) and emits three events from the new surface.

## Problem

1. **There is no Active/Backlog split.** `FiledTasks()`
   (`packages/web/src/routes/global-tasks.tsx:727-950`) renders one table. The only split it has
   is the page's Active/Archived tab, which keys on `archivedAt` or `status === 'done'`
   (`matchesFiledView`, `packages/web/src/lib/filed-tasks.ts:86-89`), not on todo-vs-not-todo. So
   work that is genuinely in flight (`in-progress`, `blocked`) is interleaved with a backlog that
   is currently 49-plus rows of never-started work, and neither can be scanned.
2. **All ordering and paging are client-side.** `filterFiledTasks` / `sortFiledTasks`
   (`filed-tasks.ts:106-176`) run in the browser over whatever `GET /workspace/todos` returned,
   and `WorkspaceTodoIndex.list()` (`packages/cezar/src/workspace/todo-index.ts:83-100`) returns
   every todo of every registered project with, in its own words, "No cap, no truncation". The
   route takes zero query parameters (`packages/contract/src/workspace-todos.ts:37-41`;
   `packages/cezar/src/server/workspace-todos-routes.ts:55-59` calls `index.list()` with nothing).
3. **That payload is already oversized and gets worse.** Each entry carries the full
   `whatToDo` (bounded at 100,000 characters) and `context` (20,000)
   (`packages/contract/src/skills.ts:105-108`), and the 2026-08-17 migration put 631 todos on the
   board. Every open of `/tasks` pulls all of them so the browser can show 100.
4. **Only two sorts exist and neither is per column.** `FiledSort` is `created-desc | created-asc`
   (`filed-tasks.ts:25`), rendered as a Newest/Oldest dropdown (`FILED_SORT_OPTIONS`,
   `global-tasks.tsx:699-704`). The header cells are static `<th>` with no `onClick` and no
   `aria-sort` (`Th`, `global-tasks.tsx:1882-1894`).
5. **Paging is one shared `shown` counter at 100 a click** (`FILED_ROW_PAGE_SIZE = 100`,
   `filed-tasks.ts:210`; `shown` state `global-tasks.tsx:756`, reset `:782-786`, button `:883`
   and `:942`). Two tables cannot share one counter, and the last change to this state produced a
   real bug: the bulk-start batch was computed from `sorted` rather than the rendered `rows`, so a
   row hidden by pagination still started (fixed at `global-tasks.tsx:797`, regression test
   `global-tasks.test.tsx:1515-1574`).
6. **There is no analytics sink in this repository at all.** Confirmed by grep across
   `packages/web/src` for `analytics|telemetry|posthog|logEvent|emitEvent`: nothing. The only
   precedent is aspirational `TODO(analytics):` markers left in prose
   (e.g. `.ai/specs/2026-08-20-reopen-sweep-execution.md:576`). "Analytics ship" therefore cannot
   mean "wire into the existing sink"; it has to mean "build a small one".

## Solution

### D1. The two splits compose; the tab axis is not replaced

The brief left this open (its open question 5). Settled:

| Page tab | Filed section renders |
| --- | --- |
| **Active** (`?archived` absent) | **two** tables: `Active` (status not `todo`) above `Backlog` (status `todo`) |
| **Archived** (`?archived=1`) | **one** table, exactly as today, client-sorted, `FILED_ROW_PAGE_SIZE = 100` |

Reasoning. `matchesFiledView` already answers a different question ("has this left the live
board", by `archivedAt` or `done`) from the one this task asks ("is this in flight or waiting").
The new split is a partition *inside* the live board, so it nests under the Active tab rather
than competing with the tab. Partitioning the Archived tab would be meaningless: an archived
`todo`-status entry is dismissed work, not backlog, and `done` entries are neither. Leaving
Archived on the existing client-side path also keeps the blast radius of this change off the
539-row archive that the 2026-08-17 prod verification pass signed off on.

**Naming collision, named rather than absorbed.** `Backlog` already means the third submit mode
of the `/new` composer (`.ai/specs/2026-08-22-backlog-add-without-starting.md`,
`.ai/specs/2026-08-24-land-the-backlog-composer.md`, landed `c406f2fa`), whose selector is
`data-slot="mode-backlog"` and whose E2E is `packages/web/e2e/backlog-composer.e2e.ts`. The two
concepts are related (a backlog-composer submit files a `status: 'todo'` entry, which lands in
this table) but they are not the same object, and no selector may be shared. Every new slot in
this spec is namespaced `filed-`: `filed-active-table`, `filed-backlog-table`,
`filed-active-show-more`, `filed-backlog-show-more`. A grep for `mode-backlog` must keep matching
exactly one thing.

**The doubled word "Active".** The page tab and the upper table are both called Active, because
the task statement fixes the table's name. They are visually separate controls (the tab sits in
the page header, the table headings sit under the `Filed` section heading) and their slots do not
collide (`data-view` on `filed-tasks` vs. `data-slot="filed-active-table"`). Flagged here so a
reviewer sees it was a decision and not an oversight.

### D2. One request per partition

`GET /api/v1/workspace/todos` gains optional query parameters. **A request that sends none of
them answers byte-identically to today** (§2 of `BACKWARD_COMPATIBILITY.md`: additive is fine,
making an existing output disappear is not). A request that sends `partition` gets a paged,
ordered, filtered answer for that partition only.

The client issues **two** requests on the Active tab, one per partition, with two React Query
keys. This is the load-bearing choice for the "preserves status partitions during expansion"
requirement: expanding Active mutates only the Active query key, so the Backlog request is not
re-issued and its rows cannot move. The property is structural, not merely tested. (The
alternative, one request carrying both partitions, would make the same property depend on the
determinism of the ordering alone, and a regression there would silently reshuffle the table
nobody touched.)

Cost arithmetic, since two requests where there was one deserves it. Each request walks the
registry and calls `readTodos()` per project, so the walk doubles: measured shape is roughly 7
registered projects and 631 todos. Against that, the *response* falls from every todo (up to
120,000 characters of body per entry, uncapped, 631 of them) to 20 or 30 full entries. Paged
responses are cheaper than today's single response by orders of magnitude even at two round
trips, and `readTodos()` is a pure read that never materializes state
(`packages/cezar/src/todos.ts:423-454`), so the extra walk allocates nothing on disk.

Rows carry the **full** `todo` object, not a trimmed summary. The detail dialog
(`FiledDetailDialog`) renders `context` / `whatToDo` / `acceptanceCriteria` from the row it was
handed, and inventing a second per-row fetch to re-supply what a 20-row page can carry outright
would be a worse trade.

### D3. Deterministic ordering, and what "stable" means precisely

Ordering lives in a new pure module, `packages/cezar/src/workspace/todo-ordering.ts`, with no fs
and no `ProjectContext` import, so it is unit-testable in isolation (the same discipline
`todo-index.ts` states for itself).

Sortable columns and their keys:

| Column (`sort=`) | Key | Order |
| --- | --- | --- |
| `age` (default) | `todo.ts` parsed as epoch ms | `desc` = newest first. Unparseable or absent sorts **last in both directions**: it is unknown, not old. This is today's rule (`sortFiledTasks`, `filed-tasks.ts:164-182`) preserved verbatim. |
| `status` | rank in `['todo','in-progress','blocked','done']` | The workflow order the enum already declares (`filed-tasks.ts:19`, `skills.ts:92`). Absent reads `'todo'` (rank 0), matching `filedStatus()` (`filed-tasks.ts:66-68`). |
| `priority` | rank in `['high','medium','low']` | `filed-tasks.ts:23`. Absent sorts **last in both directions**, same rule as `age`: no priority is not a priority. |
| `task` | `todo.summary` | Case-folded codepoint compare (see below). Always present (`z.string().min(1)`). |
| `project` | the registry slug on the entry | Case-folded codepoint compare. Always present. |
| `author` | `todo.author.label ?? todo.author.id` (`packages/contract/src/task-author.ts:70-72`) | Case-folded codepoint compare; absent author sorts **last in both directions**. |

Deliberately **not** sortable: the selection checkbox and the actions column (no value), and
**Node**. Node renders only when `nodeRoster.clusterOn` (`global-tasks.tsx:897-916`), so
`?fasort=node:asc` would be a URL that means something on one install and nothing on the next.

Two rules make the ordering total, and they are the whole answer to "deterministic backend
ordering with a stable tie-breaker":

1. **Codepoint, never `localeCompare`.** `localeCompare` resolves through ICU, so its answer can
   differ between the Node build serving the request and the one running the test. Compare
   `a.toLowerCase() < b.toLowerCase()` and nothing else.
2. **Every comparator falls through to `project:id` ascending, regardless of `dir`.** That is
   `filedTaskKey()`'s existing composite (`filed-tasks.ts:236`), which is already the React row
   key, is unique across projects, and is always present on the wire (ids are backfilled on read,
   `todos.ts:428-454`). The tie-break direction does **not** flip with `dir`, so the total order
   for a given `(sort, dir, filters)` is a single fixed sequence.

From (2) follows the invariant the tests assert, which is what the acceptance criteria means by
stability:

> **Prefix property.** For a fixed `(partition, sort, dir, filters, q)`, the rows returned for
> `limit = N` are exactly the first `N` rows returned for `limit = N + k`, for every `k >= 0`.

Expansion is therefore append-only by construction: a Show more can add rows to the bottom of a
table and can never reorder or drop the rows already on screen.

### D4. Server-side filtering follows server-side paging, necessarily

Once the server decides which 20 rows to send, the client can no longer be the thing that filters:
filtering a page after the fact would show "3 of 20" while the true match count is 300. So the
status/priority facets and the page's search box move onto the request, and the response carries
back the counts the section header and the facet chips render.

- Filters on the wire: `status` (repeatable), `priority` (repeatable), `q` (the page's one search
  box), `view` (`active` | `archived`). These are the same four inputs `filterFiledTasks` takes
  today (`filterFiledTasks`, `filed-tasks.ts:110-126`), moved.
- The facet counts keep the existing exclusion discipline (`filedTasksExcludingFacet`,
  `filed-tasks.ts:131-140`): `counts.statuses` is computed over the set narrowed by every facet
  **except** statuses, so unticking a value shows how many rows would come back rather than a
  number that already assumes the tick.
- The section keeps **one** controls row for both tables (status/priority facets, search). The
  client sums the two partition responses' `counts` maps for the chips and their totals for the
  header badge. Two tables with two separate filter bars was considered and rejected: the page has
  one search box by design ("one box narrows both the runs table and this one",
  `global-tasks.tsx:737`), and per-table facets would let a reader put the two halves of one board
  into contradictory states.
- Visibility rules move with the filter: `isVisibleFiledEntry` (`!startedTaskId`,
  `filed-tasks.ts:76-78`) becomes a server-side predicate on the partitioned path, and
  `isTombstoned` (`todos.ts:145`) joins it. **Correction to the brief:** the brief did not
  mention tombstones, and re-reading `todo-index.ts:83-100` shows `WorkspaceTodoIndex.list()`
  does not filter them, though `todos.ts:466-468` says explicitly that "Board consumers filter
  with `isTombstoned`". That is a pre-existing leak on the legacy path. It is **not** fixed here:
  removing rows from the unparameterized response is the exact shape of change §2 calls breaking.
  The partitioned path filters them, and the leak is filed as a separate todo (see Risks).

### D5. Row counts, and why the bulk-start bug cannot recur

New constants, in `packages/contract/src/workspace-todos.ts` so the server's `limit` bound and the
client's request are one number rather than twins that can drift:

```ts
export const FILED_ACTIVE_INITIAL_ROWS = 20
export const FILED_BACKLOG_INITIAL_ROWS = 30
export const FILED_SHOW_MORE_INCREMENT = 10
export const FILED_PAGE_LIMIT_MAX = 1_000
```

`FILED_ROW_PAGE_SIZE = 100` stays exactly where it is (`filed-tasks.ts:210`), still owned by the
web package, still used by the unsplit Archived table.

Each table holds its own `limit` state, initialized from its own constant, and Show more sets
`limit + FILED_SHOW_MORE_INCREMENT`. `limit` resets to the initial value whenever the filters,
the search or **that table's own** sort changes, mirroring today's reset effect
(`global-tasks.tsx:782-786`); the other table's `limit` is untouched by the reset, because a sort
change in one table is not a state change in the other.

The 2026-08-24 bulk-start bug (batch computed from the full `sorted` array rather than the
rendered `rows`) becomes structurally unreachable: on the partitioned path, `rows` **is** the
response. There is no wider in-memory array to accidentally reach for. The regression test at
`global-tasks.test.tsx:1515-1574` is re-pointed at the new tables rather than deleted, because
"unreachable by construction" is a claim a test should keep checking.

### D6. Sortable headers and URL state

`Th` gains an optional sortable mode: a `<button>` inside the `<th>`, `aria-sort` on the `<th>`
(`ascending` | `descending` | `none`), and a click cycle of **asc to desc to asc**. Note the
deliberate difference from `packages/web/src/routes/task-thread/sortable-table.tsx`, which cycles
asc to desc to *unsorted*: that component sorts a markdown table whose file order is meaningful,
whereas there is no such thing as an unsorted page here (the server must always be asked for some
order), so a third state would have to mean "back to `age:desc`", which the Age header already
says more clearly.

URL state, composed into the page's one codec (`lib/global-tasks.ts`'s
`urlStateToSearchParams` / `urlStateFromSearchParams`, `:481-530`), never into a second
`URLSearchParams` writer, per the page's stated one-codec doctrine (`filed-tasks.ts:215-228`):

| Param | Meaning |
| --- | --- |
| `fasort` | Active table sort, `<column>:<dir>`, e.g. `fasort=priority:asc` |
| `fbsort` | Backlog table sort, same grammar |
| `fsort` | unchanged; the Archived table's `created-desc` / `created-asc` |

Defaults emit nothing, so a bare `/tasks` stays bare (the codec's stated rule, `:477-483`).
Show more counts are **not** URL state, matching today's ephemeral `shown`: a pasted link should
reproduce a filtered, sorted view, not somebody's scroll depth.

**Compatibility of the composite grammar.** The URL uses one key per table
(`fasort=age:desc`) while the API uses two (`sort=age&dir=desc`); the codec is the only place the
two grammars meet, and the API keeps two so a bad value produces a zod error that names the field.
`fsort` keeps its existing values, and `isFiledSort` keeps accepting them: a bookmarked
`/tasks?fsort=created-desc` was verified in the 2026-08-17 prod pass and must keep working. The
new keys additionally accept `created-desc` / `created-asc` as aliases for `age:desc` / `age:asc`,
so a URL hand-edited from muscle memory resolves instead of silently falling back.

### D7. Analytics, built from nothing

Nothing to extend, so the smallest honest thing:

- **`packages/web/src/lib/analytics.ts`** exports `track(event: string, props: Record<string, string | number | boolean>)`.
  It buffers events in memory and flushes on an idle callback (batched, at most one request in
  flight, dropped silently on failure). It never blocks a render and never throws into a
  component.
- **`POST /api/v1/workspace/analytics`**, body `{events: [{event, ts, props}]}`, appends one JSON
  line per event to `~/.cezar/analytics/YYYY-MM-DD.ndjson` and answers `202 {accepted: n}`.
  Workspace-level, single-mount, additive, never mirrored under `/api/v1/p/:projectId` (§2's rule
  for every workspace family). Files older than 30 days are pruned on write.
- **On by default, local only.** The sink writes to the user's own machine and never leaves it,
  which is the same footing as `runs/<id>.ndjson`. `CEZ_ANALYTICS=0` disables emission entirely
  (the route then answers `202 {accepted: 0}` without writing, so a disabled install has no new
  behaviour to distinguish). Off-by-default was considered and rejected: an event that never
  fires on any real install is not shipped analytics, it is a comment.
- **Bounded by construction:** event name capped at 64 characters, at most 12 props, each value
  stringified and capped at 200 characters, at most 50 events per request. No free-text task
  content is ever a prop value; task summaries, project names and search queries are excluded by
  the design of the three events below, not by a filter.

Events emitted by this surface (naming convention `filed_tasks.<verb>`, established here):

| Event | Props | Fires |
| --- | --- | --- |
| `filed_tasks.partition_viewed` | `partition`, `rows`, `total`, `sort`, `dir` | once per partition per distinct parameter set, after its rows render (deduped, so re-renders do not multiply it) |
| `filed_tasks.sorted` | `partition`, `column`, `dir` | on a header click, before the request |
| `filed_tasks.show_more` | `partition`, `from`, `to`, `increment` | on each Show more click |

## Architecture

Unchanged: todos stay per-project `.ai/cezar/todos.json`; the workspace board stays a read-only
aggregation over `WorkspaceTodoIndex`; writes stay project-scoped routes
(`PATCH /api/v1/p/:projectId/todos/:id`). What moves is the *decision of which rows*: from the
browser into `WorkspaceTodoIndex.list(query)` and a new pure `todo-ordering.ts` beside it. What is
added is one write route, for analytics, which touches `~/.cezar/` and nothing in any project.

Upstream purity holds throughout (`filed-tasks.ts:10-11`): nothing added here names a product, a
workspace or a deployment. `active` and `backlog` are partitions of a generic status enum.

```
browser                          server
───────                          ──────
FiledTasks (Active tab)
 ├─ useFiledPage('active',  …) ──► GET /workspace/todos?partition=active&sort=…&limit=20
 └─ useFiledPage('backlog', …) ──► GET /workspace/todos?partition=backlog&sort=…&limit=30
                                     │
                                     ├─ WorkspaceTodoIndex.list(query)
                                     │    ├─ registry walk ─► readTodos(dataDir) per project
                                     │    ├─ visible? (!startedTaskId, !tombstoned)
                                     │    ├─ view + facets + q
                                     │    ├─ partition by (status === 'todo')
                                     │    ├─ todo-ordering.ts  ← total order, ties on project:id
                                     │    └─ slice(0, limit)
                                     └─ { todos, projects, page, counts }

FiledTasks (Archived tab) ───────► GET /workspace/todos   (no params, legacy path, unchanged)
```

## Phases

Each phase is independently shippable and leaves the cockpit working.

1. **Contract + server ordering and paging.** New query/response schemas in
   `packages/contract/src/workspace-todos.ts`; `packages/cezar/src/workspace/todo-ordering.ts`;
   `WorkspaceTodoIndex.list(query?)`; `queryZodValidator` on the route. No client change, so the
   cockpit still uses the legacy path and nothing visibly moves. Ships with server tests and the
   byte-identity test for the no-params path.
2. **Two tables, server-fed, with independent Show more.** `getWorkspaceTodos(params)` in
   `packages/web/src/api/client.ts`, per-partition query keys in `api/queries.ts`, `FiledTasks`
   split into `FiledPartitionTable` rendered twice on the Active tab. Sorts still come from the
   existing dropdown, applied to both tables. Delivers "Active above Backlog, 20 and 30, +10".
3. **Per-column sortable headers + URL state.** `Th` sortable mode, `fasort` / `fbsort` through
   the page codec, aliases for the legacy values. Delivers "every sortable column requests
   deterministic backend ordering".
4. **Analytics.** `lib/analytics.ts`, `POST /workspace/analytics`, the three call sites,
   `BACKWARD_COMPATIBILITY.md` §2 and §9 entries, CHANGELOG.
5. **E2E + deploy + record.** `packages/web/e2e/filed-partitions.e2e.ts` with artifacts, deploy,
   prod runtime pass, corpus/KB write.

## Data models

No change to `TodoItem` on either side of the schema twin (`packages/contract/src/skills.ts:72`
and `packages/cezar/src/todos.ts:42`). **Re-verified against the live files after `dc64b741`**,
which the brief flagged as possibly having moved the schema: it did not touch `todos.ts`'s
`todoSchema` field set, and there is still **no monotonic sequence field** on a todo. The unique,
always-present identity remains `(project, id)`, which is why the tie-breaker is that pair and not
a counter.

New shared vocabulary in `packages/contract/src/workspace-todos.ts`:

```ts
export const filedPartitionSchema = z.enum(['active', 'backlog'])
export const filedSortColumnSchema = z.enum(['age', 'status', 'priority', 'task', 'project', 'author'])
export const filedSortDirSchema = z.enum(['asc', 'desc'])

export const DEFAULT_FILED_SORT_COLUMN = 'age'
export const DEFAULT_FILED_SORT_DIR = 'desc'
```

New state file: `~/.cezar/analytics/YYYY-MM-DD.ndjson`, one JSON object per line
(`{event, ts, props}`), append-only, pruned at 30 days. Its own directory rather than a key in
`config.json`, for the reason `agent-accounts.json` states in §9: a cezar that has never heard of
it does not open it, so a downgrade cannot drop it.

## API contracts

### `GET /api/v1/workspace/todos` (additive query, additive response keys)

Query (all optional; a request with none of them is the legacy path):

| Key | Schema | Notes |
| --- | --- | --- |
| `partition` | `filedPartitionSchema` | absent = legacy path, no paging, no ordering, no filtering |
| `sort` | `filedSortColumnSchema` | default `age` |
| `dir` | `filedSortDirSchema` | default `desc` |
| `limit` | `z.coerce.number().int().min(1).max(FILED_PAGE_LIMIT_MAX)` | required in effect when `partition` is present; default `FILED_ACTIVE_INITIAL_ROWS` |
| `view` | `z.enum(['active','archived'])` | default `active`; the existing tab axis |
| `status` | repeatable string | facet, empty = every status |
| `priority` | repeatable string | facet |
| `q` | `z.string().max(500)` | the page's search box |

Repeated keys are read as arrays for `status` / `priority`; the single-valued keys use the
existing `queryValue` collapse-to-first union (`server.ts:1321`) so a duplicated key answers 200
as it does everywhere else on this server rather than newly 400ing.

Response, with `partition` present:

```ts
{
  todos: WorkspaceTodoEntry[],        // this page's rows, in order, full todo objects
  projects: WorkspaceProjectHealth[], // unchanged, one per considered project
  page: {
    partition: 'active' | 'backlog',
    sort: FiledSortColumn,
    dir: FiledSortDir,
    limit: number,
    returned: number,                 // todos.length
    total: number,                    // matching rows in this partition AFTER filters
    partitionTotal: number,           // rows in this partition BEFORE facets/search
    hasMore: boolean,                 // total > limit
  },
  counts: {
    statuses: Record<string, number>, // facet counts, each excluding its own facet
    priorities: Record<string, number>,
  },
}
```

Without `partition`, `page` and `counts` are **absent** and `todos` is the full uncapped list, as
today. Both keys are optional on `workspaceTodosResponseSchema`, which keeps
`contract-parity.workspace-todos.test.ts` exact in both directions.

Errors: `400 {error}` from `queryZodValidator` for an unknown `sort`, `dir` or `partition`, a
`limit` that is not a positive integer, a `limit` above `FILED_PAGE_LIMIT_MAX`, or a `q` over 500
characters. `{error}` is the one 400 shape this API answers (§2), and the message is prefixed with
the field path by `reject()` (`validators.ts:66-73`). Unknown query keys are stripped by the zod
object rather than rejected, so no existing caller newly fails.

### `POST /api/v1/workspace/analytics` (new, additive)

Body `{events: [{event: string(<=64), ts: string, props?: Record<string, string|number|boolean>}]}`,
at most 50 events. Answers `202 {accepted: number}`. Never 404s, never 409s, and answers
`202 {accepted: 0}` with `CEZ_ANALYTICS=0` so a disabled install is indistinguishable on the wire
from a healthy one that dropped a batch. Workspace-level, single-mount; registered in
`route-parity.test.ts` and `bc-route-inventory.test.ts` like every other route.

## Risks

- **Breaking the legacy payload by accident.** This is the big one: `GET /workspace/todos` with no
  params is a §2-protected shape and the composer's own board reads it. Mitigation is a test that
  asserts the no-params response deep-equals the pre-change handler's output over a fixture with
  archived, done, started, tombstoned and legacy-no-status entries, plus the compile-time
  `contract-parity` check that the schema is neither wider nor narrower than the route.
- **Cross-partition mutations and optimistic cache patches.** A status change can move a row from
  Active to Backlog or back, and no optimistic patch can place it at its server-decided rank in
  the other table. Rule: mutations optimistically **remove** the row from every cached page under
  the `workspaceTodos` key prefix (removal is always correct: archive removes it, and a
  partition-crossing status change removes it from where it was), then invalidate both partition
  keys so the arrival side is server-decided. The shipped instant-archive feel is preserved on the
  visible half; the invisible half refetches. This is a deliberate divergence from the pure
  optimistic patch in `applyFiledPatch` (`filed-tasks.ts:194-205`), which stays in use for the
  Archived table.
- **Two responses can disagree transiently.** The header badge sums two independent requests, so a
  mutation landing between them can show a count that is briefly one row off. Accepted: the badge
  is advisory and both queries are invalidated together.
- **Tie-breaker instability for id-less legacy entries.** `readTodos()` mints an id for an entry
  that has none and writes it back under the todos lease; when that write loses the race the next
  read mints a different one (`todos.ts:439-453`, itself a correction from 2026-08-22). Such an
  entry's tie-break position can therefore move between requests until its backfill sticks. Bounded
  to raw agent appends before their first successful backfill, and named here so a flaky expansion
  test is diagnosed rather than re-derived from scratch.
- **`localeCompare` creeping back in.** It is the obvious thing to reach for on a string column
  and it is ICU-dependent. Guarded by a unit test that orders a fixture containing accented and
  mixed-case summaries and asserts the exact sequence.
- **Tombstoned rows still leak on the legacy path.** Pre-existing (`WorkspaceTodoIndex.list()`
  does not call `isTombstoned`, `todo-index.ts:83-100`, against the instruction at
  `todos.ts:466-468`). Deliberately not fixed here, because removing rows from a protected
  response is exactly the breaking shape §2 forbids; filed as its own todo so it is decided rather
  than forgotten.
- **Analytics growing without bound, or carrying task content.** Bounded by the daily file, the
  30-day prune, the 50-event batch cap and the per-value 200-character cap; no event in the table
  above carries a summary, a project name or a search string.
- **Ordering cost per request.** Sorting is `O(n log n)` over the post-filter set, `n` around 631
  today, on every request including each Show more. That is microseconds and needs no index; if
  `n` reaches five figures the answer is a cursor, not a cache, and this envelope already has
  room for one (`page` is where a `cursor` would go).
- **Scope of the UI rewrite.** `FiledTasks()` is 220 lines that shipped six days ago and already
  carries one fixed pagination bug. Mitigation: phase 2 extracts `FiledPartitionTable` without
  changing row rendering (`FiledRow`, `FiledCard`, `FiledDetailDialog` are moved intact, not
  rewritten), and the existing Filed tests run against the new structure before the sort work
  lands.

## Verification

Every step below is executable and names its file. "Analytics ship" and "E2E artifacts prove" are
verified by artifacts, not by assertion in prose.

1. **Ordering unit tests** (`packages/cezar/src/workspace/todo-ordering.test.ts`, new):
   - one case per sortable column per direction, asserting the exact row-key sequence;
   - absent `ts`, absent `priority` and absent `author` each sort last in **both** directions;
   - `status` orders by workflow rank, not alphabetically (assert `in-progress` before `blocked`
     on `asc`, which alphabetical order would reverse);
   - accented / mixed-case fixture pins the codepoint comparator against `localeCompare`;
   - **prefix property**: over a generated 200-entry fixture, for every `(column, dir)` pair,
     `rows(limit=N)` equals `rows(limit=200).slice(0, N)` for `N` in `{20, 30, 40, 60}`;
   - total order: no two distinct rows ever compare equal (assert the comparator returns non-zero
     for every distinct pair in a fixture built to collide on every column at once).
2. **Index tests** (`packages/cezar/src/workspace/todo-index.test.ts`): partition membership
   (`todo` to Backlog, absent status to Backlog via `filedStatus`'s default, `in-progress` /
   `blocked` / `done` to Active), `startedTaskId` and tombstoned rows excluded on the partitioned
   path, `view=archived` interaction, facet counts computed with the correct exclusion, `total`
   vs `partitionTotal` vs `returned`, `hasMore`.
3. **Route tests** (`packages/cezar/src/server/workspace-todos-routes.test.ts`, extended):
   - happy path per partition with `sort` / `dir` / `limit`;
   - **invalid queries all 400 with `{error}` naming the field**: `partition=nope`, `sort=nope`,
     `dir=sideways`, `limit=0`, `limit=-1`, `limit=abc`, `limit=1001`, `q` of 501 characters;
   - `limit=20` then `limit=30` on the same fixture: the second response's first 20 rows are the
     first response's rows, in order (the prefix property over HTTP);
   - **legacy byte-identity**: a no-params request against a fixture holding archived, done,
     started, tombstoned and legacy-no-status entries deep-equals the recorded pre-change payload,
     and carries neither `page` nor `counts`;
   - unknown query keys are ignored, not rejected.
4. **Contract tests** (`packages/cezar/src/server/contract-parity.workspace-todos.test.ts`,
   extended): the response schema stays mutually assignable with the route type with `page` and
   `counts` optional, and the query keys are visible to `hc` (a `$get` with
   `{query: {partition: 'active'}}` type-checks, one with `{query: {bogus: '1'}}` does not).
   Enforced by `npm run typecheck`.
5. **Web pure-logic tests** (`packages/web/src/lib/filed-tasks.test.ts`, extended): `fasort` /
   `fbsort` round-trip through `urlStateToSearchParams` / `urlStateFromSearchParams`; defaults
   emit no key; `fasort=created-desc` aliases to `age:desc`; `fasort=garbage:sideways` falls back
   to the default without throwing; `fsort=created-asc` still parses unchanged.
6. **Web component tests** (`packages/web/src/routes/global-tasks.test.tsx`, extended):
   - Active section renders above Backlog in the DOM (assert document order of
     `filed-active-table` and `filed-backlog-table`);
   - initial row counts are exactly 20 and 30 against a fixture with 60 of each;
   - `filed-active-show-more` adds **exactly 10** rows and leaves `filed-backlog-table`'s row-key
     list **identical** (captured before and after, compared as arrays), and the same in reverse;
   - a header click issues a request with the expected `sort` / `dir` and cycles asc to desc;
   - sorting Active does not re-issue the Backlog request (assert the fetch mock's call log);
   - `aria-sort` is set on exactly the sorted column of each table;
   - the Archived tab still renders one unsplit table on the legacy path;
   - the bulk-start regression from `global-tasks.test.tsx:1515-1574`, re-pointed: a row selected
     then paged out of view is not in the batch.
7. **Analytics tests** (`packages/web/src/lib/analytics.test.ts` and the call sites): `track`
   batches, flushes once, drops silently on a failed POST and never throws; the three events fire
   with the documented props (`partition_viewed` once per parameter set, not once per render);
   `CEZ_ANALYTICS=0` suppresses the write server-side
   (`packages/cezar/src/server/analytics-routes.test.ts`: `202 {accepted: 0}`, no file created);
   the route caps the batch at 50 and truncates an over-long prop rather than 400ing.
8. **Gates**, each run with its exit code checked and the final lines quoted verbatim in the
   implementation notes:
   `npm run typecheck && npm test && npm run test:unit && npm run build && npm run test:package`.
9. **Browser E2E** (`packages/web/e2e/filed-partitions.e2e.ts`, new), on the repo's own
   `AgentBrowser` harness (`packages/web/e2e/agent-browser.ts`) dispatched by
   `npm run test:e2e` (`.ai/scripts/e2e.sh`), modelled on `backlog-composer.e2e.ts`: boot a
   throwaway `~/.cezar` home and a fixture git project, seed `todos.json` with 60 non-`todo` and
   60 `todo` entries, open `/tasks`, and write these artifacts under `.ai/qa/artifacts_e2e`:
   - `filed-partitions-both-sections.png` (Active above Backlog, 20 and 30 rows);
   - `filed-partitions-active-sorted-priority.png` (one sort in the Active table);
   - `filed-partitions-backlog-sorted-task.png` (one sort in the Backlog table);
   - `filed-partitions-active-expanded.png` (Active at 30, Backlog still 30 and unchanged);
   - `filed-partitions-backlog-expanded.png` (Backlog at 40, Active still 30 and unchanged);
   - `filed-partitions-verdict.json` recording, per assertion, the row counts and the row-key
     lists before and after each expansion, so the "unchanged" claim is readable in the artifact
     rather than only in a passing assertion.
   A run that cannot provision the browser exits `TEST_E2E_STATUS=skipped`, which is **not** a
   pass (`.ai/scripts/e2e.sh:5-13`) and must be reported as such.
10. **Prod runtime pass** on https://cockpit.example.com after deploy: both sections present with
    real data, one sort in each, both Show more controls, and the network tab showing exactly two
    `workspace/todos` requests on load and exactly one on each expansion. Until this has actually
    run, the task is **QA Needed**, not Done.
11. **Record**: `BACKWARD_COMPATIBILITY.md` §2 (the additive query and response keys, the new
    analytics route) and §9 (`~/.cezar/analytics/`), a CHANGELOG entry, and a corpus write in
    `/var/lib/cezar/loki-labs/notion-export/` followed by `CEZ_KB=1 cez kb reindex` (a corpus
    write is not a KB write until the reindex, per the workspace CLAUDE.md).

## Open items carried forward, not settled here

- **The tombstone leak on the legacy `GET /workspace/todos` path** is real and untouched by this
  spec (see Risks). It needs its own decision about whether a §2-protected response may stop
  carrying deleted rows.
- **`placement` is settable at create only** (`skills.ts:145-152` names this as a gap, not a
  decision). Unrelated to this change, but the Node column's non-sortability above is downstream
  of the same unfinished cluster surface, so it is worth naming in one place.
