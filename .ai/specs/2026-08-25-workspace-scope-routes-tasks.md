# Workspace scope routes tasks into projects; it stops editing them

> **Status:** partial — **Phases 1–3 implemented, shipped and LIVE 2026-08-25** (`dc64b741`,
> release `20260825T104007Z-dc64b741`; purity fix `7e82ce10` on top, comment-only), **still QA
> Needed.** The code was verified running on production — the loader serves `input-to-tasks`, no
> step holds a write tool, the route defaults, the worktree call is gone — and **V7's on-the-box
> gate has now run** (11854 pass / 0 fail at `7e82ce10`; it caught a real red at `dc64b741` that
> every narrow Mac sweep missed). What keeps it QA Needed: **nobody has driven the screen**, and no
> workspace run has been started on the live release. See *Implementation status* below for exactly
> what was and was not executed. **Phase 4 not started and cannot be: it is gated on the worktree
> drain.**
>
> **RUNTIME E2E PASSED 2026-08-25 12:20 UTC, unstaged:** a real composer submit ran
> `input-to-tasks` as the workspace default across 13 projects, created **0 worktrees**, filed a
> todo onto the cezar board and started nothing (toggle off). Run `ed71bbd9`. Detail in *V8* below.
>
> **KNOWN DEFECT in the shipped Phase 3, found 2026-08-25 after deploy:** the **Start filed tasks**
> toggle files todos correctly and **starts nothing** for any project that is not already resident,
> because `cez todo start` only sets a flag and the watcher that reads it is armed for resident
> contexts only. Being fixed by run `1f5aa96e` / `.ai/specs/2026-08-25-lazy-project-watchers.md`
> (todos `f09bf585` + `503195a8`). Detail in *Phase 2* below. · **Date:** 2026-08-25 · **Owner instruction, verbatim:**
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

**SUPERSEDED 2026-08-29 by 2026-08-25-composer-dispatch-mode.md:** Plan shaping now removes the
dispatch step when auto-start is off. The filing and dispatch operations remain separate when the
choice is on, but the OFF path no longer reaches a no-op agent step.

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

cezar is a published CLI (`@loki-labs/cezar-plus`, 0.x) whose state is plain files inside
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

**SUPERSEDED 2026-08-29 by 2026-08-25-composer-dispatch-mode.md:** The optional dispatch behavior
below was replaced by shaping the persisted plan before the run starts. The new spec's OFF path
omits the step entirely, rather than spawning it to report a no-op.

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

- ~~`/var/lib/cezar/loki-labs/cezar` carries 13 uncommitted/staged entries on `main`, including two
  staged spec files, left by the in-place runs of 2026-08-24. Needs a human to sort and commit or
  discard — an agent cannot know which run intended what.~~ **Done 2026-08-25.** The count was 13
  when written and had drained to 1 by the time it was acted on. The two staged specs were recovered
  from dangling autosave `a08dcf85` and pushed as `8d5274c3`
  (`2026-08-25-verify-bulk-start-release.md`, `briefs/2026-08-25-bulk-task-starts.md`); the one
  remaining dirty file was a spec renumbering `cezar` itself had written. `.e2e-bulk-start.cjs` was
  deliberately left out as a run's scratch fixture. The live checkout is now at **0 dirty entries**.
  Note the shape for next time: the list was *already stale when read* — verify a cleanup list
  against the tree before acting on any row of it.
- 21 worktrees / 6.6 GB in `cezar` and 7 / 3.9 GB in `chat`, plus 89 `cez/*` branches, several
  outside the managed `cez/<id8>` shape (`cez/3352a1e4-a574-40fd-a84e-08eff320995a`,
  `cez/cd439910-autosave`, `cez/bcc059a6-pre-rebase-20260823`, `cez/per-task-prompt-drafts`). The
  first of those is what made run `3352a1e4` refuse its own managed path and fall back to the live
  checkout — a hand-made branch in a managed namespace converts to permanent isolation loss for that
  run. Worth a guard, and worth pruning.
- `getRepoInfo` should carry its failure reason rather than returning a bare `null`, so the next
  incident of this shape is diagnosable. This spec removes the *consequence* on the workspace path;
  33 other call sites still read that `null`.

## Implementation status — 2026-08-25

Phases 1, 2 and 3 are implemented. What follows separates what was **executed** from what was
**written but not yet run**, because gates green is necessary and not sufficient and this spec's
own Verification section says so.

### What changed

**Phase 1 — no more cross-project worktrees.**

- `workflows/run.ts` — the `isWorkspaceRun` prologue branch no longer materializes anything. A
  workspace run emits *"reading every project, editing none; file work with `cez todo add
  --project <id>`"* and falls through with no worktree and no lease. `materializeWorkspaceWorktrees`
  is no longer imported. The resume path arms leases for whatever the record already carries and
  re-materializes nothing.
- **The reader stays** (`BACKWARD_COMPATIBILITY.md`): a record carrying `workspaceWorktrees` from an
  older cezar still arms its leases, still applies back on success, still discards on any other
  ending. That branch emits its own distinct note so a legacy run is legible in the transcript.
- `workspace/granted-roots.ts` — `isolated` is now **all-or-nothing** (`withWorktree === paths.size`)
  rather than `worktrees.length > 0`. That flag was the mechanism that told five concurrent prod
  runs they were isolated while they shared one live checkout. The non-isolated prompt was rewritten
  to say the paths are real, shared checkouts and that the run must not edit, create, delete,
  commit, stash, reset or push a file in any project.

**Phase 2 — `input-to-tasks` and `cez todo start`.**

- `workflows/types.ts` — `INPUT_TO_TASKS_WORKFLOW`, three steps (`context`, `file`, `dispatch`).
  **No step is given `Edit` or `Write`**, so "it does not touch your files" is a property of the
  tool grant, not a request in a prompt. `file` files without `--start`; `dispatch` reads
  `{{autoStart}}` and calls `cez todo start <id> --project <id>`.

  > **CORRECTED 2026-08-25, same day — the dispatch step does not actually start anything for most
  > projects, and this spec shipped believing it did.** `cez todo start` sets `autostart: true` and
  > nothing else; `todo-cli.ts`'s own docblock says so explicitly, and the run only happens because
  > the *running cockpit's* `todos.json` watcher notices the flag. `server.ts` arms that watcher
  > (`watchTodoAutostart`, ~line 1737) for the boot context, for contexts already built, and via
  > `onContextBuilt` — and project contexts are **lazy**, built on first API touch. So a registered
  > project nobody has opened since the last restart has no watcher on its `todos.json`.
  >
  > `dispatch` files into every project the workspace run touched, which is precisely the set most
  > likely to be cold. The tick is written, nothing reads it, and the failure is silent in both
  > directions: the todo carries the flag and no run appears. Todo `503195a8` had already
  > established the same residency gap for the *reopen* inbox by inotify against the production
  > server PID (workspace and cezar watched, `chat` not) — the two watchers are twins with one root
  > cause, which is why neither was noticed from the other.
  >
  > **This is not hypothetical and not fixed by anything in this spec.** Filed as todo `f09bf585`
  > (high) and being fixed together with `503195a8` by run `1f5aa96e` — spec
  > `.ai/specs/2026-08-25-lazy-project-watchers.md`, a cold-intent discovery service that watches the
  > two intent paths for non-resident projects and builds a context only where a pending flag
  > actually exists (no eager boot-time builds, no directory created as a side effect).
  >
  > **Until that lands, treat the Start filed tasks toggle as filing correctly and starting
  > nothing** for any project that is not already resident. Nothing in the verification below
  > catches this: every test builds the context it asserts against, so the defect is invisible to
  > exactly the tests written for the feature — the condition under test is the one production
  > supplies and the fixture never does.
- `workflows/run.ts` — `applyTemplate` renders `{{autoStart}}`, read from the **record** rather than
  the input so a resume answers identically.
- `todo-cli.ts` — `cezar todo start <id> [--project] [--json]`. Accepts an id prefix, errors on an
  ambiguous one, refuses an archived, tombstoned or already-started todo. `todos.ts`'s
  `UpdateTodoPatch` gained `autostart?: true`.
- `runs/store.ts` + `contract/workspace-run-start.ts` — optional `autoStart`. The route defaults
  `workflow` to `input-to-tasks` when the caller names neither a workflow nor steps.

**Phase 3 — composer.**

- Scope already defaults to Workspace on every generic entry point (`?scope=auto`), and an explicit
  link to one project's composer still means that project — that was left alone deliberately.
- `workflowsForScope` filters the catalog to `input-to-tasks` at workspace scope, and the **same**
  filtered list feeds `resolveSource`, so a draft still naming `spec-to-deploy` resolves to nothing
  and the server defaults rather than quietly running the old workflow with no control on screen.
- A **Start filed tasks** chip, workspace scope only, default off, deliberately *not* persisted in
  the draft — it is the one control whose leftover `true` would start unattended agents in several
  repos on a submit the user thought was a plain one. Off means the key is **absent** from the body,
  so the default submission stays byte-identical to what an older cockpit sends.
- `composerRunModeNote`'s workspace line was **corrected**: it read *"your real checkouts are
  modified directly, with no worktree"*, which was true of the defect and is false of the fix.

**Docs.** `README.md` (new "Workspace scope routes work" paragraph + the breaking note),
`CHANGELOG.md` (Breaking + Added under Unreleased), and `BACKWARD_COMPATIBILITY.md` §118, whose
description of the route was corrected in place with the superseded text kept below it.

### Verification — executed

- **V3 (the grant is honest)** — `workspace/granted-roots.test.ts`, 22 pass. Covers the
**SUPERSEDED 2026-08-29 by 2026-08-25-composer-dispatch-mode.md:** The V4/V5 verification below
describes the prior prompt-level no-op. It is retained as the historical record, while the new
spec verifies the frozen two-step or three-step plan and the filed-todo receipt.

  partially-isolated case (the exact prod defect, and the assertion that fails under the old
  `worktrees.length > 0`), the fully-isolated legacy case so the change is a narrowing rather than a
  blanket `false`, and the `brand` shape: every granted path is a registry root verbatim, never a
  path synthesized from a neighbour's worktree.
- **V4/V5 (filing, and dispatch genuinely optional)** — `workflows/load.test.ts` (catalog entry, no
  `Edit`/`Write` on any step, files without `--start`, repo override still works);
  `todo-cli.test.ts` `describe('start')`, 6 cases; `workflows/auto-start-template.test.ts`, 3 cases
  asserting `{{autoStart}}` renders `true`/`false`/`false`-when-absent **at the spawn spec**.
  Mutation-checked: deleting the `{{autoStart}}` replacement turns all three red, and `load.test.ts`
  alone stays green — it proves the token is in the prompt, which is true whether or not anything
  replaces it.
- **V6 (compatibility)** — `runs/store.test.ts`, new `describe`: a legacy record parses entry for
  entry and survives a load → update → flush round-trip with `workspaceWorktrees` unchanged; a new
  record omits `autoStart` entirely rather than writing `false`.
- **The route** — `server/workspace-run-routes.test.ts`, 5 new cases (14 total). Both of this
  route's new behaviours were invisible to every pre-existing case in that file: `resolveWorkflow`
  is stubbed, so the workflow NAME the route asks for was never inspected, and `autoStart` simply
  rode along in the input object. The new cases record what `resolveWorkflow` was asked for and
  assert the `input-to-tasks` default, that a named workflow still wins (a default, not a
  restriction — rejecting a name that worked yesterday would be breaking), that an inline `steps`
  chain gets no workflow name injected alongside it, and that `autoStart` passes through as
  `undefined`/`true`/`false` — three distinct answers, because a record has to say what was *asked
  for* or the optional dispatch step doing nothing reads as a step that failed. A non-boolean
  `autoStart` 400s rather than arriving as a truthy value. Mutation-checked: removing the default
  and removing the passthrough each turn exactly the case written for it red, and nothing else.
- **Composer** — `new-task-form.test.ts` (`workflowsForScope` including the empty-not-fallback case,
  `buildWorkspaceRunBody` autoStart), `new-task-draft.test.ts` (both workspace lines, and autoStart
  changing nothing outside workspace scope), `new-task-project.test.tsx` (the picker at both scopes,
  the chip's absence at project scope, the posted body in both directions). Mutation-checked: a
  filter that keeps everything, and an `autoStart` key always sent, each turn a *different* test
  red.
- **Full web suite** — 186 files, 4108 tests, all pass.
- **Typecheck** — `tsc --noEmit` on the contract and server projects: clean. The web project sits at
  its **pre-existing** 8 errors, all in `api/client.ts`, none in any file this change touches
  (proven with a `git stash` control: same count, same locations).
- **Tests rewritten because the behaviour they pinned was deliberately removed**, each with the
  reason in place: `workflows/boot-root-isolation.test.ts` (change C now asserts the adopted grant
  puts the run on the routing path and cuts nothing, on the record and on disk),
  `workflows/workspace-parallel.test.ts` (a failing workspace run leaves no worktree AND no branch,
  where it used to assert the branch survived), `workflows/workspace-grant-wiring.test.ts` (the
  prompt must say "do NOT edit", not the weaker "do NOT commit"), `new-task-project.test.tsx` and
  `new-task-draft.test.ts` (the corrected header line).

### Verification — NOT executed

- **V1/V2** — the end-to-end worktree-count negative control and its mutation proof need a real
  twelve-project workspace. Not run. The unit-level equivalents above are not a substitute for it.
- **V7 (gates on the box, twice)** — **EXECUTED 2026-08-25, and it earned its keep.** Deferred at
  first because the box was carrying four concurrent runs; run once it was idle (load 0.51, one
  run). `npm run typecheck` **exit 0** across all four projects, then `npm run test` twice on the
  identical tree at `dc64b741`: **11853 passed, 1 failed, both times, the same test** — a red that
  did *not* move, which is the signature of a deterministic failure rather than the flake pool.

  The failure was **real and introduced by this change**: `upstream purity (spec Verification #10,
  whole tree)` in `notifications/transports/webhook.test.ts` scans every file under
  `packages/{cezar,web}/src` and flagged `workflows/run.ts`, because the Phase 1 comment cited the
  absolute production path it was measured on, and that path spells the workspace name. The rule
  exempts exactly one spelling — the fork's own `@loki-labs/cezar-plus*` specifier, **stripped**
  before the scan rather than pattern-matched, so a bare mention in prose still fails. cezar is
  published; the hazard is a coding cockpit quoting a neighbouring product's paths into a tool that
  knows nothing about them. Fixed comment-only in `7e82ce10` (the evidence — five concurrent runs,
  same live checkout, grants 0–106 s apart — survives the rewording). Re-run on the box at
  `7e82ce10`: **11854 passed, 0 failed, 630 files, exit 0.**

  **Why every Mac gate missed it, worth carrying:** the local sweeps were scoped to
  `workflows/ workspace/ runs/ todo-cli todos`, `notes/ automations/ scheduling/` and the full web
  suite. This test is in `notifications/`, so no sweep ever loaded it. A new file or a new comment
  reddens *shared, whole-tree* gates that its own suite has no reason to run — narrow briefs leave
  the real gate unrun, and twenty greens read exactly like coverage.

  **Note for the next session:** the box's `npm run typecheck` exits 0 on **all four** projects,
  including `web`. The Mac reports 8 errors in `web`'s `api/client.ts`, called "pre-existing" here
  and proven pre-existing with a `git stash` control. Both observations stand; the discrepancy is
  environmental and unexplained, and it means "web has 8 pre-existing errors" is a fact about the
  Mac, not about the tree. Worth resolving before anyone trusts either number.

  The earlier local runs are kept below for the record.

  What was run locally, and what it shows: sweeps over `workflows/ workspace/ runs/ todo-cli todos`
  (1520/1524) **twice**, plus `notes/ automations/ scheduling/` and the CLI-wiring suites
  (147/150). Every red falls into one of two already-known pools, and each was attributed with a
  control rather than assumed:
  - **`fs.watch` timeouts on a loaded Mac** — `todos.test.ts` (3) and `todo-autostart.test.ts` (3).
    `todo-autostart` is directly downstream of this change's `todos.ts` edit, so it was checked
    against a **stashed clean tree**: the identical 3 cases fail there too.
  - **Load-sensitive flakes** — `run.test.ts`'s native-Codex `requestUserInput` case and
    `resume-missing-session.test.ts` (c). Both *moved* between two runs of the identical tree, which
    is the signature of a flake pool rather than a broken test; one run naming a file proves
    nothing.

  None of the four failures this change originally introduced in `workflows/ workspace/ runs/`
  remains.
- **V8 (runtime E2E on production)** — **the OFF path is EXECUTED and PASSED on a real production
  run, 2026-08-25 12:20 UTC.** Not staged by this session: a genuine composer submit
  (`author.via = "workspace-composer"`) picked up `input-to-tasks` as the workspace default.

  Run `ed71bbd9`, workspace project, created 12:20:34, `done` 12:22:25. **`workspaceWorktrees: 0`**
  against **13 granted projects** — the property this whole spec exists for, measured on the record
  of a run nobody instrumented. All three steps green: `context` 12:20:46, `file` 12:21:55,
  `dispatch` 12:22:25. It filed todo `1da9c2bb` ("Split tasks into sortable Active and Backlog
  tables") onto the **cezar** board at 12:21:49, matching the submitted request — so the route
  works end to end: read every project, write one project's `todos.json`, touch no working tree.
  `autoStart` was absent on the record (toggle off), the filed todo carries `autostart: false`, and
  `dispatch` started nothing — the optional step being genuinely optional, in production.

  **The ON path is still unverified, and is known broken** for non-resident projects — see the
  correction under Phase 2. A green OFF path says nothing about it: they are different branches of
  the `dispatch` prompt, and the defect lives downstream of both, in who reads the flag.

  What remains unverified: the *screen* (below), and auto-start ON.

### Verification — executed ON PRODUCTION (2026-08-25, release `20260825T104007Z-dc64b741`)

Shipped as `dc64b741` on `origin/main`, deployed blue-green to `prod-host`, 95 ms cutover.

The deploy printed `deploy: not inside cezar.service's cgroup — the restart cannot reach this
process`, which is the "new CLI tree, old resident server" shape — a deploy that reads like a whole
one while the running process still serves the old code. So the running process was asked directly
rather than the symlink believed:

- **The process serves the new sha.** `GET /api/v1/ready` → `releaseId 20260825T104007Z-dc64b741`,
  `sha dc64b741…`, `dirty:false`, `activatedAt 10:40:13Z`; `cezar.service`
  `ExecMainStartTimestamp` matches, so the restart did happen.
- **The loader serves the workflow.** `loadWorkflows('/var/lib/cezar/loki-labs')` on the live dist
  returns `input-to-tasks (built-in)` alongside the four pre-existing ones.
**SUPERSEDED 2026-08-29 by 2026-08-25-composer-dispatch-mode.md:** This historical production
check predates the frozen plan. Its `dispatch` token assertion remains a record of the old
definition, but OFF runs now omit that step and ON runs receive the filed-todo ledger.

- **No step can write, on the live definition.** Every step's `allowedTools` read off the deployed
  module: `context`/`file` = `Read,Grep,Glob,Bash`, `dispatch` = `Read,Bash`; zero write tools.
  **With a control:** the same check run against `spec-to-deploy` reports `Write,Edit`, so it is
  capable of failing. `dispatch` carries `{{autoStart}}`.
- **The route defaults.** The compiled line is present verbatim:
  `body.workflow ?? (body.steps === undefined ? INPUT_TO_TASKS_NAME : undefined)`, and the
  `autoStart` passthrough alongside it.
- **The worktree call is gone.** The only `materializeWorkspaceWorktrees` occurrence in the live
  `workflows/run.js` is the comment explaining its removal; the new note string is present.
- **The CLI has the subcommand.** `cezar todo start <id> [--project] [--json]` on the box.
- **The composer is the served bundle.** `auto-start-toggle` and `Start filed tasks` are in
  `assets/index-Dxwbz0Xv.js`, which is the entry the server actually serves; the corrected note
  ships and the old `"real checkouts are modified directly"` string is **absent** (0 matches).
  `input-to-tasks` rides in the code-split `author-cell` chunk.

**Still not executed, and what keeps this QA Needed:** nobody has *driven the screen*. That the
picker offers only `input-to-tasks` at workspace scope, and that ticking **Start filed tasks**
reaches the run, are asserted in `new-task-project.test.tsx` and proven present in the bundle, but
not clicked in a browser against production — and an API-level check cannot verify a UI control
(a curl cannot see a screen). No workspace run has been started on the live release either, so the
zero-worktree property is proven at unit level and by the absent call, not by a production run.

### Phase 4 — blocked, by design

Deleting the cross-project worktree machinery is gated on no reachable run record still carrying
`workspaceWorktrees`. It does not become unblocked by time passing; it becomes unblocked when the
drain is measured.
