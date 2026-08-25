# Ship Bulk Task Starts

> **Status:** **spec written** 2026-08-24. Nothing in this document has been executed yet. This
> is step 2/9 of run `480e0282-a967-4936-a12e-3c4e56450586` (`spec-to-deploy`); the reconcile,
> commit, gate, deploy, E2E and record steps all follow.
> · **Date:** 2026-08-24
>
> **Task:** `480e0282-a967-4936-a12e-3c4e56450586`, "Ship bulk start filed tasks."
>
> **Brief:** `.ai/specs/briefs/2026-08-24-ship-bulk-start-filed-tasks.md`, written by step 1
> ("context") of this run. Note it landed in the **main checkout**
> (`/var/lib/cezar/loki-labs/cezar/.ai/specs/briefs/…`), not in this run's worktree, so it is not
> visible from `git status` here and will not travel in this task's commit.
>
> **Feature spec (the thing being shipped):** `.ai/specs/2026-08-24-bulk-start-filed-tasks.md`,
> written by parent task `e6592588-1628-40e0-b31a-8fe26c8b2220`. It exists **only** in that
> parent's worktree today (see § Measured facts, correction 2). This spec does not restate its
> design and does not reopen it.
>
> **Three of the brief's factual claims did not survive re-checking** and are corrected below with
> the commands that falsified them. The brief's judgement calls (the deletion is load-bearing, the
> deploy path, the five gates) all held.
>
> **Revised 2026-08-24 after step 3's review**, which found four execution defects and two false
> claims in the first draft. All six are fixed in place, each marked where it was wrong rather than
> quietly replaced: P1 preserves this file across its own `git reset --hard`; § Problem retracts the
> claim that `"manual": true` stops the workflow from verifying a probe; P5 authenticates before it
> asserts, and its cleanup accounts for cancel restoring the todo and for `DELETE /runs/:id`
> answering `409` while the cancel drains; P6 makes no repository edit after P2's single commit and
> writes through the proposal contract, reporting the un-appliable half as blocked. The six-file
> patch, the pinned base, the gate list, the deploy strategy and the DOM selectors were re-checked
> and stand unchanged.
>
> **Revised again 2026-08-24 after the second review**, which found twelve items, every one of them
> re-measured against the live code before being written in here. The five that change what this
> task *does* rather than how it words it:
>
> 1. **The parent diff carries a blocking correctness defect.** `batch` is computed from `sorted`,
>    not from the rendered `rows`, so a selected row that pagination has stopped rendering still
>    starts, which the feature spec explicitly forbids. § Architecture states it; **P1.5** fixes it
>    as a declared deviation. The claim that the patch was "unchanged from the feature spec" is
>    withdrawn.
> 2. **The gates now run BEFORE the commit** (P2/P3 swapped), and the commit is proved
>    byte-identical to the tree the gates ran on via `git write-tree`.
> 3. **`git push origin main` was pushing the wrong ref.** This worktree is on `cez/480e0282` and
>    local `main` is 23 commits stale; P4.1 is now `git push origin HEAD:main`.
> 4. **`systemd-run` without `--wait` returns before the deploy finishes**, so P4 probed the old
>    release. It now waits on the unit and then bounded-polls the activation.
> 5. **P5's cleanup asserted ground truth after destroying the session it needed to ask with**, so
>    every "absent" assertion could only have read a `401`. The order is inverted.
>
> Two factual claims are also corrected in place: `knowledge/proposals.ts` **does** exist and does
> implement `applyKnowledgeProposals` (only the CLI/HTTP wiring is missing), and the parent's note
> is **not** indexed and occupies no slug. Both were wrong in the previous draft in the direction
> that would have made a blocked acceptance criterion look closable.

## TLDR

Parent task `e6592588` implemented and gate-verified multi-select + **Run N tasks** on the `/tasks`
Filed table, but was not authorized to commit or push, so it could not deploy either. Everything
left is reconciliation and release engineering: replay the parent's 6-file patch onto current
`origin/main`, fix the one blocking defect in it (`batch` is taken from the whole sorted set
instead of the rendered rows, so an unrendered selected row starts; see § Architecture and P1.5), run all
five gates, commit once referencing the feature spec and prove the commit is byte-identical to the
tree the gates ran on, push with `git push origin HEAD:main`, deploy with
`cezar server-deploy --strategy=blue-green` and wait for the activation, execute both declared
readiness probes and paste their stdout as the evidence the acceptance criterion asks for, drive a
real authenticated Chromium against the live cockpit to tick two disposable Filed rows and press
**Run 2 tasks**, keep the screenshot and video, clean up every disposable run, todo and session the
E2E created, and append the outcome to this run's corpus proposal file.

No new feature design is in scope; the one code correction P1.5 makes is a defect fix the feature
spec already demands, not a design change. **This session makes exactly one commit**, in P3, and no
phase after it edits a tracked file: the deploy sha, release id, probe output, E2E verdict and
artifact paths go to the handoff and the corpus proposal, never back into the repository.

**One acceptance criterion cannot be fully closed by this task**, and that is stated up front rather
than discovered at the end: "confirm it is searchable" needs a *supported* way to apply a knowledge
proposal, and this checkout has none (§ Solution, decision 4; P6.2). This task delivers the
validated proposal line and reports the searchable half **blocked**.

## Problem

### The feature is finished and cannot reach a user

`e6592588` ran under a workspace-run policy that forbids commit and push. Blue-green deploy
resolves a *committed, pushed sha* (`server-deploy --sha=<sha>` against a source checkout whose
HEAD must agree with the build stamp, `release-deploy.ts:90-128`), so "no commit" transitively
means "no deploy". Its handoff records the terminal state plainly: *"Deploy blocked because
workspace-run policy forbids commit/push while blue-green deployment requires a committed, pushed
SHA."* The diff has been sitting in
`/var/lib/cezar/loki-labs/cezar/.ai/cezar/worktrees/e6592588-1628-40e0-b31a-8fe26c8b2220` since
22:19 UTC, green, and invisible to every user of the cockpit.

### Reconciliation is the part that can go wrong

The parent's worktree is not a clean feature branch. Its HEAD, `1089391e`, is a `cezar autosave
(run finalize)` commit sitting on a history that includes several `origin/main` merges. Diffing it
against the wrong base pulls in dozens of unrelated files, which is exactly what the task's
"do not include unrelated shared-checkout changes" instruction is guarding against, and exactly
what the first attempt at this reconcile did. See § Measured facts, correction 3.

### The declared probes have to be captured as evidence, not inferred

`.ai/deploy-targets.json` declares two targets and both carry `"manual": true` with a
`manualReason` of *"cezar service deployment requires a human to activate the service safely"*.
The acceptance criterion is "pass every declared readiness probe," and the file's own header
comment names the failure mode it exists to prevent: *"cezar is TWO services and shipping one
alone used to end that step green."*

**What `"manual": true` actually does, read from the code rather than assumed.**
`allServicesDeployed()` (`packages/cezar/src/workflows/postconditions.ts:297-366`) runs **every**
target's probe unconditionally, in declaration order, with `bash -lc` in the step's cwd, bounded
by `PROBE_TIMEOUT_MS`. `manual` is consulted only at `:345`, and only for a probe that has
**already failed**: a failed non-manual target lands in `failed` and returns a plain `ok: false`,
while a failed manual target lands in `manualFailed` and returns `ok: false` *plus* a
`handoff: { kind: 'manual-deploy', … }` carrying `manualReason`. A passing manual target is
indistinguishable from a passing ordinary one. So the flag does **not** skip the probe, does not
weaken it, and does not stop the workflow from verifying it. It only changes the shape of the
failure into a hand-back to a human.

**An earlier draft of this spec claimed the opposite** ("a green deploy step is not a run
readiness probe … `"manual": true` is the file's way of refusing to let a workflow step vouch for
activation"). That was wrong, and it is corrected here rather than left standing, because it would
have justified distrusting a green step for a reason that does not exist.

What survives the correction is the narrower, real requirement: the acceptance criterion asks this
task to *pass* every declared probe, and a workflow step's own green/red is a verdict, not
evidence. P4 therefore executes both probes itself and records the exact line each prints, so the
record carries the measurement and not a summary of one.

## Measured facts

All measured in this run's worktree
(`/var/lib/cezar/loki-labs/cezar/.ai/cezar/worktrees/480e0282-a967-4936-a12e-3c4e56450586`,
branch `cez/480e0282`, HEAD `b3d3a44c`) on 2026-08-24, after reading the brief.

**1. This worktree is 23 commits BEHIND `origin/main`, not level with it.** The brief's header says
*"HEAD `b3d3a44c`, clean, level with `origin/main`"*. It is not:

```
$ git rev-list --left-right --count origin/main...HEAD
23      0
$ git merge-base --is-ancestor HEAD origin/main && echo behind
behind
$ git rev-parse origin/main
e38cb6199756e3a23a05235e4900b23d37c9f629   # docs: record Backlog composer QA status
```

So "a clean current-`main` tree" is not what this worktree currently is, and P1 has to make it one
before anything is applied. The 23 commits include `48f9892c feat: land the Backlog composer`.

**2. `.ai/specs/2026-08-24-bulk-start-filed-tasks.md` is NOT already on `origin/main`, and IS part
of the patch.** The brief says it *"already landed separately (visible directly in this worktree
already, byte-identical spec content)"* and concludes it "is **not** part of what needs
reconciling." Both halves are false:

```
$ ls .ai/specs/2026-08-24-bulk-start-filed-tasks.md
ls: cannot access …: No such file or directory
$ git cat-file -e origin/main:.ai/specs/2026-08-24-bulk-start-filed-tasks.md
fatal: path … does not exist in 'origin/main'
```

It exists only in the parent worktree. It is one of the 6 files in the patch and must ride in this
task's commit, otherwise the commit references a spec that is not in the repository.

**3. The patch base is `9c896e32`, not `b3d3a44c`.** The brief names `9c896e32` in prose but a
naive `git merge-base HEAD <parent-HEAD>` returns `b3d3a44c` (because *this* worktree is behind),
and diffing from there yields **50 files, +4559/−665**: the feature plus 22 unrelated commits'
worth of other people's work. Diffing from `9c896e32` yields exactly what the brief describes:

```
$ P=…/worktrees/e6592588-1628-40e0-b31a-8fe26c8b2220
$ git -C "$P" diff --stat 9c896e32 1089391e
 .ai/specs/2026-08-24-bulk-start-filed-tasks.md    |  71 +++++
 packages/cezar/test/unit/deploy-e2e-probe.test.ts | 348 ----------------------
 packages/web/src/lib/filed-tasks.test.ts          |  53 ++++
 packages/web/src/lib/filed-tasks.ts               |  43 +++
 packages/web/src/routes/global-tasks.test.tsx     |  89 +++++-
 packages/web/src/routes/global-tasks.tsx          | 153 ++++++++++
 6 files changed, 407 insertions(+), 350 deletions(-)
```

`9c896e32` is an ancestor of `origin/main` (`git merge-base --is-ancestor 9c896e32 origin/main` →
0), which is what makes the replay legitimate.

**4. That patch applies cleanly onto current `origin/main`.** Verified in a throwaway detached
worktree at `origin/main`:

```
$ git worktree add --detach "$TMPD" origin/main
$ git -C "$TMPD" apply --check /tmp/feature.patch && echo clean
clean
```

None of the 23 intervening commits touch any of the five code/test files
(`git diff --stat HEAD origin/main -- <the five paths>` → empty output), so there is no semantic
conflict hiding behind the clean textual apply.

**5. `packages/cezar/test/unit/deploy-e2e-probe.test.ts` is still present on `origin/main`**
(`git cat-file -e origin/main:…` → 0), and the probe script it asserts against was last rewritten
by `587db317` ("make deploy-e2e-probe assertions non-vacuous"), which is an ancestor of both
`origin/main` and `9c896e32`. The brief measured `npm run test:unit` **red** on `b3d3a44c`: 53
tests, 45 pass, 8 fail, all 8 in that file, and nothing between `b3d3a44c` and `origin/main`
touches either the file or the script. So the brief's conclusion stands and is load-bearing: the
deletion is not cleanup riding along with the feature, it is the only thing that makes gate 3 of 5
green. Its `test/e2e/deploy-e2e-probe.test.ts` sibling (a different file, 6 different scenarios,
run by `npm run test:package`, `packages/cezar/package.json:40`) is retained and is the probe's
authoritative coverage.

**6. The live deploy is `9c896e32`, the patch base itself.**

```
$ curl -fsS http://127.0.0.1:4321/api/v1/health | jq .deploy
{"releaseId":"20260824T212504Z-9c896e32","sha":"9c896e32…","activatedAt":"2026-08-24T21:25:09.801Z","dirty":false}
$ ls -ld /opt/cezar
/opt/cezar -> /opt/cezar-releases/20260824T212504Z-9c896e32
```

**Consequence, and it belongs in Risks, not in a footnote:** this task's deploy does not only ship
the Filed-table feature. It activates every commit between `9c896e32` and this task's HEAD,
including `48f9892c feat: land the Backlog composer`, which is committed, pushed and *not yet
deployed*. That is correct behaviour (deploy ships HEAD, not a cherry-pick) but it means a
post-deploy regression is not automatically this feature's fault, and the E2E must not be read as
clearing the composer.

**7. The five gates, confirmed from `package.json`** (root `scripts`, read directly): `npm run
typecheck` (→ contract, client, server, web; `pretypecheck` builds the server first), `npm test`
(`vitest run`), `npm run test:unit` (→ `node --import tsx --test test/unit/*.test.ts` in
`packages/cezar`), `npm run build` (→ `build:server`, `build:web`, `check:pack`, `build:stamp`),
`npm run test:package` (→ `test/e2e/*.test.ts`, needs the completed build). There is **no** root
`lint` script. Confirmed: `lint` does not appear in root `scripts`.

**8. Playwright is on this box and an agent step may drive it without asking** (`AGENTS.md:469-528`):
Playwright 1.62.1, CLI at `/usr/bin/playwright`, engines cached in `$HOME/.cache/ms-playwright`.
Two traps recorded there and both apply to P5: resolution is **CommonJS-only** (this repo is
`"type": "module"`, so `import { chromium } from 'playwright'` in a `.mjs` fails with
`ERR_MODULE_NOT_FOUND`: use `node -e`, a `.cjs`, or `createRequire`), and
`PLAYWRIGHT_BROWSERS_PATH` must never be set, because `PLAYWRIGHT_` is not in `buildChildEnv()`'s
allowlist (`packages/cezar/src/core/agent-env.ts`) and the variable is dropped before the agent's
child starts.

### What could not be verified in this step

- **The gates were not run.** This is the spec step; it changes one file and runs no builds. Every
  gate result quoted above is the parent's or the brief's measurement, re-argued from git history
  rather than re-executed. P2 executes them for real on the reconciled tree, and its output is what
  counts. Note that P1.5's correction changes two of the files the gates cover, so the parent's
  `44 passed` / `11,779 passed` figures are expectations to compare against, not predictions to
  trust.
- **Cloudflare Access / the public `https://cockpit.example.com` origin was not exercised.** P5 is
  specified against `http://127.0.0.1:4321` (loopback on the box, same process, no Access
  perimeter). That is the *same production server*, so it satisfies "a real production browser
  E2E"; it does not prove the Access edge, and this spec does not claim it does.
- **No existing "disposable task" convention was found** on the Filed board. Searched the specs
  directory and the todo surface and found no naming prefix, tag or project reserved for throwaway
  rows. P5 therefore defines one (§ Solution, decision 4) rather than assuming one.

## Solution

Six independently shippable phases. Each ends in a state that is safe to stop at.

### The brief's four open questions, settled

**1. Reconciliation mechanics → patch replay from `9c896e32`, onto a worktree reset to
`origin/main`.** Not a merge and not a cherry-pick of `1089391e`: that commit is an autosave whose
history carries unrelated merges, and cherry-picking it would drag them in (measured fact 3). The
sequence is `git fetch origin` → `git reset --hard origin/main` on `cez/480e0282` (this worktree
is 23 behind and has no commits of its own to lose: the `0` on the right of
`rev-list --left-right --count` is the proof) → `git apply` the 6-file patch. Verified to apply
cleanly (measured fact 4). If it ever stops applying cleanly, stop and re-derive the patch; do not
reach for `--3way` to force it through.

**2. Disposable filed tasks → a dedicated title prefix, filed into the `cezar` project, deleted by
id after the run.** Since no convention exists, this spec defines the minimum one that is
self-documenting on the board and mechanically greppable:

- Title prefix **`E2E disposable:`**, followed by this run's short task id and an index, e.g.
  `E2E disposable: 480e0282 #1`.
- Created via `cezar todo add` in the `cezar` project (not a user's product board).
- Cleanup is by **id**, captured at creation time, never by matching titles at cleanup time.
- Because `POST /todos/:id/start` sets `startedTaskId` and `visibleTodos()` then hides the entry,
  the two todos are consumed by the batch. Cleanup is therefore of the **runs** they spawned:
  `POST /api/v1/runs/:id/cancel` then `DELETE /api/v1/runs/:id` (`server.ts:5192`, `server.ts:5879`).
  Any todo that did *not* start is removed with `DELETE /api/v1/p/:projectId/todos/:id`
  (`server.ts:6144`, ungated since D7a).

**3. Readiness probes → run them explicitly, and paste their stdout.** Not because the workflow
skips them (it does not, see § Problem), but because the acceptance criterion asks for a
*pass* and a step's own green is a verdict rather than evidence. P4 extracts each `probe` string
from `.ai/deploy-targets.json` and executes it with `bash -lc` from the repo root, exactly as
`allServicesDeployed()` does, and records the line each prints (`live=<sha> == HEAD` and
`serving assets/index-<hash>.js == the built bundle`).

**4. Corpus write → one `upsert` appended to this run's proposal file, and the application of it
is a human gate this task cannot close.** The mechanism is fixed by the run contract: an agent
records durable knowledge by appending NDJSON to **`$CEZ_KB_WRITE_FILE`**
(`workflows/run.ts:1310` sets it to `<dataDir>/runs/<runId>.knowledge.ndjson`), and never edits a
mounted corpus document directly. That is also what the parent did: its own
`upsert` for `cezar/bulk-start-filed-tasks.md` sits in
`/var/lib/cezar/workspace/.ai/cezar/runs/e6592588-…knowledge.ndjson`, body ending *"Status: QA
needed … The runtime E2E on the prod cockpit … has NOT been run."* P5 passing makes that sentence
false, so this run's line must correct it in place (workspace `CLAUDE.md` § "Correct in place"),
carrying a bolded `CORRECTED 2026-08-24` lead-in with the original claim left below it.

**Nothing this task can run applies that proposal, and the reason is missing wiring, not a missing
applier.**

> **CORRECTED 2026-08-24 (second review).** This paragraph said *"`knowledge/proposals.ts`'s applier
> (W4.2) does not exist in this checkout"*. **It does exist.**
> `packages/cezar/src/knowledge/proposals.ts` is 12,613 bytes and exports `knowledgeWriteFilePath`
> (`:34`), `readRunProposals` (`:46`) and **`applyKnowledgeProposals`** (`:75`), with working
> `applyUpsert` / `applySupersede` implementations below it. The false claim mattered: it framed the
> blocked criterion as "a feature nobody has built", which is a reason to shrug, rather than as
> "a built function nothing calls", which is a one-line wiring gap somebody can close.

What is missing is every *supported way to invoke* that applier:

- `cez kb` has exactly six subcommands, `search|show|write|reindex|roots|proposals`
  (`knowledge/cli.ts:71, 80`), and `proposals` only **lists** pending lines (`:485-500`). There is
  no `apply`, and the CLI does not import `proposals.ts` at all: it re-derives its own reader.
- `POST /knowledge/proposals/apply` resolves each requested `seq` with `readRunProposals` and then
  refuses every one of them with `applying knowledge proposals is not implemented yet`
  (`server/knowledge-routes.ts:68, 239-258`), the handler imports the module's *reader* and never
  calls the *applier* sitting beside it. Its module comment (`:39-49`) still asserts the applier
  "does not exist in this checkout"; **that comment is stale**, and it is where the previous draft's
  error came from. Reading the comment is not reading the code.

So the acceptance item "confirm it is searchable" splits. The *write* is delivered by this task as a
complete, validated proposal line. The *searchable* half is blocked on a supported application path,
and P6 reports it as blocked, **which means acceptance criterion 6 is not fully met by this task**.
It does not reindex an unchanged corpus and call the resulting grep a pass, and it does not
hand-edit a mounted corpus document to close the gap: the workspace rule is *never edit a mounted
document directly; a proposal is reviewed and applied later, through the cockpit or
`cez kb proposals`*. An earlier draft's "either by hand as the `cezar` user" instruction contradicted
that rule and is removed.

### Rejected alternatives

- **Merge the parent branch.** Rejected: brings 22 unrelated commits' worth of diff through an
  autosave commit, directly violating "do not include unrelated shared-checkout changes."
- **Deploy `--strategy=restart`.** Rejected: `/opt/cezar` is a symlink into `/opt/cezar-releases/`
  on this box; the `dist`-swap path documented in `AGENTS.md:12` mutates the live release in place
  and destroys the property rollback depends on (`AGENTS.md:13`).
- **Skip the declared probes because the `deploy` step went green.** Rejected: see decision 3. The
  step's green does mean both probes passed; the acceptance criterion asks for the measurement.
- **Reuse an existing `cez_session` from `identity/identity.json`** the way the deploy-e2e-probe
  runbook does. Rejected: that borrows the owner's live session, which this task then must not
  destroy, leaving no clean end-state. Minting a 15-minute session costs one call and is revocable.
- **Run the E2E against `https://cockpit.example.com`.** Rejected for the primary assertion: the
  Access perimeter needs a service token and adds a failure mode orthogonal to the feature. Named
  as a limitation rather than papered over.
- **Fix `deploy-e2e-probe.test.ts` instead of deleting it.** Rejected: out of scope, and the
  parent already made the call with a design record (`.ai/specs/2026-08-22-deploy-e2e-probe-vacuous-pass.md`);
  the structured-contract package suite is the retained coverage.

## Architecture

### What is being shipped, and the one defect in it

`packages/web/src/lib/filed-tasks.ts` gains five pure helpers appended after the existing
filter/sort/status vocabulary owned by `.ai/specs/2026-08-17-filed-tasks-table-statuses.md`:
`filedTaskKey` (`` `${entry.project}:${entry.todo.id}` ``), `toggleFiledSelection`,
`setFiledSelection`, `selectedFiledEntries`, `filedSelectionState` (→ `'none' | 'some' | 'all'`).

`packages/web/src/routes/global-tasks.tsx` gains `useStartFiledTasks()` beside the untouched
single-row `useStartFiledTask`. The batch mutation loops the entries, `await`s
`startWorkspaceTodo(entry.project, entry.todo.id)` **one at a time**, catches per-entry so a
failure never aborts the rest, returns `{ started, total, failures }`, invalidates
`workspaceQueryKeys.workspaceTodos` and `workspaceQueryKeys.runsIndex` once, toasts
`Started N task(s)` or `Started N of M: <reason>`, and **never navigates**.

#### BLOCKING DEFECT in the parent diff: the batch is taken from the wrong set

> **CORRECTED 2026-08-24 (second review).** This section's heading used to read *"unchanged from the
> feature spec; restated only so the E2E has selectors"*. That claim is withdrawn: the patch
> contradicts its own spec on the one behaviour that spec calls out as a risk, and shipping it
> verbatim would deploy the defect.

The feature spec (`.ai/specs/2026-08-24-bulk-start-filed-tasks.md`) states the rule twice:
*"Intersect selection with the currently visible, filtered, sorted rows before starting"*
(§ Solution) and *"Hidden selected rows must never start. The action intersects with visible rows."*
(§ Risks). The code intersects with the **whole sorted set** instead:

```
packages/web/src/routes/global-tasks.tsx:790   const rows  = sorted.slice(0, shown)     // rendered
packages/web/src/routes/global-tasks.tsx:794   const batch = selectedFiledEntries(sorted, selected)
```

`FILED_ROW_PAGE_SIZE = 100` (`packages/web/src/lib/filed-tasks.ts:210`), and `shown` is **reset to
100 by an effect on every view / filter / sort / query change** (`global-tasks.tsx:782-785`) while
`selected` is left untouched by that effect. The reproduction is ordinary use, not a corner case:

1. Page in past 100 rows (`Show 100 more`), so `shown` is 200 or 300.
2. Tick a row at position 150.
3. Change the sort. The effect resets `shown` to 100; the row is no longer rendered.
4. The selection bar still counts it, the button still says `Run N tasks`, and pressing it **starts
   a task the user cannot see on the page**.

The existing route test does not catch this. `global-tasks.test.tsx:1499` (*"does not start a
selected row hidden by the current filter"*) passes for an unrelated reason: a filter change removes
the entry from `filtered`, therefore from `sorted`, so even the `sorted`-based batch drops it.
**Pagination is the hiding mechanism with no coverage**, and it is the one `shown` exists for.

**The fix, applied by P1.5 explicitly and never silently:**

- `const batch = selectedFiledEntries(rows, selected)`: `rows`, the rendered slice, not `sorted`.
  No helper change is needed: `selectedFiledEntries(entries, selected)` already takes the list to
  intersect against (`filed-tasks.ts:258-263`), which is exactly why this reads as a call-site slip
  rather than a design disagreement.
- One regression test in `packages/web/src/routes/global-tasks.test.tsx`: render more than
  `FILED_ROW_PAGE_SIZE` filed rows, page in past 100, select a row beyond position 100, trigger the
  `shown` reset with a sort change, and assert that both the selection count and the set of started
  todos exclude it.

**This is a deviation from "reconcile only the parent task diff", and it is declared, not absorbed.**
It is also not optional: the alternative is deploying a defect the feature spec itself forbids. The
deviation is two hunks in two files, both named above, and it is recorded in P1.5, in P3's commit
body, in this run's handoff and in P6's corpus proposal. If the owner would rather ship the parent
diff verbatim, the correct response is to send the defect back to the parent task, but that stops
this task at P1, and this spec's default is to fix it here and say so loudly.

**Consequence for every patch statistic in this document:** `6 files changed, 407 insertions(+), 350
deletions(-)` is the **pre-correction baseline**, checked in P1 before P1.5 runs. P1.5 re-measures
the post-correction stat and records it; this spec does not assert a number it has not run.

The DOM contract the E2E depends on, all present in the patch and unaffected by the correction
above:

| selector | what it is |
| --- | --- |
| `[data-slot="filed-select"]` | per-row checkbox (table row and card) |
| `[data-slot="filed-select-all"]` | tri-state header checkbox, `indeterminate` via a ref effect |
| `[data-slot="filed-selection-bar"]` | the bar, rendered only when `batch.length > 0` |
| `[data-slot="filed-selection-count"]` | the count text inside it |
| `[data-action="start-selected-filed-tasks"]` | the **Run N tasks** button |
| `[data-action="clear-filed-selection"]` | **Clear** |

### What this task does

```
parent worktree e6592588 (HEAD 1089391e)
        │  git diff 9c896e32 1089391e          ← 6 files, +407/−350 (pre-correction baseline)
        ▼
   /tmp/feature.patch
        │  git apply
        ▼
this worktree, reset --hard to origin/main (e38cb619)
        │  P1.5: sorted → rows + one regression test   (declared deviation)
        ▼
   five gates  (P2: typecheck · test · test:unit · build · test:package)
        │  green, and the tree is not touched again
        ▼
   git add by name → TESTED_TREE=$(git write-tree) → one commit
        │  assert  git rev-parse HEAD^{tree} == $TESTED_TREE
        ▼
   git push origin HEAD:main
        │
        ▼
   systemd-run --user --wait  ──►  cezar server-deploy --strategy=blue-green --sha=<HEAD>
        │                            (new /opt/cezar-releases/<ts>-<sha>, symlink flip)
        ▼
   bounded-poll /api/v1/health until activatedAt changes and sha == HEAD (or a descendant)
        │
        ▼
   both declared probes  ──►  authenticated Playwright E2E on http://127.0.0.1:4321/tasks
        │
        ▼
   one upsert appended to $CEZ_KB_WRITE_FILE  (application: blocked, P6)
```

Note what the diagram does **not** contain: any arrow back into the repository after the commit.
The tree that P2 gated is the tree P3 commits, and `git write-tree` proves it rather than asserting
it; that same tree is what P4 pushes and deploys, and it stays that tree.

## Data models and API contracts

**No data-model change and no API change.** Selection is transient React state, a
`ReadonlySet<string>` of `` `${project}:${todoId}` `` keys, and is never persisted, never sent to
the server, and never written to the URL.

Endpoints this task **uses** (all pre-existing, none modified):

| method + path | used by | for |
| --- | --- | --- |
| `POST /api/v1/p/:projectId/todos/:id/start` | the feature | one call per selected row; N calls is the whole feature |
| `GET /api/v1/health` | P4 | `deploy.{releaseId,sha,activatedAt}`: the deploy ledger (`.deployed-commit` is dead on this box) |
| `GET /api/v1/ready` | P4 | the backend probe's `deploy.sha` source |
| `GET /` | P4 | the UI probe's served-bundle source |
| `GET /api/v1/workspace/todos` | P5 | the Filed table's data; **401 without a session** (measured) |
| `GET /api/v1/workspace/runs-index` | P5 | the runs surface (`server.ts:7276`) |
| `POST /api/v1/runs/:id/cancel` | P5 cleanup | stop a disposable run (**also restores its todo**) (`server.ts:5192-5207`) |
| `DELETE /api/v1/runs/:id` | P5 cleanup | remove it; **409 `run is active — cancel it first`** while it is still draining (`server.ts:5879-5881`) |
| `DELETE /api/v1/p/:projectId/todos/:id` | P5 cleanup | remove a disposable todo (`server.ts:6144`) |

**Authentication is a hard requirement of P5, and it is measured, not assumed.** This box runs
`CEZ_AUTH=oidc`, and on loopback today:

```
$ curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4321/tasks                    → 200   (the SPA shell)
$ curl -s http://127.0.0.1:4321/api/v1/workspace/todos                                    → {"error":"unauthenticated"}  (401)
$ curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4321/api/v1/runs              → 401
```

So an unauthenticated browser reaches `/tasks` and renders an empty Filed table forever: the page
loads, every assertion below it fails, and the failure looks like a feature bug. The credential is
the `cez_session` cookie (`auth/session.ts:75`, `SESSION_COOKIE_NAME`), which is the same
credential the deploy-e2e probe runbook already uses over loopback
(`.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md:875-905`,
`.ai/specs/2026-08-22-deploy-e2e-probe-measured-assertions.md:795-810`). Those runbooks *read* an
existing unexpired id out of `<CEZ_HOME>/identity/identity.json`; P5 **mints its own short-TTL one
instead** (`SessionService.createSession`, `auth/session.ts:239`, re-exported as
`createSession(userId, ttlMs)` at `:356`) so the E2E never borrows the owner's live session and
can destroy exactly what it created (`destroySession`, `:263/:360`).

## Phases

### P1: Reconcile onto current `main` *(stop-safe: a clean tree, nothing committed)*

**Step 0 is not optional: `git reset --hard` deletes this document.** This spec file is staged
(`A .ai/specs/2026-08-24-ship-bulk-start-filed-tasks.md`) and exists nowhere else: it is not on
`origin/main`, not in the parent's patch, not committed anywhere. `reset --hard` discards the index
and the working tree together, so running it first destroys the very plan being executed, with no
reflog entry to recover it from (nothing was ever committed).

0. **Preserve it outside the worktree, before touching git at all:**

> **CORRECTED 2026-08-24 (second review): the save path was inside the worktree and its parent did
> not exist.** The previous draft wrote
> `SAVE=.ai/cezar/tmp/480e0282-…/ship-spec.md` and commented it *"outside the repo"*. It is a
> **relative** path, so it resolves inside this worktree, where `ls .ai/cezar/tmp` answers *No such
> file or directory*, so the `cp` would have failed, and the `reset --hard` on the next line would then
> have destroyed the only copy of this document. Use `$TMPDIR`, which this run already owns and which
> points at the **main checkout**
> (`/var/lib/cezar/loki-labs/cezar/.ai/cezar/tmp/480e0282-a967-4936-a12e-3c4e56450586`, measured
> present, `cezar`-owned), somewhere no git operation in this worktree can reach.

```bash
SPEC=.ai/specs/2026-08-24-ship-bulk-start-filed-tasks.md
SAVE="$TMPDIR/ship-spec.md"          # genuinely outside this worktree (see the correction above)
test -d "$TMPDIR" || { echo "TMPDIR does not exist: STOP, do not reset"; exit 1; }
cp "$SPEC" "$SAVE" && sha256sum "$SPEC" "$SAVE"    # the two digests must match
test -s "$SAVE" || { echo "save is empty: STOP, do not reset"; exit 1; }
```

1. `git fetch origin`.
2. `git reset --hard origin/main` in this worktree. Confirm `git rev-parse HEAD` equals
   `git rev-parse origin/main` and `git status --porcelain` is empty. (Empty is expected here and
   is not a loss: the shipping spec is the only uncommitted content, and step 0 saved it.)
3. **Restore the shipping spec** and verify it round-tripped:

```bash
cp "$SAVE" "$SPEC" && sha256sum "$SPEC" "$SAVE"    # digests match the pair from step 0
```

4. `git -C <parent-worktree> diff 9c896e32 1089391e > /tmp/feature.patch`; confirm
   `git apply --stat /tmp/feature.patch` lists exactly the 6 files of measured fact 3 and nothing
   else.
5. `git apply --check /tmp/feature.patch`, then `git apply /tmp/feature.patch`.
6. **Two separate checks, deliberately not one.** The parent's contribution and this spec are
   different things and are verified apart, so a discrepancy in either is unambiguous:

```bash
# (a) the parent patch, exactly, ignoring the untracked shipping spec:
git diff --stat HEAD -- packages .ai/specs/2026-08-24-bulk-start-filed-tasks.md
#     must read: 6 files changed, 407 insertions(+), 350 deletions(-)

# (b) the shipping spec, as the one intentional seventh path:
git status --porcelain | wc -l      # 7
git status --porcelain | grep -c '2026-08-24-ship-bulk-start-filed-tasks.md'   # 1
```

Any **eighth** path is a defect: investigate, do not `git add -A`.

**Done when:** check (a) reproduces `6 files changed, 407 insertions(+), 350 deletions(-)` exactly,
check (b) shows the shipping spec present and byte-identical to its pre-reset digest, and nothing
else is in the tree. That figure is the **pre-correction baseline**; P1.5 changes it deliberately.

### P1.5: Fix the blocking defect in the parent diff *(stop-safe: a clean tree, nothing committed)*

The parent patch starts selected rows that pagination has stopped rendering, which its own feature
spec forbids twice (§ Architecture → *BLOCKING DEFECT*, with the reproduction and the citations).
**This phase is a declared deviation from "reconcile only the parent task diff"; it is never made
silently.** Exactly two hunks, in two files already in the patch, no new path is introduced, so
P1's "any eighth path is a defect" rule still holds unchanged.

1. In `packages/web/src/routes/global-tasks.tsx`, one line:

```
-  const batch = selectedFiledEntries(sorted, selected)
+  const batch = selectedFiledEntries(rows, selected)
```

   `rows` is already in scope four lines above (`const rows = sorted.slice(0, shown)`), and
   `selectedFiledEntries` already accepts whatever entry list it is handed
   (`packages/web/src/lib/filed-tasks.ts:258-263`), so no helper signature changes.

2. In `packages/web/src/routes/global-tasks.test.tsx`, add one regression test that the
   `sorted`-based code fails and the `rows`-based code passes:

   - Render more than `FILED_ROW_PAGE_SIZE` (100) filed entries.
   - Page in with `Show 100 more` so `shown > 100`.
   - Select a row at a position beyond 100.
   - Change the sort, which fires the `shown` reset effect (`global-tasks.tsx:782-785`).
   - Assert `[data-slot="filed-selection-count"]` no longer counts that row, and that pressing
     **Run N tasks** issues no start for its todo id.

   Name it so the reason survives: *"does not start a selected row hidden by pagination"*, beside
   the existing *"…hidden by the current filter"* at `:1499`.

3. Re-measure the patch and record the new figure, **do not carry `+407/−350` forward**:

```bash
git diff --stat HEAD -- packages .ai/specs/2026-08-24-bulk-start-filed-tasks.md
git status --porcelain | wc -l      # still 7: no new path
```

**Done when:** the two hunks are in the tree, the path count is still 7, and the re-measured stat is
recorded in the handoff. **The gates have not run yet**; P2 is what decides whether this is correct.

### P2: Five gates on the reconciled tree *(stop-safe: green or stop, nothing committed)*

> **CORRECTED 2026-08-24 (second review): the gates run BEFORE the commit, not after it.** The
> previous draft committed in P2 and gated in P3. That inverts this repo's own rule, *"Gates first,
> fail closed. Never commit/push/deploy a red build. Typecheck + lint + tests green is the
> precondition for the commit-push step"* (`AGENTS.md:11`), and inverts the `spec-to-deploy` step
> order this run is executing (read → spec → implement → **run-tests** → commit-push → document →
> deploy). It also manufactures a commit that nothing has verified, which a red gate then has to be
> un-made from.

From the repo root, in order, each must exit 0:

```
npm run typecheck
npm test
npm run test:unit
npm run build
npm run test:package
```

Record each command's tail. `npm test` is the long one; background it to a file and block on an
`EXIT=` marker rather than a guessed sleep. **Fail closed** (`AGENTS.md:11`): a red gate ends this
task at P2 with the failure quoted. Nothing is committed, nothing is pushed, nothing is deployed.

A red gate in `global-tasks.test.tsx` is the expected shape of "P1.5 was done wrong": fix P1.5 and
re-run P2 from the top, rather than weakening the new test.

**Do not touch the working tree between the last green gate and P3's `git write-tree`.** If anything
does change it (a stray formatter, a rebuild that rewrites a tracked file), the gates are stale and
P2 runs again. This is the property P3 then proves mechanically.

### P3: One commit, proved identical to the tested tree *(stop-safe: committed locally, not pushed)*

`git add` the paths **by name**, never `-A`. There are seven: the six of the parent patch (two of
them also carrying P1.5's correction) plus this spec.

```bash
git add packages/web/src/lib/filed-tasks.ts \
        packages/web/src/lib/filed-tasks.test.ts \
        packages/web/src/routes/global-tasks.tsx \
        packages/web/src/routes/global-tasks.test.tsx \
        packages/cezar/test/unit/deploy-e2e-probe.test.ts \
        .ai/specs/2026-08-24-bulk-start-filed-tasks.md \
        .ai/specs/2026-08-24-ship-bulk-start-filed-tasks.md

# `git add` of a removed path stages the deletion, deploy-e2e-probe.test.ts is that path.
# Anything still unstaged or untracked after this is something the gates saw and the commit
# would not carry. Must print nothing:
git status --porcelain | grep -v '^[ADMR]. ' || true

TESTED_TREE=$(git write-tree)      # the exact bytes P2 gated, frozen as a tree object
```

One commit:

```
feat: bulk start filed tasks (2026-08-24-bulk-start-filed-tasks)
```

The body names the spec, the parent task id, and **three** things a `git log` reader needs:

- `packages/cezar/test/unit/deploy-e2e-probe.test.ts` is deleted because its assertions target the
  pre-`587db317` probe-script shape and are the only failures in `npm run test:unit`;
- P1.5's `sorted` → `rows` correction, named as a **declared deviation from the parent diff**, with
  its reason (the parent patch started rows hidden by pagination, which its own spec forbids);
- the trailer `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

Then prove the commit is the tested tree, rather than something adjacent to it:

```bash
test "$(git rev-parse HEAD^{tree})" = "$TESTED_TREE" && echo TREE_MATCHES_TESTED=1
git status --porcelain      # empty: nothing was left out of the commit
git rev-list --count origin/main..HEAD   # 1
```

A mismatch means the tree moved between the gates and the commit. Go back to P2 and re-run all five;
do not amend past it.

This spec file (`.ai/specs/2026-08-24-ship-bulk-start-filed-tasks.md`) rides in the same commit.
It is the release record for the change and is worthless landing separately.

### P4: Push and deploy *(stop-safe: rollback is one command)*

1. **`git push origin HEAD:main`**, with the remote named explicitly and the source ref spelled out.

   > **CORRECTED 2026-08-24 (second review): the previous draft said `git push origin main`, which
   > pushes the wrong commit from here.** `main` on the left of a refspec means *the local branch
   > named `main`*, and this worktree is on `cez/480e0282` while local `main` still points at
   > `b3d3a44c` (measured: `git rev-parse main` → `b3d3a44c…`, `git rev-parse origin/main` →
   > `e38cb619…`). That command would have pushed a 23-commit-stale branch carrying none of this
   > work, or been rejected non-fast-forward, and in neither case would the feature have shipped,
   > while the deploy in step 4 would have gone ahead against a sha nobody pushed. `HEAD:main` is the
   > explicit-refspec form the workspace `CLAUDE.md` already requires when pushing from an isolated
   > task worktree.

   Never a bare `git push`, never `upstream`. `git remote -v` in this checkout shows `origin` only
   (`https://github.com/MarcinWalendowski/cezar.git`), so there is no `upstream` here to reach by
   accident, the rule stands regardless. Verify immediately, before anything is deployed:

```bash
git push origin HEAD:main
git fetch origin
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" && echo PUSHED=1
```

   A mismatch here stops P4. `server-deploy` resolves a *pushed* sha, so deploying an unpushed HEAD
   is the failure mode this check exists to catch.
2. Check for a competing deploy before starting one. Todo
   `d0386413-8bac-4e2a-88c4-62c37ab87ea1` ("non-disruptive cezar self-deploy") is `in-progress` and
   owns this path; a concurrent `server-deploy` on the same box would race. Compare
   `/api/v1/health`'s `deploy.activatedAt` before and after to detect one.
3. `npm run build` has already run in P2 and wrote `packages/cezar/dist/.build-stamp.json`;
   `server-deploy` refuses to stage without it, and rejects it if it is older than `packages/*/src`
   or names a sha that disagrees with HEAD (`release-deploy.ts:90-128`, gated at `:391-405`). The
   stamp names the sha of the *source checkout's HEAD*, so it is valid here precisely because P3
   proved the commit is the tested tree. If anything changed the tree after P2's build, rebuild,
   and if a rebuild changes a tracked file, the commit is stale and P2/P3 run again.
4. Deploy from a **user** transient unit, never a system one (`AGENTS.md:13`), and **wait for it**:

```bash
export XDG_RUNTIME_DIR=/run/user/999 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/999/bus
systemd-run --user --wait --unit=cez-deploy-<sha> --collect --property=Type=oneshot \
  --working-directory=/var/lib/cezar/loki-labs/cezar \
  --setenv=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  /usr/bin/node packages/cezar/dist/index.js server-deploy --strategy=blue-green \
  --source=<this worktree> --sha=<HEAD>
echo "systemd-run exit=$?"
```

   > **ADDED 2026-08-24 (second review): `systemd-run` returns when the unit has STARTED, not when
   > the deploy has finished.** Without `--wait` it exits as soon as the transient unit is queued, so
   > the previous draft's next line ran the readiness probes against the **old** release. That is
   > worse than a plain failure: the backend probe compares the live sha to HEAD, so it would have
   > read red for a deploy that was merely still running, or (if a concurrent deploy from todo
   > `d0386413` had landed a descendant sha) green without this deploy having finished at all.

   Two gates, both required, before any probe runs:

   - **`--wait`**, and check the exit status. A non-zero unit result is a **deployment failure**:
     stop, capture `systemctl --user status cez-deploy-<sha>` and
     `journalctl --user -u cez-deploy-<sha> --no-pager`, and do not proceed.
   - **Then bounded-poll the activation**, because `--wait` covers the deploy process and the
     symlink flip but not the restarted server answering. The sanctioned until-loop, never a guessed
     sleep:

```bash
before=<deploy.activatedAt captured in step 2>     # the PREVIOUS activation, for comparison
head=$(git rev-parse HEAD)
deadline=$(( $(date +%s) + 300 ))
while :; do
  d=$(curl -fsS --max-time 10 http://127.0.0.1:4321/api/v1/health 2>/dev/null | jq -c .deploy)
  live=$(printf '%s' "$d" | jq -r '.sha // empty' 2>/dev/null)
  act=$(printf '%s'  "$d" | jq -r '.activatedAt // empty' 2>/dev/null)
  if [ -n "$live" ] && [ "$act" != "$before" ] &&
     { [ "$live" = "$head" ] || git merge-base --is-ancestor "$head" "$live" 2>/dev/null; }; then
    echo "ACTIVATED $d"; break
  fi
  [ "$(date +%s)" -ge "$deadline" ] && { echo "TIMEOUT: activation never observed"; exit 1; }
  sleep 5
done
```

   Both conditions matter: `activatedAt` changing proves *an* activation happened, and the sha test
   proves it is **this** one. The descendant case is legitimate and expected on this box: todo
   `d0386413` owns the same path and a concurrent deploy can land a later sha, in which case
   everything at this HEAD is still in the running process (the declared backend probe reasons
   identically, `.ai/deploy-targets.json`). **A timeout is a deployment failure and is recorded as
   one.** It is not "the probes will tell us": the probes are the next step and would inherit the
   ambiguity.

5. Execute **both** probes from `.ai/deploy-targets.json` yourself (`bash -lc`, from the repo root,
   the same invocation `allServicesDeployed()` uses) and paste the exact line each prints.
   Expected: `live=<sha> == HEAD` (or the documented `is a descendant of HEAD` variant if a
   concurrent deploy landed later) and `serving assets/index-<hash>.js == the built bundle`. This
   duplicates what the workflow's own postcondition does, on purpose: the criterion is a recorded
   pass, and the step's green is not that recording.

**Rollback:** `cezar server-deploy --rollback=` (the `=` spelling; bare `--rollback` also works
since `f97ddd39` was fixed on 2026-08-23, but `--rollback=` is the spelling that has always
worked). Rollback probes readiness itself since `2f91de4b`.

### P5: Real browser E2E on production *(stop-safe: cleanup runs even on failure)*

> **CORRECTED 2026-08-25:** The recipe below was executed by the 480e0282 production E2E, and its
> cleanup used the unscoped routes `POST /api/v1/runs/:id/cancel` and `DELETE /api/v1/runs/:id`.
> It treated their `404` responses as success, even though those routes resolve the boot project
> and the disposable runs belonged to the `cezar` project. The replacement is to resolve the owning
> project id from the registry and use `POST /api/v1/p/<projectId>/runs/<id>/cancel`,
> `DELETE /api/v1/p/<projectId>/runs/<id>`, and `GET /api/v1/p/<projectId>/runs/<id>` for the
> absence proof. The production E2E failed at the post-start row-removal assertion and remains
> **QA Needed**.

Driven with Playwright/Chromium against `http://127.0.0.1:4321`, the live production process on
this box. Loopback clears the **Cloudflare Access** perimeter, and nothing else: the application's
own session gate still applies, and every data API the Filed table needs answers `401
unauthenticated` without a `cez_session` cookie (§ Data models, measured). **CommonJS resolution
only** (measured fact 8): `node -e "…"`, a `.cjs` script, or
`createRequire(import.meta.url)('playwright')`.

Artifacts into **`$TMPDIR/e2e/`**, where `$TMPDIR` is
`/var/lib/cezar/loki-labs/cezar/.ai/cezar/tmp/480e0282-a967-4936-a12e-3c4e56450586`, this run's own
durable directory under the **main checkout** (measured present, `cezar`-owned), outside the repo, so
nothing lands in the commit.

> **CORRECTED 2026-08-24 (second review):** the previous draft wrote that same path **relatively**,
> which resolves inside this disposable worktree, where `.ai/cezar/tmp` does not exist at all
> (`ls` → *No such file or directory*). The screenshots would have failed to write, and anything that
> did write would be reaped with the worktree, losing exactly the evidence acceptance asks to retain.

**Create it before launching Playwright.** `recordVideo.dir` is created for you; a
`page.screenshot({ path })` into a missing directory is an error, and it would fire in the middle of
the run rather than at the start.

```bash
mkdir -p "$TMPDIR/e2e"     # OUT=$TMPDIR/e2e for everything below
```

```js
const context = await browser.newContext({ recordVideo: { dir: OUT } })
```

…and `page.screenshot({ path: … })` at each numbered assertion below. `browser.close()` in a
`finally`. A leaked Chrome is the memory pressure `AGENTS.md:500` warns about.

Steps:

0. **Mint a dedicated session and install it as a cookie.** Not the owner's live session, and never
   printed: the value is a bearer credential for the whole cockpit.

```js
// node --import tsx, from the repo root; identityDir() defaults to <CEZ_HOME|~>/.cezar/identity
// user id comes from the existing identity store; createSession throws `user-not-found`
// for an id with no User row (auth/session.ts:250-258), so it cannot be invented.
const { createSession, destroySession } = await import('./packages/cezar/src/auth/session.ts')
const { id } = await createSession(USER_ID, 15 * 60 * 1000)   // 15 min, not the 30-day default
```

```js
await context.addCookies([{ name: 'cez_session', value: id, domain: '127.0.0.1', path: '/' }])
```

   - The user id is read from `/var/lib/cezar/.cezar/identity/identity.json` → `users[]` (178-todo
     board, single-org box); pick the account that owns the `cezar` project.
   - **Preflight before opening any page:** `GET http://127.0.0.1:4321/api/v1/workspace/todos` with
     that cookie must answer **200**. A 401 here stops P5 immediately, because proceeding would produce an
     empty Filed table and a stream of assertion failures that read like feature bugs.
   - **Never log, echo, screenshot or write the cookie value.** Keep it in the process; if it must
     cross a process boundary, a `0600` file under this run's `tmp/` that is `rm`'d in the same
     `finally` that destroys the session. Playwright's video records the viewport only, but do not
     navigate to anything that renders the value.
   - **`destroySession(id)` in the `finally`** (`auth/session.ts:263`), asserting it returns `true`,
     then re-issuing the preflight request and asserting it now answers **401**. A session that
     outlives the E2E is a credential nobody is tracking. **Its ordering within the `finally` is
     fixed by cleanup (d)/(e) below: the session is destroyed LAST**, after the authenticated
     ground-truth queries have run, because those queries need the very credential this revokes.
1. Create two disposable todos: `cezar todo add "E2E disposable: 480e0282 #1" --project cezar`
   and `#2`. **Capture both ids.**
2. `page.goto('http://127.0.0.1:4321/tasks')`; wait for the Filed table; screenshot `01-filed.png`.
3. Record `page.url()` and the current run count (from the runs index / the runs surface) as the
   before-state.
4. Tick the two rows via their `[data-slot="filed-select"]` checkboxes, scoped to the rows whose
   text contains the two disposable titles. Screenshot `02-selected.png`.
5. Assert `[data-slot="filed-selection-bar"]` is visible and
   `[data-slot="filed-selection-count"]` reads 2. Read the button's label now and assert it is
   `Run 2 tasks`; read it **before** the click, since the mutation swaps it to `Starting...`.
6. **Register the response capture BEFORE clicking anything.**

   > **CORRECTED 2026-08-24 (second review): this used to be step 8, i.e. attached AFTER the click.**
   > That races both `201`s. A start that answers before the listener attaches is never observed, so
   > *"exactly two `201` responses"* can fail on a perfectly working feature. Far worse, a run that
   > really was created ends up with **no captured id and therefore no cleanup**, leaving a live
   > disposable run on the production board. Attach first, always.

```js
const startResponses = []
const cleanupRunIds = []
page.on('response', async (res) => {
  const path = new URL(res.url()).pathname
  if (!/\/todos\/[^/]+\/start$/.test(path)) return
  startResponses.push({ path, status: res.status() })
  if (res.status() === 201) {
    try { cleanupRunIds.push((await res.json()).run.id) }
    catch (err) { captureFailures.push(String(err)) }   // reported, never swallowed
  }
})
```

   Ids are pushed onto `cleanupRunIds` **inside the handler, as each response arrives**, so an
   assertion that fails later still leaves the cleanup everything it needs.
   `POST /p/:projectId/todos/:id/start` answers `201 {"run": {...}}` (`server.ts:6164`+), and taking
   the ids off the network rather than off the board is what makes this immune to the concurrent real
   runs this box always has, a DOM count or a `GET …/runs-index` diff is not.
7. Click `[data-action="start-selected-filed-tasks"]`.
8. Assert **`page.url()` is unchanged**. This is the single most important assertion in the whole
   E2E and the one the unit tests can only approximate. Screenshot `03-after-start.png`.
9. Bounded-poll until `startResponses.length === 2` (never a guessed sleep; a short deadline, and a
   timeout is a failure), then assert: exactly two captures, both `201`, both naming one of step 1's
   two disposable todo ids in their path, `cleanupRunIds.length === 2`, and `captureFailures` empty.
10. Assert the two rows are gone from Filed (started todos are hidden by `visibleTodos()`).
11. **Cleanup, in a `finally`.** The order matters and no step in it is a formality:

    a. **Cancel each captured run:** `POST /api/v1/runs/:id/cancel`. Note the side effect:
       the cancel handler calls `clearStartedTaskId(dataDir, id)` on success
       (`server.ts:5199-5206`, spec `2026-08-22-run-cancel-restores-todo.md`), which **deletes
       `startedTaskId` from the originating todo and puts it back on the Filed board.** So
       cancelling does not dispose of the todo; it resurrects it. This is exactly the case an
       earlier draft got wrong by deleting "any disposable todo that did not start."

    b. **Delete each run, bounded-polling through `409`.** `DELETE /api/v1/runs/:id` refuses with
       `409 {"error":"run is active — cancel it first"}` while `manager.isActive(id)` is still true
       (`server.ts:5879-5881`), and cancellation drains asynchronously, so the delete issued
       immediately after the cancel can legitimately 409. Poll the delete on the sanctioned
       until-loop, never a guessed sleep: retry every 2s for at most 60s, treat `200` and `404` as
       done, and treat a `409` still standing at the deadline as a **cleanup failure that is
       reported**, not swallowed.

    c. **Delete both captured disposable todo ids unconditionally:**
       `DELETE /api/v1/p/cezar/todos/:id` (`server.ts:6144`, ungated since D7a), for both ids,
       whether or not that todo ever started, since after (a) they are both back on the board. `404` is
       an acceptable terminal answer (already gone); anything else is a failure.

    d. **Assert the ground truth, not the intent, while the session still works.**

       > **CORRECTED 2026-08-24 (second review): this step used to run AFTER the session was
       > destroyed**, which made it unsatisfiable. `GET /api/v1/workspace/runs-index` and
       > `GET /api/v1/workspace/todos` both answer `401` without a `cez_session` (§ Data models,
       > measured on this box today), so every "the id is absent" assertion would have been reading
       > an error body and passing for the wrong reason, a cleanup check that is green precisely
       > when it can see nothing.

       Re-query **with the cookie still installed** and assert: every id in `cleanupRunIds` is absent
       from `GET /api/v1/workspace/runs-index`, and both captured todo ids are absent from
       `GET /api/v1/workspace/todos`. Both responses must be `200`; a `401` here means the session
       died early and the assertions prove nothing; treat it as a cleanup failure, not a pass. Zero
       remaining captured ids, asserted against a `200`, is the criterion. *"The delete calls were
       issued"* is not.

    e. **Destroy the session, last.** `destroySession(id)` (`auth/session.ts:263`) must return
       `true`; `rm` any `0600` credential file; then re-issue the preflight **without** the cookie
       and assert it now answers `401`. That final `401` is the only unauthenticated assertion in the
       cleanup, and it is deliberately the last thing the phase does.

    A failed E2E must still run every one of a–e, in that order. Cleanup failures are reported
    alongside the assertion failure, never in place of it.

**Done when:** every assertion above passed, the video and three screenshots exist on disk under
`$TMPDIR/e2e/`, and the cleanup assertions in (d) and (e) are all green.

### P6: Correct the record *(stop-safe: last phase)*

**This phase edits no file in the repository.** P3 promised this session exactly one commit, and
P2's gates and P4's deploy both attest *that* tree; a post-deploy edit to
`.ai/specs/2026-08-24-bulk-start-filed-tasks.md` would dirty the working tree after the commit, the
push, the gates and the activation, and would make "the gates ran on the exact committed tree"
false in retrospect. An earlier draft of this phase did exactly that and it is removed here. The
deploy sha, release id, both probe lines, the E2E verdict and the artifact paths therefore land in
the handoff and in the corpus proposal, and nowhere else. Updating the feature spec's status line
in the repository is a **second commit**; it is not authorized by this task and is left for the
owner to ask for explicitly, with the exact-tree guarantees restated.

1. **Append one complete `upsert` to this run's proposal file**, `$CEZ_KB_WRITE_FILE` =
   `/var/lib/cezar/loki-labs/cezar/.ai/cezar/runs/480e0282-a967-4936-a12e-3c4e56450586.knowledge.ndjson`
   (`workflows/run.ts:1310`). **Verified 2026-08-24: that file does not exist yet in this run**, so
   the sequence starts at **`seq: 0`** (`seq: z.number().int()` accepts `0`,
   `packages/contract/src/knowledge.ts:242-247`); re-read the file first if an earlier turn has
   already appended, since `seq` counts up across every line this run writes. Never edit a mounted
   corpus document directly.

   **Nothing occupies this slug yet, and there is no document to supersede.**

   > **CORRECTED 2026-08-24 (second review).** The previous draft carried
   > `"supersedes":["cezar/bulk-start-filed-tasks.md"]`, the document's own path, so it declared
   > itself superseded, and justified it by claiming the parent's note was *"already indexed"*. Both
   > halves are false, measured today:
   >
   > ```
   > $ ls /var/lib/cezar/loki-labs/notion-export/cezar/bulk-start-filed-tasks.md
   > ls: cannot access …: No such file or directory
   > $ grep -c 'bulk-start-filed-tasks' /var/lib/cezar/loki-labs/.ai/cezar/knowledge-index/catalog.ndjson
   > 0
   > ```

   What exists is only the parent's **pending proposal**: one line in a *different* run's file under a
   *different* data directory
   (`/var/lib/cezar/workspace/.ai/cezar/runs/e6592588-….knowledge.ndjson`, `op: upsert`,
   `scope: "project"`, `path: "cezar/bulk-start-filed-tasks.md"`, `seq: 0`), which nobody has applied.
   So this run's line is not a supersede of a live document; it is the **corrected replacement for
   that pending proposal**, and the field is omitted entirely rather than pointed at itself.

   **What the reviewer must be told, because it is the only thing standing between the record and a
   stale claim:** apply **this** proposal and discard the parent's, which still says *"Status: QA
   needed … The runtime E2E on the prod cockpit … has NOT been run."* If the parent's is applied
   anyway, applying this one afterwards repairs it (`upsert` replaces the whole document), but
   applying them in the other order leaves the false status live.

```
{"op":"upsert","scope":"project","path":"cezar/bulk-start-filed-tasks.md",
 "title":"Filed tasks: multi-select and Run N tasks (cezar cockpit)",
 "type":"note","tags":["cezar","web","tasks","todos","deploy"],
 "body":"<full document>","seq":0,
 "runId":"480e0282-a967-4936-a12e-3c4e56450586","createdAt":"<ISO-8601>"}
```

   The body is the **whole** document, not a delta: `upsert` replaces. It reproduces the parent's
   three design calls, records **P1.5's `sorted` → `rows` correction** to them (a note that described
   the shipped behaviour as the parent wrote it would be wrong about what is running), and states the
   shipped status directly. There is no live document to correct in place here, so the
   correction-in-place duty falls on the parent's *pending proposal* and is discharged by replacing
   it, as above, rather than by a `supersede` op against a document that does not exist. The status
   paragraph must carry, as literal fields a reader can check: **commit sha**, **release id**
   (`<ts>-<sha>`), **deploy activatedAt**, both probe lines verbatim, the E2E verdict, and the
   artifact directory path (`$TMPDIR/e2e/`, spelled absolutely).

2. **Application needs a supported path, and this checkout has none, so this task cannot close
   acceptance criterion 6.** The applier is present (`knowledge/proposals.ts:75`,
   `applyKnowledgeProposals`, § Solution decision 4); what is absent is any supported caller.
   `cez kb proposals` only lists (`knowledge/cli.ts:485-500`, no `apply` subcommand), and
   `POST /knowledge/proposals/apply` resolves each seq and then refuses every one with
   `applying knowledge proposals is not implemented yet` (`server/knowledge-routes.ts:68, 239-258`).
   So:

   - This task's deliverable for acceptance item 6 is the **validated proposal line**, confirmed
     readable back **by the same reader the applier uses**, `readRunProposals` against this run's
     data directory (V6). A line that fails `knowledgeProposalSchema` is silently dropped by that
     reader (`knowledge/proposals.ts:46-74`), so *"the file has a line in it"* is not evidence.
   - The **"confirm it is searchable" half is reported BLOCKED**, naming the gate: a supported
     application path (the route wired to the applier already in the tree, or the owner running it),
     followed by a reindex. **State plainly in the handoff and the final report that acceptance
     criterion 6 is only half met**, rather than reporting P6 green. Do not reindex an unchanged
     corpus and present a grep as the write having landed; nothing occupies this slug today (P6.1),
     so such a grep would return 0 anyway, and a green one would mean something else entirely.
   - **Do not hand-edit a mounted corpus document to close it.** The workspace rule is *never edit a
     mounted document directly*; a proposal is reviewed and applied later, through the cockpit or
     `cez kb proposals`. The previous draft's *"either by hand as the `cezar` user"* contradicted that
     rule and is removed.
   - Wiring the route to the applier is a **code change to cezar and a second commit**. It is outside
     this task's scope and is not done here. If the owner wants criterion 6 closed inside this task,
     that is a scope expansion only they can grant, and it changes P2 and P3 (the gates, and the
     single commit) accordingly.

3. **After a supported application** (not before), verify the resulting document, not a slug match,
   and run it **from the `cezar` checkout, not from `/var/lib/cezar/loki-labs`**.

   > **CORRECTED 2026-08-24 (second review): the previous draft reindexed the wrong project.** The
   > proposal is `scope: "project"`, and `applyUpsert` resolves that to `projectKnowledgeRoot(dataDir)`
   > = `<dataDir>/knowledge` (`knowledge/proposals.ts` → `knowledge/paths.ts:33-35`), i.e.
   > **`/var/lib/cezar/loki-labs/cezar/.ai/cezar/knowledge/cezar/bulk-start-filed-tasks.md`**, the
   > cezar project's own knowledge root, not the `loki-labs` corpus mount. A `cez kb reindex` run
   > from `/var/lib/cezar/loki-labs` indexes the corpus and would never see this document, so the
   > search would read red no matter how well the write went.

```bash
cd /var/lib/cezar/loki-labs/cezar && CEZ_KB=1 cez kb reindex
CEZ_KB=1 cez kb search "bulk start filed tasks"        # names cezar/bulk-start-filed-tasks.md
CEZ_KB=1 cez kb show <id> | grep -F "<release-id>"     # the release id is IN the document
CEZ_KB=1 cez kb show <id> | grep -F "<commit-sha>"     # so is the commit sha
```

   Read the **document**, never the catalog: a phrase grep of `catalog.ndjson` returns 0 even for a
   correctly-indexed document (the catalog stores an `excerpt`), and a slug grep answers a different
   question than *"did this task's text land"*.

4. `find /var/lib/cezar -not -user cezar | wc -l` → must be `0`.

## Risks

| risk | why it is real here | mitigation |
| --- | --- | --- |
| **The wrong diff base ships 50 files instead of 6.** | Already happened once in this run's own investigation; `git merge-base` returns `b3d3a44c` from this worktree and that is the wrong answer. | P1 pins the base to `9c896e32` and P1's check (b) fails the phase on an eighth path (seven are expected: six patch paths plus this spec). P1.5 adds no new path. `git add` by name, never `-A`. |
| **The deploy also activates the Backlog composer** (`48f9892c`), which is committed, pushed and undeployed (the live sha is `9c896e32`). | A post-deploy regression may have nothing to do with this feature, and reading the E2E as clearance for the composer would be wrong. | Named in measured fact 6. P4 records the *previous* live sha so the delta is on the record. Rollback is one command. |
| **Deleting `deploy-e2e-probe.test.ts` is misread as out-of-scope and excluded**, per the handoff's "no unrelated changes." | It is the only reason `npm run test:unit` is green; excluding it makes gate 3 red and stops the task at P2 with a confusing failure. | Measured fact 5 states the causal chain, and P3's commit body repeats it so `git log` carries the reason. |
| **The parent diff's `batch` starts rows the user cannot see.** | `batch = selectedFiledEntries(sorted, …)` while only `sorted.slice(0, shown)` renders, and `shown` resets to 100 on every sort/filter change without clearing `selected`. The feature spec forbids exactly this, twice. | P1.5 changes `sorted` → `rows` and adds the pagination regression test the existing filter test cannot catch. Declared as a deviation in P3's commit body, the handoff and the corpus note, never absorbed silently. |
| **P1.5 is mistaken for permission to widen scope.** | "Reconcile only the parent diff" is an acceptance criterion; a defect fix that grows into refactoring breaks it for real. | P1.5 is bounded to two hunks in two files already in the patch, adds no new path, and P1's "any eighth path is a defect" check still runs. |
| **The commit is not the tree the gates ran on.** | Gates and commit are separate operations; anything touching the tree between them (a formatter, a rebuild) silently decouples "green" from "shipped". | P2 forbids touching the tree afterwards, and P3 proves it mechanically: `TESTED_TREE=$(git write-tree)` before the commit, `git rev-parse HEAD^{tree}` equal to it after. |
| **`git push origin main` pushes the wrong ref.** | This worktree is on `cez/480e0282`; local `main` is `b3d3a44c`, 23 commits stale and carrying none of this work. The push would ship nothing, or be rejected, while step 4 deployed regardless. | P4.1 is `git push origin HEAD:main`, followed by `git fetch origin` and an equality assertion against `origin/main` before any deploy runs. |
| **The probes measure the previous release.** | `systemd-run` without `--wait` returns when the unit *starts*; the deploy is still running, so a probe straight afterwards reads the old sha, or reads green off a concurrent task's descendant deploy. | P4.4 passes `--wait` and checks the unit's exit status, then bounded-polls `/api/v1/health` until `activatedAt` changes **and** the live sha is HEAD or a descendant. A timeout is recorded as a deployment failure. |
| **The probe result is reported as a verdict rather than as evidence.** | The acceptance criterion asks this task to *pass* every declared probe, and the file's own header says a half-verified deploy "reads like a whole one." (`"manual": true` does **not** skip them, see § Problem.) | P4.5 executes both probes and pastes their stdout verbatim. |
| **`git reset --hard` in P1 destroys this spec.** | It is staged and uncommitted, exists on no remote and in no commit, so there is no reflog entry to recover it from, and the previous draft's save path was itself *inside* the worktree, under a directory that does not exist here, so the `cp` would have failed first. | P1 step 0 copies it to `$TMPDIR/ship-spec.md` (the main checkout's run directory), fails closed if `$TMPDIR` is missing or the copy is empty, and step 3 restores it, with `sha256sum` on both sides. |
| **The E2E artifacts are written into the disposable worktree and reaped.** | A relative `.ai/cezar/tmp/…/e2e/` resolves inside this worktree, where the parent directory does not exist; retaining screenshots and video is an acceptance criterion. | P5 writes to `$TMPDIR/e2e/` under the main checkout and `mkdir -p`s it before Chromium launches. |
| **A `201` start response is missed, so a live run is never cleaned up.** | `page.on('response')` attached after the click races both responses; an unobserved `201` means an untracked run left on the production board. | P5 step 6 registers the handler **before** the click and pushes each run id inside the handler as it arrives. |
| **Cleanup asserts "gone" against a `401`.** | Every workspace API needs the `cez_session`; destroying it first makes the absence assertions pass by being blind. | P5 cleanup (d) runs the ground-truth queries authenticated and requires `200`; (e) destroys the session last and asserts the `401` only then. |
| **P5 runs unauthenticated and reads as a feature bug.** | `/tasks` returns `200` without a session while every data API returns `401`, so the page renders an empty Filed table and every assertion below it fails for the wrong reason. | P5 step 0 mints a 15-minute `cez_session`, preflights `/workspace/todos` for `200`, and stops the phase on a `401`. |
| **The E2E leaves stray rows, runs or a live session behind.** | Real disposable tasks on the real `cezar` project; cancel *restores* the todo rather than consuming it (`clearStartedTaskId`); `DELETE /runs/:id` 409s while the cancel is still draining; and a minted session outlives the process that made it. | Run ids captured from the `201` responses as they arrive; cleanup (a)–(e) in a `finally`, bounded-polling the 409, deleting **both** todo ids unconditionally, destroying the session; a final zero-remaining assertion against the live APIs. |
| **A concurrent `server-deploy`** from todo `d0386413` races the symlink flip. | That todo is `in-progress` and owns this exact path on this exact box. | P4.2 checks `deploy.activatedAt` before and after; the backend probe already tolerates a *descendant* sha and says so. |
| **Playwright fails with `ERR_MODULE_NOT_FOUND`.** | This repo is `"type": "module"` and Playwright resolves CommonJS-only here. | P5 mandates `node -e` / `.cjs` / `createRequire`. Never set `PLAYWRIGHT_BROWSERS_PATH`. |
| **The corpus write looks successful and is not searchable.** | Three independent causes: nothing supported calls the applier that *does* exist (`knowledge-routes.ts:68` still refuses; `cez kb` has no `apply`), an applied write is not indexed until `cez kb reindex` runs, and the reindex must run in the **`cezar` project**, a `scope: "project"` upsert lands in `<dataDir>/knowledge`, not in the `loki-labs` corpus mount. | P6.2 names the gate and reports the searchable half **blocked**, so criterion 6 is reported half-met rather than green; P6.3 reindexes from `/var/lib/cezar/loki-labs/cezar` and verifies the *document's contents*, never the catalog. |
| **A second commit is created after the gated tree was deployed.** | P6 previously updated the feature spec's status line post-deploy, which dirties the tree after the commit, push, gates and activation. | P6 edits no repository file; the outcome goes to the handoff and the proposal only. |
| **A root-owned file lands in `/var/lib/cezar`.** | It indexes fine and the services then get `EACCES` forever, a silent one-directional failure. | P6.4's `find … -not -user cezar` check. |

## Verification

Concrete and executable. Each line is a command whose output is recorded **in this run's handoff
file** (`$CEZ_HANDOFF_FILE`) by the step that runs it, not appended to this document, which is
committed in P3 and not touched again (§ P6).

**V1: reconciliation is exactly the parent's feature diff plus the declared P1.5 correction, and
this spec survived the reset (P1, P1.5)**

```bash
sha256sum .ai/specs/2026-08-24-ship-bulk-start-filed-tasks.md "$TMPDIR/ship-spec.md"
                                          # two identical digests; $TMPDIR is the MAIN checkout's run dir
git rev-parse HEAD origin/main            # must be equal after the reset
# (a) BEFORE P1.5, the parent patch, exactly:
git diff --stat HEAD -- packages .ai/specs/2026-08-24-bulk-start-filed-tasks.md
                                          # must read: 6 files changed, 407 insertions(+), 350 deletions(-)
# (b) AFTER P1.5, re-measured, not predicted; record whatever it prints:
git diff --stat HEAD -- packages .ai/specs/2026-08-24-bulk-start-filed-tasks.md
git diff HEAD -- packages/web/src/routes/global-tasks.tsx | grep -c 'selectedFiledEntries(rows'  # 1
git status --porcelain | wc -l            # still 7: the 6 patch paths plus this spec, nothing else
```

**V2: five gates, on the reconciled tree, before anything is committed (P2)**. Each exits 0, output
tails recorded:

```bash
npm run typecheck && echo TYPECHECK=0
npm test          && echo TEST=0          # parent measured ~11,779 passed / 4 skipped, +1 for P1.5's test
npm run test:unit && echo UNIT=0          # expect 44 passed, 0 failed (53−9)
npm run build     && echo BUILD=0         # must produce packages/cezar/dist/.build-stamp.json
npm run test:package && echo PKG=0        # expect 25 passed
```

`npm run test:unit` reporting 53 total means the deletion did not land. Go back to P1.

**V3: one commit, and it is byte-identical to the tree V2 gated (P3)**

```bash
git log --oneline -1
git show --stat HEAD | tail -12           # the same 6 paths, plus this spec
git log -1 --format=%B | grep -c '2026-08-24-bulk-start-filed-tasks'   # ≥1
git log -1 --format=%B | grep -ci 'rows'  # ≥1: P1.5's deviation is named in the body
test "$(git rev-parse HEAD^{tree})" = "$TESTED_TREE" && echo TREE_MATCHES_TESTED=1
git status --porcelain                    # empty
git rev-list --count origin/main..HEAD    # 1
```

**V4: pushed, deployed, activation observed, and both declared probes pass (P4)**

```bash
git fetch origin
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" && echo PUSHED=1
systemctl --user show cez-deploy-<sha> -p Result -p ExecMainStatus   # Result=success
curl -fsS http://127.0.0.1:4321/api/v1/health | jq .deploy   # sha == HEAD (or a descendant),
                                                             # activatedAt != the pre-deploy value
ls -ld /opt/cezar                                    # symlink names the new release id
# then, verbatim from .ai/deploy-targets.json, bash -lc, from the repo root:
#   backend probe → "live=<sha> == HEAD"
#   UI probe      → "serving assets/index-<hash>.js == the built bundle"
```

**V5: production browser E2E (P5)**. Every assertion of P5 green, and on disk:

```bash
ls -la "$TMPDIR/e2e/"
# 01-filed.png  02-selected.png  03-after-start.png  *.webm
```

The three assertions that carry the feature, and which no unit test can make: the selection bar
reported **2**, the button read **Run 2 tasks**, and `page.url()` was **identical** before and
after the click. Plus the preflight (`/workspace/todos` → `200` before step 1), and the cleanup
ground truth: two `201` start responses captured, then zero captured run ids in
`/workspace/runs-index`, zero captured todo ids in `/workspace/todos`, `destroySession` → `true`,
and the post-destroy preflight → `401`.

**V6: the record is straight, and the blocked half is named as blocked (P6)**

> **CORRECTED 2026-08-24 (second review): the previous check could not pass.** It was
> `cez kb proposals --json | grep -c '"seq": 0'`. Two independent defects. (1) The CLI does **not**
> echo the line's embedded `seq`; it reports its own **1-based file position** (`seq: index + 1`,
> `knowledge/cli.ts:479`, whose own comment says *"1-indexed position of the line within its run's
> NDJSON file"*), so the first line is `"seq": 1` and the grep returns 0 for a perfectly valid
> proposal. (2) `cez kb` derives `dataDir` as `<repoRoot>/.ai/cezar` (`knowledge/cli.ts:112`), so run
> from **this worktree** it reads a `.ai/cezar/runs` directory that does not exist here and answers
> *"no pending proposals"* regardless. Note the two `seq` values are genuinely different things and
> both are correct: the embedded `seq: 0` is what `applyKnowledgeProposals` resolves against
> (`knowledge/proposals.ts:75-90`), and `seq` is `z.number().int()`, so `0` is valid
> (`packages/contract/src/knowledge.ts:242-247`).

```bash
git status --porcelain                                 # EMPTY: P6 edited no repository file
git rev-list --count origin/main..HEAD                 # 0: still exactly the one commit from P3

# (a) Validate the line with the SAME reader the applier uses, against the MAIN checkout's dataDir.
#     A line that fails knowledgeProposalSchema is dropped silently, so this is the real check.
cd /var/lib/cezar/loki-labs/cezar
node --import tsx -e '
  const { readRunProposals } = await import("./packages/cezar/src/knowledge/proposals.ts")
  const p = await readRunProposals("/var/lib/cezar/loki-labs/cezar/.ai/cezar",
                                   "480e0282-a967-4936-a12e-3c4e56450586")
  const mine = p.filter(x => x.op === "upsert" && x.path === "cezar/bulk-start-filed-tasks.md")
  console.log(JSON.stringify({ total: p.length, mine: mine.length, seqs: mine.map(x => x.seq) }))
'                                                      # mine: 1

# (b) And confirm the CLI lists it, selected by run id + path, never by a seq literal:
CEZ_KB=1 cez kb proposals --json | jq '
  [.proposals[] | select(.runId == "480e0282-a967-4936-a12e-3c4e56450586")
                | select(.proposal.path == "cezar/bulk-start-filed-tasks.md")] | length'   # 1
CEZ_KB=1 cez kb proposals --json | jq '.warnings'      # [], a warning means a line was dropped

find /var/lib/cezar -not -user cezar | wc -l           # 0
```

Then, **only after a supported application path exists and the proposal has been applied** (§ P6.2:
there is none in this checkout, so this task reports it blocked and does **not** run these itself),
from the **`cezar`** checkout, because a `scope: "project"` upsert lands in that project's knowledge
root and not in the `loki-labs` corpus mount:

```bash
cd /var/lib/cezar/loki-labs/cezar && CEZ_KB=1 cez kb reindex
CEZ_KB=1 cez kb search "bulk start filed tasks"
CEZ_KB=1 cez kb show <id> | grep -F "<release-id>"     # the deployment fields are in the document
```

**Definition of done, stated honestly.** V1 through V5 green with output pasted, and V6's parts (a)
and (b) green. **That is not the whole of acceptance criterion 6.** Its second half (*"confirm it is
searchable"*) requires the searchable-document check immediately above to pass, and this task
**cannot make it pass**: no supported path applies a knowledge proposal in this checkout. So the task
reports criterion 6 as **half met (written, not searchable) and names the gate**, rather than
calling V6 green and letting the criterion read as satisfied. Do not close this task as fully done
on criteria 1–5 alone.

Gates green alone is also *not* done. This is a user-facing change, so it stays **QA Needed** until
V5 has actually run in a real browser (`AGENTS.md` § Definition of Done, workspace `CLAUDE.md`).

## Record

Read and cited while writing this spec:

- `.ai/specs/briefs/2026-08-24-ship-bulk-start-filed-tasks.md`: step 1's brief (in the main
  checkout, not this worktree). Three of its factual claims corrected in § Measured facts 1–3.
- `.ai/specs/2026-08-24-bulk-start-filed-tasks.md` (parent worktree copy): the feature spec,
  KB `specs-06402c11d9f7`. Read in full; not modified by this spec.
- `.ai/specs/2026-08-17-filed-tasks-table-statuses.md` (KB `specs-fc81f822fe2d`): owns the
  pre-existing `filed-tasks.ts` vocabulary the new helpers append to.
- `.ai/specs/2026-08-22-deploy-e2e-probe-vacuous-pass.md`: design record for the deleted unit
  suite's original 9 cases.
- `.ai/specs/2026-08-22-headless-browser-on-prod-host.md`: the Playwright capability and its
  two traps.
- `.ai/deploy-targets.json`: both probes read verbatim, including their `manual`/`manualReason`
  fields and the `$comment` header.
- `AGENTS.md:7-13` (standing ship authorization, fail-closed gates, the rootless blue-green path
  and its argv/readiness corrections), `AGENTS.md:469-528` (headless browser).
- `package.json` root `scripts`, `packages/cezar/package.json` `scripts`: the five gates, and the
  absence of a root `lint`.
- `packages/cezar/src/server/server.ts:5192, 5879, 6134-6180`: cancel/delete run, patch/delete/start
  todo.
- Commits: `9c896e32` (patch base), `1089391e` (parent HEAD), `e38cb619` (`origin/main`),
  `b3d3a44c` (this worktree's pre-reset HEAD), `587db317` (the probe-script rewrite that stranded
  the unit suite), `48f9892c` (Backlog composer, committed and undeployed).
- Handoffs: this run's, and
  `/var/lib/cezar/workspace/.ai/cezar/runs/e6592588-1628-40e0-b31a-8fe26c8b2220.handoff.md`.
- `/var/lib/cezar/workspace/.ai/cezar/runs/e6592588-…knowledge.ndjson`: the parent's drafted corpus
  note, a **pending proposal**, unapplied, which P6's own `upsert` replaces (P6.1).
- `packages/cezar/src/workflows/postconditions.ts:297-366` (`allServicesDeployed`, and what
  `"manual": true` does and does not do), `packages/cezar/src/auth/session.ts:75, 218-270, 356-362`
  (`cez_session`, `createSession`/`destroySession`), `packages/cezar/src/todos.ts:969-994`
  (`clearStartedTaskId` restores the todo on cancel),
  `packages/cezar/src/server/server.ts:5192-5207, 5879-5881, 6144, 6164, 7276`,
  `packages/cezar/src/workflows/run.ts:1310` (`CEZ_KB_WRITE_FILE`).

Re-read in full for the second review, and the source of the corrections marked above:

- `packages/cezar/src/knowledge/proposals.ts` (12,613 bytes): `knowledgeWriteFilePath` `:34`,
  `readRunProposals` `:46-74`, **`applyKnowledgeProposals` `:75-99`**, `applyUpsert` below it
  resolving `scope: "project"` through `projectKnowledgeRoot(dataDir)`. **The applier exists**,
  correcting this spec's earlier claim, and the stale module comment in `knowledge-routes.ts:39-49`
  that it came from.
- `packages/cezar/src/server/knowledge-routes.ts:239-258`: the apply route reads with
  `readRunProposals` and still refuses every seq with `PROPOSAL_APPLY_NOT_AVAILABLE` (`:68`).
- `packages/cezar/src/knowledge/cli.ts:71, 80, 112, 415-500`: six subcommands and no `apply`;
  `dataDir = join(repoRoot, '.ai/cezar')` (`:112`); `seq: index + 1`, explicitly *"1-indexed position
  of the line"* (`:433, :479`); `rawProposalSchema` omits `seq`/`runId`/`createdAt`.
- `packages/contract/src/knowledge.ts:242-278`: `knowledgeProposalBaseSchema`: `seq:
  z.number().int()` (so `0` is valid), `runId`, `createdAt` all required by
  `knowledgeProposalSchema`, which is what `readRunProposals` validates against.
- `packages/cezar/src/knowledge/paths.ts:33-40`: `projectKnowledgeRoot` = `<dataDir>/knowledge`,
  `workspaceKnowledgeRoot` = `<cezarHomeDir>/knowledge`. This is why P6.3 reindexes the `cezar`
  checkout and not `/var/lib/cezar/loki-labs`.
- Parent worktree `packages/web/src/routes/global-tasks.tsx:756, 782-785, 790-798, 824-849` (the
  `shown` reset effect, `rows` vs `sorted`, `batch`, the selection bar) and
  `packages/web/src/lib/filed-tasks.ts:210, 258-263` (`FILED_ROW_PAGE_SIZE = 100`,
  `selectedFiledEntries`), the measured basis for the § Architecture blocking defect.
- Parent worktree `packages/web/src/routes/global-tasks.test.tsx:1499`: the existing hidden-row test,
  which covers the *filter* path only.
- `.ai/specs/2026-08-24-bulk-start-filed-tasks.md` § Solution and § Risks: *"Intersect selection with
  the currently visible, filtered, sorted rows"* / *"Hidden selected rows must never start."*
- Live loopback and git measurements taken while writing this spec (2026-08-24): `/tasks` → `200`,
  `/api/v1/workspace/todos` → `401 {"error":"unauthenticated"}`, `/api/v1/runs` → `401`;
  `$CEZ_KB_WRITE_FILE` does not yet exist for this run;
  `/var/lib/cezar/.cezar/identity/identity.json` holds the `users`/`sessions` this box authenticates
  against; `git rev-parse main` → `b3d3a44c…` while `origin/main` → `e38cb619…` (the wrong-refspec
  measurement); `git remote -v` → `origin` only; `ls .ai/cezar/tmp` in this worktree → *No such file
  or directory*, while `$TMPDIR` exists under the main checkout;
  `ls …/notion-export/cezar/bulk-start-filed-tasks.md` → absent and
  `grep -c 'bulk-start-filed-tasks' …/knowledge-index/catalog.ndjson` → `0`.

Not found, and therefore defined rather than assumed: any pre-existing convention for disposable
test tasks on the Filed board (§ Solution, decision 2).

## Status log

*(empty, and it stays empty. Nothing in this spec has been executed at the time of writing, and no
later phase appends to this file: P2's gates run on this document's exact bytes, P3 commits that
tree and proves it with `git write-tree`, and P4 deploys it, so appending execution output here
would dirty the tree afterwards and break both the one-commit rule and the tree-match proof.)*

Execution evidence lives in three places instead, each named by the phase that writes it:

- **This run's handoff**, `$CEZ_HANDOFF_FILE`
  (`/var/lib/cezar/loki-labs/cezar/.ai/cezar/runs/480e0282-a967-4936-a12e-3c4e56450586.handoff.md`):
  every V1–V6 command's output, one terse timestamped line per milestone, newest at the top.
- **The E2E artifact directory**, `$TMPDIR/e2e/` =
  `/var/lib/cezar/loki-labs/cezar/.ai/cezar/tmp/480e0282-a967-4936-a12e-3c4e56450586/e2e/`, under
  the **main checkout**, not this worktree, so it survives the worktree being reaped:
  `01-filed.png`, `02-selected.png`, `03-after-start.png`, the `.webm` video.
- **The corpus proposal**, `$CEZ_KB_WRITE_FILE`, which becomes the durable record only once a
  supported path applies it (§ P6.2). Until then it is a pending proposal, and this task's report
  must say so.
