# Backlog Task Composer

**Status:** implemented, QA verified; exact-SHA production deployment and live behavior verification remain pending.
**CORRECTED 2026-08-30:** The implementation is landed at `78295445` and QA is verified. Three
full root test runs, typecheck, unit, build, package, and the focused browser E2E passed. The E2E
proved one project-scoped submit creates exactly one unstarted todo, creates no run, navigates to
`/tasks`, and captures both required artifacts. Exact-SHA production activation and live behavior
verification remain pending because production currently serves `5d59a16f`.
**Status:** implemented, QA needed. The feature landed on `origin/main` at `c406f2fa`; focused tests, typecheck, build, and diff checks passed. The authoritative root, unit, and package gates remain red on reproduced shared drift, browser runtime E2E was skipped because `agent-browser` was unavailable, and production deployment plus live behavior verification remain pending.
**Date:** 2026-08-22
**Owner ask:** "allow to add new tasks to backlog without starting it"

## TLDR

Every submit path in the cockpit today starts a run (or walks straight toward starting one —
"Plan first" still calls `POST /api/plan` and proceeds to a review screen, it never stops at a
todo). `cezar todo add` (no `--start`) already gives an *agent* exactly this — file a backlog
todo, start nothing — and the backend route it writes through, `POST /todos`, is a plain, already
-shipped, ungated REST call with an unused `origin: 'composer'` enum value sitting in its own
schema. Nothing on the server needs to change. Give the `/new` composer a third run-mode segment,
**Backlog**, beside the existing **Start | Plan first** toggle: submitting with it selected calls
`POST /todos` with the typed text as `summary` and navigates to the Filed board instead of a run.
One composer, one submit, one todo — no second page, no per-project fan-out.

## Problem

Confirmed by direct reading:

- **`/new`** (`packages/web/src/routes/new-task.tsx`) has exactly one mode control, the `Start |
  Plan first` `ModeSegment` (`new-task.tsx:1435-1481`, rendered at `:848-852`, wired to
  `draft.planFirst` / `update({ planFirst })`). `submit()` (`:494-596`) branches on
  `draft.planFirst`: `false` → `createRun` (`:552`); `true` → `postPlan` then the plan-review
  overlay (`:540-551`). Neither branch, nor `startPlanned` (`:598+`, the review screen's own ▶
  Start), ever calls anything todo-shaped. There is no third branch and no todo call anywhere in
  the file.
- **`NewTaskDraft`** (`new-task-draft.ts:20-53`) has one relevant field, `planFirst: boolean` — a
  strict binary, sticky across navigation via `localStorage` (`STORAGE_KEY`, `DRAFT_VERSION = 2`).
  There is no third state to select today.
- **`POST /todos`** (`packages/cezar/src/server/server.ts:5830-5837`) is fully built, ungated, and
  validates against `createTodoInputSchema` (`packages/contract/src/skills.ts:138-149`) —
  `summary: z.string().min(1)` is the only
  required field; `context`, `whatToDo`, `acceptanceCriteria`, `knowledgeRefs`, `priority` are all
  optional. Its own comment says outright: *"this is becoming the composer's DEFAULT submit
  path"* — a comment about intent that the composer's code has never caught up to.
- **`origin: z.enum(['agent', 'composer'])`** (`packages/contract/src/skills.ts:106`) already reserves a `'composer'`
  value distinct from the CLI's `'agent'` — evidence this exact wiring was anticipated and never
  finished, not new ground.
- **`packages/web/src/api/client.ts`** has `getTodos` (`:788`), `removeTodo` (`:1542`), `startTodo`
  (`:1566`), `startWorkspaceTodo` (`:1597`), `updateWorkspaceTodo` (`:1625`) — every todo route
  **except create**. No `createTodo` function exists; grepping the whole `packages/web/src` tree
  for `POST /todos` (`createTodo`, `CreateTodoInput`, `.todos.$post`) returns nothing, confirmed
  independently of the brief.
- **`/workspace/new`** (`workspace-new-task.tsx`) is a structurally different feature: its submit
  always does `POST /workspace/notes` then `POST /workspace/notes/:id/process`
  (`:131-137`) — filing and triage-processing a **note**, which the triage pass turns into a spec
  run per implied project. There is no "file only, process later" state in that pipeline, and
  bolting one on is a materially different, separate change (see Out of scope).
- **`startWorkspaceRun`** (`client.ts:2720-2760`) starts a cross-project run immediately by
  design — its own doc comment says so. Out of scope for the same reason as `/workspace/new`.

**So the fix is exactly as narrow as the brief found: one missing client function, one missing
composer mode, no server or schema change.**

## What bounds the design (read directly, not just cited)

- **`notion-82a85b288169`** (cezar KB): *"one composer again — the two-composer routing was
  reverted the day it shipped."* No second page for this.
- **`.ai/specs/2026-08-15-knowledge-grounded-task-fanout.md`** (SUPERSEDED, read in full): the
  rejected design was a **fan-out** — one submit producing several todos, one per implied project.
  Owner verdict, verbatim: *"it's non sense — i don't want to have task per each project — it
  should be still one task."* This spec's design (one text box, one project already selected by
  the composer's scope, one `POST /todos` call) does not resemble that shape: it is not
  cross-project, and it produces exactly one todo per submit. Worth stating plainly since it is
  the design this feature must be checked against, not just cited.
- **`.ai/specs/2026-08-19-file-tasks-from-a-running-task.md`** (implemented, Phase 1+2): defines
  the semantics this spec reuses rather than re-deriving — a filed-not-started todo has
  `status: 'todo'`, no `startedTaskId`, shows on the Filed board and `/workspace/todos`, and is
  startable later with no auto-run. This spec is the human-UI counterpart of that CLI feature; it
  intentionally does not touch `--start`/`autostart` (starting-immediately paths already exist and
  are unaffected).

## Solution

### The control: a third `ModeSegment` option, `Backlog`

`ModeSegment` (`new-task.tsx:1435`) becomes a three-way `radiogroup` — `Start | Plan first |
Backlog` — instead of adding a second, disconnected toggle. A second boolean next to `planFirst`
could represent an invalid state (both true); a single tri-state avoids that by construction.

- **`NewTaskDraft.planFirst: boolean`** → **`NewTaskDraft.runMode: 'start' | 'plan' | 'backlog'`**
  in `new-task-draft.ts`. `EMPTY.runMode = 'start'` (today's default, unchanged behavior for every
  existing user). `normalize()` reads old stored drafts defensively: `obj.runMode` when it's one
  of the three literals, else falls back to the **legacy `planFirst` boolean** if present
  (`true` → `'plan'`, `false`/absent → `'start'`) — so a draft written before this ships loses
  nothing, the same discipline `DRAFT_VERSION` migrations already use elsewhere in this file. No
  `DRAFT_VERSION` bump needed: this is a read-side fallback, not a value the old code could have
  written in a form the new code misinterprets.
- Every current `draft.planFirst` read becomes `draft.runMode === 'plan'`; every
  `update({ planFirst })` write becomes `update({ runMode })`. Call sites confirmed by direct read:
  `new-task.tsx:352`, where `planFirst: draft.planFirst` is the `planFirst` input to
  `resolveComposerRunMode` (`:349-360`) and becomes `planFirst: draft.runMode === 'plan'`.
  **`ComposerRunModeInput.planFirst`** itself (`new-task-draft.ts:60`) **stays a boolean and is
  not renamed** — the local `const runMode = resolveComposerRunMode(...)` at `:349` already owns
  the `runMode` identifier for its own, unrelated return shape (`{autonomous, worktree}`); this is
  a naming collision with the draft's new `runMode` field worth a one-line comment at
  implementation time so a later editor doesn't conflate the two. Also `:540` (the plan-mode
  branch), `:697` (`sendAriaLabel`), `:821` (a `disabled={draft.planFirst}` guard on some other
  control), `:848-852` (`ModeSegment` itself).
- `ModeSegment` gains a third `role="radio"` button, `Backlog`, following the same
  `aria-checked`/active-fill pattern the existing two use (`:1454-1481`) — no new visual language,
  just a third state of the one already shipped.

### The submit branch

In `submit()` (`new-task.tsx:494`), a new `if (draft.runMode === 'backlog')` branch is inserted
**immediately after the `workspaceActive` block closes (after `new-task.tsx:526`) and before the
`!providersReady || runner === null` throw at `:527`** — clearing neither that provider gate nor
the `sourcesReady` gate below it (`:536-539`), since backlog mode starts no agent and needs
neither, and running ahead of the `if (draft.planFirst)` check (which becomes
`runMode === 'plan'`, `:540`) and `createRun`:

```ts
if (draft.runMode === 'backlog') {
  const { todo } = await createTodo({ summary: text, origin: 'composer' })
  clearDraftText(draftProjectId)
  // A predicate, not a key: `queryKeys.todos` is `[queryScope(), 'todos']`, so it cannot also
  // name the Filed board's `['workspace','todos']` aggregate — and that board carries the global
  // 5-minute `staleTime` (`refetchOnWindowFocus: false`), so an under-invalidated mount would
  // serve the stale cache instead of refetching. `queries.ts:2195-2205` documents this exact bug,
  // CORRECTED 2026-08-19; this reuses that fix rather than reintroducing it.
  void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[1] === 'todos' })
  toast(`Filed "${todo.summary}" to the backlog.`)
  routerNavigate('/tasks')
  return
}
```

- **`routerNavigate('/tasks')`** — this must use React Router's global navigator (imported under
  an explicit alias), not `@/lib/project-router`'s scoped `navigate`: the latter prefixes an
  active scope and would produce the nonexistent `/p/:projectId/tasks` route. `/tasks`
  (`packages/web/src/routes.tsx:454`) takes no `tab` search param; its URL
  state is `GlobalTasksUrlState` (`lib/global-tasks.ts:449-460`: `filters`, `groupBy`, `view`
  Active/Archived, `filedFilters`, `filedSort`). The Filed section renders on **both** views
  (`global-tasks.tsx:528-531, 696-698`), so a bare `routerNavigate('/tasks')` already lands the user on
  a page showing it — no param needed.
- **Workspace-run guard reused, not duplicated.** The existing `workspaceActive` branch
  (`:495-527`) already special-cases the workspace-wide composer before any run-mode check runs.
  Backlog mode is **not offered when `workspaceActive`** (`POST /todos` is project-scoped —
  `/p/:projectId/todos` — and there is no project selected in that state; see Open question 3
  below, resolved as: the Backlog segment is **hidden**, not disabled, while `workspaceActive` —
  following `worktreeToggleShown = hasGit && !workspaceActive` (`:341`), whose own comment
  (`:332-341`) states the reason for the pattern verbatim: "hides both rather than disabling
  them … a control would be a lie" for a control a workspace run would ignore. This is a
  rendering condition on `ModeSegment`'s third option, not a new code path.
  **Sticky `runMode: 'backlog'` under `workspaceActive`:** `ModeSegment` renders unconditionally
  today (`:848-852`) and the draft persists across the project-pill flip, so a user who picked
  Backlog and then switched the pill to Auto must not silently start a cross-project run. Pinned:
  while `workspaceActive`, a stored `runMode: 'backlog'` is treated as `'start'` — the same
  outcome the `workspaceActive`-first branch at `:495` already produces for every other mode —
  and `sendAriaLabel` (`:697`, currently `draft.planFirst && !workspaceActive ? 'Plan task' :
  'Start task'`) keeps its existing `!workspaceActive` guard unchanged: only `'plan'` needs the
  special label, so it becomes `draft.runMode === 'plan' && !workspaceActive`, which already
  covers `'backlog'` falling through to "Start task".
- **No plan step, no picker gating.** Unlike Start/Plan-first, Backlog does not require
  `providersReady`/`runner` (no agent runs) and does not call `postPlan`. It only needs the typed
  text. Any picker choices (skill, workflow, runner, model) the user made are simply **not sent**
  — a filed todo carries `summary` only, matching the CLI's bare-summary form (open question 2,
  resolved: no extra fields at creation, `context`/`acceptanceCriteria`/etc. stay agent-only until
  a future request asks for them). This mirrors how Plan-first already ignores irrelevant picker
  state.
- **The composer remains editable without a provider in Backlog mode.** `Composer.disabled`
  disables the textarea as well as submit, so the current unconditional `!providersReady` term
  cannot remain. Define the effective backlog path as
  `draft.runMode === 'backlog' && !workspaceActive`; disable for provider readiness only when that
  expression is false, while `starting` and `workspaceRun.isPending` continue to disable every
  path. Apply the same condition to `disabledReason`. This keeps a sticky Backlog selection under
  `workspaceActive` on the existing Start semantics, including its provider gate.
- **`origin: 'composer'`** is sent explicitly in the `createTodo` call body (the schema's
  already-reserved value, `packages/contract/src/skills.ts:106`). It is storage provenance, not a
  unique analytics discriminator: `workspace-reports-routes.ts:322-324` already writes the same
  origin. For later analytics, this UI path is identified by the route-authored
  `todo.author.via === 'todo-create-route'`; the CLI remains `cli-todo-add`, and server-side report
  ingestion has its own author path.

### The API client function (the actual missing piece)

`packages/web/src/api/client.ts`, beside `getTodos` (`:788`), following the exact shape of the
sibling wire calls in the same file (`removeTodo`/`startTodo` pattern — scoped project param,
`unwrap`, typed response):

```ts
export async function createTodo(input: CreateTodoInput): Promise<CreateTodoResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].todos.$post({
      param: { projectId: queryScope() },
      json: input,
    }),
    '/todos',
  )
}
```

`CreateTodoInput`/`CreateTodoResponse` already exist in `@loki-labs/cezar-plus-api-client`
(generated from `createTodoInputSchema`/`createTodoResponseSchema`,
`packages/contract/src/skills.ts:138-155`) — no
contract change. A thin `useCreateTodo()` `useMutation` wrapper in `queries.ts` (same file every
other client function gets a hook in) is optional polish; the composer can call `createTodo`
directly inside its own `submit()` the way it already calls `createRun`/`postPlan` inline.

## Architecture

```
/new composer (draft.runMode: 'start' | 'plan' | 'backlog')
        │
        ├─ 'start'   → createRun(...)              → navigate(startedRunPath(created))     [unchanged]
        ├─ 'plan'    → postPlan(...) → plan-review  → startPlanned() → createRun(...)       [unchanged]
        └─ 'backlog' → createTodo({ summary, origin: 'composer' })
                            │
                            ▼
                     POST /p/:projectId/todos   (server.ts:5830, unchanged)
                            │
                            ▼
                     .ai/cezar/todos.json  (status: 'todo', no startedTaskId)
                            │
                somewhere already reads this ─┬─ GET /workspace/todos → Filed board (global-tasks.tsx)
                                               └─ GET /todos → /tasks (project-scoped view)
```

No new entity, no new route, no new store. The only new edges in this diagram are the top box
(`runMode`) and the `createTodo` call — everything below `POST /todos` already exists and is
already exercised by `cezar todo add`.

## Data model / API

- **`NewTaskDraft.planFirst: boolean` → `NewTaskDraft.runMode: 'start' | 'plan' | 'backlog'`**
  (`new-task-draft.ts`). Client-only, `localStorage`-backed; no wire schema involved. Backward
  read compatible per "The control" above.
- **`createTodo(input: CreateTodoInput): Promise<CreateTodoResponse>`** — new client function,
  `packages/web/src/api/client.ts`. Wire contract (`packages/contract/src/skills.ts:138-155`) is
  unchanged and already shipped:
  ```ts
  // request body (only `summary` sent by this feature; everything else stays available for a
  // future richer composer, unused here)
  { summary: string, origin: 'composer', ... }
  // response, 201
  { todo: TodoItem }
  ```
- **No schema change.** `origin: 'composer'` already exists in `todoItemSchema`
  (`packages/contract/src/skills.ts:106`) and is already sent by
  `packages/cezar/src/server/workspace-reports-routes.ts:322-324`. This feature reuses that value;
  `todo.author.via === 'todo-create-route'` identifies todos created through the HTTP route.

## Phases (independently shippable)

1. **`createTodo` client function.** Add it to `client.ts` per "The API client function" above.
   Shippable and testable alone — nothing calls it yet, so it changes no behavior; verified by a
   unit test hitting the mock server the same way `startTodo`'s tests do.
2. **`runMode` draft migration.** Replace `planFirst: boolean` with `runMode` in
   `new-task-draft.ts`, update every read site in `new-task.tsx` 1:1 (`planFirst` →
   `runMode === 'plan'`), **no new UI yet** — `ModeSegment` still renders two options, mapped onto
   the new field. Shippable alone: behavior is byte-identical to today. **Not** verified by the
   existing suite passing unmodified — it does not, as written: `new-task-draft.test.ts:224-229`,
   `:250-261`, and `:265-277` construct full `NewTaskDraft` literals containing `planFirst: false`;
   the existing `toMatchObject` at `:207-217` also asserts `planFirst: true`,
   and `new-task.test.tsx:37-40`, `:483`, `:848` do the same, so dropping the field breaks both
   typecheck and the exhaustive `toEqual`s. Verification is instead: those six literals are
   updated mechanically to `runMode: 'start'`, the suite is green after that mechanical change,
   and a new case covers the legacy `{ planFirst: true }` → `runMode: 'plan'` fallback.
3. **The `Backlog` segment + submit branch.** Add the third `ModeSegment` option, the
   `runMode === 'backlog'` branch in `submit()`, and the `workspaceActive` disable/hide condition.
   This is the phase that ships the actual feature; 1 and 2 are refactors it depends on.
4. **(Deferred, optional) Quick-add directly on the Filed board.** `global-tasks.tsx`'s
   `FiledTasks` section (`:667+`) already has Start/Archive per row (`useStartFiledTask`,
   `useUpdateFiledTodo`, both local hooks at `:1329`/`:1354`) but no "add a row" affordance. A
   lightweight inline add (reusing the same `createTodo` from Phase 1) would let someone already
   on the Filed board skip the composer entirely. Not required to satisfy the owner's ask — the
   composer path alone closes the gap — and deferred for the same reason Phase 3 of the
   2026-08-19 spec was deferred: ship the core mechanism first, add a second entry point only if
   asked for.

## Open questions this spec settles

1. **Where does the control live?** The `/new` composer's `ModeSegment`, third option. Resolved
   above — no second page, no Filed-board control in the initial ship (Phase 4 defers that).
2. **What fields at creation?** `summary` only, matching the CLI's bare-summary form. Resolved —
   no new UI for context/acceptance criteria/priority at this time.
3. **Per-project only, or also workspace-level?** Per-project only. `POST /todos` is
   project-scoped; the Backlog segment is disabled/hidden while `workspaceActive`. `/workspace/new`
   is explicitly out of scope (its note→triage pipeline has no "file only" state to hook).
4. **Naming/analytics.** Reuse `todo.filed` (`origin`, `project`, `hasSpec`, `author.via`) from the
   2026-08-19 spec. `origin: 'composer'` is not unique to this path — workspace report ingestion
   already uses it — so `author.via: 'todo-create-route'` distinguishes a todo filed through the
   HTTP creation route from `cli-todo-add` and other server-side writers. Same `TODO(analytics)`
   status as that spec — no telemetry sink exists in the codebase yet; this spec does not add one.

## Risks

- **Draft migration regresses existing users' sticky Plan-first choice.** Mitigated by the
  read-side fallback in `normalize()` (see "The control") — a stored `planFirst: true` becomes
  `runMode: 'plan'` on first read after this ships, not silently reset to `'start'`. Covered by a
  new `new-task-draft.test.ts` case asserting exactly this.
- **`workspaceActive` Backlog affordance shown but non-functional.** If the disable/hide condition
  is missed, a user could pick Backlog while no project is scoped and get a confusing 400/404 from
  `POST /todos` (which requires `:projectId`). Mitigated by gating the render, not the submit —
  the same pattern the composer already uses for other project-only controls — and covered by a
  component test asserting the segment is absent/disabled under `workspaceActive`.
- **Silent scope creep back toward the rejected fan-out.** Any future edit to this feature that
  makes one Backlog submit write more than one todo, or write into more than the currently-scoped
  project, reproduces the exact shape the owner rejected in
  `2026-08-15-knowledge-grounded-task-fanout.md`. Flagging directly in code (a comment on the
  `runMode === 'backlog'` branch) is worth doing at implementation time so a later editor sees the
  constraint before extending it.

## Verification (plan the test up front)

- **Unit — `client.test.ts` (or sibling):** `createTodo` posts to `/p/:projectId/todos` with the
  given `summary`/`origin: 'composer'` and returns the parsed `{ todo }`; mirrors the existing
  `startTodo`/`removeTodo` test shape in the same file.
- **Unit — `new-task-draft.test.ts`:** `normalize()` maps a legacy `{ planFirst: true }` draft to
  `runMode: 'plan'`, `{ planFirst: false }`/absent to `runMode: 'start'`, and a fresh
  `{ runMode: 'backlog' }` draft round-trips unchanged.
- **Component — `new-task.test.tsx` (existing suite, extended):**
  - Selecting `Backlog` and submitting calls `createTodo` (mocked) and **not** `createRun`/
    `postPlan`; asserted the way the file's existing mutation-table tests already assert which
    calls did/did not fire for Start vs. Plan-first.
  - After a successful Backlog submit: the draft text clears (`clearDraftText`), the `todos` query
    predicate is invalidated, and global navigation lands on the Filed view without a project
    prefix.
  - With no provider connected, the Backlog option and textarea remain usable while Start and
    Plan-first remain gated; a sticky Backlog choice under `workspaceActive` remains provider-gated.
  - While `workspaceActive`, the `Backlog` option does not render (or renders disabled) — the
    per-project-only constraint holds at the UI layer, not just the server's.
- **Integration (existing pattern, `todos` route tests):** confirm `POST /todos` with
  `origin: 'composer'` behaves identically to `origin: 'agent'` today (it already does — this is a
  regression check, not new server behavior) and the resulting entry appears in `GET
  /workspace/todos` and the Filed board with `status: 'todo'`, no `startedTaskId`.
- **Focused Vitest:** run the repository's pinned test command:
  `npm test -- packages/web/src/api/client.test.ts packages/web/src/routes/new-task-draft.test.ts packages/web/src/routes/new-task.test.tsx`
  before the full gates.
- **E2E (the acceptance test):** run `npm run test:e2e`, then use the real cockpit to open `/new`
  for a project, type a task summary, select **Backlog**, and submit. Assert: no run starts (no new
  row under Runs), a new row appears on the Filed board with the typed summary and `status: todo`,
  and clicking **Start** on that row later starts it exactly as an already-filed CLI todo would.
  Record the cockpit walkthrough and retain both a screenshot of the Filed row and the full video
  under the run's `.ai/qa/artifacts/` directory. A skipped browser run or missing screenshot/video
  leaves the feature at **QA Needed**.
- **Full repository gates, in order:** `npm run typecheck`, `npm test`, `npm run test:unit`,
  `npm run build`, and `npm run test:package`.

## Out of scope

- **`/workspace/new`** — its submit is a note→triage pipeline with no "file only" state; adding
  one is a separate, larger design (would need to decide what a triage-less note even means) and
  no owner ask covers it.
- **`startWorkspaceRun`/`POST /workspace/runs`** — starts a cross-project run by design; unrelated
  to filing a single project's backlog todo.
- **The Filed board quick-add control** (Phase 4 above) — deferred, not required to close the gap
  the owner asked about.
- **Richer creation fields** (`context`, `acceptanceCriteria`, `priority`, `skill`, `spec`) in the
  human UI — the CLI already supports all of them for agents; adding UI for them is a future
  request, not this one.
- **Any change to `--start`/`autostart`/`cezar todo add`** — that mechanism is already implemented
  and untouched by this spec.
