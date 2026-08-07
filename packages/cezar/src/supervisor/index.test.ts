import { describe, expect, it } from 'vitest';
import { resolveSupervisorBootGate, runSupervisorBootGate, type SupervisorBootGateIo } from './index.ts';
import type { AuthProvider } from '@open-mercato/cezar-contract';

/**
 * The supervisor's own boot gate — deliberately a ONE-ROW table, unlike `auth-boot-gate.ts`'s D1
 * table: the supervisor has no `CEZ_ALLOW_UNAUTHENTICATED=1` escape hatch, because "my network is
 * the perimeter instead of a login" is incoherent for the one process whose job IS producing the
 * signed principal every org process behind it trusts (D10). `env` is a parameter on both
 * functions, so nothing here mutates `process.env` — matching `auth-boot-gate.test.ts`'s own
 * no-cross-file-leakage discipline.
 *
 * `startSupervisor` (the impure boot: opens `IdentityStore`, binds a port) is deliberately NOT
 * exercised here — this pass runs under an explicit rule against starting a server or opening a
 * listening socket, on `auth-boot-gate.ts`'s own precedent that a CLI-adjacent side effect is
 * untestable by construction without spawning a real process anyway.
 */

function recordingIo(): SupervisorBootGateIo & { errors: string[]; exits: number[] } {
  const errors: string[] = [];
  const exits: number[] = [];
  return { errors, exits, error: (m) => errors.push(m), exit: (c) => exits.push(c) };
}

describe('resolveSupervisorBootGate', () => {
  it('CEZ_AUTH unset: refuses, naming the reason', () => {
    const gate = resolveSupervisorBootGate({});
    expect(gate.proceed).toBe(false);
    expect(gate.provider).toBe('none');
    expect(gate.message).toContain('refuses to boot');
    expect(gate.message).toContain('CEZ_AUTH');
  });

  it('CEZ_AUTH=none (explicit): refuses the same way as unset', () => {
    expect(resolveSupervisorBootGate({ CEZ_AUTH: 'none' }).proceed).toBe(false);
  });

  it.each(['oidc', 'google'] as const)('CEZ_AUTH=%s: proceeds, no message', (provider) => {
    const gate = resolveSupervisorBootGate({ CEZ_AUTH: provider });
    expect(gate).toEqual({ proceed: true, provider });
  });

  /**
   * **The row phase 6 CREATED, which neither list above covered.** ADDED 2026-08-07 at the repair
   * stage, found by mutation testing: this gate's whole decision was `provider === 'none'`, and
   * `resolveAuthProvider` had just been taught `'supervisor'` — so a copy-paste of an ORG unit's
   * `Environment=CEZ_AUTH=supervisor` onto the supervisor's own unit BOOTED, and then mounted
   * `authRoutes` for a provider `OidcProvider` (`oidc | google`) cannot express. It failed at the
   * first login attempt with a message about `CEZ_PUBLIC_URL` instead of at boot with the one
   * written for exactly this mistake.
   *
   * A gate whose refusal set is written as an allow-list of known-bad values grows a hole every
   * time the enum grows; asserting the third value here is what makes the next one visible.
   */
  it('CEZ_AUTH=supervisor: refuses — that value names an ORG process, not a provider', () => {
    const gate = resolveSupervisorBootGate({ CEZ_AUTH: 'supervisor' });
    expect(gate.proceed).toBe(false);
    expect(gate.provider).toBe('supervisor');
    // The message must be the one written for THIS mistake, not the generic "CEZ_AUTH is unset":
    // an operator who did set it needs to be told the value is wrong, not that it is missing.
    expect(gate.message).toContain('names THIS process, not a provider');
  });

  it('every AuthProvider value is decided here — a new provider cannot default to "boots"', () => {
    // `authProviderSchema`'s literals, enumerated so that adding one and forgetting this gate is a
    // compile error at the `satisfies` below rather than a silently-booting supervisor.
    const providers = ['none', 'oidc', 'google', 'supervisor'] as const satisfies readonly AuthProvider[];
    const decided = Object.fromEntries(
      providers.map((p) => [p, resolveSupervisorBootGate({ CEZ_AUTH: p }).proceed]),
    );
    expect(decided).toEqual({ none: false, oidc: true, google: true, supervisor: false });
  });

  it('CEZ_ALLOW_UNAUTHENTICATED=1 does NOT substitute for CEZ_AUTH here — the supervisor has no opt-out', () => {
    // Unlike `auth-boot-gate.ts`'s D1 table, this flag means nothing to the supervisor: it is not
    // one process among several deciding "my network is my perimeter", it IS the perimeter.
    const gate = resolveSupervisorBootGate({ CEZ_ALLOW_UNAUTHENTICATED: '1' });
    expect(gate.proceed).toBe(false);
  });
});

describe('runSupervisorBootGate', () => {
  it('refusal: prints the message to error() and exits 1', () => {
    const io = recordingIo();
    const gate = runSupervisorBootGate({}, io);
    expect(gate.proceed).toBe(false);
    expect(io.errors).toHaveLength(1);
    expect(io.exits).toEqual([1]);
  });

  it('success: no error, no exit call', () => {
    const io = recordingIo();
    const gate = runSupervisorBootGate({ CEZ_AUTH: 'oidc' }, io);
    expect(gate.proceed).toBe(true);
    expect(io.errors).toEqual([]);
    expect(io.exits).toEqual([]);
  });
});
