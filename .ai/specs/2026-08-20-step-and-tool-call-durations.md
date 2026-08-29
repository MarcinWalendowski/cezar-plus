# Every step and every tool call says how long it took

**Status:** **DONE** — implemented (Phases 1-3), shipped, deployed to production, and verified
against real production data (§Verification 8). Marked done by the owner on 2026-08-20 ("If all
implemented mark as done"); all three clauses of the original ask are live on `origin/main`.
**One residual, deliberately not rounded up:** §7's *visual* pass (a-e below) has still never been
executed — this box has no browser — so it is carried as open todo
`1f74df2b-9428-4e84-a983-870b00cbdcf2`, not silently closed. What changed to make DONE honest is
§Verification 8: the failure mode §7 exists to catch (the clocks render blank because the data
lacks timestamps) is now disproved against this run's own production transcript. Written 2026-08-20 by
step 1 of run `6af4b894` (`spec-to-deploy`); implemented by step 2, gated by step 3, shipped by
step 4 as commit `69b4a3de` ("feat: every step and every tool call says how long it took", 19
files, +1452/-124, this spec and the replay fixture included), **pushed to `origin/main`**
(`a6c0ba3e..69b4a3de`, fast-forward, no PR — cezar self-dev ships direct to main under `AGENTS.md`
§"Shipping cezar itself"). Documented by step 5 (this record, plus the `AGENTS.md` scrub
correction §Verification called for). **Deployed by step 6** — see §Deployment. Phase 4 stays
deferred by design. Verification 1-6 and 8 executed and green (see §Verification); **§7's visual
pass remains NOT EXECUTED** — a headless step cannot open `/tasks/:id`.
**Date:** 2026-08-20

## TLDR

The cockpit can already tell you *that* a workflow step is running and *that* a tool call
happened. It cannot tell you how long either took. `StepRail` renders a glyph, a name and
`agent · step 1 of 6` (`packages/web/src/routes/task-thread/step-rail.tsx:78-101`) and no
time at all; `ToolCard` renders a verb, a target and an exit code
(`thread-items.tsx:615-655`) and no time at all. Add a clock to both: **ticking while the
thing is in flight, frozen at its final value once it ends.**

Both numbers already exist on shapes the browser holds. `StepState.startedAt` /
`finishedAt` are persisted contract fields (`packages/contract/src/runs.ts:82-83`), written
by the runner at every step start (`packages/cezar/src/workflows/run.ts:2699`, `:3360`) and
every step end (`run.ts:4555-4562`, `:3002-3056`) — confirmed live in this very run's
record (below). Tool times are derivable from the `ts` that `appendEvent` stamps on every
persisted frame (`packages/cezar/src/runs/store.ts:919-930`). So this is a **web-only
change**: no contract field, no migration, no runner change — which per `AGENTS.md`
§"Always self-deploy" is the class that swaps into `/opt/cezar` without a restart at all.

## Problem

Owner ask, verbatim: *"each step of workflow should show time of processing, when ended it
should show how long it took. Each tool call should show how long it took as well."*

Three gaps, all in `/tasks/:id`:

1. **A step has no clock, running or finished.** `StepRail`'s row
   (`step-rail.tsx:78-101`) carries icon, name, an optional `stopped — no output` label, an
   `×N` iterations badge and `{kind} · step N of M`. The collapsed `WorkflowSteps` summary
   (`step-rail.tsx:196-214`) carries dots, the current step's name, `step N of M` and the
   progress bar. Neither reads `step.startedAt` or `step.finishedAt`, which are right there
   on the same object. A six-step `spec-to-deploy` run is the exact case where "which step
   ate the hour" is the only question worth asking, and the rail cannot answer it.
2. **A tool card has no duration.** `UiToolItem` (`packages/api-client/src/protocol/ui-events.ts:110-133`)
   carries `name`, `toolKind`, `title`, `status`, `input`, `output`, `error`, `diffs`,
   `locations`, `exitCode`, `parentItemId` — and **no timestamps at all**. The card
   therefore cannot say whether `Ran npm test` took 90ms or 9 minutes; the reader has to
   guess from output length.
3. **The only duration in the whole view disappears the moment it matters most.**
   `.ai/specs/2026-08-20-live-run-status-line-and-timer.md` (commit `d353944c`) added
   `LiveDuration` beside the status pill, but gated on `run.status === 'running'`
   (`run-header.tsx:150-160`). When the run ends, the elapsed time is *removed from the
   screen* — the number is discarded at the exact instant it becomes the answer to "how
   long did that take".

### What the record says (read before designing this)

Read first, in the order `CLAUDE.md` prescribes — KB, then specs, then git log.

- **`.ai/specs/2026-08-20-live-run-status-line-and-timer.md`** (KB `specs-942894486a51`,
  commit `d353944c`) — the direct parent. It established: `formatDuration` as the one
  stopwatch formatter (`lib/format.ts:46`); `LiveDuration` as a **leaf** component so a 1s
  tick re-renders one `<time>` and not a 300-row transcript (its risk R2, pinned by the
  `no-tick-in-thread-containers` guardian rule at `design-guardian.test.ts:107-113`); and
  `itemStartedAt(events, itemId)` (`live-status.ts:96-107`), which already derives one
  item's start instant from `item.started`'s `ts` — this spec generalises exactly that
  derivation to every item, once, in the reducer.
- **`.ai/specs/2026-08-20-agent-step-inactivity-timeout.md`** (KB `specs-7d224461e2ba`,
  commit `e3f542df`) — *a long step is not a hung step*; silence, not duration, is the
  liveness bound. Binding on the copy here: a duration is a **measurement**, never a
  verdict. No "slow" badge, no red past a threshold.
- **`.ai/specs/2026-08-20-agent-step-stopped-is-not-failed.md`** (KB `specs-19ca3a756eac`,
  commit `62a41d30`) — `stopReason` splits a cezar-stopped step from a failed one, and the
  rail renders that. A stopped step still has real `startedAt`/`finishedAt`, so its clock
  shows normally; the pause glyph carries the meaning.
- **`.ai/specs/2026-08-19-spec-to-deploy-default-workflow.md`** (KB `specs-e01401118cd2`) —
  why six-step chains are now the default for *every* run, i.e. why per-step timing stopped
  being a niche ask.
- **`.ai/specs/2026-08-19-context-usage-in-tasks-table.md`** — the precedent that a
  per-step number belongs on `StepState` and is rendered point-in-time.
- **Deferred work this must not collide with:** the timer spec's **Phase 4** (the same
  answer on the tasks list) is explicitly deferred and needs a server-side field. This spec
  stays out of `/` and `/tasks` for the same reason. `cezar todo list` → **`no todos
  filed`**, so nothing is in flight (note: the timer spec records a todo `e755a560`; it is
  not visible in this workspace's todo store — reported as found, not invented).
- **Not found:** no KB entry and no spec covers per-tool-call or per-step durations.
  `cez kb search "workflow step duration"`, `"tool call duration elapsed"` and
  `"step timing cockpit"` return only the adjacent specs above. This is new ground.

### Evidence (measured, not assumed)

**Steps.** This run's own record, `/var/lib/cezar/workspace/.ai/cezar/runs.json`:

```
run 6af4b894 running  startedAt 2026-08-20T14:24:44.121Z  finishedAt None
  step spec        running  start 2026-08-20T14:24:46.939Z  finish None  iters 1
  step implement   pending  start None                      finish None  iters 0
  … 4 more pending
```

The data is on disk and on the wire today. Nothing renders it.

**Tools.** Replaying this run's transcript
(`/var/lib/cezar/workspace/.ai/cezar/runs/6af4b894-….ndjson`, 249 events) and pairing
`item.started` → `item.completed` by `(stepId, item.id)` yields **44 tool pairs**:

| metric | value |
| --- | --- |
| median | **0.07 s** |
| under 1 s | **42 of 44** |
| max | **10.61 s** (`cez kb search …`) |
| `item.started` frames carrying >1 tool | **0** (each frame is stamped at append time) |

This is the number that decides the format: a `m:ss` clock would print `0:00` on 95% of
cards and say nothing. Sub-second precision is required, so tool durations need their own
formatter (below) rather than reusing `formatDuration`.

## Solution

**1 — the step rail gets a clock, per row and in the collapsed summary.**

```
✓ Read the record + write the spec   agent · step 1 of 6   4:12
⟳ Implement                          agent · step 2 of 6   18:07     ← ticking
○ Run tests                          check · step 3 of 6
```

- **Active step** (`railVisual === 'active'`, i.e. `running` / `waiting` / `review`) → a
  ticking `LiveDuration` from `step.startedAt`.
- **Terminal step** with both timestamps → a static `formatDuration(finishedAt − startedAt)`.
- **No `startedAt`** (pending, skipped, or an old record) → **render nothing**. An empty
  slot is honest; `NaN:0-3` is not — the rule `shortAge` (`format.ts:10-20`) and
  `LiveDuration` already follow.
- The collapsed summary line shows the *current* step's clock, so the common case needs no
  expand.

**2 — every tool card gets a duration chip**, right-aligned beside the exit-code pill:

```
▸ Ran  npm test                                        1.4s   ⟨0⟩
▸ Read run-header.tsx                                  70ms
▸ Ran  npm run build                          ⟳       0:48          ← ticking
```

Derived client-side in the reducer from the `ts` of the frames that opened and closed the
item. Same treatment for reasoning and assistant items? **No** — cards only. The status
line already carries a per-item clock for the live item (`thread-items.tsx:386`), and a
duration on a prose bubble answers no question anyone asked.

**3 — a finished run keeps its total.** The pill slot that today empties on completion
shows `took 42:19` for any run with both `startedAt` and `finishedAt`. Same slot, same
formatter, so the running and finished readings are visibly the same quantity.

**4 — durations are measurements, never verdicts.** No threshold colouring, no "slow", no
red. Per the inactivity spec's R1: a long call is not a sick call.

### Why client-side, and what that buys

Every input is already in the browser:

| Needed | Already there |
| --- | --- |
| step start / end | `StepState.startedAt` / `finishedAt` (`contract/src/runs.ts:82-83`), served whole inside `RunRecord.steps` and read by `RunHeader` (`run-header.tsx:257`) |
| tool start / end | `RunEvent.ts` on the persisted `item.started` / `item.completed` frames (`contract/src/events.ts:22-27`; stamped in `store.ts:926`) |
| run total | `run.startedAt` / `run.finishedAt` (`contract/src/runs.ts:265-266`) |

A `durationMs` on `step-end`, or timestamps added to `UiToolItem`, would be a
contract-widening duplicate of data the client already holds — **and** it would move this
out of the web-only deploy class into the restart class, which for a change that renders
one number per row is a bad trade. It would also leave every already-recorded run without
durations, whereas deriving from `ts` makes **all existing NDJSON transcripts show
durations retroactively** (proven above on this run's own file).

## Architecture

```
RunRecord.steps ─► stepElapsed(step, now)  (pure, tested)  ─► StepRail row / summary
                                                              └─► <LiveDuration/> leaf (ticks)

events ─► reduceThread ─► entry.timing {startedAt, endedAt?} ─► ToolCard chip
                                                                └─► <LiveDuration/> leaf (ticks)
```

| File | Change |
| --- | --- |
| `packages/web/src/lib/format.ts` | **new** `formatToolDuration(ms)` beside `formatDuration` |
| `packages/web/src/components/live-duration.tsx` | additive optional `format?: (ms) => string` prop (default `formatDuration`), so a ticking tool clock reads in the same units as its finished neighbours |
| `packages/web/src/routes/task-thread/step-timing.ts` | **new** pure `stepElapsed(step, now)` → `{ ms, live }` \| `undefined` |
| `packages/web/src/routes/task-thread/step-rail.tsx` | render the clock in the row (`:98`) and in the collapsed summary (`:203`) |
| `packages/web/src/routes/task-thread/thread-state.ts` | stamp `timing` on v2 items in `upsertV2`; on v1 `tool-call`/`tool-result`; widen `ThreadEntry` |
| `packages/web/src/routes/task-thread/thread-groups.ts` | widen `ToolCardBlock.item` / `ContextGroupBlock.tools` / `isTool` to the timed tool type |
| `packages/web/src/routes/task-thread/thread-items.tsx` | duration chip in `ToolCard`'s trigger (`:637-655`) |
| `packages/web/src/routes/task-thread/run-header.tsx` | `took h:mm:ss` in the pill slot when the run is terminal |
| `packages/web/src/design-guardian.test.ts` | extend `no-tick-in-thread-containers`'s `applies` to `step-rail.tsx` and `thread-items.tsx` |

Five decisions worth writing down:

- **The tick stays in leaves, and the guardian is widened to say so.** `useNow(1000)`
  (`lib/use-now.ts`) re-renders its owner every second. Called in `StepRail`'s body it
  would re-render six rows a second; called in `ToolCard`'s body it would re-render that
  card's entire (possibly enormous) output block. Both new clocks are `<LiveDuration/>`
  leaves. The existing guardian rule (`design-guardian.test.ts:107`) covers only
  `task-thread.tsx` and `run-header.tsx`; this spec adds the two files it is now possible
  to get wrong. **This rule is the reason the tool chip is a component and not three inline
  lines.**
- **Timing is attached to the item, not carried in a side map.** A
  `Map<key, ItemTiming>` on `ThreadState` would have to be threaded through
  `SessionTranscript` → `ThreadBlockRenderer` → `GroupedEntries` → `ToolCard` → nested
  renderer (and through the subagent sheet, which reuses the same renderers) — five prop
  hops for one number. Instead the reducer attaches an optional web-local `timing` field to
  the **clone** it already makes (`thread-state.ts:346`, "deltas append in place, and the
  event object off the wire must stay untouched"). The field is never sent, never
  persisted, and is **not** added to `UiToolItem`: the api-client mirror is pinned exactly
  against the server's declaration by `api-types.test.ts`, and widening it would fail
  `npm run typecheck` — correctly. The web owns `TimedToolItem = UiToolItem & { timing?:
  ItemTiming }`.
- **`upsertV2` replaces the entry object on every update, so timing must be carried
  forward explicitly** (`existing.entry.entry = item` at `thread-state.ts:367`). The
  implementation reads the previous clone's `timing` and copies it onto the new one before
  the swap; forgetting this yields a chip that appears and vanishes as frames arrive. This
  is the single most likely implementation bug in this spec.
- **A start is only ever taken from a frame that opens an item.** Progressive history
  paging serves 100 items per page (`RUN_HISTORY_PAGE_ITEMS`, `contract/src/events.ts:29`),
  so a thread can legitimately hold an `item.completed` whose `item.started` sits on a page
  the browser has not fetched. Stamping `startedAt` from whatever frame is seen first would
  print `0ms` for a nine-minute call. Rule: `startedAt` comes from `item.started` (or an
  `item.updated` for a still-open item) only; an item first seen already-terminal gets **no
  timing and no chip**.
- **What the number means, stated in the tooltip.** It is wall-clock from the frame that
  announced the tool to the frame carrying its result — the same interval the status line's
  item clock already shows. For tools the agent issues in parallel, those intervals overlap
  by design; the chip reports elapsed time, not exclusive time. `title` says so.

## Data models

**No contract change. No persisted field. No migration.** One web-local type:

```ts
// packages/web/src/routes/task-thread/thread-state.ts
/** Wall-clock bounds of one thread item, in epoch ms, derived from RunEvent.ts.
 *  `endedAt` absent = still in flight. Web-local: never sent, never persisted. */
export interface ItemTiming { startedAt: number; endedAt?: number }
export type TimedToolItem = UiToolItem & { timing?: ItemTiming }
export type TimedUiItem = UiItem & { timing?: ItemTiming }
export type ThreadEntry = TimedUiItem | ThreadNote | ThreadImage | ThreadAsk | ThreadProviderAuthRequired
```

Reducer rules (all inside `reduceThread`, all total — a malformed frame costs one frame,
never a throw, per the module's existing contract):

| Frame | Effect |
| --- | --- |
| `item.started` (first sighting of `stepId:itemId`) | `timing = { startedAt: Date.parse(event.ts) }`; unparseable `ts` → no timing |
| `item.updated` (item already known) | carry timing forward unchanged |
| `item.updated` (item **not** known) | open it with `startedAt` — a mid-stream item, honest |
| `item.completed`, or a tool reaching `completed`/`failed`/`declined` | `endedAt = Date.parse(event.ts)` if `startedAt` exists; else leave undefined |
| `item.completed` for an item never opened | **no timing** (paging rule above) |
| `item.delta` | no effect — deltas are live-only and never replay (`store.ts:1072`) |
| v1 `tool-call` (`thread-state.ts:478`) | `startedAt` from `event.ts` |
| v1 `tool-result` (`thread-state.ts:506`) | `endedAt` from `event.ts` |
| `check-output` (`thread-state.ts:556`) | **no timing** — one frame, no interval exists. The step rail's clock is the answer for a check step |

Selector and formatter contracts:

```ts
// packages/web/src/routes/task-thread/step-timing.ts
/** `live: true` = still counting (an ACTIVE step, per railVisual). undefined = render nothing. */
export function stepElapsed(step: StepState, now: number): { ms: number; live: boolean } | undefined

// packages/web/src/lib/format.ts
/** Tool-scale durations: `70ms` / `940ms` / `1.4s` / `59.8s` / `1:04` / `12:03`.
 *  Sub-second precision because 42 of 44 measured tool calls finish under 1s. */
export function formatToolDuration(ms: number): string
```

`formatToolDuration` boundaries, pinned as a table so the tests write themselves:
`0 → 0ms`; `70 → 70ms`; `999 → 999ms`; `1_000 → 1.0s`; `1_449 → 1.4s`; `59_949 → 59.9s`;
`60_000 → 1:00`; `64_000 → 1:04`; `3_600_000 → 1:00:00`; negative → `0ms` (clock skew
clamps, like `formatDuration` and `shortAge`); non-finite → `0ms`.

## API contracts

None. No route, request or response shape changes. `GET /runs/:id` already returns
`steps[]` with both timestamps; `GET /runs/:id/events` and the history pages already carry
`ts` on every frame.

## Phases

Each phase is independently shippable, independently useful, and ends green.

**Phase 1 — step durations (the literal first half of the ask).**
`step-timing.ts` + `stepElapsed` with unit tests; render in `StepRail`'s row and in the
`WorkflowSteps` collapsed summary; widen the guardian rule to `step-rail.tsx`. Ships "each
step shows time of processing, and how long it took when it ended" on its own, touching no
reducer.

**Phase 2 — tool-call durations (the second half).**
`formatToolDuration` + tests; `ItemTiming` and the reducer rules + tests; widen
`ThreadEntry` / `thread-groups` types; the `data-slot="tool-duration"` chip in `ToolCard`;
widen the guardian rule to `thread-items.tsx`; the additive `format` prop on
`LiveDuration`. Retroactive on every existing transcript.

**Phase 3 — the run keeps its total when it ends.**
`took h:mm:ss` in the header pill slot for terminal runs with both timestamps. Small, and
it closes the "the number vanishes exactly when you want it" gap named in Problem §3.

**Phase 4 — DEFERRED, named so the next session does not re-derive it.**
(a) The CLI's `── step:` line (`packages/cezar/src/index.ts:756`) printing a duration at
`step-end`; deferred because it is a `packages/cezar` change, which moves the whole commit
out of the web-only deploy class for a surface the owner does not watch. (b) A duration
column on `/tasks`; deferred for the same reason the timer spec deferred its Phase 4 — that
view holds no event stream and no `steps[]` (`runIndexEntrySchema` omits them, see
`contract/src/runs.ts:447`), so it needs a server-side field first.

## Analytics

The cockpit web app ships **no analytics sink** — `grep -rn "analytics|posthog|track("
packages/web/src` returns nothing (re-checked for this spec). There is no event to name,
and standing up a pipeline for a display change is scope the owner did not ask for. The
observable signal is the run event stream itself, already recorded per run in
`.ai/cezar/runs/<id>.ndjson` — which is exactly what the Evidence table above was computed
from, and what Verification §5 replays.

## Risks

| # | Risk | Mitigation |
| --- | --- | --- |
| R1 | A duration reads as a verdict ("this step is slow / stuck"). | Measurement only: no thresholds, no colour, no "slow". Directly inherits `2026-08-20-agent-step-inactivity-timeout.md` R1 — silence is the liveness signal, duration is not. |
| R2 | A 1s tick re-renders six rail rows, or a tool card's whole output block. | Both clocks are `<LiveDuration/>` leaves; the `no-tick-in-thread-containers` guardian rule is extended to `step-rail.tsx` and `thread-items.tsx`, so a future inline `useNow` fails the suite. |
| R3 | `iterations > 1`: `startedAt` is **overwritten** on each attempt (`run.ts:3360`), so the rail shows the *current attempt*, not the cumulative cost. | **CORRECTED 2026-08-29**: `.ai/specs/2026-08-29-step-retry-timing.md` closes this deferral — `RunStore.updateStep` now accumulates `StepState.attempts[]`, and the rail's clock sums every recorded attempt instead of showing only the latest. Original mitigation, kept for the record: *"Accepted and stated: the row already carries the `×N` badge (`step-rail.tsx:93-97`); the clock's `title` says "this attempt". Cumulative-across-attempts would need a new persisted field — out of the web-only class, and not asked for."* |
| R4 | A step parked `waiting` (an unanswered `CEZ:ASK`) or `review` keeps ticking, so human think-time is billed to the step. | Deliberate: `railVisual` already calls those states **active**, and a clock that disagreed with the glyph would be worse. The `title` reads "elapsed since the step started". |
| R5 | A `finishedAt` that survives from a previous attempt while `status` is `running` would print a negative or absurd duration. | `stepElapsed` prefers `live` whenever the step is active and ignores `finishedAt` there; `formatDuration`/`formatToolDuration` clamp negatives to zero regardless. |
| R6 | Old records / old NDJSON with no `startedAt`, or an unparseable `ts`. | Render nothing. Every path returns `undefined` rather than a number, exactly as `shortAge` returns `''`. |
| R7 | Progressive paging splits an item's `started` and `completed` across pages, producing a `0ms` chip on a long call. | Start is only ever taken from an opening frame; an item first seen terminal gets no chip. Pinned by a reducer test that feeds `item.completed` alone. |
| R8 | Parallel tool calls overlap, so the chips sum to more than wall-clock. | The chip is elapsed, not exclusive, and the `title` says so. Measured on this run: two parallel `Bash` calls reported 10.61s and 9.98s over a ~10.6s window — correct, and correctly *not* additive. |
| R9 | A `check` step's `check-output` card gets no chip while an agent's tool cards do — an inconsistency a reader could mistake for a bug. | Named, not hidden: a `check-output` frame is a single event with no interval. The check **step's** rail clock is the honest answer, and it is right above. |
| R10 | The reducer's clone-on-update drops `timing` (see Architecture). | Explicit carry-forward + a reducer test that sends `started → updated → updated → completed` and asserts the chip survives all four frames. |
| R11 | Scope creep into `packages/cezar`, which changes the deploy class from "swap into `/opt/cezar`" to "restart the service". | Verification §6 is a hard gate: `git diff --name-only` must be `packages/web/**` + `.ai/specs/**` only. Note this is a scope risk, not a deploy risk: a backend change still self-deploys in-session per `AGENTS.md` §"Always self-deploy". |


## Deployment

Deployed to production (`prod-host`) on 2026-08-20 at 15:35 UTC by step 6 of run `6af4b894`,
using this repo's own documented web-only deploy path (`AGENTS.md:12`) rather than
`cezar server-deploy`.

**Why not `cezar server-deploy`.** That command is a hard `systemctl daemon-reload && systemctl
restart cezar.service`, which needs sudo the service user does not have. `AGENTS.md:12` describes the
class this change qualifies for: **a web-only change swaps into `/opt/cezar` without a restart at
all**, so it needs neither sudo nor a cutover.
`git diff a6c0ba3e..69b4a3de --name-only` is 18 files under `packages/web` plus this spec, and
nothing under `packages/cezar`, so the carve-out applies as written.

**What was run.**

```
NODE_ENV=development npm run build:web        # -> packages/cezar/web/dist, exit 0, built in 1.25s
cp -a <worktree>/packages/cezar/web/dist  /opt/cezar/packages/cezar/web/dist.new
diff -rq <worktree>/packages/cezar/web/dist  /opt/cezar/packages/cezar/web/dist.new   # identical
mv /opt/cezar/packages/cezar/web/dist      /opt/cezar/packages/cezar/web/dist.bak.20260820-153518
mv /opt/cezar/packages/cezar/web/dist.new  /opt/cezar/packages/cezar/web/dist
```

No `sudo`, no restart, no `kill`. Rollback is reversing the last two moves.

**Proof no restart happened:** `MainPID=3249167` and `ActiveEnterTimestamp=2026-08-20 15:21:17 UTC`
were identical before and after the swap. The deploying session and every other in-flight run
survived untouched.

**Readiness gate, executed after the swap over real HTTP against the live server** (AGENTS.md:11 —
"the deploy step must gate on a real readiness probe and never ship a broken build"):

| # | Probe | Result |
| --- | --- | --- |
| 1 | `GET /` | 200, 6492 B, references new entry chunk `index-Dw4mZmPj.js` |
| 2 | `GET /assets/task-thread-BvvI_Fzc.js` | 200, 102918 B, contains `tool-duration` |
| 3 | `GET /assets/run-header-BmtNFwZt.js` | 200, 33653 B, contains `took ` |
| 4 | Negative control: pre-swap tree | chunk was `task-thread-BhRcCytV.js`, **no** `tool-duration` |

The two markers sit in *different* chunks because Vite splits by route, so the paths are recorded
rather than a count — a bare count cannot distinguish "not deployed" from "looked in the wrong
chunk". Probe 4 is what makes the hash change evidence of new code rather than a re-copy.

**Deployed is not rendered.** Assets are served `cache-control: immutable` while `index.html`
carries no `Cache-Control` at all, so a cockpit tab that is already open keeps running the OLD
chunk graph until someone reloads it. The honest status for a human is "deployed — reload the tab".
An HTTP 200 plus a bundle grep proves DELIVERY, not BEHAVIOUR, which is exactly why §7 below is
still owed.

**Still owed: Verification §7** — the real runtime pass on a live `/tasks/:id`, watching a step's
clock tick and freeze at its final value. A headless step cannot do it and this one did not.
Tracked as todo `1f74df2b` on project `cezar`. This deploy does not discharge it.

The deploy is recorded on the box at `/opt/cezar/.deployed-commit` (prior record preserved as
`.deployed-commit.bak.20260820-153558`).

## Verification

Concrete and executable, from the repo root. **Scrub the environment first** — per
`AGENTS.md` §"Two environment traps that make the gates LIE", `NODE_ENV=production` is set
in cezar sessions and makes `npm ci` install zero devDependencies, which surfaces as
`TypeError: React.act is not a function` and invites a false "component tests can't run
here" conclusion:

```bash
env -u NODE_ENV -u CEZ_REMOTE -u CEZ_OIDC_ISSUER -u CEZ_OIDC_CLIENT_ID \
    -u CEZ_PROJECTS_DIR -u CEZ_KB -u CEZ_KB_ROOTS -u CEZ_KB_WRITE_FILE -u CEZ_TODOS_FILE \
    npm ci
```

1. **Typecheck** — `npm run typecheck`. Must be clean. It is also the check that the
   `UiToolItem` mirror was *not* widened: `api-types.test.ts` pins it against the server
   declaration, so a `timing` field added there fails here.
2. **Pure unit tests** (vitest through npm — never `npx vitest`, `AGENTS.md` §Validation):
   ```
   npm test -- --project web packages/web/src/lib/format.test.ts \
                             packages/web/src/routes/task-thread/step-timing.test.ts \
                             packages/web/src/routes/task-thread/thread-state.test.ts
   ```
   Cases the new suites must contain:
   - `formatToolDuration`: every boundary in the Data-models table, including `999 → 999ms`,
     `1_000 → 1.0s`, `60_000 → 1:00`, negative → `0ms`, `NaN`/`Infinity` → `0ms`.
   - `stepElapsed`: `pending` (no `startedAt`) → `undefined`; `running` with `startedAt` →
     `{ live: true }` counting from `now`; `done` with both → `{ ms: finish − start, live:
     false }`; `failed` **with** `stopReason` → still a duration (a stopped step ran);
     `waiting` and `review` → `live: true`; `running` with a stale `finishedAt` → `live:
     true` and the stale value ignored (R5); unparseable ISO → `undefined`.
   - reducer timing: `item.started`→`item.completed` yields `{startedAt, endedAt}` from the
     two frames' `ts`; `started → updated → updated → completed` **keeps** the original
     `startedAt` (R10); a lone `item.completed` yields **no** timing (R7); v1
     `tool-call`/`tool-result` yield a timing; `check-output` yields none; a frame with a
     junk `ts` yields no timing and does not throw.
3. **Component tests** — the rail and the card:
   ```
   npm test -- --project web packages/web/src/routes/task-thread \
                             packages/web/src/design-guardian.test.ts
   ```
   New assertions: a running step row renders `[data-slot="live-duration"]`; a done step row
   renders the static total; a pending row renders neither; a completed tool card renders
   `[data-slot="tool-duration"]` with the formatted value; a card whose item has no `timing`
   renders no chip; the guardian rule now covers `step-rail.tsx` and `thread-items.tsx`.
   Existing suites in this directory must stay green (27 files / 699 tests were green for
   it at `d353944c`).
4. **Full gate** — `npm test && npm run test:unit`, per `CLAUDE.md` ("gates green is
   necessary, not sufficient") and the standing "always run full gates" instruction.
5. **Replay proof on real recorded data** — the retroactivity claim, checkable without a
   browser: replay an existing transcript
   (`/var/lib/cezar/workspace/.ai/cezar/runs/6af4b894-….ndjson`, 249 events) through
   `reduceThread` in a test or a scratch script and assert ≥40 tool entries carry a
   `timing`, with a median under 1s — the numbers this spec's Evidence table measured
   independently of the reducer. A mismatch means the reducer rules, not the data, are wrong.
6. **Deploy-class check** — `git diff --name-only` must list `packages/web/**` and
   `.ai/specs/**` **only**. Anything under `packages/cezar/**` or `packages/contract/**`
   means Phase 4 leaked in and the restart-class caveat applies (R11).
7. **Real runtime pass — required before this is called done, not "gates green"**
   (`CLAUDE.md` §definition of done). On a genuinely running multi-step task, open
   `/tasks/:id` and observe on screen:
   a. the collapsed workflow summary showing the current step's clock, ticking each second;
   b. expanding the rail: finished steps frozen at their totals, the active one ticking,
      pending ones blank;
   c. a long `Bash` card ticking while it runs and freezing at its final value on
      completion, next to its exit-code pill;
   d. a fast tool showing sub-second precision (`70ms`), not `0:00`;
   e. the run finishing and the header keeping `took h:mm:ss` instead of blanking.
   Capture a screenshot of (b) and (c) into `.ai/specs/assets/` and reference it here.

8. **Production-data pass — EXECUTED 2026-08-20, green.** §7 needs a browser, but its
   *inputs* can be checked headlessly against real data, and that is where the plausible
   failure lives: if the clocks render blank it is because `startedAt`/`finishedAt`/`ts` are
   missing, not because the JSX is wrong (the JSX is covered by 776 web unit tests). Parsed
   this run's own production transcript
   (`/var/lib/cezar/workspace/.ai/cezar/runs/6af4b894-….ndjson`, 2156 frames) directly:
   - **7/7 steps** yield a duration from paired `step-start`/`step-end` frames — 0:08:16,
     0:32:27, 0:15:35, 0:05:40, 0:06:07, 0:04:52, 0:10:46. So the rail and the collapsed
     summary have a number to show for every step, and the frozen-total case is real.
   - **281 of 282** `tool-call`→`tool-result` pairs resolve to a duration (the one unpaired
     call is the in-flight tool doing the measuring). So the `tool-duration` chip has data.
   - Distribution: **median 0.099s, p90 6.76s, max 242.86s; 232/281 (83%) under one second.**
     This independently reconfirms the Evidence table's central design call from a *different*
     run and a much larger sample — a formatter flooring to `0s` would still be wrong on 83%
     of cards. Slowest five are all `Bash` (242.9s, 229.9s, 175.5s, 163.9s, 162.4s), which is
     the `h:mm:ss` branch exercised by real data.

**Owner decision 2026-08-20:** with 1-6 and 8 green and implementation complete, this is marked
**done**. §7's on-screen confirmation (a-e) is still owed and is tracked as todo
`1f74df2b-9428-4e84-a983-870b00cbdcf2`. Delivery and data are proven; the pixels are not. Do not
cite this spec as evidence that anyone has *watched* a clock tick.

---

## Implementation notes (step 2, 2026-08-20)

What the implementation did that the spec did not literally say, and why. Three deviations,
all forced by something the spec could not see from the outside.

**1 — `stepElapsed` does not import `railVisual`; the two share status SETS instead.** The spec
described the selector as "keyed off `railVisual`", which would make `step-timing.ts` import
`step-rail.tsx` while `step-rail.tsx` imports `step-timing.ts` — a module cycle. Inverted
instead: `ACTIVE_STEP_STATUSES` and `TERMINAL_STEP_STATUSES` live in `step-timing.ts`, the rail
imports them, and `railProgress` now reads them from there rather than keeping the inline copy
it used to. The invariant that made "keyed off `railVisual`" the right idea is pinned directly
by a test that walks every `StepStatus` and asserts
`ACTIVE_STEP_STATUSES.has(s) === (railVisual(s) === 'active')`.

**2 — `RunStatusLine` moved out of `thread-items.tsx` into its own `run-status-line.tsx`.**
Verification §3 asks for the guardian's `no-tick-in-thread-containers` rule to cover
`thread-items.tsx`, and the rule is a line-level regex over a whole file — but that file already
held a legitimate `useNow(1000)`, in the status line. Widening the rule as written would have
failed on existing, correct code. The status line's own doc comment already claimed it was a
separate component *because* it owns the tick; it now actually is one, so the rule covers
`thread-items.tsx` honestly and a future `useNow` in `ToolCard` fails the suite. Negative-control
checked: dropping a `useNow` into `step-rail.tsx` does fail the rule, at the right line.

**3 — `LiveDuration` also gained an additive `title?` prop.** The spec's file table lists only
`format?`, but risks R3, R4 and R8 each require the clock to *say* what interval it measures,
and the live clocks are `<LiveDuration/>` leaves. A wrapper `<span title>` would have added a DOM
node per row; a prop does not. Both new props are optional and every existing call site is
unchanged.

Two smaller judgment calls:

- **Timing is stamped on every item kind, not only tools** — the spec's reducer rule table keys
  on `item.started`/`item.updated`/`item.completed` without mentioning kind, and defines
  `TimedUiItem` for all items, so message and reasoning items carry a `timing` too. Only tool
  cards render one. Blast radius was two pre-existing exact-equality assertions in
  `thread-state.test.ts`, updated in place to assert the timing rather than ignore it.
- **`endedAt` freezes on the FIRST terminal frame** (an `item.updated` carrying
  `completed`/`failed`/`declined`, or `item.completed`, whichever lands first). The spec named
  both triggers but not their interaction; a later repaint of a finished item must not push the
  number forward, so it does not.

### Verification, as executed

Environment scrubbed first — and the scrub in `AGENTS.md` §"Two environment traps" turned out to
be **incomplete**: `CEZ_ACCOUNT_USAGE`, `CEZ_ACCOUNT_USAGE_HOSTED`, `CEZ_BROWSE_ROOT`,
`CEZ_PUBLIC_URL`, `CEZ_PORT_STRICT` and `CEZ_ENV_PASSTHROUGH` are also live in a run's
environment and also leak into the server suites (`accountUsage: true` where `health-forge`
expects `false`, and 10 further failures across `health-forge`, `projects-api`,
`agent-profile-wiring` and `add-project-dialog`). Unsetting **every** `CEZ_*` except
`CEZ_HANDOFF_FILE` and `CEZ_TASK_ID` clears all of them. That is worth folding back into
`AGENTS.md`. **Done by step 5** — `AGENTS.md` §"Three environment traps that make the gates LIE"
now carries a prefix-wide scrub (verified to leave exactly those two variables standing) in place
of the hand-written list, with the old list marked as the incomplete thing it was.

| # | Check | Result |
| --- | --- | --- |
| 1 | `npm run typecheck` (all four projects) | clean |
| 2 | `format.test.ts`, `step-timing.test.ts`, `thread-state.test.ts` | 177 passed |
| 3 | `packages/web/src/routes/task-thread` + `design-guardian.test.ts` | 27 files, 716 passed (699 at `d353944c`) |
| 4 | `npm test` (whole repo) / `npm run test:unit` | 9093 passed, 1 skipped, **2 failed**; 44 passed |
| 5 | Replay of this run's own transcript through `reduceThread` | 106 tool entries, all timed; 105 closed, median 76ms, 98/105 under 1s, longest 10.61s — matches the Evidence table, measured independently |
| 6 | `git diff --name-only` | `packages/web/**` + `.ai/specs/**` only — web-only deploy class holds |
| 7 | Real runtime pass on `/tasks/:id` (visual, a-e) | **NOT EXECUTED** — no browser on this host; todo `1f74df2b` |
| 8 | Production-data pass: real run's own transcript | **GREEN** — 7/7 steps timed; 281/282 tool pairs; median 0.099s, 83% sub-second |

The 2 failures in §4 are **not this change** and are named rather than rounded away:
`knowledge/catalog.test.ts` "stays under 40ms CPU per MiB" measured 55-65ms across three runs on
a box at load average 15.7, and `server/project-context.test.ts` fails only inside the full
parallel run and passes twice in isolation. Both are server files this change never touches (§6),
and both are wall-clock budgets on a loaded machine.

**Corrected 2026-08-20 by step 3 (the gate step), which re-ran everything under the COMPLETE
`CEZ_*` scrub.** The paragraph above stands as written except for its second failure: under the
full scrub `server/project-context.test.ts` **passes**, so "fails only inside the full parallel
run" was the env leak of §Verification's own finding, not a load-sensitive test. Read the numbers
below, not the ones above, as this change's gate result.

| # | Gate, re-run under the complete scrub | Result |
| --- | --- | --- |
| a | `npm run typecheck` | GREEN |
| b | `npm run test:unit` | 44/44 GREEN |
| c | `npm run build` + `check:pack` | GREEN |
| d | `npm run test:package` | 15/15 GREEN |
| e | `npm test` (whole repo) | 9094 passed, **1 failed** |
| f | `packages/web` suite | 175 files / 3859 tests GREEN |

The single remaining red, `knowledge/catalog.test.ts` C18, is **proven pre-existing, not
load-sensitive, and not ours**: reproduced at clean `HEAD` `a6c0ba3e` in the real checkout at
63.7 ms/MiB with none of this change present, on an idle host (`steal=0`). It is an absolute
40 ms/MiB budget calibrated on a faster machine than this EPYC-Rome box — see `AGENTS.md`
§"Three environment traps that make the gates LIE", trap 3, where it is now written down so no
future session re-derives it. Deliberately NOT widened: fitting the budget to the slowest host
that ever runs it would destroy the regression signal the case exists for. `packages/cezar` is
byte-identical to `HEAD` in this change's worktree, so the diff cannot be implicated.

Step 3 also caught, and step 5 recorded in `AGENTS.md`, a **pre-existing flake** unrelated to
this change: `add-project-dialog.test.tsx` > "registers exactly the checked rows" races on
navigate, ~1 full-suite run in 4, 3/3 green in isolation, in a file this change never touches.

### Replay fixture

`packages/web/src/routes/task-thread/__fixtures__/run-6af4b894.timing.json` is this run's own
NDJSON transcript reduced to its 246 turn/item frames. Every `seq`, `ts`, `stepId` and item id is
verbatim; inputs, outputs and diff bodies are dropped, long titles are elided, and absolute
host paths are redacted — the last one because `webhook.test.ts`'s upstream-purity scan
(correctly) rejected the word they contained appearing anywhere under `packages/web/src`.

