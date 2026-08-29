# Logged-Out Account Fallback

**Status:** Implemented / QA Needed — landed on `main` as `c569aee8` (PR #11, merged 2026-08-25),
shipped revision `d385cd5c`. The full repo gate suite (`npm ci --include=dev`, `npm run typecheck`,
`npm test`: 631 files / 11911 tests, 0 failing) has run green on that exact merged tree. **V6**
(the isolated-secondary-server runtime E2E) and **V7** (the packed-CLI E2E) below have not run, and
the change has not been deployed. Do not read this as `Implemented` until V6, V7 and the deploy
have actually happened. Tracked as cezar todo `21e18103-dd69-41de-8343-b6d401df75db`.
**Date:** 2026-08-25
**Repo:** `cezar`
**Task:** `90836867-2ad6-4c51-abfd-b242ba46da6d`
**Brief:** `.ai/specs/briefs/2026-08-25-credentials-unavailable-auto-fallback.md`

**Owner ask, verbatim:** *"dont block actions with 'Claude Code credentials are unavailable.
Authorize it in Settings → Agents → Providers. Configure providers' if there are more active claude
accounts or codex accounts, just continue on 'auto' one"*

**Extends:** `.ai/specs/2026-08-23-never-block-a-task.md` (the availability-outranks-the-pick
ladder), `.ai/specs/2026-08-23-retarget-task-to-another-engine.md` (Phase 4, the reroute
mechanism), `.ai/specs/2026-08-24-continuation-reroute-held-account.md` (the resume path's own
reroute), `.ai/specs/2026-08-23-step-runner-account-resolution.md` and
`.ai/specs/2026-08-16-agent-account-usage-routing.md` (the pool).

## TLDR

cezar already has a working "never blocked" ladder. It is keyed entirely off **quota**
(`isLimited`), and it lives entirely **after** dispatch begins. cezar also has a working
availability gate. It is keyed entirely off **credentials** (`status !== 'connected'`), and it
lives entirely **before** dispatch begins. Each layer routes around the failure it can see and
refuses on the failure it cannot.

The result is the reported bug: a workspace with a healthy `claude:secondary` and two healthy Codex
logins still answers `409 Claude Code credentials are unavailable` the moment the *discovered
default* Claude login goes stale, because the only thing the gate knows how to ask is "is the one
provider this action named connected?".

This spec makes the two layers see the same fact, and it **grades** that fact instead of flattening
it. An account is **runnable** (connected, in quota), **waitable** (connected, out of quota) or
**disconnected** (no usable credentials). Disconnected is hard-ineligible: dispatch never spawns on
it. Waitable stays eligible for the hold-and-appointment path that already exists, because waiting
out a limit is a real outcome and being logged out is not. Selection prefers runnable, falls back
to waitable, and never returns a disconnected account.

The pre-flight gate stops asking about one provider and starts asking the question dispatch will
actually answer: *is there any account this action is allowed to use that could run it?* One
read-only viability query answers it for both, and it takes the project's **route** as an input,
because a `pool:*` route already crosses providers with the fallback setting off while an explicit
account does not. Without the route the gate would be stricter than the picker in the exact
configuration production runs. It refuses only when the honest answer is no, and it then says which
"no" it is: *nothing is authorized anywhere*, or *this provider is out and fallback is off*.

The client stops mirroring any of this. It cannot see the accounts store or the project route, so
no client-side predicate is right; for a reroutable action the server's answer to the submission is
authoritative, and the composer renders the refusal instead of pre-empting it.

Two of the ten gate sites are deliberately **not** changed, and that is the interesting boundary:
see "The two sites that keep blocking". Two more are not gate changes at all: `POST /plan` does not
route through `RunManager` and needs its own selection, and `POST /runs/:id/messages` mostly needs
its gate moved *later* rather than relaxed.

## Problem

### The gate

`unavailableProviderMessage(required, response)`
(`packages/cezar/src/server/provider-action-gate.ts:57-71`) walks a list of *required* providers and
returns on the first one whose status row is not `'connected'` (or whose `enabled` is `false`).
`providerActionError(required, repoRoot)` (`packages/cezar/src/server/server.ts:1520-1542`) wraps
it with two mitigations that are both real and both too narrow:

- a **fresh re-probe** before refusing (`server.ts:1533`), so a stale cached negative cannot lock a
  user out. Correct, and untouched by this spec.
- **`poolHasConnectedAccount(provider, repoRoot)`** (`server.ts:1475-1495`), added after the
  production incident on run `da0119ec` (2026-08-23), which lets a connected **non-default pool
  member of the same provider** rescue the action. It is confined two ways: the project's route for
  that provider must parse as `pool:*`/`pool:<provider>` (`server.ts:1481`, `if (route.kind !==
  'pool') return false`), and even a wildcard `pool:*` is forced back to the single required
  provider (`server.ts:1483-1488`, *"a wildcard must not cross to another one here either"*).

So today: a project with a **stored explicit account** rather than a pool gets no fallback check at
all, and **no configuration whatsoever** lets a healthy Codex login rescue an action whose required
provider is Claude.

`required` is never `'auto'` at this layer. It is `providersRequiredByWorkflow(workflow, fallback)`,
`providerForActiveRun(run)`, or `providerForExistingRun(run, override)`
(`provider-action-gate.ts:17-55`), which resolve to a pin or to `config.defaultRunner`. A default
runner is a *preference*, and `2026-08-23-never-block-a-task.md` already ruled that a preference
never stops work. The gate does not know that ruling exists.

### The ten call sites

The brief lists nine. There are **ten**: `packages/cezar/src/index.ts:1031-1044`, the headless
`cezar run` pre-flight, calls `unavailableProviderMessage` directly, with no pool check at all and
no re-probe, and exits `1`. It is the strictest of the ten and the brief missed it.

| # | Site | `required` comes from | Dispatch free to choose? |
|---|---|---|---|
| 1 | `guardRunStart` (`server.ts:2571`), start a run | workflow pins + `defaultRunner` | yes, via `RunManager` |
| 2 | `POST /plan` (`server.ts:4685`) | `defaultRunner` | **not today**: no `RunManager` at all |
| 3 | `POST /runs/:id/messages`, live/starting (`server.ts:5266`) | `providerForActiveRun` | **no choice exists**: the session is already open |
| 4 | waiting-run reopen (`server.ts:5291`) | `providerForExistingRun` | yes, via `continueRun` |
| 5 | `POST /runs/:id/continue` (`server.ts:5416`) | `providerForExistingRun` + override | yes |
| 6 | retarget "Run on…" (`POST /runs/:id/agent`, `server.ts:5459`) | `providerForExistingRun` + target | yes |
| 7 | `POST /runs/:id/open-in-cli` (`server.ts:5510`) | `providerForExistingRun` | **no** |
| 8 | `POST /runs/:id/open-in`, CLI target (`server.ts:5612`) | `agentCliRunner(target)` | **no** |
| 9 | todo ▶ Run (`server.ts:6185`) | workflow pins + `defaultRunner` | yes |
| 10 | headless `cezar run` (`index.ts:1031`) | workflow pins + `defaultRunner` | yes |

Sites 2 and 3 are corrections to an earlier draft of this spec, which listed both as "dispatch free
to choose". Re-read against the code at `00a202b8`, neither is:

- **Site 2 has no dispatch layer.** `planChain` (`packages/cezar/src/planner.ts:55-101`) builds its
  own runner with `createRunner(config.defaultRunner)` (`planner.ts:66`) and resolves that same
  provider's account with `resolveProfileEnvForRoot(repoRoot, config.defaultRunner)`
  (`planner.ts:72`). It never touches `RunManager`, `resolvePoolForDispatch` or any reroute. Relax
  the gate alone and the planner spawns the logged-out CLI, `runner.run` throws, the `catch` at
  `planner.ts:82` breaks the loop, and the user gets the degraded one-step `fallback: true` plan
  (`planner.ts:96-100`) instead of a real one. The planner therefore needs its **own** selection of
  runner **and** profile env, added by this spec (Solution 4b).
- **Site 3 is two sites wearing one name.** The handler runs a three-rung delivery ladder
  (`server.ts:5279-5306`). The gate at `:5266` fires *before* `manager.sendMessage(id, content)` at
  `:5282`, so today a logged-out provider blocks a message that would have gone into an **already
  open** session, where no account is being chosen at all. There is a second, separate gate at
  `:5291`, on the reopen branch (`status === 'waiting' && !manager.isActive(id)`), and *that* one
  precedes a real dispatch (`manager.continueRun`). The fix is not one relaxation but two different
  changes: move the first gate below the ladder, and apply fallback selection only to the second.

### The dispatch layer

`rerouteExplicitAccountIfLimited` (`packages/cezar/src/workflows/run.ts:3075-3139`),
`downgradePinnedRunner` (`run.ts:3156-3205`), `resolvePoolForDispatch` and `resolvePoolForProvider`
(`packages/cezar/src/workspace/agent-route-select.ts:255-330`) can all move a run onto another
account, and `rerouteExplicitAccountIfLimited` and `downgradePinnedRunner` can cross providers
outright. Every one of them decides availability with `isLimited(usageEntry(...).limited)` and
nothing else. Grepping the seven specs of that family for `credential|unauthoriz|logged out|revoked`
returns zero hits (brief, section 3).

`downgradePinnedRunner` already stamps `reason: 'quota'` on its
`run.step.runner_downgraded` metric, with a comment saying in as many words that it is a named field
"so a future second downgrade cause does not silently merge into the quota number"
(`run.ts:3192-3196`). This spec is that second cause.

### The seam that does not exist yet

`RunManager` (`packages/cezar/src/workflows/run.ts`) has **no reference to `ProviderAuthService`**.
Verified: `grep -n 'providerAuth\|ProviderAuthService' packages/cezar/src/workflows/run.ts` returns
nothing. The dispatch layer therefore cannot currently ask whether an account is logged in. That is
the single largest piece of new plumbing this spec needs, and Phase 2 is mostly about doing it
narrowly.

### The client mirror

`packages/web/src/routes/task-thread/active-provider.ts:31-51` reproduces the gate's logic and its
exact string (`active-provider.ts:47`), and `thread-composer.tsx:45` and `ask-answer.ts:105-106`
disable the composer from it. A server-only fix leaves the user staring at a disabled box the server
would have accepted. `usableRunners` (`packages/web/src/lib/provider-status.ts`) has the same
narrowness for the engine picker.

## Solution

### 1. Three tiers, not one predicate

An earlier draft of this spec collapsed both failures into `unavailable = isLimited || !connected`.
That is wrong, and wrong in a way that would have shipped a regression: it makes "logged out" and
"out of quota" interchangeable, and they are not. A limited account **becomes usable on its own**,
which is why `heldAccountFor` (`run.ts:1973-2010`) parks a run against it and `noteHeld` tells the
user which account it is waiting on. A logged-out account never becomes usable without a human. Fold
them together and an all-limited workspace, which today parks and later runs, would instead be told
"no agent provider is authorized" and refuse. So the model is a **ladder of three tiers**:

```ts
type AccountTier = 'runnable' | 'waitable' | 'disconnected'
type AccountAuth = 'connected' | 'disconnected' | 'unknown'

/**
 * TWO caches answer for two different kinds of account, and reading the wrong one is how a
 * KNOWN-disconnected default silently becomes `unknown`, and therefore runnable.
 *
 * `status()` writes `this.completed` (`provider-auth.ts:492-493`) and `peekStatus()` reads it
 * (`:591-597`). `profileStatus()` writes `completedProfiles` (`:539`) and `peekProfileStatus()`
 * reads THAT (`:582-586`). Nothing copies between them, and the default account is probed by
 * `status()`, not by `profileStatus()`. So `peekProfileStatus(provider, 'default')` returns
 * `undefined` for a default cezar has just probed and found logged out. An earlier draft of this
 * spec routed every account through `peekProfileStatus`, which would have read that
 * freshly-probed, definitely-logged-out default as "no information" and run on it. V1 pins this.
 *
 * BOTH reads are RAW. `peekStatus()` is NOT the default's read here, because it applies
 * `withRuntimeFailures` (`provider-auth.ts:596`, `:467-480`), the provider-WIDE banner latch. A
 * secondary account's rejection writes that latch (the banner has always been per provider), so
 * routing through `peekStatus()` would classify a perfectly healthy `claude:default` as
 * `disconnected` the moment `claude:secondary` was refused, which is the exact inversion this
 * whole section exists to remove. Routing therefore reads the raw cached row and overlays only
 * the rejection recorded against THAT account.
 */
function authOf(profile: AgentProfile, ctx: ViabilityContext): AccountAuth {
  // 1. A per-account runtime rejection outranks any cache: this exact login was refused by the
  //    provider mid-run, which is newer than anything a probe wrote. Keyed by (provider, account),
  //    so it never spreads to a sibling. See "the latch is per-provider today, and that is not
  //    good enough" below.
  if (ctx.rejected(profile.provider, profile.isDefault ? undefined : profile.id)) return 'disconnected'
  // 2. The RIGHT cache for this kind of account, and only that one. Neither read carries the
  //    provider-wide banner latch.
  const row = profile.isDefault
    ? ctx.peekDefaultRowRaw(profile.provider)                // `this.completed` only, NO withRuntimeFailures
    : ctx.peekProfileStatus(profile.provider, profile.id)    // already latch-free by construction
  // 3. `unknown` ONLY when the appropriate cache has no answer at all. A cached row whose status
  //    is `disconnected`, `not-installed` or `unknown` is an answer, and it is not "connected".
  if (row === undefined) return 'unknown'
  return row.status === 'connected' ? 'connected' : 'disconnected'
}

function tierOf(profile: AgentProfile, ctx: ViabilityContext): AccountTier {
  if (authOf(profile, ctx) === 'disconnected') return 'disconnected'  // hard-ineligible, never spawned
  return isLimited(usageEntry(ctx.usage, keyOf(profile)).limited) ? 'waitable' : 'runnable'
}
```

- **`runnable`** = connected and in quota. Dispatch may start here right now.
- **`waitable`** = connected but out of quota. Dispatch may **not** start here, but the run may be
  **held** against it and released when the limit window opens. This is exactly today's behaviour
  and it is preserved unchanged: `2026-08-23-usage-limit-hold-account.md` and
  `2026-08-24-continuation-reroute-held-account.md` own this path.
- **`disconnected`** = the account's own cache row says it is not connected, or this account has a
  recorded runtime rejection. **Hard-ineligible. Never spawned, never held against, never returned
  by selection.** Holding a run against a logged-out account would be an appointment that never
  arrives, which is the exact failure this spec exists to remove.

**Selection order is `runnable` first, then `waitable`, and never `disconnected`.** Concretely:
every candidate filter in the pickers partitions rather than filters. If the `runnable` set is
non-empty, `selectPoolAccount` ranks within it and dispatch starts. If it is empty and the
`waitable` set is not, the existing hold-and-appointment path takes over, on the best `waitable`
account, with today's note text. If both are empty there is genuinely nowhere to go, and only then
does anything refuse.

**Which cache, for which account.** Auth is read from `ProviderAuthService`'s **cache only** at
the dispatch layer, never a live probe. Which peek is correct depends on the kind of account, and
getting this wrong is a shipped bug rather than a stylistic choice:

| Account | Peek | Carries the provider runtime latch? | `unknown` when |
|---|---|---|---|
| the discovered **default** for a provider | **`peekDefaultRowRaw(provider)`, NEW** (Phase 1): `this.completed?.response.providers.find(r => r.provider === provider)`, the same cache `peekStatus()` reads but **without** the `withRuntimeFailures` pass | **no**, and that is the point of adding it | `this.completed` is unset, i.e. `status()` has never resolved |
| a registered **non-default** account | `peekProfileStatus(provider, profileId)` (`:582-586`) | **no**, deliberately (`profileStatus`'s docblock, `:517-519`: the latch "is a coarse per-provider signal and stamping it onto every account of that provider would mark an untouched account as broken") | `completedProfiles` has no entry for that `(provider, profileId)` key |

**`peekStatus()` keeps its behaviour and keeps its caller.** It is what `GET /providers/status`
serves, so the acknowledgeable incident banner still latches per provider and still needs an
explicit acknowledgement to clear. `peekDefaultRowRaw` is a **second, narrower accessor added
beside it** for the routing path only, and nothing that renders the banner may use it. Two
accessors rather than one, because the banner and the router want genuinely different answers:
the banner asks "did this provider refuse someone, and has anyone acknowledged it?", the router
asks "can I spawn on THIS login right now?".

An **unknown** answer, and only an unknown answer, counts as connected, so an unprobed account is
`runnable`/`waitable` and never `disconnected`. A cached row that says `disconnected`,
`not-installed` or `unknown` is an *answer*, and it classifies as `disconnected`. Two reasons for
peeking rather than probing, both load-bearing:

- **Cost.** Every probe shells out to an agent CLI. A dispatch that spawned one per candidate would
  put hundreds of milliseconds per account onto the hot path, which is exactly the posture
  `peekProfileStatus`'s own docblock (`provider-auth.ts:565-581`) was written to protect.
- **Freshness where it matters.** The one moment this question is genuinely contested is right after
  the gate refused, and the gate has just paid for a `refresh: true` probe (`server.ts:1533`). The
  cache is warm precisely when the answer matters. When it is cold, "assume connected" reproduces
  today's behaviour exactly, so a cold cache can never make things worse than the status quo. It
  also means an unknown answer can never *manufacture* a `disconnected`, which is what would let a
  cold cache refuse an action.

**The runtime latch is per-provider today, and that is not good enough.** An earlier draft of this
spec claimed an account whose credentials were rejected mid-run would read as `disconnected`. That
is **false for a non-default account**, in two independent ways, both verified in current code:

1. `watchProviderRuntimeAuthFailures` (`packages/cezar/src/server/provider-auth-runtime.ts:11-46`)
   derives the failing provider as `step?.backend ?? run.runner ?? 'claude'` (`:26`) and **never
   reads `step.profileId`**. It calls `providerAuth.reportRuntimeAuthFailure(provider)` with a
   provider and nothing else.
2. `runtimeFailures` is a `Map<ProviderId, RuntimeAuthFailure>` (`core/provider-auth.ts:351`), and
   the latch is applied only by `withRuntimeFailures`, which rewrites rows of the *default* status
   response (`:467-480`). `profileStatus` and `peekProfileStatus` deliberately do not apply it.

So today a `claude:secondary` that just had its credentials rejected is invisible to every
per-account read, while `claude:default`, which may be perfectly healthy, is the row that gets
stamped `disconnected`. Under the tiering above, that is exactly backwards: cezar would exclude the
working account and keep routing to the dead one.

**Change (Phase 1), the smallest one that makes the signal per-account:**

- **State.** Add `runtimeRejections: Map<string, RuntimeAuthFailure>` to `ProviderAuthService`,
  keyed by the existing `profileCacheKey(provider, profileId)` shape, with `profileId` defaulting to
  the `DEFAULT_AGENT_ACCOUNT_ID` sentinel so a default account has a key too. The existing
  provider-wide `runtimeFailures` map is **kept unchanged**: it is what `GET /providers/status`
  surfaces as the acknowledgeable incident banner, and repointing that at a per-account map is a
  different, larger change with its own UI.
- **Producer.** `reportRuntimeAuthFailure(provider, profileId?)` gains the optional second
  argument, writes both maps, and returns the same `RuntimeAuthFailureReport` it does today.
  `watchProviderRuntimeAuthFailures` passes **`step.profileId` when the event names a step that
  exists on the record, and `run.agentProfile` otherwise**, resolving the ACCOUNT with the same
  step-first-run-second precedence the watcher already applies to the PROVIDER at
  `provider-auth-runtime.ts:26` (`step?.backend ?? run.runner ?? 'claude'`).
  An earlier draft of this spec said "passes `step?.profileId`" and stopped there. That is wrong,
  and the step-less case is routine rather than a corner: `AUTH_ERROR_EVENT_TYPES` is
  `{'error', 'session.error', 'note'}` (`:9`) and the watcher only looks a step up when
  `event.stepId` is a string (`:23-25`), so a runtime auth failure arriving without a `stepId` is
  an ordinary shape. Passing `step?.profileId` alone would collapse every one of those onto the
  `DEFAULT_AGENT_ACCOUNT_ID` key, which is the exact misattribution this change exists to remove:
  a run with `run.agentProfile = 'secondary'` whose credentials are rejected would mark
  `claude:default` as the routing-dead account and leave `claude:secondary`, the account that
  actually failed, eligible for the next dispatch. Called with no `profileId` at all (every other
  existing caller), behaviour is byte-identical to today.
  It keeps writing the provider-wide map **because the banner is a per-provider incident and the
  user acknowledges it per provider**; that write is precisely why routing must not read the
  default row through `peekStatus()`, and `peekDefaultRowRaw` above is the answer.
- **Consumer.** `ctx.rejected(provider, profileId)` in `authOf` reads `runtimeRejections` **only**,
  never `runtimeFailures`. That is the separation the whole design rests on: the provider-wide map
  is a **banner fact**, the per-account map is a **routing fact**, and only the second one may
  exclude an account from dispatch. It is an **overlay on the raw peek**, not a replacement for it:
  it can turn a `connected`/`unknown` answer into `disconnected`, and it never turns a
  `disconnected` answer into anything else. Only the rejected account is excluded; a sibling
  account of the same provider keeps whatever its own raw cache row says.
- **Lifecycle, stated because an unclearable latch is a permanent outage, and because the two maps
  clear on DIFFERENT rules.**
  - The provider-wide `runtimeFailures` stays **acknowledgement-only**, exactly as today.
    `clearRuntimeAuthFailure(provider, authFailureId)` (`provider-auth.ts:439-446`) is the only
    thing that clears it, and an ordinary fresh probe finding credentials deliberately does not:
    `provider-auth.test.ts:713` ("does not clear a runtime latch when an ordinary fresh probe finds
    credentials") pins that, and this spec **does not touch it**. An earlier draft of this spec
    claimed `status()` deletes the latch on a connected result; it does not, and that test is the
    proof.
  - The new per-account `runtimeRejections` clears on three things:
    (a) `clearRuntimeAuthFailure(provider, authFailureId)`, which now also deletes every
    `runtimeRejections` entry carrying that incident id, so one acknowledgement still repairs
    everything it created;
    (b) **NEW behaviour, and confined to this map:** a subsequent **`connected`** probe result for
    that exact key deletes the rejection for that key and no other. `profileStatus` (`:530-541`)
    deletes `runtimeRejections[(provider, profileId)]` when it stores a connected row, and
    `startFreshProbe` (`:485-495`) deletes `runtimeRejections[(provider, DEFAULT)]` for each
    provider whose freshly probed default row is `connected`. Neither touches `runtimeFailures`.
    The asymmetry is deliberate and is the point: a rejection that steers ROUTING should yield to
    evidence that the login works again, while a banner the user has not acknowledged should stay
    up until they do;
    (c) `forgetProfileStatus(provider, profileId)` (`:551-563`), already called when an account's
    dir is repointed under us.
  - No time-based expiry on either map, deliberately: `cacheTtlFor` already re-probes a
    non-connected answer within a minute, and (b) is that re-probe's result. Adding a second,
    independent clock would let a rejected account become eligible again with nothing having been
    checked.

### 2. The gate asks the question dispatch will answer, using the same code

The gate and the picker must not each derive their own answer. If they can disagree, they will, and
the failure mode is asymmetric and ugly in both directions: a gate that is more permissive than
dispatch turns an honest 409 into a run that starts and dies, and a gate that is less permissive
keeps refusing work dispatch could have placed. So there is exactly **one** read-only function, and
both call it.

**The candidate set is decided by the ROUTE, not by the setting alone.** An earlier draft of this
spec gave `ViabilityInput` a bare `fallbackAcrossAccounts: boolean` and no route, and concluded that
the setting being off meant "no cross-account move, therefore 409". That contradicts a recorded
decision and current code, in the direction that matters:

- KB `notion-4dee7a4df2f1` ("A pool route picks the PROVIDER too"), heading *"Overriding an explicit
  choice is a setting, and it is ON"*, states the rule directly: *"A pool routes around a limit by
  itself; an explicitly chosen account does not, because overriding a provider the user named is a
  product decision rather than a bug fix."* The setting binds the **explicit** case only.
- The code agrees. `resolvePoolForDispatch` (`agent-route-select.ts:243-270`) and
  `resolvePoolForProvider` (`:298-330`) **never read the setting**; they resolve and move on.
  `rerouteExplicitAccountIfLimited` (`run.ts:3075`) and `downgradePinnedRunner` (`run.ts:3156`)
  both open with `if (!this.semaphore.fallbackAcrossAccountsWhenLimited()) return undefined`.

So a workspace whose project route is `pool:*`, which is `prod-host`'s own configuration,
`defaults: {claude: 'pool:*', codex: 'pool:*'}`, balances across **providers** with the setting
off, and a gate that refused there would refuse work dispatch was about to place. Viability
therefore takes the route, and takes it per dispatch.

**The unit is a DISPATCH REQUIREMENT, not a provider.** An earlier draft of this spec modelled
scope as a set of *providers* and answered `placeable` with a single global "is any candidate
placeable anywhere". Two things were wrong with that, and both are reachable in production:

- **It threw away the account id.** An explicit route is `{kind: 'account', accountId}`, and
  collapsing it to its provider makes a healthy `claude:secondary` satisfy a gate for an action
  dispatch will run on the disconnected `claude:default`, because with fallback **off** neither
  `rerouteExplicitAccountIfLimited` nor `resolvePoolForDispatch` will move it: the first returns
  `undefined` at its first line, the second is never entered for a non-pool route. The gate says
  yes and the run spawns a logged-out CLI, which is exactly R1.
- **A global `some(placeable)` under-counts a mixed-provider workflow.** `spec-to-deploy` pins
  `spec` to `claude` while other steps run on the task's own provider
  (`providersRequiredByWorkflow` returns both). If claude is wholly disconnected and the setting is
  off, that pinned step has nowhere to go, but a global OR sees the healthy codex account and
  passes.

So viability answers per requirement and AND-s the answers:

```ts
// packages/cezar/src/workspace/account-viability.ts  (new, pure, no I/O of its own)

/**
 * ONE agent dispatch this action will cause, described exactly as the picker that places it will
 * see it. A run with a mixed-provider workflow produces one per distinct pinned dispatch.
 *
 * There is no `none` route. `AgentRoute` is a two-member discriminated union, `account` and
 * `pool` (`packages/contract/src/agent-route.ts:46-58`), and `parseAgentRoute(undefined)` is
 * `{kind: 'account', accountId: DEFAULT_AGENT_ACCOUNT_ID}` (`:73`). An earlier draft of this spec
 * wrote `{kind: 'none'}`, which does not type-check; "no route" is spelled as the default account,
 * because that is what dispatch actually resolves.
 */
export interface DispatchRequirement {
  /** The provider this dispatch is pinned to, when something pins it: a workflow step's `runner`,
   *  a retarget target, the recorded `run.runner` of a continuation. `undefined` only when
   *  nothing does and the route alone decides. */
  provider: ProviderId | undefined
  /** The route the corresponding picker will parse, from the SAME expression it reads (see the
   *  call-site table in Architecture). Carries the account id when there is one. */
  route: AgentRoute
  /**
   * May the pickers move this dispatch off `provider`/`route`?
   *  - `false` for sites 7 and 8, always: the pin is a capability (Solution 3).
   *  - for everything else, `fallbackAcrossAccountsWhenLimited` for an `account` route, and
   *    `true` for a `pool` route (pool resolution reads no setting).
   */
  reroutable: boolean
}

export interface ViabilityInput {
  profiles: readonly AgentProfile[]         // listAgentProfiles(accounts, PROFILE_CAPABLE_PROVIDERS)
  usage: AgentAccountUsageStore             // quota envelopes -> isLimited
  auth: (p: AgentProfile) => AccountAuth    // `authOf` from Solution 1: raw peeks + rejection overlay
  disabledProviders: readonly ProviderId[]  // workspace config; excluded from every candidate set
  /** Every default row `GET /providers/status` knows about, across all four `PROVIDER_IDS`, not
   *  only the profile-capable two. Used for `anyConnectedAnywhere` and nothing else. */
  providerRows: readonly ProviderStatus[]
  /** One per dispatch this action will cause. Never empty. */
  requirements: readonly DispatchRequirement[]
}

/**
 * The EXACT candidate set the picker for this requirement would build. Exported and tested on its
 * own, because it is the whole disagreement risk.
 */
export function candidatesFor(
  req: DispatchRequirement,
  input: ViabilityInput,
): readonly AgentProfile[]

export interface RequirementViability {
  requirement: DispatchRequirement
  runnable: AgentProfile[]      // connected + in quota, among this requirement's candidates
  waitable: AgentProfile[]      // connected + limited, among this requirement's candidates
  disconnected: AgentProfile[]  // reported for messages, metrics and notes; never selected
  /** dispatch can land THIS requirement: `runnable` or `waitable` is non-empty. */
  placeable: boolean
}

export interface Viability {
  requirements: RequirementViability[]
  /** `requirements.every(r => r.placeable)`. EVERY dispatch must have somewhere to go; a
   *  workflow is not placeable because one of its steps is. */
  placeable: boolean
  /** The pinned providers of the requirements that are NOT placeable, in `PROVIDER_IDS` order.
   *  This is what names `<Provider>` in the refusal, replacing "the first `required` entry". */
  blocked: readonly ProviderId[]
  /** Across every `PROVIDER_IDS` default row in `providerRows`, plus every registered account:
   *  is ANYTHING authorized at all? */
  anyConnectedAnywhere: boolean
  /** Narrower, and the one that decides whether a fallback could exist: is any ENABLED,
   *  profile-capable (`claude`/`codex`) account connected anywhere in the workspace? */
  anyEligibleConnected: boolean
}

export function assessAccountViability(input: ViabilityInput): Viability
```

`candidatesFor` is a table, and every row names the picker it mirrors:

| `req.route` | `req.provider` | `reroutable` | Candidates | Mirrors |
|---|---|---|---|---|
| `{kind:'pool'}` (`pool:*`) | `undefined` | any | every enabled profile-capable account | `poolCandidates` on a provider-less route, via `resolvePoolForDispatch` (`agent-route-select.ts:246-256`) |
| `{kind:'pool'}` (`pool:*`) | set | any | accounts of `req.provider` **only** | `resolvePoolForProvider` (`:311-319`), which forces the candidate set to the pinned provider *even on the wildcard*, by its own docblock |
| `{kind:'pool', provider: p}` | `undefined` | any | accounts of `p` only | `poolCandidates` on a provider-pinned route |
| `{kind:'pool', provider: p}` | set | any | accounts of `req.provider` only | same narrowing as row 2 |
| `{kind:'account', accountId}` | either | **false** | **exactly one account**: the stored account with that id on this provider, or that provider's default when the id names none (`selectProfile`'s own degrade, reproduced by `rerouteExplicitAccountIfLimited`'s `resolvedAgentProfile` at `run.ts:3095-3101`) | sites 7/8, and the setting-off first line of both reroute functions (`run.ts:3083`, `:3161`) |
| `{kind:'account', accountId}` | either | **true** | every enabled profile-capable account | `rerouteExplicitAccountIfLimited`'s candidate set (`run.ts:3107-3109`), `downgradePinnedRunner`'s (`:3164-3171`) |

The account-route rows are the fix: with fallback off, an explicit route tests **that one account**
and nothing else, so a healthy same-provider sibling cannot satisfy a gate for a dispatch that is
going to run on the disconnected account the route names.

Four properties are contractual, and each has a test:

1. **Read-only.** It reads the accounts store, the usage store and the auth cache. It **never**
   calls `resolvePoolForDispatch`, never calls `recordDispatch`, and therefore never advances the
   round-robin cursor. This is the reason it is a separate function rather than "just ask the picker
   twice": `resolvePoolForDispatch` moves the fairness cursor as a side effect
   (`agent-route-select.ts:266-268`), so a gate that consulted it would silently skew the balancer
   on every page action.
2. **No spawns.** `auth` is a peek (Solution 1). Calling `assessAccountViability` costs two JSON
   reads and no CLI process.
3. **`placeable` is an AND over requirements, and it is the gate's whole question.** The gate may
   allow an action **only** when every one of its dispatches has a runnable or waitable candidate
   inside that dispatch's own candidate set. Because `candidatesFor` reproduces the picker's rules
   per requirement rather than approximating them over providers, gate and dispatch cannot disagree
   about a `pool:*` workspace with the setting off, nor about an explicit route with a healthy
   sibling, the two cases earlier drafts got backwards in opposite directions.
4. **Reroutable steps may share one fallback; non-reroutable ones may not borrow each other's.**
   Two reroutable requirements whose only viable candidate is the same `codex:default` are both
   placeable, and correctly so: they dispatch at different moments and an account is not consumed
   by being chosen. A non-reroutable requirement is placeable only from its own single candidate.

`providerActionError` then gains a reroutable/pinned distinction:

- **Reroutable sites (1, 4, 5, 6, 9, 10).** After the fresh re-probe, and after the existing
  `poolHasConnectedAccount` same-provider check, one more rung: `assessAccountViability(...).
  placeable`. If true, return `null` and let the action proceed. Dispatch is now competent to land
  it somewhere real.
- **Pinned sites (7, 8).** Unchanged. See below.
- **Site 2 (`/plan`) and site 3 (`/messages`)** are not simple relaxations; see Solution 4b and
  Solution 4c.
- **The terminal case is THREE cases, and they must not share a sentence.** `placeable === false`
  has three genuinely different causes, and telling a user "no agent provider is authorized" when
  they have a healthy Codex login and merely switched fallback off is a new lie replacing an old
  one. So is telling them that when their **OpenCode** login is connected: `opencode` and `pi` are
  real, connectable providers (`PROVIDER_IDS` is `['claude', 'codex', 'opencode', 'pi']`,
  `provider-auth.ts:7`) that simply cannot carry accounts, because their credentials do not follow
  a config dir (`PROFILE_ENV_VAR` maps both to `null`, so `PROFILE_CAPABLE_PROVIDERS` is
  `['claude', 'codex']`, `agent-profiles.ts:40-51`). An earlier draft of this spec derived
  `anyConnectedAnywhere` from profile-capable accounts alone and then printed a sentence about
  *every* provider, which is false on a box with OpenCode connected. Two fields, three sentences:
  - `anyConnectedAnywhere === false`, computed over **every `PROVIDER_IDS` default row** in
    `providerRows` plus every registered account → **`'No agent provider is authorized. Connect one
    in Settings → Agents → Providers.'`** Reserved for exactly this: nothing enabled and connected
    anywhere, on any provider, capable or not. It is the only case where that sentence is true.
  - `anyConnectedAnywhere === true` but `anyEligibleConnected === false`, i.e. the only connected
    providers are ones cezar cannot move work onto → **`'<Provider> credentials are unavailable,
    and no account cezar can move this to is authorized. Authorize it in Settings → Agents →
    Providers.'`** This is the connected-OpenCode-or-Pi case, and it deliberately does not mention
    the fallback switch, because turning it on would change nothing.
  - `anyEligibleConnected === true` but nothing in the blocked requirement's own candidate set is
    placeable → **`'<Provider> credentials are unavailable, and account fallback is off. Authorize
    it in Settings → Agents → Providers, or turn on Account fallback in Settings → Resources.'`**
    It names the provider that is actually blocked and the switch that would unblock it, which is
    the information the user needs. `<Provider>` is `viability.blocked[0]`, the first
    **unplaceable** requirement's provider in `PROVIDER_IDS` order, which is a correction: the
    first `required` entry (what `unavailableProviderMessage` picks today,
    `provider-action-gate.ts:57-71`) can name a provider that was perfectly fine when a later
    pinned step is the one with nowhere to go.
- **A disabled `required` provider stays terminal, unchanged.** `providerActionError` returns the
  existing `'<Provider> is disabled. Enable it in Settings → Agents → Providers.'` before any of
  this, exactly as it does today (`server.ts:1528-1531`, the deliberate no-re-probe branch).
  Rerouting away from a provider the user switched off is **out of scope for this spec**: see
  "Explicitly out of scope". Enablement still enters `ViabilityInput`, but only in the negative
  direction, to keep a disabled provider out of the candidate set.
- **The runtime auth latch is not escaped, and it becomes per-account.** `withRuntimeFailures`
  (`core/provider-auth.ts:467-480`) keeps forcing a provider's **default** row disconnected until
  the user acknowledges the incident, and a latched default therefore reads as `disconnected`
  here: cezar will not route **to** it. It just no longer stops the task from running elsewhere.
  The new per-account `runtimeRejections` overlay (Solution 1) extends the same protection to
  non-default accounts, which have none today, and confines it to the account that was actually
  rejected rather than every account of that provider.

**The outcomes that were previously unstated**, spelled out because they are where the tiering
earns its keep:

| Required provider | Route | Other connected accounts | Setting | Gate | What happens |
|---|---|---|---|---|---|
| logged out | any | one runnable, same provider | either | `null` | run starts on the sibling account, note names both ends |
| logged out | `pool:*` | one runnable, **other** provider | **on** | `null` | run starts there, note names both ends |
| logged out | `pool:*` | one runnable, **other** provider | **off** | `null` | **still starts there.** A wildcard pool already crosses providers with the setting off (`resolvePoolForDispatch` reads no setting); the gate must not be stricter than the picker. This row is the one an earlier draft got wrong. |
| logged out | explicit account (incl. the implicit `default`) | one runnable, **other** provider | **on** | `null` | run starts there via `rerouteExplicitAccountIfLimited` |
| logged out | explicit account (incl. the implicit `default`) | one runnable, **other** provider | **off** | 409 | `'<Provider> credentials are unavailable, and account fallback is off…'`. Off means "do not move my work off the account I named", and this spec does not reinterpret it. `candidatesFor` returns **that one account**, so gate and dispatch agree. **Not** the "no provider is authorized" sentence: one is. |
| **explicit account, logged out** | explicit `claude:default` | a **healthy `claude:secondary`** | **off** | 409 | the sibling does **not** rescue it. With fallback off nothing moves the run off the account the route names, so a gate that scoped to the *provider* would say yes and dispatch would then spawn the dead default. This is the row that makes `candidatesFor` return one account rather than one provider. |
| **explicit account, logged out** | explicit `claude:default` | a healthy `claude:secondary` | **on** | `null` | the reroute's candidate set is every profile-capable account, so it moves to the sibling and the note names both ends |
| **mixed-provider workflow**, one pinned provider wholly logged out (e.g. `spec-to-deploy`'s claude-pinned `spec` step) | any | the other provider healthy | **off** | 409 | every requirement must be placeable, and the pinned one is not. A global "something is placeable" would pass here and then die nine steps in. |
| mixed-provider workflow, one pinned provider wholly logged out | any | the other provider healthy | **on** | `null` | the pinned step is reroutable, `downgradePinnedRunner` moves it, the note and the metric say so |
| logged out | any | **only waitable** in scope (every in-scope connected account limited) | either | `null` | run is admitted and **parked on the best waitable account**, exactly as an all-limited workspace parks today; it starts when the window opens. It is not refused, and it does not spawn a logged-out CLI. |
| logged out | any | none connected anywhere, on any of the four providers | either | 409 | `'No agent provider is authorized…'`, `anyConnectedAnywhere === false`, the only case where that sentence is true |
| logged out | any | **only OpenCode (or Pi) connected**, no claude/codex account anywhere | either | 409 | `'<Provider> credentials are unavailable, and no account cezar can move this to is authorized…'`. `anyConnectedAnywhere === true`, `anyEligibleConnected === false`. Neither of the other two sentences is true here: something *is* authorized, and the fallback switch is irrelevant because `opencode`/`pi` cannot carry accounts and never enter a candidate set. |
| **connected**, secondary logged out | `pool:*` | the default is healthy | either | `null` | unchanged at the gate; Phase 1 changes **dispatch**, which stops selecting the dead pool member. See Phases. |
| connected, limited | any | anything | either | `null` | untouched: today's hold path, no credentials logic involved |
| **disabled** | any | anything | either | 409 | `'<Provider> is disabled…'`, unchanged, out of scope |

### 3. The two sites that keep blocking

Site 7 (`POST /api/v1/runs/:id/open-in-cli`, the "Terminal" button, handler at `server.ts:5491`) and
site 8 (`POST /api/v1/runs/:id/open-in` with a CLI target, handler at `server.ts:5533`, gate at
`:5612`) spawn *that provider's own CLI binary* to reattach to a session that lives inside *that
account's config dir*. There is no `POST /runs/:id/handoff` route; an earlier draft of this spec
named one. The only `handoff` routes are `/runs/:id/handoff/resolve` (`server.ts:5232`) and
`/runs/:id/handoff/skip` (`server.ts:5242`), neither of which is a provider gate.
`resumeCommand(run.runner, sessionId)` and `handoffEnv(run.runner, sessionStep.profileId)`
(`server.ts:5514-5518`) are not choices, they are the identity of the thing being opened. There is
no "auto" for them to fall through to: opening Codex would open a different, empty conversation.
They keep the per-provider message verbatim, and this is stated here so the next reader does not
"finish the job" by changing them.

This is also the answer to the brief's open question 3. The general rule is **the pin is respected
when it is a capability, overridden when it is a preference**, which is not a new rule: it is the
one `2026-08-23-never-block-a-task.md` already applied to quota, where an `opus`-pinned spec step
downgrades loudly rather than dying. Sites 7 and 8 are the only two of the ten where the pin is a
capability.

### 4. Dispatch stops picking a dead account

Gate changes alone would be a **regression**, not a fix: the run would start, spawn the logged-out
CLI, fail with a raw auth error, write a failed record and arm an auto-resume. A 409 that says what
is wrong beats that. So dispatch learns credentials **first** (Phase 1), and the gate is relaxed
only once dispatch can keep the promise (Phase 2). Phase 1 is not merely preparation, though: on its
own it already stops a pool from selecting a logged-out **non-default** member, which the gate never
saw and cannot see (see Phases).

- `rerouteExplicitAccountIfLimited` becomes `rerouteExplicitAccountIfUnavailable`
  (`run.ts:3075-3139`). The early exit at `run.ts:3104` (`if (!isLimited(...)) return undefined`)
  becomes "the pinned account is `runnable`, nothing to do". The candidate filter at
  `run.ts:3106-3108` partitions into the three tiers instead of filtering on `isLimited`, and
  `selectPoolAccount` is offered the `runnable` set. A `disconnected` account is in neither
  selectable set, so it can no longer be chosen. Note text becomes cause-aware (`is out of quota` /
  `is logged out`). Renaming a private method is free; it is not a public surface.

  **`undefined` is NOT safe when the current account is disconnected, and an earlier draft of this
  spec said it was.** Returning `undefined` today means "leave the run where it is", and the caller
  acts on that literally:

  ```ts
  // run.ts:5096-5103, current code
  const rerouted = pooled ?? (await this.rerouteExplicitAccountIfLimited(runId, input, config.defaultRunner))
  const chosen = pooled ?? rerouted                       // undefined when the reroute declined
  const taskBackend = chosen?.provider ?? input.runner ?? config.defaultRunner
  if (this.requeueWhileHeld(runId, workflow, input, taskBackend, undefined, chosen)) return
  ```

  `requeueWhileHeld` then hits its `resolved ? … : runAccountKey({...run, runner}, runner)` branch
  (`run.ts:3399-3401`) and rebuilds the key **from the disconnected account the record names**.
  `accountHeldOn` finds no *quota* hold on it, being logged out is not a hold, returns `false`,
  and the run proceeds to spawn the logged-out CLI. The hold path is keyed on quota and always was;
  it cannot park a run on a credentials problem it has never heard of, and Solution 1's ruling that
  `heldAccountFor` must not learn about credentials is what keeps it that way.

  **So the contract changes:** when the current account is `disconnected` and the `runnable` set is
  empty, this returns **the best `waitable` account**, chosen by `selectPoolAccount` over the
  `waitable` partition, rather than `undefined`. In `execute()` that choice flows into `chosen`, so
  `requeueWhileHeld` builds its key from the **waitable** account, finds the real quota hold on it,
  parks the run there, and `heldAtSpawn` / `noteHeld` name that account. The user sees "waiting on
  `codex:default`", which is true, instead of a failed turn against a login nobody can use.

  **A bare `PoolChoice` is NOT enough, because one of the two callers has no `requeueWhileHeld`
  behind it.** `execute()` calls this and then immediately calls `requeueWhileHeld`
  (`run.ts:5096-5103`), which is the thing that turns a waitable choice into a park.
  `runContinuation` calls the SAME function (`run.ts:4336-4339`) and does nothing of the kind: it
  writes `runner`/`agentProfile` onto the record from the choice (`:4362-4366`), sets
  `continueBackend = rerouted?.provider ?? backend` (`:4374`), registers the run as active
  (`:4381-4383`) and **spawns**. Hand it a waitable account and it starts a turn on a login that is
  out of quota, which is a different bug of the same family. So the return value is tagged:

  ```ts
  type Placement =
    | { tier: 'runnable'; choice: PoolChoice }   // safe to spawn on, right now
    | { tier: 'waitable'; choice: PoolChoice }   // the caller MUST NOT spawn: park on this account
    | undefined                                  // nothing to do, or nowhere to go
  private async rerouteExplicitAccountIfUnavailable(...): Promise<Placement>
  ```

  `execute()` passes `placement?.choice` into `requeueWhileHeld` exactly as it passes `chosen`
  today, so the waitable case parks with the right key and the runnable case starts. **The tag is
  not decorative there either:** with `tier: 'waitable'` and no quota hold yet recorded against
  that account, `accountHeldOn` would answer `false` and `execute()` would spawn on it, so
  `execute()` treats `tier: 'waitable'` as an unconditional park, calling
  `holdRunOnAccount(runId, workflow, input, choice)` (the body of `requeueWhileHeld` from
  `state?.releaseRepoRoot?.()` down, extracted so both the hold-found path and this one share one
  implementation) rather than relying on the hold lookup to agree.

  `runContinuation` gets an explicit no-spawn path, `parkContinuationOnAccount(runId, stepId,
  choice)`, which is the **`deferForCapacity` branch of `continueRun` verbatim**
  (`run.ts:4236-4254`) plus the hold bookkeeping `requeueWhileHeld` does:

  ```
  pendingContinuations.set(runId, {stepId, sessionId, backend: choice.provider, prompt, images, …})
  queue.push(runId)
  store.updateRun(runId, {status: 'queued', error: undefined, finishedAt: undefined,
                          currentStepId: undefined})
  heldAtSpawn.set(runId, accountUsageKey(choice.provider, choice.accountId))
  noteHeld(runId, <that key>)
  starting.delete(runId); return          // <- returns BEFORE this.active.set and before any spawn
  ```

  That reuse is the argument for it: the continuation-defer shape is already the supported way to
  put a continuation back in the queue with its step already added, `pump()` already re-hydrates it
  (`run.ts:1856-1871`), and `heldAtSpawn` is what stops admission from immediately re-dequeuing it
  (`heldAccountFor`, `run.ts:2006`). Nothing new is invented; two existing mechanisms are joined.

  The return cases, stated exhaustively because this is the subtle one:

  | Current account | `runnable` in scope | Returns | `execute()` | `runContinuation` |
  |---|---|---|---|---|
  | `runnable` | n/a | `undefined` | nothing to do, today's cheap exit | unchanged |
  | `waitable` (out of quota) | non-empty | `{tier:'runnable', choice}` | starts there, note names both ends (today's behaviour) | resumes there (today's behaviour) |
  | `waitable` | empty | `undefined` | today's behaviour exactly: the record's own account is held, `requeueWhileHeld` finds that hold and parks | today's behaviour exactly |
  | **`disconnected`** | non-empty | `{tier:'runnable', choice}` | starts there, note says logged out | resumes there, note says logged out |
  | **`disconnected`** | empty, `waitable` non-empty | **`{tier:'waitable', choice}`** | `holdRunOnAccount` parks it on that account, **zero spawns** | `parkContinuationOnAccount`, **zero spawns** |
  | **`disconnected`** | empty, `waitable` empty | `undefined` | nowhere to go; the gate (Phase 2) has already refused, and dispatch fails honestly rather than inventing a destination | same |
- `downgradePinnedRunner`'s `open` filter (`run.ts:3165-3171`) becomes the `runnable` partition, and
  its `reason: 'quota'` metric field (`run.ts:3196`) becomes
  `'quota' | 'credentials' | 'quota+credentials'`, which is what that field's own comment
  (`run.ts:3190-3195`) says it was declared for. `'credentials'` is used when every account of the
  pinned provider is `disconnected`; `'quota'` when every one is `waitable`; `'quota+credentials'`
  for a mix.

  **It must also stop throwing away the account it picked.** Today the last line is
  `return choice.provider as RunnerId` (`run.ts:3204`): `choice.accountId` is used in the note and
  the metric and then **discarded**. The caller does
  `const backend = (pinned ? await this.downgradePinnedRunner(...) : undefined) ?? step.runner ?? taskBackend`
  (`run.ts:6342`) and passes only that provider to `agentEnvForStep` (`run.ts:6618`), which
  re-derives the account by its own rules (`run.ts:1461-1470`): `recordedProfileId`, else
  `resolvePoolForProvider` for a pool route, else `run?.agentProfile`, else `selectProfile`'s
  default-login fallback. Every one of those can land on a **different** account from the one the
  note just told the user about, including the provider's disconnected default when the route is
  not a pool. The note would say "running on `codex:kontakt-…`" while the step ran on
  `codex:default`, which is the same class of lie the `resolvePoolForProvider` fix
  (KB `notion-4dee7a4df2f1`) was written to end.

  **Change:** the return value carries provider **and** account together, `profileId` being
  `choice.accountId` or `undefined` when the choice IS that provider's default. (The full
  signature, which also carries the tier, is in the next block.)

  The caller threads both: `stepBackend` from `.runner` as today, and `.profileId` into
  `agentEnvForStep`'s `recordedProfileId` **and** into `updateStep(runId, step.id, {backend,
  profileId})`, so the step record, the env, the note and the metric all name one account. The note
  and the `actualRunner`/`actualAccount` fields are derived from that same value rather than
  computed twice. `recordedProfileId` is the existing option and already short-circuits the
  `resolvePoolForProvider` re-derivation (`run.ts:1461-1463`), so this is a thread-through, not a
  new resolution path, and it composes correctly with a resume, where `resumeFrom.profileId` wins
  because a session belongs to the login that created it.

  **A later pinned step needs the same no-spawn transition, and it has no queue to go back to.**
  `downgradePinnedRunner` is called from `runAgentStep` at `run.ts:6342`, mid-run: by then the run
  has a worktree, probably a session, and possibly six finished steps, so "hand it back to the
  queue untouched" is not available and would be a lie about what has happened. Today the
  equivalent quota case works because it does not need a transition at all: the step runs on the
  limited account, the provider says "usage limit, back at T", and `scheduleAutoResumeIfLimited`
  (`run.ts:2985-3018`) arms the appointment from the provider's own words. **A logged-out CLI
  never produces those words**, so nothing arms anything and the run just fails.

  So `downgradePinnedRunner` returns a tagged placement too, and the mid-run waitable case takes
  an explicit hold:

  ```ts
  private async downgradePinnedRunner(
    runId: string, step: {id: string; model?: string}, pinned: RunnerId,
  ): Promise<
    | { tier: 'runnable'; runner: RunnerId; profileId?: string }
    | { tier: 'waitable'; runner: RunnerId; profileId?: string }   // caller MUST NOT spawn
    | undefined
  >
  ```

  On `tier: 'waitable'`, `runAgentStep` calls `holdStepOnWaitableAccount(runId, step, choice)`
  instead of proceeding, and that function:

  - appends a note naming both ends and the cause: `` `this step asks for ${pinned}, and every
    ${pinned} account is logged out; the best account cezar can move it to
    (${accountUsageKey(...)}) is out of quota, so this task waits for that window` ``;
  - `armAutoResume(runId, (holdReopensAt(key) ?? new Date(Date.now() + ASSUMED_LIMIT_COOLDOWN_MS))
    .getTime())`, so there is a real published instant. `holdReopensAt` (`run.ts:2030-2040`) reads
    the soonest scheduled resume already recorded against that account and returns `null` when
    there is none, which is why the `ASSUMED_LIMIT_COOLDOWN_MS` floor (`agent-account-usage.ts:64`,
    one hour, the same constant the limit path already falls back to) is applied here rather than
    leaving the run with no appointment;
  - marks the run `failed` with a stated error, which is the status `fireAutoResume` requires
    (`run.ts:3242`, `run.status !== 'failed'` returns early) and the status the whole auto-resume
    machinery is built around;
  - **returns without spawning anything.** No `createRunner`, no `agentEnvForStep`, no session.

  The run then resumes through `fireAutoResume` → `continueRun` like any other parked run, and the
  reroute runs again on the way back in with whatever the world looks like then. V1 asserts zero
  runner invocations for this transition, on the pinned provider **and** on the waitable one.
- `resolvePoolForDispatch` / `resolvePoolForProvider`
  (`packages/cezar/src/workspace/agent-route-select.ts:255-330`) gain an optional
  `tier?: (profile) => AccountTier` classifier, defaulted to "everything connected" so the current
  quota-only behaviour is bit-for-bit preserved when nothing is injected. The pool picker ranks
  within `runnable`, falls back to `waitable`, and skips `disconnected` outright.
- `heldAccountFor` (`run.ts:1973-2010`) is **not** changed and must not be. It is synchronous, runs
  per pump sweep, and its docblock records the 2626-note write storm that followed the last time
  something resolved accounts there. A `disconnected` account is kept out of the hold set upstream,
  by never being selected in the first place, not by teaching admission about credentials.
- **The `while-limited` guard rails are preserved exactly.** `downgradePinnedRunner` stays keyed on
  **every** account of the pinned provider being unusable, never one (`run.ts:3172`);
  `selectPoolAccount` still answers when everything is limited, and the callers still refuse an
  empty candidate set rather than detouring somewhere no better (`run.ts:3109-3116`).
- **Same setting, same off-switch, and the same scope it has today, which is not "everything".**
  The two functions that read `resources.fallbackAcrossAccountsWhenLimited` today
  (`rerouteExplicitAccountIfUnavailable`, `downgradePinnedRunner`) keep reading it, and off
  restores today's behaviour for both causes. The two that do **not** read it
  (`resolvePoolForDispatch`, `resolvePoolForProvider`) still do not: a pool is the user asking to
  be balanced, and per KB `notion-4dee7a4df2f1` that has never needed the setting. The tier
  classifier reaches all four, so a pool stops selecting a disconnected member **regardless of the
  setting**, which is Phase 1's one user-visible effect (see Phases). `candidatesFor` reproduces
  exactly this split, per requirement, so the gate refuses in exactly the cases dispatch would not
  move, and in no others.

### 4b. The planner picks its own account, because nothing picks one for it

`planChain` is the one gated action with **no dispatch layer behind it at all** (see "The ten call
sites", site 2). Relaxing site 2's gate without this would trade a 409 for a silently degraded
one-step plan, which is worse: the 409 at least says why.

`planChain(repoRoot, task)` today does, at `planner.ts:66-72`:

```ts
const runner = createRunner(config.defaultRunner)
const plannerModel = config.defaultRunner === 'claude' ? config.plannerModel : undefined
const { env: profileEnv } = await resolveProfileEnvForRoot(repoRoot, config.defaultRunner)
```

Three facts are derived from `config.defaultRunner` and must move together: the runner, the
model alias, and the **profile env**. Picking a provider without repicking the account would run
Codex under a Claude account's `CLAUDE_CONFIG_DIR`, and picking an account without repicking the
model would pass `plannerModel` (`"sonnet"`, a Claude alias) to Codex. So the change is a single
resolution step, not three independent ones:

```ts
// planner.ts, new optional seam, default preserves today's behaviour exactly
export interface PlannerAccountChoice { provider: ProviderId; profileId?: string; env: Record<string,string> }
export async function planChain(
  repoRoot: string,
  task: string,
  chooseAccount?: (repoRoot: string, preferred: ProviderId) => Promise<PlannerAccountChoice>,
): Promise<PlanResult>
```

- Default (`chooseAccount` omitted): byte-identical to today. Every existing caller and test is
  unaffected.
- The `/plan` route injects a chooser backed by `assessAccountViability`: prefer a `runnable`
  account on `config.defaultRunner`, then any `runnable` account in the planner requirement's own
  `candidatesFor` set, then `undefined` (which keeps today's behaviour and lets the fallback plan
  happen).

**Site 2's gate is therefore NOT `placeable`, and an earlier draft of this spec had it wrong.**
`placeable` is true when a `runnable` **or** a `waitable` candidate exists, and the chooser above
accepts only `runnable` ones. Gate `/plan` on `placeable` in a workspace whose default provider is
logged out and whose every alternative is out of quota, and the sequence is: the gate relaxes, the
chooser returns `undefined`, `planChain` falls back to `createRunner(config.defaultRunner)`, the
logged-out CLI is spawned, `runner.run` throws, the `catch` at `planner.ts:82` breaks the loop, and
the user gets the degraded one-step `fallback: true` plan (`planner.ts:96-100`). That is strictly
worse than today's 409, which at least says why.

**So the gate for site 2 asks the chooser's own question:** *can an immediate `runnable`
`PlannerAccountChoice` be produced right now?* Concretely,
`viability.requirements[0].runnable.length > 0` for the planner's single requirement, which is the
same predicate the injected chooser applies, evaluated once and handed to the route. When it is
false the route keeps a credential refusal, the three-message rule from Solution 2, so `'No agent
provider is authorized…'` when `anyConnectedAnywhere` is false, the
no-account-cezar-can-move-this-to sentence when only OpenCode or Pi is connected, and the
fallback-disabled sentence otherwise. A `waitable`-only workspace refuses `/plan` today
and keeps refusing it, which is consistent with the planner having no hold path at all: there is
nothing for a plan to park on, and a composer that hangs for an hour is not a better outcome than a
sentence. This is the one place in the spec where `placeable` is deliberately not the gate, and
V8 pins it.
- `plannerModel` is passed only when the **chosen** provider is `claude`, not when the configured
  default is (`planner.ts:67`).
- The planner does **not** get a `waitable` fallback. A plan is a sub-second interactive request,
  not a run; parking it on an appointment would hang the composer. When only `waitable` accounts
  exist, the planner behaves exactly as it does today.

### 4c. Live messages are delivered before credentials are consulted

Site 3's handler (`server.ts:5254-5330`) has two gates, and they need opposite treatment.

**The first gate (`server.ts:5266`) moves, it does not relax.** Today it runs before
`manager.sendMessage(id, content)` (`:5282`), so a logged-out provider refuses a message bound for
an already-open session. There is no account to choose there: the session is a live process. The
handler's own comment already draws this line for the `queued` case (`:5264-5268`, "Stacking onto a
queued prompt mutates an existing task and invokes no provider"), and a live session is the same
category. So the ladder runs first:

1. `manager.sendMessage(id, content)` succeeds → `{ delivered: true }`, **no credential check at
   all**. Delivering into a process that is already running cannot be blocked by the state of a
   login it is not going to use.
2. still `queued` → folded into the prompt, unchanged.
3. `manager.deferMessage(...)` (starting-up buffer) → `{ deferred: true }`, unchanged.

**The second gate (`server.ts:5291`) is the real one, and it gets the fallback.** The reopen branch
(`currentRun?.status === 'waiting' && !manager.isActive(id)`) is followed by
`manager.continueRun(id, ...)`, which is a genuine dispatch and already goes through
`rerouteExplicitAccountIfLimited` via `runContinuation`
(`.ai/specs/2026-08-24-continuation-reroute-held-account.md`). This gate becomes reroutable: it
allows the reopen whenever `assessAccountViability(...).placeable`, and `continueRun` places it.

The net user-visible effect is two different fixes that used to look like one: a live conversation
stops being interruptible by an unrelated login going stale, and a parked conversation reopens on
whatever account is actually available.

### 5. The config key is NOT renamed, and that is deliberate

`resources.fallbackAcrossAccountsWhenLimited` now governs more than limits, so its name is
imperfect. It stays anyway. `cezar` is one of the two repos on the standing backward-compatibility
exception (its own `BACKWARD_COMPATIBILITY.md`: a published npm CLI whose state is plain files in
users' repos, where "anything that makes an existing input rejected... is breaking" and a breaking
change needs a deprecation note, a migration path and a called-out minor bump). Renaming the key
would silently reset every user who turned it **off** back to **on**, which is precisely the class
of harm that exception exists to prevent, in exchange for a tidier identifier.

What changes instead is what it *says*: the Settings label
(`packages/web/src/routes/settings/resources-section.tsx:107-109`) and the docblocks become
"Account fallback: route around an account that is out of quota **or logged out**". The house rule
against compatibility hedges is not in tension here, because that rule names this repo as its
exception.

### 6. The client stops deciding, because it cannot

An earlier draft of this spec had the client compute `anyProviderPlaceable(status)`, a disjunction
over the status rows, and gate the composer on it. That is wrong in **both** directions, and the
reason is structural rather than a bug in the predicate:

- **It blocks valid work.** Every row can be `disconnected` while a live session is open and happily
  accepting messages. Under Solution 4c, `POST /runs/:id/messages` delivers into that session with
  no credential check at all, because there is no account being chosen. A workspace-wide "nothing is
  connected" would disable the composer for a conversation the server would answer `{delivered:
  true}` for.
- **It enables work the server refuses.** `anyProviderPlaceable` is an aggregate over provider
  status. It has no access to the project's stored route (`selectionFor(accounts, repoRoot, …)`),
  no access to the run's `agentProfile`, and therefore cannot build a `DispatchRequirement` at
  all, let alone its candidate set. With
  fallback off and an explicitly routed project, the server refuses and the client would have said
  yes. The client would need the accounts store and the project selection to reproduce the rule,
  and the hosted account-identity rules (`agent-config/account-identity.ts:25-32`) exist precisely
  to keep it from having them.

There is no client-side predicate that is right, so the client stops having one.

**The rule: for a reroutable action, the SERVER's answer to the submission is authoritative.**
Provider status stops hard-disabling the composer, and a refusal is surfaced the way every other
`409` on these paths already is: as an error on the attempt, carrying the server's own sentence.
The user can always press send; if the workspace really has nothing authorized, they get the true
message once, from the one component that can compute it.

Concretely, in `packages/web/src/routes/task-thread/`:

- **`thread-composer.tsx:49`**, `const activeProviderBlocked = sessionOpen && !activeProvider.usable`
  → **removed**. Live composition is enabled regardless of auth state, which is the client half of
  Solution 4c: a message into an open session invokes no provider. The `queued` case is already
  unblocked for exactly this reason and the comment at `:46-48` already states the principle; this
  extends it to `sessionOpen`, which the same comment's last sentence ("Once the session is open,
  mirror the server's active-backend gate as before") is what now changes.
- **`continuationProviderBlocked`** (`thread-composer.tsx:50`) → also removed as a *hard* block.
  A continuation is reroutable (site 4/5), so the server decides. `continueAction.reason` remains
  available for an advisory line.
- **`ask-answer.ts:113-116`**, `providerBlocked` for the `live` and `resume` modes → removed for the
  same two reasons, in the same order.
- **`providerAvailability`** (`active-provider.ts:31-51`) is **kept, unchanged, and keeps its exact
  strings**, but an earlier draft of this spec was wrong about who calls it, and the correction
  changes what this spec is allowed to claim. It does **not** gate the Terminal or Open-in-CLI
  controls, and never did. Its only callers are `activeProviderAvailability` and
  `existingProviderAvailability` (`active-provider.ts:53-65`), reached from the composer and the
  ask/continuation hooks (`useActiveProviderAvailability` `:68`, `useExistingProviderAvailability`
  `:80`). `OpenInMenuForRun` (`run-header.tsx:316`) computes its own `agentAvailable` from
  `usableRunners(providers.data)` (`:330-333`), a different predicate on a different data path.
  So once the composer gates go, `providerAvailability`'s remaining consumers are **advisory**:
  `continueAction.reason` as a hint line, and nothing that refuses. Any retained use is described
  that way in this spec, and must not be attributed to a button that never called it.
- **Sites 7 and 8 are enforced authoritatively by their SERVER 409 checks, and only by them.**
  `POST /runs/:id/open-in-cli` (gate `server.ts:5510`) and `POST /runs/:id/open-in` (gate `:5612`)
  are the gate for the two pinned actions, which is what V4 pins byte-for-byte on the server side.
  The client side of those controls is a **best-effort hide**, not a guarantee, and this spec
  deliberately does not try to make it exact, because it cannot be: `usableRunners` reads one row
  per provider (`provider-status.ts:152-161`) and knows nothing about which account owns the run's
  recorded session, so no client predicate over `ProviderStatusResponse` can answer "is THIS
  session's account authorized". The failure it can produce is an offered menu entry that the
  server then refuses, with the server's own sentence in the toast, which is strictly better than
  the reverse.
- **Error surface.** The composer renders the server's `error` string from the failed submission.
  No new copy is invented client-side: the three terminal sentences are decided in "Message copy,
  decided" and arrive over the wire, so client and server cannot say different things.

**What is lost, honestly:** a user with nothing connected now discovers it on send rather than on
render. That is the trade, and it is the right way round, the previous behaviour discovered a
*false* refusal on render, which is the reported bug. The Settings banner and the provider dots
still show the real state before anyone types.

**`poolConnected` is retained, but ADVISORY only.** `GET /api/v1/providers/status` answers exactly
one row per provider, the discovered default (`packages/contract/src/workspace.ts:450-454`), so a
connected non-default account is invisible to the cockpit today: the engine picker and the Settings
dots show `claude` as disconnected while `claude:secondary` is fine. The row carries the fact so
those surfaces stop lying, and **nothing gates on it**:

`providerStatusSchema` (`packages/contract/src/workspace.ts:444-455`) gains
`poolConnected: z.boolean().optional()`, meaning "this provider has at least one **non-default**
account that is connected". It is an aggregate boolean on purpose: it answers the routing question
without naming a single account, so it leaks nothing the hosted account-identity rules
(`agent-config/account-identity.ts:25-32`) protect. The route keeps one row per provider, so the
shape is unchanged and the change is additive, which the compatibility contract permits without
ceremony.

**Where it is allowed to be read, exhaustively.** Two rendering sites, no gates:

- `usableRunners` (`packages/web/src/lib/provider-status.ts:152`), the engine picker stops greying
  out a provider that has a healthy non-default login. Choosing a greyed provider was already
  possible via the API; this only makes the picker agree with it.
  **Accepted consequence, stated here rather than discovered later:** `usableRunners` is also read
  by `OpenInMenuForRun` (`run-header.tsx:330`), so a pool-aware `usableRunners` will offer Terminal
  and Open-in-CLI for a run whose provider row is `disconnected` while some **other** account of
  that provider is connected, including when the session-owning account is the dead one. That is a
  menu entry that may be refused on click, and it is deliberate: the alternative is a client
  predicate that pretends to know which account owns the session, which it cannot. The server's
  `409` stays authoritative, the toast carries its sentence verbatim (`open.onError`,
  `run-header.tsx:322-324`), and V3 asserts the offered-then-refused shape rather than asserting
  the control is hidden.
- the Settings → Agents provider dots and the `picker-pill.tsx` advisory note (`:162,219`), a
  provider reads as available when `row.status === 'connected' || row.poolConnected === true`.

**There is deliberately no `anyProviderPlaceable`.** No client function may combine rows into a
submit/refuse decision, for the reasons at the top of this section. A reviewer who finds one being
reintroduced should read this paragraph as the objection.

**How `poolConnected` becomes correct from a cold cache, including hosted.** Advisory or not, a
field that is permanently `undefined` in the deployment that runs this cockpit is not worth the
schema change, and today's warm-up does not cover it:

- `warmAgentKnowledge` (`server.ts:2437-2447`) awaits `providerAuth.status()` for the defaults and
  then **returns early when `!capabilities().localHandoff`** (`server.ts:2439`). On a hosted box
  (`CEZ_REMOTE=1`, or a non-loopback bind, `capabilities.ts:261`) no non-default account is ever
  probed. `peekProfileStatus` never probes by design (`core/provider-auth.ts:582-586`), so
  `poolConnected` computed purely from peeks would be permanently `undefined` in hosted mode, which
  is exactly the deployment this cockpit runs in.
- **Change:** the non-default warm loop stops being gated on `localHandoff` and becomes gated on
  "there are registered non-default accounts". The comment at `server.ts:2434-2435` ("Hosted mode
  warms only the defaults: the agent-profiles family is refused there, so there are no accounts to
  learn about") is stale on a box running `CEZ_AUTO_ACCOUNTS=1`
  (`.ai/specs/2026-08-24-second-codex-account-balancing.md`, D5): `autoAccountsSweep` registers
  discovered logins there, and it already runs before the warm (`server.ts:2480`). Warming what the
  sweep just registered is the smallest change that makes hosted correct, and it stays sequential
  and fire-and-forget, so the spawn-storm reasoning in that same docblock is untouched.
- **Belt and braces:** `GET /api/v1/providers/status?refresh=1` (`server.ts:2629`) also refreshes
  registered non-default profile status before answering, so a user who clicks "Check again" repairs
  a cold aggregate without a restart. The unrefreshed `GET` stays peek-only and pays nothing, which
  is the posture `peekProfileStatus`'s docblock defends.
- **Cold means absent, not false.** When nothing is known, `poolConnected` is **omitted**, and the
  client reads `undefined` as "no pool information" and falls back to today's per-row rule. It is
  never serialized as `false` on an unprobed provider, because a `false` the client trusts would
  grey out a working provider in the picker on the strength of a cache that was simply empty.

**SSE merge rules**, both of which are easy to get wrong and are pinned by V3:

- `packages/web/src/lib/provider-status.ts`'s `parseProviderStatusRow` (`:12-43`) **rebuilds rows
  from known keys and silently drops the rest**, so it must learn `poolConnected` or the client will
  never see it, and `sameProviderStatusRow` (`:144`) must compare it or the merge at `:135` will
  treat a change as a no-op.
- An incoming SSE row **without** `poolConnected` must **preserve** the previously cached aggregate
  rather than clearing it. The `provider-status` topic is emitted by paths that only know about the
  default row (`PUT /providers/:provider/enabled`, `server.ts:2655-2657`; the connect/repoint
  handlers around `server.ts:2995-3089`), so treating "absent" as "no pool accounts" would flicker
  the picker's availability off on an unrelated enable/disable click. `applyProviderStatusRow`
  (`:80`) merges the key only when it is present.
- A **non-default** auth change (connect, repoint, remove, runtime rejection) must recompute and
  publish the aggregate for that provider. Without it, logging a second account in would leave the
  picker greyed until the next full `GET`.

## Architecture

```
                      ┌──────────────── BEFORE ─────────────────┐
  action ─▶ providerActionError(required)        dispatch: reroute/downgrade/pool
              │ knows: connected?                     │ knows: limited?
              │ blind to: limited                     │ blind to: connected
              └─▶ 409 "<Provider> credentials         └─▶ crosses providers freely
                   are unavailable"                        (but is never reached)

                      ┌──────────────── AFTER ──────────────────┐
  action ─▶ providerActionError(requirements, repoRoot)          [server.ts closure]
              │   requirements: DispatchRequirement[], built BY THE CALL SITE
              │   from the values that site will actually dispatch with
              │
              ├─ any requirement's provider DISABLED? ───────▶ 409  (unchanged, terminal)
              ├─ every requirement's provider connected? ────▶ null (unchanged, free)
              ├─ fresh re-probe agrees they are not?          (unchanged)
              ├─ poolHasConnectedAccount(provider)? ─────────▶ null (unchanged)
              ├─ viability.placeable? ───────────────────────▶ null ◀── NEW
              │     = requirements.every(r => r.placeable), and a non-reroutable
              │       requirement is placeable only from its own single candidate
              └─ otherwise ─────────────────────────────────▶ 409
                     nothing connected anywhere  → "No agent provider is authorized…"
                     only opencode/pi connected  → "<Provider> credentials are unavailable,
                                                    and no account cezar can move this to…"
                     eligible but out of scope   → "<Provider> credentials are unavailable,
                                                    and account fallback is off…"
                     non-reroutable (7, 8)       → "<Provider> credentials are unavailable…"
                                                    (byte-identical to today)
                                            │
                                            │ same function, same inputs
                                            ▼
        packages/cezar/src/workspace/account-viability.ts   ◀── NEW, exported, pure
              assessAccountViability({profiles, usage, auth, disabledProviders,
                                      providerRows, requirements})
                → { requirements[{runnable[], waitable[], disconnected[], placeable}],
                    placeable, blocked[], anyConnectedAnywhere, anyEligibleConnected }
              · reads only; never calls resolvePoolForDispatch, never recordDispatch
              · candidatesFor(req) mirrors the picker that will place THAT dispatch:
                  pool:*  , no pin       → every enabled profile-capable account
                  pool:*  , provider pin → that provider only (resolvePoolForProvider)
                  pool:<p>               → p only
                  account , reroutable   → every enabled profile-capable account
                  account , NOT          → exactly the one account the id resolves to
              · auth(p) := rejected(p.provider, p.id) ? DISCONNECTED
                         : p.isDefault ? peekDefaultRowRaw(p.provider)  (NO banner latch)
                                       : peekProfileStatus(p.provider, p.id)
                         ?? UNKNOWN → treated as connected
                                (cache only, never a spawn)
                                            │
                       ┌────────────────────┼────────────────────┐
                       ▼                    ▼                    ▼
              server.ts closure     index.ts headless      RunManager pickers
              (routes 1,4,5,6,9)    (site 10 preflight)    rerouteExplicitAccountIfUnavailable
                                                           downgradePinnedRunner
                                                           resolvePoolForDispatch/ForProvider
                                            │
                                            ▼
                     runnable? ─ yes ─▶ start there, note names both accounts
                        │                metric run.step.runner_downgraded
                        │                reason='credentials' | 'quota' | 'quota+credentials'
                        └─ no ──▶ waitable? ─ yes ─▶ HOLD + appointment (today's path, unchanged)
                                     └─ no ──▶ nothing to do: refuse honestly
```

**Module boundary, and why it is a module.** `providerActionError` is a **closure declared inside
`createApp`** (`server.ts:1520`, inside `export function createApp(deps: ServerDeps)` at
`server.ts:1427`). It captures `providerStatus`, `providerAuth`, `loadAgentAccounts` and
`capabilities` from that scope and is not exported, so `packages/cezar/src/index.ts` **cannot** call
it, and an earlier draft of this spec was wrong to say the headless site could be "brought onto the
same helper". The shared decision therefore lives one level down, in a new module with **no captured
state**:

- `packages/cezar/src/workspace/account-viability.ts` exports `assessAccountViability(input):
  Viability` (pure, everything injected) and `loadViabilityInput(repoRoot, providerAuth, opts)`
  (the two JSON reads plus the peek closure, so callers do not each reassemble it).
- `server.ts`'s `providerActionError` closure stays a closure, and calls
  `assessAccountViability`.
- `packages/cezar/src/index.ts:1031-1044` (site 10) calls the same two functions instead of
  `unavailableProviderMessage` raw. It already constructs a `ProviderAuthService`
  (`index.ts:1026`), so it has everything the input needs.
- `RunManager`'s pickers call `assessAccountViability` too, through the seam below.

Both entry points therefore share one decision function; neither reimplements it. That is the
property V2 and V7 exist to pin.

**The call sites build the requirements, because only they know them.** `providerActionError`
today takes `required: readonly ProviderId[]` and a `repoRoot` and derives everything else. It
cannot: the route is per action, and recomputing it inside the helper from the workspace default
would answer a different question from the one the site is about to ask dispatch. The concrete
case: `POST /runs` may carry `body.agentProfile`, a composer override that has not been stored
anywhere, so a helper that read `selectionFor(accounts, repoRoot, provider)` would gate the
project's route while dispatch resolved the override
(`resolvePoolForDispatch` reads `options.agentProfile ?? selectionFor(...)`,
`agent-route-select.ts:246-249`, in that order). V2 has a case for exactly this.

So the signature becomes
`providerActionError(requirements: readonly DispatchRequirement[], repoRoot?: string)`, and each
site builds its own. `requirementsFor…` helpers live in `provider-action-gate.ts` beside
`providersRequiredByWorkflow`, which stays as-is and becomes their input:

| # | Route / handler | Provider(s) | Route it must pass | Reroutable |
|---|---|---|---|---|
| 1 | `guardRunStart` → `POST /runs`, `POST /workspace/runs` (`server.ts:2562-2572`) | **one RUN-level requirement**, plus **one more per EXPLICITLY PINNED workflow step** (a step whose own `runner` is set), and nothing per unpinned step | run level: `parseAgentRoute(body.agentProfile ?? selectionFor(accounts, root, fallback))`, exactly `resolvePoolForDispatch`'s expression, **override first**, carrying `provider: undefined` when that route is the wildcard `pool:*`; pinned step: `parseAgentRoute(selectionFor(accounts, root, step.runner))` with `provider: step.runner`, exactly `resolvePoolForProvider`'s expression | setting (per requirement) |
| 2 | `POST /plan` (`server.ts:4685`) | `config.defaultRunner` | `parseAgentRoute(selectionFor(accounts, repoRoot, defaultRunner))` | setting; and site 2 gates on `runnable`, not `placeable` (Solution 4b) |
| 3a | `POST /runs/:id/messages`, live delivery (`server.ts:5266`) | none | no gate at all: the ladder runs first (Solution 4c) | n/a |
| 3b | `POST /runs/:id/messages`, reopen branch (`:5291`) | `providerForExistingRun(currentRun, undefined)` | `parseAgentRoute(sessionStep?.profileId ?? run.agentProfile)`, the same pair `runContinuation` resolves (`run.ts:4322-4340`) | setting |
| 4 | `POST /runs/:id/continue` (`:5416`) | `providerForExistingRun(run, parsed.data.runner)` | as 3b, and the **override** `parsed.data.runner` sets `provider` | setting |
| 5 | `POST /runs/:id/agent`, retarget (`:5459`) | `providerForExistingRun(run, target.runner)` | `parseAgentRoute(target.agentProfile ?? run.agentProfile)`: the retarget's own target, not the record's, since `retargetQueuedRun` writes `target.agentProfile` before dispatch (`run.ts:2106`) | setting |
| 6 | `POST /runs/:id/open-in-cli` (`:5510`) | `providerForExistingRun(run)` | `parseAgentRoute(sessionStep?.profileId)`, the account that OWNS the session | **`false`**, always |
| 7 | `POST /runs/:id/open-in`, CLI target (`:5612`) | `cliRunner` | as 6 | **`false`**, always |
| 8 | `POST /workspace/todos/:id/start` (`:6185`) | as site 1, **including the run-level / pinned-step split** | as site 1, with `parsed.data?.runner` as the RUN-level `selectionFor` fallback only | setting |
| 9 | headless `cezar run` (`index.ts:1031-1044`) | as site 1, **including the run-level / pinned-step split** | as site 1, from the CLI's own `--agent`/`--runner` values | setting |

(The numbering here is the Architecture diagram's; "The ten call sites" in Problem numbers the
same handlers as 1 to 10 and splits `POST /runs` from `POST /workspace/runs`, which share
`guardRunStart` verbatim.)

**Why site 1 is NOT one provider-pinned requirement per `providersRequiredByWorkflow` entry, which
is what an earlier draft of this spec said.** That construction pins a `provider` on every
requirement, and on the single most common configuration on `prod-host` it reproduces the
reported 409 exactly. Take the owner's own case: `POST /runs` with `runner: 'claude'`, the project's
stored claude selection `pool:*`, every claude account logged out, codex healthy.
`providersRequiredByWorkflow` answers `['claude']`, so the earlier construction builds one
requirement with `provider: 'claude'`, `candidatesFor` narrows to claude's accounts, all of them are
`disconnected`, `placeable` is `false`, and the gate refuses. **`resolvePoolForDispatch` would not
have.** It uses `fallbackProvider` for exactly one thing, locating the stored route
(`selectionFor(accounts, options.repoRoot, options.fallbackProvider)`,
`agent-route-select.ts:246-249`), and then hands the parsed route to
`poolCandidates(route, listAgentProfiles(accounts, PROFILE_CAPABLE_PROVIDERS))` (`:253`). For the
wildcard `pool:*` the route carries no provider, so the candidate set is **every** profile-capable
account, claude and codex alike, and the run would have dispatched onto codex. A gate stricter than
the picker it gates for is the bug, not a safety margin.

So the run-level requirement carries the provider **the route implies, not the one the workflow
names**: `provider: undefined` for `pool:*`, where candidates legitimately cross providers;
`route.provider` for `pool:<p>`; and the resolved account's own provider for an `account` route. The
workflow's runner survives only where `resolvePoolForDispatch` uses it, as the third argument to
`selectionFor`.

**Pinned steps DO keep a provider, and take their route from a different expression.** A step with
its own `runner` is re-resolved at dispatch by `resolvePoolForProvider`, which reads
`selectionFor(accounts, options.repoRoot, options.provider)` and **ignores the run's `agentProfile`
entirely** (`agent-route-select.ts:305-320`), forcing candidates to that provider even on `pool:*`.
So a pinned-step requirement is
`{provider: step.runner, route: parseAgentRoute(selectionFor(accounts, root, step.runner))}` and
must **not** be built from `body.agentProfile`: building it from the composer override would gate a
route that step will never take.

`providersRequiredByWorkflow` stays exactly as it is and is still the input, but site 1 reads it for
**which steps pin** rather than as a list of providers to pin requirements to. The pinned set is
`workflow.steps.filter(s => stepKind(s) === 'agent' && s.runner !== undefined)`, deduplicated by
provider: the same set minus the `?? fallback` the helper applies to unpinned steps
(`provider-action-gate.ts:17-25`). That `?? fallback` is precisely the substitution that invents a
provider pin the run never made, and it is the whole defect.

Two rules keep this from drifting: the route expression in column four is **copied from the
picker**, never re-derived, and every site that has an override passes the override. A site whose
override is dropped is the R1 failure with extra steps, and V2's override case is the test that
catches it.

**The connectedness seam into `RunManager`** matches the idiom already in its options bag
(`run.ts:1131-1137`, alongside `semaphore`, `loadGrant` and `reapBroker`):

```ts
options.accountAuth?: (provider: ProviderId, profileId: string | undefined) => AccountAuth
// default: () => 'unknown'   -> every account classifies as runnable/waitable exactly as today
```

Tri-state, not boolean, and the default is `'unknown'` rather than `'connected'`: the two read the
same way in `tierOf` (only `'disconnected'` excludes), but `'unknown'` is the honest value for "no
opinion injected" and keeps the not-injected case distinguishable in a test from an injected
`'connected'`. The production wiring passes `authOf`'s implementation, which resolves the correct
peek per account kind and applies the `runtimeRejections` overlay.

Defaulting to `true` means **every existing constructor and every existing test keeps today's exact
behaviour**, and the only behaviour change is at the three production wiring sites
(`packages/cezar/src/index.ts:791`, `index.ts:1057`,
`packages/cezar/src/server/project-context.ts:439`). The first two already build a
`ProviderAuthService` a few lines later (`index.ts:792`, `index.ts:1026`); `project-context.ts` has
none in scope today (`grep -n 'providerAuth' packages/cezar/src/server/project-context.ts` returns
nothing), so it is handed one by `createApp`, which owns the singleton. `disabledProviders` is
**not** threaded into `RunManager`: the pickers see it only through `loadViabilityInput`, which
reads the workspace config itself, so there is no route by which a disabled provider is silently
selectable.

## Data models

No stored shape changes. No new store, no migration. One new **source** module
(`packages/cezar/src/workspace/account-viability.ts`), which persists nothing and owns no state:
`AccountTier`, `ViabilityInput`, `Viability` are in-memory types, and `loadViabilityInput` reads the
two stores that already exist (`agent-accounts.json`, `agent-account-usage.json`) without writing
either.

- `RunManagerOptions` gains `accountAuth?`, in-memory only.
- `ProviderAuthService` gains `runtimeRejections: Map<string, RuntimeAuthFailure>`, keyed by
  `profileCacheKey(provider, profileId ?? DEFAULT_AGENT_ACCOUNT_ID)`, in-memory only and lost on
  restart exactly like the provider-wide `runtimeFailures` it sits beside (`provider-auth.ts:351`).
  `reportRuntimeAuthFailure` gains an optional `profileId` second parameter; `clearRuntimeAuthFailure`
  clears both maps for the incident id; a **connected** probe result clears only the matching
  `runtimeRejections` key and never `runtimeFailures`. Nothing is persisted, so there is no
  migration and a restart falls back to the probe caches, which is the pre-existing behaviour.
- `ProviderAuthService` gains `peekDefaultRowRaw(provider): ProviderStatus | undefined`, a
  latch-free sibling of `peekStatus()` reading the same `this.completed` cache. No state, no
  contract, no route: it exists so the routing path and the banner path can read the same cache and
  get the two different answers each of them actually needs.
- `downgradePinnedRunner`'s return type widens from `RunnerId | undefined` to
  `{runner: RunnerId; profileId?: string} | undefined`. Private method, in-memory, no stored shape.
- `RunStep` already carries `profileId`, so threading the downgrade's account onto the step record
  writes an existing field rather than adding one.
- `run.step.runner_downgraded`'s `reason` widens from the literal `'quota'` to
  `'quota' | 'credentials' | 'quota+credentials'`, and the event gains `actualAccount`, the
  `accountUsageKey` of the account that actually ran, the metric could previously name a provider
  the step did not use the chosen account of. It is an event in the run's NDJSON, and
  `account-hold.ts` already treats notes as prose rather than a parsed contract
  (`2026-08-24-continuation-reroute-held-account.md`, API Contracts), so no reader breaks.
- `resources.fallbackAcrossAccountsWhenLimited` keeps its name, its type, and its `true` default
  (`packages/cezar/src/workspace/config.ts:175`, `semaphore.ts:143,321-323`).

## Analytics

**The event is named while the feature is designed, not after** (house rule), and it covers
**every** account fallback, not only the pinned-step downgrade that happens to have a metric today.
`run.step.runner_downgraded` fires from exactly one of the five places a fallback can happen
(`downgradePinnedRunner`, `run.ts:3192-3201`), which is why the reported bug was invisible in the
record: a run that rerouted at dispatch, or resumed onto a different account, or picked a pool
member around a dead one, emitted nothing at all. After this spec, the number of times cezar
routed a RUN around a logged-out login is answerable, and so is which login. The fifth place,
planning, stays unrecorded for a structural reason set out below, and this spec says so rather than
implying the coverage is total.

**One structured event, `run.account_fallback`**, appended through the existing
`store.appendEvent(runId, {...})`, whose signature is `{type: string; stepId?: string; [key:
string]: unknown}` (`packages/cezar/src/runs/store.ts:1130`), so this needs **no contract change**
and no migration, exactly like `run.step.runner_downgraded` before it.

```ts
{
  type: 'metric',
  name: 'run.account_fallback',
  runId,
  stepId,                          // absent for a run-level dispatch
  workflow,                        // store.getRun(runId)?.workflow, as the existing metric does
  site: 'explicit-reroute' | 'pool' | 'continuation' | 'pinned-step',
  requestedRoute: string,          // formatAgentRoute(req.route): 'pool:*' | 'default' | '<id>'
  requestedProvider: ProviderId | undefined,
  requestedAccount?: string,       // accountUsageKey asked for; ABSENT for a pool route
  selectedProvider: ProviderId,
  selectedAccount: string,         // accountUsageKey of what it actually got
  selectedTier: 'runnable' | 'waitable',
  cause: 'quota' | 'credentials' | 'quota+credentials',
  skippedDisconnected: string[],   // accountUsageKey of every candidate excluded as disconnected
}
```

`selectedTier: 'waitable'` is the park, not a start, and is what makes "admitted then parked" (R1b)
countable rather than a thing users report. `skippedDisconnected` is the field that answers "which
login is actually rotting", which the provider-level banner cannot.

**`requestedAccount` is OPTIONAL, and an earlier draft of this spec had it required.** It cannot be
required, because a `pool:*` or `pool:<p>` route does not request an account at all: it requests a
**candidate set**, and `selectPoolAccount` picks the member (`agent-route-select.ts:253-258`).
There is no account to name, and inventing one, by writing the provider's default or the member
that happened to win, would make the field mean two different things in the same event stream and
would corrupt exactly the "which login was asked for" question it exists to answer. So the rule is
mechanical: **present for a concrete `account` route and for a concrete continuation pin** (`site:
'explicit-reroute'`, `'pinned-step'` where the step's stored route names an account, and
`'continuation'`, whose pin is the concrete `resumedProfileId ?? record.agentProfile` pair);
**omitted for pool selection**. `requestedRoute` still carries `'pool:*'` in that case, so the
event is never ambiguous about what was asked for, and a consumer that wants "requested something
concrete" tests `requestedAccount !== undefined` rather than parsing the route string. A unit
assertion on the **pool event shape** pins this: the emitted object for a `pool:*` dispatch has no
`requestedAccount` key at all, asserted with `expect(event).not.toHaveProperty('requestedAccount')`
rather than a check for `undefined`, which an over-eager `?? ''` would pass.

Emission points, one per site, all four of them:

| Site | Emitted from | `site` | Notes |
|---|---|---|---|
| explicit route rerouted | `rerouteExplicitAccountIfUnavailable` (`run.ts:3075`), beside the note it already writes at `:3125-3133` | `explicit-reroute` | emitted for BOTH tiers, including the `tier: 'waitable'` park |
| pooled selection skipped a dead member | `resolvePoolForDispatch` / `resolvePoolForProvider` (`agent-route-select.ts:246`, `:305`), only when `skippedDisconnected` is non-empty | `pool` | these two are in `workspace/`, which has no store handle: they return the skip list on `PoolChoice` and `RunManager` emits it, so the module stays I/O-free |
| a continuation moved | `runContinuation`'s reroute (`run.ts:4336`) and `parkContinuationOnAccount` | `continuation` | `requestedAccount` is `resumedProfileId ?? record.agentProfile`, the pair the resume was pinned to |
| a pinned step downgraded | `downgradePinnedRunner` (`run.ts:3192`), beside `run.step.runner_downgraded` | `pinned-step` | the older event stays, with its widened `reason` and new `actualAccount`, so nothing that reads it breaks |

**The planner is deliberately NOT on this list, and that is a gap this spec states rather than
papers over.** An earlier draft had `/plan` emit `run.account_fallback` with `site: 'planner'`.
It cannot: this event is appended through `store.appendEvent(runId, …)`, which begins
`const run = this.runs.get(runId); if (!run) throw new Error(\`unknown run: ${runId}\`)`
(`packages/cezar/src/runs/store.ts:1130-1132`). Planning **creates no run**: the `/plan` handler
gates, calls `planChain(repoRoot, parsed.data.task)` and returns the plan
(`server.ts:4685-4689`), so there is no run id to append against and the call would throw on the
only path it could ever run on. There is also **no workspace-level analytics sink** in this
repository to fall back to: every emission point above writes into one run's NDJSON, and `grep -rn
"appendEvent" packages/cezar/src` finds no workspace-scoped equivalent.

So: **planner fallback is verified by V8 but is NOT recorded.** V8 asserts the behaviour, that the
planner picks a healthy account and runs there, but the event does not exist, and the count of "how
often did planning route around a dead login" stays unanswerable until a workspace event sink is
specified separately. That is out of scope here, deliberately, because inventing one to carry a
single event would be a larger design than the bug being fixed. It is written down here, in the
section a reader consults to learn what this feature measures, so the gap is found rather than
mistaken for complete coverage.

`run.step.runner_downgraded` is deliberately **not** replaced. It is the narrow "a promise this
workflow made was degraded" signal named by
`.ai/specs/2026-08-24-codex-only-default-workflow.md` (Analytics); `run.account_fallback` is the
broad "work moved off the account it was aimed at" signal. Keeping both means the pinned-step case
emits two events, which is correct: it is both things at once.

## API contracts

- **`GET /api/v1/providers/status`**: additive optional `poolConnected?: boolean` per row
  (`packages/contract/src/workspace.ts:444-455`). One row per provider, unchanged. An older client
  ignores the key; an older server omits it and the new client reads `undefined` as "no pool
  information", falling back to today's per-row rule. Additive, so no deprecation ceremony under
  `BACKWARD_COMPATIBILITY.md`.
- **`PUT /api/v1/providers/:provider/enabled`** answers the same `providerStatusResponseSchema` and
  emits the same `provider-status` SSE row (`server.ts:2655-2657`), so it carries `poolConnected`
  too and `applyProviderStatusRow` must merge it.
- **409 bodies change text** on the reroutable sites: `{error: 'No agent provider is authorized.
  Connect one in Settings → Agents → Providers.'}` replaces the per-provider string in the
  everything-is-down case, one of two other sentences applies when something is connected but
  unreachable (see "Message copy, decided"), and in the has-a-fallback case there is no 409 at all.
- **Exit codes** on `cezar run` are unchanged: `1` when nothing is placeable, and the ordinary run
  path when it can now proceed.

### Message copy, decided

An earlier draft of this spec contradicted itself here: it gave site 10 the new generic terminal
message *and* promised site 10's exit-1 message was byte-identical to today. It cannot be both.
**The ruling: there are exactly THREE terminal strings, picked by `anyConnectedAnywhere` and
`anyEligibleConnected`, and every gated surface uses the same three, site 10 included.** Headless
and hosted must not disagree about why cezar refused. `unavailableProviderMessage`'s current
per-provider string is misleading whenever nothing is connected anywhere, because it names one
provider when the true answer is "none of them"; the generic "no agent provider is authorized" is
equally misleading when one *is* authorized and only policy is in the way; and it is **false**,
not merely unhelpful, when the connected provider is OpenCode or Pi, which cannot carry accounts
and so can never be a fallback. No sentence is right for all three, which is why there are three.
`cezar run` prints whichever applies to stderr and still exits `1`, so the exit contract is
unchanged and only the sentence differs.

| Surface | Condition | Message | Changed? |
|---|---|---|---|
| Sites 1, 4, 5, 6, 9 (409) | `placeable === false` **and** `anyConnectedAnywhere === false` (across all four `PROVIDER_IDS` rows) | `No agent provider is authorized. Connect one in Settings → Agents → Providers.` | **yes**, new string |
| Sites 1, 4, 5, 6, 9 (409) | `placeable === false`, `anyConnectedAnywhere === true`, **`anyEligibleConnected === false`** (only OpenCode and/or Pi are connected) | `<Provider> credentials are unavailable, and no account cezar can move this to is authorized. Authorize it in Settings → Agents → Providers.` | **yes**, new string |
| Sites 1, 4, 5, 6, 9 (409) | `placeable === false`, **`anyEligibleConnected === true`** (an eligible account exists but this dispatch may not use it: fallback off, explicit route) | `<Provider> credentials are unavailable, and account fallback is off. Authorize it in Settings → Agents → Providers, or turn on Account fallback in Settings → Resources.` | **yes**, new string |
| Sites 1, 4, 5, 6, 9 | `placeable === true` | none, action proceeds | **yes**, was a 409 |
| Site 2 `/plan` (409) | no **`runnable`** candidate for its requirement (not `placeable`; see Solution 4b) | whichever of the three strings above applies | **yes** |
| Site 3 live delivery | any | none, the gate no longer runs before delivery | **yes** |
| Site 3 reopen branch (409) | `placeable === false` | whichever of the three strings applies | **yes** |
| Sites 7, 8 (409) | required provider not connected | `<Provider> credentials are unavailable. Authorize it in Settings → Agents → Providers.` | no, byte-identical |
| Any site (409) | required provider **disabled** | `<Provider> is disabled. Enable it in Settings → Agents → Providers.` | no, byte-identical |
| Site 10 headless, stderr, exit `1` | `placeable === false` | whichever of the three strings applies, same as the 409 sites | **yes**, was the per-provider string |
| Site 10 headless | `placeable === true` | none, the run proceeds | **yes** |

`<Provider>` in all three is `viability.blocked[0]`, the first requirement that could not be
placed, **not** the first `required` entry. The two byte-identical rows are the ones with a
negative test (V4), and note that sites 7 and 8 keep the **original** per-provider sentence, not
the new fallback-off one: nothing about fallback is relevant to a button that reattaches to one
account's own session. All five strings live in `provider-action-gate.ts` beside
`unavailableProviderMessage` so that server and headless CLI import one constant each rather than
copies of a sentence. The client no longer holds a copy at all for the reroutable sites, it renders
whatever the server sent (Solution 6), and keeps only the two per-provider strings
`providerAvailability` already has for sites 7 and 8.

## Phases

**These are not all independently shippable, and an earlier draft of this spec said the wrong thing
about the order.** The dependency graph is:

```
  Phase 1 ──▶ Phase 2 ──▶ Phase 3
     │            └──────▶ Phase 5
     └──────────────────▶ (Phase 4 is free-standing)
```

- **Phase 1 may ship alone**, and safely, but **not invisibly**, and an earlier draft of this spec
  claimed it had no user-visible effect at all. It does, in one specific and common shape: when a
  provider's **default** row is connected but a registered **non-default** pool member is logged
  out. The gate consults only the default row (`unavailableProviderMessage`, `provider-action-gate.ts:57-71`)
  and therefore passes; `resolvePoolForDispatch` then picks among every profile-capable account with
  only `isLimited` to go on, and can select the logged-out member. That is a run that starts and
  dies today, and Phase 1 alone stops it. Because pool resolution reads no setting (Solution 4), this
  fires with `fallbackAcrossAccountsWhenLimited` **off** too. So Phase 1 is *independently safe*,
  because it only ever removes a dead account from a candidate set and never adds one, and *directly
  user-visible*: it fixes the non-default-account half of the reported bug on its own. It is
  therefore worth shipping and observing before Phase 2, rather than being pure preparation.
- **Phase 2 must ship after Phase 1 is deployed, or in the same release. Never before it.** Phase 2
  alone converts an honest 409 into a run that starts, spawns a logged-out CLI and dies. **Land 1
  first.**
- **Phase 3 depends on Phase 2 behaviourally, not on a field.** The client no longer computes a
  gate (Solution 6), so what it needs from the server is that submissions actually succeed. Shipping
  Phase 3 first would remove the composer's block while the server still answers `409`, turning a
  disabled box into a box that always errors on send: no worse in what it prevents, worse in how it
  feels. Phase 3's `poolConnected` rendering also reads a field Phase 2's server fill provides, and
  absent it every row simply reads `undefined` and the picker keeps today's appearance, degraded,
  not broken. **Land 2 first anyway.**
- **Phase 4 is independently shippable** in either direction. It is copy.
- **Phase 5 depends on Phase 1** (it uses `assessAccountViability`) but not on Phase 2, and may ship
  before or after it.

**Phase 1: dispatch stops choosing a disconnected account.** The new
`workspace/account-viability.ts` module (`AccountTier`, `AccountAuth`, `DispatchRequirement`,
`authOf`, `candidatesFor`, `assessAccountViability`, `loadViabilityInput`), the new
`peekDefaultRowRaw` accessor on `ProviderAuthService`, the per-account `runtimeRejections` map with
its own clear-on-connected-probe rule and the account pass-through in
`watchProviderRuntimeAuthFailures` (`step.profileId` when the event names a step, otherwise
`run.agentProfile`), the `accountAuth` seam on
`RunManager`, the three picker sites (`rerouteExplicitAccountIfUnavailable` including its tagged
`Placement` return plus `holdRunOnAccount` and `parkContinuationOnAccount`,
`downgradePinnedRunner` including its tagged return, its provider+account thread-through into
`agentEnvForStep` and the step record, and `holdStepOnWaitableAccount`,
`resolvePoolForDispatch` / `resolvePoolForProvider`), the
cause-aware note text, the widened `reason` field, the new `actualAccount` field, the new
`run.account_fallback` event at all **four** run-scoped emission points (Analytics; the planner is
deliberately not one of them, because planning creates no run to append to), and the three
production wiring sites (`index.ts:791`, `index.ts:1057`, `project-context.ts:439`). **User-visible
on its own** for the non-default-account case described in the dependency notes above, and safe on
its own because it only ever removes a dead account from a candidate set. Deliberately first for
that reason. Verified by V1.

**Phase 2: the gate stops refusing when a fallback exists.** `providerActionError`'s signature
becomes `(requirements, repoRoot?)` and it calls `assessAccountViability`; every call site builds
its own requirements per the Architecture call-site table, including the `POST /runs`
`body.agentProfile` override; the reroutable/pinned split across sites 1, 4, 5, 6, 9, 10; site 3's
ladder reordered so live delivery and the starting-run buffer precede any credential check, with
only the reopen branch gated; the **three** terminal message constants and the
`anyConnectedAnywhere` / `anyEligibleConnected` split that picks between them; site 10 (`index.ts:1031-1044`) switched from raw
`unavailableProviderMessage` to the shared module; the additive `poolConnected` field on
`providerStatusSchema` plus the server-side fill, the hosted non-default warm-up
(`server.ts:2437-2447`) and the `?refresh=1` top-up. `/plan` (site 2) is deliberately **not**
touched here. This is the phase the owner sees. Verified by V2, V4, V7.

**Phase 3: the client stops deciding.** Remove `activeProviderBlocked` and
`continuationProviderBlocked` from `thread-composer.tsx:49-52` and the `live`/`resume` arms of
`ask-answer.ts:113-116`, so a reroutable submission is attempted and the server's own sentence is
rendered on refusal; keep `providerAvailability` and its exact strings, now **advisory only** (it
never gated sites 7 and 8, which are enforced by their own server `409` checks at `server.ts:5510`
and `:5612`); carry `poolConnected` through `contract` → `provider-status.ts` parse/merge/compare →
`usableRunners` and the provider dots, **advisory only**, accepting that a pool-aware
`usableRunners` also widens what `OpenInMenuForRun` (`run-header.tsx:330`) offers and that those
entries are refused server-side rather than hidden. Without this the composer stays disabled on a
task whose provider is logged out even though `POST /messages` would now succeed. Verified by V3.

**Phase 4: say what the setting now means.** Settings label and helper text in
`resources-section.tsx:107-109`, `picker-pill.tsx`'s advisory note (`picker-pill.tsx:162,219`), and
the docblocks on the renamed method. Cosmetic, cuttable, and the honest completion of Phase 1's
scope widening.

**Phase 5: the planner picks its own account.** The `chooseAccount` seam on `planChain`
(`planner.ts:55`), the paired runner / model-alias / profile-env resolution, the `/plan` route's
injected chooser, and site 2's gate becoming "is there a `runnable` candidate in scope?" rather than
`placeable` (Solution 4b). Separable from Phase 2 because it is the
only gated action with no `RunManager` behind it, and because it can regress in its own way (a
degraded `fallback: true` plan rather than a dead run). Verified by V8.

## Risks

- **R1: a run starts and dies instead of being refused.** The failure mode if **Phase 2 lands ahead
  of Phase 1**, which is the ordering error an earlier draft of this spec actually wrote down. Also
  mitigated structurally: the gate's new rung calls the *same function* dispatch will call
  (`assessAccountViability`), not a parallel reimplementation of it, so an affirmative answer from
  the gate is a claim dispatch can keep by construction rather than by agreement.
- **R1b: the gate says yes and the run parks instead of starting.** When only `waitable` accounts
  exist the gate returns `null` and the run is admitted, then held on an appointment. That is
  intended (see the outcomes table) and is today's behaviour for an all-limited workspace, but it
  looks like "nothing happened" to a user who just watched a 409 disappear. Mitigated by the
  existing held-run note (`noteHeld`), which already names the account and is what the cockpit
  surfaces as "waiting on <account>".
- **R2: a stale "connected" from the peek routes onto a dead account.** Bounded by the cache TTL
  (`cacheTtlFor`: minutes for connected, one minute for anything else) and by the runtime rejection
  overlay, which marks **that account** on the first observed rejection. Note the overlay is what
  makes this bound real for non-default accounts: the provider-wide latch never covered them, so
  before this spec a rejected secondary had no fast negative signal at all. The cost of being wrong
  is one failed turn
  and a re-route, which is the same cost the quota path already accepts. Cheaper than spawning a CLI
  per candidate on every dispatch.
- **R3: an unknown peek answer counts as connected, so a cold cache reproduces today's blind
  behaviour.** Accepted, and chosen: the alternative (unknown counts as disconnected) would refuse
  actions on a freshly booted server, which is a new way to be blocked and is what this spec exists
  to remove.
- **R4: work silently lands on the wrong subscription.** A billing boundary, and the reason
  `selectProfile` deliberately refuses to degrade across a vanished account directory
  (`agent-profiles.ts`, "a billing boundary is not a preference to degrade quietly across"). Mitigated
  by announcement, not prevention, exactly as `2026-08-23-never-block-a-task.md` chose for quota:
  every cross-account and cross-provider move writes a note naming both ends, and the note is
  asserted, not decorative.
- **R5: sites 7 and 8 get "fixed" by a later reader.** Mitigated by the docblock and by an explicit
  negative test per site (V4) that fails if either becomes reroutable.
- **R6: the hosted warm-up now spawns one CLI probe per registered non-default account at boot.**
  New cost, introduced by Solution 6 to make `poolConnected` correct in the deployment that actually
  runs this cockpit. Bounded the same way the local path already is: sequential, after the defaults,
  fire-and-forget, each failure swallowed (`server.ts:2437-2447`). The measured worst case is the
  number of registered accounts, which on `prod-host` is small single digits. If it ever is
  not, the correct fix is a bounded concurrency on that loop, not reverting to a `poolConnected`
  that is permanently `undefined` in hosted mode.
- **R8: the planner picks a provider whose model alias it then mismatches.** `plannerModel`
  (`"sonnet"`) is Claude-only, and `resolveProfileEnvForRoot` returns a provider-specific env. Phase
  5 must move all three together (Solution 4b). Mitigated by V8's assertion on the *env* and the
  *model*, not only on which binary was invoked, because invoking `codex` with a Claude config dir
  is exactly the bug that would otherwise pass a "did it use codex?" test.
- **R7: `parseProviderStatusRow` drops the new field.** It rebuilds rows from known keys, so Phase 3
  silently no-ops if the parser is not updated: the contract would carry the field, the server would
  send it, and the client would never see it, with every test still green. V3's mutation covers this
  specific shape.
- **R9: a genuinely unauthorized workspace is discovered on send rather than on render.** The direct
  cost of Solution 6: with no client-side gate, a user with nothing connected types a message and
  gets the refusal on the attempt. Accepted, because the alternative is a client predicate that is
  wrong in both directions (it disables live sessions that would work, and enables explicit routes
  the server refuses), and because the Settings banner and provider dots still show the true state
  before anyone types. Mitigated by the server's sentence being rendered verbatim, so the one place
  that can compute the answer is also the one that words it.
- **R10: the per-account rejection map is in-memory and lost on restart.** After a restart a
  previously rejected non-default account reads as whatever its probe cache says, which on a cold
  cache is `unknown`, therefore eligible. This is strictly not worse than today, where the signal
  does not exist at all, and it converges within one `cacheTtlFor` window once anything probes.
  Persisting it was considered and rejected: a rejection is evidence about a live credential, and a
  restored-from-disk rejection would keep a re-authorized account excluded with nothing having
  re-checked it.

## Verification

Every case below is written to be **executable** and to have a stated mutation that reddens it. A
test that cannot go red is the failure mode this section exists to rule out.

**V1: the tiering and the dispatch pickers.**
`packages/cezar/src/workspace/account-viability.test.ts` (new, pure unit tests on
`assessAccountViability`) and `packages/cezar/src/workflows/account-fallback.test.ts`, a new
`describe` ("a logged-out account is not a limited account"), with its own fixture rather than the
existing suite's `beforeEach`, which pre-limits `claude:default` and would confound quota with
credentials.

Tiering, on `assessAccountViability` directly:

- connected + in quota → `runnable`; connected + limited → `waitable`; not connected →
  `disconnected`; unknown peek → `runnable`/`waitable`, never `disconnected`.
- **the freshly-probed disconnected DEFAULT.** Drive `providerAuth` so that `status()` has resolved
  and the cached default row for claude is `{provider: 'claude', status: 'disconnected'}`, while
  `completedProfiles` holds **nothing** for `('claude', 'default')`, which is the state
  `status()` actually leaves behind, because it writes `this.completed` and never
  `completedProfiles`. Assert `claude:default` is `disconnected`, **not** `runnable`. *Mutation:*
  route default accounts through `peekProfileStatus` → this case fails and only it. This is the
  bug that would otherwise have shipped as "we checked, and it was fine".
- **the banner latch must not steer routing, in either direction.** Two accounts, both with
  `connected` cached rows: `claude:default` and `claude:secondary`. Call
  `reportRuntimeAuthFailure('claude', 'secondary')`, which writes the per-account rejection **and**
  (unchanged, for the banner) the provider-wide `runtimeFailures`. Assert:
  (a) `claude:secondary` is `disconnected`;
  (b) **`claude:default` is still `runnable`**;
  (c) `peekStatus()` still reports claude's default row as `disconnected` with an
  `authFailureId`, so the cockpit banner is untouched.
  *Mutation:* read the default's auth through `peekStatus()` instead of `peekDefaultRowRaw` → (b)
  fails while (a) and (c) pass, which is exactly the inversion (heal the dead account, kill the
  healthy one) that makes this the first assertion in the file.
- **the per-account runtime rejection, and its clear rules.** The reverse of the above:
  `reportRuntimeAuthFailure('claude')` with no profile id leaves `claude:secondary`'s
  classification driven by its own peek. Then the two clear paths, asserted separately because
  they are deliberately asymmetric:
  - a subsequent **`connected`** `profileStatus('claude', secondary)` clears
    `runtimeRejections[('claude','secondary')]` and **nothing else**: `claude:secondary` returns to
    `runnable`, and `service.clearRuntimeAuthFailure('claude', id)` **still returns `true`**,
    proving the provider-wide latch was not cleared by the probe. This is the behaviour
    `provider-auth.test.ts:713` already pins for `runtimeFailures`, and this assertion is the
    statement that this spec did not weaken it.
  - a connected fresh `status({refresh: true})` clears
    `runtimeRejections[('claude','default')]` only, leaving a `('claude','secondary')` rejection
    in place.
  - `clearRuntimeAuthFailure('claude', id)` clears **both** maps for that incident id.
  *Mutation:* key `runtimeRejections` by provider alone → the sibling assertion fails. *Mutation:*
  have the connected probe also delete `runtimeFailures` → the `clearRuntimeAuthFailure` returns
  `false` and this case fails, and so does `provider-auth.test.ts:713`.
- **A STEP-LESS runtime auth failure rejects the RUN's account, not the provider default.** In
  `packages/cezar/src/server/provider-auth-runtime.test.ts`, whose harness already drives the
  watcher through the store. A run with `runner: 'claude'` and **`agentProfile: 'secondary'`**,
  both `claude:default` and `claude:secondary` starting from `connected` cached rows. Emit an
  auth-failure event with **no `stepId`** and a message `isRuntimeProviderAuthFailure` accepts, on
  each of the three types the watcher listens for (`error`, `session.error`, `note`;
  `provider-auth-runtime.ts:9`), since only `error` carrying a `stepId` is the well-trodden path
  and the other two are where this regresses. Assert per event:
  (a) `claude:secondary` classifies as `disconnected`;
  (b) **`claude:default` is still `runnable`**;
  (c) the provider-wide banner latch is set for `claude`, unchanged, so the acknowledgeable
  incident still appears.
  Then the paired positive control: the same run, an event **with** a `stepId` naming a step whose
  `profileId` is `default` → `claude:default` is rejected and `claude:secondary` is untouched,
  proving step-first precedence rather than a blanket run-level attribution.
  *Mutation:* pass `step?.profileId` alone (the earlier draft's rule) → every step-less case
  inverts: (a) fails and (b) fails, `claude:default` is marked dead and the account that actually
  had its credentials rejected stays eligible for the next dispatch. That inversion is
  indistinguishable in production from the reported bug, which is why it is asserted at the watcher
  rather than left to V1's pure-function cases.
- a provider in `disabledProviders` contributes to no tier, and `placeable` ignores it.
- **`candidatesFor`, one case per row of its table.** `pool:*` with no provider pin and the setting
  **off** still yields every enabled profile-capable account; `pool:*` **with** a provider pin
  yields that provider's accounts only, mirroring `resolvePoolForProvider`; `pool:codex` yields
  codex whether the setting is on or off; an explicit `account` route with `reroutable: false`
  yields **exactly one profile**, and an explicit route with `reroutable: true` yields every
  enabled profile-capable account. *Mutations:* make `pool:*` consult the setting → the first row
  fails, and it is the row that matches `prod-host`'s own
  `defaults: {claude: 'pool:*', codex: 'pool:*'}`; let a non-reroutable `account` route widen to
  its provider → the fourth row fails, and so does the dead-explicit-account case below.
- **THE REPORTED BUG, at the requirement-construction level: `runner: claude` + `pool:*` +
  fallback OFF.** The fixture is the owner's own configuration: workflow runner `claude`, the
  project's stored claude selection `pool:*`, every claude account `disconnected`, one codex
  account `connected` and in quota, `fallbackAcrossAccountsWhenLimited: false`. Build the run-level
  requirement the way the Architecture call-site table now specifies, from
  `parseAgentRoute(body.agentProfile ?? selectionFor(accounts, root, 'claude'))`, and assert the
  requirement carries **`provider: undefined`**, that `candidatesFor` yields **both** providers'
  accounts, that the codex account lands in `runnable`, and that `placeable === true` **with the
  setting off**. Then assert the same fixture's `resolvePoolForDispatch` picks that same codex
  account, so the gate and the picker are demonstrably answering the same question rather than two
  similar ones. *Mutation:* set `provider: 'claude'` on the run-level requirement from
  `providersRequiredByWorkflow`, which is what an earlier draft of this spec specified → the
  candidate set narrows to claude, every member is `disconnected`, `placeable` becomes `false`, and
  this case fails while the pinned-step cases stay green. That mutation IS the reported 409, so
  this is the single assertion whose red-to-green transition is the feature.
- **A pinned step takes its route from `selectionFor(…, step.runner)`, not from the run's
  override.** `body.agentProfile` is `pool:*`, while the project's stored **codex** selection is an
  explicit account, and a workflow step pins `runner: 'codex'`. Assert the pinned-step requirement's
  route is the explicit codex account (mirroring `resolvePoolForProvider`, which reads
  `selectionFor(accounts, repoRoot, options.provider)` and never the run's `agentProfile`,
  `agent-route-select.ts:305-320`), that it carries `provider: 'codex'`, and that its candidate set
  never crosses to claude. *Mutation:* build pinned-step requirements from `body.agentProfile` →
  the route is `pool:*`, the candidate set widens across providers, and the gate admits a run whose
  pinned step will resolve somewhere else entirely.
- **a dead explicit account with a HEALTHY same-provider sibling.** `claude:default` disconnected,
  `claude:secondary` connected and in quota, one requirement with
  `{route: {kind:'account', accountId:'default'}, provider: 'claude', reroutable: false}`. Assert
  `placeable === false` and `blocked === ['claude']`, **despite** `anyEligibleConnected === true`.
  Then flip `reroutable: true` and assert `placeable === true` with `claude:secondary` in
  `runnable`. This pair is the account-vs-provider distinction, and it is the case an earlier draft
  of this spec would have passed on both halves.
- **a mixed-provider workflow with one disconnected provider.** Two requirements,
  `{provider:'claude', reroutable:false}` and `{provider:'codex', reroutable:false}`, claude wholly
  disconnected and codex healthy. Assert `placeable === false` (the AND) and `blocked ===
  ['claude']`. Then both `reroutable: true` with fallback on → `placeable === true`, and both
  requirements name the same `codex` account in `runnable`, which is the "reroutable steps may
  share a fallback" property. *Mutation:* implement `placeable` as
  `requirements.some(r => r.placeable)` → the first assertion fails and the second still passes.
- `placeable` per requirement is `true` when its own `runnable` **or** `waitable` is non-empty, and
  `false` when both are empty. The two workspace-level flags are computed **outside** every
  candidate set:
  - a fixture with a connected codex account, an explicit claude route and the setting off yields
    `placeable: false`, `anyConnectedAnywhere: true` **and** `anyEligibleConnected: true`, the
    triple that selects the fallback-off message;
  - **the connected-OpenCode case:** every claude and codex account disconnected, `opencode`'s
    default row `connected` in `providerRows`. Assert `anyConnectedAnywhere: true`,
    `anyEligibleConnected: false`, and that the chosen message is the
    no-account-cezar-can-move-this-to one, **not** `'No agent provider is authorized…'`.
    *Mutation:* derive `anyConnectedAnywhere` from `profiles` (the profile-capable accounts) rather
    than from `providerRows` → this case fails, and it is the only one that does, because
    `opencode` never appears in `listAgentProfiles(accounts, PROFILE_CAPABLE_PROVIDERS)`.
- calling it twice returns identical results **and** leaves the round-robin cursor untouched:
  assert `loadAgentAccountUsage()` on disk is byte-identical before and after. This is the
  read-only contract, and it is the one property a careless implementation
  (`resolvePoolForDispatch`, which calls `recordDispatch`) would break silently.

Selection, on the pickers:

- `claude:default` connected but **limited**, `claude:secondary` connected and open → routes to
  `secondary`, note says out of quota. The unchanged path, as a negative control.
- `claude:default` **logged out**, `claude:secondary` connected and open → routes to `secondary`,
  note says logged out. New.
- **Every** claude account logged out, `codex:default` connected and open → crosses to codex, note
  names both ends, metric `run.step.runner_downgraded` carries `reason: 'credentials'`. New, and the
  literal shape of the owner's ask.
- **Every** claude account logged out, **every** codex account connected but limited → the run is
  **held**, not started and not refused. This is the case the flattened `isLimited || !connected`
  predicate got wrong, and it is also the case a `return undefined` would silently get wrong, so
  the assertions are specific rather than "it was held":
  - `rerouteExplicitAccountIfUnavailable` returns `{tier: 'waitable', choice}`, not `undefined`,
    and that choice names the **best waitable codex account** by `selectPoolAccount`'s own ranking.
  - `heldAtSpawn.get(runId)` is **exactly** `accountUsageKey('codex', <that account>)`, asserted
    with `toBe` on the full key, not a `toContain` on the provider, so the key came from the
    choice and not from `runAccountKey` on the record.
  - the `noteHeld` note names that same account.
  - **zero** invocations of the claude runner: assert on the injected `createRunner`/spawn seam's
    call count for `claude`, `toBe(0)`. *Mutation:* return `undefined` from the reroute in this case
    → `requeueWhileHeld` rebuilds the key from the disconnected `claude:default`, `accountHeldOn`
    finds no hold, and the claude spawn count becomes `1`. That is the exact failure this bullet
    exists to catch, and the reason the earlier draft's design was rejected.
- **The same case on a CONTINUATION, which has no `requeueWhileHeld` behind it.** A `failed` run
  with a recorded session on `claude:default`; `claude:default` disconnected; every codex account
  connected but limited. Call `continueRun(runId, {text: 'Continue.'})` and let
  `runContinuation` reach its reroute (`run.ts:4336`). Assert:
  - **zero** spawns of ANY runner: the injected `createRunner` seam's total call count is `0`,
    claude and codex both. This is the assertion that separates this case from the `execute()` one:
    there is no gate downstream to catch a waitable choice, so the reroute's own tag has to.
  - `this.active.has(runId)` is `false` and `pendingContinuations.has(runId)` is `true`: the run
    went back to the queue through `parkContinuationOnAccount`, with its `continue-N` step already
    added, rather than becoming an active run.
  - `store.getRun(runId).status === 'queued'`, `heldAtSpawn.get(runId)` is exactly the waitable
    codex key, and the held note names that account.
  - the run record's `runner`/`agentProfile` are **not** rewritten to the waitable codex account:
    a park is not a retarget, and the next attempt re-resolves from scratch.
  *Mutation:* have `runContinuation` treat `{tier: 'waitable'}` the way it treats a runnable
  placement (today's `rerouted` branch, `run.ts:4341-4374`) → the spawn count becomes `1` on a
  limited codex account, and every one of the four assertions above fails.
- **The same case on a LATER PINNED STEP, mid-run.** A run already three steps in, on step four
  which pins `runner: 'claude'`; every claude account transitions to `disconnected` while the run
  is in flight; every codex account is connected but limited. Assert:
  - `downgradePinnedRunner` returns `{tier: 'waitable', …}` naming the best waitable codex account;
  - **zero** further spawns: `createRunner` call count does not increase, on either provider;
  - the run's status is `failed` with `autoResumeAt` set to a real future instant, so
    `fireAutoResume` (`run.ts:3242`, which returns early unless the status is `failed`) will
    actually fire, and the note names the waitable account and both causes;
  - the appointment is `holdReopensAt(key)` when one exists and `now + ASSUMED_LIMIT_COOLDOWN_MS`
    when it does not, asserted on both branches, because a park with no instant is a run that never
    wakes.
  *Mutation:* return the waitable placement untagged and let `runAgentStep` use it as `backend` →
  the step spawns on a limited codex account and the spawn-count assertion fails. *Mutation:* omit
  the `armAutoResume` → the appointment assertion fails, and the run is parked forever.
- **`downgradePinnedRunner` names the account it actually ran on**, at the consumer level rather
  than only on its return value. A step pins `claude`; every claude account is `disconnected`; the
  chosen fallback provider `codex` has a **disconnected default** and a **healthy secondary**, and
  the project's stored route for codex is an explicit account (**not** a pool, so
  `resolvePoolForProvider` returns `undefined` and cannot rescue the resolution). Assert: the step's
  `backend` is `codex`; the step record's `profileId`, the env handed to `runner.run`
  (`CODEX_HOME`/config dir), the note, and the metric's `actualAccount` **all name the secondary**;
  and the disconnected codex default is never spawned. *Mutation:* return only `choice.provider`
  (today's `run.ts:3204`) → `agentEnvForStep` re-derives and lands on `codex:default`, the env
  assertion fails, and the note is revealed to have been describing an account that did not run.
- **Every** account everywhere logged out → no choice is returned, nothing spawns, and no hold is
  recorded against a disconnected account. Pins "disconnected is never held against".
- One claude account logged out, one healthy → stays on claude, no cross-provider move. Pins the
  `downgradePinnedRunner` "every account, never one" guard (`run.ts:3172`).
- Setting **off**, with an **explicit** account route → no cross-account reroute on either cause.
  Pins the off-switch where it actually applies.
- Setting **off**, with a **`pool:*`** route and a disconnected member → the pool still skips the
  disconnected member and still crosses providers, because pool resolution reads no setting. Pins
  the boundary of the off-switch, which an earlier draft of this spec drew in the wrong place.
- `accountAuth` not injected → behaves exactly as today (every account `unknown`, therefore
  eligible). Pins the default that keeps every other test in the repo honest.

*Mutations:* (a) collapse the tiers back to `isLimited || !connected` → the all-codex-limited case
fails (it refuses instead of holding) while every other case stays green, which is precisely the
regression this rewrite exists to prevent; (b) make `disconnected` eligible for holds → the
all-logged-out case fails; (c) drop the "every account of the provider" guard in
`downgradePinnedRunner` → the one-logged-out-one-healthy case fails; (d) make an unknown peek count
as `disconnected` → the not-injected case fails; (e) implement `assessAccountViability` on top of
`resolvePoolForDispatch` → the cursor-untouched assertion fails.

**V2: the gate.**
`packages/cezar/src/server/provider-action-gating.test.ts`, extending the existing
`describe('a project pooled onto more than one login')` harness (`:393-501`), whose `setupPool`
already drives per-account login state through `CLAUDE_CONFIG_DIR`.

One case per row of the outcomes table in Solution 2, so the table is executable rather than
decorative:

- Claude default and secondary both logged out, **codex connected and in quota** → `POST /runs`
  answers `201` and `startRun` is called once. This is the reported bug, and it fails on today's
  code.
- Same, but with a **stored explicit account** rather than `pool:claude` → also `201`. Pins the gap
  `poolHasConnectedAccount` cannot reach at all (`server.ts:1481`, `route.kind !== 'pool'` returns
  `false`).
- Claude logged out, **every connected codex account limited** → `201`, not `409`. The run is
  admitted and parks. Asserts the status body, and asserts `startRun`'s dispatch did not spawn a
  claude CLI. This is the outcome the flattened predicate would have turned into a refusal.
- **Nothing** connected on any provider → `409` with the new
  `'No agent provider is authorized. Connect one in Settings → Agents → Providers.'`. The negative
  control: a gate that always says yes passes every case above and is useless.
- **Fallback off, explicit route, healthy sibling on ANOTHER provider**, claude logged out, an
  explicitly stored claude account as the project's selection, codex connected and in quota,
  `fallbackAcrossAccountsWhenLimited: false` → `409`, and the body is **exactly**
  `'Claude Code credentials are unavailable, and account fallback is off. Authorize it in
  Settings → Agents → Providers, or turn on Account fallback in Settings → Resources.'` Asserted
  with `toEqual` on the parsed body. Pins both halves: the gate applies the setting where the
  setting applies, **and** it does not claim nothing is authorized when something is.
- **Fallback off, `runner: 'claude'`, `pool:*` route, healthy codex account. THE REPORTED BUG, at
  the route.** Same login state as above (every claude account logged out), but the project's
  stored claude selection is `pool:*`, one codex account is connected and in quota, and
  `fallbackAcrossAccountsWhenLimited: false`. `POST /runs` with body `{"runner": "claude", …}` →
  **`201`**, `startRun` is called **once**, and the dispatch it performs names the **codex**
  account: assert on the run record's `runner === 'codex'` and its resolved `agentProfile`, not
  merely on the status code, because a `201` that then dispatched onto a dead claude account is R1
  and passes a status-only assertion. This is the configuration `prod-host` actually runs
  (`defaults: {claude: 'pool:*', codex: 'pool:*'}`), and refusing here would be the gate being
  stricter than `resolvePoolForDispatch`, which reads no setting and whose candidate set for a
  wildcard pool is every profile-capable account of every provider
  (`agent-route-select.ts:246-258`).
  *Mutation:* build the run-level requirement with `provider` taken from
  `providersRequiredByWorkflow`, i.e. `'claude'` → the candidate set narrows to claude, all
  disconnected, and this case answers `409` with the fallback-off sentence: **exactly the bug
  reported**, reproduced by a one-token change, which is why the provider on a `pool:*` requirement
  is `undefined` and why this assertion is written at the route rather than only in V1.
  *Mutation:* drop `route` from `DispatchRequirement` and compute the candidate set from the
  setting alone → this case fails while the explicit-route case above still passes, which is
  exactly the asymmetry that makes both worth writing.
- **An explicitly selected HEALTHY secondary while the default is disconnected**, the project's
  stored selection names `claude:secondary`, which is connected and in quota, while
  `claude:default` is logged out → **`201`** with the setting either on or off, and no reroute note
  is written, because nothing needed rerouting. Pins that the gate reads the account the action will
  actually use rather than the provider's default row, which is what
  `unavailableProviderMessage` does today and is the whole reason this case is a `409` on current
  code.
- **A DEAD explicitly selected account while a healthy sibling exists, fallback off.** The mirror
  of the case above, and the one an earlier draft would have got wrong: the project's stored
  selection names `claude:default`, which is logged out; `claude:secondary` is connected and in
  quota; `fallbackAcrossAccountsWhenLimited: false` → **`409`**, with the fallback-off sentence.
  Then flip the setting on → **`201`**, and the reroute note names `claude:default` and
  `claude:secondary`. *Mutation:* have the requirement carry only `provider` and drop
  `route.accountId` → the `409` half becomes a `201`, the run spawns the logged-out default, and
  this is R1 shipped.
- **The composer override, which is not the project's route.** The project's stored selection for
  claude is `pool:claude` and claude's pool is healthy, but the request body carries
  `agentProfile: 'claude-default'` naming a **logged-out** account, with fallback off → **`409`**.
  Then the same request with the project's selection being a logged-out explicit account and the
  body carrying `agentProfile: 'pool:*'` with codex healthy → **`201`**. Both halves fail if the
  gate recomputes the route from `selectionFor(...)` instead of taking the site's own
  `body.agentProfile ?? selectionFor(...)`, which is the order `resolvePoolForDispatch` reads
  (`agent-route-select.ts:246-249`). This is the test the Architecture call-site table exists for.
- **A mixed-provider workflow with ONE disconnected pinned provider.** Start `spec-to-deploy`,
  whose `spec` step pins `runner: 'claude'` while the rest run on the task's provider, so
  `providersRequiredByWorkflow` returns both: claude wholly logged out, codex healthy, fallback
  **off** → **`409`** naming claude, because the pinned step is not placeable and every requirement
  must be. Then fallback **on** → **`201`**, and the run reaches the `spec` step and downgrades it
  with a note. *Mutation:* implement the gate as `requirements.some(r => r.placeable)` → the
  fallback-off half answers `201`, the run starts, and it dies nine steps later on a pin nothing
  could satisfy, which is the failure mode a gate exists to prevent.
- **Only OpenCode connected.** Every claude and codex account logged out, `opencode` connected →
  `409`, and the body is **exactly** `'Claude Code credentials are unavailable, and no account
  cezar can move this to is authorized. Authorize it in Settings → Agents → Providers.'`, asserted
  with `toEqual`. **Not** `'No agent provider is authorized…'`, which would be false: OpenCode is.
  *Mutation:* compute `anyConnectedAnywhere` over profile-capable accounts only → the body becomes
  the "no agent provider" sentence and this case fails.
- Codex **disabled** and codex required, claude connected → still `409` with the unchanged
  `'Codex is disabled. Enable it in Settings → Agents → Providers.'`. The existing assertion at
  `:464` ('a DISABLED provider still refuses even with a connected pool member') must stay green
  **unmodified**; disabled-provider rerouting is out of scope (see "Explicitly out of scope").
- The three existing assertions at `:330-372` (stale-cache honoured, fresh answer still refuses,
  runtime latch not talked out of) still pass with only the terminal message updated. If any needs
  its *behaviour* changed rather than its string, that is a signal the design drifted.
- Probe accounting: the happy path (`:375-384`) still spawns **zero** extra probes.
  `expect(state.probes).toBe(warmed)` is the assertion, and it is the whole cost argument for
  peeking rather than probing.
- **Site 3, live delivery:** a run with an open session and a logged-out provider → `POST
  /runs/:id/messages` answers `{delivered: true}` and calls `manager.sendMessage` once, with **no**
  provider status read at all. Asserts the gate moved rather than merely relaxed.
- **Site 3, reopen:** a `waiting` run that is not active, claude logged out, codex connected →
  `{continued: true}`, and `manager.continueRun` was called. With nothing connected anywhere → `409`
  with the new message.

*Mutations:* (a) make `placeable` return `true` unconditionally → the nothing-connected and
setting-off cases fail; (b) leave site 3's first gate where it is → the live-delivery case fails;
(c) route the disabled case through `placeable` → `:464` fails.

**V3: the client stops deciding.**
`packages/web/src/routes/task-thread/thread-composer.test.tsx`,
`packages/web/src/routes/task-thread/ask-answer.test.ts`,
`packages/web/src/routes/task-thread/active-provider.test.ts`, and new cases in the
`provider-status` suite. Web component tests need dev dependencies present: run them with
`npm ci --include=dev` and `env -u NODE_ENV`, or `React.act is not a function` will read as a
sandbox limitation when it is a missing-devDependency.

The client no longer computes a placement decision, so the cases assert **that it does not**, plus
the advisory rendering and the SSE merge.

Composer, in `thread-composer.test.tsx` / `ask-answer.test.ts`:

- **A live session with EVERY status row `disconnected`** → the composer is **enabled**, and
  pressing send calls `useSendMessage` once. This is the case a workspace-wide aggregate gets
  wrong: `anyProviderPlaceable` would be `false` and would disable a box the server answers
  `{delivered: true}` for, because delivering into an open session invokes no provider (Solution
  4c). *Mutation:* reintroduce any status-derived disjunction as a composer gate → this fails
  first.
- **Fallback off, explicit routing, a healthy other provider** → the composer is **enabled** and
  the send is attempted; the server's `409` body is rendered verbatim as the error. Asserts the
  client neither pre-refuses nor invents copy, the rendered string is the one the fixture's
  response carried, compared with `toBe`. This is the case a client-side "some row is connected"
  rule would have enabled *and* the server would have refused, in the opposite direction from the
  previous bullet, which is why one predicate cannot serve both.
- **A continuation on a logged-out provider** → enabled, attempted, server decides. Same shape.
- **Sites 7 and 8 are gated on the SERVER, and the client is allowed to offer them.** Two
  assertions, and neither of them claims `providerAvailability` disables a button, because it does
  not call one. (a) `providerAvailability` (`active-provider.ts:31-51`) still returns
  `usable: false` with its **byte-identical** existing reason for a run whose own provider row is
  disconnected, asserted directly in `active-provider.test.ts` with `toBe` on the string, in the
  same fixture where the composer is enabled: the string survives Phase 3 even though nothing
  refuses on it. (b) In `run-header`'s own test, with the run's provider row `disconnected` but
  `poolConnected: true`, the Terminal / Open-in-CLI entries are **offered**, clicking one issues
  the mutation, and the stubbed `409` body is surfaced verbatim as a danger toast
  (`open.onError`, `run-header.tsx:322-324`). That is the accepted consequence recorded in
  Solution 6, pinned so a later reader does not "fix" it into a hide.
  *Mutation:* make `usableRunners` ignore `poolConnected` → (b)'s offered assertion fails, and the
  engine-picker case above fails with it, which is the pair that shows one predicate feeds both.
  *Mutation:* delete `providerAvailability` along with the composer gates → (a) fails.

Advisory rendering and merge, in the `provider-status` suite:

- `usableRunners` offers `claude` when the `claude` row is `disconnected` but carries
  `poolConnected: true`, and a row whose provider is `enabled: false` is never offered.
- `parseProviderStatusResponse` **round-trips** `poolConnected`, and `applyProviderStatusRow` merges
  it from an SSE row.
- **An SSE row without `poolConnected` preserves the cached aggregate.** Seed the cache with
  `{provider: 'claude', status: 'disconnected', poolConnected: true}`, apply an SSE row
  `{provider: 'claude', status: 'disconnected', enabled: true}` (no `poolConnected`), and assert the
  merged row still has `poolConnected: true`. Without this, one unrelated enable/disable click
  greys the picker out.
- `sameProviderStatusRow` returns `false` when only `poolConnected` differs, so the merge is not
  short-circuited at `provider-status.ts:135`.

*Mutations:* (a) revert `parseProviderStatusRow` (`provider-status.ts:12-43`) to the old key list,
leaving contract and server correct → the round-trip case fails, and only it. This is R7, and it is
why that assertion is at the parser rather than only at the hook. (b) make an absent `poolConnected`
clear the cached value → the preserve case fails. (c) restore `activeProviderBlocked` in
`thread-composer.tsx` → the all-rows-disconnected live case fails.

**V4: the two pinned sites stay pinned.** An earlier draft of this spec named a
`POST /runs/:id/handoff` route here. **No such route exists** (`grep -n "post('/runs/:id/"
packages/cezar/src/server/server.ts`; the only `handoff` routes are `/handoff/resolve` at `:5232`
and `/handoff/skip` at `:5242`, neither of which is a provider gate). The two routes to test are:

- **`POST /api/v1/runs/:id/open-in-cli`** (handler `server.ts:5491`, gate `:5510`), the Terminal
  handoff. With `run.runner === 'claude'`, claude logged out and codex connected and in quota, and
  a recorded `sessionId`: status **`409`**, body **exactly**
  `{"error":"Claude Code credentials are unavailable. Authorize it in Settings → Agents → Providers."}`.
  Byte-identical to today, asserted with `toEqual` on the parsed body, not `toContain`.
- **`POST /api/v1/runs/:id/open-in`** with `{"target":"claude"}` (handler `server.ts:5533`, gate
  `:5612`), the Open in → CLI path. Same fixture, same status **`409`** and the same byte-identical
  body.
- Both assertions run in the same fixture where `POST /runs` answers `201` (V2's first case), so the
  test proves the split rather than a globally strict gate. This is the whole point: the same
  workspace state must produce `201` on a reroutable site and `409` on a pinned one.
- The `localHandoff: false` refusal at `server.ts:5498-5508` still precedes the gate, unchanged, so
  a hosted run answers its own message and never reaches the credential check.

*Mutation:* route sites 7 and 8 through the reroutable branch → both fail. Without these, "fix the
gate everywhere" is a one-line change a future reader will make.

**V5: gates.** The repository's complete required sequence, in this order, all from the repo root:

```sh
npm run typecheck      # pretypecheck builds the server first, then contract/client/server/web
npm test               # vitest run, the whole workspace
npm run test:unit      # node --test packages/cezar/test/unit/*.test.ts
npm run build          # build:server + build:web + check:pack + build:stamp
npm run test:package   # node --test packages/cezar/test/e2e/*.test.ts, against the built package
```

**There is no lint gate and none is added here**: `package.json` declares no `lint` script (verified
against the root `scripts` block at `00a202b8`), and inventing one would be a gate nobody can run.

**All five must exit `0`, in that order. There is no accepted-failures list.** An earlier draft of
this spec carried one, `catalog.test.ts` C18, `scheduler.test.ts` D8a, `pasted-attachments.test.ts`,
`step-stopped.test.ts`, `system-prompt.test.ts`, and told the implementer to compare against it.
That is a fail-open gate wearing a fail-closed gate's name: it converts "red, but I recognise the
names" into "pass", and the recognition is done by the same agent whose change is on trial. This
repo's rule is the opposite, and the memory of it is explicit: a step that reports done having read
a red gate is a defect. So:

- Each command is run to completion and its **exit code** is the verdict. A non-zero exit is a
  **stop**, not a note.
- An isolated rerun (`npm test -- run <file>`, the repository-required form; `npx vitest` is
  prohibited here because it resolves a vitest the workspace scripts do not pin, or a rerun on the
  box rather than a loaded Mac) is a
  legitimate **diagnostic**, this repo's record does document load-shaped flakes that do not
  reproduce on `prod-host`
  (`2026-08-24-continuation-reroute-held-account.md` V2,
  `2026-08-24-second-codex-account-balancing.md` V5). What it establishes is *where* the failure
  lives, not that the gate passed. **A green isolated rerun never converts a red full run into a
  pass.** Only a green full run does.
- If a command is still red after diagnosis, the required output is the **exact failure**: the
  command, the failing file and test name, and the assertion output, quoted. Then **stop before
  commit and before push**, and say plainly which gate is red. Do not proceed on the theory that it
  was already broken; if it genuinely was, prove it by running the same command on an unmodified
  checkout of the merge base and quoting both results.
- Run the sequence **on the box** (`prod-host`), and run it **twice**: a suite that passes
  once and fails once has not passed.

Expect churn in `provider-action-gate.test.ts` (`:40-61`), which asserts the raw strings, and in
`new-task.test.tsx` / `inbox.test.tsx`, which assert the presence of the "Configure providers" link
on the banner. Those assertions should be **updated, not deleted**: the banner still appears in the
terminal case, and a deleted assertion is how the banner quietly stops rendering at all.

**V6: runtime E2E, on an ISOLATED secondary server, on `prod-host`.** Required before this is
anything but QA Needed, per the repo's own definition of done.

An earlier draft of this spec proposed logging the production accounts out and repointing
`CLAUDE_CONFIG_DIR`. **Do not do that**, for two independent reasons. First, it is destructive: the
running `cezar` service is executing other people's tasks, and revoking its credentials fails every
one of them. Second, it does not even work: `CLAUDE_CONFIG_DIR` exported in an interactive shell
does not reach an already-running systemd service, so the "broken" state would be invisible to the
process under test and the E2E would pass on a machine that was never actually broken.

Instead, boot a **second, fully isolated cezar process** beside the live one:

1. **TWO scratch trees, because one of them must survive and the other must not.** An earlier draft
   of this spec put both under a single `WORK=$(mktemp -d)` and then had the `trap` `rm -rf "$WORK"`
   on EXIT, which deletes on the way out every artifact the same section promises to retain, and
   guarantees a failed run leaves nothing to look at. It also wrote
   `trap 'kill "${SRV:-0}" …'`, and `kill 0` **signals the entire process group**, which on an
   interactive shell includes the shell running the E2E. Both are corrected here:

   ```sh
   set -euo pipefail
   ART=$(mktemp -d /var/tmp/cez-e2e-art.XXXXXX)     # RETAINED: logs, pids, json, png, video
   CREDS=$(mktemp -d /var/tmp/cez-e2e-creds.XXXXXX) # DISPOSABLE: CEZ_HOME, copied credentials
   chmod 700 "$ART" "$CREDS"
   SRV=""
   cleanup() {
     # Guarded: a bare `kill "$SRV"` with SRV empty or 0 is `kill 0`, i.e. the whole process group.
     if [ -n "${SRV:-}" ] && [ "${SRV:-0}" -gt 1 ] 2>/dev/null; then
       kill "$SRV" 2>/dev/null || true
       # Give it a moment to flush, then make sure it is actually gone.
       for _ in 1 2 3 4 5; do kill -0 "$SRV" 2>/dev/null || break; sleep 1; done
       kill -9 "$SRV" 2>/dev/null || true
     fi
     rm -rf "$CREDS"          # credentials never outlive the run
     echo "artifacts retained in $ART"
   }
   trap cleanup EXIT INT TERM
   ```

   `$CREDS` holds the scratch `CEZ_HOME` (identity, accounts store, usage store), the scratch repo
   root for the project under test, the copied agent-config directory per fixture account, and the
   PATH shim dir from step 5. `$ART` holds everything a reader needs afterwards. Nothing under the
   live service's `CEZ_HOME` or `/opt/cezar` is touched, read-write, at any point. The `trap` is
   set **before** the first fixture is written, so an aborted run cannot leave a copied credential
   on disk.

   **Capture the live service's baseline HERE**, immediately after `$ART` exists and before
   anything else is launched. An earlier draft of this spec told the operator to write
   `$ART/live-before.json` "before step 1", which is before `$ART` is created and would simply fail
   to redirect:

   ```sh
   LIVE_API=http://127.0.0.1:4321/api/v1
   curl -fsS "$LIVE_API/providers/status" | jq -S . >"$ART/live-before.json" \
     || { echo "the LIVE service is not answering; fix that before running an isolation test"; exit 1; }
   ```

   The baseline is a **read** of the live service and the only interaction with it in the whole of
   V6. It is fetched without `?refresh=1` on purpose: a refresh would make the live service spawn
   probes, which is a side effect on the process this step exists to prove was left alone.

2. **Allocate the port concretely, then launch the artifact under test by absolute path and record
   what it was.** Not `npm start`, not a globally installed `cezar`, either of which can silently
   be a different build. The port is not "a free port": it is a fixed one well away from the live
   service's `4321`, and `--port-strict` is what turns "already in use" into a stop rather than a
   silent drift to the next port (`index.ts:177-178`, `:630`), which would otherwise put the whole
   E2E on a port none of the assertions below are pointed at:

   ```sh
   PORT=47311
   BUILD=/abs/path/to/worktree/packages/cezar/dist/index.js   # absolute, from the worktree
   test -f "$BUILD" || { echo "build the package first: npm run build"; exit 1; }
   sha256sum "$BUILD" | tee "$ART/artifact.sha256"            # artifact 1: WHAT ran
   env -i \
     PATH="$CREDS/bin:/usr/local/bin:/usr/bin:/bin" \
     HOME="$CREDS/home" \
     CEZ_HOME="$CREDS/home/.cezar" \
     CEZ_E2E_LOG="$ART" \
     CEZ_ACCOUNT_USAGE=1 \
     node "$BUILD" serve --port "$PORT" --port-strict >"$ART/server.log" 2>&1 &
   SRV=$!
   echo "$SRV" > "$ART/server.pid"                            # artifact 2: WHICH process
   ```

   `env -i` is deliberate: it is the only way to be sure the isolated server did not inherit a
   `CLAUDE_CONFIG_DIR`, `CODEX_HOME` or `CEZ_*` from the interactive shell and quietly read the
   live service's credentials. `CEZ_ACCOUNT_USAGE=1` is required for account balancing to be on at
   all (`guardRunStart` refuses an `agentProfile` without it, `server.ts:2585`). `$ART/artifact.sha256`
   and `$ART/server.pid` are kept; the SHA is what makes "we tested the new code" checkable
   afterwards rather than asserted.

3. **Readiness, then health, and they are different routes.** An earlier draft of this spec probed
   `GET /api/health` and expected a build stamp back. Neither is right: the readiness route is
   **`GET /api/v1/ready`** (`server.ts:2358`), and the informational route is **`GET
   /api/v1/health`** (`:2340`). The `deploy` field on `/ready` is present only when a release stamp
   exists (`:2375`), which a locally launched secondary does not have, so **do not** assert on it.

   ```sh
   API="http://127.0.0.1:$PORT/api/v1"
   deadline=$(( $(date +%s) + 120 ))
   until curl -fsS "$API/ready" >"$ART/ready.json"; do
     kill -0 "$SRV" 2>/dev/null || { cat "$ART/server.log"; exit 1; }  # died => fail
     [ "$(date +%s)" -lt "$deadline" ] || { echo "server never became ready"; cat "$ART/server.log"; exit 1; }
     sleep 1
   done
   curl -fsS "$API/health" >"$ART/health.json"
   ```

   `/ready` answers `503` until every check passes (`:2380`), so `curl -f` polling it *is* the
   wait; `kill -0` on the pid is what stops a dead server from being waited on forever, the
   vacuous pass `2026-08-22-deploy-e2e-probe-vacuous-pass.md` was written about; and the two-minute
   deadline is what stops a *live but never-ready* server from hanging the run instead of failing
   it. `/api/v1/health` is read **separately**, once, and its body kept as an artifact.

4. **A real connected credential fixture, and a real disconnected one.** `disconnected` is easy: an
   empty config dir probes as not connected. `connected` cannot be faked by a file whose shape we
   guessed, because the provider CLI decides. So the connected half comes from a **dedicated** Codex
   home that exists on the box for this purpose and is **never** the live service's. It is named by
   one environment variable the operator sets, and its absence is a hard stop, not a skip:

   ```sh
   : "${CODEX_FIXTURE_HOME:?set CODEX_FIXTURE_HOME to a DEDICATED codex home (never the live service's)}"
   : "${LIVE_CODEX_HOME:?set LIVE_CODEX_HOME to the codex credential dir the LIVE cezar service actually uses}"
   test -d "$CODEX_FIXTURE_HOME" || { echo "CODEX_FIXTURE_HOME does not exist"; exit 1; }
   test -d "$LIVE_CODEX_HOME"    || { echo "LIVE_CODEX_HOME does not exist"; exit 1; }
   test "$(realpath "$CODEX_FIXTURE_HOME")" != "$(realpath "$LIVE_CODEX_HOME")" \
     || { echo "refusing to use the live service's codex home"; exit 1; }
   cp -a "$CODEX_FIXTURE_HOME" "$CREDS/codex-fixture"
   chmod -R go-rwx "$CREDS/codex-fixture"
   mkdir -p "$CREDS/claude-empty"          # probes as disconnected, which is the point
   ```

   **`LIVE_CODEX_HOME` is operator-provided and has NO default, deliberately.** An earlier draft of
   this spec compared against `${HOME_OF_LIVE_SERVICE:-/root}/.codex`, and that guess is wrong in
   two independent ways on this box: the service runs as **`cezar`**, not `root`, so `/root/.codex`
   is not its home; and the unit may set an explicit `CODEX_HOME` that is not
   `$HOME/.codex` at all. A guard that compares the fixture against a path the service does not use
   is a guard that passes while pointing a second process straight at the live credentials, which
   is the exact accident the guard exists to prevent, and it fails **open**. So the operator states
   the real directory (read it off the unit: `systemctl show -p Environment cezar`, plus the unit's
   `User=`), the variable is required, and its absence is a hard stop rather than a fallback. Both
   paths are compared **canonically** with `realpath`, so a symlink or a trailing slash cannot slip
   an alias past the check.

   The copy is what makes it safe to point a second process at it, and the `trap` from step 1 is
   what removes it (`$CREDS`, not `$ART`). If no such dedicated home exists on the box, **say so
   and stop**: this step is not satisfiable by inventing a credential file, and a V6 that silently
   skipped it would be reporting a pass it did not earn.

   **Registration is a file write, not an API call.** There is no HTTP route that creates an agent
   account; the store is `$CEZ_HOME/agent-accounts.json` (`paths.ts:122-124`), and its shape is
   `{version, accounts[], defaults, selections}` with each account
   `{id, provider, configDir, label, addedAt}` (`agent-accounts.ts:94-176`). `id` must match
   `/^[a-z0-9][a-z0-9-]{0,63}$/` and must not be the reserved `default`; `provider` must be
   profile-capable, so `claude` or `codex`. `selections` is keyed by the project's **realpath'd**
   root:

   ```sh
   REPO="$CREDS/project"; mkdir -p "$REPO"; git -C "$REPO" init -q
   REPO_REAL=$(realpath "$REPO")
   mkdir -p "$CREDS/home/.cezar"
   cat > "$CREDS/home/.cezar/agent-accounts.json" <<JSON
   {
     "version": 1,
     "accounts": [
       {"id": "codex-fixture", "provider": "codex",
        "configDir": "$CREDS/codex-fixture", "label": "e2e codex", "addedAt": "2026-08-25T00:00:00Z"}
     ],
     "defaults": {},
     "selections": {"$REPO_REAL": {"claude": "default", "codex": "codex-fixture"}}
   }
   JSON
   ```

   `claude` is left on its discovered default, which under the `env -i` above has no credentials
   and therefore probes disconnected: that is the "logged out" half, produced by isolation rather
   than by breaking anything. Register the project itself through the API
   (`curl -fsS -X POST "$API/workspace/projects" -H 'content-type: application/json' -d
   "{\"path\":\"$REPO_REAL\"}"`), then confirm the split:

   ```sh
   curl -fsS "$API/providers/status?refresh=1" >"$ART/providers.json"
   # One row per provider, and that row is the DISCOVERED DEFAULT. Under `env -i` BOTH defaults are
   # credential-less, so BOTH must read disconnected. `codex-fixture` is a NON-default account and
   # is invisible to this row except through the aggregate.
   jq -e '.providers[] | select(.provider=="claude") | .status != "connected"' "$ART/providers.json"
   jq -e '.providers[] | select(.provider=="codex")  | .status != "connected"' "$ART/providers.json"
   jq -e '.providers[] | select(.provider=="codex")  | .poolConnected == true'  "$ART/providers.json"
   # The per-account evidence, from the route that answers for ONE account rather than the default.
   curl -fsS "$API/workspace/agent-profiles/codex-fixture/status?refresh=1" >"$ART/codex-fixture.json"
   jq -e '.status.status == "connected"' "$ART/codex-fixture.json"
   ```

   All four `jq -e` calls must exit `0`. **An earlier draft of this spec asserted
   `.provider=="codex" | .status == "connected"` here, and that assertion contradicts this spec's
   own statement two paragraphs up** that `GET /providers/status` answers exactly one row per
   provider and that the row is the discovered default (`packages/contract/src/workspace.ts:450-454`).
   Step 4 registers `codex-fixture` as a **non-default** account under an isolated `HOME`, so the
   codex default has no credentials either and its row is `disconnected`. The old assertion could
   only have gone green by accident, by the isolated server reading a credential it was built not to
   see, which is the one outcome this whole isolation exists to rule out.

   So the split being staged is asserted in the two places it actually lives: the **default rows
   stay disconnected** for both providers, and `poolConnected: true` on codex is the aggregate that
   says a non-default codex account is usable, which is the Phase 2 field under test. The refreshed
   per-account route (`server.ts:3074-3097`, which for a non-default account calls
   `providerAuth.profileStatus` directly) is the direct evidence that `codex-fixture` itself is
   logged in. If **that** assertion fails, the fixture home is not actually logged in and **the E2E
   stops here** rather than continuing against a workspace with nothing connected, which would make
   every later assertion pass for the wrong reason. The route requires `localHandoff`
   (`server.ts:3078`); the isolated server binds loopback and therefore has it, and a `409` from
   this call means the launch in step 2 was not isolated the way step 2 describes.

5. **Distinguish an auth probe from a run invocation with PATH wrappers, not `pgrep`.** A global
   `pgrep -f claude` count on `prod-host` also counts the **live service's** children, so it
   is both noisy and wrong. Instead, put a wrapper directory first on the isolated server's `PATH`:

   ```sh
   mkdir -p "$CREDS/bin"
   cat > "$CREDS/bin/claude" <<'EOF'
   #!/bin/sh
   # The auth probe uses the descriptor's statusArgs; a run does not.
   case "$*" in
     *--version*|*auth*|*whoami*) echo "$*" >> "$CEZ_E2E_LOG/claude.probe" ;;
     *)                           echo "$*" >> "$CEZ_E2E_LOG/claude.run" ;;
   esac
   exit 1     # a logged-out CLI: refuse, exactly as the real one would
   EOF
   chmod +x "$CREDS/bin/claude"
   ```

   The shim dir is already first on the isolated server's `PATH` and `CEZ_E2E_LOG` already points
   at `$ART`, both set in step 2's `env -i` block, so the markers land with the retained artifacts
   rather than in the tree the trap deletes. The exact `case` patterns are taken from the provider
   descriptor's `statusArgs` when the test is written, not guessed. **The assertion that matters is
   `$ART/claude.run` never being created**: probing a logged-out account is expected and fine,
   *running* on it is the bug. Counting processes cannot tell those two apart, which is why an
   earlier draft's `pgrep` check would have passed either way.

6. **The healthy-fallback case: the run must START, not `409`.** The route is the real one, and so
   is the assertion set:

   ```sh
   PROJECT=$(jq -r '.projects[0].id' <(curl -fsS "$API/workspace/projects"))
   RUN=$(curl -fsS -X POST "$API/p/$PROJECT/runs" -H 'content-type: application/json' \
           -d '{"task":"print the current date and stop","workflow":"default","runner":"claude"}' \
        | tee "$ART/start.json" | jq -r '.run.id')
   test -n "$RUN" && test "$RUN" != null || { cat "$ART/start.json"; exit 1; }
   ```

   `runner: 'claude'` is what makes this the reported bug: the action names the logged-out
   provider, and it must still start. Then wait for the run to leave `queued`, bounded, and assert
   on the **record**, not on prose:

   ```sh
   deadline=$(( $(date +%s) + 180 ))
   until [ "$(curl -fsS "$API/p/$PROJECT/runs/$RUN" | jq -r '.run.status')" != "queued" ]; do
     [ "$(date +%s)" -lt "$deadline" ] || { echo "run never dispatched"; exit 1; }
     sleep 2
   done
   curl -fsS "$API/p/$PROJECT/runs/$RUN" >"$ART/run.json"
   jq -e '.run.runner == "codex"'                  "$ART/run.json"
   jq -e '.run.agentProfile == "codex-fixture"'    "$ART/run.json"
   jq -e '[.run.steps[].profileId] | any(. == "codex-fixture")' "$ART/run.json"
   curl -fsS "$API/p/$PROJECT/runs/$RUN/events" >"$ART/events.json"
   jq -e '[.events[] | select(.name == "run.account_fallback")
           | select(.cause == "credentials" and .selectedProvider == "codex")] | length >= 1' \
      "$ART/events.json"
   test ! -e "$ART/claude.run"     # THE assertion: no run was ever attempted on the dead login
   ```

   The `run.account_fallback` assertion is the Analytics section made executable; the
   `claude.run` one is the behaviour. Both must hold: an event without the behaviour is a lie, and
   the behaviour without the event is unmeasurable.

7. **The waitable case, which is the one unit tests cannot fully stage.** Mark the codex fixture
   limited in the isolated usage store, which is a file write to
   `$CEZ_HOME/agent-account-usage.json` (`paths.ts:141-143`) whose entry shape is
   `{limited: {since, source, until}}` keyed by `accountUsageKey`
   (`agent-account-usage.ts:143`, `recordLimited` at `:257-268`). Do it with the server **stopped**
   or immediately before a dispatch, since the store is merge-written on every dispatch:

   ```sh
   cat > "$CREDS/home/.cezar/agent-account-usage.json" <<JSON
   {"accounts": {"codex:codex-fixture": {"limited":
     {"since": "2026-08-25T00:00:00Z", "source": "e2e",
      "until": "$(date -u -d '+2 hours' +%Y-%m-%dT%H:%M:%SZ)"}}}}
   JSON
   ```

   Start a task the same way as step 6 and confirm it is **admitted and held**: the `POST` answers
   `201`, the run's status settles on `queued`, the events carry a held note naming
   `codex:codex-fixture`, `run.account_fallback` carries `selectedTier: "waitable"`, and
   `$ART/claude.run` still does not exist. That last one is the whole point of the case: a park is
   correct, a spawn on the logged-out claude is not.

8. **The terminal case, and the quiet-queue check without a run NDJSON.** Remove the codex account
   from the isolated store (rewrite `agent-accounts.json` with an empty `accounts` array and no
   `selections` entry) and re-probe, so **every** provider on the isolated server is disconnected.
   Then assert the refusal:

   ```sh
   code=$(curl -s -o "$ART/refused.json" -w '%{http_code}' -X POST "$API/p/$PROJECT/runs" \
            -H 'content-type: application/json' -d '{"task":"noop","workflow":"default"}')
   test "$code" = 409
   jq -e '.error == "No agent provider is authorized. Connect one in Settings → Agents → Providers."' \
      "$ART/refused.json"
   ```

   **A refusal happens before run creation, so there is no run `.ndjson` to `grep -c`.** An earlier
   draft of this spec told the implementer to count lines in a file that does not exist, which
   would have failed as a missing file or, worse, passed as a zero. The equivalent check that does
   exist is an inventory of the whole event tree, **polled to a deadline rather than slept
   through**, so it fails on the first write instead of a minute later:

   ```sh
   inventory() { find "$CREDS/home/.cezar" -name '*.ndjson' -printf '%p %s\n' | sort; }
   inventory > "$ART/events.before"
   deadline=$(( $(date +%s) + 60 ))
   while [ "$(date +%s)" -lt "$deadline" ]; do
     inventory > "$ART/events.after"
     diff "$ART/events.before" "$ART/events.after" \
       || { echo "the refused task wrote events"; exit 1; }   # fail FAST, and say what changed
     sleep 2
   done
   ```

   Paths **and byte counts**, so a file that gained lines fails as loudly as a file that appeared.
   A bare `sleep 60` would have reported the same verdict a minute late and with no idea which
   write happened when. This is the check that caught the 2626-note write storm
   (`2026-08-23-never-block-a-task.md`, finding 4).

9. **Tear down EXPLICITLY, then prove the live service was untouched.** The ordering matters and an
   earlier draft of this spec got it wrong in both directions: it captured the "before" snapshot
   before `$ART` existed (corrected in step 1), and it captured the "after" snapshot *after
   teardown* while teardown was only an `EXIT` trap, which by definition has not run while the
   script is still executing. A comparison written at that point would either run before the
   isolated server was stopped, making "$SRV is gone" unassertable, or never run at all.

   So the last step **calls `cleanup` itself** rather than waiting for the trap. `cleanup` is
   idempotent by construction (the `kill` is pid-guarded, `rm -rf` on an already-removed dir
   succeeds), so calling it directly and then disarming the trap is safe:

   ```sh
   cleanup                       # stop $SRV, remove $CREDS, keep $ART
   trap - EXIT INT TERM          # disarm: teardown has happened, do not repeat it on exit
   ! kill -0 "$SRV" 2>/dev/null || { echo "isolated server $SRV still running"; exit 1; }
   test ! -e "$CREDS" || { echo "scratch credentials survived teardown"; exit 1; }

   curl -fsS "$LIVE_API/providers/status" | jq -S . >"$ART/live-after.json"
   diff -u "$ART/live-before.json" "$ART/live-after.json" \
     || { echo "the live service's provider status CHANGED across this run"; exit 1; }
   ```

   `jq -S .` on both sides so key order cannot make a spurious difference, and `diff -u` rather
   than a silent comparison so a real change is readable instead of merely fatal. There is nothing
   to restore on the live service because nothing on it was changed; these two files are the
   evidence for that claim. Both stay with the artifacts: "we did not touch production" needs
   evidence, not an assurance.

10. **Client E2E with artifacts retained: raw Playwright, not `npm run test:e2e`.**
    `npm run test:e2e` runs `.ai/scripts/e2e.sh`, which boots its own environment via
    `test-env-up.sh` and drives it through the **agent-browser** provider; it cannot be pointed at
    an already-running isolated port, and it records no video. Worse for this purpose, it is
    explicitly allowed to exit `0` with `TEST_E2E_STATUS=skipped` when the provider cannot be
    provisioned, which is a pass-shaped non-result. So drive this one case directly:

    ```js
    const ART = process.env.ART                      // the RETAINED dir from step 1
    const port = process.env.PORT                    // 47311
    const runId = process.env.RUN                    // the run created in step 6
    const project = process.env.PROJECT
    const browser = await chromium.launch()
    const context = await browser.newContext({
      recordVideo: { dir: `${ART}/video` },          // the artifact requirement
    })
    const page = await context.newPage()
    // The real cockpit route for a task thread: `/p/<project>/tasks/<runId>` when the workspace is
    // project-scoped, `/tasks/<runId>` on the boot project (`packages/web/src/routes.tsx:477`,
    // `workspace-tasks.tsx:485`).
    await page.goto(`http://127.0.0.1:${port}/p/${project}/tasks/${runId}`)
    const composer = page.getByRole('textbox', { name: /message/i })
    await expect(composer).toBeEnabled()             // NOT disabled by a client-side provider gate
    await composer.fill('ping')
    await page.getByRole('button', { name: /send/i }).click()
    await expect(page.getByText('ping')).toBeVisible()
    await page.screenshot({ path: `${ART}/composer.png`, fullPage: true })
    await context.close()   // Playwright finalizes the video on context close, not on browser close
    ```

    The specific assertion: with the run's provider disconnected and another provider connected, the
    composer is **enabled** and a sent message is delivered. `composer.png` and `video/` are kept
    with the run's artifacts, so a failure can be watched rather than guessed at. If Chromium cannot
    be launched on the box, that is a **skip that must be reported as a skip**, V6 is not complete
    without it, and the run is QA Needed until it runs somewhere it can.

**V7: the headless CLI shares the decision, at package level.**
`packages/cezar/test/e2e/package-cli.test.ts` (run by `npm run test:package`, so it exercises the
built and packed artifact rather than the source tree):

**These cases cannot use the suite's normal `CEZ_DRY_RUN=1` setup.** Every other case in that file
sets it (`package-cli.test.ts:90`, `:128`, `:221`), and under it `ProviderAuthService` short-circuits
every auth read to **connected**: `peekStatus()` returns a connected row for every provider
(`provider-auth.ts:592-594`), `peekProfileStatus()` returns connected for every account (`:583-585`),
`profileStatus()` the same (`:528-530`), and `reportRuntimeAuthFailure` is a no-op (`:420`). A
disconnected account is unstageable in that mode, so a test written on top of it would assert
nothing and pass unconditionally. (`CEZ_AGENT_MODELS_LOCKED=1` has the same effect through
`providerAuthChecksDisabled`, `:57-62`, and must also be unset.)

So these cases run **without `CEZ_DRY_RUN`**, with the subprocess-visible fixture the auth layer
actually consults: **provider executable shims first on `PATH`**, the same technique as V6 step 5,
scoped to the spawned CLI's environment. `claude` exits non-zero from its status args (probes as
disconnected). Both shims log their argv to files the test reads, so "was it probed?" and "was it
run?" stay separable. The shims are written into the test's `mkdtemp` dir and removed with it.

**The `codex` shim must BRANCH, and an earlier draft of this spec had it print connected auth
output and exit.** That shim cannot satisfy the healthy-fallback case below, because the *same
executable* is invoked twice for two entirely different jobs: once by the auth probe, with the
descriptor's `statusArgs` `['login', 'status']` (`core/provider-auth.ts:242`, spawned at `:608-609`),
and again by the runner, as `codex app-server` speaking JSON-RPC 2.0 JSONL over stdio
(`core/codex-app-server-transport.ts:48`, `nodeSpawn(bin, ['app-server'], …)`). A shim that answers
the probe and exits makes the *run* half fail immediately, so the "exits `0` and leaves a completed
run record" assertion could never pass, and the first implementer to try it would conclude the
assertion was wrong rather than the fixture.

So the shim dispatches on argv, and the run branch delegates to the deterministic app-server fixture
this repository already ships and already packs:

```sh
#!/bin/sh
case "$1" in
  login)      echo "$*" >> "$CEZ_E2E_LOG/codex.probe"
              # exact connected output taken from the descriptor's `parse` when the test is written
              printf '%s\n' "<connected fixture output>" ;;
  app-server) echo "$*" >> "$CEZ_E2E_LOG/codex.run"
              exec node "$MOCK_CODEX_APP_SERVER" "$@" ;;
  *)          echo "$*" >> "$CEZ_E2E_LOG/codex.other"; exit 1 ;;
esac
```

`$MOCK_CODEX_APP_SERVER` is `packages/cezar/scripts/mock-codex-app-server.mjs`, the mock the repo
uses for exactly this purpose in `run.test.ts:2619`, `account-fallback.test.ts:427`,
`codex-app-server-runner.test.ts` and `provider-action-gating.test.ts:517`, and which
`pack-check.ts:14` requires to be present in the published tarball, so it is reachable from the
packed artifact this suite exercises rather than only from the source tree. It speaks the
initialize/thread/turn handshake and one scripted turn, which is what "a completed run record"
needs. Any equivalent deterministic app-server fixture is acceptable; inventing one is not
necessary. `CEZ_DRY_RUN` stays **unset** throughout: the mock is reached through the `PATH` shim,
not through the dry-run switch, which is the whole point, since the dry-run switch is what forces
every auth read to `connected` and makes the disconnected half unstageable.

**Assert both branches were exercised as expected**, since a shim that silently took the wrong arm
would make the case vacuous: on the healthy-fallback case `codex.probe` and `codex.run` both exist,
`codex.other` does not, and `claude.probe` exists while **`claude.run` never does**. On the
terminal cases no `codex.run` is written at all, because nothing should have dispatched.

- **Healthy fallback:** an isolated `CEZ_HOME` with claude disconnected and codex connected and in
  quota → `cezar run "<task>" --workflow <name>` (the real invocation, `index.ts:1011`) **exits
  `0`** and leaves a **completed run record** whose `runner` is `codex` and whose step `profileId`
  is the codex fixture account. "A non-`1` early exit" was the earlier draft's assertion and it is
  too weak: any unrelated failure exiting `2` would satisfy it. Also assert the refusal string is
  absent from stderr, and that the `claude` shim's run log was never written.
- **No connected account:** every account disconnected → exit code **`1`** and stderr **exactly**
  `No agent provider is authorized. Connect one in Settings → Agents → Providers.` This is the
  string decided in "Message copy, decided", and this assertion is what makes that decision real
  rather than prose.
- **Connected, but out of scope:** claude required and disconnected, codex connected, an explicit
  claude route, `fallbackAcrossAccountsWhenLimited: false` → exit code **`1`** and stderr exactly
  the fallback-off sentence, **not** the "no agent provider is authorized" one. Pins the
  three-message split headless, where it is easiest to get wrong because there is no UI to notice
  it in.
- **Connected, but nothing eligible:** every claude and codex account disconnected while `opencode`
  is connected → exit code **`1`** and stderr exactly the no-account-cezar-can-move-this-to
  sentence. The third message, and the one a profile-capable-only `anyConnectedAnywhere` gets
  wrong; headless is where it is cheapest to assert, since the whole surface is one string on
  stderr.
- **Disabled provider:** the required provider disabled → exit code `1` and the unchanged
  `'<Provider> is disabled…'` string. Pins that the out-of-scope ruling holds headless too.

*Mutation:* leave `index.ts` calling `unavailableProviderMessage` raw → the first two cases fail.
This is the test that would have caught the closure problem: `providerActionError` is not exported
and never was, so any plan that routed the CLI "through the same helper" fails here immediately.

**V8: the planner picks its own account.** `packages/cezar/test/unit/planner.test.ts`, plus a route
case in `provider-action-gating.test.ts`:

- Default runner `claude`, claude disconnected, codex connected and in quota →
  `planChain(root, task, chooser)` invokes the **codex** runner, with the **codex** account's env
  (assert on the env handed to `runner.run`, not only on which runner was constructed), and
  **without** `plannerModel` (the `"sonnet"` alias is Claude-only, `planner.ts:67`). The result is a
  real plan, `fallback: false`, **not** the degraded one-step
  `'planner unavailable'` response at `planner.ts:96-100`.
- **Disconnected default, and every alternative merely `waitable`**, default runner `claude`,
  every claude account disconnected, every codex account connected but **out of quota**. The route
  answers **`409`** with the applicable credential message, `planChain` is **not called at all**,
  and no CLI is spawned. This is the case that separates the gate from `placeable`: `placeable` is
  `true` here, because a waitable candidate exists, and gating on it would relax the refusal, hand
  `planChain` a chooser that returns `undefined`, spawn the logged-out default, and return the
  degraded one-step `fallback: true` plan (`planner.ts:96-100`). *Mutation:* gate `/plan` on
  `viability.placeable` instead of `viability.runnable.length > 0` → this case fails, and it is
  the only one that does, which is why it is written.
- Every provider disconnected → the chooser returns `undefined`, and the route answers `409` with
  the applicable terminal message before `planChain` is called at all.
- `chooseAccount` omitted → byte-identical to today's behaviour, so every existing planner test
  stays green unmodified.

*Mutation:* select the runner without re-resolving the profile env → the env assertion fails, which
is R8.

## Explicitly out of scope

**Rerouting away from a DISABLED provider.** An earlier draft of this spec proposed that
`enabled === false` stop being terminal for reroutable sites, and carried it as an unresolved
question (R6). It is removed as a design element and settled the other way: **the disabled-provider
gate stays terminal, unchanged, in every site including headless.** Three reasons:

1. The owner's ask is about **credentials**, not settings. A disabled provider is a switch the user
   flipped, and rerouting around it is cezar overruling an explicit instruction, which is a
   different decision with a different owner.
2. It is already tested to refuse, deliberately, with a comment saying so
   (`provider-action-gating.test.ts:464`, "a DISABLED provider still refuses even with a connected
   pool member"; the assertion's own name goes on to call it a settings fact, not a credentials
   one). Changing it means deleting a passing assertion that encodes a prior decision.
3. It is not implementable under this spec's own seam without extra plumbing that would exist for no
   other reason. `RunManager` is deliberately not handed `disabledProviders` (see Architecture);
   enablement reaches the pickers only through `loadViabilityInput`'s own config read, which is
   enough to keep a disabled provider **out** of the candidate set but is not a mechanism for
   overriding the switch.

If the owner wants disabled providers to be reroutable, that is a separate, small spec, and it
should say what "disabled" is then supposed to mean.

## Open questions the record could not settle

Carried forward from the brief rather than answered by invention:

1. **The owner's "never blocked" ruling (KB `notion-5ce876561d8f`, 2026-08-23) is written entirely
   in quota vocabulary.** *"if model is unavailable or limit is hit"* is broad enough to read as
   covering a logged-out account, and this spec takes that reading, but no explicit ruling exists.
   The reading is stated here so that if it is wrong, it is wrong visibly.
2. **Whether a `waitable`-only workspace should park or refuse when the required account is logged
   out.** This spec chooses **park**, because that is what an all-limited workspace already does and
   because refusing would be a new way to be blocked. The alternative reading is that the user asked
   to "just continue on the auto one" and would rather hear "nothing is runnable right now" than
   watch a task sit. If the owner prefers the second reading it is a one-line change in
   `assessAccountViability` (`placeable = runnable.length > 0`) plus one V2 case, and the rest of
   this spec is unaffected.
