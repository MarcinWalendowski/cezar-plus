# A running task must say what it is doing, and for how long

**Status: IMPLEMENTED (Phases 1-3) and SHIPPED 2026-08-20** as commit `d353944c` on
`origin/main` — **QA needed**: Verification §4, the real-browser runtime pass, has NOT been
executed, so this is *not* done. Phase 4 (the same answer on the tasks list) is deferred by
design and is not in this spec's scope.
**Date:** 2026-08-20

> **Corrected 2026-08-20, after the fact, by this spec's own documentation pass.** The
> implementation session recorded that the cockpit's React component tests "cannot be executed
> in this sandbox" (`TypeError: React.act is not a function`). **That conclusion was wrong**,
> and it is marked at both sites below rather than only here, because a reader who believed it
> would skip the one gate that covers the rename this spec performs.
>
> The real cause was environmental and fixable: **`NODE_ENV=production` is set in cezar cockpit
> sessions, so `npm ci` installs ZERO devDependencies** — the worktree had no vitest, no React
> and no testing-library at all. Reinstalled with `NODE_ENV` unset, every one of those suites
> runs and passes. Re-verified first-hand during this documentation pass, at the shipped commit:
> `npm test -- --project web packages/web/src/routes/task-thread packages/web/src/lib/format.test.ts packages/web/src/design-guardian.test.ts`
> → **27 files, 699 tests, all passed**, `review-panel.test.tsx`'s
> `[data-slot="working-indicator"]` assertion among them (`✓ shows the working spinner ONLY
> while the run is running (the live heartbeat)`). The full web project is 174 files / 3782
> tests green.
>
> The durable form of this lesson now lives in `AGENTS.md` § Validation ("Two environment traps
> that make the gates lie"), which is where the next session will actually read it.

## TLDR

In the task detail view, a running run today shows one static word — `Working…`
(`thread-items.tsx:335`) — and no clock. Replace it with the CLI's grammar: a ticking
elapsed timer next to the status pill, and a live status line at the tail of the thread
that names the current activity, streams the **last line** of whatever the agent is
producing right now, and — after a silence threshold — says how long it has been quiet
instead of pretending everything is fine.

Everything it needs is already on the wire. **No server, contract or protocol change:
this is a web-only change**, which per `AGENTS.md` §"Always self-deploy" is the class
that swaps into `/opt/cezar` without a restart at all.

## Problem

Owner report: *"show timer for how long it's running already (if it's running), and show
something more than 'working' because sometimes I don't know if it's stuck or working.
Maybe let's stream last line to UI like claude code is doing in CLI?"*

Three distinct gaps, all in `/tasks/:id`:

1. **No duration anywhere.** `RunHeader` (`packages/web/src/routes/task-thread/run-header.tsx:146`)
   renders `<Pill dot={attention.tone} pulse={attention.pulse}>{attention.label}</Pill>` —
   the label is the bare word `running` from `deriveAttention` (`lib/attention.ts:132`).
   `MetaRow` (`run-header.tsx:481-627`) carries workflow, branch, PR/issue chips, diff
   stat, tokens, cost and the agent badge, and no time at all. `run.startedAt` is on the
   record (`packages/contract/src/runs.ts:260`) and is never rendered in this view. The
   only elapsed clock in the whole cockpit is the dictation overlay's
   (`components/composer/composer.tsx:668`).
2. **`Working…` is content-free.** `WorkingIndicator` (`thread-items.tsx:328-338`) is a
   spinner and a fixed string, rendered for the whole `running` window
   (`task-thread.tsx:342`). It is *true* and it is *constant* — which is precisely why it
   cannot distinguish a healthy 40-minute `implement` step from a wedged CLI. The transcript
   below it does contain the answer, but only if the user scrolls, and only if the thread
   has already rendered the tool card.
3. **Silence is unreadable.** `.ai/specs/2026-08-20-agent-step-inactivity-timeout.md`
   (commit `e3f542df`) made silence the thing that actually kills a step —
   `DEFAULT_RUN_IDLE_TIMEOUT_MS`, 30 minutes with no output, then SIGTERM → SIGKILL. The
   number that decides a run's life is currently invisible in the UI. The user is being
   asked to guess exactly the quantity the backend already measures.

### What the record says (read before designing this)

- `.ai/specs/2026-08-20-agent-step-inactivity-timeout.md` — silence, not duration, is the
  liveness bound; its risk **R1** ("a chatty-but-wedged agent never trips the bound")
  states outright that *a liveness signal cannot distinguish work from noise*. That
  constrains the wording here: this UI may report silence, it may **not** claim "stuck".
  The deployed kill message was deliberately changed from "timed out after 30m" to
  "produced no output for 30m" for the same reason — a diagnosis, not an accusation.
- `.ai/specs/2026-07-18-subagent-monitoring-status.md` (KB `specs-96d29b2df507`) — the
  `monitoring` activity exists so a run doing its own downstream work does **not** read as
  needing you. A run parked in `monitoring` is quiet **on purpose**; the stall escalation
  below must not fire there. `run.activity` (`contract/src/runs.ts:248`) and
  `MonitoringSchedule` (`run-header.tsx:628-664`) already own that surface.
- `.ai/specs/2026-08-19-context-usage-in-tasks-table.md` — the precedent for "a live number
  in the header that refreshes per round-trip", and for the rule that a subagent's frames
  are not the main session's state. Its `contextTokens` correction is the worked example of
  showing a number that is point-in-time rather than cumulative.
- `.ai/specs/2026-07-20-grouped-subagent-display.md` (KB `specs-d53ef835ba5f`) — subagent
  items are marked by `parentItemId` on `UiItem`, which is how this spec tells "the main
  agent is reading a file" from "a subagent is".
- **Not found:** no KB entry and no spec covers an elapsed timer or a live status line for
  a run. `cez kb search "elapsed timer running task UI"` and `"activity stream last line"`
  return only the adjacent specs above. `cezar todo list` → `no todos filed` — no duplicate
  work is in flight. This is new ground, extending those decisions rather than revising one.

## Solution

Three additions, in the two places the user is already looking.

**1 — `running 4:12` next to the status pill.** A ticking `h:mm:ss` since `run.startedAt`,
rendered only while the run is live. Answers "how long has this been going" without a
scroll.

**2 — the status line replaces `Working…`.** Same slot at the thread tail, four fields:

```
⟳  Ran npm test — 1:04                                        ↑ headline + turn clock
   apps/web: 214 passed, 3 skipped (12.4s)                     ↑ streamed last line
```

- **headline** — the newest live item's own `title`, which the protocol layer already
  computed once (`UiToolItem.title`, e.g. `Ran npm test`, `Read run-header.tsx`, built by
  `toolDisplay()` in `packages/api-client/src/protocol/tool-display.ts:100`). Reusing it
  means the status line and the tool card below it can never disagree about what the agent
  is doing — the same "one canonical function" discipline `lib/attention.ts` documents.
  Reasoning items read `Thinking`, assistant messages `Writing`.
- **last line** — the final non-empty line of the field that is currently streaming: a
  running `execute` tool's `output`, or the item's `text`. This is the CLI behaviour the
  owner asked for, and it is the single strongest anti-"is it stuck" signal, because it
  changes on its own.
- **turn clock** — elapsed since the current item started, so a long single tool call is
  visibly long rather than ambiguously silent.
- **quiet badge** — after the silence threshold, ` · quiet 2:14`, escalating to a `pending`
  (amber) tone with a title attribute naming the real 30-minute bound.

**3 — silence is stated, never diagnosed.** The copy is `quiet 2:14` / `no output for
6:31`, never `stuck`. Suppressed entirely when `run.activity === 'monitoring'`.

### Why client-side, and why that is not a shortcut

Every input already reaches the browser:

| Needed | Already there |
| --- | --- |
| run duration | `RunRecord.startedAt` (`contract/src/runs.ts:260`) |
| what it is doing now | `UiItem` via `item.started` / `item.updated` (`api-client/src/protocol/ui-events.ts:181-210`) |
| the streaming tail | `item.delta` on `text` / `output`, applied by the reducer (`thread-state.ts:450-459`) |
| when the last thing happened | `RunEvent.ts` on every frame (`contract/src/events.ts:22-27`) |

A server-side `lastActivityAt` field would be a persisted, migrated, contract-widening
duplicate of a timestamp the client is holding already, and would refresh at record-update
cadence rather than at delta cadence — strictly worse for this view. It is only worth
paying for the *tasks list*, which has no event stream; that is Phase 4, deferred.

## Architecture

```
useRunHistory(id)  ──► visibleEvents ──► reduceThread ──► ThreadState
        │                    │                                │
        │                    └──► lastEventAt(events) ────────┐│
        │                                                     ▼▼
        └──► run.startedAt ──────────────────────────►  liveStatus(...)   (pure, tested)
                                                              │
                                    ┌─────────────────────────┴──────────────────┐
                                    ▼                                            ▼
                        <LiveDuration/> in RunHeader              <RunStatusLine/> at thread tail
                        (owns its own 1s tick)                    (owns its own 1s tick)
```

| File | Change |
| --- | --- |
| `packages/web/src/lib/format.ts` | **new** `formatDuration(ms)` beside `shortAge`/`compactTokens` |
| `packages/web/src/components/live-duration.tsx` | **new** leaf component: `useNow(1000)` + `formatDuration` |
| `packages/web/src/routes/task-thread/live-status.ts` | **new** pure selector `liveStatus()` + `lastEventAt()` |
| `packages/web/src/routes/task-thread/thread-items.tsx` | `WorkingIndicator` → `RunStatusLine`, same `data-slot` |
| `packages/web/src/routes/task-thread/task-thread.tsx:342` | pass run + thread + events to the new line |
| `packages/web/src/routes/task-thread/run-header.tsx:146` | `<LiveDuration>` beside the `<Pill>` |

Three decisions worth writing down:

- **`useNow` lives in the leaf, never in the route.** `useNow(1000)` (`lib/use-now.ts`)
  re-renders its owner every second. Placed in `TaskThreadRoute` or in `RunHeader`'s body it
  would re-render a 300-row transcript 60×/minute. Both new components are leaves that
  receive an ISO string and render one span. This is the whole reason `LiveDuration` is its
  own component rather than three lines inlined twice.
- **`data-slot="working-indicator"` is kept** even though the component is renamed.
  `review-panel.test.tsx:177` queries it as a stable DOM handle for "is the thread live",
  and that assertion is still exactly true. Renaming the slot would break a passing test to
  say nothing new.
- **Main agent wins.** When the newest item carries `parentItemId`, it belongs to a
  subagent; it is still shown (it is real work) but prefixed `↳`, matching the
  main-vs-subagent distinction `2026-08-19-context-usage-in-tasks-table.md` established for
  `contextTokens` and `2026-07-20-grouped-subagent-display.md` for the dock.

## Data models

**No contract change. No persisted field. No migration.** Everything is derived at render
time from shapes that already exist. The one new *type* is internal to the web package:

```ts
// packages/web/src/routes/task-thread/live-status.ts
export interface LiveStatus {
  /** "Ran npm test" | "Read run-header.tsx" | "Thinking" | "Writing" | "Working" */
  headline: string
  /** Last non-empty line of the streaming field, collapsed and truncated. Absent when none. */
  detail?: string
  /** ms since the current item started; absent when no item has started this turn. */
  itemMs?: number
  /** ms since the newest event's `ts`; drives the quiet badge. */
  silentMs: number
  /** 'normal' | 'quiet' (≥ QUIET_MS) | 'stale' (≥ STALE_MS) — never "stuck". */
  tone: LiveTone
  /** True when the item is a subagent's (`parentItemId` present) — renders the `↳` prefix. */
  subagent: boolean
}

export function liveStatus(input: {
  state: ThreadState
  events: RunEvent[]
  now: number
  activity?: RunActivity
}): LiveStatus

/** Newest parseable `RunEvent.ts` as epoch ms, scanning from the end. */
export function lastEventAt(events: RunEvent[]): number | undefined
```

Thresholds, named constants in that module: `QUIET_MS = 45_000`, `STALE_MS = 5 * 60_000`.
Both are display-only and deliberately far below the real
`DEFAULT_RUN_IDLE_TIMEOUT_MS = 30 * 60_000` (`core/claude-cli-runner.ts:32`) — the UI warns
long before anything is killed, and the `title` attribute names the 30-minute bound so the
two numbers are visibly related rather than two unexplained clocks.

## API contracts

None added or changed. The feature consumes, unmodified:

- `GET /api/v1/runs/:id` → `RunRecord` (`startedAt`, `status`, `activity`)
- `GET /api/v1/runs/:id/history` (+ `/history/context`) → `RunHistoryPage`
- `GET /api/v1/runs/:id/events` (SSE, cursor-resumed) → `RunEvent` frames, including the
  ephemeral coalesced `item.delta` frames

## Phases

Each phase is independently shippable and independently useful; each ends green.

**Phase 1 — the timer.** `formatDuration` in `lib/format.ts` (+ unit tests);
`LiveDuration` leaf; render it next to the status pill in `RunHeader` when
`run.status === 'running'` and `startedAt` parses. Ships the owner's first ask alone.

**Phase 2 — the status line.** `live-status.ts` (`liveStatus` + `lastEventAt` + tests);
rename `WorkingIndicator` → `RunStatusLine`, keeping the slot; wire it in
`task-thread.tsx:342` with the reduced thread and events. Headline + streamed last line +
item clock. `silentMs` is computed but not yet rendered.

**Phase 3 — the quiet badge.** Render `tone` and the quiet/stale text; amber past
`STALE_MS`; the 30-minute bound in the `title`; suppressed for
`run.activity === 'monitoring'` and for any non-`running` status.

**Phase 4 — the tasks list (DEFERRED, not in this spec's scope).** The same "what is it
doing / how quiet is it" answer on `/` and `/tasks` needs a server-side field, because
those views hold no event stream: a `lastEventAt` on `StepState`/`RunRecord` plus a copy
onto `RunIndexEntry`, exactly the shape `2026-08-19-context-usage-in-tasks-table.md` used
for `contextTokens`. Named here so the next session does not re-derive it; explicitly not
built now. **Filed 2026-08-20 as workspace todo `e755a560`** at low priority, gated behind the
runtime QA (`98bbd957`): if the streaming grammar turns out to be wrong on screen, the list
version would inherit the mistake.

## Analytics

The cockpit web app ships **no analytics sink** — `grep -rn "analytics|posthog|track("
packages/web/src` returns nothing. There is therefore no event to name, and inventing a
pipeline for a display change would be scope the owner did not ask for. The observable
signal for this feature is the run event stream itself, which is already recorded per run
in `runs/<id>.ndjson` and is what the verification below replays.

## Risks

| # | Risk | Mitigation |
| --- | --- | --- |
| R1 | Wording implies "stuck" when the agent is mid-model-call. A long round-trip is silent and healthy. | Copy is `quiet 2:14` / `no output for 6:31` — the measured fact. Mirrors the deployed kill message's own retreat from "timed out" to "produced no output for" (`2026-08-20-agent-step-inactivity-timeout.md`). |
| R2 | A 1s tick re-renders a 300-row transcript. | The tick is owned by two leaf components, never by the route or the header body. Pinned by a test that `TaskThreadRoute` does not call `useNow`. |
| R3 | `monitoring` runs are quiet by design and would sit permanently amber. | The escalation is suppressed on `run.activity === 'monitoring'`; `MonitoringSchedule` already says when the next check is. |
| R4 | `item.delta` is ephemeral and coalesced (~40 ms) — a fast stream makes the detail line strobe, and a replay never re-emits it. | Render the last **non-empty line** only, single line, `truncate`, newlines collapsed; no markdown. On replay the reducer's snapshot (`item.updated`/`item.completed`) supplies the same text, so a reloaded thread degrades to the last complete value rather than to nothing. |
| R5 | Clock skew: a server `ts` slightly ahead of the browser prints `-3s`. | Clamp at 0, exactly as `shortAge` (`lib/format.ts:15`) already does. |
| R6 | `startedAt` absent on old records. | Render no timer. An empty slot is honest; `NaN:0-3` is not — same rule as `shortAge`'s `''`. |
| R7 | Tool output can contain secrets or 4 000-character lines. | Same content the tool card below already renders, so no new exposure; truncated to a single clipped line. |
| R8 | The newest item is a subagent's, so the line describes work the main agent is not doing. | `parentItemId` → `↳` prefix, per the subagent-display decision. Shown, but never mislabelled as the main session. |

## Verification

Concrete and executable. Run from the repo root.

1. **Typecheck** — `npm run typecheck` (contract, client, server, web). Must be clean.
2. **Pure unit tests** — the load-bearing logic is deliberately in pure modules so it is
   testable without a DOM:
   ```
   npm test -- --project web packages/web/src/lib/format.test.ts \
                             packages/web/src/routes/task-thread/live-status.test.ts
   ```
   > **Corrected 2026-08-20.** As written this said `npx vitest run …`, which `AGENTS.md`
   > § Validation forbids outright: vitest is a devDependency here, and `npx` reaches past the
   > pinned binary to fetch a different version off the registry. The implementation session
   > ran the `npx` form and got a silently-different runner. Use `npm test --`.
   Cases the new suite must contain:
   - `formatDuration`: `0 → 0:00`; `64_000 → 1:04`; `3_600_000 → 1:00:00`;
     `7_384_000 → 2:03:04`; negative input clamps to `0:00`.
   - `liveStatus`: a running `execute` item with streamed `output` → headline is the item
     `title`, detail is the **last** non-empty output line (not the first, not the whole
     blob).
   - a reasoning item still streaming → headline `Thinking`, detail = tail of `text`.
   - an item with `parentItemId` → `subagent: true`.
   - `silentMs` from the newest event's `ts`; a `ts` in the future clamps to `0`.
   - tone table: `< QUIET_MS → normal`, `≥ QUIET_MS → quiet`, `≥ STALE_MS → stale`, and
     `activity: 'monitoring'` → `normal` at every silence value.
   - an empty event list / a thread with no items → headline `Working`, no detail, no throw
     (the reducer's totality rule applies here too).
3. **Existing suites must stay green** — the rename touches a shared component:
   ```
   npm test -- --project web packages/web/src/routes/task-thread
   ```
   `review-panel.test.tsx` (`[data-slot="working-indicator"]`) is the specific assertion
   that proves the DOM handle survived the rename. **It runs, and it passes** — verified at
   the shipped commit, 27 files / 699 tests green for this directory plus `format.test.ts`
   and `design-guardian.test.ts`.

   > ~~**Known environmental caveat:** React component tests in this sandbox fail on
   > `React.act` / `node:` resolution errors unrelated to any change. If that is what the
   > output shows, say so and quote it — do not report the suite as passing, and fall back to
   > step 4 for the component-level evidence.~~
   >
   > **Struck 2026-08-20: this caveat was false, and it was load-bearing in the wrong
   > direction.** There is no sandbox limitation. `React.act is not a function` means
   > `NODE_ENV=production` was set when `npm ci` ran, so npm installed **no devDependencies**
   > and there was no React, no testing-library and no pinned vitest in the tree at all — the
   > "unrelated errors" were the absence of the test stack, reported as a React bug. Anything
   > that reproduces "even on an untouched file at clean HEAD" is evidence of an
   > *environment*, not of an unrunnable suite: the same install feeds both. `unset NODE_ENV`
   > before `npm ci` and the suites run. See `AGENTS.md` § Validation.
4. **Real runtime pass — required before this is called done, not "gates green".**
   Open the cockpit on a genuinely running task (this very run is one) and observe, on
   screen:
   a. the header timer ticking each second beside a violet `running` pill;
   b. the status line naming the current tool and its target, changing as the agent moves
      from tool to tool;
   c. the detail line updating **within a long `Bash` call** — the proof that it is the
      streamed tail and not a per-turn snapshot;
   d. the quiet badge appearing during a real model round-trip and clearing on the next
      frame.
   Capture a screenshot of (b) and (c) into `.ai/specs/assets/` and reference it here.
5. **Deploy class check** — `git diff --name-only` must touch `packages/web/**` and
   `.ai/specs/**` only. If anything under `packages/cezar/**` or `packages/contract/**`
   appears, this stopped being a web-only change: it needs the service restart described in
   `AGENTS.md` §"Always self-deploy" instead of a bare asset swap. Still deploy it in-session —
   the restart is survivable and continuation resumes the run.

Until step 4 has actually been executed and recorded, the status of this work is **QA
needed**, not done.

### What the implementation session actually ran (2026-08-20)

| Step | Result |
| --- | --- |
| 1 — `npm run typecheck` | **clean** (contract, client, server, web) |
| 2 — the two new pure suites | **68 passed**, 0 failed |
| 3 — the task-thread suites | ~~**cannot be executed in this sandbox.** 17 of 25 files fail with `TypeError: React.act is not a function`, and so does an *untouched* `packages/web/src/components/pill.test.tsx` run against a clean HEAD checkout — the caveat above, confirmed rather than assumed. Restricted to the 9 DOM-free suites in that directory: **306 passed**… `review-panel.test.tsx`'s `[data-slot="working-indicator"]` assertion is therefore **unverified by execution**.~~ **Retracted 2026-08-20 — see the correction at the top.** `NODE_ENV=production` had made `npm ci` skip every devDependency, so the test stack was simply absent. With `NODE_ENV` unset the suites run: `npm test -- --project web packages/web/src/routes/task-thread packages/web/src/lib/format.test.ts packages/web/src/design-guardian.test.ts` → **27 files / 699 tests, all passed**, including `review-panel.test.tsx`'s working-indicator assertion and the `no-tick-in-thread-containers` guardian rule. Whole web project: **174 files / 3782 tests green.** |
| 3b — the rest of the gate suite | `npm run typecheck`, `npm test`, `npm run test:unit`, `npm run build` (incl. `check:pack`) and `npm run test:package` — **all green**. One unrelated red: `packages/cezar/src/knowledge/catalog.test.ts` C18 index-build perf budget, which is **pre-existing** (reproduced at clean HEAD with this work stashed) — a machine-speed benchmark reading 61–68 ms/MiB against a 40 ms line on a box at load average 5–7 across 8 cores. Left alone: out of scope, and loosening it would gut a deliberate guardrail. |
| 4 — real runtime pass | **NOT EXECUTED. Still outstanding** — this is the single reason the status above says *QA needed* rather than *done*. Tracked as workspace todo `98bbd957` (`cezar todo list`), spec-linked, with the four on-screen acceptance checks from § Verification 4 written into it. |
| 5 — deploy class | **web-only**: `packages/web/**` + this spec, nothing under `packages/cezar/**` or `packages/contract/**`. Per `AGENTS.md` this is the class that swaps into `/opt/cezar` with no `systemctl restart`, and is therefore safe to ship from inside a live session. |

### What shipped, and where

**Commit `d353944c`** — *"feat: a running task says what it is doing, and for how long"* — on
`origin/main` (pushed `817b6971..d353944c`), one commit for the whole feature, referencing this
spec. Ten files, +921 / −17:

| File | |
| --- | --- |
| `packages/web/src/lib/format.ts` (+ `.test.ts`) | `formatDuration(ms)` beside `shortAge`/`compactTokens` |
| `packages/web/src/components/live-duration.tsx` | the ticking leaf — `useNow(1000)` + `formatDuration` |
| `packages/web/src/routes/task-thread/live-status.ts` (+ `.test.ts`) | `liveStatus()`, `lastEventAt()`, `lastLine()`, and the exported thresholds `QUIET_MS` / `STALE_MS` / `IDLE_TIMEOUT_MS` |
| `packages/web/src/routes/task-thread/thread-items.tsx` | `WorkingIndicator` → `RunStatusLine`, `data-slot="working-indicator"` kept |
| `packages/web/src/routes/task-thread/task-thread.tsx` | wires run + thread + events into the line |
| `packages/web/src/routes/task-thread/run-header.tsx` | `<LiveDuration>` beside the status pill |
| `packages/web/src/design-guardian.test.ts` | the `no-tick-in-thread-containers` rule pinning risk R2 |

No contract change, no persisted field, no migration — as designed.

Two implementation notes that differ from the sketch above, both deliberate:

- **The R2 pin is a design-guardian rule, not a bespoke test.** `no-tick-in-thread-containers`
  in `packages/web/src/design-guardian.test.ts` forbids `useNow` in `task-thread.tsx` and
  `run-header.tsx`. The guardian is where this repo already keeps static source invariants, and
  a rule there also catches the next person who inlines a tick, which a one-off assertion in
  `live-status.test.ts` would not. (It shares the `node:fs` sandbox limitation, so it too runs
  only in CI.)
- **`lastLine()` treats `\r` as a break and strips ANSI CSI.** Not in the sketch, but tool
  output is raw terminal bytes: without it a progress bar's accumulated blob, or a bare `[2K`
  erase sequence, becomes the "current activity" line. Covered by its own cases.

### Deployed 2026-08-20 14:16 UTC — evidence, not assertion

Deployed to the prod host `prod-host` via this repo's documented **web-only swap**
(`AGENTS.md` §"Shipping cezar itself"): build → `cp -a` into `/opt/cezar/.../web/dist.new` →
`mv dist dist.prev.$TS && mv dist.new dist`. **No `systemctl restart`, and none was needed** —
the server reads web assets with `readFileSync` per request (`shell-routes.ts`), so the new tree
takes effect on the next request. A full `cezar server-deploy` was deliberately NOT run: it is a
hard restart with `KillMode=control-group` that would have SIGKILLed this very session mid-deploy.

| Claim | How it was checked | Result |
| --- | --- | --- |
| Gate green before shipping | `npm run typecheck` (root, so the server AppType is rebuilt first) | clean, all 3 projects |
| The build carries the feature | `grep` the built bundle for `live-duration`, `Running for`, `tabular-nums` | all 3 in `assets/run-header-exMj32f0.js` |
| ...and the OLD build did not | same grep against `dist.prev.20260820-141605/assets/run-header-cqPAkWSl.js` | 0 matches — a real discriminator |
| The LIVE service serves it | `curl http://127.0.0.1:4321/assets/run-header-exMj32f0.js` | HTTP 200, 22617 B, markers present, `md5` == on-disk |
| Nothing restarted | `MainPID` + `ActiveEnterTimestamp` before vs after | both unchanged (`2875213`, 13:28:10 UTC) |
| Service still healthy | `systemctl is-active`; `GET /` | `active`; HTTP 200 |
| Server dist correctly untouched | `git diff --name-only 62a41d30..52a39767 -- packages/cezar/src` | **0 files** — web-only confirmed, not assumed |

A first grep pass looked like a failure — the markers were absent from `task-thread-*.js`. They
were simply in a different chunk (`run-header-*.js`); the earlier check had counted matching files
without naming them. Worth recording because the near-miss is the useful part: *a bundle grep that
reports a count instead of a path can't tell "not deployed" from "looked in the wrong chunk".*

`/opt/cezar/.deployed-commit` was updated to `52a39767` and states plainly that the **server**
build is still `62a41d30`, that this split is intended rather than drift, and that the service must
NOT be restarted to "catch up" to the stamp. `AGENTS.md`, `CHANGELOG.md` and the three specs
changed in this range were synced into `/opt/cezar` with dated `.bak` copies.

**This is deployed, not done.** Verification §4 — the real-browser runtime pass — has still never
been executed (todo `98bbd957`). It must be watched on a genuinely RUNNING task: a replayed thread
does not exercise the streaming path, because `item.delta` frames are never re-emitted (risk R4).

### Runtime confirmation 2026-08-20 14:2x UTC — the timer renders

The owner reported not seeing the timer, correctly noting that "deployed" had been evidenced only
as *bytes served*, never as *pixels rendered* — a real gap in the check. Cause was neither a failed
deploy nor a data gap: the entry chunk hash changed (`index-GwGxH3dU` -> `index-CYPil8c_`) and every
asset ships `cache-control: immutable, max-age=31536000`, so an already-open cockpit tab keeps
running the OLD graph until `index.html` is re-fetched. After a reload the owner confirmed: **"I can
see UI now."** That closes the render half of Verification section 4 for the timer.

Two facts worth pinning, because both were guessed at during the incident:

- **It is not "new tasks only".** The gate is `run.status === 'running'` (plus a present
  `startedAt`), verified in the SERVED bundle:
  `e.status===\`running\`?jsx(et,{since:e.startedAt,label:\`Running for\`}):null`. `startedAt` is a
  pre-existing server field, present on **11/11** runs in the store including the ten already
  `done` — so no run is missing it. Non-running runs show no timer *by design*, and at that moment
  exactly one run was `running`, which is why the UI looked empty.
- **`index.html` is served with NO `Cache-Control` at all** (assets are immutable, the HTML has no
  header). It works, but it leaves "did my deploy land?" resting on browser heuristics. Any future
  web deploy should expect a reload to be required, and telling a user "it is deployed" without
  saying "reload" is an incomplete instruction.

**Generalisable:** a bundle-grep plus an HTTP 200 proves *delivery*, not *behaviour*. For a UI
change the two can diverge for an entire session on nothing but an open tab. Until something has
rendered for a human or a headless browser, the honest status is "deployed, unrendered" — and this
box has no Playwright/Puppeteer, so that last step is a human's until one is installed.

Still open from section 4: the **streaming last-line** behaviour (risk R4) — it needs watching on a
live run, since replay never re-emits `item.delta`. Todo `98bbd957` stays open for it.
