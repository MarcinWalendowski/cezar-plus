# Fan-out made the step slower — dispatch async, give sub-agents the budget, size them to finish together

> **Status: SPEC WRITTEN, NOT YET IMPLEMENTED.** · **Date:** 2026-08-22
> **Origin:** cezar todo `2b56085d-f7fa-4e26-8e09-357798d30ede` (priority high, started as this task,
> `f32d72ba-c2eb-45be-a5ae-072f568ac9e9`). Written against brief
> `.ai/specs/briefs/2026-08-22-async-subagent-fanout-sizing.md`; every file:line citation and every
> transcript number below was re-verified directly against the source in this worktree while writing
> this spec, not copied from the brief unchecked.
>
> Extends `.ai/specs/2026-08-20-agent-round-trip-batching-and-fanout.md` (the tool-budget doctrine,
> R4, the 260-word cap) and `.ai/specs/2026-08-21-sub-agent-fanout-adoption-and-attribution.md` (the
> meter fix, the "prompt form predicts adoption" finding, and the "doctrine vs. step prompt → step
> prompt" decision this spec follows). Orthogonal to `.ai/specs/2026-08-22-document-fanout-post-
> deploy-metering.md` (todo `221cf511-4e18-4f7b-ba46-e20edf956a16`, picked up by task
> `fb62168a-6972-49f0-afb4-ffe9c4ec9b01`), which measures whether `document`'s prompt fans out at all
> post-deploy and takes no position on dispatch mode or sizing — not a duplicate of this task.

## TLDR

Fan-out landed (`.ai/specs/2026-08-21-...`), the meter can finally see it, and the first real
measurement of an adopted run says it made the step **slower**, not faster: run `70f19253`'s
`context` step ("Gather the record") took 557.5s — longer than its non-fanned-out predecessor
(`c10864d1`, 5.2 min) and longer than its own async-dispatch sibling `e06f2169` (7.7 min, started 11s
earlier, same three jobs). Three measured causes, all re-verified against the raw NDJSON while
writing this spec (§ Problem), none of them model slowness:

1. **Blocking dispatch.** Three `Agent` calls went out `run_in_background:false` with no parent tool
   call alongside them; the parent sat idle 241.6s of the step's 557.5s.
2. **Children are round-trip-bound, not work-bound**, and nothing measures it: two of the three
   sub-agents spent 1.2% and 1.9% of their own wall time actually executing tools.
3. **Straggler spread.** The three dispatches returned 89.1s apart; the parent pays `max()`, so the
   least-busy, most over-scoped child sets the step's price.

**The fix has exactly one lever cezar owns**, established by the prior spec and confirmed again while
writing this one: sub-agents never pass through `composeSystemPrompt` (`run.ts:570-575`), so there is
no shared-composition shortcut — the only place "give sub-agents the tool budget," "dispatch async,"
and "size them to finish together" can land is the dispatching step's OWN prompt text
(`types.ts:671-679` for `context`, `:982-991` for `document`), instructing the model to act on it and
to write condensed budget text into each `Task`/`Agent` prompt at dispatch time. This is a hypothesis
about model behaviour, not a guarantee — cezar has no Agent-tool-call interception layer, mirrors the
2026-08-21 spec's R2 posture.

**Phase 1** rewrites both prompts (async dispatch + own-turn work + comparable sizing + a condensed
per-child budget instruction), touching no test that isn't about this exact behaviour. **Phase 2**
gives `cez run stats` the per-dispatch tool-busy % and straggler-spread numbers needed to verify
Phase 1 at all — today `stats.ts` computes zero exec time for any call made inside a child's window,
by construction (it `break`s before recording it). **Phase 3 cannot run inside this task**, for the
same reason Phase 4 of the 2026-08-21 spec couldn't: the running cezar service executes its own
compiled `dist/workflows/run.js`, so this task's *own* `context` step already ran under the *old*
prompt, and its `document` step (later in this same chain, before `deploy`) will too. The rewritten
prompt only reaches a run started after this task's `deploy` step ships it.

## Problem

### 1. Blocking dispatch idled the parent for 43% of the step

Re-verified against `.ai/cezar/runs/70f19253-cf6b-407c-92e0-96a8020a8ebb.ndjson` (step `context`,
step-start `2026-08-21T19:19:26.086Z`): three `Agent` tool-calls, `stepId: "context"`, ids
`toolu_01Gwq9…`, `toolu_01QhhF…`, `toolu_01GuZv…`, all dispatched between t=53.5s and t=74.5s
(19:20:19–19:20:40) with no `run_in_background: true` in their input and no other parent tool call
until t=322.5s. That is the 241.6s / 43% idle block the brief describes, reproduced independently
here from the raw transcript.

### 2. Children are round-trip-bound, and nothing today measures it

Computed directly from the transcript (dispatch tool-call ts → its own tool-result ts = the child's
wall span; sum of exec time on every v1 call whose v2 item carries `parentItemId` equal to that
dispatch's item id = the child's busy time):

| dispatch (`Agent` call id) | children | wall | child busy | tool-busy % |
| --- | ---: | ---: | ---: | ---: |
| `toolu_01Gwq9Ckgi7XdKWpdK1hvffP` | 20 | 173.6s | 55.42s | **31.9%** |
| `toolu_01QhhFJxqqXgA9D88f7wFsee` | 27 | 185.3s | 3.47s | **1.9%** |
| `toolu_01GuZv9uKGRGsJtwVgKv2pFJ` | 46 | 252.1s | 3.13s | **1.2%** |

Matches the brief's "46 calls / 3.1s exec / 252.1s wall (1%)" and "3.5s / 185.3s (2%)" almost exactly
(3.47s vs "3.5s" — rounding) and its "only the 20-call child hit 32%." **`stats.ts` cannot report any
of this today** — for a v1 `tool-call` whose id is in `items.childIds`, the handler increments
`bucket.childToolCalls` and `break`s (`stats.ts:784-788`) *before* it ever reaches the `pending.set`
that would let a later `tool-result` compute an exec time (`stats.ts:817`); the matching `tool-result`
branch does the same (`if (id !== undefined && items.childIds.has(id)) break;`). Every child call's
exec time is silently discarded, not aggregated as zero — the counter simply never runs for it.

### 3. Straggler spread: the parent pays for the slowest, least-busy child

Same transcript, dispatch-id → return timestamp, offset from step-start (19:19:26.086Z):

| dispatch | returns at | offset |
| --- | --- | ---: |
| `toolu_01Gwq9…` (20 children, 32% busy) | 19:23:13.154 | 227.068s |
| `toolu_01QhhF…` (27 children, 2% busy) | 19:23:45.810 | 259.724s |
| `toolu_01GuZv…` (46 children, **1% busy**) | 19:24:42.225 | 316.139s |

Spread = 316.139 − 227.068 = **89.071s**, matching the brief's "89s" and its t=227.1/259.7/316.1
figures exactly. **The straggler is also the least-busy child** — the 46-call, 252.1s-wall job that
did 3.13s of real work is both the slowest to return AND the one that most needed to be split or
shrunk, which is exactly R4's abstract warning (2026-08-20 spec) landing as a concrete number.

### 4. Why this is a genuinely new problem, not a re-run of the 2026-08-21 fix

That spec's concern was whether fan-out happens at all — the meter read `sub 0` when 3 dispatches had
occurred, an instrument bug, now fixed. This task's concern is that fan-out **does** happen, is
correctly counted, and **still costs more than it saves**, for three reasons the 2026-08-20 spec's
R4 named in the abstract ("pays only where branches are independent, substantial (≳60s each), and
read-only") but never measured with numbers until `70f19253`.

## What the record already decided (citations, re-verified)

- **`.ai/specs/2026-08-20-agent-round-trip-batching-and-fanout.md`** — `TOOL_BUDGET_DOCTRINE`
  (`run.ts:541-560`, re-read in full while writing this spec — this is the literal text prepended to
  this very session's own system prompt). R7 capped it at "~200 words"; `system-prompt.test.ts:137`
  now pins **`< 260` words**, raised 2026-08-21 with a measured argument recorded in the test's own
  comment. R4 named the straggler failure mode in the abstract.
- **`.ai/specs/2026-08-21-sub-agent-fanout-adoption-and-attribution.md`** — fixed `subAgentCalls`
  attribution and spelling (`stats.ts` `indexToolItems`/`dispatchIds`, verified present at
  `stats.ts:552-566`), found *"the prompt's form, not the tool grant, predicts adoption"* (`context`'s
  imperative paragraph: 3/3 dispatches; `document`'s subordinate clause: 0/2), and explicitly chose
  **doctrine vs. step prompt → step prompt** (its open question 5) — "no fan-out bullet in
  `TOOL_BUDGET_DOCTRINE`... it rides on every step including the four deliberately denied `Task`."
  This spec's fix follows that same precedent for "give sub-agents the tool budget": it cannot go in
  `TOOL_BUDGET_DOCTRINE` (reaches Task-denied steps, is word-capped, and per
  `system-prompt.test.ts` sits beside the comment explaining `run_in_background` was *already* forced
  out of it for being backend-specific) — it goes in `types.ts`'s `context`/`document` prompts.
- **`.ai/specs/2026-08-22-document-fanout-post-deploy-metering.md`** — Phase 4 of the 2026-08-21 spec,
  filed as todo `221cf511-4e18-4f7b-ba46-e20edf956a16`, picked up by task
  `fb62168a-6972-49f0-afb4-ffe9c4ec9b01`. Confirmed orthogonal: it asks whether `document` fans out
  post-deploy at all; it takes no position on dispatch mode, sizing, or per-child metrics, and
  declines to iterate the prompt a second time inside its own task.
- **`notion-333c1a0a847b`** — "batching beats fan-out, and fan-out is not free." Causes 2 and 3 above
  are this same finding, one level down, invisible until Phase 2 of this spec.
- **This task's own todo, `2b56085d-f7fa-4e26-8e09-357798d30ede`** (priority high,
  `startedTaskId: f32d72ba-c2eb-45be-a5ae-072f568ac9e9`) carries this task's title and all four
  acceptance criteria verbatim.

## Which code is actually involved (file:line, re-verified live in this worktree)

**Prompts (no async/sizing/budget guidance today):**
- `packages/cezar/src/workflows/types.ts:671-679` — `context`'s fan-out paragraph. Verified text:
  `'Then go WIDE. Reading the record, mapping the code, and checking for in-flight duplicate'` /
  `'work are independent jobs, so run up to THREE sub-agents (`Task`) on them in parallel in a'` /
  `'single turn and read their findings together. Rules that make this safe rather than merely'` /
  `'fast:'`, then four existing bullets (READ-ONLY, YOU write the brief, worth a minute of work /
  don't fan out to read one file).
- `packages/cezar/src/workflows/types.ts:982-991` — `document`'s equivalent paragraph (moved from
  the 2026-08-21 spec's cited `:839-841` by intervening commits — re-grepped fresh for this spec, not
  trusted from the prior citation). Same structure, same gaps, `document`-specific second bullet
  ("YOU do all the writing... This step holds `Edit`/`Write`...").
- `packages/cezar/src/workflows/run.ts:541-560` — `TOOL_BUDGET_DOCTRINE`. Deliberately
  backend-agnostic; a comment at the top of `packages/cezar/src/workflows/types.ts` (`FILE_WRITE_RECIPE`,
  around `:499-503`) already sets the precedent this spec follows for saying a Claude-Code-specific
  parameter name in a prompt: *"On Claude Code that is `Edit`... on another backend, whatever
  patch/edit tool it gives you."* `run_in_background` gets the same treatment here, in the STEP
  prompt (which types.ts:22-25 confirms is itself per-step-backend-selectable), not in the doctrine.
- **No `composeSystemPrompt` reaches a sub-agent.** It is called at exactly two sites —
  `run.ts:3431-3443` (Continue-turn session) and `run.ts:4692-4701` (normal step session) — both
  building the top-level step's OWN Claude session. A `Task`/`Agent` sub-agent is dispatched by the
  underlying CLI's own built-in tool, entirely outside it. Re-verified: both call sites build
  `systemPrompt` from `TOOL_BUDGET_DOCTRINE` + handoff instructions + workspace/knowledge blocks —
  nothing sub-agent-specific exists to hook.

**The metric gap (`stats.ts`, re-verified against the current source):**
- `stats.ts:784-788` — a child's `tool-call` increments `childToolCalls` and `break`s before
  `pending.set` (`:817`) ever runs for it. Its matching `tool-result` (`~:816-836`, the
  `case 'tool-result':` block) does the same: `if (id !== undefined && items.childIds.has(id)) break;`
  before computing `execMs`. **A child's own tool-execution time is never computed, not even summed
  into a discarded bucket** — confirmed by re-deriving the 31.9% / 1.9% / 1.2% table above entirely
  outside `stats.ts`, from raw v1/v2 timestamps.
- `stats.ts:552-566` (`indexToolItems`) builds `known` / `childIds` / `dispatchIds` from `item.started`
  events but discards `parentItemId` once it has decided membership — there is no `childId → parentId`
  map kept for later use, which is what a per-dispatch child-busy sum needs.
  `dispatchIdsByStructure` (`:580-589`) already demonstrates the walk that would build it.
- `stats.ts:973-1040` (`formatRunStats`) — the table and its columns (`stats-cli.ts` only routes CLI
  argv to `formatRunStats`/`readRunStats`, per `stats-cli.ts:1-119`; it owns no columns itself). No
  `sub`-scoped busy%/spread column exists.
- `stats.test.ts` — the `c10864d1-trimmed.ndjson` and `ec6e8e06-trimmed.ndjson` fixtures
  (`packages/cezar/src/core/__fixtures__/runs/`) pin the current contract; a third fixture trimmed
  from `70f19253` (full transcript confirmed present locally, 5.1 MB) is what this spec adds, because
  it is the only one of the three fanned-out runs with a genuine straggler and a sub-10%-busy child —
  `c10864d1`'s three dispatches don't reproduce cause 2/3 the way `70f19253`'s do.

## Solution

Three independently shippable phases (Phase 3 is filed, not executed, for the reason in its section).

### Phase 1 — Rewrite both fan-out paragraphs: async dispatch, own-turn work, comparable sizing, a condensed per-child budget instruction

Insert three new bullets into `context` (`types.ts:671-679`) and `document` (`types.ts:982-991`),
immediately after the existing `'Rules that make this safe rather than merely fast:'` line and before
the four existing bullets. **Every string the existing tests pin stays untouched** — the intro
sentence, `'in parallel in a single turn'`, `'Rules that make this safe rather than merely fast:'`,
`'READ-ONLY'`, `'worth a minute of work'`, `'Do not fan out to read one file'` — new lines are added,
none of the old ones are edited or reordered away from their pinned neighbours.

```
- Dispatch all three at once, not one at a time: on Claude Code that is `run_in_background: true`
  on each `Task`/`Agent` call; on another backend, whatever non-blocking dispatch it gives you.
  Make at least one of your OWN tool calls in that same turn — do not sit idle waiting on a
  synchronous dispatch. One run lost 43% of this step's wall time exactly that way.
- Size the three jobs to return TOGETHER. Comparable scope — similar file count, similar search
  breadth — not one broad sweep beside two narrow ones. An over-scoped job that reads far more
  than its siblings is what a slow step is actually waiting on; split it narrower instead.
- Tell each sub-agent, in its own prompt, to batch its reads into as few tool calls as possible —
  the same rule you follow yourself. A sub-agent that spends four minutes of wall clock to do
  three seconds of real work costs more than it saves.
```

**Why a condensed instruction, not the literal `TOOL_BUDGET_DOCTRINE` text, copied into each child's
prompt (brief's open question 1).** Three reasons: (a) the doctrine is written for a step with its
OWN long-running turn — the sleep/background/marker tiers do not apply to a sub-agent whose entire
job is "answer in a minute"; (b) it would cost ~250 words **per dispatch**, i.e. ×3 in the parent's
own prompt just to describe what to paste, which fights the same dilution concern that capped the
doctrine itself (2026-08-20 spec R7); (c) it is not hypothetical — this very step, writing this very
spec's brief, dispatched two sub-agents this session with a condensed task-specific batching
instruction rather than the literal doctrine block (brief § Meta note), so the condensed form already
has one data point of it being followed.

**Why the async-dispatch bullet names `run_in_background: true` explicitly, when the doctrine
deliberately does not.** The doctrine is shared across `implement`/`run-tests`/`commit-push`/`deploy`,
none of which grant `Task`, so naming an Agent-dispatch parameter there would be dead text on every
step that reads it. `context`/`document` are the only two steps this instruction can ever apply to,
and `FILE_WRITE_RECIPE` (`types.ts` ~`:499-503`) already sets the "name it for Claude Code, then say
'whatever the equivalent is' for another backend" pattern in a **step** prompt for exactly this
reason — steps are per-backend-selectable (`types.ts:22-25`), the doctrine constant is not.

**Explicitly not changed:** the intro sentence, the `Task` grant list, the READ-ONLY bound, the
`worth a minute of work` / `Do not fan out to read one file` bullets, `RECORD_READ_RECIPE`'s presence
in either step, and `TOOL_BUDGET_DOCTRINE` itself.

### Phase 2 — `cez run stats` grows per-dispatch tool-busy % and straggler spread

**Extend `ItemIndex` (`stats.ts:545-566`) with a fourth set: `parentOf: Map<string, string>`**
(child item id → its dispatch's item id), populated in the same loop that already builds `childIds`
— `dispatchIdsByStructure` (`:580-589`) already walks this relationship for its cross-check; this
reuses the same field instead of rebuilding it.

**Track exec time for a child call instead of discarding it.** In the `tool-call` handler
(`:784-788`), when `items.childIds.has(id)`, still register it — in a *separate* map from `pending`
(children never open a round trip or claim `toolExecMs`, so they must not share `pending`'s bucket
semantics) — e.g. `childPending: Map<string, number>` (id → startedAt). In the `tool-result` handler's
existing early-out for a child id, look the id up in `childPending`, compute `execMs`, and add it to
`childExecByParent.get(parentOf.get(id)) ?? 0`. This assumes a child's own tool-results are logged
before its dispatching `Agent` call's tool-result — true by construction (the sub-agent's entire
session completes before the parent's `Task` call returns), and it is exactly the ordering the
70.1f19253 numbers above were computed against, by hand, outside `stats.ts`, to validate this design
before writing it down.

**When a dispatch's own `tool-result` arrives** (it is never a child, so it takes the normal "own
call" path already at `:816-836`), also push one `SubAgentDispatch` entry onto its step's bucket:

```ts
interface SubAgentDispatch {
  id: string;            // the dispatch's own v1 tool-call id
  wallMs: number;         // its own execMs — dispatch tool-call ts → dispatch tool-result ts
  childBusyMs: number;    // childExecByParent.get(id) ?? 0
  toolBusyPct: number;    // wallMs > 0 ? round(childBusyMs / wallMs * 100) : 0
  returnTs: number;       // absolute ts of the dispatch's own tool-result — for spread
}
```

`StepStats` gains:

```ts
subAgents: SubAgentDispatch[];   // one entry per dispatch THIS step made, dispatch order; [] if none
subAgentSpreadMs?: number;       // max(returnTs) - min(returnTs) across subAgents; undefined if < 2
subAgentMinBusyPct?: number;     // min(toolBusyPct) across subAgents; undefined if 0 dispatches
```

`RunStats.totals` picks `subAgents` up as the flat concatenation across steps (not a sum — there is
nothing to sum), and `subAgentSpreadMs` / `subAgentMinBusyPct` are recomputed over that concatenated
list with the same definitions — the same "totals is a rollup, not always a sum" posture
`peakContextTokens` already established (`stats.ts:486`, "the MAX").

**Table (`formatRunStats`, `:973-1040`).** Two new compact columns after `sub`, blank (`—`) when a
step made zero dispatches:

```
...  sub  busy%  spread s  ctx k  ...
...    3     1        89  141.7  ...
```

`busy%` is `subAgentMinBusyPct` (the worst child, because that is the one the acceptance criterion
and the straggler-spread finding both care about — reporting a mean would hide exactly the 1%
outlier that made the step slow). `spread s` is `subAgentSpreadMs` in seconds. **`--json`** exposes
the full `subAgents` array per step for per-dispatch detail (the brief's open question 4: aggregate
in the table, full detail in JSON — table stays readable, nothing is lost).

**New fixture: `70f19253-trimmed.ndjson`**, trimmed the same way `c10864d1-trimmed.ndjson` was (the
`context` step's `tool-call`/`tool-result`/`item.started`/`item.completed`/`context.updated` lines,
payloads stripped, ids and timestamps verbatim). Pins, from the numbers computed and cross-checked
in § Problem:

- `subAgentCalls === 3`
- three `subAgents` entries with `toolBusyPct` ≈ `32`, `2`, `1` (exact values derived from the
  trimmed fixture at implementation time, expected within rounding of `31.9`/`1.9`/`1.2`)
- `subAgentMinBusyPct` ≈ `1`
- `subAgentSpreadMs` ≈ `89071` (± the fixture's own rounding)

**Degradation.** A transcript with no `item.*` events (every pre-v2 log, the `ec6e8e06` fixture)
yields `subAgents: []` for every step — `parentOf` is empty, so no child call ever attributes to a
dispatch, and the existing `ec6e8e06` assertions (`toolCalls === 271`, `subAgentCalls === 0`, …) do
not move.

### Phase 3 — Runtime verification. Cannot execute inside this task, and this spec says so rather than leaving it to be discovered

**Same chain-ordering constraint the 2026-08-21 spec hit at its own Phase 4, re-confirmed for this
task specifically.** The chain is `context → spec → review-spec → implement → run-tests →
commit-push → document → deploy`. The running cezar service executes its own compiled
`/opt/cezar/packages/cezar/dist/workflows/run.js` — **this task's `context` step already ran**,
before this spec was written, under the *old* prompt (that is the `70f19253` transcript this very
spec is measured against). This task's own `document` step runs later in this same chain, still
before `deploy`, so it **also** runs under the old compiled prompt. The rewritten prompt only takes
effect for a run whose `context` step starts *after* this task's `deploy` step ships the change.

Acceptance criteria 1, 3 and 4 are therefore **not verifiable inside this task's own run** — they
need a `context`-step-reaching run started post-deploy. Filed as a follow-up rather than asserted:

```bash
cezar todo add "Meter the context step's async dispatch + sizing after this task's prompt rewrite deploys" \
  --project cezar \
  --context "Follow-up to .ai/specs/2026-08-22-async-subagent-dispatch-and-sizing.md. The rewritten \
context/document prompts only reach a run whose context step STARTS AFTER the deploy that ships \
them, because this task's own context step already ran under the old prompt and its document step \
runs before deploy in the same chain. Baselines (context step, 'Gather the record'): 70f19253 \
(blocking dispatch) idle 241.6s, spread 89.1s, busy 32%/2%/1%, step wall 557.5s; e06f2169 (async \
dispatch, OLD sizing/budget guidance) wall ~462s (7.7 min)." \
  --acceptance "parent idle time between last Agent dispatch and next parent tool call is under 30s" \
  --acceptance "cez run stats --json shows subAgentSpreadMs under 60000 and every subAgent toolBusyPct at or above 10" \
  --acceptance "the context step's wall time beats 462s (7.7 min, run e06f2169)" \
  --acceptance "if any of the above still fails, the failure is written into this spec's status log, not silently retried"
```

## Architecture

```
context/document step prompt (types.ts)             stats.ts (unchanged wire format)
  │                                                    │
  ├─ instructs the model to:                           │  v1 tool-call/tool-result  ──┐
  │    dispatch async (run_in_background:true)          │  v2 item.started            │
  │    + own-turn work                                  │    {id, toolKind,           │
  │    + comparable job sizing                          │     parentItemId?}          │
  │    + condensed budget text INTO each Task prompt    │                             ▼
  │                                                      │  indexToolItems() ── NEW: + parentOf map
  ▼                                                      │  tool-call/result loop ── NEW: childPending,
Claude/codex/opencode CLI's OWN Agent-dispatch tool      │    childExecByParent, per-dispatch push
  (outside composeSystemPrompt; cezar cannot intercept)  │
                                                          ▼
                                              StepStats.subAgents[] / subAgentSpreadMs / subAgentMinBusyPct
                                                          │
                                              formatRunStats() ── NEW: busy% / spread s columns
                                                          │
                                              cez run stats <id> [--json]
```

Nothing here widens the run protocol — same posture as the 2026-08-21 spec's S1/S2: every number
Phase 2 computes comes from `tool-call`, `tool-result`, and `item.started`/`item.completed` events
already persisted, re-joined by `id`/`parentItemId`, the same join already proven to have zero
unmatched ids across four transcripts.

## Data models

```ts
// stats.ts — additions only, existing fields unchanged in name and meaning
interface ItemIndex {
  known: Set<string>;
  childIds: Set<string>;
  dispatchIds: Set<string>;
  parentOf: Map<string, string>;   // NEW: child item id -> its dispatch's item id
}

interface SubAgentDispatch {       // NEW
  id: string;
  wallMs: number;
  childBusyMs: number;
  toolBusyPct: number;
  returnTs: number;
}

interface StepStats {
  // ...all existing fields unchanged...
  subAgents: SubAgentDispatch[];   // NEW
  subAgentSpreadMs?: number;       // NEW
  subAgentMinBusyPct?: number;     // NEW
}
```

`RunStats.totals` (`Omit<StepStats,'stepId'|'restarts'>`) gains the same three fields: `subAgents` is
the flat concatenation across steps, `subAgentSpreadMs`/`subAgentMinBusyPct` recomputed over that
concatenation. Nothing is persisted to `runs.json` — `stats.ts` remains a pure NDJSON replay, same as
every prior phase of this meter.

## API contracts

**`cez run stats <runId>` — human table.** Two columns added after `sub`: `busy%` and `spread s`.
Blank (`—`) for a step with zero dispatches. No existing column renamed or reordered.

**`cez run stats <runId> --json`.** `StepStats` and `RunStats.totals` gain `subAgents`,
`subAgentSpreadMs?`, `subAgentMinBusyPct?`. Additive change to a filesystem-only CLI with no HTTP
surface and no stored consumer (`stats-cli.ts` is the only caller of `readRunStats`/`formatRunStats`
outside tests).

No workflow-definition schema change — Phase 1 is prompt text only, inside the existing `prompt`
string arrays.

## Phases (recap, shippable independently, in this order)

1. **Prompt rewrite** (`types.ts:671-679`, `:982-991`). No behaviour change to anything measured by
   an existing test; new `types.test.ts` assertions cover the three new bullets.
2. **`stats.ts`/`stats.test.ts` per-dispatch metrics.** No agent behaviour change. Makes acceptance
   criteria 1, 3, 4 measurable at all — they are unmeasurable today the same way the 2026-08-21
   spec's criteria were unmeasurable before its own Phase 1.
3. **Runtime A/B, filed as a follow-up todo.** Cannot execute inside this task; the todo carries both
   baselines so the next session does not re-derive them.

## Risks

| # | Risk | Mitigation |
| --- | --- | --- |
| R1 | **Prompt-only enforcement is a hypothesis, not a guarantee** — cezar cannot force `run_in_background:true`, comparable sizing, or a written per-child budget instruction at the code level; no Agent-tool-call interception layer exists. | Stated plainly here rather than treated as closed (mirrors 2026-08-21 spec R2). Phase 3's follow-up todo names the falsification path: if idle time, spread, or wall time don't move, record it, don't re-iterate silently. |
| R2 | **The new `stats.ts` engineering (`childPending`/`childExecByParent`) is new arithmetic, not a replay of an existing formula** — a bug here would misreport tool-busy% confidently. | The `70f19253-trimmed` fixture pins numbers independently re-derived by hand outside `stats.ts` (§ Problem tables), the same way the 2026-08-21 spec's `c10864d1` fixture was. `ec6e8e06`'s existing assertions stay unmodified as the no-op-on-old-logs proof. |
| R3 | **Naming `run_in_background: true` in a step prompt reopens the exact reason it was removed from `TOOL_BUDGET_DOCTRINE`** if done carelessly. | Not done in the doctrine — done in the STEP prompt, which is already per-backend-selectable (`types.ts:22-25`), following the precedent `FILE_WRITE_RECIPE` already set for naming a Claude-Code-specific tool with a "whatever the equivalent is" fallback for another backend. |
| R4 | **Sizing jobs "to finish together" has no enforcement mechanism beyond the instruction** — a model could still scope one job far larger than its siblings. | This is R1's risk restated for one bullet specifically; Phase 2's `subAgentSpreadMs`/`subAgentMinBusyPct` make it observable per run, so drift shows up in `cez run stats` rather than staying invisible the way it was before this spec. |
| R5 | **Table width.** Two more columns on an already-wide table (`formatRunStats` header is ~122 chars before this change). | Both new columns are narrow (4-6 chars) and blank for the common case (steps with zero dispatches); full per-dispatch detail moves to `--json` rather than widening the table further, per the brief's own open question 4. |
| R6 | **One uncontrolled cross-run sample.** The Phase 3 comparison is `context` on a different task than either baseline. | Named at the todo's own acceptance criteria rather than buried — matches R10 of the 2026-08-21 spec, which this task's own acceptance criterion 4 explicitly inherits ("measured from its own NDJSON, not asserted"). |

## Verification

Concrete and executable. The standard environment traps apply:

```bash
unset NODE_ENV
unset CEZ_REMOTE CEZ_OIDC_CLIENT_ID CEZ_OIDC_ISSUER CEZ_PROJECTS_DIR CEZ_KB CEZ_KB_ROOT CEZ_TODOS_FILE
```

**§V1 — Phase 1, prompt composition (`packages/cezar/src/workflows/types.test.ts`).** All existing
pinned assertions pass **unmodified**: `'grants Task fan-out to the read-heavy steps ONLY (context,
document)'`, `'tells the two fanned-out steps to keep their sub-agents read-only and write nothing'`,
`'states fan-out as an imperative paragraph in BOTH read-heavy steps, not as an aside'` (its `flowed`
substring checks: `'Then go WIDE.'`, `'in parallel in a single turn'`, `'Rules that make this safe
rather than merely fast:'`, `'worth a minute of work'`, `'Do not fan out to read one file'`), and the
`RECORD_READ_RECIPE`-presence test. Add, for both `context` and `document`:

- prompt contains `run_in_background` (or the flowed text contains the exact async-dispatch bullet);
- prompt contains a sizing instruction (flowed text contains `'return TOGETHER'` or equivalent);
- prompt instructs writing a budget instruction into each sub-agent's own prompt.

**§V2 — Phase 2, regression (`stats.test.ts`, existing `ec6e8e06`/`c10864d1` fixtures).** Unmodified:
`toolCalls === 271`, `subAgentCalls === 0` on `ec6e8e06`; `subAgentCalls === 3`,
`childToolCalls === 70`, `ownToolCalls === 16` on `c10864d1`'s `spec` step. Add: both fixtures'
`subAgents` arrays are `[]` (`ec6e8e06`: no `item.*` at all; `c10864d1`: has dispatches but this spec
doesn't require re-deriving its per-dispatch numbers since `70f19253` is the fixture that actually
exercises the straggler/low-busy path).

**§V3 — Phase 2, the new capability (`70f19253-trimmed.ndjson` fixture, new).** On the `context`
step: `subAgentCalls === 3`; three `subAgents` entries with `toolBusyPct` within rounding of `32`,
`2`, `1`; `subAgentMinBusyPct` within rounding of `1`; `subAgentSpreadMs` within rounding of `89071`.
Every number here was independently derived from the raw transcript in § Problem before being
written into this spec, not estimated.

**§V4 — Full gates.** `npm run typecheck` and `npm test` green with the unsets above. Any pre-existing
flake (e.g. `knowledge/catalog.test.ts` C18, a documented CPU-budget flake under concurrent load) is
reproduced at clean `HEAD` before being attributed to this change, per the 2026-08-21 spec's own
verification discipline.

**§V5 — Runtime A/B. Filed as a follow-up (Phase 3), not run here.** Closes acceptance criteria 1, 3,
4 on a future run whose `context` step starts after this task's `deploy`:

1. `cez run stats <newRunId> --repo /var/lib/cezar/loki-labs/cezar --json` on the `context` step.
2. Parent idle time between the last `Agent` dispatch and the next parent tool call **< 30s** (was
   241.6s) — criterion 1.
3. Every `subAgents[].toolBusyPct` **≥ 10** (was 1.2% and 1.9%) — criterion 2's acceptance bound,
   restated at the number the acceptance criteria actually name.
4. `subAgentSpreadMs` **< 60000** (was 89 071) — criterion 3.
5. Step `wallMs` **< 462 000** (7.7 min, `e06f2169`'s async-dispatch, old-guidance baseline) —
   criterion 4, "measured from its own NDJSON, not asserted."
6. If any bound is missed, the todo's own acceptance criteria require the miss to be written into
   this spec's status log rather than silently re-attempted — same discipline as the 2026-08-21
   spec's R2/Phase 4 posture.

## Open questions

Answered here from the brief's list, so the implementer does not re-litigate them:

1. **Condensed hint vs. literal doctrine, per child prompt** — condensed, task-specific text (see
   Phase 1's third bullet and its rationale). The literal 260-word doctrine, copied ×3, both dilutes
   the parent's own prompt and does not fit a sub-agent whose entire job is answer-in-a-minute.
2. **What counts as "sized to finish together"** — the acceptance criterion's own number:
   `subAgentSpreadMs < 60000`, now a real, verifiable field (Phase 2), not just a prompt instruction
   taken on faith.
3. **Tool-busy % definition** — `childBusyMs / wallMs` where `wallMs` is the dispatch's own
   tool-call→tool-result span on the PARENT's v1 stream (not a child-side "step" framing — children
   emit no `step-start`/`step-end` equivalent). Pinned precisely in § Solution/Phase 2 and validated
   against real data in § Problem before being written down.
4. **Where the new column lives** — a compact aggregate (`busy%` = worst child, `spread s`) in the
   default table; full per-dispatch detail in `--json`. Matches the brief's own leaning: the
   acceptance criteria need per-child visibility to verify at least once, which `--json` gives without
   permanently widening the table.
5. **Enforcement is a hypothesis** — stated as R1, not treated as a closed loop.

Still genuinely open:

- Whether `document`'s adoption rate changes with the same rewrite is exactly what the orthogonal
  `221cf511-4e18-4f7b-ba46-e20edf956a16` / task `fb62168a-6972-49f0-afb4-ffe9c4ec9b01` is already
  measuring — this spec applies the same rewrite to `document` for prompt symmetry (both steps hold
  an identical `Task` grant and could hit the identical straggler pathology) but does not itself
  re-run that A/B.
