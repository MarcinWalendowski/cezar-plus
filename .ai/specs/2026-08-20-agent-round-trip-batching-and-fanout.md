# A step should spend its time working, not asking — batch the round trips, fan out the reads

> **Status: PARTIAL** — **CORRECTED 2026-08-21: §4 HAS now been run** (KB `notion-cc6ebabb2ab4`), and its fan-out result was measured with a counter that could not see a dispatch — see `.ai/specs/2026-08-21-sub-agent-fanout-adoption-and-attribution.md`. Code for Phases 1–5 landed and committed on `cez/23221162`. §4's *batching* numbers stand (batch factor 1.00–1.02 across five runs, unmoved by the doctrine); §4's *fan-out* number does not — `subAgentCalls` matched `tool === 'Task'`, a string this backend never emits, so it read `0` unconditionally. Three runs since have each dispatched three sub-agents and each been recorded as zero. Do not cite a fan-out result from this spec; re-meter the transcript. See *Status log — 2026-08-20* at the foot of this file. · **Date:** 2026-08-20
> **Origin:** owner question on run `ec6e8e06-16e4-448f-a7b9-b00411fcc3d0` — *"there were many
> tool calls one by one - it was really slow - how we can improve it? can't we run this across
> many sub agents for each step?"* and, mid-analysis, *"maybe we can do something like codemode?
> instead of calling tools one by one?"*
>
> This spec is **about cezar's own agent loop**, not about a feature of the product surface. It
> changes prompts, one CLI verb and one workflow definition; it does not change the run protocol.

## TLDR

Run `ec6e8e06` took **61.5 minutes** and made **271 tool calls**. Measured from its own NDJSON,
the run made **1.00 tool calls per model round trip** — it never once batched two independent
calls into a single assistant turn, and never once delegated to a sub-agent. **85% of those calls
(231 of 271) finished in under a second and did 29.4 seconds of actual work between them**, yet
each one cost a full model round trip at a median of 6.1 s. That is **~23.5 minutes of the hour
spent deciding to run 29 seconds of shell.**

The owner's two instincts are both right, but they are not equally valuable, and the measurement
says which is which:

- **Code mode (batching) is the big lever.** The bottleneck is *round trips*, not tool execution.
  Collapsing the cheap calls into one script per intent attacks 23.5 minutes directly, costs
  nothing, and needs no new machinery — the agent already has `Bash`, which is a code-execution
  tool.
- **Sub-agent fan-out is the second lever, and only for the read-heavy steps.** It does not reduce
  model seconds; it *overlaps* them. It pays where a step is exploration-bound (`spec`: 467 s of
  model time against 15 s of tool time) and is actively harmful where a step is serial and
  file-mutating (`implement`) or execution-bound (`run-tests`: 617 s of it is `npm`).

Neither helps the genuinely slow part: **80% of all tool-execution time is 10 calls**, almost all
`npm ci` / `npm test`. That is attacked separately, by starting it earlier and backgrounding it.

Phase 1 ships the **meter** before any optimisation, so every later phase is provable rather than
asserted.

## Problem

### What was measured, and how

All figures below come from replaying the run's own event log,
`/var/lib/cezar/workspace/.ai/cezar/runs/ec6e8e06-16e4-448f-a7b9-b00411fcc3d0.ndjson`
(2 004 events, 2.4 MB). Method: `tool-call` → matching `tool-result` by `toolCallId` gives tool
execution time; `tool-result` → the *next* `tool-call` within the same `stepId` gives model time
("gap"); `step-start`/`step-end` give wall clock.

One correction worth recording, because it bit this analysis: the `spec` step emits **two**
`step-start` events (13:22:03 and 13:28:12) — it was restarted mid-flight when the cezar worktree
was deleted under it (the run's own handoff records this). Keying steps by `stepId` without
handling that silently reports the `spec` step as 134 s instead of its real 503 s. Any
implementation of the meter in Phase 1 must take the **first** start and the **last** end per step.

### The headline

| Metric | Value |
| --- | --- |
| Run span | **61.5 min** (13:22:00 → 14:23:29) |
| Sum of step wall clock | 60.0 min |
| Tool calls | **271** |
| Model round trips | **271** |
| **Tool calls per round trip** | **1.00** — no batching, ever |
| Sub-agent (`Task`) calls | **0** |
| In-step model time (gaps) | **2 354.7 s = 39.2 min = 65%** |
| Tool execution time | **1 089.0 s = 18.2 min = 30%** |
| Median / mean / p90 model gap | 6.1 s / 9.5 s / 19.8 s |

Tool breakdown: `Bash` ×262 (1 088.8 s), `Write` ×7 (0.1 s), `Edit` ×2 (0.04 s). Median tool
execution: **0.09 s**.

### The two distributions that decide the design

**Cheap calls dominate the count; expensive calls dominate the time.** These are two different
problems and they need two different fixes.

- **231 of 271 calls (85%) executed in under 1 second, totalling 29.4 s** — 0.8% of the run.
  At the median 6.1 s gap, those calls cost roughly **23.5 minutes of model round trips**. This is
  pure protocol overhead: `cat`, `ls`, `grep`, `sed -n`, `git log`, one per turn.
- **The 10 slowest calls account for 868.2 s = 80% of all tool execution.** They are:

  | Time | Command (truncated) |
  | --- | --- |
  | 149.6 s | `unset NODE_ENV && npm test` |
  | 148.8 s | `unset NODE_ENV CEZ_REMOTE … npm test` |
  | 148.6 s | `unset NODE_ENV && npm test` (filtered) |
  | 77.6 s | `… npm ci` |
  | 76.1 s | `cezar todo list --json … grep -rl` |
  | 76.0 s | `unset NODE_ENV && npm test -- --project web` |
  | 75.1 s / 73.8 s / 25.2 s | further gated `npm` runs |
  | 17.5 s | `npm run typecheck … npx vitest` |

  Note that **three full `npm test` runs and two `npm ci` runs** were spent partly on rediscovering
  the `NODE_ENV=production` trap — already documented afterwards in `AGENTS.md` § Validation.

### Per step — which steps are round-trip bound and which are not

| Step | Calls | Model s | Exec s | Wall s | Bound by |
| --- | ---: | ---: | ---: | ---: | --- |
| `spec` | 44 | **467.1** | 14.6 | 502.8 | **round trips** (32× model:exec) |
| `implement` | 79 | **815.4** | 79.5 | 919.2 | **round trips** (10×) |
| `run-tests` | 32 | 188.6 | **617.3** | 826.2 | execution (`npm`) |
| `commit-push` | 19 | 130.9 | **244.8** | 394.1 | execution (git/gh) |
| `document` | 47 | **360.7** | 108.8 | 492.9 | **round trips** (3.3×) |
| `deploy` | 34 | **246.9** | 21.0 | 291.1 | **round trips** (12×) |
| `continue-1` | 16 | **145.0** | 3.0 | 173.6 | **round trips** (48×) |

**Four steps — `spec`, `implement`, `document`, `deploy` — spend 1 890 s of model time against
224 s of tool time.** That is where the hour went.

### Why the agent never batched

Nothing told it to. Two concrete findings in the code:

1. **`DEFAULT_ALLOWED_TOOLS` is `['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash']`**
   (`packages/cezar/src/workflows/types.ts:210`). **`Task` is absent from every built-in step**,
   including `spec` (`types.ts:442`, `allowedTools: ['Read','Grep','Glob','Write','Bash']`). So
   fan-out is not advertised to the model anywhere.
2. **…but the allowlist does not actually restrict.** `packages/cezar/src/core/claude-cli-runner.ts:399-404`
   records, measured against `claude` 2.1.224, that `--allowedTools` **only grants additively** —
   `default` mode with `--allowedTools Read` still ran `Bash`; only `--disallowedTools` removes a
   tool. So `Task` was *available in practice* during `ec6e8e06` and the model simply never reached
   for it, because no prompt in the chain mentions delegation, parallel tool blocks, or batching.

The composed system prompt (`composeSystemPrompt`, `packages/cezar/src/workflows/run.ts:475`)
carries the skill, the workflow step prompt and the handoff contract. **It carries no doctrine
about how to spend tool calls.** That is the gap this spec fills.

### What is explicitly NOT the problem

- **Not the model's speed.** Median gap 6.1 s for a step that must read and reason is reasonable.
- **Not `maxParallel`.** That governs concurrent *runs* and was already addressed in
  `.ai/specs/2026-08-19-parallel-workspace-runs-worktrees.md`. This spec is about *within* one step.
- **Not the SSE/NDJSON protocol.** 2 004 events over 61 min is nothing.

## Solution

Four independent levers, ordered by measured payoff per unit of risk.

### L1 — Code mode: one script per intent, not one call per fact

The owner's word for it is exactly right. "Code mode" in the MCP sense means exposing tools as an
API the model calls *from code*, so N tool invocations become 1. cezar's agent already holds the
general case of that tool: **`Bash` is code execution.** What is missing is the *doctrine* and the
*output discipline* that make batching safe.

The rule, to be added to the composed system prompt:

> When you need several independent facts and each is a cheap shell command, do not spend a round
> trip per fact. Write **one** script that gathers them all and prints a labelled report. Use
> `set +e` so one missing file does not abort the rest, delimit every section with a marker, and
> bound every section's output (`head -c`, `head -n`) so a batch cannot flood the context.

So the `spec` step's opening — which in `ec6e8e06` was ~15 separate calls (`cat` the handoff,
`ls` the spec dir, `git log`, `cez kb search`, `grep` the tracker…) — becomes one call:

```bash
set +e
say(){ printf '\n===== %s =====\n' "$1"; }
say HANDOFF;   sed -n 1,80p "$CEZ_HANDOFF_FILE"
say SPECS;     ls -1 .ai/specs | tail -30
say GITLOG;    git log --oneline -15
say KB;        cez kb search "$Q" 2>&1 | head -40
say TODOS;     cezar todo list 2>&1 | head -20
```

This is a **prompt change with no new machinery**, and it attacks the 23.5-minute tax head on.

### L2 — Parallel tool blocks in a single turn

Where batching into one script is wrong — because the calls use *different tools* (`Read` +
`Grep` + `Bash`), or one is slow and the others are not — the model can still emit **multiple
`tool_use` blocks in one assistant turn**. The run did this **zero times** (1.00 calls/round trip).
The doctrine states it explicitly, with the one safety condition that matters: **only for calls
with no dependency between them.** A write followed by a read of the same path must stay serial.

### L3 — Sub-agent fan-out, for read-heavy steps only

This is the owner's original question, and the measurement supports a **scoped** yes.

Fan-out does not reduce total model seconds or tokens — it overlaps them in wall clock, at the cost
of extra tokens and per-agent startup. It therefore pays only when branches are **independent**,
**substantial** (≳60 s each), and **read-only**. Applying that test to the chain:

| Step | Fan out? | Why |
| --- | --- | --- |
| `spec` | **Yes** — 3 parallel readers | 467 s model / 15 s exec, and its four reading jobs (KB, spec dir + git history, the code, the tracker) are genuinely independent. |
| `document` | **Yes** — 2 parallel readers | 361 s model; KB/spec/changelog reads are independent. |
| `deploy` | **No** | 247 s model but inherently sequential and *mutating* — discover, then act, then verify. |
| `implement` | **No** | Serial and file-mutating; concurrent writers in one worktree corrupt each other. This is the same hazard `2026-08-19-parallel-workspace-runs-worktrees.md` solved with a worktree per run — there is no equivalent isolation *inside* a step. |
| `run-tests` | **No** | Execution-bound; parallel agents would contend for the same `node_modules` and the same loaded box. |
| `commit-push` | **No** | Serial by nature; git index is a single shared lock. |

The orchestrator keeps ownership of the *writing*: sub-agents return findings, the step's own agent
writes the spec. This preserves the quality property that makes the `spec` step worth having.

### L4 — Overlap the slow serial work

The 10 calls holding 80% of execution time cannot be batched or fanned out away, but they can be
**started earlier** and **waited on later**:

- **Warm the install.** `run-tests` spent ~155 s on `npm ci` (twice) *after* the agent had finished
  thinking. Kick the install off in the background at step start, `wait` before the gates.
- **Background the gates.** `Bash` supports `run_in_background`; a 150 s `npm test` should not
  block the model from reading the next file.
- **Do not rediscover the environment traps.** Both are already written down in `AGENTS.md`
  § Validation ("Two environment traps that make the gates lie"). The doctrine points at them so
  the chain stops paying three `npm test` runs to relearn them.

## Architecture

```
                       composeSystemPrompt(run.ts:475)
                                  │
   skill ── workflow step prompt ── ► TOOL BUDGET DOCTRINE ◄── (new, this spec)
                                  │        L1 batching
                                  │        L2 parallel blocks
                                  │        L3 when to fan out
                                  └── handoff contract
                                             │
                                             ▼
                              buildClaudeArgs (claude-cli-runner.ts:411)
                                  --append-system-prompt
                                             │
                                             ▼
                                      one agent step
                                             │
                        ┌────────────────────┼────────────────────┐
                        ▼                    ▼                    ▼
                 one batched script    parallel tool blocks   Task fan-out
                  (L1, all steps)       (L2, all steps)     (L3, spec/document)
                                             │
                                             ▼
                                   NDJSON: tool-call/tool-result
                                             │
                                             ▼
                        `cez run stats` — round trips, batch factor, model:exec
                                     (Phase 1, the meter)
```

**Where each change lands:**

| Change | File |
| --- | --- |
| Doctrine text + composition | `packages/cezar/src/workflows/run.ts` (`composeSystemPrompt`, ~:475) |
| `Task` added to step tool surface | `packages/cezar/src/workflows/types.ts` (`DEFAULT_ALLOWED_TOOLS` :210, `SPEC_TO_DEPLOY_WORKFLOW` :434+) |
| Fan-out instructions in step prompts | `packages/cezar/src/workflows/types.ts` (`spec` :442, `document`) |
| The meter | new `packages/cezar/src/runs/stats.ts` + a `cez run stats` verb in `packages/cezar/src/index.ts` |
| Record-read recipe | new `packages/cezar/src/knowledge/`-adjacent recipe, or a documented snippet in `AGENTS.md` |

**Design constraint that shapes Phase 4:** because `--allowedTools` grants but does not restrict
(`claude-cli-runner.ts:399-404`), adding `Task` is *documentation of intent* today. It becomes
load-bearing the moment the filed `--disallowedTools` follow-up lands — at which point a step whose
prompt says "fan out" but whose `allowedTools` omits `Task` would silently lose the ability. Adding
it now is what prevents that future silent breakage.

## Data models

One new type, for the meter. Computed from NDJSON on demand — **not** persisted into the run record,
so nothing in `runs/store.ts` or the contract-parity tests moves.

```ts
/** Per-step tool-economy metrics, derived from a run's NDJSON. */
export type StepStats = {
  stepId: string;
  /** First step-start → last step-end. A restarted step (see ec6e8e06's `spec`)
   *  has >1 start; take the first and the last, never a keyed overwrite. */
  wallMs: number;
  restarts: number;
  toolCalls: number;
  /** Assistant turns that issued ≥1 tool call. */
  roundTrips: number;
  /** toolCalls / roundTrips. 1.00 means no batching happened at all. */
  batchFactor: number;
  /** Σ(tool-result.ts − tool-call.ts). */
  toolExecMs: number;
  /** Σ gaps tool-result → next tool-call, same step, clamped to [0, 600s). */
  modelMs: number;
  /** Calls finishing <1s, and their summed execution time. */
  cheapCalls: number;
  cheapExecMs: number;
  subAgentCalls: number;
};

export type RunStats = {
  runId: string;
  spanMs: number;
  steps: StepStats[];
  totals: Omit<StepStats, 'stepId' | 'restarts'>;
};
```

## API contracts

**No HTTP surface changes.** `BACKWARD_COMPATIBILITY.md` §2 protects `GET /api/github` and friends;
nothing here touches a protected route.

One new CLI verb:

```
cez run stats <runId> [--json]
```

- Reads `<runsDir>/<runId>.ndjson`; no network, no server required.
- Human output: the per-step table from the Problem section above.
- `--json`: a `RunStats` object, exactly the shape above.
- Exit non-zero only if the run's NDJSON is missing or unreadable. A run with zero tool calls is
  valid output (`batchFactor: 0`), not an error.

## Phases

Each phase is independently shippable and independently valuable. **Phase 1 ships first and alone**
— the repo's own standing rule is that decisions come from measured numbers, and without the meter
every later phase is an assertion.

- **Phase 1 — The meter (`cez run stats`).** `runs/stats.ts` + CLI verb + unit tests. **No behaviour
  change to any agent.** Deliverable: the ability to state any run's round trips and batch factor.
  Baseline to beat, from `ec6e8e06`: **271 calls / 271 round trips / batch factor 1.00 / 61.5 min.**
- **Phase 2 — Tool-budget doctrine in the composed system prompt (L1 + L2).** Prompt-only. Highest
  payoff, lowest risk, no schema change. Target: **batch factor ≥ 2.0** on a comparable run.
- **Phase 3 — The record-read recipe.** One documented, copy-pasteable batch script for the "read
  the record" opening, referenced from the `spec` and `document` step prompts. Turns ~15 opening
  calls into 1.
- **Phase 4 — Sub-agent fan-out for `spec` and `document` (L3).** Add `Task` to the two steps'
  `allowedTools` and instruct a bounded parallel read fan-out (max 3, read-only, orchestrator
  writes). Target: `spec` step wall clock down from 503 s.
- **Phase 5 — Overlap the slow serial work (L4).** Background install warmup and backgrounded gate
  runs in the `run-tests` prompt, plus an explicit pointer to the `AGENTS.md` environment traps.

Phases 2–5 are prompt/definition changes; Phase 1 is the only one that adds a module.

## Analytics

The feature *is* its own analytics — that is the point of ordering Phase 1 first. Events/metrics:

- `cez run stats --json` is the measurement surface; every phase's claim is a diff of two runs of it.
- Primary metric: **`batchFactor`** (calls per round trip). Chosen deliberately over wall-clock
  seconds because **wall clock on this box is not trustworthy** — the repo already carries a
  perf-budget test (`src/knowledge/catalog.test.ts` C18) that flakes under load average 5–7 on
  8 cores, as `ec6e8e06` itself hit. Round-trip *count* is load-independent.
- Secondary: `modelMs / toolExecMs` ratio per step, `cheapCalls`, `subAgentCalls`.

## Risks

| # | Risk | Mitigation |
| --- | --- | --- |
| R1 | **A batched script hides a failure** — one section fails, the model reads the rest as success. | Doctrine mandates `set +e`, a labelled delimiter per section, and echoing `$?` for any section whose success matters. Never `set -e` in a probe batch. |
| R2 | **Batching floods the context.** 231 cheap calls returned little each; a naive `cat` of everything is strictly worse than 231 small results. | Doctrine mandates a bound per section (`head -n`/`head -c`). Phase 3's recipe ships with bounds already in it. |
| R3 | **Fan-out degrades spec quality** — sub-agents return shallow summaries and the spec is the product. | Fan-out is read-only and bounded to 3; the orchestrating agent writes every word of the spec. Verification §4 compares a fanned-out spec against this very file for citation density. |
| R4 | **`Task` in `allowedTools` is decorative today** (`claude-cli-runner.ts:399-404` — grants, does not restrict), so Phase 4 may appear to work for the wrong reason. | Stated in the spec and in the code comment at the change site. Phase 4's test asserts `Task` is *present in the built argv*, which is the part that becomes load-bearing when `--disallowedTools` lands. |
| R5 | **Parallel tool blocks on dependent calls** — a write and a read of the same path in one turn. | Doctrine states the independence condition explicitly and gives the write-then-read counter-example. |
| R6 | **Backgrounded gates (Phase 5) race the autosave/worktree machinery** or report against a tree that moved under them. | Phase 5 requires an explicit `wait` before the step reports, and forbids backgrounding anything that mutates the index. |
| R7 | **Prompt bloat.** The doctrine is added to *every* step's system prompt; tokens are not free and a long preamble can dilute the step's actual instruction. | Keep the doctrine under ~200 words. It is cached across turns (the run showed `cacheRead` 599 k against `input` 10), so its marginal cost per turn is near zero. |
| R8 | **The measurement is a single run (n=1).** `ec6e8e06` may not be representative. | Phase 1 makes every subsequent run measurable; the doctrine's effect is judged on ≥3 runs, not one. Stated plainly rather than over-claimed. |

## Verification

Concrete and executable. Note the two environment traps from `AGENTS.md` § Validation — **the gates
lie without these**, as `ec6e8e06` proved by spending three `npm test` runs on it:

```bash
unset NODE_ENV                                    # else npm ci installs ZERO devDeps
unset CEZ_REMOTE CEZ_OIDC_CLIENT_ID CEZ_OIDC_ISSUER CEZ_PROJECTS_DIR CEZ_KB CEZ_KB_ROOT CEZ_TODOS_FILE
```

**§1 — Phase 1, the meter, against a real fixture.** The strongest available test: `ec6e8e06`'s own
NDJSON is a recorded, immutable input with numbers this spec already states.

1. Copy a trimmed `ec6e8e06` NDJSON into `packages/cezar/src/core/__fixtures__/`.
2. New `packages/cezar/src/runs/stats.test.ts` asserts, on that fixture:
   - `toolCalls === 271`, `roundTrips === 271`, `batchFactor === 1.00`;
   - `subAgentCalls === 0`;
   - `cheapCalls === 231` and `cheapExecMs` ≈ 29 400 ms (±500);
   - `steps.find(s => s.stepId === 'spec')` has **`restarts === 1`** and `wallMs` ≈ 502 800 —
     the regression test for the double-`step-start` trap that broke this analysis' first pass;
   - totals: `toolExecMs` ≈ 1 089 000, `modelMs` ≈ 2 354 700 (±1%).
3. `cez run stats ec6e8e06-16e4-448f-a7b9-b00411fcc3d0` prints the per-step table; `--json` parses
   and round-trips through the `RunStats` type.

**§2 — Phase 2/4, prompt composition.** Extend `packages/cezar/src/workflows/system-prompt.test.ts`:
the doctrine appears exactly once in a composed prompt, survives a skill + handoff composition, and
`buildAllowedTools(['Read','Grep','Glob','Write','Bash','Task'], …)` emits `Task` into the argv
(`claude-cli-runner.test.ts`). `types.test.ts` asserts the `spec` and `document` steps carry `Task`
and that `implement` / `run-tests` / `commit-push` deliberately do **not**.

**§3 — Full gate suite.** `npm run typecheck` and `npm test` (with the unsets above) green.
Known pre-existing failure, **not** caused by this work: `src/knowledge/catalog.test.ts` C18, a
machine-speed perf budget that fails under load on this box — reproduce it at clean `HEAD` before
attributing it.

**§4 — Runtime A/B. This is the one that decides whether the spec worked, and it cannot be
skipped or asserted from the diff.**

1. Pick a task of comparable shape to `ec6e8e06` (a cockpit UI change with a spec-to-deploy chain).
2. Run it on the chain **before** Phase 2 lands; record `cez run stats <id>`.
3. Run an equivalent task **after** Phase 2 (and again after Phase 4); record the same.
4. Acceptance:
   - **`batchFactor ≥ 2.0`** after Phase 2 (baseline 1.00). Primary, load-independent.
   - **`roundTrips` for the `spec` step down ≥ 40%** from 44.
   - After Phase 4, **`subAgentCalls > 0` in the `spec` step** and its `wallMs` below 503 000.
     **CORRECTED 2026-08-21: this criterion was UNTESTABLE as written.** `stats.ts` counted a
     dispatch by exact equality with `tool === 'Task'`; claude emits `'Agent'`, so `subAgentCalls`
     was `0` for every run regardless of what any agent did. Evaluating it — as §4's execution on
     2026-08-21 did — could only ever produce `0`. Fixed by
     `.ai/specs/2026-08-21-sub-agent-fanout-adoption-and-attribution.md` Phase 1, which re-bases the
     counter on the v2 item stream's `toolKind`. Re-metered, run `c10864d1`'s `spec` step reads
     `sub 3`, `own 16` (not 86) and `batch 1.00` — so fan-out DID happen here, and this criterion is
     met on a transcript that already existed.
   - **No quality regression:** the spec produced by the fanned-out `spec` step still cites real KB
     ids, file paths and commit hashes, at a density comparable to this file.
5. Report the numbers as measured. If `batchFactor` moves but wall clock does not, **say so** —
   a loaded box can eat the win, and that is a finding, not a failure to hide.

**§5 — What this spec does not claim.** No measurement here shows fan-out helps `implement`,
and the file-mutation hazard argues it hurts. Anyone extending fan-out to a mutating step needs a
new isolation story first (per-agent worktrees inside a step), which is out of scope.

## Open questions

- **Was `Task` genuinely available in `ec6e8e06`?** **Answered, 2026-08-20, during Phase 4:
  yes.** The run's own `session.started` event enumerates the session's tool surface and `Task` is
  the first entry in it — so fan-out was reachable throughout and the model simply never used it,
  which confirms the "nothing told it to" diagnosis rather than an availability gap. The
  assumption is no longer inherited; it is read off the log.
- **No prior KB entry covers agent-loop round-trip economics.** `cez kb search` over
  "tool call batching / code mode / round trip latency" returned 1 496 lexical hits and nothing on
  this subject; the closest analogue is `notion-fc789d6e03cc` (*"bubble-trade price polls batch
  their D1 writes (was one round trip per row)"*) — the same shape of fix in a different plane.
  If Phase 2 measures a real win, that is a durable decision worth writing to the KB.
- **The tracker is empty** (`cezar todo list` → "no todos filed" in this workspace), so no
  duplicate or in-flight work was found to reconcile against.

---

## Status log — 2026-08-20

**Status: PARTIAL.** **CORRECTED 2026-08-21 — the paragraph below survived the correction pass and still told a reader, in this log's own opening sentence, that §4 had not run. It did run.** The 2026-08-21 pass amended this file's status header, §4's `subAgentCalls > 0` acceptance criterion and the *§4 (the runtime A/B)* bullet 28 lines further down, but not this lead paragraph, so the file contradicted itself. What is true: **§4 ran**, and the code **is deployed** — the measurement was taken against production runs on `prod-host`. §4's *batching* result stands (batch factor 1.00–1.02, unmoved by the doctrine); §4's *fan-out* result was an instrument error, because `subAgentCalls` matched `tool === 'Task'`, a string this backend never emits. See the corrected `§4` bullet below and
`.ai/specs/2026-08-21-sub-agent-fanout-adoption-and-attribution.md`. Original text, left unchanged beneath this correction:

> Code for all five phases landed and is committed. The measurement that
> decides whether any of it worked — Verification §4 — has **not** run. Nothing is deployed.

### What landed

| Phase | Landed | Where |
| --- | --- | --- |
| 1 — the meter | yes | `src/runs/stats.ts`, `src/runs/stats-cli.ts`, `cez run stats` verb in `src/index.ts`, fixture `src/core/__fixtures__/runs/ec6e8e06-trimmed.ndjson` |
| 2 — tool-budget doctrine | yes | `TOOL_BUDGET_DOCTRINE` in `src/workflows/run.ts`, on every agent step and on Continue turns |
| 3 — record-read recipe | yes | `RECORD_READ_RECIPE` in `src/workflows/types.ts`, referenced from the `spec` and `document` prompts |
| 4 — fan-out | yes | `Task` added to `spec` + `document` only; withheld from `implement` / `run-tests` / `commit-push` / `deploy`, asserted as a negative control |
| 5 — overlap the slow work | yes | backgrounding guidance in the `run-tests` prompt + the `AGENTS.md` env-trap pointer |

One wiring note worth keeping: the `stats` verb is registered **before** `parseArgs`, because
`case 'run'` would otherwise start a run literally named `stats <id>`.

### Verification, as actually executed

- **§1 (the meter against a real fixture): PASS.** `cez run stats` reproduces this document's
  table exactly off the real 2.4 MB production log, including the `spec`-step double-`step-start`
  correction (`restarts === 1`, 503 s not 134 s).
- **§2 (prompt composition): PASS.** `system-prompt.test.ts`, `types.test.ts`,
  `claude-cli-runner.test.ts` all green.
- **§3 (full gate suite): typecheck GREEN. `npm test` = 3 failed / 486 passed files (9 050 tests
  passed, 3 failed), and all three are localised away from this change:**
  - `web/src/components/add-project-dialog.test.tsx` — **passes in isolation** (24/24). Load flake.
  - `server/src/server/project-context.test.ts` W3.1 — **passes in isolation.** Load flake.
  - `server/src/knowledge/catalog.test.ts` C18 — fails in isolation too. This is the documented
    pre-existing CPU-budget failure on this box; `src/knowledge/` is untouched by this diff.
- **§4 (the runtime A/B): ~~NOT RUN~~ — CORRECTED 2026-08-21, IT RAN, AND HALF OF WHAT IT
  MEASURED WAS AN INSTRUMENT ERROR.** It was executed on 2026-08-21 over five runs (KB
  `notion-cc6ebabb2ab4`): batch factor 1.00 / 1.00 / 1.01 / 1.01 / 1.02 against the `ec6e8e06`
  baseline of 1.00, and `sub 0` in every one.
  - The **batching** half stands: the tool-budget doctrine was deployed and did not move the
    number. That is a real, reported null result.
  - The **fan-out** half does not. `sub` came from `stats.ts:178`, which matched `tool === 'Task'`
    — a spelling this backend never emits (`"tool":"Task"` occurs **zero** times in every
    transcript on this box; `"tool":"Agent"` occurs three times in each of three runs). So `sub 0`
    was what the instrument prints, not what happened, and *"fan-out was available and never
    chosen"* cannot be concluded from it. Runs `c10864d1`, `70f19253` and `e06f2169` each
    dispatched **three** sub-agents and each was recorded as having dispatched **none**.
  - Of the five runs in that table, only `7c2dd8f0` and `ec6e8e06` can be re-metered from anything
    still on this box, and both are **genuinely** `sub 0`. `202d099e`, `50ce87f1` and `be31d9e9`
    have no local transcript, so their `sub 0` is **unverifiable** — not rewritten here.
  - Fixed by `.ai/specs/2026-08-21-sub-agent-fanout-adoption-and-attribution.md` (Phase 1), which
    also found that a child's tool calls were billed to the parent's step, so fan-out RAISED the
    round-trip count §4 wanted to see fall. Todo `881c4f7b-9920-4514-8449-daef2f42fa3d`.
  **No speed claim from this spec is admissible until it has numbers, and no fan-out claim is
  admissible from numbers this counter produced.**

### Two corrections this work produced, recorded rather than fixed quietly

**1. `AGENTS.md` § Validation's env-scrub list is incomplete.** The published `env -u …` line does
not unset `CEZ_ACCOUNT_USAGE`, `CEZ_ACCOUNT_USAGE_HOSTED`, `CEZ_PUBLIC_URL`, `CEZ_BROWSE_ROOT`,
`CEZ_PORT_STRICT` or `CEZ_AUTH`, all of which a cockpit session exports. Running the documented
scrub left `health-forge.test.ts` and `projects-api.test.ts` failing; adding those six made both
pass. A nearly-complete scrub list is worse than none — it leaves failures that look like your
change. Todo `58240a6a-b8ca-451a-8c43-f6d50edfd6c2`.

**2. This spec's own chain did not finish, and reported that it had.** `run-tests` ended 25 s
after backgrounding `npm test` (1 m 30 s total) without ever reading it; `commit-push` then ended
having **committed nothing**, leaving 7 modified and 5 untracked files. Both logged `status=done`.
The doctrine this spec ships *grants* backgrounding — so it has to make a step's completion
conditional on having read the output, and `commit-push` needs a post-condition it cannot fake.
Owner instruction, on seeing it: *"everything must be committed in the commit step."*
Todo `f42e2ad2-3a24-438a-b9f0-fef3fe808cb0`.

### Dependency worth naming

Phase 4's `allowedTools` entry is inert today: `--allowedTools` only grants additively (§ *Why the
agent never batched*), so `Task` was already reachable in `ec6e8e06` and the model simply never
used it. **The prompt is what unlocks fan-out; the allowlist entry only stops the step silently
losing the grant later.** That "later" is the pre-existing todo
`444c7db2-944e-457c-adc9-ec1380270203` — *Decide what allowedTools should actually restrict* —
which already carries the flag-matrix measurement. This spec also records a real conflict for it
to resolve: `bashAllowlist` compiles to STARTS-WITH `Bash(<prefix>:*)` patterns that no
`set +e …` batch script can ever match. Either the batch runs or the allowlist does.

### Knowledge

- `notion-export/knowledge/notes/round-trips-not-tool-execution-make-an-agent-step-slow--local.md`
- `notion-export/knowledge/notes/a-chain-step-that-backgrounds-its-gate-ends-before-reading-it--local.md`
- `notion-export/changelog/2026-08-20-agent-round-trip-batching-and-fanout--local.md`
- `notion-export/tasks/local-2026-08-20-agent-round-trip-batching-and-fanout.md`
