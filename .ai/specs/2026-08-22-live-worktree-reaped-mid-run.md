# A live task's worktree is deleted out from under it, mid-run, with its uncommitted work

**Status:** implemented, QA needed. **Date:** 2026-08-22.
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
   roots with its own boot root. There is one alive on the box right now:
   `node packages/cezar/dist/index.js --port 43037 --repo /var/lib/cezar/loki-labs/cezar/.ai/cezar/worktrees/fd1f214d-…`,
   up since 2026-08-21 21:40. Its ownership view can never include production's boot root.
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
refusing: <incoming> has diverged from the live sha <live>.
live has commits this tree does not: <git log --oneline <incoming>..<live>>
deploy from a tree that merged origin/main, or pass --allow-unrelated.
```

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

`isAncestorOf` itself is **kept** (B1 uses it), but it stops being reachable from a sweep.

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
2. If that entry exists but carries no `sha` (the schema makes it optional at `releases.ts:46`, for
   hand-staged trees), read the **live artifact's own stamp** through the symlink:
   `<linkPath>/packages/cezar/dist/.build-stamp.json`. Same principle as the rest of the spec: ask
   the artifact.
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
  lease from `createWorktree` (`git-worktree.ts:139`) on the same terms.
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
- **Across a restart:** `manager.recover()` re-arms the heartbeat for every resumed run. Between
  process death and recovery the lease is present but ageing, which declines the sweep, the safe
  side, for at most `LEASE_STALE_MS`.

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
never read by the runtime.

```ts
{ at: string, runId: string, repoRoot: string,
  outcome: 'removed' | 'kept' | 'declined', reason?: string,
  autosave?: 'committed' | 'nothing-to-do' | 'refused' | 'failed', branchKept: true }
```

**`ReleaseEntry`** (`releases.ts:41-59`), `builtAt` stops being deploy time and becomes
`stamp.builtAt`; `dirty?: boolean` and `stale?: true` are added. The schema is `.passthrough()` with
per-field `.catch(undefined)`, so older cezars round-trip the new fields unharmed, the
cross-version-state rule that schema already documents.

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
| **P2, no rollback by accident** | B1's four-valued relation gate (descendant/equal proceed, strict ancestor no-ops, divergent and unresolved refuse) with `--allow-unrelated`, B2 the messages, the non-empty-`deploy.json` probe from Q5 | `server-install/release-deploy.ts`, `server-install/releases.ts` | P1's stamp | no |
| **P3, fail-closed sweep** | C3 lease write/heartbeat/expiry/delete, the prune-side lease read, C5 deferred sweep on an owned `unref`'d timer | `workspace/worktree-lease.ts` (new), `workspace/workspace-worktrees.ts`, `git-worktree.ts`, `workflows/run.ts`, `server/project-context.ts`, `index.ts` | P0 (shares the report shape) | yes |
| **P4, visibility** | in-band `builtAt`/`dirty` on `/ready` and `/health`, reap run events published to the cockpit | `server/runtime-info.ts`, `server/project-context.ts` | P0, P1 | yes |

**Ship order is P0 first and it is not negotiable.** P0 converts an unrecoverable loss into a
recoverable inconvenience, touches four files (`git-worktree.ts`, `server/project-context.ts`,
`index.ts`, and `server-install/release-deploy.ts` for the rsync exclude alone), and depends on
nothing, including on P1, which is the half that takes longer to get right.

## Risks

- **A build stamp becomes a new way to block a deploy.** Mitigated by `--allow-stale-artifact` and
  by refusals that name the exact command that fixes them. The failure mode it replaces is silently
  shipping the wrong code, which is strictly worse.
- **Leases are a new write path.** One small file per repo per live run, rewritten on a heartbeat.
  Bounded by concurrent runs × granted repos (10 × 10 today). A leaked lease only ever *delays* a
  reclaim by `LEASE_STALE_MS`.
- **P3 does not bind processes that predate it.** The long-lived `--repo <worktree>` server on the
  box today will not write or honour leases until it is restarted. P3 must ship with a sweep of
  stray `cezar serve` processes, and the runbook should say that a cockpit booted from a worktree
  prunes the real project roots.
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
eslint/biome/oxlint config, so `npm run lint` exits `Missing script: lint`. Narrow a run with
`npm test -- <path>`; `AGENTS.md` explicitly forbids `npx vitest`, which reaches past the pinned
devDependency and fetches a different version. The existing suites these extend are
`packages/cezar/src/git-worktree.test.ts` (which already has a `pruneOrphans (real git)` describe at
`:551` built on real repos, not mocks), `packages/cezar/src/runs/worktree-ownership.test.ts`,
`packages/cezar/src/server/project-context.test.ts` (already exercises a real cross-project prune at
`:528`), `packages/cezar/src/workspace/workspace-worktrees.test.ts` (`discardWorkspaceWorktrees` at
`:258`), and `packages/cezar/src/server-install/{release-deploy,release-cli,deploy-strategy}.test.ts`.
Extend those files; do not start parallel ones.

**Gates green is necessary and not sufficient here.** Steps 13–18 are the authoritative gate, and
until they have actually run on the box this ships as **QA Needed**, not Done.

**P0 — unit, `packages/cezar/src/git-worktree.test.ts`**

1. Create a real repo + `cez/<id8>` worktree, write an **untracked** file into it, call
   `pruneOrphans(repo, new Set(), { trunkRef: 'main' })`. Assert: directory gone, branch present,
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

13. Start 3 concurrent workspace runs across ≥2 repos. Snapshot before:

    ```bash
    find /var/lib/cezar/loki-labs/*/.ai/cezar/worktrees -maxdepth 1 -mindepth 1 | sort > /tmp/wt.before
    for r in /var/lib/cezar/loki-labs/*/; do git -C "$r" for-each-ref --format="$r %(refname)" refs/heads/cez 2>/dev/null; done | sort > /tmp/br.before
    ```

14. Deploy forward once (`npm run server-deploy -- --strategy=blue-green --source=<checkout>`),
    then **prove a sweep actually ran before diffing anything**. Once C5 ships, the post-restart
    sweep is deferred by `SWEEP_DELAY_MS` (5 min), so a snapshot taken immediately after the deploy
    proves only that no sweep has happened yet — it would pass for the wrong reason, and this is the
    spec's own authoritative gate. So, in order:

    a. Shorten or wait out the delay: either export `CEZ_SWEEP_DELAY_MS=0` on the restarted service
       for the duration of the test, or wait past `SWEEP_DELAY_MS`.
    b. Confirm the sweep ran: `journalctl -u cezar.service --since "<deploy time>"` shows a
       per-project prune line for each granted repo, **and** `<repoRoot>/.ai/cezar/worktree-reaps.jsonl`
       has at least one `outcome: "declined"` row naming each of the three live run ids. If neither
       appears, the step is inconclusive, not green — go back to (a).
    c. Only then re-snapshot into `/tmp/wt.after` / `/tmp/br.after` and `diff` each: **zero**
       worktrees or branches belonging to a live run removed. `diff` exiting 0 is the assertion;
       eyeballing is not.
15. Attempt an **ancestor** deploy from a second checkout (a checkout whose HEAD is behind the live
    sha) → must **exit 0 as a no-op**, printing `already live: <live> contains <incoming>`, with
    `readlink /opt/cezar` byte-identical before and after and no new row in
    `jq '.releases[-1].id' /opt/cezar-releases/deploy.json`. A non-zero exit here is a **failure of
    this step**, not a pass: refusing this case is what would push an agent toward `--rollback`.
15b. Attempt a **divergent** deploy, from a `cez/<id8>` tip that has its own commit and has not
    merged the commit that is live → must be **refused**, non-zero, message naming the live-only
    commits, with `readlink /opt/cezar` unchanged. Then re-run with `--allow-unrelated` and confirm
    it proceeds, so the override is proved to exist rather than assumed.
16. Attempt a deploy from a checkout that merged `origin/main` **without rebuilding** → must be
    refused with the stale-artifact reason. This is the exact failure that caused the incident, and
    it is the one E2E step that cannot be simulated in a unit test convincingly.
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

**Not found, stated rather than invented:** `cezar todo list` returned no open todo for this work,
and nothing in `git log --all` implements build stamps, ancestry refusal, worktree leases,
autosave-before-prune or a deferred sweep. This spec starts from zero implementation.

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
