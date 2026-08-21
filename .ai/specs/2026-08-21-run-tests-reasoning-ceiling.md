# `run-tests` output-token ceiling

**Status:** draft (2026-08-21). Brief: `.ai/specs/briefs/2026-08-21-run-tests-output-tokens.md`.

## TLDR

On the measured run (`70f19253-cf6b-407c-92e0-96a8020a8ebb`), `spec-to-deploy`'s `run-tests`
step spent 43,583 output tokens — ~76% of them invisible (extended-thinking) tokens, per
`usage.updated` at seq 1875 of that run's own `.ndjson` — to run 34s of gates and then keep
root-causing a failure it had already proven, twice over, was not its fault. This spec adds one
mechanical lever (an explicit `--effort` ceiling, plumbed through as a new per-step knob and
set on `run-tests` only) and one behavioral lever (a prompt clause that stops diagnosis the
moment fault is localized), plus documents the specific bug that triggered the run's own
over-diagnosis so no future `run-tests` step re-pays the discovery cost. It does **not** touch
`npm test`'s baseline (todo `c78140a8-55b0-4cc2-8d52-d2be468916fe`) — measured and confirmed
inapplicable, see below.

## Problem

`run-tests` is step 5 of the built-in `spec-to-deploy` workflow
(`packages/cezar/src/workflows/types.ts:755-804`, prompt built on `SPEC_TO_DEPLOY_STEP_MODEL`
= `'sonnet'` since commit `a5f04b0f`). Its contract, in its own prompt, is: run the gates, fix
what the diff broke, report pass/fail with the exit-marker line quoted. On the measured run it
instead:

1. Correctly ran `npm test` (2 failed / 9515 passed — both pre-documented in AGENTS.md's C18 /
   `add-project-dialog` traps) and recognized both in one pass. Cheap, and not the problem.
2. Hit a **second, previously undocumented** red: `npm run test:package` failed 1/15
   (`packages/cezar/test/e2e/package-cli.test.ts:86`, "the release tarball installs and runs
   the dry-run CLI workflow"). It reproduced the failure directly against the built CLI, then
   reproduced it **identically against the parent checkout's `dist` at commit `f0d48513`** — a
   commit containing none of this run's change. That second reproduction is the proof the
   failure predates the branch; it is also exactly the discipline AGENTS.md's own traps section
   asks for ("localise the fault to what both runs share," `AGENTS.md:337-343`).
3. **Kept going anyway**, five probes past that proof: A/B'd `CEZ_RUN_BROKER=0` vs. the default
   broker path, A/B'd the env scrub, A/B'd a TTY (`script -qec`), read
   `claude-cli-runner.ts`'s broker-attach code and `index.ts:233`, and had to hunt down and
   `kill` several orphaned probe processes by PID.
4. Filed the result as a real, well-evidenced todo and correctly declined to fix it ("the
   broker/spool subsystem is outside this task, the red predates the branch").

Step 4 is the right outcome. Step 3 is the cost this spec removes. Per the brief's direct count
of the run's own transcript: 29 visible assistant text blocks (≈1,900 tokens) and 37 tool-call
bodies (≈8,000 tokens) account for only ≈24% of the 43,583 total. **The other ≈76% never
appears as a visible event in the log** — it is extended-thinking spent forming and
interpreting each of the nine diagnostic probes in step 3. A prompt fix aimed at prose
("stop narrating") cannot reach three quarters of the spend, because the spend was never
narration.

**Why this needs a structural lever, not only a prompt one.** This repo already ran the
prompt-only experiment on the sibling problem (round trips, not reasoning depth) and measured
the result: the tool-budget doctrine shipped in `.ai/specs/2026-08-20-agent-round-trip-batching-and-fanout.md`
(KB `notion-333c1a0a847b` / `notion-20c9698de5f9`) asked agent steps to batch tool calls, and a
later re-measurement (KB `notion-cc6ebabb2ab4`, 2026-08-21) found the batch factor had moved
1.00 → 1.02 and wall clock had not moved at all — "the fix that spec shipped did not move the
number it was written to move." A prompt clause asking an agent to stop diagnosing sooner is
exactly this shape of fix, and this repo has direct, recent evidence that this shape of fix can
ship, read as correct, and change nothing measurable. This spec ships the prompt clause anyway
(cheap, plausibly load-bearing, and the acceptance criteria ask for it) but does not rely on it
alone, and Phase 4 re-measures rather than assumes — the same mistake `notion-cc6ebabb2ab4`
corrects for the batching fix must not repeat here.

**The `npm test` baseline does not apply.** Todo `c78140a8-55b0-4cc2-8d52-d2be468916fe` records
`npm test` red with 2,152 failures on the prod box, independent of any change — confirmed by
reading the todo directly (`acceptanceCriteria`: React 19 / `React.act`, `TMPDIR` outside the
repo, or the gate stops being listed). The measured run's own `npm test` output was `Tests 2
failed | 9515 passed | 1 skipped (9518)` — the number 2,152 appears nowhere in this run. Both
failures were the documented C18 / `add-project-dialog` traps, recognized in one pass. This
task stays independent of `c78140a8`.

## Solution

Two levers, plus one piece of documentation:

1. **A per-step `effort` knob**, mirroring the existing per-step `model` knob
   (`.ai/specs/2026-08-21-per-step-model-policy.md`) exactly: a new optional field on
   `workflowStepSchema`, threaded through `runAgentStep` into `AgentRunSpec`, and consumed by
   `buildClaudeArgs` as the claude CLI's own `--effort <level>` flag (`claude --help`:
   `low | medium | high | xhigh | max` — confirmed present on the pinned CLI, `claude
   2.1.233`, the same binary `claude-cli-runner.ts` spawns via `CEZ_CLAUDE_BIN ?? 'claude'`).
   Additive and backend-scoped: every step that does not set `effort` gets exactly today's
   behavior (the flag is omitted, same as now), and the two non-claude runners
   (`codex-app-server-runner.ts`, `opencode-server-runner.ts`) never read `AgentRunSpec.effort`
   at all, so this cannot change their behavior.
2. **`run-tests` sets `effort: 'medium'`.** This is the mechanical cap: extended-thinking spend
   is bounded by the CLI itself, at the source, rather than hoped into submission by prompt
   wording. `medium` is a judgement call, not a measurement — chosen as a middle point that
   should still leave enough reasoning budget to correctly interpret a gate failure, while
   capping the open-ended, iterative root-causing this run's step 3 did. Phase 4's fresh
   measurement is what actually settles whether `medium` is the right level; if it turns out to
   suppress real diagnosis (a gate failure genuinely goes unexplained), the fix is raising this
   one constant, not re-designing the mechanism.
3. **A diagnostic-depth ceiling in the `run-tests` prompt.** The current prompt
   (`types.ts:770-771`) says "If any fail, FIX the code and re-run until they pass" with no
   carve-out for a failure that is confirmed pre-existing and outside the diff. Add one: once a
   failure reproduces identically against a control that does not contain this run's change
   (clean HEAD, the parent checkout, `git stash` — one control run, matching the method AGENTS.md
   already teaches), that is sufficient proof of "not mine." File a todo with what is already
   known and stop — no further env A/B, no source spelunking, no process hunting. This targets
   exactly the run's step 3, while leaving step 2's method (the control reproduction itself)
   untouched, because that step is what makes "not mine" a proven fact instead of an assumption.
4. **An AGENTS.md trap entry for the broker-stall bug itself** (todo
   `c895a348-4bee-4a81-89ab-a62788a6a118`: "The run broker stalls a one-shot `cezar run` at its
   first agent step"), in the same location and shape as the existing C18 / `add-project-dialog`
   traps (`AGENTS.md:250-344`). The brief's own evidence for why this works: the run recognized
   the two *documented* `npm test` failures in one pass, and spent five probes on the *one*
   `npm run test:package` failure that had no trap yet. Documenting this failure directly
   converts a future occurrence from "five probes" to "one pass," independent of whether levers
   1-3 also help.

## Architecture

Effort resolution mirrors model resolution exactly, one level simpler (no per-backend
normalization table — `effort` is a fixed five-value enum the claude CLI defines, not a model
alias that differs per backend):

```
step.effort  ──►  AgentRunSpec.effort  ──►  buildClaudeArgs: if (spec.effort) args.push('--effort', spec.effort)
   (workflow                                        (claude-cli-runner.ts, alongside the
    definition)                                       existing --model handling)
```

No lookup table, no `agentModelsLocked`-style kill switch — `effort` is not a cost/identity
control the way `model` is (an org cannot be forced onto a specific model tier by an `effort`
value), so it does not need the lock's escape hatch. `codex-app-server-runner.ts` and
`opencode-server-runner.ts` take `AgentRunSpec` too, and neither reads `.effort` — the same
"decorative on runners that don't consume it" shape `bashAllowlist`/`allowedTools` already have
today (`claude-cli-runner.ts:679-685`'s own doc comment already describes this pattern for
another field).

## Phases

**Phase 1 — the knob, defined and applied to `run-tests` only.**

- `workflowStepSchema` (`packages/cezar/src/workflows/types.ts`) gains
  `effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional()`.
- `AgentRunSpec` (`packages/cezar/src/core/agent-runner.ts:38-72`) gains `effort?: string`,
  next to `model?: string`.
- `runAgentStep` (`packages/cezar/src/workflows/run.ts`, where `backendModel` is resolved at
  ~4560-4583 and where the `openSession` call builds its spec at ~4633-4677) passes
  `effort: step.effort` straight through — no normalization step, unlike `model`.
- `buildClaudeArgs` (`packages/cezar/src/core/claude-cli-runner.ts:691-728`) gains, alongside
  the existing `if (spec.model) { args.push('--model', spec.model); }`:
  `if (spec.effort) { args.push('--effort', spec.effort); }`.
- A new constant next to `SPEC_TO_DEPLOY_STEP_MODEL` (`types.ts:526`):
  `const RUN_TESTS_STEP_EFFORT = 'medium';`, and `run-tests`'s step definition
  (`types.ts:755-804`) gains `effort: RUN_TESTS_STEP_EFFORT`. No other step sets `effort`, so
  every other step's behavior is provably unchanged (the field stays `undefined`, the flag
  stays omitted, byte-for-byte the same argv as today).
- Unit tests in `packages/cezar/src/core/claude-cli-runner.test.ts` (alongside the existing
  `buildClaudeArgs` cases at lines 42-107): `--effort` is emitted when `spec.effort` is set, in
  the exact position, and omitted entirely when unset (mirroring the existing "omits the flag
  entirely when no systemPrompt is set" case at line 49).
- A test in `packages/cezar/src/workflows/types.test.ts` (alongside the model-policy assertions
  at lines 154-183): `run-tests` carries `effort: 'medium'` and it is a member of the enum;
  every other step's `effort` is `undefined`.

**Phase 2 — the diagnostic-depth ceiling, in the `run-tests` prompt.**

Add a clause to `run-tests`'s prompt (`types.ts:755-804`), directly after the existing
execution-discipline bullets and before the closing report instructions:

> Once a failure reproduces IDENTICALLY against a control that does not contain this run's
> change (clean HEAD, the parent checkout, `git stash` — see AGENTS.md's own method for why one
> shared-cause control is proof, not evidence), that is sufficient to call it "not mine." Stop
> there. Do not also A/B environment variables, spawn additional probes, or read the implicated
> subsystem's source hunting for a root cause — that diagnosis is real work, but it belongs to
> whoever picks up the todo, not to a step whose contract is pass/fail. File what you already
> have (`cezar todo add`): the failing test, the one repro command, the one control command, and
> the shared file/line if the output already shows it. Then move on.

And extend the existing closing instruction (`types.ts`, the "End your report with..." block)
to state the acceptance criteria's own wording directly:

> Report pass/fail plainly. Quote the failing test's own output verbatim — never re-explain
> what the diff changed; that is already in the commit this step is about to hand to
> `commit-push`.

A `types.test.ts` case (same pattern as the existing "makes run-tests wait on the process"
tests at lines 320-339): the `run-tests` prompt contains a stop condition tied to "not mine" /
control reproduction, and contains the "quote... verbatim" / "never re-explain" instruction.

**Phase 3 — the AGENTS.md trap entry.**

Add a fifth entry to "Four environment traps that make the gates LIE" (`AGENTS.md:250-344`,
whose heading is already amended once for a fourth trap — same pattern, add a fifth line to the
heading's own note and a numbered entry in the body) documenting the broker-stall failure:
`npm run test:package` fails 1/15 on `package-cli.test.ts:86`, the dry run stalls at step 1 with
run status stuck `running` and CLI exit 0, reproduces identically at clean HEAD (so it predates
any branch), and the decisive control is `CEZ_RUN_BROKER=0` (finishes) vs. the default brokered
path (stalls) — cite todo `c895a348-4bee-4a81-89ab-a62788a6a118` for the live status and
acceptance criteria rather than re-deriving them. This is independent of Phases 1-2 and reduces
cost the moment it lands, on any future `run-tests` step that meets this red before the todo is
fixed — not gated on the knob or the prompt clause working.

**Phase 4 — fresh measurement (the phase that actually settles this).**

Not optional, and not satisfied by re-reading the opus-era 43,583 figure — that run predates
`a5f04b0f` (2026-08-21 21:52 UTC, per-step model policy landing `run-tests` on sonnet) by 82
minutes and is not a valid baseline for a post-fix comparison (brief, "A confound the next step
must not miss"). After Phases 1-3 ship:

1. Trigger one `spec-to-deploy` run on this repo (any small, real task) and let it reach
   `run-tests`.
2. Extract that step's own token spend directly from the run's `.ndjson` — the exact recipe the
   brief used, no new tooling required:
   ```bash
   grep '"type":"usage.updated"' .ai/cezar/runs/<runId>.ndjson \
     | grep '"stepId":"run-tests"' | tail -1
   # {"type":"usage.updated","usage":{...,"output":N,...},"costUsd":...,"stepId":"run-tests",...}
   ```
3. Confirm `N < 20000`.
4. Deliberately break one test on the branch that run is testing (a trivial, obvious assertion
   flip) before triggering it, and confirm the broken test is named in `run-tests`'s own report
   and the step does not report green — proving the effort ceiling and the diagnostic-depth
   clause did not cost real failure detection.
5. Record the measured number in the `document` step's normal knowledge sync (no separate
   action needed — this is the existing pipeline, not new process).

## Data models

`workflowStepSchema` (`packages/cezar/src/workflows/types.ts`):

```ts
effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
```

Round-trips through `workflowDefSchema` the same way `model` does today — no `.catch()` needed
beyond what the object schema already provides, since an invalid value is a schema violation at
write time (workflow YAML / `POST /runs`), not a corrupt-record-on-read case the way store
fields with `.catch(undefined)` are.

`AgentRunSpec` (`packages/cezar/src/core/agent-runner.ts`):

```ts
/** claude CLI's own `--effort` (low|medium|high|xhigh|max). Claude-only — the codex and
 *  opencode runners never read this field, same as bashAllowlist is decorative for them. */
effort?: string;
```

## API contracts

None added; `GET /api/v1/workflows` already serializes each step object wholesale (the same
mechanism `.ai/specs/2026-08-21-per-step-model-policy.md` relied on for `model` to appear with
no route change), so `effort` appears on `run-tests` in that response automatically once Phase
1 lands.

## Risks

- **`medium` is a guess, not a measurement.** If it turns out too low, the observable failure
  mode is a gate that genuinely needed more reasoning going unexplained or mis-diagnosed — which
  is exactly what Phase 4 step 4 (deliberately break a test) is designed to catch before this
  ships as "done." If it turns out too high to matter, Phase 4 step 3 catches that too (still
  over 20,000). Either way the fix is a one-constant change, not a re-design.
- **The prompt clause may not move behavior at all**, per this repo's own precedent
  (`notion-cc6ebabb2ab4`, the batching prompt that shipped and didn't move the batch factor).
  This is why Phase 1 (the mechanical cap) does not depend on Phase 2 working, and why Phase 4
  measures the combined effect rather than crediting either lever separately.
- **`--effort` is unversioned in cezar's own contract with the CLI.** It is read from `claude
  --help` on the currently pinned binary (`2.1.233`); if a future CLI version renames or drops
  the flag, `buildClaudeArgs` would pass a value the CLI silently ignores or rejects. No
  detection mechanism is added for this here — the same exposure already exists for `--model`
  (`.ai/specs/2026-08-21-per-step-model-policy.md`'s own Risks section: "If the CLI ever stops
  accepting a bare alias, `normalizeModelForBackend` fails loud" — but `--effort` has no
  equivalent resolver to fail loud, since there is nothing to normalize). Worth a follow-up if
  it ever bites, not blocking here.
- **A future step could set `effort` without understanding the cap's intent** and silently
  under-power a step that genuinely needs deep reasoning (e.g. `review-spec`, which is
  read-only judgement work the opposite of what this spec targets). Mitigated by scoping Phase 1
  to `run-tests` only and leaving every other step's `effort` unset — this spec makes no claim
  about any other step.

## Verification

1. **Unit (automated).**
   - `claude-cli-runner.test.ts`: `--effort` emitted correctly when set, omitted when not.
   - `types.test.ts`: `run-tests.effort === 'medium'`, every other step's `effort` is
     `undefined`; the `run-tests` prompt contains the diagnostic-depth stop condition and the
     "quote verbatim / never re-explain" instruction.
2. **Gates.** `npm run typecheck`, `npm test`, `npm run build` green under the scrubbed
   environment AGENTS.md § Validation prescribes (all four traps, now five after Phase 3).
3. **Runtime — Phase 4, executed for real, not assumed.** A fresh `spec-to-deploy` run reaches
   `run-tests` on sonnet with `effort: medium`; its own `usage.updated` for `stepId: "run-tests"`
   reports `output < 20000`; a deliberately-broken test in that same run is named in the step's
   report and the step does not report green.
4. **In-band.** `GET /api/v1/workflows` on the deployed server reports `effort: "medium"` on
   `run-tests` and no `effort` field (or `undefined`) on every other step of the built-in
   `spec-to-deploy` definition.
