# A step cezar stopped is not a step that failed

**Status:** implemented 2026-08-20. Extends
`.ai/specs/2026-08-20-agent-step-inactivity-timeout.md` (implemented `e3f542df`), which fixed the
CAUSE of the reported kills. This spec fixes the CONSEQUENCE that one left untouched.

## TLDR

`e3f542df` stopped agent steps being killed for working hard: the runner bound now measures
SILENCE, re-armed on every line the agent emits, instead of total duration. That removes the false
positive. It does not change what happens when a stop is genuinely warranted — and there, three
things are still wrong, all of them visible in the original incident on run `9d09795a`:

1. the step is recorded `failed`, indistinguishable from a real agent failure;
2. the whole RUN is marked `failed`;
3. the workflow's remaining steps are abandoned, and the run degrades into `continue-N` chat.

On `9d09795a` the stopped `implement` step had its code written, its gates green and its commit
made. The record still said `failed`, and the owner had to hand-annotate the handoff to explain
that it was not. A stop cezar chose is not an outcome the agent produced, and the record has to be
able to tell them apart.

## Solution

> A session cezar stops for inactivity is not an agent failure. The step records
> `stopReason: 'inactivity'`, the run parks at `review`, the workflow's later steps stay `pending`,
> and the stopped step is re-entered ONCE against the same session before the run gives up.

Four changes:

1. **The runner says WHY.** The `error` event carries `reason: AgentStopReason` when cezar
   initiated the stop, and nothing at all when the agent genuinely failed. Every runner emits it
   through one shared `stopMessage()`, so the log, the record and the cockpit read the same
   sentence.
2. **The engine acts on it.** `review` + `stopReason`, never `failed` + `runError` — the precedent
   `stopReason: 'budget'` set for exactly this category of fact. The steps after the stopped one
   are never touched, so they stay `pending` and the chain is still there to finish.
3. **The step is re-entered once**, resuming the same session id, with a prompt that tells the
   agent why its turn ended and to land what it has. Bounded at one retry: a second stop is
   terminal.
4. **The cockpit stops calling it a failure** — amber "stopped" in the step rail and the attention
   pill, and a banner that says the work is incomplete rather than ready to read.

### Also fixed here, both found while implementing

- **The grace window was a lie.** The deadline handler destroyed `stdout` immediately and the read
  loop broke on the flag, so the 10s SIGTERM→SIGKILL window bought nothing: the CLI's parting
  frames — its final message, a handoff write, a `CEZ:SPEC_PATH` declaration — were thrown away
  exactly when they mattered most. It now drains until the stream really ends.
- **`pi-runner` was never converted.** `e3f542df` changed claude, codex and opencode. A pi step was
  still killed for DURATION — the original defect, surviving on the one backend nobody measured.

### Decisions

- **`review`, not a new status.** `RunStatus`/`StepStatus` are published unions in a released npm
  package; adding a member breaks every consumer switching over them exhaustively. `review`
  already means "stopped, a human must look", and is already resumable from Continue.
- **The step keeps `status: 'failed'`** for the same reason, with `stopReason` carrying the fact
  `status` cannot. An older cockpit renders exactly what it renders today.
- **One retry, not N.** The work is on disk and in the session, so re-entering is cheap and a cold
  continuation is not. But a step that stalls twice is a hang, and looping on it is how a bound
  becomes a budget leak.
- **`CEZ_RUN_IDLE_TIMEOUT_MS`** gives the bound an operator seam it never had — 30 minutes was a
  hard-coded constant, so tuning it meant patching source. Unparseable or negative reads as unset,
  never as `0`: a typo must not silently disable a safety bound.

### Known residual gap (NOT fixed here)

The workflow's **last** agent step is interactive and spawned with `timeoutMs: 0`, so it carries no
inactivity bound at all. `IDLE_TIMEOUT_MS` covers it BETWEEN turns; a turn that wedges mid-flight
on that step is unbounded. Deliberately out of scope — it is a live design decision of the shipped
spec, not an oversight of this one — but it is the next thing to look at, and every fixture in
`step-stopped.test.ts` had to be shaped around it.

## Verification

Executed, not planned:

1. `packages/cezar/src/core/claude-cli-runner.test.ts` — frames emitted AFTER the SIGTERM still
   reach the result (red if `stdout.destroy()` or the loop's early break is restored); the stop is
   reported with `reason: 'inactivity'`; 90 minutes of work in 50s gaps is never stopped.
2. `packages/cezar/src/workflows/step-stopped.test.ts` — end-to-end through the real engine with a
   mock agent that hangs (`CEZ_MOCK_HANG=1` / `mock:hang`) and a 1.5s bound, because the defect
   lives in the seam between the runner's error event and the step loop: a permanently silent step
   parks the run `review` + `stopReason: 'inactivity'` with the later steps `pending` and no
   `continue-N`; a recoverable one is re-entered exactly once (`iterations === 2`) and the chain
   carries on; the metrics carry reason/workflow/elapsedMs/attempt; a healthy run is untouched.
3. Gates: `npm run typecheck` clean across contract → client → server → web. Vitest over
   `core`/`workflows`/`runs`/`server`/`config`: **3088 passed, 22 failed in 5 files** — and the
   SAME 22 in the SAME 5 files with this change stashed. All pre-existing
   (`server/agent-pool-selection-api`, `server/health-forge`, `server/local-org-scope`,
   `server/projects-api`, `workflows/agent-profile-wiring`), none touched by this change.

**QA needed:** no production run has yet been stopped under this code. Confirming it end-to-end
needs a real step to go silent for 30 minutes.
