# The boot root is not a git repository, so a task that lands on it runs in place, alone

> **Status:** draft — not implemented. · **Date:** 2026-08-21
> **Extends:** `.ai/specs/2026-08-19-parallel-workspace-runs-worktrees.md` (W1–W8, live and
> correct) and `.ai/specs/2026-08-20-workspace-run-worktree-isolation.md` (the five fixes that
> closed its gaps). Neither is wrong. Both assume the run carries `workspaceProjects`; this spec
> is about the runs that reach the same boot root **without** it, and about the fact that the boot
> root itself has never been a git repository.
> **Reads on:** `.ai/specs/2026-08-15-cross-project-workspace-run.md` (D2/D4/D7 — already amended
> in place by the 08-19 spec), `.ai/specs/2026-08-15-import-all-folders-as-projects.md` (D4/D5,
> the "Set up git" button whose module this reuses).

## TLDR

The owner reported seeing, on a task run in the workspace:

```
run started — workflow "spec-to-deploy" (runner: claude)
· not a git repository — running in place, one task at a time
· waiting for exclusive access to the repository working tree
```

Those two notes are real and still reachable. They are **not** the workspace-run path — that path
is healthy and was measured healthy while this spec was written. They come from a run whose home is
the boot root `/var/lib/cezar/workspace` and whose record carries **no `workspaceProjects`**. Such a
run falls into the ordinary non-git branch: it works in the boot root itself, takes the exclusive
working-tree lease, and is capped at one at a time by `pump()`.

Two independent facts have to both be true for that to happen, and today both are:

1. **`/var/lib/cezar/workspace` is not a git repository.** So there is nothing to isolate into.
2. **A run can be homed there without the workspace grant.** The grant is set in exactly one place
   (`workspace-run-routes.ts:132`); nine other `startRun` call sites never pass it.

The fix the owner asked for is exactly the fix: **make the boot root a real git repository, and
make every run that lands on it isolate into a worktree instead of running in place.**

## Problem

Everything below was measured on the prod box on 2026-08-21 from `runs.json`, the run NDJSON
transcripts and the working tree — not reasoned forward from the code.

### 1 — The boot root has no git repository

```
$ git -C /var/lib/cezar/workspace status
fatal: not a git repository (or any of the parent directories): .git

$ ls -la /var/lib/cezar/workspace
.ai/        (cezar runtime state — 47 MB of run transcripts, runs.json, spools, handoffs)
.claude/
```

It holds **no work at all**. That is by design (`2026-08-19` spec, § Problem: *"a scratch dir that
holds none of the work"*). But "holds no work" and "cannot isolate" are different claims, and only
the second one follows from being non-git — and it is the one that bites.

It is also **not in the registry**: `~/.cezar/config.json` `projects` has twelve entries and none
of them is `/var/lib/cezar/workspace`. The server appends a **synthetic** row for it anyway
(`server/server.ts:6790-6807`), with the comment *"this row exists to carry runs, not to be
displayed as a project"*. So the boot root is a project that can receive runs, and is the one
project in the workspace that can never isolate one.

### 2 — Which code the two notes come from

Both live in `workflows/run.ts`, in the `execute()` prologue, and both are in the branch taken when
the run is **not** a workspace run and the root is **not** a repo:

- `run.ts:3289` — the only definition of the predicate:
  `const isWorkspaceRun = (this.store.getRun(runId)?.workspaceProjects?.length ?? 0) > 0;`
  Read from the record and nothing else. The same expression appears at `run.ts:1142`
  (`isWorkspaceRun`), `run.ts:2754` and `run.ts:5046`.
- `run.ts:3370` — `emit({ type: 'note', message: 'not a git repository — running in place, one task at a time' })`,
  the final `else` when `repo === null`.
- `run.ts:3377-3392` — the lease. A workspace run skips it (`if (isWorkspaceRun) { /* no lease */ }`,
  spec 08-19 **W3**); anything else emits
  `'waiting for exclusive access to the repository working tree'` and `await this.acquireRepoRoot(...)`.
- `run.ts:1218` — the capacity gate in `pump()`:
  `(repo !== null || this.nonWorkspaceInPlaceBusy() < 1)`. On a non-git root, non-workspace
  in-place runs are capped at **one**, workspace-wide, regardless of `maxParallel: 5`.

So the owner's two lines are one symptom with one cause: *this run has no grant, and its home
cannot isolate.*

### 3 — It is still happening, measured, after the 08-19/08-20 fixes shipped

Grepping only genuine emitted events (`"type":"note"`, so the agent quoting the message in its own
output does not count) across all 37 boot-root transcripts in
`/var/lib/cezar/workspace/.ai/cezar/runs/`:

| run | finished | workflow | `workspaceProjects` | `workspaceWorktrees` | `not a git repository` | `exclusive access` |
|---|---|---|---|---|---|---|
| `b63f15e4` | 2026-08-21 07:14 | quick-task | 12 | 0 | 1 | 6 |
| `ae1cb6ce` | 2026-08-21 07:17 | quick-task | 12 | 0 | 1 | 2 |
| `6aa07506` | 2026-08-21 07:17 | quick-task | 12 | 0 | 1 | 1 |
| **`50ce87f1`** | **2026-08-21 13:52** | **spec-to-deploy** | **0** | **0** | **1** | **2** |

The first three were **created** 2026-08-19 17:42–20:28, before the parallel-worktree code was
live: they carry the grant (12) but produced no worktrees (0), which is the old build's signature.
They are history and need no fix.

`50ce87f1` is the live one. It was **created 2026-08-21T12:27:27Z** and its record has **no
`workspaceProjects` key at all**, plus `"worktree": false`. This run — the "one Settings area" task,
which shipped commit `00f3669f` — ran for 85 minutes in `/var/lib/cezar/workspace` itself, holding
the exclusive lease, blocking every other in-place run behind it.

The control is decisive. This spec's own run, `737eba99`, was created **43 seconds later** at
`2026-08-21T12:28:10Z`, same workflow, same box, same build:

```
737eba99  workspaceProjects: 12  workspaceWorktrees: 10
  note  loki-labs, brand, lokie-chatbox are one git repo … they share the single worktree …
  note  workspace run — 10 project worktree(s) isolated; changes apply back on finish
        (no "not a git repository", no "exclusive access")
```

Two runs 43 seconds apart, one isolated into ten worktrees and one running in place under a global
lock. **The only difference is whether the record carries the grant.**

### 4 — Nine ways to reach the boot root without the grant, and one that is deliberate

`workspaceProjects` is written in exactly one place — `server/workspace-run-routes.ts:132`,
`workspaceProjects: grant.projects`, reached only by `POST /api/v1/workspace/runs`. Every other
`startRun` caller omits it:

```
todo-autostart.ts:38            index.ts:857 (`cezar run`)      server.ts:4736 (POST /runs)
server.ts:5723                  server.ts:6511                  server.ts:6568
automations/task-template.ts:68 notes/approve.ts:129            notes/continuation.ts:107
```

Any of those bound to the **boot** manager produces exactly the `50ce87f1` shape. One more path
drops the grant on purpose — `run.ts:1064`:

```ts
// Variants never carry one: they exist to isolate, and a workspace run has nothing to isolate into.
workspaceProjects: group ? undefined : input.workspaceProjects,
```

That decision is defensible and this spec does not overturn it; it does carve it out explicitly
(§ Solution C, § Risks R4).

**What I could not determine, and am not going to invent:** which of those routes actually created
`50ce87f1`. The run record has no provenance field — its keys are
`id, title, titleSummary, workflow, task, model, modelIdentity, runner, generateFollowups,
autonomous, status, stepsUsed, declaredSpecPath, createdAt, startedAt, finishedAt, tokensUsed,
contextTokens, contextWindow, costUsd, titleOrigin, worktree, peakRssBytes, peakProcCount,
archived, seenAt, steps, workflowDef` — and nothing there records the submitting route. The fix
below is deliberately designed to be correct **whichever** route it was, and § Risks R6 names the
provenance gap as the reason this spec's verification leans on transcripts rather than records.

### 5 — The 08-19 spec's own workaround is load-bearing for the wrong reason

W3 exempted workspace runs from the non-git cap because *"both gates guard the boot scratch tree,
which a workspace run no longer edits."* True, and the exemption is right. But it left the boot
root non-git, so the exemption is the **only** thing delivering parallelism there — and it applies
to precisely the runs that carry the grant. Make the boot root a repo and `repo !== null` satisfies
the same clause structurally, for every run, grant or not.

## Solution

Three changes. None of them touches the per-project worktree model (W1–W8) — that model is right
and stays exactly as it is.

**A. The boot root becomes a git repository, at boot, idempotently.**

A new `workspace/boot-repo.ts` exporting `ensureBootRepo(bootRoot)`, called once during server
startup before any manager pumps. If `.git` exists it is a no-op and returns what it found.
Otherwise, in this order:

1. Write `.gitignore` **first**, ignoring `.ai/` and `.claude/` — before `git init`, so 47 MB of run
   transcripts, `runs.json` and spool directories are never staged, never in the object database,
   never in a commit. This is the exclusion half of `git-init.ts`'s D5 rule (*"a detected secret is
   EXCLUDED … never staged, never in the object database"*), applied to runtime state.
2. Write `README.md` — one paragraph saying what this root is (cezar's boot/scratch manager root,
   holds no project work, its `.ai/` is runtime state) and that the repo exists so tasks homed here
   can be worktree-isolated. It is also the **only** tracked content, which matters for (4).
3. `git init -b main`.
4. `git add .gitignore README.md` — an explicit two-path add, never `git add -A`. Nothing else in
   the tree is tracked or scanned.
5. Commit, with the repo-local identity `cezar <cezar@localhost>` so a host with no global
   `user.email` still succeeds.

**Step 5 is not optional, and this is the whole reason `ensureBootRepo` is not just `git init`.**
`git-init.ts:14-27` records the measured behaviour (git 2.50.1, 2026-08-15):

| repo state | `git worktree add` | worktree contents |
|---|---|---|
| `git init`, no commits | succeeds (git infers `--orphan`) | **empty — none of your files** |
| after a first commit | succeeds | your files |

An init without a commit would trade an honest "not a git repository" note for agents silently
working in an empty directory on a root `computeProbe` would then call healthy. Loud and correct,
replaced by silent and wrong.

**Why a new module rather than calling the existing `initGitRepo`.** `initGitRepo`
(`workspace/git-init.ts`, behind `POST /api/v1/projects/git-init`, `server.ts:3231`) is the
user-facing "Set up git" button. It runs `preflightGitInit` itself, walks the whole tree up to
`MAX_SCANNED_FILES` (50 000), and **refuses** on `truncated` or on any file ≥ `MAX_FILE_BYTES`.
Pointing it at a directory whose `.ai/` holds 47 MB of NDJSON means an expensive walk over content
we have already decided to ignore, and a refusal risk on a path that must never fail at boot.
`ensureBootRepo` writes the ignore file first and never scans. It cites `git-init.ts` for the
init-plus-commit rule rather than duplicating the reasoning.

**B. A run homed at the boot root never runs in place.**

With (A) in force, `repo !== null` at the boot root, so:

- `pump()`'s non-git single-slot cap (`run.ts:1218`) stops applying there **for every run**, not
  just grant-carrying ones. `nonWorkspaceInPlaceBusy()` and the W3 exemption stay — they are still
  correct for a genuinely non-git registered project — but they stop being the only thing holding
  workspace parallelism up.
- The ordinary isolated-worktree branch (`run.ts:3305`) becomes reachable at the boot root.

One gap remains: `input.worktree === false` still routes to the in-place + lease branch
(`run.ts:3305-3315`, `'worktree off — running in the repo working tree'`). So **at the boot root,
`worktree: false` is ignored** and isolation is forced, with a note that says so rather than
silently disagreeing with the request:

```
worktree forced on — this is the workspace boot root, which holds no project work;
isolating in .ai/cezar/worktrees/<runId> instead of running in place
```

This does not touch workspace runs: they are handled by the earlier `isWorkspaceRun` branch
(`run.ts:3290`) and never reach this one, so the route's unconditional `worktree: false`
(`workspace-run-routes.ts`, decision 1) keeps meaning exactly what it means today.

**C. A boot-root run with no grant adopts the workspace grant.**

This is the "always use worktrees in workspace tasks" half, at its source. In `execute()`, before
the `isWorkspaceRun` test at `run.ts:3289`: when the run's manager root is the boot root, the run
has **no** `workspaceProjects`, and it has **no** `groupId`, load the grant
(`loadWorkspaceGrant()`), persist it onto the record, and proceed down the normal workspace-run
path — ten per-project worktrees, no lease, apply-back on success.

The `groupId` carve-out is `run.ts:1064`'s decision, kept deliberately and named here so the next
reader does not think it was overlooked (§ Risks R4).

C subsumes B for every run that reaches the boot root through a route that forgot the grant, which
is the `50ce87f1` case and the owner's report. B is still needed on its own, for a run that
genuinely belongs to the boot root and asked for `worktree: false`, and as the floor if the
registry read in C fails.

## Architecture

```
server boot
  └─ ensureBootRepo(bootRoot)                          ← NEW (A), idempotent, before any pump
       .gitignore (.ai/, .claude/) → git init -b main → add 2 paths → commit
       result: repo !== null at the boot root, tracked content = { .gitignore, README.md }

pump()  run.ts:1218
  (repo !== null || nonWorkspaceInPlaceBusy() < 1)     ← now satisfied by repo !== null (A)

execute()  run.ts:~3286
  ├─ if bootRoot && !workspaceProjects && !groupId:    ← NEW (C)
  │     grant = await loadWorkspaceGrant()
  │     store.updateRun(runId, { workspaceProjects: grant.projects })
  ├─ isWorkspaceRun ?  → materializeWorkspaceWorktrees(...)          [unchanged, W1–W8]
  ├─ repo && worktree===false ?
  │     └─ if root === bootRoot: FORCE isolation + note              ← NEW (B)
  │        else:                  in place + lease                   [unchanged]
  ├─ repo ? → createWorktree(repoRoot, runId, base)                  [unchanged]
  └─ else  → 'not a git repository — running in place, one task at a time'
              ^ now unreachable for the boot root; still correct for a
                registered non-git project, which is what it was written for

settle
  boot-root worktree at .ai/cezar/worktrees/<runId> is `run.worktreePath`, so the EXISTING
  reclaimer (runs/retention.ts:112) already covers it — nothing new to build, see § Verification V6
```

`createWorktree` puts it at `join(canonicalPath(repoRoot), WORKTREES_DIR, runId)`
(`git-worktree.ts:153`) — i.e. `/var/lib/cezar/workspace/.ai/cezar/worktrees/<runId>`, inside the
directory `.gitignore` excludes. That is the same arrangement every registered project already
uses, and cezar's own `.gitignore` sets the precedent with a bare `.ai/cezar/`.

## Data models and API contracts

**No contract change, and that is deliberate.** No new field on `runRecordSchema`, no new route, no
new config key.

- (A) is a filesystem effect at boot with no representation on the wire.
- (B) changes which branch `execute()` takes; the existing `worktreePath` / `branch` / `baseBranch`
  fields already describe the outcome.
- (C) writes `workspaceProjects` — an existing, already-persisted field
  (`runs/store.ts:345`, `store.ts:684`) — through the existing `updateRun`. A run fixed by C is
  indistinguishable on the wire from one submitted through `POST /workspace/runs`, which is the
  point: `server.ts:6717` and `workspace/run-index.ts:129` both derive the cockpit's `workspace:
  true` flag from `workspaceProjects.length > 0`, so such a run will now also *render* as the
  workspace run it behaves as.

The only new module surface:

```ts
// workspace/boot-repo.ts
export interface BootRepoOutcome {
  path: string;
  /** 'existing' = there was already a .git; 'created' = this call made it. */
  state: 'existing' | 'created';
  branch: string;
  /** The first commit's sha when state==='created'; the current HEAD otherwise. */
  commit: string;
  /** Written into .gitignore. Present only when state==='created'. */
  ignored: string[];
}
export function ensureBootRepo(bootRoot: string): Promise<BootRepoOutcome | { error: string }>;
```

It **never throws** — a boot-time failure degrades to today's behaviour (a note, in-place, one at a
time) rather than refusing to start the server. That matches the house rule in AGENTS.md's git
section: *"Helpers never throw (except `createWorktree`) — degradation is the caller's policy."*

## Phases

Each phase is shippable on its own and leaves the tree green.

**Phase 1 — `ensureBootRepo` (change A).** New `workspace/boot-repo.ts` + `boot-repo.test.ts` +
the single boot call site. Ships alone and, by itself, removes the `not a git repository` note and
the non-git one-at-a-time cap for the boot root. Nothing else changes behaviour.

**Phase 2 — Force isolation at the boot root (change B).** The `worktree: false` override in
`execute()` plus its note, and the seam test. Depends on Phase 1 being live (without a repo there
is nothing to force).

**Phase 3 — Grant adoption (change C).** The pre-`isWorkspaceRun` grant load, the `groupId`
carve-out, and its tests. Independent of Phase 2 in code; both must land before the owner's report
is fully answered.

**Phase 4 — The record.** `AGENTS.md` git/worktree row (line 215) gains the boot-root rule;
`server/workspace-run-routes.ts`'s header comment gains a fourth bullet saying the boot root is now
a repo and why; a `supersede`/`upsert` proposal appended to `CEZ_KB_WRITE_FILE` recording the
decision. Documentation only.

**Phase 5 — Deploy and prove it on the box.** § Verification V5–V7. cezar ships to itself
(AGENTS.md line 12); a backend change SIGKILLs the deploying session and restart-continuation
resumes it — expected, survivable, not a reason to defer.

## Risks

**R1 — Committing 47 MB of runtime state.** The failure mode of a careless `git init` here is a
first commit containing every run transcript, `runs.json` and every `.handoff.md`. *Mitigation:*
`.gitignore` is written **before** `git init`, and the add is an explicit two-path add, never
`git add -A`. V1 asserts the tracked file count is exactly 2.

**R2 — Secrets in the boot root.** `.claude/` may hold credentials. *Mitigation:* it is in
`.gitignore` alongside `.ai/`, and only two named paths are ever staged. V1 asserts nothing else is
tracked even when the fixture contains an `.env`.

**R3 — An agent's cwd becomes a near-empty worktree.** After Phase 2/3, a boot-root run's
`state.cwd` is a worktree containing only `.gitignore` and `README.md`. For the boot root that is
honest — there was never any project content there — but it changes what relative paths resolve to
for an agent that assumed otherwise. *Mitigation:* the forced-isolation note names the real boot
root, and the `README.md` in the worktree explains where the work is. Every workspace task already
works by absolute path (the run prompt grants absolute worktree paths), so this is a change in the
empty case only.

**R4 — Overriding a deliberate decision for variants.** `run.ts:1064` drops the grant for group
variants on purpose. C respects that by excluding `groupId`. The consequence is that a ×2/×3
variant submitted at the boot root still lands on Phase 2's forced isolation, not on ten per-project
worktrees — which is the intended reading of that comment, not an oversight.

**R5 — `CEZ_HANDOFF_FILE` / `CEZ_KB_WRITE_FILE` are absolute paths into the real boot root.** They
point at `/var/lib/cezar/workspace/.ai/cezar/runs/<runId>.handoff.md` — outside the worktree, and
correctly so, since the record must survive the worktree's removal. *Risk:* some code derives them
from `state.cwd` rather than from the manager root, in which case Phase 2 silently relocates them
into a directory that is later deleted. **This must be checked before Phase 2 ships** — V4.

**R6 — No provenance on the record.** Because no run record says which route created it, this
spec cannot prove which call site produced `50ce87f1`, and verification of the fix has to read
transcripts (V7) rather than query records. Adding a provenance field is out of scope here; it is
worth its own task and is filed as one.

**R7 — Self-deploying box.** Phase 5 restarts the service that is running the task doing the
deploying. Expected per AGENTS.md line 12 and
`.ai/specs/2026-08-20-chain-integrity-restart-and-continuation.md`. If `package.json` /
`package-lock.json` change, a `dist`-only swap is insufficient — install into `/opt/cezar` too.

**R8 — In-flight runs during the boot-repo creation.** `ensureBootRepo` runs at startup before any
manager pumps, so no run can be mid-flight in the boot root when `.git` appears. A run recovered
from `runs.json` after the restart re-enters `execute()` and takes the new branch — which is the
desired outcome, not a hazard.

## Verification

Planned before implementation, as the definition of done. Gates green is necessary and **not
sufficient**: the defect this spec fixes was invisible to every existing unit test, and the closest
prior fix (`2026-08-20-workspace-run-worktree-isolation.md`) shipped with its runtime E2E never run.
V5–V7 are the ones that actually settle it.

**V1 — `ensureBootRepo` unit (`workspace/boot-repo.test.ts`).** Against a temp dir seeded with
`.ai/cezar/runs/big.ndjson` (≥ 1 MB), `.claude/settings.json` and a `.env`:
- `ensureBootRepo(dir)` returns `state: 'created'`;
- `git -C dir ls-files` prints **exactly** `.gitignore` and `README.md` — asserts R1 and R2;
- `git -C dir rev-list --count HEAD` is `1` — asserts the commit exists;
- a second call returns `state: 'existing'` and creates no second commit — asserts idempotency;
- with `HOME` pointed at an empty dir (no global `user.email`), the commit still succeeds.

**V2 — The empty-worktree trap, asserted not assumed.** In the same fixture,
`git -C dir worktree add .ai/cezar/worktrees/t HEAD` and assert the new tree contains `README.md`.
This is the one measured claim from `git-init.ts` that the whole design rests on; it gets a test of
its own rather than a citation.

**V3 — `execute()` seam tests.** Mirroring the existing `workflows/run-isolation.test.ts:75` /
`run-lease.test.ts` pattern:
- boot root + non-workspace run + `worktree: false` → `worktreePath` is set and **no** note
  contains `exclusive access` (Phase 2);
- boot root + no `workspaceProjects` + no `groupId` → the record gains `workspaceProjects` and
  `workspaceWorktrees` is non-empty (Phase 3);
- boot root + `groupId` set → grant is **not** adopted (R4);
- a registered **non-git** project still emits `not a git repository — running in place, one task at
  a time` and still takes the lease — the message keeps working where it was meant to.

**V4 — Handoff-path audit (R5).** Before Phase 2 ships:
`grep -rn "CEZ_HANDOFF_FILE\|CEZ_KB_WRITE_FILE" packages/cezar/src` and confirm every producer
derives the path from the manager/boot root, not from `state.cwd`. Record the result in the spec. If
any derives from `state.cwd`, that is a blocking sub-task, not a footnote.

**V5 — Full gates.** From the repo root: `true && npm run lint && true`, plus
`npm run test:package`. Any red is quoted verbatim in the handoff, and a pre-existing red is proven
pre-existing by a control run at clean `origin/main` before it is dismissed.

**V6 — Retention actually reclaims the new trees.** After a boot-root run finishes, assert
`run.worktreePath` is set on its record and that `runs/retention.ts:112`'s keep-last-N reclaims it
and stamps `reclaimedAt`. This is a **check that no new code is needed**, not a build step — if it
fails, Phase 5 grows a sub-phase.

**V7 — Runtime E2E on the prod box, the one that settles it.** After deploy:

```bash
# a. the repo exists, is clean, and tracks only two files
git -C /var/lib/cezar/workspace status --porcelain     # → empty
git -C /var/lib/cezar/workspace ls-files               # → .gitignore, README.md

# b. submit a task to the boot project row (the path that produced 50ce87f1),
#    then read ITS transcript — genuine note events only, not agent text
f=/var/lib/cezar/workspace/.ai/cezar/runs/<newRunId>.ndjson
grep -c '"type":"note".*not a git repository — running in place'          "$f"   # → 0
grep -c '"type":"note".*waiting for exclusive access to the repository'   "$f"   # → 0
grep -c '"type":"note".*project worktree(s) isolated'                     "$f"   # → 1

# c. no regression across every run created after the deploy
for f in /var/lib/cezar/workspace/.ai/cezar/runs/*.ndjson; do
  grep -l '"type":"note".*not a git repository — running in place' "$f"
done                                                                             # → only the four historical runs

# d. parallelism: submit two boot-root tasks at once; both reach `running`,
#    neither logs `exclusive access`, and their startedAt values overlap
```

The `50ce87f1` transcript is the before-picture for (b) and stays on disk as the control.

**Definition of done.** V1–V6 green **and** V7 executed on the box with its output pasted into the
handoff. Until V7 has run this is "qa needed", not done — stated plainly, not rounded up.
