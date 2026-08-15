# The composer stops forcing a project and a workflow

> **Status:** partially reverted 2026-08-15 — D1 and D2 (the project half: routing "New task" at
> the project-less `/workspace/new` composer) were reverted on owner review the same day, in place;
> see the marked sections below. D3 and D4 stand as shipped. **D5 shipped and was then corrected
> the same day**: "None" as the *cold* default was not enough — the owner, looking at the running
> composer, said "no workflow should be selected by default", so the cross-session `lastTask`
> stickiness D5 argued for is gone entirely. See D5's own correction. **Date:** 2026-08-15 · **Owner decisions:** "by default task
> project/directories should be 'auto detect' or 'ALL' — right now I can select only one", and
> "why do we force users to select workflow? we shouldn't force them — by default task shouldn't
> have any workflow". Asked how far to go on the first: **make the existing auto-detect composer
> the default**, not build multi-project fan-out into `POST /runs`. **Superseded same day**: the
> owner reviewed the shipped project half and rejected the two-composer shape — "composer should be
> one: exactly the same: just allow to select 'all/auto' and do it by default. We don't need
> notes." — which is what D1/D2 below record as reverted.

## TLDR

Two forced choices in the new-task composer, one fix each.

1. **Project.** A project-less composer that defaults to **Auto detect** already exists at
   `/workspace/new` — it was built by `.ai/specs/2026-08-14-project-less-task-composer.md` and it
   works. It is hidden behind `CEZ_NOTES=1`, which nothing turns on, and it is not what "New task"
   points at. Flip the flag's default and repoint the entry points. **No contract change, no
   `POST /runs` change, no fan-out.**
2. **Workflow.** The composer cannot express "no workflow": `resolveSource` always returns one, the
   source pill has no clear item, and the contract's XOR refinement rejects a body naming neither
   `workflow` nor `steps`. Relax the XOR to *at most one*, let the server fall back to
   `QUICK_TASK_WORKFLOW` the way `POST /todos/:id/start` already does, and give the pill a **None**
   item that is the cold default.

## Problem

### 1 — picking a project is a navigation, so "one project" is structural

`packages/web/src/routes/new-task.tsx:899-911` says it outright: *"Picking a project NAVIGATES to
that project's composer rather than swapping local state"*. The id rides the URL
(`/p/:projectId/new`), `createRun` sends it as a path param via `queryScope()`
(`web/src/api/client.ts:1133-1138`), and `POST /runs` reads it from middleware
(`server.ts:4464`). There is no `projectId` in `createRunInputSchema` and no `projectIds` anywhere.
One project per request is not a default that can be changed — it is the shape of the route.

### 2 — …but the fix for that was already built, and is switched off

`/workspace/new` (`web/src/routes/workspace/workspace-new-task.tsx`) is a composer with no project
in its URL and a `TargetPill` (`:227-266`) whose default label is literally **"Auto detect"**
(`:235`, `:247`). Submitting it posts a note and processes it; the note pass reads a catalog of
every project (`notes/coordinator.ts:124`, capped at 25) and returns per-project proposals behind a
human approval gate, which then start one run per approved proposal, in that proposal's project
(`notes/approve.ts:128-129`). That is "auto detect **and** ALL", already shipped.

It is gated by `capabilities.notes = env.CEZ_NOTES === '1' && !singleProject`
(`server/capabilities.ts:218`). With the flag unset the page renders *"Set CEZ_NOTES=1 and restart
cezar to turn it on."* (`workspace-new-task.tsx:90`). Meanwhile every "New task" affordance —
`app-shell.tsx:573`, `command-palette.tsx:205,403-404`, `tasks-overview.tsx:314,362` — points at
`/new`, which `project-router.tsx` rewrites to the **active project's** composer.

So the owner's complaint is exactly right, and the cheapest honest fix is not to build anything:
it is to stop hiding what exists.

### 3 — the workflow pill has no "none", at three independent layers

- **Web.** `resolveSource` (`new-task-form.ts:221-235`) cannot return "none" — its last line is
  `return { source: 'workflow', ref: workflows[0]?.name ?? 'quick-task' }`. `TaskSource` is a
  non-nullable union (`new-task-form.ts:24`). `SourcePill` (`new-task.tsx:1008`) lists skills and
  workflows and nothing else.
- **Contract.** `createRunInputSchema` (`contract/src/runs.ts:685-688`) is
  `Boolean(b.workflow) !== Boolean(b.steps)` — an XOR, so **neither** is a 400, not just both.
- **Server.** The same refinement at `server.ts:884-887`, and the handler branches
  `steps ? … : find(workflow) ?? 404` (`server.ts:4469-4483`). A body with neither never reaches it.

The irony worth naming: the thing the user wants **already exists as a workflow**.
`QUICK_TASK_WORKFLOW` (`workflows/types.ts:197-208`) is described in the source as *"The
zero-config workflow: one agent step that just does the task"*. "No workflow" and "quick-task" are
the same behaviour. What is missing is a way to *say* it without picking from a list, and a cold
default that means it.

## Solution

### D1 — REVERTED 2026-08-15 on owner review — `CEZ_NOTES` becomes an inverted gate, following the `skills` precedent

**Reverted 2026-08-15, same day it shipped, on owner review.** The owner rejected the two-composer
shape this decision was half of: "composer should be one: exactly the same: just allow to select
'all/auto' and do it by default. We don't need notes." `capabilities.ts` gates `notes` back to
`env.CEZ_NOTES === '1' && !singleProject` — its original opt-in polarity, before this spec touched
it — and the neighbouring comment that called `skills` "the one INVERTED gate in this object" is
true again. What replaces this: a single composer whose project pill gains an **All/Auto** option
and defaults to it, specced separately. Original text, unchanged below:

```ts
notes: env.CEZ_NOTES !== '0' && !singleProject,
```

`capabilities.ts:221-224` already documents exactly this asymmetry for `skills` (*"the one INVERTED
gate in this object"* — that comment must be amended, since it stops being the only one). The
`&& !singleProject` clause **stays**: a single-project cockpit has nothing to auto-detect across,
and the module docblock's reasoning is unchanged.

`CEZ_NOTES=0` remains the way to turn it off, so anyone relying on the surface being absent has a
one-variable answer.

### D2 — REVERTED 2026-08-15 on owner review — "New task" means the project-less composer when the capability is on

**Reverted 2026-08-15, same day it shipped, alongside D1.** "New task" points at `/new`
unconditionally again in `app-shell.tsx`, `command-palette.tsx`, `app-shell-container.tsx` and
`tasks-overview.tsx` — the `notesAvailable` prop threading added for this is removed. `/workspace/new`
itself stays mounted and reachable; only the default entry points changed back. What replaces this:
a single composer whose project pill gains an **All/Auto** option, specced separately — see D1's
marker. Original text, unchanged below:

`app-shell.tsx`, `command-palette.tsx` and `tasks-overview.tsx` point "New task" at
`/workspace/new` when `capabilities.notes` is true, and at `/new` otherwise. `/p/:projectId/new`
keeps working, keeps its URL, and stays reachable — from a project's own page, from the target
pill's named-project option (`workspace-new-task.tsx:118-119` already documents that picking a
named project bypasses the note pass), from the notes page's implementation prefill
(`notes/notes.tsx:310`), and from the bookmarklet (`lib/bookmarklet.ts:50`). **Nothing is
removed**; one default is repointed.

### D3 — "at most one", not "exactly one"

`contract/src/runs.ts:685-688` and `server.ts:884-887` both relax to:

```ts
.refine((b) => !(b.workflow && b.steps), { message: 'provide "workflow" or "steps", not both' })
```

Both spellings change **in the same commit**. Two copies of one rule that disagree is the drift this
repo already has a name for; the message changes too, because "either/or" stops being true.

### D4 — the server falls back to quick-task, reusing the existing precedent

`server.ts:4469-4483` gains the branch `POST /todos/:id/start` already uses at `server.ts:5452-5454`:

```ts
const { workflows } = await loadWorkflows(repoRoot);
workflow = workflows.find((w) => w.name === 'quick-task') ?? QUICK_TASK_WORKFLOW;
```

A project that defines its own `quick-task` wins, exactly as it does for todos. The built-in is the
floor, so the fallback cannot 404.

### D5 — the pill gains **None**, and None is the cold default

`TaskSource` becomes nullable at the composer level (`TaskSource | null`), `resolveSource` returns
`null` when no candidate exists rather than reaching for `workflows[0]`, `SourcePill` renders a
**None** item first, and `buildCreateRunBody` omits **both** `workflow` and `steps` when the source
is null.

**CORRECTED 2026-08-15 — cross-session stickiness is gone; this paragraph was the bug.** It read:

> **Stickiness survives.** `uiState.lastTask` is an explicit past choice, so a user who picked a
> workflow last time still gets it. Only the *cold* default changes — which is what "by default
> task shouldn't have any workflow" asks for. A user who picks **None** persists None, so the
> escape is one click and it sticks.

The owner looked at the shipped composer and said, plainly: **"no workflow should be selected by
default."** The reasoning above is what made that false in practice — a *cold* default only ever
applies to a machine that has never run anything, and every other machine (the owner's included)
kept getting a preselected workflow. "An explicit past choice" was also generous: the pre-None
composer preselected `quick-task` and persisted it, so the stored value often recorded the old
default rather than any decision.

What shipped instead:

- **`uiState.lastTask` is removed** — from `uiStateSchema`, from `resolveSource`'s candidate list,
  and from the submit's ui-state write. Nothing reads it and nothing writes it, so it is deleted
  rather than left as a field that reads like a live preference.
- **Picker ORDERING is untouched.** `recentSources` (recency) and `skillUsage` (frequency) still
  record every run and still order the menu. Ordering the list by what you use and choosing from
  it for you are different things; only the second was the complaint.
- **A pick still sticks inside the composer's own draft**, per project. That is a choice the user
  made and can see on screen, not a default.
- **Drafts written before this carry a `v` marker check** (`DRAFT_VERSION`, `new-task-draft.ts`):
  an unversioned draft drops **only** its `source`, keeping its text and every run setting. Without
  it, the machines the change exists to fix would have kept showing a preselected workflow forever,
  and a blanket key bump would have thrown away half-typed task text to fix a pill.

### D6 — what this spec does NOT do

- No `projectIds` on `createRunInputSchema`, no loop in `POST /runs`, no partial-failure shape.
  Multi-project fan-out through a single create-run request was the option the owner declined.
- No change to the note pass, its prompt, its cap, or its approval gate.
- No removal of `/p/:projectId/new` or of the per-project composer.

## Architecture

```
"New task"  ──(capabilities.notes)──▶  /workspace/new     TargetPill: "Auto detect"  [D1, D2]
                                          │
                                          └─ POST /workspace/notes → …/process
                                             → note pass reads the project catalog
                                             → per-project proposals → approve → N runs
                    └──(off, or singleProject)──▶  /new → /p/:active/new   (unchanged)

SourcePill: [None] · skills… · workflows…                                   [D5]
   None ⇒ body omits workflow AND steps
        ⇒ contract allows it            (at most one)                       [D3]
        ⇒ server resolves quick-task    (project's own, else built-in)      [D4]
```

## Data Models

No stored shape changes. `uiState.lastTask` must tolerate a **null** source — it is persisted
client state, and a stored value from before this change still resolves through `sourceExists`, so
no migration is needed. `capabilities.notes` keeps its type; only its default flips.

## API Contracts

| Route | Change |
|---|---|
| `POST /api/v1/p/:projectId/runs` | body may now name **neither** `workflow` nor `steps`; that case resolves to `quick-task`. Naming both is still a 400. Naming one is unchanged. |
| `GET /api/v1/health` | `capabilities.notes` is now `true` unless `CEZ_NOTES=0` or `singleProject`. Shape unchanged. |

Additive and permissive in both directions — no client that works today stops working. Per
`BACKWARD_COMPATIBILITY.md` §2 the route inventory needs no new row; the `POST /runs` entry's
description does.

## Phases

1. **D3 + D4** — contract and server accept and resolve "neither". Shippable alone: the API stops
   rejecting a body no client sends yet.
2. **D5** — composer's None item and null-source default.
3. **D1 + D2** — capability default and the repointed entry points.

Phase 1 before 2 is load-bearing: a composer that can send "neither" against a server that rejects
it is a 400 in the user's face.

## Risks

- **Turning `notes` on by default turns on more than a composer.** The same capability gates the
  `/notes` page and its nav item (`routes.tsx:411,679`), the eleven `/workspace/notes*` routes, and
  the nav entries in `nav-items.ts:43,136` / `project-groups.tsx:94`. That is a visible surface
  change beyond the one the owner asked about, and the CHANGELOG has to say so rather than
  describing it as "the composer now auto-detects".
- **The note pass costs a model call before anything runs.** Auto-detect submit is
  `POST /workspace/notes` then `…/process`, and the pass is an LLM call over a project catalog. The
  per-project composer starts a run immediately. Making the slower path the default is the right
  trade for correctness but it is a trade, and the composer should not look frozen while it happens.
- **`quick-task` as the fallback is a name lookup, and names can collide.** A project that defines a
  *different* workflow called `quick-task` silently becomes the meaning of "None". That is the same
  exposure `POST /todos/:id/start` already accepts, and consistency beats a second rule here — but
  it is a real behaviour, not an implementation detail.
- **A null source has three independent representations** (composer state, persisted `lastTask`,
  request body). One concept enforced at several points drifts; the verification below pins all
  three rather than just the request.

## Verification

Every guard names the mutation that must turn it red.

| Guard | Mutation that must turn it red |
|---|---|
| A body with neither `workflow` nor `steps` validates, in **both** the contract and the server schema | restore the XOR in either one — a test that only exercises one spelling must fail too |
| A body naming **both** is still a 400 | relax to `.optional()` with no refinement |
| Neither-key `POST /runs` starts a run on the project's `quick-task`, and on `QUICK_TASK_WORKFLOW` when the project defines none | resolve to `workflows[0]`, or 404 |
| `resolveSource` returns `null` when no candidate exists | restore `workflows[0]?.name ?? 'quick-task'` |
| A sticky `lastTask` still wins over the None default | make None unconditional |
| `buildCreateRunBody` with a null source omits both keys | send `workflow: 'quick-task'` instead — the wire shape is the contract, and "it behaves the same" is not the same claim |
| `capabilities.notes` is true with `CEZ_NOTES` unset, false with `CEZ_NOTES=0`, false under `singleProject` regardless | drop the `!== '0'`, or drop `&& !singleProject` — the third case needs its own assertion or the flip silently enables a cross-project surface in a single-project cockpit |
| "New task" resolves to `/workspace/new` with the capability on, `/new` with it off | hardcode either target |

The `singleProject` row is the one most likely to be skipped and most likely to matter: it is the
only guard that fails *because* of this change rather than despite it.

Gates, in order, `npm test -- <path>` never `npx vitest`: `npm run typecheck`, `npm test`,
`npm run test:unit`, `npm run build`, `npm run test:package`. `npm test` is judged by its **exit
code**, not its pass count.

### Runtime E2E — the gate on Done

Against the running cockpit:

1. With no `CEZ_NOTES` set, click **New task** from the shell and land on the project-less composer
   with the target reading **Auto detect**.
2. Submit a task naming no project and no workflow. Confirm the note pass proposes per-project work,
   approve one, and confirm a real run starts **in that proposal's project**.
3. From a project's own composer, confirm the source pill shows **None** selected by default, start
   a run, and confirm from the run record that it executed `quick-task`.
4. Pick a workflow, start a run, reload, and confirm the pill still shows that workflow — stickiness
   is not a casualty of the new default.
5. Restart with `CEZ_SINGLE_PROJECT=1` and confirm **New task** goes back to the per-project
   composer and the workspace surface is absent.
