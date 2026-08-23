# Run a parked task on another engine, and route around an exhausted account

**Status:** All five phases implemented; gates green; deployed to `prod-host` as
`20260823T150053Z-b862ef05`. **Phase 1 is Done** — verified in production against a real usage-limit
refusal (see Verification). **Phases 2, 3 and 5 are QA Needed**: the endpoint is live and mounted,
but its effect needs one authenticated click on a task that is safe to start, and the only two
parked runs on the box are not (one of them is a request for this very feature).
**Date:** 2026-08-23
**Reported:** the owner, from production — the same report that produced
`.ai/specs/2026-08-23-usage-limit-hold-account.md`. That spec made the queue honest about *why*
task `7c01e21d-49af-416a-bbe5-4be681b6ac9a` was parked; this one is about the two things a person
still cannot do afterwards: move the task, or have cezar move it for them.
**Extends:** `.ai/specs/2026-08-16-agent-account-usage-routing.md` (the pool and its four signals)
and `.ai/specs/2026-08-03-auto-resume-after-usage-limit.md` (the hold and the schedule). It
reverses nothing in either.
**Closes:** one of the two "found while auditing, NOT fixed here" risks recorded in
`2026-08-23-usage-limit-hold-account.md` — `recordLimited()` having no production caller. Phase 1
wires it, and todo `c8142431` was closed 2026-08-23 after the write was seen in production.

**Corrected 2026-08-23, against the plan this spec was built from:** the plan asserted that
"Phase 4's setting is the decision todo `81ab4ebd` asks for", and that is **wrong** — it was
written from the todo's summary rather than its acceptance criteria. `81ab4ebd` asks for one of two
things: either an explicit task-level runner **filters** pool candidates to that provider's
accounts (with a test proving a codex-created run never dispatches to a claude account), or the
per-task picker is **documented as advisory** whenever a wildcard pool is configured, *and the UI
says so*. `fallbackAcrossAccountsWhenLimited` is neither. It moves a different axis: whether an
**explicit, non-pool** account may be routed around when it is out of quota. A pool route still
picks the provider, and the picker still has no effect on it. So `81ab4ebd` stays **open**, and the
knowledge note this spec filed records the finding, not the decision it asks for.

Todo `dab1c7f8` (persist the held account on the record) also stays open and is not touched here.

## TLDR

A task created explicitly on **codex** sat `queued` for hours behind a **Claude** weekly limit.
Three separate things had to be true for that, and the previous spec fixed only the third:

1. **`pool:*` picks the provider, so the per-task picker had no effect.** The box's
   `~/.cezar/agent-accounts.json` carries `defaults: { claude: "pool:*", codex: "pool:*" }`;
   `poolCandidates` on a provider-less pool route returns every profile-capable account across
   every provider. The task said codex and was dispatched to claude.
2. **The pool could not route around the exhausted login, because nothing ever told it.**
   `selectPoolAccount` has ranked "skip a limited account" as **signal 1** since 2026-08-16 — the
   stated reason pools exist. It was dead in production: `recordLimited()` had no caller outside
   its own tests, so `AccountUsageEntry.limited` was never written and `isLimited()` answered
   `false` for an account a provider had just refused.
3. **Nothing could move the parked task.** `POST /runs/:id/continue` already accepts
   `{runner, model}`, but only a run with a **session** can use it — a queued run has none — and
   the pills that set it live inside the follow-up composer, which a parked task never shows.

Phase 1 fixes (2) alone and is the smallest change that would have prevented the report. Phases 2
and 3 give a parked task somewhere to go; Phase 5 gives it a button. Phase 4 is the product
decision (1) asks for, and it ships **off**.

## Problem

### The pool's own feature was never wired up

Measured by reading the tree, 2026-08-23: every reference to `recordLimited` outside its
definition in `workspace/agent-account-usage.ts` is a test —
`agent-account-usage.test.ts` and `agent-route-select.test.ts`. `clearLimited` is the same.

This is a specific and unusually deceptive shape of dead code, and it is worth naming because the
suite looks like it covers the feature:

- The **pure ranking function is correct and thoroughly tested.**
  `agent-route-select.test.ts` has a whole `describe('signal 1 — skip a limited account')` with
  three cases, including one that a mutation comment describes precisely.
- Every one of those tests **passes identically with and without this change**, because they build
  an `AgentAccountUsageStore` by hand and hand it to `selectPoolAccount`.
- So the coverage that exists proves the ranking, and proves nothing about the *store ever being
  written*. The gap is between the two, which is exactly where no test was looking.

What made it survivable is the queue hold from `2026-08-03-auto-resume-after-usage-limit.md`: a
limited account stops the work anyway, by parking the run. But the hold and the limit are
different mechanisms with different lifetimes and different scopes — the hold is one run's
appointment, keyed on that run's `autoResumeAt`; `limited` is a fact about a LOGIN that outlives
every run on it. Parking is not routing, and parking is what the reporter saw.

### A parked task has nowhere to go

`continueRun` requires `sessionStep?.sessionId` and refuses `queued` outright
(`cannot continue a queued run`). The two parked states a person actually meets are:

| state | record | what exists | what `/continue` does |
| --- | --- | --- | --- |
| queued behind a hold | `status: 'queued'` | a `pendingJobs` entry, no session | refuses — wrong status |
| scheduled after a limit | `status: 'failed'`, `autoResumeAt` set | a session | works, but the UI never offers it |

The second is only a UI gap. The first needs an engine method, because a queued run's executable
half lives in `pendingJobs` (process-local) and **`execute()` reads `input.runner`, not the
record** — so changing the record alone changes nothing about where the run goes.

## Solution

### Phase 1 — write the limit down, so the pool's existing skip works

Two new private helpers on `RunManager`, and three call sites.

`recordAccountLimit(run, resetAt)` is called from `scheduleAutoResumeIfLimited` **immediately after
`parseUsageLimit` succeeds and before every early return under it**. The placement is the whole
design decision: whether *this run* will resume itself and whether *that account* is exhausted are
different questions, and the three refusals below the call — the workspace setting being off, the
run having no session to resume, the resume cap being spent — all answer only the first. None of
them is evidence a provider's window reopened. Recording under them would leave the pool routing
onto a login that just said no.

**Keyed with `usageHoldAccountKey`, not `runAccountKey`** — the account that was refused is on the
STEP that ran, which is the correction `2026-08-23-usage-limit-hold-account.md` was filed for.
Repeating that mistake here would poison the balancer in both directions at once: excluding a
healthy login while leaving the closed one eligible.

`clearAccountLimit(runId, stepId)` is called wherever a step reaches `done`. **There are two such
seams, not one**, and covering only the first is the mistake this note exists to prevent:

- `finishStep()` — the workflow-step path, four `'done'` call sites. Every ordinary agent step
  lands here, so this is the seam that matters most.
- `runContinuation()`'s two inline `updateStep(… 'done')` sites (the budget-stop branch and the
  plain-success branch), which do **not** go through `finishStep`.

A completed turn is the only honest proof the window reopened. The stored `until` is a provider's
prediction and `isLimited` already expires it on time; this covers the other direction, where the
window reopened earlier than stated. A step with no `backend` (a `check` step) clears nothing —
guessing there would clear a limit on a login that never ran.

Both writes are fire-and-forget. `mergeWriteAgentAccountUsage` never throws, and a lost write costs
one dispatch's fairness, never a run; blocking the failure path on a JSON write is the worse trade.

**Nothing else changes.** `selectPoolAccount` already excludes limited candidates and already ranks
the rest by usage band → in-flight → least-recently-dispatched, which is already "another login of
the same provider first, another provider only when everything nearer is limited".

### Phase 2 — retarget a queued run

`RunManager.retargetQueuedRun(runId, { runner?, agentProfile?, model? })`. It refuses unless the
run is `queued` **and** has a `pendingJobs` / `pendingContinuations` entry — a queued record with no
work item is the wedge `reviveQueuedRun` exists to repair, and retargeting it would write a new
engine onto a record with nothing to execute, which is a 200 that changes nothing.

**The pending input is rewritten, not only the record.** `execute()` reads `input.runner` /
`input.agentProfile` / `input.model`; it never reads the record. A record-only retarget would show
the new engine on every surface a human can see and dispatch to the old one. The record is updated
too, and must be — `pump()`'s admission gate keys on `runAccountKey(run)` off the record, so a
stale one puts admission and dispatch back into the disagreement that produced the 2626-note storm.

`heldAtSpawn` and `heldNotified` are dropped for that run. The first is a memo of the account a
spawn refused it on, and it is stale the instant the target changes — left in place it would keep
the run out of the queue on a verdict about a different account, so the retarget would appear to do
nothing until the old account's hold expired.

**The model is dropped, never substituted**, following
`.ai/specs/2026-08-22-failed-turn-reads-as-done.md`: an explicit model that the target runner
cannot serve is refused outright (`continueRun`'s own guard, same words), and an *inherited* pin
that conflicts is cleared so the new backend falls through to its own current default.

> **Deviation from the plan, deliberate.** The plan asked for the resume ladder from
> `2026-08-23-codex-resume-explicit-model.md` (configured default → live catalog ∩
> `KNOWN_PRESETS_BY_RUNNER` → omit). That ladder exists because `thread/resume` with no `model`
> makes codex replay whatever it persisted when the thread was created. **A queued run has no
> thread**, so there is nothing to replay and nothing to poison; the "dropped, not substituted"
> rule is the correct one here, and it is the rule the plan itself said not to re-invent. Note
> also that the spec explicitly *rejected* falling back to `KNOWN_PRESETS_BY_RUNNER.codex[0]` as a
> static list — it uses it only as a filter over ids a live catalog just returned.

**`reviveQueuedRun` carried the fix the plan asked for, and two more sites needed it.** All three
paths that rebuild a queued run's executable half from its record — `reviveQueuedRun` (restart /
watchdog), `reattachBrokeredRun` (a live spool survived a restart) and `reenterChain` (a chain
hands itself back) — dropped `agentProfile`. Fixing only the first would have let a retarget leak
back out through the other two, so the three inline copies were collapsed into one
`queuedInputFromRecord` helper. This was a live bug before this spec: an explicit account pick was
silently downgraded to the project's selection at every restart, while the record went on
displaying the account the user chose.

### Phase 3 — one endpoint for both parked states

`POST /runs/:id/agent`, registered beside `/continue`, body `{ runner?, agentProfile?, model? }`.
One route for the two parked states because from the thread they look identical — nothing is
happening and nothing will happen soon — and making the cockpit choose the engine call would put
the engine's internals in the UI.

| state | goes to | why |
| --- | --- | --- |
| `queued` | `manager.retargetQueuedRun` | no session; the pending work item is what must change |
| `failed` (incl. scheduled) | `manager.continueRun` | already reopens on a named engine |
| anything else | **409** naming the status | never a silent 200 |

Same guards and codes as `/continue`: 404 unknown, 409 on `agentModelsLocked` with a model, 409 on
`providerActionError`.

**An `agentProfile` sent for a run that has a session is refused, not ignored.** `continueRun`
takes no account parameter, and that is not an oversight to paper over: a resume reattaches to a
session, and `sessionId`/`profileId` are a pair, so "same thread, different account" is not
something a provider can do. Accepting the field and dropping it would answer 200 and change
nothing about where the work runs.

> **Deviation from the plan.** The plan put `retargetRunSchema` in `packages/contract/src/`,
> "mirroring `continueSchema`". `continueSchema` is not in the contract package — it lives in
> `server.ts`. The sibling schema is therefore next to it, in the same file; the contract package
> holds the shapes *both* sides need, and the cockpit posts this body without reading it back.
> Likewise the client method went to `packages/web/src/api/client.ts`, which is where
> `continueRun` actually is (`packages/api-client/` holds the protocol, not the callers).

### Phase 4 — the option, off by default

`resources.fallbackAcrossAccountsWhenLimited`, default **false**, threaded exactly as
`autoResumeOnUsageLimit` is: stored schema (`workspace/config.ts`), contract GET + PUT
(`contract/src/workspace.ts`), `WorkspaceResourceLimits` + `DEFAULT_LIMITS` + `loadResourceLimits`
+ accessor (`workspace/semaphore.ts`), the four server sites, and one switch in Settings →
Resources ("Out-of-quota fallback"). Absent reads as **off** at every layer — the mirror image of
`autoResumeOnUsageLimit`'s absent-reads-as-on, and for the opposite reason: this setting overrides
a choice the user made, so a server or config predating the key must never appear to have it on.

The engine half is **two gates, one resolution**, which is not quite what the plan described:

- **Admission (`heldAccountFor`)** simply stops holding when the setting is on. With the fallback
  enabled, "this account is limited" is no longer a reason to wait, so the run is admitted and
  reaches dispatch.
- **Dispatch (`rerouteExplicitAccountIfLimited`, called from `execute()` beside
  `resolvePoolForDispatch`)** makes the actual choice, reusing `selectPoolAccount`.

> **Deviation from the plan, and the reason matters.** The plan asked for the re-route at *both*
> gates — `heldAccountFor` and `requeueWhileHeld`. Neither can host it: both are **synchronous**,
> while choosing an account means reading two JSON files. Worse, the obvious helper
> (`resolvePoolForDispatch`) advances the fairness cursor as a side effect, which is exactly why
> `2026-08-23-usage-limit-hold-account.md` states that *"admission deliberately does NOT resolve
> the pool itself"* — calling it per pump sweep would corrupt the balancer it is consulting. So
> admission answers the cheap half (stop holding) and dispatch answers the expensive half (choose),
> once, at the only point already allowed to resolve an account. If dispatch finds nowhere better,
> `requeueWhileHeld` parks the run exactly as before, so admitting it costs at most one dequeue.

Candidates are filtered to non-limited accounts **before** `selectPoolAccount` is asked, because
that function deliberately still answers when every candidate is limited (documented, for the pool
case). Unfiltered, it would move the run onto another closed login: a burnt turn, and the account
the user chose lost for nothing. Every reroute writes a `recordDispatch` (so fairness still counts
it) and a transcript note naming both accounts — overriding a user's choice in silence is the
failure this setting is a decision about.

### Phase 5 — the button

`useRetargetAction` (`task-thread/retarget-engine.tsx`) beside `useContinueAction`, built from the
same pieces: `RunnerPill` / `PickerPill`, `modelsForRunner` / `resolveModel`, `useRunnerModels`,
`useContinuationProvider`. One engine picker in the product, not three — a second implementation
would drift on exactly the details that stay invisible until they are wrong (which models a backend
offers, what "auto" resolves to, whether a locked-models workspace may pin one at all).

**Only pills the user touched are sent.** An omitted field means "keep what the run has" and a
present one means a deliberate choice; the two are indistinguishable from the UI, so somebody who
opens this to change the runner must not silently also re-pin a model they never looked at.

Visibility is `runActionFlags.retarget` — `queued`, or `failed` **with** an `autoResumeAt` — so the
rule is table-tested with the other actions. A plain `failed` run is excluded even though the
server would accept it: it already offers **Continue**, whose composer carries these same pills.

**Two placements, one hook.** The plan asked for the header action row, the mobile menu, and a
placement next to the parked pill. All three read `runActionFlags.retarget` and call
`useRetargetAction`, so they cannot disagree about *when* a task is movable or *how* it moves:

- **`RetargetHint`** (`retarget-hint.tsx`) — the full control, in the DOCK beside `AutoResumeHint`,
  carrying runner **and** model pills. The dock is where the thread answers "what is expected of me
  right now?", which for a parked task used to be "nothing, for days".
- **`RetargetMenuButton` / `RetargetMenuItems`** (`retarget-menu.tsx`) — the shortcut, in the header
  action row and (as flat rows, not a submenu, because a phone has no hover) the mobile overflow
  menu. A menu of *engines*, not a second engine picker: picking one moves the task immediately and
  sends **no model**, so Phase 2's ladder re-resolves one for the new backend. A click on "codex"
  says nothing about which codex model, and pinning one the user never chose is precisely the
  failure the ladder exists to avoid. The engine the task is already on is shown **disabled**
  rather than hidden — "you are already here" is information, and hiding it makes a two-provider
  host's menu look like it has one choice.

> **Deviation from the plan.** The plan's third placement — next to the `held <when>` pill — was
> not implemented. That pill is on the **list rows** (`lib/account-hold.ts`), not in the thread,
> and putting engine pills into a list row is a different design question. The dock hint is the
> nearest in-thread equivalent and is where this landed.

## Architecture

```
  provider refuses a step
           │
           ├─────────────► accountHolds()          ← 2026-08-03: park THIS RUN
           │                                          (per-run, dies with the run)
           │
           └─ recordAccountLimit()  [PHASE 1, NEW]
                     │  usageHoldAccountKey(run)   ← the STEP that was refused
                     ▼
              agent-account-usage.json
                  accounts[key].limited
                     │
                     │  isLimited()
                     ▼
              selectPoolAccount()  signal 1        ← 2026-08-16: route the NEXT RUN
                     │                                (per-account, outlives every run)
                     ▼
              a different login, or a different provider

  a step reaches `done`
           │
           ├─ finishStep()          (workflow steps, 4 sites)
           └─ runContinuation()     (2 inline sites)
                     │  clearAccountLimit(runId, stepId)
                     ▼
              accounts[key].limited deleted
```

The two mechanisms are deliberately not merged. The hold answers "may this run start now"; the
limit answers "which login should the next dispatch pick". A single mechanism would have to be one
or the other, and the report is what happens when only the first exists.

## Phases

Phase 1 stands alone and ships first: it needs no UI, no new route, and no schema change, and it is
the smallest change that would have prevented the report. Phases 2 and 3 are one shippable unit (an
engine method is not reachable without its route). Phase 4 is independent of both and ships off.
Phase 5 needs 3.

## Data Models

`resources.fallbackAcrossAccountsWhenLimited: boolean` is added to `~/.cezar/config.json` with
`.default(false).catch(false)`, so an existing file needs no migration and a corrupt value degrades
to off. Nothing else changes shape.

**Phase 1 changes no stored shape.** `AccountUsageEntry.limited` has existed since
2026-08-16 with a schema, a `.passthrough()`, and a bounded default — it has simply never been
populated. No migration and no backfill: the next limit writes the first entry, and a store with no
`limited` anywhere behaves exactly as it does today.

## API Contracts

**New:** `POST /api/v1/runs/:id/agent` — body `{ runner?, agentProfile?, model? }`, all optional;
`200 {run}`, `404 {error}` unknown, `409 {error}` for every refusal (wrong status, models locked,
provider unusable, account change on a run with a session, or the engine's own reason).

**No contract response schema, deliberately.** It answers `{run}` — the shape its two nearest
neighbours (`POST /runs/:id/messages` and its sibling at `server.ts:5045`) already return without
one, unlike `/continue` and `/cancel`, whose responses are literals worth pinning. Adding a schema
here would mean adding a `contract-parity.runs.test.ts` row for a payload that is just the run
record, which `GET /runs/:id` already describes. It IS listed in `typed-bodies.test.ts`, which is
the gate that matters for this route: that one is add-only, so a route nobody lists is a route
whose silent removal from `AppType` nothing would notice. Mutation-checked — dropping
`jsonZodValidator` from the registration turns the new row into
`error TS2344: Type 'false' does not satisfy the constraint 'true'`.

**An empty body is meaningful, not a no-op.** Every field omitted means "keep the engine, but stop
waiting": the run's `autoResumeAt` is cleared, the `heldAtSpawn` / `heldNotified` memos are
dropped, and the queue is pumped. That is what the dock hint posts when a person presses the button
without touching a pill, and it is the honest answer to "I know it is held, try it now anyway" — a
retarget with no target is still a decision to re-admit the task. An omitted field never means
"reset to default"; only a field the caller sends changes anything.

**Changed:** the workspace config GET response and PUT body each gain
`resources.fallbackAcrossAccountsWhenLimited: boolean` (PUT: optional).

Phases 1 and 2 change no HTTP shape — Phase 1 is entirely internal, and `retargetQueuedRun` is
reached only through the new route above.

## Risks

- **A limit recorded on a pooled run names the login the pool chose, which is not the login the
  user picked.** That is correct and is the point — but it means a user who set `runner: codex` can
  see `claude:default` limited by their own task. The transcript already says so
  (`2026-08-23-usage-limit-hold-account.md`, Solution 3), and Phase 4 is the setting that stops it
  happening at all.
- **`clearAccountLimit` trusts a completed turn over a provider's stated reset.** A provider that
  serves one cheap turn inside a window it still considers exhausted would have its limit cleared
  early, and the next dispatch would fail and re-arm it. One wasted run, self-correcting. The
  opposite reading — never clear early — costs a working login for as long as the stated window,
  which is what `ASSUMED_LIMIT_COOLDOWN_MS`'s docblock already argues against for the unbounded
  case.
- **A Phase 4 reroute can cross providers, including to one that is not authenticated.**
  `listAgentProfiles(accounts, PROFILE_CAPABLE_PROVIDERS)` contributes each provider's discovered
  login whether or not it is usable, so with the setting on, a limited claude task can be moved to
  `codex:default` on a box where codex is not signed in — and then fail. This is **not** narrowed
  here on purpose: `poolCandidates` on a `pool:*` route has exactly the same reach, and a second,
  stricter definition of "available accounts" would drift from the first the moment either changed.
  The setting is off by default, and the honest fix is one shared usability filter applied to both
  paths, which is a change to the routing spec rather than to this one.
- **Two early returns still sit ABOVE the Phase 1 record, deliberately.**
  `scheduleAutoResumeIfLimited` returns before `recordAccountLimit` when a resume timer already
  exists (the limit was recorded on the earlier call — re-recording buys nothing) and when the run
  is `archived`. The second is arguable by this spec's own reasoning: archiving is resigning from a
  *task*, not evidence a provider's window reopened. It is left alone because the case is close to
  unreachable — the cockpit only offers Archive on a non-active run, so a run cannot be archived
  while it is failing — and because the reachable path that remains is boot recovery, where
  recording a limit off an OLD archived failure would teach the balancer to avoid a login using a
  window that has long since passed. If that ever needs revisiting, the fix is to move
  `recordAccountLimit` above the `archived` check and gate it on the parsed `resetAt` still being
  in the future.
- **Phase 1 makes the balancer act on data it has never had.** Every routing test to date has run
  against a store where `limited` is always absent. The behaviour change is therefore larger than
  the diff: the first genuinely limited account on the box will be the first time signal 1 has ever
  fired in production. This is the intended change, and it is why Phase 1 ships alone rather than
  bundled.

## Verification

### Phase 1 — automated (all executed)

`packages/cezar/src/workflows/auto-resume.test.ts`, a new `describe` driving the real engine
through the bundled mock's `mock:limit` reply. `CEZ_HOME` is pinned per test rather than relying on
the suite-wide sandbox in `vitest.setup.ts`, because that home is one directory per *worker* — an
entry left by one case would make the next one's pass unattributable.

- **V1** a `mock:limit` run writes `limited` for `claude:default` with `source: 'usage-limit'` and
  `until` equal to the exact instant read back out of the provider's own message. Not "a plausible
  future date": `until` is what `isLimited` gates on, so an hour's drift silently changes routing.
- **V2** the key is the STEP's account, not the record's. The run's `runner`/`agentProfile` are
  moved to codex **before** the failure lands (mutating afterwards would prove nothing about what
  the failure path read); `claude:default` is limited and `codex:default` is not.
- **V3** the limit is recorded even with `autoResumeOnUsageLimit: false`. This is the placement
  assertion — move the call below any early return and this one goes red while the rest stay green.
  The test first asserts `autoResumeAt` is undefined, so it cannot pass vacuously.
- **V4** a later completed turn on that account clears it, through `finishStep`. The per-run hold
  is cancelled first, which is both a necessity (the queue would otherwise park the second task,
  and `settle` would time out) and the clearest statement that the two mechanisms are independent —
  the test asserts `limited` survives `cancelAutoResume`.

**Confirmed to FAIL pre-fix**, by restoring `workflows/run.ts` to its parent revision and keeping
the tests: `Tests 4 failed | 24 skipped`, all four `expected undefined to be defined` on the store
read. Post-fix the file is `28 passed`, and `agent-route-select.test.ts`,
`agent-account-usage.test.ts` and `agent-route-dispatch.test.ts` are green alongside it
(96 passed across the four files).

**`agent-route-select.test.ts` is NOT a negative control for this change and is not claimed as
one.** Its three signal-1 cases pass identically on both sides of the commit — they hand a
hand-built store to a pure function that was never broken. They are a regression guard on the
ranking; the negative control is V1-V4 above, on the call.

One honest limit: V4's *clear* half cannot be independently red pre-fix, because nothing writes the
entry pre-fix for it to clear. Its pre-fix failure is on the same `toBeDefined` as V1.

### Phase 2 — `packages/cezar/src/workflows/retarget-queued-run.test.ts` (10 cases)

Runs are parked with an injected `maxParallel: 0` limits stub so they stay queued
deterministically, without needing a real usage limit to hold them there.

- The load-bearing case asserts **where the run actually STARTS** — it releases the queue and reads
  the `backend` stamped on the step that ran — not that the record changed. Everything else in the
  file is record-shaped, and that is visible in the mutation below.
- Refusals: non-queued (names the status), unknown run, queued-with-no-work-item.
- Model: an explicit conflicting model is refused **and nothing moved** (a refusal must not
  half-apply); an inherited foreign pin is cleared; a model the caller never mentioned survives a
  runner-preserving retarget.
- `heldAtSpawn` / `heldNotified` are dropped.
- `agentProfile` survives the rebuild a restart produces.
- An **empty** target re-admits a held task without changing its engine — the request the dock hint
  makes when no pill was touched, which the API Contracts section documents as meaningful.

**Mutations, all three confirmed:**

| mutation | result |
| --- | --- |
| retarget updates the record but not the pending input | exactly 1 of 10 red — *"starts the run on the NEW engine"* |
| `agentProfile` dropped from `queuedInputFromRecord` | exactly 1 of 10 red — *"carries the account into the rebuilt input"* |
| memos cleared only `if (target.runner)` | exactly 1 of 10 red — *"re-admits a held task on an EMPTY target"* |

The first is the point of the file: the other nine pass while the feature dispatches to the wrong
engine, which is why the started-on assertion had to exist at all.

### Phase 3 — `packages/cezar/src/server/retarget-run-api.test.ts` (8 cases)

Capturing stubs for `retargetQueuedRun` and `continueRun`, the `continue-run.test.ts` pattern. Each
routing case asserts the *other* engine call did **not** fire — without that, a route calling both
would pass.

**Confirmed by deleting the route: 7 of 8 went red.** The survivor was `404s an unknown run`, which
asserted only the status — and a route that does not exist also answers 404, so it was green with
the entire feature removed. Fixed by asserting the body (`{error:'not found'}`, which only this
handler produces); all 8 now fail without the route. That case is recorded here rather than quietly
repaired because it is the exact shape of negative control that reads as coverage and is not.

### Phase 4 — `packages/cezar/src/workflows/account-fallback.test.ts` (8 cases)

Paired ON/OFF cases over one fixture (`claude:default` limited), which is what makes the default
assertable at all:

- default OFF; absent-reads-as-OFF; with it **off** the run completes on the account it was given
  and no reroute note appears; with it **on** it moves to a non-limited login and the note names
  **both** accounts; with **every** candidate limited it does not move; admission holds with it off
  and does not with it on; no `recordDispatch` is written when nothing is rerouted.

**Mutated in both directions**, which is what a paired suite is for:

| mutation | result |
| --- | --- |
| accessor forced `true` | 4 of 8 red — every "off" assertion |
| accessor forced `false` | 2 of 8 red — every "on" assertion |

Disjoint sets, so neither half is passing by accident.

The OFF case waits for the run to reach a **terminal status** rather than sleeping a second: "it
did not move" asserted against a run that never started would pass for the wrong reason.

The reroute crosses providers (claude → codex) because `PROFILE_CAPABLE_PROVIDERS` contributes each
provider's discovered login. That is the same reach `pool:*` already has and is deliberately not
narrowed — see Risks.

### Phase 5 — `packages/web/src/routes/task-thread/retarget-hint.test.tsx` (11 cases)

**The dock hint (7).** Visibility for queued / scheduled / plain-done / running, and the request
body. **Mutating the hook to always send both pills reddens both body cases** (`{}` and
`{runner:'codex'}`), which is the naive implementation a reader would otherwise write.

**The header shortcut (4).** The two ways a second placement can silently disagree with the first:
*when* (its visibility must match the dock hint's, for all four states) and *what* (one click sends
the engine **alone**). Both confirmed by mutation — pinning a model in the shortcut path reddens
"sends the ENGINE ALONE"; dropping the `available` guard reddens "renders for the same states the
dock hint does". Plus the current engine shown disabled, and the server's 409 surfaced verbatim.

Radix in jsdom needs `fireEvent.pointerDown` to open a menu (`click` does nothing) and its rows are
`menuitem` / `menuitemradio`, never `option`; a `fireEvent.click` on a still-disabled button is a
silent no-op, which is why the helpers wait for `!disabled` rather than for presence.

Plus `run-actions.test.ts`: `retarget` is now a column in the 7-status × archived matrix, with
extra cases for scheduled-vs-plain-failed and never-while-running.

### Gates

- Mac: `npm run typecheck` **0**, `npm run build` **0**, full `--project web` suite
  **183 files / 3994 tests**. The one red it found was the header action-row matrix, which is the
  point of that matrix; fixed and re-run green.
- A final box pass at the exact committed tree, after the `typed-bodies.test.ts` row was added:
  `npm run typecheck` **0**, and `typed-bodies` + `bc-route-inventory` + `route-parity`
  **21/21**.
- Box (`prod-host`, `/var/lib/cezar/gate-retarget`, `CEZ_VITEST_MAX_WORKERS=3`, `nice -n 10`),
  the authoritative gate: `npm run typecheck` **0**; full `npm test` **579 passed | 2 failed |
  2 skipped (583 files)**, **10827 passed | 2 failed | 4 skipped (10833 tests)**. **Both failures
  are pre-existing and confirmed so**, each by its own control: `knowledge/catalog.test.ts` C18 (see
  below) and `workflows/workspace-parallel.test.ts` (the intermittent `?? .ai/`, reproduced 1 of 3
  on a pristine `origin/main` tree). C18 is the permanent standing red on that host — a CPU-time budget calibrated on
  an M4 Max and asserted on an 8-vCPU Hetzner box — so **N minus the known reds is the green
  result** there, not a near miss. `npm run build` cannot pass in an rsync'd gate directory at all:
  `scripts/write-build-stamp.mjs` shells `git rev-parse HEAD` and the copy has no `.git`. It dies
  *after* `check:pack ok`, so the build gate was taken from the Mac (exit **0**).

**The box gate is what caught five files the Mac run had not.** Running `--project web` plus the
named per-phase files is not the gate: `packages/cezar`'s vitest project is called **`server`**, and
the full run turned up (a) three exhaustive `toEqual` config snapshots that had to gain
`fallbackAcrossAccountsWhenLimited` — `workspace/config.test.ts` ×2 and `server/workspace-api.test.ts`
×3 — and (b) `server/bc-route-inventory.test.ts`, the `BACKWARD_COMPATIBILITY.md` §2 drift guard,
which failed because `POST /api/v1/runs/:id/agent` was registered and not inventoried. Both are
gates doing exactly their job; §2 now carries the route and a paragraph describing it. A
round-trip test was added for the new setting (`PUT turns the out-of-quota fallback on, and it
reaches the semaphore the engine asks`) because the snapshots only prove the key is *present*, not
that all four threading points are wired — deleting the PUT persist site reddens 1 test, deleting
the GET response site reddens 4.

**A second, INTERMITTENT red on the box, confirmed pre-existing.**
`workflows/workspace-parallel.test.ts`'s "nothing was applied into the real checkout" assertion
fails as `expected '?? .ai/' to be ''` roughly half the time on that host, and passes consistently
on the Mac. It happened to pass in the 583-file run above, so that green was partly luck. Three
targeted runs on the patched tree: **2 of 3 failed.** Three on a pristine `origin/main` control
(`git archive HEAD` into `/var/lib/cezar/gate-ctl`, `cp -al` node_modules, `.vite` removed, with
`grep -c fallbackAcrossAccountsWhenLimited packages/cezar/src/workspace/config.ts` printing **0**
in the same output as proof the control carried none of this work): **1 of 3 failed.** So it is not
this change. **Filed as todo `ffc3f805`** (2026-08-23): something writes `.ai/` into the fixture
project after a run that did not succeed, which is either a real leak or a fixture that races its
own cleanup. Its acceptance criteria require naming the writer by file and line rather than
inferring it, and proving the fix with 20 consecutive green runs of the single case **on the box**,
since the Mac is not where it reproduces.

### Runtime E2E on `prod-host`

Deployed `b862ef05` as release `20260823T150053Z-b862ef05` (blue-green, cutover gap **69 ms**,
service active, `find /var/lib/cezar -not -user cezar` = **0** throughout). The deploy gate earned
its keep: the first attempt refused with *"build stamp sha 81635378 disagrees with source HEAD
b862ef05; run npm run build first"* — a pull is not a build.

**Step 1 — PASSED, and better than the plan asked for.** Within 90 seconds of the cutover the
restart re-queued `7c01e21d`, it dispatched, its `spec` step ran and was refused, and Phase 1 wrote:

```
claude:default -> {"since":"2026-08-23T15:01:18.385Z","source":"usage-limit","until":"2026-08-26T23:00:00.000Z"}
claude:secondary -> no limit    codex:default -> no limit
```

Three separate things are proven by that one line:

- **The key is the account the STEP was refused on, not the run's.** The run's `runner` is `codex`;
  the entry is `claude:default`, because `spec-to-deploy` pins claude on its `spec` step
  (`steps: context=done/codex, spec=failed/claude:default`). That is `usageHoldAccountKey` doing
  exactly what the parent spec added it for, now with something to write.
- **`until` is Aug 26, not Aug 23.** The same account's older record, `76680e19`, still carries
  `autoResumeAt: 2026-08-23T23:00:30.000Z` — written by the pre-fix parser, three days early, same
  clock time. The two records sit side by side in `runs.json` as a before/after of the tier-3
  named-date fix, and the new run's lifecycle note reads *"resuming automatically at Aug 26, 2026,
  11:00:30 PM UTC"*.
- **The pool now has somewhere to go.** `claude:secondary` is unlimited at 18% session / 25% week
  with 2672 dispatches, against `claude:default`'s 8. Signal 1 has real data in production for the
  first time.

**Step 3 — PASSED.** Note write rate measured 70 s apart on the live box: transcript lines
**46 → 46**, `held in the queue` count **2 → 2**, total `.ndjson` bytes across every run
**86,686,381 → 86,686,381**. Zero growth, `systemctl is-active` = active, local health probe 200.
The parent spec's rollback was a 2626-note storm that both deploy probes called green, so this is
the measurement that matters, not the cutover's own `[deploy.drained]`.

**Step 2 — NOT RUN, deliberately, and it needs the owner.** Two blockers, either of which is
sufficient:

1. **The fixture is obsolete.** `7c01e21d`'s task text is *"Add an option to resume a task with
   different provider/model if we hit limit"* — it is a request for **this spec**. It is
   `autonomous: true` on `spec-to-deploy`, so pressing "Run on…" would have set an autonomous agent
   to write a spec for, implement, commit, push and deploy a feature that landed on `main` minutes
   earlier. The only other parked run, `76680e19`, is the one whose stale appointment fires tonight.

   **Re-checked at 15:20 UTC, and the inventory moved under this paragraph** — worth recording,
   because it is the kind of drift that makes a stale "here is the fixture" note dangerous. Both
   runs live in the **workspace** project's store (`/var/lib/cezar/workspace/.ai/cezar/runs.json`),
   not the `cezar` one, and both have since gone `queued` → `failed` with a future `autoResumeAt`.
   So they no longer exercise Phase 2 at all; they now land on the Phase 3 `failed`-with-a-session
   branch that delegates to `continueRun`. The only run in the whole box that is currently `queued`
   is `da0119ec` — which is the run started from todo `81ab4ebd`, i.e. the decision this spec did
   **not** make. Retargeting it would be retargeting an investigation into its own subject.
   Blocker 1 therefore still stands, for a different run than when it was written.
2. **The API cannot be driven headlessly.** `CEZ_AUTH` is on, so an unauthenticated
   `POST /api/v1/runs/:id/agent` answers `401 {"error":"unauthenticated"}` before the handler runs.
   Verified as the WALL and not the route by a control: `/cancel`, `/continue` and `/agent` all
   answer `401` identically on the same run, while `/health` answers `200` — and `runs/:id/agent`
   is present in the deployed `dist/server/server.js`. A 401 where the inner gate would have said
   409 is evidence about the perimeter, not about the endpoint.

So the endpoint is live, mounted, and indistinguishable from its established siblings at the
perimeter; what remains unproven at runtime is the retarget's *effect*, which needs one authenticated
click on a task that is safe to start. **This ships as QA Needed** on Phases 2/3/5. Phase 1 is Done.

**Step 4 — DONE.** Written to the production corpus as `cezar`, and verified **indexed** rather
than merely written, against the live workspace-scoped catalog
(`/var/lib/cezar/workspace/.ai/cezar/knowledge-index/catalog.ndjson` — not the stale project-scoped
one). A phrase-grep is not proof for a `domains/*.md`-sized document, so both were checked by
comparing the catalog's `bytes` and `hash` against the file on disk:

| document | bytes | hash | catalog `updatedAt` |
| --- | --- | --- | --- |
| `changelog/2026-08-23-retarget-task-to-another-engine--local.md` | 5495 = 5495 | `5e2497be15ab9ae2…` = disk | 15:07:59Z |
| `knowledge/sections/334-…-pool-route-picks-the-provider-too--local.md` | 4727 = 4727 | `b78a996ae670a3a7…` = disk | 15:09:49Z |

Todo bookkeeping, done through the shipped store helpers as `cezar` (`updateTodo` / `cez todo add`,
so the lease and the cluster stamp are the product's, not a hand-edit), each re-read by id
afterwards because a `todos.json` write has been observed to vanish silently under a correctly-taken
lease:

- `c8142431` (`recordLimited()` has no production caller) → **done**. Re-read confirms `done`.
- `81ab4ebd` → **stays open**, against the plan's prediction. See the correction at the top of this
  spec: its acceptance criteria ask for a pool *filter* or an advisory-picker note in the UI, and
  `fallbackAcrossAccountsWhenLimited` is neither.
- `dab1c7f8` → stays open by design, untouched.
- `ffc3f805` → **new**, the pre-existing `workspace-parallel.test.ts` flake.

And the parent spec's **V5 is no longer pending**: its derivation was confirmed against the live
production records, with a negative control, and its Verification section now carries the numbers.
`find /var/lib/cezar -not -user cezar | wc -l` = **0** after every write in this session.
