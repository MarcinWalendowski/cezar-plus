import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from '../server/server.ts';
import { apiRequest } from '../server/loopback-request.testkit.ts';
import { OidcClient, type OidcDiscoveryDocument, type OidcProvider, type ResolvedOidcConfig } from './oidc.ts';
import { IdentityStore } from './identity-store.ts';
import { SESSION_COOKIE_NAME, SessionService, logoutCookie } from './session.ts';
import { createAuthRoutes, type AuthRouteDeps } from './routes.ts';
import { createOnboardingRoutes } from './onboarding-routes.ts';
import { createTeamRoutes } from './team-routes.ts';
import { createRequireOrgAdminLocal, createRequireSignedInLocal, localSessionResolver } from './local-gates.ts';
import { invalidateLocalOrgIdentityCache } from './local-identity.ts';
import { identityDir } from '../paths.ts';

/**
 * `routes.ts`'s own responsibility, tested against the REAL `./oidc.ts` `OidcClient` (only its
 * network calls are faked, via `fetchImpl` — the protocol engine itself is a separate,
 * already-tested unit) and the REAL `./identity-store.ts` `IdentityStore` +
 * `./session.ts` `SessionService` (rooted at a throwaway temp directory, no fakes) — so this
 * suite exercises the actual wiring contract between all four units, not a hand-rolled stand-in
 * for what any of them do.
 */

// ---- a minimal, real RS256 identity provider, driven entirely by fakes ------------------------

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-key-1';
const testJwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid: KID, alg: 'RS256', use: 'sig' };

function b64url(input: string | Buffer): string {
  return (typeof input === 'string' ? Buffer.from(input, 'utf8') : input).toString('base64url');
}

/** Hand-signs an RS256 ID token — the same shape `verifyIdToken` (oidc.ts) expects, built here
 *  rather than through a library so this test introduces no new dependency. */
function signIdToken(payload: Record<string, unknown>): string {
  const header = { alg: 'RS256', kid: KID };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKey);
  return `${signingInput}.${b64url(signature)}`;
}

function defaultClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return { iss: config.issuer, aud: config.clientId, sub: 'user-abc', iat: now, exp: now + 300, ...overrides };
}

const config: ResolvedOidcConfig = {
  provider: 'oidc',
  issuer: 'https://idp.example.test',
  clientId: 'test-client',
  clientSecret: 'test-secret',
  redirectUri: 'https://cezar.example.test/auth/callback',
  scopes: ['openid', 'email', 'profile'],
  groupMapping: { claim: undefined, roles: new Map() },
};

const discovery: OidcDiscoveryDocument = {
  issuer: config.issuer,
  authorization_endpoint: 'https://idp.example.test/authorize',
  token_endpoint: 'https://idp.example.test/token',
  jwks_uri: 'https://idp.example.test/jwks',
};

// Node's global `fetch` types `input` as `string | URL | Request` — there is no `RequestInfo`
// in this package's `lib` (ES2022, no DOM; see tsconfig.json's own comment on why). `oidc.ts`
// sidesteps this entirely by casting its whole fake `as unknown as typeof fetch`; these two
// fakes are typed against the real signature instead so `requestUrl` stays a real, checked
// narrowing rather than an escape hatch.
function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/** A fake `fetch` answering only the two endpoints `OidcClient.completeAuthorization` reaches
 *  (token exchange, JWKS) — anything else throws, so a test that reaches an unexpected endpoint
 *  fails loudly instead of hanging on a real network call. */
function fakeFetch(idTokenFactory: () => string): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = requestUrl(input);
    if (url === discovery.token_endpoint) {
      return new Response(JSON.stringify({ id_token: idTokenFactory(), token_type: 'Bearer' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === discovery.jwks_uri) {
      return new Response(JSON.stringify({ keys: [testJwk] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;
}

function neverExchanges(): typeof fetch {
  return (async (input: string | URL | Request) => {
    throw new Error(`token exchange must not happen on this path — reached ${requestUrl(input)}`);
  }) as typeof fetch;
}

/**
 * A real `GET /auth/login`, returning everything the matching callback needs — including the
 * `cez_auth_state` cookie the browser would carry back. Reading it out of the response rather
 * than reconstructing it from `state` is deliberate: if `/auth/login` ever stops setting the
 * cookie, every callback test below fails, instead of them all quietly passing on a cookie the
 * test itself invented.
 */
async function loginAndGetStateAndNonce(
  app: ReturnType<typeof createAuthRoutes>,
): Promise<{ state: string; nonce: string; cookie: string }> {
  const res = await app.request('/auth/login');
  const url = new URL(res.headers.get('location')!);
  return {
    state: url.searchParams.get('state')!,
    nonce: url.searchParams.get('nonce')!,
    cookie: cookieFromSetCookie(res.headers.get('set-cookie')),
  };
}

/** `GET /auth/callback` carrying the state cookie, i.e. what a real browser sends. */
async function callback(
  app: ReturnType<typeof createAuthRoutes>,
  query: string,
  cookie: string,
): Promise<Response> {
  return app.request(`/auth/callback?${query}`, { headers: { cookie } });
}

function cookieFromSetCookie(setCookieHeader: string | null): string {
  expect(setCookieHeader).not.toBeNull();
  const first = setCookieHeader!.split(';')[0];
  expect(first).toBeDefined();
  return first!;
}

// ---- real IdentityStore + SessionService, fake only the OIDC network layer --------------------

const dirs: string[] = [];

async function tempStore(): Promise<IdentityStore> {
  const dir = await mkdtemp(join(tmpdir(), 'cezar-authroutes-'));
  dirs.push(dir);
  await mkdir(dir, { recursive: true });
  return IdentityStore.open(dir);
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface FakeDeps extends AuthRouteDeps {
  readonly logs: string[];
}

function buildDeps(oidc: OidcClient, store: IdentityStore, provider: OidcProvider = 'oidc'): FakeDeps {
  const service = SessionService.create(store, { authProvider: () => provider });
  const logs: string[] = [];
  return {
    provider,
    oidc,
    sessionResolver: { resolveFromCookieHeader: (header) => service.resolveFromCookieHeader(header) },
    findOrCreateUser: (input) => store.findOrCreateUser(input),
    createSession: (userId, ttlMs) => service.createSession(userId, ttlMs),
    destroySession: (sessionId) => service.destroySession(sessionId),
    logoutCookie,
    log: (message) => {
      logs.push(message);
    },
    logs,
  };
}

describe('createAuthRoutes', () => {
  describe('GET /auth/login', () => {
    it('redirects to the provider authorization endpoint with PKCE, state and nonce', async () => {
      const oidc = new OidcClient(config, discovery, { fetchImpl: neverExchanges() });
      const app = createAuthRoutes(buildDeps(oidc, await tempStore()));

      const res = await app.request('/auth/login');
      expect(res.status).toBe(302);
      const location = res.headers.get('location');
      expect(location).not.toBeNull();
      const url = new URL(location!);
      expect(url.origin + url.pathname).toBe(discovery.authorization_endpoint);
      expect(url.searchParams.get('client_id')).toBe(config.clientId);
      expect(url.searchParams.get('redirect_uri')).toBe(config.redirectUri);
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('state')).toBeTruthy();
      expect(url.searchParams.get('nonce')).toBeTruthy();
    });
  });

  describe('GET /auth/callback', () => {
    it('finds-or-creates the (issuer, subject) user, sets the session cookie, and redirects to /onboarding', async () => {
      const store = await tempStore();
      let nonce = '';
      const oidc = new OidcClient(config, discovery, {
        fetchImpl: fakeFetch(() => signIdToken(defaultClaims({ email: 'alice@example.test', name: 'Alice Example', nonce }))),
      });
      const app = createAuthRoutes(buildDeps(oidc, store));

      const login = await loginAndGetStateAndNonce(app);
      nonce = login.nonce;

      const res = await callback(app, `code=abc123&state=${encodeURIComponent(login.state)}`, login.cookie);
      expect(res.status).toBe(302);
      // `/onboarding`, not `/` (2026-08-07, repair stage): this redirect is the ONLY thing in
      // the product that points at the D8 wizard, so a first-ever user who lands on `/` instead
      // has a valid session, no membership, every `/api/v1/*` call 401ing, and no way to reach
      // the org-creation screen. An already-onboarded user is not detoured — the wizard reads
      // `hasProjects` off `GET /auth/onboarding` and navigates straight on.
      expect(res.headers.get('location')).toBe('/onboarding');
      expect(res.headers.get('set-cookie')).toContain(`${SESSION_COOKIE_NAME}=`);
      expect(res.headers.get('set-cookie')).toContain('HttpOnly');

      const user = store.getUserByIssuerSubject(config.issuer, 'user-abc');
      expect(user).toBeDefined();
      expect(user?.email).toBe('alice@example.test');
      expect(user?.name).toBe('Alice Example');
    });

    it("a user with no org membership yet gets a real session, but /auth/me reports 401 — D8 onboarding is out of this unit's scope", async () => {
      const store = await tempStore();
      let nonce = '';
      const oidc = new OidcClient(config, discovery, {
        fetchImpl: fakeFetch(() => signIdToken(defaultClaims({ nonce }))),
      });
      const app = createAuthRoutes(buildDeps(oidc, store));

      const login = await loginAndGetStateAndNonce(app);
      nonce = login.nonce;
      const callbackRes = await callback(app, `code=abc&state=${encodeURIComponent(login.state)}`, login.cookie);
      const cookie = cookieFromSetCookie(callbackRes.headers.get('set-cookie'));

      const meRes = await app.request('/auth/me', { headers: { cookie } });
      expect(meRes.status).toBe(401);
      expect(await meRes.json()).toEqual({ error: 'unauthenticated' });
    });

    it('an invited user (pre-existing org membership) gets a fully-resolved principal from /auth/me', async () => {
      const store = await tempStore();
      const { org, defaultTeam } = await store.createOrg({ name: 'Acme', slug: 'acme' });
      const { user } = await store.findOrCreateUser({ issuer: config.issuer, subject: 'user-existing', email: 'bob@acme.test' });
      await store.createMembership({ userId: user.id, orgId: org.id, role: 'member' });

      let nonce = '';
      const oidc = new OidcClient(config, discovery, {
        fetchImpl: fakeFetch(() => signIdToken(defaultClaims({ sub: 'user-existing', email: 'bob@acme.test', nonce }))),
      });
      const app = createAuthRoutes(buildDeps(oidc, store));

      const login = await loginAndGetStateAndNonce(app);
      nonce = login.nonce;
      const callbackRes = await callback(app, `code=abc&state=${encodeURIComponent(login.state)}`, login.cookie);
      const cookie = cookieFromSetCookie(callbackRes.headers.get('set-cookie'));

      const meRes = await app.request('/auth/me', { headers: { cookie } });
      expect(meRes.status).toBe(200);
      expect(await meRes.json()).toEqual({
        principal: { kind: 'session', userId: user.id, orgId: org.id, teamId: defaultTeam.id, role: 'member' },
      });
    });

    it('logging in twice with the same (issuer, subject) reuses the same user row', async () => {
      const store = await tempStore();
      let nonce = '';
      const oidc = new OidcClient(config, discovery, {
        fetchImpl: fakeFetch(() => signIdToken(defaultClaims({ sub: 'user-repeat', nonce }))),
      });
      const app = createAuthRoutes(buildDeps(oidc, store));

      const first = await loginAndGetStateAndNonce(app);
      nonce = first.nonce;
      await callback(app, `code=c1&state=${encodeURIComponent(first.state)}`, first.cookie);
      const firstId = store.getUserByIssuerSubject(config.issuer, 'user-repeat')?.id;
      expect(firstId).toBeDefined();

      const second = await loginAndGetStateAndNonce(app);
      nonce = second.nonce;
      await callback(app, `code=c2&state=${encodeURIComponent(second.state)}`, second.cookie);
      const secondId = store.getUserByIssuerSubject(config.issuer, 'user-repeat')?.id;
      expect(secondId).toBe(firstId);
    });

    it('rejects an unknown/mismatched state without ever exchanging the code or creating a user', async () => {
      const store = await tempStore();
      const oidc = new OidcClient(config, discovery, { fetchImpl: neverExchanges() });
      const app = createAuthRoutes(buildDeps(oidc, store));

      await app.request('/auth/login'); // seeds a real pending state we deliberately ignore below

      // The state cookie MATCHES the query `state` here, so the browser-binding check passes and
      // the request really does reach `completeAuthorization` — which is the thing this test is
      // about. Without the matching cookie it would 400 one check earlier and assert nothing
      // about the pending-state lookup at all.
      const res = await callback(app, 'code=xyz&state=not-a-real-state', 'cez_auth_state=not-a-real-state');
      expect(res.status).toBe(400);
      // No SESSION cookie. The response does carry a `set-cookie`, but only the one clearing the
      // now-spent `cez_auth_state` — asserting `toBeNull()` here would have failed for that, which
      // is a different (and harmless) fact from the one this test cares about.
      expect(res.headers.get('set-cookie')).not.toContain(`${SESSION_COOKIE_NAME}=`);
      expect(store.getUserByIssuerSubject(config.issuer, 'user-abc')).toBeUndefined();
    });

    // ---- login CSRF / session fixation: `state` must be bound to THIS browser ------------------
    //
    // `state` on its own lives only in the server's in-process pending map, so it says "some
    // browser started this flow", never "the browser presenting this callback did". The attack
    // that exploits the gap: start the flow yourself, sign in at the IdP as YOURSELF, then send
    // the victim the resulting callback URL — `SameSite=Lax` allows the cookie-setting response
    // to a cross-site top-level GET navigation, so the victim ends up signed in as the attacker.
    // These three assert the cookie binding that closes it; the fourth is the negative control on
    // the `/auth/login` half, since a missing cookie there would silently make the check
    // unreachable rather than failing anything.
    it('refuses a callback whose state has no matching cookie — a URL alone cannot sign anyone in', async () => {
      const store = await tempStore();
      const oidc = new OidcClient(config, discovery, { fetchImpl: neverExchanges() });
      const deps = buildDeps(oidc, store);
      const app = createAuthRoutes(deps);

      // A REAL, live login started by the attacker's browser — the pending state exists and would
      // otherwise complete. The only thing missing is the victim's own state cookie.
      const attackerLogin = await loginAndGetStateAndNonce(app);

      const res = await app.request(`/auth/callback?code=abc&state=${encodeURIComponent(attackerLogin.state)}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'authentication failed' });
      // No session minted, and nothing about the failure leaks to the caller beyond the generic body.
      expect(res.headers.get('set-cookie')).not.toContain(`${SESSION_COOKIE_NAME}=`);
      expect(deps.logs.join('\n')).toContain('no state cookie');
      // `neverExchanges` would have thrown; assert the intent directly too — the code must never
      // reach the token endpoint on this path.
      expect(store.getUserByIssuerSubject(config.issuer, 'user-abc')).toBeUndefined();
    });

    it('refuses a callback whose state cookie belongs to a DIFFERENT flow', async () => {
      const store = await tempStore();
      const oidc = new OidcClient(config, discovery, { fetchImpl: neverExchanges() });
      const deps = buildDeps(oidc, store);
      const app = createAuthRoutes(deps);

      const attackerLogin = await loginAndGetStateAndNonce(app);
      const victimLogin = await loginAndGetStateAndNonce(app);
      expect(victimLogin.cookie).not.toBe(attackerLogin.cookie);

      // The victim's browser presents its OWN cookie against the attacker's `state`.
      const res = await callback(app, `code=abc&state=${encodeURIComponent(attackerLogin.state)}`, victimLogin.cookie);
      expect(res.status).toBe(400);
      expect(deps.logs.join('\n')).toContain('cookie/query mismatch');
      expect(store.getUserByIssuerSubject(config.issuer, 'user-abc')).toBeUndefined();
    });

    it('leaves the rejected flow completable by the browser that actually started it', async () => {
      // The mismatch path must NOT consume the pending entry: a victim's browser stumbling into
      // someone else's callback would otherwise log the real user out of their own in-flight
      // login. Also the reason the check runs before `completeAuthorization`, not after.
      const store = await tempStore();
      let nonce = '';
      const oidc = new OidcClient(config, discovery, {
        fetchImpl: fakeFetch(() => signIdToken(defaultClaims({ sub: 'user-survivor', nonce }))),
      });
      const app = createAuthRoutes(buildDeps(oidc, store));

      const login = await loginAndGetStateAndNonce(app);
      nonce = login.nonce;

      const spoofed = await app.request(`/auth/callback?code=abc&state=${encodeURIComponent(login.state)}`);
      expect(spoofed.status).toBe(400);

      const real = await callback(app, `code=abc&state=${encodeURIComponent(login.state)}`, login.cookie);
      expect(real.status).toBe(302);
      expect(store.getUserByIssuerSubject(config.issuer, 'user-survivor')).toBeDefined();
    });

    it('GET /auth/login sets the state cookie the callback checks — HttpOnly, and equal to the state it issued', async () => {
      const oidc = new OidcClient(config, discovery, { fetchImpl: neverExchanges() });
      const app = createAuthRoutes(buildDeps(oidc, await tempStore()));

      const res = await app.request('/auth/login');
      const setCookie = res.headers.get('set-cookie');
      expect(setCookie).toContain('HttpOnly');
      // Lax, not Strict: the callback arrives as a cross-site top-level navigation FROM the IdP,
      // and a Strict cookie would not be sent with it — breaking every legitimate login.
      expect(setCookie).toContain('SameSite=Lax');
      const issuedState = new URL(res.headers.get('location')!).searchParams.get('state');
      expect(cookieFromSetCookie(setCookie)).toBe(`cez_auth_state=${issuedState}`);
    });

    it('rejects a replayed state — the same state used twice succeeds at most once', async () => {
      const store = await tempStore();
      let nonce = '';
      const oidc = new OidcClient(config, discovery, {
        fetchImpl: fakeFetch(() => signIdToken(defaultClaims({ sub: 'user-replay', nonce }))),
      });
      const app = createAuthRoutes(buildDeps(oidc, store));

      const login = await loginAndGetStateAndNonce(app);
      nonce = login.nonce;

      const first = await callback(app, `code=abc&state=${encodeURIComponent(login.state)}`, login.cookie);
      expect(first.status).toBe(302);
      const second = await callback(app, `code=abc&state=${encodeURIComponent(login.state)}`, login.cookie);
      expect(second.status).toBe(400);
    });

    it('rejects a provider-side error redirect without attempting an exchange', async () => {
      const store = await tempStore();
      const oidc = new OidcClient(config, discovery, { fetchImpl: neverExchanges() });
      const app = createAuthRoutes(buildDeps(oidc, store));

      const res = await app.request('/auth/callback?error=access_denied&error_description=user+declined');
      expect(res.status).toBe(400);
      expect(res.headers.get('set-cookie')).toBeNull();
    });

    it.each([
      ['/auth/callback', 'neither code nor state'],
      ['/auth/callback?code=abc', 'state only missing'],
      ['/auth/callback?state=xyz', 'code only missing'],
    ])('rejects a callback with %s (%s)', async (path) => {
      const store = await tempStore();
      const oidc = new OidcClient(config, discovery, { fetchImpl: neverExchanges() });
      const app = createAuthRoutes(buildDeps(oidc, store));
      const res = await app.request(path);
      expect(res.status).toBe(400);
    });

    it('rejects a tampered ID token signature — a valid state is not enough on its own', async () => {
      const store = await tempStore();
      const otherKeyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
      let nonce = '';
      const oidc = new OidcClient(config, discovery, {
        fetchImpl: fakeFetch(() => {
          const header = { alg: 'RS256', kid: KID };
          const payload = defaultClaims({ sub: 'user-forged', nonce });
          const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
          // Signed with a DIFFERENT private key than the one `testJwk` (the JWKS the client
          // fetches) actually corresponds to — the signature must fail verification.
          const signature = createSign('RSA-SHA256').update(signingInput).sign(otherKeyPair.privateKey);
          return `${signingInput}.${b64url(signature)}`;
        }),
      });
      const app = createAuthRoutes(buildDeps(oidc, store));

      const login = await loginAndGetStateAndNonce(app);
      nonce = login.nonce;

      const res = await callback(app, `code=abc&state=${encodeURIComponent(login.state)}`, login.cookie);
      expect(res.status).toBe(400);
      expect(store.getUserByIssuerSubject(config.issuer, 'user-forged')).toBeUndefined();
    });
  });

  describe('POST /auth/logout', () => {
    it('destroys the server-side session and clears the cookie', async () => {
      const store = await tempStore();
      const { user } = await store.findOrCreateUser({ issuer: config.issuer, subject: 'user-1' });
      const oidc = new OidcClient(config, discovery, { fetchImpl: neverExchanges() });
      const deps = buildDeps(oidc, store);
      const app = createAuthRoutes(deps);
      const created = await deps.createSession(user.id);
      const cookie = cookieFromSetCookie(created.cookie);

      const res = await app.request('/auth/logout', { method: 'POST', headers: { cookie } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(res.headers.get('set-cookie')).toContain('Max-Age=0');

      // Server-side invalidated, not just the cookie cleared client-side.
      expect(deps.sessionResolver.resolveFromCookieHeader(cookie)).toBeNull();
    });

    it('is a safe no-op when no session cookie is present', async () => {
      const store = await tempStore();
      const oidc = new OidcClient(config, discovery, { fetchImpl: neverExchanges() });
      const app = createAuthRoutes(buildDeps(oidc, store));

      const res = await app.request('/auth/logout', { method: 'POST' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });
  });

  describe('GET /auth/me', () => {
    it('answers 401 with no session', async () => {
      const store = await tempStore();
      const oidc = new OidcClient(config, discovery, { fetchImpl: neverExchanges() });
      const app = createAuthRoutes(buildDeps(oidc, store));

      const res = await app.request('/auth/me');
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthenticated' });
    });

    it('401s once the session has been logged out', async () => {
      const store = await tempStore();
      const { org, defaultTeam } = await store.createOrg({ name: 'Acme', slug: 'acme' });
      const { user } = await store.findOrCreateUser({ issuer: config.issuer, subject: 'user-1' });
      await store.createMembership({ userId: user.id, orgId: org.id, role: 'owner' });
      void defaultTeam;
      const oidc = new OidcClient(config, discovery, { fetchImpl: neverExchanges() });
      const deps = buildDeps(oidc, store);
      const app = createAuthRoutes(deps);
      const created = await deps.createSession(user.id);
      const cookie = cookieFromSetCookie(created.cookie);

      expect((await app.request('/auth/me', { headers: { cookie } })).status).toBe(200);
      await app.request('/auth/logout', { method: 'POST', headers: { cookie } });
      expect((await app.request('/auth/me', { headers: { cookie } })).status).toBe(401);
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
    home = mkdtempSync(join(tmpdir(), 'cez-authroutes-home-'));
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-authroutes-repo-'));
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

  const makeApp = (authRoutes?: ReturnType<typeof createAuthRoutes>) =>
    createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', authRoutes });

  // CORRECTED 2026-08-07 (D13, phase 9 HTTP surface): this title used to read "...(the
  // CEZ_AUTH=none shape, D1)". No longer accurate on its own — `CEZ_AUTH` unset no longer implies
  // NOTHING under `/auth/*` is wired (D13's local mode wires `onboardingRoutes`/`teamRoutes` with
  // `CEZ_AUTH` still unset). What is still true, and what the `local mode` case just below proves
  // directly rather than leaving implied, is D13's own claim: "authRoutes... and inviteRoutes stay
  // unmounted locally — there is nothing to log into and no second user to invite."
  it('registers no /auth/* route at all when authRoutes is absent (deps-absence, not an auth-mode signature)', async () => {
    const app = makeApp(undefined);
    // Two different "nothing is registered here" signatures, because `server.ts`'s own SPA
    // catch-all (`routed.get('*', ...)`, line ~5320) is a GET-only fallback that answers 200
    // with the client shell for ANY unmatched GET path — including `/auth/login` when this
    // file's routes are absent, exactly as it would for `/some-typo` or any other client-side
    // route today. That is pre-existing, correct behaviour (Phase 1's own bar is "byte-identical
    // to today"), not a hole this test can paper over by asserting a 404 the server never sends.
    //
    // A POST has no such fallback (the catch-all only registers `.get`), so `POST /auth/logout`
    // with no authRoutes wired IS a genuine, un-shadowed 404 — that's the assertion that actually
    // proves nothing is registered under this method+path.
    const postRes = await apiRequest(app, '/auth/logout', { method: 'POST', headers: { origin: 'http://127.0.0.1:4321' } });
    expect(postRes.status).toBe(404);

    // For the GET paths, prove absence a different way: the response is the SPA shell (or its
    // dev "build the cockpit" fallback), never this file's JSON — so a reader can tell a real
    // `/auth/me` (401 JSON `{error:'unauthenticated'}`) apart from an unwired one (200 HTML) at a
    // glance, which is the actual, observable difference "no route registered" produces here.
    for (const path of ['/auth/login', '/auth/callback', '/auth/me'] as const) {
      const res = await apiRequest(app, path, { method: 'GET' });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
    }
  });

  // ---- D13 local mode: the shape that makes the title correction above meaningful ---------------
  //
  // `onboardingRoutes`/`teamRoutes` ARE wired here — `CEZ_AUTH` still unset — proving `authRoutes`'
  // absence is D13's deliberate choice ("there is nothing to log into... locally"), not a side
  // effect of nothing under `/auth/*` being mounted at all.
  it('D13: authRoutes stays absent in local mode even though onboardingRoutes/teamRoutes are wired', async () => {
    invalidateLocalOrgIdentityCache();
    const identityStore = IdentityStore.open(identityDir());
    const app = createApp({
      repoRoot,
      store,
      manager: {} as RunManager,
      version: '0.0.0-test',
      // authRoutes: deliberately omitted — D13's own claim under test.
      onboardingRoutes: createOnboardingRoutes({
        sessionResolver: localSessionResolver,
        identityStore,
        bootstrapClaim: { required: false, mode: 'open' },
        localSignedInGate: createRequireSignedInLocal(identityStore),
        localOrgAdminGate: createRequireOrgAdminLocal(localSessionResolver),
      }),
      teamRoutes: createTeamRoutes({
        sessionResolver: localSessionResolver,
        identityStore,
        localOrgAdminGate: createRequireOrgAdminLocal(localSessionResolver),
      }),
    });

    // The onboarding surface actually works, with no session, no cookie, no bootstrap code.
    const onboarding = await apiRequest(app, '/auth/onboarding');
    expect(onboarding.status).toBe(200);
    expect(await onboarding.json()).toEqual({ state: 'needs-org', bootstrapTokenRequired: false });

    // ...while every authRoutes path answers exactly like the "absent" case above: no login, no
    // callback, no logout, no second-user invite surface, all with CEZ_AUTH still unset.
    const postRes = await apiRequest(app, '/auth/logout', { method: 'POST', headers: { origin: 'http://127.0.0.1:4321' } });
    expect(postRes.status).toBe(404);
    for (const path of ['/auth/login', '/auth/callback', '/auth/me'] as const) {
      const res = await apiRequest(app, path, { method: 'GET' });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
    }
  });

  it('reaches every /auth/* route once authRoutes is wired — mounted at the app ROOT, not under /api/v1', async () => {
    const identity = await tempStore();
    const oidc = new OidcClient(config, discovery, { fetchImpl: neverExchanges() });
    const app = makeApp(createAuthRoutes(buildDeps(oidc, identity)));

    // Through `apiRequest`, i.e. carrying a loopback Host — because `/auth/*` now sits behind the
    // SAME #426 origin guard `/api/*` does (it was mounted outside it, leaving `POST /auth/logout`
    // as the only unguarded write in the app). Two dedicated tests below assert that directly.
    expect((await apiRequest(app, '/auth/login')).status).toBe(302);
    // 401, not 404: the route exists and ran, it just has no session — the opposite failure mode
    // from the "absent" case above.
    expect((await apiRequest(app, '/auth/me')).status).toBe(401);
    expect(
      (await apiRequest(app, '/auth/logout', { method: 'POST', headers: { origin: 'http://127.0.0.1:4321' } })).status,
    ).toBe(200);
  });

  // ---- /auth/* is INSIDE the #426 perimeter ---------------------------------------------------
  //
  // The auth family is mounted at the app root (D5), and the origin guard was registered on
  // `/api/*` only — so `/auth/*` was the one route family in the app with neither the loopback-Host
  // allowlist nor the same-origin write guard. `POST /auth/logout` was therefore the only write a
  // foreign page could author: `SameSite=Lax` still sends the session cookie to a page on another
  // LOOPBACK PORT (same-site, different origin), which is exactly the case the guard's own comment
  // says it exists for — "on a dev machine `http://localhost:3000` is every bit as foreign as
  // `https://evil.tld`".
  it('rejects a cross-origin POST /auth/logout — the same-origin write guard covers /auth/* too', async () => {
    const identity = await tempStore();
    const oidc = new OidcClient(config, discovery, { fetchImpl: neverExchanges() });
    const app = makeApp(createAuthRoutes(buildDeps(oidc, identity)));

    const res = await apiRequest(app, '/auth/logout', {
      method: 'POST',
      headers: { origin: 'http://localhost:3000' },
    });
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: string }).toEqual({
      error: 'forbidden: cross-origin request rejected (same-origin only)',
    });
  });

  it('rejects a rebound Host on /auth/login — the loopback allowlist covers /auth/* too', async () => {
    const identity = await tempStore();
    const oidc = new OidcClient(config, discovery, { fetchImpl: neverExchanges() });
    const app = makeApp(createAuthRoutes(buildDeps(oidc, identity)));

    // Would otherwise 302 straight to the IdP with a `state` the attacker's page then owns.
    const res = await app.request('/auth/login', { headers: { host: 'evil.tld' } });
    expect(res.status).toBe(403);
  });
});

// ---- the real module-scope singleton: config resolution actually gates the routes -------------

describe('the real authRoutes singleton (buildAuthRoutes)', () => {
  const keys = ['CEZ_AUTH', 'CEZ_PUBLIC_URL', 'CEZ_OIDC_ISSUER', 'CEZ_OIDC_CLIENT_ID', 'CEZ_OIDC_CLIENT_SECRET'] as const;
  const saved: Partial<Record<(typeof keys)[number], string>> = {};

  beforeEach(() => {
    for (const key of keys) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('degrades every route to 500 "misconfigured" — naming the exact missing setting — rather than crashing the import', async () => {
    process.env.CEZ_AUTH = 'oidc';
    // CEZ_PUBLIC_URL, CEZ_OIDC_ISSUER, CEZ_OIDC_CLIENT_ID, CEZ_OIDC_CLIENT_SECRET all stay unset.
    const printed: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((message: unknown) => {
      printed.push(String(message));
    });
    vi.resetModules();
    try {
      const fresh = await import('./routes.ts');
      const res = await fresh.authRoutes.request('/auth/login');
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain('CEZ_PUBLIC_URL');
      // Printed once at import time too — "fail loudly ... rather than at first login" (the
      // spec's own Risk item), not only inside the response body of a request nobody made yet.
      expect(printed.some((line) => line.includes('CEZ_PUBLIC_URL'))).toBe(true);
    } finally {
      spy.mockRestore();
      vi.resetModules();
    }
  });
});
