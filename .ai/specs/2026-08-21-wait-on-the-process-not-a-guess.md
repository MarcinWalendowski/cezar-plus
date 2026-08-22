# Wait on the process, not on a guess — and slice the file you already saved

> **Status — IMPLEMENTED, SHIPPED, DEPLOYED AND NOW MEASURED (revision 8, 2026-08-22). All four
> phases are done.** Phases 1-3 shipped in `ada8f376` and are deployed to `/opt/cezar`. **Phase 4 —
> the after-run that decides whether any of it worked — has now been measured and it PASSES:** run
> `bde0ec40-06da-4628-8410-06a6a42694c7` scores **`blindSleepCalls` 0** (whole run),
> `sleepCalls` 5, `sleepExecMs` 16.5 s, `repeatedExpensiveCalls` 0, `batchFactor` 1.00 — against
> baselines of 4 blind / 18 sleeps / 13.4 min / 18 re-runs (`7c2dd8f0`) and 2 blind / 14 sleeps /
> 42.2 min / 0 re-runs (`c10864d1`). All four surviving executed sleeps are the doctrine's own
> tier-3 idiom (`until grep -q "^EXIT=" …; do sleep N; done`); the fifth hit is a quoted mention.
> The numbers, the full per-`stepId` command dump, the (a)/(b)/(c) classification, the attribution
> argument and the one criterion that needed a `document`-step gate re-run to pass are in
> **§ Verification §4 → Result**, with the re-run's own markers in § Verification §5.
> **This spec claims the four counters, not a green suite.** The `document` gate re-run returned
> `EXIT=0` for `npm ci`, `typecheck` and `test:unit` and `EXIT=1` for `npm test`, on 3 pre-existing
> failures of 9634 that a one-markdown-file branch cannot have caused — 2 load flakes that passed on
> re-run, and one reproducible index-build budget failure filed as todo
> `90b00d11-b564-42ec-ae10-08bf057e5813`. See § Verification §5.
> ~~superseded 2026-08-22 by revision 5 (below): PHASES 1-3 IMPLEMENTED AND SHIPPED
> (`ada8f376`) AND NOW CONFIRMED DEPLOYED to `/opt/cezar`; Phase 4's after-run is DESIGNATED AND
> IN PROGRESS (run `bde0ec40-06da-4628-8410-06a6a42694c7`) — not yet measured, because this is the
> `spec` step of that same run and `run-tests`/`document` have not executed yet.~~ ~~superseded
> 2026-08-21 by revision 4 (below): PHASES 1-3 IMPLEMENTED AND SHIPPED (`ada8f376`, on
> `origin/main`); Phase 4 — the after-run that decides whether any of it worked — STILL
> OUTSTANDING, tracked as todo `ea54dd16-5913-4b8a-bbc8-d3b1db9da66c`.~~ ~~superseded 2026-08-21 by revision 3 (below):
> PHASES 1-3 IMPLEMENTED, Phase 4 outstanding.~~ ~~SPEC ONLY — nothing implemented.~~ That line was true when the `spec` step wrote
> it and is false now; the `implement` step of the same run shipped L1-L3. Written in the `spec`
> step of run `70f19253-cf6b-407c-92e0-96a8020a8ebb`, from the brief left by that run's `context` step
> (`.ai/specs/briefs/2026-08-21-stop-guessed-sleep-waits.md`). ~~No code, prompt or test has been
> changed by this step.~~ — true of the `spec` step, superseded by revision 3. · **Date:** 2026-08-21
>
> **Origin:** owner observation on 2026-08-21 — *"tests are taking a lot of time and are run many
> times"* — measured in kb `local:2026-08-21-cezar-run-speed-measured`
> (`notion-cc6ebabb2ab4`), whose recommendation #1 is this task verbatim: *"Replace guessed
> `sleep N` with waiting on the process in the tool-budget/run-tests prompt, and add a carve-out:
> redirect an expensive command's output to a file once, then slice the file."*
>
> This spec changes **agent-facing prompt text and four derived metrics** (revision 1 said two; the
> shipped count is four — see § Data models). It changes no route, no stored schema and no run
> protocol.

> ### Revision 2 — 2026-08-21, after review
>
> **Every number in revision 1's § Problem, § Analytics and § Verification §3 is superseded by the
> tables below.** Rev 1 counted sleeps over *matched `tool-call`→`tool-result` pairs*; that join
> silently drops any call with no recorded result, and on `7c2dd8f0` it dropped **2 of 19** — one
> of them the flagship blind `sleep 120; tail -12 /tmp/full-suite-mine.log` that § Problem quotes
> as the archetype of the defect. A defect counter whose target is zero must never under-report,
> and a `sleep` that never returned is the one you most need to see. **The predicate is now
> defined over `tool-call` events**, which is also what `computeRunStats` already does.
>
> Three further corrections, all from re-measuring rather than re-reading:
> 1. **The re-run half of the ask now has a meter** (`repeatedExpensiveCalls`, § Data models). Rev 1
>    called it "the biggest single item" and then shipped it unfalsifiable. Baseline measured: **18
>    repeated expensive calls / 5.9 min on `7c2dd8f0`**, headed by one test file run **11 times**.
> 2. **The blind-sleep predicate mislabels heredocs in *both* directions, and naive stripping does
>    not fix it** — measured net-zero. The refined predicate and the evidence are in § Data models.
> 3. **`run_in_background` is gone from the doctrine text.** Rev 1 claimed the text "names no
>    backend-specific tool" while proposing a Claude-specific parameter. The claim is now true.

> ### Revision 3 — 2026-08-21, implemented
>
> **Superseded 2026-08-22 by revision 8: Phase 4 has now run and passed** (`blindSleepCalls` 0 on
> `bde0ec40`), so the admissibility bar this paragraph sets is met and a saving *is* now
> demonstrated — see § Verification §4 → Result. Original text, unchanged:
>
> ~~**Phases 1-3 are shipped and green. Phase 4 (the after-run) is still outstanding** and cannot be
> satisfied by this run — § Verification §4 stands unchanged as the thing that decides whether any
> of this worked. Until it has run, this spec has changed prompt text and shipped a meter; it has
> **not** demonstrated a saving, and no speed claim from it is admissible (R5).~~
>
> What landed, against the plan:
>
> 1. **The doctrine is 252 words against a cap of 260** — R1's preferred option, measured by the
>    test's own counting rule, not the 240-word terse fallback. The old cap's comment was replaced
>    with the argument for the raise, so the next session inherits the reasoning.
> 2. **§ Verification §3 reproduces exactly**, through the shipped code path, on the real
>    transcript: `7c2dd8f0` → `sleep 18 blind 4 execMin 13.4 rerun 18`. `c10864d1` → 14 / 2 / 42.2
>    / 0 and `7aecd6a2` → 4 / 1 / 5.6 / 0 match § Problem's table too. `e06f2169` has since landed
>    and now reads `rerun 1` (it was 0 mid-flight, as § Problem said its row would move).
> 3. **Three divergences from this spec's own text, all deliberate:**
>    - §V1's `toContain('never end your turn while it runs')` ships as
>      `toMatch(/never end your turn\s+while it runs/)`. The clause spans a line break in the
>      doctrine, so the literal assertion fails. The **assertion** was fixed, never the text —
>      wrapping the doctrine to satisfy a test would be the tail wagging the dog.
>    - **Every verification command uses `npm test -- <path>`, not `npx vitest run`.** `AGENTS.md`
>      § Validation forbids `npx vitest` outright: vitest is a devDependency here, and `npx` reaches
>      past the pinned binary to fetch a different version off the registry — a slow, networked,
>      silently-different run. The spec's `npx` spellings are wrong for this repo; read them as
>      `npm test -- …`.
>    - **Phase 3 step 3 took the "assert over inline events" option, not a new fixture file.** Every
>      command in those tests is a real one copied from the box's transcripts, and the R7 trap is
>      pinned explicitly instead: a test now asserts that `ec6e8e06-trimmed.ndjson` reports zero
>      *because its `input` was stripped*, beside its 271 real tool calls, so the zero cannot be
>      misread as a measurement.
> 4. **Four test failures during implementation were all documented environment traps**, none of
>    them this change: `stats-cli-wiring` ×2 (trap 4 — `TMPDIR` is inside the git repo in a cezar
>    agent session), `agent-profile-wiring` and `workspace-parallel` (trap 2 — a cockpit session
>    exports `CEZ_*` knobs the server suites assert on). All three suites pass under `AGENTS.md`'s
>    documented scrub. This is the trap that block warns about, hit exactly as described.

> ### Revision 4 — 2026-08-21, shipped and recorded (the `document` step)
>
> **Shipped:** commit `ada8f376` — *"the wait had no mechanism, so agents guessed a sleep — wait on
> the process instead"* — is on `origin/main` (verified here with `git branch -r --contains`, not
> taken from the handoff: the premise "implemented, tested and shipped" is exactly the one kb
> `local:2026-08-20-backgrounded-gate-outlives-its-step` lesson 3 says a downstream step must check
> for itself). Working tree clean.
>
> **Gates, as run by the `run-tests` step and reported without rounding up:** `npm run typecheck`,
> `npm run test:unit` and `npm run build` green. Two reds, and **both reproduce at clean `HEAD`**,
> so neither is attributable to this change: `npm test` → 2 files of 516 (`knowledge/catalog` C18,
> the host-dependent 40 ms/MiB budget in `AGENTS.md` trap 3, and one recorded flake that passes
> alone), and `npm run test:package` → the release-tarball CLI E2E, localised by A/B to the run
> **broker** (`CEZ_RUN_BROKER=0` makes the identical run finish) and filed as todo
> `3c6a5aa7-9492-40ff-902b-c2db042dd9e5`. Neither red is in a file this change touches.
>
> **§4's snapshot of this run is superseded by its final count.** §4 says `70f19253` "made 3 sleep
> calls totalling 0.0 min"; that was mid-flight. Final, through the shipped meter:
> `sleep 0 blind of 9 (362.3s waited) · 0 expensive call(s) re-run`, batch factor 1.02 over 290
> calls. **This is not evidence that the change works**, and must not be quoted as such: the
> deployed bundle `/opt/cezar/packages/cezar/dist/index.js` was built at 19:00, ninety minutes
> *before* this commit, so every step of this run was composed by the OLD doctrine. What the zero
> does show is that the defect is not universal — an agent can already reach for a guarded poll
> loop unprompted, which is why the after-run must be compared against `7c2dd8f0` (4 blind / 18
> sleeps / 802.1 s / 18 re-runs) and not against a hoped-for population average.
>
> **Recorded:** kb proposal in this run's `*.knowledge.ndjson` (one new note + one changelog entry
> + three `supersede` ops against `notion-cc6ebabb2ab4`, `notion-38870ddae120` and
> `notion-b3c7402826d6`), pending review via `cez kb proposals`. Todo `eb6e528b` closed; the
> after-run filed as a new todo.

> ### Revision 5 — 2026-08-22, the `spec` step of the designated after-run (`bde0ec40`)
>
> **This is the spec-writing contribution to Phase 4, not Phase 4's completion.** Per this step's
> own instructions ("You are writing a SPEC for the task below. You are NOT implementing it in
> this step"), nothing below was executed here — `run-tests` and `document` have not run yet in
> this same run. What this revision does: confirms deployment landed, designates the run that will
> serve as the measurement, and pins the exact commands the later steps of *this same run* must
> execute so § Verification §4 stops being abstract.
>
> **1. Deployment is now confirmed, not assumed.** Revision 4 flagged that `/opt/cezar` was built
> *before* `ada8f376` and therefore attributed nothing. Re-checked now, on this box:
> `/opt/cezar/packages/cezar/dist/index.js` (and its component modules) were rebuilt
> **2026-08-22T01:43:30Z** — `stat` confirms Modify time, cross-checked against
> `git merge-base --is-ancestor ada8f376 HEAD` (true) and `ada8f376`'s own commit timestamp
> (2026-08-21T20:32:12Z, `git show -s --format='%ci'`). The rebuild is nearly 5 hours after the
> commit, and grepping the deployed bundle directly (not inferring from the timestamp) finds every
> Phase 1-3 artifact:
> - `/opt/cezar/packages/cezar/dist/workflows/run.js` contains `never on a guess` and
>   `never re-run an expensive command` (Phase 1, the doctrine bullet).
> - `/opt/cezar/packages/cezar/dist/workflows/types.js` contains `QUOTE the` and
>   `exit-marker line` (Phase 2, the `run-tests` step's L4 marker-quote requirement —
>   `packages/cezar/src/workflows/types.ts:876-878` in this worktree today).
> - `/opt/cezar/packages/cezar/dist/runs/stats.js` contains `blindSleepCalls` (Phase 3, the meter).
>
> **2. This run is the designated after-run.** `bde0ec40-06da-4628-8410-06a6a42694c7`
> (branch `cez/bde0ec40`, workflow `spec-to-deploy`) is the run this `spec` step is itself running
> inside. Its worktree birth time is **2026-08-22T01:43:59Z** — **28.9 seconds after** the dist
> rebuild above (`stat` on the worktree directory; the gap was computed, not eyeballed, so it isn't
> a coincidence of clock skew). Every step of this run, including this one, has its system prompt
> composed from the deployed `TOOL_BUDGET_DOCTRINE` — the new one. `spec-to-deploy`'s eight steps
> (`packages/cezar/src/workflows/types.ts`, step ids at absolute lines 630 `context`, 694 `spec`,
> 738 `review-spec`, 802 `implement`, 832 `run-tests`, 884 `commit-push`, 936 `document`, 1012
> `deploy` — **corrected 2026-08-22, revision 6**: an earlier draft of this line gave these as
> offsets from a re-read anchored at line 624 and printed them as if absolute) include a real
> `run-tests` step (`:832-882` in this worktree) that runs the repo's full gate
> suite — exactly the requirement revision 4 named ("a `spec-to-deploy` run that actually executes
> a `run-tests` step, started after this change is deployed"). No other run needs to be started.
>
> **3. What `implement` (this run's next-but-one step) has to do: nothing code-shaped.** Phases
> 1-3 are already on `HEAD` (`ada8f376` is an ancestor, confirmed above) and already deployed.
> There is no further code change this spec calls for. `implement` should find the working tree
> already matching the spec and report that, rather than inventing a change to make — inventing
> one would itself be a `repeatedExpensiveCalls`-style violation of the doctrine this spec is
> about. `run-tests` still runs for real: the gate suite it executes is the only thing that can
> populate `sleepCalls`/`blindSleepCalls`/`sleepExecMs`/`repeatedExpensiveCalls` with real data.
>
> **4. What `document` (this run's step 7) must do, exactly — run the commands pinned in
> § Verification §4 below (revision 6 corrected them: `--repo` and absolute paths, because
> `document` runs from this worktree, whose `.ai/cezar/runs/` is empty — the transcript only
> exists at the workspace root), read the whole-run total those commands print — **corrected
> 2026-08-22, revision 7: the whole-run total is the gate, not the `run-tests` row alone; an
> earlier draft of this point said the opposite, and § Verification §4 now explains why that was
> unsafe** — alongside the per-step `run-tests` numbers as supporting detail, and write the
> results into this file using the `Edit` tool, not a Bash `sed`/`printf`/inline-arg — § Verification
> §4 spells out why.** Then, in this same spec file: replace `<AFTER_RUN_ID>` in § Verification §4
> with `bde0ec40-06da-4628-8410-06a6a42694c7` (already done, revision 5), fill in the four numbers
> next to the baselines table, paste the per-step `SLEEP |` dump (or "none" if `sleepCalls` is 0),
> read `repeatedExpensiveCalls` against the run's own commit history (this run made no code change
> per point 3, so *any* repeat here has no "after an edit" excuse and should be scrutinized harder
> than the baseline reading in § Verification §4 allows), and only then move the Status line at the
> top of this file from "IN PROGRESS" to **implemented** — or to **failed, and say so**, per
> § Verification §4's own "Fail, and say so" clause. Do not mark it implemented from this revision;
> this revision measured nothing.
>
> **What this revision explicitly did NOT do, so the gap is visible rather than silent:** run
> `cez run stats` against `bde0ec40` (the run is still executing its own `spec` step — the numbers
> do not exist yet); read any `SLEEP |` lines from this run's own transcript; touch
> `system-prompt.test.ts`, `types.test.ts`, `stats.ts` or any other Phase 1-3 file (none needed
> changing, per point 3); or flip the Status line to implemented.

> ### Revision 8 — 2026-08-22, the `document` step of the after-run: Phase 4 measured, PASS
>
> **Phase 4 is done and the doctrine works.** Everything revision 5 listed as "explicitly did NOT
> do" has now been done, in this step, and the results are written into § Verification §4 → Result:
>
> 1. **The gate number is `blindSleepCalls` 0 on the whole run** — the criterion, met without
>    needing the discount mechanism revision 7 built for it. `sleepCalls` 5, `sleepExecMs` 16.5 s,
>    `repeatedExpensiveCalls` 0, `batchFactor` 1.00. Against `7c2dd8f0` (4 / 18 / 13.4 min / 18)
>    and `c10864d1` (2 / 14 / 42.2 min / 0), both blind-sleep counts and the re-run count go to
>    zero and the time spent asleep falls by ~1.5 orders of magnitude.
> 2. **All five `SLEEP |` hits are quoted and classified** — four class (c) guarded waits, all in
>    `run-tests`, all the doctrine's literal `until grep -q "^EXIT=" …; do sleep N; done` example;
>    one class (b) mention in `review-spec`, which turned out to be a *different* call than
>    revision 7 predicted (`review-spec` testing the predicate against `sleep 120; tail …` as a
>    fixture, rather than § Problem quoting it). Same class, different call — recorded rather than
>    smoothed over, because revision 7's prediction is the sort of thing a later reader would
>    otherwise take as confirmed.
> 3. **One criterion did not pass as measured, and was not rounded up.** Criterion 4 asks that
>    `run-tests` quote an exit-marker line; it quoted two of three and ended mid-wait on `npm test`,
>    because the run broker died 5 s later (`commit-push` failed with
>    `run broker … did not respond after 5000ms`). That is the broker defect fixed separately on
>    `origin/main` (`3e6d1b7e` / `8e20dfbf` / `0883256b`), not a sleep-doctrine failure — no sleep
>    was involved and no counter moved. `document` merged `origin/main` (`0883256b`) into this
>    branch and re-ran the full gate itself; § Verification §5 records those markers.
> 4. **The doctrine's effect is attributable this time, unlike `70f19253`'s zero.** The four
>    surviving sleeps are not merely consistent with the new text, they reproduce its shipped
>    worked example verbatim, four times, against three log files — an idiom the old doctrine
>    never contained. See § Verification §4 → Result → Attribution.
>
> **What this revision did NOT do:** change any Phase 1-3 code or prompt text (none needed
> changing); re-measure after `deploy` (step 8 runs no gate and cannot move these counters — see
> the scope note in § Verification §4).

## TLDR

`TOOL_BUDGET_DOCTRINE` (`packages/cezar/src/workflows/run.ts:519-535`) tells every agent step to
*"start it with `run_in_background`, keep working, and wait for it before you report"* — and never
says **how** to wait. Agents supplied the mechanism themselves and guessed a duration.

Three things are true, and only the first is what the task assumed:

1. **A guessed `sleep N` is real waste, and it is small.** Measured this session over the five run
   transcripts still on this box: **7 blind sleeps costing 1.8 min**, against **32 bounded poll
   loops**. A poll loop with early exit is *not* the defect — it exits when the job does, so most
   of its wall clock is a test suite genuinely running.
2. **The real, larger waste is the second call.** Start-then-poll is **two** round trips (~12 s of
   pure tax) where a foregrounded, redirected command is **one**, with zero overshoot. The
   doctrine never mentions the foreground option at all, so agents background things that take
   two seconds.
3. **Re-running an expensive command to see a different slice of its output is the biggest single
   item, and it is caused by our own rule.** Measured on `7c2dd8f0`: **18 repeated expensive calls
   costing 5.9 min**, headed by `npx vitest run …/brokered-session.test.ts` run **11 times**
   (first 37 s, 230 s of pure repetition). The doctrine's bounding rule (R2: *"bound every section
   … so the batch cannot flood your context"*) is correct for cheap reads and has **no carve-out**
   for expensive ones.

The keystone, and the reason both halves of this task are one change rather than two:
**the artifact that lets you wait is the same artifact that lets you re-slice — the output file.**
Verified this session: the harness's background-completion notification hands the agent an
`<output-file>` path (`<task-notification><task-id>…<output-file>…`), and it **does** reach a
cezar-spawned session — **421 of them in run `7c2dd8f0`**, 69 in `c10864d1`, 19 in this run. So
"wait for the completion signal" and "re-read the saved file" name one mechanism, not two.

The fix is a rewrite of the doctrine's third bullet to name the mechanism in three tiers
(foreground → background + signal → block on the marker), a matching recipe in the `run-tests` and
`implement` step prompts, and `blindSleepCalls` + `repeatedExpensiveCalls` in `cez run stats` so
**both** acceptance criteria are falsifiable instead of asserted. It costs a deliberate raise of
the R7 word cap.

## Problem

### What the record already measured

kb `local:2026-08-21-cezar-run-speed-measured` (`notion-cc6ebabb2ab4`,
`notion-export/knowledge/notes/cezar-run-speed-is-round-trip-bound-not-box-bound--local.md`),
§ *"Tests: the sleeping costs more than the testing"*, across six production sessions:

> sleep/poll waiting **16.9 min** (mean 101 s, max 276 s) against **7.0 min** of real vitest time
> and 3.0 min of typecheck. Phase 5's "background what is genuinely slow" was implemented as a
> **guessed `sleep N` then grep a log** — one call is literally `sleep 240`. That is a **2.4:1
> loss** against the thing it was meant to speed up.

That note's three benchmarked-and-dead toolchain ideas (`--project server`, jsdom→happy-dom,
`isolate: false`) are **out of scope and must not be re-attempted** — the note records why.

### What I measured myself, this session, and where it disagrees

Only five run NDJSONs remain under `.ai/cezar/runs/` on this box, so the six-session 16.9 min
figure **cannot be re-derived here** and is cited, not reproduced. What I could measure (node
replay; `jq` is not installed on this box):

| run | Bash calls | `sleepCalls` | `blindSleepCalls` | `sleepExecMs` | of which blind | `repeatedExpensiveCalls` | repeat cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `7c2dd8f0` | 595 | 18 | **4** | 13.4 min | 0.6 min | **18** | 5.9 min |
| `c10864d1` | 298 | 14 | **2** | 42.2 min | 1.2 min | 0 | 0 |
| `7aecd6a2` | 124 | 4 | **1** | 5.6 min | 0.0 min | 0 | 0 |
| `e06f2169` (in flight) | 134 | 0 | 0 | — | — | 0 | 0 |
| `70f19253` (this run) | 126 | 3 | 0 | 0.0 min | 0.0 min | 0 | 0 |
| **total** | **1 277** | **39** | **7** | **61.2 min** | **1.8 min** | **18** | **5.9 min** |

**Method, stated precisely because rev 1 got it wrong.** All three counters are computed over
**`tool-call` events** where `tool === 'Bash'`, on `String(input?.command ?? '')` — the same event
stream and the same `toolCalls` branch `computeRunStats` already increments
(`packages/cezar/src/runs/stats.ts:181-206`). The predicate itself is in § Data models.

**`sleepExecMs` necessarily has a different denominator, and this is not a bug.** Exec time only
exists for a *matched pair*: `stats.ts:212-221` computes `execMs = tool-result.ts − tool-call.ts`,
joining `tool-call.id` → `tool-result.toolCallId`. (Note the asymmetry — the call event's key is
`id`, the result's is `toolCallId`; a join on `id`-to-`id` silently returns zero and I hit exactly
that on the first attempt.) On `7c2dd8f0` **16 of the 18** sleep calls have a recorded result, so
13.4 min covers 16 calls while the count column says 18. The two unmatched calls are:

```
set +e sleep 120; tail -12 /tmp/full-suite-mine.log          ← blind, and the run's archetype
set +e cd …/worktrees/7c2dd8f0… export NODE_ENV=development …  ← blind (the sleep 12 probe below)
```

Both are blind. Counting on pairs would therefore have hidden **half** of that run's blind sleeps,
which is why the predicate moved to `tool-call`.

Notification counts (§ TLDR) are from the raw claude transcripts under
`~/.claude/projects/*worktrees*/`, not from the NDJSON — cezar's own event log records **zero**
occurrences of `task-notification` (it has a `user-message` event type but does not carry
harness-injected turns), so an NDJSON-only search would have wrongly concluded the signal never
arrives.

**Two of these runs were live while I measured** (`e06f2169`, `70f19253`), so their rows are a
snapshot at 2026-08-21 ~20:1x UTC and will have grown. The three settled runs are stable and are
what § Verification pins against.

**The conclusion the raw numbers force, which sharpens the task's own framing.** 32 of the 39
sleeps are bounded poll loops with early exit:

```
for i in $(seq 1 60);  do grep -q '^EXIT=' /tmp/gate-typecheck.log && break; sleep 2; done
until grep -qE "TEST_EXIT=" "$f"; do sleep 10; done          # ← inside a Monitor call
```

These exit **when the job exits**. Their wall clock is mostly the job, not overshoot (bounded above
by one poll interval, 2–10 s). So *"zero Bash calls whose command matches `sleep <n>`"* — acceptance
criterion 3 read as a bare grep — would ban the correct pattern along with the wrong one, and would
be satisfied by a session that simply never ran a gate. Criterion 3's own wording is *"as a wait
for backgrounded work"*, and **`blindSleepCalls == 0` is that clause operationalized**, not an
amendment to it. § Data models defines it exactly.

Inference, flagged as inference: the KB note's 16.9 min of waiting against 10.0 min of gate work
implies roughly **7 min per six sessions of genuine overshoot**, plus one wasted round trip per
start-then-poll pair. That is the recoverable amount on the sleep half. It is smaller than 16.9 and
I will not claim 16.9.

### The seven blind sleeps, in full

Every one, across all five runs. Four are in `7c2dd8f0`, two in `c10864d1`, one in `7aecd6a2`.

```
sleep 120; tail -12 /tmp/full-suite-mine.log                              # 7c2dd8f0 — the archetype
systemd-run --user --unit=cez-e2e-probe … ; sleep 2;  systemctl is-active # 7c2dd8f0 — unit settle
systemd-run --user --unit=cez-deploy-… ;   sleep 3;  systemctl is-active  # 7c2dd8f0 — unit settle
… probe.mjs … & PROBE=$!; echo "probe pid $PROBE"; sleep 12; … deploy …   # 7c2dd8f0 — see below
sleep 8 2>/dev/null; python3 "$TMPD/sweep-status.py" | …                  # c10864d1
python3 - <<'PYEOF' … PYEOF; sleep 60 2>/dev/null; python3 sweep-status.py # c10864d1
sleep 45;  tail -25 …/tmp/7aecd6a2…/build.log                             # 7aecd6a2
```

Every one is *"I started something, I do not know when it finishes, I will guess."* Most redirect
to a file already. **The agents were 90% of the way to the right pattern** — what was missing was
the instruction to wait on the marker instead of the clock, and to re-read that same file rather
than re-run.

**The fourth one is the single most instructive line in this spec.** It captures `PROBE=$!`, prints
the pid — and then sleeps 12 instead of `wait $PROBE`. Everything needed for a real wait was in
that one shell, in scope, one word away. See § Solution's correction to the task's wording: `wait
$PID` is unusable *across* calls but perfectly usable *within* one, and this agent had it and did
not reach for it.

### Why the doctrine produced this

`packages/cezar/src/workflows/run.ts:533-535`, verbatim (re-read on `origin/main` at `20319ab0`):

> - **Background what is genuinely slow.** A 150-second install or test run should not block you
>   from reading the next file: start it with `run_in_background`, keep working, and wait for it
>   before you report. Never background anything that mutates the git index.

Three defects, in order of cost:

1. **"wait for it" names no mechanism.** The model fills the gap, and a duration is the easiest
   thing to invent.
2. **It presents backgrounding as the only option.** There is no "just run it in the foreground",
   so a 1.7 s test file (the note measured a single server file at **1.7–2.0 s**) gets the
   two-round-trip treatment.
3. **Nothing anywhere carves an exception out of the bounding rule.** Confirmed by search: no
   prompt, spec or doc in this repo tells an agent not to use `sleep`, and none contains the
   phrase "re-slice"/"re-read the file". Every `sleep` in `src/` is in shell scripts and tests.

The `run-tests` step prompt (`types.ts:741-745`) repeats the same three defects.

### The re-run defect, measured

Rev 1 asserted this half from the KB note and shipped no evidence. Measured here, on the settled
runs, grouping Bash calls by their **costly invocation line with the output filter stripped**
(§ Data models gives the exact key):

| repeated invocation (`7c2dd8f0`) | times | first | repeat cost |
| --- | ---: | ---: | ---: |
| `npx vitest run packages/cezar/src/core/brokered-session.test.ts` | **11** | 37 s | 230 s |
| `npm run typecheck` (three distinct batch contexts) | 3 + 2 + 2 | 7–24 s | 75 s |
| `npx vitest run --project server …` | 3 | 13 s | 26 s |
| `npm run typecheck ; npx vitest run …/server-install/` | 2 | 14 s | 18 s |
| `npx tsc --noEmit -p tsconfig.json` | 2 | 6 s | 7 s |
| **7 groups** | **25 calls** | — | **5.9 min** |

The 11× test file is the KB note's *"same single test file re-run 12 times"*, reproduced locally
(11 in this one run; the note counted across six sessions). This is the largest single recoverable
item in either half of the task, and it is why L2 is not an afterthought clause.

### What is explicitly NOT the problem

- **Batching is not at fault and its bounding rule is not being repealed.** R2 of
  `.ai/specs/2026-08-20-agent-round-trip-batching-and-fanout.md` ("an unbounded batch is strictly
  worse than the calls it replaced") stands, and `system-prompt.test.ts:74-75` keeps pinning it.
  The KB note says the rule *lacks a carve-out*, not that it is wrong.
- **The box is not slow.** Ruled out by measurement in the same note (prod round-trip latency is
  *faster* than the Mac: mean 7.44 s vs 8.74 s).
- **The tool budget doctrine is not unread.** 100% of production Bash calls are multi-statement
  batches (median 510 chars) against 29% bare probes on the Mac. Prompt edits reliably change
  *what agents type*. They did **not** change round-trip count (batch factor 1.00 → 1.02). This
  change is of the first kind, which is the favourable precedent — not proof.

## Solution

Four levers. L1 and L2 are the change; L3 makes it falsifiable; L4 is what stops it being a
regression.

### L1 — Name the waiting mechanism, in three tiers, in preference order

Replace the doctrine's third bullet so it says *how*. The tiers, and when each is right:

| tier | when | shape | round trips | overshoot |
| --- | --- | --- | ---: | --- |
| **1. Foreground + redirect** | nothing independent to overlap — **the common case, and unmentioned today** | `cmd >"$f" 2>&1; echo EXIT=$?` then read `$f` in the same call | **1** | none |
| **2. Background + completion signal** | you genuinely have other work | start it in the background, do the other work, wait for the completion signal, read its `<output-file>` | 1 + the work you did anyway | none |
| **3. Block on the marker** | a *fresh shell* must wait on something it did not start (a systemd unit, another session's job) | `until grep -q EXIT= "$f"; do sleep 5; done` then slice | 1 | ≤ one interval |

Banned: a bare `sleep N` whose only purpose is to pass time before reading. That is tier 3 with
the exit condition deleted.

**And a fourth rule that is not a tier: never end your turn while it runs.** If you background
something and then run out of work to overlap, drop to tier 3 and block — do not report. This is
the `23221162` failure mode (R2), and it is the one way removing the guess makes things *worse*.

**Correction to the task's own wording, stated plainly rather than worked around.** Acceptance
criterion 1 names *"`wait $PID`"*. The Bash tool's contract is that the working directory persists
between calls but **shell state does not** — so a PID captured in call A is not a child of call
B's shell, and `wait $PID` is only meaningful when the start and the wait are in the *same* call.
Within one call it is exactly right, and § Problem's fourth blind sleep is an agent that had the
pid in hand and still guessed. Across calls it is not available, so tiers 2 and 3 carry that case.
The criterion is met in substance by tiers 1–3 and by the harness completion signal it also names;
it is not satisfiable as literally written across calls, and this spec does not pretend otherwise.

### L2 — Carve the expensive case out of the bounding rule

One clause, in the same bullet, because it is the same file: **re-read `$f` for a different slice;
never re-run an expensive command.** Bullet 1's bounding rule is untouched — it governs cheap
reads, which is what it always said. The split (cheap calls get batching, expensive calls get
backgrounding) is the same split the 2026-08-20 note already drew:

> Batching is for the 231 [cheap calls]. … The 10 slowest calls were 80% of all tool execution …
> Batching does nothing for those — **backgrounding** does.

### L3 — Ship the meter before claiming the win

`cez run stats` cannot see any of this today: `computeRunStats` reads `type`, `seq`, `ts`,
`stepId`, `id` and `tool`, and **never `input`** (`packages/cezar/src/runs/stats.ts:132-248`;
verified by reading every branch of its switch). Add four derived fields (§ Data models) — three
for the sleep half, one for the re-run half. The 2026-08-20 spec's own rule applies to its
successor: *"Always cite the meter."*

### L4 — Do not turn a slow gate into a fake one

kb `local:2026-08-20-backgrounded-gate-outlives-its-step`: on run `23221162` — *the run that
implemented the batching doctrine* — `run-tests` backgrounded `npm test`, ended 90 s later while
it was still running, and reported `status=done`. **A guessed sleep is at least a wait.** So the
`run-tests` prompt must additionally require the report to **quote the exit-marker line from the
saved file** (`EXIT=0` / `Test Files  N passed`) — an artifact that cannot exist unless the
process finished. This is a prompt-level mitigation, not a post-condition; the real fix is
`verify:` on `run-tests` and is deferred (§ Open questions Q6).

### The exact proposed text

```
- **Background what is genuinely slow; wait on the process, never on a guess.** Send its output to
  a file (`cmd >"$f" 2>&1; echo EXIT=$?`). Foreground it unless you have work to overlap; if you
  do, background it and wait for the completion signal, or block on the marker
  (`until grep -q EXIT= "$f"; do sleep 5; done`) — never a bare `sleep N`, and never end your turn
  while it runs. Re-read `$f` for a different slice; never re-run an expensive command. Never
  background anything that mutates the git index.
```

**Measured this session: 91 words, taking the doctrine from 203 to 252.** The cap is `< 210`
(`system-prompt.test.ts:86`), so this requires the R7 amendment in § Risks R1. A terse fallback
that carries every rule but drops tier 3's inline example measures **240 words** — see R1.

It keeps every currently pinned substring: `Background what is genuinely slow`
(`system-prompt.test.ts:67`) and `mutates the git index` (`:79`) survive verbatim, and bullets 1–2
are untouched, so `set +e` (`:72`), `bound every section` (`:74`), `head` (`:75`) and `no
dependency between them` (`:77`) are unaffected. **The only test change in Phase 1 is the cap and
the new assertions.**

**`run_in_background` is deliberately absent.** It is a Claude Code Bash parameter, and the
doctrine is prepended to codex and opencode prompts too (§ Architecture). Rev 1 proposed keeping
it while asserting the text named no backend-specific tool; those cannot both hold. It stays in the
`run-tests` *step* prompt, where `types.test.ts:231` pins it and where the backend is known.

## Architecture

Nothing structural moves. The change lands in five files, three of which are strings:

```
packages/cezar/src/workflows/run.ts
  TOOL_BUDGET_DOCTRINE  (:519-535)  ── bullet 3 rewritten  ─┐
                                                            │  composed at run.ts:3295 (Continue turn)
                                                            │  and run.ts:4522 (every agent step)
                                                            ▼
                              composeSystemPrompt(skill, extra, DOCTRINE, handoff)
                                                            │
                    ┌───────────────────────────────────────┴────────────────────┐
                    ▼                                                            ▼
      claude-cli-runner.ts:698                                  agent-runner.ts:92-94
      --append-system-prompt                                    prependSystemPrompt() → opening
                                                                user message (codex, opencode, pi)

packages/cezar/src/workflows/types.ts
  spec-to-deploy › run-tests.prompt (:721-755, bullets :741-745)  ── recipe + quote-the-marker
  spec-to-deploy › implement.prompt (:700-720)                    ── one line, same recipe

packages/cezar/src/runs/stats.ts   ── read tool-call.input.command; +4 StepStats fields;
                                      +1 column in formatRunStats (header :288-294, row :302)
AGENTS.md § "How an agent step should spend its tool calls" (:402-448) ── prose restatement
```

**`stats-cli.ts` needs no edit.** It only calls `formatRunStats(stats)` at `:117` and JSON-dumps
the object; the table is built entirely inside `stats.ts`. Rev 1 listed it as a target — that was
wrong. `stats-cli-wiring.test.ts` exists and should be run, but is expected to pass untouched.

**Backend portability is a design constraint, not an afterthought.** `.ai/specs/2026-07-18-subagent-monitoring-status.md:44`
records that **cezar itself models no background/async work at all** — there is no `Monitor`,
`BashOutput`, `TaskOutput` or `KillShell` anywhere in `src/`, and `DEFAULT_ALLOWED_TOOLS` is
`['Read','Edit','Write','Grep','Glob','Bash']` (`types.ts:251`). Therefore:

- The doctrine text names **no backend-specific tool or parameter**, and § Verification §1 asserts
  that as a test rather than trusting the author. "the completion signal" is deliberately generic.
- Tiers **1 and 3 are pure POSIX shell** and are correct on every backend, including one with no
  background notion at all. They are also the two preferred tiers, so a backend without tier 2
  loses nothing.
- Tier 2 is verified present on the claude backend (575 notifications across five sessions) and
  degrades to "not applicable" elsewhere rather than to "wrong".

Tool *availability* is not the constraint: `--allowedTools` only **grants** and never restricts on
`claude` 2.1.233, and the runner passes `--permission-mode bypassPermissions`
(`claude-cli-runner.ts:92-102`, `:668-677`, `:694`) — the allowlists are decorative on this
backend today, which is a known defect owned by todo `444c7db2`, not by this spec.

## Data models

Four fields on `StepStats` (`packages/cezar/src/runs/stats.ts:34-64`), summed into
`RunStats.totals` by the existing `Omit<StepStats, 'stepId' | 'restarts'>` — so they are picked up
by the totals with no change to that type.

```ts
export interface StepStats {
  // … existing fields unchanged …

  /** Bash calls whose command contains a real `sleep <n>`. NOT a defect count — a bounded poll
   *  loop legitimately sleeps between probes and exits when the job does. */
  sleepCalls: number;

  /** …of which the command has NO early-exit guard (`until`/`while`/`for`). THIS is the defect
   *  acceptance criterion 3 is measured on: a guessed duration. Target: 0. */
  blindSleepCalls: number;

  /** Σ exec ms of `sleepCalls` THAT HAVE A MATCHED RESULT — a strictly smaller set than
   *  `sleepCalls`, because exec time needs both events. Read as an upper bound on waiting, not
   *  as waste: a tight poll loop's exec time is mostly the job it waited for. */
  sleepExecMs: number;

  /** Repeat invocations of an expensive command whose first run took ≥5 s — i.e. calls that
   *  re-ran work already done, typically only to see a different slice of the output. THIS is
   *  the defect acceptance criterion 2 is measured on. Target: 0. */
  repeatedExpensiveCalls: number;
}
```

### The sleep predicate, exactly

Over `tool-call` events where `tool === 'Bash'`, on `String(input?.command ?? '')`:

```ts
const GUARDED = /\b(until|while|for)\b/;
const SLEEP_N = /\bsleep\s+([\d.]+)/g;

/** Drop heredoc BODIES: a `sleep` being written into a file is not a wait, and English prose
 *  inside one is not a loop. Only the closing tag on its own line ends the body. */
function stripHeredocs(cmd: string): string { /* … see § Verification §3 for the reference impl … */ }

const text     = stripHeredocs(cmd);
const isSleep  = [...text.matchAll(SLEEP_N)].some((m) => Number.parseFloat(m[1]) > 0);
const isBlind  = isSleep && !GUARDED.test(text);
```

**Why the two refinements, with the measurement that justifies each.** The naive predicate (raw
command, any duration) is wrong in *both* directions on real data, and — this is the part that
matters — **naive heredoc stripping alone is net-zero**, so it is not a fix on its own:

| predicate | blind sleeps found across the 5 runs |
| --- | ---: |
| A — raw command, any duration | 8 |
| B — heredoc-stripped, any duration | 8 |
| C — heredoc-stripped, duration > 0 **(shipped)** | **7** |

B is not A-minus-one; it is A minus one plus a different one:

- **A over-reports** on `7c2dd8f0`'s `cat > $S/cutover-experiment.sh <<'SCRIPT' … sleep 25 … sleep
  40 … sleep 50 … SCRIPT`. Those sleeps are experiment *timing being written into a file*, and the
  call itself waits for nothing. Stripping removes it. ✔
- **B then over-reports** on `7aecd6a2`'s `python3 - <<'EOF' … EOF; sleep 0; cat …`. Its only
  `for` is the English word "for" in a prose sentence inside the Python heredoc — so A called it
  guarded for the wrong reason, and stripping correctly removes that fake guard and exposes a
  `sleep 0`. But `sleep 0` waits for nothing either. ✘
- **C** requires a positive duration, which drops `sleep 0` and lands on 7 — and I read all 7
  (§ Problem lists them in full); every one is a genuine guessed wait.

Remaining failure directions, stated so a reader is not misled:

- **False "guarded"**: `for f in a b c; do …; done; sleep 60` — an unrelated loop and a blind sleep
  in one batch. Under-reports. This is the one that can hide a regression, and § Verification
  compensates by *also* eyeballing the command list, not only the count.
- **False "blind"**: a bare `sleep` guarded by other means (`timeout`, a `trap`). Over-reports —
  acceptable, it errs toward flagging. Not observed in the sample.
- It cannot distinguish overshoot from real job duration. Nothing in the NDJSON can. Said here
  rather than discovered later.

### The re-run predicate, exactly

Same events. The key is the **costly invocation with its output filter removed**, because the
defect is *the same command, a different filter* — an exact-string match finds nothing (measured:
0 across all five runs, which is why rev 1's proposed identical-command metric would have shipped
a permanent zero).

```ts
const COSTLY = /(^|[;&|(\s])(npx\s+vitest|npx\s+tsc|vitest\s+run|npm\s+(run\s+\S+|test|ci|install)|pnpm\s+\S+|tools\/(typecheck|lint|test))\b/;

// key: per step, the costly lines only, each truncated at the first `|` or `>`.
const key = stepId + '|' + stripHeredocs(cmd).split('\n').filter((l) => COSTLY.test(l))
  .map((l) => l.split(/[|>]/)[0].replace(/\s+/g, ' ').trim()).join(' ; ');
```

`repeatedExpensiveCalls` += `count - 1` for every key seen more than once whose **first** call took
≥ 5 000 ms. First-call-only, so a command that is cheap the first time and slow later is not
counted, and the 5 s floor keeps `git status` out of it. `stripHeredocs` matters here too: without
it, a handoff-update heredoc quoting the words "npm test" scores as a test run (observed in
`c10864d1` and `7aecd6a2`).

Known limits: `COSTLY` is an allowlist of *this* repo's toolchain and will miss a project that
invokes tests another way — it under-reports on unknown stacks rather than inventing hits. And a
legitimate re-run (re-running a suite *after editing the code*) is counted as a repeat. That
second one is real: the metric is a **signal to read the command list**, not a gate, and
§ Verification §4 treats it that way while treating `blindSleepCalls` as a hard zero.

`StepStats` is **derived on demand and never persisted** (`stats.ts` reads the NDJSON; nothing
writes it back), so this touches no store, no migration and no contract-parity test.

## API contracts

- **`cez run stats <runId>`** — one column added to the human table
  (`formatRunStats`, header `stats.ts:288-294`, row `:302`), e.g. `sleep` rendered as
  `blindSleepCalls/sleepCalls` so both numbers are visible in one cell, plus `re-run` for
  `repeatedExpensiveCalls`, and one clause in the summary line (`:328-329`).
- **`cez run stats <runId> --json`** — four new keys per step and in `totals`. **Additive only.**
  `BACKWARD_COMPATIBILITY.md` applies: a consumer reading `batchFactor` is unaffected.
- **No HTTP route, no event type, no NDJSON field changes.** The `tool-call` event already
  persists `input` whole (`core/claude-cli-runner.ts:802` → `run.ts:4319` → `runs/store.ts:951-961`);
  this spec only starts *reading* it.

## Phases

Each phase is independently shippable and independently green.

### Phase 1 — The doctrine (the whole point; ~30 lines)

1. Rewrite `TOOL_BUDGET_DOCTRINE` bullet 3 in `run.ts:533-535` to the § Solution text.
2. Update the doc comment above it (`run.ts:499-518`) with this spec's numbers and a pointer to
   this file.
3. `system-prompt.test.ts:86` — raise the cap and **rewrite its comment to carry the argument**
   (R1), not just the number. Add assertions for the new invariants (§ Verification §1).
4. `AGENTS.md:402-448` — restate. It already documents the bounding rule at length; add the
   carve-out and the three tiers beside it, or the two documents disagree the moment this lands.

**Green when:** `npx vitest run src/workflows/system-prompt.test.ts` passes and the word count is
under the new cap. **Re-count the doctrine before editing** — do not trust the 203 in this file
(R4).

### Phase 2 — The step prompts (uncapped, so this is where the recipe goes)

1. `types.ts:741-745` (`run-tests`) — replace the two backgrounding bullets with the tiered recipe
   *and* the L4 requirement to quote the exit-marker line in the report.
2. `types.ts:700-720` (`implement`) — one line: same rule for the gates it runs to check itself.
3. `types.test.ts:229-238` — this **will** break on the reword: it pins `'run_in_background'` and
   `` '`wait` for every one of' `` (verified on `origin/main`). Update it deliberately — keep
   `run_in_background` (the step prompt keeps it; only the doctrine drops it), drop the dead
   phrase, add assertions for the marker-quote requirement and for the absence of any
   guessed-duration wording.

**Green when:** `npx vitest run src/workflows/types.test.ts` passes.

### Phase 3 — The meter

1. `stats.ts` — read `input.command` on `tool-call`; add `stripHeredocs` + the two predicates; add
   the four fields to `Bucket`, `emptyBucket`, `StepStats` and the totals sum (`:96-118`,
   `:170-190`, `:223-245`).
2. `formatRunStats` — the two columns and the summary clause. **`stats-cli.ts` is not edited**;
   run `stats-cli-wiring.test.ts` to confirm it still passes.
3. **A new fixture with `input` intact.** The checked-in
   `packages/cezar/src/core/__fixtures__/runs/ec6e8e06-trimmed.ndjson` has `input` **stripped** —
   verified this session: `grep -c '"input"'` returns **0**. A sleep counter tested only against
   it reports zero for every run regardless of truth, and would pass while measuring nothing.
   Either add a small purpose-built fixture with real `input.command` values, or assert over
   inline events in the unit test. Do not skip this.
4. Unit-test the predicates against the four cases § Data models names: a bounded poll loop
   (guarded, not blind), a bare `sleep 120` (blind), a heredoc writing `sleep 25` (not counted),
   and `sleep 0` (not counted).

**Green when:** `npx vitest run src/runs/` passes, **and** § Verification §3's replay against a
real run id reproduces the § Problem numbers.

### Phase 4 — Measure a real post-change run, and record it

**Designated after-run: `bde0ec40-06da-4628-8410-06a6a42694c7`** (revision 5, 2026-08-22). Not
satisfiable by *this step* — the `spec` step only names the run and the commands; `run-tests`
(step 5 of this same run) has to actually execute the gate suite, and `document` (step 7) has to
run the commands in § Verification §4 against this run's own id and write the numbers back into
this file. See § Verification §4 for the exact commands and pass conditions, and revision 5 above
for why this run — not a new one — is the right one to measure.

## Analytics

The events already exist; this spec adds the *derivation*. Per run, from `cez run stats --json`:

| metric | today's baseline (this box) | target |
| --- | --- | --- |
| `blindSleepCalls` (run total) | 4 (`7c2dd8f0`), 2 (`c10864d1`), 1 (`7aecd6a2`) | **0** — hard |
| `repeatedExpensiveCalls` | **18** (`7c2dd8f0`, 5.9 min), 0 elsewhere | **0**, or every survivor explained |
| `sleepCalls` | 18 / 14 / 4 | may stay non-zero — tier 3 is legal |
| `sleepExecMs` on the `run-tests` step | see § Problem | down, but only meaningful beside gate duration |
| `batchFactor` | 1.00–1.02 | **must not fall** — this change must not un-batch anything |

`batchFactor` is a **guard metric** here, not a goal: the 2026-08-20 spec owns it, and a change
that improved waiting while regressing batching would be a bad trade taken silently.

`repeatedExpensiveCalls` is the softer of the two targets by design (§ Data models: a re-run after
an edit is legitimate and indistinguishable). It is a **read-the-list** metric; `blindSleepCalls`
is the hard zero.

## Risks

**R1 — The word cap. This is the real cost of the change, and it is a deliberate amendment.**
The doctrine is 203 words against a `< 210` assertion (both re-verified on `origin/main` at
`20319ab0` this session, counting the way the test counts). The full text takes it to **252**
(+24%). R7 of the 2026-08-20 spec set that cap because the doctrine precedes every step prompt,
and the test comment reads: *"A doctrine that grows past this is one that starts competing with the
step prompt underneath it for the model's attention."* That reasoning is sound and the number was
never measured — it is a considered guess. Weighing it:

- *For raising:* the growth buys rules attacking two measured losses (1.8 min of blind sleep and
  5.9 min of re-runs on one run). The cap protects a hypothesised dilution. The one piece of
  evidence we do have points the other way — at 203 words the doctrine **is** read and followed
  (100% of prod Bash calls are multi-statement batches). And its marginal per-turn cost is ~zero:
  it is cache-read, not re-input (`ec6e8e06` billed 599 k cacheRead against 10 input tokens), which
  `run.ts:509-511` already documents.
- *Against:* "it was already read" is evidence about the current length, not about 252. Dilution,
  if it happens, shows up as *other* bullets being followed less — and no metric here would catch
  that.

**Decision: raise the cap to 260 and rewrite the test comment to carry this argument**, so the
next session inherits the reasoning rather than a bare number. Explicitly **not** "remove the cap".
If a reviewer rejects the raise, the fallback is the **240-word terse variant** (cap 250), which
keeps all three tiers, the carve-out and the never-end-your-turn clause but drops tier 3's inline
`until` example — accepting that the legitimate poll loop is then only *implied* legal. Prefer
252/260; the poll loop is 32 of 39 observed sleeps and leaving its shape unnamed invites its
removal.

**R2 — Removing the guess without adding a real block makes the gate fake.** The `23221162`
failure mode (`run-tests` ends while `npm test` runs; both steps report done). Mitigated three
ways: tier 1 is the *default* (a foregrounded command cannot outlive its own call); L4 requires the
report to quote an exit marker that cannot exist unless the process finished; and the doctrine text
now carries **"never end your turn while it runs"**, which closes the specific hole — background,
run out of overlap work, report anyway. Not eliminated — see Q6.

**R3 — The predicate mislabels.** Both surviving directions are stated in § Data models, along with
the measurement showing that the obvious fix (strip heredocs) is net-zero on its own and needed the
duration filter beside it. Compensated in verification by reading the actual command list, not only
the count.

**R4 — Collision with run `e06f2169`.** In flight right now on the adjacent recommendation from the
same KB note (sub-agent fan-out), editing **the same two files** — `workflows/run.ts`
(`TOOL_BUDGET_DOCTRINE`) and `workflows/types.ts` (step prompts) — and it will consume part of the
same word budget. **Rebase on `origin/main` and re-count the doctrine before editing.** As of this
writing `main` is at **`20319ab0`** (it moved from `f0d48513` during this run), and `git diff
f0d48513..origin/main` over `run.ts`, `types.ts`, `system-prompt.test.ts` and `stats.ts` is
**empty** — `e06f2169` has not landed yet, so 203 still holds *today* and will not once it does.

**R5 — A prompt change may move the text and not the behaviour.** Precedent cuts both ways in the
same measurement: L1 (command shape) landed, L2 (round trips) did not. This change is command-shape
like L1, which is favourable — but the 2026-08-20 spec claimed a win it had not measured and was
corrected for it. **No speed claim from this spec is admissible until Verification §4 has run.**

**R6 — Backend portability.** Handled by design (§ Architecture): no backend-specific tool or
parameter is named — including `run_in_background`, which rev 1 would have shipped — and the two
preferred tiers are pure shell. § Verification §1 asserts it rather than trusting it.

**R7 — The fixture trap.** `ec6e8e06-trimmed.ndjson` has no `input`, so a metric tested only there
is silently always zero. Phase 3 step 3 exists solely for this; its green condition is a real run
id, not the fixture.

## Verification

Concrete and executable. §1–§3 are automated; §4 is the one that decides whether any of this worked.

### §1 — Doctrine unit tests (`src/workflows/system-prompt.test.ts`)

```bash
cd packages/cezar && npx vitest run src/workflows/system-prompt.test.ts
```
Add to the existing `describe('TOOL_BUDGET_DOCTRINE')`:

```ts
it('names the mechanism instead of leaving the agent to guess a duration', () => {
  expect(TOOL_BUDGET_DOCTRINE).toContain('never on a guess');
  expect(TOOL_BUDGET_DOCTRINE).toMatch(/completion signal/);
  expect(TOOL_BUDGET_DOCTRINE).toMatch(/never a bare `sleep N`/);
  // R2 — the hole that a guessed sleep accidentally covered.
  expect(TOOL_BUDGET_DOCTRINE).toContain('never end your turn while it runs');
});

it('carves the expensive case out of the bounding rule without repealing it', () => {
  expect(TOOL_BUDGET_DOCTRINE).toContain('never re-run an expensive command');
  expect(TOOL_BUDGET_DOCTRINE).toContain('bound every section');   // R2 of 2026-08-20 survives
});

it('names no backend-specific tool or parameter, because it also rides on codex and opencode', () => {
  for (const t of ['Monitor', 'BashOutput', 'TaskOutput', 'KillShell', 'run_in_background']) {
    expect(TOOL_BUDGET_DOCTRINE).not.toContain(t);
  }
});
```
And the amended cap at `:86`, with its comment rewritten per R1.

### §2 — Step prompt tests (`src/workflows/types.test.ts`)

```bash
cd packages/cezar && npx vitest run src/workflows/types.test.ts
```
`run-tests` must still contain `run_in_background` and `Never background anything that mutates the
git index`, must newly require quoting the exit marker, and must contain no guessed-duration
wording. The dead pin `` '`wait` for every one of' `` is removed. Assert the same
absence-of-`sleep`-as-a-wait property over `implement`.

### §3 — The meter, against a real transcript (not the fixture)

```bash
cd packages/cezar && npx vitest run src/runs/ src/runs/stats-cli-wiring.test.ts
cez run stats 7c2dd8f0-e53e-4e88-b4b3-b382c592bb12 --json \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(s).totals;
      console.log("sleep",t.sleepCalls,"blind",t.blindSleepCalls,
                  "execMin",(t.sleepExecMs/60000).toFixed(1),"rerun",t.repeatedExpensiveCalls)})'
```
**Expected: `sleep 18 blind 4 execMin 13.4 rerun 18`** — the § Problem numbers, re-derived through
the shipped code path. `7c2dd8f0` is settled, so these are stable. Any zero means R7's fixture trap
was hit, or `input` is not being read.

Reference implementation of `stripHeredocs`, which the shipped one must match on the cases in
§ Data models:

```js
function stripHeredocs(cmd) {
  const out = []; let term = null;
  for (const l of cmd.split('\n')) {
    if (term !== null) { if (l.trim() === term) term = null; continue; }
    out.push(l);
    const m = l.match(/<<-?\s*(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|([A-Za-z_]\w*))\s*$/);
    if (m) term = m[1] || m[2] || m[3];
  }
  return out.join('\n');
}
```

### §4 — The acceptance criteria, on a post-change run (the one that decides it)

**This run (`70f19253`) cannot serve as the after-measurement** — and the reason is stronger than
this paragraph first gave: **corrected 2026-08-21 (revision 4)**, its final count is 9 sleep calls
(0 blind, 362.3 s waited) and 0 repeated expensive calls, ~~3 sleep calls totalling 0.0 min and 0
repeated expensive calls~~ — but every step of it was composed by the doctrine **as deployed at
19:00, before this commit existed**, so its zero attributes to nothing here. The named after-run must be a
`spec-to-deploy` run **that actually executes a `run-tests` step**, started after this change is
deployed to `/opt/cezar/packages/cezar/dist/`. Deployment matters: the doctrine ships as compiled
`dist`, and the KB note had to correct an earlier claim that it was not deployed.

**Named after-run (revision 5, 2026-08-22): `bde0ec40-06da-4628-8410-06a6a42694c7`.** Its worktree
was born 28.9 s after `/opt/cezar`'s dist was rebuilt with `ada8f376`'s content (verified by
grepping the deployed `run.js`/`types.js`/`stats.js` directly, not by trusting the timestamp
alone — see revision 5). Its `run-tests` step (workflow step 5 of 8) has not executed as of this
`spec` step (step 2 of 8); the commands below must be run by the `document` step (step 7 of 8),
against this run's own id, once `run-tests` has completed.

**Corrected 2026-08-22 (revision 6, after review flagged both commands below as unrunnable
verbatim).** Every workflow step, `document` included, runs from **this run's own worktree**
(`.ai/cezar/worktrees/bde0ec40-…/`), which is its own git toplevel with its own, empty
`.ai/cezar/runs/` — the transcript only ever exists at the **workspace root**,
`/var/lib/cezar/loki-labs/cezar`. `stats-cli.ts` resolves `repoRoot` from git toplevel unless
`--repo` overrides it, so the commands below now pin `--repo` and an absolute `.ndjson` path
rather than relying on cwd. Verified working (exit 0) on this box before this revision was written.

```bash
# Baselines already on this box (before):
#   7c2dd8f0 → blindSleepCalls 4, sleepCalls 18, repeatedExpensiveCalls 18, sleepExecMs ≈13.4 min
#   c10864d1 → blindSleepCalls 2, sleepCalls 14, repeatedExpensiveCalls 0
cez run stats bde0ec40-06da-4628-8410-06a6a42694c7 --json \
  --repo /var/lib/cezar/loki-labs/cezar \
  | tee /tmp/bde0ec40-stats.json \
  | grep -E 'blindSleepCalls|sleepCalls|repeatedExpensiveCalls|batchFactor'

# Both the run total AND the run-tests row (revision 7: criterion 1 gates on the total — see the
# corrected note below the commands — with this per-step print kept as supporting detail, since
# `spec`/`review-spec`/`document` mostly only MENTION sleep/wait vocabulary in prose).
node -e '
const s = require("/tmp/bde0ec40-stats.json");
const step = s.steps.find((x) => x.stepId === "run-tests");
console.log("run-tests step:", JSON.stringify(step));
console.log("run total:", JSON.stringify(s.totals));
'

# And read the commands, because both predicates are crude (R3) — grouped by stepId so a mention
# in `spec`/`review-spec`/`document` cannot be mistaken for a wait inside `run-tests`:
node -e '
const fs=require("fs");
for (const l of fs.readFileSync(process.argv[1],"utf8").split("\n")) {
  if (!l.trim()) continue; let e; try { e = JSON.parse(l) } catch { continue }
  if (e.type!=="tool-call"||e.tool!=="Bash") continue;
  const c=(e.input&&e.input.command)||"";
  if(/\bsleep\s+[\d.]+/.test(c)) console.log(e.stepId, "| SLEEP |",c.replace(/\s+/g," ").slice(0,160));
}' /var/lib/cezar/loki-labs/cezar/.ai/cezar/runs/bde0ec40-06da-4628-8410-06a6a42694c7.ndjson
```

**Corrected 2026-08-22 (revision 7, after review ran the claim below and found it false):** an
earlier draft of this paragraph claimed this run's own `review-spec` step "scored `sleepCalls: 1`
while `sleepExecMs: 0`" and proposed `sleepExecMs` growth as the mention-vs-wait discriminator.
Running the pinned commands against `review-spec` gives `sleepExecMs: 1216`, not 0 (re-verified
here: `cez run stats bde0ec40-06da-4628-8410-06a6a42694c7 --json --repo
/var/lib/cezar/loki-labs/cezar`, `review-spec` row). And per § Data models / `stats.ts:830-836`,
`sleepExecMs` sums the exec time of the **whole containing Bash call** (`ts - call.startedAt`
between the `tool-call` and its `tool-result`), not the sleep alone — so it cannot discriminate in
either direction. A prose mention of `sleep 120` sitting inside a slow `grep` scores high and reads
as "a genuine wait"; a correct early-exit poll loop that exits on its first probe scores near zero
and reads as "a mention." The rule is deleted, not repaired.

**A counted `sleepCalls` is not necessarily a wait, and this run's own `review-spec` step already
demonstrated the failure mode** — but the evidence is the command TEXT, not the exec time: its one
hit is this file's own § Problem section quoting `sleep 120; tail -12 …` as example prose inside a
Bash call, which the raw-text predicate cannot tell apart from an executed wait. So the per-`stepId`
`SLEEP |` dump pinned above is the **only** sound adjudicator. When reading it, `document` must
quote every matched command in this section and classify it as one of:
- **(a) an executed wait** — the command actually blocked on the sleep as part of waiting for
  backgrounded work;
- **(b) a mention** — `sleep <n>` appears as quoted text, example prose, or inside a string/heredoc
  the predicate didn't strip, inside a command that waited for nothing (`review-spec`'s hit is this
  case); or
- **(c) a guarded wait** — a `sleep` inside an early-exit loop (tier 3 of the doctrine, § Solution
  L1 — legitimate, not a defect).

Only class (b) may be discounted from a count; classes (a) and (c) both count as real `sleepCalls`
— (c) is the legitimate pattern, (a) is the defect `blindSleepCalls` already flags on its own,
since an unguarded executed wait is exactly what the predicate calls blind. `sleepExecMs` stays in
the printed output as reported context, never as a rule to classify by. This is *also* why `document` must paste the
numbers and the dump into this file with the `Edit` tool (or `Write`), never a Bash
`sed`/`printf`/inline-arg — a heredoc is technically safe (`stripHeredocs` removes bodies before
the predicate runs), but naming the safe tool is cheaper than depending on that mechanics detail
holding for whatever `document` happens to write.

**Corrected 2026-08-22 (revision 7, after review):** an earlier draft gated criterion 1 on the
`run-tests` step's own row and demoted the whole-run total to "context, not the gate." That is
narrower than the task's own criterion (`cez run stats <AFTER_RUN_ID> --json` reports
`blindSleepCalls == 0`, run-level, no step filter) and the narrowing is not safe: `implement` and
`commit-push` both run before `document` and both plausibly wait on something real (a build, a
push, an install), so a blind `sleep 60` in either would have been invisible under the old wording
and the run would still ship as "implemented" with the headline number unread. `deploy` (step 8)
stays out of reach — the scope note below covers why that is accepted. The gate is restored to the
whole run below; the `run-tests` row is kept as supporting detail, not dropped.

**Pass, all four, judged on the whole-run total — the `run-tests` row is supporting detail, read
alongside it:**
1. `blindSleepCalls == 0` for the **whole run** — the hard criterion, and criterion 3 of the task
   operationalized verbatim. If the total is nonzero, every counted call must be adjudicated
   individually from the per-`stepId` dump above, using the (a)/(b)/(c) classification from the
   mention-vs-wait paragraph — its step named and its command quoted in this section — and only a
   call classified (b) (a mention, not a wait) may be discounted from the total. The discount and
   its reasoning are written into this section; nothing is dropped silently. A hit in `implement`
   or `commit-push` counts exactly as much as one in `run-tests`.
2. Every surviving `sleep`, across the whole run, is visibly inside an early-exit loop (class (c)) —
   not inferred from the count (R3's false-guarded direction). The `run-tests` dump is read first,
   since that step is what the doctrine chiefly targets, but a hit elsewhere is not exempt.
3. `repeatedExpensiveCalls`, whole run, is 0, **or** every survivor is explained as a legitimate
   re-run after an edit (§ Data models says the metric cannot tell these apart; a human read
   decides). This run made no code change (revision 5 point 3), so any repeat has no such excuse.
   The `run-tests` row is the one most worth reading first, since that step is where the suite
   actually runs.
4. `batchFactor` (run total) has not fallen below the 1.00–1.02 baseline, and the `run-tests`
   step's own report quotes an exit-marker line.

**Fail, and say so:** any blind sleep survives the whole-run total after discounting (per criterion
1), or `run-tests` reports a gate whose marker it cannot quote. Record the after-run id in this file
and in the KB either way — a negative result is what the 2026-08-20 spec failed to record on time,
and is the reason this spec exists.

**Scope note, so a later re-run of these commands is not misread as a regression:** `document` is
workflow step 7 of 8; `deploy` (step 8) runs after it and is invisible to these numbers. The result
below is "as of `document`, `deploy` not included" — accepted, because `deploy` runs no gate and so
cannot move any of these four counters; re-stated here only so nobody re-runs `cez run stats`
post-`deploy`, gets an identical result, and wonders why it wasn't re-verified.

**Result: PASS (criteria 1-3 outright; criterion 4 passes only after `document` re-ran the gate
itself — see below).** Measured 2026-08-22T12:10Z by the `document` step of run
`bde0ec40-06da-4628-8410-06a6a42694c7`, by running the three pinned commands above verbatim
(all exit 0).

**The whole-run total — the gate (revision 7):**

| metric | after-run `bde0ec40` | baseline `7c2dd8f0` | baseline `c10864d1` |
| --- | --- | --- | --- |
| `blindSleepCalls` | **0** | 4 | 2 |
| `sleepCalls` | 5 | 18 | 14 |
| `sleepExecMs` | 16 505 (16.5 s) | ≈802 100 (13.4 min) | ≈2 532 000 (42.2 min) |
| `repeatedExpensiveCalls` | **0** | 18 | 0 |
| `batchFactor` | 1.00 | — | — |
| `toolCalls` / `roundTrips` | 206 / 206 | — | — |

**The `run-tests` row, as supporting detail:** `wallMs` 112 344 (1 m 52 s), `toolCalls` 22,
`batchFactor` 1, `sleepCalls` 4, **`blindSleepCalls` 0**, `sleepExecMs` 15 289,
`repeatedExpensiveCalls` 0.

**The per-`stepId` `SLEEP |` dump, all five hits, each classified (a)/(b)/(c):**

```
review-spec | SLEEP | set +e W=/var/lib/cezar/loki-labs/cezar/.ai/cezar/worktrees/bde0ec40-… R=/var/lib/cezar/loki-labs/cezar cd "$W" printf '\n===== 1. cez …
run-tests   | SLEEP | until grep -q "^EXIT=" /tmp/gate-typecheck.log 2>/dev/null; do sleep 5; done; tail -5 /tmp/gate-typecheck.log
run-tests   | SLEEP | until grep -q "^EXIT=" /tmp/gate-test.log 2>/dev/null; do sleep 15; done; echo done
run-tests   | SLEEP | until grep -q "^EXIT=" /tmp/gate-test-unit.log 2>/dev/null; do sleep 10; done; echo done
run-tests   | SLEEP | until grep -q "^EXIT=" /tmp/gate-test.log 2>/dev/null; do sleep 15; done; echo done
```

1. **`review-spec` — class (b), a mention. Discounted.** The 160-char dump truncates the evidence,
   so `document` re-dumped the call in full (1 647 chars): it runs `cez run stats … | grep`, then a
   `node -e` sleep-dump, then a *self-contamination check* whose `node -e` array literal contains
   the strings `until grep -q "^EXIT=" /tmp/g.log; do sleep 5; done` and
   `sleep 120; tail -12 /tmp/full-suite-mine.log` as example commands to test the predicate against.
   Both are quoted text inside a JS array; the call blocked on nothing. Note this is a *different*
   class-(b) instance than the one revision 7 predicted — that paragraph guessed the hit would be
   § Problem's `sleep 120` quotation, and it is in fact `review-spec` testing the predicate with
   that same string as a fixture. Same class, different call; the prediction's reasoning holds.
   It carried `blindSleepCalls` 0 regardless, so the discount changes no verdict.
2-5. **`run-tests` — all four class (c), guarded waits.** Every one is the doctrine's tier-3 idiom
   verbatim: `until grep -q "^EXIT=" <logfile>; do sleep N; done`, polling for the exit marker the
   backgrounded gate writes, exiting on the first probe that finds it. Not one bare `sleep N`
   anywhere in the run. Three of the four (`gate-test`, `gate-test-unit`, `gate-test` again) were
   additionally dispatched as harness-backgrounded calls — their `tool-result` is
   `Command running in background with ID: …`, so the loop never blocked the agent at all; only the
   `gate-typecheck` wait actually blocked, which is where nearly all of the 15.3 s `sleepExecMs`
   went.

**Attribution — why this run's zero attributes to the deployed doctrine, unlike `70f19253`'s.** Two
independent lines of evidence. (i) Revision 5 established the worktree was born 28.9 s after
`/opt/cezar`'s dist carried `ada8f376`'s content, and revision 3 of `review-spec` re-verified it
from the *composed system prompt* after a mid-run redeploy at 02:09:54; `implement` (02:23:13) and
`run-tests` (02:25:37) both ran well after that. (ii) Stronger and cheaper: the four surviving
sleeps are not merely *compatible* with the new doctrine, they are its **literal worked example** —
the doctrine text ships the string `until grep -q EXIT= "$f"; do sleep 5; done`, and `run-tests`
emitted that exact idiom four times against three different log files. The old doctrine contained no
such example, which is why the baselines are full of bare `sleep 120; tail …`.

**Against the four conditions:**

1. **PASS.** `blindSleepCalls == 0` for the whole run, before any discounting — so the class-(b)
   discount above is recorded for completeness, not needed to reach the number. A hit in
   `implement` or `commit-push` would have counted; both scored 0 (`implement` 0 sleeps of 18 tool
   calls, `commit-push` 0 of 0).
2. **PASS.** Every surviving sleep is visibly inside an early-exit loop — read off the command text,
   quoted above, not inferred from the count. Four class (c), one class (b), zero class (a).
3. **PASS.** `repeatedExpensiveCalls == 0`, whole run and `run-tests` row alike, so the "explain
   every survivor" branch is not needed. Read, not asserted: against the `7c2dd8f0` baseline of 18
   (headed by one test file run 11 times), this run ran `npm ci` once, `npm run typecheck` once,
   `npm test` once and `npm run test:unit` once.
4. **PASS, but only after a `document`-step re-run, and the shortfall is recorded rather than
   rounded up.** `batchFactor` (run total) is 1.00 and has not fallen below the 1.00–1.02 baseline.
   The exit-marker half was **initially short**: `run-tests` quoted `EXIT=0` for `typecheck` and
   `EXIT=0` / `# pass 44 # fail 0` for `test:unit`, but its final text is *"Waiting for the
   `npm test` background monitor to report back"* — it never quoted `npm test`'s marker, because
   the step ended and `commit-push` died 5 s later with
   `run broker … did not respond after 5000ms — giving up`. That is the run-broker defect fixed
   separately on `origin/main` by `3e6d1b7e` / `8e20dfbf` / `0883256b`, not a sleep-doctrine
   failure — no sleep was involved and no counter moved. `document` closed it by merging
   `origin/main` (`0883256b`) into this branch and re-running the full gate itself; the markers it
   quotes are recorded in § Verification §5 below. **Had the gate not been re-run, the honest verdict
   on criterion 4 would have been FAIL-by-its-own-wording** ("`run-tests` reports a gate whose marker
   it cannot quote"), and this paragraph would have said so.
   **The criterion is "quotes a marker", not "the marker is green", and the re-run's markers were
   not all green:** `npm ci`, `typecheck` and `test:unit` returned `EXIT=0`, `npm test` returned
   `EXIT=1` on 3 failures of 9634. All three are pre-existing on `origin/main` and cannot be caused
   by a branch that changes one markdown file; two are load flakes that passed on re-run and the
   third is a reproducible budget failure filed as todo `90b00d11-b564-42ec-ae10-08bf057e5813`.
   § Verification §5 has the detail. **This spec therefore does not claim a green suite** — it
   claims the four sleep counters, which no part of that failure touches.

**Standing caveat on these numbers, with `document`'s own contribution measured rather than
predicted.** The table above is the state at 12:10Z, before `document` did its work; `document` is
itself a metered step, so the counters moved while this section was being written. Re-measured at
12:22Z, after the gate re-run and these edits:

| metric | at 12:10Z (the table above) | at 12:22Z (post-`document`) |
| --- | --- | --- |
| `blindSleepCalls` | **0** | **0** |
| `sleepCalls` | 5 | 5 |
| `repeatedExpensiveCalls` | 0 | 3 |
| `toolCalls` | 206 | 245 |
| `batchFactor` | 1.00 | 1.00 |

Two things worth reading off that, neither smoothed over:

- **`blindSleepCalls` held at 0 and `sleepCalls` did not move at all.** `document` ran four
  long jobs — `npm ci`, `typecheck`, `npm test`, `test:unit` — and waited on every one without
  emitting a single `sleep`, by using tier 2 (hand the job to the harness, get woken on
  completion) rather than tier 3. That is the doctrine's *preferred* tier, so the after-run
  demonstrates both of its legitimate patterns: `run-tests` used tier 3 and `document` used tier 2.
- **`repeatedExpensiveCalls` rose 0 → 3, and the three are `document`'s own**, all of them
  `npx vitest run src/knowledge/catalog.test.ts` — re-run deliberately, three times, to establish
  whether the C18 budget failure in § Verification §5 was a load flake or reproducible (it is
  reproducible: 68.12 / 62.81 / 59.41 ms/MiB). § Data models says this metric cannot tell a
  legitimate repeat from a wasteful one and that a human read decides; this is the read.
  **Re-running an expensive command to characterise its variance is the legitimate case** — it is
  the one thing a saved log cannot be re-sliced to answer, since the question *is* the spread
  across runs. That is a genuine third exception to § Verification §4 criterion 3's "after a code
  change, or a defect" framing, and it is recorded here rather than quietly absorbed.

`blindSleepCalls` is the number that must stay 0, it is the only one this section gates on, and it
is 0 at both timestamps.

This line is the one the top Status block's flip to "implemented" points at.

### §5 — The `document`-step gate re-run (closing criterion 4's exit-marker half)

Criterion 4 asks that the gate's exit markers be quoted, and `run-tests` could quote only two of
three before the run broker killed the step (§4 → Result → condition 4). `document` closed the gap
itself: it merged `origin/main` (`0883256b`) into `cez/bde0ec40` — the branch was 22 behind, 1
ahead — reinstalled, and re-ran the full gate on 2026-08-22 from 12:11Z. Markers, quoted:

| gate | marker | verdict |
| --- | --- | --- |
| `npm ci` | `EXIT=0` (`added 470 packages`) | pass |
| `npm run typecheck` | `EXIT=0` | pass |
| `npm run test:unit` | `EXIT=0` — `# tests 44  # pass 44  # fail 0` | pass |
| `npm test` | **`EXIT=1`** — `Test Files 3 failed \| 520 passed (523)`, `Tests 3 failed \| 9630 passed \| 1 skipped (9634)` | **3 failures, none from this branch** |

**The three `npm test` failures are pre-existing on `origin/main` and cannot be caused by this
change, which modifies exactly one file — this markdown spec** (`git diff --name-only
origin/main...HEAD` returns it alone). Re-running the three files by themselves separated them:

- **`project-context.test.ts`** (`knowledgeStore is built only under CEZ_KB=1 …`, `Test timed out in
  5000ms`) — **load flake, passed on re-run.**
- **`add-project-dialog.test.tsx`** (`expected '/p/cezar/' to be '/p/added/'`, a navigation race) —
  **load flake, passed on re-run.**
- **`catalog.test.ts` C18** (`expected 67.58… to be less than 40`) — **reproducible, and a genuine
  open defect.** Measured 67.58 / 68.12 / 62.81 / 59.41 ms/MiB across four runs at load average
  8.5–19, including runs of the file alone. Filed as todo
  `90b00d11-b564-42ec-ae10-08bf057e5813`. It is not a flake and is not being called one: the test
  deliberately takes the **minimum of three repeats of process CPU time** rather than wall clock,
  precisely so ambient load cannot move it, and its own comment records 17.4 ms/MiB alone and
  23–34 ms/MiB loaded when the 40 line was set on 2026-08-06. Today's numbers are roughly double
  the loaded figure from then. Either `buildCatalog` regressed or the line was never valid on this
  box; the todo carries the measurement that would separate the two.

**Why this does not change §4's verdict.** All three failures are in `npm test` on `origin/main`,
touch no sleep-doctrine code, and move none of the four counters. The box was at load average 19
during the full-suite run — worth recording on its own account, because **resource-budget and
timeout assertions are not safe gates on a machine that runs parallel agent workloads**, and two of
these three were exactly that.

### §6 — A third dispatch tried for a second data point and could not get one (2026-08-22, later the same day)

**Not a supersession — nothing above is retracted.** Recorded here, not as a Status-line revision,
because the confirmation attempt below produced no new claim to weigh against revision 8: it
never reached a second measurement.

Run `bde0ec40-06da-4628-8410-06a6a42694c7` — the same run id §4/§5 measure — was dispatched a
third time (first dispatch: 01:51-02:27Z, ended on a broker failure; second: 12:13-12:24Z, the
pass that produced the PASS result and §4/§5 above; third: 12:41Z onward) for the identical task
text, after the second dispatch's own handoff had already recorded "TASK COMPLETE." The third
dispatch's `spec` step, finding the task already done, wrote a new file,
`.ai/specs/2026-08-22-sleep-doctrine-phase-4-confirmation-rerun.md`, proposing to treat the
unwanted re-dispatch as free corroboration: let the chain's `run-tests` execute again and read the
*delta* against a pre-pass baseline, as a second, independent data point for the same claim.

`review-spec` rejected that design as unexecutable, for a reason worth keeping: `computeRunStats`
(`packages/cezar/src/runs/stats.ts`) buckets a run's stats **cumulatively per `stepId`**, not per
dispatch. A re-dispatch that re-runs a step named `run-tests` does not append a distinguishable
second entry — it overwrites or merges into the *same* stored bucket that step id already owns. No
new step id is minted, so there is nothing a "delta since the pre-pass baseline" query could
address; the confirmation-rerun spec's own Phase 5 depended on a capability the storage model does
not have. `review-spec` also flagged that the spec's Phase 6 assigned writing the addendum to
`commit-push`, which holds no `Write`/`Edit` tool and no `cez run stats` in its `bashAllowlist`
(confirmed directly against `AUTONOMOUS_IMPLEMENTATION_WORKFLOW`'s step definitions in `run.ts` —
`document` is the only step after `run-tests` with both).

The chain never revised the spec to fix either issue and never re-ran `implement`/`run-tests` a
third time. Confirmed empirically, from `document` (this step, third dispatch), by re-running the
exact command §4 pins:

```
cez run stats bde0ec40-06da-4628-8410-06a6a42694c7 --json --repo /var/lib/cezar/loki-labs/cezar
```

Totals: `blindSleepCalls 0`, `sleepCalls 5`, `sleepExecMs 16505`, `repeatedExpensiveCalls 3`,
`batchFactor 1` — **byte-identical** to the 12:22Z reading already recorded in §4's "Standing
caveat" table, and the `implement`/`run-tests` per-step rows are unchanged from §4's dump. That is
direct confirmation of `review-spec`'s bucketing concern, not just its prediction: the third
dispatch's `run-tests` never executed a second time: the chain went `review-spec` (revise) →
`continue-1` → `continue-2` → `document` without a second pass through `implement`/`run-tests`.

**So: no second data point exists, and none is claimed here.** The confirmation-rerun spec is
marked abandoned (see its own Status line) rather than executed. This does not weaken revision 8 —
the PASS in §4 was never in question — it only means Phase 4 still rests on **one** measurement,
not two, and a fourth dispatch of this run id would face the identical bucketing obstacle if it
tried the same design again. A todo is filed for the underlying question this section does not
answer: why a `spec-to-deploy` run whose handoff says "TASK COMPLETE" gets redispatched at all
(`cezar todo add`, filed 2026-08-22, see the confirmation-rerun spec's Risks section for the same
flag raised and left open one dispatch earlier).

## Open questions — settled here

**Q1. What mechanism?** Settled: the three tiers of L1, foreground first, plus the
never-end-your-turn rule. `wait $PID` works *within* one call and not across calls; the task's
wording is corrected in § Solution rather than obeyed literally.

**Q2. Backend-portable?** Settled: name no tool *or parameter* (this is why `run_in_background`
left the doctrine); tiers 1 and 3 are pure shell (§ Architecture), and § Verification §1 asserts it.

**Q3. Does a bounded poll loop violate criterion 3?** Settled: **no.** Criterion 3 says "as a wait
for backgrounded work", and `blindSleepCalls == 0` is that clause made executable. 32 of 39
measured sleeps are the good pattern; a bare `grep sleep` criterion would ban them and would be
satisfied by a run that never tested anything.

**Q4. One-off or a gate?** Settled: metrics on `StepStats` (Phase 3). They are derived-on-demand,
so they cost no store or contract change, and they make every future run measurable instead of
requiring an ad-hoc replay. Note the related open defect: `cez run stats` prints
`1.00 = never batched` for a run that batched perfectly (`stats.ts:328`, todo `3dd1907d` per the
brief) — adjacent, not fixed here.

**Q5. Which run proves it?** Settled: not this one; § Verification §4 defines the requirements the
named after-run must meet, and the id goes into this file.

**Q6. Should `run-tests` get a `verify:` post-condition?** **Explicitly deferred**, with the reason
recorded. `POSTCONDITION_IDS` is `['everything-committed', 'all-services-deployed']`
(`workflows/postconditions.ts:45`, re-verified this session); a `gates-green` built-in would have
to decide what "the gates" are in an arbitrary repo — a real design question, not a line of code,
and it is owned by todo `f42e2ad2`. This spec ships the cheap prompt-level mitigation (L4) and does
not pretend it is a post-condition.

**Q7. Does `bashAllowlist` interact?** Settled: **no, not today.** Allowlists are decorative on the
claude backend (`claude-cli-runner.ts:668-677`, verified against `claude` 2.1.233 on this box), and
the recipe introduces no new binary — `sleep`, `grep` and `sed` all already appear inside `set +e`
batch scripts that the STARTS-WITH prefix patterns could never match anyway. That mismatch is a
pre-existing defect owned by todo `444c7db2` ("Decide what allowedTools should actually restrict",
open, confirmed in `cezar todo list` this session).

## What I could not verify

- **The 16.9-minute, six-session figure.** Only five run NDJSONs remain on this box. Cited from
  kb `notion-cc6ebabb2ab4`, not reproduced. My own five-run measurement is in § Problem and is the
  number the phases are sized against.
- **Whether the KB note's "12 times" and my "11 times" are the same event.** The note counted
  across six sessions; I measured 11 repeats of `brokered-session.test.ts` inside `7c2dd8f0`
  alone. They are consistent and probably the same underlying behaviour, but I did not join them.
- **Todo ids from the brief.** `cezar todo list` in this worktree returned no rows matching
  `eb6e528b`, `f42e2ad2`, `095a272e`, `881c4f7b` or `3dd1907d`; only `444c7db2` was confirmed
  present. The others are cited **as reported by the brief and the KB notes**, unverified here.
- **Whether 252 words dilutes the step prompt.** No measurement exists for this, on either side of
  the cap. R1 records the trade rather than resolving it.
- **`e06f2169`'s and `70f19253`'s final counts.** Both were live while I measured; their § Problem
  rows are a snapshot, not a settled result.

## Provenance

Read in the `spec` step of run `70f19253`, 2026-08-21: the brief
`.ai/specs/briefs/2026-08-21-stop-guessed-sleep-waits.md`; kb `notion-cc6ebabb2ab4`
(`local:2026-08-21-cezar-run-speed-measured`) in full; `.ai/specs/2026-08-20-agent-round-trip-batching-and-fanout.md`
(structure, §Risks R2/R6/R7); `.ai/specs/2026-08-20-steps-green-only-when-verified.md` (format);
`.ai/specs/2026-07-18-subagent-monitoring-status.md:38-50`; `packages/cezar/src/workflows/run.ts:495-545`;
`packages/cezar/src/workflows/types.ts:700-775`; `packages/cezar/src/workflows/system-prompt.test.ts:55-100`;
`packages/cezar/src/workflows/types.test.ts:220-245`; `packages/cezar/src/runs/stats.ts:34-135`,
`:132-248`, `:279-330`; `packages/cezar/src/runs/stats-cli.ts:1-120`;
`packages/cezar/src/core/agent-runner.ts:80-105`; `packages/cezar/src/core/claude-cli-runner.ts`
(flags at `:668-712`); `AGENTS.md:402-448`; `packages/cezar/src/workflows/postconditions.ts:45`.

**Re-read on `origin/main` at `20319ab0` for revision 2** (not on the worktree's `f0d48513`):
`run.ts` (doctrine verbatim, 203 words by the test's own counting rule), `system-prompt.test.ts`
(pins at `:67`, `:72`, `:74`, `:75`, `:77`, `:79`; cap at `:86`), `types.test.ts:229-238`,
`stats.ts` (`computeRunStats` switch, `formatRunStats` header), `stats-cli.ts:117`.

Measured this session on this box: the five `.ai/cezar/runs/*.ndjson` transcripts, replayed with
node for sleep counts (three predicate variants), exec times, and repeated costly invocations; the
raw claude transcripts under `~/.claude/projects/*worktrees*/`; the doctrine's word count via
`eval` of the template literal; the fixture's missing `input`; `claude --version` → **2.1.233**;
`cezar todo list`; `git diff f0d48513..origin/main` over the target files (empty).

**Revision 5, read in the `spec` step of run `bde0ec40-06da-4628-8410-06a6a42694c7`, 2026-08-22:**
`git merge-base --is-ancestor ada8f376 HEAD` (true) and `git show -s --format='%H %ci' ada8f376`
(2026-08-21T20:32:12Z); `stat /opt/cezar/packages/cezar/dist/index.js` (Modify
2026-08-22T01:43:30Z) and `stat` on this run's worktree directory (Birth 2026-08-22T01:43:59Z, a
28.9 s gap computed with `python3`); `grep` of the deployed
`/opt/cezar/packages/cezar/dist/workflows/run.js` for `never on a guess` and
`never re-run an expensive command`, `dist/workflows/types.js` for `QUOTE the` and
`exit-marker line`, and `dist/runs/stats.js` for `blindSleepCalls` (all present); this worktree's
`packages/cezar/src/workflows/types.ts:832-882` (`run-tests` step, current line numbers — moved
since revision 1-4 from `:721-755` after `review-spec` was inserted) and `:624-632` (the eight
`SPEC_TO_DEPLOY_WORKFLOW` step ids, confirmed via `awk`); this run's own handoff file
(`.ai/cezar/runs/bde0ec40-06da-4628-8410-06a6a42694c7.handoff.md`) for the task text, acceptance
criteria and baseline figures it was given. **Not read in this revision:** this run's own
`.ndjson` (it has no `run-tests` data yet — see point 4 above for why that read belongs to the
`document` step).

**Revision 7, read in the `spec` step of run `bde0ec40-06da-4628-8410-06a6a42694c7`, 2026-08-22, in
response to review flagging § Verification §4's `sleepExecMs` claim as unmeasured and its criterion
1 as narrowed unsafely:** `packages/cezar/src/runs/stats.ts:830-836` (the `tool-result` branch —
confirms `sleepExecMs` accrues `ts - call.startedAt` for the whole Bash call, not a sleep-specific
duration); `cez run stats bde0ec40-06da-4628-8410-06a6a42694c7 --json --repo
/var/lib/cezar/loki-labs/cezar`, `review-spec` row (`sleepExecMs: 1216`, confirming the review's
number and refuting the earlier draft's "0"). No other file changed in this revision; the fix is
confined to § Verification §4 and the matching sentence in the revision-5 callout, point 4, per the
review's own scoping.
