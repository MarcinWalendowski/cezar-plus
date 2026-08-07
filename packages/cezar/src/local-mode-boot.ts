import type { Hono } from 'hono';
import { isLocalOrgModeActive } from './server/capabilities.ts';
import { listRegisteredProjectRoots } from './registered-project-roots.ts';

/**
 * D13's local-mode route-mounting decision (spec `.ai/specs/2026-08-06-org-team-auth-onboarding.md`),
 * extracted out of `src/index.ts#serveCommand` — **the same pattern, for the identical reason, as
 * `./auth-boot-gate.ts`** (see that module's own doc comment, point 1): `src/index.ts` is the CLI
 * entry, so importing it runs the CLI, and no unit test can reach a decision or a code path only
 * ever built inline there without spawning a real `cezar serve` process.
 *
 * **Why this one particularly could not stay inline.** Before this extraction, `serveCommand`'s
 * branch read:
 *
 * ```ts
 * } else if (resolveCapabilities(process.env, bindHost).localHandoff) {
 *   // ~45 lines: dynamic imports, IdentityStore.open, wire onboardingRoutes/teamRoutes
 * }
 * ```
 *
 * That single boolean is the ONLY thing standing between a hosted, unauthenticated deployment
 * (`CEZ_AUTH` unset + `CEZ_ALLOW_UNAUTHENTICATED=1`, D1's table — a real, permitted, NETWORK-FACING
 * topology) and mounting the full `/auth/onboarding*` + `/auth/teams*` route surface with a gate that
 * (`./auth/local-gates.ts`'s own doc comment) **never 401s, on purpose**, because it assumes loopback
 * already means "fully trusted". It had zero test coverage, and worse, it was only HALF the real
 * decision: the branch was reached via `if (gate.provider === 'supervisor') {…} else if
 * (gate.provider !== 'none') {…} else if (resolveCapabilities(…).localHandoff) {…}`, so the
 * `resolveAuthProvider(env) === 'none'` half of the predicate was never asked here at all — it was
 * *implied* by having fallen through the two prior branches. A refactor of that if/else chain (a
 * reordered branch, a new provider value slotted in the wrong place) could silently strand this
 * `else if` reachable when `CEZ_AUTH` names a real provider, and nothing here would notice, because
 * nothing here was asking.
 *
 * **The fix is `isLocalOrgModeActive` (`./server/capabilities.ts`), called directly rather than
 * relied on transitively.** That function already IS "the whole local-mode mounting decision" —
 * `resolveAuthProvider(env) === 'none' && resolveCapabilities(env, bindHost).localHandoff` — and it
 * already has its own mutation-killing unit tests (`server/capabilities.test.ts`,
 * `registered-project-roots.ts#registerAndAdoptProject`'s FIX A3 regression control). What was
 * missing was a caller at THIS seam that asks it directly instead of re-deriving one half of it
 * inline and inheriting the other half from control-flow position. `buildLocalModeRoutes` below
 * calls it as its own first statement, so the decision is self-contained at the call site and does
 * not depend on which branch of `serveCommand`'s if/else got here.
 *
 * **The ~45-line wiring branch is extracted too, not just the boolean**, because a decision with no
 * observable effect proves nothing: the review that asked for this fix named the wiring branch
 * itself as a second gap ("deleting it leaves every gate green"), since deleting the entire
 * `else if` body left `onboardingRoutes`/`teamRoutes` `undefined` — the server boots, every gate
 * passes, and local onboarding is just silently absent. `local-mode-boot.test.ts` calls this
 * function directly and asserts the *positive* case too: on a loopback bind, `active` is `true` and
 * `onboardingRoutes`/`teamRoutes` are real, mountable `Hono` instances.
 */

export interface LocalModeRoutes {
  /** `false` for every topology other than D13's own (`CEZ_AUTH` unset, loopback bind) — see
   *  `isLocalOrgModeActive`'s own doc comment for the full two-part predicate. When `false`, neither
   *  route field below is populated and nothing under `./auth/` or `./paths.ts` was imported: the
   *  early return happens before any dynamic `import()` runs. */
  readonly active: boolean;
  readonly onboardingRoutes?: Hono;
  readonly teamRoutes?: Hono;
}

/**
 * `env`/`bindHost` mirror `isLocalOrgModeActive`'s own signature exactly (same names, same
 * optionality) — this function does not introduce a second way to spell "which env, which bind".
 *
 * Dynamic, string-literal imports for everything under `./auth/` and `./paths.ts` — the same
 * discipline `src/index.ts`'s other two branches and `registered-project-roots.ts#registerAndAdoptProject`
 * already follow (see their own comments): these must never become part of the always-loaded
 * npm-default module graph, and a variable specifier would be opaque to `npm run typecheck` in both
 * directions, which is exactly how a previous version of one of these paths (`../auth/…` from
 * `src/index.ts`) broke silently — see `src/index.ts`'s own `provider !== 'none'` branch comment for
 * that history.
 */
export async function buildLocalModeRoutes(
  env: NodeJS.ProcessEnv = process.env,
  bindHost?: string,
): Promise<LocalModeRoutes> {
  if (!isLocalOrgModeActive(env, bindHost)) {
    return { active: false };
  }

  // Auth ROUTES stay untouched here: no `./auth/routes.ts` (login/callback/logout), no
  // `./auth/invite-routes.ts` — there is nothing to log into locally and no second user to invite
  // (D13: "authRoutes... and inviteRoutes stay unmounted locally"). Corrected 2026-08-07: "no
  // ./auth/session.ts" above overclaimed the MODULE GRAPH, not the routes — `onboarding-routes.ts`
  // and `team-routes.ts` (imported below) each carry their own static top-level `import {
  // sessionResolver } from './session.ts'` for their `buildOnboardingRoutes`/`buildTeamRoutes`
  // fallbacks (the `sessionResolver`-based construction each file's own `export const
  // onboardingRoutes`/`teamRoutes` singleton uses), so `session.ts` DOES load transitively on
  // this path now.
  // Harmless — `session.ts`'s own doc comment explains why the import itself still does no
  // filesystem I/O — but "only the five modules below are reached" was never literally true; six
  // (or seven, counting `local-identity.ts`) are.
  const [identityMod, localGatesMod, onboardingMod, teamMod, pathsMod] = await Promise.all([
    import('./auth/identity-store.ts'),
    import('./auth/local-gates.ts'),
    import('./auth/onboarding-routes.ts'),
    import('./auth/team-routes.ts'),
    import('./paths.ts'),
  ]);

  const identityStore = identityMod.IdentityStore.open(pathsMod.identityDir());
  const localOrgAdminGate = localGatesMod.createRequireOrgAdminLocal(localGatesMod.localSessionResolver);

  const onboardingRoutes = onboardingMod.createOnboardingRoutes({
    sessionResolver: localGatesMod.localSessionResolver,
    identityStore,
    // D13: the bootstrap claim never applies locally — this literal is constructed only inside the
    // branch that has already confirmed `isLocalOrgModeActive`, never by asking `resolveAuthProvider`
    // again (which would ALSO read `'none'` for the hosted-no-auth topology this function's early
    // return already excluded). See `OnboardingRouteDeps.bootstrapClaim`'s own doc comment.
    bootstrapClaim: { required: false, mode: 'open' },
    localSignedInGate: localGatesMod.createRequireSignedInLocal(identityStore),
    localOrgAdminGate,
    // D13 project adoption ("Existing projects are adopted, not stranded") — read fresh at the
    // moment `POST /auth/onboarding/org` actually asks, never eagerly here.
    listRegisteredProjectRoots,
  });

  const teamRoutes = teamMod.createTeamRoutes({
    sessionResolver: localGatesMod.localSessionResolver,
    identityStore,
    localOrgAdminGate,
  });

  return { active: true, onboardingRoutes, teamRoutes };
}
