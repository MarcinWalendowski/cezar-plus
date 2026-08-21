# Reopen every finished task and make it prove its work reached `main`

> **Status: PARTIAL — Phases 1-3 IMPLEMENTED, SHIPPED and PUSHED 2026-08-20** as commit
> `0cbb65a4` on `origin/main`, a clean fast-forward `f9bcda42..0cbb65a4`, no PR (this repo ships
> direct linear commits to `main`, AGENTS.md § "Shipping cezar itself"). Alongside it, `2e421370`
> — a pre-existing cross-cutting repair this run's gate step uncovered and reproduced at clean
> `HEAD`: post-conditions were evaluated under `CEZ_DRY_RUN=1`, where the agent is a mock that
> never commits, so every dry run died at `commit-push`. `npm run typecheck` exit 0; 64 new tests
> across five files green.
>
> **CORRECTED 2026-08-20 19:51 UTC by run `7aecd6a2`: ~~NOTHING HAS BEEN REOPENED~~ — one run
> has.** Chat run `b1684fe9` was reopened at 19:27:26 UTC as the Wave A canary of
> `.ai/specs/2026-08-20-reopen-sweep-execution.md`, and was still answering when that run's
> `document` step ran. The other **18 have not been touched, and no `MERGE-VERDICT` line exists
> anywhere on this box yet**, so the sentence's conclusion still holds even though its premise no
> longer does. Read the execution spec, not this paragraph, for where the sweep actually stands.
>
> **Phases 4-5 — the production sweep and the record it produces — are NOT done. ~~NOTHING HAS BEEN
> REOPENED~~, and the owner's ask is therefore NOT yet answered.** This is *QA needed*, not done.
> ~~Two things stand between here and there~~ — **one thing now. (1) deploy the backend is DONE,
> 2026-08-20 19:04 UTC:** `/opt/cezar/.deployed-commit` = `f53f5a58`, the service restarted onto
> the new tree (MainPID 3548803 → 3683619) and the reopen watcher is live in the resident process.
> See § Deployment. What remains is **(2) run the sweep** — `cezar runs reopen --all-done --dry-run` (expect 19: workspace 15 /
> chat 3 / cezar 1), a `--limit 1` canary, then the remaining 18, always with
> `--exclude a29f2b11-f83a-4c37-92bb-ff538551146a` so the sweep cannot reopen itself. Both are
> filed as cezar todos so they survive this run ending. See *Status log — 2026-08-20* at the foot.
>
> Written in the `spec` step of the same run. The capability now exists end to end —
> `packages/cezar/src/reopen-requests.ts` (store + `selectDoneUnarchived`),
> `reopen-watch.ts` (cockpit watcher, wired in `server/server.ts` beside `watchTodoAutostart`),
> `runs/reopen-cli.ts` (`cezar runs reopen`, routed in `index.ts`) — and is unused until
> someone runs the sweep. **It requires a backend deploy to take effect on the production box:
> the watcher only exists in a process started from this code.**
> · **Date:** 2026-08-20
> **Owner ask, verbatim:** *"reopen all 'done' tasks from active tab in cezar production (here)
> with such a promot: \"analyze if changes/fixes/updates from this task were merged into main\"
> if not, do it now"*
> **Reads on:** `2026-08-19-file-tasks-from-a-running-task.md` (the CLI-writes-intent /
> cockpit-executes pattern this spec reuses wholesale), `2026-08-20-chain-integrity-restart-and-continuation.md`
> (why a settle can leave a chain unfinished), `2026-08-20-workspace-run-worktree-isolation.md`
> (apply-back, and why a workspace run has no branch left to inspect),
> `2026-07-18-worktree-retention.md` (reclaimed worktrees, re-materialized on resume).

## TLDR

The owner wants every finished task on the production cockpit reopened and asked one question:
**did your work actually land on `main`, and if not, land it now.**

That question is not rhetorical. A four-run sample audited for this spec found **two runs whose
commits exist on no `main` anywhere** — a 561-line spec expansion in `cezar` and an 8-file,
+1000/−54 implementation in `chat` — plus a third whose work is on `origin/main` while the local
checkout is three commits behind. The cockpit ends a run at a review gate and never auto-merges
(`AGENTS.md`, intro), so "done" has never meant "merged", and nothing on the board says which.

The engine already has the exact primitive: `RunManager.continueRun` (`packages/cezar/src/workflows/run.ts:2532`)
reopens a `done` run against its original agent session, re-materializing both a reclaimed
project worktree (`run.ts:2668`) and a removed workspace worktree set (`run.ts:2685-2692`). The
gap is **reach**: the only door to it is `POST /api/v1/p/:projectId/runs/:id/continue`
(`server.ts:4875`), production runs `CEZ_AUTH=oidc` behind Cloudflare Access, and an agent on the
box has no browser and no session — so the one actor who could do this 19 times cannot call it
once.

This spec closes that gap the way this repo already closed the identical one for
`cezar todo add --start`: **the CLI writes an intent to a file, the running cockpit watches the
file and executes through its own manager.** Then it runs the sweep over the 19 tasks that are
actually on the Active tab today, one first, then the rest.

## Problem

### 1 — "Active tab" is not a lifecycle filter, so `done` runs accumulate there forever

Measured, not assumed. The Active/Archived split consults `archived` and **never** `status`:

```ts
// packages/web/src/lib/task-groups.ts:221-223
export function sortRuns<T extends SortRunInput>(runs: readonly T[], view: ListView): T[] {
  return runs
    .filter((run) => (view === 'archived' ? run.archived : !run.archived))
```

Server-side twin at `packages/cezar/src/workspace/run-index.ts:328`, cross-project twin at
`packages/web/src/lib/global-tasks.ts:284`. A `done` run lands in the `Recent` bucket
(`task-groups.ts:101`) and stays on Active until a human archives it — there is no age window and
no auto-archive (the only non-user `setArchived(…, true)` is the variant-loser sweep,
`server.ts:5382`). So "all done tasks from the active tab" is a well-defined, closed set:
**`status === 'done' && archived !== true`.**

### 2 — On this box that set is 19 runs, and it is not small

Enumerated from every registered project's `runs.json` plus the boot project
(`/var/lib/cezar/workspace`, which the registry at `~/.cezar/config.json` does **not** list — it is
`WorkingDirectory` in `/etc/systemd/system/cezar.service`, and it holds every workspace run per
`2026-08-15-cross-project-workspace-run.md`'s "a run has to live in some project's `runs.json`"):

| project | index entries | `done` & not archived |
|---|---|---|
| `workspace` (boot, `/var/lib/cezar/workspace`) | 16 (15 done, 1 running — this run) | **15** |
| `chat` | 3 | **3** |
| `cezar` | 1 | **1** |
| `loki-labs` | 1 | 0 (the one run is archived) |
| the other 9 registered projects | no `runs.json` at all | 0 |
| **total** | **21** | **19** |

Every one of the 19 has at least one step carrying a `sessionId`, so every one satisfies
`continueRun`'s hard precondition (`run.ts:2554-2555`, "no agent session to resume"). Checked
individually; the thinnest is `ae1cb6ce` (2 steps, 1 with a session). All 19 are `runner: claude`.

### 3 — "done" demonstrably does not mean "merged"

Audited against each project's `main` and `origin/main` (read-only; no fetch, so `origin/*` is as
of the last fetch someone else performed):

| run | project | branch | `rev-list --count main..branch` | on any `main`? |
|---|---|---|---|---|
| `7c2dd8f0` | cezar | `cez/7c2dd8f0` | 1 | **no** — main carries the 136-line `2026-08-19-non-disruptive-cezar-self-deploy.md`, the branch's blob is 592 lines |
| `b1684fe9` | chat | `cez/b1684fe9` | 1 | **no** — `git cherry origin/main` reports `+ 2675cd16` (SPEC-529, 8 files, +1000/−54); the spec file is absent from both `main` and `origin/main` trees |
| `28993af3` | chat | `cez/28993af3` | 3 | **yes on `origin/main`** (branch tip `e54cc50a` *is* the `origin/main` tip); local `main` is 3 behind |
| `2f1ae4aa` | chat | `cez/2f1ae4aa` | 0 | yes, fully landed |

That is 2 of 4 genuinely unmerged in the only projects where a branch still exists to check. The
15 workspace runs cannot be checked this way at all — a successful workspace settle applies each
diff back into the real checkout and then **deletes the worktree and the `cez/<id8>` branch**
(`packages/cezar/src/workspace/workspace-worktrees.ts:210-219`), so their only evidence is whether
their own `commit-push` step actually committed and pushed. That is precisely the failure mode
`2026-08-20-steps-green-only-when-verified.md` was written about: run `23221162` reported
`commit-push` green with 7 modified and 5 untracked files and no commit. `57fc8807` made that
post-condition machine-checked, but **only for runs started after it shipped** — every run in the
table above predates it.

**CORRECTED 2026-08-20 by run `7aecd6a2`: `cez/6af4b894` is NOT an orphan, and it IS in the
sweep.** It has a run record — `6af4b894-9d55-4685-8b04-3f72e56a1c99`, a **workspace** run, `done`
and unarchived, finished 2026-08-20T15:50:39Z, titled *"each step of workflow should show time of
processing…"* — in **`/var/lib/cezar/workspace/.ai/cezar/runs.json`**. The audit below looked for it
in the *cezar project's* `runs.json` and read its absence there as absence everywhere; every
workspace run's row lives in the boot project's index instead
(`2026-08-15-cross-project-workspace-run.md`). So it is one of the 19, reachable by the sweep like
any other row, and the paragraph below plus the § Out of scope bullet and the § What I could not
establish bullet that repeat this claim are all wrong about it. `rescue/staged-index-20260820` is
unaffected — it really has no run row.

Original text, unchanged:

Two orphans surfaced by the same audit, with no run record in any `runs.json` and therefore no row
on any tab (out of scope here, recorded so they are not lost): `cezar` branch
`rescue/staged-index-20260820` @ `343f79ea`, 1 commit ahead of main; and `cezar` `cez/6af4b894`
plus its worktree, whose work *did* land (0 ahead / 6 behind).

### 4 — The one actor who can do this 19 times cannot call the route

`POST /runs/:id/continue` (`server.ts:4875`) is the only door into a `done` run — `recover()`
filters to `queued|waiting|running` (`run.ts:1385`) and `POST /runs/:id/messages` answers
409 `session closed` for anything finished (`server.ts:4800`). Production runs with:

```
CEZ_AUTH=oidc
CEZ_OIDC_ISSUER=https://example.cloudflareaccess.com/…
CEZ_PUBLIC_URL=https://cockpit.example.com
```

(read from `/proc/<MainPID>/environ`; `/etc/cezar/cezar.env` is not readable by this user).
Verified live: `GET http://127.0.0.1:4321/api/v1/health` → **200**, `GET /api/v1/projects` →
**401 `{"error":"unauthenticated"}`**. A headless agent cannot complete an OIDC browser flow, so
today the sweep is 19 manual Continue clicks in a browser — which is exactly the work being
delegated.

This repo has met this problem before and answered it. `2026-08-19-file-tasks-from-a-running-task.md`
§ Phase 2 rejects "the CLI running the agent itself (a second, headless manager)" — two managers
fight the working-tree lease and the cockpit cannot stream a run it did not start — and instead
has the CLI write a flag into `todos.json` that the running cockpit watches
(`packages/cezar/src/todo-autostart.ts`). That is the shape reused here.

## Solution

**A reopen request is a file. The running cockpit is what reopens.**

Three parts, of which only the first two are code:

1. **`reopen-requests.json`** — one per project `dataDir`, beside `todos.json`. A request names a
   run and a prompt. It is *inert data*: nothing in it can start a process by itself.
2. **A watcher in the cockpit** (`reopen-watch.ts`) that reconciles that file through *this
   project's own* `RunManager.continueRun`, exactly as `todo-autostart.ts` reconciles `autostart`
   todos through `startRun`. Same boot pass, same `fs.watch`, same per-`dataDir` serialization,
   same "one bad entry never stops the file".
3. **`cezar runs reopen`** — the CLI that writes requests, with a selector for "every done,
   unarchived run".

Then the operation: run the sweep with the owner's prompt.

### Why `continue`, not a new task

Continuing resumes the run's own agent session (`run.ts:2554`, the last step carrying a
`sessionId`), so the agent already knows what *this task* changed — which is what the owner's
prompt ("changes/fixes/updates **from this task**") presupposes. A freshly started task would have
to reconstruct that from the transcript. Continuing also re-materializes the tree the work needs:
a reclaimed project worktree (`rematerializeReclaimedWorktree`, `run.ts:2668`) and, for a
workspace run whose worktrees were applied and deleted, a fresh set
(`materializeWorkspaceWorktrees`, `run.ts:2685-2692`). Both paths already exist and are already
exercised by the Continue button.

### Why the sweep must defer for capacity

`continueRun`'s third parameter (`deferForCapacity`, `run.ts:2537`) routes the continuation through
the queue instead of starting it immediately: the run goes to `status: 'queued'` with `finishedAt`
and `error` cleared (`run.ts:2616-2621`). `resources.maxParallel` is **3** on this host
(`~/.cezar/config.json`). Nineteen immediate continuations would spawn nineteen agent processes at
once. The sweep therefore always passes `deferForCapacity = true` — the same call shape restart
recovery already uses (`run.ts:1452-1457`). This is not a knob; it is the only correct value for a
bulk reopen, so it is not exposed.

### Rejected alternative: mint a session and just `curl` the route

`IdentityStore.readSnapshot()` reads `identity.json` from disk on **every** call
(`packages/cezar/src/auth/identity-store.ts:1361-1366`) — no in-memory cache — so a session row
written into `~/.cezar/identity/identity.json` by a side process would be honoured by the running
server on the next request, and the whole task would be a shell script with zero new code.

Rejected. It forges an authentication credential out of band on a host whose perimeter is
Cloudflare Access, leaves nothing behind for the next time this is needed, and would be invisible
to any audit of how 19 production runs got restarted. The file-intent path is slower to build and
is the one that can be read back afterwards. Recorded here so it is not re-proposed as a
shortcut.

### Rejected alternative: a bulk HTTP route and a UI button

`POST /runs/archive-finished` (`server.ts:4523`) is the obvious sibling for a
`POST /runs/reopen-finished`, and a "Reopen finished" broom next to the existing "Archive
finished" one (`tasks-overview.tsx:230`) would be the natural surface. Both are deferred: neither
is reachable by the actor this task needs to serve, so shipping them first would leave the ask
undone. See § Out of scope.

## Architecture

```
  cezar runs reopen --all-done --prompt "…"          (any shell on the box; no auth needed)
        │
        │  1. read every registered project's runs.json + the boot project's
        │  2. select status === 'done' && !archived   (the Active-tab predicate)
        │  3. append one request per run
        ▼
  <project>/.ai/cezar/reopen-requests.json           ← inert data
        │
        │  fs.watch (onReopenRequestsChanged) + one boot reconcile pass
        ▼
  reopen-watch.ts  ── reconcileReopenRequests(project) ──┐
        │                                                │ per-dataDir serialized tail
        │  manager.continueRun(runId, {text}, true)       │ (same idiom as reconcileTail,
        ▼                                                │  todo-autostart.ts:49)
  RunManager  → status 'queued' → pump() → runContinuation
        │                                     ├─ rematerializeReclaimedWorktree  (run.ts:2668)
        │                                     └─ materializeWorkspaceWorktrees   (run.ts:2685)
        ▼
  the run leaves `done`, streams live in the cockpit, settles again
        │
        └─ stamp startedAt (or error) back into reopen-requests.json  ← idempotence
```

Nothing new is introduced into `runs.json`. It is owned by `RunStore` with debounced atomic saves
(`store.ts:1217`, `store.ts:1228-1237`), so an external writer would be clobbered — which is the
reason the intent lives in its own file, exactly as `todos.json` does.

The watcher is wired where `watchTodoAutostart` is wired (`server.ts:1546` for the boot context,
and the same per-context hook at `server.ts:1536-1546` for every already-built and later-built
project context), so a project whose context is disposed and rebuilt gets exactly one live watch
pointed at the current manager.

## Data models

`<dataDir>/reopen-requests.json` — a JSON array, atomic tmp+rename write, missing file reads as
`[]` and is never created by a read (AGENTS.md § Zero config: *new state may be written, never
required*).

```ts
export const reopenRequestSchema = z.object({
  /** uuid — the request, not the run. One run may be reopened more than once over time. */
  id: z.string(),
  /** The run to continue. Must live in THIS dataDir's runs.json. */
  runId: z.string(),
  /** Opening prompt for the resumed session. Empty/whitespace → the engine's own
   *  default 'Continue.' (run.ts:2605). Bounded like the HTTP route's `text`. */
  prompt: z.string().max(100_000).optional(),
  createdAt: z.string(),
  /** Free text for the audit trail: 'cli', or the run id that filed it. */
  source: z.string().max(200).optional(),
  /** Stamped when the cockpit accepted the continuation. Presence = do not retry.
   *  The direct analogue of a todo's `startedTaskId` (todos.ts:79). */
  startedAt: z.string().optional(),
  /** Stamped once when `continueRun` refused (e.g. 'no agent session to resume',
   *  'run is still active'). Presence = do not retry; the row stays as the record of why. */
  error: z.string().max(2_000).optional(),
});
```

**Reconcile predicate:** `!startedAt && !error`. Both terminal, so a request is acted on at most
once no matter how many watch events or boot passes see it — the same double-start guard shape as
`todo.autostart && !todo.startedTaskId` (`todo-autostart.ts:71`).

No contract/HTTP schema is added in this spec: nothing here is served over `/api/v1`, so
`packages/contract` is untouched and no `contract-parity` test applies.

### CLI contract

```
cezar runs reopen --all-done [--project <id>|all] [--prompt "<text>"]
                             [--dry-run] [--limit <n>] [--exclude <runId>]…
cezar runs reopen <runId>…   [--project <id>] [--prompt "<text>"]
```

- `--all-done` selects `status === 'done' && archived !== true` — the Active-tab predicate,
  stated once and shared with the reconciler.
- `--project` defaults to **every** registered project *plus the boot project*; `all` is the
  explicit spelling of that default. The boot project is included because 15 of the 19 runs live
  there and it is absent from `~/.cezar/config.json`.
- `--dry-run` prints the selection (project, run id, status, finishedAt, title) and writes nothing.
  **Default-adjacent by intent: the sweep is meant to be previewed before it is fired.**
- `--limit` caps how many requests are written, oldest-finished first — the mechanism behind the
  one-run canary in § Verification.
- `--exclude` skips a run id (used to keep a sweep from reopening the run that is firing it).
- Exit 0 with a per-project count on stdout; a project with no `runs.json` is reported as skipped,
  never an error.

## Phases

Each phase is independently shippable and independently useful.

**Phase 1 — the selector and the store (pure, no wiring).**
`packages/cezar/src/reopen-requests.ts`: schema, `readReopenRequests`, `appendReopenRequests`,
`markReopenStarted`, `markReopenFailed`, `onReopenRequestsChanged`, all modelled line-for-line on
`todos.ts`. Plus `selectDoneUnarchived(runs)` — the Active-tab predicate as one exported function.
Ships green with unit tests and changes no behaviour.

**Phase 2 — the cockpit watcher.**
`packages/cezar/src/reopen-watch.ts` (`reconcileReopenRequests`, `watchReopenRequests`), wired in
`server.ts` beside `watchTodoAutostart`. After this phase the capability exists but nothing writes
requests, so the observable behaviour is still unchanged.

**Phase 3 — the CLI.**
`cezar runs reopen` in `packages/cezar/src/index.ts` (+ `--help` text, + the `cezar` usage block).
End of this phase = the feature is complete and deployable. **Requires a backend deploy**, and per
AGENTS.md § "Always self-deploy" that restart SIGKILLs this session's own process group; that is
expected and survivable, and restart-continuation resumes the run.

**Phase 4 — the production sweep (the owner's actual ask).**
`--dry-run` first, then `--limit 1` on one run and *watch it settle*, then the remaining 18. See
§ Verification for the gate between the canary and the rest.

**Phase 5 — record and report.** Knowledge entry + a per-run merge verdict table, so the answer to
"did it land?" exists on paper and not only in 19 transcripts.

## The prompt

The owner's words are the first line, unaltered:

```
analyze if changes/fixes/updates from this task were merged into main. If not, do it now.
```

**Proposed addition, flagged rather than assumed.** Nineteen agents will otherwise each
rediscover how to answer this, and two of the four auditable runs above needed
`git cherry origin/main <branch>` — not `git branch --merged` — to give the right answer
(`28993af3` looks unmerged against local `main` and is in fact the `origin/main` tip). So the
sweep appends a short factual grounding block: your branch is `cez/<id8>` if the run had a
worktree; a workspace run's worktrees and branch were deleted on apply-back, so check the real
checkout's history instead; local `main` may be behind `origin/main` (in `chat` it is, by 3);
`git cherry origin/main <branch>` is the check that distinguishes those. **This is an addition to
the owner's prompt and can be dropped on request** — `--prompt` takes free-form text, so the
verbatim-only sweep is one flag away.

## Risks

- **Cost.** These 19 runs cost between $0.53 and $488.73 apiece originally (`2f1ae4aa`, 33 steps,
  is the outlier). A continuation is far cheaper than an original run, but 19 of them is not
  free, and any one that decides to "do it now" on a large unmerged branch will do real work.
  Mitigations: `--dry-run`, `--limit`, and the mandatory one-run canary.
- **A reopened run can end worse than it started.** A continuation that crashes writes
  `status: 'failed'` with `continue crashed: …` (`run.ts:2634-2637`), turning a `done` row into a
  `failed` one. Nothing is lost (the work is in git, and `finishedAt` is restored on the next
  settle) but the board looks worse until it settles. The canary exists to see this once before it
  happens 19 times.
- **A reopened workspace run re-runs apply-back.** `settleSuccess` calls `applyWorkspaceRun`
  (`run.ts:4422`), which commits each worktree, diffs it against its base and `git apply --3way`s
  the result into the real checkout (`workspace-worktrees.ts:210-219`). The re-materialized trees
  branch from *current* HEAD, so the diff should be only what the continuation itself changes —
  but this path has never been exercised on a run that already applied once. **Verify on the
  canary specifically**, by diffing the real checkout before and after.
- **Nineteen queued runs behind `maxParallel: 3`.** The sweep will take hours of wall clock, and
  the cockpit's Working bucket will be full the whole time — including for whatever the owner
  starts next. `--limit` is the throttle; it is the reason the flag exists rather than a
  nice-to-have.
- **Reopening the run that is doing the reopening.** This run (`a29f2b11`) is `running`, so
  `continueRun` refuses it (`run.ts:2542`, "run is still active") — but it will be `done` by the
  time a later sweep runs. `--exclude` covers the deliberate case; the `error` stamp covers the
  accidental one without retry-looping.
- **`fs.watch` misses an event.** Same exposure and same mitigation as autostart: the next
  reconcile — a later file change or the project's next boot pass — catches it
  (`todo-autostart.ts:99`, and the Risks section of `2026-08-19-file-tasks-from-a-running-task.md`).
- **A reopen sweep is a runaway shape.** A request file that could be written by a run, reopening
  runs that write request files, loops. Mitigated structurally: a request is acted on at most once
  (`startedAt`/`error` are both terminal), `--all-done` excludes anything not `done`, and a run
  reopened by the sweep is `running` and therefore not selectable until it settles again. Not
  mitigated by a rate limit — say so rather than implying one exists.
- **The 9 projects with no `runs.json`** must be skipped silently, not error. They have
  `.ai/cezar/` directories with empty `runs/`, which is a perfectly normal never-ran-anything
  state.

## Verification (planned before implementation, per CLAUDE.md)

**Unit** (`vitest`, alongside the modules):
- `selectDoneUnarchived` — picks `done`+unarchived; rejects `done`+archived, `failed`, `review`,
  `cancelled`, `running`, `queued`, `waiting`. A table test, one row per `RunStatus` member, so a
  status added to the enum fails the test rather than slipping through.
- `reopen-requests`: round-trips a valid file; a missing file reads `[]` **and is not created**;
  a corrupt file degrades to `[]` with one warning and never throws; `markReopenStarted` /
  `markReopenFailed` are atomic and idempotent.
- `reconcileReopenRequests`: calls `continueRun(runId, {text}, true)` — asserting the `true`
  third argument explicitly, since deferral is the whole capacity story; stamps `startedAt` on
  `{ok:true}` and `error` on `{ok:false, error}`; **skips** rows already carrying either; a row
  whose `continueRun` throws is logged and the remaining rows still reconcile; two concurrent
  passes over one `dataDir` produce exactly one `continueRun` per request.
- CLI: `--dry-run` writes no file; `--limit` truncates oldest-finished-first; `--exclude` drops
  the named id; a project with no `runs.json` is counted as skipped, exit 0.

**Integration:** boot a server on a temp repo with a seeded `done` run carrying a `sessionId`,
write a request file, assert the run reaches `queued` and a `continue-1` step is appended
(`CEZ_DRY_RUN=1`, the pattern `continue-run.test.ts` already uses).

**Gates:** `npm run typecheck`, lint, and the full test suite green before the commit-push step —
enforced, not merely intended, by the `verify` post-conditions on `commit-push`/`document`/`deploy`
(`packages/cezar/src/workflows/postconditions.ts`, spec `2026-08-20-steps-green-only-when-verified.md`).

**Deploy — EXECUTED 2026-08-20 19:03-19:04 UTC exactly as planned; see § Deployment.** build →
readiness-probe the deployed tree → swap `dist` + `web/dist` into `/opt/cezar` →
`git rev-parse HEAD > /opt/cezar/.deployed-commit` → `kill -9` the MainPID. Backend change, so
the restart was required and did SIGKILL this session — restart-continuation resumed the run and
the resumed session verified its own deploy. Both `.ai/deploy-targets.json` probes exit 0
(~~currently deployed: `f9bcda42`~~ → now `f53f5a58`).

**E2E — the acceptance test, in this order, and the gate is real:**

1. `cezar runs reopen --all-done --dry-run` prints **exactly 19** runs across `workspace` (15),
   `chat` (3), `cezar` (1), and writes nothing. If the count is not 19, stop: the selector and the
   board disagree.
2. Record `git -C <each real checkout> rev-parse HEAD` and `git status --short` for all 12
   projects (all clean today) — the before-picture for the apply-back risk.
3. `cezar runs reopen --all-done --limit 1 --prompt "<the prompt>"`. Watch that one run in the
   cockpit: it must leave `done`, appear in **Working**, stream live, and settle. Then check the
   before/after diff of every real checkout for unexpected apply-back.
4. **Only if step 3 settled cleanly**, sweep the remaining 18. A failed canary means fixing this
   spec, not proceeding — say so plainly in the handoff rather than rounding up.
5. Re-audit merge state afterwards for the four branch-bearing runs and confirm `cez/7c2dd8f0`
   and `cez/b1684fe9` are either merged or explicitly declined with a reason. **These two are the
   only findings this whole task can be scored against today**; if the sweep ends with them still
   unmerged and no reason recorded, it did not work.

**Definition of done, stated so it cannot be rounded up:** gates green is necessary, not
sufficient. Until step 4 has completed and step 5 has a verdict per run, this is *QA needed*.

## Analytics

There is **no analytics/event sink in this codebase** — `todo-autostart.ts:39` records the same
finding (grepped for analytics/telemetry/trackEvent, none) and leaves a TODO rather than inventing
one. This spec follows that precedent exactly: `console` lines for reconcile outcomes, plus a TODO
for `run.reopened` (`project`, `source`, `queuedDepth`) beside the existing `todo.autostarted` one.
Stating it rather than promising events that have nowhere to go.

## Out of scope (recorded, not forgotten)

- `POST /runs/reopen-finished` and a "Reopen finished" UI broom beside "Archive finished"
  (`tasks-overview.tsx:230`). Natural, wanted, and useless to the actor this task serves.
- Archiving anything. This sweep does not clean the board; it audits it.
- ~~The two orphan refs with no run record~~ — **CORRECTED 2026-08-20 by run `7aecd6a2`: there is
  one, not two.** `cez/6af4b894` has a workspace run row and is therefore IN the sweep, not out of
  scope (see § 3). What genuinely has no run row is `cezar` `rescue/staged-index-20260820` (1 commit
  ahead of main); that one, plus `chat`'s local `main` being 3 behind `origin/main`, is real, found
  by this spec's audit, not reachable by a run-driven sweep, and worth a filed todo. Original text:
  *"The two orphan refs with no run record — `cezar` `rescue/staged-index-20260820` (1 commit ahead
  of main) and `cezar` `cez/6af4b894` (landed) — plus `chat`'s local `main` being 3 behind
  `origin/main`. Real, found by this spec's audit, and not reachable by a run-driven sweep because
  no run row points at them. Worth a filed todo."*
- `2f1ae4aa`'s three ad-hoc artifacts in `chat/.ai/cezar/runs/` (`…-reporters.json`,
  `…-reporters-user2.json`, `…-cancel-daily-tasks.sh`) — run leftovers in a directory that is
  supposed to hold only `<id>.ndjson` / `<id>.handoff.md` / `<id>.knowledge.ndjson`.

## What I could not establish

- **Whether `origin/*` is current.** The audit was read-only, so no `git fetch` ran; every
  `origin/main` claim is as of the last fetch performed by someone else. The reopened agents will
  need to fetch to answer honestly, and the prompt's grounding block should say so.
- **Whether the 15 workspace runs' work reached `main`.** Their branches and worktrees were
  deleted by a successful apply-back (`workspace-worktrees.ts:210-219`), so there is no ref to
  compare. Determining it needs each run's own `commit-push` record and the project history —
  which is exactly the work the reopened agents are being asked to do, and the reason this cannot
  be answered by a script from outside.
- **Why 9 of 12 registered projects have no `runs.json`** (never ran vs. ledger removed). No
  evidence on disk either way.
- ~~**Whether `cez/6af4b894`'s missing run record was deleted or never written.**~~ **RESOLVED
  2026-08-20 by run `7aecd6a2`: the record was never missing.** It is a workspace run, so its row is
  in `/var/lib/cezar/workspace/.ai/cezar/runs.json`, not in the cezar project's — which is the only
  file this audit checked. Original text: *"No trace in `runs.json` or its `.bak` files."*

## Deployment

Deployed to production (`prod-host`) on **2026-08-20 19:03-19:04 UTC** by step 6 of run
`a29f2b11`, using this repo's own documented deploy path (`AGENTS.md:12`) — **not**
`cezar server-deploy`, whose `systemctl restart` needs sudo the `cezar` service user does not
have.

**Deploy class: backend + web, so a tree swap AND a restart.** The delta `f9bcda42..f53f5a58`
touches `packages/cezar/src` (`server/server.ts`, `index.ts`, `reopen-requests.ts`,
`reopen-watch.ts`, `runs/reopen-cli.ts`, `workflows/postconditions.ts`), so the web-only
carve-out did not apply and the artifact in place was not a correct build of this commit.
`package.json` / `package-lock.json` are **unchanged** across the delta
(`git diff --name-only f9bcda42..f53f5a58 -- package.json package-lock.json '*/package.json'` is
empty), so no `npm install` into `/opt/cezar` was needed — the `dist` swap is sufficient, per the
one correctness caveat in `AGENTS.md:12`.

**What was run.**

```
npm run build                                  # in the worktree, exit 0 (server + web + check:pack)
cp -a <worktree>/packages/cezar/dist      /opt/cezar/packages/cezar/dist.new
cp -a <worktree>/packages/cezar/web/dist  /opt/cezar/packages/cezar/web/dist.new
diff -rq <worktree>/... /opt/cezar/...         # both exit 0, staged == built
# readiness probe, BEFORE touching the service:
node -e "await import('/opt/cezar/packages/cezar/dist.new/server/server.js'); ..."   # exit 0
mv .../dist     .../dist.bak.20260820-190308  &&  mv .../dist.new     .../dist
mv .../web/dist .../web/dist.bak.20260820-190308 && mv .../web/dist.new .../web/dist
printf '%s\n' f53f5a58c5d24f950841293dcb847f20c19a304b > /opt/cezar/.deployed-commit
kill -9 3548803                                # the unit's MainPID; Restart=on-failure brings it back
```

Rollback is reversing the two `mv` pairs for stamp `20260820-190308` and restoring
`.deployed-commit.bak.20260820-190308`.

**Readiness gate, executed BEFORE the swap** (`AGENTS.md:12` — "readiness-probe the DEPLOYED tree
before touching the service, so a broken build is still one `mv` from rollback"). The staged tree
was imported, not merely inspected:

| # | Probe | Result |
| --- | --- | --- |
| 1 | `await import()` the staged server module graph (`server/server.js`, `reopen-watch.js`, `reopen-requests.js`, `runs/reopen-cli.js`, `workflows/postconditions.js`) | exit 0, 490 ms |
| 2 | `node dist.new/index.js runs reopen --help` | prints the new usage block |
| 3 | **Negative control:** the OLD deployed tree | no `dist/runs/reopen-cli.js`; `runs reopen` was an unknown route there |

Probe 3 is what makes probes 1-2 evidence of *new code* rather than a re-copy.

**Restart.** `kill -9` on MainPID `3548803` at 19:03:57 UTC; the unit was back `active (running)`
as MainPID `3683619` at **19:04:02 UTC — a ~5 s outage**, `NRestarts=11`. As `AGENTS.md:12`
predicts, that SIGKILL took the deploying session's own process group with it; restart-continuation
(`.ai/specs/2026-08-20-chain-integrity-restart-and-continuation.md`) resumed this run, and the
resumed session is what verified the deploy below. Expected and survivable, exactly as documented.

**Post-restart verification — both `.ai/deploy-targets.json` targets exit 0.**

| target | probe | result |
| --- | --- | --- |
| cezar service (backend) | `dist/index.js` present ∧ `.deployed-commit` == HEAD ∧ `GET /api/v1/health` | **exit 0** |
| cezar UI (web) | `web/dist/index.html` present ∧ served HTML references the built entry chunk | **exit 0** (`assets/index-CfWS9u4Q.js`) |

**Delivery is not activation — so activation was proved separately**, which is the whole point of
that `$comment` in `.ai/deploy-targets.json`. A health 200 only shows *some* process answers:

- the resident process's own `cmdline` is `/usr/bin/node /opt/cezar/packages/cezar/dist/index.js
  serve …`, started **19:04:01**, i.e. after the 19:03:08 swap — it loaded the new tree, not the old one;
- `dist/server/server.js` imports `../reopen-watch.js` (line 61) and calls `watchReopenRequests`
  at three seams (boot context, context-built, per-project);
- **runtime, not static:** PID `3683619` holds an inotify watch on inode `0x5f5aa`, which is
  `/var/lib/cezar/workspace/.ai/cezar` — the reopen store's `dataDir`. The watcher is subscribed
  in the live process, not merely present on disk.

**Verification § E2E step 1 is DISCHARGED by this deploy step.** Run against the *deployed*
binary from `/var/lib/cezar/workspace`:

```
node /opt/cezar/packages/cezar/dist/index.js runs reopen --all-done --dry-run \
  --exclude a29f2b11-f83a-4c37-92bb-ff538551146a
→ dry run — 19 run(s) would be reopened, nothing written        (exit 0)
→ skipped (no runs.json): anymail-mcp, aside, bubble-trade, career, career-kit,
  homebrew-tap, mw-site, brand, lokie-chatbox
```

**Exactly 19**, split `workspace` 15 / `chat` 3 / `cezar` 1 — the count this spec predicted, so
the selector and the board agree. `reopen-requests.json` was absent before and after: the dry-run
path returns at `reopen-cli.js:197`, before any `appendReopenRequests`. The selector, the project
walk, the exclude flag and the CLI wiring are therefore all confirmed working *in production*.

**What this deploy does NOT discharge.** Nothing has been reopened. E2E steps 2 onward — the
`--limit 1` canary, the remaining 18, and the per-run merge verdicts — are Phases 4-5 and remain
**QA needed**, carried by cezar todo `3cd4adc4`. Deploying is what makes that sweep possible at
all; it is not the sweep.

## Status log — 2026-08-20 (run `a29f2b11`, workflow `spec-to-deploy`)

| step | outcome |
|---|---|
| 1 `spec` | this file, written after reading the KB, the spec dir and a four-run production merge audit. |
| 2 `implement` | Phases 1-3: `reopen-requests.ts` (store + `selectDoneUnarchived`), `reopen-watch.ts` (cockpit watcher, wired in `server/server.ts`), `runs/reopen-cli.ts` (`cezar runs reopen`, routed in `index.ts`). 5 new test files, 64 tests. |
| 3 `run-tests` | full suite. Found and fixed a **pre-existing** red from `57fc8807` — post-conditions evaluated under `CEZ_DRY_RUN=1` — reproduced at clean `HEAD` as a control. +3 tests. |
| 4 `commit-push` | `2e421370` (the dry-run repair) and `0cbb65a4` (the feature), pushed `f9bcda42..0cbb65a4`. Split deliberately: burying a cross-cutting engine repair inside a `feat:` hides it from the `git log -S` archaeology AGENTS.md relies on. |
| 5 `document` | this status block, the `CHANGELOG.md` Added + Fixed entries, `AGENTS.md`'s post-condition rule given its dry-run carve-out, and three specs marked in place (`steps-green-only-when-verified`, `spec-to-deploy-default-workflow`, `003-handoff-cli`). Todos filed for Phases 4-5. |
| 6 `deploy` | **DONE 2026-08-20 19:04 UTC — see § Deployment.** `f9bcda42` → `f53f5a58` in `/opt/cezar`; `dist` + `web/dist` swapped (no `npm install`, the delta touches no manifest), readiness-probed before the swap with a negative control, service restarted (MainPID 3548803 → 3683619, ~5 s outage) and the restart SIGKILLed this session as predicted — continuation resumed the run and the resumed session verified it. Both `.ai/deploy-targets.json` probes exit 0, and the watcher is proved live in the resident process (inotify watch on the store `dataDir`). E2E step 1 discharged against the deployed binary: **exactly 19**, nothing written. |

**What a later session must not conclude from this file.** That the sweep ran. **AMENDED
2026-08-20 19:51 UTC by run `7aecd6a2`: 1 of the 19 has now been asked** — chat `b1684fe9`, the Wave
A canary, reopened 19:27:26 UTC and still answering — **and 18 have not.** No verdict has been
recorded for any of them. The paragraph's warning stands for those 18. The
19 `done` runs on the production Active tab have not been asked whether their work reached `main`,
and the two runs this spec's audit already caught with commits on no `main` anywhere are still
unmerged. Phases 1-3 built the door and step 6 opened it in production — but nobody has walked
through it. The only thing the deploy proved about the sweep is that its *selector* returns the
predicted 19 and writes nothing; firing it is Phase 4, todo `3cd4adc4`.
