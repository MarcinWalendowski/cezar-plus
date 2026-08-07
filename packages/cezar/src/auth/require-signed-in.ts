import type { Context, Next } from 'hono';
import type { IdentityStore } from './identity-store.ts';
import { readSessionIdFromCookieHeader } from './session.ts';

/**
 * The **lower** authorization bar of the `/auth/*` family: "a resolvable session naming a real
 * `User` row", with no org, team or role required — the bar `POST /auth/invites/redeem`,
 * `GET /auth/onboarding` and `POST /auth/onboarding/org` need, because every one of them serves a
 * caller who has no membership yet and therefore cannot produce a D3 `Principal` at all.
 * `./require-org-admin.ts` is the HIGHER bar on the same family (a full principal, plus D12's
 * `owner`/`admin` role); these two are siblings, not alternatives.
 *
 * **ADDED 2026-08-07 (5b/5c/8 repair stage), for two reasons that turned out to be one.**
 *
 * 1. **Authorization ran after validation on two routes, which is invariant 3's exact defect.**
 *    `POST /auth/invites/redeem` was registered as
 *    `.post(path, jsonZodValidator(schema), handler)` with `resolveSignedInUser` as the handler's
 *    first statement, so an **unauthenticated** caller sending `{}` got
 *    `400 {"error":"token: Invalid input: expected string, received undefined"}` — learning the
 *    request schema, and having their JSON body parsed, before any identity check. That is
 *    verbatim what the phase-6 repair stage fixed for `supervisor/server.ts`'s `requireAdmin`
 *    ("a non-admin got 400, leaking the body schema, instead of 403") one layer up, and what
 *    `./require-org-admin.ts` exists to make structural for the admin bar. `POST
 *    /auth/onboarding/org` had the identical shape (`{"name":123}` with no session → 400). As
 *    middleware the ordering is inherited by any route added later rather than re-decided, which
 *    is the whole argument `require-org-admin.ts`'s own doc comment makes.
 * 2. **The cookie parse was duplicated, and the duplicate was pinned by nothing.**
 *    `invite-routes.ts` carried its own copy of `onboarding-routes.ts`'s private
 *    `resolveSignedInUser`, with a docblock asserting "both read the SAME
 *    `readSessionIdFromCookieHeader` (D3's single cookie-parse rule), so there is nothing here
 *    that could drift from it." True of that code and tested by nothing: replacing the copy with a
 *    first-occurrence parser left all 382 test files green, while D3's own second correction exists
 *    precisely because `getCookie` returns the FIRST `cez_session` and `session.ts` the LAST. Under
 *    D10 that is more reachable, not less — `CEZ_SESSION_COOKIE_DOMAIN=.<base>` is required for
 *    `auth_request` to work, so a cookie set on any sibling subdomain rides along to every org
 *    host, and RFC 6265 §5.4 lets the setter choose the ordering. There is now ONE copy, here, and
 *    `require-signed-in.test.ts` drives a duplicate-`cez_session` header through it and through
 *    `SessionService` and asserts both resolve the same user.
 *
 * **Not merged into `session.ts`'s `SessionResolver`.** That interface deliberately collapses "no
 * session at all" and "signed in, no membership yet" into one `null` (its own module doc says so),
 * and `GET /auth/onboarding` is the one route whose entire job is telling those apart. Reading
 * `getSession`/`getUserById` one level deeper is that distinction, not a second resolver: it is
 * strictly *less* resolution than D3's, never a different answer to the same question.
 */

/** The subset of `IdentityStore` this bar reads — narrowed the same way `OnboardingIdentityStore`
 *  and `InviteIdentityStore` narrow theirs, and structurally satisfied by both of them. */
export type SignedInUserStore = Pick<IdentityStore, 'getSession' | 'getUserById'>;

export interface SignedInUser {
  readonly userId: string;
  readonly email?: string;
}

/**
 * Reads the session cookie through `./session.ts`'s exported `readSessionIdFromCookieHeader` —
 * literally the same function `SessionService#resolveFromCookieHeader` calls, applying
 * `SESSION_ID_RE` and taking the LAST occurrence — then the same
 * `identity-store.ts#getSession` (already expiry-checked, D6: "on every read"), but stops one step
 * short of resolving org/team/role, which is exactly the step that does not exist yet for a D8
 * "needs-org" user.
 *
 * Exported for `GET /auth/onboarding`, which needs the three-way branch (no session / signed in
 * with no org / full principal) and therefore cannot use the middleware below.
 */
export function resolveSignedInUser(
  c: Context,
  store: SignedInUserStore,
): SignedInUser | undefined {
  const sessionId = readSessionIdFromCookieHeader(c.req.header('cookie'));
  const session = sessionId ? store.getSession(sessionId) : undefined;
  if (!session) return undefined;
  const user = store.getUserById(session.userId);
  if (!user) return undefined; // defensive: a session's userId always names a real row today
  return { userId: user.id, email: user.email };
}

/**
 * The middleware form — registered as a route's FIRST handler, ahead of its `jsonZodValidator`, so
 * an unauthenticated caller gets 401 without their body ever being parsed. Mirrors
 * `./require-org-admin.ts#createRequireOrgAdmin` exactly, including the stash-and-read-back pair
 * below, so the two bars on this route family are written the same way and a reader comparing them
 * sees only the difference that matters (which bar, not which style).
 */
export function createRequireSignedIn(
  store: SignedInUserStore,
): (c: Context, next: Next) => Response | Promise<Response | void> {
  return async (c, next) => {
    const user = resolveSignedInUser(c, store);
    if (!user) return c.json({ error: 'unauthenticated' }, 401);
    (c as unknown as Context<{ Variables: { signedInUser: SignedInUser } }>).set('signedInUser', user);
    return next();
  };
}

/** The typed read-back half of the stash above — `c.get('signedInUser')` after
 *  `createRequireSignedIn(...)`'s instance has run, via the same cast-through-`unknown` idiom
 *  `getOrgAdminPrincipal` and `server.ts`'s own `/api/*` principal middleware use. */
export function getSignedInUser(c: Context): SignedInUser {
  return (c as unknown as Context<{ Variables: { signedInUser: SignedInUser } }>).get('signedInUser');
}
