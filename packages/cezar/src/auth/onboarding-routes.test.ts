import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from '../server/server.ts';
import { apiRequest } from '../server/loopback-request.testkit.ts';
import { IdentityStore } from './identity-store.ts';
import { SessionService } from './session.ts';
import { createOnboardingRoutes, type OnboardingRouteDeps } from './onboarding-routes.ts';
import type { BootstrapClaim } from './bootstrap-claim.ts';

/**
 * Exercised against a REAL `IdentityStore` (temp directory, no fakes) and a REAL `SessionService`
 * built on top of it — the same "real wiring, fake only what's genuinely external" discipline
 * `./routes.test.ts` uses (there is nothing external here to fake: no network, no OIDC).
 */

const dirs: string[] = [];

async function tempStore(): Promise<IdentityStore> {
  const dir = await mkdtemp(join(tmpdir(), 'cezar-onboarding-'));
  dirs.push(dir);
  await mkdir(dir, { recursive: true });
  return IdentityStore.open(dir);
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * `bootstrapClaim` is left at the route's own default here, which under the suite's environment
 * (`vitest.setup.ts` deletes `CEZ_AUTH` once per worker) resolves to `{ required: false, mode:
 * 'open' }` — i.e. exactly the pre-2026-08-07 behaviour, so every test below that is not ABOUT the
 * claim exercises the same route it always did. The claim's own describe block injects a required
 * one explicitly rather than mutating `process.env`, the same reason `SessionServiceOptions.
 * authProvider` is injectable.
 */
function buildDeps(store: IdentityStore, bootstrapClaim?: BootstrapClaim): OnboardingRouteDeps {
  const service = SessionService.create(store, { authProvider: () => 'oidc' });
  return {
    sessionResolver: { resolveFromCookieHeader: (header) => service.resolveFromCookieHeader(header) },
    identityStore: store,
    bootstrapClaim,
  };
}

/** Mints a real session cookie against `store` — a fresh `SessionService` here is exactly as good
 *  as reaching into `deps.sessionResolver`, since both read/write the SAME `IdentityStore` and
 *  neither keeps an in-memory cache (see `identity-store.ts`'s own module doc on why). */
async function signInCookie(store: IdentityStore, input: { subject: string; email?: string }): Promise<{ cookie: string; userId: string }> {
  const { user } = await store.findOrCreateUser({ issuer: 'https://idp.example.test', subject: input.subject, email: input.email });
  const service = SessionService.create(store, { authProvider: () => 'oidc' });
  const created = await service.createSession(user.id);
  return { cookie: created.cookie.split(';')[0]!, userId: user.id };
}

describe('createOnboardingRoutes', () => {
  describe('GET /auth/onboarding', () => {
    it('401s with no session at all', async () => {
      const store = await tempStore();
      const app = createOnboardingRoutes(buildDeps(store));
      const res = await app.request('/auth/onboarding');
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthenticated' });
    });

    it('reports needs-org for a signed-in user with no membership, suggesting an org name from the email domain', async () => {
      const store = await tempStore();
      const deps = buildDeps(store);
      const { cookie } = await signInCookie(store, { subject: 'alice', email: 'alice@acme.com' });
      const app = createOnboardingRoutes(deps);

      const res = await app.request('/auth/onboarding', { headers: { cookie } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ state: 'needs-org', suggestedOrgName: 'Acme', bootstrapTokenRequired: false });
    });

    it('suggests nothing for a personal-mailbox domain (gmail.com) rather than an actively wrong default', async () => {
      const store = await tempStore();
      const deps = buildDeps(store);
      const { cookie } = await signInCookie(store, { subject: 'bob', email: 'bob@gmail.com' });
      const app = createOnboardingRoutes(deps);

      const res = await app.request('/auth/onboarding', { headers: { cookie } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ state: 'needs-org', bootstrapTokenRequired: false });
    });

    it('suggests nothing when the signed-in user has no email on file', async () => {
      const store = await tempStore();
      const deps = buildDeps(store);
      const { cookie } = await signInCookie(store, { subject: 'carol' });
      const app = createOnboardingRoutes(deps);

      const res = await app.request('/auth/onboarding', { headers: { cookie } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ state: 'needs-org', bootstrapTokenRequired: false });
    });

    it('reports ready with the resolved org/team/role once a membership exists, hasProjects false with none registered', async () => {
      const store = await tempStore();
      const { org, defaultTeam } = await store.createOrg({ name: 'Acme', slug: 'acme' });
      const { user } = await store.findOrCreateUser({ issuer: 'https://idp.example.test', subject: 'dave' });
      await store.createMembership({ userId: user.id, orgId: org.id, role: 'owner' });
      const deps = buildDeps(store);
      const service = SessionService.create(store, { authProvider: () => 'oidc' });
      const created = await service.createSession(user.id);
      const cookie = created.cookie.split(';')[0]!;
      const app = createOnboardingRoutes(deps);

      const res = await app.request('/auth/onboarding', { headers: { cookie } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        state: 'ready',
        org: { id: org.id, name: org.name, slug: org.slug, createdAt: org.createdAt },
        team: { id: defaultTeam.id, orgId: defaultTeam.orgId, name: defaultTeam.name, slug: defaultTeam.slug },
        role: 'owner',
        hasProjects: false,
      });
    });

    it('reports hasProjects true once a project root is registered to the org', async () => {
      const store = await tempStore();
      const { org, defaultTeam } = await store.createOrg({ name: 'Acme', slug: 'acme' });
      const { user } = await store.findOrCreateUser({ issuer: 'https://idp.example.test', subject: 'erin' });
      await store.createMembership({ userId: user.id, orgId: org.id, role: 'owner' });
      const projectRoot = await mkdtemp(join(tmpdir(), 'cezar-onboarding-project-'));
      dirs.push(projectRoot);
      await store.createProjectTeam({ projectRoot, orgId: org.id, teamId: defaultTeam.id });
      const deps = buildDeps(store);
      const service = SessionService.create(store, { authProvider: () => 'oidc' });
      const created = await service.createSession(user.id);
      const cookie = created.cookie.split(';')[0]!;
      const app = createOnboardingRoutes(deps);

      const res = await app.request('/auth/onboarding', { headers: { cookie } });
      expect(res.status).toBe(200);
      expect((await res.json()) as { hasProjects: boolean }).toMatchObject({ state: 'ready', hasProjects: true });
    });
  });

  describe('POST /auth/onboarding/org', () => {
    it('401s with no session', async () => {
      const store = await tempStore();
      const app = createOnboardingRoutes(buildDeps(store));
      const res = await app.request('/auth/onboarding/org', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Acme' }),
      });
      expect(res.status).toBe(401);
    });

    it('creates the org + default team, grants the caller owner, and reports ready afterwards', async () => {
      const store = await tempStore();
      const deps = buildDeps(store);
      const { cookie, userId } = await signInCookie(store, { subject: 'frank', email: 'frank@umbrella.corp' });
      const app = createOnboardingRoutes(deps);

      const res = await app.request('/auth/onboarding/org', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Umbrella Corp' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { org: { id: string; slug: string; name: string }; team: { id: string }; role: string };
      expect(body.org.name).toBe('Umbrella Corp');
      expect(body.org.slug).toBe('umbrella-corp');
      expect(body.role).toBe('owner');

      const membership = store.getMembership(userId, body.org.id);
      expect(membership).toEqual({ userId, orgId: body.org.id, role: 'owner' });

      const status = await app.request('/auth/onboarding', { headers: { cookie } });
      expect(status.status).toBe(200);
      expect((await status.json()) as { state: string }).toMatchObject({ state: 'ready', role: 'owner' });
    });

    it('409s a second bootstrap attempt for the same already-a-member user', async () => {
      const store = await tempStore();
      const deps = buildDeps(store);
      const { cookie } = await signInCookie(store, { subject: 'grace' });
      const app = createOnboardingRoutes(deps);

      const first = await app.request('/auth/onboarding/org', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Grace Org' }),
      });
      expect(first.status).toBe(201);

      const second = await app.request('/auth/onboarding/org', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'A Second Org' }),
      });
      expect(second.status).toBe(409);
    });

    // ---- D8 step 1's actual rule: "subsequent users need an invite" -----------------------------
    //
    // REPLACES a test that asserted the opposite ("disambiguates a colliding slug rather than
    // refusing the second org": `user-two` POSTed and got a 201 with slug `acme-2`). That test
    // was green and encoded the defect — a per-USER bootstrap gate, which lets every authenticated
    // identity own its own org inside the one process D4 says is a single org until phase 6. The
    // spec is unambiguous the other way in three places: D8 step 1 ("the first user to sign in
    // becomes owner of a new org; subsequent users need an invite"), the phase 4 verification row
    // ("invite required for the second user"), and D4 ("hosted means single-org"). The two tests
    // below are what that row actually asks for, and they are a strictly stronger claim than the
    // one they replace — a refusal is falsifiable by the old implementation, which they fail
    // against (verified: reverting the route to `createOrg` + `createMembership` makes both red).
    it('refuses a SECOND user’s bootstrap once any org exists — D8: subsequent users need an invite', async () => {
      const store = await tempStore();
      const deps = buildDeps(store);
      const app = createOnboardingRoutes(deps);

      const first = await signInCookie(store, { subject: 'user-one' });
      const firstRes = await app.request('/auth/onboarding/org', {
        method: 'POST',
        headers: { cookie: first.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Acme' }),
      });
      expect(firstRes.status).toBe(201);
      const firstBody = (await firstRes.json()) as { org: { id: string; slug: string } };
      expect(firstBody.org.slug).toBe('acme');

      // A genuinely different user, with zero memberships of their own — the exact caller the
      // old per-user check waved through.
      const second = await signInCookie(store, { subject: 'user-two' });
      const secondRes = await app.request('/auth/onboarding/org', {
        method: 'POST',
        headers: { cookie: second.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Umbrella' }),
      });
      expect(secondRes.status).toBe(409);

      // Nothing was written for them: no second org (not even under a disambiguated slug), no
      // membership, and the first user still owns the one org that exists.
      expect(store.listOrgs()).toHaveLength(1);
      expect(store.listOrgs()[0]!.id).toBe(firstBody.org.id);
      expect(store.listMemberships(second.userId)).toEqual([]);
      expect(store.getMembership(first.userId, firstBody.org.id)?.role).toBe('owner');
    });

    it('lets exactly one of two simultaneous first-time users win the bootstrap', async () => {
      const store = await tempStore();
      const deps = buildDeps(store);
      const app = createOnboardingRoutes(deps);

      const alice = await signInCookie(store, { subject: 'race-alice' });
      const bob = await signInCookie(store, { subject: 'race-bob' });

      // Fired in the SAME synchronous tick, with no `await` between them — both handlers run up
      // to their first suspension point before either has taken the identity-store write lease,
      // which is what makes this a real interleaving rather than two sequential calls dressed up
      // as one. A read-then-act gate outside the lease passes both.
      const [aliceRes, bobRes] = await Promise.all([
        app.request('/auth/onboarding/org', {
          method: 'POST',
          headers: { cookie: alice.cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Acme' }),
        }),
        app.request('/auth/onboarding/org', {
          method: 'POST',
          headers: { cookie: bob.cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Acme' }),
        }),
      ]);

      const statuses = [aliceRes.status, bobRes.status].sort((a, b) => a - b);
      expect(statuses).toEqual([201, 409]);
      expect(store.listOrgs()).toHaveLength(1);
      // ...and exactly one owner, not two memberships on the one surviving org.
      expect(store.listOrgMembers(store.listOrgs()[0]!.id)).toHaveLength(1);
    });

    // ---- slugFromName's two guards (unpinned until 2026-08-07; both survived a full-suite
    // mutation run, and removing either turns first-user onboarding into an uncaught ZodError →
    // plain-text 500 with no way for that deployment to ever get an org) ------------------------
    it('falls back to the "org" slug for a name with no ASCII alphanumerics — deleting `|| \'org\'` 500s the only bootstrap the deployment gets', async () => {
      const store = await tempStore();
      const { cookie } = await signInCookie(store, { subject: 'kanji' });
      const app = createOnboardingRoutes(buildDeps(store));

      const res = await app.request('/auth/onboarding/org', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: '株式会社アクメ' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { org: { name: string; slug: string } };
      expect(body.org.name).toBe('株式会社アクメ');
      expect(body.org.slug).toBe('org');
      // …and it really is on disk, i.e. the 201 is not a response shaped ahead of a failed write.
      expect(store.listOrgs().map((org) => org.slug)).toEqual(['org']);
    });

    it('truncates a slug longer than 63 chars and strips the trailing hyphen the cut can leave', async () => {
      const store = await tempStore();
      const { cookie } = await signInCookie(store, { subject: 'verbose' });
      const app = createOnboardingRoutes(buildDeps(store));

      // 40 × "ab" joined by " - " is a 197-char name (inside `createOnboardingOrgInputSchema`'s
      // 200-char limit, so a real user can type it) whose raw slug is `ab-ab-…`, 119 chars. The
      // repeating unit is 3 chars, so the 63-char cut lands exactly ON a hyphen — one input
      // exercising both halves of the guard, `slice(0, 63)` and the `-+$` strip. Without the
      // guard the 119-char slug fails `slugSchema`'s 63-char max inside `guardedWrite`, and the
      // ZodError escapes the handler as a plain-text 500 (verified by mutation).
      const name = Array.from({ length: 40 }, () => 'ab').join(' - ');
      expect(name.length).toBeLessThanOrEqual(200);
      const res = await app.request('/auth/onboarding/org', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      expect(res.status).toBe(201);
      const slug = ((await res.json()) as { org: { slug: string } }).org.slug;
      expect(slug.length).toBeLessThanOrEqual(63);
      expect(slug.endsWith('-')).toBe(false);
      // `auth/types.ts`'s own storage shape, asserted here rather than trusted: this is the exact
      // regex whose violation raised the uncaught ZodError.
      expect(slug).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
    });

    it('400s a body with no name', async () => {
      const store = await tempStore();
      const deps = buildDeps(store);
      const { cookie } = await signInCookie(store, { subject: 'henry' });
      const app = createOnboardingRoutes(deps);

      const res = await app.request('/auth/onboarding/org', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  });

  // ---- who may be first (ADDED 2026-08-07, `./bootstrap-claim.ts`) ------------------------------
  describe('the bootstrap claim', () => {
    const required: BootstrapClaim = { required: true, mode: 'generated', token: 'c0de-from-the-boot-log' };

    it('403s a signed-in stranger with no code, and writes NOTHING', async () => {
      const store = await tempStore();
      const { cookie, userId } = await signInCookie(store, { subject: 'passing-stranger' });
      const app = createOnboardingRoutes(buildDeps(store, required));

      const res = await app.request('/auth/onboarding/org', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Totally Legitimate Inc' }),
      });
      expect(res.status).toBe(403);
      // The whole point: no org, so no `owner` membership, so no principal, so no
      // `POST /api/v1/workflows` → `spawn('bash', …)`.
      expect(store.listOrgs()).toEqual([]);
      expect(store.listMemberships(userId)).toEqual([]);
    });

    it('403s a wrong code', async () => {
      const store = await tempStore();
      const { cookie } = await signInCookie(store, { subject: 'guesser' });
      const app = createOnboardingRoutes(buildDeps(store, required));

      const res = await app.request('/auth/onboarding/org', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Acme', bootstrapToken: 'c0de-from-the-boot-lob' }),
      });
      expect(res.status).toBe(403);
      expect(store.listOrgs()).toEqual([]);
    });

    it('lets the operator through with the exact code', async () => {
      const store = await tempStore();
      const { cookie, userId } = await signInCookie(store, { subject: 'operator' });
      const app = createOnboardingRoutes(buildDeps(store, required));

      const res = await app.request('/auth/onboarding/org', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Acme', bootstrapToken: 'c0de-from-the-boot-log' }),
      });
      expect(res.status).toBe(201);
      expect(store.listOrgs()).toHaveLength(1);
      expect(store.getMembership(userId, store.listOrgs()[0]!.id)?.role).toBe('owner');
    });

    it('tells the wizard a code is wanted, without ever sending the code itself', async () => {
      const store = await tempStore();
      const { cookie } = await signInCookie(store, { subject: 'operator' });
      const app = createOnboardingRoutes(buildDeps(store, required));

      const res = await app.request('/auth/onboarding', { headers: { cookie } });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ state: 'needs-org', bootstrapTokenRequired: true });
      // The negative half, stated as its own assertion rather than left to `toEqual`'s exactness:
      // the secret must not reach a client under ANY key.
      expect(JSON.stringify(body)).not.toContain('c0de-from-the-boot-log');
    });

    it("an 'open' claim (CEZ_AUTH_BOOTSTRAP_OPEN=1) needs no code — the refusal is opt-out, not unconditional", async () => {
      const store = await tempStore();
      const { cookie } = await signInCookie(store, { subject: 'local-tester' });
      const app = createOnboardingRoutes(buildDeps(store, { required: false, mode: 'open' }));

      const res = await app.request('/auth/onboarding/org', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Acme' }),
      });
      expect(res.status).toBe(201);
    });
  });

  // ---- D8 step 1's second half, as a STATE and not only as a 409 -------------------------------
  describe('needs-invite', () => {
    it('reports needs-invite (not needs-org) to a second user once an org exists', async () => {
      const store = await tempStore();
      const app = createOnboardingRoutes(buildDeps(store));

      const first = await signInCookie(store, { subject: 'owner-one', email: 'one@acme.com' });
      expect(
        (
          await app.request('/auth/onboarding/org', {
            method: 'POST',
            headers: { cookie: first.cookie, 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'Acme' }),
          })
        ).status,
      ).toBe(201);

      const second = await signInCookie(store, { subject: 'colleague', email: 'two@acme.com' });
      const res = await app.request('/auth/onboarding', { headers: { cookie: second.cookie } });
      expect(res.status).toBe(200);
      // Exactly this, and nothing else: no org name, no owner, no suggestion, and — because the
      // bootstrap window is closed for them — no `bootstrapTokenRequired` either. An unauthorized
      // caller learns nothing here they did not already know by reaching the page.
      expect(await res.json()).toEqual({ state: 'needs-invite' });
    });
  });

  // ---- one cookie reader, shared with session.ts (2026-08-07) ----------------------------------
  describe('a doubled session cookie', () => {
    it('creates the org as the SAME user every other route resolves — hono getCookie takes the first, session.ts takes the last', async () => {
      const store = await tempStore();
      const app = createOnboardingRoutes(buildDeps(store));

      const alice = await signInCookie(store, { subject: 'alice' });
      const bob = await signInCookie(store, { subject: 'bob' });
      // RFC 6265 §5.4 sends longer-`Path` cookies first, so an attacker who can set a cookie on a
      // sibling subdomain controls WHICH occurrence comes first — the position the old
      // `hono/cookie` read picked. `session.ts` picks the last.
      const doubled = `${alice.cookie}; ${bob.cookie}`;

      const created = await app.request('/auth/onboarding/org', {
        method: 'POST',
        headers: { cookie: doubled, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Acme' }),
      });
      expect(created.status).toBe(201);

      // THE discriminator. The org was created for whoever this route read; the status route
      // resolves the identical header through D3's shared `sessionResolver`. If the two readers
      // disagree, the org belongs to Alice while the resolver sees Bob, and this reads
      // `needs-invite` instead of `ready`.
      const status = await app.request('/auth/onboarding', { headers: { cookie: doubled } });
      expect(status.status).toBe(200);
      expect((await status.json()) as { state: string }).toMatchObject({ state: 'ready', role: 'owner' });

      // Said again from the store's side, so the claim is not resting on one route's answer.
      const orgId = store.listOrgs()[0]!.id;
      expect(store.getMembership(bob.userId, orgId)?.role).toBe('owner');
      expect(store.getMembership(alice.userId, orgId)).toBeUndefined();
    });
  });

  // ---- the wire shape is PICKED, not spread (unpinned until 2026-08-07) ------------------------
  describe('response shaping', () => {
    it('never leaks a storage-only column that `.passthrough()` let through', async () => {
      const store = await tempStore();
      const { org, defaultTeam } = await store.createOrg({ name: 'Acme', slug: 'acme' });
      const { user } = await store.findOrCreateUser({ issuer: 'https://idp.example.test', subject: 'nina' });
      await store.createMembership({ userId: user.id, orgId: org.id, role: 'owner' });

      // Simulate a NEWER cezar having written a column this version has never heard of — the exact
      // case `auth/types.ts`'s `.passthrough()` exists for (D7). `identity.json` is edited
      // directly because no method on this version's store can write an unknown key.
      const snapshotPath = join(store.dir, 'identity.json');
      const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as {
        orgs: Record<string, unknown>[];
        teams: Record<string, unknown>[];
      };
      snapshot.orgs[0]!.billingCustomerId = 'cus_SECRET';
      snapshot.teams[0]!.internalNote = 'do-not-ship';
      writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
      // The store really does carry it forward — otherwise this test would be asserting the
      // absence of something that never existed.
      expect(store.getOrgById(org.id)).toMatchObject({ billingCustomerId: 'cus_SECRET' });

      const deps = buildDeps(store);
      const service = SessionService.create(store, { authProvider: () => 'oidc' });
      const cookie = (await service.createSession(user.id)).cookie.split(';')[0]!;
      const app = createOnboardingRoutes(deps);

      const res = await app.request('/auth/onboarding', { headers: { cookie } });
      const body = (await res.json()) as { org: Record<string, unknown>; team: Record<string, unknown> };
      expect(Object.keys(body.org).sort()).toEqual(['createdAt', 'id', 'name', 'slug']);
      expect(Object.keys(body.team).sort()).toEqual(['id', 'name', 'orgId', 'slug']);
      expect(JSON.stringify(body)).not.toContain('cus_SECRET');
      expect(JSON.stringify(body)).not.toContain('do-not-ship');
      expect(defaultTeam.id).toBe(body.team.id);
    });

    it('scopes hasProjects to the CALLER’s org — another org’s registered project is not theirs', async () => {
      const store = await tempStore();
      const { org: orgA, defaultTeam: teamA } = await store.createOrg({ name: 'Org A', slug: 'org-a' });
      const { org: orgB } = await store.createOrg({ name: 'Org B', slug: 'org-b' });
      const { user: userB } = await store.findOrCreateUser({ issuer: 'https://idp.example.test', subject: 'user-b' });
      await store.createMembership({ userId: userB.id, orgId: orgB.id, role: 'owner' });

      // Only org A holds a project claim.
      const projectRoot = await mkdtemp(join(tmpdir(), 'cezar-onboarding-other-org-'));
      dirs.push(projectRoot);
      await store.createProjectTeam({ projectRoot, orgId: orgA.id, teamId: teamA.id });

      const service = SessionService.create(store, { authProvider: () => 'oidc' });
      const cookie = (await service.createSession(userB.id)).cookie.split(';')[0]!;
      const app = createOnboardingRoutes(buildDeps(store));

      const res = await app.request('/auth/onboarding', { headers: { cookie } });
      expect(res.status).toBe(200);
      // Dropping `{ orgId: org.id }` from the `listProjectTeams` call makes this `true`, and org
      // B's owner is told to skip a step they have never done.
      expect((await res.json()) as { hasProjects: boolean }).toMatchObject({ state: 'ready', hasProjects: false });
    });
  });

  describe('PATCH /auth/onboarding/team', () => {
    it('401s with no session', async () => {
      const store = await tempStore();
      const app = createOnboardingRoutes(buildDeps(store));
      const res = await app.request('/auth/onboarding/team', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Engineering' }),
      });
      expect(res.status).toBe(401);
    });

    it("401s a signed-in user who has no org yet — there is nothing to rename", async () => {
      const store = await tempStore();
      const deps = buildDeps(store);
      const { cookie } = await signInCookie(store, { subject: 'iris' });
      const app = createOnboardingRoutes(deps);

      const res = await app.request('/auth/onboarding/team', {
        method: 'PATCH',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Engineering' }),
      });
      expect(res.status).toBe(401);
    });

    it('renames the caller\'s own default team', async () => {
      const store = await tempStore();
      const { org, defaultTeam } = await store.createOrg({ name: 'Acme', slug: 'acme' });
      const { user } = await store.findOrCreateUser({ issuer: 'https://idp.example.test', subject: 'jane' });
      await store.createMembership({ userId: user.id, orgId: org.id, role: 'owner' });
      const deps = buildDeps(store);
      const service = SessionService.create(store, { authProvider: () => 'oidc' });
      const cookie = (await service.createSession(user.id)).cookie.split(';')[0]!;
      const app = createOnboardingRoutes(deps);

      const res = await app.request('/auth/onboarding/team', {
        method: 'PATCH',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Platform Engineering' }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        team: { id: defaultTeam.id, orgId: org.id, name: 'Platform Engineering', slug: defaultTeam.slug },
      });
      expect(store.getTeamById(defaultTeam.id)?.name).toBe('Platform Engineering');
    });

    // ---- role is a permission, not a label (ADDED 2026-08-07) -----------------------------------
    //
    // Before this, `principal.role` was read by nothing in the whole server except a response
    // body: a `member` could rename the org's team exactly as an `owner` could, which made
    // `CEZ_OIDC_GROUP_ROLE_MAP` and the store's `CHECK (role IN (...))` decorative. This route is
    // also NOT scoped to onboarding — nothing restricts it to the `needs-org` moment — so it is a
    // permanent rename of the name every member of the org sees.
    it('403s a `member` renaming the org team, and the team keeps its name', async () => {
      const store = await tempStore();
      const { org, defaultTeam } = await store.createOrg({ name: 'Acme', slug: 'acme' });
      const { user } = await store.findOrCreateUser({ issuer: 'https://idp.example.test', subject: 'rank-and-file' });
      await store.createMembership({ userId: user.id, orgId: org.id, role: 'member' });
      const service = SessionService.create(store, { authProvider: () => 'oidc' });
      const cookie = (await service.createSession(user.id)).cookie.split(';')[0]!;
      const app = createOnboardingRoutes(buildDeps(store));

      const res = await app.request('/auth/onboarding/team', {
        method: 'PATCH',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'member renamed this' }),
      });
      expect(res.status).toBe(403);
      expect(store.getTeamById(defaultTeam.id)?.name).toBe(defaultTeam.name);
    });

    it('lets an `admin` rename it — the refusal is about ROLE, not about "only the owner exists"', async () => {
      const store = await tempStore();
      const { org, defaultTeam } = await store.createOrg({ name: 'Acme', slug: 'acme' });
      const { user } = await store.findOrCreateUser({ issuer: 'https://idp.example.test', subject: 'an-admin' });
      await store.createMembership({ userId: user.id, orgId: org.id, role: 'admin' });
      const service = SessionService.create(store, { authProvider: () => 'oidc' });
      const cookie = (await service.createSession(user.id)).cookie.split(';')[0]!;
      const app = createOnboardingRoutes(buildDeps(store));

      const res = await app.request('/auth/onboarding/team', {
        method: 'PATCH',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Platform' }),
      });
      expect(res.status).toBe(200);
      expect(store.getTeamById(defaultTeam.id)?.name).toBe('Platform');
    });

    // ---- THE negative control: org isolation, not merely "is logged in" -------------------------
    it("a member of org A cannot rename org B's team, even if the request body tries to name org B's ids directly", async () => {
      const store = await tempStore();
      const { org: orgA, defaultTeam: teamA } = await store.createOrg({ name: 'Org A', slug: 'org-a' });
      const { org: orgB, defaultTeam: teamB } = await store.createOrg({ name: 'Org B', slug: 'org-b' });
      const { user: userA } = await store.findOrCreateUser({ issuer: 'https://idp.example.test', subject: 'user-a' });
      await store.createMembership({ userId: userA.id, orgId: orgA.id, role: 'owner' });
      // A member of org B too, so a resolver bug that picked the WRONG membership would still
      // read as "some org", not as an obvious crash — the assertions below are what actually
      // catch it.
      const { user: userB } = await store.findOrCreateUser({ issuer: 'https://idp.example.test', subject: 'user-b' });
      await store.createMembership({ userId: userB.id, orgId: orgB.id, role: 'owner' });

      const deps = buildDeps(store);
      const service = SessionService.create(store, { authProvider: () => 'oidc' });
      const cookieA = (await service.createSession(userA.id)).cookie.split(';')[0]!;
      const app = createOnboardingRoutes(deps);

      const res = await app.request('/auth/onboarding/team', {
        method: 'PATCH',
        headers: { cookie: cookieA, 'content-type': 'application/json' },
        // Smuggled ids for org B's team — the schema doesn't declare these fields, but a client
        // can still send them; the route must not read them.
        body: JSON.stringify({ name: 'Hijacked', teamId: teamB.id, orgId: orgB.id }),
      });
      expect(res.status).toBe(200);

      // Org A's team WAS renamed (the request succeeded, scoped to the caller's own org)...
      expect(store.getTeamById(teamA.id)?.name).toBe('Hijacked');
      // ...and org B's team — the one the body tried to name — is completely untouched.
      expect(store.getTeamById(teamB.id)?.name).toBe(teamB.name);
      expect(store.getTeamById(teamB.id)?.name).not.toBe('Hijacked');
    });
  });
});

// ---- mount-point wiring: does server.ts's contract actually hold? -----------------------------

describe('mount point (server.ts)', () => {
  const savedHome = process.env.CEZ_HOME;
  let home: string;
  let repoRoot: string;
  let store: RunStore;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-onboarding-home-'));
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-onboarding-repo-'));
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

  const makeApp = (onboardingRoutes?: ReturnType<typeof createOnboardingRoutes>) =>
    createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', onboardingRoutes });

  it('registers no /auth/onboarding* route at all when onboardingRoutes is absent (the CEZ_AUTH=none shape, D1)', async () => {
    const app = makeApp(undefined);
    // Same two-signature absence proof `./routes.test.ts` uses: GET falls through to the SPA
    // catch-all (200 HTML), a mutating method has no such fallback (genuine, un-shadowed 404).
    const postRes = await apiRequest(app, '/auth/onboarding/org', { method: 'POST', headers: { origin: 'http://127.0.0.1:4321' } });
    expect(postRes.status).toBe(404);
    const patchRes = await apiRequest(app, '/auth/onboarding/team', { method: 'PATCH', headers: { origin: 'http://127.0.0.1:4321' } });
    expect(patchRes.status).toBe(404);

    const getRes = await apiRequest(app, '/auth/onboarding', { method: 'GET' });
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get('content-type')).toContain('text/html');
  });

  it('reaches /auth/onboarding once onboardingRoutes is wired — mounted at the app ROOT, not under /api/v1', async () => {
    const identity = await tempStore();
    const app = makeApp(createOnboardingRoutes(buildDeps(identity)));

    // 401, not 404: the route exists and ran, it just has no session.
    expect((await apiRequest(app, '/auth/onboarding')).status).toBe(401);
  });

  // ---- /auth/onboarding* is INSIDE the #426 perimeter (the exact defect the task named) --------
  it('rejects a cross-origin POST /auth/onboarding/org', async () => {
    const identity = await tempStore();
    const app = makeApp(createOnboardingRoutes(buildDeps(identity)));

    const res = await apiRequest(app, '/auth/onboarding/org', {
      method: 'POST',
      headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Acme' }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects a cross-origin PATCH /auth/onboarding/team', async () => {
    const identity = await tempStore();
    const app = makeApp(createOnboardingRoutes(buildDeps(identity)));

    const res = await apiRequest(app, '/auth/onboarding/team', {
      method: 'PATCH',
      headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Engineering' }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects a rebound Host on GET /auth/onboarding', async () => {
    const identity = await tempStore();
    const app = makeApp(createOnboardingRoutes(buildDeps(identity)));

    const res = await app.request('/auth/onboarding', { headers: { host: 'evil.tld' } });
    expect(res.status).toBe(403);
  });
});
