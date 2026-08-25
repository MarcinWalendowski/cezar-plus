# Config API env isolation

**Status: IMPLEMENTED 2026-08-25 in `fe4287c2b4e1991206da753511be41541df0cf72`; QA NEEDED pending deploy.** This document is the `spec` step (2 of 9) of run
`6446fb82-b878-4818-b54a-e3d2ef7ad714`, workflow `spec-to-deploy`, branch `cez/6446fb82`, worktree
HEAD `b3d3a44c`. Written against the brief
`.ai/specs/briefs/2026-08-24-config-api-claude-env-isolation.md` (step 1 of this run). Every file
and commit cited below was re-opened at `b3d3a44c` for this document; where the brief and the tree
disagree, the tree wins and the disagreement is named in §"Corrections to the brief".

No test was run in this step: the worktree has **no `node_modules`** (`ls node_modules` → absent),
so reproducing the failure here would mean a full `npm ci`. The reproduction is deferred to step 5
(`run-tests`) and specified exactly in §Verification. The problem statement below therefore rests on
the measurement already in the record, not on a fresh one, and says so.

## TLDR

`packages/cezar/src/server/config-api.test.ts` fakes `HOME` and writes `$HOME/.claude/settings.json`,
but `agentHomePaths()` (`packages/cezar/src/paths.ts:256-263`) resolves Claude's home from
`CLAUDE_CONFIG_DIR` **first** and only falls back to `$HOME/.claude`. Every agent session on
`prod-host` exports `CLAUDE_CONFIG_DIR=/var/lib/cezar/.claude-secondary` (confirmed in this
step's own environment), so the fixture's settings file is never read and
`GET /api/v1/config` answers `defaultModels` with no `claude` key.

The fix is one test file. The suite already saves, overrides and restores `HOME`, `CEZ_HOME`,
`CODEX_HOME`, `XDG_CONFIG_HOME` and `CEZ_AGENT_MODELS_LOCKED` (`config-api.test.ts:24-60`); it
simply omits Claude's. Add `CLAUDE_CONFIG_DIR` to that list, and `ANTHROPIC_MODEL` with it — the
Claude strategy short-circuits on `env.ANTHROPIC_MODEL` at a *higher* priority than any settings
file (`model-settings/claude.ts:8`), so it is the same defect one variable over, unset on this box
today and a red gate on the first box that exports it.

Nothing in the resolver, the catalog or `paths.ts` changes. `CLAUDE_CONFIG_DIR` outranking `HOME` is
a deliberate product decision (`.ai/specs/2026-08-14-claude-subscription-autodetect.md`, D1) and the
cockpit depends on it; the defect is a fixture that forgot to own an ambient variable, not a
precedence bug.

## Problem

### The measurement

Recorded by task `f2280db6` and carried into the brief: `npm test` → **1 failed / 11775 passed**;
`env -u CLAUDE_CONFIG_DIR npm test` → **0 failed / 11776 passed**. The single failure is
`config-api.test.ts > "uses the coding agents' native model settings as the initial defaults"`.

The same failure was diagnosed once before, on 2026-08-22, in
`.ai/specs/2026-08-22-per-task-prompt-drafts-qa-and-closeout.md:277-289`:

> `config-api.test.ts` … **newly diagnosed this run**: `CLAUDE_CONFIG_DIR` (this agent's own Claude
> Code config dir) leaks into the test's child process; the test saves/restores
> `HOME`/`CEZ_HOME`/`CODEX_HOME`/`XDG_CONFIG_HOME` but not `CLAUDE_CONFIG_DIR` … Isolated re-run
> with `CLAUDE_CONFIG_DIR` also unset: 15/15 pass. This is a **third environment trap**.

So this is a known, twice-observed trap that was written down and never fixed. That is the cost
being paid: a suite red for a reason unrelated to the change under test trains every `run-tests`
step to wave a failure through, which is exactly the habit `AGENTS.md` §"Gates first, fail closed"
exists to prevent.

### The mechanism, end to end

1. `GET /api/v1/config` calls `readAgentModelDefaults(repoRoot)` with **no env argument**
   (`packages/cezar/src/server/server.ts:6720`).
2. `readAgentModelDefaults` defaults its `env` parameter to `process.env`
   (`packages/cezar/src/agent-config/models.ts:31-43`) and fans out to one strategy per runner.
3. `claudeModelSettingsStrategy.read` (`packages/cezar/src/agent-config/model-settings/claude.ts:4-10`)
   returns `env.ANTHROPIC_MODEL` outright if set; otherwise it reads native settings files.
4. `readNativeSettingsFiles` → `readConfigFile('claude.user.settings', repoRoot, env)`
   (`model-settings/shared.ts:62-81`), whose catalog entry resolves to
   `join(home.claude, 'settings.json')` (`packages/cezar/src/agent-config/catalog.ts:82-99`).
5. `home.claude` comes from `agentHomePaths(env)`:
   ```ts
   claude: env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude'),
   ```
   (`packages/cezar/src/paths.ts:256-263`).

The test's `beforeEach` (`config-api.test.ts:31-44`) moves `HOME` to a temp dir and writes
`{"model":"sonnet"}` into `$HOME/.claude/settings.json` (`:99-105`), then asserts
`defaultModels` equals `{claude:'sonnet', codex:'gpt-5-codex', opencode:'openai/gpt-5.1'}`
(`:107-111`). With `CLAUDE_CONFIG_DIR` ambient, step 5 never reaches the `join(home, '.claude')`
branch. The `codex` and `opencode` legs pass because `CODEX_HOME` and `XDG_CONFIG_HOME` — the two
variables that steer *their* homes — are already owned by the same `beforeEach`. Claude's is the
only one missed.

The fixture was introduced with this exact gap by `d6385531` ("Use native coding-agent models and
support model locking (#726)").

### Why the same variable is fine everywhere else

`agent-profiles-discovered-api.test.ts` fakes `HOME` too and *does* own `CLAUDE_CONFIG_DIR`
(`:25-69`: saved at `:30`, deleted at `:53`, restored at `:66`). That is the precedent this change
copies, and it is already on `main` — it came in with `e8fc6d2e` (Claude subscription autodetect),
not with the unmerged branch the brief cites.

## Corrections to the brief

The brief is accurate on the mechanism and on the constraint. Two of its record claims do not
survive re-reading the tree, and both change what the implementation should do:

1. **`.ai/specs/2026-08-24-isolate-discovered-account-tests.md` is not in this branch's history.**
   `git merge-base --is-ancestor 2888f117 HEAD` → false; `git branch -a --contains 2888f117` →
   `cez/6509be16` and `origin/cez/6509be16` only. That commit is **in flight, not landed**, and it
   adds a *global* scrub to `packages/cezar/vitest.setup.ts`:
   ```ts
   delete process.env.CLAUDE_CONFIG_DIR
   delete process.env.CODEX_HOME
   ```
   inserted immediately after the existing `delete process.env.CEZ_AUTH`. `vitest.setup.ts` at
   `b3d3a44c` has no such block (re-read in full for this spec). **Consequence (D5 below): this
   change must not touch `vitest.setup.ts`** — two branches editing one insertion point for the same
   outcome is a merge conflict bought for nothing, and the suite-local guard is correct whether or
   not `cez/6509be16` lands.

2. **The sweep in criterion 2 has one more candidate than the brief examined, and it is clean.**
   `packages/cezar/src/workspace/agent-accounts-auto.test.ts` sets `process.env.HOME` (`:179`) and
   builds `$HOME/.claude` fixtures (`:190-193`) with no `CLAUDE_CONFIG_DIR` guard — but it calls
   `autoRegisterDiscoveredAccounts(env())` where `env()` is a **literal object**,
   `{ HOME: home, CEZ_AUTO_ACCOUNTS: '1', ...over }` (`:45-49`), with no `process.env` spread. So
   `env.CLAUDE_CONFIG_DIR` is `undefined` and the fallback branch is taken by construction. The
   `process.env.HOME` write at `:179` exists only because `expandTilde` goes through
   `os.homedir()`; the file says so in a comment at `:173-176`. No change needed. The brief's
   conclusion was right; its cited line numbers were not.

## Solution

### D1 — The fixture owns `CLAUDE_CONFIG_DIR`, save / delete / restore

In `config-api.test.ts`, alongside the five variables already handled:

```ts
const savedClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
// beforeEach:
delete process.env.CLAUDE_CONFIG_DIR;
// afterEach:
if (savedClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
else process.env.CLAUDE_CONFIG_DIR = savedClaudeConfigDir;
```

**Delete, not point-at-the-fake-home.** Setting `CLAUDE_CONFIG_DIR = join(homeRoot, '.claude')`
would make this one assertion pass while testing the override path instead of the default path —
and the thing under test is what `agentHomePaths` answers *when nothing overrides it*, which is what
the docblock at `paths.ts:245-255` says the function is for. Deleting is also what the
discovered-account suite does (`agent-profiles-discovered-api.test.ts:53`), so there is one idiom in
this repo, not two.

### D2 — `ANTHROPIC_MODEL` gets the same treatment, in the same breath

`claude.ts:7-8`:
```ts
// Claude Code gives ANTHROPIC_MODEL higher priority than settings files.
if (env.ANTHROPIC_MODEL?.trim()) return { model: env.ANTHROPIC_MODEL.trim() };
```
An ambient `ANTHROPIC_MODEL` produces the *same* failure with a different value in it
(`claude: '<whatever was exported>'` instead of `'sonnet'`), and it is the only remaining
process-env input to the claude leg of this assertion. It is **unset on this box today** (measured
in this step: `ANTHROPIC_MODEL=<unset>`), so this is prophylactic, not a live red — which is why it
is its own phase and can be dropped without touching D1.

This is a deliberate widening past the task's acceptance criteria, flagged rather than smuggled: the
criteria name `CLAUDE_CONFIG_DIR` only. It costs three lines in a file already being edited, and
leaving it means the same bug is one `export` away.

The other two legs need nothing added: `codex` reads `CODEX_HOME` (owned at `:36`), `opencode` reads
`XDG_CONFIG_HOME` (owned at `:37`), and `pi` is not catalogued at all
(`model-settings/pi.ts` docblock).

### D3 — A regression test that fails on every machine, not only a poisoned one

Today the assertion at `:107-111` exercises the guard only when the ambient variable *happens* to be
set — i.e. the fix would be untested on CI, whose environment is clean, and the trap could be
reintroduced by anyone who reads the `beforeEach` as noise. The brief raises this as its open
question 3. Answer: add it, and make the poison machine-independent by injecting it from a **nested
`describe`'s `beforeAll`**:

```ts
describe('with a hostile ambient Claude config dir', () => {
  let decoy: string;
  beforeAll(() => {
    decoy = mkdtempSync(join(tmpdir(), 'cez-configapi-decoy-'));
    writeFileSync(join(decoy, 'settings.json'), '{"model":"decoy-model"}');
    process.env.CLAUDE_CONFIG_DIR = decoy;      // outer beforeEach must delete this
  });
  afterAll(() => rmSync(decoy, { recursive: true, force: true }));

  it('still reads the fake HOME, not the ambient override', async () => { /* as :99-111 */ });
});
```

The load-bearing fact is vitest's hook order: **`beforeAll` of a nested suite runs when the suite is
entered, before any `beforeEach` of any test in it** — so the poison is planted, then the outer
`beforeEach` scrubs it. If that ordering ever changed, the poison would survive into the test and
`defaultModels.claude` would come back `'decoy-model'`, so the assertion **fails loudly rather than
passing vacuously**. That is the property that makes this test worth having; a test that asserts
`process.env.CLAUDE_CONFIG_DIR === undefined` inside the body would be a tautology over the line
above it.

`afterAll` does not need to restore the variable: the outer `afterEach` already restores the
process-wide saved value after every test in the file, including these.

### D4 — Nothing outside the test file changes

`paths.ts`, `catalog.ts`, `models.ts` and the strategies are correct as written.
`.ai/specs/2026-08-14-claude-subscription-autodetect.md` D1 states the precedence deliberately:

> `discoverClaudeAccounts()` considers `agentHomePaths(env).claude` first (so with
> `CLAUDE_CONFIG_DIR` set on the cezar process the row labelled default is the dir cezar actually
> spawns agents with)

and `discoverAgentAccounts` (`workspace/agent-account-identity.ts:212-218`) carries the same
reasoning in a comment. Making `HOME` win would break a valid production configuration — including
this box's own second-account setup — to fix a test.

`packages/cezar/src/paths.test.ts` asserts the override behaviour directly and must keep passing
untouched.

### D5 — `vitest.setup.ts` is out of scope for this change

Per §"Corrections to the brief" (1). The global scrub is a strictly better long-term shape and it is
already written on `cez/6509be16`; duplicating it here creates a conflict and no new coverage. The
two are compatible if that branch lands: a `delete` of an already-deleted key is a no-op, and
restoring `undefined` to an already-`undefined` key is a no-op. If `cez/6509be16` merges first, this
change still applies cleanly and the suite-local guard becomes belt-and-braces — which is the
discipline `.ai/specs/2026-08-21-npm-test-gate-environment-scrub.md:600-605` already asks for
("a suite that wants a real ambient value now has to set it itself").

## Architecture

No new module, no new concept. The change lives entirely inside one suite's env-ownership block. The
rule it instantiates is already the repo's:

> A validation gate scrubs the ambient variables it does not mean to test; a suite that *does* test
> a variable owns its setup and restoration locally.
> (`.ai/specs/2026-08-21-npm-test-gate-environment-scrub.md:419-437`, commit `1c225e7e`)

Ownership map for the three legs of the assertion under test, after this change:

| runner | native settings file | env inputs on the resolution path | owned by the fixture? |
| --- | --- | --- | --- |
| `claude` | `join(home.claude,'settings.json')` (`catalog.ts:88`) | `CLAUDE_CONFIG_DIR` → `HOME`; `ANTHROPIC_MODEL` (short-circuit) | **new in P1 / P3** |
| `codex` | `join(home.codex,'config.toml')` | `CODEX_HOME` → `HOME` | yes (`:36`) |
| `opencode` | `join(home.opencodeConfig,'opencode.json')` (`catalog.ts:244`) | `XDG_CONFIG_HOME` → `HOME` | yes (`:37`) |
| `pi` | none catalogued | none | n/a |

## Data models and API contracts

None. `GET /api/v1/config`'s response shape, `AgentModelDefaults`
(`packages/cezar/src/agent-config/models.ts:9`) and the `ConfigFileDef` catalog are untouched. No
migration, no stored state, no wire change — so `BACKWARD_COMPATIBILITY.md` is not engaged even
though this is one of the two repos where it would be.

## Phases

Independently shippable, in order. P1 alone satisfies the task's acceptance criteria 1 and 3; P2 is
the evidence for criterion 2 and writes no code.

**P1 — `CLAUDE_CONFIG_DIR` guard.** `packages/cezar/src/server/config-api.test.ts` only. Add
`savedClaudeConfigDir` next to `savedXdgConfigHome` (`:27`), `delete process.env.CLAUDE_CONFIG_DIR`
in `beforeEach` next to the `CEZ_AGENT_MODELS_LOCKED` delete (`:38`), and the two-branch restore in
`afterEach` next to its neighbours (`:57-58`). One comment saying *why* deleted and not repointed
(D1), citing `paths.ts:256-263`. **Closes AC1.**

**P2 — Record the sweep (no code).** Criterion 2 asks for a grep of `home.claude` consumers. Done in
this step; the result is a table, not a change. The full candidate set is every `*.test.ts` that
assigns `process.env.HOME`:

| file | fake `$HOME/.claude`? | reads `process.env`? | verdict |
| --- | --- | --- | --- |
| `server/config-api.test.ts` | yes (`:99-105`) | yes (`server.ts:6720`) | **the defect — P1** |
| `server/agent-profiles-discovered-api.test.ts` | yes | yes | already guarded (`:30,:53,:66`) |
| `workspace/agent-accounts-auto.test.ts` | yes (`:190-193`) | no — literal env object (`:45-49`) | immune |
| `workspace/boot-repo.test.ts` | no — a **repo-local** `.claude/` inside a fixture checkout (`:36-37`); the `HOME` move at `:92` is for git identity | n/a | immune |
| `server/fs-browse.test.ts`, `server/projects-git-init-api.test.ts`, `workspace/home-safety.test.ts`, `server-install/platforms/macosx-ngrok.test.ts`, `test/unit/skills-remote.test.ts` | no `.claude` fixture | n/a | immune |

Suites that pass an explicit env and are therefore immune by construction, re-confirmed:
`agent-config/models.test.ts:32-65`, `agent-config/files.test.ts`, `agent-config/catalog.test.ts`,
`workspace/agent-account-identity.test.ts`. Suites that *intentionally* set `CLAUDE_CONFIG_DIR`
(`paths.test.ts`, `core/agent-env.test.ts`, `core/agent-profiles.test.ts`,
`server/provider-action-gating.test.ts`, `cluster/node-identity.test.ts`, …) are testing the
override and must not be touched. **Closes AC2.**

**P3 — `ANTHROPIC_MODEL` guard.** Same file, same three insertion points, per D2. Separable from P1;
drop it without consequence if a reviewer disagrees with the widening.

**P4 — The machine-independent regression, per D3.** Nested `describe` + `beforeAll` poison. Needs
`beforeAll`/`afterAll` added to the `vitest` import at `:5`. If P3 shipped, poison
`ANTHROPIC_MODEL='decoy-model'` in the same `beforeAll` and assert `'sonnet'` still wins — one test
covering both guards.

**P5 — Mark the stale record in place.** House rule: a correction edits what it invalidates.
`.ai/specs/2026-08-22-per-task-prompt-drafts-qa-and-closeout.md:277-289` currently reads as a live,
open "third environment trap"; that is the first thing a future session grepping for this failure
finds. Add a bolded `CORRECTED 2026-08-24 by .ai/specs/2026-08-24-config-api-env-isolation.md — the
fixture now owns CLAUDE_CONFIG_DIR` lead-in, leaving the original text below it unchanged. Do **not**
amend `AGENTS.md` §"Five environment traps": that section is about scrubbing the *gate's* env, its
recipe is still correct, and nothing in its trap list is invalidated by a suite-local guard.

**P6 — Close the record in the corpus (during the `document` step; P7 runs after it).** A code change that
never reaches the knowledge base is invisible to the next session, and this exact defect has already
been diagnosed twice without being fixed — so the closeout is part of the work, not a courtesy.

1. Append a changelog **upsert** as one NDJSON line to `$CEZ_KB_WRITE_FILE` (never edit a mounted
   corpus document directly). Read the file first and continue its `seq` numbering; `runId` is
   `$CEZ_TASK_ID`, `createdAt` an ISO-8601 timestamp:
   ```jsonc
   {"op":"upsert","scope":"project","path":"changelog/2026-08-24-config-api-env-isolation.md",
    "title":"Fixed: config-api test no longer reads ambient CLAUDE_CONFIG_DIR","type":"note",
    "tags":["cezar","testing","notion-changelog"],
    "body":"<cause · fix · gate result · commit · deploy status>","seq":<n>,"runId":"…","createdAt":"…"}
   ```
   The body must state all five, concretely: the **cause** (`agentHomePaths` resolves
   `CLAUDE_CONFIG_DIR` before `$HOME/.claude`, `paths.ts:256-263`, and the fixture never owned it);
   the **fix** (suite-local save/delete/restore in `config-api.test.ts`, plus P3/P4 if they shipped);
   the **hostile-environment gate result** — the verbatim summary line from Verification step 4
   command 2, run *with* `CLAUDE_CONFIG_DIR` exported, against the prior 1 failed / 11775 passed; the
   **commit** hash; and the **deployment status**, which is **not** "test-only, ships nothing".
   `AGENTS.md:7` — *"every change to cezar is always committed, pushed, and deployed — the full loop,
   no per-session ask"* — admits no behaviourally-unchanged exemption, and the `deploy` step's
   `all-services-deployed` post-condition (`workflows/postconditions.ts`, `workflows/types.ts:1443-1447`)
   is red for a repo that ships nothing at all. At `document` time the honest value is therefore
   **PENDING — P7 has not run yet**; P7 replaces it with the release id and the live sha the running
   process reports. Do not write "no deploy needed": that is the sentence this repo's deploy gate
   exists to stop.
2. Update this spec's `Status:` line from `SPEC — not implemented` to `IMPLEMENTED <date> in
   <commit>` (or `PARTIAL`, naming the phases dropped) in the same step.
3. **Corpus sync is not complete until an exact-title search finds it.** The upsert is a *proposal*,
   applied later through the cockpit or `cez kb proposals`, and a corpus write is not a KB write
   until the index moves. So verify:
   ```bash
   cez kb search "config-api test no longer reads ambient CLAUDE_CONFIG_DIR"
   ```
   If it returns the entry, record sync as **done**. If the proposal is still unapplied — the
   expected case in the same session — record sync as **PENDING** in the handoff and the final
   report, naming the proposal, rather than claiming a closeout that has not happened.

**P7 — Deploy the committed sha (runs last, in the `deploy` step).** Ships no behaviour change, and
ships anyway. Three reasons this is not a phase to skip, none of them stylistic:

1. **The rule has no "runtime bytes unchanged" carve-out.** `AGENTS.md:7` makes commit → push →
   deploy the standing loop for *every* change to cezar, and `spec-to-deploy` (this run's workflow)
   ends in a `deploy` step by construction (`workflows/types.ts:1439-1470`).
2. **The gate is machine-checked, so "nothing to deploy" reads as red, not as skipped.** The step
   carries `verify: { builtin: 'all-services-deployed', max: 1 }` (`types.ts:1447`) and is green only
   when **every** probe in `.ai/deploy-targets.json` exits 0 — both of them, because cezar is two
   services and shipping one alone used to end this step green.
3. **The bytes are not in fact identical.** `packages/cezar/src/server/config-api.test.ts` is not in
   the published `dist`, but the release id and the ledger `sha` are HEAD-derived
   (`server-install/release-deploy.ts:444-446`, `releases.ts:44-52`), so leaving this commit
   undeployed leaves the live server reporting a sha that predates it — which is exactly the state
   the backend probe is written to call out.

Mechanics and the executable proof are Verification step 7. Nothing about the deploy is specific to
this change: it is the box's documented rootless blue-green path, from a **user** transient unit.

## Risks

- **The nested-`beforeAll` ordering in P4.** If vitest's hook order ever changed, the poison would
  reach the test body. It fails closed (assertion mismatch on `'decoy-model'`), so the cost is a red
  test with an obvious cause, not a silent hole. Named here so a future reader does not "fix" the
  ordering by moving the poison into a `beforeEach`, where it would run *after* the outer scrub and
  break the test permanently.
- **Merge collision with `cez/6509be16`.** Mitigated by D5 — that branch touches `vitest.setup.ts`
  and `agent-profiles-discovered-api.test.ts`; this one touches neither. Confirm before committing:
  `git diff --stat` should list `config-api.test.ts`, this spec, and (P5) the prompt-drafts spec, and
  nothing else.
- **Cross-file `process.env` bleed inside a worker.** `packages/cezar/vitest.config.ts` sets
  `maxWorkers` but not `isolate: false`; `process.env` mutations can still outlive a file if a worker
  is reused. The save/restore in `afterEach` is what bounds that, and this change only extends an
  existing, already-correct restore block. Not a new exposure.
- **A known unrelated flake will show up in the full-gate run.** `catalog.test.ts` C18 ("stays under
  40ms CPU per MiB of scanned corpus") is a documented host-load flake
  (`.ai/specs/2026-08-22-per-task-prompt-drafts-qa-and-closeout.md:276-278`). If it fires during
  Verification step 4, it is not this change and must be reported as such, not rounded into green.
- **The gate scrub does not remove `CLAUDE_CONFIG_DIR`.** `AGENTS.md`'s recipe unsets `CEZ_*` and
  `NODE_ENV` only, so a session that runs the scrubbed recipe still carries this variable. That is
  precisely why AC3 ("green *with* `CLAUDE_CONFIG_DIR` exported") is the meaningful criterion and why
  Verification step 4 re-exports it explicitly rather than relying on the ambient value.

## Verification

Executable steps, in order. Step 1 is the negative control that keeps the rest honest; steps 2-3 are
the focused proof; step 3b is the negative control for the *new* test, which step 1 does not provide;
step 4 is the gate criterion; step 5 is the cross-check on step 4; step 6 bounds the diff; step 7 is
the deploy and its two live probes. Steps 1-6 run from the worktree root after `npm ci`; step 7 runs
from the source checkout, after commit and push.

**Run vitest through `npm`, never `npx vitest`** (`AGENTS.md:239-247`): vitest is a devDependency of
this repo, so `npm test` uses the pinned binary while `npx` reaches past it and fetches a different
version from the registry — a slow, networked, silently-different run. Narrow a run by passing
vitest's own arguments after `--`.

1. **Negative control — confirm the failure is real on this exact tree.** This workflow runs
   `implement` *before* `run-tests`, so "before any edit" cannot be deferred to this step: reach the
   pre-change state by stashing the one source file, measure, then restore it immediately.
   ```bash
   git stash push -- packages/cezar/src/server/config-api.test.ts
   CLAUDE_CONFIG_DIR=/var/lib/cezar/.claude-secondary \
     npm test -- packages/cezar/src/server/config-api.test.ts
   git stash pop        # ALWAYS — including when the run above fails or is interrupted
   ```
   The stash is **path-scoped on purpose**: P5's spec edit and this spec must not move with it, and
   `git stash pop` must run even on a red result, or the implementation is left stashed and every
   later step measures the wrong tree. Confirm with `git stash list` → empty and
   `git diff --name-only` → the P1 file back in place before continuing.

   Expect **1 failed / 14 passed** (the file has 15 `it(` blocks before P4), the failure being
   `uses the coding agents' native model settings as the initial defaults`, with `defaultModels`
   missing its `claude` key. If it passes, stop — the premise has changed and this spec needs
   re-deriving, not implementing.

2. **After P1 (and P3/P4), same hostile variable → green.**
   ```bash
   CLAUDE_CONFIG_DIR=/var/lib/cezar/.claude-secondary \
     npm test -- packages/cezar/src/server/config-api.test.ts
   ```
   → **0 failed / 16 passed** (15 existing `it(` blocks plus the one P4 adds; 15 passed if P4 was
   dropped). Then the poisoned-`ANTHROPIC_MODEL` variant, which must also pass once P3 lands and
   would have failed before it:
   ```bash
   CLAUDE_CONFIG_DIR=/var/lib/cezar/.claude-secondary ANTHROPIC_MODEL=decoy-model \
     npm test -- packages/cezar/src/server/config-api.test.ts
   ```

3. **No regression when the variable is genuinely absent** (the CI shape):
   ```bash
   env -u CLAUDE_CONFIG_DIR -u ANTHROPIC_MODEL \
     npm test -- packages/cezar/src/server/config-api.test.ts
   ```
   → **16 passed** (15 without P4) — the same count as step 2, since nothing here is environment
   -conditional. With P4 in place this run also exercises the guard, because the decoy is planted by
   the suite itself rather than by the machine — that is the whole point of D3.

3b. **Negative proof for P4 itself — that the new test can actually fail.** Step 1 is *not* this
   proof and must not be read as one: its stash removes the D1/D2 guard **and** the P4 test together,
   so all it re-establishes is that the pre-existing assertion breaks on an ambient-poisoned host. It
   says nothing about whether P4 would catch a future regression, and a nested-hook test that passes
   in every configuration is exactly the vacuous shape D3 was written to avoid.

   So remove **only the guard**, keeping P4:
   ```bash
   cp packages/cezar/src/server/config-api.test.ts /tmp/config-api.test.ts.bak   # restore point
   # Edit the file: comment out ONLY the D1/D2 scrub lines in the outer `beforeEach` — the
   # `delete process.env.CLAUDE_CONFIG_DIR` (and, if P3 shipped, `delete process.env.ANTHROPIC_MODEL`).
   # Leave the nested `describe('with a hostile ambient Claude config dir', …)` from D3 fully in place.
   env -u CLAUDE_CONFIG_DIR -u ANTHROPIC_MODEL \
     npm test -- packages/cezar/src/server/config-api.test.ts; echo "EXIT=$?"
   ```
   → **must be non-zero, with exactly one failing test**: the nested `still reads the fake HOME, not
   the ambient override`, and its diff **must name `decoy-model`** — the value the suite's own
   `beforeAll` planted, arriving in `defaultModels.claude`. Run it with the ambient variables
   *unset* on purpose: the failure must come from the suite's decoy, not from this box's
   `/var/lib/cezar/.claude-secondary`, or the test is only re-proving step 1. A failure that reports
   a **missing** `claude` key instead, or a pass, means P4 is vacuous — rewrite it before shipping,
   do not restore-and-continue.

   Then restore and confirm green:
   ```bash
   cp /tmp/config-api.test.ts.bak packages/cezar/src/server/config-api.test.ts
   env -u CLAUDE_CONFIG_DIR -u ANTHROPIC_MODEL \
     npm test -- packages/cezar/src/server/config-api.test.ts; echo "EXIT=$?"   # 0, same counts as step 3
   git diff --stat packages/cezar/src/server/config-api.test.ts    # must match what step 2 measured
   ```
   Restore from the copy, **not** `git checkout --` — that file is uncommitted at this point in the
   workflow and checking it out would discard P1/P3/P4 entirely. Skip this step only if P4 was
   dropped, and say so explicitly in the report rather than leaving it unmentioned.

4. **AC3 — the repository's full five-command gate, with the variable deliberately exported.**
   `AGENTS.md:225-247` names exactly five commands and this repo has **no `lint` script** (verified:
   `package.json` `scripts` has `typecheck`, `test`, `test:unit`, `build`, `test:package` and no
   `lint`), so there is no separate static-lint step to run. Every one of the five must exit `0`
   before commit, push or deploy — a non-zero exit anywhere stops the workflow and gets quoted, not
   rounded into green.
   **The block below is fail-closed by construction, not by instruction.** An earlier draft chained
   the commands with `; echo "… EXIT=$?"`, which *reports* each status and then runs the next command
   anyway — so a failed `npm ci` or a red `npm test` still ended with `test:package` printing green,
   and the block as a whole exited 0. That is the exact "gates that LIE" shape this spec exists to
   remove. Every command below is status-checked and the first non-zero exit aborts the run.

   Run it as a **script**, not pasted into an interactive shell: it calls `exit`, which would close
   an interactive session rather than stopping the gate.
   ```bash
   cat > /tmp/cez-gate.sh <<'SH'
   set -u -o pipefail
   scrub=$(env | sed -n 's/^\(CEZ_[A-Z0-9_]*\)=.*/\1/p' \
           | grep -vxE 'CEZ_(HANDOFF_FILE|TASK_ID)' | sed 's/^/-u /')
   tmp=$(mktemp -d /tmp/cez-gate-XXXXXX)
   G="env -u NODE_ENV $scrub TMPDIR=$tmp TMP=$tmp TEMP=$tmp"
   log=$tmp/hostile-test.log
   gate() { echo "--- $*"; "$@"; s=$?; echo "EXIT=$s"
            [ "$s" = 0 ] || { echo "GATE FAILED (exit $s): $*"; exit "$s"; }; }
   gate $G npm ci                                                     # 0 — install, gated like the rest
   gate $G npm run typecheck                                          # 1 (runs build:server first)
   # 2 — the hostile-env run. tee'd so its summary can be quoted; PIPESTATUS so tee's 0 cannot mask a red.
   $G CLAUDE_CONFIG_DIR=/var/lib/cezar/.claude-secondary npm test 2>&1 | tee "$log"
   s=${PIPESTATUS[0]}; echo "test EXIT=$s"
   grep -E '^[[:space:]]*(Test Files|Tests)[[:space:]]' "$log" | tail -2   # ← quote these verbatim
   [ "$s" = 0 ] || { echo "GATE FAILED (exit $s): hostile-env npm test"; exit "$s"; }
   gate $G npm run test:unit                                          # 3
   gate $G npm run build                                              # 4
   gate $G npm run test:package                                       # 5 (needs 4 to have run)
   echo "ALL FIVE GATES GREEN"
   SH
   bash /tmp/cez-gate.sh; echo "GATE SCRIPT EXIT=$?"     # must be 0, and must print ALL FIVE GATES GREEN
   ```
   `bash` (not `sh`) is required: `PIPESTATUS` and `-o pipefail` are bashisms. A run that stops early
   prints `GATE FAILED (exit N): <command>` as its last line — quote that line and the failing
   command's output in the run-tests report, and do not proceed to commit, push or deploy.

   Command 2 is the one AC3 is about: → **0 failed**. Quote its summary line verbatim in the
   run-tests report. The prior measurement to beat is 1 failed / 11775 passed. `TMPDIR` is redirected
   out of the repo and `test:package` runs after `build` because both are documented gate traps
   (`AGENTS.md` §"Five environment traps that make the gates LIE").

5. **Cross-check against the unpoisoned run.** Same scrub, `CLAUDE_CONFIG_DIR` and `ANTHROPIC_MODEL`
   removed instead of exported.

   Two mechanical traps, both of which made an earlier draft of this step non-executable. `$G` is
   defined *inside* step 4's script and does not survive it, so redefine it here. And `$G` already
   ends in `NAME=VALUE` operands, while GNU `env` requires **options before operands** — so
   `$G -u CLAUDE_CONFIG_DIR npm test` makes `-u` the program name and dies with
   `env: '-u': No such file or directory`, never running the suite at all
   ([GNU coreutils, `env` invocation](https://www.gnu.org/s/coreutils/manual/html_node/env-invocation.html)).
   Put the `-u`s in an **outer** `env`:
   ```bash
   scrub=$(env | sed -n 's/^\(CEZ_[A-Z0-9_]*\)=.*/\1/p' \
           | grep -vxE 'CEZ_(HANDOFF_FILE|TASK_ID)' | sed 's/^/-u /')
   tmp=$(mktemp -d /tmp/cez-gate-XXXXXX)
   G="env -u NODE_ENV $scrub TMPDIR=$tmp TMP=$tmp TEMP=$tmp"
   env -u CLAUDE_CONFIG_DIR -u ANTHROPIC_MODEL $G npm test; echo "EXIT=$?"
   ```
   Equivalently, fold them into the definition —
   `G="env -u NODE_ENV -u CLAUDE_CONFIG_DIR -u ANTHROPIC_MODEL $scrub TMPDIR=$tmp …"`. What must not
   happen either way is a `-u` appearing *after* an assignment.

   Its **total test count must equal command 2's in step 4, and both must report zero failures.** If
   step 4 is green but the counts differ, a test is being *skipped* rather than fixed — the guard
   would then be hiding the assertion instead of isolating it — and the criterion is not met.

6. **Diff discipline.** `git diff --name-only` lists exactly: `packages/cezar/src/server/config-api.test.ts`,
   `.ai/specs/2026-08-24-config-api-env-isolation.md`,
   `.ai/specs/briefs/2026-08-24-config-api-claude-env-isolation.md`, and — only if P5 ran —
   `.ai/specs/2026-08-22-per-task-prompt-drafts-qa-and-closeout.md`. Any other path, in particular
   `packages/cezar/vitest.setup.ts`, means D5 was violated.

7. **Deploy the committed sha, and prove the running process is serving it** (P7, the `deploy` step).
   Runs **after** commit and push, and after P6's documentation. `<src>` below is a checkout whose
   HEAD *is* the commit being shipped — normally the main checkout at
   `/var/lib/cezar/loki-labs/cezar` after `git -C /var/lib/cezar/loki-labs/cezar pull --ff-only`, not
   this task's worktree under `.ai/cezar/worktrees/` (release staging deliberately excludes those:
   `.ai/specs/2026-08-22-release-staging-excludes-worktrees-and-tmp.md`).

   **7a. Rebuild after committing, or staging refuses.** `npm run build` writes
   `packages/cezar/dist/.build-stamp.json`, and `server-deploy` refuses to stage when that stamp is
   missing, unreadable, older than `packages/*/src`, or names a sha that disagrees with the source
   checkout's HEAD (`server-install/release-deploy.ts:90-128`, gated at `:391-405`). Step 4's build
   ran *before* the commit existed, so its stamp names the wrong sha and this rebuild is mandatory,
   not hygiene:
   ```bash
   SHA=$(git -C <src> rev-parse HEAD); echo "shipping $SHA"
   (cd <src> && npm run build); echo "build EXIT=$?"        # must be 0
   node -e 'const s=require("<src>/packages/cezar/dist/.build-stamp.json");console.log(s.sha,s.dirty,s.builtAt)'
   ```
   The printed sha **must equal `$SHA`** and `dirty` must be `false`. If it does not, stop: staging
   would refuse anyway, and forcing past it is how a stale `dist` ships under a fresh label
   (`.ai/specs/2026-08-22-live-worktree-reaped-mid-run.md`, commit `362865ec`).

   **7b. Rootless blue-green, from a USER transient unit** (`AGENTS.md:13`;
   `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md:118-136`). On `prod-host`,
   `/opt/cezar` is a **symlink** into `/opt/cezar-releases/`, so the older `dist`-swap + `kill -9`
   recipe would mutate the live release in place and destroy what rollback depends on — do not use
   it, and do not use `--strategy=restart` here. A *system* `systemd-run` is correctly denied to the
   `cezar` user (that unit would run as root; do not "fix" it with a polkit grant); a **user**
   transient unit works unprivileged because this box has `Linger=yes` and a live `user@999.service`.
   ```bash
   export XDG_RUNTIME_DIR=/run/user/999 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/999/bus
   systemd-run --user --unit=cez-deploy-$SHA --collect --property=Type=oneshot \
     --property=TimeoutStartSec=900 --working-directory=<src> \
     --setenv=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
     /usr/bin/node packages/cezar/dist/index.js server-deploy --strategy=blue-green \
     --source=<src> --sha=$SHA
   journalctl --user -u cez-deploy-$SHA -n 300 --no-pager     # READ the outcome; do not assume it
   ```
   The cutover SIGKILLs nothing of this session's own process group on this box, but if the deploy
   fails its readiness probe, roll back with `cezar server-deploy --rollback=` (bare `--rollback`
   also works since 2026-08-23, `.ai/specs/2026-08-23-bare-rollback-argv-trap.md`) and report the
   failure rather than retrying blind.

   **7c. Every probe in `.ai/deploy-targets.json` must exit 0 — both of them.** This is the literal
   post-condition the `deploy` step is scored on (`workflows/postconditions.ts`, builtin
   `all-services-deployed`), and it is two targets because cezar is two services: shipping the UI
   without the backend used to end this step green. Run them exactly as the harness does, from the
   repo root:
   ```bash
   for i in 0 1; do
     p=$(node -e 'const t=require("./.ai/deploy-targets.json").targets['"$i"'];process.stdout.write(t.probe)')
     bash -lc "$p"; echo "PROBE $i EXIT=$?"
   done
   ```
   Both must print `EXIT=0`, and their stdout must be quoted in the deploy report:
   - probe 0 (backend) polls `GET /api/v1/ready` and passes only when the **running** process reports
     a deploy sha equal to `$SHA` or descended from it — a stale marker file cannot forge it;
   - probe 1 (UI) polls `GET /` and passes only when the served HTML names the `assets/index-*.js`
     bundle in the deployed tree.

   **Delivery is not activation.** A new dist tree copied into place with the old resident server
   still answering is precisely what reads like a completed deploy, which is why neither probe checks
   the filesystem alone.

**Runtime E2E — what this change does and does not get.** It alters no product code path: the
resolver behaves identically before and after, and there is no user-visible behaviour a device or
cockpit pass could observe. In that narrow sense step 4 *is* the substantive verification, and this
is the rare case where "gates green" is sufficient rather than merely necessary — the artifact under
test is the gate itself.

That is **not** a reason to stop before step 7, and the earlier draft of this paragraph, which ended
the verification at step 4, was wrong to imply it. Step 7c is the runtime evidence this change gets:
two probes against the live process, at the committed sha. Until both have exited 0, the honest
status is **shipped, not deployed** — say that, rather than rounding a green gate up into a green
deploy.

## Closeout evidence (2026-08-25)

- Implementation phases P1 through P4 and the in-place stale-record correction P5 landed in
  `fe4287c2b4e1991206da753511be41541df0cf72`, then reached `origin/main` at merge commit
  `f153b53759af33f7f06cc98f7826e985ed6f55d5`.
- The recorded run-tests gate completed `npm ci` and `npm run typecheck`, then stopped fail-closed on
  the hostile full suite. Its exact summary was `Test Files  6 failed | 619 passed | 2 skipped (627)`
  and `Tests  16 failed | 11732 passed | 4 skipped (11752)`, exit 1. The failures were in six
  unrelated suites: knowledge catalog, sources scheduler, discovered account API, pasted attachments,
  stopped steps, and system prompt. `test:unit`, build, and package tests were not run after the gate
  stopped. The targeted config-api result is not separately claimed here because the run record does
  not preserve a focused summary.
- Deployment was not performed in this document step. The next deploy step must rebuild the landed
  sha, activate it through the documented blue-green path, and pass both service probes.

## Record

- Brief: `.ai/specs/briefs/2026-08-24-config-api-claude-env-isolation.md`
- Prior diagnosis, to be corrected in place by P5:
  `.ai/specs/2026-08-22-per-task-prompt-drafts-qa-and-closeout.md:277-289`
- Precedence decision that must not change: `.ai/specs/2026-08-14-claude-subscription-autodetect.md`
  D1 (KB `specs-362123d36be2`)
- Gate-environment doctrine: `.ai/specs/2026-08-21-npm-test-gate-environment-scrub.md:419-437,585-610`
  (KB `specs-cb279cda3c66`), commit `1c225e7e`; `AGENTS.md` §"Five environment traps that make the
  gates LIE"
- In-flight, overlapping, **not on `main`**: commit `2888f117` on `origin/cez/6509be16`, with
  `.ai/specs/2026-08-24-isolate-discovered-account-tests.md` (KB `notion-82e42a379b69`) — see D5
- Origin of the gap: commit `d6385531` (#726)
- Code re-read at `b3d3a44c`: `packages/cezar/src/paths.ts:240-263`,
  `packages/cezar/src/agent-config/catalog.ts:82-99,145-160,240-277`,
  `packages/cezar/src/agent-config/models.ts:1-52`,
  `packages/cezar/src/agent-config/model-settings/{claude,codex,opencode,pi,shared}.ts`,
  `packages/cezar/src/server/server.ts:6718-6742`,
  `packages/cezar/src/server/config-api.test.ts:1-145`,
  `packages/cezar/src/server/agent-profiles-discovered-api.test.ts:1-75`,
  `packages/cezar/src/workspace/agent-accounts-auto.test.ts:1-215`,
  `packages/cezar/src/workspace/agent-account-identity.ts:180-230`,
  `packages/cezar/vitest.setup.ts`, `packages/cezar/vitest.config.ts`
- Not found: no `tools/next-spec` allocator exists in this repo (`ls tools/` → no such directory);
  cezar specs are date-named, not numbered, so this file follows `YYYY-MM-DD-<3-4 words>.md` as every
  neighbour in `.ai/specs/` does.
