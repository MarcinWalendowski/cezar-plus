# A run's cost cannot be attributed — measure the thinking/text/tool-args split instead of guessing it

**Status:** DRAFT, revision 8 — written against brief
`.ai/specs/briefs/2026-08-22-output-token-attribution-revision4.md` (itself written against the
original `.ai/specs/briefs/2026-08-21-output-token-attribution.md`); revised after a seventh review
independently re-verified every revision-7 citation (all exact) and independently reproduced every
revision-7 headline number a third time, at `TokenBreakdown`'s own per-`stepId` granularity
(reproduced exactly — see "Revision note (r7→r8)" below), confirming D1 through N3, N4/N5's
run-wide pooling, and N6/N7/N8 all correctly and completely fixed (none reopened), but found one
new, narrow defect: Phase 4 and Verification §4 specified the criterion-3 tolerance/stability test
as running against a real archived transcript (`70f19253`) that is unavailable in a fresh checkout
or in CI — `.ai/cezar/runs/` is gitignored and the Claude Code transcript lives outside the repo on
a retention window this spec does not control — making that test "eyeballed once" with extra
steps, the exact failure criterion 3 exists to prevent. Revisions 1-7 are preserved in the review
transcripts only; this file is the current draft.
**Date:** 2026-08-21. **Origin:** task *"A run's cost cannot be attributed - the log records total
output tokens but never thinking vs tool-args vs text"* — todo `3d6c0e66-792f-459c-8242-066185c0b28d`
(`cezar todo list --project cezar --json`) — filed alongside three sibling tasks after measuring
run `70f19253-cf6b-407c-92e0-96a8020a8ebb` (`spec-to-deploy`, 2026-08-21, 85 min wall, 11 turns / 8
steps).

**Revision note (r1→r2).** Revision 1's TLDR argued, from "zero reasoning items on disk" + "no
thinking flag in `buildClaudeArgs`", that the handoff's 55–60% "thinking" figure was very likely a
chars÷4 under-count of ordinary text/tool-args, not real thinking. That argument is refuted by data
sitting on this box: Claude Code's own session transcripts for `70f19253`
(`~/.claude/projects/-var-lib-cezar-…-worktrees-70f19253-…/*.jsonl`) show **224 of 272 API
responses (82%) carry a `thinking` content block** — every one of them with `thinking: ""` and a
populated `signature`. Zero reasoning items on disk is a consequence of the blank-text filter this
spec itself documents below (`claude-ui-mapper.ts:192`), not evidence thinking didn't happen: the
mapper only mints a `reasoning` item for *non-blank* `thinking` text, and Claude withholds that
text while still emitting (and billing) the block. Revision 2 corrected the TLDR, Problem, and
Solution accordingly — the finding is "thinking is on, is the majority of API responses, its text
is permanently withheld, and it is corroborated (not refuted) as the largest output-token
category" — and reworked Phase 2's reconciliation math, which revision 1 built around a formula
(`thinkingTokens = tokenize(reasoning item.text)`) that is now known to always evaluate to 0.

**Revision note (r2→r3).** A second review independently re-measured every load-bearing number in
revision 2 from the run's NDJSON and transcripts — all reproduced exactly (375,001 tokens /
$38.33 / 11 turns / 8 step ids; 628 transcript records / 272 unique `message.id` / block-count
histogram `{1: 628}`; 940,963 naive vs 375,001 deduped = 2.51×; 224/272 thinking-bearing, all blank;
2.126 chars/token; 490,974 total chars; 38.4%/62.6% residual split) — so none of revision 2's
empirical claims changed. Three things did:

1. **(Blocking.)** `toolArgTokens`/`narrationTokens` were defined over "every `item.completed`",
   with no distinction between a tool call the main agent made and one a dispatched sub-agent made
   inside its own context window. **93 of 360 tool `item.completed` events on `70f19253` carry
   `parentItemId`** (a sub-agent call) — and `turn.completed.usage.output`, the ground truth this
   spec reconciles against, **only ever bills the main agent's own responses** (the joined
   transcript contains exactly 267 `tool_use` blocks, precisely the 267 non-child items; deduped
   transcript `usage.output_tokens` sums to 375,001, matching the NDJSON exactly). Revision 2's
   definitions would have pulled the 93 child items' ~10k tokens into `measuredTokens` while
   `reportedTokens`/`withheldThinkingTokens` never counted them — corrupting the reconciliation
   identity Verification §5 claims "holds by construction," and doing so via the *exact* bug class
   `stats.ts:21-38` already documents twice ("billed a child's tool calls to the parent"), which
   this spec itself cited as precedent without applying the lesson. Fixed throughout below by
   filtering to non-child items using `stats.ts`'s existing `ItemIndex.childIds` mechanism, and by
   stating plainly that `reportedTokens` is main-agent-only, with child tool-call tokens reported
   as their own explicit, explicitly-unbilled line rather than silently dropped.
2. **(Blocking.)** The API contracts section named a parity mechanism (`api-types.test.ts`'s
   "existing `UiToolItem` pattern") that doesn't exist for this event, and the wrong file for the
   mirror. Corrected below with the real target and the real test's actual scope.
3. **(Should-fix.)** The TOLERANCE prediction ("single-digit-to-low-teens") is contradicted by the
   spec's own 2.126 chars/token calibration figure, which is far denser than any real BPE tokenizer
   produces on this content — the real figure is more likely 25–35%. Phase 4 now carries an
   explicit branch for that outcome.

Revision 2's own text is otherwise left as reviewed; edits below are scoped to these three points
plus the nits the same review flagged (transcript path, one mis-cited line, the Phase 3
independence claim).

**Revision note (r3→r4).** A third review independently re-measured every load-bearing number in
revision 3 from the run's own NDJSON and transcripts — all reproduced exactly (375,001 tokens /
$38.33 / 11 turns / 8 step ids; 360 tool `item.completed` / 93 child / 3 no-input; 137 message
items / 0 child; 628 records / 272 unique `message.id` / histogram `{1: 628}`; 267 `tool_use`
blocks == 267 non-child items; deduped transcript sum == NDJSON sum to the token; 0 sidechain
records; 224 bearing / 48 free) — the revision-3 mechanism (transcript join, `message.id` dedupe,
child-item filtering for tool-args, `ItemIndex.childIds` reuse) is sound and unchanged by this
revision. Five things were not:

1. **(Blocking.)** Revision 3's headline premise — *"thinking is not measurable at the text level,
   ever, for claude"* (§Solution, repeated in TLDR/Problem) — **is false**. It was built entirely
   from `70f19253`'s own transcripts, which happen to run only `claude-opus-5`/`claude-sonnet-5`
   (per the run's per-step model policy, `a5f04b0f`). Measured across all 476 thinking-bearing
   Claude Code session transcripts on this box (all Claude Code 2.1.233, model the only variable):
   `claude-opus-5` (4,309 blocks), `claude-opus-4-8` (804), `claude-sonnet-5` (379) are **all
   blank**; `claude-haiku-4-5` (285 blocks, 60 distinct files) is **all non-blank** (spot-checked
   again this revision: five haiku transcripts under `~/.claude/projects/` show real
   non-blank `thinking` text; a sampled `opus-5` transcript shows the documented blank shape).
   Blank thinking is **model-specific to the Claude 5/4.8 family, not an Anthropic-wide
   withholding policy** — and `haiku` is a shipped cezar model preset
   (`core/model-presets.ts:32,36`), so a step routed to it (a real, reachable configuration, not a
   hypothetical) has genuinely measurable thinking text today, which revision 3's design would have
   silently discarded as "unmeasurable by design." Fixed throughout below: the false claim is
   corrected in place everywhere it appeared (TLDR, Problem §3, Solution §2, R5); `thinkingTokens`
   is restored as a real MEASURED field (Σ tokenize of non-child, non-blank `reasoning`
   `item.completed` text — this is exactly the formula revision 2 killed as "always evaluates to 0
   for claude", which is true only for the two models `70f19253` happened to use); calibrated
   mode's `bearingChars` now includes recorded (visible) thinking length, so
   `withheldThinkingTokens` correctly collapses toward zero on a step where thinking was actually
   visible rather than double-counting it as both measured and withheld; and `ClaudeBlockCounts`'s
   single `thinking` counter is split into `thinking` (non-blank/visible) and `thinkingWithheld`
   (blank) — a merged counter cannot distinguish the two regimes this fix depends on telling apart.
2. **(Blocking.)** Phase 1's `blockCounts` tally, as revision 3 specified it, runs inside
   `mapAssistant` for **every** assistant frame passed to it — including sub-agent
   (`parent_tool_use_id`) frames (confirmed this revision: `mapAssistant`,
   `claude-ui-mapper.ts:161-163`, derives `parentItemId` from `msg.parent_tool_use_id` with no
   branch that skips tallying for a non-`undefined` value; this is the same function, and the same
   frames, that produce the 93 child tool items `stats.ts` already has to filter out). Left
   unfixed, `turn.completed.blockCounts` would count sub-agent blocks alongside a
   `turn.completed.usage.output` that never bills them — the *exact* child-attribution bug
   `stats.ts:21-38` documents twice, which revision 3 caught and fixed for Phase 2's tool-arg
   accounting (Problem §4, `ItemIndex.childIds`) but left live in Phase 1. Fixed below: `blockCounts`
   tallies main-agent frames only (`parent_tool_use_id` absent); child frames' blocks are tallied
   into a new, separately-reported `childBlockCounts` field instead of being silently dropped — the
   same "never merge, never drop, report as its own explicitly-unbilled line" rule this spec already
   applies to `childToolArgTokens`.
3. **(Should-fix.)** `computeRunStats` is pure and synchronous (`stats.ts:470`); every filesystem
   read lives in the async `readRunStats` (`stats.ts:655`) — confirmed unchanged this revision. The
   architecture as drawn put the transcript join *inside* `computeRunStats`, which cannot read a
   file without becoming async/impure, and left Verification §3's synthetic-transcript fixture with
   no way to inject one. Fixed below: `readRunStats` globs and loads the transcript(s), then passes
   them into `computeRunStats(runId, events, transcripts?)` — the seam is named explicitly rather
   than left implicit.
4. **(Should-fix.)** `stats-cli.ts`'s module doc (confirmed still present verbatim this revision:
   *"Filesystem-only: it reads `<repo>/.ai/cezar/runs/<runId>.ndjson` and nothing else"*,
   `stats-cli.ts:11`) becomes false the moment calibrated mode reads
   `~/.claude/projects/*/<sessionId>.jsonl`. Fixed in place below, per `CLAUDE.md`'s
   correction-in-place rule — not left standing next to a design that contradicts it. Also fixed:
   `sessionId` (pulled out of the run's own NDJSON to build a filesystem glob) gets the same
   character-class guard `validRunId` already applies to the `runId` argument
   (`stats-cli.ts:56-62`) before it touches a path.
5. **(Nit.)** Data models' implementation rule 2, as revision 3 phrased it, told every consumer to
   exclude a `parentItemId` item "reusing `ItemIndex.childIds`" — true for `toolArgTokens` (tool
   items, which `indexToolItems` does key by id) but not implementable for `narrationTokens`:
   `toolItemOf` (`stats.ts:316-322`) returns `undefined` for anything with `kind !== 'tool'`, so a
   message item is never added to `childIds` no matter whose child it is (confirmed this revision:
   0 of 137 message items on `70f19253` carried a `parentItemId`, so this was latent, not live, but
   the rule as written was false the moment a run has a sub-agent narrate). Fixed below: narration
   filtering reads `item.parentItemId` on the message item directly; only the tool-item filter
   reuses `childIds`.

None of these five reopen the transcript-join mechanism, the `message.id` dedupe rule, or the
decision to exclude child tool items from `reportedTokens` — those are revision 3's contribution
and stand. Edits below are scoped to the five points above.

**Revision note (r4→r5).** A fourth review independently re-verified every citation in revision 4
against the live code (all exact) and independently reproduced D1's headline claim across all
13,064 Claude Code session transcripts on this box, not a sample (`claude-opus-5` 4,453 blocks /
`claude-sonnet-5` 979 / `claude-opus-4-8` 804 — all blank; `claude-haiku-4-5` 285 blocks across 283
files — all non-blank) — confirming blank thinking is model-specific, not an Anthropic-wide policy,
exactly as D1 established. D1 through D5 are correctly and completely fixed and none are reopened by
this revision. Three new defects, all narrow, local edits to an otherwise-sound design:

1. **(Blocking — hits acceptance criterion 3 directly.)** Verification §5 asserted a single
   reconciliation identity "holds by construction" across both modes. True in basic mode
   (`unclassifiedGapTokens` is *defined* as the residual). **False in calibrated mode:**
   `measuredTokens` is a real BPE tokenization of NDJSON `item.completed` text, while
   `withheldThinkingTokens` is a chars-ratio inference over transcript text
   (`bearingTokens − bearingChars/calibrationRatio`) — two independent estimators of different
   evidence, with their sum having no algebraic reason to equal `reportedTokens`. Compounding this,
   `gapTokens`/`gapPct` were named in Solution's basic-mode paragraph and in Verification §5 but
   never declared as `TokenBreakdown` fields — only `unclassifiedGapTokens` and `freeGapPct` were.
   Fixed below: a new `calibratedResidual` field is declared explicitly (signed, calibrated-mode
   only, reported not asserted-small), Solution's basic-mode paragraph now names the real field
   (`unclassifiedGapTokens`) instead of the phantom `gapTokens`/`gapPct`, and Verification §5 states
   the identity separately per mode instead of one blanket claim.
2. **(Blocking — contradicts the spec's own stated convention.)** `opaqueBlocks` was declared a
   non-optional `number`, but it sums `blockCounts.{redactedThinking,serverToolUse,other}`, which
   only exists on a turn recorded after Phase 1 ships. On every already-archived run — including
   `70f19253`, this spec's own baseline — no turn carries `blockCounts`, so `opaqueBlocks` would
   read a fake `0`, contradicting the "undefined, never a fake 0" rule this spec states repeatedly
   for every other field in this exact situation. R6 already gestured at a `blockCountsAvailable`
   flag the data model never declared. Fixed below: `opaqueBlocks` is now optional, `undefined` when
   no turn in the step carried `blockCounts`; R6, Phase 3's printer rule, and Verification §5/§3 are
   updated to match, and the phantom `blockCountsAvailable` name is removed rather than left
   dangling.
3. **(Blocking — live, and defeats D2's own fix.)** `mapAssistant`'s `events.length === 0` early
   return (`claude-ui-mapper.ts:247-251`) returns the OLD `state`, carrying forward only
   `lastMainAgentPromptTokens` — discarding any other local accumulator computed in that call,
   including the block-tally counters Phase 1 adds. This is not theoretical: `mainAgentPromptTokens`
   (`:264`) already returns `undefined` for any `parent_tool_use_id` frame, so a sub-agent frame gets
   no `context.updated` push either — meaning every sub-agent frame whose only block is a blank
   `thinking` (the common opus/sonnet shape this spec's own TLDR measures at 82% of responses) hits
   this branch and would silently lose its `childBlockCounts` increment, undermining D2's own child/
   parent split in exactly the categories Phase 1 exists to count. Verification §2's D2 test case
   would not have caught this, because its frames also carry a `tool_use` block that keeps `events`
   non-empty. Fixed below: Phase 1's implementation must thread the tally accumulator through the
   early-return branch (Implementation-critical rules #4), and Verification §2 gains a case built
   specifically to hit this path.

None of these three reopen the transcript join, the `message.id` dedupe rule, the child-item
filtering split (D5), the restored measured `thinkingTokens` (D1), the `computeRunStats(runId,
events, transcripts?)` seam (D3), or the `stats-cli.ts` doc/`sessionId` guard fix (D4) — those stand
as revision 4 left them. Edits below are scoped to the three points above.

**Revision note (r5→r6).** A fifth review independently re-verified every revision-5 citation
against the live code (all exact) and independently re-derived this spec's own headline numbers
from `70f19253`'s NDJSON and joined transcripts, reproducing them exactly (48 free / 224 bearing
responses; run-wide ratio 80,295/37,773 = 2.126). It also computed the same split PER STEP, using
this spec's own (revision-5) formula, and found two new defects, both narrow:

1. **(Blocking — the exact "line item nobody should optimise against" this task exists to remove,
   reintroduced by the estimator itself.)** `calibrationRatio`, as revision 5 defined it, is
   computed **per step** (`# over the step's turns` in the formula block). On `70f19253` itself,
   **(corrected below, "Revision note (r6→r7)": this was measured per session/turn, not per step —
   the real per-step figure is n=4, ratio 2.144, withheld 20,832 vs run-wide 20,242)** the `spec`
   step's calibration set is **n=1** (one free response, 364 tokens), giving a step-local
   ratio of 1.566 against the run-wide 2.126 — its `withheldThinkingTokens` comes out **45** instead
   of **10,634** (0.1% withheld thinking where the run-wide ratio says 26%, on 40,255 bearing
   tokens). **(Also corrected below: the true count is 7 of 11, not 8.)** 8 of the run's 11
   turn-groups have n ≤ 4 free responses, so a thin calibration set is
   the common case at this run's shape, not a corner case. Worse, nothing guarded
   `freeResponses === 0`: a step whose every response carries a thinking block gives
   `calibrationRatio = 0/0 = NaN`, which propagates into `withheldThinkingTokens`,
   `calibratedResidual`, the printed line, and would fail Verification §5's per-mode identity
   assertion for a reason the spec never anticipated. Fixed below: `calibrationRatio` is now a
   single **run-wide** quantity — pooled free responses across every step's turns in the run,
   computed once — applied uniformly to every step's `withheldThinkingTokens`. This needs no new
   architecture: `computeRunStats` already operates over the whole run (D3), so the pool is built
   once, before the per-step loop, not inside it. Each step's `calibration` diagnostic still reports
   that step's own local n/chars/tokens/ratio (useful for spotting a thin-sample step like `spec`
   above) plus a new `appliedRatio` field naming the run-wide ratio actually used. If the run itself
   has zero free responses anywhere (every response in every step carries thinking — a real, if
   rare, all-thinking-bearing run), `calibrationRatio` cannot be computed at all: every step in that
   run reports `mode: 'basic'` (never `'calibrated'`, never `NaN`) and
   `withheldThinkingTokens`/`calibration` are `undefined` throughout — the same "undefined, never a
   fake number" convention this spec already applies to `opaqueBlocks` (N2) and
   `unclassifiedGapTokens`.
2. **(Should-fix, same class as N1/N2.)** `RunStats.totals` is typed `Omit<StepStats, 'stepId' /
   'restarts'>` (`stats.ts:278`), so adding `tokenBreakdown?: TokenBreakdown` to `StepStats` forces
   `totals.tokenBreakdown` to be a full `TokenBreakdown`, not a bag of summed scalars — and the Data
   models comment already said totals reports "the sum plus the count of steps excluded" for
   `opaqueBlocks`/`withheldThinkingTokens`/`calibratedResidual` without ever declaring where that
   count lives, the third instance of exactly the "named but never declared" defect N1/N2 already
   caught once each. Fixed below: `stepsWithoutBlockCounts`/`stepsNotCalibrated` are declared as
   real optional `TokenBreakdown` fields, undefined on every per-step breakdown by construction and
   populated only on `RunStats.totals.tokenBreakdown`; and `mode`/`freeGapPct`/`calibration`'s
   meaning on a mixed-mode run's totals is stated explicitly rather than left to guesswork.

Neither defect reopens the transcript join, the `message.id` dedupe rule, the child-item filtering
split (D5), the restored measured `thinkingTokens` (D1), the `computeRunStats(runId, events,
transcripts?)` seam (D3), the `stats-cli.ts` doc/`sessionId` guard fix (D4), or N1/N2/N3's fixes —
those stand as revision 5 left them. `freeGapPct`/Phase 4's tolerance test are unaffected: that
figure was already computed run-wide (the TLDR's own n=48 total was always pooled across the whole
run, never per step). Edits below are scoped to the two points above.

**Revision note (r6→r7).** A sixth review re-verified every revision-6 citation against live code
(all exact) and independently re-derived this spec's own run-wide headline numbers a second time
from `70f19253`'s NDJSON and joined transcripts (reproduced exactly: free n=48 / 80,295 chars /
37,773 tok / ratio 2.1257; bearing n=224 / 337,228 tok; total 375,001; 0 non-blank thinking blocks;
0 sidechain records), confirming D1-D5 and N1/N2/N3 correctly and completely fixed, and confirming
the decision to pool `calibrationRatio` run-wide (N4) is itself right. It found three new, narrow
defects, none of which reopen that pooling decision:

1. **(Blocking — N4's own justifying measurement was taken at the wrong granularity.)** The "`spec`
   step: n=1, 364-token free response, ratio 1.566, withheld 45 instead of 10,634" figures revision
   6 cited to justify pooling reproduce exactly, but only **per session/turn** (session `9f2f6bb7`,
   the `spec` step's first of two turns — that step restarted once). `TokenBreakdown` is keyed per
   `stepId`, not per turn (`stats.ts:596` sets one `restarts` bucket per step id, pooling every turn
   a step ran across), and revision 5's own formula already said "over the step's turns" — so the
   `spec` step's real calibration set is **n=4**, local ratio **2.144**, `withheldThinkingTokens`
   **20,832** against the run-wide **20,242** — a **2.9%** difference, not a 99.6% one. Measured the
   same way across all 8 of `70f19253`'s steps, every local ratio sits in **2.03–2.28** against the
   run-wide 2.126, the smallest calibration set is **n=2** (not n=1), and the largest swing is
   **9.2%** (`context`: withheld 3,962 locally vs 3,629 run-wide) — the catastrophic per-turn figure
   cannot occur at the granularity this design actually computes at. "8 of the run's 11 turn-groups
   have n ≤ 4" is also corrected to 7 of 11 (8 have n ≤ 5). Fixed below: the pooling decision (N4)
   itself is unchanged — restated with the real per-step numbers, and justified on grounds that hold
   regardless of any single step's measured swing (Solution, Implementation-critical rule #5, R17,
   and the `withheldThinkingTokens`/`calibration` doc comments).
2. **(Blocking, narrow.)** `calibration.ratio` is a required `number` documented as THIS STEP's own
   local figure, but N4's `freeTokens === 0` guard only covers the RUN-WIDE pool — a calibrated step
   whose every response of its own carries thinking has `freeResponseCount === 0`, giving
   `ratio = 0/0 = NaN`, printed. Not live on `70f19253` itself (its thinnest step still has n=2), but
   reachable: per-session n already ranges 1–10 on this same run, and a step is not guaranteed a free
   response of its own. Fixed below: `calibration.ratio` is now `ratio?: number`, undefined exactly
   when this step's own `freeTokens === 0`; Phase 3 prints nothing for that step's ratio line, never
   `NaN`; Verification §3 gains a fixture for a step with a zero local free-response count inside a
   run whose pool (drawn from other steps) is non-empty.
3. **(Blocking, narrow.)** `'unavailable'` mode was the one place this spec's own "undefined, never
   a fake 0" convention was not applied: `reportedTokens`/`narrationTokens`/`toolArgTokens`/
   `childToolArgTokens`/`thinkingTokens`/`measuredTokens` were all declared as required `number`, so
   an `'unavailable'` `TokenBreakdown` was a zero-filled object in every field but `mode` — the exact
   defect this convention exists to rule out, and Phase 3's printer had no `'unavailable'` branch, so
   such a step would print narration 0 / tool-args 0 / thinking 0 beside a real `reportedTokens`,
   reading as "wrote no text, called no tools." R7, the risk row that motivated `'unavailable'` mode,
   was also factually wrong about when it applies: `codex-ui-mapper.ts`, `opencode-ui-mapper.ts`, and
   `pi-ui-mapper.ts` all emit `turn.completed` (`:240`/`:593`/`:223`) **and** `item.completed`
   including `kind: 'reasoning'` (`codex:616,776`/`opencode:297`/`pi:145`) — a non-claude step has a
   full v2 item stream and is fully measurable in basic mode; only `blockCounts` (claude-only) is
   absent for it, and that alone does not force `'unavailable'`. Fixed below: `reportedTokens` stays
   required (it comes from `turn.completed.usage`, guaranteed to exist whenever `tokenBreakdown`
   itself does — see `StepStats.tokenBreakdown`'s own doc); the other five fields become optional,
   undefined only in `'unavailable'` mode; `'unavailable'` is redefined as "no `item.*` events and no
   transcript for this step" — not a backend check — and R7's risk/mitigation text is corrected in
   place.

None of these three reopen the transcript join, the `message.id` dedupe rule, the child-item
filtering split (D5), the restored measured `thinkingTokens` (D1), the `computeRunStats(runId,
events, transcripts?)` seam (D3), the `stats-cli.ts` doc/`sessionId` guard fix (D4), N1/N2/N3's
fixes, or N4/N5's run-wide pooling and totals fields — those all stand as revision 6 left them.
Edits below are scoped to the three points above.

**Revision note (r7→r8).** A seventh review re-verified every revision-7 citation against live
code (all exact) and independently reproduced every revision-7 headline number a third time, this
time at `TokenBreakdown`'s own per-`stepId` granularity (`stats.ts:596`): run-wide free n=48 /
80,295 chars / 37,773 tok / ratio 2.1257 / total 375,001; the `spec` step's own calibration set
n=4, local ratio 2.144, `withheldThinkingTokens` 20,832 against the run-wide 20,242 (+2.9%); every
step's local ratio in 2.034–2.276 against 2.126; smallest set n=2 (`context`), largest swing 9.2%
(`context`, 3,962 vs 3,629); 0 non-blank thinking blocks, 0 sidechain records — confirming D1-D5,
N1-N5, and N6/N7/N8 are all correctly and completely fixed; none are reopened. It found one new,
narrow defect:

1. **(Blocking — the criterion-3 tolerance test has no CI-runnable target.)** Phase 4 specified
   the assertion as `freeGapPct` "computed against a fixed, archived run (`70f19253`)", and
   Verification §4 as "computed against real archived transcripts." Neither input exists in a
   fresh checkout: `.ai/cezar/runs/` is gitignored (`.gitignore:11`); the Claude Code transcript
   lives under `~/.claude/projects/`, outside the repo, on a retention window this spec's own
   Architecture section already says cezar does not control; no test in the repo reads that path;
   and CI runs `npm run test:unit` (`.github/workflows/ci.yml:48`) and `npm test` (`:51`) on a
   clean runner. A test built this way passes only on this box and rots the moment Claude Code
   prunes the transcript — "eyeballed once" with extra steps, the exact failure criterion 3 exists
   to prevent. Compounding it, the repo's existing run-fixture convention cannot be reused as-is:
   `src/core/__fixtures__/runs/ec6e8e06-trimmed.ndjson` (`stats.test.ts:10-24`) is trimmed to v1
   `tool-call`/`tool-result` events with `input`/`result` payloads stripped — no v2 `item.*` events,
   and no payload text, which is the one thing `freeGapPct` must tokenize. Fixed below: Phase 4
   splits into a one-time derivation against real archived transcripts (unchanged in substance —
   still what picks `TOLERANCE` and the tight-vs-wide branch, its numbers recorded in the status
   log per Verification §7/§8, exactly like the 39–63% thinking-share figure already is) and a
   separately committed, CI-safe test that runs against a new, hand-authored synthetic NDJSON +
   transcript fixture pair — payloads retained, v2 `item.*` events included, an explicit inversion
   of the `ec6e8e06` convention stated as such in the fixture's own doc comment — built to reflect
   `70f19253`'s own real tool-arg/narration proportions. Verification §4 and §8's closing clause
   are updated to match.

None of this reopens the transcript join, the `message.id` dedupe rule, the child-item filtering
split (D5), the restored measured `thinkingTokens` (D1), the `computeRunStats(runId, events,
transcripts?)` seam (D3), the `stats-cli.ts` doc/`sessionId` guard fix (D4), N1-N8's fixes, or the
run-wide `calibrationRatio` pooling — those all stand as revision 7 left them. Edits below are
scoped to the one point above, plus three citation off-by-ones (`indexToolItems` is
`stats.ts:341`, not `325-338`; `stats-cli.ts`'s module doc is `:11`, not `:10`; the api-client
mirror is `172-178`, not `172-179`) and a one-clause tightening of `'unavailable'` mode so a step
with a transcript but no `item.*` events (effectively unreachable, since `session.started`, the
join key, is itself a v2 event) is not left with an undefined mode.

## TLDR

`turn.completed.usage.output` (`packages/cezar/src/core/claude-ui-mapper.ts:576`,
`rawTokenUsage` at `:626-639`) is one number per turn — the API's raw `output_tokens` for that
turn, already correctly summed across every internal API round trip inside it (`msg.usage` on the
final `result` frame is the CLI's own cross-call total; confirmed no double-counting risk there —
see Architecture). Nothing downstream knows what those tokens *were*.

**Claude's extended thinking is on, and whether its text is visible is MODEL-SPECIFIC, not an
Anthropic-wide policy — that is the central, measured finding this spec is built around, and
revision 3's stronger claim ("invisible by design", full stop) is corrected in place this
revision.** From `70f19253`'s own Claude Code session transcripts (11 files, one per turn, joined
deterministically by `sessionId` — see Architecture):

- **224 of 272 unique API responses (82%) carry a `thinking` content block.** All 224 have
  `thinking: ""` (blank) with a large `signature` field — Anthropic's documented shape for
  redacted/withheld thinking text that is still real, billed output. `70f19253` ran
  `claude-opus-5`/`claude-sonnet-5` (this workflow's per-step model policy, `a5f04b0f`) — **and the
  blank shape is a property of those two models, not of claude in general.** Measured this
  revision across every thinking-bearing Claude Code session transcript on this box (all Claude
  Code 2.1.233, model the only variable):

  | Model | Thinking blocks measured | Text |
  | --- | --- | --- |
  | `claude-opus-5` | 4,309 | ALL blank |
  | `claude-opus-4-8` | 804 | ALL blank |
  | `claude-sonnet-5` | 379 | ALL blank |
  | `claude-haiku-4-5` | 285 (60 distinct files) | ALL non-blank (spot-checked: real reasoning text, ~1,755-char sample) |

  `haiku` is a shipped cezar model preset (`core/model-presets.ts:32,36`), reachable by any run's
  per-step model policy today — not a hypothetical edge case. A design that treats blank thinking
  as an Anthropic-wide law would silently discard genuinely measurable text the moment a step runs
  on that preset.
- Splitting those 272 `70f19253` responses by shape and comparing recorded chars (text +
  `tool_use.input` JSON, exactly what a tokenizer would see) against each response's own
  `usage.output_tokens` gives a **thinking-free calibration ratio of 2.13 chars/token** (n=48
  responses with no thinking block, 80,295 chars / 37,773 tokens — denser than a naive chars÷4
  guess, confirming the handoff's chars÷4 method under-counts, but only by ~1.9×, not by enough to
  explain the residual away). Applying that ratio to all 490,974 recorded chars across the run
  (**transcript-derived — the main agent's own responses only**, per this revision's D1 fix;
  Phase 2's basic mode instead tokenizes NDJSON `item.completed` chars, which is a larger figure
  until it too is filtered to exclude sub-agent items, at which point the two should converge —
  see Data models/Architecture) and subtracting from the true total (375,001 tokens, re-derived
  below) leaves a **39% residual**; a conventional general-purpose BPE ratio (3.5 chars/token)
  gives **63%**. **On this run's two models, thinking is 39–63% of output tokens — the handoff's
  55–60% estimate is corroborated, not refuted, on the models it happened to measure.**

So the task is not "the residual is probably a undercounting artifact, go measure text/tool-args
precisely and the gap will close" (revision 1's hypothesis), nor "thinking can never be measured
for claude, full stop" (revision 3's overcorrection). It is: **thinking is real and is the single
largest output-token category on the models `70f19253` ran; whether its text is visible depends on
which model produced it; and no tokenizer — however good — can measure a quantity that a given
model's response never put on the wire.** What *can* always be measured precisely, with a real
tokenizer, is assistant narration and tool-call arguments — and, on a model that emits visible
thinking, the thinking text itself. Where thinking is genuinely blank, the only honest move
remains reporting the withheld remainder as a labeled inference rather than folding it into a
false "thinking exact count" or a false "thinking is unmeasurable" absolute. That three-way
distinction (measured visible / measured thinking / inferred withheld) is the design this spec now
targets.

**The fix is three complementary pieces, two of them independently shippable, the third
essentially free:**

- **Phase 1 (wire, forward-only, no dependency):** count raw content-block types at the one place
  in the codebase that still sees them before they're mapped or discarded
  (`mapAssistant`, `claude-ui-mapper.ts:161-247`), and carry the counts on `turn.completed`. This
  was already correctly designed in revision 1 to count *both* blank and non-blank `thinking`
  blocks (see Data models) — which turns out to be exactly the mechanism that would have caught
  this run's real shape, and is promoted here from a footnote to the headline durable signal:
  every future run gets a permanent, tokenizer-free answer to "did thinking happen, and was it
  visible or withheld." **Fixed this revision (D2):** the tally now runs over main-agent frames
  only — a sub-agent's blocks land in a separate `childBlockCounts`, never merged into the parent
  step's count, the same rule this spec already applies to tool-call tokens.
- **Phase 2 (retroactive, on any run whose transcript or NDJSON is still on disk):** tokenize the
  text/JSON that `item.completed` events already persist in full (`ui-event-sink.ts:99-104`) with
  a real BPE tokenizer for the visible categories — narration, tool-args, **and, restored this
  revision (D1), non-blank reasoning text** — and, where the Claude Code session transcript is
  still present, classify individual API responses as thinking-bearing (blank thinking present) or
  thinking-free (joined by `sessionId`, deduped by `message.id`; see Architecture) to calibrate and
  report the genuinely withheld category honestly, never as a tautological fourth bucket and never
  conflated with the visible-thinking case that's now measured directly.
- **Phase 3/4 (as before):** `cez run stats` prints the breakdown; a reconciliation test asserts a
  real, falsifiable tolerance — now scoped to the thinking-free subset, where reconciliation is a
  meaningful claim rather than a wide bound that absorbs the whole phenomenon (see Solution).

Both plug into `packages/cezar/src/runs/stats.ts`, the existing tool-economy meter, which today
reads **no usage field at all** (module doc, `stats.ts:6-19`; confirmed — `computeRunStats` never
touches `turn.completed`, `usage.updated`, or a message/reasoning `item.completed`).

## Problem

Three problems, in order of how directly the acceptance criteria name them:

1. **No breakdown exists.** `cez run stats` is thorough about round trips (batch factor,
   model-vs-exec time, sleep/poll detection) and blind to token composition. A step that gets
   slower or more expensive can be reported but never explained.
2. **The one estimate that exists doesn't reconcile with its own source.** Summing
   `turn.completed.usage.output` directly off `70f19253`'s NDJSON gives **375,001** tokens / **$38.33**
   across **11** turns over **8** step ids (`spec`, `review-spec`, `deploy` each restarted once) —
   not the handoff's "307,118 tokens" / "$32.53" / "9 completed steps". **A test asserting "output
   dropped 40%" needs a trustworthy baseline before it can assert anything**, and this spec's own
   Verification §8 closes that dispute now, with the actual re-derived numbers, rather than leaving
   it open until a future run (see Revision note and Verification).
3. **Thinking is real, large, and its measurability is model-specific — the design has to say so
   honestly instead of treating one run's two models as a law about claude in general.** 82% of
   `70f19253`'s API responses carry a `thinking` block, and on the two models that run used
   (`claude-opus-5`, `claude-sonnet-5`) Anthropic never reveals that text — so a local tokenizer
   applied to `70f19253` alone would produce a true `thinkingTokens` count of 0 for every one of
   its steps, and revision 1's formula (tokenize `item.completed` "reasoning" text) is not wrong on
   *this run's* transcripts. **It is wrong as a permanent, cross-model claim.** Measured this
   revision: `claude-haiku-4-5` — a shipped cezar preset any step's model policy can reach
   (`core/model-presets.ts:32,36`) — emits non-blank thinking text in all 285 sampled blocks across
   60 files. A design that hard-codes "thinking is unmeasurable, always" would silently discard
   that text the moment a step runs on it, the same mislabeling this problem statement is meant to
   rule out, just pointed the opposite direction from revision 1's mistake. The fix is a
   three-way split, not a single number: measure narration and tool-args precisely on every model;
   measure thinking precisely too, whenever a response's thinking text is non-blank; and only where
   thinking is genuinely blank, report its size as an inference, honestly labeled as such, sized
   against a calibration ratio derived from the same run's own thinking-free responses (see
   Solution).
4. **`turn.completed.blockCounts`, as revision 3 specified it, would count a sub-agent's blocks
   against the parent step.** `mapAssistant` (`claude-ui-mapper.ts:161-247`) runs identically for a
   main-agent frame and a sub-agent (`parent_tool_use_id`) frame — it is the same function that
   produces the 93 child tool items `stats.ts` already filters out of the round-trip meter. A
   per-block tally with no such filter would report, on the same `turn.completed` event as a
   main-agent-only `usage.output`, a `blockCounts.toolUse` that includes every dispatched
   sub-agent's tool calls too — the identical failure mode `stats.ts:21-38` documents twice, caught
   by revision 3 for tool-arg tokens (see problem #5 below) and left live in Phase 1. Fixed below:
   the tally excludes child frames, reporting their blocks under a separate `childBlockCounts`
   instead of dropping or merging them.
5. **`turn.completed.usage.output` bills the main agent only — a breakdown over "every tool call"
   would silently mix in tokens the ground truth never counted.** `70f19253` dispatched sub-agents
   3 times; 93 of its 360 tool `item.completed` events carry `parentItemId` (ran inside a
   sub-agent's own context window). The Claude Code session transcript this spec joins against
   (Architecture) contains exactly 267 `tool_use` blocks — precisely the 267 *non-child* items —
   and deduped transcript `usage.output_tokens` sums to 375,001, matching the NDJSON's
   `turn.completed.usage.output` sum to the token. So a child item's tool-call tokens are real
   spend, but they are **not** in `reportedTokens`, and a design that tokenizes every `item.completed`
   without filtering them out both inflates `measuredTokens` for a reason unrelated to narration or
   tool-args, and breaks the reconciliation identity Verification §5 depends on. This is the same
   failure mode `stats.ts:21-38` already documents twice under a different name ("billed a child's
   tool calls to the parent") — see Data models and Architecture for the fix (filter by
   `ItemIndex.childIds`, don't build a second mechanism).

### What the record already decided (citations)

| Decision | Where | Bearing here |
| --- | --- | --- |
| `computeRunStats` is filesystem-only, replay-only, computed on demand, **nothing persisted** | `stats.ts:6-19` | Sets the shape this change takes: new fields on `StepStats`/`RunStats`, no store/contract-parity change. |
| Two prior metering bugs in this exact module were caused by **assuming a wire spelling/attribution instead of measuring it** (`'Task'` vs `'Agent'`; billing a child's calls to the parent) | `stats.ts:21-38`, `.ai/specs/2026-08-21-sub-agent-fanout-adoption-and-attribution.md` | Direct precedent for this task's own risk class. Revision 3's review caught this design repeating the *exact same* "billed a child's calls to the parent" bug for tool-arg tokens (Problem #5) before it shipped, plus a fourth instance of the class (naively summing `usage.output_tokens` per raw transcript record over-counts 2.5×, see Architecture) — and revision 4's review caught a **fifth**, unfixed by revision 3: Phase 1's `blockCounts` tally (Problem #4) had the identical child-attribution defect, just in the one place revision 3's own "don't repeat this bug" citation didn't get applied. |
| `haiku` is a shipped, reachable model preset for the `claude` runner | `core/model-presets.ts:28-37` (`KNOWN_PRESETS_BY_RUNNER.claude`, includes `'haiku'` and `'claude-haiku-4-5'`) | Direct support for D1: a step routed to this preset is a real, already-supported configuration, not a hypothetical — so "thinking is unmeasurable for claude" cannot be scoped down to "usually true" without naming the model it's false for. |
| `TokenUsage.reasoning?: number` exists in the wire contract, typed, documented, **never populated** for claude | `ui-events.ts:105`; `claude-ui-mapper.ts:626-639` | The wire has literally nowhere to report a reasoning-only output count even if we wanted to populate it live — `result.usage.output_tokens` is one number covering every block type in the turn. A breakdown can only ever be a **replay-time reconstruction**, not a wire-reported figure (see Architecture). |
| `--include-partial-messages` is documented as the intended source of streamed deltas but is **not enabled** | `ui-events.ts:147` (the only mention of the flag anywhere in the repo); confirmed — zero occurrences in `buildClaudeArgs` (`claude-cli-runner.ts:691-724`) | The sibling todo (`37f3ebf1`) this task's handoff cites. Streaming deltas would let text/thinking be counted as they arrive, but does not by itself solve the "thinking text is never revealed at all" problem this spec is built around (partial-message deltas for a `thinking` block would themselves be blank, for the same withholding reason), so this spec does not depend on it. |
| Peak-context and other usage numbers are **per-window, never summed across steps** — a rule already burned once | `stats.ts:202-217`; commit `f65ccdde` | Caution for aggregation: sum where additive (raw output tokens, tool-arg tokens), never max-vs-sum confusion. |
| Output tokens, not round trips or tool execution, are what a step's wall clock is spent on | this task's handoff | The framing this task is justified by. **Correction, not confirmation:** the citation list in revision 1 named KB entry `notion-cc6ebabb2ab4` as "not contradicted by anything found here" — that entry's own title and headline claim are the *opposite* framing ("cezar production is not slower per round trip … the agent loop is round-trip bound", `notion-export/knowledge/notes/cezar-run-speed-is-round-trip-bound-not-box-bound--local.md`), with context size, not output-token count, as its stated latency mechanism. It is a competing explanation of the same symptom (slow steps), not supporting evidence, and per `CLAUDE.md`'s correction rule it needs a dated addendum in place, not a citation claiming agreement (see Phase 5d and Verification §7d). |

### What I could not find (re-checked this revision)

- No KB entry or spec anywhere proposes a token-category breakdown, a tokenizer choice, or a
  `usage.output` reconciliation test — `cez kb search`, `.ai/specs/`, and `git log` all confirm
  this, unchanged from revision 1.
- **Correction to revision 1's claim that criterion 4 "has no pre-existing target to correct":**
  it does. The brief this spec is written against, `.ai/specs/briefs/2026-08-21-output-token-attribution.md`,
  is itself indexed in the KB (`specs-2c2d02c67406`) and already carries a computed **65.6%
  residual** figure (brief, "residual accounted for, against 375,001 total") alongside the
  handoff's 55–60% claim — both now corroborated, not refuted, by this revision's transcript-based
  calibration (39–63%, bracketing both). There is nothing to correct *in the sense of overturning*;
  there is a claim to confirm in place, with the measured range, per Verification §7d/§8.
- **Correction, this revision: todo `37f3ebf1` DOES exist — it was a scoping miss, not a missing
  record.** Revisions 1-3 all claimed it "does not exist in any searchable form" because an
  unscoped `cezar todo list` returns empty; scoped to `--project cezar` it's real:
  `37f3ebf1-e4dc-4db5-80a4-772c02327073`, status todo, priority **high** (higher than this task),
  filed 2026-08-21T18:42:42Z: *"Stream assistant tokens to the cockpit — pass
  `--include-partial-messages` and map `stream_event` deltas to `item.delta`."* This corrects the
  earlier claim, not the design: the spec's own reasoning for why this task doesn't depend on it
  (partial-message deltas for a `thinking` block would themselves be blank on a withholding model,
  per the citation table above) already holds regardless of whether the todo could be found.
- Whether Claude Code CLI requests extended thinking by some default outside `buildClaudeArgs`
  (a model-tier default, a harness-level flag not visible in this repo's source) remains not
  settled by static reading alone. It no longer needs to be, for this task's purposes: Phase 1's
  `blockCounts` and this revision's own transcript read already settle the *empirical* question
  ("does it happen, how often") without needing the *mechanism* question answered.

## Solution

**"Measured from the stream" now means three different things for three different categories
(narration/tool-args always measured; thinking measured when visible, inferred when withheld), and
the design says so explicitly instead of blurring them into one number or one blanket rule:**

1. **Narration and tool-call arguments are genuinely measurable — but only the main agent's own,
   because that is all `reportedTokens` bills.** Their text/JSON is fully persisted
   (`item.completed`, `ui-event-sink.ts:99-104`) and a real tokenizer can count it precisely (not
   exactly matching Anthropic's internal count — no public tokenizer does — but real, deterministic,
   reproducible, per the precision boundary in Open Question 2 of the brief). `turn.completed.usage.output`
   — the ground truth this whole design reconciles against — covers only the main agent's own API
   responses; a dispatched sub-agent runs its own turns in its own context window, billed to *its*
   `turn.completed`, not the parent's (confirmed on `70f19253`: 93 of 360 tool `item.completed`
   events carry `parentItemId`, and the joined transcript's `tool_use` block count — 267 — matches
   the non-child item count exactly, not the full 360). So `narrationTokens`/`toolArgTokens` must
   exclude any item with a `parentItemId`. For `toolArgTokens` (tool items), reuse the same
   distinction `stats.ts` already computes for batch-factor accounting (`ItemIndex.childIds`,
   `indexToolItems`, `stats.ts:341`) — not a second, independently-maintained filter. For
   `narrationTokens` (message items), `childIds` does not apply: `indexToolItems`'s `toolItemOf`
   helper (`stats.ts:316-322`) returns `undefined` for anything with `kind !== 'tool'`, so a message
   item is never a member of that set regardless of its own `parentItemId` — filter these by reading
   `item.parentItemId` directly (D5, this revision). Child items' tool-call tokens are real spend
   and are reported, just as their own explicitly-unbilled line (see Data models,
   `childToolArgTokens`), never folded into `measuredTokens`.
2. **Thinking's measurability is model-specific, not permanent or Anthropic-wide — corrected this
   revision (D1).** Revision 3 claimed "thinking is not measurable at the text level, ever, for
   claude"; that is false as a cross-model law, even though it happens to be true for the two
   models `70f19253` ran. Measured this revision (see TLDR's four-model table):
   `claude-opus-5`/`claude-opus-4-8`/`claude-sonnet-5` withhold `thinking` text
   (`thinking: ""` + `signature`) in every sampled block; `claude-haiku-4-5` — a shipped, reachable
   preset (`core/model-presets.ts:32,36`) — does not. So the design now branches on the actual wire
   shape instead of assuming one:
   - **Where a response's `thinking` block is non-blank,** the mapper already mints a `reasoning`
     item for it (`claude-ui-mapper.ts:192`); its text is real, persisted, and tokenizable exactly
     like narration. `thinkingTokens` (Data models) is a genuinely **measured** field — Σ tokenize
     of every non-child, non-blank `reasoning` `item.completed`'s text — folded into
     `measuredTokens` alongside narration and tool-args.
   - **Where it is blank**, Anthropic has withheld the content and no tokenizer, however accurate,
     can count text it never received. The only honest move there is to **infer its size by
     subtraction**, using a calibration ratio measured from the same run's own thinking-free
     responses — not a borrowed constant, not a guess — and to **label it as an inference**
     (`withheldThinkingTokens`), never as a measured count. Calibrated mode's per-response
     classification (below) now folds any *visible* thinking text into the chars it treats as
     already-explained, so a step that ran on a visible-thinking model doesn't get double-counted
     as both "measured" and "withheld" for the same text.

### 1. Block-type occurrence counting at the wire (Phase 1) — reworked this revision (D1, D2)

`mapAssistant`'s block loop (`claude-ui-mapper.ts:180-245`) is the *only* place in the codebase
that still holds the raw Anthropic content block before it becomes an item or is silently dropped
(`:244`, `// Unknown block types (redacted_thinking, server_tool_use, …): ignored.`). Add a per-turn
tally there — `text`, `thinking` split into **`thinking` (non-blank) and `thinkingWithheld`
(blank) — corrected this revision, D1: a single merged counter cannot tell a model that withholds
reasoning (opus/sonnet) from one that shows it (haiku)** — `tool_use`, `redacted_thinking`,
`server_tool_use`, and `other` (any `raw.type` not in that list). **The tally branches on
`parent_tool_use_id` (corrected this revision, D2): a main-agent frame (`parent_tool_use_id`
absent) accumulates into `blockCounts`; a sub-agent frame accumulates into a separate
`childBlockCounts` instead** — `mapAssistant` runs unmodified for both kinds of frame today
(`claude-ui-mapper.ts:161-163`), so without this branch the tally would silently mix a dispatched
sub-agent's blocks into the parent step's count, next to a `usage.output` that never bills them.
Both counters accumulate across every frame of their kind in the turn, flushed onto
`turn.completed` in `mapResult` (`claude-ui-mapper.ts:526-591`), and reset per turn.

**A third hazard, found this revision (N3), sits in `mapAssistant` itself, not in the tally
design.** When a frame's block loop produces zero `UiEvent`s — which happens whenever every block
in the frame is a blank `thinking`, a `redacted_thinking`, or a `server_tool_use` (none of the
three mints an item) — `mapAssistant`'s `if (events.length === 0)` branch
(`claude-ui-mapper.ts:247-251`) returns EARLY with the OLD `state`, carrying forward only
`lastMainAgentPromptTokens`; any other local accumulator computed in that call is discarded. This
is not hypothetical: `mainAgentPromptTokens` (`claude-ui-mapper.ts:264`) already returns
`undefined` for any `parent_tool_use_id` frame, so a sub-agent frame gets no `context.updated` push
to keep `events` non-empty either — meaning EVERY sub-agent frame whose only block is a blank
`thinking` (the common opus/sonnet case, D1) hits this early return and would silently lose its
`childBlockCounts` increment, defeating D2's own fix in precisely the opaque-and-withheld
categories this phase exists to count. The fix belongs in Phase 1's implementation, not in this
spec's data model: the block-tally accumulator (this call's `blockCounts`/`childBlockCounts`
deltas) must be threaded through the `events.length === 0` path the same way
`lastMainAgentPromptTokens` already is — this early return must still carry forward an updated
tally, not just an updated prompt-size field. See Implementation-critical rules (#4) and
Verification §2.

This is a handful of counter increments (now split two ways instead of one) inside a loop that
already runs per block. No new dependency, no latency added to a live run, no change to what gets
persisted for existing item types. It is **forward-only relative to cezar's own NDJSON**:
`blockCounts`/`childBlockCounts` cannot retroactively explain a run recorded before this ships
*from that run's NDJSON alone*. It is, however, not the only source of this information for a
recent past run — see Architecture's transcript-join path, which is how this revision measured
`70f19253` itself without waiting for Phase 1 to exist. `blockCounts` adds **durability**: the
Claude Code session transcripts under `~/.claude/projects/` are outside cezar's control, on a
retention/pruning policy this repo does not own, while `turn.completed.blockCounts` lives forever
in cezar's own append-only NDJSON alongside everything else `stats.ts` already reads.

### 2. Tokenized replay reconciliation, with the withheld category made honest (Phase 2 — reworked)

**Two data sources, not one.** Everything narration/tool-args/thinking needs is already persisted
in cezar's own NDJSON: message/reasoning item text via `item.completed` (`ui-event-sink.ts:99-104`
— the reasoning item only exists when the mapper minted one, i.e. when `thinking` was non-blank,
which is what makes `thinkingTokens` a genuine measurement rather than always-zero, D1), tool-call
arguments via the same events' `item.input` (`UiToolItem.input`, `ui-events.ts:193`), and the
ground truth `turn.completed.usage.output`. That is a **pure replay function**, following the
module's own stated precedent (`stats.ts:16-19`): read the NDJSON, tokenize the recorded text, sum
per category. **But `item.completed` events include sub-agent tool calls, and `reportedTokens`
does not** — so the NDJSON-derived computation must first exclude any item with a `parentItemId`.
**This is two different filters, not one filter applied to two field kinds (D5, this revision):**
for `toolArgTokens` (tool items), use `stats.ts`'s own `ItemIndex.childIds` (`indexToolItems`,
`stats.ts:341`), the same index the batch-factor meter already builds for this exact reason;
for `narrationTokens`/`thinkingTokens` (message/reasoning items), `childIds` doesn't apply —
`toolItemOf` only recognizes `kind === 'tool'` (`stats.ts:316-322`) — so these read
`item.parentItemId` directly. Excluded tool items' tokenized total is reported separately as
`childToolArgTokens` — real spend, explicitly labeled unbilled-to-this-step, never merged into
`measuredTokens` (see Data models). Classifying *which individual API response* a chunk of
narration/tool-args/thinking came from — needed to separate the thinking-free calibration set from
the thinking-*withheld* set (not merely "has a thinking block", D1) — is not something
`item.completed` events carry (they are per-item, not per-response; one `turn` can span dozens of
internal API round trips, 24.7 on average across `70f19253`'s 11 turns). That classification
requires the **Claude Code session transcript**, joined by `sessionId` (see Architecture) — the
same file this revision read to produce the TLDR's numbers, and which already contains only the
main agent's own responses (a sub-agent's turns are billed and transcripted separately, under its
own `sessionId` — confirmed on `70f19253`: the joined transcript's 267 `tool_use` blocks match the
267 non-child items exactly, not the full 360), so the transcript-based calibration below needs no
additional filtering.

So Phase 2 runs in one of two modes, chosen automatically per step:

- **Basic mode** (transcript pruned or never captured, NDJSON only): tokenize narration, tool-args,
  and thinking precisely (D1 — `thinkingTokens` is measured here too, from any non-blank `reasoning`
  item.completed; zero on a step whose model withheld thinking entirely), **excluding any item with
  a `parentItemId`** — tool items via `ItemIndex.childIds`, message/reasoning items via the field
  directly (D5) — with excluded tool items reported separately as `childToolArgTokens`; report
  `measuredTokens` and the residual `unclassifiedGapTokens = reportedTokens − measuredTokens` (this
  is the only declared residual field for this mode — an earlier draft of this paragraph called it
  `gapTokens`/`gapPct`, names that were never added to `TokenBreakdown`; corrected this revision,
  N1, see Data models and Verification §5): **no split of the gap into "withheld thinking" vs
  "tokenizer imprecision"** — it is reported as this one labeled line, honestly not attributed
  further, and the identity `narrationTokens + toolArgTokens + thinkingTokens +
  unclassifiedGapTokens === reportedTokens` holds EXACTLY, by definition of the residual — an
  arithmetic tautology, not a claim about measurement quality (see Verification §5).
- **Calibrated mode** (transcript still present): additionally read the joined transcript, dedupe
  its per-block records by `message.id` (Architecture — required, or usage over-counts 2.5×),
  classify each unique response as thinking-bearing (has ≥1 thinking block, blank or not) or
  thinking-free, and compute:

  ```
  # calibrationRatio is RUN-WIDE — pooled once across every step's turns before the per-step loop
  # runs (N4, this revision) — NOT computed per step. Everything below the line is still per step,
  # applying the one pooled ratio.
  freeResponses     = responses with no thinking block, pooled across every step in the run
  freeChars         = Σ (text length + JSON.stringify(tool_use.input).length) over freeResponses
  freeTokens        = Σ usage.output_tokens over freeResponses        (ground truth for this subset)
  calibrationRatio  = freeTokens === 0 ? undefined : freeChars / freeTokens   (N4 guard, see below)

  # --- per step, from here down, using the run-wide calibrationRatio above ---
  bearingResponses  = this step's responses with ≥1 thinking block (blank OR non-blank — see D1: a
                       response with a non-blank block still counts as "bearing" here, it just isn't
                       WITHHELD; the length term below is what tells the two apart)
  bearingChars      = Σ (text length + tool-input JSON length + thinking-text length) over
                       bearingResponses  ── thinking-text length is 0 for a blank block (withheld,
                       unchanged from revision 3) and >0 for a non-blank one (e.g. haiku) — D1
  bearingTokens     = Σ usage.output_tokens over bearingResponses     (ground truth for this subset)
  expectedVisible   = calibrationRatio === undefined ? undefined : bearingChars / calibrationRatio
  withheldThinkingTokens = calibrationRatio === undefined ? undefined
                          : bearingTokens − expectedVisible   (signed; collapses toward 0 on a
                            bearingResponse whose thinking was fully visible, since expectedVisible
                            already accounts for it)
  ```

  **Why run-wide, not per step (N4, this revision; justification corrected, N6, this revision).**
  Revision 5 computed `calibrationRatio` per step. Revision 6 justified pooling with a "`spec` step:
  n=1, ratio 1.566, withheld 45 instead of 10,634" figure that turned out to be measured **per
  turn** (session `9f2f6bb7`, the `spec` step's first of two turns — that step restarted once), not
  at `TokenBreakdown`'s actual granularity, which is per `stepId` (`stats.ts:596` keys one
  `restarts` bucket per step id, pooling every turn a step ran across). At the design's real
  granularity, the `spec` step's calibration set is **n=4**, local ratio **2.144**, giving
  `withheldThinkingTokens` of **20,832** against the run-wide **20,242** — a **2.9%** difference, not
  a 99.6% one. Measured the same way across all 8 of `70f19253`'s steps, every local ratio sits in
  **2.03–2.28** against the run-wide 2.126, the smallest calibration set is **n=2** (not n=1), and
  the largest swing is **9.2%** (`context`: withheld 3,962 locally vs 3,629 run-wide) — the
  catastrophic per-turn figure cannot occur at the granularity this design actually computes at.
  Pooling run-wide is still the right call, on grounds that hold independent of any single step's
  measured swing: per-step free-response counts vary from 2 to 11 on this run and are unbounded
  below in general (a step can produce a single free response, or none — see the zero-free-response
  guard below), and one auditable, run-wide `appliedRatio` is simpler to reason about and to test
  than N independently-noisy per-step ratios, several of which a run this size will always compute
  from a single-digit sample. Pooling every step's free responses before computing the ratio removes
  that instability without changing the architecture: `computeRunStats` already runs over the whole
  run (D3), so the pool is built once, ahead of the per-step loop. **The guard above is for the run
  having ZERO free responses anywhere** — every response in every step carries a thinking block, a
  real if rare all-thinking-bearing run. There, no ratio is computable at all: `calibrationRatio` is
  `undefined`, every step's `mode` is `'basic'` (not `'calibrated'`, never `NaN`), and
  `withheldThinkingTokens`/`calibration` are `undefined` throughout that run — the same "undefined,
  never a fake number" rule this spec already applies to `opaqueBlocks` (N2) and
  `unclassifiedGapTokens`.

  `narrationTokens` / `toolArgTokens` / `thinkingTokens` (tokenized precisely from non-child
  `item.completed` events — `thinkingTokens` restored revision 4, D1) still report the true,
  measured visible categories, and `thinkingTokens` is what feeds the "thinking-text length" term
  above for a bearingResponse whose block turned out non-blank. `withheldThinkingTokens` is reported
  as its own explicitly labeled line — **"withheld thinking — inferred by subtraction using this
  run's own (run-wide, N4) thinking-free calibration ratio, net of any thinking text that was
  directly measured"** — never merged into a fourth silent bucket, and never called "measured". Each
  step's `calibration` diagnostic (Data models) still reports that step's own local free-response
  count/chars/tokens/ratio — useful for spotting a thin-sample step like `spec` above — alongside a
  new `appliedRatio` field naming the run-wide ratio actually used to compute
  `withheldThinkingTokens`, so the two are never confused with each other.

**Reconciliation, precisely — the part that makes criterion 3 a real, falsifiable test.** The
reconciliation target is **the thinking-free subset only**:

```
freeGapTokens = freeTokens − Σ tokenize(text/tool-args of freeResponses)
freeGapPct    = freeGapTokens / freeTokens × 100
```

This is the genuinely falsifiable claim revision 1 was reaching for and couldn't state cleanly:
on responses where nothing is withheld, applying a real tokenizer to the real recorded text is a
meaningful, falsifiable check against `usage.output` — but "meaningful" does not mean "expected to
be tight." **This run's own thinking-free calibration ratio, 2.126 chars/token (n=48, 80,295
chars / 37,773 tokens), argues against a small `TOLERANCE`, not for one:** it is markedly denser
than a real BPE tokenizer produces on Bash commands and JSON tool-call arguments (typically
≈2.8–3.5 chars/token for general-purpose vocabularies), which means these thinking-free responses
carry substantial per-response billed overhead that the visible text does not account for. Running
the actual shipped tokenizer over the same 80,295 chars is expected to land `freeGapPct` around
25–35%, not the single-digit-to-low-teens figure a naive "a real tokenizer should nearly fully
explain it" intuition would suggest — Phase 4 (below) must re-derive the real number and branch on
whether it comes out tight or wide, rather than assume tightness going in. On the thinking-bearing
subset, no tight bound is asserted — `withheldThinkingTokens` is reported, not tested against a
tolerance, because its "true" value is by construction never observable to check against.

`opaqueBlocks` (Σ `blockCounts.{redactedThinking, serverToolUse, other}` — unrelated to regular
`thinking`, which is common and now well understood) remains as designed in revision 1: reported
honestly as its own labeled, unattributed quantity if it ever occurs on a step where `blockCounts`
is available (undefined, not 0, on a pre-Phase-1 run like `70f19253` itself — N2, this revision;
see Data models), never
folded into "thinking" or "withheld".

## Architecture

```
mapAssistant (claude-ui-mapper.ts)
  └─ per-block tally, MAIN-AGENT FRAMES ONLY (parent_tool_use_id absent — D2, this revision)
       │  thinking split into thinking (non-blank) / thinkingWithheld (blank), text/tool_use/
       │  redacted_thinking/server_tool_use/other — accumulated in ClaudeUiMapperState, per turn
       │  a frame WITH parent_tool_use_id tallies into childBlockCounts instead (D2) — same
       │  "never merge, never drop" rule this spec already applies to childToolArgTokens
       ▼
mapResult → UiTurnCompletedEvent.blockCounts / .childBlockCounts   (NEW fields, Phase 1)
       │
       ▼  (persisted verbatim to NDJSON, like every other UiEvent)
runs/<id>.ndjson  ──────────────┐
       │                        │  session.started.sessionId (ui-events.ts:216) is the exact
       │ readRunStats (D3)      │  string cezar passes to the CLI as --session-id / --resume
       │ globs+loads the        │  (claude-cli-runner.ts:709-716) — the CLI names its own
       │ transcript, THEN       │  session transcript file after it. The join is therefore
       │ calls computeRunStats  ▼  BY CONSTRUCTION, not coincidence:
       ▼                        glob ~/.claude/projects/*/<sessionId>.jsonl
computeRunStats(runId, events,    (Claude Code's own transcript — one JSON record per raw
                transcripts?)     content block, NOT per API response: verified on 70f19253,
  ├─ existing: batch factor,      628 records / 272 unique message.id, block-count histogram
  │  model/exec/wall ms, sleep,   {1: 628} — every record repeats that response's full `usage`)
  │  peak context (unchanged)
  └─ NEW: tokenizeStepBreakdown  ── PURE function of (events, transcripts?) — D3: no fs access
       (item.completed +            of its own, so the synthetic-transcript fixture in
        turn.completed;             Verification §3 passes `transcripts` straight in, no disk
        + transcripts param,        needed for the test
        when provided)
            │
            ▼
StepStats.tokenBreakdown?: TokenBreakdown
       │
       ▼
formatRunStats (stats.ts) / stats-cli.ts   → cez run stats prints the breakdown  (Phase 3)
```

Seven things worth stating plainly, the first two corrected from revision 1, the fourth updated
this revision (D5), the sixth and seventh new this revision (D3/D4):

- **The transcript join is a real, deterministic, retroactive data source — not a future-only
  capability — but it is a filename match, not a computed path.** `session.started.sessionId` is
  the literal argument cezar passes as `--session-id`/`--resume` (`claude-cli-runner.ts:709-716`),
  and the CLI's own transcript file is named after it, but the *directory* it lands in
  (`~/.claude/projects/<something>/`) is not a value this design should compute from the run's cwd:
  `70f19253` alone has three candidate project directories on this box (the worktree path, a
  `cez-root-lease` path, and a `cez-root-isolation` path) depending on how the step was launched.
  The join must therefore glob `~/.claude/projects/*/<sessionId>.jsonl` and take whichever directory
  matches, never re-derive a slug from the cwd. Verified end-to-end on `70f19253`: all 11 turns'
  `sessionId`s match an existing transcript file 1:1 under exactly one of those three directories,
  and `stepId` is present on every `turn.completed`/`item.completed` event in the run's NDJSON, so
  per-step attribution through the join is never ambiguous. This is what let this revision produce
  real numbers for `70f19253` without waiting for a new run (Verification §8).
- **Deduping by `message.id` is mandatory whenever usage is derived from a raw transcript, or the
  total over-counts 2.5×.** Measured on `70f19253`: naively summing `usage.output_tokens` once per
  transcript record gives 940,963; deduped by `message.id`, 375,001 — matching the NDJSON's own
  `turn.completed.usage.output` sum exactly. This is a third instance of the exact bug class
  `stats.ts:21-38` already documents twice ("assuming a wire spelling/attribution instead of
  measuring it") and must be stated as a hard implementation rule (Data models / Risks), not left
  implicit.
- **`blockCounts` (Phase 1) and `tokenBreakdown` (Phase 2) are differently retroactive, and remain
  independent.** `tokenBreakdown` in *basic* mode works on any run with v2 `item.*` events on disk
  today. *Calibrated* mode is basic mode PLUS the joined transcript, which is only available while
  Claude Code has not pruned it — an unbounded but not indefinite window — never the transcript
  alone: `narrationTokens`/`toolArgTokens`/`thinkingTokens` are computed from `item.completed` text
  regardless of mode, so a step with a transcript but no `item.*` events has nothing to tokenize
  either way. `blockCounts` requires the run to have been recorded *after Phase 1 ships*, but then
  lives forever in cezar's own storage. **`mode` is `'unavailable'` whenever a step has no `item.*`
  events, full stop, regardless of whether a transcript exists for it (tightened, N9, this
  revision — a transcript-without-items step is effectively unreachable in practice, since
  `session.started.sessionId`, the transcript join key, is itself part of the same v2 event stream
  that also carries `item.*` events for the same step)** — never a fake zero. **This is a per-step
  data-availability check, not a backend check (R7's premise corrected, N8, this revision) — see
  Data models.**
- **`reportedTokens` is main-agent-only, and every measured category must be filtered to match, or
  the reconciliation identity breaks for a reason that has nothing to do with thinking.**
  `turn.completed.usage.output` covers only the API responses of the agent that owns the step —
  a dispatched sub-agent runs its own turns, billed to its own `turn.completed` under its own
  `sessionId`, never rolled into the parent's. Measured on `70f19253`: 93 of 360 tool
  `item.completed` events carry `parentItemId` (ran inside a sub-agent's window); the joined
  transcript contains exactly 267 `tool_use` blocks, matching the 267 non-child items, not 360.
  So `narrationTokens`/`toolArgTokens`/`thinkingTokens` — computed from `item.completed` — must
  exclude any item with a `parentItemId`. **Corrected this revision (D5): this is two different
  filters, not one.** `toolArgTokens` is computed over tool items, which `stats.ts`'s existing
  `ItemIndex.childIds` does index (`indexToolItems`, `stats.ts:341` — reuse it, the mechanism
  the batch-factor meter already builds to answer the identical question, not a new one).
  `narrationTokens`/`thinkingTokens` are computed over message/reasoning items, which `childIds`
  does **not** index — `toolItemOf` (`stats.ts:316-322`) returns `undefined` for any item with
  `kind !== 'tool'`, so a message or reasoning item is never a member of that set no matter whose
  child it is (confirmed this revision: 0 of 137 message items on `70f19253` carried a
  `parentItemId`, so revision 3's "reuse `childIds`" instruction for narration was never exercised
  live, but was false as written). These must read `item.parentItemId` directly instead. Either
  way, the excluded child items' tokens are real spend and are reported as their own line
  (`childToolArgTokens`, Data models) — labeled explicitly as tokens the step's own
  `reportedTokens` never counted, not silently dropped.
- **Why not populate `TokenUsage.reasoning` (already declared, never used)?** Because the wire
  never reports a reasoning-only output count for claude (see Problem citations table) — there is
  nothing honest to assign to it from the mapper, even on a model whose thinking is visible: the
  wire's own `usage.output_tokens` is still one number covering every block type in that response,
  never split at the source. `reasoning` stays reserved for a backend that *does* report it live.
  The new breakdown (including the now-measured `thinkingTokens`) lives on `StepStats`/`RunStats`,
  computed at replay time, not on the wire `TokenUsage` type.
- **`computeRunStats` stays pure and synchronous; `readRunStats` owns every filesystem read,
  transcript included (D3, this revision).** Confirmed this revision: `computeRunStats`
  (`stats.ts:470`) is sync and touches no `fs` API; every read lives in the async `readRunStats`
  (`stats.ts:655`). Revision 3 drew the transcript join as if it happened inside
  `computeRunStats`, which cannot read `~/.claude/projects/*/<sessionId>.jsonl` without becoming
  async — and left Verification §3's synthetic-transcript fixture with no way to supply one.
  Fixed: `readRunStats` globs and parses the transcript(s) for the run's distinct `sessionId`s
  (falling back silently to `undefined` per-step when a transcript is missing or unparseable — the
  same "degrade to `unavailable` mode, never fail the whole read" posture the module already uses
  for a malformed NDJSON line), then calls `computeRunStats(runId, events, transcripts?)`. A test
  exercises the pure function directly with a hand-built `transcripts` argument, no disk involved.
- **`stats-cli.ts`'s own module doc is stale the moment calibrated mode ships, and must be
  corrected in place, not left standing (D4).** It currently reads *"Filesystem-only: it reads
  `<repo>/.ai/cezar/runs/<runId>.ndjson` and nothing else"* (`stats-cli.ts:11`) — true today,
  false once Phase 2 reads `~/.claude/projects/`. Phase 2's implementation must update that comment
  in the same change, per `CLAUDE.md`'s correction-in-place rule, and additionally apply
  `stats-cli.ts`'s existing `validRunId` character-class guard (`stats-cli.ts:56-62`) to the
  `sessionId` values pulled out of the run's own NDJSON before they are used to build the
  transcript glob path — `runId` already gets this treatment for the same reason (it, too, is
  attacker-influenced data reaching a filesystem path) and `sessionId` is no more trustworthy.

## Data models

**Wire contract addition (Phase 1) — `packages/cezar/src/core/ui-events.ts`. Reworked this revision
(D1: split `thinking`; D2: `childBlockCounts`):**

```ts
/** Occurrence counts of raw Anthropic content-block types seen this turn, before mapping or
 *  discarding — claude only, absent for other backends and for any turn recorded before this
 *  field existed. Free to compute (no tokenizer): answers "did extended thinking happen, was it
 *  visible or withheld, did opaque billing happen at all" without persisting content that
 *  Anthropic itself never reveals (redacted_thinking's `data` field is intentionally not captured
 *  here or anywhere else). MAIN-AGENT FRAMES ONLY (D2, this revision) — see childBlockCounts. */
export interface ClaudeBlockCounts {
  text: number;
  /** NON-BLANK `thinking` blocks only — split from `thinkingWithheld` this revision (D1). A
   *  non-blank block means the mapper minted a `reasoning` item for it (claude-ui-mapper.ts:192)
   *  and its text is directly measurable — see TokenBreakdown.thinkingTokens. Confirmed
   *  model-specific: 0 on 70f19253 (claude-opus-5/claude-sonnet-5, both withhold), but
   *  claude-haiku-4-5 (a shipped preset, core/model-presets.ts:32,36) emits ONLY non-blank
   *  thinking in every sampled block on this box. A merged thinking counter cannot tell these two
   *  regimes apart, which is exactly the distinction this fix depends on. */
  thinking: number;
  /** BLANK `thinking` blocks (`thinking: ""` + a populated `signature`) — Anthropic's documented
   *  shape for real, billed, permanently-withheld reasoning. On 70f19253, 224/272 responses (82%)
   *  carried a thinking block and ALL 224 were this shape — proof this must not be conflated with
   *  "no thinking happened": a run that emits only withheld thinking (the common case on
   *  opus/sonnet, not a corner case) must read differently from a run that requests no thinking at
   *  all. Feeds TokenBreakdown.withheldThinkingTokens's inference, never a measured count. */
  thinkingWithheld: number;
  toolUse: number;
  redactedThinking: number;
  serverToolUse: number;
  other: number;
}

export interface UiTurnCompletedEvent {
  type: 'turn.completed';
  turnId: string;
  stopReason: StopReason;
  usage?: TokenUsage;
  costUsd?: number;
  contextTokens?: number;
  /** NEW. Main-agent frames only — see childBlockCounts (D2). */
  blockCounts?: ClaudeBlockCounts;
  /** NEW, this revision (D2). Tally of the SAME shape, but over frames carrying
   *  parent_tool_use_id — a dispatched sub-agent's own blocks, on the SAME turn.completed event as
   *  a usage.output that never bills them. Reported here rather than merged into blockCounts (the
   *  exact "billed a child's calls to the parent" bug class stats.ts:21-38 documents twice, and
   *  which revision 3 left live in this one spot) or silently dropped (the same
   *  never-drop-real-spend rule this spec already applies to childToolArgTokens). undefined for a
   *  step that dispatched nothing this turn — not a fake zero-filled object. */
  childBlockCounts?: ClaudeBlockCounts;
}
```

**Replay computation (Phase 2, reworked) — `packages/cezar/src/runs/stats.ts`:**

```ts
export type TokenBreakdownMode = 'calibrated' | 'basic' | 'unavailable';

export interface TokenBreakdown {
  mode: TokenBreakdownMode;
  /** Σ turn.completed.usage.output over this step's turns — the ground truth being reconciled.
   *  MAIN-AGENT-ONLY: a dispatched sub-agent's turns are billed to its own turn.completed under
   *  its own sessionId, never rolled into this one. Every field below must be filtered to match
   *  (exclude items with a parentItemId) or it double-counts against a total that never included
   *  the child's spend in the first place. Required in EVERY mode, including 'unavailable' (N8,
   *  this revision) — StepStats.tokenBreakdown itself is undefined unless this step had a
   *  turn.completed (see below), so a defined TokenBreakdown always has a usage total, even when
   *  nothing downstream of it could be measured. */
  reportedTokens: number;
  /** Tokenized text of every 'message' item.completed belonging to THIS agent (parentItemId
   *  absent — see reportedTokens). Measured, not inferred. Filtered by reading item.parentItemId
   *  DIRECTLY (D5, this revision) — NOT via ItemIndex.childIds, which only indexes items where
   *  toolItemOf(...) returns non-undefined, i.e. kind==='tool' (stats.ts:316-322); a message item
   *  is never a member of that set regardless of its own parentItemId. undefined only in
   *  'unavailable' mode (N8, this revision — was a required number, forcing a fake 0 the one place
   *  this spec's own "undefined, never a fake 0" convention wasn't applied); always a real number,
   *  0 included, in 'basic'/'calibrated' mode. */
  narrationTokens?: number;
  /** Tokenized JSON.stringify(item.input) of every 'tool' item.completed with no parentItemId,
   *  PLUS item.started input for any such tool whose item.completed never arrived (aborted turn)
   *  or whose completed event lost its input (claude-ui-mapper.ts:454 state-loss path — 3/360 tool
   *  completions on 70f19253) — deduped by item id so a tool counted from item.started is not
   *  double-counted if item.completed does arrive with input. Filtered via the same
   *  ItemIndex.childIds stats.ts already computes (indexToolItems, stats.ts:341) — reuse it,
   *  don't rebuild it. Measured, not inferred. undefined only in 'unavailable' mode (N8, this
   *  revision — same fix as narrationTokens above). */
  toolArgTokens?: number;
  /** Tokenized JSON.stringify(item.input) of tool item.completed/item.started events that DO carry
   *  a parentItemId — ran inside a sub-agent's own context window. Real spend, but never counted
   *  in reportedTokens (see above), so it is reported here as its own explicitly-unbilled-to-this-
   *  step line rather than folded into toolArgTokens or silently dropped. Measured on 70f19253: 93
   *  of 360 tool item.completed events, ≈10,067 tokens (2.7% of reportedTokens for this run). Zero
   *  for a step that dispatched nothing, but undefined (not 0) in 'unavailable' mode (N8, this
   *  revision) — "dispatched nothing" and "couldn't be measured" must stay distinguishable. */
  childToolArgTokens?: number;
  /** RESTORED this revision (D1) — revision 2 killed this as "always evaluates to 0 for claude",
   *  which is true only for the two models 70f19253 happened to run. Tokenized text of every
   *  non-child 'reasoning' item.completed (the mapper only mints these for NON-BLANK thinking
   *  text, claude-ui-mapper.ts:192, so this is genuinely measured, not inferred). Zero on a step
   *  whose model withholds thinking (claude-opus-5/opus-4-8/sonnet-5, confirmed this revision);
   *  real and nonzero on a step using a model that emits visible thinking (claude-haiku-4-5, a
   *  shipped preset — core/model-presets.ts:32,36). Included in measuredTokens. Filtered by
   *  item.parentItemId directly, same as narrationTokens (D5) — a reasoning item is not a 'tool'
   *  item either, so ItemIndex.childIds does not apply to it. undefined only in 'unavailable' mode
   *  (N8, this revision — same fix as narrationTokens above). */
  thinkingTokens?: number;
  /** narrationTokens + toolArgTokens + thinkingTokens. Deliberately excludes childToolArgTokens
   *  (unbilled to this step) and withheldThinkingTokens/unclassifiedGapTokens (inferences, not
   *  measurements — folding either in here would make "components sum to usage.output" true by
   *  construction, the tautology criterion 3 exists to rule out). undefined only in 'unavailable'
   *  mode (N8, this revision), the one mode where its three addends are themselves undefined. */
  measuredTokens?: number;
  /** 'calibrated' mode only: bearingTokens − (bearingChars / calibrationRatio), i.e. the
   *  thinking-bearing subset's ground-truth usage minus its predicted visible-token cost, where
   *  bearingChars now includes any recorded (non-blank) thinking-text length (D1 — see Solution) so
   *  a bearingResponse whose thinking was actually visible doesn't get double-counted as both
   *  measured (via thinkingTokens) and withheld here. calibrationRatio is RUN-WIDE, not this step's
   *  own (N4, this revision — see calibration.appliedRatio below and Solution's "Why run-wide, not
   *  per step"): local ratios still vary step to step (2.03-2.28 against the run-wide 2.126 on
   *  70f19253, n=2-11 free responses per step — N6, this revision, corrected an earlier figure that
   *  was actually measured per turn, not per step), and pooling run-wide keeps a thin-sample step's
   *  own noisier local ratio from producing a large, wrong number on its own. SIGNED. Labeled as an
   *  INFERENCE in every consumer (printer, docs) — never "thinkingTokens", which is now a real,
   *  separate, measured field (see above) and must not be confused with this one. undefined in
   *  'basic'/'unavailable' mode; also undefined in a 'calibrated'-eligible run that has ZERO
   *  thinking-free responses anywhere (no calibrationRatio is computable — N4 guard; that run's
   *  steps report mode: 'basic' instead, never NaN); collapses toward 0 (not undefined — it's still
   *  computed, just small) on a calibrated step where thinking was fully visible. */
  withheldThinkingTokens?: number;
  /** 'calibrated' mode only, NEW this revision (N1). reportedTokens − (narrationTokens +
   *  toolArgTokens + thinkingTokens + withheldThinkingTokens). SIGNED. Declared explicitly because
   *  the identity does NOT close for a measurement reason, only a definitional one: measuredTokens
   *  is a real BPE tokenization of NDJSON item.completed text, while withheldThinkingTokens is a
   *  chars-ratio inference over transcript text (bearingTokens − bearingChars/calibrationRatio) —
   *  two independent estimators of different (only partially overlapping) evidence, with no
   *  algebraic reason for their sum to equal reportedTokens on the nose. calibratedResidual is that
   *  leftover, reported honestly rather than assumed away. Phase 4's falsifiable test is
   *  freeGapPct (the thinking-free subset alone, direct tokenization against ground truth, no
   *  calibration ratio involved) — NOT this field; a small calibratedResidual is not a design goal
   *  here, just a measured, printed quantity (Verification §5). undefined outside 'calibrated'
   *  mode. */
  calibratedResidual?: number;
  /** 'basic' mode only: reportedTokens − measuredTokens, reported as ONE unattributed line —
   *  no attempt to split it into thinking vs tokenizer noise without the transcript's per-response
   *  classification. undefined in 'calibrated'/'unavailable' mode. */
  unclassifiedGapTokens?: number;
  /** 'calibrated' mode only: gap on the thinking-free response subset alone — the number Phase 4's
   *  test actually bounds. |freeGapPct| ≤ TOLERANCE is the falsifiable claim; NOT computed over
   *  thinking-bearing responses, where a gap is expected and reported via withheldThinkingTokens
   *  instead. undefined outside 'calibrated' mode. */
  freeGapPct?: number;
  /** Σ blockCounts.{redactedThinking,serverToolUse,other} over the step's turns, but ONLY when at
   *  least one turn.completed in the step carried a blockCounts field at all (Phase 1 is
   *  forward-only — see Architecture). undefined, NOT 0, for a step where no turn carries
   *  blockCounts — which is every already-archived run, including 70f19253, this spec's own
   *  baseline. Corrected this revision (N2): this field used to be non-optional, silently reading a
   *  fake 0 for every pre-Phase-1 run and contradicting the "undefined, never a fake 0" convention
   *  this spec applies to every other field in the same situation (tokenBreakdown,
   *  childBlockCounts, withheldThinkingTokens, etc). A consumer must not read `undefined` here as
   *  "confirmed no opaque blocks occurred" (pins R6). Unrelated to ordinary `thinking`, which is
   *  common and handled above — this is the genuinely opaque, never-reconstructable-even-
   *  approximately category. */
  opaqueBlocks?: number;
  /** Present only in 'calibrated' mode — diagnostic, not asserted against in tests.
   *  freeResponseCount/freeChars/freeTokens/ratio are THIS STEP's OWN local free-response numbers
   *  (informational — e.g. spotting a thin-sample step; on 70f19253 the thinnest step, `context`,
   *  has n=2 — N6, this revision, corrected an earlier n=1 figure that was actually measured per
   *  turn, not per step); NONE of these four is what withheldThinkingTokens was actually computed
   *  from. appliedRatio (NEW, N4 this revision) is the RUN-WIDE calibrationRatio that WAS used —
   *  see Solution's "Why run-wide, not per step". The two are deliberately different fields so a
   *  consumer can never mistake a step's own noisy local ratio for the one that produced its
   *  withheldThinkingTokens. */
  calibration?: {
    freeResponseCount: number;
    freeChars: number;
    freeTokens: number;
    /** ratio?: number (N7, this revision — was a required number, giving ratio = 0/0 = NaN on a
     *  step whose every response of its own carries thinking, i.e. freeResponseCount 0; not live on
     *  70f19253, whose thinnest step still has n=2, but reachable — per-session n already ranges
     *  1-10 on this same run, and a step is not guaranteed a free response of its own). undefined
     *  exactly when THIS step's own freeTokens === 0 — independent of the run-wide
     *  zero-free-response guard on calibrationRatio itself (N4); appliedRatio below can still be
     *  defined here even when ratio is not, since the run-wide pool draws from every step, not just
     *  this one. */
    ratio?: number;
    /** NEW, N4 this revision. The run-wide calibrationRatio actually applied to compute this
     *  step's withheldThinkingTokens — undefined only when the whole run had zero thinking-free
     *  responses (see withheldThinkingTokens's own doc). */
    appliedRatio?: number;
  };
  /** RunStats.totals.tokenBreakdown ONLY (N5, this revision) — always undefined on a per-step
   *  TokenBreakdown, by construction. Count of steps in the run whose own tokenBreakdown had
   *  opaqueBlocks === undefined (no turn carried blockCounts), i.e. excluded from the opaqueBlocks
   *  sum below. `RunStats.totals: Omit<StepStats, 'stepId' / 'restarts'>` (stats.ts:278) reuses this
   *  same TokenBreakdown shape for the run-level aggregate, so this is where the "count of steps
   *  excluded" the totals comment (below) already promised has to live. */
  stepsWithoutBlockCounts?: number;
  /** RunStats.totals.tokenBreakdown ONLY (N5, this revision) — always undefined on a per-step
   *  TokenBreakdown. Count of steps in the run whose own tokenBreakdown.mode was NOT 'calibrated'
   *  (basic, unavailable, or no tokenBreakdown at all), i.e. excluded from the
   *  withheldThinkingTokens/calibratedResidual sums below. */
  stepsNotCalibrated?: number;
}

// StepStats gains:
tokenBreakdown?: TokenBreakdown;  // undefined when the step emitted no turn.completed at all —
                                   // same "undefined, never a fake 0" convention as peakContextTokens.

// RunStats.totals: reportedTokens always SUMs across every step (required in every mode, N8 this
// revision — see reportedTokens's own doc). narrationTokens / toolArgTokens / thinkingTokens /
// childToolArgTokens / measuredTokens SUM only across steps where each is itself defined — all
// five are undefined on an 'unavailable'-mode step (N8, this revision), the same "sum only where
// defined" treatment opaqueBlocks below already uses; no separate exclusion counter is added for
// them since totals.mode already reports 'unavailable' when every step was, and a run mixing
// 'unavailable' with measurable steps undercounts by exactly the unavailable steps' own
// contribution, which by definition carried no measured information to add. opaqueBlocks sums only
// across steps where it was itself defined (blockCounts present, N2
// this revision) — a run with steps missing blockCounts reports the sum plus
// stepsWithoutBlockCounts (N5, this revision — declared as a real TokenBreakdown field above; the
// "count of steps excluded" this comment always promised but revision 5 never gave it anywhere to
// live), never a fake 0 baked silently into the total. withheldThinkingTokens and
// calibratedResidual (N1, this revision) sum only across steps that were themselves 'calibrated';
// a run with mixed modes reports the sum plus stepsNotCalibrated (N5), never silently averages
// partial data into the total. mode/freeGapPct/calibration on a MIXED-MODE run's totals (N5, this
// revision — previously unstated): mode is 'calibrated' if ANY step was calibrated
// (stepsNotCalibrated names how many weren't), else 'basic' if any step was basic, else
// 'unavailable'; freeGapPct and calibration are ALWAYS undefined on totals — both are per-step
// diagnostics (freeGapPct is Phase 4's own separately-computed tolerance figure, not summed here;
// calibration's four local numbers are meaningless averaged across steps of different sample
// sizes) — never a fabricated run-level average, the same rule R9 already states for
// step-averaged ratios generally.
```

**Implementation-critical rules, stated once and referenced everywhere they apply:**

1. Any code path that derives token usage from raw Claude Code transcript records
   (calibrated-mode classification) MUST dedupe by `message.id` before summing
   `usage.output_tokens` — never sum per content-block record. Measured over-count on `70f19253`
   from skipping this: 2.5× (940,963 vs the correct 375,001). This is the same bug class
   `stats.ts:21-38` already paid for twice.
2. Any code path that tokenizes `item.completed`/`item.started` events for `toolArgTokens` MUST
   exclude items carrying a `parentItemId` (report them under `childToolArgTokens` instead),
   reusing `stats.ts`'s existing `ItemIndex.childIds` (`indexToolItems`, `stats.ts:341`) —
   never a second, independently-maintained parent/child check. **Corrected this revision (D5):**
   this reuse only applies to tool items. For `narrationTokens`/`thinkingTokens` (message/reasoning
   items), `childIds` does not apply — `toolItemOf` returns `undefined` for `kind !== 'tool'`
   (`stats.ts:316-322`), so these items are never members of that set. Filter them by reading
   `item.parentItemId` directly instead. Measured impact of skipping the tool-item filter on
   `70f19253`: 93/360 tool completions, ≈10,067 tokens (2.7% of `reportedTokens`) misattributed
   into a total the ground truth never counted. This is the same bug class `stats.ts:21-38`
   documents as "billed a child's tool calls to the parent."
3. The same parent/child distinction applies to `ClaudeBlockCounts` at the wire (D2, this
   revision): `mapAssistant`'s per-block tally MUST branch on `parent_tool_use_id` and write to
   `blockCounts` when absent, `childBlockCounts` when present — never one shared counter. This is
   the identical rule as #2, one layer earlier in the pipeline (at block-tally time instead of
   replay time), and both exist because `mapAssistant` runs unmodified for a sub-agent frame
   (`claude-ui-mapper.ts:161-163` derives `parentItemId` from `msg.parent_tool_use_id` with no
   branch today).
4. **(N3, new this revision.)** `mapAssistant`'s `events.length === 0` early return
   (`claude-ui-mapper.ts:247-251`) MUST carry forward this call's block-tally accumulator the same
   way it already carries forward `lastMainAgentPromptTokens` — NOT bail out to the unmodified old
   `state`. Skipping this silently drops the tally for any frame whose only blocks are a blank
   `thinking`, a `redacted_thinking`, or a `server_tool_use` (none of the three mints an item, so
   `events` stays empty) — the exact opaque/withheld categories Phase 1 exists to count, and
   disproportionately likely on a sub-agent frame, since `mainAgentPromptTokens`
   (`claude-ui-mapper.ts:264`) already returns `undefined` there, removing the one other thing that
   would otherwise keep `events` non-empty.
5. **(N4, new this revision; numbers corrected, N6, this revision.)** `calibrationRatio` MUST be
   computed ONCE, RUN-WIDE — pooling every step's free (thinking-free) responses before the
   per-step loop — never per step. Measured on `70f19253` at `TokenBreakdown`'s own per-`stepId`
   granularity (not per turn — see Solution's "Why run-wide, not per step"), local ratios range
   2.03–2.28 against the run-wide 2.126 (n=2 to n=11 free responses per step), a swing of up to 9.2%
   on the thinnest step (`context`) — real, but not catastrophic at this run's shape. The rule is
   kept regardless: per-step free-response counts are unbounded below in general (a step can
   produce a single free response, or none), and one auditable, run-wide `appliedRatio` is simpler
   to reason about and to test than N independently-noisy per-step ratios. Guard the pool itself:
   when the RUN has zero free responses anywhere, `calibrationRatio` is `undefined` — every step in
   that run reports `mode: 'basic'` (never `'calibrated'`, never `NaN = 0/0`), and
   `withheldThinkingTokens`/`calibration` are `undefined` throughout. **Separately (N7, this
   revision):** a single calibrated step whose OWN free-response count is zero — while the run-wide
   pool, drawn from other steps, is non-empty — must not compute `calibration.ratio = 0/0 = NaN`.
   That field is `ratio?: number`, undefined exactly when this step's own `freeTokens === 0`,
   independent of the run-wide guard above (Data models); `withheldThinkingTokens` for that step is
   still computed normally, from `calibration.appliedRatio`.

## API contracts

None. `cez run stats` is a CLI/local read, not a served route — `readRunStats` calls
`computeRunStats` directly against a local NDJSON file plus, for calibrated mode, a local
transcript file under `~/.claude/projects/` (D3: `readRunStats`, not `computeRunStats`, does this
read — see Architecture) — a local filesystem read, not a network call. No `GET` endpoint changes.
The `UiTurnCompletedEvent.blockCounts`/`childBlockCounts` addition widens the wire event contract,
and its client-side mirror lives at `packages/api-client/src/protocol/ui-events.ts:172-178`
(`UiTurnCompletedEvent`) — that file must gain the same `blockCounts?`/`childBlockCounts?:
ClaudeBlockCounts` fields, hand-edited, same as this file already diverges from the server on
`contextTokens` (added server-side, still absent from the mirror, typecheck green regardless).
**No automated test catches a missed field here.** `packages/cezar/src/server/api-types.test.ts` —
the only "parity" guard in the repo for this event shape — pins exactly one thing:
`Exact<RunEvent, WebRunEvent>` against the loose, index-signatured `RunEvent` bag from
`runs/store.ts`; its own doc explains the other 58 shape-by-shape guards were retired in favor of
route-derived contract checks, and `UiTurnCompletedEvent` was never one of the two that stayed. So
mirroring `blockCounts`/`childBlockCounts` (and, while touching this file, backfilling the
already-missing `contextTokens`) is a **manual step to perform and note in the phase's own PR
description**, not a test to satisfy. If the cockpit UI has no near-term plan to consume
`blockCounts`, that is a legitimate reason to skip the mirror — but skip it deliberately, stated as
such, not by omission.

## Phases

Phases 1 and 2 are independently shippable. Phase 3 depends on Phase 2's fields existing first
(it has nothing to print without them) — sequenced, not independent, despite reading like a
parallel deliverable.

**Phase 1 — block-type telemetry at the wire.** `ClaudeBlockCounts` type (with `thinking`/
`thinkingWithheld` split, D1); tally in `mapAssistant`, **branching on `parent_tool_use_id` (D2)**
— main-agent frames accumulate into `blockCounts`, sub-agent frames into `childBlockCounts`, never
one shared counter; flush + reset both in `mapResult`. Ships alone, gives every run recorded from
here on a durable, tokenizer-free answer to "did extended thinking happen, was it visible or
withheld, did opaque billing happen, how often" — no longer a hypothesis to test but a confirmed,
common (and now correctly-attributed) case this makes visible forever instead of only for as long
as `~/.claude/projects` happens to retain the transcript. **No contract-parity test gates this**
(see API contracts) — mirroring `blockCounts`/`childBlockCounts` into
`packages/api-client/src/protocol/ui-events.ts:172-178` is a manual step for this phase's PR to
perform and call out, not something `api-types.test.ts` will fail on if skipped.

**Phase 2 — tokenized replay reconciliation, basic + calibrated modes.** Add the tokenizer
dependency; `TokenBreakdown` type and its computation, added to `computeRunStats`, which **stays
pure and synchronous and gains a `transcripts?` parameter (D3)** rather than reading the
filesystem itself: `computeRunStats(runId, events, transcripts?)`. `readRunStats` (already the
module's one async, fs-touching function, `stats.ts:655`) globs and parses the transcript(s) for
the run's distinct `sessionId`s and passes them in — reading non-child `item.completed` +
`turn.completed` per step for narration/tool-args/thinking (basic mode, works on any run with v2
item events, including `70f19253` today). Tool items are filtered via `stats.ts`'s existing
`ItemIndex.childIds` (`indexToolItems`, `stats.ts:341`); **message/reasoning items are filtered
by reading `item.parentItemId` directly (D5)**, since `childIds` does not index them. Excluded tool
items report separately as `childToolArgTokens`. The transcript-join helper (`sessionId` → glob
`~/.claude/projects/*/<sessionId>.jsonl` — the directory is not deterministically computable
(`70f19253` alone has three candidate project directories on this box: the worktree, a
`cez-root-lease` path, and a `cez-root-isolation` path), so the join globs and matches by filename,
never by re-deriving the slug, and validates `sessionId` against the same character class
`validRunId` already applies to `runId` before it touches a path, D4) groups and dedupes records by
`message.id`, classifies thinking-bearing (has a `thinking` block, blank or not) vs thinking-free,
pools every step's thinking-free responses into a single RUN-WIDE `calibrationRatio` computed ONCE
before the per-step loop, never per step (N4, this revision — a per-step ratio is unstable on a
thin sample; see Solution), falling every step in the run back to `mode: 'basic'` when the run has
zero free responses anywhere (never a `NaN`), and computes `bearingChars` inclusive of any
non-blank thinking-text length (D1) so `withheldThinkingTokens` collapses toward zero exactly when
nothing was actually withheld — for calibrated mode, where the transcript is still present (already
known to contain the main agent's own responses only, so it needs no separate child filter — see
Architecture). New `StepStats.tokenBreakdown` / `RunStats.totals` fields, including
`stepsWithoutBlockCounts`/`stepsNotCalibrated` (N5, this revision) on the totals aggregate. **This
phase's implementation must also correct `stats-cli.ts`'s module doc comment (D4)**, which
currently claims filesystem-only NDJSON reads and nothing else — false the moment this phase ships.

**Phase 3 — `cez run stats` prints it.** Extend `formatRunStats` (`stats.ts:693-760`) with a
breakdown block beside the existing batch-factor/model:exec lines: `narrationTokens`,
`toolArgTokens`, `thinkingTokens` (restored, D1 — printed as a plain measured figure, never
qualified "inferred"), `childToolArgTokens` (labeled "unbilled to this step" whenever nonzero),
`withheldThinkingTokens` (calibrated mode, clearly labeled "inferred") or `unclassifiedGapTokens`
(basic mode, clearly labeled "unattributed"), and an explicit opaque-blocks line only when
`opaqueBlocks` is defined and `> 0` — nothing printed, not a `0` line, when `opaqueBlocks` is
`undefined` (no turn in the step carried `blockCounts`, N2, this revision). Follows the existing
`row()`/`pad()` pattern; no new formatter primitive needed beyond what the module already has.
**(N7, this revision.)** The `calibration` diagnostic's own ratio line prints only when
`calibration.ratio` is defined — nothing, never `NaN`, for a step whose own free-response count is
zero; `calibration.appliedRatio` (and that step's `withheldThinkingTokens`) still print normally on
the same step whenever the run-wide pool produced one. **(N8, this revision.)** A step whose
`tokenBreakdown.mode === 'unavailable'` gets its own explicit branch: print `reportedTokens`
(always defined — see Data models) plus a single "breakdown unavailable — no tool/message events or
transcript for this step" line, never the narration/tool-args/thinking rows with a fake `0`.

**Phase 4 — the reconciliation test, tolerance derived not guessed, against a CI-safe fixture (N9,
this revision).** The tolerance/stability assertion cannot run against `70f19253`, or any other
archived run, at test time: `.ai/cezar/runs/` is gitignored (`.gitignore:11`), the Claude Code
transcript lives outside the repo under `~/.claude/projects/` on a retention window this spec does
not control (Architecture; Risks R3), and CI (`.github/workflows/ci.yml:48,51`) runs `npm run
test:unit` / `npm test` on a clean checkout with neither path present. A test that reads either
path passes only on this box and rots the moment Claude Code prunes the transcript — "eyeballed
once" with extra steps, the exact failure criterion 3 exists to prevent. So the derivation and the
committed test are two separate things, run once each:

- **One-time derivation against real archived transcripts — informs the fixture and `TOLERANCE`,
  is not itself the committed test.** Run Phase 2's calibrated-mode computation against several
  already-archived real transcripts (at minimum `70f19253`, plus 2-3 more from `.ai/cezar/runs/`
  with their matching `~/.claude/projects/` transcripts) using the shipped `gpt-tokenizer`, and
  record the observed `freeGapPct` — the thinking-free-subset gap. **That proxy's own arithmetic
  argues against a tight bound, not for one:** 2.126 chars/token (this spec's own hand-computed
  run-wide ratio) is markedly denser than a real BPE tokenizer produces on Bash commands and JSON
  tool arguments (typically ≈2.8–3.5 chars/token), which means the thinking-free responses in this
  run carry substantial per-response billed overhead that the visible text does not account for —
  plausibly a 25–35% `freeGapPct` once `gpt-tokenizer` runs over the same 80,295 free-response
  chars against the same 37,773-token ground truth, not the single-digit-to-low-teens figure a
  naive reading of "a real tokenizer should nearly fully explain usage.output" would suggest.
  Whatever this derivation actually measures is recorded with real numbers in this spec's status
  log (Verification §7/§8) — exactly as §8 already records the 39–63% thinking-share figure from
  the same kind of one-time, this-box-only derivation — never re-run by CI and never itself the
  assertion.
- **The committed test runs against a hand-authored, checked-in fixture, never a live transcript.**
  Author a new synthetic NDJSON + matching synthetic transcript pair under
  `src/core/__fixtures__/runs/` — a new pair, distinct from the existing `ec6e8e06-trimmed.ndjson`
  convention (`stats.test.ts:10-24`), which deliberately strips `item.input`/text payloads and
  carries only v1 `tool-call`/`tool-result` events, no v2 `item.*` events at all. This fixture must
  do the opposite — retain full text/JSON payloads and include v2 `item.*` + `turn.completed`
  events, since payload text is the one thing `freeGapPct` tokenizes — and its own doc comment
  must state that inversion explicitly, so a future reader doesn't assume it follows the
  `ec6e8e06` convention. Build its Bash-command / JSON-tool-arg / prose content to be
  representative of the shapes the one-time derivation above actually saw (proportions drawn from
  `70f19253`'s own tool-arg/narration mix), so it stands in for real content rather than an
  arbitrary string. `TOLERANCE` (or the stability band) is asserted against THIS fixture's own
  computed `freeGapPct`, with both the fixture's value and the real run's one-time-derived value
  recorded side by side in the test's doc comment:
  - **If the measured spread is tight (roughly ≤15%):** set `TOLERANCE` to comfortably bound the
    fixture's own `freeGapPct`, written down with the actual numbers in the test's comment, and
    assert `|freeGapPct| ≤ TOLERANCE` as a real accuracy claim.
  - **If the measured spread is wide (the more likely outcome per the arithmetic above):** the
    per-response billed overhead is real and not attributable to any single visible category, so a
    `TOLERANCE` wide enough to bound it would assert almost nothing — exactly the "eyeballed once"
    failure criterion 3 exists to prevent. In that case the test's content becomes a **stability /
    regression** assertion instead: `freeGapPct` computed against the committed fixture must stay
    within a narrow band (e.g. ±2 points) of its recorded value at the time Phase 4 ships, catching
    a future change to the tokenizer, the JSON-serialization path, or the transcript-join logic
    that silently shifts the number, without claiming the absolute figure is small.
  Either way, `TOLERANCE`, the branch actually taken, and both the fixture's and the real archived
  run's `freeGapPct` are recorded with real numbers in the test's own comment — never assumed from
  this paragraph's prediction.
The test then separately asserts that a fixture step with `opaqueBlocks > 0` produces a
*reported*, not silently-passing-or-failing, opaque line, and that a fixture step with
thinking-bearing responses reports `withheldThinkingTokens` rather than being folded into
`freeGapPct` or silently dropped — both built into the same fixture pair, or a small sibling
fixture alongside it.

**Phase 5 — verification on a new run (not a code phase).** Execute after Phases 1-4 ship: run a
new, comparable-shape chain (ideally another `spec-to-deploy` run), then `cez run stats <newRunId>`.
Use it to:
  a. Read `blockCounts`/`childBlockCounts` across every step — confirm, on a run recorded with the
     real mechanism rather than a manual transcript read, that `thinkingWithheld > 0` is common on
     whichever claude models the run actually used (this spec's own model-vs-blank table predicts
     this for opus/sonnet; if the run's per-step model policy, `a5f04b0f`,
     `workflows/types.ts:509-571`, ever routes a step to `haiku`, expect `thinking > 0` there
     instead — confirm the split tracks the model rather than being uniformly one or the other),
     and that `redactedThinking`/`serverToolUse`/`other` remain 0 (or, if not, that this is
     reported rather than silently absorbed). Also confirm `childBlockCounts` is populated only on
     steps that actually dispatched a sub-agent, and never bleeds into the parent's `blockCounts`
     (pins D2).
  b. Report the measured `withheldThinkingTokens` share (calibrated-mode steps) and compare it
     against this spec's own 39–63% range for `70f19253` — same order of magnitude expected, not a
     fresh guess.
  c. Recompute the idle-vs-output relationship (wall time not spent executing a tool, against
     `reportedTokens` per step) and check whether it lands near the cited 81.3 tok/s / R²=0.984.
     **Scope note:** this is a one-time verification calculation from fields Phase 2 already adds
     (`wallMs`, `toolExecMs`, `reportedTokens`) — it does not add a permanent regression/R²
     feature to `stats.ts`. If the owner wants that as a standing meter output, that is separate,
     unrequested scope and should be filed as its own follow-up, not folded in here.
  d. Write the result to the KB as a **dated addendum to `notion-cc6ebabb2ab4`** (per `CLAUDE.md`'s
     correction rule — that entry's own headline claims the opposite framing, "round-trip bound",
     and must be corrected in place, not left standing next to a new entry that quietly
     contradicts it) — state plainly that output-token volume, not round-trip count, is the
     stronger explanation for this workflow's wall clock, with the 39–63%/measured-run thinking
     share as supporting detail, and that the two entries describe the same symptom from different
     angles rather than one having been simply wrong.

## Risks

| # | Risk | Mitigation |
| --- | --- | --- |
| R1 | No public Claude tokenizer exists; `gpt-tokenizer`'s vocab is a stand-in, not a copy, so even perfect measurement of the right text will not zero out `freeGapPct`. | Named explicitly in Solution. `TOLERANCE` (Phase 4) is derived from real data using the shipped tokenizer, not the manual chars/token proxy this spec computed; the spec claims "measured, deterministic, reproducible," never "exact". |
| R2 | `withheldThinkingTokens` is an inference (subtraction against a calibration ratio), not a direct measurement — it could be mistaken for one if the printer or a consumer doesn't carry the label through. | `TokenBreakdown.withheldThinkingTokens` is named and documented as an inference in the type itself (Data models); Phase 3's printer must render it with an explicit "(inferred)" qualifier, not as a plain token count beside the measured `narrationTokens`/`toolArgTokens`. |
| R3 | Calibrated mode depends on the Claude Code session transcript still being present under `~/.claude/projects/` — a resource cezar does not own or control the retention of. | `mode: 'basic'` is the documented fallback (Data models, Architecture) — `unclassifiedGapTokens` still reports honestly, just without the thinking/noise split. `blockCounts` (Phase 1) is the durable, forward-only answer to "did thinking happen" that survives transcript pruning entirely. |
| R4 | Deriving usage from raw transcript records without deduping by `message.id` over-counts by ~2.5× (measured on `70f19253`: 940,963 vs 375,001) — the same bug class `stats.ts:21-38` already paid for twice. | Stated as a hard implementation rule in Data models, not left as an assumption; Phase 4's test fixtures should include a multi-record-per-response transcript sample specifically to catch a regression here. |
| R5 | `redacted_thinking` / `server_tool_use` content is permanently invisible by Anthropic's own design — no tokenizer, local or remote, can measure it, and it is a distinct phenomenon from blank-text `thinking`, which is common on some models (opus/sonnet) and absent on others (haiku, D1). | Reported as an explicit, separately-labeled `opaqueBlocks` count, never folded into or renamed "thinking"/"withheld thinking"/"thinkingWithheld". |
| R13 | (D1, new this revision.) The design could ship believing "thinking is unmeasurable for claude" as a permanent property, silently discarding real, visible reasoning text the moment a step runs on a model that doesn't withhold it (`claude-haiku-4-5`, confirmed non-blank in every sampled block on this box) — repeating, in the opposite direction, the exact kind of "assumed the wire shape instead of measuring it" mistake `stats.ts:21-38` already paid for twice. | `ClaudeBlockCounts.thinking`/`.thinkingWithheld` are two counters, not one, so the regime is visible per turn; `thinkingTokens` is a real measured field whenever `thinking > 0`; `withheldThinkingTokens` is computed only from the genuinely-blank subset. Phase 4's fixtures and Phase 5's verification (step a) both include a case where thinking is visible, not just the withheld case `70f19253` happened to show. |
| R14 | (D2, new this revision.) `blockCounts`, unfiltered, would tally a dispatched sub-agent's blocks against the parent step's `turn.completed` — a `usage.output` that never bills them — the same misattribution class already caught for tool-arg tokens (R12) but in a different function (`mapAssistant`'s block loop vs `stats.ts`'s replay), so fixing one does not fix the other. | `mapAssistant` branches on `parent_tool_use_id` before tallying, writing to `childBlockCounts` for a child frame; a mapper test with a `parent_tool_use_id` frame pins this (Verification §2). |
| R15 | (D3/D4, new this revision.) `computeRunStats`'s sync/pure contract could quietly break the moment someone "just adds" the transcript join where the diagram implies it belongs — inside `computeRunStats` itself — reintroducing an fs call into a function the rest of the module (and its tests) assume never blocks or throws on disk I/O. Separately, `stats-cli.ts`'s module doc and `sessionId`'s unvalidated use in a filesystem path could both go stale/unnoticed the same way the doc already did once. | `computeRunStats(runId, events, transcripts?)` — the seam is a parameter, not a convention to remember; `readRunStats` is the only function that touches `fs`. `stats-cli.ts`'s doc comment and `sessionId`'s `validRunId`-style guard are named as concrete edits in Phase 2, not left as prose to interpret later. |
| R16 | (N3, new this revision.) Phase 1's block tally could be correctly designed (D1/D2) yet silently lose data at the one place `mapAssistant` already special-cases: the `events.length === 0` early return (`claude-ui-mapper.ts:247-251`), which today carries forward only `lastMainAgentPromptTokens` and discards every other local accumulator. A frame whose only block is a blank `thinking`, a `redacted_thinking`, or a `server_tool_use` mints no item and hits this path — and a sub-agent frame is *especially* likely to, since `mainAgentPromptTokens` (`:264`) already returns `undefined` there, removing the one other thing that would otherwise keep `events` non-empty. | The tally accumulator is threaded through the early-return branch explicitly (Implementation-critical rules #4), not left to be "naturally" carried by the normal return path; a mapper test pins a `parent_tool_use_id` frame whose only block is blank `thinking` and asserts `childBlockCounts.thinkingWithheld` still increments (Verification §2). |
| R6 | `blockCounts` is forward-only from cezar's own NDJSON — cannot retroactively explain a pre-Phase-1 run *using that source alone*. | The transcript-join path (Architecture) is the retroactive substitute while transcripts survive; `opaqueBlocks` is left `undefined` (not a fake `0`, N2 this revision — a prior draft gestured at an undeclared `blockCountsAvailable` boolean instead of the field the type actually declares) on old steps, reading as "no wire-level signal", not "confirmed zero". |
| R7 | (Risk premise corrected, N8, this revision.) `'unavailable'` mode was framed around a non-claude backend, which doesn't hold: `codex-ui-mapper.ts`, `opencode-ui-mapper.ts`, and `pi-ui-mapper.ts` all emit `turn.completed` (`:240`/`:593`/`:223`) **and** `item.completed` including `kind: 'reasoning'` (`codex:616,776`/`opencode:297`/`pi:145`), so a non-claude step has a full v2 item stream and is fully measurable in basic mode — only `blockCounts` (claude-only) is absent for it, and that alone does not force `'unavailable'`. The real risk is narrower: a step with no `item.*` events at all. | `tokenBreakdown.mode` is `'unavailable'` whenever a step has no `item.*` events, regardless of whether a transcript exists for it (tightened, N9, this revision — see Architecture) — a transcript alone cannot produce `narrationTokens`/`toolArgTokens`/`thinkingTokens`, which are computed from `item.completed` text in every mode. `reportedTokens` (from `turn.completed.usage`, guaranteed to exist whenever `tokenBreakdown` itself does) stays required; `narrationTokens`/`toolArgTokens`/`childToolArgTokens`/`thinkingTokens`/`measuredTokens` become `undefined` (N8, this revision — were non-optional, contradicting this row's own "not a fake zero-filled object" claim) — same "undefined, never a fake 0" convention `peakContextTokens` already uses (`stats.ts:202-217`). |
| R8 | `JSON.stringify(item.input)`'s exact formatting (key order, whitespace) is a reconstruction, not necessarily byte-identical to whatever Claude actually streamed for the `tool_use` block's `input` — that difference itself shifts the tokenized count slightly. | Folded into the same `TOLERANCE` derivation (Phase 4) rather than treated as a separate unmodeled error source. |
| R9 | Averaging `freeGapPct`/`withheldThinkingTokens` shares across steps (rather than recomputing from summed totals) would silently misstate the run-level figure — the exact class of bug `stats.ts:202-217`'s peak-context correction was about. | `RunStats.totals`'s aggregate figures are defined as ratios of summed totals, not `mean(step.figure)` — stated explicitly in Data models. |
| R10 | Adding a tokenizer dependency to a CLI package increases install size / cold start for every `cezar` invocation, not just `run stats`. Weakened case, since the calibration ratio itself is derivable from chars/token without a tokenizer at all — but `gpt-tokenizer` still gives materially better precision than chars/token for the categories that ARE fully visible (narration, tool-args), which is what makes `freeGapPct` a meaningful measurement regardless of whether Phase 4 lands on a tight-tolerance or stability-band test (see Phase 4). | `gpt-tokenizer` (or whatever Phase 2 lands on) should be imported lazily inside the stats replay path, not at module top-level of anything on the CLI's hot path. If a reviewer judges the chars/token calibration ratio sufficient on its own (skipping the dependency entirely, at the cost of a wider, looser `TOLERANCE`), that is a legitimate simpler alternative to weigh before Phase 2 implementation starts. |
| R11 | Criterion 1 ("the run log carries the breakdown") could be read as "the NDJSON file must literally contain the numeric breakdown," which this design does not do — Phase 2's numbers are replay-computed, never persisted. | Read as "measurable from the stream," matching this module's own stated precedent (`stats.ts:16-19`, "replay an old recording with new arithmetic"). Flagged explicitly for the next review pass to confirm or override. |
| R12 | A dispatched sub-agent's tool calls appear in the same `item.completed` stream as the main agent's own, but `turn.completed.usage.output` never bills them — a design that tokenizes "every tool item.completed" without filtering silently inflates `measuredTokens` against a `reportedTokens` that never counted the child's tokens, breaking the reconciliation identity for a reason unrelated to thinking. Measured on `70f19253`: 93/360 tool completions, ≈10,067 tokens (2.7%). | `toolArgTokens` computed only over tool items with no `parentItemId`, filtered via `stats.ts`'s existing `ItemIndex.childIds` (`indexToolItems`, `stats.ts:341`); `narrationTokens`/`thinkingTokens` computed only over message/reasoning items with no `parentItemId`, filtered by reading the field directly since `childIds` does not index them (D5, this revision — see Data models). Child tokens reported separately as `childToolArgTokens`, explicitly labeled unbilled-to-this-step. Phase 4's fixtures include a `parentItemId` item specifically to pin this. |
| R17 | (N4, new this revision; risk numbers corrected, N6, this revision.) A per-step `calibrationRatio` is unstable on a thin free-response sample — measured on `70f19253` at the design's own per-`stepId` granularity, local ratios range 2.03–2.28 against the run-wide 2.126 (n=2–11 free responses per step, up to a 9.2% swing on the thinnest step) — and a step whose OWN free-response count is zero gives `calibrationRatio = 0/0 = NaN`, propagating into every downstream field and Verification §5's identity assertion. | `calibrationRatio` is computed once, RUN-WIDE, pooling every step's free responses before the per-step loop (Solution, Implementation-critical rule #5); a run with zero free responses anywhere falls every step back to `mode: 'basic'` instead of computing a ratio at all. Separately (N7, this revision): a step's own local `calibration.ratio` — diagnostic only, never what `withheldThinkingTokens` is actually computed from — is `ratio?: number`, undefined rather than `NaN` when that step's own `freeTokens === 0` (Data models). Verification §3 gains fixtures for the thin-sample case, the run-wide zero-free-response case, and the single-step zero-free-response case. |
| R18 | (N5, new this revision.) `RunStats.totals: Omit<StepStats, 'stepId' / 'restarts'>` (`stats.ts:278`) reuses the per-step `TokenBreakdown` shape for the run-level aggregate, so the "count of steps excluded" the totals comment already promised for `opaqueBlocks`/`withheldThinkingTokens`/`calibratedResidual` had nowhere to live, and `mode`/`freeGapPct`/`calibration`'s meaning on a mixed-mode run's totals was never stated. | `stepsWithoutBlockCounts`/`stepsNotCalibrated` are declared as real, optional `TokenBreakdown` fields — undefined on every per-step breakdown by construction, populated only on `RunStats.totals.tokenBreakdown` (Data models). Totals' `mode`/`freeGapPct`/`calibration` semantics are stated explicitly in the same comment block. |

## Analytics

No product-facing analytics event — this is an internal meter, same as the module it extends
(`stats.ts` has none today; `cez run stats` is a developer-facing CLI read, not a served UI). The
observable signal is the NDJSON transcript (and, for calibrated mode, the Claude Code session
transcript) itself, exactly as the existing batch-factor meter uses the NDJSON.

## Verification

1. **Typecheck** — `npm run typecheck`. **No `api-types.test.ts` change is expected or required**
   for `blockCounts`/`childBlockCounts`/`contextTokens` (see API contracts) — that file's one
   remaining guard doesn't cover this event shape, so this step only confirms the server-side
   change typechecks; the api-client mirror is a separate, manual edit called out in Phase 1, not
   something this gate verifies.
2. **Mapper unit tests** (`packages/cezar/src/core/claude-ui-mapper.test.ts`) — new cases:
   - The **real wire shape**: a turn built from several assistant frames, each carrying exactly
     ONE content block (confirmed as the live shape: `70f19253`'s transcript block-count histogram
     is `{1: 628}` across all 628 records — no frame ever carried more than one block), with
     `blockCounts` accumulating correctly across those frames and resetting at the next turn.
   - The **hand-written multi-block fixture** (`__fixtures__/claude/thinking-edit-write-todo.ndjson`)
     kept as a second case, since a single frame carrying `thinking`+`text`+`tool_use` together is
     not ruled out by anything in this spec's reading of the wire, just not observed live.
   - Non-blank `thinking` tallies into `blockCounts.thinking`; blank `thinking` tallies into
     `blockCounts.thinkingWithheld` (D1 — these are two counters, not one). `text`, `tool_use`,
     `redacted_thinking`, `server_tool_use` all tally correctly. Existing item-minting behavior
     (blank thinking mints no item, `redacted_thinking` mints nothing at all) must stay unchanged —
     this is additive counting, not a change to what becomes an item.
   - **A frame carrying `parent_tool_use_id` (D2, new this revision — the current draft's
     Verification had no such case despite Phase 1 processing every frame the mapper sees).** Its
     blocks must land in `childBlockCounts`, not `blockCounts`; a turn mixing a main-agent frame and
     a sub-agent frame in the same turn must keep the two tallies disjoint, and `blockCounts` alone
     must equal what the turn would have tallied had the sub-agent frame never occurred.
   - **The `events.length === 0` early-return path (N3, new this revision).** A `parent_tool_use_id`
     frame whose ONLY block is a blank `thinking` (mints no item, so the block loop produces zero
     `UiEvent`s and `mapAssistant` takes the early-return branch, `claude-ui-mapper.ts:247-251`)
     must still increment `childBlockCounts.thinkingWithheld` by one — pins that the tally survives
     the branch that today only preserves `lastMainAgentPromptTokens`. A main-agent frame with the
     same shape (blank `thinking` only) must equally still increment `blockCounts.thinkingWithheld`.
     Without this case, the bullet above would still pass with the bug live, since its own frames
     also carry a `tool_use` block that keeps `events` non-empty.
3. **Stats replay tests** (`packages/cezar/src/runs/stats.test.ts`) — `computeRunStats(runId,
   events, transcripts?)` exercised directly with a hand-built `transcripts` argument, no
   filesystem access in the test (D3 — pins the sync/pure seam); `TokenBreakdown` computed correctly
   in `'basic'` mode against a small fixture with known text/tool-input content and a known
   `usage.output`; `'calibrated'` mode against a small fixture pairing an NDJSON with a synthetic
   transcript (including a multi-record-per-response case, to pin the `message.id` dedupe rule from
   R4, **and a response with a non-blank `thinking` block, to pin that `thinkingTokens` is measured
   and `withheldThinkingTokens` collapses toward zero for that response — D1**); `'unavailable'`
   mode when neither v2 items nor a transcript exist for a step — asserts `reportedTokens` is still
   populated (from `turn.completed.usage`) while `narrationTokens`/`toolArgTokens`/
   `childToolArgTokens`/`thinkingTokens`/`measuredTokens` are all `undefined`, never a fake `0`
   (pins N8, this revision); `RunStats.totals` recomputes aggregate ratios
   from summed totals, not step-averaged (pins R9). **A fixture with at least one tool
   `item.completed` carrying a `parentItemId`** — its tokens must land in `childToolArgTokens`, be
   excluded from `toolArgTokens`/`measuredTokens`, and not appear in `reportedTokens`'s
   reconciliation at all (pins R12). **A fixture with a 'message' or 'reasoning' item.completed
   carrying a `parentItemId`** — same exclusion, but via the direct `item.parentItemId` read, not
   `ItemIndex.childIds` (pins D5; this case is new — revision 3's own citation of `childIds` for
   narration would have passed a test that only checked tool items, silently missing this path).
   `readRunStats`'s transcript glob rejects a `sessionId` that fails the `validRunId`-style
   character-class check rather than building a path from it (pins D4). **A fixture built from a
   pre-Phase-1 NDJSON** (`item.completed` events present, no turn ever carries
   `turn.completed.blockCounts`) **computes `opaqueBlocks === undefined`, never `0`** (pins N2, this
   revision — the field's prior non-optional declaration would have silently read `0` here). **A
   fixture with one step whose own free-response count is n=1, alongside other steps with larger
   samples** (pins N4, this revision) — `withheldThinkingTokens` for the thin step must be computed
   from the RUN-WIDE `calibrationRatio`, not that step's own local ratio; assert the step's
   `calibration.ratio` (its own local number) and `calibration.appliedRatio` (the run-wide number
   actually used) differ and that only the latter feeds `withheldThinkingTokens`. **A fixture where
   the run has ZERO thinking-free responses anywhere** (pins N4) — every step reports
   `mode: 'basic'`, `withheldThinkingTokens`/`calibration` are `undefined` for all of them, and
   nothing evaluates to `NaN`. **A fixture where one calibrated step's own free-response count is
   zero but the run-wide pool, drawn from other steps, is non-empty** (pins N7, this revision) —
   that step's own `calibration.ratio` is `undefined` while `calibration.appliedRatio` is defined
   and `withheldThinkingTokens` is computed from it normally, not `NaN`. **A `RunStats.totals`
   fixture with mixed per-step modes** (pins N5,
   this revision) — some steps `'calibrated'`, some `'basic'`, one missing `blockCounts` — asserts
   `totals.tokenBreakdown.stepsWithoutBlockCounts`/`.stepsNotCalibrated` count the excluded steps
   correctly, `totals.tokenBreakdown.mode` follows the `'calibrated'` > `'basic'` > `'unavailable'`
   precedence, and `totals.tokenBreakdown.freeGapPct`/`.calibration` are both `undefined` (never a
   fabricated run-level average).
4. **The reconciliation test** (Phase 4, N9 this revision) — computed against the committed,
   hand-authored, CI-safe fixture (`src/core/__fixtures__/runs/`, new pair, payloads retained, v2
   `item.*` events included — see Phase 4), never against `70f19253` or any live transcript, using
   the shipped `gpt-tokenizer`; asserts either `|freeGapPct| ≤ TOLERANCE` (if the fixture's
   measured spread turns out tight) or a stability band around the fixture's own recorded
   `freeGapPct` (if wide, the likelier outcome per this spec's own chars/token arithmetic — see
   Phase 4), with the branch actually taken and both the fixture's and the real archived run's
   `freeGapPct` recorded in the test's own comment, not asserted from this spec's prediction. The
   one-time derivation against real archived transcripts that picked the fixture's content and
   `TOLERANCE` runs once, on this box, with its numbers recorded in the status log (§7/§8) — it is
   not itself part of the committed, CI-runnable test. A separate assertion checks that a fixture
   with `opaqueBlocks > 0` reports a distinct labeled line, and that a fixture with
   thinking-bearing responses reports `withheldThinkingTokens` rather than folding into
   `freeGapPct`.
5. **`cez run stats <runId>` on a real archived run** — confirm the new breakdown block prints with
   the "(inferred)" qualifier on `withheldThinkingTokens` (pins R2) and `thinkingTokens` printed as
   a plain measured figure, never qualified "inferred" (pins D1). **The reconciliation identity is
   stated per mode, corrected this revision (N1) — it does not hold the same way in both, and a
   single blanket "holds by construction" claim across both modes was the defect:**
   - **Basic mode:** `narrationTokens + toolArgTokens + thinkingTokens + unclassifiedGapTokens ===
     reportedTokens` holds EXACTLY, by construction — `unclassifiedGapTokens` is *defined* as the
     residual `reportedTokens − measuredTokens`, so this checks only the printer's arithmetic, not
     measurement quality.
   - **Calibrated mode:** `narrationTokens + toolArgTokens + thinkingTokens + withheldThinkingTokens
     + calibratedResidual === reportedTokens` also holds exactly, but for the same definitional
     reason (`calibratedResidual` is declared precisely to close it — see Data models), and it is
     NOT the same claim as basic mode's identity: `withheldThinkingTokens` is a chars-ratio
     inference over a *different* text source (the transcript) than the BPE-tokenized
     `measuredTokens` (NDJSON `item.completed` text), so `calibratedResidual` is a genuine,
     expected-nonzero measurement of how far those two independent estimators disagree — not a
     rounding artifact to drive toward zero. This step asserts the identity holds (printer
     correctness) and separately prints `calibratedResidual` un-asserted, with no tolerance claimed
     on it — the tolerance claim Phase 4 actually makes is on `freeGapPct` alone (Verification §4),
     never on this identity.
   In both modes, **`childToolArgTokens` is deliberately NOT a term in this identity**: it is
   unbilled-to-this-step spend that `reportedTokens` never included, so it prints as its own
   separate line, not as a component of the reconciliation — and the opaque-blocks line appears
   only when `opaqueBlocks` is defined and `> 0` (N2, this revision) — never printed, not even as a
   `0` line, when `opaqueBlocks` is `undefined`.
6. **Full gate** — `npm test` and `npm run test:unit`, both clean.
7. **Phase 5, executed after 1-6 are green** — a new comparable-shape run, `cez run stats` on it,
   and the four checks in Phase 5 (a-d) recorded with their actual numbers in this spec's status
   log, not asserted from a prior run. This is what makes acceptance criterion 4 real: a NEW run,
   not a replay of `70f19253`.
8. **Baseline correction, already executed in this revision** — the corrected `70f19253` totals are
   **375,001 tokens / $38.33 / 8 step ids / 11 turns** (direct NDJSON sum, confirmed exact; the
   handoff's 307,118/$32.53/9-steps figures do not reconcile and are superseded by this number), and
   the thinking share for that same run is **39–63%** (transcript-based calibration, this revision,
   corroborating the handoff's 55–60% and the brief's 65.6% chars÷4 figure, not refuting either).
   Problem §2's baseline dispute is closed with these numbers now, ahead of any code shipping,
   using the transcript-join method (Architecture) as the audit trail. Phase 2's shipped
   `TokenBreakdown` computation should reproduce these same totals if run against `70f19253`'s real
   NDJSON and transcript — but that check stays a one-time, this-box-only derivation (N9, this
   revision — see Phase 4), never a committed CI test that reads this box's paths. The committed
   regression coverage for the reconciliation arithmetic lives in Verification §3's hand-built
   fixtures and Phase 4's synthetic fixture, the latter built specifically to reflect this run's
   real tool-arg/narration proportions (not listed as a separate numbered item because it is
   subsumed by those two).

## Status log — 2026-08-22

**Status: Phases 1-4 implemented, Phase 5 (new-run verification + KB write) NOT YET EXECUTED —
left for a later step, since it requires a NEW comparable-shape run after this code ships.**

**What landed:**

| Phase | Landed | Where |
| --- | --- | --- |
| 1 — wire tally | yes | `ClaudeBlockCounts` (`thinking`/`thinkingWithheld` split, D1) + `UiTurnCompletedEvent.blockCounts`/`.childBlockCounts` (D2) in `core/ui-events.ts` and the api-client mirror; tally + N3 early-return fix in `core/claude-ui-mapper.ts`'s `mapAssistant`/`mapResult` |
| 2 — basic + calibrated `TokenBreakdown` | yes | `runs/stats.ts`: `TokenBreakdown`/`TokenBreakdownMode`/`TranscriptResponse`/`Tokenize` types; `computeRunStats(runId, events, transcripts?, tokenize?)` (D3 seam); `parseTranscriptResponses` + the `~/.claude/projects/*/<sessionId>.jsonl` glob/join, `message.id` dedup (R4), `validSessionId` guard (D4) in `readRunStats` |
| 3 — `cez run stats` prints it | yes | `formatRunStats`'s new breakdown table + per-step annotation lines (withheld/unattributed/opaque/calibration-ratio), `'unavailable'`-mode branch (N8) |
| 4 — reconciliation test | yes | `stats.test.ts`; CI-safe fixture pair `core/__fixtures__/runs/token-breakdown-synthetic.{ndjson,*.jsonl}` |
| 5 — new-run verification (Phase 5a-d) | **pending** | needs a new `spec-to-deploy` run after this ships |

**Baseline reproduction (Verification §8) — the shipped code, not hand arithmetic, run against
`70f19253`'s real NDJSON + its still-present `~/.claude/projects/` transcripts:**

```
reportedTokens        375,001   (exact match to this spec's hand-derived baseline)
narrationTokens         13,931
toolArgTokens           138,162
childToolArgTokens        7,088   (93 sub-agent tool calls, unbilled to their parent step)
thinkingTokens                0   (0 non-blank reasoning items — opus-5/sonnet-5 both withhold)
measuredTokens          152,093
withheldThinkingTokens 144,033   → 144,033 / 375,001 = 38.4% of reportedTokens
calibratedResidual       78,875
stepsWithoutBlockCounts       8   (every step — turn.completed predates Phase 1, as expected)
stepsNotCalibrated             0   (every step's session transcript was still present)
```

38.4% sits essentially at the low edge of this spec's own hand-derived 39–63% thinking-share
range for this run (Solution/TLDR) — the ~0.6-point difference is transcript-record-level
precision (per-response classification) vs the coarser hand calibration, not a discrepancy
worth chasing. **The corrected baseline itself (375,001 tokens / $38.33 / 8 step ids / 11 turns,
superseding the handoff's 307,118/$32.53/9-steps) is CONFIRMED, to the token, by the shipped
`TokenBreakdown` computation — not just by the hand analysis that originally produced it.**

**Phase 4's `TOLERANCE`/stability-band derivation — real archived runs, real
`~/.claude/projects/` transcripts, real `gpt-tokenizer`, run once on this box:**

```
26 archived runs read via readRunStats() against their live transcripts (still present on this
  box at derivation time) — 20 of 26 had at least one 'calibrated' step
freeGapPct (thinking-free-subset gap) across every calibrated step of every run: 29.3% – 61.4%
freeGapPct on 70f19253 alone, across its 8 steps: 34.7% – 38.9%
```

A 32-point run-wide spread is WIDE, not tight (the spec's own ≤15% threshold for "tight" —
Phase 4), confirming the Solution section's chars/token-arithmetic prediction ("plausibly a
25–35% `freeGapPct`… not the single-digit-to-low-teens figure a naive reading would suggest").
**Phase 4's WIDE branch was taken**: the committed test asserts a ±2-percentage-point stability
band around the fixture's own recorded `freeGapPct` (36.9% for the fixture's clean/thinking-free
step, 36.5% for its opaque-blocks step), not an absolute-accuracy claim. Full derivation output
and the fixture-generation script's reasoning are preserved in this implementation step's own
transcript; the numbers above are what the fixture's content and target ratio were built from.

**Resume note for whoever runs Phase 5:** after this code is committed, pushed, and (per this
repo's standing deploy authorization) deployed, launch a new comparable-shape `spec-to-deploy`
run, then `cez run stats <newRunId>` and walk Phase 5's checklist (a-d) — read
`blockCounts`/`childBlockCounts` per step, compare the measured `withheldThinkingTokens` share
against this log's 38.4%/39–63% figures, recompute the idle-vs-output relationship against the
cited 81.3 tok/s / R²=0.984, and write a dated addendum to KB entry `notion-cc6ebabb2ab4` per
`CLAUDE.md`'s correction-in-place rule. None of this blocks shipping Phases 1-4; it is the
acceptance-criterion-4 verification that only a genuinely new run can provide.
