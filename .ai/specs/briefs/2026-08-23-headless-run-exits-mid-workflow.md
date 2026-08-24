# Brief — headless `cez run` exits 0 mid-workflow, run record stuck `running`

**For task eeceb869. Gather-the-record step only — no spec, no code written here.**

## The problem, in this repo's own terms

`npm run test:package` (`packages/cezar/test/e2e/package-cli.test.ts:14`, "the release
tarball installs and runs the dry-run CLI workflow") installs the packaged tarball and runs
`node dist/index.js run mock:done --repo <fixture>` with `CEZ_DRY_RUN=1`, then asserts
`run.stdout` matches `/run (done|review)/` (`:86`) and `.ai/cezar/runs.json` holds one row
with status `done`/`review`. Reproduced by hand per the handoff: the CLI prints `run started`
/ `worktree ready` / `── step: Gather the record`, then **exits 0** — no error, no further
step output — while the run record is left at `status: 'running'` forever. Exit 0 makes this
silent: nothing downstream (CI, a caller polling the run) can tell the difference between
this and a real success.

Confirmed pre-existing at clean `a5f04b0f` and `387ba439` (handoff), with no diff and a full
`CEZ_*` scrub, so this is not caused by task 737eba99's own change.

## What the record already decided — with citations

**This exact test, this exact failure shape, was already found and fixed once — read that
fix before doing anything else.**

- `.ai/specs/briefs/2026-08-22-run-broker-cli-stall.md` and
  `.ai/specs/2026-08-22-run-broker-cli-keepalive.md` diagnose and fix a CLI-exits-0-while-
  running-0-status defect in the exact same test, same task string (`mock:done`), same
  symptom (`run.stdout` never reaches a terminal line, `runs.json` stuck `running`). Root
  cause there: `BrokeredSession`'s spool-poll timer was constructed `unref()`'d
  (`brokered-session.ts`, pre-fix), and the moment the first control-socket connect to
  `ctl.sock` failed fast (a normal broker-startup race), **every** handle in the one-shot CLI
  process was unref'd/gone, so Node's empty-event-loop drain exited the process at t≈50ms —
  before the run's first agent turn was ever sent, and independent of the still-unsettled
  `BrokeredSession.result` / `runCommand` promises.
- Fixed by commit `3e6d1b7e` (2026-08-22, confirmed **present on current HEAD** —
  `git merge-base --is-ancestor 3e6d1b7e HEAD` → yes, 147 commits ago): P1 stops `unref()`-ing
  the poll timer while a session is genuinely open (`brokered-session.ts:158-162`, comment:
  *"this is the ONLY handle that keeps a one-shot `cezar run` process alive… `finish()` and
  `detach()` both `clearInterval` it the moment the session reaches a terminal state"*); P2
  wires the give-up path to actually reject `result` instead of hanging silently. The spec's
  own status line records `npm run test:package` **15/15** at the time, including this same
  test, verified both by the automated suite and a direct manual repro against the built CLI.
- **AGENTS.md § "the sharp edges..." item 5** (root `AGENTS.md`, not `packages/cezar`) has a
  correction appended to the original finding, dated 2026-08-22: *"the canonical todo
  (`c895a348`) is now `status: 'done'`... This red may no longer reproduce; if it does, that
  is new information, not a re-confirmation of this entry."* **That is exactly the situation
  now** — do not re-diagnose the fixed mechanism (the within-step control-socket race); treat
  this as new information about a different mechanism in the same test.

## What is actually involved — code map, verified against current HEAD

**Workflow selection for `cezar run mock:done` (no `--workflow` flag).** `mock:done` is pure
task/prompt text — grepped the whole package, it has no special-case handling anywhere; it
only appears as literal test-fixture text. Selection is purely:
`packages/cezar/src/index.ts:1003` `const name = workflowName ?? DEFAULT_WORKFLOW_NAME` →
`DEFAULT_WORKFLOW_NAME = SPEC_TO_DEPLOY_WORKFLOW.name` (`workflows/types.ts:1152`) = the
real **8-step** `spec-to-deploy` chain: `context` ("Gather the record", `types.ts:696`),
`spec`, `review-spec`, `implement`, `run-tests`, `commit-push`, `document`, `deploy`
(`types.ts:696,760,805,870,900,974,1026,1102`).

**The handoff's stated hypothesis names commit `097d1b15` — that is imprecise; correct the
record before spec'ing off it.** `097d1b15` ("default ALL run paths to spec-to-deploy",
2026-08-20 09:53) only touches `automations/task-template.ts` and web integration fallbacks
(GitHub/bookmarklet/automations-create) — it never touches `packages/cezar/src/index.ts`.
The commit that actually flips the **CLI**'s default from `quick-task` to `spec-to-deploy`
is **`5e388ccf`** ("cezar autosave (run finalize)", 2026-08-20 10:00:24, i.e. *after*
`097d1b15`), whose diff to `index.ts` is exactly:
`- const name = workflowName ?? 'quick-task';` / `+ const name = workflowName ?? DEFAULT_WORKFLOW_NAME;`
(also the `--workflow` help text, same commit). Before `5e388ccf`, `cezar run mock:done`
with no flag ran the **1-step** `QUICK_TASK_WORKFLOW` (`types.ts:283`, one step, id `task`,
prompt `{{task}}`) — a shape with no inter-step gap at all. `5e388ccf` is an autosave commit
bundling a full day of unrelated spec/doc/fixture changes (52 files), so it is not a clean
bisect target by itself; **`git bisect` against the actual repro, not this reasoning, is
still required** per the acceptance criteria — this citation only narrows where to start.

**Why the *already-fixed* mechanism and the *current* failure are not the same bug.** The
3e6d1b7e fix ref's the poll timer only *while a session is genuinely open*, and clears it
(`brokered-session.ts` `finish()`/`giveUp()`/`detach()`) the instant that ONE step's session
reaches a terminal state — by design, scoped to a single `BrokeredSession`. `run.ts` builds a
**new** `BrokeredSession` per step (`brokerFor()`, `run.ts:2013-2036`, consumed at the
per-step call site `run.ts:5423`), and the broker child itself is spawned `detached: true` +
`proc.unref()` immediately (`claude-cli-runner.ts:492,498`) — deliberate, so the launcher
never holds a pipe to a process meant to outlive it. Between step N's `finish()` (interval
cleared) and step N+1's `new BrokeredSession(...)` (`setInterval` re-armed), the CLI's only
ref-holding handle is gone; the process stays alive across that gap **only** if something in
the intervening orchestration is itself doing real, ref-holding async I/O at that instant.
`brokerFor()`'s own orchestration is a mix: `this.store.updateRun(...)` (`run.ts:2025`) is a
**synchronous** method (`runs/store.ts:853`, no `Promise`, in-memory + scheduled flush), while
`await this.runResourceLimits()` (`run.ts:2033`) awaits `loadWorkspaceConfig()`
(`workspace/config.ts:388`), a real `fs` read whose caching behaviour I did **not** verify
(open question below). **Hypothesis, not yet proven at runtime:** on a run where that
intervening work resolves fast enough (or is already cached) relative to the next step's
broker/timer re-arming, the event loop finds nothing ref'd and Node's ordinary empty-loop
drain exits the process — the same *class* of bug 3e6d1b7e fixed (nothing holds the loop
between "current handle gone" and "next handle not yet created"), but at a **step-transition
boundary in a multi-step chain** rather than *within* one step's broker-startup handshake.

**This would explain why it wasn't caught by 3e6d1b7e's own verification.** That spec's
manual repro (`CEZ_DRY_RUN=1 … run mock:done` → `run done`) and the 15/15 suite pass are
dated 2026-08-22, i.e. *after* `5e388ccf` had already made `mock:done` drive the 8-step
chain — so the fix WAS tested against the multi-step shape and passed at the time. An Explore
sub-agent run for this brief built `dist/` fresh from current HEAD and ran both the manual
repro and the actual e2e test twice; **both passed** (8/8 steps, exit 0, status `done`) — the
bug did **not** reproduce deterministically in a lightly-loaded environment. This matches
`brokered-session.ts:38-42`'s own measured note that broker socket-accept latency is
load-sensitive (p50 621 ms / max 716 ms at load average 7.68 on `prod-host`) — the
between-step gap this brief hypothesizes is very plausibly a **race that only manifests under
load**, which fits the origin report (found by a *gate run*, i.e. on a loaded shared box) and
means a fix here needs a verification strategy that doesn't rely on one clean local run
passing (see open questions).

**A genuinely lightweight workflow still exists** — `QUICK_TASK_WORKFLOW`
(`workflows/types.ts:283`, `name: 'quick-task'`), still loaded by `loadWorkflows`
(`workflows/load.ts:71-76`). Pointing the e2e test at it explicitly (`--workflow quick-task`)
would sidestep the multi-step gap entirely, but per the acceptance criteria the actual defect
to fix is the CLI's silent-exit-0-while-running behavior, not this one test's workflow choice
— the third AC line (*"headless `cez run` never exits 0 while its run record is still
'running'"*) is a general correctness property of the one-shot CLI/broker path, independent
of which workflow a caller happens to run.

**Dry-run mechanics that are NOT the cause:** `postconditions.ts:70-87,334` confirms every
step's `verify:` postcondition short-circuits to a green `dryRunVerdict` under
`CEZ_DRY_RUN=1` — later steps' gates (`commit-push`'s `everything-committed`, `deploy`'s
probes) cannot be the blocker under dry-run. `broker-launch.ts:50-61` confirms brokering only
applies to the `claude` backend and only in a built tree (both true for this test).

## Prior decisions this would contradict, if unaddressed

- `.ai/specs/2026-08-22-run-broker-cli-keepalive.md`'s own status line claims `npm run
  test:package` **15/15**, "the originally-failing test 5 now passes" — that claim needs a
  status correction once this brief's finding is confirmed (it was true for the mechanism it
  fixed, at the time it was measured; it does not hold as a durable guarantee for the CLI
  path in general).
- Root `AGENTS.md`'s "The method, which generalises past all five" section (item 5 of the
  sharp-edges list) explicitly warns against treating "fails identically at clean HEAD too"
  as proof the code is innocent — the handoff already did the right thing here (proved it at
  two clean commits with an env scrub) and correctly stopped short of declaring it
  unfixable/environmental. This brief's job was the next step that method calls for: name the
  shared thing (the per-step broker/timer handoff) and read it directly.

## Open questions a spec will have to settle

1. **Runtime confirmation, not just code reading.** Nothing above was proven live — the one
   attempt to reproduce this session did not trigger the failure. A spec needs either (a) a
   way to force the race deterministically (e.g. inject latency into `runResourceLimits`/
   `updateRun`/the next step's broker spawn, or shrink `SPOOL_POLL_MS` timing assumptions
   under a test hook) or (b) a loop-N-times / artificial-load repro strategy, before claiming
   a fix actually closes the gap rather than just narrowing its window.
2. **Where exactly does the ref-holding handle disappear, precisely (line-level), across a
   step transition?** This brief traced the shape (`finish()` clears the old timer;
   `brokerFor()` + `attachBroker()` eventually create the new one) but did not instrument a
   real run to catch the exact tick where zero handles exist. `loadWorkspaceConfig()`'s
   caching behavior (does a second call within one process resolve via real I/O or an
   already-resolved promise?) is specifically unverified and matters for how tight the window
   is.
3. **Fix shape.** Candidates the AC leaves open: (a) a keep-alive handle owned by the CLI's
   `runCommand`/`RunManager` itself, ref'd for the run's entire lifetime regardless of
   per-step session state (would also cover any other future gap of this shape, not just this
   one); (b) closing the specific gap inside `brokerFor()`/the step-transition path; (c)
   detecting the drained-process case after the fact and failing loud rather than silent
   (weaker — AC3 explicitly wants no exit-0-while-running, not just a better error after it
   already happened). (a) reads as the more structurally sound fix given this is the SECOND
   time a variant of "nothing refs the one-shot CLI's event loop" has caused this exact
   symptom.
4. **Bisect target.** `git bisect` should be run for real per AC1 — this brief's citations
   (`5e388ccf` as the CLI-default-flip commit) are a strong lead, not a substitute; the actual
   red might not even be bisectable to one commit if it's a load-sensitive race that "passes"
   on a quiet bisect runner and "fails" only on the loaded gate-run box, which itself would be
   an important finding to record if it happens.

## What I could not find

- No open todo for this exact recurrence (`cezar todo list` returned "no todos filed"; the
  only related todo, `c895a348`, is closed `done` and superseded by 3e6d1b7e).
- No runtime trace of the actual failure from this session — see open question 1.
- Did not verify `loadWorkspaceConfig()`'s caching semantics (sync-fast on repeat calls vs.
  real I/O each time) — flagged as open question 2, directly relevant to whether the
  hypothesized gap is real.

## Citations index

- `packages/cezar/test/e2e/package-cli.test.ts:14,86`
- `packages/cezar/src/index.ts:1003-1004` (workflow selection), `:698-703,1076-1080` (older
  line numbers per `5e388ccf`'s diff context)
- `packages/cezar/src/workflows/types.ts:283` (`QUICK_TASK_WORKFLOW`), `:690-1152`
  (`SPEC_TO_DEPLOY_WORKFLOW`, `DEFAULT_WORKFLOW_NAME`)
- `packages/cezar/src/core/brokered-session.ts:130-230` (constructor, `tick()`, `finish()`)
- `packages/cezar/src/core/claude-cli-runner.ts:401-521` (`spawnBroker`, `proc.unref()` at
  `:498`)
- `packages/cezar/src/workflows/run.ts:2013-2036` (`brokerFor`), `:5395-5423` (per-step
  broker/reattach decision)
- `packages/cezar/src/runs/store.ts:853` (`updateRun`, synchronous)
- `packages/cezar/src/workspace/config.ts:388` (`loadWorkspaceConfig`)
- `packages/cezar/src/workflows/postconditions.ts:70-87,334` (dry-run short-circuit)
- Commits: `3e6d1b7e` (prior fix, present on HEAD), `097d1b15` (unattended-paths default,
  does NOT touch CLI), `5e388ccf` (autosave — actually flips CLI default), `37a9a978`
  (doc-only), `a5f04b0f`/`387ba439` (handoff's clean-repro points, both descendants of all
  the above)
- Specs: `.ai/specs/2026-08-22-run-broker-cli-keepalive.md`,
  `.ai/specs/briefs/2026-08-22-run-broker-cli-stall.md`,
  `.ai/specs/2026-08-19-spec-to-deploy-default-workflow.md`
- `AGENTS.md` (root) § sharp-edges item 5 and its 2026-08-22 correction
