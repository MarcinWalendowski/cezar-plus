# A workspace run's per-project worktree is invisible to that project's own orphan prune, and gets destroyed — directory and branch

**Status:** draft — not yet implemented.

**Brief:** `.ai/specs/briefs/2026-08-22-workspace-worktree-orphan-prune-cross-project.md`. That
brief also flagged an in-flight duplicate: run `b3b5719c-ccf6-445c-9b97-39dd7eaf077e` was
independently investigating the same bug (from a second, 26-minutes-later todo,
`4a2e865e-f3aa-4f15-880e-0136b552ec9f` vs. `4227ba55-0b7c-4985-bf4c-4a9dabb0dc4e`). Verified at
the start of this step: this run (`43ab17aa`) started 7s earlier (06:51:46Z vs. 06:51:53Z) and
had already reached the spec-writing step while `b3b5719c` was still on its context/brief step
(its own brief: `.ai/specs/briefs/2026-08-22-workspace-run-worktree-orphan-prune.md`, written
into its own worktree, not yet on `main`). Sent it a message (`SendMessage`, msg
`794717bc-4708-406b-8106-44f2b6283916`) asking it to stand down in favor of this run rather than
shipping a second, possibly conflicting fix to the same files. It replied after finishing its own
spec anyway (`.ai/specs/2026-08-22-workspace-run-worktree-orphan-prune.md`, its own worktree, not
yet on `main`) — declining to self-stop unilaterally and leaving reconciliation to the
user/orchestrator, which is the right call for a peer to make. Its reply named one finding this
draft had missed at the time: **the boot root (`/var/lib/cezar/workspace`) is itself never a row
in `~/.cezar/config.json`** (`suppressBootRegistration()`,
`packages/cezar/src/registered-project-roots.ts:176`, unconditional `true`), so a candidate list
built from `listProjects()` alone can never see it. Independently verified before accepting it
(not taken on trust): `systemctl cat cezar.service` on this box shows
`WorkingDirectory=/var/lib/cezar/workspace`, and `/var/lib/cezar/.cezar/config.json` lists 12
registered projects (`loki-labs`, `anymail-mcp`, `aside`, `bubble-trade`, `career`, `career-kit`,
`cezar`, `chat`, `homebrew-tap`, `mw-site`, `brand`, `lokie-chatbox`) — `workspace` is not among
them. That makes it near-certain the ACTUAL 232ad6d4 incident fired through
`project-context.ts`'s `build('cezar')` (`cezar` is registered, its own `runs.json` never held
232ad6d4's record) rather than `index.ts`'s boot-project prune, and confirms a `listProjects()`-only
candidate list — this draft's first pass — would not have caught it. Folded into the design below
(see Solution/Architecture/Phase 3); credited to the peer's finding, verified independently
against this box's actual running service before being trusted. There is also a third, older,
unactioned todo on the same mechanism (`918a0d09-f13d-49fe-922e-75f7d6e9e791`, 2026-08-20T13:45Z,
predates the incident this task was filed from) — worth closing once one fix lands.

## TLDR

Every registered project's boot path runs `pruneOrphans(repoRoot, validIds)`
(`packages/cezar/src/git-worktree.ts:572-590`) before serving that project — once for the boot
project (`packages/cezar/src/index.ts:710-726`), once per other project on first access
(`packages/cezar/src/server/project-context.ts:444-453`, e.g. sidebar open). `validIds` is built
solely from `store.listRuns().map(r => r.id)` — **that project's own `runs.json`**. A parallel
WORKSPACE run (`.ai/specs/2026-08-19-parallel-workspace-runs-worktrees.md`) records its
per-project worktrees only on the run record in the **workspace's own** `runs.json`
(`workspaceWorktrees`, `packages/contract/src/runs.ts:160-173`) — the target project never gets
an entry of its own. So the moment the target project's boot runs (a routine cockpit
restart/deploy — cezar self-deploys on every green change), it sees a `cez/<id>` directory that
isn't in its own `runs.json` and deletes it — directory **and** branch
(`packages/cezar/src/git-worktree.ts:239-248`, `removeWorktree`, called with `--force` and
`git branch -D`). No safety check runs first.

This already caused confirmed, non-recoverable-by-git data loss: during run
`232ad6d4-58a5-421e-941f-5c24bd5a8452`, cezar's own worktree was reclaimed twice (21:53, 21:57)
by cezar's own boot-time prune firing on prod restarts; `git reflog cez/232ad6d4` in that repo
holds exactly one entry, `branch: Created from origin/main` — the branch carrying the run's
commits was deleted and silently recreated empty. The run survived only because a continuation
had already copied its work outside the pruned tree
(`/var/lib/cezar/workspace/.ai/cezar/runs/232ad6d4-recovery/README.txt` — the only record of
this incident anywhere, not mirrored into `.ai/specs/` or the KB).

The fix has two independent layers, both scoped to `pruneOrphans` only:

1. **Ownership visibility.** Before deleting a candidate, check every OTHER registered project's
   `runs.json` **plus the process's own boot root's `runs.json`** (read-only, via the existing
   `readRunIndexFromDisk`, `packages/cezar/src/runs/run-index.ts`) for a `workspaceWorktrees`
   entry that still claims this exact `{root, worktreePath}`. If one exists, decline and log why.
   The boot root must be checked explicitly and separately from `listProjects()` — it is
   deliberately never one of that list's rows (`suppressBootRegistration()`,
   `packages/cezar/src/registered-project-roots.ts:176`), and it is precisely where a workspace
   run's OWN record lives (`this.store` in `packages/cezar/src/workflows/run.ts:3659-3662` is the
   boot project's store). Confirmed on this box: `cezar.service`'s `WorkingDirectory` is
   `/var/lib/cezar/workspace`, which holds no row in `~/.cezar/config.json` — so the 232ad6d4
   incident's owning run was invisible to any check that consulted only the registered-project
   list.
2. **Branch-reachability safety net**, independent of layer 1 (covers the case where the
   ownership record itself is missing or unreadable — the failure mode layer 1 cannot see):
   before deleting a candidate's branch, verify it is fully merged into the repo's own current
   branch (`git merge-base --is-ancestor`). If it is not — the branch carries commits nothing
   else has — keep the branch and reclaim the directory only, exactly the "directory gone,
   branch kept" contract `packages/cezar/src/runs/retention.ts` already uses for finished-run
   retention.

The **registered** projects on this box (`cezar` and every product repo) live under the one
shared registry, `~/.cezar/config.json` (`packages/cezar/src/workspace/config.ts`,
`workspace/projects.ts`) — so "read another project's `runs.json`" is not a new capability; it
is the same primitive the workspace-level dashboard already uses in the opposite direction
(`packages/cezar/src/workspace/run-index.ts` reads every project's runs to build the
cross-project index). The **boot root** (`/var/lib/cezar/workspace` on this box) is deliberately
**outside** that registry — `suppressBootRegistration()` keeps it off the list on purpose — which
is exactly why layer 1 must check it separately, as its own explicit candidate, rather than
assuming the registry read already covers it (see Solution/Architecture, Phase 3). No new
pointer, no new cross-process protocol, no persisted schema change.

## Problem

### The prune has no idea a workspace run exists

`pruneOrphans` (`packages/cezar/src/git-worktree.ts:572-590`):

```ts
export async function pruneOrphans(
  repoRoot: string,
  validIds: ReadonlySet<string>,
): Promise<string[]> {
  await git(repoRoot, ['worktree', 'prune']);
  let entries: Dirent[];
  try {
    entries = await readdir(join(repoRoot, WORKTREES_DIR), { withFileTypes: true });
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || validIds.has(entry.name)) continue;
    await removeWorktree(repoRoot, worktreePathFor(repoRoot, entry.name), branchFor(entry.name));
    removed.push(entry.name);
  }
  return removed;
}
```

`validIds` never includes a workspace run's id in the TARGET project, because nothing writes it
there. `materializeWorkspaceWorktrees` (`packages/cezar/src/workspace/workspace-worktrees.ts:83-134`)
only ever calls `createWorktree(repoRoot, runId, base)` — a plain `git worktree add` inside the
target repo, no marker, no lock, no registry entry — and the run record it produces is persisted
by the WORKSPACE's own store (`this.store.updateRun(runId, { workspaceWorktrees })`, called from
`packages/cezar/src/workflows/run.ts:3659-3662`, where `this.store` is the workspace's
`RunStore`). The target project's own `store.listRuns()` (used to build `validIds` at both call
sites below) has no way to know that id exists.

`removeWorktree` (`git-worktree.ts:239-248`) then does this, unconditionally:

```ts
export async function removeWorktree(
  repoRoot: string,
  worktreePath: string,
  branch?: string,
): Promise<void> {
  await git(repoRoot, ['worktree', 'remove', '--force', worktreePath]);
  await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
  await git(repoRoot, ['worktree', 'prune']);
  if (branch) await git(repoRoot, ['branch', '-D', branch]);
}
```

`pruneOrphans` always passes `branchFor(entry.name)` as `branch` — force-deleting the branch
regardless of whether it carries commits nothing else has. `git branch -D` does not check merge
status.

### Two call sites, same blind spot

- Boot project — `packages/cezar/src/index.ts:710-726`, inside `serveCommand`, wrapped in
  `.catch(() => [] as string[])`.
- Every other registered project — `packages/cezar/src/server/project-context.ts:444-453`,
  inside `ProjectContexts.build()`, same `.catch(() => [] as string[])`, gated on
  `await getRepoInfo(project.root)`.

Both wrap the call in a swallow-all catch, but the deletions inside `pruneOrphans` already
happened before the catch fires — the wrapper protects boot from failing, not the worktree from
being deleted. Both fire independently of whether any workspace run using that project is still
active; a target project's boot is driven by that project's own restart/deploy schedule, which a
workspace run running against it has no visibility into or control over. cezar in particular
self-deploys the moment its own gates go green (`~/loki-labs/AGENTS.md`,
`.ai/specs/2026-08-19-spec-to-deploy-default-workflow.md`), so this fires routinely, not rarely,
on the one box where cezar tasks against the `cezar` repo itself are common.

### `pruneOrphans` has zero test coverage today

Confirmed by search: `packages/cezar/src/git-worktree.test.ts` (539 lines) has no
`describe('pruneOrphans'` block at all — every other exported function in the file
(`createWorktree`, `worktreeShortstat`, `resolveBaseRef`, …) does. This bug shipped, and would
have kept shipping, with the gates green.

## What the record already decided

- **`.ai/specs/2026-08-19-parallel-workspace-runs-worktrees.md`** (KB `specs-b031a8bc53a9`).
  Decision W7 assumed the gap didn't exist: *"Orphans are reclaimed by the existing per-project
  prune on next boot of that project's manager."* A 2026-08-20 header note on that same file
  already retracts this for **retention** (finished-run directory cleanup): *"The per-project
  prune this spec's Risks section relied on never reclaimed these. Retention now walks
  `workspaceWorktrees` too."* That retraction is about retention, not about orphan-prune
  actively **destroying** a live tree — this spec is the retraction the orphan-prune half still
  needs.
- **`.ai/specs/2026-08-20-workspace-run-worktree-isolation.md`** (KB `specs-f647a4038e21`),
  §3, IMPLEMENTED/SHIPPED. Fixed `reclaimWorktrees` (finished-run retention) to also walk
  `workspaceWorktrees` — `packages/cezar/src/runs/retention.ts:43-45,69-75`
  (`isWorkspaceReclaimable`, `selectReclaimableWorkspaceRuns`). Directory-only reclaim, branch
  always kept, gated on the run being **finished**. This is the template this spec's layer 2
  mirrors ("directory gone, branch kept"), but it solves a different failure: the owning process
  not cleaning up after itself, not a foreign process destroying a live tree mid-run. It is also
  scoped to a run this project's OWN store already knows about (retention iterates
  `store.listRuns()`) — it never had to solve cross-project visibility, because by the time
  retention runs the owning run is a normal row in `store.listRuns()`.
- **`.ai/specs/2026-07-18-worktree-retention.md`** (KB `specs-ad856d31abc8`). The general
  (non-workspace) retention spec: count-based, directory-only, branch always kept — explicitly
  rejected deleting branches (its Q2). `pruneOrphans` predates it and is a different, harsher
  mechanism: single-repo, directory-name-membership only, and it deletes the branch. Zero
  mentions of an unmerged-commit check anywhere in that file.
- **Nowhere in `.ai/specs/` or the KB corpus** does any spec make `pruneOrphans` aware of another
  project's or the workspace's `runs.json`, and nowhere is a branch-reachability check specified
  before a force branch delete. This is a genuine, previously undocumented gap.

## Solution

### Layer 1 — cross-project ownership check, read-only

New pure module, `packages/cezar/src/runs/worktree-ownership.ts`, modeled on
`runs/retention.ts`'s split of a pure selector from a thin I/O enforcer:

- `loadForeignWorkspaceRunSources(currentRoot, projects)` — for every OTHER registered project
  (excluding `currentRoot`, canonicalized the same way `git-worktree.ts`'s existing
  `canonicalPath` already does — exported for reuse, previously private), read its `runs.json`
  via the existing `readRunIndexFromDisk(join(root, '.ai/cezar'))`
  (`packages/cezar/src/runs/run-index.ts:24-41`). That reader is **already built for exactly
  this**: its own doc comment says it exists to answer "which tasks exist" without opening a
  store or triggering `manager.recover()` — the same property this check needs, since triggering
  recovery or resuming agents across every registered project on every OTHER project's boot
  would be its own new bug. Synchronous (`readFileSync`), and for its EXISTING caller (the
  workspace-level run index, a search feature) degrading to `[]` per project on any read/parse
  failure is benign — a project that can't be read just doesn't show up in a search box. **For
  this caller it is not benign: a delete-authorization gate that reads a bad index as `[]` reads
  it as "no owner," and the prune proceeds straight to `git worktree remove --force` + `git branch
  -D`.** Not hypothetical: `runRecordSchema` (`store.ts:120-...`) is a plain `z.object` with only
  four `.catch(...)` guards across roughly 190 lines, and `readRunIndexFromDisk` parses the whole
  file as one `z.array(runRecordSchema)` — one record failing that schema drops every record in
  the file, this run's included, not just the bad one. So `loadForeignWorkspaceRunSources` cannot
  simply call `readRunIndexFromDisk` and trust an empty result; it separately checks whether
  `<root>/.ai/cezar/runs.json` **exists and is non-empty** on disk. If it does and
  `readRunIndexFromDisk` still returned zero records, that source is marked `unreadable: true`
  rather than treated as "no owner" — a missing file, or a file that legitimately parses to `[]`,
  is the only case that still means "no owner." See Data models for the `ForeignRunSource` shape
  and Risks for what `pruneOrphans` does when a candidate source comes back `unreadable`.
- `findForeignWorkspaceOwner(repoRoot, worktreePath, foreignSources)` — pure, no I/O: scans every
  foreign project's runs for a `workspaceWorktrees` entry whose `{root, worktreePath}` matches
  (canonicalized). Returns `{ projectName, runId }` on a match, `undefined` otherwise.
  Deliberately does **not** filter by `run.status` — see Risks for why a `running`-looking record
  read cold can misleadingly show `status: 'failed'` (`reconcileLoadedRun`,
  `packages/cezar/src/runs/store.ts:598-627`) while `workspaceWorktrees` itself is untouched by
  that reconciliation, and why a still-present entry means "someone else still owns this" whether
  or not that someone has gotten around to cleaning it up.

`projects` is the same `{id, root, name}` shape both call sites already have on hand — see
Architecture. This is the ownership signal the acceptance criteria ask for: a project-local boot
consults the workspace's (and every other project's) `runs.json` directly, rather than a new
marker file needing its own lifecycle (create/clean-up-on-crash) inside the target worktree.

**Write-ordering hole this layer does not close on its own.** `materializeWorkspaceWorktrees`
(`packages/cezar/src/workspace/workspace-worktrees.ts:83-134`) creates worktrees for every
granted project inside one loop and returns only once every `createWorktree` call in that loop
has finished; the caller, `run.ts:3659-3662`, persists the whole `workspaceWorktrees` array in a
single `this.store.updateRun(runId, { workspaceWorktrees: worktrees })` call AFTER that loop
returns — plus `RunStore`'s own 300ms save debounce on top (`store.ts:1252`). On this box (12
registered projects, roughly ten distinct repos) each loop iteration does a `getRepoInfo` +
`resolveBaseRef` + `git worktree add`, so the FIRST project's worktree can sit on disk, fully
created, for several seconds before its own record exists anywhere layer 1 can read it. A prune
firing inside that window still finds an unrecorded, unowned-looking directory — and for a
just-created worktree, layer 2 does not save it either: a brand-new `cez/<id8>` branch has no
unique commits yet, so `isAncestorOf` reports it as merged and its branch is force-deleted right
alongside the directory. Closing this needs a persist callback (or the `RunStore` itself) threaded
into `materializeWorkspaceWorktrees` — but **not** one that appends the just-created entry per
iteration. The function dedupes through `byWorktreePath` (`workspace-worktrees.ts:88-118`): several
registry entries can collapse onto one worktree path (`collapsed.members.push(...); continue`),
and a LATER iteration can retroactively rewrite an already-emitted entry's `root` when it turns out
to be the repo-root ancestor of the incumbent (`collapsed.entry = { ...collapsed.entry, root:
repoRoot }`). Appending per iteration would therefore write duplicate `workspaceWorktrees` rows for
any repo with more than one registry entry (this box collapses 12 registry entries into roughly 10
worktrees) and leave a stale `root` on the incumbent row — and both `workspaceGrantOf` and the
apply-back path read that array directly. The callback must instead persist a **snapshot of the
current deduped entry set** after each successful `createWorktree` — `[...byWorktreePath.values()].
map(v => v.entry)`, the same expression the function's own final `return` already uses — so every
intermediate write is the same value the eventual return would produce for the work done so far,
never a partial append. Added as a Phase 3 step below.

### Layer 2 — branch-reachability safety net, independent of layer 1

New helper in `git-worktree.ts`, `isAncestorOf(repoRoot, ref, ancestorOf)`: wraps
`git merge-base --is-ancestor <ref> <ancestorOf>`, returning `true` only on a clean success.
Anything else — the ref doesn't resolve, the git call errors, an unsafe ref string — returns
`false`, the fail-safe direction (keep the branch).

`pruneOrphans` gains an optional `trunkRef` (the repo's own current branch, from the
already-existing `getRepoInfo(repoRoot).branch`). Before deleting a candidate's branch, it checks
`isAncestorOf(repoRoot, branchFor(id), trunkRef)`. If the branch is NOT an ancestor of the trunk
— it carries at least one commit the trunk doesn't have — `removeWorktree` is called **without**
the branch argument: directory reclaimed, branch kept, same shape `retention.ts` already uses.
Omitting `trunkRef` entirely (a caller that hasn't been updated, or a test exercising layer 1 in
isolation) defaults to the SAFE direction too — branch always kept — never silently reverting to
the pre-fix unconditional delete.

This is the second, orthogonal net the acceptance criteria ask for: it protects against layer 1's
signal being wrong or absent — the registry read failing, a project having been deregistered
mid-run, a marker-based alternative crashing before it wrote anything — by making "did this branch
carry unique work" the question actually asked immediately before the one irreversible operation
(`git branch -D`), rather than trusting any one upstream signal.

### Why not a marker file (open question 1 from the brief)

A marker written into `.ai/cezar/worktrees/<id>/` at `createWorktree` time was the brief's
option (a). Rejected: it is new state with its own lifecycle a crash can leave inconsistent (a
run that crashes between `createWorktree` and writing the marker leaves an unmarked-but-owned
tree — exactly the gap layer 2 exists to catch anyway), and it duplicates information
`workspaceWorktrees` already carries durably. Reading the existing registries directly (option
b/c collapsed into just b, since the registry read is cheap and synchronous once the project list
is in hand) needs no new write path, no new cleanup-on-every-exit-path obligation, and reuses a
primitive (`readRunIndexFromDisk`) already proven safe for exactly "read a project's runs
without owning it."

## Architecture

```
target project boot (index.ts serveCommand, OR project-context.ts ProjectContexts.build())
  → loadWorkspaceConfig() / already-fetched `projects`      (existing registry read)
  → candidates = [bootRoot (if any, != repoRoot), ...projects (!= repoRoot)]
      bootRoot: index.ts already IS the boot root (excluded by the != repoRoot filter);
                project-context.ts gets it from the ALREADY-COMPUTED `this.resolveBootRoot()`
                (`project-context.ts:394-398`, called earlier in `build()` for the boot-root-
                duplication guard) — the boot root is never a `listProjects()` row
                (`suppressBootRegistration`), so it must be added explicitly.
  → loadForeignWorkspaceRunSources(repoRoot, candidates)     [NEW] runs/worktree-ownership.ts
      → readRunIndexFromDisk(<candidate>/.ai/cezar)          (existing, runs/run-index.ts)
  → getRepoInfo(repoRoot).branch                             (existing, server/git.ts)
  → pruneOrphans(repoRoot, validIds, {                        [CHANGED] git-worktree.ts
      findForeignOwner: (path) =>
        findForeignWorkspaceOwner(repoRoot, path, foreignSources),   [NEW]
      trunkRef: repo.branch,
    })
      for each orphan candidate:
        owner = findForeignOwner(path)
        owner found  → DECLINE, log reason                    [NEW behavior]
        no owner     → isAncestorOf(branch, trunkRef)?          [NEW]
                          yes → removeWorktree(path, branch)   (today's behavior, now gated)
                          no  → removeWorktree(path)           [NEW: branch kept]
  → { removed: string[], declined: {id, reason}[] }            [CHANGED return shape]
```

Nothing changes about how a workspace run itself creates or applies back its worktrees
(`workspace-worktrees.ts`) — this spec only changes what the TARGET project's own boot considers
safe to delete. `retention.ts`'s finished-run reclaim is untouched (it already never deletes
branches and already walks `workspaceWorktrees` — spec 2026-08-20).

## Data models and API contracts

No persisted schema change — `workspaceWorktreeSchema`
(`packages/contract/src/runs.ts:160-173`) and `runRecordSchema`
(`packages/cezar/src/runs/store.ts:120-...`) are read-only inputs to this fix, unmodified. New
in-memory types only:

```ts
// packages/cezar/src/runs/worktree-ownership.ts
export interface ForeignRunSource {
  projectId: string;
  projectName: string;
  runs: RunRecord[];
  // True when `<root>/.ai/cezar/runs.json` exists and is non-empty but `readRunIndexFromDisk`
  // still returned zero records (corrupt file, or a record failing `runRecordSchema`'s
  // whole-array parse) — as opposed to no file at all, which legitimately means "no owner" and
  // leaves this `false`. See Solution/Layer 1 and Risks: a `true` here must make the ownership
  // check fail CLOSED (decline), not read as an empty, ownerless index.
  unreadable: boolean;
}
export function loadForeignWorkspaceRunSources(
  currentRoot: string,
  // Caller-assembled: every `listProjects()` row PLUS a synthetic entry for the boot root when
  // one exists and differs from `currentRoot` (Phase 3) — the function itself does not know
  // about boot roots or the registry; it only reads whatever candidates it is handed.
  projects: readonly { id: string; name?: string; root: string }[],
): ForeignRunSource[];
export function findForeignWorkspaceOwner(
  repoRoot: string,
  worktreePath: string,
  foreign: readonly ForeignRunSource[],
): { projectName: string; runId: string } | undefined;
```

```ts
// packages/cezar/src/git-worktree.ts — CHANGED
export function canonicalPath(path: string): string;   // was private; export, no behavior change

export interface PruneOrphansReport {
  removed: string[];
  declined: { id: string; reason: string }[];
}
export interface PruneOrphansOptions {
  findForeignOwner?: (worktreePath: string) => { projectName: string; runId: string } | undefined;
  trunkRef?: string;
  // Set by the caller when any `ForeignRunSource` it consulted came back `unreadable: true`
  // (worktree-ownership.ts). When true, EVERY orphan candidate for this boot is declined —
  // directory and branch both kept — without evaluating `findForeignOwner` or `isAncestorOf` at
  // all: an unreadable foreign index means the ownership signal cannot be trusted for ANY
  // candidate, not just the one whose owner happened to be behind the bad file. See Risks.
  ownershipCheckUnavailable?: { reason: string };
}
export async function pruneOrphans(
  repoRoot: string,
  validIds: ReadonlySet<string>,
  opts?: PruneOrphansOptions,
): Promise<PruneOrphansReport>;   // was Promise<string[]> — see Phase 2 for the two call sites this touches
```

No new CLI flag, no new HTTP route, no config knob. `PruneOrphansReport`/`removed` is a strict
superset of the old return's information (`removed` is the same array the old bare `string[]`
was), so both call sites need a one-line update (`.removed` instead of the bare result) rather
than a behavioral migration.

## Phases

**Phase 1 — pure ownership-check module, unit-testable in isolation.**
Add `packages/cezar/src/runs/worktree-ownership.ts` (`loadForeignWorkspaceRunSources`,
`findForeignWorkspaceOwner`) and export `canonicalPath` from `git-worktree.ts` (currently
private, `git-worktree.ts:119-126`). No wiring into `pruneOrphans` yet — ships and is tested on
its own. Independently shippable; satisfies none of the acceptance criteria alone but is the
foundation for AC1/AC2.

**Phase 2 — `pruneOrphans` gains the ownership check and the branch-reachability net.**
`git-worktree.ts:572-590`: change the signature to the `PruneOrphansOptions`/`PruneOrphansReport`
shapes above, add the `isAncestorOf` helper, and rewrite the loop body to (a) honor
`opts.ownershipCheckUnavailable` by declining every candidate outright and logging the given
reason, (b) otherwise consult `opts.findForeignOwner` before touching a candidate, logging and
skipping on a match, and (c) gate the branch argument to `removeWorktree` on
`isAncestorOf(branch, opts.trunkRef)`, defaulting to "keep the branch" when `trunkRef` is omitted.
Independently testable against hand-built `findForeignOwner`/`trunkRef`/`ownershipCheckUnavailable`
fakes, no real registry needed.

This phase also updates its own two call sites' TYPES, as a no-behavior-change step so the repo
stays green at the end of the phase rather than typechecking red until Phase 3: `index.ts:712-718`
and `project-context.ts:444-453` both currently do `orphans.length` / `orphans.map(...)` against
the old bare `string[]` and type their `.catch(...)` fallback as `[] as string[]` — both become
`.removed` / `{ removed: [], declined: [] }` here, with no new options passed in yet (so behavior
is unchanged: `opts` stays `undefined`, `pruneOrphans` still falls back to today's unconditional
delete). The actual wiring — foreign sources, the boot root, `trunkRef`, decline logging, and the
`server.ts:7112` prerequisite — is Phase 3.

Once unit-tested, this phase alone satisfies AC2 (the mechanism is stated and testable) and AC3
(decline is logged; branch is never deleted without the ancestry check passing) — and, together
with its call-site type updates, ships as a complete, typecheck-green, behavior-preserving step on
its own, independently shippable ahead of Phase 3's actual wiring.

**Phase 3 — wire both call sites, boot root included.**
- **Prerequisite, without which this phase ships green and changes nothing in production:
  `deps.bootRoot` does not actually reach `ProjectContexts` today.** `startServer`
  (`packages/cezar/src/server/server.ts:7101-7116`) builds `sharedContexts = deps.contexts ?? new
  ProjectContexts({ listProjects, semaphore, automationStore })` — no `bootRoot` key — and passes
  that object into `createApp` as `deps.contexts` (`:7123-7126`). `createApp`'s OWN `deps.contexts
  ?? new ProjectContexts({ ..., bootRoot })` (`:1552-1566`) is therefore dead code: the `??` never
  evaluates its right side because `sharedContexts` is already non-`undefined` by the time it gets
  there. `index.ts:762` is the sole non-test `startServer` caller, so this is not a test-only gap —
  `this.resolveBootRoot()` returns `undefined` in the actual running process. Left unfixed,
  everything else in this phase's `project-context.ts` bullet below — capturing the boot root,
  adding it to the candidate list — silently degenerates to a `listProjects()`-only check, which is
  the exact shape that would NOT have caught the 232ad6d4 incident (see the Brief note at the top).
  This phase must therefore also add `bootRoot: deps.repoRoot` to the `new ProjectContexts({...})`
  construction at `server.ts:7112`. See Risks for a side effect of doing so.
- Threading the write-ordering fix from Solution/Layer 1: `materializeWorkspaceWorktrees`
  (`workspace-worktrees.ts:83-134`) has **two** production callers, both with the identical
  after-the-loop persist, and both need the same persist-callback fix — `run.ts:3659-3662` (the
  initial materialize on run start) AND `run.ts:3116-3123` (the resume path: `const live =
  (record?.workspaceWorktrees ?? []).filter((w) => existsSync(w.worktreePath)); if (live.length
  === 0) { … this.store.updateRun(runId, { workspaceWorktrees: worktrees }) }`, which
  re-materializes from scratch whenever none of a resumed workspace run's previously-recorded
  worktrees still exist on disk). The second one matters more for this bug than the first: the
  232ad6d4 incident's SECOND reclaim (21:57) came after the run had already been interrupted once
  and resumed, i.e. through exactly this path, not through the initial-materialize path. Pass a
  per-entry persist callback (or the `RunStore` directly) through both call sites into
  `materializeWorkspaceWorktrees`, and call it immediately after each `createWorktree` succeeds
  inside the loop — passing it a **snapshot of the current deduped entry set**
  (`[...byWorktreePath.values()].map(v => v.entry)`, per Solution/Layer 1 above), not the raw
  just-created entry — rather than doing one `this.store.updateRun(runId, { workspaceWorktrees })`
  after the whole loop returns. Closes the window where the first-created worktree in a
  multi-project grant is unrecorded — and unmerged, so layer 2 can't save it either — for as long
  as the remaining projects take to materialize, on EITHER path.
- `packages/cezar/src/server/project-context.ts:400-453` (`ProjectContexts.build()`): `projects`
  is already fetched at line 401 for other purposes — reuse it. `this.resolveBootRoot()` is
  ALSO already called earlier in the same method (line ~417, for the boot-root-duplication
  guard) — capture that value too rather than re-deriving it. Capture `repo` from the existing
  `getRepoInfo(project.root)` call (line 445, currently only checked for truthiness) to get
  `repo.branch`. Build the candidate list as `[...projects, ...(bootRoot ? [{ id: '__boot__',
  name: 'workspace boot', root: bootRoot }] : [])].filter(p => canonicalPath(p.root) !==
  canonicalPath(project.root))`, then `foreignSources =
  loadForeignWorkspaceRunSources(project.root, candidates)`, and pass `{ findForeignOwner: (p) =>
  findForeignWorkspaceOwner(project.root, p, foreignSources), trunkRef: repo.branch }` into
  `pruneOrphans` (the `.catch(...)` fallback's shape was already updated in Phase 2). Log
  `declined` entries the same way `index.ts` already logs `removed`/`reclaimed` counts (see
  below) — currently this call site's `pruneOrphans` result is discarded entirely regardless of
  shape (`.catch(() => ...)` with no read of the resolved value), so this phase also adds the
  first logging this call site has ever had for a decline. **This is the call site that actually
  failed in the
  232ad6d4 incident** (see the Brief note): `cezar` is a registered project, so `projects` alone
  was never going to be the gap — the boot root was, and this is the fix for it.
- `packages/cezar/src/index.ts:710-726` (`serveCommand`): this call site's own `repoRoot` IS the
  boot root, so it needs no separate boot-root candidate (the `!= repoRoot` filter drops it if
  added anyway) — only the registered-project list. Fetch the raw registry cheaply via
  `loadWorkspaceConfig()` (`packages/cezar/src/workspace/config.ts`, `.projects`) rather than the
  workspace-level `listProjects()` (which additionally shells out a `git status`/branch probe per
  project via `probeRoot` — unneeded cost on the hot boot path, and this call site only needs
  `{id, root, name}`). `repo` is already resolved just above at line 708. Same wiring as
  project-context.ts, plus a new `console.log` line for `declined.length > 0`, matching the
  existing `orphans.length > 0` / `reclaimed.length > 0` log style at lines 715-717/723-725. Kept
  in scope even though the confirmed incident went through the other call site: a workspace run
  can in principle be initiated from a NON-boot registered project context too (not verified
  either way in this pass — see Risks), in which case its record lives in THAT project's
  `runs.json`, reachable from `index.ts`'s own prune via the ordinary registered-project check
  this call site already had.

This phase satisfies AC1 (the actual behavior change: an in-flight run's worktree survives) end
to end at both boot paths — including the specific shape the real incident took — and completes
AC3's logging requirement.

**Phase 4 — regression tests.**
- Unit tests for `findForeignWorkspaceOwner`/`loadForeignWorkspaceRunSources` in
  `packages/cezar/src/runs/worktree-ownership.test.ts`, mirroring `retention.test.ts`'s minimal
  fixture-builder pattern (`run(partial)` helpers) — no real git needed, pure data.
- Unit tests for the branch-safety net and the new `pruneOrphans` shape in `git-worktree.test.ts`,
  alongside the existing `describe('createWorktree recovery (real git)')` block, using the same
  `fixtureRepo()` helper (real git, temp dir): a true orphan with an unmerged branch keeps the
  branch and loses the directory; a true orphan whose branch has no unique commits is deleted
  exactly as today; a candidate with a `findForeignOwner` match is declined and the directory
  survives untouched.
- **The end-to-end regression the acceptance criteria specifically ask for**, in
  `packages/cezar/src/server/project-context.test.ts`, built in the EXACT shape the real
  incident took (see the Brief note and Phase 3). Note this file's existing fixtures are all
  `status: 'not-git'` temp dirs with no real store behind them — a real-git-plus-`RunStore`
  fixture is new to this file (`fixtureRepo()` itself lives in `git-worktree.test.ts` and
  `runs/retention-*.test.ts`), and this file's own boot-root guard test already realpaths its temp
  root FIRST (`rootA = mkdtempSync(join(realpathSync(tmpdir()), 'cez-ctx-boot-'))`,
  `project-context.test.ts:213`) because the guard compares realpath'd roots — this test's fixture
  roots need the same treatment or a symlinked `/tmp` (macOS) makes the comparison miss for reasons
  unrelated to the bug under test. Two real temp git repos (`fixtureRepo()`
  style) — one standing in for the **unregistered boot root**, one for "the target project" (a
  normal `listProjects()` row, id `'target'`). A real `RunStore.open(join(bootRoot, '.ai/cezar'))`
  with a `createRun(...)` + `updateRun(id, { status: 'running', workspaceWorktrees: [...] })`
  recording a worktree inside the TARGET repo (mirroring what `materializeWorkspaceWorktrees`
  really persists — using the real store, not a hand-authored `runs.json`, guarantees schema
  validity for free); a `cez/<id8>` worktree actually created in the target repo (`createWorktree`)
  with a unique commit on it (so it is provably not merged into trunk, exercising layer 2 as well
  if layer 1 were ever bypassed); a `ProjectContexts` built with `bootRoot` set to the boot fixture
  root and `listProjects` returning ONLY the target fixture root (deliberately NOT the boot
  root — matching `suppressBootRegistration`, and the precise condition that made the peer's
  correction necessary: a candidate list built from `listProjects()` alone must NOT be sufficient
  for this test to pass); then `contexts.context('target')` (the exact boot path
  `ProjectContexts.build()` runs, with the target's own `runs.json` knowing nothing about this
  run — reproducing the bug's precondition exactly). Assert both `existsSync` on the worktree
  directory and `git show-ref --verify refs/heads/cez/<id8>` in the target repo still succeed
  afterward. A second variant of the same test with `bootRoot` omitted from `ProjectContexts`
  deps confirms the OLD (pre-boot-root-fix) design would still have failed — i.e., this test only
  passes because the boot root is checked explicitly, not merely because SOME cross-project check
  exists. This is the AC4 test; it fails against `main` today (no `findForeignOwner` wiring exists
  at all) and would ALSO have failed against a `listProjects()`-only fix (this draft's first pass);
  it passes once Phases 1-3, boot-root inclusion included, land.
- **A separate assertion for the production wiring itself, since the AC4 test above cannot catch
  it.** That test constructs `new ProjectContexts({ listProjects, bootRoot })` directly, so it
  passes whether or not `server.ts:7112` actually threads `bootRoot` through `startServer` — it
  exercises the boot-root check once wired, not whether production wires it. Add a test (near
  `server.ts`'s own tests) that asserts the `ProjectContexts` instance `startServer` builds actually
  carries a boot root: either inject a `contexts` factory spy via `deps.contexts` and assert it
  observes a boot root, or assert structurally on `startServer`'s own construction the way
  `run-index.test.ts` asserts on source text (grep the source for a `bootRoot:` key inside the
  `new ProjectContexts({...})` call at that line). This is the test that fails if the
  `bootRoot: deps.repoRoot` wiring line is ever dropped from `server.ts:7112`; the AC4 integration
  test alone would still pass green in that regression.

## Risks

- **A finished-but-not-yet-cleaned-up workspace run keeps its target worktree alive slightly
  longer.** `findForeignWorkspaceOwner` does not check `run.status` — a workspace run that
  finished and successfully applied/discarded its trees no longer has a matching entry (the
  applying/discarding code already removed the directory before any of this runs — see
  Architecture), so this only matters for a workspace run that finished but crashed before its
  own finalize path ran. In that case the target's `pruneOrphans` now declines to touch it, where
  today it would silently delete it. That is the correct trade for this bug: the crashed run's
  own next resume/cleanup pass is what should reconcile that state, not a foreign project's boot
  guessing. Bounded by retention: if the crashed run truly never resumes, its directory (not
  branch — retention never deletes branches either) still eventually gets swept by this project's
  own `reclaimWorktrees` once the crashed run's record is visible there — which it never will be,
  since it's not this project's run. This is a genuine, narrow leak (a worktree from a permanently
  abandoned foreign run, in a project whose registry entry was never removed, accumulates
  forever) — out of scope for this spec's three acceptance criteria, which are about not
  destroying LIVE work; flagging it as a follow-up rather than silently absorbing scope.
- **A corrupt foreign `runs.json` now suspends orphan reclaim for that boot instead of destroying
  trees.** This is the deliberate trade behind `ForeignRunSource.unreadable` (Data models,
  Solution/Layer 1): `readRunIndexFromDisk`'s existing degrade-to-`[]` is fine for its original
  caller (a search index — a project that can't be read just doesn't show up) but is fail-OPEN for
  a delete-authorization gate, since `[]` and "this project genuinely owns nothing here" are
  indistinguishable once inside `pruneOrphans` unless something upstream tells them apart. Because
  `readRunIndexFromDisk` parses one project's entire `runs.json` as a single `z.array(...)`, a
  single record failing `runRecordSchema` blinds the check for every OTHER run recorded in that
  same file, including a live workspace run's `workspaceWorktrees` entry — the exact class of
  incident this spec exists to close, reopened through a different door. So the fix goes the other
  way: any candidate source that is provably non-empty-but-unparseable makes `pruneOrphans` decline
  **every** orphan candidate for that boot (`ownershipCheckUnavailable`), not just the one behind
  the bad file, and log why. The cost is availability, not safety: a box with one corrupt project
  index stops reclaiming ANY orphan directory anywhere until that index is fixed, which is
  the correct side to fail on for an operation this irreversible — a stalled prune is a disk-space
  nuisance one project's `runs.json` explains; a wrongly-executed one is the 232ad6d4 incident
  again. A missing file (no `.ai/cezar/runs.json` at all — a project this box has literally never
  run against) is not this case and reclaims normally, since there is nothing there to fail to
  parse.
- **Wiring `bootRoot` into `startServer` (Phase 3's prerequisite fix) also activates a second,
  currently-inert guard.** `ProjectContexts.build()` already throws
  `ProjectContextError('boot-root-conflict')` when a registered project's root resolves to the
  same path as `deps.bootRoot` (`project-context.ts:417-419`, spec 2026-08-15-duplicate-project-
  context-wipes-runs) — but since `deps.bootRoot` is never actually set in production today (see
  Phase 3), that guard has never fired outside its own tests. Once `server.ts:7112` passes
  `bootRoot: deps.repoRoot`, any registered project whose root equals the boot root starts getting
  a hard 409 on `context(id)` instead of silently opening a second `RunStore` over the same
  `.ai/cezar` directory. Safe on this box: no row in `~/.cezar/config.json` names
  `/var/lib/cezar/workspace` (verified — 12 rows, none of them `workspace`), so no registered
  project can collide with the boot root here. An install that DOES register the boot root under
  its own project id would start seeing this 409 where it previously (silently, dangerously)
  didn't — worth a release note alongside this change, not a reason to withhold the wiring fix.
- **Perf: an extra registry read + N `readRunIndexFromDisk` calls per boot.** Only paid when
  `pruneOrphans` actually has orphan candidates to consider (the existing early-return on an
  empty/missing worktrees dir is untouched) — not on every boot. `readRunIndexFromDisk` is a
  synchronous, uncached local file read with no store overhead; on this box, "every other
  registered project" is single digits. `index.ts`'s call site deliberately uses the cheap
  `loadWorkspaceConfig()` rather than the probing `listProjects()` for this reason (see Phase 3).
- **A deregistered project's workspace run becomes invisible to layer 1.** If a NON-boot
  registered project holding a workspace run's grant were ever removed from `~/.cezar/config.json`
  mid-run, `loadForeignWorkspaceRunSources` would not find it, and layer 1 would not decline.
  Layer 2 (the branch-reachability net) is the backstop for exactly this: the branch survives
  regardless, independent of whether layer 1's signal was available. Only the directory would be
  lost in this scenario — recoverable from the branch via `createWorktree`'s existing reattach
  path (`git-worktree.ts:192-208`). The BOOT root's own equivalent gap — the one that actually
  caused the 232ad6d4 incident — is closed directly by Phase 3 rather than left to layer 2, since
  the boot root is deterministically knowable (`resolveBootRoot()`) and never merely "a project
  that happened to get deregistered."
- **Layer 2's `isAncestorOf` check compares a candidate branch against the repo's CURRENT branch,
  not the worktree's own recorded `baseBranch` — a real, unquantified cost until now.** Any
  orphaned branch whose work landed upstream via squash-merge or rebase is provably not an
  ancestor of trunk even though its work IS upstream, and a genuinely abandoned orphan is never an
  ancestor either — both classes keep their branch forever, with nothing in this spec bounding
  that accumulation (already named as a narrow leak two bullets above, for the directory side;
  this is the branch-side version, and it is not narrow). Measured today in
  `/var/lib/cezar/loki-labs/cezar`: of 39 existing `cez/*` branches, only 20 are ancestors of
  `main` (`git merge-base --is-ancestor <branch> main` in a loop over `git branch --list
  'cez/*'`) — so layer 2, as specified, would roughly HALVE how many branches `pruneOrphans` can
  still reap after this change lands, not merely add a narrow edge case. The current branch was
  chosen over the recorded `baseBranch` deliberately, not by oversight: a plain (non-workspace)
  orphan has no recorded `baseBranch` at all, so a check keyed on it would have nothing to compare
  against for most candidates, and comparing against the current branch only ever errs toward
  KEEPING a branch it shouldn't (never toward deleting one it should keep) — the correct direction
  for an operation this irreversible, even though it leaves the accumulation named here as an
  explicit, out-of-scope follow-up rather than something this spec's three acceptance criteria
  require it to solve.
- **Whether a workspace run can be initiated from a NON-boot registered project, not just the
  boot root, was not established in this pass.** If it can, that run's record lives in the
  initiating project's own `runs.json`, which `index.ts`'s prune already reaches via the ordinary
  registered-project check (Phase 3 keeps that call site's candidate list, unchanged from the
  first draft) — no gap either way, but the claim itself is unverified; flagging rather than
  asserting it either way.
- **`reconcileLoadedRun` cold-reads a genuinely still-running workspace run's status as
  `'failed'`** (`store.ts:598-627`, `!opts?.keepLive` branch — `readRunIndexFromDisk` never passes
  `keepLive`). This is read-only on the copy `readRunIndexFromDisk` hands back (per its own doc
  comment, "these records were just parsed into fresh objects that nothing else holds a reference
  to") — it never writes back to the workspace's real `runs.json`, and does not touch
  `workspaceWorktrees`. Called out explicitly because a status of `'failed'` might look, at a
  glance, like grounds to treat the run as finished-and-abandoned; the ownership check
  deliberately ignores status entirely so this cannot cause a live run's tree to read as
  reclaimable.
- **Scope discipline.** This spec does not change `retention.ts`'s existing "branch always kept"
  invariant (already correct, untouched), does not add a marker-file mechanism (rejected above),
  and does not address the leak described in the first Risk bullet — none are required by the
  four stated acceptance criteria.
- **Duplicate in-flight investigation.** See the Brief note at the top — `b3b5719c` may still
  land a second, differently-shaped fix to the same files if it does not stand down in response
  to the message sent. If both land, whichever merges second will conflict at
  `packages/cezar/src/git-worktree.ts` and `project-context.ts` and need manual reconciliation;
  not something this spec can prevent from inside a single run.

## Verification

1. **Unit — `worktree-ownership.test.ts` (Phase 1/4).** `findForeignWorkspaceOwner` matches on
   exact `{root, worktreePath}` (canonicalized), ignores non-matching projects, ignores run
   status, returns `undefined` when no foreign source claims the path. `vitest run
   packages/cezar/src/runs/worktree-ownership.test.ts`.
2. **Unit — `git-worktree.test.ts`, new `describe('pruneOrphans (real git)')` block (Phase 2/4).**
   Three real-git cases: (a) true orphan, branch fully merged into trunk → both directory and
   branch gone (today's behavior, now explicit and covered for the first time); (b) true orphan,
   branch carries a unique commit → directory gone, branch survives (`git show-ref --verify`
   succeeds); (c) `findForeignOwner` returns a match → directory AND branch both survive, and the
   returned report's `declined` array names the id and reason. `vitest run
   packages/cezar/src/git-worktree.test.ts`. Note on AC3's wording: AC3 says a deleted branch must
   never carry "commits not reachable from its base"; case (b) here tests against the repo's
   CURRENT branch instead (Solution/Layer 2, Risks explains why) — a strictly stronger bar than the
   literal wording for a branch that has been rebased past its original base, so passing this test
   satisfies AC3 without being a literal transcription of it.
3. **Integration — `project-context.test.ts`, the AC4 test (Phase 4).** As described in Phase 4:
   boot a real `ProjectContexts` for a target project whose OWN `runs.json` has never heard of the
   run, while a second, real `RunStore`-backed "workspace" project's `runs.json` still claims the
   worktree. Assert the directory and the `cez/<id8>` branch both survive `contexts.context('target')`.
   Run it once against pre-Phase-3 code to confirm it fails (reproduces the bug), then again after
   Phase 3 lands to confirm it passes. `vitest run packages/cezar/src/server/project-context.test.ts`.
   Note: this test constructs `ProjectContexts` with `bootRoot` supplied directly, so it verifies
   the boot-root check works once wired but cannot by itself verify that `server.ts:7112` actually
   wires it in production — that is the separate wiring test from Phase 4, and it is the one that
   actually fails if the `bootRoot: deps.repoRoot` line is ever dropped from `startServer`.
4. **Gates.** `npm run typecheck` / `npm run lint` / `npm test` (root) — the `pruneOrphans`
   signature change touches exactly two call sites (Phase 3), both updated in the same phase, so
   no other caller should need changes; typecheck is what confirms that claim rather than a grep.
5. **Manual, on a box that reproduces the original incident's timing (recommended, not blocking
   for the four ACs above):** start a workspace run granting the `cezar` project, let it create
   its worktree, then trigger this project's own boot path a second time (e.g. open the sidebar
   for a different already-registered project, or restart the dev server) while the workspace run
   is still mid-flight. Confirm the worktree and branch are both still present afterward, and that
   a `declined to reclaim` log line appears. This is the live-timing scenario the automated AC4
   test simulates without needing an actual second cezar process.
