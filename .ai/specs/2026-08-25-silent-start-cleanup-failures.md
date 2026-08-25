# Silent Start Cleanup Failures

> **Status:** **EXECUTED 2026-08-25, step 8/9 of the same run.** ~~Nothing here has been
> executed.~~ P1 and P2 are both done: three follow-up tasks are filed
> (`ec74e82a-90f1-47b9-bb41-b0d1d0b49543`, `caab0649-3991-4beb-b022-46f00ce49b96`,
> `e3562b60-2b2f-43b3-897c-7876925ac56b`, project `cezar`), and the sibling run
> `ae7bd42f-a399-4ceb-92cf-d657e620d80f` is cancelled, deleted, and confirmed absent (§
> Verification 1-3 all passed; see this run's handoff, `10:05Z` entry). The spec and brief were
> committed (`04e46586`), a pre-existing `.ship-drafts` gitlink corruption on this branch was fixed
> in passing (`5d50bfc2`), and the branch was merged into and pushed to `origin/main` directly
> (`9fdf364b`) — confirmed still an ancestor of `origin/main` as of this writing. **P3 remains
> genuinely outstanding**: this run, `a3dd8f5f-5d66-402e-b876-c1a6746d9da7`, cannot cancel itself
> (see § P3 below) and is still `status: "running"` in `runs.json` as this step executes. The
> parent task `480e0282` or the owner still needs to reap it once this chain reaches its final
> step. Original status line, describing the pre-execution worktree, preserved below unchanged.
>
> **Original status (2026-08-25, pre-execution):** ~~**operational cleanup record + filed
> diagnosis**, revised 2026-08-25 after review. Nothing here has been executed. This is step 2/9 of
> run `a3dd8f5f-5d66-402e-b876-c1a6746d9da7` (`spec-to-deploy`).~~
>
> **REVISED 2026-08-25.** This document was first written as a three-defect implementation spec
> (P1-P5) for a task whose title is disposable E2E fixture data. Review found that this exceeded
> the task, and that two of the proposed changes carried blocking defects — a response-contract
> change described as "no schema changes", and a start ordering that D41 already records as an
> open **owner** decision. It is now **an operational cleanup record (P1, P2) with the diagnosis
> preserved in full and handed off as three separate filed tasks (F1, F2, F3)**. The superseded
> text is kept in place beneath each correction, per the workspace's correction rule.
>
> **Task:** `a3dd8f5f-5d66-402e-b876-c1a6746d9da7`, titled `"E2E disposable: 480e0282 #2"`.
> **That title is not a feature request** — see § Problem, part 0. This document builds nothing for
> that title, and after review it builds nothing for the defects either: it cleans up the fixture
> and files them.
>
> **Brief:** `.ai/specs/briefs/2026-08-25-e2e-disposable-480e0282-2.md`, written by step 1 of this
> run. Its headline finding (this run is disposable E2E fixture data) is **confirmed**. This
> document originally claimed three of its supporting claims failed re-checking; **on review, one
> of those three "corrections" was itself wrong and the brief was right** — see § Measured facts,
> claim 3.
>
> **Line numbers below are from this worktree's HEAD, `b3d3a44c`.** `7932cf4d` ("feat: bulk start
> filed tasks") is **not** an ancestor of `b3d3a44c` (`git merge-base --is-ancestor 7932cf4d HEAD`
> → false), so this branch is behind `origin/main`.
>
> **CORRECTED 2026-08-25 (review) — the earlier claim that `7932cf4d` "touched only
> `packages/web/**` and specs" is false.** `git show --stat 7932cf4d` lists seven files, and one of
> them is a **deletion** outside `packages/web`: `packages/cezar/test/unit/deploy-e2e-probe.test.ts`
> (-348). The other six are the two specs and four `packages/web` files. Separately,
> `git diff --stat HEAD origin/main` is 55 files, so "this branch is behind" is not a formality.
> The three anchors this document leans on were re-checked against `origin/main` directly and are
> byte-identical there — `server.ts:6198` (`await markStarted(dataDir, id, run.id);`),
> `todos.ts:942` (`if (!options?.humanIntent) {`), `todo-index.ts:83`
> (`async list(): Promise<WorkspaceTodoListResult> {`) — so the diagnosis below survives the gap.
> **This task no longer implements anything, so no rebase is required by it.** A rebase is P0 for
> whichever follow-up task picks up F1/F2/F3.

## TLDR

**This task requests no product feature, and this document ships no code.** Its title,
`"E2E disposable: 480e0282 #2"`, is verbatim fixture data from a browser-E2E run (§ Problem, part
0). Building a feature for it would be invented scope, and building the *defects* it exposed under
its number would be a different kind of invented scope — a disposable fixture is not the right
carrier for three production changes to a public, released package.

So this document is **an operational cleanup record plus a diagnosis handed off**, in two halves:

**Half one — what this task does (P1, P2 below).** Cancel and delete, project-scoped and
authenticated, the two runs this fixture spawned; confirm their todo records are terminal; verify
by re-query rather than by the exit code of the thing being verified; and terminate this
nine-step chain. **No commit, no push, no deploy.**

> **CORRECTED 2026-08-25 (second review) — the paragraph above understates what "this task" can
> reach, and its ordering is not executable.** A run cannot cancel itself and then keep going:
> `RunManager.cancel()` sets `state.cancelled = true` and calls `state.interrupt()` on the active
> session (`packages/cezar/src/workflows/run.ts:3661-3663`) — this session. Every step written
> after that call would never run. So the phases below are re-ordered and re-scoped: **P1 files the
> three follow-ups** (the durable output, and it must land before anything is destroyed), **P2
> cancels and deletes only the SIBLING run `ae7bd42f`**, and **P3 hands this run's own cancel and
> delete to an external actor** — the parent task `480e0282` or the owner, from a shell that is not
> this run. "Terminate this nine-step chain" is therefore not something this document executes; it
> is something it requests, with the verification the external actor owes stated in P3.
> **Still true: no commit to `main`, no merge, no deploy.** The one write this task does make is
> the durability step in § Verification 0 — committing this document and its brief on this task's
> own branch `cez/a3dd8f5f` and pushing that branch to `origin` — which replaces the
> copy-into-the-main-checkout step an earlier draft called for. That step left an untracked file in
> a checkout it did not own and preserved nothing.

- Runs: `a3dd8f5f-5d66-402e-b876-c1a6746d9da7` (this run) and `ae7bd42f-a399-4ceb-92cf-d657e620d80f`.
- **Id discrepancy, flagged rather than silently reconciled:** the review that requested this
  rewrite named the sibling as `ae7bd42f-442f-4314-ab36-f7b96dbec097`. That string occurs nowhere
  in `.ai/cezar/` except inside this run's own ndjson transcript, where it appears only as a quote
  of the review text itself. `runs.json` and `.ai/cezar/runs/` both carry exactly one `ae7bd42f…`
  run, `ae7bd42f-a399-4ceb-92cf-d657e620d80f`, `status: running`, titled
  `"1: E2E disposable: 480e0282 #1"`. **P1 uses the id that exists on disk** and asserts, before
  acting, that the `442f` id resolves to nothing — so if a second run really does exist somewhere
  this document cannot see, the cleanup fails loudly instead of quietly reaping the wrong pair.
- Todos: `2d0b837a-b71b-4c7f-af43-929060e0ef66` and `520e2bbe-4abe-4a3a-8bc9-c818968be2aa`, both
  already carrying `tombstone` (`08:18:56.666Z` / `08:18:56.690Z`) and both with
  `startedTaskId: null`. Their cleanup is a **verification**, not a deletion — but see P1's
  ordering trap: cancelling a run calls `clearStartedTaskId`, so cancel-then-check is the only
  safe order.

**Half two — what this task files rather than builds (F1, F2, F3 below).** The diagnosis is real
and is preserved in full: § Problem, § Measured facts and § Architecture are unchanged and are the
substance of this document. Each defect leaves here as its own `cezar todo add` with its own spec
to be written, because each has an unresolved design question that a cleanup task has no business
deciding (F1 in particular collides with an open **owner** decision, D41).

The three defects, in descending order of user impact — two independent, one shared shape: **a
failure coded as a success.**

1. **`POST /todos/:id/start` starts the run and then silently fails to mark the todo started.**
   The box runs `CEZ_CLUSTER=1`, the route calls `markStarted(dataDir, id, run.id)` with **no
   options**, so there is no `confirmStart` hub confirmer and no `humanIntent` flag. That path
   returns `{started: false, reason: 'hub-unconfirmed'}` and **writes nothing**
   (`todos.ts:942`). The route discards the boolean and answers `201`. Net effect on this
   production box: **every "▶ Run" and every bulk start creates a run and leaves the row sitting on
   the Filed board.** Deterministic, not intermittent.

2. **The E2E's cleanup addresses runs at `/api/v1/runs/:id/…`, which binds to the boot project**
   (`/var/lib/cezar/workspace`), **not to `cezar`** where the runs live. Every cancel and delete
   answers `404`, and the script codes `404` as "already gone" — so cleanup reported success while
   doing nothing. **This run and its sibling `ae7bd42f` are the artifacts.**

A third, smaller defect makes the cleanup's own safety net unable to fire: the ground-truth
re-query asserts the todo id is absent from `GET /api/v1/workspace/todos`, but that endpoint
returns tombstoned rows by design, so "absent" is never true after a delete.

Defect (1) is the user-facing priority. **CORRECTED 2026-08-25 (review): it is not a bug `7932cf4d`
introduced.** `server.ts:6198` has called `markStarted` with no options since long before that
commit, and `7932cf4d` touches no file under `packages/cezar/src`. What `7932cf4d` did was ship a
**bulk** UI over the same route, which turns a per-click silent refusal into a "Started 12 tasks"
toast over twelve rows that did not move — so it exposed the defect at scale rather than causing
it. Defect (2) is what stops disposable runs accumulating.

None of the three is fixed here. They are filed — see § Phases, F1/F2/F3.

## Problem

### 0. This task's title is fixture data, and nothing should be built for it

`"E2E disposable: 480e0282 #2"` is the verbatim summary of a throwaway todo created by task
`480e0282` as a browser-E2E fixture. Measured directly in
`/var/lib/cezar/loki-labs/cezar/.ai/cezar/todos.json`:

```json
{ "id": "520e2bbe-4abe-4a3a-8bc9-c818968be2aa",
  "ts": "2026-08-25T08:18:36.591Z",
  "summary": "E2E disposable: 480e0282 #2",
  "origin": "agent",
  "author": { "kind": "agent", "id": "480e0282-a967-4936-a12e-3c4e56450586",
              "via": "cli-todo-add", "parentStepId": "continue-3" },
  "hubSeq": 272,
  "tombstone": { "at": "2026-08-25T08:18:56.690Z" } }
```

Its sibling `2d0b837a-…` (`#1`) is identical in shape and spawned run
`ae7bd42f-a399-4ceb-92cf-d657e620d80f`, whose handoff is the same 324-byte stub as this one. There
is no requester, no context, no acceptance criteria — `POST /todos/:id/start` produced a run from a
row whose only content is a `summary`.

**So a feature spec for this title would be invented scope.** What follows instead is the record of
why the fixture outlived its test, which is a real and citable defect in this repository.

### 1. The start route silently declines to mark the todo started

`packages/cezar/src/server/server.ts:6198`, inside `POST /todos/:id/start`:

```ts
const run = manager.startRun(workflow, { task, /* … */ author: authorOf(c, 'todo-start') });
await markStarted(dataDir, id, run.id);          // ← boolean discarded, no options passed
return c.json({ run }, 201);
```

`markStarted` → `markStartedWithClaim` (`todos.ts:881`). With `clusteringOn()` true
(`todos.ts:286-288`: `options?.clustered ?? clusterModeFromEnv(options?.env).enabled`, and
`cezar.service` carries `Environment=CEZ_CLUSTER=1`), it asks the hub:

```ts
const ack = clustered ? await askHubToConfirm(dataDir, id, taskId, options) : undefined;
```

and `askHubToConfirm` (`todos.ts:848-856`) opens with:

```ts
const confirm = options?.confirmStart;
if (!confirm) return undefined;
```

The route passed no options, so `confirmStart` is `undefined`, so `ack` is `undefined`, and
`todos.ts:941-947` runs:

```ts
if (!ack) {
  if (!options?.humanIntent) {
    // Nothing is written. The absence is the point …
    return { started: false, reason: 'hub-unconfirmed', message: HUB_UNCONFIRMED_MESSAGE };
  }
  …
}
```

`startedTaskId` is never written. `visibleTodos()` (`packages/web/src/routes/inbox.tsx:57`) hides
only *started* entries, so **the row never leaves the Filed board** while a real run burns a
`maxParallel` slot behind it.

This is exactly what `480e0282`'s E2E caught, and it is why that E2E "failed":

```
Error: todo 2d0b837a-b71b-4c7f-af43-929060e0ef66 to leave Filed timed out
    at waitUntil (.e2e-bulk-start.cjs:25:9)
```

The E2E was right. The feature it was testing is half-broken on this box, and the failure was read
as a flaky test rather than as the true negative it was.

Note the code's own doctrine says this refusal must be *rendered*: `markStartedWithClaim`'s
docblock cites **D15a — "the refusal is a stated, rendered state — never a silent skip"**
(`todos.ts:850-853`, and the `TodoStartClaimResult.message` field at `:858`). The route discarding
the boolean is a direct violation of the contract the function was written to satisfy. The only
non-test caller that passes `humanIntent: true` is the cluster spoke
(`packages/cezar/src/cluster/spoke-runtime.ts:1177`); the two HTTP paths
(`server.ts:4983` and `server.ts:6198`) pass nothing.

### 2. Cleanup addressed runs at a mount that resolves to the wrong project

`packages/cezar/src/server/server.ts:2086-2096` documents the dual mount:

> Every route below registers ONCE on this sub-app; `createApp` mounts it twice — under
> `/api/v1/p/:projectId` (scoped) and under `/api/v1` (bound to **the boot project**) …

and `resolveProjectScope` (`server.ts:2097-2104`) implements it: no `projectId` param → the boot
context. The boot project is `cezar.service`'s `WorkingDirectory=/var/lib/cezar/workspace`, which
is its own project with its own `.ai/cezar` dataDir — **not** the `cezar` repo at
`/var/lib/cezar/loki-labs/cezar` where these runs live.

The E2E cleanup (`.e2e-bulk-start.cjs`, `finally` block) used the unscoped spelling:

```js
const res = await api(`/api/v1/runs/${id}/cancel`, { method: 'POST' })
if (![200, 404, 409].includes(res.status)) cleanupFailures.push(`cancel ${id}: ${res.status}`)
…
const res = await api(`/api/v1/runs/${id}`, { method: 'DELETE' })
if ([200, 404].includes(res.status)) return true          // ← 404 counted as done
```

`POST /runs/:id/cancel` (`server.ts:5192-5194`) opens `if (!store.getRun(id)) return c.json({error:
'not found'}, 404)`; `DELETE /runs/:id` (`server.ts:5879-5883`) does the same. Resolved against the
boot project, a `cezar` run id is not found, so both answer `404` — which this script treats as
success in both loops. **Cleanup ran, reported nothing wrong on those two steps, and cancelled
nothing.**

The second, ad-hoc cleanup attempt (`480e0282` ndjson, tool-call `2026-08-25T08:20:01.138Z`) used
the *correct* project-scoped paths, but selected runs by title match:

```js
const runs = (await rr.json()).runs.filter(r => wanted(r.title.replace(/^\d+: /,"")) || wanted(r.task))
```

Its regex literal was mangled by four levels of shell quoting (it reaches the interpreter as
`/''^'"\\\\d+: /`), so the `"2: "` prefix was never stripped, `wanted()` never matched, and it
logged `"foundRuns":[]`. Nothing was cancelled that time either. Both attempts failed for
*different* reasons, which is why the failure looked intermittent rather than structural.

### 3. The cleanup's own safety net cannot fire

Both attempts ended with a ground-truth re-query:

```js
const remainingTodos = todoIds.filter((id) => todos.some((entry) => entry.todo.id === id))
if (remainingRuns.length || remainingTodos.length) throw new Error(`remaining runs=… todos=…`)
```

`GET /api/v1/workspace/todos` (`packages/cezar/src/server/workspace-todos-routes.ts:55`) delegates
to `WorkspaceTodoIndex.list()` (`packages/cezar/src/workspace/todo-index.ts:83`), which calls
`readTodos` and **never filters tombstones** — no `isTombstoned` appears in that file. `readTodos`'s
own docblock (`todos.ts:466`) says so deliberately:

> `readTodos` still returns tombstoned rows, deliberately: the outbox derivation reads through it
> (D5a) and must be able to see the delete. Board consumers filter with `isTombstoned`.

So after a successful `DELETE /todos/:id` — which writes `tombstone` rather than removing the row
(`removeTodo`, `todos.ts:466-480`) — the id is still in the endpoint's answer. The assertion
"remaining todos = 0" is **unsatisfiable by construction**. Measured: both runs reported
`todos=2` remaining in the same ~200 ms window in which their own deletes had just written
tombstones at `08:18:56.666Z` and `08:18:56.690Z`.

This is the same failure shape the KB already records for this repo — an assertion that cannot
distinguish success from failure (KB `notion-d298477a98b5`, "A capability flag nobody sets fails as
silence — and two guards that passed for the wrong reason", cezar, 2026-08-16), and the same shape
as `.ai/specs/2026-08-22-deploy-e2e-probe-vacuous-pass.md` and commit `587db317` ("fix: make
deploy-e2e-probe assertions non-vacuous").

## Measured facts

Timeline, reconstructed from `todos.json`, the two run ndjson logs, and the E2E script on disk:

| Time (UTC, 2026-08-25) | Event | Source |
| --- | --- | --- |
| `08:18:29.955` | E2E script `.e2e-bulk-start.cjs` written | `480e0282` ndjson, `fileChange` |
| `08:18:36.044/.581` | both disposable todos created | `todos.json`, `author.at` |
| `08:18:40.715` | this run (`a3dd8f5f`) starts | `a3dd8f5f-….ndjson:2` |
| `~08:18:41-56` | `waitUntil(todo to leave Filed)` times out after 15 s | script line 114 |
| `08:18:56.666/.690` | both todos tombstoned by the cleanup's `DELETE /todos/:id` | `todos.json` |
| `08:18:56.898` | process exits 1, `{"cleanup":"FAIL","cleanupFailures":["ground truth: remaining runs=2 todos=2"]}` | `480e0282` ndjson |
| `08:20:01.644` | ad-hoc second cleanup, `"foundRuns":[]`, exit 1 | `480e0282` ndjson |
| `08:20:52.843` | "cezar restarted — this run kept going" | both ndjson logs |

`durationMs: 22491` for the whole first script confirms the 60 s delete-poll never engaged: the
deletes returned immediately, with `404`.

### Three of the brief's claims, corrected

1. **The brief said the tombstones "line up with started todos being hidden by `visibleTodos()`,
   not a delete."** Wrong, and backwards. `tombstone` *is* the delete marker — `removeTodo` is its
   only writer (`todos.ts:475`). The tombstones are the cleanup's own `DELETE /todos/:id` calls
   succeeding at `08:18:56`. The todos were deleted; they were never hidden, because they were
   never marked started.
2. **The brief said the `continue-3` cleanup "got 404 for both todo deletes, plausibly because a
   started/tombstoned todo is not a target `DELETE` recognizes."** The 404s are real but their cause
   is simpler: the *first* script had already tombstoned both rows 65 seconds earlier, and
   `removeTodo` answers `false` for an already-tombstoned row (`todos.ts:472-473`), which the route
   maps to `404` (`server.ts:6147`). That is correct, documented behaviour, and the ship spec
   already calls `404` an acceptable terminal answer. It is not a defect.
3. ~~**The brief cited the ship spec as `.ai/specs/2026-08-24-ship-bulk-start-filed-tasks.md` with
   line numbers.** That file is **not** in the main checkout under that path; the committed spec is
   `.ai/specs/2026-08-24-bulk-start-filed-tasks.md` (99 lines, no P5). The 1330-line document with
   the P5/P6 the brief quotes exists only inside `480e0282`'s own worktree. Its P5 text is quoted
   accurately by the brief; the path is not.~~

   **CORRECTED 2026-08-25 (review) — claim 3 was itself wrong, and the brief was right.** It was
   written from this worktree, which is 55 files behind `origin/main`. Measured against
   `origin/main` after a fetch, **both** documents are committed there:

   ```
   $ git ls-tree -r --name-only origin/main -- .ai/specs | grep bulk-start
   .ai/specs/2026-08-24-bulk-start-filed-tasks.md            #    71 lines
   .ai/specs/2026-08-24-ship-bulk-start-filed-tasks.md       # 1,330 lines
   ```

   Both landed in `7932cf4d` itself (`+71` and `+1330` in its `--stat`). So the brief's path is
   correct, the ship spec is a tracked, durable file — which is what makes it a legitimate
   implementation target for F2 — and this document's own line count for the short spec ("99") was
   wrong too: it is 71. **Checking a repository-history claim against the local `HEAD` of a
   worktree that is deliberately behind is not checking it.**

4. **This document said `7932cf4d` "touched only `packages/web/**` and specs".** It also deleted
   `packages/cezar/test/unit/deploy-e2e-probe.test.ts` (-348 lines). Corrected in the header block
   above; noted here because the same sentence appeared twice.

5. **This document called defect 1 "a live production bug in the feature `7932cf4d` just
   shipped".** The start-ordering defect **predates** `7932cf4d`, which changed no file under
   `packages/cezar/src`. Corrected in § TLDR.

### The cluster question is SETTLED — this box is the hub, deliberately

**This section previously read "What could not be verified" and led with "whether `CEZ_CLUSTER=1`
on this box is correct configuration or a leftover", proposing a measurement phase to decide it.
That was an open question in this document only; the record had already closed it.** Measured
directly, 2026-08-25:

```jsonc
// /var/lib/cezar/.cezar/cluster/node.json   (0600 cezar:cezar, created 2026-08-24T11:15:34.493Z)
{ "nodeId": "06495ac4-0146-4e6d-b021-ea591f3cc63e", "nodeName": "prod-host",
  "role": "hub", "acceptsDispatch": true, "labels": ["cgroup", "claude", "codex"] }
```

- `systemctl show cezar.service -p Environment` → `Environment=CEZ_CLUSTER=1`.
- `peers.json` carries an enrolled **spoke**, `mac-mw` (`bb40a34d-…`, `role: "spoke"`, labels
  `macos`/`imessage`/`device-e2e`), last seen `2026-08-24T11:59:00.086Z`.
- `enroll-codes.json` shows a real redemption (`redeemedByNodeId: bb40a34d-…`).
- `hub-seq.json` → `{"counters": {"project:cezar": 272}}`, and the disposable todo `520e2bbe-…`
  carries `hubSeq: 272`. The hub sequencer is not idle; it numbered this very fixture.

This is the activation `.ai/specs/2026-08-22-multi-node-cezar-cluster.md` spent its "THE BLOCKER"
block making possible: that spec records that **no shipped code path could mint a hub identity**
(`ensureNodeIdentity({role:'hub'})` existed only in tests), and that the fix landed 2026-08-23 as a
sixth subcommand, `cez cluster init`. The `node.json` above is that command's output. **So
`CEZ_CLUSTER=1` here is intentional and current, not vestigial** — the same spec's line 5734
("`CEZ_CLUSTER` is unset everywhere on prod-host") is a *pre-activation* observation and must
not be read as the present state.

Two consequences that F1 must carry, and that a "measurement phase" would have obscured:

1. **There is no hub-side confirmer to wire into the HTTP route.** The only `confirmStart` a hub
   produces is `hubSelfConfirm(projectKey)`, and it is a **closure created inside the
   `createHubAutostartDispatch` factory** (`packages/cezar/src/cluster/hub-autostart-dispatch.ts:92`,
   handed to `markStartedWithClaim` only at `:210`). It is not exported, and it needs
   `deps.allocateHubSeq` and `deps.identity` — neither of which `server.ts`'s todo-start route
   holds. The route's fix is therefore **not a one-file change**: it needs a role-aware seam that
   resolves *this node's* confirmer (hub → self-confirm; spoke → the link's confirmer; unclustered
   → none) and reaches the HTTP handler. `hub-autostart-dispatch.ts:200-206` states the invariant
   that seam must preserve, in its own words: a hub confirming its own claim "is not a shortcut past
   the exactly-once property; it is that property stated where it is trivially true."
2. **A `humanIntent: true` shortcut is not available as a free win here,** because on a hub a
   confirmer genuinely exists and skipping it discards the serialization. See § Solution.

### What still could not be verified

- **Whether `manager.cancel()` would have succeeded had it been reached.** No cancel ever reached
  the `cezar` project's manager, so the cancel path itself is untested here, not exonerated.
- **Whether the boot project at `/var/lib/cezar/workspace` has ever legitimately served an
  unscoped run route.** Not investigated; the dual mount may be correct for its intended callers.

## Solution

**Nothing in this section is implemented by this task.** It is the design brief the three
follow-up tasks (F1/F2/F3 in § Phases) inherit — stated here because a filed task with no design
is a rediscovery request.

Three changes, in descending order of user impact, each independently shippable.

**A. Make the start refusal visible — and do NOT do it by confirming after the fact.**

> **SUPERSEDED 2026-08-25 by the review below.** The original text read: *"Switch `server.ts:6198`
> from `markStarted` to `markStartedWithClaim`, pass `humanIntent: true` (a person clicked ▶ Run —
> the route's own comment two lines above says exactly that), and surface a refusal in the `201`
> body rather than discarding it. D15a row 1 (`todos.ts:948-955`) explicitly sanctions the
> optimistic stamp for human intent, marks it pending, and lets the hub reconcile later. This is
> the change that makes the Filed row disappear when the user clicks."* It is kept because the
> D15a citation is accurate and the "surface the refusal" half survives; the ordering does not.

**Why the original is not a solution: it leaves the run running and the claim lost.** The route's
sequence is `manager.startRun(...)` **first**, then the todo bookkeeping. Confirming the claim
*after* execution has already begun means a refusal arrives at a node that is already running the
work, and nothing in that path stops it. This is not a hypothetical; the cluster record names it as
a known, open, **owner-level** defect:

> **D41 — THE D9a DOUBLE-START IS REAL, AND IT IS REPORTED RATHER THAN PREVENTED.** *"The hub
> refusing a claim does not stop the run this node already started. … So two nodes can be running
> the same task, and the guard built to prevent exactly that reports the collision after the fact
> instead of preventing it."* … *"This is an owner decision, not an engineering one. Either a claim
> becomes synchronous (the spoke waits for `accepted` before starting, which is what D9a's own text
> says `accepted` means and costs a round trip on every start), or the double-start is accepted and
> something must reconcile it. It is currently neither: documented, warned about, and live."*
> — `.ai/specs/2026-08-22-multi-node-cezar-cluster.md:5822`, still listed as genuinely open at
> `:4812`.

Passing `humanIntent: true` from the HTTP route does not dodge D41 — **it widens it.** `humanIntent`
is the path D15a sanctions for when the hub *cannot be asked at all*; on this box the hub is this
process, so it can always be asked, and using `humanIntent` there would stamp `startedTaskId`
optimistically while skipping the one serializer that exists. The `mac-mw` spoke is enrolled and
`acceptsDispatch: true`, so "two nodes, one todo" is a reachable state, not a thought experiment.

**So F1's design is constrained, and the constraints are the deliverable, not the code.**

> **CORRECTED 2026-08-25 (second review) — "either claim-before-start or compensating cancellation"
> was not a choice this document could leave open, because one branch of it is not reachable with
> the current API.** `markStartedWithClaim(dataDir, id, taskId, options)` requires a `taskId`
> (`packages/cezar/src/todos.ts:881-885`), and the only `taskId` there is is `run.id` — minted by
> `this.store.createRun({...})` **inside** `manager.startRun` (`workflows/run.ts:1503`), whose last
> three statements are `pendingJobs.set(run.id, …)`, `queue.push(run.id)`, `void this.pump()`
> (`:1569-1571`). Execution is enqueued synchronously, in the same call that mints the id. So
> "claim before start" cannot mean "call `markStartedWithClaim` before `manager.startRun`": there is
> no id yet, and a refusal at that point has no run to refuse. The route must be split, not
> re-ordered, and the design below is that split. The original wording is kept above.

**F1's design: prepare → claim → enqueue, with rollback on both failure edges.**

1. **Split `RunManager.startRun` into three exported operations, changing no existing caller.**
   `workflows/run.ts:1493-1573` today does two separable things: it *materialises* a run record
   (`createRun`, `updateRun(workflowDef)`, pasted-image persistence, `refineTaskRefs`, the
   fire-and-forget `autoNameRun`) and then it *enqueues* it (the last three statements).
   - `prepareRun(workflow, input, group?): RunRecord` — everything up to and **not** including
     `pendingJobs.set`. The run exists in the index with `status: 'queued'`
     (`runStatusSchema`, `packages/contract/src/runs.ts:30-38`) and nothing is executing it.
   - `enqueueRun(runId): void` — exactly the three removed statements.
   - `discardPrepared(runId): void` — the rollback. Asserts the id is absent from `queue`,
     `pendingJobs` and `active` (it must be, if it was never enqueued), then `store.deleteRun(runId)`.
   - `startRun` becomes `prepareRun` followed by `enqueueRun` and keeps its exact signature and
     return type, so `cezar run`, `startVariants` (`:1582-1591`), the inbox "▶ Run" and the
     workspace-run paths are untouched. **This is the whole reason to split rather than to
     re-order:** only the todo-start route needs a seam in the middle.
2. **The route becomes two-phase, with the claim between the phases:**

   ```ts
   const run = manager.prepareRun(workflow, { task, /* … */ author: authorOf(c, 'todo-start') });
   let claim: TodoStartClaimResult;
   try {
     claim = await markStartedWithClaim(dataDir, id, run.id, { confirmStart: resolveConfirmer(...) });
   } catch (err) {
     manager.discardPrepared(run.id);                     // rollback edge 1: the claim threw
     throw err;
   }
   if (!claim.started) {
     manager.discardPrepared(run.id);                     // rollback edge 2: the claim refused
     return c.json({ error: 'start-refused', todoStart: claim }, 409);
   }
   try {
     manager.enqueueRun(run.id);
   } catch (err) {
     await clearStartedTaskId(dataDir, run.id);           // rollback edge 3: release the claim taken
     manager.discardPrepared(run.id);
     throw err;
   }
   return c.json({ run }, 201);
   ```

   **Rollback edge 3 is the one that is easy to omit and expensive to omit.** By the time
   `enqueueRun` runs, `startedTaskId` is already written and points at a run that will never
   execute; without `clearStartedTaskId` (`server.ts:5199-5206`, the same call the cancel route
   makes) the todo is permanently stuck in "started" with no run behind it, which is defect 1
   inverted and worse.
3. **Rollback must be cheap, and F1 must prove it rather than assume it.** No worktree exists at
   prepare time — `createWorktree` is called on the execute path (`workflows/run.ts:5188`), not in
   `startRun` — so `discardPrepared` has nothing to unwind but the index entry. **Verify that
   before relying on it**, and note `store.deleteRun` (`runs/store.ts:1364-1378`) removes the
   NDJSON, the handoff and the images directory but **not** `<id>.spool` or `<id>.broker.log`; a
   prepared-and-discarded run should have created neither, which is itself an assertion worth
   writing.
4. **Refusal status and body: `409`, not a `201` carrying a refusal.** The route already speaks 409
   three times with the same `{ error: string }` shape — locked models (`server.ts:6172`), `'already
   started'` (`:6175`) and a blocked provider (`:6186`) — and a refusal is the same class of answer:
   *you cannot start this right now*. Emitting `201 { run }` when `discardPrepared` has just deleted
   that run would hand the client an id that no longer resolves, which is a worse lie than the one
   being fixed. Body: `{ error: 'start-refused', todoStart: { started, reason, message } }`, with
   `reason`/`message` taken verbatim from `TodoStartClaimResult` (`todos.ts:824-864`).
5. **Prove the property, don't assert it.** F1 is not done until a test drives (a) a confirmer that
   refuses and (b) a claim lost to a concurrent `already-started`, and asserts in both cases that
   **no run record survives at all** for that todo — not merely that no run is *active*. A green
   "the refusal was returned" test proves nothing about D41; that is precisely the shape D41 says is
   already shipped.
6. **Treat the offline human-intent path separately.** Unclustered installs, and a spoke whose link
   is genuinely down, are the case D15a row 1 (`todos.ts:948-955`) legitimately covers — optimistic
   stamp, marked pending, reconciled later. That branch is fine and should stay. It must be reached
   by *detecting that no confirmer is resolvable*, never by the HTTP route asserting human intent
   unconditionally. On that branch the claim succeeds, so the route proceeds to `enqueueRun`
   normally and answers `201` exactly as today.
7. **Surface the refusal regardless.** `todos.ts`'s own docblock cites **D15a — "the refusal is a
   stated, rendered state — never a silent skip"**, and today the route discards the boolean.
   Rendering it is required by the contract the function was written to satisfy, and it has a
   contract cost — see § Data models, which also records that turning some `201`s into `409`s is
   **breaking** under `BACKWARD_COMPATIBILITY.md`'s own definition and owes the documented path.

**F1 may therefore land in front of D41's owner decision**, because prepare-claim-enqueue is
strictly narrower than D41's cross-node question: it makes *this node's* HTTP start atomic and does
not decide what a spoke does when a hub refuses a claim it has already begun executing. Anything
broader is blocked on the owner.

**B. Address runs by their project.** Any cleanup — and the E2E harness in `480e0282`'s P5 — must
use `/api/v1/p/${projectId}/runs/${id}/…`, taking `projectId` from the run index entry rather than
assuming the boot project. Separately, **stop coding `404` as success on the delete path**: a `404`
from a run you just created and hold the id for is a cleanup failure, not a completed one.

**C. Assert cleanup against a tombstone-aware view — and settle what a tombstone means at every
todo boundary, not just this one.**

> **CORRECTED 2026-08-25 (second review). The original text — *"Either filter `isTombstoned` in
> `WorkspaceTodoIndex.list()` (it is a board index, and every board consumer already filters
> client-side), or have the assertion filter it. Preference is the former"* — rests on a false
> claim about the current code and proposes a change `BACKWARD_COMPATIBILITY.md` forbids.**
>
> **No board consumer filters tombstones.** Measured: `isVisibleFiledEntry`
> (`packages/web/src/lib/filed-tasks.ts:76-78`) is `return !entry.todo.startedTaskId` — nothing
> else. `visibleTodos` (`packages/web/src/routes/inbox.tsx:56-58`) is the same one predicate. Across
> `packages/web/src` the string `tombstone` appears exactly once, in a comment
> (`lib/task-node.ts:13`). Across `packages/cezar/src` the only non-test caller of `isTombstoned`
> (`todos.ts:145`) is **`removeTodo` itself** (`:474`). So `readTodos`'s docblock line *"Board
> consumers filter with `isTombstoned`"* (`todos.ts:467`) describes an intention that was never
> implemented, and it is the sentence that made this document's earlier claim look checked.
> **That docblock is itself a stale entry and F3 must correct it in place.**
>
> **And the deleted row is startable.** `todoMustExist` (`server.ts:6093-6098`) resolves the id out
> of raw `readTodos` and checks only that it is present, so `POST /todos/:id/start` will happily
> start a tombstoned todo. `updateTodo` (`todos.ts:678-687`) likewise patches a tombstoned row.
> `DELETE` is the one boundary that gets it right, via `removeTodo`'s own `isTombstoned` check.
>
> **So C is not "add a filter"; it is "decide what a tombstone means at the GET, PATCH, start and
> delete boundaries, on both todo list routes, and make each boundary say it."** The board-view
> half must be **opt-in**, because removing rows from an existing response is breaking under
> `BACKWARD_COMPATIBILITY.md:5` ("anything that makes … an existing output disappear … is
> breaking"). See § Data models for the query-parameter design and the equality contract on
> `projects[].total`, and F3 in § Phases for the audit.
>
> Unchanged from the original and still correct: **`readTodos` keeps returning tombstoned rows.**
> That is D5a — the outbox derivation reads through it and must be able to see the delete
> (`todos.ts:466-467`) — and no part of C may weaken it.

Explicitly **not** in scope: changing the dual-mount design, changing the tombstone-vs-removal
design (D6), adding a "disposable todo" concept to the data model, or touching the shipped
`packages/web` bulk-start UI, which is not implicated in either defect.

## Architecture

```
  ▶ Run / Run N tasks
        │
        ▼
  POST /api/v1/p/cezar/todos/:id/start        server.ts:6164
        │
        ├── manager.startRun(...)  ────────────────────────►  run created, 201 ✔
        │
        └── markStarted(dataDir, id, run.id)  server.ts:6198
                │  options === undefined
                ▼
            markStartedWithClaim              todos.ts:881
                │  clusteringOn() → true      (CEZ_CLUSTER=1)
                ▼
            askHubToConfirm                   todos.ts:848
                │  options?.confirmStart === undefined
                ▼
                return undefined  ──►  !ack && !humanIntent
                                              │
                                              ▼
                              {started:false, reason:'hub-unconfirmed'}   ✘ nothing written
                                              │
                                    (boolean discarded by the route)
                                              │
                                              ▼
                       startedTaskId absent → visibleTodos() keeps the row → Filed never clears
```

and the cleanup half:

```
  cleanup: POST /api/v1/runs/<cezar run id>/cancel
                │  no :projectId param
                ▼
        resolveProjectScope → bootContext          server.ts:2097-2101
                │  boot = /var/lib/cezar/workspace   (systemd WorkingDirectory)
                ▼
        store.getRun(id) → undefined → 404          server.ts:5194
                │
                ▼
        script: `![200,404,409].includes(status)` → no failure recorded   ✘ run survives
```

## Data models and API contracts

> **CORRECTED 2026-08-25 (review). This section opened "No schema changes." That is false, and it
> is the kind of false that makes a follow-up task fail its first gate.** This repo pins route and
> schema to each other with a *mutual* type assertion, not a subset one:
>
> ```ts
> // packages/contract/src/skills.ts:235
> export const startTodoResponseSchema = z.object({ run: runRecordSchema });
> export type StartTodoResponse = z.infer<typeof startTodoResponseSchema>;
>
> // packages/cezar/src/server/contract-parity.workflows.test.ts:61,82
> type StartTodo201 = InferResponseType<(typeof client.api.v1.todos)[':id']['start']['$post'], 201>;
> Assert<Exact<z.infer<typeof startTodoResponseSchema>, StartTodo201>>,
> ```
>
> `Exact<>` fails in **both** directions — that file's own `it('is enforced by tsc, not at
> runtime')` pins the comparator with a `'schema-is-wider'` / `'route-is-wider'` pair precisely so
> a degenerate `true` cannot make the assertions vacuous.
>
> **CORRECTED AGAIN 2026-08-25 (second review), twice over.** First, the line above was quoted with
> `InferResponseType<…, 200>`; the file says **`201`** (`contract-parity.workflows.test.ts:61`), and
> `packages/api-client/src/client.ts:83` records that this route "has no 200 branch at all", so a
> `200` there would not even compile. Corrected in the quote. Second, and larger: **the `todoStart`
> optional field on the `201` is withdrawn.** It was designed for a route that returns a run
> alongside a refusal, and § Solution A now shows that route cannot exist — a refused start
> `discardPrepared`s the run, so there is no `run` to put in a `201` body. The withdrawn proposal
> read: *"add the optional `todoStart` to `startTodoResponseSchema` … `StartTodoResponse` re-infers
> for free"*, with a five-file change set built on it. It is kept in this sentence and nowhere else.

**The contract F1 actually changes: a new `409` branch, and `startTodoResponseSchema` untouched.**

`POST /api/v1/p/:projectId/todos/:id/start`, today:

| Status | Body | Emitted at |
| --- | --- | --- |
| `201` | `{ "run": { /* RunRecord */ } }` | `server.ts:6199` |
| `409` | `{ "error": "<AGENT_MODELS_LOCKED_ERROR>" }` | `server.ts:6172` |
| `409` | `{ "error": "already started" }` | `server.ts:6175` |
| `409` | `{ "error": "<provider blocked>" }` | `server.ts:6186` |
| `404` | `{ "error": "not found" }` | `todoMustExist`, `server.ts:6096` |
| `400` | validator | `jsonZodValidator(startTodoSchema, …)` |

After F1, one branch is added and none is removed:

```jsonc
// 409 — the todo claim was refused, and the prepared run has been discarded.
{ "error": "start-refused",
  "todoStart": { "started": false,
                 "reason": "hub-unconfirmed" | "hub-refused" | "already-started" | "not-found",
                 "message": "waiting for the hub to confirm the claim" } }
```

`reason` and `message` are `TodoStartRefusal` / `TodoStartClaimResult` verbatim (`todos.ts:824-864`)
— no second vocabulary. The `201` body is byte-identical to today on every path that still reaches
it, so **`startTodoResponseSchema` and the `Exact<>` parity assertion do not change**, which is the
main practical advantage of the 409 shape over the withdrawn one.

**F1's change set, restated for the two-phase design:**

1. `packages/cezar/src/workflows/run.ts` — `prepareRun` / `enqueueRun` / `discardPrepared`, with
   `startRun` re-expressed as the first two (§ Solution A step 1). No caller outside the route
   changes.
2. `packages/cezar/src/server/server.ts:6188-6199` — the two-phase body, the confirmer resolver, and
   the three rollback edges.
3. `packages/contract/src/skills.ts` — **audit, then decide.** The parity test pins the `201` only,
   so a new `409` may need no schema at all. F1 must check whether this family declares its error
   bodies (grep the contract package for the sibling `409` shapes) and follow whatever it finds
   rather than inventing a second convention. Record the finding either way.
4. `packages/web/src/api/client.ts` — `startTodo` (`:1636`) and `startWorkspaceTodo` (`:1664`) throw
   on a non-2xx today, so a `409` already reaches the consumers as a **throw**. That is the
   mechanism the table below builds on.

**Consumer behaviour must be specified, or the status change is a worse silence than the bug.**
Today all three consumers treat "did not throw" as "started". Under the 409 they *will* throw — but
a generic error toast for a hub refusal is not "a stated, rendered state" either:

| Consumer | Code | Today | Required of F1 |
| --- | --- | --- | --- |
| Bulk "Run N tasks" | `useStartFiledTasks`, `packages/web/src/routes/global-tasks.tsx` (origin/main) | `await startWorkspaceTodo(...); started += 1` inside `try`; only a **throw** lands in `failures`. Toast: `Started ${started} task${…}`. | A `409 start-refused` must land in `failures` **and be named as a refusal, not an error** — the toast reads `Started 9 of 12; 3 awaiting hub confirmation`, using `todoStart.message`. This is the case that motivated the whole change: twelve rows, one green toast, nothing moved. |
| Single ▶ Run on a filed row | `useStartFiledTask`, same file | `onSuccess` → `navigate(scopeTo(projectId, '/tasks/'+result.run.id))` unconditionally. | **Do not navigate** — there is no run to navigate to, because `discardPrepared` deleted it. Render `todoStart.message` in place, on the row. |
| Inbox card ▶ Run | `packages/web/src/routes/inbox.tsx:206` via `startTodo` | Same unconditional navigate. | Same as above. Note this card also drives `visibleTodos()` (`inbox.tsx:56-58`), so it is where the "row didn't leave" symptom is seen first. |

**`BACKWARD_COMPATIBILITY.md:5` makes this breaking, and F1 owes the documented path.** A call that
used to answer `201 {run}` in the refusal case now answers `409`, which "makes an existing output
disappear". The package is 0.x, so the required path is: a note in the README **and** the CHANGELOG,
a migration path (here: read `todoStart` on the `409`; the old `201` never carried a usable run in
this case, which the note should say), and a **minor** version bump called out as breaking. F1 must
not skip this on the grounds that the old `201` was wrong — the rule is about the shape a caller
sees, not about whether that shape was correct.

**The two todo list routes: the default response does not change, and the board view is opt-in.**

> **CORRECTED 2026-08-25 (second review). This block previously specified that `GET
> /api/v1/workspace/todos`'s `todos[]` would simply stop containing tombstoned entries, calling it
> *"a **behaviour** change to a documented surface"* needing a consumer audit and a note. That is
> not what `BACKWARD_COMPATIBILITY.md` says.** Its general rule, line 5 verbatim: *"additive changes
> (new optional field, new flag, new route) are fine; anything that makes an existing input
> rejected, **an existing output disappear**, or an existing file unreadable is breaking."* Rows
> vanishing from an existing response is exactly an existing output disappearing, and 0.x breaking
> needs a README **and** CHANGELOG deprecation note, a migration path, and a minor bump *called out
> as breaking* — none of which the old text budgeted. The superseded design is retained in this
> paragraph.

Two routes are in scope, and today they behave the same way for the same reason:

| Route | Handler | Tombstones today |
| --- | --- | --- |
| `GET /api/v1/p/:projectId/todos` | `server.ts:6105`, `c.json(await readTodos(dataDir))` | **present** — raw `readTodos`, no filter anywhere |
| `GET /api/v1/workspace/todos` | `workspace-todos-routes.ts:55` → `WorkspaceTodoIndex.list()`, `workspace/todo-index.ts:83` | **present** — `readTodos` again, no `isTombstoned` in the file |

**Design: an additive, opt-in query parameter on both, defaulting to today's behaviour.**

```
GET /api/v1/p/:projectId/todos?tombstoned=exclude
GET /api/v1/workspace/todos?tombstoned=exclude
```

- `tombstoned` absent, or `tombstoned=include` → **byte-identical to today**, tombstoned rows
  present, `projects[].total` still `items.length`. Nothing existing disappears, so this stays on
  the additive side of line 5 and needs no deprecation path.
- `tombstoned=exclude` → rows with `todo.tombstone` set are omitted, **and `projects[].total` is
  computed from the same filtered array**, so the two halves agree.

The cockpit's Filed table and the corrected E2E cleanup assertion (§ Verification, and F2's helper)
both pass `tombstoned=exclude`. A sibling route (`/workspace/todos/board`) was considered and
rejected: it duplicates the whole `WorkspaceTodoIndex` response shape in the contract package for
one predicate, and a new route is no more additive than a new optional query parameter.

**Why `projects[].total` has to move with the filter.** `WorkspaceTodoIndex.list()` builds the two
halves from one array and counts the raw one (`packages/cezar/src/workspace/todo-index.ts`):

```ts
const items = await this.readTodosFn(dataDir);
for (const todo of items) todos.push({ project: source.id, todo });
projects.push({ id: source.id, name: …, status: source.status, ok: true, total: items.length });
```

Filter the `for` and leave `total: items.length` and the endpoint answers, for `cezar` today, a
`todos[]` short by two rows beside a `total` that still counts them — **an unexplained discrepancy
that reads to a client as truncation**, which is the failure mode `list()`'s own docblock says it
avoids ("No cap, no truncation").

**The stated contract, asserted as an equality rather than a hard-coded number, under both views:**

- **Index level** (`packages/cezar/src/workspace/todo-index.test.ts`, Vitest): a fixture `readTodos`
  returning 3 rows of which 1 is tombstoned. Default view → `todos` length 3, `projects[0].total`
  `3`. `tombstoned: 'exclude'` → `todos` length 2, `projects[0].total` `2`. Plus the invariant, in
  both cases and asserted generically, so it survives a future predicate:
  `expect(result.projects.every(p => p.total === result.todos.filter(t => t.project === p.id).length)).toBe(true)`.
- **Endpoint level** (`workspace-todos-routes` test, injecting `deps.todoIndex`): the same equality
  over the JSON body for both values of the parameter, so a future change that filters in the route
  rather than the index cannot reintroduce the skew. Plus: an unrecognised `tombstoned=` value is a
  `400`, not a silent fallback to the default — a typo that silently returns tombstones is how this
  assertion was wrong the first time.
- **Contract level**: `packages/contract/src` gains the optional query parameter; the workspace-todos
  parity assertion must be updated in the same commit — the `Exact<>` rule above applies identically
  here. The **response** schema is unchanged, which is the point of the opt-in shape.

Note that `projects[].total` for a `status: 'missing'` project is hard-coded `0` today and stays
`0` under either view; the equality invariant holds for it trivially.

**Alternative, if the owner would rather change the default.** Then it is breaking and the full path
is owed: README + CHANGELOG note, a documented migration (`?tombstoned=include` restores the old
answer), and a minor bump called out as breaking. F3 may take that route **only** with that path
executed; it may not take it on the argument that the old default was a mistake.

## Phases

**Scope split, restated so it cannot be missed: P1 and P2 are this task; P3 is an EXTERNAL actor's,
because this run cannot execute it. F1, F2 and F3 are designs handed to separate tasks and are NOT
implemented here.**

> **RE-ORDERED 2026-08-25 (second review).** The earlier phase list ran *cancel and delete both runs
> (P1) → file the follow-ups (P2) → verify*, which cannot execute in that order: cancelling this run
> interrupts the session that would run the rest (`RunManager.cancel` → `state.interrupt()`,
> `workflows/run.ts:3661-3663`). Everything after that point was unreachable. The filing moved to
> **P1** because it is the durable output and must land before anything is destroyed; the sibling
> cleanup is **P2**, the only cancellation this run can safely perform; and this run's own reaping is
> **P3**, assigned out.

> **SUPERSEDED 2026-08-25 (review).** A phase here previously read *"P1: Settle the cluster question
> — measurement only"*, forking on whether `CEZ_CLUSTER=1` is "a spoke with a real hub" or
> "standalone and vestigial". **Neither branch is the fact.** `/var/lib/cezar/.cezar/cluster/node.json`
> says `role: "hub"`, `nodeName: "prod-host"`, minted `2026-08-24T11:15:34.493Z` by the
> `cez cluster init` subcommand that `.ai/specs/2026-08-22-multi-node-cezar-cluster.md` landed on
> 2026-08-23 for exactly this purpose; a spoke (`mac-mw`) is enrolled and the hub sequencer numbered
> this very fixture (`hubSeq: 272`). The box is **the intentionally activated hub**. Full evidence
> in § Measured facts → "The cluster question is SETTLED". There is nothing left to measure, so the
> measurement phase is deleted rather than kept as an open question.

### P1 — File the three defects as their own tasks *(THIS TASK; no code; runs FIRST)* — **DONE 2026-08-25**

The diagnosis is the value here, and it must land **before** anything is cancelled or deleted: P2
destroys a run and P3 destroys this one, and a task filed after that point would be filed by nobody.

**Each todo must be self-contained.** An earlier draft pointed each `--context` at a section of this
document and stopped there, which made three durable tasks depend on one file whose durability was
itself in question (§ Verification 0). The `--context` below therefore carries the finding, the
citation *and* the constraint, so a reader who never opens this spec can still act; the spec path is
a pointer for depth, not the payload.

```bash
cezar todo add "Todo start route: claim before enqueue, and render the refusal" \
  --project cezar --priority high \
  --context "packages/cezar/src/server/server.ts:6198 calls markStarted(dataDir, id, run.id) with NO options. On this box (role=hub, CEZ_CLUSTER=1) askHubToConfirm returns undefined for a missing confirmStart (todos.ts:848-856), so markStartedWithClaim returns {started:false, reason:'hub-unconfirmed'} and WRITES NOTHING (todos.ts:941-947) while the route still answers 201. Net effect: every 'Run' and every bulk start creates a run and leaves the row on Filed. Deterministic. Fix shape: split RunManager.startRun (workflows/run.ts:1493-1573) into prepareRun / enqueueRun / discardPrepared, claim between them, and answer 409 {error:'start-refused', todoStart} on refusal after discarding the prepared run - a refused start has no run to return. Predates 7932cf4d. Adjacent to OPEN OWNER decision D41 (.ai/specs/2026-08-22-multi-node-cezar-cluster.md:5822); the prepare/claim/enqueue split is narrower than D41 and does not pre-empt it. Detail: .ai/specs/2026-08-25-silent-start-cleanup-failures.md SS Solution A + Data models." \
  --acceptance "startRun split into prepareRun/enqueueRun/discardPrepared; no existing caller changes" \
  --acceptance "Claim runs between prepare and enqueue; refusal discards the prepared run and answers 409" \
  --acceptance "Rollback covers all three edges, including clearStartedTaskId when enqueueRun throws" \
  --acceptance "Test proves NO run record survives a refusal and a lost-claim race, not merely no active run" \
  --acceptance "201 body byte-identical; startTodoResponseSchema and the Exact<> parity assertion unchanged" \
  --acceptance "Bulk 'Run N tasks' names refusals separately from errors; single Run does NOT navigate on a refusal" \
  --acceptance "README + CHANGELOG breaking note and a minor bump: a 201 became a 409 (BACKWARD_COMPATIBILITY.md:5)"

cezar todo add "Cleanup helper: project-scoped run routes, and 404 is never 'done'" \
  --project cezar --priority medium \
  --context "The E2E cleanup in task 480e0282 addressed /api/v1/runs/:id/cancel and DELETE /api/v1/runs/:id - UNSCOPED. createApp mounts the runs sub-app twice (server.ts:2086-2104): unscoped binds to the BOOT project (cezar.service WorkingDirectory=/var/lib/cezar/workspace), not to cezar where the runs live. Both answered 404, and the script coded 404 as 'already gone', so cleanup reported success while cancelling nothing. Two live runs were the artifacts. Also note the real contracts the old script got wrong: POST /runs/:id/cancel answers 200 {cancelled:boolean} (server.ts:5192-5207), never 409, so the BODY must be parsed; DELETE /runs/:id answers 409 while manager.isActive(id) (server.ts:5881) and cancellation drains asynchronously, so the delete needs a bounded poll. Deliverable is a TRACKED helper plus tests, not an edit to a throwaway .cjs. Detail: .ai/specs/2026-08-25-silent-start-cleanup-failures.md SS Problem 2 + F2." \
  --acceptance "Tracked cleanup helper that builds /api/v1/p/:projectId/runs/... from a captured projectId" \
  --acceptance "Tests assert the captured project id reaches the URL, against a stubbed fetch" \
  --acceptance "Cancel body parsed: {cancelled:false} on a non-terminal run is a failure" \
  --acceptance "DELETE bounded-polls 409 (2s x 60s); a 409 at the deadline is a reported failure" \
  --acceptance "A FIRST 404 on cancel or delete of a preflighted id is a FAILURE, and a test proves it red against the old inline logic" \
  --acceptance "P5 of .ai/specs/2026-08-24-ship-bulk-start-filed-tasks.md corrected IN PLACE"

cezar todo add "Settle what a tombstoned todo means at every route boundary" \
  --project cezar --priority medium \
  --context "readTodos deliberately returns tombstoned rows (D5a, todos.ts:466-467) and MUST keep doing so. But its docblock line 'Board consumers filter with isTombstoned' is false: measured, isVisibleFiledEntry (packages/web/src/lib/filed-tasks.ts:76-78) and visibleTodos (packages/web/src/routes/inbox.tsx:56-58) each check only startedTaskId; 'tombstone' appears once in packages/web/src, in a comment; and the ONLY non-test caller of isTombstoned in packages/cezar/src is removeTodo itself (todos.ts:474). Consequences: GET /todos (server.ts:6105) and GET /workspace/todos (workspace/todo-index.ts:83) both return deleted rows, todoMustExist (server.ts:6093-6098) will START a tombstoned todo, and updateTodo (todos.ts:678-687) will PATCH one. Removing rows from the existing responses is BREAKING per BACKWARD_COMPATIBILITY.md:5 ('an existing output disappear'), so the board view must be an opt-in ?tombstoned=exclude with projects[].total computed from the same filtered array. Detail: .ai/specs/2026-08-25-silent-start-cleanup-failures.md SS Solution C + Data models + F3." \
  --acceptance "Audit written down: GET, PATCH, start and DELETE boundaries on both todo list routes" \
  --acceptance "todoMustExist 404s a tombstoned todo; a test proves it red first" \
  --acceptance "Opt-in ?tombstoned=exclude on both list routes; default response byte-identical to today" \
  --acceptance "projects[].total equals that project's row count in todos[] under BOTH views, asserted generically" \
  --acceptance "An unrecognised ?tombstoned= value is a 400, not a silent default" \
  --acceptance "readTodos still returns tombstoned rows (D5a), with a test" \
  --acceptance "The false 'Board consumers filter with isTombstoned' docblock at todos.ts:467 corrected in place"
```

**Done when:** `cezar todo list --project cezar` shows the three rows, and their ids are appended
to this run's handoff file so P3's external actor can find them without reading this document.

### P2 — Cancel and delete the SIBLING run only *(THIS TASK; operational, no code)* — **DONE 2026-08-25**

**Scope: `ae7bd42f-a399-4ceb-92cf-d657e620d80f` and nothing else.** This run
(`a3dd8f5f-5d66-402e-b876-c1a6746d9da7`) is P3's, not P2's — see the phase preamble.

Both runs are live: `runs.json` reports `status: "running"` for each, and each holds a worktree
under `.ai/cezar/worktrees/`, so each is burning a `maxParallel` slot and tokens right now.

**Everything is project-scoped and authenticated.** The unscoped `/api/v1/runs/:id/…` spelling is
the whole of defect 2 — it binds to the boot project (`/var/lib/cezar/workspace`) and answers `404`
for a `cezar` run. The session is minted, used and destroyed per § Verification 0a; it is never
pasted into a command line as a literal, which is what `S=<session id>` in the superseded draft
amounted to.

**Step 1 — preflight, with assertions that abort.** The superseded draft printed status codes and
carried on regardless; `-w '%{http_code}'` writes to stdout and does not affect the exit status, so
nothing in it could stop. This form stops.

```bash
set -euo pipefail
B=http://127.0.0.1:4321/api/v1/p/cezar
GHOST=ae7bd42f-442f-4314-ab36-f7b96dbec097          # named by review; absent from disk
SIB=ae7bd42f-a399-4ceb-92cf-d657e620d80f            # the real sibling

code() { curl -sS -o /dev/null -w '%{http_code}' -H "cookie: cez_session=$CEZ_CLEANUP_SESSION" "$@"; }

g=$(code "$B/runs/$GHOST")
[ "$g" = 404 ] || { echo "STOP: ghost id answered $g — a run this document cannot see exists; re-scope"; exit 1; }
p=$(code "$B/runs/$SIB")
[ "$p" = 200 ] || { echo "STOP: sibling preflight answered $p, want 200"; exit 1; }
```

A `401` on the sibling preflight is a session failure, not a missing run: stop and re-mint rather
than reading it as "already gone".

**Step 2 — cancel, and parse the body.** `POST /runs/:id/cancel` answers **`200 {"cancelled":
boolean}`** (`server.ts:5192-5207`). It does **not** answer `409`; the superseded draft's
`# want 200 (409 = already terminal, ok)` comment described a route that does not exist. `cancelled:
false` means `manager.cancel` found neither a queued entry, an active state, nor a `waiting` run
(`workflows/run.ts:3632-3665`) — which is fine only if the run is already terminal, and that has to
be checked rather than assumed.

```bash
resp=$(curl -sS -w '\n%{http_code}' -X POST -H "cookie: cez_session=$CEZ_CLEANUP_SESSION" "$B/runs/$SIB/cancel")
status=${resp##*$'\n'}; body=${resp%$'\n'*}
[ "$status" = 200 ] || { echo "STOP: cancel answered $status, want 200"; exit 1; }
printf '%s' "$body" | python3 -c "
import json, sys, subprocess, os
b = json.load(sys.stdin)
if b.get('cancelled') is True:
    print('cancel accepted'); raise SystemExit(0)
# cancelled:false is only acceptable if the run is ALREADY terminal.
run = json.loads(subprocess.run(
    ['curl','-sS','-H','cookie: cez_session='+os.environ['CEZ_CLEANUP_SESSION'],
     os.environ['B']+'/runs/'+os.environ['SIB']], capture_output=True, text=True, check=True).stdout)
assert run.get('status') in {'done','failed','cancelled'}, \
    f\"STOP: cancelled:false but status is {run.get('status')!r} — nothing was cancelled\"
print('already terminal:', run['status'])
"
```

Terminal statuses are `done`, `failed`, `cancelled` out of the seven in `runStatusSchema`
(`packages/contract/src/runs.ts:30-38`); `queued`, `running`, `waiting` and `review` are not.

**Step 3 — delete, bounded-polling through the real `409`.** `DELETE /runs/:id` refuses with
`409 {"error":"run is active — cancel it first"}` while `manager.isActive(id)` is still true
(`server.ts:5881`), and cancellation drains asynchronously, so the delete issued immediately after
the cancel can legitimately `409`. Poll on the sanctioned until-loop, never a guessed sleep. **A
`404` anywhere in this loop is a failure**: step 1 preflighted the id at `200`, so `404` can only
mean wrong scope or a run someone else reaped, and the old script's "404 means already gone" is
exactly the reading that produced these artifacts.

```bash
deadline=$(( SECONDS + 60 ))
while :; do
  st=$(code -X DELETE "$B/runs/$SIB")
  case "$st" in
    200) echo "deleted $SIB"; break ;;
    409) [ "$SECONDS" -lt "$deadline" ] || { echo "STOP: still active at the 60s deadline"; exit 1; }
         sleep 2 ;;
    404) echo "STOP: 404 after a 200 preflight — wrong scope, or reaped by someone else"; exit 1 ;;
    *)   echo "STOP: unexpected $st from DELETE"; exit 1 ;;
  esac
done
```

**Step 4 — confirm the todo records are terminal, AFTER the cancel.** Ordering trap, and it runs
the opposite way to intuition: `POST /runs/:id/cancel` calls `clearStartedTaskId` on success
(`server.ts:5199-5206`, `.ai/specs/2026-08-22-run-cancel-restores-todo.md`), which **restores the
todo to the Filed board**. Both rows are already tombstoned (`2d0b837a-…` at `08:18:56.666Z`,
`520e2bbe-…` at `08:18:56.690Z`, each `startedTaskId: null`), so this is a **verification, not a
deletion** — re-issuing `DELETE /todos/:id` would answer `404` and prove nothing (`removeTodo`
returns `false` for an already-tombstoned row, `todos.ts:472-473`). Read the store:

```bash
python3 - <<'PY'
import json
d = json.load(open('/var/lib/cezar/loki-labs/cezar/.ai/cezar/todos.json'))
items = d if isinstance(d, list) else d['todos']
want = {'2d0b837a-b71b-4c7f-af43-929060e0ef66', '520e2bbe-4abe-4a3a-8bc9-c818968be2aa'}
seen = {t['id']: t for t in items if t['id'] in want}
assert want <= set(seen), f'missing rows: {want - set(seen)}'
for i, t in seen.items():
    assert t.get('tombstone'), f'{i} NOT tombstoned'
    assert not t.get('startedTaskId'), f'{i} was restored by the cancel: {t["startedTaskId"]}'
print('both todos terminal:', {i: t['tombstone']['at'] for i, t in seen.items()})
PY
```

That third assertion is the one that catches the ordering trap firing. In this particular case
`clearStartedTaskId` is a no-op — `startedTaskId` was never written, which *is* defect 1 — so a
surprise here would mean the diagnosis is wrong, which is worth catching.

**Done when:** § Verification 1, 2 and 3 pass for `ae7bd42f` — it is absent from
`GET /api/v1/p/cezar/runs`, answers `404` on the scoped mount, its worktree directory is gone, and
both todos are terminal. Then destroy the session (§ Verification 0a).

### P3 — Reap THIS run *(EXTERNAL actor: parent task `480e0282`, or the owner)* — **STILL PENDING as of step 8/9 (2026-08-25); this run is still `status: "running"`**

**This run cannot do this, and the reason is mechanical, not cautious.** `RunManager.cancel()` on an
active run sets `state.cancelled = true` and calls `state.interrupt()`
(`packages/cezar/src/workflows/run.ts:3661-3663`), which interrupts this very session. Any command
written after the cancel — including the delete, including the verification of the delete — is
unreachable. A run that cancels itself and then reports the delete succeeded is reporting something
it did not observe.

**Who resumes, and where.** The parent task `480e0282` (which created this fixture and owns the E2E
that spawned it) or the owner, from **any shell that is not one of these two runs**: an interactive
`cezar@prod-host` session, or a new cezar task. It needs nothing from this worktree — P1's
todos carry the diagnosis and this document is on `origin/cez/a3dd8f5f` after § Verification 0.

**What it runs:** P2 steps 1-3 verbatim, with `SIB` replaced by
`SELF=a3dd8f5f-5d66-402e-b876-c1a6746d9da7`, and its **own** freshly minted session (§ Verification
0a) — not this run's, which is destroyed at the end of P2. The ghost-id assertion in step 1 is not
repeated; it is a one-time check and P2 already made it.

**What it verifies before calling this done:**

1. `GET /api/v1/p/cezar/runs` contains **neither** `a3dd8f5f-…` nor `ae7bd42f-…`.
2. `GET /api/v1/p/cezar/runs/a3dd8f5f-…` answers `404` on the **scoped** mount.
3. `/var/lib/cezar/loki-labs/cezar/.ai/cezar/worktrees/a3dd8f5f-…` does not exist.
4. The store-owned files are gone and the sidecars are accounted for — § Verification 2, which
   states exactly which files `deleteRun` owns and which it does not.
5. `find /var/lib/cezar -not -user cezar | wc -l` is `0`.
6. Its own session is destroyed and the post-destroy preflight answers `401`.

**This also terminates the chain.** This is step 2 of 9 of a `spec-to-deploy` workflow with no work
left: steps 3-9 would implement, gate and deploy a document deliberately emptied of implementable
scope. Deleting the run ends it. **If the run has already ended on its own** by the time the external
actor arrives — status `done` or `failed` — steps 1-3 still apply; the cancel simply answers
`{"cancelled": false}` over a terminal status, which P2 step 2 already handles.

**Done when:** all six checks above pass, reported by the actor that ran them.

---

**Everything below is FOLLOW-UP DESIGN. Not this task's scope. Do not implement it here.**

### F1 *(follow-up, not this task)*: Surface the start refusal — and secure the claim first

**This is not a one-file change**, which is what the superseded P2 assumed. The route has no hub
self-confirmation dependency to wire: `hubSelfConfirm` is a closure inside
`createHubAutostartDispatch` (`hub-autostart-dispatch.ts:92`, used at `:210`), unexported, and it
needs `deps.allocateHubSeq` and `deps.identity`, neither of which `server.ts`'s route holds.

1. Start from `origin/main` (`git merge --ff-only origin/main`) — 55 files behind here.
2. **Build the role-aware confirmation seam.** One resolver, called by both HTTP start paths, that
   answers *this node's* confirmer:
   - `role: 'hub'` (this box) → the hub's self-confirm, allocating from the same `hubSeq` counter.
     Requires either exporting `hubSelfConfirm` or lifting it to a module both callers can reach;
     it must keep allocating from the one counter, or the record is unreplicable — the reason
     `hub-autostart-dispatch.ts:82-91` gives for not routing through `applyOpAtHub`.
   - `role: 'spoke'` → the link's confirmer, as `spoke-runtime.ts:1177` already resolves it.
   - unclustered, or a spoke whose link is down → **no confirmer**, and only then the D15a row 1
     optimistic path (`todos.ts:948-955`), stamped pending.
3. **Split `RunManager.startRun` (§ Solution A step 1).** `prepareRun` / `enqueueRun` /
   `discardPrepared` in `workflows/run.ts`, with `startRun` re-expressed as the first two so
   `startVariants` (`:1582-1591`), `cezar run`, the inbox "▶ Run" and the workspace-run paths are
   untouched. Land this alone first, with a test that `startRun`'s observable behaviour is
   unchanged; it is a pure refactor and reviewable as one.
4. `server.ts:6188-6199` → the two-phase body of § Solution A step 2: `prepareRun`, then
   `markStartedWithClaim(dataDir, id, run.id, { confirmStart: <resolved> })`, then `enqueueRun`,
   with all three rollback edges — including `clearStartedTaskId` when `enqueueRun` throws, which
   is the one that is easy to omit.
5. **Refusal answers `409 { error: 'start-refused', todoStart }`**, not a `201` carrying a refusal
   (§ Data models). Audit whether this route family declares its `409` bodies in
   `packages/contract/src` before adding a schema; the `Exact<>` parity assertion pins the `201`
   only (`contract-parity.workflows.test.ts:61`), which is why the `201` must stay byte-identical.
6. Apply the same treatment at `server.ts:4983` (the `POST /runs` best-effort `todoId` path), where
   the boolean is at least already checked — verify its warning path still reads correctly. Note it
   has no prepared-run seam to use, so decide explicitly whether it adopts one or stays best-effort.
7. Update the three web consumers per § Data models' table. The single-run paths must **stop
   navigating on a refusal**: `discardPrepared` deleted the run, so `result.run.id` no longer
   resolves.
8. **Tests — Vitest, in `packages/cezar/src/server/start-run-todo.test.ts`** (note: `src/**` is
   Vitest, run by `npm test`; `npm run test:unit` is `node --test test/unit/*.test.ts` and will
   **not** execute this file — see § Verification):
   - hub role + confirmer accepts → `201`, `startedTaskId` is the run id, body byte-identical to
     today, and the run is in `manager`'s queue;
   - hub role + confirmer **refuses** → `409`, `error: 'start-refused'`, `todoStart.started` is
     `false`, and — the assertion that actually addresses D41 — **`store.getRun(runId)` is
     `undefined`**: no run record survives at all, not merely no active run;
   - claim lost to a concurrent `already-started` → same no-surviving-record assertion;
   - `enqueueRun` made to throw → `startedTaskId` is cleared **and** the record is gone (rollback
     edge 3, which no other test reaches);
   - a prepared-then-discarded run leaves no `<id>.spool`, no `<id>.broker.log` and no worktree —
     the sidecars `store.deleteRun` does **not** own (`runs/store.ts:1364-1378`);
   - no confirmer resolvable (unclustered) → the D15a optimistic path, `pendingSince` stamped,
     `201`, body byte-identical to today.

**Done when:** those tests pass and are demonstrated **red against the pre-fix tree** (the refusal
tests fail there because the pre-fix route answers `201` and leaves the run running — quote that
failure); `npm run typecheck` stays green throughout, including the untouched `Exact<>` parity
assertion; and the README + CHANGELOG breaking note and minor bump are in the same commit
(§ Data models, `BACKWARD_COMPATIBILITY.md:5`).

### F2 *(follow-up, not this task)*: Address runs by project, and stop treating 404 as done

> **CORRECTED 2026-08-25 (review). The superseded P3 targeted `.e2e-bulk-start.cjs`, and that is
> not a shippable artifact.** It is a temporary file `480e0282` wrote into its own worktree at
> `08:18:29.955` and never tracked; "rewrite it" cannot land, cannot be reviewed, and cannot
> prevent recurrence. F2 has **two** durable targets, and needs both, because the correction is
> partly documentary and partly executable:

**Target 1 — the documentary correction, in a tracked file.**
`.ai/specs/2026-08-24-ship-bulk-start-filed-tasks.md` (1,330 lines, committed to `origin/main` in
`7932cf4d` — see § Measured facts claim 3). Its **P5 cleanup procedure is what the throwaway script
was generated from**, so correcting the script without correcting its source guarantees the next
generated harness repeats the defect. Per the workspace's correction rule, edit it **in place**: a
bolded `CORRECTED 2026-08-25` lead-in on the P5 block, original text kept beneath, naming the
project-scoped route and the `404` rule that replace it.

**Target 2 — the executable coverage, so it cannot recur silently.**

> **CORRECTED 2026-08-25 (second review). The superseded target 2 was a new Vitest file,
> `packages/cezar/src/server/run-routes-project-scope.test.ts`, asserting that `GET
> /api/v1/runs/:id` for another project's run is `404` while `GET /api/v1/p/B/runs/:id` is `200`.
> That test cannot do the job it was written for.** The dual mount is deliberate and unchanged
> (`server.ts:2086-2104`), so those assertions describe **existing intentional server behaviour**
> and pass on the pre-fix tree, unmodified. A regression test that is green before the fix proves
> nothing and cannot satisfy F1/F2's own red-before-fix requirement — it is the vacuous-assertion
> shape this whole document is about (`.ai/specs/2026-08-22-deploy-e2e-probe-vacuous-pass.md`,
> commit `587db317`). **The defect is in the caller, so the test has to exercise a caller.** The
> superseded bullet list is retained above.

The deliverable is a **tracked cleanup helper plus its tests** — the thing the throwaway `.cjs`
should have imported instead of open-coding.

`packages/cezar/src/server/e2e-cleanup.ts` (path to be confirmed against where the repo keeps
test-support code that ships), exporting one function:

```ts
export interface CleanupTarget { runId: string; projectId: string }
export interface CleanupDeps { baseUrl: string; cookie: string; fetch?: typeof globalThis.fetch;
                               deadlineMs?: number; intervalMs?: number }
export async function cleanupRuns(targets: CleanupTarget[], deps: CleanupDeps): Promise<void>
```

It implements P2 steps 1-3 exactly: scoped URLs built from the **captured** `projectId`, the cancel
body parsed, the delete bounded-polled through `409`, and a first `404` treated as a failure. `fetch`
is injectable, which is what makes the tests real without a live box.

`packages/cezar/src/server/e2e-cleanup.test.ts` (Vitest, `npm test`) against a stub `fetch` that
records every request:

- **captured project id reaches the URL** — `{ runId: 'r1', projectId: 'B' }` produces
  `POST <base>/api/v1/p/B/runs/r1/cancel` and `DELETE <base>/api/v1/p/B/runs/r1`, and **no request
  is ever made to `/api/v1/runs/…`**. Assert on the recorded URL list, not on the return value;
- **project id is encoded** — a `projectId` needing `encodeURIComponent` survives intact;
- **cancel body is parsed** — `200 {"cancelled": false}` over a non-terminal `GET /runs/:id` status
  is a **failure**; `200 {"cancelled": false}` over `done`/`failed`/`cancelled` is accepted;
- **bounded 409 polling** — a scripted `409, 409, 200` completes and issues exactly three `DELETE`s;
- **the deadline is reported, not swallowed** — `409` forever throws once the deadline passes, and
  the message names the run id;
- **first 404 is a failure** — `404` on the first cancel, and separately on the first delete, each
  throws. This is the caller regression, stated as an assertion.

**The red-before-fix demonstration, which target 2 exists to make possible.** Extract the old inline
cleanup logic (the `.e2e-bulk-start.cjs` `finally` block, quoted verbatim in § Problem 2) into a
fixture implementing the same `cleanupRuns` signature, and run the suite against it. It fails the
first, second and last groups above — unscoped URLs, and `404` coded as success — which is the
regression demonstrated red. Keep that fixture in the test file as the documented counter-example.

**Then**, and only with both targets in place, the harness rules themselves — to be applied wherever
a cleanup block is next generated, and satisfied for free by importing the helper:

- take `projectId` from the run-index entry and call
  `/api/v1/p/${encodeURIComponent(projectId)}/runs/${id}/cancel` and `…/runs/${id}`;
- treat `404` on the **first** cancel/delete of an id captured from a `201` as a **failure**, since
  the run demonstrably existed;
- select runs by **captured id**, never by title match — the `"<seq>: "` prefix and shell-quoted
  regexes are exactly how attempt two failed.

**Optionally, and only as documentation:** a test pinning the dual mount itself (unscoped `404`,
scoped `200`) is still worth having as a *characterisation* test of `server.ts:2086-2104` — but it
must be labelled as such, and it does not count toward F2's regression coverage.

**Done when:** `e2e-cleanup.test.ts` passes against the helper and is demonstrated **red against the
old-inline-logic fixture**, with the failure quoted; the ship spec's P5 block carries its in-place
correction naming the scoped route, the parsed cancel body and the `404` rule; and a dry run of
`cleanupRuns` against two deliberately-created disposable todos cancels and deletes both runs,
failing loudly if either id survives.

### F3 *(follow-up, not this task)*: Settle what a tombstone means at every todo boundary

> **CORRECTED 2026-08-25 (second review). The superseded F3 was one change — *"Filter
> `isTombstoned` in `WorkspaceTodoIndex.list()` … and settle `projects[].total` in the same
> change"*, gated on a consumer audit — and it was built on a false reading of the current code.**
> Its premise (from § Solution C, also corrected) was that board consumers already filter
> tombstones client-side, so the endpoint was the last place that didn't. **Nothing filters them.**
> `isVisibleFiledEntry` (`packages/web/src/lib/filed-tasks.ts:76-78`) and `visibleTodos`
> (`packages/web/src/routes/inbox.tsx:56-58`) each check `startedTaskId` and nothing else; the only
> non-test caller of `isTombstoned` in `packages/cezar/src` is `removeTodo` itself
> (`todos.ts:474`). So filtering one endpoint would have been a change to the *least* affected
> boundary, and it would have been breaking (`BACKWARD_COMPATIBILITY.md:5`) on top. The superseded
> text is retained above.

**F3 covers five boundaries and two routes.** Audit each, decide each, write the decision down:

| Boundary | Today | Required decision |
| --- | --- | --- |
| `GET /api/v1/p/:projectId/todos` (`server.ts:6105`) | raw `readTodos` — tombstones present | Default unchanged; add opt-in `?tombstoned=exclude` (§ Data models) |
| `GET /api/v1/workspace/todos` (`workspace/todo-index.ts:83`) | `readTodos` again — tombstones present, `projects[].total` counts them | Same opt-in, **and** `total` computed from the same filtered array under that view |
| `POST /todos/:id/start` → `todoMustExist` (`server.ts:6093-6098`) | finds the row in raw `readTodos`, checks presence only → **a deleted todo is startable** | **`404`.** This is the sharpest of the five and the only one that is a live defect rather than a shape question |
| `PATCH /todos/:id` → `updateTodo` (`todos.ts:678-687`) | patches a tombstoned row happily | Decide: `404` (consistent with start and delete) or deliberately permitted, with the reason recorded |
| `DELETE /todos/:id` → `removeTodo` (`todos.ts:472-474`) | already correct: `false` for a tombstoned row → `404` | No change. It is the one boundary that models the tombstone properly, and it is the reference |

**Invariants F3 must not break:** `readTodos` keeps returning tombstoned rows — D5a, the outbox
derivation reads through it and must be able to see the delete (`todos.ts:466-467`) — and the
default response of both list routes stays byte-identical. Keep an explicit test for each.

**And correct the record in place.** `todos.ts:467` reads *"Board consumers filter with
`isTombstoned`."* That is false and was the sentence that made this document's earlier claim look
verified. Per the workspace correction rule, edit it where it stands rather than only writing the
truth elsewhere.

Then the assertions § Data models names: the index-level fixture under **both** views, the
endpoint-level `total`-equals-row-count equality over the JSON body under both views, the `400` on
an unrecognised `?tombstoned=` value, and the contract update for the new query parameter.

**Done when:** those tests pass, each demonstrated red against the pre-fix tree (the `todoMustExist`
one is red today — a tombstoned todo starts); the five-boundary audit is written into F3's own spec;
`todos.ts:467`'s docblock is corrected in place; and — because the design is opt-in and additive —
**no** `BACKWARD_COMPATIBILITY.md` breaking note is needed. If F3 instead changes a default, that
note plus the README/CHANGELOG entries, the migration path and a minor bump called out as breaking
are all required, and their absence is a failed gate rather than an oversight.

*(The former P5, "Reap the current artifacts", became **P1** on the first revision and is now split
across **P2** (the sibling, which this run can reach) and **P3** (this run, which it cannot), with
the id-discrepancy check, aborting preflight assertions, a parsed cancel body and a bounded `409`
delete poll. Its `404`-is-fine note for the todo deletes was also wrong as a procedure: a `404`
proves nothing, so P2 step 4 reads the store instead.)*

## Risks

| Risk | Mitigation |
| --- | --- |
| **This document is lost with its worktree.** P3 deletes this run, and the spec is untracked here. This is the only risk this task can realise, and it is realised by doing the task. | **CORRECTED 2026-08-25 (second review):** ~~copy to the main checkout, reindex, grep the catalog for the slug~~ — that left an untracked file in a checkout this task does not own and preserved nothing durable. § Verification 0 instead commits this document and its brief on `cez/a3dd8f5f` and pushes that branch to `origin` with an explicit refspec, and **P1's filed todos are self-contained**, so the diagnosis survives even if the branch is never merged. Nothing is destroyed until that push is confirmed. |
| P2 cancels or deletes the wrong run — the review named an id (`ae7bd42f-442f-…`) that exists nowhere on disk. | P2 step 1 asserts the ghost id resolves `404` and the sibling resolves `200` **before** any mutation, under `set -euo pipefail` with explicit `[ … ] \|\| exit 1` guards, so a surprise stops rather than printing. |
| **This run cancels itself and the rest of the phase never executes.** `RunManager.cancel()` calls `state.interrupt()` on the active session (`workflows/run.ts:3661-3663`), so a self-cancel silently truncates everything after it — including the delete and the verification of the delete. | The phases are ordered P1 (file) → P2 (sibling) → P3 (**external actor**). This run never cancels itself. P3 names who resumes, from where, with its own session, and the six checks it owes. |
| The cancel restores a todo to the Filed board mid-cleanup (`clearStartedTaskId`, `server.ts:5199-5206`), leaving the fixture visible after "cleanup". | P2 checks todos **after** the cancel, and step 4 asserts `startedTaskId` is falsy specifically to catch this firing. |
| **The cleanup session outlives the cleanup**, or is pasted into a transcript as a literal. It is a bearer credential for the whole cockpit. | § Verification 0a: minted with a 15-minute TTL from an existing user, never printed or echoed, destroyed by its own minter, with a post-destroy `401` asserted. Two sessions, not one — P2's is destroyed at the end of P2, because a run that has just been interrupted cannot destroy anything. |
| The three defects are filed and then forgotten, so the diagnosis dies as a cleanup note. | P2's todos carry acceptance criteria and cite this document by section; their ids go into the handoff. If `cezar todo add` is unavailable, the sync is flagged pending, not skipped silently. |
| **F1 (follow-up) fixes the symptom and leaves D41.** Confirming a claim after `manager.startRun` means a refusal reaches a node already running the work, and nothing stops it — two nodes, one todo, with `mac-mw` enrolled and `acceptsDispatch: true`. | Not mitigated here; **constrained**. § Solution A requires claim-before-start or compensating cancellation, and requires the no-surviving-run assertion. F1 may land only if it takes the narrow HTTP-path option, which does not pre-empt D41's owner decision. |
| F1 ships the route change without the `startRun` split, or leaves a rollback edge open — most likely `clearStartedTaskId` when `enqueueRun` throws, which strands a todo in "started" behind a run that will never execute. | § Solution A step 2 writes all three edges out; F1's test list includes a made-to-throw `enqueueRun` case, which is the only test that reaches edge 3. § Data models keeps the `201` byte-identical, so the `Exact<>` parity assertion stays a live gate rather than a changed one. |
| **F2's regression test is green before the fix and proves nothing** — the failure mode this whole document is about. | The superseded `run-routes-project-scope.test.ts` did exactly that (it asserts deliberate, unchanged mount behaviour). F2 target 2 is now a tracked helper plus tests that must be demonstrated **red against a fixture wrapping the old inline cleanup logic**, quoted. |
| Settling tombstones breaks a consumer that needs them (D5a outbox derivation), or leaves `projects[].total` counting invisible rows. | The outbox reads `readTodos` directly, which F3 must not touch, with a test. § Data models makes the `total` equality a stated, asserted contract under both views. |
| This repo is public and released (`BACKWARD_COMPATIBILITY.md:5`), so a `201` becoming a `409` and rows leaving a list response are both **breaking** by its own definition. | F1's status change is genuinely breaking and takes the documented 0.x path: README + CHANGELOG note, migration (read `todoStart` on the `409`), minor bump called out as breaking. F3 avoids the question entirely by making the board view an **opt-in** `?tombstoned=exclude` with the default byte-identical — additive, and therefore permitted. |
| Fixing the E2E harness (F2) without fixing F1 makes the E2E fail *correctly* and loudly, which may read as a regression. | Land F1 before F2, or expect and document the red. Filing them as separate tasks makes that ordering explicit rather than implicit in a phase list. |

## Verification

**0. Make this document durable first — before any of P1, P2 or P3**, since P3 destroys this
worktree and this file is untracked here.

> **CORRECTED 2026-08-25 (second review). The superseded step was** ~~`cp` the spec into
> `/var/lib/cezar/loki-labs/cezar/.ai/specs/`, then `CEZ_KB=1 cez kb reindex`, then grep the
> catalog for the slug~~**, under a document that also declares "no commit, no push".** Those two
> cannot both hold. The `cp` lands a new **untracked** file in the main checkout — which is already
> dirty — owned by no branch and no commit, so the next `git status` there shows an orphan nobody
> can attribute, and the "durable record" is one `git clean` from gone. It is the same class of
> mistake as writing the corpus without reindexing: the artifact exists and the record does not.

**The durable path is the branch this task already has.** The work is in a cezar worktree on
`cez/a3dd8f5f`; committing there and pushing that branch touches no other checkout:

```bash
cd /var/lib/cezar/loki-labs/cezar/.ai/cezar/worktrees/a3dd8f5f-5d66-402e-b876-c1a6746d9da7
git add .ai/specs/2026-08-25-silent-start-cleanup-failures.md \
        .ai/specs/briefs/2026-08-25-e2e-disposable-480e0282-2.md
git commit -m "docs: record the silent start and cleanup failures behind the 480e0282 E2E fixture"
git push origin cez/a3dd8f5f          # EXPLICIT refspec. Never a bare `git push`, never `upstream`.
git ls-remote --exit-code origin refs/heads/cez/a3dd8f5f    # want exit 0 — the push is confirmed
```

`origin` is `MarcinWalendowski/cezar`; `upstream` (`open-mercato/cezar`) is never a target here, per
the workspace rule. **No merge to `main`, no deploy, and the main checkout is not touched at all.**

**Known limitation, stated rather than papered over.** The KB's `specs` root is the *main*
checkout's `.ai/specs`, so this document is **not** in `cez kb search` until the branch merges. That
is why P1's todos are self-contained: the diagnosis has to survive without this file being findable,
and it does. Do **not** work around it with a `cp` — see the correction above. Re-running
`CEZ_KB=1 cez kb reindex` here would index nothing new and would be a false green.

**Do not begin P1 until `git ls-remote` above exits 0.**

**0a. Mint, use and destroy a dedicated session — the procedure, applied once per actor.** P2 and P3
each need an authenticated cookie, and `S=<session id>` in the superseded draft was a placeholder,
not a procedure. This is the one already documented for this box, in
`.ai/specs/2026-08-24-ship-bulk-start-filed-tasks.md` P5 step 0 (`origin/main`, lines 839-866):

```js
// node --import tsx, from the repo root. identityDir() defaults to <CEZ_HOME|~>/.cezar/identity.
// USER_ID comes from the EXISTING identity store — createSession throws `user-not-found` for an id
// with no User row (auth/session.ts:250-258), so it cannot be invented.
const { createSession, destroySession } = await import('./packages/cezar/src/auth/session.ts')
const { id } = await createSession(USER_ID, 15 * 60 * 1000)   // 15 min, not the 30-day default
```

- `USER_ID` is read from `/var/lib/cezar/.cezar/identity/identity.json` → `users[]`; pick the
  account that owns the `cezar` project.
- **Never log, echo, screenshot or paste the value.** Keep it in the process; if it must cross a
  process boundary, a `0600` file under this run's `tmp/`, `rm`'d in the same `finally` that
  destroys the session. The commands in P2 read it from `$CEZ_CLEANUP_SESSION`, never as a literal.
- **Preflight before anything else:** `GET /api/v1/p/cezar/runs/$SIB` with that cookie must answer
  **200**. A `401` stops the phase — proceeding would make every "the id is absent" assertion pass
  by being blind, which is the failure `.ai/specs/2026-08-24-ship-bulk-start-filed-tasks.md`'s own
  P5 correction (cleanup step d) was written to prevent.
- **Destroy it last, after the ground-truth queries**, which need the very credential it revokes:
  `destroySession(id)` (`auth/session.ts:360`) must return `true`; then re-issue the preflight
  **without** the cookie and assert **401**.

**Two sessions, not one, and that is deliberate.** P2's is minted and destroyed by this run, at the
end of P2. P3's external actor mints and destroys its own, after its six checks. A single shared
session cannot work: this run is interrupted the instant P3's cancel lands
(`workflows/run.ts:3661-3663`), so it could never reach a `destroySession` placed after it, and the
credential would outlive the task with nobody tracking it.

### For P2 (this run) and P3 (the external actor)

Each of 1-3 below is run by whichever actor just deleted a run, against **that** run's id: P2 runs
them for `ae7bd42f-…`, P3 for `a3dd8f5f-…`. `$R` is that id; `$CEZ_CLEANUP_SESSION` is that actor's
own session (§ Verification 0a).

**1. The cleanup is verified by re-query, never by the exit code of the thing being verified.**
That is the failure this whole document is about: the original harness asked its own `finally`
block whether it had succeeded.

```bash
B=http://127.0.0.1:4321/api/v1/p/cezar
# the deleted run may not appear in the cezar project's own run list.
# NOTE the body shape: `GET /runs` answers a BARE ARRAY (server.ts:4993,
# `c.json(store.listRuns().map(withUsage))`), not `{ runs: [...] }` — the workspace
# runs-index endpoint is the one with the wrapper. Indexing ['runs'] here would raise
# TypeError and read as a failed cleanup.
curl -sS -H "cookie: cez_session=$CEZ_CLEANUP_SESSION" "$B/runs" \
| R="$R" python3 -c "
import sys, json, os
body = json.load(sys.stdin)
assert isinstance(body, list), f'expected a bare array, got {type(body).__name__}'
assert os.environ['R'] not in {r['id'] for r in body}, f\"FAIL: {os.environ['R']} still listed\"
print('gone from the run list:', os.environ['R'])
"
# and the id must now 404 on the SCOPED mount (the unscoped one always did)
st=$(curl -sS -o /dev/null -w '%{http_code}' -H "cookie: cez_session=$CEZ_CLEANUP_SESSION" "$B/runs/$R")
[ "$st" = 404 ] || { echo "FAIL: scoped GET answered $st, want 404"; exit 1; }
```

The scoped `404` is the assertion that matters. A `404` from the **unscoped** mount would prove
nothing at all — it answers `404` for every `cezar` run whether or not it exists, which is exactly
how the original cleanup reported success while cancelling nothing.

**2. Filesystem ground truth — but only for the files the delete contract actually owns.**

> **CORRECTED 2026-08-25 (second review). The superseded assertion was**
> ~~`ls .ai/cezar/runs/ | grep -c -e a3dd8f5f -e ae7bd42f   # want 0`~~**, and it is false: it
> fails on a delete that worked perfectly.** `RunStore.deleteRun` (`packages/cezar/src/runs/store.ts:1364-1378`)
> removes exactly three things — `<id>.ndjson`, `<id>.handoff.md` and the images directory — and no
> `store.on('deleted', …)` listener removes anything else (the two in `server.ts:6329,6378` and the
> one in `cluster/run-projection.ts:91` are SSE and projection listeners). Measured on disk for both
> runs right now: `<id>.ndjson`, `<id>.handoff.md`, **`<id>.spool`** and **`<id>.broker.log`**. The
> last two are not the delete's to remove, so a `want 0` filename grep asserts something the code
> never promised.

```bash
D=/var/lib/cezar/loki-labs/cezar/.ai/cezar
# (a) the authoritative index — RunStore's own words: "the index is authoritative"
python3 - "$R" <<'PY'
import json, sys
d = json.load(open('/var/lib/cezar/loki-labs/cezar/.ai/cezar/runs.json'))
runs = d if isinstance(d, list) else d.get('runs', [])
assert sys.argv[1] not in {r['id'] for r in runs}, f'FAIL: {sys.argv[1]} still in runs.json'
print('absent from the run index:', sys.argv[1])
PY
# (b) the worktree — removeWorktree runs BEFORE deleteRun on the DELETE path (server.ts:5885-5887)
[ ! -e "$D/worktrees/$R" ] || { echo "FAIL: worktree survives"; exit 1; }
# (c) exactly the files deleteRun owns
for f in "$D/runs/$R.ndjson" "$D/runs/$R.handoff.md" "$D/images/$R"; do
  [ ! -e "$f" ] || { echo "FAIL: $f survives a successful delete"; exit 1; }
done
# (d) the sidecars deleteRun does NOT own — recorded, not asserted gone
ls -d "$D/runs/$R.spool" "$D/runs/$R.broker.log" 2>/dev/null || true
```

**On (d), plainly: this cleanup leaves sidecars behind and that is not a failure of the cleanup.**
`<id>.spool` is swept later and best-effort by `RunManager.sweepSpools`
(`workflows/run.ts:2696-2725`), which removes a spool only when its run is not live and the spool is
not live — so it goes on some subsequent sweep, not on delete. `<id>.broker.log`
(`core/claude-cli-runner.ts:1239`) has **no** reaper anywhere: nothing in the repository removes it,
ever. Removing either from `deleteRun` is a real change to the delete contract with its own
lifecycle question (a spool may be mid-reattach), so it is **not attempted here**. It is also not
worth its own task on its own: fold it into whichever follow-up next touches `deleteRun` — F1 is the
likely one, since its `discardPrepared` path already asserts that a prepared-and-discarded run
creates neither sidecar.

**3. Todo records terminal** — P2 step 4's script, exit 0, with its third assertion
(`startedTaskId` falsy) present, since that is what catches the `clearStartedTaskId` restore. Run
once, by P2; P3 does not repeat it.

**4. The follow-ups exist** — `cezar todo list --project cezar` shows the three P1 rows, their
`--context` is self-contained (readable without this document), and their ids are written into this
run's handoff file where P3's external actor will find them.

**5. Ownership check**, per workspace doctrine, at the end of any session that touched the box:

```bash
find /var/lib/cezar -not -user cezar | wc -l      # must be 0
```

**6. The session is gone** — `destroySession(id)` returned `true` and the post-destroy preflight
answers `401` (§ Verification 0a). Each actor checks its own.

**No test gates run for this task, and that is correct, not a skipped step.** P1, P2 and P3 change
no source file: they file todos, cancel runs over HTTP, read `todos.json`, and commit two markdown
documents. There is nothing to typecheck, and running the suite would be theatre. The one write is
§ Verification 0's commit and branch push. **No merge to `main`, no deploy.**

### For the follow-up tasks (F1, F2, F3) — stated here so their specs inherit it

**7. Gates — the repository's actual five.**

> **CORRECTED 2026-08-25 (review): the superseded list named `npm run lint`, which does not
> exist.** `package.json` has no `lint` script; the chain would abort at
> `npm error Missing script: "lint"` and, run under `&&`, would never reach `build` or
> `test:package`. The real set is the one `.ai/agentic.config.json` `validation.commands` names,
> and it is what the deploy postconditions check:

```bash
npm run typecheck && npm test && npm run test:unit && npm run build && npm run test:package
```

**`npm test` is not optional here, and `npm run test:unit` is not a substitute for it.** They run
disjoint suites:

| Script | Expands to | Runs |
| --- | --- | --- |
| `npm test` | `vitest run` (root `vitest.config.ts`, four projects) | **`packages/*/src/**/*.test.ts`** — including `start-run-todo.test.ts`, `contract-parity.workflows.test.ts`, `todo-index.test.ts` and the proposed `e2e-cleanup.test.ts` |
| `npm run test:unit` | `node --import tsx --test test/unit/*.test.ts` (in `packages/cezar`) | only `packages/cezar/test/unit/` — **none** of the files F1/F2/F3 add or touch |

So the superseded F1 "Done when: the three tests pass and `npm run test:unit` is green" was
unsatisfiable as written: `test:unit` would have been green whether or not the new tests existed.
`npm run typecheck` also runs four sub-checks (`typecheck:contract`, `:client`, `:server`, `:web`)
and is where the `Exact<>` contract-parity assertion actually fires.

**8. Targeted commands, for the red-then-green demonstration.** Each follow-up must show its
regression test **failing against the pre-fix tree**, quoting the failure, before showing it green.
A test written after the fix that has never been red is not evidence:

```bash
npx vitest run packages/cezar/src/workflows/run.test.ts                      # F1 step 3, the split
npx vitest run packages/cezar/src/server/start-run-todo.test.ts              # F1 steps 4-8
npx vitest run packages/cezar/src/server/contract-parity.workflows.test.ts   # F1 (type-level;
npm run typecheck:server                                                     #     this is the real gate)
npx vitest run packages/cezar/src/server/e2e-cleanup.test.ts                 # F2 (see the note below)
npx vitest run packages/cezar/src/workspace/todo-index.test.ts               # F3
npx vitest run packages/cezar/src/server/todos-start.test.ts                 # F3, todoMustExist + tombstone
npx vitest run packages/web/src/routes/global-tasks.test.tsx                 # F1 consumer behaviour
```

> **CORRECTED 2026-08-25 (second review):** the F2 line named
> ~~`packages/cezar/src/server/run-routes-project-scope.test.ts`~~, and the paragraph that followed
> read *"For F1 specifically, the asymmetry must be demonstrated both ways: `npm run typecheck` red
> with the `server.ts` change alone, green with the contract change alongside it."* Both are dead.
> The F2 file was replaced (§ Phases, F2 target 2) because it was green on the pre-fix tree; and
> F1's `201` body no longer changes, so there is no typecheck asymmetry to demonstrate — the
> `Exact<>` parity assertion must stay **green throughout**, and going red is the failure signal,
> not the demonstration.

**What "red first" means for each follow-up, concretely, since none of them can use a typecheck
asymmetry:**

- **F1** — the refusal tests are red on the pre-fix tree because the route answers `201` with a live
  run instead of `409` with no run. Quote that failure.
- **F2** — the helper tests are red against the fixture that wraps the old inline cleanup logic
  (§ Phases, F2 target 2). Quote that failure. A test run against the *server* would be green either
  way, which is the whole reason the target changed.
- **F3** — the `todoMustExist` test is red today: a tombstoned todo starts. That one is red against
  the unmodified tree with no fixture needed, and it is the strongest evidence in the set.

**9. Defect 2, provable by hand today**, and the shape F2's helper tests pin:

```bash
curl -sS -o /dev/null -w 'unscoped=%{http_code}\n' -H "cookie: cez_session=$CEZ_CLEANUP_SESSION" \
     "http://127.0.0.1:4321/api/v1/runs/$KNOWN_CEZAR_RUN_ID"
curl -sS -o /dev/null -w 'scoped=%{http_code}\n'   -H "cookie: cez_session=$CEZ_CLEANUP_SESSION" \
     "http://127.0.0.1:4321/api/v1/p/cezar/runs/$KNOWN_CEZAR_RUN_ID"
```

Expected today: `unscoped=404`, `scoped=200`. This is a **characterisation** of the deliberate dual
mount (`server.ts:2086-2104`), not a regression check — it reads the same before and after F2.

**10. Defect 3**, in the four parts F3 must satisfy:

- `POST /api/v1/p/cezar/todos/:id/start` for a tombstoned id answers **`404`** (fails today —
  `todoMustExist` starts it);
- after `DELETE /api/v1/p/cezar/todos/:id` returns `200`, the id is absent from
  `GET /api/v1/workspace/todos?tombstoned=exclude` **and still present** from the same endpoint with
  the parameter absent (the byte-identical default);
- `projects[].total` equals that project's row count in `todos[]` under **both** views;
- the row is still present in raw `todos.json` carrying a `tombstone`, and still returned by
  `readTodos()` — must keep passing, that is D6/D5a.

**11. Real browser E2E before F1 is called Done.** Gates green is necessary and not sufficient: the
user-visible claim is "click Run N tasks and the rows leave the board", and only a driven Chromium
session against `http://127.0.0.1:4321/tasks` proves it. Use F2's `cleanupRuns` helper and the
minted-session procedure of § Verification 0a, not the cleanup in the ship spec's P5 as it stands.
Until that has actually run, F1 is **QA Needed**, not Done.
