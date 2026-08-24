# Stable Test Gate Blockers

**Status:** Draft
**Date:** 2026-08-24
**Parent task:** `cd439910-d96d-4d32-9493-b39b5654d66d`

Allocator note: the required workspace allocator exists only at
`/var/lib/cezar/loki-labs/chat/tools/next-spec`. It derives its repository from the current
working directory and only understands `SPEC-NNN-*` files. Cezar's authoritative spec set is
date-named and contains no allocator. Running the Chat allocator from this checkout refuses to
guess, while running it from Chat would allocate a Chat number and require a pointer mutation in
another repository. This file therefore follows Cezar's repository-local dated naming convention.

## TLDR

The root test gate cannot turn green on `prod-host`. Three stable failures remain after the
broker re-attach feature itself passes its focused tests and typecheck:

1. catalog C18 measures 60 to 64 ms CPU per MiB against a strict 40 ms limit;
2. `home-safety.test.ts` hard-codes a worktree-local `node_modules/.bin/vitest` that does not
   exist even though the gate's `npm exec vitest` resolves the installed binary elsewhere;
3. `workspace-parallel.test.ts` leaves `?? .ai/` in the granted project's real checkout after a
   failed workspace run.

This follow-up will close those three blockers without relaxing product guarantees. It first measures
the exact cause of C18 and the `.ai/` residue, then fixes the responsible mechanism. The nested
Vitest test resolves the executable from the running test process's actual environment instead
of assuming an install topology.

## Problem

### C18 is a permanent red, not a useful budget

`packages/cezar/src/knowledge/catalog.test.ts:293-324` takes the minimum CPU time of three warmed
catalog builds and asserts less than 40 ms per MiB. The repository record says this machine once
measured 17.4 ms/MiB alone and 23 to 34 under load. Current isolated measurements on the same box
are stable at 60.17, 64.07, and earlier recorded 55 to 70 ms/MiB. The domain record and several
specs already call this the deterministic standing red.

The test currently cannot distinguish a real catalog regression from a stale calibration. The
fix must not simply raise or delete the threshold. Before changing the assertion, profile the
current `buildCatalog()` stages on the same generated corpus and compare current main with the
commit that established C18. If one stage regressed, optimize it and retain the 40 ms budget. If
the product now deliberately performs more work, replace the stale absolute budget with a
measured invariant that still catches the regression class, such as bounded incremental cost or
linear scaling across two corpus sizes. Record the before and after numbers in this spec.

### The nested test assumes the wrong install topology

`packages/cezar/src/workspace/home-safety.test.ts:114-123` constructs
`<worktree>/node_modules/.bin/vitest`. This task worktree intentionally has no local
`node_modules`, while `npm exec vitest` successfully resolves the shared installation used by the
outer gate. The nested spawn therefore fails before it exercises home-write safety:

`spawnSync .../worktree/node_modules/.bin/vitest ENOENT`.

The test must resolve the already-running Vitest executable from the process environment or
module resolution, fail clearly if no installed executable can be found, and keep the negative
control that the nested suite times out without creating the fake user's registry.

### Failed workspace cleanup leaves real-checkout state

`packages/cezar/src/workflows/workspace-parallel.test.ts:245-286` waits for the run to settle and
for `workspaceWorktrees` to clear, then expects the granted project's checkout to be clean. The
stable isolated failure is `?? .ai/`, accompanied by a delayed RunStore save after fixture
cleanup. Before changing either code or assertion, capture the residue tree and its writer. If
the `.ai/` path is operational state that should live only under the boot root or workspace
worktree, move the write to the correct owner. If it is an asynchronous cleanup race, make the
terminal transition await the cleanup it promises and dispose or flush the relevant store before
removing fixture directories. Do not add `.ai/` to the fixture's ignore file or weaken the clean
checkout assertion, because that would hide the production guarantee the test exists to pin.

## Solution

### Measured causes, 2026-08-24

The existing 4,689,980-byte C18 corpus is 4.4727 MiB. Three warmed stage-level samples on the
current implementation produced minima of 8.053 ms for scanning, 239.237 ms for parsing, and
35.380 ms for assembly. Parsing alone is 53.49 ms/MiB, before the other required stages. Repeating
the same probe with the only post-C18 catalog behavior removed (`domain` and `changeType`
extraction/projection) produced 9.335 ms scanning, 208.644 ms parsing, and 33.889 ms assembly; the
ordinary full-build loop still measured 65.18 ms/MiB. The source comparison against C18's
introduction commit `65eef6d2` confirms those two metadata fields are the only added per-document
catalog behavior. Removing them does not restore the 40 ms/MiB line, so the absolute calibration
is stale on this runtime and is not detecting a catalog regression. Phase 3 will replace it with
a two-size linear-scaling invariant, retaining a negative control for duplicated work.

The workspace residue was made deterministic by delaying the already-asynchronous lease removal
by 250 ms. The failed run then left exactly:

`?? .ai/`, containing `.ai/cezar/worktree-leases/<runId>.json` (198 bytes) and the empty
`.ai/cezar/worktrees/` directory.

`RunManager.clearWorktreeLeases()` clears the timer and calls
`void removeWorktreeLeases(roots, runId)`. Therefore the run record and worktree cleanup can become
observable as complete while the lease deletion is still pending. Phase 4 will make lease cleanup
part of the awaited terminal cleanup barrier. The delayed RunStore save warning is a separate test
teardown race under the boot root, not the writer of the granted project's `.ai/` residue.

### Phase 1: measure the two ambiguous blockers

- Add bounded diagnostic assertions or a temporary local probe for C18 that reports stage-level
  CPU cost and corpus bytes for current main and the original C18 implementation commit.
- Capture the exact files under the failed workspace fixture's `.ai/` before teardown, together
  with the lifecycle event that preceded each write.
- Write the measured cause into this spec before implementation. Remove temporary probes unless
  they become durable regression coverage.

Completed. All temporary timing and residue probes were removed after the measurements above.

### Phase 2: make nested Vitest topology-independent

- Add one small helper local to `home-safety.test.ts` that finds the executable named `vitest`
  from `PATH`, using the platform path delimiter and the same environment handed to `spawnSync`.
- Require an existing regular executable and throw a diagnostic that lists the searched PATH when
  absent.
- Keep the nested command arguments and fake-HOME assertions unchanged.

### Phase 3: fix catalog cost at its measured cause

- If profiling finds avoidable work, optimize that stage and retain C18's strict 40 ms/MiB line.
- If current required behavior invalidated the old absolute calibration, replace it with the
  measured invariant selected in Phase 1. The new threshold must be derived from recorded samples,
  include headroom stated numerically, and fail against a deliberately superlinear or duplicated
  work negative control.

### Phase 4: fix failed-workspace cleanup at its writer

- Correct the ownership or lifecycle ordering found in Phase 1.
- Preserve all existing guarantees: failed worktree directory removed, recovery branch retained,
  run record cleared, and real project checkout clean.
- Add a negative control that removes or bypasses the fix and reproduces `?? .ai/`.

## Architecture

```text
root test gate
  |
  +-- catalog budget -> measured catalog stages -> useful regression invariant
  |
  +-- home safety -> actual PATH executable -> nested timeout safety probe
  |
  +-- workspace failure -> terminal cleanup barrier -> clean real checkout
```

The three fixes share only the release gate. They remain in their owning test or runtime modules;
no generic test utility or product configuration is introduced.

## Phases

| Phase | Files expected | Exit condition |
| --- | --- | --- |
| 1. Measure | this spec, temporary local probes only | cause and numbers recorded for C18 and `.ai/` |
| 2. Vitest path | `workspace/home-safety.test.ts` | nested probe reaches Vitest and preserves fake HOME |
| 3. Catalog | catalog implementation and/or `catalog.test.ts` | meaningful budget passes with negative control |
| 4. Cleanup | workspace-run owner plus `workspace-parallel.test.ts` | failed run leaves checkout byte-clean |
| 5. Verify | no new product files | focused, typecheck, and full root gate green |

## Data models

No persisted product model changes are planned. If measurement finds that cleanup ordering needs a
new in-memory completion promise, it remains internal and is not serialized into `RunRecord`.

## API contracts

No HTTP, CLI, SSE, or published package contract changes.

## Risks

- Raising C18 without measurement would convert a red signal into no signal. Forbidden.
- Ignoring `.ai/` in the fixture would hide a real-checkout mutation. Forbidden.
- Spawning through a package manager could add network or version drift to a unit test. Resolve the
  already-installed executable only.
- These blockers are separate from broker re-attachment. Track and ship them as a distinct
  follow-up, with their own verification record, rather than treating them as evidence for the
  broker acceptance criteria.

## Verification

Permission is required before executing any command below.

1. C18 focused test, including its new negative control, passes on three consecutive isolated runs
   and reports the recorded invariant values.
2. `home-safety.test.ts` passes from a worktree with no local `node_modules`; negative control with
   `vitest` removed from PATH fails with the helper's diagnostic rather than `spawnSync ENOENT`.
3. `workspace-parallel.test.ts` passes three consecutive isolated runs; removing the cleanup fix
   reproduces `?? .ai/` at least once under the deterministic injected writer/timing control.
4. Broker and `startServer()` focused suites remain green:
   `recover-brokered.test.ts`, `cluster-flag-off.test.ts`, and
   `cluster-link-activation.test.ts`.
5. `npm run typecheck` passes. The repository has no lint script, report lint as unavailable.
6. `env -u NODE_ENV npm test` passes with zero failed tests.
7. `find /var/lib/cezar -not -user cezar | wc -l` returns `0`.
