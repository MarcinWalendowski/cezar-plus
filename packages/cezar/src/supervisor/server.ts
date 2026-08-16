import { Hono, type Context, type Next } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { createInternalOrgInputSchema, type CreateInternalOrgResponse } from '@loki-labs/better-cezar-contract';
import { jsonZodValidator, paramZodValidator, queryZodValidator } from '../server/validators.ts';
import type { SessionResolver } from '../server/server.ts';
import { IdentityStoreError, type IdentityStore } from '../auth/identity-store.ts';
import { hashOrgClaimToken, mintOrgClaimToken } from '../auth/org-claim-token.ts';
import type { Org, ProjectTeam, Team } from '../auth/types.ts';
import { resolveAuthCheck } from './auth-request.ts';
import { X_CEZAR_PRINCIPAL_HEADER, X_CEZAR_SIGNATURE_HEADER } from './forwarded-principal.ts';
import { callerMayUseOrgId, resolveInternalCaller, type InternalCaller } from './internal-auth.ts';
import { cockpitAssetRoutes, serveCockpitShell } from '../server/shell-routes.ts';
import { OrgProcessRegistryError, type OrgProcessRegistrationInput, type OrgProcessRegistryStore } from './org-registry-store.ts';
import type { OrgProcessRecord } from './org-process-registry.ts';

/**
 * The supervisor's own HTTP surface (D4/D10, spec `.ai/specs/2026-08-06-org-team-auth-onboarding.md`).
 *
 * **`authRoutes`/`onboardingRoutes`/`inviteRoutes`/`teamRoutes` are mounted VERBATIM.** D10 is
 * explicit: the supervisor "imports `auth/routes.ts`'s `authRoutes` and
 * `auth/onboarding-routes.ts`'s `onboardingRoutes` verbatim ... and mounts them exactly as a phase
 * 1-3 single-process deployment does today." All four are already-built, already-tested `Hono`
 * instances built by `./index.ts` (the real wiring; this file's own `SupervisorAppDeps` takes them
 * as already-constructed values so `server.test.ts` can hand in the real ones — the same "no fakes
 * for a unit whose whole job is being correct" stance `auth/routes.test.ts` and
 * `auth/onboarding-routes.test.ts` already take with `IdentityStore`).
 *
 * **ADDED 2026-08-07 (5b/5c/8 integration pass): `inviteRoutes`/`teamRoutes` were declared and
 * mounted on the SINGLE-PROCESS path only, and were unreachable here.** `server/server.ts` gained
 * `ServerDeps.inviteRoutes`/`.teamRoutes` and `src/index.ts` threaded them, but this file's
 * `SupervisorAppDeps` carried neither and `startSupervisor` imported neither — so on the D10
 * topology, where nginx sends every `/auth/` request to the SUPERVISOR and never to an org
 * process, `/auth/invites*` and `/auth/teams*` answered 404. That is the exact deployment phases
 * 5b/5c/8 exist for: a hosted host with more than one org is the only place a second member and a
 * second team are reachable at all, and it was the one place the routes were not. The four fields
 * are REQUIRED, not optional, for the same reason `authRoutes` always was — the supervisor's boot
 * gate refuses `CEZ_AUTH=none` outright (`./index.ts`), so there is no topology where it serves
 * some of `/auth/*` and not the rest, and a required field makes the compiler enforce the wiring
 * that a comment could only ask for. (`team-routes.ts`'s own singleton docblock already claimed
 * `SupervisorAppDeps.teamRoutes` existed; it does now.)
 *
 * **What is genuinely new here — the `/internal/*` family, `internal;` in nginx, unreachable from
 * outside the box (D10):**
 *  - `GET /internal/auth-check` — nginx's `auth_request` target. See `./auth-request.ts`.
 *  - `GET /internal/orgs`, `GET /internal/orgs/:slug` — thin reads over `IdentityStore`, so the
 *    hetzner platform's `--provision-org` step can resolve an operator-named slug to an `orgId`
 *    without duplicating identity data (D10).
 *  - `POST /internal/orgs` — D11's first half, ADDED 2026-08-07 (5b/5c/8 scaffold pass, Fill unit
 *    6): the org row, created by the installer's not-yet-built `org-create` step (Fill unit 8),
 *    authenticated the same way every other admin verb here is. Mints and hashes a fresh per-org
 *    claim code (`auth/org-claim-token.ts`) and returns the RAW code exactly once, in this
 *    response, so the second half of D11 — the org's first owner claiming it — has something
 *    other than the deployment-wide bootstrap code to check against.
 *  - `GET /internal/teams`, `GET /internal/teams/:teamId` — thin reads over `IdentityStore`'s team
 *    table, for the two things an org process lost when phase 6 took its local `identity/`
 *    directory away: team NAMES to annotate the project board, and validating an explicit `teamId`
 *    on registration. ADDED 2026-08-07 at the integration pass — see their own comment below.
 *  - `/internal/project-teams*` — D4's root -> org mapping, owned exclusively by the supervisor
 *    once phase 6 lands (D4's amendment 2: "phase 6 must REPLACE [the phase-5 in-process] check,
 *    not merely join it"). This is the HTTP surface Fill unit 5's `supervisor/registry-client.ts`
 *    (not yet built) calls instead of opening `identityDir()` in-process — same
 *    `getProjectTeam`/`createProjectTeam`/`deleteProjectTeam`/`listProjectTeams` methods phase 5
 *    already built and tested, reached across a process boundary instead of in-process.
 *  - `/internal/org-processes*` — the org-process-registry's HTTP surface: register ("start"),
 *    deprovision ("stop"), and a live health probe, for the not-yet-built hetzner installer
 *    (phase 7) to drive provisioning through instead of touching the registry file directly (the
 *    registry lives under the SUPERVISOR's `CEZ_HOME`, reachable to the installer's own shell only
 *    if it happens to run as the supervisor's unix user — going through this HTTP surface instead
 *    means the installer never needs that).
 *
 * **CSRF posture.** `originGuard` (`server/server.ts`) is a large, `Host`-allowlist-aware guard
 * built for a deployment that is SOMETIMES loopback-local — none of that applies here: the
 * supervisor is, by D10's own design, always hosted behind nginx. What still applies is the
 * narrower half D5's amendment fixed `server.ts` for: a mutating request whose `Origin` does not
 * match its own `Host` is a forged cross-site write (`POST /auth/logout` was the concrete case that
 * amendment closed). `sameOriginWriteGuard` below is that narrower check, applied to `/auth/*` and
 * `/internal/*` alike, and it is a NEW, small function rather than a copy of `server.ts`'s
 * `originGuard` (which is unexported, and duplicating its DNS-rebinding-aware `Host` allowlist
 * logic here — logic this always-hosted process never needs — would be a second copy of something
 * this file has no reason to also own).
 */

// ---- deps: the testable seam ------------------------------------------------------------------

/** The subset of `IdentityStore` this surface touches — mirrors `auth/onboarding-routes.ts`'s own
 *  `OnboardingIdentityStore` narrowing precedent. */
export type SupervisorIdentityStore = Pick<
  IdentityStore,
  | 'listOrgs'
  | 'getOrgBySlug'
  | 'listTeams'
  | 'getTeamById'
  | 'listProjectTeams'
  | 'getProjectTeam'
  | 'createProjectTeam'
  // ADDED 2026-08-07 (5c, Fill unit 3): `PATCH /internal/project-teams`'s own write.
  | 'updateProjectTeam'
  | 'deleteProjectTeam'
  // ADDED 2026-08-07 (5b/5c/8 scaffold pass, D11, Fill unit 6): `POST /internal/orgs`'s own write.
  | 'createOrg'
>;

/** The subset of `OrgProcessRegistryStore` this surface touches. */
export type SupervisorOrgProcessRegistry = Pick<
  OrgProcessRegistryStore,
  'list' | 'getActiveByOrgId' | 'getActiveByHostname' | 'register' | 'deprovision'
>;

export interface SupervisorAppDeps {
  readonly authRoutes: Hono;
  readonly onboardingRoutes: Hono;
  /** 5b's `/auth/invites*` (`auth/invite-routes.ts`) — see the module doc comment on why these two
   *  fields are required rather than optional, and what it cost that they were absent. */
  readonly inviteRoutes: Hono;
  /** 5c's `/auth/teams*` (`auth/team-routes.ts`). */
  readonly teamRoutes: Hono;
  /** `process.env.CEZ_SUPERVISOR_ADMIN_TOKEN` in production (the supervisor unit's root-owned
   *  `EnvironmentFile=`). Absent ⇒ there is no admin caller and every `/internal/*` route that
   *  requires one answers 401 — see `./internal-auth.ts` for why that is the fail-closed default
   *  rather than an open one. */
  readonly adminToken?: string;
  /** The SAME resolver `authRoutes`/`onboardingRoutes` were built against (D3) — `/internal/auth-
   *  check` must resolve a session exactly the way `GET /auth/me` would, never a second read. */
  readonly sessionResolver: Pick<SessionResolver, 'resolveFromCookieHeader'>;
  readonly identityStore: SupervisorIdentityStore;
  readonly orgProcessRegistry: SupervisorOrgProcessRegistry;
  now?: () => Date;
  /** For `GET /internal/org-processes/:orgId/health`'s live probe. Defaults to the global `fetch`
   *  — a REAL network call in production, never invoked by this repo's own test suite (every test
   *  injects a fake). */
  fetchImpl?: typeof fetch;
}

// ---- wire shaping (mirrors `auth/onboarding-routes.ts`'s own precedent) -----------------------

function toWireOrgSummary(org: Org): { id: string; slug: string; name: string } {
  return { id: org.id, slug: org.slug, name: org.name };
}

/** `POST /internal/orgs`'s own wire contract (`createInternalOrgResponseSchema`, `packages/
 *  contract/src/orgs.ts`) is the FULL `orgSchema`, including `createdAt` — deliberately a
 *  separate function from `toWireOrgSummary` above rather than a shared one widened to match:
 *  `GET /internal/orgs`/`:slug`'s existing wire contract is `{id, slug, name}` only, asserted with
 *  `toEqual` (exact-shape) in `server.test.ts`, and widening the shared helper would silently add
 *  a field neither that test nor its one real caller (the hetzner installer's org-slug lookup,
 *  D10) ever asked for. Never returns `claimTokenHash` — it only reads the four fields it names,
 *  so there is no field to accidentally forward the hash through. */
function toWireOrgWithCreatedAt(org: Org): { id: string; slug: string; name: string; createdAt: string } {
  return { id: org.id, slug: org.slug, name: org.name, createdAt: org.createdAt };
}

function toWireProjectTeam(row: ProjectTeam): { projectRoot: string; orgId: string; teamId: string } {
  return { projectRoot: row.projectRoot, orgId: row.orgId, teamId: row.teamId };
}

function toWireTeam(team: Team): { id: string; orgId: string; name: string; slug: string } {
  return { id: team.id, orgId: team.orgId, name: team.name, slug: team.slug };
}

function toWireOrgProcess(record: OrgProcessRecord): Omit<OrgProcessRecord, 'supervisorSecret'> {
  // The secret is never echoed back over HTTP, even on this internal-only surface — the installer
  // that minted it already has its own copy (it is the one writing `EnvironmentFile=`, D10), and a
  // response body is one more place a value that authenticates every request to an org's process
  // could leak (logs, a proxy that buffers bodies, ...).
  const { supervisorSecret: _secret, ...rest } = record;
  return rest;
}

// ---- request validation ---------------------------------------------------------------------

const orgSlugParamSchema = z.object({ slug: z.string().min(1).max(63) });
const orgIdParamSchema = z.object({ orgId: z.string().min(1) });
const teamIdParamSchema = z.object({ teamId: z.string().min(1) });
const orgIdQuerySchema = z.object({ orgId: z.string().min(1) });
const listProjectTeamsQuerySchema = z.object({ orgId: z.string().min(1).optional(), teamId: z.string().min(1).optional() });
const rootQuerySchema = z.object({ root: z.string().min(1) });
const createProjectTeamInputSchema = z
  .object({
    projectRoot: z.string().min(1),
    orgId: z.string().min(1),
    teamId: z.string().min(1),
  })
  .strict();

/** `PATCH /internal/project-teams`'s body (5c, ADDED 2026-08-07, Fill unit 3) — deliberately no
 *  `orgId` field, matching `IdentityStore#updateProjectTeam`'s own signature: the D4 guard is
 *  checked against the EXISTING row's `orgId` (below, via `callerMayUseOrgId`), never one a
 *  caller names, so a reassignment can never smuggle a root across the org boundary. */
const updateProjectTeamInputSchema = z
  .object({
    projectRoot: z.string().min(1),
    teamId: z.string().min(1),
  })
  .strict();

/**
 * Deliberately its OWN `.strict()` schema rather than `orgProcessRecordSchema.omit({status: true,
 * createdAt: true})` (`./org-process-registry.ts`) — that schema is `.passthrough()` (an ON-DISK
 * shape a newer writer's extra field must survive), and this is a WIRE input from an
 * as-yet-unbuilt caller (the hetzner installer, phase 7): rejecting an unrecognized key here
 * catches a typo in that not-yet-written caller instead of silently ignoring it, the same
 * `.strict()`-for-wire / `.passthrough()`-for-disk split `forwarded-principal.ts`'s own module doc
 * comment already draws.
 */
const registerOrgProcessInputSchema = z
  .object({
    orgId: z.string().min(1),
    orgSlug: z.string().min(1),
    unixUser: z.string().min(1),
    cezHome: z.string().min(1),
    loopbackPort: z.number().int().positive().max(65535),
    hostname: z.string().min(1),
    platformId: z.literal('hetzner'),
    supervisorSecret: z.string().min(32),
  })
  .strict();

const listOrgProcessesQuerySchema = z.object({ hostname: z.string().min(1).optional() });

// ---- CSRF: the narrow half of #426 that applies to an always-hosted process --------------------

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function hostOfOrigin(origin: string): string | undefined {
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return undefined;
  }
}

/** See the module doc comment's "CSRF posture" section. A mutating request with NO `Origin` (every
 *  non-browser caller: nginx's own proxying, the hetzner installer's loopback curl, `auth_request`
 *  subrequests) passes untouched — browsers are the only client this guards against, and browsers
 *  always attach `Origin` to a cross-origin write. */
async function sameOriginWriteGuard(c: Context, next: Next): Promise<Response | void> {
  if (!MUTATING_METHODS.has(c.req.method)) return next();
  const origin = c.req.header('origin');
  if (origin === undefined) return next();
  const originHost = hostOfOrigin(origin);
  const host = c.req.header('host')?.toLowerCase();
  if (!originHost || originHost !== host) {
    return c.json({ error: 'forbidden: cross-origin write rejected (same-origin only)' }, 403);
  }
  return next();
}

// ---- the app ------------------------------------------------------------------------------------

/** ~64 KiB: every body this surface accepts is a handful of short string fields — generous
 *  headroom over the largest real payload (`registerOrgProcessInputSchema`) without carrying
 *  `server/server.ts`'s 32 MiB agent-upload-sized limit onto a process that never handles one. */
const SUPERVISOR_BODY_LIMIT = 64 * 1024;

/**
 * The one `/internal/*` route that carries NO credential, by design: nginx's `auth_request`
 * subrequest cannot present one (the secret would have to sit in a world-readable vhost file, and
 * `/internal/auth-check` is per-BROWSER-session anyway — it signs for whichever org the caller's
 * own cookie already resolves to, so a local prober with no session gets a 401 and one with a
 * session gets headers for the org they are already a member of). Both generated vhosts mark
 * `location /internal/` `internal;` (`server-install/platforms/hetzner/nginx.ts`), so no external
 * client reaches it either.
 */
const UNAUTHENTICATED_INTERNAL_PATHS = new Set(['/internal/auth-check']);

/** `Context` typing for the caller the `/internal/*` guard resolves once per request. */
type InternalEnv = { Variables: { internalCaller: InternalCaller } };

export function createSupervisorApp(deps: SupervisorAppDeps): Hono {
  const now = deps.now ?? (() => new Date());
  const fetchImpl = deps.fetchImpl ?? fetch;

  const app = new Hono();
  app.use('*', bodyLimit({ maxSize: SUPERVISOR_BODY_LIMIT }));
  app.use('/auth/*', sameOriginWriteGuard);
  app.use('/internal/*', sameOriginWriteGuard);

  /**
   * **The `/internal/*` credential check (ADDED 2026-08-07, repair stage).** See
   * `./internal-auth.ts`'s module doc for what was reproduced without it — in short, any caller
   * could `DELETE /internal/project-teams/by-root` (D4 data loss), re-claim the root for another
   * org, and re-register an org process with an attacker-chosen `supervisorSecret`.
   *
   * Registered on `/internal/*` only. `/auth/*` deliberately keeps NO bearer requirement: those
   * are the browser's own login routes, and a credential the browser cannot hold is not a check,
   * it is a lockout.
   */
  app.use('/internal/*', async (c: Context<InternalEnv>, next: Next) => {
    if (UNAUTHENTICATED_INTERNAL_PATHS.has(c.req.path)) return next();
    const caller = resolveInternalCaller(c.req.header('authorization'), {
      adminToken: deps.adminToken,
      listOrgProcesses: () => deps.orgProcessRegistry.list(),
    });
    if (!caller) return c.json({ error: 'unauthorized' }, 401);
    c.set('internalCaller', caller);
    return next();
  });

  /**
   * **Admin-only route families, enforced as MIDDLEWARE rather than as a first line in each
   * handler.** CORRECTED 2026-08-07 (repair stage): the check used to sit inside each handler,
   * which put it *after* that route's `jsonZodValidator`/`paramZodValidator`. So
   * `POST /internal/org-processes` answered a valid ORG credential carrying a malformed body with
   * **400**, not 403 — the caller learned whether its payload parsed before learning it was never
   * allowed to call the route at all. The refusal was still correct for a well-formed body, so this
   * was an ordering and oracle defect rather than a bypass, but the ordering is the part that would
   * silently rot: authorization that runs after parsing is one `.optional()` away from running
   * after a side effect.
   *
   * As middleware it also cannot be forgotten on a route added later, which the in-handler shape
   * could not promise — the same "one guarded helper, not a check at each call site, or the
   * guarantee decays to 'every caller remembered'" reasoning D7 already applies to the identity
   * store's uniqueness checks. `server.test.ts`'s route-inventory assertion walks this app's own
   * route table and fails when an `/internal/*` path appears that neither list below classifies.
   *
   * `/internal/orgs*` enumerates every tenant on the box; `/internal/org-processes*` carries the
   * whole infrastructure map plus the two lifecycle writes that decide whether an org is reachable
   * at all (`POST` sets the very key that signs that org's forwarded principals). An org process
   * needs none of it — only the operator's installer does.
   */
  const requireAdmin = async (c: Context<InternalEnv>, next: Next): Promise<Response | void> => {
    // `?.` and not `!`: if the credential middleware above ever stops running for a path this one
    // covers, the answer is 403, never "undefined is not admin, but let's find out later".
    if (c.get('internalCaller')?.kind !== 'admin') {
      return c.json({ error: 'forbidden: admin credential required' }, 403);
    }
    return next();
  };
  for (const path of ['/internal/orgs', '/internal/orgs/*', '/internal/org-processes', '/internal/org-processes/*']) {
    app.use(path, requireAdmin);
  }

  /** The org-scoping refusal `supervisor/registry-client.ts`'s wire contract specifies (403, not
   *  404 — the caller IS authenticated, it is just not this org). One wording, one status, one
   *  place, so two routes can never answer the same fact differently. */
  const refuseOrgScope = (c: Context, orgId: string | undefined): Response =>
    c.json(
      {
        error:
          orgId === undefined
            ? 'forbidden: orgId is required — an org process may only read its own org'
            : 'forbidden: this credential does not belong to that organization',
      },
      403,
    );

  // ---- /auth/* — mounted verbatim (see module doc comment) -------------------------------------
  // All four in the SAME order `server/server.ts`'s single-process `createApp` mounts them
  // (`authRoutes`, `onboardingRoutes`, `inviteRoutes`, `teamRoutes`), so the two topologies cannot
  // resolve an overlapping path differently. Every one of them is already covered by the
  // `app.use('/auth/*', sameOriginWriteGuard)` registration above — the perimeter half D5's
  // amendment closed for `POST /auth/logout`, which a route family living outside `/api/` has to
  // be added to explicitly because nothing derives it.
  app.route('/', deps.authRoutes);
  app.route('/', deps.onboardingRoutes);
  app.route('/', deps.inviteRoutes);
  app.route('/', deps.teamRoutes);

  const internal = new Hono<InternalEnv>()
    // ---- GET /internal/auth-check: nginx's auth_request target (D10) ---------------------------
    .get('/internal/auth-check', (c) => {
      const result = resolveAuthCheck(c.req.header('cookie'), {
        sessionResolver: deps.sessionResolver,
        getActiveOrgProcess: (orgId) => deps.orgProcessRegistry.getActiveByOrgId(orgId),
        now,
      });
      if (!result.ok) return c.json({ error: result.reason }, 401);
      c.header(X_CEZAR_PRINCIPAL_HEADER, result.headers.principalHeader);
      c.header(X_CEZAR_SIGNATURE_HEADER, result.headers.signatureHeader);
      return c.body(null, 200);
    })

    // ---- GET /internal/orgs, GET /internal/orgs/:slug -------------------------------------------
    // ADMIN ONLY. These enumerate every tenant on the box (id, slug, display name) and exist for
    // exactly one caller: `server-install --platform hetzner --org-slug <slug>`, resolving an
    // operator-named slug to an `orgId` before it provisions anything (D10). An ORG process has no
    // use for them and must not be able to learn its neighbours' names, so a valid org secret is
    // not enough here — `callerMayUseOrgId` is about scoping a filter; this is a different answer
    // to a different question ("may you see the whole roster"), and conflating the two is how a
    // scoping check quietly becomes an authorization one.
    .get('/internal/orgs', (c) => {
      return c.json({ orgs: deps.identityStore.listOrgs().map(toWireOrgSummary) });
    })
    .get('/internal/orgs/:slug', paramZodValidator(orgSlugParamSchema), (c) => {
      const { slug } = c.req.valid('param');
      const org = deps.identityStore.getOrgBySlug(slug);
      if (!org) return c.json({ error: `no org with slug "${slug}"` }, 404);
      return c.json({ org: toWireOrgSummary(org) });
    })

    // ---- POST /internal/orgs -----------------------------------------------------------------
    // ADDED 2026-08-07 (5b/5c/8 scaffold pass, Fill unit 6). D11's first half: "the org row —
    // created by the installer through a new admin-only POST /internal/orgs, authenticated by
    // CEZ_SUPERVISOR_ADMIN_TOKEN". ADMIN ONLY — inherited from the `requireAdmin` middleware
    // already registered on this exact path above (the `for (const path of [...])` loop), NOT a
    // check in this handler: that ordering is what keeps a non-admin's malformed body from ever
    // reaching `jsonZodValidator` (see the middleware's own doc comment on why the check used to
    // sit downstream of validation and what that cost — 400, leaking the body schema, instead of
    // 403).
    //
    // Mints and hashes a fresh per-org claim code (`auth/org-claim-token.ts`, D11's crux) rather
    // than accepting one on the wire: the raw code exists to leave this process exactly once, in
    // THIS response, for the installer to print for the org's intended owner — nothing upstream
    // of this route has a code to hand in, and accepting a caller-supplied one would let whoever
    // holds the admin token also choose a weak or reused code.
    .post('/internal/orgs', jsonZodValidator(createInternalOrgInputSchema), async (c) => {
      const { name, slug } = c.req.valid('json');
      const bootstrapToken = mintOrgClaimToken();
      try {
        const { org, defaultTeam } = await deps.identityStore.createOrg({
          name,
          slug,
          claimTokenHash: hashOrgClaimToken(bootstrapToken),
        });
        const body: CreateInternalOrgResponse = { org: toWireOrgWithCreatedAt(org), team: toWireTeam(defaultTeam), bootstrapToken };
        return c.json(body, 201);
      } catch (error) {
        if (error instanceof IdentityStoreError && error.code === 'org-slug-taken') {
          return c.json({ error: error.message, code: error.code }, 409);
        }
        throw error;
      }
    })

    // ---- GET /internal/teams, GET /internal/teams/:teamId ---------------------------------------
    // ADDED 2026-08-07 at the phase 6/7 integration pass. `supervisor/registry-client.ts` has
    // called both since it was written — its own module doc comment named their absence as "gap 1"
    // — and the org process needs them for the two things the phase-5 in-process `IdentityStore`
    // gave it for free: team NAMES for the project board (`server.ts#withTeams`, which caught the
    // resulting throw and silently degraded to an unannotated listing, so D5's "team filter on the
    // board" was dead in supervisor mode) and `getTeamById` validation of an explicit `teamId` on
    // registration (`server.ts#registerFolder`, where the throw is NOT caught and surfaced as a
    // 500). Shapes are exactly the ones the client already expects, and `registry-client.test.ts`
    // now round-trips them against this real app rather than asserting they 404.
    .get('/internal/teams', queryZodValidator(orgIdQuerySchema), (c) => {
      const { orgId } = c.req.valid('query');
      if (!callerMayUseOrgId(c.get('internalCaller'), orgId)) return refuseOrgScope(c, orgId);
      return c.json({ teams: deps.identityStore.listTeams(orgId).map(toWireTeam) });
    })
    .get('/internal/teams/:teamId', paramZodValidator(teamIdParamSchema), (c) => {
      // `null`, not a 404, for an unknown id: this mirrors `IdentityStore#getTeamById`'s own
      // never-throws-for-missing contract, and the client (`getTeamById`) distinguishes "the
      // route answered, the team does not exist" from "the call failed" on exactly that field.
      //
      // TIGHTENED 2026-08-07 (repair stage): a team belonging to ANOTHER org reads as `null` for
      // an org caller. `registry-client.ts`'s contract said "any active org — the client re-checks
      // `team.orgId` itself", which is true of the one client that exists and is not a property
      // the supervisor can rely on; answering with a sibling tenant's team NAME because the caller
      // guessed an opaque id is a leak with no consumer. The single real call site
      // (`server.ts#registerFolder`, validating an explicit `teamId` on registration) only ever
      // names its OWN org's team, so it sees no change.
      const { teamId } = c.req.valid('param');
      const team = deps.identityStore.getTeamById(teamId);
      if (!team) return c.json({ team: null });
      if (!callerMayUseOrgId(c.get('internalCaller'), team.orgId)) return c.json({ team: null });
      return c.json({ team: toWireTeam(team) });
    })

    // ---- /internal/project-teams* : D4's root -> org mapping, the supervisor's alone (D4 amend. 2)
    .get('/internal/project-teams', queryZodValidator(listProjectTeamsQuerySchema), (c) => {
      const { orgId, teamId } = c.req.valid('query');
      // An org caller MUST name its own `orgId`; an absent filter would mean "every org's project
      // roots", which is the enumeration `registry-client.ts`'s wire contract explicitly requires
      // this route to refuse. Admin (the installer) may list everything.
      if (!callerMayUseOrgId(c.get('internalCaller'), orgId)) return refuseOrgScope(c, orgId);
      return c.json({ projectTeams: deps.identityStore.listProjectTeams({ orgId, teamId }).map(toWireProjectTeam) });
    })
    .get('/internal/project-teams/by-root', queryZodValidator(rootQuerySchema), (c) => {
      // `root` must already be normalized (realpath) by the caller — the same contract
      // `IdentityStore#getProjectTeam` already documents for its in-process callers
      // (`server.ts`'s `mayActOnRoot`/`withTeams`), unchanged now that the call crosses an HTTP
      // boundary instead.
      const { root } = c.req.valid('query');
      const row = deps.identityStore.getProjectTeam(root);
      if (!row) return c.json({ error: `no org/team claim on ${root}` }, 404);
      // TIGHTENED 2026-08-07 (5b/5c/8 repair stage). This was the ONE verb in the
      // `/internal/project-teams*` family with no org scoping — `POST`, `PATCH` and `DELETE` all
      // call `callerMayUseOrgId`, and this one went straight from the validator to the store.
      // Reproduced at review holding org A's `CEZ_SUPERVISOR_SECRET` against org B's root: 200,
      // with org B's `orgId` and `teamId` in the body, while every sibling verb answered 403.
      // Under D4 every MEMBER of org A shares that org's unix user and shell, and D10 delivers the
      // secret into that process's environment, so this is reachable by a tenant, not only by the
      // operator — the exact caller `internal-auth.ts`'s own module doc names as its threat model.
      //
      // Scoped against the EXISTING row's `orgId`, never a caller-named one, exactly like `PATCH`
      // and `DELETE` on this path. The 403-vs-404 split (claimed-by-another vs. unclaimed) is the
      // same split those two already have, so this adds no oracle that was not already there.
      //
      // **This does not weaken `server.ts#mayActOnRoot`, which needs to see a foreign claim in
      // order to refuse.** `registry-client.ts`'s `call()` turns a 403 into
      // `RegistryClientError('unauthorized')`, and `mayActOnRoot` is deliberately fail-CLOSED
      // (`catch { return false; }`, its own doc comment) — so a root claimed by another org still
      // refuses the write, now because the supervisor refused to answer rather than because the
      // client compared two org ids. Pinned by `registry-client.test.ts`.
      if (!callerMayUseOrgId(c.get('internalCaller'), row.orgId)) return refuseOrgScope(c, row.orgId);
      return c.json({ projectTeam: toWireProjectTeam(row) });
    })
    .post('/internal/project-teams', jsonZodValidator(createProjectTeamInputSchema), async (c) => {
      const { projectRoot, orgId, teamId } = c.req.valid('json');
      // The actual D4 write. Without this check any holder of ANY org's secret could claim a root
      // for a DIFFERENT org — the "two processes over one `.ai/cezar`" history loss D4's hard
      // constraint exists to prevent, reached through the very surface that was supposed to own
      // the mapping.
      if (!callerMayUseOrgId(c.get('internalCaller'), orgId)) return refuseOrgScope(c, orgId);
      try {
        // `createProjectTeam` resolves `projectRoot` to its own realpath internally — see that
        // method's own doc comment on why that is the ONE place this store does so.
        const row = await deps.identityStore.createProjectTeam({ projectRoot, orgId, teamId });
        return c.json({ projectTeam: toWireProjectTeam(row) }, 201);
      } catch (error) {
        if (error instanceof IdentityStoreError) {
          // `code` alongside `error` (ADDED 2026-08-07, integration pass — "gap 2" in
          // `supervisor/registry-client.ts`'s module doc comment). The status alone cannot carry
          // this: TWO `IdentityStoreError` codes map onto 404 and two onto 409, so a client
          // reading the discriminant off the status would have to guess, and guessing wrong on a
          // D4 boundary is worse than failing. The client deliberately trusts only this field —
          // without it every failure here threw `unexpected`, turning `registerFolder`'s
          // "project-root-taken ⇒ 409 with the cross-org wording" branch into an unreachable 500.
          if (error.code === 'org-not-found' || error.code === 'team-not-found') {
            return c.json({ error: error.message, code: error.code }, 404);
          }
          if (error.code === 'team-org-mismatch' || error.code === 'project-root-taken') {
            return c.json({ error: error.message, code: error.code }, 409);
          }
        }
        throw error;
      }
    })

    // ---- PATCH /internal/project-teams: 5c reassignment (D4 amendment 2, Fill unit 3, ADDED
    // 2026-08-07) — the phase-5 in-process `updateProjectTeam` call, replaced by this supervisor
    // route exactly as D4's amendment 2 requires ("REPLACED, not merely joined"). Org-scoped
    // against the EXISTING row's `orgId`, mirroring `DELETE /internal/project-teams/by-root`'s own
    // posture: the wire body carries no `orgId` for a caller to name, so the only org this can ever
    // act against is whichever one already claimed `projectRoot`.
    .patch('/internal/project-teams', jsonZodValidator(updateProjectTeamInputSchema), async (c) => {
      const { projectRoot, teamId } = c.req.valid('json');
      const existing = deps.identityStore.getProjectTeam(projectRoot);
      if (!existing) return c.json({ error: `no org/team claim on ${projectRoot}`, code: 'project-root-not-found' }, 404);
      if (!callerMayUseOrgId(c.get('internalCaller'), existing.orgId)) return refuseOrgScope(c, existing.orgId);
      try {
        const row = await deps.identityStore.updateProjectTeam(projectRoot, teamId);
        return c.json({ projectTeam: toWireProjectTeam(row) });
      } catch (error) {
        if (error instanceof IdentityStoreError) {
          // Same `code`-alongside-`error` discipline `POST /internal/project-teams` above already
          // uses, and for the identical reason: the status alone cannot carry the discriminant.
          if (error.code === 'project-root-not-found' || error.code === 'team-not-found') {
            return c.json({ error: error.message, code: error.code }, 404);
          }
          if (error.code === 'team-org-mismatch') {
            return c.json({ error: error.message, code: error.code }, 409);
          }
        }
        throw error;
      }
    })
    .delete('/internal/project-teams/by-root', queryZodValidator(rootQuerySchema), async (c) => {
      const { root } = c.req.valid('query');
      // TIGHTENED 2026-08-07 (repair stage). `registry-client.ts`'s contract said "any active org
      // — authorization already happened via a prior `mayActOnRoot` round trip", which describes
      // what the ONE well-behaved client does, not what the supervisor enforces. Holding org B's
      // secret and calling this directly destroyed org A's claim, which D4's amendment 1 names as
      // "not tenancy-shaped behaviour, it is data loss". The owning org (or admin) only.
      //
      // An UNCLAIMED root answers `{released:false}` rather than 403: there is nothing to
      // authorize against and nothing to destroy, and 403 there would be an oracle for whether an
      // arbitrary path is registered to somebody.
      const existing = deps.identityStore.getProjectTeam(root);
      if (!existing) return c.json({ released: false });
      if (!callerMayUseOrgId(c.get('internalCaller'), existing.orgId)) return refuseOrgScope(c, existing.orgId);
      const released = await deps.identityStore.deleteProjectTeam(root);
      return c.json({ released });
    })

    // ---- /internal/org-processes* : process lifecycle — register ("start"), deprovision
    // ("stop"), health, and hostname -> org -> process resolution (D4/D10) -----------------------
    // ADMIN ONLY, every verb. These carry the deployment's whole infrastructure map (each org's
    // `unixUser`, `cezHome`, `loopbackPort`, `hostname`) and the two lifecycle writes that decide
    // whether an org is reachable at all — `POST` sets the very key that signs that org's
    // forwarded principals, and `DELETE` takes an org permanently offline
    // (`/internal/auth-check` then answers `org-has-no-active-process` for every one of its
    // requests). An org process needs none of it; only the operator's installer does.
    .get('/internal/org-processes', queryZodValidator(listOrgProcessesQuerySchema), (c) => {
      const { hostname } = c.req.valid('query');
      if (hostname !== undefined) {
        const record = deps.orgProcessRegistry.getActiveByHostname(hostname);
        return c.json({ orgProcesses: record ? [toWireOrgProcess(record)] : [] });
      }
      return c.json({ orgProcesses: deps.orgProcessRegistry.list().map(toWireOrgProcess) });
    })
    .get('/internal/org-processes/:orgId', paramZodValidator(orgIdParamSchema), (c) => {
      const { orgId } = c.req.valid('param');
      const record = deps.orgProcessRegistry.getActiveByOrgId(orgId);
      if (!record) return c.json({ error: `org ${orgId} has no active process` }, 404);
      return c.json({ orgProcess: toWireOrgProcess(record) });
    })
    .get('/internal/org-processes/:orgId/health', paramZodValidator(orgIdParamSchema), async (c) => {
      const { orgId } = c.req.valid('param');
      const record = deps.orgProcessRegistry.getActiveByOrgId(orgId);
      if (!record) return c.json({ error: `org ${orgId} has no active process` }, 404);
      // A live probe of the RUNNING process, not a re-read of the stored `status` (see the module
      // doc comment on why this is a route concern, not the registry store's). Best-effort: any
      // network failure (process down, port not yet bound) is a normal, expected answer here, not
      // a 500 — the whole point of a health check is to report "unhealthy" rather than to throw.
      try {
        const response = await fetchImpl(`http://127.0.0.1:${record.loopbackPort}/api/v1/health`, {
          signal: AbortSignal.timeout(2_000),
        });
        return c.json({ healthy: response.ok, status: response.status });
      } catch (error) {
        return c.json({ healthy: false, error: error instanceof Error ? error.message : String(error) });
      }
    })
    .post('/internal/org-processes', jsonZodValidator(registerOrgProcessInputSchema), async (c) => {
      const input: OrgProcessRegistrationInput = c.req.valid('json');
      try {
        const record = await deps.orgProcessRegistry.register(input);
        return c.json({ orgProcess: toWireOrgProcess(record) }, 201);
      } catch (error) {
        if (error instanceof OrgProcessRegistryError) return c.json({ error: error.message }, 409);
        throw error;
      }
    })
    .delete('/internal/org-processes/:orgId', paramZodValidator(orgIdParamSchema), async (c) => {
      const { orgId } = c.req.valid('param');
      const deprovisioned = await deps.orgProcessRegistry.deprovision(orgId);
      return c.json({ deprovisioned });
    });

  app.route('/', internal);

  // ---- the cockpit shell (ADDED 2026-08-07, repair stage) ---------------------------------------
  // `auth/routes.ts`'s `/auth/callback` redirects EVERY completed sign-in to `/onboarding`, and
  // `/onboarding` is a top-level React route (`packages/web/src/routes.tsx`, deliberately outside
  // `ProjectScopeRoute` since there may be no org yet). Without these two mounts that redirect
  // landed on a bare 404 and D8's wizard was unreachable, so no org could ever be created on a
  // hetzner deployment — and `hetzner.ts#verifyStep`, which requires the login host to answer
  // 2xx/3xx, aborted every supervisor install. Same module `server/server.ts` mounts, so both
  // hosts serve identical bytes.
  //
  // `GET /` redirects rather than rendering the shell: on the login host there is no project
  // registry and no `/api/v1/*` family at all, so the SPA's own bare-root gate would bounce
  // through `/p/default/...` and land on a screen whose every query 404s. `/onboarding` is what
  // this host is FOR (D10: the supervisor terminates auth and hosts onboarding; projects live on
  // an org's own host), and the wizard sends an already-onboarded user onward itself.
  app.get('/', (c) => c.redirect('/onboarding', 302));
  app.route('/', cockpitAssetRoutes());
  app.get('*', (c) => serveCockpitShell(c) ?? c.notFound());

  return app;
}
