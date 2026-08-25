# Brief: Headless Run Exits

Gather-the-record deliverable for task `eeceb869-64ee-462a-a180-675761e24ce7`. The code citations describe the task branch after source changes landed, not the vulnerable mainline baseline. This brief does not claim that the implementation is verified.

## Problem in repository terms

The one-shot `cez run` command can return exit code 0 while its durable run row is still non-terminal. The reported packaged dry-run printed `run started`, `worktree ready`, and the first `Gather the record` step, then exited with `.ai/cezar/runs.json` still at `status: "running"`. That violates the headless command's public contract: exit 0 means the workflow reached `done` or `review`, never merely that the Node event loop emptied.

The package E2E exercises the release shape. It packs and installs the tarball, creates a git fixture, invokes the installed CLI with `CEZ_DRY_RUN=1`, then requires terminal stdout and a `done` or `review` run row (`packages/cezar/test/e2e/package-cli.test.ts:14-94`). The task's "case 5" and 15/15 count are stale. The current suite has 18 cases and this test is eighth (`.ai/specs/2026-08-23-headless-run-drains-event-loop.md:20-28,741-748`).

## What the record already decided

- The built-in `spec-to-deploy` workflow applies to the CLI default path. Dry-run postconditions simulate success rather than performing commit or deploy verification (`.ai/specs/2026-08-19-spec-to-deploy-default-workflow.md:6-11,23-28`; KB `specs-e01401118cd2`).
- The earlier single-step failure had the same symptom but a narrower cause. Commit `3e6d1b7e` kept the broker poll interval referenced and made broker startup give-up settle as failure. Its record is corrected in place: a step-scoped timer does not provide run-lifetime liveness across multi-step hand-offs (`.ai/specs/2026-08-22-run-broker-cli-keepalive.md:3-25`; KB `specs-72b289500380`).
- A workflow chain must not finish while later steps remain pending. The chain-integrity decision fixed continuation and restart paths, but it did not establish a process-level keep-alive for the one-shot CLI (`.ai/specs/2026-08-20-chain-integrity-restart-and-continuation.md`; KB `specs-172ddd891dd0`).
- The authoritative current design measured the structural problem: `runCommand` awaited promises and EventEmitter delivery, neither of which references a Node handle. A healthy brokered eight-step run spent 97.4 percent of sampled time with exactly one referenced handle, versus 0.6 percent without the broker. The CLI therefore depended on incidental step-scoped handles and hand-off timing (`.ai/specs/2026-08-23-headless-run-drains-event-loop.md:3-8,20-67`; KB `specs-b3a2d37e8d23`).
- The handoff's `097d1b15` hypothesis is not the deterministic reachability commit. That commit did not change `index.ts`; it broadened the already-existing default to other unattended paths. The build-free bisect on the selected `e9d77657` to `67e93cca` ancestry named `a7510b2f` first bad. Parallel-history commit `5e388ccf` carries the same five-line CLI fallback change, but is not the first bad commit on that selected ancestry (`.ai/specs/2026-08-23-headless-run-drains-event-loop.md:3-13,1164-1179`).

No open todo duplicates this task. `cezar todo list` returned `no todos filed`. The curated Cezar domain record at `/var/lib/cezar/loki-labs/notion-export/domains/cezar.md` has no current bullet for this exact defect.

A conflicting duplicate-closure record exists on main in commit `a2a74f43`, `.ai/specs/2026-08-22-headless-run-exit0-bisect-and-verify.md`. It treats the narrower `3e6d1b7e` broker-session timer as a complete fix and proposes no runtime change. That conclusion is superseded for this multi-step hand-off race by the measured run-lifetime diagnosis in KB `specs-b3a2d37e8d23` and `.ai/specs/2026-08-23-headless-run-drains-event-loop.md:58-105`. The next record-writing step must correct that stale conclusion in place rather than merely append another claim.

## Code actually involved now

HEAD already contains an unverified implementation:

- `runCommand` builds the manager at `packages/cezar/src/index.ts:998-1051`, installs output listeners at `:1053-1078`, then creates terminal state, a `beforeExit` guard, and a referenced one-second run-lifetime interval at `:1082-1113`. It starts the run at `:1114`, resolves from terminal store events at `:1118-1126`, cleans up at `:1127-1131`, flushes synchronously at `:1132`, and grants exit 0 only to `done` or `review` at `:1134-1138`.
- `packages/cezar/src/runs/run-exit-guard.ts:3-6` defines terminal statuses and the three-miss policy. It persists failure, error text, a synchronous flush, and exit code 1 at `:30-45`; provides the `beforeExit` backstop at `:47-58`; and implements repeated liveness checks at `:60-93`.
- `RunManager.startRun` creates and queues durable work, then calls the pump without awaiting it (`packages/cezar/src/workflows/run.ts:1390-1469`). The current liveness query counts active, starting, queued, waiting, monitoring, auto-resume timers, and pending jobs (`:3483-3500`). Execution registers the active run and persists `running` at `:4728-4812`. Chain settlement refuses success while steps remain pending (`:6617-6678`).
- Deterministic fault injection is at `packages/cezar/src/workflows/run.ts:5093-5095`, selected by `CEZ_RUN_FAULT=stall-step[:stepId]`; the environment contract is at `.env.example:405`.
- Broker polling remains step-scoped. Its interval starts referenced and is cleared on terminal spool exit or detach (`packages/cezar/src/core/brokered-session.ts:131-163,196-232,349-356`). It cannot be the lifetime guarantee for the whole workflow.
- Run persistence creates and updates rows at `packages/cezar/src/runs/store.ts:780-874` and exposes synchronous flush at `:1347-1354`. Its normal debounce timer is unreferenced at `:1417-1424`, so persistence does not keep the CLI alive.

## Prior decisions this must not contradict

The fix must preserve the server path, detached broker lifetime, direct and brokered execution, and `review` as a successful terminal status for headless runs. It must not reinterpret a non-terminal row as success, add required user configuration, or restore the assumption that one step's broker timer represents the workflow. It must fail closed: a keep-alive without a deterministic stalled-run failure path would convert silent exit into an indefinite hang.

The current design narrows, rather than supersedes, `3e6d1b7e`. That earlier correction remains valid for broker startup and per-session polling. The wider invariant is: the CLI owns liveness from `startRun` until durable terminal settlement (`.ai/specs/2026-08-23-headless-run-drains-event-loop.md:471-476`).

## Open questions the next steps must settle

1. Does the load-sensitive package test reproduce reliably at `a7510b2f`, in addition to the completed build-free workflow-selection bisect?
2. Does the regression test fail against the old source and pass against the task branch?
3. Do repeated packaged CLI runs complete all eight dry-run steps, and does forced `stall-step` persist failure and exit non-zero without hanging?
4. Are the current gates green, especially the named package test and the current 18-case count? The authoritative status is `IMPLEMENTED, VERIFICATION PENDING`.
5. After verification, will the stale duplicate-closure record, the curated domain record, and the durable corpus be corrected and made searchable?

## What could not be established here

No build, test, or runtime reproduction was run during this read-only gather step. Acceptance criterion 1 is supported by the completed build-free bisect recorded in the authoritative spec, but a load-sensitive package-test bisect was not run here. Acceptance criterion 2 remains unproven here, and acceptance criterion 3 is implemented but not verified. The task's original failing checkout base is deleted, so its claimed earlier 15/15 result could not be independently inspected. No separate tracker item was found.
