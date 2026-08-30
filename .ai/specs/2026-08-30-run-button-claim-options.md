# ▶ Run stamps its claim, so one press is one run

**Status:** Implemented (2026-08-30)
**Supersedes nothing.** Applies `.ai/specs/2026-08-22-multi-node-cezar-cluster.md` D15a (row 1) and
D43 to the one call site that never got them: the HTTP `▶ Run` route.

## TLDR

`POST /todos/:id/start` calls `markStarted(dataDir, id, run.id)` with **no start options** and
**discards the answer**. On a node with `CEZ_CLUSTER=1` that is a refusal: the claim goes to a hub
that has nobody to ask, `markStartedWithClaim` returns `hub-unconfirmed`, and it writes nothing.
The run exists; the record does not know it. Two user-visible symptoms, one cause:

1. **The filed row never leaves the board.** Both the server (`todo-index.ts#isBoardVisible`) and
   the client (`filed-tasks.ts#isVisibleFiledEntry`) hide an entry once it carries `startedTaskId`.
   Unstamped, the task shows in Running *and* in Filed at the same time.
2. **The same task runs twice.** The route's only double-start guard is
   `if (todo.startedTaskId) return 409`. Keyed on the field that is never written, it can never
   fire, so a second press starts a second agent on the same work.

Symptom 2 is caused by symptom 1 twice over: the row not leaving the board is *why* a person
presses again.

## Problem

Measured on `prod-host`, 2026-08-30. `CEZ_CLUSTER=1` has been set since 2026-08-24
(`cezar.service.d/50-cluster.conf`), role **hub**.

| Fact | Value |
| --- | --- |
| `▶ Run` starts since the cluster flip | **13** |
| …that stamped `startedTaskId` | **0** |
| `todo-autostart` starts in the same window | 8 |
| …that stamped | **8** — the control |
| Filed rows currently doubled | **13 of 13** |
| …whose run has already finished | 11 (board still reads `todo` / `in-progress`) |
| `todos.json` mtime vs. the 18:33Z starts | 17:52Z — nothing was written |

The double-start, caught in the act:

```
4d9a3166  running    via todo-start  2026-08-30T05:15:35.167Z
3c32c52a  cancelled  via todo-start  2026-08-30T05:15:53.911Z   ← 18s later, same todo
```

Two agents, one todo, one box — the exact failure `markStartedWithClaim`'s docblock says the claim
exists to prevent ("a SECOND RUN of the same work … spending the same subscription twice"), reached
by never recording the claim at all.

### Why the tests could not see it

`todos-start.test.ts` has 24 cases. `startedTaskId` appears in it **twice, both as input** — the
fixtures for the two 409 cases. Nothing asserts the route ever *writes* it. The suite pins the
guard by handing the guard its own precondition, so it stays green against a route that never
arms it. Same shape as the sweep in `2026-08-29-resolve-button-red-recheck.md` S5: every test
drove the callee directly, nothing covered what the caller passes it.

### Why the autostart path is fine

`todo-autostart.ts` hit this first and fixed it there. `createHubAutostartDispatch#place` returns
`startOptions` alongside the placement, and its comment is this bug written out in advance:

> Left to the environment, `markStarted` would ask a hub that has nobody to ask, refuse
> `hub-unconfirmed`, and write nothing — so every unpaired todo on a clustered hub would start,
> fail to stamp, and be started again by the next pass.

`▶ Run` is that sentence with a person in place of the pass. The fix was never carried across
because the two paths reach `markStarted` from different sides: autostart through the placement
seam, the route directly.

## Solution

**S1 — the claim seam answers for a human start too.** `TodoAutostartDispatch` gains
`localStartOptions({ repoRoot })`: *what kind of claim is a start that happens on THIS node, for
this project?* The hub implementation is the two answers `place()` already computes for its local
branches — `{clustered: false}` for a project this hub has no confirmed pairing for,
`{clustered: true, confirmStart: hubSelfConfirm(key)}` when it does — and `place()` now **calls it**
rather than repeating them, so the two cannot drift.

**S2 — `startOptionsForHumanStart(repoRoot)`** (`cluster/autostart-seam.ts`) is what the route asks.
Two branches, each naming its rule:

- a placement policy is armed (this node is a **hub**) → ask it, per S1.
- otherwise → `{ humanIntent: true }`, D15a row 1: *"a person clicks ▶ Run … **proceeds** — a human
  is asserting intent on this host."* Correct for a **spoke** (optimistic, stamped pending, the hub
  reconciles) and inert on **single-node** cezar, where `clusteringOn()` reads the environment as
  off and the flag is never consulted.

Named for the human case on purpose. Autostart must **not** call it: a replicated todo's autostart
refuses when the link is down (D15a row 3), and a helper that says "proceed" would erase that row.

**S3 — the route stops discarding the answer.** `markStarted`'s boolean is read. On a refusal the
run exists and the record does not know it (**D43**), so the route remembers `todo → run` in the
same in-process `pendingStamp` map the autostart path already keeps, and warns with the reason.

**S4 — a second press settles the orphan instead of starting a second run.** Before starting
anything the route asks `pendingRunForTodo(dataDir, id)`. If a previous press left a run behind, it
retries that stamp and answers **409 `already started`** either way — because a run for this todo
exists, and that is true whether or not the record can be made to say so. This is the guard that
holds even when the claim genuinely is refused, which the `startedTaskId` check cannot.

**S5 — a press that LOSES the claim cancels its own run.** `markStarted`'s boolean cannot say
*why*, so the route uses `markStartedWithClaim` and splits on the reason. **A refusal that names a
winner means this run is the duplicate; one that means "nobody could confirm" leaves it standing:**

| reason | what it means | what the route does |
| --- | --- | --- |
| `already-started` | two presses raced past the `startedTaskId` guard — both read the todo before either stamped — or an autostart pass claimed it in between | `manager.cancel(run.id)`, **409** |
| `hub-refused` | another **node** holds the claim; two worktrees on two machines | `manager.cancel(run.id)`, **409** |
| `hub-unconfirmed` / `not-found` | nobody won; this run is the only one and it is real | remember it (S3), **201** |

The race is real and no re-read shrinks it to zero: `askHubToConfirm` runs with **no lease held**,
deliberately, and the authoritative re-read happens after it. That gap is exactly what a second
click lands in. Cancelling the loser is what makes the guard total rather than merely narrow.

## Architecture

```
POST /todos/:id/start
  │
  ├─ todo.startedTaskId?        ─▶ 409 already started        (unchanged)
  ├─ pendingRunForTodo(...)?    ─▶ retry that stamp ─▶ 409     ← S4
  │
  ├─ startOptionsForHumanStart(repoRoot)                       ← S2
  │     ├─ hub    ─▶ dispatch.localStartOptions({repoRoot})    ← S1
  │     │             ├─ unpaired ─▶ { clustered: false }
  │     │             └─ paired   ─▶ { clustered: true, confirmStart: hubSelfConfirm }
  │     └─ spoke / single node ─▶ { humanIntent: true }         (D15a row 1)
  │
  ├─ manager.startRun(...)
  └─ markStartedWithClaim(dataDir, id, run.id, startOptions)
        ├─ started            ─▶ 201 { run }   row leaves the board, guard armed
        ├─ already-started    ─▶ cancel(run) ─▶ 409          ← S5, a winner exists
        ├─ hub-refused        ─▶ cancel(run) ─▶ 409          ← S5, the winner is another node
        └─ hub-unconfirmed    ─▶ rememberPendingRun + warn ─▶ 201 { run }   ← S3 (D43)
```

The options are resolved **before** `startRun`, so nothing but the start sits between the run and
its stamp — the window `todo-autostart.ts` keeps deliberately small, for the same reason.

## Data models

None. `startedTaskId`, `pendingSince`/`pendingFields` and `hubSeq` are written by `markStarted`
exactly as they always were; this change is only about which options reach it.

## API contracts

`POST /todos/:id/start` is unchanged on the wire on the success path (`201 {run}`). New 409s, both
in place of a 201 that carried a duplicate run: a press for a todo whose earlier press left an
unstamped run (S4), and a press that loses the claim outright (S5, where the run it created is
cancelled before the answer is sent).

## Risks

- **`localStartOptions` does I/O** (workspace config + `peers.json`) on every press. Both are small
  local reads that `place()` already makes on every autostart, and it happens before `startRun`, so
  it cannot widen the start→stamp window.
- **`pendingStamp` is in-process and does not survive a restart.** That is the scope its own docblock
  argues for and it is unchanged here: a restart costs at most one extra attempt. Persisting it
  would mean a second on-disk source of truth about whether a run exists.
- **`{humanIntent: true}` on a spoke stamps the record pending.** That is the intended D15a row-1
  behaviour — an optimistic claim the hub reconciles — not a leak. Measured on the hub: 0 of 208
  todos carry `pendingSince` today, and all 208 carry `hubSeq`, so the hub's own path settles
  inline via `hubSelfConfirm` and never takes this branch.

## Verification

1. `todos-start-claim.test.ts` — the route, against a real `todos.json`, with `CEZ_CLUSTER=1`:
   the start **stamps** `startedTaskId`; a **second press 409s and starts no second run**; with no
   policy armed the `humanIntent` branch still stamps; and a refused claim leaves a pending run that
   the next press settles rather than duplicating. *Mutation control:* restoring
   `markStarted(dataDir, id, run.id)` (no options) must fail the first two.
2. `hub-autostart-dispatch.test.ts` — `localStartOptions` returns the unpaired and paired shapes,
   and `place()`'s local branches return **the same** options, so S1's no-drift claim is asserted
   rather than asserted-by-comment.
3. `autostart-seam.test.ts` — `startOptionsForHumanStart` asks an armed dispatch, and falls back to
   `{humanIntent: true}` with none armed. *Negative control:* it must NOT return `{clustered:false}`
   when clustering is on and nothing is armed — that would be a silent single-node lie.
4. `todos-start-claim.test.ts`, S5 half — a rival stamp landing inside the unleased confirm window
   makes the press 409, **cancel its own run**, and leave the winner's `startedTaskId` untouched.
   *Negative control:* an `hub-unconfirmed` refusal cancels **nothing**, so "cancel on refusal" cannot
   pass by throwing away every run started during a hub outage. *Mutation-checked:* dropping the
   cancel branch fails the race case alone.
5. Full gates (`typecheck`, `test`, `build`).
6. **Shipped and verified on `prod-host`, 2026-08-30.** Release
   `20260830T053441Z-5d59a16f`, 91 ms cutover, cockpit 200, service active.

   - **The fix is in the live release, with a control:** `startOptionsForHumanStart` appears 3x in
     the release's `server/server.js` and **0x** in the release it replaced.
   - **The armed policy is the hub's, proven from data rather than assumed** — the one layer the
     unit tests cannot reach, because it is a property of the running process. **7 of 8**
     autostarted todos carry `startedOn = 06495ac4…`, this hub's own node id, which only
     `hubSelfConfirm` writes. (The 8th is the unpaired answer, `{clustered: false}`, which sets
     none.) So the next press takes the hub branch, and the checkable prediction is:
     `startedTaskId` set, `startedOn` = that node id, `hubSeq` bumped, **no `pendingSince`**.
   - **Backfill.** 10 orphaned records stamped with the run each was started from — the earliest
     non-cancelled `todo-start` run whose task text begins with the todo's summary. **3 of the 10
     had a duplicate run**, which is the double-start's residue; cancelled runs are excluded
     deliberately, since `clearStartedTaskId` un-hides a cancelled todo on purpose
     (`2026-08-22-run-cancel-restores-todo.md`). Written through `markStartedWithClaim` under the
     todos lease — never a hand-edit of `todos.json` beside a running server — with
     `{clustered: false}`, which is honest here for a repair of a historical fact on records that
     already carry a `hubSeq`, with the pairing's only peer (`mac-worker`) disabled since
     2026-08-24. Backup at `todos.json.bak-preclaim-backfill`.
   - **Measured after:** rows still doubled on the board **0** (was 13); `pendingSince` **0 of
     208** and `hubSeq` **208 of 208**, both unchanged, so the repair added no outbox debt;
     `find /var/lib/cezar -not -user cezar | wc -l` = **0**.
   - **Not run here:** a real Run press. Doing it would start a live agent on the production box
     for a task nobody asked for. The next genuine press is the E2E, and the prediction above is
     what it must show.
