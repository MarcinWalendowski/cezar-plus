# `npm test` is a validation gate an agent can never see green

**Status:** draft (2026-08-21)

Brief: `.ai/specs/briefs/2026-08-21-npm-test-validation-gate-red.md`

## TLDR

`npm test` (134 files / 2152 of 9526 tests, measured 2026-08-21 on `prod-host` at
`7e8f2938`, reproduced on untouched `main`) is red for two reasons, and both are cezar's
**own** agent runtime shooting its own gate: every agent session runs with `NODE_ENV=production`
standing in its environment, and every agent-run process gets `TMPDIR`/`TMP`/`TEMP` pointed at
`.ai/cezar/tmp/<runId>` **inside the checkout** (`agent-tmpdir.ts`, #785). Neither is a React 19
bug, a testing-library incompatibility, or a flaky test. `AGENTS.md` § Validation already
documents both as "traps" and gives a manual shell recipe that fixes them — the fix here is to
stop requiring an agent (or a human) to retype that recipe correctly every time, by baking it into
the three `package.json` scripts `.ai/agentic.config.json` actually lists: `test`, `test:unit`,
`test:package`. No dependency upgrade, no per-test-file patching at scale, no config removal.

## Problem

### Failure #1 (~1931 web tests): not a React 19 bug — `NODE_ENV=production` at test-run time

Read directly out of the installed packages in `/var/lib/cezar/loki-labs/cezar/node_modules`
(react 19.2.7, react-dom 19.2.7, `@testing-library/react` 16.3.2):

- `react/index.js` and `react-dom/index.js` both branch on `process.env.NODE_ENV === 'production'`
  at **require time** to pick `cjs/*.production.js` vs `cjs/*.development.js` — a plain runtime
  `if`, not a package.json `exports` condition.
- `react/cjs/react.production.js` has **no `exports.act`** at all (verified by grep: zero matches).
  `react/cjs/react.development.js` defines it (line 806).
- `@testing-library/react`'s `act-compat.js` picks its `act` implementation with
  `typeof React.act === 'function' ? React.act : DeprecatedReactTestUtils.act` — under the
  production build, `React.act` is `undefined`, so it falls back to
  `react-dom/test-utils` → `react-dom-test-utils.production.js`, whose own `act` shim is a
  deprecation-warning wrapper that itself just calls `React.act(callback)` — which is *also*
  `undefined` under the production build. Hence, exactly: **`TypeError: React.act is not a
  function`**, reproduced from source, not inference.

This is the identical symptom `AGENTS.md` § Validation trap 1 already names ("`NODE_ENV=production`
… the symptom is not 'missing module': it is `TypeError: React.act is not a function`"), and it
requires nothing more than `NODE_ENV` being anything other than `production` at the moment vitest's
worker process requires `react`/`react-dom` — devDependencies do not need to be missing (trap 1's
documented "npm ci installs zero devDependencies" framing is one *cause* of that env state, not the
only one). `NODE_ENV=production` is **structural** here, not incidental: it is set in every cezar
agent session right now (confirmed live in this very task's own shell — `env | grep NODE_ENV` →
`NODE_ENV=production`), consistent with `AGENTS.md`'s own note that "cezar's own agent sessions run
with it set." GitHub Actions' `ubuntu-latest` runner never sets it, which is why `.github/workflows/ci.yml`'s
identical `npm test` step (`ci.yml`, `verify` job) has never seen this.

No dependency version is implicated. `packages/web/package.json`'s `react`/`react-dom` ^19.2.7 and
`@testing-library/react` ^16.3.2 already handle React 19 correctly — 16.3.2's peer range is
`react: "^18.0.0 || ^19.0.0"` and its act-compat already prefers `React.act`. The brief's Open
Question 1 (pin a newer testing-library, or add a `setupFiles` shim) is answered: **neither is
needed.**

### Failure #2 (~41 server tests): `TMPDIR` pointed inside the repo, by cezar's own design

`packages/cezar/src/runs/agent-tmpdir.ts:45-47` (`agentTmpDir`) resolves every run's temp dir to
`<dataDir>/tmp/<runId>`; for an in-repo task `dataDir` is `.ai/cezar`, so
`agentTmpEnv()` (`agent-tmpdir.ts:130-144`) sets `TMPDIR=TEMP=TMP=<repo>/.ai/cezar/tmp/<runId>` —
**inside the git checkout under test.** This is `#785`'s deliberate design (disk-quota isolation
per run, documented at length in that file's own header comment) and is correct for the agent's
general-purpose Bash use; it is simply wrong for a git-detection test fixture.

An Explore pass confirmed there is no separate "bash step" spawn path in cezar: workflow steps are
only `agent`/`check` kind (`packages/cezar/src/workflows/types.ts:165`); `run-tests` is a **prompt**
telling the agent to run `npm test` etc. with its own Bash tool, and that Bash subprocess is spawned
through the same `buildChildEnv` as every other agent action, with `agentEnv()`
(`packages/cezar/src/workflows/run.ts:1035-1052`, spreading `agentTmpEnv()` last so it always wins)
supplying the in-repo `TMPDIR`. So `npm test`, run exactly as `.ai/agentic.config.json` and
`AGENTS.md` instruct, inherits the in-repo tmpdir with no code-level override anywhere.

`os.tmpdir()` (Node) reads `process.env.TMPDIR` **live, on every call** — not once at process
start — so any test that does `mkdtempSync(join(tmpdir(), prefix))` and then asserts the result is
**not** a git repo gets a directory whose upward `git rev-parse` walk finds the checkout's own
`.git` and flips the assertion. Confirmed failing sites (brief, `AGENTS.md` trap 4):
`workspace-parallel.test.ts:70-74,136`, `boot-root-isolation.test.ts:71-75`,
`postconditions.test.ts:166-173`, plus `knowledge/store.test.ts`, `catalog.test.ts`, `paths.test.ts`,
`server/workspace-reports-api.test.ts`, `server/project-context.test.ts`,
`server/knowledge-api.test.ts`. With `TMPDIR=/tmp` forced, `npm run test:unit` is 44/44 green
(brief measurement) — consistent with this being the entire server-side cause.

**Scale check, because it matters for the fix shape:** `grep -rl` for the
`mkdtempSync(...tmpdir()...)` pattern across `packages/cezar/src` and `packages/cezar/test` returns
**211 files.** Only the handful above assert git-repo-*detection* specifically (most of the 211 use
a scratch dir for unrelated reasons and never call anything git-aware, so they don't fail either
way) — but 211 is the number that rules out "patch every fixture builder" as the primary fix. A
harness-level environment correction is the only shape that scales.

### Failure #3 (`test:package` test 5): not yet independently confirmed, likely the same mechanism

`packages/cezar/test/e2e/package-cli.test.ts:14-15` opens with the identical
`mkdtemp(join(tmpdir(), 'cezar-package-e2e-'))` pattern, then `git init`s a **nested** fixture repo
(`fixtureRepo`, line 65-74) inside it and runs the packaged CLI's dry-run workflow against that
nested repo. If the outer `root` lands inside the real checkout (failure #2's exact mechanism), the
packaged CLI's own boot/worktree/git-detection logic is exercised against a nested-repo layout it
was never meant to see, which is a plausible way for "the dry-run workflow status is 'done' or
'review'" (line 92) to fail. This is a hypothesis, not a confirmed root cause — the brief did not
run it in isolation, and neither does this spec (per the standing "don't run without asking" rule).
Phase 3 below re-tests it **after** Phase 2 lands, before deciding whether it needs its own fix.

### Why this is a harness gap, not (only) a test-suite bug

`AGENTS.md` § Validation already documents traps 1, 2 and 4 (`NODE_ENV`, `CEZ_*` leakage, TMPDIR)
and gives a proven shell recipe (lines 270-276) — but it is **prose a human or agent has to
remember and retype correctly**, not something the gate commands do for themselves. The `run-tests`
workflow step's own prompt (`packages/cezar/src/workflows/types.ts:793-797`) already tells the agent
to "read AGENTS.md for environment traps" and names traps 1 and 2 explicitly — but **not trap 4**
(TMPDIR), which was only discovered and documented the same day this task was filed. That prompt is
advisory text embedded in a workflow definition; it cannot be enforced, it goes stale (as it already
has, missing trap 4), and it does nothing for anyone who runs `npm test` outside that one workflow
step — which is exactly what happened when this task's own 2152-red measurement was taken directly
on the box. `.ai/agentic.config.json` lists `npm test` as a command any tool is entitled to run
verbatim and trust; today it cannot be trusted verbatim.

## Solution

Move the scrub from prose into the commands themselves. A new shell wrapper,
`.ai/scripts/scrub-test-env.sh` (matching the existing `.ai/scripts/e2e.sh` /
`test-env-up.sh` convention), execs its arguments after:

1. Unsetting `NODE_ENV` (fixes failure #1 — forces the `react`/`react-dom` `require` branch back to
   the development build, where `act` exists).
2. Repointing `TMPDIR`/`TMP`/`TEMP` at a fresh directory under the real system temp root — computed
   the same way `AGENTS.md`'s own recipe does it (`/tmp/cez-gate-$$`), which is guaranteed outside
   any repo on this box — regardless of what the calling shell's `TMPDIR` was (fixes failure #2, and
   very likely #3 as a side effect).
3. Unsetting every `CEZ_*` variable except `CEZ_HANDOFF_FILE`/`CEZ_TASK_ID` (mirrors `AGENTS.md`
   trap 2's recipe) — not implicated in the measured 2152, but the wrapper is free real estate to
   close a second already-documented, already-recurring trap at the same time, so a future
   regression of that class doesn't get its own task.

`package.json` (root) and `packages/cezar/package.json` then call the real command **through** the
wrapper for exactly the three scripts `.ai/agentic.config.json` names — `test`, `test:unit`,
`test:package` — and nothing else. `test:watch`, `packages/web`'s own standalone `test`, and any
other script are untouched: this fix is scoped to the commands that are an agent-trusted contract,
not "every possible way to invoke vitest."

No dependency changes. No test file needs to change for failures #1 or #2 to go away.

## Architecture

Before (today):
```
agent session env (NODE_ENV=production, TMPDIR=<repo>/.ai/cezar/tmp/<runId>, CEZ_*)
  └─ Bash("npm test")                    ── inherits everything verbatim
       └─ vitest run                     ── react require()s the production build → act undefined
            └─ packages/web project      ── mkdtemp lands inside the repo → git-detection lies
```

After:
```
agent session env (NODE_ENV=production, TMPDIR=<repo>/…, CEZ_*)
  └─ Bash("npm test")
       └─ npm script: .ai/scripts/scrub-test-env.sh vitest run
            ├─ unset NODE_ENV, unset CEZ_* (except HANDOFF_FILE/TASK_ID)
            ├─ TMPDIR=TMP=TEMP=/tmp/cez-gate-$$ (mkdir -p; outside every repo on this box)
            └─ exec vitest run            ── inherits the corrected env, nothing else changes
```

The wrapper is a pure `exec`-through: same process tree shape, same exit code propagation, no new
dependency. It changes nothing about `#785`'s per-run `TMPDIR` isolation for the agent's *other*
Bash activity — only the environment of the process the wrapper directly launches is corrected.

## Phases

**Phase 1 — the wrapper.** Add `.ai/scripts/scrub-test-env.sh`:
```sh
#!/bin/sh
set -eu
scrub=$(env | sed -n 's/^\(CEZ_[A-Z0-9_]*\)=.*/\1/p' | grep -vxE 'CEZ_(HANDOFF_FILE|TASK_ID)')
tmp="/tmp/cez-gate-$$"
mkdir -p "$tmp"
trap 'rm -rf "$tmp"' EXIT
unset NODE_ENV
for v in $scrub; do unset "$v"; done
export TMPDIR="$tmp" TMP="$tmp" TEMP="$tmp"
exec "$@"
```
(POSIX `sh`, matching `e2e.sh`'s own shebang and this repo's Linux-only CI/prod targets — see
Risks.) No test yet depends on it.

**Phase 2 — wire the three gate commands through it.**
- Root `package.json:20`: `"test": "vitest run"` → `"test": ".ai/scripts/scrub-test-env.sh vitest run"`.
- `packages/cezar/package.json` `test:unit` and `test:package` (the scripts root's `npm run
  test:unit -w …` / `npm run test:package -w …` actually delegate to): wrap the `node --import tsx
  --test …` invocations the same way. Wrapping the leaf script is transparent to root's `-w`
  delegation — no root-script change needed for these two.
- `npm run build` and `npm run typecheck` are untouched — neither is implicated in the 2152 and
  neither should silently start depending on a scrubbed `TMPDIR`.

This alone should flip both failure #1 and #2 green, and plausibly #3 (Phase 3 confirms).

**Phase 3 — re-test `test:package` test 5, decide if it needs anything else.** Run `npm run
test:package` (ask first, per the standing rule) after Phase 2 lands. If test 5 now passes, close
the brief's Open Question 3 as "same mechanism, fixed for free." If it still fails, root-cause it in
isolation (`TMPDIR=/tmp node --import tsx --test packages/cezar/test/e2e/package-cli.test.ts`) as a
follow-up — out of scope for this spec's phases to pre-solve blind.

**Phase 4 (optional, recommended) — narrow defense-in-depth for the git-detection assertions.**
Apply the proven `20319ab0` pattern (`git init -q` in the fixture directory, which stops the upward
git-detection walk regardless of `$TMPDIR`) to the **specific ~9-12 files** listed under Failure #2
above that actually assert "not a git repo" — not the other ~200 files that merely use a scratch
dir. This is belt-and-suspenders: if Phase 1-2's wrapper is ever bypassed, removed, or misapplied to
a fourth new gate script, these specific assertions stay correct on their own. Not required to meet
the acceptance criteria (Phase 2 alone satisfies all three), and should not block shipping Phase
1-3.

**Phase 5 (docs) — correct the record in place, per this repo's own correction doctrine.**
- `AGENTS.md` § Validation: add a dated note that traps 1 and 4 no longer apply to `npm test` /
  `npm run test:unit` / `npm run test:package` specifically (self-scrubbing as of this spec's
  commit) — they still apply to any other invocation (`vitest run` directly, a single-file run, an
  IDE test runner), so the trap descriptions themselves stay, only the "you must do this by hand for
  the gate commands" framing is corrected.
- `packages/cezar/src/workflows/types.ts:793-797` (the `run-tests` step prompt): the NODE_ENV/CEZ_*
  reminder becomes moot for the three wrapped commands; trim it to cover only ad hoc invocations the
  agent might still make outside those three scripts, so the prompt doesn't keep telling agents to
  manually re-solve a problem the harness now solves for them.

## Data models

None. No schema, no persisted state, no API surface changes anywhere in this fix.

## API contracts

None.

## Risks

- **POSIX-only wrapper.** `.ai/scripts/scrub-test-env.sh` uses `sh`-isms (`$$`, `trap`, `sed -n`)
  that don't run under Windows `cmd.exe`. This repo's actual verified targets are `ubuntu-latest`
  CI and the Linux prod box (`prod-host`); `test:e2e` already delegates to a `sh` script with
  the same constraint. A contributor testing on Windows/macOS via a non-POSIX shell would need an
  equivalent, which this spec does not build — flagged, not solved, matching existing precedent.
- **The wrapper becomes a second thing that must not silently break.** If Phase 1's script itself
  has a bug (e.g., the `CEZ_*` grep pattern drifts as new `CEZ_` vars are added — `AGENTS.md`
  already flags this as trap 2's own failure mode, "do not enumerate, that list will be stale
  again"), the gate goes back to lying, now with one more layer between the failure and its cause.
  Mitigated by Phase 4's defense-in-depth for the git-detection subset, and by the wrapper doing
  `unset` on a live-computed prefix match (never a hardcoded list) exactly to avoid the staleness
  trap 2 already hit once.
- **`CEZ_HANDOFF_FILE`/`CEZ_TASK_ID` are deliberately preserved** so a test run inside an agent
  session can still report back to the handoff file if a future test wants to (none currently do) —
  keeping them is a no-op today and a safety margin, not a requirement.
- **Phase 3's outcome is genuinely unknown until it's run.** The spec does not claim failure #3 is
  solved by Phase 2 — only that it's the leading hypothesis, to be confirmed or refuted by actually
  running the gate once, with permission, after Phase 2 ships.
- **Scope discipline:** this fix intentionally does not touch `packages/web/package.json`'s own
  standalone `test`/`test:watch`, `packages/cezar/package.json`'s own `test`/`test:watch`, or `npm
  run build`/`npm run typecheck` — none are in `.ai/agentic.config.json`'s `validation.commands` and
  none were measured red. Widening the wrapper to them is a reasonable future follow-up, not part of
  this spec's acceptance criteria.

## Verification

1. **Reproduce the baseline (ask first).** `npm test` on the untouched tree, unscrubbed —
   confirm the reported 134 files / 2152 tests failed still holds before changing anything, so the
   "after" comparison is against a real number, not the brief's.
2. **Phase 1+2, automated.** After wiring the wrapper: `npm test` (root, via the new `test` script)
   reports `Test Files … passed` with 0 failed, and the saved log's exit marker is `EXIT=0`,
   matching the `run-tests` step's own existing convention (send output to a file, wait on the
   process, quote the exit marker — `types.ts:775-800`).
3. **`npm run test:unit`** (root → `packages/cezar` `test:unit`) reports 44/44 green (the count the
   brief already measured under a manually-scrubbed `TMPDIR=/tmp`), now with **no manual env
   override** — i.e. run it with the ambient agent-session environment exactly as-is, unscrubbed by
   the caller, and confirm the wrapper does the scrubbing itself.
4. **`npm run test:package`** — Phase 3's re-test. Green end-to-end, or a follow-up is filed with
   the isolated root-cause if test 5 still fails.
5. **Negative control.** Temporarily invoke the pre-Phase-2 form (`vitest run` directly, bypassing
   the wrapper) inside an agent session and confirm it **still fails** the same way — proves the fix
   is the wrapper, not an incidental change to `node_modules` or the lockfile from `npm ci` along the
   way.
6. **`.ai/agentic.config.json`'s `validation.commands`** needs no edit if 1-4 are green — the
   acceptance criteria's "or stop listing a gate that cannot pass" fallback is not exercised.
7. **CI parity.** `.github/workflows/ci.yml`'s `verify` job runs the identical three commands
   unchanged; confirm a CI run post-merge stays green (the wrapper is a no-op there — `NODE_ENV` and
   `CEZ_*` are already unset on `ubuntu-latest`, and `TMPDIR` is already outside any checked-out
   repo), demonstrating the fix closes the box/CI gap without disturbing CI itself.
