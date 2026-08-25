# Composer dispatch mode shapes the plan

- **Status:** Specified, not implemented
- **Date:** 2026-08-25
- **Task:** "Make input-to-tasks honor composer dispatch mode"
- **Brief:** `.ai/specs/briefs/2026-08-25-composer-dispatch-mode.md` (read in full; every citation
  below was re-opened in the tree at `2fd01a16`, not taken from the brief)
- **Extends:** `.ai/specs/2026-08-25-workspace-scope-routes-tasks.md` (`dc64b741`, `eb9c033d`,
  `7e82ce10`, `2fd01a16`)

## TLDR

The composer's **Start filed tasks** checkbox becomes a fact about the run's PLAN, not a string
inside a prompt. When it is off, `input-to-tasks` is frozen at creation as a **two-step** workflow
(`context`, `file`), the `dispatch` step is not in `workflowDef`, not in `run.steps`, and
therefore never spawns a session or spends a token. When it is on, `dispatch` survives and is
handed the **explicit list** of todos the `file` step created, so "mark every filed todo" is
checkable rather than remembered.

The list itself is the second half of this change: every todo `cez todo add` files from inside a
run already carries `author.parentTaskId = <run id>` and `author.parentStepId = 'file'`
(`runs/task-author.ts:120-160`; measured on production todo `1da9c2bb` below). That is a durable,
structured record nobody has to parse out of agent prose. The run record gains `filedTodos` built
from it, the thread renders one link per todo into that todo's own project's Filed board, and two
metric events distinguish `filed-only` from `filed-and-dispatched`.

## Problem

### 1. The optional step is not optional; it is a step that always fires and then declines

`INPUT_TO_TASKS_WORKFLOW` (`packages/cezar/src/workflows/types.ts:441-523`) has three steps
unconditionally. `dispatch` opens with:

> `This step is OPTIONAL and is a no-op unless this task was created with auto-start enabled.`
> `Auto-start for this run: {{autoStart}}`

`{{autoStart}}` is rendered by `applyTemplate` (`workflows/run.ts:7888-7890`) from the RECORD
(`run.ts:6417-6419`), which is right and stays. But the topology is decided before that: `startRun`
persists `steps: workflow.steps.map(...)` and `workflowDef: workflow` (`run.ts:1550-1556`) from the
def `resolveWorkflow` handed the route. So `false` costs a full agent step (a spawned session, a
system prompt, a turn, tokens, a step row on the board, and wall clock) to be told to do nothing.

The design said so on purpose: *"It also makes the optional half a genuine no-op"*
(`types.ts:433-436`), and V5 of the prior spec asserted exactly that behaviour
(`.ai/specs/2026-08-25-workspace-scope-routes-tasks.md:417-420`). **This task overrules that
decision**, and the acceptance criterion is explicit: *auto-start off produces no dispatch step,
agent session, or token usage.* Both statements must be corrected in place, not merely appended to
(Phase 5).

Production evidence that the OFF path really does spend the turn: run `ed71bbd9`, 2026-08-25 12:20
UTC, `autoStart` absent, *"All three steps green"* and *"dispatch started nothing"* (commit
`eb9c033d`). Its own record is no longer in any reachable `runs.json` on this box (checked:
`/var/lib/cezar/loki-labs/.ai/cezar/runs.json`, `.../cezar/...`, `.../chat/...`; absent from all three), so the
step-level token figure cannot be quoted; the commit message is the record. The **todo** it filed
is still there and is quoted below.

### 2. The completion surface is prose, and prose is not a link

The `file` step's prompt ends *"Report the todo id and project for each one you filed."*
(`types.ts:513`). That report is free text in a transcript. Nothing in the codebase turns it into a
navigable row: there is no `filedTodos` anywhere in `packages/` (grepped, zero hits), no completion
component, and no per-todo deep link. The Filed board's detail dialog opens from React state only
(`web/src/routes/global-tasks.tsx:755`, `1347-1376`), and the only URL params the page understands
are the facets (`lib/global-tasks.ts:428-443`, `lib/filed-tasks.ts:227-231`). So after a workspace
run finishes, reaching what it filed means: read the transcript, go to `/tasks`, find the row.

### 3. A restart can resurrect a step the plan dropped

Not a defect today (there is nothing to drop today), but it becomes one the moment Phase 1 lands.
`reviveWorkflow` (`run.ts:2769-2777`) prefers the persisted `workflowDef` and falls back to *the
catalog by name*. `defDescribesRun` (`runs/chain.ts:40-46`) only checks that every RECORD step is
present in the DEF: a two-step record against the three-step catalog def passes it, and
`firstUnfinishedStep` then points at `dispatch` and runs it. A run whose `workflowDef` failed to
parse (`runs/store.ts:590` `.catch(undefined)`) would therefore start tasks the user never asked to
start. The shaper has to be applied on that fallback path too, from the same frozen field.

### 4. "Marks every filed todo" is currently unfalsifiable

`dispatch` is told *"for each todo the previous step filed"*, from the transcript. Nothing pins the
set, so "every" cannot be asserted by a test or seen by a reader. The ledger in Phase 2 is what makes
the acceptance criterion checkable.

## Solution

Four moves, each independently shippable.

1. **Freeze the plan, not the prompt.** A pure shaper drops `dispatch` from the built-in
   `input-to-tasks` def when the composed `autoStart` is not `true`. Applied at the one route that
   owns a workspace run's fixed decisions, and re-applied on the catalog-revival fallback.
2. **Build a ledger of what was filed**, derived from `author.parentTaskId`, persisted on the run
   record as `filedTodos`.
3. **Hand the ledger to `dispatch`** through a new `{{filedTodos}}` token, so the ON path names
   every todo it must mark.
4. **Render the ledger as links** in the thread, into a new `fdetail` deep link on the Filed board.

### Why `author.parentTaskId` and not a parsed report

It already exists, it is already written on every filing, and it is written by the CLI rather than
by the model. Measured on this box, production todo `1da9c2bb-fec2-43b9-9f91-4f13eb32fcc4` on the
`cezar` board, filed by run `ed71bbd9` at 12:21:49Z:

```json
"author": { "kind": "agent", "id": "ed71bbd9-5918-447a-a691-b4b27147c036",
            "via": "cli-todo-add", "at": "2026-08-25T12:21:49.441Z",
            "parentTaskId": "ed71bbd9-5918-447a-a691-b4b27147c036",
            "agentSessionId": "7af73263-fa82-...", "parentStepId": "file" }
```

`autostart` is **absent** on it, which is the OFF path's on-disk signature. (Note for the reader of
`eb9c033d`, which says the todo *"carries autostart:false"*: the key is absent, not `false`.
`todos.ts` writes the flag only as `true` (`UpdateTodoPatch.autostart?: true`, `todos.ts:663-676`).
Same meaning, and the distinction matters for the test in V4.)

The schema makes an `agent` author refuse to exist half-formed: `taskAuthorSchema`'s `.refine`
requires both `parentTaskId` and `agentSessionId` (`runs/task-author.ts:49-53`), so a filing either
carries usable provenance or is not an agent filing at all. Deriving the ledger is idempotent, which
is what makes restart behaviour deterministic without a second persisted decision.

### What is deliberately NOT in scope

- **Cold-project intent discovery** (`e8a2b1d6`, `.ai/specs/2026-08-25-lazy-project-watchers.md`),
  landed on `origin/main`, QA Needed. It is downstream of `autostart: true` being written, on the ON
  path only. This spec must neither duplicate nor undo it, and nothing here touches
  `todo-autostart.ts`.
- **The Backlog composer** (`48f9892c`, `.ai/specs/2026-08-24-land-the-backlog-composer.md`), a
  single-project, filing-only composer mode. Different control, different scope; not repurposed.
- **Bulk start** (`7932cf4d`), reused as precedent for the `<project>:<todo-id>` key shape and
  nothing else.
- Phase 4 of the prior spec (deleting the cross-project worktree machinery) stays blocked on its own
  drain measurement.

## Architecture

```
composer  ──autoStart?──▶ POST /api/v1/workspace/runs
                          workspace-run-routes.ts
                            resolveWorkflow(...)          ← injected, unchanged
                            inputToTasksPlan(def, on)     ← NEW, pure  (types.ts)
                                 off → steps: [context, file]
                                 on  → steps: [context, file, dispatch]
                          startRun(shapedDef, input)
                            persists run.steps + run.workflowDef  ← THE FROZEN PLAN
                            persists run.autoStart                ← unchanged
                            metric run.input_to_tasks.planned     ← NEW

RunManager
  isBuiltInInputToTasksRun(run)  ← NEW shared predicate, gates EVERYTHING below
  after step 'file' settles ─▶ collectFiledTodos(runId)   ← NEW
        WorkspaceTodoIndex over run.workspaceProjects (the FROZEN grant, not the registry)
        keep todo.author.parentTaskId === runId
     ─▶ run.filedTodos = { items[], at }                  ← NEW record field
  step 'dispatch' prompt  ◀── {{filedTodos}}              ← NEW token, from run.filedTodos
  settleSuccess ─▶ re-collect (picks up autostart marks AND startedTaskId)
               ─▶ metric run.input_to_tasks.completed     ← NEW, once, guarded

cockpit
  task-thread.tsx  {run.filedTodos ? <FiledTodosCard/> : null}
     row → Link to={`/tasks?fdetail=<project>:<todoId>`}   ← the GLOBAL board, never scopeTo
  global-tasks.tsx  reads ?fdetail → opens FiledDetailDialog on that entry
```

**The Filed board is global-only, and the link must not be scoped.** `/tasks` is registered exactly
once, outside `ProjectScopeRoute` (`web/src/routes.tsx:793`, with that route's own comment: *"every
project's tasks scoped to one project is a contradiction"*). Project scope registers
`tasks/:id`, `tasks/:id/changes`, `tasks/:id/files`, `tasks/:id/commits[/:sha]` and nothing else
(`routes.tsx:506-546`), so a `scopeTo(project, '/tasks?…')` would produce `/p/<project>/tasks`,
which matches no route and lands on the unknown-project page. The project identity travels in the
**key**, `fdetail=<project>:<todo-id>`, not in the path — which is also why one card can link rows
belonging to several different projects to one board.

Three properties fall out of putting the shaper before `startRun` rather than inside the step loop:

- Every consumer of `run.steps` (the step rail, the board's progress, `pendingChainSteps`,
  `firstUnfinishedStep`) reads the two-step plan, so an OFF run *finishes* after `file` instead of
  being one step short of complete.
- `workflowDef` is the persisted plan (`run.ts:1555`), so a restart re-enters the same two steps.
- Nothing about custom workflows changes: the shaper is a no-op unless the def is
  `source: 'built-in'` **and** `name === 'input-to-tasks'`. A repo shipping its own
  `.ai/cezar/workflows/input-to-tasks.yaml` (which `load.test.ts:150+` pins as supported) keeps every
  step it wrote.

## Phases

Each phase is independently shippable and independently green.

### Phase 1: the frozen two-step plan

- `workflows/types.ts`: export `INPUT_TO_TASKS_DISPATCH_STEP = 'dispatch'` and
  ```ts
  export function inputToTasksPlan(def: WorkflowDef, autoStart: boolean): WorkflowDef
  ```
  Returns `def` **unchanged** when `autoStart === true`, or when
  `def.source !== 'built-in' || def.name !== INPUT_TO_TASKS_NAME`. Otherwise returns
  `{ ...def, steps: def.steps.filter((s) => s.id !== INPUT_TO_TASKS_DISPATCH_STEP) }`. Pure, no I/O,
  no clock; testable as a table.
- `server/workspace-run-routes.ts:105-160`: shape between `resolveWorkflow` and `guard`, so the
  guard sees the plan that will actually run:
  ```ts
  const workflow = inputToTasksPlan(resolved.workflow, body.autoStart === true);
  ```
  `body.autoStart` stays recorded on the input exactly as today (absent / `true` / `false` remain
  three distinct answers on the record; see `workspace-run-routes.test.ts:236-251`).
- `workflows/run.ts#reviveWorkflow` (2769-2777): apply the same shaper to the **catalog fallback**
  using `run.autoStart === true`. The `workflowDef` branch is already shaped by construction and is
  left alone.
- `workflows/run.ts#startRun`: emit `run.input_to_tasks.planned` (see Analytics) alongside the
  existing `run.workflow.selected` (`run.ts:1560-1568`), for `input-to-tasks` runs only.

Ships alone. Acceptance criteria 2 and 4 are satisfied at the end of this phase.

### Phase 2: the filed-todo ledger

- `contract/src/runs.ts` + `cezar/src/runs/store.ts`: add optional `filedTodos` (Data models below).
  Optional, per `BACKWARD_COMPATIBILITY.md` §3.
- `workflows/run.ts`: `private async collectFiledTodos(runId): Promise<FiledTodo[]>`. It builds a
  `WorkspaceTodoIndex` (`workspace/todo-index.ts:65-111`) whose `listProjects` returns
  `run.workspaceProjects` mapped to `WorkspaceTodoProjectSource`, call `list()`, keep entries whose
  `todo.author?.parentTaskId === runId`, map to
  `{ project, todoId, summary, autostart, startedTaskId }` with `summary` truncated to the schema's
  500 (Data models), sort by `todo.ts` then `todoId`, **uncapped**. Reusing the index rather than
  `readTodos` per root means a missing or unreadable project degrades exactly the way the Filed
  board already degrades.
- Call sites: once when the `file` step reaches a terminal status, and once in `settleSuccess`
  (`run.ts:7375`) before the status flip, so the ON path's marks land in the record — `autostart:
  true` for a todo still awaiting pickup, `startedTaskId` for one the watcher already claimed. Both
  writes are whole-array replacements of a derived value, so ordering and repetition are harmless.
- Guard: `isBuiltInInputToTasksRun(run)` and nothing looser (see Analytics for its definition —
  it is one exported predicate, used by planning, collection and both metrics). Never for an
  ordinary project run, and never for a repo's own workflow that merely shares the name.

Ships alone; nothing renders it yet.

### Phase 3: dispatch reads the ledger

- `applyTemplate` (`run.ts:7888`) gains `{{filedTodos}}`, rendered from `run.filedTodos.items` as
  one line per todo (`- <todoId>  --project <projectId>  <summary>`), or the literal `(none)` for an
  empty ledger. Unknown-token behaviour is unchanged: `replaceAll` touches only what it matches.
- `{{autoStart}}` **stays supported** in `applyTemplate`. It shipped yesterday and a user's own
  workflow file may already use it (`BACKWARD_COMPATIBILITY.md` §4 protects the token vocabulary).
  It is simply no longer needed by the built-in `dispatch` prompt.
- Rewrite the `dispatch` prompt (`types.ts:508-523`): drop the "OPTIONAL / no-op / if that says
  false" branch entirely (the step now exists only when auto-start is on) and give it the frozen
  list plus the instruction to mark **every** entry with `cez todo start <id> --project <id>` and to
  report any it could not mark and why. Keep `allowedTools: ['Read', 'Bash']` and the
  `cez todo`/`cezar todo` allowlist: no step of this workflow may ever hold `Edit`/`Write`
  (`types.ts:437-440`, pinned by `load.test.ts:125-136`).
- Rename the step: `name: 'Start the filed tasks'` (the trailing `(optional)` is now false on every
  run that has the step). `id` stays `dispatch`: it is the chain-resume key and a record field.

Ships alone. Acceptance criterion 3 is satisfied at the end of this phase.

### Phase 4: completion links

- `web/src/lib/filed-tasks.ts`: add `detail: 'fdetail'` to `FILED_SEARCH_PARAMS` (227-231) and a
  pure `parseFiledDetailKey(value): {project, todoId} | null` beside `filedTaskKey` (235-237), which
  keeps `<project>:<todo-id>` spelled in exactly one place. A todo id is a UUID and a project slug
  contains no `:`, so split on the **first** `:`.
- `web/src/lib/global-tasks.ts`: carry `filedDetail` through `urlStateFromSearchParams` /
  `urlStateToSearchParams` (428-443, 487-499) like every other facet, so it survives a filter change
  and round-trips.
- `web/src/routes/global-tasks.tsx`: when `filedDetail` names an entry present in the loaded
  workspace todos, open `FiledDetailDialog` on it; closing the dialog clears the param. A param
  naming a todo the board cannot see renders **a visible "that task is no longer on this board"
  empty state**, never a silent no-op. That is the vacuous-pass lesson of
  `.ai/specs/2026-08-22-deploy-e2e-probe-vacuous-pass.md`.
- `web/src/routes/task-thread/filed-todos-card.tsx` (new): renders `run.filedTodos`, one row per
  todo: summary, project, short id, and a *started* pill on any row that counts as marked
  (`autostart === true` **or** `startedTaskId` present — Data models). Each row is a
  `Link to={'/tasks?fdetail=' + encodeURIComponent(key)}` — the **global** board path, written
  plainly and **not** through `scopeTo`, because `/tasks` exists only outside project scope
  (`routes.tsx:793`) and `/p/<project>/tasks` is not a route. The project travels in the key.
  Header states the mode in words: *"Filed 3 tasks"* / *"Filed 3 tasks and started them"*.
- `web/src/routes/task-thread/task-thread.tsx:385-386`: render it beside `ApprovalCard` and
  `HandoffCard` as `{run.filedTodos ? <FiledTodosCard key={run.id} run={run} /> : null}`.
- Zero todos renders the card with an explicit *"Filed nothing"* line rather than nothing at all: a
  run that correctly decided the work already exists (`types.ts:511`) must not look like a run whose
  card failed to load.

Ships alone. Acceptance criterion 1 is satisfied at the end of this phase.

### Phase 5: correct the record, in place

Required, and part of the same change, per the workspace correction rule:

- `.ai/specs/2026-08-25-workspace-scope-routes-tasks.md`, **V5** (417-420) and the *"genuine
  no-op"* rationale quoted at 433-436 of `types.ts` and restated at 522-548 of that spec. Each gets a
  bolded `SUPERSEDED 2026-08-25 by 2026-08-25-composer-dispatch-mode.md` lead-in with the original
  text left below it unchanged, saying what replaced the mechanism (plan shaping, not a prompt
  branch). Also the claim in its production-verification section that the deployed `dispatch` step
  carries `{{autoStart}}`: true when written, false after Phase 3.
- `packages/cezar/src/workflows/types.ts:432-436`, the docblock paragraph that argues for the
  always-present optional step, corrected in place for the same reason.
- `README.md` and `CHANGELOG.md` (Changed, under Unreleased). `BACKWARD_COMPATIBILITY.md` §3 gains
  the `filedTodos` additive note.
- KB: one `upsert` through `CEZ_KB_WRITE_FILE` recording the decision (dispatch mode is a plan
  decision, frozen at creation), superseding the prior entry's no-op claim.

## Data models

`RunRecord.filedTodos`, new, optional, on both the wire schema (`contract/src/runs.ts`) and the
persisted twin (`cezar/src/runs/store.ts`), the way `workspaceProjects` and `testAttestation`
already are:

```ts
export const filedTodoSchema = z.object({
  /** Registry slug of the project whose board holds it, the link's first half. */
  project: z.string(),
  /** The todo's own id, the link's second half. */
  todoId: z.string(),
  /** PREVIEW of the summary as filed, so the card stays readable if the row is later edited.
   *  Deliberately bounded, and the source is NOT: `todoSchema.summary` is `z.string().min(1)`
   *  with no upper bound (`todos.ts:46`), so a copy-through would let one legitimately long todo
   *  make the whole run record fail `runRecordSchema` and take the ledger down with it. The
   *  collector truncates instead, deterministically — first 497 code units + `'…'` — so the
   *  bounded field can never be the reason a valid todo is unrepresentable. */
  summary: z.string().max(500),
  /** `true` while the mark is still PENDING pickup. Absent on every filed-only run, matching
   *  `todos.json`, where the flag is only ever written as `true` (`todos.ts` UpdateTodoPatch)
   *  and is DELETED again the moment the watcher claims it. */
  autostart: z.literal(true).optional(),
  /** The run the todo was picked up as. Stamped by `markStartedWithClaim` in the same write that
   *  deletes `autostart` (`todos.ts:930-937`). Present only on the ON path, after pickup. */
  startedTaskId: z.string().optional(),
});

filedTodos: z.object({
    /** EVERY todo this run filed into its granted projects. Deliberately UNCAPPED: the
     *  acceptance criterion is "links every created todo", and any cap silently turns that into
     *  "links a bounded subset" — the truncated tail is exactly the part nobody notices is
     *  missing. An entry is ~120 bytes; a run that files thousands is a different bug, and one
     *  that stays visible precisely because the ledger did not hide it. */
    items: z.array(filedTodoSchema),
    /** When the ledger was last derived. */
    at: z.string(),
    /** Set by the one emission of `run.input_to_tasks.completed`; its presence is the
     *  double-count guard for restarts and chain re-entries. */
    summaryEmittedAt: z.string().optional(),
  }).optional()
```

**A todo counts as successfully marked when `autostart === true` OR `startedTaskId` is present.**
The flag alone is not proof of dispatch, and this is the one non-obvious fact in the data model.
`markStartedWithClaim` (`todos.ts:900-937`) stamps `startedTaskId` and `delete item.autostart` in
the *same* write, with the reason in its own comment: *"leaving it `true` next to a
`startedTaskId` would read as 'still pending' to the next reconcile pass."* So a **fast** pickup —
the autostart watcher claiming a todo before `settleSuccess` re-derives the ledger — leaves a
correctly-marked todo carrying no `autostart` at all, and a ledger that read the flag alone would
report the ON path as having marked nothing. Both the card's *"and started them"* header and the
`autostartMarked` dimension use the OR, never `autostart` alone. **V4 exercises watcher consumption
before final settlement**, so this is a tested property rather than a remembered one.

The ledger is a snapshot at derivation time, not a live view: `unmarkStarted` (`todos.ts:990-1010`)
can clear `startedTaskId` on a later cancel, and that does not rewrite a settled run's record. That
is intended — the record answers "what did this run file, and did it mark them", not "what is the
state of those todos now", which the linked board answers.

Derived, never authored: the source of truth stays each project's `todos.json`. Absent on every
pre-existing record and on every non-workspace run, so a consumer that ignores it reads exactly the
pre-existing shape.

No change to `todoSchema`, to `TodoItem`, or to `todos.json`.

## API contracts

- `POST /api/v1/workspace/runs`: **request unchanged**. `autoStart` stays an optional boolean on
  the `.strict()` `workspaceRunStartInputSchema` (`contract/src/workspace-run-start.ts:44-64`);
  absent still means off; a non-boolean still 400s. The **response** changes only in that
  `run.steps` has two entries instead of three when auto-start is off, which is the observable
  contract of this whole spec, and what the E2E asserts.
- `GET /api/v1/runs/:id`, `GET /api/v1/p/:projectId/runs`, and the SSE `run` frames all carry the
  new optional `filedTodos`. Additive; `api-types.test.ts`'s contract-parity check keeps the api-client
  mirror type-exact.
- `POST /p/:projectId/todos/:id/start`, `GET /api/v1/workspace/todos`: **unchanged**. The card
  links to a page; it starts nothing itself.
- Cockpit URL: `/tasks?fdetail=<project>:<todo-id>` is a new **additive** query param on the
  existing **global** Filed board route (`routes.tsx:793`). Not `/p/<project>/tasks`, which is not a
  registered route — project scope registers only `tasks/:id` and its git tabs. An older cockpit
  ignores the param and shows the board.

## Analytics

Two metric events on the run's own append-only event log (`store.appendEvent`, `type: 'metric'`),
the same mechanism `run.workflow.selected` (`run.ts:1560-1568`) and `run.resource_kill`
(`run.ts:2609-2617`) already use. (`todo-cli.ts:216-219` says no event sink exists; that is true of
the **CLI child process**, which has no store handle. The RunManager does.)

### One predicate gates all of it

`run.workflow` is a bare **name**, so `run.workflow === 'input-to-tasks'` is *not* the same question
as "this is the built-in workflow". A repo shipping its own `.ai/cezar/workflows/input-to-tasks.yaml`
(`load.test.ts:150+` pins that override as supported, and this spec promises the shaper leaves it
alone) would still match a name-only test — and would then acquire a *"Filed nothing"* card it never
asked for and emit `input-to-tasks` analytics whose `stepCount` describes somebody else's workflow.
The shaper's own conjunction and the ledger's gate would disagree, which is exactly how a "no-op"
becomes a live behaviour change for a user who opted out by writing their own file.

So there is **one** exported predicate, in `workflows/types.ts` beside `inputToTasksPlan`, and every
consumer uses it:

```ts
export function isBuiltInInputToTasks(def: Pick<WorkflowDef, 'source' | 'name'>): boolean {
  return def.source === 'built-in' && def.name === INPUT_TO_TASKS_NAME;
}

/** The run-level form: the same conjunction, plus the workspace grant this feature needs.
 *  Reads the run's own FROZEN `workflowDef`, never a re-resolution from the catalog. */
export function isBuiltInInputToTasksRun(run: RunRecord): boolean {
  return (run.workspaceProjects?.length ?? 0) > 0
    && run.workflowDef !== undefined
    && isBuiltInInputToTasks(run.workflowDef);
}
```

Used by: plan shaping (Phase 1, via `isBuiltInInputToTasks` on the resolved def), ledger collection
(Phase 2), and **both** metrics below. Nothing in this feature may test `run.workflow` by name.

| Event | Emitted | Dimensions |
| --- | --- | --- |
| `run.input_to_tasks.planned` | once, in `startRun`, only when `isBuiltInInputToTasks(shapedDef)` and the run carries a workspace grant | `dispatchMode: 'filed-only' \| 'filed-and-dispatched'`, `stepCount` (2 or 3), `runId` |
| `run.input_to_tasks.completed` | once, in `settleSuccess`, only when `isBuiltInInputToTasksRun(run)`, after the final ledger write | `dispatchMode`, `todoCount`, `autostartMarked` (count where `autostart === true` **or** `startedTaskId` is present — Data models), `projectCount` (distinct), `runId` |

`planned` is emitted at CREATION and not from `execute()`, for the reason `run.workflow.selected`'s
own comment gives: `execute` re-enters on every reattachment and chain re-entry, which turns "once
per run" into a silent overcount on exactly the long, interrupted runs a rate most needs to count
honestly.

`completed` cannot use that trick: `settleSuccess` has three callers (`run.ts:7375-7383`) and a
restart-settle or a continuation can reach it again. So it is guarded by
`filedTodos.summaryEmittedAt`: written in the same `updateRun` as the final ledger, checked before
emitting. A second settle re-derives the ledger (cheap, idempotent) and emits nothing.

The pair answers the question this change exists for: **how often is the composer's dispatch mode
actually used, and does the ON path mark everything it filed?** `autostartMarked < todoCount` on a
`filed-and-dispatched` run is a defect signal, and the whole point of Phase 3's frozen list is that
this comparison is now meaningful.

## Backward compatibility

cezar is published (`@loki-labs/better-cezar`), so `BACKWARD_COMPATIBILITY.md` applies and the
house "no backward compatibility" default does not.

- **§3 state files.** `filedTodos` is optional and additive; absent on every existing record. Never
  required, never backfilled onto a finished run.
- **§4 workflow format.** `{{task}}` and `{{autoStart}}` both keep working. `{{filedTodos}}` is a
  new token; an unknown token still passes through verbatim, so nothing a user wrote changes
  meaning. A repo's own `input-to-tasks.yaml` override is untouched by the shaper, by construction.
- **The built-in workflow's own topology is not a protected surface.** §4 protects the file
  *format*, the `{{task}}` token, and the `quick-task` name; a built-in's step list is not listed
  there, and `spec-to-deploy` has been reshaped before. The user-visible change is that an
  auto-start-off workspace run now has two steps. That is the requested behaviour, and it is called
  out in `CHANGELOG.md` under Changed.
- **A run created before this change** keeps its three-step `workflowDef` and re-enters it exactly
  as today; the shaper never rewrites a persisted def.

## Risks

- **A restart resurrects `dispatch`.** The catalog-revival fallback in `reviveWorkflow` returns the
  unshaped built-in, and `defDescribesRun` will not object (a two-step record is a subset of the
  three-step def). Mitigation: shape on that path too, from `run.autoStart`. **V3 tests exactly
  this, with the fallback forced.** This is the single most likely way the feature silently
  regresses.
- **The ledger over-collects.** `author.parentTaskId` is the *parent task*, which is also stamped on
  todos a nested `cezar todo add` files from a sub-agent. For `input-to-tasks` that is the same run
  and the same intent, so it is wanted, not a leak. But the filter must be scoped to the run's
  **frozen grant** (`run.workspaceProjects`), never `listProjects()`, or a project registered
  mid-run appears in a finished run's ledger.
- **The ledger under-collects.** A todo the agent filed into a project outside the grant, or through
  a path that does not set `CEZ_TASK_ID`, is invisible. Accepted: the grant is the run's whole
  world, and a filing outside it is already a bug. The card's count is stated as "what this run
  filed into its granted projects".
- **A deleted or archived todo leaves a dead link.** Accepted, and handled visibly: the `fdetail`
  param renders an explicit "no longer on this board" state rather than silently doing nothing.
- **Zero todos reads as a broken card.** Handled in Phase 4 with an explicit "Filed nothing" line.
- **E2E vacuity.** Both traps from `.ai/specs/2026-08-24-land-the-backlog-composer.md:384-418` apply
  here and are designed against in V6: boot never registers its own launch directory
  (`index.ts:535`, `suppressBootRegistration()` is unconditional), so a fixture that files into the
  boot project finds an empty Filed board; and an unscoped `/api/v1/runs` read binds to the boot
  project, so "no dispatch step" asserted against the wrong scope passes vacuously.
- **A shaper that is too eager.** Filtering by step id alone would strip a `dispatch` step from a
  user's own similarly-named workflow. Mitigation: the `source === 'built-in' && name ===
  'input-to-tasks'` conjunction, asserted directly in V1.
- **A gate that is too loose, which is the same bug wearing the other face.** The shaper is
  conjunctive but the ledger and the metrics could easily be written against `run.workflow ===
  'input-to-tasks'`, which a repo's own override matches — giving a user who opted out by writing
  their own workflow file an unasked-for card and analytics that misdescribe their steps.
  Mitigation: the single `isBuiltInInputToTasksRun` predicate (Analytics), with the
  custom-workflow negative case in V5 as the regression fence.

## Verification

Gates green is necessary and not sufficient. V1 to V5 are automated; V6 is the browser proof; V7 is the
gate; V8 is production. **This is QA Needed until V6 and V8 have actually run**, and each must be
reported with its artifacts or named as not run.

**V1: the shaper is a pure table.** `workflows/input-to-tasks-plan.test.ts` (new).
`inputToTasksPlan(INPUT_TO_TASKS_WORKFLOW, false).steps.map(s => s.id)` is `['context', 'file']`;
with `true` it is `['context', 'file', 'dispatch']` and the returned object is the input unchanged.
A def with `source: 'file'` and the same name, and a built-in with a different name, are both
returned untouched with all three steps: one case per conjunct.

**V2: the route freezes the plan, in both directions, for zero/one/many.**
`server/workspace-run-routes.test.ts`, extending `describe('input-to-tasks default and autoStart')`
(193-251): assert on the def handed to `startRun` (the harness already records `started[0].input`;
it gains the workflow argument). `autoStart` absent → 2 steps; `false` → 2 steps; `true` → 3 steps.
`workflow: 'spec-to-deploy'` → untouched. An inline `steps` chain → untouched.
**Mutation check:** removing the `inputToTasksPlan` call must turn exactly the three new cases red
and nothing else.

**V3: restart is deterministic from the frozen decision.** `workflows/` integration test:
1. Start with `autoStart: false`; assert `store.getRun(id).workflowDef.steps` has 2 entries and
   `run.steps` has 2 entries.
2. Restart the manager (`recover()`) and assert the revived def still has 2 steps and no `dispatch`
   session is spawned.
3. **The fallback, forced:** blank `workflowDef` on the record (the `.catch(undefined)` shape
   `store.ts:590` produces), recover, and assert the catalog-revived def is *still* two steps.
   Without the `reviveWorkflow` change this case is red. That is its whole purpose.
4. The same three with `autoStart: true`, asserting `dispatch` is present and re-entered.

**V4: no session, no tokens, on the OFF path; every todo marked on the ON path.**
Extending `workflows/auto-start-template.test.ts` (which already captures spawn specs at
`AgentRunSpec` level, 95-134):
- OFF: run to completion against a fixture grant; assert **no spawn spec carries `stepId:
  'dispatch'`**, `run.steps` has no `dispatch` entry, and the summed `tokensUsed` across step
  records equals the sum over `context` + `file` only. Zero, one and three filed todos, all three
  producing the same "no dispatch anything" answer.
- ON: assert the `dispatch` spawn spec's `userPrompt` contains **every** filed todo id and no
  `{{` (the token rendered), and that after the step each todo in the fixture `todos.json` has
  `autostart: true`. Zero todos renders `(none)` and the step still runs and reports.
- **ON, with the watcher racing the settle — the case the flag alone fails.** After `dispatch`
  marks the fixture's three todos, call `markStartedWithClaim(dataDir, id, 'run-x')`
  (`todos.ts:900`) on **one** of them *before* letting the run settle, reproducing a fast autostart
  pickup. That todo now has `startedTaskId` and **no** `autostart` on disk. Assert the final ledger
  still counts all three as marked, and that `run.input_to_tasks.completed` reports
  `autostartMarked: 3`, not 2. **This case is red against any implementation that reads
  `autostart` alone**, which is its entire purpose; assert the on-disk shape (`autostart`
  undefined, `startedTaskId` truthy) in the same test so a future change to
  `markStartedWithClaim` cannot make it pass vacuously.
- **Mutation check:** re-adding `dispatch` unconditionally must redden the OFF cases;
  removing the `{{filedTodos}}` replacement must redden the ON cases; narrowing the marked
  definition to `autostart === true` must redden the racing case and nothing else.

**V5: the ledger and the links.**
- `workflows/` unit: `collectFiledTodos` over a two-project fixture returns only todos whose
  `author.parentTaskId` is this run, in `ts` order, with `project` set to the registry slug; a todo
  filed by a *different* run in the same board is excluded; a `missing` project degrades without
  throwing; the 200 cap sets `truncated`.
- `runs/store.test.ts`: a record round-trips `filedTodos`; a pre-existing record without it parses.
- `web/src/lib/filed-tasks.test.ts`: `parseFiledDetailKey` round-trips `filedTaskKey`, splits on the
  first `:`, and rejects garbage.
- `web/src/routes/task-thread/filed-todos-card.test.tsx`: zero, one and three todos; the href is
  `/p/<todo's project>/tasks?fdetail=<project>:<id>` (**the todo's own project, not the run's**);
  the header says "and started them" only when `autostart` is set.
- `web/src/routes/global-tasks.test.tsx`: `?fdetail=` opens the dialog on the right entry, closing
  clears the param, and an unknown key renders the visible "no longer on this board" state.

**V6: browser E2E, artifacts retained.** New `packages/web/e2e/composer-dispatch-mode.e2e.ts`,
modelled on the design in `.ai/specs/2026-08-24-land-the-backlog-composer.md:419-520`: its own free
port, its own `cezar serve` child, its own `AgentBrowser`, and **two fixture roots**, a throwaway
`hostRoot` the server boots on, and a registered `projectRoot` seeded into the hermetic
`CEZ_HOME/config.json` before boot (because the boot root is never registered, `index.ts:535`).
- **Non-vacuity guard first:** `GET /api/v1/workspace/todos` must report the fixture project with
  `ok: true` and an empty `todos` array before anything is submitted.
- **OFF:** submit at workspace scope with the chip untouched; read the created run **scoped**
  (`/api/v1/p/<boot>/runs/<id>`, never the unscoped index) and assert `run.steps` has exactly
  `['context','file']`, a *positive* assertion on the list, not "dispatch is absent", so a broken
  read cannot pass it. Then assert no filed todo carries `autostart`.
- **Links:** with a pre-seeded `filedTodos` run record (the agent itself is not driven in E2E),
  click a card row and assert the URL carries `fdetail=` and that `[data-slot="filed-task-detail"]`
  is present with the right todo id.
- **ON:** tick the chip, submit, assert `run.steps` is exactly `['context','file','dispatch']`.
- Screenshots at each assertion into `/var/lib/cezar/e2e-artifacts/composer-dispatch-<id8>/`,
  matching `.ai/specs/2026-08-25-verify-bulk-start-release.md`'s retention. **`AgentBrowser` has no
  video capture** (`packages/web/e2e/agent-browser.ts:226-240` offers `screenshot` only), so the
  acceptance criterion's "artifacts" are screenshots plus the scoped JSON responses saved beside
  them. Stated here rather than promised and quietly not delivered.
- Run via `npm run test:e2e`. `TEST_E2E_STATUS=skipped` is **not** a pass (`.ai/scripts/e2e.sh:19-32`)
  and must be reported as "the UI was not verified".

**V7: gates, on the box, twice.** `npm run typecheck` (all four projects) and `npm run test` twice
on an idle box, per `.ai/specs/2026-08-25-workspace-scope-routes-tasks.md:588-612`: a red that does
not move between two runs of the identical tree is a real failure; one that moves is the flake pool.
Note that spec's own finding: the Mac reports 8 pre-existing `web` errors the box does not, so quote
the box's numbers. Also run the whole-tree `upstream purity` check in
`notifications/transports/webhook.test.ts`. It scans every file under `packages/{cezar,web}/src` and
is the gate a narrow sweep misses; any new comment here must not spell a neighbouring product's
paths.

**V8: production.** Deploy the landed sha, confirm `GET /api/v1/ready` reports it, then from the
live cockpit submit one disposable workspace task with the chip **off** and one with it **on**:
- off → the run's record has two steps, its thread shows the card, each link opens the right todo's
  detail on the Filed board, and **no session or token is attributed to a `dispatch` step**;
- on → three steps, and every todo it filed carries `autostart: true`;
- clean up both runs and both todos afterwards, and say plainly if cleanup failed (the bulk-start
  E2E's cleanup failed and left two live runs,
  `.ai/specs/2026-08-24-bulk-start-filed-tasks.md:61-70`).

## What was read, and what was not

**Read in the tree at `2fd01a16`:** `packages/cezar/src/workflows/types.ts:414-523`;
`workflows/run.ts:1530-1570, 2265-2300, 2760-2810, 6400-6440, 6790-6820, 7375-7430, 7865-7895`;
`workflows/load.test.ts:110-150`; `workflows/auto-start-template.test.ts:90-134`;
`runs/store.ts:420-440, 825-880, 1151-1160`; `runs/chain.ts:40-58`; `runs/task-author.ts` (whole);
`todos.ts:428-445, 640-700`; `todo-cli.ts:180-260`; `server/workspace-run-routes.ts` (whole);
`server/workspace-run-routes.test.ts:193-255`; `server/workspace-todos-routes.ts` (whole);
`workspace/todo-index.ts:46-111`; `contract/src/workspace-run-start.ts` (whole);
`contract/src/runs.ts:394-460`; `contract/src/workspace-todos.ts` (whole);
`web/src/routes/new-task.tsx:170-190, 505-560, 865-885`; `web/src/routes/new-task-form.ts:340-370`;
`web/src/routes/global-tasks.tsx:280-330, 700-800, 1341-1380`; `web/src/lib/filed-tasks.ts:227-250`;
`web/src/lib/global-tasks.ts:428-443, 487-499`; `web/src/lib/project-router.tsx:60-80`;
`web/src/routes/task-thread/task-thread.tsx:380-425`; `web/e2e/agent-browser.ts:82-245`;
`.ai/scripts/e2e.sh:1-60`; `BACKWARD_COMPATIBILITY.md` §3 to §7; `package.json` scripts.
Specs: `2026-08-25-workspace-scope-routes-tasks.md` (whole), `2026-08-24-bulk-start-filed-tasks.md`
(whole), `2026-08-24-land-the-backlog-composer.md:384-520`.
Commits: `eb9c033d`, `dc64b741`, `e8a2b1d6`, `48f9892c`, `7932cf4d`, `2fd01a16` (`git log -1`).
Live data: `/var/lib/cezar/loki-labs/cezar/.ai/cezar/todos.json` (todo `1da9c2bb`, quoted above).

**Not found, stated rather than invented:**
- Run `ed71bbd9`'s own record is absent from every `runs.json` on this box, so its step-level token
  cost is not quotable. Commit `eb9c033d` is the only record of that run's behaviour.
- No `filedTodos`, no completion-summary component, no completion analytics event, and no per-todo
  deep link exist anywhere in `packages/` today: all four are new here.
- `.ai/specs/2026-08-25-lazy-project-watchers.md` was **not** read in this session; it is cited from
  the brief and from KB `notion-711b57ca383e` only, and this spec's sole claim about it is that it is
  out of scope.
- The brief's citation `.ai/specs/2026-08-25-workspace-scope-routes-tasks.md:610-647` was checked:
  that range is the production-verification section, and it supports the OFF-path claim, but the
  sentence quoted in Problem §1 lives at 417-420 and in `types.ts:432-436`. Line numbers corrected
  here.
