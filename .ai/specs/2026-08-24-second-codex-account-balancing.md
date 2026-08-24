# A second codex account, detected by itself, and a pool that can actually balance it

**Status:** Implemented (QA Needed — V6, the prod E2E, has not been run)
**Date:** 2026-08-24
**Repo:** `cezar`
**Extends:** `.ai/specs/2026-08-16-agent-account-usage-routing.md` (the pool and its four signals),
`.ai/specs/2026-08-14-claude-subscription-autodetect.md` (discovery, which this reverses in one
place), `.ai/specs/2026-08-23-usage-limit-hold-account.md` (the hold that is currently the only
working codex signal).

## TLDR

`prod-host` runs one codex login. It is rate-limited until **2026-08-29 14:45 UTC**, so
`pool:*` has nowhere to put codex work and every dispatch lands on `claude:secondary`. The owner
asked for a second codex account, detected automatically, balanced against the first.

Adding the login is configuration. The other two thirds are not, and one of them is a defect:

1. **Codex's quota reading is invented.** Probed twice on the box, 21 s apart:
   `usedPercent: 0` both times and `resetsAt` moved with the clock — always exactly
   `takenAt + 10080 min`. The app-server is answering with an empty snapshot, not a measurement.
   `probeCodexQuota` stores it anyway, so every codex account presents as **band 0**, the
   most-favoured value, which is the one claim `agent-account-probe.ts` says in its own rules it
   must never make: *"Never invents … Zero is a claim ('nothing used'), and it is the wrong one."*
2. **A band cannot be compared across providers, and `pool:*` compares them.** `byBand` is
   all-or-nothing over the whole candidate set, so one Claude percentage is ranked directly against
   one Codex percentage as if they measured the same thing. With (1) fixed, codex becomes
   unmeasured and the all-or-nothing rule then destroys Claude-vs-Claude steering too — the fix for
   one defect switches off a working feature.
3. **Discovery is Claude-only, and on this box it is invisible anyway.** `discoverClaudeAccounts`
   refuses codex on the grounds that identity would mean reading a credential file; and the route
   that serves it is withheld in hosted mode, which `prod-host` runs. So on the machine that
   needs this, detection has to be a server-side write or it is nothing.

So: stop inventing the codex window, rank bands **within a provider** and choose **across**
providers on the live signals, read codex identity from the one field of `auth.json` that is not a
credential, and — behind a new opt-in flag — register what is found instead of only offering it.

## Problem

### Measured on `prod-host`, 2026-08-24

`~/.cezar/agent-accounts.json`: one stored account (`claude:secondary`), `defaults` =
`{claude: "pool:*", codex: "pool:*"}`. `~/.cezar/agent-account-usage.json`:

| account | dispatches | limited until | quota |
| --- | --- | --- | --- |
| `claude:default` | 8 | 2026-08-29T14:45Z | week **100 %**, `takenAt` 2026-08-23T18:17Z (stale) |
| `claude:secondary` | 2681 | — | week 53 %, session 3 %, fresh |
| `codex:default` | 18 | 2026-08-29T14:45Z | week **0 %**, fresh, `planType: plus` |

Two of three logins are held, so the pool is a pool of one.

### The codex window is a default, not a reading

`account/rateLimits/read` on the box, twice:

```
11:39:15.981Z  {"usedPercent":0,"windowMinutes":10080,"resetsAt":1788176355}
11:39:37.257Z  {"usedPercent":0,"windowMinutes":10080,"resetsAt":1788176377}
```

`resetsAt` advanced by the 21 s between the calls. It is `now + windowDurationMins`, recomputed per
call — the shape of an unpopulated snapshot. The raw payload agrees: `limitId: "codex"`,
`secondary: null`, `rateLimitReachedType: null`, `credits.balance: "0"`.

The *real* snapshot, captured from a live request in a session rollout
(`sessions/2026/08/23/rollout-…19-51-43.jsonl`, 19:52:11Z, the request that armed the hold):

```json
"rate_limits": { "limit_id": "premium", "primary": null, "secondary": null, "plan_type": "plus" }
```

**On a ChatGPT Plus plan the windows that matter are `null`.** The limit that actually stops codex
is the weekly *premium* allowance, and it is announced only in the refusal text ("You've hit your
usage limit. Upgrade to Pro … purchase more credits"), never as a percentage. There is no numeric
signal to be had on this plan — not from the app-server, not from the rollouts. So the honest
answer for a codex account here is **unmeasured**, and `limited` holds plus the live signals are
what balancing has to run on.

**Confirmed on a second account and a higher tier (2026-08-24, during Phase 5).** The
`second@example.com` login registered by this spec is `chatgpt_plan_type: pro`, and its
first probe answered `usedPercent: 0`, `windowDurationMins: 10080`, `resetsAt` exactly 604 800 s
after `takenAt`. So this is not a Plus-tier quirk that Pro would have fixed: both accounts on this
box are unmeasured, and the two-signal balance below is what they will actually run on.

### Why "unmeasured" is not free

`selectPoolAccount` decides `byBand = pool.every(row => row.band !== undefined)` once over the whole
comparison set — deliberately, so the comparator stays a total order. Under `pool:*` the set spans
providers, so a single unmeasured codex account turns band ranking off for the two Claude logins as
well, and a pool with a 100 %-used Claude account and a 3 %-used one stops preferring the fresh one.
That is a real regression, and it is caused by the fix rather than by the bug.

The deeper point is that the cross-provider comparison was never sound: `floor(usedPercent/10)` on a
Claude Max week and on a Codex Plus week are two different subscriptions' fractions, and "7 vs 0"
does not mean the Claude account is worse to use. Bands rank **within** a subscription family.

### Detection

`discoverClaudeAccounts` scans `~/.claude*`, recognizes a login by the CLI's own marker files, and
reads `.claude.json`'s `oauthAccount` for a display identity. Codex is excluded by an argued
decision: its identity sits in `auth.json` beside `OPENAI_API_KEY`, an `access_token` and a
`refresh_token`.

The argument holds for the file and not for the fact — and it had already been overtaken when it was
written. **`agent-config/account-identity.ts` has read exactly this file's `id_token` claims for the
"Show details" route since `2026-07-29-agent-profiles.md`.** So the exclusion was not protecting a
file the repo otherwise leaves alone; it was leaving discovery blind to a fact cezar already
displays, on a machine where discovery is the only path that exists.

`auth.json` carries `tokens.id_token`, a JWT whose *payload* is an identity assertion and nothing
else — measured on the box:

```json
{ "email": "owner@example.com",
  "https://api.openai.com/auth": { "chatgpt_plan_type": "plus",
                                   "organizations": [{ "title": "Personal", "role": "owner" }] } }
```

That is the same class of fact `.claude.json` gives up, and it can be read without the function ever
returning, logging or retaining a credential. (The stored `id_token` is expired — `last_refresh` is
two days old — which is correct for this use: like Claude's `oauthAccount`, it says who the dir
belongs to, never whether the login still works.)

### Detection on a hosted box is a write or it is nothing

`GET …/agent-profiles/discovered` and `GET …/agent-profiles` both refuse when `localHandoff` is
false, because absolute host paths are a disclosure. `prod-host` runs `CEZ_REMOTE=1`. So the
"Detected on this machine" block cannot appear there, and `claude:secondary` was added to that box
by hand-editing JSON — which is exactly what the owner asked not to have to do again.

## Solution

### D1 — a codex window that cannot be told from an empty snapshot is dropped

In `parseWindow`, refuse a window whose `usedPercent` is 0 **and** whose `resetsAt` is within
`SYNTHETIC_RESET_EPSILON_S` (120 s) of `takenAt + windowDurationMins`. `parseCodexQuota` already
returns `undefined` when no window survives, so a Plus account becomes unmeasured rather than
falsely empty.

The epsilon test, not a two-probe comparison: a second probe costs a second CLI child on every
refresh round, and the shape is decisive on its own. A genuinely fresh window is
`windowStart + duration` where `windowStart` is the first request in it, so it coincides with
`now + duration` only in the instant the window opens — and in that instant the account has just
spent something, so `usedPercent` is no longer 0. Both conditions together are the empty default.

Dropping a *real* 0 % window costs nothing this feature needs: band 0 and unmeasured differ only in
that band 0 claims to be the best account in the pool, which is precisely the claim that must be
earned.

### D2 — bands rank within a provider; providers are chosen on the live signals

`selectPoolAccount` becomes two levels:

1. Partition the eligible candidates by provider. Inside each partition apply today's rule
   unchanged — `byBand` over **that partition**, then in-flight, then least-recently-dispatched —
   and take the winner.
2. Compare the partition winners by in-flight, then least-recently-dispatched. No band.

Every comparison is between homogeneous rows, so the order stays total and transitive. Claude keeps
its band steering. Two codex logins with no bands alternate strictly. A codex account can no longer
out-rank a Claude account by producing a number that means something else.

`pool:claude` and `pool:codex` are unaffected: one partition, one rule, today's behaviour exactly.

### D3 — codex identity from `id_token` claims only

The reader is **extracted, not written**: `readCodexIdentity`'s file handling becomes an exported
`readCodexAuthClaims(configDir)` in `agent-config/account-identity.ts`, which is where this repo
keeps the one copy of "where each vendor records its identity" — a second `readFile` of `auth.json`
elsewhere is precisely how two readers of one upstream drift apart. It returns
`{present, claims, apiKeyLogin}`: the JWT payload, and `OPENAI_API_KEY` **reduced to a boolean**.
`access_token` and `refresh_token` are not read at all. So the risk the struck-out paragraph names —
that such a value, once in a route's hands, ends up in a log line or an error body — is removed by
construction rather than by declining to look.

`readCodexAccountIdentity(configDir)` then narrows the claims to `{email, plan, organization}`.
`auth_mode: "apikey"` and a missing or unparseable `id_token` are `null`, the same "unknown
identity" a never-signed-in Claude dir produces.

Plan label: `chatgpt_plan_type` title-cased (`plus` → `Plus`), matching `planLabel`'s rule of
showing the vendor's own string rather than a guessed name.

### D4 — discovery covers every profile-capable provider

`discoverClaudeAccounts` → `discoverAgentAccounts`, scanning `~/.claude*` **and** `~/.codex*`,
recognized by the existing `PROFILE_DIR_MARKERS` (codex's are already there: `auth.json`,
`config.toml`). The contract's `provider: z.literal('claude')` widens to the profile-capable ids,
and the UI's hard-coded `provider: 'claude'` on the Add button uses the row's own provider.

### D5 — `CEZ_AUTO_ACCOUNTS=1` registers what is discovered

**This reverses the 2026-08-14 decision** *"Discovery that registered what it found would be a write
nobody asked for, and would also decide FOR the user that every login on the machine belongs in this
cockpit"* — on the owner's instruction, and only where the flag is set. That argument is still
right by default, which is why the flag is opt-in, strict-`'1'` like every other capability, and off
for everyone who does not ask.

Behind the flag, a reconcile runs at server boot and every `AUTO_REGISTER_INTERVAL_MS` (5 min):
discover, drop dirs already stored or already the discovered default, drop dirs with **no identity**
(a directory the CLI created but was never signed into is not an account), and append the rest
through the same `mergeWriteAgentAccounts` writer the route uses, labelled with the detected email.

**Not gated on `localHandoff`.** The routes withhold host *paths from a browser*; this writes the
server's own state on the server. Gating it would make the flag inert on the one class of machine
that cannot use the UI instead — which is the box this was asked for.

The reconcile only ever appends. It cannot see a deliberate removal — nothing records "not this
one" — so a deleted auto-registered account comes back on the next sweep. That is the one open edge;
see R3.

## Architecture

```
codex login (2nd)  →  /var/lib/cezar/.codex-secondary/auth.json
                                  │
        ┌─────────────────────────┴───────────────────────────┐
        │ discoverAgentAccounts()      readCodexAccountIdentity│  id_token payload only
        └─────────────────────────┬───────────────────────────┘
                                  │  CEZ_AUTO_ACCOUNTS=1
                        autoRegisterAccounts()  ── boot + 5 min ──►  agent-accounts.json
                                  │
                                  ▼
   resolvePoolForDispatch → selectPoolAccount
        partition by provider ─┬─ claude: band → inflight → lastDispatch
                               └─ codex : (unmeasured) → inflight → lastDispatch
                    winners ──► inflight → lastDispatch ──► PoolChoice
```

## Phases

| # | What | Where |
| --- | --- | --- |
| 1 | Drop the synthetic codex window | `core/agent-account-probe.ts` + fixture |
| 2 | Per-provider band ranking | `workspace/agent-route-select.ts` |
| 3 | Codex identity + discovery over both providers | `workspace/agent-account-identity.ts`, `agent-config/account-identity.ts`, contract, web |
| 4 | `CEZ_AUTO_ACCOUNTS` reconcile | `workspace/agent-accounts-auto.ts`, `server/capabilities.ts`, `server/server.ts` |
| 5 | The box: second login, config parity, flag, verify balancing | `prod-host` |

## Data Models

`AgentAccountIdentity` is unchanged (`email` / `plan` / `organization`) — codex fills the same three.

`DiscoveredAgentAccount.provider` widens from `'claude'` to the profile-capable provider ids. Older
cockpits parse the wider value fine (it is a string in a `z.enum`, and an unknown row is rendered by
`configDir`), and no stored shape changes at all: an auto-registered account is an ordinary
`agent-accounts.json` row.

No new persisted field. `AccountQuota` keeps its shape; a Plus codex account simply has none.

## API Contracts

- `GET /api/v1/workspace/agent-profiles/discovered` — unchanged shape, `provider` now also `codex`.
  Still withheld in hosted mode.
- No new route. Auto-registration is a server-side reconcile, deliberately not an endpoint: an
  endpoint would need the same host-path disclosure argument the listing route already lost.
- `GET /api/v1/health` gains `"autoAccounts": false` to the capability object, on the same terms as
  the six flags before it. (The flag-off byte-identity claim in `capabilities.ts` was already
  measured false and corrected in place; this makes the body grow by one more pair.)

## Risks

- **R1 — the epsilon drops a legitimately empty window.** A Pro/Business codex account genuinely at
  0 % right after a reset reads as unmeasured for as long as it stays untouched. Cost: that account
  ranks by in-flight and dispatch order instead of by band, for one dispatch. Accepted; the reverse
  error (a fabricated best-in-pool) is the one that misroutes work.
- **R2 — losing cross-provider band ranking changes production routing today.** With `pool:*` on the
  box, work will alternate providers rather than always preferring the lower percentage. That is the
  intent, but it is a live behaviour change: a Claude account at 90 % will now take dispatches while
  a fresh codex account exists. `limited` holds remain the backstop, and D1 means codex no longer
  wins on a fake number.
- **R3 — the reconcile cannot see a deliberate removal.** Delete an auto-registered account and the
  next sweep adds it back, because nothing records "not this one". Mitigation for now: the flag is
  opt-in and the machine it is on wants every login pooled. If this bites, the fix is a
  `dismissedDirs` list in the accounts store, not a change to the reconcile.
- **R4 — a second `CODEX_HOME` starts empty**, exactly as `CLAUDE_CONFIG_DIR` did (that trap cost a
  session: a second Claude profile inherited no `CLAUDE.md`, no skills, no memory). The box's codex
  home carries `AGENTS.md` → `../.claude/CLAUDE.md` and an 8.8 KB `config.toml`; the secondary must
  get both or it is a dumber agent that nothing announces. Phase 5 does this and verifies it.
- **R5 — the second account may have no paid plan.** A free ChatGPT login registers, probes as
  unmeasured, takes its turn in the rotation and fails on the first real step. Phase 5 confirms
  `chatgpt_plan_type` before the account is registered.

## Verification

**V1 (unit, Phase 1).** A fixture captured from the live wire — the synthetic payload above, with
`takenAt` set so `resetsAt == takenAt + 604800` — parses to `undefined`. Negative control: the same
payload with `usedPercent: 12` parses to one window, and with `resetsAt` 10 minutes short of a full
window parses to one window. Without the negative controls the assertion passes against a parser
that returns `undefined` for everything.

**V2 (unit, Phase 2).** Two Claude accounts at bands 7 and 0 and one unmeasured codex account:
Claude's winner is the band-0 login (proving the partition still ranks), and the choice alternates
Claude/codex across successive dispatches (proving cross-provider is round-robin). Negative control:
delete the partition step and V2's first assertion still passes while the second fails — the two
assertions must not be provable by one behaviour.

**V3 (unit, Phase 3).** `readCodexAccountIdentity` over a fixture `auth.json` holding a real-shaped
`id_token` plus a fake `access_token`/`refresh_token`/`OPENAI_API_KEY`: returns the email and
`Plus`, and — the assertion that matters — `JSON.stringify` of the result contains none of the three
credential values. `auth_mode: apikey` and a malformed `id_token` both return `null`.

**V4 (unit, Phase 4).** With the flag unset the reconcile writes nothing given a discoverable
unregistered dir (the negative control that the flag is the gate, not the discovery). With it set,
one row appears, a second sweep adds nothing, and a dir with no identity is never added.

**V5 (gates).** `npm run typecheck`, `npm run build`, and the full vitest suite — run **on the box**,
in a dedicated gate tree, twice, because this repo has a load-sensitive flake pool and one run cannot
tell a broken test from a flake. The standing `catalog.test.ts` C18 host-budget red is expected.

**Corrected 2026-08-24: there is no `lint` gate in this repo.** This line said `lint` between
typecheck and build until the run, and the run is what disproved it — `npx eslint` answers *"couldn't
find an eslint.config.js"*, there is no `lint` script in `package.json`, and no config file anywhere
in the tree. Naming a gate that does not exist is worse than naming none: a later session reads three
gates, runs two, and reports the set as green.

**Result, measured on `prod-host` in `/var/lib/cezar/gate-codex2` (load average 0.13, i.e. an
idle host):** `typecheck` exit 0; `build` exit 0; the suite run twice.

| | files | tests | non-C18 red |
|---|---|---|---|
| run 1 | 607 passed / 1 failed of 610 | 11383 passed / 1 failed of 11388 | — |
| run 2 | 606 passed / 2 failed of 610 | 11382 passed / 2 failed of 11388 | `add-project-dialog.test.tsx > registers exactly the checked rows…` |

**The red moved between the two runs, which is the whole point of running it twice.** Run 1's only
failure was the standing C18 host-budget ratio (`63.6 > 40`); run 2 added one more, in a file this
change does not touch, and it is a navigation race rather than an assertion about behaviour —
`expected '/p/cezar/' to be '/p/added/'`, i.e. the router had not settled when the assertion read
it. Re-run alone on the same tree on the same box: **24 passed**. Flake pool, not a break.

`health-forge.test.ts`, `projects-api.test.ts` and `workspace-parallel.test.ts` were red on the
**loaded Mac** and green in both box runs, which is the same effect — the Mac was carrying load
average 10-12 from the suite's own workers.

**The gate tree's `.git` has to be a real repository, not the worktree gitfile.** `build:stamp` runs
`git rev-parse HEAD`, and `/Users/mw/cezar-codex2` is a *linked worktree*, so its `.git` is a
**file** pointing at `/Users/mw/loki-labs/cezar/.git/worktrees/…` — a path that does not exist on the
box. `rsync --exclude '.git/'` does not exclude it (the trailing slash matches directories only), so
the file rides along, replaces whatever repository was there, and the build dies at the stamp step
with `fatal: not a git repository` naming a **Mac** path. Exclude `.git` without the slash, and
`git init && git commit` once inside the gate tree.

**V6 (production E2E, the one that decides Done).** On `prod-host`, after Phase 5:
1. `CODEX_HOME=/var/lib/cezar/.codex-secondary codex login status` → logged in, and the id_token
   claims name a **different** email and `chatgpt_account_id` than `/var/lib/cezar/.codex`. Two dirs
   holding the same login balance nothing and look successful — the trap the second Claude account
   already hit once.
2. Restart the service with `CEZ_AUTO_ACCOUNTS=1` and watch the account appear in
   `agent-accounts.json` with no hand edit.
3. `/api/v1/workspace/agent-accounts/usage` lists four rows, with both codex rows showing **no**
   quota bar (D1 working, not a probe failure — confirmed by the Claude rows still showing theirs).
4. Dispatch several tasks and read `dispatch.count` per account: the two codex accounts alternate,
   and neither takes every run.
5. `find /var/lib/cezar -not -user cezar | wc -l` → 0.

Until V6 has run this is **QA Needed**, not Done.
