Brief — headless `cez run` exits 0 mid-workflow — run left stuck at status 'running'

**For task 9bf5030d. Gather-the-record step only — no spec, no code, no test run here.**

## The problem, in this repository's own terms

Task 9bf5030d's own handoff (`$CEZ_HANDOFF_FILE`) states: `npm run test:package` case 5
("the release tarball installs and runs the dry-run CLI workflow",
`packages/cezar/test/e2e/package-cli.test.ts:14`) is RED on main. Reproduced by hand:
`node dist/index.js run mock:done --repo <fixture>` under `CEZ_DRY_RUN=1` prints `run
started / worktree ready / -- step: Gather the record` then **exits 0**, leaving
`.ai/cezar/runs.json` at `status: "running"` with no error — silent because the exit code
is 0. The handoff proved this pre-existing (reproduces at clean `a5f04b0f` and clean
`387ba439`, with a full `CEZ_*` env scrub) and floated one un-bisected hypothesis: commit
`097d1b15` ("default ALL run paths to spec-to-deploy") means the e2e's `mock:done`
invocation now drives the real 8-step `spec-to-deploy` workflow instead of a dedicated
mock workflow.

## The central finding: this looks like the same defect a different task already fixed and shipped

`cez kb search "run-broker"` surfaces two documents that describe **the same symptom** —
same test, same command, same "stalls after `Gather the record`, exits 0, `runs.json`
never reaches a terminal status" signature:

- `specs-7864d0810713` = `.ai/specs/briefs/2026-08-22-run-broker-cli-stall.md` — a
  gather-the-record brief written **for a different task, `d92e6b85`**, tracing the exact
  same `npm run test:package` case 5 failure to root cause by direct code reading.
- `specs-72b289500380` = `.ai/specs/2026-08-22-run-broker-cli-keepalive.md` — the spec that
  followed it. **Status line: "IMPLEMENTED, TESTED and SHIPPED 2026-08-22."** Shipped as
  commit `3e6d1b7e` ("fix: keep a one-shot brokered run's interval ref'd so the process
  outlives the session"), pushed to `origin/main`. The spec records `npm run test:package`
  going from **1/15 red → 15/15 green** as part of its own verification, plus 4 new unit
  tests in `brokered-session.test.ts`.

Root cause as documented there (not re-derived here, cited for the next step to check
rather than re-diagnose): `packages/cezar/src/core/brokered-session.ts:96-100` arms the
spool-tailing poll timer as an **unref'd** `setInterval` with no comment justifying it
(every sibling `unref()` in the codebase has one). `spawnBroker`
(`claude-cli-runner.ts:375-434`) correctly `unref()`s the detached broker child. The first
`ctl.sock` connect races the broker's own `server.listen()` and fails fast (ordinary
startup race) — at that instant *every* handle left in the one-shot CLI process is unref'd
or gone, so Node drains the event loop and exits 0 via the default code path, never through
the run's real success/failure branch, regardless of the still-pending `session.result`
promise. This is invisible on the `cezar serve` path only because that process holds its
own unrelated ref'd HTTP listener (`server/server.ts:7149`). The fix (P1: stop unref'ing
the poll timer; P2: make the existing but inert "give up after 100 poll attempts" branch in
`pumpPending` actually reject `session.result` instead of just going silent) is scoped
entirely to `brokered-session.ts` plus one call-site edit in `claude-cli-runner.ts`.

**Git evidence gathered this step, not assumed from the KB write-up:**

- `git merge-base --is-ancestor 3e6d1b7e HEAD` → **true**. Commit `3e6d1b7e` is already in
  this worktree's (`cez/9bf5030d`) ancestry — visible directly in `git log --oneline -25`
  a few commits below `HEAD` (`c73c8a2d`), alongside `351626f5` ("docs: mark the run-broker
  CLI keepalive spec implemented, shipped and verified").
- `git rev-parse main HEAD` both resolve to `c73c8a2d` — the local `main` ref already
  includes the fix. `origin/main` is stale at `0acf886e` (an earlier commit, unrelated to
  this defect) — a fetch lag, not evidence the fix is unshipped.
- Working tree is clean (`git status` → "nothing to commit, working tree clean").

**So the specific mechanism described in this task's handoff appears to already be fixed
in the exact code this worktree is branched from.** Task 9bf5030d's handoff context (dated
from the 2026-08-21 gate run of task `737eba99`) was almost certainly written *before*
`3e6d1b7e` landed later on 2026-08-22, and this task was never told the fix shipped in the
interim from a sibling task. This is very likely a duplicate filed against a stale
snapshot — **not confirmed**, because this step deliberately did not run
`npm run test:package` (read-only gather step; global instruction is "don't build or run
anything without asking", and running the full pack/install/e2e cycle is exactly that).

## The `097d1b15` hypothesis in the handoff — confirmed as fact, but appears orthogonal to the exit-0 bug

Verified directly (not from the KB): `mock:done` is not a workflow name. It is task-prompt
text. `packages/cezar/scripts/mock-claude.mjs:82`: `userText.includes('mock:done')` appends
`CEZ:DONE` to the mock's reply. `packages/cezar/test/e2e/package-cli.test.ts:80` calls
`cliPath, 'run', 'mock:done', '--repo', fixtureRepo` with **no `--workflow` flag** — so the
run takes whatever `run`'s default is, which `index.ts:105` states is `spec-to-deploy`
(and commit `097d1b15`, per the handoff and per `AGENTS.md`'s "Changing a mechanism that
already works" section, made that the default for *every* run path, not just the cockpit).
`spec-to-deploy`'s step 1 is literally named "Gather the record"
(`packages/cezar/src/workflows/types.ts:587` doc comment: "gather the record → write the
…") — matching the exact stalled step in the handoff's repro output. So: yes, the e2e now
drives the real 8-step workflow rather than a single-step mock, exactly as hypothesized.
Whether that shape change is itself a problem (e.g. whether `CEZ:DONE` appended to a
non-final step's turn is correctly *not* treated as run-done, per the multi-step chain
guard at `packages/cezar/src/workflows/run.ts:138-170` and the `#410`/`#367` history
`AGENTS.md` documents) is a **separate, already-decided-correct behavior** — a mid-chain
`CEZ:DONE` is supposed to advance to the next step, not end the run early — not a new bug
to fix. The KB-documented root cause (the unref'd poll timer) is unrelated to which
workflow runs; it fires on the very first agent turn regardless of chain length.

## What the record already decided (citations)

- `specs-72b289500380` / `.ai/specs/2026-08-22-run-broker-cli-keepalive.md` — the fix spec,
  status IMPLEMENTED/SHIPPED, commit `3e6d1b7e`.
- `specs-7864d0810713` / `.ai/specs/briefs/2026-08-22-run-broker-cli-stall.md` — the
  original discovery brief for task `d92e6b85`, superseded by the spec above.
- `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md` (`specs-594acc539b36`) — origin
  spec for the detached run-broker mechanism (P4, commit `954c6a55`); its Verification
  section only ever covered the server/cockpit restart-survival scenario, never the
  one-shot CLI — the gap the keepalive spec closed.
- `AGENTS.md` § "Changing a mechanism that already works" — names `097d1b15` explicitly as
  the commit that changed the *shape* of every run's default workload and says two
  separate P0s traced back to it; this task's own handoff hypothesis fits that pattern
  precisely.
- Canonical todo `c895a348-4bee-4a81-89ab-a62788a6a118` (referenced by the brief above,
  already folded in two duplicate todos) stated acceptance criteria near-identical to this
  task's — "the parent no longer exits 0 while the broker and backend are still alive; if
  it must give up it fails loudly with a non-zero exit" — and is recorded as already
  attached to task `d92e6b85`, not this one. **This task's own todo file was not found**:
  `.ai/cezar/todos.json` does not exist in this worktree (only `runs.json` does), so no
  local todo cross-reference could be checked directly.

## Code actually involved

- `packages/cezar/src/core/brokered-session.ts` — poll timer + unref (`:96-100`),
  `pumpPending`/`dispatch` (`:175-210`), `finish()` (`:147-162`) — the fix already landed
  here per `3e6d1b7e`.
- `packages/cezar/src/core/claude-cli-runner.ts` — `spawnBroker`/`attachBroker`
  (`:375-547`); threads `mode.spawnFailed` per the shipped fix.
- `packages/cezar/src/core/run-broker.ts`, `broker-client.ts`, `broker-launch.ts` — broker
  lifecycle, `ctl.sock`, `CEZ_RUN_BROKER` gating — untouched by the shipped fix, cited by
  the spec as out of scope.
- `packages/cezar/src/index.ts:889-986` — one-shot `run` command's exit-code convention
  (`process.exitCode = final === 'done' || 'review' ? 0 : 1`), default workflow name at
  `:105`.
- `packages/cezar/test/e2e/package-cli.test.ts:14-121` — the regression gate itself (case
  5 is the assertion this task must turn green; case 6, `:118`, is a second `mock:done`
  invocation in the same test that must also stay covered).
- `packages/cezar/scripts/mock-claude.mjs:80-99` — `mock:*` marker vocabulary in task text.
- `packages/cezar/src/workflows/run.ts:138-170, 3240-3510` — the `CEZ:DONE` chain-position
  guard (mid-chain `CEZ:DONE` ≠ run done).

## Duplicate / in-flight work check

`git worktree list` shows 14 other active task worktrees. None inspected here for
uncommitted diffs (out of scope for a targeted duplicate check — would need per-worktree
`git status`), but every one's `HEAD` is a normal commit on the shared history, and none of
the KB search results (`run-broker`, `spec-to-deploy`) name a currently-open task other
than the already-shipped `d92e6b85`. No evidence of a second in-flight fix to
`brokered-session.ts` et al.

## Open questions a spec will have to settle

1. **Verify, don't re-diagnose.** The very first thing the next step should do is actually
   run `npm run test:package` (and ideally the two-line manual repro from the handoff)
   *on this worktree* to get a real, current pass/fail count — this step deliberately did
   not, per the no-build/no-run instruction for a read-only gather step. If it's 15/15
   green already, this task's real content shrinks to: confirm, document the duplicate
   finding, and close — no code change.
2. **If still red**, is it the same unref'd-handle mechanism recurring (e.g. a regression
   reintroduced after `3e6d1b7e`, or a second unref'd handle the P1/P2 fix didn't cover —
   the keepalive spec explicitly named `reattachSession`'s never-populated `pending` queue,
   used by the server boot re-attach sweep, as a *distinct*, not-yet-closed gap), or is it
   a genuinely new failure mode introduced by something after `351626f5`?
3. **AC1 ("git bisect names the commit that turned test:package case 5 red")** — the
   shipped spec identified root cause by direct code reading, not by running `git bisect`.
   If test:package is confirmed already green, does this criterion still need a literal
   bisect run for the historical record, or is citing `3e6d1b7e` (and the brief that traced
   it) sufficient evidence of "which commit turned it red / which fixed it"? Worth deciding
   explicitly rather than mechanically bisecting a question the record already answers.
4. **What does closing this task look like** if it turns out to be a pure duplicate: a
   docs-only commit noting task 9bf5030d's handoff predated task `d92e6b85`'s shipped fix,
   plus fresh verification numbers? Or does standing repo convention (one spec per defect)
   call for folding a short verification note into the existing
   `2026-08-22-run-broker-cli-keepalive.md` spec instead of writing a new one?

## Not found

No indexed KB document describes this task (`9bf5030d`) itself — it exists only in this
task's own handoff. No local `.ai/cezar/todos.json` in this worktree to cross-check a
todo row against. Did not check sibling worktrees' uncommitted diffs.

---

**Brief path:** `.ai/specs/briefs/2026-08-22-headless-run-exits-0-mid-workflow.md`

**The facts that most constrain the design:**

1. `git merge-base --is-ancestor 3e6d1b7e HEAD` is **true** in this worktree — the fix spec
   `.ai/specs/2026-08-22-run-broker-cli-keepalive.md` (status: IMPLEMENTED/SHIPPED,
   verified `npm run test:package` 15/15) for what reads as the *identical* symptom (same
   test, same command, same "stalls after Gather the record, exits 0, runs.json stuck at
   running" signature) is already in this branch's history, shipped from a different task
   (`d92e6b85`) on the same day this task's handoff was written from.
2. This step did not run `npm run test:package` itself (read-only gather step, global
   no-build/no-run-without-asking instruction) — so "is it still red on this worktree" is
   confirmed-unconfirmed, not confirmed-fixed. The very next action should be running it
   for real numbers before writing any new fix code.
3. The handoff's `097d1b15` hypothesis (mock:done now drives the real 8-step
   `spec-to-deploy` instead of a mock workflow) is confirmed true by direct code reading,
   but is a separate, already-correct-by-design behavior change — not itself the cause of
   the exit-0 bug, which is unref'd-handle related and fires on the very first agent turn
   regardless of workflow shape.
4. If re-confirmed red, root cause and fix shape are already fully documented in
   `packages/cezar/src/core/brokered-session.ts:96-100` (poll-timer unref) and
   `:175-210`/`:196-202` (`pumpPending`'s inert give-up branch) — re-reading those first is
   strictly cheaper than re-deriving them.
