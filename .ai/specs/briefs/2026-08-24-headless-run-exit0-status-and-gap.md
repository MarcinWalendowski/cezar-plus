# Brief — headless `cez run` exits 0 mid-workflow (task `eeceb869-64ee-462a-a180-675761e24ce7`)

**Step:** 1/8 — Gather the record only. No spec, code, or tests were written or run in this
step; everything below is a read of what is *already on this branch*, HEAD `2256f748`.

**Why this brief exists even though a fix already landed:** this task has been through many
prior cycles on this same branch (see handoff progress log — spec written and reviewed 7
rounds, implementation done, "continue-2" failed once). Between the start of this step and
now, HEAD moved from `8426420a` to `2256f748` — a real, gate-verified fix commit landed mid-step
(not written by me; discovered by re-checking `git log` after dispatching research). This brief
therefore documents the **current, post-fix state**, not a fresh problem statement, because the
fresh problem statement was already answered on this branch. The job for the next step is to
decide what remains, not to re-diagnose.

## The problem, in this repository's own terms

A headless `cez run <task> --repo <fixture>` could return exit code 0 while its durable run row
in `.ai/cezar/runs.json` was still `status: "running"`. Root cause (measured, not guessed): the
CLI has no run-lifetime handle of its own — it survives only on the incidental ref of whatever
step-scoped timer/socket happens to be open at that instant, and at a step hand-off boundary
there can be a gap with zero ref'd handles, at which point Node's event loop drains and the
process exits naturally with `process.exitCode` never having been set to non-zero. Discovered by
the gate run of task `737eba99`; canonical open todo `49162dbe-8857-4f5d-abff-7be5fcc2967b` in
`.ai/cezar/todos.json` (repo `~/loki-labs/cezar`, not this worktree — filed `2026-08-21T22:08:23Z`,
`status: "todo"`, **still open, never updated by any of the tasks that worked this bug**).

## What's already on this branch (commit `2256f748`, "fix: keep a headless cezar run alive until its record is terminal")

Implements `.ai/specs/2026-08-23-headless-run-drains-event-loop.md`. Four pieces, all present at
HEAD:

- **P1 `runExitGuard`** (`packages/cezar/src/runs/run-exit-guard.ts:48-58`) — a `beforeExit`
  backstop. No-ops on a missing or already-terminal record (`:56`); otherwise calls
  `failNonTerminalRun` (`:30-45`), which writes `status: 'failed'` + an explicit error string,
  flushes the store, and sets `process.exitCode = 1` (never a hard `process.exit()`).
- **P2 a run-lifetime keep-alive** — `packages/cezar/src/index.ts:1107-1117`, a `setInterval`
  armed before `manager.startRun(...)` (`:1119`) and cleared in a `.finally()` at `:1132-1136`,
  so the loop cannot drain across a step hand-off by accident.
- **P3 `RunManager.runLiveness()`** (`packages/cezar/src/workflows/run.ts:3675-3684`) — a
  read-only predicate over **seven** run-state registries (`active`, `starting`, `queue`,
  `waiting`, `monitoring`, `autoResumeTimers`, `pendingJobs`), deliberately wider than the
  pre-existing `isActive()` (`:3667-3669`, only 3 of the 7). Paired with `runWedgeTick`
  (`run-exit-guard.ts:64-112`): a missing record or a "not live" reading is tolerated for up to
  `RUN_WEDGE_TICKS = 3` consecutive 1s ticks (`RUN_KEEPALIVE_MS = 1_000`), then fails the run and
  clears the keep-alive — so P2's handle is bounded, not an unbounded hang-preventer-turned-hang.
- **P4** `CEZ_RUN_FAULT=stall-step[:stepId]` fault injector (`run.ts:5391-5395`, wedges a step
  deliberately for testing) and `CEZ_RUN_WEDGE_DEBUG=1` diagnostics, both documented in
  `.env.example:404-407`.

Both new modules are unit-tested standalone (not via `src/index.ts`, which has zero exports and
calls `main()` at module scope): `run-exit-guard.test.ts` (7 cases) + `run-liveness.test.ts` (8
cases) = 15 cases, all passing per the commit message and the KB doc below.

## Acceptance criteria — current status, from the commit message and the KB record it matches

KB `specs-b3a2d37e8d23` ("Headless Run Event Liveness", `.ai/specs/2026-08-23-headless-run-drains-event-loop.md`)
carries a block headed **"VERIFIED 2026-08-24"**, timestamped `20:04:40Z`, immediately preceding
the `20:06:17Z` commit — this is the one revision of that spec written *after* something was
actually executed, not merely read:

- `npm run typecheck` — exit 0.
- `npm run test:unit` — exit 0, **53/53**.
- `npm run build` — exit 0.
- `npm test` — exit 1, **15 failed / 11723 passed / 4 skipped**, and all 15 are proven
  pre-existing on clean `origin/main c328ec06` too (16 failures there — this branch's failure
  set is a strict subset, not a regression).
- `run-exit-guard.test.ts` 7/7, `run-liveness.test.ts` 8/8 (`--reporter=verbose` specifically to
  avoid "absence from a log proves nothing").
- `CEZ_DRY_RUN=1 CEZ_RUN_FAULT=stall-step timeout 45 node dist/index.js run mock:done` → exit
  **124** (timeout), record still `running` — this is the fault injector working as a *sanity
  check that a genuine wedge is still caught*, not a regression.
- `npm run test:package` → **17 passed / 1 failed**, identically idle and under an 8-way busy
  load.

**AC1 (bisect names the commit) — answered: `a7510b2f`.** Not a literal `git bisect run` session
transcript; a static predicate applied to the exact two-way flip (`workflowName ?? 'quick-task'`
→ `workflowName ?? DEFAULT_WORKFLOW_NAME`) plus its git position, reasoned to be equivalent to
and cheaper than a mechanical bisect (spec's own §"Why not a mechanical bisect" — I did not
independently re-verify this reasoning in this step; flagging as **the one AC1 detail the next
step should sanity-check** if a literal bisect transcript is what "done" requires). `a7510b2f`
and `5e388ccf` are siblings (both children of `67e93cca`, neither an ancestor of the other,
`git diff` between them on `index.ts` is empty) — the handoff's own `097d1b15` hypothesis is
refuted by this spec's §6, independently confirmed by the sibling-task investigation below.

**AC3 (never exits 0 while running) — met**, per the fault-injector sanity check above and the
event-loop-drain measurement in the commit message: "against unfixed main on the same fixture
and probe, single-handle event-loop windows drop from 15 to 1, and the one that remains is in
boot before a run record exists" (i.e. before there is anything to leave `running`).

**AC2 (`npm run test:package` is 15/15 — now 18 cases, so 18/18 — green on main) — NOT met, and
NOT met for a reason unrelated to this bug.** This is the one open item. See next section.

## The open gap: AC2 is blocked by a second, independent, pre-existing defect

`packages/cezar/test/e2e/package-cli.test.ts:14` ("the release tarball installs and runs the
dry-run CLI workflow" — the exact case the original bug report named) now fails with
`You've hit your usage limit. Upgrade to Pro… or try again at Aug 31st, 2026 12:32 PM.`, **not**
a stall or an exit-0. Root cause, measured identically on this branch and on clean
`origin/main c328ec06`:

- `resolveCodexExecutable()` (`packages/cezar/src/core/codex-app-server-transport.ts:19-20`,
  `override ?? process.env.CEZ_CODEX_BIN ?? 'codex'`) has **no `CEZ_DRY_RUN` branch**, unlike the
  Claude runner (`claude-cli-runner.ts:137`, which substitutes a mock binary under
  `CEZ_DRY_RUN=1`).
- The default `spec-to-deploy` workflow pins its `review-spec` step to a codex model (per the
  2026-08-24 "codex step model and effort" work, `specs-c6acc2811730` / `specs-9e1e3308c99f`,
  landed same-day on `main` as `c328ec06`, already merged into this branch).
- So `CEZ_DRY_RUN=1 cez run` **spawns the real `codex` CLI**, which dies on quota on this box.
- A mock fixture already exists but isn't shippable as-is:
  `packages/cezar/src/core/__fixtures__/codex/mock-codex-app-server.mjs` (223 lines, test-only —
  `package.json`'s `files` field ships `dist`, `web/dist`, `scripts`, `README.md`, not
  `src/core/__fixtures__`).

Documented in three places already (all landed in commit `2256f748`, so this is not new
information for the next step to discover, only to act on): `AGENTS.md:367-398` (trap 5, twice
corrected in place, 2026-08-23 and 2026-08-24), the spec's own status block, and a **queued but
not-yet-applied** knowledge proposal at
`$CEZ_KB_WRITE_FILE` (`.../eeceb869-64ee-462a-a180-675761e24ce7.knowledge.ndjson`, `seq: 0`) —
titled "CEZ_DRY_RUN does not mock the codex backend, so dry runs spend real quota". That proposal
also names a **second, independent** pre-existing `npm test` red: `system-prompt.test.ts` (8 of
main's 16 failures) asserting on a recorded agent invocation but receiving a task-classifier
prompt instead — unrelated to both this bug and the codex-quota gap.

**Open question the next step must settle:** does closing this task require *also* shipping a
codex dry-run mock (i.e. extend `resolveCodexExecutable` + package a shippable mock, mirroring
the Claude runner's pattern), or is that legitimately out of scope as an independent,
already-reproducing-on-`main` defect deserving its own follow-up task? The acceptance criterion
as literally written — "`npm run test:package` is 15/15 green **on main**" — points toward
in-scope: it names `main`, and the red case is the exact one the bug report opened with, so a
reader closing this task's todo while that case is still red on `main` would be shipping the
same symptom under a new cause. Precedent for the alternative (declare it a separate defect,
close this task, file a new todo) exists on this same branch: the `npm test` infra brief
(`specs-facf916dad1a`, `specs-cb279cda3c66`) treated "pre-existing, reproduces on clean main,
independently diagnosed" as sufficient grounds to not block *that* fix's merge — but note that
precedent was for a *different* test suite (`npm test`, not `npm run test:package`), and it was
still fixed separately and promptly (commit `1c225e7e`, merged same week), not left open
indefinitely.

## Prior decisions this must not contradict, and one that needs a correction still pending

- **Sibling task `9bf5030d`** (`.ai/specs/2026-08-22-headless-run-exit0-bisect-and-verify.md`,
  landed via `a2a74f43`) closed *itself* as "PARTIAL, documentation-only duplicate closure…
  implemented, tested, and shipped by the sibling task's commit `3e6d1b7e`… no application code
  change belongs to this task," naming `954c6a55` as the reachability commit for a **narrower**
  bug: one unref'd poll timer in `BrokeredSession`'s constructor, which `3e6d1b7e` fixed. That
  conclusion is **not wrong, but incomplete**: `3e6d1b7e` closed one step-boundary drain gap
  (broker startup); this task's P1–P4 close the general class (~55 other hand-off gaps measured
  in the original probe). This task's own spec (§"Prior decisions this touches", tail of
  `.ai/specs/2026-08-23-headless-run-drains-event-loop.md`) already **instructs** that once the
  fix ships, a `SUPERSEDED <date> by .ai/specs/2026-08-23-headless-run-drains-event-loop.md`
  lead-in should be added to `2026-08-22-headless-run-exit0-bisect-and-verify.md`'s status line,
  preserving its original text, and crediting the two things it got right (the `097d1b15`
  refutation, and the `node_modules` resolve-upward warning). **I checked: this correction has
  NOT been written yet** — the fix commit (`2256f748`) touched only the spec file and
  `AGENTS.md`, not `2026-08-22-headless-run-exit0-bisect-and-verify.md`. This is still owed.
  `9bf5030d`'s bisect answer `954c6a55` and this task's `a7510b2f` are both real, dated commits
  and are **not contradictory** — they answer two different "what made X reachable" questions
  (one-shot broker wiring vs. multi-step-default flip), `a7510b2f` chronologically first.
- **`3e6d1b7e`** ("keep a one-shot brokered run's interval ref'd") is confirmed present on this
  branch (`git merge-base --is-ancestor 3e6d1b7e HEAD` → true) — it's a real prerequisite/partial
  fix, not competing unmerged work.
- The canonical todo `49162dbe-8857-4f5d-abff-7be5fcc2967b` is still `status: "todo"` in
  `~/loki-labs/cezar/.ai/cezar/todos.json` (this worktree has no `todos.json` of its own —
  confirmed, `grep` for it here returned "No such file or directory"). Neither this task nor
  `9bf5030d` has ever touched it. It should be updated (not necessarily to `done`, given the AC2
  gap above) once the next step decides AC2's scope.
- **This commit is not yet pushed.** `git status` shows a clean tree at `2256f748`, one commit
  ahead of the merge of `origin/main`; no `origin/cez/eeceb869` ref exists yet. `origin/main` has
  also moved one commit further (`ec867e7f`, docs-only) since this branch's last merge — not a
  blocker, just unmerged drift to be aware of before the next commit-push step.

## What I could not determine

- Whether AC1's "static predicate, not a mechanical bisect" reasoning would satisfy a strict
  reading of "git bisect names the commit" — flagged above, not independently re-verified this
  step.
- The exact meaning of the handoff's `"mock: implemented the change (dry run)"` and `"continue-2"
  … status=failed` progress-log entries from earlier today (13:42, 15:26, 17:57, 19:46, 19:54
  UTC) — no elaborating text exists anywhere in the handoff file or the KB for these specific
  lines; they read like orchestrator-level telemetry rather than agent-written narrative, but I
  could not confirm that.
- Whether `packages/cezar/node_modules/.bin` having exactly 1 entry (rather than the 0 an
  earlier KB doc described, or a fuller count) reflects a partial install state — root
  `node_modules/.bin` has 28 real entries including `vitest`/`tsx`/`tsc`, which is the normal
  hoisted-workspace shape per `AGENTS.md:318-329`'s resolve-upward-trap description (that trap's
  signature is ~13 `.bin` entries and no `vitest`/`jsdom`; this worktree doesn't match it), so
  this is very unlikely to invalidate the verified gate results above, but I did not chase the
  discrepancy to ground.
- Whether `9bf5030d`'s and `737eba99`'s short IDs seen elsewhere in the corpus (in two unrelated
  systemd-scope-collision documents) are genuinely the same task IDs or a coincidental run-ID
  prefix collision — flagged in case a future step greps for one of these IDs and gets an
  unrelated hit.

## The three or four facts that most constrain the next step

1. **The core fix is already implemented, committed (`2256f748`), and gate-verified** — AC1 and
   AC3 are effectively closed; do not re-implement P1–P4.
2. **AC2 is the only open acceptance criterion, and it's blocked by an independent, already
   root-caused defect** (`resolveCodexExecutable` has no `CEZ_DRY_RUN` branch) that reproduces
   identically on clean `origin/main` — the next step must decide, explicitly, whether fixing
   that is in scope for this task or is a separate follow-up, and act on that decision rather
   than leaving it implicit.
3. **A documentation correction is owed and not yet done**: `SUPERSEDED` the `9bf5030d` spec's
   duplicate-closure conclusion in place, per that spec's own explicit instruction.
4. **Nothing has been pushed yet**, and the canonical todo (`49162dbe`) has never been updated by
   any task that worked this bug — closing the loop on the record (not just the code) is still
   required before this can be called done.
