# Organizations, teams, optional auth, and hosted onboarding

Status: **Draft**

## TLDR

Add `Organization → Team → Project` with onboarding, generic OIDC and Google
OAuth, deployable to a Hetzner VPS — **without enforcing auth**. Off, cezar is
byte-for-byte the zero-config single-user tool that ships on npm today. On, it is
a multi-org deployment where **cross-org isolation is an OS process boundary**
and within-org sharing is documented rather than implied.

The middle tier is called **Team**, not "workspace". See D2.

## Problem

Four facts about cezar today, each established by reading it:

1. **Nothing authenticates.** There is no user, session, cookie, bearer check or
   ACL anywhere in `packages/cezar/src` or `packages/web/src`. The entire
   perimeter is three middlewares: a 32 MiB body limit
   (`server/server.ts:1276`), a loopback-Host + same-origin-write guard
   (`:1312`), and a CORS-open health route (`:1497`), plus `verifyWsUpgrade`
   (`:5341`).

2. **Hosted mode removes the Host allowlist and puts nothing in its place.**
   The guard's own comment says it is skipped in hosted mode "where the reverse
   proxy forwards the real public Host and **TLS+auth own the perimeter**"
   (`server.ts:1288-1291`) — an auth that does not exist. And
   `cezar server-install --platform ubuntu-vps` already ships that deployment:
   an nginx vhost with `auth_basic` + htpasswd in front of one systemd unit
   running as the operator's unix user with `CEZ_REMOTE=1`
   (`server-install/platforms/ubuntu-vps.ts:154-155, 566-591`). Hosted cezar
   today is **one shared password in front of one shared shell**.

3. **A request can author a shell command.** `POST /api/v1/workflows` accepts
   YAML whose `command` is a free-form string
   (`packages/contract/src/workflows.ts:35`), and a `check` step runs
   `spawn('bash', ['-lc', command], { cwd, env: process.env })`
   (`workflows/run.ts:3441`) — the one spawn that bypasses the `#427`
   `buildChildEnv` allowlist and sees the whole server environment. Agent steps
   default to unrestricted `Bash`; Codex runs `danger-full-access` with
   `approvalPolicy: never`. Isolation is git worktrees, not uid or container.

4. **The run index has no lock.** `RunStore.saveNow` rewrites all of
   `runs.json` with tmp+rename on a 300 ms debounce, with no lease
   (`runs/store.ts:1005-1010`) — even though the same repo uses an `O_EXCL`
   lease (`openSync(path, 'wx', 0o600)`) in `automations/store.ts:212` and
   `sources/store.ts:236`. Two processes over one project's `.ai/cezar` destroy
   each other's history silently.

Taken together: adding a login to the existing process would produce a system
that *looks* multi-tenant and is not. Authentication and isolation are separate
problems and this spec keeps them separate.

## Decisions

### D1 — auth is opt-in, and the default path does not change

`CEZ_AUTH` selects a provider: unset/`none` (default), `oidc`, or `google`.
Unset means **zero I/O**: no database file created, no session middleware
mounted, no login route registered — the same discipline as `CEZ_KB` and its
siblings, which do no filesystem work to decide they are off.

But "optional" cuts by deployment, not by one global switch:

| Bind | `CEZ_AUTH` | Result |
|---|---|---|
| loopback | unset | today's behaviour, unchanged. The npm default. |
| loopback | `oidc`/`google` | login required locally (useful for testing the flow) |
| hosted | `oidc`/`google` | login required |
| hosted | unset, `CEZ_ALLOW_UNAUTHENTICATED=1` | boots, logs a startup warning naming the risk |
| hosted | unset, no flag | **refuses to boot**, naming the reason |

The refusal is the point. An operator who treats their private network as the
perimeter says so once, deliberately; nobody exposes a shell by forgetting a
variable. This does not enforce auth — it enforces *choosing*.

**AMENDED 2026-08-07 (post-review), two ways the first implementation got this
wrong:**

1. **The refusal ran too late to be a refusal.** It sat after `initWorkspace`
   (writes `~/.cezar`), `reclaimWorktrees` (*deletes* worktree directories) and
   `manager.recover()` (re-queues and resumes interrupted agent runs). A hosted
   no-auth box therefore did all of that and only then declined to serve. The
   decision, its two messages and its exit code now live in
   `packages/cezar/src/auth-boot-gate.ts`, and `serveCommand` calls it as its
   **first** statement — before any of the above — leaving only
   `if (!gate.proceed) return;` at the call site. It is its own module because
   `src/index.ts` is the CLI entry: importing it runs the CLI, so an inline gate
   was untestable by construction, and a mutation turning the refusal into
   `if (false && …)` passed all five gates. `auth-boot-gate.test.ts` walks every
   row of the table above.
2. **The one deployment cezar itself ships was left unbootable.**
   `server-install --platform ubuntu-vps` writes `Environment=CEZ_REMOTE=1` and
   nothing else, so every existing host would have died on upgrade and a fresh
   install would have provisioned a service that never starts. That installer now
   also writes `Environment=CEZ_ALLOW_UNAUTHENTICATED=1` — the correct row of the
   table for it, since the same installer puts an nginx `auth_basic` vhost in
   front, so the operator genuinely has said "my proxy is the perimeter" and the
   installer states it on their behalf at the moment it installs the proxy that
   backs it. `ubuntu-vps.test.ts` feeds the generated unit's own `Environment=`
   lines to `resolveAuthBootGate` and asserts both directions, so the two files
   cannot drift apart again. Phase 7's `--platform hetzner` sets `CEZ_AUTH`
   instead and must not write this flag.

The startup refusal message must name the actual consequence, not "auth
required": *"hosted mode with no authentication exposes shell execution to
anyone who can reach this port (POST /api/v1/workflows → spawn bash). Set
CEZ_AUTH, or CEZ_ALLOW_UNAUTHENTICATED=1 if your network is the perimeter."*

### D2 — the middle tier is **Team**

`Organization → Team → Project`. Teams are `engineering`, `marketing`.

**Not "workspace".** In cezar, *workspace* already means the per-OS-user machine
scope: `~/.cezar/` (`paths.ts:16-20`), `WorkspaceEventBus`,
`workspace/semaphore.ts`, and ~15 `/api/v1/workspace/*` routes that
`route-parity.test.ts:177-192` asserts are **absent** from the project manifest
because they are single-mount by contract. Reusing the word would make a
released, test-enforced surface lie about its own scope, and renaming the
existing one is a breaking change to a published API.

"Team" is also the word Linear uses for exactly this tier, and Linear is the
stated reference.

### D3 — ONE resolver, both modes

Auth-off resolves to an implicit principal — a synthetic `local` user, in a
default org, in a default team — through the *same* code path an authenticated
request takes. There is no "if auth is off, skip the resolver" branch.

This is not stylistic. On 2026-08-06 this repo shipped exactly that shape
elsewhere: `ProjectContexts.build()` activated the knowledge and source stores,
`createApp`'s hand-built `bootContext` did not, and the two paths silently
disagreed until the knowledge base was dead on the only project the cockpit
opens by default. Two authorization paths would drift the same way, and what
drifts is who is allowed to do what.

**CORRECTED 2026-08-07 (post-review).** The first implementation violated this
decision in the most literal available way: a `LOCAL_PRINCIPAL` literal in
`server/server.ts` **and** a byte-identical `LOCAL_IDENTITY` literal in
`auth/principal.ts`, with the auth-off request short-circuiting to the former
before any resolver call — and a comment conceding the two were "hand-kept in
sync ... by convention, not by shared code". Nothing asserted they matched.
`server.ts` now imports `resolvePrincipal` and its auth-off constant *is*
`resolvePrincipal({ authProvider: 'none' })`, so there is one construction.

The static import was the thing weighed against D1's "unset means zero I/O", and
the trade is sound: `auth/principal.ts` has no runtime imports of its own (its
only import of `server.ts` is `import type`, which TypeScript erases, so there is
no cycle), reads no file, and touches nothing under `<CEZ_HOME>/identity`. A
module-load trace of `dist/index.js` confirms it is the **only** `dist/auth/*`
module loaded on the `CEZ_AUTH`-unset path. D1's own gloss on zero I/O is "no
database file created, no session middleware mounted, no login route registered",
and all three still hold.

### D4 — isolation is a process per org

Decided by the owner, 2026-08-06.

- **Cross-org: a real boundary.** One cezar process per organization, each with
  its own unix user, its own `CEZ_HOME`, its own systemd unit. A supervisor plus
  nginx routes a request to its org's process. Two orgs share no filesystem and
  no process.
- **Within-org: shared, and said out loud.** Members of one org share a shell,
  the host's `claude`/`codex` credentials, and cost. The documentation must
  state: *"members of an organization can run code as one another. Invite
  accordingly."* Not a footnote.

The justification is honest rather than convenient: everyone in an org already
has commit rights to the same repos, so the shell adds little there. Across orgs
it would be catastrophic, so that boundary is real.

**Hard constraint from problem 4:** a project root may belong to exactly one
org. Registering one root under two orgs puts two processes on one
`.ai/cezar`, and `RunStore` has no lease — that is silent history loss, not a
leak. Enforced at registration by the supervisor, which owns the only mapping
of root → org.

Until the per-org split ships (phase 4), **hosted means single-org**, and the
spec says so rather than letting a partial implementation imply otherwise.

### D5 — no new URL segment

Because org is determined by *which process answers*, it needs no path segment;
nginx routes by hostname (`acme.cezar.example.com`) or path prefix at the proxy,
above the app. Team is metadata on a project used for grouping and filtering,
not a scope.

So `/api/v1/...` and `/api/v1/p/<id>/...` are untouched, and the three-spelling
route parity (`/api/v1/x` ≡ `/api/v1/p/<boot>/x` ≡ `/api/v1/p/default/x`) — a
protected surface whose manifest is derived from the live route table so new
routes auto-enrol — survives unchanged. Adding an `/o/<org>/` prefix would have
multiplied that alias set and handed every path-keyed gate a fresh way to be
wrong.

New top-level segments (`auth`, `login`, `callback`, `o`, `t`) must be added to
the reserved-slug list **forward-only at allocation**
(`workspace/projects.ts:33-40`): retroactive reservation cannot evict a slug
already sitting in someone's registry.

**AMENDED 2026-08-07 (post-review).** Root-mounting `/auth/*` also put it outside
the `#426` origin guard, which was registered on `app.use('/api/*', …)` only —
making `POST /auth/logout` the only unguarded write in the application. A page on
another *loopback port* is same-**site**, so its `SameSite=Lax` session cookie
rides along, which is exactly the case the guard's own comment names ("on a dev
machine `http://localhost:3000` is every bit as foreign as `https://evil.tld`").
The guard is now one handler registered on **both** `/api/*` and `/auth/*`; the
"no new URL segment" decision stands, but a route family living outside `/api/`
must be added to the perimeter explicitly, because nothing derives it.

### D6 — the session is a cookie, and the WebSocket check is separate

`packages/web/src/api/client.ts:330` already sends `credentials: 'include'` and
has no header seam, and both SSE streams use `withCredentials: true`. So a
`HttpOnly; Secure; SameSite=Lax` session cookie fits with no client rewrite.

**The WebSocket upgrade is attached to the raw HTTP server, not Hono**
(`server.ts:5304`), so `app.use` middleware never runs for it and the
BACKWARD_COMPATIBILITY drift guard cannot inventory it. The auth check must be
duplicated inside `verifyWsUpgrade` (`server.ts:5341`), where today
`origin === undefined` is trusted. A cookie-authenticated fetch that passes
while the socket upgrade does not check is the exact shape of a bypass, so this
gets its own test asserting an unauthenticated upgrade is refused — the negative
control must exercise the socket, not the route beside it.

Browser WebSocket cannot send `Authorization`, which is why a cookie is the only
workable session carrier here and a bearer token is not.

**STATUS 2026-08-07: the required negative control now exists**, having initially
shipped without one. `server/ws.test.ts` → `describe('when CEZ_AUTH names a
provider')` refuses an upgrade with no cookie, with a rejected cookie, and with no
resolver wired at all, asserts the check runs *before* the `origin === undefined`
trust (otherwise any non-browser client bypasses auth by omitting a header), and
admits a valid session so the refusals are not "auth on means always false". The
HTTP twin is `server/auth-perimeter.test.ts`. Both were missing at first review,
and deleting either guard left all five gates green — the exact shape D6 exists to
name.

### D7 — identity storage is JSON behind the existing `O_EXCL` lease

**CORRECTED 2026-08-06, before implementation.** This decision first read
"SQLite via `node:sqlite`… Not JSON: these are relational, concurrently written,
and want real constraints (a unique index is what makes 'one root, one org' true
rather than hoped for)." The reasoning about constraints stands; the mechanism
does not, and was checked rather than assumed:

- `node:sqlite` is **absent** at cezar's supported floor. `package.json` declares
  `engines: {"node": ">=20"}`, and `require('node:sqlite')` throws
  *"No such built-in module"* even on the local Node **v22.12**.
- `better-sqlite3` is a **native** dependency. cezar's runtime deps today are
  `@clack/prompts, @hono/node-server, hono, smol-toml, ws, yaml, zod` — all pure
  JS. Adding a compiled module breaks `npx cezar-cli` on any platform without a
  prebuild, which is the product's entire first-run story.
- A runtime "SQLite if available, else JSON" fallback would be two storage code
  paths, which D3 exists to forbid.

**So:** `<CEZ_HOME>/identity/*.json`, written through the same `O_EXCL` lease
idiom the codebase already uses (`openSync(path, 'wx', 0o600)` —
`sources/store.ts:236`, `automations/store.ts:212`), with tmp+rename for the
write itself. House style, no new dependency, and unlike `RunStore` it actually
takes the lease.

The uniqueness that a `PRIMARY KEY` would have given is enforced **inside the
lease** — read, check, write, release — which is sound precisely because the
lease serializes writers. Write it as one guarded helper, not as a check at each
call site, or the guarantee decays to "every caller remembered".

Scale makes this comfortable rather than a compromise: identity is tens to
thousands of rows, and under D4 it is written by the single supervisor process,
not by N org processes.

Created lazily on first authenticated boot. `CEZ_AUTH` unset ⇒ the module is
never imported.

`RunRecord` gains an optional `createdBy` (`packages/contract/src/runs.ts`).
Optional because every run already on disk has no author and must keep loading;
absent renders as "—", never as a guessed owner.

### D8 — onboarding

First authenticated boot with no org:

1. **Sign in** (OIDC or Google). The first user to sign in becomes owner of a
   new org; subsequent users need an invite.
2. **Name the organization** — defaulted from the OIDC `hd`/email domain when
   present, editable.
3. **Create a default team.** Suggested and pre-filled, one click to accept, per
   the owner's ask. Named `General` unless the org name suggests better.
4. **Add projects**, assigned to that team. Reuses the existing registration
   flow; the only new input is the team.

Steps 2–4 are skippable and resumable — a half-finished onboarding must not
strand an org with no team, so the default team is created on org creation and
the step only renames it.

### D9 — OIDC and Google

Authorization Code + PKCE, `state` and `nonce` verified. Generic OIDC is the
implementation; Google is that implementation with a pinned issuer, not a second
code path — one code path per D3's reasoning.

- Discovery via `/.well-known/openid-configuration`, JWKS cached with a bounded
  TTL and refetched on unknown `kid`.
- `redirect_uri` must be an exact registered match, which means the deployment's
  public origin has to be known at boot (`CEZ_PUBLIC_URL`) — the one place a
  hosted deployment cannot infer its own identity from the request, because
  trusting a forwarded header for it is how open redirects happen.
- Group/role mapping from a configurable claim, defaulting to none. An
  unrecognised group grants nothing; membership is never inferred from a claim
  the operator did not map.
- **ADDED 2026-08-07 (post-review): `state` is bound to the browser, not only to
  the server.** "`state` verified" as written meant only "this server issued it",
  because the pending map is process-global. That leaves login CSRF / session
  fixation: the attacker starts the flow against the deployment's own
  `/auth/login`, completes it at the IdP as themselves, then navigates the victim
  to the resulting `?code=&state=` — `SameSite=Lax` permits a cookie-setting
  response to a cross-site top-level GET, so the victim's browser ends up pinned
  to the attacker's identity. Today the damage is capped only because a user with
  no membership resolves to no principal and everything 401s anyway; **D8 step 1
  ("the first user to sign in becomes owner of a new org") is precisely the change
  that uncaps it**, so it was closed before that phase rather than after.
  `/auth/login` now mirrors `state` into a short-lived `HttpOnly; Secure;
  SameSite=Lax` cookie and `/auth/callback` requires the query `state` to equal
  it, checked *before* `completeAuthorization` and without consuming the pending
  entry (so a spoofed callback cannot cancel the real browser's in-flight login).
  `Lax` rather than `Strict` is load-bearing: the callback arrives as a cross-site
  top-level navigation from the IdP, and a `Strict` cookie would not be sent with
  it. Not `__Host-` prefixed, because that requires `Secure` and D1's table
  supports `CEZ_AUTH=oidc` on a plain-http loopback deployment for testing.

## Data Models

Expressed as SQL because it states the constraints exactly; the storage is JSON
under D7, and every `UNIQUE` / `PRIMARY KEY` below is a check performed inside
the write lease.

```sql
CREATE TABLE orgs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE teams (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL, slug TEXT NOT NULL,
  UNIQUE (org_id, slug)
);
CREATE TABLE users (
  id TEXT PRIMARY KEY, subject TEXT NOT NULL, issuer TEXT NOT NULL,
  email TEXT, name TEXT, created_at TEXT NOT NULL,
  UNIQUE (issuer, subject)          -- identity is (issuer, sub), never email:
);                                   -- email is mutable and reassignable
CREATE TABLE memberships (
  user_id TEXT NOT NULL REFERENCES users(id),
  org_id  TEXT NOT NULL REFERENCES orgs(id),
  role    TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
  PRIMARY KEY (user_id, org_id)
);
CREATE TABLE project_teams (
  project_root TEXT PRIMARY KEY,     -- realpath. PK, not just indexed:
  org_id  TEXT NOT NULL REFERENCES orgs(id),   -- one root, ONE org (D4) —
  team_id TEXT NOT NULL REFERENCES teams(id)   -- RunStore has no lease
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
```

`users` is keyed on `(issuer, subject)` and not on email deliberately: an email
can be reassigned to a different human inside a company, and keying identity on
it hands that human the previous holder's org membership.

## Phases

| # | Work | Verification |
|---|---|---|
| 1 | `CEZ_AUTH` capability + boot refusal (D1) | off ⇒ health payload and every route byte-identical to today; hosted+no-auth+no-flag exits non-zero with the message; the flag permits boot |
| 2 | identity.db + principal resolver (D3, D7) | auth-off resolves the implicit principal through the SAME resolver; no db file exists when off |
| 3 | OIDC + Google, cookie session, **WS upgrade check** (D6, D9) | full code+PKCE flow; bad `state` rejected; expired session 401s; **unauthenticated WS upgrade refused** — its own test |
| 4 | orgs/teams/memberships + onboarding UI (D2, D8) | first user owns the org; default team exists the moment the org does; invite required for the second user |
| 5 | project→team mapping + filtering (D5) | one root in two orgs is refused at registration; team filter on the board |
| 6 | per-org process supervisor + nginx (D4) | two orgs ⇒ two unix users, two `CEZ_HOME`s, no shared path; org A cannot read org B's runs |
| 7 | `server-install --platform hetzner` (D4) | provisions from clean; OIDC replaces `auth_basic`; TLS |

Phases 1–3 are useful alone (a single-org authenticated deployment). Phase 6 is
what makes "multi-tenant" true, and until it lands the docs say single-org.

## Risks

- **Shipping the word "multi-tenant" before phase 6.** The largest risk here is
  not technical. A deployment with auth and orgs but one process is a shared
  shell with a login screen, and calling it tenancy invites someone to onboard a
  customer into it. The README states the boundary that exists today, and phases
  are named for what they actually deliver.
- **The `check`-step spawn stays broad.** Auth changes *who* can reach it, not
  what it does. Narrowing it (an env allowlist on that spawn like `#427` applies
  elsewhere) is worth its own spec and is not in scope here — but it must not be
  described as mitigated by auth, because it isn't.
- **Zero-config regression.** The npm default is the product for most users. The
  route-parity, bc-route-inventory and versioned-surface suites are the control;
  a diff in the auth-off health payload is a failure, not an update.
  **HELD 2026-08-07.** The first implementation added `capabilities.auth` to the
  health payload and edited ~20 fixture files to expect it — updating the control
  to match the change, which is the one move that makes a control stop meaning
  anything. Reverted: `CEZ_AUTH` is read by `resolveAuthProvider` at the two call
  sites that need it and is **not** a capability, so the auth-off payload is
  byte-identical to the pre-auth build. `capabilities.test.ts` now asserts the
  absence directly, so re-adding the key fails a test rather than only ~20
  fixtures whose edits are what made the first attempt look green. Nothing
  consumed the field; whichever phase builds a login screen adds it deliberately.
- **A guard the suite cannot reach.** `CEZ_AUTH` is read *per request*, so an
  ambient `CEZ_AUTH=oidc` in a developer's shell or a CI runner turned every
  `createApp`-based suite red at once and blamed route parity
  (`CEZ_AUTH=oidc npx vitest run …/route-parity.test.ts` → 6 failed | 3 passed).
  `packages/cezar/vitest.setup.ts` now deletes it once per worker, the way
  `CEZ_HOME` is pinned; the suites that mean to exercise auth set it per test.
- **Cookie + SSE + WS drift.** Three transports, one session. The WS path is the
  one that bypasses Hono, so it is the one that will silently miss a change.
- **`CEZ_PUBLIC_URL` misconfiguration** breaks the OIDC redirect with an opaque
  provider-side error. Validate at boot and fail loudly, rather than at first
  login.

## Verification

Beyond the per-phase table: an end-to-end on a real Hetzner VPS — provision from
clean with `server-install`, sign in through a real Google account and a real
generic OIDC provider (Keycloak or Authentik), create an org, accept the default
team, register a project, start a run, and confirm from a second org's session
that neither its runs nor its knowledge base are reachable.

Until that has actually been run against a live VPS this ships as **QA Needed**,
not Done. A local `--platform ubuntu-vps` dry run is not the same evidence: the
things that break here — TLS, redirect URIs, forwarded headers, systemd users —
are precisely the ones a local run does not exercise.
