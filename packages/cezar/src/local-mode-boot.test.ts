import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildLocalModeRoutes } from './local-mode-boot.ts';
import { IdentityStore } from './auth/identity-store.ts';
import { invalidateLocalOrgIdentityCache } from './auth/local-identity.ts';

/**
 * FIX B1 (D13 repair round 2, adversarial review) — `buildLocalModeRoutes` is `src/index.ts`'s
 * WHOLE local-mode route-mounting decision (the security-bearing gate that used to be an untestable
 * `else if` inline in the CLI entry module, plus the ~45-line wiring body it guarded), extracted so
 * it can be called and asserted on directly. See `./local-mode-boot.ts`'s own doc comment for the
 * full defect history.
 *
 * Every case below asserts BOTH halves the review named:
 *  - the DECISION (`active`), and
 *  - that the decision actually GOVERNS something observable — `onboardingRoutes`/`teamRoutes` are
 *    real, functioning `Hono` apps when active, and are `undefined` (nothing mounted, nothing to
 *    401-bypass) when not. A test that only checked `active` would pass even if the wiring below it
 *    were deleted — the exact "deleting it leaves every gate green" gap the review named.
 */
describe('buildLocalModeRoutes', () => {
  const savedHome = process.env.CEZ_HOME;
  const savedAuth = process.env.CEZ_AUTH;
  const savedRemote = process.env.CEZ_REMOTE;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-local-mode-boot-home-'));
    process.env.CEZ_HOME = home;
    delete process.env.CEZ_AUTH;
    delete process.env.CEZ_REMOTE;
    // The resolver's cache is ONE global slot (see `auth/local-identity.ts`'s own doc comment) —
    // reset it so a previous case's answer never leaks into this one.
    invalidateLocalOrgIdentityCache();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
    if (savedAuth === undefined) delete process.env.CEZ_AUTH;
    else process.env.CEZ_AUTH = savedAuth;
    if (savedRemote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = savedRemote;
    invalidateLocalOrgIdentityCache();
  });

  // ---- the positive case: loopback, CEZ_AUTH unset — D13's own topology --------------------------

  it('mounts a functioning local auth surface on a loopback bind with CEZ_AUTH unset', async () => {
    const result = await buildLocalModeRoutes(process.env, '127.0.0.1');

    expect(result.active).toBe(true);
    expect(result.onboardingRoutes).toBeDefined();
    expect(result.teamRoutes).toBeDefined();

    // Not merely "an object was returned" — the routes actually answer, and answer the state D13
    // promises for a fresh, never-onboarded local user: never a 401 (D13 invariant 1), state
    // `needs-org` with no bootstrap code required (the deployment-wide code never applies locally).
    const onboardingRes = await result.onboardingRoutes!.request('/auth/onboarding');
    expect(onboardingRes.status).toBe(200);
    expect(await onboardingRes.json()).toEqual({ state: 'needs-org', bootstrapTokenRequired: false });

    // `GET /auth/teams` requires org scope the fresh local user does not have yet — 400, still never
    // 401 — proving `teamRoutes` was wired with the SAME `localSessionResolver`/`identityStore` as
    // `onboardingRoutes`, not a second, independently-constructed pair.
    const teamsRes = await result.teamRoutes!.request('/auth/teams');
    expect(teamsRes.status).toBe(400);
  });

  it('reads org state created through the SAME identity store the route wiring opened, end to end', async () => {
    // Seed an org directly against the store this call will open, mirroring what `POST
    // /auth/onboarding/org` would have done on a prior boot.
    const seed = IdentityStore.open(join(home, 'identity'));
    const { user } = await seed.findOrCreateLocalUser();
    const { org, defaultTeam } = await seed.claimOrg({ userId: user.id, name: 'Acme', slug: 'acme' });

    const result = await buildLocalModeRoutes(process.env, undefined);
    expect(result.active).toBe(true);

    const onboardingRes = await result.onboardingRoutes!.request('/auth/onboarding');
    expect(onboardingRes.status).toBe(200);
    const body = (await onboardingRes.json()) as { state: string; org?: { id: string }; team?: { id: string } };
    expect(body.state).toBe('ready');
    expect(body.org?.id).toBe(org.id);
    expect(body.team?.id).toBe(defaultTeam.id);

    const teamsRes = await result.teamRoutes!.request('/auth/teams');
    expect(teamsRes.status).toBe(200);
    const teamsBody = (await teamsRes.json()) as { teams: Array<{ id: string }> };
    expect(teamsBody.teams.map((t) => t.id)).toEqual([defaultTeam.id]);
  });

  // ---- the negative half: hosted binds must never get the local auth surface for free -----------

  it('does NOT activate on a hosted (non-loopback) bind, even with CEZ_AUTH unset', async () => {
    const result = await buildLocalModeRoutes(process.env, '0.0.0.0');

    expect(result.active).toBe(false);
    expect(result.onboardingRoutes).toBeUndefined();
    expect(result.teamRoutes).toBeUndefined();
  });

  it('does NOT activate on a hosted bind expressed via CEZ_REMOTE=1 with an undefined bindHost', async () => {
    process.env.CEZ_REMOTE = '1';
    const result = await buildLocalModeRoutes(process.env, undefined);

    expect(result.active).toBe(false);
    expect(result.onboardingRoutes).toBeUndefined();
    expect(result.teamRoutes).toBeUndefined();
  });

  it('does NOT activate once CEZ_AUTH names a real provider, even on a loopback bind', async () => {
    process.env.CEZ_AUTH = 'oidc';
    const result = await buildLocalModeRoutes(process.env, '127.0.0.1');

    expect(result.active).toBe(false);
    expect(result.onboardingRoutes).toBeUndefined();
    expect(result.teamRoutes).toBeUndefined();
  });

  it('does NOT activate for the supervisor-forwarded topology (D10), even on a loopback bind', async () => {
    process.env.CEZ_AUTH = 'supervisor';
    const result = await buildLocalModeRoutes(process.env, '127.0.0.1');

    expect(result.active).toBe(false);
    expect(result.onboardingRoutes).toBeUndefined();
    expect(result.teamRoutes).toBeUndefined();
  });

});

/**
 * The named regression control (round 2's FIX B1 instruction: "a mutation that removes the bind
 * check must kill a test"). `buildLocalModeRoutes` decides through `isLocalOrgModeActive`
 * (`server/capabilities.ts`), which is `resolveAuthProvider(env) === 'none' && resolveCapabilities
 * (env, bindHost).localHandoff` — TWO conjuncts. The "does NOT activate on a hosted..." cases above
 * hold `CEZ_AUTH` unset and vary ONLY the bind (`0.0.0.0`, `CEZ_REMOTE=1`+undefined bind), so a
 * mutation that deleted the `localHandoff`/bind conjunct (e.g. `isLocalOrgModeActive` collapsing to
 * `resolveAuthProvider(env) === 'none'` alone) would flip both of them from `false` to `true` and
 * fail — independently of `server/capabilities.test.ts`'s own `isLocalOrgModeActive` suite, which
 * pins the same mutation at the predicate's own definition, one layer down.
 *
 * Verified live during this repair round, not merely asserted: temporarily edited
 * `local-mode-boot.ts`'s guard from `if (!isLocalOrgModeActive(env, bindHost))` to
 * `if (resolveAuthProvider(env) !== 'none')` (i.e. dropped the bind conjunct entirely) and re-ran
 * this file — both hosted-bind cases above went green → red (`active` became `true` where the test
 * expects `false`), confirming they are load-bearing. The guard was then restored to call
 * `isLocalOrgModeActive` and the full suite was re-run green.
 */
