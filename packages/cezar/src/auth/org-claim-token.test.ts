import { describe, expect, it } from 'vitest';
import { hashOrgClaimToken, matchesOrgClaimToken, mintOrgClaimToken } from './org-claim-token.ts';

/**
 * The per-org claim-code contract (D11's crux — see `org-claim-token.ts`'s own module doc comment).
 * Pure functions, no filesystem, no store — the same "walk the pure contract in isolation" shape
 * `bootstrap-claim.test.ts` already uses for the deployment-wide code.
 */

describe('mintOrgClaimToken', () => {
  it('draws real entropy — 128 bits, hex, and not a constant', () => {
    const a = mintOrgClaimToken();
    const b = mintOrgClaimToken();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(b).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});

describe('hashOrgClaimToken', () => {
  it('is deterministic — same input, same 64-hex-char digest', () => {
    const token = mintOrgClaimToken();
    expect(hashOrgClaimToken(token)).toBe(hashOrgClaimToken(token));
    expect(hashOrgClaimToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('two different tokens hash to two different digests', () => {
    expect(hashOrgClaimToken('token-a')).not.toBe(hashOrgClaimToken('token-b'));
  });
});

describe('matchesOrgClaimToken', () => {
  const token = mintOrgClaimToken();
  const hash = hashOrgClaimToken(token);

  it('accepts the exact raw token against its own hash', () => {
    expect(matchesOrgClaimToken(hash, token)).toBe(true);
  });

  it('rejects a wrong, absent, or differently-cased token', () => {
    for (const supplied of [undefined, '', 'wrong', token.toUpperCase(), `${token}x`, token.slice(0, -1)]) {
      expect(matchesOrgClaimToken(hash, supplied)).toBe(false);
    }
  });

  it("one org's token never matches another org's hash — the whole point of a PER-ORG code", () => {
    const otherToken = mintOrgClaimToken();
    const otherHash = hashOrgClaimToken(otherToken);
    expect(otherHash).not.toBe(hash);
    expect(matchesOrgClaimToken(hash, otherToken)).toBe(false);
    expect(matchesOrgClaimToken(otherHash, token)).toBe(false);
  });
});
