# Make sub-agent fan-out actually happen on read-heavy steps

- Date: 2026-08-21
- Category: agent-loop / measurement
- Priority signal: high — the only lever named against the 28:1 context ratio, and the meter that would prove it is currently blind.
- Risk signal: medium — the change lands in the composed system prompt and the step-tool matrix, both pinned by deliberate negative-control tests; a live run is editing the same constant right now.
- Routing: Next: write the spec against this brief.

## Problem, in this repository's terms

`.ai/specs/2026-08-20-agent-round-trip-batching-and-fanout.md` shipped Phase 4 (grant `Task` to
the read-heavy steps) and its own Verification §4 ran on 2026-08-21 with a negative result: five
runs at batch factor 1.00 / 1.00 / 1.01 / 1.01 / 1.02 and **0 sub-agent calls in every one**
(`notion-cc6ebabb2ab4`, `notion-38870ddae120`). The conclusion recorded there — *"the tool is
present and simply never chosen… availability is not adoption"* — is the premise of this task.

**Two measurements taken for this brief show that premise is stale, in two independent ways.**

### 1. Fan-out has already been happening, and the meter reports it as zero

`packages/cezar/src/runs/stats.ts:178` counts a sub-agent call by exact string match:

```ts
if (stringOf((event as { tool?: unknown }).tool) === 'Task') bucket.subAgentCalls += 1;
```

Claude 2.x dispatches sub-agents as **`Agent`**, not `Task`. cezar's own display layer already
knows this — `packages/cezar/src/core/tool-display.ts:140-146`: *"claude dispatches these through
`Agent` today and `Task` historically (opencode uses `task`) — both spellings resolve"*, and it
maps `case 'task': case 'agent':` alike. `stats.ts` does not.

Measured across all 8 run transcripts in `/var/lib/cezar/loki-labs/cezar/.ai/cezar/runs/`:
**zero `"tool":"Task"` events exist anywhere**, and three runs carry `"tool":"Agent"`:

| run | step | `Agent` calls | what `cez run stats` prints in `sub` |
| --- | --- | ---: | --- |
| `c10864d1-5dd1-4c03-b1ea-5443838c7347` (done) | `spec` | 3 | **0** |
| `70f19253-cf6b-407c-92e0-96a8020a8ebb` (live) | `context` | 3 | 0 |
| `e06f2169-7a55-4524-a035-7e5e8de8585b` (this run) | `context` | 3 | 0 |

`cez run stats c10864d1-… --repo /var/lib/cezar/loki-labs/cezar` prints `spec 86 78 1.10 … sub 0`
and the footer `0 sub-agent call(s)` — for a step that dispatched three sub-agents.

**Acceptance criterion 1 as written ("verified by a non-zero `sub` column") is unsatisfiable
today no matter what any agent does.** The meter has to be fixed before it can prove anything.

Stated honestly, this does **not** fully overturn §4: `7c2dd8f0` carries `Agent`=0 and `Task`=0, so
that run genuinely never fanned out. The §4 negative result stands for the five runs it measured.
What is new is that at least one *completed* run since then did fan out and was recorded as not
having done so — so "chosen exactly 0 times" is no longer a claim the record can support.

### 2. A child's tool calls are attributed to the parent step, so fan-out makes the meter look worse

`packages/cezar/src/core/claude-cli-runner.ts:800-802` emits a v1 `tool-call` event for **every**
`tool_use` block with no `parent_tool_use_id` filter (the v2 UI mapper *does* filter, at
`packages/cezar/src/core/claude-ui-mapper.ts:264-265`). Measured on this run's NDJSON: **99
`tool-call` events, 0 of them carrying any parent-id field**; the persisted keys are
`['id','input','seq','stepId','tool','ts','type']`. The parent step's own agent made roughly nine
of those 85 `Bash` calls — the rest are the three children's, folded into `stepId: 'context'` by
`packages/cezar/src/workflows/run.ts:4319` (`emit({ ...event, stepId: step.id })`).

So fan-out currently **raises** the parent step's `calls`, `trips` and `cheap` counts and
**depresses** its `batchFactor` — the opposite of the signal the acceptance criteria want to read.

## What the record already decided

- **`.ai/specs/2026-08-20-agent-round-trip-batching-and-fanout.md`** (KB `specs-8c8777512e48`),
  status PARTIAL. Baseline `ec6e8e06`: 61.5 min, 271 calls / 271 round trips / batch 1.00 / 0
  sub-agent calls; 231 of 271 calls (85%) under 1 s doing 29.4 s of work at ~23.5 min of round
  trips. §4 acceptance: *"After Phase 4, `subAgentCalls > 0` in the `spec` step and its `wallMs`
  below 503 000"*, plus *"No quality regression: the spec produced by the fanned-out `spec` step
  still cites real KB ids, file paths and commit hashes."*
- **`notion-333c1a0a847b`** — § *"Batching beats fan-out, and fan-out is not free"*. The binding
  constraint: fan-out *"does not reduce model seconds, it **overlaps** them"* and pays only where
  branches are *independent*, *substantial* (≳60 s each) and *read-only*. Grants `Task` to the
  read-heavy steps and *"deliberately withholds it from `implement`, `run-tests`, `commit-push`
  and `deploy` — and… `workflows/types.test.ts` asserts the absence as hard as the presence."*
  Also: *"`--allowedTools` only GRANTS, additively… naming a tool in the allowlist is not what
  unlocks fan-out; **the prompt is**."*
- **`notion-cc6ebabb2ab4`** (`local:2026-08-21-cezar-run-speed-measured`) — the executed §4. The
  number that motivates this work: *"**2.38 s per round trip under 50 k tokens → 9.55 s at
  200–300 k**. Production sessions run at median 210 k, p90 349 k… context is **28:1 tool output to
  assistant text** (~189 k tokens of Bash output against ~7 k of prose)… exploration output that a
  child would have absorbed instead inflates the parent, and every later round trip in the session
  pays for it."* Also the measurement trap: *"Batching inside a call is not batching round trips…
  **Always cite the meter.**"*
- **`notion-c0cf44eded02`** — an independent prior with the same rule, from cezar's org/invite
  phase: *"Read-only reviewers may fan out freely. Anything that mutates source is either
  serialized into one agent owning mutation for the phase, given its own worktree, or run in a
  later pipeline stage."* Failure modes named: false kill, false survivor, lost work.
- **`specs-9a01e3bf2eeb`** (`.ai/specs/2026-08-20-split-steps-spec-review-and-approval-gate.md`) —
  records that each chain step is *already* a separate agent process with a separate context
  window (`run.ts` mints a fresh `sessionId` per step), and that *"no change is proposed for this.
  It is recorded here so the next session does not re-investigate it."* This task is about `Task`
  sub-agents **inside** one step, not step-level parallelism.
- **`specs-d53ef835ba5f`** (`.ai/specs/2026-07-20-grouped-subagent-display.md`) — per-sub-agent
  token accounting is explicitly out of scope; *"this feature must not invent protocol to get a
  display."*
- **Commit `1f1078a4`** (2026-08-20, *"give an agent step a tool budget, and a meter to prove
  it"*) created `stats.ts`, `stats-cli.ts` and `TOOL_BUDGET_DOCTRINE`. It is the **only** commit
  ever to touch `packages/cezar/src/runs/stats*.ts` — that code is unchanged since.

## Which code is actually involved

| Concern | Location |
| --- | --- |
| The `sub` counter (wrong string) | `packages/cezar/src/runs/stats.ts:178`; fixture only covers `'Task'` — `packages/cezar/src/runs/stats.test.ts:164-171` |
| Round-trip / batch-factor counting | `packages/cezar/src/runs/stats.ts:170-177`, doc at `:123-130`; `batchFactor` = calls ÷ maximal runs of consecutive `tool-call` events per step |
| v1 event emission (no parent filter) | `packages/cezar/src/core/claude-cli-runner.ts:800-802`; step stamped at `packages/cezar/src/workflows/run.ts:4319` |
| v2 event, spelling-proof | `packages/cezar/src/core/tool-display.ts:144-155` → `toolKind: 'task'`; nesting via `parentItemId`, `packages/cezar/src/core/ui-events.ts:179-180` |
| Tool-budget doctrine (no fan-out bullet) | `TOOL_BUDGET_DOCTRINE`, `packages/cezar/src/workflows/run.ts:519-535`; composed at `:4517-4527`, Continue at `:3290-3297`; delivered as `--append-system-prompt` (`claude-cli-runner.ts:697-699`); ≤210-word guard at `packages/cezar/src/workflows/system-prompt.test.ts:86` |
| Fan-out instruction (step prompts) | `context`: `packages/cezar/src/workflows/types.ts:593-601`; `document`: `types.ts:839-841`; shared batch literal `RECORD_READ_RECIPE` at `types.ts:465-476` |
| Per-step tool grants | `context` `types.ts:568` (has `Task`), `spec` `:622` (no `Task`), `document` `:818` (has `Task`); `DEFAULT_ALLOWED_TOOLS` `types.ts:251` |
| Negative-control tests | `packages/cezar/src/workflows/types.test.ts:186`, `:197`; argv plumbing `packages/cezar/src/core/claude-cli-runner.test.ts:71-87` |
| Peak-context raw material | `context.updated` events, `packages/cezar/src/core/claude-ui-mapper.ts:178`, filtered to main-agent frames at `:264-265`; persisted with `stepId` via `run.ts:4618`. `stats.ts` ignores them (`:209-210 default: break;`); `store.ts:73-76` keeps only the latest, overwritten |
| Enforcement machinery | `verify: {builtin|command, max}` schema `types.ts:69-77`; built-ins `postconditions.ts:45`; re-run-with-verdict loop `run.ts:5306-5327` |

**Measured, this run:** 40 `context.updated` samples, **peak 127 359 tokens** on the `context`
step. So criterion 2's metric — per-step peak context — is derivable from the NDJSON today
(`max(contextTokens)` per `stepId`) and is simply not computed anywhere. No `peakContext` symbol
exists; the only `peak*` fields are `peakRssBytes` / `peakProcCount` (`runs/store.ts:412-416`).

## The prior decision this would contradict

**The task says "a read-heavy step (spec or document)". `Task` is no longer on the `spec` step,
and that removal was deliberate and recent.** Commit `e9ed8f5a` (*"split the record read from the
spec, review it, and gate it on approval"*, spec `.ai/specs/2026-08-20-split-steps-spec-review-and-approval-gate.md`)
split the old `spec` step into `context` → `spec` → `review-spec`. `Task` moved to `context`
(`types.ts:568`); `spec` carries the comment at `types.ts:619-621`: *"`Task` is deliberately NOT
granted here — the writing is the one job that must not be delegated"*, pinned by
`types.test.ts:186` (*"grants Task fan-out to the read-heavy steps ONLY (context, document)"*).

So restoring `Task` to `spec` would contradict `e9ed8f5a`. The read-heavy step that fans out today
**is `context`** — which is the step that produced this brief, dispatching three sub-agents.

Any widening beyond `context`/`document` also collides with the negative control in
`types.test.ts` and with the read-only rule in `notion-333c1a0a847b` / `notion-c0cf44eded02`.

## Open questions a spec will have to settle

1. **Order of operations.** The meter fix is a prerequisite for all three acceptance criteria. Does
   the spec fix `stats.ts` first and re-measure the existing transcripts (which would retroactively
   show `c10864d1`'s `spec` step at `sub 3`), or change prompts first?
2. **Which counter.** Widen the v1 match to `Agent`/`Task`/`task` case-insensitively (one line,
   but keeps counting children's calls in the parent), or re-base `sub` on the v2
   `item.started` + `toolKind === 'task'` + no `parentItemId` (spelling-proof and backend-agnostic,
   but changes `stats.test.ts`'s fixture contract)?
3. **Parent/child attribution.** Excluding a child's tool calls from the parent step needs
   `parent_tool_use_id` plumbed into the v1 `tool-call` event (`claude-cli-runner.ts:800-802`) — a
   protocol widening that `specs-d53ef835ba5f` warns against — or computing stats from v2 events
   instead. Without it, criterion 3's before/after is measuring a compound of two changes.
4. **Prompt or post-condition.** The `context` prompt's fan-out instruction is imperative and
   specific (*"run up to THREE sub-agents (`Task`) on them in parallel in a single turn"*,
   `types.ts:593-601`) and it fired on 3 of 3 observed runs; `document`'s is a subordinate clause
   (`types.ts:839-841`) and has not been observed firing. That is a testable hypothesis — rewriting
   `document`'s instruction in `context`'s voice may be the entire fix. The harder alternative is a
   `fanned-out` post-condition, which is **blocked on wiring**: `evaluatePostcondition` is called
   with only `{ cwd, workspaceRun }` (`run.ts:5292`) and `verify.command` spawns with
   `env: process.env` (`run.ts:5342`), so neither can see `CEZ_TASK_ID` — set only in `agentEnv`
   (`run.ts:995`). A run/step id must reach `PostconditionContext` first.
5. **Doctrine vs step prompt.** `TOOL_BUDGET_DOCTRINE` mentions batching, parallel tool blocks and
   backgrounding — **never sub-agents or `Task`**. Adding a fan-out bullet there hits the 210-word
   guard (`system-prompt.test.ts:86`) and would reach steps that are deliberately denied `Task`.
6. **What the "before" is.** `ec6e8e06`'s full NDJSON **does not exist locally** — only the trimmed
   fixture `packages/cezar/src/core/__fixtures__/runs/ec6e8e06-trimmed.ndjson` and prose numbers in
   todo `881c4f7b`. And the workflow itself changed shape (6 steps → 8) between then and now, so
   "the same step before and after" needs redefining. Candidates: `7c2dd8f0` `spec` (38 calls / 38
   trips / 1.00 / genuinely 0 sub) or `c10864d1` `spec` (86 / 78 / 1.10 / 3 unrecorded `Agent`).
7. **Does batch factor still mean anything here?** Todo `3dd1907d-d7ac-4563-888b-6095d04a4b0a`
   already records that `batchFactor` *"prints '1.00 = never batched' for a run that batched
   perfectly"* — folding five reads into one script drops calls and trips proportionally. Criterion
   3 asks for batch factor before and after; the spec should say what a move in it would prove.

## In-flight conflict — name it before editing

Live run **`70f19253-cf6b-407c-92e0-96a8020a8ebb`** (*"Stop agents blocking on guessed 'sleep N'"*,
todo `eb6e528b-50d6-419b-842a-ffa4f0d61fa5`) is rewriting the **same constant** —
`TOOL_BUDGET_DOCTRINE`'s *"Background what is genuinely slow"* bullet at `run.ts:519` — and the
same assertions in `system-prompt.test.ts:91-94`. Its worktree has nothing committed yet. High
conflict risk on `run.ts`.

This branch (`cez/e06f2169`) is **7 commits behind `origin/main` (cf334d89), 0 ahead**. None of the
seven touch the doctrine, the workflow definitions or the stats code, but they do touch
`core/claude-cli-runner.ts` — the process that receives `--append-system-prompt` — so rebase before
committing.

## What could not be found

- **No full `ec6e8e06` transcript** anywhere under `*/.ai/cezar/runs/` — only the trimmed fixture.
- **No per-step peak-context metric** in the codebase; the raw events exist, nothing computes it.
- **No workflow YAML.** `WORKFLOWS_DIR = '.ai/cezar/workflows'` (`workflows/load.ts:14`) does not
  exist in this repo; all three built-ins are TypeScript literals in `workflows/types.ts`.
- **No `--disallowedTools`** is emitted by the runner anywhere, so `allowedTools` still only grants
  (`claude-cli-runner.ts:672-678`); todo `444c7db2` still owns that decision.
- **No KB entry** setting a numeric ceiling on concurrent sub-agents beyond this spec's own
  "max 3, read-only, orchestrator writes", and none recording per-sub-agent token/cost accounting.
