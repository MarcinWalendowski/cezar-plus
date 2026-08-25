# Verify Bulk Start Release

**Status:** **spec written** 2026-08-25. Nothing in this document has been executed yet. This is
step 2/9 of run `480e0282-a967-4936-a12e-3c4e56450586` (`spec-to-deploy`), re-entered after the
earlier pass of the same chain already performed the reconcile, commit and push phases, and ran the
gates on a tree that the commit then moved away from (§ P-A).

**Repo:** `cezar`. Worktree `/var/lib/cezar/loki-labs/cezar/.ai/cezar/worktrees/480e0282-a967-4936-a12e-3c4e56450586`,
HEAD `7932cf4d83ff6a4f263ae7181ec0d8e9fa81ea7f`, branch `cez/480e0282`.

**Brief:** `.ai/specs/briefs/2026-08-25-bulk-task-starts.md`, written by step 1 ("context") of this
pass. Its findings held on re-checking, with **one correction** recorded in § Measured facts (item
11): the brief did not know that a prior E2E attempt in this same run leaked two live agent runs,
which is now the most urgent item in this document. Its open question 4, that a searchable corpus
record is blocked on a human applying a proposal, is **correct**; the first draft of this spec
contradicted it and was wrong (§ P-E, § Measured facts 8).

**Predecessor spec, same feature:** `.ai/specs/2026-08-24-ship-bulk-start-filed-tasks.md` (1330
lines, committed in `7932cf4d`). It planned the reconcile/gate/commit/push/deploy/E2E/record
sequence. Its P1 (reconcile), P1.5 (the `sorted` to `rows` defect fix) and P3 (the commit) are
**done and provable from git**, as is the push half of its P4; this spec does not replay them and
explicitly forbids replaying them. Its **P2 (the five gates) was run, but on a pre-merge tree**, so
this spec re-runs it as P1.5 (§ P-A). The deploy half of its P4 is `manual: true` and correctly did
not happen (§ P-D). Its own status header still says "Nothing in this document has been executed
yet", which is now false. **This spec does not correct it**, because that edit is a second commit
its own P6 explicitly reserved for the owner to ask for; the correction is filed as a follow-up
instead (§ P4).

**Feature spec (the thing being verified):** `.ai/specs/2026-08-24-bulk-start-filed-tasks.md`,
written by parent task `e6592588-1628-40e0-b31a-8fe26c8b2220`, now on `main` inside `7932cf4d`.
This spec does not restate or reopen its design.

**On quotations:** house style forbids the em dash, so quoted passages are re-punctuated with
commas, colons or parentheses. No quoted wording is otherwise altered.

## TLDR

**The feature is already shipped and already live in production.** `7932cf4d` ("feat: bulk start
filed tasks") is an ancestor of `origin/main` (`d217ab2e`), the running server reports release
`20260825T082047Z-d217ab2e` activated at `2026-08-25T08:20:53.041Z`, the served bundle
`assets/index-BpuMuVjc.js` contains the feature's own DOM markers, and **both declared probes in
`.ai/deploy-targets.json` exit 0 right now** when run verbatim from this worktree.

So the reconcile, the feature commit and the push are already satisfied, and re-doing them would be
duplicate work: a second reconcile, a second feature commit, or an agent-run `server-deploy` would
each be actively wrong. The agent-run deploy is wrong for a second, independent reason: both
targets are `"manual": true` by an owner decision made 2026-08-24, so activating cezar from an
agent is the exact behaviour that decision withdrew.

**Acceptance criterion 3 is NOT satisfied, contrary to the first draft of this spec.** The five
gates ran green at `2026-08-24T23:57Z` on a tree based on `e38cb619`. The commit was made at
`00:00Z`, *after* a `git merge --ff-only origin/main` pulled in `ea40c7a1`, which changed 11 paths
including `packages/cezar/src/workflows/{postconditions,run,types}.ts` and three of their test
files. The handoff's `HEAD^{tree} == $TESTED_TREE` check was taken after that merge, so it proves
the commit equals what was staged, not that any gate ever ran on the committed tree
(§ Measured facts 18). Criterion 3 stays open until P1.5 below runs all five gates on a clean
checkout of `7932cf4d` itself.

What actually remains is **four things, none of them shipping**:

1. **A leak to reap, first.** A prior E2E attempt in this run at 08:18 UTC started two real
   `spec-to-deploy` runs on two disposable todos and then died before its cleanup ran. Both runs are
   still `status: "running"` and between them they had burned **6,692,666 tokens** by 08:46, up from
   1,151,848 at 08:2x, i.e. the meter is running while this spec is being written. Two disposable
   todos sit in the shared `todos.json`. This is an ongoing cost leak, and it is this run's own mess.
2. **Five gates on the exact committed tree**, per above.
3. **A production browser E2E whose verdict is actually recorded.** Screenshots and a video from
   08:18 exist on disk, but no pass/fail verdict was written to the handoff or anywhere else, and
   the leak is evidence the script did not reach its own success path. Artifacts without a verdict
   are not proof.
4. **A corpus record.** It gets written as a proposal to `$CEZ_KB_WRITE_FILE`, which is the only
   write path this run's knowledge protocol permits. The *searchable* half of acceptance criterion 6
   stays **BLOCKED** on a human applying that proposal, exactly as the predecessor spec said
   (§ P-E). The earlier draft of this spec withdrew that conclusion on the strength of `cez kb
   write` existing; that withdrawal is itself withdrawn.

Six phases, in dependency order, not independent: **P0** reap the leak, **P1** re-verify release
identity, **P1.5** five gates on a clean checkout of `7932cf4d`, **P2** re-run the E2E leak-proof
and record its verdict, **P3** file the corpus proposal, **P4** leave the worktree clean and commit
nothing. **No phase edits a tracked file, and this run makes no second commit:** its one commit is
already `7932cf4d`, and the predecessor spec explicitly left a post-release status edit to the owner
to ask for (§ P4). Correcting the three stale spec headers is therefore a **deferred follow-up**,
filed as a todo, not work this run does.

## Problem

### P-A. Three of the acceptance criteria describe work that is already done, and one only looks done

The task asks to reconcile the parent diff, make one feature commit referencing
`.ai/specs/2026-08-24-bulk-start-filed-tasks.md`, push to `origin main`, run five gates, deploy, run
a browser E2E, and record the outcome. Criteria 1 and 2 (reconcile, commit and push) are recorded as
done in this run's handoff and are independently provable from git today (§ Measured facts 1 to 5,
and the commit log at `.ai/cezar/runs/480e0282-a967-4936-a12e-3c4e56450586.handoff.md` under
"Progress log (step 6: commit & push)").

**Criterion 3 is the one that only looks done.** The handoff's "Progress log (step 5: run the
gates)" records all five green at `23:57Z`, and step 6 then records a `git merge --ff-only
origin/main` at `00:00Z` that pulled in `ea40c7a1` before committing. `ea40c7a1` changes 11 paths,
four of them `packages/cezar/src/workflows/*.ts` source and test files that `npm test` and
`npm run test:unit` cover. Nothing re-ran after that merge. The `HEAD^{tree} == $TESTED_TREE`
equality the handoff cites was captured from `git write-tree` after the merge and after staging, so
it establishes that the commit is the staged tree and says nothing about which tree the gates saw
(§ Measured facts 18). P1.5 closes this, and until it is green criterion 3 is open.

A step that obeys the acceptance criteria literally would reset onto main, re-apply the parent
patch, and produce a second commit of a feature main already contains. The criteria were written
before the work happened; git is what happened. **Git wins.**

The one thing that must not be inferred from this is that the *whole* task is done. Criteria 3, 5
and 6 are unproven, and criterion 4's probes pass by inheritance rather than by anything this task
did.

### P-B. Two disposable agent runs are still burning tokens right now

Measured at 08:2x UTC on 2026-08-25, from `/var/lib/cezar/loki-labs/cezar/.ai/cezar/`:

| what | id | state |
| --- | --- | --- |
| todo `E2E disposable: 480e0282 #1` | `2d0b837a-b71b-4c7f-af43-929060e0ef66` | `status: "todo"` |
| todo `E2E disposable: 480e0282 #2` | `520e2bbe-4abe-4a3a-8bc9-c818968be2aa` | `status: "todo"` |
| run `1: E2E disposable: 480e0282 #1` | `ae7bd42f-a399-4ceb-92cf-d657e620d80f` | `status: "running"`, `tokensUsed: 1151848`, workflow `spec-to-deploy`, backend `codex`/`gpt-5.6-terra` |
| run `2: E2E disposable: 480e0282 #2` | `a3dd8f5f-5d66-402e-b876-c1a6746d9da7` | `status: "running"`, runner `claude`, profile `secondary` |

**Re-measured at 08:46 UTC, while revising this spec:** both still `status: "running"`,
`tokensUsed` now `2869979` and `3822687` respectively, **6,692,666 tokens between them**. At 08:2x
the pair was at 1,151,848. The figure in the table above is kept as the first measurement so the
growth is legible; treat any number here as a floor, not a total, and re-read `runs.json` at reap
time rather than quoting this spec.

Both were created at `2026-08-25T08:18:4xZ` with `author.via: "todo-start"`, which is exactly the
signature of the browser E2E's own button click. The todos being back at `status: "todo"` rather
than started is consistent with a cancel having restored them, or with `markStarted` bookkeeping
never being cleaned; either way the runs were never deleted and are not terminal.

**Why this is expensive and not merely untidy.** `cezar todo add` has no `--workflow` flag (`cezar
todo` usage, measured), and `POST /todos/:id/start` resolves the workflow through
`resolveTodoWorkflow(repoRoot, todo)` (`packages/cezar/src/server/server.ts:6182`) and then calls
`manager.startRun(workflow, …)` (`:6188`). A disposable todo therefore starts a **full
`spec-to-deploy` chain against the real cezar repo**, holding a worktree lease and calling real
paid models, for as long as nobody cancels it. One of these two has already spent over a million
tokens producing work nobody will ever read.

This is also a design flaw in the E2E as written, not only an accident: `.e2e-bulk-start.cjs`
cancels only inside its `finally` block, after it has waited up to 15 seconds per todo for rows to
leave the Filed table and re-queried the runs index. Any crash, timeout or SIGKILL between the click
and that block leaves live runs behind with no record of their ids anywhere on disk.

### P-C. The 08:18 E2E produced artifacts but no verdict

`/var/lib/cezar/loki-labs/cezar/.ai/cezar/tmp/480e0282-a967-4936-a12e-3c4e56450586/e2e/` holds
`01-filed.png` (183,929 B), `02-selected.png` (179,524 B), `03-after-start.png` (179,700 B) and
`page@edf9250b5fc6b7f36362392d07941356.webm` (731,839 B), all mtime `Aug 25 08:18`.

The helper prints its verdict as JSON on stdout (`{"verdict":"PASS",…}` and a second
`{"cleanup":…}` line). Neither line appears in the run handoff, and the handoff's progress log has
no step-5 E2E entry at all. So the artifacts prove a browser reached `/tasks` and clicked
something; they do not prove the assertions passed, and the leak in P-B is positive evidence that
execution did not reach the end of the `finally` block cleanly.

A second, quieter problem: those artifacts were captured at 08:18, while the currently live release
was activated at **08:20:53**. The release running at 08:18 was `20260825T081138Z-00a202b8`. That
commit does contain the feature (`git merge-base --is-ancestor 7932cf4d 00a202b8` exits 0), so the
old artifacts are not worthless, but they are not artifacts of the release that is live now.

### P-D. An agent must not run `cezar server-deploy` here, and does not need to

Acceptance criterion 4 says "Deploy with `cezar server-deploy --strategy=blue-green` and pass every
declared readiness probe." Both halves need care.

Both targets in `.ai/deploy-targets.json` carry `"manual": true` with `manualReason` beginning "a
person activates cezar, not an agent (owner decision 2026-08-24,
`.ai/specs/2026-08-24-default-workflow-ten-stages.md` D6)". `AGENTS.md:5-12` carries the matching
`CORRECTED 2026-08-24` supersession of its own "always self-deploy" instruction, and
`.ai/specs/2026-08-24-manual-deploy-not-a-bug.md` spells the decision out: a parked agent deploy
"is the expected terminal state for such a run, not a defect to route around and not a bug to fix
by flipping `manual` back to `false`."

The probe half, meanwhile, is already satisfied. Run verbatim from this worktree today, the backend
probe exits 0 with `live=d217ab2e… is a descendant of HEAD=7932cf4d… (this HEAD is running)` and the
UI probe exits 0 with `serving assets/index-BpuMuVjc.js == the built bundle`. `allServicesDeployed`
(`packages/cezar/src/workflows/postconditions.ts`) runs every probe unconditionally and only
reshapes a **failed** manual target into a handoff, so with both green the `deploy` step's
postcondition is `ok: true` and no manual handoff is raised.

So the correct action for the deploy step is: **run the two declared probes, report them, deploy
nothing.** If a probe were red, the correct action would be to park, not to activate.

### P-E. The corpus record IS blocked, and the first draft of this spec was wrong to say otherwise

The predecessor spec's P6 states that writing the outcome to the corpus can only be a proposal to
`$CEZ_KB_WRITE_FILE` and that "APPLICATION IS BLOCKED: the applier exists but nothing supported
calls it". The brief repeats this as open question 4. **That conclusion stands.** The first draft of
this spec withdrew it; this section is the correction.

The withdrawal rested on a true fact and a wrong inference. The fact: `cez kb write
<project|workspace> <path>` is a first-class subcommand (`packages/cezar/src/knowledge/cli.ts:80`,
dispatched at `:126`) and its handler calls `store.createDocument({ scope, path, content })`
directly at `:361`, with no proposal queue in between. The inference, that an agent in this run may
therefore use it, is wrong for two independent reasons:

1. **This run's knowledge protocol forbids it.** The operating instructions for this run say, in
   terms: record a durable decision by appending NDJSON lines to `$CEZ_KB_WRITE_FILE`
   (`/var/lib/cezar/loki-labs/cezar/.ai/cezar/runs/480e0282-a967-4936-a12e-3c4e56450586.knowledge.ndjson`),
   **never edit a mounted document directly**, and a proposal "is reviewed and applied later,
   through the cockpit or `cez kb proposals`, never automatically". A mechanism existing in the
   codebase is not a grant of permission to use it; the protocol is the grant, and it names one
   path.
2. **Nothing supported can apply that proposal today.** `POST /knowledge/proposals/apply` refuses
   every requested `seq` with the constant `PROPOSAL_APPLY_NOT_AVAILABLE = 'applying knowledge
   proposals is not implemented yet'` (`packages/cezar/src/server/knowledge-routes.ts:68`, handler
   at `:239-258`), even though `applyKnowledgeProposals` exists and is tested
   (`packages/cezar/src/knowledge/proposals.ts:81`). So the human review step has no working button
   behind it yet either.

The same protocol rules out hand-writing a file into `/var/lib/cezar/loki-labs/notion-export/` and
reindexing it, which is what the first draft's P3 step 1 proposed. That is a direct edit of a
mounted document.

**Consequence for acceptance criterion 6, stated plainly:** the *write* half is achievable in this
run and is P3's job. The *searchable* half is **not achievable by this run** and must be reported
as blocked pending human application, not quietly counted as green.

## Solution

Stop treating this as a shipping task. It is a **reap, verify and record** task.

- **Reap** the two leaked runs and two disposable todos before anything else, because they cost
  money every minute they stay up, and snapshot their evidence first because deletion destroys it.
- **Verify** twice over: the five gates on a clean checkout of the exact commit `7932cf4d` (which
  has never happened), and the two declared probes plus one real browser E2E against the release
  that is live at the time of the run, capturing the verdict as a line of JSON in the handoff, not
  only as image files.
- **Record** the outcome in the two places this run is permitted to write: a knowledge **proposal**
  appended to `$CEZ_KB_WRITE_FILE`, and the run handoff. Not the mounted corpus, and not `cez kb
  write` (§ P-E), and **not the repo's spec headers** either: correcting those in place is right in
  principle and is a second commit in practice, which the predecessor spec deliberately left for the
  owner to request (§ P4). It becomes a filed follow-up todo instead.

Three design changes to the E2E, all aimed squarely at P-B:

1. **Cancel as soon as both runs are proven to exist, before asserting anything else.** The window
   between the button click and the cancel is the entire cost of this test. The current script's
   window is the whole assertion suite plus two 15-second waits; the new window is milliseconds.
2. **Write each run id to a sidecar reap file inside the response handler**, the instant that one
   response body is parsed and before any assertion can throw. Per response, not per batch: a crash
   between the first `201` and the second is exactly the case the sidecar exists for. A crash then
   leaves a machine-readable list instead of an archaeology problem, and P0 becomes a reusable
   procedure rather than a one-off.
3. **Drop the assertion that started rows leave the Filed table.** It contradicts cancelling first,
   because cancel deliberately restores the todo (§ P2 step 5).

## Architecture

Nothing in the product changes, and **no tracked file is edited at all**: not under `packages/`, and
not the Markdown under `.ai/specs/` either. This spec and its brief stay untracked task artifacts,
the two stale spec headers stay stale until an owner asks for the correction, and the run's git
footprint ends exactly where it already is, at `7932cf4d` (§ P4). Everything below is measurement
and cleanup.

The pieces already in place, re-read at HEAD `7932cf4d` and cited so an implementer edits the right
region:

**Selection helpers**, `packages/web/src/lib/filed-tasks.ts:235-274`: stable project-qualified
selection key, immutable toggle/set, ordered visible intersection, tri-state select-all.

**Rendered-row batch derivation**, `packages/web/src/routes/global-tasks.tsx:782-799`. The shipped
code computes the batch from the rendered `rows`, not from the whole `sorted` set. That is the
P1.5 correction the earlier pass made on top of the parent patch, and its regression test is
`packages/web/src/routes/global-tasks.test.tsx:1515-1574` (250 filed rows, page in to 200 shown,
reverse the sort, assert the hidden row never reaches `/start`).

**Serial submit**, `packages/web/src/routes/global-tasks.tsx:1522-1548` (`useStartFiledTasks`): a
`for` loop over entries awaiting `startWorkspaceTodo(entry.project, entry.todo.id)` one at a time,
pushing failures into an array rather than aborting, then invalidating both
`workspaceQueryKeys.workspaceTodos` and `workspaceQueryKeys.runsIndex` and toasting. **It never
calls `navigate`.** The single-row start path immediately above it (`:1516`) does navigate, by
design; the E2E's no-navigation assertion is what separates the two.

**DOM contract consumed by the E2E** (all measured in `global-tasks.tsx` at HEAD):

| selector | line | role |
| --- | --- | --- |
| `input[data-slot="filed-select"][data-todo-id="<id>"]` | `1071`, `1072` | per-row checkbox, addressable by todo id |
| `input[data-slot="filed-select-all"]` | `1050` | tri-state header checkbox |
| `[data-slot="filed-selection-bar"]` | `826` | the bar that appears once anything is selected |
| `[data-slot="filed-selection-count"]` | `829` | renders `N selected` |
| `[data-action="start-selected-filed-tasks"]` | `835` | renders `Run N tasks` |
| `[data-action="clear-filed-selection"]` | `847` | clears selection |

**Auth.** `/tasks` answers `200` unauthenticated (measured), but every API the E2E asserts against
does not: `GET /api/v1/workspace/runs-index` and `GET /api/v1/workspace/todos` both return `401` on
loopback (measured). Without a session cookie the Filed table renders empty and every assertion
fails as a false feature bug. `packages/cezar/src/auth/session.ts:356` exports
`createSession(userId, ttlMs?)` and `:360` exports `destroySession(sessionId)`; the cookie name is
`SESSION_COOKIE_NAME = 'cez_session'` (`:75`).

## Phases

**These phases are not independent, and an earlier draft of this spec claimed they were.** The real
dependency graph, which the executing step must respect:

- **P0 before everything.** It is the only phase that stops money burning, and P2 must not add a
  second pair of leaked runs to an uncleaned first pair (the ground-truth assertions in P2 cannot
  distinguish them).
- **P1 and P1.5 both before P2.** P1 pins which release the browser is about to measure; P1.5 is
  what makes acceptance criterion 3 true. Running a browser E2E against a build whose committed tree
  was never gated proves the button works, not that the release is sound.
- **P2 before P3.** P3's record states a verdict, so it needs one. Until the browser pass the
  feature is **QA Needed**, and the proposal must say so rather than claim Implemented.
- **P4 last**, and last in a stricter sense than the others: its step 3 removes this spec from the
  worktree, so it runs only after every step of this nine-step chain that still needs to read it.

A later phase failing does not retroactively invalidate an earlier phase's evidence, but it does
leave the task incomplete. In particular P3 ends **blocked** by construction (§ P-E): even with
every other phase green, acceptance criterion 6 is half met, and the run must say so rather than
report Done.

### P0. Reap the leak (do this first, before anything else)

**Why first:** every minute of delay is paid model tokens on two runs nobody wants.

**Every path in this phase is absolute, rooted at `/var/lib/cezar/loki-labs/cezar/.ai/cezar/`.**
The worktree has its own `.ai/cezar/` directory (it contains `todos.json`, `knowledge-index/` and
`tmp/`), so a relative `grep .ai/cezar/todos.json` run from the worktree reads a **different data
store** from the one the server mutates and can report a clean reap that never happened.

**Snapshot before you destroy.** `RunStore.deleteRun` (`packages/cezar/src/runs/store.ts:1364-1379`)
`rmSync`s the run's event NDJSON, its handoff file and its images directory. R1 below used to claim
the transcripts "survive run deletion long enough to read if needed"; they do not. So steps 1 and 2
are evidence capture and they are not optional.

1. Copy the evidence into the preserved-artifact directory, as the `cezar` user:
   `mkdir -p /var/lib/cezar/loki-labs/cezar/.ai/cezar/tmp/480e0282-a967-4936-a12e-3c4e56450586/e2e/2026-08-25T0818Z-orphaned/`
   then move the four 08:18 artifacts (`01-filed.png`, `02-selected.png`, `03-after-start.png`,
   `page@edf9250b5fc6b7f36362392d07941356.webm`) into it, and copy in, for each of
   `ae7bd42f-a399-4ceb-92cf-d657e620d80f` and `a3dd8f5f-5d66-402e-b876-c1a6746d9da7`:
   `.ai/cezar/runs/<id>.ndjson` (the event transcript) and `.ai/cezar/runs/<id>.handoff.md` if it
   exists. Copy, do not move: the run is still live and still appending.
2. Record the run records themselves, at reap time, into
   `2026-08-25T0818Z-orphaned/runs-snapshot.json`: the two full objects from
   `/var/lib/cezar/loki-labs/cezar/.ai/cezar/runs.json` including `status`, `tokensUsed`,
   `createdAt`, `workflow`, `author` and `startedTaskId`. The token figure quoted in the report is
   this one, not the one in § P-B.
3. Mint a short-lived session for the owner user id and export the cookie. The E2E helper already
   uses `a168b3d6-0ff4-46c7-84c3-7fa5217df843`; confirm it against `runs.json`'s
   `author.id` on the leaked runs rather than trusting the constant.
4. `POST /api/v1/runs/<id>/cancel` for both ids. Accept `200`, `404`, `409`.
5. Poll `DELETE /api/v1/runs/<id>` until `200` or `404`. A `409` means the cancel is still draining
   (`run is active - cancel it first`); keep polling on a bounded 60s/2s loop, do not treat it as
   terminal. This is the doctrine's sanctioned until-loop, not a guessed `sleep N`.
6. `DELETE /api/v1/p/cezar/todos/<id>` for `2d0b837a-b71b-4c7f-af43-929060e0ef66` and
   `520e2bbe-4abe-4a3a-8bc9-c818968be2aa`. Cancel restores a started todo
   (`clearStartedTaskId`, `server.ts:5202`), so the todo delete must come **after** the cancel, not
   before it, or the restore resurrects a row you already deleted. Accept `200` **and `404`, and
   expect `404`:** both rows already carry `tombstone: { at: "2026-08-25T08:18:56…Z" }` (measured
   while revising this spec), and `removeTodo` returns `false` for an already tombstoned row
   (`packages/cezar/src/todos.ts:469-484`), which `.delete('/todos/:id')` reports as
   `404 {"error":"not found"}` (`packages/cezar/src/server/server.ts:6144-6148`). **A `404` on these
   two ids is successful cleanup, not a missed delete.**
7. **A tombstone IS the delete record here, so do not look for physical removal.** Under clustering
   a delete is a tombstone and never a removal: `removeTodo` writes `tombstone: { at }` onto the row
   and leaves it in `todos.json`, because that marker is what the outbox derivation reads to emit
   `op: 'tombstone'`, and it is compacted only after the retention window (`todos.ts:469-484`, and
   the same rule documented on `isTombstoned` at `todos.ts:142-147`). Consequence, stated plainly
   because the earlier draft of this spec got it wrong: **`grep -c "E2E disposable" todos.json` will
   still print `2` after a perfectly successful reap**, so a check demanding `0` can never pass and
   would report a real cleanup as a failure. Assert ground truth **while still authenticated**, and
   structurally rather than by text match:
   - neither run id appears in `GET /api/v1/workspace/runs-index`, and neither appears in
     `runs.json` (a run delete **is** a physical removal, so absence is the right test there);
   - neither todo id appears in `GET /api/v1/workspace/todos`, which answers `200`;
   - each todo id is **either absent from `todos.json` or present carrying `tombstone`**;
   - **no non-tombstoned** row in `todos.json` has a summary matching `E2E disposable`.

   V0 spells all four out as runnable code. Do not use a concatenated-blob `includes` or a
   `grep -c` as the cleanup gate: both conflate a tombstoned row with a surviving filed task, and
   the blob form additionally matches an id that appears anywhere in either file for any reason.
8. Destroy the session **last**, then confirm `GET /api/v1/workspace/todos` returns `401`.
9. Record the reaped ids, the snapshot path and the final token figure in the run handoff.

**Done when:** both run ids are absent from `runs.json` and from the authenticated runs index; both
todo ids are absent from `GET /api/v1/workspace/todos` and are either absent from `todos.json` or
tombstoned in it; no non-tombstoned `E2E disposable` row survives; the `2026-08-25T0818Z-orphaned/`
directory holds the four artifacts plus both transcripts plus `runs-snapshot.json`; and no new leak
was created.

### P1. Re-verify release identity (deploy nothing)

1. `git fetch origin`, then confirm `git merge-base --is-ancestor HEAD origin/main` exits 0 and that
   `git diff --stat HEAD origin/main -- packages/web/src/routes/global-tasks.tsx
   packages/web/src/lib/filed-tasks.ts packages/web/src/lib/filed-tasks.test.ts
   packages/web/src/routes/global-tasks.test.tsx` prints nothing.
2. Extract both probes from `.ai/deploy-targets.json` programmatically (do not retype them) and run
   each with `bash -lc` from this worktree. Both must exit 0. Quote their stdout in the report.
3. Independently confirm the live bundle contains the feature, which the UI probe does not check:
   `grep -l 'start-selected-filed-tasks' /opt/cezar/packages/cezar/web/dist/assets/index-*.js` must
   match, and so must `filed-selection-bar`.
4. Record the live `deploy` object from `GET /api/v1/ready` verbatim, including `releaseId`, `sha`
   and `activatedAt`.
5. **Run no deploy command.** If a probe is red, stop and park with a manual-deploy handoff naming
   the exact command from the target's `manualReason`. Do not activate, and do not edit `manual`.

**Done when:** both probes exit 0 and their output is quoted in the report, or the run is parked
with a legible handoff.

### P1.5. Run all five gates on a clean checkout of `7932cf4d`

This is acceptance criterion 3, and it is the phase the first draft of this spec wrongly declared
already met. § P-A has the argument; this is the procedure.

1. Make a detached checkout of the exact commit, outside this worktree so nothing untracked leaks
   into it, as the `cezar` user:
   ```bash
   GATES=/var/lib/cezar/loki-labs/cezar/.ai/cezar/tmp/480e0282-a967-4936-a12e-3c4e56450586/gates-7932cf4d
   git -C /var/lib/cezar/loki-labs/cezar/.ai/cezar/worktrees/480e0282-a967-4936-a12e-3c4e56450586 \
       worktree add --detach "$GATES" 7932cf4d83ff6a4f263ae7181ec0d8e9fa81ea7f
   git -C "$GATES" rev-parse HEAD            # want 7932cf4d83ff6a4f263ae7181ec0d8e9fa81ea7f
   git -C "$GATES" rev-parse HEAD^{tree}     # want 89d05604e33d92b6a94151f36d2e6ffe36e54740
   git -C "$GATES" status --porcelain --untracked-files=all   # want empty
   ```
   The tree hash is the assertion that matters: it is the same `$TESTED_TREE` the handoff quotes, so
   printing it here is what finally binds a gate run to that value honestly.
2. `npm ci` in `$GATES`, then the five gates in order, each exiting 0:
   `npm run typecheck`, `npm test`, `npm run test:unit`, `npm run build`, `npm run test:package`.
   Run them from `$GATES`, not from this worktree.
3. **Scrub the ambient `CLAUDE_CONFIG_DIR`** for `npm test`: `env -u CLAUDE_CONFIG_DIR npm test`.
   Without it `src/server/config-api.test.ts` fails because the session's
   `CLAUDE_CONFIG_DIR=/var/lib/cezar/.claude-secondary` leaks into `readAgentModelDefaults` and
   bypasses the test's mocked `HOME`. This is a known environment defect, already filed as todo
   `eff223d4-7070-42c3-b56e-f16fb027c753`, and it is not a gate failure. `onboarding.test.tsx` is a
   known roughly 1-in-24 flake; an isolated rerun of that one file is the accepted control, and the
   rerun result must be quoted rather than waved at.
4. These runs are long. Redirect each to a file and block on an `EXIT=` marker rather than a guessed
   `sleep`; re-slice the file for detail instead of re-running the gate.
5. Expected shape, from the pre-merge run recorded in the handoff, useful only as a tripwire for
   "did the count move": `npm test` around 11,784 passed / 4 skipped, `test:unit` 44/44,
   `test:package` 25/25. A `test:unit` total of 53 rather than 44 means the checkout is not
   `7932cf4d` (the `deploy-e2e-probe.test.ts` deletion is missing).
6. Remove the throwaway checkout when green: `git worktree remove "$GATES"`, then
   `git worktree prune`. Quote every exit code in the report before removing it.

**If a gate is red**, that is a genuine finding about a commit already on `origin/main` and already
live. Do not paper over it and do not revert anything from this run: report it, file a todo, and
keep the checkout for diagnosis.

**Done when:** all five commands exit 0 on a checkout whose `HEAD^{tree}` printed
`89d05604e33d92b6a94151f36d2e6ffe36e54740`, and every exit code plus the three test totals are
quoted in the handoff.

### P2. Re-run the production browser E2E, leak-proof, verdict recorded

Adapt the existing helper `.e2e-bulk-start.cjs` (172 lines, `cezar`-owned). **It moves out of the
worktree first** (§ P4 requires a clean `git status`, and an untracked file at the worktree root
defeats that just as surely as a tracked one):

```bash
W=/var/lib/cezar/loki-labs/cezar/.ai/cezar/worktrees/480e0282-a967-4936-a12e-3c4e56450586
E2E_DIR=/var/lib/cezar/loki-labs/cezar/.ai/cezar/tmp/480e0282-a967-4936-a12e-3c4e56450586
git -C "$W" rm --cached --quiet .e2e-bulk-start.cjs        # drop the intent-to-add index entry
mv "$W/.e2e-bulk-start.cjs" "$E2E_DIR/e2e-bulk-start.cjs"
```

Two resolutions become location-sensitive once it moves, and both must be made absolute:
`require('playwright')` (installed globally at `/usr/lib/node_modules/playwright`, measured; use
`require.resolve('playwright', { paths: [W] })` or require the absolute path) and the dynamic
`import('./packages/cezar/src/auth/session.ts')` at line 30, which becomes a `file://` URL under
`$W`. Run it as `cd "$W" && npx tsx "$E2E_DIR/e2e-bulk-start.cjs"`; `tsx` is in the worktree's
`node_modules` (measured).

Changes required:

1. `OUT` becomes a timestamped subdirectory under `$E2E_DIR/e2e/` so the P0-preserved artifacts are
   not overwritten, and is taken from the environment variable `E2E_OUT` so the shell and the script
   agree on one path (see V4).
2. **Inside the `page.on('response')` handler, at the point the individual body is parsed**
   (currently line 70-71), synchronously `appendFileSync` one line `{runId, todoId, at}` to
   `$E2E_OUT/reap.ndjson`, per response. Not after both responses have arrived, and not in the main
   path: a crash between the first `201` and the second is precisely the case the sidecar exists
   for, and a batched write loses the first run id in exactly that case. Derive `todoId` from the
   response path (`/todos/<id>/start`), which the handler already parses.
3. **The cleanup path must reap the union of the sidecar and the in-memory list.** Read
   `$E2E_OUT/reap.ndjson` back at cleanup time, merge its `runId`s with `cleanupRunIds`, dedupe, and
   cancel/delete every one. The in-memory array is not authoritative once a handler can throw.
4. **Cancel immediately after proving the runs exist, then prove them in the DOM.** The API half
   alone does not satisfy the acceptance criterion, which says "verify two runs appear" on `/tasks`,
   in a browser. Cancelling does not cost us that: `POST /runs/:id/cancel` stops the model work but
   **keeps the run record**, and `/tasks` renders every run it is given, so a cancelled run still
   has a row. Order, exactly:
   1. Wait for both responses to be captured (`startResponses.length === 2` **and** both run ids
      present) and assert both start paths name the two todo ids.
   2. `GET /api/v1/workspace/runs-index` and assert **both exact run ids appear in it**
      (membership, not a count delta, which cannot tell this run's two rows from a concurrent
      task's). Record `page.url()` into the verdict object at that moment.
   3. **Cancel both runs now.** This is the end of the spend window.
   4. **Wait for both run ids in the page DOM**, one selector per id:
      `page.waitForSelector('[data-slot="global-task-row"][data-run-id="<id>"]')` for each, bounded
      (30s is generous). No reload, and no navigation: the batch's own success handler invalidates
      `workspaceQueryKeys.runsIndex` (`global-tasks.tsx:1540`) and the global SSE stream invalidates
      it again on each run event (`packages/web/src/api/global-events.tsx:125,158`), so the rows
      arrive by refetch into the already-mounted page. A `page.reload()` here would make the
      no-navigation assertion vacuous, so it is forbidden; if the rows do not arrive, that is a
      **failure to report**, not a thing to reload around. The row markup is
      `<tr data-slot="global-task-row" data-run-id={run.id} …>` at `global-tasks.tsx:1944`, with the
      below-`md` card carrying the same `data-run-id` at `:2138`.
   5. **Re-assert `page.url() === beforeUrl` after that UI refresh**, which is the assertion that
      actually rules out a late navigate: the first check runs milliseconds after the click, before
      any refetch has landed.
   6. Read both DOM run ids back out of the matched elements (`getAttribute('data-run-id')`) and put
      them, plus the final `page.url()`, into the verdict object. The verdict names what the browser
      saw, not what the script hoped it would see.
   7. Only now delete the runs (P0 step 5's `409` polling applies), then the todos.
5. **Delete the assertion that both rows leave the Filed table** (currently lines 113-115, a 15s
   wait per todo). It cannot coexist with cancelling first: `POST /runs/:id/cancel` calls
   `clearStartedTaskId` (`server.ts:5202`) and deliberately restores the originating todo
   (`.ai/specs/2026-08-22-run-cancel-restores-todo.md`), so the rows come **back**. The
   no-navigation assertion plus the two `201`s plus run-id membership in the runs index already
   prove the feature; a row-disappearance assertion proves the cancel semantics, which is a
   different spec's subject.
6. Keep `page.on('response')` registered **before** the click, keep the `beforeUrl === page.url()`
   no-navigation assertion, keep the `2 selected` and `Run 2 tasks` text assertions.
7. Keep video recording on (`recordVideo`) and the three full-page screenshots. Add a fourth,
   `04-runs-visible.png`, taken once both `data-run-id` rows have matched, so the browser evidence
   shows the thing the acceptance criterion asks about.
8. Print the two JSON verdict lines on stdout, and **copy both into the run handoff.** The verdict
   object carries `domRunIds` (the two ids read back off the matched rows), `beforeUrl` and
   `finalUrl`.
9. **Re-read release identity after the browser closes, and compare it with P1.** R3 promises this
   and the earlier draft never executed it. `GET /api/v1/ready` authenticated, and compare `sha` and
   `activatedAt` against the values P1 recorded:
   - **Both equal:** declare PASS against release `<releaseId>` and say so in the verdict line.
   - **Either changed:** a concurrent activation happened mid-E2E. Do **not** attribute the result
     to P1's release. Record both identities verbatim in the handoff and **re-run P2 against the
     now-stable release**, starting from a fresh P1 read. Only the second, uncontaminated run
     counts as the pass.

   This read happens before PASS is declared, not after, so a PASS is never printed against an
   unknown build.

Sequence, in order: authenticated preflight (`200`) → `cezar todo add` two disposables → launch
chromium with the `cez_session` cookie on `127.0.0.1` → `goto /tasks` → screenshot → snapshot
`beforeUrl` and the runs-index length → check both row checkboxes → screenshot → assert the
selection bar is visible, the count reads `2 selected`, the button reads `Run 2 tasks` → click →
assert the URL is unchanged → screenshot → wait for two `201`s, **each already written to
`reap.ndjson` by its own handler** → assert both start paths name the two todo ids → assert both run
ids are present in the authenticated runs index and record `page.url()` → **cancel both runs, now**
→ wait for `[data-run-id="<id>"]` for both ids in the page DOM → screenshot `04-runs-visible.png` →
**re-assert `page.url() === beforeUrl`** and read both ids back off the matched rows → delete both
runs (polling through `409`) → delete both todos → assert ground truth authenticated, against the
union of sidecar and in-memory ids → destroy the session → close the browser → re-read
`GET /api/v1/ready` and compare with P1.

**Done when:** stdout carries `"verdict":"PASS"` and `"cleanup":"PASS"`, both lines are in the
handoff, `domRunIds` in the verdict equals the two started run ids and `finalUrl` equals
`beforeUrl`, the artifact directory holds four PNGs plus one `.webm` plus a two-line `reap.ndjson`,
the post-E2E `/api/v1/ready` `sha` and `activatedAt` match P1's, and the ground-truth assertion
(tombstone-aware, per P0 step 7) confirms nothing disposable survives as a live row.

### P3. File the corpus proposal, and report the searchable half blocked

**One write, one mechanism: a proposal appended to `$CEZ_KB_WRITE_FILE`.** Per § P-E, this run's
knowledge protocol permits nothing else. Concretely, and stated as prohibitions because the first
draft of this spec proposed both of them: **do not** hand-write a file into
`/var/lib/cezar/loki-labs/notion-export/` and reindex it (that is a direct edit of a mounted
document), and **do not** call `cez kb write` (that bypasses the proposal queue the protocol
requires).

1. **Read the file first, to pick `seq`.** The target is
   `/var/lib/cezar/loki-labs/cezar/.ai/cezar/runs/480e0282-a967-4936-a12e-3c4e56450586.knowledge.ndjson`
   (`$CEZ_KB_WRITE_FILE`). Measured while writing this spec: it **does not exist**, so `seq` is `0`
   unless an earlier step in this chain has since appended, in which case it is one past the highest
   `seq` present. Count from the file, never from memory.
2. **Append exactly one line**, schema-valid against `knowledgeProposalSchema`. A line that fails
   validation is silently DROPPED rather than reported
   (`packages/cezar/src/knowledge/proposals.ts:46-70`), which is why step 3 reads it back. **What
   the contract actually requires** (`packages/contract/src/knowledge.ts:240-260`,
   `knowledgeUpsertProposalSchema` extending `knowledgeProposalBaseSchema`): `seq`, `runId` and
   `createdAt` from the base, plus `op`, `scope`, `path` (min length 1) and `body`. `title`, `type`,
   `tags` and `supersedes` are **optional** and have no defaults. The sample below is complete
   rather than minimal on purpose, because a proposal a human has to review deserves a title and
   tags, but do not carry away from it that every field is mandatory:
   ```json
   {"op":"upsert","scope":"project","path":"decisions/2026-08-25-bulk-start-filed-tasks-release.md",
    "title":"Bulk start filed tasks: release verification","type":"note",
    "tags":["cezar","tasks","deploy","verification"],"supersedes":[],"body":"...",
    "seq":0,"runId":"480e0282-a967-4936-a12e-3c4e56450586","createdAt":"<ISO-8601>"}
   ```
   One object on one line. `scope: "project"` puts it under the cezar project's own knowledge root,
   which is where a decision about cezar's release belongs.
3. **Validate it by reading it back through the real reader**, not by eyeballing the JSON. From the
   worktree: `npx tsx -e` importing `readRunProposals` from
   `packages/cezar/src/knowledge/proposals.ts` with
   `dataDir = /var/lib/cezar/loki-labs/cezar/.ai/cezar` and
   `runId = 480e0282-a967-4936-a12e-3c4e56450586`; it must return an array containing your proposal
   with the `seq` you wrote. An empty array means the line was dropped as invalid, which is the
   failure mode this step exists to catch. `CEZ_KB=1 cez kb proposals` from the repo root is a
   secondary check on the same file.
4. **Report the searchable half as BLOCKED, not green.** Applying the proposal is a human step
   through the cockpit or `cez kb proposals`, and the supported route refuses today
   (`knowledge-routes.ts:68`, `:239-258`). So `cez kb search` will not find this document during
   this run, and no amount of reindexing changes that: nothing has written a document yet. Say
   exactly that in the handoff, name the file and the `seq`, and mark acceptance criterion 6 **half
   met**.
5. End the session that touched the box with
   `find /var/lib/cezar -not -user cezar | wc -l`, which must print `0`.

**There is a second, PENDING proposal about this same feature, and it is wrong on two points.** The
parent task left one at
`/var/lib/cezar/workspace/.ai/cezar/runs/e6592588-1628-40e0-b31a-8fe26c8b2220.knowledge.ndjson`
(2,462 bytes, one `upsert` line, `seq: 0`, `createdAt: 2026-08-24T21:50:00Z`, `scope: "project"`,
`path: "cezar/bulk-start-filed-tasks.md"`, measured 2026-08-25). It is still unapplied, for the same
reason this one will be. It is **not** invalidated by this run's proposal living at a different
`path` in a different run's file, and an empty `supersedes` array on the new line does not reach it
either: nothing links them. Two stale claims in its body:

1. It states design call 2 as `selectedFiledEntries(sorted, selected)`. The shipped code derives the
   batch from the **rendered** `rows`, not `sorted` (`global-tasks.tsx:782-799`); that was the
   earlier pass's P1.5 correction, because a row hidden by `FILED_ROW_PAGE_SIZE` pagination would
   otherwise start, which the feature spec forbids. Its regression test is
   `global-tasks.test.tsx:1515-1574`.
2. It says "**Status: QA needed** … The runtime E2E on the prod cockpit … has NOT been run", and
   describes the full `npm run test` as red on two pre-existing failures. Both statements are about
   a moment that has passed once P1.5 and P2 land.

So P3 has two obligations beyond appending a line:

- **The new `body` must correct both claims explicitly**, naming the old wording, so the correction
  is legible to a reader who has only the new document (house doctrine: a correction marks what it
  invalidates, in place, and where two records disagree the stale one is what the next session
  reads first).
- **The report must name the pending parent proposal by its absolute path and say what should happen
  to it:** when a human reviews this run's proposal, the parent's must be **rejected or discarded**
  rather than applied, because applying it would write the two stale claims into the corpus as
  current. If a future applier grows a way to link them, `supersedes` is the field for it; today it
  cannot reference a proposal that has never become a document.

Beyond those corrections, the `body` should say the things a future session would otherwise
re-derive: that the feature shipped in `7932cf4d` and went live in release
`20260825T082047Z-d217ab2e`; that the five gates were re-run on a clean checkout of that exact
commit because the original gate run predated the `ea40c7a1` fast-forward, with the outcome; that
agent-run cezar deploys are manual and a green probe here means inheritance, not activation; and
that a browser E2E which starts disposable todos launches **real** `spec-to-deploy` runs and must
cancel them within milliseconds or it costs millions of tokens (this run's own leak reached 6.7
million in 28 minutes, and 11.9 million by the time this spec was revised).

**Done when:** `readRunProposals` returns the proposal, the handoff records the searchable half as
blocked on human application with the file path and `seq` named, and the pending parent proposal is
named with a recommendation to reject it.

### P4. Leave the worktree clean, and commit nothing

**Corrected 2026-08-25: this phase edits no tracked file, makes no commit and pushes nothing.** An
earlier draft of it planned a `docs:` commit that would correct three stale status headers in place
and add this spec plus its brief to the repo. That work is **not authorized by this task**, for two
independent reasons:

- **The predecessor spec already removed exactly this phase, deliberately.**
  `.ai/specs/2026-08-24-ship-bulk-start-filed-tasks.md:961-971` (its P6) states that the phase
  "edits no file in the repository", that a post-deploy edit to the feature spec "would dirty the
  working tree after the commit, the push, the gates and the activation, and would make 'the gates
  ran on the exact committed tree' false in retrospect", that "an earlier draft of this phase did
  exactly that and it is removed here", and that updating the feature spec's status line in the
  repository "is a **second commit**; it is not authorized by this task and is left for the owner to
  ask for explicitly, with the exact-tree guarantees restated". This spec's P4 was that removed
  draft, reintroduced.
- **One commit per session or feature**, and this run has already made and pushed it: `7932cf4d`
  ("feat: bulk start filed tasks"), now an ancestor of `origin/main`. A second commit from the same
  run is the thing that rule forbids.

**So the three stale headers stay stale in the repository, and the report says so.** The record of
what actually happened lands in the run handoff and in the P3 proposal, which are the two places
this run is permitted to write. Correcting
`.ai/specs/2026-08-24-ship-bulk-start-filed-tasks.md`'s "Nothing in this document has been executed
yet", moving `.ai/specs/2026-08-24-bulk-start-filed-tasks.md` to Implemented, and committing this
spec are **one deferred follow-up**, to be named explicitly in the handoff as needing owner
authorization. Do not do any of it on inference from acceptance criterion 6.

**The reconcile is gone too**, because it only ever existed to make a push possible. There is no
push, so there is nothing to fast-forward for. `git fetch origin` still happens in P1, for the
ancestor check; the branch itself stays at `7932cf4d`, which is also what keeps the backend probe's
`HEAD` meaningful across P1 and P2.

What remains is cleanup, so the worktree ends in a state a human can read at a glance:

1. **Drop the three intent-to-add index entries.** All three paths are empty-blob entries
   (`e69de29b`, `git status` files them under "Changes not staged for commit"), which is neither
   tracked nor untracked and confuses every clean check:
   ```bash
   git rm --cached --quiet .ai/specs/2026-08-25-verify-bulk-start-release.md \
                           .ai/specs/briefs/2026-08-25-bulk-task-starts.md \
                           .e2e-bulk-start.cjs
   git status --porcelain --untracked-files=all   # expect ?? lines only, nothing staged
   ```
   `git rm --cached` drops the index entry and leaves the file on disk as untracked; it deletes no
   content. Confirm all three files still exist before continuing. If P2 already moved the helper
   out of the worktree, its `git rm --cached` has already run there and this list is two paths.
2. **The E2E helper must be outside the worktree.** P2 moves it to
   `$E2E_DIR/e2e-bulk-start.cjs`. Leave it there deliberately as the task's own artifact; it is
   never tracked (§ Out of scope).
3. **Preserve this spec and its brief as task-private artifacts, then clear them from the worktree
   as the final action of the run.** Copy both into
   `.../tmp/480e0282-…/artifacts/` first, verify the copies, then remove the worktree originals.
   **Timing matters:** later steps of this nine-step chain still read this spec, so the removal is
   the last thing that happens, after the final step that needs it. If the run ends before that, say
   plainly in the handoff that the worktree still carries two untracked files and name them; a
   documented dirty worktree is honest, a silently dirty one is not.
4. **Record the deferred follow-up.** File it as a todo (`cezar todo add`) naming the three headers,
   the exact corrections they need, and the fact that landing them is a second commit requiring
   owner authorization. A follow-up that exists only in a final message is not filed.

**Done when:** `git diff --cached --name-only` prints nothing and no empty-blob index entry remains;
`.e2e-bulk-start.cjs` is not inside the worktree; this spec and its brief exist under
`artifacts/`; **no commit was created and nothing was pushed** (`git rev-parse HEAD` still prints
`7932cf4d83ff6a4f263ae7181ec0d8e9fa81ea7f`); and the deferred header corrections are filed as a todo
and named in the handoff.

## Data models and API contracts

**Nothing new.** This spec adds no endpoint, no schema and no field. The contracts it consumes,
all pre-existing:

| call | shape | used by |
| --- | --- | --- |
| `POST /api/v1/p/:project/todos/:id/start` | body optional (`prompt`, `runner`, `model`); `201 {run}`; `409 {error:"already started"}` | the feature under test; `server.ts:6164-6199` |
| `GET /api/v1/workspace/runs-index` | `{runs:[…]}`; `401` unauthenticated | E2E before/after counts |
| `GET /api/v1/workspace/todos` | `{todos:[{todo,project},…]}`; `401` unauthenticated | preflight and ground truth |
| `POST /api/v1/runs/:id/cancel` | `200`; also clears `startedTaskId` and restores the todo | P0 and P2 cleanup |
| `DELETE /api/v1/runs/:id` | `200` / `404`; **`409` while the run is still active** | P0 and P2 cleanup |
| `DELETE /api/v1/p/cezar/todos/:id` | `200` / `404` | P0 and P2 cleanup |
| `GET /api/v1/ready` | uncached by construction, `503` until ready, carries `deploy{releaseId,sha,activatedAt,builtAt,dirty}` | P1, and both declared probes |

The one **new artifact format** is the E2E's sidecar reap file, `reap.ndjson`, one JSON object per
line: `{"runId":"<uuid>","todoId":"<uuid>","at":"<iso8601>"}`. It is scratch under
`.ai/cezar/tmp/<taskId>/e2e/<stamp>/`, never tracked, and exists only so a crashed E2E leaves a
machine-readable cleanup list.

`GET /api/v1/health` is deliberately **not** used anywhere here: it is cached
stale-while-revalidate and past `HEALTH_MAX_STALE_MS` the read blocks on a fresh snapshot, which is
what silently killed an earlier deploy probe (`.ai/deploy-targets.json` `$comment`, correction of
2026-08-21).

## Risks

**R1. Reaping the leaked runs destroys evidence about why the 08:18 E2E died.** Real, and accepted:
the runs cost money continuously and the diagnosis is not worth the burn. **Corrected 2026-08-25:**
this risk previously ended "the run NDJSON transcripts under `.ai/cezar/runs/` also survive run
deletion long enough to read if needed", which is false. `RunStore.deleteRun`
(`packages/cezar/src/runs/store.ts:1364-1379`) `rmSync`s `eventsPath(id)`, `handoffPath(id)` and
`imagesDir(id)` the moment the index entry goes, best-effort and unrecoverable. Mitigation is
therefore P0 steps 1 and 2, which **copy** both transcripts, both handoffs and the two run records
into the preserved `2026-08-25T0818Z-orphaned/` directory before any cancel or delete is issued, and
which move the 08:18 browser artifacts there rather than overwriting them.

**R2. The E2E starts two more real runs and leaks again.** This is the failure that already
happened once. Mitigated three ways: cancel moved into the main path immediately after the two
`201`s; the sidecar `reap.ndjson` written before any assertion can throw; and the `finally` block
retained. Residual risk: a SIGKILL between the click and the sidecar write, a window of
milliseconds. Accepted.

**R3. A concurrent task deploys mid-E2E** and the assertions run against a different release than
the one P1 recorded. cezar is one service on a shared box and this is exactly why the backend probe
accepts a descendant rather than demanding equality. Mitigation: re-read `GET /api/v1/ready` after
the E2E and report both `activatedAt` values. If they differ, say so plainly and re-run rather than
reporting a pass against an unknown build.

**R4. Someone reads acceptance criterion 4 as an instruction to deploy.** That would reverse an
owner decision. Mitigated by P1 step 5 stating the refusal explicitly and by § P-D citing
`AGENTS.md:5-12`, `.ai/deploy-targets.json`, and
`.ai/specs/2026-08-24-manual-deploy-not-a-bug.md`.

**R5. The record is reported as searchable when nothing has been written to any knowledge root.**
This is the live risk, and it is the opposite of the one this slot used to describe. **Corrected
2026-08-25:** R5 previously said the corpus write "lands on disk and never reaches the index" and
was mitigated by "P3 step 1 running an explicit `cez kb reindex` and grepping the **slug** in
`catalog.ndjson`, and by step 3 proving the search itself". That contradicts P3 and V6 as they now
stand, and it describes a phase this spec does not have: **P3 writes no document.** It appends one
proposal line to `$CEZ_KB_WRITE_FILE`, which is the only write path this run's knowledge protocol
permits (§ P-E). A proposal is not a corpus document, so there is nothing on disk for `fs.watch` to
notice and nothing for `cez kb reindex` to index; running a reindex here would produce a green-
looking command and prove nothing at all.

What actually validates the write is `readRunProposals` returning the line (V6), because a line that
fails `knowledgeProposalSchema` is dropped silently rather than reported
(`packages/cezar/src/knowledge/proposals.ts:46-70`). What stays unmitigated is searchability: it
requires a human to apply the proposal, and the supported route refuses every `seq` today with
`PROPOSAL_APPLY_NOT_AVAILABLE` (`packages/cezar/src/server/knowledge-routes.ts:68`, handler
`:239-258`), even though `applyKnowledgeProposals` exists and is tested (`proposals.ts:81`). So the
mitigation is honesty, not a command: report acceptance criterion 6 as **half met, blocked on an
applier that is not wired**, name the file and `seq`, and do not present an empty `cez kb search` as
either a pass or a defect of this run.

**R6. A file lands owned by `root`.** Writes here must be made as `cezar`; a `root:root` file in
cezar's tree still indexes (the reader only needs read) so the write looks entirely successful,
while `cezar.service` gets `EACCES` on it forever. Mitigated by P3 step 4's
`find /var/lib/cezar -not -user cezar | wc -l` returning `0`.

**R7. The E2E asserts against a stale session or the wrong user id.** `/tasks` returns `200`
unauthenticated, so an unauthenticated run renders an empty Filed table and every assertion fails as
a false feature bug. Mitigated by the authenticated preflight in P2 step 1: if
`GET /api/v1/workspace/todos` is not `200` the script aborts before touching the browser.

## Verification

Concrete, executable, in order. Every one of these was either run while writing this spec (marked
**measured**) or is a direct instruction for the executing step.

**V0, the leak is gone.** Two things this check must get right, and the earlier draft got the second
one wrong.

Absolute paths on purpose: the worktree has its own `.ai/cezar/` with its own `todos.json`, and a
relative check run from the worktree reads that one instead of the store the server mutates,
reporting a clean reap that never happened.

**Parse both stores structurally.** A deleted todo is a **tombstone, not a removal**
(`packages/cezar/src/todos.ts:469-484`), so it stays in `todos.json` carrying `tombstone: { at }`
until retention compacts it. `grep -c "E2E disposable"` therefore keeps printing `2` after a
completely successful reap, and a concatenated-blob `includes` on the raw id conflates a tombstoned
row with a live one. Both were the earlier draft's gate and neither can pass. Runs are different: a
run delete really does remove the record, so absence is the right test there. Both files are
top-level JSON arrays (measured).

```bash
export CEZ=/var/lib/cezar/loki-labs/cezar/.ai/cezar
node -e '
  const fs=require("fs"), C=process.env.CEZ;
  const load=f=>{const r=JSON.parse(fs.readFileSync(C+"/"+f,"utf8"));
    return Array.isArray(r)?r:(r.todos||r.runs||r.items||[]);};
  const todos=load("todos.json"), runs=load("runs.json");
  const TODO_IDS=["2d0b837a-b71b-4c7f-af43-929060e0ef66","520e2bbe-4abe-4a3a-8bc9-c818968be2aa"];
  const RUN_IDS=["ae7bd42f-a399-4ceb-92cf-d657e620d80f","a3dd8f5f-5d66-402e-b876-c1a6746d9da7"];
  const survivingRuns=runs.filter(r=>RUN_IDS.includes(r.id)).map(r=>[r.id,r.status,r.tokensUsed]);
  const liveTodos=TODO_IDS.filter(id=>{const t=todos.find(x=>x.id===id); return t && t.tombstone===undefined;});
  const strayLive=todos.filter(t=>t.tombstone===undefined
    && String(t.summary||t.title||"").includes("E2E disposable")).map(t=>t.id);
  console.log(JSON.stringify({survivingRuns, liveTodos, strayLive},null,1));'
# want {"survivingRuns":[], "liveTodos":[], "strayLive":[]}
# measured while revising this spec: survivingRuns = both "running" (5,398,675 and 6,521,110 tokens),
#   liveTodos = []  (both todos ALREADY tombstoned at 2026-08-25T08:18:56Z: the 08:18 E2E's todo
#   cleanup did run, only its run cleanup did not), strayLive = [].
```
Then, **authenticated**, before the session is destroyed: `GET /api/v1/workspace/runs-index` and
`GET /api/v1/workspace/todos` must each return `200`, the runs index must contain neither run id,
and the todos response must contain neither todo id. A `401` from either is a failed check, not a
pass: an unauthenticated read returns no rows and would "exclude" every id trivially.

**V1, the code is on main and byte-identical.**
```bash
git fetch origin
git merge-base --is-ancestor HEAD origin/main && echo ANCESTOR_OK          # measured: exits 0
git diff --stat HEAD origin/main -- \
  packages/web/src/routes/global-tasks.tsx packages/web/src/lib/filed-tasks.ts \
  packages/web/src/lib/filed-tasks.test.ts packages/web/src/routes/global-tasks.test.tsx
# want: no output   (measured: no output)
```

**V1.5, the five gates on the exact commit.** This is acceptance criterion 3 and it has never been
run. NOT measured while writing this spec: it is the executing step's job.
```bash
export GATES=/var/lib/cezar/loki-labs/cezar/.ai/cezar/tmp/480e0282-a967-4936-a12e-3c4e56450586/gates-7932cf4d
git worktree add --detach "$GATES" 7932cf4d83ff6a4f263ae7181ec0d8e9fa81ea7f
git -C "$GATES" rev-parse HEAD^{tree}     # MUST print 89d05604e33d92b6a94151f36d2e6ffe36e54740
git -C "$GATES" status --porcelain --untracked-files=all   # want empty
cd "$GATES" && npm ci                                  ; echo "CI_EXIT=$?"
npm run typecheck                                      ; echo "TYPECHECK_EXIT=$?"
env -u CLAUDE_CONFIG_DIR npm test                      ; echo "TEST_EXIT=$?"
npm run test:unit                                      ; echo "UNIT_EXIT=$?"     # want 44/44
npm run build                                          ; echo "BUILD_EXIT=$?"
npm run test:package                                   ; echo "PACKAGE_EXIT=$?"  # want 25/25
```
Every `*_EXIT` must be `0` and all six lines must be quoted in the handoff. Redirect each to a file
and block on the `EXIT=` marker rather than guessing a sleep. `env -u CLAUDE_CONFIG_DIR` is not
optional (§ P1.5 step 3). Remove the checkout with `git worktree remove "$GATES" && git worktree
prune` only after the exit codes are recorded.

**V2, both declared probes, verbatim, from this worktree.** Write the extracted probes into a
task-private `mktemp -d` directory, never a shared `/tmp/probe-*.sh`: this box runs several cezar
tasks at once and a fixed name is a collision another task can win between the write and the run.
```bash
export PROBE_DIR=$(mktemp -d)
node -e 'const fs=require("fs");const p=process.env.PROBE_DIR;
  const t=JSON.parse(fs.readFileSync(".ai/deploy-targets.json","utf8"));
  fs.writeFileSync(p+"/probe-backend.sh",t.targets[0].probe);
  fs.writeFileSync(p+"/probe-ui.sh",t.targets[1].probe)'
bash -lc 'bash "$PROBE_DIR/probe-backend.sh"'; echo "BACKEND_EXIT=$?"   # measured: 0
bash -lc 'bash "$PROBE_DIR/probe-ui.sh"';      echo "UI_EXIT=$?"        # measured: 0
rm -rf "$PROBE_DIR"
```
Measured output today: `live=d217ab2e9526e68248cad06c089fb887dff7c48b is a descendant of
HEAD=7932cf4d83ff6a4f263ae7181ec0d8e9fa81ea7f` and `serving assets/index-BpuMuVjc.js == the built
bundle`.

**V3, the live bundle really contains the feature.**
```bash
grep -l 'start-selected-filed-tasks' /opt/cezar/packages/cezar/web/dist/assets/index-*.js  # measured: index-BpuMuVjc.js
grep -l 'filed-selection-bar'        /opt/cezar/packages/cezar/web/dist/assets/index-*.js  # measured: index-BpuMuVjc.js
curl -fsS http://127.0.0.1:4321/api/v1/ready | python3 -m json.tool | sed -n '/deploy/,$p'
```

**V4, the browser E2E.** The artifact directory is created in the shell and handed to the helper
through the environment, so that one path is shared by the `mkdir`, the script's `OUT` and the
redirection. In the previous draft `$OUT` existed only as a JavaScript constant inside the helper,
so the shell expanded it to the empty string and the redirect failed before the script ever ran.
```bash
export E2E_DIR=/var/lib/cezar/loki-labs/cezar/.ai/cezar/tmp/480e0282-a967-4936-a12e-3c4e56450586
export E2E_OUT="$E2E_DIR/e2e/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$E2E_OUT"
cd /var/lib/cezar/loki-labs/cezar/.ai/cezar/worktrees/480e0282-a967-4936-a12e-3c4e56450586
npx tsx "$E2E_DIR/e2e-bulk-start.cjs" > "$E2E_OUT/verdict.log" 2>&1; echo "E2E_EXIT=$?"
grep -q '"verdict":"PASS"' "$E2E_OUT/verdict.log" && grep -q '"cleanup":"PASS"' "$E2E_OUT/verdict.log"
ls -la "$E2E_OUT"  # want: 01-filed.png 02-selected.png 03-after-start.png 04-runs-visible.png
                   #       *.webm reap.ndjson verdict.log
wc -l "$E2E_OUT/reap.ndjson"   # want 2 (one line per started run, written by its own handler)
```
The helper reads `E2E_OUT` from `process.env` and fails fast if it is unset, rather than falling
back to a hardcoded path that the shell is not looking at. The exit code alone is not the gate: the
script sets `process.exitCode = 1` on cleanup failure as well as assertion failure, so **both** JSON
lines must be quoted in the report, not summarised.

**The browser half of the acceptance criterion is asserted in the DOM, not in the API** (P2 step 4).
Mirrored here so this section is executable on its own:

```bash
node -e '
  const fs=require("fs"), out=process.env.E2E_OUT;
  const v=fs.readFileSync(out+"/verdict.log","utf8").split("\n")
    .filter(l=>l.trim().startsWith("{")).map(l=>JSON.parse(l))
    .find(o=>o.verdict);
  const reap=fs.readFileSync(out+"/reap.ndjson","utf8").trim().split("\n").map(l=>JSON.parse(l));
  const started=reap.map(r=>r.runId).sort();
  const dom=(v.domRunIds||[]).slice().sort();
  console.log(JSON.stringify({
    verdict:v.verdict,
    domMatchesStarted: JSON.stringify(dom)===JSON.stringify(started),
    urlUnchanged: v.finalUrl===v.beforeUrl,
    beforeUrl:v.beforeUrl, finalUrl:v.finalUrl, domRunIds:dom,
    releaseStable: v.readyBefore && v.readyAfter
      && v.readyBefore.sha===v.readyAfter.sha
      && v.readyBefore.activatedAt===v.readyAfter.activatedAt,
    readyBefore:v.readyBefore, readyAfter:v.readyAfter},null,1));'
# want verdict "PASS", domMatchesStarted true, urlUnchanged true, releaseStable true
```

`domMatchesStarted` is the assertion that "two runs appear on `/tasks`": the ids came off
`[data-slot="global-task-row"][data-run-id="<id>"]` elements in the live page
(`global-tasks.tsx:1944`), not out of an API response. `urlUnchanged` is checked **after** that DOM
refresh, which is what rules out a late navigate. `releaseStable` is R3's promised comparison: if it
is `false` a concurrent activation landed mid-E2E, and the result is attributed to no release and
re-run against a stable one (P2 step 9) rather than reported as a pass.

**V5, no orphan created by V4.** Re-run V0 verbatim after the E2E, then additionally require that
**this run's own exact ids**, read from the sidecar rather than from memory, are clean. Same
structural rule as V0 and for the same reason: the run ids must be gone from `runs.json`, while the
todo ids need only be gone **or tombstoned**, because a tombstone is what a successful todo delete
leaves behind (`todos.ts:469-484`).
```bash
node -e '
  const fs=require("fs"), C=process.env.CEZ;
  const load=f=>{const r=JSON.parse(fs.readFileSync(C+"/"+f,"utf8"));
    return Array.isArray(r)?r:(r.todos||r.runs||r.items||[]);};
  const todos=load("todos.json"), runs=load("runs.json");
  const reap=fs.readFileSync(process.env.E2E_OUT+"/reap.ndjson","utf8").trim().split("\n")
    .map(l=>JSON.parse(l));
  const survivingRuns=reap.map(r=>r.runId).filter(id=>runs.some(x=>x.id===id));
  const liveTodos=reap.map(r=>r.todoId)
    .filter(id=>{const t=todos.find(x=>x.id===id); return t && t.tombstone===undefined;});
  console.log(JSON.stringify({checked:reap.length*2, survivingRuns, liveTodos}));'
# want {"checked":4,"survivingRuns":[],"liveTodos":[]}
```
Then, still authenticated: `GET /api/v1/workspace/runs-index` and `GET /api/v1/workspace/todos` both
`200`, and neither response contains any of the four ids.

Neither a count delta nor a text grep is acceptable here. A count-based check nets to zero when two
disposable rows are deleted while a concurrent task creates two of its own, and reads as clean; a
`grep -c` on the raw file reports every tombstone as a survivor and never reads as clean at all.

**V6, the record. The write half is verifiable here; the search half is not, and must be reported
blocked** (§ P-E). Verify the proposal by reading it back through the same reader the server uses,
which is the only check that catches a line the schema silently drops:
```bash
cd /var/lib/cezar/loki-labs/cezar/.ai/cezar/worktrees/480e0282-a967-4936-a12e-3c4e56450586
npx tsx -e 'import {readRunProposals} from "./packages/cezar/src/knowledge/proposals.ts";
  const p = await readRunProposals("/var/lib/cezar/loki-labs/cezar/.ai/cezar",
    "480e0282-a967-4936-a12e-3c4e56450586");
  console.log(JSON.stringify(p.map(x=>({seq:x.seq, op:x.op, scope:x.scope, path:x.path})), null, 1))'
# want exactly one entry, op "upsert", scope "project", with the seq you appended.
# An empty array means the line failed knowledgeProposalSchema and was DROPPED.
CEZ_KB=1 cez kb proposals            # secondary check on the same file
```
Do **not** run `cez kb reindex` and claim a pass from it: nothing has been written into any
knowledge root, so there is nothing to index. `cez kb search "bulk start filed tasks"` returning
nothing is the **expected** result of this run and is not a failure of this phase. Acceptance
criterion 6 is reported **half met: written, not searchable, blocked on human application**
(`knowledge-routes.ts:68` refuses every apply today).

**V7, ownership.**
```bash
find /var/lib/cezar -not -user cezar | wc -l   # want 0
```

**V8, P4 changed nothing tracked and committed nothing.** The check is the inverse of what this slot
used to assert: the earlier draft verified that a `docs:` commit had landed and been pushed, which
is the unauthorized second commit P4 now refuses (§ P4).
```bash
git rev-parse HEAD          # want 7932cf4d83ff6a4f263ae7181ec0d8e9fa81ea7f, UNCHANGED by this run
git diff --cached --name-only                        # want empty (no intent-to-add entries left)
git diff --name-only                                 # want empty (no tracked file modified)
git ls-files --format='%(objectname) %(path)' | grep e69de29bb2d1d6434b8b29ae775ad8c2e48c5391
                                                     # want no match (the empty-blob entries are gone)
test ! -e .e2e-bulk-start.cjs && echo HELPER_MOVED_OUT
ls .ai/cezar/tmp/480e0282-a967-4936-a12e-3c4e56450586/artifacts/   # want the spec and the brief
git status --porcelain --untracked-files=all         # expect empty, or exactly the two ?? spec
                                                     # lines if a later step still needs them
```
`git rev-parse HEAD` being unchanged is the assertion that matters, and it is deliberately **not**
compared with `origin/main`: this branch stays behind main because there is no push to fast-forward
for. If `git status` is not empty, the handoff must name each remaining path and say why, rather
than the run reporting a clean tree it does not have.

**Gates.** V1.5 is the gate run of record for `7932cf4d`. The handoff's `23:57Z` run
(`npm run typecheck`, `npm test` at 11,784 passed / 4 skipped, `npm run test:unit` 44/44,
`npm run build`, `npm run test:package` 25/25, all exit 0) is real but was taken on a **pre-merge**
tree, so it is evidence about the code, not about the commit; the numbers above are useful only as
the expected shape for V1.5. No later phase commits anything, so there is no second tree to gate:
P4 changes no tracked file at all (§ P4). If any phase ends up modifying a file under `packages/`,
that is a scope change, and it needs all five gates re-run plus an owner decision about the commit
it would require.

## Out of scope

- **Re-applying the parent diff or making a second feature commit.** Already on main; § P-A.
- **Any second commit at all, including a `docs:` one.** Correcting the three stale status headers
  (`.ai/specs/2026-08-24-ship-bulk-start-filed-tasks.md`,
  `.ai/specs/2026-08-24-bulk-start-filed-tasks.md`, and this spec's own) and committing this spec to
  the repo are right, and they are a **second commit this task does not authorize** (§ P4,
  `.ai/specs/2026-08-24-ship-bulk-start-filed-tasks.md:961-971`). Filed as a follow-up todo for the
  owner to approve; not done here.
- **Running `cezar server-deploy`.** Owner decision, § P-D.
- **Flipping `manual` to `false`** in `.ai/deploy-targets.json`, for the same reason.
- **Tracking `.e2e-bulk-start.cjs`.** It stays a scratch helper and moves out of the worktree into
  the task tmp directory (§ P2), so it can never enter a commit. Promoting it to a real
  suite would need it to stop starting real `spec-to-deploy` runs, which is a design change and a
  separate spec.
- **Giving `cezar todo add` a `--workflow` flag** so a disposable todo can start a trivial run
  instead of a full chain. That is the durable fix for P-B's cost, and it is a feature. File it as a
  todo rather than doing it here.
- **`eff223d4-7070-42c3-b56e-f16fb027c753`** (config API ambient `CLAUDE_CONFIG_DIR` isolation),
  already filed by the gate step and unrelated.

## Measured facts

Every claim in this spec traces to one of these, each re-measured on 2026-08-25 from the worktree at
`7932cf4d` unless stated.

1. `git rev-parse HEAD` = `7932cf4d83ff6a4f263ae7181ec0d8e9fa81ea7f`; `git rev-parse origin/main` =
   `d217ab2e9526e68248cad06c089fb887dff7c48b`; `git merge-base --is-ancestor 7932cf4d origin/main`
   exits 0.
2. Local `main` = `b3d3a44cf8a122b9242fc138eb6c6ac79aa15f47`, stale and **not** evidence of current
   main; read `origin/main` after a fetch instead. (This fact previously ended "which is why the
   push is spelled `git push origin HEAD:main`". **Corrected 2026-08-25:** this run pushes nothing,
   § P4. The fact about local `main` being stale still holds.)
3. `git diff --stat 7932cf4d origin/main -- <the four feature paths>` prints nothing.
4. `git show --stat 7932cf4d` = 7 paths, 1799 insertions, 350 deletions:
   `.ai/specs/2026-08-24-bulk-start-filed-tasks.md` (+71),
   `.ai/specs/2026-08-24-ship-bulk-start-filed-tasks.md` (+1330),
   `packages/cezar/test/unit/deploy-e2e-probe.test.ts` (-348, deliberate),
   `packages/web/src/lib/filed-tasks.test.ts` (+53), `packages/web/src/lib/filed-tasks.ts` (+43),
   `packages/web/src/routes/global-tasks.test.tsx` (+151/-), `packages/web/src/routes/global-tasks.tsx` (+153).
5. `git remote -v` lists only `origin` = `https://github.com/MarcinWalendowski/cezar.git`.
6. `GET http://127.0.0.1:4321/api/v1/ready` → `{"ready":true,"version":"0.10.0",…,"deploy":
   {"releaseId":"20260825T082047Z-d217ab2e","sha":"d217ab2e9526e68248cad06c089fb887dff7c48b",
   "activatedAt":"2026-08-25T08:20:53.041Z","builtAt":"2026-08-25T08:20:47.391Z","dirty":false}}`.
   `/opt/cezar` symlinks to `/opt/cezar-releases/20260825T082047Z-d217ab2e`.
7. Both declared probes exit 0; output quoted under V2. The deployed bundle
   `assets/index-BpuMuVjc.js` matches both `start-selected-filed-tasks` and `filed-selection-bar`.
8. **`cez kb write` exists, and it is still not the permitted path.** It is a real subcommand
   (`packages/cezar/src/knowledge/cli.ts:80`, `:126`) whose handler calls
   `store.createDocument({scope,path,content})` at `:361`, with no proposal queue, and `CEZ_KB=1 cez
   kb roots` in this repo shows `project [indexed, writable]
   /var/lib/cezar/loki-labs/cezar/.ai/cezar/knowledge`. **The first draft of this spec inferred from
   that that acceptance criterion 6 is not blocked. That inference is withdrawn** (§ P-E): this
   run's knowledge protocol permits only an append to `$CEZ_KB_WRITE_FILE`, and
   `POST /knowledge/proposals/apply` refuses every `seq` with `PROPOSAL_APPLY_NOT_AVAILABLE =
   'applying knowledge proposals is not implemented yet'`
   (`packages/cezar/src/server/knowledge-routes.ts:68`, handler `:239-258`), so even the human
   review step has no working applier behind it. `applyKnowledgeProposals` exists and is tested
   (`packages/cezar/src/knowledge/proposals.ts:81`, `proposals.test.ts`) but is not wired to any
   route or CLI verb.
9. Both deploy targets carry `"manual": true`; `manualReason` begins "a person activates cezar, not
   an agent (owner decision 2026-08-24, `.ai/specs/2026-08-24-default-workflow-ten-stages.md` D6)".
   `AGENTS.md` carries the matching `CORRECTED 2026-08-24` at its "Shipping cezar itself" section.
10. `cezar todo` usage lists `add "<summary>" [--project] [--context] [--acceptance] [--priority]
    [--skill] [--spec] [--start] [--json]`: **no `--workflow`**. `POST /todos/:id/start` resolves the
    workflow itself (`server.ts:6182`) and starts a real run (`:6188`).
11. **The leak.** `todos.json` (183 entries) holds `2d0b837a-b71b-4c7f-af43-929060e0ef66` and
    `520e2bbe-4abe-4a3a-8bc9-c818968be2aa`, both `status: "todo"`, summaries
    `E2E disposable: 480e0282 #1` / `#2`. `runs.json` (56 entries) holds
    `ae7bd42f-a399-4ceb-92cf-d657e620d80f` (`running`, `tokensUsed: 1151848`, workflow
    `spec-to-deploy`, backend `codex`, model `gpt-5.6-terra`) and
    `a3dd8f5f-5d66-402e-b876-c1a6746d9da7` (`running`, runner `claude`), both created
    `2026-08-25T08:18:4xZ` with `author.via: "todo-start"`. **Re-measured at 08:46 while revising
    this spec:** both still `running`, `tokensUsed` `2869979` and `3822687`, 6,692,666 between them,
    up from 1,151,848 for the pair 25 minutes earlier.
12. E2E artifacts at `.ai/cezar/tmp/480e0282-…/e2e/`: `01-filed.png`, `02-selected.png`,
    `03-after-start.png`, `page@edf9250b5fc6b7f36362392d07941356.webm`, all mtime `Aug 25 08:18`.
    No verdict line anywhere in the run handoff.
13. The release live at 08:18 was `20260825T081138Z-00a202b8`;
    `git merge-base --is-ancestor 7932cf4d 00a202b8` exits 0, so those artifacts do show a build
    containing the feature, just not the current one.
14. `GET /api/v1/workspace/runs-index` and `GET /api/v1/workspace/todos` return `401` on loopback;
    `GET /tasks` returns `200`.
15. `packages/cezar/src/auth/session.ts`: `SESSION_COOKIE_NAME` at `:75`, `createSession` at `:356`,
    `destroySession` at `:360`.
16. `packages/web/src/routes/global-tasks.tsx`: `filed-selection-bar` `:826`,
    `filed-selection-count` `:829`, `start-selected-filed-tasks` `:835`, `clear-filed-selection`
    `:847`, `filed-select-all` `:1050`, `filed-select` + `data-todo-id` `:1071-1072`,
    `useStartFiledTasks` `:1522-1548` (serial, failure-tolerant, no `navigate`).
17. This repo has **no spec-number allocator**: `tools/next-spec` and `tools/` do not exist, and
    `.ai/specs/` uses dated `YYYY-MM-DD-three-to-four-words.md` filenames. This file follows that
    convention and is the first `2026-08-25-*` spec in the directory.
18. **The gates did not cover the committed tree.** The handoff's "Progress log (step 5: run the
    gates)" is stamped `2026-08-24T23:57Z` and ran on the worktree as reconciled onto `e38cb619`.
    "Progress log (step 6: commit & push)" is stamped `00:00Z` and opens by recording a
    `git merge --ff-only origin/main` onto `ea40c7a1`, then the commit. `git diff --name-only
    e38cb619 ea40c7a1` lists 11 paths: `.ai/deploy-targets.json`, two `.ai/specs/*`, `AGENTS.md`,
    `CHANGELOG.md`, and `packages/cezar/src/workflows/{handoff-gate.test,postconditions.test,
    postconditions,run,types.test,types}.ts`. `$TESTED_TREE`
    (`89d05604e33d92b6a94151f36d2e6ffe36e54740`) equals `7932cf4d^{tree}` (re-measured), but it was
    produced by `git write-tree` after that merge, so the equality proves the commit matches the
    index, not that a gate ever saw it.
19. **`RunStore.deleteRun` destroys the transcript.** `packages/cezar/src/runs/store.ts:1364-1379`:
    on a successful `this.runs.delete(id)` it `rmSync`s `eventsPath(id)`, `handoffPath(id)` and
    `imagesDir(id)` (recursive, force), then emits `deleted`. Best effort, no backup.
20. **`POST /runs/:id/cancel` restores the todo.** `packages/cezar/src/server/server.ts:5192-5208`:
    after `manager.cancel(id)` returns true it awaits `clearStartedTaskId(dataDir, id)`, citing
    `.ai/specs/2026-08-22-run-cancel-restores-todo.md`. So a cancelled run's todo returns to Filed.
21. **The three worktree paths are intent-to-add, not staged.** `git ls-files --format='%(objectname)
    %(path)'` prints the empty blob `e69de29bb2d1d6434b8b29ae775ad8c2e48c5391` for
    `.ai/specs/2026-08-25-verify-bulk-start-release.md`, `.ai/specs/briefs/2026-08-25-bulk-task-starts.md`
    and `.e2e-bulk-start.cjs`; `git diff --cached --name-only` prints nothing and `git status` lists
    all three under "Changes not staged for commit". `origin/main` is `d217ab2e`, six commits ahead
    of `HEAD`.
22. **Tooling locations for the E2E.** `playwright` resolves to `/usr/lib/node_modules/playwright`
    (global; it is **not** in either checkout's `node_modules`), while `tsx` is present at
    `<worktree>/node_modules/tsx`. `$CEZ_KB_WRITE_FILE` =
    `/var/lib/cezar/loki-labs/cezar/.ai/cezar/runs/480e0282-a967-4936-a12e-3c4e56450586.knowledge.ndjson`
    and does not exist yet, so the first proposal's `seq` is `0`.
23. **Both disposable todos are already tombstoned, so the 08:18 E2E's todo cleanup DID run.**
    `todos.json` (a top-level JSON array, 183 entries) holds both ids carrying
    `tombstone: {"at":"2026-08-25T08:18:56.666Z"}` and `…690Z` respectively, with `status` still
    `"todo"`. That is what a successful delete looks like here: `removeTodo`
    (`packages/cezar/src/todos.ts:469-484`) stamps `tombstone` and leaves the row in the file under
    clustering, returning `false` for an already tombstoned row; `.delete('/todos/:id')`
    (`packages/cezar/src/server/server.ts:6144-6148`) maps that `false` to
    `404 {"error":"not found"}`. `isTombstoned` and the retention rule are documented at
    `todos.ts:142-147`. Consequence for this spec: a `grep -c "E2E disposable" todos.json` of `0` is
    **unreachable**, and every cleanup gate had to become tombstone-aware (§ P0 step 7, V0, V5).
24. **The leak is still growing.** Re-measured while applying this revision: both runs still
    `status: "running"`, `tokensUsed` `5398675` and `6521110`, **11,919,785 between them**, up from
    6,692,666 at 08:46 and 1,151,848 at 08:2x. `runs.json` is a top-level array of 56 entries.
25. **`/tasks` run rows carry the id in the DOM.** `packages/web/src/routes.tsx:793` maps `/tasks`
    to `GlobalTasksRoute`; `packages/web/src/routes/global-tasks.tsx:1944` renders
    `<tr data-slot="global-task-row" data-run-id={run.id} data-project={run.projectId}>`, and the
    below-`md` card carries `data-run-id` at `:2138`. The list refreshes into the mounted page
    without navigation: the batch's success handler invalidates `workspaceQueryKeys.runsIndex`
    (`global-tasks.tsx:1540`) and the global SSE stream invalidates it on run events
    (`packages/web/src/api/global-events.tsx:125`, `:158`). This is what makes P2's DOM assertion
    possible without a reload.
26. **`knowledgeUpsertProposalSchema` does not require every field.**
    `packages/contract/src/knowledge.ts:240-260`: the base contributes `seq`, `runId`, `createdAt`;
    the upsert extension adds `op`, `scope` (`project` | `workspace`), `path` (`min(1)`) and `body`
    as required, with `title`, `type`, `tags` and `supersedes` all `.optional()` and no defaults.
    The earlier draft of § P3 said every illustrated field was required, which is false.
27. **The parent task's proposal is still pending and still stale.**
    `/var/lib/cezar/workspace/.ai/cezar/runs/e6592588-1628-40e0-b31a-8fe26c8b2220.knowledge.ndjson`,
    2,462 bytes, one `upsert` line: `seq: 0`, `runId: e6592588-…`, `createdAt: 2026-08-24T21:50:00Z`,
    `scope: "project"`, `path: "cezar/bulk-start-filed-tasks.md"`, no `supersedes`. Its body states
    design call 2 as `selectedFiledEntries(sorted, selected)` (the shipped code uses `rows`) and
    ends "**Status: QA needed** … The runtime E2E on the prod cockpit … has NOT been run". Nothing
    in this run's proposal file links to or invalidates it; § P3 says what to do about that.

## Definition of done

- P0 green, **tombstone-aware** (§ P0 step 7, V0): both run ids are absent from `runs.json`; both
  todo ids are absent from `todos.json` **or present carrying `tombstone`**, which is what a
  successful delete leaves behind here; no non-tombstoned `E2E disposable` row survives; the
  authenticated `runs-index` and `workspace/todos` both answer `200` and contain none of the four
  ids; the evidence snapshot (transcripts, handoffs, run records, 08:18 artifacts) is in
  `2026-08-25T0818Z-orphaned/`; and the reaped ids and final token cost are in the handoff. A
  `grep -c` of `todos.json` is **not** a condition and must not be used as one.
- P1 green: both declared probes exit 0 with their output quoted, and **nothing was deployed**.
- **P1.5 green: all five gates exit 0 on a checkout whose `HEAD^{tree}` printed
  `89d05604e33d92b6a94151f36d2e6ffe36e54740`,** with the six exit codes and the three test totals
  quoted. Acceptance criterion 3 is open until this is true, whatever the handoff's earlier gate
  entry says.
- P2 green: `"verdict":"PASS"` and `"cleanup":"PASS"` both quoted in the handoff; **both started run
  ids read back out of the page DOM** via `[data-slot="global-task-row"][data-run-id="<id>"]`, with
  `page.url()` re-asserted equal to `beforeUrl` after that refresh; `/api/v1/ready` re-read after the
  browser closes with `sha` and `activatedAt` matching P1's; artifacts retained including four PNGs
  and a two-line `reap.ndjson`; V5 re-run clean by exact id, tombstone-aware.
- **P3 half met by construction:** the proposal is appended to `$CEZ_KB_WRITE_FILE` and
  `readRunProposals` returns it; its body explicitly corrects the parent proposal's two stale claims
  (`selectedFiledEntries(sorted, selected)`, and "the runtime E2E … has NOT been run"); the parent's
  still-pending proposal at
  `/var/lib/cezar/workspace/.ai/cezar/runs/e6592588-1628-40e0-b31a-8fe26c8b2220.knowledge.ndjson` is
  named in the handoff with a recommendation to reject rather than apply it; and the searchable half
  is reported **BLOCKED** on human application. `find /var/lib/cezar -not -user cezar | wc -l` is
  `0`. This phase can never be fully green inside this run, and reporting it as green would be a
  false claim.
- P4 green: **no commit, no push, no tracked file changed.** `git rev-parse HEAD` still prints
  `7932cf4d…`, `git diff` and `git diff --cached` are both empty, no empty-blob index entry
  survives, `.e2e-bulk-start.cjs` is outside the worktree, this spec and its brief are preserved
  under the task's `artifacts/` directory, and the three deferred header corrections are filed as a
  todo naming the owner authorization they need.

Until P1.5 and P2 both pass, the feature is **QA Needed**, not Done, regardless of the fact that it
is already running in production. A live release is not evidence that its tree was ever gated, and
gates green are not evidence that the button works; the browser pass is what closes it.

**The task as a whole cannot be reported Done by this run.** Acceptance criterion 6 is structurally
half met (§ P-E), so the honest terminal state, even with every other phase green, is QA Needed with
one blocked criterion named, its proposal file path and `seq` recorded, and the missing applier
(`knowledge-routes.ts:68`) named as the blocker.
