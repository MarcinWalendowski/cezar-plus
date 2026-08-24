# Headless Run Event Liveness

**VERIFIED 2026-08-24 (verification step). Read this block before the two below: it is the only
one written after anything was actually executed, and it settles AC1/AC3 and re-scopes AC2.**

- **Integration (§0).** `main` had moved again to `c328ec06`; merged into `cez/eeceb869` at
  `8426420a`, clean, **zero conflicts** (`merge-tree --write-tree` exit 0, unlike the `8790d334`
  reading below). The anchored registry grep still returns exactly **7**
  (`run.ts:972/976/977/983/985/986/1036`), and `git diff 3e3977c7 origin/main -- run.ts` filtered
  to `new Map<`/`new Set<`/`private readonly` is **empty**: `main` added no eighth run-state
  registry across either merge, so `runLiveness` is still complete. Re-anchored in `index.ts`:
  `beforeExit` `:1106`, keep-alive `:1107`, `startRun` `:1119`.
- **Gates (§7), from the repo root.** `npm run typecheck` **exit 0**. `npm run test:unit`
  **exit 0, `# pass 53 / # fail 0`**. `npm run build` **exit 0** (`check:pack ok — 1236 files`).
  `npm test` **exit 1: `Test Files 6 failed | 620 passed | 2 skipped (628)`, `Tests 15 failed |
  11723 passed | 4 skipped (11742)`**, and **every one of those 15 is pre-existing on `main`**,
  proved rather than assumed: the same suite on a clean `origin/main` worktree (`c328ec06`,
  hardlinked `node_modules` so it tests its own tree) is **`Tests 16 failed | 11707 passed`**, and
  `comm` over the two sorted failure-name lists shows **zero failures present on this branch and
  absent on `main`**. The one extra on `main` is a `|web|` onboarding flake. So this branch's
  failure set is a strict **subset** of `main`'s. The reds are `system-prompt.test.ts` (8),
  `step-stopped.test.ts` (3), `config-api`, `pasted-attachments`, `scheduler`, and the
  long-documented `catalog.test.ts` C18 timing case.
- **This spec's own tests are green and were confirmed to actually run** (absence from a vitest
  log proves nothing: it only prints failures). Run explicitly with `--reporter=verbose`:
  `src/runs/run-exit-guard.test.ts` **7 passed** and `src/workflows/run-liveness.test.ts`
  **8 passed**, i.e. `Test Files 2 passed (2)`, `Tests 15 passed (15)`, covering all seven liveness
  sources, both miss paths and the terminal-branch totality case.
- **AC3 is CLOSED, by three independent measurements.**
  1. **Fault injection (§2).** `CEZ_DRY_RUN=1 CEZ_RUN_FAULT=stall-step timeout 45 node
     dist/index.js run 'mock:done'` → **exit 124** with the record still `running`. That is the
     predicted post-P2 behaviour, not a defect: a stalled agent step keeps the run in `active`,
     so `runLiveness` correctly reports live and the wedge correctly does **not** fire. The
     process **hangs instead of exiting 0**, which is exactly the class AC3 names.
  2. **Healthy path (§1/§4).** A real dry run ends **exit 1** with
     `status: "failed"` and the failing step's error **on the record**. Never `exit 0` with a
     `running` row.
  3. **Resource probe (§1), like-for-like against unfixed `main`.** Same fixture, same probe,
     same run shape: **unfixed `main` 15 single-handle windows / 45 transitions; this branch 1 /
     46**. Transition ref-sets containing `refd=[]`: **0**. The single remaining window is
     `[probe +401ms] refd=[FSReqPromise]`, in **boot**, before the keep-alive arms (present by
     +440ms) and before `startRun` creates a record, so a drain there has no run to leave
     `running`, so it is outside the class. The §1 prediction of exactly 0 was therefore not
     met, and the reason is recorded here rather than rounded up.
- **AC2 is NOT met, and the blocker is a defect this spec never predicted.**
  `npm run test:package` is **`# pass 17 / # fail 1`** (`PKG_EXIT=1`), **idle and again under an
  8-way busy-loop load**, identical both times, which is itself evidence the liveness class is
  closed, since the original failure was load-sensitive. The one red is the AC2 case by name,
  `test/e2e/package-cli.test.ts:14`, and it now fails for a **completely different reason**:
  ```
  ✗ You've hit your usage limit. Upgrade to Pro (…) or try again at Aug 31st, 2026 12:32 PM.
  ```
  **The same case fails identically on clean `origin/main`** (`# pass 17 / # fail 1`, same
  message), so it is neither caused nor fixed by this branch. **Root cause, read from source:**
  `resolveCodexExecutable()` (`src/core/codex-app-server-transport.ts:20`) is
  `override ?? process.env.CEZ_CODEX_BIN ?? 'codex'`, and it has **no `CEZ_DRY_RUN` branch**, while
  the Claude runner does (`src/core/claude-cli-runner.ts:137`, `… ? mockClaudePath() : 'claude'`).
  Since `main`'s ten-stage default workflow pins step 2 (`review-spec`) to `gpt-5.6-sol`, a
  `CEZ_DRY_RUN=1` run **spawns the real `codex` CLI**, which is out of quota until Aug 31. A
  codex app-server mock exists but only as a test fixture
  (`src/core/__fixtures__/codex/mock-codex-app-server.mjs`, 223 lines), not in the packaged
  `scripts/`. Closing AC2 means shipping a codex dry-run mock, a separate defect and a separate
  concept, so it wants its own spec rather than being smuggled into this one.
- **The original exit-0 symptom is no longer reproducible on `main` either**, because the quota
  failure now aborts the workflow at step 2 before the drain window is reached. AC1's bisect
  result (`a7510b2f`) stands unchanged; it was answered statically and needed no build.

**REVISED 2026-08-24 (spec step of the re-run, against HEAD `7a19ca72`).** Read this block
first: it re-anchors the two below, which are correct about mechanism and stale about line
numbers and git position.

- **What is now true in source, re-read line by line at `7a19ca72` and not taken from the
  previous block's word:** P1 through P5-step-2/3 are all present. `run-exit-guard.ts` is
  **112** lines (was 93), the missing-record path counts a miss and fails closed at three
  (`:72-86`) instead of returning silently, both miss paths carry the `CEZ_RUN_WEDGE_DEBUG=1`
  refs-free diagnostic (`:75-78`, `:101-106`), and **both** previously-missing unit cases are
  written: "settles failed after three missing-record ticks without trying to write a row"
  (`src/runs/run-exit-guard.test.ts:122`) and "resets consecutive misses after a live tick"
  (`:156`). `.env.example` documents `CEZ_RUN_FAULT` at `:405` and `CEZ_RUN_WEDGE_DEBUG` at
  `:407`.
- **AC1 is answered, and the answer is cleaner than either prior said.** `a7510b2f` and
  `5e388ccf` are **siblings, not a predecessor and a successor**: both have parent `67e93cca`
  (`git merge-base --is-ancestor` is false in both directions), both are autosaves from
  2026-08-20 (07:16 and 10:00 UTC), and `git diff a7510b2f 5e388ccf -- packages/cezar/src/index.ts`
  is **empty**: the identical 5-line change, committed twice on parallel history and later
  joined by a merge. `67e93cca` has `workflowName ?? 'quick-task'`; both children have
  `workflowName ?? DEFAULT_WORKFLOW_NAME`. So the flip is exactly at the `67e93cca` boundary,
  the `good` endpoint is now *measured* rather than assumed (§6's honesty note is thereby
  discharged, not merely repeated), and the first bad commit on the specified ancestry is
  `a7510b2f`, the earlier of the two. The handoff's `097d1b15` hypothesis is refuted: it does
  not touch `index.ts`.
- **What is still stale and must be redone: the merge.** `main` has moved again, from
  `b2c3aa79` to `8790d334`. The branch is **14 behind, 3 ahead**, merge-base `b2c3aa79`.
  `main`'s own drift since that merge-base touches `src/workflows/run.ts` (+204) and
  `src/runs/store.ts` (+32) and **does not touch `src/index.ts` at all**, and it adds no
  `new Map<`/`new Set<`/`private readonly` run-state registry, so `runLiveness` stays complete.
  `git merge-tree --write-tree HEAD main` exits **1**, with exactly one conflicted path and it
  is a document: `.ai/specs/briefs/2026-08-23-headless-run-exits-mid-workflow.md` (add/add).
  `run.ts` auto-merges. Verification §0 runs again with these numbers.
- **CORRECTED 2026-08-24 (verification step): this bullet's claim is no longer true; every
  gate below has now been executed, and the measurements are in the new status block at the very
  top of this file.** ~~Still nothing has been executed. No `npm run typecheck`, no `npm test`,
  no `npm run test:unit`, no `npm run build`, no `npm run test:package`, no resource probe, no
  `CEZ_RUN_FAULT` run, no load-based secondary bisect. AC2 and AC3 remain open.~~ AC3 is closed
  and measured; AC2 is blocked on a defect this spec did not predict (the codex backend escapes
  `CEZ_DRY_RUN`), see the top block. The one
  pre-flight that *was* measured: this worktree now has a real root `node_modules` (317 entries,
  28 `.bin`, `vitest`/`tsx`/`typescript` all present), while `packages/cezar/node_modules` is
  empty, which is the normal hoisted-workspace shape, not the `AGENTS.md` resolve-upward trap.
- **New obligation this revision discovered, not in any prior block:** `main` carries a
  conflicting duplicate-closure record. See "Prior decisions this touches".

**CORRECTED 2026-08-24 during implementation:** P5 source work is complete on the task branch
after integrating `main` at `b2c3aa79`. The missing-record path now fails closed after three
ticks without attempting a store write, both miss paths expose refs-free diagnostics behind
`CEZ_RUN_WEDGE_DEBUG=1`, and the missing-record and consecutive-miss-reset unit cases exist.
The build-free primary bisect was executed and named `a7510b2f` as the first bad commit on the
selected ancestry. That autosave changes `runCommand` from the one-step `quick-task` fallback
to `DEFAULT_WORKFLOW_NAME`. The earlier `5e388ccf` prior below names a parallel-history commit
with the same five-line change, but it is not the commit reached first by the specified
`e9d77657` to `67e93cca` bisect. No build, test, package gate, runtime probe, or load-based
secondary bisect was run in this implementation step, so runtime verification and AC2 remain
pending for the separate gate step.

**Status 2026-08-24, revised for this run against HEAD `03371871`: CODE LANDED ON THE TASK
BRANCH, NOTHING VERIFIED.** P1 through P4 exist as source on `cez/eeceb869`
(`packages/cezar/src/runs/run-exit-guard.ts` new, 93 lines; `src/index.ts:1082-1145`;
`src/workflows/run.ts:3487-3501` and `:5093-5097`; two new test files; `.env.example:405`;
`AGENTS.md:367-370`; a `CORRECTED` lead-in on `.ai/specs/2026-08-22-run-broker-cli-keepalive.md`).
Against that: **no gate and no runtime step has been executed since the diff landed.** Not
`npm run typecheck`, not `npm test`, not `npm run test:unit`, not `npm run build`, not
`npm run test:package`, no resource probe, no `CEZ_RUN_FAULT` run, no bisect. This spec claims
no green anywhere, and the three acceptance criteria all stand open.

Two facts discovered while re-reading the code for this revision, both of which change the
verification plan and neither of which was true when the 2026-08-23 draft was written.
**Both are SUPERSEDED 2026-08-24 by the REVISED block at the top of this file**: fact 1's
numbers by the `b2c3aa79` merge and `main`'s subsequent move to `8790d334`, fact 2 by P5 step 2
and step 3 landing. They are kept below unchanged as the record of what the `03371871` reading
found, because the verification plan they created is the one still being executed:

1. **The task branch is 79 commits behind `main`** (merge-base `9c65f9e9`, `main` at
   `d01fc102`), and `main` has since rewritten the two files this change edits:
   `packages/cezar/src/index.ts` (295 changed lines) and `packages/cezar/src/workflows/run.ts`
   (77), 273 insertions and 99 deletions between them. Gates run on the un-integrated branch
   would measure a tree nobody will ship. Verification §0 is therefore the new first step.
2. **All seven designed unit cases were written; two cases this revision discovered were not,
   and one of the gaps is a live hang path.** `runWedgeTick` returns early on a missing record
   (`run-exit-guard.ts:72-73`) without counting a miss, so with the keep-alive armed a run whose
   store row is absent or unreadable holds the process open forever with `beforeExit`
   unreachable. See §"As built at HEAD `03371871`" for the full delta list.

**Status 2026-08-23 (kept below as the record of what the implementation session measured; its
"IMPLEMENTED" claim is about source existing, not about anything passing):** The
pre-implementation resource
probe confirmed the diagnosis: brokered execution spent 97.4% of 19,991 sampled ms on exactly
one ref'd handle (54 windows, narrowest 10 ms), while `CEZ_RUN_BROKER=0` spent 0.6% of 16,238
sampled ms there (6 windows, narrowest 12 ms). Both completed all eight steps and neither trace
contained an empty transition. P1 through P4 are implemented; gates, post-fix probes, runtime
repetition, package E2E, and P0 bisect remain pending.

Written 2026-08-23 for task `eeceb869` against HEAD
`84fb8237`. The diagnosis below is **measured on this box**, not inferred: see Problem
§"The measurement" for the instrumented run, and Problem §"What this is not" for the five
candidate mechanisms this session ruled out with citations so the implementation step does
not re-tread them.

Supersedes nothing. It **narrows** `.ai/specs/2026-08-22-run-broker-cli-keepalive.md`, whose
own status line claims the class was closed — it closed one instance of it. See
"Prior decisions this touches".

## TLDR

`npm run test:package`'s tarball case ("the release tarball installs and runs the dry-run CLI
workflow", `packages/cezar/test/e2e/package-cli.test.ts:14` — call it by name; the handoff's
"case 5" is a stale ordinal, see Verification §5) is red: the packaged CLI's
`node dist/index.js run mock:done --repo <fixture>` prints `run started` / `worktree ready` /
`── step: Gather the record` and then **exits 0**, leaving `.ai/cezar/runs.json` at
`status: "running"` with no `error`. Exit 0 is what makes it lethal — no caller can tell it
from a success.

Root cause, measured: **the one-shot CLI has no handle of its own that represents "a run is in
flight."** `runCommand` (`src/index.ts:989`) starts the run fire-and-forget
(`manager.startRun`, `:1073`; the engine is entered through `void this.pump()`,
`src/workflows/run.ts:1417`) and then awaits a promise that is resolved by a
`store.on('run')` listener (`src/index.ts:1076-1080`). An EventEmitter listener refs nothing,
and a pending promise refs nothing. So the process stays alive **only** for as long as the
run's *current* piece of work happens to own a libuv handle — a child-process pipe, an fs
request, or the `BrokeredSession` poll timer. Instrumenting a healthy 8-step dry run at HEAD
with `process.getActiveResourcesInfo()` shows the process spent **97.1% of its 20.1 s on
exactly ONE ref'd handle**, with 56 single-handle windows, the narrowest 7 ms, and 110 ms in
which the only thing keeping `cez run` alive was an in-flight `FSReqPromise`. Any instant
where the hand-off from one handle to the next has a gap is an instant where Node's ordinary
empty-loop drain exits the process with `process.exitCode` never set — i.e. 0.

That is why this is load-sensitive (found by a *gate run* on a loaded box, and it does not
reproduce on a quiet one), and why fixing one such gap — commit `3e6d1b7e`, which ref'd the
broker poll timer — moved the failure rather than removing it.

The fix is to stop relying on the hand-off chain:

- **P0** — the bisect AC1 asks for, run **last** (after P1-P4) and on a *deterministic*
  predicate: which commit made the CLI's default workflow multi-step. The load-based
  confirmation is secondary and time-boxed, because a bisect whose test never goes red marks
  every candidate good and terminates on noise.
- **P1** — a `beforeExit` guard in `runCommand`: never exit 0 while the record is
  non-terminal. Small, independently shippable, and it makes every *future* member of this
  class loud instead of silent. The hook is measured to fire with an empty ref-set — the probe
  recorded `BEFORE-EXIT code=0 refd=[]`. Stated precisely: that sample was taken at normal
  end-of-process on a run that *completed*, not at a mid-run drain. The mechanism is identical
  (`beforeExit` fires whenever the loop empties, whatever emptied it), so the conclusion holds;
  the trace shows the hook firing, not the bug firing.
- **P2** — a **run-lifetime keep-alive** owned by `runCommand`, ref'd from `startRun` until
  the record reaches a terminal status. This removes the class rather than one instance.
- **P3** — a stall detector on the same tick, so P2 can never trade a silent exit-0 for a
  silent hang: if the manager reports the run is not in flight anywhere while the record is
  still non-terminal, fail the record loudly and exit non-zero.
- **P4** — deterministic fault injection (`CEZ_RUN_FAULT=stall-step`) plus the tests, so this
  class is covered by something that does not depend on a loaded box to go red.

## Problem

### The failure, as reported

From the handoff (task `eeceb869`), reproduced by hand against the built CLI:

```
# node dist/index.js run mock:done --repo <fixture>
# env: CEZ_DRY_RUN=1
run started
worktree ready
── step: Gather the record
# exit 0, immediately, no further output
# <fixture>/.ai/cezar/runs.json  →  [{ status: "running", error: undefined }]
```

Proven pre-existing at clean `a5f04b0f` and clean `387ba439` with no diff applied and a full
`CEZ_*` env scrub, so it is not caused by task `737eba99`'s change.

**The record reads as deterministic and this spec does not; that is not a contradiction, and
the next session should not read it as one.** Root `AGENTS.md:374` says the failure "Reproduces
IDENTICALLY at clean HEAD", written from a gate run on a loaded box. Three deliberate attempts
on a *quiet* box across 2026-08-23 and 2026-08-24 did not reproduce it. Both observations are
believed: the diagnosis below is a hand-off race whose window is measured in single-digit
milliseconds (§"The measurement"), so a box with eight busy cores hits it reliably and an idle
one essentially never does. The `AGENTS.md` entry is not being contradicted, it is being
explained, which is why Verification §4 and §5 each run twice, idle **and** under load, and why
P0's bisect predicate is deterministic rather than load-based (§6).

The e2e that catches it asserts `run.stdout` matches `/run (done|review)/`
(`test/e2e/package-cli.test.ts:86`) and that the single `runs.json` row is `done`/`review`.
Both fail, and `execFile` resolves rather than rejecting, because the exit code is 0.

The handoff and root `AGENTS.md` both call this test **"case 5"**. That ordinal was correct at
`3e6d1b7e` and is stale at HEAD — `test:package` now has 18 cases and this one is the 8th
(Verification §5 has the arithmetic). Refer to it as
`packages/cezar/test/e2e/package-cli.test.ts:14`, by name.

### The measurement

The brief (`.ai/specs/briefs/2026-08-23-headless-run-exits-mid-workflow.md`, open question 1)
left "get a real runtime repro" unresolved — one quiet local attempt passed. This session did
not get the failure to reproduce either, and that is itself the finding: **the healthy path
is the evidence.** Run at HEAD `84fb8237` against the already-built `packages/cezar/dist`,
with a preloaded probe that samples `process.getActiveResourcesInfo()` (the list of resources
*currently keeping the event loop alive*) every 5 ms from an `unref()`'d timer, so the
sampler itself never appears in the list and never prevents the drain it is looking for:

```
env -u CEZ_TASK_ID … CEZ_DRY_RUN=1 CEZ_HOME=<tmp> \
  node --import file://<tmp>/probe.mjs dist/index.js run 'mock:done' --repo <fixture>
```

Result: the run **completed** (`run done — 11640 tokens`, `runs.json` → `done`) in 20.6 s
across all 8 spec-to-deploy steps. The resource trace:

| measure | value |
| --- | --- |
| distinct ref-set transitions | 122 over 20 113 ms |
| time held open by **exactly one** ref'd handle | **19 535 ms — 97.1%** |
| single-handle windows | 56, narrowest **7 ms** |
| time where the only ref'd handle was an fs request | 110 ms |
| most common ref-set | `[Timeout]` (47 windows) |
| terminal sample | `BEFORE-EXIT code=0 refd=[]` |

The recurring step-boundary shape, verbatim from the trace, is a three-hop hand-off in which
no two handles are ever alive together:

```
+3123ms refd=[PipeWrap,PipeWrap,PipeWrap,ProcessWrap,Timeout]   step N's session + a git child
+3143ms refd=[Timeout]                                          child gone; only the poll timer
+3159ms refd=[FSReqPromise]                                     timer cleared; only an fs read
+3167ms refd=[Timeout]                                          step N+1's poll timer armed
```

That 8 ms `[FSReqPromise]` window is the whole safety margin at a step boundary, and it exists
only because `loadWorkspaceConfig()` is genuinely uncached (see below). A slower or
differently-ordered tick — which is what a loaded box produces — puts a zero-handle instant in
that chain, and the process is gone.

### Root mechanism, read from code in the order it executes

1. `runCommand` (`src/index.ts:989`) builds the store, semaphore (`:1040`) and `RunManager`
   (`:1042`), then calls `manager.startRun(...)` (`:1073`), which returns a `RunRecord`
   **synchronously** and enters the engine through `void this.pump()`
   (`src/workflows/run.ts:1417`) — fire-and-forget by design.
2. `runCommand` then awaits `new Promise<string>` resolved from a `store.on('run')` listener
   (`src/index.ts:1076-1080`), and sets `process.exitCode` from the result (`:1087`).
   **Neither the listener nor the pending promise refs the event loop.** `process.exitCode`
   is left at its default 0 unless that line runs.
3. Every handle the process actually has belongs to the run's current work: the broker's
   `BrokeredSession` poll interval (`src/core/brokered-session.ts:158-162`, deliberately ref'd
   by `3e6d1b7e`), a spawned `git`/backend child's pipes, or an fs request. The broker child
   itself is `detached: true` + `proc.unref()` (`src/core/claude-cli-runner.ts:492,498`) — on
   purpose, so the launcher never holds a pipe to a process meant to outlive it.
4. The poll timer is cleared the instant *one step's* session reaches a terminal state —
   `finish()` (`brokered-session.ts:227`) and `detach()` (`:351-356`) both `clearInterval`.
   Every other timer in the engine is `unref()`'d and therefore contributes nothing: the queue
   watchdog (`run.ts:1081`), the auto-resume timer (`:2512`), the approval-timeout timer
   (`:4971`), the per-run idle timer (`:6172`), and the store's debounced save timer
   (`src/runs/store.ts:1424`).

So the invariant the CLI currently runs on is: *"at every instant of a multi-minute,
eight-step run, some piece of the engine happens to own a ref'd handle."* Nothing enforces
it, nothing tests it, and the measurement above shows it holds by a margin of single-digit
milliseconds at each of the 56 hand-offs.

### What this is not — ruled out this session, with citations

Recording these so the implementation step does not re-derive them:

- **Not a swallowed exception.** Both floating `execute()` calls catch and *fail the record*:
  `run.ts:1666-1679` (`engine crashed: …`) and `run.ts:2190-2199` (`re-attach crashed: …`).
  A throw would leave `status: 'failed'` with an error, not `running` with none.
- **Not an unhandled rejection.** There is no `unhandledRejection`/`uncaughtException` handler
  anywhere in `src/` (grepped), so a floating rejection would print a stack and exit **1**,
  not exit 0 silently.
- **Not an explicit exit.** No `process.exit()` on the `run` path — the only non-test call
  sites are the `serve` shutdown (`src/index.ts:920,981`), `:1916`, and the broker's own
  `src/core/run-broker.ts:266`.
- **Not `loadWorkspaceConfig()` caching.** The brief flagged this as unverified (open question
  2). Settled: it is **never cached** — `src/workspace/config.ts:372` says so explicitly and
  `loadWorkspaceConfig` (`:388`) does a real `readFile` (`:391`) on every call. That is why `await this.runResourceLimits()`
  inside `brokerFor` (`run.ts:2033`) shows up in the trace as a ref'd `FSReqPromise`. The
  brief's hypothesis that *this specific await* is the gap is therefore **wrong** — it is one
  of the few things holding the gap shut. Correct that when citing the brief.
- **Not the heavy-step gate — for this test, but it is the same latent hazard.**
  `WorkspaceSemaphore.acquireHeavyStep()` (`src/workspace/semaphore.ts:269-281`) queues into
  `heavyWaiters` (`:197`) and is resolved only by an in-process `releaseHeavyStep()` (`:285`).
  That promise refs **nothing**. It cannot be the cause here: only `run-tests` declares
  `heavy: true` (`src/workflows/types.ts:910`), `maxHeavySteps` is `.optional()` with no
  default (`src/workspace/config.ts:120`, `?? Infinity` at `semaphore.ts:232`), and the e2e
  runs under a fresh temp `CEZ_HOME`. But on a box where the key **is** set — `config.ts:120`'s
  own docblock records `prod-host` as having it written to 2 — a one-shot `cez run` that
  queues at that gate has zero ref'd handles and drains exactly the same way. P2 covers it;
  the eventual fix must not be so narrow that it doesn't.
- **Not the dry-run postconditions.** `src/workflows/postconditions.ts:70-87,334` short-circuit
  every `verify:` to a green `dryRunVerdict` under `CEZ_DRY_RUN=1`, so no later gate can be
  the blocker.

**And one entry that is the opposite of a rule-out — the strongest recorded datum about this
bug, and it *supports* the drain theory.** Root `AGENTS.md:371-372` (trap 5) records the
decisive control from the original investigation: **"`CEZ_RUN_BROKER=0` makes the identical run
finish; the default brokered path stalls."** The flag is live and reaches
`brokerPreference()` (`src/core/broker-launch.ts:26,35`); `0` forces the in-process path.

That is exactly what the drain theory predicts, and it is not a coincidence: the in-process
path holds a child's stdio pipes (a ref'd `PipeWrap`/`ProcessWrap` set) for the *whole* duration
of a step, so it has no hand-off gaps to fall through. The brokered path detaches
(`claude-cli-runner.ts:492,498`) and survives only on the poll `Timeout` that `finish()`/
`detach()` clear at every step boundary (`brokered-session.ts:158-162,351-356`). Same run, same
workflow, different number of zero-handle instants.

It is also a **free, falsifiable prediction**, which is why Verification §2 runs it as an A/B
before P2 lands: under the resource probe, `CEZ_RUN_BROKER=0` must show **no single-handle
`[Timeout]` windows at step boundaries**, while the default path must show them. If the
in-process path shows the same 7-20 ms single-handle hand-offs, this diagnosis is wrong and P2
is being built on a coincidence — stop and re-diagnose before writing the keep-alive.

### Why `3e6d1b7e` did not close this

`.ai/specs/2026-08-22-run-broker-cli-keepalive.md` diagnosed the identical symptom in the
identical test and fixed it by making **one** handle ref'd: the `BrokeredSession` poll timer,
for exactly as long as one session is open. That was correct and it is on HEAD
(`git merge-base --is-ancestor 3e6d1b7e HEAD` → yes, per the brief). What it could not do is
change the *shape*: the process is still alive only while some step-scoped handle exists, and
`finish()`/`detach()` still clear that handle at every step boundary. Its verification passed
15/15 at the time — on a quiet box, where, as measured above, the healthy path survives its
hand-offs by 7-20 ms.

The commit that made this reachable eight times per run instead of once is **`5e388ccf`**
(2026-08-20 10:00:24, an autosave), which flipped the CLI's default from `quick-task` to
`DEFAULT_WORKFLOW_NAME` at `src/index.ts:1003`. Before it, `cez run mock:done` ran the 1-step
`QUICK_TASK_WORKFLOW` (`src/workflows/types.ts:283`) — no step boundary at all. The handoff's
own hypothesis named `097d1b15`; that commit never touches `index.ts` (brief, verified).
`5e388ccf` bundles 52 unrelated files, so it is a lead, not a verdict — P0 runs the real
bisect.

## Solution

Four changes, each independently shippable, in increasing order of how much of the class they
close. P1 alone already satisfies the weaker half of AC3 and is worth landing on its own.

### P1 — `beforeExit`: never exit 0 with a non-terminal record

Register, inside `runCommand` and only for the lifetime of the awaited run, a
`process.on('beforeExit')` handler. `beforeExit` fires precisely when the loop has emptied and
the process is about to exit normally — which is the drain, and nothing else (it does not fire
for `process.exit()` or an uncaught throw). The handler:

1. Guards against re-entry with a one-shot flag (a `beforeExit` handler that does only
   synchronous work leaves the loop empty again and would otherwise fire in a loop).
2. Reads the record. Terminal (`done` / `review` / `failed` / `cancelled`) → do nothing; the
   normal path is finishing.
3. Non-terminal → `store.updateRun(runId, { status: 'failed', error: 'cezar exited before the
   run finished — the process ran out of work while the run was still <status> (no step, no
   session and no queued job held the event loop open)', finishedAt })`, `store.flush()` (both
   synchronous — `runs/store.ts`), print the message to stderr, and set `process.exitCode = 1`.

This is a pure backstop: on a healthy run it never fires, because the loop is not empty.

### P2 — a run-lifetime keep-alive owned by the CLI

The correct owner of "a run is in flight" is the thing that is waiting for the run, not the
step that happens to be executing. `runCommand` arms one ref'd `setInterval` immediately
before `manager.startRun(...)` and clears it in a `finally` around the `final` await. Cadence
is a liveness tick, not a poll of anything expensive — `RUN_KEEPALIVE_MS = 1000` — and the
callback body is P3's check.

Scoped to `runCommand` deliberately, **not** to `RunManager`: the server path already has a
ref'd HTTP listener and does not want a second always-on interval per manager, and the CLI is
the only process whose lifetime is supposed to equal one run's. `RunManager` gains only the
read-only predicate P3 needs.

With P2 in place, the 56 hand-off windows measured above stop mattering: the keep-alive is
ref'd across all of them, so a gap in the chain is no longer an exit.

### P3 — the stall detector, so P2 cannot buy a hang

A keep-alive that is unconditionally ref'd converts "silent exit 0" into "silent hang forever"
whenever the run genuinely will not progress. AC3 forbids both, so the keep-alive tick must be
able to answer *"is this run actually in flight?"* — and the manager already holds every piece
of that answer in memory. Add a read-only predicate:

```ts
// src/workflows/run.ts (RunManager)
runLiveness(runId: string): { live: boolean; reason: string }
```

`live` is true if any of these holds, and `reason` names which:

| source | meaning | anchor |
| --- | --- | --- |
| `this.active.has(runId)` | the step chain is executing | `run.ts:927` |
| `this.starting.has(runId)` | admitted, about to execute | `run.ts:932` |
| `this.queue.includes(runId)` | waiting for a slot | `run.ts:931` |
| `this.waiting.has(runId)` | parked on approval / message | `run.ts:938` |
| `this.monitoring.has(runId)` | durable monitoring session | `run.ts:940` |
| `this.autoResumeTimers.has(runId)` | scheduled resume | `run.ts:982` |
| `this.pendingJobs.has(runId)` | job accepted, not yet dequeued | `run.ts:941` |

**These seven do NOT cover every state the engine models, and the uncovered one is on the
healthy path.** An earlier draft of this spec claimed the six-source union was total. That claim
was false, and correcting it is why the seventh row exists.

The chain hand-back at the end of **every** step drops a perfectly healthy run out of the
registry sets before it puts it back. `runContinuation` calls `this.dropActive(runId)`
(`run.ts:4107`), which deletes the run from `active`, `waiting` and `monitoring`
(`run.ts:2430-2445`), and only *then* awaits
`this.reenterChain(handBack, 'step goal achieved', { requireProgress: true })` (`run.ts:4161`).
`reenterChain` (`run.ts:2322`) opens with `await this.reviveWorkflow(run)` (`run.ts:2352`, a
real fs read) before it does anything observable, then sets `pendingJobs` (`run.ts:2393`),
writes the record to `status: 'queued'` (non-terminal, so P1's guard would fire on it), and
pushes to `queue` (`run.ts:2413-2421`). The default workflow crosses that window **7 times per
run**, and it is precisely the `[Timeout] → [FSReqPromise] → [Timeout]` boundary that Problem
§"The measurement" recorded.

Adding `pendingJobs` shrinks the uncovered span to exactly one gap: `dropActive`
(`run.ts:4107`) to `pendingJobs.set` (`run.ts:2393`), whose entire content is the
`reviveWorkflow` fs read plus synchronous bookkeeping. `pendingJobs` is also set by `startRun`
(`run.ts:1415`) immediately before its `queue.push`, so the same row covers the pre-queue
instant at run start, and it is the same set the engine's own `isQueued()` already treats as
authoritative for "is this run still pre-dequeue" (`run.ts:3062-3069`, whose comment explains
why the record's own `status` cannot answer that question).

So the wedge predicate is: in none of the seven **and** the record is non-terminal. That is a
strong signal, not a proof, with one known false-positive window bounded by a single fs read.
`RUN_WEDGE_TICKS = 3` (about 3 s, below) is sized against **that** window, not against the
length of a step: a step can occupy 40 minutes and never leave `active`.

**Relation to the existing `RunManager.isActive()`** (`run.ts:2944`, `active || starting ||
queue`): `runLiveness` does not supersede it, and must not replace it. `isActive` answers a
deliberately narrower, server-side question, "may an HTTP caller mutate, cancel or merge this
run right now?" (`server/server.ts:5064,5548,5589,5598,5654,5683`), where counting a parked,
monitoring or merely-accepted run as active would wrongly reject a legitimate call.
`runLiveness` answers "could this run still make progress?", which is wider on purpose. Two
predicates, two questions; both stay, and `runLiveness` carries a comment saying so, so the
next session does not "consolidate" them.

**The terminal branch must be total, not a bare `return`.** The obvious tick body opens
`record = store.getRun(runId); if (terminal) return` — and with P2 armed, that branch is the one
case where the keep-alive is never cleared *and* `beforeExit` can never fire, so a terminal
record whose `store.on('run')` resolution was missed becomes an **unbounded hang**: precisely
the outcome this spec says it will not trade for. Today that same case exits (wrongly, but it
exits), so a careless P3 would make it strictly worse.

The window is real in shape even if not currently reachable: the listener is registered *after*
`startRun` returns (`src/index.ts:1073`, then `:1076-1080`) and `emit('run')` is fully
synchronous (`src/runs/store.ts:872-874`, `:1394-1397`), so any status write inside `pump()`'s
synchronous prefix (`src/workflows/run.ts:1562-1572`, before the first `await` at `:1576`) would
be emitted into a void. I did not find a path that does this at HEAD — but P2 is exactly what
converts a missed resolution from "exits" into "never exits", so the branch must be closed
regardless of whether it is reachable today.

So on a terminal record the tick **settles, it does not return**: resolve the awaited `final`
with `record.status` (one-shot and idempotent, sharing a single settle function with the
`store.on('run')` listener so whichever fires first wins), clear the keep-alive, and return. The
CLI's existing exit-code path (`src/index.ts:1087`) then runs unchanged and maps the status to
0 or 1 as it always has. Verification §3 case 7 tests this branch directly.

The keep-alive tick requires the wedge condition to hold for `RUN_WEDGE_TICKS = 3` consecutive
ticks (≈3 s) before acting, to tolerate any single-tick window where a run is momentarily
between sets. On the third, it takes P1's failure path (same message, with `reason` appended)
and clears the keep-alive so the process exits 1.

**This does not add a wall-clock stall heuristic.** A long agent turn, a 40-minute test step
and a parked session are all `live` by the table above, so nothing here can kill slow-but-
healthy work — which is the failure mode a naive "no events for N minutes" watchdog would have.

### P4 — make the class reproducible without a loaded box

Follow the precedent already in this codebase: `CEZ_BROKER_FAULT`
(`src/core/claude-cli-runner.ts:418`, `src/core/run-broker.ts:80-86`) is an inert-unless-set
fault injector that exists purely so a spec's verification can force a race. Add the same
shape for this one:

- `CEZ_RUN_FAULT=stall-step[:<stepId>]` — in `execute()`, immediately after the `step-start`
  event is emitted (`run.ts:4525`) for the named step (default: the first agent step), `await`
  a promise that is never resolved and holds no handle: `await new Promise(() => {})`.

That is not a simulation of the bug; it *is* the bug, in its purest form — the run's async
chain pending with zero ref'd handles behind it. On unfixed code it reproduces the report
exactly (exit 0, `runs.json` at `running`, no error). On fixed code, P2 holds the loop, P3
sees `active.has(runId)` stay true with no progress… and here is the one honest limitation to
state up front:

**With `stall-step`, `runLiveness` returns `live: true`** (the chain is still inside
`execute()`, so the run is in `active`). P3 therefore does **not** fire, and the fixed CLI
**hangs** rather than exiting 1. That is the correct and intended trade: an engine bug that
parks the chain forever is not something the CLI can distinguish from a legitimately long
step, and AC3's guarantee is about never reporting success falsely. So the P4 test asserts
**"does not exit 0 with a running record"** — it kills the process after a bounded wait and
asserts no exit-0 occurred — rather than asserting a specific non-zero code. The
exit-non-zero path is tested separately by P3's own unit test, which drives the predicate
directly. Say this in the test's comment; a reader who expects exit 1 here and finds a hang
will otherwise "fix" it back.

## Architecture

```
  cez run  (one process, one run, no HTTP listener)
  ─────────────────────────────────────────────────────────────────────
  runCommand()                                       src/index.ts:989
    ├─ keepAlive = setInterval(tick, 1000)   ← P2, ref'd  ─────────┐
    ├─ manager.startRun(...)          :1073  (returns sync)        │  held for the
    │     └─ void this.pump()   run.ts:1417  (fire and forget)     │  WHOLE run,
    ├─ await new Promise(store.on('run'))    :1076                 │  independent of
    │        ↑ refs NOTHING — this is the defect                   │  any step
    └─ finally { clearInterval(keepAlive) }                     ───┘

  tick():                                                  ← P3
    record = store.getRun(runId)
    if (terminal) { settleFinal(record.status)   ← one-shot, idempotent,
                    clearInterval(keepAlive)        SHARED with the
                    return }                        store.on('run') listener
        ^ never a bare `return`: with P2 armed, that is the ONE branch
          that can hang forever (keep-alive uncleared, beforeExit unreachable)
    if (manager.runLiveness(runId).live) { misses = 0; return }
    if (++misses < 3) return
    fail the record loudly · flush · exitCode = 1 · clear keepAlive

  process.on('beforeExit')                                 ← P1 backstop
    fires only if the loop empties anyway (P2 not yet armed,
    an early return, or a future path nobody thought about)
    → same failure write, exitCode = 1, never a silent 0

  ── today, without P2, the loop is held by whatever the STEP owns ──
  step N:  [PipeWrap×3, ProcessWrap, Timeout]  →  [Timeout]
  gap:     [FSReqPromise]                 ← 8 ms, measured
  step N+1:[Timeout]
           ^ any zero-handle instant in this chain = silent exit 0
```

## Data models

No persisted schema change. One new run-record *value* on an existing field:

| field | type | written by | value |
| --- | --- | --- | --- |
| `status` | existing enum | P1 / P3 | `'failed'` |
| `error` | existing `string \| undefined` | P1 / P3 | `cezar exited before the run finished — <reason>` |
| `finishedAt` | existing ISO string | P1 / P3 | write time |

Constants (new, in the module that uses them):

| name | value | where |
| --- | --- | --- |
| `RUN_KEEPALIVE_MS` | `1000` | `src/runs/run-exit-guard.ts` |
| `RUN_WEDGE_TICKS` | `3` | `src/runs/run-exit-guard.ts` |

Both live in the new module rather than in `src/index.ts` so they are reachable from a test:
see Verification §3 for why importing `src/index.ts` is not an option.

Environment (new, inert unless set):

| variable | values | effect |
| --- | --- | --- |
| `CEZ_RUN_FAULT` | `stall-step` / `stall-step:<stepId>` | Verification-only. Parks the step chain with no ref'd handle after `step-start`. |

## API / interface contracts

**New, `RunManager`** — read-only, no side effects, safe to call on any tick:

```ts
/** Is this run in flight anywhere in this process? `reason` names the source, or why not. */
runLiveness(runId: string): { live: boolean; reason: string };
```

`live: false` with a non-terminal record is a wedge by definition — the caller decides what to
do about it. This method must not mutate `active`/`queue`/`waiting`, must not `pump()`, and
must not read the filesystem.

**Behavioural contract, `cez run` (this is AC3, stated as a testable invariant):**

> `cez run` exits 0 **iff** the run record it started has reached `done` or `review`. It exits
> non-zero for `failed`/`cancelled`, and for any exit taken while the record is non-terminal,
> in which case the record is left `failed` with an `error` explaining the exit. It never exits
> 0 with a non-terminal record.

Unchanged: exit codes for the existing terminal statuses (`src/index.ts:1087`), stdout format,
`review` messaging, and every non-`run` subcommand.

## As built at HEAD `7a19ca72`

Everything above this section is the design. This section is the **code that actually exists on
`cez/eeceb869`**, re-read line by line at HEAD `7a19ca72` on 2026-08-24 (it was written against
`03371871`, before the `b2c3aa79` merge and P5 steps 2-3; every anchor below has moved and every
one has been re-verified), so that the verification below anchors on the tree rather than on the
plan. Where the two differ, the code is what runs.

**Where each piece landed.**

| design | as built | anchor at `7a19ca72` |
| --- | --- | --- |
| P1 `beforeExit` guard | `runExitGuard(store, runId, state)`, one-shot via `state.handled`, no-op on a terminal or missing record | `src/runs/run-exit-guard.ts:48-58`, wired at `src/index.ts:1103-1106` |
| P2 run-lifetime keep-alive | `setInterval(..., RUN_KEEPALIVE_MS)` armed **before** `manager.startRun` and cleared in `.finally()` on the awaited promise | `src/index.ts:1107-1117` (arm), `:1119` (`startRun`), `:1133-1136` (clear + both listener removals) |
| P3 `runLiveness` | seven-source predicate, comment explaining why it is not `isActive()` | `src/workflows/run.ts:3548-3557`; `isActive` unchanged at `:3540` |
| P3 wedge tick | `runWedgeTick({store, runId, state, liveness, settle, clearKeepAlive})`, `RUN_KEEPALIVE_MS = 1_000` (`:3`), `RUN_WEDGE_TICKS = 3` (`:4`) | `src/runs/run-exit-guard.ts:64-112` |
| P4 fault injector | `CEZ_RUN_FAULT=stall-step[:<stepId>]`, immediately after the `step-start` emit | `src/workflows/run.ts:5155` (emit), `:5157-5161` (fault) |
| P4 e2e re-timing | inner `execFile` timeout 120s (`:85`), test timeout 240s (`:14`), with the 20.6s measurement in the comment at `:80-84` | `test/e2e/package-cli.test.ts:14,80-85` |
| P5 missing-record close (delta 4 below) | counts a miss, fails closed on the third with stderr + `exitCode = 1` + `settle('failed')` + `clearKeepAlive()` and **no** store write | `src/runs/run-exit-guard.ts:72-86` |
| P5 wedge diagnostics | `CEZ_RUN_WEDGE_DEBUG=1` gated `process._rawDebug` through a local typed view, on **both** miss paths | `src/runs/run-exit-guard.ts:75-78` (record missing) and `:101-106` (not live) |
| env contract | `CEZ_RUN_FAULT` and `CEZ_RUN_WEDGE_DEBUG` documented under the testing/internal block | `.env.example:405` and `:407` |
| in-place corrections | `AGENTS.md:367` trap 5, and the `CORRECTED 2026-08-23` lead-in on `.ai/specs/2026-08-22-run-broker-cli-keepalive.md:3-6` | both landed, re-verified at `7a19ca72` |

**Deltas from the design, each deliberate or harmless but none of them written down before now.**

1. **The error string uses a colon, not an em dash, and carries the liveness reason instead of
   the designed parenthetical:** `cezar exited before the run finished: the process ran out of
   work while the run was still <status>[: <reason>]` (`run-exit-guard.ts:25-28`). The wedge path
   passes `liveness.reason`; the `beforeExit` path passes none. Better than designed, and it
   respects the workspace no-em-dash rule.
2. **The settle path is stronger than designed.** `runCommand` now owns a shared one-shot
   `settle()` (`src/index.ts:1091-1099`) used by both the `store.on('run')` listener and the
   wedge tick, plus a `pendingFinal` stash and a synchronous re-read of the record inside the
   promise executor (`:1127-1132`). That closes the "a terminal status emitted before the
   listener is registered goes into a void" window that P3 could only describe, not fix.
3. **The fault injector fires on the first `agent`-kind step, not on a named default.** The
   guard is `faultName === 'stall-step' && kind === 'agent' && (!faultStepId || faultStepId ===
   step.id)` (`run.ts:5159`), so `CEZ_RUN_FAULT=stall-step` stalls whichever agent step executes
   first, which for `spec-to-deploy` is step 1. Same observable behaviour; state it plainly so
   nobody reads "the first agent step" as a hard-coded id.
4. **CLOSED 2026-08-24 by P5 step 2, re-verified in source at `7a19ca72`. A missing run record
   was an unbounded hang, and it was not designed.** The original finding is kept below
   unchanged; what replaced it is `run-exit-guard.ts:72-86`, which now increments
   `state.misses`, emits the gated `record missing` diagnostic, returns while
   `misses < RUN_WEDGE_TICKS`, and on the third tick prints
   `cezar exited before the run finished: its run record is missing from the store (<runId>)`
   to stderr (`:81`), sets `process.exitCode = 1` (`:82`), calls `settle('failed')` (`:83`) and
   `clearKeepAlive()` (`:84`), **with no store write**, because there is no row to write.
   `runExitGuard`'s `!record` no-op (`:55-56`) is deliberately left alone. The unit case is
   `run-exit-guard.test.ts:122`. What remains open is that none of it has been executed: this is
   a source reading, not a test result.
   ~~`runWedgeTick` opens `const record = options.store.getRun(options.runId); if (!record) return;`
   (`run-exit-guard.ts:72-73`) **without counting a miss and without clearing the keep-alive**,
   and `runExitGuard` likewise no-ops on `!record` (`:55-56`). So a run id whose store row is
   absent, deleted mid-run, or unreadable leaves the ref'd interval armed forever with
   `beforeExit` unreachable: exactly the hang this spec promised P3 would never buy. It is the
   same shape as the terminal-branch hazard P3 already argues about, on the one input P3 did not
   enumerate. Fix is one line (treat a missing record as a miss, and fail the run on the third),
   and Verification §3 case 8 covers it.~~

**Test coverage as built, re-counted at `7a19ca72`: all nine cases now exist.** The two rows
this section previously marked **NO** were written by P5 step 3. `run-exit-guard.test.ts` is 181
lines with six `it` blocks under two `describe`s; `run-liveness.test.ts` is 79 lines with two.
Written is not passing: no test runner has been invoked on this tree (Verification §3, §7).

| designed case (Verification §3) | written? | where at `7a19ca72` |
| --- | --- | --- |
| 1. seven liveness sources, each with its `reason` | yes, `it.each` over all seven | `src/workflows/run-liveness.test.ts:35` |
| 2. `live: false` for unknown / unregistered id | yes | `run-liveness.test.ts:49` (one `it` block, shared with case 3) |
| 3. predicate mutates nothing | yes, size snapshot before/after | `run-liveness.test.ts:49` (same block) |
| 4. terminal record, guard is a no-op | yes | `src/runs/run-exit-guard.test.ts:52` |
| 5. non-terminal, fails once, one-shot | yes | `run-exit-guard.test.ts:60` |
| 6. two misses do nothing, the third fails | yes | `run-exit-guard.test.ts:77` |
| 7. terminal-branch totality (tick settles, clears keep-alive, does not rewrite the record) | yes, `it.each<RunStatus>(['done', 'failed'])` | `run-exit-guard.test.ts:101` |
| 8. missing record does not hang, per delta 4 | **yes, added by P5 step 3** | `run-exit-guard.test.ts:122` ("settles failed after three missing-record ticks without trying to write a row") |
| 9. misses reset to 0 when liveness returns live | **yes, added by P5 step 3** | `run-exit-guard.test.ts:156` ("resets consecutive misses after a live tick") |

**Corrected in this revision: case 7 is written, and an earlier draft of this section said it
was not.** It is `it.each<RunStatus>(['done', 'failed'])('settles terminal %s records and clears
the keep-alive')` at `run-exit-guard.test.ts:101-120`, asserting `settle` called with the
record's own status, `clearKeepAlive` exactly once, and `updateRun` **not** called, with a
comment naming the missed-store-event hazard, which is exactly what the design asked for. The
one half of the designed assertion it does not make is the exit code (`done` → 0, `failed` → 1),
and that half is **not unit-testable** under this section's own rule against importing
`src/index.ts`: the status-to-exit-code mapping lives at `src/index.ts:1138`, inside
`runCommand`. It is covered at runtime instead, by Verification §2 and §5.

**Both "(new)" rows are now written** (P5 step 3, 2026-08-24): the misses reset at
`run-exit-guard.test.ts:156`, and the missing-record hang from delta 4 at `:122`. Nothing in the
unit layer is outstanding. What is outstanding is execution: see Phases and Verification §7.

## Phases

Each phase is independently shippable and independently verifiable.

**Where this stands on 2026-08-24, re-read at HEAD `7a19ca72`:** P1 through P4 plus P5 steps 1
to 3 are **written and still unverified** on `cez/eeceb869` (see §"As built at HEAD `7a19ca72`").
P0's primary, build-free bisect **has run** and named `a7510b2f`. What remains is the whole of
P5 step 4 (re-integrate the `main` that has moved since, `b2c3aa79` → `8790d334`, then execute
every gate and every runtime step in Verification §0 to §7), plus P0's load-based secondary and
the record corrections in "Prior decisions this touches". P1 to P4 stay below unchanged as the
record of what was designed and why.

| phase | state at HEAD `7a19ca72` |
| --- | --- |
| P1 `beforeExit` guard | code landed, **unverified**, 2 of 2 designed unit cases written |
| P2 keep-alive | code landed, **unverified**, no probe re-run, no healthy-path repetition |
| P3 `runLiveness` + wedge | code landed, **unverified**; all 9 unit cases written; missing-record hang closed in source (`run-exit-guard.ts:72-86`) |
| P4 fault + e2e re-timing | code landed, **unverified**; `CEZ_RUN_FAULT` still never executed |
| P5 step 1 integrate `main` | done once at `b2c3aa79`; **must run again**, `main` is now `8790d334` (14 ahead, merge-base `b2c3aa79`) |
| P5 steps 2-3 close hang + test gaps | **done in source**, re-verified line by line at `7a19ca72`, never executed |
| **P5 step 4 gates + runtime** | **not started. This is the entire remaining critical path** |
| P0 bisect (AC1) | **primary done**: build-free static predicate named `a7510b2f`. Load-based secondary not started |

### P5: integrate, close the missing-record hang and the two test gaps, run every gate

The phase that converts "written" into "done". In order, because each step invalidates the
previous one's measurements if taken out of order:

1. **DONE once, and must be done again.** Bring `main` into the task branch and re-anchor every
   line citation in this spec afterwards. It was done at `main = b2c3aa79`, and §"As built at
   HEAD `7a19ca72`" is the re-anchoring. `main` has since moved to `8790d334` (14 commits; the
   branch is 3 ahead), so repeat it with the §0 numbers as they stand on the day you run it, not
   as they are written here.
2. **DONE, unexecuted.** The missing-record hang is closed in source at
   `run-exit-guard.ts:72-86` exactly as specified: count a missing record as a miss; on the
   third, write **no** store record (there is no row to write and no status to name, see
   Verification §3 case 8 for why), print the missing-record message to stderr, set
   `process.exitCode = 1`, `settle('failed')`, `clearKeepAlive()`, and leave `runExitGuard`'s
   `!record` no-op alone. Do not redo it; verify it.
3. **DONE, unexecuted.** Both unit cases exist (`run-exit-guard.test.ts:122` and `:156`), the
   `CEZ_RUN_WEDGE_DEBUG` miss line is on **both** miss paths (`:75-78`, `:101-106`) through the
   local typed view Verification §4 mandates, and `.env.example` documents `CEZ_RUN_FAULT`
   (`:405`) and `CEZ_RUN_WEDGE_DEBUG` (`:407`). Do not write case 7 or either new case a second
   time.
4. **NOT STARTED, and it is the entire remaining critical path.** Run the gates and the runtime
   verification below, in the order §0 to §7 gives. Nothing in steps 1 to 3 has ever been
   compiled, linted or executed: not `tsc`, not `vitest`, not `node --test`, not the packaged
   CLI. Treat every "done" above as a source reading.
5. **Correct the record, in place, once step 4 is green**, including the conflicting
   duplicate-closure spec that arrives with the `main` merge. See "Prior decisions this
   touches"; it is not optional and it is not covered by any other step.

Only after 1 to 5 may this spec's status say anything is verified. A gate run taken before
step 1 measures a tree that will never ship.

**Order: P1 → P2 → P3 → P4, then P0 last.** P0 is numbered 0 because it answers AC1 and owns no
code, not because it runs first. It is scheduled last deliberately: its load-based form is the
one step here that can consume unbounded time without converging (a `git bisect run` whose test
never goes red marks every candidate `good` and terminates on noise, after paying a full
`npm run build` plus N loaded runs *per candidate*), and none of P1-P4 depends on its answer.
Running it first is how the phases that must land get eaten by a race that has not reproduced
on a quiet box in three attempts.

### P1 — `beforeExit` guard (closes AC3's weaker branch)

`src/index.ts` only. ~20 lines, no new dependency, no behaviour change on a healthy run.
Shippable alone: even with nothing else, the reported failure becomes a red exit with an
explanatory error on the record instead of a silent success.

### P2 — run-lifetime keep-alive (closes the class)

`src/index.ts` only: arm before `startRun` (`:1073`), clear in a `finally` around the `final`
await (`:1076-1086`). At this point the measured 7-20 ms hand-off windows stop being able to
end the process.

### P3 — `runLiveness` + wedge detection (stops P2 buying a hang)

`src/workflows/run.ts` (new predicate) + `src/runs/run-exit-guard.ts` (the tick body, extracted
there rather than left inline in `src/index.ts` so Verification §3 can test it). Depends on P2.

### P4 — fault injection, tests, and the e2e (AC2)

`src/workflows/run.ts` (`CEZ_RUN_FAULT`), new unit tests, and the `test:package` re-run. Also
re-time `package-cli.test.ts:14`: it is asserted with an inner `execFile` timeout of `60_000` ms and an outer
test timeout of `120_000` ms (`test/e2e/package-cli.test.ts:14,84`), while the 8-step
spec-to-deploy dry run measured **20.6 s on an idle box**. That is a ~3× margin against a
loaded gate box that also runs `npm pack` + `npm install` inside the same 120 s. Raise the
inner timeout to 120 s and the test timeout to 240 s **and record the measured number in a
comment**, so the next person reading a red knows whether they are looking at this defect or
at a box that was simply slow. Do not switch `package-cli.test.ts:14` to
`--workflow quick-task`: the CLI's default workflow is exactly what this test exists to smoke,
and pinning it would hide the next regression of this kind.

### P0 — bisect (AC1), no code — runs LAST

Two predicates, in this order. The first is the one that actually answers AC1.

**Endpoints, named.** `bad = e9d77657`, `good = 5e388ccf^` (= `67e93cca`, "feat: host CPU/mem %
+ per-task context usage in tasks table"). The earlier draft of this spec said "between the last
known-good base and `e9d77657`" and never named the good end — which is unrunnable, because the
handoff records that base as a **deleted worktree base** and `git bisect` cannot start without a
good commit. `5e388ccf` is confirmed an ancestor of `e9d77657`
(`git merge-base --is-ancestor 5e388ccf e9d77657` → true), so its parent is a valid good
endpoint under the `5e388ccf` prior. If the bisect walks past `5e388ccf` and lands elsewhere,
that is a real finding: report it, do not force the prior.

**Primary — deterministic, always names a commit.** AC1 asks which commit turned this red, and
the reachability change *is* the answer being sought: which commit made the default `cez run`
drive a multi-step workflow, and therefore made a step boundary exist at all. That is a pure
static predicate with no race in it:

```bash
git bisect start e9d77657 5e388ccf^
git bisect run sh -c '
  grep -qE "workflowName \?\? .quick-task." packages/cezar/src/index.ts && exit 0   # good: 1-step default
  grep -qE "workflowName \?\? DEFAULT_WORKFLOW_NAME" packages/cezar/src/index.ts && exit 1  # bad: multi-step default
  exit 125   # neither form present: this commit cannot answer the question
'
git bisect log > /tmp/bisect-primary.log && git bisect reset
```

**No build runs, and none is needed.** The predicate is a static read of the checked-out tree,
so it costs one `grep` per candidate instead of a full `npm run build`, and it cannot be
perturbed by dependency drift across 79+ commits of history. That matters beyond speed: a
per-candidate build with `|| exit 125` would mark a candidate `skip` every time an unrelated
build broke, which is precisely the "terminates on noise" failure this phase is scheduled last
to avoid. Run it from the **repo root**, because the path in the predicate is repo-relative.

Both endpoint forms are verified present, so the predicate is not hypothetical:
`git show 67e93cca:packages/cezar/src/index.ts` contains
`const name = workflowName ?? 'quick-task';` (the good end, a one-step default) and
`git show e9d77657:packages/cezar/src/index.ts` contains
`const name = workflowName ?? DEFAULT_WORKFLOW_NAME;` (the bad end, whose default resolves to
the eight-step `spec-to-deploy`).

**`exit 125` here means "the fallback expression is in neither known form", not "the build
broke".** If any candidate returns 125, the bisect must not be allowed to skip past it: stop and
read that commit's `runCommand` by hand to see what the default resolves to, then answer the
candidate manually with `git bisect good` / `git bisect bad`. A skipped candidate in a range this
narrow is the difference between naming a commit and naming a neighbourhood.

This terminates on a named commit **every time**, and it is the honest answer to AC1: the commit
that made the failure reachable.

**Secondary — load-based confirmation, TIME-BOXED to 30 minutes.** Only after the primary has
named a commit, and only as corroboration. Script `bisect-probe.sh`: at each candidate,
`npm run build`, then `node dist/index.js run mock:done --repo <fresh fixture>` **N=10 times
under artificial load** (the portable busy-loop form in Verification §5; `stress-ng` is not
installed on this box), failing the commit if *any* iteration exits 0 with a non-terminal
record. **Stop at 30 minutes of wall clock regardless of where it is.** The failure has not
reproduced in any of the three attempts so far, so the expected outcome is that this predicate
stays green everywhere; that is information, not a bisect.

**Record whichever happened, plainly**, in this spec's status line: the primary's named commit,
plus either the secondary's agreement or "the load predicate never went red in N runs across M
candidates in 30 minutes — the race did not reproduce on this box, so the commit named above is
named on the reachability predicate, not on an observed failure." A race that is green on a
quiet bisect runner is a finding about the test, not an absence of a cause. Do not pick a
plausible commit.

## Risks

| risk | severity | mitigation |
| --- | --- | --- |
| **P3 false-positives and kills a healthy run.** A run momentarily in none of the seven sets gets failed. | high — worse than the bug | The predicate unions seven sources covering every state the engine models **except one named window**: the chain hand-back's `dropActive` (`run.ts:4107`) to `pendingJobs.set` (`run.ts:2393`) span, crossed 7× per default run and bounded by a single `reviveWorkflow` fs read (see P3, which states this rather than claiming completeness). `RUN_WEDGE_TICKS = 3` (about 3 s) is sized against that window specifically. Verification §4 runs a full healthy 8-step dry run 5× with the detector armed and asserts zero misses: that run is the evidence the window really is sub-tick in practice, and if it is not, P3 does not ship as written. |
| **P2 turns a genuine engine wedge into an indefinite hang** where today it exits (wrongly) fast. | medium | Accepted and documented (P4). A hang is loud (CI timeout, visible terminal, Ctrl-C) where exit 0 is silent; the whole point of AC3 is that a false success is the worst outcome. P3 catches every wedge the manager can see. |
| **P1's `beforeExit` handler re-fires or does async work**, either looping or resurrecting the loop. | medium | One-shot flag; handler body is strictly synchronous (`store.updateRun` and `store.flush` both are — `runs/store.ts`). Unit-tested. |
| **A ref'd 1 s interval delays exit** after the run settles. | low | Cleared in a `finally` on the same tick the `final` promise resolves, before the summary line is printed. Verification §4 measures the **exit latency** after the `run done` summary line (it explicitly withdraws the earlier total-wall-clock bound, which did not measure this risk); §4 is authoritative on the assertion. |
| **The bisect (P0) is inconclusive** because the race is load-sensitive, and burns the session's time getting there. | medium — it is an acceptance criterion | P0's **primary** predicate is deterministic (does a no-`--workflow` run select a multi-step workflow?), so it names a commit every time regardless of whether the race reproduces. The load-based predicate is secondary, time-boxed to 30 minutes, and P0 runs **after** P1-P4 so an inconclusive race cannot consume the phases that must land. If the secondary never goes red, that is recorded as the finding rather than dressed up as confirmation. Flagged to the reviewer now, not at the end. |
| **`CEZ_RUN_FAULT` leaks into a real run.** | low | Same shape as the existing `CEZ_BROKER_FAULT` (`claude-cli-runner.ts:418`): inert unless the exact string is set, and never set outside a test. |
| **The heavy-step gate wedge** (`semaphore.ts:269-281`) is a second, independent instance of this class that P2 covers only because P2 is generic. | low | Called out explicitly in Problem §"What this is not"; a narrower fix (e.g. ref'ing one more timer) must be rejected in review for exactly this reason. |
| **CLOSED IN SOURCE 2026-08-24, still unexecuted: a missing run record hung the CLI forever.** The fix is at `run-exit-guard.ts:72-86` and its unit case at `run-exit-guard.test.ts:122`; the original row is kept below unchanged. The residual risk is now the ordinary one: this path has never been run. | was high, now pending execution | Verification §3 case 8 and §7. Do not close the task on the source reading alone. |
| ~~**Added 2026-08-24: a missing run record hangs the CLI forever.**~~ `runWedgeTick` returns on `!record` without counting a miss or clearing the keep-alive (`run-exit-guard.ts:72-73`), and `runExitGuard` no-ops on the same input (`:55-56`). With P2 armed this is an unbounded hang on a deleted, truncated or unreadable `runs.json` row: the exact trade this spec says it will not make, realised on the one input P3 never enumerated. | high, it is shipped code today | P5 step 2 counts a missing record as a miss and, on the third, settles `failed` with `exitCode = 1` and a stderr line **without writing the store**: there is no row to write (`RunStore.updateRun` no-ops on an absent id, `src/runs/store.ts:853-855`) and no status to name (`failNonTerminalRun` takes one). Verification §3 case 8 states the contract and is the proof. Do not close this task with the source unchanged. |
| **Added 2026-08-24, re-measured the same day after the merge: `main` keeps moving under this branch.** The 79-commit gap was closed by merging at `b2c3aa79`; `main` is now `8790d334`, **14** ahead of a `b2c3aa79` merge-base, with the branch 3 ahead. `main`'s own drift since that merge-base is `src/workflows/run.ts` (+204) and `src/runs/store.ts` (+32) and **zero lines of `src/index.ts`**, so `runCommand`, which is where all of P1 and P2 live, is untouched by `main` for a second time. `git merge-tree --write-tree HEAD main` now exits **1**, but the single conflicted path is a document (`.ai/specs/briefs/2026-08-23-headless-run-exits-mid-workflow.md`, add/add) and `run.ts` auto-merges; resolve the brief by keeping both readings, and do not let a document conflict be read as a code conflict. `main` adds no `new Map<` / `new Set<` / `private readonly` run-state registry, so `runLiveness` stays complete. | low, and it will move again | Re-run §0's five commands on the day you merge rather than trusting these numbers; that is what §0 instructs and it is why this row is worth keeping despite going stale on a schedule. |
| ~~**Added 2026-08-24: the branch is 79 commits behind `main`**, which has rewritten 295 lines of `src/index.ts` and 77 of `src/workflows/run.ts` since the merge-base.~~ | superseded by the row above | Verification §0 integrates before any gate runs. The merge is **clean today**: `git merge-tree --write-tree HEAD main` exits 0 and writes a tree, because `main` touched `index.ts` only at the import block and from `runClusterCommand` down, never inside `runCommand`. So this is a re-anchoring risk, not a conflict-resolution one; re-check with `merge-tree` before merging in case `main` has moved, and only if it has moved into `runCommand` does the keep-both-intents rule apply. **Citations in this spec are anchored in two places on purpose:** the design body (Problem, Solution, Architecture) is against `84fb8237`, and §"As built at HEAD `03371871`" is against `03371871`. §0 re-anchors both in one pass after the merge, and do not re-anchor the design body twice. Known drift `84fb8237` → `03371871`, verified: `runCommand` `index.ts:989` → `:998`, `startRun` `:1073` → `:1114`, the awaited promise `:1076-1080` → `:1122-1126`, `process.exitCode` `:1087` → `:1138`, `main()` `:1914` → `:1965`; the seven registries `run.ts:927/931/932/938/940/941/982` → `:950/954/955/961/963/964/1005`; `isActive` `:2944` → `:3483`; the `step-start` emit `:4525` → `:5091`. |

## Verification

Every step below is executable as written, from `packages/cezar`, with two substitutions the
reader must make: `<fixture>` / `<fresh git fixture>` is a throwaway repo built exactly as
`test/e2e/package-cli.test.ts:65-73` builds one (`git init --initial-branch=main`, one committed
`README.md`, `user.name`/`user.email` supplied inline), and `dist/index.js` assumes
`npm run build` has been run. §7 is the exception and runs from the **repo root**, for the
reason given there.

**Added 2026-08-24: §0 runs first, and nothing below it is meaningful until it has.**

### 0. Integrate `main`, then re-anchor: the prerequisite

**Re-measured 2026-08-24 at HEAD `7a19ca72`, superseding the 79-commit numbers below.** The
79-commit gap was closed by the `b2c3aa79` merge. `main` has since moved to `8790d334`:

```bash
git -C <repo> merge-base HEAD main                                 # b2c3aa79
git -C <repo> rev-list --count HEAD..main                          # 14
git -C <repo> rev-list --count main..HEAD                          # 3
git -C <repo> diff --stat b2c3aa79 main -- \
  packages/cezar/src/index.ts packages/cezar/src/workflows/run.ts \
  packages/cezar/src/runs/store.ts
# run.ts +204, store.ts +32, index.ts ABSENT from the output: main did not touch it.
git -C <repo> merge-tree --write-tree HEAD main; echo $?
# 1, and the ONLY conflicted path is
# .ai/specs/briefs/2026-08-23-headless-run-exits-mid-workflow.md (add/add, a document).
# packages/cezar/src/workflows/run.ts auto-merges. Resolve the brief by keeping both readings.
git -C <repo> diff b2c3aa79 main -- packages/cezar/src/workflows/run.ts \
  | grep '^+' | grep -E 'new Map<|new Set<|private readonly'
# empty: main adds no eighth run-state registry, so runLiveness is still complete.
```

Run all five again on the day you merge. These numbers are true on 2026-08-24 and `main` moves
daily; the point of the section is the procedure, not the integers.

Every gate below, run before integration, measures a tree that will never ship. **The numbers
in the rest of this section are the pre-`b2c3aa79` reading** and are kept because the reasoning
(why the merge was expected to be clean, and what would make it not be) is what a reader needs;
the commands are still the right commands, with `9c65f9e9`/`d01fc102` replaced by
`b2c3aa79`/`8790d334`.

**But the merge itself is clean, measured, not assumed.** An earlier draft of this section said
a `runCommand` conflict was "likely rather than hypothetical". That is false and is checkable in
one command:

```bash
git merge-tree --write-tree HEAD main   # exit 0, prints a tree oid, no conflict markers
```

`main`'s hunks in `src/index.ts` sit at the import block (`:64`) and at `runClusterCommand` and
below (`:1382`, `:1443`, `:1463`, `:1521`, `:1539`, `:1590`, `:1661`, `:1683`, `:1913`,
merge-base numbering). `runCommand` (~`:996-1095`) is untouched by `main`. So §0 is about
re-anchoring and re-gating on the shipping tree, not about resolving conflicts. **Re-run
`merge-tree` immediately before merging** in case `main` has moved since; only if it has moved
into `runCommand` does the resolve-by-keeping-both-intents rule apply, and a wholesale take of
either side would then silently drop P1/P2 or drop 79 commits of unrelated work.

**The finding that actually matters for P3, and it lands in this spec's favour.** `main`'s five
hunks in `src/workflows/run.ts` are: two `brokerIsolation` cache/warn fields (`:983`), a new
read-only `hasCapacity()` (`:1600`), the `brokerIsolation()` re-probe and degraded-mode warning
(`:2305`), and two `image`-event `name`/`url` projections (`:4207`, `:5752`). **None of them
adds a run-state registry**, so `runLiveness`'s seven sources are still complete after the
merge, which was the single largest unknown hanging over P3's integration. Confirm it after
merging rather than trusting this paragraph:

```bash
grep -nE 'private readonly (active|queue|starting|waiting|monitoring|pendingJobs|autoResumeTimers)[ :=]' \
  packages/cezar/src/workflows/run.ts
# expect exactly 7 hits. Re-measured at HEAD 7a19ca72: :951 active, :955 queue, :956 starting,
# :962 waiting, :964 monitoring, :965 pendingJobs, :1015 autoResumeTimers. (The pre-merge
# reading was :950/954/955/961/963/964/1005 in merge-base numbering.) An eighth run-state
# registry means runLiveness is no longer complete.
```

The trailing `[ :=]` is load-bearing: the unanchored form of this pattern returns **9** hits and
the anchored form **7**, at `03371871` and again at `7a19ca72`, because `queue` prefix-matches
`queuedImageSeq` (`run.ts:1006` at `7a19ca72`, `:996` before the merge) and `queueWatchdog`
(`:1054`, was `:1044`), neither of which is a run-state registry. Verified against `main`
`8790d334` too: the same two decoys, at `:1018` and `:1066`, and no new registry.

Then merge or rebase `main` in, re-run
`grep -n "keepAlive = setInterval\|process.on('beforeExit'\|manager.startRun(workflow"
packages/cezar/src/index.ts` to re-anchor, and correct this spec's line citations in place: the
design body's (against `84fb8237`) and §"As built"'s (against `03371871`) in the same pass, per
the Risks row that lists the known drift.

Then, and only then, §1 onward.

### 1. Prove the mechanism, not the symptom — the resource probe

Re-run the instrumented run from Problem §"The measurement" **before and after P2**:

```bash
cat > /tmp/probe.mjs <<'EOF'
const t0 = Date.now(); let last = null;
const s = setInterval(() => {
  const now = process.getActiveResourcesInfo().slice().sort().join(',');
  if (now !== last) { process._rawDebug(`[probe +${Date.now()-t0}ms] refd=[${now}]`); last = now; }
}, 5);
s.unref();
process.on('beforeExit', c => process._rawDebug(`BEFORE-EXIT code=${c} refd=[${process.getActiveResourcesInfo()}]`));
EOF
CEZ_DRY_RUN=1 CEZ_HOME=$(mktemp -d) node --import file:///tmp/probe.mjs \
  dist/index.js run 'mock:done' --repo <fresh git fixture> 2>/tmp/probe.log
```

- **Before P2 (baseline, already measured at `84fb8237`):** 97.1% of wall clock on a single
  ref'd handle; 56 single-handle windows; narrowest 7 ms.
- **After P2, primary assertion (the one that actually discriminates):** every sampled
  *transition* ref-set contains the keep-alive `Timeout`, and the count of single-entry ref-sets
  drops from **56 to 0**. That is the direct proof the class is closed, and it does not depend
  on reproducing the race.
- **Secondary, and note the filter:**
  `grep 'probe +' /tmp/probe.log | grep -c 'refd=\[\]'` is 0. The `grep 'probe +'` prefilter is
  not cosmetic. A bare `grep -c 'refd=\[\]' /tmp/probe.log` can never be 0 on fixed *or* broken
  code, because the probe's own terminal line is `BEFORE-EXIT code=0 refd=[]` (quoted as the
  baseline's last sample in Problem §"The measurement") and it prints on every normal exit,
  including a healthy post-P2 one. Nor can the 5 ms `unref()`'d sampler ever observe a
  zero-handle instant on the broken path: the process is gone before its next tick fires. So
  this grep is a lint over the transition trace only, and on its own it proves nothing either
  way.

### 1a. Confirm the theory before building on it — the `CEZ_RUN_BROKER` A/B

**Already run, on 2026-08-23, and it confirmed the prediction; do not re-run it.** Brokered
spent **97.4%** of 19,991 sampled ms on exactly one ref'd handle (54 windows, narrowest 10 ms);
`CEZ_RUN_BROKER=0` spent **0.6%** of 16,238 sampled ms there (6 windows, narrowest 12 ms). Both
completed all eight steps. That is the falsifiable gap the table below predicts, so §1a is
**closed** and P1/P2 build on a confirmed mechanism. The procedure stays below as the record of
what was measured and how to repeat it if the diagnosis is ever reopened.

Root `AGENTS.md:371-372` records the decisive control from the original
investigation: `CEZ_RUN_BROKER=0` makes the identical run finish while the default brokered path
stalls. Probe the same 8-step dry run both ways, with the §1 probe attached:

```bash
for mode in 0 ''; do
  CEZ_DRY_RUN=1 CEZ_HOME=$(mktemp -d) ${mode:+CEZ_RUN_BROKER=$mode} \
    node --import file:///tmp/probe.mjs dist/index.js run 'mock:done' \
    --repo <fresh git fixture> 2>/tmp/probe-broker-${mode:-default}.log
done
```

**Compare within-step occupancy, not the step boundaries.** At a boundary the two modes execute
the *same* code, `dropActive` (`run.ts:4107`) to `reenterChain` (`:4161`) to `pump()` to
`execute()`, held open only by fs reads and `getRepoInfo`'s git child, regardless of broker
mode. So a boundary comparison cannot discriminate, and stating the criterion there would read
as a failure on correct code. What genuinely differs is what each mode holds **during** a step:
brokered holds one ref'd poll `Timeout` (`brokered-session.ts:158-162`) for the step's whole
duration, while in-process holds the runner child's `ProcessWrap` plus three `PipeWrap`s
(`claude-cli-runner.ts:492,498`).

The prediction, therefore, is a statistic over the whole run:

| metric | default (brokered), measured | `CEZ_RUN_BROKER=0`, predicted |
| --- | --- | --- |
| fraction of wall clock on exactly **one** ref'd handle | **97.1%** | well under 50% |
| count of single-handle windows | 56 | few, and only at boundaries |
| narrowest single-handle window | 7 ms | boundary-only, same order |

**Falsification condition:** the two traces are statistically indistinguishable on the first two
rows. It is *not* "the in-process trace shows any single-handle window at all", because it will
show boundary ones, and those are expected.

If the prediction fails, the root-cause narrative in Problem §"Root mechanism" is wrong:
re-diagnose, and record the corrected mechanism in this spec before building further on it. A
failed prediction does **not** block P1 or P2. A `beforeExit` guard and a run-lifetime keep-alive
satisfy AC3 whichever window is draining the loop. What it blocks is shipping them under a story
the measurement contradicts, which is how the *next* session inherits a wrong prior (see
§"Why `3e6d1b7e` did not close this"). Quote both handle traces and both statistics in the
status line.

### 2. Force the failure deterministically — `CEZ_RUN_FAULT` (P4)

```bash
CEZ_DRY_RUN=1 CEZ_RUN_FAULT=stall-step CEZ_HOME=$(mktemp -d) \
  node dist/index.js run 'mock:done' --repo <fixture>; echo "exit=$?"
cat <fixture>/.ai/cezar/runs.json
```

- **On unfixed code:** `exit=0`, record `status: "running"`, no error — i.e. the report,
  reproduced on demand, on a quiet box.
- **After P1:** `exit=1`, record `status: "failed"` with the `cezar exited before the run
  finished` error, message on stderr. **Not observable on the integrated tree**: P2 is already
  landed (§"As built"), and it turns this case into the bounded hang described next. Kept as the
  design's intermediate state; do not treat its absence as a failure.
- **After P2, the only bullet here that is executable today:** the process no longer exits; the
  run parks, and P3's wedge tick fails it after `RUN_WEDGE_TICKS`. Bound it with `timeout 30`
  and assert `exit != 0` (`timeout` yields 124 if P3 has not fired, 1 if it has) plus a record
  of `status: "failed"` carrying the liveness reason, see P4's stated limitation for why this
  case can be a hang rather than a clean 1.

### 3. Unit tests

`src/workflows/run.test.ts` (or a new `run-liveness.test.ts`):

1. `runLiveness` returns `live: true` with the right `reason` for each of the seven sources
   (queued, starting, active, waiting, monitoring, auto-resume, pending-job) — seven cases,
   driven by putting a run into each state directly.
2. `runLiveness` returns `live: false` for an unknown run id and for a run whose record is
   `running` but which is in none of the sets.
3. The predicate mutates nothing: snapshot `active`/`queue`/`waiting` sizes before and after.

**Do not import `src/index.ts` from a test, and do not add exports to it.** It has **zero**
`export` statements at HEAD (`grep -c '^export ' src/index.ts` → 0) and calls `main()` at module
scope (`src/index.ts:1914`, whose `.catch` runs `process.exit(1)`), so importing it runs the
whole CLI against the test runner's own `argv` and can hard-exit the worker. Instead, P1 to P3
extract the two testable bodies, `runExitGuard` (the `beforeExit` handler) and `runWedgeTick`
(the keep-alive tick), into a **new module**, `packages/cezar/src/runs/run-exit-guard.ts`, which
`index.ts` imports and wires into `runCommand`. Cases 4 to 7 then live in
`src/runs/run-exit-guard.test.ts`:

4. Terminal record → handler is a no-op, `process.exitCode` untouched.
5. Non-terminal record → record failed with the message, `exitCode = 1`, handler is one-shot
   (second invocation does nothing).
6. Wedge detector: two consecutive misses do nothing; the third fails the run.
7. **Terminal-branch totality** (the branch P2 makes dangerous): the record is already terminal
   and the `store.on('run')` listener never fired → the tick settles `final` with
   `record.status`, clears the keep-alive, and the process **finishes** with the correct exit
   code (`done` → 0; repeat with `failed` → 1). Assert it does **not** hang and does **not**
   rewrite the record. Without this branch the tick returns, the keep-alive is never cleared,
   `beforeExit` is unreachable, and the process runs forever — which is worse than today's
   wrong-but-fast exit. Say that in the test's comment.

**Which runner picks these up, because it is not the obvious one.** Both new files live under
`src/`, and `packages/cezar/vitest.config.ts` has `include: ['src/**/*.test.ts']` while
deliberately excluding `test/`. So `run-liveness.test.ts` and `run-exit-guard.test.ts` run under
**`npm test`** (vitest), *not* under `npm run test:unit`, which is
`node --import tsx --test test/unit/*.test.ts` (`packages/cezar/package.json:39`). §7's gate
line therefore does not cover these cases on its own: `npm test` must be run alongside it, as §7
already says. Do not place them in `test/unit/` to "make the gate cover them", because that
directory is node:test with a different assertion API.

**Landed 2026-08-24, and what is still missing.** Cases 1 to 7 exist, in the two files this
section names, under vitest as predicted (`src/workflows/run-liveness.test.ts:35-77`,
`src/runs/run-exit-guard.test.ts:52-120`); the module extraction happened as designed, and no
test imports `src/index.ts`. Case 7 is `run-exit-guard.test.ts:101-120`, so do **not** write it
again; its exit-code half is covered at runtime by §2 and §5 rather than as a unit assertion,
for the reason §"As built" gives. **Two** cases must still be written, and neither is polish:

8. **Missing record must not hang.** `runWedgeTick` with a store whose `getRun` returns
   `undefined` currently returns at `run-exit-guard.ts:72-73` without counting a miss or
   clearing the keep-alive, so the process would run forever.

   **The fix cannot be "fail the run", and the exact contract matters**: an earlier draft said
   "count it as a miss so the third one fails the run", which is not implementable as written.
   `failNonTerminalRun` (`run-exit-guard.ts:30-45`) takes a `status: RunStatus` read off the
   record, and `RunStore.updateRun` returns `undefined` and writes nothing when the id is absent
   (`src/runs/store.ts:853-855`). With no record there is no status to name and no row to fail.
   The contract is therefore: on a `!record` tick, increment `state.misses`; below
   `RUN_WEDGE_TICKS`, return; on the third, write **no** store record, print to stderr
   `cezar exited before the run finished: its run record is missing from the store (<runId>)`,
   set `process.exitCode = 1`, call `settle('failed')`, and call `clearKeepAlive()`.

   `runExitGuard`'s own `!record` no-op (`:56`) deliberately **stays** a no-op. AC3 speaks only
   to a record that is still non-terminal, and there is nothing to write; the hang, not the exit
   code, was the defect.

   The test asserts exactly that: three consecutive missing-record ticks call `settle('failed')`
   once, `clearKeepAlive()` once, set `process.exitCode = 1`, and call `updateRun` **zero**
   times. Do not assert a store write here: it would fail against a real store. Fix the source
   first (P5 step 2); this case is the proof of it.
9. **Misses reset.** Two misses, then a `live: true` tick, then two more misses: the record is
   untouched, because `state.misses` returned to 0 (`run-exit-guard.ts:82-85`). Without this,
   a detector that counted cumulative rather than consecutive misses would pass cases 6 and 8
   and still kill healthy long runs.

Run them with `npm test` (vitest) from `packages/cezar`, then again from the repo root as §7
requires, and quote vitest's own pass/fail line.

### 4. Healthy-path regression — the detector must not fire

Full 8-step dry run with P2+P3 armed. **There is no wedge counter to read yet, so expose one
first.** `state.misses` is a plain field on the object literal created at `src/index.ts:1096`;
`runWedgeTick` logs nothing at all until it actually fails the run
(`src/runs/run-exit-guard.ts:87-92`); and there is no `CEZ_DEBUG` / `CEZ_LOG` convention
anywhere in `packages/cezar/src` to hook into (grepped at HEAD `03371871`: zero hits). Left as
it was, the "zero misses" assertion below is not executable, and the likely outcome is that it
gets silently downgraded to "the run said `done`", which is exactly the weaker evidence this
section exists to reject.

**The mechanism, added as P5 work.** On the increment path in `runWedgeTick`
(`src/runs/run-exit-guard.ts:87`, immediately after `options.state.misses += 1`):

```ts
// `_rawDebug` is a Node internal: synchronous, and it refs nothing, so it cannot hold the
// event loop open and perturb the measurement it serves. @types/node (20.19.43) does not
// declare it and this package is `strict`, so name it through a local typed view rather
// than reaching for `console.error`, which writes through a `process.stderr` that refs a
// handle when stderr is a pipe.
const rawDebug = (process as unknown as { _rawDebug?: (msg: string) => void })._rawDebug;
if (process.env.CEZ_RUN_WEDGE_DEBUG === '1') {
  rawDebug?.(`[wedge] miss ${options.state.misses}: ${liveness.reason}`);
}
```

**The cast is load-bearing, not stylistic, and it applies to both call sites.** Written bare as
`process._rawDebug(...)`, the line does not compile: `_rawDebug` is undocumented and absent from
the resolved `@types/node` (20.19.43 at `node_modules/@types/node`; `grep -rn '_rawDebug'` over
it returns nothing), while `packages/cezar/tsconfig.json` sets `strict: true` and
`types: ["node"]`. Reproduced with the repo's own `tsc` on an equivalent config:
`error TS2339: Property '_rawDebug' does not exist on type 'Process'`, exit 1. So the bare form
turns §7's own `npm run typecheck` gate red on this spec's mandated code, and the cheapest
workaround is deleting the line, which is what makes the zero-miss assertion below unexecutable.
Use the same typed escape on the **second** call site this section mandates below (the
missing-record increment path added by P5 step 2, with the literal reason `record missing`), so
both go in cast rather than one of them reddening the gate anyway. Do **not** substitute
`console.error` or `process.stderr.write`: that contradicts the refs-nothing rationale above.
The probe script in §1 uses `process._rawDebug` bare, and correctly so, because it is a
standalone `.mjs` loaded with `--import` and never reaches `tsc`.

The count and the reason are separated by a colon rather than an em dash, per the workspace
no-em-dash rule; the assertions below key only on the `[wedge] miss` prefix, so the separator is
immaterial to them.

**After P5 step 2 there are two increment paths, and this line instruments only one.** The
missing-record path added by that step has no `liveness` object to read a reason from, so give it
its own literal reason string (`record missing`) behind the same `CEZ_RUN_WEDGE_DEBUG` gate,
emitting the same `[wedge] miss <n>: <reason>` shape, rather than leaving it silent. In practice a healthy run can never
take that path (`store.getRun` reads an in-memory map that `startRun` populates synchronously),
so the zero-miss greps below would pass either way; instrument it anyway so nobody reads a zero
count as covering both paths when it only ever exercised one.

**This line ships; it is not reverted before the commit.** It is inert unless
`CEZ_RUN_WEDGE_DEBUG=1` is set, which is the same shape as the existing `CEZ_RUN_FAULT`
injector, and a debug hook removed at commit time means the next person who doubts the detector
has to re-derive and re-add it before they can measure anything. Because it ships, add it to the
environment contract next to `CEZ_RUN_FAULT` (`.env.example:404-405`), in the same
`# ---- testing / internal ----` block and commented out by default.

Then five idle repetitions:

```bash
for i in 1 2 3 4 5; do
  CEZ_RUN_WEDGE_DEBUG=1 CEZ_DRY_RUN=1 CEZ_HOME=$(mktemp -d) \
    node dist/index.js run 'mock:done' --repo <fixture> 2>/tmp/wedge-idle-$i.log
  grep -c '\[wedge\] miss' /tmp/wedge-idle-$i.log || true   # expect 0 on every i
done
```

Assert on all five: `run done`, `runs.json` → `done`, `grep -c '\[wedge\] miss'` is **`0`**, and
the process **exits within 1 s of printing its `run done` summary line**. Measure that directly:
stamp `ts=$(date +%s%3N)` immediately after the `node dist/index.js run …` invocation returns and
compare it to the timestamp of the summary line, or at minimum confirm the command returns
promptly rather than lingering for a multiple of `RUN_KEEPALIVE_MS`. That is the assertion that
actually measures the Risks row "a ref'd 1 s interval delays exit"; the risk is about **exit
latency**, not total runtime. A detector that fires once in five healthy runs is not shippable.
(`grep -c` exits 1 when the count is 0, which is the passing case here, hence the `|| true`; do
not let a `set -e` harness read the pass as a failure.)

**Total wall clock is recorded for information only, with no bound.** The earlier draft asserted
"+1 s of the 20.6 s baseline", and that assertion is withdrawn: 20.6 s was measured at
`84fb8237`, pre-P2 and pre-merge, on the tree §0 itself says nobody will ship. After integrating
79 commits it is not a valid comparand, so holding it would produce a red for reasons unrelated
to this change and force the implementer to adjudicate it mid-verification. Write the five
numbers down as the new baseline for whoever measures next; do not gate on them.

**Then repeat the same five runs under load, and treat those as the real evidence.** Five idle
repetitions are the weaker half: this spec's own thesis is that the drain window widens under
load, and `RUN_WEDGE_TICKS = 3` buys only about 3 s of margin against a `reviveWorkflow` fs read
that is fast precisely because the box is quiet. Use §5's portable load harness:

```bash
for i in $(seq "$(nproc)"); do (while :; do :; done) & done
trap 'kill $(jobs -p)' EXIT
for i in 1 2 3 4 5; do
  CEZ_RUN_WEDGE_DEBUG=1 CEZ_DRY_RUN=1 CEZ_HOME=$(mktemp -d) \
    node dist/index.js run 'mock:done' --repo <fixture> 2>/tmp/wedge-load-$i.log
  grep -c '\[wedge\] miss' /tmp/wedge-load-$i.log || true   # expect 0 on every i
done
```

Assert the same two things on all five: `grep -c '\[wedge\] miss' /tmp/wedge-load-$i.log` is
**`0`**, and `runs.json` → `done`. Do
**not** carry the +1 s wall-clock bound over to the loaded repetitions: eight busy loops on
eight cores will blow it for reasons unrelated to this change, and a failure there is noise, not
signal.

**Stop-ship:** *any* wedge-caused failure of a healthy run, idle or loaded, means P3 does not
ship as written. **This, and not the zero-miss count, is the decision rule.** The zero-miss
assertion is the diagnostic: a single transient miss that never reaches `RUN_WEDGE_TICKS` fails
that assertion without failing the run, so record its count and its reason and read it as
evidence that the tick margin is thinner than assumed, rather than as an automatic stop-ship. A
wedge-caused **failure** is what blocks the ship. Two ways out, in order of preference: raise `RUN_WEDGE_TICKS` and re-measure
the loaded five, or make the tick treat the `dropActive` → `pendingJobs.set` window as live
**explicitly** (a flag set at `dropActive` and cleared at `pendingJobs.set`), which removes the
guess instead of widening it. Shipping a detector known to fire on healthy runs is not an
option: it trades a silent wrong success for a loud wrong failure, which is better and still
wrong.

### 5. AC2 — the actual gate

```bash
npm run test:package     # from packages/cezar
```

**The gate is 18/18 at `84fb8237`, not 15/15.** `test:package` is
`node --import tsx --test test/e2e/*.test.ts` (`packages/cezar/package.json:40`), and HEAD has
**18** top-level cases: `alias-bin-exports` 1, `cold-broker-retry` 3, `inline-contract` 3,
`package-cli` 1, `release-snapshot` 5, `release` 5. AC2's "15/15" and root `AGENTS.md`'s
"case 5" were the count and the ordinal at `3e6d1b7e`; `3336ac15` (2026-08-22, "test: cover the
transient broker retry path with fault-injected e2e cases") then added
`cold-broker-retry.test.ts` with 3 cases, and because it sorts second alphabetically the tarball
case is now the **8th**, not the 5th. **Name it, do not number it:** the case that matters is
`packages/cezar/test/e2e/package-cli.test.ts:14`, by name. And **quote the runner's own count
line** (`# pass`/`# fail` from `node --test`) in the status line rather than a remembered number
— this spec exists partly because a stale green claim about this very test was believed once
already.

Run it **twice**: once idle, once under load, since a quiet green is exactly the evidence that
was already recorded once here and did not hold. `stress-ng` is **not installed on this box**
(`command -v stress-ng` → not found; `nproc` → 8), so use the portable form:

```bash
for i in $(seq "$(nproc)"); do (while :; do :; done) & done
trap 'kill $(jobs -p)' EXIT
npm run test:package
```

Use `stress-ng --cpu $(nproc) --timeout 300s` instead if it happens to be present on the box
you run this on. Quote both results, with their counts, in the status line.

### 6. AC1 — the bisect

**RESULT 2026-08-24, primary predicate executed: the first bad commit is `a7510b2f`.** The
build-free static predicate was run over the specified `e9d77657` … `67e93cca` ancestry and
named `a7510b2f` (2026-08-20 07:16 UTC, "cezar autosave (run finalize)"), which changes
`runCommand`'s fallback from `workflowName ?? 'quick-task'` to
`workflowName ?? DEFAULT_WORKFLOW_NAME`. That is AC1 answered.

**And the `5e388ccf` prior below is not wrong so much as half the picture, which this revision
measured rather than assumed.** `a7510b2f` and `5e388ccf` are **siblings**, not successive:

```bash
git log -1 --format='%h %P %ci' a7510b2f   # parent 67e93cca, 2026-08-20 07:16:44 +0000
git log -1 --format='%h %P %ci' 5e388ccf   # parent 67e93cca, 2026-08-20 10:00:24 +0000
git merge-base --is-ancestor a7510b2f 5e388ccf; echo $?   # 1
git merge-base --is-ancestor 5e388ccf a7510b2f; echo $?   # 1
git diff a7510b2f 5e388ccf -- packages/cezar/src/index.ts | wc -l   # 0
git diff --stat 67e93cca a7510b2f -- packages/cezar/src/index.ts    # 5 lines, 3 ins 2 del
git diff --stat 67e93cca 5e388ccf -- packages/cezar/src/index.ts    # identical
```

Two autosaves of the same five-line change, committed on parallel history within three hours and
later joined by a merge; both are ancestors of HEAD. So the flip sits exactly on the `67e93cca`
boundary, `a7510b2f` is simply the earlier of the two and therefore what a bisect over that
ancestry reaches first, and the handoff's `097d1b15` hypothesis is refuted (it does not touch
`index.ts`; it broadened an already-default to other unattended paths).

**This also discharges the honesty note below rather than repeating it.** That note warns that
the `good` endpoint was *chosen from the prior* and never measured, so the bisect could only
confirm what it was pointed at. It has now been measured directly:
`git show 67e93cca:packages/cezar/src/index.ts | grep -n 'workflowName ??'` gives
`700:  const name = workflowName ?? 'quick-task';`, and the same grep at `a7510b2f`, at
`5e388ccf` and at `e9d77657` gives `DEFAULT_WORKFLOW_NAME`, while `a7510b2f^` and `5e388ccf^`
(both `67e93cca`) give `'quick-task'`. The endpoint is correct on evidence, not on assumption.
What is still **not** done is the load-based secondary, which is the only thing that would show
the red *reproducing* at `a7510b2f` rather than the default *flipping* there. Report it that way.

Original instruction, unchanged, for the secondary and the reporting discipline:

Per P0, and **after** P1-P4 have landed. Run the deterministic primary predicate
(`git bisect start e9d77657 5e388ccf^`, asserting that a no-`--workflow` `cez run` selects a
workflow with more than one step) — it names a commit every time. Then the load-based secondary,
time-boxed to 30 minutes. Record the named commit **and** which predicate named it, plus the
secondary's outcome, in this spec's status line and in the task's handoff. If the secondary
never went red, say exactly that with its numbers rather than implying the commit was confirmed
by an observed failure.

**Second honesty note, on the primary predicate itself.** `git bisect` trusts its endpoints
rather than testing them, and the `good` endpoint here (`5e388ccf^` = `67e93cca`) is *chosen
from the prior*, not measured. So the primary bisect can only ever land on `5e388ccf` or later:
it confirms and dates the workflow-default flip, it does not independently discover it. That is
still worth running, because it rules out a *later* commit having moved the default again, but
report it as "confirmed and dated `5e388ccf`", never as "bisect independently found".

### 7. Gates

**Pre-flight, before any gate, because a worktree's gates lie when it is missing.** Root
`AGENTS.md` documents the trap: Node resolves upward out of a worktree into the parent
checkout's `node_modules`, so a gate in an uninstalled worktree "starts, prints a normal vitest
banner and returns a real-looking result" while testing the wrong tree.

```bash
ls node_modules/.bin | wc -l    # from the worktree root
```

**Measured 2026-08-24 in this worktree: root `node_modules` has 317 entries and 28 in `.bin`,
with `vitest`, `tsx` and `tsc` all present, while `packages/cezar/node_modules` is empty.** That
is the normal hoisted-workspace shape and it is *not* the trap: the trap is an **empty or absent
root `node_modules`**, which is what the sibling spec hit. If the count is 0 or the directory is
absent, run `npm install` from the worktree root first and say so in the status line. Do not
read the empty `packages/cezar/node_modules` as a failed install.

**Run the gates from the repo ROOT, not from `packages/cezar`.** The root `typecheck` fans out to
four workspaces (`typecheck:contract`, `:client`, `:server`, `:web` — root `package.json`), and
`packages/cezar`'s own `typecheck` is only the `:server` quarter of that. Running the gate from
the package therefore skips the contract, api-client and web checks entirely, which is exactly
the green-looking gate this spec is about. Root `.ai/agentic.config.json:8-15` names the five
validation commands, all root-relative.

```bash
npm run typecheck && npm run test:unit && npm run build     # from the repo root
```

**There is no `lint` script** — not in `packages/cezar/package.json` and not in the root
`package.json` (verified at HEAD). A chained `npm run lint` therefore aborts the whole command
with `Missing script: lint` before `test:unit` and `build` ever run, which is a green-looking
gate that ran nothing. Root `AGENTS.md:284` names this repo's five validation commands:
`typecheck`, `test`, `test:unit`, `build`, `test:package`.

Plus `npm test` (vitest), noting the pre-existing unrelated `knowledge/catalog.test.ts` C18
timing failure documented in `.ai/specs/2026-08-22-run-broker-cli-keepalive.md`'s status line —
if it is still the only red there, say so rather than claiming a clean sweep.

## Prior decisions this touches

- **`.ai/specs/2026-08-22-run-broker-cli-keepalive.md`** — its status line records
  `npm run test:package` **15/15** and "the originally-failing test 5 now passes". That was
  true, measured, for the mechanism it fixed. It does not hold as a durable guarantee for the
  one-shot CLI path, because it fixed one hand-off in a chain of 56. **When P2 lands, add a
  dated `CORRECTED 2026-08-2x` lead-in to that spec's status line** pointing here, leaving the
  original text below it — per the workspace rule that a correction marks what it invalidates
  in place. Do not delete or rewrite its claim.
  **Done 2026-08-23, verified in place 2026-08-24:** the lead-in is at
  `.ai/specs/2026-08-22-run-broker-cli-keepalive.md:3-7`, above the original status line, which
  is unchanged. Nothing further is owed here unless P5 changes the conclusion.
- **Root `AGENTS.md` → `### Five environment traps that make the gates LIE` (`AGENTS.md:250`),
  item 5 (`:367-383`).** There is no section called "sharp edges" in that file; this is the real
  anchor. Item 5 already carries a 2026-08-22 correction (`:379-383`) saying that if this red
  recurs, "that is new information, not a re-confirmation of this entry." **This spec is that
  new information**, so item 5's own `**Do not re-diagnose this one**` directive (`:375`) is
  *satisfied* by this spec rather than violated by it: the red recurred, the correction opened
  the door, and the entry's canonical todo `c895a348` is already closed. When P2 lands, item 5
  should point here, and its "fails 1/15" heading needs the same treatment as the 15/15 claim
  above — the count is now 18 and the ordinal is 8 (Verification §5). Item 5 is also where the
  `CEZ_RUN_BROKER=0` control lives (`:371-372`), which Problem §"What this is not" now uses as
  positive evidence and Verification §1a turns into a test.
  **Done 2026-08-23, verified in place 2026-08-24:** the correction is at `AGENTS.md:367-370`
  and points here, records the 18-case count and the eighth ordinal, and leaves the original
  "fails 1/15 … Case 5" text intact below it (`:371` onward), which is what the in-place rule
  asks for. One thing it does **not** yet say, and should once P5 finishes: whether the case is
  green. Until then the entry correctly reads as an open trap.
- **`a7510b2f` / `5e388ccf`** (CLI default → `spec-to-deploy`; the same five-line change on two
  parallel autosaves, see Verification §6) is not reverted and should not be: the default is a
  product decision (`.ai/specs/2026-08-19-spec-to-deploy-default-workflow.md`). It only made an
  existing latent defect eight times more likely to be hit.

- **ADDED 2026-08-24, and it is the one record obligation nothing else covers:
  `.ai/specs/2026-08-22-headless-run-exit0-bisect-and-verify.md`, which arrives with the `main`
  merge (commit `a2a74f43`, "docs: record headless run duplicate status", 452 lines).** It is a
  sibling task's (`9bf5030d`) documentation-only closure of *this same defect*, and it concludes
  that the runtime bug "is implemented, tested, and shipped by the sibling task's commit
  `3e6d1b7e`" with "no application code change belongs to this task". **That conclusion does not
  hold for the multi-step hand-off race**, for exactly the reason this spec's "Why `3e6d1b7e`
  did not close this" section gives: a step-scoped broker timer is not run-lifetime liveness.
  Read alongside this spec it produces a direct contradiction (one document says the class is
  closed with no code owed, the other says P1 to P5 are code that had to be written), and a
  reader who greps the spec directory hits the alphabetically earlier, more confident one first.

  So, **once P5 step 4 is green**, add a dated `SUPERSEDED 2026-08-2x by
  .ai/specs/2026-08-23-headless-run-drains-event-loop.md` lead-in to *its* status line, leaving
  its original text below unchanged, saying that its `3e6d1b7e`-closes-it conclusion holds only
  for broker startup and per-session polling and that the run-lifetime invariant is here. Do not
  delete it and do not merely append a note to this spec: appending leaves the stale document
  reading as current, which is the failure mode the workspace rule exists for.

  Two things in it are **correct and must survive the correction**: its independent finding that
  `097d1b15` is not the trigger (this spec's §6 reaches the same answer by a different route),
  and its `node_modules` pre-flight warning, which named the resolve-upward trap that makes a
  worktree's gates lie. Its own AC1 remains unanswered on its terms; this spec's §6 answers it
  with `a7510b2f`, so the correction should point there rather than leaving two open bisects on
  the record.

## Sources read

Read directly at HEAD `84fb8237` for this spec (not taken from the brief):

- `packages/cezar/test/e2e/package-cli.test.ts:14,80-100` — the tarball case (the handoff's
  "case 5"; 8th of 18 at HEAD), its assertions and timeouts
- `packages/cezar/package.json:28,37,39-41` — the actual script names behind the gates (there is
  no `lint`); root `package.json` scripts block, same check
- `packages/cezar/test/e2e/` (all six files) — counted the top-level `test(` cases: 18
- Root `AGENTS.md:250` (`### Five environment traps that make the gates LIE`), `:284` (the five
  validation commands), `:367-383` (trap 5, the `CEZ_RUN_BROKER=0` control at `:371-372`, "do
  not re-diagnose" at `:375`, the 2026-08-22 correction at `:379-383`)
- `packages/cezar/src/core/broker-launch.ts:26,35` — `CEZ_RUN_BROKER` / `brokerPreference()`
- `git log`/`git merge-base` at HEAD — `3336ac15`, `5e388ccf`, `5e388ccf^` = `67e93cca`,
  `e9d77657`, and `5e388ccf` confirmed an ancestor of `e9d77657`
- `packages/cezar/src/index.ts:989-1087` — `runCommand`: workflow selection, `startRun`, the
  `store.on('run')` await, `process.exitCode`; `:920,981,1916` — the only `process.exit()` sites
- `packages/cezar/src/workflows/run.ts:1339-1350` (`startRun`), `:1417` (`void this.pump()`),
  `:1666-1679` + `:2190-2199` (floating `execute()` catches), `:1073-1081` (queue watchdog,
  unref'd), `:2013-2036` (`brokerFor`), `:2510-2512`, `:4525` (`step-start`), `:4955-4971`,
  `:5395-5445` (per-step broker decision), `:6155-6172`, `:927-982` (the state sets)
- `packages/cezar/src/core/brokered-session.ts:130-240` (constructor, `tick`, `finish`),
  `:351-356` (`detach`)
- `packages/cezar/src/core/claude-cli-runner.ts:401-521` (`spawnBroker`, `detached`/`unref` at
  `:492,498`, `CEZ_BROKER_FAULT` at `:418`)
- `packages/cezar/src/workspace/semaphore.ts:1-80,197,230-290,320-430` (`runHeavyStep`,
  `acquireHeavyStep`, `heavyWaiters`, `release`)
- `packages/cezar/src/workspace/config.ts:100-160` (`maxHeavySteps` docblock and schema),
  `:372-400` (`loadWorkspaceConfig` — "never cached")
- `packages/cezar/src/workflows/types.ts:283` (`QUICK_TASK_WORKFLOW`), `:910` (`heavy: true`),
  `:1152` (`DEFAULT_WORKFLOW_NAME`)
- `packages/cezar/src/runs/store.ts:1417-1428` (debounced save timer, unref'd)
- `/var/lib/cezar/loki-labs/cezar/.ai/specs/briefs/2026-08-23-headless-run-exits-mid-workflow.md`
  — step 1's brief (its open question 2 is settled above, and its `runResourceLimits` hypothesis
  corrected). **Absolute path on purpose:** the brief exists only in the main checkout, not in
  the `eeceb869` worktree where the implementation runs, so a repo-relative path resolves to
  nothing there.
- `.ai/specs/2026-08-22-run-broker-cli-keepalive.md` — the prior fix and its verification

Measured for this spec, on this box: the `getActiveResourcesInfo` trace summarised in Problem
§"The measurement" (raw log `/tmp/cez-drainprobe-IYIQ/probe.log`, 122 transitions over
20 113 ms; that path is scratch and will not survive a reboot — the numbers are quoted here
because of it).

Read directly at HEAD `03371871` for the 2026-08-24 revision (this run's spec step), on top of
step 1's brief `.ai/specs/briefs/2026-08-23-headless-run-exits-mid-workflow.md` (which exists in
this worktree at that path, unlike the 2026-08-23 brief):

- `packages/cezar/src/runs/run-exit-guard.ts:1-93`, the whole new module, read line by line;
  the `!record` early returns at `:55-56` and `:72-73` are where delta 4 comes from
- `packages/cezar/src/index.ts:998-1012` (`runCommand` head, `DEFAULT_WORKFLOW_NAME` at `:1012`),
  `:1082-1145` (settle, guard, keep-alive, `startRun`, the awaited promise and its `finally`),
  `:1965` (`main()` at module scope; the "zero exports" claim still holds)
- `packages/cezar/src/workflows/run.ts:950-1005` (the state sets `runLiveness` reads),
  `:3483-3501` (`isActive` and the new predicate), `:5090-5097` (`step-start` and the fault)
- `packages/cezar/src/runs/run-exit-guard.test.ts:1-121` and
  `src/workflows/run-liveness.test.ts:1-79`, counted the landed cases against §3's list
- `packages/cezar/src/runs/store.ts:742,776,853,1348`: `RunStore extends EventEmitter`, plus the
  `getRun`/`updateRun`/`flush` signatures the guard's structural `RunExitGuardStore` must match
- `packages/contract/src/runs.ts:39`: `RunStatus` is exported, which the inline
  `import('@loki-labs/better-cezar-contract').RunStatus` annotations in `index.ts` depend on
- `packages/cezar/package.json:35-42` and root `package.json` scripts, `vitest.config.ts`
  (`include: ['src/**/*.test.ts']`), `.ai/agentic.config.json:8-16` (five validation commands,
  no `lint`), and `grep -c '^test(' test/e2e/*.test.ts` → 18, `package-cli` 1: all four of the
  2026-08-23 gate facts re-verified, all still true
- `git rev-list --count 9c65f9e9..main` → 79; `git diff --stat 9c65f9e9..main` over the two
  edited source files → 295 and 77 changed lines. This is the new §0.

**Not verified in the 2026-08-24 revision, and deliberately not claimed:** nothing was built,
run or tested in this step either. The three acceptance criteria are exactly as open as they
were on 2026-08-23; what changed is that the code to test now exists and its gaps are named.

**Not found / not done in this step:** no runtime reproduction of the *failure* itself (it did
not trigger on a quiet box, twice now — once in step 1's Explore run, once here); the bisect
(P0) was not run; `npm run test:package` was not run in this step. All three are the
implementation step's work and are written into Phases and Verification as such.
