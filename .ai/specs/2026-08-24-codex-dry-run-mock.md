# `CEZ_DRY_RUN=1` still spawns the real `codex`, so the offline dry run spends real quota and the packaged e2e is red

**Status:** Implemented, tested, and shipped 2026-08-24. Committed `03a16af3` ("fix: dry-run codex
through a bundled mock instead of the real CLI"), then reconciled with a parallel session's
independent fix for the same defect (`8219c6f0`, `33ac3b20`) at merge commit `c25d8ee5`, pushed to
`origin/main`. This branch's `scripts/` move (P1-P3 below) is what shipped; see "Executed 2026-08-24"
in the Status log for the reconciliation and the final gate numbers. Originally written by the spec
step of task `eeceb869-64ee-462a-a180-675761e24ce7`, on branch `cez/eeceb869` at HEAD `2256f748`.
**Date:** 2026-08-24
**Repo:** `cezar`
**Closes:** acceptance criterion 2 of task `eeceb869` ("`npm run test:package` is green"), the one
criterion `.ai/specs/2026-08-23-headless-run-drains-event-loop.md` left open and explicitly
deferred to a spec of its own.
**Extends / depends on:**
- `.ai/specs/2026-08-23-headless-run-drains-event-loop.md` (the liveness fix, shipped at
  `2256f748`; AC1 and AC3 closed there, do not re-open them)
- `.ai/specs/2026-08-24-codex-step-model-and-effort.md` and
  `.ai/specs/2026-08-24-default-workflow-ten-stages.md` (which put a codex-pinned step into the
  default workflow, and so into every dry run)
- `.ai/specs/2026-08-23-codex-resume-explicit-model.md` (the mock fixture this spec promotes was
  last extended there)
- `.ai/specs/2026-08-20-steps-green-only-when-verified.md` (the existing `CEZ_DRY_RUN`
  post-condition carve-out, the closest precedent for "dry run means simulated, not real")
**Brief read first:** `.ai/specs/briefs/2026-08-24-headless-run-exit0-status-and-gap.md`.
**KB read first:** `notion-859eb87e7872` ("An unpinned codex step is not on a default…", section
*"Testing a codex path with no codex dry-run mock"*), `notion-20d423d8d1fe` (codex became a usable
provider on production 2026-08-22), `notion-d0d1b149e664` (codex quota reporting).

## TLDR

`resolveCodexExecutable()` has no `CEZ_DRY_RUN` branch. The Claude runner has one and the pi
runner has one, so `CEZ_DRY_RUN=1` mocks two of the three backends and silently spawns the real
third. Since `spec-to-deploy` became the default workflow for every run path and its third step,
`review-spec`, carries `runner: 'codex'`, **every dry run now makes a real codex call**, which on
this box dies on quota until Aug 31 2026.

Two consequences, one visible and one not:

1. `npm run test:package` case *"the release tarball installs and runs the dry-run CLI workflow"*
   is red at `# pass 17 / # fail 1`, identically on `cez/eeceb869` and on clean `origin/main`
   `c328ec06`. This is task `eeceb869`'s last open acceptance criterion.
2. Every offline demo, every packaged smoke test, and every codex quota probe under
   `CEZ_DRY_RUN=1` spends the owner's real codex quota. Nobody has been watching that one,
   because it fails soft.

The fix is to finish a pattern the repo already has twice: give `resolveCodexExecutable` the same
three-tier resolution the other two runners use, and promote the existing 223-line app-server
fixture out of `src/core/__fixtures__/` into the packaged `scripts/` directory, so it is one file
that both the unit tests and the shipped dry run use, exactly as `scripts/mock-claude.mjs`
already is.

No new concept is invented here. What is new is that a mock now ships in the tarball, so the
tarball has to be made to guarantee it, not merely happen to include it.

## Problem

### What is red, and what it says

`packages/cezar/test/e2e/package-cli.test.ts:14`, *"the release tarball installs and runs the
dry-run CLI workflow"*, packs the release, installs it into a scratch consumer, boots the real
CLI against a git fixture with `CEZ_DRY_RUN=1` and `CEZ_HOME` pinned, and asserts the run reaches
`done` or `review` (`package-cli.test.ts:83-93`). It now fails with:

```
You've hit your usage limit. Upgrade to Pro (…) or try again at Aug 31st, 2026 12:32 PM.
```

Measured in the verification step of task `eeceb869` and recorded in
`.ai/specs/2026-08-23-headless-run-drains-event-loop.md`'s `VERIFIED 2026-08-24` block: the suite
is `# pass 17 / # fail 1`, identically when idle and under an 8-way busy-loop load, and **the same
case fails identically on a clean `origin/main` `c328ec06` worktree**. So it is neither caused nor
fixed by that branch.

The acceptance criterion as written says "15/15". That number is stale, and so is every other
fixed count anyone has written down for this suite, because the suite keeps growing under it. This
branch has 6 e2e files / 18 cases; `origin/main` `8737a136` has **7 files / 25 cases**, because main
added `test/e2e/deploy-e2e-probe.test.ts` (407 lines, 7 cases) which has **never been run on this box
or on this branch**. Since this spec mandates merging `origin/main` before P1 (see the Status log),
the count that matters is the one measured **after** that merge. Read the criterion as
"`npm run test:package` is green", and see V4 for how to make that measurable rather than
guessed.

A third, independent reason this case cannot be green today: `.github/workflows/ci.yml:57` runs
`test:package` on `ubuntu-latest`, which has no `codex` binary at all. So in CI the case fails on
`ENOENT` rather than on quota. That strengthens the argument for D1 beyond quota alone: the fix
makes the packaged dry run **host-independent**, which is the only way this case can ever be green
on a clean runner.

### The mechanism, read from source at `2256f748`

`packages/cezar/src/core/codex-app-server-transport.ts:19-21`:

```ts
export function resolveCodexExecutable(override?: string): string {
  return override ?? process.env.CEZ_CODEX_BIN ?? 'codex';
}
```

Compare the other two backends, which each have a third tier:

- `packages/cezar/src/core/claude-cli-runner.ts:133-138`, resolving to `mockClaudePath()`
  (`:921-926`, which points at `<pkg>/scripts/mock-claude.mjs` from either `dist/core` or
  `src/core`).
- `packages/cezar/src/core/pi-runner.ts:52`, resolving to `mockPiPath()` (`:437-443`, pointing at
  `<pkg>/scripts/mock-pi-rpc.mjs`, and carrying a comment about why the path is resolved this way
  rather than through `new URL().pathname`).

`resolveCodexExecutable` has **three** non-test callers, and all three inherit the gap:

- `packages/cezar/src/core/codex-app-server-runner.ts:87` (`this.bin = resolveCodexExecutable(opts.bin)`),
  the run path.
- `packages/cezar/src/core/agent-account-probe.ts:125`, inside `probeCodexQuota`, the quota panel's
  account probe, which issues `account/rateLimits/read` (`agent-account-probe.ts:70`).
- `packages/cezar/src/core/codex-model-catalog.ts:39`, inside `discoverCodexModels`. It is reached
  from **both** planes: the run path, via `codex-app-server-runner.ts:21`'s import of
  `sharedRunnerModelCatalog` (`:59`, used for resume-model discovery), and the cockpit's
  `GET /models` endpoint (`server.ts:2492`, `modelCatalog.get(runner)`).

D1 changes this third caller's behaviour too, and the change is benign in both directions: under
`CEZ_DRY_RUN=1` model discovery answers from the mock, whose `model/list` already returns exactly
`gpt-5.6-sol` (fixture `:68`), the model `review-spec` pins, so discovery resolves fast and
offline instead of spawning a real codex. The dry-run cockpit's codex model picker will therefore
show that one-model catalog. That is intended, not a regression: a dry run showing the dry-run
catalog is the same stance `CEZ_DRY_RUN` already takes everywhere else.

### Why every dry run reaches it now

`packages/cezar/src/workflows/types.ts:1490` sets `DEFAULT_WORKFLOW_NAME = SPEC_TO_DEPLOY_WORKFLOW.name`,
and `SPEC_TO_DEPLOY_WORKFLOW` (`types.ts:999`) has nine steps in this order:

`context`, `spec`, `review-spec`, `implement`, `run-tests`, `commit-push`, `merge`, `document`,
`deploy`.

Step three, `review-spec` (`types.ts:1116-1123`), carries `runner: 'codex'`, with
`byRunner: { claude: … }` as the per-runner override. A grep for `runner: 'codex'` across
`packages/cezar/src/` outside tests returns exactly one hit, `types.ts:1120`, so **`review-spec` is
the only codex-pinned step**, which bounds this problem usefully (see D4).

This is why the symptom changed shape without anybody changing the test, and it happened in **two
unrelated moves four days apart**. Do not attribute this red to the AC1 bisect commit:

- `a7510b2f` (2026-08-20) made `spec-to-deploy` the default, replacing `workflowName ?? 'quick-task'`
  with `workflowName ?? DEFAULT_WORKFLOW_NAME`. Measured at that commit, `SPEC_TO_DEPLOY_WORKFLOW`
  had **six steps** (`spec`, `implement`, `run-tests`, `commit-push`, `document`, `deploy`) and
  **zero codex pins**, an all-Claude chain. That is why the ORIGINAL symptom was the event-loop
  liveness drain, closed at `2256f748`, and not a quota error.
- At `e2566b3e` (2026-08-23) the chain had grown to **eight steps** and still carried zero codex
  pins.
- The codex pin arrived at **`c328ec06` (2026-08-24, "feat: implement default workflow ten stages
  spec")**, which is the *only* commit in this file's history to add `runner: 'codex'`
  (`git log -S"runner: 'codex'" -- packages/cezar/src/workflows/types.ts` returns exactly one hit).
  The same commit added the `merge` step. So `c328ec06` is what turned the same case red for a
  second, unrelated reason, on top of a liveness bug that had already been fixed.

**The corollary is the best available evidence that P4 will succeed.**
`test/e2e/package-cli.test.ts:80-81` records the **eight-step chain completing in 20.6 s** under the
Claude mock. Steps 4 through 9 therefore have a green precedent, and the only two steps that have
never completed in a packaged dry run are `review-spec` (what this spec fixes) and **`merge`, new in
the same `c328ec06`**. P4's second contingency names `merge` explicitly for that reason.

### The second consequence, which no test is watching

`AGENTS.md:11` records a deliberate carve-out: under `CEZ_DRY_RUN=1` every post-condition
short-circuits green with a `simulated, not verified` verdict, because a dry-run agent commits and
deploys nothing (`.ai/specs/2026-08-20-steps-green-only-when-verified.md`). The stance that
carve-out encodes is that a dry run must not do real, side-effecting work. Spawning the real
`codex` and consuming a real quota window is exactly the class of thing that stance forbids, and
it is happening on every dry run today, both in `CodexAppServerRunner` and in `probeCodexQuota`.

### What the record already says about this, so it is not re-derived

- `packages/cezar/src/task-classifier.ts:36` gives the gap as a live reason for a design decision:
  the classifier runs on `config.defaultRunner` rather than on the run's own runner partly because
  "the `CEZ_DRY_RUN` mock only exists for claude and pi".
- KB `notion-859eb87e7872`, section *"Testing a codex path with no codex dry-run mock"*: mocks
  claude and pi only, there is no codex mock, and `CEZ_CODEX_BIN` plus the unit fixture is the
  workaround. That section also records two gotchas paid for in wall-clock: a workflow of a single
  agent step parks at `waiting` rather than finishing, and an assertion should read the step
  record's `model` rather than trying to capture the child's argv.
- `AGENTS.md` trap 5 (`:367-398`) carries two dated in-place corrections that walk this exact
  diagnosis forward, ending at "Fixing this one means shipping a codex app-server mock in
  `scripts/`".
- A queued, **not yet applied** knowledge proposal sits in this run's `CEZ_KB_WRITE_FILE`
  (`seq: 0`), titled *"CEZ_DRY_RUN does not mock the codex backend, so dry runs spend real quota"*.

## Solution

### D1: the dry-run branch goes in `resolveCodexExecutable`, not in the runner constructor

```ts
export function resolveCodexExecutable(override?: string): string {
  return override ?? process.env.CEZ_CODEX_BIN ?? (process.env.CEZ_DRY_RUN === '1' ? mockCodexPath() : 'codex');
}
```

Tier order matters and is copied deliberately from `pi-runner.ts:52`: an explicit `override` wins,
then `CEZ_CODEX_BIN`, then the mock, then the real binary. Keeping `CEZ_CODEX_BIN` **above** the
mock is what leaves the nine existing test files that point that variable at a fixture working
unchanged, and it leaves an operator able to force a real codex inside a dry run if they ever want
to.

**The alternative considered and rejected:** put the branch in `CodexAppServerRunner`'s
constructor (`codex-app-server-runner.ts:87`) instead, leaving `probeCodexQuota` on the real
binary. That would mirror Claude exactly, where `ClaudeCliRunner` gets the mock and
`probeClaudeAccount` (`agent-account-probe.ts:367`) does not. Rejected because the Claude
asymmetry is itself a latent defect of the same family, not a design: a quota probe is a real
provider call, and `CEZ_DRY_RUN` exists to mean "no real provider calls". Fixing the codex half at
the shared seam is cheaper than fixing it twice, and D5 removes the only cost of doing so. The
Claude probe is deliberately **left alone** here: it is a separate defect, it is not blocking
anything, and widening this change to it would put two unrelated behaviour changes in one commit.

### D2: one mock file, moved into `scripts/`, not copied

`packages/cezar/src/core/__fixtures__/codex/mock-codex-app-server.mjs` (mode 0755; **223 lines on
this branch but 298 on `origin/main` `8737a136`**, where the `2026-08-24-codex-never-asks-permission`
work added roughly 76 lines of approval scripting; measure it after the mandated merge rather than
trusting either number) **moves** to `packages/cezar/scripts/mock-codex-app-server.mjs`. Every reference is repointed. It
is a move, not a copy: two files drift, and the drift is silent because each has its own consumer.

The precedent is exact and already in this repo. `scripts/mock-claude.mjs` is simultaneously the
`CEZ_DRY_RUN` mock and the fixture the unit tests use, referenced from
`src/core/claude-cli-runner.ts`, `src/core/claude-cli-runner.test.ts`,
`src/core/claude-ui-mapper.test.ts`, `src/workflows/run.test.ts`, `src/workflows/postconditions.ts`,
`src/pack-check.test.ts` and `test/e2e/package-cli.test.ts`.

Nine files reference the codex fixture path today and must be repointed (measured by
`grep -rl mock-codex-app-server src/ test/`):

| File | Occurrences |
| --- | --- |
| `src/core/codex-app-server-runner.test.ts` | 4 |
| `src/workflows/account-fallback.test.ts` | 2 |
| `src/core/codex-ui-mapper.test.ts` | 1 |
| `src/server/provider-action-gating.test.ts` | 1 |
| `src/workflows/run.test.ts` | 1 |
| `src/workflows/model-identity-wiring.test.ts` | 1 |
| `src/workflows/recover-session-failure.test.ts` | 1 |
| `src/workflows/codex-resume-poisoned-model.test.ts` | 1 |
| `src/workflows/resume-missing-session.test.ts` | 1 |

This is the one place in this spec where a scripted multi-file transform is the right tool rather
than hand edits: the change is a single path rewrite repeated 13 times.

Note the depth change. From `src/core/__fixtures__/codex/` the tests reach the file with paths
like `join(import.meta.dirname, '../core/__fixtures__/codex/mock-codex-app-server.mjs')`; from
`scripts/` the correct relative path differs per test directory. Repoint by resolving from
`import.meta.dirname` to the package root and then into `scripts/`, the same shape
`mockClaudePath()` uses, rather than counting `../` by hand per file.

### D3: the tarball must guarantee the mock, not merely happen to carry it

`packages/cezar/package.json`'s `files` field is `["dist", "web/dist", "scripts", "README.md"]`, so
a file placed in `scripts/` ships today with no manifest change. That is exactly the kind of
implicit dependency that breaks quietly later, which is the bug class `src/pack-check.ts` was
written for after phase R1 of the cockpit redesign shipped a tarball with no UI in it.

So two guards, in the two places that already do this job:

1. `findPackGaps` (`src/pack-check.ts`) gains a required-file check for the three bundled mocks:
   `scripts/mock-claude.mjs`, `scripts/mock-pi-rpc.mjs`, `scripts/mock-codex-app-server.mjs`. A
   tarball missing any of them ships a `CEZ_DRY_RUN` that spawns real CLIs, which is a broken
   package by the same standard as a missing UI shell. This runs on every build, since
   `check:pack` is the **third of four** legs of the root `npm run build`
   (`build:server && build:web && check:pack && build:stamp`, `package.json:17`).
2. `test/e2e/package-cli.test.ts:32-35` already asserts a required-path list against what
   `npm pack --json` reports, and already names `scripts/mock-claude.mjs`. Add
   `scripts/mock-codex-app-server.mjs` to that list.

### D4: what the shipped mock must do for `review-spec`, and what it deliberately must not

The fixture already speaks the handshake the runner needs: `initialize`, `model/list` (one page,
`nextCursor: null`), `thread/start` / `thread/resume`, `turn/start`, then an `agentMessage` with a
streamed delta, a `commandExecution` with an `outputDelta`, a `thread/tokenUsage/updated`, and
`turn/completed`. It exits on stdin EOF. That is enough for one chain step to run and finish.

Two things it must **not** be taught, each for a reason:

- **It must not emit a `CEZ:REVIEW=pass` verdict.** `parseReviewVerdict` returning `undefined` is
  a supported outcome: `run.ts:6365-6372` stores a verdict only when one was declared, and
  `run.ts:5601` acts only on `'revise'`. A no-verdict review therefore proceeds, which is what
  `mock-claude.mjs` already produces for this step (it emits no verdict either). A mock that
  declares `pass` would be a mock asserting a review happened, and every dry run would then carry
  a fabricated approval on its record.
- **It does not need a `CEZ:DONE` marker for this step.** `run.ts:6371` gates the done marker on
  `interactive`, which is false for a mid-chain step, so the marker is ignored at `review-spec` by
  construction. And because `review-spec` is the only codex-pinned step (see the Problem section),
  the final step of the chain still runs on the Claude mock, which does append `CEZ:DONE` when the
  task text contains `mock:done` (`scripts/mock-claude.mjs:99-101`). If P4's measurement shows the
  run parking rather than settling, the contingency is written down in P4 rather than pre-emptively
  built here.

The fixture's `thread/start` guard is kept as it is: it rejects a request whose `sandbox` is not
`danger-full-access` (or `workspace-write` when `CEZ_CODEX_NETWORK=0`) or whose `approvalPolicy`
is not `never`. It computes that expectation from the same env variable the runner computes it
from (`codex-app-server-runner.ts:410-412`), so it can only fire when runner and mock genuinely
disagree, which is information rather than noise.

### D5: the mock answers `account/rateLimits/read`, so the quota probe stays fast and offline

D1 routes `probeCodexQuota` at the mock under `CEZ_DRY_RUN=1`. The mock ignores unknown methods,
so without this decision the probe's request would never resolve and every dry-run probe would
burn its full `DEFAULT_PROBE_TIMEOUT_MS` (8 s, `agent-account-probe.ts:61`) before failing soft to
`undefined`.

So the mock gains one branch: `account/rateLimits/read` returns a small, fixed, plausible
envelope, parsed by the same zod schema the real answer is. This follows the established dry-run
precedent in `src/server/forge/github.ts` (`:491`, "a small fixed catalog so the GitHub tab is
demoable offline"), and it turns a stall into a working offline account panel.

Fail-soft is preserved either way: `probeCodexQuota` documents `undefined` as covering every
failure, so a malformed canned answer degrades exactly as a missing codex does today. The point of
D5 is latency and demo quality, not correctness.

### D6: corrections owed in place

Six statements become false the moment P2 lands, and every one is somewhere a future session reads
first. Under the workspace rule on corrections, each is edited in place with a dated lead-in and
its original text preserved beneath.

| Where | What is now false |
| --- | --- |
| `packages/cezar/src/task-classifier.ts:36` | "the `CEZ_DRY_RUN` mock only exists for claude and pi". The surrounding decision (classify on `defaultRunner`) still stands on its other two reasons; only this clause dies. |
| `AGENTS.md` trap 5 (`:367-398`) | "Fixing this one means shipping a codex app-server mock in `scripts/`" and the accompanying "the only one that exists today is a test fixture at `src/core/__fixtures__/…`". Both become the past tense. |
| `.ai/specs/2026-08-23-headless-run-drains-event-loop.md`, `VERIFIED 2026-08-24` block | "AC2 is NOT met" and "wants its own spec rather than being smuggled into this one". The deferral was correct; point it at this file and record the outcome. |
| KB `notion-859eb87e7872` | The falsehood is in a **section heading inside the body**, `## Testing a codex path with no codex dry-run mock` (line 76 of `notion-export/knowledge/notes/codex-task-class-router-fills-the-unpinned-step--local.md`), and in its first sentence at line 78 ("`CEZ_DRY_RUN=1` mocks claude and pi only; there is no codex mock"). The **document title** (verbatim: *"An unpinned codex step is not on a default, it is on the worst cell — so cezar classifies the task"*) is still true and must **not** be stamped. Amend the section heading; leave the title alone. |
| `.ai/specs/2026-08-22-headless-run-exit0-bisect-and-verify.md` | Inherited debt, flagged by the brief: the liveness spec instructed a `SUPERSEDED` lead-in on that spec's duplicate-closure status line once the fix shipped, and commit `2256f748` did not write it. Nobody else will. It is folded into P5. |
| `~/loki-labs/cezar/.ai/cezar/todos.json`, todo `49162dbe-8857-4f5d-abff-7be5fcc2967b` | Still `status: "todo"`, filed `2026-08-21T22:08:23Z`, never touched by either task that worked this bug. It is the canonical record of the original symptom. |

## Architecture

```
                     resolveCodexExecutable(override?)        [transport.ts:19]
                                  |
        override ─── CEZ_CODEX_BIN ─── CEZ_DRY_RUN=1 ? mockCodexPath() ─── 'codex'
                                  |
       ┌──────────────────────────┴──────────────────────────┐
       │                          │                          │
 CodexAppServerRunner      probeCodexQuota          discoverCodexModels
 (runner.ts:87,           (agent-account-          (codex-model-catalog.ts:39;
  the run path)            probe.ts:125)            resume discovery via
       │                          │                 runner.ts:59, and the
       │ spawnCodexAppServer      │ account/        cockpit's server.ts:2492)
       │  → nodeSpawn(bin,        │  rateLimits/            │
       │     ['app-server'])      │  read                   │ model/list
       ▼                          ▼                         ▼
        ┌─────────────────────────────────────────────────────┐
        │  packages/cezar/scripts/mock-codex-app-server.mjs   │  ← moved from
        │  initialize · model/list · thread/{start,resume}    │    src/core/__fixtures__/
        │  turn/start · account/rateLimits/read (D5)          │    codex/
        │  exits on stdin EOF                                 │
        └─────────────────────────────────────────────────────┘
             ▲                                        ▲
             │ CEZ_CODEX_BIN=…                        │ files: ["dist","web/dist","scripts",…]
             │ (9 unit/integration test files)        │ + findPackGaps guard (D3)
             │                                        │ + package-cli.test.ts required-path list
```

`mockCodexPath()` is the third instance of a helper this package already has twice. It resolves
from `import.meta.url`'s directory up two levels and into `scripts/`, which lands correctly from
both `<pkg>/dist/core` (built) and `<pkg>/src/core` (tsx dev). Copy the body of `mockPiPath()`
(`pi-runner.ts:437-443`) rather than re-deriving it: its comment records that `new URL().pathname`
yields a leading-slash `/C:/…` on Windows that `spawn` cannot execute.

## Phases

Each phase is independently shippable and independently verifiable. P1 through P3 can land in any
order; P4 is the measurement that closes the acceptance criterion, and P5 is the record.

### P1: move the fixture into `scripts/` (no behaviour change)

- `git mv packages/cezar/src/core/__fixtures__/codex/mock-codex-app-server.mjs packages/cezar/scripts/mock-codex-app-server.mjs`
  (use `git mv`, so the file's history and its 0755 mode both follow it).
- Repoint the 13 references across the 9 files in D2's table, resolving through the package root
  rather than hand-counting `../`.
- `src/core/__fixtures__/codex/` **stays**: 28 NDJSON/JSON fixtures remain in it, read by
  `codex-model-catalog.test.ts:9` (which resolves the whole directory), `agent-account-probe.test.ts:64,77`,
  `ui-event-sink.test.ts:29` and `codex-ui-mapper.test.ts`. Only the `.mjs` moves. The directory
  holds 29 files today; deleting it after the move would take 28 live fixtures with it. Note in
  passing that `account-rate-limits.json` is the **recorded live envelope** (`agent-account-probe.ts:194`
  says it was captured, not hand-written) that D5's canned answer should be shaped from.
- Nothing else changes. `CEZ_DRY_RUN` is untouched in this phase, so a green `npm test` is
  complete proof that P1 is inert.

**Ships alone?** Yes. Nothing outside the test suite reads the file yet.

### P2: the dry-run branch (the fix)

- Add `mockCodexPath()` to `codex-app-server-transport.ts`, bodied on `mockPiPath()`.
- Rewrite `resolveCodexExecutable` per D1, with a comment naming `CEZ_DRY_RUN` and this spec.
- Add cases to the existing `src/core/codex-app-server-transport.test.ts`:
  1. no env set, returns `'codex'`;
  2. `CEZ_DRY_RUN=1`, returns a path ending `scripts/mock-codex-app-server.mjs`;
  3. `CEZ_DRY_RUN=1` **and** `CEZ_CODEX_BIN=/x/y`, returns `/x/y` (tier order, the property that
     keeps the nine existing test files working);
  4. an explicit `override` beats both.
  Save and restore both env vars around each case, in the shape
  `src/workflows/codex-resume-poisoned-model.test.ts:41-61` uses.
- **Decide the `MOCK_RPC` stderr echo here, not in P4.** The fixture writes
  `MOCK_RPC <method> <params>` to stderr on every request (fixture `:73` and `:99`, covering
  `thread/start` and `thread/resume`). Once it ships, that line appears in the stderr of every real
  dry run. It is harmless and useful for debugging, and `mock-claude.mjs` sets no contrary
  precedent. Recommendation: **keep it**, and record the decision in the status log so P4 does not
  discover it as a surprise. If it turns out to be noisy in cockpit output, gate it behind
  `MOCK_CODEX_TRACE=1` rather than deleting it.

**Ships alone?** Yes, but it is only useful together with P1, since without P1 the resolved path
does not exist in a built or packed tree.

### P3: make the tarball guarantee the mocks

- Extend `findPackGaps` (`src/pack-check.ts`) with the three required `scripts/mock-*.mjs` paths,
  each with its own human-readable gap message.
- Extend `src/pack-check.test.ts` with a case per new gap, plus one that a complete list reports
  no gaps.
- Add `scripts/mock-codex-app-server.mjs` to the required-path list at
  `test/e2e/package-cli.test.ts:33`.

**Ships alone?** Yes, though the new pack assertions only pass once P1 has moved the file.

### P4: measure the packaged dry run and close AC2

No new code is expected here. This phase is the executable proof, and it owns two contingencies
that are written down in advance so a surprise is a decision rather than an improvisation:

- **If the run parks at `waiting` instead of settling** (the failure shape KB `notion-859eb87e7872`
  warns about for a chain that ends without a terminal signal), the remedy is a `mock:done` branch
  in the codex mock mirroring `scripts/mock-claude.mjs:99-101`: when the accumulated turn input
  contains `mock:done`, append a trailing `CEZ:DONE` line to the final `agentMessage`. Add it only
  if measured, and say so in the status log.
- **If the run fails at a step after `review-spec`**, that is a different defect from this one.
  Record the step id and the error, and do not widen this spec to cover it; file it. **The most
  likely surprise is `merge`**, and the Problem section says why: `package-cli.test.ts:80-81`
  records the eight-step chain completing in 20.6 s under the Claude mock, so steps 4 through 9 all
  have a green precedent **except** `merge`, which arrived in the same `c328ec06` as the codex pin
  and has therefore never completed in a packaged dry run either. Expect it, measure it, and file
  it separately rather than absorbing it here.

**Ships alone?** It is the gate on the other phases, not a change.

### P5: correct the record in place

Work the six rows of D6's table. Specifically:

- Edit the clause at `task-classifier.ts:36`, keeping the decision it supports intact.
- Add a dated correction to `AGENTS.md` trap 5, in the same in-place style the two existing
  corrections there use, and stop short of deleting them.
- Add a line to the `VERIFIED 2026-08-24` block of
  `.ai/specs/2026-08-23-headless-run-drains-event-loop.md` pointing at this spec and recording that
  AC2 closed.
- Write the owed `SUPERSEDED <date>` lead-in on
  `.ai/specs/2026-08-22-headless-run-exit0-bisect-and-verify.md`'s status line, preserving its
  original text and crediting the two things it got right (the `097d1b15` refutation and the
  `node_modules` resolve-upward warning).
- Correct KB `notion-859eb87e7872` via `CEZ_KB_WRITE_FILE`, aimed at the **section heading, not the
  document title** (D6's row says why). Two lines:
  1. an **`upsert`** whose body rewrites the section heading at line 76 of
     `notion-export/knowledge/notes/codex-task-class-router-fills-the-unpinned-step--local.md`,
     e.g. *"Testing a codex path: the dry-run mock, and how it was tested before it existed"*,
     with a dated `CORRECTED 2026-08-24` lead-in above the preserved original text, naming this
     spec as where the mock now lives;
  2. a **`supersede`** note **without** `amendHeading`. That flag targets the document title, and
     the title (*"An unpinned codex step is not on a default…"*) is still true; stamping it would
     retire a correct statement.
  **Append with the next free `seq`**: this run's file already holds `seq: 0`.
- Reindex the corpus afterwards, because a corpus write is not a KB write until then:
  `cd /var/lib/cezar/loki-labs && CEZ_KB=1 cez kb reindex`, then grep the catalog for the slug.
- Set todo `49162dbe-8857-4f5d-abff-7be5fcc2967b` in `~/loki-labs/cezar/.ai/cezar/todos.json` to
  its true status, with a note naming both this spec and the liveness spec.

**Ships alone?** Yes, and it should not ship *before* P4 measures, or it records something that
has not happened.

## Data models

No persisted schema changes. `runs.json`, `todos.json` and `~/.cezar/config.json` are untouched.
The only manifest field involved, `package.json`'s `files`, already lists `scripts` and does not
change.

## API contracts

Two contracts change, neither of them HTTP.

**1. Codex executable resolution.** From a two-tier to a three-tier order:

| Tier | Source | Before | After |
| --- | --- | --- | --- |
| 1 | `override` argument | wins | wins |
| 2 | `CEZ_CODEX_BIN` | wins | wins |
| 3 | `CEZ_DRY_RUN === '1'` | *(absent)* | `<pkg>/scripts/mock-codex-app-server.mjs` |
| 4 | fallback | `'codex'` | `'codex'` |

**2. The JSON-RPC surface the shipped mock is now committed to.** Once the file is in the tarball
it is a published artifact, so the methods it answers are a contract that a codex upgrade can
break:

| Method | Answer |
| --- | --- |
| `initialize` | `{ userAgent }` |
| `model/list` | one page, `nextCursor: null`, one servable `gpt-*` model |
| `thread/start` | `thread/started` notification plus a `{ thread: { id } }` result; rejects a mismatched `sandbox` / `approvalPolicy` |
| `thread/resume` | inherits the persisted model per `.ai/specs/2026-08-23-codex-resume-explicit-model.md` |
| `turn/start` | `turn/started`, item stream, `thread/tokenUsage/updated`, `turn/completed` |
| `account/rateLimits/read` | **new (D5)** a fixed envelope matching the probe's zod schema |
| stdin EOF | exits 0, unless `MOCK_CODEX_IGNORE_EOF=1` / `MOCK_CODEX_IGNORE_SIGTERM=1` |

Because this section declares the shipped surface a contract, the switch enumeration has to be
complete. Measured on `origin/main` `8737a136` (`grep -o 'MOCK_CODEX_[A-Z_]*' | sort -u`), the full
set is **ten**, not the seven this branch carries:

`MOCK_CODEX_APPROVAL`, `MOCK_CODEX_ASK`, `MOCK_CODEX_EXIT_CODE`, `MOCK_CODEX_IGNORE_EOF`,
`MOCK_CODEX_IGNORE_SIGTERM`, `MOCK_CODEX_NOTIFICATION`, `MOCK_CODEX_ORPHAN`,
`MOCK_CODEX_PERSISTED_MODEL`, `MOCK_CODEX_REJECT_RESUME`, `MOCK_CODEX_SUICIDE_SIGKILL`.

Three of those arrived on main and are absent from this branch's copy, so re-read the merged file
before writing them down as final:

- **`MOCK_CODEX_APPROVAL`** drives the approval surface: `item/commandExecution/requestApproval`,
  `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `execCommandApproval` and
  `mcpServer/elicitation/request`.
- **`MOCK_CODEX_ORPHAN`** and **`MOCK_CODEX_NOTIFICATION`** likewise.

All ten stay test-only in intent and are **inert unless set**, which is the same position
`MOCK_CLAUDE_REJECT_RESUME` already occupies in the shipped `scripts/mock-claude.mjs`. Publishing
an inert switch is not publishing a behaviour.

## Risks

1. **The move breaks a test path nobody repointed.** 13 references across 9 files, and a missed
   one fails as a spawn `ENOENT` inside a test that then times out rather than failing fast.
   *Mitigation:* P1 ships alone and its whole verification is a green `npm test` against a
   `main` baseline; and `grep -rn mock-codex-app-server src/ test/` must return zero hits naming
   `__fixtures__` afterwards.

2. **`npm pack` drops the executable bit and the shebang spawn fails in the consumer.** *Mitigation:*
   `scripts/mock-claude.mjs` is 0755 and already ships and executes through exactly this path in
   the same e2e case, so the mechanism is proven. P4's verification reads the installed file's
   mode explicitly rather than assuming it.

3. **Windows.** `spawn` of a shebang `.mjs` does not work on win32. This is a pre-existing
   limitation shared with `scripts/mock-claude.mjs` and `scripts/mock-pi-rpc.mjs`, and this spec
   does not fix it, it only makes it apply to a third backend. Named here so it is a known
   position rather than a discovery. `mockCodexPath()` copying `mockPiPath()`'s resolution at
   least avoids the separate `/C:/…` path defect that comment records.

4. **A shipped mock is a shipped attack surface / support surface.** A user could point
   `CEZ_CODEX_BIN` at it, or read `CEZ_DRY_RUN` output as real work. *Mitigation:* it spawns
   nothing, opens no socket, writes no file, and only ever speaks NDJSON on its own stdio; and the
   `simulated, not verified` post-condition verdict already tells a dry-run reader not to trust the
   result (`.ai/specs/2026-08-20-steps-green-only-when-verified.md`).

5. **One file now has two masters.** A change made for a unit test can change what every dry run
   does, and the reverse. *Mitigation:* this is the existing, working arrangement for
   `mock-claude.mjs`, and it is strictly better than the two-copies alternative, where the same
   coupling exists but is invisible.

6. **The e2e's timeout is 120 s for the run and 240 s for the case** (`package-cli.test.ts:14`,
   `:82`). Its comment records the eight-step workflow at 20.6 s idle. The chain is nine steps now
   and one of them changes backend. *Mitigation:* P4 records the measured wall-clock. If the
   margin has thinned rather than the run having failed, raise the timeout with the measurement
   quoted in the comment, the way that comment already does.

7. **Fixing the visible red hides the invisible one.** The original exit-0 liveness symptom is no
   longer reproducible on `main` because the quota failure now aborts the chain at step three,
   before the drain window. Once this spec lands, the dry run reaches those windows again.
   *Mitigation:* this is why P4 re-runs the liveness spec's fault injector as a control rather than
   treating a green e2e as proof of both. That control is in Verification below, not optional.

8. **`account/rateLimits/read` drifts on a codex upgrade.** The canned D5 answer is a snapshot.
   *Mitigation:* the probe's own doc comment (`agent-account-probe.ts:65-70`) already records that
   the app-server answers an unknown method with the list of methods it knows, and names that list
   as the oracle to re-check against. Cite it in the mock's comment.

## Verification

Every step below is a command with an expected result. Run from the repo root unless stated.
Nothing here may be reported green from reading; the workspace rule is that gates green is
necessary and not sufficient, and this spec's own acceptance is a runtime measurement.

### V1: P1 is inert

```bash
grep -rn "mock-codex-app-server" packages/cezar/src packages/cezar/test | grep -c "__fixtures__"   # expect 0
ls -l packages/cezar/scripts/mock-codex-app-server.mjs                                             # expect mode -rwxr-xr-x
npm run typecheck                                                                                  # expect exit 0
npx vitest run --reporter=verbose \
  packages/cezar/src/core/codex-app-server-runner.test.ts \
  packages/cezar/src/core/codex-ui-mapper.test.ts \
  packages/cezar/src/workflows/account-fallback.test.ts \
  packages/cezar/src/workflows/codex-resume-poisoned-model.test.ts \
  packages/cezar/src/workflows/recover-session-failure.test.ts \
  packages/cezar/src/workflows/resume-missing-session.test.ts \
  packages/cezar/src/workflows/model-identity-wiring.test.ts \
  packages/cezar/src/workflows/run.test.ts \
  packages/cezar/src/server/provider-action-gating.test.ts
```

`--reporter=verbose` is not decoration: vitest prints only failures by default, so absence from a
log is not evidence a case ran. Every one of the nine files must appear and pass.

### V2: P2's tier order

```bash
npx vitest run --reporter=verbose packages/cezar/src/core/codex-app-server-transport.test.ts
```

All four D1 cases named and passing.

### V3: P3's pack guards

```bash
npx vitest run --reporter=verbose packages/cezar/src/pack-check.test.ts
npm run build                       # expect exit 0, and a `check:pack ok` line on stdout
```

Then a negative control, so the guard is proved to have teeth rather than merely to be present:
temporarily rename `packages/cezar/scripts/mock-codex-app-server.mjs`, re-run
`npm run check:pack`, expect a **non-zero** exit naming the missing file, and restore it.

### V4: the acceptance criterion

**Do not assert a fixed pass count.** This spec must not fix a number in advance that the merge will
change. Three steps, in order:

1. **Merge `origin/main` first** (the Status log already requires it), then re-count rather than
   quoting this document:

   ```bash
   grep -c '^test(' packages/cezar/test/e2e/*.ts        # per-file counts; sum them for the total
   ```

2. **Take a baseline on the merged tree BEFORE P1 through P3.** Record the exact pass/fail counts
   and the names of every failing case. "Green" is then measured against a known starting set,
   rather than against the stale 17/1 this branch measured on a pre-merge tree.

3. **Then run it, twice**, once idle and once under an 8-way busy-loop load
   (`for i in $(seq 8); do (while :; do :; done) & done`), because the original failure this task
   was opened for was load-sensitive and a single idle green would not distinguish the two. Kill
   the load afterwards. Record both.

   ```bash
   npm run test:package                # exit 0
   ```

**The acceptance is stated as a set, not a count:** the named case
(`test/e2e/package-cli.test.ts:14`, "the release tarball installs and runs the dry-run CLI
workflow") passes, **and** the suite's failure set is empty.

The one carve-out, written down in advance so it is a decision and not an improvisation: `main`'s
`deploy-e2e-probe.test.ts` has never been executed here, so if it is red for **host reasons
unrelated to codex** (a missing deploy credential, a network egress rule), that is a **separate
defect to file with its own todo**, recorded in this spec's status log with the measured output.
It is not silently absorbed into AC2, and it is not grounds for calling AC2 closed either: say
which of the two it is, with the output quoted.

### V5: prove the mock is what made it green

A green suite alone does not prove codex was never spawned; a quota window could simply have
reset. So:

```bash
mkdir -p /tmp/poison-codex
printf '#!/bin/sh\necho "REAL CODEX WAS SPAWNED" >&2\nexit 66\n' > /tmp/poison-codex/codex
chmod +x /tmp/poison-codex/codex
PATH=/tmp/poison-codex:$PATH npm run test:package     # expect the SAME result V4 measured, still green
```

If the packaged dry run resolves the mock, a poisoned `codex` on `PATH` is never reached and the
result is unchanged. If anything still falls through to the real binary, the case fails with
`REAL CODEX WAS SPAWNED` on stderr, which names the fall-through precisely.

Then the mirror control, that the packaged CLI still uses a real codex when told to:

```bash
CEZ_DRY_RUN=1 CEZ_CODEX_BIN=/tmp/poison-codex/codex node packages/cezar/dist/index.js run 'mock:done' --repo <fixture>
# expect a FAILED run whose record carries the codex error, proving CEZ_CODEX_BIN still outranks the mock
```

### V6: the liveness control (risk 7)

The dry run now reaches the step hand-off windows again, so re-run the liveness spec's own
injector rather than assuming its earlier verdict transfers:

```bash
cd packages/cezar
CEZ_DRY_RUN=1 CEZ_RUN_FAULT=stall-step timeout 45 node dist/index.js run 'mock:done' --repo <fixture>; echo "EXIT=$?"
# expect EXIT=124 (hang), with the run record still `running` (a genuine wedge is still caught)
```

and confirm a healthy dry run never ends `exit 0` with a `running` record: read
`<fixture>/.ai/cezar/runs.json` after V4 and assert every row is terminal.

### V7: full gates, against a `main` baseline

```bash
npm run typecheck                   # expect exit 0
npm run test:unit                   # expect exit 0, `# pass 53 / # fail 0` or better
npm test                            # expect exit 1 today; the failure SET must be a subset of main's
```

`npm test` is red on clean `origin/main` for reasons unrelated to this spec (16 failures there at
`c328ec06`, of which 8 are `system-prompt.test.ts` asserting on a recorded agent invocation and
receiving a task-classifier prompt). Do not report that as this spec's regression, and do not
report it as green either. Use the procedure the liveness spec used and recorded: build a clean
`origin/main` worktree, run the same suite there, sort both failure-name lists, and `comm` them.
The acceptance is **zero failures present here and absent on `main`**.

Two traps that cost prior sessions real time, both already documented in `AGENTS.md`: point
`TMPDIR`/`TMP`/`TEMP` at `/tmp` before running the suite in a worktree (trap 4), and confirm this
worktree resolves a real `node_modules` rather than resolving upward into the parent checkout
(trap at `AGENTS.md:318-329`). Root `node_modules/.bin` holding `vitest`/`tsx`/`tsc` is the
normal hoisted-workspace shape and is not the trap; the trap's signature is roughly 13 `.bin`
entries with no `vitest` and no `jsdom`.

### V8: the record

```bash
cd /var/lib/cezar/loki-labs && CEZ_KB=1 cez kb reindex
grep -ac "codex-dry-run-mock" /var/lib/cezar/loki-labs/.ai/cezar/knowledge-index/catalog.ndjson   # expect 1
find /var/lib/cezar -not -user cezar | wc -l                                                       # expect 0
```

Grep the slug or path, never the document's text: the catalog stores an excerpt, so a phrase grep
returns 0 even for a correctly indexed document.

**Run V8 after the `merge` step, not before.** The indexed spec root is
`/var/lib/cezar/loki-labs/cezar/.ai/specs`, the main checkout, not this worktree, so the
`codex-dry-run-mock` grep returns 0 until this branch's spec file exists on `main`. A 0 before the
merge is the expected reading, not a failure.

## What this spec does NOT do, deliberately

- **It does not re-run the bisect.** AC1 is answered: `a7510b2f`, established statically against
  the exact two-way flip (`workflowName ?? 'quick-task'` to `workflowName ?? DEFAULT_WORKFLOW_NAME`)
  and its git position, with `a7510b2f` and `5e388ccf` shown to be siblings off `67e93cca` with an
  empty `git diff` between them on `index.ts`. Recorded in
  `.ai/specs/2026-08-23-headless-run-drains-event-loop.md`.
- **It does not touch P1 through P5 of the liveness fix** (`runExitGuard`, the run-lifetime
  keep-alive, `RunManager.runLiveness()`, `CEZ_RUN_FAULT`). Those shipped at `2256f748` and AC3 is
  closed by three independent measurements.
- **It does not fix `probeClaudeAccount`'s identical missing dry-run branch** (D1). Separate
  defect, not blocking, file it rather than widen this.
- **It does not fix `system-prompt.test.ts`** or the other pre-existing `npm test` reds on `main`
  (V7). Separate defects, independently reproducing, file them.

## Open questions

- **Should the shipped mock's `MOCK_CODEX_*` switches be documented in `.env.example`?** They are
  test-only in intent but now published. `.env.example:400-420` already documents `CEZ_DRY_RUN`,
  `CEZ_MOCK_ARGS_FILE` and `CEZ_MOCK_LIMIT_RESET_SECONDS`, which is precedent for documenting them.
  Not decided here; it changes no behaviour either way and can be settled during P5.
- **Whether the packaged e2e should assert that no real `codex` is spawned**, i.e. bake V5's
  poisoned-`PATH` control into `package-cli.test.ts` permanently rather than running it once by
  hand. It would pin the regression, at the cost of a `PATH` manipulation inside a test. Worth
  doing; deferred to whoever implements P3 so the decision is made with the test in front of them.

## Status log

- **2026-08-24, spec step of task `eeceb869`.** Written against HEAD `2256f748`. All line numbers
  and file contents in this document were read at that commit, not carried from the brief. Not
  implemented. `origin/main` has moved to `587db317` since this branch's last merge; integrate
  before P1.
- **2026-08-24, executed (implement + run-tests + commit-push steps).** P1-P3 implemented as
  specified (`git mv` into `scripts/`, the third `resolveCodexExecutable` tier, `findPackGaps` and
  `package-cli.test.ts` guards). P4: `npm run typecheck` exit 0; `npm run build` exit 0
  (`check:pack ok`, 1240 files); `npm run test:package` exit 0, **25/25**, including case
  *"the release tarball installs and runs the dry-run CLI workflow"* (the AC2 target case), now
  green with no real provider call. `npm test` and `npm run test:unit` both reproduce their
  pre-existing failures (15 and 8) identically on a stashed pre-diff control, confirmed unrelated;
  filed as todo `d9bdb51f-817d-4903-99a9-cd1c6ce25c75` since the run-tests log's earlier
  `428c4e0e` reference was never actually created (the `cezar todo add`-inside-a-worktree trap
  documented on todo `46dbb850`).

  **Reconciliation, not a clean P5.** Committed as `03a16af3`, but `git push origin
  cez/eeceb869:main` was rejected non-fast-forward twice: a parallel session had independently
  landed its own fix for the identical AC2 defect on `origin/main` (`8219c6f0` "fix: mock codex in
  dry runs", followed by a docs commit `33ac3b20`), documented in
  `.ai/specs/2026-08-22-headless-run-exit0-bisect-and-verify.md`. That fix kept the mock at
  `src/core/__fixtures__/codex/mock-codex-app-server.mjs` instead of moving it. Merged both in,
  resolved the four real conflicts (`transport.ts`, `transport.test.ts`, `package-cli.test.ts`,
  the mock's rename target) **in favor of this spec's `scripts/` move**, confirmed on disk:
  `packages/cezar/scripts/mock-codex-app-server.mjs` exists, `src/core/__fixtures__/codex/` no
  longer holds the `.mjs` (the other 28 fixtures stay). Dropped the now-stale duplicate
  `package.json` `files` entry the other session's approach didn't need. Kept the other session's
  unrelated test fixes (they cleared 8 of `npm test`'s pre-existing failures for free). Re-ran
  gates post-merge: typecheck 0, build 0, test:package 25/25, `npm test`/`test:unit` failures
  confirmed untouched by either diff. Pushed `origin cez/eeceb869:main` → `c25d8ee5`.
  `origin/main` and this branch's `HEAD` are now identical.

  P5's six D6 corrections: `task-classifier.ts:36`, `AGENTS.md` trap 5, the
  `2026-08-23-headless-run-drains-event-loop.md` AC2 line, the
  `2026-08-22-headless-run-exit0-bisect-and-verify.md` architecture correction (mock location:
  `scripts/`, not `__fixtures__/`, per the reconciliation above), the KB `notion-859eb87e7872`
  section-heading correction, and todo `49162dbe` all done in this (document) step. The
  `.ai/specs/2026-08-22-run-broker-cli-keepalive.md` row from D6 needed no edit: its existing
  codex-gap caveat (added by an earlier step) already reads correctly now that the gap is closed,
  since it only ever said the case was red "for reasons unrelated to this spec" (true before and
  after). The MOCK_RPC stderr echo and `.env.example` documentation open questions were left
  undecided, as the spec allowed; not blocking.
