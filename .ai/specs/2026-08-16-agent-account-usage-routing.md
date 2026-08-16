# Per-account usage in the sidebar, and account routing modes

**Status:** implemented (2026-08-16) — all four phases, five gates green, runtime E2E steps 1–7
executed against real `claude`/`codex` CLIs on this machine.

## TLDR

Two asks, one substrate. The sidebar should show **what each Claude/Codex account is doing right
now**, and choosing an agent — in the composer and in settings — should offer, besides a specific
account, **"balance across Claude"** and **"balance across everything"**.

The blocking question was *where a usage number can honestly come from*. It is now answered by
measurement rather than assumption, and the answer is **asymmetric**:

- **Codex reports true allowance.** Its app-server — the protocol cezar already speaks — has
  `account/rateLimits/read`, `account/usage/read` and `account/read`. A window carries
  `usedPercent`, `windowDurationMins` and `resetsAt`; there is a `planType` and a credits balance.
  That is remaining allowance, first-class and supported.

  **Both of those spellings were wrong in the first draft of this spec, and the live probe is what
  corrected them** — worth recording, because the wrong version of each fails silently:

  - The method is `account/rateLimits/read`, not `account/rateLimits`. The short name is rejected
    as an `unknown variant`, and the rejection helpfully enumerates every method the app-server
    knows — that list is the oracle to re-check against after a Codex upgrade.
  - The wire is **camelCase**, not the snake_case visible in the shipped binary's strings. Those
    strings are the Rust struct's field names; serde renames them for JSON. The snake_case spelling
    is real but belongs to Codex's session *rollout* files, a different format nothing here reads.
    A parser built from the binary strings matches nothing and returns `undefined` — which is
    exactly what "this provider reports no quota" looks like, so the panel would simply never draw
    a bar and the feature would look finished. That is why the parser is pinned by a fixture
    **captured from the live wire** rather than hand-written.
- **SUPERSEDED 2026-08-16 by `2026-08-16-claude-usage-windows.md` — Claude reports usage too.**
  `claude -p "/usage" --output-format json` returns the same windows the `/usage` screen shows, in
  the envelope's `result` field, for **0 tokens** (`num_turns: 0`, `total_cost_usd: 0`) and with no
  credential handling at all. Per-account via `CLAUDE_CONFIG_DIR`, like every other Claude probe
  here. The asymmetry that survives is narrower and is about SHAPE: Codex states a machine
  timestamp and a window length, Claude states a name and a localized human string and omits the
  reset entirely on an idle window. Original text, wrong in its conclusion and right in its
  evidence: ~~"**Claude reports none.** `claude auth status --json` gives identity and plan
  (`{loggedIn, email, orgName, subscriptionType}`) and **no usage at all**. There is no CLI
  command, no state file, and nothing on disk. The number the `/usage` screen shows comes from
  `/api/oauth/usage`, reachable only with the account's OAuth token out of the macOS Keychain
  (`Claude Code-credentials-<hash>`, keyed by a hash of the config dir)."~~ — `auth status` and the
  files really do carry nothing, and the Keychain path really does work (it was probed: `five_hour
  29% / seven_day 66%`). What was never tested was `-p` with a slash command, which is where the
  answer was.

So the panel shows, per account, **only numbers cezar can prove**, each labelled by what it is.
(Until 2026-08-16 this sentence continued "and it **never renders a percentage for a Claude
account**"; that clause is superseded — Claude states real percentages, and the rule it served is
now "a percentage only where a provider stated one".) The reasoning it rested on still holds
wherever a provider says nothing, because there is no denominator and an
invented one would be the most believable wrong number in the cockpit.

What makes the feature work anyway: the signals that decide routing are ones **cezar owns and
measures exactly** — in-flight runs per account, recent dispatch order, and observed limit-hits.
Real quota refines that where it exists; nothing depends on it.

**CORRECTED 2026-08-16 (same day):** this paragraph read "the **three** signals … Codex's real
quota refines that where it exists". There are four now, and quota is no longer Codex's alone. See
Solution C, where the 95% ceiling is superseded by a usage band.

## Problem

### 1. Accounts are invisible

`~/.cezar/agent-accounts.json` holds them, Settings → Accounts lists them, and
`selectProfile()` routes to them. But nothing anywhere shows **what an account is doing**. On this
machine right now there are two Claude logins and one Codex login, and the cockpit cannot answer
"which one am I about to exhaust", "which one is already rate-limited", or even "how many runs are
on each". The owner's stated shape of use — parallel agents, all day — is exactly the case where
that matters, and it is the case with no surface at all.

### 2. Routing is one fixed choice, and cannot spread

`selections[repoRoot][provider] = accountId` (`workspace/agent-accounts.ts`) is a single answer per
`(repo, provider)`. There is no way to express "use whichever Claude login is free", so a second
login only helps if the operator remembers to switch to it by hand — which means it is used when
someone notices a limit, i.e. after the limit has already cost a run.

The picker (`components/default-agent-picker.tsx`) already flattens agent × login into one list:

```
claude · Default
claude · Klaudiusz
codex
```

There is no row that means a *pool*, and the type has no way to spell one: `account: string | null`
where `null` is the discovered default.

### What each provider actually exposes — measured 2026-08-16

| | Identity + plan | True allowance | Spend |
|---|---|---|---|
| **Codex** | `account/read` | **`account/rateLimits/read`** — `usedPercent`, `windowDurationMins`, `resetsAt`, `planType`, credits | `account/usage/read` + cezar's own metrics |
| **Claude** | `claude auth status --json` — `email`, `subscriptionType` | ~~**none** — no CLI command, no state file; only `/api/oauth/usage` behind a Keychain OAuth token~~ **CORRECTED 2026-08-16: `claude -p "/usage" --output-format json`**, free and per-config-dir | cezar's own `usage.updated` metrics |

`~/.claude/stats-cache.json` and `~/.claude/usage-data/` were both checked and are **not** a source:
the first is Claude Code's own lazily-computed *spend* cache (and is per-config-dir, so it says
nothing about a second login), the second is a stale HTML report from 2026-06-01.

## Solution

Four phases. Phase A is the only one with new vendor knowledge in it; B, C and D consume it.

### A. A usage registry cezar owns

A new `workspace/agent-account-usage.ts` over `~/.cezar/agent-account-usage.json`, following the
house rules `agent-accounts.ts` already documents (every field `.catch`-defaulted, `.passthrough()`
at each level, per-entry salvage, atomic `0600` write, corrupt ⇒ empty + one warning).

It holds, per account id, three things and keeps them **distinguishable by name** so no consumer can
average them together:

- `inflight` — runs currently active on this account. **Derived, never stored**: counted from the
  cross-project run index at read time, so it cannot go stale or leak on a crash.
- `dispatch` — `{ lastAt, count }`, the fairness cursor for round-robin. Stored.
- `limited` — `{ since, until?, source }` when a run failed with a usage-limit error, cleared on the
  next success. Stored. `until` is present only when the provider said so.
- `quota` — the last `account/rateLimits` snapshot for a Codex account, with the time it was taken.
  Stored as a **cache of a provable fact**, never synthesized for a provider that has none.

**Collectors** (`core/agent-account-probe.ts`), each modelled on `core/codex-model-catalog.ts` —
short-lived child, NDJSON correlator, hard timeout, size cap, never throws into a request path:

- Codex: spawn the app-server with `CODEX_HOME` set from the account's `configDir` via the existing
  `profileEnv()`, `initialize`, then `account/rateLimits/read`.
- Claude: `claude auth status --json` with `CLAUDE_CONFIG_DIR` set the same way — identity and plan
  only, which is all it has.

Probes are **cached with the asymmetric TTL `provider-auth.ts` already argues for** and refreshed on
demand, never on a render.

### B. The sidebar panel

A new `components/account-usage-panel.tsx`, mounted in the sidebar under the project nav, one row
per account:

```
claude · Default        2 running   Max
claude · Klaudiusz      –           Max · limited until 18:40
codex                   1 running   Pro · 5h 43% ▓▓▓▓░░░░  resets 15:22
```

The **bar is rendered only where a real `used_percent` exists.** A Claude row shows its plan, its
in-flight count and its limited state, and nothing shaped like a gauge. This is the whole honesty
argument in one rule: two rows that look alike must mean alike.

Gated behind a capability flag like every other optional surface (`CEZ_ACCOUNT_USAGE`), default off,
so the zero-config cockpit is unchanged.

### C. Routing modes

The route becomes a small union instead of an account id, and **pools are rows in the existing
picker** rather than a second control:

```
claude · Default
claude · Klaudiusz
claude · Balance across Claude      ← new
codex
Balance across everything           ← new
```

**CORRECTED 2026-08-16 — there is no single builder, and assuming one would have shipped pools to
Settings only.** This paragraph originally read: *"`agentPickerRows()` is the single builder both
settings scopes and the composer already share, so adding rows there makes all three surfaces agree
by construction."* The first half is wrong. `agentPickerRows()` is shared by the **two settings
scopes** and nothing else; the composer builds its own option list inside `RunnerPill`
(`components/picker-pill.tsx`), from its own `accountChoices`. Adding rows in one place would have
left the composer — the surface the request names first — without a pool, and the symptom is a
routing mode that exists in Settings and silently does not apply to a task started from `/new`.

So the rows are added in **both** builders, and `components/agent-pool-rows.test.tsx` asserts they
agree, because nothing structural now makes them.

That file also pins the trap the two encodings create together: `RunnerPill` addresses a row as
`runner:account`, and a pool id contains its own colon, so the original `value.split(':')` yielded
`picked === 'pool'` — neither a pool nor an account. `selectProfile` degrades an unknown id to the
discovered login without a word, so every "balance" pick would have run on one account while the
pill still read "balance". Split on the FIRST colon only (`parseChoiceValue`).

**A pool row picks the provider too.** "Balance across everything" may resolve to Codex — that is
what the owner asked for, and it is why the route sits *above* the per-provider selection map rather
than inside it.

**The balancing policy, in strict order. SUPERSEDED 2026-08-16 (same day) — the ceiling is now a
band; the new policy is stated immediately below.**

~~1. **Skip** accounts in `limited` whose `until` has not passed. This is the point of the feature:
route around an exhausted login instead of failing on it.
2. **Fewest in-flight runs.** Exact, real-time, needs no vendor API.
3. **Least recently dispatched.** Breaks the tie and makes the spread even over a session.~~

~~Codex quota refines step 2 *only when fresh*: an account over a `used_percent` ceiling sorts last.
It is never required — a machine that has never probed still balances correctly.~~

**What replaced it, and why (2026-08-16).** Both sentences above were built on a claim that was
false by the time they shipped: that quota is a Codex-only fact, so scarce that a single yes/no was
all it could support. `2026-08-16-claude-usage-windows.md` landed Claude windows the same morning.
As a binary at 95%, quota saw **no difference between a login at 66% of its week and one at 9%** —
the measured state of this machine — so signals 2 and 3 alternated between them and the gap never
closed.

**The policy, as built:**

1. **Skip** accounts in `limited` whose `until` has not passed. Unchanged, and still a filter rather
   than a sort key: it must beat every later signal at once.
2. **Lowest usage band**, `floor(worstUsedPercent / 10)`.
3. **Fewest in-flight runs.**
4. **Least recently dispatched.**

Four decisions inside step 2, each because the obvious alternative fails a specific way:

- **A band, not the raw percent.** Raw percent is a near-unique key: it would win essentially every
  comparison, making in-flight unreachable in practice, and it would reorder the pool on a number
  the panel re-polls every 15 seconds. A band says "materially more used" and lets the live signals
  decide inside it.
- **The max across fresh windows, not the average.** Unchanged from the ceiling — being out of any
  one window stops the account. It is also *why this converges without a second mechanism*: because
  the band is the max, a burst on the fresher login raises its **5h session** percentage quickly,
  climbs it a band, and hands work back. Concurrency still spreads inside a band.
- **The band key applies only when every compared candidate has a fresh quota**, decided once over
  the set before sorting so the comparator stays a total order. A measured account and an unmeasured
  one are not comparable, and the tempting default — unmeasured sorts best — would hand every run to
  whichever login the probe happens to be failing on. A partially measured pool balances exactly as
  it did before quota existed.
- **A quota whose windows have all rolled over is unmeasured, not 0%.** `freshQuota` answers
  `undefined` once nothing is left, and reading that as zero would put the account in the best band
  on the strength of an expired window.

**`POOL_QUOTA_CEILING` retires with a replacement, not by lowering the floor.** The hazard it named
— routing onto an account about to be rejected — is covered *more strongly* by band ordering, which
avoids high usage from 10% upward instead of only at 95%. Its other property is preserved verbatim:
sorting last never excludes, so when every candidate is exhausted one is still returned.

Nothing else moved. `resolvePoolForDispatch` still reads the cached snapshot and **never probes on
the dispatch path** — the 15s panel poll (`useAccountUsage`) is what keeps quota inside the 5-minute
`QUOTA_STALE_AFTER_MS`. With the cockpit closed, or `CEZ_ACCOUNT_USAGE` off, nothing is measured and
balancing degrades to exactly the pre-band behaviour.

**Resolution happens once, at dispatch, and the chosen account is recorded on the run**
(`runs.agentProfile`, overwritten in `execute()`, plus `runs.runner` when `pool:*` picked the
provider; the per-step `profileId` follows from it). A pool is therefore never a property of a
running run: the run says exactly which login it went to, resume reads that same login, and the
thread header keeps meaning what it means.

**The route is spelled as a reserved account id, not a new field** (`pool:claude`, `pool:*` —
`contract/agent-route.ts`). `AGENT_ACCOUNT_ID_RE` cannot contain a colon, so no stored account can
ever collide, exactly as with the reserved `default`. The alternative — a second field beside
`agentProfile` — would have to be threaded through `runs.agentProfile`, the stored selection, the
create-run body, the settings write and the picker prop, and every consumer that missed it would
keep routing to one login while looking correct.

**Two sources for the route, in `selectProfile`'s existing order**: the task's own choice, then the
project's stored selection. Reading only the first was a real gap — a pool chosen in Settings never
appears on a run's input, so it parsed as "no route" and degraded to the discovered login. The
setting would have read as applied and done nothing. Guarded in
`workspace/agent-route-dispatch.test.ts`.

### D. Docs

`README.md` (the new flag and the panel), `BACKWARD_COMPATIBILITY.md` (the route field is additive,
and an older cockpit reading a pool value must degrade to the discovered default, not to a random
account), `CHANGELOG.md`.

## Architecture

```
                       ┌─────────────────────────────────────────┐
   account/rateLimits   │  core/agent-account-probe.ts            │
   account/read     ───▶│  (short-lived child, TTL cache)         │
   claude auth status   └──────────────┬──────────────────────────┘
                                       │ quota + identity (provable only)
                                       ▼
   run index ───────────▶ ┌──────────────────────────────────────┐
   (in-flight, derived)   │ workspace/agent-account-usage.ts      │
   run failures ─────────▶│ inflight · dispatch · limited · quota │
   (limited)              └───────┬───────────────────┬───────────┘
                                  │                   │
                    GET /agent-accounts/usage   selectRoute()
                                  │                   │
                                  ▼                   ▼
                     sidebar panel (B)      dispatch → runs.profileId (C)
```

The one non-obvious coupling: `selectProfile()` (`workspace/agent-profiles.ts`) stays the resolver
for a **specific** account and is not touched. Pools resolve *before* it, into a concrete
`(provider, accountId)`, and then call it. That keeps the existing "unknown id degrades to default,
missing directory does NOT degrade" asymmetry — a billing boundary — exactly where it already is.

## Phases

| # | Phase | Independently revertable |
|---|---|---|
| A | Usage registry + probes | yes — nothing reads it yet |
| B | Sidebar panel (flag-gated) | yes |
| C | Routing modes | yes — the union's `account` arm is today's behaviour |
| D | Docs | yes |

## Data Models

**CORRECTED 2026-08-16 — as built.** The draft below the line was wrong in two ways that mattered.
`provider` on the `account` arm was redundant (the provider is decided by the runner, not by the
route) and `accountId: string | null` gave two spellings for the discovered account when
`DEFAULT_AGENT_ACCOUNT_ID` already exists. The route is also **not a stored object** — it is parsed
from the account-id string that already flows everywhere; see Solution C.

```ts
export type AgentRoute =
  | { kind: 'account'; accountId: string }   // 'default' or a stored slug
  | { kind: 'pool'; provider?: ProviderId }  // absent provider = balance across every login

parseAgentRoute('pool:claude')  // { kind: 'pool', provider: 'claude' }
parseAgentRoute('pool:*')       // { kind: 'pool' }
parseAgentRoute('work')         // { kind: 'account', accountId: 'work' }
parseAgentRoute(undefined)      // { kind: 'account', accountId: 'default' }
```

~~Original draft:~~

```ts
export type AgentRoute =
  | { kind: 'account'; provider: ProviderId; accountId: string | null }  // null = discovered default
  | { kind: 'pool'; provider: ProviderId }        // balance across one provider's logins
  | { kind: 'pool' }                              // balance across every profile-capable login
```

`~/.cezar/agent-account-usage.json`, version 1. **Keys are `<provider>:<accountId>`, never the
account id alone** — `default` is the reserved id for *every* provider, so a bare key would pool
Claude's discovered login and Codex's into one bucket:

```jsonc
{
  "version": 1,
  "accounts": {
    "claude:owner-example-com": {
      "dispatch": { "lastAt": "2026-08-16T16:02:11.000Z", "count": 47 },
      "limited": { "since": "2026-08-16T13:40:00.000Z", "until": "2026-08-16T18:40:00.000Z",
                   "source": "run-error" },
      // Codex only. Absent for Claude — absence is the honest answer, not zero.
      "quota": { "takenAt": "...", "planType": "pro",
                 "windows": [{ "usedPercent": 43, "windowMinutes": 300, "resetsAt": 1783682746 }] }
    }
  }
}
```

`inflight` is deliberately **not** in the file. A count that survives a crash is a count that lies.

## API Contracts

Additive only:

- `GET /api/v1/workspace/agent-accounts/usage` → `{ enabled, accounts: AccountUsageRow[] }`.
  **CORRECTED 2026-08-16 in three places.** The draft said `GET /api/v1/agent-accounts/usage` →
  `{accounts}` with a **`404` when off**; all three were wrong. It is *workspace*-scoped (the
  accounts are the machine's, not a project's); flag-off answers **`200 {enabled: false, accounts:
  []}`**, following `notes-routes.ts`, because a 404 in this family has to keep meaning "no such
  route"; and `enabled` is what lets a client tell a disabled feature from a machine with no
  accounts, since both answer an empty list.
- ~~`POST /api/v1/agent-accounts/usage/refresh`~~ — **not built, and not needed.** The GET kicks a
  deduped refresh round when the stored snapshot is stale and answers from the snapshot without
  waiting, so there is nothing an explicit refresh verb would add except a way to spawn CLI children
  on demand.
- **No schema gained a route union.** Pools travel as reserved values in the account-id field that
  already exists (`pool:claude`, `pool:*`) — see Solution C for why a parallel field would have had
  to be threaded through five consumers, each of which would look correct while ignoring it. The
  wire therefore keeps accepting a bare account id unchanged, which matters because
  `agent-accounts.json` is explicitly designed to survive being read by another cezar build on the
  same machine: that build hands `pool:claude` to `selectProfile`, finds no such account, and
  degrades to the discovered default.
- `PUT …/agent-profiles/selection` accepts a pool id and **409s one while `CEZ_ACCOUNT_USAGE` is
  off** — storing a route nothing acts on is a setting that reads as applied and is not. A dead
  account id is still a 400.

## Risks

1. **A stale quota snapshot reads as current.** A cached `used_percent` from an hour ago on a 5h
   window is materially wrong. Mitigated by rendering the age next to it and dropping the bar
   entirely past a staleness ceiling — an absent bar is honest, an old bar is not.
2. **`account/rateLimits` is not a stable public contract.** It is an app-server method read out of
   the shipped binary, and it can change or vanish on a Codex update. Contained: the probe never
   throws into a request path, and every consumer already has to handle "no quota" because that is
   Claude's permanent state. The failure mode is the panel losing a bar, never a run failing.
3. **Balancing can spread a repo's runs across two logins mid-session**, which matters because a
   Claude session id only means something inside the config dir that created it (`runs/store.ts`
   says so). Contained by resolving the pool **once at dispatch** and recording the account on the
   run, so a resume follows the run's own `profileId` and never re-balances.
4. **"Balance across everything" changes which *agent* runs a task**, not just which login. That is
   the ask, but it means a task can land on Codex when the operator was thinking in Claude. The
   picker row says "everything" for that reason, and the run header names the resolved agent.
5. **Probing costs a child process per account.** Bounded by the TTL cache and by never probing on
   render; the panel reads the registry, and refresh is explicit.

## Verification

Every guard names the mutation that must turn it red.

| Guard | File | Mutation |
|---|---|---|
| The parser reads a response captured from the LIVE app-server | `core/agent-account-probe.test.ts` | Rename any field to its snake_case spelling — the state this feature was actually in until the probe ran, and the one no hand-written fixture can catch |
| A Claude account never gets a `usedPercent` | `workspace/agent-account-usage.test.ts` | Synthesize one from spend — the panel would render a bar with an invented denominator |
| A stale quota snapshot drops its bar | same | Raise the staleness ceiling past the window length |
| `inflight` is derived, not read from the file | same | Persist it — kill the process mid-run and the count never returns to zero |
| A limited account is skipped by the pool | `workspace/agent-route-select.test.ts` | Sort by in-flight only — the exhausted login gets picked first, since it is running nothing ✅ |
| The pool falls back when *every* account is limited | same | Return no account — dispatch would fail instead of trying ✅ |
| Fewest-in-flight beats least-recent | same | Swap the comparator order — a busy account keeps winning while it is the oldest ✅ |
| ~~Quota is exhausted when ANY window is~~ **superseded by the band rows below, same mutation** | same | ~~Average the windows — a fresh 5h window hides an exhausted week ✅~~ |
| The balancer works with no quota at all | same | Require a quota — an unprobed cockpit would stop balancing ✅ |

**Added 2026-08-16 with the usage band** (all executed; each mutation was applied to the source and
turned exactly the named guard red):

| Guard | File | Mutation |
|---|---|---|
| 66% loses to 9% at equal in-flight, and keeps losing | `workspace/agent-route-select.test.ts` | Restore the binary ceiling — the pick returns to `['default','work','default','work']` ✅ |
| Inside one band, fewest in-flight still wins | same | Drop `inflight` from `compare` ✅, or order on the raw percent ✅ (both were run; each kills this guard alone) |
| One unmeasured candidate ⇒ no reordering by band at all | same | Let an unmeasured account sort as band 0 ✅ |
| A quota with every window rolled over is unmeasured | same | Read an absent/emptied quota as 0% ✅ |
| Bands on the WORST window, not the average | same | Average the windows ✅ |
| Every candidate exhausted still returns one | same | Exclude band-10 accounts instead of sorting them last — `reduce` over an empty pool ✅ |
| `limited` is still skipped first, whatever the bands say | same | Move `limited` below the band in `compare` ✅ |
| A 4% fill is not the track's own surface token | `components/account-usage-panel.test.tsx` | Revert the fill to `bg-accent` ✅ |
| 40% is emerald, 80% amber, 95% red | same | Collapse the three branches to one colour ✅ |
| A stored pool selection is resolved, not just the task's own | `workspace/agent-route-dispatch.test.ts` | Read only `input.agentProfile` — a pool set in Settings silently does nothing ✅ |
| The dispatch cursor advances at the choice | same | Record on completion — a burst all reads the same LRU account ✅ |
| A pool id survives the composer's `runner:account` split | `components/agent-pool-rows.test.tsx` | `value.split(':')` — yields `'pool'`, which degrades to the default login while the pill reads "balance" ✅ |
| Both pickers offer the same pools | same | Add rows to `agentPickerRows` only — Settings gets pools, `/new` does not ✅ |
| A pool of one is never offered | same | Drop the ≥2 check — the balancer looks live on a machine where it cannot balance ✅ |
| The selection route still refuses a dead account id | `server/agent-pool-selection-api.test.ts` | Skip the check for everything, not just pools ✅ |
| A pool cannot be stored with the capability off | same | Store it anyway — a setting that reads as applied and is not ✅ |
| An unknown route value degrades to the discovered default | `contract/agent-route.test.ts` | Treat `pool:<anything>` as a pool — a foreign write becomes a routing instruction ✅ |
| The panel is absent when the flag is off | `server/agent-account-usage-api.test.ts` | Serve it unconditionally ✅ |
| In-flight counting reaches every manager, boot included | `server/agent-account-usage-boot-inflight.test.ts` | Enumerate `contexts.ids()` alone — reads 0 through a real running step ✅ |
| A `running` RECORD this process is not executing counts as nothing | same | Derive from `store.listRuns()` — a SIGKILLed run leaks a phantom 1 that never clears ✅ |
| The route reads the semaphore it was given | same | Hand it a store walk or `{}` — reads 0, which is what both shipped bugs looked like ✅ |
| `POST /runs` accepts a pool as `agentProfile` | `server/agent-pool-selection-api.test.ts` | Validate it as an account id — every pooled task 400s, which is how this was found ✅ |
| `POST /runs` passes the pool through UNRESOLVED | same | Resolve at create time — a queued run routes on in-flight counts that are minutes stale ✅ |
| `POST /runs` still refuses a dead account id | same | Drop the pool exemption's negation — "accepts a pool" becomes "stopped checking" ✅ |
| `POST /runs` refuses a pool with the capability off | same | Drop the 409 branch — the run starts on a route nothing will ever balance ✅ |

✅ = the mutation was executed and turned exactly that guard red.

Gates in order, **`npm test -- <path>`, never `npx vitest`**, judged by **exit code**:
`npm run typecheck`, `npm test`, `npm run test:unit`, `npm run build`, `npm run test:package`.
(There is no `lint` script in this repo.)

**Runtime E2E — the gate on done.** A green suite cannot see a probe against a real CLI, and this
feature is almost entirely about what the real CLIs say.

1. Rebuild, restart the cockpit on `localhost:4321` with `CEZ_ACCOUNT_USAGE=1`.
2. The sidebar lists all three accounts on this machine (two Claude, one Codex).
3. The Codex row shows a real `usedPercent` bar and a reset time that matches `codex` itself.
4. **Neither Claude row shows a bar** — the negative control for the whole honesty argument.
5. Start a run on one Claude account; its in-flight count goes 0 → 1 → 0 with the step, on that
   row and not on the other Claude row.
6. Choose "Balance across Claude" in the composer, start three runs, and confirm from
   `runs.profileId` that they did not all land on one login.
7. Kill the server mid-run; on restart a `running` record nothing is executing counts 0, not 1.
   (Not "the count is 0 after a restart" — `recover()` resumes interrupted runs, and a resumed run
   is genuinely in flight. The property is that the number follows execution, not the record.)

**Executed 2026-08-16 on a second cockpit (port 4399, scratch repo), steps 1–5.** Steps 2–4 passed
first time. **Step 5 failed, and it is the reason this section is not a formality:** the count stayed
at `0` through an entire real `running` step, while 8367 tests were green. See "In-flight counting
must include the boot project" below. Re-run after the fix: `0 → 1 → 0`, tracking
`pending → running → waiting`, attributed to `owner-example-com` and not to
`default:claude`, and the sidebar badge rendered `1` on that row alone.

**Steps 6–7 executed 2026-08-16, same cockpit.** Step 6 passed after one fix: `POST /runs`'s
`guardRunStart` refused `pool:claude` with `400 unknown claude account` — the composer's own value
bounced off its own create route, which no test caught because every test posted a real account id.
Four pooled runs then alternated `default` → `owner-example-com` → `default` →
`owner-example-com`, each record carrying the **concrete** login rather than the pool
string, and two `pool:*` runs landed on **codex** then **claude** — the everything pool really does
pick the provider. The dispatch cursor on disk showed 6 dispatches split 3/2/1 across the three
accounts.

**Step 7 FAILED on its first run, and it found the second real bug in this feature.** See "The
in-flight count cannot come from record status" below.

**Step 7 re-executed 2026-08-16 against the rebuilt binary, and it passes — in two measurements,
because the naive reading of "the count is 0 after a restart" is not the property that matters.**

1. *The crash itself.* A run was started on `owner-example-com`, the count went to `1`,
   and the server was `kill -9`ed mid-step. On disk the record came back exactly as before:
   `run.status = running`, `task` still `running`, still carrying that login. On restart the first
   sample read **`inflight=0` while the record said `running`** — the phantom is gone. The count
   then went to `1`, and that `1` is *correct*: `recover()` had genuinely resumed the run, verified
   by a live `claude --input-format stream-json` child of the new server pid. A count that tracks
   execution must go back up when execution resumes, so "0 forever after a restart" would itself
   have been a bug.
2. *The phantom recovery can never clear.* Measurement 1 races `recover()`, so it cannot show the
   case that actually leaked: a step left `running` on a run whose status is **terminal**, which
   `recover()` never revisits (it only sweeps `queued`/`waiting`/`running` runs). That state was
   written directly into `runs.json` — run `done`, its `task` step flipped back to `running` on
   `default` — and the server booted against it. The row read **`inflight=0`** while the API still
   reported that step as `running`, so the assertion is not vacuous: the record says one thing, the
   count answers from execution and says the other. This is the exact shape that measured `1`
   forever before the fix.

### Runtime E2E for the usage band + visible bars — executed 2026-08-16, all five steps passed

Not a formality: the previous two rounds of this feature each shipped a defect a green suite could
not see (a phantom in-flight count; an invisible fill).

1. ✅ Rebuilt, restarted on `localhost:4321` with `CEZ_ACCOUNT_USAGE=1`, v0.10.0.
2. ✅ The three rows draw a **coloured** (emerald) fill against a visibly darker track, and
   `week 68%` is plainly fuller than `week 9%`. The 9% and 12% slivers are legible, which is the
   case the old fill could not render at all.
3. ✅ Settings → Logins → Show details: the same bars under **Usage**, same colours, on the opened
   card only — the second card, closed, shows none.
4. ✅ `GET /api/v1/workspace/agent-accounts/usage` reports exactly what the bars draw:
   `claude · Default` session 12 / week 68 / week (Fable) 13; `owner` 0 / 9 / 0;
   `codex` 0.
5. ✅ **Balance across claude**, two runs back to back. Both resolved to
   `owner-example-com` (9%), neither to `Default` (68%), and the dispatch cursor on disk
   confirms it: `claude:default` still sits at its 15:30 entry while the second login took both.
   Under the retired ceiling the first would have gone to `Default` and the second would have
   alternated back.

**One trap this E2E surfaced, for whoever runs it next.** The run header renders the login from the
**step's** `profileId`, not the run's `agentProfile`, so a run whose step is still `pending` shows a
bare `claude · <model>` with no account name — which reads exactly like "it chose the discovered
default". Here run 2 sat pending on the working-tree lock (the scratch project is not a git repo, so
it is one task at a time) and looked like alternation for about a minute. Read `agentProfile` off
the run, or wait for the step to dispatch, before concluding anything from the header.

### In-flight counting must include the boot project

The first `inflight` closure enumerated `contexts.ids()`. That map **structurally cannot contain the
boot project**: `resolveProjectScope` (`server.ts:1733`) short-circuits both of its spellings —
`default` and its own id — straight to `bootContext`, so no boot request ever builds a map entry.
Every run in the boot repo was therefore invisible to the count.

Three things make this worth writing down rather than just fixing:

- **It measured as `0`, which is also what "nothing is running" looks like.** There is no error, no
  log line, and the panel renders perfectly. Only running a real agent and watching the number
  during a `running` step distinguishes the two.
- **The boot repo is where workspace runs live**, so the blind spot covered precisely the runs a
  balancer most needs to see. Phase C would have been built on a number that is always zero.
- **It is the third instance of this same gap.** `GET /workspace/runs-index` and
  `GET /workspace/runs` both shipped enumerating the registry and never visiting the boot repo. A
  cross-project reader in this codebase must ask "and the boot project?" as a matter of course.

First fixed by unioning `bootContext.store` into the store walk. **That fix was then replaced** by
the one below, which removes the enumeration entirely — see "Where the count actually comes from".

### The in-flight count cannot come from record status

Step 7 of the runtime E2E: SIGKILL the cockpit mid-run, restart, and the count must read 0. It read
**1**, on an idle login, and it would have read 1 forever.

The reasoning that produced the bug is in the original `inflightFromRuns` docblock, and it was
careful and wrong. `readRunIndexFromDisk` *does* reconcile a loaded `running` row to `failed`, so
"a disk read reports zero in-flight forever" is true — of that reader. But the server opens every
store with **`keepLive: true`**, which skips exactly that reconciliation so `recover()` can resume
interrupted work. After the SIGKILL the record came back with its first step reconciled to `failed`
and its `continue-1` step still `running`. Nothing will ever move that step again, so the phantom
never clears, and the balancer would route away from that account permanently.

### Where the count actually comes from

`RunManager.accountInflight()`, aggregated by `WorkspaceSemaphore.accountInflight()`. Both halves
are structural rather than careful, because both bugs were the careful version:

- **Registration, not enumeration.** Every manager registers with the shared semaphore, the boot
  project's included. There is no list to leave one off, which is what made bug 1 possible.
- **`active`, not `status`.** The manager answers from its in-memory map of runs it is executing.
  A dead process cannot leave that behind, which is what made bug 2 possible. It counts the run's
  `currentStepId` only — counting every `running`-looking step would multiply one agent across an
  interrupted run's history.

Summed across participants rather than unioned like `accountHolds`: a hold is a boolean fact about
an account, this is a quantity, and two projects running one task each on one login is two runs.

Guarded by `server/agent-account-usage-boot-inflight.test.ts` (rewritten for the new mechanism);
the mutation — derive from `store.listRuns()` — reproduces the measured phantom
`{'claude:default': 1}`. `ServerDeps.accountUsageProbes` injects the *probes* only, never the count:
every test that injected a count had agreed with both bugs.

## Not in this spec

- **Reading Claude's `/api/oauth/usage`.** Still out, and now for a stronger reason than when this
  was written: it is no longer "the only way to put a real Claude percentage on the screen"
  (`2026-08-16-claude-usage-windows.md` does it through the CLI), so the security cost — cezar
  handling the owner's subscription credentials out of the macOS Keychain — buys nothing the
  cockpit does not already have. The hash turned out to be plain `sha256(configDir)[0:8]` and the
  endpoint works; neither fact changes the decision. ~~Original: "It would need the account's OAuth
  token out of the Keychain under a hash cezar would have to reverse-engineer, against an
  undocumented endpoint … a separate decision with a security dimension. Flagged, not assumed."~~
- Cost/billing attribution per account. `usage.updated` already carries cost; aggregating it into a
  spend-per-account report is its own feature.
- Any change to `bare /new`, the bookmarklet contract, or which provider is the default agent.
