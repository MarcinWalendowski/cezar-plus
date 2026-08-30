# Brief: show each retry's time in the tree UI, with aggregated total as step time

**Task id:** 6ed5bc42-b99d-4f6d-a346-de794980718c
**Step:** Gather the record only. No spec, code, or tests were written or run.
**Date:** 2026-08-29

## The problem, in this repository's own terms

When a workflow step (`RunRecord.steps[i]`, `packages/contract/src/runs.ts:64-116`) is retried, the cockpit's tree/rail view (`StepRail`, `packages/web/src/routes/task-thread/step-rail.tsx:77-121`) already shows a bare `×N` iterations badge (`step-rail.tsx:104-108`), but its duration clock, `StepClock` (`step-rail.tsx:263-280`), reads only the *current* attempt's elapsed time via `stepElapsed` (`packages/web/src/routes/task-thread/step-timing.ts:38-48`). This is because the backend overwrites `startedAt` on every retry re-entry instead of keeping one record per attempt (`packages/cezar/src/workflows/run.ts:5760-5765`, and the parallel interactive-continue path at `run.ts:4787-4788`), and `finishedAt` is only ever set once, on a true terminal status, in `finishStep` (`run.ts:8283-8288`) — a failed/retried attempt's own `finishedAt` is never recorded. So a step wearing `×3` today shows the third attempt's duration, not the three attempts' individual times or their sum.

The task asks for two things the current model cannot produce: (1) each retry's own elapsed time, individually visible in the tree UI, and (2) the step's headline "time" changed from single-attempt elapsed to the sum across all attempts.

## What the record already decided

1. **This exact gap was already identified, named, and deliberately deferred** — not overlooked. `.ai/specs/2026-08-20-step-and-tool-call-durations.md` (KB `specs-055be85ab716`, status DONE, shipped `69b4a3de`), Risk R3 (spec line ~339): *"`iterations > 1`: `startedAt` is overwritten on each attempt (`run.ts:3360`), so the rail shows the current attempt, not the cumulative cost... Cumulative-across-attempts would need a new persisted field — out of the web-only class, and not asked for."* That spec's own doc comment survives verbatim in the code today: `step-timing.ts:34-36` on `stepElapsed`. This task is, in the spec's own terms, exactly the follow-up that was scoped out.

2. **Retries are currently capped at one, via two independent in-memory mechanisms**, both per-run `Set`s checked once per step id — not an open-ended retry count:
   - Cold-broker retry (broker started but never answered): `retriedColdBroker` Set, `run.ts:5738`, trigger at `run.ts:5905-5933`. Spec: `.ai/specs/2026-08-22-bounded-transient-broker-retry.md` (KB `specs-bbd072143122`), status DONE, commit `2258aee0`, deployed. That spec explicitly declined a >1 retry policy: *"Deliberately NOT done here: More than one retry... Both precedents chose one."* Its only UI surfacing today is a dim transcript `note` line plus a `run.step.retried_cold_broker` metric event — no tree-UI duration/attempt display exists or was designed.
   - Missing-session retry: `resumedAfterMissingSession` Set, `run.ts:5883-5901`, identical overwrite pattern.
   - Separately, `workflowStepDefSchema.onFail = { retry: <stepId>, max: number }` (`packages/contract/src/workflows.ts:70-73`) drives a verify-fail retry loop with its own in-memory counters (`retriesUsed`, `verifyRetries` maps, `run.ts:5655-5659`), which is not capped at 1 by construction — `max` is author-set per step. This is the path most likely to produce `iterations > 2` in practice.

3. **The individual attempt timestamps already exist on the wire, just not persisted into `StepState`.** Every attempt emits `step-start` (carrying `iteration`, e.g. `run.ts:4792`, `5766`, `5197`, `5223`) and `step-end` events, each stamped with `ts`/`seq` by `Store.appendEvent` (`packages/cezar/src/runs/store.ts:1151-1161`). The retry announcement itself also emits `note` and `metric` events (`run.ts:5915-5928`). The NDJSON event schema is deliberately open (`runEventSchema`, `packages/contract/src/events.ts:22-28`, a `z.looseObject`), served via `GET /api/v1/runs/:id/events` and `runs/event-history.ts`. So per-attempt timing is technically reconstructable from event history today without any `StepState` schema change — this is the same design pattern the prior spec already used for tool-call durations (computed client-side from `item.started`/`item.completed` frames, never persisted as a field).

## Code actually involved

- `packages/contract/src/runs.ts:64-116` — `stepStateSchema`/`StepState`. No `attempts` array exists; only `iterations`, `startedAt`, `finishedAt` (single values, last-attempt-wins).
- `packages/cezar/src/workflows/run.ts` — the two step re-entry sites that overwrite `startedAt` (`4787-4788`, `5760-5765`), the two retry trigger sites (`5883-5901`, `5905-5933`), `finishStep` (`8283-8288`), and the `step-start`/`step-end` event emission call sites (`4792`, `5197`, `5223`, `5766`, and the `finishStep` end-event at `8294-8300`).
- `packages/cezar/src/runs/store.ts:598-604` (`RunEvent` interface) and `:1151-1161` (`appendEvent`) — the NDJSON event log a reconstruction approach would read from.
- `packages/web/src/routes/task-thread/step-timing.ts:38-48` — `stepElapsed`, the single-attempt duration computation that needs a sibling (attempt list + sum) or a replacement.
- `packages/web/src/routes/task-thread/step-rail.tsx` — `StepRail` (`77-121`), the `×N` badge (`104-108`), and `StepClock` (`263-280`) — the render sites that show today's counter/clock and would carry the new per-attempt list and aggregated total.
- `packages/contract/src/workflows.ts:70-73` — `onFail.retry`/`max`, the schema governing how many retries a step can actually accrue beyond the two hardcoded single-retry paths.

## Duplicate and in-flight check

`cezar todo list` reports no todos filed. No existing brief in `.ai/specs/briefs/` combines "retry" with "tree"/"step time"/"aggregated" (grepped separately: 14 briefs mention retry, all about broker retry mechanics; 3 mention step time/duration/aggregated, none about retries). No git history collision: `git log --all --oneline | grep -i retry` surfaces broker/session-retry commits only (`32b37321`, `e9248eed`, `b885e11b`, `2258aee0`, `88c755fb`, `8ad38e17`, `3116c03e`), none touching `step-rail.tsx` or `step-timing.ts`; `tree`-matching commits are all about git worktrees, unrelated. This is genuinely unstarted work, not a re-check.

## Prior decisions this change would contradict

- `.ai/specs/2026-08-20-step-and-tool-call-durations.md` Risk R3's disposition — "not asked for," scoped out, kept web-only — is directly reopened by this task. The new spec should record itself as the follow-up that changes that disposition, not silently redo the same analysis.
- If the implementation approach is a persisted `StepState.attempts` field (rather than event-history reconstruction), it crosses out of the "web-only" classification the prior spec used to justify deferring this. That classification boundary itself is not a hard rule found elsewhere in the record — it was this one spec's own scoping choice — so crossing it is a scope decision to make explicitly, not a rule to break.
- The cold-broker and missing-session retry specs (`2026-08-22-bounded-transient-broker-retry.md`, and its sibling `.ai/specs/2026-08-22-...retried-once...md`) deliberately kept retry visibility to a dim transcript note; this task asks for first-class, structured UI surfacing of the same event, which is a visibility upgrade those specs didn't anticipate.

## Open questions the spec must settle

1. **Persisted field vs. event-derived reconstruction.** Does `StepState` gain an `attempts: { iteration, startedAt, finishedAt? }[]` array populated by `run.ts` at each retry re-entry (a store/contract schema change, no backward-compat constraint per house rules — reshape directly), or is per-attempt timing reconstructed from existing `step-start`/`step-end` NDJSON events at read time (web/API-layer only, mirroring the prior spec's tool-call-duration pattern)? The latter avoids a schema change but requires event-history retention to cover a run's full lifetime, which needs verifying against `runs/event-history.ts`'s actual retention/paging behavior.
2. **What counts as an "attempt" for events not driven by the two hardcoded retry paths?** The `onFail.retry`/`max` verify-fail loop can produce `iterations > 2`; does it hit the same `startedAt`-overwrite code path (evidence says yes, since it's the same loop re-entry), and does it emit the same `step-start`/`step-end` pair per attempt? Needs confirming before deciding whether one mechanism covers all retry sources or only the two Set-gated ones.
3. **Render design.** Does the `×N` badge become expandable/hoverable to list each attempt's individual time, with `StepClock` changed to show the aggregated sum as the row's headline number? Or does the aggregate replace the badge's label outright? Needs a concrete UI decision, not just a data-layer one.
4. **Failed-attempt timing.** Since `finishedAt` is only set on true terminal status (`finishStep`), a retried-away failed attempt currently has no recorded end time at all. Does each retry's `finishedAt` come from the retry-trigger's own event timestamp (`ts` on the `note`/`metric` event at `run.ts:5915-5928`) rather than a `StepState` field, regardless of which persistence approach is chosen?
5. **Backfill for runs in flight or already completed when this ships.** Old runs' `StepState` never had more than the last attempt's `startedAt`; event-history reconstruction may still recover their earlier attempts (events aren't overwritten), but a persisted-field approach would show old multi-attempt steps as if they had only one attempt. This asymmetry should be an explicit, stated tradeoff in the spec, not discovered later.

## Facts that constrain the next step most

1. This is a reopened, previously-deferred risk (R3) with a citation trail already in the code (`step-timing.ts:34-36`) — the spec should explicitly supersede that risk's disposition rather than re-litigate it from scratch.
2. The backend destroys per-attempt data today: `startedAt` is overwritten and `finishedAt` is never set on a retried-away attempt, but the raw timestamps survive independently in the NDJSON event stream — so the central design choice is persisted-field vs. event-reconstruction, and it decides the blast radius (contract schema change vs. web/API-only).
3. Only two retry paths are hardcoded to a single retry each (cold-broker, missing-session); the general `onFail.retry/max` mechanism can produce more than one retry and must be checked for the same overwrite behavior before assuming the fix covers every retry source.
4. No duplicate or in-flight work exists; this is new scope, not a re-check of already-shipped work.
