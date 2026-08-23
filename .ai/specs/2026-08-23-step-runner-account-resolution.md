# A step that pins its own runner must resolve its own account

**Status:** Implemented — QA Needed until the production re-run of `da0119ec` lands its `spec`
step on `claude:secondary`.
**Date:** 2026-08-23
**Reported:** the owner, from production, watching run `da0119ec` immediately after pressing
"Run on… codex": *"there is some inconsistency eg. on steps model when we rerun this on codex, and
for some reason it tried to run on codex sonnet"*.

**Extends:** `.ai/specs/2026-08-23-retarget-task-to-another-engine.md` (which wrote the limit down),
`.ai/specs/2026-08-16-agent-account-usage-routing.md` (the pool), and
`.ai/specs/2026-08-22-per-step-model-display.md` (the rail's three-way chip). It reverses nothing in
any of them.

## TLDR

1. **A per-step `runner` pin overrides the PROVIDER but never re-resolves the ACCOUNT**, so it
   silently lands on that provider's *default* profile — even when that account is out of quota and
   a healthy sibling is sitting idle. Measured in production: `spec` went to `claude:default`
   (limited until Aug 26) while `claude:secondary` was unlimited and never considered.
2. **The step rail plans a model the step's backend cannot serve.** Six `spec-to-deploy` steps pin
   `sonnet`, a Claude alias. On a codex run the engine drops the pin at dispatch and says so, while
   the rail goes on rendering `sonnet` beside those steps.

## Problem

### 1. The account is resolved once, for the run's provider, and never again

`resolvePoolForDispatch` runs a single time, at dispatch (`run.ts` ~4620), keyed on
`input.runner ?? config.defaultRunner`. Its own comment is explicit: *"A pool route resolves HERE,
once, and never again."* That is correct for the run.

Each step then computes `backend = step.runner ?? taskBackend` (`runAgentStep`, ~5598). The built-in
`spec-to-deploy` pins `runner: 'claude'` on `spec` and `review-spec` deliberately
(`SPEC_AUTHORING_RUNNER`), so that *"these two steps are opus, on Claude, whatever the rest of the
chain runs on"*. That pin changes the provider. **Nothing re-resolves the account for it.**

The account then falls through the documented ladder in the profile-resolution helper (~1345):

```ts
const profileId = options.recordedProfileId
  ?? (backend === (run?.runner ?? 'claude') ? run?.agentProfile : undefined);
```

`backend` is `claude`, the run's runner is `codex`, so `profileId` is `undefined` and resolution
falls to *"the project's stored selection, and failing that the discovered default"*. The stored
selection for claude on this box is `pool:*` — and `selectProfile` **cannot resolve a pool**:

```ts
const chosen = profileId ?? selectionFor(store, repoRoot, provider);   // "pool:*"
if (chosen === undefined || chosen === DEFAULT_AGENT_ACCOUNT_ID) return defaultAgentProfile(...);
const stored = store.accounts.find((a) => a.id === chosen && a.provider === provider);  // no match
return stored ? resolveStoredProfile(stored) : defaultAgentProfile(provider, env);      // ← default
```

A `pool:` route silently degrades to the default account. That is harmless on the run path, which
resolves pools earlier — **the step path is the only caller that reaches it with a pool route**.

**Why this survived the fix that shipped this morning.** Phase 1 of the retarget spec now writes
`limited` correctly, and that flag is read in exactly two behavioural places: `agent-route-select.ts`
(inside `selectPoolAccount`) and `run.ts:2863` (the Phase 4 setting, off by default). Neither is on
this path. The limit was written, was correct, and was never consulted.

**Measured, run `da0119ec`, 2026-08-23 15:51 UTC:**

```
context  done    backend=codex   profileId=default
spec     failed  backend=claude  profileId=default  model=opus
         error: You've hit your weekly limit · resets Aug 26, 11pm (UTC)
```

with `claude:default` carrying `limited {until: 2026-08-26T23:00:00Z}` and `claude:secondary`
carrying no limit at all.

### 2. The rail plans a model that cannot run

`StepModel`'s three-way chip is careful — an unresolved step renders its workflow-planned model
dimmed, italic, `data-source="planned"`, titled *"Planned by this workflow."* It is not claiming the
step ran. **But the plan it shows is one the engine has already decided cannot happen.**
`modelForBackend` drops a pin the backend cannot serve, and the transcript says so outright:
`model "sonnet" is not a codex model — running on codex's default instead`. The rail and the
transcript then disagree, and the rail is what a reader scans first.

The two `opus` chips are **correct** and must stay: `spec` and `review-spec` pin `runner: claude`,
so opus really is what they will ask for. Any fix that blanks every pin on a codex run would delete
true information — the distinction is per step, not per run.

## Solution

### Phase 1 — a step-pinned provider resolves an account for that provider

New `resolvePoolForProvider({ provider, repoRoot, inflight, now })` in `agent-route-select.ts`,
beside `resolvePoolForDispatch` and sharing its parts:

- reads that provider's stored selection (`selectionFor`), and returns `undefined` when it is not a
  pool — an explicitly stored account is already honoured by `selectProfile`, and overriding it here
  would be a second, invisible routing rule;
- **forces the candidate set to `provider`**, even when the route is the wildcard `pool:*`. The
  caller has already pinned the provider; letting a wildcard cross back over to another provider
  would undo the very pin that got us here. This is deliberately narrower than
  `resolvePoolForDispatch`, and it does **not** decide the open question in todo `81ab4ebd` (whether
  a *run's* explicit runner should constrain a wildcard pool) — that stays open.
- ranks with the existing `selectPoolAccount`, so limited-skip, usage band, in-flight and
  least-recently-dispatched all apply unchanged;
- records the dispatch, advancing the fairness cursor. **This is a real second dispatch**, to a
  different provider than the run resolved, so the cursor should move; the hazard the todo warned
  about is double-counting *one* dispatch, which this is not.
- never throws, matching its sibling: an unreadable home degrades to today's behaviour.

Wired at the documented seam in `run.ts` (~1345): when `profileId` is `undefined` **and** the step's
`backend` differs from the run's runner, resolve through the pool for `backend` and use the chosen
account. Same-provider steps are untouched, and a recorded `profileId` (a resume) still wins — a
session belongs to the account that created it.

### Phase 2 — the rail does not plan an unservable model

`PlannedSteps` gains the `runner` it already carries on the wire (`workflowStepDefSchema` has
`runner` and `model`, both optional, so the web already receives it). `StepModel` takes the run's
runner and, for a planned pin only, asks the existing `modelConflictsWithRunner` against
`step.runner ?? runRunner`. On a conflict it renders `auto` with `data-source="planned-dropped"` and
a title naming what was planned and why it will not be used.

`executed` and `identity` are untouched: once a step has run, what ran is a fact and outranks
every plan.

## Phases

1. `resolvePoolForProvider` + the `run.ts` wiring. Ships alone and is the whole production fix.
2. The rail chip. Cosmetic, no engine coupling.

## Risks

- **R1 — a second dispatch record per run.** Accepted and intended; see above. The test asserts the
  cursor moves for the step's provider and not for the run's.
- **R2 — the wildcard narrowing could read as deciding `81ab4ebd`.** It does not: that todo is about
  a *run's* runner versus a wildcard pool. Called out in the code comment so the next reader does
  not mistake one for the other.
- **R3 — masking a real pin in the rail.** Mitigated by naming the planned model in the tooltip
  rather than dropping it silently, and by keying on the step's own runner so the two `opus` chips
  stay truthful.

## Verification

Every case must be confirmed to fail before the change it covers.

- `agent-route-select` — `resolvePoolForProvider` skips a limited account and returns the healthy
  sibling; returns `undefined` for a non-pool route; **never crosses providers on `pool:*`**.
- `run.ts` engine — a run on codex whose step pins `runner: claude`, with `claude:default` limited
  and `claude:secondary` healthy, records `profileId: secondary` on that step. Fails today with
  `default`. A same-provider step is unchanged, and a recorded `profileId` still wins.
- `step-rail` — a planned `sonnet` on a codex run renders `auto`/`planned-dropped`; a planned `opus`
  on a step pinning `runner: claude` still renders `opus`. The second is the negative control: a fix
  that blanks everything passes the first and fails this.
- Full gate on the box, expecting the one standing red (`catalog.test.ts` C18) plus the known
  intermittent `workspace-parallel.test.ts` (todo `ffc3f805`).
- **Runtime:** re-run `da0119ec` and watch `spec` land on `claude:secondary` instead of failing.

## Verification — executed

**Automated, all run.**

- `agent-route-step-provider.test.ts` (6) — the resolver. **Mutation-confirmed:** replacing the
  forced provider with the route's own (`poolCandidates(route, …)`, i.e. undoing the narrowing)
  reddens *"never crosses providers on the wildcard `pool:*`"* and **only** that case.
- `step-runner-account.test.ts` (3) — the wiring, and the one that would have caught production.
  **Confirmed to FAIL pre-fix** by restoring the seam to `: undefined`:
  `AssertionError: expected 'default' to be 'secondary'`. It names the account, so the failure is
  the defect rather than a timeout.
- `step-rail.test.tsx` (+3) — **two mutations, biting different tests**, which is what makes the
  pair a proof rather than one assertion counted twice: disabling the new branch reddens only *"does
  not plan a model the run's backend cannot serve"*; keying on the RUN's runner instead of the
  step's reddens only *"keeps a planned model the STEP's own runner pin can serve"*.

**Full gate on the box** (`/var/lib/cezar/gate-retarget`, full-tree sync, six manifests md5-matched
so no `npm ci`): `typecheck EXIT=0`; `582 passed | 1 failed | 2 skipped (585)`, `10840 passed | 1
failed` — the single red is the standing `catalog.test.ts` C18 CPU budget. `workspace-parallel.test.ts`
passed this round; it is the ~50% flake tracked as todo `ffc3f805`.
`find /var/lib/cezar -not -user cezar` = 0.

### Two fixture bugs found while writing this, both worth keeping

- **`codex: 'pool:*'` in the accounts fixture routed the RUN onto a claude account** — todo
  `81ab4ebd` reproducing inside my own test. The run's provider stopped being codex, so the fixture
  silently exercised two mechanisms. Narrowed to `{ claude: 'pool:*' }` and commented, because the
  next person writing a routing test will reach for the same shape.
- **The wait was the bug, and only the box showed it.** `settle()` waited for the RUN to reach a
  terminal status; the second step raises `ask.requested` and the run parks on `waiting`, which is
  not terminal. It timed out on the box and passed on the Mac — and the diagnostic proved the
  account resolution was already correct in the failing run (`pinned` was `done` on
  `claude/secondary`). Replaced with a step-scoped wait, which also took the file from 60s to 3s.
  Keyed on **`profileId`, not `backend`**: they are stamped by two different `updateStep` calls,
  `backend` lands first, and waiting on it read `profileId` as `undefined` — "not there" was "not
  arrived yet".

The lesson worth carrying: a timeout names the WAITER, not the awaited. Both times the engine was
right and the fixture was wrong, and only a diagnostic that printed the run's actual step state
distinguished them — `'run did not finish in time'` would have sent me to debug the fix.
