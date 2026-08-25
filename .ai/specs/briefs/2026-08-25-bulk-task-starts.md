# Brief: Bulk Task Starts

**Status:** record gathered, 2026-08-25

## Problem in current repository terms

The requested release work was to reconcile the parent task's multi-select Filed-table
implementation, make one feature commit, push it to `origin/main`, deploy it, and prove it in a
production browser. The record now establishes that the reconcile, correction, one feature
commit, five pre-commit gates, and explicit `origin` push have already happened. Repeating the
parent apply or making a second feature commit would duplicate a feature that current main already
contains.

`7932cf4d` is `feat: bulk start filed tasks (2026-08-24-bulk-start-filed-tasks)`. It is an ancestor
of current `origin/main` (`d217ab2e`), with later unrelated commits following it. Local `main` is
still stale at `b3d3a44c`, so it is not evidence of current main and must not be the basis for a
new push.

## What the record decided

- The Filed table selects project-qualified todo keys, starts only currently rendered rows in
  display order, submits serially, continues after an individual failure, refreshes both indexes,
  clears selection, and does not navigate. No server contract changes. [Feature spec
  `.ai/specs/2026-08-24-bulk-start-filed-tasks.md:7-29,39-50`; KB
  `specs-06402c11d9f7`.]
- Hidden selected rows are a load-bearing safety constraint, not a UI nicety. The parent patch used
  the whole sorted set, which could start a row hidden after pagination reset. The shipped commit
  derives `batch` from rendered `rows`: `packages/web/src/routes/global-tasks.tsx:782-799`. The
  250-row sort-and-pagination regression is at `packages/web/src/routes/global-tasks.test.tsx:1515-1574`.
- The removal of `packages/cezar/test/unit/deploy-e2e-probe.test.ts` is intentional: it asserted the
  superseded string contract. The feature spec retains the structured package E2E suite as the
  authoritative coverage. [`.ai/specs/2026-08-24-bulk-start-filed-tasks.md:31-37,53-59`; commit
  `7932cf4d`.]
- The release record says the five gates were green before the commit, then records matching tested
  and committed tree IDs, followed by `git push origin HEAD:main`. [`.ai/cezar/runs/480e0282-a967-4936-a12e-3c4e56450586.handoff.md:133-158,162-174`.]
- Agent-run cezar deployment is deliberately manual. Both declared targets have `manual: true` and
  tell a person to activate blue-green deployment, then Resolve the handoff. A parked agent deploy
  is expected, not a reason to bypass the policy. [`.ai/deploy-targets.json:22-35`; KB decision
  reflected in `.ai/specs/2026-08-24-manual-deploy-not-a-bug.md`.]

## Code actually involved

- `packages/web/src/lib/filed-tasks.ts:235-274`: stable selection key, immutable toggle/set,
  ordered visible intersection, and tri-state select-all helpers.
- `packages/web/src/routes/global-tasks.tsx:756-853,1033-1079`: selection state, rendered-row
  batch derivation, selection bar, select-all, and row checkboxes.
- `packages/web/src/routes/global-tasks.tsx:1522-1548`: serial per-project calls to the existing
  start endpoint, failure continuation, index invalidation, toast and selection clear. The ordinary
  single-start path remains separate and navigates by design.
- `packages/web/src/lib/filed-tasks.test.ts:245-263` and
  `packages/web/src/routes/global-tasks.test.tsx:1464-1586`: helper behavior, cross-project order,
  no navigation, selection controls, hidden filtering/pagination, and partial failure coverage.
- `packages/web/src/api/client.ts:1653-1679` and `packages/contract/src/skills.ts:234-238`: existing
  project-scoped start request and response, unchanged by this feature.

## Reconciliation and duplicate-work findings

The parent implementation is `1089391e`, based on `9c896e32`, with six paths and `+407/-350`.
The shipping commit `7932cf4d`, parent `ea40c7a1`, carries those paths plus the shipping spec and
the pagination correction. `git merge-base --is-ancestor 7932cf4d origin/main` succeeds, and the
feature paths do not differ between `7932cf4d` and current `origin/main`.

No duplicate bulk-start work was found in the todo list or active task branches. The only listed
todo is unrelated: `eff223d4` (config API ambient environment isolation). The current worktree has
one user-owned untracked file, `.e2e-bulk-start.cjs`, owned by `cezar`; it appears to be an E2E
helper and must be preserved and excluded from any commit.

## Contradictions and open questions for the next step

1. The task acceptance criteria say to reconcile, commit, and push, but those are already satisfied
   by `7932cf4d` and the explicit push record. The next release step must not replay or recommit the
   parent diff.
2. The header of `.ai/specs/2026-08-24-ship-bulk-start-filed-tasks.md` says nothing was executed,
   while its later handoff progress records gates, the commit, and the push. Treat the later dated
   progress and git reachability as current evidence. The stale status needs correction in place
   only if a subsequent authorized record-update phase edits tracked documentation.
3. Deployment, declared-probe output, production browser E2E artifacts, cleanup, and a searchable
   corpus record are not proven by the gathered record. The current untracked helper may be part of
   later E2E work, but this step did not run it.
4. The corpus proposal application path remains unavailable to agents. A proposal can be written to
   `CEZ_KB_WRITE_FILE`, but searchability cannot be claimed until a human applies it through a
   supported workflow. [`.ai/cezar/runs/480e0282-a967-4936-a12e-3c4e56450586.handoff.md:123-129`.]

## What was not found or executed

No new feature defect, conflicting API decision, or duplicate in-flight bulk-start task was found.
This gather step ran no gates, deploy, browser E2E, cleanup, or corpus proposal write. Prior green
gate results are cited historical evidence, not a fresh verification.
