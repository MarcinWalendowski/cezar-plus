# Workspace-level navigation above Projects

> **Status:** Phase 1 **implemented**, QA Needed · Phases 2–3 not started · **Date:** 2026-08-14
> **Supersedes in part:** the `TODO(upstream-sync)` in `app-shell.tsx` (the multi-project
> top-level slot), whose closing claim — *"not a regression today: no item carries
> `workspace: true`"* — went stale the same day it was written.

## TLDR

The multi-project sidebar has **no top-level nav at all**. `AppShell` renders its nav item list
only on the single-project branch; the multi-project branch renders one hardcoded `AllTasksLink`
and then the project groups. Two shipped features are invisible because of it, on the owner's own
cockpit, today:

- **Notes** is unreachable. It carries `workspace: true`, which means "render once at the top
  level" — and there is nowhere at the top level to render it. `capabilities.notes` is `true` and
  the whole `packages/cezar/src/notes/` pipeline shipped in `11467f44`.
- **Knowledge** is unreachable. `ProjectGroups` calls `visibleNavItems({forge, inbox,
  automations})` and never passes `knowledge`, so the gate defaults to `false` and the item is
  filtered out of every project group. `capabilities.knowledge` is `true`.

Measured in the running cockpit (12 projects, `knowledge: true`, `notes: true`):

```
top level        New task · All tasks
cezar navigation Tasks · Git · Settings        ← no Knowledge
```

The browser was on `/p/loki-labs/knowledge/workspace-…` at the time: **the page being read could
not be reached from the sidebar that was next to it.**

This spec builds the structure the owner asked for — workspace-level Tasks / Git / Knowledge /
Settings above a `Projects` section whose groups carry the same four, scoped — and Phase 1 closes
the two holes above with the routes that already exist.

## Problem

### 1 — there is no top-level slot

`app-shell.tsx` branches on `projectGroups`:

```
projectGroups ? [ AllTasksLink , <project groups> ]
              : [ <nav>{items.map(…)}</nav> , <quick list> ]
```

`items` — the output of `visibleNavItems`, the single source both the sidebar and the ⌘K palette
render from — appears **only on the else branch**. So every gate in `nav-items.ts` is dead weight
in the mode most workspaces actually run in, and `workspace: true` describes a slot that does not
exist. The file's own TODO says as much and closes by asserting the gap is harmless because
nothing carries the flag; `Notes` has carried it since `11467f44`, which landed hours later.

### 2 — the per-project nav drops Knowledge

```ts
visibleNavItems({ forge: project.forge === 'github', inbox: inboxAvailable, automations: automationsAvailable })
```

`knowledge` is absent, so it defaults `false` and the Knowledge item never survives the filter.
This is the failure mode a defaults-to-absent gate is designed to produce when a caller forgets a
key — safe (it hides rather than lies) but silent. Nothing failed, nothing logged; the tab simply
was not there.

### 3 — the cross-project board is `AllTasksLink`, hardcoded

A link with its own bespoke styling, pinned above the groups, pointing at `/tasks`. It is the
right destination and the wrong mechanism: it cannot carry a badge, cannot be gated, does not
appear in the ⌘K palette's Views group, and is invisible to `activeNavPath`.

### 4 — two boards over one idea

`/tasks` (`GlobalTasksRoute`, upstream's `runs/run-index.ts`, facets + grouping + row mutations)
and `/workspace/tasks` (`WorkspaceTasksRoute`, our `workspace/run-index.ts`, read-only, gated on
`CEZ_WORKSPACE_VIEWS`). Both are live on this install. `.ai/runs/2026-08-13-upstream-merge-triage/
PLAN.md` §5 already recommends adopting upstream's as the single reader — that decision stands and
is **not re-litigated here**; this spec only stops promoting both.

### 5 — the precondition §5 attaches to that board

Recorded there, and re-verified against the current source rather than taken on trust:

| step | file | what it does |
|---|---|---|
| `archiveProjectRun` / `setProjectRunRead` | `web/src/api/client.ts:1131,1150` | `POST /api/v1/p/:projectId/runs/:id/{archive,read,unread}` |
| `.use('*', resolveProjectScope)` | `server.ts:6171` | method-agnostic, every `/p/:projectId` request |
| `resolveProjectScope` | `server.ts:1728` | `contexts.context(raw)` — the **building** accessor |
| `build()` | `project-context.ts:402,408,410` | `pruneOrphans` → `reclaimWorktrees` (**deletes worktree directories**) → `manager.recover()` |

So marking one finished row read on the cross-project board **resumes every interrupted run in
that row's project**, in middleware, before the handler runs. The trigger is the project, not the
row. This is live today (`AllTasksLink` already points there); promoting the board to the first
entry of a proper nav makes it the default path rather than a URL you had to know.

**It is not fixed in this spec** — it gets its own, because the fix is server-side and has nothing
to do with navigation. Named here because Phase 1 must not be read as having cleared it.

## Solution

### D1 — `workspaceTo`: one item, two homes

`NavItem` gains `workspaceTo?: string` — where this item points **when rendered at workspace
level**. An item appears in the top band iff it has a workspace destination:

| item | per project (`scopeTo(id, to)`) | workspace (`workspaceTo`) |
|---|---|---|
| Tasks | `/p/:id/` | `/tasks` |
| Git | `/p/:id/git` | *(Phase 2 — no route yet)* |
| Knowledge | `/p/:id/knowledge` | *(Phase 2 — no route yet)* |
| Notes | — (`workspace: true`) | `/notes` |
| Settings | `/p/:id/settings` | `/settings/global` |

The existing `workspace: true` keeps its exact meaning — top level **only**, filtered out of the
per-project loop — and now reads as "an item whose workspace destination is its only destination".
Notes is still the one item that carries it, and still must: a note is workspace-scoped precisely
because it has not been assigned to a repo yet.

Chosen over adding a second parallel `WORKSPACE_NAV_ITEMS` array because two lists over one
concept drift, and this fork has already been bitten by a nav concept enforced in two places. One
list, one gate function, two renderers.

### D2 — the top band renders through `visibleNavItems`, like everything else

`AllTasksLink` is replaced by a real nav rendering the same gated list the single-project branch
renders, filtered to items with a workspace destination. It keeps the band's visual treatment
(pinned above the scroller, its own bordered section) — that was a good decision for a different
reason and survives.

**Consequence worth stating:** the Tasks row can now carry the `tasks-unread` badge across the
whole workspace, and every workspace item reaches the ⌘K palette by construction rather than by a
second registration.

### D3 — a `Projects` section header

The groups get a label, because the top band and the group list are now two different kinds of
thing and the eye needs the seam. Matches the owner's own framing: *"Then next should be Projects
and then we should show all projects."*

### D4 — pass `knowledge`, and pin it

The one-line fix, plus a test that fails if any *future* gate is forgotten the same way: the
per-project nav is asserted to contain Knowledge when `capabilities.knowledge` is on. A test that
only asserted today's four labels would go stale silently the next time an item is added.

### D5 — active state is scope-aware, and the raw pathname is the whole mechanism

A workspace item is active only when the current path is **not** inside a project scope. Without
that, `/p/loki-labs/notes` would light both the workspace Notes row and the project's own — and
the whole point of the two levels is that they are distinguishable.

**Corrected during implementation.** This was first built as an explicit
`if (pathname.startsWith('/p/')) return null` guard at the top of `activeWorkspaceNavPath`. Then
the mutation test refused to kill it: with the **raw** pathname the guard can never fire, because
every workspace destination (`/tasks`, `/notes`, `/settings/global`) sits outside `/p/:id` by
construction, so a scoped path matches none of them and falls out as null on its own. The guard
was decoration reading as a safety net, and it has been deleted.

What actually carries the decision is one argument: `activeWorkspaceNavPath(pathname)` is fed the
raw location, while the per-project band is correctly fed `stripProjectPrefix(pathname)`. Hand the
workspace band the stripped value and `/p/shop/notes` becomes `/notes`, which lights the workspace
row from inside a project. That substitution is what the test pins — see Verification.

## Architecture

```
packages/web/src/components/nav-items.ts       workspaceTo, workspaceNavItems()
packages/web/src/components/app-shell.tsx      the top band replaces AllTasksLink
packages/web/src/components/project-groups.tsx knowledge gate + Projects header
```

No server, contract or route change in Phase 1. Every destination it links to already exists.

## Phases

1. **The two invisible items, with the routes that exist.** Top band (Tasks / Notes / Settings),
   `Projects` header, Knowledge restored per project. Shippable on its own — it is a strict
   increase in what is reachable.
2. **Workspace Git and workspace Knowledge.** Both need a page that does not exist: a cross-project
   git view, and a knowledge view that reads across every project rather than one project plus the
   `~/.cezar/knowledge/` workspace root it already mounts. New server surface; own spec.
3. **Board consolidation.** Retire `/workspace/tasks` or `/tasks` per merge-triage §5, after §5's
   own precondition (the non-instantiating mutation path) lands.

## Data Models

None. `workspaceTo` is a URL string on an existing type.

## API Contracts

None in Phase 1.

## Risks

- **A nav item that leads nowhere is worse than a missing one.** This is why Git and Knowledge do
  not get a workspace row in Phase 1: the rows would 404 or, worse, land on the boot project's page
  wearing a workspace label. Deferred deliberately, not overlooked.
- **`/settings/global` is already reachable** from the footer's icon link. The top band makes it a
  second door to the same room. Accepted: the footer icon is discoverable only by hover.
- **Phase 1 does not touch the mutation hazard** (Problem §5). The board it promotes is the one
  that carries it.

## Verification

Automated, in `app-shell.test.tsx` (84) and `project-groups.test.tsx` (16). Every mutation below
was **run**, and the test count held steady through each one, so a failure is a kill and not a
suite that stopped collecting:

| Mutation | Expected kill | Result |
|---|---|---|
| M1 — drop `knowledge` from the group's `visibleNavItems` call (**the exact original bug**) | the per-group Knowledge gate | **1 failed / 16** |
| M2 — stop filtering `workspace: true` items out of the group loop | Notes must appear in no group | **1 failed / 16** |
| M4 — give Settings `workspaceTo: '/settings'` | the band's plain-target test | **1 failed / 84** |
| M5 — give Knowledge a `workspaceTo` it has no route for | the no-dead-rows test | **1 failed / 84** |
| M3′ — feed the band `stripProjectPrefix(pathname)` instead of the raw path | D5's mechanism | **1 failed / 84** |
| restored | — | **84 + 16 passed** |

**M2 and M3 both survived on the first attempt, and both findings changed the code:**

- **M2** passed because `ProjectGroups` never received `notes` at all, so the capability gate — not
  the `workspace` filter — was keeping Notes out of the groups. The assertion was true for the
  wrong reason and would have stayed green with the filter deleted. Fixed by threading
  `notesAvailable` through, which makes the filter load-bearing and the test real.
- **M3** passed because the explicit `/p/` guard was unreachable (see D5). Deleted, and replaced by
  a test on the substitution that can actually go wrong.

Gates: `npm run typecheck` clean; `npm test` — **422 files, 7846 tests, all passing** (+6).

Runtime, on the running cockpit (12 projects, `capabilities.knowledge` and `.notes` both true) —
the same measurement that found the bug, re-run and read out of the DOM:

```
workspace band     Tasks → /tasks · Notes → /notes · Settings → /settings/global   (none current)
heading            PROJECTS
cezar navigation   Tasks · Git · Knowledge · Settings
```

Knowledge is back in the group, Notes is reachable for the first time, and no workspace row claims
to be current while the URL is inside `/p/loki-labs/…`.

Still **QA Needed** rather than Done: the owner's own pass has not run, and the mobile drawer
(which renders the same `SidebarContent`) was verified only by the automated tests, not by hand at
a phone width.
