# One cross-project workspace run

> **Status:** implemented — every gate green; runtime E2E recorded under "Executed" below.
> · **Date:** 2026-08-15 (implemented 2026-08-16)
> **Supersedes:** `2026-08-15-knowledge-grounded-task-fanout.md`, entirely. That spec's mechanism —
> split one request into N per-project todos — is the thing this one deletes.
> **Keeps from it:** `GET /workspace/todos` + the ungated FILED section on `/tasks` (D2/D7a), and
> the structured todo spec fields, whose writer is now `POST /todos`.

## TLDR

The composer's project pill offers **Workspace** (renamed from *All / Auto*, and still the
default). Submitting with it selected starts **ONE run**: not scoped to any project, running in
place with no worktree, granted read and write access to **every registered project directory**.
One transcript, one output, changes across every checkout. It starts immediately — there is no
analysis pass in front of it.

## Problem

### 1 — the shape was wrong, and it had just shipped

The fan-out did exactly what its spec said: one submit produced twelve todos, one per project,
each grounded in that project's own knowledge base. The owner's response on seeing it:

> *"it's non sense — i don't want to have task per each project — it should be still one task that
> makes me one output and apply changes across all directories/projects"*

Nothing about the implementation was broken. The **premise** was: work that spans projects is one
piece of work, and splitting it up front produces N briefs to read and N runs to start instead of
one answer.

### 2 — the reported bug was a symptom of that premise

The report that opened this thread was *"I just tried to add a task and nothing happened."* The
submit had in fact worked — 12 todos, ~60 s. It looked dead because the fan-out was a long
synchronous analysis that produced **nothing to navigate to**, so its result had to be parked in
the TanStack MutationCache and surfaced through a pending banner, a result panel and a shell
toast, each of which had to survive an unmount. Three surfaces existed only to make a wait
bearable.

A submit that starts a run has none of that problem: the run thread is the surface, and it exists
before the composer finishes clearing. **Fixing the visibility was fixing the wrong layer.**

### 3 — there was no way to express "work on everything"

Every run belongs to one project, and `--add-dir` was reachable only for the run-state folder and
knowledge-base roots. A task like *"bump the lint rule everywhere"* had no representation at all.

## Solution

A **workspace run**: an in-place run in the boot project, granted every registered project root.

| Decision | Value | Why |
|---|---|---|
| **D1** Where the record lives | The boot project's `runs.json` | Every `RunManager` is bound to a repository, and the boot repo is the one every workspace-level pass already uses. A storage fact, not a scoping claim. |
| **D2** cwd | The boot root (`~/cezar/cockpit-boot` on the owner's install — an empty scaffold repo) | A neutral cwd containing none of the work, so no project is accidentally privileged. The agent works by absolute path. |
| **D3** Access | `--add-dir` per granted root, deduped by containment | Registering a parent and its children is normal, not an edge case: 12 registered roots collapse to 2 on the owner's workspace. Passing all 12 would work but claims precision the grant does not have. |
| **D4** Worktree | Forced `false`, server-side, not offered | There is no single repo to branch. Consequence, stated rather than discovered: an in-place run takes the boot repo's exclusive-tree lease, so **one workspace run at a time** — correct, since two agents editing the same checkouts concurrently is a hazard, not throughput. |
| **D5** The grant is persisted, not re-derived | `runRecordSchema.workspaceProjects` | The registry is mutable. A project added or removed mid-run would silently widen or narrow the grant of a run already in flight, the moment it resumed. Decided once at creation; every step and every restart re-applies that list. |
| **D6** The prompt states the grant | `workspaceGrantSystemPrompt` | `--add-dir` is **Claude-only** — codex and opencode drop `additionalDirectories` on the floor. The prompt text is the portable half, and the only thing that tells *any* backend where the work is. |
| **D7** No commits | Stated in that prompt block | With no worktree, every edit lands in the user's real working tree beside whatever they had in progress. An agent that helpfully `git commit -am`s is committing someone else's work. |
| **D8** An empty grant is a 409 | Not a run | Starting an agent in an empty scratch repo and calling it a workspace run is the exact "it worked and nothing happened" shape this spec exists to remove. |
| **D9** Ungated | No `capabilities()` check | Same reason the route it replaces had none: this is the composer's default submit path on a multi-project workspace, and gating a main path on a flag nobody sets makes it fail as silence. |
| **D10** `.strict()` input | `worktree`/`variants`/`todoId` are a 400, not stripped | Zod strips unknown keys by default, so `worktree: true` would answer 201 with a worktree-less run. For a run that edits real checkouts, "we heard you and did something else" is the worst available answer. |
| **D11** The composer offers neither control | Worktree chip and variants pill **hidden** while Workspace is selected | Found in the browser E2E, not by a test. D10 makes the *API* refuse to silently ignore `worktree`, but the composer still rendered a tickable Worktree chip, and `buildWorkspaceRunBody` strips the key before the post — so the user ticks it, sees it ticked, and gets a run with no worktree. The exact answer D10 exists to refuse, smuggled back one layer above it. Hidden rather than disabled, following `followupsToggleShown`'s rule ("the server pins the value regardless, so a control would be a lie"), and nothing is lost because the header line already states both facts. |

### What was deleted

`src/fanout/` (engine + prompt + tests), `server/task-fanout-routes.ts` + test,
`contract/src/task-fanout.ts`, and client-side `useFanoutTasks` / `useFanoutState` /
`useDismissFanout` / `FANOUT_MUTATION_KEY`, `FanoutPendingBanner` / `FanoutResultPanel` /
`FanoutErrorPanel`, `fanoutToastMessage` / `useFanoutCompletionToast`. Pre-launch doctrine: change
directly, and never leave a dead path that reads as live.

## Architecture

```
composer (Workspace pill)
  └─ POST /api/v1/workspace/runs          ← never /p/:projectId — no project is named
       ├─ resolveRunWorkflow  ┐ shared verbatim with POST /runs, so both answer
       ├─ guardRunStart       ┘ identically for the same body
       ├─ loadWorkspaceGrant()            ← registry → { projects[], roots[] (deduped) }
       └─ bootContext.manager.startRun(workflow, {
            worktree: false, workspaceProjects: grant.projects })
             └─ persisted on the record
                  └─ every step: workspaceGrantOf(record) → buildWorkspaceGrant (pure)
                       ├─ …roots      → additionalDirectories → --add-dir
                       └─ prompt block → composeSystemPrompt
  ← { run, project: <boot slug>, grantedRoots[] }
       └─ navigate(scopeTo(project, `/tasks/${run.id}`))
```

`bootContext` is taken directly, never `contexts.context(id)` — the boot context already exists in
the serving process, so starting a workspace run builds nothing and resumes nothing. Same
justification `noteApprover.startRun` records for the one notes path allowed to build a context.

## Data Models

```ts
// contract/src/runs.ts
workspaceGrantProjectSchema = { id, name, root, status: ok|missing|not-git|no-commits }
runRecordSchema.workspaceProjects?: WorkspaceGrantProject[]   // D5
```

The **project** list, not the granted **directory** list: `--add-dir` gets the containment-deduped
set (12 → 2), while the prompt must name all 12 so the agent knows what is there. Both derive from
this one field via `buildWorkspaceGrant`, a pure function, so nothing re-reads the registry mid-run.

A project with `status: 'missing'` contributes **no** root (`--add-dir` on a nonexistent path fails
the spawn — one moved checkout would kill every workspace run) but stays in the list, rendered as
unreachable rather than silently absent.

## API Contracts

`POST /api/v1/workspace/runs` — `createRunInputBaseSchema` minus `worktree`/`variants`/`todoId`,
`.strict()` (D10). Answers `201 { run, project, grantedRoots }`; `409` for an empty grant (D8) or a
guard refusal; `400` for an unknown account or a rejected key; `404` for an unknown workflow.

## Phases

1. `workspace/granted-roots.ts` — containment dedupe + prompt block (pure).
2. Contract + store + `run.ts`: carry `workspaceProjects`, apply it at both spawn sites.
3. `POST /workspace/runs`, sharing `resolveRunWorkflow`/`guardRunStart` with `POST /runs`.
4. Client: `startWorkspaceRun`, the composer branch, the pill relabel, the header warning.
5. Delete the fan-out; correct in place every docblock that cited it as a writer.
6. Spec, supersede-in-place, Notion sync, one commit.

## Risks

- **An agent with write access to every checkout, no worktree.** Mitigated by D7's prompt block,
  the header line in the composer, and D4's serialization. Not mitigated by isolation — there is
  none, by design, and that is the thing the user chose.
- **`--add-dir` is Claude-only.** D6 is the mitigation and it is guarded by its own test, because
  deleting it leaves Claude working and every other runner silently unable to find a file.
- **No diff summary.** `diffStat` is only computed when `run.worktreePath` exists, so a workspace
  run shows none — the same as every in-place run today, not a new regression. The transcript is
  the output. A per-root `git status --porcelain` summary is the obvious follow-up and is
  deliberately **not** in this spec.

## Verification

Every guard names the mutation that must turn it red.

| Guard | File | Mutation |
|---|---|---|
| Granted roots reach `additionalDirectories` | `workflows/workspace-grant-wiring.test.ts` | Drop `...stepGrant?.roots` — **verified red** |
| The grant is named in the prompt TEXT | same | Delete `workspaceGrantSystemPrompt(stepGrant)` — **verified red** |
| The grant is read from the RECORD | same | Never persist `workspaceProjects` — **verified red (3 cases)** |
| An ordinary run gains nothing | same | — |
| 12 registered roots → 2 granted | `workspace/granted-roots.test.ts` | Return roots unfiltered |
| Segment containment, not `startsWith` | same | `/a/bc` inside `/a/b` |
| A missing project grants no root, is still listed | same | — |
| `worktree: false` + full grant reach `startRun` | `server/workspace-run-routes.test.ts` | — |
| An empty grant 409s and starts nothing | same | — |
| `worktree`/`variants`/`todoId` are 400s | same | Drop `.strict()` |
| Ungated on a default install | same | Reinstate a capability check |
| Submit posts to `/workspace/runs`, exactly one run | `routes/new-task-project.test.tsx` | — |
| Navigation uses the RESPONSE's project, not the active scope | same | Use `startedRunPath` — **verified red** |
| The header warns about real checkouts, never promises isolation | same + `new-task-draft.test.ts` | — |
| No Worktree / variants control is offered (**D11**) | `routes/new-task-project.test.tsx` | Un-gate either one — **verified red, both halves independently**. Asserts both chips PRESENT for a named project in the same render, so it cannot pass by their having been deleted outright |

Gates: `npm run typecheck`, `npm test` (**8177 passed / 443 files**), `npm run test:unit`,
`npm run build`, `npm run test:package` — all green 2026-08-16, judged by exit code.

### Executed — runtime E2E

Ran 2026-08-16 against the real cockpit (`localhost:4321`, booted on `~/cezar/cockpit-boot`),
after `npm run build` and a restart. Deployed build verified before the run: `task-fanout` absent
from `dist/index.js`, and `POST /workspace/runs` answers **400** on an empty body rather than 404.

**Task** (deliberately naming projects, never paths): *"In the registered projects named `mw-site`
and `homebrew-tap` ONLY, create `WORKSPACE-RUN-E2E.md` at the repo root containing that project's
name and the first line of its own README.md."*

| Claim | Result |
|---|---|
| One run, started immediately | `201`, run `15cdbad4`, `status: queued` → `done` |
| Not scoped to a project | Response `project: "cockpit-boot"`; all 12 registered projects persisted on the record |
| Grant deduped by containment | `grantedRoots: ["/Users/mw/loki-labs", "/Users/mw/cezar/projects/black"]` — **12 → 2** |
| `worktree: false`, forced | On the record; `worktreePath: null`, `branch: null` |
| The prompt taught it the paths (**D6**) | The task named no path and the cwd is an empty boot repo outside the grant, yet the agent wrote to `/Users/mw/loki-labs/mw-site` and `/Users/mw/loki-labs/homebrew-tap`. The grant block is the only place it could have learned them. |
| Changes land in the REAL checkouts | `git status` in each showed `?? WORKSPACE-RUN-E2E.md`; contents read from each project's own README (`mw-site # example.com`, `homebrew-tap # marcinwalendowski/homebrew-tap`) |
| Boot repo untouched | Clean; no `cez/*` branch, no `.git/worktrees` |
| Blast radius | `find` over both trees: exactly two files. The two other repos with dirty trees (`chat`, `chat-wt-spec-101`) were checked and their changes are unrelated pre-existing work |
| **D4** serialization is live | The run's event log contains `waiting for exclusive access to the repository working tree` — the in-place lease was taken |
| **Known limit confirmed** | `diffStat: null`. As stated in Risks: no diff summary for an in-place run. The transcript is the output. |

**Cleanup:** both probe files removed; `mw-site` and `homebrew-tap` verified clean afterwards.

### Executed — browser E2E, through the composer

The API pass above proves the server. It does **not** touch the surface the bug was actually
reported on: *"I just tried to add a task and nothing happened"* was a UI report, and verifying it
with `curl` would have left the reported symptom unverified. So this pass drives the real composer
in Chrome, on a rebuilt and restarted cockpit.

| Claim | Result |
|---|---|
| `?scope=auto` opens on the new pill | Pill reads **Workspace**, subtitle "one run, every project" — ahead of all 12 registered projects |
| The header states the risk | *"Runs once across every project — your real checkouts are modified directly, with no worktree."* |
| **D11**, found here | Worktree chip and `×1` pill are **absent** under Workspace, present again for a named project |
| **The reported bug is gone** | Submit navigated to `/p/cockpit-boot/tasks/be176a55…` **immediately** — no banner, no wait, no invisible operation. The run thread is the surface |
| The thread states the mode | Event log: `worktree off — running in the repo working tree`, then `waiting for exclusive access to the repository working tree` (**D4** again) |
| One run, in place | `worktree: false`, `autonomous: true` on the record; status `done` |
| Real checkouts edited, per project | `mw-site` → `mw-site main`; `homebrew-tap` → `homebrew-tap main`. Each resolved **its own** branch, so the agent worked in both trees rather than copying one answer |
| Boot repo untouched | Only `?? .ai/` (this run's own state). No branch, no `.git/worktrees` |
| Blast radius | `find` over both trees: exactly two files |

**Cleanup:** both probe files removed; both projects verified clean.

**One honest note on method.** The first poll of this run reported `?` for five minutes: it read
`.run.status`, and `GET /api/v1/runs/:id` returns the record **unwrapped**. The run had been `done`
almost the whole time. Nothing was concluded from the `?` — the raw response was read instead,
which is the only reason it did not become "the run hung". A probe keyed on the wrong shape reports
the same thing as a broken feature.
