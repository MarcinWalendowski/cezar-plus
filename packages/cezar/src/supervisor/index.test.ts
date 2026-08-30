import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildSupervisorApp,
  resolveSupervisorBootGate,
  runSupervisorBootGate,
  supervisorBootLines,
  type SupervisorBootGateIo,
} from './index.ts';
import { resolveBootstrapClaim } from '../auth/bootstrap-claim.ts';
import type { AuthProvider } from '@loki-labs/cezar-plus-contract';
import { IdentityStore } from '../auth/identity-store.ts';
import { OrgProcessRegistryStore } from './org-registry-store.ts';

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

/**
 * **ADDED 2026-08-07 (5b/5c/8 repair stage) — the wiring nothing tested.**
 *
 * `SupervisorAppDeps` making `inviteRoutes`/`teamRoutes` REQUIRED enforces the field's *presence*,
 * never its *value*: replacing both arguments in `startSupervisor` with `new Hono()` left the whole
 * suite (382 files / 6851 tests) green, because `./server.test.ts` builds its own deps and this file
 * covered the boot gate and nothing else. That is the same "mounted on one topology and not the
 * other" regression the 5b/5c/8 integration pass already had to fix once, re-arriving through the
 * one call site with no test — and on the D10 topology it means every `/auth/invites*` and
 * `/auth/teams*` request 404s, on the only topology where a second org exists at all.
 *
 * `startSupervisor` itself is still not called here (it binds a port); `buildSupervisorApp` is the
 * part of it that decides which routers get mounted, split out for exactly this reason. The
 * assertion is 401-not-404: a mounted route that refuses is the route running, and a 404 is the
 * signature of a router that isn't there.
 */
describe('buildSupervisorApp — the /auth/* families are actually mounted', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function app(): Promise<ReturnType<typeof buildSupervisorApp>> {
    const identityDir = await mkdtemp(join(tmpdir(), 'cezar-supervisor-identity-'));
    const registryDir = await mkdtemp(join(tmpdir(), 'cezar-supervisor-registry-'));
    dirs.push(identityDir, registryDir);
    return buildSupervisorApp({
      identityStore: IdentityStore.open(identityDir),
      orgProcessRegistry: OrgProcessRegistryStore.open(registryDir),
      adminToken: undefined,
    });
  }

  it.each([
    // `authRoutes` answers 500 here rather than 401 because `vitest.setup.ts` deletes `CEZ_AUTH`
    // for every worker (the Risks section's "a guard the suite cannot reach"), and that module
    // fails closed when it is imported with no provider configured. Either way it is the ROUTER
    // answering — which is the whole assertion: a missing mount is a 404, and 404 is the one status
    // no row here may produce.
    ['GET', '/auth/me', 500],
    ['GET', '/auth/onboarding', 401],
    // 5b — the family that 404'd on this topology once already.
    ['GET', '/auth/invites', 401],
    ['POST', '/auth/invites', 401],
    ['POST', '/auth/invites/revoke', 401],
    ['POST', '/auth/invites/redeem', 401],
    // 5c.
    ['GET', '/auth/teams', 401],
    ['POST', '/auth/teams', 401],
    ['PATCH', '/auth/teams/team_x', 401],
    ['DELETE', '/auth/teams/team_x', 401],
  ] as const)('%s %s answers %i — the router ran, it did not 404', async (method, path, status) => {
    const res = await (
      await app()
    ).request(path, {
      method,
      // Same-origin: the `/auth/*` CSRF guard would answer 403 for a cross-origin write, which is a
      // different (also correct) refusal and would mask the 404 this test exists to catch.
      headers: { 'content-type': 'application/json', host: 'localhost', origin: 'http://localhost' },
      ...(method === 'GET' || method === 'DELETE' ? {} : { body: '{}' }),
    });
    expect([method, path, res.status]).toEqual([method, path, status]);
    expect(res.status).not.toBe(404);
  });
});

/**
 * The supervisor is the ONLY process that mounts `POST /auth/onboarding/org` on the D10 topology
 * (nginx proxies every org vhost's `location /auth/` to it), so it is the only process that can
 * print the deployment-wide bootstrap code the route demands. It printed one line — the provider
 * and port — and never the code, which made the first organization unclaimable on `--platform
 * hetzner` unless the operator pinned `CEZ_AUTH_BOOTSTRAP_TOKEN` at install time, while
 * `docs/server-install/hetzner.md` told them to grep the journal for it.
 *
 * `env` is a parameter to `resolveBootstrapClaim`, so nothing here touches `process.env` — same
 * discipline as the boot-gate tables above.
 */
describe('supervisorBootLines — the bootstrap code reaches the journal', () => {
  const generated = () => resolveBootstrapClaim({ CEZ_AUTH: 'google' }, () => 'c0de-minted-at-boot');

  it('generated mode, no org yet: the code itself is printed', () => {
    const lines = supervisorBootLines({
      provider: 'google',
      port: 4400,
      claim: generated(),
      hasOrg: false,
    });
    expect(lines.join('\n')).toContain('c0de-minted-at-boot');
  });

  it('still prints the provider/port line it always printed', () => {
    const lines = supervisorBootLines({
      provider: 'oidc',
      port: 4400,
      claim: generated(),
      hasOrg: false,
    });
    expect(lines[0]).toContain('cezar-plus supervisor');
    expect(lines[0]).toContain('oidc');
    expect(lines[0]).toContain('4400');
  });

  it('once the org exists the code is gone — a leaked code after onboarding grants nothing, and printing it forever is noise', () => {
    const lines = supervisorBootLines({
      provider: 'google',
      port: 4400,
      claim: generated(),
      hasOrg: true,
    });
    expect(lines.join('\n')).not.toContain('c0de-minted-at-boot');
    expect(lines).toHaveLength(1);
  });

  it('preset mode prints no code — the operator chose the value and it must not be echoed into the journal', () => {
    const lines = supervisorBootLines({
      provider: 'google',
      port: 4400,
      claim: resolveBootstrapClaim({ CEZ_AUTH: 'google', CEZ_AUTH_BOOTSTRAP_TOKEN: 'operator-picked' }),
      hasOrg: false,
    });
    expect(lines.join('\n')).not.toContain('operator-picked');
    expect(lines).toHaveLength(1);
  });

  it('CEZ_AUTH_BOOTSTRAP_OPEN=1 warns instead — whoever signs in first owns a shell on this host', () => {
    const lines = supervisorBootLines({
      provider: 'google',
      port: 4400,
      claim: resolveBootstrapClaim({ CEZ_AUTH: 'google', CEZ_AUTH_BOOTSTRAP_OPEN: '1' }),
      hasOrg: false,
    });
    expect(lines.join('\n')).toContain('CEZ_AUTH_BOOTSTRAP_OPEN=1');
    expect(lines).toHaveLength(2);
  });
});
