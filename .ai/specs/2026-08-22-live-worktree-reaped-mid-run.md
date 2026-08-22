# A live task's worktree is deleted out from under it, mid-run, with its uncommitted work

**Status:** specced, not implemented. **Date:** 2026-08-22. **Severity:** data loss, recurring,
four confirmed incidents in one day on `prod-host`.

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
project*. Nine restarts today. With N concurrent workspace tasks, each task's deploy sweeps the
other N-1 tasks' live trees. One task deploying a stale artifact disarms the guard protecting all
the others.

The fix is in two independent halves, and **neither depends on the other**:

- **Kill the trigger.** The artifact must say what it is. A build stamp inside `dist/`, and a
  deploy that refuses to ship an artifact whose stamp disagrees with the source HEAD, or to
  activate a release older than the live one without `--rollback`.
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
fleet ran it 9 times today and got it wrong once, which was enough.

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

With N tasks deploying their own HEADs, an ancestor deploy silently reverts whatever landed since.
There is no monotonicity check before the symlink flip. `--rollback` exists and is the honest way to
go backwards; nothing makes it the only way.

### P4 — `pruneOrphans` deletes uncommitted work

`pruneOrphans` (`packages/cezar/src/git-worktree.ts:622-660`) removes a candidate with
`removeWorktree(...)` → `git worktree remove --force` + `rm -rf` (`git-worktree.ts:242-251`).
**No `autosaveCommit` first.** Its sibling on the run-ending path,
`discardWorkspaceWorktrees` (`packages/cezar/src/workspace/workspace-worktrees.ts:295-327`), gets
this right: it autosaves, and if the autosave returns `refused`/`failed` it **keeps the directory**
so nothing uncommitted is lost. The prune path never learned that discipline, so untracked files —
a spec being drafted, an unstaged fix — are gone with no recovery point.

Pre-fix, it also passed the branch to `removeWorktree`, so `git branch -D cez/<id8>` destroyed the
one artifact a continuation could re-materialize from. Layer 2 of the predecessor spec keeps the
branch unless ancestry proves it merged; that is right, and should simply be unconditional on this
path.

### P5 — the removal is invisible where it matters

`index.ts:740` logs `cleaned N orphaned worktree(s)` for the **boot** project. `project-context.ts:466-473`
logs only `declined` — never `removed`. Workspace worktrees live in **project** repos, so the only
call site that touches them writes nothing when it deletes. Attributing today's incident took an
hour of forensics on mtimes and reflogs because the destructive event left no trace.

Corollary: `journalctl | grep -i reap` returning nothing is not evidence that nothing was reaped.
The absence of a log line here is unprovable, which is its own defect.

### P6 — ownership is a cold snapshot, and it is fail-open

`findForeignWorkspaceOwner` answers "is this live?" by cold-reading every *other* registered
project's `runs.json` at context-build time, plus the workspace boot root's. Three ways that is
weaker than it looks:

1. **Unknown means delete.** A candidate no source claims is removed. The safe default for an
   irreversible sweep is the opposite.
2. **It cannot see a different boot root.** A second cezar server reaches the same real project
   roots with its own boot root. There is one alive on the box right now:
   `node packages/cezar/dist/index.js --port 43037 --repo /var/lib/cezar/loki-labs/cezar/.ai/cezar/worktrees/fd1f214d-…`,
   up since 2026-08-21 21:40. Its ownership view can never include production's boot root.
3. **It ignores the filesystem's own evidence.** `eb9f65aa`'s tree had three live `vitest` processes
   running inside it when it was swept. A directory a process is standing in is not an orphan, and
   nothing asks.

### P7 — the sweep runs at the worst possible moment

It runs during boot, per project, before `recover()` has finished re-materializing and re-claiming
anything. Its purpose is **disk reclamation**, which has no deadline at all. Running it seconds
after a restart buys nothing and costs exactly the race that fires here.

---

## Solution

Two independent halves. Ship P0 first; it converts data loss into recoverable inconvenience and
depends on nothing else in this spec.

### Half A — the artifact is self-describing, and the deploy checks it

**A1. Build stamp.** `npm run build` writes `packages/cezar/dist/.build-stamp.json`:

```json
{ "sha": "<git rev-parse HEAD at build time>", "builtAt": "<ISO>", "dirty": true|false, "version": "0.10.0" }
```

**A2. The deploy refuses a stale artifact.** Before `stage()`, `server-deploy` reads the stamp from
`--source` and refuses, non-zero with a named reason, when any of:

- the stamp is missing → `"<source>/packages/cezar/dist/.build-stamp.json` is absent — run `npm run build` first"`;
- `stamp.sha !== <source HEAD>` → names both shas and the fix;
- `stamp.dirty === true` and `--allow-dirty` was not passed;
- any tracked file under `packages/*/src` is newer than `stamp.builtAt`.

Escape hatch: `--allow-stale-artifact`, which logs loudly and records `"stale": true` in the
ledger. **Fail closed:** an unreadable stamp is a refusal, never an assumed HEAD.

**A3. The release id and the ledger come from the stamp, not from HEAD.** `releaseId`,
`deploy.json.sha` and the in-band `deploy` field name the sha the artifact was **built** from. A
`--sha=` argument is cross-checked against the stamp, never trusted over it. After this, "the
running server is serving this HEAD" is a claim about the running code, which is what every probe
already believes it is asserting.

### Half B — no silent backwards deploy

**B1.** Before the symlink flip, compare the incoming stamp sha with the live sha from
`deploy.json`. If `git merge-base --is-ancestor <incoming> <live>` and the two differ, refuse unless
`--rollback` / `--allow-rollback`. Fail closed: if either sha cannot be resolved in the source repo,
refuse.

**B2.** A refusal names the live sha, the incoming sha, and `--rollback` as the deliberate way
through. Forward deploys and genuine rollbacks are both unaffected.

### Half C — the sweep fails closed

**C1. Autosave before deleting; keep the directory if the autosave does not commit.** In
`pruneOrphans`, before `removeWorktree`, call `autosaveCommit(worktreePath, 'run finalize')`. On
`refused` or `failed`, push a `kept` outcome and **do not delete** — byte-for-byte the discipline of
`discardWorkspaceWorktrees` (`workspace-worktrees.ts:306-314`). Every untracked byte then reaches
the `cez/<id8>` branch before the directory goes.

**C2. Never delete the branch on the prune path.** Remove `pruneOrphans`'s branch-delete entirely.
A branch is bytes; it is the only thing a continuation can re-materialize from. Deliberate branch
deletion stays with retention.

**C3. Liveness lease, next to the thing it protects.** The owning server writes
`<repoRoot>/.ai/cezar/worktree-leases/<runId>.json` when it materializes a worktree, and re-stamps
it on a heartbeat while the run is live:

```json
{ "runId": "...", "ownerBootRoot": "/var/lib/cezar/workspace", "ownerPid": 3066180,
  "ownerReleaseId": "20260822T131749Z-504ce87f", "heartbeatAt": "<ISO>" }
```

`pruneOrphans` declines any candidate whose lease heartbeat is younger than `LEASE_STALE_MS`
(15 min, ~15 heartbeats of slack), **and declines on an unreadable or unparseable lease**. This
moves the authority off cross-project bookkeeping and onto the repo that owns the directory, so it
holds for a pruner with a different boot root, a second server, or any process that can read the
filesystem. Leases live **outside** `worktrees/` on purpose: a directory inside it would be a prune
candidate to any build that predates this spec.

**C4. Log every removal, and make the log line provable.** `project-context.ts` logs `removed` the
way `index.ts` already does. When a removed id matches a known run record, also append a run event
and publish it, so a reap is visible in the cockpit and not only in the journal. The verification
below includes a deliberate orphan whose removal **must** appear — otherwise "no reap logged" and
"logging broken" stay indistinguishable.

**C5. Defer the sweep past boot.** Run the per-project prune on a timer ~5 minutes after the
context is built, not inline with `build()`. `recover()` has re-materialized and re-leased by then.
Disk reclamation has no deadline; the boot race is pure downside.

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
        ├─ ancestor of live?      ──yes─► REFUSE   │     refused/failed?  ──► KEEP     (C1)
        │                          (unless          ├─ removeWorktree(dir only)        (C2)
        │                           --rollback)     └─ log removed + run event         (C4)
        ├─ rsync ─► /opt/cezar-releases/<id>
        ├─ smoke-boot, flip symlink, restart
        └─ deploy.json.sha := stamp.sha  (A3)      scheduled ~5 min after context build (C5)
```

## Data models

- `packages/cezar/dist/.build-stamp.json` — `{ sha, builtAt, dirty, version }` (A1).
- `<repoRoot>/.ai/cezar/worktree-leases/<runId>.json` — `{ runId, ownerBootRoot, ownerPid, ownerReleaseId, heartbeatAt }` (C3).
- `/opt/cezar-releases/deploy.json` entries gain `builtAt` and `stale?: true` (A3, A2 override).
- `PruneOrphansOptions` gains `leaseDir?: string` and `leaseStaleMs?: number`.
- `PruneOrphansReport.declined[].reason` gains the lease reasons; `removed` becomes the logged half.

## API contracts

- `GET /api/v1/ready` and `/api/v1/health`: `deploy` gains `builtAt` and `artifactSha`; `sha`
  becomes the artifact's sha (A3). Additive except that `sha` now means something stricter — it can
  only ever have been *more* wrong before.
- `cezar server-deploy` gains `--allow-stale-artifact`, `--allow-dirty`, `--allow-rollback`.
  Existing invocations are unchanged when the source was actually built from its HEAD.

## Phases

| Phase | Content | Independent? |
|---|---|---|
| **P0 — stop the loss** | C1 autosave-before-delete, C2 never delete the branch, C4 log removals | yes, ship first |
| **P1 — honest artifact** | A1 build stamp, A2 deploy refusal, A3 ledger from the stamp | yes |
| **P2 — no rollback by accident** | B1, B2 | needs P1's stamp |
| **P3 — fail-closed sweep** | C3 leases + heartbeat, C5 deferred sweep | yes |
| **P4 — visibility** | in-band `builtAt`/`artifactSha`, reap run events | needs P1, P0 |

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
  conflict-marked trees, so it will decline exactly the cases where committing would be wrong — and
  C1 turns that decline into "keep the directory", which is the safe side.

## Verification

Every step below is executable and has a negative control. Nothing here is aspirational.

**P0 — unit, `packages/cezar/src/git-worktree.test.ts`**

1. Create a real repo + `cez/<id8>` worktree, write an **untracked** file into it, call
   `pruneOrphans(repo, new Set(), { trunkRef: 'main' })`. Assert: directory gone, branch present,
   and `git show cez/<id8>:<file>` returns the file's content. *Negative control:* the same
   assertion must fail when C1 is stubbed out — add the stub as an explicit test seam and assert
   the failure, so the test cannot pass against the pre-fix behaviour.
2. Worktree left mid-merge (conflict markers present) → outcome `kept`, directory still on disk,
   nothing committed.
3. Assert `pruneOrphans` never invokes `git branch -D` (spy on the git runner and assert the exact
   argv is absent — not that the branch "still exists", which a merged-branch path could satisfy
   for the wrong reason).
4. `project-context` test: a removal produces a `removed` log line naming the id. *Negative
   control:* a run with zero candidates produces **no** line, so the assertion is not vacuous.

**P1/P2 — integration, `packages/cezar/src/server-install/release-deploy.test.ts`**

5. Stamp sha ≠ source HEAD → deploy exits non-zero, message names both shas. Stamp sha == HEAD →
   proceeds (the control that proves the gate is not simply always-refuse).
6. **Replay the real incident:** a source tree whose `dist/.build-stamp.json` predates its HEAD by
   one commit, exactly as `20260822T131126Z-504ce87f` did → refused.
7. Missing stamp → refused. Unreadable stamp → refused (fail closed, not "assume HEAD").
8. `deploy.json.sha` equals the **stamp** sha, not the source HEAD, when `--allow-stale-artifact`
   forces a stale ship. This is the assertion that makes the ledger honest.
9. Live = descendant, incoming = ancestor → refused; with `--rollback` → allowed; incoming sha
   unresolvable → refused.

**P3 — unit + integration**

10. Fresh lease → declined **with `validIds` empty and `findForeignOwner` returning `undefined`**.
    The point is that it holds with every other signal removed; a fixture where ownership also
    matches proves nothing.
11. Lease older than `LEASE_STALE_MS` → eligible. Corrupt/truncated lease JSON → declined.
12. Heartbeat keeps updating for the life of a run; the lease is removed on a clean settle.

**Runtime E2E on `prod-host` — the authoritative gate**

13. Start 3 concurrent workspace runs across ≥2 repos. Snapshot
    `find /var/lib/cezar/loki-labs/*/.ai/cezar/worktrees -maxdepth 1 -mindepth 1` and every
    `cez/*` ref.
14. Deploy forward once. Re-snapshot: **zero** worktrees or branches belonging to a live run
    removed.
15. Attempt an ancestor deploy from a second checkout → must be refused, and the live release must
    not change.
16. Attempt a deploy from a checkout that merged `origin/main` without rebuilding → must be refused
    with the stale-artifact reason. This is the exact failure that caused the incident.
17. Create a genuinely orphaned worktree directory (no run, no lease) and confirm the next sweep
    removes it **and logs it**. Without this the whole log-based verification is unfalsifiable.
18. `find /var/lib/cezar -not -user cezar | wc -l` → `0` before ending the session.

**Field evidence this spec must be able to explain afterwards** — re-run the forensics that produced
it and get a different answer: no release in `deploy.json` whose `dist/` predates its own sha, and
`journalctl -u cezar.service | grep "removed .* worktree"` accounting for every directory that
disappeared.

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
