# Show per-retry time on a workflow step, and total step time as the sum of its retries

- Date: 2026-08-29
- Category: feature (cockpit UI, `/tasks/:id` step rail)
- Priority signal: medium — a direct owner ask, and a named-but-declined gap in the prior
  durations spec (see below), not new ground someone forgot to write down.
- Risk signal: medium — the obvious implementation (persist a new `attempts[]` field) is a
  contract change; the cheaper one (derive from the existing NDJSON event log, matching how
  tool-call durations were done) is web-only but has not been scoped in detail — that scoping is
  this task's spec step's job.
- Routing: Next step writes the spec from this brief.

## The problem, in this repository's own terms

Owner ask, verbatim: *"if there are multiple retries of workflow step: show time of each retry in
'tree UI' and total time as step time (aggregated sum of each retry)."*

There is no component literally named "tree" in this codebase (checked
`packages/web/src/routes/task-thread/` and `packages/web/src/components/` — the only "tree" hits
are an unrelated git-file-tree view under `task-git/`). "Tree UI" is the owner's informal name for
the workflow step list on a task's page: `StepRail` (expanded, one row per step) and
`WorkflowSteps` (the collapsed one-line summary with step dots), both in
`packages/web/src/routes/task-thread/step-rail.tsx`. A "retry" is what this codebase calls an
**iteration**: `StepState.iterations` (`packages/contract/src/runs.ts:69`), rendered today as a
plain `×N` badge with no time breakdown — `step-rail.tsx:104-108`:

```tsx
{step.iterations > 1 ? (
  <span data-slot="step-iterations" className="shrink-0 text-xs text-soft-foreground tabular-nums">
    ×{step.iterations}
  </span>
) : null}
```

Right now that badge is the *only* surviving trace that a step retried. Clicking it does nothing;
there is no per-attempt drill-down anywhere in the app.

## What the record already decided (with citations)

This is a **named, declined gap** in the spec that shipped the rest of step/tool timing:
`.ai/specs/2026-08-20-step-and-tool-call-durations.md` (KB `specs-055be85ab716`, status **DONE**,
commit `69b4a3de`, deployed). Its Risk R3, verbatim:

> `iterations > 1`: `startedAt` is **overwritten** on each attempt (`run.ts:3360`), so the rail
> shows the *current attempt*, not the cumulative cost. … Cumulative-across-attempts would need a
> new persisted field — out of the web-only class, and not asked for.

That "not asked for" is now exactly what this task asks for. The same limitation is documented a
second time, in code, in the module this task will extend —
`packages/web/src/routes/task-thread/step-timing.ts:29-34` (doc comment on `stepElapsed`):

> The number is elapsed wall-clock for the CURRENT ATTEMPT. `run.ts` overwrites `startedAt` on
> every retry, so a step wearing an `×3` badge shows attempt 3, not the three summed — cumulative
> cost would need a persisted field that does not exist (spec risk R3).

**That doc comment's premise is worth re-checking before the spec assumes it.** It says a
persisted field is required; there is a second path that was true for the *original* durations
spec and is very likely true here too — see "Open question 1" below.

No other spec or KB entry touches per-iteration/per-retry timing. Searched: `cez kb search "step
retry iteration time"`, `"step iterations badge"`, `"workflow step duration"`; grepped
`.ai/specs/` for "iteration" and for filenames containing "iteration" or "retry". The only hits
are the durations spec above (R3) and unrelated broker-retry specs (below, different kind of
retry). `cezar todo list` → **no todos filed**, so nothing is in flight on this.

**A different, unrelated meaning of "retry" already exists in this codebase — do not conflate
them.** `.ai/specs/2026-08-22-bounded-transient-broker-retry.md` and
`.ai/specs/2026-08-23-bare-rollback-argv-trap.md`'s sibling
`.ai/specs/2026-08-22-workflow-step-broker-never-answered-retried-once.md`-style specs (see KB
`specs-bbd072143122`, `specs-aedad17c2af6`) cover a **broker/session-transport** retry — a step
whose backend process never answered gets relaunched once, tracked via
`resumedAfterMissingSession` / `retriedColdBroker` sets in `run.ts:5746-5749`. That is plumbing
retry, invisible to the user and not counted in `iterations`. The task at hand is about
`StepState.iterations` — the user-visible "this step ran N times" counter — not that mechanism.

## What code is actually involved (file:line)

- **Data model:** `packages/contract/src/runs.ts:64-116`, `stepStateSchema` — `iterations:
  z.number()` (line 69), one `startedAt`/`finishedAt` pair per step (lines 88-89), no
  `attempts[]` or per-iteration timestamps.
- **Where iterations increment and timestamps get overwritten:**
  `packages/cezar/src/workflows/run.ts:5757` — `const iteration = (record?.iterations ?? 0) + 1;`
  then `:5760-5765`:
  ```ts
  this.store.updateStep(runId, step.id, {
    status: 'running',
    iterations: iteration,
    startedAt: new Date().toISOString(),
    error: undefined,
  });
  emit({ type: 'step-start', stepId: step.id, name: step.name ?? step.id, kind, iteration });
  ```
  `finishedAt` is overwritten similarly at step end (e.g. `run.ts:4556`, `:5453`, `:5763`).
  `packages/cezar/src/runs/store.ts:981-993` (`updateStep`) does `Object.assign(step, patch)` on
  the single existing `StepState` object — nothing before this call survives the merge.
- **The event log already carries per-attempt data that the step record does not.** The
  `step-start` emit above includes `iteration` in its payload, and every event, regardless of
  type, is stamped with `ts` and `seq` by `appendEvent`
  (`packages/cezar/src/runs/store.ts:1151-1157`: `{ ...event, seq, ts: new Date().toISOString() }`),
  persisted to the run's NDJSON transcript. The event schema is deliberately open —
  `packages/contract/src/events.ts:22-27`, `runEventSchema = z.looseObject({ seq, ts, stepId?,
  type })`, comment: *"unknown keys pass through, because the event vocabulary is an APPEND-ONLY
  on-disk format … that old NDJSON recordings must keep replaying forever."* So a transcript
  already has, for every attempt: a `step-start` event carrying `iteration` + `ts`, and (for a
  finished attempt) a following `step-end` event with its own `ts`. This is the same shape the
  *original* durations spec exploited for tool-call timing (pairing `item.started`/`item.completed`
  by `ts`, `.ai/specs/2026-08-20-step-and-tool-call-durations.md` §"Why client-side").
- **Today, the frontend explicitly drops these events from anything except the live step rail
  glyph.** `packages/web/src/routes/task-thread/thread-state.ts:701-707` lists `step-start` in
  a deliberate no-op sweep, with the comment (line 693): *"`step-start` / non-failed `step-end`:
  the run header's step rail (step-rail.tsx) is the steps surface"* — meaning the rail is
  currently fed from the **snapshot** `RunRecord.steps` (one `StepState` per step, overwritten in
  place), not from event replay. `case 'step-end'` (`thread-state.ts:605-615`) only pushes a
  transcript note when a step *failed*.
- **Rendering surfaces:**
  - `StepRail` (expanded list), `step-rail.tsx:77-116` — per-row `×N` badge (:104-108, quoted
    above) and `<StepClock step={step} />` (:113, defined :263) which calls
    `stepElapsed(step, now)` (`step-timing.ts:29`).
  - `WorkflowSteps` (collapsed summary), `step-rail.tsx:353-408` — shows only the **current**
    step's name/model/clock (:392-393) plus a dot per step (`StepDot`, via `railVisual`); no
    per-iteration information at all, even collapsed.
  - `stepElapsed` (`step-timing.ts:22-34`) is the single function that turns a `StepState` into a
    `{ ms, live }` for both surfaces above — it is the natural seam for "sum across iterations"
    but currently has only one `startedAt`/`finishedAt` pair to read.
  - `LiveDuration` (`packages/web/src/components/live-duration.tsx`) is the shared ticking-clock
    leaf both `StepClock` and `ToolCard` durations use; it already accepts a `format` override.

## Prior decisions this would contradict, or need to respect

- **Nothing is contradicted by adding retry-level timing** — R3 in the durations spec explicitly
  *deferred* this rather than ruling it out, so this is completing a known gap, not reversing a
  decision.
- **Must respect:** "durations are measurements, never verdicts" (`.ai/specs/2026-08-20-step-and-tool-call-durations.md`
  §Solution 4, and the inactivity-timeout spec's R1, `.ai/specs/2026-08-20-agent-step-inactivity-timeout.md`)
  — no color/threshold on a slow retry, however many there were.
  - **Must respect the "web-only deploy class" preference** stated for the parent spec: a
    contract-widening field change moves this from a web-only hot-swap into the restart-required
    deploy class (relevant per `AGENTS.md` §"Always self-deploy" / manual-deploy correction). If
    retry timestamps can be derived from the already-persisted event log instead of a new
    persisted field, that is the cheaper and precedented path — see Open question 1.
  - **Must respect `stepElapsed`'s existing "render nothing over render a lie" rule**
    (`step-timing.ts` risk R6/R5 comments) — old runs recorded before this feature existed will
    have no retry-level data (or, if the derivation reads events, transcripts predating this
    change already *do* carry `step-start`/`iteration`/`ts`, so back-fill may be possible the same
    way tool durations retroactively worked on old NDJSON — worth confirming in the spec step).

## Open questions the spec step must settle

1. **Persisted field vs. client-derived from events — which, and why.** The `step-timing.ts`
   comment asserts a persisted field is required; the event log evidence above suggests the same
   client-derivation trick used for tool durations may work here too (pair each `step-start`
   event, keyed by `iteration`, with the next `step-start` for that `stepId` or the step's
   terminal state/`finishedAt` for the last attempt). This needs to be worked out concretely,
   including: does the frontend currently hold the *full* per-run event history for a finished
   run (needed to reconstruct all past attempts), or only a recent/paginated window (`RUN_HISTORY_PAGE_ITEMS
   = 100`, `packages/contract/src/events.ts:29`) that could truncate older attempts on a long run?
2. **Where does per-retry detail render?** Options include: expanding the `×N` badge into a
   tooltip/popover listing each attempt's duration; a drill-down under `WorkflowSteps`'s
   `CollapsibleContent`; or a fully separate detail row per attempt in `StepRail`. Not decided.
3. **What does "total time" mean while a step is mid-retry (attempt N still running)?** Presumably
   sum of finished attempts' durations plus a live tick for the in-progress one — needs an
   explicit formula and a test, following `stepElapsed`'s `live: boolean` pattern.
4. **Does the collapsed `WorkflowSteps` summary need retry info at all**, or is per-retry detail
   an expanded-view-only concern (current step's total in the summary, like today, with
   per-attempt breakdown only in the full `StepRail`)? Precedent (`step-rail.tsx:392-393` comment)
   favors keeping the summary terse.
5. **Interaction with the broker-retry mechanism** (`run.ts:5746-5749`, unrelated "retry" concept
   above) — does a broker-retried attempt (which never got real agent work done) count as one of
   the "retries" whose time should show, or should it be filtered out as noise? Not addressed by
   any existing spec.

## Duplicate / in-flight work check

`cezar todo list` → **no todos filed**. `git log --oneline -15` on this branch shows no commit
touching step iterations, timing, or the tree/step-rail UI. No other spec or brief in
`.ai/specs/` or `.ai/specs/briefs/` covers this. This is new, non-duplicated work.
