# Fan-out made the step slower — dispatch async, give sub-agents the tool budget, size them to finish together

## Meta note

This brief is being written **by the exact step it is about** — the `context` step of
`spec-to-deploy` (this task, `f32d72ba-c2eb-45be-a5ae-072f568ac9e9`), whose own baked prompt is the
"go WIDE" paragraph at `packages/cezar/src/workflows/types.ts:671-679` (quoted verbatim below). This
step dispatched its two research sub-agents with `run_in_background:true` and did its own
document-reads in the same turn, in accordance with the fix this task exists to ship — a live,
partial data point for whoever runs this task's own eventual A/B, with the self-measurement caveat
`.ai/specs/2026-08-22-document-fanout-post-deploy-metering.md` already names: an in-flight step's own
timing is a lower bound, not a settled figure.

## Problem, in this repository's own terms

`packages/cezar/src/runs/stats.ts`'s fix (commit `5ef7e653`, "the fan-out meter could not see a
dispatch, and it billed the children to the parent") made fan-out visible and attributed correctly.
Once visible, a new measurement — run `70f19253`'s `context` step, 2026-08-21, cited in this task's
own context block — showed that fan-out adoption **made the step slower than not fanning out at
all**, for three distinct, independently-measured reasons, none of them model slowness:

1. **Blocking dispatch.** Three `Task`/`Agent` calls went out with `run_in_background:false` in one
   turn with no parent tool call alongside them. The parent was idle 241.6s = 43% of the step's
   557.5s wall time — it made zero tool calls between t=74.5s and t=322.5s. The async-dispatch
   sibling run `e06f2169` (same jobs, same prompt, started 11s earlier) finished 1.6 min faster.
2. **Children are round-trip-bound, not work-bound.** Two of the three sub-agents in `70f19253` spent
   1–2% of their own wall time actually executing tools (46 calls / 3.1s exec / 252.1s wall on one;
   3.5s / 185.3s on another) — the same round-trip-bound pathology the parent doctrine already treats
   (`notion-333c1a0a847b`), relocated one level down where nothing currently measures it.
3. **Straggler spread.** The three siblings returned at t=227.1 / 259.7 / 316.1 — 89s of the parent's
   idle block was spent waiting on one over-scoped job (46 calls, 191KB read) after its two siblings
   were already done. The parent pays `max()` over the fan-out, so the least-batched child sets the
   step's price.

**This is a genuinely new problem, not a re-run of an old one.** The 2026-08-20/21 specs' concern was
*whether* fan-out happens at all (the meter read `sub 0` when 3 dispatches had occurred — an
instrument bug, fixed). This task's concern is that fan-out **does** happen and **still costs more
than it saves**, for reasons the earlier specs' own risk tables named but did not yet act on (R4 in
the 2026-08-20 spec: *"Fan-out on reads too small to pay for themselves... pays only where branches
are independent, substantial (≳60s each), and read-only"* — the straggler in `70f19253` was exactly
this: a 46-call, 191KB job sized far outside its two siblings).

## What the record already decided (citations)

- **`.ai/specs/2026-08-20-agent-round-trip-batching-and-fanout.md`** — established the doctrine
  (`TOOL_BUDGET_DOCTRINE`), the record-read recipe, and granted `Task` to `context`/`document` only,
  read-only, "worth a minute of work" bound. Its R7 caps the doctrine at **~200 words**, pinned by
  a system-prompt word-count test — this bounds where new async/sizing guidance can physically live.
  Its R4 already named the straggler failure mode in the abstract; this task is R4 materialized with
  numbers.
- **`.ai/specs/2026-08-21-sub-agent-fanout-adoption-and-attribution.md`** — fixed the meter's
  attribution (`stats.ts`'s `childToolCalls`/`ownToolCalls`/`subAgentCalls` now correctly bill
  children to their step, not to a global "0"), established that **"the prompt's form, not the tool
  grant, is what predicts adoption"** (its §4 finding: `context`'s imperative paragraph fanned out
  3/3 times, `document`'s subordinate clause 0/2), and explicitly decided **doctrine vs. step
  prompt → step prompt** (open question 5: doctrine reaches steps deliberately denied `Task` and is
  word-capped; fan-out guidance belongs in the step's own prompt). This is the precedent this task's
  fix should follow for "give sub-agents the tool budget," rather than editing `TOOL_BUDGET_DOCTRINE`.
- **`.ai/specs/2026-08-22-document-fanout-post-deploy-metering.md`** — Phase 4 of the 2026-08-21 spec,
  status `SPEC WRITTEN, NOT YET EXECUTED`, filed as todo `221cf511-4e18-4f7b-ba46-e20edf956a16`,
  picked up by a **different** task (`fb62168a-6972-49f0-afb4-ffe9c4ec9b01`). **Orthogonal to this
  task**: it measures whether `document`'s rewritten prompt fans out *at all* post-deploy; it takes
  no position on dispatch mode, sizing, or per-child metrics, and explicitly declines to iterate the
  prompt a second time inside its own task. Confirmed not a duplicate.
- **This task's own todo, `2b56085d-f7fa-4e26-8e09-357798d30ede`** (priority high,
  `startedTaskId: f32d72ba-c2eb-45be-a5ae-072f568ac9e9` — this task) carries the title and all four
  acceptance criteria verbatim, `knowledgeRefs → .ai/specs/2026-08-20-agent-round-trip-batching-and-fanout.md`.
  **This brief is not chasing separate in-flight work — it is that todo's own first step.**
- `notion-333c1a0a847b` — "batching beats fan-out, and fan-out is not free"; the round-trip-bound
  pathology in children (cause 2 above) is this same finding one level down, previously undetected
  because nothing measured inside a dispatched sub-agent.

## Which code is actually involved (file:line)

**Where the bug lives (prompt text, no async/sizing guidance today):**
- `packages/cezar/src/workflows/types.ts:671-679` — the `context` step's fan-out paragraph, verified
  live in this worktree (this is the literal prompt this step is running under right now):
  > *"Then go WIDE... run up to THREE sub-agents (`Task`) on them in parallel in a single turn... Give
  > each one a job whose answer is worth a minute of work."*
  Says "parallel in a single turn," never says `run_in_background:true`, never tells the model to
  embed budget doctrine in the child prompt, never tells it to size jobs so they finish together.
- `packages/cezar/src/workflows/types.ts:982-991` — the `document` step's equivalent paragraph (moved
  from the earlier-cited `:839-841` by intervening commits; re-grepped fresh for this brief). Same
  gaps.
- `packages/cezar/src/workflows/run.ts:541-560` — `TOOL_BUDGET_DOCTRINE`. Deliberately
  backend-agnostic (a comment at `:535` states it names no backend-specific tool or parameter, "not
  even `run_in_background`," because it is also prepended to codex/opencode/pi prompts). Gives three
  tiers for the STEP's OWN tool calls (foreground+redirect / background+wait-on-process /
  block-on-marker) but says nothing about sub-agent dispatch mode or sizing.
- **There is no cezar-owned location for "Agents run in the background by default."** That string is
  the underlying `claude` CLI's own Agent-tool schema description (confirmed: zero matches for
  "background by default" anywhere in this repo; `claude-cli-runner.ts:88-102` only ever passes
  `--allowedTools`/`--disallowedTools`/`--append-system-prompt` to the CLI, never a tool schema
  override). **The only lever cezar has is prompt text that instructs the model to pass
  `run_in_background:true` explicitly** — there is no code-level way to force it.
- **Sub-agents get zero doctrine today, structurally, not just by oversight.** `composeSystemPrompt`
  (`run.ts:570-575`) is called at exactly two sites — `run.ts:3431-3443` (Continue-turn session) and
  `run.ts:4692-4701` (normal step session) — both building the **top-level step's own** Claude
  session. A sub-agent spawned via `Task`/`Agent` from inside that session is dispatched by the
  underlying `claude` CLI's own built-in tool, entirely outside `composeSystemPrompt`. So "give them
  the tool budget" cannot be a `composeSystemPrompt` change; the only reachable lever is the
  **dispatching step's own prompt text instructing the model to write budget/sizing text into each
  sub-agent's `prompt` parameter at dispatch time** — which is exactly the pattern this step used for
  its own two dispatches this turn (see Meta note).

**Where the metric gap lives (`cez run stats`, no per-child data today):**
- `packages/cezar/src/runs/stats.ts` — `childToolCalls` (`:347`), `ownToolCalls` (`:349`),
  `batchFactor` (`:864`, `:900`), `subAgentCalls` (`:378`, `:601`, `:627`, `:801`, `:870`, `:906`) are
  all aggregated **at the step level**, summed across however many children a step spawned. **No
  per-dispatch/per-child row exists** — no tool-busy % (`toolExecMs`/`wallMs` per child), no
  straggler-spread (max−min sibling completion time) anywhere in `stats.ts` or `stats-cli.ts`.
  Attribution is via `parentItemId` on persisted v2 `item.started` events (`:341, 516, 560,
  570-586`), which already carries enough to compute both: each v1 `tool-call`/`tool-result` pair for
  an `Agent` dispatch gives that child's dispatch-to-return span (wall time), and the same v2
  `parentItemId` join used for `childToolCalls` gives that child's own `toolExecMs`. Tool-busy % and
  straggler spread are therefore **derivable from data already on disk**, per the same "no protocol
  widening needed" pattern the 2026-08-21 spec used for its own fix (verified: v1 `tool-call.id` and
  v2 `item.id` are the same `toolu_…` string in every checked transcript, 0 unmatched).
- `packages/cezar/src/runs/stats-cli.ts` (~line 1000-1006, the table's `pad(...)` column builders,
  and the JSON shape) is where a new `sub`-scoped batch-factor/tool-busy column would render.

## Prior decisions this would touch or risk contradicting

- **The 2026-08-21 spec's explicit choice, "No fan-out bullet in `TOOL_BUDGET_DOCTRINE`"** (word-cap,
  reaches Task-denied steps too) — this task's "give sub-agents the tool budget" criterion must
  therefore land as step-prompt text the dispatching model copies into each child's prompt, not as an
  edit to the shared doctrine constant. Getting this wrong reopens a settled design choice.
- **`types.test.ts:186` / `:197`** (per the 2026-08-21 spec, exact line numbers now stale — re-grep
  before editing) pin that `Task` is granted to `context`/`document` only and that both steps' children
  must stay read-only. Any prompt rewrite here must keep those assertions true; the read-only
  boundary is unrelated to this task's fix but sits in the same paragraph being edited.
- **R10** (2026-08-21 spec) already flags that any single A/B here is one uncontrolled cross-task
  sample — this task's own acceptance criterion 4 ("beats 7.7 min... measured from its own NDJSON, not
  asserted") inherits that same limit and should be reported with the same caveat, not as a controlled
  result.
- The 2026-08-22 metering spec's stated rule — **"an in-flight step cannot measure its own peak
  context... only `ownToolCalls` and `sub` are safe to read from inside the step"** — applies equally
  to any straggler-spread/tool-busy number this task tries to read from its own not-yet-closed step.

## Open questions a spec will have to settle

1. **How exactly does a step-prompt tell the model to write budget doctrine into a child's prompt?**
   Copy the full `TOOL_BUDGET_DOCTRINE` text verbatim into each dispatch (word-cost per child ×3), or
   a condensed sizing-specific subset ("batch your reads into one call, size your job to ~N tool
   calls, return in under a minute")? This step's own two dispatches this turn used the latter
   (task-specific batching instructions, not the literal doctrine block) — worth treating as a design
   option, not just a data point.
2. **What exactly counts as "sized to finish together"?** The acceptance criterion is spread <60s
   between first and last return. Does the spec pursue this via prompt guidance alone (tell the model
   to scope jobs comparably) or does it also want stats.ts to surface the spread so a future run can
   verify it after the fact — and if the latter, does that require new v2 event timestamps or are the
   existing `tool-call`/`tool-result` timestamps on each `Agent` dispatch sufficient (this brief's
   research suggests they are)?
3. **Tool-busy % definition.** `toolExecMs / wallMs` for the child's own span — is `wallMs` the
   dispatch-to-return span on the PARENT's v1 stream, or does it need the child's own `step-start`/
   `step-end`-equivalent framing (children don't emit those; only `item.started`/`item.completed`)?
   Needs to be pinned precisely before `stats.ts` can compute it.
4. **Where does the new `sub` batch-factor/tool-busy column live in the CLI table** — a new row per
   dispatch under each step (verbose mode), or a single aggregate (e.g. min tool-busy % across
   children, worst-case straggler spread) folded into the existing per-step row? The acceptance
   criteria ("no child under 10% tool-busy") imply per-child visibility is needed at least once to
   verify, even if the default table shows an aggregate.
5. **Enforcement is fundamentally a hypothesis, not a guarantee**, same as the 2026-08-21 spec's
   Phase 3: cezar cannot force `run_in_background:true` or sub-agent sizing at the code level (no
   Agent-tool-call interception layer exists); the fix is prompt text and the model may not comply
   every time. The spec should say this plainly rather than treat the prompt rewrite as a closed loop,
   mirroring the 2026-08-21 spec's R2 posture on the `document` prompt-form hypothesis.

## What I could not find

- No existing per-child/per-dispatch timing metric anywhere in `stats.ts`/`stats-cli.ts` — confirmed
  absent, not merely unread.
- No cezar-owned place to change the Agent tool's own `run_in_background` default/description — it is
  upstream, in the `claude` CLI itself.
- No test currently pins word-count or content of the `context`/`document` fan-out paragraphs at their
  *current* line numbers (`:671-679`, `:982-991`) — the 2026-08-21 spec's cited test line numbers are
  stale after intervening commits; re-grep `types.test.ts` before editing rather than trusting old
  citations (including this brief's own).

---

**Brief path:** `.ai/specs/briefs/2026-08-22-async-subagent-fanout-sizing.md`

**The four facts that most constrain the design:**

1. **Sub-agents receive zero doctrine today, structurally** — `composeSystemPrompt` only builds the
   top-level step's own session (`run.ts:570-575`, called only at `:3431-3443` and `:4692-4701`); a
   dispatched `Task`/`Agent` sub-agent never passes through it. The only lever is the dispatching
   step's own prompt text instructing the model to write budget/sizing guidance into each child's
   `prompt` parameter — there is no shared-composition shortcut.
2. **The doctrine word cap (`TOOL_BUDGET_DOCTRINE`, ~200 words, `run.ts:541-560`) and the 2026-08-21
   spec's explicit "doctrine vs. step prompt → step prompt" decision** together mean this fix belongs
   in `types.ts:671-679` (`context`) and `:982-991` (`document`), not in the shared doctrine constant.
3. **`cez run stats` has the raw data (v2 `item.started`/`parentItemId`, v1 `tool-call`/`tool-result`
   timestamps on each `Agent` dispatch) to compute both a per-child tool-busy % and a straggler
   spread without protocol widening** — same "already on disk" pattern the 2026-08-21 meter fix used;
   this is new engineering in `stats.ts`/`stats-cli.ts`, not new instrumentation.
4. **This task is already claimed** as todo `2b56085d-f7fa-4e26-8e09-357798d30ede`, started under this
   very task id — no reconciliation needed with other in-flight work, and the orthogonal `221cf511`/
   `fb62168a` Phase-4-metering task should not be conflated with this one in the spec.
