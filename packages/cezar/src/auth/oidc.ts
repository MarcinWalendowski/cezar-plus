/**
 * Generic OIDC + Google OAuth (D9, `.ai/specs/2026-08-06-org-team-auth-onboarding.md`).
 *
 * Authorization Code + PKCE, `state` and `nonce` verified, one code path for both providers:
 * "Google" is this same client with its issuer pinned to `https://accounts.google.com` rather
 * than a second implementation — the same D3 reasoning that keeps auth-on and auth-off
 * resolving a principal through one path applies here to keep oidc-vs-google from drifting.
 *
 * **Scope of this module.** This is the protocol engine only: discovery, the authorization
 * URL, the code-for-tokens exchange, ID-token verification, and group-claim -> role mapping.
 * It does not create sessions, cookies, users, orgs, teams or memberships — those are Phase
 * 2/3/4 concerns (`../auth/session.ts`, `../auth/routes.ts`, org/team storage), none of which
 * exist yet. `startAuthorization`/`completeAuthorization` below are what those modules are
 * expected to call; nothing here reaches into `server/server.ts` or touches `<CEZ_HOME>/identity`.
 *
 * **`resolveOidcConfig` must run exactly once, at boot** (D9: "redirect_uri from
 * CEZ_PUBLIC_URL, validated at BOOT — never derived from a forwarded request header"). A
 * per-request `Host`/`X-Forwarded-Host` header is attacker-controlled; a caller that re-derives
 * `redirect_uri` from one per request has rebuilt the exact open-redirect shape D9 calls out.
 * Callers must resolve the config once and reuse the same `ResolvedOidcConfig` for the life of
 * the process, not call this per request.
 *
 * **Only RS256 is accepted** for ID-token signatures (`verifyIdToken`). This is what stops the
 * classic JWT "alg confusion" bypass — a token claiming `alg: "none"` (no signature to check
 * at all) or a symmetric algorithm the server would happily "verify" against a key it never
 * chose to trust for that purpose. Every OIDC provider this module targets (Google, Keycloak,
 * Authentik) signs with RS256 by default, so this is not a compatibility cost.
 *
 * **`CEZ_OIDC_GROUP_ROLE_MAP` can only map to `admin` or `member`, never `owner`.** D8: the
 * first user to sign in becomes owner of a NEW org, once, structurally — every user after that
 * needs an invite. Owner is not a fact re-derived from an IdP claim on every login, so a
 * `group=owner` entry in the map is treated as malformed and dropped rather than honoured; see
 * `parseGroupRoleMap`.
 */

import { createHash, createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto';
import type { JsonWebKey as CryptoJsonWebKey, KeyObject } from 'node:crypto';
import { z } from 'zod';
import type { AuthProvider } from '@loki-labs/cezar-plus-contract';

// ---- provider selection --------------------------------------------------------------------

/**
 * The two providers that actually run the OIDC/PKCE flow (D9).
 *
 * **CORRECTED 2026-08-07 (phase 6/7 repair stage): spelled out, not derived.** This was
 * `Exclude<AuthProvider, 'none'>`, and phase 6 widened `AuthProvider` with `'supervisor'` — so
 * this type silently gained a third member, and `contract/health.ts`'s own new docblock claiming
 * `OidcProvider` "stays `oidc | google` exactly" became false the moment it was written. Verified
 * by probe at review: `const _: OidcProvider = 'supervisor'` type-checked. The compile-time guard
 * that would have stopped `'supervisor'` reaching `resolveOidcConfig` was gone, which is why
 * `../auth/routes.ts` compiles while passing `resolveAuthProvider`'s output straight in.
 *
 * A derived type is right when the two sets are the same set for a REASON; here they are the same
 * set only by coincidence of there being no third value yet, and that coincidence expired. The
 * exhaustiveness this loses is bought back by `authProviderCoverage` below, which fails to compile
 * if a future `AuthProvider` member is neither an OIDC provider nor explicitly listed as
 * non-OIDC — so adding a fourth provider is still a compile error somewhere, just at a place that
 * forces a decision instead of guessing one.
 */
export type OidcProvider = 'oidc' | 'google';

/** Every `AuthProvider` that is NOT an `OidcProvider`, named explicitly. */
type NonOidcProvider = 'none' | 'supervisor';

/** Compile-time exhaustiveness: if `AuthProvider` ever gains a member, this alias stops being
 *  assignable and typecheck fails here — at the one place that has to decide whether the new
 *  provider runs the OIDC flow. Never evaluated at runtime; the `void` keeps it from being an
 *  unused-symbol lint error. */
type AuthProviderCoverage = OidcProvider | NonOidcProvider;
const _authProviderCoverage: AuthProvider extends AuthProviderCoverage
  ? AuthProviderCoverage extends AuthProvider
    ? true
    : never
  : never = true;
void _authProviderCoverage;

const GOOGLE_ISSUER = 'https://accounts.google.com';

/** Fixed, non-configurable callback path (D5's reserved top-level `auth`/`callback` segments).
 *  Exported so `../auth/routes.ts` (Phase 3) mounts its callback handler at the exact path this
 *  module already baked into every `redirect_uri` — two modules independently hardcoding the
 *  same string is how they drift apart the first time one of them changes it. */
export const AUTH_CALLBACK_PATH = '/auth/callback';

/** OIDC Core requires `openid`; a caller who only sets custom scopes without it would get a
 *  plain OAuth2 grant with no `id_token`, which this module has no way to complete. Not
 *  configurable via env - D9 doesn't ask for scope customization, and the three scopes below
 *  are exactly what D8's onboarding needs (identity, email, and a display name / `hd` claim). */
const SCOPES = ['openid', 'email', 'profile'] as const;

// ---- role mapping (D9: "Group/role mapping from a configurable claim, defaulting to none") --

/** Deliberately excludes `'owner'` - see the module doc comment. */
export type MappedRole = 'admin' | 'member';

export interface GroupRoleMapping {
  /** Claim name to read group membership from, e.g. `"groups"`. `undefined` means mapping is
   *  disabled entirely: no claim is ever read, so nothing is ever inferred - "membership is
   *  never inferred from a claim the operator did not map" (D9), including the *name* of the
   *  claim itself. */
  readonly claim: string | undefined;
  /** IdP group name -> role. A group present in the claim's value but absent from this map
   *  contributes nothing - not a default role, just silently ignored (D9). */
  readonly roles: ReadonlyMap<string, MappedRole>;
}

const ROLE_RANK: Record<MappedRole, number> = { member: 0, admin: 1 };

/**
 * `undefined` when the claim isn't configured, the token doesn't carry it, or none of the
 * groups it lists are in `mapping.roles`. When more than one mapped group matches, the
 * highest-privilege one wins (admin over member) rather than the first or last in claim order,
 * which would make the result depend on an IdP-specific, undocumented ordering.
 */
export function mapGroupsToRole(claims: Readonly<Record<string, unknown>>, mapping: GroupRoleMapping): MappedRole | undefined {
  if (!mapping.claim) return undefined;
  const raw = claims[mapping.claim];
  const groups = Array.isArray(raw)
    ? raw.filter((g): g is string => typeof g === 'string')
    : typeof raw === 'string'
      ? [raw]
      : [];

  let best: MappedRole | undefined;
  for (const group of groups) {
    const role = mapping.roles.get(group);
    if (!role) continue; // unmapped group: grants nothing (D9)
    if (!best || ROLE_RANK[role] > ROLE_RANK[best]) best = role;
  }
  return best;
}

/**
 * Parses `CEZ_OIDC_GROUP_ROLE_MAP` (`group=role,group2=role2`, the same comma-list-of-pairs
 * shape as `CEZ_ENV_PASSTHROUGH` elsewhere in this codebase). A malformed entry - no `=`, an
 * empty group name, or a role that isn't exactly `admin`/`member` (including `owner`, see the
 * module doc comment) - is dropped rather than thrown: one operator typo in a multi-entry list
 * degrading that one mapping to "grants nothing" is the same zero-config failure mode the rest
 * of this file uses, and is safer than refusing to boot over a single bad line.
 */
function parseGroupRoleMap(raw: string | undefined): ReadonlyMap<string, MappedRole> {
  const map = new Map<string, MappedRole>();
  if (!raw) return map;
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const group = trimmed.slice(0, eq).trim();
    const role = trimmed.slice(eq + 1).trim();
    if (!group) continue;
    if (role === 'admin' || role === 'member') map.set(group, role);
  }
  return map;
}

// ---- config resolution (env -> ResolvedOidcConfig, sync, boot-time only) --------------------

export interface ResolvedOidcConfig {
  readonly provider: OidcProvider;
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly groupMapping: GroupRoleMapping;
}

export type ResolveOidcConfigResult = { ok: true; config: ResolvedOidcConfig } | { ok: false; reason: string };

/**
 * Resolves and validates the OIDC/Google client config from the environment. See the module
 * doc comment: call this ONCE at boot, never per request.
 */
export function resolveOidcConfig(provider: OidcProvider, env: NodeJS.ProcessEnv = process.env): ResolveOidcConfigResult {
  const publicUrlRaw = env.CEZ_PUBLIC_URL?.trim();
  if (!publicUrlRaw) return { ok: false, reason: 'CEZ_PUBLIC_URL is required when CEZ_AUTH is "oidc" or "google"' };
  let publicUrl: URL;
  try {
    publicUrl = new URL(publicUrlRaw);
  } catch {
    return { ok: false, reason: `CEZ_PUBLIC_URL "${publicUrlRaw}" is not a valid absolute URL` };
  }
  if (publicUrl.protocol !== 'http:' && publicUrl.protocol !== 'https:') {
    return { ok: false, reason: `CEZ_PUBLIC_URL "${publicUrlRaw}" must be http or https` };
  }

  const clientId = env.CEZ_OIDC_CLIENT_ID?.trim();
  const clientSecret = env.CEZ_OIDC_CLIENT_SECRET?.trim();
  if (!clientId) return { ok: false, reason: 'CEZ_OIDC_CLIENT_ID is required when CEZ_AUTH is "oidc" or "google"' };
  if (!clientSecret) return { ok: false, reason: 'CEZ_OIDC_CLIENT_SECRET is required when CEZ_AUTH is "oidc" or "google"' };

  let issuer: string;
  if (provider === 'google') {
    // Pinned (D9) - CEZ_OIDC_ISSUER is ignored for this provider so there is exactly one way
    // to end up authenticating against something other than real Google.
    issuer = GOOGLE_ISSUER;
  } else {
    const configured = env.CEZ_OIDC_ISSUER?.trim();
    if (!configured) return { ok: false, reason: 'CEZ_OIDC_ISSUER is required when CEZ_AUTH=oidc' };
    let parsedIssuer: URL;
    try {
      parsedIssuer = new URL(configured);
    } catch {
      return { ok: false, reason: `CEZ_OIDC_ISSUER "${configured}" is not a valid absolute URL` };
    }
    if (parsedIssuer.protocol !== 'https:' && parsedIssuer.hostname !== 'localhost' && parsedIssuer.hostname !== '127.0.0.1') {
      return { ok: false, reason: `CEZ_OIDC_ISSUER "${configured}" must be https (localhost excepted, for local testing)` };
    }
    issuer = configured.endsWith('/') ? configured.slice(0, -1) : configured;
  }

  const groupMapping: GroupRoleMapping = {
    claim: env.CEZ_OIDC_GROUP_CLAIM?.trim() || undefined,
    roles: parseGroupRoleMap(env.CEZ_OIDC_GROUP_ROLE_MAP),
  };

  const redirectUri = new URL(AUTH_CALLBACK_PATH, publicUrl).toString();

  return {
    ok: true,
    config: { provider, issuer, clientId, clientSecret, redirectUri, scopes: SCOPES, groupMapping },
  };
}

// ---- discovery -----------------------------------------------------------------------------

const discoveryDocumentSchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  jwks_uri: z.string(),
  userinfo_endpoint: z.string().optional(),
});

export type OidcDiscoveryDocument = z.infer<typeof discoveryDocumentSchema>;

export type DiscoverOidcConfigurationResult =
  | { ok: true; document: OidcDiscoveryDocument }
  | { ok: false; reason: string };

const DISCOVERY_TIMEOUT_MS = 10_000;

/**
 * Fetches `<issuer>/.well-known/openid-configuration` (string concatenation, not `new URL(path,
 * issuer)` - a relative URL resolved against a base without a trailing slash drops the base's
 * last path segment per standard URL-resolution rules, which would silently mangle an issuer
 * that includes a path, e.g. Keycloak's `https://kc.example.com/realms/<realm>`).
 *
 * Verifies the returned `issuer` matches what was requested (OIDC Discovery 1.0 §4.3: "The
 * issuer value returned MUST be identical to the Issuer URL that was directly used to retrieve
 * the configuration information") - a mismatch here means we asked one issuer and got
 * configuration for another, which is exactly the kind of provider-confusion `verifyIdToken`'s
 * later `iss` check depends on this step having already ruled out.
 */
export async function discoverOidcConfiguration(
  issuer: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DiscoverOidcConfigurationResult> {
  const base = issuer.endsWith('/') ? issuer.slice(0, -1) : issuer;
  const url = `${base}/.well-known/openid-configuration`;

  let res: Response;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
  } catch (err) {
    return { ok: false, reason: `OIDC discovery request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!res.ok) return { ok: false, reason: `OIDC discovery endpoint responded ${res.status}` };

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, reason: 'OIDC discovery endpoint returned invalid JSON' };
  }
  const parsed = discoveryDocumentSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: `unexpected OIDC discovery document shape: ${parsed.error.message}` };
  if (parsed.data.issuer !== base) {
    return { ok: false, reason: `OIDC discovery document issuer "${parsed.data.issuer}" does not match requested issuer "${base}"` };
  }
  return { ok: true, document: parsed.data };
}

// ---- PKCE + authorization URL --------------------------------------------------------------

function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

/** RFC 7636 code_verifier: 32 random bytes base64url-encoded is 43 characters, inside the
 *  spec's [43,128] range and drawn entirely from its unreserved-character alphabet. */
function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function buildAuthorizationUrl(
  discovery: OidcDiscoveryDocument,
  config: ResolvedOidcConfig,
  params: { state: string; nonce: string; codeChallenge: string },
): string {
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', config.scopes.join(' '));
  url.searchParams.set('state', params.state);
  url.searchParams.set('nonce', params.nonce);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

// ---- token exchange --------------------------------------------------------------------------

const tokenResponseSchema = z.object({
  id_token: z.string(),
  access_token: z.string().optional(),
  token_type: z.string().optional(),
  expires_in: z.number().optional(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
});

export type OidcTokenResponse = z.infer<typeof tokenResponseSchema>;

type ExchangeResult = { ok: true; tokens: OidcTokenResponse } | { ok: false; reason: string };

const TOKEN_REQUEST_TIMEOUT_MS = 15_000;

async function exchangeCodeForTokens(
  discovery: OidcDiscoveryDocument,
  config: ResolvedOidcConfig,
  params: { code: string; codeVerifier: string },
  fetchImpl: typeof fetch,
): Promise<ExchangeResult> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code_verifier: params.codeVerifier,
  });

  let res: Response;
  try {
    res = await fetchImpl(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, reason: `OIDC token request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!res.ok) return { ok: false, reason: `OIDC token endpoint responded ${res.status}` };

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { ok: false, reason: 'OIDC token endpoint returned invalid JSON' };
  }
  const parsed = tokenResponseSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: `unexpected OIDC token response shape: ${parsed.error.message}` };
  return { ok: true, tokens: parsed.data };
}

// ---- JWKS cache (D9: "cached with a bounded TTL and refetched on unknown kid") --------------

const jwkSchema = z
  .object({ kty: z.string(), kid: z.string().optional() })
  .catchall(z.unknown());

const jwksResponseSchema = z.object({ keys: z.array(jwkSchema) });

type Jwk = z.infer<typeof jwkSchema>;

export interface JwksCacheOptions {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Bounded TTL for a full cache refresh even absent an unknown `kid` - a rotated key whose
   *  `kid` this cache has never seen still forces a refetch immediately (see `getKey`); this
   *  TTL is the ceiling for how long a KNOWN key stays trusted before we re-check the provider
   *  hasn't revoked it. */
  ttlMs?: number;
}

const DEFAULT_JWKS_TTL_MS = 10 * 60_000;
const JWKS_REQUEST_TIMEOUT_MS = 10_000;

export class JwksCache {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private keys = new Map<string, Jwk>();
  private fetchedAt = 0;

  constructor(
    private readonly jwksUri: string,
    options: JwksCacheOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? DEFAULT_JWKS_TTL_MS;
  }

  /**
   * Throws (fails closed) rather than returning `undefined` for a key that can't be resolved -
   * a caller that forgot to handle "no key" would otherwise skip signature verification
   * entirely rather than reject the token, which is a far worse failure mode than an exception.
   *
   * An unknown `kid` gets exactly ONE extra refetch beyond whatever the TTL logic already
   * triggered, never a retry loop: key rotation can happen between scheduled refreshes (an IdP
   * doesn't wait for our cache to expire before rotating), so a single kid-miss is worth one
   * unconditional refresh - but a `kid` that is unknown twice in a row is not a rotation, it's
   * either a forged token or a broken/hostile `jwks_uri`, and hammering it would be the wrong
   * response to either.
   */
  async getKey(kid: string): Promise<KeyObject> {
    if (this.keys.size === 0 || this.isExpired()) {
      await this.refresh();
    }
    let jwk = this.keys.get(kid);
    if (!jwk) {
      await this.refresh();
      jwk = this.keys.get(kid);
    }
    if (!jwk) throw new Error(`oidc: no JWKS key found for kid "${kid}" after refetch`);
    return jwkToPublicKey(jwk);
  }

  private isExpired(): boolean {
    return this.now().getTime() - this.fetchedAt > this.ttlMs;
  }

  private async refresh(): Promise<void> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.jwksUri, { signal: AbortSignal.timeout(JWKS_REQUEST_TIMEOUT_MS) });
    } catch (err) {
      throw new Error(`oidc: JWKS fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) throw new Error(`oidc: JWKS endpoint responded ${res.status}`);
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new Error('oidc: JWKS endpoint returned invalid JSON');
    }
    const parsed = jwksResponseSchema.safeParse(json);
    if (!parsed.success) throw new Error(`oidc: unexpected JWKS shape: ${parsed.error.message}`);

    const next = new Map<string, Jwk>();
    for (const jwk of parsed.data.keys) {
      if (jwk.kid) next.set(jwk.kid, jwk);
    }
    this.keys = next;
    this.fetchedAt = this.now().getTime();
  }
}

function jwkToPublicKey(jwk: Jwk): KeyObject {
  return createPublicKey({ key: jwk as unknown as CryptoJsonWebKey, format: 'jwk' });
}

// ---- ID token verification -------------------------------------------------------------------

const ALLOWED_ALG = 'RS256';
const DEFAULT_CLOCK_SKEW_MS = 60_000;

type JwtClaims = Record<string, unknown>;

interface DecodedJwt {
  readonly header: Record<string, unknown>;
  readonly payload: JwtClaims;
  readonly signingInput: string;
  readonly signature: Buffer;
}

function decodeJwt(token: string): DecodedJwt | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  const [headerB64, payloadB64, signatureB64] = parts;
  if (!headerB64 || !payloadB64 || !signatureB64) return undefined;
  try {
    const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8')) as unknown;
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as unknown;
    if (typeof header !== 'object' || header === null || typeof payload !== 'object' || payload === null) return undefined;
    return {
      header: header as Record<string, unknown>,
      payload: payload as JwtClaims,
      signingInput: `${headerB64}.${payloadB64}`,
      signature: Buffer.from(signatureB64, 'base64url'),
    };
  } catch {
    return undefined;
  }
}

export interface VerifyIdTokenParams {
  readonly idToken: string;
  readonly issuer: string;
  readonly clientId: string;
  /** The nonce THIS authorization request generated (from the `state`-keyed pending entry, see
   *  `OidcClient`). Checked per OIDC Core §15.5.2 - a token whose nonce doesn't match is treated
   *  as a replay, not a mismatch: a correctly-signed, otherwise-valid token from an earlier
   *  (already-completed) login is exactly this case. */
  readonly expectedNonce: string;
  readonly jwks: JwksCache;
  readonly now?: () => Date;
  readonly clockSkewMs?: number;
}

export type VerifyIdTokenResult = { ok: true; claims: JwtClaims } | { ok: false; reason: string };

export async function verifyIdToken(params: VerifyIdTokenParams): Promise<VerifyIdTokenResult> {
  const decoded = decodeJwt(params.idToken);
  if (!decoded) return { ok: false, reason: 'malformed ID token' };

  const alg = decoded.header.alg;
  if (alg !== ALLOWED_ALG) {
    // See the module doc comment: this is the alg-confusion guard, not a compatibility gap.
    return { ok: false, reason: `unsupported ID token algorithm "${String(alg)}" (only RS256 is accepted)` };
  }
  const kid = decoded.header.kid;
  if (typeof kid !== 'string' || !kid) return { ok: false, reason: 'ID token header is missing "kid"' };

  let key: KeyObject;
  try {
    key = await params.jwks.getKey(kid);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  const signatureValid = verifySignature('RSA-SHA256', Buffer.from(decoded.signingInput), key, decoded.signature);
  if (!signatureValid) return { ok: false, reason: 'ID token signature verification failed' };

  const claims = decoded.payload;
  const nowMs = (params.now ?? (() => new Date()))().getTime();
  const skew = params.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;

  const iss = claims.iss;
  if (iss !== params.issuer) return { ok: false, reason: 'ID token "iss" does not match the configured issuer' };

  const aud = claims.aud;
  const audList: unknown[] = Array.isArray(aud) ? aud : typeof aud === 'string' ? [aud] : [];
  if (!audList.includes(params.clientId)) return { ok: false, reason: 'ID token "aud" does not include this client' };
  if (audList.length > 1 && claims.azp !== params.clientId) {
    // OIDC Core §3.1.3.7 step 9: with multiple audiences, `azp` MUST equal this client. Without
    // this, a token this client's own IdP issued FOR A DIFFERENT CLIENT (audience confusion)
    // would otherwise pass the plain `aud`-includes check above.
    return { ok: false, reason: 'ID token has multiple audiences and "azp" does not match this client' };
  }

  const exp = claims.exp;
  if (typeof exp !== 'number' || nowMs > exp * 1000 + skew) return { ok: false, reason: 'ID token is expired' };

  const iat = claims.iat;
  if (typeof iat === 'number' && iat * 1000 > nowMs + skew) return { ok: false, reason: 'ID token "iat" is in the future' };

  const nbf = claims.nbf;
  if (typeof nbf === 'number' && nowMs < nbf * 1000 - skew) return { ok: false, reason: 'ID token is not yet valid ("nbf")' };

  if (claims.nonce !== params.expectedNonce) {
    return { ok: false, reason: 'ID token "nonce" does not match this request (possible replay)' };
  }

  return { ok: true, claims };
}

// ---- the stateful flow: ties one `state` to its nonce + PKCE verifier, once ------------------

export interface OidcClientOptions {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** How long a `state` stays valid awaiting its callback (the user has this long to complete
   *  the IdP's login screen). */
  requestTtlMs?: number;
  /** Injectable for tests; defaults to one built from `discovery.jwks_uri`. */
  jwks?: JwksCache;
  clockSkewMs?: number;
}

const DEFAULT_REQUEST_TTL_MS = 10 * 60_000;

export type OidcLoginResult =
  | {
      readonly ok: true;
      readonly issuer: string;
      readonly subject: string;
      readonly email?: string;
      readonly name?: string;
      /** `undefined` when group mapping is unconfigured or no group matched - see
       *  `mapGroupsToRole`. What that means for org membership is a Phase 4 decision, not this
       *  module's. */
      readonly role: MappedRole | undefined;
    }
  | { readonly ok: false; readonly reason: string };

interface PendingRequest {
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly createdAt: number;
}

/**
 * The stateful half of D9. `startAuthorization`/`completeAuthorization` are what
 * `../auth/routes.ts` (Phase 3, not yet written) is expected to call from its `/login` and
 * `AUTH_CALLBACK_PATH` handlers; this class owns the protocol, routes.ts owns turning a
 * successful `OidcLoginResult` into a session cookie.
 *
 * One `OidcClient` instance is meant to live for the process lifetime (it owns the pending
 * `state` map), built once at boot from `resolveOidcConfig` + `discoverOidcConfiguration`.
 */
export class OidcClient {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly requestTtlMs: number;
  private readonly jwks: JwksCache;
  private readonly clockSkewMs: number | undefined;

  constructor(
    private readonly config: ResolvedOidcConfig,
    private readonly discovery: OidcDiscoveryDocument,
    options: OidcClientOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.requestTtlMs = options.requestTtlMs ?? DEFAULT_REQUEST_TTL_MS;
    this.jwks = options.jwks ?? new JwksCache(discovery.jwks_uri, { fetchImpl: this.fetchImpl, now: this.now });
    this.clockSkewMs = options.clockSkewMs;
  }

  startAuthorization(): { url: string; state: string } {
    this.pruneExpired();
    const state = randomToken();
    const nonce = randomToken();
    const { verifier, challenge } = generatePkcePair();
    this.pending.set(state, { nonce, codeVerifier: verifier, createdAt: this.now().getTime() });
    const url = buildAuthorizationUrl(this.discovery, this.config, { state, nonce, codeChallenge: challenge });
    return { url, state };
  }

  async completeAuthorization(params: { state: string; code: string }): Promise<OidcLoginResult> {
    this.pruneExpired();
    const entry = this.pending.get(params.state);
    // Single-use the moment it's looked up, success or failure alike: a second callback for the
    // same `state` (a resubmitted form, a captured-and-replayed callback URL) must never get a
    // second chance at the nonce/code_verifier this entry was holding.
    this.pending.delete(params.state);
    if (!entry) return { ok: false, reason: 'unknown or expired authorization state' };

    const exchanged = await exchangeCodeForTokens(
      this.discovery,
      this.config,
      { code: params.code, codeVerifier: entry.codeVerifier },
      this.fetchImpl,
    );
    if (!exchanged.ok) return { ok: false, reason: exchanged.reason };

    const verified = await verifyIdToken({
      idToken: exchanged.tokens.id_token,
      issuer: this.config.issuer,
      clientId: this.config.clientId,
      expectedNonce: entry.nonce,
      jwks: this.jwks,
      now: this.now,
      clockSkewMs: this.clockSkewMs,
    });
    if (!verified.ok) return { ok: false, reason: verified.reason };

    const claims = verified.claims;
    const subject = claims.sub;
    if (typeof subject !== 'string' || !subject) return { ok: false, reason: 'ID token is missing "sub"' };
    const email = typeof claims.email === 'string' ? claims.email : undefined;
    const name = typeof claims.name === 'string' ? claims.name : undefined;
    const role = mapGroupsToRole(claims, this.config.groupMapping);

    return { ok: true, issuer: this.config.issuer, subject, email, name, role };
  }

  private pruneExpired(): void {
    const cutoff = this.now().getTime() - this.requestTtlMs;
    for (const [state, entry] of this.pending) {
      if (entry.createdAt < cutoff) this.pending.delete(state);
    }
  }
}
