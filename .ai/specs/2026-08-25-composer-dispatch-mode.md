# Composer dispatch mode shapes the plan

- **Status:** Implemented, QA Needed. Code and test coverage are in this change; build, gates and
  browser E2E remain for the authoritative verification steps.
- **Date:** 2026-08-25
- **Task:** "Make input-to-tasks honor composer dispatch mode"
- **Brief:** `.ai/specs/briefs/2026-08-25-composer-dispatch-mode.md` (read in full; every citation
  below was re-opened in the tree at `2fd01a16`, not taken from the brief)
- **Extends:** `.ai/specs/2026-08-25-workspace-scope-routes-tasks.md` (`dc64b741`, `eb9c033d`,
  `7e82ce10`, `2fd01a16`)
- **Revised 2026-08-29** after review, in six places, each re-checked against the tree at
  `2fd01a16`: `reviveWorkflow` must **persist** the shaped def (without the write every gate here
  turns itself off on a recovered run); the ledger is refreshed **before every `dispatch` spawn**
  (the crash window between the terminal `file` write and the ledger write otherwise renders
  `(none)`); the completion metric's restart receipt is the **append-only event itself**, and the
  `summaryEmittedAt` field it replaced is gone; V2 gains a contract-schema matrix for zero/one/many
  in both modes; V5's 200-item cap and `truncated` assertions are replaced by a positive proof of
  the uncapped ledger, and its href corrected to the global `/tasks`; every automated and
  production assertion now uses the declared marked predicate, and the card header states zero /
  partial / complete honestly instead of claiming "and started them" for a partial run.

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
from it, the thread renders one link per todo into the **global** `/tasks` Filed board, keyed
`<that todo's own project>:<todo id>`, because the board is registered only outside project scope,
and two metric events distinguish `filed-only` from `filed-and-dispatched`.

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
  before EVERY 'dispatch' spawn ─▶ await collectFiledTodos  ← closes the crash window
  step 'dispatch' prompt  ◀── {{filedTodos}}              ← NEW token, from run.filedTodos
  settleSuccess ─▶ re-collect (picks up autostart marks AND startedTaskId)
               ─▶ metric run.input_to_tasks.completed     ← NEW; the EVENT is its own
                                                            receipt (readEvents), no flag
  reviveWorkflow catalog fallback ─▶ shape AND persist workflowDef
                                       ← without the write, every gate above turns off

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
**key**, `fdetail=<project>:<todo-id>`, not in the path, which is also why one card can link rows
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
- `workflows/run.ts#reviveWorkflow` (2770-2778): apply the same shaper to the **catalog fallback**
  using `run.autoStart === true`, **and persist the shaped result back onto the record** with
  `this.store.updateRun(run.id, { workflowDef: shaped })` before returning it. The `workflowDef`
  branch is already shaped by construction and is left alone.

  Persisting is not tidiness, it is a precondition of the rest of this spec. Today the fallback
  returns the catalog def to the caller and writes nothing (`run.ts:2774-2777`, verified in the
  tree at `2fd01a16`), so a record whose `workflowDef` failed to parse keeps `workflowDef ===
  undefined` for the rest of its life. Every gate in this feature is
  `isBuiltInInputToTasksRun(run)`, which requires that field (Analytics). A recovered run with the
  field still absent would therefore file todos with **no ledger, no `{{filedTodos}}` rendering
  and no completion metric**, while still running whatever steps the catalog gave it, the exact
  silent half-feature this spec exists to remove. One `updateRun` on the recovery path closes it,
  and it is the same field `startRun` already writes (`run.ts:1555`). V3 asserts the persistence in
  both modes.
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
- Call sites, **three**, and the middle one is load-bearing:
  1. once when the `file` step reaches a terminal status (the common path, so the card appears as
     soon as filing is done);
  2. **`await`ed immediately before every built-in `dispatch` spawn**, inside `execute()`, as the
     last thing that happens before the prompt is templated, the refresh is what the
     `{{filedTodos}}` rendering reads;
  3. once in `settleSuccess` (`run.ts:7375`) before the status flip, so the ON path's marks land in
     the record, `autostart: true` for a todo still awaiting pickup, `startedTaskId` for one the
     watcher already claimed.

  Call site 2 exists because call site 1 alone leaves a crash window. The terminal-step write and
  the ledger write are separate durable writes, so a crash between them leaves a record whose `file`
  step is already `done` and whose `filedTodos` is absent. Recovery resumes at the first unfinished
  step, `dispatch`, and templating an absent ledger renders the literal `(none)`, so the ON path
  would start an agent and correctly tell it there is nothing to mark, having filed three todos a
  moment earlier. Refreshing at the spawn boundary makes the ledger a **read-through of
  `todos.json`** rather than a cached side effect of a step that may not have completed its write,
  and `collectFiledTodos` is a pure derivation over `author.parentTaskId`, so recomputing it costs
  one index pass and cannot disagree with itself. V3 forces exactly this state.

  All three writes are whole-array replacements of a derived value, so ordering and repetition are
  harmless.
- Guard: `isBuiltInInputToTasksRun(run)` and nothing looser (see Analytics for its definition,
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
  (`autostart === true` **or** `startedTaskId` present, Data models). Each row is a
  `Link to={'/tasks?fdetail=' + encodeURIComponent(key)}`, the **global** board path, written
  plainly and **not** through `scopeTo`, because `/tasks` exists only outside project scope
  (`routes.tsx:793`) and `/p/<project>/tasks` is not a route. The project travels in the key.
- **The header counts, it does not generalise.** *"and started them"* is a claim about every row,
  and on a `dispatch` step that marked two of three todos and reported the third as unmarkable it is
  simply false, the one place a user would notice the failure is the one place the old wording hid
  it. Let `marked` be the number of items satisfying the marked predicate (`autostart === true`
  **or** `startedTaskId` present) and `total` be `items.length`. The header is a pure function of
  that pair, with three honest states:

  | state | condition | header |
  | --- | --- | --- |
  | none marked | `marked === 0` | *"Filed 3 tasks"* |
  | partial | `0 < marked < total` | *"Filed 3 tasks, marked 2 of 3 to start"* |
  | complete | `marked === total > 0` | *"Filed 3 tasks and marked them all to start"* |

  The filed-only mode lands in the `none marked` row by construction, so it needs no separate
  branch: with no `dispatch` step nothing is ever marked, and the header says what happened rather
  than what mode was chosen. The partial header is the user-visible twin of the
  `autostartMarked < todoCount` defect signal in Analytics.
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
   *  collector truncates instead, deterministically, first 497 code units + `'…'`, so the
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
     *  "links a bounded subset", the truncated tail is exactly the part nobody notices is
     *  missing. An entry is ~120 bytes; a run that files thousands is a different bug, and one
     *  that stays visible precisely because the ledger did not hide it. */
    items: z.array(filedTodoSchema),
    /** When the ledger was last derived. */
    at: z.string(),
    /* NO `summaryEmittedAt`, deliberately. An earlier draft put the completion-metric guard here;
     * a record flag and the metric event are two separate durable writes, and a crash between them
     * either suppresses the event forever or double-counts it. The receipt is the append-only event
     * itself, see Analytics. This object stays purely descriptive: what was filed, and when it was
     * last derived. */
  }).optional()
```

**A todo counts as successfully marked when `autostart === true` OR `startedTaskId` is present.**
The flag alone is not proof of dispatch, and this is the one non-obvious fact in the data model.
`markStartedWithClaim` (`todos.ts:900-937`) stamps `startedTaskId` and `delete item.autostart` in
the *same* write, with the reason in its own comment: *"leaving it `true` next to a
`startedTaskId` would read as 'still pending' to the next reconcile pass."* So a **fast** pickup,
the autostart watcher claiming a todo before `settleSuccess` re-derives the ledger, leaves a
correctly-marked todo carrying no `autostart` at all, and a ledger that read the flag alone would
report the ON path as having marked nothing. The card's `marked` count (which drives all three
header states, Phase 4) and the `autostartMarked` dimension both use the OR, never `autostart`
alone, and so does every assertion in V4, V5, V6 and V8. **V4 exercises watcher consumption before
final settlement**, so this is a tested property rather than a remembered one.

The ledger is a snapshot at derivation time, not a live view: `unmarkStarted` (`todos.ts:990-1010`)
can clear `startedTaskId` on a later cancel, and that does not rewrite a settled run's record. That
is intended, the record answers "what did this run file, and did it mark them", not "what is the
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
- **Existing `autoStart` drift, corrected as part of this change.** `runRecordSchema` in
  `packages/contract/src/runs.ts` (268-504) has **no `autoStart` field**, while the store's own
  `runRecordSchema` persists and returns it (`packages/cezar/src/runs/store.ts:434`, with the
  "absent means false" doc comment) and every run route answers with the stored record. Verified in
  the tree at `2fd01a16`: `grep -n autoStart packages/contract/src/runs.ts` returns nothing. So the
  runtime response is today **wider than the published contract**, and any consumer parsing a run
  through `runRecordSchema` (or `apiRunSchema`, which extends it, `runs.ts:511`) silently
  **strips** the field, because `z.object` is strip-by-default and the loss raises nothing. That is
  a defect this spec owns rather than a tidy-up: `autoStart` is the composer decision the whole
  change freezes into the plan, and it is the field `reviveWorkflow` reads on the recovery path
  (Phase 1), so a client that cannot see it cannot tell a filed-only run from a dispatched one
  except by counting steps. Add `autoStart: z.boolean().optional()` to the contract schema, in
  Phase 2 alongside `filedTodos`, carrying the store's doc comment across. Additive in both
  directions under `BACKWARD_COMPATIBILITY.md` §3: an older record without the key still parses, a
  newer one stops losing it. V2's contract matrix round-trips absent, `false` and `true` against
  both workflow topologies.
- `GET /api/v1/runs/:id`, `GET /api/v1/p/:projectId/runs`, and the SSE `run` frames all carry the
  new optional `filedTodos`. Additive; `api-types.test.ts`'s contract-parity check keeps the api-client
  mirror type-exact.
- `POST /p/:projectId/todos/:id/start`, `GET /api/v1/workspace/todos`: **unchanged**. The card
  links to a page; it starts nothing itself.
- Cockpit URL: `/tasks?fdetail=<project>:<todo-id>` is a new **additive** query param on the
  existing **global** Filed board route (`routes.tsx:793`). Not `/p/<project>/tasks`, which is not a
  registered route, project scope registers only `tasks/:id` and its git tabs. An older cockpit
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
alone) would still match a name-only test, and would then acquire a *"Filed nothing"* card it never
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

**`run.workflowDef !== undefined` is a hard requirement of this predicate, and that puts an
obligation on the one path that can enter execution without it.** Catalog recovery is *defined* by
that field being absent: `reviveWorkflow` reads `run.workflowDef` and falls through to
`loadWorkflows(...).find(w => w.name === run.workflow)` precisely when it is missing
(`run.ts:2774-2777`). Left alone, a recovered run would be executed with a def the record does not
hold, so this predicate would answer `false` for the whole remainder of the run and quietly disable
ledger collection, `{{filedTodos}}` templating and completion analytics, for the run that most
needs them, since it already crashed once. Phase 1 therefore requires `reviveWorkflow` to **shape
and persist** the recovered definition into `run.workflowDef` before returning it, which restores
the invariant this predicate depends on: *any run that is executing has its own frozen def on the
record.* The predicate is deliberately not loosened to re-resolve from the catalog itself, that
would reintroduce the name-only test this section exists to forbid.

| Event | Emitted | Dimensions |
| --- | --- | --- |
| `run.input_to_tasks.planned` | once, in `startRun`, only when `isBuiltInInputToTasks(shapedDef)` and the run carries a workspace grant | `dispatchMode: 'filed-only' \| 'filed-and-dispatched'`, `stepCount` (2 or 3), `runId` |
| `run.input_to_tasks.completed` | once, in `settleSuccess`, only when `isBuiltInInputToTasksRun(run)`, after the final ledger write | `dispatchMode`, `todoCount`, `autostartMarked` (count where `autostart === true` **or** `startedTaskId` is present, Data models), `projectCount` (distinct), `runId` |

`planned` is emitted at CREATION and not from `execute()`, for the reason `run.workflow.selected`'s
own comment gives: `execute` re-enters on every reattachment and chain re-entry, which turns "once
per run" into a silent overcount on exactly the long, interrupted runs a rate most needs to count
honestly.

`completed` cannot use that trick: `settleSuccess` has three callers (`run.ts:7375-7383`) and a
restart-settle or a continuation can reach it again. **Its idempotency receipt is the event
itself:** before emitting, scan `store.readEvents(runId)` (`store.ts:1340`) for an existing
`type: 'metric'`, `name: 'run.input_to_tasks.completed'` entry and emit only when there is none. A
second settle re-derives the ledger (cheap, idempotent), finds the receipt, and emits nothing.

**A separate `filedTodos.summaryEmittedAt` guard field was specified here and has been removed,
because it cannot be crash-safe.** A guard flag and the event are two durable writes in some order,
and both orders are wrong: guard-then-emit permanently *suppresses* the metric if the process dies
between them (the flag says "already counted" and the event never existed), and emit-then-guard
double-counts on the same crash. Using the append itself collapses the two writes into one:
`appendEvent` is a single `appendFileSync` of one NDJSON line (`store.ts:1161`) and `readEvents`
drops any line that fails `JSON.parse` (`store.ts:1340-1356`), so a torn trailing line reads as
*absent* and the event is re-emitted on the next settle rather than lost.

**That only holds once `appendEvent` repairs the separator, and today it does not.** An earlier
revision of this section claimed the torn line was harmless; against the current code it is not.
The append is `appendFileSync(path, JSON.stringify(full) + '\n')`: the newline goes *after* the
record, so a process killed mid-write leaves a final line with **no** trailing newline, and the
next append concatenates its own JSON onto that fragment. `readEvents` splits on `\n`, so the
fragment and the retry then form **one** unparseable line and are dropped **together**: the
receipt this design depends on can never become readable, and the completion metric is lost
permanently for that run rather than re-emitted. That is precisely the failure the removed guard
flag was rejected for, reintroduced one layer down.

So this change carries a small, self-contained fix to `appendEvent`, landing in Phase 2 beside the
`filedTodos` field: **before writing, check the file's last byte; if the file is non-empty and that
byte is not `\n`, write a leading `\n` ahead of the event.** One `statSync` for the size plus one
1-byte read at `size - 1`, on a path that already does a synchronous write, so the cost is
immaterial at agent-event rates. It does **not** rewrite, rewind or compact the append-only file:
the torn fragment stays exactly where it is, `readEvents` drops that one fragment line, and the
retry that follows it parses as a valid event. The repair is deliberately generic (every event
type on every run gets it, not just this metric), because the same torn line silently swallows the
*next* event of any kind today, which is a live defect independent of this feature.

With the separator repaired, the receipt is at-least-once biased toward emitting, which is the
correct bias for a completion counter: an over-count is visible as two events with the same `runId`
and can be deduped in analysis, whereas a suppressed event leaves no trace anywhere that it should
have existed.

The scan is bounded and cheap in the only place it runs: one read of the run's own event file, once,
on a run that is already settling. V3 case 6 tests that crash boundary directly, and is red without
the separator repair.

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
- **A restart survives with no def on the record, and the feature quietly switches itself off.** The
  same fallback returns a def without writing it, so `run.workflowDef` stays `undefined` and
  `isBuiltInInputToTasksRun`, the gate on ledger collection, `{{filedTodos}}` and both metrics,
  answers `false` for the rest of the run. The run keeps executing and files todos; only the
  feature disappears, which is far harder to notice than a crash. Mitigation: `reviveWorkflow`
  persists the shaped def (Phase 1); V3 cases 3 and 4 assert the persistence in both modes.
- **A crash between the terminal `file` write and the ledger write leaves `dispatch` with nothing to
  mark.** Two separate durable writes, and recovery resumes at `dispatch`, so the prompt would
  render `(none)` and the agent would correctly report that there is nothing to start, on a run
  that had just filed three todos. Mitigation: the awaited pre-spawn ledger refresh (Phase 2, call
  site 2), which makes the prompt a read-through of `todos.json`; V3 case 5 constructs exactly this
  record.
- **The completion metric is counted twice, or lost forever.** `settleSuccess` has three callers, so
  the event needs a restart receipt, but a receipt stored as a record flag is a second durable
  write, and a crash between the two either suppresses the event permanently (guard first) or
  double-counts it (emit first). Mitigation: the append-only event *is* the receipt (Analytics), so
  there is one write; the residual risk is a duplicate after a torn append, which is visible in the
  data and the safer direction. V3 case 6 tests the truncation boundary.
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
  'input-to-tasks'`, which a repo's own override matches, giving a user who opted out by writing
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

**V2: the route freezes the plan, in both directions, and the record shape holds zero, one and
many.** Two files, because these are two different claims and the earlier draft conflated them: the
route cases below decide *topology* and legitimately carry no todos (nothing has been filed when
`startRun` is called), so the zero/one/many coverage is a **contract-schema matrix**, and the
end-to-end zero/one/many behaviour is V4's workflow matrix, which is retained in full.

- `server/workspace-run-routes.test.ts`, extending `describe('input-to-tasks default and autoStart')`
  (193-251): assert on the def handed to `startRun` through the seam the harness **already** has.
  Its `startRun` stub records `{ workflow, input }` on every call
  (`workspace-run-routes.test.ts:60-75`, read in the tree at `2fd01a16`), so the shaped definition
  is asserted off `started[0].workflow` and the harness needs no change at all. An earlier revision
  of this spec said it "gains the workflow argument", which was wrong: it has had one since it was
  written. `autoStart` absent → 2 steps; `false` → 2 steps; `true` → 3 steps.
  `workflow: 'spec-to-deploy'` → untouched. An inline `steps` chain → untouched. These cases assert
  topology only and make no claim about todo counts.
  **Mutation check:** removing the `inputToTasksPlan` call must turn exactly the three new cases red
  and nothing else.
- `packages/contract/src/runs.test.ts` (existing file, currently `testAttestationSchema` only,
  verified in the tree at `2fd01a16`): a `filedTodos` matrix parsed through `runRecordSchema`, six
  cases, the cross-product of **`items.length` ∈ {0, 1, 3}** and **filed-only vs filed-and-dispatched**:

  | case | `steps` on the record | `items` | `autoStart` on the record | per-item marks |
  | --- | --- | --- | --- | --- |
  | filed-only, none | `['context','file']` | `[]` | **absent** |, |
  | filed-only, one | `['context','file']` | 1 | `false` | no `autostart`, no `startedTaskId` |
  | filed-only, many | `['context','file']` | 3 | `true` | none marked |
  | dispatched, none | `['context','file','dispatch']` | `[]` | **absent** |, |
  | dispatched, one | `['context','file','dispatch']` | 1 | `false` | `autostart: true` |
  | dispatched, many | `['context','file','dispatch']` | 3 | `true` | one `autostart: true`, one `startedTaskId`, one **neither** (the partial state Phase 4's header must render) |

  The `autoStart` column is deliberately **not** correlated with the `steps` column. The contract
  schema does not couple the two, `autoStart` is the composer's request as persisted at creation
  (`store.ts:434`) and `steps` is the frozen plan, so pairing `autoStart: true` with a two-step
  record and `false` with a three-step one is a *legal* record shape the schema must accept, and
  pinning it here is what stops a future `.refine()` from quietly making the field a derived
  duplicate of the topology. Correlating them would also leave the `true`/two-step and
  `false`/three-step combinations untested.

  Each case asserts the record parses, round-trips (`parse(x)` deep-equals `x`), and that the
  two-step and three-step step arrays are both valid record shapes.
  **Each case also carries an `autoStart` value, and the matrix crosses the two topologies with all
  three of absent, `false` and `true`**: the contract-drift fix in API contracts. The assignment is
  the `autoStart` column above, and the arithmetic matters for the mutation check below, six rows,
  each topology seeing all three values, which is **two** rows where the key is absent
  (filed-only/none, dispatched/none) and **four** rows where it is present with a value
  (filed-only/one `false`, filed-only/many `true`, dispatched/one `false`, dispatched/many `true`).
  An earlier revision of this section said "the two present-value cases", which miscounted the
  cross-product by half and would have accepted a mutation that reddened only two of the four.
  On each of the four present rows, assert the parsed record still *has* the field
  (`'autoStart' in parsed`) **and** that the value survives the round-trip, `false` must come back
  as `false`, not merely be present, so a `z.boolean().default(true)` or a truthiness coercion is
  caught rather than passing on presence alone. On each of the two absent rows, assert
  `'autoStart' in parsed` is `false`, so no key is invented. All four present-row assertions are
  **red against the schema as it stands today**, because `z.object` strips an unknown `autoStart`
  silently rather than rejecting it, which is exactly why the drift went unnoticed; the two absent
  rows are green today and must stay green, which is what makes them the control.
  Plus the negative cases the schema owes: a `summary` over 500 code units is rejected;
  `autostart: false` is rejected (`z.literal(true)`); a record with **no** `filedTodos` at all
  parses unchanged, which is the `BACKWARD_COMPATIBILITY.md` §3 additive guarantee.
  **Mutation check:** widening `summary` to an unbounded `z.string()` must redden exactly the
  over-length case; making `filedTodos` required must redden exactly the absent case; deleting
  `autoStart: z.boolean().optional()` from the contract schema must redden **all four**
  present-value rows, filed-only/one, filed-only/many, dispatched/one, dispatched/many, and
  **leave the two absent rows (filed-only/none, dispatched/none) green**, since a stripped key and
  a never-supplied key are indistinguishable to those two assertions. Count the reds: four, not
  two, and not six. Fewer than four means some present row is not actually asserting presence;
  more than four means an absent row is asserting something it must not.

**V3: restart is deterministic from the frozen decision.** `workflows/` integration test:
1. Start with `autoStart: false`; assert `store.getRun(id).workflowDef.steps` has 2 entries and
   `run.steps` has 2 entries.
2. Restart the manager (`recover()`) and assert the revived def still has 2 steps and no `dispatch`
   session is spawned.
3. **The fallback, forced:** blank `workflowDef` on the record (the `.catch(undefined)` shape
   `store.ts:590` produces), recover, and assert the catalog-revived def is *still* two steps.
   Without the `reviveWorkflow` change this case is red. That is its whole purpose.
   **And assert it was persisted:** after recovery, `store.getRun(id).workflowDef` is defined, has
   two steps, and `isBuiltInInputToTasksRun(store.getRun(id))` is `true`. A revival that shapes but
   does not write leaves the field `undefined` and this assertion red, which is the point, because
   every gate in the feature reads it.
4. The same three with `autoStart: true`, asserting `dispatch` is present and re-entered, **and the
   same persistence assertion**: the revived record carries a three-step `workflowDef` and the
   predicate answers `true`, so the resumed `dispatch` step gets a real ledger rather than `(none)`.
5. **The crash window between the terminal `file` write and the ledger write.** Construct a record
   with `file` already `done`, **no** `filedTodos` on the run, and three todos on disk carrying
   `author.parentTaskId === runId`; `autoStart: true`, so recovery resumes at `dispatch`. Recover,
   and assert the `dispatch` spawn spec's `userPrompt` contains **all three** todo ids, the awaited
   pre-spawn refresh (Phase 2, call site 2) is what puts them there, and that after the step all
   three satisfy the marked predicate. **Against a collector that only runs on the `file` transition
   this case renders `(none)` and marks nothing**, which is exactly the regression it pins.
6. **The completion-metric receipt, at its crash boundary.** Settle an ON run to success, assert
   exactly one `run.input_to_tasks.completed` event on `store.readEvents(id)`. Then drive
   `settleSuccess` again (the restart-settle / continuation path) and assert the count is **still
   one**. Then reproduce the crash shape that actually occurs, which is a torn line **with no
   trailing newline left on it**: `truncateSync(eventsPath, len)` with `len` landing *inside* the
   final JSON object, and **do not re-append a `\n`**: the file must end in a bare fragment,
   exactly as a killed process leaves it (`appendEvent` writes the newline after the record, so a
   partial write can never have one). Settle once more, then assert three things on
   `store.readEvents(id)`: exactly **one** readable `run.input_to_tasks.completed` event; that its
   object is intact (a full parse and a field check, not a substring match on the file); and that
   an ordinary event appended *after* it is readable too, proving the file did not stay poisoned
   for everything that follows.
   **Mutation check, and it is the whole point of the case:** removing the separator repair from
   `appendEvent` (Analytics) must make this case **fail**, because the retry concatenates onto the
   fragment and `readEvents` drops both, so the first assertion then finds **zero** readable
   completion events, not one. Restoring the trailing newline in the test setup would let a broken
   implementation pass, so the truncation must not restore it; a test that truncates to a clean
   line boundary is simulating an easier corruption than the one this design claims to survive.
   Reinstating a record-flag guard written in a separate `updateRun` must also report zero.

**V4: no session, no tokens, on the OFF path; every todo marked on the ON path.**
Extending `workflows/auto-start-template.test.ts` (which already captures spawn specs at
`AgentRunSpec` level, 95-134):
- OFF: run to completion against a fixture grant; assert **no spawn spec carries `stepId:
  'dispatch'`**, `run.steps` has no `dispatch` entry, and the summed `tokensUsed` across step
  records equals the sum over `context` + `file` only. Zero, one and three filed todos, all three
  producing the same "no dispatch anything" answer.
- ON: assert the `dispatch` spawn spec's `userPrompt` contains **every** filed todo id and no
  `{{` (the token rendered), and that after the step **every** todo in the fixture `todos.json`
  satisfies the marked predicate (`autostart === true` **or** `startedTaskId` present, Data
  models), never the flag alone. In this fixture no watcher runs, so the observed shape is
  `autostart: true`; assert the predicate anyway, so the case does not have to be rewritten when a
  watcher is in play. Zero todos renders `(none)` and the step still runs and reports.
- **ON, with the watcher racing the settle, the case the flag alone fails.** After `dispatch`
  marks the fixture's three todos, call `markStartedWithClaim(dataDir, id, 'run-x')`
  (`todos.ts:900`) on **one** of them *before* letting the run settle, reproducing a fast autostart
  pickup. That todo now has `startedTaskId` and **no** `autostart` on disk. Assert the final ledger
  still counts all three as marked, and that `run.input_to_tasks.completed` reports
  `autostartMarked: 3`, not 2. **This case is red against any implementation that reads
  `autostart` alone**, which is its entire purpose; assert the on-disk shape (`autostart`
  undefined, `startedTaskId` truthy) in the same test so a future change to
  `markStartedWithClaim` cannot make it pass vacuously.
- **Both analytics events, in both modes, over the same zero/one/three matrix.** The Analytics
  section defines a `dispatchMode` distinction whose entire purpose is to answer "how often is the
  composer's dispatch mode actually used", and nothing above tests it: V3 case 6 tests only the
  *idempotency* of the completion receipt, and it is an ON run, so a build that hard-coded
  `dispatchMode: 'filed-and-dispatched'` and never emitted `planned` at all would pass every other
  case in this spec. These assertions read the run's own event log with
  `store.readEvents(runId).filter(e => e.type === 'metric')`, the same reader V3 case 6 uses, and
  are asserted on the parsed event objects, never on a substring of the file.

  - **`run.input_to_tasks.planned`, exactly once per run, at creation.** Across all six cells of
    the matrix (OFF and ON × zero, one, three filed todos), assert exactly **one** `planned` event
    per run and that it carries this run's `runId`. On the three OFF runs it must read
    `dispatchMode: 'filed-only'` and `stepCount: 2`; on the three ON runs, `dispatchMode:
    'filed-and-dispatched'` and `stepCount: 3`. Assert both dimensions on every run: `stepCount`
    alone would pass a build that emitted a constant mode, and `dispatchMode` alone would pass one
    whose mode and topology disagree, which is the exact incoherence the shared predicate exists to
    prevent. Then **re-enter execution** (drive `recover()` on the same run, the reattachment path
    V3 exercises) and assert the count is **still one**, this is the overcount `planned` is
    emitted from `startRun` rather than `execute()` specifically to avoid, and the count is the only
    thing that catches a move back into `execute()`.
  - **`run.input_to_tasks.completed`, exactly once, with all four dimensions, over the same six
    cells.** Assert one `completed` event per settled run, carrying:

    | cell | `dispatchMode` | `todoCount` | `projectCount` | `autostartMarked` |
    | --- | --- | --- | --- | --- |
    | OFF, zero | `filed-only` | 0 | 0 | 0 |
    | OFF, one | `filed-only` | 1 | 1 | 0 |
    | OFF, three (two projects) | `filed-only` | 3 | 2 | 0 |
    | ON, zero | `filed-and-dispatched` | 0 | 0 | 0 |
    | ON, one | `filed-and-dispatched` | 1 | 1 | 1 |
    | ON, three (two projects) | `filed-and-dispatched` | 3 | 2 | 3 |

    The three-todo cells put todos on **two** granted projects so `projectCount` is a distinct count
    and not an alias of `todoCount`, with one todo per project the two dimensions are numerically
    identical and neither is tested. The `autostartMarked` column uses the declared marked predicate
    (`autostart === true` **or** `startedTaskId` present), so the racing case above, re-asserted
    here, reports `3` and not `2`.
  - **Mutation checks on the pair, and they are what make the mode distinction falsifiable:**
    hard-coding `dispatchMode` to either literal must redden the three cells of the *other* mode in
    **both** tables and nothing else; deriving `stepCount` from the unshaped
    `INPUT_TO_TASKS_WORKFLOW` rather than the shaped def must redden the three OFF `planned` cases;
    counting `projectCount` as `items.length` must redden exactly the two three-todo `completed`
    cells; dropping either emission entirely must redden all six cells of that event's table.
  - **The gate is the shared predicate, asserted negatively.** Run one `spec-to-deploy` run and one
    run on a file-sourced workflow named `input-to-tasks` (the `load.test.ts:150+` override shape)
    through the same fixture, and assert **zero** events of either name on both. A name-only test
    passes the first and fails the second, which is the whole reason `isBuiltInInputToTasks` exists;
    without this case nothing in the spec proves the override is left alone.
- **Mutation check:** re-adding `dispatch` unconditionally must redden the OFF cases;
  removing the `{{filedTodos}}` replacement must redden the ON cases; narrowing the marked
  definition to `autostart === true` must redden the racing case and nothing else.

**V5: the ledger and the links.**
- `workflows/` unit: `collectFiledTodos` over a two-project fixture returns only todos whose
  `author.parentTaskId` is this run, in `ts` order, with `project` set to the registry slug; a todo
  filed by a *different* run in the same board is excluded; a `missing` project degrades without
  throwing.
- **The ledger is uncapped, asserted positively.** Seed a fixture with **250** todos carrying this
  run's `parentTaskId` and assert `items.length === 250`, that the **250th** id is present (not just
  the count), and that the ledger object carries **no `truncated` field**, `expect('truncated' in
  ledger).toBe(false)`, so a later cap cannot be added silently. This is the deliberate choice in
  Data models and it matches `WorkspaceTodoIndex`, whose own comment states *"No cap, no
  truncation"* (`workspace/todo-index.ts:81`, read in the tree at `2fd01a16`). An earlier draft of
  this section asserted a 200-item cap setting `truncated`; that field exists nowhere in this spec
  or in the code, and the assertion contradicted acceptance criterion 1 ("links **every** created
  todo"). Also assert the card renders all 250 rows as links, since a cap in the component would
  fail the same criterion from the other end.
- `runs/store.test.ts`: a record round-trips `filedTodos`; a pre-existing record without it parses.
- `web/src/lib/filed-tasks.test.ts`: `parseFiledDetailKey` round-trips `filedTaskKey`, splits on the
  first `:`, and rejects garbage.
- `web/src/routes/task-thread/filed-todos-card.test.tsx`: zero, one and three todos.
  - **The href is the GLOBAL board, asserted by parsing it, never by string equality.** Phase 4
    builds the link as `'/tasks?fdetail=' + encodeURIComponent(key)` over a `<project>:<id>` key, so
    the **raw href contains `%3A`, not a literal colon**, so an assertion spelling
    `/tasks?fdetail=<project>:<id>` verbatim can only fail, and an earlier revision of this section
    asserted exactly that, contradicting its own Phase 4. Parse instead: `new URL(href,
    'http://localhost')`, then assert `url.pathname === '/tasks'` (exactly, so there is no `/p/`
    prefix and a future `scopeTo` cannot slip back in), and
    `url.searchParams.get('fdetail') === '<project>:<id>'`, which compares the **decoded** key,
    the claim that actually matters. `/p/<project>/tasks` is **not** a registered route: `/tasks`
    is registered once outside project scope (`routes.tsx:454, 793`) and project scope registers
    only `tasks/:id` and its git tabs (Architecture), so a scoped href would land on the
    unknown-project page. The project identity is asserted to survive **inside the key**: for a run
    granted two projects, the row for a todo on project `b` must decode to `b:<id>`, not the run's
    first project.
  - **Marked rows use the declared predicate, never the flag alone**
    (`autostart === true` **or** `startedTaskId` present, Data models): a row with only
    `startedTaskId` (the already-picked-up case, which `markStartedWithClaim` leaves with
    **no** `autostart` at all, `todos.ts:936`) renders the *started* pill exactly like a row with
    only `autostart: true` (the pending-autostart case).
  - **All three header states** (Phase 4): `marked === 0` → *"Filed 3 tasks"*; two of three marked,
    one of them via `startedTaskId` only → *"marked 2 of 3 to start"*; all three marked, mixed
    pending and picked-up → *"and marked them all to start"*. **Mutation check:** narrowing the
    predicate to `autostart === true` must redden the picked-up row and the mixed complete header,
    and nothing else.
- `web/src/routes/global-tasks.test.tsx`: `?fdetail=` opens the dialog on the right entry, closing
  clears the param, and an unknown key renders the visible "no longer on this board" state.

**V6: browser E2E, artifacts retained.** New `packages/web/e2e/composer-dispatch-mode.e2e.ts`,
modelled on the design in `.ai/specs/2026-08-24-land-the-backlog-composer.md:419-520`: its own free
port, its own `cezar serve` child, its own `AgentBrowser`, and **three fixture roots**: a throwaway
`hostRoot` the server boots on, plus **two** registered project roots, `projectRootA` and
`projectRootB`, both seeded into the hermetic `CEZ_HOME/config.json` before boot (because the boot
root is never registered, `initWorkspace` gates registration behind `suppressBootRegistration`,
`index.ts:535-551`).

**Two project roots, not one**, and this is a correction: an earlier revision of this section defined
a single `projectRoot` and then required the second linked todo to belong to "the run's *other*
granted project", which is not executable, there was no other project to grant. Each root is a real
git repo (the `initRepo` helper, `backlog-composer.e2e.ts:37-46`) and each gets its own entry in the
seeded `config.json`, in the shape `registerAndAdoptProject` writes
(`workspace/projects.ts:251-267`) and `backlog-composer.e2e.ts:62-76` already seeds:
`{ id, root: realpathSync(root), name, addedAt, source: 'local' }`. The ids are the fixed literals
**`fixture-a`** and **`fixture-b`**, authored rather than allocated, so the per-row project
assertion can name the expected one instead of resolving a registry slug.
- **What is seeded BEFORE `spawn`, and what must not be.** `RunStore.open` reads `runs.json`
  **once, at startup**, into an in-memory `Map` and never re-reads it (`runs/store.ts:789-808`;
  the map is `private runs = new Map()` at `:780`), and the boot root's store is opened through
  `openStore` → `RunStore.open` at `index.ts:1366-1370`. `quick-list.e2e.ts:12-26` is the existing
  spec that boots its own server for exactly this reason and says so in its header. So the fixture
  **run record** below is written into `<hostRoot>/.ai/cezar/runs.json` *before* the `serve` child
  is spawned; written afterwards it would never become visible to the process under test, and the
  navigation in step 4 would land on an unknown run. This too is a correction: the earlier revision
  pre-seeded that record after boot. **Todos are the opposite case**, `todos.json` is file-watched
  and re-broadcast (same header, `quick-list.e2e.ts:16-18`), so the todo rows are written *after*
  boot, which is what lets the empty-board guard be true first.
- **Non-vacuity guard first:** both project todo stores start **empty**. `GET /api/v1/workspace/todos`
  must report **both** `fixture-a` and `fixture-b` with `ok: true` and a globally empty `todos` array
  before anything is submitted, so "the board already had rows" can never be what makes the link case
  pass.
- **OFF:** submit at workspace scope with the chip untouched; read the created run **scoped**
  (`/api/v1/p/<boot>/runs/<id>`, never the unscoped index) and assert `run.steps` has exactly
  `['context','file']`, a *positive* assertion on the list, not "dispatch is absent", so a broken
  read cannot pass it. Then assert **no filed todo satisfies the marked predicate**, neither
  `autostart === true` nor a `startedTaskId`, rather than checking the flag alone, which a
  todo already picked up by a watcher would pass vacuously.
- **Links, with a fixture whose todos actually exist.** A card link proves nothing unless the todo
  it points at is on the board, and the empty-board guard above guarantees it is not there yet: a
  run record alone would open the *"no longer on this board"* empty state and the case
  would pass on the wrong thing. So the fixture is built in two halves, split by the boot, for the
  in-memory-`runs.json` reason given above:
  1. **Before `spawn`.** Fix **two literal todo UUIDs** as constants in the test,
     `11111111-2222-4333-8444-555555555555` on `fixture-a` and
     `66666666-7777-4888-8999-000000000000` on `fixture-b`, and write a fixture `RunRecord[]` into
     `<hostRoot>/.ai/cezar/runs.json` holding one run whose `filedTodos.items` are exactly those two
     entries: id 1 with `project: 'fixture-a'`, id 2 with `project: 'fixture-b'`. Its `status` is
     terminal (`done`), because a serve boot *recovers* live runs and a fixture therefore cannot
     hold a non-terminal one still (`quick-list.e2e.ts:26-30`). The agent is never driven in E2E;
     this record stands in for what Phase 2's ledger writes. **Neither project's `todos.json` is
     written yet**, that is what keeps the guard below honest.
  2. **After boot, the empty guard and the OFF assertions**, write one schema-valid todo per project
     with those ids: id 1 into `<projectRootA>/.ai/cezar/todos.json`, id 2 into
     `<projectRootB>/.ai/cezar/todos.json` (the path is `join(dataDir, 'todos.json')`,
     `todos.ts:177`), in the same shape `GET /api/v1/workspace/todos` answers with (`summary`,
     `status`, `ts`, and `author.parentTaskId` set to the fixture run's id).
  3. **Positively re-read them through the API:** `GET /api/v1/workspace/todos` now reports
     `ok: true` for **both** projects and contains **both** ids, one attributed to `fixture-a` and
     one to `fixture-b`. This is the non-vacuity guard's positive half: the empty assertion before
     and the present assertion here are what make "the dialog opened" mean something later. Fail
     here if the re-read misses them, rather than downstream, where a missing todo and a broken link
     are indistinguishable.
  4. Navigate to the **already-loaded** fixture run's thread, `/p/<boot>/runs/<fixtureRunId>`, the
     prefix from `bootProjectId()` (`agent-browser.ts:74-80`). No run is created here and none can
     be: it was in `runs.json` before the process started, which is the only way it is in the store.
  5. Click the card row for the todo on the **second** project, and assert the landed URL by
     parsing it: `pathname === '/tasks'` (no `/p/` prefix) and `searchParams.get('fdetail')` equal
     to that row's own project-qualified key, `fixture-b:66666666-7777-4888-8999-000000000000`,
     resolving to `projectRootB`, not `fixture-a`, which is the assertion the single-root version
     could not make at all. Then assert `[data-slot="filed-task-detail"]` is present and shows
     **that** todo id, the real detail dialog the board opens on a real entry, which is only
     reachable because step 2 created it.

  Asserting the pathname, not just the param, is what catches a `scopeTo` regression:
  `/p/<project>/tasks` is not a registered route and renders the unknown-project page, on which the
  param would be silently inert.
- **ON:** tick the chip, submit, assert `run.steps` is exactly `['context','file','dispatch']`.
- Screenshots at each assertion into `/var/lib/cezar/e2e-artifacts/composer-dispatch-<id8>/`,
  matching `.ai/specs/2026-08-25-verify-bulk-start-release.md`'s retention. **`AgentBrowser` has no
  video capture** (`packages/web/e2e/agent-browser.ts:226-240` offers `screenshot` only), so the
  acceptance criterion's "artifacts" are screenshots plus the scoped JSON responses saved beside
  them. Stated here rather than promised and quietly not delivered.
- Run via `npm run test:e2e`. `TEST_E2E_STATUS=skipped` is **not** a pass (`.ai/scripts/e2e.sh:19-32`)
  and must be reported as "the UI was not verified".

**V7: the repository's five mandatory gates, on the box.** This repo's validation set is **five**
commands, not two, `.ai/agentic.config.json`'s `validation.commands` lists `typecheck`, `test`,
`test:unit`, `build`, `test:package`, and `AGENTS.md:233-240` documents each. An earlier revision of
this section named only `typecheck` and `test`, which silently dropped three gates, and two of the
three are the ones this change can actually break on its own: `test:unit` is `node:test` coverage of
the core modules Phase 2 edits (`appendEvent` lives in `store.ts`), and `build` is what compiles the
new contract field across all four projects. Run, in this order, on an idle box:

```bash
npm run typecheck    # tsc --noEmit: contract + api-client + server + web (package.json:38)
npm test             # vitest run, server + cockpit unit suites; run this one TWICE (below)
npm run test:unit    # node:test, packages/cezar/test/unit/
npm run build        # tsc → dist/ + vite → web/dist/ + the check:pack tarball gate
npm run test:package # packs and installs the tarball, exercises the built CLI
```

`npm run build` must precede `npm run test:package`, which packs the tarball the build produces
(`AGENTS.md:240`); running it against a stale or missing `dist/` tests the previous release.

**`npm test` runs twice**, on the identical tree, per
`.ai/specs/2026-08-25-workspace-scope-routes-tasks.md:588-612`: a red that does not move between the
two runs is a real failure; one that moves is the flake pool. Note that spec's own finding, the Mac
reports 8 pre-existing `web` errors the box does not, so quote the **box's** numbers, not a Mac
run's. Use the environment scrub from `AGENTS.md:275-281` (`env -u NODE_ENV`, the `CEZ_*` strip,
`TMPDIR` outside any git repo); root `npm test` self-scrubs for the `server` project only, and
`test:unit`/`test:package` do not self-scrub at all (`AGENTS.md:284-299`), so the wrapper is
required for them.

**Two pre-existing reds to expect and not to claim as this change's:** `npm run test:package` fails
1/15 under the run broker, case 5 of `packages/cezar/test/e2e/package-cli.test.ts:86`, which stalls
at "Gather the record" and reproduces identically at clean HEAD (`AGENTS.md:401-404`). Confirm it
reproduces at the merge-base before attributing it, and report the two counts side by side rather
than rounding the gate up to green.

Also run the whole-tree `upstream purity` check in `notifications/transports/webhook.test.ts`. It
scans every file under `packages/{cezar,web}/src` and is the gate a narrow sweep misses; any new
comment here must not spell a neighbouring product's paths.

`npm run test:e2e` is **not** part of this gate, it is V6's browser verification and is reported
there, separately, with its artifacts. A green V7 says nothing about the UI.

**V8: production.** Deploy the landed sha, confirm `GET /api/v1/ready` reports it, then from the
live cockpit submit one disposable workspace task with the chip **off** and one with it **on**:
- off → the run's record has two steps, its thread shows the card, each link opens the right todo's
  detail on the **global** `/tasks` board (check the address bar reads `/tasks?fdetail=…`, not
  `/p/<project>/tasks`), and **no session or token is attributed to a `dispatch` step**;
- on → three steps, and every todo it filed satisfies the marked predicate: `autostart: true`
  **or** a `startedTaskId`. Check the predicate, not the flag, production is the one place a
  watcher really can claim a todo between `dispatch` and the moment you look, and a todo that was
  correctly marked and then picked up carries no `autostart` at all (`todos.ts:936`). Reading the
  flag alone here would report a working ON path as broken. Record which of the two shapes each
  todo was actually in, so the report says what was observed rather than what was expected;
- clean up both runs and both todos afterwards, and say plainly if cleanup failed (the bulk-start
  E2E's cleanup failed and left two live runs,
  `.ai/specs/2026-08-24-bulk-start-filed-tasks.md:61-70`).

## What was read, and what was not

**Read in the tree at `2fd01a16`:** `packages/cezar/src/workflows/types.ts:414-523`;
`workflows/run.ts:1530-1570, 2265-2300, 2760-2810, 6400-6440, 6790-6820, 7375-7430, 7865-7895`;
`workflows/load.test.ts:110-150`; `workflows/auto-start-template.test.ts:90-134`;
`runs/store.ts:420-440, 825-880, 1151-1190, 1340-1356`; `runs/chain.ts:40-58`;
`runs/task-author.ts` (whole);
`todos.ts:428-445, 640-700`; `todo-cli.ts:180-260`; `server/workspace-run-routes.ts` (whole);
`server/workspace-run-routes.test.ts:193-255`; `server/workspace-todos-routes.ts` (whole);
`workspace/todo-index.ts:46-111`; `contract/src/workspace-run-start.ts` (whole);
`contract/src/runs.ts:394-460`; `contract/src/runs.test.ts` (whole);
`contract/src/workspace-todos.ts` (whole);
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
- **No `truncated` field, and no 200-item cap, exists anywhere**, not in `filedTodos` (which this
  spec defines as uncapped), not in `WorkspaceTodoIndex` (whose own comment at
  `workspace/todo-index.ts:81` reads *"No cap, no truncation"*), and not in `contract/src/runs.ts`.
  An earlier revision of V5 asserted one; it was describing nothing. V5 now proves the absence
  positively instead.
- The brief's citation `.ai/specs/2026-08-25-workspace-scope-routes-tasks.md:610-647` was checked:
  that range is the production-verification section, and it supports the OFF-path claim, but the
  sentence quoted in Problem §1 lives at 417-420 and in `types.ts:432-436`. Line numbers corrected
  here.
