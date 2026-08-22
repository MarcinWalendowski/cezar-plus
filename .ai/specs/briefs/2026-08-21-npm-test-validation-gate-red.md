# `npm test` — a listed validation gate — is 2152 tests red on the prod box, independent of any change

- Date: 2026-08-21
- Category: test infra / CI-agent parity
- Priority signal: high — `.ai/agentic.config.json` lists `npm test`, `npm run test:unit` and
  `npm run test:package` as validation commands every agent run is expected to gate on; a gate
  that can never go green trains agents to ignore it, which defeats "gates first, fail closed"
  (`AGENTS.md`).
- Risk signal: low-to-medium — none of the three sub-problems below requires touching product
  code; the fixes are in test/harness config and one test-isolation helper. The risk is scope
  creep into "upgrade testing-library properly" territory (see Open questions).
- Routing: Next: write the spec against this brief.

## Problem, in this repository's terms

Measured 2026-08-21 on `prod-host` at `7e8f2938`, and reproduced on an **untouched `main`
checkout** — so this is environmental/pre-existing, not caused by any in-flight branch. Root
`npm test` (`vitest run`, package.json:20) reports **134 files / 2152 tests failed of 9526**.
There are **three independent failures** hiding behind one gate, not one bug:

1. **~1931 web-package failures**, all `React.act is not a function`, from
   `@testing-library/react`'s act-compat module resolving
   `react-dom/cjs/react-dom-test-utils.production.js` under React 19.2.7. `packages/web` pins
   `"react": "^19.2.7"`, `"react-dom": "^19.2.7"`, `"@testing-library/react": "^16.3.2"`
   (`packages/web/package.json`), and `packages/web/vitest.config.ts:1-16` sets only
   `test.environment: 'jsdom'` — no `setupFiles`, no React-19 act-environment shim. Root `npm test`
   picks these up via Vitest workspace/project discovery (the web project is named `'web'` in its
   own vitest config), which is how a web-only regression fails the root gate.
2. **~41 server-package failures**, all tests asserting "this directory is NOT a git repository" —
   caused by cezar's own agent runtime setting `TMPDIR` to a path **inside the repo under test**.
   `packages/cezar/src/runs/agent-tmpdir.ts:45-47` computes `agentTmpDir(dataDir, runId) =
   join(dataDir, 'tmp', runId)`; `dataDir` resolves to `.ai/cezar`, so on an in-repo task the
   effective value — set into the spawned process env at `packages/cezar/src/workflows/run.ts:1030`
   and `run.ts:4659` (`TMPDIR`/`TEMP`/`TMP`, tagged `#785`) — is
   `.ai/cezar/tmp/<taskId>`, **inside the git checkout**. The affected tests build their "not a
   git repo" fixture via `mkdtempSync(join(tmpdir(), prefix))` (i.e. `os.tmpdir()`, which honors
   `$TMPDIR`), so the fixture directory lands inside the repo, and `git rev-parse`-style detection
   walks up and finds the repo's own `.git`, flipping the assertion. Confirmed sites:
   `packages/cezar/src/workflows/workspace-parallel.test.ts:70-74,136`,
   `packages/cezar/src/workflows/boot-root-isolation.test.ts:71-75`,
   `packages/cezar/src/workflows/postconditions.test.ts:166-173`, plus similar `tempDir`/inline
   `mkdtemp` patterns in `knowledge/store.test.ts:9`, `catalog.test.ts:17`, `paths.test.ts:21`,
   `server/workspace-reports-api.test.ts:63`, `server/project-context.test.ts:318`,
   `server/knowledge-api.test.ts:43`. With `TMPDIR=/tmp` forced, `npm run test:unit` is reported
   44/44 green — consistent with this being the entire server-side cause.
3. **`npm run test:package` test 5**, `'the release tarball installs and runs the dry-run CLI
   workflow'` (`packages/cezar/test/e2e/package-cli.test.ts:14`, asserts at line 92 that the
   dry-run workflow status is `'done'` or `'review'`), fails on **both** trees (branch and
   untouched `main`) — this brief did not root-cause it further; see Open questions.

`.ai/agentic.config.json` → `validation.commands` lists, verbatim:
```
"npm run typecheck", "npm test", "npm run test:unit", "npm run build", "npm run test:package"
```
`.github/workflows/ci.yml`'s `verify` job runs the identical command set on `ubuntu-latest`, no
web-package skip, no separate React pin — and per `AGENTS.md:335`, CI never sees failure #2
because `ubuntu-latest` has a plain `/tmp`, not a `TMPDIR` pointed inside the checkout. So CI green
is not evidence this gate works for an agent running inside its own repo.

## What the record already decided (with citations)

**Same mechanism, different symptom — a precedent exists.** `kb notion-b2a2f1953d58` ("A test's
temp-dir isolation is void when $TMPDIR points inside the repo — the 'Ship it' tasks") and
`kb notion-912e1e001bcc` document the identical root mechanism as failure #2 above — agent-run
`TMPDIR=<repo>/.ai/cezar/tmp/<runId>` defeats `mkdtemp`-based isolation because `os.tmpdir()`
honors `$TMPDIR` — but a **different manifestation**: `packages/cezar/src/todo-cli-wiring.test.ts`
piped `process.env` straight into a subprocess that ran `cez todo add`, and `getRepoInfo(cwd)`'s
upward walk for a git toplevel escaped the "isolated" temp cwd and filed ten real "Ship it" rows on
the live production Tasks board. **Fix shipped as commit `20319ab0`**: `git init -q` in the temp
cwd before running, which stops the upward walk regardless of `$TMPDIR`. Two test assertions were
added: one pinned to the temp root (passed trivially on CI, was the missing coverage), and one that
**explicitly sets `$TMPDIR` inside the repo** to reproduce the box condition. That KB entry itself
flags `todo-cli-wiring.test.ts` as *"the only test in the repo piping `process.env` into a writing
subprocess"* — implying the ~41 failures in this task (which assert git-repo-detection directly,
not a subprocess side effect) are a **different code path** hitting the same underlying trap, and
the `20319ab0` fix does not cover them. This is the closest precedent for how to fix failure #2, but
it does not already fix it.

**Two adjacent, unrelated fixes already merged (confirmed ancestors of current `HEAD`
`3444f1c8`) — ruled out as already covering this:**
- `c23fb562` "fix(runs): give each task its own TMPDIR and preflight it (#785)" — this is the
  commit that *introduced* per-run `TMPDIR` isolation (the very mechanism now causing failure #2);
  it is about runtime isolation, not test-suite git-detection.
- `b33f7a66` "fix(test): canonicalize test tmpdirs so symlinked TMPDIR matches realpathed roots" —
  a macOS `/var`→`/private/var` symlink fix for 3 specific test files
  (`projects-api.test.ts`, `projects-cli.test.ts`, `projects.test.ts`). Different root cause
  (symlink canonicalization, not TMPDIR-inside-repo).
- `kb notion-b6646332e21d` — a prior `test:package` red streak (since 2026-08-08, fixed
  `28593de0`) was a stale assertion about deliberately-removed boot-registration behavior
  ("assertion D3"). Also already merged, and a different failing assertion than today's test 5.

**Explicitly NOT the same bug, despite superficially similar titles:**
- `kb specs-b48aa00ad493` ("The boot root is not a git repository…") is about
  `/var/lib/cezar/workspace` (the *server's* boot/scratch root) not being a git repo, causing runs
  homed there to skip worktree isolation — fixed via `ensureBootRepo()`, shipped `c15780cb` +
  `c58d1d04`, deployed and confirmed live. It never mentions `TMPDIR` or the test suite. Do not
  reuse or extend that fix here.
- `kb specs-55d961fac4a0` ("A step is green only when its goal was verified") is about workflow
  step post-conditions (`everything-committed`, `all-services-deployed`), landed `57fc8807`. Not
  about TMPDIR or test isolation.
- `.ai/specs/2026-08-14-tag-patch-and-stale-tests.md` (Status: Implemented) is a closed, unrelated
  incident: 24 failures from a stale PATCH whitelist + reversed-decision test pins, already fixed
  and verified at a different pass count (422 files / 7840 tests, before the suite grew to 9526).

**No duplicate work in flight.** Checked `.ai/specs/briefs/` (only 3 files exist, none on this
topic), all 16 local `cez/*` branches (none touch `act|react 19|tmpdir|2152|validation gate` in
recent log), and `cezar todo list` (empty). This is open ground.

## Code map (what's actually involved)

| Concern | File | Note |
| --- | --- | --- |
| Root test script | `package.json:20` | `"test": "vitest run"` — root gate |
| Server unit/package scripts | `package.json:22-23`, `packages/cezar/package.json:39-40` | `test:unit` = `node --test test/unit/*.test.ts`; `test:package` = `node --test test/e2e/*.test.ts` |
| Web test script/config | `packages/web/package.json:11`, `packages/web/vitest.config.ts:1-16` | `vitest run`, `jsdom`, no `setupFiles` |
| Web/React/testing-library versions | `packages/web/package.json:27,28,41` | react/react-dom `^19.2.7`, `@testing-library/react` `^16.3.2` |
| Per-run TMPDIR source | `packages/cezar/src/runs/agent-tmpdir.ts:45-47,88-90,130-144` | `agentTmpDir()`, `agentTmpEnv()`, `CEZ_AGENT_TMPDIR=0` escape hatch already exists |
| TMPDIR wired into spawn env | `packages/cezar/src/workflows/run.ts:1030,4659` | tagged `#785` |
| Failing "not a git repo" tests | `workspace-parallel.test.ts:70-74,136`, `boot-root-isolation.test.ts:71-75`, `postconditions.test.ts:166-173`, + 6 more listed above | all build fixtures via `os.tmpdir()`-based `mkdtemp` |
| Precedent fix pattern | `todo-cli-wiring.test.ts` (via `20319ab0`) | `git init -q` in the temp cwd before use |
| Package/release dry-run test | `packages/cezar/test/e2e/package-cli.test.ts:14,92` | fails on both branch and untouched `main` |
| Validation gate list | `.ai/agentic.config.json` (`validation.commands`) | names all three failing commands |
| CI parity gap | `.github/workflows/ci.yml` (`verify` job) | same commands, but CI's plain `/tmp` never reproduces failure #2 |
| Existing escape hatch | `agentTmpDirEnabled()` / `CEZ_AGENT_TMPDIR=0` (`agent-tmpdir.ts:88-90`) | could plausibly be used by a test-runner wrapper, unconfirmed whether that's the intended fix shape |

## Open questions a spec will have to settle

1. **Failure #1 (React 19 / act):** pin `@testing-library/react` to a version with confirmed React
   19.2 act-compat support, or add a `setupFiles` shim (e.g. `global.IS_REACT_ACT_ENVIRONMENT`) —
   which, and does it require a `react-dom/test-utils` or `react-test-renderer` version bump too?
   Not yet checked: current lockfile-resolved versions of `react-dom/cjs/react-dom-test-utils` and
   whether a newer `@testing-library/react` (17.x?) exists that drops the act-compat shim
   entirely for React 19.
2. **Failure #2 (TMPDIR-inside-repo):** two candidate fix shapes, not yet decided between: (a)
   apply the `20319ab0` pattern (`git init -q` per fixture) to every affected test file
   individually, or (b) fix it once at the harness level — e.g. have the test runner itself set
   `TMPDIR=/tmp` (or `os.tmpdir()`'s system default) regardless of the ambient agent-run `TMPDIR`,
   via `CEZ_AGENT_TMPDIR=0` or an explicit override in the `test:unit`/root `vitest` script. Task
   acceptance criteria phrase this as "git-dependent tests use a TMPDIR outside the repo (or the
   runner stops pointing TMPDIR inside it)" — i.e. both shapes are acceptable; the record doesn't
   yet say which the maintainers prefer for *test* isolation specifically (as opposed to the
   *todo-add subprocess* case `20319ab0` fixed).
3. **Failure #3 (package-cli.test.ts test 5):** not root-caused in this brief. Unknown whether it's
   the same TMPDIR mechanism (the dry-run workflow likely spawns its own subprocess tree and could
   inherit the same trap) or an unrelated regression. A spec/implementation step must reproduce it
   in isolation (`TMPDIR=/tmp node --import tsx --test packages/cezar/test/e2e/package-cli.test.ts`)
   before deciding the fix — this brief did not run tests per the standing "don't build or run
   without asking" instruction.
4. **Gate list scope:** the third acceptance criterion allows "or `.ai/agentic.config.json` stops
   listing a gate that cannot pass there" as a fallback — should any command be dropped, or is the
   expectation that all three (`npm test`, `npm run test:unit`, `npm run test:package`) become
   genuinely green on the prod box? The task title framing ("is 2152 tests red … independent of any
   change") and the acceptance criteria as a set read as "fix it," with config-removal only as a
   last resort per-command if a given failure turns out unfixable in scope.
5. Not found in the record: any prior discussion of React 19 + testing-library compatibility in
   this repo at all (`kb` search for "React 19 act testing-library upgrade" returned nothing
   on-topic), so this is a first-time decision, not one this brief can cite.

## What I could not find

- No KB entry or spec documents the ~41 "not a git repo" test failures directly (only the
  differently-shaped `20319ab0` todo-add incident).
- No prior root-cause analysis of `package-cli.test.ts` test 5's current failure reason.
- No existing decision on which `@testing-library/react`/React 19 act-compat fix path this repo
  prefers.
