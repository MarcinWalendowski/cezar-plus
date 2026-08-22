# Every task records its author — user, API, or the agent session that spawned it

**Status: IMPLEMENTED + DEPLOYED 2026-08-22 — Phases 1-4, then HOTFIXED the same day (see the
correction directly below; "VERIFIED" was in this heading and was wrong). Phase 5 not started (it
was always optional). Shipped as `5f8cfced` + `64394362`, fast-forwarded onto `main`, deployed to
cockpit.example.com as release `20260822T122039Z-64394362` (rootless blue-green; both
`.ai/deploy-targets.json` probes exit 0 — backend `live=64394362 == HEAD`, UI `serving
assets/index-3BBCV-iR.js == the built bundle`).**

**CORRECTED 2026-08-22 — Phase 4 shipped a crash, and the shape of the miss is the lesson.**
`AuthorCell` renders a Radix `Tooltip`, and a bare `Tooltip` with no `TooltipProvider` above it does
not degrade — it *throws*. The run header, the third call site and one this very change added, has
no provider, so every task carrying an author white-screened its thread page in production with
``Uncaught Error: `Tooltip` must be used within `TooltipProvider` ``. Fixed by giving `AuthorCell`
its own provider — the same conclusion `ReferenceChip` had already reached for the same reason, in
the same codebase.

**Both browser passes below missed it because both only ever opened the two BOARDS.** The runs
table and the Filed board each wrap their `<table>` in a `TooltipProvider`, so the cell cannot fail
there; §Solution also puts the provenance "as a sentence in the run header's meta row", and that is
the one surface neither pass loaded. The verification was real and careful and confined to the
surfaces that were structurally incapable of failing — which is why the second pass, whose whole
point was to close a coverage gap, closed a gap on the same two boards. **A change that adds a
component to N surfaces has to be opened on N surfaces**; a surface that "already works" is exactly
where a shared component is cheapest to check and least likely to be checked.

The unit tests could not catch it either, in two independent ways: `run-header.test.tsx` (1073
lines) never set `author` on a fixture, so `if (run.author)` never rendered; and
`author-cell.test.tsx` mounted its own `TooltipProvider`, which makes a missing-provider bug
structurally unreachable no matter how many cases it adds. Both are fixed — §Verification 22-24.

**The DATA path is verified in production, on real records, not fixtures:**

- **`kind: 'agent'` with the pair the owner required.** `cezar todo add`, run by the deployed CLI
  from inside this task's own agent session, stamped
  `{kind: 'agent', via: 'cli-todo-add', parentTaskId: '232ad6d4-…', agentSessionId: '2aa7483d-…',
  parentStepId: 'continue-5'}` — the parent task AND the agent session, which is requirement 3
  read literally.
- **`CEZ_STEP_ID` / `CEZ_SESSION_ID` reach a live agent.** Confirmed in this session's own
  environment after the deployed server respawned it (`continue-5` / `2aa7483d-…`). Phase 2's
  premise held on the real box, not just in the test.
- **`kind: 'user'` from a real person.** A run a user started through the composer two seconds
  after activation (12:20:43Z; activated 12:20:41Z) carries
  `{kind: 'user', via: 'workspace-composer'}`. Not a fixture — an unrelated task someone filed.
- **Backward compatibility proven against production data.** 61 run records scanned across the
  workspace and every registered project: 1 carries an author, 60 do not, and all 61 load. The
  additive-optional field does exactly what §Backward compatibility claims.

**The BROWSER check (§Verification 18-20) has now been RUN and passed** — Playwright/Chromium on
this box (`AGENTS.md` § Headless browser), against a throwaway cockpit seeded with one run of each
author kind. Screenshot at the time of writing: `/tmp/qa-author-column.png`.

- The `Author` header renders on the runs table, between `Ref` and `Workflow`.
- All three kinds render as designed, in one table:
  `[{kind: 'agent', via: 'cli-todo-add', text: '⤷ aaaaaaaa'}, {kind: 'user', via: 'composer',
  text: 'Marcin'}, {kind: 'none', text: '—'}]`.
- The agent cell is a real link to its parent — `href="/p/qa-cockpit/tasks/aaaaaaaa-1111-…"`,
  resolved through `TaskLocationProvider` (divergence 1), not built from the child's own project.
- Hovering it shows the full sentence: *"Started by an agent in task aaaaaaaa, session cb916c71
  (step implement) via cezar todo add"* — the parent task AND the agent session, on screen.
- Zero page errors.

**Confirmed a second time, independently, and it covered two things the first pass did not**
(2026-08-22, port 4399, fixture with all FOUR states). Recorded because the gap is the useful part:
the run above checked the runs table and three kinds, so the **Filed board's** Author column and
the **`api`** kind were unverified until now.

- Both boards carry the header: `["Status","Task","Project","Author","Priority","Age","Actions"]`
  (Filed) and `[…,"Ref","Author","Workflow",…]` (runs) — one page, two tables, one column.
- `{kind: 'api', via: 'composer'}` renders `API`, and carries no parent link.
- An agent-authored **todo** on the Filed board links to its parent exactly as an agent-authored
  run does, which is what divergence 1's shared `AuthorCell` was for.

The method both passes used is now written down in `AGENTS.md` §"Verifying a cockpit UI change —
boot a throwaway cezar on a spare port", so the next UI change does not have to rediscover the
Access wall, the inherited `CEZ_PUBLIC_URL` that blocks boot, or the org-adoption gate.

**Why a throwaway cockpit and not production:** cockpit.example.com sits behind Cloudflare Access,
and the prod API answers `401` to an unauthenticated loopback client, so the SPA redirects to the
Access sign-in and never renders a board. Driving the real cockpit needs credentials this task does
not have and should not acquire. The fixture instance ran the SAME deployed bundle
(`/opt/cezar/packages/cezar/dist`), on an isolated `HOME` and its own port, and was stopped
afterwards.

**Remaining unverified: §Verification 21 only** — the Author FILTER, which is divergence 3 and was
never built. Filed as todo `2d53e16c`. Written in the `spec` step of the `spec-to-deploy` run for task
`232ad6d4-58a5-421e-941f-5c24bd5a8452`; Phases 1-3 built in the `implement` step of the same run,
Phase 4 after the owner confirmed the orphan-prune fix (`5ffa383c`) had landed.

**Divergences from the design below, all deliberate:**

1. **The parent link is resolved by the page, not by a scoped URL.** §Solution promised the Author
   cell would link to `/p/:projectId/tasks/:parentTaskId`. That URL is wrong more often than it is
   right — a workspace run's parent lives in the workspace's own store, not in the project the
   child landed in, so the child's `projectId` is not the parent's. What shipped is
   `TaskLocationProvider` (`web/src/components/author-cell.tsx`): the cross-project board already
   holds every project's rows, builds an id → path map from them, and supplies it through context
   (the `ReferenceStatusProvider` precedent in the same file). A parent the page cannot locate
   renders as plain text. An unlinked id is honest; a 404 that looks like a feature is not.
2. **Both board shapes were widened, not just the global one.** `author` was added to
   `runIndexEntrySchema` (`contract/src/runs.ts`) AND `workspaceRunSummarySchema`
   (`contract/src/workspace-runs.ts`). `run-index.ts`'s own comment says the two boards must not
   drift, and a provenance column on one of them is exactly that drift.
3. **The Author filter facet is NOT implemented.** §Solution's fourth bullet listed one. The
   facet-space plumbing lives in two separate modules with their own URL params and tests
   (`lib/global-tasks.ts`, `lib/filed-tasks.ts`), and adding it would roughly double this phase's
   diff for a convenience, so it is deferred rather than half-built. `authorFacet()` and
   `authorFacetLabel()` (`web/src/lib/task-author.ts`) are implemented and tested, so the facet is
   a wiring job, not a design one.
4. **The column is hidden on narrow viewports** (`lg:` on the Filed table, `xl:` on the runs
   table), following the rule the runs table's own header comment states: every column is pinned
   as narrow as it can be so Task keeps the pixels it gives up.

**Date:** 2026-08-21

**Owner ask (verbatim):** *"Add author to every task: when created, auther (user or API, if
different agent sessions, require what was parent task + agent session)"*

Read as three requirements, in the order they appear:

1. **Every** task carries an author, stamped at creation — not a subset, not best-effort.
2. The author says **which kind of actor** made it: a person, or a program calling the API.
3. When the actor is **another agent session**, the record must name **the parent task and the
   agent session inside it** — and "require" is taken literally: a record claiming an agent author
   without both of those is invalid, not merely incomplete.

## Related records read before writing this

- **Knowledge base:** searched `cez kb search` for `task author attribution`,
  `task created by agent session`, `parent task child session spawn`,
  `cezar run provenance origin who started`, `cezar principal auth local userId`. **There is no
  KB entry about run/task provenance or authorship.** The nearest neighbours are about the
  *surfaces* this touches, not the field: `local:2026-08-19-tasks-page-and-start-grounding`
  (Start injects the whole todo, not just the title), `local:2026-08-17-filed-tasks-table-statuses-changelog`
  (todos gained `status`/`priority`/`archivedAt`), `local:2026-08-17-open-tasks-inbox-doctrine`
  (open tasks live in the todo inbox, corpus `tasks/` is the archive), `notion-c5319dc6cadd` +
  `notion-74e42908cc82` (the optional OIDC/Google auth, orgs and teams that produced the
  `Principal` this spec reads), `notion-b8c7168f38aa` (the cross-project workspace run).
  Nothing to extend or contradict — this is a new field, and it is the first one.
- **Todos:** `cezar todo list` → *no todos filed*. No duplicate work in flight.
- **Specs (`.ai/specs/`, 126 files):**
  - `2026-08-19-file-tasks-from-a-running-task.md` — the spec that created the agent→task path
    this one must attribute. It introduced `cezar todo add`, hard-coded `origin: 'agent'` on the
    todo, and left `TODO(analytics)` markers where an actor would have gone.
  - `2026-08-17-filed-tasks-table-statuses.md` — the precedent for *how* to add fields to the todo
    twins (additive, optional, `.omit()` on the create input for server-stamped fields). This spec
    copies its shape exactly.
  - `2026-08-15-knowledge-grounded-task-fanout.md` — where `origin: 'agent' | 'composer'` came
    from (D2/D4). That enum is the closest thing to an author today, and §Problem explains why it
    is not one.
  - `2026-08-15-cross-project-workspace-run.md` — the workspace run path (`POST /workspace/runs`).
  - `2026-08-20-chain-integrity-restart-and-continuation.md` — why "who created this record" and
    "who resumed it" are different questions; this spec answers only the first.
- **Git:** `git log --oneline -20`. Head is `04be7d0b` (docs: record the one Settings area).
  Nothing in the last twenty commits touches `runs/store.ts`'s schema or `todos.ts`. The most
  recent schema-shaped change in the area is `0cbb65a4` (reopen finished tasks), which added
  `reopen-requests.ts` — including the one `source` string discussed in §Problem.
- **Conventions:** `AGENTS.md` §Zero config (*never trade a working default for a knob*),
  §"Changing a mechanism that already works" (*a replacement that ships OFF is not a
  replacement*), §Shipping cezar itself (gates first, `.env.example` is the env contract's single
  documentation surface). `BACKWARD_COMPATIBILITY.md` §2 (HTTP API), §3 (`.ai/cezar/` state
  files), §general rule (*additive changes are fine*).

## TLDR

Add one additive optional object, `author`, to **both** task-shaped records — `RunRecord`
(`runs.json`) and `TodoItem` (`todos.json`) — stamped at creation by the server, never accepted
from a client. It names the actor (`user` / `api` / `agent` / `automation` / `system`), the
surface it came through (`via`), and, when the actor is an agent, the **parent task id and agent
session id**, which a zod `.refine` makes mandatory for that kind.

The enforcement is not the schema field (which must stay optional, for the records already on
disk) — it is the **input type**: `RunStore.createRun` and `createTodo` take `author` as a
**required** argument, so all eight existing creation paths and every future one fail to compile
until they name one. Two new env vars, `CEZ_STEP_ID` and `CEZ_SESSION_ID`, give a child `cezar`
process the "which agent session" half that `CEZ_TASK_ID` alone cannot supply.

## Problem

**Nothing on a cezar task says who made it.** Confirmed by reading both schema twins end to end
(`packages/contract/src/runs.ts:219-432`, `packages/cezar/src/runs/store.ts:120+`) and every
creation site:

1. **`RunRecord` has no actor field at all.** The single mint point is
   `RunStore.createRun` (`packages/cezar/src/runs/store.ts:647`, record literal at `:666`), whose
   accepted input (`store.ts:647-664`) is `title, workflow, task, model, runner, agentProfile,
   generateFollowups, autonomous, stepBudgetOverride, worktree, workspaceProjects, groupId,
   variant, steps` — no origin, source, createdBy or parent of any kind. Its only caller is
   `RunManager.startRun` (`packages/cezar/src/workflows/run.ts:1027`, `:1037`).

2. **Eight distinct paths reach that mint point, and seven record nothing about who asked:**

   | # | Path | Site | Records the actor? |
   |---|---|---|---|
   | 1 | `POST /api/v1/runs` (composer) | `server/server.ts:4671`, start at `:4736` | no — the principal is on `c` (`server.ts:1767`) and is not read |
   | 2 | `POST /api/v1/workspace/runs` | `server/workspace-run-routes.ts:79`, start at `:135` | no |
   | 3 | `POST /api/v1/todos/:id/start` (▶ Run) | `server/server.ts:5694`, start at `:5723` | no — only the reverse link, `markStarted` at `:5728` |
   | 4 | Todo autostart (`--start`) | `todo-autostart.ts:38` | no — explicit `TODO(analytics)` at `:39-42` |
   | 5 | CLI `cezar run "<task>"` | `index.ts:857` | no |
   | 6 | GitHub automation | `automations/task-template.ts:67-76` | **yes**, and only here |
   | 7 | Note approval → spec run | `notes/approve.ts:129` | no — the link is on the note (`:139`) |
   | 8 | Note continuation → impl run | `notes/continuation.ts:107` | no — the parent run id is **prose inside the prompt** (`continuation.ts:117-122`) |

3. **The one path that does record provenance proves the shape works and proves it is too
   narrow.** `RunRecord.automation` (`contract/src/runs.ts:257-265`) carries
   `{ automationId, automationRevision, receiptId, event, githubUrl }`, applied as a
   post-creation `updateRun` patch (`task-template.ts:69-76`). Its own doc comment
   (`contract/src/runs.ts:248-256`) frames it as *"Provenance for a task a project GitHub
   automation launched… Absent on every ordinary run, which is what makes it additive."* That is
   exactly the sentence this spec generalises — except that a patch-after-create can be skipped,
   which is why `author` goes in the constructor instead.

4. **The parent→child relationship exists and is unrecorded.** `notes/continuation.ts` starts an
   implementation run *because* a spec run finished, and the child's only trace of its parent is
   the string `Implement the spec written by run ${run.id}` in its prompt (`continuation.ts:119`).
   `groupId`/`variant` (`contract/src/runs.ts:385/387`) link *siblings* (parallel variants), never
   a parent. There is no `parentTaskId` anywhere in the codebase.

5. **A child process already knows its parent task, and exactly one caller uses it.**
   `CEZ_TASK_ID` **is the run id** (`workflows/run.ts:968`, inside `agentEnv`). The only code that
   reads it is `runs/reopen-cli.ts:270-272`, which builds `source = cli:${taskId}` — and even that
   is dropped before it reaches a record: `reopen-watch.ts:45` calls `continueRun` and never
   forwards `request.source` (with another `TODO(analytics)` at `:50-53`). `todo-cli.ts` — the
   agent's own "file a task" command — does **not** read it (`todo-cli.ts:178-190`), so a task
   filed by an agent loses the filing agent's identity at the first hop.

6. **"Which agent session" is unavailable to a child at all.** A session id is a *step*-level
   field (`contract/src/runs.ts:85-93`, `StepState.sessionId`), minted at
   `workflows/run.ts:4071` and reconciled from the backend at `:4110`/`:2862`. It is never
   exported into the child environment (`agentEnv`, `workflows/run.ts:961-978`, sets
   `CEZ_HANDOFF_FILE`, `CEZ_TASK_ID`, `CEZ_TODOS_FILE`, `CEZ_KB_*`, `TMPDIR` and nothing else).
   So today the owner's third requirement is not merely unrecorded — it is **not reachable** from
   where a task gets filed.

7. **`TodoItem.origin` looks like an author and is not one.** `z.enum(['agent','composer'])`
   (`todos.ts:73`, wire twin `contract/src/skills.ts:105`) names *a writer class*, with no
   identity, no parent, and no distinction between the human at the composer and a script posting
   to the same route. `origin: 'agent'` is hard-coded by `todo-cli.ts:179` whether the caller is
   an agent or a human typing `cezar todo add` in a terminal.

8. **The identity to record already exists and is already read — three times, never at
   creation.** `Principal` (`server/server.ts:477-485`), resolved by
   `auth/principal.ts:115-125` behind `app.use('/api/*')` (`server.ts:1767-1834`), is read by
   `approverOf` (`server.ts:1110-1114`, for `pendingApproval.approvals[].by`), `triagedBy`
   (`workspace-reports-routes.ts:218-222`) and the project routes (`server.ts:3128`, `:3255`,
   `:3299`). `approverOf`'s doc comment already works through the `'local'` fallback question this
   spec has to answer, and answers it the same way.

**What the absence costs.** On a cockpit running six-step `spec-to-deploy` chains that can file
and auto-start further tasks (`2026-08-19-file-tasks-from-a-running-task.md`), the Tasks board is
a flat list in which a task the owner typed, a task an automation fired, and a task an agent span
off mid-run are visually identical. When a run misbehaves — the ten spurious "Ship it" tasks of
`local:2026-08-21-tmpdir-inside-repo-defeats-test-isolation` are the worked example — there is no
field to sort, filter or group by to find the source; that investigation had to reason from
timestamps. Runaway-fanout containment (the risk `2026-08-19-file-tasks-from-a-running-task.md`
§Risks named and mitigated only by keeping `--start` explicit) has no data to act on either.

## Solution

### The record: one `author` object on both task-shaped records

```ts
taskAuthorSchema = {
  kind: 'user' | 'api' | 'agent' | 'automation' | 'system',
  id: string,                      // stable identity of the actor
  label?: string,                  // display only
  via: <surface enum>,             // which door it came through
  at: string,                      // ISO 8601, stamped at creation
  parentTaskId?: string,           // required when kind === 'agent'
  agentSessionId?: string,         // required when kind === 'agent'
  parentStepId?: string,           // the workflow step id, when known
}
```

`kind` answers the owner's "user or API"; `parentTaskId` + `agentSessionId` answer "if different
agent sessions". `via` is the thing the two `TODO(analytics)` markers wanted and is what makes the
field useful for triage. Full definition in §Data models.

**Meaning of each `kind`, decided rather than left to the implementer:**

- **`user`** — a person acting through the cockpit. `id` is `principal.userId` when a session
  principal exists, and the literal `'local'` on an unauthenticated single-machine install. This
  is `approverOf`'s exact rule (`server.ts:1110-1114`) and its exact justification: *"'local' is
  an honest single identity for an unauthenticated deployment: one machine, one approver."* A
  headless `cezar run` at a terminal is also a `user` with id `'local'` — it is a person typing.
- **`api`** — a program calling `/api/v1` rather than a person clicking. See §"Telling `user`
  from `api`" for the discriminator, which is the only genuinely novel decision here.
- **`agent`** — a running cezar agent session caused this task to exist. **Requires**
  `parentTaskId` and `agentSessionId` (`.refine`). Covers `cezar todo add [--start]` from inside a
  run, todo autostart, and the note continuation trigger.
- **`automation`** — a GitHub automation. `id` is the `automationId`; the existing
  `RunRecord.automation` object stays exactly as it is and keeps carrying the detail, so this is
  a pointer, not a migration.
- **`system`** — cezar itself, with no external actor: today only restart-time paths. Deliberately
  the narrowest kind, so that a lazy implementation reaching for it stands out in a grep.

### Telling `user` from `api`

Both arrive at the same routes behind the same principal middleware, and in the default
zero-config install both resolve to the same `local` principal (`server.ts:1805-1808`). The
discriminator is therefore **the request, not the principal**:

- A request carrying browser fetch metadata (`Sec-Fetch-Site: same-origin` / `same-site`, or an
  `Origin` the existing `originGuard` accepted — `server.ts:1737-1738`) is the **cockpit**, i.e.
  a `user`.
- A request without it — `curl`, a script, the api-client from Node, a machine bearer
  (`supervisor/internal-auth.ts:60`) — is `api`.
- A **forwarded supervisor principal** (`supervisor/forwarded-principal.ts:161`) with
  `kind: 'session'` is still a `user`: it is a signed assertion about a person.

**Its failure mode, stated rather than hidden:** a `fetch()` typed into the browser devtools
console reads as `user`. That is accepted — it *is* the user's own browser, and the alternative
(a client-supplied `author`) is forgeable, which is strictly worse. **`author` is never accepted
from a request body on any route**, on either record. `createTodoInputSchema` puts it in the
`.omit()` list beside `archivedAt` (`contract/src/skills.ts:126-132`), for exactly the reason
that comment already gives.

### The enforcement: required at the input boundary, optional on the schema

This is the load-bearing design decision, and it is what makes "**every** task" true rather than
aspirational.

- **On the persisted/wire schema, `author` is optional.** Every `runs.json` and `todos.json`
  already on disk lacks it, and `BACKWARD_COMPATIBILITY.md` §3 makes rejecting those a breaking
  change. Absent `author` renders as *"unknown (created before 2026-08-21)"* — never as a guess.
- **On the constructor input types, `author` is required.** `RunStore.createRun`'s input object
  (`store.ts:647`) and `createTodo(dataDir, input, author)` (`todos.ts:263`) both take it
  non-optionally. `StartRunInput` (`workflows/run.ts`) gains a required `author` too, because
  three of the eight paths (CLI, notes ×2) never touch the store directly.

The consequence is the point: **`npm run typecheck` fails until all eight creation sites name an
author, and it will fail again for the ninth.** No default, no fallback, no `?? 'unknown'` — per
`AGENTS.md` §Zero config, *never trade a working default for a knob*, and its sibling rule that a
replacement shipping OFF is not a replacement. A helper trio keeps the call sites one-liners:

```ts
authorFromRequest(c, via)              // routes 1,2,3 — principal + fetch metadata
authorFromAgentEnv(env, via)           // cezar todo add, inside a run
inheritAuthor(todo.author, via)        // autostart / ▶ Run, when no human is present
systemAuthor(via)                      // restart paths
```

### Giving the child process the session half

`agentEnv` (`workflows/run.ts:961-978`) gains nothing — it is per-run. `agentEnvForStep`
(`workflows/run.ts:1002-1025`), which is already the one place every agent step's env is
assembled, gains two vars:

- **`CEZ_STEP_ID`** — the workflow step id (`step.id`). Stable across backends, resumes and
  session re-mints; this is the authoritative "which agent session slot".
- **`CEZ_SESSION_ID`** — the backend session id as known at spawn time. Best-effort by
  construction: cezar mints it at `run.ts:4071` and **Codex/OpenCode overwrite it** with their own
  when the backend reports one (`run.ts:4110`, `:2862`), after the child env is already built. The
  spec records it anyway because for the Claude backend — the default and the overwhelming
  majority — it is exact, and `CEZ_STEP_ID` covers the case where it drifts.

Ordering is already correct: `sessionId` is minted at `run.ts:4071` and `agentEnvForStep` is
called at the spawn sites (`run.ts:4251`, `:4311`), after it. Both vars ride through
`buildChildEnv` with no allowlist edit — `agent-env.ts:375` passes the whole non-secret `CEZ_*`
namespace. Per `AGENTS.md`, **both must be added to `.env.example`** in the same commit (it
already documents the sibling trio at `:395`), and to `handoff.ts`'s agent-facing contract text
next to the existing `CEZ_TASK_ID` mentions (`handoff.ts:141`, `:162-163`).

### The todo is the carrier across the process boundary

`cezar todo add` writes `todos.json` directly (bypassing the auth wall, by design — see
`2026-08-19-file-tasks-from-a-running-task.md`), possibly into **another project's** data dir. The
cockpit that later autostarts it may therefore have no access to the parent run's store — a
workspace run's records live in the workspace repo, not in the target project. So:

1. `cezar todo add` stamps the **todo** with the full agent author it read from its own env.
2. When that todo becomes a run — autostart (`todo-autostart.ts:38`) or ▶ Run
   (`server.ts:5723`) — the run's author is decided by **who caused the run**, not who filed the
   todo:
   - **Autostart:** no human acted. The run **inherits** the todo's author verbatim, with
     `via: 'todo-autostart'`. The agent that filed it is the author of the run it caused.
   - **▶ Run:** a person clicked. The run's author is that person (`via: 'todo-start'`); the
     todo keeps its own agent author. The existing `todo.startedTaskId` link
     (`todos.ts:375`) already joins the two records, so both facts are recoverable and neither
     overwrites the other.

### Cockpit surface

- **Runs table** (`web/src/routes/global-tasks.tsx`, and the same table on
  `tasks-overview.tsx`): a new **Author** column — an avatar-less compact cell, matching the
  existing `Th`/`TD_BASE` grammar used by the Filed table's columns at `global-tasks.tsx:809-816`.
  Renders `You` / the userId for `user`, `API` for `api`, `⤷ <parent title>` as a link to
  `/p/:projectId/tasks/:parentTaskId` for `agent`, the automation name for `automation`, `—` for
  absent.
- **Filed table** (`global-tasks.tsx:809-816`): the same column, same renderer.
- **Task detail header:** one line — *"Started by <author> via <surface>"*, and for an agent
  author, *"from task <parent> · session <short id>"* with the parent linked.
- **Filter:** the Filed/runs filter row (`global-tasks.tsx:893`, `:906`) gains an Author facet
  built the same way as the existing Status/Priority ones.

## Architecture

| Layer | File | Change |
|---|---|---|
| Wire schema | `packages/contract/src/task-author.ts` (new) | `taskAuthorSchema`, `TaskAuthor`, the `via` enum, the `.refine` |
| Wire — runs | `packages/contract/src/runs.ts:219` | `author: taskAuthorSchema.optional()` on `runRecordSchema`, beside `automation` (`:257`) |
| Wire — todos | `packages/contract/src/skills.ts:68` | `author` on `todoItemSchema`; joins `createTodoInputSchema.omit()` (`:126-132`) |
| Persisted twin — runs | `packages/cezar/src/runs/store.ts:120` | same field on `runRecordSchema`; `author` **required** in `createRun`'s input (`:647`) and written in the record literal (`:666`) |
| Persisted twin — todos | `packages/cezar/src/todos.ts:36` | same field on `todoSchema`; `author` added to the `CreateTodoInput` omit (`:~118`); `createTodo` takes it as a required 3rd arg (`:263`) |
| Parity | `packages/cezar/src/server/contract-parity.runs.test.ts` | already type-level `Exact<>`; drift fails `npm run typecheck` with no edit |
| Manager | `packages/cezar/src/workflows/run.ts:1027` | `StartRunInput.author` required; passed through to `createRun` at `:1037`; `startVariants` (`:1112`) forwards it unchanged to each variant |
| Env | `packages/cezar/src/workflows/run.ts:1002-1025` | `CEZ_STEP_ID`, `CEZ_SESSION_ID` in `agentEnvForStep` |
| Helpers | `packages/cezar/src/runs/task-author.ts` (new) | `authorFromRequest`, `authorFromAgentEnv`, `inheritAuthor`, `systemAuthor` |
| Routes | `server.ts:4671`, `:5694`; `workspace-run-routes.ts:79` | `author: authorFromRequest(c, …)` |
| CLI | `index.ts:857`; `todo-cli.ts:178-190` | `authorFromAgentEnv(process.env, …)`, falling back to local-user |
| Autostart | `todo-autostart.ts:38` | `inheritAuthor(todo.author, 'todo-autostart')` |
| Notes | `notes/approve.ts:129`; `notes/continuation.ts:107` | user author from the approving principal; agent author with the parent run for the continuation |
| Automations | `automations/task-template.ts:57-76` | `author: { kind:'automation', id: automationId, via:'automation' }` at creation; the existing `automation` patch is untouched |
| Web | `web/src/routes/global-tasks.tsx`, `tasks-overview.tsx`, `web/src/lib/filed-tasks.ts` | Author column, detail line, filter facet |
| Docs | `.env.example`, `handoff.ts`, `BACKWARD_COMPATIBILITY.md` §2/§3, `README` env table, `CHANGELOG.md` | additive-field notes + the two new env vars |

**The one choke point.** Because `startRun` → `createRun` is the *only* way a `RunRecord` comes
into being (verified: one caller of `createRun`, at `run.ts:1037`), making `author` required there
is a complete guarantee for runs. `createTodo` (`todos.ts:263`) is the same for todos, with one
caveat named in §Risks: an agent appending raw JSON to `CEZ_TODOS_FILE` under `CEZ_FOLLOWUPS=1`
(`handoff.ts:160-165`) bypasses it.

## Phases

Each phase ships on its own, green, and leaves the product working.

**Phase 1 — the type and the run record.** New `task-author.ts` in both packages; `author` on both
`runRecordSchema` twins; required on `createRun` + `StartRunInput`; all eight creation sites
updated with the four helpers; `authorFromRequest`'s user/api discriminator. No UI, no env vars.
Ships as: every new run has an author; `kind: 'agent'` is impossible to construct incompletely.
*This is the phase that satisfies requirements 1 and 2.*

**Phase 2 — the agent session.** `CEZ_STEP_ID` + `CEZ_SESSION_ID` in `agentEnvForStep`;
`.env.example`, `handoff.ts` and README updated in the same commit; `authorFromAgentEnv` starts
returning a complete agent author; `cezar todo add` stamps the todo. Ships as: a task filed from
inside a run names its parent task and session. *Requirement 3.*

**Phase 3 — todo authorship and inheritance.** `author` on both `todoItemSchema` twins; the
`.omit()` on create; `POST /:projectId/todos` derives it from the principal; autostart inherits,
▶ Run attributes the clicker. Ships as: the Filed board and the runs board agree about who made
what.

**Phase 4 — the cockpit.** Author column on both tables, detail-header line, parent link, filter
facet. Web-only, so it deploys with an asset swap and no restart (`AGENTS.md` §Shipping cezar).

**Phase 5 (optional, not required by the ask) — per-step authorship.** `reopen-requests.ts:40`
already carries a `source` string that `reopen-watch.ts:45` drops. Recording *who resumed or
messaged* a run is a step-level question, distinct from who created the task, and is left out of
Phases 1-4 deliberately. Listed so the next reader knows it was considered, not missed.

## Data models

`packages/contract/src/task-author.ts` (twin in `packages/cezar/src/runs/task-author.ts`; the two
are duplicated deliberately, the same way `runRecordSchema` and `todoItemSchema` already are, and
kept honest by the existing type-level parity test):

```ts
/** The surface a task came through. Every value names a real, existing code path — there is no
 *  'other' and no 'unknown': a new door must add a value here, which is the review moment. */
export const taskAuthorViaSchema = z.enum([
  'composer',            // POST /api/v1/runs                      server.ts:4736
  'workspace-composer',  // POST /api/v1/workspace/runs            workspace-run-routes.ts:135
  'todo-start',          // POST /api/v1/todos/:id/start           server.ts:5723
  'todo-autostart',      // the running cockpit's watcher          todo-autostart.ts:38
  'cli-run',             // cezar run "<task>"                     index.ts:857
  'cli-todo-add',        // cezar todo add                         todo-cli.ts:190
  'todo-create-route',   // POST /api/v1/p/:projectId/todos
  'automation',          // GitHub automation                      task-template.ts:67
  'note-approval',       // notes/approve.ts:129
  'note-continuation',   // notes/continuation.ts:107
]);

export const taskAuthorSchema = z
  .object({
    kind: z.enum(['user', 'api', 'agent', 'automation', 'system']),
    /** principal.userId, or 'local' on an unauthenticated install (the `approverOf` rule,
     *  server.ts:1110); the parent run id for 'agent'; the automationId for 'automation'. */
    id: z.string().min(1).max(200),
    /** Display only. Never used for identity or counting. */
    label: z.string().min(1).max(200).optional(),
    via: taskAuthorViaSchema,
    /** ISO 8601. Equal to the record's own createdAt/ts at creation, kept explicit so the
     *  provenance object is self-contained when it is copied between records (autostart). */
    at: z.string(),
    /** The cezar task that caused this one. */
    parentTaskId: z.string().min(1).max(200).optional(),
    /** The agent session inside that task — CEZ_SESSION_ID, or the parent's last
     *  session-bearing step when resolvable in-process. */
    agentSessionId: z.string().min(1).max(200).optional(),
    /** The workflow step id — CEZ_STEP_ID. Authoritative where agentSessionId can drift. */
    parentStepId: z.string().min(1).max(200).optional(),
  })
  .refine((a) => a.kind !== 'agent' || (Boolean(a.parentTaskId) && Boolean(a.agentSessionId)), {
    message: "author.kind 'agent' requires both parentTaskId and agentSessionId",
    path: ['parentTaskId'],
  });
```

On `runRecordSchema` (`contract/src/runs.ts:219`, `cezar/src/runs/store.ts:120`) and
`todoItemSchema` (`contract/src/skills.ts:68`, `cezar/src/todos.ts:36`):

```ts
/** Who created this task, stamped at creation and never rewritten (spec
 *  2026-08-21-task-author-provenance). Optional on the schema because records written before
 *  2026-08-21 have none — REQUIRED by `createRun`/`createTodo`'s input types, which is what
 *  makes it present on everything written since. Never client-supplied. */
author: taskAuthorSchema.optional(),
```

**Bounds** follow `createRunInputSchema`'s scale (`contract/src/runs.ts:810`), the precedent
`todoItemSchema:93-95` already cites for the same reason. **Immutability:** `author` is written
once, in the record literal; `updateRun`/`updateTodo` must not accept it, so an author can never
be edited after the fact — the property that makes it worth reading.

## API contracts

- **`GET /api/v1/runs`, `GET /api/v1/runs/:id`, `GET /api/v1/workspace/*`, the SSE run payloads:**
  gain `author` in every `RunRecord`. Additive, optional — `BACKWARD_COMPATIBILITY.md` §2's
  general rule; older clients ignore it.
- **`POST /api/v1/runs`, `POST /api/v1/workspace/runs`, `POST /api/v1/todos/:id/start`:** request
  bodies **unchanged**. `createRunInputSchema` (`contract/src/runs.ts:854`) is `.strict()`; adding
  `author` to it would make it forgeable, so it is not added, and a body containing `author` is
  rejected by the strictness that already exists.
- **`GET /workspace/todos`, `POST /:projectId/todos`, `PATCH /:projectId/todos/:id`:** response
  todos gain `author`; `createTodoInputSchema` adds `author` to its `.omit()` list
  (`contract/src/skills.ts:126-132`) — server-stamped, exactly like `archivedAt`;
  `updateTodoInputSchema` (`:151`) is unchanged, so no route can rewrite an author.
- **New env contract (`.env.example`, required by `AGENTS.md`):** `CEZ_STEP_ID`,
  `CEZ_SESSION_ID` — set by cezar into each agent step's child env, read by `cezar todo add`.
  Not user-settable; documented alongside `CEZ_TASK_ID` at `.env.example:395`.
- **CLI:** no new flags. `cezar todo add` reads the env; `cezar todo add --json` output gains
  `author` inside the emitted todo.

## Risks

1. **Test churn from a required field (highest-cost, certain).** Making `author` required on
   `StartRunInput` and `createRun` breaks every test that constructs a run. Accepted deliberately:
   a default is what would let a real path ship unattributed, and `AGENTS.md` §"Changing a
   mechanism that already works" is explicit that a mechanism shipping OFF is not a mechanism. The
   mitigation is mechanical, not semantic — one exported fixture, `LOCAL_CLI_AUTHOR` (`kind:
   'user', id: 'local', via: 'cli-run'`), which is exactly what a headless `cezar run` sends, so
   the fixture is a true statement rather than a test-only escape hatch. **No `'test'` value is
   added to the `via` enum**, for that reason.
2. **`CEZ_SESSION_ID` drifts on Codex/OpenCode.** Those backends mint their own session id after
   the child env is built (`run.ts:4110`, `:2862`), so a task filed by a Codex step records
   cezar's pre-mint id. Named in the field's doc comment, and `parentStepId` (`CEZ_STEP_ID`) is
   the stable identifier that always resolves. Not fixed here — fixing it means re-exporting the
   env mid-step, which is a bigger change than the value it buys.
3. **The raw-append todo path bypasses `createTodo`.** Under `CEZ_FOLLOWUPS=1`, agents append JSON
   objects straight into `CEZ_TODOS_FILE` (`handoff.ts:160-165`); those entries will have no
   author, and `todoSchema` must keep validating them (it does — `author` is optional). Accepted:
   they read as "unknown", which is honest. The prompt text in `handoff.ts` gains
   `"author"` guidance so a compliant agent supplies it, but nothing enforces it.
4. **Author is not authentication.** On a zero-config local install every human is `'local'`,
   because there is no identity to record. `author` is an **audit and triage** field, not an
   authorization input; nothing may gate a decision on it. Stated in the schema doc comment so
   the next reader does not build a permission check on top of it.
5. **A wide `via` enum invites a lazy value.** Mitigated by refusing to include `'other'` or
   `'unknown'`: a new creation path must add an enum value, which is a visible line in a diff.
6. **UI regression on a wide table.** The runs table is already dense; a sixth column can push the
   title cell narrow on a laptop. Mitigated by making Author the narrowest fixed-width column
   (`w-[104px]`, matching the Status column at `global-tasks.tsx:809`) and by shipping it in its
   own web-only phase, which rolls back with an asset swap.
7. **Two twins, one guard.** `runRecordSchema` exists twice and `todoItemSchema` exists twice.
   `AGENTS.md` §"Two handlers, one guard, is the same bug at rest" is the standing warning. The
   runs pair is covered by the compile-time parity test; **the todos pair has no equivalent**, so
   Phase 3 adds one rather than trusting the edit.

## Verification

Concrete and executable. Gates: `npm run typecheck`, `npm run lint`, `npm test` (nothing is
committed red — `AGENTS.md` §Shipping cezar).

**Schema (Phase 1)**
1. `taskAuthorSchema.safeParse({kind:'agent', id:'r1', via:'cli-todo-add', at:'…'})` → **fails**,
   message names `parentTaskId`. With both `parentTaskId` and `agentSessionId` → succeeds.
   *This test is the owner's word "require", executable.*
2. `runRecordSchema.safeParse(<a real record captured from `.ai/cezar/runs/runs.json` before this
   change>)` → succeeds with `author` absent. Same for a legacy `todos.json` entry, including a
   bare `{summary}` agent append.
3. `createRunInputSchema.safeParse({task:'x', author:{…}})` → fails (`.strict()`), proving
   `author` is unforgeable over the wire.

**Creation paths (Phase 1) — one assertion per row of the §Problem table**
4. `POST /api/v1/runs` with a session principal → `author.kind === 'user'`,
   `author.id === principal.userId`, `via === 'composer'`.
5. The same route with no fetch metadata and a local principal → `kind === 'api'`.
6. The same route with `Sec-Fetch-Site: same-origin` and a local principal → `kind === 'user'`,
   `id === 'local'`.
7. `POST /api/v1/workspace/runs` → `via === 'workspace-composer'`.
8. `POST /api/v1/todos/:id/start` on an **agent-filed** todo → the run's author is the clicking
   user (`via: 'todo-start'`) **and** the todo's own author is unchanged. Both records asserted.
9. `startVariants(…, 3)` → all three variants carry the identical author.
10. `automations/task-template.ts` launch → `author.kind === 'automation'`, `author.id ===
    automationId`, and `run.automation` is still populated exactly as before (no regression).
11. `notes/continuation.ts` → `author.kind === 'agent'` with `parentTaskId` = the spec run's id.
12. **Grep guard:** a test that fails if any `createRun(`/`startRun(` call site in `src/` is
    missing an `author` key. (Typecheck already enforces this; the grep is the positive control
    that the check is looking at what it thinks it is — the lesson from
    `notion-178597643142`, *"a structural test that greps needs a positive control on what it
    found"*.)

**Env + CLI (Phase 2)**
13. `agentEnvForStep` returns `CEZ_STEP_ID` and `CEZ_SESSION_ID`, and `buildChildEnv` forwards
    both (they are non-secret `CEZ_*`, `agent-env.ts:375`) — asserted through `buildChildEnv`, not
    by inspection.
14. `cezar todo add "x"` with `CEZ_TASK_ID`/`CEZ_STEP_ID`/`CEZ_SESSION_ID` set → the written todo
    has `author.kind === 'agent'` with all three ids. With none set (a human in a terminal) →
    `kind === 'user'`, `id === 'local'`, `via === 'cli-todo-add'`.
15. `.env.example` contains both new vars — the existing env-contract test, or a new one if none
    covers it.

**Integration (Phase 3)**
16. `cezar todo add "x" --project cezar --start` from a fake agent env → the autostarted run's
    author equals the todo's author with `via: 'todo-autostart'` (inheritance, not re-derivation).
17. `GET /workspace/todos` returns `author` on the filed entry; `PATCH …/todos/:id` with an
    `author` in the body is rejected.

**Runtime e2e (Phase 4 — the acceptance test; until this passes the work is QA-needed, not done,
per `AGENTS.md` §Definition of done)**
18. On the running cockpit: start a task from the composer → its row shows **Author = you** and
    the detail header reads *"Started by … via composer"*.
19. From inside that running task, `cezar todo add "author probe" --start` → a second task
    appears whose Author cell links to the first, and whose detail header names the parent task
    and the session id. Click the link; it lands on the parent task.
20. An existing pre-change task still renders (Author `—`), proving the optional field did not
    break the board.
21. Filter the Tasks board by Author → only that author's tasks remain, counts consistent with
    the unfiltered board.

**Regression, added 2026-08-22 after the crash above**

22. `run-header.test.tsx` renders a run WITH an author and asserts the cell appears. `renderHeader`
    mounts no `TooltipProvider`, and that absence IS the assertion — the test is only meaningful
    while the harness stays bare, so it carries a comment saying not to add one.
23. `author-cell.test.tsx` renders bare, with no `TooltipProvider` in the harness at all. It used
    to supply one; that is why 6 green tests sat over a component that threw on the one of its
    three surfaces that nobody opened.
24. `components/ui/tooltip-provider.guard.test.ts` — a static scan failing any shipped module that
    imports `Tooltip` without `TooltipProvider`, which is the exact mistake made here. It carries a
    floor assertion (at least 5 consumers found, `author-cell.tsx` among them) so a renamed alias
    or moved directory cannot turn it green by finding nothing. It does not claim to prove each
    `<Tooltip>` is wrapped — only that no module inherits the provider by coincidence.
25. Negative controls, both executed rather than assumed: with the shipped `AuthorCell` restored, 7
    tests fail with the exact production string ``Tooltip` must be used within `TooltipProvider``,
    while the "no author at all" case still passes (that path renders no tooltip); and with only
    the `TooltipProvider` import dropped, the guard fails naming `components/author-cell.tsx`. With
    the fix, 88/88 pass.

## Analytics

`AGENTS.md` requires events named at design time. **There is no telemetry sink in this codebase**
(checked; this is why `todo-cli.ts:190` and `todo-autostart.ts:39` carry `TODO(analytics)`
markers). So: `author` itself *is* the analytics this feature ships — it is the dimension the two
existing markers were missing, and once it lands, `todo.filed(origin, project, hasSpec)` and
`todo.autostarted(project, queuedBehindLease)` can be emitted with an `author.kind` /
`author.via` dimension the moment a sink exists. No sink is invented here.

## Backward compatibility

Additive throughout, per `BACKWARD_COMPATIBILITY.md`'s general rule:

- **§3 `.ai/cezar/` state files** — `runs.json` and `todos.json` gain one optional key. Records
  without it stay valid and readable forever; no migration, no backfill, no dual write. **No
  backfill is attempted**: cezar has no evidence about who created a run last week, and inventing
  one would be worse than `—`.
- **§2 HTTP API** — responses widen; no request shape changes; no route added or removed.
- **§1 CLI** — no command, flag or exit code changes.
- **§8 marker vocabulary** — untouched. `author` is not agent-declarable; an agent cannot set its
  own authorship, which is the point.
- A newer cezar reading an older repo, and an older cezar reading a newer repo, both work.

## Out of scope

- **Backfilling existing records** (see above).
- **Per-step / per-message authorship** — who resumed, messaged or reopened a run. `reopen-requests.ts:40`'s
  `source` already exists for that and is dropped at `reopen-watch.ts:45`; wiring it is Phase 5,
  not this ask.
- **Authorization.** `author` never gates anything (§Risks 4).
- **Sub-agents *inside* an agent session.** Cezar has no visibility into agents the Claude CLI
  spawns internally — no event, no id — so a task filed by a sub-agent records its *session's*
  identity. Named so the limit is on the record rather than discovered later.
- **Changing `TodoItem.origin`.** It stays as it is; `author` supersedes it in usefulness but
  removing a shipped field is a breaking change with no benefit here.
