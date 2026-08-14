# Cross-project git overview

> **Status:** specified, not implemented · **Date:** 2026-08-14
> **Implements:** Phase 2 (the Git half) of `.ai/specs/2026-08-14-workspace-level-navigation.md`,
> which shipped the workspace nav band with **no** Git row precisely because the page did not
> exist and a nav row that leads nowhere is worse than a missing one.
> **Follows:** `.ai/specs/2026-08-14-cross-project-run-mutations.md` — same non-instantiating
> discipline, same reason.

## TLDR

`GET /api/v1/workspace/git` — one row per registered project: branch, ahead/behind, dirty count,
last commit. Backed by a new `workspace/git-index.ts` that shells `git` against each project's
**bare root path** and never builds a `ProjectContext`.

The question it answers is the one the owner actually has: *with several worktrees running agents
in parallel, which repos have uncommitted work and which branch is each on?* Today that costs one
sidebar click per project, and each click builds that project's context.

## Problem

### 1 — there is no cross-project git view, and the per-project one is not free

Every git surface is project-scoped by construction. `repoRoutes` (`server.ts:5807-5898`) is
chained into `v1` behind `.use('*', resolveProjectScope)` (`server.ts:6178`), and for any non-boot
project that middleware calls `contexts.context(raw)` (`server.ts:1729`) — the **building**
accessor, whose `build()` runs `pruneOrphans` → `reclaimWorktrees` → `manager.recover()`.

For `/p/:projectId/*` that is **correct and stays**: a caller under that prefix is standing in the
project, and opening it is a deliberate act. This spec does not touch it. But it does mean the
"check every repo" workflow costs N context builds today, which is the second reason the aggregate
belongs at workspace level rather than being N scoped fetches from the browser.

Note what the handlers actually use once that build completes: `c.get('project').root`
(`server.ts:5810,5836,5852,5879,5891`) — a filesystem path. The whole context is built to obtain a
string the registry already has.

### 2 — the helpers are already bare-path, so nothing needs inventing

`server/git.ts` and `server/git-changes.ts` take a `root: string` and shell out. No
`ProjectContext`, no `RunStore`, no `KnowledgeStore`. `getRepoInfo(dir)`, `getStatus(root)`,
`getBranches(root)`, `getLog(root, n)`, `collectChanges(dir, base, opts)` are all directly usable
from a workspace index. This feature is wiring, not invention.

### 3 — but the naive wiring does not scale, and the arithmetic says so

`getRepoInfo` alone is 2–4 `execFile` spawns (`git.ts:32,33,36,42,44`). Adding `getStatus` (1) and
`getLog` (1) is **4–6 processes per project**. On the owner's cockpit — 12 registered projects —
one page load is 48–72 `git` subprocesses, fanned out at once if written the obvious way.

That is the whole reason D2 below exists. A cross-project page that spawns 70 processes on every
focus is not a page, it is a load generator.

## Solution

### D1 — `GET /api/v1/workspace/git`, workspace-level and single-mount

New `server/workspace-git-routes.ts`, mounted into `workspaceV1` beside the runs families. **Never
mirrored under `/api/v1/p/`** — `BACKWARD_COMPATIBILITY.md` §2 is explicit that workspace routes
answer for the whole workspace, so a scoped spelling would be a second surface with no consumer.

Gated on `capabilities.workspaceViews` (`CEZ_WORKSPACE_VIEWS === '1' && !singleProject`), the same
gate as `GET /api/v1/workspace/runs`, because it is the same kind of thing: our own opt-in
aggregate. Off → **200 with a schema-valid empty payload**, never 404 (D19).

This differs from the run-**mutations** family, which is deliberately ungated — that one serves an
always-on upstream board, and gating it would half-disable a page. Nothing is half-disabled here:
gate off, the nav row is absent and the route answers an honest empty aggregate.

### D2 — two git calls per project, not six

A new `getRepoSummary(root)` in `server/git.ts` — the one place in this repo that shells `git`, so
the aggregate cannot drift from the detail views:

```
git status --porcelain=v1 --branch    → branch, upstream, ahead/behind, every dirty entry
git log -1 --pretty=%h%x1f%s%x1f%an%x1f%cr  → last commit
```

Two spawns, not six. `--branch` on `status` is what collapses `getRepoInfo`'s
`rev-parse`+`rev-parse`+`remote` into the call that was already being made, and it carries
ahead/behind, which no current helper reports at all.

`remote` is **not** in the summary: it costs a third spawn and the overview does not show it. Forge
identity already rides `ProjectListEntry.forge`, classified from the registry without a probe.

### D3 — bounded concurrency and a per-project deadline, both reported

- **Concurrency cap of 4** projects in flight. 12 projects × 2 calls = 24 spawns, in 3 waves of 8.
- **Per-project deadline** (default 5s, whole summary). A repo on a stalled network mount, or a
  `git` blocked on an index lock held by an agent run, must not hang the page.

A project that trips the deadline answers `{ ok: false, reason: 'timed out' }` — a **row**, not a
silent omission. Same for a missing root, a `not-git` root, or any `git` failure. This is
`run-index.ts`'s rule and it is the one that matters: *never silently fewer rows.* A dead project
that vanishes reads as "all clear" when it is the opposite.

### D4 — never builds a context, pinned structurally

`workspace/git-index.ts` takes `listProjects` as an **injected dep** (the `WorkspaceRunIndex` and
`AutomationCoordinator` shape) and imports neither `server/project-context.ts` nor
`workflows/run.ts`. A structural test pins that, **with a floor**: it must import `server/git.ts`,
so the two negative assertions cannot pass on an empty file.

Unlike the run mutations, there is **no peek**: this path only reads, and reading a repo's git
state through a bare path is identical whether or not a context happens to exist. Peeking would
buy nothing and would hand this module a reference to the thing it is supposed to be unable to
reach.

### D5 — no caching in v1, and the reason is that caching here would lie

`WorkspaceRunIndex` caches on `runs.json`'s `mtimeMs`+`size`, which is sound because that file is
the whole input. A working tree has no such key: `git status` changes when any file under the root
changes, and the interesting case — an agent writing files right now — is exactly the case a
staleness heuristic gets wrong. So: no cache, bounded cost instead (D3), and the client controls
refresh cadence.

## Architecture

```
packages/cezar/src/server/git.ts                      + getRepoSummary(root)
packages/cezar/src/workspace/git-index.ts             new  — injected listProjects, no context
packages/cezar/src/server/workspace-git-routes.ts     new  — GET /workspace/git, gated
packages/cezar/src/server/server.ts                   mount into workspaceV1
packages/contract/src/workspace-git.ts                new  — closed wire schema
packages/web/src/api/client.ts                        getWorkspaceGit()
packages/web/src/api/queries.ts                       workspaceQueryKeys.git + useWorkspaceGit()
packages/web/src/routes/workspace/workspace-git.tsx   new  — the page
packages/web/src/routes.tsx                           <Route path="/workspace/git">
packages/web/src/components/nav-items.ts              workspaceTo on the Git item
BACKWARD_COMPATIBILITY.md §2                          inventory (a test enforces this)
```

## Data Models

```ts
interface WorkspaceGitProject {
  id: string
  name: string
  ok: boolean
  reason?: string            // set iff ok === false; 'timed out' | 'root not found' | 'not a git repo' | git's own stderr
  branch?: string            // absent on a detached HEAD or an unborn branch
  detached?: boolean
  upstream?: string
  ahead?: number             // absent when there is no upstream — 0 would be a claim we cannot make
  behind?: number
  dirty?: { staged: number; unstaged: number; untracked: number }
  head?: { hash: string; subject: string; author: string; when: string }
}

interface WorkspaceGitResponse {
  projects: WorkspaceGitProject[]   // registry order; a failed project is a row, never a gap
  bootProject: string
}
```

`ahead`/`behind` are **optional, not defaulted to 0**. "No upstream" and "level with upstream" are
different facts and the UI must be able to say which.

## API Contracts

`GET /api/v1/workspace/git` → `WorkspaceGitResponse`. No parameters in v1.
Flag off → `200 { projects: [], bootProject }`.

## Phases

1. `getRepoSummary` + `git-index.ts` + the route + contract. Server-side, testable alone.
2. The page, the nav row (`workspaceTo: '/workspace/git'`), the client/query wiring.

## Risks

- **`git status` on a large repo is not instant.** Bounded by D3's deadline; the row says
  `timed out` rather than the page hanging. Accepted for v1.
- **An agent run holding `.git/index.lock`.** `git status` does not take that lock, so it reads
  through. If it fails anyway, that is a `{ ok: false }` row with git's own stderr — honest, and
  arguably the single most useful row on the page.
- **Registry order is not usefulness order.** v1 ships registry order rather than inventing a
  ranking. Sorting dirty-first is a later decision, not a silent default.

## Verification

Automated, each guard named with the mutation that must turn it red:

| Guard | Mutation that must kill it |
|---|---|
| `git-index.ts` imports neither `server/project-context.ts` nor `workflows/run.ts`, **and does** import `server/git.ts` (the floor) | add either import / empty the file |
| A project whose root is gone yields an `ok: false` row, and the response still contains every other project | make the failure path drop the row |
| A project that exceeds the deadline yields `ok: false, reason: 'timed out'` | remove the deadline (a hung fake must hang the test) |
| At most 4 summaries in flight at once — asserted by a fake that records concurrent entries and reports its own high-water mark | raise or delete the cap |
| No upstream → `ahead`/`behind` **absent**, not `0` | default them to 0 |
| Flag off → 200 with `projects: []` | answer 404, or answer real data |
| `getRepoSummary` reports staged / unstaged / untracked separately against a fixture repo with one of each | collapse them into one count |

The concurrency guard needs a real high-water mark, not a call count: a test that only counts calls
passes with the cap deleted, which is the mutation it exists to catch.

Gates in order, and **`npm test -- <path>`, never `npx vitest`** (PLAN D21):
`npm run typecheck`, `npm test`, `npm run build`.

### Runtime E2E — the gate on Done

With `CEZ_WORKSPACE_VIEWS=1` and the owner's 12 projects registered: open `/workspace/git`,
confirm every project appears, deliberately `mv` one project's root aside and confirm its row
turns into an honest failure rather than disappearing, and confirm from `ps`/timing that the load
does not spawn a git process per project all at once. Until that has run this is **QA Needed**.
