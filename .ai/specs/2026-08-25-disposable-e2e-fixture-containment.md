# Disposable E2E Fixture Containment

- **Status:** **CORRECTED 2026-08-25:** P1 evidence preservation and P2 record work are complete
  in step 4/9. P0 containment, gate execution, commit, push, and deployment remain unexecuted by
  this run. The feature remains **QA Needed**, and the KB proposal remains pending corpus application.
  > **Original review status:** Spec revised 2026-08-25 after review (`CEZ:REVIEW=revise`). Nothing
  > here has been executed. This is step 2/9 of run `ae7bd42f-a399-4ceb-92cf-d657e620d80f`
  > (`spec-to-deploy`).
- **Date:** 2026-08-25
- **Brief:** `.ai/specs/briefs/2026-08-25-bulk-start-e2e-disposable.md` (KB `specs-b903eebc0533`),
  written by step 1 of this run. Read. Its judgement is sound; one of its central conclusions is
  superseded by evidence it did not have, and one citation needed re-pathing. Both corrected in
  § Measured facts.
- **Extends / does not reopen:** `.ai/specs/2026-08-24-bulk-start-filed-tasks.md` (the feature),
  shipped as `7932cf4d83ff6a4f263ae7181ec0d8e9fa81ea7f`, an ancestor of `origin/main` `d217ab2e`.
  The feature is not re-specified here.
- **Punctuation note:** this repository's specs use em dashes; the workspace doctrine forbids them
  in new writing. Every em dash below is inside a verbatim quotation of a string cezar itself emits
  or of an existing document. Nothing in this spec's own prose uses one.

---

## TLDR

**This task has no feature content. It is a disposable test fixture that escaped its own cleanup
and became a live nine-step production run.**

At 08:18:36 UTC today, run `480e0282`'s browser E2E created two throwaway todos titled
`E2E disposable: 480e0282 #1` and `#2`, started them through the new bulk-start button to prove the
feature works, and then tried to delete them. The todos were deleted. **The two runs were not.**
They are both `status: "running"` right now, each executing a full nine-step `spec-to-deploy` chain
against the real cezar repository. `ae7bd42f` (this run, `#1`) and `a3dd8f5f` (`#2`) are those two
runs. This spec was written by a test fixture.

The cleanup failed for one precise, cited reason: it addressed the runs through the **unscoped**
routes `POST /api/v1/runs/:id/cancel` and `DELETE /api/v1/runs/:id`, which `resolveProjectScope`
binds to the **boot project** (`workspace`, `/var/lib/cezar/workspace`) while the runs live in the
`cezar` project. Both routes answered `404 not found`, and the harness treats `404` as "already
gone". A `404` from the wrong address is not proof of deletion, and the harness had no way to tell
the two apart.

**Scope of this task, deliberately narrow.** Three things, none of which is a feature:

1. **Contain the two named runs by exact captured ID, through the scope that owns them.**
2. **Preserve the evidence** the failed E2E produced, so the outstanding QA is still diagnosable.
3. **Record the truth**: the production E2E ran, it failed, and the bulk-start feature stays
   **QA Needed**.

**This run cannot complete step 1 itself.** `ae7bd42f` is one of the two runs; a run cancelling
itself mid-step is not a controlled stop. **P0 must be executed by the owner or by a third run.**

**Everything that would change product behaviour is out of scope for this task** and is specified,
not built, under § Deferred scope. That covers the scope-correct browser harness, an additive
`scope` field on unscoped `404` bodies, and a fixture ledger plus reaper. Those are a separate
concern with their own compatibility surface, their own tests and their own risk; they get their
own filed todo and their own spec (P2 files it). The previous revision of this document authorised
them here, which turned an escaped-fixture incident into a new API, CLI and persisted-state
feature. That was wrong and is reversed.

---

## Problem

### 1. What actually happened, from the record

Reconstructed from `runs/*.ndjson`, `runs.json`, `todos.json` and `/api/v1/health`. Every timestamp
is UTC and taken verbatim from the files.

| Time | Event | Source |
| --- | --- | --- |
| 08:17:46 | `480e0282` launches the authenticated browser E2E | `runs/480e0282-….ndjson`, `text` |
| 08:18:36.052 / .591 | Todos `2d0b837a…` (`#1`) and `520e2bbe…` (`#2`) created via `cli-todo-add` | `.ai/cezar/todos.json:3696-3736` |
| 08:18:40.634 | Run `a3dd8f5f` created for `#2` | `runs.json` |
| 08:18:40.715 | `a3dd8f5f`: `run started — workflow "spec-to-deploy" (runner: claude)` | `runs/a3dd8f5f-….ndjson` seq 2 |
| 08:18:41.266 | Run `ae7bd42f` created for `#1`; `run.workflow.selected`, `stepCount: 9` | `runs/ae7bd42f-….ndjson` seq 1 |
| 08:18:5x | Harness cleanup runs: cancel, delete run, delete todo, assert ground truth | `.e2e-bulk-start.cjs` |
| 08:18:56.666 / .690 | Both todos tombstoned. **The todo half of cleanup worked.** | `todos.json:3714-3716, 3734-3736` |
| 08:19:07.298 | `The E2E failed at the post-start row-removal assertion, and its cleanup verification also found both disposable runs and todos still present.` | `runs/480e0282-….ndjson`, `text` |
| 08:19:46.339 | `the disposable runs belong to the project-scoped cezar context, while the cleanup used the unscoped run routes and treated their 404s as success. One run is queued and one is still active.` | ibid. |
| 08:20:17.651 | Agent reports the runs "now absent"; todos in a split state | ibid. |
| 08:20:47.391 / 08:20:53.041 | Blue-green release `20260825T082047Z-d217ab2e` built, then **activated**. cezar restarts. | `GET /api/v1/health` → `deploy` |
| 08:20:52.758 | `480e0282`: `cezar restarted — chain re-queued at step "merge"`. **The cleanup agent is killed mid-diagnosis.** | `runs/480e0282-….ndjson` |
| 08:20:52.844 | `ae7bd42f`: `cezar restarted — task re-queued` | `runs/ae7bd42f-….ndjson` seq 2 |
| 08:21:07.668 | `a3dd8f5f` re-started (`startedAt` in `runs.json`) | `runs.json` |
| 08:21:48.952 | `ae7bd42f`: `run started — workflow "spec-to-deploy" (runner: codex)` | `runs/ae7bd42f-….ndjson` seq 4 |
| 08:21:49.339 | `ae7bd42f` step 1 `context` begins. **This document is step 2.** | ibid. seq 7 |

Current state, re-measured while revising this document:

```
runs.json → ae7bd42f-a399-4ceb-92cf-d657e620d80f  status=running  task="E2E disposable: 480e0282 #1"
            a3dd8f5f-5d66-402e-b876-c1a6746d9da7  status=running  task="E2E disposable: 480e0282 #2"
```

Both hold a worktree (`.ai/cezar/worktrees/<id>/`), a branch (`cez/<short>`), and a live lease
(`.ai/cezar/worktree-leases/<id>.json`; both files present).

### 2. The defect that let it happen

`packages/cezar/src/server/server.ts:2097-2101` (read via `git show origin/main:`):

```ts
const resolveProjectScope = async (c, next) => {
  const raw = c.req.param('projectId');
  if (raw === undefined) {
    c.set('project', bootContext);
    return next();
  }
```

An unscoped request silently gets the **boot project**. On this box that is `workspace`
(`/api/v1/health` → `repo.root: "/var/lib/cezar/workspace"`, measured again while revising), and the
disposable runs live in `cezar` (`/var/lib/cezar/loki-labs/cezar`). So:

- `POST /api/v1/runs/<id>/cancel` (`server.ts:5192`) does `store.getRun(id)` against the
  **workspace** store, misses, and returns `404 {"error":"not found"}`.
- `DELETE /api/v1/runs/<id>` (`server.ts:5879-5888`) does the same and returns the same `404`.

And the harness (`.e2e-bulk-start.cjs`, untracked, in the `480e0282` worktree, 8171 bytes) accepts
both:

```js
if (![200, 404, 409].includes(res.status)) cleanupFailures.push(`cancel ${id}: ${res.status}`)
...
if ([200, 404].includes(res.status)) return true      // delete: 404 counted as done
```

**`404` was chosen to mean "already gone". It also means "not here".** Those are opposite facts and
the response body cannot distinguish them. The two-word error string is identical.

Proof that no cancel ever reached the run: `manager.cancel()` on a queued run writes a lifecycle
event (`packages/cezar/src/workflows/run.ts:3663-3671`):

```ts
this.store.updateRun(runId, { status: 'cancelled', finishedAt: … });
this.store.appendEvent(runId, { type: 'lifecycle', message: 'cancelled while queued' });
```

`ae7bd42f`'s event log goes seq 1 (`run.workflow.selected`, 08:18:41) straight to seq 2
(`cezar restarted — task re-queued`, 08:20:52). **There is no `cancelled while queued` event.** The
run was still `queued` when the process restarted, so boot recovery, which filters
`['queued','waiting','running']` (`run.ts:2279-2281`) and calls `reviveQueuedRun`
(`run.ts:2255-2262`), correctly put it back in the queue. The restart behaved exactly as designed.
The cleanup had already failed, three minutes earlier, in silence.

### 3. The second-order failure: cleanup is not restart-survivable

The agent *did* find the bug at 08:19:46 and started fixing it by hand. Thirty-five seconds after
its 08:20:17 progress note, its own chain's blue-green deploy activated and killed it
(`08:20:52.758 — cezar restarted — chain re-queued at step "merge"`). Everything it knew (which ids,
which scope, how far it had got) lived only in that process. The resumed chain restarted at step 1
and had no idea a cleanup was outstanding.

This is structural, not bad luck. In `spec-to-deploy`, the deploy phase and the E2E phase are
adjacent, and the deploy *causes a restart*. Any E2E cleanup holding state in process memory is one
`kill -9` from being lost, and the thing it was cleaning up is exactly the thing boot recovery
resumes. **This spec records that finding and defers the durable fix** (§ Deferred scope, D3). It is
the reason the containment runbook below is written to be re-runnable and idempotent rather than
one-shot.

### 4. Blast radius, because it is not one wasted run

Starting a filed todo mints the default workflow. Here that is `spec-to-deploy` with
`stepCount: 9` (`runs/ae7bd42f-….ndjson` seq 1). Two fixtures, both started, both resumed after a
restart: **eighteen agent steps**, two isolated worktrees, two branches, two leases, and two agents
with commit-and-push authorization on `origin/main` under `AGENTS.md:7`, all descending from a
one-line string typed by a test. Nothing bounds that today. There is no "disposable" concept
anywhere in the run model. That is a real gap and it is deferred, not denied.

---

## Measured facts, including a correction to the brief

1. **Implementation-base precondition, binding on every phase here and on every deferred phase.**
   This worktree is `b3d3a44c`; `git merge-base --is-ancestor 7932cf4d HEAD` **exits 1**. It does
   not contain the shipped feature, its spec, or the ship spec. Every code and spec citation in this
   document was read with `git show origin/main:<path>`. **Reading current code with `git show` does
   not make the stale working-tree files safe to modify.** Before any file in this repository is
   edited by this task or its follow-up, the executing step must be in a source tree containing
   current `origin/main` and must prove it:

   **CORRECTED on review: `--is-ancestor 7932cf4d HEAD` is the wrong assertion.** It proves only
   that one commit is reachable, which was already true of `origin/main` on 2026-08-24 and says
   nothing about the ~14 commits that landed after it. The tree must contain **current
   `origin/main`**, and only one command says that:

   ```bash
   git -C <tree> fetch origin main
   git -C <tree> merge-base --is-ancestor origin/main HEAD; echo "current_base_exit=$?"   # want 0
   ```

   A non-zero exit blocks the edit. Measured in this worktree at revision time: `HEAD` is
   `b3d3a44c`, `origin/main` is `d217ab2e`, and **both** spellings exit 1.

   **How the two uncommitted files get onto that base.** This worktree holds exactly two files
   that must survive: `.ai/specs/2026-08-25-disposable-e2e-fixture-containment.md` (this document)
   and `.ai/specs/briefs/2026-08-25-bulk-start-e2e-disposable.md`. Both are `git add`-ed and
   uncommitted (`git status --short` → two `A ` rows). Preferred path, in this worktree, before any
   other edit:

   ```bash
   git -C <tree> add .ai/specs/2026-08-25-disposable-e2e-fixture-containment.md \
                     .ai/specs/briefs/2026-08-25-bulk-start-e2e-disposable.md
   git -C <tree> commit -m "wip: containment spec + brief"     # temporary; squashed by P2's commit
   git -C <tree> fetch origin main
   git -C <tree> rebase origin/main
   git -C <tree> merge-base --is-ancestor origin/main HEAD; echo "current_base_exit=$?"   # want 0
   ```

   Fallback, if the rebase conflicts on anything: copy both files to the P1 destination
   (`/var/lib/cezar/e2e-artifacts/bulk-start-480e0282/`), cut a fresh worktree from `origin/main`,
   copy them back in, and continue there. Never edit the stale tree "just this once" and never
   resolve a conflict by taking the stale side. The same assertion is repeated in V2(a).
2. **The brief's spec citation needed re-pathing, and the specs are on `origin/main`.**
   `.ai/specs/2026-08-24-bulk-start-filed-tasks.md` and
   `.ai/specs/2026-08-24-ship-bulk-start-filed-tasks.md` (1330 lines) both exist on `origin/main`
   (`git ls-tree -r --name-only origin/main -- .ai/specs`). They are absent from **this** worktree
   only, because of fact 1. Cite them by repository path, not by a worktree path: a worktree path is
   reaped with the worktree. The ship spec's P5 recipe begins at `:803` on `origin/main`.
3. **The brief's conclusion, "the remaining work is production browser E2E plus cleanup", is
   superseded.** The E2E ran at 08:18 and its artifacts exist and are retained:
   `.ai/cezar/tmp/480e0282-…/e2e/{01-filed.png, 02-selected.png, 03-after-start.png,
   page@edf9250b5fc6b7f36362392d07941356.webm}`, 1.2 MB total, `cezar`-owned, all mtime 08:18
   (re-verified while revising). The E2E **failed** (at the post-start row-removal assertion) and its
   cleanup failed. The brief was written by an agent that could not see the sibling run's log.
4. **The feature itself is shipped.** `7932cf4d` (`feat: bulk start filed tasks
   (2026-08-24-bulk-start-filed-tasks)`, 2026-08-24 23:58:50 +0000) is an ancestor of `origin/main`
   (`d217ab2e`), and production is running `d217ab2e`. Do not re-implement, re-commit or re-deploy
   it. That part of the brief is correct and load-bearing.
5. **The row-removal assertion failure is a separate, unproven finding.** The E2E's step 10 (the two
   started rows leave the Filed board) failed. Whether that is a real UI defect or a consequence of
   the same project-scope confusion is **not determined here**, and this spec does not claim it
   either way. P2 files it as its own todo so it does not ride out of here inside a containment
   document.
6. **`GET /api/v1/workspace/runs-index` is a finder, not a census, so absence from it is not proof.**
   `server.ts:7174` sets `RUNS_INDEX_PER_PROJECT = 200`; `:7331` pushes a project id onto
   `truncated` when it contributed more, and `:7346-7352` returns
   `{runs, perProjectLimit, truncated, referenceStatuses}`. Its own doc comment (`:7167-7173`) says
   it is "a FINDER, not a listing". A run older than a project's newest 200 is simply not in the
   payload whether or not it exists. **Every "is it gone" assertion in this document therefore goes
   through the owning project's own route, never through the index.**
7. **No existing disposable-fixture convention exists.** Searched `.ai/specs/*.md` for `disposable`
   (six hits, none about test fixtures) and `packages/cezar/src` for `E2E disposable` (zero). The
   `E2E disposable: <runId> #<n>` title is a convention invented by the `480e0282` spec and used
   exactly once. It is, however, the only reason this incident was reconstructable at all.
8. **cezar is on the compatibility exception list.** `BACKWARD_COMPATIBILITY.md:5`: additive changes
   (new optional field, new flag, new route) are fine; making an existing output disappear is
   breaking. This task changes no output at all. The deferred work does, and § Deferred scope names
   the constraint each piece must satisfy.

### What could not be verified

- **Why the agent's 08:20:17 note said the runs were "now absent."** The event log proves no cancel
  landed on `ae7bd42f` in the scope that owns it. The most likely reading is that it re-queried a
  surface that did not contain them, but the tool output that would settle it is not in the
  transcript. Recorded as an open question, not as a finding.
- **The `cezar` project's registry id was not read.** `GET /api/v1/projects` requires a session and
  this step holds none (measured: `{"error":"unauthenticated"}` on loopback). The evidence in
  `runs/480e0282-….ndjson` names the scope as `cezar`. **P0 resolves it from the registry rather
  than trusting that string**, because addressing the wrong scope is the entire bug.
- **Nothing was executed for this spec.** No gate was run, no process stopped, no file outside this
  one changed. P0 is the first thing that touches state.

---

## Solution

Three phases, all containment, evidence and record. Each ends somewhere safe to stop.

Two rejected alternatives, named so they are not re-proposed:

- **"Make the E2E not start real runs."** Rejected: the whole point of the E2E is that clicking
  **Run 2 tasks** creates two real runs. A fixture that does not start anything proves nothing.
  Contain the blast radius; do not remove the thing under test.
- **"Stop boot recovery from reviving fixture runs."** Rejected: recovery is correct and is
  load-bearing for every real interrupted run (`run.ts:2284-2288` doc comment: a queued record with
  no work item behind it "is the worst failure this engine has"). The defect is upstream, in a
  cleanup that never cancelled anything.

And one alternative rejected **on review of the previous revision of this document**:

- **"Fix the class of bug here, while we are in it."** Rejected. The task is an escaped fixture. The
  harness rewrite, the `404` body change and the ledger plus reaper are three separate changes to
  three separate surfaces, two of them with published compatibility contracts and one of them
  destructive. Bundling them behind a containment runbook means the containment cannot ship until
  all three are reviewed. They are fully specified in § Deferred scope and filed as their own todo.

---

## Architecture

### The invariant this restores

> **A cleanup is complete when the resource is observably absent, asked of the scope that owns it.
> Never when a route returned a status code that is compatible with success, and never when a
> capped, explicitly-truncatable finder failed to mention it.**

Three consequences, and only the first is in scope for this task:

1. **Address by scope, and verify by scope.** Every mutation and every check goes to
   `/api/v1/p/:projectId/…` with `:projectId` resolved from the registry. The proof that a run is
   gone is `GET /api/v1/p/:projectId/runs/:id` → `404` **from the owning project**, plus the absence
   of its worktree, lease and branch on disk. A `404` from a scope that never owned the run proves
   nothing, which is exactly what happened at 08:18.
2. **`GET /api/v1/workspace/runs-index` is for discovery only** (fact 6). Use it to *find* candidate
   fixture rows across projects. Never cite it as evidence of absence, and when you do read it,
   read `truncated` in the same breath: a non-empty `truncated` means the payload is admittedly
   incomplete for those projects.
3. **Making a wrong-address answer legible** is the durable fix and is deferred (D2).

### What this task does not change

No route, no response body, no schema, no CLI surface, no persisted state format.

**File inventory, corrected on review.** This task's single session commit contains **four
repository documents**, and nothing else:

| Path | State | Phase |
| --- | --- | --- |
| `.ai/specs/2026-08-25-disposable-e2e-fixture-containment.md` | new (this document) | written here, committed by P2 |
| `.ai/specs/briefs/2026-08-25-bulk-start-e2e-disposable.md` | new (the brief) | written by step 1, committed by P2 |
| `.ai/specs/2026-08-24-bulk-start-filed-tasks.md` | corrected in place | P2(a) |
| `.ai/specs/2026-08-24-ship-bulk-start-filed-tasks.md` | corrected in place | P2(b) |

The first two are currently uncommitted in `ae7bd42f`'s worktree and are destroyed with it — see
Measured fact 1 for how they are carried onto a current `origin/main` base, and P0's ordering rule
for why that must happen before `ae7bd42f` is deleted.

**The knowledge NDJSON proposal is not a repository file.** `CEZ_KB_WRITE_FILE` points at
`.ai/cezar/runs/ae7bd42f-….knowledge.ndjson`, inside `.ai/cezar/`, which `ensureDataGitignore`
ignores (`packages/cezar/src/index.ts:1374-1381`). It is runtime state, it cannot be committed, and
`git status` must not show it. The previous revision counted it as a third edited file; that was
wrong.

The commit carries **no stale-tree deletions and no unrelated differences**. Verify with
`git show --stat HEAD` before pushing: exactly four paths, two added and two modified. A diff that
deletes files which exist on `origin/main` means the tree is still the stale one and the rebase in
Measured fact 1 did not happen.

---

## Data models and API contracts

This task introduces **no new contract**. It consumes existing ones, all read from `origin/main`:

| Surface | Used for | Citation |
| --- | --- | --- |
| `GET /api/v1/projects` | resolve the owning project id from the repo root | brief; `agent-browser.ts:74-80` uses the same route for `bootProject` |
| `POST /api/v1/p/:projectId/runs/:id/cancel` | stop a fixture run in its own scope | `server.ts:5192` (project-scoped mirror of the unscoped spelling) |
| `GET /api/v1/p/:projectId/runs/:id` | **the absence proof**: `200` while it exists, `404` once deleted | `server.ts:5116` |
| `DELETE /api/v1/p/:projectId/runs/:id` | remove it; `409` while it is still draining | `server.ts:5879-5888` |
| `GET /api/v1/workspace/runs-index` | **discovery only**, never proof (fact 6) | `server.ts:7276-7352` |

**Why the scoped spellings are guaranteed to exist.** `route-parity.test.ts` iterates
`projectRouteManifest` (derived from the app's real registrations, so it cannot drift) and asserts
that `/api/v1<path>`, `/api/v1/p/<bootId><path>` and `/api/v1/p/default<path>` answer
**byte-identically** for every mirrored project route. So every unscoped run route above has a
`/p/:projectId` twin by construction, and that twin is the correct address.

---

## Phases

### P0: Contain the two live runs by exact captured ID *(runbook only, no code; P0a now, P0b last)*

The two fixture runs are burning agent steps while this is read. This phase changes no repository
file. It is idempotent and re-runnable, deliberately, because the last cleanup died mid-flight.

**CORRECTED on review: P0 cannot run first, and it cannot run as one step.** `DELETE
/runs/:id` is not a bookkeeping delete. Measured on `origin/main`:

- `server/server.ts:5879-5888` calls `removeWorktree(repoRoot, run.worktreePath, run.branch)` — the
  run's **worktree directory and its branch go with it**.
- `runs/store.ts:1364-1379` (`RunStore.deleteRun`) then `rmSync`s the run's **events NDJSON, its
  handoff file, and its images directory**.

`ae7bd42f`'s worktree is where this spec and its brief currently live, uncommitted (§ What this
task does not change). Deleting `ae7bd42f` now destroys both documents and this run's handoff
before P1 or P2 can preserve or commit anything. So containment splits:

**P0a — `a3dd8f5f-5d66-402e-b876-c1a6746d9da7`, immediately.** Nothing in this task depends on its
worktree, handoff or branch. Contain it now, on its own, ahead of everything else.

**P0b — `ae7bd42f-a399-4ceb-92cf-d657e620d80f`, LAST.** Cancel and delete it only after **all** of
the following have completed:

1. P1 has copied all five evidence files to the destination and V1 passed.
2. The spec and brief are on a tree containing current `origin/main` (Measured fact 1).
3. P2's record corrections, KB proposal and follow-up todos are done.
4. The five-command gate is green (see § Verification).
5. The single session commit exists and is **pushed to `origin main`**.
6. The `deploy` step has been reached. Per `AGENTS.md:16` and `.ai/deploy-targets.json`, both
   targets are `"manual": true` since commit `c328ec06`, so an agent-run `spec-to-deploy` on cezar
   **parks** at that step with a manual-deployment handoff. That parked state is the expected
   terminal state, not a failure, and it does not block P0b.

**Who performs P0b: the owner, or a separate cezar run in the `cezar` project — never `ae7bd42f`
itself.** A run cannot cancel and delete itself: the cancel kills the process mid-request and the
delete removes the tree it is executing in. This is the one genuinely blocking dependency in this
document, and it is external by construction.

**This task is QA Needed until V0 confirms P0b.** Nothing in it may be reported as Done on the
strength of the commit alone; the fixture is contained when V0 exits 0 for both IDs, run by whoever
performed P0b.

**Cleanup is by captured ID. Never by title matching.** This preserves the rule already recorded in
the ship spec's P5 recipe (cleanup "bounded to the recorded fixture IDs, never a broad delete",
brief § What the record already decided). The two IDs are:

```
ae7bd42f-a399-4ceb-92cf-d657e620d80f    # E2E disposable: 480e0282 #1  (this run)
a3dd8f5f-5d66-402e-b876-c1a6746d9da7    # E2E disposable: 480e0282 #2
```

These two are the **explicit-ID exception**: they predate any fixture ledger, so there is no
recorded fixture list to read them from. They are named here, in the spec, by hand, once.

**CORRECTED on review: every check below is enforced, not printed.** The previous revision's
runbook echoed status codes into a terminal with `# want 200` beside them and continued regardless.
Under `set -e` that is not a guard — a `401` from an expired session, a `404` from the wrong scope
and a `5xx` from a half-restarted server all read as "kept going". Nothing here prints an
expectation it does not also assert.

Save as `p0-contain.sh` and run it with **one** run id per invocation (`./p0-contain.sh <runId>
<expected task string>`), so P0a and P0b are literally separate executions:

```bash
#!/usr/bin/env bash
set -euo pipefail

BASE=http://127.0.0.1:4321
S=${CEZ_SESSION:?export CEZ_SESSION=<a valid cez_session>}   # ship spec P5 for how one is minted
ROOT=$(realpath /var/lib/cezar/loki-labs/cezar)              # canonical: the registry stores realpaths
RUN=${1:?run id}
WANT_TASK=${2:?expected task string}

die() { echo "STOP: $*" >&2; exit 1; }

# body -> $1, status -> stdout. -sS so a transport failure is loud; no -f, because we branch on codes.
http() { # http <outfile> <method> <url>
  curl -sS -o "$1" -w '%{http_code}' -X "$2" -b "cez_session=$S" "$3" \
    || die "curl transport failure: $2 $3"
}

# ---- 1. Resolve EXACTLY ONE registry project for the canonical root ----------------------------
PJ=$(mktemp)
code=$(http "$PJ" GET "$BASE/api/v1/projects")
[ "$code" = 200 ] || die "GET /api/v1/projects -> $code (401 = the session is not valid; fix it, do not proceed)"
n=$(jq --arg r "$ROOT" '[.projects[] | select(.root == $r)] | length' "$PJ") \
  || die "GET /api/v1/projects returned a body jq could not parse"
[ "$n" = 1 ] || die "expected exactly 1 registry project with root=$ROOT, got $n — guessing the scope IS the bug"
PROJECT=$(jq -r --arg r "$ROOT" '.projects[] | select(.root == $r) | .id' "$PJ")
[ -n "$PROJECT" ] || die "resolved an empty project id"
echo "scope: $PROJECT ($ROOT)"

# ---- resource checks, called from two places --------------------------------------------------
verify_resources() {
  local id8=${RUN%%-*}
  test ! -e "$ROOT/.ai/cezar/worktrees/$RUN"            || die "$RUN: worktree still present"
  test ! -e "$ROOT/.ai/cezar/worktree-leases/$RUN.json" || die "$RUN: lease still present"
  [ -z "$(git -C "$ROOT" branch --list "cez/$id8*")" ]  || die "$RUN: branch cez/$id8* still present"
  [ "$(find /var/lib/cezar -not -user cezar | wc -l)" = 0 ] || die "non-cezar-owned files under /var/lib/cezar"
  echo "$RUN: resources clean (worktree, lease, branch, ownership)"
}

# ---- 2. Prove this scope owns THIS run, and that it is the fixture, before mutating ------------
B=$(mktemp)
code=$(http "$B" GET "$BASE/api/v1/p/$PROJECT/runs/$RUN")
case "$code" in
  200) ;;
  404) echo "$RUN: already absent from $PROJECT — skipping cancel and delete"
       verify_resources; exit 0 ;;                      # a 404 HERE branches straight to resources
  401) die "$RUN: 401 — session invalid" ;;
  *)   die "$RUN: GET -> $code (unexpected; 5xx means the server is not healthy enough to contain anything)" ;;
esac
jq -e --arg id "$RUN" --arg t "$WANT_TASK" '.id == $id and .task == $t' "$B" >/dev/null \
  || die "$RUN: identity mismatch — id=$(jq -r '.id // "?"' "$B") task=$(jq -r '.task // "?"' "$B"); refusing to mutate"
echo "$RUN: confirmed in $PROJECT as \"$WANT_TASK\""

# ---- 3. Cancel, in scope. Validate the status AND the body. -----------------------------------
C=$(mktemp)
code=$(http "$C" POST "$BASE/api/v1/p/$PROJECT/runs/$RUN/cancel")
[ "$code" = 200 ] || die "$RUN: cancel -> $code"
jq -e 'has("cancelled") and (.cancelled | type == "boolean")' "$C" >/dev/null \
  || die "$RUN: cancel body malformed: $(cat "$C")"
# cancelled:false is legal — it means the manager held no active work item. The delete and the
# final 404 are what settle it, not this flag. (server/server.ts:5192-5209)
echo "$RUN: cancel returned cancelled=$(jq -r .cancelled "$C")"

# ---- 4. Delete, polling through the 409 (`run is active — cancel it first`) --------------------
#      Bounded poll on the CONDITION, never a guessed sleep. 2s interval, 120s deadline.
#      A 404 here is accepted ONLY because step 2 already proved this same scope owned the run.
deadline=$((SECONDS + 120))
while :; do
  D=$(mktemp)
  code=$(http "$D" DELETE "$BASE/api/v1/p/$PROJECT/runs/$RUN")
  case "$code" in
    200|404) break ;;
    409) : ;;
    *)   die "$RUN: delete -> $code" ;;
  esac
  [ "$SECONDS" -lt "$deadline" ] || die "$RUN: delete timed out after 120s, last=$code"
  sleep 2
done
echo "$RUN: delete -> $code"

# ---- 5. THE PROOF: exactly 404 from the scope that owned it ------------------------------------
code=$(http /dev/null GET "$BASE/api/v1/p/$PROJECT/runs/$RUN")
[ "$code" = 404 ] || die "$RUN: after delete the scoped GET -> $code (want exactly 404)"
echo "$RUN: gone (scoped GET = 404)"

verify_resources
```

Invocations, in this order and never merged:

```bash
export CEZ_SESSION=<a valid cez_session>
./p0-contain.sh a3dd8f5f-5d66-402e-b876-c1a6746d9da7 'E2E disposable: 480e0282 #2'   # P0a, now
./p0-contain.sh ae7bd42f-a399-4ceb-92cf-d657e620d80f 'E2E disposable: 480e0282 #1'   # P0b, LAST, external
```

The expected task strings are the runs' **`task`** field, measured in `runs.json` at revision time.
Their `title` fields carry the chain-position prefix (`1: E2E disposable: 480e0282 #1`) and are
deliberately not what the guard compares.

**Discovery sweep, separate and non-authoritative.** After the two named IDs are provably gone, look
for any *other* fixture row the same incident may have left, then verify each candidate the same
way, by ID, in its own scope:

```bash
curl -sf -b "cez_session=$S" "$BASE/api/v1/workspace/runs-index" | jq '{
  candidates: [.runs[] | select((.task // "") | startswith("E2E disposable: ")) | {id, projectId, status}],
  truncated: .truncated, perProjectLimit: .perProjectLimit }'
```

An empty `candidates` list with a **non-empty** `truncated` is not a clean result; it is an
incomplete one (fact 6). Say so rather than reporting zero.

The two todos are already tombstoned (`todos.json:3714-3716, 3734-3736`); do not re-delete them.

**P0a done when:** `./p0-contain.sh a3dd8f5f-… 'E2E disposable: 480e0282 #2'` exits `0`, and the
outcome is written to this spec's § Status log.

**P0b done when:** `./p0-contain.sh ae7bd42f-… 'E2E disposable: 480e0282 #1'` exits `0`, run by the
owner or a third run after all six preconditions above hold, the discovery sweep is either empty
with `truncated: []` or reported as incomplete, and the outcome is written to § Status log. Until
that exit code exists, this task is **QA Needed**, not Done.

### P1: Preserve the evidence *(stop-safe: read-only plus one copy)*

The failed E2E's artifacts are the only proof of what the bulk-start UI actually did, and the
harness is the only artifact of how the cleanup was written. Both currently live inside
`480e0282`'s disposable worktree tree, which is reapable.

Re-verified while writing this document, all `cezar`-owned, all mtime 08:18:

```
.ai/cezar/tmp/480e0282-…/e2e/01-filed.png                                   183929 B
.ai/cezar/tmp/480e0282-…/e2e/02-selected.png                                179524 B
.ai/cezar/tmp/480e0282-…/e2e/03-after-start.png                             179700 B
.ai/cezar/tmp/480e0282-…/e2e/page@edf9250b5fc6b7f36362392d07941356.webm     731839 B
.ai/cezar/worktrees/480e0282-…/.e2e-bulk-start.cjs                            8171 B
```

`.ai/cezar/tmp/` and `.ai/cezar/worktrees/` are both in `ensureDataGitignore`'s `wanted` array
(`packages/cezar/src/index.ts:1374-1381`), so **neither can be committed** and neither survives a
worktree reap.

**The destination is chosen here, not at implementation time:**

```
/var/lib/cezar/e2e-artifacts/bulk-start-480e0282/
```

`/var/lib/cezar/e2e-artifacts/` already exists — measured `drwx------ cezar cezar`, created
2026-08-21, currently holding eight deploy-probe artifacts. It is outside every run's tree, outside
every git repo, and already the convention for exactly this. No new root is invented.

```bash
SRC_TMP=/var/lib/cezar/loki-labs/cezar/.ai/cezar/tmp/480e0282-a967-4936-a12e-3c4e56450586/e2e
SRC_WT=/var/lib/cezar/loki-labs/cezar/.ai/cezar/worktrees/480e0282-a967-4936-a12e-3c4e56450586
DEST=/var/lib/cezar/e2e-artifacts/bulk-start-480e0282

mkdir -p "$DEST"                                    # as cezar, never as root, never root-then-chown
cp -p "$SRC_TMP"/01-filed.png "$SRC_TMP"/02-selected.png "$SRC_TMP"/03-after-start.png \
      "$SRC_TMP"/'page@edf9250b5fc6b7f36362392d07941356.webm' "$DEST"/
cp -p "$SRC_WT"/.e2e-bulk-start.cjs "$DEST"/
```

**Copy, never move** (a move destroys the original if it is interrupted), and **do not commit them**
— the destination is deliberately outside the repository.

**Ordering, and it is load-bearing:** all five files must be at `$DEST` and V1 must have passed
**before any source run or worktree is deleted**. `DELETE /runs/:id` removes the run's worktree
(`server/server.ts:5879-5888`), so containing `480e0282` — or reaping its tree under the keep-last-N
retention rule — takes `.e2e-bulk-start.cjs` with it. P1 therefore runs **first**, ahead of P0a.

**Done when:** all five files exist at `/var/lib/cezar/e2e-artifacts/bulk-start-480e0282/` with
matching byte counts (V1), and `find /var/lib/cezar -not -user cezar | wc -l` is `0`.

### P2: Correct the record and file the follow-ups *(stop-safe: last phase)*

Requires the fact-1 ancestry check to pass before any spec file is edited.

**a. Correct the feature spec, in place, at the exact existing text.** On `origin/main`,
`.ai/specs/2026-08-24-bulk-start-filed-tasks.md` § Verification is a five-item numbered list at
`:61-71`. The production E2E is **item 5**, verbatim:

> `5. On production, select two disposable filed tasks, run the batch, verify both runs appear and the`
> `   browser remains on `/tasks`, then cancel or clean up the disposable runs.`

There is **no** `Runtime E2E (pending)` heading anywhere in that file; the previous revision of this
document cited one and cited item 4 (which is the deploy-probe package suite). Both were wrong.
Add a dated `**CORRECTED 2026-08-25:**` lead-in to item 5 and leave the original text below it
unchanged, per the correction doctrine: the E2E ran on 2026-08-25 at 08:18, its artifacts are at
`/var/lib/cezar/e2e-artifacts/bulk-start-480e0282/`, it **failed** at the post-start row-removal
assertion, its cleanup failed and left two live runs, and the feature therefore remains
**QA Needed**.

**b. Same treatment for the ship spec.** `.ai/specs/2026-08-24-ship-bulk-start-filed-tasks.md` § P5
(`:803` on `origin/main`) reads as a recipe that works. Mark it corrected at the same date: the
recipe's cleanup used the unscoped run routes and treated their `404`s as success, which is the
defect this document exists for. Name the scoped spellings as the replacement so the reader knows
where to look next.

**c. Propose the knowledge note, do not write the corpus.** Append **one** `upsert` proposal to
`CEZ_KB_WRITE_FILE`
(`.ai/cezar/runs/ae7bd42f-a399-4ceb-92cf-d657e620d80f.knowledge.ndjson`; the file does not exist
yet, so the first line is `seq: 0`). The general lesson: *an unscoped `404` means "not here", not
"gone", because `resolveProjectScope` binds an unscoped request to the boot project.*

```jsonc
{"op":"upsert","scope":"project","path":"knowledge/notes/unscoped-404-means-not-here.md",
 "title":"An unscoped cezar 404 means \"not here\", not \"gone\"","type":"note",
 "tags":["cezar","testing","verification-doctrine"],
 "body":"…","seq":0,"runId":"ae7bd42f-a399-4ceb-92cf-d657e620d80f","createdAt":"2026-08-25T…Z"}
```

**Do not edit the mounted corpus directly and do not run `cez kb reindex` for it.** A proposal is
reviewed and applied later, through the cockpit or `cez kb proposals`. **Corpus sync stays PENDING**
until that proposal is applied and `cez kb search` finds the note; report it as pending, by name, in
the handoff.

**d. File two follow-up todos.** Neither is done by this task.

```bash
cezar todo add "Bulk-start Filed board: started rows do not leave the board (E2E step 10)" \
  --context "Measured 2026-08-25 by run 480e0282's browser E2E. Unproven whether this is a real UI
defect or a consequence of the project-scope confusion in .ai/specs/2026-08-25-disposable-e2e-fixture-containment.md.
Artifacts at /var/lib/cezar/e2e-artifacts/bulk-start-480e0282/." \
  --acceptance "The E2E's post-start row-removal assertion passes, or the assertion is proved wrong and corrected."

cezar todo add "Scope-correct disposable E2E fixtures: harness, legible 404, fixture ledger" \
  --spec .ai/specs/2026-08-25-disposable-e2e-fixture-containment.md \
  --context "The Deferred scope section of that spec (D1/D2/D3) is the input. It needs its own spec
before code: three surfaces, two with published compatibility contracts, one destructive."
```

**Done when:** both spec corrections are in place on a tree that passed the fact-1 ancestry check,
the NDJSON proposal is appended and valid, both todos exist, and corpus sync is reported as pending.

---

## Deferred scope

**Not built by this task.** Specified here because the analysis is done and would otherwise be lost,
and because the review of the previous revision found real defects in each design that must not be
re-introduced. P2(d) files these as one todo, which needs its own spec before any code.

### D1: A scope-correct browser harness

Promote `.e2e-bulk-start.cjs` from an untracked script in a disposable worktree to a tracked suite
under `packages/web/e2e/`, following the disposable-fixture precedent the brief cites
(`packages/web/e2e/backlog-composer.e2e.ts:53-143`: isolated `CEZ_HOME`, temporary repos, a dry-run
server, screenshots, unconditional teardown) and the `.ai/scripts/e2e.sh:1-13` exit-code contract
(`0 + passed`, `0 + skipped`, `non-zero + failed`).

**The design decision the follow-up spec must make first, because the previous revision got it
wrong.** `packages/web/e2e/agent-browser.ts` exports `AgentBrowser`, whose entire surface is
`open/goto/snapshot/text/url/isVisible/count/waitForFunction/press/fill/tapAt/dragTo/evaluate/
setViewport/click/hover/screenshot/close` (read from `origin/main`). **There is no response-event
API, no cookie API and no video recording.** So a harness cannot both "follow `agent-browser.ts`"
and keep the original's `page.on('response')` capture, cookie injection and WebM recording. Pick one:

- **(a) Raw Playwright**, at the Node API level, as `480e0282`'s harness already did. Keeps
  `page.on('response')` (the ship spec's `:1092` risk mitigation: register the handler **before**
  the click, push each run id inside the handler), keeps cookie injection, keeps video. Does not
  reuse `AgentBrowser`.
- **(b) `AgentBrowser` plus scoped API observation.** Capture the created run IDs by polling
  `GET /api/v1/p/:projectId/runs` around the click instead of by listening for the `201`s. Loses
  video; loses the exact-response guarantee; gains the shared provider setup. Only viable if the
  follow-up spec can show the poll cannot miss or misattribute a run.

Non-negotiable regardless of choice, each traceable to a measured failure:

1. **Resolve the project id from the start response and use it in every mutation.** The response
   the fixture already reads is `POST …/p/<projectId>/todos/<id>/start`; keep that `projectId`
   beside the run id and address `/api/v1/p/<projectId>/runs/<runId>/…` thereafter.
2. **Never accept `404` as evidence of deletion.** A `404` is terminal only from a scope that
   previously answered `200` for that id. Otherwise it is a cleanup failure and is reported.
3. **Prove absence through the owning scope's own route**, per the invariant. `runs-index` is
   discovery only.
4. **Keep what the original got right:** ground truth asserted while still authenticated,
   `destroySession` last, artifacts to an absolute path outside any worktree, `browser.close()` in a
   `finally` (ship spec risks `:1091-1093`).

**A dry-run `test-env-up.sh` pass is not the outstanding production E2E** and must not be reported
as one. The feature spec's Verification item 5 says "On production". A green suite against an
isolated dry-run environment is a regression test for the harness; the production run is a separate,
still-outstanding obligation.

### D2: Make an unscoped `404` name its scope

The idea: `POST /api/v1/runs/:id/cancel` and `DELETE /api/v1/runs/:id` answer
`{"error":"not found","scope":"<resolved project id>"}` instead of `{"error":"not found"}`, so
"not here" becomes distinguishable from "gone".

**Three constraints the previous revision violated. Any follow-up spec must satisfy all three or
drop the phase.**

1. **The field cannot be unscoped-only.** `route-parity.test.ts` asserts that `/api/v1<path>`,
   `/api/v1/p/<bootId><path>` and `/api/v1/p/default<path>` answer **byte-identically** for every
   mirrored project route. A `scope` key present on one spelling and absent on the other two fails
   that guard by construction. Add it to **every** spelling, populated from the resolved
   `ProjectContext.id`, so all three stay identical and each one is self-describing.
2. **It must be declared in `packages/contract`** (`packages/contract/src/runs.ts` is the relevant
   module) with bidirectional contract-parity coverage, following the pattern
   `contract-parity.runs.test.ts` already uses. `contract-parity.cluster.test.ts:44-49` records why
   the assertions must be **mutual**: one-way assignability passes on a schema that is merely wider.
3. **Decide how a caller receives it.** `packages/web/src/api/client.ts:216-246` defines `ApiError`
   with an explicit `extras` whitelist (`manual`, `command`, `exists`, `identityGate`, `cause`).
   **Any other field, including `scope`, is discarded.** Shipping the field without widening
   `ApiError` gives the cockpit nothing; it would be legible only in a raw `curl` or a server log.
   Either widen `ApiError` in the same change or state plainly that the field is for operators only.

**Correction to a route name.** The previous revision proposed extending the change to a sibling
`DELETE /api/v1/runs/:id/worktree`. **That route does not exist.** `origin/main` has
`POST /runs/:id/remove-worktree` (`server.ts:5868`). Use the real name if it is in scope.

**Explicitly not proposed:** cross-project run lookup on the boot context, so that an unscoped
`DELETE` finds and deletes a run in another project. That would make the unscoped route silently
authoritative across scopes, a larger security and correctness surface than the bug justifies, and
it would reward exactly the addressing mistake this document exists to make visible.

### D3: A fixture ledger and a reaper

The durable answer to § Problem 3: a fixture's identity written to disk **before** it is started and
cleared **only** after verified cleanup, so a cleanup killed by a deploy restart is finishable by
the next invocation instead of lost with the process.

**A discriminated state model, not one object with optional fields.** The previous revision's single
shape required `todoId` and `runIds` while also requiring a `pending` record to be written *before*
the todo exists. That is unwritable. The `pending` form must be legal before allocation; the
`started` form must require what allocation produced:

```ts
type FixtureRecord =
  | { state: 'pending';  id: string; label: string; ownerRunId: string; projectId: string; createdAt: string }
  | { state: 'started';  id: string; label: string; ownerRunId: string; projectId: string; createdAt: string;
      todoId: string; runIds: [string, ...string[]]; startedAt: string }
  | { state: 'reaped';   id: string; label: string; ownerRunId: string; projectId: string; createdAt: string;
      todoId: string; runIds: string[]; reapedAt: string };
```

`pending` → `started` → `reaped`, one direction only. `reaped` is written **only** after the
scope-correct absence proof passes. A crash leaves `started`, which is precisely the signal the next
run needs.

**Fail closed on corruption. Never degrade to empty.** The previous revision specified "a corrupt or
absent file degrades to empty rather than throwing", which silently forgets live fixtures and then
permits more to be created. Split the two cases:

- **Absent** may mean empty. That is the zero-config default and is safe.
- **Present but malformed** must **fail closed**: preserve the bad file untouched (rename to
  `e2e-fixtures.json.corrupt-<seq>`), refuse to create new fixtures, and refuse to reap anything
  destructively. A safety ledger that cannot be read is not a permission to proceed.

**Writes are atomic**: write `e2e-fixtures.json.tmp`, `fsync`, `rename` over the target, matching
the tmp+rename pattern `RunStore` already uses for `runs.json`. **Add both `e2e-fixtures.json` and
`e2e-fixtures.json.tmp` to `ensureDataGitignore`'s `wanted` array**
(`packages/cezar/src/index.ts:1374-1403`), alongside the `runs.json` / `runs.json.tmp` and
`todos.json` / `todos.json.tmp` pairs already there. Run state must not enter the user's history.

**The reaper: ledger-backed exact IDs are authoritative; the title prefix is a warning, not a
target.** This preserves the rule already in the record (P0 above; the ship spec's P5 recipe). The
previous revision's contract said every prefix match is deleted while its own Risks section claimed
non-ledger rows are cross-checked; those contradict, and the destructive reading is the one that
would have shipped.

- **Deletes** exactly the run and todo IDs recorded in `started` ledger entries, each through its
  own `projectId`, each proved absent through that scope's own route.
- **Reports, and never deletes,** anything matching the reserved title prefix `E2E disposable: `
  that has no ledger entry. That is a validation signal ("a fixture escaped the ledger"), and it
  exits non-zero so a human looks. Today's two orphans are exactly that case, and they are handled
  by P0's hand-written explicit-ID exception, not by a prefix sweep.
- `--dry-run` prints the plan and changes nothing, and is the documented first step.

**How the command reaches the live server, which the previous revision did not specify at all.** It
must **not** open a second `RunStore` beside the running service. `openStore()`
(`packages/cezar/src/index.ts:1366-1371`) calls `RunStore.open(dataDir)` **without** `keepLive`, and
`reconcileLoadedRun` (`packages/cezar/src/runs/store.ts:717-744`) then marks every `queued` /
`running` / `waiting` row **failed**, because "one-shot CLI paths that never recover" must not leave
ghosts. Pointing that at a live root would mark every in-flight run on the box as failed. So the
follow-up spec must specify:

- **Authenticated loopback HTTP** against the running cockpit, using the existing local-CLI
  credential path (`packages/cezar/src/server/launch-key.ts`), so the live `RunManager` performs the
  cancel and the delete.
- **Server discovery**: how the base URL is found, and what happens when no server is running.
  Failure behaviour must be an explicit non-zero "no cockpit reachable, nothing reaped", never a
  silent fallback to direct store mutation.
- **Project resolution**: `projectId` comes from the ledger entry, and is re-validated against
  `GET /api/v1/projects` before any mutation.

---

## Risks

- **P0 cannot be run by this run.** `ae7bd42f` cancelling `ae7bd42f` is an uncontrolled stop
  mid-step. Escalate to the owner or a third run. Left unmitigated, both fixtures keep consuming
  agent steps. This is the highest-cost item in the document and the cheapest to fix.
- **P0's session.** Every route it uses needs a `cez_session`; loopback without one answers
  `{"error":"unauthenticated"}` (measured). An unauthenticated sweep would make every check "fail"
  by being blind, which is a variant of the same bug. The runbook stops if the project resolve
  returns empty, which is the first thing an unauthenticated session breaks.
- **The two IDs are hand-written in this document.** A typo deletes the wrong run. Step 2 of the
  runbook (`GET` → `200` before mutating) is the guard, and it is not optional.
- **P1 copies rather than moves.** A move would destroy the only evidence if interrupted. The cost
  is 1.2 MB of duplication, which is the correct trade.
- **P2 edits specs on a tree that may be stale.** Fact 1's ancestry check is a hard precondition, not
  advice. Editing `.ai/specs/2026-08-24-bulk-start-filed-tasks.md` in *this* worktree would create a
  file that does not exist here and silently diverge from `origin/main`.
- **Corpus sync will remain pending at the end of this task.** The proposal path is review-gated by
  design. Reporting it as done because the NDJSON line was appended would repeat, in the record, the
  exact failure this document is about: an operation that returned successfully and changed nothing.
- **Fixing containment does not make the feature verified.** The bulk-start E2E still fails at its
  post-start row-removal assertion. Nothing here entitles anyone to mark
  `.ai/specs/2026-08-24-bulk-start-filed-tasks.md` Done.
- **Deferring D1 to D3 leaves the class of bug open.** Another fixture can escape the same way
  tomorrow. Accepted deliberately: the containment must not wait on three reviewed changes, and P2(d)
  files the follow-up in the same session so the deferral is recorded rather than forgotten.

---

## Verification

Concrete and executable. `find /var/lib/cezar -not -user cezar | wc -l` → `0` runs at the end of
every phase that touches the box.

**V0, containment (P0a and P0b).** **CORRECTED on review: V0 asserts, it does not print.** The
previous revision echoed `%{http_code}` beside a `# want 404` comment (nothing compared it) and used
bare `ls` calls whose *expected* outcome was a non-zero exit — under the `set -euo pipefail` the
script itself declares, those kill V0 on success and pass on failure. Both are fixed. **Every failed
condition below makes V0 exit non-zero.**

Run it **once per contained id**, after that id's `p0-contain.sh` invocation:

```bash
#!/usr/bin/env bash
set -euo pipefail
BASE=http://127.0.0.1:4321
S=${CEZ_SESSION:?}
ROOT=$(realpath /var/lib/cezar/loki-labs/cezar)
RUN=${1:?run id}
PROJECT=${2:?the project id p0-contain.sh resolved and printed}
fail=0
note() { echo "FAIL: $*" >&2; fail=1; }

# a. the absence proof, from the OWNING scope (never from runs-index). Exactly 404.
code=$(curl -sS -o /dev/null -w '%{http_code}' -b "cez_session=$S" \
        "$BASE/api/v1/p/$PROJECT/runs/$RUN") || { echo "FAIL: curl transport" >&2; exit 1; }
[ "$code" = 404 ] || note "$RUN scoped GET -> $code, want exactly 404"

# b. resources. `test ! -e` is the assertion; a bare `ls` is not.
test ! -e "$ROOT/.ai/cezar/worktrees/$RUN"            || note "$RUN worktree still present"
test ! -e "$ROOT/.ai/cezar/worktree-leases/$RUN.json" || note "$RUN lease still present"
branches=$(git -C "$ROOT" branch --list "cez/${RUN%%-*}*")
[ -z "$branches" ] || note "$RUN branches still present: $branches"

# c. discovery sweep. Non-empty `truncated` means INCOMPLETE, never clean (fact 6).
SW=$(mktemp)
code=$(curl -sS -o "$SW" -w '%{http_code}' -b "cez_session=$S" "$BASE/api/v1/workspace/runs-index")
[ "$code" = 200 ] || note "runs-index -> $code"
n=$(jq '[.runs[] | select((.task // "") | startswith("E2E disposable: "))] | length' "$SW")
t=$(jq -c '.truncated' "$SW")
echo "sweep: candidates=$n truncated=$t"
[ "$n" = 0 ] || note "$n 'E2E disposable: ' rows still visible — verify each by id, in its own scope"
[ "$t" = '[]' ] || echo "NOTE: sweep is INCOMPLETE for $t — report it as incomplete, not as clean"

# d. ownership
[ "$(find /var/lib/cezar -not -user cezar | wc -l)" = 0 ] || note "non-cezar-owned files under /var/lib/cezar"

[ "$fail" = 0 ] || exit 1
echo "V0 PASS for $RUN in $PROJECT"
```

Re-run it five minutes later for the same id. A run that comes back means something re-queued it and
P0 is not done. Report `truncated` verbatim; do not round a truncated index down to "clean".

**V1, evidence (P1).**

```bash
DEST=/var/lib/cezar/e2e-artifacts/bulk-start-480e0282
for f in 01-filed.png 02-selected.png 03-after-start.png \
         page@edf9250b5fc6b7f36362392d07941356.webm; do
  cmp "$ROOT/.ai/cezar/tmp/480e0282-a967-4936-a12e-3c4e56450586/e2e/$f" "$DEST/$f" && echo "OK $f"
done
cmp "$ROOT/.ai/cezar/worktrees/480e0282-a967-4936-a12e-3c4e56450586/.e2e-bulk-start.cjs" \
    "$DEST/.e2e-bulk-start.cjs" && echo "OK harness"
find /var/lib/cezar -not -user cezar | wc -l                            # want 0
```

All five `cmp`s must be silent-and-zero, and **V1 must pass before P0a runs** (§ P1, Ordering).

**V2, record (P2).**

```bash
# a. the tree really is on a CURRENT origin/main base (Measured fact 1) — not merely
#    "contains 7932cf4d", which the previous revision asserted and which proves nothing.
git -C <tree> fetch origin main
git -C <tree> merge-base --is-ancestor origin/main HEAD; echo "current_base_exit=$?"   # want 0
# b. both corrections landed at the right anchors
grep -n 'CORRECTED 2026-08-25' <tree>/.ai/specs/2026-08-24-bulk-start-filed-tasks.md       # want 1, inside item 5
grep -n 'CORRECTED 2026-08-25' <tree>/.ai/specs/2026-08-24-ship-bulk-start-filed-tasks.md  # want 1, inside P5
grep -c 'browser remains on' <tree>/.ai/specs/2026-08-24-bulk-start-filed-tasks.md         # want 1: original text kept
# c. the KB proposal is one valid NDJSON line, not a corpus edit
wc -l "$CEZ_KB_WRITE_FILE"                                                # want 1
jq -e '.op=="upsert" and .seq==0 and (.runId|length>0)' "$CEZ_KB_WRITE_FILE"   # want exit 0
git -C /var/lib/cezar/loki-labs status --short -- notion-export/ | wc -l   # want 0: corpus untouched
# d. both follow-up todos exist
cezar todo list | grep -c 'E2E step 10\|Scope-correct disposable E2E fixtures'   # want 2
```

Then state, in the handoff and in § Status log: **corpus sync PENDING** until the proposal is
applied and `cez kb search` returns the note.

**V3, gates and delivery (this task).** **CORRECTED on review: the previous revision said "No gates
are run by this task", and that is wrong.** This task changes four repository documents (§ What this
task does not change), so it produces a commit, and cezar's standing delivery contract
(`AGENTS.md:9,13`) puts the full gate in front of every commit — not only in front of source
changes. `.ai/agentic.config.json`'s `validation.commands` lists five entries and they are not
negotiable per-change:

```bash
# On the tree that passed V2(a) — a current origin/main base — and NOT before it.
scrub=$(env | sed -n 's/^\(CEZ_[A-Z0-9_]*\)=.*/\1/p' \
        | grep -vxE 'CEZ_(HANDOFF_FILE|TASK_ID)' | sed 's/^/-u /')
tmp=/tmp/cez-gate-$$ && mkdir -p $tmp        # trap 4: TMPDIR must be OUTSIDE any git repo
G="env -u NODE_ENV -u CLAUDE_CONFIG_DIR $scrub TMPDIR=$tmp TMP=$tmp TEMP=$tmp"
$G npm ci          || exit 1
$G npm run typecheck && $G npm test && $G npm run test:unit \
                    && $G npm run build && $G npm run test:package
echo "GATE_EXIT=$?"                          # want 0; a red gate blocks the commit, fail closed
```

`env -u CLAUDE_CONFIG_DIR` is not decoration: ambient `CLAUDE_CONFIG_DIR` leaks into
`src/server/config-api.test.ts`, the trap `480e0282` recorded. Say that you scrubbed it. See
`AGENTS.md` § "Five environment traps that make the gates LIE" for the other four, and note
`npm run test:package` requires a completed `npm run build` (`AGENTS.md:240`).

Then delivery, in this order:

```bash
git -C <tree> show --stat HEAD    # exactly 4 paths: 2 added, 2 modified; no deletions, nothing else
git -C <tree> push origin HEAD:main
git -C <tree> status --short      # want empty
git -C <tree> log origin/main..HEAD --oneline | wc -l   # want 0: nothing unpushed
```

One commit for the whole session, per the standing rule — not one per phase.

**Deployment: this run parks, and that is correct.** `AGENTS.md:16` and `.ai/deploy-targets.json`
(commit `c328ec06`, 2026-08-24) set **both** targets to `"manual": true`, so an agent-run
`spec-to-deploy` on cezar structurally cannot finish its own `deploy` step: it commits, pushes, and
parks with an "Awaiting manual deployment" handoff for a person to Resolve. The review note asking
for "blue-green deployment" by this task is asking for something the repo deliberately removed from
the agent path. Do not flip `manual` back to `false` to satisfy it.

**No new user-facing runtime E2E is required for these four documentation-only changes** — they add
no route, no UI and no behaviour to exercise. The required live verification for this task is
**V0**, and specifically V0 on `ae7bd42f` after P0b. Until that has been executed by the owner or a
third run, this task is **QA Needed**.

The deferred feature's gates are separate and belong to its own spec; see § Verification for the
deferred phases below.

### Verification for the deferred phases (specified now, executed there)

**VD1, harness (D1).** Bash only, because the exit code matters and the previous revision captured
the wrong one: `npm run test:e2e | tee log; echo "$?"` reports **`tee`'s** status, not the test
command's.

```bash
set -o pipefail
npm run test:e2e 2>&1 | tee "$TMPDIR/e2e.log"; echo "EXIT=${PIPESTATUS[0]}"   # want 0
grep -c 'TEST_E2E_STATUS=passed' "$TMPDIR/e2e.log"    # want 1; 'skipped' is NOT a pass
```

Then the negative control, which is the actual test of the phase: point cleanup at the boot project
instead of the owning one and re-run. **It must exit non-zero.** Two hard conditions, because a
negative control that starts real runs is another escaped fixture:

- Run it **only against isolated state** (`CEZ_HOME` in a temp dir, `CEZ_DRY_RUN=1`, the
  `backlog-composer.e2e.ts:53-143` pattern), never against the live cockpit.
- Finish it with a **correct-scope** cleanup of everything it created, and prove that cleanup with
  the same scoped absence check as V0(a). Proving the failure must not leave a fixture behind.

**VD2, `scope` field (D2).** Contract-parity tests both directions
(`contract-parity.runs.test.ts` pattern), plus `route-parity.test.ts` green, which is what proves the
field is present identically on all three spellings. Plus a `ApiError` test asserting the field
survives into the client, if D2 chooses to widen it.

**VD3, ledger and reaper (D3).** Unit tests for `pending` → `started` → `reaped`; a test that an
**absent** file reads as empty; a test that a **malformed** file fails closed, preserves the original
as `.corrupt-<seq>`, and refuses both creation and destructive reaping; a kill-between-states test
that leaves `started` and is finished by a subsequent `cezar e2e-reap` exiting 0. Simulate the kill;
do not deploy to cause one. Plus a test that the reaper **reports and does not delete** a
prefix-matching row with no ledger entry, and exits non-zero.

**Definition of done for this task.** Gates green is necessary and not sufficient. This task **does**
run the five-command gate (V3) because it produces a commit, and green there buys only the right to
push. It is **QA Needed** until **V0 on `ae7bd42f` has been executed and exited 0**, by the owner or
by a third run, after P0b. The parked `deploy` step is the expected terminal state for this run and
does not change that. Any phase whose verification did not execute is reported as not executed, by
name.

---

## Record

Everything below was read during this step unless marked otherwise.

- **Feature spec:** `.ai/specs/2026-08-24-bulk-start-filed-tasks.md` on `origin/main`; § Verification
  is `:61-71`, production E2E is **item 5**. Shipped `7932cf4d`, ancestor of `origin/main`
  `d217ab2e`. Untouched by this task except for P2(a)'s in-place correction.
- **Ship spec:** `.ai/specs/2026-08-24-ship-bulk-start-filed-tasks.md` on `origin/main`, 1330 lines;
  P5 begins `:803`; the API table is `:491-495`; the three cleanup risks are `:1091-1093`.
- **Brief:** `.ai/specs/briefs/2026-08-25-bulk-start-e2e-disposable.md`, KB `specs-b903eebc0533`
  (resolved; `cez kb show` returns it). The previous revision cited `specs-06402c11d9f7` and
  `specs-85e563c425df`; **both return `no such document`** and are removed. Prefer repository paths
  for the two specs above, which are stable, rather than KB ids that are not.
- **Harness (evidence, P1):** `.ai/cezar/worktrees/480e0282-…/.e2e-bulk-start.cjs`, 8171 B,
  untracked, inside a gitignored and reapable tree.
- **Retained artifacts (evidence, P1):** `.ai/cezar/tmp/480e0282-…/e2e/` (3 PNG + 1 WebM, 1.2 MB,
  08:18 UTC). **P1 complete:** all five files were copied and compared successfully at
  `/var/lib/cezar/e2e-artifacts/bulk-start-480e0282/`, outside the repository and its worktrees.
- **Incident evidence:** `runs/{480e0282,ae7bd42f,a3dd8f5f}-….ndjson`, `.ai/cezar/runs.json`,
  `.ai/cezar/todos.json:3696-3736`, `GET /api/v1/health`.
- **Code, all via `git show origin/main:<path>` because this worktree is stale at `b3d3a44c`:**
  - `packages/cezar/src/server/server.ts`: `resolveProjectScope` `:2097-2101`; `GET /runs/:id`
    `:5116`; `POST /runs/:id/cancel` `:5192`; `POST /runs/:id/remove-worktree` `:5868`;
    `DELETE /runs/:id` `:5879-5888`; `RUNS_INDEX_PER_PROJECT = 200` `:7174` with the finder doc
    comment `:7167-7173`; the index handler `:7276-7352` (`truncated` push at `:7331`).
  - `packages/cezar/src/workflows/run.ts`: `reviveQueuedRun` `:2255-2262`; recovery filter and its
    doc comment `:2278-2302`; `cancel()`'s `cancelled while queued` event `:3662-3697`.
  - `packages/cezar/src/runs/store.ts`: `reconcileLoadedRun` and the `keepLive` doc comment
    `:709-753`. This is the citation behind D3's "do not open a second `RunStore`".
  - `packages/cezar/src/index.ts`: `openStore` `:1366-1371`; `ensureDataGitignore` and its `wanted`
    array `:1374-1403`.
  - `packages/web/src/api/client.ts`: `ApiError` and its `extras` whitelist `:216-246`.
  - `packages/web/e2e/agent-browser.ts`: the full `AgentBrowser` surface `:82-243`; `bootProjectId`
    `:74-80`; `fixtureServeEnv` `:60-64`.
  - `packages/cezar/src/server/route-parity.test.ts:14-31`: the three-spelling byte-identical guard
    and the `spellings()` helper.
  - `packages/cezar/src/server/contract-parity.cluster.test.ts:44-49`: why parity assertions must be
    mutual.
  - `.ai/scripts/e2e.sh:1-13`: the exit-code contract.
  - `packages/contract/src/runs.ts`: named as D2's home; **not read in detail this step.**
- **Not found:** no corpus knowledge note on bulk start or on disposable fixtures
  (`cez kb search`); no prior spec establishing a disposable-fixture convention (fact 7). P2(c)
  proposes the first.

## Status log

- **2026-08-25, step 4/9 of `ae7bd42f`:** P1 completed. All five retained E2E evidence files were
  copied and compared at `/var/lib/cezar/e2e-artifacts/bulk-start-480e0282/`; the ownership check
  found zero non-cezar-owned files. The worktree was rebased onto current `origin/main` and the
  current-base ancestry check passed. P0 remains unexecuted by this run.
- **2026-08-25, step 4/9 of `ae7bd42f`:** P2 completed. The feature and ship specs now carry
  in-place corrections, the KB proposal was appended at sequence 0, and both follow-up todos were
  filed. The proposal is pending review and corpus application. No gate, P0 containment, commit,
  push, or deployment was run by this step.
- **2026-08-25, step 2/9 of `ae7bd42f` (revision 2, after `CEZ:REVIEW=revise`):** spec rescoped to
  containment, evidence and record; D1 to D3 moved to § Deferred scope with the review's corrections
  applied. Nothing executed. No file outside this one changed. Both fixture runs `ae7bd42f` and
  `a3dd8f5f` were re-measured as `status: "running"` while this revision was written, and P0 is
  still the first thing that should happen to them.
- **2026-08-25, step 2/9 of `ae7bd42f` (revision 1):** first draft. Superseded by revision 2, which
  reversed its authorization of new API, CLI and persisted-state work under this task.
