import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTeamRoutes, type TeamRouteDeps } from './team-routes.ts';
import { IdentityStore } from './identity-store.ts';
import { SessionService } from './session.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from '../server/server.ts';
import { apiRequest } from '../server/loopback-request.testkit.ts';
import { identityDir } from '../paths.ts';
import {
  createOnboardingRoutes,
} from './onboarding-routes.ts';
import {
  createRequireOrgAdminLocal,
  createRequireSignedInLocal,
  localSessionResolver,
} from './local-gates.ts';
import { invalidateLocalOrgIdentityCache } from './local-identity.ts';

/**
 * Phase 5c's team-management HTTP surface (D2, D12), exercised against a REAL `IdentityStore`
 * (temp directory, no fakes) and a REAL `SessionService` — the same discipline
 * `invite-routes.test.ts` uses for the sibling 5b surface. `createTeam`/`renameTeam`/`deleteTeam`'s
 * own store-level guarantees (uniqueness inside the lease, the refuse-vs-reassign decision) are
 * covered by `identity-store.test.ts`'s own describe blocks; these tests are about the HTTP layer
 * this file adds: status codes, D12's role-gate ORDERING (authorization before validation), and the
 * cross-org 404 this file's own module doc comment promises.
 */

const dirs: string[] = [];

async function tempStore(): Promise<IdentityStore> {
  const dir = await mkdtemp(join(tmpdir(), 'cezar-teams-'));
  dirs.push(dir);
  await mkdir(dir, { recursive: true });
  return IdentityStore.open(dir);
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function buildDeps(store: IdentityStore): TeamRouteDeps {
  const service = SessionService.create(store, { authProvider: () => 'oidc' });
  return {
    sessionResolver: { resolveFromCookieHeader: (header) => service.resolveFromCookieHeader(header) },
    identityStore: store,
  };
}

/** Mints a real session cookie for a user with a real membership in `orgId`. */
async function signInAs(
  store: IdentityStore,
  input: { subject: string; orgId: string; role: 'owner' | 'admin' | 'member' },
): Promise<string> {
  const { user } = await store.findOrCreateUser({ issuer: 'https://idp.example.test', subject: input.subject });
  await store.createMembership({ userId: user.id, orgId: input.orgId, role: input.role });
  const service = SessionService.create(store, { authProvider: () => 'oidc' });
  const created = await service.createSession(user.id);
  return created.cookie.split(';')[0]!;
}

describe('createTeamRoutes', () => {
  describe('GET /auth/teams', () => {
    it('401s with no session', async () => {
      const store = await tempStore();
      const app = createTeamRoutes(buildDeps(store));
      const res = await app.request('/auth/teams');
      expect(res.status).toBe(401);
    });

    it('a plain member (not admin/owner) can list — no D12 bar on reads', async () => {
      const store = await tempStore();
      const { org, defaultTeam } = await store.createOrg({ name: 'Acme', slug: 'acme' });
      const cookie = await signInAs(store, { subject: 'rank-and-file', orgId: org.id, role: 'member' });
      const app = createTeamRoutes(buildDeps(store));

      const res = await app.request('/auth/teams', { headers: { cookie } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { teams: Array<{ id: string; slug: string }> };
      expect(body.teams.map((t) => t.slug)).toEqual([defaultTeam.slug]);
    });

    it('only ever lists the caller\'s OWN org, never a body/query orgId', async () => {
      const store = await tempStore();
      const { org: orgA } = await store.createOrg({ name: 'Acme', slug: 'acme' });
      await store.createOrg({ name: 'Beta', slug: 'beta' });
      const cookie = await signInAs(store, { subject: 'ann', orgId: orgA.id, role: 'owner' });
      const app = createTeamRoutes(buildDeps(store));

      const res = await app.request('/auth/teams', { headers: { cookie } });
      const body = (await res.json()) as { teams: Array<{ orgId: string }> };
      expect(body.teams.every((t) => t.orgId === orgA.id)).toBe(true);
    });
  });

  describe('POST /auth/teams', () => {
    it('401s with no session', async () => {
      const store = await tempStore();
      const app = createTeamRoutes(buildDeps(store));
      const res = await app.request('/auth/teams', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Engineering', slug: 'engineering' }),
      });
      expect(res.status).toBe(401);
    });

    it("403s a `member`, BEFORE the body validator ever runs (authorization before validation)", async () => {
      const store = await tempStore();
      const { org } = await store.createOrg({ name: 'Acme', slug: 'acme' });
      const cookie = await signInAs(store, { subject: 'mallory', orgId: org.id, role: 'member' });
      const app = createTeamRoutes(buildDeps(store));

      // A malformed body that would 400 the validator — a leak here would be 400, not 403.
      const res = await app.request('/auth/teams', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(403);
    });

    it("an owner adds a second, later team beside the org's default one — D2's own example", async () => {
      const store = await tempStore();
      const { org } = await store.createOrg({ name: 'Acme', slug: 'acme' });
      const cookie = await signInAs(store, { subject: 'owner-1', orgId: org.id, role: 'owner' });
      const app = createTeamRoutes(buildDeps(store));

      const eng = await app.request('/auth/teams', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Engineering', slug: 'engineering' }),
      });
      expect(eng.status).toBe(201);
      const mkt = await app.request('/auth/teams', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Marketing', slug: 'marketing' }),
      });
      expect(mkt.status).toBe(201);

      const list = await app.request('/auth/teams', { headers: { cookie } });
      const body = (await list.json()) as { teams: Array<{ slug: string }> };
      expect(body.teams.map((t) => t.slug).sort()).toEqual(['engineering', 'general', 'marketing']);
    });

    it('an `admin` (not only `owner`) may create a team — D12 gates BOTH roles the same way', async () => {
      const store = await tempStore();
      const { org } = await store.createOrg({ name: 'Acme', slug: 'acme' });
      const cookie = await signInAs(store, { subject: 'admin-1', orgId: org.id, role: 'admin' });
      const app = createTeamRoutes(buildDeps(store));

      const res = await app.request('/auth/teams', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Support', slug: 'support' }),
      });
      expect(res.status).toBe(201);
    });

    it('409s a duplicate slug WITHIN the caller\'s own org', async () => {
      const store = await tempStore();
      const { org } = await store.createOrg({ name: 'Acme', slug: 'acme' });
      const cookie = await signInAs(store, { subject: 'owner-1', orgId: org.id, role: 'owner' });
      const app = createTeamRoutes(buildDeps(store));

      await app.request('/auth/teams', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Engineering', slug: 'engineering' }),
      });
      const dup = await app.request('/auth/teams', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Eng (dup)', slug: 'engineering' }),
      });
      expect(dup.status).toBe(409);
    });
  });

  describe('PATCH /auth/teams/:teamId', () => {
    it('401s with no session', async () => {
      const store = await tempStore();
      const { defaultTeam } = await store.createOrg({ name: 'Acme', slug: 'acme' });
      const app = createTeamRoutes(buildDeps(store));
      const res = await app.request(`/auth/teams/${defaultTeam.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Acme HQ' }),
      });
      expect(res.status).toBe(401);
    });

    it("403s a `member`, BEFORE the body validator ever runs", async () => {
      const store = await tempStore();
      const { org, defaultTeam } = await store.createOrg({ name: 'Acme', slug: 'acme' });
      const cookie = await signInAs(store, { subject: 'mallory', orgId: org.id, role: 'member' });
      const app = createTeamRoutes(buildDeps(store));

      const res = await app.request(`/auth/teams/${defaultTeam.id}`, {
        method: 'PATCH',
        headers: { cookie, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(403);
    });

    it('an owner renames ANY team in their own org, not only the one they onboarded through', async () => {
      const store = await tempStore();
      const { org } = await store.createOrg({ name: 'Acme', slug: 'acme' });
      const eng = await store.createTeam({ orgId: org.id, name: 'Engineering', slug: 'engineering' });
      const cookie = await signInAs(store, { subject: 'owner-1', orgId: org.id, role: 'owner' });
      const app = createTeamRoutes(buildDeps(store));

      const res = await app.request(`/auth/teams/${eng.id}`, {
        method: 'PATCH',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Platform Engineering' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { team: { name: string; slug: string } };
      expect(body.team.name).toBe('Platform Engineering');
      expect(body.team.slug).toBe('engineering'); // slug untouched (IdentityStore#renameTeam)
    });

    it('404s an unknown teamId', async () => {
      const store = await tempStore();
      const { org } = await store.createOrg({ name: 'Acme', slug: 'acme' });
      const cookie = await signInAs(store, { subject: 'owner-1', orgId: org.id, role: 'owner' });
      const app = createTeamRoutes(buildDeps(store));

      const res = await app.request('/auth/teams/does-not-exist', {
        method: 'PATCH',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'x' }),
      });
      expect(res.status).toBe(404);
    });

    it("CROSS-ORG: a team id from org B is not reachable by an org A caller — 404, not 403 (no oracle for 'exists but not yours')", async () => {
      const store = await tempStore();
      const { org: orgA } = await store.createOrg({ name: 'Acme', slug: 'acme' });
      const { defaultTeam: teamB } = await store.createOrg({ name: 'Beta', slug: 'beta' });
      const cookie = await signInAs(store, { subject: 'owner-a', orgId: orgA.id, role: 'owner' });
      const app = createTeamRoutes(buildDeps(store));

      const res = await app.request(`/auth/teams/${teamB.id}`, {
        method: 'PATCH',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'renamed by an intruder' }),
      });
      expect(res.status).toBe(404);
      // and nothing was written
      expect(store.getTeamById(teamB.id)?.name).not.toBe('renamed by an intruder');
    });
  });

  describe('DELETE /auth/teams/:teamId', () => {
    it('401s with no session', async () => {
      const store = await tempStore();
      const { org } = await store.createOrg({ name: 'Acme', slug: 'acme' });
      const eng = await store.createTeam({ orgId: org.id, name: 'Engineering', slug: 'engineering' });
      const app = createTeamRoutes(buildDeps(store));
      const res = await app.request(`/auth/teams/${eng.id}`, { method: 'DELETE' });
      expect(res.status).toBe(401);
    });

    it('403s a `member`', async () => {
      const store = await tempStore();
      const { org } = await store.createOrg({ name: 'Acme', slug: 'acme' });
      const eng = await store.createTeam({ orgId: org.id, name: 'Engineering', slug: 'engineering' });
      const cookie = await signInAs(store, { subject: 'mallory', orgId: org.id, role: 'member' });
      const app = createTeamRoutes(buildDeps(store));

      const res = await app.request(`/auth/teams/${eng.id}`, { method: 'DELETE', headers: { cookie } });
      expect(res.status).toBe(403);
    });

    it('an owner deletes a team with no projects assigned', async () => {
      const store = await tempStore();
      const { org } = await store.createOrg({ name: 'Acme', slug: 'acme' });
      const eng = await store.createTeam({ orgId: org.id, name: 'Engineering', slug: 'engineering' });
      const cookie = await signInAs(store, { subject: 'owner-1', orgId: org.id, role: 'owner' });
      const app = createTeamRoutes(buildDeps(store));

      const res = await app.request(`/auth/teams/${eng.id}`, { method: 'DELETE', headers: { cookie } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ deleted: true, id: eng.id });
      expect(store.getTeamById(eng.id)).toBeUndefined();
    });

    it("409s — REFUSES, never silently orphans or reassigns — a team that still has a project assigned", async () => {
      const store = await tempStore();
      const { org, defaultTeam } = await store.createOrg({ name: 'Acme', slug: 'acme' });
      const eng = await store.createTeam({ orgId: org.id, name: 'Engineering', slug: 'engineering' });
      const projectDir = await mkdtemp(join(tmpdir(), 'cezar-teams-project-'));
      dirs.push(projectDir);
      // Keyed on the row's OWN `projectRoot` below, not `projectDir` itself — `createProjectTeam`
      // stores a realpath (D4's PRIMARY KEY discipline), which can differ from the raw temp-dir
      // string on a platform where the temp root is a symlink (macOS `/tmp` -> `/private/tmp`).
      const claim = await store.createProjectTeam({ projectRoot: projectDir, orgId: org.id, teamId: eng.id });
      const cookie = await signInAs(store, { subject: 'owner-1', orgId: org.id, role: 'owner' });
      const app = createTeamRoutes(buildDeps(store));

      const res = await app.request(`/auth/teams/${eng.id}`, { method: 'DELETE', headers: { cookie } });
      expect(res.status).toBe(409);
      // the team survives, and so does the project's assignment
      expect(store.getTeamById(eng.id)).toBeDefined();
      expect(store.getProjectTeam(claim.projectRoot)?.teamId).toBe(eng.id);
      // and the org's OTHER team is untouched by this refusal
      expect(store.getTeamById(defaultTeam.id)).toBeDefined();
    });

    it("CROSS-ORG: a team id from org B is not reachable by an org A caller — 404, and nothing is deleted", async () => {
      const store = await tempStore();
      const { org: orgA } = await store.createOrg({ name: 'Acme', slug: 'acme' });
      const { defaultTeam: teamB } = await store.createOrg({ name: 'Beta', slug: 'beta' });
      const cookie = await signInAs(store, { subject: 'owner-a', orgId: orgA.id, role: 'owner' });
      const app = createTeamRoutes(buildDeps(store));

      const res = await app.request(`/auth/teams/${teamB.id}`, { method: 'DELETE', headers: { cookie } });
      expect(res.status).toBe(404);
      expect(store.getTeamById(teamB.id)).toBeDefined();
    });

    /**
     * ADDED 2026-08-07 (5b/5c/8 repair stage). Every DELETE case above happens to run against an
     * org with TWO teams, which is why none of them could see this: an org's LAST team is
     * project-free by definition on a fresh org, so it passed `team-has-projects` and answered
     * `200 {"deleted":true}` — and then `session.ts#resolveIdentity` returned `null` for every
     * member of that org, because it resolves `principal.teamId` as `listTeams(orgId)[0]`. The
     * assertion that matters is not the 409, it is the line after it: the owner's own session must
     * still resolve. Without the guard the DELETE succeeds and `resolveFromCookieHeader` answers
     * `null` here, so both halves of this test fail.
     */
    it("409s on the org's LAST team — deleting it would resolve every member's session to null", async () => {
      const store = await tempStore();
      const { org, defaultTeam } = await store.createOrg({ name: 'Acme', slug: 'acme' });
      const cookie = await signInAs(store, { subject: 'owner-1', orgId: org.id, role: 'owner' });
      const service = SessionService.create(store, { authProvider: () => 'oidc' });
      const app = createTeamRoutes(buildDeps(store));
      expect(store.listTeams(org.id)).toHaveLength(1);

      const res = await app.request(`/auth/teams/${defaultTeam.id}`, { method: 'DELETE', headers: { cookie } });
      expect(res.status).toBe(409);
      expect((await res.json()) as { error: string }).toEqual({
        error: expect.stringContaining('only team in your organization') as unknown as string,
      });

      // The point of the guard: the org is still usable afterwards.
      expect(store.getTeamById(defaultTeam.id)).toBeDefined();
      expect(service.resolveFromCookieHeader(cookie)).toMatchObject({ kind: 'session', orgId: org.id, role: 'owner' });
      const listed = await app.request('/auth/teams', { headers: { cookie } });
      expect(listed.status).toBe(200);
    });

    it('once a SECOND team exists, the former last team is deletable again — the guard is a count, not a pin on the default team', async () => {
      const store = await tempStore();
      const { org, defaultTeam } = await store.createOrg({ name: 'Acme', slug: 'acme' });
      const cookie = await signInAs(store, { subject: 'owner-1', orgId: org.id, role: 'owner' });
      const app = createTeamRoutes(buildDeps(store));

      const created = await app.request('/auth/teams', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Engineering', slug: 'engineering' }),
      });
      expect(created.status).toBe(201);

      const res = await app.request(`/auth/teams/${defaultTeam.id}`, { method: 'DELETE', headers: { cookie } });
      expect(res.status).toBe(200);
      expect(store.listTeams(org.id).map((team) => team.slug)).toEqual(['engineering']);
    });
  });

  /**
   * ADDED 2026-08-07 (5b/5c/8 repair stage). `createTeamInputSchema.slug` was
   * `z.string().trim().min(1).max(63)` with no pattern while the STORE's `slugSchema` enforces DNS
   * label rules, so a D12-authorized admin's ordinary typo sailed past the route validator and
   * threw a raw `ZodError` out of `identity-store.ts` — past this file's `IdentityStoreError`-only
   * catch — as an unhandled 500. The contract carries `slugInputSchema` now; this is the pin.
   */
  describe('the wire slug schema is no wider than the store slug schema', () => {
    it.each([['Not A Slug!'], ['UPPER'], ['-leading-hyphen'], ['trailing-hyphen-'], ['has space']])(
      'rejects %j with a 400, never a 500',
      async (slug) => {
        const store = await tempStore();
        const { org } = await store.createOrg({ name: 'Acme', slug: 'acme' });
        const cookie = await signInAs(store, { subject: 'owner-1', orgId: org.id, role: 'owner' });
        const app = createTeamRoutes(buildDeps(store));

        const res = await app.request('/auth/teams', {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Engineering', slug }),
        });
        expect(res.status).toBe(400);
        expect(store.listTeams(org.id)).toHaveLength(1);
      },
    );

    it('and the lease is not wedged by the refusal — a legal create right after still succeeds', async () => {
      const store = await tempStore();
      const { org } = await store.createOrg({ name: 'Acme', slug: 'acme' });
      const cookie = await signInAs(store, { subject: 'owner-1', orgId: org.id, role: 'owner' });
      const app = createTeamRoutes(buildDeps(store));

      await app.request('/auth/teams', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Bad', slug: 'Bad Slug!' }),
      });
      const ok = await app.request('/auth/teams', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Marketing', slug: 'marketing' }),
      });
      expect(ok.status).toBe(201);
    });
  });
});

// ---- mount-point wiring: does server.ts's contract actually hold? -----------------------------
//
// Every test above exercises `createTeamRoutes(deps)` directly, never through `createApp` — so
// none of them could have caught `ServerDeps.teamRoutes` being declared and threaded by
// `src/index.ts`'s `serveCommand` without `createApp` ever mounting it. That was exactly the shape
// of the bug: the field existed, `serveCommand` built and passed a real `Hono` instance for it, and
// `createApp` silently dropped it on the floor — `GET /auth/teams` fell through to the SPA
// catch-all (a 200 HTML page, not even a 404) on every real deployment, while every unit test above
// stayed green because none of them go through this seam. Mirrors
// `onboarding-routes.test.ts`'s own `describe('mount point (server.ts)', …)` block, added for the
// identical reason.
describe('mount point (server.ts)', () => {
  const savedHome = process.env.CEZ_HOME;
  let home: string;
  let repoRoot: string;
  let store: RunStore;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-teams-home-'));
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-teams-repo-'));
    process.env.CEZ_HOME = home;
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
  });

  afterEach(() => {
    store.flush();
    for (const dir of [home, repoRoot]) rmSync(dir, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
  });

  const makeApp = (teamRoutes?: ReturnType<typeof createTeamRoutes>) =>
    createApp({
      repoRoot,
      store,
      manager: {} as RunManager,
      version: '0.0.0-test',
      teamRoutes,
    });

  // CORRECTED 2026-08-07 (D13, phase 9 HTTP surface): this title used to read "...(the
  // CEZ_AUTH=none shape, D1)". No longer accurate — `CEZ_AUTH` unset no longer implies these deps
  // are absent (see the `local mode` block below, wired with `CEZ_AUTH` still unset). What is
  // still true, and all this test asserts, is that ABSENT deps produce this exact 404/SPA-fallback
  // signature — a statement about `server.ts`'s mount contract, not about auth mode.
  it('registers no /auth/teams* route at all when teamRoutes is absent (deps-absence, not an auth-mode signature)', async () => {
    const app = makeApp(undefined);
    // Same two-signature absence proof `./onboarding-routes.test.ts` uses: GET falls through to
    // the SPA catch-all (200 HTML), a mutating method has no such fallback (genuine 404).
    const getRes = await apiRequest(app, '/auth/teams');
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get('content-type')).toContain('text/html');

    const postRes = await apiRequest(app, '/auth/teams', {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:4321' },
    });
    expect(postRes.status).toBe(404);
  });

  it('reaches /auth/teams once teamRoutes is wired — mounted at the app ROOT, not under /api/v1', async () => {
    const identityStore = await tempStore();
    const service = SessionService.create(identityStore, { authProvider: () => 'oidc' });
    const app = makeApp(
      createTeamRoutes({
        sessionResolver: { resolveFromCookieHeader: (header) => service.resolveFromCookieHeader(header) },
        identityStore,
      }),
    );

    // 401, not 404 or the SPA shell: the route exists and ran, it just has no session.
    const res = await apiRequest(app, '/auth/teams');
    expect(res.status).toBe(401);
  });

  // ---- D13 local mode: teamRoutes wired the way src/index.ts wires it, CEZ_AUTH still unset -----
  describe('local mode (D13)', () => {
    beforeEach(() => {
      // Single global cache slot (see `./local-identity.ts`'s own doc comment) — must not leak a
      // cached answer between this block's own cases, or from a case above it in this same file.
      invalidateLocalOrgIdentityCache();
    });

    it('reaches /auth/teams with no session cookie at all, once an org exists — never 401 (D13 invariant 1)', async () => {
      const identityStore = IdentityStore.open(identityDir());
      const onboarding = makeApp(
        createOnboardingRoutes({
          sessionResolver: localSessionResolver,
          identityStore,
          bootstrapClaim: { required: false, mode: 'open' },
          localSignedInGate: createRequireSignedInLocal(identityStore),
          localOrgAdminGate: createRequireOrgAdminLocal(localSessionResolver),
        }),
      );
      const created = await apiRequest(onboarding, '/auth/onboarding/org', {
        method: 'POST',
        headers: { origin: 'http://127.0.0.1:4321', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'My Workspace' }),
      });
      expect(created.status).toBe(201);

      const teams = makeApp(
        createTeamRoutes({
          sessionResolver: localSessionResolver,
          identityStore,
          localOrgAdminGate: createRequireOrgAdminLocal(localSessionResolver),
        }),
      );
      const listed = await apiRequest(teams, '/auth/teams');
      expect(listed.status).toBe(200);
      const body = (await listed.json()) as { teams: { name: string }[] };
      expect(body.teams).toHaveLength(1);
      expect(body.teams[0]?.name).toBe('General');

      const secondTeam = await apiRequest(teams, '/auth/teams', {
        method: 'POST',
        headers: { origin: 'http://127.0.0.1:4321', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Engineering', slug: 'engineering' }),
      });
      expect(secondTeam.status).toBe(201);
    });

    it('reports "no organization exists yet" (400, never 401) before the local org has been created', async () => {
      const identityStore = IdentityStore.open(identityDir());
      const teams = makeApp(
        createTeamRoutes({
          sessionResolver: localSessionResolver,
          identityStore,
          localOrgAdminGate: createRequireOrgAdminLocal(localSessionResolver),
        }),
      );
      const res = await apiRequest(teams, '/auth/teams');
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'no organization exists yet' });
    });

    /**
     * FIX 4 (D13 repair pass). `./local-identity.ts#resolveLocalOrgIdentity`'s cache was
     * invalidated in exactly ONE place before this fix — `POST /auth/onboarding/org`'s legacy
     * branch — so a request that had already resolved (and cached) a local `Principal` naming the
     * org's default team kept reading that SAME `teamId` after a later `DELETE
     * /auth/teams/:teamId` removed it. Reproduced end to end, through the real HTTP surface, using
     * the same cache both `localSessionResolver` (this file) and `server.ts#resolveLocalPrincipal`
     * (the POST /api/v1/projects path below) read: without the fix, the final assertion's request
     * throws `unexpected project-team registration failure: team-not-found` inside
     * `registerFolder`'s claim block and answers 500 instead of 200.
     */
    it('DELETE-ing the cached team does not brick a later POST /api/v1/projects — the cache is invalidated too', async () => {
      const identityStore = IdentityStore.open(identityDir());
      const onboarding = makeApp(
        createOnboardingRoutes({
          sessionResolver: localSessionResolver,
          identityStore,
          bootstrapClaim: { required: false, mode: 'open' },
          localSignedInGate: createRequireSignedInLocal(identityStore),
          localOrgAdminGate: createRequireOrgAdminLocal(localSessionResolver),
        }),
      );
      const created = await apiRequest(onboarding, '/auth/onboarding/org', {
        method: 'POST',
        headers: { origin: 'http://127.0.0.1:4321', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'My Workspace' }),
      });
      expect(created.status).toBe(201);
      const defaultTeamId = ((await created.json()) as { team: { id: string } }).team.id;

      const teams = makeApp(
        createTeamRoutes({
          sessionResolver: localSessionResolver,
          identityStore,
          localOrgAdminGate: createRequireOrgAdminLocal(localSessionResolver),
        }),
      );
      // A second team so the default team is not the org's LAST (`team-is-last` would otherwise
      // refuse the delete below) — this call ALSO warms `resolveLocalOrgIdentity`'s cache with
      // `teamId: defaultTeamId` (the admin gate resolves the principal on every call), which is
      // the precondition the bug needs: a resolved, CACHED principal naming the team about to be
      // deleted.
      const secondTeam = await apiRequest(teams, '/auth/teams', {
        method: 'POST',
        headers: { origin: 'http://127.0.0.1:4321', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Engineering', slug: 'engineering' }),
      });
      expect(secondTeam.status).toBe(201);

      const deleted = await apiRequest(teams, `/auth/teams/${defaultTeamId}`, {
        method: 'DELETE',
        headers: { origin: 'http://127.0.0.1:4321' },
      });
      expect(deleted.status).toBe(200);

      // The regression: `server.ts`'s own `resolveLocalPrincipal` reads THE SAME
      // `resolveLocalOrgIdentity` cache `localSessionResolver` reads above. If the cache was not
      // invalidated by the DELETE, this still names the just-deleted team and `registerFolder`'s
      // claim block 500s instead of filing the project under whatever team is actually left.
      const projectRoot = mkdtempSync(join(tmpdir(), 'cez-teams-project-'));
      try {
        const registered = await apiRequest(makeApp(), '/api/v1/projects', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ root: projectRoot }),
        });
        expect(registered.status).toBe(200);
        const body = (await registered.json()) as { project: { teamId?: string } };
        expect(body.project.teamId).toBeDefined();
        expect(body.project.teamId).not.toBe(defaultTeamId);
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    });
  });
});
