# Brief: `agent-profile-wiring.test.ts` "adds NOTHING for the default account" — root cause is NOT what the handoff says

**Task id:** f3ab054c-3a98-4257-a031-e371decfa01d
**Step:** 1/8 — gather the record only. No spec, no code, no test run in this file.

## The problem, in this repository's own terms

`packages/cezar/src/workflows/agent-profile-wiring.test.ts:82` — the test `'adds NOTHING for
the default account — the zero-config env is untouched'` asserts that
`agentEnvForStep(runId, 'claude')` on a fresh run returns **exactly** these six env keys:
`CEZ_HANDOFF_FILE, CEZ_TASK_ID, CEZ_TODOS_FILE, TEMP, TMP, TMPDIR`.

The handoff task claims this fails on HEAD because "commit `63de653c` added `CEZ_KB_ROOTS` and
`CEZ_KB_WRITE_FILE` to that env (`run.ts:1006`, unconditional with `CEZ_KB` off — they are set to
empty strings)". **I verified this claim against the actual commit and it is wrong on every
specific**, and the real cause is a well-understood, already-partially-fixed environment-leak
problem, not a design gap. Details below with citations; a spec should be written against the
corrected diagnosis, not the handoff's.

## What I verified, and where the handoff's diagnosis breaks down

1. **Commit `63de653c` never touches `run.ts` or this test file.** `git show --stat 63de653c`
   lists 15 files (tasks-page grouping, `todoTaskText`, knowledge CLI wiring, knowledge
   `paths.ts`) — no `workflows/run.ts`, no `agent-profile-wiring.test.ts`. `git log --oneline
   63de653c..HEAD -- packages/cezar/src/workflows/run.ts` and the reverse both confirm it.

2. **The actual code that adds `CEZ_KB_ROOTS`/`CEZ_KB_WRITE_FILE` is conditional, not
   unconditional**, and was written by a different, earlier commit:
   `git blame -L 1076,1093 packages/cezar/src/workflows/run.ts` → `65eef6d25` (2026-08-06).
   The real code, `run.ts:1081-1092` (HEAD):
   ```ts
   return {
     CEZ_HANDOFF_FILE: handoffPath(this.dataDir, runId),
     CEZ_TASK_ID: runId,
     CEZ_TODOS_FILE: generateFollowups ? todosPath(this.dataDir) : '',
     ...(knowledge.enabled
       ? { CEZ_KB_ROOTS: ..., CEZ_KB_WRITE_FILE: ... }
       : {}),
     ...agentTmpEnv(this.dataDir, runId),
   };
   ```
   `knowledge.enabled` is `kbEnabled = process.env.CEZ_KB === '1'` (`run.ts:1127`, inside
   `agentEnvForStep`). **With the flag off, the two keys are absent, not empty strings** — the
   opposite of what the handoff asserts.

3. **This was a deliberate, already-documented design decision**, not an open question. The
   doc comment directly above (`run.ts:1042-1075`) is an entire paragraph arguing exactly the
   "add-empty vs. omit" question the task's acceptance criteria asks a spec to settle, and
   resolves it: `CEZ_KB_ROOTS`/`CEZ_KB_WRITE_FILE` must be **absent** when the flag is off, to
   satisfy "the flag-off byte-identity requirement in `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md`"
   (that PLAN's own D4 row, read directly: *"Unset means the feature does not exist: no index
   built, no nav item, no prompt bytes, no background timer"* — `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md:36`).
   `.env.example:394-398` documents the same contract for operators. So acceptance criterion 2 as
   currently worded ("the fix decides deliberately...") has already been decided, in writing, by
   a prior session — a spec here should cite that decision, not re-open it.

## What actually makes the test fail (verified live in this environment)

This agent's own process environment — the one running this very task — has:
```
CEZ_KB=1
CEZ_KB_ROOTS=/var/lib/cezar/loki-labs/cezar/.ai/cezar/knowledge:...:/var/lib/cezar/loki-labs/notion-export
CEZ_KB_WRITE_FILE=/var/lib/cezar/loki-labs/cezar/.ai/cezar/runs/f3ab054c-....knowledge.ndjson
```
(`env | grep CEZ_KB`, checked directly, not inferred). This is cezar **dogfooding itself**: this
task's own agent step was spawned by a cezar server that has knowledge indexing on for this
workspace, via exactly the `agentEnv()` code path under test. Since `agentEnvForStep` reads
`process.env.CEZ_KB` **live**, and the test never saves/clears/restores `CEZ_KB` (it does
save/restore `CEZ_HOME` in `beforeEach`/`afterEach`, `agent-profile-wiring.test.ts:23,44-46`, but
has no equivalent for `CEZ_KB`), running this test inside a shell that has ambient `CEZ_KB=1`
(such as this very dogfooding session) makes `knowledge.enabled` true and the two extra keys
appear — failing the exact-match assertion. Outside such a shell (plain `CEZ_KB` unset) the test
already passes today, which is consistent with the handoff's own note that it "still fails … with
both vars unset in the parent shell" — that note checked the wrong variable; `CEZ_KB` itself,
not `CEZ_KB_ROOTS`/`CEZ_KB_WRITE_FILE`, is what `agentEnvForStep` reads.

## This is a known bug class, and it is already half-fixed on `origin/main` — not yet on this branch

`cez kb search` and `git log` turned up a directly-on-point, very recent fix for exactly this
failure mode (ambient `CEZ_*` vars from cezar's own agent runtime leaking into cezar's own test
run): spec `.ai/specs/2026-08-21-npm-test-gate-environment-scrub.md` (KB `specs-cb279cda3c66`),
implemented in commit `1c225e7e` ("fix: npm test gate scrubs its own environment instead of lying
red"), marked shipped in `a97e1427`. That commit adds, to `packages/cezar/vitest.setup.ts`:
```ts
// AGENTS.md trap 2: ... live-computed, not enumerated.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('CEZ_') && key !== 'CEZ_HANDOFF_FILE' && key !== 'CEZ_TASK_ID') {
    delete process.env[key]
  }
}
```
This scrubs `CEZ_KB` (and everything else `CEZ_*`) before any suite runs, in every worker — which
removes the exact contamination path described above. **The same commit also touches this exact
test file**: it adds `NODE_ENV: ''` unconditionally to `agentEnv()` (a separate, unrelated fix —
pinning `NODE_ENV` for spawned agent processes) and updates this test's expected key list to add
`'NODE_ENV'` (`agent-profile-wiring.test.ts` diff in `1c225e7e`: `+ 'NODE_ENV',` after
`'CEZ_TODOS_FILE'`).

**Critically, `1c225e7e` is not an ancestor of this task's branch.** `git merge-base --is-ancestor
1c225e7e HEAD` → not an ancestor; merge-base of `HEAD` (`c73c8a2d`, branch `cez/f3ab054c`) and
`origin/main` (`7ad35ad8`) is `3444f1c8`, twelve commits back. `origin/main` is currently ahead of
this branch by (among others) `1c225e7e` and `a97e1427`. This repo's own established pattern
(visible repeatedly in `git log`: "merge: origin/main (X) into cez/Y before landing the Z fix")
is to merge `origin/main` into the task branch before landing a fix — that merge alone would pull
in the `vitest.setup.ts` scrub and the matching `NODE_ENV` test-list update.

## Code actually involved

| What | Where |
|---|---|
| The failing assertion | `packages/cezar/src/workflows/agent-profile-wiring.test.ts:82-96` |
| The env-building method under test | `packages/cezar/src/workflows/run.ts:1076-1093` (`agentEnv`), `:1117-1140` (`agentEnvForStep`) |
| The flag read | `run.ts:1127` — `process.env.CEZ_KB === '1'`, live, no test isolation |
| The prior design decision (already resolved) | `run.ts:1042-1075` doc comment; `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md:36` (D4); `.env.example:394-398` |
| The generic fix for this bug class (on `origin/main`, not this branch) | `packages/cezar/vitest.setup.ts` (added by `1c225e7e`) |
| The same commit's unrelated but overlapping edit to this test | `1c225e7e`'s diff to `agent-profile-wiring.test.ts` (adds `'NODE_ENV'` to the expected list) |
| Existing precedent for CEZ_KB test isolation elsewhere | `packages/cezar/src/server/boot-project-stores.test.ts:40,54` (save/restore `process.env.CEZ_KB`); `workspace-reports-api.test.ts`, `workspace-knowledge-routes.test.ts` (set/delete per test) |

## Prior decisions this would contradict if not accounted for

- Re-litigating "should `CEZ_KB_ROOTS`/`CEZ_KB_WRITE_FILE` be omitted when off" would contradict
  the already-recorded decision in `run.ts:1042-1075` / PLAN.md D4 — a new spec should cite it,
  not redecide it.
- Fixing this by hand-patching `agentEnv()` or hand-editing just this one test's expected list
  (without merging `origin/main`) would diverge from the generic scrub mechanism already chosen
  and shipped for this exact bug class (`1c225e7e`), producing a narrower, one-off fix that the
  next merge from `origin/main` would then conflict with or duplicate.

## Open questions a spec will have to settle

1. **Does merging `origin/main` into this branch make the test pass with zero further code
   changes?** Plausible from the diff (the scrub removes the `CEZ_KB` contamination, and the
   `NODE_ENV` key addition is already paired with the test-list update), but **not verified** —
   no test was run in this step (per the "don't build or run without asking" standing rule for
   a gather-only step). The next step should merge `origin/main` and then actually run
   `npx vitest run packages/cezar/src/workflows/agent-profile-wiring.test.ts` to confirm before
   deciding the fix needs any further diff at all.
2. **If, after merging, the test is still not fully green** (e.g. some other ambient `CEZ_*` var
   this box sets is exempted by the scrub, or a fixture ordering issue), does the fix add
   per-test `CEZ_KB` save/restore to this specific test file too (belt-and-suspenders, matching
   `boot-project-stores.test.ts`'s existing pattern), or is the global `vitest.setup.ts` scrub
   considered sufficient on its own?
3. **Scope of the merge**: pulling in `origin/main` at `7ad35ad8` brings in unrelated commits
   (server-deploy dry-run flag, run-tests effort-ceiling work) alongside the scrub fix. Confirm
   there's no conflict with this branch's own commit `c73c8a2d` ("msg") or the in-flight work
   this task was split out of (`.ai/specs/2026-08-21-the-spec-step-must-produce-a-spec.md`).

## What I could not find

- No test run was executed (by design, for this step) — I could not confirm whether the test is
  green after merging `origin/main`, only that the merge brings in a mechanism that removes the
  specific contamination path I reproduced live.
- No KB or spec entry that discusses `agent-profile-wiring.test.ts` specifically outside of the
  `1c225e7e` diff — the test's own history otherwise only shows unrelated additions (`c23fb562`
  `#785` TMPDIR-per-task, `218d68c9` per-project agent accounts).
- Whether this task's own branch (`cez/f3ab054c`) was created before or after `1c225e7e` landed
  on `main` (i.e. whether this is a stale-branch artifact rather than a genuinely undiscovered
  gap) — timestamps are consistent with "before" (`1c225e7e` is dated `Sat Aug 22 02:02:04 2026
  +0000`; this worktree's own `msg` commit `c73c8a2d` is HEAD and does not descend from it), but
  I did not find an explicit timestamp for when this task's worktree/branch was cut.
