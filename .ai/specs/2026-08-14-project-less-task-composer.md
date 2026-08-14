# Project-less task composer

> **Status:** implemented, **QA Needed** — no runtime E2E has run · **Date:** 2026-08-14,
> status corrected 2026-08-15 (it read "specified, not implemented" after the code had landed)
> **Completes:** `.ai/specs/2026-08-14-note-to-spec-pipeline.md` (shipped `11467f44`) — that spec
> built the whole engine and left the way in as a capture inbox. This is the way in the owner
> asked for.
> **Depends on:** nothing new server-side. Every route this needs already exists.

## TLDR

A composer at `/workspace/new` with **no project selected**. Type one thing, press the button, and
cezar decides which repos it implies — the triage pass that has been shipped and unreachable since
`11467f44` unless you go looking in the Notes inbox.

The owner's list of controls to drop turns out not to be a preference. **Every control on the
list is project-derived, and there is no project.** That is the spec's whole shape.

## Problem

The owner's words:

> "I want to be able to create a tasks above all projects without specifying any project: agent
> should pull the knowledge base data and then decide for which projects we should add task/tasks.
> by default it should be 'auto detect', we don't need any 'skill' selected, we can hide template,
> add some explainer to 'autonomous', hide 'base: main' select - it should be always from main"

### 1 — there is no project-less composer, and the existing one cannot become it

`/new` is not a route: it is a redirect onto `/p/<bootProject>/new` (`routes.tsx:190-198`), and the
real composer mounts inside `ProjectScopeRoute` (`routes.tsx:443-445`). Its project comes from
`useParams()` (`new-task.tsx:128`) and is always a registered project.

The project pill (`new-task.tsx:912-1001`) is not a "which project is this for" chooser — it is a
scope switcher. Picking a project **navigates** (`new-task.tsx:606`), deliberately, because the
alternative is "a second, parallel notion of 'the active project' living in this component"
(`new-task.tsx:902-910`). There is no option that is not a concrete registered project.

So "add Auto detect to the pill" is not available: there is no id to navigate to, and every
project-dependent query in the component (`/repo`, skills, workflows, config, uiState) would have
nothing to resolve against. Worse, an unscoped mount hits the documented scope trap —
`queryScope()` returns `'default'` and project-local calls **silently hit the boot project**: wrong
data, no error, no symptom (`2026-08-06-workspace-notes-cross-project.md`, "The scope trap").

### 2 — the engine exists and nothing points at it

`NoteProcessor.process()` (`notes/processor.ts:83-161`) reads the whole registry, proposes
`{ projectId, title, task }` per project, refuses to guess an unknown project
(`processor.ts:278`), and checks candidates against the live cross-project board. Exposed as
`POST /api/v1/workspace/notes/:noteId/process`. Approval starts a spec run in the target repo.

It is reachable only from `/notes`, behind `CEZ_NOTES=1`, presented as an inbox. The owner asked
for a composer.

### 3 — the controls to hide are the project-derived ones, exactly

This is the finding that decides the design rather than a coincidence:

| Control | Where its options come from | Meaning with no project |
|---|---|---|
| Skill / workflow pill | that project's skills + workflows (`new-task.tsx:182`) | none — the list is empty |
| Prompt templates | that project's `uiState.promptTemplates` (`new-task.tsx:192-195`) | none — the menu renders nothing at zero templates anyway (`prompt-template-menu.tsx:55`) |
| Base branch | that repo's `repo.branches`, and it is **repo config**, not a run field | none — there is no repo |
| Autonomous | a policy, not a project lookup (`new-task-draft.ts:57-74`) | **still meaningful** |

Which is why the owner's list drops three and keeps the fourth with an explainer. The composer is
not being simplified for taste; it is being given the only controls that survive having no project.

**`base: main` deserves its own note, because "hide it, always main" is not what it sounds like.**
The pill does not ride the run payload — `CreateRunInput` has no `baseBranch` field
(`contract/src/runs.ts:611-646`). Picking a value calls `PUT /api/v1/config`
(`new-task.tsx:1184-1195`): it is repo-level configuration that happens to be rendered in the
composer. So hiding it in a project-less form removes a control that could not work anyway, and
each spec run still forks from whatever its own project's config says — which is `main` unless
that project was configured otherwise. See D5.

## Solution

### D1 — a new route at `/workspace/new`, not a mode on the existing composer

Mounted outside `ProjectScopeRoute`, beside `/workspace/tasks` and `/workspace/git`.

`/new`'s legacy redirect to the boot project **stays exactly as it is**. cezar is a released
package; repointing an existing path is a breaking change, and this adds a surface rather than
reshaping one.

A separate component rather than a `workspace` prop through `new-task.tsx`'s 1293 lines: the two
share almost no controls (the table above), and threading a project-less mode through a file whose
every query is project-scoped is how the scope trap gets sprung. What they do share — the textarea,
the submit affordance — is already component-level.

### D2 — the project control defaults to **Auto detect**, and it is a real choice

A pill reading `Auto detect` by default, whose menu also lists every registered project.

- **Auto detect** (default) → `POST /workspace/notes` then `POST /workspace/notes/:id/process`,
  then land on the review view for that note. This is the shipped path, unchanged.
- **A named project** → navigate to `/p/<id>/new?ref=…` prefilled, the detour
  `2026-08-14-note-to-spec-pipeline.md:210-213` already decided and the Inbox already uses
  (`new-task-params.ts:42-49`).

The named-project branch exists so the pill is not a lie. A control whose only option is its
default should not be a control.

### D3 — autonomous: explainer yes, toggle NO

> **CORRECTED 2026-08-14, during implementation, before anything shipped.** As first written this
> section specified a working toggle and gave it copy reading *"cezar writes a spec in each
> detected project, then keeps going and implements it."* **That copy is false and the toggle
> would have been dead.** Verified in source, not inferred:
>
> - `autonomous` appears **nowhere** in `packages/contract/src/notes.ts` or
>   `packages/cezar/src/notes/` — neither `createNoteInputSchema` nor `approveNoteInputSchema`
>   carries such a field.
> - `NOTE_TO_SPEC_WORKFLOW` (`workflows/types.ts:227`) is a single step whose own description ends
>   **"Does not implement."**
> - `notes/approve.ts` starts exactly that workflow unconditionally, with no branch on anything.
>
> So toggling it on or off would have produced **byte-identical requests**. Shipping that means two
> failures at once: a control that does nothing, and a product claim about a capability that does
> not exist. The rule is that an absolute claim on a page has to be true.
>
> **What ships instead:** the explainer, describing what actually happens, and no toggle. The
> owner's ask — "add some explainer to 'autonomous'" — is satisfied by explaining; a switch that
> changes nothing is not.
>
> The owner does want autonomous continuation (*"if autonomous, it continues with implementation
> as far as I understand"*). That is **engine work** — an implement step plus a field threaded
> through approve — and it gets its own spec. The toggle returns when there is something behind
> it. The original text is kept below, unchanged, so the reasoning that produced it is legible.

### Superseded — the original D3, kept for the record

Today the only explanation is a `title` attribute (`new-task.tsx:818-824`) — invisible on touch,
invisible to a screen reader that does not announce it, invisible to anyone not hovering. At
workspace level the stakes are higher than in the per-project composer, because the toggle governs
runs in **repos the user did not name**.

Visible help text under the toggle, both states, no hover required:

- **on** — "cezar writes a spec in each detected project, then keeps going and implements it. Runs
  start in repos you did not name."
- **off** — "cezar writes a spec in each detected project and stops. You review, then start the
  implementation yourself."

Wording is a product claim and must stay true to `processor.ts`/`NoteApprover`; if the pipeline's
behaviour changes, this text changes with it.

### D4 — the review gate is not optional, and autonomous does not remove it

Approval remains a click on a proposal a person has read (`notes.tsx:28-31`). Autonomous governs
what happens **after** approval — spec-then-stop versus spec-then-implement — never whether the
approval happened. A composer that could start runs in three unnamed repos from one submit is not
a feature this spec ships.

### D5 — "always from main" is recorded as an assumption, not implemented as a write

The literal reading — force `baseBranch: 'main'` — would mean this form issuing `PUT /config`
against every detected project, silently rewriting repo-level configuration the owner set
elsewhere, for repos whose default branch may not be `main` at all.

So: the project-less composer **does not render the pill and does not write config**. Each spec run
forks from its own project's configured base, which is the checked-out branch unless configured
otherwise. If the owner wants a hard workspace-wide "always main", that is a config decision with
its own blast radius and belongs in Settings, not hidden inside a composer submit.

**Flagged, not silently dropped** — this is the one item on the owner's list not implemented
literally, and the reason is that the literal version writes to state the composer does not own.

### D6 — the per-project composer is left alone

"Hide template" and "hide base: main" are implemented **for this form**. `/p/:id/new` keeps its
pills: there, the options exist, the base-branch picker is the documented way to set repo config
from the composer, and eight tests pin the current behaviour.

If the owner wants the per-project composer trimmed too, that is a render-condition change of a few
lines plus those tests — cheap, reversible, and a separate decision. It is not assumed here.

## Architecture

```
packages/web/src/routes/workspace/workspace-new-task.tsx   new — the composer
packages/web/src/routes/workspace/workspace-new-task.test.tsx  new
packages/web/src/routes.tsx                                <Route path="/workspace/new">
packages/web/src/routes/workspace/workspace-tasks.tsx      a "New task" action pointing at it
packages/web/src/components/nav-items.ts                   (unchanged — this is an action, not a nav row)
```

Server: **nothing.** Every route already exists and is already in the BC inventory.

## Data Models

None new. A submit in Auto-detect mode is a `CreateNoteInput` followed by the existing process
call; a submit with a named project is a navigation.

## API Contracts

Unchanged. `POST /api/v1/workspace/notes`, `POST /api/v1/workspace/notes/:noteId/process`,
`POST /api/v1/workspace/notes/:noteId/approve` — all as shipped.

`CEZ_NOTES=1` gates the engine. Flag off, this page renders the same honest "off" state `/notes`
and `/inbox` use, naming the flag and the restart (D19's pattern) — never a 404, and never a
composer that accepts text it cannot process.

## Phases

1. The route, the composer, Auto-detect submit, the autonomous explainer, the off state.
2. The named-project branch of the pill (the prefilled-composer detour).
3. The entry point on `/workspace/tasks`.

## Risks

- **Two composers can drift.** Accepted and bounded: they share no controls, and the shared
  affordance is already a component. The alternative — one component in two modes — is the scope
  trap.
- **`CEZ_NOTES` is off by default** (D4: every flag is off unless exactly `'1'`), so this page is
  invisible on a default install. Correct per the standing rule, and the off state says so.
- **Auto-detect can be wrong.** It already can be; the review gate is the answer and D4 keeps it.

## Verification

| Guard | Mutation that must turn it red |
|---|---|
| Default state shows `Auto detect`, and renders **no** skill pill, no template menu, no base-branch pill | render any of the three |
| Auto-detect submit calls `POST /workspace/notes` then `/process`, in that order, with the typed text | drop the `/process` call (a note that is never processed is the current inbox, not this feature) |
| Submit **never** calls any project-scoped path — a request-assertion test in the mould of `new-task-project.test.tsx:352` | issue any `/api/v1/p/…` or unscoped project call (this is the scope-trap guard, and it must fail on the *silent* boot-project hit, not just on a throw) |
| Picking a named project navigates to `/p/<id>/new` and posts nothing | make it submit in place |
| The autonomous explainer is visible text, asserted by `getByText` | move it back to a `title` attribute (a `title`-only assertion must not pass) |
| **No toggle renders** — corrected D3; a control that changes nothing must not ship | render a toggle |
| The page issues no `autonomous` field on any request, because nothing consumes one | add one (it would be silently ignored, which is the point) |
| `CEZ_NOTES` off → the off state names the flag; the textarea does not accept a submit | render the composer anyway, or 404 |

The scope-trap guard is the one that matters most and the easiest to write vacuously: it must
assert on the *set of URLs requested*, because the failure mode is a successful request to the
wrong project, not an error.

**CORRECTED 2026-08-14, found by mutation testing during implementation.** The obvious spelling of
this guard — a blocklist on `/api/v1/p/…` — is **vacuous**, and measurably so: adding `useRepo()`
to a workspace page killed **0** tests.

**Settled on captured evidence, after one wrong amendment.** A middle version of this note claimed
the typed client emits `/api/v1/p/default/repo`, so a `/p/` blocklist would catch it. That was
wrong — it read `client.ts:618-622` and stopped one function short.

Logging the actual requests a workspace page makes gives `/api/v1/repo`: no `/p/` segment. The
reason is `withApiBase` → `unscoped()` (`client.ts:278-303`), which every typed-client request
passes through and which strips a whole `/p/default` segment whenever `getApiScope() === null`,
precisely so an unscoped request is byte-identical whichever half of the client sent it.

So both halves collapse to the bare URL on a page outside `ProjectScopeRoute`, and the server's
no-prefix convention serves the **boot project**. A `/p/`-shaped blocklist sees none of it.

(The `2/13`-either-way measurement on this page is still correct and is not evidence against the
above: that blocklist had been broadened to name `/api/v1/repo` explicitly, so it caught the bare
URL. It caught the endpoint someone remembered to list — which is the whole limitation.)

**The guard must therefore be an allowlist**: assert the set of requested paths is a subset of the
two or three this page is permitted to touch, plus a floor asserting the expected calls did happen
(an empty request log must not pass). A blocklist can only ever protect against the endpoints its
author thought of; an allowlist fails closed when someone adds a new one next month.

This applies to **every** page mounted outside `ProjectScopeRoute` — see the same correction in
`.ai/specs/2026-08-14-cross-project-git-overview.md`.

Gates in order, **`npm test -- <path>`, never `npx vitest`** (PLAN D21): `npm run typecheck`,
`npm test`, `npm run build`.

### Runtime E2E — the gate on Done

With `CEZ_NOTES=1` and several projects registered: open `/workspace/new`, type a note that
plainly implies two different repos, submit on Auto detect, and confirm the review view names both
projects with a spec proposal each. Approve one and confirm a spec run starts **in that repo**.
Until that has run this is **QA Needed**.
