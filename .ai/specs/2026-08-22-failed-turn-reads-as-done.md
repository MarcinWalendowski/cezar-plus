# A failed agent turn reads as a done step

**Status:** Implemented — shipped `c1ccbe79` 2026-08-22 (Phase 1 failed-turn signal, Phase 2
dropped-pin dispatch guard). **CORRECTED 2026-08-23:** this spec's own record said reopening such
a run "resumes the codex thread, whose stored settings still say `model: sonnet` … indistinguishable
from nothing happening" (below) and left that open. It is now closed by
`.ai/specs/2026-08-23-codex-resume-explicit-model.md` (commit `d76058b1`, merged to `main` at
`9686b449`) — `thread/resume` now always sends an explicit, cezar-checked model instead of none.
That spec is itself QA Needed until its own V7 (real-box reopen of the two named runs) is run.
**Date:** 2026-08-22
**Owner instruction:** *"ensure this type of errors won't make steps in workflow successful"*,
*"writing spec + spec review should be by opus always, the rest can be load balanced by codex or
claude sonnet"*

## TLDR

Every codex run on `prod-host` since codex went live on 2026-08-22 has done **nothing**, and
cezar reported all of it as success. Five runs, forty-seven failed turns, zero tokens, zero diff.
Two causes, independent, both live:

1. **cezar cannot see a codex turn fail.** Codex reports a failed turn as method `turn/completed`
   carrying `turn.status: "failed"`, plus a separate `error` notification. cezar decides "did it
   fail?" from the notification *method* alone, so a hard HTTP 400 becomes `stopReason: end_turn`
   and the step is marked `done`.
2. **cezar hands codex model ids codex cannot serve.** The `spec-to-deploy` per-step model policy
   pins Claude aliases (`sonnet`, `opus`). `modelConflictsWithRunner` already exists and would
   catch exactly this, but it is applied to the run-level model only, never to `step.model`.
   Separately, all three ids in `KNOWN_PRESETS_BY_RUNNER.codex` are themselves dead.

Cause 1 is the serious one: without it, cause 2 was invisible for a day, and any *future*
codex-side error would be equally invisible.

## Problem

### Measured, on the box

Live capture against the codex app-server, spawned exactly as cezar spawns it:

```
NOTIF warning        Model metadata for `sonnet` not found. Defaulting to fallback metadata...
NOTIF error          {"status":400,"error":{"type":"invalid_request_error",
                      "message":"The 'sonnet' model is not supported when using Codex
                      with a ChatGPT account."}}   willRetry: false
NOTIF turn/completed turn.status = "failed"   turn.error = <the same 400>
```

Contrast a model that works (`gpt-5.6-terra`): `item/completed` with real text, then
`turn/completed` with `turn.status: "completed"`, `turn.error: null`. The signal is present and
discriminating. cezar just does not read it.

### The three code defects

| # | File | Defect |
|---|---|---|
| 1 | `core/codex-app-server-runner.ts` | `handleNotification` has no `case 'error'` and no `case 'warning'`. The error text never leaves the transport. |
| 2 | `core/codex-app-server-runner.ts` | The `turn/completed` / `turn/failed` case emits an error only `if (method === 'turn/failed')`. `params.turn.status` and `params.turn.error` are never read. |
| 3 | `core/codex-ui-mapper.ts` | `mapCodexNotification` hardcodes `mapTurnEnd(params, state, /* failed */ false)` for `turn/completed`, and `turnStopReason` checks `turn.status === 'interrupted'` but not `'failed'`. |

Confirmed present in the deployed release `20260822T194548Z-97909f18`, not only in source.

### The model half

`normalizeModelForBackend('codex', 'sonnet')` maps a bare id onto the backend's default provider
and returns the wire model `sonnet` (`core/model-identity.ts`). Its "fail loud" gate only fires on
an *ambiguous* id (a bare id on a backend with no default provider), so a Claude alias on codex
sails through.

`modelConflictsWithRunner('sonnet', 'codex')` already returns `true`. It is called on the
continuation path for `run.model` (`workflows/run.ts:3146`, `:3158`) with a comment naming this
exact hazard, but the per-step model policy that landed 2026-08-21 never routed through it.

Measured, all three codex presets cezar ships are dead on this account:

| id | result |
|---|---|
| `gpt-5.1-codex` | `Model metadata not found` → 400 → `status: failed` |
| `gpt-5-codex` | `Model metadata not found` → 400 → `status: failed` |
| `gpt-5.6-terra` | **works** |

Live catalog via `model/list`: `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`,
`gpt-5.4`, `gpt-5.4-mini`. So pinning vendor ids in cezar source goes stale, and has.

### Blast radius, measured

All five codex runs, checked against git rather than cezar's own record:

| run | cezar says | tokens | `git diff main...branch` |
|---|---|---|---|
| `28aec920` | needs you | 0 | empty |
| `8286b77d` | **done** | 0 | empty |
| `9cd43b1b` | needs you | 0 | empty |
| `9517b3e0` | needs you | 0 | empty |
| `0f59fcd0` | **done** | 0 | empty |

Every one of eight steps reads `done` in each. All five branches point at the same SHA. The
`diffStat` the UI shows (12 files, 3324 adds) is also false. Across all rollouts: **47 of 57 turns
failed this way** (42 `sonnet`, 5 `opus` — exactly one opus step per run).

The "stuck in needs you, cannot reopen" symptom is downstream of this, not a separate bug.
Reopening works: it resumes the codex thread, whose stored settings still say `model: sonnet`, the
turn 400s again in ~2.4s with no output, and the run returns to `waiting`. Indistinguishable from
nothing happening.

## Solution

### Phase 1 — a failed turn fails the step

Read failure from the turn itself, not from the notification method.

- `codex-app-server-runner.ts`: add `case 'error'` → emit `{ type: 'error', message }`. The
  `warning` notification is logged as a note, not an error (`Model metadata not found` preceded
  every failure here and is a useful early signal, but it is not itself fatal).
- `codex-app-server-runner.ts`: in the turn-end case, treat the turn as failed when the method is
  `turn/failed` **or** `params.turn.status === 'failed'` **or** `params.turn.error` is present.
- `codex-ui-mapper.ts`: derive `failed` the same way, in one shared helper, so the v1 event stream
  and the v2 UI stream cannot disagree. `turnStopReason` returns `error` for a failed turn.

This is deliberately general: it keys on codex's own turn status, so it catches every future
codex-side failure, not just this 400.

### Phase 2 — a model a runner cannot serve never reaches it

- `workflows/run.ts`: before `normalizeModelForBackend`, drop a step/run model that
  `modelConflictsWithRunner` rejects for the step's backend, and append a visible `note` event
  saying which pin was dropped and why. Falling back to the backend's own default is chosen over
  substituting a hardcoded id, because a hardcoded id is exactly what went stale.
- `core/model-presets.ts`: replace the three dead codex ids with the live catalog. Recorded in the
  spec and the KB as vendor knowledge that WILL go stale again; `discoverCodexModels`
  (`model/list`) is the non-stale source and should become the picker's input.

### Phase 3 — the per-step model policy the owner asked for

`spec` and `review-spec` pin **`runner: 'claude'`, `model: 'opus'`**, so "always opus" holds
regardless of which runner the run was started on. Pinning the runner is what makes it always
true: `model: 'opus'` alone would be dropped by Phase 2 on a codex run.

The other six steps keep `model: 'sonnet'`, which Phase 2 drops on a codex run so codex uses its
account default. That is "the rest can be load balanced by codex or claude sonnet" as far as
today's mechanism reaches.

**Not in scope, filed as a task:** cezar has no cross-runner load balancing. `pool:*` balances
*accounts within a provider*, not providers, and the backend is fixed per run before the pool is
consulted. Making the whole policy configurable in global settings (which steps on which model and
runner, and balancing across runners) is the owner's follow-up ask and gets its own spec.

## Risks

- **Steps that used to pass will now fail.** That is the point, but it means a codex run that was
  silently green becomes loudly red. Correct, and the alternative is the current state.
- **`turn.error` present with `status: "completed"`** is not a shape observed here. Treating it as
  failure is a deliberate over-trigger: an error attached to a turn is evidence, and the cost of a
  false positive (a visible failure) is far below the cost of the false negative this spec exists
  to remove.
- **Refreshed codex presets go stale again.** Named in the KB note rather than papered over.

## Verification

Decided up front, per repo rules.

1. **Unit, negative controls first.** A `turn/completed` frame carrying `status: "failed"` +
   `turn.error` must produce a step error and `stopReason: error`; the same frame with
   `status: "completed"` must stay green. Both directions asserted, so the test cannot pass by
   construction.
2. **Unit.** An `error` notification is surfaced as an error event.
3. **Unit.** A step whose `model` conflicts with its backend has the pin dropped and a note
   appended; a matching pin is untouched.
4. **Gates on the box**, not the loaded Mac (`fs.watch` tests go red under Mac load).
5. **Production E2E, the one that actually matters:** start a real codex run on the box after
   deploy and confirm (a) it either does real work or **fails visibly**, and (b) it never again
   reports `done` with zero tokens and an empty diff.
