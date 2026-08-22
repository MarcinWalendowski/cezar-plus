# `npm test` validation gate is red — this task is already mid-flight, not fresh ground

- Date: 2026-08-22
- Category: test infra / CI-agent parity — continuation brief
- Priority signal: high, unchanged from the original brief (`.ai/agentic.config.json` lists a gate
  that cannot pass).
- Routing: this step ("gather the record") found that steps 2-5 of what looks like the SAME
  8-step chain already ran, on this same worktree/branch, before this invocation. The next step
  must pick up from that state, not restart the investigation.

## The one fact that changes everything about how to run the rest of this chain

This is task `f2012c07`, branch `cez/f2012c07`, worktree
`/var/lib/cezar/loki-labs/cezar/.ai/cezar/worktrees/f2012c07-f201-4f17-804a-e8ff7fa1ffd8`. Its own
`$CEZ_HANDOFF_FILE` already contains a full progress log dated 2026-08-21T23:03 through
2026-08-22T00:23:40, recording (in order): step "context" done → step "spec" done (3 drafts) →
step "review-spec" done, round 3, **verdict PASS** → step "implement" done. That is 4-5 steps of
an apparently-identical prior chain run, already executed, on this exact branch, before the
current "step 1 of 8 — gather the record" instruction was issued for this turn.

**And the working tree shows real, matching, unstaged code changes** — this is not just a log
artifact:

```
git diff --stat (HEAD 3444f1c8, nothing committed on this branch yet)
 .ai/specs/2026-08-21-npm-test-gate-environment-scrub.md | 568 ++++++++ (new file)
 AGENTS.md                                               |  26 +
 packages/cezar/src/core/agent-env.test.ts               |  15 +
 packages/cezar/src/workflows/agent-profile-wiring.test.ts |  1 +
 packages/cezar/src/workflows/run.ts                      |  11 +
 packages/cezar/src/workflows/types.ts                    |  11 +-
 packages/cezar/vitest.setup.ts                           |  33 ++
 packages/web/src/design-guardian.test.ts                 |   1 +
 packages/web/src/vite-config.test.ts                     |   1 +
 packages/web/vitest.config.ts                            |   7 +
```

Every one of those diffs matches, line for line, what the spec (below) describes as its four
"immediate" fixes. **Nothing is committed** — `git rev-parse HEAD` = `3444f1c8` = the merge-base
with `origin/main`, i.e. this branch has zero commits of its own; all of the above is working-tree
state only.

The one thing that doesn't add up: the handoff's own log lines for the "implement" step (and
earlier "spec" steps) are literally `mock: implemented the change (dry run)`, three times, each
followed immediately by a real `step "X" complete — status=done`. Whether that string is generic
scaffolding logged for every step regardless of what actually ran, or whether "implement" really
did run as a dry-run mock and something else wrote these diffs, **could not be determined from the
record alone** — flagging it rather than guessing. What's not ambiguous: the diffs are real, on
disk, in this worktree, right now.

**Open process question for whoever designed this chain (not answerable by reading the repo):**
is this turn a genuine restart of the whole 8-step workflow from step 1 (in which case steps 2-5
already did the work and the smart move is to verify + resume from around step 5/6, not redo
spec-writing), or is the "step 1 of 8" framing itself stale/mismatched against a chain that's
actually further along? This brief cannot resolve that; it only reports what's on disk so the next
step doesn't silently redo 90 minutes of already-done, already-reviewed work.

## The problem, in this repository's own terms (unchanged from the original finding)

Measured 2026-08-21 on `prod-host` at `7e8f2938`, reproduced on untouched `main`: root
`npm test` (`vitest run`) — 134 files / 2152 of 9526 tests failed. `.ai/agentic.config.json`
(`validation.commands`) lists `npm test`, `npm run test:unit`, `npm run test:package` (and
`typecheck`/`build`) as the gates an agent must pass. A gate that can never go green trains an
agent to ignore it.

## What the record already decided — with citations

The **spec already exists, already written, already reviewed to a PASS verdict**, in this
worktree: `.ai/specs/2026-08-21-npm-test-gate-environment-scrub.md` (568 lines, currently
unstaged/untracked — `git status` reports it as a new file). Per the handoff's round-3 log entry,
every citation in this 3rd draft was re-verified against the live tree and holds. Its own status
line still reads "draft (2026-08-22, 3rd draft)" — **the spec file's own header was never updated
to reflect the PASS verdict the review step recorded** in the handoff; that's a loose end for
whichever step edits the spec next.

The spec identifies **five** causes, not the two the task description names, all measured
empirically this round (not inferred):

1. **~1931 web tests** — `NODE_ENV=production` is standing in every cezar agent session (confirmed
   live: `env | grep NODE_ENV` → `production` in this task's own shell per the spec's Cause 1).
   React's production build (`react/cjs/react.production.js`) exports no `act`, and
   `@testing-library/react`'s act-compat fallback chain throws `TypeError: React.act is not a
   function`. **Not** a React-19/testing-library incompatibility (round 1 of this spec assumed
   that; round 2's grounding disproved it by reading the actual installed package source). Fix
   already in the working tree: `packages/web/vitest.config.ts` — `test.env.NODE_ENV = ''`.
2. **~41 server tests** — `agent-tmpdir.ts:45-47` (`agentTmpDir`) resolves every run's temp dir
   inside the checkout (`.ai/cezar/tmp/<runId>`); `run.ts` (~line 1035-1052, `agentEnv()`) wires it
   into every spawned process, `npm test` included. Tests asserting "this dir is NOT a git repo"
   (`postconditions.test.ts:166`, `workspace-parallel.test.ts:70-74,136`,
   `boot-root-isolation.test.ts:71-75`, + others) fail because `os.tmpdir()` honors the poisoned
   `$TMPDIR`. Fix already in the working tree: `packages/cezar/vitest.setup.ts` now
   `mkdtempSync`s a fresh dir under `realpathSync('/tmp')` and points `TMPDIR`/`TMP`/`TEMP` there,
   before `sandboxHome` is created.
3. **~26 server tests, newly measured this round** — ambient `CEZ_*` cockpit-session knobs
   (`CEZ_ACCOUNT_USAGE`, `CEZ_KB`, `CEZ_OIDC_*`, etc.) leak into every agent-spawned `npm test`
   because `buildChildEnv` allows `CEZ_*` wholesale by design (`agent-env.ts:376`), and nothing
   scrubbed it before this round. Reproduced directly: `health-forge.test.ts` goes 20/20 → 7 failed
   with only `CEZ_ACCOUNT_USAGE=1` ambient. This is `AGENTS.md`'s own already-documented "trap 2,"
   never previously wired to a fix. Fix already in the working tree: the same
   `packages/cezar/vitest.setup.ts` change deletes every `CEZ_*` key except
   `CEZ_HANDOFF_FILE`/`CEZ_TASK_ID` before any suite runs.
4. **2 test files, newly discovered this round, unrelated to 1-3** — `design-guardian.test.ts` and
   `vite-config.test.ts` import `node:fs`/`node:path`/`node:url` at module scope but inherit the
   `web` project's `jsdom` environment, which cannot resolve `node:` builtins — both fail to load
   entirely (0 tests each), reproducing on a clean `git stash`. Fix already in the working tree: a
   `// @vitest-environment node` docblock added to both files.
5. **`test:package` test 5, unconfirmed this round** — `package-cli.test.ts` test 5 ("the release
   tarball installs and runs the dry-run CLI workflow") fails on both branch and untouched `main`,
   per the original task description. The spec explicitly defers this ("Cause 5, unconfirmed") —
   it was **not measured or fixed** in any of the three spec drafts, because running
   `test:package` packs and installs a tarball, which the standing "don't build or run without
   asking" rule blocks without explicit permission. **This is still open** — nothing in the
   current working tree touches it.

**A durable (not just vitest-layer) fix also landed**: `run.ts`'s `agentEnv()` now sets
`NODE_ENV: ''` unconditionally in every agent-spawned process env (not gated by any `CEZ_*` flag),
which reaches `npm ci` under `NODE_ENV=production` too — but per the diff's own comment and
`AGENTS.md`'s new correction note, this only takes effect **after `cezar.service` is redeployed and
restarted**; it cannot be observed in-run on this box yet. Matching test coverage was added:
`agent-env.test.ts` (empty-string override wins over host value) and
`agent-profile-wiring.test.ts` (added `'NODE_ENV'` to the expected zero-config key list).

**`AGENTS.md` was corrected in place** (2026-08-22 note after its existing § Validation traps 1/2/4
recipe) saying the three `.ai/agentic.config.json`-listed commands now scrub themselves, and the
manual recipe is still needed only for invocations those three don't cover. `types.ts`'s
`SPEC_TO_DEPLOY_WORKFLOW` step-prompt text was also updated to point at the new self-scrubbing
behavior instead of telling every agent to re-read the manual trap recipe.

**Acceptance criterion 3 is NOT met by this spec, and the spec says so itself (non-blocking nit N1
from round 3 review, still unresolved in the diffs).** The spec's own "measured result of applying
all four fixes" (TLDR, adversarial synthetic environment) is **2 test files / 1 failure each**
residual — `knowledge/catalog.test.ts` C18 (a host-speed budget `AGENTS.md` already documents as a
deliberately-accepted permanent red on this box) and one `auto-resume.test.ts` concurrency flake
(same class as the already-documented `add-project-dialog.test.tsx` flake, 22/22 clean in
isolation). So on this box, `npm test` **still exits nonzero** even after every fix in this spec is
applied. The spec's framing is "redefine what counts as green" (residual = already-accepted
exceptions) rather than literally satisfying either branch criterion 3 offers ("green" or "the gate
list stops naming an unpassable command"). Whoever runs the verification/commit step next must
**report this plainly** — per this repo's own "definition of done" rule, gates green is necessary
but not sufficient, and rounding "2 residual failures, both pre-accepted" up to "green" would be
exactly the kind of overclaim that rule exists to prevent.

**No duplicate work in flight elsewhere.** `cezar todo list` → empty. `gh issue list` / `gh pr
list` → both empty (no open issues or PRs in this repo currently). `origin/main` has moved past
this branch's base (3 newer commits: `6fdbe35e`, `6f3db24a`, `5d884ce1`) but on an unrelated topic
— release-staging excludes for worktrees/tmp scratch, not this task.

**Precedent this spec explicitly builds on and distinguishes itself from:**
`kb notion-b2a2f1953d58` / `kb notion-912e1e001bcc` (the "Ship it" tasks incident — same
TMPDIR-inside-repo mechanism, different manifestation: a subprocess piping `process.env`, fixed via
`git init -q` in commit `20319ab0`). That fix does not cover this task's failures (they assert
git-detection directly, not via a subprocess side effect) — this spec's `vitest.setup.ts` scrub is
the actual fix for this case.

## Code map (confirmed against the live tree this round)

| Concern | File:line | State |
| --- | --- | --- |
| Web test env fix | `packages/web/vitest.config.ts` (`test.env.NODE_ENV`) | in working tree, unstaged |
| Server env scrub (CEZ_* + TMPDIR) | `packages/cezar/vitest.setup.ts` (top of file, before `sandboxHome`) | in working tree, unstaged |
| Durable agent-env fix | `packages/cezar/src/workflows/run.ts` `agentEnv()` ~line 1035-1052 | in working tree, unstaged; needs redeploy+restart to take effect |
| Zero-config key-list doc/test | `run.ts` doc comment ~line 1013; `agent-profile-wiring.test.ts:82-89` (6-key list, now includes `NODE_ENV`) | in working tree, unstaged |
| Least-privilege env test | `packages/cezar/src/core/agent-env.test.ts` (~line 124-138) | in working tree, unstaged |
| jsdom/node: fix | `packages/web/src/design-guardian.test.ts`, `packages/web/src/vite-config.test.ts` (`// @vitest-environment node`) | in working tree, unstaged |
| Doc corrections | `AGENTS.md` (two new "Corrected 2026-08-22" notes) | in working tree, unstaged |
| Workflow step-prompt text | `packages/cezar/src/workflows/types.ts` ~line 790-802 | in working tree, unstaged |
| Full spec | `.ai/specs/2026-08-21-npm-test-gate-environment-scrub.md` | in working tree, untracked; header still says "draft" despite round-3 PASS |
| Original brief | written by a prior step, but landed in the **main checkout**
  (`/var/lib/cezar/loki-labs/cezar/.ai/specs/briefs/2026-08-21-npm-test-validation-gate-red.md`),
  **not this worktree** — a path bug the spec's own resume notes already caught and describe (see
  handoff, 3rd-draft entry) | exists, wrong location, not this task's concern to move |
| Still unaddressed | `packages/cezar/test/e2e/package-cli.test.ts` test 5 ("Cause 5") — no fix, no re-test, permission for the packaged run not yet asked for in this session | open |
| Still unaddressed | Spec header status line, `agentic.config.json` (nothing changed there — still lists all 5 commands verbatim) | open |
| Not yet done at all | **Nothing on this branch is committed.** No `npm test`/`typecheck`/`build` run has been executed *in this turn* to confirm the diffs actually produce the claimed residual-2 result — that measurement is claimed by the spec's own prior draft-writing step, not verified fresh here (this step is read-only, per its own instructions) | open |

## Open questions the next step(s) must settle

1. **Resume vs. restart** (see top section) — does this chain's step numbering already know steps
   2-5 ran, or does the framing assume a fresh start? If fresh, is redoing spec/review wasted work
   given round 3 already passed, or does it need re-review because nothing was committed?
2. **How to report acceptance criterion 3.** The spec does not literally satisfy either branch;
   say so plainly (2 pre-existing, pre-accepted residual failures: C18 host-speed budget,
   `auto-resume.test.ts` flake) rather than claiming "green," per this repo's own definition-of-done
   rule and per the round-3 reviewer's own non-blocking nit N1.
3. **Cause 5 (`test:package` test 5)** — still needs reproduction and root-cause; requires
   permission to run a build/pack/install cycle, which no step so far has asked for or been granted
   in-session.
4. **The spec's own header** says "draft" — does the next step correct it to reflect the recorded
   PASS verdict before or as part of committing?
5. **Follow-up filing** — round-3 review flagged (nit N1) that the C18 host-speed budget deserves
   its own tracked follow-up (a per-host relative budget) rather than staying an silently-accepted
   permanent red; no todo/issue for that exists yet (`cezar todo list` is empty).

## What could not be determined in this step

- Whether the "mock: implemented the change (dry run)" log lines mean the diffs were produced by a
  simulated step rather than a genuine one (the diffs are real and on-disk either way).
- Whether `npm test`/`test:unit`/`build`/`typecheck` currently pass on this exact working tree,
  right now — no test was run this step (read-only by instruction); the "2 residual failures"
  figure is what the spec's prior draft-writing step claims to have measured, not something this
  step re-verified.
