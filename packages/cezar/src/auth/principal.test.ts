import { describe, expect, it } from 'vitest';
import { resolvePrincipal, type SessionIdentity } from './principal.ts';

/**
 * Both modes go through the SAME `resolvePrincipal` call below: no test-only shortcut that
 * constructs a `Principal` by hand for either branch. That mirrors the constraint the module
 * itself is built to (D3): a test with two separate construction paths would defeat the point
 * of the production code having only one.
 */
describe('resolvePrincipal', () => {
  it('auth off resolves a real, fully-populated local principal (not undefined/null)', () => {
    const principal = resolvePrincipal({ authProvider: 'none' });

    expect(principal).toBeDefined();
    expect(principal).not.toBeNull();
    expect(typeof principal).toBe('object');
    expect(principal).toEqual({
      kind: 'local',
      userId: 'local',
      orgId: 'local',
      teamId: 'local',
      role: 'owner',
    });
  });

  it('auth off always resolves the SAME implicit identity regardless of call site', () => {
    // Two independent calls, as two different request handlers would make. If this module ever
    // grew a second "off" construction path, this is the test that would catch the two diverging.
    const first = resolvePrincipal({ authProvider: 'none' });
    const second = resolvePrincipal({ authProvider: 'none' });
    expect(first).toEqual(second);
  });

  it('auth on (oidc) resolves from the already-resolved session identity, not the local one', () => {
    const identity: SessionIdentity = {
      userId: 'usr_alice',
      orgId: 'org_acme',
      teamId: 'team_engineering',
      role: 'admin',
    };

    const principal = resolvePrincipal({ authProvider: 'oidc', identity });

    expect(principal).toEqual({
      kind: 'session',
      userId: 'usr_alice',
      orgId: 'org_acme',
      teamId: 'team_engineering',
      role: 'admin',
    });
  });

  it('auth on (google) resolves from the session identity through the same entry point', () => {
    const identity: SessionIdentity = {
      userId: 'usr_bob',
      orgId: 'org_acme',
      teamId: 'team_marketing',
      role: 'owner',
    };

    const principal = resolvePrincipal({ authProvider: 'google', identity });

    expect(principal.kind).toBe('session');
    expect(principal).toEqual({ kind: 'session', ...identity });
  });

  it('auth on (supervisor) resolves from the forwarded, already-verified identity through the same entry point (D10)', () => {
    // The org-process case (phase 6/7): by the time `resolvePrincipal` is called, a supervisor's
    // HMAC-signed forwarded principal has already been verified — this function does not know or
    // care that the identity came from a header instead of a cookie-backed session lookup.
    const identity: SessionIdentity = {
      userId: 'usr_dave',
      orgId: 'org_acme',
      teamId: 'team_engineering',
      role: 'member',
    };

    const principal = resolvePrincipal({ authProvider: 'supervisor', identity });

    expect(principal.kind).toBe('session');
    expect(principal).toEqual({ kind: 'session', ...identity });
  });

  it('never falls back to the local identity for an authenticated provider', () => {
    // The whole reason ResolvePrincipalInput is a discriminated union and not
    // `SessionIdentity | null`: there is no spelling of an authenticated call that can produce
    // the implicit local/local/local/owner identity. A caller with no resolved session must
    // 401 before ever reaching this function, not pass a null-ish identity into it.
    const identity: SessionIdentity = { userId: 'usr_carol', orgId: 'org_acme', teamId: 'team_x', role: 'member' };
    const principal = resolvePrincipal({ authProvider: 'oidc', identity });
    expect(principal.userId).not.toBe('local');
    expect(principal.orgId).not.toBe('local');
    expect(principal.teamId).not.toBe('local');
  });

  it('every membership role round-trips unchanged', () => {
    for (const role of ['owner', 'admin', 'member'] as const) {
      const identity: SessionIdentity = { userId: 'usr', orgId: 'org', teamId: 'team', role };
      expect(resolvePrincipal({ authProvider: 'oidc', identity }).role).toBe(role);
    }
  });
});
