# Fan-out already happens and the meter cannot see it — fix the counter, then make `document` do what `context` does

> **Status: PARTIAL** — **Phases 1–3 implemented 2026-08-21**; Phase 4 (the runtime A/B on the
> rewritten `document` prompt) cannot execute in this chain and is filed as a follow-up. Acceptance
> criteria 1 and 3 are closed by re-metering transcripts already on disk; criterion 2 is not.
> See *Status log — 2026-08-21* at the foot of this file. · **Date:** 2026-08-21
> **Origin:** task *"Make sub-agent fan-out actually happen on read-heavy steps — Task has been
> available since Phase 4 and chosen exactly 0 times"*, filed after
> `.ai/specs/2026-08-20-agent-round-trip-batching-and-fanout.md` §4 was executed on 2026-08-21
> (KB `notion-cc6ebabb2ab4`). Written against the brief
> `.ai/specs/briefs/2026-08-21-sub-agent-fanout-adoption.md`, whose two central measurements were
> re-derived from the raw transcripts for this spec and are confirmed.
>
> Like the spec it extends, this is **about cezar's own agent loop**. It changes one module
> (`runs/stats.ts`), one step prompt, and no run protocol.

## TLDR

**The task's premise is half wrong, and the half that is wrong is the meter's fault.**

`packages/cezar/src/runs/stats.ts:178` counts a sub-agent dispatch by exact string equality with
`'Task'`. Claude emits `'Agent'`. Across every transcript in `.ai/cezar/runs/`, **`"tool":"Task"`
occurs zero times and `"tool":"Agent"` occurs three times in each of three separate runs.** cezar's
own display layer has known both spellings since `tool-display.ts:140-155`; the meter never did. So
"chosen exactly 0 times" is what the instrument prints, not what happened.

Worse, the meter attributes a **child's** tool calls to the **parent's** step, because
`workflows/run.ts:4319` stamps `stepId` onto every v1 event and `claude-cli-runner.ts:800-802`
emits one for every `tool_use` block with no parent filter. Measured:

| run | step | calls the meter prints | the parent's **own** calls | children's | sub-agents dispatched | `batchFactor` printed | own-only `batchFactor` |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `7c2dd8f0` | `spec` | 38 | **38** | 0 | 0 | 1.00 | 1.00 |
| `c10864d1` | `spec` | 86 | **16** | 70 | **3** | 1.10 | 1.00 |
| `e06f2169` | `context` | 101 | **21** | 80 | **3** | 1.12 | 1.00 |
| `70f19253` | `context` | 106 | **13** | 93 | **3** | 1.07 | 1.18 |

So fan-out currently **raises** the number the acceptance criteria want to see fall, and reports the
dispatch count that would prove it as zero. **All three acceptance criteria are unmeasurable today
regardless of what any agent does.**

**What this spec can and cannot close.** Fixing the meter closes acceptance criteria 1 and 3 **in
this PR**, on transcripts already on disk: three runs dispatched three sub-agents each and were
recorded as zero. Criterion 2 — the peak-context comparison on `document` — needs the rewritten
prompt to have actually run, and `document` executes *before* `deploy` in this same chain, so it
cannot close here. Phase 4 files it as a follow-up with both baselines attached rather than
pretending otherwise.

Two consequences set this spec's shape:

1. **Fix the meter first.** Everything needed is *already persisted*: the NDJSON carries v2
   `item.started` events whose tool items have `parentItemId` (child) and `toolKind: 'task'`
   (dispatch). **Every v1 `tool-call` id matched a v2 tool item in all four transcripts checked —
   zero unmatched.** No protocol widening, no change to `claude-cli-runner.ts`, so
   `specs-d53ef835ba5f`'s "must not invent protocol to get a display" is not touched.
2. **The step to change is `document`, not `spec`.** `context` was told to fan out in an imperative
   paragraph with rules and **did so on 3 of 3 runs**. `document` holds the same `Task` grant behind
   a subordinate clause and has fanned out on **0 of 2 runs** (38 and 45 own calls, `sub` 0).
   `spec` deliberately lost `Task` in `e9ed8f5a` and must not get it back.

The strongest evidence that fan-out works is already on disk and was never read: **the same `spec`
step, in the same 6-step workflow, made 38 own calls without fan-out (`7c2dd8f0`) and 16 with it
(`c10864d1`) — 58% fewer parent round trips**, with the exploration output absorbed by children.

## Problem

### 1. The counter matches a string the backend does not emit

```ts
// packages/cezar/src/runs/stats.ts:178
if (stringOf((event as { tool?: unknown }).tool) === 'Task') bucket.subAgentCalls += 1;
```

Against `packages/cezar/src/core/tool-display.ts:140-146`, which already documents the truth —
*"claude dispatches these through `Agent` today and `Task` historically (opencode uses `task`) —
both spellings resolve"* — and maps `case 'task': case 'agent':` alike to `toolKind: 'task'`.

Verified by grep over `/var/lib/cezar/loki-labs/cezar/.ai/cezar/runs/*.ndjson`:

| run | `"tool":"Agent"` | `"tool":"Task"` | what `cez run stats` prints in `sub` |
| --- | ---: | ---: | ---: |
| `c10864d1-…` (done) | 3 | 0 | **0** |
| `70f19253-…` (live) | 3 | 0 | **0** |
| `e06f2169-…` (this run) | 3 | 0 | **0** |
| `7c2dd8f0-…` (done) | 0 | 0 | 0 — *genuinely* zero |
| `7aecd6a2-…` (done) | 0 | 0 | 0 — *genuinely* zero |

**And the obvious fix is a trap.** `toolKind === 'task'` looks like the spelling-proof replacement
— it is what the display layer keys on — but `tool-display.ts:159-165` maps `case 'skill':` to that
same `toolKind`, so the naive fix trades a false negative for a false positive on exactly the step
this spec changes. S1 states the rule that avoids it.

**This does not overturn §4's finding wholesale, and the spec should not pretend it does.**
`7c2dd8f0` really did not fan out, and §4's five-run sample stands for the runs it measured. What is
no longer supportable is the categorical claim *"chosen exactly 0 times"*: at least one completed
run since then dispatched three sub-agents and was recorded as having dispatched none.

### 2. A child's tool calls are billed to the parent's step

`packages/cezar/src/core/claude-cli-runner.ts:800-802` emits a v1 `tool-call` for **every**
`tool_use` block:

```ts
} else if (b.type === 'tool_use' && b.id && b.name) {
  ctx.toolCalls.push({ id: b.id, name: b.name, input: b.input });
  ctx.onEvent?.({ type: 'tool-call', id: b.id, tool: b.name, input: b.input });
}
```

There is no `parent_tool_use_id` test here — unlike the v2 mapper, which filters at
`claude-ui-mapper.ts:264-265` (`mainAgentPromptTokens` returns `undefined` for a subagent frame).
`workflows/run.ts:4319` then stamps `stepId: step.id` on all of them. The persisted v1 `tool-call`
keys are exactly `['id','input','seq','stepId','tool','ts','type']` — no parent field.

So on `70f19253`'s `context` step, **93 of 106 metered calls were made by sub-agents inside their
own context windows**, and the parent's real spend was 13.

### 3. Therefore every acceptance criterion is currently unmeasurable

- *"non-zero `sub` column"* — blocked by §1.
- *"the parent step's peak context is measurably lower"* — **no per-step peak-context metric exists
  anywhere in the codebase.** The raw material does: `context.updated` events are persisted with
  `stepId` (`run.ts:4618` via `makeUiSink`) and are **main-agent-only by construction**, because
  `mainAgentPromptTokens` returns `undefined` when `parent_tool_use_id` is present. `stats.ts`
  discards them at its `default: break;`. The only `peak*` fields in the repo are `peakRssBytes` /
  `peakProcCount` (`runs/store.ts:412-416`).
- *"batch factor … before and after"* — contaminated by §2, and see *Open questions* on what a move
  in it would even prove.

### 4. Which read-heavy step is actually not fanning out

`e9ed8f5a` (*"split the record read from the spec, review it, and gate it on approval"*, spec
`.ai/specs/2026-08-20-split-steps-spec-review-and-approval-gate.md`, KB `specs-9a01e3bf2eeb`) split
the old `spec` step into `context` → `spec` → `review-spec` and moved `Task` to `context`
(`types.ts:568`). `types.ts:619-621` states the intent: *"`Task` is deliberately NOT granted here —
the writing is the one job that must not be delegated"*, pinned by `types.test.ts:186`.

The two steps that hold `Task` today read very differently:

| | `context` (`types.ts:593-601`) | `document` (`types.ts:839-841`) |
| --- | --- | --- |
| form | its own paragraph: *"Then go WIDE… run up to THREE sub-agents (`Task`) on them in parallel in a single turn"*, plus four bulleted rules | a subordinate clause inside the batched-read sentence: *"and fan the deeper reads out to at most three READ-ONLY sub-agents (`Task`) in a single turn"* |
| names the three jobs | yes, as independent work | yes, parenthetically |
| observed dispatches | **3 of 3 runs** (`c10864d1` pre-split as `spec`, `e06f2169`, `70f19253`) | **0 of 2 runs** (`c10864d1` 38 own calls, `7c2dd8f0` 45) |

That is a clean natural experiment with the same grant, the same model and the same doctrine on both
sides. **The prompt's form, not the tool grant, is what predicts adoption** — consistent with
`notion-333c1a0a847b`'s own conclusion that *"naming a tool in the allowlist is not what unlocks
fan-out; **the prompt is**."*

## Solution

Three changes, in strict order, each shippable alone.

**S1 — Re-base the meter on the v2 item stream it already has.** Pre-pass the sorted events once to
build two id sets from `item.started` where `item.kind === 'tool'`:

- `childIds` — items carrying `parentItemId`. Their v1 `tool-call` / `tool-result` events are
  excluded from the parent's `roundTrips`, `batchFactor`, `cheapCalls` and `modelMs`, and counted
  into a new `childToolCalls`.
- `dispatchIds` — items with `toolKind === 'task'` **whose lowercased tool name is not `skill`**.
  These are the sub-agent dispatches, counted into `subAgentCalls`, bucketed by the `stepId` on the
  matching v1 `tool-call` event. Spelling-proof (`Task` / `Agent` / opencode's `task` all normalise
  to the same `toolKind` at `tool-display.ts:144-155`) and backend-agnostic, because `toolDisplay()`
  is the protocol layer every backend passes through.

  **The `skill` exclusion is not defensive padding — without it this counter cannot answer the one
  question the spec exists to answer.** `tool-display.ts` returns `toolKind: 'task'` from **two**
  cases, not one: the dispatch case at `:144-155`, and `case 'skill':` at `:159-165`
  (`{ toolKind: 'task', title: 'Skill: …' }`), which groups skill rows with task rows for display.
  A bare `toolKind === 'task'` test therefore scores a `Skill` invocation as fan-out. That lands
  squarely on this spec's go/no-go: §V4's acceptance is `subAgentCalls ≥ 1` on `document`, and
  `document` is the step most likely to invoke a skill (`/cezar-sync` and neighbours). `Skill` is
  reachable there even though it is absent from `document`'s allowlist, because `--allowedTools`
  only grants **additively** on a Claude run (`types.ts:565-567`). One skill call would make the
  acceptance pass with zero fan-out — precisely the class of instrument error this spec was written
  to remove. The exclusion is a single lowercased string compared against the one non-dispatch case
  that yields `toolKind: 'task'`; `toolDisplay` already lowercases (`tool-display.ts:96`), so the
  implementer reuses that normalisation rather than inventing a second one.

  **Cross-check, not a second mechanism.** A dispatch can also be identified structurally: a tool
  item whose `id` appears as some other item's `parentItemId`. Measured on both fanned-out
  transcripts, that set is **exactly** the `Agent` tool-call id set — 3 of 3 on `c10864d1` and on
  `e06f2169`, with `dispatchIds === parentIds === agentToolCallIds` on both. It is skill-proof and
  spelling-proof for free, but it misses a dispatch that produced no child items, so it is **not**
  the rule; §V2 asserts the two definitions agree on the fixture, which is how a future divergence
  (a new tool mapped to `toolKind: 'task'`) surfaces as a failing test rather than as a silent
  false positive.

**Degradation is exact and is why the existing fixture does not move.** A transcript with no
`item.*` events yields empty sets, so every call is "own" and `roundTrips`/`batchFactor` are
unchanged — which is precisely the `ec6e8e06-trimmed.ndjson` fixture (measured: it contains only
`lifecycle`, `step-start`, `tool-call`, `tool-result`, `step-end`; **no `item.*` at all**). For such
transcripts `subAgentCalls` falls back to a case-insensitive name match on `Task`/`Agent`/`task`, so
old logs still answer the question they were asked. `ec6e8e06`'s answer stays `0`, correctly.

**S2 — Compute `peakContextTokens` per step** from the `context.updated` events already persisted:
`max(contextTokens)` grouped by `stepId`. This is the metric acceptance criterion 2 names and it
exists nowhere today. It is `undefined`, not `0`, when a step emitted no sample — a real case:
`7c2dd8f0`'s `spec` step has **zero** `context.updated` events while its later steps have 72–294, so
emission began part-way through that run. Printing `0` there would read as "the step used no
context", which is a lie of exactly the kind this spec exists to remove.

**S3 — Rewrite `document`'s fan-out instruction in `context`'s voice.** Promote the clause to its own
paragraph, name the three independent jobs as jobs, and carry the same rules. `document` **writes**
(`Edit`/`Write` are granted, `types.ts:818`), so the read-only bound on children is load-bearing
rather than decorative — `notion-c0cf44eded02`'s rule (*"Read-only reviewers may fan out freely.
Anything that mutates source is either serialized into one agent owning mutation for the phase…"*)
is what keeps this safe.

**Explicitly not done, and why.**

- **No `Task` for `spec`.** It would contradict `e9ed8f5a` and break `types.test.ts:186`. The task
  text says "spec or document"; `document` satisfies it without reversing a two-day-old decision.
  (This step — the one writing this spec — is the one denied `Task`, and the denial is correct: the
  citations *are* the product.)
- **No fan-out bullet in `TOOL_BUDGET_DOCTRINE`.** It rides on *every* step including the four
  deliberately denied `Task` (`types.test.ts:186`), and `system-prompt.test.ts:86` caps it at 210
  words. Telling `implement` to fan out is a measured pessimisation. It also avoids a head-on
  conflict with live run `70f19253`, which is editing that same constant right now.
- **No `parent_tool_use_id` in the v1 event.** S1 makes it unnecessary.

## Architecture

```
claude stream-json
  │
  ├─ v1 path  claude-cli-runner.ts:800-802 ──► onEvent ──► run.ts:4319 {...event, stepId}
  │            (every tool_use, parent or child)                 │
  │                                                              ▼
  ├─ v2 path  claude-ui-mapper.ts ──► UiEventSink ──► run.ts:4618 {...event, stepId}
  │            item.started {kind:'tool', id, toolKind, parentItemId?}
  │            context.updated {contextTokens}      (main-agent frames only)
  │                                                              │
  │                                                    .ai/cezar/runs/<id>.ndjson
  │                                                              │
  └──────────────────────────────────────────────────────────────┘
                                                                 ▼
                                     runs/stats.ts  computeRunStats()
                                       pass 1: item.started → childIds, dispatchIds   ← NEW
                                               context.updated → peak per step        ← NEW
                                       pass 2: v1 tool-call/result, children excluded ← CHANGED
                                                                 │
                                                    cez run stats <id> [--json]
```

The join that makes this work: **the v1 `tool-call.id` and the v2 `item.id` are the same
`toolu_…` string.** Verified across four transcripts — `unmatched: 0` in every step of every run.
`computeRunStats` stays pure and order-independent (it already sorts by `seq` first), because the
pre-pass runs over the whole sorted array before any counting.

## Data models

`StepStats` (`packages/cezar/src/runs/stats.ts`) gains three fields; two change meaning.

```ts
export interface StepStats {
  stepId: string;
  wallMs: number;
  restarts: number;

  /** UNCHANGED: every tool call stamped with this step, parent's and children's alike. */
  toolCalls: number;
  /** NEW: calls made by a sub-agent inside its own window (v2 item carried `parentItemId`). */
  childToolCalls: number;
  /** NEW: `toolCalls - childToolCalls`. What this step's own agent actually spent. */
  ownToolCalls: number;

  /** CHANGED: maximal runs of consecutive OWN tool-calls. Children no longer split a batch. */
  roundTrips: number;
  /** CHANGED: `ownToolCalls / roundTrips`. */
  batchFactor: number;

  /** NEW: max `context.updated.contextTokens` seen in this step — main-agent window only.
   *  `undefined` when the step emitted no sample; never coerce to 0. */
  peakContextTokens?: number;

  /** CHANGED SEMANTICS: sub-agent DISPATCHES — v2 items with `toolKind === 'task'` and a tool name
   *  that is not `skill` (see S1) — not `tool === 'Task'`. Attributed to the step on the MATCHING
   *  v1 `tool-call` event, i.e. the dispatching parent's step, never a child's. */
  subAgentCalls: number;

  /** UNCHANGED and worth naming while this file is being re-documented: `toolExecMs` SUMS per-call
   *  durations, so a step that dispatches three sub-agents in one turn triple-counts that wall
   *  time. Pre-existing, not introduced here, and not fixed here — but do not read it as elapsed
   *  time on a fanned-out step. `wallMs` is the elapsed figure. */
  toolExecMs: number;   // own calls only
  modelMs: number;      // own gaps only
  cheapCalls: number;   // own calls only
  cheapExecMs: number;  // own calls only
}
```

`RunStats.totals` is `Omit<StepStats,'stepId'|'restarts'>` and picks the new fields up by summation,
except `peakContextTokens`, which is a **max across steps**, not a sum — summing peaks would invent
a number no window ever held. `RunStats.runId` / `spanMs` unchanged.

**Nothing is persisted.** `stats.ts` remains a pure replay of the NDJSON; no field is added to
`runs.json`, so `runs/store.ts` and the contract-parity tests do not move — the same posture commit
`1f1078a4` established, and the reason it is safe to re-meter old recordings with new arithmetic
(`BACKWARD_COMPATIBILITY.md` §7, append-only event log).

## API contracts

**`cez run stats <runId>` — human table.** Three columns added to `formatRunStats`
(`stats.ts:283-320`); `calls` becomes own-calls so the table reads as the step's own spend, with the
child count beside it.

```
step             calls  child  trips  batch  model s  exec s  wall s  cheap  cheap s  sub   ctx k
----------------------------------------------------------------------------------------------
context             21     80     21   1.00    412.3    38.1   498.0     14      6.2    3   141.7
spec                 9      0      9   1.00     96.4     4.4   118.7      7      2.1    0    86.6
```

**`cez run stats <runId> --json`** gains `childToolCalls`, `ownToolCalls`, `peakContextTokens?` per
step and in `totals`. **This is an additive JSON change to a filesystem-only CLI with no HTTP
surface and no stored consumer** — the only readers are `stats-cli.ts` and `stats.test.ts`.
`toolCalls` keeps its name and its meaning; `roundTrips`, `batchFactor` and `subAgentCalls` keep
their names and become *correct*, which is a behaviour change worth stating in the commit.

No workflow-definition schema change: `document`'s edit is prompt text only. No `verify` block is
added (see Phase 4).

## Phases

Independently shippable, in this order. **Phase 1 ships first and alone** — the standing rule that
decisions come from measured numbers is the whole reason this task exists at all.

- **Phase 1 — Fix the meter (attribution + spelling), and correct the record it falsified.**
  `runs/stats.ts` pre-pass, `childToolCalls` / `ownToolCalls`, own-only round trips,
  `toolKind`-based `subAgentCalls` with the `skill` exclusion and the name-match fallback.
  Table + `--json`. **No agent behaviour changes.** Deliverables:
  1. `cez run stats c10864d1-… --repo /var/lib/cezar/loki-labs/cezar` prints `sub 3` for a step
     that dispatched three sub-agents, and the `ec6e8e06` fixture test passes **unmodified**.
  2. **The stale record is marked in place, not appended beside.** This spec's central finding is
     that a record written two days ago states a measurement the instrument could not make. The
     workspace rule (`CLAUDE.md` sync rule 3a; the global *"a correction marks what it invalidates,
     in place"*) requires editing the entry that is wrong, so this is a phase deliverable and not a
     footnote. Executed by this task's own `document` step, which is the step that writes records.
     Targets and exact wording constraints:

     | target | what is stale | what replaces it |
     | --- | --- | --- |
     | KB `notion-cc6ebabb2ab4` (`notion-export/knowledge/notes/cezar-run-speed-is-round-trip-bound-not-box-bound--local.md`) — title asserts *"sub-agent calls are still exactly 0"*, table prints `0` for five runs | the **method**, not necessarily every cell: the counter it quotes matches `tool === 'Task'`, which the backend never emits | a `CORRECTED 2026-08-21` lead-in saying the counter was blind, plus the confirmed numbers below. **Do not restate all five cells as wrong** — see the honesty constraint. |
     | `.ai/specs/2026-08-20-agent-round-trip-batching-and-fanout.md` line 3 (`Status: PARTIAL … §4 … has NOT been run`) and its *Status log* bullet *"§4 (the runtime A/B): NOT RUN"* | §4 **has** run, on 2026-08-21 | mark both in place, pointing at KB `notion-cc6ebabb2ab4` for what it measured and at this spec for what the measurement could not see |
     | same spec, its §4 acceptance *"`subAgentCalls > 0` in the `spec` step"* | it was evaluated with a counter that reads 0 unconditionally | note that the criterion was untestable as written until Phase 1 |

     **Honesty constraint on that correction.** Of the five runs in the KB table, only two can be
     re-metered from anything on this box: `7c2dd8f0` (local transcript; `"tool":"Agent"` ×0,
     `"tool":"Task"` ×0 — **genuinely** `sub 0`) and `ec6e8e06` (survives only as
     `ec6e8e06-trimmed.ndjson`; also genuinely `0`). `202d099e`, `50ce87f1` and `be31d9e9` have
     **no local transcript** — verified by listing `.ai/cezar/runs/`. Their `sub 0` therefore
     cannot be re-derived and must be marked **unverifiable**, not silently rewritten. What *is*
     provable and what the correction should say: three runs completed since that note
     (`c10864d1`, `70f19253`, `e06f2169`) each dispatched **three** sub-agents and each was
     recorded as having dispatched **none**. That turns *"never chosen"* into *"chosen and
     unrecorded"* without overclaiming.
- **Phase 2 — `peakContextTokens` per step.** From `context.updated`. `undefined` when unsampled.
  Deliverable: acceptance criterion 2 becomes expressible. Independently useful — it is the first
  per-step context metric cezar has.
- **Phase 3 — Rewrite `document`'s fan-out instruction (`types.ts:839-841`).** Prompt-only, in
  `context`'s imperative voice, keeping the strings `types.test.ts:197` pins **and keeping
  `RECORD_READ_RECIPE` in the prompt** — a third test pins that separately
  (`types.test.ts:210-213`, *'opens the record-reading steps with ONE batched, bounded,
  non-aborting script'*), and the clause being rewritten is the same sentence that introduces the
  recipe, so it is easy to drop by accident. Deliverable: the one behaviour change in this spec.
- **Phase 4 — Runtime A/B, and the decision that follows it. THIS PHASE CANNOT EXECUTE INSIDE THIS
  TASK, and the spec says so rather than leaving an implementer to discover it.** The chain is
  `context → spec → review-spec → implement → run-tests → commit-push → document → deploy`
  (`types.ts:553-861`, pinned by `types.test.ts:88`): **`document` runs BEFORE `deploy`**, and the
  running cezar service executes its own compiled workflow definition from
  `/opt/cezar/packages/cezar/dist/workflows/run.js`. So Phase 3's rewritten `document` prompt
  physically cannot reach *this* run's `document` step — it reaches the first run started after
  this task's `deploy` step restarts the service. §V4 steps 2–5 therefore describe a **subsequent
  run**, not an in-PR checklist. Reading them as one produces either a false failure ("the step
  didn't fan out") or an A/B against a step that is still executing the old prompt.

  Run a `document`-reaching task and meter it against the two recorded baselines (§V4). If
  `document` still does not fan out, the prompt-form hypothesis is **falsified** and the finding is
  recorded rather than patched over; the fallback is a `fanned-out` post-condition, which is
  **blocked on wiring** and is specified but not built here: `evaluatePostcondition` receives only
  `{cwd, workspaceRun, probeTimeoutMs, dryRun}` (`postconditions.ts:48-68`, called at
  `run.ts:5292`) and `verify.command` spawns with `env: process.env` (`run.ts:5342`), so neither can
  see `CEZ_TASK_ID` — it is set only in `agentEnv` (`run.ts:995`). A run/step id must reach
  `PostconditionContext` before any check can read a run's own transcript. **Do not start Phase 4's
  fallback without a separate spec for that plumbing.**

  Phase 4 is filed as a follow-up task by this run's `document` step, with both baselines pasted in
  so the next session does not re-derive them:

  ```bash
  cezar todo add "Meter the document step's fan-out after the rewritten prompt is deployed" \
    --project cezar \
    --context "Phase 4 of .ai/specs/2026-08-21-sub-agent-fanout-adoption-and-attribution.md. \
  The rewritten document prompt only reaches runs STARTED AFTER the deploy that shipped it, \
  because document runs before deploy in the same chain. Baselines, document step, meter fixed \
  (Phase 1): c10864d1 own 38 / trips 38 / batch 1.00 / sub 0 / peak ctx 141783; \
  7c2dd8f0 own 45 / trips 44 / batch 1.02 / sub 0 / peak ctx 167235." \
    --acceptance "cez run stats <newRunId> shows subAgentCalls >= 1 on the document step" \
    --acceptance "peakContextTokens and ownToolCalls on document recorded beside both baselines" \
    --acceptance "if sub is still 0, the falsification is written into the spec's status log"
  ```

**Which acceptance criteria close where.** Splitting this honestly is the point:

| criterion | closes | how |
| --- | --- | --- |
| 1 — *a read-heavy step dispatches at least one sub-agent, verified by a non-zero `sub` column* | **in this PR**, Phases 1–2 | Re-metering `c10864d1` / `e06f2169` / `70f19253` prints `sub 3` on the `context` step. A read-heavy step **did** dispatch sub-agents; only the meter said otherwise. The task's own premise — *"chosen exactly 0 times"* — is answered by the meter, on runs already on disk. |
| 3 — *batch factor and sub-agent count recorded for the same step before and after* | **in this PR**, Phase 1 | The before/after is recorded for the same step id on the same transcripts (§V4 step 1): `context` on `70f19253` reads `1.07 / sub 0` today and `1.18 / sub 3` after. Proven by the meter, not asserted. |
| 2 — *the parent step's peak context is measurably lower than the pre-change equivalent step* | **follow-up run**, Phase 4 | Needs the rewritten `document` prompt to have run, which needs the deploy. Phase 2 makes the metric exist; the comparison needs a second run. |
| 1 again, for `document` specifically | **follow-up run**, Phase 4 | Same reason. |

Phase 3 is the only phase that touches an agent's behaviour; Phases 1–2 touch one module.

## Analytics

The feature is its own analytics, as in the parent spec. Metrics, in the order they should be
trusted:

- **`subAgentCalls` per step** — primary for criterion 1. Load-independent count.
- **`ownToolCalls` per step** — the honest round-trip spend. **This replaces `batchFactor` as the
  primary adoption metric**, because fan-out reduces the parent's *number* of round trips while
  leaving *calls per turn* untouched (measured: own-only `batchFactor` is 1.00 on both `c10864d1`'s
  fanned-out `spec` and `7c2dd8f0`'s non-fanned-out `spec` — identical, while own calls differ 16 vs
  38). Batch factor answers a different question and this spec says so rather than reporting a flat
  number as a null result.
- **`peakContextTokens` per step** — criterion 2, and the link to the 28:1 context ratio and the
  2.38 s → 9.55 s per-round-trip curve in `notion-cc6ebabb2ab4`.
- **`childToolCalls`** — secondary: how much exploration the children absorbed.

## Risks

| # | Risk | Mitigation |
| --- | --- | --- |
| R1 | **Changing `roundTrips`/`batchFactor` semantics silently rewrites history**, so old recorded numbers stop matching new output. | The change is a no-op on any transcript without `item.*` events, which includes every pre-v2 log and the `ec6e8e06` fixture (verified: fixture holds 5 event types, none of them `item.*`). Where it *does* change, the old number was wrong. The commit message and the spec state it; `stats.test.ts` keeps the `ec6e8e06` assertions untouched as the proof. |
| R2 | **The prompt-form hypothesis is wrong** and `document` still refuses to fan out. | Phase 4 treats falsification as the outcome, not a failure to hide, and names the fallback plus its blocker. n=2 on each side is thin and this spec says so. |
| R3 | **`document` fans out and corrupts its own work** — it holds `Edit`/`Write` and runs after `commit-push`. | Children are read-only by instruction, as `context`'s already are; `types.test.ts:197` pins `READ-ONLY` and the "three sub-agents" phrasing in both steps' prompts. `notion-c0cf44eded02` and `types.test.ts:186`'s rationale are the governing rule: mutation stays with one agent. |
| R4 | **Fan-out on reads too small to pay for themselves.** A sub-agent that reads one file costs more than it saves (`notion-333c1a0a847b`: pays only where branches are independent, ≳60 s, read-only). | The rewritten prompt carries `context`'s existing bound verbatim — *"Give each one a job whose answer is worth a minute of work. Do not fan out to read one file."* |
| R5 | **Merge conflict on `run.ts`** with live run `70f19253`, which is rewriting `TOOL_BUDGET_DOCTRINE`'s backgrounding bullet (`run.ts:519`) and `system-prompt.test.ts:91-94`. | This spec touches **neither** — that is a design decision (see *Solution*, "Explicitly not done"), not luck. Phase 3's only edit is `types.ts:839-841`. The branch is **8** commits behind `origin/main` (`20319ab0` as of this writing; it was `cf334d89` when the brief was written, so re-check rather than trusting either number); rebase before committing. |
| R6 | **`peakContextTokens` is misread as a whole-run figure.** Each step is a separate agent session with its own window (`specs-9a01e3bf2eeb`), so peaks are per-window and do not compose. | Documented on the field; `totals` takes the **max**, never the sum, and the doc comment says why. |
| R7 | **`context.updated` coverage is incomplete on older runs**, so a before/after could compare a measured step against an unmeasured one. | `undefined` ≠ 0, printed as `—`. §V4 picks baselines that actually carry samples (`document`: 141 783 and 167 235) and names the one that does not (`7c2dd8f0` `spec`: zero samples). |
| R8 | **A backend that emits no v2 items** (or a future one) loses attribution silently. | The fallback is explicit and degrades to today's behaviour, not to zero. Every backend currently routes through `toolDisplay()`, which normalises all three spellings (`tool-display.ts:144-155`). |
| R9 | **The new counter false-positives on `Skill`**, which shares `toolKind: 'task'` (`tool-display.ts:159-165`), letting §V4's go/no-go pass with zero fan-out on the step most likely to call a skill. | S1 excludes it by lowercased name; §V2 asserts a `Skill` item counts `0`; §V2 also asserts `dispatchIds` equals the structural `parentItemId` set, so any *future* tool mapped to `toolKind: 'task'` breaks a test instead of inflating the metric. |
| R10 | **Phase 4's A/B is a single uncontrolled sample.** It compares `document` on a *different* task against `document` on `c10864d1`/`7c2dd8f0`; peak context and own-call count are task-dependent, so the `< 130 000` and `< 30` thresholds are directional, not controlled. | Stated at the thresholds themselves rather than buried. The durable answer is not this one comparison: Phase 1 makes **every future run** report `sub`, `ownToolCalls` and `peakContextTokens` per step for free, so the sample grows without further work. Do not report a single A/B as proof of a magnitude. |

## Verification

Concrete and executable. The two environment traps from `AGENTS.md` § Validation apply — **the gates
lie without these**:

```bash
unset NODE_ENV
unset CEZ_REMOTE CEZ_OIDC_CLIENT_ID CEZ_OIDC_ISSUER CEZ_PROJECTS_DIR CEZ_KB CEZ_KB_ROOT CEZ_TODOS_FILE
```

**§V1 — Phase 1, against the immutable fixture (regression).** `packages/cezar/src/runs/stats.test.ts`
must pass with **its existing `ec6e8e06` assertions unedited**: `toolCalls === 271`,
`roundTrips === 271`, `batchFactor === 1`, `subAgentCalls === 0`, `cheapCalls === 231`, the `spec`
step's `restarts === 1` and `wallMs ≈ 502 800`. That is the proof that the semantic change is a
no-op where no children exist. Adjust only the `'counts Task calls as sub-agent fan-out'` case
(`stats.test.ts:164-171`) — keep it, and add its `Agent`/`toolKind:'task'` siblings.

**§V2 — Phase 1, against a real fanned-out recording (the new capability).** Add a second fixture
trimmed from `c10864d1-5dd1-4c03-b1ea-5443838c7347.ndjson` — the `spec` step's `tool-call` /
`tool-result` / `item.started` / `context.updated` lines, payloads stripped, ids and timestamps
verbatim. Assert on the `spec` step:

- `subAgentCalls === 3` (it is `0` before this phase — the headline);
- `toolCalls === 86`, `childToolCalls === 70`, `ownToolCalls === 16`;
- `roundTrips === 16` and `batchFactor === 1.00` (was 78 / 1.10);
- Phase 2: `peakContextTokens === 122650`.

Every one of those numbers was derived from the raw transcript for this spec, not estimated.

Unit cases that must also exist, each one guarding a way the counter can lie:

- **A `Skill` item does NOT count as a dispatch.** Synthesise an `item.started` with
  `kind: 'tool'`, `toolKind: 'task'`, tool name `Skill`; assert `subAgentCalls === 0`. This is the
  case that keeps §V4's go/no-go honest (R9).
- **The two definitions agree on the real fixture:** `dispatchIds` (rule) equals the distinct
  `parentItemId` set (structure) equals the `Agent` v1 `tool-call` id set — measured `3 === 3 === 3`
  on `c10864d1`, same on `e06f2169`. A future tool mapped to `toolKind: 'task'` then fails a test
  rather than inflating the metric.
- **`subAgentCalls` is billed to the dispatching parent's step**, never to a child's — assert the
  `spec` step carries all 3 and no other step carries any.
- A transcript with `item.*` but no children (own === all).
- A transcript with **no** `item.*` at all, falling back to the widened name match.

**§V3 — Phase 3, prompt composition.** `packages/cezar/src/workflows/types.test.ts` must still pass
`'grants Task fan-out to the read-heavy steps ONLY (context, document)'` (`:186`) and
`'tells the two fanned-out steps to keep their sub-agents read-only and write nothing'` (`:197`)
**unmodified** — `spec`, `review-spec`, `implement`, `run-tests`, `commit-push`, `deploy` still
without `Task`, `DEFAULT_ALLOWED_TOOLS` still without it. **And `'opens the record-reading steps
with ONE batched, bounded, non-aborting script'` (`:210-213`) must still pass** — `RECORD_READ_RECIPE`
stays in `document`'s prompt; the rewritten clause is the sentence that introduces it. Add:
`document`'s prompt names the three independent jobs and carries the "worth a minute of work" bound.

**§V4 — The runtime A/B. This decides whether Phase 3 worked, cannot be asserted from the diff, and
— step 1 excepted — CANNOT RUN INSIDE THIS TASK.** `document` executes before `deploy` in this very
chain and the service runs its own compiled definition, so the rewritten prompt first takes effect
on a run started **after** this task deploys (Phase 4). **Step 1 below closes in this PR; steps 2–5
are the follow-up task Phase 4 files.**

Recorded baselines, measured from the transcripts on disk on 2026-08-21, for the `document` step —
which held `Task` throughout and never used it:

| baseline run | own calls | trips | batch | `sub` | peak ctx |
| --- | ---: | ---: | ---: | ---: | ---: |
| `c10864d1-5dd1-4c03-b1ea-5443838c7347` | 38 | 38 | 1.00 | 0 | 141 783 |
| `7c2dd8f0-e53e-4e88-b4b3-b382c592bb12` | 45 | 44 | 1.02 | 0 | 167 235 |

Procedure:

1. **(in this PR)** Land Phases 1–2. Re-run `cez run stats <id> --repo /var/lib/cezar/loki-labs/cezar`
   on **both** `document` baselines **and** on the three runs whose `context` step fanned out
   (`c10864d1`, `70f19253`, `e06f2169`), and paste the corrected tables into this file's status log.
   This is the "before", it is honest only after the meter is fixed, and it is what closes
   acceptance criteria 1 and 3 — the `context` rows print `sub 3` where the old meter printed
   `sub 0`, on transcripts that already exist.
2. **(follow-up run, after deploy)** Land Phase 3. Run one task through the full chain to
   `document`. Note this is a *different task* from either baseline, so step 4's magnitudes are
   directional (R10); only the `sub ≥ 1` test is categorical.
3. `cez run stats <newRunId>` and compare the `document` row.
4. **Acceptance** (criteria 1–3, made measurable):
   - `subAgentCalls ≥ 1` on `document` — **criterion 1**, and the go/no-go;
   - `peakContextTokens` on `document` **below 130 000** (≥ 8% under the lower baseline, ≥ 22% under
     the higher) — **criterion 2**. Directional, n=1 per side, different task: report it with that
     caveat attached, never as a measured effect size;
   - `ownToolCalls` on `document` **below 30** (from 38 / 45) — same caveat; the load-independent
     proxy for criterion 3, with `batchFactor` reported beside it and interpreted per *Analytics*
     rather than treated as the headline;
   - **no quality regression**: the KB entry, spec status update and tracker sync `document`
     produces still land, and `everything-committed` (`types.ts:812`) still passes — fan-out must
     not cost the step its own product.
5. **Report as measured.** If `document` still shows `sub 0`, record the falsification in the status
   log and stop; do not iterate the prompt more than once before writing down what was tried.

**§V5 — Full gates.** `npm run typecheck` and `npm test` green with the unsets above. Known
pre-existing failure, **not** caused by this work: `src/knowledge/catalog.test.ts` C18, a
machine-speed perf budget that flakes under load on this box — reproduce it at clean `HEAD` before
attributing it.

**§V6 — What this spec does not claim.** It does not show that fan-out makes a run *faster* in wall
clock; it shows the parent spends fewer round trips and holds less context, which is what
`notion-cc6ebabb2ab4`'s latency curve says should matter. It does not touch `implement`,
`run-tests`, `commit-push` or `deploy`, and nothing here weakens the argument for keeping them
serial. It does not measure per-sub-agent tokens or cost — `specs-d53ef835ba5f` rules that out of
scope and this spec adds no protocol to get it.

## Open questions

Answered here, from the brief's list, so the implementer does not re-litigate them:

1. **Order of operations** — meter first (Phase 1), unambiguously. Fixing it retroactively corrects
   `c10864d1` to `sub 3`, which is itself a deliverable: it turns a *"never chosen"* record into a
   *"chosen and unrecorded"* one. That correction is **carried by Phase 1, deliverable 2** — marked
   in place on KB `notion-cc6ebabb2ab4` and the parent spec's status log, with the three
   re-derivable runs separated from the three whose transcripts no longer exist. It is not left as
   an observation in this file.
2. **Which counter** — v2 `toolKind === 'task'` **minus the `skill` case** (`tool-display.ts:159-165`
   returns that same kind for `Skill`, and `document` is the step most likely to call one), with a
   widened name match only as the no-v2 fallback and the structural `parentItemId` set as a test-time
   cross-check. Spelling-proof and backend-agnostic; the `ec6e8e06` fixture contract survives intact.
3. **Parent/child attribution** — from `parentItemId` on persisted v2 items. **No protocol widening
   needed**, because the events are already on disk and their ids already join to the v1 stream
   (measured: 0 unmatched across 4 transcripts).
4. **Prompt or post-condition** — prompt, tested as a hypothesis (Phase 3/4). The post-condition
   route is specified as the fallback *and* named as blocked on `PostconditionContext` plumbing.
5. **Doctrine vs step prompt** — step prompt. The doctrine reaches steps deliberately denied `Task`
   and is capped at 210 words; adding fan-out there would be wrong on both counts.
6. **What the "before" is** — `document` on `c10864d1` and `7c2dd8f0`: same step id, `Task` granted
   in both, never used in either, and both carry `context.updated` samples. `ec6e8e06`'s full
   transcript **does not exist locally** (only the trimmed fixture) and its workflow was a different
   shape, so it is the meter's regression anchor, not the A/B baseline.
7. **Does batch factor still mean anything here?** — Not as this task's headline, and the spec says
   so with numbers rather than quietly dropping it (see *Analytics*). It stays in the table because
   it is the parent spec's primary metric for a *different* lever; `ownToolCalls` is this spec's.
   Todo `3dd1907d-d7ac-4563-888b-6095d04a4b0a` already records the related complaint that perfect
   batching can read as `1.00`; nothing here closes that, and it is not this spec's job.

Still genuinely open, and deliberately not answered:

- **Why did `7c2dd8f0`'s `spec` step emit zero `context.updated` events** while its later steps
  emitted 72–294? Most likely the cezar service was restarted mid-run (that run deployed cezar
  itself), but nothing in the transcript proves it. Recorded so the next session does not read the
  gap as a bug in Phase 2.
- **Is `context`'s 3-of-3 adoption stable, or an artifact of these particular tasks?** n=3, all
  record-gathering tasks of similar shape. Phase 1 makes every future run answer this for free.

---

## Status log — 2026-08-21

**Status: PARTIAL.** Phases 1, 2 and 3 landed. Phase 4 is a follow-up by construction, not by
omission — `document` runs before `deploy` in this same chain, so the rewritten prompt physically
cannot reach this run's own `document` step.

### What landed

| Phase | Landed | Where |
| --- | --- | --- |
| 1 — meter: attribution + spelling | yes | `src/runs/stats.ts` (`indexToolItems`, `dispatchIdsByStructure`, child exclusion, `toolKind`-based `subAgentCalls` with the `Skill` exclusion and the widened name fallback), table + `--json`; fixture `src/core/__fixtures__/runs/c10864d1-trimmed.ndjson`; tests in `src/runs/stats.test.ts` |
| 2 — `peakContextTokens` per step | yes | `src/runs/stats.ts` (`context.updated` case; `undefined` when unsampled; `totals` takes the **max**), `ctx k` column |
| 3 — `document`'s fan-out prompt | yes | `src/workflows/types.ts` — the subordinate clause promoted to its own imperative paragraph in `context`'s voice; assertions in `src/workflows/types.test.ts` |
| 4 — runtime A/B | **no, and cannot here** | filed as a follow-up todo with both baselines attached (see below) |

`StepStats` gained `childToolCalls`, `ownToolCalls` and `peakContextTokens?`; `roundTrips`,
`batchFactor` and `subAgentCalls` kept their names and became correct. Nothing is persisted —
`runs/store.ts` and the contract-parity tests did not move.

### §V4 step 1, as actually executed — the corrected tables

`cez run stats <id> --repo /var/lib/cezar/loki-labs/cezar`, run 2026-08-21 against the fixed meter.
`70f19253` and `e06f2169` were still executing when metered, so their later steps are partial; the
`context` rows are complete and are the ones that matter.

| run | step | old `calls` | own | child | trips | old `batch` | new `batch` | old `sub` | **new `sub`** | peak ctx |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `c10864d1` | `spec` | 86 | **16** | 70 | 16 | 1.10 | 1.00 | 0 | **3** | 122 650 |
| `e06f2169` | `context` | 101 | **21** | 80 | 21 | 1.12 | 1.00 | 0 | **3** | 141 658 |
| `70f19253` | `context` | 106 | **13** | 93 | 11 | 1.07 | 1.18 | 0 | **3** | 119 560 |
| `7c2dd8f0` | `spec` | 38 | 38 | 0 | 38 | 1.00 | 1.00 | 0 | **0** | — *(no sample)* |
| `ec6e8e06` (fixture) | all | 271 | 271 | 0 | 271 | 1.00 | 1.00 | 0 | **0** | — *(pre-`context.updated`)* |

The `document` baselines for Phase 4, re-derived with the fixed meter and now pinned by
`stats.test.ts`:

| baseline run | own calls | child | trips | batch | `sub` | peak ctx |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `c10864d1` | 38 | 0 | 38 | 1.00 | 0 | 141 783 |
| `7c2dd8f0` | 45 | 0 | 44 | 1.02 | 0 | 167 235 |

**What this closes, and what it does not.**

- **Criterion 1 — a read-heavy step dispatches at least one sub-agent, non-zero `sub`: CLOSED.**
  Three runs, three dispatches each, on transcripts that already existed. The premise *"chosen
  exactly 0 times"* was the meter's, not the agents'.
- **Criterion 3 — batch factor and sub-agent count recorded for the same step before and after:
  CLOSED**, in the table above: same step ids, same transcripts, before and after the fix.
- **Criterion 2 — the parent's peak context measurably lower: NOT CLOSED.** Phase 2 makes the
  metric exist (it did not before); the comparison needs the rewritten `document` prompt to have
  run, which needs the deploy. Filed, not asserted.

**A finding worth keeping, because it changes which metric to watch.** `batchFactor` is the wrong
headline for fan-out. On `c10864d1`, own-only batch factor is **1.00** on the fanned-out `spec`
step and **1.00** on `7c2dd8f0`'s non-fanned-out `spec` step — identical — while own calls differ
**16 vs 38**. Fan-out cuts the *number* of the parent's round trips, not the calls per turn. Watch
`ownToolCalls` and `peakContextTokens`; report `batchFactor` beside them, never as the verdict.

### Phase 1, deliverable 2 — the record corrected in place

- `.ai/specs/2026-08-20-agent-round-trip-batching-and-fanout.md`: status header amended (the
  falsehood was in the heading), §4's `subAgentCalls > 0` acceptance criterion marked as untestable
  as written, and the *Status log* bullet *"§4 (the runtime A/B): NOT RUN"* rewritten to record
  that it ran, that its batching half stands, and that its fan-out half was an instrument error.
- KB `notion-cc6ebabb2ab4`
  (`notion-export/knowledge/notes/cezar-run-speed-is-round-trip-bound-not-box-bound--local.md`) —
  **still to do**, by the `document` step, which owns the knowledge mount. Honesty constraint from
  Phase 1 applies: only `7c2dd8f0` and `ec6e8e06` can be re-metered (both genuinely `0`);
  `202d099e`, `50ce87f1` and `be31d9e9` have no local transcript and must be marked
  **unverifiable**, not rewritten.

### Verification, as actually executed

- **§V1 (the `ec6e8e06` fixture, unmodified): PASS.** 271 / 271 / 1.00 / `sub 0` / 231 cheap calls
  / `spec` `restarts === 1` at 502.8 s — every existing assertion unedited, plus two new ones
  pinning the degradation contract (`childToolCalls === 0`, `peakContextTokens === undefined`).
- **§V2 (the `c10864d1` fixture, new): PASS.** `sub 3`; 86 / 70 / 16; 16 trips at 1.00; peak
  122 650. Plus: a `Skill` item counts `0`; the `toolKind` rule agrees exactly with the structural
  `parentItemId` set and with the raw `Agent` call ids (3 === 3 === 3); dispatches bill to the
  dispatching step; a child's *results* are excluded too, or they re-split the parent's batch.
- **§V3 (prompt composition): PASS.** `types.test.ts` 72/72 — the three pinned cases
  (`Task` granted to `context`+`document` only, sub-agents `READ-ONLY`, `RECORD_READ_RECIPE` still
  opening both steps) pass **unmodified**, plus a new case asserting the fan-out paragraph's form
  in both steps.
- **§V4: step 1 done (above). Steps 2–5 are the follow-up.**
- **§V5 (full gates): typecheck GREEN; `npm test` 9 500 passed / 2 failed, both pre-existing and
  outside this diff** — `knowledge/catalog.test.ts` C18 (the documented CPU-budget flake: 55.3 ms
  against a 40 ms budget on a box running three tasks at once) and `workspace/home-safety.test.ts`
  (a `spawnSync` failure in its nested suite run). Both fail at clean `HEAD` too. The authoritative
  run is the next step in this chain.

  **Attribution was done by measurement, not assertion:** the same suite at clean `HEAD` (my four
  source files reverted, fixture moved aside) failed **15 files / 19 tests**; with this change,
  **14 / 18** — a strict subset. No test that passes without this change fails with it.

### A correction this work produced, recorded rather than fixed quietly

**`AGENTS.md` § Validation's env guidance is missing `TMPDIR`, and that one variable accounts for
twelve failing test files on this box.** A cezar agent run sets
`TMPDIR=<repo>/.ai/cezar/tmp/<taskId>` — *inside the git repository*. Every test that `mkdtemp`s a
scratch directory and expects it NOT to be a git repo (or to be a repo of its own) therefore gets a
directory whose `git rev-parse --show-toplevel` answers `/var/lib/cezar/loki-labs/cezar`. Measured,
full suite, all other documented unsets applied:

| env | failing files | failing tests |
| --- | ---: | ---: |
| as inherited by an agent run | 14 | 18 |
| identical, plus `TMPDIR=/tmp` | **2** | **2** |

`runs/stats-cli-wiring.test.ts` was in that cluster and looks alarming — it is this spec's own
module — but its failure is the same artifact: the CLI resolved the temp repo's root to the real
checkout and correctly reported `no transcript`. It passes with `TMPDIR=/tmp`. So the scrub line
future sessions run should be `env -u … TMPDIR=/tmp npm test`. Worth a todo against `AGENTS.md`,
alongside the six-variable omission the parent spec's status log already records.

### Phase 4, filed rather than pretended

```bash
cezar todo add "Meter the document step's fan-out after the rewritten prompt is deployed" \
  --project cezar \
  --context "Phase 4 of .ai/specs/2026-08-21-sub-agent-fanout-adoption-and-attribution.md. \
The rewritten document prompt only reaches runs STARTED AFTER the deploy that shipped it, \
because document runs before deploy in the same chain. Baselines, document step, meter fixed \
(Phase 1): c10864d1 own 38 / trips 38 / batch 1.00 / sub 0 / peak ctx 141783; \
7c2dd8f0 own 45 / trips 44 / batch 1.02 / sub 0 / peak ctx 167235." \
  --acceptance "cez run stats <newRunId> shows subAgentCalls >= 1 on the document step" \
  --acceptance "peakContextTokens and ownToolCalls on document recorded beside both baselines" \
  --acceptance "if sub is still 0, the falsification is written into the spec's status log"
```

R10 stands: that A/B is one uncontrolled cross-task sample. The durable answer is that every run
from here on reports `sub`, `ownToolCalls` and `peakContextTokens` per step for free.
