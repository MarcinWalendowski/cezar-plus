import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  AUTH_CALLBACK_PATH,
  JwksCache,
  OidcClient,
  buildAuthorizationUrl,
  discoverOidcConfiguration,
  mapGroupsToRole,
  resolveOidcConfig,
  verifyIdToken,
  type OidcDiscoveryDocument,
  type ResolvedOidcConfig,
} from './oidc.ts';

/**
 * `oidc.ts` (D9, `.ai/specs/2026-08-06-org-team-auth-onboarding.md`). No test here performs live
 * network I/O - every call passes an explicit `fetchImpl` reading an in-memory `Response`, the
 * same discipline `sources/notion/client.test.ts` and `knowledge/embeddings.test.ts` use. ID
 * tokens are real, signed JWTs (RS256, one RSA keypair generated once below) verified through the
 * module's actual signature-checking code path, not hand-waved past it.
 */

// ---- shared fixtures --------------------------------------------------------------------------

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const { publicKey: otherPublicKey, privateKey: otherPrivateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-key-1';

const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, string>), kid: KID, use: 'sig', alg: 'RS256' };
const jwksBody = { keys: [jwk] };

const ISSUER = 'https://idp.example.com';
const CLIENT_ID = 'client-abc';
const FIXED_NOW = Date.parse('2026-08-06T12:00:00Z');

const discovery: OidcDiscoveryDocument = {
  issuer: ISSUER,
  authorization_endpoint: 'https://idp.example.com/authorize',
  token_endpoint: 'https://idp.example.com/token',
  jwks_uri: 'https://idp.example.com/jwks',
};

function testConfig(overrides: Partial<ResolvedOidcConfig> = {}): ResolvedOidcConfig {
  return {
    provider: 'oidc',
    issuer: ISSUER,
    clientId: CLIENT_ID,
    clientSecret: 'client-secret',
    redirectUri: 'https://cezar.example.com' + AUTH_CALLBACK_PATH,
    scopes: ['openid', 'email', 'profile'],
    groupMapping: { claim: undefined, roles: new Map() },
    ...overrides,
  };
}

function baseClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const nowSec = Math.floor(FIXED_NOW / 1000);
  return {
    iss: ISSUER,
    aud: CLIENT_ID,
    sub: 'user-123',
    email: 'user@example.com',
    name: 'Test User',
    iat: nowSec - 5,
    exp: nowSec + 3600,
    nonce: 'expected-nonce',
    ...overrides,
  };
}

/** Signs a real RS256 JWT. `key` defaults to the keypair published in `jwksBody` under `KID`;
 *  passing `otherPrivateKey` produces a token whose signature won't verify against that key -
 *  exactly the "tampered / wrong key" shape a forged token would have. */
function signJwt(claims: Record<string, unknown>, opts: { kid?: string; alg?: string; key?: KeyObject } = {}): string {
  const header = { alg: opts.alg ?? 'RS256', kid: opts.kid ?? KID, typ: 'JWT' };
  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = cryptoSign('RSA-SHA256', Buffer.from(signingInput), opts.key ?? privateKey);
  return `${signingInput}.${signature.toString('base64url')}`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/** Routes a fake `fetch` to `jwks`/`token` handlers by URL substring; anything else throws so an
 *  unexpected extra HTTP call fails the test that triggered it rather than hanging or 404ing. */
function makeFetch(handlers: { jwks?: () => Response; token?: () => Response }): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = urlOf(input);
    if (url.includes('/jwks') && handlers.jwks) return handlers.jwks();
    if (url.includes('/token') && handlers.token) return handlers.token();
    throw new Error(`unexpected fetch to ${url}`);
  }) as unknown as typeof fetch;
}

// ---- resolveOidcConfig --------------------------------------------------------------------

describe('resolveOidcConfig', () => {
  const validEnv = {
    CEZ_PUBLIC_URL: 'https://cezar.example.com',
    CEZ_OIDC_CLIENT_ID: 'client-abc',
    CEZ_OIDC_CLIENT_SECRET: 'secret-xyz',
    CEZ_OIDC_ISSUER: 'https://kc.example.com/realms/cezar',
  };

  it('resolves a valid generic OIDC config, deriving redirect_uri from CEZ_PUBLIC_URL', () => {
    const result = resolveOidcConfig('oidc', validEnv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.issuer).toBe('https://kc.example.com/realms/cezar');
    expect(result.config.redirectUri).toBe(`https://cezar.example.com${AUTH_CALLBACK_PATH}`);
    expect(result.config.clientId).toBe('client-abc');
  });

  it('pins the issuer to Google and ignores CEZ_OIDC_ISSUER for provider "google"', () => {
    const result = resolveOidcConfig('google', { ...validEnv, CEZ_OIDC_ISSUER: 'https://not-google.example.com' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.issuer).toBe('https://accounts.google.com');
  });

  it('rejects when CEZ_PUBLIC_URL is missing', () => {
    const { CEZ_PUBLIC_URL: _drop, ...env } = validEnv;
    const result = resolveOidcConfig('oidc', env);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/CEZ_PUBLIC_URL/);
  });

  it('rejects when CEZ_PUBLIC_URL is not a valid absolute URL', () => {
    const result = resolveOidcConfig('oidc', { ...validEnv, CEZ_PUBLIC_URL: 'not-a-url' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/CEZ_PUBLIC_URL/);
  });

  it('rejects when CEZ_OIDC_CLIENT_ID is missing', () => {
    const { CEZ_OIDC_CLIENT_ID: _drop, ...env } = validEnv;
    const result = resolveOidcConfig('oidc', env);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/CEZ_OIDC_CLIENT_ID/);
  });

  it('rejects when CEZ_OIDC_ISSUER is missing for provider "oidc"', () => {
    const { CEZ_OIDC_ISSUER: _drop, ...env } = validEnv;
    const result = resolveOidcConfig('oidc', env);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/CEZ_OIDC_ISSUER/);
  });

  it('parses CEZ_OIDC_GROUP_ROLE_MAP, dropping malformed entries and any "owner" mapping', () => {
    const result = resolveOidcConfig('oidc', {
      ...validEnv,
      CEZ_OIDC_GROUP_CLAIM: 'groups',
      CEZ_OIDC_GROUP_ROLE_MAP: 'cezar-admins=admin,cezar-members=member,cezar-owners=owner,garbage,=member',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.groupMapping.claim).toBe('groups');
    expect(result.config.groupMapping.roles.get('cezar-admins')).toBe('admin');
    expect(result.config.groupMapping.roles.get('cezar-members')).toBe('member');
    // D8: owner is granted once, structurally, to the org creator - never via a group claim.
    expect(result.config.groupMapping.roles.has('cezar-owners')).toBe(false);
    expect(result.config.groupMapping.roles.size).toBe(2);
  });

  it('leaves group mapping disabled (claim undefined) when CEZ_OIDC_GROUP_CLAIM is unset', () => {
    const result = resolveOidcConfig('oidc', validEnv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.groupMapping.claim).toBeUndefined();
  });
});

// ---- discoverOidcConfiguration -------------------------------------------------------------

describe('discoverOidcConfiguration', () => {
  it('fetches <issuer>/.well-known/openid-configuration and returns the document', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      expect(urlOf(input)).toBe(`${ISSUER}/.well-known/openid-configuration`);
      return jsonResponse(discovery);
    }) as unknown as typeof fetch;
    const result = await discoverOidcConfiguration(ISSUER, fetchImpl);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.document.token_endpoint).toBe(discovery.token_endpoint);
  });

  it('rejects when the document\'s issuer does not match the requested issuer', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ...discovery, issuer: 'https://someone-else.example.com' })) as unknown as typeof fetch;
    const result = await discoverOidcConfiguration(ISSUER, fetchImpl);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/issuer/i);
  });
});

// ---- buildAuthorizationUrl ------------------------------------------------------------------

describe('buildAuthorizationUrl', () => {
  it('includes PKCE, state and nonce parameters', () => {
    const url = new URL(
      buildAuthorizationUrl(discovery, testConfig(), { state: 'state-1', nonce: 'nonce-1', codeChallenge: 'challenge-1' }),
    );
    expect(url.origin + url.pathname).toBe(discovery.authorization_endpoint);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('state')).toBe('state-1');
    expect(url.searchParams.get('nonce')).toBe('nonce-1');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-1');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
  });
});

// ---- JwksCache ------------------------------------------------------------------------------

describe('JwksCache', () => {
  it('fetches once and serves a known kid from cache on subsequent calls', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(jwksBody)) as unknown as typeof fetch;
    const cache = new JwksCache(discovery.jwks_uri, { fetchImpl, now: () => new Date(FIXED_NOW) });
    await cache.getKey(KID);
    await cache.getKey(KID);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('an unknown kid triggers exactly one refetch and then fails closed', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(jwksBody)) as unknown as typeof fetch;
    const cache = new JwksCache(discovery.jwks_uri, { fetchImpl, now: () => new Date(FIXED_NOW) });

    await cache.getKey(KID); // primes the cache - fetch #1
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await expect(cache.getKey('unknown-kid')).rejects.toThrow(/unknown-kid/);
    // Exactly one additional fetch for the miss (fetch #2), not a retry storm.
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // A second lookup for the same still-unknown kid does not loop further within this window -
    // it refetches once again (key rotation could have happened) and fails closed, same as above.
    await expect(cache.getKey('unknown-kid')).rejects.toThrow(/unknown-kid/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('refreshes past its TTL even for an already-known kid', async () => {
    let now = FIXED_NOW;
    const fetchImpl = vi.fn(async () => jsonResponse(jwksBody)) as unknown as typeof fetch;
    const cache = new JwksCache(discovery.jwks_uri, { fetchImpl, now: () => new Date(now), ttlMs: 1_000 });
    await cache.getKey(KID);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    now += 2_000; // past the 1s TTL
    await cache.getKey(KID);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

// ---- verifyIdToken --------------------------------------------------------------------------

describe('verifyIdToken', () => {
  function jwks(): JwksCache {
    return new JwksCache(discovery.jwks_uri, { fetchImpl: makeFetch({ jwks: () => jsonResponse(jwksBody) }), now: () => new Date(FIXED_NOW) });
  }

  it('accepts a correctly signed token with matching claims and nonce', async () => {
    const idToken = signJwt(baseClaims());
    const result = await verifyIdToken({
      idToken,
      issuer: ISSUER,
      clientId: CLIENT_ID,
      expectedNonce: 'expected-nonce',
      jwks: jwks(),
      now: () => new Date(FIXED_NOW),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims.sub).toBe('user-123');
  });

  it('rejects an unsupported algorithm (alg-confusion guard)', async () => {
    const idToken = signJwt(baseClaims(), { alg: 'none' });
    const result = await verifyIdToken({
      idToken,
      issuer: ISSUER,
      clientId: CLIENT_ID,
      expectedNonce: 'expected-nonce',
      jwks: jwks(),
      now: () => new Date(FIXED_NOW),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/algorithm/i);
  });

  it('rejects a signature made with a key other than the one published under its kid', async () => {
    const idToken = signJwt(baseClaims(), { key: otherPrivateKey });
    const result = await verifyIdToken({
      idToken,
      issuer: ISSUER,
      clientId: CLIENT_ID,
      expectedNonce: 'expected-nonce',
      jwks: jwks(),
      now: () => new Date(FIXED_NOW),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/signature/i);
    void otherPublicKey; // referenced only to keep the "other" keypair symmetrical/self-documenting
  });

  it('rejects a token whose issuer does not match', async () => {
    const idToken = signJwt(baseClaims({ iss: 'https://someone-else.example.com' }));
    const result = await verifyIdToken({
      idToken,
      issuer: ISSUER,
      clientId: CLIENT_ID,
      expectedNonce: 'expected-nonce',
      jwks: jwks(),
      now: () => new Date(FIXED_NOW),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/iss/i);
  });

  it('rejects a token whose audience does not include this client', async () => {
    const idToken = signJwt(baseClaims({ aud: 'some-other-client' }));
    const result = await verifyIdToken({
      idToken,
      issuer: ISSUER,
      clientId: CLIENT_ID,
      expectedNonce: 'expected-nonce',
      jwks: jwks(),
      now: () => new Date(FIXED_NOW),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/aud/i);
  });

  it('rejects a multi-audience token whose azp does not match this client', async () => {
    const idToken = signJwt(baseClaims({ aud: [CLIENT_ID, 'another-client'], azp: 'another-client' }));
    const result = await verifyIdToken({
      idToken,
      issuer: ISSUER,
      clientId: CLIENT_ID,
      expectedNonce: 'expected-nonce',
      jwks: jwks(),
      now: () => new Date(FIXED_NOW),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/azp/i);
  });

  it('rejects an expired token', async () => {
    const idToken = signJwt(baseClaims({ exp: Math.floor(FIXED_NOW / 1000) - 3600 }));
    const result = await verifyIdToken({
      idToken,
      issuer: ISSUER,
      clientId: CLIENT_ID,
      expectedNonce: 'expected-nonce',
      jwks: jwks(),
      now: () => new Date(FIXED_NOW),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/expired/i);
  });

  it('rejects a mismatched nonce', async () => {
    const idToken = signJwt(baseClaims({ nonce: 'wrong-nonce' }));
    const result = await verifyIdToken({
      idToken,
      issuer: ISSUER,
      clientId: CLIENT_ID,
      expectedNonce: 'expected-nonce',
      jwks: jwks(),
      now: () => new Date(FIXED_NOW),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/nonce/i);
  });
});

// ---- mapGroupsToRole ------------------------------------------------------------------------

describe('mapGroupsToRole', () => {
  const roles = new Map([
    ['cezar-admins', 'admin' as const],
    ['cezar-members', 'member' as const],
  ]);

  it('grants nothing for a group not present in the configured map', () => {
    const role = mapGroupsToRole({ groups: ['some-unrelated-group'] }, { claim: 'groups', roles });
    expect(role).toBeUndefined();
  });

  it('grants nothing when no claim is configured, even if the token carries matching groups', () => {
    const role = mapGroupsToRole({ groups: ['cezar-admins'] }, { claim: undefined, roles });
    expect(role).toBeUndefined();
  });

  it('maps a recognised group to its role', () => {
    const role = mapGroupsToRole({ groups: ['cezar-members'] }, { claim: 'groups', roles });
    expect(role).toBe('member');
  });

  it('picks the highest-privilege role when multiple mapped groups match', () => {
    const role = mapGroupsToRole({ groups: ['cezar-members', 'cezar-admins'] }, { claim: 'groups', roles });
    expect(role).toBe('admin');
  });
});

// ---- OidcClient (full flow) -----------------------------------------------------------------

describe('OidcClient', () => {
  it('completes a full authorization-code + PKCE login end to end', async () => {
    let tokenClaims: Record<string, unknown> = {};
    const fetchImpl = makeFetch({
      jwks: () => jsonResponse(jwksBody),
      token: () => jsonResponse({ id_token: signJwt(tokenClaims) }),
    });
    const client = new OidcClient(testConfig(), discovery, { fetchImpl, now: () => new Date(FIXED_NOW) });

    const { url, state } = client.startAuthorization();
    const nonce = new URL(url).searchParams.get('nonce');
    expect(nonce).toBeTruthy();
    tokenClaims = baseClaims({ nonce });

    const result = await client.completeAuthorization({ state, code: 'auth-code-1' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.subject).toBe('user-123');
      expect(result.email).toBe('user@example.com');
      expect(result.issuer).toBe(ISSUER);
    }
  });

  it('rejects a mismatched state', async () => {
    // This test USED TO assert the failure by `expect(result.reason).toMatch(/state/i)` while its
    // token stub threw `'token endpoint must not be called for an unknown state'`. Under a mutation
    // that made `completeAuthorization` fall back to any pending entry — i.e. the callback no
    // longer bound to the authorization request that issued it, a login-CSRF hole — the token
    // endpoint WAS called, the stub threw, `exchangeCodeForTokens` caught it and returned
    // `reason: 'OIDC token request failed: token endpoint must not be called for an unknown state'`,
    // and `/state/i` matched the stub's OWN message. The test passed while asserting the exact
    // opposite of what it means. Both halves are fixed below: the guard-rail is a recorded call
    // COUNT rather than a thrown string, and the reason is matched literally rather than on a
    // substring the fixture itself supplies.
    let tokenCalls = 0;
    const fetchImpl = makeFetch({
      jwks: () => jsonResponse(jwksBody),
      token: () => {
        tokenCalls += 1;
        throw new Error('BOOM — the token endpoint must not be reached for an unknown state');
      },
    });
    const client = new OidcClient(testConfig(), discovery, { fetchImpl, now: () => new Date(FIXED_NOW) });
    client.startAuthorization(); // a real, unrelated pending request exists but is never used

    const result = await client.completeAuthorization({ state: 'a-state-nobody-issued', code: 'whatever' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown or expired authorization state');
    // The mechanism, not a message: a callback whose `state` was never issued must fail BEFORE any
    // code is exchanged, so the decoy pending entry above can never be borrowed to complete it.
    expect(tokenCalls).toBe(0);
  });

  it('rejects a replayed nonce carried over from an earlier, already-completed flow', async () => {
    let tokenClaims: Record<string, unknown> = {};
    const fetchImpl = makeFetch({
      jwks: () => jsonResponse(jwksBody),
      token: () => jsonResponse({ id_token: signJwt(tokenClaims) }),
    });
    const client = new OidcClient(testConfig(), discovery, { fetchImpl, now: () => new Date(FIXED_NOW) });

    // Flow 1: legitimate end to end, consumes nonce1.
    const first = client.startAuthorization();
    const nonce1 = new URL(first.url).searchParams.get('nonce');
    tokenClaims = baseClaims({ nonce: nonce1 });
    const result1 = await client.completeAuthorization({ state: first.state, code: 'code-1' });
    expect(result1.ok).toBe(true);

    // Flow 2: a fresh, legitimate state/nonce pair - but the ID token presented at callback
    // carries flow 1's nonce (an attacker replaying a captured, correctly-signed token; or a
    // buggy IdP/client reusing nonces). state2 itself was never used before, so only the nonce
    // check catches this.
    const second = client.startAuthorization();
    tokenClaims = baseClaims({ nonce: nonce1 });
    const result2 = await client.completeAuthorization({ state: second.state, code: 'code-2' });
    expect(result2.ok).toBe(false);
    if (!result2.ok) expect(result2.reason).toMatch(/nonce/i);
  });

  it('a second completion attempt for an already-consumed state is rejected outright', async () => {
    let tokenClaims: Record<string, unknown> = {};
    const fetchImpl = makeFetch({
      jwks: () => jsonResponse(jwksBody),
      token: () => jsonResponse({ id_token: signJwt(tokenClaims) }),
    });
    const client = new OidcClient(testConfig(), discovery, { fetchImpl, now: () => new Date(FIXED_NOW) });

    const { url, state } = client.startAuthorization();
    const nonce = new URL(url).searchParams.get('nonce');
    tokenClaims = baseClaims({ nonce });
    const first = await client.completeAuthorization({ state, code: 'code-1' });
    expect(first.ok).toBe(true);

    const replay = await client.completeAuthorization({ state, code: 'code-1' });
    expect(replay.ok).toBe(false);
    // Literal, not `/state/i` — see the mismatched-state test above for how a loose regex over a
    // reason string let a fixture's own error message satisfy an assertion about the code.
    if (!replay.ok) expect(replay.reason).toBe('unknown or expired authorization state');
  });

  it('resolves a role from a mapped group and none for an unmapped one', async () => {
    let tokenClaims: Record<string, unknown> = {};
    const fetchImpl = makeFetch({
      jwks: () => jsonResponse(jwksBody),
      token: () => jsonResponse({ id_token: signJwt(tokenClaims) }),
    });
    const config = testConfig({
      groupMapping: { claim: 'groups', roles: new Map([['cezar-admins', 'admin']]) },
    });
    const client = new OidcClient(config, discovery, { fetchImpl, now: () => new Date(FIXED_NOW) });

    const mapped = client.startAuthorization();
    const nonce1 = new URL(mapped.url).searchParams.get('nonce');
    tokenClaims = baseClaims({ nonce: nonce1, groups: ['cezar-admins'] });
    const mappedResult = await client.completeAuthorization({ state: mapped.state, code: 'code-a' });
    expect(mappedResult.ok).toBe(true);
    if (mappedResult.ok) expect(mappedResult.role).toBe('admin');

    const unmapped = client.startAuthorization();
    const nonce2 = new URL(unmapped.url).searchParams.get('nonce');
    tokenClaims = baseClaims({ nonce: nonce2, groups: ['some-other-group'] });
    const unmappedResult = await client.completeAuthorization({ state: unmapped.state, code: 'code-b' });
    expect(unmappedResult.ok).toBe(true);
    if (unmappedResult.ok) expect(unmappedResult.role).toBeUndefined();
  });
});
