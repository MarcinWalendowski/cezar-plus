import { describe, expect, it } from 'vitest';
import { hasOrgScope, resolvePrincipal, type SessionIdentity } from './principal.ts';

/**
 * Both modes go through the SAME `resolvePrincipal` call below: no test-only shortcut that
 * constructs a `Principal` by hand for either branch. That mirrors the constraint the module
 * itself is built to (D3): a test with two separate construction paths would defeat the point
 * of the production code having only one.
 */
describe('resolvePrincipal', () => {
  // D13: this assertion is a snapshot of THIS file's own output, not one of the three security/
  // design controls named by the phase-9 invariants (those live in `projects-api.test.ts`,
  // `capabilities.test.ts`, `auth-perimeter.test.ts` and assert HTTP-layer behaviour, never a bare
  // `resolvePrincipal` return value) — so unlike those, it is expected to change here, and it is
  // the change D13 asks for by name: "the no-org local case returns `orgId: null, teamId: null`
  // (NOT 'local')."
  it("auth off with no local org resolves a real principal with a NULL org/team (D13 invariant 3: never coerced to 'local')", () => {
    const principal = resolvePrincipal({ authProvider: 'none' });

    expect(principal).toBeDefined();
    expect(principal).not.toBeNull();
    expect(typeof principal).toBe('object');
    expect(principal).toEqual({
      kind: 'local',
      userId: 'local',
      orgId: null,
      teamId: null,
      role: 'owner',
    });
    expect(hasOrgScope(principal)).toBe(false);
  });

  it("auth off WITH a resolved local org identity resolves kind: 'local' plus the REAL ids, never the implicit no-org identity (D13)", () => {
    const identity: SessionIdentity = {
      userId: 'usr_local_abc',
      orgId: 'org_local_one',
      teamId: 'team_local_general',
      role: 'owner',
    };

    const principal = resolvePrincipal({ authProvider: 'none', identity });

    expect(principal).toEqual({
      kind: 'local',
      userId: 'usr_local_abc',
      orgId: 'org_local_one',
      teamId: 'team_local_general',
      role: 'owner',
    });
    expect(hasOrgScope(principal)).toBe(true);
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

/**
 * D13's replacement for the five call sites' old `principal.kind === 'session'` check. These
 * exercise `hasOrgScope` directly against every `Principal` shape `resolvePrincipal` can actually
 * produce, rather than only against `resolvePrincipal`'s own output above — `hasOrgScope` is a
 * public, independently-callable predicate, and a future caller building a `Principal` by hand
 * (a test double, say) must get the same answer `resolvePrincipal`'s own callers do.
 */
describe('hasOrgScope', () => {
  it('is false for the implicit no-org local principal (D13: the common, un-onboarded case)', () => {
    expect(hasOrgScope(resolvePrincipal({ authProvider: 'none' }))).toBe(false);
  });

  it('is true for a local principal carrying a resolved org (D13: auth off, org created)', () => {
    const identity: SessionIdentity = { userId: 'u', orgId: 'org_x', teamId: 'team_x', role: 'owner' };
    expect(hasOrgScope(resolvePrincipal({ authProvider: 'none', identity }))).toBe(true);
  });

  it('is true for every authenticated-session principal, every role', () => {
    for (const role of ['owner', 'admin', 'member'] as const) {
      const identity: SessionIdentity = { userId: 'u', orgId: 'org_x', teamId: 'team_x', role };
      expect(hasOrgScope(resolvePrincipal({ authProvider: 'oidc', identity }))).toBe(true);
    }
  });

  // D13's whole reason for introducing this predicate: `kind` must stop standing in for "has an
  // org". A hand-built principal with `kind: 'session'` (the OLD, pre-D13 signal for "has a real
  // org") but a null org/team must still read as scopeless — proving `hasOrgScope` is keyed on
  // the id fields themselves, never on `kind`, which is what makes it correct for D13's new
  // `kind: 'local'`-with-a-real-org case above.
  it("is keyed on orgId/teamId nullability, never on kind — a 'session' principal with no org still reads as scopeless", () => {
    const phantom = { kind: 'session' as const, userId: 'u', orgId: null, teamId: null, role: 'member' as const };
    expect(hasOrgScope(phantom)).toBe(false);
  });

  it('narrows orgId/teamId to non-null strings inside the guarded branch (compile-time check)', () => {
    const principal = resolvePrincipal({ authProvider: 'none' });
    if (hasOrgScope(principal)) {
      // If this compiles, `orgId`/`teamId` are narrowed to `string` here — assigning to a
      // `string`-typed local would fail to compile if the guard did not narrow.
      const orgId: string = principal.orgId;
      const teamId: string = principal.teamId;
      expect(orgId).toEqual(teamId); // unreachable for the no-org identity; asserted only to use the vars
    } else {
      expect(principal.orgId).toBeNull();
    }
  });
});
