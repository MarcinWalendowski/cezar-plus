# Cross-project run mutations without building a context

> **Status:** **implemented**, QA Needed (the runtime E2E has NOT run — see Verification) ·
> **Date:** 2026-08-14
> **Precondition for:** `.ai/specs/2026-08-14-workspace-level-navigation.md` Phase 3 (board
> consolidation), and named as a precondition in `.ai/runs/2026-08-13-upstream-merge-triage/PLAN.md`
> §5.

## TLDR

Marking one finished row read on the cross-project board **resumes every interrupted run in that
row's project**, deletes worktree directories, and does it in middleware before the handler runs.
The trigger is the project, not the row.

This adds a mutation family that never builds a project context:
`POST /api/v1/workspace/runs/:projectId/:runId/{archive,read,unread}`.

## Problem

Re-verified against current source rather than inherited from the plan that recorded it:

| step | file | what it does |
|---|---|---|
| `archiveProjectRun` / `setProjectRunRead` | `web/src/api/client.ts:1131,1150` | `POST /api/v1/p/:projectId/runs/:id/{archive,read,unread}` |
| `.use('*', resolveProjectScope)` | `server.ts:6171` | method-agnostic — every `/p/:projectId` request |
| `resolveProjectScope` | `server.ts:1728` | `contexts.context(raw)` — the **building** accessor |
| `build()` | `project-context.ts:402,408,410` | `pruneOrphans` → `reclaimWorktrees` (**deletes worktree directories**) → `manager.recover()` |

`manager.recover()` resumes interrupted runs into `spawn('bash', ['-lc', command])`. So a read
receipt on project B's row spends tokens, deletes directories and starts processes in B — none of
which the user asked for, and none of which is visible at the call site.

The board is one click from the sidebar, and the workspace nav band (`c1f6b1a2`) keeps it there.

**Why the obvious fix is wrong.** The middleware cannot simply switch to `peek`: every genuinely
project-scoped route under `/p/:projectId` needs a built context, and most of them are the reason
`build()` exists. The fix is to stop routing a *workspace-level* action through a *project-scoped*
path.

## Solution

### D1 — a workspace route family, so the scope middleware is never met

`POST /api/v1/workspace/runs/:projectId/:runId/{archive,read,unread}` in a new
`server/workspace-run-mutations-routes.ts`, mounted beside the existing read family. `/workspace/*`
has no `:projectId` param of its own, so `resolveProjectScope` sets the already-seeded boot context
and returns — no build, for any project named in the path.

The project id in the path is now **data the handler resolves**, not a routing scope. That is the
whole change.

### D2 — peek first, open second, and never build

```
contexts.peek(projectId)  →  use that context's store   (already built; no build, no recover)
otherwise                 →  RunStore.open(dataDir, { keepLive: true }), mutate, flush()
```

The peek is **correctness, not an optimization**. `RunStore.open` returns a new instance on every
call with no singleton, and `saveNow` rewrites the whole file from the instance's own map — so a
second store opened over a live one would silently drop everything the live one had learned since
it opened.

`contexts` is injected as a dep rather than imported, so this file never imports
`server/project-context.ts` and the structural guard can say so.

### D3 — `keepLive: true` on the standalone open, or the receipt rewrites history

Without it, `RunStore.open` runs `reconcileLoadedRun`, which turns every `running` / `queued` /
`waiting` row into `failed` with `error: 'interrupted — cezar process exited during the run'` — and
this path then `flush()`es, **persisting that**. A read receipt would mark a live run in another
process dead.

`keepLive: true` is exactly what `project-context.ts:381` passes for the same reason. The
difference from that call site is that nothing here recovers the live rows afterwards, which is
correct: this family only ever edits one row's `archived` / `seenAt` and must leave every other
field exactly as it found it.

### D4 — a missing root is a 409, never a directory tree

`RunStore.open` starts with `mkdirSync(join(dataDir, 'runs'), { recursive: true })`. On a project
whose folder is gone, that would **recreate the tree** — a mutation route quietly resurrecting a
deleted repo's skeleton. The handler checks the registry entry's root exists first and answers
`409 { error: 'project folder not found: <id>' }`, matching what `resolveProjectScope` already
answers for the same condition.

### D5 — not gated on `CEZ_WORKSPACE_VIEWS`

The read family is gated because it is our own opt-in aggregate. This family is **not**, because
the board it serves (`/tasks`, upstream's `GlobalTasksRoute`) is not gated either: gating the
mutations would leave an always-on board with row actions that 409 on an install that never set
the flag. A capability must not be able to half-disable a page.

## Architecture

```
packages/cezar/src/server/workspace-run-mutations-routes.ts   new
packages/cezar/src/server/server.ts                            mount + inject `contexts`
packages/web/src/api/client.ts                                 archiveProjectRun / setProjectRunRead repoint
BACKWARD_COMPATIBILITY.md §2                                   inventory (a test enforces this)
```

`/api/v1/p/:projectId/runs/:id/{archive,read,unread}` is **untouched** — it is the correct route
for a caller already standing in that project (`archiveRun`), where the context is built anyway.
Nothing is removed, so there is no compatibility burden: cezar is a released package and this adds
a surface rather than reshaping one.

## Data Models

None. The stored `RunRecord` is unchanged; only which code path reaches it changes.

## API Contracts

`POST /api/v1/workspace/runs/:projectId/:runId/archive` — body `{ archived: boolean }`
`POST /api/v1/workspace/runs/:projectId/:runId/read`
`POST /api/v1/workspace/runs/:projectId/:runId/unread`

All three answer the **bare `RunRecord`**, matching the per-project twins so the client's `unwrap`
and cache updates are unchanged. (This section first said `{ run: RunRecord }`; the twins return
the record directly, and the compiler said so.) `404` for an unknown project or run; `409` for a
registered project whose folder is gone.

## Phases

Single change.

## Risks

- **Two writers to one `runs.json` across processes.** Unchanged by this spec — it is the existing
  situation for any second cezar process — and the peek closes the in-process case, which is the
  one the cockpit can actually cause.
- **A standalone store emits no SSE.** The per-project twin's `touch` broadcasts on that context's
  event bus; a store opened here has no subscribers. The cockpit already updates the board from the
  mutation's own response, so the row is correct immediately; another tab watching that project's
  stream sees the change on its next poll rather than instantly. Named rather than papered over.

## Verification

Automated: `workspace-run-mutations-routes.test.ts`, **8 tests**. Every mutation below was run,
with the count held at 8:

| Mutation | Expected kill | Result |
|---|---|---|
| N1 — drop `keepLive: true` from the standalone open | the live-bystander row must stay `running` | **1 failed / 8** |
| N2 — open the store before checking the root exists | 409 must not recreate the tree | **1 failed / 8** |
| N3 — skip the peek and always open a fresh store | the live context's own store must be the one written | **1 failed / 8** |
| restored | — | **8 passed** |

Plus a structural guard that the module imports neither `server/project-context.ts` nor
`workflows/run.ts` — with a **floor** (`runs/store.ts` *must* be imported), so it cannot pass on an
empty file. `contexts` is an injected dep precisely so that guard can hold whatever a later edit
does to the handler bodies.

**One assertion was deleted for being unfalsifiable.** A `toMatch(/keepLive:\s*true/)` source scan
sat beside the behavioural test — and this module's docblock *explains* `keepLive` in prose, so the
regex matched the comment and stayed green with the real option removed. N1 is killed by the
behavioural test alone, which is the one that means anything.

`bc-route-inventory.test.ts` covers the §2 entry (11 passing). Repointing the client also turned
`global-tasks.test.tsx` red on three pinned URLs — the fixtures now pin the workspace spelling,
because here **the path is the fix**.

Gates: `npm run typecheck` clean; `npm test` — **423 files, 7854 tests, all passing**.

### Runtime E2E — NOT run

The cockpit on this machine is serving **pre-change code**: `POST /api/v1/workspace/runs/x/y/read`
answers Hono's plain-text `404 Not Found` (no route matched), while the old
`/api/v1/p/x/runs/y/read` still answers a JSON `{"error":"unknown project: x"}` and
`GET /api/v1/workspace/runs` answers 200 — so the probe is sound and the process simply predates
the mount.

Running it needs a server restart, which is **not** a neutral act here: `serveCommand` builds the
boot context on startup with `keepLive` + `recover()`, so restarting cezar to test a
"don't resume runs" fix can itself resume runs. It is the owner's call, not something to do in
passing.

When it runs: with a second project's context **not** built, archive one of its rows from `/tasks`
and confirm (a) the row archives, (b) no run in that project starts, (c) no worktree directory
disappears. Until then this is **QA Needed**.
