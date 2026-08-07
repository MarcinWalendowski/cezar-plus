import type { Context, Next } from 'hono';
import { identityDir } from '../paths.ts';
import type { Principal, SessionResolver } from '../server/server.ts';
import type { IdentityStore } from './identity-store.ts';
import { resolveLocalOrgIdentity } from './local-identity.ts';
import { hasOrgScope, resolvePrincipal } from './principal.ts';
import type { SignedInUser } from './require-signed-in.ts';

/**
 * D13's local-mode counterparts to `./require-signed-in.ts` and `./require-org-admin.ts` (spec
 * `.ai/specs/2026-08-06-org-team-auth-onboarding.md`, phase 9 HTTP surface) — the "two injected
 * gates" `onboarding-routes.ts`/`team-routes.ts` need to serve `/auth/onboarding*`/`/auth/teams*`
 * with `CEZ_AUTH` unset on loopback. Deliberately NOT a second onboarding implementation:
 * `createOnboardingRoutes`/`createTeamRoutes` stay the exact same functions, called by
 * `../local-mode-boot.ts#buildLocalModeRoutes` with these instead of the cookie-based gates when
 * it wires local mode (that function is itself called from `src/index.ts`'s `else` branch). D13 names
 * `invite-routes.ts`'s byte-for-byte copy of `resolveSignedInUser` as the precedent for why a
 * second surface is the wrong shape — this file exists so that mistake isn't repeated at the gate
 * layer instead of the route layer.
 *
 * **Every gate here shares one absolute rule (D13 invariant 1): never 401.** Loopback is already
 * fully trusted under D12's own reasoning — anyone who can reach this port can already
 * `POST /api/v1/workflows` and get a shell — so there is no "who are you" question left to fail on
 * here, only "does an organization exist yet", which is a 400 precondition when it matters, never
 * an authentication failure. `require-org-admin.ts`'s existing `createRequireOrgAdmin` cannot be
 * reused as-is for this reason alone: its `principal.kind !== 'session'` check would 401 EVERY
 * local request, because a local principal's `kind` is `'local'` by construction (D3/D13 — `kind`
 * means "was this request authenticated", never "does it have an org"; `hasOrgScope` is the
 * question this file needs answered instead).
 */

/**
 * D3's one resolver, local-mode flavour — shared by `onboarding-routes.ts`'s `GET
 * /auth/onboarding` and `team-routes.ts`'s `GET /auth/teams`, the two reads that only need a
 * resolved `Principal`, not the admin bar below. Ignores the cookie header entirely (there is no
 * session to read) and, unlike the cookie-based `SessionResolver`, NEVER returns `null`: D13's
 * whole point is that a local request is never "unauthenticated", only "not yet in an org" —
 * `hasOrgScope(principal)` is what tells the two apart, exactly as it does for the five call sites
 * D13 names in `server.ts`.
 *
 * Reads through `local-identity.ts`'s own module-scope cache — the SAME read the (later-stage)
 * `/api/v1/*` principal-resolution path will use — rather than a second lookup this file invents,
 * which is what keeps this a D3-shaped resolver and not a competing one.
 */
export const localSessionResolver: SessionResolver = {
  resolveFromCookieHeader(): Principal {
    const identity = resolveLocalOrgIdentity(identityDir());
    return resolvePrincipal({ authProvider: 'none', identity: identity ?? undefined });
  },
};

/** The subset of `IdentityStore` the signed-in gate below needs — narrowed the same way
 *  `./require-signed-in.ts`'s own `SignedInUserStore` and `onboarding-routes.ts`'s
 *  `OnboardingIdentityStore` narrow theirs. */
export type LocalSignedInStore = Pick<IdentityStore, 'findOrCreateLocalUser'>;

/**
 * D13's local counterpart to `./require-signed-in.ts#createRequireSignedIn` — deliberately the
 * SAME shape (a middleware that stashes a `SignedInUser` under the identical `'signedInUser'`
 * context key `./require-signed-in.ts#getSignedInUser` reads back), so
 * `onboarding-routes.ts`'s `POST /auth/onboarding/org` handler needs no branch on which gate ran.
 * Instead of parsing a session cookie, it RESOLVES/CREATES the local user
 * (`IdentityStore#findOrCreateLocalUser`, D13) — the one write this file performs, and the only
 * one: every other gate below is read-only.
 *
 * Never 401s: `findOrCreateLocalUser` has no failure mode to report on loopback (it is idempotent
 * — a re-run of the wizard against an already-onboarded `CEZ_HOME` finds the same row).
 * Mounted ahead of `POST /auth/onboarding/org`'s body validator, mirroring the cookie gate's own
 * "authorization before validation" ordering even though local mode has no unauthenticated caller
 * to protect the schema from — kept for one code shape rather than a special case.
 */
export function createRequireSignedInLocal(
  store: LocalSignedInStore,
): (c: Context, next: Next) => Promise<Response | void> {
  return async (c, next) => {
    const { user } = await store.findOrCreateLocalUser();
    (c as unknown as Context<{ Variables: { signedInUser: SignedInUser } }>).set('signedInUser', {
      userId: user.id,
      email: user.email,
    });
    return next();
  };
}

/**
 * D13's local counterpart to `./require-org-admin.ts#createRequireOrgAdmin` — same stash
 * (`'principal'`, read back by that module's own `getOrgAdminPrincipal`, which is mode-agnostic
 * and works unchanged against either gate's output), same middleware position (ahead of
 * `jsonZodValidator`/`paramZodValidator`), but keyed on `hasOrgScope` rather than `kind ===
 * 'session'` (see this module's own doc comment for why the cookie version cannot be reused
 * as-is).
 *
 * READ-ONLY, unlike the signed-in gate above: every route this guards
 * (`PATCH /auth/onboarding/team`, `/auth/teams*`'s three write verbs) only ever runs after `POST
 * /auth/onboarding/org` has already created the local org, so "no organization yet" here is a
 * genuine precondition failure (400) this gate reports rather than papers over by creating one on
 * the caller's behalf.
 *
 * The role check below is kept for parity with the cookie gate rather than special-cased away, but
 * it is vacuous by construction: `claimOrg`'s legacy branch (the only way a local org is ever
 * created, D13) always grants the local user `'owner'` — local mode is single-user, single-org —
 * so it can never actually refuse. The same "should never happen, but fails closed anyway" stance
 * `onboarding-routes.ts` already takes for its own defensive branches.
 */
export function createRequireOrgAdminLocal(
  resolver: Pick<SessionResolver, 'resolveFromCookieHeader'> = localSessionResolver,
): (c: Context, next: Next) => Response | Promise<Response | void> {
  return async (c, next) => {
    const principal = resolver.resolveFromCookieHeader(undefined);
    if (!principal || !hasOrgScope(principal)) {
      return c.json({ error: 'no organization exists yet — create one first' }, 400);
    }
    if (principal.role !== 'owner' && principal.role !== 'admin') {
      // Unreachable today — see this function's own doc comment — kept so a future local role
      // (e.g. a second local membership) fails closed instead of silently falling through.
      return c.json({ error: 'forbidden: this action requires an owner or admin role' }, 403);
    }
    (c as unknown as Context<{ Variables: { principal: Principal } }>).set('principal', principal);
    return next();
  };
}
