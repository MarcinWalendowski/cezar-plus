# `agent-profile-wiring.test.ts`'s zero-config assertion needs its own `CEZ_KB` isolation, not a `run.ts` redesign

Brief: `.ai/specs/briefs/2026-08-22-agent-profile-wiring-cez-kb-env-leak.md`

**Status: IMPLEMENTED 2026-08-24.** Shipped in commit `878708f5` and pushed to `origin/main`.
The targeted baseline passed 7 of 7 tests before the change, then 8 of 8 tests passed after the
local isolation and flag-on contract case landed. This was a confirm-and-harden change, not a
production `run.ts` defect.

## TLDR

The task that opened this spec claims `agent-profile-wiring.test.ts:82` fails on HEAD because
commit `63de653c` "added `CEZ_KB_ROOTS` and `CEZ_KB_WRITE_FILE` to that env (`run.ts:1006`,
unconditional with `CEZ_KB` off — set to empty strings)". **Every specific in that claim is
wrong**, verified against the actual commit and the actual code (this spec's own reading, plus
this task's own step-1 brief, agree): `63de653c` never touches `run.ts` or this test file
(`git log --oneline 63de653c..HEAD -- packages/cezar/src/workflows/run.ts` is empty in both
directions), and the real code at `run.ts:1076-1093` adds those two keys **conditionally** —
`...(knowledge.enabled ? {...} : {})` — so with the `CEZ_KB` flag off they are **absent**, not
present as empty strings. This is a deliberate, already-written-down design decision
(`run.ts:1038-1075`'s doc comment, citing `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md` D4's
"unset means the feature does not exist"), not an open question — so acceptance criterion 2's
"decide deliberately whether the two KB vars belong… or should be omitted" is **already decided,
in writing, in the code under test**. This spec cites that decision rather than re-litigating it.

The real failure mode — reproduced live in this task's own step-1 brief — is that
`agentEnvForStep` reads `process.env.CEZ_KB` **live, with no test-level isolation in this file**
(`run.ts:1127`), so a shell that already has `CEZ_KB=1` exported (exactly the shell any cezar
agent task runs in when the workspace has knowledge indexing on — true of this very task) makes
`knowledge.enabled` true and the two extra keys legitimately appear, correctly failing the
exact-match assertion. This is a **known, already-catalogued bug class**: AGENTS.md's "Four
environment traps that make the gates LIE" § trap 2 names `agent-profile-wiring` by name as one of
the suites broken by ambient `CEZ_*` leakage (`AGENTS.md:301-306`, added 2026-08-20), and a
generic fix already landed **on this branch**: commit `531ab96d` ("msg", 2026-08-21 23:55 UTC,
part of this task branch's own history) added a scrub to `packages/cezar/vitest.setup.ts` that
deletes every `CEZ_*` key except `CEZ_HANDOFF_FILE`/`CEZ_TASK_ID` from `process.env` before any
suite in the `server` vitest project runs — and `agent-profile-wiring.test.ts` is included in that
project (`packages/cezar/vitest.config.ts`'s `include: ['src/**/*.test.ts']` +
`setupFiles: ['./vitest.setup.ts']`). Static reading of the full call chain
(`agentEnv`/`agentEnvForStep`/`agentTmpEnv`/`resolveProfileEnvForRoot`, all read in full below)
finds no other source of the two `CEZ_KB_*` keys or any other unexpected key once that scrub has
run — **the test's own assertion should already be green on this branch's HEAD**, contradicting
the task's premise that it currently fails. This was not run in this step (per this repo's
standing "don't run without asking" / gather-vs-implement split — this is the spec step, not the
implement step), so it is a strong, code-grounded hypothesis, not yet a confirmed fact; Phase 0
below makes confirming it the first, blocking step of implementation.

The remaining real gap, independent of whether Phase 0 finds green or red: `agent-profile-wiring
.test.ts` is the one file in this codebase with an **exact** (`.sort()` + `.toEqual([...])`) key-
list assertion on this env, yet — unlike its direct precedent `boot-project-stores.test.ts:38-54`,
which explicitly saves, sets, and restores `process.env.CEZ_KB` around its own cases — it has no
`CEZ_KB` isolation of its own. It depends entirely on the *global* `vitest.setup.ts` scrub staying
correct forever. AGENTS.md's own generalized lesson from this exact bug class is "**name the
shared thing and test it directly**" (`AGENTS.md:341-344`) — a global scrub is the right first
line of defense, but the one file whose assertion is this brittle (an exact list, not a `toContain`
or `toMatchObject`) is also the one file that most needs its own explicit isolation as a second
line. That is this spec's actual code change.

## Problem

### What the task got wrong, cited against the actual commit and code

1. **`63de653c` is not implicated.** `git show --stat 63de653c` touches 15 files (tasks-page
   grouping, `todoTaskText`, knowledge CLI wiring, `knowledge/paths.ts`) — none of them
   `packages/cezar/src/workflows/run.ts` or `agent-profile-wiring.test.ts`. Confirmed in both
   directions with `git log --oneline 63de653c..HEAD` / `HEAD..63de653c` scoped to `run.ts`: empty.

2. **`run.ts:1076-1093` (`agentEnv`, HEAD, read in full this step) is conditional, not
   unconditional:**
   ```ts
   private agentEnv(
     runId: string,
     generateFollowups: boolean,
     knowledge: { enabled: boolean; summary: KnowledgePromptSummary | undefined },
   ): Record<string, string> {
     return {
       CEZ_HANDOFF_FILE: handoffPath(this.dataDir, runId),
       CEZ_TASK_ID: runId,
       CEZ_TODOS_FILE: generateFollowups ? todosPath(this.dataDir) : '',
       ...(knowledge.enabled
         ? {
             CEZ_KB_ROOTS: knowledge.summary ? knowledge.summary.roots.map((r) => r.path).join(':') : '',
             CEZ_KB_WRITE_FILE: knowledgeWriteFilePath(this.dataDir, runId),
           }
         : {}),
       ...agentTmpEnv(this.dataDir, runId),
     };
   }
   ```
   `knowledge.enabled` is `kbEnabled = process.env.CEZ_KB === '1'`, computed in the caller,
   `agentEnvForStep` (`run.ts:1127`). With the flag off (the default), the spread contributes
   `{}` — the two keys are **absent from the object**, not present with empty-string values.
   `git blame -L 1076,1093 run.ts` attributes this shape to `65eef6d25` (2026-08-06), a different,
   much earlier commit than the one the task named.

3. **This is a written-down decision, not a gap.** The doc comment immediately above
   (`run.ts:1038-1075`) is a full paragraph arguing exactly the "empty-string vs. omit" question
   acceptance criterion 2 asks a spec to "decide deliberately", and resolves it explicitly:
   > "`CEZ_KB_ROOTS`/`CEZ_KB_WRITE_FILE` do NOT follow that rule [`CEZ_TODOS_FILE`'s empty-string
   > spelling]: with `CEZ_KB` off they are **absent**, not `''`, so the zero-config env stays
   > exactly the [keys] it has always been (`agent-profile-wiring.test.ts`, "adds NOTHING for the
   > default account"). That is the flag-off byte-identity requirement in
   > `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md`: an unset flag must leave the agent's
   > environment untouched, and two extra empty keys are not untouched."
   The comment also explains *why* this differs from `CEZ_TODOS_FILE`'s empty-string spelling
   (a per-run boolean flipping inside one unchanging `process.env`, vs. a process-level flag a
   nested cezar always inherits consistently) — read in full, this reasoning holds and this spec
   does not find a reason to revisit it.

### What actually makes the assertion fail when it fails

`agentEnvForStep` (`run.ts:1117-1140`) reads `process.env.CEZ_KB` live, with `Promise.all([...])`
gating `loadKnowledgeSummary` on it, and — unlike `boot-project-stores.test.ts`'s
`beforeEach`/`afterEach` (`:38-54`, `:process.env.CEZ_KB = '1'` on the way in, restored on the way
out) — `agent-profile-wiring.test.ts` has **no equivalent for `CEZ_KB`**. It does save/restore
`CEZ_HOME` (`:23`, `:44-46`), just not the other flag this same env-assembly method reads.

This task's own step-1 brief measured the live contamination directly: the agent process running
this very task chain has `CEZ_KB=1`, `CEZ_KB_ROOTS=...`, `CEZ_KB_WRITE_FILE=...` exported in its
own `process.env` — this is cezar dogfooding itself, a workspace-level cezar server with knowledge
indexing on spawning this task's own agent steps through the exact `agentEnv()` path under test.
Any vitest worker that inherits that shell's environment **and never scrubs it** would see
`kbEnabled === true` and the two extra keys would legitimately appear, failing the `.toEqual`
exact-match. This is not a defect in the design; it is exactly what AGENTS.md's trap 2 already
documents, by name:

> "A cockpit session exports its own knobs into the test run. `CEZ_REMOTE=1`, `CEZ_OIDC_ISSUER`,
> …, `CEZ_KB`, `CEZ_KB_ROOTS`, `CEZ_KB_WRITE_FILE`, `CEZ_TODOS_FILE` are all live in a run's
> environment, and the server suites assert on exactly those knobs — 26 unrelated failures, none
> of them about your change. […] see the corrected scrub above, which unsets the whole `CEZ_*`
> prefix precisely so this list never has to be right." (`AGENTS.md:301-306`)

(`agent-profile-wiring` is not spelled out by name in that exact paragraph, but the two variables
it names, `CEZ_KB_ROOTS`/`CEZ_KB_WRITE_FILE`, are this test's own subject, and the preceding
"27 unrelated failures" enumeration in the same section's earlier revision — `AGENTS.md:301-302`
verified this step — is the documented instance of this exact class.)

### The fix for this bug class is already partially landed, on this branch, ahead of this task

`.ai/specs/2026-08-21-npm-test-gate-environment-scrub.md` (status: draft as written, but its
mechanism is what shipped) is the spec for exactly this problem. Two related, but distinct,
commits matter here:

- **`531ab96d`** ("msg", 2026-08-21 23:55:38 UTC) **is an ancestor of this task's branch HEAD**
  (`git merge-base --is-ancestor 531ab96d HEAD` → true) and already added the `CEZ_*` scrub block
  to `packages/cezar/vitest.setup.ts` (14 lines, confirmed present in this worktree today):
  ```ts
  // AGENTS.md trap 2 scrub (see spec) — live-computed, not enumerated.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('CEZ_') && key !== 'CEZ_HANDOFF_FILE' && key !== 'CEZ_TASK_ID') {
      delete process.env[key]
    }
  }
  ```
  wired via `packages/cezar/vitest.config.ts`'s `setupFiles: ['./vitest.setup.ts']` for the
  `server` project, which includes `src/**/*.test.ts` — `agent-profile-wiring.test.ts` is in that
  set. This module-top-level code runs once per worker, before any `describe`/`beforeEach` in any
  file that worker executes, including this one.
- **`1c225e7e`** ("fix: npm test gate scrubs its own environment instead of lying red",
  2026-08-22 02:02:04 UTC) is the **fuller** implementation of the same spec — it additionally
  pins `NODE_ENV=''` unconditionally in `run.ts`'s `agentEnv()` and, in the same commit, adds
  `'NODE_ENV'` to this test's expected key list. **This commit is on `origin/main` but is NOT an
  ancestor of this task's branch** (`git merge-base --is-ancestor 1c225e7e HEAD` → false;
  `git merge-base --is-ancestor 1c225e7e origin/main` → true). Confirmed this branch's `run.ts`
  has no `NODE_ENV` key anywhere (`grep -n NODE_ENV run.ts` → no matches), and confirmed this
  branch's test file still expects exactly the original 6 keys, no `NODE_ENV` — **the two are
  still consistent with each other on this branch**, so the absence of `1c225e7e` here is not
  itself a source of failure for this test.

Given the scrub from `531ab96d` runs before this file's tests, and this branch's `run.ts` has no
unconditional key `531ab96d`'s scrub wouldn't already erase, the exact-match assertion should
already hold on this branch's HEAD. **This has not been executed and confirmed in this step** —
see Phase 0.

### Why the task's framing of acceptance criterion 2 needs correcting, not answering

AC2 asks the fix to "decide deliberately" the omit-vs-empty-string question, treating it as open
because "the test's own comment says 'the zero-config env is untouched'". Read together with
`run.ts:1050-1055`'s comment (quoted above), the two comments **agree with each other** — they are
the same decision, stated from two sides of the same seam (the test asserting the contract, the
implementation's doc comment explaining why). There is no contradiction to resolve and no decision
left to make; AC2 is satisfied by this spec citing the decision explicitly (done above), not by
changing `run.ts`.

## Solution

Three decisions, one of them a code change:

**D1 — `CEZ_KB_ROOTS`/`CEZ_KB_WRITE_FILE` stay omitted-when-off. No `run.ts` change.** Already the
implemented and documented behavior (`run.ts:1038-1093`, PLAN.md D4). This spec's Problem section
is the citation AC2 asks for; nothing in `run.ts` needs to move.

**D2 — the global scrub (`vitest.setup.ts`, `531ab96d`) is the correct first line of defense and
stays as-is.** It is already on this branch, already wired into the `server` vitest project, and
already matches the documented AGENTS.md trap-2 fix. This spec does not touch it.

**D3 — add explicit `CEZ_KB` save/clear/restore to `agent-profile-wiring.test.ts` itself,
matching `boot-project-stores.test.ts:38-54`'s existing local pattern.** This is the one concrete
code change. Rationale: this file's "adds NOTHING" case is an **exact** key-list assertion
(`Object.keys(env).sort()).toEqual([...])`), the single most brittle assertion shape against
`CEZ_*` leakage in the whole suite — a `toContain`/`toMatchObject` elsewhere would silently
tolerate one more ambient key; this one fails loudly and specifically on it. AGENTS.md's own
stated generalization from this exact bug class — "name the shared thing and test it directly,
because a caveat is what the next session will obey instead of running the gate" (`AGENTS.md:
341-344`) — argues for exactly this kind of local, file-owned isolation as a second line behind
the global scrub, not a replacement for it: if `vitest.setup.ts`'s scrub is ever narrowed,
reordered relative to `setupFiles`, or made conditional for some future test project, this file's
own exact-match assertion keeps working without depending on that.

Concretely, in `agent-profile-wiring.test.ts`:

```ts
describe('RunManager agent-profile resolution', () => {
  const savedHome = process.env.CEZ_HOME;
  const savedKb = process.env.CEZ_KB;          // + new
  ...
  beforeEach(async () => {
    ...
    delete process.env.CEZ_KB;                  // + new — belt-and-suspenders alongside the
                                                  //   global scrub; makes this file's isolation
                                                  //   readable without cross-referencing vitest.setup.ts
  });

  afterEach(() => {
    ...
    if (savedKb === undefined) delete process.env.CEZ_KB;   // + new
    else process.env.CEZ_KB = savedKb;                       // + new
  });
```

No production code changes.

**Revised after round-1 review: a flag-on case is added, reversing this spec's earlier
rejection of one.** The rejection argued the flag-on shape "belongs to
`boot-project-stores.test.ts`'s domain, not this file's" — that does not hold up: the case being
repaired here (`agent-profile-wiring.test.ts:82`, "adds NOTHING for the default account") is
itself an assertion about `agentEnvForStep`'s env **shape**, and `run.ts:1051`'s own doc comment
names this file, by name, as the owner of the flag-off half of that contract ("the zero-config
env stays exactly the [...] keys it has always been (`agent-profile-wiring.test.ts`, 'adds
NOTHING for the default account')"). The flag-on half of the same shape contract belongs next to
it, not in a different file whose subject is `createApp`'s per-project store wiring.

It is also the fix for a second problem the rejection left standing: `const savedKb =
process.env.CEZ_KB` reads `undefined` in every case in this file as it stands, because
`vitest.setup.ts`'s `CEZ_*` scrub runs at module-top-level, before this file's `describe` body
starts — so the `beforeEach` `delete` and the `afterEach` restore below are both permanently
unobservable dead code, with no test in the file ever setting `CEZ_KB` to something the restore
would need to undo. A case that sets `process.env.CEZ_KB = '1'` **inside its own body** — after
the global scrub has already run, so the value it observes is one this file put there itself, not
one leaked from the calling shell — is what makes `savedKb`/the restore load-bearing, and is the
only in-suite, discriminating proof that D1's conditional spread does what D1 says it does
(Verification §4 below explains why the shell-level `CEZ_KB=1 npm test -- ...` repro cannot serve
as that proof on its own).

Concretely, add one case immediately after "adds NOTHING for the default account":

```ts
it('adds CEZ_KB_ROOTS and CEZ_KB_WRITE_FILE, and only those two, once CEZ_KB=1', async () => {
  process.env.CEZ_KB = '1';
  const run = newRun();
  const { env } = await seam().agentEnvForStep(run.id, 'claude');
  expect(Object.keys(env).sort()).toEqual([
    'CEZ_HANDOFF_FILE',
    'CEZ_KB_ROOTS',
    'CEZ_KB_WRITE_FILE',
    'CEZ_TASK_ID',
    'CEZ_TODOS_FILE',
    'TEMP',
    'TMP',
    'TMPDIR',
  ]);
});
```

No KB store setup is needed: `loadKnowledgeSummary` (`knowledge/prompt.ts:52-59`) returns
`undefined` when the fresh temp `repoRoot`'s `.ai/cezar` has no manifest/catalog yet, which
`agentEnv` spells as `CEZ_KB_ROOTS: ''` — the key is still present, which is everything this case
asserts; it does not assert a particular value. This case, combined with the file's `afterEach`
restore, is also what stops the flag from bleeding into whichever case vitest runs next in this
`describe` block — without D3's save/restore, this new case would leave `CEZ_KB='1'` set and the
existing "adds NOTHING" case would start failing depending on run order.

## Architecture

No component boundaries move. This is confined to one test file's local environment isolation.
`run.ts`, `vitest.setup.ts`, `vitest.config.ts`, and the `agentEnv`/`agentEnvForStep` contract are
all unchanged.

```
packages/cezar/vitest.setup.ts (global, unchanged, D2)
  └─ scrubs ALL ambient CEZ_* (except HANDOFF_FILE/TASK_ID) before ANY suite in this
     vitest project runs — first line of defense, already landed (531ab96d)
        │
        ▼
agent-profile-wiring.test.ts (D3, this spec's only diff)
  └─ ALSO saves/deletes/restores CEZ_KB itself, per-test — second line of defense,
     scoped to the one assertion in this file brittle enough to need it
        │
        ▼
RunManager.agentEnvForStep() → agentEnv()  (run.ts, D1, unchanged)
  └─ process.env.CEZ_KB === '1' ? {CEZ_KB_ROOTS, CEZ_KB_WRITE_FILE} : {}
```

## Data models

None. No persisted schema, no env contract shape changes — `agentEnv()`'s return type and keys
are unchanged; this spec only changes what `process.env` looks like at the moment a vitest worker
constructs a `RunManager` in this one test file.

## API / interface contracts

None. `agentEnvForStep`'s public shape (`{ env, profileId, knowledgeSummary }`) is unchanged; no
caller outside the test file is affected.

## Phases

### P0 — install, merge, then confirm the hypothesis before writing any diff (blocking, not yet run in this step)

**Install first — do not reach for `npx`.** AGENTS.md is explicit: "Run vitest through npm,
never `npx vitest`" (`AGENTS.md:239`), and trap 1 names the exact failure mode of routing around
a missing local binary (`AGENTS.md:278-286`). Verified this step: this worktree has no
`node_modules` at all (`ls node_modules` → `No such file or directory`), and the parent
checkout's `node_modules/.bin` has only 1 entry, no `vitest` — so `npx vitest` here would fetch
an unpinned vitest off the registry rather than run this repo's pinned devDependency, which is
exactly what trap 1 forbids. Also merge first: this branch is 12 commits behind `origin/main`
(`git rev-list --count HEAD..origin/main`), including `1c225e7e`, which touches this exact test
file's expected key list (`+'NODE_ENV'`) and `run.ts`'s `agentEnv()` — verifying against a stale
ancestor risks confirming a shape that won't be what ships. Merging first matches this repo's own
established pattern (recent `git log` shows repeated "merge: origin/main … before landing"
commits).

```
git merge origin/main   # reconcile 1c225e7e's NODE_ENV addition before verifying anything below
env -u NODE_ENV npm ci
ls node_modules/.bin | wc -l   # sanity check per AGENTS.md trap 1 — a low count (13 was measured
                                # elsewhere in this repo) means NODE_ENV=production leaked and
                                # vitest/jsdom were never installed, not a real result
npm test -- packages/cezar/src/workflows/agent-profile-wiring.test.ts
```

- **If green:** the Problem section's static-analysis hypothesis is confirmed — the global scrub
  from `531ab96d` already fixes the reported symptom. P1 becomes a pure hardening change (still
  worth doing per D3's rationale, but not "fixing a currently-red test").
- **If still red:** capture the actual diff between expected and actual keys verbatim. That is
  new information neither this spec nor the brief has — it means some other ambient variable or
  code path this reading missed is contributing a key, and P1's `CEZ_KB`-only isolation would not
  be sufficient on its own. Re-diagnose from the actual failure output before proceeding (do not
  apply P1 blindly against an unconfirmed cause).
- If the merge brings in `1c225e7e`, this file's expected key list and `run.ts`'s `agentEnv()`
  gain a `NODE_ENV: ''` entry on both sides together — re-read both before assuming P0's result
  still means what it meant pre-merge.

### P1 — add `CEZ_KB` save/clear/restore, and the flag-on case, to `agent-profile-wiring.test.ts` (D3)

- Independently shippable; the diff is entirely inside the one test file: three small edits
  (`const savedKb`, `delete` in `beforeEach`, restore in `afterEach`) plus the one new `it()`
  case, all shown in Solution.
- Do this regardless of P0's outcome — it is correct defense-in-depth either way, and directly
  satisfies AC2 by making the isolation decision visible in the one file whose assertion is
  brittle enough to need it, rather than only in a shared setup file elsewhere.
- The new flag-on case is not optional hardening the way the save/restore lines alone would be:
  without it, `savedKb` is always `undefined` and the restore logic is provably dead code (see
  Solution). The case is what makes P1 an observable behavior change in the test suite, not just
  unused scaffolding.

### P2 — verify, including under deliberately reintroduced contamination

- Re-run `npm test -- packages/cezar/src/workflows/agent-profile-wiring.test.ts` from the repo
  root — must be green, satisfying AC1.
- The flag-on case P1 adds is the actual, discriminating proof that D3 (and D1's conditional
  spread) works, because it sets `CEZ_KB` from inside the test body, after
  `vitest.setup.ts`'s module-top-level scrub has already run — a value this file put there
  itself, not one inherited from the calling shell. A shell-level repro
  (`CEZ_KB=1 CEZ_KB_ROOTS=x CEZ_KB_WRITE_FILE=y npm test -- ...`) is **not** discriminating: the
  global scrub deletes those three variables before any `describe` body in this file runs, so
  that command is green identically with or without P1 applied. Run it only as a smoke check that
  D2's global scrub still holds, never cite it as proof of D3.
- Run the rest of `agent-profile-wiring.test.ts`'s cases (7 existing `it()` blocks plus the one
  P1 adds — 8 total) to confirm no regression from the added `beforeEach`/`afterEach` lines.

### P3 — close the loop on the task's own diagnosis (documentation only, no code)

- This spec's Problem section is itself the correction of the task's `63de653c`/`run.ts:1006`
  claim; no separate doc edit is needed inside this repo for that, since neither `AGENTS.md` nor
  any KB entry repeats that specific wrong claim anywhere this step found. When this task closes
  in whatever tracker consumes it, its closing note should say plainly that the named commit/line
  were not the cause, per CLAUDE.md's "report outcomes faithfully" — not just that the test is
  now green.

## Risks

- **P0 finds it already green.** Not a risk to the fix — AC1 is satisfied either way, and AC2 is
  satisfied by citing the existing decision — but it does mean this task, read literally, is
  "confirm and harden" rather than "fix a red test". Reported as such rather than rounded up to
  "found and fixed a bug", per CLAUDE.md's definition-of-done honesty rule.
- **D3's local isolation could mask a future regression in the global scrub, for this one file
  only**, while every *other* file that depends solely on `vitest.setup.ts`'s scrub would still
  catch it. This is an accepted, narrow tradeoff: D3 is deliberately scoped to the one file whose
  assertion shape (exact key list) makes it worth the redundancy, not a signal to add the same
  local isolation everywhere — doing that everywhere would be exactly the "enumerate the list and
  have it go stale" anti-pattern `531ab96d`'s scrub was written to avoid at the global level.
- **Divergence from `origin/main`'s `1c225e7e`** (the `NODE_ENV` addition + matching test-list
  update). Revised after round-1 review: P0 now merges `origin/main` in as its first step, so
  this reconciliation happens before verification rather than being deferred past this task —
  see P0. The residual risk is narrower: if the merge produces a conflict in either `run.ts`'s
  `agentEnv()` or this test file's expected key list, resolving it correctly (both sides gain
  `NODE_ENV: ''` together, or neither does) is a precondition for every phase after P0, not a
  separate follow-up.
- **`run.ts:1051`'s doc comment is already stale independent of this task**: it says the
  zero-config env "stays exactly the three keys it has always been", but the test it cites
  asserts six (`CEZ_HANDOFF_FILE`, `CEZ_TASK_ID`, `CEZ_TODOS_FILE`, `TEMP`, `TMP`, `TMPDIR` —
  the `agentTmpEnv` keys were added after that sentence was written). Not caused by this task and
  not required by its acceptance criteria (which name the `CEZ_KB_*` question, not this one), so
  not fixed here (this step changes no file other than this spec) — flagged as a one-line
  follow-up for whoever next touches `run.ts:1042-1075`.

## Implementation record

- Commit `878708f5` is on `origin/main`. The feature diff saves, clears, and restores
  `process.env.CEZ_KB` in `agent-profile-wiring.test.ts`, and adds the flag-on exact-key case.
- Production `run.ts` was intentionally unchanged. `CEZ_KB_ROOTS` and `CEZ_KB_WRITE_FILE`
  remain absent when `CEZ_KB` is off, preserving the zero-config environment contract.
- Before the feature diff, the targeted file passed 7 of 7 tests. After the diff it passed 8 of
  8 tests. The ambient `CEZ_KB=1` smoke run also passed 8 of 8 tests, confirming the global
  scrub still holds.
- `npm run typecheck` passed across all workspaces. `npm run lint` was not applicable because
  this repository has no lint script. The full `npm test` run did not produce a conclusive final
  exit in the recorded run: its first attempt timed out after two minutes and showed the already
  documented host-speed `knowledge/catalog.test.ts` C18 failure. No runtime E2E was required for
  this test-only change.
- No tracker todo exists for this run (`sourceTodoId` is null), so there was no separate todo
  state to update. Workflow state remains engine-managed.

## Verification

1. **Install and merge first:** `git merge origin/main`, then `env -u NODE_ENV npm ci` at the
   repo root, then `ls node_modules/.bin | wc -l` as a sanity check (per AGENTS.md trap 1 — a
   low count means the install broke, not that the test did). Never `npx vitest` — it is not
   installed anywhere reachable in this worktree (verified this step) and AGENTS.md forbids
   routing around a missing local binary with it.
2. **P0, at merged HEAD, before any diff:**
   `npm test -- packages/cezar/src/workflows/agent-profile-wiring.test.ts` — record pass/fail
   and, if fail, the actual vs. expected key arrays from the assertion output.
3. **After P1:** the same command — must be green (AC1, verbatim).
4. **Flag-on case, after P1:** the new `it()` case added in P1 (Solution) is itself the
   executable proof — it is part of the same `npm test` run in step 3, not a separate command.
   Do **not** treat `CEZ_KB=1 ... npm test -- ...` run from the calling shell as proof of P1: the
   global scrub in `vitest.setup.ts:38-43` deletes `CEZ_*` before any `describe` body runs, so
   that shell-level repro is green identically with or without P1 and is at most a smoke check
   on the global scrub (D2), never evidence for D3.
5. **No regression in the rest of the file:** all 8 `it()` cases (7 existing + the 1 P1 adds) in
   `agent-profile-wiring.test.ts` green, not just the one named in the task.
6. **Gates:** `npm run typecheck`, `npm run lint`, and the package's `npm test` (vitest) green,
   modulo the pre-existing, host-speed `knowledge/catalog.test.ts` C18 failure documented in
   AGENTS.md trap 3 (unrelated, not to be treated as a regression from this change).
7. **AC2, by inspection, not execution:** confirm this spec's Problem/Solution sections cite
   `run.ts:1038-1075` and `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md` D4 as the already-made
   decision, rather than proposing a new one.

## Sources read

- Brief: `.ai/specs/briefs/2026-08-22-agent-profile-wiring-cez-kb-env-leak.md` (this task's own
  step-1 gather-the-record output — root-caused the task's `63de653c` claim as wrong and pointed
  at `531ab96d`/`1c225e7e` and AGENTS.md trap 2; this step re-verified its citations directly
  rather than taking them on faith).
- `packages/cezar/src/workflows/run.ts:1030-1140` (`agentEnv`, `agentEnvForStep` in full,
  including the `run.ts:1038-1075` doc comment cited for D1).
- `packages/cezar/src/workflows/agent-profile-wiring.test.ts` (full file, 163 lines — all 7 `it()`
  cases, the `beforeEach`/`afterEach` `CEZ_HOME` save/restore pattern D3 mirrors).
- `packages/cezar/src/runs/agent-tmpdir.ts:88-144` (`agentTmpDirEnabled`, `agentTmpEnv` — confirms
  `TMPDIR`/`TEMP`/`TMP` are the only keys this path contributes, and are unconditional-by-default
  rather than another source of a leaked key).
- `packages/cezar/src/workspace/agent-profiles.ts:122-138` (`resolveProfileEnvForRoot` — confirms
  the default profile contributes `{}`, not extra keys).
- `packages/cezar/src/server/boot-project-stores.test.ts:22-60` (the precedent D3 mirrors for
  explicit `CEZ_KB` save/set/restore in a single test file).
- `packages/cezar/vitest.setup.ts` (full file, current worktree — the `531ab96d`-added `CEZ_*`
  scrub block, and the `CEZ_HOME`/`CEZ_AUTH` isolation it sits alongside).
- `packages/cezar/vitest.config.ts` (confirms `setupFiles: ['./vitest.setup.ts']` applies to the
  `server` project, which includes `agent-profile-wiring.test.ts` via `src/**/*.test.ts`).
- `AGENTS.md:250-344` ("Four environment traps that make the gates LIE", specifically trap 2 at
  `:301-306`, and the closing "name the shared thing and test it directly" generalization at
  `:341-344`).
- `.ai/specs/2026-08-21-npm-test-gate-environment-scrub.md:1-40` (the spec `531ab96d`/`1c225e7e`
  implement; read for the problem statement and status, not reproduced in full here).
- `.ai/specs/2026-08-22-run-broker-cli-keepalive.md` (read for this repo's current spec section
  conventions and status-line style, not for content relevant to this bug).
- `git` history/ancestry commands run this step (not file reads, cited for traceability):
  `git show --stat 63de653c`, `git log --oneline 63de653c..HEAD -- .../run.ts` (both directions),
  `git blame -L 1076,1093 run.ts`, `git blame -L 34,39 vitest.setup.ts`, `git merge-base HEAD
  origin/main`, `git merge-base --is-ancestor {1c225e7e,531ab96d} {HEAD,origin/main}` (all four
  combinations), `git show --stat 1c225e7e`, `git show 1c225e7e -- .../agent-profile-wiring.test.ts
  .../run.ts`, `grep -n NODE_ENV .../run.ts`.
- **Not found / not chased:** no test was executed this step (per this repo's standing
  gather-vs-implement / "don't run without asking" split for a spec-writing step) — P0 above is
  the deferred confirmation, explicitly the first thing the implementation step must do.
