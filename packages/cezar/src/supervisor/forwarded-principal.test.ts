import { describe, expect, it } from 'vitest';
import {
  forwardedPrincipalPayloadSchema,
  principalFromForwardedPayload,
  readForwardedPrincipalHeaders,
  signForwardedPrincipal,
  verifyForwardedPrincipal,
  X_CEZAR_PRINCIPAL_HEADER,
  X_CEZAR_SIGNATURE_HEADER,
  type ForwardedPrincipalPayload,
} from './forwarded-principal.ts';

const SECRET = 'a'.repeat(32);
const OTHER_SECRET = 'b'.repeat(32);

function payload(overrides: Partial<ForwardedPrincipalPayload> = {}, now = new Date()): ForwardedPrincipalPayload {
  return {
    userId: 'user_1',
    orgId: 'org_acme',
    teamId: 'team_general',
    role: 'owner',
    issuedAt: now.toISOString(),
    ...overrides,
  };
}

describe('signForwardedPrincipal / verifyForwardedPrincipal — the supervisor -> org-process trust channel', () => {
  it('round-trips: a signature minted with the org secret verifies with the same secret', () => {
    const p = payload();
    const signed = signForwardedPrincipal(p, SECRET);
    const verified = verifyForwardedPrincipal(signed.principalHeader, signed.signatureHeader, SECRET);
    expect(verified).toEqual(p);
  });

  it('refuses a signature minted with a DIFFERENT org secret — the cross-org forgery this exists to stop', () => {
    const signed = signForwardedPrincipal(payload(), OTHER_SECRET);
    expect(verifyForwardedPrincipal(signed.principalHeader, signed.signatureHeader, SECRET)).toBeNull();
  });

  it('refuses a tampered principal header (payload edited after signing)', () => {
    const signed = signForwardedPrincipal(payload({ role: 'member' }), SECRET);
    const tampered = signForwardedPrincipal(payload({ role: 'owner' }), SECRET).principalHeader;
    expect(verifyForwardedPrincipal(tampered, signed.signatureHeader, SECRET)).toBeNull();
  });

  it('refuses a tampered signature (one byte flipped)', () => {
    const signed = signForwardedPrincipal(payload(), SECRET);
    const flipped = signed.signatureHeader.slice(0, -1) + (signed.signatureHeader.at(-1) === 'A' ? 'B' : 'A');
    expect(verifyForwardedPrincipal(signed.principalHeader, flipped, SECRET)).toBeNull();
  });

  it('refuses a stale payload past maxAgeMs', () => {
    const old = new Date(Date.now() - 5 * 60_000);
    const signed = signForwardedPrincipal(payload({}, old), SECRET);
    expect(
      verifyForwardedPrincipal(signed.principalHeader, signed.signatureHeader, SECRET, { maxAgeMs: 60_000 }),
    ).toBeNull();
  });

  it('accepts a payload within maxAgeMs at a fixed clock', () => {
    const issuedAt = new Date('2026-08-07T12:00:00.000Z');
    const signed = signForwardedPrincipal(payload({}, issuedAt), SECRET);
    const verified = verifyForwardedPrincipal(signed.principalHeader, signed.signatureHeader, SECRET, {
      now: () => new Date('2026-08-07T12:00:30.000Z'),
      maxAgeMs: 60_000,
    });
    expect(verified?.userId).toBe('user_1');
  });

  it('refuses a payload dated into the future — a clock disagreement is refused, never guessed at', () => {
    const future = new Date(Date.now() + 5 * 60_000);
    const signed = signForwardedPrincipal(payload({}, future), SECRET);
    expect(verifyForwardedPrincipal(signed.principalHeader, signed.signatureHeader, SECRET)).toBeNull();
  });

  it('refuses malformed base64/JSON without throwing', () => {
    expect(verifyForwardedPrincipal('not-valid-base64url-json!!', 'whatever-sig', SECRET)).toBeNull();
  });

  it('refuses a well-formed but schema-invalid payload (unknown role), correctly signed', () => {
    // `as ForwardedPrincipalPayload` deliberately lies to the type system — the whole point is to
    // prove the RUNTIME schema check (`.strict()` + the role enum), not TypeScript, is what gates
    // an invalid value that was still signed correctly (e.g. by a future supervisor build that
    // accepts a role this one does not yet know).
    const invalid = { ...payload(), role: 'superadmin' } as unknown as ForwardedPrincipalPayload;
    const signed = signForwardedPrincipal(invalid, SECRET);
    expect(verifyForwardedPrincipal(signed.principalHeader, signed.signatureHeader, SECRET)).toBeNull();
  });

  it('refuses missing headers, and an empty secret, without throwing', () => {
    expect(verifyForwardedPrincipal(undefined, undefined, SECRET)).toBeNull();
    const signed = signForwardedPrincipal(payload(), SECRET);
    expect(verifyForwardedPrincipal(signed.principalHeader, signed.signatureHeader, '')).toBeNull();
  });

  it('forwardedPrincipalPayloadSchema is .strict() — an extra key is rejected, unlike every on-disk identity schema', () => {
    const withExtra = { ...payload(), extra: 'nope' };
    expect(forwardedPrincipalPayloadSchema.safeParse(withExtra).success).toBe(false);
  });
});

describe('principalFromForwardedPayload', () => {
  it('maps to kind: session, matching what a locally-resolved oidc/google session already produces', () => {
    const principal = principalFromForwardedPayload(payload());
    expect(principal).toEqual({ kind: 'session', userId: 'user_1', orgId: 'org_acme', teamId: 'team_general', role: 'owner' });
  });
});

describe('readForwardedPrincipalHeaders', () => {
  it('reads both headers by their fixed lowercase names', () => {
    const headers = new Map([
      [X_CEZAR_PRINCIPAL_HEADER, 'p'],
      [X_CEZAR_SIGNATURE_HEADER, 's'],
    ]);
    const result = readForwardedPrincipalHeaders((name) => headers.get(name) ?? null);
    expect(result).toEqual({ principal: 'p', signature: 's' });
  });

  it('reads undefined for an absent header rather than null, matching cookieHeader-style callers', () => {
    const result = readForwardedPrincipalHeaders(() => null);
    expect(result).toEqual({ principal: undefined, signature: undefined });
  });
});
