# Stale artifact live prune

- Date: 2026-08-22
- Category: deploy integrity / worktree lifecycle / data loss
- Priority signal: P0, confirmed unrecoverable deletion during a live run
- Task: `b34867ee-be6d-4275-9b14-0d3fdd62e78d`

## Problem in this repository's terms

Blue-green deploy currently attests to the source checkout's Git SHA, not to the bytes it stages. `stage()` copies the source tree with rsync and does not build it. Release id, ledger SHA, and the health/readiness identity are populated from a caller-supplied or source-derived SHA. A valid but stale `dist/` therefore passes smoke boot and can run under a fresh release identity.

That happened on `prod-host`. Release `20260822T131126Z-504ce87f` claimed SHA `504ce87f`, which contains the cross-project ownership fix `5ffa383c`, but served a `dist/` built before that fix. During its six-minute lifetime, the stale startup prune swept the cezar project while run `eb9f65aa` was executing vitest inside a workspace worktree. It force-removed live worktree directories and their recovery branches. The lazy project-context path did not log removals. The incident and measurements are recorded in KB `notion-23363acb2719`, `stale-artifact-reaps-live-worktrees--local.md`, under “The deploy ledger attests to a commit the running code does not come from” and “What that cost, for six minutes.”

The failure has two independent halves. A deployment must prove which source produced the artifact. A prune must preserve work even when every ownership signal is cold, stale, missing, or unreadable. Fixing only one leaves data loss reachable through the other.

## Checkout and record topology

This task worktree is at `2778fd52`; local `main` is also there, while `origin/main` is `c1ccbe79`. The checkout does not contain the shipped ownership fix `5ffa383c`, the retry fix `c1ccbe79`, or the incident spec commit `3f669bf3`. Consequently:

- Checkout citations describe the destructive pre-fix implementation that actually matches the stale artifact served during the incident.
- `origin/main:<path>:<line>` citations describe the current shipped source after `5ffa383c`.
- The named incident spec exists at commit `3f669bf3` as `.ai/specs/2026-08-22-live-worktree-reaped-mid-run.md`, status “specced, not implemented.” The next spec step should reconcile that record instead of allocating an unrelated duplicate.

No open todo was returned by `cezar todo list`. No commit in `git log --all` implements build stamps, monotonic forward-deploy ancestry refusal, worktree leases, autosave-before-prune, or delayed project-context pruning.

## What the record already decided

### Artifact identity is not source identity

- KB `notion-23363acb2719` measured the exact stale-artifact deployment and requires artifact self-description plus fail-closed pruning as separate controls.
- KB `notion-8d2aa351272c`, `324-2026-08-22-blue-green-source-sha-is-a-label-not-a-checkout.md`, records that `server-deploy --sha=<sha>` labels what is already checked out. It neither checks out that SHA nor authenticates the staged bytes. Its operational exact-SHA-worktree workaround is amended by this task: the build stamp becomes machine authority and the caller SHA becomes a cross-check.
- The blue-green design established sortable `<timestamp>-<short-sha>` release ids and a rollback ledger, but did not bind either to artifact bytes (`.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md:345`). Stamp-derived identity tightens that contract without changing atomic activation or rollback.
- The Cezar domain record notes that builds and full gates write `packages/cezar/dist`, so concurrent work can corrupt shared artifacts (`/var/lib/cezar/loki-labs/notion-export/domains/cezar.md:38`). The stamp must therefore be written as part of the build that produced the directory, not as deploy metadata added later.

### A recovery branch is durable data

- Worktree retention explicitly rejects branch deletion because the branch can be the only copy of local-only work (`.ai/specs/2026-07-18-worktree-retention.md:49`, `:66`, `:200`).
- Workspace cleanup already encodes the desired fail-closed rule: autosave first, keep the directory when autosave refuses or fails, remove only the directory, and retain the branch (`packages/cezar/src/workspace/workspace-worktrees.ts:257`, `:267`, `:270`). Its tests cover successful autosave with branch retention and conflict refusal with directory retention (`packages/cezar/src/workspace/workspace-worktrees.test.ts:258`).
- Workspace isolation X3/X4 chose directory-only cleanup and branch preservation (`.ai/specs/2026-08-20-workspace-run-worktree-isolation.md:189`). P0 extends that invariant to orphan pruning.
- The earlier workspace decision W7 relied on ordinary per-project orphan prune for failed/cancelled cleanup (`.ai/specs/2026-08-19-parallel-workspace-runs-worktrees.md:91`). That reliance is no longer safe and must be marked corrected where it remains current.

### The ownership fix is necessary but insufficient

- Commit `5ffa383c`, `fix: cross-project orphan prune no longer reclaims a live workspace-run worktree`, shipped a foreign-owner check and structured decline reporting. Its spec is `.ai/specs/2026-08-22-cross-project-worktree-orphan-prune-safety.md`.
- Current origin reads foreign `runs.json` snapshots and matches exact canonical workspace-worktree paths (`origin/main:packages/cezar/src/runs/worktree-ownership.ts:50`, `:93`). This is snapshot ownership, not a live lease.
- Current origin declines a candidate claimed by another run or protected by unreadable ownership input, but still performs no autosave and can still pass a branch to destructive removal (`origin/main:packages/cezar/src/git-worktree.ts:622`, `:651`). A stale build can omit the module entirely, and a cold restart can see neither local valid ids nor a recovered foreign owner.
- The existing incident spec at `3f669bf3:.ai/specs/2026-08-22-live-worktree-reaped-mid-run.md:55` explicitly treats deploy integrity and prune safety as independent boundaries; its detailed prune constraints are at `:103`, `:118`, and `:128`.

## Code actually involved

### Destructive worktree path

- In this checkout, `pruneOrphans` enumerates `.ai/cezar/worktrees`, treats every directory absent from the local store as orphaned, and calls `removeWorktree` with `branchFor(id)` (`packages/cezar/src/git-worktree.ts:568`).
- `removeWorktree` force-removes the registered worktree, recursively removes the path, prunes metadata, then runs `git branch -D` when given a branch (`packages/cezar/src/git-worktree.ts:238`).
- The safe cleanup primitive already available is `autosaveCommit`, whose result distinguishes no-op, committed, refused, and failed (`packages/cezar/src/git-worktree.ts:307`). `discardWorkspaceWorktrees` demonstrates the correct sequencing and refusal behavior (`packages/cezar/src/workspace/workspace-worktrees.ts:270`).
- Current origin's ownership-aware prune is at `origin/main:packages/cezar/src/git-worktree.ts:622-663`. P0 must strengthen this version, not reimplement the stale checkout's simpler function.

### Sweep callers, timing, and logging

- Boot creates its store and manager, prunes synchronously, logs removed ids, then recovers live runs (`packages/cezar/src/index.ts:698`, `:710`, `:728`). Current origin logs both removed and declined reports (`origin/main:packages/cezar/src/index.ts:720-753`).
- A lazy registered-project context opens its store and manager, prunes and reclaims synchronously inside `build()`, then calls `manager.recover()` (`packages/cezar/src/server/project-context.ts:425`, `:440`, `:454`). Reads that construct a context can therefore trigger destructive cleanup inline.
- Current origin logs project-context declines but still does not log removed candidates and still prunes before recovery (`origin/main:packages/cezar/src/server/project-context.ts:446-479`). P3 moves the per-project sweep out of the context-build critical path, while P0 requires removal reporting equivalent to the boot path.
- Workspace run worktrees are created per repository and recorded on the owning run (`packages/cezar/src/workspace/workspace-worktrees.ts:83`; `packages/cezar/src/workflows/run.ts:3690`). A per-run lease under `<repoRoot>/.ai/cezar/worktree-leases/` supplies a local, independently readable liveness signal when stores and foreign ownership are not yet available.

### Build and deploy identity

- Root `npm run build` sequences server build, web build, and package check, but writes no build stamp (`package.json:16`). The server workspace build is `tsc` plus contract inlining (`packages/cezar/package.json:28`, `:42`).
- Blue-green `stage()` is `rsync -a --delete` plus runtime-state exclusions. It neither builds nor validates artifacts (`packages/cezar/src/server-install/release-deploy.ts:130-166`).
- The CLI derives a SHA from the source checkout when the caller did not supply one (`packages/cezar/src/server-install/release-cli.ts:61-72`). `runReleaseDeploy` builds the release id from `options.sha`, copies that SHA into the ledger, sets `builtAt` to deploy time, and stages without inspecting `dist/` (`packages/cezar/src/server-install/release-deploy.ts:309`, `:382`, `:390`).
- Smoke boot proves only that staged JavaScript exists and starts. A stale valid build therefore passes (`packages/cezar/src/server-install/release-deploy.ts:190`).
- Runtime health/readiness reports the active ledger entry through `currentRelease`, so it repeats ledger metadata rather than independently verifying the artifact (`packages/cezar/src/server/runtime-info.ts:49`, `:68`).
- Ordinary deploy has no current-versus-candidate ancestry guard. Ledger loading degrades a missing or malformed ledger to an empty ledger (`packages/cezar/src/server-install/releases.ts:120`), which cannot be used as a fail-open answer for P2.

## Existing verification record and missing coverage

The current deploy tests cover orchestration order, pre-flip smoke failure, readiness rollback, retention, and explicit rollback (`packages/cezar/src/server-install/deploy-strategy.test.ts:55`, `:105`, `:133`, `:166`, `:183`). Safe workspace discard tests cover autosave success and refusal. The checkout has no test of `pruneOrphans`; `5ffa383c` adds ownership tests on origin, but not the new controls.

The spec must preserve the acceptance E2E as a real box test, not infer it from unit gates: three concurrent workspace runs survive a forward deployment; a stale, not-rebuilt artifact and an ancestor deployment are refused; a genuine orphan is autosaved, removed without branch deletion, and logged. Automated regression coverage must separately pin:

- autosave success, refusal, and failure before prune removal;
- proof that prune never invokes branch deletion;
- removed and declined project-context reporting;
- valid, missing, and unreadable leases, including `validIds` empty and no foreign owner;
- delayed per-project sweep scheduling;
- missing, unreadable, mismatched, dirty, and source-older/newer build stamps;
- stamp-derived release id and ledger SHA;
- ancestor refusal and fail-closed unresolvable SHA behavior;
- the genuine-orphan control, so safety does not disable reclamation.

The existing incident spec already lays out regression and E2E cases at `3f669bf3:.ai/specs/2026-08-22-live-worktree-reaped-mid-run.md:300-348`. The next step should validate and amend that verification section against current origin rather than create competing acceptance language.

## Prior decisions this work amends

1. `--sha` changes from an authoritative caller label to a value checked against the artifact's own stamp. Release identity and ledger SHA come from the stamp.
2. W7's assumption that startup orphan prune is safe cleanup is corrected. Prune becomes a recoverability-preserving operation with autosave, branch retention, leases, and explicit outcomes.
3. `5ffa383c`'s ancestry-gated branch deletion is strengthened to never delete a branch during orphan prune. The ownership snapshot remains useful but is not sufficient proof of orphanhood.
4. Lazy project-context construction stops performing the sweep inline. A delayed sweep must have an owned timer lifecycle and must not keep a process alive accidentally.
5. The ledger's permissive treatment of missing SHA remains acceptable for historical/manual entries, but forward activation cannot interpret absent or unresolvable identity as permission.

## Open questions the spec must settle

1. Which build command owns the atomic write of `packages/cezar/dist/.build-stamp.json`, and at what exact point after server/web/package outputs are complete is it written? The acceptance wording names `dist/.build-stamp.json`; the repository has both server and web output trees, so the authoritative path and completeness boundary must be explicit.
2. What does `dirty` mean: source worktree dirty at build start, build end, or both? Does deployment refuse every dirty stamp, or only require the field and an exact source-HEAD match? The acceptance criteria require the field but do not state the activation policy.
3. Which files count for “older than `packages/*/src`”? The comparison needs explicit handling for generated files, equal timestamps, filesystem timestamp resolution, deleted sources, and web assets.
4. Is caller `--sha` retained for compatibility as a mandatory equality check, made optional, or removed from ordinary forward deploy? It must not override the stamp.
5. For P2, what identifies the live SHA when the ledger is unreadable or the active release lacks one? The requirement says fail closed, but the error surface and rollback escape hatch must be specified.
6. What is the lease schema, creation point, refresh model, ownership proof, and deletion point across restart continuation? An unreadable lease declines pruning, but stale leases need a bounded and measurable route to eventual genuine-orphan cleanup.
7. Does the approximately five-minute sweep use one timer per context, one scheduler, or an unref'd task? The owner must define cancellation on context disposal and deduplication across repeated context construction.
8. Where is a removal logged when no owning run exists? The boot console precedent is clear, but a durable project-context event may require a project-level log rather than a run event.
9. How will the regression test prove it fails without the fix across both the ownership-aware origin code and the stale-artifact scenario? The test must not pass merely because `5ffa383c` declines a foreign owner.

## Facts that most constrain the design

- Artifact identity and prune safety are independent fail-closed boundaries; either one alone leaves the incident reachable.
- Branches are recovery artifacts and orphan prune must never delete them.
- The current origin ownership guard is snapshot-based, runs before recovery, and can be absent from stale `dist/`; a repo-local lease supplies the missing live signal.
- The current deploy pipeline stages without building, while every externally visible SHA is copied from source metadata rather than derived from the artifact.
