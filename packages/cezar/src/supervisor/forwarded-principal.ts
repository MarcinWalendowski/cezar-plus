import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Principal } from '../server/server.ts';

/**
 * **Phase 6/7 scaffold** (D4/D7, spec `.ai/specs/2026-08-06-org-team-auth-onboarding.md`, "D10"
 * section added at the scaffold pass). Not wired into any process yet — this file is the frozen
 * contract two not-yet-built units share, written now so neither invents it independently:
 *
 *   - **Fill unit 1 (supervisor core)** SIGNS. After `auth/session.ts`'s existing
 *     `sessionResolver.resolveFromCookieHeader` resolves a real `Principal` from the session
 *     cookie (unchanged, phase-3 code), the supervisor's nginx `auth_request` handler calls
 *     `signForwardedPrincipal` and returns the two headers below for nginx's `auth_request_set` /
 *     `proxy_set_header` to inject into the request nginx then forwards to that org's process.
 *   - **Fill unit 5 (root-registry + principal resolver)** VERIFIES. A new `CEZ_AUTH=supervisor`
 *     branch of `auth/principal.ts` calls `verifyForwardedPrincipal` inside a `SessionResolver`
 *     implementation, and on success builds a `Principal` via `principalFromForwardedPayload`.
 *
 * **Why a process boundary needs a signature at all, not just header trust.** Every org's
 * process binds loopback-only (unchanged from today), reachable only via nginx per D4/D5 — but
 * loopback is a SHARED namespace across every unix user on the host, uid-separated or not. Any
 * local process — including another org's, compromised or not — can open a TCP connection to
 * `127.0.0.1:<this org's port>` and set whatever headers it likes; nginx's `proxy_set_header` is
 * the only thing that would normally overwrite a client-supplied value, and trusting that alone
 * makes the isolation boundary an nginx-config typo away from failing open. A per-org HMAC secret
 * (`CEZ_SUPERVISOR_SECRET`, minted at provisioning — see `org-process-registry.ts`) means a
 * forged header is rejected by the ORG PROCESS ITSELF regardless of what reached it or how,
 * which is the same "verify at the boundary that actually enforces it" reasoning D6 already
 * applies to the WebSocket upgrade (`server.ts#verifyWsUpgrade`) rather than trusting Hono's
 * `/api/*` middleware to have run.
 *
 * **Why sign-then-verify rather than encrypt.** The payload (`userId`/`orgId`/`teamId`/`role`) is
 * not secret from the org process — it is inherently addressed TO it. What must not be forgeable
 * is the CLAIM, not the content, which is exactly what HMAC gives and encryption would not add.
 *
 * **Freshness, not replay-proofing.** `issuedAt` bounds how long a captured header pair remains
 * usable (`DEFAULT_MAX_AGE_MS`), the same "resolved fresh, never cached" posture
 * `auth/session.ts`'s own module doc already commits to for org/team/role. It is not a nonce
 * scheme — nginx's `auth_request` runs on (approximately) every proxied request, so the window an
 * attacker would need to replay inside is the same one a live session cookie already grants them.
 */

/** Injected by nginx's `auth_request_set` after a successful `/internal/auth-check` subrequest to
 *  the supervisor, then forwarded with `proxy_set_header` to the org process's upstream — never
 *  set by a browser or any other untrusted client directly. */
export const X_CEZAR_PRINCIPAL_HEADER = 'x-cezar-principal';
export const X_CEZAR_SIGNATURE_HEADER = 'x-cezar-principal-sig';

/** 60s: generous enough that ordinary request latency and modest clock skew between the
 *  supervisor and an org host never cause a false refusal, short enough that a captured header
 *  pair is useless within a minute of capture. Override per call for tests. */
const DEFAULT_MAX_AGE_MS = 60_000;

/**
 * Deliberately `.strict()`, not `.passthrough()` like every ON-DISK schema in `auth/types.ts`.
 * Those use `.passthrough()` because a newer cezar's on-disk write must survive an older cezar's
 * read (BACKWARD_COMPATIBILITY.md §3/§9) — a forward-compatibility concern with no counterpart
 * here: the supervisor and every org process under it come from the SAME install, so there is no
 * "older reader" to protect, and this value rides in an HTTP header nginx must buffer, where an
 * unbounded passthrough payload is a cost with no corresponding benefit.
 */
export const forwardedPrincipalPayloadSchema = z
  .object({
    userId: z.string().min(1),
    orgId: z.string().min(1),
    teamId: z.string().min(1),
    role: z.enum(['owner', 'admin', 'member']),
    /** `Date#toISOString()`, matching every other timestamp in this codebase (`RunRecord`,
     *  `identity-store.ts`'s tables) rather than a numeric epoch. */
    issuedAt: z.string().min(1),
  })
  .strict();
export type ForwardedPrincipalPayload = z.infer<typeof forwardedPrincipalPayloadSchema>;

function encodePayload(payload: ForwardedPrincipalPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function sign(encodedPayload: string, secret: string): string {
  return createHmac('sha256', secret).update(encodedPayload).digest('base64url');
}

export interface SignedForwardedPrincipal {
  /** Value for `X_CEZAR_PRINCIPAL_HEADER` — the base64url-encoded JSON payload. */
  readonly principalHeader: string;
  /** Value for `X_CEZAR_SIGNATURE_HEADER` — base64url HMAC-SHA256 of `principalHeader`. */
  readonly signatureHeader: string;
}

/** The supervisor side. `secret` is that org's `OrgProcessRecord#supervisorSecret`
 *  (`org-process-registry.ts`), looked up by the org the routed hostname resolved to — never a
 *  secret shared across orgs, or one org's compromise would forge headers for every other. */
export function signForwardedPrincipal(payload: ForwardedPrincipalPayload, secret: string): SignedForwardedPrincipal {
  const principalHeader = encodePayload(payload);
  return { principalHeader, signatureHeader: sign(principalHeader, secret) };
}

export interface VerifyForwardedPrincipalOptions {
  now?: () => Date;
  maxAgeMs?: number;
}

/**
 * The org-process side. Returns `null` for every failure mode — missing header, wrong secret,
 * tampered payload or signature, malformed encoding, unparseable JSON, a shape that fails the
 * schema, a stale or clock-skewed-into-the-future `issuedAt` — never throws, matching
 * `SessionResolver#resolveFromCookieHeader`'s existing null-on-failure contract
 * (`server/server.ts`) so Fill unit 5 can wire this in without changing that interface's error
 * shape.
 *
 * Signature is checked BEFORE the payload is parsed or its age is read, and with
 * `timingSafeEqual` — the same ordering `auth/session.ts`'s own doc comment on session-id
 * comparison names as the correct shape, applied here where it is actually implementable (unlike
 * that file's session-id lookup, this comparison is the FIRST and ONLY comparison of a
 * caller-supplied value, not a second pass over an already-resolved row).
 */
export function verifyForwardedPrincipal(
  principalHeader: string | undefined | null,
  signatureHeader: string | undefined | null,
  secret: string,
  options: VerifyForwardedPrincipalOptions = {},
): ForwardedPrincipalPayload | null {
  if (!principalHeader || !signatureHeader || !secret) return null;
  const expected = Buffer.from(sign(principalHeader, secret));
  const actual = Buffer.from(signatureHeader);
  // Length compared before `timingSafeEqual` (which throws, rather than returning false, on a
  // length mismatch) — not a timing leak of the secret, since `expected`'s length is fixed by the
  // HMAC digest encoding and never depends on `secret`'s content.
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(principalHeader, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const parsed = forwardedPrincipalPayloadSchema.safeParse(decoded);
  if (!parsed.success) return null;

  const issuedAtMs = Date.parse(parsed.data.issuedAt);
  if (!Number.isFinite(issuedAtMs)) return null;
  const now = (options.now ?? (() => new Date()))();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const ageMs = now.getTime() - issuedAtMs;
  // Negative age (issuedAt in the future) is refused too, not clamped to zero — a payload that
  // claims to be from the future is exactly as suspect as one that is stale, and guessing which
  // clock is wrong is not this function's job.
  if (ageMs < 0 || ageMs > maxAgeMs) return null;

  return parsed.data;
}

/** `kind: 'session'` — deliberately reuses the SAME discriminant `auth/principal.ts` already
 *  produces for a locally-resolved `oidc`/`google` session, rather than widening `Principal.kind`
 *  (`'local' | 'session'`, `server/server.ts`) with a third value. Nothing that reads a
 *  `Principal` needs to know whether org/team/role were resolved from a local cookie lookup or
 *  from a supervisor-forwarded, HMAC-verified header — both are "a real signed-in user, already
 *  authenticated", which is everything `kind: 'session'` has ever meant. Widening the union would
 *  touch every exhaustive `switch`/narrowing on `principal.kind` in `server.ts` for a distinction
 *  no caller acts on. */
export function principalFromForwardedPayload(payload: ForwardedPrincipalPayload): Principal {
  return { kind: 'session', userId: payload.userId, orgId: payload.orgId, teamId: payload.teamId, role: payload.role };
}

export interface ForwardedPrincipalHeaders {
  readonly principal?: string;
  readonly signature?: string;
}

/**
 * One header-extraction helper for both call shapes `verifyForwardedPrincipal`'s two callers need
 * — Hono's `c.req.header(name)` and the raw `IncomingMessage.headers[name]` `verifyWsUpgrade`
 * reads from (`server.ts:5768`) — mirroring `auth/session.ts`'s own `parseCookieHeader` existing
 * for exactly the same "one HTTP surface, two request shapes" reason. Header lookups are
 * case-insensitive by HTTP spec and both Node's raw headers object and Hono already normalize to
 * lowercase, so this does no case-folding of its own — pass the lowercase name through.
 */
export function readForwardedPrincipalHeaders(getHeader: (name: string) => string | undefined | null): ForwardedPrincipalHeaders {
  return {
    principal: getHeader(X_CEZAR_PRINCIPAL_HEADER) ?? undefined,
    signature: getHeader(X_CEZAR_SIGNATURE_HEADER) ?? undefined,
  };
}
