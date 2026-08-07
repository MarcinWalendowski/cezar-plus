import { describe, expect, it } from 'vitest';
import { verifyForwardedPrincipal } from './forwarded-principal.ts';
import { resolveAuthCheck, type AuthCheckDeps } from './auth-request.ts';
import type { OrgProcessRecord } from './org-process-registry.ts';
import type { Principal } from '../server/server.ts';

const SECRET_A = 'a'.repeat(32);
const SECRET_B = 'b'.repeat(32);

function orgRecord(overrides: Partial<OrgProcessRecord> = {}): OrgProcessRecord {
  return {
    orgId: 'org_acme',
    orgSlug: 'acme',
    unixUser: 'cez-acme',
    cezHome: '/var/lib/cezar/orgs/acme',
    loopbackPort: 4400,
    hostname: 'acme.cezar.example.com',
    platformId: 'hetzner',
    supervisorSecret: SECRET_A,
    status: 'active',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function deps(overrides: Partial<AuthCheckDeps> = {}): AuthCheckDeps {
  return {
    sessionResolver: { resolveFromCookieHeader: () => null },
    getActiveOrgProcess: () => undefined,
    ...overrides,
  };
}

describe('resolveAuthCheck', () => {
  it('no session -> unauthenticated, nothing signed', () => {
    const result = resolveAuthCheck('cez_session=nope', deps());
    expect(result).toEqual({ ok: false, reason: 'unauthenticated' });
  });

  it("a 'local' principal (should never happen once CEZ_AUTH names a provider) is refused, not signed", () => {
    const principal: Principal = { kind: 'local', userId: 'u1', orgId: 'org_acme', teamId: 'team_1', role: 'owner' };
    const result = resolveAuthCheck('cookie', deps({ sessionResolver: { resolveFromCookieHeader: () => principal } }));
    expect(result).toEqual({ ok: false, reason: 'unauthenticated' });
  });

  it("a resolved session whose org has no active process -> refused, not signed with a stale/missing secret", () => {
    const principal: Principal = { kind: 'session', userId: 'u1', orgId: 'org_acme', teamId: 'team_1', role: 'member' };
    const result = resolveAuthCheck(
      'cookie',
      deps({ sessionResolver: { resolveFromCookieHeader: () => principal }, getActiveOrgProcess: () => undefined }),
    );
    expect(result).toEqual({ ok: false, reason: 'org-has-no-active-process' });
  });

  it('a resolved session signs a payload that verifies against that SAME org\'s secret', () => {
    const principal: Principal = { kind: 'session', userId: 'u1', orgId: 'org_acme', teamId: 'team_1', role: 'admin' };
    const now = () => new Date('2026-08-07T12:00:00.000Z');
    const result = resolveAuthCheck(
      'cookie',
      deps({
        sessionResolver: { resolveFromCookieHeader: () => principal },
        getActiveOrgProcess: (orgId) => (orgId === 'org_acme' ? orgRecord() : undefined),
        now,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    const verified = verifyForwardedPrincipal(result.headers.principalHeader, result.headers.signatureHeader, SECRET_A, { now });
    expect(verified).toEqual({ userId: 'u1', orgId: 'org_acme', teamId: 'team_1', role: 'admin', issuedAt: now().toISOString() });
  });

  it('a caller signed for org A can never verify at org B\'s secret — cross-org isolation lives at the receiving process, not this check', () => {
    const principal: Principal = { kind: 'session', userId: 'u1', orgId: 'org_acme', teamId: 'team_1', role: 'owner' };
    const result = resolveAuthCheck(
      'cookie',
      deps({
        sessionResolver: { resolveFromCookieHeader: () => principal },
        getActiveOrgProcess: () => orgRecord({ supervisorSecret: SECRET_A }),
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    // Org B's own process would verify with ITS OWN secret, not org A's — the signature fails.
    expect(verifyForwardedPrincipal(result.headers.principalHeader, result.headers.signatureHeader, SECRET_B)).toBeNull();
  });
});
