# Brief — `run-tests` output-token ceiling: gathering the record for a chain that already built Phases 1-3

**Task id:** 95d3c6f2-7e11-4a1d-826c-e03a5a5a168b · **Step:** 1 of 8 (Gather the record) · **Date:** 2026-08-22

**This is a third pass through step 1 of the same task.** Two prior gather briefs already
exist for this task (`.ai/specs/briefs/2026-08-21-run-tests-output-tokens.md`,
`.ai/specs/briefs/2026-08-22-run-tests-output-tokens-revise.md`), and between them the chain
already ran spec → review-spec (4 passes, verdict **PASS**) → implement. **The distinguishing
fact this pass exists to surface: this worktree's git status shows that implementation sitting
uncommitted right now** (`git diff --stat`: 9 files, 579 insertions / 48 deletions, touching
exactly the files the spec's Phases 1-3 name). Nothing about the underlying problem changed —
this brief exists to hand the *current, already-advanced* state to whichever step runs next, so
it doesn't redo settled work or, worse, silently re-derive a different design.

## The problem, unchanged

`run-tests` (spec-to-deploy step 5, `packages/cezar/src/workflows/types.ts:770`) burned 43,583
output tokens / 631s wall / $4.16 on run `70f19253-cf6b-407c-96e0-96a8020a8ebb`, against 34s of
actual tool execution — a step whose job is running gates and reporting the result. Full framing
(output-token-bound runs, 81.3 tok/s, 12ms/token) is in the task handoff and unchanged; not
re-derived here.

## What the record already decided — verified against the code as it stands NOW

**The spec passed review and is (mostly) built, not "pre-implementation."** The spec file's own
status line still reads *"Status: revised (2026-08-22), still pre-implementation — no phase
below has landed (`git grep '--effort' ... zero hits`)"* — **that line is now stale**, contradicted
by the working tree. Verified directly, this session:

- `effort?: string` on `AgentRunSpec` — `packages/cezar/src/core/agent-runner.ts:65`.
- `effort: z.enum(['low','medium','high','xhigh','max']).optional()` on `workflowStepSchema` —
  `packages/cezar/src/workflows/types.ts:27`.
- `--effort` flag wired into `buildClaudeArgs` — `packages/cezar/src/core/claude-cli-runner.ts:724-725`
  (`if (spec.effort) { args.push('--effort', spec.effort); }`).
- `RUN_TESTS_STEP_EFFORT = 'medium'` set on the `run-tests` step only —
  `packages/cezar/src/workflows/types.ts:545,774`.
- The `run-tests` prompt (types.ts:770-833) carries **both** clauses the spec's Phase 2 called
  for, quoted verbatim from the current file:
  - Diagnostic-depth stop condition: *"Once a failure reproduces IDENTICALLY against a control
    that does not contain this run's change ... that is sufficient to call it 'not mine'. Stop
    there. Do not also A/B environment variables, spawn additional probes, or read the
    implicated subsystem's source hunting for a root cause ... File what you already have
    (`cezar todo add`) ... Then move on."* (types.ts:815-822)
  - Output discipline: *"Report pass/fail plainly. Quote the failing test's own output verbatim
    — never re-explain what the diff changed; that is already in the commit this step is about
    to hand to `commit-push`."* (types.ts:831-833)
- AGENTS.md gained trap #5 (heading now *"Five environment traps that make the gates LIE"*,
  AGENTS.md:250,346) documenting the `test:package` case-5 broker-stall red and citing
  `c895a348` as canonical.
- Todos reconciled: `c895a348-4bee-4a81-89ab-a62788a6a118` is the canonical entry (status
  **done** — its own `startedTaskId` shows it was investigated and closed as a real bug, not
  just filed), `1e8e5266` and `46dbb850` both carry a `"SUPERSEDED 2026-08-22 by c895a348 ...
  Archived, not deleted"` line prepended to `context`, but **their `status` field is still
  `"todo"`, not archived** — confirmed by direct read of `/var/lib/cezar/loki-labs/cezar/.ai/cezar/todos.json`.
  This matches review-spec pass-4's nit N1: `todos.ts`'s status enum has no `superseded` value,
  so "archived" here means the context note only, not a status transition. Worth flagging
  forward — a step that filters todos by `status !== 'todo'` will still surface these two.
- Tests: `claude-cli-runner.test.ts` gained `--effort` emitted/omitted assertions,
  `types.test.ts` gained `run-tests.effort === 'medium'` + every-other-step-undefined
  assertions (both files show as modified in `git diff --stat`).

**Confound already resolved, with evidence (task acceptance criterion 1):** the first brief
(`2026-08-21-run-tests-output-tokens.md`) determined ~76% of the 43,583 tokens were invisible
reasoning spent deep-diagnosing a **confirmed pre-existing, unrelated** `test:package`
broker-stall bug, well past the point a control repro had already proven it wasn't the run's own
change — **not** the 2,152-failure `npm test` baseline (todo `c78140a8`, still open/`status:
todo`, environmental — React 19 `act` incompatibility + a `TMPDIR`-inside-repo trap, per its own
`context` field). So **(b) and (c) dominate, not (a)** — this does **not** fold into `c78140a8`;
that todo stays open as its own, separate item. This finding was independently re-verified by
`review-spec` pass 4 rather than merely carried forward.

**The population table Phase 4 measures against (spec Problem section, re-verified against
`.ai/cezar/runs/*.ndjson` across two review passes):**

| run | model | run-tests output tokens | wall | note |
|---|---|---|---|---|
| `70f19253` | opus | 43,583 | 631s | pre-`a5f04b0f`, the outlier that started this task |
| `e06f2169` | opus | 6,658 | 107s | cheapest — but ended its turn mid-`npm test`, `status:"done"` regardless (see below) |
| `f272fda8` | sonnet | 19,219 | 454s | post-`a5f04b0f`, zero Phase 1-3 lever, hit the same broker-stall red, self-stopped correctly |
| `0762e872` | sonnet | 9,880 | 318s | post-`a5f04b0f`, zero lever, the tighter of the two sonnet baselines |

Phase 4's bar (spec line 340-421) is **N materially below 9,880**, not a fixed `<20000` —
both sonnet baselines already ran unaided and one nearly clears 20k on its own, so a fixed
threshold can't discriminate this spec's fix from doing nothing. This directly narrows the
task's own acceptance criterion ("drop below 20,000") to a tighter, evidence-based bar.

**`e06f2169`'s false economy is a named trap, not just a data point.** It hit `step-end
status:"done"` six seconds after emitting `"I'll wait for it rather than risk a false red from a
concurrent rebuild."` while `npm test` was still running in the background — confirmed against
its own `.ndjson` (`turn.completed stopReason:"end_turn"` → `session.ended` → `step-end
status:"done"`, no intervening gate completion). Phase 4 step 3a exists specifically to reject a
measurement run that gets cheap this way: every gate the step's report names must show an
`EXIT=`-shaped marker (or `Test Files N passed`) in the run's own `.ndjson`.

## What is NOT done — this is the actual gap this brief hands forward

1. **Nothing is committed.** `git status`/`diff --stat` shows the Phase 1-3 work sitting in the
   working tree of this exact worktree, untested against a fresh gate run in this session.
2. **The spec's own status header is stale** ("still pre-implementation") and needs a one-line
   correction before/alongside whatever step next touches this file — otherwise the next reader
   opens it and re-derives what's already built.
3. **Phase 4 has not started.** No todo matching "record post-effort-cap run-tests token
   measurement" or the spec's own filing text exists in `todos.json` (searched by summary and by
   `"Phase 4"` / `"reasoning-ceiling"` substring — only unrelated Phase-4 references from other
   specs matched). The spec's Phase 4 step 0 explicitly requires filing that todo **before**
   triggering the measurement run, with `--project /var/lib/cezar/loki-labs/cezar` (absolute
   path — this worktree's own `.ai/cezar/` is gitignored and not the real board).
4. **No fresh post-Phase-1-3 measurement exists.** The four-run population above all predates
   this session's uncommitted code. The task's own 4th acceptance criterion — N < 20,000 (spec:
   materially below 9,880) *and* a deliberately-broken test still surfaces — requires a real
   triggered run after commit/deploy, which is downstream of `commit-push`, not something this
   step or `implement` can produce.
5. **`review-spec`'s N2 nit is still open**, and matters for whoever runs Phase 4: don't measure
   N on the same run that carries the deliberately-broken test (spec Phase 4 step 4) — that
   inflates N against baselines that never paid that cost. Split into two runs, or exclude the
   break-run's token count from the comparison.

## What a spec/implement step should NOT do

Do not redesign the mechanism (per-step `effort` knob, the two prompt clauses, the AGENTS.md
trap, the todo reconciliation) — it already cleared four review passes and matches the code as
it stands. The only legitimate next actions are: (a) correct the spec's stale status line, (b)
run this repo's own gates against the currently-uncommitted diff and commit if green, (c)
execute Phase 4 exactly as written (file the todo first, trigger a comparable run, extract N
from its `.ndjson`, verify the 3a exit-marker check, run the deliberately-broken-test check,
update the Phase 4 todo with the result).

## Citations

- Handoff: `$CEZ_HANDOFF_FILE` (this task, 95d3c6f2) — full progress log of prior steps.
- Spec: `.ai/specs/2026-08-21-run-tests-reasoning-ceiling.md` (status line stale; body correct
  per review-spec pass 4 PASS verdict).
- Prior briefs: `.ai/specs/briefs/2026-08-21-run-tests-output-tokens.md`,
  `.ai/specs/briefs/2026-08-22-run-tests-output-tokens-revise.md`.
- KB: `specs-8f1e7c1c28d3` (first brief), `specs-a9b7093c5eda` (revise brief),
  `specs-31c31862d9f0` (the spec itself, indexed) — `cez kb show specs-31c31862d9f0` for the
  full text if the file path above is unavailable to a later step.
- Todos: `todos.json` — `c895a348-4bee-4a81-89ab-a62788a6a118` (done, canonical broker-stall
  bug), `c78140a8-55b0-4cc2-8d52-d2be468916fe` (todo, open, unrelated 2152-failure baseline),
  `1e8e5266-b3e8-45f1-9489-25391408cdc3` / `46dbb850-f968-45a8-8622-fb1e4432d2e6` (todo status,
  superseded-by-context-note only).
- Code: `packages/cezar/src/workflows/types.ts:27,545,770-833`;
  `packages/cezar/src/core/agent-runner.ts:65`;
  `packages/cezar/src/core/claude-cli-runner.ts:724-725`; `AGENTS.md:250,346`.
- `git diff --stat` (this worktree, uncommitted): 9 files, +579/-48.

## Open questions the next step must settle (not this one)

- Does the next step (`spec`) just patch the stale status line, or does the chain jump straight
  to verifying/committing the existing implementation? The task instructions for this chain say
  step order is context → spec → review-spec → implement → run-tests → commit-push → document →
  deploy; if steps 2-4 re-run against a design that's already built, they should recognize that
  from this brief rather than rewriting it.
- Who executes Phase 4 (the fresh measurement + broken-test check)? It requires a full
  triggered run after this work ships, which is a chain of its own — confirm whether that's this
  task's own `run-tests`/`document` steps closing the loop, or a follow-up todo for a session
  after deploy.
