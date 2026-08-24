# A workspace run's worktree is not an orphan to the project it lives in

> **Status:** superseded 2026-08-22 by
> `.ai/specs/2026-08-22-cross-project-worktree-orphan-prune-safety.md`, implemented and shipped
> as `5ffa383c`. This draft's diagnosis and review findings informed the accepted spec, but its
> proposed helper, unchanged prune signature, and three-arm dirty-worktree design did not land.
> The proposal below is preserved as historical context, not the description of shipped behavior.
> · **Date:** 2026-08-22
> **Reads on:** `.ai/specs/2026-07-18-worktree-retention.md` (defines `pruneOrphans`),
> `.ai/specs/2026-07-20-multi-project-workspace.md` (defines lazy per-project `ProjectContext.build()`,
> the mechanism this bug exploits), `.ai/specs/2026-08-15-cross-project-workspace-run.md` (D1: a
> workspace run's record lives in the **boot** project's `runs.json`), `.ai/specs/
> 2026-08-19-parallel-workspace-runs-worktrees.md` (introduces per-project worktrees for workspace
> runs; **its W7 row is corrected in place by this spec — see Phase 6**),
> `.ai/specs/2026-08-20-workspace-run-worktree-isolation.md` (fixes the **boot-side** leak of these
> same worktrees; this spec fixes the **target-project-side** deletion of them, a different
> mechanism entirely).
> **Brief:** `.ai/specs/briefs/2026-08-22-workspace-run-worktree-orphan-prune.md` (context step of
> this run) — all code citations below were re-verified directly against source during this step,
> not copied from the brief.
> **Revision note (this pass):** review round 1 flagged this draft's claim that `deps.bootRoot` is
> "always populated in production, wired at `server.ts:6664`/`:6796`" as false — those two lines
> wire `bootRoot` into `NoteProcessor` and `createWorkspaceRunRoutes`, not into `ProjectContexts`;
> re-verified directly against source for this revision (see Problem §4). Phase 1 below fixes the
> actual wiring gap; every other phase was already correctly designed but inert without it. An
> independent peer run (`43ab17aa`, reviewing the sibling spec below) re-derived the identical gap
> against the same line numbers, cited here as corroboration, and separately supplied the cost
> figure used in Risks for the new branch-reachability backstop (Phase 3) — re-measured directly in
> this revision (`git branch --list 'cez/*'` in this repo: 39 branches, 19 not ancestors of `main`).
> **Revision note (round 2, this pass):** review round 2 confirmed the round-1 bootRoot fix and found
> three further defects, all applied here: (1) the foreign-`runs.json` reader had coupled to the
> contract's `runRecordSchema`, stricter than the store's own on-disk loader — replaced with a
> minimal permissive `claimSchema` (see the new module section); (2) the Phase 3 backstop was a
> binary skip/delete that leaked the worktree *directory* forever and didn't cover the incident's
> actual uncommitted-work loss — replaced with the three-arm dirty/reachability/no-commits rule; (3)
> the Phase 1 wiring-guard test offered `createApp` as an alternative harness, which has its own
> `bootRoot` and would stay green with `server.ts:7112` unwired — narrowed to `startServer` only,
> asserted over HTTP.
> **SUPERSEDED 2026-08-22:** reconciliation resolved in favor of the independently-written spec
> `.ai/specs/2026-08-22-cross-project-worktree-orphan-prune-safety.md` from run `43ab17aa`.
> That design shipped in `5ffa383c`; this draft was stood down and was not implemented.
>
> Original text retained for the record: a second spec for this exact bug also existed and touched
> `pruneOrphans` and `project-context.ts`; the two proposals would have collided if both were built.

## TLDR

A **workspace run** creates its per-project worktrees under each granted project's own
`.ai/cezar/worktrees/<runId>`, but the run's *record* — the only thing that says "this id is not an
orphan" — is written exclusively to the **boot project's** `runs.json`
(`.ai/specs/2026-08-15-cross-project-workspace-run.md` D1). Every other registered project's own
`ProjectContext`, built lazily on first access (including every server boot/restart), runs
`pruneOrphans(project.root, new Set(store.listRuns().map(r => r.id)))` — and `store` is *that
project's own* `RunStore`, which never heard of the workspace run. So every workspace-run worktree
looks orphaned to the project it was granted into, and gets `git worktree remove --force` +
`rm -rf` + `git branch -D`'d, including mid-run. This fired live 2026-08-21 on task `232ad6d4`,
twice, destroying ~40 minutes of uncommitted work, and it fires on every restart of every non-boot
project's cockpit context.

The fix teaches the one call site that matters —
`packages/cezar/src/server/project-context.ts:446` — to also treat as "not an orphan" any run id
that owns a *live* `workspaceWorktrees` entry rooted at this project, recorded in the **boot**
project's `runs.json` or any other **registered** project's `runs.json` (the boot root is often
*not* itself a registered project — `suppressBootRegistration()` returns `true` unconditionally —
which is exactly why checking only `listProjects()` would still miss it). A new, deliberately
minimal, read-only helper does this without opening a `RunStore` (side effect: `mkdirSync`s a
`runs/` directory in every project merely to check it) and without extending the already
contract-tested `WorkspaceRunIndex` (risk: leaking `workspaceWorktrees` into the public
`WorkspaceRunSummary` API shape). The silent `.catch(() => [])` at the same call site is replaced
with a log line naming the project and the removed ids, matching the format `index.ts`'s
already-logging boot-time call site uses.

None of that works unless the boot root the check needs is actually reachable at runtime. It rides
on `ProjectContextsDeps.bootRoot` (`project-context.ts:214`), read through `resolveBootRoot()`
(`:394-397`, returns `undefined` whenever the field was never set) — but the **only** production
entry point, `packages/cezar/src/index.ts:762` calling `startServer`, builds its `ProjectContexts`
at `server.ts:7112` without that field, so `resolveBootRoot()` returns `undefined` in every real
cezar process today, and the 2026-08-15 boot-root-duplication guard that already depends on it
(`build()` lines 417-419) has never actually fired in production either (see Problem §4). Phase 1
below fixes that wiring first — everything else in this spec, including the fix already drafted
below, is dead code without it.

As a second, independent line of defense, `pruneOrphans` itself (`git-worktree.ts:572`) gains a
branch-reachability backstop (Phase 3): before hard-deleting a candidate orphan's branch, it checks
whether that branch holds any commit not already reachable from the repo's checked-out branch — a
still-live piece of uncommitted work, however it got there, that no ownership record needs to
explain for this spec to refuse to destroy it. This lives inside `pruneOrphans` itself, so both
existing call sites (`index.ts:710` and `project-context.ts:446`) get it automatically, without
either one needing to know about it.

## Problem

### The mechanism, traced to the exact lines

1. **Where the record lives.** A workspace run always executes through the **boot** manager
   (`bootContext.manager.startRun(...)`, `packages/cezar/src/server/server.ts:6797`), whose
   `RunManager` is built over `RunStore.open(dataDir)` where `dataDir = join(bootRoot, '.ai/cezar')`
   (`project-context.ts:425` for the general case; the boot context itself is built the same way in
   `index.ts`). `materializeWorkspaceWorktrees` is called once per granted project
   (`workflows/run.ts:3656-3662`, and again on resume at `:3118-3123`), and its result is persisted
   with `this.store.updateRun(runId, { workspaceWorktrees })` — `this.store` is the **boot** store,
   never the target project's own.

2. **Where the worktree lives.** `createWorktree(repoRoot, runId, base)`
   (`packages/cezar/src/workspace/workspace-worktrees.ts`, calling into
   `packages/cezar/src/git-worktree.ts:136`) is called with `repoRoot = project.root`, the
   **target** project. The directory lands at
   `worktreePathFor(repoRoot, runId) = join(repoRoot, WORKTREES_DIR, runId)`
   (`git-worktree.ts:83-85`, `WORKTREES_DIR = '.ai/cezar/worktrees'`) — inside the *target*
   project's own tree, named by the run's full `id` (confirmed: `RunStore.createRun` assigns
   `id: randomUUID()`, `store.ts:693`, and that same string is the `runId` threaded through both
   calls above — so the directory basename equals the boot record's `id` byte-for-byte).

3. **Where the prune runs, and what it checks.** `pruneOrphans(repoRoot, validIds)`
   (`git-worktree.ts:572-590`) lists every directory under `repoRoot/.ai/cezar/worktrees/` and
   removes (`removeWorktree`, `git-worktree.ts:239-248`: `git worktree remove --force`, `rm -rf`,
   `git branch -D`) any whose name is not in `validIds`. Both call sites build `validIds` as
   `new Set(store.listRuns().map(r => r.id))` — **that project's own store, full stop**:
   - `packages/cezar/src/index.ts:710-717` (boot process startup) — logs what it removes.
   - `packages/cezar/src/server/project-context.ts:446-448` (lazy `build()`, fires on **first
     access to a non-boot project after any process restart** — the common "cockpit restart /
     redeploy" case) — wrapped in `.catch(() => [])`, **completely silent**. This is the call site
     that fired for task `232ad6d4`.

   Since a workspace-run worktree's owning record is in the *boot* store, not the target project's
   own store, `validIds` at the target project's `build()` never contains it. Every workspace-run
   worktree in every non-boot project reads as an orphan on that project's very first context
   build after a restart.

4. **Why the boot root itself doesn't already cover this — and why the existing wiring can't
   either, today.** The boot root is deliberately **not** auto-registered as a project
   (`registered-project-roots.ts:176-178`, `suppressBootRegistration()` → unconditional `true`, per
   D3 of `.ai/specs/2026-08-07-org-scoped-tasks-knowledge.md`). So a fix that only cross-checks
   `listProjects()` (the registry) would still miss the boot store on an installation where nobody
   separately registered it — which is the owner's actual prod layout (`/var/lib/cezar/workspace`).
   `ProjectContexts` carries the boot root out-of-band for exactly this reason, as `deps.bootRoot`
   (`project-context.ts:214`), read through `private resolveBootRoot()` (`:394-397`) — which returns
   `undefined`, unconditionally, whenever `deps.bootRoot` was never set at construction.

   **Corrected in this revision — the previous draft asserted `deps.bootRoot` is "always populated
   in production, wired at `server.ts:6664` and `:6796`." That is false; re-checked directly
   against source.** Those two lines wire `bootRoot: deps.repoRoot` into `NoteProcessor` (`:6663`)
   and `createWorkspaceRunRoutes` (`:6796`) — two unrelated dependents, neither of them
   `ProjectContexts`. The **only** construction of `ProjectContexts` that supplies `bootRoot` is
   inside `createApp`, at `server.ts:1552-1566` (`deps.contexts ?? new ProjectContexts({ ...,
   bootRoot })`) — and that fallback never runs in the real server process. `startServer`, the
   actual production entry point (`packages/cezar/src/index.ts:762` is the sole non-test caller),
   builds its own `ProjectContexts` **first**, at `server.ts:7112`:
   `deps.contexts ?? new ProjectContexts({ listProjects, semaphore: deps.semaphore, automationStore:
   ... })` — no `bootRoot` key anywhere in that object — and hands the result into `createApp` as
   `contexts: sharedContexts` (`server.ts:7125`). Since `deps.contexts` is then already set,
   `createApp`'s own bootRoot-carrying construction at `:1552` never executes; it is dead code.
   `index.ts`'s call to `startServer` never sets `deps.contexts` either. So in every real cezar
   process running today, `resolveBootRoot()` returns `undefined` — the 2026-08-15
   boot-root-duplication guard that already depends on it (`build()` lines 417-419) has never
   actually fired in production, and this spec's fix, as drafted, would ship inert without also
   fixing this. Phase 1 (below) closes it: `bootRoot: deps.repoRoot` added at `server.ts:7112`, plus
   a wiring-guard regression test that exercises the real `startServer` construction path rather
   than a test-only `ProjectContexts` built with `bootRoot` passed in by hand (see Verification).

### Why this isn't a re-litigation of a settled decision

`.ai/specs/2026-08-19-parallel-workspace-runs-worktrees.md` W7 asserts the opposite of the above:
*"Orphans are reclaimed by the existing per-project prune on next boot of that project's manager."*
That sentence was written without checking what set that prune reads against, and it is wrong for
exactly the reason in point 3 — the "existing per-project prune" reads the *target* project's own
store, and a workspace run's id is never in it. No other spec claims ownership of this mechanism;
this is a genuine, previously undocumented gap between two features (per-project-scoped orphan
prune, designed 2026-07-18/2026-07-20, and cross-project workspace worktrees, designed 2026-08-19)
that were never cross-referenced. `.ai/specs/2026-08-20-workspace-run-worktree-isolation.md` fixed
the *sibling* leak — the **boot** store's own `reclaimWorktrees` (`runs/retention.ts:140-206`)
walking `run.workspaceWorktrees` for count-based retention — and does not touch or discuss the
target-project-side `pruneOrphans` this spec fixes. The two mechanisms (retention: reclaim old
*finished* worktrees, keep the branch; orphan-prune: reclaim worktrees nobody's record explains at
all, delete the branch too) stay independent; this spec only teaches the second one where else to
look for "somebody's record."

### A related but distinct gap this spec does not close

`materializeWorkspaceWorktrees` (`workspace/workspace-worktrees.ts:83-134`) creates every granted
project's worktree inside one loop, but the caller only persists the whole `workspaceWorktrees`
array **once, after the loop finishes** (`workflows/run.ts:3659-3662` on initial start,
`:3118-3123` on resume) — plus `RunStore`'s own 300ms save debounce (`runs/store.ts:1246-1254`) on
top of that. On a grant spanning N projects, the first project's worktree exists on disk, claimed by
no record anywhere (not this project's own store, not yet even the boot store), for the seconds it
takes to materialize the rest. A prune firing in exactly that window still deletes it — and because
the branch is brand new, the Phase 3 branch-reachability backstop below does not save it either
(zero unique commits is indistinguishable from "safe to reap"). Flagged here as a genuine adjacent
gap in the same failure class, not fixed by this spec: closing it means persisting each
`workspaceWorktrees` entry as it is created, inside `materializeWorkspaceWorktrees`'s own loop,
rather than once at the end — a `workflows/run.ts` change, out of scope for a spec whose acceptance
criteria are about the *ownership-check* gap, not the *write-ordering* one. Recorded here so it is
not lost; worth its own spec if the owner wants it closed too.

## Solution

Compute a fuller `validIds` set at the **one call site that matters**
(`project-context.ts` `build()`, around line 446) before calling the unmodified `pruneOrphans`:

```
validIds = (this project's own run ids)
         ∪ (run ids that own a live workspaceWorktrees entry rooted at this project,
            found in the boot project's runs.json, if a boot root is configured)
         ∪ (same, found in every OTHER registered project's runs.json)
```

`pruneOrphans`'s **exported signature** is unchanged (`(repoRoot, validIds) => Promise<string[]>`,
still independently unit-testable) but it gains one **internal** safety net in Phase 3: before
hard-deleting a candidate not in `validIds`, it now classifies it into one of three outcomes instead
of today's unconditional delete-both, because a binary skip-or-delete still leaks the
*directory* forever (nothing else reclaims a worktree no record explains — see Phases item 3) and a
binary "unique commits" check alone does not cover the incident that motivated this spec, whose
~40 minutes of loss was *uncommitted* work with no unique commit to detect:

- **(a) dirty** — `git status --porcelain` inside the worktree is non-empty → skip entirely, delete
  neither the directory nor the branch. This is the arm that actually covers the 2026-08-21 incident.
- **(b) clean, unique commits** — the branch holds a commit not reachable from the repo's
  checked-out `HEAD` → reclaim the directory only (`removeWorktree(repoRoot, path)`, branch argument
  omitted), keeping `cez/<id8>` — the same "directory only, branch kept, recoverable" contract
  `runs/retention.ts:148` and `index.ts:718-720` already use for count-based retention, so nothing
  new leaks.
- **(c) clean, no unique commits** — today's behavior: directory and branch both removed.

A branch that no longer exists (e.g. already deleted by a prior pass) makes `git merge-base
--is-ancestor` error rather than answer false; that error is read as "no unique commits" (falls
through to (c)), not as a reason to skip, so an orphan directory whose branch is already gone can
still be cleaned up rather than skipped forever. This applies uniformly at both existing call sites
— `index.ts:710` and `project-context.ts:446` — with no change required at either. The rest of the
new logic, separately, is: first, a new, narrowly-scoped read-only helper that finds "who
else's record claims a live worktree in my tree", used only at the `project-context.ts` call site,
where cross-project ownership actually needs checking; and second, turning the `.catch(() => [])` at
that same call site into a `.catch` that degrades to "skip this project's prune entirely this
cycle" on a genuine read/parse failure (distinct from "no `runs.json` yet", which is a normal
steady state) rather than silently proceeding with an incomplete `validIds` set — logging either
way instead of swallowing.

### Why a new helper, not one of the two existing cross-project readers

- **Not `RunStore.open(otherProjectDataDir)`.** `RunStore.open` (`runs/store.ts:645`)
  unconditionally `mkdirSync(join(dataDir, 'runs'))` — reading another project's `runs.json` just
  to check it would create a `.ai/cezar/runs/` directory in every registered project on every
  restart of every *other* project's context, a filesystem side effect with no reason to exist.
  This is precisely the discipline `workspace/run-index.ts`'s own header comment already states for
  a different reader: *"deliberately imports NEITHER `../runs/store.ts` ... NOR
  `../server/project-context.ts`"*.
- **Not `WorkspaceRunIndex` (`workspace/run-index.ts:230`), even though `ProjectContexts` already
  owns one (`this.runIndex`, `project-context.ts:279-282`) built once, shared, and cached per
  `(mtimeMs, size)`.** Its cache stores `TrimmedRun`, defined as
  `Omit<WorkspaceRunSummary, 'project' | 'noteId'>` — a type driven by the **public** API contract
  (`list()` spreads `{...run, project}` straight into an HTTP response). Adding
  `workspaceWorktrees` to that shape to make it available to this check would put worktree paths
  and branch names into every `GET` of the cross-project run list unless every call site
  remembered to strip it back out — a contract leak risk with no corresponding test guarding it,
  for a value this module (a boot-time, once-per-project-lifetime check) doesn't need cached at
  all. Not worth the risk to a doctrine-protected, contract-parity-tested module.
- **A dedicated, minimal, uncached reader is the right size for a check that runs at most once per
  project per process lifetime** (`ProjectContexts.build()` runs once per id — "nothing built until
  first access, one instance per id", `project-context.test.ts`'s own description).

### New module: `packages/cezar/src/workspace/foreign-worktree-owners.ts`

```ts
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';

/** Thrown when a candidate root's `runs.json` exists but could not be read or parsed — distinct
 *  from "no runs.json yet", which is a normal steady state and never throws. The call site must
 *  treat this as "verification failed," not as "nothing claimed" (see project-context.ts change
 *  below) — degrading to an empty set here would let a project's real ownership claim silently
 *  fail to protect its worktree. */
export class ForeignWorktreeOwnersError extends Error {}

/**
 * Deliberately NOT the contract's `runRecordSchema` (`@loki-labs/better-cezar-contract`,
 * `packages/contract/src/runs.ts:219`) — that is the **API** shape, which is stricter than the
 * **on-disk** one this module actually reads: the contract requires `archived: z.boolean()` where
 * the store's own loader (`runs/store.ts:120`, `archived: z.boolean().default(false)`) tolerates
 * an absent key, and the contract's `workflowDef` is a plain `.optional()` where the store's is
 * `.optional().catch(undefined)` (`store.ts:441-447`), by design, "so an older or hand-edited
 * entry" doesn't "fail the whole index parse." Coupling this reader to the contract schema instead
 * would mean a `runs.json` the store itself loads without complaint — e.g. one missing `archived`,
 * or carrying a `workflowDef` shape the store's own `.catch` would silently drop — fails this
 * module's `safeParse` instead. Combined with fail-CLOSED below and the caller's per-root loop
 * throwing on the first bad root (aborting every remaining root, see project-context.ts change),
 * that one record would disable orphan-prune for **every** project, silently and permanently,
 * because this process never rewrites another project's `runs.json` to fix the shape. This module
 * validates only the two fields it reads — `id` and `workspaceWorktrees[].root`/`.reclaimedAt` —
 * and stays loose (`.loose()`) everywhere else, so it can never reject a record the store itself
 * accepts.
 */
const claimSchema = z.array(
  z
    .object({
      id: z.string(),
      workspaceWorktrees: z
        .array(z.object({ root: z.string(), reclaimedAt: z.string().optional() }).loose())
        .optional(),
    })
    .loose(),
);

/**
 * Every run id, across the given candidate roots' OWN runs.json, that currently owns a live
 * (`!reclaimedAt`) workspace worktree rooted at `targetRoot` (spec
 * 2026-08-22-workspace-run-worktree-orphan-prune). A workspace run's record lives in the boot
 * project's runs.json, which is often not itself a registered project — callers must include the
 * boot root in `candidateRoots` explicitly; this function does not special-case it.
 *
 * Read-only, deliberately NOT `RunStore.open` (no mkdirSync side effect) and NOT
 * `WorkspaceRunIndex` (would have to grow its public, contract-tested TrimmedRun shape). Runs at
 * most once per project per process lifetime, so no caching layer is worth the complexity.
 *
 * Fails CLOSED, not open: a missing `runs.json` (ENOENT) is a normal steady state and is skipped,
 * but an existing, unreadable, or malformed one throws `ForeignWorktreeOwnersError` rather than
 * silently contributing nothing — the caller must not proceed to prune with an ownership set it
 * could not actually verify.
 */
export async function collectForeignWorkspaceWorktreeIds(
  targetRoot: string,
  candidateRoots: readonly string[],
): Promise<Set<string>> {
  const target = resolve(targetRoot);
  const ids = new Set<string>();
  const seen = new Set<string>();
  for (const root of candidateRoots) {
    const key = resolve(root);
    if (seen.has(key) || key === target) continue; // a project's own worktrees are covered by store.listRuns()
    seen.add(key);
    const path = `${key}/.ai/cezar/runs.json`;
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue; // no runs.json yet — legitimate
      throw new ForeignWorktreeOwnersError(
        `could not read ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new ForeignWorktreeOwnersError(
        `could not parse ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const result = claimSchema.safeParse(parsed);
    if (!result.success) {
      throw new ForeignWorktreeOwnersError(`${path} is not a JSON array of run records`);
    }
    for (const run of result.data) {
      for (const wt of run.workspaceWorktrees ?? []) {
        if (!wt.reclaimedAt && resolve(wt.root) === target) ids.add(run.id);
      }
    }
  }
  return ids;
}
```

Distinguishing "file absent" from "file present but broken" this way is the direct fix for the
review's defect: the previous draft's blanket `try { stat; readFile } catch { continue }` degraded a
corrupt `runs.json` to the same "nothing claimed here" outcome as a project that legitimately has no
runs yet — silently reintroducing the exact destructive behavior this spec exists to close, for
whichever project happens to have the unreadable file, on every restart, with no signal that
anything was skipped rather than genuinely empty. `malformed`, for this module, means "not a JSON
array of objects with a string `id`" — i.e. a `claimSchema` failure — not "does not match the
contract's `runRecordSchema`"; see the doc comment above `claimSchema` for why those two are
deliberately different tests.

### Call-site change: `packages/cezar/src/server/project-context.ts`

Current (lines ~444-452):

```ts
if (await getRepoInfo(project.root)) {
  await pruneOrphans(project.root, new Set(store.listRuns().map((r) => r.id))).catch(
    () => [] as string[],
  );
  const keep = await resolveWorktreeRetention(project.root).catch(
    () => DEFAULT_WORKTREE_RETENTION,
  );
  await reclaimWorktrees(project.root, store, keep).catch(() => [] as string[]);
}
```

New:

```ts
if (await getRepoInfo(project.root)) {
  const candidateRoots = [
    ...(bootRoot !== undefined ? [bootRoot] : []),
    ...projects.map((p) => p.root),
  ];
  let validIds: Set<string> | undefined;
  try {
    const foreignIds = await collectForeignWorkspaceWorktreeIds(project.root, candidateRoots);
    validIds = new Set([...store.listRuns().map((r) => r.id), ...foreignIds]);
  } catch (err) {
    // Fail CLOSED: we could not verify who else claims a worktree here, so we do not prune at
    // all this cycle rather than prune against a set we know is incomplete. A genuinely orphaned
    // worktree just waits for the next successful build; a wrongly-claimed one is never destroyed
    // by a check that couldn't run.
    console.warn(
      `[cez] project ${project.id}: could not verify foreign workspace-worktree ownership, ` +
        `skipping orphan prune this cycle (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (validIds) {
    const orphans = await pruneOrphans(project.root, validIds).catch((err) => {
      console.warn(`[cez] project ${project.id}: pruneOrphans failed (${err instanceof Error ? err.message : String(err)})`);
      return [] as string[];
    });
    if (orphans.length > 0) {
      console.log(
        `[cez] project ${project.id}: pruned ${orphans.length} orphaned worktree(s): ` +
          `${orphans.map((id) => id.slice(0, 8)).join(', ')}`,
      );
    }
  }
  const keep = await resolveWorktreeRetention(project.root).catch(
    () => DEFAULT_WORKTREE_RETENTION,
  );
  await reclaimWorktrees(project.root, store, keep).catch(() => [] as string[]);
}
```

`bootRoot` and `projects` are both **already in scope** at this point in `build()` — `bootRoot` is
the result of `await this.resolveBootRoot()` computed a few lines above for the boot-root-conflict
guard (`project-context.ts:417`), and `projects` is the registry list fetched at the top of
`build()` (`:401`). No new I/O is added to fetch either. `project.root` is excluded from
`candidateRoots`'s effective set inside the helper (it equals `target`, skipped), since this
project's own runs are already covered by `store.listRuns()`. **This code path only starts
returning a real `bootRoot` once Phase 1's wiring fix lands** — until then `resolveBootRoot()` is
always `undefined` here too, same as everywhere else in `build()`.

`pruneOrphans`'s exported signature and `reclaimWorktrees` are both unchanged by this call-site
edit. **`index.ts`'s call site is left out of this particular change, flagged rather than settled**:
the previous draft asserted outright that it "does not need this fix," reasoning that `repoRoot`
there is always the boot root itself, so the only way a foreign claim could land in the boot root's
own worktrees directory is a workspace run granting the boot root to itself — a case already covered
because that grant is recorded in the very same store `index.ts` reads. That reasoning has not been
independently verified with a test the way this call site now is, and a peer review agreed it is
safer to say so plainly than to assert it as closed. It is not left completely unprotected, though:
Phase 3's branch-reachability backstop lives inside `pruneOrphans` itself, so `index.ts`'s call site
gains that protection automatically, with no code change here, regardless of how the ownership-set
question above resolves. If a future incident shows otherwise, the same
`collectForeignWorkspaceWorktreeIds` helper applies there too, with `candidateRoots` = every *other*
registered project's root (no separate `bootRoot` argument needed, since `repoRoot` there already
**is** the boot root).

## Architecture

```
startServer (server.ts:7112)                              (NEW: Phase 1 adds bootRoot here)
  └─ new ProjectContexts({ listProjects, semaphore, automationStore, bootRoot: deps.repoRoot })

ProjectContexts.build(projectId)                          (project-context.ts:400)
  ├─ projects = await listProjects()                       (already fetched, :401)
  ├─ bootRoot = await resolveBootRoot()                     (already fetched, :417 — real value only
  │                                                           once Phase 1 lands)
  ├─ boot-root-conflict guard                                (:418, unchanged)
  ├─ store = RunStore.open(dataDir, {keepLive:true})         (:425, unchanged — THIS project's own)
  └─ if getRepoInfo(project.root):
       ├─ try: foreignIds = collectForeignWorkspaceWorktreeIds(   (NEW, Phase 2)
       │     project.root,
       │     [bootRoot, ...projects.map(p => p.root)]
       │   )
       │     for each candidate root's OWN runs.json (best-effort per-root, fails CLOSED overall):
       │       ENOENT → skip this root ("claims nothing")
       │       unreadable/malformed → throw ForeignWorktreeOwnersError
       │       else: for each run's workspaceWorktrees entries,
       │             if !reclaimedAt && entry.root == project.root: claim entry.run.id
       │   catch: log + skip pruning entirely this cycle (fail closed, not open)
       ├─ if verified: validIds = store.listRuns().ids ∪ foreignIds
       ├─   orphans = pruneOrphans(project.root, validIds)     (git-worktree.ts:572)
       │       internally, Phase 3, per candidate not in validIds — applies here AND at
       │       index.ts:710, unconditionally:
       │         dirty working tree            → skip (delete nothing)
       │         clean + unique commit(s)      → remove directory only, branch kept
       │         clean + no unique commits     → remove directory AND branch (today's behavior)
       │         (branch already gone reads as "no unique commits", not as skip)
       │     — now logs project id + removed ids instead of the old .catch(() => [])
       └─ reclaimWorktrees(project.root, store, keep)         (unchanged)
```

## Data Models

No schema changes. `workspaceWorktreeSchema` (`packages/contract/src/runs.ts:160-172`) already
carries everything the check needs: `root` (the real project root the worktree mirrors — matched
against `project.root`), `worktreePath`, `branch`, `baseBranch`, and `reclaimedAt` (optional —
absence means "still live", already the exact semantics `runs/retention.ts`'s own
`isWorkspaceReclaimable` relies on). `runRecordSchema`'s `id` field is the run's UUID and, per the
Problem section trace above, is byte-identical to the worktree directory's basename.

## Phases

Each phase is independently shippable and independently testable. Phase 1 is a blocking
prerequisite — nothing else in this spec has any effect in production until it lands. Phases 2-3
together close acceptance criterion 1; phase 4 closes criterion 3; phase 5 is criterion 2; phase 6
is the correction discipline.

1. **Fix the dead `bootRoot` wiring (blocking).** Add `bootRoot: deps.repoRoot` to the
   `ProjectContexts` construction at `server.ts:7112` (inside `startServer`), so the field
   `resolveBootRoot()` reads is finally populated in the process that actually runs in production.
   Ship with the wiring-guard regression test (see Verification) that fails if this ever regresses
   silently again — the mechanism that let the original claim in this spec go unverified for a full
   review round.
2. **The ownership cross-check fix.** Add `workspace/foreign-worktree-owners.ts`
   (`collectForeignWorkspaceWorktreeIds`, fail-closed per its doc comment) and wire it into
   `project-context.ts` `build()` exactly as shown above, including the fail-closed `try`/`catch`
   that skips pruning entirely on a genuine verification failure. Depends on Phase 1 to have any
   production effect; independently unit-testable without it.
3. **Dirty/reachability backstop inside `pruneOrphans`.** Before hard-deleting any candidate not in
   `validIds`, classify it three ways instead of today's binary delete-everything: (a) a dirty
   working tree (`git status --porcelain` non-empty) → skip entirely, deleting neither directory nor
   branch — the arm that actually covers the 2026-08-21 incident's uncommitted-work loss; (b) clean
   but the branch holds a commit not reachable from the repo's checked-out `HEAD` → reclaim the
   directory only (`removeWorktree` called without the branch argument), keeping `cez/<id8>`, so
   nothing is leaked — matching the existing "directory only, branch kept" contract in
   `runs/retention.ts:148` / `index.ts:718-720`; (c) clean with no unique commits → today's behavior,
   directory and branch both removed. A branch that no longer exists makes the `merge-base
   --is-ancestor` check error rather than answer false; that is read as arm (c), not as a reason to
   skip, so a directory whose branch is already gone is still reclaimed rather than left forever.
   Lives entirely inside `git-worktree.ts`'s `pruneOrphans`, so it protects both existing call sites
   (`index.ts:710`, `project-context.ts:446`) with no change at either — this is what backs the
   "flagged, not asserted" posture on `index.ts` in the Solution section. Independent of phases 1-2;
   does not depend on the ownership check at all.
4. **Visibility.** Replace the silent `.catch(() => [])` around `pruneOrphans` with the
   log-on-success / warn-on-failure / warn-on-skip shown above (criterion 3). No behavior change on
   the happy path beyond the new log lines.
5. **Regression tests** (criterion 2) — see Verification below for the exact shape, including the
   wiring-guard test that Phase 1 depends on and the branch-reachability tests for Phase 3.
6. **Correct the record.** `.ai/specs/2026-08-19-parallel-workspace-runs-worktrees.md`'s W7 row
   currently reads *"Orphans are reclaimed by the existing per-project prune on next boot of that
   project's manager"* as the **Why** for "apply happens on success only". Per this repo's
   correction discipline (`CLAUDE.md` → "a correction marks what it invalidates, in place"), amend
   that cell in place: keep the Decision column text (still true — apply-on-success-only is
   unchanged), and replace the Why with a corrected line, e.g. *"~~Orphans are reclaimed by the
   existing per-project prune on next boot of that project's manager~~ — **corrected
   2026-08-22 by `2026-08-22-workspace-run-worktree-orphan-prune.md`**: that prune reads the
   *target* project's own store, which never holds a workspace run's record, so every orphaned
   workspace worktree read as legitimate work and was destroyed rather than reclaimed. See that
   spec for the actual reclaim path (the per-project prune now cross-checks the boot project's
   record and its own `bootRoot` wiring fix; count-based retention, unaffected, still reclaims old
   *finished* ones via `runs/retention.ts`)."* Leave the original sentence struck through rather
   than deleted, per the doctrine.

## Risks

- **Phase 1 activates a throwing guard for the first time in production.** `boot-root-conflict`
  (`project-context.ts:417-419`) has never fired in any real cezar process, since `resolveBootRoot()`
  has always returned `undefined` there (see Problem §4) — wiring `bootRoot: deps.repoRoot` at
  `server.ts:7112` means any registry row whose `root` equals the boot root starts failing to build,
  where before it silently didn't. Verified safe on this owner's install: the boot root is
  `/var/lib/cezar/workspace` (`cezar.service`'s `WorkingDirectory`), and none of the 12 rows in
  `/var/lib/cezar/.cezar/config.json` match it. Not guaranteed elsewhere — cezar ships as
  `@open-mercato/cezar` to installations whose registry this repo cannot see.
- **Extra file I/O per project's first context build.** One `readFile` per registered project
  (typically single digits to low tens on this owner's install) plus the boot root, once per
  project per process lifetime (cached implicitly by `build()` only ever running once — the
  `ProjectContexts` map memoizes the built context). Negligible; no polling, no repeat reads.
- **Fail-closed on a broken `runs.json` means a genuinely orphaned worktree in that one project
  waits an extra cycle, rather than being destructively pruned against an incomplete ownership
  set.** This is a deliberate trade against the previous draft's fail-open design, which degraded a
  corrupt or unreadable file to "nothing claimed here" — the same outcome as a project with no runs
  at all — silently reintroducing this spec's own bug for whichever project happens to have the
  broken file, with no signal that verification, not the check itself, is what failed. The cost is a
  temporarily-leaked orphan directory, not a false deletion; matches this repo's own instruction to
  "fail closed on any path that can lose money or data."
- **The dirty/reachability backstop (Phase 3) measurably reduces automatic branch reaping, not just
  in the narrow case this spec targets — but only its arm (a), the dirty-worktree check, protects the
  actual harm from the 2026-08-21 incident** (~40 minutes of *uncommitted* work, which leaves no
  unique commit for arm (b) to detect). Measured directly in this repo: `git branch --list 'cez/*'`
  returns 39 branches; 19 of them are **not** ancestors of `main` (`git merge-base --is-ancestor
  <branch> main`) — arm (b) candidates. Arm (b) reclaims the *directory* of each (`removeWorktree`
  without the branch argument, matching the existing `runs/retention.ts:148` / `index.ts:718-720`
  "directory only, branch kept" contract), so it leaks nothing; only arm (a) — a dirty worktree left
  entirely in place — carries a directory-disk cost, and only for as long as the worktree stays
  dirty and unowned. `HEAD` is used as the trunk proxy for arm (b) (matching `resolveBaseRef`'s own
  "current branch" fallback elsewhere in this file); a repo whose primary checkout is not on its
  trunk branch gets weaker or stronger protection than intended by this heuristic. No existing
  mechanism reclaims a branch left behind by arm (b) — it accumulates until someone or something else
  removes it, same as any `cez/*` branch does today once retention drops its worktree but keeps the
  branch (`runs/retention.ts`).
- **A known, adjacent, *not-closed* gap in the same failure class:** the write-ordering hole named
  above (`workflows/run.ts:3659-3662` persisting `workspaceWorktrees` only once, after
  `materializeWorkspaceWorktrees`'s whole loop finishes) can still let a freshly-created,
  brand-new-branch workspace worktree be pruned in the seconds before its record is written — and
  the Phase 3 backstop does not help there, because a brand-new branch has no unique commits yet to
  detect. Out of scope for this spec's phases (a `workflows/run.ts` change); recorded so it is not
  mistaken for closed by this spec's acceptance criteria.
- **A workspace run whose worktree was already reclaimed by count-based retention
  (`wt.reclaimedAt` set) but whose directory still exists on disk (a race between the two
  best-effort mechanisms) is treated as prunable.** This is intentional — `reclaimedAt` already
  means "retention considers this gone"; a directory that races back into existence after that
  stamp is exactly what orphan-prune exists to clean up, and this is no different from today's
  behavior for ordinary (non-workspace) worktrees. (The Phase 3 backstop does not protect it either
  in the common case: a reclaimed worktree that was never touched again has no unique commits beyond
  its base, by definition.)
- **This does not close the *general* class of "one project's context has stale information about
  another's state"** — it closes the one instance the acceptance criteria name, plus the
  branch-reachability backstop as a second, independent line of defense. If a future feature invents
  a second way for one project's worktree to be legitimately owned by another project's record, it
  will need the same treatment; `collectForeignWorkspaceWorktreeIds` is written generic enough
  (candidate-root list in, not "boot root" hardcoded) to extend rather than replace.

## Verification

Gates: `npm run typecheck`, `npm test` (or the package-scoped equivalents this repo's other 2026-08
specs cite), `npm run build`.

| Guard | File | Mutation that turns it red |
|---|---|---|
| **Wiring guard (Phase 1)** — booted through the real `startServer` path (never `createApp` directly — see below), a project-scoped HTTP request for a project registered with the same root as `deps.repoRoot` gets back the `boot-root-conflict` 409 the route layer maps at `server.ts:1949-1955` | `server/server.test.ts` or a new `server/boot-root-wiring.test.ts` | Remove `bootRoot: deps.repoRoot` from the `ProjectContexts` construction at `server.ts:7112` |
| `collectForeignWorkspaceWorktreeIds` finds a run id whose `workspaceWorktrees` entry targets the given root and is not reclaimed | `workspace/foreign-worktree-owners.test.ts` (new) | Drop the `resolve(wt.root) === target` check, or the loop entirely |
| It does NOT return an id whose matching entry has `reclaimedAt` set | same | Drop the `!wt.reclaimedAt` guard |
| It skips a candidate root with no `runs.json` (ENOENT) without throwing | same | Remove the `code === 'ENOENT'` branch |
| It THROWS `ForeignWorktreeOwnersError` for a candidate root whose `runs.json` exists but is unreadable or malformed — malformed meaning not a JSON array of objects with a string `id` — rather than degrading to empty | same | Revert to a blanket `catch { continue }` around the read/parse |
| A `runs.json` record carrying a field the contract's `runRecordSchema` would reject (e.g. missing `archived`, or a `workflowDef` shape the store's own `.catch(undefined)` would drop) is still read successfully, because `claimSchema` only validates `id` and `workspaceWorktrees` | same | Swap `claimSchema` back for the contract's `runRecordSchema` |
| **The regression test named in acceptance criterion 2** — a workspace run's worktree under project P survives a `ProjectContexts` build for P | `server/project-context.test.ts` (new `describe`) | Revert the `build()` change to the original `new Set(store.listRuns().map(r => r.id))` |
| A genuinely orphaned worktree (no record anywhere: not in P's own store, not in the boot store, not in any other registered project's store, and its branch has no unique commits) is still removed | same | Make the new cross-check unconditionally return the full directory listing (defeats pruning entirely) |
| The removal is logged (project id + removed ids), not swallowed | same, asserting on a `console.log` spy | Reinstate `.catch(() => [])` with no logging |
| A verification failure (unreadable/malformed foreign `runs.json`) skips pruning entirely for that project's build, rather than pruning against an incomplete set | `server/project-context.test.ts` (new) | Change the fail-closed `catch` to fall back to `foreignIds = new Set()` and prune anyway |
| **Dirty backstop, arm (a) (Phase 3):** `pruneOrphans` does NOT touch a directory/branch not in `validIds` when the worktree has a dirty `git status --porcelain` | `git-worktree.test.ts` (new) | Remove the `git status --porcelain` check from `pruneOrphans` |
| **Reachability backstop, arm (b) (Phase 3):** for a clean worktree not in `validIds` whose branch has a commit not reachable from `HEAD`, `pruneOrphans` removes the directory but keeps the branch (`removeWorktree` called without the branch argument) | same | Pass the branch argument unconditionally, or remove the `merge-base --is-ancestor` check |
| **Arm (c) (Phase 3):** for a clean worktree not in `validIds` whose branch has no unique commits, `pruneOrphans` DOES still delete both directory and branch (today's behavior, unaffected) | same | Invert the backstop condition |
| A candidate not in `validIds` whose branch no longer exists (already deleted) is treated as arm (c) — directory removed, not left forever as a skip | same | Treat a `merge-base` error as "has unique commits" (arm (b)/skip) instead of "no unique commits" |

**Wiring-guard test shape (Phase 1).** The previous draft's regression test constructed
`new ProjectContexts({ listProjects, bootRoot })` directly — which exercises `build()`'s *logic*
correctly but would stay green even if `server.ts:7112` never wired `bootRoot` at all, since the
test supplies it by hand. **`createApp` is not a safe substitute either, and must not be offered as
one**: `createApp` builds its own `bootRoot`-carrying `ProjectContexts` at `server.ts:1552-1566`
(`bootRoot = deps.repoRoot`, set at `:1400`) whenever the caller doesn't already pass `deps.contexts`
— so a test that calls `createApp` directly stays green whether or not `server.ts:7112` is wired,
reintroducing exactly the "green while prod stays broken" flaw this guard exists to close (`:7112`
is the only construction the real `startServer` entry point uses, and it sets `deps.contexts` before
`createApp` ever runs, which is precisely why `createApp`'s own `:1552` construction is dead in
production). The guard must go through **`startServer` only**.

`startServer` returns a `ServerType` and never exposes `sharedContexts`, so the assertion has to be
made over HTTP rather than by inspecting internal state: boot on an ephemeral port (`0`) and await
the `'listening'` event — the existing harness pattern in `server/automations-gate.test.ts:199-212`
— with `deps.repoRoot` set to a temp git repo and `deps.listProjects` resolving to a registry that
includes a project row whose `root` is that same temp repo. Issue a project-scoped request for that
project's id and assert the response is the `boot-root-conflict` 409 the route layer maps at
`server.ts:1949-1955` (`ProjectContextError('boot-root-conflict', ...)` thrown from
`project-context.ts:417-419`) — a response that is only reachable if `bootRoot` reached
`ProjectContexts` through the real production wiring, not a test fixture's shortcut. A sibling test
with the `bootRoot: deps.repoRoot` line reverted at `server.ts:7112` must reproduce today's bug (a
plain 404, not the 409), proving the guard actually exercises the wiring and not something else.
Name the file `server/server.test.ts` or a new `server/boot-root-wiring.test.ts` — not
`project-context.test.ts`, which is where a test would naturally drift back toward hand-constructing
`ProjectContexts` and silently stop exercising the wiring at all.

**Regression test shape** (criterion 2), modeled on the existing `bootRoot`-dependency test pattern
already in `project-context.test.ts` (`describe('ProjectContexts — boot-root duplication guard')`,
lines ~204-291) and the fixture-repo helper in `git-worktree.test.ts` (`fixtureRepo`, `git init` +
one commit):

1. Create two real git repos via `fixtureRepo`-style init: `bootRoot` (the workspace/boot scratch
   root) and `projectPRoot` (the target project, registered under id `p`).
2. Open a `RunStore` directly over `join(bootRoot, '.ai/cezar')` (as the duplication-guard test
   already does), `createRun(...)`, then `updateRun(id, { workspaceWorktrees: [{ root:
   projectPRoot, worktreePath: <P's WORKTREES_DIR>/<id>, branch: 'cez/<id8>', baseBranch: 'main' }]
   })`, `flush()`. Do **not** create any record for this id in P's own store — that is the shape of
   the bug.
3. Actually materialize the worktree on disk under P: `createWorktree(projectPRoot, id, 'main')`
   (real `git worktree add -b`), so the directory is a real, registered worktree — a bare directory
   would let `git worktree remove` no-op while `rm -rf` still deleted it, masking whether the fix
   or an accidental no-op saved it. Make at least one commit on the new branch (`autosaveCommit` or
   a direct commit) so the branch-reachability backstop (Phase 3) is not the thing silently saving
   this test — this test must isolate the ownership-check fix (Phase 2) specifically.
4. Build `new ProjectContexts({ listProjects: async () => [{ id: 'p', root: projectPRoot, status:
   'ok' }], bootRoot })` and call `contexts.context('p')`.
5. Assert: the worktree directory still exists (`existsSync`), `git branch --list cez/<id8>` in
   `projectPRoot` still shows the branch, and (mutation-testing the negative) a sibling test with
   `bootRoot` omitted from the constructor call reproduces today's bug — the worktree is gone —
   proving the test actually exercises the fix rather than something else keeping it alive.
6. A second case: same setup, but the run's `workspaceWorktrees` entry is stamped `reclaimedAt`, the
   branch is left with zero unique commits (so the Phase 3 backstop does not intervene), and the
   directory is deliberately left on disk (simulating the race named in Risks) — assert it IS
   removed, confirming the cross-check does not accidentally protect reclaimed entries forever.

**Dirty/reachability backstop test shape (Phase 3).** In a `fixtureRepo`-style repo, create a
worktree/branch pair via `createWorktree` with no owning record anywhere (the plain orphan case
`pruneOrphans` already handles), then exercise all three arms plus the missing-branch case:

1. **Arm (a), dirty.** Modify a tracked file in the worktree without committing (`git status
   --porcelain` non-empty), then call `pruneOrphans(repoRoot, new Set())`. Assert the directory,
   the branch, and the uncommitted change all survive untouched, and the returned array does not
   include this id — this is the arm that covers the incident's actual loss.
2. **Arm (b), clean + unique commits.** Commit at least one change on the branch inside the worktree
   (so the working tree is clean again), then call `pruneOrphans(repoRoot, new Set())`. Assert the
   directory is gone but `git branch --list cez/<id8>` in `repoRoot` still shows the branch, and the
   id IS included in the returned array (it was reclaimed, just not destroyed).
3. **Arm (c), clean + no unique commits.** A worktree freshly created via `createWorktree` with zero
   commits beyond its base (matching its own detached-then-branched state) and a clean working tree:
   `pruneOrphans` removes both the directory and the branch — today's behavior, unaffected — and the
   id is in the returned array.
4. **Missing branch.** Same as (3), but delete the branch out from under the worktree entry first
   (simulating a directory whose branch a prior pass already removed) — `git merge-base
   --is-ancestor` against a nonexistent branch must be read as "no unique commits" (arm (c)), so the
   directory is still reclaimed rather than the check erroring into a permanent skip.

**Runtime check (not blocking phases 1-5, but named per this repo's Definition of Done):** restart
the live cockpit process while a workspace run's worktree exists under a non-boot project, confirm
via the new log line that the project's context build ran and did **not** report that worktree as
pruned, and confirm the directory and branch are both still present after the restart.
