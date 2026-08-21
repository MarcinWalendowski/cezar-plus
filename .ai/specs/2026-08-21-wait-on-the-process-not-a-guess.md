# Wait on the process, not on a guess — and slice the file you already saved

> **Status — superseded 2026-08-21 by revision 3 (below): PHASES 1-3 IMPLEMENTED, Phase 4
> outstanding.** ~~SPEC ONLY — nothing implemented.~~ That line was true when the `spec` step wrote
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
> **Phases 1-3 are shipped and green. Phase 4 (the after-run) is still outstanding** and cannot be
> satisfied by this run — § Verification §4 stands unchanged as the thing that decides whether any
> of this worked. Until it has run, this spec has changed prompt text and shipped a meter; it has
> **not** demonstrated a saving, and no speed claim from it is admissible (R5).
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

Not optional, and not satisfiable by this run. See § Verification §4.

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

**This run (`70f19253`) cannot serve as the after-measurement** — its steps are read-only, it made
3 sleep calls totalling 0.0 min and 0 repeated expensive calls. The named after-run must be a
`spec-to-deploy` run **that actually executes a `run-tests` step**, started after this change is
deployed to `/opt/cezar/packages/cezar/dist/`. Deployment matters: the doctrine ships as compiled
`dist`, and the KB note had to correct an earlier claim that it was not deployed.

```bash
# Baselines already on this box (before):
#   7c2dd8f0 → blindSleepCalls 4, sleepCalls 18, repeatedExpensiveCalls 18
#   c10864d1 → blindSleepCalls 2, sleepCalls 14, repeatedExpensiveCalls 0
cez run stats <AFTER_RUN_ID> --json \
  | grep -E 'blindSleepCalls|sleepCalls|repeatedExpensiveCalls|batchFactor'

# And read the commands, because both predicates are crude (R3):
node -e '
const fs=require("fs");
for (const l of fs.readFileSync(process.argv[1],"utf8").split("\n")) {
  if (!l.trim()) continue; let e; try { e = JSON.parse(l) } catch { continue }
  if (e.type!=="tool-call"||e.tool!=="Bash") continue;
  const c=(e.input&&e.input.command)||"";
  if(/\bsleep\s+[\d.]+/.test(c)) console.log("SLEEP |",c.replace(/\s+/g," ").slice(0,160));
}' .ai/cezar/runs/<AFTER_RUN_ID>.ndjson
```

**Pass, all four:**
1. `blindSleepCalls == 0` — the hard criterion, and criterion 3 of the task operationalized.
2. Every surviving `sleep` is visibly inside an early-exit loop, read from the dump above — not
   inferred from the count (R3's false-guarded direction).
3. `repeatedExpensiveCalls` is 0, **or** every survivor is explained as a legitimate re-run after
   an edit (§ Data models says the metric cannot tell these apart; a human read decides).
4. `batchFactor` has not fallen below the 1.00–1.02 baseline, and the `run-tests` step's report
   quotes an exit-marker line.

**Fail, and say so:** any blind sleep survives, or `run-tests` reports a gate whose marker it
cannot quote. Record the after-run id in this file and in the KB either way — a negative result is
what the 2026-08-20 spec failed to record on time, and is the reason this spec exists.

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
