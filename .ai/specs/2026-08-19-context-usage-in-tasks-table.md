# Context usage in the tasks table

**Status:** implemented
**Date:** 2026-08-19

## TLDR

Next to the per-run **CPU** and **Mem** columns in the tasks tables, show a combined
**Context** column — how full the agent's context window is right now over its maximum,
e.g. `45k / 200k`. Current from the latest turn's prompt size; max from the model.

## Problem

The tasks tables (`/` overview and global `/tasks`) show per-run CPU% and memory of the
agent's process tree, plus cumulative IN/OUT token counts. Neither answers "how close is
this session to filling its context window?" — the number that predicts an imminent
compaction/auto-continue. Cumulative `inputTokens` is a running SUM across every turn, not
the occupancy of the window right now, so it cannot be reused for this.

## Solution

Two new numbers per run:

- **`contextTokens`** — current context occupancy. **Corrected 2026-08-20 by
  "point-in-time context occupancy": the original mechanism below took this from the
  turn's `usage`, which for Claude/opencode is a per-turn CUMULATIVE total that SUMS every
  internal API round-trip's prompt — a 50-round-trip session read `~50 ×` the window and
  the cell showed `10M / 200k`, `28M`. It is now the prompt size of the MOST RECENT single
  model call in the turn (`input + cacheRead + cacheWrite` of that one call), reported by
  each mapper on `UiTurnCompletedEvent.contextTokens`. See "Point-in-time correction"
  below; the original wording is kept for history.** ~~Current context occupancy = the
  MOST RECENT turn's prompt size (`input + cacheRead + cacheWrite`, excluding `output`
  which is generated, not part of that turn's input). Overwritten each turn (not
  accumulated), so it tracks "now".~~
- **`contextWindow`** — the model's maximum context, derived from the model string:
  `[1m]` → 1,000,000; any Claude model (opus/sonnet/haiku) → 200,000; otherwise unknown
  (omitted — the cell then shows only the current figure rather than inventing a max).

Rendered as one combined `Context` column, `used / max` with a compact `k`/`M` format
(`45k / 200k`), tinted amber past 75% and danger past 90% of the window.

## Point-in-time correction (2026-08-20)

The turn-level `usage` on `turn.completed` is a **cumulative** total for the whole turn,
so `input + cacheRead + cacheWrite` of it is a SUM across every model call the agent made
inside that turn — not the window's current fill. Within a turn the prompt only grows (each
tool result is appended), so the correct occupancy is the **last (largest) single call's**
prompt. New optional field `UiTurnCompletedEvent.contextTokens` carries that per-call figure,
computed by whichever mapper knows the backend's token semantics:

- **claude** (`claude-ui-mapper.ts`): the last MAIN-agent (`parent_tool_use_id` absent)
  `assistant` frame's `message.usage` = `input_tokens + cache_read_input_tokens +
  cache_creation_input_tokens`. Subagent frames are skipped — a subagent's small window is
  not the main session's. Reset at `turn.started`. (The `result` frame that used to feed
  this is the SUM of every call's usage — the exact source of the inflation.)
- **opencode** (`opencode-ui-mapper.ts`): the MAX per-message prompt among the turn's
  messages, not `usageForMessages`' sum (which stays the turn's cumulative `usage`).
- **codex** (`codex-ui-mapper.ts`): `last.input` — codex's `inputTokens` already INCLUDES
  the cached prefix, so adding `cacheRead` would double-count.
- **pi**: not stamped; its `turnUsage` is already the last message's usage (point-in-time),
  so `recordUsageUiEvent` falls back to the old formula for it with no change in behavior.

`recordUsageUiEvent` prefers `event.contextTokens` and falls back to `input + cacheRead +
cacheWrite` only when a mapper did not stamp it. The denominator (`contextWindow`) is
unchanged and correct: cezar launches Claude with the standard 200k window (no
`context-1m` beta), so `45k / 200k` is right until that beta is enabled.

## Architecture

- **Capture** (`workflows/run.ts::recordUsageUiEvent`): on `turn.completed`, persist
  `contextTokens` on the step (OVERWRITE — latest turn wins), preferring the mapper's
  point-in-time `event.contextTokens` and falling back to `input + cacheRead + cacheWrite`
  of the turn `usage`. The existing `inputTokens`/`outputTokens` accumulation is untouched.
- **Roll up** (`runs/store.ts::updateStep`): run-level `contextTokens` = the latest
  started agent step's value (the current session); `contextWindow` =
  `contextWindowForModel(run.model, run.modelIdentity)`. Both recomputed on every step
  update, like `inputTokens`/`costUsd`.
- **New pure helper** (`core/context-window.ts`): `contextWindowForModel()`, unit-tested.
- **Cross-project index** (`server.ts::runIndexEntry`): copy both fields onto
  `RunIndexEntry` so the global `/tasks` table has them.
- **Contract** (`contract/src/runs.ts`): `contextTokens` on `stepStateSchema` +
  `runRecordSchema`; `contextTokens` + `contextWindow` on `runRecordSchema` and
  `runIndexEntrySchema`. All additive/optional — an absent field means "predates this".

## Data model

| field | where | meaning |
|---|---|---|
| `StepState.contextTokens` | persisted per step | latest turn's prompt size for that step |
| `RunRecord.contextTokens` | persisted per run | latest agent step's context occupancy |
| `RunRecord.contextWindow` | persisted per run | model max context, or absent if unknown |
| `RunIndexEntry.contextTokens` / `contextWindow` | derived on read | copied from the record |

## Display

`web/src/lib/task-columns.ts`: new foldable `context` column after `memory`.
`web/src/lib/tasks-table.ts`: `formatTokenCount` + `contextCell(run)` (pure, tested).
`web/src/routes/tasks-overview.tsx`: icon + cell + card meta.
`web/src/routes/global-tasks.tsx`: a fixed `Context` column next to CPU/Mem.
(Workspace `/workspace/tasks` shows neither CPU nor Mem, so it is out of scope.)

## Risks

- **Non-Claude runners**: Codex/OpenCode window sizes are not modelled → `contextWindow`
  absent → the cell honestly shows only the current figure. Adding those sizes later is
  one map entry in `contextWindowForModel`.
- **Model as free text**: `run.model` may be `auto`; `modelIdentity` (the resolved
  `provider/model`, #405) is checked first, so `auto` still resolves once known.

## Verification

- Unit: `context-window.test.ts` (`[1m]`, claude variants, unknown); `tasks-table` cell
  formatting (used-only, used/max, thresholds, empty); `store` roll-up (latest wins, not
  summed); `run.ts` recordUsage persists overwrite context.
- Component: tasks-overview + global-tasks render the column with data and em-dash empty.
- Contract parity tests already cover the new fields against the routes both directions.
