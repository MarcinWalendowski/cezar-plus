import { mkdirSync, realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { apiRequest } from '../server/loopback-request.testkit.ts';
import type { Principal } from '../server/server.ts';
import { IdentityStore } from '../auth/identity-store.ts';
import { createSupervisorApp, type SupervisorAppDeps } from './server.ts';
import { OrgProcessRegistryStore } from './org-registry-store.ts';
import { verifyForwardedPrincipal } from './forwarded-principal.ts';

const dirs: string[] = [];

async function directory(prefix = 'cezar-supervisor-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A trivial stand-in for the real `auth/routes.ts`/`onboarding-routes.ts` — proving THIS file
 *  mounts whatever it is handed, at root, verbatim. The real routers' own behaviour is
 *  `routes.test.ts`/`onboarding-routes.test.ts`'s job, not this suite's. */
function fakeAuthRoutes(): Hono {
  return new Hono().get('/auth/ping', (c) => c.json({ pong: true })).post('/auth/logout', (c) => c.json({ ok: true }));
}

function fakeOnboardingRoutes(): Hono {
  return new Hono().get('/auth/onboarding', (c) => c.json({ state: 'needs-org' }));
}

/** The supervisor's operator-tooling credential (`./internal-auth.ts`) — what
 *  `server-install --platform hetzner` reads out of the supervisor's root-owned `EnvironmentFile`. */
const ADMIN_TOKEN = 'admin-'.padEnd(48, 'a');

async function buildDeps(overrides: Partial<SupervisorAppDeps> = {}): Promise<{ deps: SupervisorAppDeps; identityStore: IdentityStore; registry: OrgProcessRegistryStore }> {
  const identityStore = IdentityStore.open(await directory('cezar-supervisor-identity-'));
  const registry = OrgProcessRegistryStore.open(await directory('cezar-supervisor-registry-'));
  const deps: SupervisorAppDeps = {
    authRoutes: fakeAuthRoutes(),
    onboardingRoutes: fakeOnboardingRoutes(),
    adminToken: ADMIN_TOKEN,
    sessionResolver: { resolveFromCookieHeader: () => null },
    identityStore,
    orgProcessRegistry: registry,
    ...overrides,
  };
  return { deps, identityStore, registry };
}

/**
 * `apiRequest` carrying the ADMIN bearer — the credential the installer holds.
 *
 * **Every `/internal/*` call in this file goes through this rather than bare `apiRequest`, and
 * that is the point.** Before the repair stage this suite called each route with NO credential and
 * asserted 200, so its 27 green tests DOCUMENTED the surface as open rather than closing it: three
 * independent reviews reproduced `DELETE /internal/project-teams/by-root` (D4 data loss) and
 * `POST /internal/org-processes` with an attacker-chosen `supervisorSecret` against the real app,
 * unauthenticated. A helper that must name a credential is what makes "this route needs one"
 * impossible to forget for the next route added here. The refusals themselves are pinned in
 * `describe('/internal/* credential guard')` below.
 */
async function internalRequest(app: Hono, input: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set('authorization', `Bearer ${ADMIN_TOKEN}`);
  return apiRequest(app, input, { ...init, headers });
}

/** The same, as an ORG caller: authenticated by that org's own `supervisorSecret`. */
async function orgRequest(app: Hono, secret: string, input: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set('authorization', `Bearer ${secret}`);
  return apiRequest(app, input, { ...init, headers });
}

async function realProjectDir(): Promise<string> {
  const parent = await directory('cezar-supervisor-project-');
  const dir = join(parent, 'repo');
  mkdirSync(dir);
  return realpathSync.native(dir);
}

describe('createSupervisorApp — mounts authRoutes/onboardingRoutes verbatim', () => {
  it('serves whatever it is handed at root, unmodified', async () => {
    const { deps } = await buildDeps();
    const app = createSupervisorApp(deps);
    const ping = await apiRequest(app, '/auth/ping');
    expect(ping.status).toBe(200);
    await expect(ping.json()).resolves.toEqual({ pong: true });

    const onboarding = await apiRequest(app, '/auth/onboarding');
    expect(onboarding.status).toBe(200);
    await expect(onboarding.json()).resolves.toEqual({ state: 'needs-org' });
  });
});

describe('createSupervisorApp — GET /internal/auth-check', () => {
  it('no session -> 401, no forwarded-principal headers set', async () => {
    const { deps } = await buildDeps();
    const app = createSupervisorApp(deps);
    const res = await apiRequest(app, '/internal/auth-check');
    expect(res.status).toBe(401);
    expect(res.headers.get('x-cezar-principal')).toBeNull();
  });

  it("a resolved session whose org has an active process -> 200, signed headers verify with THAT org's secret", async () => {
    const principal: Principal = { kind: 'session', userId: 'u1', orgId: 'org_acme', teamId: 'team_1', role: 'owner' };
    const { deps, registry } = await buildDeps({ sessionResolver: { resolveFromCookieHeader: () => principal } });
    await registry.register({
      orgId: 'org_acme',
      orgSlug: 'acme',
      unixUser: 'cez-acme',
      cezHome: '/var/lib/cezar/orgs/acme',
      loopbackPort: 4400,
      hostname: 'acme.cezar.example.com',
      platformId: 'hetzner',
      supervisorSecret: 'x'.repeat(32),
    });
    const app = createSupervisorApp(deps);
    const res = await apiRequest(app, '/internal/auth-check', { headers: { cookie: 'cez_session=whatever' } });
    expect(res.status).toBe(200);
    const principalHeader = res.headers.get('x-cezar-principal');
    const signatureHeader = res.headers.get('x-cezar-principal-sig');
    expect(principalHeader).toBeTruthy();
    const verified = verifyForwardedPrincipal(principalHeader, signatureHeader, 'x'.repeat(32));
    expect(verified).toMatchObject({ userId: 'u1', orgId: 'org_acme', teamId: 'team_1', role: 'owner' });
  });

  it('a resolved session whose org has NO active process -> 401', async () => {
    const principal: Principal = { kind: 'session', userId: 'u1', orgId: 'org_acme', teamId: 'team_1', role: 'owner' };
    const { deps } = await buildDeps({ sessionResolver: { resolveFromCookieHeader: () => principal } });
    const app = createSupervisorApp(deps);
    const res = await apiRequest(app, '/internal/auth-check');
    expect(res.status).toBe(401);
  });
});

describe('createSupervisorApp — GET /internal/orgs, GET /internal/orgs/:slug', () => {
  it('lists orgs and resolves one by slug', async () => {
    const { deps, identityStore } = await buildDeps();
    const { org } = await identityStore.createOrg({ name: 'Acme', slug: 'acme' });
    const app = createSupervisorApp(deps);

    const list = await internalRequest(app, '/internal/orgs');
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toEqual({ orgs: [{ id: org.id, slug: 'acme', name: 'Acme' }] });

    const found = await internalRequest(app, '/internal/orgs/acme');
    expect(found.status).toBe(200);
    await expect(found.json()).resolves.toEqual({ org: { id: org.id, slug: 'acme', name: 'Acme' } });

    const missing = await internalRequest(app, '/internal/orgs/nope');
    expect(missing.status).toBe(404);
  });
});

describe('createSupervisorApp — /internal/project-teams* (D4\'s root -> org mapping)', () => {
  it('creates, reads by root, lists, and releases a claim — the supervisor\'s exclusive surface over IdentityStore', async () => {
    const { deps, identityStore } = await buildDeps();
    const { org, defaultTeam } = await identityStore.createOrg({ name: 'Acme', slug: 'acme' });
    const app = createSupervisorApp(deps);
    const root = await realProjectDir();

    const created = await internalRequest(app, '/internal/project-teams', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectRoot: root, orgId: org.id, teamId: defaultTeam.id }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { projectTeam: { projectRoot: string; orgId: string; teamId: string } };
    expect(createdBody.projectTeam.orgId).toBe(org.id);

    const byRoot = await internalRequest(app, `/internal/project-teams/by-root?root=${encodeURIComponent(createdBody.projectTeam.projectRoot)}`);
    expect(byRoot.status).toBe(200);
    await expect(byRoot.json()).resolves.toEqual({ projectTeam: createdBody.projectTeam });

    const list = await internalRequest(app, `/internal/project-teams?orgId=${org.id}`);
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toEqual({ projectTeams: [createdBody.projectTeam] });

    const released = await internalRequest(app, `/internal/project-teams/by-root?root=${encodeURIComponent(createdBody.projectTeam.projectRoot)}`, {
      method: 'DELETE',
    });
    expect(released.status).toBe(200);
    await expect(released.json()).resolves.toEqual({ released: true });

    const goneNow = await internalRequest(app, `/internal/project-teams/by-root?root=${encodeURIComponent(createdBody.projectTeam.projectRoot)}`);
    expect(goneNow.status).toBe(404);
  });

  it('one root claimed by org A is refused for org B — D4 held across the HTTP boundary, not just in-process', async () => {
    const { deps, identityStore } = await buildDeps();
    const { org: orgA, defaultTeam: teamA } = await identityStore.createOrg({ name: 'Acme', slug: 'acme' });
    const { org: orgB, defaultTeam: teamB } = await identityStore.createOrg({ name: 'Beta', slug: 'beta' });
    const app = createSupervisorApp(deps);
    const root = await realProjectDir();

    const first = await internalRequest(app, '/internal/project-teams', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectRoot: root, orgId: orgA.id, teamId: teamA.id }),
    });
    expect(first.status).toBe(201);

    const second = await internalRequest(app, '/internal/project-teams', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectRoot: root, orgId: orgB.id, teamId: teamB.id }),
    });
    expect(second.status).toBe(409);
  });

  it('an unknown org/team 404s', async () => {
    const { deps } = await buildDeps();
    const app = createSupervisorApp(deps);
    const root = await realProjectDir();
    const res = await internalRequest(app, '/internal/project-teams', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectRoot: root, orgId: 'nope', teamId: 'also-nope' }),
    });
    expect(res.status).toBe(404);
  });

  /**
   * ADDED 2026-08-07 (integration pass). `supervisor/registry-client.ts` reads the failure
   * discriminant off `code` and NEVER off the HTTP status, because the status maps 2-to-1 in both
   * directions: `org-not-found`/`team-not-found` both answer 404, `team-org-mismatch`/
   * `project-root-taken` both answer 409. Asserting the status alone here would leave the client
   * unable to tell D4's real refusal (`project-root-taken`, which `server.ts#registerFolder` turns
   * into the cross-org 409 wording) from a caller mistake — and while `code` was missing, every
   * one of these threw `unexpected` and that 409 branch was an unreachable 500.
   */
  it.each([
    ['org-not-found', { orgId: 'nope', teamId: 'also-nope' }, 404],
    ['team-not-found', { orgId: 'REAL_ORG', teamId: 'no-such-team' }, 404],
  ] as const)('names the failure with a machine-readable code, not only a status: %s', async (expectedCode, patch, expectedStatus) => {
    const { deps, identityStore } = await buildDeps();
    const { org } = await identityStore.createOrg({ name: 'Acme', slug: 'acme' });
    const app = createSupervisorApp(deps);
    const root = await realProjectDir();

    const res = await internalRequest(app, '/internal/project-teams', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectRoot: root, orgId: patch.orgId === 'REAL_ORG' ? org.id : patch.orgId, teamId: patch.teamId }),
    });
    expect(res.status).toBe(expectedStatus);
    await expect(res.json()).resolves.toMatchObject({ code: expectedCode });
  });

  it('a root already claimed by another org answers 409 WITH code project-root-taken', async () => {
    const { deps, identityStore } = await buildDeps();
    const { org: orgA, defaultTeam: teamA } = await identityStore.createOrg({ name: 'Acme', slug: 'acme' });
    const { org: orgB, defaultTeam: teamB } = await identityStore.createOrg({ name: 'Beta', slug: 'beta' });
    const app = createSupervisorApp(deps);
    const root = await realProjectDir();

    await internalRequest(app, '/internal/project-teams', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectRoot: root, orgId: orgA.id, teamId: teamA.id }),
    });
    const res = await internalRequest(app, '/internal/project-teams', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectRoot: root, orgId: orgB.id, teamId: teamB.id }),
    });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ code: 'project-root-taken' });
  });
});

/**
 * ADDED 2026-08-07 (integration pass) — the routes `supervisor/registry-client.ts` had been
 * calling since it was written, whose absence made `server.ts#withTeams` degrade to an
 * unannotated project board and `server.ts#registerFolder` 500 on an explicit `teamId`.
 */
describe('createSupervisorApp — /internal/teams*', () => {
  it('lists exactly the named org\'s teams, never another org\'s', async () => {
    const { deps, identityStore } = await buildDeps();
    const { org: orgA, defaultTeam: teamA } = await identityStore.createOrg({ name: 'Acme', slug: 'acme' });
    const { org: orgB, defaultTeam: teamB } = await identityStore.createOrg({ name: 'Beta', slug: 'beta' });
    const app = createSupervisorApp(deps);

    const a = await internalRequest(app, `/internal/teams?orgId=${orgA.id}`);
    expect(a.status).toBe(200);
    await expect(a.json()).resolves.toEqual({ teams: [{ id: teamA.id, orgId: orgA.id, name: teamA.name, slug: teamA.slug }] });

    const b = await internalRequest(app, `/internal/teams?orgId=${orgB.id}`);
    await expect(b.json()).resolves.toEqual({ teams: [{ id: teamB.id, orgId: orgB.id, name: teamB.name, slug: teamB.slug }] });
  });

  it('requires orgId — an unfiltered team list is never served', async () => {
    const { deps, identityStore } = await buildDeps();
    await identityStore.createOrg({ name: 'Acme', slug: 'acme' });
    const app = createSupervisorApp(deps);
    expect((await internalRequest(app, '/internal/teams')).status).toBe(400);
  });

  it('resolves one team by id, and answers team: null (not 404) for an unknown id', async () => {
    const { deps, identityStore } = await buildDeps();
    const { org, defaultTeam } = await identityStore.createOrg({ name: 'Acme', slug: 'acme' });
    const app = createSupervisorApp(deps);

    const found = await internalRequest(app, `/internal/teams/${defaultTeam.id}`);
    expect(found.status).toBe(200);
    await expect(found.json()).resolves.toEqual({ team: { id: defaultTeam.id, orgId: org.id, name: defaultTeam.name, slug: defaultTeam.slug } });

    // `null` rather than 404 is the contract `registry-client.ts#getTeamById` reads: it maps this
    // to `undefined` and lets `registerFolder` answer "unknown team: <id>" as a 400 client error,
    // where a 404 would be indistinguishable from the route itself being absent — which is
    // precisely the failure this route was added to fix.
    const missing = await internalRequest(app, '/internal/teams/team_nope');
    expect(missing.status).toBe(200);
    await expect(missing.json()).resolves.toEqual({ team: null });
  });
});

describe('createSupervisorApp — /internal/org-processes* (process lifecycle + hostname resolution)', () => {
  it('registers ("start"), lists, resolves by orgId and by hostname, and never echoes the secret', async () => {
    const { deps } = await buildDeps();
    const app = createSupervisorApp(deps);

    const registered = await internalRequest(app, '/internal/org-processes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        orgId: 'org_acme',
        orgSlug: 'acme',
        unixUser: 'cez-acme',
        cezHome: '/var/lib/cezar/orgs/acme',
        loopbackPort: 4400,
        hostname: 'acme.cezar.example.com',
        platformId: 'hetzner',
        supervisorSecret: 'x'.repeat(32),
      }),
    });
    expect(registered.status).toBe(201);
    const registeredBody = (await registered.json()) as { orgProcess: Record<string, unknown> };
    expect(registeredBody.orgProcess).not.toHaveProperty('supervisorSecret');
    expect(registeredBody.orgProcess.status).toBe('active');

    const byId = await internalRequest(app, '/internal/org-processes/org_acme');
    expect(byId.status).toBe(200);

    const byHostname = await internalRequest(app, '/internal/org-processes?hostname=acme.cezar.example.com');
    expect(byHostname.status).toBe(200);
    const byHostnameBody = (await byHostname.json()) as { orgProcesses: Array<{ orgId: string }> };
    expect(byHostnameBody.orgProcesses).toHaveLength(1);
    expect(byHostnameBody.orgProcesses[0]?.orgId).toBe('org_acme');

    const missingHostname = await internalRequest(app, '/internal/org-processes?hostname=nope.example.com');
    await expect(missingHostname.json()).resolves.toEqual({ orgProcesses: [] });
  });

  it('refuses a second active registration for the same org (D4: "refuse to start two processes for one org")', async () => {
    const { deps } = await buildDeps();
    const app = createSupervisorApp(deps);
    const body = {
      orgId: 'org_acme',
      orgSlug: 'acme',
      unixUser: 'cez-acme',
      cezHome: '/var/lib/cezar/orgs/acme',
      loopbackPort: 4400,
      hostname: 'acme.cezar.example.com',
      platformId: 'hetzner' as const,
      supervisorSecret: 'x'.repeat(32),
    };
    const first = await internalRequest(app, '/internal/org-processes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(201);
    const second = await internalRequest(app, '/internal/org-processes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, hostname: 'acme-2.cezar.example.com', loopbackPort: 4401 }),
    });
    expect(second.status).toBe(409);
  });

  it('deprovisions ("stop"), idempotently, and the org then has no active record', async () => {
    const { deps, registry } = await buildDeps();
    await registry.register({
      orgId: 'org_acme',
      orgSlug: 'acme',
      unixUser: 'cez-acme',
      cezHome: '/var/lib/cezar/orgs/acme',
      loopbackPort: 4400,
      hostname: 'acme.cezar.example.com',
      platformId: 'hetzner',
      supervisorSecret: 'x'.repeat(32),
    });
    const app = createSupervisorApp(deps);
    const stopped = await internalRequest(app, '/internal/org-processes/org_acme', { method: 'DELETE' });
    expect(stopped.status).toBe(200);
    await expect(stopped.json()).resolves.toEqual({ deprovisioned: true });

    const goneNow = await internalRequest(app, '/internal/org-processes/org_acme');
    expect(goneNow.status).toBe(404);

    const again = await internalRequest(app, '/internal/org-processes/org_acme', { method: 'DELETE' });
    await expect(again.json()).resolves.toEqual({ deprovisioned: false });
  });

  it('health: reports the live probe result, ok and not-ok, without ever making a real network call', async () => {
    const { deps, registry } = await buildDeps({
      fetchImpl: (async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
    });
    await registry.register({
      orgId: 'org_acme',
      orgSlug: 'acme',
      unixUser: 'cez-acme',
      cezHome: '/var/lib/cezar/orgs/acme',
      loopbackPort: 4400,
      hostname: 'acme.cezar.example.com',
      platformId: 'hetzner',
      supervisorSecret: 'x'.repeat(32),
    });
    const app = createSupervisorApp(deps);
    const healthy = await internalRequest(app, '/internal/org-processes/org_acme/health');
    await expect(healthy.json()).resolves.toEqual({ healthy: true, status: 200 });
  });

  it('health: a probe that throws (process down) reports unhealthy, not a 500', async () => {
    const { deps, registry } = await buildDeps({
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });
    await registry.register({
      orgId: 'org_acme',
      orgSlug: 'acme',
      unixUser: 'cez-acme',
      cezHome: '/var/lib/cezar/orgs/acme',
      loopbackPort: 4400,
      hostname: 'acme.cezar.example.com',
      platformId: 'hetzner',
      supervisorSecret: 'x'.repeat(32),
    });
    const app = createSupervisorApp(deps);
    const res = await internalRequest(app, '/internal/org-processes/org_acme/health');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ healthy: false, error: 'ECONNREFUSED' });
  });

  it('health: no active process -> 404, no probe attempted', async () => {
    let called = false;
    const { deps } = await buildDeps({
      fetchImpl: (async () => {
        called = true;
        return new Response(null, { status: 200 });
      }) as unknown as typeof fetch,
    });
    const app = createSupervisorApp(deps);
    const res = await internalRequest(app, '/internal/org-processes/org_acme/health');
    expect(res.status).toBe(404);
    expect(called).toBe(false);
  });
});

describe('createSupervisorApp — same-origin write guard on /auth/* and /internal/*', () => {
  it('a mutating request whose Origin does not match Host is rejected', async () => {
    const { deps } = await buildDeps();
    const app = createSupervisorApp(deps);
    const res = await app.request('/auth/logout', {
      method: 'POST',
      headers: { host: 'acme.cezar.example.com', origin: 'https://evil.tld' },
    });
    expect(res.status).toBe(403);
  });

  it('a mutating request with a matching Origin passes through', async () => {
    const { deps } = await buildDeps();
    const app = createSupervisorApp(deps);
    const res = await app.request('/auth/logout', {
      method: 'POST',
      headers: { host: 'acme.cezar.example.com', origin: 'https://acme.cezar.example.com' },
    });
    expect(res.status).toBe(200);
  });

  it('a mutating request with NO Origin passes through (nginx subrequests, the installer\'s own curl)', async () => {
    const { deps } = await buildDeps();
    const app = createSupervisorApp(deps);
    const res = await app.request('/auth/logout', { method: 'POST', headers: { host: 'acme.cezar.example.com' } });
    expect(res.status).toBe(200);
  });

  it('a GET is never gated by Origin', async () => {
    const { deps } = await buildDeps();
    const app = createSupervisorApp(deps);
    const res = await app.request('/auth/ping', { headers: { host: 'acme.cezar.example.com', origin: 'https://evil.tld' } });
    expect(res.status).toBe(200);
  });
});

/**
 * **The `/internal/*` credential guard (`./internal-auth.ts`).** ADDED 2026-08-07 at the phase 6/7
 * repair stage, and every case here fails if the guard is removed — which is the whole reason it
 * exists as a suite rather than a comment. Six independent adversarial reviews reproduced the same
 * chain against the real `createSupervisorApp`, with no headers of any kind:
 *
 *     GET    /internal/orgs                                     -> 200  (every tenant enumerated)
 *     DELETE /internal/project-teams/by-root?root=<org A's>     -> 200 {"released":true}
 *     POST   /internal/project-teams {root:<A's>, orgId:<B>}    -> 201  (D4 claim transferred)
 *     POST   /internal/org-processes {supervisorSecret:<mine>}  -> 201  (forge any principal)
 *
 * D4's amendment 1 names the third of those as "not tenancy-shaped behaviour, it is data loss".
 * `sameOriginWriteGuard` was never a barrier here: a mutating request with no `Origin` passes by
 * design, which is every `curl`.
 */
describe('createSupervisorApp — /internal/* credential guard (D4/D10)', () => {
  const ORG_A_SECRET = 'a'.repeat(64);
  const ORG_B_SECRET = 'b'.repeat(64);

  /** Two orgs, each with a registered process, so both org secrets are live callers. */
  async function twoOrgs() {
    const built = await buildDeps();
    const { org: orgA, defaultTeam: teamA } = await built.identityStore.createOrg({ name: 'Acme', slug: 'acme' });
    const { org: orgB, defaultTeam: teamB } = await built.identityStore.createOrg({ name: 'Beta', slug: 'beta' });
    for (const [org, secret, port] of [
      [orgA, ORG_A_SECRET, 4400],
      [orgB, ORG_B_SECRET, 4401],
    ] as const) {
      await built.registry.register({
        orgId: org.id,
        orgSlug: org.slug,
        unixUser: `cez-${org.slug}`,
        cezHome: `/home/cez-${org.slug}/.cezar`,
        loopbackPort: port,
        hostname: `${org.slug}.cezar.example.com`,
        platformId: 'hetzner',
        supervisorSecret: secret,
      });
    }
    return { ...built, app: createSupervisorApp(built.deps), orgA, orgB, teamA, teamB };
  }

  /**
   * Every `/internal/*` route, classified by the credential it demands. Two lists, not one, and
   * the inventory assertion below walks the app's OWN route table and fails when a registered path
   * is in neither — so a route added later cannot ship without someone deciding, in this file,
   * whether an org process may call it. That is the property the previous suite lacked: it called
   * every route with no credential at all and asserted 200, which reads as coverage and is
   * documentation of a hole.
   */
  const ADMIN_ONLY: ReadonlyArray<readonly [string, string, string]> = [
    ['GET', '/internal/orgs', '/internal/orgs'],
    ['GET', '/internal/orgs/acme', '/internal/orgs/:slug'],
    ['GET', '/internal/org-processes', '/internal/org-processes'],
    ['GET', '/internal/org-processes/org_x', '/internal/org-processes/:orgId'],
    ['GET', '/internal/org-processes/org_x/health', '/internal/org-processes/:orgId/health'],
    ['POST', '/internal/org-processes', '/internal/org-processes'],
    ['DELETE', '/internal/org-processes/org_x', '/internal/org-processes/:orgId'],
  ];
  const ORG_SCOPED: ReadonlyArray<readonly [string, string, string]> = [
    ['GET', '/internal/teams?orgId=org_x', '/internal/teams'],
    ['GET', '/internal/teams/team_x', '/internal/teams/:teamId'],
    ['GET', '/internal/project-teams?orgId=org_x', '/internal/project-teams'],
    ['GET', '/internal/project-teams/by-root?root=%2Fsrv%2Frepo', '/internal/project-teams/by-root'],
    ['POST', '/internal/project-teams', '/internal/project-teams'],
    ['DELETE', '/internal/project-teams/by-root?root=%2Fsrv%2Frepo', '/internal/project-teams/by-root'],
  ];
  const INTERNAL_ROUTES = [...ADMIN_ONLY, ...ORG_SCOPED].map(([method, path]) => [method, path] as const);

  it('every /internal/* path the app registers is classified admin-only or org-scoped above', async () => {
    const { deps } = await buildDeps();
    const app = createSupervisorApp(deps);
    // `app.routes` also carries the `app.use()` middleware entries, whose paths are patterns
    // (`/internal/*`) rather than routes. Only concrete paths are classifiable.
    const registered = new Set(
      app.routes
        .map((r) => r.path)
        .filter((p) => p.startsWith('/internal/') && !p.includes('*') && p !== '/internal/auth-check'),
    );
    const classified = new Set([...ADMIN_ONLY, ...ORG_SCOPED].map(([, , pattern]) => pattern));
    expect([...registered].filter((p) => !classified.has(p)).sort()).toEqual([]);
    // …and nothing in the lists names a route that no longer exists, so a deleted route does not
    // leave a passing assertion behind pretending to guard it.
    expect([...classified].filter((p) => !registered.has(p)).sort()).toEqual([]);
  });

  it.each(INTERNAL_ROUTES)('%s %s with NO credential -> 401', async (method, path) => {
    const { app } = await twoOrgs();
    const res = await apiRequest(app, path, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
    expect(res.status).toBe(401);
  });

  it.each(INTERNAL_ROUTES)('%s %s with an UNRECOGNISED bearer -> 401', async (method, path) => {
    const { app } = await twoOrgs();
    const res = await apiRequest(app, path, {
      method,
      headers: { authorization: 'Bearer not-a-real-secret-at-all', 'content-type': 'application/json' },
      body: method === 'POST' ? '{}' : undefined,
    });
    expect(res.status).toBe(401);
  });

  it('GET /internal/auth-check is the ONE deliberate exception: no credential, still answers', async () => {
    // nginx's `auth_request` subrequest cannot present a secret (it would have to sit in a
    // world-readable vhost file). It is safe because it signs only for the org the CALLER'S OWN
    // session cookie already resolves to. Pinning it here means "unauthenticated" stays a decision
    // about this one path rather than a hole that grows.
    const principal: Principal = { kind: 'session', userId: 'u1', orgId: 'org_acme', teamId: 't1', role: 'owner' };
    const { deps, registry } = await buildDeps({ sessionResolver: { resolveFromCookieHeader: () => principal } });
    await registry.register({
      orgId: 'org_acme',
      orgSlug: 'acme',
      unixUser: 'cez-acme',
      cezHome: '/home/cez-acme/.cezar',
      loopbackPort: 4400,
      hostname: 'acme.cezar.example.com',
      platformId: 'hetzner',
      supervisorSecret: ORG_A_SECRET,
    });
    const app = createSupervisorApp(deps);
    const res = await apiRequest(app, '/internal/auth-check', { headers: { cookie: 'cez_session=x' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-cezar-principal')).toBeTruthy();
  });

  describe('admin-only routes refuse a valid ORG credential', () => {
    /**
     * The body is deliberately `{}` — invalid for `POST /internal/org-processes`. Before the
     * repair stage the admin check was the first line of each HANDLER, i.e. after that route's
     * `jsonZodValidator`, so this exact request answered **400**: the caller learned its payload
     * did not parse before learning it was never allowed to call the route. Authorization that
     * runs after parsing is one refactor away from running after a side effect. It is middleware
     * now, and a malformed body from a non-admin never reaches a validator.
     */
    it.each(ADMIN_ONLY.map(([method, path]) => [method, path] as const))('%s %s -> 403 for an org caller, before any body validation', async (method, path) => {
      const { app } = await twoOrgs();
      const res = await orgRequest(app, ORG_A_SECRET, path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'POST' ? '{}' : undefined,
      });
      expect(res.status).toBe(403);
    });
  });

  describe('org-scoped routes refuse another org', () => {
    it("org B cannot list org A's project-teams", async () => {
      const { app, orgA } = await twoOrgs();
      const res = await orgRequest(app, ORG_B_SECRET, `/internal/project-teams?orgId=${orgA.id}`);
      expect(res.status).toBe(403);
    });

    it('an org caller with NO orgId filter is refused rather than defaulted to its own', async () => {
      const { app } = await twoOrgs();
      expect((await orgRequest(app, ORG_A_SECRET, '/internal/project-teams')).status).toBe(403);
    });

    it("org B cannot CLAIM a root for org A — the D4 write, the one that transfers a mapping", async () => {
      const { app, orgA, teamA } = await twoOrgs();
      const root = await realProjectDir();
      const res = await orgRequest(app, ORG_B_SECRET, '/internal/project-teams', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectRoot: root, orgId: orgA.id, teamId: teamA.id }),
      });
      expect(res.status).toBe(403);
      // and nothing was written
      expect(await (await internalRequest(app, `/internal/project-teams/by-root?root=${encodeURIComponent(root)}`)).status).toBe(404);
    });

    it("org B cannot RELEASE org A's claim — D4 amendment 1's data loss, reached over HTTP", async () => {
      const { app, orgA, teamA } = await twoOrgs();
      const root = await realProjectDir();
      const created = await orgRequest(app, ORG_A_SECRET, '/internal/project-teams', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectRoot: root, orgId: orgA.id, teamId: teamA.id }),
      });
      expect(created.status).toBe(201);

      const stolen = await orgRequest(app, ORG_B_SECRET, `/internal/project-teams/by-root?root=${encodeURIComponent(root)}`, {
        method: 'DELETE',
      });
      expect(stolen.status).toBe(403);
      // the claim survives, and still belongs to A
      const still = await internalRequest(app, `/internal/project-teams/by-root?root=${encodeURIComponent(root)}`);
      expect(still.status).toBe(200);
      await expect(still.json()).resolves.toMatchObject({ projectTeam: { orgId: orgA.id } });
    });

    it("org B cannot read org A's team NAMES by guessing an id", async () => {
      const { app, teamA } = await twoOrgs();
      const res = await orgRequest(app, ORG_B_SECRET, `/internal/teams/${teamA.id}`);
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ team: null });
    });

    it('an org CAN do all of the above for itself — the refusals are not "org callers can never act"', async () => {
      const { app, orgA, teamA } = await twoOrgs();
      const root = await realProjectDir();
      expect((await orgRequest(app, ORG_A_SECRET, `/internal/project-teams?orgId=${orgA.id}`)).status).toBe(200);
      expect((await orgRequest(app, ORG_A_SECRET, `/internal/teams?orgId=${orgA.id}`)).status).toBe(200);
      const created = await orgRequest(app, ORG_A_SECRET, '/internal/project-teams', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectRoot: root, orgId: orgA.id, teamId: teamA.id }),
      });
      expect(created.status).toBe(201);
      const released = await orgRequest(app, ORG_A_SECRET, `/internal/project-teams/by-root?root=${encodeURIComponent(root)}`, {
        method: 'DELETE',
      });
      expect(released.status).toBe(200);
    });
  });

  it("a DEPROVISIONED org's secret stops authenticating immediately, without a supervisor restart", async () => {
    // `resolveInternalCaller` filters to `status === 'active'`. Without that filter a
    // decommissioned org keeps a working credential against D4's mapping for as long as its record
    // sits in the registry file — and `deprovision` is exactly what an operator runs when they no
    // longer trust that org's box.
    const { app, orgA } = await twoOrgs();
    expect((await orgRequest(app, ORG_A_SECRET, `/internal/project-teams?orgId=${orgA.id}`)).status).toBe(200);
    expect((await internalRequest(app, `/internal/org-processes/${orgA.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await orgRequest(app, ORG_A_SECRET, `/internal/project-teams?orgId=${orgA.id}`)).status).toBe(401);
  });

  it('an UNSET adminToken closes the admin surface rather than opening it', async () => {
    const { deps, identityStore } = await buildDeps({ adminToken: undefined });
    await identityStore.createOrg({ name: 'Acme', slug: 'acme' });
    const app = createSupervisorApp(deps);
    // No credential at all, and — the part that matters — the empty-string/undefined compare must
    // not admit a caller who simply sends nothing, or `Bearer undefined`.
    expect((await apiRequest(app, '/internal/orgs')).status).toBe(401);
    expect((await apiRequest(app, '/internal/orgs', { headers: { authorization: 'Bearer undefined' } })).status).toBe(401);
    expect((await apiRequest(app, '/internal/orgs', { headers: { authorization: 'Bearer ' } })).status).toBe(401);
  });
});
