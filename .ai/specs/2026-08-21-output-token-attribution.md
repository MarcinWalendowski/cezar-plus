# A run's cost cannot be attributed — measure the thinking/text/tool-args split instead of guessing it

**Status:** DRAFT, revision 3 — written against brief `.ai/specs/briefs/2026-08-21-output-token-attribution.md`;
revised after a second review confirmed revision 2's empirical claims (reproduced exactly, see
"Revision note (r2→r3)" below) but found revision 2's `toolArgTokens`/`narrationTokens` definitions
mixed main-agent and sub-agent tool calls into one pool that `reportedTokens` never fully covers,
plus two smaller defects. Revisions 1 and 2 are preserved in the review transcripts only; this file
is the current draft.
**Date:** 2026-08-21. **Origin:** task *"A run's cost cannot be attributed - the log records total
output tokens but never thinking vs tool-args vs text"*, filed alongside three sibling tasks after
measuring run `70f19253-cf6b-407c-92e0-96a8020a8ebb` (`spec-to-deploy`, 2026-08-21, 85 min wall,
11 turns / 8 steps).

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

## TLDR

`turn.completed.usage.output` (`packages/cezar/src/core/claude-ui-mapper.ts:576`,
`rawTokenUsage` at `:626-639`) is one number per turn — the API's raw `output_tokens` for that
turn, already correctly summed across every internal API round trip inside it (`msg.usage` on the
final `result` frame is the CLI's own cross-call total; confirmed no double-counting risk there —
see Architecture). Nothing downstream knows what those tokens *were*.

**Claude's extended thinking is on, and its text is invisible by design — that is the central,
measured finding this spec is built around.** From `70f19253`'s own Claude Code session
transcripts (11 files, one per turn, joined deterministically by `sessionId` — see Architecture):

- **224 of 272 unique API responses (82%) carry a `thinking` content block.** All 224 have
  `thinking: ""` (blank) with a large `signature` field — Anthropic's documented shape for
  redacted/withheld thinking text that is still real, billed output.
- Splitting those 272 responses by shape and comparing recorded chars (text + `tool_use.input`
  JSON, exactly what a tokenizer would see) against each response's own `usage.output_tokens`
  gives a **thinking-free calibration ratio of 2.13 chars/token** (n=48 responses with no thinking
  block, 80,295 chars / 37,773 tokens — denser than a naive chars÷4 guess, confirming the
  handoff's chars÷4 method under-counts, but only by ~1.9×, not by enough to explain the residual
  away). Applying that ratio to all 490,974 recorded chars across the run (**transcript-derived —
  the main agent's own responses only**, per this revision's D1 fix; Phase 2's basic mode instead
  tokenizes NDJSON `item.completed` chars, which is a larger figure until it too is filtered to
  exclude sub-agent items, at which point the two should converge — see Data models/Architecture)
  and subtracting from the true total (375,001 tokens, re-derived below) leaves a **39% residual**;
  a conventional general-purpose BPE ratio (3.5 chars/token) gives **63%**. **Thinking is 39–63% of
  this run's output tokens — the handoff's 55–60% estimate is corroborated, not refuted.**

So the task is not "the residual is probably a undercounting artifact, go measure text/tool-args
precisely and the gap will close" (revision 1's hypothesis). It is: **thinking is real, it is the
single largest output-token category, Anthropic never reveals its text to anyone, and no tokenizer
— however good — can measure a quantity that was never on the wire.** What *can* be measured
precisely, with a real tokenizer, is the ~40–60% that *is* visible: assistant narration and
tool-call arguments. Measuring those precisely, then reporting the withheld remainder as an
honestly-labeled inference rather than folding it into a false "thinking exact count", is the
design this spec now targets.

**The fix is three complementary pieces, two of them independently shippable, the third
essentially free:**

- **Phase 1 (wire, forward-only, no dependency):** count raw content-block types at the one place
  in the codebase that still sees them before they're mapped or discarded
  (`mapAssistant`, `claude-ui-mapper.ts:161-247`), and carry the counts on `turn.completed`. This
  was already correctly designed in revision 1 to count *both* blank and non-blank `thinking`
  blocks (see Data models) — which turns out to be exactly the mechanism that would have caught
  this run's real shape, and is promoted here from a footnote to the headline durable signal:
  every future run gets a permanent, tokenizer-free answer to "did thinking happen, how often."
- **Phase 2 (retroactive, on any run whose transcript or NDJSON is still on disk):** tokenize the
  text/JSON that `item.completed` events already persist in full (`ui-event-sink.ts:99-104`) with
  a real BPE tokenizer for the two visible categories (narration, tool-args), and — where the
  Claude Code session transcript is still present — classify individual API responses as
  thinking-bearing or thinking-free (joined by `sessionId`, deduped by `message.id`; see
  Architecture) to calibrate and report the withheld category honestly, never as a tautological
  fourth bucket.
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
3. **Thinking is real, large, and permanently unmeasurable at the text level — the design has to
   say so honestly instead of reaching for a number that looks exact.** 82% of this run's API
   responses carry a `thinking` block; Anthropic never reveals that text to any client, so no local
   tokenizer, however accurate, can produce a true `thinkingTokens` count. A design that tokenizes
   `item.completed` "reasoning" text (as revision 1's formula did) will report **0** for a claude
   run forever, silently mislabeling the largest category as absent. The fix is not "measure it
   more precisely" — it is "measure what is visible precisely, and report what is invisible as an
   inference, honestly labeled as such, sized against a calibration ratio derived from the same
   run's own thinking-free responses" (see Solution).
4. **`turn.completed.usage.output` bills the main agent only — a breakdown over "every tool call"
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
| Two prior metering bugs in this exact module were caused by **assuming a wire spelling/attribution instead of measuring it** (`'Task'` vs `'Agent'`; billing a child's calls to the parent) | `stats.ts:21-38`, `.ai/specs/2026-08-21-sub-agent-fanout-adoption-and-attribution.md` | Direct precedent for this task's own risk class — and revision 3's review caught this design repeating the *exact same* "billed a child's calls to the parent" bug (Problem #4) before it shipped, plus a fourth instance of the class: naively summing `usage.output_tokens` per raw transcript record over-counts 2.5× because Claude Code's own transcript repeats one response's usage once per content-block record (see Architecture). |
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
- Todo `37f3ebf1` does not exist in any searchable form in this session (`cezar todo list` empty,
  no KB/spec hit) — its existence and scope are known only from the handoff's one paraphrased
  sentence, unchanged from revision 1.
- Whether Claude Code CLI requests extended thinking by some default outside `buildClaudeArgs`
  (a model-tier default, a harness-level flag not visible in this repo's source) remains not
  settled by static reading alone. It no longer needs to be, for this task's purposes: Phase 1's
  `blockCounts` and this revision's own transcript read already settle the *empirical* question
  ("does it happen, how often") without needing the *mechanism* question answered.

## Solution

**"Measured from the stream" now means two different things for two different categories, and the
design says so explicitly instead of blurring them into one number:**

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
   exclude any item with a `parentItemId`, using the same distinction `stats.ts` already computes
   for batch-factor accounting (`ItemIndex.childIds`, `indexToolItems`, `stats.ts:325-338`) — not a
   second, independently-maintained filter. Child items' tool-call tokens are real spend and are
   reported, just as their own explicitly-unbilled line (see Data models, `childToolArgTokens`),
   never folded into `measuredTokens`.
2. **Thinking is not measurable at the text level, ever, for claude.** Its content is withheld by
   Anthropic (`thinking: ""` + `signature`, confirmed above). No tokenizer, however accurate, can
   count text it never receives. The only honest move is to **infer its size by subtraction**,
   using a calibration ratio measured from the same run's own thinking-free responses — not a
   borrowed constant, not a guess — and to **label it as an inference**, never as a measured count.

### 1. Block-type occurrence counting at the wire (Phase 1) — unchanged from revision 1

`mapAssistant`'s block loop (`claude-ui-mapper.ts:180-245`) is the *only* place in the codebase
that still holds the raw Anthropic content block before it becomes an item or is silently dropped
(`:244`, `// Unknown block types (redacted_thinking, server_tool_use, …): ignored.`). Add a per-turn
tally there — `text`, `thinking` (regardless of blank/non-blank — this is the mechanism that
already anticipated this run's real shape, see Data models), `tool_use`, `redacted_thinking`,
`server_tool_use`, and `other` (any `raw.type` not in that list) — accumulated across every
assistant frame in the turn, flushed onto `turn.completed` in `mapResult`
(`claude-ui-mapper.ts:526-591`), and reset per turn.

This is a handful of counter increments inside a loop that already runs per block. No new
dependency, no latency added to a live run, no change to what gets persisted for existing item
types. It is **forward-only relative to cezar's own NDJSON**: `blockCounts` cannot retroactively
explain a run recorded before this ships *from that run's NDJSON alone*. It is, however, not the
only source of this information for a recent past run — see Architecture's transcript-join path,
which is how this revision measured `70f19253` itself without waiting for Phase 1 to exist.
`blockCounts` adds **durability**: the Claude Code session transcripts under `~/.claude/projects/`
are outside cezar's control, on a retention/pruning policy this repo does not own, while
`turn.completed.blockCounts` lives forever in cezar's own append-only NDJSON alongside everything
else `stats.ts` already reads.

### 2. Tokenized replay reconciliation, with the withheld category made honest (Phase 2 — reworked)

**Two data sources, not one.** Everything narration/tool-args needs is already persisted in
cezar's own NDJSON: message/reasoning item text via `item.completed` (`ui-event-sink.ts:99-104`),
tool-call arguments via the same events' `item.input` (`UiToolItem.input`, `ui-events.ts:193`),
and the ground truth `turn.completed.usage.output`. That is a **pure replay function**, following
the module's own stated precedent (`stats.ts:16-19`): read the NDJSON, tokenize the recorded
text, sum per category. **But `item.completed` events include sub-agent tool calls, and
`reportedTokens` does not** — so the NDJSON-derived `narrationTokens`/`toolArgTokens` computation
must first exclude any tool item with a `parentItemId`, using `stats.ts`'s own `ItemIndex.childIds`
(`indexToolItems`, `stats.ts:325-338`), the same index the batch-factor meter already builds for
this exact reason. Their tokenized total is reported separately as `childToolArgTokens` — real
spend, explicitly labeled unbilled-to-this-step, never merged into `measuredTokens` (see Data
models). Classifying *which individual API response* a chunk of narration/tool-args came from —
needed to separate the thinking-free calibration set from the thinking-bearing set — is not
something `item.completed` events carry (they are per-item, not per-response; one `turn` can span
dozens of internal API round trips, 24.7 on average across `70f19253`'s 11 turns). That
classification requires the **Claude Code session transcript**, joined by `sessionId` (see
Architecture) — the same file this revision read to produce the TLDR's numbers, and which already
contains only the main agent's own responses (a sub-agent's turns are billed and transcripted
separately, under its own `sessionId` — confirmed on `70f19253`: the joined transcript's 267
`tool_use` blocks match the 267 non-child items exactly, not the full 360), so the transcript-based
calibration below needs no additional filtering.

So Phase 2 runs in one of two modes, chosen automatically per step:

- **Basic mode** (transcript pruned or never captured, NDJSON only): tokenize narration and
  tool-args precisely, **excluding any tool item with a `parentItemId`** (reported separately as
  `childToolArgTokens`); report `measuredTokens`, `gapTokens = reportedTokens − measuredTokens`,
  `gapPct`; **no split of the gap into "withheld thinking" vs "tokenizer imprecision"** — it is
  reported as one labeled `unclassifiedGapTokens` line, honestly not attributed further.
- **Calibrated mode** (transcript still present): additionally read the joined transcript, dedupe
  its per-block records by `message.id` (Architecture — required, or usage over-counts 2.5×),
  classify each unique response as thinking-bearing (`blockCounts`-equivalent > 0 for that single
  response) or thinking-free, and compute:

  ```
  # over the step's turns, using the joined + deduped transcript records
  freeResponses      = responses with no thinking block
  freeChars           = Σ (text length + JSON.stringify(tool_use.input).length) over freeResponses
  freeTokens          = Σ usage.output_tokens over freeResponses      (ground truth for this subset)
  calibrationRatio    = freeChars / freeTokens                        (chars per token, this run's own)

  bearingResponses    = responses with ≥1 thinking block
  bearingChars        = Σ (text length + tool-input JSON length) over bearingResponses
  bearingTokens       = Σ usage.output_tokens over bearingResponses   (ground truth for this subset)
  expectedVisible      = bearingChars / calibrationRatio               (predicted narration+toolArgs tokens)
  withheldThinkingTokens = bearingTokens − expectedVisible             (signed; the inferred quantity)
  ```

  `narrationTokens` / `toolArgTokens` (tokenized precisely from non-child `item.completed` events,
  as in basic mode) still report the true, measured visible categories. `withheldThinkingTokens` is reported
  as its own explicitly labeled line — **"withheld thinking — inferred by subtraction using this
  run's own thinking-free calibration ratio"** — never merged into a fourth silent bucket, and
  never called "measured".

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
honestly as its own labeled, unattributed quantity if it ever occurs (0 in `70f19253`), never
folded into "thinking" or "withheld".

## Architecture

```
mapAssistant (claude-ui-mapper.ts)
  └─ per-block tally (thinking/text/tool_use/redacted_thinking/server_tool_use/other)
       │  accumulated in ClaudeUiMapperState, per turn
       ▼
mapResult → UiTurnCompletedEvent.blockCounts   (NEW field, Phase 1)
       │
       ▼  (persisted verbatim to NDJSON, like every other UiEvent)
runs/<id>.ndjson  ──────────────┐
       │                        │  session.started.sessionId (ui-events.ts:216) is the exact
       │ (replay, Phase 2)      │  string cezar passes to the CLI as --session-id / --resume
       ▼                        │  (claude-cli-runner.ts:709-716) — the CLI names its own
computeRunStats                 │  session transcript file after it. The join is therefore
  ├─ existing: batch factor,    │  BY CONSTRUCTION, not coincidence:
  │  model/exec/wall ms, sleep, │
  │  peak context (unchanged)   ▼
  └─ NEW: tokenizeStepBreakdown  glob ~/.claude/projects/*/<sessionId>.jsonl
       (item.completed +          (Claude Code's own transcript — one JSON record per raw
        turn.completed;           content block, NOT per API response: verified on 70f19253,
        + transcript join         628 records / 272 unique message.id, block-count histogram
        when available)           {1: 628} — every record repeats that response's full `usage`)
            │
            ▼
StepStats.tokenBreakdown?: TokenBreakdown
       │
       ▼
formatRunStats (stats.ts) / stats-cli.ts   → cez run stats prints the breakdown  (Phase 3)
```

Four things worth stating plainly, the first two corrected from revision 1:

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
  today. *Calibrated* mode additionally needs the joined transcript, which is only available while
  Claude Code has not pruned it — an unbounded but not indefinite window. `blockCounts` requires
  the run to have been recorded *after Phase 1 ships*, but then lives forever in cezar's own
  storage. A step computed without either source simply reports `tokenBreakdownMode: 'unavailable'`
  — never a fake zero.
- **`reportedTokens` is main-agent-only, and every measured category must be filtered to match, or
  the reconciliation identity breaks for a reason that has nothing to do with thinking.**
  `turn.completed.usage.output` covers only the API responses of the agent that owns the step —
  a dispatched sub-agent runs its own turns, billed to its own `turn.completed` under its own
  `sessionId`, never rolled into the parent's. Measured on `70f19253`: 93 of 360 tool
  `item.completed` events carry `parentItemId` (ran inside a sub-agent's window); the joined
  transcript contains exactly 267 `tool_use` blocks, matching the 267 non-child items, not 360.
  So `narrationTokens`/`toolArgTokens` — computed from `item.completed` — must exclude any item
  with a `parentItemId`, reusing `stats.ts`'s existing `ItemIndex.childIds`
  (`indexToolItems`, `stats.ts:325-338`; this is the mechanism the batch-factor meter already
  builds to answer the identical question, not a new one). The excluded child items' tokens are
  real spend and are reported as their own line (`childToolArgTokens`, Data models) — labeled
  explicitly as tokens the step's own `reportedTokens` never counted, not silently dropped.
- **Why not populate `TokenUsage.reasoning` (already declared, never used)?** Because the wire
  never reports a reasoning-only output count for claude (see Problem citations table) — there is
  nothing honest to assign to it from the mapper. `reasoning` stays reserved for a backend that
  *does* report it live. The new breakdown lives on `StepStats`/`RunStats`, computed at replay
  time, not on the wire `TokenUsage` type.

## Data models

**Wire contract addition (Phase 1) — `packages/cezar/src/core/ui-events.ts`, unchanged from
revision 1:**

```ts
/** Occurrence counts of raw Anthropic content-block types seen this turn, before mapping or
 *  discarding — claude only, absent for other backends and for any turn recorded before this
 *  field existed. Free to compute (no tokenizer): answers "did extended thinking / opaque
 *  billing happen at all" without persisting content that Anthropic itself never reveals
 *  (redacted_thinking's `data` field is intentionally not captured here or anywhere else). */
export interface ClaudeBlockCounts {
  text: number;
  /** Both blank and non-blank `thinking` blocks. On 70f19253, 224/272 responses (82%) carried a
   *  thinking block and ALL 224 were blank — proof this must not skip blank ones, or a run that
   *  emits only blank thinking (the common case, not a corner case) reads identically to a run
   *  that requests no thinking at all. */
  thinking: number;
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
  /** NEW. */
  blockCounts?: ClaudeBlockCounts;
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
   *  the child's spend in the first place. */
  reportedTokens: number;
  /** Tokenized text of every 'message' item.completed belonging to THIS agent (parentItemId
   *  absent — see reportedTokens). Measured, not inferred. */
  narrationTokens: number;
  /** Tokenized JSON.stringify(item.input) of every 'tool' item.completed with no parentItemId,
   *  PLUS item.started input for any such tool whose item.completed never arrived (aborted turn)
   *  or whose completed event lost its input (claude-ui-mapper.ts:454 state-loss path — 3/360 tool
   *  completions on 70f19253) — deduped by item id so a tool counted from item.started is not
   *  double-counted if item.completed does arrive with input. Filtered via the same
   *  ItemIndex.childIds stats.ts already computes (indexToolItems, stats.ts:325-338) — reuse it,
   *  don't rebuild it. Measured, not inferred. */
  toolArgTokens: number;
  /** Tokenized JSON.stringify(item.input) of tool item.completed/item.started events that DO carry
   *  a parentItemId — ran inside a sub-agent's own context window. Real spend, but never counted
   *  in reportedTokens (see above), so it is reported here as its own explicitly-unbilled-to-this-
   *  step line rather than folded into toolArgTokens or silently dropped. Measured on 70f19253: 93
   *  of 360 tool item.completed events, ≈10,067 tokens (2.7% of reportedTokens for this run). Zero
   *  for a step that dispatched nothing. */
  childToolArgTokens: number;
  /** narrationTokens + toolArgTokens. Deliberately excludes childToolArgTokens (unbilled to this
   *  step) and any thinking figure — see below. */
  measuredTokens: number;
  /** 'calibrated' mode only: bearingTokens − (bearingChars / calibrationRatio), i.e. the
   *  thinking-bearing subset's ground-truth usage minus its predicted visible-token cost.
   *  SIGNED. Labeled as an INFERENCE in every consumer (printer, docs) — never "thinkingTokens",
   *  which would imply a measured count that does not and cannot exist for claude. undefined in
   *  'basic'/'unavailable' mode. */
  withheldThinkingTokens?: number;
  /** 'basic' mode only: reportedTokens − measuredTokens, reported as ONE unattributed line —
   *  no attempt to split it into thinking vs tokenizer noise without the transcript's per-response
   *  classification. undefined in 'calibrated'/'unavailable' mode. */
  unclassifiedGapTokens?: number;
  /** 'calibrated' mode only: gap on the thinking-free response subset alone — the number Phase 4's
   *  test actually bounds. |freeGapPct| ≤ TOLERANCE is the falsifiable claim; NOT computed over
   *  thinking-bearing responses, where a gap is expected and reported via withheldThinkingTokens
   *  instead. undefined outside 'calibrated' mode. */
  freeGapPct?: number;
  /** Σ blockCounts.{redactedThinking,serverToolUse,other} over the step's turns. Unrelated to
   *  ordinary `thinking`, which is common and handled above — this is the genuinely opaque,
   *  never-reconstructable-even-approximately category. */
  opaqueBlocks: number;
  /** Present only in 'calibrated' mode — diagnostic, not asserted against in tests. */
  calibration?: { freeResponseCount: number; freeChars: number; freeTokens: number; ratio: number };
}

// StepStats gains:
tokenBreakdown?: TokenBreakdown;  // undefined when the step emitted no turn.completed at all —
                                   // same "undefined, never a fake 0" convention as peakContextTokens.

// RunStats.totals: reportedTokens / narrationTokens / toolArgTokens / childToolArgTokens /
// measuredTokens / opaqueBlocks all SUM across steps (additive, unlike peakContextTokens's max).
// withheldThinkingTokens sums only across steps that were themselves 'calibrated'; a run with
// mixed modes reports the sum plus the count of steps excluded, never silently averages partial
// data into the total.
```

**Implementation-critical rules, stated once and referenced everywhere they apply:**

1. Any code path that derives token usage from raw Claude Code transcript records
   (calibrated-mode classification) MUST dedupe by `message.id` before summing
   `usage.output_tokens` — never sum per content-block record. Measured over-count on `70f19253`
   from skipping this: 2.5× (940,963 vs the correct 375,001). This is the same bug class
   `stats.ts:21-38` already paid for twice.
2. Any code path that tokenizes `item.completed`/`item.started` events for `narrationTokens` or
   `toolArgTokens` MUST exclude items carrying a `parentItemId` (report them under
   `childToolArgTokens` instead), reusing `stats.ts`'s existing `ItemIndex.childIds`
   (`indexToolItems`, `stats.ts:325-338`) — never a second, independently-maintained parent/child
   check. Measured impact of skipping this on `70f19253`: 93/360 tool completions, ≈10,067 tokens
   (2.7% of `reportedTokens`) misattributed into a total the ground truth never counted. This is
   the same bug class `stats.ts:21-38` documents as "billed a child's tool calls to the parent."

## API contracts

None. `cez run stats` is a CLI/local read, not a served route — `packages/cezar/src/runs/stats-cli.ts`
calls `computeRunStats` directly against a local NDJSON file (and, for calibrated mode, a local
transcript file under `~/.claude/projects/`, read the same way — a local filesystem read, not a
network call). No `GET` endpoint changes. The `UiTurnCompletedEvent.blockCounts` addition widens
the wire event contract, and its client-side mirror lives at
`packages/api-client/src/protocol/ui-events.ts:172-179` (`UiTurnCompletedEvent`) — that file must
gain the same `blockCounts?: ClaudeBlockCounts` field, hand-edited, same as this file already
diverges from the server on `contextTokens` (added server-side, still absent from the mirror,
typecheck green regardless). **No automated test catches a missed field here.**
`packages/cezar/src/server/api-types.test.ts` — the only "parity" guard in the repo for this event
shape — pins exactly one thing: `Exact<RunEvent, WebRunEvent>` against the loose, index-signatured
`RunEvent` bag from `runs/store.ts`; its own doc explains the other 58 shape-by-shape guards were
retired in favor of route-derived contract checks, and `UiTurnCompletedEvent` was never one of the
two that stayed. So mirroring `blockCounts` (and, while touching this file, backfilling the
already-missing `contextTokens`) is a **manual step to perform and note in the phase's own PR
description**, not a test to satisfy. If the cockpit UI has no near-term plan to consume
`blockCounts`, that is a legitimate reason to skip the mirror — but skip it deliberately, stated as
such, not by omission.

## Phases

Phases 1 and 2 are independently shippable. Phase 3 depends on Phase 2's fields existing first
(it has nothing to print without them) — sequenced, not independent, despite reading like a
parallel deliverable.

**Phase 1 — block-type telemetry at the wire.** `ClaudeBlockCounts` type; tally in `mapAssistant`;
flush + reset in `mapResult`. Ships alone, gives every run recorded from here on a durable,
tokenizer-free answer to "did extended thinking / opaque billing happen, how often" — no longer a
hypothesis to test but a confirmed, common case this makes visible forever instead of only for as
long as `~/.claude/projects` happens to retain the transcript. **No contract-parity test gates
this** (see API contracts) — mirroring `blockCounts` into
`packages/api-client/src/protocol/ui-events.ts:172-179` is a manual step for this phase's PR to
perform and call out, not something `api-types.test.ts` will fail on if skipped.

**Phase 2 — tokenized replay reconciliation, basic + calibrated modes.** Add the tokenizer
dependency; `TokenBreakdown` type and its computation in `stats.ts`, reading non-child
`item.completed` + `turn.completed` per step for narration/tool-args (basic mode, works on any run
with v2 item events, including `70f19253` today) — filtering out any item with a `parentItemId`
via `stats.ts`'s existing `ItemIndex.childIds` (`indexToolItems`, `stats.ts:325-338`) and reporting
those separately as `childToolArgTokens` — plus a transcript-join helper (`sessionId` → glob
`~/.claude/projects/*/<sessionId>.jsonl` — the directory is not deterministically computable
(`70f19253` alone has three candidate project directories on this box: the worktree, a
`cez-root-lease` path, and a `cez-root-isolation` path), so the join globs and matches by filename,
never by re-deriving the slug — records grouped and deduped by `message.id`, classified
thinking-bearing vs thinking-free) for calibrated mode where the transcript is still present
(already known to contain the main agent's own responses only, so it needs no separate child
filter — see Architecture). New `StepStats.tokenBreakdown` / `RunStats.totals` fields.

**Phase 3 — `cez run stats` prints it.** Extend `formatRunStats` (`stats.ts:693-760`) with a
breakdown block beside the existing batch-factor/model:exec lines: `narrationTokens`,
`toolArgTokens`, `childToolArgTokens` (labeled "unbilled to this step" whenever nonzero),
`withheldThinkingTokens` (calibrated mode, clearly labeled "inferred") or `unclassifiedGapTokens`
(basic mode, clearly labeled "unattributed"), and an explicit opaque-blocks line when
`opaqueBlocks > 0`. Follows the existing `row()`/`pad()` pattern; no new formatter primitive
needed beyond what the module already has.

**Phase 4 — the reconciliation test, tolerance derived not guessed.** Before writing the assertion,
run Phase 2's calibrated-mode computation against several already-archived real transcripts (at
minimum `70f19253`, plus 2-3 more from `.ai/cezar/runs/` with their matching `~/.claude/projects/`
transcripts) and record the observed `freeGapPct` — the thinking-free-subset gap, using the
**shipped `gpt-tokenizer`**, not the manual 2.126 chars/token proxy this spec computed by hand.
**That proxy's own arithmetic argues against a tight bound, not for one:** 2.126 chars/token is
markedly denser than a real BPE tokenizer produces on Bash commands and JSON tool arguments
(typically ≈2.8–3.5 chars/token), which means the thinking-free responses in this run carry
substantial per-response billed overhead that the visible text does not account for — plausibly a
25–35% `freeGapPct` once `gpt-tokenizer` runs over the same 80,295 free-response chars against the
same 37,773-token ground truth, not the single-digit-to-low-teens figure a naive reading of "a real
tokenizer should nearly fully explain usage.output" would suggest. Phase 4 must handle both
outcomes explicitly, not assume the optimistic one:
  - **If the measured spread is tight (roughly ≤15%):** set `TOLERANCE` to comfortably bound it,
    written down with the actual numbers in the test's comment, and assert `|freeGapPct| ≤ TOLERANCE`
    as a real accuracy claim.
  - **If the measured spread is wide (the more likely outcome per the arithmetic above):** the
    per-response billed overhead is real and not attributable to any single visible category, so a
    `TOLERANCE` wide enough to bound it would assert almost nothing — exactly the "eyeballed once"
    failure criterion 3 exists to prevent. In that case the test's content becomes a **stability /
    regression** assertion instead: `freeGapPct` computed against a fixed, archived run (`70f19253`)
    must stay within a narrow band (e.g. ±2 points) of its recorded value at the time Phase 4 ships,
    catching a future change to the tokenizer, the JSON-serialization path, or the transcript-join
    logic that silently shifts the number, without claiming the absolute figure is small. Either
    way, `TOLERANCE` and the branch actually taken are recorded with real numbers in the test's own
    comment — never assumed from this paragraph's prediction.
The test then separately asserts that a step/fixture with `opaqueBlocks > 0` produces a *reported*,
not silently-passing-or-failing, opaque line, and that a step with thinking-bearing responses
reports `withheldThinkingTokens` rather than being folded into `freeGapPct` or silently dropped.

**Phase 5 — verification on a new run (not a code phase).** Execute after Phases 1-4 ship: run a
new, comparable-shape chain (ideally another `spec-to-deploy` run), then `cez run stats <newRunId>`.
Use it to:
  a. Read `blockCounts` across every step — confirm, on a run recorded with the real mechanism
     rather than a manual transcript read, that `thinking > 0` is common (this revision's own
     measurement predicts ~most turns, per-step model policy landed in `a5f04b0f`,
     `workflows/types.ts:509-571`, permitting), and that `redactedThinking`/`serverToolUse`/`other`
     remain 0 (or, if not, that this is reported rather than silently absorbed).
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
| R5 | `redacted_thinking` / `server_tool_use` content is permanently invisible by Anthropic's own design — no tokenizer, local or remote, can measure it, and it is a distinct phenomenon from ordinary (blank-text) `thinking`, which this revision found is common and now well understood. | Reported as an explicit, separately-labeled `opaqueBlocks` count, never folded into or renamed "thinking"/"withheld thinking". |
| R6 | `blockCounts` is forward-only from cezar's own NDJSON — cannot retroactively explain a pre-Phase-1 run *using that source alone*. | The transcript-join path (Architecture) is the retroactive substitute while transcripts survive; `blockCountsAvailable` (or `mode !== 'calibrated'`) on old steps reads as "no wire-level signal", not "confirmed zero". |
| R7 | A step with turns from a non-claude backend (codex/opencode) has no `blockCounts` and a different usage shape. | `tokenBreakdown.mode` is `'unavailable'`, not a fake zero-filled object — same convention `peakContextTokens` already uses (`stats.ts:202-217`). |
| R8 | `JSON.stringify(item.input)`'s exact formatting (key order, whitespace) is a reconstruction, not necessarily byte-identical to whatever Claude actually streamed for the `tool_use` block's `input` — that difference itself shifts the tokenized count slightly. | Folded into the same `TOLERANCE` derivation (Phase 4) rather than treated as a separate unmodeled error source. |
| R9 | Averaging `freeGapPct`/`withheldThinkingTokens` shares across steps (rather than recomputing from summed totals) would silently misstate the run-level figure — the exact class of bug `stats.ts:202-217`'s peak-context correction was about. | `RunStats.totals`'s aggregate figures are defined as ratios of summed totals, not `mean(step.figure)` — stated explicitly in Data models. |
| R10 | Adding a tokenizer dependency to a CLI package increases install size / cold start for every `cezar` invocation, not just `run stats`. Weakened case, since the calibration ratio itself is derivable from chars/token without a tokenizer at all — but `gpt-tokenizer` still gives materially better precision than chars/token for the categories that ARE fully visible (narration, tool-args), which is what makes `freeGapPct` a meaningful measurement regardless of whether Phase 4 lands on a tight-tolerance or stability-band test (see Phase 4). | `gpt-tokenizer` (or whatever Phase 2 lands on) should be imported lazily inside the stats replay path, not at module top-level of anything on the CLI's hot path. If a reviewer judges the chars/token calibration ratio sufficient on its own (skipping the dependency entirely, at the cost of a wider, looser `TOLERANCE`), that is a legitimate simpler alternative to weigh before Phase 2 implementation starts. |
| R11 | Criterion 1 ("the run log carries the breakdown") could be read as "the NDJSON file must literally contain the numeric breakdown," which this design does not do — Phase 2's numbers are replay-computed, never persisted. | Read as "measurable from the stream," matching this module's own stated precedent (`stats.ts:16-19`, "replay an old recording with new arithmetic"). Flagged explicitly for the next review pass to confirm or override. |
| R12 | A dispatched sub-agent's tool calls appear in the same `item.completed` stream as the main agent's own, but `turn.completed.usage.output` never bills them — a design that tokenizes "every tool item.completed" without filtering silently inflates `measuredTokens` against a `reportedTokens` that never counted the child's tokens, breaking the reconciliation identity for a reason unrelated to thinking. Measured on `70f19253`: 93/360 tool completions, ≈10,067 tokens (2.7%). | `narrationTokens`/`toolArgTokens` computed only over items with no `parentItemId`, filtered via `stats.ts`'s existing `ItemIndex.childIds` (`indexToolItems`, `stats.ts:325-338`); child tokens reported separately as `childToolArgTokens`, explicitly labeled unbilled-to-this-step (Data models). Phase 4's fixtures include a `parentItemId` item specifically to pin this. |

## Analytics

No product-facing analytics event — this is an internal meter, same as the module it extends
(`stats.ts` has none today; `cez run stats` is a developer-facing CLI read, not a served UI). The
observable signal is the NDJSON transcript (and, for calibrated mode, the Claude Code session
transcript) itself, exactly as the existing batch-factor meter uses the NDJSON.

## Verification

1. **Typecheck** — `npm run typecheck`. **No `api-types.test.ts` change is expected or required**
   for `blockCounts`/`contextTokens` (see API contracts) — that file's one remaining guard doesn't
   cover this event shape, so this step only confirms the server-side change typechecks; the
   api-client mirror is a separate, manual edit called out in Phase 1, not something this gate
   verifies.
2. **Mapper unit tests** (`packages/cezar/src/core/claude-ui-mapper.test.ts`) — new cases:
   - The **real wire shape**: a turn built from several assistant frames, each carrying exactly
     ONE content block (confirmed as the live shape: `70f19253`'s transcript block-count histogram
     is `{1: 628}` across all 628 records — no frame ever carried more than one block), with
     `blockCounts` accumulating correctly across those frames and resetting at the next turn.
   - The **hand-written multi-block fixture** (`__fixtures__/claude/thinking-edit-write-todo.ndjson`)
     kept as a second case, since a single frame carrying `thinking`+`text`+`tool_use` together is
     not ruled out by anything in this spec's reading of the wire, just not observed live.
   - Blank AND non-blank `thinking`, plus `tool_use`, `redacted_thinking`, `server_tool_use` all
     tally correctly. Existing item-minting behavior (blank thinking mints no item, `redacted_thinking`
     mints nothing at all) must stay unchanged — this is additive counting, not a change to what
     becomes an item.
3. **Stats replay tests** (`packages/cezar/src/runs/stats.test.ts`) — `TokenBreakdown` computed
   correctly in `'basic'` mode against a small fixture with known text/tool-input content and a
   known `usage.output`; `'calibrated'` mode against a small fixture pairing an NDJSON with a
   synthetic transcript (including a multi-record-per-response case, to pin the `message.id` dedupe
   rule from R4); `'unavailable'` mode when neither v2 items nor a transcript exist; `RunStats.totals`
   recomputes aggregate ratios from summed totals, not step-averaged (pins R9). **A fixture with at
   least one tool `item.completed` carrying a `parentItemId`** — its tokens must land in
   `childToolArgTokens`, be excluded from `narrationTokens`/`toolArgTokens`/`measuredTokens`, and
   not appear in `reportedTokens`'s reconciliation at all (pins R12/D1).
4. **The reconciliation test** (Phase 4) — computed against real archived transcripts' thinking-free
   response subsets using the shipped `gpt-tokenizer`; asserts either `|freeGapPct| ≤ TOLERANCE`
   (if the measured spread turns out tight) or a stability band around a fixed archived run's
   recorded `freeGapPct` (if wide, the likelier outcome per this spec's own chars/token arithmetic
   — see Phase 4), with the branch actually taken and its real numbers recorded in the test's own
   comment, not asserted from this spec's prediction; a separate assertion that a fixture with
   `opaqueBlocks > 0` reports a distinct labeled line, and that a fixture with thinking-bearing
   responses reports `withheldThinkingTokens` rather than folding into `freeGapPct`.
5. **`cez run stats <runId>` on a real archived run** — confirm the new breakdown block prints with
   the "(inferred)" qualifier on `withheldThinkingTokens` (pins R2), the arithmetic identity
   `narrationTokens + toolArgTokens + withheldThinkingTokens(calibrated) or unclassifiedGapTokens(basic)
   + gapTokens(residual, if any) === reportedTokens` holds by construction (checks the printer's
   math, not measurement quality) — **`childToolArgTokens` is deliberately NOT a term in this
   identity**: it is unbilled-to-this-step spend that `reportedTokens` never included, so it prints
   as its own separate line, not as a component of the reconciliation — and the opaque-blocks line
   appears only when `opaqueBlocks > 0`.
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
   using the transcript-join method (Architecture) as the audit trail — Phase 2's shipped
   `TokenBreakdown` computation should reproduce these same totals for `70f19253` once it exists,
   which is itself a regression check worth adding to Phase 2's test suite (not listed as a
   separate numbered item because it is subsumed by Verification §3's fixture tests using this
   run's real numbers as the fixture).
