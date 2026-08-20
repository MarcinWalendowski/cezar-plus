# Reopen every finished task and make it prove its work reached `main`

> **Status: PARTIAL — Phases 1-3 implemented 2026-08-20 (run `a29f2b11`, `implement` step);
> Phases 4-5 (the production sweep and its record) NOT done, nothing has been reopened yet.**
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

**Deploy:** build → readiness-probe the deployed tree → swap `dist` + `web/dist` into `/opt/cezar`
→ `git rev-parse HEAD > /opt/cezar/.deployed-commit` → `kill -9` the MainPID. Backend change, so
the restart is required and will SIGKILL this session. `.ai/deploy-targets.json` probes must all
exit 0 (currently deployed: `f9bcda42`).

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
- The two orphan refs with no run record — `cezar` `rescue/staged-index-20260820` (1 commit ahead
  of main) and `cezar` `cez/6af4b894` (landed) — plus `chat`'s local `main` being 3 behind
  `origin/main`. Real, found by this spec's audit, and not reachable by a run-driven sweep because
  no run row points at them. Worth a filed todo.
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
- **Whether `cez/6af4b894`'s missing run record was deleted or never written.** No trace in
  `runs.json` or its `.bak` files.
