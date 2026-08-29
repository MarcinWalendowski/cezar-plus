# Brief: ship bulk start filed tasks

**Task id:** 480e0282-a967-4936-a12e-3c4e56450586
**Step:** 1/9 — Gather the record only. No spec, code, or tests were written or run beyond
read-only gate probes used to verify claims below.
**Date:** 2026-08-24
**Worktree:** `/var/lib/cezar/loki-labs/cezar/.ai/cezar/worktrees/480e0282-a967-4936-a12e-3c4e56450586`
(branch `cez/480e0282`, HEAD `b3d3a44c`, clean, level with `origin/main`)

## The problem, in this repository's own terms

A prior, isolated task (`e6592588-1628-40e0-b31a-8fe26c8b2220`) implemented and gate-verified a
feature — multi-select + "Run N tasks" on the cezar cockpit's `/tasks` Filed table — entirely
inside its own worktree, but that task was **not authorized to commit or push** (workspace-run
policy forbids commit/push from that run) and therefore could not deploy either, since blue-green
deploy requires a committed, pushed sha. This task's job is purely the shipping half: pull that
already-implemented, already-gated diff into a clean current-`main` tree, commit it referencing
the spec, push to `origin main`, re-run all five gates on the exact committed tree, deploy with
`cezar server-deploy --strategy=blue-green`, pass the declared readiness probes, run a real
production browser E2E, and record the outcome in the corpus.

**This is reconciliation + release engineering, not feature design.** The feature's design
questions (selection semantics, navigation behavior, partial-failure reporting) are already
answered and cited below; nothing in this task should reopen them.

## What the record already decided (with citations)

1. **The spec is written and describes the shipped shape.**
   `.ai/specs/2026-08-24-bulk-start-filed-tasks.md` (KB `specs-06402c11d9f7`), status line:
   *"Implemented — QA needed (runtime E2E in a real browser on prod not yet run)"*. It documents:
   a `ReadonlySet<string>` selection keyed `` `${project}:${todoId}` `` (project-qualified because
   the Filed board is cross-project); selection reads always intersect with the **visible, sorted,
   paginated** row list, so a filtered-out ticked row is dropped from the batch by construction and
   restored when the filter is removed; select-all scopes to **rendered** rows only, never the full
   unpaginated set; starts are awaited **one at a time**, a failure never aborts the rest, and the
   batch action **never navigates** (unlike the existing single-row `useStartFiledTask`, which still
   does). Explicitly out of scope: bulk archive, shift-click range selection, any server change.
   `POST /p/:projectId/todos/:id/start` is unmodified — N calls to the existing endpoint is the
   whole feature.

2. **The corpus note for this feature is already drafted** (not yet written — see below) in
   `/var/lib/cezar/workspace/.ai/cezar/runs/e6592588-1628-40e0-b31a-8fe26c8b2220.knowledge.ndjson`:
   an `upsert` for `cezar/bulk-start-filed-tasks.md`, restating the three non-obvious design calls
   above and the exact gate state at hand-off. This task's "write the deployment/verification
   outcome to the corpus" criterion should extend this note (new "Shipped" section with the deploy
   sha, probe results, and the runtime E2E artifacts), not create a second one.

3. **This extends, not replaces, the existing Filed table.**
   `.ai/specs/2026-08-17-filed-tasks-table-statuses.md` (KB `specs-fc81f822fe2d`) owns
   `packages/web/src/lib/filed-tasks.ts`'s pre-existing filter/sort/status vocabulary; the new
   selection helpers are appended after it, not interleaved.

4. **Deploy mechanics on this box are settled and must be followed exactly, not improvised:**
   `AGENTS.md:11-17` — `cezar server-deploy --strategy=blue-green` is the only correct path on
   `prod-host` (rootless blue-green; `/opt/cezar` is a symlink into
   `/opt/cezar-releases/…`; `.deployed-commit` is dead, `deploy.json` + `GET /api/v1/health`'s
   `deploy` field are the ledger). `npm run build` must run first and produces the
   `dist/.build-stamp.json` that `server-deploy` refuses to stage without. From inside an agent
   task, a deploy must use a **user** `systemd-run --user` transient unit (this box has
   `Linger=yes`, live `user@999.service`), never a system one. `--rollback=` (with the trailing
   `=`) is the correct spelling; both known argv/readiness traps (`f97ddd39`, `6497f002`) are fixed
   as of 2026-08-22/23.

5. **The two declared readiness probes** are `.ai/deploy-targets.json`: a backend probe that polls
   `GET /api/v1/ready` (bounded 30s/2s) until it reports a `deploy.sha` that is `HEAD` or a
   descendant of it, and a UI probe that polls `GET /` until the served HTML references the
   built `assets/index-*.js` bundle. Both are `"manual": true` with a `manualReason` — **read this
   literally against the acceptance criterion "pass every declared readiness probe" before
   assuming the workflow's automated `deploy` step alone satisfies it**; the file's own header
   comment says cezar is two services and a half-verified deploy "reads like a whole one," which
   is exactly the failure mode a manual flag exists to force a human/agent to actually run the
   probe script, not just trust a green step.

6. **"The five cezar gates," precisely** (`.ai/specs/2026-08-22-missing-session-resume-verification.md:474-482`,
   `AGENTS.md:225-237`): run from the **repo root**, in this order, each exiting 0 —
   `npm run typecheck`, `npm test`, `npm run test:unit`, `npm run build`, `npm run test:package`
   (needs the completed build). There is no root `lint` script (`npm run lint` → "Missing
   script"), so lint is not one of the five — confirmed by trying it in this worktree.

## Code actually involved (current HEAD `b3d3a44c`, verified directly, not assumed from the parent's notes)

The parent worktree's diff against **its own** merge-base (`9c896e32`) is exactly 6 files,
+407/−350:

```
 .ai/specs/2026-08-24-bulk-start-filed-tasks.md    |  71 +++++
 packages/cezar/test/unit/deploy-e2e-probe.test.ts | 348 ----------------------
 packages/web/src/lib/filed-tasks.test.ts          |  53 ++++
 packages/web/src/lib/filed-tasks.ts               |  43 +++
 packages/web/src/routes/global-tasks.test.tsx     |  89 +++++-
 packages/web/src/routes/global-tasks.tsx          | 153 ++++++++++
```

Verified by direct diff (not by trusting the handoff prose) against **this task's own clean
worktree** (branched from current `origin/main`), file by file:

- `packages/web/src/lib/filed-tasks.ts` — this task's worktree already has the pre-existing
  231-line file (filters/sort/status, `2026-08-17` spec). The parent's 43 new lines
  (`filedTaskKey`, `toggleFiledSelection`, `setFiledSelection`, `selectedFiledEntries`,
  `filedSelectionState`) are a clean **append**, diffed byte-for-byte — not present here.
- `packages/web/src/routes/global-tasks.tsx` — full diff read directly (not summarized): adds
  `useStartFiledTasks()` beside the untouched `useStartFiledTask`, a `selected` state set, a
  `SelectAllCheckbox` (tri-state, `indeterminate` via a ref effect) and `FiledRowCheckbox`
  component, a leading 40px `<Th>` checkbox column in the table head, a `data-slot="filed-select"`
  cell in both `FiledRow` and `FiledCard`, and a `data-slot="filed-selection-bar"` block
  (`data-action="start-selected-filed-tasks"` / `"clear-filed-selection"`) rendered only when
  `batch.length > 0`. None of this exists in this task's worktree yet (`grep -c
  start-selected-filed-tasks` on `origin/main`'s copy → 0).
- `packages/web/src/routes/global-tasks.test.tsx`, `packages/web/src/lib/filed-tasks.test.ts` —
  new/expanded test files for the above (211 lines combined new coverage).
- `.ai/specs/2026-08-24-bulk-start-filed-tasks.md` — already present in this task's worktree
  (present on `origin/main`), so it is **not** part of what needs reconciling — it landed
  separately (visible directly in this worktree already, byte-identical spec content).
- `packages/cezar/test/unit/deploy-e2e-probe.test.ts` — deletion, **investigated in depth,
  not taken on faith** (see next section): confirmed correct and currently necessary.

## The deploy-e2e-probe.test.ts deletion — verified independently, and it is correct

The acceptance criteria describe this as "removal of the superseded deploy-e2e-probe unit
duplicate." That characterization is easy to misread as a stray cleanup; it is not — it is load
-bearing, and re-running the gate confirms it:

- **Two files share a filename but are not duplicates by content.** `test/unit/deploy-e2e-probe.test.ts`
  (9 cases, `node:test`, spawns the probe script against a bare `node:http` fixture — CLI-arg
  validation, HTTP-only assertion shape) runs under `npm run test:unit`
  (`packages/cezar/package.json:39`, `test/unit/*.test.ts`). `test/e2e/deploy-e2e-probe.test.ts`
  (6 cases, different scenarios — auth/401 handling, project scoping, SSE reconnect/gap
  detection, redirect handling) runs under `npm run test:package`
  (`packages/cezar/package.json:40`, `test/e2e/*.test.ts`) — a **different gate**, despite the
  directory name. `.ai/specs/2026-08-22-deploy-e2e-probe-vacuous-pass.md:497` is the design
  record for the unit file's original 9 cases.
- **Measured directly in this task's own clean worktree, right now:** `npm run test:unit` is
  currently **RED** — 53 total, 45 pass, **8 fail** — and all 8 failures are exactly this file
  (`not ok 4..10, 12`, all under `packages/cezar/test/unit/deploy-e2e-probe.test.ts`; only its
  9th case, "`--header` is sent…", still passes). The script that this unit file spawns and
  asserts against was rewritten by commit `587db317` ("make deploy-e2e-probe assertions
  non-vacuous," already an ancestor of this worktree's `b3d3a44c` and of the parent's merge-base
  alike) — the unit file's assertions on the *old* script shape are now stale. `9 removed (1
  pass + 8 fail) → 53−9=44 total, 45−1=44 pass, 0 fail`, which is the **exact** "test:unit 44
  passed" the parent task reported after deleting it. **Deleting this file is not incidental to
  shipping the feature — it is currently the only thing that makes gate 3 of 5 green on this
  branch at all**, independent of the Filed-table feature.

This is worth stating plainly in the next step's spec so it isn't miscategorized as an
unrelated/out-of-scope change to exclude per the handoff's "do not include unrelated shared
-checkout changes" instruction — it is *in scope*, verified, and necessary.

## Prior decisions this would touch, and one live in-flight item to be aware of

- **`d0386413-8bac-4e2a-88c4-62c37ab87ea1`** ("Implement the non-disruptive cezar self-deploy
  spec — blue-green + run-slice + atomic release") is `in-progress, high, started` on the cezar
  todo board. It is the umbrella item that produced the blue-green deploy path this task must
  use; nothing here conflicts with it, but a concurrent deploy from that work could race this
  task's own `server-deploy` invocation on the shared box — check for a live conflicting deploy
  before running this task's own.
- **No other active worktree carries this feature.** Swept all 16 worktrees under
  `cezar/.ai/cezar/worktrees/`: only `e6592588` (the parent, source of the diff) has
  `start-selected-filed-tasks`; `origin/main` has zero occurrences. No duplicate-shipping risk.
- **Standing authorization already covers this task's push/deploy steps** — `AGENTS.md:11` /
  workspace `CLAUDE.md` "Working Agreement" both grant commit/push-to-`origin/main`/deploy for
  `cezar` without asking, so acceptance criterion 2 ("push explicitly to origin main, never
  upstream") is a repetition of standing policy, not a new grant — but "explicitly" is the
  operative word given `cezar` is the one repo with a second remote (`upstream`); this worktree's
  `git remote -v` shows only `origin` configured, no `upstream`, which removes the accidental-push
  risk mechanically but a bare `git push` should still not be assumed elsewhere on this box.

## Open questions the spec must settle

1. **Reconciliation mechanics.** The parent's diff is best obtained as a patch (`git diff` between
   the parent worktree's merge-base and its HEAD) and applied to this clean worktree — not a
   merge or cherry-pick of `1089391e` (an "autosave" commit whose parent history includes commits
   this worktree doesn't share). Confirm the patch applies cleanly given `.ai/specs/2026-08-24
   -bulk-start-filed-tasks.md` already exists identically in both trees (patching a file that's
   already identical is a no-op hunk, not a conflict, but worth a dry-run check first).
2. **Disposable filed tasks for the E2E.** The acceptance criteria require creating and starting
   two *disposable* filed tasks in production, then cleaning them up. Neither the spec nor this
   brief's search surfaced an existing "disposable test task" convention on this board — the spec
   should define what marks a task disposable (a project/tag, a naming prefix) and the exact
   cleanup step (archive vs. delete), so the E2E doesn't leave stray rows on the real board.
3. **Readiness-probe execution given `"manual": true`.** Confirm whether the shipping workflow's
   `deploy` step actually invokes `.ai/deploy-targets.json`'s probes despite the `manual` flag, or
   whether this task must run `bash -lc '<probe>'` itself post-deploy to satisfy "pass every
   declared readiness probe" literally.
4. **Corpus write mechanics.** Per workspace `CLAUDE.md`, a corpus write is not indexed until
   `cez kb reindex` runs and is confirmed via `grep -ac <slug> catalog.ndjson`, not by search
   result count alone — the spec's verification section should include this exact check for
   whatever note this task adds/extends.

## Most constraining facts for the next step

1. The feature diff is fully implemented, gate-verified in isolation, and cited above
   (`.ai/specs/2026-08-24-bulk-start-filed-tasks.md`); this task is reconciliation + release only —
   don't redesign the feature.
2. **The `deploy-e2e-probe.test.ts` unit-file deletion is not cosmetic — it is required for gate 3
   of 5 (`npm run test:unit`) to pass at all**, independently verified by running it red (8/8
   matching failures) on this task's own clean worktree right now.
3. The five gates are exactly `npm run typecheck`, `npm test`, `npm run test:unit`, `npm run
   build`, `npm run test:package`, from the repo root, in that order — there is no root `lint`
   script.
4. Deploy must go through `cezar server-deploy --strategy=blue-green` via a **user** `systemd-run`
   transient unit (never system), after `npm run build` produces `dist/.build-stamp.json`; the two
   declared readiness probes in `.ai/deploy-targets.json` are marked `"manual": true` and must be
   read literally against the acceptance criterion, not assumed satisfied by a green workflow step.
