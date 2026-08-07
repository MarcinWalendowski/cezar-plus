import type { Context, Next } from 'hono';
import type { Principal, SessionResolver } from '../server/server.ts';
import { sessionResolver } from './session.ts';

/**
 * D12 (spec `.ai/specs/2026-08-06-org-team-auth-onboarding.md`): **`role` gates org
 * administration, and is NEVER used to restrict code execution.**
 *
 * `owner`/`admin` gate org administration — creating and revoking invites, renaming the org,
 * creating/renaming/reassigning teams, removing members. `member` gets everything else,
 * including `POST /api/v1/workflows` and every agent-run surface. See D12's own reasoning:
 * everyone in an org already shares one unix user, one `CEZ_HOME` and one set of
 * `claude`/`codex` credentials (D4 — "members of an organization can run code as one another.
 * Invite accordingly."), so a role check in front of a code-execution route would not create a
 * boundary; it would only *look* like one, while the `member` reaches the identical shell
 * through any other agent surface. An isolation control that isn't one is worse than none,
 * because it is what the next reader trusts when deciding who to invite.
 *
 * **DO NOT mount this in front of `POST /api/v1/workflows`, any other `/api/v1/*` route, or any
 * agent-run surface.** Its one legitimate mount family is `/auth/*` org-administration routes:
 * invite create/revoke, team create/rename/reassign, org rename, member removal. If a deployment
 * genuinely needs members who cannot execute code, D12 says that is a second org (D4's real
 * boundary), never a role.
 *
 * **What this generalizes.** `onboarding-routes.ts`'s `PATCH /auth/onboarding/team` handler
 * carried the one role check that existed in this codebase before 5b/5c
 * (`principal.role !== 'owner' && principal.role !== 'admin'`, inline in the handler, ADDED
 * 2026-08-07 repair stage) — the precedent generalized here, not re-invented.
 *
 * **CORRECTED 2026-08-07 (5b/5c/8 integration pass): that route no longer keeps its own inline
 * check.** This paragraph used to end "`onboarding-routes.ts` itself is a different unit's file
 * and is deliberately left untouched here — `PATCH /auth/onboarding/team` keeps its own inline
 * check rather than being refactored onto this middleware in this pass", which was an accurate
 * statement of that unit's ownership and a description of a live defect: because the inline check
 * sat downstream of `jsonZodValidator`, a `member` with a malformed body got 400 and an
 * unauthenticated caller with a malformed body got 400, not 403/401. `auth-admin-routes.test.ts`'s
 * strengthened inventory (every `ADMIN_ONLY` route driven with a body that satisfies no schema)
 * is what surfaced it. That route now mounts this middleware, so the D12 gate has exactly ONE
 * construction — which is the whole reason to have a shared one.
 *
 * **Registered as MIDDLEWARE, ahead of the route's own `jsonZodValidator` — never a first line
 * inside a handler.** Mirrors `supervisor/server.ts`'s own `requireAdmin`, and for the same
 * reason: that file's own doc comment records a real defect where an admin check that ran AFTER
 * a body validator answered a non-admin caller 400 (leaking the request schema) instead of 403,
 * for a request that was never going to be allowed regardless of its body — authorization that
 * runs after parsing is one `.optional()` away from running after a side effect. As middleware,
 * an admin route added later inherits the ordering rather than re-deciding it, e.g.:
 *
 *   .post('/auth/teams', requireOrgAdmin, jsonZodValidator(createTeamInputSchema), handler)
 *
 * **Why this resolves the principal itself, rather than reading `c.get('principal')`.** Unlike
 * `/api/*`, the `/auth/*` family is NOT behind `server.ts`'s principal-resolution middleware
 * (see that middleware's own doc comment — it is scoped to `/api/*` only). Every `/auth/*` route
 * resolves its own principal from the cookie, exactly as `GET /auth/me` and `PATCH
 * /auth/onboarding/team` already do, via the injected `SessionResolver` (D3's one resolver, the
 * same instance `requirePrincipal`/`verifyWsUpgrade` use). This middleware does the same, so an
 * admin route mounted on `/auth/*` needs no separate principal-resolution step of its own.
 */
export function createRequireOrgAdmin(
  resolver: Pick<SessionResolver, 'resolveFromCookieHeader'>,
): (c: Context, next: Next) => Response | Promise<Response | void> {
  return async (c, next) => {
    const principal = resolver.resolveFromCookieHeader(c.req.header('cookie'));
    // `principal.kind !== 'session'` is unreachable in practice — `/auth/*` only mounts once
    // `CEZ_AUTH` names a provider, and a cookie resolver never resolves the `'local'` kind (the
    // same defensive stance `onboarding-routes.ts`'s `GET /auth/onboarding` and `PATCH
    // /auth/onboarding/team` already take for this exact check) — but failing closed here costs
    // nothing.
    if (!principal || principal.kind !== 'session') {
      return c.json({ error: 'unauthenticated' }, 401);
    }
    if (principal.role !== 'owner' && principal.role !== 'admin') {
      return c.json({ error: 'forbidden: this action requires an owner or admin role' }, 403);
    }
    // Stashed for the handler so it doesn't have to resolve the SAME cookie a second time — read
    // back with `getOrgAdminPrincipal` below, via the same cast-through-`unknown` idiom
    // `server.ts`'s own `/api/*` principal middleware uses. This function's own parameter stays a
    // bare `Context` rather than widening to a specific `Env`, so mounting it does not force every
    // future caller to type their app against a special `Variables` shape just to use one
    // middleware — the same trade `server.ts`'s own comment on this exact cast explains.
    (c as unknown as Context<{ Variables: { principal: Principal } }>).set('principal', principal);
    return next();
  };
}

/** The typed read-back half of the stash above — `c.get('principal')` after `requireOrgAdmin` (or
 *  a `createRequireOrgAdmin(...)` instance) has run, for a handler that would rather not resolve
 *  the cookie a second time. Optional: a handler is equally free to call
 *  `sessionResolver.resolveFromCookieHeader` itself, the way `PATCH /auth/onboarding/team` does
 *  today — both read the identical value, since both go through D3's one resolver. */
export function getOrgAdminPrincipal(c: Context): Principal {
  return (c as unknown as Context<{ Variables: { principal: Principal } }>).get('principal');
}

/**
 * The real, process-lifetime instance — wired against `./session.ts`'s own `sessionResolver`
 * singleton, the SAME one `auth/routes.ts`'s `GET /auth/me` and `onboarding-routes.ts`'s `PATCH
 * /auth/onboarding/team` already resolve through (D3). A Fill unit adding an admin route on
 * `/auth/*` needs nothing more than this import — no local wiring — mirroring `routes.ts`'s
 * `authRoutes` and `onboarding-routes.ts`'s `onboardingRoutes`, which export their own real,
 * process-lifetime instances the same way.
 */
export const requireOrgAdmin = createRequireOrgAdmin(sessionResolver);
