# `npm test` validation gate — spec is written and reviewed PASS; two new facts this round change what "resume" means

- Date: 2026-08-22
- Category: test infra / CI-agent parity — continuation brief (third brief on this task; supersedes
  nothing, adds two facts neither predecessor had)
- Priority signal: high, unchanged (`.ai/agentic.config.json` lists a gate that cannot pass).
- Routing: this is another "step 1 of 8 — gather the record" invocation on the SAME task
  (`f2012c07`, branch `cez/f2012c07`). The chain has already run past this point at least once
  before (see prior briefs, both cited below) and is materially further along than either of them
  captured. Read this brief, not the code from scratch — but verify the two new findings below
  before acting on the residual-failure count either predecessor cites.

## Read these first — this brief only adds to them

1. `.ai/specs/briefs/2026-08-22-npm-test-gate-resume-status.md` (same worktree) — the fullest
   account of the spec's five causes, the code map, and the "is this a restart or a stale framing"
   question. Also indexed in the KB corpus as `specs-39e79ea43be9`.
2. `.ai/specs/2026-08-21-npm-test-gate-environment-scrub.md` (568→~830 lines now; grew since the
   prior brief measured it) — the spec itself, reviewed to **round 6, verdict PASS**, per this
   task's own `$CEZ_HANDOFF_FILE` (resume note: *"2026-08-22: Spec REVIEWED AND PASSED (round
   6)... Next step implements... Phases 1a-4 are already applied on disk; the only work left is
   Phase 6's two doc edits... Then Phase 5 (npm run test:package, ask first)."*). The file's own
   `**Status:**` header still says "draft, round 5" — **this is not stale/wrong**, it is round
   numbering for spec *drafts*; round 6 was a review pass over the round-5 draft that passed
   without requiring a new draft, so the header correctly reflects the last-written draft. Not a
   defect, just a naming trap for whoever reads only the header.
3. KB `specs-cb279cda3c66` — an older indexed snapshot of the spec (round-5-era body), same
   document lineage as #2.

## What's new since the last brief was written (both facts measured fresh this step)

### 1. This worktree's `node_modules` is currently empty — not "missing a few binaries," empty

```
$ ls node_modules            # only .vite/ and .vite-temp/ cache dirs, zero packages
$ ls node_modules/.bin       # No such file or directory
$ stat node_modules          # Birth: 2026-08-22 00:23:11 — created empty, never populated
```

No `vitest`, no `react-dom`, no `@testing-library/*` anywhere under this worktree's `node_modules`
(root-level; this repo hoists to root, confirmed nothing under
`packages/cezar/node_modules/.bin` either). `package-lock.json` exists (23:02 UTC, 309KB) but
nothing has been installed from it in this checkout. **Ambient `NODE_ENV=production` is confirmed
standing right now** (`env | grep NODE_ENV` → `production`) — the exact condition AGENTS.md's own
trap 1 says makes `npm ci` install zero devDependencies. The durable fix for this
(`run.ts` `agentEnv()` → `NODE_ENV: ''`, confirmed applied at `packages/cezar/src/workflows/run.ts:1051`)
only reaches processes spawned by a **redeployed, restarted** `cezar.service` — it cannot be
observed in this already-running task, so **a plain `npm ci` run from inside this exact step,
right now, would reproduce trap 1 and leave devDependencies uninstalled again.**

This matters concretely for whatever the next step does: neither "run `npm run test:package`
(Phase 5, with permission)" nor "re-verify the full gate one more time before committing" can
happen without an `npm ci` first, and that `npm ci` needs to be run with `NODE_ENV` explicitly
scrubbed (`env -u NODE_ENV npm ci`, per AGENTS.md's existing manual recipe) or it will silently
reproduce the exact bug this spec fixes, in the one command this spec's scrub does not (and by
design cannot, per its own Scope-discipline note) reach.

### 2. A full self-check `npm test` DID run in this worktree ~25 minutes ago — and its residual doesn't match what the spec predicts

`/tmp/cez-selfcheck/npm-test-full.log` (start 01:20:50, duration 158.72s, finished 01:23) shows:

```
Test Files  2 failed | 516 passed (518)
     Tests  2 failed | 9552 passed | 1 skipped (9555)
```

The two failures:
- `src/knowledge/catalog.test.ts` C18 — `69.42 ms/MiB` vs. the `< 40` budget. Matches the
  spec's own named, already-accepted permanent host-speed residual (AGENTS.md, "trap 3"). Not new.
- `src/workspace/home-safety.test.ts` > *"survives a real, timing-out suite run: the home registry
  is never created"* — **this is NOT the `auto-resume.test.ts` flake the spec's Verification
  section and AGENTS.md's new "second known live flake" note both name as the expected second
  residual.** It fails with `spawnSync .../node_modules/.bin/vitest ENOENT` — i.e. the test's own
  nested `vitest run` (it deliberately spawns a second vitest process against
  `packages/cezar/src/workspace/projects-cli.test.ts` to prove `npm test` never touches a real
  user's `~/.cezar`, see `home-safety.test.ts:100-130`) couldn't find the vitest binary to spawn.

Given finding #1 (node_modules is empty right now), the most likely explanation is that
`node_modules` was already broken (or became broken) at the moment this self-check ran — either
it was never fully installed to begin with when this step invoked it, or something on this shared
box removed/emptied it in the ~25 minutes between then and now (this box has 15 other task
worktrees active under `.ai/cezar/worktrees/` as of this reading, and the prior spec draft itself
already documents one instance of cross-session interference on this same box mid-verification —
see the spec's own Risks section, "`531ab96d`" incident). **Which of those it is could not be
determined in this read-only step** — it's the one open question in this brief that isn't just
"do the deferred work," and it's worth settling before trusting the residual-2 claim, because a
missing test binary failing a *different* test than predicted is not confirmation of the spec's
own claimed result, even though the total failure *count* (2) happens to match.

## What's unchanged from the prior brief (confirmed again this round, not re-derived)

- **Code diffs match spec Phases 1a/1b/2/3/4/6 exactly**, re-checked via `git diff` this step:
  `packages/cezar/vitest.setup.ts` (CEZ_* scrub + TMPDIR-to-real-/tmp scrub, with `scrubbedTmp`
  cleanup in the `afterAll`), `packages/cezar/src/workflows/run.ts:1013-1051` (`NODE_ENV: ''` +
  corrected doc comment), `packages/web/vitest.config.ts` (`test.env.NODE_ENV = ''`),
  `packages/cezar/src/core/agent-env.test.ts` + `agent-profile-wiring.test.ts` (matching test
  coverage, 7-key zero-config list now includes `NODE_ENV`), `AGENTS.md:278-306` and
  `packages/cezar/src/workflows/types.ts:790-802` (Phase 6 doc corrections, verified this round to
  carry the *correct*, scoped-to-`server`-project wording — not the round-3 text that falsely
  claimed all three/five `agentic.config.json` commands self-scrub).
- **Nothing is committed.** `git rev-parse HEAD` = `3444f1c8`, the branch's own merge-base with
  `origin/main` — zero commits on `cez/f2012c07`.
- **Phase 5 (`npm run test:package`, Cause 5 / the pre-existing "test 5" failure) is still
  untouched** — no fix, no re-test, and (see finding #1) it cannot even be attempted right now
  without an `npm ci` first.
- **No duplicate work in flight**: `cezar todo list` → empty. `gh issue list` / `gh pr list` →
  both empty.
- **No follow-up filed** for the C18 host-speed budget (round-3 review's nit N1, still open).

## Open questions the next step must settle

1. **Is the `home-safety.test.ts` failure real, or an artifact of a broken `node_modules`?**
   Before treating "2 residual failures" as confirmation of the spec's predicted result, either
   re-run `npm test` after a clean, correctly-scrubbed `npm ci` (permission needed — this is a
   build/install action) and see whether `auto-resume.test.ts` or `home-safety.test.ts` is the
   second failure, or explain why the ENOENT is expected/harmless. Don't silently substitute one
   for the other in a final report.
2. **`npm ci` itself needs to be run with `NODE_ENV` unset**, per AGENTS.md's existing manual
   recipe (`env -u NODE_ENV ... npm ci`) — the durable `run.ts` fix for this doesn't reach an
   in-flight task. Confirm this is what actually happens before reporting any result from a fresh
   install in this worktree.
3. **Phase 5 / Cause 5** (`test:package` test 5, "the release tarball installs and runs the
   dry-run CLI workflow") — still needs permission to run, then reproduction, then either a fix or
   an honest "unresolved, filed as X" in the final report.
4. **How to report acceptance criterion 3.** Neither branch is literally satisfied (see both
   priors); state the actual residual plainly once question 1 is resolved, rather than rounding up.
5. **File the C18 follow-up** (a per-host relative budget, not a fixed `40 ms/MiB`) — flagged
   three review rounds running, never filed.
6. **Whether/when to correct the spec's own header** from "draft, round 5" to something that
   reads as final/PASS before this branch commits — cosmetic, not blocking, but the "keep the
   record straight" convention this repo follows says a stale-looking status invites the next
   reader to re-review work that already passed.

## What could not be determined in this step

- Whether `node_modules` was already broken when the 01:20 self-check started, or was emptied
  afterward by something else on this shared box. No process log or timestamp evidence settles it
  either way from inside this read-only step.
- Whether a fresh, correctly-scrubbed `npm ci` + `npm test` right now would reproduce exactly the
  spec's claimed "C18 + one flake" residual, or something else — not run this step, per its
  read-only instruction and the standing "don't build or run without asking" rule.
