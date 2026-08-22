# A run's cost cannot be attributed — measure the thinking/text/tool-args split instead of guessing it

**Status:** DRAFT — written against brief `.ai/specs/briefs/2026-08-21-output-token-attribution.md`.
**Date:** 2026-08-21. **Origin:** task *"A run's cost cannot be attributed - the log records total
output tokens but never thinking vs tool-args vs text"*, filed alongside three sibling tasks after
measuring run `70f19253-cf6b-407c-92e0-96a8020a8ebb` (`spec-to-deploy`, 2026-08-21, 85 min wall,
11 turns / 8 steps).

## TLDR

`turn.completed.usage.output` (`packages/cezar/src/core/claude-ui-mapper.ts:581`,
`rawTokenUsage` at `:622-637`) is one number per turn — the API's raw `output_tokens`, unweighted.
Nothing downstream knows what those tokens *were*. The task's own handoff estimated the split by
guessing chars÷4 over already-recorded text, landed on "thinking ~55-60%, pure residual, never
measured," and flagged that figure as too load-bearing to leave ungrounded.

**Investigating that estimate turned up a stronger, falsifiable story than "go measure it more
precisely": the estimate is very likely measuring the wrong thing.** Two facts, both cited in the
brief and re-verified below, point the same way:

1. `kind:"reasoning"` items — which the mapper **already** turns non-blank `thinking` blocks into
   and persists in full (`claude-ui-mapper.ts:190-194`, live since #528) — occur **zero** times in
   the entire 85-minute, 11-turn run the estimate was built from. If Claude had emitted one
   non-blank `thinking` block, it would be on disk right now, in full text, already tokenizable.
   It is not.
2. `buildClaudeArgs` (`claude-cli-runner.ts:691-724`) passes no thinking-related flag at all —
   nothing requests extended thinking for any cezar run today.

So the leading hypothesis this spec is built to test, not assume: **the 55-60% "thinking" residual
is chars÷4 under-counting real text and tool-call JSON** (a crude ÷4 divisor undercounts
punctuation-dense, code-shaped content), not a hidden reasoning cost. A *real* tokenizer applied to
the text/JSON already sitting in every `item.completed` event should close most of that gap on its
own, with no new capture needed. What a real tokenizer cannot do is see `redacted_thinking` /
`server_tool_use` blocks — Anthropic bills them as output but cezar's mapper drops them so
completely that not even their occurrence is on disk (`claude-ui-mapper.ts:244`,
`claude-ui-mapper.test.ts:101`). This spec adds a free, tokenizer-free counter for exactly that, so
"did opaque billing happen at all" stops being a guess.

**The fix is two independent, differently-shaped changes:**

- **Phase 1 (wire, forward-only, no dependency):** count raw content-block types at the one place
  in the codebase that still sees them before they're mapped or discarded
  (`mapAssistant`, `claude-ui-mapper.ts:161-247`), and carry the counts on `turn.completed`. This
  settles, for every future run, whether `thinking`/`redacted_thinking` happen at all — something
  no existing run's NDJSON can answer.
- **Phase 2 (replay, retroactive on every run with v2 items):** tokenize the text/JSON that
  `item.completed` events already persist in full (`ui-event-sink.ts:99-104` — every completed
  item is snapshotted, never coalesced) with a real BPE tokenizer, and reconcile the sum against
  `turn.completed.usage.output`. This needs a new dependency (none exists today — confirmed by
  `grep` across every `package.json`) but no new capture: it runs against NDJSON already on disk.

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
   not the handoff's "307,118 tokens" / "$32.53" / "9 completed steps". Applying the handoff's own
   chars÷4 method to this file's actual text/tool-input character counts gives 65.6% residual, same
   order of magnitude as the claimed 55-60% but not the same total. **A test asserting "output
   dropped 40%" needs a trustworthy baseline before it can assert anything.**
3. **The estimate's vocabulary may be wrong, not just its precision.** See TLDR — 0 reasoning items
   in the source run, 0 thinking-related flags anywhere in `buildClaudeArgs`. Building "measure
   thinking better" without first checking whether thinking happens at all risks shipping precise
   machinery pointed at a near-zero quantity while the real gap (undercounted text/tool-args, and
   possibly opaque `redacted_thinking`) goes unmeasured under a wrong label.

### What the record already decided (citations)

| Decision | Where | Bearing here |
| --- | --- | --- |
| Output tokens, not round trips or tool execution, are what a step's wall clock is spent on | this task's handoff; KB `notion-cc6ebabb2ab4` ("cezar production is not slower per round trip…", 2026-08-21) — item 3 of its "what to do" list is `--include-partial-messages` + `stream_event` → `item.delta`, matching the sibling todo `37f3ebf1` the handoff cites | The framing this task is justified by. Not contradicted by anything found here. |
| `computeRunStats` is filesystem-only, replay-only, computed on demand, **nothing persisted** | `stats.ts:6-19` | Sets the shape this change takes: new fields on `StepStats`/`RunStats`, no store/contract-parity change. |
| Two prior metering bugs in this exact module were caused by **assuming a wire spelling/attribution instead of measuring it** (`'Task'` vs `'Agent'`; billing a child's calls to the parent) | `stats.ts:21-38`, `.ai/specs/2026-08-21-sub-agent-fanout-adoption-and-attribution.md` | Direct precedent for this task's own risk: assuming "residual = thinking" without checking the wire is the same class of mistake. |
| `TokenUsage.reasoning?: number` exists in the wire contract, typed, documented, **never populated** for claude | `ui-events.ts:100-110`; `claude-ui-mapper.ts:622-637` | The wire has literally nowhere to report a reasoning-only output count even if we wanted to populate it live — `result.usage.output_tokens` is one number covering every block type in the turn (verified against the `thinking-edit-write-todo` fixture: a single assistant frame with `thinking` + `text` + `tool_use` blocks carries one shared `usage.output_tokens`). A breakdown can only ever be a **replay-time reconstruction**, not a wire-reported figure — this rules out ever populating `reasoning` from the mapper directly (see Architecture). |
| `--include-partial-messages` is documented as the intended source of streamed deltas but is **not enabled** | `.ai/analysis/cockpit-ui-redesign/agent-event-protocols.md:54`; confirmed — zero occurrences in `buildClaudeArgs` | The sibling todo (`37f3ebf1`) this task's handoff cites. **Not found** in `cezar todo list` (empty), `cez kb search`, or any spec/KB text in this repo — its existence and scope are known only from the handoff's one paraphrased sentence. Streaming deltas would let text/thinking be counted as they arrive, but does not by itself solve tool-arg attribution or the opaque-block problem this spec is built around, so this spec does not depend on it. |
| Peak-context and other usage numbers are **per-window, never summed across steps** — a rule already burned once | `stats.ts:202-214`; commit `f65ccdde` | Caution for aggregation: sum where additive (raw output tokens, tool-arg tokens), never max-vs-sum confusion. |

### What I could not find (unchanged from the brief, re-checked)

- No KB entry or spec anywhere proposes a token-category breakdown, a tokenizer choice, or a
  `usage.output` reconciliation test — `cez kb search`, `.ai/specs/`, and `git log` all confirm
  this. **There is no existing curated corpus entry stating a "55-60% thinking" figure to correct.**
  The closest related entry, `notion-cc6ebabb2ab4`, records the output-token-bound framing and the
  `--include-partial-messages` recommendation but makes no thinking-share claim. Acceptance
  criterion 4's "correct the corpus entry in place if refuted" therefore has no pre-existing target
  — this spec's own Verification §5 is the first curated record of a *measured* figure, and Phase 5
  below is where it gets written down. If a later search turns up a hidden prior claim, that must be
  corrected in place per `CLAUDE.md`'s correction rule instead of left standing.
- Todo `37f3ebf1` does not exist in any searchable form in this session (see table above).
- Whether Claude Code CLI silently requests extended thinking by some default this repo's own
  source can't show (e.g., a model-tier default outside `buildClaudeArgs`) is **not fully settled**
  by static reading alone — Phase 1's counters are what finally settle it empirically, on a live
  run, for good.

## Solution

**"Measured from the stream" means: tokenize the exact text/JSON the run already emitted, with a
real tokenizer, rather than guess a ratio from character counts.** It does not mean the Anthropic
API hands back a native per-category token count — it doesn't. `result.usage.output_tokens` is one
number per turn covering every block type together (confirmed against the mapper's own test
fixture, `__fixtures__/claude/thinking-edit-write-todo.ndjson:2`: a single assistant frame with
`thinking`+`text`+`tool_use` blocks carries one shared `usage.output_tokens`). So a breakdown is
necessarily a **local reconstruction**: real, deterministic, reproducible — not a heuristic ratio —
but not byte-identical to whatever Anthropic's own (undisclosed) tokenizer counted internally. The
spec makes this precision boundary explicit rather than overclaiming exactness, per Open Question 2
in the brief.

**Two components, independently shippable:**

### 1. Block-type occurrence counting at the wire (Phase 1)

`mapAssistant`'s block loop (`claude-ui-mapper.ts:180-245`) is the *only* place in the codebase
that still holds the raw Anthropic content block before it becomes an item or is silently dropped
(`:244`, `// Unknown block types (redacted_thinking, server_tool_use, …): ignored.`). Add a per-turn
tally there — `text`, `thinking` (regardless of blank/non-blank, so this differs from the
item-minting rule at `:190`, which skips blank thinking), `tool_use`, `redacted_thinking`,
`server_tool_use`, and `other` (any `raw.type` not in that list) — accumulated across every
assistant frame in the turn, flushed onto `turn.completed` in `mapResult`
(`claude-ui-mapper.ts:526-591`), and reset per turn.

This is a handful of counter increments inside a loop that already runs per block. No new
dependency, no latency added to a live run, no change to what gets persisted for existing item
types. It is **forward-only**: it cannot retroactively explain `70f19253` or any other
already-recorded run, because the raw block type was never on the wire for those NDJSON files to
begin with (Open Question in the brief, §"What I could not find" above). Every run recorded after
this ships gets the counter; nothing before it can be backfilled.

### 2. Tokenized replay reconciliation (Phase 2)

Every input this needs is **already persisted**: message/reasoning item text via `item.completed`
(`ui-event-sink.ts:99-104` — always snapshotted, never coalesced or dropped), tool-call arguments
via the same events' `item.input` (`UiToolItem.input`, `ui-events.ts:193`), and the ground truth
`turn.completed.usage.output`. So this is a **pure replay function** added to `stats.ts`, following
the module's own stated precedent exactly (`stats.ts:16-19`): read the NDJSON, tokenize the
recorded text with a real tokenizer, sum per category, compare against `usage.output`.

**Tokenizer choice.** No tokenizer dependency exists anywhere in this repo today (checked: `grep`
for `tiktoken`/`gpt-tokenizer`/`@anthropic-ai` across every `package.json` and `package-lock.json`
returns zero hits). Claude's own BPE vocabulary is undisclosed, so no tokenizer will match
Anthropic's internal count exactly. The practical choice is `gpt-tokenizer`
(pure JS/ESM, no native binding, no network call, widely used as a consistent stand-in for
non-OpenAI models when the vendor's own vocab isn't public) — real, deterministic, and reproducible,
which is what "measured, not estimated" requires, while being explicit that it is an
**approximation of Claude's tokenizer, not a copy of it**. This is a design decision the spec is
flagging for review, not a settled fact — if the reviewing step knows of a closer stand-in already
vetted elsewhere in this workspace, that should replace this choice before implementation.

**Reconciliation, precisely — the part that makes criterion 3 a real test and not a tautology.**
Define, per step:

```
narrationTokens = Σ tokenize(item.text)              over 'message' item.completed events
thinkingTokens  = Σ tokenize(item.text)              over 'reasoning' item.completed events
toolArgTokens   = Σ tokenize(JSON.stringify(item.input)) over 'tool' item.completed events
measuredTokens  = narrationTokens + thinkingTokens + toolArgTokens
reportedTokens  = Σ turn.completed.usage.output       over the step's turns
gapTokens       = reportedTokens − measuredTokens                    (signed — can be negative)
gapPct          = reportedTokens === 0 ? 0 : gapTokens / reportedTokens × 100
opaqueBlocks    = Σ blockCounts.{redactedThinking, serverToolUse, other}  over the step's turns
```

`gapTokens` is **not** folded into a fourth "unattributed" bucket that always exists by
construction — that would make "components sum to usage.output" true by definition regardless of
measurement quality, which is the tautology the acceptance criteria is guarding against. Instead:

- On a step where `opaqueBlocks === 0`, `gapPct` is the actual thing being tested — it should be
  small, and the reconciliation test (Phase 4) asserts `|gapPct| ≤ TOLERANCE` for exactly this
  case. This is the falsifiable claim: real tokenization of real text should nearly fully explain
  `usage.output` once no opaque blocks are involved.
- On a step where `opaqueBlocks > 0`, a larger `gapPct` is expected and reported as its own labeled
  line — `N opaque blocks (redacted_thinking/server_tool_use/other), ~gapTokens tokens` — rather
  than being asserted small or silently blended into the same number as tokenizer noise. This
  directly answers Open Question 3 in the brief: an opaque bucket is reported honestly as opaque,
  sized by subtraction (the only way it can be sized, since its content is never revealed), and
  never relabeled "thinking."

`TOLERANCE` is **not invented here** — Phase 4 requires deriving it from real archived transcripts
before it is hardcoded into a test (see Phases and Verification).

## Architecture

```
mapAssistant (claude-ui-mapper.ts)
  └─ per-block tally (thinking/text/tool_use/redacted_thinking/server_tool_use/other)
       │  accumulated in ClaudeUiMapperState, per turn
       ▼
mapResult → UiTurnCompletedEvent.blockCounts   (NEW field, Phase 1)
       │
       ▼  (persisted verbatim to NDJSON, like every other UiEvent)
runs/<id>.ndjson
       │
       ▼  (replay, Phase 2 — stats.ts, computed on demand, nothing persisted here)
computeRunStats
  ├─ existing: batch factor, model/exec/wall ms, sleep, peak context   (unchanged)
  └─ NEW: tokenizeStepBreakdown(step's item.completed + turn.completed events)
            → StepStats.tokenBreakdown?: TokenBreakdown
       │
       ▼
formatRunStats (stats.ts) / stats-cli.ts   → cez run stats prints the breakdown  (Phase 3)
```

Two things worth stating plainly:

- **`blockCounts` (Phase 1) and `tokenBreakdown` (Phase 2) are independent and differently
  retroactive.** `blockCounts` requires the run to have been recorded *after* this ships.
  `tokenBreakdown` works on any run with v2 `item.*` events on disk today, including `70f19253`,
  because the text it needs was already being persisted before this task existed. A step computed
  from an old log simply has `opaqueBlocks` always `0` (the counter didn't exist then) — which must
  read as "unknown", not "confirmed none happened". `TokenBreakdown` should carry a boolean
  `blockCountsAvailable` so a consumer doesn't misread absence of opaque blocks as proof of
  absence.
- **Why not populate `TokenUsage.reasoning` (already declared, never used)?** Because the wire
  never reports a reasoning-only output count for claude (see Problem citations table) — there is
  nothing honest to assign to it from the mapper. `reasoning` stays reserved for a backend that
  *does* report it live (the field's own doc already frames it that way). The new breakdown lives
  on `StepStats`/`RunStats`, computed at replay time, not on the wire `TokenUsage` type.

## Data models

**Wire contract addition (Phase 1) — `packages/cezar/src/core/ui-events.ts`:**

```ts
/** Occurrence counts of raw Anthropic content-block types seen this turn, before mapping or
 *  discarding — claude only, absent for other backends and for any turn recorded before this
 *  field existed. Free to compute (no tokenizer): answers "did extended thinking / opaque
 *  billing happen at all" without persisting content that Anthropic itself never reveals
 *  (redacted_thinking's `data` field is intentionally not captured here or anywhere else). */
export interface ClaudeBlockCounts {
  text: number;
  /** Both blank and non-blank `thinking` blocks — NOTE this differs from the item-minting rule
   *  (claude-ui-mapper.ts:190), which skips blank thinking when creating a reasoning item. This
   *  counter must not skip blank ones, or a run that emits only blank thinking reads identically
   *  to a run that requests no thinking at all — exactly the ambiguity Phase 1 exists to remove. */
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

**Replay computation (Phase 2) — `packages/cezar/src/runs/stats.ts`:**

```ts
export interface TokenBreakdown {
  /** Σ turn.completed.usage.output over this step's turns — the ground truth being reconciled. */
  reportedTokens: number;
  /** Tokenized text of every 'message' item.completed. */
  narrationTokens: number;
  /** Tokenized text of every non-blank-or-blank 'reasoning' item.completed. */
  thinkingTokens: number;
  /** Tokenized JSON.stringify(item.input) of every 'tool' item.completed. */
  toolArgTokens: number;
  /** narrationTokens + thinkingTokens + toolArgTokens. */
  measuredTokens: number;
  /** reportedTokens − measuredTokens. SIGNED — a negative value (tokenizer over-counts relative
   *  to Anthropic's own count) is as real a finding as a positive one and must not be clamped. */
  gapTokens: number;
  /** gapTokens / reportedTokens × 100, 1dp. 0 when reportedTokens is 0. */
  gapPct: number;
  /** Σ blockCounts.{redactedThinking,serverToolUse,other} over the step's turns. */
  opaqueBlocks: number;
  /** False for any step containing a turn recorded before Phase 1 shipped — see Architecture.
   *  A false here means `opaqueBlocks` is definitionally 0 and must not be read as "confirmed
   *  no opaque blocks occurred". */
  blockCountsAvailable: boolean;
}

// StepStats gains:
tokenBreakdown?: TokenBreakdown;  // undefined when the step emitted no turn.completed at all —
                                   // same "undefined, never a fake 0" convention as peakContextTokens.

// RunStats.totals: reportedTokens / narrationTokens / thinkingTokens / toolArgTokens / measuredTokens /
// opaqueBlocks all SUM across steps (additive, unlike peakContextTokens's max). gapPct is
// recomputed from the summed reportedTokens/measuredTokens, not averaged from steps' gapPct
// (averaging percentages is exactly the kind of composition bug stats.ts:202-214 warns about).
```

## API contracts

None. `cez run stats` is a CLI/local read, not a served route — `packages/cezar/src/runs/stats-cli.ts`
calls `computeRunStats` directly against a local NDJSON file. No `GET` endpoint changes. The
`UiTurnCompletedEvent.blockCounts` addition widens the wire event contract
(`packages/contract` mirrors it per the existing `api-types.test.ts` parity pattern used by
`UiToolItem` — that test must be extended, not bypassed) but adds no new endpoint or request shape.

## Phases

Each phase is independently shippable and independently useful.

**Phase 1 — block-type telemetry at the wire.** `ClaudeBlockCounts` type; tally in `mapAssistant`;
flush + reset in `mapResult`; contract mirror + `api-types.test.ts` parity update. Ships alone,
settles "does extended thinking / opaque billing ever happen on a cezar run" for every run recorded
from here on, needs no tokenizer.

**Phase 2 — tokenized replay reconciliation.** Add the tokenizer dependency; `TokenBreakdown` type
and its computation in `stats.ts`, reading `item.completed` + `turn.completed` per step; new
`StepStats.tokenBreakdown` / `RunStats.totals` fields. Retroactive on every run with v2 item
events already on disk (i.e., essentially every run cezar has produced since the v2 mapper
shipped) — this is the phase that finally lets `70f19253` itself be re-measured properly, closing
Problem §2's baseline dispute.

**Phase 3 — `cez run stats` prints it.** Extend `formatRunStats` (`stats.ts:693-760`) with a
breakdown block beside the existing batch-factor/model:exec lines: per-category tokens, `gapPct`,
and an explicit opaque-blocks line when `opaqueBlocks > 0`. Follows the existing `row()`/`pad()`
pattern; no new formatter primitive needed beyond what the module already has.

**Phase 4 — the reconciliation test, tolerance derived not guessed.** Before writing the assertion,
run Phase 2's `TokenBreakdown` computation against several already-archived real transcripts (at
minimum `70f19253`, plus 2-3 more from `.ai/cezar/runs/`) and record the observed `gapPct` on steps
where `opaqueBlocks === 0`. Set `TOLERANCE` to comfortably bound that observed spread — written down
with the actual numbers in the test's comment, not assumed. The test then asserts `|gapPct| ≤
TOLERANCE` on those steps, and separately asserts that a step/fixture with `opaqueBlocks > 0`
produces a *reported*, not silently-passing-or-failing, larger gap (i.e., the test distinguishes
"reconciled" from "explained by opacity" rather than conflating them).

**Phase 5 — verification on a new run (not a code phase).** Execute after Phases 1-4 ship: run a
new, comparable-shape chain (ideally another `spec-to-deploy` run), then `cez run stats <newRunId>`.
Use it to:
  a. Read `blockCounts` across every step — settle, empirically, whether `thinking` /
     `redacted_thinking` occur at all for the models this workflow uses (per-step model policy
     landed in `a5f04b0f`, `workflows/types.ts:509-571`). The leading hypothesis (TLDR) is that
     both are ~0 and the historical "thinking" framing was measuring undercounted text/tool-args.
  b. Report the measured `gapPct` distribution and compare it against the handoff's 55-60% claim —
     confirm or refute it with this spec's own numbers, not the disputed `70f19253` chars÷4 figure.
  c. Recompute the idle-vs-output relationship (wall time not spent executing a tool, against
     `reportedTokens` per step) and check whether it lands near the cited 81.3 tok/s / R²=0.984.
     **Scope note:** this is a one-time verification calculation from fields Phase 2 already adds
     (`wallMs`, `toolExecMs`, `reportedTokens`) — it does not add a permanent regression/R²
     feature to `stats.ts`. If the owner wants that as a standing meter output, that is separate,
     unrequested scope and should be filed as its own follow-up, not folded in here.
  d. Write the result to the KB — either amend `notion-cc6ebabb2ab4` with a dated addendum (per
     `CLAUDE.md`'s correction rule — appending is not enough if it contradicts something already
     there) or file a new entry if it stands alone, since no existing entry currently makes the
     55-60% claim to correct in place.

## Risks

| # | Risk | Mitigation |
| --- | --- | --- |
| R1 | No public Claude tokenizer exists; `gpt-tokenizer`'s vocab is a stand-in, not a copy, so even perfect measurement of the right text will not zero out `gapPct`. | Named explicitly in Solution. `TOLERANCE` (Phase 4) is derived from real data, not assumed to be near-zero; the spec claims "measured, deterministic, reproducible," never "exact". |
| R2 | The leading hypothesis (thinking ≈ 0 for cezar's runs) could be wrong — some step's model tier might request extended thinking by a default this repo's static source can't reveal. | Phase 1's `blockCounts` is the empirical check, not an assumption baked into the schema — `thinkingTokens` and `opaqueBlocks` are real, live numbers on every future run, not hardcoded to 0. |
| R3 | `redacted_thinking` content is permanently invisible by Anthropic's own design — no tokenizer, local or remote, can measure it. | Reported as an explicit, separately-labeled `opaqueBlocks` count + its inferred token size by subtraction, never folded into or renamed "thinking". Directly answers brief Open Question 3. |
| R4 | `blockCounts` is forward-only — cannot retroactively explain `70f19253` or any pre-Phase-1 run. | `blockCountsAvailable: false` on old steps, read as "unknown" not "confirmed zero" — stated in Architecture and in the `TokenBreakdown` type doc itself, not just prose. |
| R5 | A step with turns from a non-claude backend (codex/opencode) has no `blockCounts` and a different usage shape. | `tokenBreakdown` is `undefined`, not a fake zero-filled object — same convention `peakContextTokens` already uses (`stats.ts:202-214`). |
| R6 | `JSON.stringify(item.input)`'s exact formatting (key order, whitespace) is a reconstruction, not necessarily byte-identical to whatever Claude actually streamed for the `tool_use` block's `input` — that difference itself shifts the tokenized count slightly. | Folded into the same `TOLERANCE` derivation (Phase 4) rather than treated as a separate unmodeled error source; noted here so a future session doesn't rediscover it as a surprise. |
| R7 | Averaging `gapPct` across steps (rather than recomputing from summed totals) would silently misstate the run-level figure — the exact class of bug `stats.ts:202-214`'s peak-context correction was about. | `RunStats.totals.gapPct` is defined as `totalGapTokens / totalReportedTokens`, not `mean(step.gapPct)` — stated explicitly in Data models. |
| R8 | Adding a tokenizer dependency to a CLI package increases install size / cold start for every `cezar` invocation, not just `run stats`. | `gpt-tokenizer` (or whatever Phase 2 lands on) should be imported lazily inside the stats replay path, not at module top-level of anything on the CLI's hot path — a concrete implementation constraint for Phase 2, not just an aspiration. |
| R9 | Criterion 1 ("the run log carries the breakdown") could be read as "the NDJSON file must literally contain the numeric breakdown," which this design does not do — Phase 2's numbers are replay-computed, never persisted. | Read as "measurable from the stream," matching this module's own stated precedent (`stats.ts:16-19`, "replay an old recording with new arithmetic"). Flagged explicitly in Solution for the review step to confirm or override — this is a real interpretation choice, not a settled fact. |

## Analytics

No product-facing analytics event — this is an internal meter, same as the module it extends
(`stats.ts` has none today; `cez run stats` is a developer-facing CLI read, not a served UI). The
observable signal is the NDJSON transcript itself, exactly as the existing batch-factor meter uses
it.

## Verification

1. **Typecheck** — `npm run typecheck`, including the widened `api-types.test.ts` parity check for
   `UiTurnCompletedEvent.blockCounts`.
2. **Mapper unit tests** (`packages/cezar/src/core/claude-ui-mapper.test.ts`) — new cases: an
   assistant frame with `thinking` (blank and non-blank), `text`, `tool_use`, `redacted_thinking`,
   and `server_tool_use` blocks in one message produces the correct `blockCounts` tally on the
   following `turn.completed`, counts accumulate correctly across multiple assistant frames in one
   turn, and reset to zero at the next turn. Existing item-minting behavior (blank thinking mints
   no item, `redacted_thinking` mints nothing at all) must stay unchanged — this is additive
   counting, not a change to what becomes an item.
3. **Stats replay tests** (`packages/cezar/src/runs/stats.test.ts`) — `TokenBreakdown` computed
   correctly against a small fixture with known text/tool-input content and a known
   `usage.output`; `blockCountsAvailable: false` on a fixture predating the field;
   `RunStats.totals` recomputes `gapPct` from summed totals, not step-averaged (pins R7).
4. **The reconciliation test** (Phase 4) — `|gapPct| ≤ TOLERANCE` on real archived transcripts with
   `opaqueBlocks === 0`, `TOLERANCE` recorded with the actual observed numbers it was derived from
   in the test's own comment; a separate assertion that a fixture with `opaqueBlocks > 0` reports a
   distinctly larger, labeled gap rather than passing the same tight bound.
5. **`cez run stats <runId>` on a real archived run** — confirm the new breakdown block prints,
   `narrationTokens + thinkingTokens + toolArgTokens + gapTokens === reportedTokens` exactly (an
   arithmetic identity, always true by construction — this checks the printer's math, not
   measurement quality), and the opaque-blocks line appears only when `opaqueBlocks > 0`.
6. **Full gate** — `npm test` and `npm run test:unit`, both clean.
7. **Phase 5, executed after 1-6 are green** — a new comparable-shape run, `cez run stats` on it,
   and the four checks in Phase 5 (a-d) recorded with their actual numbers in this spec's status
   log, not asserted from a prior run. This is what makes acceptance criterion 4 real: a NEW run,
   not a replay of `70f19253`.
8. **Baseline correction, recorded here** — re-derive and state, in this spec's status log once
   Phase 2 ships, the corrected `70f19253` totals (this draft found 375,001 tokens / $38.33 / 8
   step ids / 11 turns against the handoff's 307,118 / $32.53 / 9 steps) using the shipped
   `TokenBreakdown` computation, so Problem §2's dispute is closed with the same tool the rest of
   this spec relies on, not left as an open discrepancy.
