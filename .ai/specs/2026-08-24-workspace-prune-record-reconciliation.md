# Workspace prune record reconciliation

**Status:** implemented and pushed to `origin/main` in `8737a136`. Ownership protection is
runtime verified; removal-authorization observability is verified by automated coverage. The
production journal wording was not directly observed. Deployment of `8737a136` belongs to the
next workflow step.

**Task:** `b3b5719c-ccf6-445c-9b97-39dd7eaf077e`

**Brief:** `.ai/specs/briefs/2026-08-24-workspace-orphan-prune-record.md`

## TLDR

The requested protection already shipped in commit `5ffa383c` under the accepted spec
`.ai/specs/2026-08-22-cross-project-worktree-orphan-prune-safety.md` (KB
`specs-91633925b646`). A target project's delayed `ProjectContexts` sweep now reads the run
indexes of every other registered project plus the unregistered boot root, declines to reclaim
an exact `{root, worktreePath}` claim, and records a reason-bearing decline outcome. The
regression test reproduces the incident topology: a workspace run record under the boot root
owns a worktree under target project P, and building P's context leaves its directory and branch
intact.

Later commits `362865ec` and `32379c34` added leases, autosave-before-removal, and unconditional
branch preservation. They superseded only the accepted spec's original branch-deletion safety
net, not its cross-project ownership rule. The exact production restart timing was exercised on
2026-08-24 and passed. This spec reconciles the repeated task to that shipped record. Commit
`8737a136` closed the remaining acceptance gap: a successful removal outcome and both boot log
call sites now name the worktree and explain why removal was authorized. It did not add a second
ownership implementation.

## Problem

A parallel workspace run has one owning `RunRecord`, stored in the workspace or project that
started it, while its `workspaceWorktrees` can live under several target repositories. Before
`5ffa383c`, target project P built its local valid-id set solely from P's `RunStore`. P therefore
classified a workspace-owned directory under `P/.ai/cezar/worktrees/<runId>` as an orphan even
though another run index claimed it.

That exact mismatch destroyed the cezar target worktree twice during live workspace task
`232ad6d4` on 2026-08-21, including its branch and roughly 40 minutes of uncommitted work. A
cockpit restart or deploy could trigger the target project's context construction, so the
failure was part of the normal production path rather than a manual cleanup edge case.

The prior topology decision is
`.ai/specs/2026-08-19-parallel-workspace-runs-worktrees.md` (KB
`specs-b031a8bc53a9`). Its W7 assumption that a project-local orphan pass could safely reclaim
these worktrees was corrected by the accepted orphan-prune spec. Finished-run retention in
`.ai/specs/2026-08-20-workspace-run-worktree-isolation.md` (KB
`specs-f647a4038e21`) is separate: it acts from the owning run record after completion and does
not solve foreign ownership visibility during a live run.

This task is a duplicate of already accepted and shipped work. Its earlier competing spec,
`.ai/specs/2026-08-22-workspace-run-worktree-orphan-prune.md`, is explicitly superseded in place
and was reconciled by commit `32e9549a`. Re-implementing that design would conflict with the
current ownership, lease, autosave, and recovery-branch guarantees.

## Solution

Retain the accepted ownership implementation and add only the missing removal-observability change:

1. Assemble foreign ownership sources from every registered project and the process boot root.
   The boot root is explicit because it is deliberately absent from the project registry.
2. Read each source's `runs.json` without opening a `RunStore` or triggering recovery. Treat an
   existing non-empty index that cannot be parsed as unavailable, never as proof of no owner.
3. Match ownership by canonical target root and canonical worktree path. Do not filter by the
   cold-loaded run status because reconciliation can alter status while leaving the ownership
   claim valid.
4. Sample ownership when the delayed sweep executes. Decline a candidate claimed by a foreign
   workspace run, and emit a durable and console-visible reason.
5. Preserve the later destructive backstops: leases are checked first, an unowned candidate is
   autosaved before directory removal, autosave refusal keeps the directory, and the recovery
   branch is always retained.
6. Persist each materialized workspace-worktree snapshot as it is created so ownership becomes
   visible before materialization of the remaining projects completes.
7. Complete removal observability in `pruneOrphans`: every `removed` outcome must include a
   reason that identifies the checks which authorized destruction, and the project-context log
   must print each removed worktree id with that reason. Assert both the durable outcome and the
   console message in automated tests.

No new API, configuration, compatibility layer, or data migration is introduced.

## Architecture

The shipped flow is:

`ProjectContexts.build(P)` schedules a sweep in
`packages/cezar/src/server/project-context.ts:451-483`. When the timer fires, it assembles the
other registered roots plus `bootRoot`, loads them through
`packages/cezar/src/runs/worktree-ownership.ts:50-68`, and creates a pure exact-path owner lookup
through `packages/cezar/src/runs/worktree-ownership.ts:84-112`.

`pruneOrphans` in `packages/cezar/src/git-worktree.ts:653-707` applies the safety gates for each
directory not named by P's own run store. It declines fresh or unreadable leases, fails closed
when the ownership check is unavailable, declines a foreign claim with the owning run and
project in its reason, then autosaves any remaining candidate before directory removal. It never
deletes the branch. The call site appends every outcome to
`.ai/cezar/worktree-reaps.jsonl` (`packages/cezar/src/server/project-context.ts:474-477`). Kept,
declined, and removed candidates carry reasons. Commit `8737a136` made the removed variant
reason-bearing and changed both `packages/cezar/src/server/project-context.ts` and
`packages/cezar/src/index.ts` to print each removed id beside its authorization reason.
Successful authorization is therefore as inspectable as refusal without weakening any prune
gate.

Production supplies the otherwise unregistered boot root to `ProjectContexts`. The structural
guard at `packages/cezar/src/server/server-boot-root-wiring.test.ts:19-28` pins this wiring.
Creation and resume paths persist incremental `workspaceWorktrees` snapshots at
`packages/cezar/src/workflows/run.ts:4156-4163,4877-4887`.

The design stays read-only across foreign projects. It does not instantiate their managers,
mutate their run records, or resume their agents. Only the target repository's own prune pass can
mutate the candidate worktree, after all safety gates allow it.

## Phases

### Phase 1: Reconcile the duplicate record

Independently shippable documentation-only step.

- Adopt `.ai/specs/2026-08-22-cross-project-worktree-orphan-prune-safety.md` and commit
  `5ffa383c` as the accepted solution.
- Keep `.ai/specs/2026-08-22-workspace-run-worktree-orphan-prune.md` superseded.
- Record that commits `362865ec` and `32379c34` replace the older branch-deletion proposal with
  autosave and unconditional branch retention.
- Make no source or test change.

### Phase 2: Confirm the shipped contracts

Independently shippable verification step with no code mutation.

- Run the focused ownership, project-context, boot-root wiring, and real-git prune tests listed
  below.
- Run typecheck, lint, build, and the full test gates.
- Confirm the regression test still exercises a boot-root-owned workspace run whose worktree is
  inside target project P.
- Confirm the decline outcome record and log assertion include the candidate and the reason.

### Phase 3: Explain authorized removals

Implemented in `8737a136` after the accepted ownership behavior was confirmed.

- Extend the internal removed outcome in `packages/cezar/src/git-worktree.ts` with a required
  reason describing why removal was authorized after the lease, foreign-ownership, and autosave
  gates passed. Keep the reason internal, with no published contract change.
- Return the same reason beside each removed id, or otherwise make it available to the
  project-context completion handler, so the console log names each removed worktree and its
  authorization reason.
- Add focused assertions in `packages/cezar/src/git-worktree.test.ts` for the removed outcome's
  id and reason, and in `packages/cezar/src/server/project-context.test.ts` for the persisted row
  and console log. Prove the new assertions fail against the current reasonless removal path.

### Phase 4: Confirm runtime timing

Independently shippable production verification step after Phase 3 and all gates are green.

- Start or identify a live workspace run with a target-project worktree.
- Restart the cockpit, then force `ProjectContexts.build(P)` through an authenticated
  target-project request.
- Verify the worktree directory and branch exist before and after the sweep.
- Retain the runtime evidence with an explicit exit status.

This phase already passed on 2026-08-24 for run
`da9033bd-a4d3-43c9-9fdf-2102109556ef`; the rolling handoff records evidence at
`/tmp/cezar-orphan-e2e-b3b5719c.log` with `E2E_EXIT=0`. The service user could not read the
production journal, so console wording was verified by automated coverage rather than that
runtime probe. Durable outcome recording remained available.

## Data models

No schema change applies. The existing `RunRecord.workspaceWorktrees` entries remain the source
of ownership. Matching uses the existing fields:

| Field | Meaning in the ownership decision |
| --- | --- |
| `RunRecord.id` | Owning workspace run id used in the decline reason |
| `workspaceWorktrees[].root` | Canonical target repository root |
| `workspaceWorktrees[].worktreePath` | Canonical candidate path claimed by the run |
| `workspaceWorktrees[].branch` | Recovery branch, retained by the current prune contract |
| `workspaceWorktrees[].reclaimedAt` | Existing finished-run retention state, not an orphan-prune authorization |

`ForeignRunSource.unreadable` is an in-memory safety signal in
`packages/cezar/src/runs/worktree-ownership.ts:17-38`. It distinguishes an absent or genuinely
empty index from a non-empty index that could not be loaded. It is not persisted and is not an
API field.

Prune outcomes are internal records with `id`, `outcome`, required `reason`, autosave state, and
`branchKept`. Commit `8737a136` made `reason` required for every materialized outcome, including
the `removed` variant. Outcomes are appended to
`.ai/cezar/worktree-reaps.jsonl`. No migration is needed.

## API contracts

No HTTP, SSE, CLI, or published package contract changes apply. Triggering a project-scoped
request may cause lazy `ProjectContexts` construction, but the response shape and route behavior
remain unchanged. The feature is internal startup and reconciliation safety.

## Analytics and observability

No product analytics event is required because the behavior is an internal safety operation.
The durable operational surface remains `.ai/cezar/worktree-reaps.jsonl`, paired with the boot
log summaries in `project-context.ts:474-481`. Kept and declined outcomes explain why
destruction did not proceed. Removed outcomes explain why destruction was authorized, and both
removal log call sites identify the worktree beside the same reason. Commit `8737a136` closed
that observability gap. Automated assertions, rather than inaccessible production journal text,
pin the wording contract.

## Risks

| Risk | Mitigation |
| --- | --- |
| A malformed foreign `runs.json` is mistaken for no owner | A non-empty unreadable source makes ownership unavailable and the prune fails closed. |
| The unregistered boot root is omitted | Production wiring passes `deps.repoRoot`; a source-level regression test pins it. |
| Ownership changes between context build and sweep | Sources are loaded when the delayed sweep fires. |
| A run status is cold-reconciled and appears finished | Ownership matching deliberately ignores status while the exact worktree claim exists. |
| Creation exposes a worktree before its ownership is persisted | Materialization persists each deduplicated snapshot incrementally in initial and resume paths. |
| No ownership record exists for uncommitted work | Lease checks and autosave-before-removal protect the directory; the branch is always retained. |
| Duplicate ownership implementation weakens later safety guarantees | Limit source changes to the removed outcome and its durable and console observability; retain the accepted ownership, lease, autosave, and branch-preservation paths. |
| Cross-project scanning adds boot work | It reads only registered run indexes plus the boot root and does not instantiate managers or trigger recovery. |
| A successful removal is mistaken for proof that every safety gate ran | Require a reason on the emitted removed outcome and print it beside the worktree id; assert both durable and console surfaces. |
| A generic reason overstates checks that were skipped | Build the reason from the actual successful path and its autosave result, rather than using an unconditional `orphan` label. |

## Verification

The implementation and verification steps changed source and tests for the bounded observability
gap. The following commands and assertions were the planned verification inputs; actual results
are recorded below.

1. Focused automated regression and safety coverage:

   ```sh
   npx vitest run \
     packages/cezar/src/runs/worktree-ownership.test.ts \
     packages/cezar/src/server/project-context.test.ts \
     packages/cezar/src/server/server-boot-root-wiring.test.ts \
     packages/cezar/src/git-worktree.test.ts
   ```

   Required assertion: the test at
   `packages/cezar/src/server/project-context.test.ts:534-586` creates a workspace run record in
   the boot root, creates its worktree under target project P, builds P's context, waits for the
   delayed prune outcome, and proves both directory and branch survive. The negative control
   without `bootRoot` must still demonstrate that registry-only discovery is insufficient.

2. Repository gates:

   ```sh
   npm run typecheck
   npm run lint
   npm run build
   npm test
   npm run test:package
   ```

3. Observability assertions:

   - The ProjectContexts regression must observe a `declined` outcome naming the workspace owner.
   - Real-git prune tests must cover foreign ownership, unavailable ownership, leases, autosave
     refusal, successful removal, and branch preservation.
   - A successful removal must emit a row containing the candidate id, `removed` outcome, and a
     reason explaining the checks that authorized removal, including the actual autosave result.
   - The project-context console assertion must identify the removed worktree and include the
     same authorization reason. The implementation step proved the new assertions red against
     the reasonless path before applying the source change.

4. Runtime E2E:

   - Capture the live workspace run id, target path, and branch.
   - Restart the cockpit and issue an authenticated request that builds target project P.
   - Assert the target directory and branch exist before and after.
   - Save output with a final `E2E_EXIT=0` marker.

5. Ship after every gate is green, following the cezar standing deployment authorization:

   - commit the complete feature as the session's single commit;
   - push explicitly to `origin main`, never to `upstream` and never with a bare `git push`;
   - deploy with the repository's rootless blue-green path;
   - run every readiness probe declared in `.ai/deploy-targets.json` and require all of them to
     pass before reporting the change shipped.

### Verification results

- The focused ownership, project-context, boot-root wiring, and real-git prune coverage passed.
  The new removal assertions were first shown to fail against the reasonless source path.
- `npm run typecheck`, `npm run test:unit`, `npm run build`, and `npm run test:package` passed.
  Root `npm test` completed with 11,382 passing tests and two failures in
  `agent-profiles-discovered-api.test.ts`; the same failures reproduced from the parent checkout
  and are tracked separately as host-profile contamination. This record does not call that root
  gate green.
- Commit `8737a136` contains the implementation and this spec, is pushed to `origin/main`, and was
  verified as the remote head after a conflict-free rebase.
- The exact production timing E2E passed on 2026-08-24 with `E2E_EXIT=0`: a live workspace run's
  target directory and branch survived a cold restart and authenticated target-project context
  build. Production journal access was unavailable, so the new console wording is covered by
  automated tests rather than a runtime log observation.
- Deployment and readiness verification for `8737a136` remain the responsibility of the next
  workflow step. This spec is implemented, but this documentation step does not claim that
  `8737a136` is deployed.

## Sources read

- KB `specs-91633925b646`, accepted cross-project orphan-prune decision.
- KB `specs-517c2fd1a554`, original incident context brief.
- KB `specs-b031a8bc53a9`, parallel workspace-run worktree topology.
- KB `specs-f647a4038e21`, finished workspace-run retention.
- KB `specs-1470bd6c6779`, later live-worktree destructive-path hardening.
- `/var/lib/cezar/loki-labs/notion-export/domains/cezar.md`, current product record.
- `.ai/specs/briefs/2026-08-24-workspace-orphan-prune-record.md`, this run's record brief.
- `.ai/specs/2026-08-22-cross-project-worktree-orphan-prune-safety.md`, accepted implementation
  spec.
- `.ai/specs/2026-08-22-workspace-run-worktree-orphan-prune.md`, superseded competing spec.
- `packages/cezar/src/runs/worktree-ownership.ts`.
- `packages/cezar/src/server/project-context.ts` and
  `packages/cezar/src/server/project-context.test.ts`.
- `packages/cezar/src/server/server-boot-root-wiring.test.ts`.
- `packages/cezar/src/git-worktree.ts` and `packages/cezar/src/git-worktree.test.ts`.
- `packages/cezar/src/workflows/run.ts`.
- Commits `5ffa383c`, `362865ec`, `32379c34`, and `32e9549a`.

No GitHub issue or pull request is the subject of this task. The brief reports no open todo and
no newer decision superseding cross-project ownership visibility.
