# Yes, a workspace run worktrees every project — and two of the twelve share one tree

> **Status:** implemented (code + automated coverage) — **QA needed**: the runtime E2E in
> § Verification has not been run. Answers a question, then fixes the four defects the answer
> exposed.
> · **Date:** 2026-08-20
> **Extends:** `2026-08-19-parallel-workspace-runs-worktrees.md` (implemented; the model it
> describes is live and correct). This spec does **not** replace it — it closes the gaps between
> what that spec assumed and what the owner's twelve-project registry actually does.
> **Reads on:** `2026-08-15-cross-project-workspace-run.md` (D2/D4/D7 already amended in place
> there), `2026-08-20-chain-integrity-restart-and-continuation.md` (whose fix is why apply-back
> is gated behind `pendingChainSteps`).

## The question this started as

> *"if we run task in workspace, do we create a worktree? or do multiple sessions work on the
> same files?"*

**Answer, measured on the live prod box 2026-08-20, not inferred:**

**We create worktrees. One per registered project, per run — not one shared tree.** A workspace
run materializes `<project>/.ai/cezar/worktrees/<runId>` on branch `cez/<id8>` for every granted
git project, grants those *worktree* paths to the agent instead of the real checkouts, and applies
each diff back into the real checkout when the run settles successfully. Three workspace runs were
live simultaneously while this spec was written (`a1be9ae3`, `3bc55a31`, `23221162`), each holding
its own tree in each project — so workspace runs are genuinely parallel, and they do **not** edit
each other's files.

Three qualifications, each of which is a defect below, not a design:

1. **Two of the twelve projects share a tree.** `loki-labs`, `brand` and `lokie-chatbox` are three
   registry entries inside **one** git repo, so the run's `workspaceWorktrees` has **12 entries but
   10 distinct paths** — one path repeated three times (measured on `a1be9ae3`). Apply-back then
   runs three times over the same tree, concurrently, and races. **§ Problem 1.**
2. **The knowledge mount IS shared, at its real path.** `notion-export` is granted to every
   concurrent run as `/var/lib/cezar/loki-labs/notion-export` — the real directory, no worktree.
   For that one path the answer to "do multiple sessions work on the same files?" is **yes**.
   **§ Problem 4.**
3. **Only a successful settle cleans up.** A failed, cancelled or stopped run leaves all twelve
   trees and branches on disk forever. **§ Problem 2 / 3.**

## Problem

Everything in this section was measured on the prod install, from `runs.json`, the run NDJSON
transcripts, and `git worktree list` — not from reading the code and reasoning forward.

### 1 — Sibling projects in one repo share a worktree, and their apply-back races

The registry (`~/.cezar/config.json`) holds twelve projects. Ten are their own git repos; `brand`
and `lokie-chatbox` are **subdirectories of the `loki-labs` repo** registered as separate projects,
and `loki-labs` itself is the eleventh entry.

`materializeWorkspaceWorktrees` (`packages/cezar/src/workspace/workspace-worktrees.ts:50`) calls
`createWorktree(project.root, runId, base)` per project, and `createWorktree` computes its path
from the **repo root** it resolves to (`git-worktree.ts:153`,
`join(canonicalPath(repoRoot), WORKTREES_DIR, runId)`). So all three entries resolve to the same
path. Measured on this run:

```
entries: 12   distinct: 10
SHARED x3: /var/lib/cezar/loki-labs/.ai/cezar/worktrees/a1be9ae3-…
```

At settle, `applyWorkspaceWorktrees` fires every entry concurrently (`Promise.all`,
`workspace-worktrees.ts:172`) and `applyOne` (`:117`) does, in order: `existsSync(worktreePath)` →
`autosaveCommit` → `git diff --binary base HEAD` → `serializeByRoot(wt.root, …)` → `git apply` →
`removeWorktree`.

The serialization keys on **`wt.root`** (`:132`), which is different for all three
(`/loki-labs`, `/loki-labs/brand`, `/loki-labs/lokie-chatbox`) — so it does not serialize them
against each other. All three pass the `existsSync` gate together; whichever wins applies and
**removes the shared worktree**; the losers then run `git diff` with a cwd that no longer exists.
`execFile` fails with empty stderr, so the report is `failed` with a blank reason.

This is not hypothetical. From run `be31d9e9`'s own transcript:

```
note  applied changes to /var/lib/cezar/loki-labs/cezar
note  no changes in /var/lib/cezar/loki-labs/brand
note  /var/lib/cezar/loki-labs/lokie-chatbox: failed on apply — kept worktree branch cez/be31d9e9 (diff failed: )
```

and identically in `ec6e8e06`: `failed on apply — kept worktree branch cez/ec6e8e06 (diff failed: )`.
The same session flagged the symptom without finding the cause: *"an apply-back failure with an
empty error message… the diagnostic is blank."*

The consequence is a **phantom conflict on every workspace run**: `applyWorkspaceRun`
(`run.ts:4282-4310`) keeps `conflict`/`failed` entries and re-persists them, so the finished record
carries a leftover pointing at a directory that no longer exists. Measured — three finished runs,
each with a leftover, each of them `lokie-chatbox`:

| run | status | `workspaceWorktrees` left | path exists? |
|---|---|---|---|
| `ec6e8e06` | done | 1 — `lokie-chatbox` | **no** |
| `be31d9e9` | done | 1 — `lokie-chatbox` | **no** |
| `ef9901e3` | done | 2 — `cezar`, `lokie-chatbox` | **no** (both) |

A latent second bug sits behind the race: even if `brand` won, `git apply` would run with
`cwd = /var/lib/cezar/loki-labs/brand` against a patch whose paths are relative to the repo root
(`workspace-worktrees.ts:140-146`). `git apply` resolves paths against the cwd, so it would apply
into the wrong place or reject. It has never been reached because the race always kills it first.

### 2 — Apply-back runs on success only; every other ending leaks twelve trees

`applyWorkspaceRun` has exactly one call site: `run.ts:4341`, inside `settleSuccess`
(`run.ts:4312`), and even that returns early when the chain-integrity guard finds pending steps
(`run.ts:4322-4338`). A run that ends `failed`, `cancelled`, or via a `stopReason` never applies
back **and never removes anything**. Spec 2026-08-19 **W7** chose "apply on success only" on
purpose — applying a half-finished run is worse than not — but it left the *cleanup* half
unowned, which was not the intent: W6 says the branch is the recovery artifact for a **conflict**,
not for every abort.

### 3 — Retention never reclaims a workspace worktree, so they accumulate without bound

`reclaimWorktrees` (`runs/retention.ts:112`) iterates runs and skips any without
`run.worktreePath` — the single-repo field. `workspaceWorktrees` is a different field and no
reclaimer reads it. `removeWorktree`'s callers are `retention.ts:112`, `server.ts:5286/5298/5380`
and `workspace-worktrees.ts:129/148`; the first four are all keyed on `run.worktreePath`.

Measured accumulation right now, with `worktreeRetentionDefault: 10` in force and doing nothing:

```
chat        6 worktrees / 6 cez branches
cezar       5 worktrees / 5 cez branches
anymail-mcp, aside, bubble-trade, career, career-kit, homebrew-tap, mw-site   3 each
```

Two of the residents belong to `23221162`, a run whose record still says `running` since 14:23 and
which is not alive. Spec 2026-08-19's Risks section costed this at "12 worktrees per run × up to 10
parallel" and assumed the per-project prune would reclaim orphans (**W7**); it does not, because
that prune is the `run.worktreePath` one.

### 4 — The knowledge mount is granted to every concurrent run at its real path

`buildWorkspaceGrant` correctly substitutes worktree paths for project roots
(`granted-roots.ts:96`), and `dedupeContainedRoots` (`:100`) collapses the three duplicates for
`--add-dir`. But the knowledge-base roots are a **separate** contribution to the same list
(`run.ts:3888-3893`, `...(stepProfile.knowledgeSummary?.roots.map((r) => r.path) ?? [])`) and are
never worktree-mapped. `CEZ_KB_ROOTS` (`run.ts:941`) does the same.

So `/var/lib/cezar/loki-labs/notion-export` — 2110 documents, the corpus that IS the record — is
handed writable to every concurrent workspace run at its real path. This run's own environment
confirms it: `notion-export` appears in the working-directory list as the real path while all
twelve projects appear as worktrees. Nothing has corrupted it yet because the write protocol is
append-only NDJSON to a per-run `CEZ_KB_WRITE_FILE`, which is exactly the mitigation that makes it
safe — but that safety is a convention agents are asked to follow, not an isolation boundary, and
the spec that established the grant never said so.

### 5 — The route's own documentation still describes the superseded model

`packages/cezar/src/server/workspace-run-routes.ts:24-28` still says a workspace run takes the boot
lease and runs one at a time. That has been false since 2026-08-19. It is the first thing a reader
of the workspace-run entry point sees.

## Solution

Five changes, none of which alters the model — the model is right. In order of severity:

1. **Deduplicate the worktree map by worktree path.** `materializeWorkspaceWorktrees` returns at
   most one entry per distinct `worktreePath`; sibling registry entries that resolve to the same
   repo collapse into the one entry whose `root` is the **repo root** (so `git apply`'s cwd is
   correct by construction, closing the latent bug too). The dropped siblings are named in a note
   so the transcript still accounts for all twelve projects.
2. **Clean up on every terminal ending, apply on success only.** Keep W7's rule about *applying*;
   add a `discardWorkspaceWorktrees(runId)` on `failed`/`cancelled`/`stopped` that leaves the
   `cez/<id8>` **branch** (nothing is lost, the work is recoverable) and removes the **directory**.
3. **Teach retention about `workspaceWorktrees`.** `reclaimWorktrees` reclaims workspace worktree
   directories under the same `keep`-last-N rule it applies to `run.worktreePath`, branch kept.
   This is what bounds the disk cost spec 2026-08-19 flagged and mispriced.
4. **Say the knowledge mount is shared.** It stays shared — worktreeing a 2110-document corpus per
   run is not worth it, and the append-only write protocol is the right mechanism. Make it
   explicit in `workspaceGrantSystemPrompt` (the one path that is NOT isolated, and why), and
   record the decision so the next reader does not assume isolation covers it.
5. **Correct the stale comment** at `workspace-run-routes.ts:24-28`.

### Decisions

| # | Decision | Why |
|---|---|---|
| **X1** | Dedupe by `worktreePath`, keeping the entry whose `root` is the resolved **repo root** | One tree, one apply, one cwd that git can resolve. Keeping a *subdirectory* root instead would preserve the `git apply` cwd bug. |
| **X2** | Dropped siblings are reported as a note, not silently discarded | Twelve projects were granted; a transcript that accounts for ten reads as a bug. The note names which entries collapsed into which tree. |
| **X3** | Non-success endings **discard** the directory, **keep** the branch | Splits W6/W7 correctly: the branch is the recovery artifact and costs bytes; the checkout is the thing that costs gigabytes. Nothing becomes unrecoverable. |
| **X4** | Retention reclaims workspace worktree **directories**, never their branches | Matches the existing `run.worktreePath` reclaimer's contract exactly (`retention.ts` — "branch kept"), so there is one rule, not two. |
| **X5** | The KB mount stays shared and real-pathed; the prompt says so out loud | Isolating it is expensive and pointless given the append-only protocol; leaving it undocumented is what makes it dangerous. Zero-config: no new knob. |
| **X6** | `applyOne` reports a non-empty reason on every failure path | `(diff failed: )` cost a previous session an investigation that ended in "the diagnostic is blank". A blank error is a defect in its own right. |

### Owner amendments, 2026-08-20 (mid-implementation)

Three calls made by the owner after the spec was written; each changes what shipped.

| # | Amendment | What it changed |
|---|---|---|
| **O1** | *"propose a fix for 1, but I still want to run agents in root"* | X1 stands, and the collapse deliberately keeps the **repo root itself granted**: the surviving entry is rooted at the repo root, so the agent can work at the top of the `loki-labs` checkout exactly as before. The collapsed siblings are not merely named in a note (X2) — `buildWorkspaceGrant` maps each to its **matching subdirectory inside the shared tree** (`<worktree>/brand`), so all twelve projects keep a path of their own and `dedupeContainedRoots` still collapses them to one `--add-dir`. Without that mapping the dropped siblings would have fallen back to their REAL checkouts: a silent isolation leak, worse than the race being fixed. |
| **O2** | *"knowledge can be shared, but we should use only local cezar knowledge base"* | X5 stands (the mount stays shared and real-pathed), and the prompt paragraph is stronger than "here is a caveat": the knowledge roots are declared **read-only**, and the local cezar knowledge base — reached by appending to the per-run `CEZ_KB_WRITE_FILE` — is named as the only thing an agent writes. The convention is now stated, not assumed. |
| **O3** | *"retention should be much bigger: like last 1000 worktrees"* | `DEFAULT_WORKTREE_RETENTION` 10 → 1000, and `resources.worktreeRetentionDefault` 10 → 1000 (already the schema's `max`). X4 makes the enforcer reach twelve directories per workspace run instead of one per ordinary run, so a keep-10 budget would start reclaiming trees a user might still want after a handful of runs. Retention exists to stop disk saturating, not to garbage-collect recent work — and it only ever removes the directory, never the branch. |

## Architecture

```
execute()  ─ isWorkspaceRun ──► materializeWorkspaceWorktrees(runId, projects)
                                  ├─ per project: getRepoInfo → createWorktree
                                  ├─ NEW dedupeByWorktreePath()          ← X1/X2
                                  │     keep root === repo root; note the collapsed siblings
                                  └─ persist record.workspaceWorktrees   (10 entries, not 12)

settleSuccess() ─ pendingChainSteps empty ─► applyWorkspaceRun
                                              └─ per entry, serializeByRoot(root):
                                                   autosave → diff → git apply --3way → removeWorktree
                                                   failure detail is never empty          ← X6

settleFailure()/cancel()/stop()  ─► NEW discardWorkspaceWorktrees        ← X3
                                      remove directory, keep cez/<id8>

retention.reclaimWorktrees(keep)  ─► ALSO walks run.workspaceWorktrees   ← X4
                                      remove directory, keep branch, stamp reclaimed
```

Nothing changes in `pump()`, the lease exemption, or the grant construction — all three are
correct today and verified live by three concurrent workspace runs.

## Data models

`workspaceWorktreeSchema` (`packages/contract/src/runs.ts:160-169`) is unchanged in shape. One
optional field is added so a reclaimed workspace worktree is distinguishable from a leaked one:

```ts
// contract/src/runs.ts — workspaceWorktreeSchema
reclaimedAt: z.string().optional(),   // set when retention removed the directory; branch survives
```

The store's inline duplicate (`packages/cezar/src/runs/store.ts:355-364`, whose comment already
says "keep the two in sync") gets the same field.

No API contract changes: `POST /workspace/runs` and the run record's public shape are untouched.

## Phases

Each phase is independently shippable and independently green.

1. **Dedupe the worktree map (X1/X2/X6).** `workspace-worktrees.ts` only. Collapse by
   `worktreePath`, prefer the repo-root entry, emit the collapse note, and give every `failed`
   report a non-empty detail. This alone removes the phantom conflict from every workspace run and
   is the highest-value change in the spec.
2. **Discard on non-success endings (X3).** `discardWorkspaceWorktrees` in
   `workspace-worktrees.ts`, wired into the failure/cancel/stop settles in `run.ts`. Stops new
   leaks.
3. **Retention reclaims workspace worktrees (X4) + the `reclaimedAt` field.** `runs/retention.ts`,
   `contract/src/runs.ts`, `runs/store.ts`. Drains the leaks already on disk.
4. **Prompt + docs (X5, § Problem 5).** The shared-KB-mount paragraph in
   `workspaceGrantSystemPrompt`; correct `workspace-run-routes.ts:24-28`; mark this spec's answer
   in `2026-08-19-parallel-workspace-runs-worktrees.md` as extended in place.
5. **Backfill the untested seams.** Spec 2026-08-19 shipped without tests for the `pump()` non-git
   exemption or the lease skip (`nonWorkspaceInPlaceBusy` and `isWorkspaceRun` appear only in
   `run.ts`; no case in `run.test.ts`, `run-lease.test.ts`, `run-isolation.test.ts`). Add them —
   they are the guarantee that makes parallel workspace runs work at all.

## Risks

- **Collapsing twelve grants to ten trees changes what the agent is told.** `brand` and
  `lokie-chatbox` currently get a line each in the prompt pointing at the loki-labs tree; after
  X1 they must still be named (X2) or the agent will not know they are in scope. The collapse note
  is load-bearing, not decoration — the failure mode is silent scope loss, which is exactly the
  failure AGENTS.md § "Changing a mechanism that already works" describes.
- **Discarding a failed run's directory is irreversible for uncommitted work.** Mitigated by
  `autosaveCommit` before discard, so the branch holds everything — but if the autosave itself
  fails the discard must be skipped, not forced. Fail closed.
- **Retention deleting a live run's worktree.** `selectReclaimableWorktrees` already filters to
  *finished* runs; the workspace walk must reuse that selector rather than growing its own, or a
  running workspace run loses its tree mid-flight.
- **This spec does not isolate the KB mount.** That is a deliberate accepted risk (X5), not an
  oversight. If two runs ever write the corpus directly instead of through
  `CEZ_KB_WRITE_FILE`, they will clobber each other and nothing here prevents it.

## Verification

Every guard names the mutation that turns it red. `packages/cezar/src/workspace/workspace-worktrees.test.ts`
already builds throwaway git repos; the new cases extend that harness.

| # | Guard | File | Mutation that must turn it red |
|---|---|---|---|
| 1 | Two registry entries inside one repo produce **one** worktree entry, rooted at the repo root | `workspace-worktrees.test.ts` | Return the raw per-project list from materialize |
| 2 | The collapsed siblings are named in a note | same | Drop the note |
| 3 | Apply-back over a repo with sibling entries reports exactly one outcome, never `failed (diff failed: )` | same | Restore the pre-dedupe list |
| 4 | Every `failed` report carries a non-empty `detail` | same | Return `detail: ''` |
| 5 | A failed/cancelled/stopped run removes its worktree directories and **keeps** `cez/<id8>` | same + `workflows/run*.test.ts` | Skip `discardWorkspaceWorktrees`; separately, delete the branch too |
| 6 | A successful run still applies then removes (2026-08-19 behaviour intact) | existing cases at `:93/:120/:137` | — must stay green unchanged |
| 7 | Retention reclaims workspace worktree dirs of finished runs, keeps branches, stamps `reclaimedAt` | `runs/retention.test.ts` | Skip the `workspaceWorktrees` walk |
| 8 | Retention never touches a **running** workspace run's worktree | same | Bypass `selectReclaimableWorktrees` |
| 9 | `pump()` runs N workspace runs concurrently on a non-git boot root | `workflows/run*.test.ts` (new) | Restore `repo !== null \|\| busySlots() < 1` for workspace runs |
| 10 | A workspace run does not take the repo-root lease; an ordinary run still does | same (new) | Reinstate `acquireRepoRoot` for workspace runs |
| 11 | The prompt states the KB mount is shared and real-pathed | `granted-roots.test.ts` | Remove the paragraph |

**Gates:** `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:unit`, `npm run build`,
`npm run test:package`.

### What shipped, guard by guard

| # | Where it landed |
|---|---|
| 1 | `workspace-worktrees.test.ts` — *collapses them to ONE worktree entry, rooted at the repo root* |
| 2 | same — *names the collapsed siblings in a note rather than dropping them silently* |
| 3 | same — *applies back exactly once — never a phantom `failed (diff failed: )`* |
| 4 | same — *never returns an empty detail, whatever git wrote to its streams* (+ the not-a-worktree case). `failureDetail` is exported for exactly this: the empty-stream case cannot be provoked from a real git without a race |
| 5 | same — *removes the directory and KEEPS the branch* / *fails CLOSED* ; end-to-end in `workflows/workspace-parallel.test.ts` — *removes the directory, keeps cez/<id8>, and leaves no leftover entry on the record* |
| 6 | the three pre-existing `applyWorkspaceWorktrees` cases, unchanged and green |
| 7 | `runs/retention.test.ts` (selector) + `runs/retention-enforce.test.ts` — *reclaims a finished workspace run in every repo it touched*, across two repos, neither of which is the enforcer's own `repoRoot` |
| 8 | `retention-enforce.test.ts` — *never reclaims a workspace run that is still running, even when it is the over-limit one* (the live run is the OLDER of the two, so a bypassed selector would delete it) |
| 9 | `workflows/workspace-parallel.test.ts` — *runs two at once on a NON-GIT boot root, where two ordinary in-place runs serialize* |
| 10 | same — *overtakes an ordinary in-place run that holds the tree — which still takes the lease itself* |
| 11 | `granted-roots.test.ts` — *states that the knowledge mount is shared and real-pathed, and is not written directly* |
| O1 | `granted-roots.test.ts` — *maps a sibling registry entry to its SUBDIRECTORY of the shared repo worktree* (+ the shared-prefix guard) |

**Still QA-needed.** Every runtime step in the numbered E2E list above is unrun: the defect this
spec fixes was invisible to every unit test and visible in one line of a production transcript, so
"green" is necessary and not sufficient. Until a real Workspace task settles with an empty
`workspaceWorktrees` and a transcript free of `(diff failed: )`, this is *qa needed*, not done.

**Runtime E2E on the live cockpit — the part that is not optional.** The defect this spec fixes was
invisible to every unit test and visible in one line of a production transcript, so the acceptance
evidence must come from a real run:

1. Submit a Workspace task. When it settles, its record's `workspaceWorktrees` must be **absent or
   empty** — no leftover entry pointing at a path that does not exist. Today three finished runs
   carry exactly that leftover (`ec6e8e06`, `be31d9e9`, `ef9901e3`).
2. Its transcript must contain **no** `failed on apply — … (diff failed: )` line, and must name all
   twelve projects across `applied` / `no changes` / collapsed-sibling notes.
3. `git worktree list` in `chat` and `cezar` must not grow run over run; after retention runs, the
   pre-existing orphans (`23221162`, `3bc55a31`, `6af4b894`, `7c2dd8f0`) must be gone as
   directories with their `cez/*` branches still present.
4. Submit two Workspace tasks at once; both must execute concurrently (2026-08-19's own E2E, re-run
   to prove nothing here regressed it).

## What I could not establish

- **Whether `23221162`'s `running` status is this spec's problem or the restart-recovery path's.**
  Its record says `running` since 14:23 with a live-looking NDJSON; it holds twelve worktrees and a
  `maxParallel` slot (`maxParallel: 3`). That interacts with
  `2026-08-20-chain-integrity-restart-and-continuation.md` and is **out of scope here** — this spec
  only ensures such a run's trees are reclaimable, not that its status is correct. Worth its own
  investigation.
- **Whether any real work has ever been lost** to the phantom `lokie-chatbox` failure. In all three
  observed cases the shared tree's changes were applied by the winning entry first, so the loser's
  failure was cosmetic. I found no case of a *lost* diff, and I did not prove one cannot happen —
  the race has no defined winner, and if the loser is the entry that would have applied a real
  change, the branch (kept) is the only copy.
