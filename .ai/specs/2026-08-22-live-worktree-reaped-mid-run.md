# A live task's worktree is deleted out from under it, mid-run, with its uncommitted work

**Status:** implemented and merged to `origin/main`, **not yet deployed**. **CORRECTED
2026-08-23T00:31Z (task `b34867ee`, final round):** the paragraph below described an intermediate
state — `362865ec`/`a3e70792` was live in production for a window on 2026-08-22, but that build still
had the fail-open gap review pass 7 found (a missing stamp plus `--allow-stale-artifact` skipped B1
entirely), the `runContinuation` lease gap, and zero automated coverage for gates 5–9b/12. A second
implement pass fixed all three, added 15 tests (`release-deploy.test.ts` +14 covering A2/B1 end to
end, `run.test.ts` +1 for the lease-continuation fix), and found and fixed a real latent bug while
doing it: the Q3 staleness pathspec `packages/*/src` never matched anything recursively (git glob
does not cross `/`), so the mtime gate could never fire for any source edit — fixed to
`packages/*/src/**`. That round shipped as `32379c34`, merged to `origin/main` as `1688a407` via PR
[#4](https://github.com/MarcinWalendowski/cezar/pull/4) at 2026-08-23T00:31Z. `origin/main`'s tip is
now `1688a407`. **Production has not redeployed since**: the live release is still
`20260823T001331Z-b885e11b` (unrelated work, activated 00:13:39Z, ~15 minutes *before* `1688a407`
merged), so the fixes described in this spec are merged but not running. That live sha **is a clean
ancestor** of `1688a407` (`git merge-base --is-ancestor b885e11b 1688a407` exits 0) — the divergent
state the paragraph below warned about was specific to the now-superseded `a81a0a30` release and
does **not** apply to the next deploy attempt; a forward deploy from `origin/main` today is an
ordinary descendant case, no re-anchor needed. **QA Needed**, for two reasons: the deploy itself
hasn't happened yet, and even after it does, the runtime E2E (Verification steps 13–19) has never
run anywhere. Known accepted gap, not blocking: the `git-worktree.ts` `branch -D` argv spy and the
C1a negative controls have no test DI seam for the internal git runner and remain manual-review-only
(git-worktree.test.ts:527's `['branch','-D',…]` line is a fixture setup, not the spy).

Original status line, describing the state after the *first* implement pass only, left for the
paper trail: *"implemented, merged to `origin/main`, and deployed. Measured 2026-08-22 23:5xZ on
`prod-host`: the live release is `20260822T232351Z-a81a0a30` (activated 23:23:56Z), and its
`dist/` carries both `leaseDeclineReason` and a valid `.build-stamp.json` — so the gates below are
not merely merged, they are the code running in production right now. QA Needed: the runtime E2E
(Verification steps 13–19) has still never run anywhere, and, as a direct consequence of B1 being
live, every forward deploy from this box is currently refused as divergent — see the re-anchor
precondition at the head of "## Verification" before attempting one."* **Date:** 2026-08-22.

**Amended 2026-08-22 (second pass, task `b34867ee`; no separate brief was written for this pass, and
the earlier draft's citation of one was wrong: the run's only brief is
`.ai/specs/briefs/2026-08-22-stale-artifact-live-prune.md`, cited in the first amendment below, and
this pass re-read the merged tree directly rather than a brief):** the code this spec
describes has since been **written, gate-tested and merged**: commit `362865ec`, merged to
`origin/main` as `a3e70792`. See **"As shipped"** below for what landed per phase (re-verified by
reading the merged tree, not by trusting the commit message), the two corrections applied *after*
the last review pass, and the three residues that re-read turned up. Nothing in the diagnosis or the
design below changed; what changed is that this is no longer a proposal, so the reader's job is now
to verify and finish it, not to build it.

**Amended 2026-08-22** (task `b34867ee`, brief `.ai/specs/briefs/2026-08-22-stale-artifact-live-prune.md`):
re-read against `origin/main` at `c1ccbe79`, citations corrected to the shipped source, and the nine
open design questions the first draft left open are now **settled** in "Decisions settled" below.
Nothing in the diagnosis changed; what changed is that this is now buildable without further
judgement calls. **Severity:** data loss, recurring, four confirmed incidents in one day on
`prod-host`.

**Read against, and current as of, these exact sources.** Every line number below is
`origin/main@c1ccbe79`, not this task's checkout (`2778fd52`, which predates the ownership fix and
therefore still shows the pre-incident code):
`packages/cezar/src/git-worktree.ts` (664 lines), `.../workspace/workspace-worktrees.ts` (327),
`.../index.ts` (1342), `.../server/project-context.ts` (542),
`.../server-install/release-deploy.ts` (486), `.../server-install/release-cli.ts` (335),
`.../server-install/releases.ts` (256), `.../server/runtime-info.ts` (81),
`.../runs/worktree-ownership.ts`, `package.json`, `packages/cezar/package.json`,
`packages/web/vite.config.ts`, `.ai/deploy-targets.json`.

**Which means every line number in Problem / Solution / Decisions settled is a PRE-implementation
citation** — it points at the code as it was before `362865ec`, which is correct for reading the
diagnosis and wrong for finding the code today. The **post**-implementation citations, re-read at
`a3e70792` (`git-worktree.ts` now 722 lines, `release-deploy.ts` 613, `project-context.ts` 552,
`releases.ts` 258, `runtime-info.ts` 127), are collected in "As shipped" below and are the ones to
follow when you are looking for the shipped mechanism rather than the bug it replaced.

**Extends:** `.ai/specs/2026-08-22-cross-project-worktree-orphan-prune-safety.md` (Layers 1 and 2,
shipped `5ffa383c` 07:58:54Z today). That spec closed the *cross-project blindness* in
`pruneOrphans`. This one closes the three things it did not: the prune is still **fail-open**, still
**destroys uncommitted work**, and still **writes no record of what it deleted** — and, separately,
the deploy path can put a build *without* those layers back into production while stamping it with a
commit that has them.

**Related, distinct:** `.ai/specs/2026-08-22-brokered-run-survive-bluegreen-cutover.md` (the run
*process* across a cutover), `.ai/specs/2026-08-22-spool-exit-cross-talk.md`. Both are about the
agent surviving; this is about the **directory it is standing in**.

---

## TLDR

Between **13:11:37Z and 13:17:59Z today** production ran release `20260822T131126Z-504ce87f`. That
release is stamped with sha `504ce87f` and marked `"healthy": true` in
`/opt/cezar-releases/deploy.json`, and `504ce87f` contains the orphan-prune safety fix. **The
`dist/` inside it does not.** Its `packages/cezar/dist/git-worktree.js` was built at **07:48:29Z**,
ten minutes before the fix commit landed at 07:58:54Z, and
`packages/cezar/dist/runs/worktree-ownership.js` is absent from the tree entirely.

`stage()` (`packages/cezar/src/server-install/release-deploy.ts:132-166`) is a bare
`rsync -a --delete` of the source checkout. **It never builds.** The release id, `deploy.json.sha`,
`GET /api/v1/ready`'s `deploy.sha`, and both probes in `.ai/deploy-targets.json` all derive the sha
from `git rev-parse HEAD` of the *source checkout*. Nothing anywhere reads the artifact. So a
worktree that merged `origin/main` and deployed without rebuilding shipped six-hour-old bytes under
a current label, and every gate went green.

For those six minutes production ran the pre-fix `pruneOrphans(repoRoot, validIds)` — no ownership
check, no ancestry gate. At **13:12:02Z** it built the `cezar` project context and swept
`/var/lib/cezar/loki-labs/cezar/.ai/cezar/worktrees/`, force-deleting every live workspace run's
directory **and** its `cez/<id8>` branch. Run `eb9f65aa` was `running` at the time, with a `vitest`
process executing inside that tree and an untracked spec file in it. Nothing was logged: the
per-project prune call site logs `declined` and never logs `removed`.

Four specs were reconstructed from context today because of this
(`a30cf07d`, `53d22c7e` "reconstructed after a **fourth** worktree reap", plus two rescued into
`.ai/cezar/runs/<id>.spec-rescue.md`). The agent for `eb9f65aa` has since given up on its managed
worktree and is working out of `/tmp/cez-eb9f65aa-work`.

**Why concurrency is the trigger, exactly as reported.** Every task self-deploys, every deploy
restarts the service, and every restart re-runs the destructive sweep across *every registered
project*. Ten restarts today. With N concurrent workspace tasks, each task's deploy sweeps the
other N-1 tasks' live trees. One task deploying a stale artifact disarms the guard protecting all
the others.

The fix is in two independent halves, and **neither depends on the other**:

- **Kill the trigger.** The artifact must say what it is. A build stamp inside `dist/`, a deploy
  that refuses to ship an artifact whose stamp disagrees with the source HEAD, and a relation gate
  that no-ops when the incoming tree is already contained in the live one and refuses when the two
  have diverged.
- **Kill the weapon.** A destructive sweep must fail *closed*: autosave before deleting, never
  delete the recovery branch, decline anything holding a fresh lease, and log every removal. Then
  even a stale build cannot cause unrecoverable loss.

---

## Problem

### P1 — the deploy ships an artifact it never built and never inspects

`stage()` is `rsync -a --delete` from `--source` to the release dir, excluding `.git`,
`.ai/cezar/runs`, `.ai/cezar/worktrees`, `.ai/cezar/tmp`. There is no build step anywhere in the
deploy path: `grep -n "npm run\|tsc\b" packages/cezar/src/server-install/*.ts` (excluding tests)
returns **nothing at all**.

`AGENTS.md` already says so, in prose: *"**Build first** — `stage` is an rsync, not a build, so a
stale `dist/` ships old bytes under a new label."* That instruction is correct and it did not hold.
A rule that depends on an agent remembering to run one command before another is not a guard; the
fleet ran it ten times today and got it wrong once, which was enough.

Measured, per release directory (`grep -c "still owned by workspace run" <rel>/packages/cezar/dist/git-worktree.js`):

| release | stamped sha | `dist/` built | has the fix |
|---|---|---|---|
| `20260822T122351Z-fb325ff8` | fb325ff8 | 12:23:02Z | yes |
| `20260822T124742Z-ff06ecc7` | ff06ecc7 | 12:46:55Z | yes |
| `20260822T124854Z-ff06ecc7` | ff06ecc7 | 12:48:34Z | yes |
| **`20260822T131126Z-504ce87f`** | **504ce87f** | **07:48:29Z** | **NO** |
| `20260822T131749Z-504ce87f` | 504ce87f | 13:17:28Z | yes |

### P2 — every deploy verification reads the same sha, from the wrong side

`deploy.json`, the in-band `deploy` field on `/api/v1/ready`, and both `.ai/deploy-targets.json`
probes all trace back to `git rev-parse HEAD` in the deploying checkout. The backend probe's own
comment reasons carefully about a *concurrent* task deploying a **later** commit and accepts HEAD
being an ancestor of live — but the whole chain is blind to the artifact by construction, so a
stale `dist/` cannot fail any of them. The 13:11 deploy passed every gate and was recorded
`"healthy": true`.

### P3 — nothing refuses a backwards deploy

With N tasks deploying their own HEADs, activating a tree the live one already contains silently
reverts whatever landed since, and activating a **divergent** tree (a `cez/<id8>` tip that never
merged what another task landed) drops those commits without anything noticing. There is no
relation check of any kind before the symlink flip. `--rollback` exists and is the honest way to go
backwards; nothing makes it the only way, and nothing at all covers the divergent case, which is
the more common one on a box where every task deploys its own branch.

### P4 — `pruneOrphans` deletes uncommitted work

`pruneOrphans` (`packages/cezar/src/git-worktree.ts:622-663`) removes a candidate with
`removeWorktree(...)` → `git worktree remove --force` + `rm -rf` + `git branch -D` when a branch is
passed (`git-worktree.ts:242-251`, the delete itself at `:250`).
**No `autosaveCommit` first.** It is right there at `git-worktree.ts:323`, and this is the one
destructive path in the file that does not call it. Its sibling on the run-ending path,
`discardWorkspaceWorktrees` (`packages/cezar/src/workspace/workspace-worktrees.ts:295-327`), gets
this right: it autosaves (`:306`), keeps the directory on `refused`/`failed` (`:308-313`), and calls
`removeWorktree` with **no branch argument** so the branch survives (`:315`). The prune path never
learned that discipline, so untracked files, a spec being drafted, an unstaged fix, are gone with
no recovery point.

Pre-fix, it also passed the branch to `removeWorktree`, so `git branch -D cez/<id8>` destroyed the
one artifact a continuation could re-materialize from. Layer 2 of the predecessor spec keeps the
branch unless ancestry proves it merged (`git-worktree.ts:657-660`: `keepBranch` is false exactly
when `isAncestorOf(branch, trunkRef)` says the branch is fully merged). That is right as far as it
goes, and it is still a `branch -D` reachable from a sweep. It should simply be unconditional on
this path: **`pruneOrphans` stops passing a branch at all**, the way `:315` already does.

### P5 — the removal is invisible where it matters

`index.ts:740` logs `cleaned N orphaned worktree(s)` for the **boot** project, and `:743` logs
`declined to reclaim …`. `project-context.ts:460-475` calls the same `pruneOrphans` but logs **only**
`declined` (`:468-474`), never `removed`. Workspace worktrees live in **project** repos, so the only
call site that touches them writes nothing when it deletes. Attributing today's incident took an
hour of forensics on mtimes and reflogs because the destructive event left no trace.

Corollary: `journalctl | grep -i reap` returning nothing is not evidence that nothing was reaped.
The absence of a log line here is unprovable, which is its own defect.

### P6 — ownership is a cold snapshot, and it is fail-open

`findForeignWorkspaceOwner` (`packages/cezar/src/runs/worktree-ownership.ts:93-113`) answers "is
this live?" by cold-reading every *other* registered project's `runs.json` at context-build time
(`loadForeignWorkspaceRunSources`, `:52-68`), plus the workspace boot root's. It is a genuine
improvement and it holds where it applies, the `unreadable` signal (`:70-78`) is even routed into a
whole-boot decline (`git-worktree.ts:589-613`, acted on at `:641-644`). Three ways it is still
weaker than it looks:

1. **Unknown means delete.** A candidate no source claims is removed (`git-worktree.ts:657-661`).
   `unreadable` is handled; *absent* is not, and the two are the same evidentially. The safe default
   for an irreversible sweep is the opposite.
2. **It cannot see a different boot root.** A second cezar server reaches the same real project
   roots with its own boot root. **Historical observation, at the 13:12Z incident:** one was alive
   on the box then —
   `node packages/cezar/dist/index.js --port 43037 --repo /var/lib/cezar/loki-labs/cezar/.ai/cezar/worktrees/fd1f214d-…`,
   up since 2026-08-21 21:40. Its ownership view could never include production's boot root.
   **That process is gone as of 2026-08-22 23:5xZ**: `ps -eo pid,lstart,args | grep
   cezar/dist/index.js` now shows exactly one cezar, pid 373697, started 23:23:55, running
   `/opt/cezar/packages/cezar/dist/index.js serve`. The structural weakness is unchanged — nothing
   *prevents* a second `--repo <worktree>` server, and P3's lease is the only guard that would
   survive one — but do not read this bullet as a claim about the box's current process list.
3. **It ignores the filesystem's own evidence.** `eb9f65aa`'s tree had three live `vitest` processes
   running inside it when it was swept. A directory a process is standing in is not an orphan, and
   nothing asks.

### P7 — the sweep runs at the worst possible moment

It runs during boot, per project, before `recover()` has finished re-materializing and re-claiming
anything: `index.ts:732` prunes, `:758` recovers; `project-context.ts:460` prunes **inside
`build()`**, `:479` recovers. Its purpose is **disk reclamation**, which has no deadline at all.
Running it seconds after a restart buys nothing and costs exactly the race that fires here.

Worse on the project path than on the boot path: `build()` is called lazily by *any read* that
touches a project, so an ordinary API request is a sufficient trigger for an irreversible sweep of
that project's repo.

---

## Solution

Two independent halves. Ship P0 first; it converts data loss into recoverable inconvenience and
depends on nothing else in this spec.

### Half A — the artifact is self-describing, and the deploy checks it

**A1. Build stamp.** The root `npm run build` gains a final step that writes
`packages/cezar/dist/.build-stamp.json`:

```json
{ "sha": "<git rev-parse HEAD>", "builtAt": "<ISO>", "dirty": true, "version": "0.10.0", "stampVersion": 1 }
```

Settled in "Decisions settled" Q1–Q3: **which** command writes it and when, what `dirty` means,
and which files "newer than the build" is measured against.

**A2. The deploy refuses a stale artifact.** The stamp is read at the **top of `runReleaseDeploy`
(`release-deploy.ts:299`), before `makeReleaseId` at `:309` and before `decideReExec` at `:314`**,
and `server-deploy` refuses, non-zero with a named reason, when any of the conditions below hold.

That placement is load-bearing and is **not** "before `stage()`". `release-deploy.ts:132` is
`defaultHost.stage`, the effect *implementation*, reached only from `runGatedDeploy`
(`deploy-strategy.ts:125`), which this function does not call until `:417`. Two things break if the
gate lands there. First, A3 requires `makeReleaseId` to be called with `stamp.sha`, and that call
happens at `:309-311` off `options.sha`, long before any staging. Second, `decideReExec` runs at
`:314` and the detached-handoff branch returns at `:344-368` with `detachedUnit` set;
`release-cli.ts:80-85` then prints "Deploy is running outside this process" and **`return 0`
unconditionally**, so any refusal raised after `:344` would reach the caller as exit 0 — fatal for
E2E steps 15b and 16, which both assert a non-zero exit. (On `prod-host` today `decideReExec`
returns false because the unit's `KillMode=process`, so the bug would be latent rather than visible;
the spec must not depend on that.) Reading the stamp at `:299` means the resolved `stamp.sha` feeds
the release id and every A2 refusal returns `{ ok: false, error }` from the launcher process itself.

Under `--dry-run` (the short-circuit at `:335-342`) the gates still **evaluate and print their
verdict**, but they do not change the exit code: a dry run stays a preview and never fails a build.

The refusals:

- the stamp is **missing** → `"<source>/packages/cezar/dist/.build-stamp.json is absent, run npm run build first"`;
- the stamp is **unreadable or fails its schema** → refuse; never fall back to an assumed HEAD;
- `stamp.sha !== <source HEAD>` → names both shas and the command that fixes it. This is the
  incident: `504ce87f` staged with a `dist/` built at `07:48:29Z` from an earlier commit;
- any **tracked** file under `packages/*/src` (plus each package's `package.json`, `tsconfig*.json`
  and `vite.config.ts`) has an mtime later than `stamp.builtAt` (Q3);
- a `--sha=` was supplied and disagrees with `stamp.sha` (Q4).

`stamp.dirty === true` is **recorded and logged, not refused** (see Q2, which reverses this spec's
first draft).

Escape hatch: `--allow-stale-artifact`, which logs loudly and records `"stale": true` on the ledger
entry. **Fail closed:** every unresolvable input above is a refusal.

**A3. The release id and the ledger come from the stamp, not from HEAD.** `makeReleaseId`
(`releases.ts:110`) is called with `stamp.sha`; `ReleaseEntry.sha` (`release-deploy.ts:400-406`) is
`stamp.sha`; `ReleaseEntry.builtAt` becomes `stamp.builtAt` rather than `fx.now()` (deploy time),
which is the field that would have made the incident visible in `deploy.json` at a glance. The
in-band `deploy` field (`runtime-info.ts:61-79`) therefore reports the artifact's identity with no
change to `currentRelease` itself, it already just echoes the ledger, and the ledger becomes
honest underneath it.

Today the default is the opposite: `release-cli.ts:72` fills `sha` from `gitSha(opts.source)`
(`:324`, a bare `git rev-parse HEAD`), which is precisely the source-side value that cannot see the
artifact. That call site changes to supply `sourceHead`, used **only** for the A2 comparison.

After this, "the running server is serving this HEAD" is a claim about the running code, which is
what both probes in `.ai/deploy-targets.json` already believe they are asserting.

### Half B — no silent backwards deploy

**B1. The gate is four-valued, and "behind" is not the same as "sideways".** The relation gate runs
in `runReleaseDeploy` **before `runGatedDeploy` is called (`release-deploy.ts:417`), and before the
free-space check at `:392` and the `ReleaseEntry` construction at `:400`** — i.e. alongside the A2
gate above, before `decideReExec` at `:314`, and for the same exit-code reason. It relates the
incoming stamp sha to the live sha.

"Before the symlink flip" would be too late: `runGatedDeploy` rsyncs the release tree at
`deploy-strategy.ts:125` and **writes a ledger row** at `:126-127`, both *before* `flipSymlink` at
`:149`. A gate placed there would already have staged a release directory and appended to
`deploy.json`, contradicting this section's own "does not flip the symlink, restart the service, or
write a ledger row" and E2E step 15's "no new row in `jq '.releases[-1].id'`".

Two `git merge-base --is-ancestor` probes are needed, not one, because a single probe cannot tell
*behind* from *diverged*, and those two cases have opposite correct answers:

| relation of incoming to live | outcome | why |
|---|---|---|
| **descendant** of live (`live` is an ancestor of `incoming`, they differ) | **proceed** | ordinary forward deploy |
| **equal** | **proceed** | re-deploy of the same tree, e.g. after a config change |
| **strict ancestor** of live | **exit 0, no-op** | everything in this tree is already running |
| **divergent** (neither is an ancestor of the other) | **refuse** | this tree is missing commits that are live |
| either sha **unresolvable** in the source repo | **refuse** | fail closed |

The strict-ancestor case is deliberately **not a failure**. `.ai/deploy-targets.json`'s backend
probe already decided this, in its `CORRECTED AGAIN 2026-08-21 (2) EXACT EQUALITY ON A SHARED BOX`
note: *"HEAD being an ANCESTOR of the live sha is now green … everything at HEAD is in the running
process."* Turning the same condition into a non-zero exit here would contradict a current
decision, and it would do real harm: the deploy step is an **agent** step, and an agent handed
"refused, use `--rollback`" for a case whose correct action is *do nothing* would roll production
backwards, which is the exact harm this section exists to prevent. So the no-op prints

```
already live: <live> contains <incoming>, nothing to deploy
```

exits 0, and does **not** flip the symlink, restart the service, or write a ledger row. It does not
mention `--rollback` at all.

The divergent case is the one P3 actually names, and it is the one the current code waves through:
a task deploying its own unmerged `cez/<id8>` tip ships a tree that lacks whatever another task
landed on `main` in the meantime. `git merge-base --is-ancestor <incoming> <live>` exits non-zero
for *both* "ahead" and "sideways", so a single-probe gate cannot see it. The refusal names what
would be lost:

```
refusing: <incoming> is divergent from the live sha <live>.
live has commits this tree does not: <git log --oneline <incoming>..<live>>
merge the live sha <live> — it is in this repo's object db even when it is not on
origin/main — or pass --allow-unrelated.
```

**CORRECTED 2026-08-22 (review pass 5): the last line used to read *"deploy from a tree that merged
`origin/main`, or pass `--allow-unrelated`"*, and that advice is false on this box.** It is also the
line an agent will act on, so it is the one part of this section that can itself cause a bad deploy.
Measured 23:5xZ: the live sha `a81a0a30` is a merge commit on `cez/f28edef5`, and **neither**
`git merge-base --is-ancestor a81a0a30 origin/main` nor `git merge-base --is-ancestor origin/main
a81a0a30` exits 0. A tree that merges `origin/main` therefore stays `divergent` from live, because
live never landed on `main` under that sha; merging `origin/main` cannot make a tree a descendant
of a commit that is not on `origin/main`. The correct instruction names the **live sha itself** as
the merge target — releases here are deployed from `cez/<id8>` tips, and those tips are pushed, so
the live commit is reachable in this repo's object db even though no branch on `main` contains it.
**The shipped string at `release-deploy.ts:430` still carries the old wording and must be updated to
match this block** (it is a one-line template change; the `divergent`/`unresolved` logic around it
is correct as shipped).

**The steady state this produces, which is a property of the concurrency model and not a bug in
B1.** Every task self-deploys from its own `cez/<id8>` tip. When that tip is the live sha and the
same work later lands on `main` as a *different* commit — a squash, a rebase, or (as here) a merge
commit that only ever existed on the task branch — then **every other task's forward deploy is
`divergent` until one deploy re-anchors `live` onto a commit that is reachable from `main`.** So the
gate does not fail once; it fails for every concurrent task, in a fleet where ten deploys a day is
normal. That is the cost of the gate being correct, and it is paid until someone re-anchors.
Re-anchoring is a deliberate operator act, not an automatic one: either merge the live sha into the
deploying tree (which makes the next deploy an honest `descendant`) or deploy once with
`--allow-unrelated`, having read the live-only commit list the refusal prints.

**The `spec-to-deploy` deploy step must NOT pass `--allow-unrelated` on its own.** Decided here so
the next implementer does not "fix" a red deploy step by adding the flag: an agent that force-
deploys past a divergence discards, unreviewed, exactly the commits the refusal just listed, which
is the harm P3 names. The deploy step's correct behaviour on `divergent` is to **refuse, surface the
live-only commit list, and stop**, leaving the re-anchor to a human decision recorded per the
procedure in "## Verification". Passing the flag is reserved for that explicit act, and per the Data
models section below it now leaves a trace on the ledger.

Overrides, and they are not interchangeable: **`--allow-unrelated`** forces through a divergent or
an unresolvable-sha deploy; **`--rollback`** (already `ReleaseDeployOptions.rollback`,
`release-cli.ts:34-35`) stays what it is today, the deliberate way to go *backwards*, and is only
relevant to the strict-ancestor case when the operator genuinely wants the older tree activated
rather than the no-op.

**CORRECTED 2026-08-22 after review:** both the artifact gate and the relation gate are forward
deploy gates. An explicit `--rollback` bypasses both and activates the already-staged release;
requiring the source checkout to carry a fresh matching build stamp during recovery would make the
rollback path unusable by definition.

Resolving the *live* sha is the subtle half and is settled in Q5, `loadLedger`
(`releases.ts:122-136`) degrades an unreadable ledger to an **empty** one, so it cannot be asked
this question directly without turning a corrupt `deploy.json` into a silent "first deploy, go
ahead".

Reuse `isAncestorOf` (`git-worktree.ts:578-582`) rather than a second `merge-base` wrapper, but not
its boolean: it already returns `false` on any non-clean answer, which is the fail-safe direction
*there* and the fail-**open** direction here. So each of the two probes must distinguish "proved
ancestor" from "could not tell", and the gate resolves to one of the five rows above, refusing on
`divergent` and on `unresolved`.

**B2.** Every outcome prints the live sha and the incoming sha. A *refusal* (divergent, or
unresolvable) names `--allow-unrelated`. The strict-ancestor *no-op* names neither override; it is
a success and the correct operator response is to stop. Forward deploys and genuine rollbacks are
unaffected. Concurrency note: with N tasks deploying their own HEADs the ancestor branch of this
gate will fire routinely, and each time it does the honest answer is "your code is already
running", exactly what the backend probe in `.ai/deploy-targets.json` reports as green for the
same condition.

### Half C — the sweep fails closed

**C1. Autosave before deleting; keep the directory if the autosave does not commit.** In
`pruneOrphans`, before `removeWorktree`, call `autosaveCommit(worktreePath, 'run finalize')`
(`git-worktree.ts:323`). On `refused` or `failed`, push a `kept` outcome and **do not delete**,
byte-for-byte the discipline of `discardWorkspaceWorktrees` (`workspace-worktrees.ts:306-313`).
Every untracked byte then reaches the `cez/<id8>` branch before the directory goes.

**C1a. Confirm the candidate is its own worktree root before autosaving it, or the autosave
commits the parent repo.** This is not a nicety, it is a correctness precondition, and getting it
wrong turns P0 from a safety fix into a second data-integrity bug.

A prune candidate is *any* directory under `.ai/cezar/worktrees/`: `pruneOrphans` builds its
candidate list from a bare `readdir` (`git-worktree.ts:630`, filtered at `:637`) and filters only on
`entry.isDirectory()` and `validIds`. It is not necessarily a git worktree: a `mkdir`'d leftover, an
interrupted `rm -rf`, or a tree whose `.git` file was deleted all qualify. And `.ai/cezar/` is
gitignored but still *inside* the repo, so for such a candidate `git` walks **up** and resolves to
the parent checkout. Measured on this box: with cwd inside such a directory, `git status
--porcelain` reports the parent checkout's modified files, and `git add -A && git commit` writes a
real `cezar autosave (run finalize)` commit containing the parent repo's unrelated uncommitted work
onto its current branch. Every checkout here routinely carries uncommitted spec and handoff files,
so an unguarded C1 would commit them, unasked, to the production `cezar` checkout. The E2E's own
step 17 creates exactly this shape.

So, before any autosave, the candidate must be proved to be a worktree root **of its own**:

- `git -C <worktreePath> rev-parse --show-toplevel` must succeed **and** canonicalize to
  `worktreePath` itself, **and** must not equal `repoRoot`; equivalently, the candidate appears in
  `registeredWorktrees(repoRoot)` (`git-worktree.ts:95`, currently module-private, so either export
  it or use the `--show-toplevel` form; the implementer picks one and uses it in both places).
- When the proof fails for any reason, `autosaveCommit` is **not invoked at all**. Record
  `autosave: 'nothing-to-do'` and proceed to `removeWorktree`. A directory with no git state of its
  own has no branch to save to, and nothing to lose by being removed.
- Stated explicitly, because it is the whole point of C1a: **`autosaveCommit` is never invoked on a
  path whose toplevel is the parent repo.**

This is also the path the E2E's genuine-orphan control depends on (step 17): a plain directory must
still be removed, and must still be logged. If C1a wrongly routed it into `kept`, that control would
never go green and the reclaim path would silently stop working.

`PruneOrphansReport` (`git-worktree.ts:584-587`) grows a third bucket, `kept: { id, reason }[]`,
rather than folding these into `declined`: a decline is "I did not judge this an orphan", a keep is
"I judged it an orphan and could not make it safe to delete". They need different operator
responses, and collapsing them would make the E2E's genuine-orphan control unfalsifiable.

**C2. Never delete the branch on the prune path.** Remove `pruneOrphans`'s branch argument entirely
`keepBranch`/`isAncestorOf` at `git-worktree.ts:657-660` and the `branch` parameter at `:660` both
go, and the call becomes `removeWorktree(repoRoot, worktreePath)` exactly as
`workspace-worktrees.ts:315` already does. A branch is bytes; it is the only thing a continuation
can re-materialize from. Deliberate branch deletion stays with retention.

**CORRECTED 2026-08-22:** an earlier draft of this paragraph said `isAncestorOf` is **kept**, because
B1 uses it. It does not. B1 shipped as its own five-valued `gitRelation`
(`release-deploy.ts:120-128`), which calls `git merge-base --is-ancestor` directly, and
`grep -rn isAncestorOf packages/*/src` at `a3e70792` returns only its own definition
(`git-worktree.ts:578`) and one stale doc comment (`:662`). It therefore has **no caller at all**
and is deleted — see *What is still open* #3.

**C3. Liveness lease, next to the thing it protects.** The owning server writes
`<repoRoot>/.ai/cezar/worktree-leases/<runId>.json` when it materializes a worktree, and re-stamps
it on a heartbeat while the run is live:

```json
{ "runId": "...", "ownerBootRoot": "/var/lib/cezar/workspace", "ownerPid": 3066180,
  "ownerReleaseId": "20260822T131749Z-504ce87f", "heartbeatAt": "<ISO>", "leaseVersion": 1 }
```

`pruneOrphans` declines any candidate whose lease heartbeat is younger than `LEASE_STALE_MS`,
**and declines on an unreadable, truncated or schema-failing lease**. This moves the authority off
cross-project bookkeeping and onto the repo that owns the directory, so it holds for a pruner with a
different boot root, a second server, or any process that can read the filesystem. Leases live
**outside** `worktrees/` on purpose: a directory inside it would be a prune candidate to any build
that predates this spec. Write point, heartbeat cadence, what counts as proof, and the deletion
point are settled in Q6.

**The lease check is never opt-in.** The lease directory **defaults to
`join(repoRoot, '.ai/cezar/worktree-leases')` and is never derived from the caller's presence or
absence**; the `leaseDir` option exists only as a test seam to point at a fixture, and **omitting it
must never skip the check**. This is called out because the surrounding file's established
convention runs the other way — `git-worktree.ts:652-656` documents that `opts` entirely omitted
"reproduces today's unconditional delete-both" — so an implementer following that convention would
naturally read a missing `leaseDir` as "no lease check". That would make the one guard that survives
a foreign boot root opt-in, silently disarming the sweep for every call site not updated, which is
the exact fail-open this spec exists to close. The **only** path that skips the check remains the one
stated in verification step 11: a lease directory that does not exist at all behaves as today, so a
repo that predates P3 is unaffected.

**C4. Log every removal, and make the log line provable.** `project-context.ts` logs `removed` in
the exact shape `index.ts:740` already uses. Three sinks, because the journal alone is what failed
during this incident's forensics, see Q8 for why a `.jsonl` is needed and not just a `console.log`.

**C5. Defer the sweep past boot.** Run the per-project prune on a timer `SWEEP_DELAY_MS` (5 min)
after the context is built, not inline with `build()` (`project-context.ts:460`). `recover()`
(`:479`) has re-materialized and re-leased by then. Disk reclamation has no deadline; the boot race
is pure downside. Timer ownership, `unref`, cancellation and dedup are settled in Q7. The boot
sweep (`index.ts:732`) moves behind the same delay for the same reason.

---

## Decisions settled

The first draft of this spec left nine design questions open. Implementation is blocked on each of
them, so each is answered here. Every answer names the code it is answering against.

### Q1: which command writes the stamp, and at what point

Root `package.json:17` is `build:server && build:web && check:pack`. `build:web` is a vite build
whose `outDir` is **`packages/cezar/web/dist`** (`packages/web/vite.config.ts`, `build.outDir`), i.e.
*inside the server package*, because the CLI serves it. So there are two output trees and one
package, and the stamp must attest to both.

- **Path:** `packages/cezar/dist/.build-stamp.json`. The server `dist/` is the authoritative
  location because it is what everything else anchors on: `smokeBootRelease` boots
  `<release>/packages/cezar/dist/index.js` (`release-deploy.ts:201`), and the backend probe in
  `.ai/deploy-targets.json` tests the same path.
- **Written by:** a new `scripts/write-build-stamp.mjs`, run as a new final root step:
  `"build": "npm run build:server && npm run build:web && npm run check:pack && npm run build:stamp"`.
  Last, so a present stamp means *every* output tree finished.
- **Written how:** tmp + `rename`, the atomic-write pattern `saveLedger` already uses
  (`saveLedger`, `releases.ts:138-146`). A half-written stamp is an A2 refusal, which is the safe side, but there
  is no reason to create the case.
- **Invalidation is mandatory and is the non-obvious half.** `pretypecheck` (root `package.json:35`)
  runs `build:server` **alone**, so a typecheck would otherwise leave last week's whole-build stamp
  sitting on top of a freshly rebuilt partial `dist/`. Therefore `build:server` and `build:web` each
  **delete** `packages/cezar/dist/.build-stamp.json` before they run. "Stamp present" then means
  exactly "a complete `npm run build` completed after the last partial build", which is the only
  claim A2 can safely rest on.

### Q2: what `dirty` means, and what it does

`dirty` is `git status --porcelain` in the source checkout being **non-empty at the moment the stamp
is written**, i.e. at build *end*, not build start. End is the strictly stronger reading: it
catches a source edit made *during* the build, which is the case a start-of-build read would call
clean and ship.

**Policy: record, do not refuse.** This reverses the draft's `--allow-dirty` refusal. On this box an
agent deploys from a task worktree that routinely carries an uncommitted spec file or handoff note;
a gate that refuses every dirty tree would refuse most legitimate deploys and would be switched off
within a day, taking the mismatch and staleness gates (the ones that actually catch the incident)
with it. So `dirty: true` is written to the stamp, copied to the ledger entry, printed as a warning
line, and `--refuse-dirty` opts into strictness for anyone who wants it. A dirty tree whose stamp
sha still equals HEAD and whose sources are older than `builtAt` genuinely *did* build the bytes
being shipped.

### Q3: what "older than `packages/*/src`" is measured against

The candidate set is **tracked files only**, enumerated with `git ls-files -z --` over
`packages/*/src`, `packages/*/package.json`, `packages/*/tsconfig*.json` and
`packages/*/vite.config.ts`. Tracked-only is what keeps `node_modules`, `dist`, agent scratch and
untracked drafts from tripping a gate they say nothing about. `packages/web/src` is inside the glob,
so the web bundle is covered by the same check.

- **Comparison:** stale iff `max(mtimeMs) > Date.parse(stamp.builtAt) + STAMP_MTIME_GRACE_MS`, with
  `STAMP_MTIME_GRACE_MS = 1000`. The grace absorbs ms-vs-ns truncation between `statSync` and an ISO
  string; equal timestamps are therefore *not* stale.
- **Deleted sources** are deliberately **not** detected by mtime, `git ls-files` cannot list what is
  gone, and leaning on parent-directory mtimes is unreliable across filesystems. A commit that
  deletes a source file moves HEAD, so the `stamp.sha !== HEAD` check catches it. Stated so nobody
  later reads the mtime scan as complete on its own.
- **Cost:** ~1500 `stat` calls on this repo, once per deploy. Not worth optimizing.

### Q4: what happens to `--sha`

**Kept, demoted to a cross-check.** It cannot be removed: `reExecCommand` (`release-deploy.ts:430`)
rebuilds its own argv including `--sha=` so the transient unit and its launcher agree on the release
identity, and dropping it would change that handoff.

New semantics: `--sha` supplied and equal to `stamp.sha` ⇒ proceed. Supplied and different ⇒
**refuse**, naming both. Omitted ⇒ the stamp is the answer. What goes away is
`release-cli.ts:72`'s default `sha: gitSha(opts.source)`, the source HEAD moves to a separate
`sourceHead` option consumed only by A2's comparison, so no code path can quietly reintroduce a
source-derived identity.

### Q5: how the live sha is resolved for B1, and the ledger trap

In order:

1. `loadLedger(releasesDir).releases.find(r => r.id === ledger.current)?.sha`.
2. ~~If that entry exists but carries no `sha` (the schema makes it optional at `releases.ts:46`, for
   hand-staged trees), read the **live artifact's own stamp** through the symlink:
   `<linkPath>/packages/cezar/dist/.build-stamp.json`. Same principle as the rest of the spec: ask
   the artifact.~~ **CORRECTED 2026-08-22 (review pass 5): step 2 was never shipped, and it is
   hereby dropped rather than left standing as unbuilt work that reads as built.** `liveSha`
   (`release-deploy.ts:129-142`) returns `{ error: '<path> does not identify the live artifact
   sha' }` for exactly this case and B1 refuses on it. The shipped behaviour is therefore
   fail-closed, which is the safe direction and is consistent with every other unresolvable-sha
   path in the gate. Deciding it *as shipped* rather than implementing the fallback: a ledger entry
   with no `sha` means a hand-staged release, i.e. a tree that already bypassed the build path, and
   inferring its provenance from a stamp inside it would let a hand-staged artifact silently
   re-acquire the authority the stamp exists to confer. The operator who hand-staged it is the
   right person to type `--allow-unrelated`, and after the Data models change above that override
   is now recorded on the ledger. **Do not implement step 2.**
3. Otherwise **refuse**, with `--allow-unrelated` as the named way through.

**The trap:** `loadLedger` degrades a missing *and* an unreadable ledger to `freshLedger()`
(`releases.ts:122-136`), "the house pattern", and correct for its other callers. For a
delete-authorization gate it is fail-open: a corrupt `deploy.json` would read as "nothing deployed
yet, any deploy is forward". So B1 first asks whether `deploy.json` **exists and is non-empty**,
exactly the way `isNonEmptyIndexFile` (`worktree-ownership.ts:75-82`) distinguishes "no `runs.json`" from "a `runs.json` I
could not parse". Absent ⇒ genuinely a first deploy ⇒ allow. Present but yielding an empty ledger ⇒
refuse. `loadLedger` itself is not changed; a second, narrower read is added beside it.

### Q6: lease schema, lifecycle and what counts as proof

- **Write point:** the same place `persist` is already invoked (`workspace-worktrees.ts:144`), after
  each `createWorktree` succeeds. That hook exists precisely because the window between "directory
  on disk" and "record written" is where the previous incident lived
  (`.ai/specs/2026-08-22-cross-project-worktree-orphan-prune-safety.md`), so the lease inherits that
  ordering guarantee instead of inventing a second one. Ordinary single-repo task worktrees get a
  lease from `createWorktree` (`git-worktree.ts:139`) on the same terms. *(As shipped the lease for
  an ordinary task worktree is written by the caller immediately after that call, at `run.ts:4189`,
  not inside `createWorktree` — same ordering guarantee, one frame out.)*
- **Heartbeat:** its own timer at `LEASE_HEARTBEAT_MS = 90_000`, matching `AUTOSAVE_INTERVAL_MS`
  (`workflows/run.ts:204`) for cadence but **not** sharing its arming. The periodic autosave is
  opt-in behind `CEZ_AUTOSAVE=1` (`run.ts:211`); a lease that only exists when autosave is enabled
  would be worse than no lease at all, because it would look like a guard.
- **Who arms it:** the run manager in `workflows/run.ts`, in the same place it already arms the
  autosave timer, and it arms **unconditionally**. The new `workspace/worktree-lease.ts` module owns
  the file format and the `write`/`touch`/`remove`/`read` primitives and owns **no** timer; the
  manager owns the interval, `unref()`s it, and clears it on the same settle path that removes the
  lease. One interval per run, not per leased repo: a single tick re-stamps every lease that run
  holds, so a run with ten granted repos still costs one timer. Putting the timer in the lease
  module instead would give a short-lived CLI process a live handle it never settles.
- **Staleness:** `LEASE_STALE_MS = 15 * 60_000`, ten missed beats. Overridable via
  `CEZ_LEASE_STALE_MS` so tests do not sleep.
- **What is proof:** `heartbeatAt` freshness, and only that. `ownerPid`, `ownerBootRoot` and
  `ownerReleaseId` are **diagnostic**, written so a human reading a declined-reap can tell which
  process holds the tree. A pid-liveness check is explicitly rejected: pids mean nothing across boot
  roots, containers or a restart, and consulting one would reintroduce exactly the fail-open this
  spec exists to close.
- **Deletion:** on clean settle, beside `discardWorkspaceWorktrees` (`run.ts:5666`) and wherever a
  run's worktrees are applied and released. A leaked lease is *not* a leak forever: it expires after
  `LEASE_STALE_MS`, and that expiry is the bounded route to genuine-orphan reclamation.
- **Across a restart. CORRECTED 2026-08-22 (third amendment): this holds only for the resume paths
  that funnel through `execute()`, and NOT for a continuation.** As shipped, `reviveQueuedRun`,
  `reenterChain` and `reattachBrokeredRun` (`run.ts:2012` → `execute` at `:4021`) do re-materialize
  and re-arm — `armWorktreeLeases` at `:4125` for the workspace case, lease written at `:4189` and
  armed at `:4204` for the single-repo case. But **`runContinuation` (`run.ts:3370`) does not**: its
  single-repo branch (`:3411-3414`) reuses `record.worktreePath` with no `writeWorktreeLease` and no
  `armWorktreeLeases` anywhere in the method, and its workspace branch arms only inside
  `if (live.length === 0)` (`:3424`, arming at `:3438`), i.e. only when the trees had to be rebuilt.
  Since `dropActive` (`run.ts:2297-2299`) **deletes** the lease files when a run settles, a continued
  run — the most common way work resumes on this box — occupies a live worktree with **no lease at
  all**, which leaves the fail-open `findForeignOwner` snapshot as the only guard and reproduces the
  incident's own shape. The fix and its coverage are item 2 of "What is still open". Original text,
  left unchanged: *"`manager.recover()` re-arms the heartbeat for every resumed run. Between process
  death and recovery the lease is present but ageing, which declines the sweep, the safe side, for
  at most `LEASE_STALE_MS`."*

### Q7: how the deferred sweep is scheduled

**One `setTimeout` per `ProjectContext`, held on the context, `unref()`d, cleared in `teardown()`.**

- `unref()` because a 5-minute timer that keeps `node` alive would turn every CLI read of a project
  into a process that will not exit.
- Cancellation: `teardown()` (`project-context.ts:503-508`) is already the single path both
  `dispose(projectId)` (`:376`) and `disposeAll()` (`:387`) run through, and it is already what the
  half-built-context `catch` calls. Clearing there means no new cancellation path is introduced.
- Dedup: `build()` is memoized per project id by the context cache, so one live context is one
  timer. A context rebuilt after `dispose` legitimately gets a fresh one.
- `SWEEP_DELAY_MS = 5 * 60_000`, overridable by `CEZ_SWEEP_DELAY_MS` (tests set it to 0).
- The sweep is also skipped outright if the context was disposed while the timer was pending:
  checked at fire time, not only at schedule time.

**The boot sweep in `index.ts:732` is deferred the same way, and that has a consequence worth
stating rather than discovering.** With an `unref`'d 5-minute timer, a short-lived CLI process
(anything that boots the project and exits well inside five minutes) **never sweeps the boot repo at
all**. That is intended: reclamation is not a CLI's job, it belongs to the long-lived
`cezar serve` process, and an `unref`'d timer that fires in a process about to exit would either
hold it open or run a destructive sweep during shutdown. The consequence is that orphan reclamation
on the boot root now happens only in a server that lives past `SWEEP_DELAY_MS`. Disk reclamation
has no deadline, so this is an acceptable trade and not a regression to fix later; it is recorded
here so a reader who notices a CLI run leaving orphans behind knows it is by design. `CEZ_SWEEP_DELAY_MS=0`
restores inline behaviour for anyone who wants it (tests do).

### Q8: where a removal is recorded when no run owns it

Three sinks, in increasing durability:

1. `console.log` from `project-context.ts`, the exact shape of `index.ts:740`. This is the literal
   acceptance criterion.
2. A **run event** when the removed id matches a run in this project's own store, so a reap shows up
   in the cockpit rather than only in the journal.
3. For the case that has no run to attach to, which is *both* the genuine-orphan case and the
   incident's case, one appended line to `<repoRoot>/.ai/cezar/worktree-reaps.jsonl`:
   `{ at, runId, repoRoot, outcome: "removed"|"kept"|"declined", reason, autosave, branchKept: true }`.

Sink 3 is not redundant with sink 1. Attributing this incident took an hour precisely because the
only record would have been journald, which rotates and is not repo-local; a reader looking at a
repo six weeks later has nothing. The file is append-only, never read by the runtime, and is one
line per reap, bounded by how often trees are reclaimed, which is rare by construction.

### Q9: how the regression proves it fails without the fix

The risk named in the brief is real: a naive test could pass on `origin/main` merely because
`5ffa383c`'s foreign-owner check declines, proving nothing about C1/C2.

- **Prune half:** the tests pass `validIds: new Set()` **and** `findForeignOwner: () => undefined`
  **and** no `ownershipCheckUnavailable`, every pre-existing signal set to "delete this". Against
  `c1ccbe79` that is exactly the path at `git-worktree.ts:657-661`, which deletes. The new tests are
  therefore red on current origin by construction, not by a missing ownership match. Pin it: run the
  new test file against a stash of the implementation and record the failure in the PR body.
- **Branch-delete half:** spy on the git runner and assert the argv `['branch', '-D', …]` never
  appears. Asserting "the branch still exists" is not equivalent, an unmerged branch survives
  `keepBranch` today for the wrong reason, so that assertion is green on origin and proves nothing.
- **Deploy half:** there is no stamp code on origin at all, so "red before the fix" cannot mean
  "this test compiles and fails". The honest controls are the *positive* ones: stamp `== ` HEAD
  proceeds (the gate is not always-refuse), and `deploy.json.sha === stamp.sha` while
  `stamp.sha !== gitSha(source)`, an assertion that is false under `release-cli.ts:72` today and is
  the single line that makes the ledger honest.

---

## Architecture

```
  deploy                                   sweep
  ──────                                   ─────
  npm run build ─► dist/.build-stamp.json   pruneOrphans(repoRoot, validIds, opts)
        │              { sha, builtAt }            │
        ▼                                          ├─ candidate not in validIds
  server-deploy                                    ├─ fresh lease?        ──► DECLINE  (C3)
        ├─ read stamp from --source                ├─ unreadable lease?   ──► DECLINE  (C3)
        ├─ stamp.sha == HEAD?     ──no──► REFUSE   ├─ foreign owner?      ──► DECLINE  (Layer 1)
        ├─ src newer than stamp?  ──yes─► REFUSE   ├─ autosaveCommit()
        ├─ relate to live sha (B1):               │     not its own worktree root?     (C1a)
        │    descendant/equal ──► proceed          │        ──► skip autosave, remove
        │    strict ancestor  ──► EXIT 0 no-op     │     refused/failed?  ──► KEEP     (C1)
        │    divergent        ──► REFUSE           ├─ removeWorktree(dir only)         (C2)
        │    unresolved       ──► REFUSE           └─ log removed + run event          (C4)
        ├─ rsync ─► /opt/cezar-releases/<id>
        ├─ smoke-boot, flip symlink, restart
        └─ deploy.json.sha := stamp.sha  (A3)      scheduled ~5 min after context build (C5)
```

## Data models

**`packages/cezar/dist/.build-stamp.json`** (A1, new). Zod-validated on read; a parse failure is an
A2 refusal, never a default.

```ts
{ stampVersion: 1, sha: string, builtAt: string /* ISO */, dirty: boolean, version: string }
```

**`<repoRoot>/.ai/cezar/worktree-leases/<runId>.json`** (C3, new). `heartbeatAt` is the only field
the sweep's decision depends on; the rest are diagnostic (Q6).

```ts
{ leaseVersion: 1, runId: string, ownerBootRoot: string, ownerPid: number,
  ownerReleaseId?: string, heartbeatAt: string /* ISO */ }
```

**`<repoRoot>/.ai/cezar/worktree-reaps.jsonl`** (C4/Q8, new). Append-only, one JSON object per line,
never read by the runtime. *(In the shipped code the path is spelled `join(dataDir,
'worktree-reaps.jsonl')` with `dataDir = join(project.root, '.ai/cezar')` (`project-context.ts:425,
473`) — the same path as written here, but do not go looking for a literal `repoRoot` join.)*

```ts
{ at: string, runId: string, repoRoot: string,
  outcome: 'removed' | 'kept' | 'declined', reason?: string,
  autosave?: 'committed' | 'nothing-to-do' | 'refused' | 'failed', branchKept: true }
```

**As actually shipped the record carries one more field than this.** `project-context.ts:473` builds
it as `{ at, runId: outcome.id, repoRoot, ...outcome }`, and the spread lands **after** `runId`, so
every line also carries the outcome's own `id` — the same value under a second name. Harmless (the
file is append-only and never read by the runtime), but a reader writing a parser against this
schema will not expect it. Either drop `runId` and let the spread supply `id`, or spread first and
keep `runId` as the single name; do not leave both.

**`ReleaseEntry`** (`releases.ts:41-59`), `builtAt` stops being deploy time and becomes
`stamp.builtAt`; `dirty?: boolean`, `stale?: true` and `unrelated?: true` are added. The schema is
`.passthrough()` with per-field `.catch(undefined)`, so older cezars round-trip the new fields
unharmed, the cross-version-state rule that schema already documents.

**`unrelated?: true` is not shipped yet and must be, and this is a gap the review pass found rather
than a design note.** As of `a3e70792` the *only* override recorded on a ledger row is
`stale: z.literal(true).optional()` (`releases.ts:51`), written at `release-deploy.ts:528` from
`options.allowStaleArtifact`. `--allow-unrelated` writes **nothing anywhere**: it suppresses the
refusal at `:423` and `:427-430` and leaves no trace in `deploy.json`, in the release directory, or
in the journal beyond the transient log line. For a gate whose entire purpose is preventing the
*silent* loss of commits that are live, a forced override that is itself silent reproduces the
defect one layer up — six months from now nobody can tell which release was force-activated over a
divergence. So:

```ts
/** Set when --allow-unrelated suppressed a divergent / unresolved / unreadable-ledger refusal. */
unrelated: z.literal(true).optional().catch(undefined),
/** The live-only commits that were overridden, exactly as printed at force time. */
unrelatedLostCommits: z.string().optional().catch(undefined),
```

written in the same `entry` literal that already carries `...(options.allowStaleArtifact ? { stale:
true } : {})` (`release-deploy.ts:525-530`), whenever `options.allowUnrelated` suppressed a
`divergent`, an `unresolved`, or a `live.error` refusal — and **not** when the flag was passed but
no refusal fired, so the field means "this deploy was forced", not "the operator typed a flag".
`unrelatedLostCommits` holds the `git log --oneline <incoming>..<live>` output the refusal computes
at `:428`, which is otherwise discarded. Mirrored in the P2 row of "## Phases" and asserted in item
1 of "### What is still open".

**`PruneOrphansOptions`** (`git-worktree.ts:589-604`) gains `leaseDir?: string`,
`leaseStaleMs?: number`, `now?: () => number` (test seam), and `onOutcome?: (o) => void` (the C4
sink, injected rather than imported so `git-worktree.ts` keeps no dependency on the run store).
`leaseDir` is a **test seam only**: when it is omitted the check still runs, against the default
`join(repoRoot, '.ai/cezar/worktree-leases')` (C3). An omitted `leaseDir` must never be read as "no
lease check", unlike the omit-`opts`-entirely convention documented at `git-worktree.ts:652-656`.

**`PruneOrphansReport`** (`git-worktree.ts:584-587`) gains `kept: { id; reason }[]`; `removed` stays
`string[]` so `index.ts:740` keeps compiling unchanged.

## API contracts

- `GET /api/v1/ready` and `/api/v1/health`: the `deploy` object (`runtime-info.ts:25-30`) gains
  `builtAt` and `dirty`; `sha` becomes the **artifact's** sha (A3). Additive, except that `sha` now
  means something stricter, it can only ever have been *more* wrong before, so no consumer that was
  correct becomes incorrect. Both probes in `.ai/deploy-targets.json` already parse `deploy.sha`
  positionally out of the JSON and need no change.
- `cezar server-deploy` gains `--allow-stale-artifact` (ship despite an A2 refusal, recorded on the
  ledger), `--refuse-dirty` (Q2's opt-in strictness), and `--allow-unrelated` (force through B1's
  `divergent` or `unresolved` refusal).
  `--rollback` is unchanged (`ReleaseDeployOptions.rollback`, `release-cli.ts:34-35`) and remains
  the deliberate way *backwards*; it is not the override for either new refusal, and B1's
  strict-ancestor case needs no flag because it is a success. `--sha` keeps its spelling and changes
  meaning (Q4). Existing invocations are unchanged whenever the source was actually built from its
  HEAD, which is the intended steady state.
- No HTTP route is added, removed or renamed. No `@loki-labs/better-cezar-contract` change.

## Phases

Each row is independently shippable and independently valuable, a phase that stops here still
leaves the box better than it found it. Phase numbering matches the task's acceptance criteria.

**One deliberate deviation, named so it is not mistaken for an oversight:** acceptance criterion
P2's "refused" is amended by this spec to **"exit 0 as a no-op" for the strict-ancestor case only**
(see `### Half B` and "Prior decisions this spec amends" #7 — refusing it would contradict
`.ai/deploy-targets.json`'s current ancestor-is-green decision and push the deploying agent toward
`--rollback`). The rest of P2 is unchanged: "fail closed when either sha cannot be resolved" stays a
refusal, the divergent case stays a refusal, and the E2E criterion's "an ancestor deploy … refused"
reads as E2E step 15's exit-0 no-op assertion.

| Phase | Content | Files | Depends on | Ships alone? |
|---|---|---|---|---|
| **P0, stop the loss** | C1 autosave-before-delete + `kept` outcome, **C1a worktree-root proof before any autosave**, C2 drop the branch argument, C4 log `removed` from `project-context.ts` and append `worktree-reaps.jsonl` (+ its rsync exclude) | `git-worktree.ts`, `server/project-context.ts`, `index.ts`, `server-install/release-deploy.ts` (exclude only) | nothing | **yes, ship first** |
| **P1, honest artifact** | A1 stamp writer + build-script wiring + partial-build invalidation, A2 the five refusals, A3 release id / ledger `sha` / `builtAt` from the stamp | `scripts/write-build-stamp.mjs` (new), root `package.json`, `packages/cezar/package.json`, `server-install/release-cli.ts`, `server-install/release-deploy.ts`, `server-install/releases.ts` | nothing | yes |
| **P2, no rollback by accident** | B1's four-valued relation gate (descendant/equal proceed, strict ancestor no-ops, divergent and unresolved refuse) with `--allow-unrelated`, B2 the messages **naming the live sha as the merge target, not `origin/main`**, the non-empty-`deploy.json` probe from Q5, and `ReleaseEntry.unrelated?: true` + `unrelatedLostCommits` recorded whenever `--allow-unrelated` suppressed a refusal | `server-install/release-deploy.ts`, `server-install/releases.ts` | P1's stamp | no |
| **P3, fail-closed sweep** | C3 lease write/heartbeat/expiry/delete, the prune-side lease read, C5 deferred sweep on an owned `unref`'d timer | `workspace/worktree-lease.ts` (new), `workspace/workspace-worktrees.ts`, `git-worktree.ts`, `workflows/run.ts`, `server/project-context.ts`, `index.ts` | P0 (shares the report shape) | yes |
| **P4, visibility** | in-band `builtAt`/`dirty` on `/ready` and `/health`, reap run events published to the cockpit | `server/runtime-info.ts`, `server/project-context.ts` | P0, P1 | yes |

**Ship order is P0 first and it is not negotiable.** P0 converts an unrecoverable loss into a
recoverable inconvenience, touches four files (`git-worktree.ts`, `server/project-context.ts`,
`index.ts`, and `server-install/release-deploy.ts` for the rsync exclude alone), and depends on
nothing, including on P1, which is the half that takes longer to get right.

## As shipped

Added 2026-08-22 (second amendment). Everything in this section was verified by **reading the merged
tree at `a3e70792`**, not by trusting `362865ec`'s commit message or the prior step's handoff. Line
numbers here are current; line numbers everywhere else in this spec are pre-implementation.

**The commit.** `362865ec`, *"fix: pruneOrphans autosaves before removing, releases carry a build
stamp, and worktree leases stop live-tree reaping"*, 20 files, +1328/−185, merged to `origin/main`
as `a3e70792`. It ships P0, P1, P2, P3 and the `/ready` half of P4 together; the phase table above
kept them separable and they were not in the end shipped separately.

| Phase | Landed? | Where it is now |
|---|---|---|
| **P0** | yes | `git-worktree.ts:667` `pruneOrphans`; worktree-root proof at `:708` (`rev-parse --show-toplevel`, canonicalised, and `!== repoRoot`); `autosaveCommit(worktreePath, 'run finalize')` at `:709`; `refused`/`failed` → `outcome: 'kept'`, directory left on disk, `:710-715`. **No `git branch -D` on any path**: every outcome literal carries `branchKept: true` (`:687`, `:694`, `:703`, `:713`, `:719`). Reap log: `project-context.ts:471-473` appends `worktree-reaps.jsonl`; staging excludes it at `release-deploy.ts:230`. |
| **P1** | yes | `scripts/write-build-stamp.mjs` (18 lines) writes `packages/cezar/dist/.build-stamp.json` `{stampVersion:1, sha, builtAt, dirty, version}` via tmp+`rename`. Root `package.json:17-19`: `build` = `build:server && build:web && check:pack && build:stamp` (`:17`), and `build:server`/`build:web` (`:18-19`) each `rm -f` the stamp **first**, which is Q1's partial-build invalidation, shipped. Gates at `release-deploy.ts:402-441`, helpers `readBuildStamp:90-104`, `staleSource:106-118`. Release id from `stamp?.sha` at `:444-446`; ledger row writes `sha`/`version`/`builtAt`/`dirty` (+`stale`) at `:527-528`, schema `releases.ts:44-52`. |
| **P2** | yes, with the documented ancestor deviation and two named deviations | `gitRelation` at `release-deploy.ts:120-128` returns `equal`/`descendant`/`ancestor`/`divergent`/`unresolved`. Strict ancestor → `ancestorNoop`, **exit 0, no flip** (`:426`, `:437-440`). `divergent`/`unresolved` → refused unless `--allow-unrelated` (`:427-430`). Unparseable/absent-but-present `deploy.json` → `live.error` → refused (`:423`), i.e. Q5's fail-open trap is closed — **but Q5's step 2 (fall back to the live artifact's own stamp when the ledger row carries no `sha`) was NOT shipped**: `liveSha` (`:129-142`) returns `does not identify the live artifact sha` and B1 refuses. That deviation is now decided as permanent and step 2 is dropped (see Q5). Second deviation: **`--allow-unrelated` writes no ledger trace** — `stale` (`releases.ts:51`, set at `:528`) is the only override field — which "## Data models" now closes with `unrelated?: true`. |
| **P3** | **yes, with one gap** | `workspace/worktree-lease.ts` (59 lines), `LEASE_HEARTBEAT_MS = 90_000`, atomic tmp+`rename`. Written at `workspace-worktrees.ts:132` and `run.ts:4189`; heartbeat interval `run.ts:6091-6096` (`unref`'d); removed on settle/dispose via `clearWorktreeLeases` (`run.ts:6099-6104`, called at `:1094` and `:2299`). Prune side reads it itself in `leaseDeclineReason` (`git-worktree.ts:622-646`): fresh heartbeat **or** malformed/unparseable lease both decline; `DEFAULT_LEASE_STALE_MS = 15 min` (`:620`) with `CEZ_LEASE_STALE_MS` override. Deferred sweep: `project-context.ts:463-481` and `index.ts:737-751`, both `setTimeout(…, CEZ_SWEEP_DELAY_MS ?? 5 min)` and `unref`'d; the project-scoped timer is cancelled by `teardown` (`project-context.ts:512-513`). Docs: `.env.example:264,266`, `README.md:553-554`. **The gap:** a *continued* run holds no lease. `dropActive` (`run.ts:2297-2299`) deletes the lease at settle and `runContinuation` (`run.ts:3370`) never writes it back — the single-repo branch (`:3411-3414`) reuses `record.worktreePath` with no write and no arm, and the workspace branch arms only inside `if (live.length === 0)` (`:3424`), i.e. only when the trees were absent and had to be rebuilt, never when a live tree is reused. So on the most common resume path C3's guard is simply not there. Fix and coverage: item 2 of "What is still open"; the Q6 lifecycle bullet is corrected in place. |
| **P4** | **half** | `/ready` half landed: `DeployInfo` gained `builtAt`/`dirty` (`runtime-info.ts:64-70`), populated from the ledger entry at `:118-121`. **Not landed:** "reap run events published to the cockpit": the only sink for a reap outcome is `worktree-reaps.jsonl`. P4 remains open work, not shipped work. |

### Two corrections applied after the last review pass

Both were made during the earlier chain's `run-tests` step, i.e. **after** the third `review-spec`
pass signed off, so they were never themselves reviewed as spec. Re-read and confirmed correct here:

1. **Gate ordering.** The reviewed draft put the new P1/P2 gates at the very top of
   `runReleaseDeploy`. That broke the pre-existing "install path is a directory, not a release
   symlink" structural check and produced the wrong error when both conditions held. The symlink
   check now runs **first and unconditionally**, ahead of `if (!rollback)` (`release-deploy.ts:391-398`),
   with the reason stated in-comment. Rollback remains fully exempt from the forward gates
   (`:401-405`), which is the correction review pass 3 demanded.
2. **Test timing.** `project-context.test.ts`'s two AC4 tests asserted on `pruneOrphans`'s effect
   immediately after `context()` + `disposeAll()`. P3 made that sweep deferred, and `disposeAll()`
   cancels a still-pending timer, so the assertions raced. They now set `CEZ_SWEEP_DELAY_MS: '0'`
   and wait for the sweep's own `worktree-reaps.jsonl` record before disposing.

### Three residues this re-read turned up

Named here rather than silently fixed, because this step writes the spec and does not touch code.

1. **`trunkRef` is now dead, and its documentation is now false.** `PruneOrphansOptions.trunkRef`
   (`git-worktree.ts:606`) is still passed by both call sites (`index.ts:742`,
   `project-context.ts:467`) and `pruneOrphans` never reads it, because C2 removed the `branch -D` it
   gated. `isAncestorOf` (`:578`) has **no production caller left**. The doc comments at `:604-607`
   and `:661-662` still describe a candidate that "only loses its BRANCH when `opts.trunkRef` proves
   it fully merged", which is no longer what the function does. Per this workspace's correct-in-place
   rule that comment is exactly the kind of stale entry the next session reads first: either delete
   the option and its two call sites, or mark the comments superseded, pointing at C2.
2. **The boot-root sweep writes no durable reap record.** `onOutcome` (and therefore
   `worktree-reaps.jsonl`) is wired only in `project-context.ts:471-473`. The boot-root sweep in
   `index.ts:737-751` still logs to the console alone. That is the asymmetry with the worst possible
   placement: the incident's ownership claim lived in the **boot root's** `runs.json`, so the one
   sweep with no forensic trail is the sweep over the workspace root. Acceptance criterion P0 asked
   for project-context to log removals "the way `index.ts:740` does"; it was read literally and
   satisfied, and it left the boot root behind. Closing it is ~6 lines in `index.ts`: an `onOutcome`
   mirroring `project-context.ts:471-473`, plus the `appendFileSync` import that `index.ts:5` does
   not currently have.
3. **`readWorktreeLease` has no caller at all.** `worktree-lease.ts:53-58` is exported and never
   called: re-verified at `a3e70792`, neither production code nor any test file references it.
   `pruneOrphans` deliberately reads the lease itself so it can tell *unreadable*
   from *absent*, a distinction `readWorktreeLease`'s catch-all `return undefined` erases, and the
   one the "unreadable lease also declines" criterion turns on. Keep it only if a caller needs the
   lossy read; otherwise it is a trap for whoever reaches for it next.

### What is still open

This is the whole instruction set for the implement step, and every choice the residues above left
open is decided here. Nothing below needs a further judgement call.

1. **The automated coverage for the deploy gates and the lease lifecycle does not exist, and it must
   be green BEFORE the deploy step.** Right now the only proof that A2 and B1 behave is a human
   reading the code, and those gates run on **every** deploy from this box. See the inventory table
   in "## Verification" for what is missing and what merely looks covered. Write, in the existing
   suites — do not start parallel files:

   - `packages/cezar/src/server-install/release-deploy.test.ts` (steps 5–9b): stamp sha ≠ source HEAD
     refuses and the message names **both** shas; stamp sha == HEAD proceeds (the control that proves
     the gate is not always-refuse); stamp missing refuses; truncated/unparseable stamp refuses; a
     tracked file under `packages/*/src` touched to `builtAt + 5 s` refuses and to `builtAt − 5 s`
     proceeds; under `--allow-stale-artifact`, `deploy.json.sha` **and** `deploy.json.builtAt` come
     from the stamp, not from source HEAD and not from the deploy time; all five `gitRelation` rows —
     `descendant` and `equal` proceed, strict `ancestor` exits 0 with **no flip, no restart and no
     ledger row**, `divergent` refused and then forced through by `--allow-unrelated`, `unresolved`
     the same; a forced divergent deploy (`--allow-unrelated`) writes **`unrelated: true` on the
     ledger row** together with `unrelatedLostCommits`, and a deploy that passes the flag while no
     refusal fires writes **neither** (the field means "forced", not "flag typed");
     `deploy.json` absent → allowed, `deploy.json` present but unparseable → refused; a ledger row
     whose `sha` is absent → refused, per Q5's now-dropped step 2; the divergent refusal message
     names **the live sha** as the merge target and does **not** say `origin/main`; and
     `--rollback` still activates an older release **with no stamp present**. Note that the two
     existing fixture helpers (`:92`, `:104`) hard-code `builtAt: '2099-01-01T00:00:00.000Z'`, so a
     staleness test must write its own stamp rather than reuse them.
   - `packages/cezar/src/git-worktree.test.ts`: the `['branch','-D',…]` argv spy (step 3), and the
     stubbed-C1 and stubbed-C1a negative controls (steps 1 and 3b), without which those two tests
     could pass against the pre-fix behaviour.
   - `packages/cezar/src/server/project-context.test.ts`: step 12b's three assertions — with
     `CEZ_SWEEP_DELAY_MS` unset, `build()` performs no prune inline; after the timer, it does; after
     `dispose()`, it never does.
   - A lease-lifecycle test for step 12 (heartbeat keeps updating, lease removed on clean settle,
     resumed run re-arms it). This is the coverage whose absence let item 2 below ship unnoticed, so
     it is the one to write first.

2. **`runContinuation` adopts a live worktree without a lease. Fix it, and cover it.** Verified at
   `a3e70792`: `dropActive` (`run.ts:2297-2299`) calls `clearWorktreeLeases`, which **deletes** the
   lease files when a run settles, and `runContinuation` (`run.ts:3370`) — the path every user
   "continue" and every restart-continuation takes — never writes them back. Its single-repo branch
   (`:3411-3414`) simply sets `cwd = record.worktreePath`, with no `writeWorktreeLease` and no
   `armWorktreeLeases` anywhere in the method; its workspace branch arms leases only inside
   `if (live.length === 0)` (`:3424`, arming at `:3438`), i.e. only in the case where the worktrees
   were **absent** and had to be re-materialized, never in the case where a live tree is reused. Net
   effect: **a continued run occupies a live worktree with no lease at all.** For the most common
   way work resumes on this box, the fail-open `findForeignOwner` snapshot is again the only thing
   between a continued run and the sweep — the incident's exact shape. (This item no longer leans on
   P6.2's second `--repo <worktree>` server, which was alive at the 13:12Z incident and is **gone**
   as of 23:5xZ; the gap stands on its own, because `findForeignOwner` is fail-open for an *absent*
   claim regardless of how many boot roots exist.) The fix:

   - single-repo case: `writeWorktreeLease` for the repo root owning `record.worktreePath`, then
     `armWorktreeLeases(state, runId, [<that root>])`;
   - workspace case: the same for **every** entry of `record.workspaceWorktrees` that still exists on
     disk, unconditionally — not only when `live.length === 0`.

   Write the lease explicitly rather than relying on `armWorktreeLeases` alone. `touchWorktreeLeases`
   (`worktree-lease.ts:40-46`) does create the file, since it calls `writeWorktreeLease` — but not
   until the first `LEASE_HEARTBEAT_MS` tick 90 s later, and a sweep can land inside that window.

   Then a regression test that a continued run's lease file is present and heartbeated. **And an E2E
   consequence:** verification step 13's three concurrent runs must include at least one *continued*
   run, or the E2E goes green having never exercised this path.

3. **The runtime E2E (steps 13–19) has not run anywhere.** This is the acceptance criterion the
   whole spec turns on, and it needs the box. Nothing else in this list substitutes for it.

4. **Close residue 2: wire `onOutcome` into the boot-root sweep.** ~6 lines: an `onOutcome` added to
   the `pruneOrphans` options at `index.ts:740-746`, mirroring `project-context.ts:471-473` with the
   boot root as `repoRoot`, plus the `appendFileSync` import that `index.ts:5` does not yet have. **This is a prerequisite for Verification step 14b** whenever the boot
   root is one of the repos under test, because without it that assertion has nothing to read.

5. **Close residue 1 by DELETING the dead option, not by re-documenting it.** Concretely:
   - remove `PruneOrphansOptions.trunkRef` and its doc comment (`git-worktree.ts:603-606`);
   - remove the two call sites that still pass it, `index.ts:742` and `project-context.ts:467`;
   - remove `isAncestorOf` (`git-worktree.ts:578-582`), which has no production caller and no test
     caller. Its `isSafeGitRef` import stays used by six other call sites in the same file
     (`:69, :154, :473, :496, :555`), so nothing else in the import block changes;
   - rewrite the `pruneOrphans` doc paragraph at `git-worktree.ts:656-665` so it no longer claims a
     branch-delete path that C2 removed. Two sentences there are now false, not one: the
     "only loses its BRANCH when `opts.trunkRef` proves it fully merged" claim at `:661-662`, and
     the "omitting `opts` entirely reproduces today's unconditional delete-both behavior
     byte-for-byte" claim at `:664-665`, which P0's autosave also invalidated. Say instead that the
     branch is **always** kept and that a removal is always preceded by an autosave, and point at
     this spec's Half C.

   Deleting beats a `SUPERSEDED` lead-in in this one case because the comment documents an option
   that is itself going away, so there is no surviving mechanism to redirect a reader to. Test
   fallout is known and small: `git-worktree.test.ts:620, 637, 651, 670` pass `trunkRef: 'main'`
   (drop the property, the assertions are unaffected because the branch is kept either way), and
   `:698`'s *"opts supplied but `trunkRef` omitted defaults to the SAFE direction: branch always
   kept"* case is subsumed by C2. Keep that test and rename it to state the now-unconditional
   contract rather than deleting the coverage.

6. **Close residue 3 by deleting `readWorktreeLease`** (`worktree-lease.ts:53-58`). It has **no
   caller anywhere**, production or test (re-verified at `a3e70792`). `leaseDeclineReason`
   (`git-worktree.ts:622-646`) reads the lease file itself precisely because this helper's catch-all
   `return undefined` erases *unreadable* from *absent*, which is the distinction the "unreadable
   lease also declines" acceptance criterion turns on. Leaving it exported is therefore a trap for
   whoever reaches for it next, not a convenience.

7. **P4's cockpit reap events are explicitly OUT OF SCOPE for this spec.** Q8 names the cockpit as
   sink 2 in one sentence of prose and nothing else: there is no event type, no payload shape, no
   publisher, "## API contracts" adds no route for it, and "## Verification" has no step that would
   prove it works. Specifying it properly is a design task of its own, and attaching an unverified
   event to a spec whose only remaining work is a runtime E2E would dilute that E2E rather than
   strengthen it. The durable sink that the incident's forensics actually needed
   (`worktree-reaps.jsonl`, sink 1) is shipped. File the cockpit half as its own task. **It is not
   filed as of this amendment**; the command is:

   ```bash
   cezar todo add "Publish worktree reap outcomes as cockpit run events (P4 sink 2)" \
     --context "Spec .ai/specs/2026-08-22-live-worktree-reaped-mid-run.md Q8 names the cockpit as sink 2 for a reap outcome but never specifies it: no event type, no payload, no publisher, no verification step. Today the only sink is <repoRoot>/.ai/cezar/worktree-reaps.jsonl, written from project-context.ts:471-473." \
     --acceptance "an event type and payload shape are specified, and the publisher named, before any code" \
     --acceptance "a reap outcome for a directory whose id matches a known run reaches that run's cockpit timeline" \
     --acceptance "a reap outcome for a directory no run owns still lands in worktree-reaps.jsonl and is not silently dropped" \
     --priority low
   ```

   Until that task lands, the P4 row in the table above stays **half**, and that is the honest
   state of it.

8. **Apply the three unmade in-place corrections that "Prior decisions this spec amends" demands.**
   That section lists seven entries; only one of them has actually been marked. Checked at
   `a3e70792`, so the next reader neither redoes done work nor skips undone work:

   - **#3 is already applied.** The `CORRECTED 2026-08-22 by 2026-08-22-live-worktree-reaped-mid-run.md`
     banner sits at the top of `.ai/specs/2026-08-22-cross-project-worktree-orphan-prune-safety.md`,
     landed in `362865ec`. Do not write it again.
   - **#4, #5 and #7 need no file edit.** #4 and #5 record that a prior decision's *shape* is
     unchanged (blue-green release identity; the ledger's permissive missing `sha`), so nothing in
     either file became false. #7 is upheld explicitly, and `.ai/deploy-targets.json` must **not** be
     touched.

   The remaining three are unmade, and the code session that was supposed to carry them is over, so
   nothing downstream makes them unless this list does:

   a. **#2 — `.ai/specs/2026-08-19-parallel-workspace-runs-worktrees.md:91`, row W7.** The cell still
      reads *"Orphans are reclaimed by the existing per-project prune on next boot of that project's
      manager"*, which is now false in three ways at once. Add a
      `**CORRECTED 2026-08-22 by 2026-08-22-live-worktree-reaped-mid-run.md:**` lead-in to that cell,
      leaving the original sentence below it unchanged, stating that the prune now (i) autosaves the
      tree onto its `cez/<id8>` branch before removing anything and keeps the directory when that
      autosave refuses or fails, (ii) **always** keeps the branch — there is no `branch -D` on this
      path any more — and (iii) runs on a deferred timer roughly 5 minutes after context build, not
      inline at boot. W7 is the entry that made this sweep a routine operation rather than an
      exceptional one, so it is the one a reader is most likely to act on.
   b. **#6 — `AGENTS.md:13`**, the sentence *"**Build first** — `stage` is an rsync, not a build, so
      a stale `dist/` ships old bytes under a new label"*, inside the
      `CORRECTED 2026-08-21 — on prod-host` bullet. The prose stays true and stops being
      load-bearing: append that since `362865ec` it is **enforced**, not merely asked for — `npm run
      build` writes `packages/cezar/dist/.build-stamp.json` (`package.json:17-19`) and
      `server-deploy` refuses to stage when that stamp is missing, unreadable, older than
      `packages/*/src`, or names a sha that disagrees with the source checkout's HEAD
      (`release-deploy.ts:90-128`, gated at `:391-405`). Without that note the next reader assumes
      the instruction is still the only thing between them and a stale ship, which is exactly the
      assumption the incident falsified.
   c. **#1 — the corpus doc**
      `/var/lib/cezar/loki-labs/notion-export/knowledge/sections/324-2026-08-22-blue-green-source-sha-is-a-label-not-a-checkout.md`.
      Its diagnosis is correct and stands; its prescribed *workaround* — "build from an isolated
      worktree checked out at the exact target sha" — is superseded by A1/A3, under which the stamp
      is the machine authority and `--sha` is a cross-check (Q4). **This one must NOT be edited in
      place.** It is a mounted KB document, and this workspace's rule is that a mounted doc is
      corrected through a reviewed proposal, never by writing to the mount. Append a single NDJSON
      line to `CEZ_KB_WRITE_FILE` instead — `{"op":"supersede", "target":
      "324-2026-08-22-blue-green-source-sha-is-a-label-not-a-checkout", "by":
      "2026-08-22-live-worktree-reaped-mid-run", "date":"2026-08-22", "note": "<what replaced the
      workaround>"}` — as **`seq: 1`, not `seq: 0`**: the run's `CEZ_KB_WRITE_FILE` already holds one
      line, a `seq: 0` `upsert` of `knowledge/2026-08-22-live-worktree-prune-implementation.md` whose
      `supersedes` array already names `notion-8d2aa351272c`, the same corpus document. Two claims on
      one target from one run is how a proposal review stalls, so make the new line a `supersede` op
      that continues the sequence rather than a second, competing assertion — carrying its own `seq`
      (counting up across every line appended to that file
      this run; read the file first if earlier turns already wrote to it), `runId` and `createdAt`,
      and let it land via `cez kb proposals`. A proposal is reviewed and applied later, so this step
      ends with the line appended, not with the corpus changed.

## Risks

- **A build stamp becomes a new way to block a deploy.** Mitigated by `--allow-stale-artifact` and
  by refusals that name the exact command that fixes them. The failure mode it replaces is silently
  shipping the wrong code, which is strictly worse.
- **Leases are a new write path.** One small file per repo per live run, rewritten on a heartbeat.
  Bounded by concurrent runs × granted repos (10 × 10 today). A leaked lease only ever *delays* a
  reclaim by `LEASE_STALE_MS`.
- **P3 does not bind processes that predate it.** A `cezar serve` started before P3 will neither
  write nor honour leases until it is restarted, and it prunes the real project roots regardless of
  which boot root it was launched from. **The specific long-lived `--repo <worktree>` server this
  bullet used to name is gone** — measured 2026-08-22 23:5xZ, `ps -eo pid,lstart,args | grep
  cezar/dist/index.js` returns exactly one process, pid 373697, started 23:23:55, on
  `/opt/cezar/…`. The risk is structural, not a claim about the current process list, and it is now
  discharged as an **executable precondition on Verification step 13** rather than as an
  instruction. The runbook should still say that a cockpit booted from a worktree prunes the real
  project roots.
- **C5 leaves orphans on disk ~5 minutes longer.** Disk is the cheap resource in this trade; the
  predecessor spec already established "directory gone, branch kept" as the reclaim contract.
- **C1 costs a commit on the prune path.** `autosaveCommit` already refuses mid-merge and
  conflict-marked trees (`git-worktree.ts:326-333`), so it will decline exactly the cases where
  committing would be wrong, and C1 turns that decline into "keep the directory", which is the safe
  side.
- **A dotfile inside `dist/` and `check:pack`, checked and not a risk.** `packages/cezar/package.json`'s
  `files` array lists `dist`, so `.build-stamp.json` will be published in the npm tarball (harmless,
  arguably good provenance). `scripts/check-pack.mjs:38` calls `findPackGaps(files)`
  (`packages/cezar/src/pack-check.ts:18-28`), which asserts that two *required* paths are **present**
  (`web/dist/index.html` and some `web/dist/assets/*`) and says nothing about any other file. It is
  a presence check, not an exact-list check, so an extra dotfile cannot trip it. No action needed
  in A1.
- **`stage()`'s rsync does not exclude the new repo-local files.** `release-deploy.ts:147-160`
  excludes `.git`, `.ai/cezar/runs`, `.ai/cezar/worktrees` and `.ai/cezar/tmp`, so
  `.ai/cezar/worktree-reaps.jsonl` and later `.ai/cezar/worktree-leases` would be copied into every
  release tree. Harmless (nothing reads them from a release root, and the release is not a repo root
  any sweep visits) but pointless and confusing. **`worktree-reaps.jsonl` is created in P0, so its
  exclude ships in P0**, in the same phase as the file itself; P3 adds `.ai/cezar/worktree-leases`
  when it introduces the lease directory.
- **Retention is a second destructive path and was checked.** `reclaimWorktrees` also removes
  directories, but only for runs finished in *this project's own* store, so it cannot reach a live
  foreign run's tree the way `pruneOrphans` could. It already keeps the branch. Deliberately out of
  scope; recorded here so the next reader does not have to re-derive it.
- **P4's `builtAt` change is observable.** `deploy.json` entries written after P1 carry a `builtAt`
  that is *earlier* than the activation time, where every existing row's `builtAt` is deploy time.
  Anything reading `builtAt` as "when was this deployed" becomes wrong. Nothing in this repo does,
  `activatedAt` is that field, and it is untouched.

## Verification

Every step below is executable and has a negative control. Nothing here is aspirational.

Gates, as `AGENTS.md` → **Validation** actually defines them: `npm run typecheck` and `npm test`
(vitest, from the repo root), plus `npm run test:unit` (node:test) and, when the packaging path is
touched, `npm run build` followed by `npm run test:package`, which packs the tarball and therefore
needs a completed `npm run build`. **There is no `lint` script**: neither the root
`package.json` nor any of the four workspace packages defines one, and the repo carries no
eslint/biome/oxlint config, so `npm run lint` exits `Missing script: lint`.

**Run them in this order, because P1 can be tripped procedurally.** Anything that ends in a deploy
goes `npm ci` → `npm run typecheck` → `npm test` → **`npm run build`** → `server-deploy`, with the
build last. The reason is P1's own invalidation rule pointed back at the operator: root
`package.json:36` is `"pretypecheck": "npm run build:server"`, and `build:server` and `build:web`
each begin with `rm -f packages/cezar/dist/.build-stamp.json` (`package.json:18-19`). So a
`typecheck` run *after* a `build` deletes the stamp that build just wrote, and the very next
`server-deploy` is refused with
`<source>/packages/cezar/dist/.build-stamp.json is absent, run npm run build first`
(`release-deploy.ts:92`). That is a procedural miss whose message is indistinguishable at a glance
from step 16's genuine stale-artifact refusal, so it gets debugged as a bug in the gate.
**A `build` that precedes a `typecheck` must be repeated after it.**

**And there is a second precondition, ahead of `npm run build`, that B1 itself created: re-anchor
the tree onto the live sha, or the deploy is refused before it ever reads the stamp.** This is not
hypothetical. Measured 2026-08-22 23:5xZ, with the gates live as `20260822T232351Z-a81a0a30`:

```bash
LIVE=$(jq -r --arg c "$(jq -r .current /opt/cezar-releases/deploy.json)" \
  '.releases[]|select(.id==$c)|.sha' /opt/cezar-releases/deploy.json)
git merge-base --is-ancestor "$LIVE" HEAD    # exit 0 ⇒ forward deploy will pass B1
```

`$LIVE` is `a81a0a30`, a **merge commit on `cez/f28edef5`**. Both
`git merge-base --is-ancestor a81a0a30 origin/main` and
`git merge-base --is-ancestor origin/main a81a0a30` exit **1**, so `gitRelation(incoming=origin/main,
live=a81a0a30)` is `divergent` and `release-deploy.ts:427-430` refuses. Four commits are live-only
against this checkout's `HEAD`.

So, when that probe exits non-zero: **`git merge origin/main` is NOT sufficient**, because the live
sha is not on `origin/main` and merging `origin/main` cannot make the tree a descendant of a commit
that `origin/main` does not contain. Either

- **merge the live sha itself** — `git merge "$LIVE"` — which works because releases here are
  deployed from pushed `cez/<id8>` tips, so the live commit is in this repo's object db even with
  no `main` branch containing it; this is the default, and it makes the next deploy an honest
  `descendant`; or
- **deploy once with `--allow-unrelated`**, having first read the live-only commit list the refusal
  prints, to re-anchor `live` onto a commit reachable from `main`. This is an operator decision, not
  the deploy step's (see "### Half B"), and after the Data models change it is recorded on the
  ledger as `unrelated: true`.

**That merge moves `HEAD`, and therefore invalidates the build stamp exactly the way a post-build
`typecheck` does.** So the full mandatory order is: re-anchor probe → merge (if needed) →
`npm ci` → `npm run typecheck` → `npm test` → **`npm run build`** → `server-deploy`. **E2E steps 14
and 16 take this same precondition**, and step 15's ancestor fixture must be built relative to the
re-anchored live sha, not to `origin/main`.

Narrow a run with
`npm test -- <path>`; `AGENTS.md` explicitly forbids `npx vitest`, which reaches past the pinned
devDependency and fetches a different version. The existing suites these extend are
`packages/cezar/src/git-worktree.test.ts` (which already has a `pruneOrphans (real git)` describe at
`:551` built on real repos, not mocks), `packages/cezar/src/runs/worktree-ownership.test.ts`,
`packages/cezar/src/server/project-context.test.ts` (already exercises a real cross-project prune at
`:528`), `packages/cezar/src/workspace/workspace-worktrees.test.ts` (`discardWorkspaceWorktrees` at
`:258`), and `packages/cezar/src/server-install/{release-deploy,release-cli,deploy-strategy}.test.ts`.
Extend those files; do not start parallel ones.

**Gates green is necessary and not sufficient here.** Steps 13–19 are the authoritative gate, and
until they have actually run on the box this ships as **QA Needed**, not Done.

**Status of this section as of the third amendment (2026-08-22).** The previous draft of this
paragraph claimed "Steps 1–12b exist as code and were exercised". **That was false**, and it was the
most load-bearing false sentence in the spec: it told an implementer that only the runtime E2E
remained, which would ship a deploy gate that now stands between every task on this box and
production with **no** automated proof that it refuses anything. A gate that over-refuses bricks
every deploy from here; a gate that under-refuses is the original hole, still open. Re-counted
against `a3e70792`:

| Step | Code? | Where it is, or why it is not |
|---|---|---|
| 1 | **partial** | The autosave-then-remove case is `git-worktree.test.ts:562`. The negative control this spec demands — stub C1 out and assert the test fails — does **not** exist, so the test cannot yet prove it would catch the pre-fix behaviour. |
| 2 | yes | Mid-merge tree → `kept`, nothing committed. |
| 3 | **partial** | `git-worktree.test.ts:562` asserts the branch **still exists**, which this spec itself says proves nothing (a merged-branch path satisfies it for the wrong reason). The `['branch','-D',…]` argv spy is not implemented. |
| 3b | **partial** | The C1a fixture exists; the "stub the C1a guard out and assert a parent-repo commit appears" negative control does not. |
| 4 | yes | `project-context.test.ts` removal-log assertions, with the zero-candidate control. |
| 5, 6, 7, 8, 9, 9b | **none at all** | `server-install/release-deploy.test.ts` has 17 `it()`s and **not one tests the new gates**. `build-stamp` appears in that file exactly twice (`:92`, `:104`), in the two fixture helpers, both writing `builtAt: '2099-01-01T00:00:00.000Z'` — i.e. the fixtures exist so the *pre-existing* tests survive the gate, and that far-future `builtAt` means `staleSource` can never fire in any of them. `grep -rn 'allowUnrelated\|allowStaleArtifact\|refuseDirty\|sourceHead\|already live' --include='*.test.ts'` over the whole repo returns **nothing**. |
| 10 | yes | Fresh lease declines with `validIds` empty and `findForeignOwner` returning `undefined`. |
| 11 | **partial** | Staleness and corrupt-JSON declines are covered; the mode-000 unreadable case and the "lease directory does not exist at all" case are not separately asserted. |
| 12 | **none** | No lease-lifecycle test anywhere. `git-worktree.test.ts` is the only test file that mentions leases at all, and it covers only the prune-side decline of steps 10/11. Nothing asserts that the heartbeat keeps updating, that a clean settle removes the lease, or that a resumed run re-arms it — which is precisely how the `runContinuation` gap (item 2 of "What is still open") shipped unnoticed. |
| 12b | **none** | Nothing asserts that `build()` performs no prune inline, that the deferred timer fires, or that `dispose()` cancels it. C5's whole contract is unexercised. |

`npm ci`, `npm run typecheck` and `npm test` were run **by an earlier step, not by this amendment**,
and reported `Test Files 5 failed | 528 passed (533)`, with all five failures individually
re-checked in isolation and attributed to two `AGENTS.md`-documented pre-existing host issues plus
host load (measured 25–31, several concurrent tasks each running a full suite on this shared box),
reproduced against a clean control worktree at the same base and not reproduced by this diff in
isolation. **That is second-hand here**: this amendment re-read the code, it did not re-run the
gates.

So **two** things stand between this spec and Done, not one: the missing unit and integration
coverage tabulated above (item 1 of "What is still open", which must be green **before** the deploy
step, because the gates it covers run on every deploy from this box), and steps 13–19, the runtime
E2E on `prod-host`, which have **not run anywhere**. That is why the status line says QA
Needed.

**CORRECTED 2026-08-23T00:31Z (task `b34867ee`, final round, commit `32379c34`).** The table above is
re-counted against `a3e70792` and is now stale for rows 5–9b: `release-deploy.test.ts` gained 14 new
`it()`s exercising all five B1 relation rows, the A2 stale/missing/unreadable/mtime-grace refusals,
the incident replay (row 6), and the stamp-sha-not-HEAD-sha ledger assertion (row 8) — those rows
move from `none` to `yes`. Row 12 moves from `none` to `partial`: `run.test.ts` gained a regression
test for the `runContinuation` lease gap (Q6's third amendment, `run.ts:3411-3438`), proving both the
single-repo and workspace branches now write and arm a lease on a continued run, but "heartbeat keeps
updating for the life of a run" and "a clean settle removes the lease" are still unproven, so row 12
is not fully closed. Rows 1/3/3b (the negative controls and the `branch -D` argv spy) are still open
— no test DI seam exists for the internal git runner — and are the one item carried forward as an
accepted, non-blocking gap rather than closed. Item 12b (the deferred-sweep timer contract) and the
mode-000/no-directory lease cases in row 11 were not part of this round either; treat the table's
`partial`/`none` marks for those as still accurate. `npm run typecheck` and the full `npm test` both
ran green after this round (modulo confirmed pre-existing host-load flakes in files this diff never
touched, re-verified green in isolation).

**P0 — unit, `packages/cezar/src/git-worktree.test.ts`**

1. Create a real repo + `cez/<id8>` worktree, write an **untracked** file into it, call
   `pruneOrphans(repo, new Set(), { findForeignOwner: () => undefined })`. Assert: directory gone,
   branch present,
   and `git show cez/<id8>:<file>` returns the file's content. *Negative control:* the same
   assertion must fail when C1 is stubbed out — add the stub as an explicit test seam and assert
   the failure, so the test cannot pass against the pre-fix behaviour. Per Q9, the call deliberately
   passes `validIds: new Set()` and `findForeignOwner: () => undefined`, so `5ffa383c`'s guard
   cannot be what makes it pass.
2. Worktree left mid-merge (conflict markers present) → outcome `kept`, directory still on disk,
   nothing committed.
3. Assert `pruneOrphans` never invokes `git branch -D` (spy on the git runner and assert the exact
   argv is absent — not that the branch "still exists", which a merged-branch path could satisfy
   for the wrong reason).
3b. **C1a, and this one is a data-integrity test, not a nicety.** Put a plain `mkdir`'d directory
   with one untracked file (no `.git` at all) under `.ai/cezar/worktrees/` of a real repo that has
   its **own uncommitted changes**, and call `pruneOrphans`. Assert: the directory is removed, the
   record carries `autosave: 'nothing-to-do'`, and, the actual assertion, `git -C <repo> rev-parse
   HEAD` and `git -C <repo> status --porcelain` are **unchanged**, i.e. no `cezar autosave` commit
   was written to the parent repo and its dirty files are still dirty. *Negative control:* the same
   fixture with the C1a guard stubbed out must produce a new commit, so the test provably catches
   the bug rather than passing vacuously. Repeat with a directory whose `.git` file was deleted
   after the worktree was created, which is the shape an interrupted `rm -rf` leaves.
4. `project-context` test: a removal produces a `removed` log line naming the id. *Negative
   control:* a run with zero candidates produces **no** line, so the assertion is not vacuous.

**P1/P2 — integration, `packages/cezar/src/server-install/release-deploy.test.ts`**

5. Stamp sha ≠ source HEAD → deploy exits non-zero, message names both shas. Stamp sha == HEAD →
   proceeds (the control that proves the gate is not simply always-refuse).
6. **Replay the real incident:** a source tree whose `dist/.build-stamp.json` predates its HEAD by
   one commit, exactly as `20260822T131126Z-504ce87f` did → refused.
7. Missing stamp → refused. Truncated/unparseable stamp → refused (fail closed, not "assume HEAD").
   Stamp present and sha-equal but one tracked file under `packages/*/src` touched to
   `builtAt + 5 s` → refused; touched to `builtAt - 5 s` → proceeds (Q3's grace window is exercised
   from both sides, so a bug that makes the mtime scan always-true or always-false is caught).
8. `deploy.json.sha` equals the **stamp** sha, not the source HEAD, when `--allow-stale-artifact`
   forces a stale ship. This is the assertion that makes the ledger honest, and per Q9 it is the
   line that is false under `release-cli.ts:72` today.
   `deploy.json.builtAt` equals `stamp.builtAt`, not the deploy time.
9. All five rows of B1's table, because the whole defect they close is that one probe cannot tell
   them apart: incoming a **descendant** of live → proceeds; incoming **equal** to live → proceeds;
   incoming a **strict ancestor** of live → **exit 0 with no flip, no restart and no ledger row**,
   and the message says "already live", never `--rollback`; incoming **divergent** from live
   (build the fixture by committing on two branches from a common base) → **refused**, message
   lists the live-only commits, and `--allow-unrelated` forces it through; incoming sha
   unresolvable → refused, `--allow-unrelated` forces it through. Plus `--rollback` with an
   older release still activates it (the deliberate backwards path is unbroken). And on the ledger
   side: **`deploy.json` absent → allowed** (first deploy); **`deploy.json` present but unparseable
   → refused** (Q5's fail-open trap, this is the case `loadLedger` alone would wave through, so it
   needs its own test).
9b. A build-script test: `npm run build:server` alone leaves **no** `.build-stamp.json` behind when
   one existed before it (Q1's invalidation). Without this, `pretypecheck` silently re-arms the
   exact failure mode P1 exists to close.

**P3 — unit + integration**

10. Fresh lease → declined **with `validIds` empty and `findForeignOwner` returning `undefined`**.
    The point is that it holds with every other signal removed; a fixture where ownership also
    matches proves nothing.
11. Lease older than `LEASE_STALE_MS` → eligible (drive it with the injected `now`, never a real
    sleep). Corrupt/truncated lease JSON → declined. Lease file present but unreadable (mode 000) →
    declined. A lease directory that does not exist at all → the sweep behaves exactly as it does
    today, so a repo that predates P3 is unaffected.
12. Heartbeat keeps updating for the life of a run; the lease is removed on a clean settle; a
    `manager.recover()`d run re-arms its heartbeat.
12b. `project-context.test.ts`: with `CEZ_SWEEP_DELAY_MS` unset, `build()` performs **no** prune
    inline, assert the git runner sees no `worktree prune` during `build()`. Then advance the timer
    and assert it does. Then `dispose()` before the timer fires and assert it never runs. This is
    C5's whole contract and it is the one part that is invisible in production until it matters.

**Runtime E2E on `prod-host` — the authoritative gate**

12c. **Precondition on the box, before step 13: no cezar process is running pre-P3 code.** A server
    that predates P3 neither writes nor honours leases, and it sweeps the real project roots
    whatever boot root it was launched from — so one stray process makes the whole E2E prove
    nothing while going green. Assert it, do not eyeball it:

    ```bash
    ps -eo pid,args | grep -E '[c]ezar.*(dist/index\.js|serve)' | while read -r pid args; do
      exe=$(printf '%s\n' "$args" | grep -oE '(/[^ ]*)/packages/cezar/dist/index\.js')
      root=${exe%/packages/cezar/dist/index.js}
      if grep -q leaseDeclineReason "$root/packages/cezar/dist/git-worktree.js" 2>/dev/null
        then echo "ok   $pid $root"
        else echo "STALE $pid $root"; fi
    done
    ```

    Every line must read `ok`; restart or kill anything that reads `STALE` before proceeding.
    Measured 2026-08-22 23:5xZ this passes with a single process (pid 373697, `/opt/cezar`, whose
    `dist/git-worktree.js` contains `leaseDeclineReason`), but that is a snapshot — re-run it, it is
    cheap and the whole E2E depends on it.

13. Start 3 concurrent workspace runs across ≥2 repos, **at least one of them a *continued* run** —
    settled and then resumed, so it enters through `runContinuation` and reuses an existing tree
    rather than re-materializing one. Without that, the unleased-continuation path named in item 2 of
    "What is still open" is never exercised and this step goes green while the most common way work
    resumes on this box stays unguarded. Snapshot before:

    ```bash
    find /var/lib/cezar/loki-labs/*/.ai/cezar/worktrees -maxdepth 1 -mindepth 1 | sort > /tmp/wt.before
    for r in /var/lib/cezar/loki-labs/*/; do git -C "$r" for-each-ref --format="$r %(refname)" refs/heads/cez 2>/dev/null; done | sort > /tmp/br.before
    ```

14. **Two preconditions, both from the gates paragraph above, and this step cannot pass without
    them.** First, **re-anchor**: `git merge-base --is-ancestor "$LIVE" HEAD` must exit 0, where
    `$LIVE` is the live release's `sha` out of `deploy.json`; if it does not, merge `$LIVE` itself
    (merging `origin/main` does **not** help when the live sha never landed on `main` — measured
    today, it has not). Second, **`npm run build` immediately after that merge and after the last
    `npm run typecheck` of the session**: `pretypecheck` runs `build:server`, which deletes the
    stamp, and the merge moves `HEAD` past the stamp's sha, so either one leaves this step refusing
    for a procedural reason whose message reads exactly like step 16's.
    Then deploy forward once (`npm run server-deploy -- --strategy=blue-green --source=<checkout>`),
    then **prove a sweep actually ran before diffing anything**. Once C5 ships, the post-restart
    sweep is deferred by `SWEEP_DELAY_MS` (5 min), so a snapshot taken immediately after the deploy
    proves only that no sweep has happened yet — it would pass for the wrong reason, and this is the
    spec's own authoritative gate. So, in order:

    a. Shorten or wait out the delay: either export `CEZ_SWEEP_DELAY_MS=0` on the restarted service
       for the duration of the test, or wait past `SWEEP_DELAY_MS`.
    b. Confirm the sweep ran, and expect a reap row only where the shipped code can actually emit
       one. The primary evidence is the journal: `journalctl -u cezar.service --since "<deploy
       time>"` must show a per-project prune line for each granted repo, which is emitted on every
       sweep. The `<repoRoot>/.ai/cezar/worktree-reaps.jsonl` expectation is narrower than it looks,
       for two shipped reasons:

       - `pruneOrphans` skips any directory whose id is in `validIds` with `continue` **before** it
         calls `onOutcome` (`git-worktree.ts:683`). A live run sweeping in **its own** project is
         therefore not a candidate at all, and correctly produces **no row**. A `declined` row
         appears only in a repo that is *not* the owning store for that run id, where the id is a
         candidate and the lease or ownership check turns it away.
       - The **boot root emits no rows on any path**: its sweep at `index.ts:737-751` passes no
         `onOutcome` (residue 2 above).

       So assert, per live run id, a `outcome: "declined"` row in each granted repo that does not own
       it, and **no** row in the one that does. If the boot root is one of the repos under test,
       either close residue 2 first (the `onOutcome` wiring named in "What is still open") or fall
       back to the journal line alone for that repo and record that fallback in the result. If the
       journal shows no prune line at all, the step is inconclusive, not green: go back to (a).
    c. Only then re-snapshot into `/tmp/wt.after` / `/tmp/br.after` and `diff` each: **zero**
       worktrees or branches belonging to a live run removed. `diff` exiting 0 is the assertion;
       eyeballing is not.
15. Attempt an **ancestor** deploy from a second checkout (a checkout whose HEAD is behind the live
    sha) → must **exit 0 as a no-op**, printing `already live: <live> contains <incoming>`, with
    `readlink /opt/cezar` byte-identical before and after and no new row in
    `jq '.releases[-1].id' /opt/cezar-releases/deploy.json`. A non-zero exit here is a **failure of
    this step**, not a pass: refusing this case is what would push an agent toward `--rollback`.
15b. Attempt a **divergent** deploy, from a `cez/<id8>` tip that has its own commit and has not
    merged the commit that is live → must be **refused**: non-zero exit, a message naming the
    live-only commits, `readlink /opt/cezar` byte-identical before and after, and
    `jq -r '.releases[-1].id' /opt/cezar-releases/deploy.json` unchanged.

    **The step stops at the refusal.** The `--allow-unrelated` override is proved by step 9, which
    forces a divergent deploy through at the integration level in `release-deploy.test.ts`, and it
    is deliberately **not** exercised against the live `/opt/cezar-releases`. Doing so would mean
    activating a tree *known* to be missing commits that are live, on the production box, with no
    restore step anywhere in steps 16–19 — the precise harm this spec exists to prevent, performed
    by its own authoritative gate, for coverage it already has. If the override must be seen on the
    box at all, run it against a scratch ledger: `--releases-dir=/tmp/e2e-releases` is a real flag
    (parsed at `index.ts:278`, wired into both deploy paths at `:372` and `:400`, and forwarded to a
    re-exec'd child at `release-deploy.ts:561`), so the live symlink and `deploy.json` are never
    touched.
16. Attempt a deploy from a checkout that merged **without rebuilding** → must be refused with the
    **stale-artifact** reason. This is the exact failure that caused the incident, and it is the one
    E2E step that cannot be simulated in a unit test convincingly. **It takes step 14's re-anchor
    precondition, and here it is load-bearing rather than incidental:** if the tree is still
    `divergent` from live, B1 refuses *first* and the step goes green on the wrong refusal, proving
    nothing about A2. So merge the **live sha** (not `origin/main`) to make the tree a `descendant`,
    do **not** rebuild, and assert the message names the stamp/HEAD mismatch and not the relation.
17. Create a genuinely orphaned worktree directory (no run, no lease) and confirm the next sweep
    removes it, logs it to the journal, **and** appends a line to
    `<repoRoot>/.ai/cezar/worktree-reaps.jsonl`. This step carries step 14's timing dependency
    identically, so it takes the same precondition: set `CEZ_SWEEP_DELAY_MS=0` or wait past
    `SWEEP_DELAY_MS`, and confirm from the journal that a sweep ran in the window **before** reading
    the outcome — otherwise "the directory is still there" means "no sweep yet", not "the sweep is
    broken", and the control proves nothing. Without this the whole log-based verification is
    unfalsifiable, "nothing was reaped" and "reap logging is broken" would look identical, which is
    exactly the position the incident's forensics started from.
18. `find /var/lib/cezar -not -user cezar | wc -l` → `0` before ending the session.
19. Sanity on the deploy that just happened, since it is the first one under P1:
    `jq -r '.releases[-1] | "\(.id) sha=\(.sha) builtAt=\(.builtAt)"' /opt/cezar-releases/deploy.json`
    and `cat /opt/cezar/packages/cezar/dist/.build-stamp.json`, the two shas must be equal, and
    `builtAt` must precede the release id's timestamp.

**Field evidence this spec must be able to explain afterwards** — re-run the forensics that produced
it and get a different answer: no release in `deploy.json` whose `dist/` predates its own sha, and
`journalctl -u cezar.service | grep "removed .* worktree"` accounting for every directory that
disappeared.

---

## Prior decisions this spec amends

Each of these is *current* in the record and becomes wrong when this ships. Per the workspace's
correct-in-place rule, the marking happens in the named file in the same session as the code, not
by leaving the stale entry standing next to a newer one.

1. **`--sha` is an authoritative label.** KB `notion-8d2aa351272c` /
   `324-2026-08-22-blue-green-source-sha-is-a-label-not-a-checkout.md` records that
   `server-deploy --sha=<sha>` labels whatever is already checked out, and prescribes an
   exact-sha-worktree workaround. Correct diagnosis; the workaround is superseded by A1/A3, the
   **stamp** is the machine authority and `--sha` becomes a cross-check (Q4).
2. **W7: startup orphan prune is the cleanup path for failed/cancelled workspace runs.**
   `.ai/specs/2026-08-19-parallel-workspace-runs-worktrees.md:91`. That reliance is what made the
   sweep a routine operation rather than an exceptional one. It stays true only once the sweep is
   recoverability-preserving; mark it corrected there, pointing here.
3. **Layer 2's ancestry-gated branch delete is the right contract for prune.**
   `.ai/specs/2026-08-22-cross-project-worktree-orphan-prune-safety.md`. It was a strict improvement
   over the unconditional `branch -D`, and it is still a `branch -D` reachable from a sweep. C2
   makes it unconditional-keep on this path. The ownership snapshot itself stays and stays useful;
   it is simply not sufficient proof of orphanhood.
4. **Blue-green release identity.** `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md:345`
   established sortable `<timestamp>-<short-sha>` ids and the ledger. Unchanged in shape; the
   **source** of the sha changes. Atomic activation and rollback are untouched.
5. **The ledger's permissive missing-`sha`.** `releases.ts:46`'s `.optional().catch(undefined)` stays
   right for historical and hand-staged rows. What changes is that forward *activation* stops
   reading absent-or-unresolvable identity as permission (Q5).
6. **`AGENTS.md`'s "Build first, `stage` is an rsync, not a build".** The prose stays true and
   stops being load-bearing. Note there that P1 now enforces it, so the next reader does not assume
   the instruction is still the only thing standing between them and a stale ship.

7. **Upheld, explicitly, and not amended: the backend probe's ancestor rule.**
   `.ai/deploy-targets.json`'s `CORRECTED AGAIN 2026-08-21 (2) EXACT EQUALITY ON A SHARED BOX`
   note decided that an incoming HEAD which is an **ancestor** of the live sha is **green**, because
   everything at that HEAD is already in the running process. B1 is written to agree with it: the
   strict-ancestor case is an `exit 0` no-op, not a refusal. An earlier draft of this spec made it a
   refusal, which would have contradicted a current decision and, worse, pushed the agent running
   the deploy step toward `--rollback` for a case whose correct action is to do nothing. Nothing in
   `.ai/deploy-targets.json` needs editing.

**SUPERSEDED 2026-08-22 by `362865ec` (merged `a3e70792`); see "As shipped".** The paragraph below
was true when written and is now false in its conclusion: build stamps, the ancestry gate, worktree
leases, autosave-before-prune and the deferred sweep are all implemented and merged. It is kept
because its *method* still holds: the todo check and the `git log --all` search were real, and
re-running them is how the next reader confirms there is still no second, competing implementation.
Original text, unchanged:

> **Not found, stated rather than invented:** `cezar todo list` returned no open todo for this work,
> and nothing in `git log --all` implements build stamps, ancestry refusal, worktree leases,
> autosave-before-prune or a deferred sweep. This spec starts from zero implementation.

---

## Evidence appendix (measured 2026-08-22 13:15–13:22Z on `prod-host`)

- `5ffa383c` (the prune-safety fix) landed **07:58:54Z**; release `20260822T131126Z-504ce87f` ships
  `dist/git-worktree.js` built **07:48:29Z** with `dist/runs/worktree-ownership.js` absent;
  `deploy.json` records it `"healthy": true`.
- `pruneOrphans` in that build: `export async function pruneOrphans(repoRoot, validIds) {` — no
  `opts`, no ownership check, unconditional `git branch -D`.
- Service restarts today: 08:07, 08:31, 10:21, 10:27, 12:20, 12:23, 12:47, 12:49, 13:11, 13:17
  (ten).
- `[cez] project "cezar": declined to reclaim …` present at 12:20:55, 12:47:58, 12:50:00 and
  `"chat"`/`"homebrew-tap"` at 13:02:54 and 13:20:14 — and **absent** at 13:12:02, the one boot on
  the stale build, where the same context built and swept.
- Boot-root `runs.json` claims the reaped path explicitly:
  `{"root":"/var/lib/cezar/loki-labs/cezar","worktreePath":"…/worktrees/eb9f65aa-…","branch":"cez/eb9f65aa","baseBranch":"origin/main"}`,
  run status `running`, 10 worktrees, 14 live claims under that repo.
- Live processes inside the reaped tree at sample time: three
  `…/worktrees/eb9f65aa-…/node_modules/vitest/…` node processes.
- Recovery cost: `a30cf07d` and `53d22c7e` ("reconstructed after a fourth worktree reap"), plus two
  drafts rescued into `.ai/cezar/runs/<id>.spec-rescue.md`. The `eb9f65aa` agent is now working from
  `/tmp/cez-eb9f65aa-work`, outside the managed path, to avoid the sweep.
