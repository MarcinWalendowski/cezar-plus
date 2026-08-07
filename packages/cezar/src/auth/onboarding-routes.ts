import { Hono, type Context } from 'hono';
import {
  createOnboardingOrgInputSchema,
  renameOnboardingTeamInputSchema,
  type CreateOnboardingOrgResponse,
  type OnboardingStatusResponse,
  type Org as WireOrg,
  type RenameOnboardingTeamResponse,
  type Team as WireTeam,
} from '@open-mercato/cezar-contract';
import { jsonZodValidator } from '../server/validators.ts';
import { identityDir } from '../paths.ts';
import type { SessionResolver } from '../server/server.ts';
import { bootstrapClaim, matchesBootstrapClaim, type BootstrapClaim } from './bootstrap-claim.ts';
import { IdentityStore, IdentityStoreError } from './identity-store.ts';
import { readSessionIdFromCookieHeader, sessionResolver } from './session.ts';
import type { Org, Team } from './types.ts';

/**
 * D8's onboarding HTTP surface (spec `.ai/specs/2026-08-06-org-team-auth-onboarding.md`, phases
 * 4-5): `GET /auth/onboarding`, `POST /auth/onboarding/org`, `PATCH /auth/onboarding/team`.
 *
 * **Mount point — same family as `./routes.ts`, same reasoning.** `server.ts` mounts
 * `deps.onboardingRoutes` at the app ROOT next to `deps.authRoutes`, only when `CEZ_AUTH` names a
 * provider, and this file's paths (`/auth/onboarding*`) all fall under the reserved `auth` segment
 * D5 already carved out — no new top-level reservation needed. Critically, that root mount is
 * INSIDE `app.use('/auth/*', originGuard)` (the #426 loopback-Host allowlist + same-origin write
 * guard D5's own amendment added): phase 3 originally mounted `/auth/*` OUTSIDE `app.use('/api/*',
 * originGuard)`, leaving `POST /auth/logout` as the only unguarded write in the whole app, closed
 * by registering the SAME guard handler on both `/api/*` and `/auth/*`. This file's two mutating
 * routes ride that fix for free by living under `/auth/*` too — see
 * `onboarding-routes.test.ts`'s "mount point" suite, which proves it rather than assuming it.
 *
 * **Why this can't just be three more routes on `./routes.ts`'s `Hono`.** `routes.ts`'s own
 * module doc comment names exactly this gap and defers it: "a user who signs in with no existing
 * membership gets a real, valid session... every principal-gated read answers 401/unauthenticated
 * for them until an org exists" — `GET /auth/onboarding` is precisely the route that has to
 * answer THAT user, so it structurally cannot sit behind `requirePrincipal`
 * (`app.use('/api/*', ...)`, `server.ts`) OR treat "no session resolved" as terminal the way
 * `./routes.ts`'s `/auth/me` does. It needs a level of detail `SessionResolver` deliberately
 * collapses away: `session.ts`'s own module doc says a signed-in user with no membership yet
 * resolves to `null`, the exact same `null` an absent/expired/malformed cookie produces. This
 * file is the one place that tells those two apart — by reading `identity-store.ts`'s
 * `getSession`/`getUserById` directly, the way `orgs.ts`'s own doc comment on
 * `onboardingStateSchema` anticipated.
 *
 * **Authorization is three different bars, on purpose, not an oversight.**
 *  - `GET /auth/onboarding` and `POST /auth/onboarding/org` require only a SIGNED-IN USER (a
 *    resolvable session, a real `User` row) — D8 step 1's whole premise is that this route serves
 *    someone who does not have an org yet, so it cannot require the full D3 `Principal`
 *    (`orgId`/`teamId`/`role`), which by construction does not exist for them.
 *  - `POST /auth/onboarding/org` adds the **bootstrap claim** on top of that (ADDED 2026-08-07,
 *    `./bootstrap-claim.ts`): a signed-in user is not automatically permitted to *own* the
 *    deployment. With `CEZ_AUTH=google` the issuer is pinned but the audience is the whole
 *    internet, so "first to arrive" would hand a stranger `role: 'owner'` and, through it, shell
 *    execution. That module's doc comment carries the reproduced chain and the three modes.
 *  - `PATCH /auth/onboarding/team` requires a fully resolved `Principal` **with `role` owner or
 *    admin**, read through the SAME `sessionResolver` `server.ts`'s `requirePrincipal` and
 *    `verifyWsUpgrade` use (D3) — never a second, hand-rolled membership lookup. That is what
 *    makes "a member of org A cannot rename org B's team" true BY CONSTRUCTION rather than by a
 *    check this file remembers to add: the route takes no `orgId`/`teamId` in its body at all, and
 *    the only team it can ever touch is `principal.teamId`, which the shared resolver derived from
 *    the caller's OWN membership. See `onboarding-routes.test.ts`'s two-org negative test —
 *    including one where the request body tries to smuggle a different `orgId`/`teamId` and is
 *    ignored.
 */

// ---- deps: the testable seam --------------------------------------------------------------------

/** The subset of `IdentityStore` these routes touch — narrowed (not the whole class) so a test can
 *  hand in a fake without standing up every unrelated method, though in practice
 *  `onboarding-routes.test.ts` follows `./routes.test.ts`'s own precedent and uses a REAL,
 *  temp-directory `IdentityStore` throughout (no fakes for the store this file's whole job is to
 *  read/write correctly). */
export type OnboardingIdentityStore = Pick<
  IdentityStore,
  | 'getSession'
  | 'getUserById'
  | 'getOrgById'
  | 'getTeamById'
  | 'listOrgs'
  | 'listProjectTeams'
  | 'bootstrapFirstOrg'
  | 'renameTeam'
>;

export interface OnboardingRouteDeps {
  /** D3's one resolver — see the module doc comment on why `PATCH /auth/onboarding/team` uses
   *  this and the other two routes deliberately do not. */
  readonly sessionResolver: SessionResolver;
  readonly identityStore: OnboardingIdentityStore;
  /** Who is allowed to be the first user (`./bootstrap-claim.ts`). Injected rather than read from
   *  the module singleton so a test can exercise all three modes without mutating the shared
   *  `process.env` (one global per vitest worker, the same reason `SessionServiceOptions.
   *  authProvider` is injectable). Defaults to the process-lifetime claim. */
  readonly bootstrapClaim?: BootstrapClaim;
}

// ---- wire shaping --------------------------------------------------------------------------------

/** `identity-store.ts`'s `Org`/`Team` are `.passthrough()` (D7: a newer cezar's extra column must
 *  survive an older one's round trip through `identity.json`) — reading one straight off disk can
 *  therefore carry a key this route's wire contract never promised. Picking the known fields by
 *  hand is what keeps `GET /auth/onboarding` from ever leaking whatever a future column adds,
 *  matching AGENTS.md's "the contract must describe EXACTLY what the route sends — no wider, no
 *  narrower." `POST /auth/onboarding/org`'s org/team are freshly `orgSchema.parse`d/`teamSchema.
 *  parse`d by `identity-store.ts#createOrg` and carry nothing extra either way, but shaping every
 *  response through the same two functions means there is exactly one place this could go wrong,
 *  not two. */
function toWireOrg(org: Org): WireOrg {
  return { id: org.id, name: org.name, slug: org.slug, createdAt: org.createdAt };
}

function toWireTeam(team: Team): WireTeam {
  return { id: team.id, orgId: team.orgId, name: team.name, slug: team.slug };
}

// ---- signed-in-but-maybe-orgless user resolution (the gap `SessionResolver` collapses) ----------

interface SignedInUser {
  readonly userId: string;
  readonly email?: string;
}

/**
 * The lower bar `GET /auth/onboarding` and `POST /auth/onboarding/org` need. Reads the session
 * cookie through `./session.ts`'s exported `readSessionIdFromCookieHeader` — literally the same
 * function `resolveFromCookieHeader` calls — then the same `identity-store.ts#getSession` (already
 * expiry-checked, D6: "on every read"), but stops one step short of resolving org/team/role, which
 * is exactly the step that does not exist yet for a D8 "needs-org" user.
 *
 * **CORRECTED 2026-08-07 (repair stage).** This used `getCookie` from `hono/cookie` and claimed in
 * this very comment to read the cookie "the SAME way" `session.ts` does. On a header carrying two
 * `cez_session` values that was false — `getCookie` takes the FIRST, `session.ts`'s parser takes
 * the LAST — so a single request could create the org as one user while every other route in the
 * app acted as another. It also skipped `SESSION_ID_RE`. Both are gone: there is now one reader,
 * exported from the module that owns the cookie. See `readSessionIdFromCookieHeader`'s own doc
 * comment for the full attack it closes.
 */
function resolveSignedInUser(c: Context, store: OnboardingIdentityStore): SignedInUser | undefined {
  const sessionId = readSessionIdFromCookieHeader(c.req.header('cookie'));
  const session = sessionId ? store.getSession(sessionId) : undefined;
  if (!session) return undefined;
  const user = store.getUserById(session.userId);
  if (!user) return undefined; // defensive: a session's userId always names a real row today
  return { userId: user.id, email: user.email };
}

// ---- D8 step 2: "defaulted from ... the email domain when present" ------------------------------

/** Domains that name a personal mailbox rather than an organization — suggesting "Gmail" as an org
 *  name would be actively wrong, not merely unhelpful, so these fall back to no suggestion at all
 *  (same as having no email on file). Deliberately small and un-configurable: D9 doesn't ask for
 *  this to be a setting, and AGENTS.md's zero-config rule argues against inventing one just to
 *  cover a cosmetic default. */
const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'icloud.com',
  'me.com',
  'proton.me',
  'protonmail.com',
]);

function orgNameFromEmailDomain(email: string): string | undefined {
  const at = email.lastIndexOf('@');
  if (at === -1) return undefined;
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (!domain || PERSONAL_EMAIL_DOMAINS.has(domain)) return undefined;
  const label = domain.split('.')[0];
  if (!label) return undefined;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// ---- D8 step 2: slug is server-derived, never a user-input field --------------------------------

/** Lowercase-hyphen, matching `auth/types.ts`'s `slugSchema` shape
 *  (`^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`, 1-63 chars) without importing it — `slugSchema` is
 *  `identity-store.ts`'s internal STORAGE validation, not something this file's wire-facing slug
 *  derivation needs a runtime dependency on; a plain regex here says the same thing and stays
 *  correct even if that internal schema changes shape for reasons unrelated to slug allocation. */
function slugFromName(name: string): string {
  let base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (base.length > 63) base = base.slice(0, 63).replace(/-+$/g, '');
  return base || 'org';
}

/**
 * **There is deliberately no slug-collision retry loop here.** An earlier draft of this route
 * wrapped `createOrg` in a bounded `acme` → `acme-2` → `acme-3` retry, because `createOrg`'s doc
 * comment says "a slug collision is an `IdentityStoreError('org-slug-taken', …)` the route
 * disambiguates (e.g. by suffixing)." That loop only ever had anything to do because the route
 * ALSO let a second user create a second org — the defect fixed below. Now that this route calls
 * `bootstrapFirstOrg`, whose whole guard is `orgs.length > 0` (checked under the write lease), a
 * slug collision on the org being created is unreachable by construction: no org exists with any
 * slug at the only moment the write is permitted to proceed. Keeping the retry would have been
 * dead code that reads as a live guarantee — see `bootstrapFirstOrg`'s own doc comment, which
 * makes the same argument from the store's side.
 */

// ---- the routes -----------------------------------------------------------------------------------

export function createOnboardingRoutes(deps: OnboardingRouteDeps): Hono {
  const claim = deps.bootstrapClaim ?? bootstrapClaim;
  return new Hono()
    // ---- GET /auth/onboarding: the resumable state machine (D8, "two states, not four") --------
    .get('/auth/onboarding', (c) => {
      // Try the shared D3 resolver FIRST — reuses org/team/role resolution instead of a second,
      // possibly-drifting read of the same membership. Everything this needs for the 'ready'
      // state is already ON the resolved principal.
      const principal = deps.sessionResolver.resolveFromCookieHeader(c.req.header('cookie'));
      if (principal) {
        if (principal.kind !== 'session') {
          // Unreachable in practice — this route only ever mounts once `CEZ_AUTH` names a
          // provider, and `./session.ts`'s `sessionResolver` never resolves the `'local'` kind
          // (see its own defensive `authProvider === 'none'` branch) — but failing closed here
          // costs nothing and matches this codebase's general stance on "should never happen".
          return c.json({ error: 'onboarding is unavailable while CEZ_AUTH is unset' }, 500);
        }
        const org = deps.identityStore.getOrgById(principal.orgId);
        const team = deps.identityStore.getTeamById(principal.teamId);
        if (!org || !team) {
          // Also unreachable by construction (a resolved principal names a real org/team), same
          // fail-closed stance as above rather than a response the schema cannot describe.
          return c.json({ error: 'onboarding state is inconsistent for this session' }, 500);
        }
        const hasProjects = deps.identityStore.listProjectTeams({ orgId: org.id }).length > 0;
        const body: OnboardingStatusResponse = {
          state: 'ready',
          org: toWireOrg(org),
          team: toWireTeam(team),
          role: principal.role,
          hasProjects,
        };
        return c.json(body);
      }

      // No principal. That collapses "no session at all" and "signed in, no org yet" into the
      // same `null` (`session.ts`'s own doc comment names this) — the one distinction ONLY this
      // route needs to make, so it reads the cookie one level deeper than the shared resolver.
      const user = resolveSignedInUser(c, deps.identityStore);
      if (!user) return c.json({ error: 'unauthenticated' }, 401);

      // Which of the two membership-less states is this? The distinction is exactly
      // `bootstrapFirstOrg`'s own guard (`orgs.length > 0`), read here so the wizard is told the
      // truth BEFORE it asks for an org name it will only be able to refuse — see
      // `onboardingStateSchema`'s 2026-08-07 correction. This is a read of the same fact the
      // store enforces under its write lease, never a second rule: a user who sees `needs-org` and
      // races another to POST still loses at the lease, and gets the 409.
      if (deps.identityStore.listOrgs().length > 0) {
        const body: OnboardingStatusResponse = { state: 'needs-invite' };
        return c.json(body);
      }

      const body: OnboardingStatusResponse = {
        state: 'needs-org',
        suggestedOrgName: user.email ? orgNameFromEmailDomain(user.email) : undefined,
        bootstrapTokenRequired: claim.required,
      };
      return c.json(body);
    })

    // ---- POST /auth/onboarding/org: D8 steps 1 (bootstrap) + 2 (name it), one call --------------
    //
    // **CORRECTED 2026-08-07 (integration).** The first draft of this handler read
    // `listMemberships(user.userId).length > 0` and, if empty, did `createOrg` then a separate
    // `createMembership`. That is a PER-USER gate, and D8 step 1 is not a per-user rule: "the
    // first user to sign in becomes owner of a new org; **subsequent users need an invite**" —
    // deployment-wide, which phase 4's own verification row states as "invite required for the
    // second user", and which D4 requires anyway ("until the per-org split ships, hosted means
    // single-org": two orgs inside ONE process is a shared shell with two logins, the exact thing
    // the spec's Risks section names as the largest risk here). The per-user version let every
    // authenticated identity walk away owning its own org in the same process, and two *different*
    // users racing — each with zero memberships, so each passing its own check — was not closed by
    // `createMembership`'s recheck either, because they were writing two different membership rows.
    //
    // `bootstrapFirstOrg` replaces all three calls with one guarded write: it checks
    // `orgs.length > 0` on the snapshot re-read fresh UNDER the lease, and creates org + default
    // team + the `owner` membership in that same write. So the race is closed where D7 says every
    // uniqueness check belongs, and there is no longer a window in which an org exists with no
    // owner (the old two-call shape could die between `createOrg` and `createMembership` and strand
    // exactly that).
    .post('/auth/onboarding/org', jsonZodValidator(createOnboardingOrgInputSchema), async (c) => {
      const user = resolveSignedInUser(c, deps.identityStore);
      if (!user) return c.json({ error: 'unauthenticated' }, 401);

      const { name, bootstrapToken } = c.req.valid('json');
      // ADDED 2026-08-07 (repair stage). Being first is not, on its own, permission to own a
      // shell — see `./bootstrap-claim.ts`'s module doc comment for the reproduced 401→owner→
      // `spawn('bash')` chain this closes. Checked BEFORE the store write, so a wrong code leaves
      // nothing behind, and checked on EVERY request rather than once at boot, because the claim
      // is process state the route reads, not a fact about the caller.
      if (!matchesBootstrapClaim(claim, bootstrapToken)) {
        return c.json(
          {
            error:
              'this deployment needs its bootstrap code to create the first organization — it is printed in the server log at startup',
          },
          403,
        );
      }
      try {
        const { org, defaultTeam, membership } = await deps.identityStore.bootstrapFirstOrg({
          userId: user.userId,
          name,
          slug: slugFromName(name),
        });
        const body: CreateOnboardingOrgResponse = {
          org: toWireOrg(org),
          team: toWireTeam(defaultTeam),
          // Read off the row the store actually wrote, not the `'owner'` literal this route would
          // otherwise repeat — `bootstrapFirstOrg` hardcodes the role precisely so it is decided in
          // one place (its own doc comment), and re-stating it here would be a second copy to drift.
          role: membership.role,
        };
        return c.json(body, 201);
      } catch (error) {
        // **CORRECTED 2026-08-07 (repair stage): `membership-exists` was also caught here, and
        // could never arrive.** `bootstrapFirstOrg` throws exactly two codes —
        // `org-already-bootstrapped` and `user-not-found` — and never calls `createMembership`, so
        // that arm was dead code reading as a live guarantee. That is the same defect this file's
        // own slug-retry comment (above) argues against, decided the opposite way 100 lines apart;
        // removing it is the consistent answer. A mutation deleting the surviving arm is killed by
        // `onboarding-routes.test.ts`'s "second user" case.
        if (error instanceof IdentityStoreError && error.code === 'org-already-bootstrapped') {
          // The bootstrap window is closed, and joining now goes through an invite (D8 step 1).
          // Nothing was written on this path, so there is no orphaned org/team to clean up the way
          // the old two-call shape could leave behind.
          return c.json({ error: 'an organization already exists on this deployment — you need an invite to join it' }, 409);
        }
        throw error;
      }
    })

    // ---- PATCH /auth/onboarding/team: D8 step 3, "the step only renames it" ----------------------
    .patch('/auth/onboarding/team', jsonZodValidator(renameOnboardingTeamInputSchema), async (c) => {
      // The FULL D3 principal, not the lower `resolveSignedInUser` bar above — see the module doc
      // comment's "Authorization is two different bars" section. `principal.teamId` is the ONLY
      // team this handler can ever touch; the request body carries no id at all (`orgs.ts`'s own
      // doc comment on `renameOnboardingTeamInputSchema`), so a client cannot smuggle a different
      // org's team in even by trying.
      const principal = deps.sessionResolver.resolveFromCookieHeader(c.req.header('cookie'));
      if (!principal || principal.kind !== 'session') return c.json({ error: 'unauthenticated' }, 401);
      // ADDED 2026-08-07 (repair stage): the FIRST authorization decision in the codebase that
      // actually reads `principal.role`. Before this, `role` was carried on every principal,
      // constrained by a `CHECK (role IN (...))` in the store, mapped from IdP groups by
      // `oidc.ts` — and read by nothing but a response body, so `member` and `owner` were the same
      // thing. This route is not "onboarding-only" either: nothing scopes it to the `needs-org`
      // moment, so it is a permanent rename of the org's team. Renaming what the whole org sees is
      // an owner/admin act; `CEZ_OIDC_GROUP_ROLE_MAP` exists precisely so an operator can say who
      // is which, and until something consumes that distinction the map grants nothing real.
      // (Deliberately narrow: this pins the one route phase 4 introduced. Role enforcement across
      // the rest of `/api/v1/*` is a decision the spec does not make for phases 4-5 — see its
      // D8 amendment, which now says so out loud rather than leaving the field looking enforced.)
      if (principal.role !== 'owner' && principal.role !== 'admin') {
        return c.json({ error: 'only an owner or admin can rename the team' }, 403);
      }

      const { name } = c.req.valid('json');
      try {
        const team = await deps.identityStore.renameTeam(principal.teamId, name);
        const body: RenameOnboardingTeamResponse = { team: toWireTeam(team) };
        return c.json(body);
      } catch (error) {
        if (error instanceof IdentityStoreError && error.code === 'team-not-found') {
          // Unreachable today (nothing deletes a team), kept for the same reason every other
          // "should never happen" branch in this file is: a resolved principal that no longer
          // resolves to a real row must fail closed, not 500 with a stack trace.
          return c.json({ error: 'your team no longer exists' }, 404);
        }
        throw error;
      }
    });
}

// ---- the real, process-lifetime wiring ------------------------------------------------------------

/**
 * Opens its OWN `IdentityStore` at the same directory `./session.ts`/`./routes.ts` each open
 * theirs — exactly as consistent as sharing one, since none of the three keeps an in-memory cache
 * (see `identity-store.ts`'s own module doc on why: every read re-parses `identity.json`). Reuses
 * the module-scope `sessionResolver` singleton from `./session.ts` rather than requiring
 * `src/index.ts` to thread it through a second time — this module needs nothing `./session.ts`
 * doesn't already export, so, like `./routes.ts`'s `authRoutes`, it can build itself with a bare
 * `import('./auth/onboarding-routes.ts')` at the call site.
 */
function buildOnboardingRoutes(): Hono {
  const identityStore = IdentityStore.open(identityDir());
  return createOnboardingRoutes({ sessionResolver, identityStore });
}

/** What `src/index.ts`'s `serveCommand` dynamically imports and threads into `server.ts`'s
 *  `ServerDeps.onboardingRoutes`, mounted at the app root beside `deps.authRoutes`. Synchronous
 *  (unlike `authRoutes`, which awaits OIDC discovery) — this module has no external config to
 *  resolve or discovery call to make, so there is nothing to fail closed on at import time. */
export const onboardingRoutes: Hono = buildOnboardingRoutes();
