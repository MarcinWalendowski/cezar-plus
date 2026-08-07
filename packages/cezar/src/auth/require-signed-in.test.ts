import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import { jsonZodValidator } from '../server/validators.ts';
import { IdentityStore } from './identity-store.ts';
import { createRequireSignedIn, getSignedInUser, resolveSignedInUser } from './require-signed-in.ts';
import { SessionService } from './session.ts';

/**
 * The LOWER `/auth/*` bar (`./require-signed-in.ts`), against a REAL `IdentityStore` and a REAL
 * `SessionService` — same discipline as `./require-org-admin.test.ts`, which covers the HIGHER
 * (D12) bar on the same family.
 *
 * Two properties, both of which were asserted only by a docblock before this file existed:
 *
 * 1. **Ordering** — the gate answers 401 without the route's `jsonZodValidator` ever running, so an
 *    unauthenticated caller cannot learn the request schema (invariant 3's defect, which shipped on
 *    `POST /auth/invites/redeem` and `POST /auth/onboarding/org`). Each of those routes has its own
 *    pin in its own suite; this one pins the MIDDLEWARE, so a route mounting it inherits the
 *    property rather than re-establishing it.
 * 2. **One cookie parse** — `invite-routes.ts` used to carry a byte-for-byte copy of
 *    `onboarding-routes.ts`'s private resolver, with a comment claiming they could not drift.
 *    Replacing the copy's parser with a FIRST-occurrence one left the entire suite green, while
 *    D3's own second correction exists because `getCookie` returns the first `cez_session` and
 *    `session.ts` returns the last. The duplicate-cookie case below is that missing control: it
 *    asserts this module and `SessionService` resolve the SAME user from a header carrying two
 *    `cez_session` values, so a divergence is a red test rather than an invisible identity split.
 */

const dirs: string[] = [];

async function tempStore(): Promise<IdentityStore> {
  const dir = await mkdtemp(join(tmpdir(), 'cezar-signed-in-'));
  dirs.push(dir);
  return IdentityStore.open(dir);
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function signIn(store: IdentityStore, subject: string): Promise<{ userId: string; cookie: string }> {
  const { user } = await store.findOrCreateUser({ issuer: 'https://idp.example.test', subject, email: `${subject}@example.test` });
  const service = SessionService.create(store, { authProvider: () => 'oidc' });
  const created = await service.createSession(user.id);
  return { userId: user.id, cookie: created.cookie.split(';')[0]! };
}

/** A route shaped exactly like the two production callers: gate first, validator second. */
function buildApp(store: IdentityStore): Hono {
  return new Hono().post(
    '/probe',
    createRequireSignedIn(store),
    jsonZodValidator(z.object({ required: z.string() })),
    (c) => c.json({ userId: getSignedInUser(c).userId }),
  );
}

describe('createRequireSignedIn', () => {
  it('401s an anonymous caller whose body satisfies no schema — authorization before validation', async () => {
    const store = await tempStore();
    const app = buildApp(store);
    for (const body of ['{}', '[]', JSON.stringify({ required: 42 })]) {
      const res = await app.request('/probe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      expect([body, res.status]).toEqual([body, 401]);
    }
  });

  it('401s a cookie that names no live session, and one whose user row is gone', async () => {
    const store = await tempStore();
    const app = buildApp(store);
    const unknown = await app.request('/probe', {
      method: 'POST',
      headers: { cookie: `cez_session=${'a'.repeat(64)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ required: 'x' }),
    });
    expect(unknown.status).toBe(401);

    const malformed = await app.request('/probe', {
      method: 'POST',
      headers: { cookie: 'cez_session=not-a-session-id', 'content-type': 'application/json' },
      body: JSON.stringify({ required: 'x' }),
    });
    expect(malformed.status).toBe(401);
  });

  it('admits a signed-in user WITH NO MEMBERSHIP — that is the whole point of this bar', async () => {
    const store = await tempStore();
    const { userId, cookie } = await signIn(store, 'orgless');
    expect(store.listMemberships(userId)).toEqual([]);

    const res = await buildApp(store).request('/probe', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ required: 'x' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId });
  });

  it('still runs the validator once the caller IS signed in — the gate does not swallow a 400', async () => {
    const store = await tempStore();
    const { cookie } = await signIn(store, 'orgless');
    const res = await buildApp(store).request('/probe', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(400);
  });

  /**
   * D3's second correction, as a control rather than a comment. RFC 6265 §5.4 lets whoever sets the
   * cookies choose the order, and D10's `CEZ_SESSION_COOKIE_DOMAIN=.<base>` makes a sibling
   * subdomain's cookie visible on every org host — so "which occurrence wins" is attacker-chosen,
   * and a route that grants an org membership (redeem) resolving a DIFFERENT user than
   * `/auth/me`/`requirePrincipal`/`verifyWsUpgrade` is the exact split D3 forbids. The assertion is
   * agreement with `SessionService`, not a specific occurrence: if the shared parser's rule ever
   * changes deliberately, both sides move together and this test still passes.
   */
  it('resolves the SAME user SessionService does from a header carrying two cez_session cookies', async () => {
    const store = await tempStore();
    const { org } = await store.createOrg({ name: 'Acme', slug: 'acme' });
    const alice = await signIn(store, 'alice');
    const bob = await signIn(store, 'bob');
    expect(alice.cookie).not.toBe(bob.cookie);
    // Both need a membership so `resolveFromCookieHeader` returns a PRINCIPAL rather than `null`:
    // a `null` on both sides would make this assertion vacuous, which is exactly the trap a
    // "they agree" test falls into when the shared value is absent.
    await store.createMembership({ userId: alice.userId, orgId: org.id, role: 'owner' });
    await store.createMembership({ userId: bob.userId, orgId: org.id, role: 'member' });
    const service = SessionService.create(store, { authProvider: () => 'oidc' });
    const app = buildApp(store);

    for (const [header, last] of [
      [`${alice.cookie}; ${bob.cookie}`, bob],
      [`${bob.cookie}; ${alice.cookie}`, alice],
    ] as const) {
      const res = await app.request('/probe', {
        method: 'POST',
        headers: { cookie: header, 'content-type': 'application/json' },
        body: JSON.stringify({ required: 'x' }),
      });
      expect(res.status).toBe(200);
      const gateUserId = ((await res.json()) as { userId: string }).userId;

      // The agreement that matters: the gate and D3's own resolver name ONE user for one header.
      // A first-occurrence parser on either side flips one of the two iterations and fails here.
      expect(gateUserId).toBe(service.resolveFromCookieHeader(header)?.userId);
      // ...and, concretely, that user is the LAST occurrence — `session.ts`'s documented rule,
      // stated so a silent flip of BOTH sides together is still a visible change.
      expect(gateUserId).toBe(last.userId);

      // The exported function agrees with the middleware, since they are one code path.
      const direct = resolveSignedInUser(
        { req: { header: (name: string) => (name === 'cookie' ? header : undefined) } } as never,
        store,
      );
      expect(direct?.userId).toBe(gateUserId);
    }
  });
});
