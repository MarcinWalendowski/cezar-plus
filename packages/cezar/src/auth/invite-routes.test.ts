import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createInviteRoutes, type InviteRouteDeps } from './invite-routes.ts';
import { IdentityStore } from './identity-store.ts';
import { SessionService } from './session.ts';

/**
 * Exercised against a REAL `IdentityStore` (temp directory, no fakes) and a REAL `SessionService`
 * — the same "real wiring, fake only what's genuinely external" discipline
 * `onboarding-routes.test.ts` uses. Everything below the HTTP layer (single-use, expiry, org/team
 * validation, redeem-vs-membership atomicity) is already covered by `identity-store.test.ts`'s
 * "IdentityStore — invites" describe block — these tests are about the HTTP surface this unit adds
 * on top: status codes, D12's role gate ordering, and the org-scoping this file itself has to
 * enforce (`revokeInvite`/`getInvite` take no `orgId`).
 */

const dirs: string[] = [];

async function tempStore(): Promise<IdentityStore> {
  const dir = await mkdtemp(join(tmpdir(), 'cezar-invites-'));
  dirs.push(dir);
  await mkdir(dir, { recursive: true });
  return IdentityStore.open(dir);
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function buildDeps(store: IdentityStore, overrides: Partial<InviteRouteDeps> = {}): InviteRouteDeps {
  const service = SessionService.create(store, { authProvider: () => 'oidc' });
  return {
    sessionResolver: { resolveFromCookieHeader: (header) => service.resolveFromCookieHeader(header) },
    identityStore: store,
    ...overrides,
  };
}

/** Mints a real session cookie for a user with a real membership — the "owner"/"admin"/"member" of
 *  `org`, exactly as `onboarding-routes.test.ts#signInCookie` does for a membership-less user. */
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

/** A signed-in user with NO membership yet — the bar `POST /auth/invites/redeem` needs. */
async function signInNoMembership(store: IdentityStore, subject: string): Promise<string> {
  const { user } = await store.findOrCreateUser({ issuer: 'https://idp.example.test', subject });
  const service = SessionService.create(store, { authProvider: () => 'oidc' });
  const created = await service.createSession(user.id);
  return created.cookie.split(';')[0]!;
}

describe('createInviteRoutes', () => {
  describe('POST /auth/invites', () => {
    it('401s with no session', async () => {
      const store = await tempStore();
      const app = createInviteRoutes(buildDeps(store));
      const res = await app.request('/auth/invites', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'member' }),
      });
      expect(res.status).toBe(401);
    });

    it('403s a `member`, BEFORE the body validator ever runs (authorization before validation)', async () => {
      const store = await tempStore();
      const { org } = await store.createOrg({ name: 'Acme', slug: 'acme' });
      const cookie = await signInAs(store, { subject: 'mallory', orgId: org.id, role: 'member' });
      const app = createInviteRoutes(buildDeps(store));

      // A malformed body that would 400 the validator — a leak here would be 400, not 403.
      const res = await app.request('/auth/invites', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(403);
    });

    it('an owner creates a high-entropy, org-scoped invite with the default 7-day TTL', async () => {
      const now = new Date('2026-01-01T00:00:00.000Z');
      const store = await tempStore();
      const { org } = await store.createOrg({ name: 'Acme', slug: 'acme' });
      const cookie = await signInAs(store, { subject: 'owner-1', orgId: org.id, role: 'owner' });
      const app = createInviteRoutes(buildDeps(store, { now: () => now }));

      const res = await app.request('/auth/invites', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'member' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { invite: { id: string; orgId: string; role: string; expiresAt: string } };
      expect(body.invite.orgId).toBe(org.id);
      expect(body.invite.role).toBe('member');
      // 256 bits, hex — the module doc comment's stated entropy bar.
      expect(body.invite.id).toMatch(/^[0-9a-f]{64}$/);
      expect(body.invite.expiresAt).toBe(new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString());
    });

    it('an admin (not just an owner) may create an invite, honoring an explicit expiresInMs', async () => {
      const now = new Date('2026-01-01T00:00:00.000Z');
      const store = await tempStore();
      const { org } = await store.createOrg({ name: 'Acme', slug: 'acme' });
      const cookie = await signInAs(store, { subject: 'admin-1', orgId: org.id, role: 'admin' });
      const app = createInviteRoutes(buildDeps(store, { now: () => now }));

      const oneHourMs = 60 * 60 * 1000;
      const res = await app.request('/auth/invites', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'admin', expiresInMs: oneHourMs }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { invite: { expiresAt: string } };
      expect(body.invite.expiresAt).toBe(new Date(now.getTime() + oneHourMs).toISOString());
    });

    it('refuses an expiresInMs outside the [15min, 30 days] bound, without touching the store', async () => {
      const store = await tempStore();
      const { org } = await store.createOrg({ name: 'Acme', slug: 'acme' });
      const cookie = await signInAs(store, { subject: 'owner-1', orgId: org.id, role: 'owner' });
      const app = createInviteRoutes(buildDeps(store));

      const tooShort = await app.request('/auth/invites', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'member', expiresInMs: 1000 }),
      });
      expect(tooShort.status).toBe(400);

      const tooLong = await app.request('/auth/invites', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'member', expiresInMs: 365 * 24 * 60 * 60 * 1000 }),
      });
      expect(tooLong.status).toBe(400);
      expect(store.listOrgInvites(org.id)).toEqual([]);
    });

    it('400s a teamId that belongs to a DIFFERENT org — never smuggled through as a wire input', async () => {
      const store = await tempStore();
      const { org: orgA } = await store.createOrg({ name: 'Acme', slug: 'acme' });
      const { defaultTeam: teamB } = await store.createOrg({ name: 'Beta', slug: 'beta' });
      const cookie = await signInAs(store, { subject: 'owner-1', orgId: orgA.id, role: 'owner' });
      const app = createInviteRoutes(buildDeps(store));

      const res = await app.request('/auth/invites', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'member', teamId: teamB.id }),
      });
      expect(res.status).toBe(400);
      expect(store.listOrgInvites(orgA.id)).toEqual([]);
    });
  });

  describe('GET /auth/invites', () => {
    it('401s with no session, 403s a member', async () => {
      const store = await tempStore();
      const { org } = await store.createOrg({ name: 'Acme', slug: 'acme' });
      const app = createInviteRoutes(buildDeps(store));

      const anon = await app.request('/auth/invites');
      expect(anon.status).toBe(401);

      const memberCookie = await signInAs(store, { subject: 'member-1', orgId: org.id, role: 'member' });
      const memberRes = await app.request('/auth/invites', { headers: { cookie: memberCookie } });
      expect(memberRes.status).toBe(403);
    });

    it('lists only the CALLER\'S OWN org invites — never another org\'s', async () => {
      const store = await tempStore();
      const { org: orgA } = await store.createOrg({ name: 'Acme', slug: 'acme' });
      const { org: orgB } = await store.createOrg({ name: 'Beta', slug: 'beta' });
      await store.createInvite({ id: 'a'.repeat(64), orgId: orgA.id, role: 'member', expiresAt: new Date(Date.now() + 60_000) });
      await store.createInvite({ id: 'b'.repeat(64), orgId: orgB.id, role: 'member', expiresAt: new Date(Date.now() + 60_000) });
      const cookieA = await signInAs(store, { subject: 'owner-a', orgId: orgA.id, role: 'owner' });
      const app = createInviteRoutes(buildDeps(store));

      const res = await app.request('/auth/invites', { headers: { cookie: cookieA } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { invites: { id: string; orgId: string }[] };
      expect(body.invites).toHaveLength(1);
      expect(body.invites[0]?.orgId).toBe(orgA.id);
    });
  });

  describe('POST /auth/invites/revoke', () => {
    it('401s with no session, 403s a member', async () => {
      const store = await tempStore();
      const { org } = await store.createOrg({ name: 'Acme', slug: 'acme' });
      const app = createInviteRoutes(buildDeps(store));

      const anon = await app.request('/auth/invites/revoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'x' }),
      });
      expect(anon.status).toBe(401);

      const memberCookie = await signInAs(store, { subject: 'member-1', orgId: org.id, role: 'member' });
      const memberRes = await app.request('/auth/invites/revoke', {
        method: 'POST',
        headers: { cookie: memberCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'x' }),
      });
      expect(memberRes.status).toBe(403);
    });

    it('an owner revokes an active invite in their own org', async () => {
      const store = await tempStore();
      const { org } = await store.createOrg({ name: 'Acme', slug: 'acme' });
      const invite = await store.createInvite({ id: 'c'.repeat(64), orgId: org.id, role: 'member', expiresAt: new Date(Date.now() + 60_000) });
      const cookie = await signInAs(store, { subject: 'owner-1', orgId: org.id, role: 'owner' });
      const app = createInviteRoutes(buildDeps(store));

      const res = await app.request('/auth/invites/revoke', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ id: invite.id }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ revoked: true });
      expect(store.getInvite(invite.id)).toBeUndefined();
    });

    it('an org-A admin CANNOT revoke org B\'s invite — it answers revoked:false and org B keeps it', async () => {
      const store = await tempStore();
      const { org: orgA } = await store.createOrg({ name: 'Acme', slug: 'acme' });
      const { org: orgB } = await store.createOrg({ name: 'Beta', slug: 'beta' });
      const inviteB = await store.createInvite({ id: 'd'.repeat(64), orgId: orgB.id, role: 'member', expiresAt: new Date(Date.now() + 60_000) });
      const cookieA = await signInAs(store, { subject: 'owner-a', orgId: orgA.id, role: 'owner' });
      const app = createInviteRoutes(buildDeps(store));

      const res = await app.request('/auth/invites/revoke', {
        method: 'POST',
        headers: { cookie: cookieA, 'content-type': 'application/json' },
        body: JSON.stringify({ id: inviteB.id }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ revoked: false });
      // The cross-org attempt did not mutate org B's invite at all.
      expect(store.getInvite(inviteB.id)).toEqual(inviteB);
    });

    it('an unknown id answers revoked:false, indistinguishable from the cross-org case', async () => {
      const store = await tempStore();
      const { org } = await store.createOrg({ name: 'Acme', slug: 'acme' });
      const cookie = await signInAs(store, { subject: 'owner-1', orgId: org.id, role: 'owner' });
      const app = createInviteRoutes(buildDeps(store));

      const res = await app.request('/auth/invites/revoke', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'e'.repeat(64) }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ revoked: false });
    });
  });

  describe('POST /auth/invites/redeem', () => {
    it('401s with no session', async () => {
      const store = await tempStore();
      const app = createInviteRoutes(buildDeps(store));
      const res = await app.request('/auth/invites/redeem', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'x'.repeat(64) }),
      });
      expect(res.status).toBe(401);
    });

    it('404s a malformed token without ever reaching the store, same as a well-formed unknown one', async () => {
      const store = await tempStore();
      const cookie = await signInNoMembership(store, 'newbie');
      const app = createInviteRoutes(buildDeps(store));

      const malformed = await app.request('/auth/invites/redeem', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'not-hex' }),
      });
      expect(malformed.status).toBe(404);

      const unknown = await app.request('/auth/invites/redeem', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'f'.repeat(64) }),
      });
      expect(unknown.status).toBe(404);
      expect(await malformed.json()).toEqual(await unknown.json());
    });

    it('410s an expired invite, 409s an already-consumed one, 409s an existing membership', async () => {
      const store = await tempStore();
      const { org } = await store.createOrg({ name: 'Acme', slug: 'acme' });

      // Real, store-clock-relative timestamps — the store's own `now()` (unpinned here) is what
      // `redeemInvite` checks expiry against, not this route's injected `now`.
      const expired = await store.createInvite({ id: '1'.repeat(64), orgId: org.id, role: 'member', expiresAt: new Date(Date.now() - 60_000) });
      const consumable = await store.createInvite({ id: '2'.repeat(64), orgId: org.id, role: 'member', expiresAt: new Date(Date.now() + 60_000) });
      const alreadyMember = await store.createInvite({ id: '3'.repeat(64), orgId: org.id, role: 'admin', expiresAt: new Date(Date.now() + 60_000) });

      const app = createInviteRoutes(buildDeps(store));

      const expiredCookie = await signInNoMembership(store, 'user-expired');
      const expiredRes = await app.request('/auth/invites/redeem', {
        method: 'POST',
        headers: { cookie: expiredCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ token: expired.id }),
      });
      expect(expiredRes.status).toBe(410);

      const firstCookie = await signInNoMembership(store, 'user-first');
      await app.request('/auth/invites/redeem', {
        method: 'POST',
        headers: { cookie: firstCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ token: consumable.id }),
      });
      const secondCookie = await signInNoMembership(store, 'user-second');
      const consumedRes = await app.request('/auth/invites/redeem', {
        method: 'POST',
        headers: { cookie: secondCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ token: consumable.id }),
      });
      expect(consumedRes.status).toBe(409);

      const memberCookie = await signInAs(store, { subject: 'already-in-org', orgId: org.id, role: 'member' });
      const memberRes = await app.request('/auth/invites/redeem', {
        method: 'POST',
        headers: { cookie: memberCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ token: alreadyMember.id }),
      });
      expect(memberRes.status).toBe(409);
    });

    it('grants the invite\'s role in the invite\'s org, verified from a FRESH store instance', async () => {
      const store = await tempStore();
      const { org, defaultTeam } = await store.createOrg({ name: 'Acme', slug: 'acme' });
      const invite = await store.createInvite({
        id: '4'.repeat(64),
        orgId: org.id,
        teamId: defaultTeam.id,
        role: 'admin',
        expiresAt: new Date(Date.now() + 60_000),
      });
      const cookie = await signInNoMembership(store, 'new-admin');
      const app = createInviteRoutes(buildDeps(store));

      const res = await app.request('/auth/invites/redeem', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ token: invite.id }),
      });
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ orgId: org.id, teamId: defaultTeam.id, role: 'admin' });

      const reopened = IdentityStore.open(store.dir);
      const { user } = await reopened.findOrCreateUser({ issuer: 'https://idp.example.test', subject: 'new-admin' });
      expect(reopened.getMembership(user.id, org.id)?.role).toBe('admin');
    });

    it('THE RACE, at the HTTP layer: two simultaneous redeems of one invite produce exactly one 201', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'cezar-invites-'));
      dirs.push(dir);
      const seed = IdentityStore.open(dir);
      const { org } = await seed.createOrg({ name: 'Acme', slug: 'acme' });
      const invite = await seed.createInvite({ id: '5'.repeat(64), orgId: org.id, role: 'member', expiresAt: new Date(Date.now() + 60_000) });

      // Two SEPARATE store instances over the same directory, mirroring `identity-store.test.ts`'s
      // own race test — a single shared instance would prove nothing about the lease, only about
      // single-threaded JS ordering.
      const storeA = IdentityStore.open(dir, { lockRetryMs: 5 });
      const storeB = IdentityStore.open(dir, { lockRetryMs: 5 });
      const appA = createInviteRoutes(buildDeps(storeA));
      const appB = createInviteRoutes(buildDeps(storeB));
      const cookieA = await signInNoMembership(storeA, 'racer-a');
      const cookieB = await signInNoMembership(storeB, 'racer-b');

      const [resA, resB] = await Promise.all([
        appA.request('/auth/invites/redeem', {
          method: 'POST',
          headers: { cookie: cookieA, 'content-type': 'application/json' },
          body: JSON.stringify({ token: invite.id }),
        }),
        appB.request('/auth/invites/redeem', {
          method: 'POST',
          headers: { cookie: cookieB, 'content-type': 'application/json' },
          body: JSON.stringify({ token: invite.id }),
        }),
      ]);

      const statuses = [resA.status, resB.status].sort();
      expect(statuses).toEqual([201, 409]);
      expect(seed.listOrgMembers(org.id)).toHaveLength(1);
    });

    /**
     * ADDED 2026-08-07 (5b/5c/8 repair stage). This used to answer **201** with org B's id and the
     * invite's role — a grant `session.ts#resolveIdentity` could never honour, because it pins a
     * signed-in user to `listMemberships(userId)[0]` and there is no active-org switcher (F4) — and
     * stamped `consumedAt` in the same guarded write, so org B's owner could not re-send it. That
     * is the only outcome a multi-org host produces for any invitee who already belongs to an org,
     * and it is silent and lossy rather than a 4xx.
     *
     * The 409 is the smaller half of this test. The larger half is the two assertions after it: the
     * invite must be UNCONSUMED and still redeemable by an account with no org, which is what makes
     * this a refusal rather than a second way to destroy the credential.
     */
    it('409s a member of ANOTHER org — and leaves the invite unconsumed and still redeemable', async () => {
      const store = await tempStore();
      const { org: orgA } = await store.createOrg({ name: 'Acme', slug: 'acme' });
      const { org: orgB, defaultTeam: teamB } = await store.createOrg({ name: 'Beta', slug: 'beta' });
      const invite = await store.createInvite({
        id: '6'.repeat(64),
        orgId: orgB.id,
        teamId: teamB.id,
        role: 'owner',
        expiresAt: new Date(Date.now() + 60_000),
      });
      const mallory = await signInAs(store, { subject: 'mallory', orgId: orgA.id, role: 'member' });
      const app = createInviteRoutes(buildDeps(store));

      const res = await app.request('/auth/invites/redeem', {
        method: 'POST',
        headers: { cookie: mallory, 'content-type': 'application/json' },
        body: JSON.stringify({ token: invite.id }),
      });
      expect(res.status).toBe(409);

      // No membership was written, in EITHER org...
      const reopened = IdentityStore.open(store.dir);
      const { user } = await reopened.findOrCreateUser({ issuer: 'https://idp.example.test', subject: 'mallory' });
      expect(reopened.listMemberships(user.id).map((m) => m.orgId)).toEqual([orgA.id]);
      // ...and the single-use token was NOT burnt — the person it was for can still use it.
      expect(reopened.getInvite(invite.id)?.consumedAt).toBeUndefined();
      const intended = await signInNoMembership(store, 'orgb-owner');
      const second = await app.request('/auth/invites/redeem', {
        method: 'POST',
        headers: { cookie: intended, 'content-type': 'application/json' },
        body: JSON.stringify({ token: invite.id }),
      });
      expect(second.status).toBe(201);
      expect(await second.json()).toEqual({ orgId: orgB.id, teamId: teamB.id, role: 'owner' });
    });

    /**
     * ADDED 2026-08-07 (5b/5c/8 repair stage) — invariant 3's exact defect, one bar down from the
     * D12 gate. Redeem used to be `.post(path, jsonZodValidator(schema), handler)` with the
     * identity check as the handler's first statement, so an UNAUTHENTICATED stranger sending `{}`
     * got `400 {"error":"token: Invalid input: expected string, received undefined"}` — the request
     * schema, learned before any identity check, with their JSON body parsed first.
     * `auth-admin-routes.test.ts` could not see it: it drives `ADMIN_ONLY` routes only, and this
     * route is (correctly) classified `OPEN`.
     */
    it('401s BEFORE the body validator runs — a body satisfying no schema still answers 401, never 400', async () => {
      const store = await tempStore();
      const app = createInviteRoutes(buildDeps(store));
      for (const body of ['{}', '[]', JSON.stringify({ token: 123 })]) {
        const res = await app.request('/auth/invites/redeem', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        });
        expect([body, res.status]).toEqual([body, 401]);
      }
    });
  });
});
