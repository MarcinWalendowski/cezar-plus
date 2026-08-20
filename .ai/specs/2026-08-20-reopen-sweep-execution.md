# Firing the reopen sweep: two canaries, nineteen verdicts, and one line each agent must print

> **Status: PARTIAL — executed through Wave A, and Wave A has not finished. Waves B, C and D have
> NOT run.** Measured 2026-08-20 19:51 UTC, at the end of this run's `document` step. Phase 0
> (deploy) and Phase 1 (the dry runs) are **DONE** and their acceptance criteria are met. Wave A's
> canary — chat run `b1684fe9`, request `acd801d9` — was reopened at **19:27:26 UTC** and its
> `continue-1` step was still `running` when this line was written, so **not one `MERGE-VERDICT`
> line exists yet**: `grep -rn MERGE-VERDICT` across every run directory on this box matches only
> the prompt text this spec injects. **One of nineteen runs has been reopened; eighteen have not.
> The owner's ask is still unanswered.** What remains is carried by a cezar todo — see § Status log
> at the foot for the per-step record and the exact resume commands.
>
> ~~**Status: SPEC — not executed.**~~ This is the execution plan for **Phases 4-5** of
> `.ai/specs/2026-08-20-reopen-finished-tasks-merge-audit.md`, which shipped Phases 1-3 as
> `0cbb65a4` and is still marked **PARTIAL** because nothing has been reopened. That spec built
> the door and deployed it; this one walks through it. It does not re-litigate the design — the
> file-intent mechanism, the `deferForCapacity` decision and the rejected alternatives all stand
> as written there.
> · **Date:** 2026-08-20 · **Run:** `7aecd6a2` (project `cezar`, workflow `spec-to-deploy`)
> **Owner ask, verbatim (unchanged since the parent spec):** *"reopen all 'done' tasks from active
> tab in cezar production (here) with such a promot: \"analyze if changes/fixes/updates from this
> task were merged into main\" if not, do it now"*
> **Parent:** `2026-08-20-reopen-finished-tasks-merge-audit.md` (Phases 1-3 IMPLEMENTED + DEPLOYED;
> Phases 4-5 open, carried by cezar todo `3cd4adc4-9af3-4c1e-b068-4d9cb86e89bf`).
> **Reads on:** `2026-08-20-workspace-run-worktree-isolation.md` (`a23aa9bf` — the ten-worktrees-per-workspace-run
> fact this spec's blast-radius arithmetic rests on), `2026-08-20-steps-green-only-when-verified.md`
> (`57fc8807` — the `deploy` post-condition, and why this run's HEAD matters),
> `2026-08-15-cross-project-workspace-run.md` (why every workspace run lives in the boot project's
> index), `2026-08-20-chain-integrity-restart-and-continuation.md`.

## TLDR

Nineteen finished runs on the production Active tab have never been asked whether their work
reached `main`. The capability to ask them shipped and is live in the resident cockpit process
(`/opt/cezar/.deployed-commit` = `f02156d5`, MainPID `3683619` since 19:04:02 UTC). Nobody has
fired it.

This spec fires it, in four waves, and defines the one thing the parent spec left undefined: **how
the answers get collected.** Each reopened agent is required to print a single machine-readable
line — `MERGE-VERDICT: <verdict> | <repo> | <ref> | <one sentence>` — into both its final message
and its handoff file, so nineteen verdicts can be read with `grep` instead of nineteen transcripts
being read by hand.

Three corrections to the parent spec's arithmetic, all measured today:

1. **The set is 20 now, not 19.** `a29f2b11` — the run that built the feature — settled at
   `2026-08-20T19:08:27Z` and is itself a `done`, unarchived Active-tab row. The owner's
   `--exclude a29f2b11` brings it back to exactly **19 (workspace 15 / chat 3 / cezar 1)**, the
   predicted split. The exclusion is now load-bearing rather than a no-op.
2. **Reopening a workspace run materializes TEN git worktrees, not one.** Every one of the 15
   workspace runs carries all twelve registry projects in `workspaceProjects`, and
   `materializeWorkspaceWorktrees` collapses those twelve entries to ten distinct repos
   (`workspace-worktrees.ts:83`). Fifteen workspace runs is **150 worktree creations and 150
   apply-backs**. The parent spec's Risks section says "a reopened workspace run re-runs
   apply-back"; it does not say how many times.
3. **The `--limit 1` canary the parent spec asked for lands on `b1684fe9`** — oldest-finished
   across the whole selection (`2026-08-19T11:17:25Z`) — which is a *chat project* run, not a
   workspace run. So the parent's single canary would prove the cheap path and leave the
   ten-worktree path unproven. This spec uses **two** canaries for that reason.

## Problem

### 1 — The deploy acceptance criterion is satisfied by value and fails by probe

`/opt/cezar/.deployed-commit` holds `f02156d5105733107a81810397a576abb66b91ab`, which is
`origin/main`'s tip and four commits *ahead* of `0cbb65a4`. So "0cbb65a4 or later" is already true.

But the first probe in `.ai/deploy-targets.json` does not compare against `0cbb65a4`; it compares
against `git rev-parse HEAD` **in the step's own cwd**:

```
test "$(cat /opt/cezar/.deployed-commit 2>/dev/null)" = "$(git rev-parse HEAD)"
```

This run's worktree is on `cez/7aecd6a2` at `f9bcda42`, **4 commits behind `origin/main`**
(`git rev-list --count HEAD..origin/main` → 4). Run the probe here today and it exits non-zero.
The deploy work left for this run is therefore not "deploy the reopen feature" — that is done and
proven live — it is **bring this branch's HEAD to the deployed commit, then re-stamp the marker
once this run's own commit lands**. Phase 0 below.

### 2 — Nineteen answers with nowhere to land

The parent spec's acceptance criterion is "each records a merge verdict (merged / merged now /
cannot determine + why)". It specifies no place for that record and no format. Nineteen agents
left to their own devices will each write a paragraph in a different shape into a different
artifact, and Phase 5's verdict table becomes nineteen manual transcript reads.

The artifacts that exist per run are fixed and greppable:

| artifact | path | verified |
|---|---|---|
| transcript | `<dataDir>/runs/<runId>.ndjson` | typed NDJSON; agent prose is `{"type":"text",…}`. `grep -c CEZ:DONE` on `6aa07506`'s transcript → **4**, so a literal marker in a final message *is* recoverable by grep. |
| handoff | `<dataDir>/runs/<runId>.handoff.md` | every run already appends dated lines under `## Progress log` — `6aa07506`'s carries four, ending "DEPLOY VERIFIED LIVE … HEAD=origin/main=67e93cca". |
| knowledge inbox | `<dataDir>/runs/<runId>.knowledge.ndjson` | present for 14 of 16 workspace runs. |

A required marker line costs the agent one line and turns Phase 5 from a reading exercise into a
`grep`.

### 3 — Nineteen agents that may all decide to push

The owner's ask ends "if not, do it now", so landing is in scope. `resources.maxParallel` is **3**
(`~/.cezar/config.json`), so up to three reopened agents run at once, and **nothing anywhere in
this codebase serializes a `git push`.** `serializeByRoot` (`workspace-worktrees.ts:130`)
serializes *apply-back* per repo root; it has no bearing on what an agent does with `git push`
inside its own worktree.

Three workspace runs concurrently deciding their cezar work is unmerged and pushing to
`origin/main` is a plausible, unprotected race. The failure mode is benign if handled
(non-fast-forward rejection) and catastrophic if not (a `--force` "fix"). This is why the prompt
carries a push protocol and not just a question.

### 4 — What the merge audit actually says today, re-measured

The parent spec audited four runs on 2026-08-20. Re-measured now (still read-only; no `git fetch`
ran, so `origin/*` is as of the last fetch someone else performed):

| run | project | branch | tip | `git cherry origin/main <branch>` | verdict |
|---|---|---|---|---|---|
| `b1684fe9` | chat | `cez/b1684fe9` | `2675cd16` | `+ 2675cd16` | **NOT merged** (SPEC-529, 8 files, +1000/−54) |
| `7c2dd8f0` | cezar | `cez/7c2dd8f0` | `ce6a5e14` | `+ ce6a5e14` | **NOT merged** |
| `28993af3` | chat | `cez/28993af3` | `e54cc50a` | *(empty)* | merged — branch tip **is** `origin/main`'s tip |
| `2f1ae4aa` | chat | `cez/2f1ae4aa` | `3e4f26a5` | *(empty)* | merged — is local `main`'s tip |

Both unmerged findings are unchanged since the parent spec was written, and **both still have live
worktrees on disk** (`chat/.ai/cezar/worktrees/b1684fe9-…` at `2675cd16`;
`cezar/.ai/cezar/worktrees/7c2dd8f0-…` at `ce6a5e14`), so continuing either resumes into a tree
that still holds the unmerged work. These two are the only rows this task can be *scored* against.

Two checkout facts every reopened agent needs and none can assume: **`chat`'s local `main` is 3
behind `origin/main`**, and **`cezar`'s local `main` (`f9bcda42`) is 4 behind `origin/main`
(`f02156d5`)**. An agent that checks `git branch --merged main` without fetching will call
`28993af3` unmerged and be wrong — the exact trap the parent spec flagged.

### 5 — One parent-spec claim that is wrong, corrected here

The parent spec's § Out of scope lists `cez/6af4b894` as an orphan "with no run record in any
`runs.json` and therefore no row on any tab". **It has a row.** `6af4b894-9d55-4685-8b04-3f72e56a1c99`
is a *workspace* run in the boot project's index (`done`, unarchived, finished
`2026-08-20T15:50:39Z`, title "each step of workflow should show time of processing"), and its
record still carries a `workspaceWorktrees` entry for branch `cez/6af4b894` whose directory is
gone — the normal post-apply-back state. The branch itself no longer exists in `cezar`
(`git branch -a` lists only `cez/7aecd6a2`, `cez/7c2dd8f0`, `main`, `rescue/staged-index-20260820`).
So it is **in the sweep**, not outside it. `rescue/staged-index-20260820` @ `343f79ea` remains a
genuine orphan with no run row, and stays out of scope.

## Solution

**Four waves, one required output line, one collector.**

The mechanism is entirely the parent spec's: `cezar runs reopen` writes intents into each
project's `reopen-requests.json`; the resident cockpit's `watchReopenRequests` reconciles them
through that project's own `RunManager.continueRun(runId, {text}, true)`. Nothing new is built
here. What this spec adds is the *operation*: which runs in which order, what prompt, and how the
answers are read back.

### Wave shape, and why two canaries

| wave | runs | what it proves | blast radius |
|---|---|---|---|
| **A — project canary** | `b1684fe9` (chat) | end-to-end: a request is written, the cockpit reconciles it, the run leaves `done`, streams, settles, and prints a verdict. | reuses the existing worktree; **no** worktree materialization, **no** apply-back. And it is one of the two known-unmerged runs, so it also tests *landing*. |
| **B — workspace canary** | `be31d9e9` (workspace) | the ten-worktree path: `materializeWorkspaceWorktrees` over 12 registry entries → 10 repos, then `applyWorkspaceWorktrees` on settle. | 10 worktrees created and applied back. |
| **C — the remaining 17** | everything else in the selection | nothing new; volume. | up to 3 concurrent, queue-throttled. |
| **D — collect** | none | Phase 5's record. | read-only. |

`b1684fe9` is not a choice — it is what `--limit 1` selects. `sortKey` is `finishedAt ?? createdAt`
oldest-first (`reopen-cli.ts`), and `b1684fe9`'s `2026-08-19T11:17:25Z` is the earliest in the
whole selection. Confirmed against the sorted list of all 19.

`be31d9e9` **is** a choice, and a deliberate one on three grounds: it is the cheapest workspace run
on record (**$2.80**, versus a $186.41 worst case), it is a workspace run so it exercises the
ten-worktree path, and it is one of the two runs (`be31d9e9`, `ec6e8e06`) whose apply-back race
was measured and diagnosed in `2026-08-20-workspace-run-worktree-isolation.md` — the run most
likely to expose that path misbehaving, against a fix (`a23aa9bf`) that is deployed but has never
had its runtime E2E. It is named by id, not selected by `--limit`.

### Where the sweep must be invoked from

Not a detail — get it wrong and 15 of 19 runs are silently missing. `reopen-cli.ts`'s own doc
comment:

> "The boot project" here means the repo THIS CLI was invoked from — the CLI has no way to read
> another process's `WorkingDirectory`, so a sweep meant to cover the cockpit's boot repo must be
> run from it (or name it with `--project <path>`).

The boot project is `/var/lib/cezar/workspace` (the service's `WorkingDirectory`), it is **not** in
`~/.cezar/config.json`'s twelve registered projects, and it holds 15 of the 19 runs. It is also
**not a git repository** (`git -C /var/lib/cezar/workspace status` → `fatal: not a git repository`)
— which is exactly why workspace runs work through per-project worktrees and apply-back.

So every sweep command in this spec runs with **`cwd = /var/lib/cezar/workspace`**, against the
**deployed** binary `/opt/cezar/packages/cezar/dist/index.js` — never the worktree source, which
is at `f9bcda42` and does not contain `runs/reopen-cli.ts` at all.

One invocation from there covers everything: `allTargets` returns the twelve registered projects
plus the boot project, and `cezar` and `chat` are both registered.

### The prompt

Line 1 is the owner's words, unaltered. Everything after the rule is added by the sweep, and is
flagged as added — the parent spec set that precedent and it holds here.

```
analyze if changes/fixes/updates from this task were merged into main. If not, do it now.

--- added by the reopen sweep (2026-08-20); not part of the original ask ---

GROUNDING — facts measured on this box today, so you do not have to rediscover them:
* `git fetch` FIRST. Local `main` is behind `origin/main` in both repos that matter:
  chat by 3 commits, cezar by 4 (cezar local main f9bcda42, origin/main f02156d5).
  `git branch --merged main` without a fetch gives the WRONG answer here — it already
  did once, on run 28993af3.
* `git cherry origin/main <branch>` is the check that distinguishes "my commit is not an
  ancestor" from "my patch never landed". Prefer it. A `+` prefix means NOT landed.
* If this run had its own worktree, your branch is `cez/<first 8 chars of the run id>`.
* If this was a WORKSPACE run, your worktrees and branches were deleted when the run
  settled (apply-back lands each diff in the real checkout, then removes the tree). There
  is no branch left to compare — check the real checkout's history for your changes
  instead, and your own `commit-push` step's record for what it claimed to do. Note that
  step post-conditions only became machine-checked on 2026-08-20 (57fc8807), AFTER every
  run in this sweep — so a green `commit-push` step in your own history is a claim, not
  evidence.

IF YOUR WORK IS UNMERGED, LAND IT — under these constraints, which are not negotiable:
* Land only THIS task's work. Do not touch another run's branch, another task's commits,
  or unrelated working-tree changes you find beside yours.
* Push protocol: `git fetch`, then fast-forward or rebase, then push. NEVER `--force`,
  never `push --force-with-lease`, never rewrite published history. If the push is
  rejected, do NOT retry harder — report `land-blocked` and say why.
* cezar pushes to `origin` ONLY. Pushing to `upstream` (open-mercato/cezar) is never
  authorized. Naming the remote explicitly is required: `git push origin main`.
* Run the repo's gates before you push anything. Never push a red build.

REQUIRED OUTPUT — print this exact line, once, as the last line of your final message,
and also append it under `## Progress log` in your handoff file:

MERGE-VERDICT: <merged|merged-now|land-blocked|cannot-determine> | <repo> | <ref-or-commit> | <one sentence>

  merged           — it was already on main before you looked.
  merged-now       — it was not, and you landed it in this session. Name the commit.
  land-blocked     — it was not, you tried, and something stopped you. Name what.
  cannot-determine — you could not establish it either way. Say precisely why; do not
                     guess, and do not round "probably fine" up to `merged`.

If this task touched more than one repo, print one MERGE-VERDICT line per repo.
```

`cannot-determine` is a first-class verdict on purpose. Fifteen of the nineteen are workspace runs
whose branches were deleted on apply-back; for some of them the honest answer will be that the
evidence is gone. A sweep that cannot say so will manufacture confidence instead.

### The collector

Phase 5 reads the verdicts mechanically:

```bash
grep -h '^MERGE-VERDICT:' \
  "<dataDir>/runs/<runId>.ndjson" "<dataDir>/runs/<runId>.handoff.md" 2>/dev/null | tail -1
```

A run with no matching line is itself a finding — recorded as `no-verdict`, not silently dropped,
and its transcript read by hand.

### Rejected: two passes (audit-only, then land)

The obvious safer shape is an audit-only sweep across all 19 (read-only, safe at any concurrency),
then a serialized landing pass over only the runs that came back unmerged. It removes the push
race outright.

Rejected. It doubles the cost of a $1,175-of-original-spend sweep, it takes two rounds of wall
clock instead of one, and — the deciding reason — it does not answer the ask. The owner wrote "if
not, do it now"; an audit that files follow-ups is the thing this task already is, one level down.
The push race is real but small and bounded: the two known-unmerged runs are in *different* repos,
and the protocol above (fetch, never force, report `land-blocked` on rejection) converts a race
into a reported non-event rather than damage. Recorded here so it is not re-proposed as an
oversight.

## Architecture

```
  Phase 0  git merge origin/main into cez/7aecd6a2      (probe 1 needs HEAD == deployed commit)
        │
  ══════╪════════════════════ cwd = /var/lib/cezar/workspace ══════════════════════
        │  binary: /opt/cezar/packages/cezar/dist/index.js   (NOT the worktree source)
        ▼
  Wave A   runs reopen b1684fe9-… --project chat --prompt "$P"
        │        └─► chat/.ai/cezar/reopen-requests.json
        │              └─► fs.watch → reconcileReopenRequests → continueRun(id,{text},true)
        │                    └─► queued → pump → continue-1 → existing worktree @2675cd16
        │                          └─► settle → MERGE-VERDICT printed
        ▼  GATE: settled clean? verdict present? real checkouts unchanged except intended?
  Wave B   runs reopen be31d9e9-… --project workspace --prompt "$P"
        │        └─► materializeWorkspaceWorktrees: 12 entries → 10 repos → 10 worktrees
        │              └─► settle → applyWorkspaceWorktrees: 10 × diff+apply --3way
        ▼  GATE: 10 worktrees created AND removed? no stray cez/be31d9e9 branches?
  Wave C   runs reopen --all-done --exclude a29f2b11 --exclude b1684fe9 --exclude be31d9e9
        │              --exclude 7aecd6a2 --prompt "$P"          → 17 requests
        │        └─► queued behind maxParallel=3; hours of wall clock
        ▼
  Wave D   grep '^MERGE-VERDICT:' over 19 × (ndjson, handoff.md) → the Phase 5 table
        │
  Phase 6  parent spec Status: PARTIAL → resolved; marker re-stamped; commit + push
```

Nothing here writes to `runs.json` directly — it is `RunStore`-owned with debounced atomic saves,
which is the whole reason the intent lives in its own file (parent spec § Architecture).

## Data models

No new persisted shape. `reopenRequestSchema` is unchanged from the parent spec. The one new
*format* is the verdict line, which is a convention in agent output, not a schema:

```
MERGE-VERDICT: <verdict> | <repo> | <ref-or-commit> | <sentence>
   verdict ∈ { merged, merged-now, land-blocked, cannot-determine }
   repo    = a registered project id, or the repo's directory name
   ref     = the branch, commit, or "-" when there is none left to name
```

Deliberately not JSON and deliberately not a contract type: it has to survive being typed into
prose by nineteen independent agents and be found by `grep`. A `packages/contract` addition would
imply a route validates it; none does.

## API contracts

None. This spec adds no HTTP surface, touches no `packages/contract` domain, and therefore no
`contract-parity` test applies. Every command below is a CLI invocation against the already-shipped
`cezar runs reopen`, whose contract is the parent spec's § CLI contract and whose deployed `--help`
was read to confirm it matches:

```
cezar runs reopen --all-done [--project <id|path|all>] [--prompt "<text>"]
                             [--dry-run] [--limit <n>] [--exclude <runId>]...
cezar runs reopen <runId>...  [--project <id|path>] [--prompt "<text>"] [--dry-run]
```

## Phases

**Phase 0 — make the deploy probe true.** Merge `origin/main` (`f02156d5`) into `cez/7aecd6a2`,
which is 4 behind. After this run's own commit lands on `origin/main`, advance
`/opt/cezar/.deployed-commit` to the new HEAD. **This is a docs-only delta**, so it takes the
carve-out already recorded in `/opt/cezar/.deployed-notes.md` for `f53f5a58 → f02156d5`: *no tree
swap and no restart*, because the artifact in place is already a correct build of a commit whose
only difference is markdown. Verify with
`git diff --name-only <deployed>..HEAD | grep -v '\.md$'` returning nothing before taking that
path; if it returns anything, do the full build → readiness-probe → swap → `kill -9` cycle per
`AGENTS.md:12`. Independently shippable: it makes both `.ai/deploy-targets.json` probes exit 0
whether or not the sweep ever runs.

**Phase 1 — the dry run.** `--all-done --dry-run` from the boot project, twice: once bare (expect
**20**) and once with `--exclude a29f2b11` (expect **19** = workspace 15 / chat 3 / cezar 1).
Confirm `reopen-requests.json` exists in no project before or after — today it exists in none
(checked: `workspace`, `cezar`, `chat` all `No such file or directory`). Writes nothing; satisfies
acceptance criterion 2 on its own.

**Phase 2 — Wave A, the project canary.** One run, `b1684fe9`. Watch it settle. Gate below.

**Phase 3 — Wave B, the workspace canary.** One run, `be31d9e9`. Watch the ten worktrees appear
and disappear. Gate below.

**Phase 4 — Wave C, the remaining 17.** One invocation. Queue-throttled at 3.

**Phase 5 — Wave D, collect and record.** The verdict table; the parent spec's Status moved off
PARTIAL; todo `3cd4adc4` closed or re-scoped; `CHANGELOG.md` entry; KB decision written to
`CEZ_KB_WRITE_FILE`.

Phases 2, 3 and 4 are **gated, not merely ordered** — see § Verification. A failed canary means
amending this spec, not proceeding.

## Risks

- **Ten worktrees per workspace run, 150 across the sweep.** Measured, not estimated: all 15
  workspace runs carry twelve `workspaceProjects` each, collapsing to ten repos. Disk is fine —
  the largest working tree is `chat` at **311 MB** fresh (the 2.3 GB figure on
  `chat/.ai/cezar/worktrees/28993af3-…` is `node_modules`, which a fresh worktree does not have),
  `cezar` is ~40 MB, and there is **134 GB free on `/`**. Worst case if every tree leaked is ~6 GB.
  The real exposure is not space, it is 150 `git worktree add` + 150 `git apply --3way` operations
  against live checkouts. Bounded by the Wave B gate, which counts them once before doing it 14
  more times.
- **Apply-back on a run that already applied once.** The parent spec flagged this as never
  exercised. It should be benign: a re-materialized tree branches from *current* HEAD, so
  `git diff base..HEAD` is only what the continuation itself changed, and an empty patch takes the
  `outcome: 'nothing'` path that removes the worktree without touching the real checkout
  (`workspace-worktrees.ts`, `applyOne`). "Should be" is why Wave B exists and why the gate diffs
  every real checkout before and after.
- **Concurrent pushes.** § Problem 3. Mitigated by protocol, not by a lock — say so plainly rather
  than implying serialization that does not exist.
- **Cost.** The 19 runs cost **$1,174.55** originally (summed from `runs.json`; range $2.80
  `be31d9e9` to $488.73 `2f1ae4aa`). A continuation is far cheaper than an original run, but an
  audit-and-land continuation on an 8-file unmerged branch is not free. No basis exists on this box
  for a per-continuation estimate — there has never been one — so the canaries are also the cost
  probe: read Wave A's and Wave B's actual `costUsd` before firing 17 more.
- **Wall clock and board saturation.** Original runs averaged ~2h (median ~1.5h; range 17 min to
  710 min). Continuations will be much shorter, but at `maxParallel: 3` — one slot held by this run
  while it is alive — 17 queued continuations will occupy the Working bucket for hours, **and the
  queue is FIFO, so anything the owner starts next waits behind them.** `--limit` exists precisely
  to split Wave C if that cost is unacceptable; the default here is one invocation, and the owner
  can cancel individual runs from the cockpit at any time.
- **A continuation can end worse than it started.** `continue crashed: …` writes `status: 'failed'`
  over a `done` row (`run.ts`). Nothing is lost, but the board looks worse until it settles. Also:
  a continuation that ends in `review` rather than `done` is *not* done — the verdict collector
  must check final status, not assume it.
- **`a29f2b11`'s exclusion rationale is stale, and it is honoured anyway.** The parent spec excluded
  it because "the sweep cannot reopen itself" — but the sweep now fires from `7aecd6a2`, so that
  reason no longer applies. The owner's instruction is explicit and unconditional, so it stands,
  and its verdict is recorded from this spec's own evidence instead: `a29f2b11`'s commits
  `2e421370`, `0cbb65a4`, `f53f5a58` and `f02156d5` are all on `origin/main` — **merged**, on
  documentary evidence, without spending a continuation to rediscover it.
- **`7aecd6a2` (this run) is excluded defensively.** It is `running`, so `--all-done` cannot select
  it and `continueRun` would refuse it. But if Wave C is fired from a later step, or re-fired after
  this run settles, it becomes selectable — and a run reopening itself mid-settle is not a
  behaviour anyone has tested. `--exclude 7aecd6a2-e87b-485f-b1b1-c242ddaa92fa` costs nothing.
- **`fs.watch` misses an event.** Unchanged from the parent spec: the next reconcile catches it —
  a later file change or the project's next boot pass. If a request sits unstamped with the run
  still `done`, `touch` the file to fire another watch event rather than editing the row.
- **The sweep depends on a resident process nobody may restart mid-flight.** The watcher lives in
  MainPID `3683619`. A deploy that `kill -9`s it during Wave C drops in-flight continuations onto
  restart-recovery. Do not deploy anything to `/opt/cezar` between Wave A and Wave D — which is why
  Phase 0 is *before* the sweep and Phase 5's marker re-stamp is a docs-only marker advance with no
  restart.

## Verification

Every command below is executable as written. `$P` is the prompt from § The prompt, written to a
file and passed as `--prompt "$(cat …)"` so it survives quoting intact.

**Phase 0 gate — both probes exit 0.** Run each probe verbatim from `.ai/deploy-targets.json`, in
this worktree, and echo `$?`:

```bash
cd <this worktree>
set -e; test -f /opt/cezar/packages/cezar/dist/index.js
test "$(cat /opt/cezar/.deployed-commit)" = "$(git rev-parse HEAD)"
curl -fsS --max-time 10 http://127.0.0.1:4321/api/v1/health > /dev/null
# and the web probe, verbatim
```

**Phase 1 gate — the selection matches the board.**

```bash
cd /var/lib/cezar/workspace
B=/opt/cezar/packages/cezar/dist/index.js
node $B runs reopen --all-done --dry-run                              # expect 20
node $B runs reopen --all-done --dry-run \
  --exclude a29f2b11-f83a-4c37-92bb-ff538551146a                      # expect 19: ws 15 / chat 3 / cezar 1
ls /var/lib/cezar/{workspace,loki-labs/cezar,loki-labs/chat}/.ai/cezar/reopen-requests.json
# expect: No such file or directory, three times — a dry run writes NOTHING
```

If the count is neither 20 nor 19, **stop**: the selector and the board disagree and this spec's
arithmetic is wrong.

**Before Wave A — the before-picture** (the apply-back control). For all twelve registered projects
plus the boot dir, record `git rev-parse HEAD`, `git status --short`, and `git worktree list`.
All twelve are clean today except the two live cezar worktrees and three live chat worktrees
already enumerated in § Problem 4. Save it to a file; Waves A and B diff against it.

**Wave A gate — all five must hold before Wave B.**

1. `b1684fe9` leaves `done`, appears in Working, streams, and settles to `done` (not `failed`, not
   `review`).
2. `grep '^MERGE-VERDICT:' chat/.ai/cezar/runs/b1684fe9-….{ndjson,handoff.md}` returns a line.
3. Its verdict is `merged-now` or `land-blocked` — **not** `merged`. `cez/b1684fe9` @ `2675cd16`
   is provably unmerged today (`git cherry origin/main cez/b1684fe9` → `+ 2675cd16`), so a
   `merged` verdict here means the agent got it wrong and the prompt's grounding failed.
4. If `merged-now`: `git -C chat cherry origin/main cez/b1684fe9` is now empty, and the named
   commit is reachable from `origin/main`.
5. No real checkout changed except `chat`, and `chat`'s change is exactly the landing.

**Wave B gate — the ten-worktree path.**

1. While `be31d9e9` runs: `git -C <root> worktree list` across the ten repos shows a
   `cez/be31d9e9` worktree in each. Count them. **Ten, not twelve** — `loki-labs`, `brand` and
   `lokie-chatbox` are one repo and must collapse to one tree, and a transcript note must say so
   (`workspace-worktrees.ts` emits "… are one git repo … they share the single worktree …").
2. After it settles: **zero** `cez/be31d9e9` worktrees and **zero** `cez/be31d9e9` branches remain
   in any repo. A leftover is the `conflict`/`failed` apply-back path and must be read, not
   ignored.
3. Every real checkout matches the before-picture except where the run deliberately changed
   something, and no `git apply --3way` conflict markers (`grep -rn '^<<<<<<<'`) exist anywhere.
4. A `MERGE-VERDICT:` line is present.
5. Its `costUsd` and duration are recorded — the per-continuation number that does not exist yet.

**Wave C.**

```bash
cd /var/lib/cezar/workspace
node $B runs reopen --all-done --prompt "$(cat /tmp/reopen-prompt.txt)" \
  --exclude a29f2b11-f83a-4c37-92bb-ff538551146a \
  --exclude b1684fe9-0201-48ba-ad3d-782b144350f5 \
  --exclude be31d9e9-6c5b-452d-bc63-caa348fe3292 \
  --exclude 7aecd6a2-e87b-485f-b1b1-c242ddaa92fa
# expect: 17 request(s) written
```

Then poll until no selected run is `queued` or `running`.

**Wave D — the record.** One row per run, all 19 plus `a29f2b11`:

| run | project | final status | verdict | ref / commit | evidence |
|---|---|---|---|---|---|

and a re-audit of the two scoreable findings:

```bash
git -C /var/lib/cezar/loki-labs/chat  fetch --quiet && git -C … cherry origin/main cez/b1684fe9
git -C /var/lib/cezar/loki-labs/cezar fetch --quiet && git -C … cherry origin/main cez/7c2dd8f0
```

**These two are the whole score.** If the sweep ends with either still unmerged *and* no recorded
reason, it did not work — and the handoff must say that rather than round it up.

**Gates before the commit:** `npm run typecheck`, lint, full test suite. This spec changes no
TypeScript, so the expected result is unchanged-from-`origin/main` — which is itself worth
asserting rather than assuming, since Phase 0 merges four commits into this branch.

## Analytics

Unchanged and still absent. There is no analytics or event sink anywhere in this codebase —
`todo-autostart.ts` records the finding, `reopen-watch.ts` carries the matching
`TODO(analytics): emit run.reopened (project, source, queuedDepth)`. This sweep emits `console`
lines and nothing else. Stated rather than promised.

The sweep does, however, produce the first real dataset on continuation cost and duration on this
box (19 samples, with per-run `costUsd` in `runs.json`). Recording those two numbers per run in the
Wave D table is the analytics deliverable, and it is the input any future bulk-reopen needs.

## Out of scope

- `POST /runs/reopen-finished` and a "Reopen finished" UI broom. Unchanged from the parent spec.
- Archiving anything. This sweep audits the board; it does not clean it. The 19 rows stay on
  Active afterwards.
- `rescue/staged-index-20260820` @ `343f79ea` in `cezar` — 1 commit ahead of `main`, no run row,
  unreachable by a run-driven sweep. Still worth a filed todo. (`cez/6af4b894` is **no longer** in
  this bucket — see § Problem 5.)
- `2f1ae4aa`'s three ad-hoc artifacts in `chat/.ai/cezar/runs/` (`…-reporters.json`,
  `…-reporters-user2.json`, `…-cancel-daily-tasks.sh`) — still there, still not `<id>.ndjson` /
  `.handoff.md` / `.knowledge.ndjson`.
- Raising `resources.maxParallel` to make the sweep faster. Tempting and out of scope: it changes a
  global production setting to speed up one operation.

## What I could not establish

- **How long a continuation takes, or what it costs.** No continuation of a finished run has ever
  been measured on this box. Every wall-clock and cost figure in § Risks is derived from *original*
  run records, which is a ceiling and not an estimate. The canaries are the measurement.
- **Whether the 15 workspace runs' work reached `main`.** Unchanged from the parent spec, and it is
  the sweep's whole question: their branches and worktrees were deleted on apply-back, so there is
  no ref to compare and no script can answer it from outside.
- **Whether `origin/*` is current.** This audit was read-only; no `git fetch` ran. Every
  `origin/main` claim here is as of the last fetch someone else performed — which is exactly why
  the prompt's first grounding bullet is "fetch first".
- **Whether re-applying a workspace run that already applied once is safe.** Reasoned through the
  code above and expected to be benign; never executed. Wave B is the first execution, which is why
  it is a gate and not a step.
- **Why `git -C /var/lib/cezar/loki-labs ls-files` reports 0 tracked files** when the workspace
  `CLAUDE.md` describes that root as a small git repo tracking `CLAUDE.md` and `AGENTS.md`. Noted,
  not chased — it does not affect the sweep, but any agent reasoning about the `loki-labs` project's
  merge state should verify it rather than trust either source.

## Status log — 2026-08-20 (run `7aecd6a2`, workflow `spec-to-deploy`)

| step | outcome |
|---|---|
| 1 `spec` | this file. Read the parent spec end to end, the shipped `reopen-cli.ts` / `reopen-watch.ts` / `continueRun` / `workspace-worktrees.ts` at `origin/main`, `AGENTS.md` § "Shipping cezar itself", `.ai/deploy-targets.json`, `/opt/cezar/.deployed-notes.md`, and re-measured the live board: 20 done+unarchived rows, 10-worktrees-per-workspace-run, the four-run merge audit, per-run cost and duration, and the transcript/handoff shapes the verdict collector depends on. Three corrections to the parent spec's arithmetic recorded above. |

| 2 `implement` | **Phase 0 DONE** — fast-forwarded `origin/main` `f02156d5` into `cez/7aecd6a2`; both `.ai/deploy-targets.json` probes exit 0, so **AC1 is met** (`/opt/cezar/.deployed-commit` = `f02156d5`, ≥ `0cbb65a4`, service live as MainPID `3683619`). No tree swap and no restart: this run's delta is docs-only and takes the no-restart carve-out — deliberately, because a restart mid-sweep `kill -9`s in-flight continuations. **Phase 1 DONE** — dry runs: bare = **20**, `--exclude a29f2b11` = **19** (workspace 15 / chat 3 / cezar 1), and `reopen-requests.json` was absent before and after in every project, so **AC2 is met**. Before-picture in `.ai/cezar/tmp/7aecd6a2…/reopen-before.txt`. **Wave A FIRED** — `b1684fe9` (chat), request `acd801d9`, 19:23:27 UTC written / 19:27:26 UTC started. **Waves B, C and D were not reached.** |
| 3 `run-tests` | Nothing to run — the delta is a spec file. No code changed, so the gates from run `a29f2b11` (typecheck exit 0, 64 new tests green) still describe `HEAD`. |
| 4 `commit-push` | `58961e5e` ("docs: spec the reopen sweep — two canaries, nineteen verdicts, one grep-able line"), pushed `f02156d5..58961e5e` to `origin/main`, clean fast-forward. |
| 5 `document` | this block, the Status correction at the head of this file, and **four corrections written in place** into the parent spec (`2026-08-20-reopen-finished-tasks-merge-audit.md`): its "NOTHING HAS BEEN REOPENED" head claim, and the three places it calls `cez/6af4b894` an orphan with no run record. KB proposals written for the lazy-context defect and for the sweep's execution state. Todo filed for Waves B-D. |

### The blocking defect this run found, and did not fix

**A reopen request filed against a project whose context is not resident is silently lost.**
`server.ts` wires `watchReopenRequests` for the boot context, for contexts already built, and on
`onContextBuilt` — but project contexts are **lazy** (`ProjectContexts.context()` builds on first
API touch), so a project nobody has opened since the last restart has no watch on its
`<dataDir>/reopen-requests.json`. Verified on production by inotify against PID `3683619`: the
`workspace` (boot) and `cezar` dataDirs were watched, `chat`'s was not. `cezar runs reopen
--project chat` therefore wrote a well-formed request that nothing would ever read — no error, no
stamp — which is the precise silent-loss failure `reopen-watch.ts`'s continue-then-stamp ordering
was designed to prevent.

**Worked around, not fixed:** one authenticated loopback read (`GET /api/v1/p/chat/launch-key`,
using a live session id from the local identity store) built chat's context, which fired
`onContextBuilt` → `watch` → reconcile, and Wave A started four minutes after it was filed. It
affects `chat` (3 runs) only in this sweep; `workspace` (15) and `cezar` (1) were already resident.
Not fixed here on purpose: the fix is TypeScript, and shipping TypeScript means a restart, and a
restart mid-sweep drops in-flight continuations. Filed as cezar todo `503195a8`.

### Verdicts collected so far

**None.** The table below is the shape the sweep must fill; it is empty because Wave A had not
settled when this run's `document` step ran, and Waves B-D never fired.

| run | project | verdict | repo | ref | note |
|---|---|---|---|---|---|
| `b1684fe9` | chat | *pending* — `continue-1` still `running` at 19:51 UTC | — | — | KNOWN-UNMERGED going in: `2675cd16`'s content is not on `origin/main`. A bare `merged` verdict from this run means the prompt failed, not that the work landed. |
| the other 18 | — | *not reopened* | — | — | — |

**Scoring caveat for whoever grades Wave A.** At ~19:35 UTC the reopened agent fetched
(`origin/main` `3e4f26a5` → `e54cc50a`) and then `git reset --hard origin/main` on `cez/b1684fe9`,
dropping tip `2675cd16` from the branch and re-applying its SPEC-529 work as a focused delta on top
of SPEC-528, which had landed meanwhile. So `git cherry origin/main cez/b1684fe9` is now
**vacuously empty** (branch == `origin/main`) and cannot score items 3-4 of the Wave A gate. Score
on whether `2675cd16`'s **content** reaches `origin/main`; the commit survives in the branch reflog
(`cez/b1684fe9@{1}`).

### How to resume

Nothing here is stateful — the waves are independent CLI invocations. In order:

```bash
# Wave A gate — b1684fe9 must settle first
grep -n '^MERGE-VERDICT' /var/lib/cezar/loki-labs/chat/.ai/cezar/runs/b1684fe9-*.handoff.md

# Wave B canary — the ten-worktree path, still unproven
cezar runs reopen be31d9e9-6c5b-452d-bc63-caa348fe3292 --project workspace   # expect 10 worktrees, all gone after settle

# Wave C — the remaining 17
cezar runs reopen --all-done   --exclude a29f2b11-f83a-4c37-92bb-ff538551146a   --exclude b1684fe9-0201-48ba-ad3d-782b144350f5   --exclude be31d9e9-6c5b-452d-bc63-caa348fe3292   --exclude 7aecd6a2-e87b-485f-b1b1-c242ddaa92fa

# Wave D — collect
grep -rn '^MERGE-VERDICT' /var/lib/cezar/*/.ai/cezar/runs/*.handoff.md                           /var/lib/cezar/loki-labs/*/.ai/cezar/runs/*.handoff.md
```

**Cautions that outlive this run.** Do NOT deploy to `/opt/cezar` between Wave A and Wave D — the
restart is a `kill -9` and drops in-flight continuations. `maxParallel` is 3 with a FIFO queue, so
17 queued reopens block the owner's next task for hours; that is a scheduling decision for the
owner, not a technical one. And `--project chat` still needs a resident context (see the defect
above) until `503195a8` is fixed.
