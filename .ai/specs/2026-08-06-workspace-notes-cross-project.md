# Workspace notes (REMOVED 2026-08-14) and cross-project views

> **SUPERSEDED IN PART 2026-08-14 by `.ai/specs/2026-08-14-remove-notes-capture-inbox.md`.**
> **Feature B — the notes capture inbox — was removed from the fork and is not coming back:**
> every route, the `CEZ_NOTES` flag, the `capabilities.notes` key, the `/notes` page, the
> contract module and the `~/.cezar/notes.json` path helpers are deleted. It never got past the
> inert scaffold, so nothing described below about notes was ever implemented. Read everything
> about notes here as history, not as queued work.
>
> **Feature A — cross-project views (`CEZ_WORKSPACE_VIEWS`, `GET /api/v1/workspace/runs`,
> `/workspace/tasks`, W4.10) — is UNAFFECTED and still current.** That is the half of this spec
> still worth reading.

> Plan: `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md` (feature F3, packages W1.11, W4.10, P2.1 to P2.5).
> Its "Resolved decisions" table D1 to D22 (including the cross-spec additions D15 to D22) is
> authoritative and overrides anything below that contradicts it.

**The ask, as recorded.** The only fragment on record verbatim is the premise: cezar
*"has a view of 1 project only"*, alongside a request for org and team level **notes** that turn
into tasks in whichever projects they belong to. Everything else in this spec is derived from that
premise plus the PLAN, and the paraphrase is marked as a paraphrase rather than dressed up as a
quotation.

**The premise is half wrong, and the half that is wrong matters.** cezar is already multi-project:
the registry is per machine (`packages/cezar/src/paths.ts:16-20` resolves `~/.cezar`, overridable by
`CEZ_HOME`; `packages/cezar/src/workspace/config.ts:34-52` holds the project rows), the API is
mounted twice so every project route answers at `/api/v1/p/:projectId/...`
(`packages/cezar/src/server/server.ts:5126-5129`), the cockpit mirrors it at `/p/:projectId/...`
(`packages/web/src/routes.tsx:313`), and the sidebar already renders one collapsible group per
registered project (`packages/web/src/components/project-groups.tsx:127-189`), each reading its own
project's runs by explicit id (`packages/web/src/api/queries.ts:647-653`).

What is actually missing is narrower and sharper: **every content view is scoped to exactly one
project, and no aggregated view exists anywhere.** The Tasks table calls `useRuns()`
(`packages/web/src/routes/tasks-overview.tsx:666-667`), whose key is led by the active scope
(`packages/web/src/api/queries.ts:115`) and whose fetch resolves to one project
(`packages/web/src/api/client.ts:423-428`). "Filter by project" is not a filter today, it is the URL
prefix, and there is exactly one active scope per page, held in a module singleton
(`packages/api-client/src/utils/project-scope.ts:50-60`).

## TLDR

**The foundational fact, and everything here follows from it: in cezar a task IS a run, and
`RunRecord` has no project field.** The record is `packages/contract/src/runs.ts:132-262`: id, title,
workflow, task, status, timings, usage, git state, and no `project` key anywhere in it. A run
belongs to a project for one reason only, that a `RunStore` was opened against that project's
`dataDir` (`packages/cezar/src/server/project-context.ts:208-211`). Project identity exists on the
wire as an SSE envelope stamp and nowhere else (`packages/cezar/src/server/server.ts:4549-4553`
stamps it, `packages/web/src/api/events.ts:91-93` strips it straight back off).

Two features ship, deliberately separable and independently landable, sharing exactly one new module:

- **(A) Cross-project views.** `GET /api/v1/workspace/runs`, one workspace-level aggregate over
  every registered project's `runs.json`, and a `/workspace/tasks` board with a project multi-select
  filter. Behind `CEZ_WORKSPACE_VIEWS=1`.
- **(B) Notes.** A workspace-scoped capture inbox in `~/.cezar/`, drained by ONE agent pass that
  proposes N tasks across N projects, behind a human review gate that is the only path to creation.
  Behind `CEZ_NOTES=1`.

The shared module is `WorkspaceRunIndex` (W1.11), which makes project membership explicit by
stamping it at read time. Both features need it: (A) to render provenance, (B) to dedupe proposals
against the board that already exists.

Single-project mode is preserved byte-for-byte. cezar is a released npm package, so the workspace
rule in `/Users/mw/loki-labs/AGENTS.md` ("pre-launch, no backward-compatibility burden") does not
apply inside this repo (PLAN dispatch contract, clause 6).

## Resolved assumptions (autonomous defaults)

| # | Question | Applied default | Why |
|---|----------|-----------------|-----|
| Q1 | Does a task become a new entity? | **No. A task stays a run.** No `ticket` entity is introduced here. | PLAN D13. `RunRecord` is a run's prompt and lifecycle; `todos.json` is a delete-on-check list that `ensureDataGitignore` keeps out of the repo (`packages/cezar/src/index.ts:664-683`). Neither models a backlog row that exists before it runs and after it finishes. That entity is F5's job in phase 3, and inventing a second one here would leave two half-boards. |
| Q2 | Where does a note live? | **Workspace scope, `~/.cezar/notes.json`, never inside a repo.** | PLAN D14, four reasons in the Problem Statement. The decisive one is mechanical: a note fanning out to three projects would have its resulting-task pointers spread across three separate `runs.json` files while living in only one of them. |
| Q3 | Is `projectHint` a target? | **No. Advisory only, overrulable, never a default fallback.** | The value of a note is that it has not yet been assigned to a repo. A hint that silently becomes a target recreates the wrong-repo defect class the whole review gate exists to prevent. |
| Q4 | One flag or two? | **Two: `CEZ_WORKSPACE_VIEWS=1` and `CEZ_NOTES=1`.** Each off unless the value is exactly `'1'`. **Off means: every `GET` answers 200 with a schema-valid empty payload, every mutator answers 409, and nothing answers 404** (PLAN D19, spelled out per route in API Contracts). | PLAN D4, and D19 for the shape: a 404 would tell the typed client the route does not exist, breaking its own contract, when in fact the feature is merely switched off. Two flags mean B's release never blocks A's. The exact-`'1'` spelling is the house rule, matching `singleProject: env.CEZ_SINGLE_PROJECT === '1'` (`packages/cezar/src/server/capabilities.ts:136`) and `followupsEnabled` (`packages/cezar/src/handoff.ts:127-129`). |
| Q5 | Does the aggregate touch `RunRecord`? | **No. No field is added to `packages/contract/src/runs.ts` or `packages/cezar/src/runs/store.ts`.** Provenance is stamped at read time by the index, and a note's link to its runs is derived by joining the note store's `resultingTasks` against the index. | Two reasons. First, "single-project mode preserved byte-for-byte" and "add a key to the shared record" pull against each other, and the preserved surface wins. Second, a back-pointer buys nothing here: `runs.json` prunes at `MAX_RUNS_KEPT = 300` (`packages/cezar/src/runs/store.ts:280`), so a persisted `run.note` disappears with the run exactly when the note's own pointer goes stale. The index already reads every project's live run ids, so staleness is detectable without a second field. This diverges from the design brief deliberately. |
| Q6 | How do the new surfaces get live updates? | **No new SSE name, no new WebSocket topic, no change to `packages/web/src/api/global-events.tsx`.** The aggregate refetches on focus and reconnect plus a bounded visible-tab interval; the note review screen polls its own note while `status === 'processing'` and stops on transition. | Honest, and a deliberate flagged exception to the "add a topic instead of a `refetchInterval`" rule in `AGENTS.md`. The workspace stream attaches only the boot context plus contexts that are ALREADY built (`packages/cezar/src/server/server.ts:4584-4591`), precisely because "subscribing never force-instantiates a project". So a live channel would be silent for exactly the never-opened projects the aggregate exists to surface. A real live channel needs a per-project `runs.json` watcher, which is a new mechanism with its own cost, and is out of scope. Raise it in review rather than shipping it quietly. |
| Q7 | Which account pays for a note pass? | **The machine-wide default: `resolveProfileEnvForRoot(undefined, runner)`.** | Already exists and already means this: `selectionFor(store, undefined, provider)` skips every per-root selection and returns `store.defaults[provider]` (`packages/cezar/src/workspace/agent-accounts.ts:279-286`). Charging project A's work subscription for a pass that mostly produced tasks for B is the mis-billing `packages/cezar/src/planner.ts:70-72` exists to prevent. |
| Q8 | Auto-drain, or a scheduler for notes? | **Neither. Processing is user-triggered, and nothing is created without explicit approval.** | An agent pass costs a real turn, and creating agent runs unattended in repos the user did not name is the highest-blast-radius thing this feature could do. cezar's own doctrine is "never launch blind". There is no `?auto=1`, ever. |
| Q9 | Do proposals carry `variants`? | **The field does not exist on the schema at all.** | Three projects times three variants from one click is nine agent runs from one approval. A schema that cannot express it is a stronger guard than a validation rule. |
| Q10 | Aggregate response shape? | **A new `WorkspaceRunSummary`, not a narrowing of `runRecordSchema`.** | `RunRecord` carries `task` (up to 100k), `queuedMessages`, `steps[]` and `workflowDef` (`packages/contract/src/runs.ts:139-260`). Two hundred of those across projects is megabytes for a table that renders about twenty fields. A new shape also narrows nothing protected. |
| Q11 | Does a new page path need a reserved slug? | **No, checked.** `RESERVED_PROJECT_IDS` (`packages/cezar/src/workspace/projects.ts:33-40`) needs no entry for `notes` or `workspace`. | Project slugs only ever appear under `/p/` in the cockpit and under `/api/v1/p/` on the wire, so `/notes` cannot collide with a project named `notes`. The client-side scope regex already exempts `/workspace/` (`packages/api-client/src/utils/project-scope.ts:86-87`), so both new route families are un-scoped by the existing rule with no edit. |
| Q12 | Mobile voice capture? | **Not solved, and not claimed.** | Section "Capture surfaces". The server binds loopback and the note route stays same-origin guarded. Opening a CORS hole on a route that ends in an agent run is the wrong trade at any convenience. |

## Problem Statement

**A.** With several repos registered, there is no way to ask "what is running, everywhere?". The
sidebar is N per-project lists stacked vertically, not one merged list
(`packages/web/src/components/project-groups.tsx:229` opens one `useProjectRuns` per group), and it
caps each at ten (`:33`, `RECENT_LIMIT = 10`). The Tasks table itself cannot express the question:
its data comes from `useRuns()`, its key is scope-led, and `GET /api/v1/p/:projectId/runs` takes no
query parameters at all (`packages/cezar/src/server/server.ts:3449`). So the natural client-side
answer is a fan-out across N projects, and that answer is actively dangerous (see the hazard
section).

**B.** Capture is the other half. A thought that spans repos has nowhere to land. The existing
inbox is per project and agent-authored: `todos.json` lives in `<repo>/.ai/cezar/`, and
`markStarted(dataDir, todoId, runId)` writes into the RUN's dataDir
(`packages/cezar/src/todos.ts:148-157`), so an entry filed under project A can never be marked by a
task created in B. That is the mechanical form of D14: a note that fans out to A, B and C would
have its resulting-task pointers spread across three different `runs.json` files while living in
only one of them, invisible from the other two and unreconcilable.

Three more reasons a note is workspace-scoped, in descending force after that one:

2. A note's value is precisely that it has NOT yet been assigned to a repo. Storing it under one
   repo answers the question the note exists to hold open.
3. Downgrade safety, on the `agent-accounts.json` precedent (`packages/cezar/src/paths.ts:110-124`):
   its own file means a cezar version that never heard of notes does not open it, so it cannot drop
   them. A key inside `config.json` would make survival depend on another version's passthrough.
4. Repo hygiene for free. `~/.cezar` is outside every checkout, so notes need zero
   `ensureDataGitignore` entries (`packages/cezar/src/index.ts:663-694`), and no dictated prose ever
   lands near a user's git history.

**The failure to avoid in B, stated up front.** The current Notion workflow produces one task per
line of a captured note. A per-line loop, or a pass that cannot see the board that already exists,
reproduces that by construction. It is not a quality problem to be tuned later, it is a shape
problem in the pass.

## Research

**The engine already crosses projects; only the views do not.** One `WorkspaceSemaphore` is shared
by every project's `RunManager` (`packages/cezar/src/server/project-context.ts:60-65` documents that
boot passes the one instance it already gave the boot manager), `busy()` sums every participant
(`packages/cezar/src/workspace/semaphore.ts:172-176`), per-project caps ride on top
(`:276-279`), and `release()` pumps every participant longest-queued-first (`:243-264`). Approving
nine tasks across three projects under a workspace cap therefore queues correctly with nothing to
build.

**Two identities, and they are not interchangeable.** The semaphore's per-project map is keyed by
realpath'd ROOT (`packages/cezar/src/workspace/semaphore.ts:47-54`), and so are agent-account
selections (`packages/cezar/src/workspace/agent-accounts.ts:35-39`, "keyed by the project's
REALPATH'D ROOT, not its registry slug"). Anything holding a slug must resolve to a root before
consulting a cap or an account.

**The right analogue for the note pass is `planChain`, not `automations`.**
`packages/cezar/src/planner.ts:55-103` is one cheap call on a resolved runner, strict JSON out,
sanitised against a catalog so the model cannot name things that do not exist
(`sanitizeSteps`, `:165-191`: an unknown skill is stripped and the step survives), one retry on an
unparseable answer, and a runner error degrades to a `fallback: true` result rather than an error.
`parseStructured` is already exported (`:225`), so a second JSON extractor would be a duplicate.

Three things differ from `planChain` and each decides a design point. It is workspace-scoped rather
than repo-scoped, so it needs the `AutomationCoordinator` shape (a lightweight workspace index that
opens per-project stores without materialising a `RunManager` or a `ProjectContext`,
`packages/cezar/src/automations/coordinator.ts:16-46`). It pays from the machine-wide account (Q7).
And its dedupe is a prompt shape rather than a post-filter.

**What is not reused from automations.** `renderAutomationTask`
(`packages/cezar/src/automations/task-template.ts:8-21`) validates against a CLOSED GitHub
placeholder set and demands a `GithubCandidate`. What is reusable is `launchAutomationRun`'s SHAPE
(`:38-45`: root, manager and store as parameters), which is already the cross-project seam. A note
launcher is written beside it rather than merged into it: a premature shared abstraction over two
different placeholder namespaces is the worse outcome under `CODE_REVIEW.md:11`.

**The gate contract already has a worked example.** `CEZ_FOLLOWUPS` gates the inbox as a
capability (`packages/cezar/src/server/capabilities.ts:135`), the GET degrades to a `200` empty list
rather than a 404 (`packages/cezar/src/server/server.ts:4353`), the mutators 409
(`:4344`, `:4358`), and the entries survive the flag being round-tripped off and on
(`packages/cezar/src/server/inbox-gate.test.ts:77-84`). `BACKWARD_COMPATIBILITY.md:47` states that
contract as protected. Both new families copy it exactly.

## Proposed Solution

**One invariant carries both features: READ never instantiates, WRITE always does.**

- **Read** (the aggregate board, the note list, the catalog, the board digest) goes through
  `WorkspaceRunIndex`, which parses each project's `runs.json` directly and never touches
  `ProjectContexts`, `RunStore` or `RunManager`.
- **Write** (approving a proposal into a real run) goes through `contexts.context(projectId)`
  deliberately. Creating work in project B is exactly the moment B should come fully online,
  recovery included, and it is the same trade the automation scheduler already accepts
  (`packages/cezar/src/server/server.ts:5195-5198`).

**A.** `GET /api/v1/workspace/runs` is one server-side aggregate, not a client fan-out. Four
reasons: provenance has to be authoritative (the server knows `bootProject`, the client would have
to infer it from which request answered); a fan-out over `GET /api/v1/p/:id/runs` triggers the
hazard below in every project at once; N round trips of up to 300 records each is wasteful; and a
full `RunRecord` payload is megabytes at that scale (Q10).

**B.** Capture writes a note. `POST .../process` computes and stores a pass and creates nothing,
ever. `POST .../approve` with explicitly named proposal ids is the only thing that creates runs,
fanning out server-side so the client makes ONE call and never touches the API scope singleton.
Each proposal's target project is chosen per row in the review screen, and an unknown target is
rejected, never coerced.

## Architecture

### `WorkspaceRunIndex` (W1.11), `packages/cezar/src/workspace/run-index.ts`

The shared foundation. Two methods:

- `list({projects?, view, limit})` returns `{runs, projects, truncated}`. Runs are stamped with the
  project's canonical registry slug and merged newest-first.
- `digest(projectIds, perProject)` returns per-project board entries (title, status, createdAt) for
  the note pass to dedupe against.

Rules, each with a reason:

- **Reads `<root>/.ai/cezar/runs.json` directly.** Never `RunStore.open`, which `mkdirSync`s
  (`packages/cezar/src/runs/store.ts:423`) and, without `keepLive`, rewrites live-looking statuses
  (`:417-421`). A read must not create directories in a repo the user only looked at, and must not
  report a `running` run as anything else.
- **Merge, do not sort.** `listRuns()` already returns `createdAt` descending
  (`packages/cezar/src/runs/store.ts:471-473`), so the aggregate is an N-way merge of sorted lists.
- **Scan cap 300 per project**, the store's own `MAX_RUNS_KEPT` (`:280`), so the index can never
  read more than the store keeps.
- **Cached per root on `mtimeMs` plus `size` with a short TTL.** The precedent is the registry's
  `probeCache` (`packages/cezar/src/workspace/projects.ts:177-186`, a 5 s TTL that exists to
  coalesce a burst of sidebar renders). Adding mtime and size means an unchanged file is not
  re-parsed at all, and a changed one is never served stale.
- **Per-project degradation, rendered rather than swallowed.** A missing root, an unparseable
  `runs.json` or an `EACCES` yields `{ok: false, reason}` and ZERO rows, never a throw and never a
  5xx. This matches the two existing doctrines: an unreadable registry degrades to `projects: []`
  (`packages/cezar/src/server/server.ts:1166-1169`), and broken todo JSON degrades to an empty inbox
  with a warning.

### Provenance and the boot project's two names

The boot project mounts UNSCOPED in the cockpit, so its cache lives under the `'default'` sentinel
rather than its own slug (`packages/web/src/routes.tsx:184-190`, `queryScope()` returns `'default'`
when unscoped at `packages/api-client/src/utils/project-scope.ts:76-78`). The sidebar already
carries a dedicated `boot: true` alias for exactly this
(`packages/web/src/api/queries.ts:640-653`). Server-side the same duality exists: `bootContext.id`
starts as the reserved alias `'default'` when registration was suppressed
(`packages/cezar/src/server/server.ts:1187-1189`), which is why handlers name the boot project
through `resolveBootProject()` (`:1131`) instead.

So the index resolves every project to its canonical registry slug through `resolveBootProject`
BEFORE stamping, exactly as the workspace SSE stream does (`:4581-4583` attaches the boot context
under `resolveBootProject()`, "NOT `bootContext.id`, which may be the reserved alias"). The
aggregate also returns `bootProject` in its body, so the client resolves links without a second
query. A run therefore appears exactly once, under one name, and REST agrees with SSE.

### The note pass (P2.2), `packages/cezar/src/notes/{coordinator,processor,prompt}.ts`

`NoteCoordinator` enumerates registered projects and reads each one's skills and workflows without
building a `ProjectContext` or a `RunManager`, on the `AutomationCoordinator` pattern
(`packages/cezar/src/automations/coordinator.ts:16-46`).

**ONE call decides ALL proposals, against the board that already exists.** The prompt carries: the
note body once; a per-project catalog (id, name, root basename, skills as `name, description`,
workflow names); and the board digest from `WorkspaceRunIndex.digest`, which is each project's live
non-archived run titles plus status plus age, newest first. The instructions are explicit: merge
lines that describe one piece of work, emit at most 12 proposals, say for each whether it duplicates
an existing board item and name it, and pick `project` only from the supplied catalog.

Caps, because 40 registered projects would explode the prompt: at most 25 projects by
`lastOpenedAt`, 30 skills per project, 40 board titles per project, 12 proposals. `consideredProjects`
and `boardDigestSize` are persisted on the pass and shown in the review header, so truncation is
visible rather than silent and "why did it miss the duplicate?" is answerable later.

Sanitisation mirrors `sanitizeSteps` (`packages/cezar/src/planner.ts:165-191`): an unknown `project`
keeps the proposal but flags `unknown-project` and defaults it to rejected, never retargeting it at
the boot project; an unknown `skill` is stripped and the prompt survives; an unknown `workflow` is
flagged and falls back to `quick-task` on approval. Parsing uses `parseStructured` imported from
`planner.ts` (`:225`), not a second extractor.

**It never blocks.** A runner error, or two unparseable answers, degrades to `fallback: true` with
exactly one proposal (the whole note, targeted at `projectHint ?? bootProject`, decision `pending`),
which is `planChain`'s own degradation (`packages/cezar/src/planner.ts:98-102`). **Zero proposals is
a valid successful pass**, rendered as "nothing actionable found", not an error.

### Idempotency: a double-click, a retry, or two tabs

Two independent guards, and each covers a case the other does not.

1. **Optimistic concurrency on the pass.** `approve` carries the `passId` and 409s when it is not
   the note's current pass, which is what a re-process in another tab produces.
2. **First-wins per proposal, under the store lock.** `markProposalCreated(noteId, proposalId, runId)`
   checks and sets `proposal.createdRunId` inside the same in-process lock that guards the write.
   This is a direct port of `markStarted` (`packages/cezar/src/todos.ts:143-157`), whose docblock
   states why sharing the lock is the mechanism: "the check shares this lock, so two concurrent
   launches cannot both claim the entry". A second approve of a claimed proposal creates nothing and
   reports the existing run id.

The claim is taken BEFORE `manager.startRun`, so the worst case is a claimed proposal with no run
(visible, retryable) rather than two runs from one click (invisible, expensive, and in two repos).

## The read-path hazard: looking at a board must not resume agent runs

**This is the single most dangerous thing in the feature and it is entirely invisible at the call
site.**

Verified chain, read rather than assumed:

1. Any request to `/api/v1/p/:projectId/...` passes `resolveProjectScope`, which for a real slug
   calls `contexts.context(raw)` (`packages/cezar/src/server/server.ts:1369`).
2. `context()` builds lazily on first access; `build()` opens the store with `keepLive: true`,
   prunes orphan worktrees, reclaims worktrees, and then calls `await manager.recover()`
   (`packages/cezar/src/server/project-context.ts:202-232`, the recover call is `:231`).
3. `recover()` is not a read. It re-queues every `queued` run via `reviveQueuedRun`
   (`packages/cezar/src/workflows/run.ts:1030-1032`), settles `waiting` runs (`:1034-1046`), and for
   every `running` run marks it interrupted and calls
   `continueRun(run.id, {text: RESTART_CONTINUATION_PROMPT}, ...)` (`:1047-1064`).

So a client fan-out that renders an "all projects" board by hitting `GET /api/v1/p/:id/runs` once
per project would **silently resume interrupted agent runs in every registered project, at the
moment the user opened a view.** A naive server-side aggregate that called `contexts.context(id)` in
a loop would do exactly the same thing.

The codebase already knows this and already refused it once, in prose worth quoting: the active-run
count for project deletion is taken from `contexts.peek()` and never `context()`, "because building
one to answer the question would recover and resume runs on a project being deleted, which is the
exact opposite of what the caller asked for" (`packages/cezar/src/server/server.ts:2680-2691`). The
workspace SSE stream is built on the same rule, attaching only the boot context plus contexts that
are already built (`:4584-4591`).

**The design that makes it unreachable rather than merely discouraged:**

- The read path is a read-only parser over each project's `runs.json`. `run-index.ts` imports
  neither `runs/store.ts`, nor `server/project-context.ts`, nor `workflows/run.ts`. A structural
  test asserts that by reading the module source, so the invariant cannot rot into a comment.
- Provenance is stamped in by the index from the registry, resolved through `resolveBootProject` so
  the boot project is emitted under its own slug and never the `'default'` alias.
- `mtimeMs` plus `size` caching keeps the repeated read cheap without a context.
- Per-project degradation means one unreadable project contributes `{ok: false, reason}` and zero
  rows instead of failing the request.

**Two facts that make the workspace mount safe, both checked.** First, the aggregate is mounted in
`workspaceV1` (`packages/cezar/src/server/server.ts:5104-5114`), which is single-mount and never
mirrored under `/p/:projectId`, so `route-parity.test.ts`'s three-way obligation does not apply.
Second, a workspace route still passes `resolveProjectScope` because `v1`'s `use('*')` covers the
prefix, but with no `:projectId` param that middleware sets the ALREADY-SEEDED boot context and
returns immediately (`:1356-1361`). It builds nothing. The behavioural control for this is stated in
Verification: `contexts.ids()` must be unchanged across a request to the aggregate.

## Data Models

### On disk

```
~/.cezar/
  config.json           (existing, the registry)
  ui-state.json         (existing, plus one new `workspaceTasks` key)
  agent-accounts.json   (existing)
  notes.json            NEW  { version: 1, notes: NoteRecord[] }
  notes.json.bak        NEW  last-known-good, the config.json discipline
  notes-log.ndjson      NEW  append-only pass receipts, 90-day retention
```

`notesPath()` and `notesLogPath()` are added to `packages/cezar/src/paths.ts` beside
`agentAccountsPath()` (`:110-124`), because that module's docblock is explicit that it owns homedir
logic and later specs import it (`:9-15`). Every write passes
`assertCezarHomeWriteIsSandboxed()` (`:33-45`), so a test with `CEZ_HOME` unpinned fails loudly
rather than rewriting the developer's real home.

Shape follows `runs.json`: one JSON array of full records plus an NDJSON sidecar, not a file per
note. Writes are tmp-plus-rename atomic, serialised by an in-process lock keyed by path (the
15-line port at `packages/cezar/src/todos.ts:39-56`), with a `.bak` snapshot on every mutation, which
is the discipline `packages/cezar/src/workspace/config.ts:338-358` already applies to the registry.
A corrupt or non-array file degrades to an empty list with one warning. Retention prunes on create:
200 live notes, 500 archived. Bodies cap at 100_000 chars, matching `RunRecord.task`.

**No `.ai/cezar/.gitignore` entry is needed or added.** The workspace home is outside every
checkout, so `ensureDataGitignore`'s `wanted` list (`packages/cezar/src/index.ts:666-683`) stays
untouched. That is asserted, not assumed.

### `packages/contract/src/notes.ts`

```ts
export const noteStatusSchema = z.enum(['raw', 'processing', 'processed', 'failed']);
export const noteSourceSchema = z.enum(['cockpit', 'cli', 'api']);   // closed; 'watch' added additively later
export const proposalDecisionSchema = z.enum(['pending', 'approved', 'rejected']);
export const proposalIssueSchema = z.enum([
  'unknown-project',   // the pass named a project not in the catalog, defaults to rejected
  'missing-root',      // registered, but its folder is gone
  'unknown-workflow',  // falls back to quick-task on approval
  'not-git',           // cannot host a worktree proposal
  'models-locked',     // agentModelsLocked(root) refuses the proposed model
]);

export const noteProposalSchema = z.object({
  id: z.string().min(1),                    // stable within the pass
  projectId: z.string().min(1).max(64),     // the TARGET registry slug, the whole point
  title: z.string().min(1).max(200),
  task: z.string().min(1).max(100_000),
  skill: z.string().max(200).optional(),
  workflow: z.string().max(200).optional(),
  runner: runnerSchema.optional(),
  model: z.string().max(200).optional(),
  agentProfile: z.string().max(200).optional(),
  rationale: z.string().max(2_000).default(''),
  confidence: z.enum(['high', 'medium', 'low']).optional(),
  duplicateOf: z.object({
    projectId: z.string(), runId: z.string().optional(),
    title: z.string(), reason: z.string().max(500),
  }).optional(),
  issues: z.array(proposalIssueSchema).default([]),
  decision: proposalDecisionSchema.default('pending'),
  createdRunId: z.string().optional(),      // first-wins guard, written only by approve
});
// NB: there is deliberately no `variants` key (Q9).

export const notePassSchema = z.object({
  id: z.string().min(1),
  startedAt: z.string(), finishedAt: z.string().optional(),
  runner: runnerSchema, model: z.string().optional(),
  summary: z.string().max(4_000).default(''),
  proposals: z.array(noteProposalSchema).max(12),
  unassigned: z.array(z.object({ text: z.string().max(2_000), reason: z.string().max(500) })).default([]),
  /** True when the pass degraded to the whole-note single proposal. Never blocks. */
  fallback: z.boolean(),
  truncated: z.boolean().default(false),
  consideredProjects: z.array(z.string()),
  boardDigestSize: z.number().int(),
  error: z.string().max(1_000).optional(),
});

export const noteRecordSchema = z.object({
  id: z.string().min(1),
  capturedAt: z.string(),
  source: noteSourceSchema,
  sourceRef: z.string().max(200).optional(),   // shortcut name, filename, script id
  body: z.string().min(1).max(100_000),
  status: noteStatusSchema,
  title: z.string().max(200),
  titleOrigin: z.enum(['user', 'auto']),
  projectHint: z.string().max(64).optional(),  // ADVISORY. Never a default, never a constraint.
  processedAt: z.string().optional(),
  pass: notePassSchema.optional(),             // the LATEST pass only; history is in the ndjson
  resultingTasks: z.array(z.object({
    proposalId: z.string(), projectId: z.string(), runId: z.string(), createdAt: z.string(),
  })).default([]),
  archived: z.boolean().optional(), archivedAt: z.string().optional(),
});

/** List row. Body trimmed to a 280-char excerpt so a 100k note never rides the list. */
export const noteSummarySchema = noteRecordSchema
  .omit({ body: true, pass: true })
  .extend({ excerpt: z.string(), proposalCount: z.number().int(), targetProjects: z.array(z.string()) });
```

**CORRECTED 2026-08-06 by `cezar/.ai/specs/2026-08-06-inbound-agent-control-channel.md`:**
`noteRecordSchema.sourceRef`'s docblock comment above, `// shortcut name, filename, script id`, is
incomplete on its own. The inbound control channel spec adds a fourth caller of `source: 'api'`: a
text message. Its notes write an opaque command id into `sourceRef` (`cmd_01J...`), never a handle
or a chat id, so a reviewer cannot recover who sent it from that field alone. The comment text above
is left as originally written; read it together with this note.

### `packages/contract/src/workspace-runs.ts`

```ts
/** Deliberately NOT a narrowing of runRecordSchema (Q10): a new shape, so nothing protected moves. */
export const workspaceRunSummarySchema = z.object({
  project: z.string(),   // canonical registry slug. The boot project under its OWN slug, never 'default'.
  id: z.string(), title: z.string(), titleSummary: z.string().optional(),
  workflow: z.string(), status: runStatusSchema, activity: z.literal('monitoring').optional(),
  createdAt: z.string(), startedAt: z.string().optional(), finishedAt: z.string().optional(),
  diffStat: diffStatSchema.optional(), branch: z.string().optional(),
  groupId: z.string().optional(), variant: z.string().optional(),
  archived: z.boolean().optional(), seenAt: z.string().optional(),
  tokensUsed: z.number().optional(), costUsd: z.number().optional(),
  pullRequestUrl: z.string().optional(), prNumber: z.number().optional(),
  issueNumber: z.number().optional(), error: z.string().optional(),
  autoResumeAt: z.string().optional(), monitoringWakeAt: z.string().optional(),
  /** Derived at read time by joining the note store, NOT persisted on the run (Q5). */
  noteId: z.string().optional(),
});

export const workspaceRunsResponseSchema = z.object({
  runs: z.array(workspaceRunSummarySchema),
  /** Per-project health, so a dead project is RENDERED, never silently absent. */
  projects: z.array(z.object({
    id: z.string(), name: z.string(),
    status: z.enum(['ok', 'missing', 'not-git']),
    ok: z.boolean(), reason: z.string().optional(), total: z.number().int(),
  })),
  truncated: z.boolean(),
  bootProject: z.string(),
});
```

Every field here is a stored value or a stored timestamp. **No clock-derived field rides a GET body**
(PLAN D8): `route-parity.test.ts` issues the same GET three times and compares bodies byte for byte,
so an age computed at request time would be a flaky red gate debugged as alias drift.

### `~/.cezar/ui-state.json`, one additive key

```ts
// packages/contract/src/workspace.ts, inside workspaceUiStateSchema (a looseObject at :194)
/** Last-used cross-project board filter. Restored ONLY when the URL carries no `projects` param.
 *  The PUT merges SHALLOWLY at the top level (see the note at :183-186), so a writer sends this
 *  WHOLE object, never a leaf. */
workspaceTasks: z.looseObject({
  projects: z.array(z.string()).optional(),
  view: z.enum(['active', 'archived']).optional(),
}).optional(),
```

`workspaceLastLocationSchema` requires `pathname.startsWith('/p/')`
(`packages/contract/src/workspace.ts:186-192`), so a workspace path can never be stored as the
restore target. That is intentional and is documented rather than "fixed": a bare `/` must keep
landing on a project, never on `/workspace/tasks`.

## API Contracts

All new routes are **workspace-level and single-mount** in `workspaceV1`
(`packages/cezar/src/server/server.ts:5104-5114`), never mirrored under `/api/v1/p/:projectId`.
Every shape is a zod schema in `packages/contract`; every route is registered by CHAINING into a
family builder with an inferred return type (never annotated, never a loose `app.get(...)`, which is
what `typed-bodies.test.ts:5-16` exists to catch); every body and query is validated as MIDDLEWARE
through `jsonZodValidator` / `queryZodValidator` (`packages/cezar/src/server/validators.ts:88`,
`:160`), because a handler-side parse is invisible to `AppType`; everything answers under `/api/v1`.

**The flag-off shape, confirmed and identical for both families (PLAN D19).** When
`CEZ_WORKSPACE_VIEWS` or `CEZ_NOTES` is off, **every `GET` answers `200` with an empty payload and
every mutator answers `409`. Never `404`, on any route, in either family.** The feature is switched
off, not missing: a `404` tells the typed client the route does not exist, which contradicts the
client's own contract and breaks `bc-route-inventory.test.ts`'s reading of a built app's route table.
This is the `CEZ_FOLLOWUPS` contract copied exactly (`packages/cezar/src/server/server.ts:4353`
degrades the GET, `:4344` and `:4358` refuse the mutators with 409), and it is protected prose at
`BACKWARD_COMPATIBILITY.md:47`. The `404`s that remain below are all ordinary
unknown-id answers on a route whose flag is ON, which is a different question.

### A. Cross-project runs, `CEZ_WORKSPACE_VIEWS=1` maps to `capabilities.workspaceViews`

```
GET /api/v1/workspace/runs
  query  projects?  csv of registry slugs. ABSENT MEANS ALL PROJECTS, never none. Max 64 ids.
                    csv follows the `GET /api/v1/github/checks?prs=<csv>` precedent.
         view?      'active' | 'archived'      default 'active'
         limit?     1..500                     default 200
  200  workspaceRunsResponseSchema
  200  { runs: [], projects: [], truncated: false, bootProject }   capability off (D19: a GET
                   degrades to an empty payload; never 404, and never 409 on a read)
  200  same empty payload   CEZ_SINGLE_PROJECT=1, which reports the capability false and so takes
                   the identical flag-off shape
  400  { error }   malformed query only
```

The empty payload is schema-valid `workspaceRunsResponseSchema`, not a bare `{}`, so a client parses
one shape whether the flag is on or off. This family is read-only, so it has no mutator to 409; the
409 half of D19 is exercised by the notes family below.

Never 5xx on a bad project: an unknown id is dropped from `projects[]`; a missing or unreadable one
appears with `ok: false, reason` and contributes zero runs.

**Deliberately unchanged:** `GET /api/v1/runs` and `GET /api/v1/p/:id/runs` keep their exact handler
and shape (`packages/cezar/src/server/server.ts:3449`) and still take no query parameters.

### B. Notes, `CEZ_NOTES=1` maps to `capabilities.notes`

```
GET    /api/v1/workspace/notes?status=raw|processing|processed|all&projects=<csv>&limit=1..200
       200 { notes: NoteSummary[], truncated }
       200 { notes: [], truncated: false }  when the capability is OFF (D19 and the GET /todos
                      degrade precedent: a gate, never a 404, and never a 409 on a read)

POST   /api/v1/workspace/notes
       body { body: 1..100_000, source?, sourceRef?: <=200, projectHint?: projectId }
       201 { note } | 409 { error } when off  (D19: every mutator in this family refuses with 409)
       Same-origin guarded (#426). NOT CORS-open: /api/v1/health remains the only one.
       THE single write path. Cockpit textarea, phone Shortcut and webhook all use this route.

GET    /api/v1/workspace/notes/:noteId          200 { note } | 404 unknown id, flag ON
                                                200 { note: null }  when the capability is OFF, so the
                                                404 keeps meaning "no such note" and never "no such
                                                feature" (D19)
PATCH  /api/v1/workspace/notes/:noteId          body { title?, body?, projectHint? | null, archived? }
                                                200 { note } | 404 | 409 while status === 'processing'
                                                409 when off
DELETE /api/v1/workspace/notes/:noteId          200 { removed: true } | 404 | 409 when off

POST   /api/v1/workspace/notes/:noteId/process
       202 { note }   status flips to 'processing'; the pass runs in the BACKGROUND (an agent call
                      up to 90 s must not hold a request open) and lands on the note.
       409 { error }  already processing
       409 { error }  the provider gate refuses the workspace default runner
       409 { error }  when off
       CREATES NOTHING. Ever.

POST   /api/v1/workspace/notes/:noteId/approve
       body { passId, proposals: [{ id, projectId?, title?, task?, workflow?, skill?, runner?,
                                    model?, agentProfile? }] }   // 1..12, edits override the pass
       200  { note,
              created:  [{ proposalId, projectId, runId }],
              rejected: [{ proposalId, projectId, status: 404|409|400, error }] }
       409  pass is stale (passId is not the note's current pass)
       409  CEZ_SINGLE_PROJECT=1 and any target is not the pinned project
       409  when off
       404  unknown note

POST   /api/v1/workspace/notes/:noteId/reject
       body { proposals: [id] }   200 { note } | 409 when off
```

`approve` is **all-or-nothing per proposal, partial across proposals, reported in a 200 body.** A 4xx
would make partial success unreadable. A rejected row stays `pending` so the user can fix it in the
review screen and re-approve. An unknown target is REJECTED, never coerced to the boot project.

### Per-proposal validation inside `approve`, in order

1. `contexts.context(projectId)` resolves the target. This is a write path, so instantiating (and
   recovering) the target is correct and intended. `ProjectContextError` maps to 404 (unknown) or
   409 (missing root) INTO THAT ROW, never into the response status
   (`packages/cezar/src/server/project-context.ts:69-84`).
2. Resolve `ProjectContext.root` before touching any cap or account, because both are keyed by
   realpath'd root and not by slug (`packages/cezar/src/workspace/semaphore.ts:47-54`,
   `packages/cezar/src/workspace/agent-accounts.ts:35-39`).
3. `agentModelsLocked(root)` with a proposed model gives 409 into the row, reusing
   `AGENT_MODELS_LOCKED_ERROR` (`packages/cezar/src/server/server.ts:3493-3494`).
4. Workflow named, so `loadWorkflows(root)`; unknown gives 404 into the row. Skill through
   `discoverSkills(root)`; unknown is stripped and the prompt survives. Neither gives `quick-task`.
5. `providerActionError(providersRequiredByWorkflow(...))` gives 409 into the row
   (`packages/cezar/src/server/server.ts:3511-3513`).
6. A supplied `agentProfile` is resolved and a stale id gives 400 into the row, matching the
   `POST /runs` honesty rule: a user's explicit pick gets an honest answer, unlike a replayed stored
   id (`packages/cezar/src/server/server.ts:3514-3521`).
7. Claim the proposal first-wins under the note store's lock, then `manager.startRun(...)`.

### CLI

```
cezar note "text"          # registry-only. No server, no HTTP: the `cezar projects` pattern
cezar note -               # body from stdin:  pbpaste | cezar note -
       [--project <slug>]  # sets projectHint (advisory), validated against the registry
```

Writes `~/.cezar/notes.json` directly through the P2.1 store, exactly as
`packages/cezar/src/workspace/projects-cli.ts:7-16` does for the registry ("It talks to
`~/.cezar/config.json` ... directly, NOT over HTTP: the whole point is that it works with no server
running"). Under `CEZ_SINGLE_PROJECT=1` the command refuses, matching the server's refusal, on the
`projects-cli.ts:33` precedent.

### Contract and inventory obligations (the drift guards that fail a build)

- `packages/contract/src/index.ts` gains exactly two `export *` lines, appended after
  `./automations.ts` (currently line 16).
- `BACKWARD_COMPATIBILITY.md` section 2 gains two bullets, in the existing format, and both state the
  same D19 shape: one for the workspace runs route (new shape, additive, present always, gated on
  `CEZ_WORKSPACE_VIEWS=1`, the GET degrading to a schema-valid empty payload when the capability is
  off and under `CEZ_SINGLE_PROJECT`, never 404), one for the notes family (present always, gated on
  `CEZ_NOTES=1`, the GET degrading to `200 {notes: [], truncated: false}` and every mutator 409, never
  404). Enforced by `bc-route-inventory.test.ts`, which
  reads a BUILT app's route table and brace-expands the prose, so it cannot be satisfied by accident.
- `contract-parity.notes.test.ts` and `contract-parity.workspace-runs.test.ts` assert mutual
  assignability in BOTH directions; a one-way check passes on real drift.
- `typed-bodies.test.ts` gains one assertion per mutating route.
- `versioned-surface.test.ts` is satisfied: everything is under `/api/v1`.
- `route-parity.test.ts` does not apply, and that is the point of mounting workspace-level.
- `.env.example` documents `# CEZ_NOTES=1` and `# CEZ_WORKSPACE_VIEWS=1` **in the same commit that
  introduces them** (`AGENTS.md:19`: "an undocumented env var is a bug"), in the same commented form
  as `# CEZ_SINGLE_PROJECT=1` (`.env.example:68`) and `# CEZ_FOLLOWUPS=1` (`:88`). README's env table
  gains both rows.

**No new runtime dependency.** The budget stays hono, @hono/node-server, yaml, zod, smol-toml, ws
(`CODE_REVIEW.md:52`), and this spec adds nothing to it: zod for schemas, the existing runner factory
for the agent call, native `node:fs` for the index.

## UI/UX

**Zero-config throughout.** Nothing here asks the user to configure anything: the project list comes
from the registry, the aggregate defaults to all projects, the note pass discovers each project's
skills and workflows, and the account is the machine default. The only knobs are the two on/off
flags, which is what `AGENTS.md:14` asks of a feature that widens what the server does.

**Nav.** One new item, `Notes`, gated on `capabilities.notes` as a third clause in `visibleNavItems`
beside `forge` and `inbox` (`packages/web/src/components/nav-items.ts:68-70`), and a `workspace: true`
marker so it renders once in the shell's top-level nav rather than inside each project group. That
marker exists because every nav item today renders per group and links through
`scopeTo(project.id, item.to)` (`packages/web/src/components/project-groups.tsx:336`), which would
produce `/p/shop/notes` for a surface that has no project.

**The nav fixture churn is one file, not six.** Checked rather than assumed: the fixtures in
`app-shell.test.tsx:65-76`, `command-palette.test.tsx:196-198` and `project-groups.test.tsx:161-170`
all render through `visibleNavItems` with the availability they pass, so a `notes` gate defaulting to
false drops the item and leaves them green. Only `nav-items.test.ts` asserts `NAV_ITEMS` directly
(`:67-76`) and asserts `visibleNavItems({forge: true, inbox: true})` equals `NAV_ITEMS` (`:94-96`),
and both live in the file the scaffold already owns.

**No second Tasks nav item.** The cross-project board is reached from a segmented
`[ This project | All projects ]` switch in the Tasks view header, navigating between `/p/<id>/` and
`/workspace/tasks`. It renders only when `capabilities.workspaceViews` is true and
`projects.length > 1`, the same threshold that reveals the sidebar at all
(`packages/web/src/components/app-shell-container.tsx:105`), and never under `singleProject`.

**Notes list, `/notes`.** A capture textarea pinned at the top ("What's on your mind?", Cmd+Enter to
file). Below it, note cards: relative age, source chip, status dot, the pass-generated title or the
dimmed first line while unprocessed (so nothing pretends to be a title it is not), a `projectHint`
chip when present, and for a processed note a row of target-project chips with run counts. Status
tabs plus the shared project filter, which here filters on a note's RESULTING projects.

**Review screen.** A full-screen overlay, the sibling of `PlanReview`
(`packages/web/src/routes/plan-review.tsx:40-51`: numbered, editable, removable cards with a
Start / Discard footer). Header: the collapsible note body, the pass summary,
`Considered N projects, M board items`, and a dim degraded note when `fallback` is true. One card per
proposal with an approve/reject checkbox, an editable title and task, skill / workflow / runner /
model pills that re-resolve when the target changes, a rationale line, and a
`duplicate of "<title>"` chip.

Two rules baked into the screen:

- A row defaults to **approved**, except rows carrying `duplicateOf` or an `unknown-project` or
  `missing-root` issue, which default to **rejected**. The safe default is the one that creates less
  work.
- The per-row project picker **SETS A FIELD**. It is built from the same registry-fed picker as the
  composer's project pill, and the code carries a comment saying the difference in capitals, because
  it is the single most confusable thing here: the composer's pill NAVIGATES
  (`packages/web/src/routes/new-task.tsx:598` does
  `navigate('/p/<next>/new', { replace: true })`, remounting the whole scoped subtree). Each card
  shows the project's name AND its root's basename, so `chat` versus `chat-fork` is visible before
  the click rather than after.

On approve there is **no automatic navigation**: a cross-project batch has no single thread to open,
unlike the composer. Per-row Open links point at `/p/<project>/tasks/<runId>`; rejected rows carry the
server's own wording inline.

**Workspace Tasks board, `/workspace/tasks`.** Reuses `TasksOverview`, whose own docblock states it
is presentational and takes its rows as a prop
(`packages/web/src/routes/tasks-overview.tsx:48-59`), so sorting, search, queue numbers, attention
derivation and the mobile stacked-card layout come free. Three additions: an optional project column
(folded into the meta line below `md`), the shared project filter, and the scope switch. The one real
edit inside the component is a row's href becoming `/p/<project>/tasks/<id>` rather than
scope-relative.

**Filter state lives in the URL**: `/workspace/tasks?projects=alpha,beta&view=active`. Every cockpit
surface is a URL, a filtered board is the thing that gets pasted to someone, and back and forward
must move the filter. **Absent `projects` means ALL projects, never none.** The last-used selection
mirrors into `~/.cezar/ui-state.json` and is restored ONLY when the URL carries no `projects` param,
which is the `lastLocation` rule that an explicit link always wins
(`packages/web/src/routes.tsx:240-256`). Unknown or removed ids are dropped on read and the URL
rewritten with `replace`, so a stale bookmark never shows an unexplained empty board.

**The scope trap, and its guard.** `/workspace/tasks` mounts OUTSIDE `ProjectScopeRoute`, as the
second non-project cockpit area beside `/settings/global/*` (`packages/web/src/routes.tsx:514-529`).
With no scope mounted, `queryScope()` returns `'default'`
(`packages/api-client/src/utils/project-scope.ts:76-78`) and any project-local call would silently hit
the boot project: wrong data, no error, no symptom. The guard is that the view uses only
`workspaceQueryKeys.*` (`packages/web/src/api/queries.ts:193-215`) and workspace-level client
functions, enforced by a request-assertion test in the mould of the existing one that asserts an
unscoped endpoint is NEVER called (`packages/web/src/routes/new-task-project.test.tsx:352`).

**States that must not lie.**

- Aggregate with a dead project: rows render, and a warning strip names each `ok: false` project with
  its reason. Never silently fewer rows.
- Filter matching nothing: "No projects match this filter" plus a Clear action, distinct from "no
  tasks yet".
- Capability off: the nav item is ABSENT rather than disabled, and the route if reached directly
  renders the copy pattern at `packages/web/src/routes/inbox.tsx:94-101`, with restart wording, since
  like `followups` these are effectively boot-time flags
  (`packages/cezar/src/server/capabilities.ts:118-126`).
- `runs` undefined versus `[]`: the header renders and the body stays empty until the aggregate
  answers. An empty state before we know there are no runs would be a lie.
- Processing: the note card shows a spinner and disables Process; a second attempt 409s rather than
  starting a duplicate pass.

## Capture surfaces, and the one thing this does not replace

Three surfaces, in priority order, and all three write through the same path.

1. **Cockpit textarea** at the top of `/notes`, Cmd+Enter to file. The primary path.
2. **`POST /api/v1/workspace/notes`**, the SAME route the textarea calls. One write path, not two.
   This is what a phone Shortcut, a webhook, or `curl` posts to.
3. **`cezar note "..."` and `cezar note -`**, registry-only, no server. `pbpaste | cezar note -`
   makes every shell and every editor hook a capture surface for free.

Deliberately deferred: a watched drop directory (an `fs.watch` per directory, a debounce, a
"finished writing?" heuristic and a dedupe key, and the existing watcher at
`packages/cezar/src/todos.ts:161-166` shows how much care one costs, while the API route covers the
case with a two-line script), and any external connector, which is out of scope for cezar's identity
and blocked by the dependency budget at `CODE_REVIEW.md:52`. That deferral is exactly why the API
route is in the minimum set.

**Mobile voice capture is the one thing this does not replace, and cezar cannot solve it
internally.** The server binds `127.0.0.1` and that loopback guarantee is load-bearing
(`AGENTS.md:71` describes the global `/api/*` request-origin guard, with `/api/v1/health` as the sole
CORS-open exception). A phone on the same wifi cannot reach it. Three real paths already exist and
none of them is new code here: an existing `cezar server-install --domain` deployment, so a Shortcut
POSTs to `https://<domain>/api/v1/workspace/notes` behind that install's Basic Auth; an existing
tunnel; or capture into a synced folder and drain with a cron `cezar note -`.

**We ship none of them and we open no hole.** The note route is a write that eventually causes an
agent to run, so it stays behind the same-origin guard and is NEVER added to the CORS-open list.
Say so in the README rather than implying the feature covers a phone.

## Single-project mode is preserved byte-for-byte

`CEZ_SINGLE_PROJECT` is a released, documented narrowing whose stance is to remove choices rather
than disable them, and whose refusals are server-side (`packages/cezar/src/server/server.ts:2375`,
`:2441`, `:2496`, `:2559`, with the read pins at `:1154-1157` and `:2352`). Both new features respect
it in both directions.

- `GET /api/v1/runs` and `GET /api/v1/p/:id/runs` are untouched: same handler, same shape, still no
  query parameters. The aggregate is a NEW route with a NEW shape, so `bc-route-inventory.test.ts`
  gains two section-2 bullets and edits none.
- `/p/:projectId/` remains the home. `LegacyPathRedirect` is unchanged, and a bare `/` still restores
  `lastLocation` or lands on the boot project, never on `/workspace/tasks`. That is enforced for free
  by `workspaceLastLocationSchema`'s `startsWith('/p/')`
  (`packages/contract/src/workspace.ts:186-192`).
- With ONE registered project the cockpit is byte-identical to today: the scope switch appears only
  above `projects.length > 1`, the same threshold that reveals the sidebar
  (`packages/web/src/components/app-shell-container.tsx:105`).
- Under `CEZ_SINGLE_PROJECT=1` both capabilities report false, both nav affordances vanish, and both
  route families take the D19 flag-off shape server-side: reads answer 200 with a schema-valid empty
  payload, every mutator refuses with 409, and nothing anywhere answers 404. Hiding the nav alone
  leaks; the server must also refuse. (An earlier draft said a flag-off GET 409s. It does not: a read
  degrades, a write refuses.)
- With both flags unset, `GET /api/v1/health` and the agent system prompt must be byte-identical to
  the pre-change build (PLAN, "Verification that the plan itself is honest"). Anything less is not
  opt-in.
- No field is added to `RunRecord` or to `runs.json` (Q5), so a downgraded cezar reads exactly what
  it read before.

## Phases

Package ids are the PLAN's. Nothing here re-derives a decision recorded there.

| PLAN id | Wave | Scope in this spec | Depends on |
|---|---|---|---|
| **W1.1** | 1, SOLO scaffold | `packages/contract/src/{notes,workspace-runs}.ts` (the schemas above), the `export *` lines in `contract/src/index.ts`, both booleans on `capabilitiesSchema` in `contract/src/health.ts` and on `resolveCapabilities`, inert flag-gated `server/{notes,workspace-runs}-routes.ts` plus their two mount lines in `workspaceV1`, both `contract-parity.*` files, `typed-bodies.test.ts`, `notesPath()`/`notesLogPath()` in `paths.ts`, `case 'note':` plus HELP in `cezar/src/index.ts`, both cockpit routes in `web/src/routes.tsx`, the `Notes` nav entry plus `notes?`/`workspace?` on `NavItem` in `nav-items.ts` and its test, `web/src/components/project-groups.tsx` and `web/src/routes/tasks-overview.tsx` (both scaffold-owned per PLAN D22c, edited once, by W1.1 alone), the typed wrappers in `web/src/api/{client,queries}.ts`, `BACKWARD_COMPATIBILITY.md` section 2, `.env.example`, `README.md` | W0.1 |
| **W1.11** | 1 | `packages/cezar/src/workspace/run-index.ts` plus test. The shared foundation. Read-only, side-effect-free, provenance-stamping, mtime-plus-size cached, per-project degrading. | W1.1 |
| **W3.1** | 3, SOLO | Registers the run index at workspace level in `server/project-context.ts`. Already in its declared scope. | W1.11 |
| **W4.10** | 4 | `server/workspace-runs-routes.ts` handlers plus test, `web/src/routes/workspace/{workspace-tasks,workspace-filter-state}.*`, `web/src/components/project-filter.tsx` plus tests. Takes over and fills the two W1.1 stubs (route file, cockpit entry) it inherits: a sequenced hand-off, never a concurrent edit. **Feature A ships here and is complete without any of P2.** | W3.1, W1.11 |
| **P2.1** | 2 | `packages/cezar/src/notes/{types,store}.ts` plus tests. Durable entity, atomic locked store, retention, log sidecar, first-wins claim. No HTTP, no agent, no web. | W1.1 |
| **P2.2** | 2 | `packages/cezar/src/notes/{coordinator,processor,prompt}.ts` plus tests. The one-pass, board-aware, catalog-constrained engine. | P2.1, W1.11 |
| **P2.3** | 2 | `server/notes-routes.ts` handlers, `notes/task-template.ts` plus tests. Capture, list, read, edit, process, approve fan-out, reject. | P2.2, W3.1 |
| **P2.4** | 2 | `web/src/routes/notes/*` plus tests. Inbox, capture box, review overlay. Takes over and fills W1.1's `notes/notes.tsx` stub: a sequenced hand-off, never a concurrent edit. | P2.3 |
| **P2.5** | 2 | `notes/cli.ts` plus test. `cez note`. | P2.1 |
| **W5.1** | 5, SOLO, exclusive | `web/e2e/{workspace-tasks,notes}.e2e.ts`. **No other package may run `npm run test:e2e`.** | all of wave 4 |

**Ordering that matters.** A is landable alone: W1.1, W1.11, W3.1, W4.10, and nothing from P2. B
needs W1.11 for its board digest, which is why the index is a wave-1 leaf rather than living inside
either feature.

### Shared-file ownership: what the scaffold owns, and the two sequenced hand-offs

Stated here rather than discovered mid-dispatch, because the PLAN's clause 5 says a package that
needs a file the scaffold did not create must hand back to the orchestrator. All of it is W1.1's, and
all of it is safe with both flags off. **Nothing in this list is an amendment this feature makes to a
file another package also edits**, which is the collision D6 exists to make unreachable.

1. **Two cockpit shared files, scaffold-owned outright (PLAN D22c).** `web/src/components/project-groups.tsx`
   (one clause, so a `workspace: true` item is not rendered inside a project group and therefore never
   receives `scopeTo`, `:336`) and `web/src/routes/tasks-overview.tsx` (the
   `[ This project | All projects ]` switch in the header, rendered only when
   `capabilities.workspaceViews && projects.length > 1`) are **W1.1's files, edited once, by the
   scaffold**. No package in this spec touches either afterwards. Earlier drafts of this section
   listed them as amendments this feature requires; that reading is superseded by D22c, because two
   packages editing one cockpit file is precisely the failure the scaffold exists to prevent.
2. **Two cockpit entry stubs, created by W1.1 and filled later: a hand-off, not a collision.**
   `web/src/routes/workspace/workspace-tasks.tsx` and `web/src/routes/notes/notes.tsx` are created by
   the scaffold as capability-gated placeholders, so `routes.tsx` is edited exactly once. W4.10 then
   **takes ownership of** `workspace-tasks.tsx` and P2.4 of `notes/notes.tsx`, and fills it. The two
   packages are strictly downstream of W1.1 in the wave order (W4.10 after W3.1, P2.4 in phase 2), so
   the scaffold's write and the filling write are never concurrent and never merge: this is a
   sequenced hand-off of a file whose owner changes once, not two owners at the same time. The same
   applies to `server/{notes,workspace-runs}-routes.ts`, created inert by W1.1 and filled by W4.10 and
   P2.3.

**Explicitly NOT touched by anything in this spec:** `packages/contract/src/runs.ts`,
`packages/cezar/src/runs/store.ts`, `packages/web/src/api/global-events.tsx`,
`packages/cezar/src/workspace/projects.ts`. Q5, Q6 and Q11 are what removed the need for each.

## Risks

- **Fan-out by construction.** The pass produces one task per line of the note, which is the exact
  failure being escaped. *Mitigation:* dedupe is a prompt shape, not a post-filter. ONE call decides
  ALL proposals, and the prompt carries a digest of every considered project's live board. The
  response schema requires an explicit `duplicateOf` per proposal, and a row carrying one defaults to
  rejected. `consideredProjects` and `boardDigestSize` are persisted and shown, so a missed duplicate
  is diagnosable rather than mysterious.
- **Opening a view resumes agent runs everywhere.** *Mitigation:* the hazard section above, enforced
  by a structural import test and a behavioural `contexts.ids()` control.
- **A task is created in the wrong repository.** The model names a project that does not exist, or a
  target-less proposal falls back to the boot project, and an agent starts editing a repo nobody
  meant. *Mitigation:* never default a target. Unknown or absent is flagged and rejected, never
  coerced; the model can only name projects from the supplied catalog; the review card shows the
  project name AND its root basename; the approve response names the project on every created row.
- **One approval creates duplicate runs.** *Mitigation:* two guards, stale-`passId` 409 and the
  first-wins claim under the store lock, ported from `markStarted`
  (`packages/cezar/src/todos.ts:143-157`).
- **The workspace board silently reads the boot project.** *Mitigation:* workspace-only query keys
  and client functions, with a request-assertion test.
- **The boot project appears twice.** *Mitigation:* the server stamps `resolveBootProject()`'s slug
  authoritatively and returns `bootProject` in the body.
- **One unreadable project blanks or 500s the board.** *Mitigation:* per-project degradation,
  rendered rather than swallowed.
- **Prompt explosion and cost.** Forty registered projects would put forty catalogs and forty boards
  into one prompt, and every pass is a real LLM call. *Mitigation:* hard caps recorded on the pass,
  the machine-wide account (Q7), and no scheduler and no auto-drain (Q8).
- **The new surfaces leak past `CEZ_SINGLE_PROJECT=1`.** *Mitigation:* refuse server-side AND hide
  client-side, tested in both directions.
- **A stale run pointer on a note.** `runs.json` prunes at 300, so a note can name a run that no
  longer exists. *Mitigation:* the index knows every live run id, so the note view renders "no longer
  in this project's history" rather than a dead link. This is the reason Q5 does not need a
  persisted back-pointer.
- **The live-update exception (Q6) gets waved through in review.** *Mitigation:* it is written down
  here as an exception with its reason, not buried in a component. If a reviewer wants a topic, the
  cost is a per-project `runs.json` watcher and it should be a separate package.

## Verification

The gate is exactly five commands, in order, and **there is no lint step and no format step in
cezar**: `npm run typecheck`, `npm test`, `npm run test:unit`, `npm run build`,
`npm run test:package`. `packages/contract` has no `test` script, so contract-only acceptance is
`npm run typecheck`. Green gates are necessary and not sufficient (`SDLC.md:69` on the QA label).

**Every control below names what must FAIL when the mechanism is disabled.** A test that passes
either way proves nothing.

### Negative controls, feature A

1. **The read path never instantiates.** *Control:* `contexts.ids()` is captured before and after a
   request to `GET /api/v1/workspace/runs` across three registered projects and must be identical,
   and a fixture run whose stored status is `running` must be reported as `running`.
   *Must fail when:* the index is switched to `contexts.context(id)` or `RunStore.open`. Under
   `RunStore.open` without `keepLive` the `running` row is rewritten
   (`packages/cezar/src/runs/store.ts:417-421`), and under `contexts.context` the id set grows. If
   the control still passes with either substitution, the control is decorative and the invariant is
   unproven.
2. **The structural import guard.** *Control:* read `run-index.ts`'s source and assert it imports
   none of `runs/store.ts`, `server/project-context.ts`, `workflows/run.ts`.
   *Must fail when:* any one import is added. This is the guard that keeps control 1 from having to
   be re-derived by the next reader.
3. **No directory is created by a read.** *Control:* point the index at a fixture project whose
   `.ai/cezar/runs` directory does not exist, call `list()`, and assert it still does not exist.
   *Must fail when:* the read goes through `RunStore.open`, which `mkdirSync`s at `store.ts:423`.
4. **Absent filter means ALL.** *Control:* two registered projects, `GET /api/v1/workspace/runs` with
   no `projects` param must return both projects' runs.
   *Must fail when:* the query default is changed to an empty array. An absent filter meaning an
   empty board is the silent version of this bug.
5. **The boot project appears once, under its own slug.** *Control:* with the boot project registered,
   its runs appear exactly once, and no row carries `project: 'default'`.
   *Must fail when:* the stamp is taken from `bootContext.id` instead of `resolveBootProject()`
   (`packages/cezar/src/server/server.ts:1187-1189` is where the alias comes from).
6. **One dead project does not blank the board.** *Control:* three projects, one with a corrupt
   `runs.json`, must answer 200 with the other two's runs and exactly one `ok: false` entry carrying
   a reason.
   *Must fail when:* the per-project try/catch is removed (the request 500s) or when the failure is
   swallowed without an entry (the count of `ok: false` entries drops to zero while rows silently
   disappear).
7. **Cache correctness, both directions.** *Control:* a second `list()` inside the TTL with unchanged
   mtime and size performs no re-read (asserted with a read counter), AND a `list()` after the file
   is rewritten returns the new rows.
   *Must fail when:* the cache key drops `size` or `mtimeMs` (the second half fails), or when the
   cache is removed (the first half fails). Only asserting the first half would let a permanently
   stale board pass.
8. **The payload is not a `RunRecord`.** *Control:* 200 aggregated rows serialise under 512 KB, and
   the schema has no `task`, `steps`, `queuedMessages` or `workflowDef` key.
   *Must fail when:* the route starts echoing full records.
9. **Gating in both directions, in the D19 shape.** *Control:* with `CEZ_WORKSPACE_VIEWS` unset the
   GET answers **200 with a schema-valid empty payload, not 409 and not 404**, and the nav affordance
   is absent; with it set to `'1'` both work; with it set to `'true'` it stays off. Assert the status
   code explicitly, not just the empty body.
   *Must fail when:* the check is loosened to a truthiness test, or the flag-off answer is changed to
   404 or 409. A body-only assertion would pass against a 404, which is the exact answer D19 forbids.
10. **Flag-off byte identity.** *Control:* with both flags unset, `GET /api/v1/health` and the agent
    system prompt are byte-identical to the pre-change build.
    *Must fail when:* either capability is defaulted on, or a prompt block is emitted unconditionally.

### Negative controls, feature B

11. **The pass is not a per-line loop.** *Control:* a fixture note of six lines describing two pieces
    of work yields at most three proposals, and the runner is invoked exactly ONCE.
    *Must fail when:* the processor loops per line. Asserting only the proposal count would pass a
    loop that happened to merge; asserting the call count is what makes the shape provable.
12. **The pass can see the board.** *Control:* a fixture note restating an existing run's title
    produces a proposal carrying `duplicateOf` with that run id.
    *Must fail when:* the board digest is removed from the prompt. Run the same fixture with an empty
    digest and assert the `duplicateOf` is ABSENT, so the digest is proven load-bearing rather than
    incidental.
13. **Process creates nothing.** *Control:* snapshot every registered project's `runs.json` bytes
    before and after `POST .../process` and assert byte equality.
    *Must fail when:* any creation path leaks into the process route.
14. **No silent retarget.** *Control:* a proposal naming an unregistered slug creates nothing, answers
    that row 404 in `rejected[]`, and leaves the boot project's `runs.json` byte-identical.
    *Must fail when:* an unknown target falls back to the boot project. Asserting only the 404 would
    miss a fallback that also logged an error.
15. **Approve is idempotent under concurrency.** *Control:* two concurrent approves of the same pass
    produce exactly one run per proposal, and a stale `passId` 409s.
    *Must fail when:* the claim is moved outside the store lock, or taken after `startRun`.
16. **Never blocks.** *Control:* force a runner error, then force two unparseable answers. Both yield
    `fallback: true` with exactly one proposal and no thrown error.
    *Must fail when:* either failure mode is allowed to reject.
17. **Zero proposals is success.** *Control:* a note with nothing actionable answers 200 with an empty
    proposal list and `fallback: false`, not an error.
18. **The right account pays.** *Control:* assert on the env handed to the runner that it came from
    `resolveProfileEnvForRoot(undefined, runner)` and not from any project root.
    *Must fail when:* a project root is passed, which is observable because a per-root selection then
    wins over `store.defaults` (`packages/cezar/src/workspace/agent-accounts.ts:279-286`).
19. **The store never writes the real home.** *Control:* a store test run with `CEZ_HOME` unpinned
    must FAIL loudly through `assertCezarHomeWriteIsSandboxed` (`packages/cezar/src/paths.ts:33-45`),
    not write.
20. **The gate is lossless, and in the D19 shape.** *Control:* file notes with `CEZ_NOTES=1`, unset
    it, confirm the list GET answers **200** `{notes: [], truncated: false}`, the single-note GET
    answers **200** `{note: null}`, and every mutator (POST, PATCH, DELETE, process, approve, reject)
    answers **409**; then set it again and confirm the same notes come back unchanged. Assert the
    status code on every one of those routes: **no route in either family may answer 404 because a
    flag is off.** This is the `inbox-gate.test.ts:77-84` losslessness pattern.
    *Must fail when:* any flag-off handler answers 404, or a mutator degrades to a 200 instead of
    refusing.
21. **No gitignore entry appears.** *Control:* assert `ensureDataGitignore`'s `wanted` list
    (`packages/cezar/src/index.ts:666-683`) is unchanged and that no note path is added to it.
    *Must fail when:* note state is moved into a repo, which is the mechanical form of D14.
22. **The picker sets a field.** *Control:* changing a review row's project issues no navigation and
    remounts nothing, which is the exact opposite of the composer pill
    (`packages/web/src/routes/new-task.tsx:598`), and re-resolves that row's skill, workflow and model
    pills against the new target.
23. **No `variants` key exists.** *Control:* assert on the schema itself, so a three-projects-by-three-variants
    surprise is structurally impossible rather than merely validated against.

### Runtime and e2e

24. **e2e (W5.1 only, `CEZ_DRY_RUN=1`).** With two registered projects: the board shows both
    projects' tasks, filtering to one hides the other's rows, and the URL reflects it; then capture a
    note, process it, uncheck one proposal, approve, and verify tasks appear in two different
    projects' task lists.
25. **QA gate.** Both features are user-facing cockpit changes, so the PR carries `needs-qa` and must
    not merge without `qa-approved` (`SDLC.md:69`). A `CEZ_DRY_RUN=1` session covers most of it
    (`SDLC.md:71`). Gates green is not the finish line.

### Validation

Run in this order, from the repo root, each in its own worktree per the PLAN's dispatch contract:

```bash
npm run typecheck        # includes pretypecheck -> build:server; also enforces the type-level assertions
npm test                 # vitest run
npm run test:unit        # -w @open-mercato/cezar
npm run build            # build:server + build:web + check:pack
npm run test:package     # -w @open-mercato/cezar
```

Targeted runs while iterating. **Always through npm, never `npx vitest`** (PLAN D21, `AGENTS.md:99`):
vitest is a pinned devDependency here, so `npm test` uses the installed binary while `npx` reaches
past it to the registry and gives a slow, networked, silently-different run. Narrowing arguments go
after `--`.

```bash
npm test -- packages/cezar/src/workspace/run-index.test.ts                    # W1.11  (C1, C2, C3, C7)
npm test -- packages/cezar/src/server/workspace-runs-api.test.ts              # W4.10  (C4, C5, C6, C8, C9)
npm test -- packages/cezar/src/server/contract-parity.workspace-runs.test.ts  # W1.1
npm test -- packages/cezar/src/server/bc-route-inventory.test.ts              # the drift guards
npm test -- packages/cezar/src/server/versioned-surface.test.ts
npm test -- packages/cezar/src/notes                                          # P2.1 to P2.3, P2.5
npm test -- packages/web/src/routes/workspace packages/web/src/routes/notes   # W4.10, P2.4
```

**Do not run `npm run test:e2e`.** One instance, one port 4321, one `.ai/qa/test-env.lock`,
`fileParallelism: false`. W5.1 owns it and it is a global mutex. **There is no lint step and no
format step in this repo; do not invent one.**

## Alternatives considered and rejected

- **Client-side fan-out over `GET /api/v1/p/:id/runs`.** Disqualified by the hazard section on its
  own, and separately by cost and payload size.
- **A `project` field on `RunRecord`.** Would make provenance authoritative at the source, but it
  edits a protected record for a feature that can derive the same fact at read time, and it breaks
  "single-project mode preserved byte-for-byte" for no gain the index does not already provide (Q5).
- **A ticket entity in phase 2.** PLAN D13. Building a backlog row here and again in F5 is how the
  board and the executor become the same broken thing.
- **Notes inside `<repo>/.ai/cezar/`.** PLAN D14 and the Problem Statement. The pointer-scattering
  argument alone settles it.
- **A per-project spelling of the new routes.** A second surface to protect with no consumer, and it
  would drag `resolveProjectScope` (and therefore `contexts.context()`) in front of a read.
- **A new SSE name or WebSocket topic for live aggregate updates.** Q6. It would be silent for
  exactly the never-opened projects the aggregate exists to surface, and it edits a central file no
  package owns.
- **A watched capture directory.** Deferred; the API route covers it with a two-line script.

## Open questions for the owner

1. **The live-update exception (Q6).** `AGENTS.md` prefers a subscription topic over a
   `refetchInterval`. This spec takes the interval and says why. Confirm, or fund a per-project
   `runs.json` watcher as its own package.
2. **Closed, not open: the shared-file ownership question.** An earlier draft asked the owner to
   grant three ownership amendments before dispatch. PLAN D22c settled it: `project-groups.tsx` and
   `tasks-overview.tsx` are **W1.1's**, and the route and cockpit stubs are scaffold-created hand-offs
   to W4.10 and P2.4. Nothing here needs an owner decision, and it should not be re-raised at
   dispatch.
3. **Upstreamability.** PLAN D2 puts F3 in the upstreamable set, and nothing in this spec names Loki
   or any Loki-specific string. Worth confirming that a `Notes` nav item and a `/workspace/tasks`
   board are features a general cezar user wants, before the scaffold spends its central-file budget
   on them.
