# Headless `cez run` exit-0-mid-workflow (task 9bf5030d): bisect the regression and close the duplicate

**Status: PARTIAL, documentation-only duplicate closure as of 2026-08-24.** The runtime defect is
implemented, tested, and shipped by the sibling task's commit `3e6d1b7e`, but this task's separate
formal-bisect and authoritative current-main rerun acceptance criteria remain unverified. No
application code change belongs to this task. The defect task
9bf5030d's handoff describes was already fixed, on this same branch, by commit `3e6d1b7e`
("fix: keep a one-shot brokered run's interval ref'd so the process outlives the session"),
shipped from a different task (`d92e6b85`) via `.ai/specs/2026-08-22-run-broker-cli-keepalive.md`
(status: IMPLEMENTED/SHIPPED). `git merge-base --is-ancestor 3e6d1b7e HEAD` is true on
`cez/9bf5030d`; local `main` and `HEAD` both resolve to `c73c8a2d`. This spec's job is to close
task 9bf5030d's own three acceptance criteria on the record — one of which (AC1, a `git bisect`
result) the shipping task never produced, because it root-caused by direct code reading instead —
and to correct one specific fact the shipping task's own spec did not need and therefore never
established: **which commit made the bug reachable in the first place.** It was not the commit
the handoff's own hypothesis named.

## TLDR

Measurements taken on this worktree during this step (`cez/9bf5030d`, `HEAD c73c8a2d`, same commit
as local `main`) are **indicative, not authoritative**: this worktree's `node_modules` is empty
(`ls node_modules | wc -l` → `0`, no `.bin`, no `typescript`/`vite`/`vitest`/`tsx`), so every
command below resolved upward into the parent checkout's `node_modules`
(`/var/lib/cezar/loki-labs/cezar/node_modules`, 28 `.bin` entries) instead of a real in-worktree
install — precisely the trap `AGENTS.md:288-300` documents by name: "Node resolves upward out of
the worktree and finds the parent checkout's complete `node_modules` … so `npm test` starts,
prints a normal vitest banner and returns a real-looking result." A pre-flight `ls
node_modules/.bin | wc -l` (the check `AGENTS.md` itself prescribes) would have caught this before
these numbers were treated as an AC record.

- `npm run build:server && npm run build:web` (both required — `test:package` needs the tarball to
  contain `web/dist/index.html`; a server-only build makes case 5 fail on that assertion for a
  reason that has nothing to do with this bug, a trap this step fell into and is naming so a later
  step doesn't repeat it) followed by `npm run test:package -w @loki-labs/better-cezar`:
  **15/15 pass**, including case 5 ("the release tarball installs and runs the dry-run CLI
  workflow"), the exact case the handoff reported red — against the parent checkout's dependency
  tree, not a real in-worktree install.
- `npm run test -w @loki-labs/better-cezar` (the repo's own gate — never `npx vitest`, which
  `AGENTS.md:283-286` forbids for fetching an unpinned vitest off the registry instead of fixing a
  missing local install): **9/9 pass** on `brokered-session.test.ts`, including the P1 (ref state)
  and P2 (give-up rejection, `spawnFailed` precedence) cases the keepalive spec added — again
  against the parent checkout's tree, pending re-run after a real in-tree install.
- Code read confirms both fix pieces are present exactly as the keepalive spec describes:
  `brokered-session.ts:106-110` — the poll timer is ref'd, with the "why" comment; `:208-215` —
  the exhausted-retry branch calls `giveUp()`, which (`:233-239`) rejects `result` instead of
  going silent.

**AC2 and AC3 read as true against this indicative run, but the record is not yet established**:
it needs a re-run after a real in-tree install and, for AC2, a measurement taken on `main` after
merging `origin/main` (Phase 2 gives the exact recipe) before either acceptance criterion can be
marked satisfied. What is left is that re-run, AC1 (a literal bisect result), and closing the loop
on the record so the next reader of either task doesn't re-diagnose a defect that is already
fixed.

**AC1's answer, found by direct commit-content diff (cheaper and more precise than an N-commit
`git bisect run` here, since the candidate range turned out to be one file's single atomic
change):** the commit that made this bug *reachable* is **not** `097d1b15` ("default ALL run
paths to spec-to-deploy", 2026-08-20 09:53), which the handoff floated as a hypothesis and this
spec confirms is real but orthogonal. It is **`954c6a55`** ("feat: a run now outlives the cockpit
that started it", 2026-08-21 14:41 — one day later). Proof: `git show 954c6a55^:packages/cezar/
src/core/claude-cli-runner.ts | grep -c broker` → `0`; `git show 954c6a55:packages/cezar/src/core/
claude-cli-runner.ts | grep -n broker` → the `spawnBroker` import and the `if (opts.broker) { ...
spawnBroker(...) }` call in `startSession`. Before `954c6a55`, `ClaudeCliRunner.startSession`
never constructed a `BrokeredSession` at all for a real run — the class existed (added one commit
and 111 minutes earlier, in `3f4e9c33`, "feat: the machinery for a deploy that does not kill what
it is deploying", 2026-08-21 12:50, already carrying the unref'd timer that is the actual bug) but
nothing called it. `954c6a55` is the commit that wires `spawnBroker`/`BrokeredSession` into
`startSession`, which is the precondition for the unref'd-timer bug to be reachable through
`cezar run` at all. Phase 1 below runs a real `git bisect` to put this on the record formally, but
the direct diff already settles it: `954c6a55^` (`04be7d0b`) cannot exhibit this bug (no code path
constructs a `BrokeredSession` from a real run yet); `954c6a55` can, and does, in the exact 15/15→
1/15 shape the handoff describes.

**Why the `097d1b15` hypothesis is real but not the trigger.** Verified directly (not re-derived
here — this is the same reading task `9bf5030d`'s own gather-the-record step already did):
`097d1b15` made `spec-to-deploy` (whose step 1 is literally named "Gather the record") the default
workflow for every `run` invocation, including the e2e's `mock:done` call, which passes no
`--workflow` flag (`packages/cezar/test/e2e/package-cli.test.ts:80`,
`packages/cezar/src/index.ts:105`). That explains *which step name* the stall is reported at and
*why* a mid-chain `CEZ:DONE` correctly does not end the run early (the guard at
`packages/cezar/src/workflows/run.ts:138-170`, unrelated to this bug). It does not explain *why*
the process exits 0 mid-flight — that mechanism is unref'd-handle related and requires
`BrokeredSession` to be constructed for a real `cezar run` at all, which only became true a day
later, in `954c6a55`. Both commits are part of the same broader shift `AGENTS.md` § "Changing a
mechanism that already works" already names (`097d1b15` "made the six-step `spec-to-deploy` the
default for every run path" and produced two other P0s the same week) — this is a third instance
of the same pattern (a default-path shape change makes a latent branch reachable), but the shape
change that mattered here is the *brokering* wiring, not the *workflow* default.

## Problem

Task 9bf5030d's own handoff (`$CEZ_HANDOFF_FILE`) reports `npm run test:package` case 5 red on
main, reproduced by hand, with `.ai/cezar/runs.json` left at `status: "running"` and the process
exiting 0 — silent, because the exit code gives no signal anything is wrong. It is dated from the
2026-08-21 gate run of task `737eba99`, and floats one hypothesis (`097d1b15`) for why the e2e now
drives the full `spec-to-deploy` chain instead of a single-step mock.

This task's own gather-the-record step (brief:
`.ai/specs/briefs/2026-08-22-headless-run-exits-0-mid-workflow.md`) found that a KB search
(`cez kb search "run-broker"`) surfaces two documents describing the identical symptom — same
test, same command, same stall-after-"Gather the record"-exit-0-`runs.json`-stuck-`running`
signature — for a **different** task, `d92e6b85`:

- `.ai/specs/briefs/2026-08-22-run-broker-cli-stall.md` — that task's own gather-the-record brief,
  which root-caused the bug by direct code reading (not `git bisect`): the poll timer in
  `BrokeredSession`'s constructor was `.unref()`'d with no comment, unlike every sibling unref'd
  timer in the codebase; the moment the seeded first send's control-socket connect fails fast
  (an ordinary startup race — the broker hasn't called `server.listen()` yet), every handle left
  in the one-shot CLI process is unref'd or gone, and Node drains the event loop and exits 0,
  never through the run's real success/failure branch.
- `.ai/specs/2026-08-22-run-broker-cli-keepalive.md` — the fix spec that followed it. **Status
  line: "IMPLEMENTED, TESTED and SHIPPED 2026-08-22."** Shipped as `3e6d1b7e`, pushed to
  `origin/main`. Its own verification recorded `npm run test:package` going 1/15 → 15/15, plus 4
  new unit tests in `brokered-session.test.ts` (9/9 total).

The gather step confirmed by direct `git` inspection (not from the KB write-up) that `3e6d1b7e` is
already an ancestor of this worktree's `HEAD` (`cez/9bf5030d`, `c73c8a2d`) — i.e., this task's own
branch already contains the fix task `d92e6b85` shipped, for what reads as the identical defect.
The gather step deliberately did not run `npm run test:package` itself (a read-only step, and this
repo's global instruction is "don't build or run anything without asking"), so it left "is this
task's own reproduction still red" as an open, unconfirmed question — explicitly flagged as "the
very next action" for whoever picks this up next.

**This step ran it, but against the parent checkout's dependency tree** (see TLDR — this
worktree's own `node_modules` is empty). 15/15 and 9/9 green, plus a code read confirming the
shipped mechanism is present, are strong indicative evidence but not yet the AC2/AC3 record — that
needs one more re-run, after a real in-tree install and (for AC2) a merge of `origin/main`, per
Phase 2. What the indicative run already confirms: task 9bf5030d's handoff was written against a
snapshot of `main` that predates `3e6d1b7e`, and never learned the sibling task's fix landed in
the interim. This reads as a duplicate, already resolved — not a live defect requiring a new fix —
pending that confirming re-run.

What remains is closing task 9bf5030d's own three acceptance criteria honestly:

- **AC1** ("git bisect names the commit that turned test:package case 5 red") — not yet satisfied
  by anything either task has done; the keepalive spec root-caused by reading, not bisecting.
  Answered above by direct commit-diff (a de facto one-step bisect, since the candidate range
  collapsed to a single atomic wiring change) and formalized as an actual `git bisect run` in
  Phase 1.
- **AC2** ("npm run test:package is 15/15 green on main") — reads green on this step's indicative
  run, but not yet established as the record: `HEAD`/`main` (`c73c8a2d`) is 14 commits behind
  `origin/main`, and the run resolved into the parent checkout's `node_modules` rather than a real
  in-worktree install (see TLDR). Phase 2 below gives the scrubbed, in-tree, post-merge recipe (the
  `build:server && build:web` requirement is not obvious from `test:package`'s own script and
  tripped this step up once) that produces the authoritative number.
- **AC3** ("headless `cez run` never exits 0 while its run record is still 'running'") — reads as
  satisfied by the already-shipped P1 (ref'd timer, `brokered-session.ts:106-110`) + P2 (`giveUp`,
  `:208-215`/`:233-239`) mechanism against this step's indicative test run; pending the same
  authoritative re-run as AC2. As literally written, AC3 is in fact fully closed by the ref'd timer
  alone — a session with nothing ever queued can now only *hang*, not exit 0 — which is why the
  Risks section's `reattachSession`/unseeded-session gap is correctly left out of scope rather than
  treated as a live AC3 gap.

## Solution

No code change. Three closing actions:

1. **Run a real `git bisect`** between the handoff's own measured-bad commit (`387ba439`) and a
   good commit at or before `3f4e9c33`, to put AC1's answer on the record as an actual bisect
   result rather than only a direct-diff argument — the direct diff already gives high confidence
   in the outcome, but the acceptance criterion asks for the bisect specifically, and it is cheap
   here (`git rev-list --count 3f4e9c33..387ba439` → 29 commits, all from 2026-08-21, so roughly
   `log2(29)` ≈ 5 automated probes once the endpoints are measured — see Phase 1).
2. **Re-run and document `npm run test:package` on `main` proper**, with the correct two-step build
   recipe, as the AC2 record — an indicative run was done once this step (see TLDR), but the
   authoritative record still needs a real in-tree install and a measurement taken after merging
   `origin/main` (Phase 2 gives the exact scrubbed recipe). Phase 2 is also about writing the
   recipe down somewhere a gate run will find it, since `test:package`'s own npm script does not
   build for you and the missing-`web/dist` failure mode looks nothing like this bug (a
   `web/dist/index.html` assertion failure, not a stall) but is easy to misdiagnose as a recurrence
   if whoever runs it next doesn't know to build both halves first.
3. **Mark the record straight**: add a short, dated note to
   `.ai/specs/2026-08-22-run-broker-cli-keepalive.md` (the correction convention this repo's
   `CLAUDE.md` and workspace `CLAUDE.md` both specify: mark what a correction invalidates, in
   place, rather than only appending) recording that (a) task `9bf5030d` independently reproduced
   this defect from a stale handoff snapshot and independently re-verified the fix on a separate
   branch/worktree, and (b) the precise commit that made the bug reachable is `954c6a55`, not
   named by hash in that spec's own Root cause section (which correctly explains the *mechanism*
   but never had to pin down *which commit first wired brokering into a real run*, since knowing
   that wasn't necessary to fix it). This is additive confirmation, not a correction of anything
   the keepalive spec got wrong — nothing there is false, it simply never answered this specific
   question because nothing required it to.

### Why not re-run the P1/P2 code changes or add new tests

There is nothing to change. `brokered-session.ts:106-110` and `:208-215`/`:233-239` already match
the keepalive spec's Solution section verbatim, confirmed by this step's own read (see TLDR).
Re-implementing an already-shipped fix would either be a no-op diff or, worse, risk silently
reverting or duplicating it. The existing unit tests (`brokered-session.test.ts`, 9/9 green this
step) already cover both P1 (timer ref state) and P2 (give-up rejection, `spawnFailed`
precedence) at the mechanism level; nothing this task's acceptance criteria ask for needs new
coverage.

## Architecture

Unchanged. No component boundaries move — this task touches no runtime code. The only artifacts
are: a `git bisect` session (transient, not committed — `git bisect reset` when done), and a
documentation amendment to one existing spec file.

## Data models

None.

## API / interface contracts

None.

## Phases

### P1 — Formal `git bisect` for the AC1 record

Run in a **disposable worktree**, not this task's own (`cez/9bf5030d` has an in-flight,
uncommitted spec-writing session on it; bisecting would move `HEAD` around and risk disturbing
that state).

**Endpoints must be measured, not asserted.** The handoff already reproduced the bug by hand,
under a full `CEZ_*` scrub, at two clean commits — `387ba439` and `a5f04b0f` — so use one of those
as the *measured* bad, not `954c6a55` (which this spec reached by direct diff reading, not by
running the predicate). The good side needs one real run of the predicate at `3f4e9c33`: `git
bisect run` never executes the script on revisions marked good/bad by hand, so if `3f4e9c33` is
asserted good without actually running it, the range the automated walk searches could be wrong
even if the final answer happens to still land right.

```bash
git worktree add /tmp/cezar-bisect-9bf5030d 387ba439   # measured bad, per the handoff's own repro
cd /tmp/cezar-bisect-9bf5030d

scrub=$(env | sed -n 's/^\(CEZ_[A-Z0-9_]*\)=.*/\1/p' \
        | grep -vxE 'CEZ_(HANDOFF_FILE|TASK_ID)' | sed 's/^/-u /')
tmp=/tmp/cez-gate-$$ && mkdir -p $tmp

# 1. establish the bad endpoint (already known from the handoff's manual repro; re-confirm here)
git bisect start
git bisect bad 387ba439

# 2. run the predicate ONCE, by hand, at the candidate good commit before trusting it as one —
#    scoped to case 5 alone (packages/cezar/test/e2e/package-cli.test.ts), not the full 15-test
#    test:package suite, so an unrelated red in one of the other 4 e2e files never gets recorded
#    as "bad" for the wrong reason
git checkout 3f4e9c33
env -u NODE_ENV $scrub TMPDIR=$tmp TMP=$tmp TEMP=$tmp npm ci --no-audit --no-fund \
  && env -u NODE_ENV $scrub TMPDIR=$tmp TMP=$tmp TEMP=$tmp npm run build:server \
  && env -u NODE_ENV $scrub TMPDIR=$tmp TMP=$tmp TEMP=$tmp npm run build:web \
  && (cd packages/cezar && env -u NODE_ENV $scrub TMPDIR=$tmp TMP=$tmp TEMP=$tmp \
        node --import tsx --test test/e2e/package-cli.test.ts)
# only if that actually exits 0:
git bisect good 3f4e9c33
# if it does NOT exit 0 — brokered-session.ts existing at this commit doesn't guarantee the e2e
# passes for an unrelated reason — fall back one commit and re-check the same way:
#   git checkout 3f4e9c33^ && <same predicate> && git bisect good 3f4e9c33^

# 3. hand off to the automated walk over the now-measured range
git checkout -   # back to bisect's own HEAD before `git bisect run` takes over
git bisect run bash -c '
  scrub=$(env | sed -n "s/^\(CEZ_[A-Z0-9_]*\)=.*/\1/p" \
          | grep -vxE "CEZ_(HANDOFF_FILE|TASK_ID)" | sed "s/^/-u /")
  tmp=/tmp/cez-gate-$$ && mkdir -p $tmp
  env -u NODE_ENV $scrub TMPDIR=$tmp TMP=$tmp TEMP=$tmp npm ci --no-audit --no-fund || exit 125
  env -u NODE_ENV $scrub TMPDIR=$tmp TMP=$tmp TEMP=$tmp npm run build:server || exit 125
  env -u NODE_ENV $scrub TMPDIR=$tmp TMP=$tmp TEMP=$tmp npm run build:web || exit 125
  cd packages/cezar &&
  env -u NODE_ENV $scrub TMPDIR=$tmp TMP=$tmp TEMP=$tmp \
    node --import tsx --test test/e2e/package-cli.test.ts
'
git bisect log      # record the transcript
git bisect reset
cd / && git worktree remove /tmp/cezar-bisect-9bf5030d
```

Scoping the predicate to case 5 alone, rather than the whole `test:package` script, and using the
`AGENTS.md:271-274` scrub with an out-of-repo `TMPDIR` on every probe, are both load-bearing, not
stylistic: per `AGENTS.md:278-286`, ambient `NODE_ENV=production` makes `npm ci` install zero
devDependencies, so an un-scrubbed probe fails the *install* step at every candidate commit for a
reason that has nothing to do with this bug — the same class of false-red `1c225e7e` (on
`origin/main`, not yet in this branch; see Risks/P2) exists to fix. The `|| exit 125` on every
install/build step is what lets `git bisect run` tell "the bug reproduced" apart from "the build
broke for an unrelated reason": exit 125 means `git bisect skip`, any other non-zero means a
genuine case-5 failure.

Expected result, per the direct diff already performed this step (Problem/TLDR): bisect converges
on `954c6a55`. The searched range is `3f4e9c33..387ba439` (`git rev-list --count
3f4e9c33..387ba439` → 29 commits), so `git bisect run` should take roughly `log2(29)` ≈ 5 probes —
wider than the single-commit range an earlier draft of this spec assumed, because the measured bad
endpoint (`387ba439`) sits well after `954c6a55` itself, not at it.

If the bisect result disagrees with `954c6a55` (contingency, not expected): stop and re-diagnose
from `packages/cezar/src/core/brokered-session.ts` and `claude-cli-runner.ts` at the commit it
actually names, rather than forcing the result to match this spec's prediction.

### P2 — Re-state the AC2 record with the correct recipe

An indicative run was already done once this step (TLDR), but only against the parent checkout's
`node_modules` (this worktree's own install is empty) and only on local `main`/`HEAD`
(`c73c8a2d`), which is **not** the same commit as `origin/main`. The authoritative AC2 record still
needs both a real in-tree install and a measurement taken after merging `origin/main`:

```bash
scrub=$(env | sed -n 's/^\(CEZ_[A-Z0-9_]*\)=.*/\1/p' \
        | grep -vxE 'CEZ_(HANDOFF_FILE|TASK_ID)' | sed 's/^/-u /')
tmp=/tmp/cez-gate-$$ && mkdir -p $tmp
env -u NODE_ENV $scrub TMPDIR=$tmp TMP=$tmp TEMP=$tmp npm ci
npm run build:server && npm run build:web   # NOT just `npm run build -w @loki-labs/better-cezar`
                                              # — that alone leaves web/dist missing and fails
                                              # case 5 on an unrelated assertion
                                              # ("release tarball should contain web/dist/index.html")
                                              # that looks nothing like the exit-0 bug and is easy
                                              # to misdiagnose as a recurrence of it.
npm run test:package -w @loki-labs/better-cezar
```

`origin/main` is not behind local `main` — it is **14 commits ahead** (`git rev-parse origin/main`
→ `0acf886e`, dated 2026-08-22 05:23; local `main`/`HEAD` → `c73c8a2d`, dated 02:04;
`git rev-list --count HEAD..origin/main` → 14, `origin/main..HEAD` → 0). So this step's "on main"
measurement was **not** taken on `main` in the sense that matters for a durable record: this
branch must merge `origin/main` before this spec's own commit lands, per this repo's own
convention (`6fdbe35e`, `80d208c3`, `c17ae1d5`: "merge: origin/main (…) into cez/… before
landing"). This matters concretely, not just procedurally — `origin/main` carries `1c225e7e`
("fix: npm test gate scrubs its own environment instead of lying red") and `18707bf1`, neither of
which is in `c73c8a2d`, and `1c225e7e` changes exactly the harness behaviour these AC2/AC3
measurements depend on. The AC2 record is the number from that post-merge, scrubbed, in-tree
run — not the indicative number in this spec's TLDR.

### P3 — Mark the record straight (documentation only)

Append a short, dated note to `.ai/specs/2026-08-22-run-broker-cli-keepalive.md`, near its status
line or Root cause section (whichever this repo's convention favors when re-reading that file
at implementation time — it currently has no "corrections" subsection to slot into, so a new
short paragraph after the status line is likely the right shape, per `CLAUDE.md`: "amend the
heading when the falsehood is in the heading... otherwise a bolded lead-in in the body, with
the original text left below it unchanged"). Content: task `9bf5030d` independently reproduced
this exact symptom from a handoff snapshot predating `3e6d1b7e`, independently re-verified the fix
(15/15 `test:package`, 9/9 `brokered-session.test.ts`, both freshly run) on a separate
branch/worktree, and pinned the precise commit that made the bug reachable through a real
`cezar run` as `954c6a55` (`git bisect`, this spec's Phase 1) — a fact the original spec never
needed to establish for its own fix to be correct, but worth recording once known, so a third
report of the same symptom finds the answer immediately instead of re-deriving it a third time.

Also record the durable finding — task `9bf5030d` is a confirmed duplicate of `d92e6b85`, and
`954c6a55` is the commit that made the brokered exit-0 path reachable — as an NDJSON `upsert`
proposal appended to `$CEZ_KB_WRITE_FILE`, `scope: "project"`, per this repo's KB-write contract
(each line needs its own `seq`, `runId` = `CEZ_TASK_ID`, `createdAt`). That is the documented, live
mechanism for putting a decision where the next session reads it, and it is the one thing that
stops a third report of this same symptom; a proposal there is reviewed and applied later, never
automatically. File any genuine follow-up this spec leaves out of scope (the
`reattachSession`/unseeded-session gap named in Risks) with `cezar todo add`, not by editing this
spec further. Before any of this spec's own edits land as a commit, merge `origin/main` into this
branch first — per the repo convention named in Risks/P2 (`6fdbe35e`, `80d208c3`, `c17ae1d5`) —
since `origin/main` carries harness-affecting commits (`1c225e7e`, `18707bf1`) not yet in
`c73c8a2d`.

## Risks

- **The bisect script's `npm ci` at each candidate commit is the slow, fragile part** — a lockfile
  or Node-version mismatch on an older commit could make the build itself unreliable independent
  of this bug. Mitigated by the narrow range (29 commits, all from 2026-08-21) and by using
  `git bisect skip` (via the predicate's `|| exit 125`) rather than letting an unrelated build
  failure get recorded as "bad" (see P1).
- **`origin/main` is 14 commits AHEAD of local `main`/`HEAD`, not behind** — measured this step
  (`git rev-parse origin/main` → `0acf886e`; `git rev-list --count HEAD..origin/main` → 14;
  `origin/main..HEAD` → 0; `git merge-base --is-ancestor HEAD origin/main` → true). AC2's "on main"
  was therefore **not** measured on `main` — it was measured on a commit strictly behind it. The
  branch must merge `origin/main` before this spec's commit lands (P2), and that merge is not
  cosmetic: `origin/main` carries `1c225e7e` ("npm test gate scrubs its own environment instead of
  lying red") and `18707bf1`, neither in `c73c8a2d`, and `1c225e7e` changes exactly the harness
  behaviour these measurements depend on.
- **This spec's Phase 3 documentation edit touches a file another in-flight task might also be
  editing** (the keepalive spec, or task `d92e6b85`'s own follow-up work, if any is still open).
  Low risk — that task's own status line already reads SHIPPED and its worktree's likely gone —
  but worth a `git log -1 -- .ai/specs/2026-08-22-run-broker-cli-keepalive.md` check immediately
  before editing it, in case something landed there since this spec was written.
- **None of this closes the `reattachSession`/unseeded-session gap** the keepalive spec already
  named as a distinct, deliberately out-of-scope follow-up (a `BrokeredSession` with nothing ever
  queued to `pending` has no path into `giveUp` at all). Not in scope here either — task 9bf5030d's
  acceptance criteria describe the seeded-first-send path only, which is fully closed.

## Verification

1. **AC1** — `git bisect` transcript (Phase 1) names `954c6a55` as first-bad. Cross-check against
   this spec's direct-diff proof (`git show 954c6a55^:packages/cezar/src/core/claude-cli-runner.ts
   | grep -c broker` → `0`; same at `954c6a55` → non-zero, `spawnBroker`/`opts.broker` present).
2. **AC2** — the scrubbed, in-tree recipe from Phase 2 (`npm ci` under the full `CEZ_*` scrub, then
   `npm run build:server && npm run build:web && npm run test:package -w @loki-labs/better-cezar`)
   on `main`, after merging `origin/main`, exits 0 with `# pass 15` / `# fail 0` in the `node
   --test` TAP summary. This step's own run (TLDR) is indicative only — parent-checkout
   `node_modules`, pre-merge `main` — so treat it as a smoke check, not the AC2 measurement.
3. **AC3** — two independent proofs, both indicatively collected this step and reproducible:
   - `npm run test -w @loki-labs/better-cezar` (or root `npm test`) → `brokered-session.test.ts`
     `9 passed (9)`, including the P1 `hasRef()` assertion and the P2 give-up-rejects-`result` /
     `spawnFailed`-precedence cases. Run after the scrubbed, in-tree install (Phase 2) — never
     `npx vitest`, which `AGENTS.md:283-286` forbids by name: "reaching for `npx vitest` when the
     local binary is missing 'makes it work' by fetching an unpinned vitest off the registry, which
     is exactly the silently-different run the rule above forbids. A missing local vitest is a
     signal to fix the install, never to route around it." The 9/9 figure recorded in this spec's
     TLDR is pending that re-run, not yet the AC3 record.
   - Direct manual repro of the exact scenario named in the handoff: build the CLI, then
     `CEZ_DRY_RUN=1 CEZ_HOME=<tmp> node <dist>/index.js run mock:done --repo <fixture>` — expect
     `run (done|review)` printed and `process.exitCode` 0 only alongside a terminal `runs.json`
     row, never before one. (The keepalive spec already ran this exact repro as its own AC2
     verification when it shipped; re-running it here is optional confirmation, not new ground —
     do it if time allows, skip it if P1/P2's e2e and unit results are already conclusive.)
4. **Gates** — `npm run typecheck`, `npm run lint`, `npm run test` should already be green (no
   code changed by this spec); confirm nothing in Phase 3's documentation edit breaks a markdown
   lint or link-check step this repo runs, if any.

## Sources read

- `$CEZ_HANDOFF_FILE` (task 9bf5030d's own handoff) — problem statement, acceptance criteria,
  prior progress log entries.
- `.ai/specs/briefs/2026-08-22-headless-run-exits-0-mid-workflow.md` — this task's own
  gather-the-record brief (required reading per this step's instructions); its citations followed
  and re-verified rather than trusted blind.
- `.ai/specs/2026-08-22-run-broker-cli-keepalive.md` (full file) — the shipped fix spec for the
  identical symptom, status IMPLEMENTED/SHIPPED, commit `3e6d1b7e`.
- `.ai/specs/briefs/2026-08-22-run-broker-cli-stall.md` (referenced, not re-read line-by-line this
  step — already fully digested and cited by the keepalive spec above).
- `packages/cezar/src/core/brokered-session.ts` (full file re-read this step, current line
  numbers: constructor/timer `:82-110`, `dispatch`/`pumpPending` `:187-221`, `giveUp` `:228-239`).
- `packages/cezar/src/index.ts` (`:95-115` default-workflow flag doc; `:960-986` `runCommand`'s
  terminal-status promise and exit-code convention — read fresh this step, unchanged from the
  keepalive spec's own citation of `:888-987`).
- `packages/cezar/test/e2e/package-cli.test.ts` (full file, 267 lines — confirms case 5's
  assertions, including the `web/dist/index.html` tarball-contents check at `:33-35` that this
  step's own incomplete-build mistake tripped on).
- `packages/cezar/package.json` (`test:package` script) and root `package.json` (`build`,
  `build:server`, `build:web` scripts) — read to find the correct build recipe after the first,
  server-only build produced 13 unrelated failures.
- `AGENTS.md` § "Changing a mechanism that already works" (`:30-85`) — the `097d1b15` pattern this
  spec's TLDR distinguishes from `954c6a55`'s.
- `AGENTS.md:239-334` ("Run vitest through npm, never `npx vitest`" / the environment-scrub block /
  the parent-checkout `node_modules` trap) — read in response to review feedback; source for the
  scrub recipe used in P1/P2 and for the `npx vitest` prohibition.
- `git log`/`git show` on `954c6a55`, `3f4e9c33`, `097d1b15`, and the 5-commit range between
  `3f4e9c33` and `954c6a55` — direct commit-content diffs, this step, to establish the AC1 answer
  (see TLDR for the exact commands and their output).
- `git rev-parse`/`git rev-list --count`/`git merge-base --is-ancestor` on `HEAD`, `main`,
  `origin/main` (this step, in response to review feedback) — establishes `origin/main` is 14
  commits ahead of `HEAD`/`main`, not behind; `git log --oneline HEAD..origin/main` names
  `1c225e7e` and `18707bf1` among the missing commits.
- **Freshly executed this step** (not cited from any prior document): `npm run build:server`,
  `npm run build:web`, `npm run test:package -w @loki-labs/better-cezar` (twice — once
  server-build-only, red for unrelated reasons; once with both builds, 15/15 green); the
  `brokered-session.test.ts` suite (9/9 green), run via the repo's own `npm run test -w
  @loki-labs/better-cezar` gate, never `npx vitest` (forbidden by `AGENTS.md:283-286`). All of the
  above resolved into the parent checkout's `node_modules` — this worktree's own install is empty
  (`ls node_modules | wc -l` → `0`) — so these numbers are indicative, not the AC2/AC3 record; see
  TLDR and Phase 2. Logs retained in this worktree's `.ai/cezar/tmp/*-9bf5030d.log` for this
  session; not committed (scratch output).
- **Not found / not chased:** no indexed KB document treats `954c6a55` as the reachability-
  introducing commit (the keepalive spec's Root cause section explains the mechanism without
  pinning the wiring commit by hash) — this spec is the first place that connection is written
  down. `.ai/cezar/todos.json` still does not exist in this worktree; task-closure mechanics for
  Phase 3 are left to whatever the live tracker is at implementation time rather than guessed here.
