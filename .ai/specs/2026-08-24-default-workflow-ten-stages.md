# The default workflow becomes ten stages

**Status:** Partial 2026-08-24. Implementation exists in the task worktree. Typecheck and the focused 57-test gate pass, while the full suite has 9 reproduced baseline-failure files and 20 tests; commit and push are blocked, and runtime QA has not run. QA Needed.
**Date:** 2026-08-24
**Repo:** `cezar`
**Brief:** `.ai/specs/briefs/2026-08-24-default-workflow-revision.md` (KB `specs-8512200feb66`)

**Extends:**
`.ai/specs/2026-08-19-spec-to-deploy-default-workflow.md` (KB `specs-e01401118cd2`, the chain itself),
`.ai/specs/2026-08-20-split-steps-spec-review-and-approval-gate.md` (KB `specs-9a01e3bf2eeb`, the front-half split and the approval gate),
`.ai/specs/2026-08-20-steps-green-only-when-verified.md` (post-conditions, commit `57fc8807`),
`.ai/specs/2026-08-24-codex-step-model-and-effort.md` (`byRunner`, `effort` on codex),
`.ai/specs/2026-08-23-never-block-a-task.md` (the availability ladder),
KB `notion-c20835e294bf`, *"2026-08-23 — The gate that authorises a push is the one on the MERGED
tree, not the branch gate"*
(`notion-export/knowledge/sections/328-2026-08-23-merged-tree-gate-not-branch-gate--local.md`).
D3's Mode B **applies** that entry's rule and does not supersede it: a base branch that moved
under a run spends the branch gate, so stage 8 reds and re-runs the gate on the merged tree.

**Supersedes, in place — two published claims, both corrected in Phase 6:**

1. The standing "always self-deploy cezar, including from inside a running cockpit session"
   instruction at `AGENTS.md:12`, for **agent-run workflow deployment only**. See D6.
2. The **"never auto-merges" product guarantee**, stated five times: `AGENTS.md:3` ("ends at a
   review gate (never auto-merges)"), `AGENTS.md:9` ("those still end at the review gate and never
   auto-merge"), `README.md:104` ("never an auto-merge"), `README.md:192` ("cezar never
   auto-merges"), `README.md:252` ("Nothing auto-merges: a run with changes rests in `review` until
   you act on it"). `spec-to-deploy` is the default workflow for **every** repo cezar runs in
   (`packages/cezar/src/index.ts:139`, `packages/cezar/src/server/server.ts:2533`), so a
   mandatory, unconditional merge step would make all five false by default in a released npm
   package. D4 therefore puts stage 8 behind an explicit per-checkout opt-in that is **off by
   default**, and Phase 6 amends all five lines to state the opt-in rather than deleting the
   guarantee. This is decided here, not left to be discovered during implementation.

## TLDR

The owner restated the default pipeline as ten stages:

| # | Stage | Today |
| --- | --- | --- |
| 1 | Gather the record | `context`, unchanged |
| 2 | Write the spec (Opus, fall back if unavailable) | `spec`, Opus pinned; the fallback exists but lands on an unchosen model |
| 3 | Auto-review the spec (SOL xhigh) | `review-spec`, pinned to Claude Opus |
| 4 | Manual review (optional, N approvers) | `requiresApproval` on `review-spec`, already exactly this |
| 5 | Implement | `implement`, unchanged |
| 6 | Run the tests | `run-tests`, unchanged |
| 7 | Commit and push, without re-running green tests | `commit-push`; no durable proof of what was tested |
| 8 | Merge to the repo's base branch | folded into `commit-push` as "push **or** PR **or** merge" |
| 9 | Update the knowledge base | `document`, already before deploy but before the merge too |
| 10 | Deploy, except never the cezar service | `deploy`, deploys everything including cezar |

Five of the ten are already right. This spec changes the other five:

1. **Model policy.** `review-spec` moves to codex `gpt-5.6-sol` at `xhigh`. `spec` stays Opus-first
   and gains an explicit named landing spot for the cross-provider downgrade it can already take.
2. **A test attestation.** `run-tests` records the exact tree it made green; `commit-push` and
   `merge` prove the shipped commit is that tree. "Do not re-run tests that passed" becomes a
   verified claim instead of a sentence in a prompt.
3. **A separate `merge` step** with its own post-condition: green only when HEAD is an ancestor of
   the base branch on the remote — and only in a checkout that has opted in (`autoMerge`, default
   **off**), because "cezar never auto-merges" is a published guarantee in a released package.
4. **A handoff park.** A run that reaches work only a human may perform parks at `waiting` with a
   persisted `pendingHandoff`, and the cockpit reads "Awaiting manual deployment". No published
   status enum is widened.
5. **Manual deploy targets.** `.ai/deploy-targets.json` entries gain `manual: true`. The `deploy`
   step deploys every automatic target and hands the manual ones to a person. cezar's own file
   marks both of its targets manual; every other repo is unaffected and stays fully automatic.

## Problem

### P1. "Opus, fall back if unavailable" is true but lands nowhere

`spec` pins `model: SPEC_AUTHORING_MODEL` (`'opus'`) and `runner: SPEC_AUTHORING_RUNNER`
(`'claude'`) (`packages/cezar/src/workflows/types.ts:748`, `:766`). The fallback the owner asks for
already exists and is already policy: `.ai/specs/2026-08-23-never-block-a-task.md` ruled that
availability outranks the pick, and its ladder descends to another account of the same provider,
then to another provider entirely, announcing the downgrade.

The gap is what happens **after** it crosses providers. `modelForBackend`
(`packages/cezar/src/workflows/run.ts:1408-1421`) drops a pin that names another runner's model and
returns `undefined`, so the step runs on the new backend's own default. Measured and recorded in
`.ai/specs/2026-08-24-codex-step-model-and-effort.md`: on `prod-host` that default is
`gpt-5.6-sol` with `reasoningEffort: null`, the most expensive model in the catalog at its
shallowest setting. So the spec-writing step's fallback is real, and it is unchosen.

### P2. The reviewer is not the model the owner asked for

`review-spec` pins the same Opus and the same `runner: 'claude'`
(`packages/cezar/src/workflows/types.ts:1090-1091`). The owner asks for SOL xhigh. That is a policy
change, not a defect repair, and it contradicts the 2026-08-22 instruction quoted at
`types.ts:751-756` ("writing spec + spec review should be by opus always"). It has to be recorded
as a correction of that instruction, not appended beside it.

### P3. Nothing proves the tested revision is the shipped revision

`run-tests` cannot commit or push (`types.ts:1199-1200`, the allowlist borrowed from
`AUTONOMOUS_IMPLEMENTATION_WORKFLOW`), and `commit-push`'s prompt does not ask it to re-run
anything. So "do not re-run tests if they passed" is already the behaviour. What is missing is the
other half: nothing detects that the tree **changed** between the green gate and the commit. An
agent that edits one file while writing the commit message ships an untested tree, and
`everything-committed` (`packages/cezar/src/workflows/postconditions.ts:126-183`) will happily call
that green, because it only asks whether the tree is clean and pushed.

Splitting the merge out of `commit-push` makes this worse, not better: a merge that resolves a
conflict edits code after the gate by construction.

### P4. Merge is optional and undeclared

`commit-push` is told to "ship it the way this repo ships": push a branch, or open a PR, or merge
one (`types.ts:1291-1300`). Its post-condition, `everything-committed`, is satisfied by a clean tree
whose branch is in sync with **its own** upstream. A task branch pushed to `origin/cez/abc` and
never merged is green today. The owner wants stage 8 to be a real stage with a real target: the
base branch of the repo.

### P5. The record is written before the merge, and its own commit is not merged

`document` runs after `commit-push` and commits the KB, spec-status and tracker edits
(`types.ts:1313-1387`). In the ten-stage order, knowledge is stage 9, after the merge at stage 8.
That means `document`'s own commit lands after the merge and needs to reach the base branch too, or
the record ships to a branch nobody reads.

### P6. cezar deploys itself, and the owner has withdrawn that

`deploy` gets unrestricted `Bash` and is told to discover and run the repo's own deploy mechanism
(`types.ts:1389-1420`). For cezar itself, `AGENTS.md:12` currently makes self-deploy mandatory:
"Every change ships the moment its gates are green, no quiet window, no handing the restart to a
human." `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md` and
`packages/cezar/src/server-install/self-safe-deploy.ts` exist specifically to make that survivable.

The owner now wants the opposite for the cezar service: no automatic deploy, and a visible parked
state instead. That is a direct supersession of a decision the record states twice.

### P7. A new run status is not free

`runStatusSchema` is `queued | running | waiting | review | done | failed | cancelled`
(`packages/contract/src/runs.ts:30-38`). `stopReason`'s doc comment at `runs.ts:295-302` states the
rule in the repo's own words: `RunStatus` is a published union and cezar is a released npm package,
so adding a member would break a consumer switching over it exhaustively.
`BACKWARD_COMPATIBILITY.md`'s general rule agrees: additive is fine, anything that makes an existing
output disappear or an existing consumer wrong is breaking. The approval gate hit this exact wall in
2026-08-20 and reused `waiting` plus a persisted `pendingApproval`
(`runs.ts:200-232`, `run.ts:5696`).

## Solution

Ten steps, in the owner's order. Six decisions carry the weight.

### D1. Stage 3 is codex `gpt-5.6-sol` at `xhigh`; stage 2 stays Opus-first

"SOL xhigh" resolves to the codex model `gpt-5.6-sol` (a member of
`KNOWN_PRESETS_BY_RUNNER.codex`, `packages/cezar/src/core/model-presets.ts:58`) at
`effort: 'xhigh'` (`workflowStepSchema.effort`, `types.ts:37`). Both halves are already
expressible; nothing new is invented.

```ts
/** Stage 3, owner instruction 2026-08-24. CORRECTS the 2026-08-22 "spec review should be by opus
 *  always" recorded on SPEC_AUTHORING_MODEL: the reviewer is sol at xhigh now. The WRITER is
 *  still opus. */
const CODEX_REVIEW = { model: 'gpt-5.6-sol', effort: 'xhigh' } as const;
```

| Step | runner pin | claude row | codex row |
| --- | --- | --- | --- |
| `spec` | `claude` | `opus` (unchanged) | `CODEX_COMPLEX` (`gpt-5.6-sol`, `medium`) |
| `review-spec` | `codex` | `{ model: 'opus', effort: 'xhigh' }` | `CODEX_REVIEW` (`gpt-5.6-sol`, `xhigh`) |
| `merge` (new, D4) | none | `SPEC_TO_DEPLOY_STEP_MODEL` (`sonnet`) | `CODEX_MECHANICAL` (`gpt-5.6-luna`, `medium`) |

The `merge` row is here and not left to D4 because a step that ships without one is not
unopinionated, it is opinionated by accident: on a codex run it would land on `gpt-5.6-sol` at
`null` effort, the one cell of the owner's table that is never deliberately selected
(`types.ts:884-891` says so about `CODEX_CLASS_CHOICE`), and it would redden the whole-table
assertion at `types.test.ts:820` by design — that test's own comment says *"a ninth step added
later without a codex pin reddens this instead of silently inheriting codex's default"*. The pair
is copied from `commit-push` (`types.ts:1262-1263`), which is the step `merge` was split out of and
which does the same class of work. `heavy` is **not** set on it: a merge is not a gate suite.

Both authoring steps name **both** rows through `byRunner`, which is what closes P1. The ladder in
`.ai/specs/2026-08-23-never-block-a-task.md` is left exactly as it is: no second availability
mechanism, no new probe, no new setting. What changes is only where a downgrade lands. When every
Claude account is limited, `spec` descends to `gpt-5.6-sol` at `medium` (the owner's own
"complex bug, architecture" row, already the constant `CODEX_COMPLEX` at `types.ts:842`) instead of
to codex's `null`-effort default. When every codex account is limited, `review-spec` descends to
opus at `xhigh`, preserving the depth half of the instruction across the provider change.

`spec`'s codex row is deliberately `CODEX_COMPLEX` and not a fifth literal: the owner wrote one
table, and re-typing a row is how two surfaces end up disagreeing about what it said
(`types.ts:855-861` makes the same argument for `CODEX_CLASS_CHOICE`).

The downgrade stays announced by the mechanism that already announces it: the `note` event emitted
at `run.ts:1415-1419`. No change there.

### D2. `run-tests` attests the tree it made green

After its final gate passes, the **engine** (not the agent) computes:

```
GIT_INDEX_FILE=<tmp> git add -A          # writes blobs; the real .git/index is untouched
GIT_INDEX_FILE=<tmp> git write-tree      # -> treeSha
git rev-parse HEAD                       # -> headSha, or absent on an unborn branch
```

and persists `testAttestation: { stepId, treeSha, headSha?, at }` on the run record. Using a
temporary `GIT_INDEX_FILE` is what makes this safe to run mid-chain: it writes objects but mutates
no index and no ref, so it cannot disturb the agent's working state.

The digest is computed in the engine because an attestation an agent can write is not an
attestation. The agent's report still says what commands it ran; the tree hash is cezar's own
observation.

### D3. `tested-revision-shipped`, a new post-condition

A third built-in beside `everything-committed` and `all-services-deployed`. It answers: is the
commit this step produced the tree the tests were run against? It has **two modes, because the two
steps that carry it are asking different questions** — the `merge` mode below is deliberately not
the tree comparison.

**Mode A, on `commit-push`: the shipped tree IS the tested tree.**

```
git diff-tree -r --name-only <attestation.treeSha> HEAD^{tree}
```

Every differing path is compared against a record allowlist:

```ts
/** Paths that may differ between the tested tree and the shipped commit. These are the record,
 *  not the program: no test outcome can depend on them, and stages 9 and 10 write them by design. */
const RECORD_PATHS = ['.ai/specs/', '.ai/cezar/knowledge/', 'docs/', 'CHANGELOG.md'];
```

- No differing path outside the allowlist: **green**, and the verdict names the tree.
- Any differing path outside it: **red**, and the verdict names the files. The step's `onFail`
  loops back to `run-tests`, which re-attests. This is the answer to "what invalidates a green
  gate": a change to a non-record file, and nothing else.
- Attestation absent (a resumed run from before this ships, a `run-tests` that never went green):
  **green with a stated reason**, degrading rather than failing a step for a fact about the
  record's age. This is the same degradation stance the module already takes
  (`postconditions.ts:20-25`).
- `treeSha` present but not resolvable in the object database (git gc pruned an unreachable tree
  between stages): **red**, with "re-run the tests" as the verdict. Failing toward re-running a
  gate is the cheap direction; failing toward shipping an unverified tree is not.

**Mode B, on `merge`: the base branch did not move under the gate, and the tested commit is in
what shipped.**

Mode A is the wrong *question* here, but not because reddening on a moved base is wrong. It asks
about file paths: `git diff-tree <treeSha> HEAD^{tree}` after any non-fast-forward merge reports
every file the base branch changed since the fork, and names them one by one. The verdict would be
a file list, when the fact that matters is not which files moved but **that the base moved at all**.

The record already settled what follows from a moved base, and this spec applies that rule rather
than restating or softening it. KB `notion-c20835e294bf`, *"2026-08-23 — The gate that authorises a
push is the one on the MERGED tree, not the branch gate"*
(`notion-export/knowledge/sections/328-2026-08-23-merged-tree-gate-not-branch-gate--local.md`),
records a measured incident **in this repo**: a branch gate on `prod-host` read 559 of 560
files green; merging `origin/main` took the same tree to 3 failed files and 12 failed tests; and
**none of the twelve were in a file the merge touched textually**. `origin/main` had made
`instanceId` a required field of a fresh broker launch, replacing a contract beneath tests that
were correct against the contract they were written against. Git reported a clean merge because
nothing conflicted. The entry's rule, verbatim:

> Re-run the full gate **after** the merge, on the tree you are about to push, and treat the branch
> gate as spent the moment `origin/main` moves. […] A clean `Merge made by the 'ort' strategy` is
> not evidence.

So a clean non-ff merge of a base that moved by unrelated files is exactly the case that must go
red. On `merge` the built-in asks two engine-checkable questions:

1. **The merge brought in no new base-branch commits.** Green only on a true fast-forward — HEAD
   unchanged by the merge — or when `shippedSha` was already an ancestor of `<remote>/<base>`
   before the step ran (a concurrent task merged it, so there is nothing to merge and nothing new
   came the other way). Otherwise **red**, with the verdict *"the base branch moved N commits under
   this run — the branch gate is spent; re-running the gate on the merged tree"*, where N is
   `git rev-list --count <shippedSha>..<remote>/<base>`. No file list, because the incident above
   is precisely the one a file list cannot see.
2. **The tested commit is an ancestor of HEAD.** When `commit-push` goes green the engine records
   `testAttestation.shippedSha = git rev-parse HEAD`. `merge` requires
   `git merge-base --is-ancestor <shippedSha> HEAD`. Red when it is not, with the verdict naming
   both shas. This catches a merge that dropped or rewrote what was shipped, independently of
   question 1.

A conflict resolution is covered without a third question: resolving edits code, which lands new
commits from the base branch by construction, so question 1 is already red.

Nothing here inspects merge trees, so nothing here depends on `git merge-tree --write-tree` or on
any git version floor.

A red on `merge` loops back to `run-tests` (`onFail: { retry: 'run-tests', max: 1 }`, legal because
`run-tests` is an *earlier* step — `stepsIssue`, `types.ts:396-402`), which re-attests against the
merged tree; `commit-push` and `merge` then re-run against that attestation.

Carried by `commit-push` (Mode A) and `merge` (Mode B). Deliberately **not** by `document`: its
whole job is to write files under `RECORD_PATHS`, so Mode A is vacuous there and Mode B would only
re-ask what `merge` already answered.

### D4. `merge`, a step with a target

New step, id `merge`, between `commit-push` and `document`. Its target is, in order:
`run.baseBranch` (persisted at `packages/cezar/src/runs/store.ts:457`, the branch this task's
worktree forked from), then `config.baseBranch` (`packages/cezar/src/config.ts:141`), then the
remote's own default branch (`git symbolic-ref refs/remotes/origin/HEAD`).

`run.baseBranch` needs the same two guards `gh pr create` already applies to it
(`packages/cezar/src/server/forge/github.ts:2052-2053`): strip a leading `origin/`, and **skip the
candidate entirely when what remains is a raw 7-to-40-hex sha**, because `createWorktree` stores a
commit there on a detached-HEAD start (`packages/cezar/src/git-worktree.ts:144-151` — the file is
at `src/git-worktree.ts`, not under `src/server/`). A sha is not a branch and cannot be merged
into, so the derivation falls through to the next candidate.

**Grant.** `merge` reuses `commit-push`'s tools rather than inventing a second list:
`allowedTools: ['Read', 'Grep', 'Glob', 'Bash']` and `commit-push`'s `bashAllowlist`
(`types.ts:1274-1291`), which already carries `git fetch`/`merge`/`checkout`/`switch`/`push`/
`rev-parse` plus `gh pr` and `gh repo` — a superset of what `merge` needs; `checkout` and `switch`
are inert here for the reason the next paragraph gives, and are kept only because the list is
shared verbatim with `commit-push` rather than forked. The implementation lifts it to one named
constant shared by both steps, because two copies of a shipping allowlist are two things that
drift.

**The base branch cannot be checked out, so only two mechanisms are available.** Every cezar task
runs in its own git worktree, and the real checkout is standing on the base branch — measured on
this box: `git -C /var/lib/cezar/loki-labs/cezar rev-parse --abbrev-ref HEAD` → `main`. Git refuses
to check out a branch that another worktree already holds, and refuses it hard: inside this run's
own worktree, `git checkout main` gives `fatal: 'main' is already used by worktree at
'/var/lib/cezar/loki-labs/cezar'`, **exit 128**, and `git switch main` gives the same. So the
"stand on the base branch, merge, push" shape is not merely discouraged here, it is unavailable,
and a spec that offered it would have prescribed a step that fails on every run on this box.

The step keeps freedom about **how**, but only between the two mechanisms that work from a task
branch that is never checked out anywhere else:

- **`gh pr merge`** — the merge happens server-side, so nothing local has to move.
- **`git push <remote> HEAD:refs/heads/<base>`** — a server-side fast-forward. It is refused by the
  remote unless HEAD is strictly ahead of the base, which is the correct failure: a base that moved
  under the run must not be force-advanced past, it must send the run back through the gate
  (D3 Mode B, question 1).

`git merge` stays in the grant because the step may still need to merge the *base into the task
branch* (`git fetch <remote> <base>` then `git merge <remote>/<base>`, both performed from the task
branch, both legal in a worktree) before it can fast-forward the base onto HEAD. What it may never
do is `git checkout <base>` or `git switch <base>`.

It removes the freedom about **whether** — once the checkout has opted in, which is the next
subsection. New post-condition `merged-into-base`:

```
git fetch <remote> <base>
git merge-base --is-ancestor HEAD <remote>/<base>
```

Green only when HEAD is an ancestor of the remote base branch. Ancestor rather than equality, for
the same reason the cezar backend deploy probe uses ancestry (`.ai/deploy-targets.json`, the
2026-08-21 correction): a concurrent task may have merged a later commit, and everything at HEAD is
still in the base branch.

**The opt-in, and why stage 8 needs one.** cezar states in five published places that it never
auto-merges (see **Supersedes**), and `spec-to-deploy` is the default workflow in every repo it
runs in, so an unconditional `merge` step would falsify all five for every user of a released npm
package. Stage 8 is therefore gated on one new config key, modelled field for field on `reviewGate`
(`packages/cezar/src/config.ts:132-136`) — the exact precedent: an optional gate behaviour, default
off, with a Settings toggle:

```ts
/** Stage 8 of `spec-to-deploy`: merge the task branch into the base branch. Absent/false = OFF,
 *  which is the published "cezar never auto-merges" guarantee. Only a checkout that opts in
 *  merges. Owner instruction 2026-08-24 asked for the merge; the default stays off because the
 *  guarantee is published in a released package. */
autoMerge: z.boolean().optional(),
```

`.ai/cezar/` is gitignored (`.gitignore:11`), so this is a per-checkout choice this repo cannot
impose on anybody else's. With `autoMerge` **off**, the `merge` step still runs and still reports —
it states that the branch is pushed and awaiting the review gate — and `merged-into-base` returns
**green with that reason**. Putting the conditional inside the post-condition rather than around
the step means `document` inherits the same answer without a second copy of the rule. With it
**on**, the step merges and the post-condition has teeth. cezar's own prod checkout sets
`autoMerge: true`, which is a local setting and not a committed file.

Three outcomes that are not a clean merge:

- **Conflict.** The step's agent resolves it on the task branch. A conflict means the base moved, so
  Mode B's question 1 is already red before the resolution is even considered:
  `tested-revision-shipped` goes red and the chain loops back to `run-tests`
  (`onFail: { retry: 'run-tests', max: 1 }`), which re-attests against the merged tree. Note that a
  **clean** merge of a moved base reds identically, and that is the point rather than a cost: KB
  `notion-c20835e294bf` measured 12 test failures behind a merge git called clean.
- **Protected branch or required human review.** The step opens or updates the PR, then parks as a
  handoff of kind `manual-merge` (D5). It does not force a push and it does not report green.
- **No remote at all.** Green, with the verdict saying so, matching `everything-committed`'s
  existing "no upstream is configured, so the commits are local only" branch
  (`postconditions.ts:163-168`).

`document` stays where the owner put it — stage 9, **after** the merge — and gains
`merged-into-base` alongside its existing `everything-committed`. That is the fix for P5: the record
commit must reach the same base branch the code did.

Handing it the post-condition is not enough on its own, and this is the part that would otherwise
fail on every repo. `document`'s grant today is `git status/diff/log/show/add/commit/push`,
`gh pr` and `cez kb` (`types.ts:1337-1346`) — **no `git fetch`, `merge` or `rev-parse`** — and its
prompt (`:1384`) says only "commit the doc/spec edits and push them the same way the change was
shipped (branch push or PR)". After `merge` has already merged, and on the `gh pr merge` path very
likely deleted the task branch, `document`'s own commit would land on a branch nobody merges,
`merged-into-base` would go red, and the run would fail at stage 9. Three concrete changes ship
together:

1. **Grant.** Add `git fetch`, `git merge` and `git rev-parse` to `document`'s `bashAllowlist`. It
   keeps `cez kb`; nothing is removed. `git checkout` and `git switch` are deliberately **not**
   added: `document` runs in the same task worktree `merge` does, so it cannot stand on the base
   branch either (exit 128, see above), and granting a verb the step must never use is an
   invitation to a run that fails at the shell instead of at the spec.
2. **Prompt.** Add a final step ordering it to commit the record **on the task branch**, then land
   that commit on the base branch with the same mechanism `merge` used — `gh pr` (open or update
   and merge), or `git push <remote> HEAD:refs/heads/<base>` — and to report which it did and
   where. It must state explicitly that `git checkout <base>` is not available to it. It must not
   assume the task branch still exists on the remote: when `gh pr merge` deleted it, the local
   branch is still there and re-pushing it is what re-creates it.
3. **Retry budget.** A red here re-runs `document` itself through `verify.max: 1`, which is the
   existing seam for exactly that (`retryAfterFailedPostcondition`, `run.ts:7226-7248`). It is
   **not** `onFail: { retry: 'document' }`: `stepsIssue` rejects an `onFail.retry` that does not
   name an *earlier* step, so a step cannot name itself (`types.ts:396-402`). After that one
   re-run a red is terminal, and terminal is correct — the record failing to reach the base branch
   is precisely the drift this step exists to prevent, and a green there would be a lie.

With `autoMerge` off, all of this is inert: `merged-into-base` is green-with-a-reason for both
steps, `document` pushes its branch as it does today, and its widened allowlist goes unused.

**The alternative considered and rejected:** move `document` before `merge` and let `merge` carry
the record commit too. It needs no new grant and merges once instead of twice, but it departs from
the owner's stated stage order (knowledge at 9, after merge at 8) and makes the record describe a
ship that has not happened yet. If a reviewer prefers it, the change is exactly: swap the two steps
and drop `merged-into-base` from `document`.

### D5. One handoff park, two uses

`waiting` plus a persisted object, exactly as the approval gate does it. Concretely:

- `waitingReason` gains one member: `'handoff'`. It is an **optional** field
  (`runs.ts:327`) and its sibling `stopReason` was already widened from `['budget']` to
  `['budget', 'inactivity']` (`runs.ts:302`), which is the precedent for widening a sub-reason enum
  in this codebase. `runStatusSchema` is **not** touched.
- New optional `pendingHandoff` on `runRecordSchema`, modelled field for field on
  `pendingApprovalSchema` and persisted for the same reason that one is: a cezar restart must not
  silently un-park the run (`runs.ts:200-208`).

The park itself reuses `awaitApproval`'s shape (`run.ts:5663-5712`): join `waiting`, give the
`maxParallel` slot back, await, restore on the way out, re-park from the persisted record on
`recover()`.

**Every exit, enumerated** (AGENTS.md asks for this explicitly of any new state):

| Exit | Effect |
| --- | --- |
| `POST /runs/:id/handoff/resolve` | Re-evaluate the parked step's post-condition. Green: clear `pendingHandoff`, finish the step `done`, continue the chain. Red: stay parked, append the verdict as an event. **The human's claim is checked, not trusted.** |
| `POST /runs/:id/handoff/skip` | Finish the step `skipped`, clear `pendingHandoff`, continue. The one exit that takes a person's word for it, and it is recorded as a skip rather than a pass. |
| `POST /runs/:id/cancel` | Existing route, existing behaviour: `cancelled`. |
| cezar restart | The promise dies with the process; `recover()` re-parks from `pendingHandoff`, mirroring `run.ts:2283-2287`. Note what that branch actually does: it appends a lifecycle event and `continue`s, re-parking **nothing** in process, and leaves `releaseApproval`'s no-live-waiter branch to re-enter the chain when the decision arrives. `handoff/resolve` needs the same shape — a resolve that finds no live waiter must itself re-enter the chain, or a restarted run stays parked forever with a button that does nothing. |
| timeout | None. A handoff waits indefinitely. `approvals.timeoutHours` auto-approves a **review**; nobody can auto-perform a deploy. |

**The task-status question, answered honestly.** The owner asked for "a new status to task like
(await manual deployment)". The user-visible status is new: the cockpit renders a run with
`waitingReason: 'handoff'` and `pendingHandoff.kind: 'manual-deploy'` as **"Awaiting manual
deployment"**, with the target list and a Resolve action. The wire enum is not widened, for the
reason `runs.ts:295-302` gives and `BACKWARD_COMPATIBILITY.md` repeats. A linked todo moves to the
existing `blocked` (`packages/cezar/src/todos.ts:60`) with a note naming the handoff; that enum is
not widened either. **This is the one place a reviewer might reasonably overrule this spec**, and it
is called out rather than buried: if the owner wants a literal eighth `RunStatus` member, that is a
breaking change to a released package and takes the deprecation path in
`BACKWARD_COMPATIBILITY.md`, not a quiet enum edit.

### D6. Manual deploy targets, declared per target, not detected per repo

`deployTargetsSchema` (`postconditions.ts:198-205`) gains two optional fields. It is a plain
`z.object`, so zod **strips** unknown keys rather than rejecting them — cezar's own `$comment` array
in `.ai/deploy-targets.json` already relies on exactly that — which is what makes these two keys
safe in both directions: an older cezar reading a file that declares them ignores them and deploys
automatically, and a newer cezar reading a file without them behaves as it does today.

```jsonc
{ "name": "...", "probe": "...", "manual": true, "manualReason": "why a person must do this" }
```

The `deploy` step deploys every target where `manual` is falsy, exactly as today, and does not touch
the manual ones. `allServicesDeployed` then splits its verdict:

- Every automatic target must probe green. Unchanged, including the fail-closed missing-file branch
  (`postconditions.ts:284-296`) and the explicit `{"targets": []}` opt-out.
- Manual targets are probed too, and a manual target that is **already** live (a human deployed it
  during the run, or it was never behind) counts as satisfied.
- Any manual target still red: the step parks as a handoff of kind `manual-deploy`, carrying the
  target names and their `manualReason`. It does not report green and it does not report failure.

The engine learns nothing about cezar. What makes cezar's service manual is one field in cezar's
own `.ai/deploy-targets.json`, which is where "what this repo deploys" is already declared. Every
other repo's file has no `manual` key and behaves exactly as it does today, which is what makes this
additive rather than a policy imposed on other people's repos.

**Both** of cezar's targets are marked manual, not just the backend. On `prod-host` the deploy
path is `cezar server-deploy --strategy=blue-green` (`AGENTS.md:13`), where `/opt/cezar` is a
symlink and activation is one atomic release flip that restarts the service. There is no way to
activate the UI target without activating the service, so marking only one would be a half-truth
that produces a half-deploy. The `$comment` block in that file, which already carries three dated
corrections, gains a fourth saying so.

## Architecture

```
1 context        claude/sonnet | codex/terra-medium        unchanged
2 spec           claude+opus   | codex/sol-medium          D1: codex row named
3 review-spec    codex+sol-xhigh | claude/opus-xhigh       D1: runner + model flip
4   requiresApproval on step 3                             unchanged (minApprovers: 0 = auto)
5 implement      unchanged
6 run-tests      unchanged prompt/tools  + engine writes testAttestation   D2
7 commit-push    verify: [everything-committed, tested-revision-shipped/A] D3
8 merge          NEW. verify: [merged-into-base, tested-revision-shipped/B],
                 onFail -> run-tests (max 1), may park manual-merge        D4/D5
9 document       verify: [everything-committed, merged-into-base]          D4
10 deploy        all-services-deployed, may park manual-deploy             D5/D6
```

Steps 7, 8 and 9 each name **two** post-conditions, which the schema cannot express today:
`verify` is a single object, not a list (`types.ts:136-145`), and every current step names exactly
one (`:1268`, `:1319`, `:1398`). Adding ids to `POSTCONDITION_IDS` does not make a step able to
carry two, so the schema widening in **Data models** is a prerequisite for Phases 2 and 3, not an
afterthought. There is a **second** prerequisite of the same kind, also in **Data models**: a
post-condition can see only `{ cwd, workspaceRun, probeTimeoutMs, dryRun }` today
(`postconditions.ts:48-70`, and `run.ts:7213` passes just the first two), which is not enough state
for either new built-in and carries no step id to tell D3's two modes apart. Apart from those two
widenings, nothing changes about how steps are executed, retried, approved or recovered: every
other new behaviour is a step-definition field the schema already has
(`byRunner`, `effort`, `runner`, `onFail`, `verify.max`) or a new `verify.builtin` id, which is the
extension point `POSTCONDITION_IDS` exists for (`postconditions.ts:44-45`).

**In-flight runs across the upgrade — confirmed, not assumed.** `recover()` re-adopts a queued run
"from the persisted workflowDef (or the catalog by name for older records)" (`run.ts:2245-2252`),
and the resolver reads `run.workflowDef` first and only falls back to `loadWorkflows` when it is
absent (`run.ts:2733-2736`). The store parses that field against the definition schema and
`.catch(undefined)`s a def that no longer fits (`runs/store.ts:570`). So a run already executing the
eight-step chain keeps executing the eight-step chain after a restart, and inserting `merge` in the
middle does not disturb it. Phase 3 is **not** blocked on this; the one real constraint the store's
own comment states is that a **narrowing** of `workflowStepSchema` silently eats queued runs
(`store.ts:560-570`), which is why the `verify` widening below is a union and not a replacement.

## Data models

### A step must be able to carry more than one post-condition

Today it cannot. `verify` is a single object with an XOR refine
(`packages/cezar/src/workflows/types.ts:136-145`):

```ts
verify: z.object({ builtin, command, max }).refine(builtin XOR command).optional()
```

Steps 7, 8 and 9 each need two. The widening is a union, so the existing single-object form stays
valid:

```ts
const verifyEntrySchema = z
  .object({
    builtin: z.enum(POSTCONDITION_IDS).optional(),
    command: z.string().min(1).optional(),
    max: z.number().int().nonnegative().default(1),
  })
  .refine((v) => Boolean(v.builtin) !== Boolean(v.command), {
    message: 'a step\'s verify names either a builtin or a command, not both',
  });

/** One entry, or an ordered list of them. The XOR applies PER ENTRY, not across the list. */
verify: z.union([verifyEntrySchema, z.array(verifyEntrySchema).min(1).max(4)]).optional(),
```

Semantics the step loop must implement (`runStepVerify`/`retryAfterFailedPostcondition`,
`run.ts:7196-7248`):

- **Normalize on read.** A bare object becomes a one-element list; nothing downstream sees two
  shapes.
- **Every entry runs, in declared order**, each emitting its own `check-output` card so a reader can
  tell which one failed. Do not short-circuit on the first red: a step that fails two conditions
  should say so once, not across two re-runs.
- **The step is green only when every entry is green.**
- **When more than one is red, the FIRST red in declared order owns the outcome** — its `detail` is
  the verdict text appended to the retried prompt, and its `max` is the retry budget consulted by
  the ledger. Declaration order is the tie-break precisely because it is visible in the step
  definition; anything else (worst-severity, last-red) would be an invisible rule. The other reds
  are still reported in the verdict text so the agent is told everything it did not achieve.
- **`onFail` is unchanged** — it is per step, not per entry, and it still may only name an earlier
  step (`stepsIssue`, `types.ts:396-402`).

**Persisted `workflowDef` implication.** This is a widening, so a def written by an older cezar —
which always wrote the single-object form — still parses under the new schema and survives the
round-trip through `runs/store.ts:570`. That is the property the store's own comment says must hold
("a narrowing here silently eats queued runs"), and a union satisfies it. The reverse direction is
not protected and does not need to be: a def written by a newer cezar with a two-entry `verify`,
read back by an older one, `.catch`es to `undefined` and falls back to the catalog by name, which is
the documented degradation for a catalog workflow.

### A post-condition cannot see the run today, and both new built-ins need to

This is a prerequisite, not a detail, and it is the reason neither new built-in is implementable
against the module as it stands. `runStepVerify` calls

```ts
// packages/cezar/src/workflows/run.ts:7213 — verbatim
const result = await evaluatePostcondition(verify.builtin as string, { cwd: state.cwd, workspaceRun });
```

and `PostconditionContext` (`postconditions.ts:48-70`) carries exactly four fields: `cwd`,
`workspaceRun`, `probeTimeoutMs`, `dryRun`. No run record, and **no step id**. Three consequences:

- `tested-revision-shipped` cannot read `testAttestation`, which lives on the run record.
- `merged-into-base` cannot read `autoMerge`, the derived base branch, or the remote.
- Nothing tells `tested-revision-shipped` whether it is in Mode A or Mode B. D3 names **one**
  built-in id carried by **two** steps with different semantics, so the discriminator has to be
  stated rather than assumed: it is the step id, and `merge` selects Mode B.

The context widens by four optional fields:

```ts
export interface PostconditionContext {
  cwd: string;
  workspaceRun?: boolean;
  probeTimeoutMs?: number;
  dryRun?: boolean;

  /** Which step is being verified. The discriminator for a built-in carried by more than one
   *  step: `tested-revision-shipped` runs Mode B when `stepId === 'merge'` and Mode A otherwise. */
  stepId?: string;
  /** D2's attestation, read off the run record. Absent = the degrade-to-green branch in D3. */
  attestation?: TestAttestation;
  /** The `autoMerge` opt-in (D4). Absent/false = `merged-into-base` is green-with-a-reason. */
  autoMerge?: boolean;
  /** The `merge` target, already derived and guarded by D4's rules — derived once by the caller,
   *  not re-derived inside two built-ins. */
  baseBranch?: string;
}
```

`runStepVerify` populates them: `stepId` from `step.id`, `attestation` from
`this.store.getRun(runId)?.testAttestation` (it already calls `getRun` on the line above, for
`workspaceRun`, so this costs no extra read), and `autoMerge`/`baseBranch` from the resolved config
and D4's derivation.

**Every one stays optional, deliberately.** `postconditions.test.ts` drives the built-ins from a
bare `{ cwd }` context today, against real `mkdtemp` git repos, and must keep being able to: a
required field here would force every existing case to be rewritten to say nothing, and the tests
that exercise the absent-attestation and opt-in-off branches need to construct exactly that.

### `waitingReason` is declared in three places, not one

Widening only the contract's run record leaves two of the three rejecting or dropping `'handoff'`.
All three sites change in the same commit:

| Site | Today | Why it matters |
| --- | --- | --- |
| `packages/contract/src/runs.ts:327` | `z.enum(['question','report']).optional()` | The run record on the wire. |
| `packages/contract/src/runs.ts:523` | same, on the run **index row** | Without it the boards cannot carry the reason; `deriveAttention` and the two cross-project boards read this row, not the record. |
| `packages/cezar/src/runs/store.ts:344` | same, **no `.catch`** | The persisted record. Left alone, `'handoff'` is rejected or dropped on persist/reload, which destroys the restart-survival property D5 rests on. |

Two mirrors copy the field from the record onto the index row and need no schema change but do need
to be in the same read-through: `server.ts:7185` and `notifications/observer.ts:104`, both
`...(run.waitingReason !== undefined ? { waitingReason: run.waitingReason } : {})`.

**One behavioural trap.** `updateRun` clears `waitingReason` on any status change whose patch does
not itself carry one (`store.ts:880-895`, and again at `:892-896` for any terminal status). So the
handoff park must set `status: 'waiting'` **and** `waitingReason: 'handoff'` in the *same*
`updateRun` patch. A two-call park silently un-sets the reason and the cockpit renders a bare
`waiting`. `awaitApproval` (`run.ts:5696`) is the shape to copy — one patch carrying
`pendingApproval` and `status` together — but only a **partial** precedent: it never sets
`waitingReason` at all, so it does not demonstrate the trap. The authority for the rule is
`store.ts:881-889` itself.

```ts
// packages/contract/src/runs.ts: additive, all optional.

/** Work only a human may perform. Persisted for the reason pendingApproval is: a restart must not
 *  silently un-park the run. */
export const pendingHandoffSchema = z.object({
  kind: z.enum(['manual-deploy', 'manual-merge']),
  stepId: z.string(),
  requestedAt: z.string(),
  /** Sentence shown in the cockpit. Never synthesized: the deploy target's own `manualReason`, or
   *  the merge step's reported obstruction. */
  reason: z.string().max(2000),
  /** manual-deploy: the target names still red. Absent on manual-merge. */
  targets: z.array(z.string()).max(50).optional(),
  /** manual-merge: the PR a human has to merge, when one was opened. */
  prUrl: z.string().max(500).optional(),
  /** What the resolver will be checked against. */
  sha: z.string().max(64).optional(),
  baseBranch: z.string().max(300).optional(),
});

/** Proof of which tree the gate suite was green against (D2). Written by the engine. */
export const testAttestationSchema = z.object({
  stepId: z.string(),
  treeSha: z.string().length(40),
  headSha: z.string().length(40).optional(),
  /** The commit `commit-push` produced from `treeSha`, recorded when that step went green. Mode B
   *  of `tested-revision-shipped` requires it to be an ancestor of HEAD at `merge`. Absent until
   *  `commit-push` passes. */
  shippedSha: z.string().length(40).optional(),
  at: z.string(),
});

// runRecordSchema gains:
  pendingHandoff: pendingHandoffSchema.optional(),
  testAttestation: testAttestationSchema.optional(),
// and waitingReason widens by exactly one member, at ALL THREE sites in the table above
// (contract runs.ts:327, contract runs.ts:523, cezar runs/store.ts:344):
  waitingReason: z.enum(['question', 'report', 'handoff']).optional(),
```

```ts
// packages/cezar/src/workflows/postconditions.ts

export const POSTCONDITION_IDS = [
  'everything-committed',
  'all-services-deployed',
  'tested-revision-shipped',   // new
  'merged-into-base',          // new
] as const;

export const deployTargetsSchema = z.object({
  targets: z.array(z.object({
    name: z.string().min(1),
    probe: z.string().min(1),
    /** Absent/false = deploy it automatically, today's behaviour for every existing file. */
    manual: z.boolean().optional(),
    manualReason: z.string().min(1).optional(),
  })),
});
```

`PostconditionResult` gains one optional field so a post-condition can request a park rather than
only pass or fail:

```ts
export interface PostconditionResult {
  ok: boolean;
  detail: string;
  /** Set instead of a plain `ok: false` when the remaining work is a human's. The step loop parks
   *  the run rather than failing or retrying it. */
  handoff?: { kind: 'manual-deploy' | 'manual-merge'; reason: string; targets?: string[] };
}
```

## API contracts

Two new routes beside the existing `POST /api/v1/runs/:id/approve` and
`POST /api/v1/runs/:id/request-changes` (`packages/cezar/src/server/server.ts:5212`, `:5221`),
matching their body-validation and response conventions:

```
POST /api/v1/runs/:id/handoff/resolve
  body: { by?: string, note?: string }
  200  { resolved: true, verdict: string }            post-condition re-checked and green
  200  { resolved: false, verdict: string }           re-checked and still red; run stays parked
  409                                                 the run is not parked on a handoff
  404                                                 unknown run

POST /api/v1/runs/:id/handoff/skip
  body: { by?: string, note: string }                 a note is REQUIRED: this exit is unverified
  200  { skipped: true }
  409 / 404                                           as above
```

`GET /api/v1/runs/:id` returns `pendingHandoff` and `testAttestation` inside the existing run
record. No response loses a field; no request gains a required one. Per
`BACKWARD_COMPATIBILITY.md` section 2, new routes and new optional fields are additive.

The cockpit's task thread renders a handoff card (target list, reason, Resolve, Skip) in the same
slot the approval card uses. That UI work is Phase 4's tail and was **not** read in detail while
writing this spec; the implementer should locate the approval card first and mirror it rather than
invent a second parked-run presentation.

## Phases

Each phase is shippable alone and leaves the chain working.

**Phase 1: model policy (D1).** `CODEX_REVIEW`; `review-spec` flips `runner` to `codex` and names
both rows; `spec` gains its codex row.

Two doc comments are falsified by this phase and both get a dated `CORRECTED 2026-08-24` lead-in
with the original text left below it (the correct-in-place rule):

- `SPEC_AUTHORING_MODEL` (`types.ts:739`), whose 2026-08-22 "spec review should be by opus always"
  is what D1 corrects for the reviewer half.
- `CODEX_COMPLEX` (`types.ts:837-841`), which currently states: *"No `spec-to-deploy` step names
  it, which is not an oversight: that chain splits the complex work across `spec`/`review-spec`,
  and both of those pin `SPEC_AUTHORING_RUNNER = 'claude'`, so on a codex run they never reach a
  codex model at all."* D1 makes `spec` name it, so the comment's premise and its conclusion are
  both false as written. The correction says `spec` now names this row as its codex landing spot,
  which is the whole point of P1.

**Six tests in `packages/cezar/src/workflows/types.test.ts` change, not two:**

- `:186` `'pins the two authoring steps to opus and every other step to sonnet'` — the `models`
  array asserts `['review-spec', 'opus']` at `:191`, and `:200` asserts
  `models.filter(m === 'opus')` is exactly `['spec', 'review-spec']`. `review-spec.model` becomes
  `'gpt-5.6-sol'`, so both break.
- `:215` `'pins the runner on the two opus steps, and only there'` — asserts `['review-spec',
  'claude']` at `:219`. The runner becomes `'codex'`, and the test's *name* states the rule this
  phase repeals.
- `:259` `'caps run-tests to medium effort and leaves every other step unset'` — asserts
  `['review-spec', undefined]` at `:264`. `review-spec` gains `effort: 'xhigh'`, so `run-tests` is
  no longer the only step carrying one and the test's premise changes, not just a cell.
- `:820` `'names a codex model and effort on every step that does not pin the claude runner'` — the
  whole-table assertion at `:832-833` has `spec` and `review-spec` both resolving to
  `{ model: 'opus', effort: undefined }` on codex. Both rows change, and the comment above them
  quoting the 2026-08-22 instruction changes with them.
- `:842` `'keeps the two judgement steps pinned to claude, which is what makes them opus'` —
  asserts for **both** steps that `runner === 'claude'` **and** `byRunner === undefined`. D1 breaks
  all four halves. Its assertion becomes: `spec` pins `claude` and **does** name a codex row
  (`CODEX_COMPLEX`); `review-spec` pins `codex` and names a claude row.
- `:850` `'every codex model it names is one the picker offers'` — **passes unmodified.**
  `gpt-5.6-sol` is already in `KNOWN_PRESETS_BY_RUNNER.codex` (`model-presets.ts:58`), so the new
  rows satisfy it as written. Do not extend it; a test that needed no change is evidence the new
  models were chosen from the offered set.

For each of the five that do change, rewrite the test's **name and comment** to state the
2026-08-24 correction rather than silently flipping an assertion under a name that still reads like
the old rule. That is how a repealed rule survives its own repeal.

No other phase depends on this.

**Phase 2: test attestation (D2, D3), and the `verify` widening.** The `verify` union plus the
step-loop normalization and "all entries must pass / first red owns the outcome" semantics
(**Data models**) land here, because `commit-push` is the first step to need two. Then the
`GIT_INDEX_FILE` helper, `testAttestation` (including `shippedSha`) on the contract and the store,
the write at the end of a green `run-tests`, the `tested-revision-shipped` built-in with Mode A,
and the second `verify` entry on `commit-push`. Independently valuable: it closes P3 on the
eight-step chain before the merge step exists.

**Phase 3: the merge step (D4).** The `autoMerge` config key and its Settings toggle;
`merged-into-base` (green-with-a-reason when `autoMerge` is off, or when there is no remote); the
`merge` step with its shared allowlist constant, its model row (D1's table), and its guarded base
derivation; `tested-revision-shipped` Mode B; `document` gains `merged-into-base`, the three extra
git verbs in its `bashAllowlist`, and the prompt step that lands the record commit on the base
branch. Depends on Phase 2 for the `verify` union and for `shippedSha`. Recovery of in-flight runs
is **not** a blocker — `recover()`'s use of the persisted `workflowDef` is confirmed in
**Architecture**.

**This phase inserts a ninth step into a suite that is deliberately count-anchored**, so the
breakage is broad, mechanical, and entirely intended by the people who wrote those tests. Every
one, in `types.test.ts`:

- `:100` `'is the eight-step context → spec → review → implement → tests → push → document →
  deploy chain'` — both the test **name** and the exact id array at `:106-115`. It becomes the
  nine-step chain with `merge` between `commit-push` and `document`, and its comment gains the
  2026-08-24 line beside the existing 2026-08-20 one.
- `:186` the models array, `:215` the runners array (`merge` joins the runner-free list at
  `:224-231`), `:259` the efforts array — all three enumerate all eight steps positionally.
- `:820` the codex table, whose own comment says *"a ninth step added later without a codex pin
  reddens this instead of silently inheriting codex's default."* That is the guard working as
  designed, and D1's `merge` row is the answer to it, not a workaround.

**Phases 2 and 3 also break the `verify` shape assertions, and one of them fails *open*.** `:629`
asserts `commit-push.verify` deep-equals `{ builtin: 'everything-committed', max: 1 }` and `:633`
the same for `document`; under the union both become two-entry lists, so both must be rewritten to
the list form. The one that needs care is `:650`
`'every declared post-condition names a builtin the runner can actually evaluate'`, whose body is

```ts
for (const s of SPEC_TO_DEPLOY_WORKFLOW.steps) {
  if (s.verify?.builtin) expect(known.has(s.verify.builtin)).toBe(true);
}
```

Under the union `s.verify.builtin` is `undefined` on every list, so this guard goes **vacuous
rather than red** — it would keep passing while checking nothing, silently disabling the
unknown-builtin check for the default workflow at the exact moment two new builtins are added. It
must be rewritten to normalize first and iterate the entries, its `known` set extended with
`tested-revision-shipped` and `merged-into-base`, and it must gain a count floor asserting the loop
exercised something, the way `:243` already does (`expect(pinned.length).toBeGreaterThan(0)`).

**Phase 4: the handoff park (D5).** Contract fields, `awaitHandoff` in the step loop,
`PostconditionResult.handoff`, the two routes, `recover()` re-park, and the cockpit card. Ships with
no producer: nothing sets `handoff` yet, so no run parks. That is the point, it is testable in
isolation.

**Phase 5: manual deploy targets (D6).** The two schema fields, the `allServicesDeployed` split,
the `deploy` step prompt saying it must not deploy a manual target, and cezar's own
`.ai/deploy-targets.json` marking both targets manual with a dated `$comment`. Depends on Phase 4.

**Phase 6: the record.** Two published claims are corrected in place, each with a dated lead-in
pointing at this spec and the original text left below it (the correct-in-place rule):

1. **Self-deploy.** `AGENTS.md:12` — agent-run workflow deployment of cezar is manual now (D6).
2. **"Never auto-merges."** All five lines named in **Supersedes** — `AGENTS.md:3`, `AGENTS.md:9`,
   `README.md:104`, `README.md:192`, `README.md:252`. The guarantee is not deleted, because with
   `autoMerge` off it is still true; each line gains the condition. E.g. `README.md:252`
   ("Nothing auto-merges: a run with changes rests in `review` until you act on it") becomes
   "Nothing auto-merges **unless you turn on `autoMerge`**…", and `AGENTS.md:3`'s parenthetical
   "(never auto-merges)" becomes "(never auto-merges unless you opt in)". `AGENTS.md:9` is the one
   that must be amended most carefully: it currently asserts the guarantee *specifically* about
   tasks cezar runs for users, which is exactly the claim stage 8 touches.

Plus: a `BACKWARD_COMPATIBILITY.md` entry covering the `waitingReason` widening, the `verify`
union, the `autoMerge` key and the two new routes; a CHANGELOG entry; and a KB entry recording both
supersessions. **The KB write is a proposal appended to `CEZ_KB_WRITE_FILE`, not an edit to the
mounted corpus,** and it is not the record until a human applies it.

## Risks

| Risk | Mitigation |
| --- | --- |
| Flipping `review-spec` to codex means a Claude-only install has no reviewer at its named model. | The `byRunner.claude` row is opus at `xhigh`, so a Claude-only box gets a real, chosen reviewer. The ladder handles the rest. |
| SOL xhigh on every run is a cost increase over opus review, and nobody has measured it. | Say so rather than guess: this spec does not claim a number. Phase 1's verification records the first ten runs' `outputTokens` for that step so the next decision has one. |
| `git gc` prunes the attested tree between stages, reddening a legitimate ship. | The window is minutes, and the unreachable-object grace period is two weeks by default. A missing tree is red with "re-run the tests", the cheap direction. |
| `RECORD_PATHS` is an allowlist, so a repo that keeps code under `docs/` could ship an untested change. | The list is four literal prefixes and is stated in the verdict text, so the escape is visible in the step's own output rather than silent. A repo that needs a different list needs a follow-up; this spec does not add a setting for it. |
| Inserting `merge` mid-chain breaks recovery of runs in flight across the upgrade. | It does not: `recover()` reads the run's persisted `workflowDef` (`run.ts:2245-2252`, `:2733-2736`, parsed at `store.ts:570`), so an in-flight eight-step run finishes as an eight-step run. The live constraint is the opposite one the store documents — never NARROW `workflowStepSchema`, which is why `verify` widens by union. |
| The `verify` union changes the shape of a field inside the persisted `workflowDef`, the one place `store.ts:560-570` warns about. | A union strictly accepts everything the old object did, so every persisted def still parses. The regression control is a store test that round-trips a def written in the old single-object form. |
| Mode B reds on every merge of a base that moved, which on this box is most merges, so stage 8 sends runs back through the gate often. | That is the cost the record already priced: KB `notion-c20835e294bf` measured 12 test failures behind a merge git called clean. A gate re-run is minutes; a contract replaced beneath a passing test cost a day. Mode B uses only `git rev-list --count` and `git merge-base`, so it carries no git version floor and nothing to fall back from. |
| Shipping `autoMerge` default-off means the owner's stage 8 does nothing until somebody sets it. | Deliberate, and stated: the alternative is falsifying a published guarantee for every user of a released package. cezar's own checkout sets it, so the owner's box behaves as asked; V8 verifies that end to end. |
| A person clicks Resolve without deploying. | Resolve re-runs the probe. The unverified exit is Skip, which requires a note and records the step as `skipped`, not `done`. |
| Making cezar's deploy manual means cezar changes now sit undeployed until someone acts. | That is the owner's instruction, and the parked run is the visible reminder. The blue-green path in `AGENTS.md:13` is unchanged and is what the human runs. |
| `waitingReason` is a published enum and an exhaustive consumer could break on `'handoff'`. | Optional field, precedent set by `stopReason`'s own widening, documented in `BACKWARD_COMPATIBILITY.md` in the same change. The alternative, widening `RunStatus`, is the one `runs.ts:295-302` forbids. |

## Verification

Gate suite first, in every phase: `npm run typecheck`, `npm run lint`, `npm test` from the repo
root. Send each to a file and read the `EXIT=` marker; `npm test` scrubs its own environment,
`npm run test:unit` and `npm run test:package` do not (AGENTS.md, Validation).

**V1 (Phase 1).** `packages/cezar/src/workflows/types.test.ts`: `review-spec` resolves to
`{ model: 'gpt-5.6-sol', effort: 'xhigh' }` on codex and `{ model: 'opus', effort: 'xhigh' }` on
claude; `spec` resolves to opus on claude and `gpt-5.6-sol`/`medium` on codex. Then rewrite each of
the five tests D1 breaks, name and comment included, exactly as Phase 1 enumerates:

| Test | What breaks | Replacement asserts |
| --- | --- | --- |
| `:186` models array | `['review-spec','opus']` (`:191`); the opus filter (`:200`) | `review-spec` is `gpt-5.6-sol`; opus is now `spec` alone |
| `:215` runners array | `['review-spec','claude']` (`:219`) | `review-spec` pins `codex`; `spec` still pins `claude` |
| `:259` efforts array | `['review-spec',undefined]` (`:264`) | `review-spec` is `'xhigh'`, `run-tests` still `'medium'` |
| `:820` codex table | `spec` and `review-spec` rows (`:832-833`) | `spec` → `gpt-5.6-sol`/`medium`; `review-spec` → `gpt-5.6-sol`/`xhigh` |
| `:842` judgement-steps pin | `runner === 'claude'` + `byRunner === undefined`, both steps | `spec` pins claude **and** names a codex row; `review-spec` pins codex **and** names a claude row |

And the negative control, asserted by **running it unmodified**: `:850` `'every codex model it
names is one the picker offers'` must pass with no edit, because `gpt-5.6-sol` is already in
`KNOWN_PRESETS_BY_RUNNER.codex` (`model-presets.ts:58`). If that test needs touching, a model was
invented rather than chosen.
`npx vitest run packages/cezar/src/workflows/types.test.ts`

**V1b (Phase 2, the schema widening).** `types.test.ts`: a step with a two-entry `verify` parses and
normalizes to a two-element list; a bare object still parses and normalizes to one element; an entry
naming both `builtin` and `command` is rejected while its sibling entry is valid (the XOR is per
entry); a five-entry list is rejected. Plus a `runs/store.ts` round-trip test proving a
`workflowDef` persisted in the **old** single-object form still parses under the new union — the
narrowing hazard `store.ts:560-570` names.

**V2 (Phase 2).** `postconditions.test.ts`, against real `mkdtemp` git repos, the way that suite
already drives the other two built-ins: (a) commit the exact attested tree, green; (b) edit
`src/foo.ts` after attesting, red, and the verdict names `src/foo.ts`; (c) edit only
`.ai/specs/x.md` after attesting, green; (d) no attestation on the record, green with the stated
reason; (e) a `treeSha` of 40 zeroes, red.
`npx vitest run packages/cezar/src/workflows/postconditions.test.ts`

**V3 (Phase 2).** A chain test asserting the engine wrote `testAttestation` when `run-tests`
finished green, and did not when it finished red.

**V4 (Phase 3).** `postconditions.test.ts` for `merged-into-base`: HEAD merged into `origin/main`,
green; HEAD on an unmerged branch, red; HEAD an ancestor of a later `origin/main`, green; no remote,
green with the local-only verdict; `autoMerge` off, green with the opt-in-off verdict **regardless
of the branch state** (the case that keeps `document` from failing on every repo).

For `tested-revision-shipped` Mode B, the headline case is the one KB `notion-c20835e294bf`
measured: a **clean** `git merge --no-ff` of a base branch that moved by three unrelated files is
**red**, and its verdict names the commit count rather than a file list. Then: a true
fast-forward is green; a `shippedSha` already an ancestor of `<remote>/<base>` before the step ran
is green; a `shippedSha` that is not an ancestor of HEAD is red naming both shas; Mode A is
selected when `stepId !== 'merge'` and Mode B when it is (drive the same repo state through both
ids and assert the verdicts differ — this is the discriminator from **Data models**, and an
untested discriminator is how one built-in quietly becomes one mode). Plus a chain test:
`tested-revision-shipped` red on `merge` loops back to `run-tests` exactly once, and `commit-push`
then `merge` re-run against the new attestation. Plus base derivation unit tests: `origin/develop`
→ `develop`; a 40-hex `run.baseBranch` is skipped in favour of `config.baseBranch`.

The step-list breakage Phase 3 causes is verified by the suite going green after the rewrites, but
two items need asserting rather than merely fixing:

- `types.test.ts:100` names nine ids in order, with `merge` between `commit-push` and `document`,
  under a test name that says nine.
- `types.test.ts:650` — after the `verify` union, the rewritten unknown-builtin guard must carry a
  **count floor** (`expect(checked).toBeGreaterThan(0)`, mirroring `:243`) proving it iterated real
  entries. Confirm the floor works by deleting it locally and reverting the normalization: the test
  must then pass while checking nothing, which is the exact failure the floor exists to catch.

**V4b (Phase 3, `document`).** A chain test with `autoMerge` on: after `merge` has merged and
deleted the task branch, `document` commits the record and `merged-into-base` is green. And the
negative: with `document`'s widened `bashAllowlist` reverted, the same scenario goes red — proving
the grant is what makes the step possible, not decoration.

**V5 (Phase 4).** A new `handoff-gate.test.ts`, mirroring `approval-gate.test.ts`: a post-condition
returning `handoff` parks the run at `waiting`/`'handoff'` with `pendingHandoff` persisted and the
concurrency slot released; `resolve` with the probe still red keeps it parked; `resolve` with the
probe green continues the chain; `skip` marks the step `skipped`; `recover()` re-parks from the
persisted record.

**V6 (Phase 5).** `postconditions.test.ts`: a file with one automatic and one manual target where
only the automatic one probes green returns `handoff` naming the manual target; both green returns
`ok`; a file with **no** `manual` key behaves byte-identically to today (the existing cases must
pass unmodified, which is the real regression control).

**V7 (end to end, dry run).** `CEZ_DRY_RUN=1 npm run test:package` must still complete the whole
chain. Under dry run every post-condition is simulated (`postconditions.ts:80-88`), so this proves
the ten-step chain is executable and that no new built-in wedges the mock path, which is exactly
what `57fc8807` broke when `verify` first landed.

**V8 (runtime, the owner-visible half, and NOT satisfied by V1 to V7).** One real
`spec-to-deploy` run on `prod-host` with `autoMerge: true` set in that box's
`.ai/cezar/config.json`, against a small real task in this repo. It must show:
`review-spec` reporting `gpt-5.6-sol` in its step model display; a green `commit-push` with a
`tested-revision-shipped` verdict naming a tree; a `merge` step green with HEAD an ancestor of
`origin/main`; and the `deploy` step **parked** at "Awaiting manual deployment" naming both cezar
targets, with the run never restarting `cezar.service` by itself. Then a human runs
`cezar server-deploy --strategy=blue-green`, clicks Resolve, and the run finishes `done`.

Until V8 has actually run, this is **QA Needed**, not done.

## What this spec could not establish

- The cockpit's approval-card component was not opened. Phase 4 must find it and mirror it rather
  than design a second parked-run presentation from this document.
- The Settings → Agents surface that would carry the `autoMerge` toggle was not opened either.
  Phase 3 mirrors `reviewGate`'s existing toggle rather than inventing a placement.
- No number is claimed for the cost delta of SOL xhigh review versus opus review. There is no
  measurement, so there is no number here.
- *(Closed 2026-08-24, in the review round that produced this revision. The box runs `git version
  2.53.0`, and D3 Mode B no longer inspects merge trees at all, so no git version floor remains
  anywhere in this spec.)*
