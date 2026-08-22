# `run-tests` output-token ceiling

**Status: partial (2026-08-22).** Phases 1-3 are implemented, committed and shipped —
commit `16eb7a24` (`feat: cap run-tests reasoning effort at medium, cut its output-token
burn`), merged to `origin/main` via `966a832b`. **Phase 4 (the live A/B token measurement
that would prove the fix moved the number) did NOT run.** `implement`'s second pass found
the on-disk Phase 4 mechanism (trigger a full run per arm, `POST /runs/:id/cancel`
immediately after `run-tests`'s own step-end) unsafe: the measured step-end-to-commit-push
gap is 1-4ms across all 11 sampled runs, unwinnable by any external cancel call, so both
arms — one of them carrying a deliberately-broken test — would reach a real `git push` and
a real `deploy` before the cancel could land. Running Phase 4 as written risked shipping a
broken build to production to collect a token count, which this workspace's standing
authorization for cezar-on-cezar does not cover implicitly (see AGENTS.md, "gates first,
fail closed"). Correctly not run rather than run unsafely. Follow-up filed as todo
`ef4f65f7-0621-41d2-ad33-b7bce4ac916d`: redesign Phase 4 around `POST /runs` with an inline
5-step `steps` array that terminates by construction at `run-tests` (no cancel race
possible), then run the A/B. Until that todo closes, **acceptance criterion 4 (tokens
measured below 20,000 on a comparable run) is unverified** — Phases 1-3 are a plausible,
cheap, reviewed fix, not a proven one. The below is kept as history for how Phases 1-3
were arrived at and reviewed; it previously read "revised" — corrected to "partial" now
that the run itself is complete and Phase 4's fate is settled.

<details>
<summary>Review history (Phases 1-3), kept for context</summary>

**Status:** revised (2026-08-22) — pass 4 `review-spec` (opus) returned **PASS**; pass 5
(same day, after Phases 1-3 landed) returned **REVISE** on three localized defects (D1-D3 below,
in revision item 10); pass 6 (same day) returned **REVISE** on one blocking defect confined to
Phase 4's Arm B mechanism plus a supporting base-branch gap (revision item 11); pass 7 (same day)
returned **REVISE** on one blocking defect (Phase 4 never stopped the two measurement runs short
of `commit-push`/`deploy`) plus two should-fix items (an unquantified "materially below" pass bar,
and `POST /runs` bodies missing the required `task` field) — all fixed here (revision item 12).
**Corrected 2026-08-22 (later same day) — Phases 1-3 HAVE
landed, in this working tree, uncommitted.** This line previously said "still pre-implementation —
no phase below has landed," true when it was written but stale the moment `implement` ran:
`--effort` is on `workflowStepSchema` (`types.ts:27`), `AgentRunSpec.effort` (`agent-runner.ts:65`),
`buildClaudeArgs` pushes it (`claude-cli-runner.ts:724-725`), `RUN_TESTS_STEP_EFFORT = 'medium'` is
set and wired to `run-tests` (`types.ts:545,774`), the diagnostic-depth stop clause and the "quote
verbatim" closing instruction are both in the `run-tests` prompt (`types.ts:818-819,830`), and unit
tests for all of it exist and were confirmed present directly in this pass
(`claude-cli-runner.test.ts:59-70`, `types.test.ts:178-180`). **Corrected 2026-08-22 (this pass) —
the file/insertion count was stale the moment the spec itself grew past the first read of it:**
`git diff --stat HEAD` now shows 9 files changed, 613 insertions (was 7 files / 364 insertions when
that line was written, before this file and its second brief were themselves counted as diff). What
has **not** happened: a commit, a push, a deploy, or Phase 4's fresh post-deploy measurement — those
remain correctly downstream of this step. Briefs:
`.ai/specs/briefs/2026-08-21-run-tests-output-tokens.md` (original gather),
`.ai/specs/briefs/2026-08-22-run-tests-output-tokens-revise.md` (re-gather after `review-spec`
returned REVISE — handoff progress log, 2026-08-21T23:01:20Z; see revision item 8 below — this
second brief re-derived the same three defects items 1-3 already fixed and found nothing new),
`.ai/specs/briefs/2026-08-22-run-tests-phase4-gather.md` (third gather pass, confirms Phases 1-3
sit uncommitted in this worktree and hands forward that Phase 4 has not started — read directly
for this revision; see revision item 11 below).

**Revision 2026-08-22 — ten items `review-spec` (opus) found across five review passes,
fixed here rather than deferred (items 1-9 fixed pre-implementation; item 10 fixed post-Phases-1-3):**

1. **CORRECTED 2026-08-22 (same revision, before landing) — `CLAUDE_EFFORT=high` is NOT ambient
   host env, and the CLI does not read it as input.** This item originally claimed
   `CLAUDE_EFFORT=high` "rides into every claude-backend child unconditionally" via
   `agent-env.ts:221-222`, evidenced by `env | grep CLAUDE` inside an agent's own Bash tool shell
   — evidence that cannot distinguish host inheritance from CLI injection. Process-tree evidence
   settles it: `/proc/<pid>/environ` for the cezar server process, the runner child, and the
   `claude` CLI process itself are all readable and carry ZERO `CLAUDE_*` variables; `CLAUDE_EFFORT`
   appears only in shells the CLI spawns for its own Bash tool, alongside `CLAUDE_PID` and
   `CLAUDECODE` — it is an OUTPUT the CLI exports to its children, not an input it reads. Four
   spawn probes on the pinned CLI (`claude 2.1.233`), each with every `CLAUDE_*` var scrubbed from
   the parent, confirm this directly: no flag → tool shell reports `high` (the CLI's own default);
   `--effort medium` → `medium`; `CLAUDE_EFFORT=low` + `--effort max` → `max`; and decisively,
   `CLAUDE_EFFORT=low` with **no** flag → `high`, unchanged — the CLI never reads the env var as
   input, so there is no ambient value to override and no flag/env precedence to arbitrate (the
   flag is the only signal that does anything). The second code path this item added — writing
   `step.effort` into the child's own `env.CLAUDE_EFFORT` alongside the `--effort` flag — addressed
   a mechanism that does not exist and is removed below; `buildClaudeArgs`'s `--effort` flag is the
   only lever. The same probes are also the source of a grounded baseline used in Solution §2 and
   Risks below: a cezar-spawned `run-tests` step with no `--effort` flag runs at `high` today, so
   `effort: 'medium'` is a measured one-notch reduction from the step's own current default, not a
   guess about an unknown one.
2. **Phase 4 step 4** ("deliberately break one test... confirm... the step does not report
   green") **contradicted `run-tests`'s own prompt**, which says "FIX the code and re-run until
   they pass" — a fixable regression going green *is* that instruction working. Redesigned below
   around what the acceptance criterion in the task brief actually asked for ("no gate silently
   passes... every real failure still surfaces... seeing it reported") — the break must be
   *detected and named in the transcript*, not that the step ends red.
3. **Phase 4's write-up step couldn't execute where it said** ("record in the `document` step's
   normal knowledge sync — no separate action needed"): `document` is step 7 and `deploy` is
   step 8 of the SAME run (`types.ts:859`, `types.ts:933`) — the verification run's own
   `document` step has no way to know it is the verification run for a different, earlier task's
   spec. Replaced with an explicit todo, named as Phase 4's own first action below, not deferred
   to "no action needed."
4. **Phase 4 step 4's detection check read a log path the prompt never mandates.** The prompt only
   shows `/tmp/gate-test.log` as an example for overlap discipline — it does not require that
   filename or a durable location, and per-run `TMPDIR` is redirected and cleaned (#785), so the
   verifier could find nothing to read on exactly the check that proves AC#4. Fixed below: the
   run's own `.ndjson` is now the primary source (step 2 already greps it for the token count, and
   it demonstrably carries gate output — 220 `gate-test.log` / `npm test` matches in run
   `70f19253`'s own `.ndjson`); the saved log file is kept as a fallback only.
5. **Pass 3 found the 43,583 figure is an opus-era outlier, not a baseline: two post-`a5f04b0f`
   sonnet runs (`f272fda8`=19,219, `0762e872`=9,880) already clear the spec's own `< 20000` pass
   bar with zero phases landed, and both hit the identical `test:package` red unprompted.** A
   fixed `N < 20000` threshold in Phase 4 could not discriminate this spec's fix from doing
   nothing. Fixed below: Problem now carries the full four-run population table, and Phase 4's
   criterion compares against the measured 9,880/19,219 baselines instead of a constant — see
   Problem and Phase 4 step 3.
6. **A token-minimum criterion alone rewards a step that gets cheap by not finishing.** The
   cheapest run in the population (`e06f2169`, 6,658 tokens) ended its own turn while `npm test`
   was still running in the background and was still recorded `step-end status:"done"` — confirmed
   directly against its `.ndjson`. Fixed below: Phase 4 step 3a adds a floor check, from the same
   `.ndjson`, that every gate the step reports on shows its quoted `EXIT=`-shaped marker (which the
   prompt already requires in the final report) before the step's `step-end`.
7. **Phase 3 cited only one of at least three open, unreconciled todos for the same
   `test:package` red** (`c895a348`, `1e8e5266`, `46dbb850` — all `status: todo`, filed by three
   different steps across two different runs, and not obviously agreeing on cause). Fixed below:
   Phase 3 now reconciles the duplicates (pick `c895a348` as canonical, mark the other two
   superseded) before writing the AGENTS.md entry, instead of citing one and leaving the other two
   for the next session to trip over.
8. **This revision's own second brief pass (`.ai/specs/briefs/2026-08-22-run-tests-output-tokens-revise.md`)
   re-derived the same three defects items 1-3 above already fixed, and found nothing beyond
   them — confirmed directly this pass, not assumed:** its "Defect 1" (`CLAUDE_EFFORT` env/flag
   precedence), "Defect 2" (Phase 4 step 4 contradicting the "FIX and re-run" prompt), and
   "Defect 3" (`document` cannot host the write-up) are the identical three findings from
   `review-spec` pass 1 (2026-08-21T23:01:20Z), already resolved by items 1-3 above and by
   `review-spec` pass 4's PASS verdict, which post-dates and supersedes that brief. Separately,
   this pass found the AGENTS.md trap Phase 3 adds (item 7 above, trap 5) now documents a **fixed**
   bug: todo `c895a348` reads `status: "done"` (was `todo` when Phase 3 wrote the trap), closed by
   an unrelated task — `.ai/specs/2026-08-21-workspace-boot-repo-and-always-worktrees.md`
   (commit `c15780cb`, "the boot root becomes a git repo, so a homeless run isolates too") fixed a
   one-shot run stalling for want of a git-repo working tree, which is the same failure shape
   `c895a348` reported for the `test:package` dry run. This does not undo Phase 3 — the trap stays,
   the same way AGENTS.md's own C18 stays documented after it was explained rather than fixed — but
   it means Phase 4 should not plan around this specific red recurring naturally; see the note added
   to Phase 4 step 3 below.
9. **CORRECTED 2026-08-22 (pass 5 fix) — item 8's own causal claim about why `c895a348` closed was
   itself wrong, and Phase 3's "all three are `status: todo`" line (below) was stale the moment
   Phase 3 landed.** Item 8 attributed the closure to commit `c15780cb` ("the boot root becomes a
   git repo, so a homeless run isolates too") on an unverified guess that a git-repo-working-tree
   fix matched `c895a348`'s stall shape. Reading `c895a348`'s own `context` field directly in
   `/var/lib/cezar/loki-labs/cezar/.ai/cezar/todos.json` (not inferred) shows a different, later,
   and exactly-matching fix: *"RESOLVED 2026-08-22 by task `d92e6b85`... Fixed in
   `packages/cezar/src/core/brokered-session.ts` (removed the poll timer's `unref()`...)"* — commit
   `3e6d1b7e` ("fix: keep a one-shot brokered run's interval ref'd so the process outlives the
   session", `git log -1 3e6d1b7e` → `2026-08-22T01:38:44Z`), spec
   `.ai/specs/2026-08-22-run-broker-cli-keepalive.md`. Not a coincidental match: `c895a348`'s own
   diagnostic note already named the exact mechanism — *"note `deadline.unref()` in
   `claude-cli-runner.ts` `attachBroker`"* — and `3e6d1b7e`'s commit message removes precisely that
   `unref()`. `c15780cb` landed 2026-08-21T22:10:04Z, four hours before the real fix, never touched
   `brokered-session.ts`, and fixed a different failure shape (no git repo at the boot root) that
   happened to read as a similar stall. All references to the fixing commit below now cite
   `3e6d1b7e`, not `c15780cb`. Todo state, also reconfirmed directly this pass: `c895a348` is
   `status: "done"`; `1e8e5266` and `46dbb850` both carry `archivedAt: "2026-08-22T00:56:20.866Z"`
   with a `SUPERSEDED 2026-08-22 by c895a348-4bee-4a81-89ab-a62788a6a118` note prepended to their
   own `context` — Phase 3's reconciliation (below) did execute as designed; only the "today"
   status line describing it was left in the present tense after the fact.
10. **Pass 5 REVISE, three defects, fixed below (D1-D3), plus new population evidence folded in
    directly.** (D1) Phase 3's "all three are `status: todo` today" line is fixed by item 9 above —
    the correction lives there since it is the same underlying fact. (D2) Phase 4 had no executable
    path to completion: step 0's `--acceptance` and step 3 both required "a run that hits a
    comparable diagnostic red," while item 8/9 record that red as now closed and unlikely to recur
    — two incompatible instructions for a condition Phase 4 could not control. **Fixed by redesigning
    Phase 4 around a controlled A/B** (same task, same deliberately-broken test, `RUN_TESTS_STEP_EFFORT`
    set vs. unset between the two arms) instead of waiting on an organic red — see Phase 4 below.
    (D3) AGENTS.md trap 5, as landed, cites `c895a348` "for the live status" in the present tense;
    that todo is now `done`. **This step cannot edit AGENTS.md** (out of scope for a spec-only
    revision pass) — Phase 3 below now carries the exact one-line addendum for whoever next touches
    that file, citing `3e6d1b7e` per item 9's correction, not `c15780cb` as pass 5's own review text
    suggested (the review had not yet read `c895a348`'s `context` field when it wrote that
    suggestion).

    **New population evidence, gathered directly this pass, not relayed from a prior summary** —
    every `run-tests` step's final `usage.updated` pulled fresh from every `.ai/cezar/runs/*.ndjson`
    on the box right now (11 runs total, not the 4 in the original table or the 10 pass 5 cited):
    properly-finished post-`a5f04b0f` sonnet runs are `0762e872`=9,880, `d92e6b85`=11,056,
    `f272fda8`=19,219 — confirmed by reading each run's own final report text, all three end with an
    actual gate result (`Test Files N passed/failed`), not a "waiting" message. The 9,880 floor
    holds. **Four sonnet/opus runs, not pass 5's three, show the identical "cheap by not finishing"
    pattern** — ends its turn while a gate is still running in the background, then `step-end
    status:"done"` fires anyway: `e06f2169`=6,658 (*"I'll wait for it rather than risk a false red
    from a concurrent rebuild"*), `57f093be`=8,346 (*"The gate suite is running in the background.
    I'll report back once it completes."* — compounding a `-u`-heredoc bug that made every gate exit
    127), `95d3c6f2`=7,754 (**this run's own `run-tests` step** — *"Standing by for the test-gate
    completion notification before continuing."*), and `f2012c07`=8,257, a run this session found
    that pass 5 did not have — *"Both `typecheck` and `test:unit` gates passed. `npm test`... is
    still running in the background — I'll pick this back up automatically when it completes."*
    Four confirmed instances, not three, strengthens Phase 4 step 3a into the load-bearing check it
    needs to be — folded into Problem's population table and step 3a's citation below.

11. **Pass 6 REVISE, one blocking defect (D1) plus a supporting gap (D2), both confined to Phase 4
    steps 1-3 — fixed below, mechanism NOT redesigned.** (D1) Phase 4 step 3, as revision item 10
    left it, said to produce Arm B's uncapped control by commenting out `types.ts:774`'s `effort:
    RUN_TESTS_STEP_EFFORT` line as "a local, uncommitted patch." Measured directly against the box
    this spec runs on: `loadWorkflows` (`packages/cezar/src/workflows/load.ts:68-74`) reads
    `SPEC_TO_DEPLOY_WORKFLOW` from the RUNNING SERVER'S COMPILED BUILD, not from any worktree's
    source — `systemctl cat cezar.service` → `ExecStart=/usr/bin/node
    /opt/cezar/packages/cezar/dist/index.js serve`, `/opt/cezar` → a dated release under
    `/opt/cezar-releases/`, and `grep -c -- --effort` on that `dist` → `0`. A source edit in a
    worktree — or in this checkout at all, absent a rebuild and a service restart — never reaches a
    triggered run's workflow definition, and a restart would disturb every OTHER concurrent run on
    this box (the population table above already shows several: `f2012c07`, `57f093be`). Left as
    written, Arm B would silently re-measure a CAPPED run and report "no effect," with nothing in
    the transcript to signal the false negative. **Fixed by using the override mechanism
    `loadWorkflows` already documents**, instead of a source patch: `.ai/cezar/workflows/<name>.yaml`
    (`WORKFLOWS_DIR`, `load.ts:14-15`, "a repo may override any built-in by shipping a file of the
    same name," and file workflows win name collisions with built-ins). `GET /api/v1/workflows`
    already serializes the running built-in `spec-to-deploy` definition wholesale, `effort` field
    included (the same mechanism `.ai/specs/2026-08-21-per-step-model-policy.md` relies on for
    `model` to appear with no route change) — read it, drop `run-tests`'s `effort` key, write the
    result to that path, trigger Arm B by name, then delete the override the moment both arms show
    a `baseBranch` recorded on their own run record (confirms `workflowDef` is frozen onto the
    record at trigger time, `run.ts:1145`, so the cleanup cannot reach back into either arm). No
    rebuild, no restart — the only remaining exposure is the window the override file exists
    on disk, stated as a risk in Phase 4 step 3 rather than elided. (D2) The same steps said to
    trigger runs "on the throwaway branch" with no mechanism named: `startRunSchema`
    (`server.ts:887`) has no base-branch field at all — every worktree instead forks from the
    project's own `config.baseBranch` (`run.ts:3661-3671` → `createWorktree`,
    `packages/cezar/src/git-worktree.ts:136`), a workspace-global setting, not a per-run one. Fixed
    by folding an explicit `GET`/`PUT /config` `baseBranch` swap — save the current value, point
    it at the throwaway branch, restore it once both arms have forked — into step 1 and the cleanup
    half of step 3. See Phase 4 below for both fixes in place; step 0's todo `--context` is updated
    to match, since it still described the old source-patch mechanism.
12. **Pass 7 REVISE, one blocking defect (D1) plus two should-fix items (S1, S2), all confined to
    Phase 4 — fixed below, mechanism NOT redesigned (pass 7 re-verified the override + `baseBranch`
    swap from item 11 sound and said so explicitly).** (D1) **Both arms, left to run to completion,
    each end in `commit-push` (a real `git push` on the project's scoped remote grant) and `deploy`
    (unrestricted Bash, `verify: { builtin: 'all-services-deployed' }`, and a real target list —
    `/var/lib/cezar/loki-labs/cezar/.ai/deploy-targets.json` exists on this box) — i.e. two
    production deploys of cezar from a throwaway branch carrying a deliberately broken test,
    triggered purely to count tokens.** Nothing parks either arm first: the project config carries
    no `approvals` key, so `minApprovers` is 0 and `requiresApproval` steps like `review-spec`
    auto-approve. **Fixed by cancelling each arm the moment its own `run-tests` `step-end` is
    recorded**, before it can advance into `commit-push` — `POST /runs/<runId>/cancel`
    (`server.ts:4975`) — stated in Phase 4 steps 2 and 3 as new sub-steps 2b/3b, and mirrored into
    step 0's todo `--context`/`--acceptance`. A cancelled arm is Phase 4's expected terminal state,
    not a failure — these runs exist to measure `run-tests`, not to ship. (S1) "`N_capped`
    materially below `N_uncapped`" had no number, against a population that already shows ~2x
    same-condition spread (`0762e872`=9,880 to `f272fda8`=19,219) with each arm's own `implement`
    step writing a different diff — one A/B pair alone cannot separate a real capping effect from
    that spread. Fixed in Phase 4 step 4: pass requires `N_capped` at least 30% below `N_uncapped`;
    a delta smaller than that, or one that lands inside the historical spread, is recorded as
    inconclusive rather than a pass or a fail, and a second A/B pair is run before drawing a
    conclusion. (S2) The `POST /runs` bodies shown in steps 2 and 3 omit the required `task` field
    (`startRunSchema`, `z.string().min(1).max(100_000)`, `server.ts:895`) and would 400. Fixed by
    adding a concrete, byte-identical `task` string to both bodies — see Phase 4 steps 2 and 3.
    Also folded in this pass, from pass 7's nits: the project-vs-workspace root question in step 3
    is answered outright (project-scoped `POST /runs` resolves via `resolveRunWorkflow(repoRoot =
    c.get('project').root)`, `server.ts:4829-4840` — the same root `GET /api/v1/workflows` reads),
    not left as "confirm which applies"; the override's exposure window is now stated as bounded by
    Arm B's own fork (however long it queues behind `maxParallel` — minutes on a busy box, not
    "a few seconds"), not by wall clock; and step 0's parenthetical on `--project` no longer implies
    cezar is unregistered (it is a registered project root — the absolute path is used because it
    needs no id lookup, not because no id resolves).

</details>

## TLDR

On the measured run (`70f19253-cf6b-407c-92e0-96a8020a8ebb`), `spec-to-deploy`'s `run-tests`
step spent 43,583 output tokens — ~76% of them invisible (extended-thinking) tokens, per
`usage.updated` at seq 1875 of that run's own `.ndjson` — to run 34s of gates and then keep
root-causing a failure it had already proven, twice over, was not its fault. This spec adds one
mechanical lever (an explicit `--effort` ceiling, plumbed through as a new per-step knob and
set on `run-tests` only) and one behavioral lever (a prompt clause that stops diagnosis the
moment fault is localized), plus documents the specific bug that triggered the run's own
over-diagnosis so no future `run-tests` step re-pays the discovery cost. It does **not** touch
`npm test`'s baseline (todo `c78140a8-55b0-4cc2-8d52-d2be468916fe`) — measured and confirmed
inapplicable, see below.

## Problem

`run-tests` is step 5 of the built-in `spec-to-deploy` workflow
(`packages/cezar/src/workflows/types.ts:755-804`, prompt built on `SPEC_TO_DEPLOY_STEP_MODEL`
= `'sonnet'` since commit `a5f04b0f`). Its contract, in its own prompt, is: run the gates, fix
what the diff broke, report pass/fail with the exit-marker line quoted. On the measured run it
instead:

1. Correctly ran `npm test` (2 failed / 9515 passed — both pre-documented in AGENTS.md's C18 /
   `add-project-dialog` traps) and recognized both in one pass. Cheap, and not the problem.
2. Hit a **second, previously undocumented** red: `npm run test:package` failed 1/15
   (`packages/cezar/test/e2e/package-cli.test.ts:86`, "the release tarball installs and runs
   the dry-run CLI workflow"). It reproduced the failure directly against the built CLI, then
   reproduced it **identically against the parent checkout's `dist` at commit `f0d48513`** — a
   commit containing none of this run's change. That second reproduction is the proof the
   failure predates the branch; it is also exactly the discipline AGENTS.md's own traps section
   asks for ("localise the fault to what both runs share," `AGENTS.md:337-343`).
3. **Kept going anyway**, five probes past that proof: A/B'd `CEZ_RUN_BROKER=0` vs. the default
   broker path, A/B'd the env scrub, A/B'd a TTY (`script -qec`), read
   `claude-cli-runner.ts`'s broker-attach code and `index.ts:233`, and had to hunt down and
   `kill` several orphaned probe processes by PID.
4. Filed the result as a real, well-evidenced todo and correctly declined to fix it ("the
   broker/spool subsystem is outside this task, the red predates the branch").

Step 4 is the right outcome. Step 3 is the cost this spec removes. Per the brief's direct count
of the run's own transcript: 29 visible assistant text blocks (≈1,900 tokens) and 37 tool-call
bodies (≈8,000 tokens) account for only ≈24% of the 43,583 total. **The other ≈76% never
appears as a visible event in the log** — it is extended-thinking spent forming and
interpreting each of the nine diagnostic probes in step 3. A prompt fix aimed at prose
("stop narrating") cannot reach three quarters of the spend, because the spend was never
narration.

**43,583 is the tail of this step's cost, not its typical spend — confirmed against the
population, not just this one run.** Pulling every recent `spec-to-deploy` `run-tests` step's
final `usage.updated` from this same `.ai/cezar/runs/*.ndjson` directory (`stepId=run-tests`,
`output` field, cross-checked against each run's own `session.started.model`):

| run | model | output tokens | wall | notes |
|---|---|---|---|---|
| `70f19253` (measured above) | `claude-opus-5[1m]` | 43,583 | 631s | outlier, opus-era |
| `7c2dd8f0` | `claude-opus-5[1m]` | 46,090 | — | opus-era |
| `c10864d1` | `claude-opus-5[1m]` | 21,205 | — | opus-era |
| `e06f2169` | `claude-opus-5[1m]` | 6,658 | 107s | opus-era; cheap-by-not-finishing (below) |
| `f272fda8` | `claude-sonnet-5` | 19,219 | 454s | post-`a5f04b0f`, properly finished |
| `d92e6b85` | `claude-sonnet-5` | 11,056 | — | post-`a5f04b0f`, properly finished |
| `0762e872` | `claude-sonnet-5` | 9,880 | 318s | post-`a5f04b0f`, properly finished — floor |
| `f2012c07` | `claude-sonnet-5` | 8,257 | — | post-`a5f04b0f`; cheap-by-not-finishing (below) |
| `57f093be` | `claude-sonnet-5` | 8,346 | 107s | post-`a5f04b0f`; cheap-by-not-finishing (below) |
| `95d3c6f2` | `claude-sonnet-5` | 7,754 | — | **this task's own `run-tests` step**; cheap-by-not-finishing (below) |

**CORRECTED 2026-08-22 (revision item 10, N3) — this table originally showed 4 of the 10 runs a
later review pass found in this population; it now shows all 10.** Re-pulled directly this
revision (every `.ai/cezar/runs/*.ndjson` on the box, not a secondhand count): one further run,
`7aecd6a2` (opus-era, 317 tokens, report text `"Test Files no tests"`), exists but is excluded
from this table as not comparable — its own report shows it found nothing to test, not a shortened
diagnosis of a real gate run. None of the additions change the conclusion below: the three
properly-finished post-`a5f04b0f` sonnet runs still bracket `9,880`-`19,219`, and the floor still
holds at `9,880`. The two lowest sonnet numbers (`f2012c07`=8,257, `57f093be`=8,346, both below the
floor) are not counter-evidence — see the "cheap-by-not-finishing" discussion below the table,
which both fail.

Two of the three properly-finished runs after commit `a5f04b0f` (2026-08-21 21:52 UTC, the
per-step model policy that put `run-tests` on sonnet) hit the *same* `test:package` case-5 red
walked through above, and both handled it with no lever from this spec in place: `f272fda8`'s own
report reproduces the failure at clean `387ba439` and cites the already-filed todo
(`1e8e5266-b3e8-45f1-9489-25391408cdc3`) rather than re-diagnosing — *"This confirms it
independently: this exact test was already found pre-existing red on this box... tracked as cezar
todo `1e8e5266-b3e8-45f1-9489-25391408cdc3`, not a blocker for spec work."* `0762e872`, running
later still, spent under half of `f272fda8`'s tokens on the same red. **`d92e6b85`, the third and
lowest-token properly-finished run at 11,056, did NOT hit this red at all** — confirmed by reading
its own report text directly: *"Build is green. Now the key gate — `npm run test:package`."*
followed by *"All gates are green"* — because `d92e6b85` is the task that fixed the broker-stall
bug itself (revision item 9: commit `3e6d1b7e`), so its own `test:package` gate passed cleanly.
Its one reported failure was the unrelated, already-documented C18 host-speed trap. So the
post-`a5f04b0f` sonnet population spans `9,880`-`19,219` for runs that hit the red, plus `11,056`
for a run that didn't need to — not a single ~14.5k median across a uniform condition, and Phase 4
below has to beat the `9,880` floor specifically (see Phase 4), not a fixed number ten times higher
than what sonnet already does unaided.

This also reorders which lever the evidence supports as primary. Four runs in the table are
*not* success stories despite low token counts — see the "cheap-by-not-finishing" note above and
Phase 4 step 3a for the full evidence (`e06f2169`, `57f093be`, `95d3c6f2`, `f2012c07`), all of
which ended their turn while a gate was still running in the background and were still recorded
`step-end status:"done"`. Discounting those, the gap between the two runs that both hit the same
red and actually finished — `f272fda8` at 19,219 vs. `0762e872` at 9,880 — tracks whether the run
had to discover the `test:package` failure itself or could find it already filed, which is what
Phase 3 (the AGENTS.md trap / todo citation) targets, not what Phase 1 (the `effort` cap) targets.
This spec still ships both — Phase 1 is cheap, additive, and nothing here proves it doesn't help
further — but Phase 3 is the lever this population's own data actually shows moving the number,
and Solution / Phase 4 below are written accordingly.

**Why this needs a structural lever, not only a prompt one.** This repo already ran the
prompt-only experiment on the sibling problem (round trips, not reasoning depth) and measured
the result: the tool-budget doctrine shipped in `.ai/specs/2026-08-20-agent-round-trip-batching-and-fanout.md`
(KB `notion-333c1a0a847b` / `notion-20c9698de5f9`) asked agent steps to batch tool calls, and a
later re-measurement (KB `notion-cc6ebabb2ab4`, 2026-08-21) found the batch factor had moved
1.00 → 1.02 and wall clock had not moved at all — "the fix that spec shipped did not move the
number it was written to move." A prompt clause asking an agent to stop diagnosing sooner is
exactly this shape of fix, and this repo has direct, recent evidence that this shape of fix can
ship, read as correct, and change nothing measurable. This spec ships the prompt clause anyway
(cheap, plausibly load-bearing, and the acceptance criteria ask for it) but does not rely on it
alone, and Phase 4 re-measures rather than assumes — the same mistake `notion-cc6ebabb2ab4`
corrects for the batching fix must not repeat here.

**The `npm test` baseline does not apply.** Todo `c78140a8-55b0-4cc2-8d52-d2be468916fe` records
`npm test` red with 2,152 failures on the prod box, independent of any change — confirmed by
reading the todo directly (`acceptanceCriteria`: React 19 / `React.act`, `TMPDIR` outside the
repo, or the gate stops being listed). The measured run's own `npm test` output was `Tests 2
failed | 9515 passed | 1 skipped (9518)` — the number 2,152 appears nowhere in this run. Both
failures were the documented C18 / `add-project-dialog` traps, recognized in one pass. This
task stays independent of `c78140a8`.

## Solution

Two levers, plus one piece of documentation:

1. **A per-step `effort` knob**, mirroring the existing per-step `model` knob
   (`.ai/specs/2026-08-21-per-step-model-policy.md`) with the same shape: a new optional field on
   `workflowStepSchema`, threaded through `runAgentStep` into `AgentRunSpec`, consumed by
   `buildClaudeArgs` as the claude CLI's own `--effort <level>` flag (`claude --help`: `low |
   medium | high | xhigh | max` — confirmed present on the pinned CLI, `claude 2.1.233`, the same
   binary `claude-cli-runner.ts` spawns via `CEZ_CLAUDE_BIN ?? 'claude'`). No second path: the
   Revision note above corrects the original design, which additionally wrote `step.effort` into
   the child's own `CLAUDE_EFFORT` env var — process-tree evidence and four spawn probes show no
   ambient `CLAUDE_EFFORT` exists on this box and the CLI does not read the variable as input in
   the first place, so there is nothing for a second path to defend against.

   Additive and backend-scoped: every step that does not set `effort` gets exactly today's
   behavior (the flag is skipped, byte-for-byte the same argv as now), and the two non-claude
   runners (`codex-app-server-runner.ts`, `opencode-server-runner.ts`) never read
   `AgentRunSpec.effort` at all, so this cannot change their behavior.
2. **`run-tests` sets `effort: 'medium'`.** This is the mechanical cap: extended-thinking spend
   is bounded by the CLI itself, at the source, rather than hoped into submission by prompt
   wording. This is a measured one-notch cut, not a guess about an unknown default: the spawn
   probes in the Revision note above show a cezar-spawned `claude` session with no `--effort` flag
   runs at `high` — the same level the 43,583-token baseline ran at — so `medium` is one step down
   from what actually produced that run, chosen to still leave enough reasoning budget to
   correctly interpret a gate failure while capping the open-ended, iterative root-causing this
   run's step 3 did. Phase 4's fresh measurement is what actually settles whether `medium` is the
   right level; if it turns out to suppress real diagnosis (a gate failure genuinely goes
   unexplained), the fix is raising this one constant, not re-designing the mechanism.
3. **A diagnostic-depth ceiling in the `run-tests` prompt.** The current prompt
   (`types.ts:770-771`) says "If any fail, FIX the code and re-run until they pass" with no
   carve-out for a failure that is confirmed pre-existing and outside the diff. Add one: once a
   failure reproduces identically against a control that does not contain this run's change
   (clean HEAD, the parent checkout, `git stash` — one control run, matching the method AGENTS.md
   already teaches), that is sufficient proof of "not mine." File a todo with what is already
   known and stop — no further env A/B, no source spelunking, no process hunting. This targets
   exactly the run's step 3, while leaving step 2's method (the control reproduction itself)
   untouched, because that step is what makes "not mine" a proven fact instead of an assumption.
4. **An AGENTS.md trap entry for the broker-stall bug itself** (todo
   `c895a348-4bee-4a81-89ab-a62788a6a118`: "The run broker stalls a one-shot `cezar run` at its
   first agent step"), in the same location and shape as the existing C18 / `add-project-dialog`
   traps (`AGENTS.md:250-344`). The brief's own evidence for why this works: the run recognized
   the two *documented* `npm test` failures in one pass, and spent five probes on the *one*
   `npm run test:package` failure that had no trap yet. Documenting this failure directly
   converts a future occurrence from "five probes" to "one pass," independent of whether levers
   1-3 also help.

## Architecture

Effort resolution mirrors model resolution exactly — one path, no per-backend normalization
table (`effort` is a fixed five-value enum the claude CLI defines, not a model alias that
differs per backend):

```
step.effort ──► AgentRunSpec.effort ──► buildClaudeArgs:
                 (workflows/run.ts,       if (spec.effort) args.push('--effort', spec.effort)
                  runAgentStep)           (claude-cli-runner.ts, alongside --model)
```

If a step leaves `effort` unset, the arrow never fires, `buildClaudeArgs` omits `--effort`
entirely, and the CLI falls back to its own default — measured as `high` (Revision note above) —
exactly as it does today. This spec changes nothing about steps that don't opt in.

No env-side path: the Revision note above corrects the original design, which additionally wrote
`step.effort` into the child's own `CLAUDE_EFFORT` env var to override an ambient host value.
Process-tree evidence and four spawn probes show that value does not exist and the CLI does not
read `CLAUDE_EFFORT` as input at all — there is no flag/env precedence question, because the CLI
never consults the env var; the flag is the only signal. `env: stepProfile.env` at
`packages/cezar/src/workflows/run.ts:4671` is therefore untouched by this spec.

No lookup table, no `agentModelsLocked`-style kill switch — `effort` is not a cost/identity
control the way `model` is (an org cannot be forced onto a specific model tier by an `effort`
value), so it does not need the lock's escape hatch. `codex-app-server-runner.ts` and
`opencode-server-runner.ts` take `AgentRunSpec` too, and neither reads `.effort` — the same
"decorative on runners that don't consume it" shape `bashAllowlist`/`allowedTools` already have
today (`claude-cli-runner.ts:679-685`'s own doc comment already describes this pattern for
another field).

## Phases

**Phase 1 — the knob, defined and applied to `run-tests` only.**

- `workflowStepSchema` (`packages/cezar/src/workflows/types.ts`) gains
  `effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional()`.
- `AgentRunSpec` (`packages/cezar/src/core/agent-runner.ts:38-72`) gains `effort?: string`,
  next to `model?: string`.
- `runAgentStep` (`packages/cezar/src/workflows/run.ts`, where `backendModel` is resolved at
  ~4560-4583 and where the `openSession` call builds its spec at ~4633-4677) passes
  `effort: step.effort` straight through to the `openSession` spec, next to `model: backendModel`
  at `run.ts:4672` — no normalization step, unlike `model`. `env: stepProfile.env` at
  `run.ts:4671` is untouched (Revision note above / Architecture).
- `buildClaudeArgs` (`packages/cezar/src/core/claude-cli-runner.ts:691-728`) gains, alongside
  the existing `if (spec.model) { args.push('--model', spec.model); }`:
  `if (spec.effort) { args.push('--effort', spec.effort); }`.
- A new constant next to `SPEC_TO_DEPLOY_STEP_MODEL` (`types.ts:526`):
  `const RUN_TESTS_STEP_EFFORT = 'medium';`, and `run-tests`'s step definition
  (`types.ts:755-804`) gains `effort: RUN_TESTS_STEP_EFFORT`. No other step sets `effort`, so
  every other step's behavior is provably unchanged (the field stays `undefined`, the flag
  stays omitted, byte-for-byte the same argv as today).
- Unit tests in `packages/cezar/src/core/claude-cli-runner.test.ts` (alongside the existing
  `buildClaudeArgs` cases at lines 42-107): `--effort` is emitted when `spec.effort` is set, in
  the exact position, and omitted entirely when unset (mirroring the existing "omits the flag
  entirely when no systemPrompt is set" case at line 49).
- A test in `packages/cezar/src/workflows/types.test.ts` (alongside the model-policy assertions
  at lines 154-183): `run-tests` carries `effort: 'medium'` and it is a member of the enum;
  every other step's `effort` is `undefined`.

**Phase 2 — the diagnostic-depth ceiling, in the `run-tests` prompt.**

Add a clause to `run-tests`'s prompt (`types.ts:755-804`), directly after the existing
execution-discipline bullets and before the closing report instructions:

> Once a failure reproduces IDENTICALLY against a control that does not contain this run's
> change (clean HEAD, the parent checkout, `git stash` — see AGENTS.md's own method for why one
> shared-cause control is proof, not evidence), that is sufficient to call it "not mine." Stop
> there. Do not also A/B environment variables, spawn additional probes, or read the implicated
> subsystem's source hunting for a root cause — that diagnosis is real work, but it belongs to
> whoever picks up the todo, not to a step whose contract is pass/fail. File what you already
> have (`cezar todo add`): the failing test, the one repro command, the one control command, and
> the shared file/line if the output already shows it. Then move on.

And extend the existing closing instruction (`types.ts`, the "End your report with..." block)
to state the acceptance criteria's own wording directly:

> Report pass/fail plainly. Quote the failing test's own output verbatim — never re-explain
> what the diff changed; that is already in the commit this step is about to hand to
> `commit-push`.

A `types.test.ts` case (same pattern as the existing "makes run-tests wait on the process"
tests at lines 320-339): the `run-tests` prompt contains a stop condition tied to "not mine" /
control reproduction, and contains the "quote... verbatim" / "never re-explain" instruction.

**Phase 3 — the AGENTS.md trap entry.**

**First, reconcile the duplicate todos — three open records track the same `test:package`
case-5 red, and citing only one leaves the other two for the next session to find by accident:**
`c895a348-4bee-4a81-89ab-a62788a6a118` (filed by run `70f19253`'s own `run-tests` step, the
broker-stall framing — "the run broker stalls a one-shot `cezar run` at its first agent step"),
`1e8e5266-b3e8-45f1-9489-25391408cdc3` (filed independently by `f272fda8`, "test:package case 5
... is red on clean main, pre-dating the boot-repo change," with its own control-repro at clean
`a5f04b0f` and `387ba439`), and `46dbb850-f968-45a8-8622-fb1e4432d2e6` (filed by a `commit-push`
step gating a different task, "the release-tarball e2e is red on main"). **CORRECTED 2026-08-22
(revision item 10, D1) — this paragraph describes the state when Phase 3 was written; Phase 3 has
since landed and executed exactly the reconciliation this paragraph specifies.** All three were
`status: todo` when this phase was drafted. Read directly against
`/var/lib/cezar/loki-labs/cezar/.ai/cezar/todos.json` right now: `c895a348` is canonical and
`status: "done"` (closed 2026-08-22T01:38:44Z by commit `3e6d1b7e`, not the `c15780cb` this spec
originally guessed — see revision item 9); `1e8e5266` and `46dbb850` both carry
`archivedAt: "2026-08-22T00:56:20.866Z"` with a `SUPERSEDED 2026-08-22 by c895a348` note prepended
to their own `context`, folding in exactly what the rest of this paragraph describes. The
paragraph below is left as originally written, describing what Phase 3 does and why — it remains
accurate as a record of Phase 3's design intent, executed as written.

The three todos describe
the same underlying symptom from three different angles — `0762e872` even diagnosed a *fourth*
possible root cause for the same symptom ("the CLI's default workflow now being
`spec-to-deploy`"), so the three may not even agree on cause. Before writing the AGENTS.md entry:
pick `c895a348` as canonical (it is the one with the fullest reproduction detail — dry-run stall,
run status, `CEZ_RUN_BROKER=0` control) and mark `1e8e5266` and `46dbb850` superseded-by-`c895a348`
in `todos.json`, folding in `1e8e5266`'s extra control point (reproduces at two different clean
commits, not just one) and `0762e872`'s fourth-cause note as additional context on the canonical
record.

Then add a fifth entry to "Four environment traps that make the gates LIE" (`AGENTS.md:250-344`,
whose heading is already amended once for a fourth trap — same pattern, add a fifth line to the
heading's own note and a numbered entry in the body) documenting the broker-stall failure:
`npm run test:package` fails 1/15 on `package-cli.test.ts:86`, the dry run stalls at step 1 with
run status stuck `running` and CLI exit 0, reproduces identically at clean HEAD (so it predates
any branch), and the decisive control is `CEZ_RUN_BROKER=0` (finishes) vs. the default brokered
path (stalls) — cite the now-canonical `c895a348-4bee-4a81-89ab-a62788a6a118` for the live status
and acceptance criteria rather than re-deriving them. This is independent of Phases 1-2 and
reduces cost the moment it lands, on any future `run-tests` step that meets this red before the
todo is fixed — not gated on the knob or the prompt clause working, and (per the Problem section's
population table above) already the lever the evidence most directly supports.

**Outstanding follow-up (revision item 10, D3) — the trap entry above already landed in AGENTS.md
in the `implement` step, but wrote it while `c895a348` was still open; it is now closed, and the
entry (`AGENTS.md:340-351`, trap 5) still cites it "for the live status" in the present tense.**
Per this workspace's own doctrine (a correction marks what it invalidates, in place), append one
sentence to the end of trap 5, without touching anything above it: *"Corrected 2026-08-22 — the
canonical todo (`c895a348`) is now `status: 'done'`, closed by commit `3e6d1b7e`
(`.ai/specs/2026-08-22-run-broker-cli-keepalive.md`), which removed the `unref()` on the one-shot
broker's poll interval — the same mechanism this todo's own diagnosis pointed at. This red may no
longer reproduce; if it does, that is new information, not a re-confirmation of this entry."* This
edit belongs to whichever step next has write access to source files (this revision pass is
spec-only) — it is one line, already-cited, and should land before or alongside Phase 4's trigger
run so a future reader of the trap is not pointed at a closed todo as if it were live.

**Phase 4 — fresh measurement (the phase that actually settles this).**

Not optional, and not satisfied by re-reading the opus-era 43,583 figure — that run predates
`a5f04b0f` (2026-08-21 21:52 UTC, per-step model policy landing `run-tests` on sonnet) by 82
minutes and is not a valid baseline for a post-fix comparison (brief, "A confound the next step
must not miss"). After Phases 1-3 ship:

**REDESIGNED 2026-08-22 (revision item 10, D2) — a controlled A/B, not a wait for an organic red.**
The original design measured one run against the frozen `9,880`/`19,219` baselines and required
that run to "hit a comparable diagnostic red" to count — but revision item 9 records that the only
red this spec's population ever measured (`test:package` case 5, todo `c895a348`) is now closed by
commit `3e6d1b7e`, and may not recur. The original step 3 and step 4 then resolved that same
condition two incompatible ways: step 3 said "re-trigger rather than record a false pass" if no red
shows up, step 4's note said treat the token count as "informative context" instead — two rules for
the same case, and a `--acceptance` string (step 0) that could not be satisfied by construction if
the red stays fixed. **Fixed by controlling the only variable that matters and removing the
dependency on an organic red entirely:** run the same real task twice, with the same test
deliberately broken beforehand in both runs, differing only in whether `RUN_TESTS_STEP_EFFORT` is
applied — an "Arm A / Arm B" pair. This answers the actual question ("did the effort cap reduce
output tokens?") directly, folds the deliberately-broken-test detection check into the same
measurement instead of running it as an unrelated fourth step, and gives step 0's `--acceptance` a
criterion that is satisfiable regardless of whether the organic red ever reappears. The population
table in Problem, and the 9,880 floor specifically, are kept as background context below (per this
item's own instruction) — informative, not the pass bar.

0. **File the write-up todo first, not after** — closes revision item 3's original Defect 3 (a
   verification run's own `document` step cannot know it is measuring a different, earlier spec;
   nothing in its own chain can write the result up). Before triggering either run:
   ```bash
   cezar todo add "record post-effort-cap run-tests A/B token measurement" \
     --project /var/lib/cezar/loki-labs/cezar \
     --context "Verifies .ai/specs/2026-08-21-run-tests-reasoning-ceiling.md Phase 4 (A/B design, revision item 10; mechanism corrected revision item 11 after review-spec pass 6 D1/D2; both arms cancelled right after their own run-tests step-end, per revision item 12 D1 after pass 7 — neither arm is allowed to reach commit-push/deploy). Same real task (byte-identical across arms), same deliberately-broken test on a shared throwaway branch (config.baseBranch swapped in for both arms, restored after), two spec-to-deploy runs differing only in whether run-tests's effort key is present: Arm A (built-in spec-to-deploy, effort=medium) vs. Arm B (a .ai/cezar/workflows/spec-to-deploy.yaml override with the effort key removed, written just before triggering and deleted right after). Extract run-tests's usage.updated output tokens from each run's .ndjson (stepId=run-tests); record N_capped and N_uncapped here against the Problem section's population table for context (properly-finished pre-fix sonnet: f272fda8=19219, d92e6b85=11056, 0762e872=9880)." \
     --acceptance "N_capped and N_uncapped are both recorded from two runs of the same task with the same deliberately-broken test; N_capped is at least 30% below N_uncapped, OR the result is recorded as inconclusive (delta inside the ~9880-19219 historical spread) and a second A/B pair is run; every gate both arms report on shows its EXIT= marker in each run's own .ndjson (Phase 4 step 2a/3a); both arms' .ndjson name the deliberately-broken test's failure verbatim under stepId=run-tests (Phase 4 step 5); both arms were cancelled (POST /runs/:id/cancel) immediately after their own run-tests step-end and never reached commit-push or deploy (Phase 4 step 2b/3b); config.baseBranch and the workflow catalog are confirmed restored after both arms forked (GET /config shows originalBaseBranch again, GET /api/v1/workflows shows effort: medium on run-tests again)"
   ```
   (`--project` takes the absolute repo path rather than an id string — `resolveProjectRoot`
   in `packages/cezar/src/todo-cli.ts:85-97` accepts a registered id or a path; `cezar` is a
   registered project root here, so an id would also resolve, but the absolute path needs no
   lookup, which is why it is used.) Step 6 below updates this SAME todo with the result — it is
   the destination, not either verification run's own `document` step.
1. **Deliberately break one test, once, shared by both arms — and point the project at it.**
   Pick a trivial, obvious assertion flip in a test that is otherwise unrelated to Phases 1-3 (so
   the same diff drives both runs), and commit it to a throwaway branch (e.g.
   `verify/run-tests-effort-ab`) in this repo's own working copy — no push required, since
   `createWorktree` forks locally. This replaces the original design's separate step 4 — by
   controlling the red instead of waiting for one to occur naturally, the detection check (step 5
   below) is guaranteed to have something to detect in both arms, closing the gap the original
   design left when the organic red went away.

   **CORRECTED 2026-08-22 (review-spec pass 6, D2) — "on the throwaway branch" needs a mechanism.**
   `POST /runs` (`startRunSchema`, `packages/cezar/src/server/server.ts:887`) has no base-branch
   field; every worktree instead forks from the project's own `config.baseBranch`
   (`run.ts:3661-3671` → `createWorktree`, `packages/cezar/src/git-worktree.ts:136`). So before
   triggering either arm: `GET /config` (project-scoped) and save the current `baseBranch` as
   `originalBaseBranch`, then `PUT /config` with `{ "baseBranch": "verify/run-tests-effort-ab" }`
   (`.put('/config', ...)`, `server.ts:6455`, the `baseBranch` handling at `:6469-6471`). This is
   workspace-global, not per-run — it governs every new run on
   this project until changed back, which is why step 3 below restores it the moment both arms have
   forked, not at the end of the phase.

   **ADDED 2026-08-22 (revision item 12, S2) — `POST /runs` requires a `task` string
   (`startRunSchema`, `z.string().min(1).max(100_000)`, `server.ts:895`); the bodies in steps 2/3
   originally omitted it, which would 400.** Fix the task text now, once, and reuse it
   byte-identical in both arms — the design holds everything but the effort key constant between
   arms, and a task that differed between them would confound `N_capped`/`N_uncapped` the same way
   a different diff would:
   ```
   Phase 4 A/B measurement run for .ai/specs/2026-08-21-run-tests-reasoning-ceiling.md: the test
   break already committed to this branch (see repo HEAD) is the only change under measurement.
   Make no other code changes. Run the normal spec-to-deploy steps against it.
   ```

   Also prepare, but do not yet write, Arm B's workflow override: `GET /api/v1/workflows`
   (project-scoped) already serializes the running built-in `spec-to-deploy` definition wholesale,
   `effort` field included. Copy that response's `spec-to-deploy` entry verbatim and delete the
   `effort: "medium"` key from its `run-tests` step only — hold this JSON ready for step 3; writing
   it early would affect Arm A too.
2. **Arm A — capped.** Trigger one `spec-to-deploy` run: `POST /runs` with
   `{ "workflow": "spec-to-deploy", "task": "<the step-1 task text, byte-identical to Arm B's>" }`
   and no `steps` override. No `.ai/cezar/workflows/spec-to-deploy.yaml` exists yet at this point,
   so `loadWorkflows` (`workflows/load.ts:68-74`) resolves the unmodified built-in — `effort:
   RUN_TESTS_STEP_EFFORT` = `'medium'` in effect, per Phase 1 — and the worktree forks from the
   `config.baseBranch` set in step 1, so the deliberately-broken test is already present at the
   run's own `HEAD`. Let it reach `run-tests`, then extract that step's own token spend directly
   from the run's `.ndjson`:
   ```bash
   grep '"type":"usage.updated"' .ai/cezar/runs/<runIdA>.ndjson \
     | grep '"stepId":"run-tests"' | tail -1
   # {"type":"usage.updated","usage":{...,"output":N_capped,...},"costUsd":...,"stepId":"run-tests",...}
   ```
   Before moving to Arm B, poll `GET /runs/<runIdA>` until the record itself carries a `baseBranch`
   field (set at worktree creation) — this confirms the fork already captured the throwaway branch
   into Arm A's own record, so restoring `config.baseBranch` later (step 3) cannot retroactively
   change what Arm A ran against.
   2a. Gate-completion check — see the shared check after step 3 below; apply it to this run's
   `.ndjson` before treating `N_capped` as valid.
   2b. **ADDED 2026-08-22 (revision item 12, D1) — cancel this arm now, before it can ship.**
   Once `run-tests`'s own `step-end` is recorded in the `.ndjson` (2a has already confirmed it
   actually finished), `POST /runs/<runIdA>/cancel` (`server.ts:4975`) immediately — do not let
   the run auto-advance into `commit-push` (a real `git push` on the project's scoped remote
   grant) and `deploy` (unrestricted Bash, `verify: { builtin: 'all-services-deployed' }`, and a
   real target list at `.ai/deploy-targets.json`). Nothing else parks it: the project config has
   no `approvals` key, so `minApprovers` is 0 and `requiresApproval` steps like `review-spec`
   auto-approve on their own. This arm exists to measure `run-tests`, not to ship — a cancelled
   run here is Phase 4's expected terminal state, not a failed one.
3. **Arm B — uncapped control.** **CORRECTED 2026-08-22 (review-spec pass 6, D1) — a local,
   uncommitted edit to `types.ts:774` cannot produce this control.** `SPEC_TO_DEPLOY_WORKFLOW` is a
   compiled-in constant that `loadWorkflows` (`workflows/load.ts:68-74`) reads from the RUNNING
   SERVER'S BUILD, not from any worktree's source (measured directly against the box this spec runs
   on: `systemctl cat cezar.service` → `ExecStart=/usr/bin/node
   /opt/cezar/packages/cezar/dist/index.js serve`, `/opt/cezar` → a dated release under
   `/opt/cezar-releases/`, `grep -c -- --effort` on that `dist` → `0`). A source edit here reaches a
   triggered run only after a rebuild and a service restart, which would disturb every OTHER
   concurrent run on this box (this phase's own population table already shows several: `f2012c07`,
   `57f093be`). Left as originally written, Arm B would silently re-measure a CAPPED run and report
   "no effect," with nothing in the transcript to signal the false negative.

   **Fixed by using the override mechanism `loadWorkflows` already documents** — no rebuild, no
   restart: write the JSON prepared in step 1 (the built-in `spec-to-deploy` definition with
   `run-tests`'s `effort` key removed) to `.ai/cezar/workflows/spec-to-deploy.yaml`
   (`WORKFLOWS_DIR`, `load.ts:14`) in the SAME project root `GET /api/v1/workflows` was read from
   in step 1 — `c.get('project').root` (`server.ts:4382`). **RESOLVED 2026-08-22 (revision item
   12, per pass 7's nit) — this is not an open question.** Both arms trigger via project-scoped
   `POST /runs`, which resolves the workflow catalog the identical way:
   `resolveRunWorkflow(repoRoot = c.get('project').root)` (`server.ts:4829-4840`). The
   workspace-scoped `POST /workspace/runs`, which resolves against `bootRoot`
   (`workspace-run-routes.ts:97`) instead, is not used anywhere in this phase, so there is no
   ambiguity to confirm — write the override to `c.get('project').root`. `.ai/cezar/` is
   gitignored and this path does not exist yet on this box — create it. Confirm the write took
   with a fresh `GET /api/v1/workflows`: `run-tests` on `spec-to-deploy` shows no `effort` field.
   Only THEN trigger Arm B: `POST /runs` with
   `{ "workflow": "spec-to-deploy", "task": "<the step-1 task text, byte-identical to Arm A's>" }`
   — `load.ts`'s own "file workflows win name collisions with built-ins" rule means this resolves
   the override (falling back to the CLI's own measured default, `high`, per the Revision note's
   spawn probes), not the built-in. Phase 2's prompt clause
   and Phase 3's AGENTS.md trap are unchanged in the override (only the `effort` key differs from
   the built-in), and the same throwaway branch/broken test from step 1 drives both arms — this
   isolates the effort knob specifically, everything else that could move the number between the
   two arms held constant.

   Extract `N_uncapped` with the identical recipe as step 2. Poll `GET /runs/<runIdB>` the same way
   as step 2, until its own `baseBranch` is recorded — this also confirms `workflowDef` is frozen
   onto the run record at trigger time (`run.ts:1145`), not re-read per step, so the cleanup below
   cannot reach back into either already-started arm. **The moment BOTH arms show a recorded
   `baseBranch`:** delete `.ai/cezar/workflows/spec-to-deploy.yaml` (restores the built-in,
   `effort: medium`, for every subsequent run on this project) and `PUT /config` `baseBranch`
   back to `originalBaseBranch` from step 1. State the exposure plainly rather than eliding it:
   between writing the override and deleting it, any OTHER `spec-to-deploy` run started on this
   project — this box demonstrably runs several concurrently, per the population table above —
   would also run uncapped. **CORRECTED 2026-08-22 (revision item 12, per pass 7's nit) — that
   window is not "a few seconds."** It is bounded by however long Arm B queues behind this
   project's `maxParallel` before it can even fork, not by wall clock — on a busy box (this one
   demonstrably runs several concurrent runs, per the population table above) that queue wait can
   run minutes. Keep the override in place only until Arm B's own `baseBranch` is confirmed
   recorded, and do not run this phase during a period of known-heavy concurrent activity on this
   project.
   3a. **Every gate the step reports on must have actually finished — verify this from the same
   `.ndjson`, independently of the token count. Apply this to BOTH arms' `.ndjson` (step 2a and
   3a are the same check).** This is not a hypothetical: four separate instances of a step getting
   cheap by not finishing were confirmed directly this revision, not three — `e06f2169` (opus,
   6,658 tokens, *"I'll wait for it rather than risk a false red from a concurrent rebuild"*
   immediately followed by `turn.completed stopReason:"end_turn"` → `session.ended` →
   `step-end status:"done"`), `57f093be` (sonnet, 8,346, *"The gate suite is running in the
   background. I'll report back once it completes."*, compounding a `-u`-heredoc bug that made
   every gate exit 127), `95d3c6f2` (sonnet, 7,754 — **this task's own `run-tests` step** —
   *"Standing by for the test-gate completion notification before continuing."*), and `f2012c07`
   (sonnet, 8,257, found fresh this revision, not in any prior pass — *"Both `typecheck` and
   `test:unit` gates passed. `npm test`... is still running in the background — I'll pick this
   back up automatically when it completes."*). All four end their turn with `step-end
   status:"done"` recorded seconds later, with no completed gate result for the long-running suite.
   The prompt already requires the step to "QUOTE the exit-marker line from each saved log" in its
   final report (`types.ts`, the closing instruction block) — so confirm each arm's report actually
   contains an `EXIT=`-shaped line (or `Test Files N passed`) for every gate it names, not just a
   token count. An arm that reports a low token count without a quoted exit marker for every named
   gate has gotten cheap by not finishing, and that arm's `N` must be discarded and the run
   re-triggered, regardless of how good the number looks.
   3b. **ADDED 2026-08-22 (revision item 12, D1) — cancel this arm now, the same way as Arm A.**
   Once `run-tests`'s own `step-end` is recorded (confirmed by 3a), `POST /runs/<runIdB>/cancel`
   (`server.ts:4975`) before it can advance into `commit-push`/`deploy` — same reasoning as step
   2b: this arm exists to measure `run-tests`, not to ship, and a cancelled run is the expected
   terminal state. Do this before or after deleting the workflow override and restoring
   `config.baseBranch` above, in either order — cancellation and the override/`baseBranch` cleanup
   are independent of each other.
4. **Compare `N_capped` against `N_uncapped` — this is the pass bar, not a fixed threshold or the
   frozen population.** **QUANTIFIED 2026-08-22 (revision item 12, S1) — "materially below" had no
   number, against a population that already shows ~2x same-condition spread.** Pass: `N_capped`
   at least 30% below `N_uncapped`, with both values coming from arms that passed step 2a/3a. Record
   the population table's baselines (`f272fda8`=19,219, `d92e6b85`=11,056, `0762e872`=9,880 — all
   properly-finished pre-fix sonnet runs, confirmed this revision by reading each run's final
   report text) alongside the two new numbers as context for where they land relative to history,
   but do not gate pass/fail on them directly — they were measured under different diffs and
   different reds, which is exactly the comparability problem this A/B design exists to remove.
   **If the delta is below 30%, or falls inside that historical spread (roughly 9,880-19,219),
   record the result as inconclusive rather than a pass or a fail, and run a second A/B pair**
   (a fresh deliberate break, same task text) before drawing a conclusion — one pair alone, with
   each arm's own `implement` step writing a different diff, cannot separate a real capping effect
   from ordinary run-to-run variance at this population's measured scale.
5. **Detection check, folded into the same two runs rather than a separate step.** Confirm each
   arm's own `.ndjson` names the deliberately-broken test's failure verbatim under
   `stepId: "run-tests"`: `grep '"stepId":"run-tests"' <runId>.ndjson | grep -F '<broken test
   name>'` (the same file step 2/3 already grep for the token count, and it demonstrably carries
   gate output — 220 `gate-test.log` / `npm test` matches in run `70f19253`'s own `.ndjson`). The
   prompt's saved gate-output log (`types.ts:775-776`, e.g. `/tmp/gate-test.log`) is a fallback
   only — the prompt shows that path as an example, not a mandated one, and per-run `TMPDIR` is
   redirected and cleaned (#785), so the file is not guaranteed to survive past the run. This does
   not contradict `run-tests`'s own "FIX the code and re-run until they pass" contract: if an arm's
   report shows it fixed the regression (reverted the flip) and re-ran green, that is `run-tests`
   working correctly, not a defect; if it left the test failing, the report must name it and must
   not claim the suite passed. The one failure mode this rules out is the `.ndjson` showing the
   break and the final report claiming green with no mention of it in either arm — that, and only
   that, is "a gate silently passed."
6. Update the Phase 4 step 0 todo with `N_capped`, `N_uncapped`, the delta (and whether it clears
   the 30% bar or is recorded inconclusive per step 4), confirmation that both arms passed step
   5's detection check, and confirmation that both arms were cancelled (step 2b/3b) and never
   reached `commit-push` or `deploy` — this is the write-up; no other step's `document` sync is
   involved.

## Data models

`workflowStepSchema` (`packages/cezar/src/workflows/types.ts`):

```ts
effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
```

Round-trips through `workflowDefSchema` the same way `model` does today — no `.catch()` needed
beyond what the object schema already provides, since an invalid value is a schema violation at
write time (workflow YAML / `POST /runs`), not a corrupt-record-on-read case the way store
fields with `.catch(undefined)` are.

`AgentRunSpec` (`packages/cezar/src/core/agent-runner.ts`):

```ts
/** claude CLI's own `--effort` (low|medium|high|xhigh|max). Claude-only — the codex and
 *  opencode runners never read this field, same as bashAllowlist is decorative for them.
 *  No env-side mirror: the CLI does not read `CLAUDE_EFFORT` as input (measured — see
 *  .ai/specs/2026-08-21-run-tests-reasoning-ceiling.md, Revision note), so the flag is the
 *  only signal. */
effort?: string;
```

## API contracts

None added; `GET /api/v1/workflows` already serializes each step object wholesale (the same
mechanism `.ai/specs/2026-08-21-per-step-model-policy.md` relied on for `model` to appear with
no route change), so `effort` appears on `run-tests` in that response automatically once Phase
1 lands.

## Risks

- **Choosing one notch down (`medium`, not `low`) is still a judgement call, not a measurement.**
  The starting point is now measured (Revision note above: a cezar-spawned `run-tests` step with
  no `--effort` flag runs at `high`), but how far down to cut from it is not. If `medium` turns
  out too low, the observable failure mode is a gate that genuinely needed more reasoning going
  unexplained or mis-diagnosed — which is exactly what Phase 4 steps 1/5 (deliberately break a
  test, then confirm both arms detect and report it) are designed to catch before this ships as
  "done." If it turns out too high to matter, Phase 4 step 4's `N_capped` vs. `N_uncapped`
  comparison catches that too. Either way the fix is a one-constant change, not a re-design.
- **The prompt clause may not move behavior at all**, per this repo's own precedent
  (`notion-cc6ebabb2ab4`, the batching prompt that shipped and didn't move the batch factor).
  This is why Phase 1 (the mechanical cap) does not depend on Phase 2 working, and why Phase 4
  measures the combined effect rather than crediting either lever separately.
- **`--effort` is unversioned in cezar's own contract with the CLI.** It is read from `claude
  --help` on the currently pinned binary (`2.1.233`); if a future CLI version renames or drops
  the flag, `buildClaudeArgs` would pass a value the CLI silently ignores or rejects. No
  detection mechanism is added for this here — the same exposure already exists for `--model`
  (`.ai/specs/2026-08-21-per-step-model-policy.md`'s own Risks section: "If the CLI ever stops
  accepting a bare alias, `normalizeModelForBackend` fails loud" — but `--effort` has no
  equivalent resolver to fail loud, since there is nothing to normalize). Worth a follow-up if
  it ever bites, not blocking here.
- **A future step could set `effort` without understanding the cap's intent** and silently
  under-power a step that genuinely needs deep reasoning (e.g. `review-spec`, which is
  read-only judgement work the opposite of what this spec targets). Mitigated by scoping Phase 1
  to `run-tests` only and leaving every other step's `effort` unset — this spec makes no claim
  about any other step.
- **`--effort` is documented only as "Effort level for the current session," with no stated
  behavior under `--resume`.** `spec.resume` spawns `claude --resume <sessionId>` for a
  continuation rather than a fresh session (`claude-cli-runner.ts:707-712`); whether a resumed
  process re-applies `--effort` from the new invocation or keeps whatever level the original
  session started at is not documented and not tested by this spec. Immaterial to `run-tests`
  itself (`spec-to-deploy` never resumes it — each run is one fresh session per step), but worth
  a follow-up before `effort` is set on any step that a user might resume interactively.
- **Argv order between `--resume` and `--effort` is immaterial, confirmed by reading
  `buildClaudeArgs`.** `--resume <sessionId>` is pushed at `claude-cli-runner.ts:707-712`, before
  `--effort` would land alongside `--model` at `:722` — both are independent flag/value pairs on
  the same argv array, not positional arguments, so the order they're pushed in has no effect on
  what the CLI parses. Noted here only because the two lines sit far apart in the same function
  and it is not obvious without reading both.

## Verification

1. **Unit (automated).**
   - `claude-cli-runner.test.ts`: `--effort` emitted correctly when set, omitted when not.
   - `types.test.ts`: `run-tests.effort === 'medium'`, every other step's `effort` is
     `undefined`; the `run-tests` prompt contains the diagnostic-depth stop condition and the
     "quote verbatim / never re-explain" instruction.
2. **Gates.** `npm run typecheck`, `npm run build` green under the scrubbed environment AGENTS.md
   § Validation prescribes (all four traps, now five after Phase 3). **`npm test` itself is not
   green on this box at baseline** — todo `c78140a8-55b0-4cc2-8d52-d2be468916fe`, still `status:
   todo`, records 2,152 pre-existing failures (React 19 `React.act` + `TMPDIR`-inside-repo, see
   Problem's "does not apply" note) independent of any change here, and this spec does not fix
   that gate. The scoped subset this spec's own changes are actually verified against — the same
   subset `implement` ran — is `npm test -- src/workflows src/core/claude-cli-runner.test.ts`,
   green (380/380, 29/29 files). Treat that scoped command, not a bare `npm test`, as this
   verification step's gate.
3. **Runtime — Phase 4, executed for real, not assumed, as a controlled A/B (revision item 10,
   D2).** Phase 4 step 0's todo is filed before either run; one test is deliberately broken on a
   throwaway branch shared by both arms, reached via a `config.baseBranch` swap restored after both
   arms fork (step 1); Arm A (built-in `spec-to-deploy`, `effort: medium` in effect) and Arm B (a
   `.ai/cezar/workflows/spec-to-deploy.yaml` override with `run-tests`'s `effort` key removed,
   written and deleted around the trigger — revision item 11) each trigger a `spec-to-deploy` run
   and reach `run-tests` on sonnet; each arm's own
   `usage.updated` for `stepId: "run-tests"` is extracted as `N_capped` / `N_uncapped`; every gate
   either arm names shows its quoted `EXIT=`-shaped marker in that arm's own `.ndjson` (Phase 4
   step 2a/3a — rules out the four confirmed "cheap by not finishing" instances, including this
   task's own `run-tests` step, `95d3c6f2`); both arms' `.ndjson` name the deliberately-broken
   test's failure verbatim under `stepId: "run-tests"` (Phase 4 step 5 — detection proven for both
   arms; the saved gate-output log is a fallback only) and neither arm's final report claims a
   green suite while that failure is unaddressed in its own record (no silent pass); `N_capped` is
   at least 30% below `N_uncapped`, or the result is recorded inconclusive and a second pair run
   (revision item 12, S1); both arms are cancelled (`POST /runs/:id/cancel`) immediately after
   their own `run-tests` `step-end` and neither reaches `commit-push` or `deploy` (Phase 4 step
   2b/3b — revision item 12, D1); the todo is updated with both numbers and the outcome.
4. **In-band.** `GET /api/v1/workflows` on the deployed server reports `effort: "medium"` on
   `run-tests` and no `effort` field (or `undefined`) on every other step of the built-in
   `spec-to-deploy` definition.

**Outcome recorded 2026-08-22 — item 3 above (Phase 4) did NOT run.** `implement`'s second
pass found the design step 3 itself describes (2b/3b: cancel each arm right after
`run-tests`'s own step-end) unsafe as written — the step-end-to-commit-push gap measures
1-4ms across all 11 sampled runs, unwinnable by any external `POST /runs/:id/cancel`, so
both arms (one carrying a deliberately-broken test) would reach a real `git push` and
`deploy` before the cancel could land. Items 1, 2 and 4 passed as written (unit tests
present, scoped gates green, `effort: "medium"` confirmed live on the deployed
`spec-to-deploy` workflow after commit `16eb7a24`/`966a832b`). Item 3 is deferred to todo
`ef4f65f7-0621-41d2-ad33-b7bce4ac916d`, which redesigns the mechanism (a `POST /runs` with
an inline 5-step array terminating at `run-tests`, removing the cancel race entirely) before
re-attempting the A/B. Acceptance criterion 4 of the originating todo (`33ce6584`) —
tokens measured below 20,000 on a comparable run — stays unverified until that todo closes.
