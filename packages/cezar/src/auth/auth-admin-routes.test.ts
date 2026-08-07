import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { createAuthRoutes, type AuthRouteDeps } from './routes.ts';
import { createOnboardingRoutes, type OnboardingRouteDeps } from './onboarding-routes.ts';
import { createInviteRoutes } from './invite-routes.ts';
import { createTeamRoutes } from './team-routes.ts';
import { IdentityStore } from './identity-store.ts';
import { SessionService } from './session.ts';
import { OidcClient, type OidcDiscoveryDocument, type ResolvedOidcConfig } from './oidc.ts';

/**
 * D12's route-inventory gate over `/auth/*` (spec `.ai/specs/2026-08-06-org-team-auth-onboarding.md`,
 * D11/D12 scaffold's "role enforcement" unit) — mirrors `supervisor/server.ts`'s own
 * two-directional `ADMIN_ONLY`/`ORG_SCOPED` assertion, the pattern invariant 3 leans on, applied
 * to the family `./require-org-admin.ts`'s `requireOrgAdmin` exists to gate.
 *
 * Composes `createAuthRoutes` + `createOnboardingRoutes` + `createInviteRoutes` +
 * `createTeamRoutes` at root, in the SAME order `server/server.ts` and `supervisor/server.ts` both
 * mount them — these four factories together define the whole `/auth/*` surface.
 *
 * **CORRECTED 2026-08-07 (5b/5c/8 integration pass): this file used to compose TWO of them and
 * describe that as "the whole `/auth/*` surface as it exists today".** It was true when written
 * and stopped being true within the same session: 5b's `/auth/invites*` and 5c's `/auth/teams*`
 * landed in parallel, adding seven routes — three of them D12-gated admin verbs — that this
 * assertion could not see, because a route the app never registers here is a route this inventory
 * cannot fail on. A gate that enumerates a subset of the surface reports "everything is
 * classified" with the same green tick as one that enumerates all of it, which is exactly the
 * shape the supervisor's own inventory had (path-only keys hiding a second verb) and exactly what
 * invariant 3 exists to prevent. Composing every factory is what makes the two-directional
 * assertion below mean what it says.
 *
 * **The property this protects.** An admin route (org rename, member removal — still unbuilt) that
 * lands on `/auth/*` without being added to `ADMIN_ONLY` below fails the first test in this file,
 * forcing whoever adds it to decide — in this file — whether it needs `requireOrgAdmin` or is
 * genuinely open to any signed-in member (or unauthenticated, for the D8 states that predate a
 * membership). That is the "gate that proves someone decided" property; the per-route behavioural
 * coverage lives in `onboarding-routes.test.ts`, `invite-routes.test.ts` and `team-routes.test.ts`
 * and is deliberately not duplicated here — what IS re-driven below is the `ADMIN_ONLY` list
 * itself, so a route listed as gated that lost its gate fails here too.
 */

const dirs: string[] = [];

async function tempStore(): Promise<IdentityStore> {
  const dir = await mkdtemp(join(tmpdir(), 'cezar-auth-inventory-'));
  dirs.push(dir);
  await mkdir(dir, { recursive: true });
  return IdentityStore.open(dir);
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// ---- a real-but-network-free OidcClient, only to satisfy createAuthRoutes's dep shape ----------
// This suite never drives `/auth/login` or `/auth/callback` to completion (that is
// `routes.test.ts`'s job) — it only needs a real instance to compose the app and enumerate its
// route table, so no fetch fake is wired at all; a test that accidentally reached the network
// would throw on the unmocked global `fetch`, which is the failure mode we want.

const oidcConfig: ResolvedOidcConfig = {
  provider: 'oidc',
  issuer: 'https://idp.example.test',
  clientId: 'test-client',
  clientSecret: 'test-secret',
  redirectUri: 'https://cezar.example.test/auth/callback',
  scopes: ['openid', 'email', 'profile'],
  groupMapping: { claim: undefined, roles: new Map() },
};

const oidcDiscovery: OidcDiscoveryDocument = {
  issuer: oidcConfig.issuer,
  authorization_endpoint: 'https://idp.example.test/authorize',
  token_endpoint: 'https://idp.example.test/token',
  jwks_uri: 'https://idp.example.test/jwks',
};

async function buildApp(store: IdentityStore): Promise<Hono> {
  const service = SessionService.create(store, { authProvider: () => 'oidc' });
  const sessionResolver = {
    resolveFromCookieHeader: (header: string | undefined) => service.resolveFromCookieHeader(header),
  };
  const authDeps: AuthRouteDeps = {
    provider: 'oidc',
    oidc: new OidcClient(oidcConfig, oidcDiscovery),
    sessionResolver,
    findOrCreateUser: (input) => store.findOrCreateUser(input),
    createSession: (userId, ttlMs) => service.createSession(userId, ttlMs),
    destroySession: (id) => service.destroySession(id),
    logoutCookie: () => 'cez_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
  };
  const onboardingDeps: OnboardingRouteDeps = { sessionResolver, identityStore: store };
  const app = new Hono();
  app.route('/', createAuthRoutes(authDeps));
  app.route('/', createOnboardingRoutes(onboardingDeps));
  app.route('/', createInviteRoutes({ sessionResolver, identityStore: store }));
  app.route('/', createTeamRoutes({ sessionResolver, identityStore: store }));
  return app;
}

async function ownerCookie(store: IdentityStore, orgId: string, subject: string): Promise<string> {
  const { user } = await store.findOrCreateUser({ issuer: 'https://idp.example.test', subject });
  await store.createMembership({ userId: user.id, orgId, role: 'owner' });
  const service = SessionService.create(store, { authProvider: () => 'oidc' });
  return (await service.createSession(user.id)).cookie.split(';')[0]!;
}

async function memberCookie(store: IdentityStore, orgId: string, subject: string): Promise<string> {
  const { user } = await store.findOrCreateUser({ issuer: 'https://idp.example.test', subject });
  await store.createMembership({ userId: user.id, orgId, role: 'member' });
  const service = SessionService.create(store, { authProvider: () => 'oidc' });
  return (await service.createSession(user.id)).cookie.split(';')[0]!;
}

/**
 * Every `/auth/*` path this app registers, classified. `ADMIN_ONLY` is what `requireOrgAdmin`
 * exists to gate; `OPEN` is everything else — the four personal auth actions
 * (login/callback/logout/me, none of which are org administration) and the two D8 onboarding
 * routes that must answer a signed-in user with NO org yet, structurally before a `role` exists
 * for them at all (`onboarding-routes.ts`'s own module doc comment: "Authorization is three
 * different bars, on purpose").
 */
// `[method, a CONCRETE request path, the registered PATTERN]` — a triple, not a pair, because 5c's
// two `:teamId` routes cannot be both driven and matched by one string. Same shape
// `supervisor/server.test.ts`'s own inventory uses, and for the same reason.
const ADMIN_ONLY: ReadonlyArray<readonly [string, string, string]> = [
  ['PATCH', '/auth/onboarding/team', '/auth/onboarding/team'],
  // 5b (D12): who may hand out and take back org membership is org administration by definition.
  ['POST', '/auth/invites', '/auth/invites'],
  ['GET', '/auth/invites', '/auth/invites'],
  ['POST', '/auth/invites/revoke', '/auth/invites/revoke'],
  // 5c (D12): "creating/renaming/reassigning teams" is named in D12's own list of gated verbs.
  ['POST', '/auth/teams', '/auth/teams'],
  ['PATCH', '/auth/teams/team_unknown', '/auth/teams/:teamId'],
  ['DELETE', '/auth/teams/team_unknown', '/auth/teams/:teamId'],
];
const OPEN: ReadonlyArray<readonly [string, string, string]> = [
  ['GET', '/auth/login', '/auth/login'],
  ['GET', '/auth/callback', '/auth/callback'],
  ['POST', '/auth/logout', '/auth/logout'],
  ['GET', '/auth/me', '/auth/me'],
  ['GET', '/auth/onboarding', '/auth/onboarding'],
  ['POST', '/auth/onboarding/org', '/auth/onboarding/org'],
  // Redeeming an invite is the ONE invite verb a user with no membership must reach — there is no
  // role to gate on until that call grants their first one (`contract/src/invites.ts`'s own note).
  ['POST', '/auth/invites/redeem', '/auth/invites/redeem'],
  // Reading the org's teams is not administering them: you need it to file a project under one.
  ['GET', '/auth/teams', '/auth/teams'],
];

describe('/auth/* route inventory — D12 role classification', () => {
  it('every /auth/* path the app registers is classified admin-only or open above', async () => {
    const app = await buildApp(await tempStore());
    const registered = new Set(
      app.routes.map((r) => `${r.method} ${r.path}`).filter((entry) => entry.includes(' /auth/')),
    );
    const classified = new Set([...ADMIN_ONLY, ...OPEN].map(([method, , pattern]) => `${method} ${pattern}`));
    // A route added later that nobody classified fails here...
    expect([...registered].filter((entry) => !classified.has(entry)).sort()).toEqual([]);
    // ...and a classification naming a route that no longer exists fails here, so a deleted or
    // renamed route does not leave a passing assertion behind pretending to guard it.
    expect([...classified].filter((entry) => !registered.has(entry)).sort()).toEqual([]);
  });

  describe('ADMIN_ONLY: a `member` is refused, an `owner` is not', () => {
    /** A body that deliberately satisfies NO route's schema. For the member cases that is the
     *  point: 403 rather than 400 is what proves the role gate ran ahead of the validator
     *  (invariant 3's ordering — `requireOrgAdmin` registered as middleware, never a first line in
     *  a handler). `GET` carries none, since a GET with a body is not a request any client sends. */
    const nonsenseBody = JSON.stringify({ nonsense: 'neither a name nor a slug nor a role' });

    it.each(ADMIN_ONLY)('%s %s -> 403 for a member, before any body validation', async (method, path) => {
      const store = await tempStore();
      const { org } = await store.createOrg({ name: 'Acme', slug: 'acme' });
      const cookie = await memberCookie(store, org.id, 'rank-and-file');
      const app = await buildApp(store);
      const res = await app.request(path, {
        method,
        headers: { cookie, 'content-type': 'application/json' },
        body: method === 'GET' ? undefined : nonsenseBody,
      });
      expect(res.status).toBe(403);
    });

    it.each(ADMIN_ONLY)('%s %s -> NOT refused for an owner', async (method, path) => {
      const store = await tempStore();
      const { org } = await store.createOrg({ name: 'Acme', slug: 'acme' });
      const cookie = await ownerCookie(store, org.id, 'the-owner');
      const app = await buildApp(store);
      const res = await app.request(path, {
        method,
        headers: { cookie, 'content-type': 'application/json' },
        body: method === 'GET' ? undefined : JSON.stringify({ name: 'owner wrote this' }),
      });
      // Not asserting a SUCCESS status: an owner's nonsense body is a legitimate 400, and an
      // unknown `:teamId` a legitimate 404. What must never happen is the two answers that mean
      // "you are not allowed here", which is the only thing this list claims about these routes.
      expect(res.status).not.toBe(403);
      expect(res.status).not.toBe(401);
    });

    it.each(ADMIN_ONLY)('%s %s -> 401 with no session at all', async (method, path) => {
      const store = await tempStore();
      await store.createOrg({ name: 'Acme', slug: 'acme' });
      const app = await buildApp(store);
      const res = await app.request(path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'GET' ? undefined : nonsenseBody,
      });
      expect(res.status).toBe(401);
    });
  });
});
