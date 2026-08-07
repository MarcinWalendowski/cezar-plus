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

**ADDED 2026-08-07 (post-review): after phases 4-5 the tier exists in storage and
is inert in the product, and the spec should say so rather than let the phase
table imply otherwise.** `IdentityStore.createTeam` has no HTTP caller;
`PATCH /auth/onboarding/team` is the only rename surface and the onboarding
wizard is its only client, reached once and never returned to; and a project's
team cannot be reassigned (`POST /api/v1/projects` prefers an existing claim and
discards an explicit `teamId` for an already-claimed root, correctly, since that
is what makes D4 a constraint). So `teamOptions` on the board can never hold more
than the one default team, and D2's own example — teams named `engineering` and
`marketing` — is unreachable from any user surface. **Team management (create /
rename / reassign, with the role checks that go with them) is its own phase and
is not in 4-5.** The wizard's copy was corrected to stop promising "you can
rename it again later", which nothing could deliver.

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

**CORRECTED again 2026-08-07 (post-review): one resolver was not enough, because
there were two readings of the INPUT.** Phase 4's onboarding routes resolved the
session cookie with `getCookie` from `hono/cookie` while everything else went
through `session.ts`'s own parser, and a docblock asserted the two read it "the
SAME way". On a `Cookie:` header carrying two `cez_session` values they do not:
measured on this repo's hono, `getCookie` returns the FIRST occurrence and
`session.ts` the LAST. So one request could create the org — and its `owner`
membership — as Alice while `requirePrincipal`, `verifyWsUpgrade`, `/auth/me` and
`PATCH /auth/onboarding/team` all acted as Bob. Cookies are not origin-scoped and
RFC 6265 §5.4 orders longer-`Path` cookies first, so an attacker who can set a
cookie on a sibling subdomain chooses which occurrence is first. There is now one
exported `readSessionIdFromCookieHeader` in `session.ts` (applying `SESSION_ID_RE`
too) and both callers use it. **D3 covers "who is this request" end to end — the
parse, not only the resolve.**

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

Until the per-org split ships (phase 6), **hosted means single-org**, and the
spec says so rather than letting a partial implementation imply otherwise.

**CORRECTED 2026-08-07: the paragraph above named the wrong phase number** —
the per-org split is phase 6 (the phase table's own row), not phase 4; phase 4
is orgs/teams/onboarding. Fixed in place; every other cross-reference in this
document already said "phase 6" and this was the one straggler.

**ADDED 2026-08-07 (docs pass, started ahead of phase 6/7 landing, CONFIRMED
once units 1-7 actually landed later in the same session): closing the process
boundary is necessary but not sufficient — nothing creates a SECOND org
either way, and this is now two independently-confirmed gaps, not one.**

Checked against the code, not assumed: `IdentityStore#createOrg`
(`auth/identity-store.ts:279`) has exactly one caller, `bootstrapFirstOrg`
itself, and that method's whole gate is `orgs.length > 0` — once *any* org
exists, every later `POST /auth/onboarding/org` 409s regardless of caller
(`bootstrapFirstOrg`'s own doc comment: "not a general ceiling on how many
`Org` rows can ever exist ... a future phase-6 multi-org tool would use it
too" — written at phase 4/5, anticipating phase 6 would add one). **D10's
8-unit ownership map does not add that tool, and the landed code confirms it
rather than merely the plan**: `supervisor/server.ts`'s `/internal/orgs` and
`/internal/orgs/:slug` (`:204-211`) are both `GET`; there is no `POST
/internal/orgs`. `auth/onboarding-routes.ts` is mounted into the supervisor
**verbatim** (`supervisor/server.ts:192-194`), gate included.

**CORRECTED 2026-08-07 (repair stage) — the second gap below is CLOSED; the
first one above is not.** The paragraph that follows says provisioning a
second org's infrastructure stops short of handing its secret to the
supervisor, so the org "cannot actually be reached until that's done by
hand". That is no longer true and must not be read as current. `hetzner.ts`
now ships an `org-register` step (`orgRegistrationStep`, between `org-systemd`
and `nginx` in `steps()`) that reads `CEZ_SUPERVISOR_ADMIN_TOKEN` and the
org's own `CEZ_SUPERVISOR_SECRET` out of their root-owned `0600`
`EnvironmentFile`s and `POST`s the record to `/internal/org-processes` — no
value printed, none in `argv`. The route it calls is `POST
/internal/org-processes`, not the `POST /internal/orgs/register` the text
below anticipated; the spelling changed, the capability is there. Its
`check()` and its post-write `verify` are the same function
(`isRegistered`), so "already done" and "did it take" cannot disagree, and
`undo` deprovisions the record rather than leaving the supervisor routing at
a unit that no longer exists.

The **existence check** that paragraph also asks for landed too, but in a
different place than it names, and the difference matters: it is in the
`org-register` step (`GET /internal/orgs/:slug`, `curl -f`, aborting with
"the supervisor knows no org with slug X — create it in the onboarding
wizard first"), **not** in `preflight`. `preflight` runs before any sudo, and
the check needs the root-owned admin token, so it cannot live there. The
practical consequence is unchanged from what D10 wanted — an unknown
`--org-slug` fails the install — but it fails four steps in, after the unix
user and the systemd unit already exist, rather than before anything is
written. `preflight` does now refuse one thing it never did: the same org
slug already provisioned on a second hostname (see `sibling` there).

**What has NOT changed: nothing creates a second `Org`.** The first gap above
stands exactly as written, and it alone is why "hosted means single-org" is
still true. `bootstrapFirstOrg` remains `createOrg`'s only caller, its
`orgs.length > 0` gate is untouched, and `supervisor/server.ts` exposes
`/internal/orgs` and `/internal/orgs/:slug` as `GET` only. So the honest
statement after phases 6/7 is: **provisioning a second org's infrastructure is
now fully automated, and there is still no way to create the org it would
serve.** Whoever closes that gap needs an authenticated org-create surface;
`org-register` is then already waiting for it.

The original text follows unchanged.

**A second, distinct gap surfaced once `hetzner.ts` itself landed, named by
its own author, not found independently by this docs pass**: even
provisioning a second org's *infrastructure* doesn't finish wiring it up.
`hetzner.ts`'s own module doc, "What this pass deliberately does NOT build"
(`:85-94`): `POST /internal/orgs/register` — the call that would hand a
freshly-provisioned org's `CEZ_SUPERVISOR_SECRET` to the supervisor's
`OrgProcessRegistryStore` so `/internal/auth-check` can actually route to it
— does not exist yet ("Fill unit 1's remaining work"). `orgSystemdStep`
prints the fields an operator would need to complete that registration by
hand once the route ships. Separately, `hetzner.ts`'s `preflight` does not
call `/internal/orgs/:slug` to confirm the named org exists before
provisioning (D10's text said it would); it only validates hostname
structure and that a supervisor instance exists locally — so `--org-slug`
accepts any slug today, whether or not that org has ever been onboarded.

So even a fully-landed phase 6 **and** phase 7 — every unix user, every
`CEZ_HOME`, every nginx vhost, working exactly as D10 specifies — still
cannot host a second **working** organization: there is no surface that
creates its identity, and no automated surface that finishes registering its
process even if one were created by hand. The OS-level isolation this phase
builds is real and independently valuable (it is what phase 7's own
verification exercises against a real second `IdentityStore` seeded
in-process, per the Verification section's own caveat that two REAL orgs
cannot be observed yet), but "hosted means single-org" does not become false
the moment units 1-7 land — it stays true for a *different* reason than the
one this paragraph gives today. **Whoever closes these gaps should treat them
as named work, not fold a fix in silently**: unit 1 needs `POST
/internal/orgs/register` (already scoped by `hetzner.ts`'s own doc) and an
authenticated org-create endpoint, and `hetzner.ts`'s `preflight` needs the
`/internal/orgs/:slug` existence check D10 originally specified. The docs
correction these gaps require — precise about what's real (isolation) and
what isn't (a second org) — is applied: see README's D4 blockquote and
`CHANGELOG.md`.

**AMENDED 2026-08-07 (post-review), two ways.**

1. **The constraint was enforced on create and ignored on destroy and modify.**
   Phase 5 put the check in `identity-store.ts#createProjectTeam` and in
   `POST /api/v1/projects`, and nowhere else — so `DELETE /api/v1/projects/:id`
   and `PATCH /api/v1/projects/:id` read no principal at all. With two orgs
   seeded, org B unregistered org A's project (200) and left the `project_teams`
   row behind as an orphan, which then blocked re-registration and made the old
   team stick to any later one. Both verbs now go through one `mayActOnRoot`
   helper and answer the same 409 `registerFolder` does, and a successful DELETE
   *releases* the claim (`IdentityStore#deleteProjectTeam`). The project-scoped
   *reads* deliberately stay open: D4 says cross-org isolation is the process
   boundary phase 6 delivers, and org-scoping one listing would read as an
   isolation control without being one. Destroying another org's registration is
   not tenancy-shaped behaviour, it is data loss, which is why that half could
   not wait.
2. **Phase 6 must REPLACE this check, not merely join it.** The phase-5
   enforcement is keyed on `<CEZ_HOME>/identity/identity.json`, i.e. it is
   in-process and per-`CEZ_HOME`. The moment phase 6 gives each org its own unix
   user and its own `CEZ_HOME`, each process sees only its own `project_teams`
   table, and two orgs registering the same root both succeed — reinstating
   exactly the leaseless-`RunStore` history loss this constraint exists to
   prevent, with all five gates green and the phase-5 suite still passing (it
   seeds both orgs in one store). Phase 6's row says so explicitly below.

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

New top-level segments (`auth`, `login`, `callback`, `onboarding`, `o`, `t`,
`internal`) must be added to the reserved-slug list **forward-only at allocation**
(`workspace/projects.ts:33-40`): retroactive reservation cannot evict a slug
already sitting in someone's registry. (`onboarding` was missed when phase 4 made
`/onboarding` a real top-level cockpit segment and added 2026-08-07 at the repair
stage — the same argument that put `auth`/`login`/`callback` on the list.)

**AMENDED 2026-08-07 (repair stage): "no new URL segment" cuts both ways, and
phase 7 added a segment nobody was watching.** The rule above was written about
segments the *cockpit* answers, so the reserved list was maintained against
`packages/web/src/routes.tsx`. Phase 7's generated org vhost adds two prefixes
that **nginx** answers, above the app: `location /internal/` (declared nginx
`internal;` — an external request gets 404 and never reaches the org process at
all) and `location /auth/` (proxied to the SUPERVISOR, not to this org). `auth`
was already reserved for the in-process reason; `internal` was not reserved at
all, so `allocateProjectSlug` could hand a repo named `internal/` a slug that
works perfectly on a laptop and 404s on a hosted host — the worst shape of D5
collision, because it cannot be reproduced where it was allocated. `internal` is
now on the list, and `projects.test.ts` asserts every prefix the generated org
vhost carves out is reserved, so a third carve-out fails a test instead of
shipping. The reserved list is therefore maintained against **two** route tables
now, the cockpit's and the vhost generator's.

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

1. **Sign in** (OIDC or Google). The first user to **name an organization**, and
   who can supply the deployment's bootstrap code, becomes its owner; subsequent
   users need an invite.
2. **Name the organization** — defaulted from the OIDC `hd`/email domain when
   present, editable.
3. **Create a default team.** Suggested and pre-filled, one click to accept, per
   the owner's ask. Named `General` unless the org name suggests better.
4. **Add projects**, assigned to that team. Reuses the existing registration
   flow; the only new input is the team.

Steps 2–4 are skippable and resumable — a half-finished onboarding must not
strand an org with no team, so the default team is created on org creation and
the step only renames it.

**AMENDED 2026-08-07 (post-review). Five corrections; step 1's wording above is
already the corrected one.**

1. **"the first user to *sign in*" was not implementable and is now "the first
   user to *name an organization*".** Signing in cannot create an org because an
   org needs a name. The implementation puts the gate in
   `IdentityStore.bootstrapFirstOrg` as `orgs.length > 0`, checked on the
   snapshot re-read fresh under the write lease (D7), which also closes the
   two-simultaneous-first-timers race the literal reading would leave open.
2. **ADDED: being first is not, on its own, permission to own a shell.** D8 never
   said who is *allowed* to be first, and phase 4 shipped the literal reading:
   with `CEZ_AUTH=google` the issuer is pinned to Google, so the eligible set was
   every Google account on the internet, and the first stranger to reach
   `/auth/login` became owner. Reproduced end to end at review: `GET
   /api/v1/runs` 401 → one `POST /auth/onboarding/org` → 201 `role: "owner"` →
   `POST /api/v1/workflows` 201 with a free-form `command:` that a check step
   runs through `spawn('bash', ['-lc', …], { env: process.env })`, i.e. Problem
   §3. Closed by `auth/bootstrap-claim.ts`: with `CEZ_AUTH` on, claiming a fresh
   deployment requires a **bootstrap code** the operator can see and the network
   cannot — generated and printed to the boot log by default,
   `CEZ_AUTH_BOOTSTRAP_TOKEN` to pin your own, `CEZ_AUTH_BOOTSTRAP_OPEN=1` to opt
   back into "whoever signs in first". This is D1's own doctrine one layer in: it
   does not enforce a policy, it enforces *choosing*, and the safe option is what
   you get by doing nothing. The gate is one-shot by construction — it is only
   consulted by the route `bootstrapFirstOrg` already makes unreachable once an
   org exists, so a leaked code afterwards grants nothing.
3. **ADDED: `needs-invite` is a state, not only a 409.** "Subsequent users need
   an invite" shipped as a refusal on a form the wizard had already invited the
   user to fill in: the status route reported `needs-org` to *every*
   membership-less user, so the second person to sign in was shown "Name your
   organization", typed a name, and was told they needed an invite that no
   surface in the product can produce. `onboardingStateSchema` now has three
   states and the wizard renders a terminal "ask an owner to invite you" screen,
   carrying nothing about the existing org.
4. **STILL MISSING, and named here so the next phase owns it: there is no invite
   HTTP surface.** `IdentityStore.createInvite`/`redeemInvite`/`revokeInvite`
   exist, are guarded and are tested; nothing calls them. Until a create/redeem
   route, a `packages/contract/src/invites.ts` and the owner-side UI land, a
   phases-4/5 deployment holds exactly one org and exactly one member. Phase 4's
   verification row ("invite required for the second user") is therefore
   half-satisfied: the refusal exists, the invite does not.
   **Whoever builds it must not assume `role` is enforced.** As of this repair
   stage exactly one route reads `principal.role` —
   `PATCH /auth/onboarding/team`, restricted to `owner`/`admin`. Every
   `/api/v1/*` route treats `member` and `owner` identically, including
   `POST /api/v1/workflows` (shell) and `PUT /api/v1/workspace/config` (which
   moves `browseRoot`, the containment root project registration is checked
   against in hosted mode). That is consistent with D4's "members of an
   organization can run code as one another", but it means an `admin`/`member`
   invite grants everything an owner has, and the invite phase is where that
   becomes reachable and therefore where the decision has to be made.
5. **`hd` never reaches step 2.** `auth/oidc.ts` extracts only
   `issuer`/`subject`/`email`/`name`/`role` from the verified ID token and
   nothing persists an `hd` claim, so `suggestedOrgName` is derived from the email
   domain alone — and `PERSONAL_EMAIL_DOMAINS` deliberately suppresses
   `gmail.com`, so a personal-Google first user gets an empty required field.
   Wiring `hd` end to end (oidc → callback → `userSchema` → store) is additive and
   deferred; it is a defaulting nicety, not a correctness gap, but for a Google
   Workspace deployment `hd` is *the* org signal and the spec named it first for
   that reason.

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

### D10 — the phase 6/7 seam: the supervisor owns auth and identity; org processes trust a forwarded signature

**ADDED 2026-08-07, scaffold pass ahead of phase 6/7 implementation.** Three recon passes over
`server-install/`, the runtime (`paths.ts`, `server.ts`, `runs/store.ts`, …) and the uid boundary
itself converged on one blocking gap: **the spec never said whether the supervisor or each org's
own process terminates authentication**, and the two readings are mutually exclusive —

- *Org process terminates* ⇒ N identity stores, N OIDC clients, N IdP-registered `redirect_uri`s
  (D9's exact-match rule), and the supervisor never learns who anyone is, so it cannot own the
  root→org mapping D4 assigns it.
- *Supervisor terminates* ⇒ org processes run `CEZ_AUTH` unset ⇒ `principal.kind === 'local'` ⇒
  phase 5's `mayActOnRoot`/`releaseRootClaim`/`registerFolder` checks (all gated on
  `principal.kind !== 'session'`) **evaporate rather than get replaced**, silently satisfying "the
  phase-5 check must be replaced" by deleting the only thing there was to replace.

D7 already answers this, one layer in, and phase 5's code just doesn't reflect it yet:
`identity-store.ts:85-89`'s own doc comment says *"under D4 this store is written only by the
single supervisor process"* — not one identity store per org. **Resolved: the supervisor
terminates auth and is the only process that ever opens `<CEZ_HOME>/identity/*.json`.** Concretely:

**The supervisor is a cezar process, not a new program.** `cezar supervisor` (new subcommand,
`src/index.ts`) boots with its OWN `CEZ_HOME` (never equal to any org's, and never the operator's
real `~/.cezar` — same "own dedicated unix user, own dedicated home" posture D4 asks of an org,
applied to the process that holds every org's identity and secrets, which is the single highest-
value target on the box). It imports **`auth/routes.ts`'s `authRoutes` and
`auth/onboarding-routes.ts`'s `onboardingRoutes` verbatim** — both are already self-contained,
already-landed `Hono` instances with zero dependency on `server.ts`'s general-purpose app — and
mounts them exactly as a phase 1-3 single-process deployment does today. `auth/session.ts`'s
existing `sessionResolver` singleton, `IdentityStore`, `bootstrap-claim.ts` and `oidc.ts` are used
**unmodified**. Two things are genuinely new, both owned by the not-yet-built Fill unit 1:

1. An `/internal/auth-check` route for nginx's `auth_request` directive: resolve the request's
   session cookie via the existing `sessionResolver.resolveFromCookieHeader`, and on a resolved
   `Principal`, sign it with `forwarded-principal.ts#signForwardedPrincipal` (below) using that
   caller's org's secret, returning it as the two headers nginx's `auth_request_set` captures and
   `proxy_set_header` forwards to the org's own upstream. No session ⇒ plain 401, same as every
   other unauthenticated `/api/v1/*` request today.
2. `/internal/orgs/*` — thin reads over `IdentityStore` (list orgs, resolve an org by slug) that
   the hetzner platform's `--provision-org` step (D10 below) calls to look up the `orgId` an
   operator names by slug, so a provisioning record never has to duplicate identity data.

**The org process is `cezar serve`, unmodified, running with a new `CEZ_AUTH=supervisor` value.**
Under it: `resolveAuthProvider` (`server/capabilities.ts`) and `authProviderSchema`
(`packages/contract/src/health.ts`) gain the literal `'supervisor'` — one line each, and
`auth-boot-gate.ts` needs **no change at all**: its whole decision is `provider !== 'none'` ⇒
proceed, which already covers any named provider. The org process's `SessionResolver`
(`server/server.ts`'s existing interface) is a **new**, small implementation
(`auth/forwarded-principal.ts`'s `verifyForwardedPrincipal` + `principalFromForwardedPayload`,
already written and tested this pass — see below) wired in `index.ts`'s existing "which resolver
does `CEZ_AUTH` import" dynamic-import branch, alongside the existing `oidc`/`google` case. It
never imports `identity-store.ts` or opens `identityDir()` — there is nothing there to open, since
this process's `CEZ_HOME` carries no `identity/` directory at all. `SessionResolver#
resolveFromCookieHeader` gains one optional second parameter carrying the forwarded headers
(TypeScript's "fewer params is assignable to more params" rule means every existing implementation,
including `auth/session.ts`'s own, satisfies the widened interface with **zero edits** — this is
additive, not a rename):

```ts
resolveFromCookieHeader(cookieHeader: string | undefined, forwarded?: ForwardedPrincipalHeaders): Principal | null
```

**Why a signature, not bare header trust.** Every org's process still binds loopback-only, per D4 —
but loopback is one namespace shared by every unix user on the host, uid-separated or not. Trusting
whatever headers arrived is one nginx-config mistake away from any local process forging
`X-Cezar-Role: owner` directly against another org's port. A **per-org** HMAC secret
(`CEZ_SUPERVISOR_SECRET`, minted at provisioning, `EnvironmentFile`-delivered — see below) makes a
forged header fail at the org process itself regardless of how it arrived, the same "verify where
it's actually enforced" reasoning D6 already applies to the WebSocket upgrade rather than trusting
that Hono's middleware ran. **This pass wrote the full contract, signed and verified, with tests —
`packages/cezar/src/supervisor/forwarded-principal.ts` / `.test.ts`** — so Fill units 1 (signs) and
5 (verifies) converge on one scheme instead of each inventing one, which is exactly the
"two-literals-hand-kept-in-sync" drift D3's own history (`server.ts`'s `LOCAL_PRINCIPAL` vs.
`auth/principal.ts`'s `LOCAL_IDENTITY`) already named as a real failure mode once in this repo.

**The phase-5 in-process check is replaced by deletion at the call site, not by a new local
check.** `withTeams`/`mayActOnRoot`/`releaseRootClaim` (`server.ts:2594-2656`) and
`registerFolder`'s claim block all gate on `principal.kind !== 'session'` and, when it IS
`'session'`, open `IdentityStore.open(identityDir())` **in the org process** — which under D4 holds
no identity data and is precisely the "each process sees only its own table" hazard the phase-6 row
warns about. Fill unit 5 replaces those four call sites with a small HTTP client
(`supervisor/registry-client.ts`, new) that asks the supervisor's `/internal/*` surface instead —
which, because the supervisor is the ONE process with `identityDir()`, is calling the very same
`IdentityStore#getProjectTeam`/`createProjectTeam`/`deleteProjectTeam`/`listProjectTeams` methods
phase 5 already built and tested, just from across a process boundary instead of in-process. No new
storage, no new lease mechanism — the O_EXCL lease D7 already took care of is what makes this safe
to call concurrently from N org processes in the first place.

**Org identity (self-service) and org infrastructure (operator-run) are deliberately two separate
steps — D8's onboarding never provisions a systemd unit, and it must not start to.**
`POST /auth/onboarding/org` is reachable by any authenticated first user (guarded only by the
bootstrap code, D8 amendment 2) — letting it trigger unix-user creation or a systemd unit write
would hand a network request root-adjacent power over the host, which is exactly the shape D1
exists to refuse elsewhere. So: onboarding creates the `Org` row only (unchanged, phase 4 code).
Turning that row into a running process is `cezar server-install --platform hetzner --domain
<org-hostname> --org-slug <slug>` — an operator command requiring shell/sudo on the host, resolving
`slug` against the supervisor's `/internal/orgs/*` lookup before it provisions anything.

**Hostname/TLS topology: one base domain, one supervisor login host, org hostnames are its
subdomains — not arbitrary customer domains, for phase 7.** D9's `redirect_uri` exact-match rule
means an IdP registration names ONE host; the auth_request pattern (nginx forwards the session
cookie from the ORIGINAL request to the supervisor as a subrequest) only works when that cookie is
visible on every org's hostname, which requires `Domain=.<base-domain>` cookie scoping — i.e. every
org hostname must be a subdomain of the same base domain the login host uses. This resolves what
recon flagged as an unsolved per-org IdP-registration cost: with this topology there is exactly
**one** registered `redirect_uri` for the whole deployment, ever, regardless of org count. Fully
custom per-org domains (`acme-corp.com` rather than `acme.<base>`) are explicitly out of scope for
phase 7; note it as a real limitation rather than letting it surface as a surprise later.
`auth/session.ts#serializeSessionCookie` needs one additive change to carry a configurable
`Domain=` (new optional `CEZ_SESSION_COOKIE_DOMAIN`, unset preserving today's host-only cookie
exactly — a single-process phase 1-5 deployment sets nothing and is untouched).

**nginx's role is unchanged in kind, widened in routing.** Per hostname: `/auth/` and `/internal/`
(marked `internal;`, unreachable from outside) proxy to the supervisor; `/` runs `auth_request
/internal/auth-check` then proxies to that org's own loopback port with the signed headers
attached. D5 ("no new URL segment") holds exactly as before — every change here is which upstream
nginx picks, never a path a client sees.

**The org's port must be a hard bind, not today's "auto-picks the next free port".**
`pickPort`/`serveCommand` (`index.ts`) silently falling back to the next free port (documented,
protected behaviour, BACKWARD_COMPATIBILITY.md §1) is exactly wrong here: nginx's `proxy_pass` is
rendered with a specific port at provisioning time, and a process that silently drifted to the next
free one would have nginx forwarding one org's traffic into another org's — or a stranger's —
process. The zero-config default (`cezar serve`, no flags) must NOT change. Fill unit 6 adds a new
opt-in flag (`--port-strict`, or an env var of the same shape as every other `CEZ_*` opt-in) that
makes an explicit `--port` a hard requirement (`EADDRINUSE` fails startup loudly) rather than a
preference, and only the hetzner unit's `ExecStart` sets it.

**Secrets go in a root-owned `EnvironmentFile=`, never a unit's `Environment=` line.**
`systemctl show <unit>` is readable by any local user regardless of which org's uid it runs as —
exactly the cross-org leak D4 exists to prevent. `CEZ_SUPERVISOR_SECRET` (and, on the supervisor's
own unit, `CEZ_OIDC_CLIENT_SECRET`/`CEZ_AUTH_BOOTSTRAP_TOKEN` if pinned) belong in
`EnvironmentFile=/etc/cezar/<slug>.env` at `0600`, written the way the existing `htpasswd` step
already does it — payload on stdin, never `printf %s <content>` into the operator's terminal or a
sudo-note transcript (`ubuntu-vps.ts`'s `writeFileStep`/`writeRootFileCmd` echo their content by
design; this is a different, narrower write shape and needs its own step, not that one
parameterised).

#### Ownership map — the 8 units, no file overlap

| # | Unit | Owns (new files unless noted) | Reads (imports, never edits) |
|---|---|---|---|
| 1 | Supervisor core | `src/index.ts` (new `supervisor` subcommand only — coordinate with unit 6, which owns the REST of `index.ts`'s edits), `supervisor/server.ts`, `supervisor/index.ts`, `supervisor/auth-request.ts`, `supervisor/paths.ts` (new home/registry-path helpers — never touches the existing `paths.ts`), the org-process-registry STORE built around `supervisor/org-process-registry.ts`'s schema (this pass) | `auth/routes.ts`, `auth/onboarding-routes.ts`, `auth/session.ts`, `auth/identity-store.ts`, `supervisor/forwarded-principal.ts` (this pass) |
| 2 | Unix user + `CEZ_HOME` provisioning | `server-install/platforms/hetzner/provision-user.ts` (+ test) — pure generators only, per this task's safety rules: useradd/mkdir/chown/`git config --global --add safe.directory` commands, never executed here | `server-install/steps.ts` (the `sudoStep`/stdin-secret idiom) |
| 3 | Per-org + supervisor systemd unit generation | `server-install/platforms/hetzner/systemd-unit.ts` (+ test) — new functions, does NOT edit `ubuntu-vps.ts#systemdUnit` (invariant 6) | may import `ubuntu-vps.ts`'s exported `sysd()` escaping helper if exported additively; else a 3-line duplicate, noted as such |
| 4 | nginx vhost + hostname routing | `server-install/platforms/hetzner/nginx.ts` (+ test) — org vhost (`auth_request` + signed-header forwarding) and the supervisor's own base config (`/auth/`, `/internal/` `internal;`) | none |
| 5 | Root→org registry replacement + principal resolution | `server/server.ts` (edit: the 4 call sites named above), `auth/principal.ts` (edit: new `authProvider: 'supervisor'` branch), `supervisor/registry-client.ts` (new — the HTTP client org processes use to reach unit 1's `/internal/*`) | `supervisor/forwarded-principal.ts` (this pass, unmodified) |
| 6 | `hetzner` platform installer | `server-install/platforms/hetzner.ts` (+ test), `server-install/strategies.ts` (register `'hetzner'`), `server-install/types.ts` (extend `PLATFORM_IDS`), `src/index.ts` (help text, `--domain`/`--org-slug` flag plumbing, the new `--port-strict` flag/env — coordinate with unit 1 on the `supervisor` subcommand addition) | units 2/3/4/7's generators |
| 7 | TLS / certificate issuance | `server-install/platforms/hetzner/tls.ts` (+ test) | may import `ubuntu-vps.ts`'s certbot command shape if exported; else a short duplicate |
| 8 | Docs | `docs/server-install/hetzner.md` (new), `docs/server-install/README.md` (provider table), `README.md` + `packages/cezar/README.md` (correct the single-org claim **only once phase 6 actually lands** — do not correct it early, since the boundary it describes does not exist until then), `CHANGELOG.md`, `.env.example` (every new `CEZ_*` named in this section: `CEZ_SUPERVISOR_SECRET`, `CEZ_SESSION_COOKIE_DOMAIN`, the port-strict flag, `CEZ_AUTH=supervisor`) | — |

`supervisor/forwarded-principal.ts` and `supervisor/org-process-registry.ts` (+ their tests) are
this scaffold pass's own output, already landed by the time any of the 8 units start — treat them
as frozen contracts, not drafts to revise independently.

#### Named separately: two defects this recon surfaced that are NOT phase 6/7 work

Neither belongs in the 8 units above — raising them here so they are not lost, not so they get
folded in.

- **P0, pre-existing, unrelated to this spec: `macosx-ngrok`'s generated launchd plist never
  gained `CEZ_ALLOW_UNAUTHENTICATED=1`** (`server-install/platforms/macosx-ngrok.ts`'s
  `cezarLaunchdPlist`), so under the CURRENT `auth-boot-gate.ts` every existing and fresh
  `macosx-ngrok` host refuses to boot — verbatim the defect D1's amendment 2 fixed for `ubuntu-vps`
  and missed on this platform. This needs its own immediate, narrowly-scoped fix (one line plus the
  `ubuntu-vps.test.ts:259-288`-shaped pairing test's macOS twin), independent of phase 6/7.
- **The existing multi-instance docs overstate isolation today, before phase 6 changes anything.**
  `docs/server-install/ubuntu-vps.md:183-208` calls two `--domain` instances on one host "fully
  independent cockpits" — they share one unix user and therefore one `~/.cezar` project registry,
  identity store and agent credentials. Worth a docs correction on its own, separate from this
  spec's phase 6/7 work (which is what actually makes two cockpits independent).

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
| 4 | orgs/teams/memberships + onboarding UI (D2, D8) | first user owns the org **and had to supply the bootstrap code**; default team exists the moment the org does; the second user is refused and told `needs-invite` |
| 5 | project→team mapping + filtering (D5) | one root in two orgs is refused at registration **and on DELETE/PATCH**; team filter on the board |
| 5b *(new, not yet built)* | invite create/redeem HTTP surface + the role decision it forces (D8) | a second member exists, joined by invite; what an `admin`/`member` may do is decided rather than inherited |
| 5c *(new, not yet built)* | team management: create/rename/reassign (D2) | a project can be moved between two real teams; the board filter has more than one option |
| 6 | per-org process supervisor + nginx (D4) | two orgs ⇒ two unix users, two `CEZ_HOME`s, no shared path; org A cannot read org B's runs. **The phase-5 in-process `project_teams` check must be REPLACED by the supervisor's mapping, not joined by it** — per-org `CEZ_HOME`s make each process blind to the other's table, so two orgs would both succeed at claiming one root with every gate green (D4's amendment) |
| 7 | `server-install --platform hetzner` (D4) | provisions from clean; OIDC replaces `auth_basic`; TLS |

Phases 1–3 are useful alone (a single-org authenticated deployment). Phase 6 is
what makes "multi-tenant" true, and until it lands the docs say single-org.

**CORRECTED 2026-08-07 (docs pass): "what makes multi-tenant true" overstates
what phase 6 delivers on its own.** Phase 6 makes the *isolation* true — a real
uid/process/filesystem boundary an operator could put a second org behind. It
does not make *multi-tenant* true, because nothing in phases 1-7 as scoped
creates a second org to put behind it (see the D4 addendum above, and D10's
ownership map, unit 1). Read "until it lands the docs say single-org" as still
correct after phase 6/7 land, not stale — for the new reason, not the old one —
until an org-creation surface exists.

**ADDED 2026-08-07 (scaffold pass): phase 6's "supervisor" and phase 7's `hetzner` platform have a
shared design now — D10, in the Decisions section above. Read it before starting either row.**
It resolves the auth-termination question the phase-6 row's own text left open, defines the
forwarded-principal contract (written and tested this pass:
`packages/cezar/src/supervisor/forwarded-principal.ts`), and gives an 8-way ownership map so
phase 6 and phase 7 can be filled in parallel without two units editing the same file.

**AMENDED 2026-08-07 (post-review): 5b and 5c are new rows, and they are not
polish.** They were implicit in D8 and D2 and were read as delivered by phase
4/5 because the storage layer for both exists and is tested. It does, and
nothing calls it: without 5b a deployment holds exactly one member forever, and
without 5c the team tier the board filters on can never have a second value. Two
rows in a table are cheaper than a reviewer rediscovering that twice.

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
- **The CORS-open health route is outside the perimeter, and it carries the
  registry.** `ADDED 2026-08-07.` `/api/v1/health` is exempt from
  `requirePrincipal` — it must be, since the bookmarklet's port sweep runs before
  any cookie for the origin exists — and the exemption's own comment justified
  itself with "it carries no per-principal data, so skipping identity resolution
  here widens nothing." True about principals and beside the point: the payload's
  `projects[].name` is every registered repository's name, and
  `Access-Control-Allow-Origin: *` means any page on the internet can *read* the
  response, not merely force the request. #431 already basename-redacted
  `repoRoot` for exactly this reason and did not cover the sibling field. The
  route now redacts `projects` to `[]` when `CEZ_AUTH` names a provider and the
  request carries no valid session; `bootProject` deliberately stays (the SPA
  shell's redirect gate reads it before any `/api/v1/*` call can succeed). The
  auth-off payload is untouched, and there is a test asserting exactly that — the
  redaction is gated on `CEZ_AUTH`, so the control this Risks entry is about
  stays byte-identical.
- **The zero-config bundle is the control's other half.** `ADDED 2026-08-07.`
  Phase 4 statically imported the onboarding wizard into the cockpit's entry
  chunk, adding 6.90 kB raw / 2.02 kB gz that every `CEZ_AUTH`-unset install
  downloads and parses for a page whose auth-off render is one sentence. The
  route is `lazy()` now. A payload regression on the npm default counts as a
  zero-config regression even when no JSON changed.
- **`ADDED 2026-08-07 (D10 scaffold pass).` Port auto-drift silently routes one org's traffic to
  another's process.** `pickPort` (`index.ts`) falls back to the next free port by design and is a
  protected default (BACKWARD_COMPATIBILITY.md §1) — but nginx's per-org `proxy_pass` is a static
  port baked in at provisioning time, so a drifted bind is not a startup failure, it is silent
  cross-tenant traffic. Fill unit 6's `--port-strict` opt-in (D10) must ship in the SAME change that
  wires it into the hetzner unit's `ExecStart`, never after.
- **A secret in `Environment=` is readable by any local user, any org's uid included.**
  `systemctl show <unit>` does not check whose unit it is. `CEZ_SUPERVISOR_SECRET` and any OIDC
  client secret the supervisor's own unit carries must go through `EnvironmentFile=` at `0600`,
  written via stdin like the existing htpasswd step — never through `writeRootFileCmd`'s
  content-echoing sudo-note path, which is fine for a public vhost and wrong for a secret.
- **Phase 7's hostname/TLS topology is one base domain, not arbitrary customer domains** (D10). A
  fully custom per-org domain needs a different, unbuilt mechanism (per-org IdP registration, no
  shared cookie domain) — call this a limitation in the phase 7 release notes, not a surprise a
  customer discovers.

## Verification

Beyond the per-phase table: an end-to-end on a real Hetzner VPS — provision from
clean with `server-install`, sign in through a real Google account and a real
generic OIDC provider (Keycloak or Authentik), **read the bootstrap code out of
`journalctl -u cezar` and paste it into the wizard**, create an org, accept the
default team, register a project, start a run, and confirm from a second org's
session that neither its runs nor its knowledge base are reachable.

**ADDED 2026-08-07 (D10 scaffold pass).** For phase 7 specifically, "provision from clean" means
the supervisor's OWN unit first (a **system**-scope unit under its own dedicated unix user, per
D10 — deliberately not the `systemctl --user`-preferred path `ubuntu-vps.ts#autostartStep` defaults
to, which cannot express a per-org or per-supervisor unix user at all), then one `--domain
--org-slug` run per org. `journalctl -u cezar` for the bootstrap code (below) is correct for this
topology precisely because the supervisor is forced onto a system unit — the ambiguity recon
flagged against `ubuntu-vps`'s user-scope default does not apply to `hetzner`. The additional
things only that VPS run settles for D10 specifically: the `auth_request` → signed-header → org-
process round trip against REAL nginx (not a generated-string assertion), that a session cookie set
by the supervisor's login host is actually visible to nginx's subrequest on an org's subdomain
(`Domain=` cookie scoping, live), and that two orgs' `EnvironmentFile` secrets are in fact
unreadable to each other's unix user on a real filesystem.

`forwarded-principal.ts`'s sign/verify contract itself does not need that VPS — it is pure
functions over strings, and this pass's own test suite
(`packages/cezar/src/supervisor/forwarded-principal.test.ts`) already covers the round trip, cross-
org secret rejection, tampering, staleness and future-dated clocks. What the VPS adds for that
piece specifically is only the wiring: that nginx actually calls `auth_request` before proxying,
and that the headers it sets are the ones the org process reads.

**ADDED 2026-08-07: what only that VPS can settle**, listed so the difference
between "tested" and "QA Needed" is not left to interpretation. Everything below
is exercised by unit/route tests against a real `IdentityStore` here, and none of
it is *evidence* until it runs against a real IdP on a real host:

- The bootstrap code end to end: that it actually reaches the systemd journal in
  a readable form, that a restart before onboarding mints a new one, and that the
  banner stops once the org exists.
- The `/auth/callback` → `/onboarding` redirect through a real IdP's cross-site
  top-level navigation, with the real `SameSite=Lax` session cookie and the real
  `state` cookie — a `Set-Cookie` that a browser silently drops behind TLS
  termination looks identical here to one it keeps.
- `hd` and the email-domain default against a real Google Workspace account and a
  real Keycloak realm, including the personal-Gmail case that leaves the field
  empty.
- The health redaction from a genuinely third-party origin, not a synthetic
  `Origin:` header — and that the signed-in cockpit's workspace views still
  enumerate projects behind nginx.
- Two REAL orgs. Every cross-org assertion in this repo seeds both orgs in ONE
  `IdentityStore` inside one process, which is precisely the arrangement phase 6
  abolishes; the D4 boundary as specified cannot be observed until two unix users
  and two `CEZ_HOME`s exist.

Until that has actually been run against a live VPS this ships as **QA Needed**,
not Done. A local `--platform ubuntu-vps` dry run is not the same evidence: the
things that break here — TLS, redirect URIs, forwarded headers, systemd users —
are precisely the ones a local run does not exercise.

**ADDED 2026-08-07 (phase 6/7 repair stage): the QA-Needed list GREW when
phases 6 and 7 landed, and saying so is the point.** Every item above still
stands. Phases 6 and 7 are the first work in this spec whose deliverable is
*generated text a machine executes elsewhere* — systemd units, an nginx config,
root shell commands — so the gap between "asserted" and "observed" is wider here
than in any earlier phase, not narrower. The repair stage's own discipline was
to assert on generated output and never execute it (no unix user created, no
service manager run, no port bound, no `~/.cezar` touched), which is the correct
discipline and also exactly why the following cannot be closed from here:

- **Every privileged command's actual effect.** `install -d -m 0700 -o cez-acme`,
  `useradd --create-home`, `systemctl enable --now`, `nginx -t`, `certbot
  --nginx`, `git config --global --add safe.directory` — all of these are pinned
  as *strings* by tests that read the generated command. Nothing here has ever
  run one. A quoting bug that survives `shquote` review, a `useradd` flag an
  Ubuntu release deprecated, an `install` that succeeds and produces the wrong
  mode: each looks identical to correct from this side.
- **The `auth_request` round trip end to end**, which is the whole of D10. The
  supervisor's signing (`auth-request.ts`), nginx's forwarding (`nginx.ts`) and
  the org's verification (`forwarded-session.ts`) are each tested, and the header
  *names* are imported rather than re-typed so they cannot drift. What no test
  here can show is nginx actually performing the subrequest, capturing
  `$upstream_http_x_cezar_principal` under that spelling, and overwriting a
  client-supplied header with it.
- **That `CEZ_SESSION_COOKIE_DOMAIN` actually produces a cookie a browser sends
  to `acme.<base>`.** This variable was generated-and-never-read until the repair
  stage; it now has a consumer and a test, but the test asserts a `Set-Cookie`
  *string*. Whether a real browser scopes it as intended across a real
  `login.<base>` → `acme.<base>` navigation is a browser behaviour, and this
  repo cannot observe browser behaviour.
- **`org-register` against a real supervisor.** The command is asserted; the
  `curl -f` failure modes, the `sed`-out-of-an-`EnvironmentFile` parse, and the
  bootstrap ordering (an org registered before its unit is enabled vs. after) are
  not. Note its failure is *silent by construction from the outside*: an org whose
  process record is missing answers 401 to an anonymous request, which is also
  what a correctly-installed org answers, so a passing install does not prove the
  registration landed.
- **Upgrade, not just install.** `server-install` has already provisioned real
  hosts on earlier versions. `describeBootGateUpgradeRisk` reads a literal
  `systemctl show` transcript transcribed from `v0.9.2` and warns correctly
  against it — but "correctly warns" was verified against a string, and an actual
  upgrade of an actual pre-phase-6 host is unobserved. So is the interaction of a
  changed unit file with an already-enabled unit.
- **`ProtectSystem=full` + the agent CLIs.** The hardening set is chosen and
  argued (`ProtectHome` deliberately absent, `full` not `strict`), and it is
  entirely untested against a real `claude`/`codex` run inside the unit. A
  hardening directive that breaks an agent CLI at runtime is invisible until an
  agent CLI runs under it.
- **The uid boundary itself, which is phase 6's verification row verbatim.** "Two
  orgs ⇒ two unix users, two `CEZ_HOME`s, no shared path; org A cannot read org
  B's runs" cannot be observed here at all, and — per the D4 correction above —
  cannot yet be observed on a real host either, because nothing creates the
  second org. What a VPS run *can* settle today is the one-org shape: that the
  isolation primitives (user, home mode, `WorkingDirectory`, `EnvironmentFile`
  ownership) are what the generators claim.

So the honest status after this repair stage is: phases 6 and 7 are **QA Needed
with a longer list than any earlier phase**, and one line of their stated
verification is **not reachable at all** until an org-creation surface exists.
