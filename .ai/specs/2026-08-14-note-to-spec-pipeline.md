# Note to spec pipeline

> **Status:** implemented · **runtime E2E EXECUTED 2026-08-15** — the core loop works end to end
> (capture → split → route → approve → a real spec run that does not implement). **Still QA Needed:**
> two defects found at runtime (the Notes list never refreshes off `processing`; routing mis-targets
> when a note names a project by anything other than its registered id), and the **dedupe** leg was
> never exercised. See "Runtime E2E — EXECUTED 2026-08-15" at the end of this file. ·
> **Date:** 2026-08-14, status corrected 2026-08-15 — this header read "the runtime E2E has NOT been
> run", which went false the moment it was run, and a header is what a scanning reader keeps
> **Supersedes in part:** `2026-08-14-remove-notes-capture-inbox.md` (same day). That spec deleted
> the notes scaffold; this one builds the feature it was a scaffold for. See "Relationship to the
> removal" below — the removal was correct and is not being undone by accident.
> **Implements:** the unbuilt half of `2026-08-06-workspace-notes-cross-project.md` (F3 feature B),
> under `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md`, whose decision table outranks this file.

## TLDR

One free-form note goes in. cezar splits it into distinct pieces of work, routes each to a
registered project, checks each against what is already on the board across every project, and
then — for each piece you approve — runs a real agent **in that project's own repo** which reads
the knowledge base, the specs and the git history and writes a **full spec with phases**. From
there it is an ordinary cezar run.

This reproduces the `notion-sync` Loop's division of labour rather than approximating it: the
parent keeps the dedupe and the split, a per-item agent does the investigation, and nothing is
implemented until you say so.

## Problem

Two gaps, and they are the same gap seen from both ends.

1. **There is no way in.** Every task in cezar starts as a run you compose against one project you
   have already chosen. A thought that spans three repos, or that you cannot yet place, has
   nowhere to land. `notion-sync` solved this outside cezar with a capture inbox; cezar has none.
2. **A task is only as good as the context behind it.** Starting a run from a one-line prompt
   throws away everything the workspace already knows — 400+ specs, a knowledge base, the git
   history of the thing being changed. The Loop's whole value is that a memo becomes a task whose
   body says *which existing decision this extends*, and cezar reproduces none of that.

The prior design (`2026-08-06-workspace-notes-cross-project.md`) closed gap 1 and left gap 2 open:
its pass emitted a run prompt directly from one cheap model call, with no per-project
investigation. That is the piece this spec adds.

## Relationship to the removal, and why this is not a silent re-add

`2026-08-14-remove-notes-capture-inbox.md` deleted the notes family this morning, by owner
decision, and its own text records that doing so contradicted the programme's mission item
("notes processed into tasks across multiple projects").

**The removal was correct and this spec does not dispute it.** What was deleted answered a
constant empty payload from every route regardless of the flag, rendered "Notes is not built yet",
and had never written a byte to `~/.cezar/notes.json`. A scaffold that promises a feature is worse
than no feature, which is exactly what that spec argued.

What changes is that the feature is now being **built**, by owner decision 2026-08-14, in the same
session and after that removal shipped. So the contract and route shapes come back — recovered
from `ce05b940`, where they are 234 lines of already-reviewed design — and this time with the
`notes/{store,coordinator,processor,prompt}.ts` modules that never existed behind them.

Both `2026-08-14-remove-notes-capture-inbox.md` and the PLAN's notes rows are marked in place, in
their headings, because a reader scanning headings must not carry away "notes were removed" as the
current state.

## Solution

### D1 — The capture is a note at workspace scope, never in a project

`~/.cezar/notes.json`, per PLAN D14. A note's value is precisely that it has **not** been assigned
to a repo yet, and a note that fans out to three projects would otherwise have its results
pointing into three `runs.json` files while living in only one of them.

### D2 — The parent keeps the split and the dedupe. This is not delegable

One pass, one model call, made through `planner.ts`'s existing machinery (`createRunner`,
`parseStructured`, one retry, then a non-blocking fallback). Its prompt carries three things:

- the note body, once;
- a **project catalog** — id, name, root basename, skills (`name, description`), workflow names —
  gathered by `NoteCoordinator` on the `AutomationCoordinator` pattern;
- the **board digest** — `WorkspaceRunIndex.digest()`, every project's live non-archived run
  titles with status and age.

The digest is what makes dedupe a prompt shape rather than a per-item loop, and it is the rule the
Loop states most sharply: *"dispatch without this and you get one new row per item **by
construction**"*. `digest()` already exists and shipped — its docblock says it is "for the note
pass (P2.2)" — so this spec is its first caller.

The same pass **splits**: one memo describing three features emits three proposals, never one blob
row. That is also a Loop rule, and it is what makes each proposal's spec writable at all.

### D3 — The investigation happens inside the target repo, as a real run

Each approved proposal starts a cezar run in **its own project** using a new built-in workflow,
`note-to-spec`. That agent has the repo checked out and full tool access, so "gather context" is
it reading `.ai/specs/`, the knowledge base and `git log` **for that repo** — not cezar
assembling a digest and hoping the retrieval found the right things.

Its prompt instructs it to write a spec carrying the sections this repo requires (TLDR, Problem,
Solution, Architecture, Phases, Data Models, API Contracts, Risks, Verification) and **to stop
there**. It does not implement. That is the Loop's step 4 / step 5 boundary, and it is why the
"stages" in the ask are real: the spec's Phases section is written by an agent that has read the
code it is phasing.

**This choice is what keeps the cross-project read safe, as a side effect worth naming.** Because
the deep work happens inside a project-scoped run, the triage pass needs only the registry, some
file reads and a `runs.json` parse. It never builds a `ProjectContext`, so it never reaches
`manager.recover()` — which re-queues queued runs, settles waiting ones and calls `continueRun` on
running ones. A pass that touched contexts would silently resume interrupted agent runs in every
registered project at the moment you pressed Process.

### D4 — Approving creates a run, not a backlog row

PLAN D13 says a task is not a run and a durable backlog row is a `ticket` — which lives in F5,
which is blocked on two preconditions. **This spec does not open F5.** A note's output is a real
run, which is what "continue with the cezar flow" means literally, and `note.resultingTasks[]` is
the durable record of what the note produced.

### D5 — Off by default, inert when off

`CEZ_NOTES=1` exactly (PLAN D4). Off: every GET answers 200 with a schema-valid empty payload,
every mutator answers 409, and nothing in the family ever answers 404 (PLAN D19) — the feature is
switched off, not missing.

### D6 — Generic, upstreamable, no new dependency

F3 feature B is explicitly upstreamable (PLAN D2), so no workspace-specific string enters `src/`
— mechanically enforced by the brand scan in `notifications/transports/webhook.test.ts`. The model
call is an agent CLI through `createRunner`; the runtime dependency budget is untouched (PLAN D7).

## Architecture

```
POST /workspace/notes ──► ~/.cezar/notes.json        NoteStore, O_EXCL lease + in-process lock
        │
POST …/:id/process ──► 202, background
        │
        ├─ NoteCoordinator.catalog()      registry + skills + workflows, NO ProjectContext
        ├─ WorkspaceRunIndex.digest()     live board, every project, read-only parse
        └─ createRunner(defaultRunner)    ONE call, parseStructured, 1 retry, then fallback
                 │
                 ▼   note.pass.proposals[]  { projectId, title, task, duplicateOf?, issues[] }
        [review screen: reject, retarget, edit]
                 │
POST …/:id/approve ──► per proposal, first-wins claim under the store lock, THEN startRun
                 │
                 ▼   run in THAT project, workflow `note-to-spec`
                     agent reads knowledge + .ai/specs + git log, writes the spec, stops
                 │
                 ▼   note.resultingTasks[] { proposalId, projectId, runId, kind: 'spec', specPath? }
        [Start implementation]
                 │
                 ▼   POST /p/<project>/runs — the ordinary cezar flow from here
```

**Reused, not rebuilt:** `planner.ts` (`createRunner`, `parseStructured`, `sanitizeSteps`'s
discipline), `workspace/run-index.ts` (`digest()`), `automations/coordinator.ts` (the
no-context enumeration pattern), `todos.ts`'s `markStarted` (the first-wins claim),
`workflows/types.ts` (`QUICK_TASK_WORKFLOW` is the shape `NOTE_TO_SPEC_WORKFLOW` follows).

## Data models

The contract is recovered verbatim from `ce05b940` (`packages/contract/src/notes.ts`, 234 lines):
`noteRecordSchema`, `notePassSchema`, `noteProposalSchema`, `noteSummarySchema`, the five response
shapes and the five request bodies. It was designed against this exact flow and needs **one**
addition:

```ts
// resultingTasks[] entry — was { proposalId, projectId, runId, createdAt }
kind: z.enum(['spec', 'implementation']).default('spec'),
/** Repo-relative path the spec run reported writing. Absent until it finishes. */
specPath: z.string().max(500).optional(),
```

Storage (`packages/cezar/src/notes/types.ts`) is `.passthrough()` like `automations`; the contract
shapes are closed.

## API contracts

Six routes under `workspaceV1`, single-mount, never mirrored under `/p/:projectId`:

| Route | Answers | Flag off (D19) |
|---|---|---|
| `GET /api/v1/workspace/notes` | `{notes, truncated}` | `{notes: [], truncated: false}` |
| `POST /api/v1/workspace/notes` | 201 `{note}` | 409 |
| `GET /api/v1/workspace/notes/:noteId` | `{note}` | `{note: null}`, 200 |
| `PATCH /api/v1/workspace/notes/:noteId` | `{note}` | 409 |
| `DELETE /api/v1/workspace/notes/:noteId` | `{removed: true}` | 409 |
| `POST /api/v1/workspace/notes/:noteId/process` | **202** `{note}` | 409 |
| `POST /api/v1/workspace/notes/:noteId/approve` | 200 `{note, created[], rejected[]}` | 409 |

`process` answers 202 and creates nothing, ever: the pass is a model call that can take a minute
and must not hold a request open. `approve` is all-or-nothing per proposal and partial across
them, reported in one 200 body — a 4xx would make a partial success unreadable.

`GET /api/v1/health` grows `capabilities.notes` back. `BACKWARD_COMPATIBILITY.md` §2 gains all
seven rows.

## Phases

1. **Capture.** `notes/{types,store}.ts`, the contract, the routes, the page, the flag, the nav
   item. A note can be written, listed, edited, archived, deleted. Nothing analyses anything.
2. **Triage pass.** `notes/{coordinator,processor,prompt}.ts`. Proposals with split and dedupe.
   The phase that must not build a project context.
3. **Spec pass.** `NOTE_TO_SPEC_WORKFLOW`, and approve starting one run per proposal in its target
   project, first-wins claimed before `startRun`.
4. **Review and dispatch UI.** The note page: proposals with per-row project picker and edit, the
   spec run's status and path, and Start implementation.

Phases 1–2 are the shippable unit — after them a note already tells you what work it implies and
where.

**All four are built (2026-08-14).** Two things about phase 4 differ from the sketch above and
are decisions rather than shortfalls:

- **"Start implementation" is a link to the target project's prefilled composer**
  (`/p/<id>/new?ref=…`), not a button that starts a run. It follows the review-before-launch
  detour `newTaskPrefillHref` already documents for the Inbox: a note typed on a phone produced
  the spec, and a person decides whether it gets built, in the repository it will change.
- **`specPath` is still never written.** The contract carries the field and the UI renders it when
  present, but nothing extracts it from a finished run — that needs a run-completion observer
  parsing agent output, which is its own mechanism and its own failure modes. Until it exists the
  implementation prefill names the spec RUN (`/p/<id>/tasks/<runId>`), which the agent can open,
  rather than a path nobody wrote. The field being absent is honest; a guessed path would not be.
  Follow-up, not shipped.

The per-row **project picker** in phase 4 is likewise not built as a picker: `approve` accepts a
per-row `projectId` override and is tested for it, but the UI only offers select/deselect today.
Retargeting is an API capability with no control on the page yet.

## Risks

| Risk | Mitigation |
|---|---|
| Opening a note board resumes agent runs across every project | The triage path imports neither `server/project-context.ts` nor `workflows/run.ts`, asserted structurally by reading the module source (the pattern `run-index.test.ts`'s C2 already uses), plus a behavioural check that `contexts.ids()` is unchanged across a pass |
| One click becomes N runs in N repos | The first-wins claim is taken **before** `startRun`, so the worst case is a claimed proposal with no run (visible, retryable) rather than two runs in two repos (invisible, expensive) |
| A re-process in another tab approves against a stale pass | `approve` carries `passId` and 409s when it is not the note's current pass |
| The pass invents a project | An unknown `projectId` keeps the proposal, flags `unknown-project` and defaults it to **rejected** — never retargeted at the boot project, which would run work in the wrong repo silently |
| A runner error loses the note | It never blocks: a failure degrades to `fallback: true` with the error persisted on the pass and the note marked `failed`. **Corrected during implementation:** the fallback proposes the whole note only when the note NAMED a project (`projectHint`), and proposes nothing otherwise. `planChain` can degrade to a one-step plan because it already knows which repo it is planning for; here the target is precisely what the pass failed to work out, so picking one would be inventing the one answer that matters. Zero proposals **with a visible error** is honest; zero with no error would be the silent failure |
| A 40-project workspace explodes the prompt | Caps: 25 projects by `lastOpenedAt`, 12 board titles each, 12 proposals — and `consideredProjects`/`boardDigestSize` are persisted and shown, so truncation is visible rather than silent. **Corrected during implementation:** the catalog carries no skills at all. Twenty-five projects' skill lists with descriptions is this exact risk, paid on every pass, to fill an OPTIONAL proposal field — while the spec run that follows approval reads that repo's skills first-hand, which is both cheaper and better informed |
| The spec run implements instead of specifying | The workflow has one agent step whose prompt forbids it, and a test asserts the built-in has no implement step |

## Verification

Automated. Each guard names the mutation that must turn it red — a guard whose mutation still
passes is not a guard:

| Guard | Mutation |
|---|---|
| Triage path imports no context/run module (structural, source-reading) | add the import |
| `contexts.ids()` unchanged across a full pass (behavioural) | build a context in the pass |
| Every considered project's live board reaches the prompt | drop the digest section from `buildNotePassPrompt` |
| A two-feature answer becomes two proposals, not one | collapse them in `sanitizeProposals` |
| Runner error → `fallback: true`, the error on the pass, status `failed` | swallow the error and record an ordinary empty pass |
| Runner error with no `projectHint` → no proposal at all | pick a project anyway |
| Double approve creates one run and reports the existing id | take the claim after `startRun` |
| Unknown project → kept, flagged, rejected — never retargeted | default it to the boot project |
| Flag off → GET 200 empty, mutators 409, no 404 in the family | answer 404 |
| `NOTE_TO_SPEC_WORKFLOW` has no implement step | add one |

### What was actually run — 2026-08-14

**Every guard above was mutation-tested.** Each mutation was applied to the source, the suite
re-run, the failure observed, and the source restored. All eight were caught:

| Mutation | Caught by |
|---|---|
| Flag-off `GET /:noteId` answers 404 | `server/notes-api.test.ts` — flag-off family |
| `toWire` drops the closed-schema strip | `server/notes-api.test.ts` — unknown-key round-trip |
| `notes/coordinator.ts` imports `workflows/run.ts` (one level deep, NOT direct) | `notes/processor.test.ts` — transitive import walk |
| `buildNotePassPrompt` omits the board | `notes/processor.test.ts` — prompt |
| The claim is taken after `startRun` | `notes/approve.test.ts` — two concurrent approvals |
| `NOTE_TO_SPEC_WORKFLOW` gains an implement step | `notes/approve.test.ts` — the workflow |
| The review UI pre-selects a suspected duplicate | `routes/notes/notes.test.tsx` — the review gate |
| `NoteStore.recordResultingTask` lets the implementation run overwrite the spec claim | `notes/store.test.ts` (found a real bug this way) |

One caveat worth writing down rather than glossing: the first attempt at the transitive-import
mutation broke the test file's own syntax, and vitest reported "no tests" — which looks like a
red run and is not one. A broken build is not a killed mutant; the mutation was re-run against a
compiling tree before being counted.

The `contexts.ids()` control runs a REAL pass end-to-end under `CEZ_DRY_RUN=1` (the bundled mock
gained a `[cez-note-pass]` branch that reads the first catalog id out of the prompt, so it names
a project that actually exists rather than exercising only the rejection path). It asserts the
pass reached `processed` with proposals BEFORE asserting no context was built — otherwise a pass
that died at step one would satisfy it while proving nothing.

**Gate results.** `npm run typecheck` ✅ · `npm run test:unit` ✅ (35) · `npm run build` ✅ ·
`npm test` — 7797 pass, **24 fail** · `npm run test:package` — 14 pass, **1 fail**.

Those 25 failures are **pre-existing on `main`** and untouched by this work. Verified by stashing
the whole change (including untracked files), rebuilding, and re-running the same suites at HEAD:
identical failures, identical counts. They are `web/src/routes.test.tsx` (11),
`web/src/routes/settings/projects-section.test.tsx` (10), `web/src/routes/onboarding/onboarding.test.tsx`
(2), `server/src/server/projects-api.test.ts` (1, "an empty body is a no-op"), and
`test/e2e/package-cli.test.ts` (1, "a headless run registers the boot repo"). Nothing in this
feature touches any of them. **Fixing them is separate work and has not been done.**

**Root cause of the `test:package` failure, diagnosed 2026-08-15.** Independently reproduced in a
clean worktree at `0085e2bb` (`npm ci` + `npm run build` — the build is required, since
`test:package` packs `dist/` and `web/dist/`, both gitignored), then narrowed to a runtime
behaviour failure with no packing involved at all:

`suppressBootRegistration()` (`packages/cezar/src/registered-project-roots.ts`) returns an
unconditional `true`, so the registration branch in `initWorkspace`
(`packages/cezar/src/index.ts:249`, gated on `shouldRegisterProject(...) && !suppressBootRegistration()`)
is **dead code**. That is deliberate: it is D3 of `.ai/specs/2026-08-07-org-scoped-tasks-knowledge.md`
— "boot never auto-registers the launch directory; an unknown launch directory is *offered*, never
written" — which itself superseded an earlier version that suppressed only while onboarding was
incomplete, after the bug reappeared on a second launch. It landed in `9b5f62b8` (2026-08-08).
**That commit never touched `test/e2e/`**, and the test file is unchanged since `57683d02`. So the
assertion has been pinning reverted behaviour for a week.

Two consequences worth stating plainly. First, **`.github/workflows/ci.yml:57` runs `test:package`,
so CI on `main` is red** — and has been, unnoticed, for that week; "pre-existing" was recorded three
times without anyone asking why. Second, **the fix is to the test, not the code**: assert the
inverse (a headless run against an unregistered repo completes and leaves `projects` empty), then
register the fixture explicitly through the `registerAndAdoptProject` seam before the `cezar projects`
stdout assertion at `:178-184` that genuinely needs a registered project. Deleting the test instead
would drop real coverage and leave phase 5's offer-don't-write behaviour with no e2e at all, which
is the thing D3 exists to guarantee.

**Method note, because the next session will copy whichever one it reads here.** The verification
above was done by stashing the whole change. **Do not stash to establish a baseline in this
checkout** — parallel worktrees and agents run against it, and a stash rips their in-flight work out
from under them. `git worktree add <short-path> <commit>` gives the same clean baseline without
touching the shared tree. Use a short path: a deep one hits `mkdirat: name too long` here.

Two suites DID break because of this change and were fixed here: `server/health-forge.test.ts`
(one of seven exhaustive capability fixtures still excluded `notes`, with a comment citing the
removal spec — corrected in place) and `web/components/app-shell.test.tsx` (the nav gained a
Notes row).

Gates, in order, and `npm test -- <path>` rather than `npx vitest` (PLAN D21): `npm run
typecheck`, `npm test`, `npm run test:unit`, `npm run build`, `npm run test:package`.

**Runtime E2E — the gate on Done.** With `CEZ_NOTES=1` and at least three registered projects,
capture a real multi-feature note touching two of them. Confirm: the pass splits it and names both
projects; one proposal reports a duplicate of something genuinely on the board; approving one
starts a run in **that** project whose spec cites real specs and commits from that repo; and Start
implementation puts a run in that project's Tasks table and in `/tasks`. Until that has run, this
ships as QA Needed, not Done.

### Runtime E2E — EXECUTED 2026-08-15

Run against a real cockpit (`node dist/index.js --port 4399`) with `CEZ_NOTES=1 CEZ_KB=1
CEZ_WORKSPACE_VIEWS=1` and a **sandbox `CEZ_HOME`**, six registered projects (five real repos plus a
throwaway fixture). Driven both through the HTTP API and through the browser UI.

**What passed.**

| Step | Result |
|---|---|
| Capture a note at workspace scope | ok — `POST /workspace/notes` |
| Triage **splits** a two-feature note | ok — one note → 2 proposals |
| Triage **routes to the right projects** | ok when the note names projects by their registered id (`cezar` + `bubble-trade`, from 5 considered) |
| Detection works on a project it has never seen | ok — a fixture registered seconds earlier was picked correctly out of 6 |
| `fallback: false`, real runner | ok — `claude` runner, 9.6s and 29s on two passes |
| Approve starts a run **in that project** | ok — `kind: "spec"`, run id returned |
| The spec run writes a spec and **does not implement** | ok — 239-line spec added, `src/` diff **0 lines** |
| The spec cites the repo's own prior work | ok — `Extends: 2026-08-01-label-formatting.md`, plus a "What I read first" section naming the actual source file |
| Work is isolated on a branch | ok — `cez/<runid>`, `main` untouched |
| `/workspace/new` renders as specified | ok — Auto detect default, **no** template/base-branch/skill controls, explainer present, no toggle |
| Sidebar shape | ok — Tasks/Git/Knowledge/Notes/Settings above a `PROJECTS` heading, each project nested |
| `GET /workspace/git` | ok — real branch/upstream/ahead/dirty/head per project |

**Two defects found, neither caught by any unit test.**

1. **The Notes list does not refresh while a note is processing.** Submitting from `/workspace/new`
   lands on `/notes` with the note at `processing`, and it stays there indefinitely: the API had it
   at `processed` while the page still showed `processing`, and only a manual reload updated it.
   A user watching the page concludes the feature hung. There is no polling and no push channel on
   this list. **This is the first thing a new user sees, so it makes a working pipeline look broken.**

2. **Routing keys on the registered project id, so a note naming a project any other way can
   mis-route — silently and confidently.** A note saying "the **widget-service** label code has no
   test file … separately, **aside** needs a data export" put **both** proposals on `aside`. The
   fixture's registered id was `cez-e2e-fixture` while its README titled it `widget-service`, and
   nothing reconciles the two. The pass's own summary shows the conflation ("aside project has an
   already-completed spec run for label pluralisation" — that run was the fixture's). The split was
   still correct; only the target was wrong. Earlier passes succeeded **because the notes happened
   to use exact registered ids**, which is exactly the condition a hand-written test would also
   satisfy — so this class of failure is invisible to the suite by construction.

**Not exercised, and not claimable:** the **dedupe** leg. `boardDigestSize: 0` on every pass, because
a fresh sandbox `CEZ_HOME` has no prior runs to compare against. `duplicateOf` therefore never had
input and remains **unverified at runtime**. Also unexercised: Start-implementation from a written
spec, and the changelog projection (which still has no UI consumer at all).
