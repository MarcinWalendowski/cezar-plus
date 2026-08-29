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

> **PARTLY SUPERSEDED 2026-08-07 by D13 (local-mode onboarding).** The sentence
> above conflated two things that D13 separates: *authentication* (still fully
> off, and still zero I/O — no session middleware, no login route, no cookie
> parsed, no 401 ever) and *organization scope* (which a local user may now
> create deliberately). Precisely: with `CEZ_AUTH` unset cezar still creates
> **nothing** on its own — `<CEZ_HOME>/identity/` comes into existence only if
> the local user completes the onboarding wizard and asks for an org. Until
> then the behaviour above holds exactly as written, which is why D1's landed
> controls (`projects-api.test.ts`'s five "no identity directory is created"
> assertions) stay green unchanged. What is no longer true is the *implication*
> that auth-off can never have an org: it can, because the local user asked.
> See D13 for why that is not an authorization change.

But "optional" cuts by deployment, not by one global switch:

| Bind | `CEZ_AUTH` | Result |
|---|---|---|
| loopback | unset | ~~today's behaviour, unchanged. The npm default.~~ **AMENDED TWICE, 2026-08-07.** D13: no login, no session, no 401 — but the local user may create an org. **D14 (owner decision, supersedes "unchanged"):** the cockpit is now *gated* on onboarding — no dashboard element renders until the first org exists, so the npm default DOES change for existing users. Auth behaviour is still unchanged; the landing experience is not. |
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

**CORRECTED 2026-08-07 (phase 5c landed): the paragraph below describes a state of affairs
that phase 5c ended, and its framing — that this needed its own phase — is what 5c was.**
`IdentityStore.createTeam` has an HTTP caller now (`POST /auth/teams`, `auth/team-routes.ts`,
D12-gated, beside `PATCH`/`DELETE /auth/teams/:teamId` and a Settings → Teams pane); a
project's team IS reassignable (`PATCH /api/v1/projects/:projectId`'s `teamId` field over
`IdentityStore#updateProjectTeam`); and `teamOptions` on the board is sourced from `GET
/auth/teams` rather than derived from already-claimed projects, so a team with no projects is
selectable. **D2's own example — `engineering` beside `marketing` — is reachable from the
product.** The original text follows unchanged.

**AMENDED 2026-08-07 (5b/5c/8 repair stage): the tier has a floor of one, enforced in the
store.** `DELETE /auth/teams/:teamId` refuses (409, `team-is-last`) when the named team is the
last one in its org. Not a route-level nicety: every membership resolves through a team
(`session.ts#resolveIdentity` reads `listTeams(orgId)[0]`), so an org with zero teams cannot be
signed into by *anybody*, including its owner, and no route can create one back — the org is
bricked, permanently, by one successful admin action. The check therefore lives in
`IdentityStore#deleteTeam` under the write lease, beside every other uniqueness invariant (D7),
rather than in the handler, so a second caller cannot race past it. Read D2 as
"`Organization → Team → Project`, with at least one Team, always".

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

**CORRECTED 2026-08-07 by D13: the module-load-trace sentence above is now FALSE
on the loopback-bind branch of the `CEZ_AUTH`-unset path.** D13's local-mode
onboarding dynamically imports `auth/identity-store.ts`, `auth/local-gates.ts`,
`auth/onboarding-routes.ts`, `auth/team-routes.ts` and `paths.ts`, and — transitively,
via those last two's own static imports — `auth/session.ts` too, on every loopback
boot with `CEZ_AUTH` unset (the npm zero-config default), gated on
`isLocalOrgModeActive`, not on `CEZ_AUTH` naming a provider. `auth/principal.ts`
remains the *statically*-imported one — that half of the sentence still holds
literally — but it is no longer the only `dist/auth/*` module the trace would show
on that path. D1's own gloss on zero I/O still holds in its narrower,
behavioural sense: none of the newly-reached modules performs filesystem I/O at
import time (`IdentityStore.open` is a bare constructor; see `auth/session.ts`'s
own doc comment, corrected the same way), so "no database file created" survives
for a user who never opens the onboarding wizard — it is "the module is never
imported" that no longer does.

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

**CORRECTED 2026-08-07 (phases 5b/5c/8 landed): the sentence below is FALSE and this is the
one correction in this document where the FACT changed rather than the reason.** A hosted
cezar can now hold more than one organization: `POST /internal/orgs` (admin-only, D11)
creates the row, the hetzner installer's `org-create` step calls it, and `claimOrg` (the
renamed `bootstrapFirstOrg`) grants that org's first owner via `POST /auth/onboarding/org`
with an `orgSlug` and that org's own claim code. The sentence is kept below unchanged because
every "hosted means single-org" reference elsewhere in this document was written against it;
read each of those as superseded by D11 too, not as a second, still-standing claim.

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

**CORRECTED 2026-08-07 (phases 5b/5c/8 landed) — the heading below is now false and every
one of the four facts it rests on has changed.** `createOrg` has a second caller (`POST
/internal/orgs`, admin-only, `supervisor/server.ts`); that route exists, so `/internal/orgs`
is no longer `GET`-only; `bootstrapFirstOrg` is renamed `claimOrg` and its `orgs.length > 0`
gate now guards only the legacy first-org branch, while the `orgId` branch guards "this org
already has a member" instead; and the hetzner installer calls the new route from its
`org-create` step. The honest statement after phases 5b/5c/8 is therefore: **provisioning a
second org's infrastructure is automated AND the org it serves can now be created — by an
operator holding `CEZ_SUPERVISOR_ADMIN_TOKEN`, never by a browser request (D11).** The
original paragraph is kept below unchanged because the paragraphs above it were written
against it.

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

> **CORRECTED 2026-08-07 by D13.** The second sentence is now: `CEZ_AUTH` unset
> ⇒ the module is never imported **until the local user creates an org through
> the onboarding wizard**, and never imported at all if they don't. The trigger
> changed from "is auth on?" to "does an org exist, or is one being created?" —
> a `POST` to the onboarding route, or a cached-miss check that finds
> `identity.json` present. A local read never creates the directory
> (`readSnapshot` degrades a missing file to an empty snapshot,
> `identity-store.ts:1291`), so "cezar created identity state I never asked
> for" stays false. The `users` row written on that path carries
> `issuer: 'local'` — see D13 for why that keeps `findOrCreateUser`'s
> `(issuer, subject)` key honest rather than bypassing it.
>
> **CORRECTED AGAIN 2026-08-07 (phase 9 HTTP-surface pass): the paragraph above
> is itself now superseded — "never imported until an org exists" describes an
> intermediate build, not what shipped.** Once D13's route-mounting landed,
> `local-mode-boot.ts#buildLocalModeRoutes` imports `identity-store.ts`
> unconditionally on every loopback boot with `CEZ_AUTH` unset — regardless of
> whether an org exists yet — because `onboarding-routes.ts`/`team-routes.ts`
> need `IdentityStore.open` wired in to answer `GET /auth/onboarding`'s
> `needs-org` state at all, not only once `POST /auth/onboarding/org` is
> called. So the trigger is "is the bind loopback with `CEZ_AUTH` unset", not
> "does an org exist, or is one being created" — importing the module and
> *creating identity state* are the two different things this correction
> conflated. What still holds, unchanged: `IdentityStore.open` and a local
> read both still do no filesystem I/O, so "cezar created identity state I
> never asked for" stays false for a user who never opens the wizard. See
> `paths.ts#identityDir`'s own doc comment for the fuller, source-checked
> account.

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

> **SUPERSEDED 2026-08-07 by D15 for step 4 only.** Step 4 is no longer
> skippable: onboarding does not complete until the org owns at least one
> project. Steps 2–3 remain skippable exactly as described below, and the
> resumability property below is unchanged and now load-bearing (a user who
> quits at step 4 must resume there, not be stranded). See D15 for the three
> ways step 4 can be satisfied and for why boot auto-registration must not
> satisfy it silently.

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
4. **CORRECTED 2026-08-07 (phase 5b landed): the heading below is false — the
   invite HTTP surface exists.** `auth/invite-routes.ts` ships `POST /auth/invites`
   (mint, 256-bit hex token, TTL bounded to `[15 min, 30 days]`, 7-day default),
   `GET /auth/invites`, `POST /auth/invites/revoke` — all three D12-gated by
   `require-org-admin.ts`'s middleware, ahead of validation — and `POST
   /auth/invites/redeem`, deliberately NOT role-gated because the caller has no
   membership yet. `packages/contract/src/invites.ts` is its wire contract, and
   the routes are mounted on BOTH the single-process app and the supervisor. So
   phase 4's verification row ("invite required for the second user") is fully
   satisfied rather than half: the refusal exists and so does the invite. **What
   the paragraph asks for that is still open: the owner-side invite UI.** No
   cockpit surface creates or redeems an invite yet — an operator or owner drives
   these routes directly today. The role question it raises is answered by D12
   below, which was written for exactly this reason.
   The original text follows unchanged.

   **STILL MISSING, and named here so the next phase owns it: there is no invite
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
exists to refuse elsewhere. **CORRECTED 2026-08-07 (5b/5c/8 scaffold pass) by D11, for the
SECOND-and-later org only — the sentence that follows is no longer true in that one case; the
reasoning above it (self-service identity, operator-run infrastructure, kept as two steps) still
stands and is exactly why D11 exists.** So: onboarding creates the `Org` row only (unchanged, phase
4 code) — **true for the deployment's first-ever org, on either topology; false for org two
onward, where `POST /internal/orgs` (admin-only, D11) creates the row instead and onboarding only
grants the caller's `owner` membership on it.** See D11's own text below, and its 5b/5c/8 scaffold
addendum, for the exact split and why the first org keeps the self-serve path.
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

### D11 — creating the *second* organization is an operator action, not a user action

Added 2026-08-07, after phases 6/7 landed and the multi-org story turned out to be
unreachable. Phase 6 automated every piece of infrastructure for org two — a unix user, a
`CEZ_HOME`, a systemd unit, an nginx vhost, a supervisor process record — and left no way to
create the organization those serve. `bootstrapFirstOrg` is `createOrg`'s only caller and its
guard is `orgs.length > 0`; the supervisor's `/internal/orgs*` routes are `GET` only. So phase
6's own verification row ("two orgs ⇒ two unix users…") is not reachable here **or on a real
host**, and the whole uid boundary is, today, infrastructure with nothing on the far side.

**Creating an organization requires root.** It provisions a unix user, a home directory, a
systemd unit and an nginx vhost. No request from a browser can do that, and no application role
should be able to: handing org creation to an org `owner` would let any tenant create unix users
and consume host resources, which inverts the very boundary D4 exists to draw. D4's isolation is
a *uid* boundary, so the authority to mint one belongs to whoever already holds root.

So org creation splits into two halves with **two different authorities**:

1. **The org row** — created by the installer through a new admin-only `POST /internal/orgs`,
   authenticated by `CEZ_SUPERVISOR_ADMIN_TOKEN`, the same credential
   `POST /internal/org-processes` already requires. The installer runs as root and already holds
   it, so this adds no new trust: it makes an existing capability reachable rather than granting
   one. `requireAdmin` already covers `/internal/orgs*`, so the new verb inherits the
   authorization-before-validation ordering rather than re-deciding it.
2. **The org's first owner** — claimed by the first user to sign in at *that org's hostname* with
   *that org's* bootstrap code, exactly as org one is claimed today. Unchanged mechanism, and
   D9's bounded-audience reasoning carries over verbatim.

   **CORRECTED 2026-08-07 (5b/5c/8 repair stage): "at *that org's hostname*" is wrong, and it was
   wrong when written — an org's own process cannot serve a claim.** Under D10 an org process runs
   `CEZ_AUTH=supervisor` and deliberately mounts none of `authRoutes`/`onboardingRoutes`/
   `inviteRoutes`/`teamRoutes` (`packages/cezar/src/index.ts`'s `provider === 'supervisor'` branch,
   which exists precisely so a second login surface never appears on a loopback port every local
   uid can reach). `POST /auth/onboarding/org` therefore exists **only on the supervisor**, and its
   claim branch is keyed on the `orgSlug` in the request body plus that org's `claimTokenHash` —
   the Host header is never read. As landed: the owner signs in at the deployment's **login host**
   and enters slug + code. Two things follow that the original wording hid. First, the docs
   telling an operator to send the owner to `<slug>.<base>` were sending them to a 401 loop, and
   `README.md`, `docs/server-install/hetzner.md` and `CHANGELOG.md` all carried that instruction —
   now corrected in place. Second, "exactly as org one is claimed today" is what made the
   supervisor's missing bootstrap banner invisible in review: `cezar serve` printed the code and
   `cezar supervisor` never did, so on the one platform this spec is written for, org ONE was
   unclaimable too unless `CEZ_AUTH_BOOTSTRAP_TOKEN` had been pinned at install. Fixed at this
   stage (`supervisor/index.ts#supervisorBootLines`, pinned by `supervisor/index.test.ts`).

**`bootstrapFirstOrg` therefore changes meaning, not shape:** from "create the first org" to
"claim an unclaimed org". Its guard becomes *this org already has an owner*, not *any org
exists*. That was always the honest reading — the check existed to stop a second **claim**, and
capped orgs at one only incidentally. Renaming it to say so is part of this phase, because a
function called `bootstrapFirstOrg` that no longer creates anything is exactly the stale name a
future session would trust.

**What this makes false.** The single-org claim in the README, the CHANGELOG and this spec stops
being true the moment this lands — and unlike the last two corrections, the *fact* changes rather
than the reason. Every one of those sentences must be corrected in place, and phase 6's
verification row becomes runnable for the first time. Do not land this phase and leave them
standing.

### D12 — `role` gates org administration, and never code execution

Added 2026-08-07. Phase 5b was left with "what an `admin`/`member` may do is decided rather than
inherited", and an implementer should not be the one deciding it, because the tempting answer is
wrong in a way that reads as security.

**`owner` / `admin` gate org administration**: creating and revoking invites, renaming the org,
creating/renaming/reassigning teams, removing members. **`member` gets everything else**,
including `POST /api/v1/workflows` and every agent-run surface.

**Role must NOT be used to restrict code execution.** D4 already states the honest position —
*"members of an organization can run code as one another. Invite accordingly."* Everyone in an
org shares one unix user, one `CEZ_HOME`, one set of `claude`/`codex` credentials and one shell.
A `role !== 'member'` check in front of `POST /api/v1/workflows` would not create a boundary; it
would only *look* like one, while the member reaches the identical shell through any other agent
surface. An isolation control that isn't one is worse than none, because it is what the next
reader trusts when deciding who to invite.

The line is therefore: **role decides who can change the org; the uid decides who can run code.**
If a deployment genuinely needs members who cannot execute code, that is a second org (D4's real
boundary), not a role — and the docs should say so rather than implying a role would do.

**OPEN 2026-08-07 (5b/5c/8 integration pass), and deliberately NOT decided here: which side of
that line `PATCH /api/v1/projects/:projectId`'s `teamId` field falls on.** D12's list above
names "creating/renaming/reassigning teams" as gated, and phase 5c's row says "team
management: create/rename/reassign" — so reassigning a project between teams reads as gated.
It shipped ungated: `/auth/teams*`'s three write verbs go through `requireOrgAdmin`, and this
field goes through `mayActOnRoot` (D4's same-org check) alone, so a `member` can move any
project between their org's teams. Two written artifacts pull apart on the fix, which is why
an integration pass should not pick a side quietly:
- **D12's own list** says gate it.
- **`auth/require-org-admin.ts`'s module doc** says, flatly, "DO NOT mount this in front of
  `POST /api/v1/workflows`, **any other `/api/v1/*` route**, or any agent-run surface", and
  names `/auth/*` org-administration routes as its one legitimate mount family.
The prohibition's stated reason is code execution, which this field is not — D5 calls team
"metadata on a project used for grouping and filtering, not a scope", so a `member` moving a
project between teams gains and loses no access whatsoever. That argues the prohibition wants
scoping rather than a blanket ban. But it is also a route a `member` may legitimately call
(for `maxParallel`), so the gate would be FIELD-level, not route-level, and therefore cannot
be middleware — which means it cannot inherit the authorization-before-validation ordering the
rest of D12's gates get by construction. **Whoever resolves this owns two edits, not one:** the
check itself, and re-scoping `require-org-admin.ts`'s prohibition so the next reader is not
choosing between a decision and a docblock.

**OPEN 2026-08-07 (5b/5c/8 repair stage), also deliberately not decided here: an `admin` can mint
an `owner` invite.** `POST /auth/invites` takes `role` from the body and validates it against
`roleSchema` alone, so an `admin` can create an invite that makes its redeemer an `owner` — and
`owner` is not a higher tier of anything today, because D12's list is flat: `owner` and `admin`
are the same set of permissions, and the only asymmetry anywhere in the system is that the
deployment's claim path mints `owner`. So the escalation is currently **inert**: an `admin` can
produce another principal with exactly the permissions they already have. It is recorded rather
than fixed because it stops being inert the moment anything is made owner-only (org deletion,
billing, removing the last admin, transferring ownership), and at that point the fix is a
one-line rank check at the route — not a redesign. The reason not to add that check now is D12's
own discipline about not deciding a policy in an implementation pass: "an `admin` may not mint an
`owner`" is a real product rule with a real consequence (an org whose only `owner` leaves has no
way back), and it should be decided beside whatever first makes `owner` mean more than `admin`.

**GAP 2026-08-07 (5b/5c/8 repair stage), named so it is not mistaken for an oversight: there is
no member roster and no member-removal surface.** D12's own list names "removing members" as an
org-administration act, and nothing implements it — there is no `GET /auth/members`, no
`DELETE /auth/members/:userId`, and `IdentityStore` has no `deleteMembership`. A user invited by
mistake, or one who should no longer have access, can only be removed by editing
`<CEZ_HOME>/identity/*.json` by hand. That is a real operational hole, and it is worth being
precise about how big: it does not gate anything landed in 5b/5c/8, because every path that could
have made it *worse* now refuses instead of writing — a claim aimed at the wrong org and an
invite redeemed by a user who already belongs somewhere both answer 409 with the code unspent
(`user-already-member`), and an org's last team cannot be deleted (`team-is-last`). So the
irreversible cases are closed; the missing verb is the reversible one. Whichever phase builds it
owns three things: the store method under the existing write lease, the D12 role gate, and the
rule for the last `owner` (an org with no owner is the same class of lockout `team-is-last`
exists to prevent).

### D11/D12 scaffold — seams for nine 5b/5c/8 Fill units

Added 2026-08-07. Three recon passes over the landed phase 1-7 code (invites/roles, teams/UI,
org-creation/D11) converged on a set of blockers that D11 as first written did not anticipate — the
most load-bearing being **"per-org bootstrap codes do not exist"** (D11 assumed the per-org secret
was already solvable; the deployment-wide `auth/bootstrap-claim.ts` is one code per PROCESS, not
per org, and org one's owner already holds it). This section is that gap closed, plus the wire/store
seams and the 9-unit ownership map Fill builds from — mirroring the shape D10 already used for
phase 6/7. Everything below is either already-landed code (marked as such) or a declared-not-
implemented seam a Fill unit fills in; nothing here is a business-logic decision left for Fill to
make on its own.

**The crux, solved.** `packages/cezar/src/auth/org-claim-token.ts` (+ `.test.ts`) is the frozen,
already-implemented, already-tested two-sided contract — `mintOrgClaimToken`/`hashOrgClaimToken`
(Fill unit 6 mints+hashes at `POST /internal/orgs`) and `matchesOrgClaimToken` (Fill unit 7 verifies
at the renamed claim method) — the same "write both sides once so two units converge on one scheme"
move D10 made for `supervisor/forwarded-principal.ts`. The hash lands on a new, additive
`Org.claimTokenHash` (`auth/types.ts`, `.passthrough()`-safe); `IdentityStore#createOrg` already
takes an optional `claimTokenHash` input this pass (existing callers unaffected — every one omits
it). This is what makes D11's "cannot claim another org's [code]" true: org one's owner holds the
DEPLOYMENT-wide code (unchanged, still gates only the deployment's first-ever org); org two's code
is a completely different, per-org secret nothing about org one exposes.

**`bootstrapFirstOrg` → `claimOrg` — the exact rename target. LANDED 2026-08-07 (Fill unit 7); this section is kept as the specification the implementation was checked against.** Spelled out in
full on `bootstrapFirstOrg`'s own docblock in `identity-store.ts` (Fill unit 7 reads it there, not
only here): the method gains an optional `orgId` input that forks its behavior — **absent** keeps
today's exact behavior (deployment-wide code, `orgs.length > 0` guard, creates org+team+membership
from a name) for the deployment's first-ever org on EITHER topology (a bare `cezar serve --auth
oidc` with no supervisor has no `/internal/orgs` route to pre-create anything with, so this path
must survive); **present** is the new D11 claim path (org+team already exist, guard is "does this
org already have a member", grants only the `owner` membership). Every production call site that
must change: `onboarding-routes.ts:83` (the `OnboardingIdentityStore` `Pick<>` literal),
`onboarding-routes.ts:310` (the `POST /auth/onboarding/org` handler, branching on the new `orgSlug`
wire field), and every comment across `identity-store.ts`/`onboarding-routes.ts`/`bootstrap-
claim.ts` that names the old method — grep for it once the rename lands rather than hand-picking.
**Do not rename this without doing the D11 legacy-path preservation above** — a rename that dropped
the `orgId`-absent branch would break the ONLY currently-real, currently-tested org-creation path
(the deployment's first org) in the name of enabling one that is still QA Needed even after phase
6/7 (per this spec's own Verification section).

**The routing gap D11 could not have specified: "at that org's hostname" is not reachable, and this
scaffold does not reopen nginx to make it so.** Three independent, already-landed facts close it:
`/auth/callback` redirects with a RELATIVE `/onboarding` (`auth/routes.ts:235`), so every login
lands on the LOGIN host regardless of where it started; the org vhost's `location /` runs
`auth_request /internal/auth-check` ahead of everything, which 401s a membership-less signed-in
user before the wizard's HTML ever loads (`hetzner/nginx.ts`); and `OnboardingRouteDeps` carries no
hostname resolver at all. Reopening the perimeter (carving `/onboarding` + its asset prefix out of
the org vhost's `auth_request` gate) is a real option but is a D10-perimeter decision, not a
scaffolding one — **not made here, flagged instead.** The wire contract adopted in its place:
`POST /auth/onboarding/org` grows an optional `orgSlug` body field
(`packages/contract/src/orgs.ts`'s `createOnboardingOrgInputSchema`, doc comment has the full
reasoning) that the user types in (told the slug out-of-band by the operator, the same channel that
already carries the code). This preserves the security property D11 actually cares about — org A's
owner cannot claim org B without ALSO knowing org B's own per-org code — at the cost of the "walk up
to your own subdomain" ergonomics, which stays open for whoever revisits the nginx perimeter later.
**Flag this to the owner as a product-flow decision, not an implementation detail**, per all three
recon passes' independent conclusion.

> **DECIDED 2026-08-17 (owner): ship the `orgSlug` body field; hostname-based claim
> routing is declined for now.** The claim/join mechanism is the already-scaffolded
> `orgSlug` field on `POST /auth/onboarding/org` — the user types the slug, told it
> out-of-band by the operator over the same channel as the per-org code. The nginx
> `auth_request` perimeter stays closed; `/onboarding` is **not** carved out of the org
> vhost gate. The "walk up to your own subdomain" ergonomics remain open for whoever
> revisits the perimeter later, but are not built here. Security property preserved:
> claiming org B still requires knowing org B's own per-org code, not just its slug.

**Wire seams (`packages/contract/src`, all landed this pass. CORRECTED 2026-08-07: "none yet consumed by a route" is no longer true — every row below now has its consuming route):**

| File | What | Consumed by |
|---|---|---|
| `invites.ts` (new) | `inviteSchema`, create/list/revoke/redeem DTOs | Fill unit 1 |
| `orgs.ts` (extended) | `createOnboardingOrgInputSchema` gains `orgSlug` (claim mode); `createInternalOrgInputSchema`/`Response` (`POST /internal/orgs`); `listTeamsResponseSchema`, `createTeamInputSchema`/`Response`, `renameTeamInputSchema`/`Response` | Fill units 6, 3 |
| `projects.ts` (extended) | `updateProjectInputSchema.maxParallel` relaxed to optional, `.teamId` added (reassignment) | Fill unit 3 |

`packages/web/src/api/client.ts#updateProject` was adjusted in the SAME change to keep `npm run
typecheck` green against the widened `UpdateProjectInput` (the route's own validator is untouched,
so the Hono-typed client still requires the OLD narrower body) — see that function's own comment for
the exact trap Fill unit 3 must not walk into when it wires `teamId` through for real (an
unqualified forward of `maxParallel: input.maxParallel ?? null` would silently CLEAR a project's
concurrency override on a team-only reassignment once the route understands the field).

**Store seam (`auth/identity-store.ts`. CORRECTED 2026-08-07: no longer "declared, stub bodies" — Fill unit 3 implemented it, and `project-root-not-found`/`org-already-claimed` are both thrown now):**
`updateProjectTeam(projectRoot, teamId)` — reassign an already-claimed root to a different team in
the SAME org, one guarded write (delete+create is two writes and reopens the exact D4 race
`registerFolder`'s existing claim-preference already avoids). Full check list, in order, is on the
method's own docblock. Two new `IdentityStoreErrorCode` members declared for it and for the D11
claim path: `project-root-not-found`, `org-already-claimed` — neither is thrown by any method
today; both exist so Fill doesn't have to invent the spelling.

**The route-inventory gate has a bug Fill unit 6 must fix in the SAME change it adds `POST
/internal/orgs`, not after.** `supervisor/server.test.ts`'s two-directional inventory assertion
(the one invariant 3 leans on) keys both `registered` and `classified` on PATH ALONE:

```ts
const registered = new Set(app.routes.map((r) => r.path).filter(/* … */));
const classified = new Set([...ADMIN_ONLY, ...ORG_SCOPED].map(([, , pattern]) => pattern));
```

`/internal/orgs` is already in `ADMIN_ONLY` as a `GET`. Adding `POST /internal/orgs` registers the
SAME path string, so both `expect(...).toEqual([])` assertions stay green with the new verb
COMPLETELY UNCLASSIFIED — and, because `INTERNAL_ROUTES` (feeding the 401/403 `it.each` suites) is
built from the same tuples, the new verb gets no negative-credential coverage either. This is not
hypothetical: it is the exact "gate that proves someone decided" hole invariant 3 exists to close,
sitting in the gate itself. The fix: key both sets on `` `${method} ${path}` ``, add
`['POST', '/internal/orgs', '/internal/orgs']` to `ADMIN_ONLY`, and confirm the existing `GET`
entries still pass (they will — nothing else changes shape).

**File overlaps this ownership map deliberately allows, and how to sequence them (per this task's
own "split differently NOW and say so" instruction — these two are additive, same-file, different
route families, and splitting the file itself is out of scope for a scaffold pass):**
- `supervisor/server.ts` + `supervisor/server.test.ts`: unit 3 adds a `PATCH /internal/project-
  teams` route (project-teams section) and its `ORG_SCOPED` entry; unit 6 adds `POST /internal/orgs`
  (orgs section, fixing the inventory keying above) and its `ADMIN_ONLY` entry. Land either first,
  rebase the other — both diffs are small, additive hunks in disjoint sections of the same route
  chain and the same two const arrays.
- `SupervisorIdentityStore`'s `Pick<IdentityStore, …>` union (`supervisor/server.ts`): unit 6 adds
  `'createOrg'`; unit 3 adds `'updateProjectTeam'`. Same note.

**Ownership map — the nine 5b/5c/8 units, no file overlap beyond the two noted above:**

| # | Unit | Owns (new files unless noted) | Reads (imports, never edits) |
|---|---|---|---|
| 1 | Invite store+HTTP | `/auth/invites*` routes (new file or an addition to `auth/onboarding-routes.ts`'s family — implementer's call), the token-entropy/default-TTL policy `createInviteInputSchema`'s doc comment leaves open | `packages/contract/src/invites.ts` (this pass), `identity-store.ts`'s already-implemented `createInvite`/`redeemInvite`/`revokeInvite`/`getInvite`/`listOrgInvites` (unmodified) |
| 2 | Role enforcement (D12) | A `requireOrgAdmin` middleware for the `/auth/*` family (mirrors `supervisor/server.ts`'s `requireAdmin` — registered BEFORE `jsonZodValidator`, not a per-handler check, so invariant 3's ordering defect can't recur three more times across units 1/3's new admin verbs), plus its own route-inventory test over `/auth/*` | `onboarding-routes.ts`'s existing `principal.role !== 'owner' && !== 'admin'` check (the one precedent to generalize, not re-invent) |
| 3 | Team CRUD store+HTTP | `IdentityStore#updateProjectTeam`'s implementation (declared this pass), `/auth/teams*` routes, `PATCH /api/v1/projects/:projectId`'s `teamId` branch (`server.ts`), `supervisor/server.ts`'s new `PATCH /internal/project-teams` + `registry-client.ts`'s mirror method, `packages/web/src/api/client.ts#updateProject`'s eventual `teamId` wiring (see its own comment on the `?? null` trap) | `packages/contract/src/orgs.ts`/`projects.ts` (this pass) |
| 4 | Team management UI | A Settings → Teams pane (list/create/rename), reached from the cockpit's lazy-loaded settings chunk (AGENTS.md zero-config-bundle discipline — do not statically import into the entry chunk, the exact regression this spec's Risks section already names once) | unit 3's routes/contract |
| 5 | Board/project team filter | `projects-section.tsx`'s `teamOptions` (currently derived from `project.teamId` on registered projects only — `:274-281`) gains a per-row team-picker control backed by unit 1's/3's `GET /auth/teams` so an EMPTY team is selectable, not only one already carrying a project | unit 3's list-teams route |
| 6 | `POST /internal/orgs` + route inventory | `supervisor/server.ts`'s orgs section (new `POST`), `supervisor/server.test.ts`'s inventory fix (above) + new `ADMIN_ONLY` row, `SupervisorIdentityStore`'s `'createOrg'` addition | `auth/org-claim-token.ts`, `identity-store.ts#createOrg` (already extended, this pass — no store change left) |
| 7 | Claim-an-unclaimed-org rename + per-org bootstrap codes | The `bootstrapFirstOrg` → `claimOrg` rename (target fully specified on that method's own docblock, this pass), `onboarding-routes.ts`'s `POST /auth/onboarding/org` handler (branch on `orgSlug`), `GET /auth/onboarding`'s status-route/state-machine interaction with claim mode (genuinely undesigned by this pass — see the routing-gap note above) | `auth/org-claim-token.ts`, `packages/contract/src/orgs.ts` (this pass) |
| 8 | Installer org-creation step | A new `org-create` step in `server-install/platforms/hetzner.ts`'s `steps()`, positioned BEFORE `orgRegistrationStep` (today aborts with "create it in the onboarding wizard first" at `hetzner.ts:655` — that message becomes wrong advice the moment this step exists and must change in the SAME diff), `check()`/`verify` sharing one probe against `GET /internal/orgs/:slug` (mirror `isRegistered`'s own idiom, `hetzner.ts:679-693`), printing the returned `bootstrapToken` once (never in `argv`, never echoed by a sudo-note transcript — the same discipline `orgSystemdStep` already applies to `CEZ_SUPERVISOR_SECRET`) | unit 6's route, `packages/contract/src/orgs.ts`'s `createInternalOrg*` DTOs (this pass) |
| 9 | Docs incl. every single-org correction | `README.md` (**CORRECTED 2026-08-07: `packages/cezar/README.md` is NOT hand-edited and this row was wrong to say so.** `packages/cezar/scripts/sync-readme.mjs` copies the root file into it as a `prebuild` step and the copy is gitignored — edit the root README only; `npm run build` regenerates the pairing, so something does enforce it), `CHANGELOG.md`, `docs/server-install/hetzner.md` (heading included — the falsehood is IN the heading, `## Read this before you start: you can host exactly one organization today`), `BACKWARD_COMPATIBILITY.md` §1's `409 once ANY org exists` line, plus every docblock recon named (`identity-store.ts:405-416`+`:436`, `onboarding-routes.ts:195-206`+`:270-289`, `bootstrap-claim.ts:43-46`, `contract/src/orgs.ts:196-207`, `onboarding.tsx:202-206`+`:213`) — correct each IN PLACE per this project's correction discipline, do not leave the old text standing unmarked | this spec |

**Known gaps this scaffold pass names but does not close (report these, do not silently fix or
silently skip):**
- **F4 (recon, pre-existing, now reachable):** `auth/session.ts#resolveIdentity` picks
  `listMemberships(userId)[0]` and that org's FIRST team — a user with two org memberships is
  permanently pinned to whichever is oldest. 5b's invite flow reaches this immediately: a user
  invited to and redeeming an invite for a SECOND org can never actually use it (every request to
  that org's host/scope resolves against the wrong org and 401s/403s with no diagnosable reason).
  Documented as a "Phase 4/5 owns replacing" gap since phase 3; still open. Not this scaffold's to
  fix — named so Fill unit 1 doesn't discover it by way of a confusing bug report.
- **The bootstrap-code banner still never prints on a hetzner deployment** (recon F2,
  pre-existing): `startSupervisor` never calls `bootstrapClaimBanner`. Blocks org ONE's claim on a
  real hetzner host today, independent of everything above. Not fixed here — flagged because phase
  8's own verification row ("the first user at its hostname claims it with its own bootstrap code")
  cannot run until it is.
- **The claim-mode UX inside `GET /auth/onboarding`/the wizard is undesigned.** How a user learns to
  type `orgSlug` (a new wizard state? a field always shown?) is left to Fill unit 7.

### D13 — a local user may create an org and workspaces without auth

**The ask.** Opening `http://127.0.0.1:<port>` for the first time, with no
`CEZ_AUTH`, should offer to create an **organization**, then one or more
**workspaces** ("Engineering", "Marketing"), then file projects under them. Today
it cannot: the wizard is "invisible and inert with `CEZ_AUTH` unset"
(`onboarding.tsx:30`), no `/auth/*` route is constructed at all
(`index.ts:301`), and the local principal is a synthetic literal naming no
stored row (`principal.ts:66-71`).

**Why this is not an authorization change, and the one fact that makes it
safe.** D12 already settled that `role` gates org *administration* and never
code execution. Local mode is the limiting case: the caller is on loopback, and
anyone who can reach loopback can already `POST /api/v1/workflows` and get a
shell. So an org here partitions *the user's own work*; it grants nothing and
withholds nothing. Concretely, this changes **no** authentication behaviour:

- no session middleware, no cookie parsed, no login route, no 401 — ever;
- `requirePrincipal`'s auth-off branch still short-circuits on
  `resolveAuthProvider(process.env) === 'none'` (`server.ts:1559`);
- `verifyWsUpgrade` still skips the principal check when the provider is
  `'none'` (`server.ts:5965`);
- the health payload is still returned unredacted, and `capabilitiesSchema`
  still carries **no** `auth` key (`capabilities.test.ts:213` stays green).

That is possible because **authentication and org-scope are already keyed on two
different things**, and only coincide today by derivation. Every auth decision
reads `resolveAuthProvider(...)`; every org decision reads
`principal.kind === 'session'`. D13 breaks the coincidence and leaves the auth
half untouched.

**The seam: `kind` stops standing in for "has an org".** `Principal.orgId` and
`teamId` become `string | null`, and the five org gates stop asking
`kind === 'session'` and start asking a single exported predicate
`hasOrgScope(principal)` (`orgId !== null`).

**CORRECTED 2026-08-07 by D13 (adversarial review): "`orgId !== null`" describes
what the implementation was PLANNED to check here, not what it does.**
`hasOrgScope` (`auth/principal.ts`) reads `principal.orgId !== null &&
principal.teamId !== null` — both fields, not `orgId` alone. `resolvePrincipal`'s
one construction path only ever produces the two as a matched pair (both `null`
or both real), which is why checking `orgId` alone would have been
*observationally* sufficient for every principal the resolver can produce today —
but it is not what shipped, and a reader who trusted this sentence over the
source risks writing a future caller (or a future edit to `hasOrgScope` itself)
against the weaker, one-field claim. See `auth/principal.ts#hasOrgScope`'s own
doc comment for the fuller reasoning, corrected the same way at the first
adversarial review.

Each seam then carries exactly one condition:

| principal | `kind` | `orgId`/`teamId` | meaning |
|---|---|---|---|
| auth off, no org yet | `'local'` | `null` | today's zero-config default, unchanged |
| auth off, org created | `'local'` | real ids | D13's new state |
| auth on | `'session'` | real ids | unchanged |

`kind` keeps its honest meaning — *was this request authenticated* — and is what
the auth perimeter and D10's supervisor branch keep reading. The five call sites
that move to `hasOrgScope` are `withTeams` (`server.ts:2690`), `mayActOnRoot`
(`:2763`), `releaseRootClaim` (`:2800`), `registerFolder`'s claim block
(`:3188`), and `PATCH /projects/:id`'s `teamId` arm (`:2958`) — whose 400 message
must change from "teamId requires an authenticated session" to naming the real
precondition, an org. **A `null` orgId must never be silently coerced to the
string `'local'`**: that string is what the old literal used, it names no row,
and a coercion would file projects under a phantom org.

**Identity, without an IdP.** `findOrCreateUser` keys users on `(issuer,
subject)`, both required. The local user is a real row with
`issuer: 'local'`, `subject: 'local'` — the key stays honest and stays unique,
rather than being bypassed with a nullable column. `issuer: 'local'` can never
collide with an OIDC issuer (those are absolute URLs), which is also what makes
"this deployment later turns auth on" well-defined: the local row and an OIDC
row for the same human are different rows, and merging them is out of scope
here and named in Risks.

**Zero I/O is preserved for the user who never onboards.** The local org is
resolved through a module-level cache with three states (`unknown` → one
`existsSync` → `none` | resolved). A user who never opens the wizard costs one
`stat` for the process lifetime and creates nothing; `readSnapshot` degrades a
missing file to an empty snapshot without `mkdir`
(`identity-store.ts:1291`). D1's five landed "no identity directory is created"
controls (`projects-api.test.ts:577,665,751,855,869`) therefore stay green
**unchanged** — and that is the acceptance test for this paragraph, not a
prediction. The cache is invalidated by the onboarding write itself, in-process.

**CORRECTED 2026-08-07 (adversarial review round 4): the cache design above is
no longer what shipped.** "For the process lifetime" was the defect three
review rounds kept reopening: `<CEZ_HOME>/identity/identity.json` is
machine-global (D4 allows more than one process pointed at the same
`CEZ_HOME` — a long-lived `cezar serve` alongside a `cezar projects add` CLI
invocation, for instance), so a `'none'` answer cached for the rest of the
process lifetime, invalidated only by the in-process
`invalidateLocalOrgIdentityCache()`, went stale forever for any reader that
was running when a DIFFERENT process's onboarding write landed — silently
filing every project that reader registered under no org, reproducing D13's
own named FAIL state through a door in-process invalidation could not close.
`auth/local-identity.ts#resolveLocalOrgIdentity` now pairs each cache state
(`'none'` or `'resolved'`, `'unknown'` unchanged) with a **fingerprint** —
`identity.json`'s `{size, mtimeMs}` as of the last `statSync` — and re-reads
the real store whenever the current fingerprint differs from the one the
cache was built from, regardless of which process wrote the change. The
"one `stat` for the process lifetime" cost above is now "one `stat` per
call": still cheap enough to pay on every auth-off request, and what makes a
second process's write always visible rather than only visible to the
process that made it. `invalidateLocalOrgIdentityCache()` still exists and is
still called by the onboarding write, but is now belt-and-suspenders for the
same-process caller (an unconditional fresh read on the very next call,
rather than depending on the fingerprint having moved) — cross-process
readers have no way to call it at all, which is exactly why they needed the
fingerprint check instead. See that module's own doc comment for the fuller
account, including the deliberate asymmetry: a `'resolved'` cache is sticky
against `identity.json` disappearing (never happens through this store's own
write path) but not against it changing.

**One onboarding implementation, two gates — never two implementations.** The
same `onboardingRoutes`/`teamRoutes` mount in local mode at the same
`/auth/onboarding*` and `/auth/teams*` paths; only the injected gate differs
(`createRequireSignedIn` → a local gate that resolves/creates the local user).
This is deliberate: `invite-routes.ts` already shipped a byte-for-byte copy of
`resolveSignedInUser` whose "these cannot drift" docblock nothing tested, and a
second onboarding surface under `/api/v1/*` would repeat that mistake at a
larger scale. `authRoutes` (login/callback/logout) and `inviteRoutes` stay
**unmounted** locally — there is nothing to log into and no second user to
invite.

**CORRECTED 2026-08-07 (repair round 2, FIX B1): the mounting decision no
longer lives inline in `src/index.ts`.** The first implementation put the
~45-line "resolve the two gates, dynamic-import the four modules, wire
`onboardingRoutes`/`teamRoutes`" body directly in `serveCommand`'s `else if
(resolveCapabilities(process.env, bindHost).localHandoff)` branch — untestable
by construction (`src/index.ts` is the CLI entry; importing it runs the CLI)
and, worse, that inline condition re-derived only HALF of this decision's real
predicate (the bind check) and relied on the branch's position after two prior
`if`/`else if`s to supply the other half (`gate.provider === 'none'`), so a
reordering of that chain could have stranded it reachable on an authenticated
topology unnoticed. Both the decision and the wiring now live in
`local-mode-boot.ts#buildLocalModeRoutes`, which re-asks the full two-part
predicate (`isLocalOrgModeActive`, `server/capabilities.ts`) as its own first
statement and is exercised directly by `local-mode-boot.test.ts` — including
asserting the returned `onboardingRoutes`/`teamRoutes` are real, functioning
`Hono` apps, not merely that the boolean is correct (a deleted wiring body
previously left both `undefined` with every other gate green). `src/index.ts`'s
`else` branch is reduced to `const localMode = await buildLocalModeRoutes(...);
if (localMode.active) { ... }`.

**The bootstrap claim does not apply locally, and the reason must be the bind,
not the provider.** `bootstrapTokenRequired` is `false` in local mode *because
`capabilities.localHandoff` is true* (loopback), not because `CEZ_AUTH` is
unset. The distinction is load-bearing: `hosted + unset + CEZ_ALLOW_UNAUTHENTICATED=1`
is a real, permitted topology (D1's table), and there the audience is a network,
not one machine — so that configuration keeps requiring the deployment-wide
code, exactly as D9's bounded-audience reasoning demands. Keying this on
`CEZ_AUTH` instead would hand org-one ownership to the first stranger who
reaches an intentionally-exposed instance.

**Workspaces are the code's `team`, renamed only in the UI.** The owner's word
is "workspace"; the code's `workspace` already means the per-OS-user machine
scope (`~/.cezar`, `workspace/config.ts`), which is released and test-enforced.
So the UI says **Workspace**, the code keeps saying `team`, and no identifier is
renamed. A rename would collide with a shipped concept for a cosmetic gain.

**The wizard gains a create step.** Today step 3 only *renames* the single
hardcoded `General` team (`onboarding.tsx:432-446`) — with one workspace there
is nothing to organize. The wizard gains "add a workspace" backed by the
existing `POST /auth/teams`, defaulting to one workspace and letting the user
add "Engineering"/"Marketing" before finishing.

**Existing projects are adopted, not stranded.** Creating the first org locally
must file every already-registered project under the default workspace in the
same write. Otherwise the first run — which always has at least the boot project
— produces an org whose project list is empty, and nothing else ever backfills
it (`claimOrg` writes only orgs/teams/memberships). This is the D13 step most
likely to be skipped as "polish"; it is the difference between a wizard that
works and a wizard that looks like it did.

**ADDED 2026-08-07 (repair round 2): the paragraph above covers only the
moment the org is CREATED — it does not, on its own, cover a project
registered AFTER that moment, and the first implementation genuinely did not
either.** `cezar projects add` (`workspace/projects-cli.ts`) and a fresh
`cezar serve` boot in a NEW repo (`src/index.ts#initWorkspace`) both call
`registerProject` directly, bypassing the HTTP `POST /api/v1/projects` route
that already had D4-aware team-claiming logic (`registerFolder` in
`server.ts`) — so a project added by either of those two paths after a local
org already existed was filed in the registry but never in
`<CEZ_HOME>/identity/project_teams`, silently absent from every team filter.
Closed by one shared seam, `registerAndAdoptProject`
(`registered-project-roots.ts`), called from both call sites: it resolves
whether a local org exists (`isLocalOrgModeActive`) and, only then, claims the
newly-registered root under the caller's default team — mirroring
`registerFolder`'s own D4 claim rather than inventing a second one. A
symmetric `releaseProjectTeamClaim` does the same for `cezar projects remove`,
so a root removed through the CLI stops blocking re-registration the same way
`DELETE /api/v1/projects/:id` already did. Both are gated on
`isLocalOrgModeActive`, not on `resolveAuthProvider` alone, for the identical
reason the bootstrap claim paragraph below already gives — and a failed
adoption write (a stuck lease, a team deleted out from under a stale cache
read) is caught and logged rather than propagating into `initWorkspace`'s own
error path, so a transient identity-store failure never turns a successful
project registration into a boot failure.

**Out of scope, named rather than implied:** switching between orgs locally
(`session.ts#resolveIdentity` still pins to `listMemberships(userId)[0]`);
merging a `local` user row into an OIDC row when a deployment later enables
auth; and multi-org local mode — `claimOrg`'s `orgs.length > 0` guard still
holds, so local mode is single-org, and the wizard must say so rather than
offering a second org it will refuse.

**ADDED 2026-08-07 (repair round 2, packages/web fixes C1-C4): four cockpit
defects the decision text above did not anticipate, closed at this pass.**
(1) Declining onboarding was irreversible — nothing routed back into
`/onboarding` afterward. Settings → Workspaces now renders a "Create an
organization" link into `/onboarding` whenever it reads the new `no-org`
probe state, and re-entry is tested directly (declining, then loading
`/onboarding` again, asserts the wizard actually renders rather than bouncing
away). (2) The decline flag lived in `localStorage` only, with no fallback —
now a 3-tier `localStorage` → `sessionStorage` → in-memory chain, each tier's
read/write independently guarded, with the in-memory tier's real limit (does
not survive an actual page reload) named rather than silently claimed as
fixed. (3) `GET /auth/teams`'s 400 "no organization exists yet" precondition
— the ordinary, expected state on every zero-config default before onboarding
— surfaced as `teams-panel.tsx`'s generic red `tone="danger"` error card
instead of a neutral explainer; `probeTeams` now returns a dedicated `no-org`
state for that one status code. (4) `TeamsProbe`'s `auth-off` kind was
renamed `unavailable` to match `onboarding-api.ts#OnboardingProbe`'s own
2026-08-07 rename (see that file's own doc comment): D13 local mode answers
real JSON from `/auth/onboarding`/`/auth/teams` now, so a kind named for
"auth is off" was actively misleading about which deployments actually reach
it — only a hosted, unauthenticated deployment with no `/auth/*` mounted at
all does. **Left open, named rather than fixed:** `listOrgTeams` (the
Projects-board team-filter query, `teams-api.ts`) still throws on that same
400 instead of returning `[]` the way its sibling `probeTeams` now handles it
explicitly — not user-visible today (`useOrgTeams()` is a soft,
`retry: false` query whose result is always read through `?? []`), but a
latent inconsistency now that one of the two callers handles the status and
the other doesn't.

### D14 — the cockpit is gated on onboarding, and logout exists

**NARROWED 2026-08-29 (`.ai/specs/2026-08-29-global-provider-toggle.md`, D9) — a live decision
being scoped, not a stale fact.** The global provider lock bar (`EngineLockBar`, shipped in
`58f5ede5`) is machine-wide state, not a dashboard element, so it renders on the two
*authenticated* states this gate covers — `needs-org` and `ready && !hasProjects` — where the
session exists to read and write `workspace/config` with, while `signed-out` keeps this decision
exactly as written below: no session, no bar, no dashboard. Implemented via
`allowsGlobalBar(onboardingProbe.data)` in `packages/web/src/routes/onboarding/onboarding-gate.ts`,
wired at `packages/web/src/components/app-shell-container.tsx:93,193`. Everything below continues
to describe the wizard-only surface for the states it always covered.

**Owner decision, 2026-08-07. This REVERSES D13's repair-round-3 "decline" behaviour**
(`onboarding-decline.ts`, the "Not now" button, and the Settings re-entry path added to
make declining reversible). Those were added because a reviewer objected that an
unconditional redirect turned the npm zero-config default into a mandatory
org-naming interstitial, contradicting D1's compatibility row. The owner has
decided the opposite: **no dashboard element renders before the first
organization exists.** The wizard is the entire surface until onboarding
completes. The decline flag and its Settings entry point are removed rather than
left as dead code that still reads as live.

**The consequence, stated rather than discovered later:** cezar is released, and
today `npx cezar` opens straight into a working cockpit. After this, an existing
user upgrading meets a mandatory onboarding wall on first launch. That is a
deliberate product change, not an accident of the auth work — D1's table row is
amended again to say so.

**The gate is keyed on the probe, never on a flag, and never on `CEZ_AUTH`.** It
fires only when `GET /auth/onboarding` answers `needs-org`. It must NOT fire on
`unavailable` — the hosted + `CEZ_AUTH` unset + `CEZ_ALLOW_UNAUTHENTICATED=1`
topology mounts no `/auth/*` at all (`index.ts`'s D13 branch is keyed on
`localHandoff` and falls through unmatched there), so a hard gate on that
deployment would block the cockpit behind a wizard the deployment can never
satisfy. Bricking a permitted topology is the failure mode this paragraph
exists to prevent, and it needs its own test.

**Logout.** `POST /auth/logout` has existed since phase 3 with **no caller in the
cockpit at all** — there is no way to sign out of a cezar deployment from its own
UI. The cockpit gains an Account section in Settings whose visibility is derived
from whether `/auth/*` is actually mounted (the same
answered-with-JSON probe `onboarding-api.ts` already uses, not a capability flag
— `capabilitiesSchema` still deliberately carries no `auth` key). In local mode
`authRoutes` stay unmounted, so the section is absent there: local mode has no
session to end.

> **CORRECTED 2026-08-07, hours after this was written — "the section is absent
> there" is not achievable and was not achieved.** Settings sections are declared
> in `registry.tsx` and gated by `visibleSettingsSections`, whose three gates
> (`hidden`, `scope`, `capability`) are all **synchronous**, decided from
> `useHealth()` at render time. The `auth` capability key that a synchronous gate
> would need is exactly the key D1's Risks section forbids and
> `capabilities.test.ts:213` enforces the absence of. An async probe can hide the
> PANEL but not the NAV ENTRY. Shipped behaviour: the nav entry exists in local
> mode and its panel states that this deployment has no sign-in. The sentence
> above mattered because implementing it literally produced a live *Account* nav
> item — described as "Sign out of this cezar deployment" — that opened a blank
> pane on the npm zero-config default, which reads as a broken build rather than
> as a deployment without sessions. What is genuinely load-bearing, and is tested,
> is that **no sign-out action is reachable** where there is no session.

### D15 — onboarding is not complete until the org owns at least one project

**Owner decision, 2026-08-07, from a first-run report.** D14 gated the cockpit on
the first *organization*. That turned out to be half the gate: after naming an org
and accepting a workspace, the user landed in a cockpit already showing a project,
its commit history and its branch — none of which they had added. Their words:
*"I didn't add any project — why do I see data in commits and git tab?"*

**Decision: the wizard does not finish until the org owns at least one project,
and the user chooses that project one of three ways** — blank, from a local
directory, or imported from GitHub.

**The gate extends D14's rather than replacing it.** D14's condition was
`kind === 'needs-org'`. It becomes `needs-org` **OR** (`ready` **AND**
`!hasProjects`). Everything D14 says about what must NOT gate is unchanged and
still load-bearing: `unavailable` must never gate (it would brick the hosted +
`CEZ_AUTH` unset + `CEZ_ALLOW_UNAUTHENTICATED=1` topology behind a wizard that
deployment can never satisfy), and neither may ~~`signed-out` or~~ `needs-invite`.

> **CORRECTED 2026-08-19 for `signed-out`, which now DOES gate.** See
> `2026-08-19-signed-out-cockpit-reauth.md`. The sentence above excluded three
> states in one breath but argued only one of them, and `signed-out` was carried
> along by the sentence rather than by a reason. What it cost: on
> `cockpit.example.com`, an unauthenticated visitor got the **entire cockpit** —
> sidebar, nav, command palette, every tab — with every `/api/*` query 401ing
> behind it and no sign-in affordance anywhere on the page. The owner's words,
> 2026-08-19: *"if I clear application/website data I'm still in cezar, but I
> can't see any tasks, git, etc. I should be always enforced to relogin there."*
>
> `signed-out` does not share `unavailable`'s hazard, and the boot wiring is the
> proof. It requires `GET /auth/onboarding` to answer a JSON **401**, which
> `src/index.ts` produces from exactly one of its three branches — the
> `oidc`/`google` one, which sets `authRoutes` **and** `onboardingRoutes`
> together. Local mode never 401s (D13 invariant 1); the supervisor and
> hosted-unauthenticated branches mount no `/auth/*` at all and probe as
> `unavailable`. So **`signed-out` implies `/auth/login` is mounted**: the gate it
> raises is always satisfiable, which is precisely what `unavailable` lacks and
> was excluded for. `needs-invite` is untouched and still never gates — that user
> HAS a session, so it is a different problem.
>
> The gated surface for `signed-out` is `onboarding.tsx#SignInStep`, which since
> the same date **redirects to `/auth/login` on mount** rather than waiting for a
> click (owner's choice), with a 30 s one-shot guard so an IdP that returns
> without a session lands on the screen instead of looping.

**`hasProjects` already exists and already means the right thing.** It is
computed in `auth/onboarding-routes.ts` as
`identityStore.listProjectTeams({ orgId }).length > 0` — projects **adopted into
the org**, not merely present in the workspace registry. That distinction is what
makes the gate honest, and it must not be relaxed to "the registry is non-empty":
the registry is machine-wide and predates the org, so a registry read would let a
project belonging to nobody satisfy an org-scoped requirement.

**Boot auto-registration must not satisfy the gate.** This is the part that
produced the report, and without it the whole decision is vacuous. `serveCommand`
→ `initWorkspace` → `shouldRegisterProject` (`workspace/projects.ts`) registers
the launch directory as a project for **every** root except `$HOME` and a task
worktree. Since `cezar` is normally launched from inside a repo, the requirement
would be satisfied before the wizard ever asked — the user would be shown "add
your first project" over a cockpit that already had one, which is precisely the
contradiction reported. **While the local org does not exist yet, boot does not
register.**

> **SUPERSEDED 2026-08-07, hours later, by SPEC `2026-08-07-org-scoped-tasks-knowledge.md`
> D3 — "only while onboarding is incomplete" was the wrong bound, and the owner
> caught it in the running app.** Scoping the suppression to onboarding merely
> DEFERS the reported problem by one launch: the owner onboarded, restarted cezar
> from inside the cezar checkout, and `cezar` reappeared in the sidebar beside the
> project they had actually created — the same "I didn't add any project"
> complaint this decision exists to answer. Boot now **never** auto-registers;
> an unknown launch directory is *offered* ("Add <name> to a workspace") and the
> registry is not written until the user accepts. The bullets below describe the
> shipped-then-superseded behaviour and are kept for the reasoning, not as the
> current rule.

That is a real narrowing of cezar's founding "cockpit for *the current repo*"
behaviour, so it is bounded deliberately:

- It applies **only** while onboarding is incomplete. Once an org exists, boot
  registration and adoption behave exactly as they do today, for every launch
  thereafter.
- The launch directory is not discarded, it is **offered**: the wizard's
  local-directory path pre-fills it, so the historical one-launch-one-repo
  ergonomics survive as one click rather than as a silent write.
- It changes nothing for hosted/auth topologies, which never had a local org to
  be missing.

**Blank project = a directory plus `git init`.** It is created at
`<projectsDir>/<name>` — the same `projectsDir` (default `~/cezar/projects`) that
"Clone from GitHub" already writes into and that Settings → Projects already
exposes, so blank projects land beside checkouts instead of inventing a second
location. `git init` runs because every project-scoped surface in the cockpit
(Git tab, GitHub tab, task worktrees) assumes a repository; a blank project
without one is a project whose main panes are permanently empty.

**The checkout route gains an optional `teamId`**, matching the local-register
route that already takes one. Without it a clone performed *during* onboarding
would be filed under the principal's default team rather than the team the wizard
just told the user it would use — right by luck in the single-workspace case, and
wrong the moment a second workspace exists.

**Risk — the upgrade path must not wall in an existing user.** An installed user
already has registered projects. On first launch after upgrading,
`registerAndAdoptProject` adopts them into the local org as it does today, so
`hasProjects` is true and the wizard closes at the org/workspace steps rather than
demanding a project they already have. This needs a test, not an assumption: the
failure mode is an existing user locked out of their own cockpit, which is worse
than the report this decision answers.

**Risk — "at least one" is a floor, not a ceiling.** Nothing here limits a user to
one project, and the enforcement must not survive past onboarding: deleting your
last project later is a normal thing to do and must not re-open the wizard as a
modal wall. The gate is evaluated on the onboarding probe at entry, and D14's
`firedOnce` latch already bounds it to at most one redirect per page load.

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
| 5b *(landed 2026-08-07, QA Needed)* | invite create/redeem HTTP surface + the role decision it forces (D8) | a second member exists, joined by invite; what an `admin`/`member` may do is decided rather than inherited — **and the decision is D12 below, not the implementer's** |
| 5c *(landed 2026-08-07, QA Needed)* | team management: create/rename/reassign (D2) | a project can be moved between two real teams; the board filter has more than one option |
| 6 | per-org process supervisor + nginx (D4) | two orgs ⇒ two unix users, two `CEZ_HOME`s, no shared path; org A cannot read org B's runs. **The phase-5 in-process `project_teams` check must be REPLACED by the supervisor's mapping, not joined by it** — per-org `CEZ_HOME`s make each process blind to the other's table, so two orgs would both succeed at claiming one root with every gate green (D4's amendment) |
| 7 | `server-install --platform hetzner` (D4) | provisions from clean; OIDC replaces `auth_basic`; TLS |
| 8 *(landed 2026-08-07, QA Needed)* | org-creation surface (D11) — admin-only `POST /internal/orgs`, the installer step that calls it, and `bootstrapFirstOrg` → claim-an-unclaimed-org | a **second** org exists on one host; the first user to sign in **at the deployment's login host** claims it with its slug + **its own** claim code and cannot claim another org's *(**CORRECTED 2026-08-07 at the repair stage**: this row read "the first user at its hostname", which is not where the claim is served — see D11's own correction; the row was unrunnable as written)*; a non-admin `POST /internal/orgs` is **403 before validation**; every single-org claim in README/CHANGELOG/this spec is corrected in the same change; **phase 6's verification row runs for the first time** |
| 9 | local-mode onboarding (D13) — `orgId`/`teamId` become nullable + `hasOrgScope`, a local user/gate, onboarding+team routes mounted with `CEZ_AUTH` unset, a create-workspace wizard step, and project adoption | **The negative half first, and it must pass UNCHANGED:** D1's five "no `<CEZ_HOME>/identity` directory is created" controls (`projects-api.test.ts:577,665,751,855,869`), `capabilities.test.ts:213` (no `auth` key), and `auth-perimeter.test.ts:225-240` (auth-off never 401s, no resolver consulted) all stay green **with no edit to their assertions** — an edit to any of them is the signal that the change went wider than D13 permits. **Then the positive half, on a real first run:** from a cleared `CEZ_HOME`, `http://127.0.0.1:<port>` offers to create an org with **no bootstrap code**; creating one yields a default workspace **and files the already-registered boot project under it** (an org whose project list is empty is a FAIL, not a cosmetic gap); a second workspace named "Engineering" can be added and a project moved into it; `PATCH /projects/:id` with a `teamId` succeeds where it previously 400'd; and `<CEZ_HOME>/identity/identity.json` contains a `users` row with `issuer: 'local'`. **The mutation that must kill a test:** coercing a `null` `orgId` back to the string `'local'` — if the suite stays green, `hasOrgScope` is not actually load-bearing anywhere. **CORRECTED 2026-08-07, and this row was wrong in a way worth keeping:** naming these five controls as the tripwire assumed they *could* fail. At least the listing one cannot, and the reason is structural, not an oversight. `withTeams` is read-only; `IdentityStore`'s reads are documented "always fresh off disk, never throw"; `withTeams` wraps them in `catch { return projects; }`; and `project_teams.org_id` is `NOT NULL`, so a `null` `orgId` matches no seeded row even with the guard deleted. Mutating `withTeams`'s condition to `(false && !hasOrgScope(principal))` leaves **all 64 tests in the file green** — verified by running it, not by reading it. No booby trap can change that: every path a bypass would take is designed to swallow identity-storage failure and degrade to the unannotated listing. So the requirement "these pass unedited" was satisfiable by a test that had stopped testing, which is exactly the failure mode the row existed to prevent. What IS now pinned: the shared `hasOrgScope` predicate, via `registerFolder`'s POST and `mayActOnRoot`/`releaseRootClaim`'s DELETE, which reach the identity **write** path — that path is not swallowed, and mutating `hasOrgScope` to `return true \|\| (...)` turns 9 tests red including two controls added for exactly this. Making the *listing* guard falsifiable would require narrowing `withTeams`'s catch so a registry failure surfaces instead of degrading silently — a product decision (it trades resilience for observability), not a test fix, and deliberately not taken here. |

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

**CORRECTED AGAIN 2026-08-07 (phase 8 landed): that org-creation surface now exists, so the
instruction in the sentence directly above has expired.** `POST /internal/orgs` creates the
org row and `claimOrg` grants its first owner, so *multi-tenant* is true in the product sense
for the first time: phase 6's isolation has something on the far side of it. Read the two
paragraphs above as the history of why the claim was held back, not as the current status.
What is still NOT settled is evidence, not capability — see the Verification section: two
REAL orgs on two unix users has never been observed on a real host, so this ships as **QA
Needed**, and "isolation is real, tenancy is now reachable" is the honest phrasing rather
than "multi-tenant, verified".

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

**ADDED 2026-08-07 (5b/5c/8 scaffold pass): rows 5b, 5c and 8 have a shared design now too — the
D11/D12 scaffold addendum right after D12, in the Decisions section above. Read it before starting
any of the three.** It solves D11's crux (per-org bootstrap codes did not exist — `auth/org-claim-
token.ts`, tested, frozen), specifies the exact `bootstrapFirstOrg` → `claimOrg` rename target,
flags the one product-flow decision it could NOT make on its own (hostname-based claim routing is
unreachable against the landed nginx/D9 topology — an explicit `orgSlug` field is the pragmatic
wire-level substitute, not a replacement decision), and gives the nine-unit ownership map. All three
rows remain **not yet built**: the wire contracts (`packages/contract/src/invites.ts`, `orgs.ts`,
`projects.ts`) and store seam (`IdentityStore#updateProjectTeam`, `Org.claimTokenHash`,
`createOrg`'s optional `claimTokenHash` input) are landed; the routes, the rename itself, the
installer step, the UI and the docs corrections are not.

**CORRECTED 2026-08-07 (5b/5c/8 landed): the last sentence above is stale — all nine units
landed.** The routes (`auth/invite-routes.ts`, `auth/team-routes.ts`, `POST /internal/orgs`),
the `bootstrapFirstOrg` → `claimOrg` rename, the hetzner `org-create` step, the Settings →
Teams pane, the board's team-option widening and the docs corrections are all in. Two things
the nine units did NOT do were caught and closed at the integration pass, and are recorded
here because both are the shape a future parallel-unit pass will reproduce:
- **A route mounted on one topology and not the other.** `inviteRoutes`/`teamRoutes` were
  threaded into `server/server.ts`'s single-process app and into nothing else, so on the D10
  hosted topology — the only one where a second org exists, and therefore the only one where
  5b/5c matter — every one of the seven routes 404'd. `SupervisorAppDeps` now carries all
  four `/auth/*` families as REQUIRED fields, so the compiler enforces the pairing.
- **An inventory gate that enumerated a subset of its own surface.**
  `auth-admin-routes.test.ts` composed two of the four route factories and called that "the
  whole `/auth/*` surface", so the seven new routes — three of them D12-gated admin verbs —
  were invisible to the assertion whose entire job is refusing an unclassified route. Driving
  every `ADMIN_ONLY` route with a body that satisfies no schema then exposed a second, older
  defect: `PATCH /auth/onboarding/team`'s role check sat INSIDE the handler, downstream of
  `jsonZodValidator`, so a `member` with a malformed body got 400 and an unauthenticated
  caller got 400. It uses `require-org-admin.ts`'s middleware now — the module that route was
  the stated precedent for.

**Still open after 5b/5c/8, named rather than folded in:** no cockpit UI creates or redeems
an invite (the routes are driven directly); `PATCH /api/v1/projects/:projectId`'s `teamId`
branch carries no D12 role check while `/auth/teams*`'s three verbs do (see the note at the
end of D12); and the three "known gaps" the scaffold pass listed — F4's first-membership
pinning, the missing bootstrap-code banner on `startSupervisor`, and the claim-mode wizard UX
— are all untouched.

**CORRECTED 2026-08-07 (repair stage): two of the three "known gaps" above are now closed, and
the list has grown two entries it did not have.** Read the paragraph above as the state at the
end of the build stage, not as current.

Closed at the repair stage:
- **The missing bootstrap-code banner on `startSupervisor`** — closed. It was not cosmetic: the
  supervisor is the only process that serves `POST /auth/onboarding/org` on the D10 topology, so
  with no banner a `--platform hetzner` deployment's FIRST org was unclaimable unless
  `CEZ_AUTH_BOOTSTRAP_TOKEN` had been pinned at install, and `docs/server-install/hetzner.md` told
  the operator to grep a journal that never held the code. `supervisor/index.ts#supervisorBootLines`
  is a pure function so the regression is pinned by a test rather than by the boot path (which
  binds a port and is untestable here by construction).
- **The claim-mode wizard UX** — closed. `/onboarding`'s `needs-invite` step now carries a
  collapsed "I have an organization code" disclosure that POSTs `{orgSlug, bootstrapToken}`.
  Collapsed rather than a fourth wizard state on purpose: `GET /auth/onboarding` still answers
  `needs-invite` to every membership-less user and deliberately does not hint that a claimable org
  exists (that fact is privileged and travels out of band with the code), so the disclosure asks
  the user to assert they hold a code rather than the server to volunteer that one is wanted.
  Without it, phase 8's verification row could only be executed with `curl`.

Still open, unchanged: **F4's first-membership pinning** (`session.ts#resolveIdentity` pins a
user to `listMemberships(userId)[0]` and `listTeams(orgId)[0]`, with no active-org switcher —
which is now *load-bearing* rather than latent, because the `user-already-member` refusals added
at this stage are what keep a second membership from ever existing to be silently ignored), and
the ungated `teamId` field above.

> **DECIDED 2026-08-17 (owner): the `teamId` reassignment PATCH is GATED on org
> membership.** The actor must have org scope — be a member/admin of the project's org —
> for `PATCH /api/v1/projects/:id { teamId }` to take effect; with no org scope
> (local/no-auth, or no org created) the field is rejected, not silently applied. This
> closes the ungated hole and, together with Fill unit 3's `?? null` guard, the
> maxParallel-clearing trap. F4's first-membership pinning stays open.

Added to the list at the repair stage:
- **No member roster and no member-removal surface** — D12 names "removing members" and nothing
  implements it. Full reasoning, and why the irreversible half is nonetheless closed, in the GAP
  note at the end of D12.
- **An `admin` can mint an `owner` invite** — **DECIDED 2026-08-17 (owner): NO.** Only an
  `owner` may create `owner`-role invites; an `admin` may invite up to `admin`/`member`. The
  invite-create path validates the requested role against the actor's own role and refuses an
  `owner` invite from a non-owner. Least-privilege, closing the escalation path *before* anything
  becomes owner-only rather than after. *Original open question, kept for context:* inert under
  D12's flat role model, live the moment anything becomes owner-only. Recorded as an OPEN question
  at the end of D12 rather than decided in an implementation pass.
- **The auth-off cockpit shows a "Teams" item in global settings.** The nav registry has three
  gates (`hidden`, `scope`, `capability`) and none can express "auth is on" — by design, since
  D1's Risks entry below forbids a `capabilities.auth` key and a test enforces its absence. The
  pane behind it is inert (one request, a static explainer, no writes, no identity file), and
  invariant 1 holds literally: no route diff, no health-payload diff, no server-side I/O with
  `CEZ_AUTH` unset. Recorded as an accepted deviation in `teams-section.tsx`'s own doc comment
  and in CHANGELOG.md rather than fixed, because both available fixes are worse than the symptom
  (a probe on the zero-config default, or the forbidden capability key).

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
  **ADDED 2026-08-07 (5b/5c/8 repair stage): the accepted cost of that decision is
  now visible in the product, and it should be written down rather than
  rediscovered.** Phase 5c's Settings → Teams section is registered like every
  other global section, and `visibleSettingsSections` has exactly three gates
  (`hidden`, `scope`, `capability`) — none of which can express "auth is on",
  because of the paragraph above. So the zero-config npm default shows a **Teams**
  nav item for a feature that deployment can never have; the pane behind it makes
  one request, gets the SPA catch-all, and renders a static explainer. Invariant 1
  is untouched — no route diff, no health-payload diff, no server-side I/O — and
  both available fixes are worse: a client-side probe puts a fetch on the default
  path this whole decision exists to keep quiet, and a `capabilities.auth` key is
  the exact move `capabilities.test.ts` fails on by design. Accepted, recorded in
  `teams-section.tsx`'s own doc comment and in CHANGELOG.md, and revisitable by
  whichever phase builds a login screen — which is the same phase that would add
  the capability key deliberately.
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

**CORRECTED 2026-08-07 (phases 5b/5c/8 landed): that last clause has expired, and what
replaces it is a bigger QA-Needed list, not a smaller one.** The org-creation surface exists
(`POST /internal/orgs` + the hetzner `org-create` step + `claimOrg`), so phase 6's
verification row — "two orgs ⇒ two unix users, two `CEZ_HOME`s, no shared path; org A cannot
read org B's runs" — is **runnable for the first time**, on a real host, by an operator. It
has not been run. Every bullet above still stands unchanged, and 5b/5c/8 add their own:
- **A second org, end to end, on one host.** The installer creating org two's row, printing
  its claim code, provisioning its unix user/`CEZ_HOME`/unit/vhost, and a different human
  claiming it at that org's hostname with that code — and, critically, **failing** to claim
  it with org one's code. Every assertion in this repo about this seeds both orgs in one
  `IdentityStore` in one process, which is the exact arrangement phase 6 abolishes.
- **An invite redeemed by a real second human through a real IdP.** The routes are tested;
  the flow (owner mints, hands the token over some channel, a stranger signs in and redeems)
  is not, and F4's first-membership pinning bug is waiting on exactly that path for a user
  who already belongs to another org.
- **`/auth/invites*` and `/auth/teams*` through real nginx.** They are mounted on the
  supervisor now and asserted in-process; whether nginx's org vhost actually routes
  `location /auth/` to the supervisor for these paths, and whether the session cookie is
  visible there, is the same live question D10's `auth_request` bullet already raises.
- **The claim code out of the journal on a hetzner host.** Still blocked by the pre-existing
  gap the scaffold pass named: `startSupervisor` never calls `bootstrapClaimBanner`, so org
  ONE's code does not print on this topology. Org two's code comes from the installer's own
  output instead, so 5b/5c/8 do not depend on it — but phase 8's own verification row for the
  FIRST org still does.

**ADDED 2026-08-07 (5b/5c/8 repair stage). Two corrections to the four bullets above, and then
the precise answer to "how much of phase 6's row does this phase actually close".**

Corrections first:
- The last bullet's blocker is **removed**, not still standing. `startSupervisor` prints the
  banner now (`supervisorBootLines`, pinned by `supervisor/index.test.ts`), so the documented
  `journalctl … | grep -i bootstrap` step is executable. What remains unobserved is one notch
  narrower and still real: that the line actually lands in a **systemd journal** in readable form
  on a real host, which is a `console.log`-under-`systemd` question, not a code question. Before
  this fix that step could not have succeeded on any hetzner host, and phase 8's verification row
  for the FIRST org was therefore unrunnable end to end.
- The first bullet says "claiming it **at that org's hostname**". It is not claimed there — see
  D11's correction. Read that bullet as "at the deployment's login host, entering org two's slug
  and org two's code, and **failing** with org one's code".

**Phase 6's row is "two orgs ⇒ two unix users, two `CEZ_HOME`s, no shared path; org A cannot read
org B's runs." It has two halves, and this phase closes exactly one of them.**

- **Closed: the far side of the boundary now exists.** The half that made the row *unrunnable*
  for three phases was not the isolation — that landed in phase 6 — it was that nothing created
  a second organization to isolate. `POST /internal/orgs` + the installer's `org-create` step +
  `claimOrg`'s claim branch + the wizard's claim form close that, and the repair stage's fixes are
  what make the path survive being walked by a human rather than by curl: the supervisor now
  prints org one's code, a mis-aimed claim refuses instead of burning the code, and the docs name
  the host the claim is actually served on. An operator can now run the row start to finish.
- **NOT closed, and not closeable from this repo: every observation the row asks for.** "Two unix
  users", "two `CEZ_HOME`s", "no shared path" and "org A cannot read org B's runs" are all
  filesystem and kernel facts on a provisioned host. Nothing in this repo has ever created a unix
  user, started a unit, or bound a port — by the standing rule this stage ran under, and by
  necessity: a `useradd` in CI proves nothing about an Ubuntu VPS. Every cross-org assertion here
  still seeds both orgs in ONE `IdentityStore` in ONE process, which is precisely the arrangement
  phase 6 abolishes, so the strongest thing the suite can say is "the application layer refuses
  cross-org access", never "the uid boundary holds".

So: **the row moved from unrunnable to unrun.** That is a real change of state and the only one
5b/5c/8 could deliver, but it is not evidence, and phases 6, 7, 5b, 5c and 8 all stay **QA
Needed** on a real Hetzner host. The first org can now be claimed on that host; the second org can
now exist there; whether the two are actually isolated remains, as it has been since phase 6, a
question only the host can answer.

### D15 verification — planned before implementation

Written up front per the repo's "plan the test" rule; results recorded in place
once each step has actually been executed, with anything unrun said plainly.

| # | Step | What it would catch | Result |
|---|------|--------------------|--------|
| 1 | Automated: probe answers `ready` + `hasProjects: false` → gate holds (redirect to `/onboarding`, cockpit chromeless) | The gate reading only `needs-org`, i.e. D15 not wired in at all | |
| 2 | Automated **negative control**: probe answers `ready` + `hasProjects: true` → gate does NOT fire | An enforcement that never releases — the "existing user walled out of their own cockpit" risk | |
| 3 | Automated: `unavailable` still does not gate | D14's bricked-topology failure mode, re-checked after widening the predicate | |
| 4 | Automated: boot registration is suppressed while no org exists, and NOT suppressed once one does | The vacuous-enforcement case the user actually reported; the second half is the regression control | |
| 5 | Automated: blank project creates `<projectsDir>/<name>`, `git init`s it, registers it against `teamId` | Silent wrong-location writes, and a "project" with no repo | |
| 6 | Automated: checkout route threads `teamId` through to registration | A clone filed under the wrong workspace when a second one exists | |
| 7 | Runtime E2E, real browser, wiped `~/.cezar`: org → workspace → **each** of the three project paths, confirming the wizard cannot be left without a project | Everything the unit tests cannot: that the three buttons exist, are reachable, and actually finish | |
| 8 | Runtime E2E: launch from inside a repo, confirm no project appears until chosen, and that the launch repo is offered pre-filled | The exact report this decision answers, plus the ergonomics promised in exchange | |

Step 7 is the one that decides Done vs QA Needed. Steps 1–6 are necessary and, on
this spec's own record, repeatedly insufficient: three consecutive review rounds
here ended green and were each found to contain a real defect, one introduced by
the round before it.
