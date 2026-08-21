# Brief — run-tests burns 14% of a run's output budget while executing 34s of tools

**Task id:** 95d3c6f2-7e11-4a1d-826c-e03a5a5a168b · **Step:** 1 of 8 (Gather the record) · **Date:** 2026-08-21

## The problem, in this repo's own terms

`run-tests` is step 5 of the built-in `spec-to-deploy` workflow
(`packages/cezar/src/workflows/types.ts:755-804`). Its job, per its own prompt, is: run the
repo's gates, fix what the diff broke, report pass/fail with the exit markers. On the
measured run (`70f19253-cf6b-407c-92e0-96a8020a8ebb`, 2026-08-21) it instead emitted **43,583
output tokens** — more than the entire first spec draft (40,619) and 4.3× `commit-push`
(10,076) — for **34s of actual tool execution** inside a 631s step. Cost: **$4.16** of the
run's $32.53.

The framing that makes this worth fixing at all: cezar runs are **output-token bound**
(KB `notion-333c1a0a847b`, `notion-20c9698de5f9`) — idle generation, not tool execution or
round-trip latency, is 82% of wall clock, at ~81 tok/s. So 43,583 output tokens is not a
cosmetic verbosity complaint; it is directly ~9 minutes of the step's own 631s wall time.

## What I found in the actual run log (not assumed)

Source: `/var/lib/cezar/loki-labs/cezar/.ai/cezar/runs/70f19253-cf6b-407c-92e0-96a8020a8ebb.ndjson`,
lines 1538-1881 (the `run-tests` step, session `8188f5a4-4d30-42b3-8169-5638456b1916`).
`usage.updated` at seq 1875: `{"input":70,"output":43583,...}`, `costUsd: 4.159684` — the
exact figure in the task's framing, confirmed from source rather than trusted secondhand.

### Acceptance criterion 1 — where did the tokens go (quoted, not asserted)

**(a) does NOT dominate.** `npm test` in this run reported `Tests 2 failed | 9515 passed |
1 skipped (9518)` — not the 2,152-failure baseline the task warned to check for (todo
`c78140a8`, unverifiable directly — `cezar todo list` needs a registered `--project` and
the KB has no exact-id lookup, but the number 2,152 appears nowhere in this run's own gate
output). The two `npm test` failures were identified as **already documented** in one pass:
*"Chain B: 2 failed | 9515 passed — and both are the exact failures AGENTS.md documents
(trap 3's C18, and the known `add-project-dialog` flake)."* That recognition cost almost
nothing. **This task does not fold into c78140a8** — measured, not assumed.

**(c) dominates, but not "diagnosing its own change" in the usual sense — diagnosing a
second, unrelated, previously-undocumented red it correctly ruled out as its own fault, and
then kept root-causing anyway.** `npm run test:package` failed 1/15. The step:
1. Read the failing test, reproduced it directly against the built CLI.
2. Reproduced **identically against the parent checkout's `dist` at commit `f0d48513`** —
   a commit containing none of this change — which is what proves it's pre-existing.
3. Kept going anyway: A/B'd `CEZ_RUN_BROKER=0` (fixes it) vs. the default broker path
   (stalls), A/B'd the env scrub, A/B'd a TTY (`script -qec`), read
   `claude-cli-runner.ts`'s broker-attach code and `index.ts:233`, spawned and then had to
   hunt down and `kill` several orphaned probe processes by PID.
4. Filed the result as a new, well-evidenced todo (`3c6a5aa7`, priority high) and correctly
   did **not** fix it ("the broker/spool subsystem is outside this task, the red predates
   the branch").

Every one of those steps was individually defensible — step 2 is exactly the discipline
AGENTS.md asks for ("localise the fault to what both runs share"), and the step found a
real, previously unknown bug. But nothing in the step's prompt or in AGENTS.md bounds *how
much* of that diagnosis belongs to a step whose contract is "report pass/fail," once step 2
has already answered "is this my fault? No."

**(b) is a red herring for this run.** I measured it directly rather than assume: 29 visible
assistant text blocks, 7,589 chars (~1,900 tokens) — terse, one-to-three-sentence status
lines, not padding. The 37 tool-call inputs (the diagnostic bash scripts themselves) total
~32,095 chars (~8,000 tokens). **Visible content (text + tool-call bodies) accounts for only
~10,000 of the 43,583 output tokens — about 24%.** The other ~33,000 tokens (76%) do not
appear as any visible event in the log at all. Given the framing's own claim that idle time
*is* output tokens, this is almost certainly extended-thinking/reasoning tokens spent
forming and interpreting each of the 9 diagnostic probes — real compute, billed and clocked
identically to visible text, but invisible to a transcript read and untouched by an
instruction like "don't narrate." **This is the single fact that most changes the shape of
the fix**: a prompt tweak aimed at trimming prose will not touch three-quarters of the spend.

### A confound the next step must not miss

The `run-tests` step in this measured run ran on **`claude-opus-5[1m]`**
(`session.started` event, seq 1539) — not sonnet. `SPEC_TO_DEPLOY_STEP_MODEL = 'sonnet'`
(the per-step model policy, `.ai/specs/2026-08-21-per-step-model-policy.md`, commit
`a5f04b0f`, "opus reviews, sonnet builds") landed at **2026-08-21 21:52:09 UTC** —
`git log` confirms it — while this `run-tests` step finished at **20:30:18 UTC**, 82 minutes
earlier. **Every `spec-to-deploy` run since `a5f04b0f` runs `run-tests` on sonnet by
default; this 43,583-token figure is a pre-policy-change, opus measurement.** It cannot
stand as the "before" baseline for a post-fix comparison, and acceptance criterion 4 ("drop
below 20,000 on a comparable run") needs a **fresh** run taken after `a5f04b0f`, not a
re-read of this one.

## What the record already decided (citations)

- `notion-333c1a0a847b` / `notion-20c9698de5f9` (2026-08-20, "Round trips, not tool
  execution…") shipped the batching/wait-on-process doctrine that is now baked into
  `run-tests`'s own prompt (`types.ts:773-804`: background the install, wait on the exit
  marker, never `sleep N`, don't re-run a gate to re-read it, quote the exit line). Its own
  correction (`notion-cc6ebabb2ab4`) recorded that this **moved the batch factor 1.00→1.02
  and did not move wall clock** — because round trips were never the driver, output tokens
  were. **This task is the next link in that exact chain**: the previous fix addressed *tool
  call* discipline; this one is about *reasoning-depth* discipline, which the prior fix
  explicitly did not touch.
- `specs-055be85ab716` ("Every step and every tool call says how long it took," DONE) is
  where the per-step `wallMs`/`toolExecMs`/`modelMs` breakdown comes from — but note the
  cached `/tmp/stats-70f19253-*.json` for this run is **stale/partial** (only 4 of the 8
  steps, no `run-tests` entry); the real per-step numbers for this run had to come from the
  run's own `.ndjson`, not that cache.
- `specs-9e1e3308c99f` (per-step model policy, implemented 2026-08-21) already reduced
  `run-tests`'s default cost/verbosity lever once, by moving opus→sonnet, independent of
  anything a prompt rewrite would do. See confound above.
- AGENTS.md's own `npm test` traps (C18 / `add-project-dialog`, documented at length around
  lines 297-430) are the existing pattern for making a known red **cheap to recognize**
  instead of re-diagnosed every run — and it visibly worked in this transcript (one pass,
  not five probes). AGENTS.md does **not** yet document the `test:package` broker-stall
  failure this run discovered — grepped for `ctl.sock`, `attachBroker`, `stalls at step 1`,
  `dry-run CLI workflow`: no hits. Every future `run-tests` step that hits this same red
  before todo `3c6a5aa7` is fixed will re-pay a similar diagnostic cost from scratch.

## Code actually involved

- `packages/cezar/src/workflows/types.ts:755-804` — the `run-tests` step definition: prompt
  text, `model: SPEC_TO_DEPLOY_STEP_MODEL` (now `'sonnet'`), `bashAllowlist` (shared by
  reference with `implement`/`AUTONOMOUS_IMPLEMENTATION_WORKFLOW`). The prompt already has
  an execution/tool-batching discipline block (lines 772-804); it has **no** clause bounding
  diagnostic depth once a failure is confirmed pre-existing and out of scope. Line 770-771
  ("If any fail, FIX the code and re-run until they pass") has no carve-out for "confirmed
  not mine to fix."
- `AGENTS.md` — the traps/validation section (~lines 200-430) that already makes some reds
  cheap to recognize; candidate location to add the broker-stall trap.
- Todo `3c6a5aa7-9492-40ff-902b-c2db042dd9e5` (filed by this very run, high priority) — the
  actual defect the diagnosis found: the run broker stalls a one-shot `cezar run` at its
  first agent step under `CEZ_DRY_RUN`, so `npm run test:package` is red until it's fixed.
  Not this task's job to fix, but the next spec should reference it rather than re-describe
  it.
- The run's raw evidence, for whoever writes the spec: `/var/lib/cezar/loki-labs/cezar/.ai/cezar/runs/70f19253-cf6b-407c-92e0-96a8020a8ebb.ndjson`
  (full event log) and the `.claude/projects/.../8188f5a4-*.jsonl` session transcript for
  message-level detail if needed.

## What I could NOT find / verify

- Todo `c78140a8` (the "2,152 failures" baseline) could not be directly inspected — `cezar
  todo list` requires a registered `--project <id|path>` and `.` isn't one; `cez kb search`
  has no exact-id lookup and returned no lexical match for the id string. Its existence and
  priority are taken from the task description as given; its content is not verified here.
  It doesn't matter for this brief's conclusion (measured `npm test` output has only 2
  failures, not 2,152), but the next step should resolve the project id if it wants to read
  it directly.
- No evidence either way on whether cezar's Claude runner exposes a configurable
  thinking/reasoning-effort budget per step (distinct from `model`) that could bound the
  invisible ~76% directly rather than through prompt wording — worth a quick check before
  the spec commits to a prompt-only fix.
- No second comparable `run-tests` execution (post `a5f04b0f`, on sonnet) was found to
  measure against — needed for acceptance criterion 4.

## Open questions for the spec

1. Does `run-tests` get an explicit "confirmed pre-existing and unrelated → report + file a
   todo with what you already have, stop investigating" ceiling, and if so, how many probes
   is "confirmed" (this run's step 2 — reproducing at clean-HEAD `dist` — already was
   sufficient proof; steps 3-4 were additional root-causing, not fault attribution)? That
   trades away some real bug-discovery value for token cost — is that the right trade
   specifically for this step, given `commit-push`/`deploy` already gate independently on
   `verify` post-conditions (`.ai/specs/2026-08-20-steps-green-only-when-verified.md`)?
2. Given ~76% of the spend is invisible reasoning tokens, is a reasoning-effort/thinking-
   budget knob available and more direct than prompt wording?
3. Should AGENTS.md gain a trap entry for the broker-stall `test:package` failure now
   (mirroring C18/`add-project-dialog`), independent of the prompt-discipline question? This
   looks cheap and directly reduces future `run-tests` cost regardless of how question 1 is
   resolved.
4. The verification run for "output tokens < 20,000, no real failure silently passes" must
   be taken fresh, post-`a5f04b0f`, on sonnet — not compared against this opus-era 43,583
   figure.

## Four facts that most constrain the design

1. **43,583 output tokens is confirmed from the run log** (`usage.updated`, seq 1875) — not
   secondhand — and only ~24% of it is visible text/tool-call content; ~76% is invisible
   (almost certainly extended thinking), so a "stop narrating" prompt fix addresses at most
   a quarter of the problem.
2. **The dominant driver is deep, correct, but out-of-scope root-causing of a confirmed
   pre-existing, unrelated bug** (5 probes past the point where "not my fault" was already
   proven) — not re-litigating a documented red (that part was cheap) and not padding.
3. **This run's `run-tests` executed on opus**, 82 minutes before the per-step model policy
   (`a5f04b0f`, run-tests→sonnet) landed. It is not a valid "before" baseline for a post-fix
   comparison; a fresh post-policy measurement is required.
4. **`npm test`'s red in this run was 2 documented failures, not the 2,152-failure baseline**
   — condition (a) from the acceptance criteria does not apply; this task stays independent
   of todo `c78140a8`.
