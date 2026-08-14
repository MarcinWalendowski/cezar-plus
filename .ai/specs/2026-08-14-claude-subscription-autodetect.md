# Autodetect Claude subscriptions

**Status:** Implemented (2026-08-14)

## TLDR

A second Claude subscription is a second config directory (`CLAUDE_CONFIG_DIR=~/.claude-work`), and
until now cezar knew one only by the **label somebody typed** when adding it. The CLI has already
written every login on the machine under `~/.claude*`, and each dir records the account it is signed
in as. Settings → Agent accounts now lists those dirs under **"Detected on this machine"**, named by
the email and plan the CLI itself recorded, with a one-click Add that prefills the label with that
email.

The accounts listing still carries no identity. That is the point of D5 below.

## Problem

Two things were wrong with "an account is a path plus a label you typed":

1. **You had to remember the path.** Adding a second subscription meant recalling that it lives in
   `~/.claude-bis` and typing it into a folder picker. Nothing on the machine was consulted, even
   though the CLI had written the dir and knows exactly which account it belongs to.
2. **The label is a guess about a fact.** `account-2` says nothing about whose quota a run will
   spend. The user asked for this directly: *"In addition to id, I'd like to be able to AUTODETECT
   different claude subscriptions as we are doing right now, via different aliases."*

## Solution

### D1 — Discovery is the resolved default plus `~/.claude*` siblings, recognized by markers

`discoverClaudeAccounts()` considers `agentHomePaths(env).claude` first (so with `CLAUDE_CONFIG_DIR`
set on the cezar process the row labelled default is the dir cezar actually spawns agents with), then
every `~/.claude*` directory, alphabetically, deduped by path.

A dir is offered only when `looksLikeProfileDir('claude', entries)` accepts it — the same recognizer
the rest of the feature uses, so there is no second definition of "a Claude home" and an empty
`~/.claude-notes` folder is not offered as a login that could never authenticate.

`CLAUDE_CONFIG_DIR` accepts any absolute path, so a dir elsewhere is legal and simply will not be
discovered. That is the honest boundary of an autodetect: it offers what it can recognize, and the
folder picker still exists for everything else. Crawling the home directory to close the gap would
turn opening a settings pane into a filesystem walk.

### D2 — Identity comes from `.claude.json`'s `oauthAccount`, through the one reader that knows where that file is

The location is **not uniform**: `.claude.json` is a *sibling* of `~/.claude` by default and *inside*
an overridden config dir. `paths.ts#claudeStateFilePath` owns that rule, and
`agent-config/account-identity.ts` is the declared home of "where each agent writes its own identity".

So discovery does **not** open the file itself. `readClaudeOauthAccount()` was extracted in that
module and both readers go through it: `readClaudeIdentity` (the "Show details" rows) and
`workspace/agent-account-identity.ts#readClaudeAccountIdentity` (the structured `{email, plan,
organization}` discovery shows). Two `readFile(claudeStateFilePath(...))` calls in two modules is
exactly how two readers of one upstream drift apart, and the failure it would produce here is the one
this feature must not have: **labelling the second account with the default account's email.**

### D3 — Claude only, and the other providers are absent rather than approximated

`PROFILE_CAPABLE_PROVIDERS` is `['claude', 'codex']`; this covers the first only. Codex records its
identity in `<CODEX_HOME>/auth.json`, which is a **live credential file** — on this machine it holds
`OPENAI_API_KEY`, an `access_token` and a `refresh_token` beside the account id. Reading a token file
to build a display label is a real risk for a cosmetic gain, and the risk is not "we might print it":
a value like that, once in a route's hands, has a way of reaching a log line or an error body later.
Claude's `.claude.json` holds no credential at all (the OAuth tokens are in the macOS Keychain),
which is what makes it safe to read here.

("Show details" already reads codex's `auth.json` for its JWT claims — that is a pre-existing,
per-account, user-initiated read of one named account, not a sweep of every dir on the machine.)

### D4 — Discovery proposes; adding is still the same POST

`GET /api/v1/workspace/agent-profiles/discovered` writes nothing. Add posts the ordinary
`POST /api/v1/workspace/agent-profiles` with the dir it named, through the same duplicate-folder and
absolute-path guards a hand-typed dir goes through. Discovery that registered what it found would be
a write nobody asked for, and would decide for the user that every login on the machine belongs in
this cockpit.

`added` is computed server-side because the answer is `sameProfileDir` — a realpath comparison — and
a client-side string compare would offer a second spelling of a dir cezar already has as a new
account.

### D5 — The accounts listing carries no identity. Discovery is a second on-demand route, not a widening

`agent-config/account-identity.ts` rule 2 said identity is *"read on demand, answered to exactly one
route"* and *"never joins the accounts listing"*. This spec **amends the first half and keeps the
second**, and the amendment is recorded in place in that module's doc comment:

- **Two routes now.** Discovery is the second. It has to carry identity because a discovered dir is
  **not an account yet** — there is no account id `…/:id/details` could be addressed with, and a list
  of bare paths does not answer the only question the block exists to answer. It is on-demand and
  `localHandoff`-gated on exactly the terms the details route is.
- **The listing still carries none.** An `identity` field on `GET …/agent-profiles` was built first
  and backed out: that response is fetched on every load of the settings pane, so the email would sit
  in the response body, the query cache and devtools whether or not anything rendered it — which is
  what "hidden by default" exists to prevent. An added account is named by its **label**, which
  discovery prefills with the detected email, so the subscription survives the add without the
  listing ever carrying identity.

### D6 — The plan label is derived from the vendor's own strings, with no lookup table

The only tier observed on a real machine (2026-08-14) is `default_claude_max_20x`. A hardcoded map of
plan names would be one verified entry and a pile of guesses, and a guessed plan rendered beside an
email reads exactly as confidently as a correct one. So: `…max_<n>x…` → `Max <n>x`; anything else is
the vendor's own `organizationType`/tier string, de-snake-cased. The tier wins over
`organizationType`, which is `claude_max` for a 5x and a 20x alike.

`organizationName` is dropped when it starts with the email — a personal account's org is literally
`"<email>'s Organization"`, the email restated in longer words — so the field means "a real
organization" wherever it survives.

### D7 — Identity, never liveness

`oauthAccount` is the last account the CLI wrote. It says who a dir **belongs to**, never whether the
login still works. That question already has an owner (`ProviderAuthService`, which shells out to the
CLI and fills `status`). A dir whose session expired still names its account here, and the two are
rendered apart so a stale email is never read as proof of a live session.

## Architecture

```
packages/cezar/src/agent-config/account-identity.ts
  readClaudeOauthAccount(dir)          ← the ONE place that knows where .claude.json is
    ├── readClaudeIdentity(dir)        → display rows        → GET …/agent-profiles/:id/details
    └── (imported by)
packages/cezar/src/workspace/agent-account-identity.ts
  readClaudeAccountIdentity(dir)       → {email, plan, organization} | null
  planLabel(fields)                    → "Max 20x"
  discoverClaudeAccounts(env)          → [{provider, path, identity}]
                                                              → GET …/agent-profiles/discovered
packages/web/src/routes/settings/accounts-section.tsx
  <DetectedLogins/>                    → the block, + POST …/agent-profiles on click
```

## Data models

```ts
interface AgentAccountIdentity {
  email?: string;         // oauthAccount.emailAddress
  plan?: string;          // derived, D6
  organization?: string;  // oauthAccount.organizationName, unless it restates the email
}

interface DiscoveredAgentAccount {
  provider: 'claude';
  path: string;                          // absolute config dir
  identity: AgentAccountIdentity | null; // null = the dir exists but records no login
}
```

Contract: `agentAccountIdentitySchema`, `discoveredAgentAccountSchema`,
`discoveredAgentAccountsResponseSchema` in `packages/contract/src/agent-profiles.ts`.
`agentProfileSchema` deliberately has **no** `identity` key (D5).

## API contracts

`GET /api/v1/workspace/agent-profiles/discovered` → `200`

```json
{
  "accounts": [
    {
      "provider": "claude",
      "configDir": "/Users/me/.claude",
      "identity": { "email": "me@example.com", "plan": "Max 20x" },
      "added": true
    },
    { "provider": "claude", "configDir": "/Users/me/.claude-bis", "added": false }
  ]
}
```

- Hosted mode (`!capabilities().localHandoff`) answers `{"accounts": []}` — these are absolute paths
  on the host, and an empty list is the only honest hosted answer, the same terms the rest of the
  family is withheld on.
- `identity` is an **absent key**, not `null`, when nothing was readable — the same spread discipline
  `status` follows on the listing.
- An unreadable account store degrades to `added: false` for every row: the POST still refuses a
  duplicate, so the cost is a refused click rather than two accounts silently sharing a session store.

Documented in `BACKWARD_COMPATIBILITY.md` §2.

## Phases

1. `workspace/agent-account-identity.ts` + unit tests. ✅
2. Contract schemas, the route, `BACKWARD_COMPATIBILITY.md`. ✅
3. `api-client` + `useDiscoveredAgentAccounts`, the `DetectedLogins` block. ✅
4. Back out the listing `identity` field, extract `readClaudeOauthAccount`, record D5 in place. ✅

## Risks

| Risk | Mitigation |
|---|---|
| A dir is labelled with **another** account's email | `claudeStateFilePath` is the single owner of the file location, reached through one shared reader (D2); the "reads each dir its OWN file" test is the direct negative control. |
| Discovery reads a credential file | Claude only, and Claude's state file holds no credential (D3). Codex is not discovered at all. |
| An email leaks onto a page nobody asked it for | The listing has no identity field; both identity routes are `localHandoff`-gated and fetched only on demand (D5). |
| A guessed plan name renders as confidently as a real one | No lookup table — the vendor's own string, de-snake-cased, when the shape is unrecognized (D6). |
| An expired login reads as live because an email is shown | Identity and `status` are separate fields, separate routes, rendered apart (D7). |
| Discovery silently registers accounts | It writes nothing; Add is an explicit click through the normal POST (D4). |

## Verification

**Automated** — `packages/cezar/src/workspace/agent-account-identity.test.ts` (13):

- `planLabel` reads the multiplier out of the tier, prefers the tier over the coarser
  `organizationType`, falls back to the de-snake-cased vendor string, and is `undefined` for nothing.
- `readClaudeAccountIdentity` reads the account, keeps a real org name and drops the restated-email
  one, answers `null` (never throws) for absent / empty / malformed / never-logged-in dirs, and —
  **the load-bearing one** — reads each dir its own file with a decoy `~/.claude.json` present.
- `discoverClaudeAccounts` finds default + siblings, **does not** offer a marker-less `~/.claude-notes`
  (negative control: the name prefix alone is not the recognizer), follows `CLAUDE_CONFIG_DIR` and
  lists that dir once, keeps a dir whose identity is unreadable, and answers `[]` on a machine with
  no Claude home.

`packages/cezar/src/server/agent-profiles-discovered-api.test.ts`: the route's shape, `added`
computed by realpath rather than by string, the hosted-mode empty answer, and the listing's **absence**
of an `identity` key (D5's regression guard).

`packages/web/src/routes/settings/accounts-section.test.tsx`: the block renders email · plan, hides
already-added dirs, posts the discovered `configDir` with the email as label, and is absent when
nothing is detected.

**Runtime E2E — NOT YET RUN (QA Needed).** `npm run dev`, then Settings → Agent accounts on this
machine, which has two real Claude logins (`~/.claude` and `~/.claude-bis`). The authoritative check
is that the detected rows name **different** emails — that is what proves the per-dir read, and it is
the one thing the unit tests can only assert against a fixture. Also: Add one, confirm the new
account's label is the detected email, and confirm the accounts listing response carries no
`identity` key (devtools → Network → `agent-profiles`).
