import { Hono, type Context, type Next } from 'hono';
import { z } from 'zod';
import {
  createTeamInputSchema,
  deleteTeamResponseSchema,
  listTeamsResponseSchema,
  renameTeamInputSchema,
  type CreateTeamResponse,
  type DeleteTeamResponse,
  type ListTeamsResponse,
  type RenameTeamResponse,
  type Team as WireTeam,
} from '@loki-labs/cezar-plus-contract';
import { jsonZodValidator, paramZodValidator } from '../server/validators.ts';
import { identityDir } from '../paths.ts';
import type { SessionResolver } from '../server/server.ts';
import { IdentityStore, IdentityStoreError } from './identity-store.ts';
import { invalidateLocalOrgIdentityCache } from './local-identity.ts';
import { hasOrgScope } from './principal.ts';
import { createRequireOrgAdmin, getOrgAdminPrincipal } from './require-org-admin.ts';
import { sessionResolver } from './session.ts';
import type { Team } from './types.ts';

/**
 * Team management (D2, D12, Phase 5c — spec `.ai/specs/2026-08-06-org-team-auth-onboarding.md`).
 * Fill unit 3 (team CRUD store+HTTP), 5b/5c/8 scaffold pass follow-up. `GET/POST /auth/teams`,
 * `PATCH /auth/teams/:teamId`, `DELETE /auth/teams/:teamId` — the wire shapes and their doc
 * comments live in `packages/contract/src/orgs.ts`'s "team management (D2, Phase 5c)" section
 * (`DeleteTeamResponse` added by this pass, the other three by the scaffold).
 *
 * **Why a separate file rather than three more methods on `onboarding-routes.ts`.** That file's
 * own module doc comment already draws this line for `/auth/onboarding/*`: those three routes
 * exist because a signed-in, membership-less user needs an authorization bar `requirePrincipal`
 * cannot express. Every route here is the OPPOSITE case — every one of them requires a fully
 * resolved `Principal` (D3), exactly like `PATCH /auth/onboarding/team` does — so there is no
 * shared "lower bar" plumbing to reuse, and folding four more routes onto a file whose whole
 * reason to exist is that one gap would blur why it exists. `orgs.ts`'s own doc comment on this
 * section suggested this exact split ("Fill unit 3 owns the routes").
 *
 * **Mount point.** Same family as `./onboarding-routes.ts` and `./routes.ts`: mounted at the app
 * ROOT, under the already-reserved `auth` segment (D5), inside `app.use('/auth/*', originGuard)`
 * (the #426 CSRF guard) exactly as every other `/auth/*` route already is — see
 * `onboarding-routes.ts`'s own module doc comment for why that matters (the guard is registered
 * on `/api/*` and `/auth/*` explicitly; a route family living outside `/api/` that skipped that
 * registration would be an unguarded write, which is the exact defect D5's amendment closed for
 * `POST /auth/logout`).
 *
 * **Authorization: one bar for all four routes (a resolved `Principal`), one extra check for
 * three of them (D12's `owner`/`admin` gate).** `GET /auth/teams` is open to any signed-in member
 * of the org — you don't need to be an admin to see which teams exist in order to file a project
 * under one, only to create/rename/delete one (`orgs.ts`'s own module comment on this section).
 * The role check is `./require-org-admin.ts`'s shared `requireOrgAdmin` — the generalized form of
 * the one precedent that predates it (`PATCH /auth/onboarding/team`'s inline check) — mounted as
 * MIDDLEWARE ahead of `jsonZodValidator`/`paramZodValidator` on `POST`/`PATCH`/`DELETE` below,
 * never a check written inside the handler body downstream of them. That ordering is not
 * decorative: it is the exact defect the phase-6/7 repair stage had to fix once already on
 * `supervisor/server.ts`'s `requireAdmin` (an admin check that ran after a body validator answered
 * a non-admin caller 400, leaking the request schema, instead of 403 for a request that was never
 * going to be allowed regardless of its body). D12 is explicit that this is the correct
 * generalization: role gates ORG ADMINISTRATION (creating/renaming/reassigning/deleting teams is
 * squarely that), never code execution.
 *
 * **Cross-org: unknown-to-you reads as not-found.** `PATCH`/`DELETE` both take a `teamId` in the
 * URL, so — unlike `PATCH /auth/onboarding/team`, which can only ever touch
 * `principal.teamId` — a client CAN name a team belonging to a different org. Both handlers
 * therefore look the team up first and 404 if it does not belong to `principal.orgId`, mirroring
 * `supervisor/server.ts`'s `GET /internal/teams/:teamId` (already established for the cross-
 * process case, applied here to the in-process one, per `orgs.ts`'s own doc comment on
 * `renameTeamInputSchema`). This is what makes "a team id from org B is not reachable by an org A
 * caller" true by construction rather than by a check this file remembers to add.
 */

// ---- deps: the testable seam --------------------------------------------------------------------

export type TeamRoutesIdentityStore = Pick<IdentityStore, 'listTeams' | 'getTeamById' | 'createTeam' | 'renameTeam' | 'deleteTeam'>;

export interface TeamRouteDeps {
  /** D3's one resolver — every route here needs the FULL principal (`orgId`/`teamId`/`role`),
   *  unlike `onboarding-routes.ts`'s lower "signed in, maybe no org yet" bar.
   *
   *  **D13 (phase 9 HTTP surface): also what `GET /auth/teams` reads for local mode.** In local
   *  mode this is `./local-gates.ts#localSessionResolver` (never `null`, `kind: 'local'`) — see
   *  `onboarding-routes.ts`'s `OnboardingRouteDeps.sessionResolver` doc comment for the same note,
   *  which applies here unchanged. */
  readonly sessionResolver: SessionResolver;
  readonly identityStore: TeamRoutesIdentityStore;
  /**
   * D13's local-mode "org admin" gate (`./local-gates.ts#createRequireOrgAdminLocal`) —
   * substitutes for the internally-built `createRequireOrgAdmin(sessionResolver)` on all three
   * write verbs. Cannot be expressed by swapping `sessionResolver` alone: `createRequireOrgAdmin`'s
   * own `kind !== 'session'` check would 401 every local request (see `./local-gates.ts`'s module
   * doc comment). Absent keeps today's cookie-based construction.
   */
  readonly localOrgAdminGate?: (c: Context, next: Next) => Response | Promise<Response | void>;
}

// ---- wire shaping (mirrors `onboarding-routes.ts`'s own precedent) -------------------------------

/** `identity-store.ts`'s `Team` is `.passthrough()` (D7: a newer column must survive an older
 *  reader's round trip) — picking the known fields by hand keeps this route from ever leaking one
 *  the wire contract never promised, same reasoning `onboarding-routes.ts#toWireTeam` already
 *  states for the identical shape. */
function toWireTeam(team: Team): WireTeam {
  return { id: team.id, orgId: team.orgId, name: team.name, slug: team.slug };
}

const teamIdParamSchema = z.object({ teamId: z.string().min(1) });

export function createTeamRoutes(deps: TeamRouteDeps): Hono {
  // Own instance (not the process-wide `requireOrgAdmin` singleton) so this factory stays testable
  // against a fake `SessionResolver` — the same shape `invite-routes.ts#createInviteRoutes` and
  // `require-org-admin.test.ts`'s own `buildApp` helper use.
  //
  // D13: `deps.localOrgAdminGate` substitutes the WHOLE gate, not just its resolver — see
  // `./local-gates.ts`'s module doc comment for why swapping only `deps.sessionResolver` into
  // `createRequireOrgAdmin` would still 401 every local request.
  const adminGate = deps.localOrgAdminGate ?? createRequireOrgAdmin(deps.sessionResolver);

  return new Hono()
    // ---- GET /auth/teams: every team in the caller's own org, no admin bar (see module doc) -----
    .get('/auth/teams', (c) => {
      const principal = deps.sessionResolver.resolveFromCookieHeader(c.req.header('cookie'));
      if (!principal) return c.json({ error: 'unauthenticated' }, 401);
      if (!hasOrgScope(principal)) {
        // D13: reachable in local mode before an org exists (`kind: 'local'`, `orgId: null`) —
        // unreachable in session mode (`session.ts#resolveIdentity` never resolves a
        // membership-less 'session' principal; `sessionResolver` returns `null` instead, caught
        // above). NOT 401: this caller genuinely is who they say they are, there just isn't an
        // org yet (D13 invariant 1 — no 401 in local mode, ever).
        return c.json({ error: 'no organization exists yet' }, 400);
      }
      const body: ListTeamsResponse = { teams: deps.identityStore.listTeams(principal.orgId).map(toWireTeam) };
      return c.json(body);
    })

    // ---- POST /auth/teams: D12 admin action, a later team beside the org's default one -----------
    // `adminGate` runs BEFORE `jsonZodValidator` (module doc comment: authorization before
    // validation) so a non-admin's malformed body never reaches the validator.
    .post('/auth/teams', adminGate, jsonZodValidator(createTeamInputSchema), async (c) => {
      const principal = getOrgAdminPrincipal(c);
      if (!hasOrgScope(principal)) {
        // Defensive narrowing only (also what makes `principal.orgId` a `string` below to the
        // type checker) — `adminGate` (cookie-based OR D13's local one) never stashes a principal
        // without an org. Unreachable in practice; see `onboarding-routes.ts`'s identical guard on
        // `PATCH /auth/onboarding/team` for the same reasoning.
        return c.json({ error: 'no organization exists yet' }, 400);
      }
      const { name, slug } = c.req.valid('json');
      try {
        const team = await deps.identityStore.createTeam({ orgId: principal.orgId, name, slug });
        const body: CreateTeamResponse = { team: toWireTeam(team) };
        return c.json(body, 201);
      } catch (error) {
        if (error instanceof IdentityStoreError && error.code === 'team-slug-taken') {
          return c.json({ error: `a team with slug "${slug}" already exists in this organization` }, 409);
        }
        throw error;
      }
    })

    // ---- PATCH /auth/teams/:teamId: D12 admin action, ANY team in the caller's own org -----------
    .patch('/auth/teams/:teamId', adminGate, paramZodValidator(teamIdParamSchema), jsonZodValidator(renameTeamInputSchema), async (c) => {
      const principal = getOrgAdminPrincipal(c);
      const { teamId } = c.req.valid('param');
      // Cross-org: unknown-to-you reads as not-found (module doc comment).
      const existing = deps.identityStore.getTeamById(teamId);
      if (!existing || existing.orgId !== principal.orgId) return c.json({ error: `unknown team: ${teamId}` }, 404);
      const { name } = c.req.valid('json');
      const team = await deps.identityStore.renameTeam(teamId, name);
      const body: RenameTeamResponse = { team: toWireTeam(team) };
      return c.json(body);
    })

    // ---- DELETE /auth/teams/:teamId: D12 admin action, refused if the team still has projects ----
    .delete('/auth/teams/:teamId', adminGate, paramZodValidator(teamIdParamSchema), async (c) => {
      const principal = getOrgAdminPrincipal(c);
      const { teamId } = c.req.valid('param');
      // Cross-org: unknown-to-you reads as not-found (module doc comment) — checked BEFORE the
      // store call so a team belonging to a different org never even reaches `deleteTeam`.
      const existing = deps.identityStore.getTeamById(teamId);
      if (!existing || existing.orgId !== principal.orgId) return c.json({ error: `unknown team: ${teamId}` }, 404);
      try {
        await deps.identityStore.deleteTeam(teamId);
        // FIX 4 (D13 repair pass): `./local-identity.ts`'s cache is a single, process-lifetime slot
        // that resolves once and is trusted forever until something tells it otherwise — and
        // before this, the ONLY place that ever did was `onboarding-routes.ts`'s `claimOrg` calls.
        // A caller who had already resolved (and cached) a local `Principal` naming THIS team keeps
        // reading that same, now-deleted, `teamId` after a successful delete — and every later
        // `POST /api/v1/projects` (`server.ts#registerFolder`, via `resolveLocalPrincipal`, the
        // SAME cache) 500s trying to file a project under a team that no longer exists. A no-op in
        // session mode: nothing populates that cache outside local mode (see the module's own doc
        // comment), so this just resets an already-`'unknown'` slot back to `'unknown'`.
        invalidateLocalOrgIdentityCache();
        const body: DeleteTeamResponse = { deleted: true, id: teamId };
        return c.json(body);
      } catch (error) {
        if (error instanceof IdentityStoreError) {
          if (error.code === 'team-has-projects') {
            return c.json({ error: 'this team still has projects assigned to it — reassign them before deleting the team' }, 409);
          }
          // ADDED 2026-08-07 (5b/5c/8 repair stage). Deleting an org's LAST team used to answer
          // `200 {"deleted":true}` and lock every member of that org out permanently — see
          // `IdentityStore#deleteTeam`'s own doc comment for the reproduced blackout and why the
          // refusal is a store invariant rather than a check written here.
          if (error.code === 'team-is-last') {
            return c.json(
              {
                error:
                  'this is the only team in your organization — deleting it would lock every member out, because a session resolves its team from this list. Create another team first, or rename this one.',
              },
              409,
            );
          }
        }
        throw error;
      }
    });
}

// ---- the real, process-lifetime wiring ------------------------------------------------------------

/**
 * Opens its OWN `IdentityStore` at the same directory `./session.ts`/`./routes.ts`/
 * `./onboarding-routes.ts` each open theirs — none of the four keeps an in-memory cache (see
 * `identity-store.ts`'s own module doc on why), so this is exactly as consistent as sharing one.
 */
function buildTeamRoutes(): Hono {
  const identityStore = IdentityStore.open(identityDir());
  return createTeamRoutes({ sessionResolver, identityStore });
}

/** What `src/index.ts`'s `serveCommand` and `supervisor/index.ts`'s `startSupervisor` both thread
 *  into their respective `ServerDeps.teamRoutes` / `SupervisorAppDeps.teamRoutes`, mounted at the
 *  app root beside `authRoutes`/`onboardingRoutes` on whichever process serves `/auth/*` — the
 *  single process (phases 1-5) or the supervisor (D10, phases 6-8). Synchronous, like
 *  `onboardingRoutes` and for the same reason: no external config to resolve at import time. */
export const teamRoutes: Hono = buildTeamRoutes();
