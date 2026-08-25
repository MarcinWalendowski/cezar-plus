# Workspace scope routes tasks into projects; it stops editing them

> **Status:** proposed · **Date:** 2026-08-25 · **Owner instruction, verbatim:**
> *"when creating a task we can by default set scope to workspace and the only available workflow
> there should be like: input-to-tasks, where retrieve the context across all workspace (like we are
> doing now in our default workflow). The workflow steps should be: 1. Gather the context. 2. Create
> task/tasks in projects/projects. 3. Trigger run of the tasks (this is optional, in UI user should
> be able to check if he want to start them automatically) WE SHOULDN'T CREATE ANY WORKTREE."*
>
> **Supersedes the execution half of:** `.ai/specs/2026-08-19-parallel-workspace-runs-worktrees.md`
> (W1–W8), `.ai/specs/2026-08-20-workspace-run-worktree-isolation.md` (X1–X6),
> `.ai/specs/2026-08-22-cross-project-worktree-orphan-prune-safety.md`,
> `.ai/specs/2026-08-22-workspace-run-worktree-orphan-prune.md`. None of them is *wrong*: each
> correctly closed the gap in front of it. They are superseded because they all answer "how does one
> run safely edit twelve checkouts at once", and this spec removes the question.
> **Leaves alone:** `.ai/specs/2026-08-21-workspace-boot-repo-and-always-worktrees.md` (the boot root
> stays a git repo, and non-workspace runs homed there still isolate — that fix is orthogonal and
> still needed), and per-task worktrees for ordinary **project-scoped** runs, which already fail
> closed and are the mechanism this design leans on.

## TLDR

A workspace-scoped task stops being a thing that *does* work across every project and becomes a
thing that *routes* work into projects. It runs one built-in workflow, `input-to-tasks`:

1. **Gather the context** across every registered project — read-only.
2. **File a task into each project** it concerns, via the existing `cez todo add --project <id>`.
3. **Start those tasks** — optional, off by default, a checkbox in the composer.

**A workspace run creates no worktree and writes no project working tree.** Its entire write surface
becomes each project's `.ai/cezar/todos.json`. The real work then happens in ordinary
project-scoped runs, which already get a `cez/<id8>` worktree per task and already **fail closed**
when they cannot get one.

This dissolves — rather than patches — the collision class documented below, in which five separate
runs were each handed the same live `cezar` checkout within seconds of each other on 2026-08-24,
each having been told by its own system prompt that it was working in an isolated worktree.

## Problem

Everything in this section was measured on `prod-host` on 2026-08-25 from `runs.json`, the run
NDJSON transcripts, the live working trees and the deploy release history. Nothing is reasoned
forward from the code alone.

### 1 — Isolation is optional per project, and the fallback is the live checkout with no lease

`materializeWorkspaceWorktrees` (`workspace/workspace-worktrees.ts`) loops over the granted
projects. A project that is missing, is not a git repo, or whose `createWorktree` throws contributes
**no entry**, and the caller falls back to granting its **real root**:

```ts
} catch (err) {
  note(`${project.name || project.id}: worktree failed (${message}) — granted in place`);
}
```

That fallback is deliberate and documented — *"so a single unco-operative repo never cranks the
whole run to a halt"*. The problem is what "in place" means for a **workspace** run specifically,
and the asymmetry is stark. In `workflows/run.ts`, a **single-project** run that cannot get a
worktree **fails the run**:

```ts
} catch (err) {
  const error = `worktree creation failed: ${message}`;
  this.store.updateRun(runId, { status: 'failed', error, … });
```

A **workspace** run emits a note and carries on — and then, by design, takes no lease at all:

```ts
if (isWorkspaceRun) {
  // no lease — parallel by design
}
```

The lease exemption is correct *given* the premise it was written under (spec 2026-08-19, W3: *"its
work is isolated in per-project worktrees, so the boot scratch tree it shares … holds none of it"*).
When isolation silently drops for one project, the premise is false for that project, and nothing
downstream re-checks it. **The one path that grants a shared live tree is the one path with no
serialization.**

Measured consequence — every in-place grant in the record, chronologically:

```
2026-08-22T13:18:03  run 3352a1e4  project=cezar
2026-08-22T13:40:53  run 3352a1e4  project=cezar
2026-08-24T14:25:51  run 15ff402b  project=cezar
2026-08-24T17:57:24  run 15ff402b  project=cezar
2026-08-24T18:35:14  run 22b6f7cd  project=cezar   <== same live root as 15ff402b
2026-08-24T18:37:00  run 171c8647  project=cezar   <== 106s later, third run
2026-08-24T18:37:29  run 15ff402b  project=cezar   <== 29s later
2026-08-24T19:42:10  run 22b6f7cd  project=cezar
2026-08-24T19:42:10  run 15ff402b  project=cezar   <== identical second
2026-08-24T19:43:14  run da9033bd  project=cezar   <== 64s later, fourth run
2026-08-24T19:49:49  run 6c217a42  project=cezar   <== fifth run
```

Five distinct runs, all handed `/var/lib/cezar/loki-labs/cezar` — the live checkout the box builds
and deploys from — with grants as little as **0 seconds** apart. That is the owner's report,
measured: *"multiple tasks are running on the same files."*

The residue is visible now. `git status --porcelain` in that checkout carries 13 entries on `main`,
including two **staged** spec files and modifications to `run.ts`, `granted-roots.ts` and
`workspace-worktrees.ts` — the very files this spec is about.

### 2 — The trigger is a `null` that means eight different things

The in-place grant fires on `if (!repo)`, where `repo` comes from `getRepoInfo`
(`server/git.ts`), which ends:

```ts
  } catch {
    return null;
  }
```

Every failure collapses into one `null`: a genuinely non-git directory, a transient timeout, a fork
failure under load, a corrupt object database, a permissions fault. `materializeWorkspaceWorktrees`
then reads that single `null` as the **categorical** claim `not a git repo` and applies the remedy
that is only correct for the one cause that is actually permanent.

`/var/lib/cezar/loki-labs/cezar` is emphatically a git repo. It has 21 live worktrees, 89 `cez/*`
branches, a 75 MB object store, and `git rev-parse --show-toplevel` returns in 0.00 s.

The onset is datable. Commit `f45a00bd` (*"bound the two awaits that could hang forever, at the
cause"*, **2026-08-24 08:17:34 +0200**) gave `git()` a 30 s timeout plus a 2 s kill grace, adding a
**new throw path** where the call previously hung forever:

| release | carries `f45a00bd` | deployed |
|---|---|---|
| `20260823T195016Z-1509d3ad` | **no** | 2026-08-23 19:50Z |
| `20260824T141542Z-7835f33a` | **yes** | 2026-08-24 14:15:42Z |

The first `cezar: not a git repo` note in the entire record is **2026-08-24T14:25:51Z** — ten
minutes after the first release that could produce it. Every subsequent one is in that release or
later, and none exists before it.

**I cannot say which transient it was, and that is the finding.** The diagnostic is destroyed at
`catch { return null }`, so the record cannot distinguish a 32 s stall from an `EAGAIN`. Measured at
investigation time and ruled out as standing causes: ownership audit `find /var/lib/cezar -not -user
cezar` = **0**; zero-length loose objects = **0**; no `safe.directory` entries; no stale
`index.lock` or `gc.pid`; `rev-parse` at 0.00 s under load average 1.44 on 16 cores. A failure mode
whose remedy is "abandon isolation and hand over the live tree" must not be reachable from an error
nobody can name afterwards.

`f45a00bd` is not the bug and should not be reverted — an unbounded git call was a real defect. It
merely converted a hang into the *silent* failure that was already waiting behind it.

### 3 — The system prompt tells the agent the live checkout is an isolated worktree

`buildWorkspaceGrant` (`workspace/granted-roots.ts`) computes:

```ts
const isolated = worktrees.length > 0;
```

**Any** worktree makes the whole grant read as isolated. So in a run where eleven projects isolated
and `cezar` did not, `workspaceGrantSystemPrompt` still emits:

> Each path above is an ISOLATED git worktree for that project, not its real checkout. Do all your
> work there. When this task finishes, cezar applies your changes back into each real checkout
> automatically and removes the worktree — so do NOT commit, stash, reset, or push, and never edit a
> project outside its worktree path.

…while the `cezar` line in that same list is the real checkout. The prompt then names exactly one
shared exception — the knowledge-base mounts — which tells the agent, in as many words, that
everything else it can reach is its own. The agent has no way to know otherwise, and it has been
told not to commit, so its edits stay uncommitted in a tree three other agents are also editing.

This is the part that makes the failure dangerous rather than merely wasteful: the run does not
degrade visibly, it degrades into **a confident false belief**.

### 4 — Two of twelve projects are granted a path that cannot exist

`brand` and `lokie-chatbox` have no `.git` of their own; `git rev-parse --show-toplevel` in either
walks up to `/var/lib/cezar/loki-labs`. The 2026-08-20 collapse rule (X1) therefore folds them into
that repo's worktree and maps each to a matching subdirectory — a rule written for *tracked
subdirectories of a monorepo*.

They are not tracked subdirectories. `/var/lib/cezar/loki-labs/.gitignore` is `/*` with 19 files
allowed back, and `git check-ignore -v` confirms it:

```
.gitignore:9:/*	brand
.gitignore:9:/*	lokie-chatbox
.gitignore:9:/*	notion-export
```

Measured in the live worktree of the currently-running workspace run:

```
$ ls .ai/cezar/worktrees/90836867-…/
.claude/  .gitignore  AGENTS.md  CLAUDE.md  tools/
brand/          → NO — absent
lokie-chatbox/  → NO — absent
notion-export/  → NO — absent
```

So in **every** isolated workspace run, two of the twelve registered projects are advertised in the
system prompt at paths that do not exist. This is not a collision; it is silent unreachability, and
it has been true since the collapse rule shipped.

### 5 — A restart orphans a broker that keeps writing the worktree the new session owns

Already recorded in the corpus on 2026-08-24
(`knowledge/notes/scope-isolation-survives-the-stop-then-cezar-discards-the-survivor--local.md`):

> The surviving broker is orphaned: still running, still holding a live backend session, **still
> pointed at a worktree the new session now owns, so two agents write the same tree.** Six were
> found alive at cleanup on 2026-08-24, up to 17 minutes old, each with a live `claude` child.
> **Three of them predated the test**, which is the important part: this leaks on ordinary restarts.

The hub blue-green self-deploys roughly ten times a day, so "ordinary restarts" is the common case.

**This spec does not fix mechanism 5.** It is a restart/adoption defect in the broker lifecycle, it
reaches project-scoped runs too, and it needs its own spec. It is listed here because it produces
the same user-visible symptom, and closing 1–4 without saying so would leave the owner believing the
symptom is fully gone when it is not.

### 6 — The cost of the machinery being removed

21 worktree directories / **6.6 GB** in `cezar`, 7 / **3.9 GB** in `chat`, one each in seven other
repos. Disk is not currently at risk (37 G of 601 G used), but this is per-run full checkouts of
every repo, kept for a mechanism that is about to stop being needed.

### 7 — The route already asks for this, and the run prologue overrides it

`POST /api/v1/workspace/runs` already sets `worktree: false` on the run input, calling it *"the two
decisions this route owns"*. In `run.ts` the `isWorkspaceRun` branch is evaluated **first**, so the
`input.worktree === false` branch below it is unreachable for a workspace run. The route's stated
intent and the runtime's behaviour have disagreed since the 08-19 spec landed. Implementing this
spec makes the route honest rather than adding a new knob.

## Solution

**Workspace scope is a router.** It reads everywhere and writes one file per project.

### The workflow: `input-to-tasks`

A new built-in in `workflows/types.ts`, alongside `quick-task` / `note-to-spec` / `spec-to-deploy`.

| # | step id | what it does | tools |
|---|---|---|---|
| 1 | `context` | Gather the record across every registered project: KB first (`cez kb search`, `domains/<product>.md`), then each project's `.ai/specs/`, then git history. Read-only. Mirrors `spec-to-deploy`'s existing "Gather the record" step, widened from one repo to all. | `Read`, `Grep`, `Glob`, `Bash` restricted to `cez kb`, `git log`, `git show`, `git status` |
| 2 | `file` | Decide which project(s) the input concerns and file one todo into each, with Context / What to do / Acceptance criteria in the body. **Never** `--start`. | `Bash` restricted to `cez todo add` |
| 3 | `dispatch` | **Optional.** Flip the just-filed todos to autostart. No-op — and says so — when the run was not created with auto-start. | `Bash` restricted to `cez todo start` |

**Step 2 files and step 3 starts, deliberately as two steps.** Passing `--start` in step 2 would
make "filed" and "started" one indivisible act; splitting them means a failure in step 3 leaves the
work filed and recoverable on the Filed board rather than losing it, and it makes both facts
separately observable in the transcript. It is also what makes the optional half a genuine no-op
rather than a different filing command.

### Why this needs almost no new machinery

`cez todo add` already exists and is exactly the primitive step 2 needs
(`.ai/specs/2026-08-19-file-tasks-from-a-running-task.md`):

```
cezar todo add "<summary>" [--project <id|path>] [--context "..."] [--acceptance "..." ...]
                           [--priority low|medium|high] [--skill <name>] [--spec <path>]
                           [--start] [--json]
```

It writes straight to the target project's `.ai/cezar/todos.json` on the filesystem — deliberately
not over HTTP, which would 401 a headless caller — and produces a row byte-identical to a
composer-filed one.

Auto-start already exists too, and is already correctly serialized: `--start` sets `autostart: true`,
and `todo-autostart.ts` has the **running cockpit** turn that into a run, *"never a second headless
manager … only it owns this project's concurrency cap and single-workspace-run lease"*. So step 3
does not start anything itself; it hands the decision to the component that already owns it.

The only new CLI surface is a way to flip an **existing** todo to autostart, since `cez todo` today
has only `add` and `list`:

```
cezar todo start <id> [--project <id|path>] [--json]
```

### What is removed

For a workspace run, `materializeWorkspaceWorktrees` is not called. With it go, on this path:
`applyWorkspaceWorktrees`, `discardWorkspaceWorktrees`, `writeWorktreeLease` for foreign roots,
`armWorktreeLeases` over foreign roots, and the cross-project half of `worktree-ownership.ts` /
orphan pruning. The grant becomes the projects' **real roots**, read-mostly, and
`workspaceGrantSystemPrompt` loses its `isolated` branch entirely — replaced by a single honest
paragraph:

> These are the real checkouts, shared with every other run in flight. This task does not edit them.
> Read them, then file a task into each project that needs work with `cez todo add --project <id>`.
> Do not edit, commit, stash, reset or push in any project.

Mechanisms 1, 3 and 4 cannot occur after this, because there is no isolation to lose, no isolation
claim to be false, and no collapse mapping to be wrong.

## Architecture

```
        BEFORE                                    AFTER

  workspace run                             workspace run  (input-to-tasks)
        │                                          │
        ├── worktree in chat ────┐                 ├── reads all 12 projects (read-only)
        ├── worktree in cezar ───┤ apply back      │
        ├── … ×10 ───────────────┤ into 12 real    └── writes N × .ai/cezar/todos.json
        └── 2 projects: path ────┘ checkouts               │
            that cannot exist                              │  autostart (optional)
        ↑                                                  ▼
        └─ any failure here: the LIVE checkout,      project-scoped run, per task
           no lease, prompt says "isolated"                 │
                                                           └── cez/<id8> worktree
                                                               FAILS CLOSED if unavailable
```

The write surface of a workspace run collapses from *twelve working trees* to *N append-only todo
stores*, each written through `createTodo`'s existing atomic path. Concurrency stops being this
path's problem: two workspace runs filing into the same project append two rows.

## Phases

**Phase 1 — stop creating worktrees for workspace runs.** Delete the `isWorkspaceRun` materialize
branch in `run.ts`; let the run fall through to the existing no-worktree path. Rewrite
`workspaceGrantSystemPrompt`'s isolated branch as the read-only paragraph above. Keep the
*readers* (see Backward compatibility). Ships alone and is the whole safety fix.

**Phase 2 — `input-to-tasks` + `cez todo start`.** The built-in workflow and the one new CLI
subcommand.

**Phase 3 — composer.** Scope defaults to **workspace**; at workspace scope the workflow picker
offers only `input-to-tasks`; a "start the filed tasks automatically" checkbox, **default off**,
carried as `autoStart` on the run.

**Phase 4 — prune.** Once no run record still carries `workspaceWorktrees`, delete the now-dead
cross-project worktree machinery and its tests.

## Data models

- **Run record** (`runs/store.ts`): `workspaceWorktrees` becomes **legacy, read-only** — still
  parsed, no longer written. New optional `autoStart?: boolean` recording what the composer asked
  for, so the transcript can explain why step 3 was or was not a no-op.
- **Todo** (`todos.ts`): unchanged. `autostart` already exists and already means exactly this.
- **Config:** no new keys. Per this workspace's convention any tuning is an env var, and none is
  needed.

## API contracts

- `POST /api/v1/workspace/runs` — `workflow` now defaults to `input-to-tasks` when omitted;
  new optional `autoStart?: boolean` (default `false`). `worktree: false` stays and finally means
  what it says. **Additive**: an existing caller naming a `workflow` still works.
- `cezar todo start <id> [--project <id|path>] [--json]` — new subcommand. **Additive.**
- No route is removed, no field is removed from any response.

## Backward compatibility

cezar is a published CLI (`@loki-labs/better-cezar`, 0.x) whose state is plain files inside
strangers' repos, so `BACKWARD_COMPATIBILITY.md` applies. Everything above is additive except one
thing, handled as follows:

- **Remove the writer, keep the reader.** Run records written by older versions carry
  `workspaceWorktrees`, and those worktrees exist on users' disks. The parse path, the settle-time
  apply/discard and the orphan prune stay until Phase 4, so an in-flight run upgraded mid-flight
  still lands its work and still cleans up. Only the code that *creates* new ones goes.
- **Phase 4 is gated on the drain, not on a date** — it may not land until no reachable run record
  carries the field.
- **README + CHANGELOG** note that workspace-scoped runs no longer edit projects directly, with the
  one-line migration ("workspace tasks now file project tasks; run those"), and a **minor** bump
  called out as breaking, per the 0.x rule.

## Risks

1. **Losing genuine cross-project edits from one task.** Real: a change that must land atomically
   across `chat` and `cezar` is now two tasks. Accepted deliberately — it was never atomic anyway
   (apply-back is per repo, serialized per root, and can conflict per repo), and each half now gets
   its own isolated worktree and its own gates. A task needing both can still be run project-scoped
   with the other project granted read-only.
2. **The gather step reads twelve projects and blows its context.** Mitigate by making step 1
   KB-first and specs-second exactly as the house rules already require, and by capping it to the
   projects the input plausibly concerns rather than all twelve unconditionally.
3. **Task spam.** A vague input could file twelve todos. Mitigate: auto-start defaults **off**, so
   the default outcome is rows on the Filed board a human approves; and step 2's prompt requires a
   named reason per project.
4. **Mechanism 5 (orphaned brokers) survives this spec** and will keep producing the same symptom at
   a lower rate. Must be tracked as its own spec; do not report the symptom as closed.
5. **Auto-start bypasses review when switched on.** It is off by default and per-run, never a
   config default.

## Verification

Decided up front, and each step is executable.

**V1 — negative control, the core claim.** Snapshot `git worktree list | wc -l` in all twelve
project roots; run a workspace task end to end; re-snapshot. **Every count must be unchanged**, and
the run record must have no `workspaceWorktrees`. This is the assertion the whole spec exists to
make true.

**V2 — mutation proof for V1.** Re-enable the materialize call behind a temporary flag and confirm
V1 **fails**. A green V1 against code that still creates worktrees would prove nothing.

**V3 — the grant is honest.** Assert `workspaceGrantSystemPrompt` output for a mixed grant contains
neither "ISOLATED git worktree" nor "applies your changes back", and that every path it lists
`existsSync`. Fixture must include a project with no `.git` inside an ignoring parent — i.e. the
`brand` shape from §4 — which today produces a nonexistent path.

**V4 — filing.** Unit: step 2's prompt contract against `cez todo add --project`. Integration: a run
whose input names two projects files exactly two todos, in the right `todos.json`, with
`autostart` **absent**.

**V5 — dispatch is genuinely optional.** With `autoStart: false`, assert zero runs start and step 3
reports a no-op. With `autoStart: true`, assert each filed todo reaches `autostart: true` and the
cockpit's watcher starts it under the project's own cap. Both directions — an "optional" step tested
only in the on position cannot see a step that always fires.

**V6 — compatibility.** Load a run record fixture carrying `workspaceWorktrees` from before this
change; assert it parses, applies back and prunes exactly as today.

**V7 — gates.** `typecheck`, `lint`, the full suite — **run on the box, twice**, per the standing
rule that the loaded Mac produces a load-sensitive flake pool and one run cannot tell a broken test
from a flake.

**V8 — runtime E2E on production.** Start a real workspace task from the cockpit against the live
twelve-project registry, with auto-start off; confirm the filed todos appear on the Filed board,
confirm V1's worktree counts, and confirm `git status --porcelain` in every project root is byte-
identical before and after. Until V8 has passed this is **QA Needed**, not Done.

## Cleanup, independent of this spec

These are consequences of the defect, not of the fix, and should be handled whether or not the spec
lands:

- `/var/lib/cezar/loki-labs/cezar` carries 13 uncommitted/staged entries on `main`, including two
  staged spec files, left by the in-place runs of 2026-08-24. Needs a human to sort and commit or
  discard — an agent cannot know which run intended what.
- 21 worktrees / 6.6 GB in `cezar` and 7 / 3.9 GB in `chat`, plus 89 `cez/*` branches, several
  outside the managed `cez/<id8>` shape (`cez/3352a1e4-a574-40fd-a84e-08eff320995a`,
  `cez/cd439910-autosave`, `cez/bcc059a6-pre-rebase-20260823`, `cez/per-task-prompt-drafts`). The
  first of those is what made run `3352a1e4` refuse its own managed path and fall back to the live
  checkout — a hand-made branch in a managed namespace converts to permanent isolation loss for that
  run. Worth a guard, and worth pruning.
- `getRepoInfo` should carry its failure reason rather than returning a bare `null`, so the next
  incident of this shape is diagnosable. This spec removes the *consequence* on the workspace path;
  33 other call sites still read that `null`.
