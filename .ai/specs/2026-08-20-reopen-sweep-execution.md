# Firing the reopen sweep: two canaries, nineteen verdicts, and one line each agent must print

> **Status: DONE — the sweep ran, and every one of the 19 runs answered.** 2026-08-21, run
> `c10864d1`. **20 `merged`, 2 `merged-now`, 0 `land-blocked`, 0 `cannot-determine`, 0 runs without
> a verdict.** The owner's ask — *"analyze if changes/fixes/updates from this task were merged into
> main. if not, do it now"* — is answered for the whole Active tab.
>
> **Both known-unmerged findings were landed, and neither was rounded up.** `chat` `cez/b1684fe9`
> → `35d2e33e`; `cezar` `cez/7c2dd8f0` → `e916a211`. Both are `origin/main`'s tip in their repo and
> both verify with an empty `git cherry` after a fetch. Everything else was already on `main` —
> which nobody could have known before this ran.
>
> **It cost $114.05.** 19 continuations, mean $6.00, against $1,222.59 of original spend for the
> same runs. A merge audit that lands work costs ~$7; one that finds it already merged costs ~$2.
>
> Per-wave gates, the four defects this run measured, and the full 20-row table are in
> § Status log — 2026-08-21. Two things are deliberately **not** claimed done: eleven runs finished
> in `waiting` rather than settling, so their worktrees and branches are still on disk (board
> hygiene, not audit — cezar todo `4929b86c`, which superseded `4fc816ca`); and the queue-pump
defect that nearly stalled the
> sweep is diagnosed, not fixed (cezar todo `b6fbd608`).
>
> ~~**Status: EXECUTED — all four waves have fired; every one of the 19 runs has now been asked, and
> the verdicts are arriving.**~~ Superseded a few hours later by the answers themselves.
>
> ~~**Status: PARTIAL — executed through Wave A, and Wave A has not finished. Waves B, C and D have
> NOT run.**~~ **Superseded 2026-08-21 by run `c10864d1`; the original text follows.** Measured
> 2026-08-20 19:51 UTC, at the end of run `7aecd6a2`'s `document` step. Phase 0
> (deploy) and Phase 1 (the dry runs) are **DONE** and their acceptance criteria are met. Wave A's
> canary — chat run `b1684fe9`, request `acd801d9` — was reopened at **19:27:26 UTC** and its
> `continue-1` step was still `running` when this line was written, so **not one `MERGE-VERDICT`
> line exists yet**: `grep -rn MERGE-VERDICT` across every run directory on this box matches only
> the prompt text this spec injects. **One of nineteen runs has been reopened; eighteen have not.
> The owner's ask is still unanswered.** What remained was carried by a cezar todo — which run
> `c10864d1` then executed.
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

> **CORRECTED 2026-08-21 (run `c10864d1`) — the anchored grep below matches nothing.** It was
> written from the format the prompt asks for, not from the artifact agents actually produce. The
> prompt says "append it under `## Progress log` in your handoff file", and a Progress-log entry is
> a **bullet**, so the real line is `- 2026-08-20 19:55 — MERGE-VERDICT: merged-now | chat | …`.
> `^MERGE-VERDICT` cannot match it. Measured against both settled runs: the anchored form returns
> zero rows where the token-anywhere form returns both. Two further traps found the same way — the
> `.ndjson` transcript *also* contains the prompt's own `<merged|merged-now|…>` **placeholder**,
> which any naive grep reports as a verdict; and the transcript escapes newlines, so a match must
> be cut at the first `\n`. Use:
>
> ```bash
> grep -ho 'MERGE-VERDICT:.*' "<dataDir>/runs/<runId>.handoff.md" 2>/dev/null \
>   | grep -v '<merged' | sed 's/\\n.*//' | tail -1
> ```
>
> Handoff **first**, transcript only as a fallback: the handoff carries the agent's final,
> self-corrected line, while the transcript carries every draft of it. The working collector run
> `c10864d1` used is preserved at `.ai/cezar/tmp/c10864d1-…/sweep-status.py` (and its markdown
> renderer beside it), which also joins each verdict to the run's final status and cost — the
> three facts the Wave D table needs together.

**Superseded — kept verbatim so the mistake is recognisable, do not run it:**

```bash
# WRONG: `^` never matches, because the line is written as a Progress-log bullet.
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
  Wave D   grep 'MERGE-VERDICT:' over 19 × (handoff.md, ndjson) → the Phase 5 table   [*]
        │
  Phase 6  parent spec Status: PARTIAL → resolved; marker re-stamped; commit + push
```

`[*]` **Corrected 2026-08-21 (run `c10864d1`).** This box originally read
`grep '^MERGE-VERDICT:'` and the anchor matches nothing — the line is written as a Progress-log
**bullet**. Handoff first, transcript only as a fallback. See § The collector for the working
command and the two further traps it hides.

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
2. ~~`grep '^MERGE-VERDICT:' chat/.ai/cezar/runs/b1684fe9-….{ndjson,handoff.md}` returns a line.~~
   **Corrected 2026-08-21:** the anchored form returns nothing for any run, because the line is a
   Progress-log bullet — use the collector in § The collector. Graded with the corrected command,
   this item **PASSED**.
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

| 6 `deploy` | **Re-deployed `34a80bb9` and both probes exit 0 — AC1 holds again at the new HEAD.** Step 4's push moved HEAD past the marker (`f02156d5` → `58961e5e` → `34a80bb9`), so probe 1 — which string-compares `/opt/cezar/.deployed-commit` against `git rev-parse HEAD` — had gone **red** again (measured exit 1 at 19:56 UTC) even though nothing shippable had changed. Took the docs-only carve-out per `AGENTS.md`:12 and § Phase 0: `git diff --name-only f02156d5..HEAD \| grep -v '\.md$'` returns nothing (the delta is this spec, the parent spec's corrections, and `CHANGELOG.md`). **This time the carve-out was verified rather than asserted** — a full `npm run build` was run at `34a80bb9` and diffed against the deployed tree: `web/dist` byte-identical (222/222 files, zero diffs); `dist` 787/787 files with **zero `.js`/`.json` differing**, `dist/index.js` sha256 `5a839289…6d1c89bc` on both sides, and `reopen-requests.js` / `reopen-watch.js` / `runs/reopen-cli.js` all hash-matching. The only three differing files are `.d.ts` declarations (`notes-routes`, `notifications-routes`, `workspace-reports-routes`) where tsc emitted the same inferred Hono response union in a different member order — type-only, never loaded at runtime. So the artifact in place **is** a correct build of `34a80bb9`; marker advanced, **no tree swap and no restart**, prior marker kept as `.deployed-commit.bak.20260820-195754` and the reasoning appended to `/opt/cezar/.deployed-notes.md`. The restart was withheld deliberately, not skipped: the reopen watcher lives in resident MainPID `3683619` and Wave A's continuation `b1684fe9` was **still running** — a `kill -9` would have dropped it onto restart-recovery to re-execute the exact bytes already loaded. Post-state: both probes **exit 0**, service `active` MainPID `3683619` unchanged since 19:04:02 UTC, `b1684fe9` still `running`, and the deployed CLI still answers `runs reopen --help`. **This step deployed; it did NOT run the sweep** — Waves B, C and D remain unrun and AC3/AC4 remain **unmet**, carried by todo `9159228c`. |

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

> **SUPERSEDED 2026-08-21 by § Status log — 2026-08-21 (run `c10864d1`), which carries the live
> table for all 20 rows.** The "None" below was true when written; Wave A has since settled and
> Waves B-D have fired. Kept for the Wave A scoring caveat at the foot, which is still the
> instruction that was actually followed.

~~**None.**~~ The table below is the shape the sweep must fill; it was empty because Wave A had not
settled when run `7aecd6a2`'s `document` step ran, and Waves B-D had not fired.

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

## Status log — 2026-08-21 (run `c10864d1`, workflow `spec-to-deploy`)

Run `7aecd6a2` fired Wave A and stopped. This run finished the sweep: it graded Wave A, fired
Wave B and Wave C, and built the collector Wave D needs. **All 19 runs have now been asked.**

| step | outcome |
|---|---|
| 1 `spec` | Re-measured the board rather than trusting the numbers above, and was right to: the selection is **20 done+unarchived rows** (workspace 16 / cezar 2 / chat 2), unchanged in count from 19:51 UTC but not in membership — `7aecd6a2` settled into it and `b1684fe9` left it for `running`. Confirmed `reopen-requests.json` existed in exactly one dataDir workspace-wide, holding exactly one consumed request: **the sweep had filed one intent, ever.** Wrote no spec file; this section is where its census landed. |
| 2 `implement` | Everything below. |

**Phase 0.** `cez/c10864d1` was 7 behind `origin/main` and 1 ahead (`b99317c5` "msg", a local-`main`
commit duplicating the shipped reopen feature). Merged `origin/main` `997efab0` in, taking origin's
side on both add/add conflicts — the parent spec and `CHANGELOG.md`, where origin already carried
run `7aecd6a2`'s corrections. **The merged tree is byte-identical to `origin/main`**
(`git diff origin/main..HEAD` empty), which is the cleanest possible proof that `b99317c5` added
nothing origin did not already have. Probe 1 (`.deployed-commit` == `git rev-parse HEAD`) is
therefore **red by commit hash and green by content** until this run's own commit lands and the
marker advances — the `deploy` step's problem, and deliberately not fixed here, because
**the marker advance must not restart the service while 17 continuations are queued.**

### Wave A — GRADED: four of five gate items PASS, the fifth not establishable

`b1684fe9` settled **`done`** at `2026-08-21T06:57:03.082Z`, 11h30m after being reopened — of which
almost all was idle: its `continue-1` step parked in `waiting` at 19:55 and `continue-2` did the
remaining work in **12 minutes** (06:45:15 → 06:57:03). Cost went `$28.28 → $35.09`, so the
continuation cost **$6.80**.

```
MERGE-VERDICT: merged-now | chat | 35d2e33e | SPEC-529's rescoped delta is on origin/main;
                                              the original duplicate commit was discarded, not re-landed.
```

Scored on **content**, per the scoring caveat this spec left for exactly this moment — `git cherry`
is vacuously empty after the agent reset onto `origin/main`, so it proves nothing. What proves it:

* `35d2e33e` **is** `origin/main`'s tip (`git merge-base --is-ancestor` → yes).
* `.ai/specs/SPEC-529-2026-08-19-name-the-survivors.md` is on `origin/main`.
* All three of SPEC-529's markers — `remaining_tasks`, `next_fire_local`, `formatLocalDateTime` —
  are present in `domains/chatbots/worker/src/scheduled-tasks.ts` **on `origin/main`**.
* `030343da` (SPEC-528, the parallel triage that had already covered ~85%) is on `origin/main` too,
  which is why the delta was small.

And the verdict is **`merged-now`, not a bare `merged`** — the one outcome this spec said would mean
the prompt's grounding had failed. It did not fail. The agent found the duplication, discarded
`2675cd16` rather than re-landing it, and said so in one line.

*Gate item 5 (no real checkout changed except `chat`) is graded* **not established** *rather than
passed:* this run's before-picture was necessarily taken **after** Wave A had already pushed, so
there is no control to diff against. Recorded as a gap in the method, not as a pass.

### Wave B — GATE ITEM 1 PASS (the ten-worktree path is proven), ITEM 2 PENDING

Filed 06:55:11.046Z, stamped `startedAt` **300 ms later** — the resident watcher's `fs.watch` fired
immediately. The run then sat `queued` for ~2 minutes and started the instant `b1684fe9` settled.

**Exactly 10 distinct worktrees materialized**, counted by `--git-common-dir` rather than by
directory (the naive count is 14, because five registry projects resolve into the `loki-labs`
repo):

```
loki-labs · anymail-mcp · aside · bubble-trade · career · career-kit · cezar · chat ·
homebrew-tap · mw-site                                                      = 10 repos, 10 worktrees
```

and the engine emitted its own confirmation of the collapse — *"… are one git repo
(/var/lib/cezar/loki-labs) — they share the single worktree …"*. Note the run's own note says
**"12 project worktree(s) isolated"**: that counts `workspaceProjects` **entries**, not
directories. Both numbers are correct and they are not the same number; a reader checking the gate
against the transcript note alone will conclude the collapse did not happen.

The verdict came back in **under four minutes**, cost `$2.80 → $4.69` — a **$1.89** continuation,
the cheapest datum in the sweep:

```
MERGE-VERDICT: merged | cezar | 9c65a1b8 | The spec .ai/specs/2026-08-20-split-steps-spec-review-and-approval-gate.md
                                           was already on origin/main before this audit, swept in by the
                                           follow-on chain-integrity commit.
```

Verified by the agent with `git merge-base --is-ancestor 9c65a1b8 origin/main` **and** a
`git show origin/main:<spec>` content diff — not by `git branch --merged`, which is the trap. It
also noticed `b99317c5` on local `cezar` `main` and correctly left it alone as another task's work.

**Gate item 2 — "zero `cez/be31d9e9` worktrees remain after it settles" — was pending on the canary
and has since PASSED on a different run.** `be31d9e9` did not settle when the gate was first
checked: it went **`waiting`** at 06:58:40 with its `claude` process still alive, exactly as
`b1684fe9` did for 11 hours, and apply-back only runs on *settle*.

**`b63f15e4` (Wave C, workspace, the $186 run) executed the path instead, at 07:14** — and this is
the measurement the spec's § Risks entry *"apply-back on a run that already applied once"* had been
missing since it was written:

* the transcript emits `applying 10 project worktree(s) back to their checkouts…`, and the
  five-projects-one-repo note again;
* afterwards **zero** `cez/b63f15e4` worktrees and **zero** `cez/b63f15e4` branches remain in any of
  the 10 repos;
* every real checkout is **clean** (`git status --porcelain` empty in all 10) and **no conflict
  markers** exist anywhere — the audit changed nothing, so `applyOne` took its `outcome: 'nothing'`
  path and removed the tree without touching the checkout, exactly as the risk entry predicted it
  should.

So re-applying a workspace run that already applied once is **benign, measured rather than
reasoned**. Todo **`4fc816ca`** is therefore **closed 2026-08-21**: all three of its acceptance
criteria were executed and measured here. The narrower question it also asked — a run that *does*
change something on a second apply-back — this sweep never produced, so it is **unmeasured, not
passed**, and it carries forward in `4929b86c` rather than keeping a satisfied todo open.

**And the canary's own ten did clear, by the other route.** `be31d9e9` never settled — it later
died on a transport error (§ Two continuations died of transport errors) — but the `failed` path
still removed all **10** of its worktrees. What it did **not** remove is its **10 branches**, which
are still there. So the literal gate reads: *ten materialized, ten gone* for `be31d9e9` as well,
with the branch leak as the difference between the `failed` and `done` paths. Stated this way
because "all 10 are gone after it settles" is satisfied by the count and **not** by the mechanism
the gate was written to test — `b63f15e4` is what actually tested that.

### Wave C — FIRED, 17 of 17

```
dry run — 17 run(s) would be reopened, nothing written     # matched the predicted 17 exactly
chat: filed 2 · workspace: filed 14 · cezar: filed 1       # 06:59:08Z
```

Exclusions: `a29f2b11` (the owner's, unconditional), `b1684fe9` + `be31d9e9` (the canaries),
`7aecd6a2` (which had since settled into `done` and so was genuinely selectable this time — the
defensive exclusion the spec added stopped being defensive and started mattering), and
`c10864d1` (this run).

**Every one of the 17 was stamped `started` within a second, in all three dataDirs — including
`chat`.** Defect `503195a8` (a request filed against a non-resident project context is silently
lost) did **not** bite, because Wave A had made `chat`'s context resident an hour earlier. That is
luck, not a fix: fire this sweep from a cold restart and the two `chat` rows vanish silently.

### What throttles the drain — a missed pump wakeup, established by experiment

Six minutes after Wave C was filed, **all 17 were still `queued` and nothing had started**, with:

| fact | value |
|---|---|
| `resources.maxParallel` (`~/.cezar/config.json`) | **3** |
| live `claude` agent processes | **2** (`c10864d1` running, `be31d9e9` parked in `waiting`) |
| queued runs whose reopen request is stamped `started` | **17** |
| runs started in that window | **0** |
| runs started within 8s of nudging the pump | **2** |

The same shape appeared earlier: `be31d9e9` sat `queued` from 06:55:11 to 06:57:03 while exactly
two runs were live, and started the instant one settled. So the queue behaves as though the ceiling
were **2**, or as though the pump needs a wake event it is not getting.

Two hypotheses fit that: a **real ceiling** (something counts a third slot), or a **missed
wakeup** (capacity exists, nothing pumps). Reading `pump()` favoured the second — `capacity()` is
`semaphore.busy() < maxParallel && busySlots() < projectMax && (repo !== null ||
nonWorkspaceInPlaceBusy() < 1)`, and with `busy() <= 2 < 3` every clause holds — but the
counter-hypothesis was `accountHeldFor`: every queued run is `claude:default`, and if
`accountHolds().inFlight` names that account the dequeue `findIndex` returns `-1` and the loop
breaks with capacity to spare.

**Distinguished by experiment at 07:09:56 UTC, and it is the missed wakeup.** `PUT
/api/v1/workspace/config` with the `resources` object read back verbatim from `GET` — a no-op write
(`~/.cezar/config.json` md5 `2dae41e8…` identical before and after) whose only side effect is the
documented live-apply hook `semaphore.refresh()` → `release()` → *pump every registered manager*.
**Two runs started within eight seconds** (`2f1ae4aa` and `28993af3`, both chat). The capacity had
been there the whole time; nothing had asked for it.

That also settles what a `waiting` run costs. After the nudge the board read `c10864d1` +
`2f1ae4aa` + `28993af3` running with `be31d9e9` still `waiting` — **three running against
`maxParallel: 3`**, so a `waiting` run holds **no** slot, exactly as `busySlots()` claims.
`accountHeldFor` is exonerated; the account-hold reading was wrong, and the earlier sentence in this
spec guessing at "the ceiling behaves as 2" was wrong with it.

**So the defect is: a transition into `waiting` frees a slot without pumping.** Every *settle*
pumps — which is why `be31d9e9` started the instant `b1684fe9` finished — but a run that parks in
`waiting` instead of settling leaves the queue asleep on capacity it is allowed to use. With 17
reopens queued behind two canaries that both parked in `waiting`, that is the difference between a
sweep that drains overnight and one that does not move at all. Filed as cezar todo **`b6fbd608`**;
not fixed here, because fixing it is TypeScript and shipping TypeScript means a restart, and a
restart mid-sweep `kill -9`s the continuations. Same trade the last run made with `503195a8`, for
the same reason.

**The operational remedy, until it is fixed.** When the board shows queued runs and fewer live
agents than `maxParallel`, nudge the pump. It writes nothing:

```bash
ID=/var/lib/cezar/.cezar/identity/identity.json
SID=$(python3 -c "import json,datetime;d=json.load(open('$ID'));\
n=datetime.datetime.now(datetime.timezone.utc);\
s=[x for x in d['sessions'] if datetime.datetime.fromisoformat(x['expiresAt'].replace('Z','+00:00'))>n];\
s.sort(key=lambda x:x['expiresAt'],reverse=True);print(s[0]['id'])")
curl -s -H "Cookie: cez_session=$SID" http://127.0.0.1:4321/api/v1/workspace/config > /tmp/cfg.json
curl -s -X PUT -H "Cookie: cez_session=$SID" -H 'Content-Type: application/json' \
  -d "$(python3 -c "import json;print(json.dumps({'resources':json.load(open('/tmp/cfg.json'))['resources']}))")" \
  http://127.0.0.1:4321/api/v1/workspace/config > /dev/null
```

The session id is the box's own, the route is the one the cockpit's settings page already calls, and
the body is the config read back unchanged — confirm with `md5sum ~/.cezar/config.json` before and
after that it did not change. Two details that cost time to find: the cookie is **`cez_session`**
(`cezar_session`, `session` and `sid` all 401), and the route is **`/api/v1/workspace/config`** —
`/api/workspace/config` returns **404 *after* authenticating**, which reads exactly like an auth
failure and is not one.

### Two continuations died of transport errors, and what that leaves behind

Between 07:32 and 07:34 two runs flipped from `running` to **`failed`**, both on transport, neither
on logic:

| run | error | verdict at the time it died |
|---|---|---|
| `be31d9e9` (the Wave B canary) | `continue failed: API Error: Connection lost mid-response.` | **had already printed one** |
| `81345cea` | `continue failed: API Error: The response stopped arriving.` | **none** — it died mid-sentence on *"Let me fetch first and verify my work against the latest origin/main"* |

Three things follow, and all three are collector rules, not curiosities:

1. **`failed` does not mean "no answer".** `be31d9e9`'s verdict was written before the transport
   died and is intact in its handoff. A collector that skips non-`done` rows loses a real verdict.
   The § Risks note that a continuation "can end worse than it started" is confirmed — the row now
   reads `failed` where it read `done` this morning — but the *audit* it was reopened for succeeded.
2. **A `failed` run is re-askable, and `--all-done` will not re-ask it.** `continueRun` accepts
   `done | failed | cancelled | review | waiting`, so an explicit
   `cezar runs reopen <runId>` works. But `--all-done` selects `status === 'done'` only, and
   `markReopenStarted` is first-stamp-wins and never retried — so **a crashed continuation is
   silently dropped from any re-run of the sweep.** Re-file it by id. `appendReopenRequests` does
   not dedupe, which is exactly what makes that safe *for one named run* and dangerous for a wave.
3. **A failed workspace run removes its 10 worktrees but leaks its 10 branches.** Measured across
   the 10 repos right after both failures: **zero** `cez/be31d9e9` / `cez/81345cea` *worktrees*
   remain, and **ten of each `cez/…` branch do**. A settled run (`b63f15e4`) leaves neither. Every
   real checkout stayed clean throughout, so this is litter rather than damage — but at 10 branches
   per failed workspace run it accumulates fast, and nothing in the sweep cleans it up.

Also worth stating plainly: **two transport failures in three minutes**, while three agents ran
concurrently, is the only quality signal this sweep has about running reopens in parallel. One
sample of two; not enough to conclude anything, and recorded so the next bulk reopen watches for it
rather than rediscovering it.

### Continuation cost — the number that did not exist before

Two samples, and they are **far** below the "original run cost" ceiling § Risks had to reason from:

| run | original | after continuation | continuation cost | wall clock (active) |
|---|---|---|---|---|
| `b1684fe9` (chat, landed work) | $28.28 | $35.09 | **$6.80** | ~40 min across two sessions |
| `be31d9e9` (workspace, audit only) | $2.80 | $4.69 | **$1.89** | ~4 min |

An audit that finds its work already merged costs ~$2. An audit that has to rebase, run a
monorepo's full pre-push gate and push costs ~$7. Against $1,209 of original spend, the whole
19-run sweep should land in the **$40-$130** range — not the four figures the original-cost table
invites you to fear. Record this before the next bulk reopen is argued about on the wrong numbers.

### Verdict table — all 20 rows, all answered

**The sweep is answered.** Every reopened run printed a `MERGE-VERDICT` line; the twentieth row is
the run the owner excluded, settled on documentary evidence. Regenerate at any time with
`python3 .ai/cezar/tmp/c10864d1-…/render-table.py`.

**Outcome, in one line: 20 `merged`, 2 `merged-now`, 0 `land-blocked`, 0 `cannot-determine`,
0 `no-verdict`** — 22 verdict lines across 20 runs, because `2f1ae4aa` touched three repos and
printed one per repo, as the prompt asks.

**Total continuation spend: $114.05 across 19 continuations, mean $6.00** (min $1.15 `ec6e8e06`,
max $21.53 `2f1ae4aa`), against **$1,222.59** of original spend for the same 20 runs. The estimate
this spec made from its first two samples — "$40-$130" — held. **Re-asking every finished run on
this board costs about 9% of one of its expensive runs.**

| run | project | wave | final status | verdict | repo | ref / commit | continuation $ | evidence |
|---|---|---|---|---|---|---|---|---|
| `2f1ae4aa` | chat | C | `done` | **merged** | chat | `3e4f26a5` | +$21.53 | All four commits are ancestors of origin/main and `git cherry origin/main cez/2f1ae4aa` is empty. |
|   ↳ |  |  |  | **merged** | cezar | `f08cb687` |  | The host-metrics commit is an ancestor of origin/main and packages/cezar/src/core/host-metrics.ts exists there. |
|   ↳ |  |  |  | **merged** | loki-labs (workspace root) | `1f607c7` |  | Commit is on main; the repo has no remote, so there is nowhere further to land it. |
| `b63f15e4` | workspace | C | `done` | **merged** | cezar | `4c0c0118 (+f08cb687,70beab7f,63f01cc4,4797a60d)` | +$9.49 | all five session commits are ancestors of origin/main (head 997efab0), verified by git merge-base --is-ancestor after fetch. |
| `ae1cb6ce` | workspace | C | `done` | **merged** | cezar | `67e93cca` | +$6.12 | Feature already on origin/main (commit 67e93cca) with the 2026-08-20 point-in-time correction on top; nothing to land. |
| `6aa07506` | workspace | C | `done` | **merged** | cezar | `1a1b2aba,67e93cca` | +$6.86 | Both commits are ancestors of origin/main (997efab0); pushed last session, already on main. |
| `4e5ba904` | workspace | C | `done` | **merged** | cezar | `5e388ccf` | +$2.73 | mobile-UX changes are an ancestor of origin/main and its code+spec are present there; no push needed. |
| `28993af3` | chat | C | `done` | **merged** | chat | `e54cc50a (+ f955ceb3 added this session)` | +$17.96 | All three original commits were already ancestors of origin/main; `git cherry` after a fetch returned empty. |
| `7e4a2d14` | workspace | C | `waiting` | **merged** | cezar | `097d1b15 (ancestor of origin/main 997efab0)` | +$4.90 | Both task commits are ancestors of origin/main and all changed files verified present; nothing to land. |
| `be31d9e9` | workspace | B | `failed` | **merged** | cezar | `9c65a1b8` | +$1.89 | The spec `.ai/specs/2026-08-20-split-steps-spec-review-and-approval-gate.md` was already on origin/main before this audit, swept in by the follow-on c |
| `7c2dd8f0` | cezar | C | `waiting` | **merged-now** | cezar | `e916a211` | +$12.87 | Spec rewrite was never on main; rebased onto origin/main preserving f9bcda42's amendment, typecheck green, pre-existing test failures proven unrelated |
| `ef9901e3` | workspace | C | `waiting` | **merged** | cezar | `9c65a1b8 (ancestor of origin/main 997efab0)` | +$3.78 | reopen-sweep verified my idle-park change (run.ts idleParked, server.ts /messages fallback, contract continued, tests) is already on origin/main; noth |
| `81345cea` | workspace | C | `waiting` | **merged** | cezar | `c069eba5 (+5e388ccf)` | +$1.24 | all three fixes (context point-in-time, recover pending-ask→review, live per-round-trip context.updated) were already on origin/main before this audit |
| `9d09795a` | workspace | C | `waiting` | **merged** | cezar | `e3f542df (+ 5774bf95, e6b77995, 9c65a1b8, ee74a158)` | +$4.58 | All five commits are ancestors of origin/main and `git cherry origin/main cez/9d09795a` reports zero unlanded patches; content verified present at ori |
| `202d099e` | workspace | C | `waiting` | **merged** | cezar | `62a41d30` | +$4.31 | Committed and pushed during the session; verified on origin/main by ancestry, by file/behaviour presence, and by an empty `git cherry` against cez/202 |
| `ec6e8e06` | workspace | C | `waiting` | **merged** | cezar | `d353944c,52a39767,ec02fdda,a6c0ba3e` | +$1.15 | All four commits are ancestors of origin/main and git cherry is empty; the feature files and the LiveDuration wiring are present at origin/main. |
| `6af4b894` | workspace | C | `waiting` | **merged** | cezar | `93e450c7` | +$1.71 | All three commits (69b4a3de, fe8b148e, 93e450c7) are ancestors of origin/main and `git cherry` reports zero unlanded patches. |
| `23221162` | workspace | C | `waiting` | **merged** | cezar | `1f1078a4 (landed via merge 93e450c7)` | +$2.43 | Ancestor of origin/main with an empty `git cherry`, and all six files plus both prompt markers content-verified upstream. |
| `3bc55a31` | workspace | C | `waiting` | **merged** | cezar | `57fc8807 + 19327f28 (ancestors of origin/main 997efab0)` | +$1.49 | Both commits are ancestors of origin/main and `git cherry origin/main cez/3bc55a31` is empty, so every patch from this task landed; no other repo was  |
| `a1be9ae3` | workspace | C | `waiting` | **merged** | cezar | `f9bcda42` | +$2.21 | All four commits are ancestors of origin/main with an empty `git cherry` and the content verified still present, and no other repo was touched. |
| `a29f2b11` | workspace | — (excluded) | `done` (never reopened) | **merged** | cezar | `2e421370`,`0cbb65a4`,`f53f5a58`,`f02156d5` | — | documentary: all four commits are on `origin/main`; the owner’s `--exclude` stands, so no continuation was spent |
| `b1684fe9` | chat | A | `done` | **merged-now** | chat | `35d2e33e` | +$6.80 | SPEC-529's rescoped delta is on origin/main; the original duplicate commit was discarded, not re-landed. |

**19 of 19 reopened runs printed a `MERGE-VERDICT` line (21 lines in total — `2f1ae4aa` touched three repos), and the twentieth (`a29f2b11`, excluded by the owner) is settled on documentary evidence. No run is blank.** As of 2026-08-21 07:52 UTC.

`a29f2b11` is the twentieth row and is deliberately not a reopen: the owner excluded it, and its
verdict is settled from documentary evidence instead — all four of its commits are on `origin/main`.

**The two scoreable findings, re-audited. These are the whole score, per § Verification — and both
are closed.**

| finding | state 2026-08-20 | state 2026-08-21, verified |
|---|---|---|
| `chat` `cez/b1684fe9` @ `2675cd16` — 8 files, +1000/−54, on no `main` | **NOT merged** | **LANDED** as `35d2e33e` — `origin/main`'s tip. The duplicate commit was *discarded*, not re-landed, because SPEC-528 had covered ~85% of it in parallel; only the genuine delta was pushed. `git cherry origin/main cez/b1684fe9` empty. |
| `cezar` `cez/7c2dd8f0` @ `ce6a5e14` — 561-line spec expansion, on no `main` | **NOT merged** | **LANDED** as `e916a211` — `origin/main`'s tip, confirmed by `git merge-base --is-ancestor` after a fetch. `git cherry origin/main cez/7c2dd8f0` empty. The agent rebased onto `origin/main` preserving `f9bcda42`'s amendment, ran typecheck green, proved the pre-existing test failures unrelated, and fast-forward pushed. `ce6a5e14` itself is correctly *not* an ancestor — the work was rescoped, not replayed. |

**So the sweep closed both known-unmerged findings, and neither was rounded up to `merged` on the
way.** Both came back `merged-now` with a named commit, and both commits verify independently
against `origin/main`. Every other run's work was already on `main` — which is the answer the owner
asked for, and it was not knowable before this sweep ran.

**One caveat on how the sweep ended, which must not be read as a failure.** Eleven of the nineteen
runs finished in **`waiting`**, not `done`: their agents answered, printed the verdict, and parked
awaiting a user rather than settling. Two ended `failed` on transport errors (§ above). **The
verdicts are unaffected — all 19 are present** — but the *runs* are not closed, so their worktrees
and branches are still on disk and their apply-backs have not run. Closing them is a board-hygiene
task, not an audit task, and it is deliberately out of this spec's scope: the ask was "analyze if
changes were merged, and if not do it now", and that is answered.

### What the sweep left on disk — measured, and it is the one real cost

Eleven runs ended in `waiting` and one `failed`, so most of the sweep's worktrees were never
applied back and removed. Counted across the 10 distinct repos immediately after the last verdict:

| | count |
|---|---|
| live `cez/*` worktrees | **107** |
| live `cez/*` branches | **117** (10 more than worktrees — `be31d9e9` leaked its branches when it `failed`) |
| real checkouts with any uncommitted change | **0 of 10** |
| conflict markers anywhere | **none** |
| disk under `*/.ai/cezar/worktrees` | **7.8 GB** (`chat` 4.0 G, `career` 2.5 G, `cezar` 1.4 G) |
| free on `/` | **129 GB of 150 GB** |

So the § Risks disk arithmetic held — "worst case if every tree leaked is ~6 GB" against 134 GB
free; the real figure is 7.8 GB against 129 GB, and it is **litter, not damage**: not one real
checkout was modified by the sweep, at any point, and every audit that had something to land landed
it through `origin/main` rather than through apply-back.

Cleaning it up means settling or cancelling the eleven `waiting` runs, which is board hygiene and
deliberately out of this spec's scope — cezar todo `4929b86c` (opened 2026-08-21 to carry exactly
this, superseding `4fc816ca`). Do not `git worktree remove` them by
hand while their runs are parked but resumable.

### How to finish (Wave D) — done, and how to re-derive it

Wave D is complete: the table above is the record. To re-derive it from the artifacts rather than
trusting this file:

```bash
T=.ai/cezar/tmp/c10864d1-5dd1-4c03-b1ea-5443838c7347
python3 $T/sweep-status.py          # one line per run: status, cost, verdict
python3 $T/render-table.py          # the markdown table above, regenerated
$T/pump-nudge.sh                    # idempotent; only if rows sit `queued` with free slots
```

**Do not re-fire any wave.** `appendReopenRequests` does not dedupe, so a second sweep double-files
every run. The one legitimate re-file is by **explicit run id**, for a continuation that crashed
before printing a verdict — which is exactly how `81345cea` was recovered after
`API Error: The response stopped arriving` (re-filed 07:44, answered 07:46, $1.24).

Carried to completion under cezar todo `033ccf08`, **closed 2026-08-21**: the table above holds
20 distinct runs, every one with a final status and a verdict, none left blank.

### Where the record went (step `document`, 2026-08-21)

Written the same session as the code, per the workspace rule that the repo and the record must not
drift. Four knowledge proposals on this run's `CEZ_KB_WRITE_FILE`, pending review
(`cez kb proposals`, run from the **real repo root** — see the caveat below):

| seq | scope | path | what it carries |
|---|---|---|---|
| 0 | project | `cezar/reopen-sweep-executed-2026-08-21.md` | the result, the $114.05 / mean-$6.00 cost datum, and the four defects the sweep measured |
| 1 | project | `cezar/reopen-verdict-collector-grep.md` | the anchored-grep trap and the working collector |
| 2 | workspace | `environment/agent-run-tmpdir-is-inside-the-git-checkout.md` | a run's `TMPDIR` sits inside the project checkout — 17 of 19 test failures |
| 3 | project | `cezar/reopen-sweep-execution-state.md` | **supersedes run `7aecd6a2`'s still-pending proposal at the same path**, whose heading claims only 1 of 19 runs was reopened |

Seq 3 is the one that needs care. Both proposals are *pending*, `applyKnowledgeProposals` is
per-run, and the reviewer chooses the order — so applying `7aecd6a2`'s **after** this one
reinstates the false heading. Carried as todo `648bbed4`; rejecting `7aecd6a2` seq 2 loses nothing,
because seq 3 preserves its full original text below the correction.

**Todos closed:** `9159228c` (this run's own brief), `3cd4adc4` (the sweep, whose summary still read
"the owner's ask is still unanswered"), `033ccf08` (Wave D collection), `4fc816ca` (Wave B gate
item 2, executed on `b63f15e4`). **Todos opened:** `4929b86c` (the worktree/branch litter),
`a8585eed` (`cez kb proposals` reads the worktree's non-existent `dataDir`, so it prints
"no pending proposals" from inside *any* task — indistinguishable from an empty queue, and it
briefly convinced this run its own proposals had been rejected), `648bbed4` (above). **Left open
deliberately:** `b6fbd608` (queue does not pump on a transition into `waiting` — diagnosed, not
fixed, because the fix is TypeScript and shipping it restarts the service) and `503195a8`
(lazy-context reopen loss).

**Not written:** the workspace corpus at `notion-export/` has no changelog entry and no
`domains/cezar.md` mention for any of this. That is not an oversight — the whole notion corpus is a
**read-only mount**, `applySupersede` refuses any target whose root is neither `project` nor
`workspace`, and no proposal can reach it. Todo `94230424` already carries that gap.

### How run `7aecd6a2` said to resume — kept for the record

> **Historical — the sweep is finished; do not run these.** Both `grep '^MERGE-VERDICT'`
> commands below are the anchored form corrected in § The collector: they match nothing, and in
> the last hours of run `7aecd6a2` that was indistinguishable from "no verdicts yet".

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
