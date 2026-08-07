import { z } from 'zod';

/**
 * The ORG/TEAM family — the wire half of D2/D7/D8 (spec
 * `.ai/specs/2026-08-06-org-team-auth-onboarding.md`), phases 4-5.
 *
 * These shapes exist twice on purpose, the same split `automations.ts` documents for itself:
 * `packages/cezar/src/auth/types.ts` owns the STORAGE schemas (`.passthrough()`, so a row a
 * newer cezar writes survives an older one's round trip through `identity.json` unharmed).
 * The schemas here are the CLOSED wire half — every key a route actually answers with, no
 * index signature, so a consumer compiles against a shape instead of `unknown`. Field names and
 * shapes mirror `auth/types.ts` exactly (this file has no import of it — Node-free rule 1 — so
 * agreement is by construction of both being read off the same spec, not by a shared reference).
 *
 * **Ownership note (2026-08-07).** This file is not named in the fan-out's per-unit ownership map
 * at all (unit 3, "onboarding API routes", is the only unit that consumes it). The onboarding-api
 * unit therefore extended it directly rather than leaving `packages/cezar/src/auth/
 * onboarding-routes.ts` with nowhere to declare the one additive field it needed
 * (`onboardingStatusResponseSchema.hasProjects`) — see that field's own doc comment.
 *

 * **Scope note.** Only four entities are wire types here: `Org`, `Team`, `Membership`,
 * `ProjectTeam` — the ones phase 4/5's onboarding and project-board surfaces answer over HTTP.
 * `Invite` (D8: "subsequent users need an invite") is deliberately NOT here: the spec's Data
 * Models section has no `invites` table at all, so the storage shape added for it
 * (`auth/types.ts`'s `inviteSchema`) is this scaffold's own minimal extension to make the
 * `IdentityStore` signatures in `identity-store.ts` well-typed — an internal fact the "memberships
 * + invites" unit needs to store something, not yet a decided wire contract. Whichever unit builds
 * the actual invite HTTP surface (create/redeem) owns adding its own `packages/contract/src/
 * invites.ts` alongside the routes that need it, the same way this file exists because THIS
 * scaffold owns the onboarding routes' wire shapes.
 */

// ---- entities -------------------------------------------------------------------------------

export const roleSchema = z.enum(['owner', 'admin', 'member']);
export type Role = z.infer<typeof roleSchema>;

/** One organization. Cross-org isolation is a process boundary (D4), not anything this shape
 *  enforces — the wire type is the same regardless of which org's process answers it. */
export const orgSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  createdAt: z.string(),
});
export type Org = z.infer<typeof orgSchema>;

/** One team — `engineering`, `marketing` (D2's own examples). Metadata for grouping/filtering
 *  projects (D5), never a URL scope and never itself a permission boundary. */
export const teamSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  slug: z.string(),
});
export type Team = z.infer<typeof teamSchema>;

/** A user's role in ONE org. No `teamId` here — the spec's data model puts team assignment on
 *  the PROJECT (`project_teams`), never on the membership row; a user's teams are simply "every
 *  team of every org they're a member of", derived, not stored. */
export const membershipSchema = z.object({
  userId: z.string(),
  orgId: z.string(),
  role: roleSchema,
});
export type Membership = z.infer<typeof membershipSchema>;

/**
 * Which org/team a registered project root belongs to (D4's hard constraint: one root, one org —
 * `IdentityStore.createProjectTeam` is the sole enforcement point, at registration time).
 *
 * `projectRoot` carries the absolute, realpath'd path on the wire deliberately — this is a
 * same-origin route (like `GET /api/v1/projects`' own `root`, `projects.ts`'s own doc comment),
 * never the CORS-open `/api/v1/health`, so the #431 username-leak concern that keeps an absolute
 * path off health does not apply here.
 */
export const projectTeamSchema = z.object({
  projectRoot: z.string(),
  orgId: z.string(),
  teamId: z.string(),
});
export type ProjectTeam = z.infer<typeof projectTeamSchema>;

// ---- onboarding state machine (D8) -----------------------------------------------------------

/**
 * `GET /auth/onboarding` — what the cockpit's onboarding wizard polls once `/auth/me` shows a
 * signed-in user. Mounted under the already-landed, already-reserved `/auth/*` family (D5's
 * reserved-slug list names `auth`, `login`, `callback`, `o`, `t` — never `onboarding` as its own
 * top-level segment, so this stays inside the existing reservation rather than needing a new one)
 * and, like the other four `/auth/*` routes, OUTSIDE `/api/*` — which is exactly what lets it
 * answer for a signed-in user who has no org yet.
 *
 * **Why that placement is load-bearing, not incidental.** `app.use('/api/*', requirePrincipal)`
 * (`server.ts`) resolves `sessionResolver.resolveFromCookieHeader` and 401s the whole `/api/v1/*`
 * surface for a session with no membership — `session.ts`'s own module doc names this state
 * explicitly ("a signed-in user with no org membership yet (D8 onboarding not finished)") and
 * `routes.ts`'s doc comment names it as the gap this phase closes. A route that must tell that
 * exact user "you're signed in, now create an org" cannot itself live behind the check it is
 * telling the user they haven't passed yet — so it has to sit where `/auth/me` already does,
 * reading the SAME session cookie directly (`identity-store.ts`'s `getSession`/`getUserById`, both
 * already implemented) rather than through `requirePrincipal`'s all-or-nothing `Principal`.
 *
 * **Three states, not four.** D8's steps 2-4 (name the org, accept/rename the default team, add
 * projects) are explicitly "skippable and resumable", and step 3 itself says "the default team is
 * created on org creation [step 1] and the step only renames it" — so the instant an org exists at
 * all, nothing server-side is left half-finished for a state machine to gate on. The wizard's own
 * step-by-step presentation belongs to the client (e.g. "have I dismissed the extra steps") as
 * local UI state, never a server-persisted flag — inventing one would be state whose only job is
 * remembering a user clicked past a suggestion, which is the shape AGENTS.md's zero-config rule
 * ("when a feature seems to need configuration, the design is wrong") argues against.
 *
 * **CORRECTED 2026-08-07 (repair stage): `needs-invite` is the third.** There were two states, and
 * the missing one was a lie by omission. `POST /auth/onboarding/org` refuses (409) once ANY org
 * exists — D8 step 1's "subsequent users need an invite" — but the status route reported
 * `needs-org` for *every* membership-less user, so the wizard showed the second person to sign in
 * "Name your organization", took their input, and answered "you need an invite". Reproduced at
 * review. A state machine that routes a user into the one step they cannot complete is worse than
 * no state machine; `needs-invite` says the true thing instead.
 */
export const onboardingStateSchema = z.enum([
  /** A real, signed-in user (a resolvable session, a real `User` row) with zero memberships, on a
   *  deployment where NO org exists yet — so this caller may still claim it (D8 step 1). */
  'needs-org',
  /** Same user shape, but an org already exists and they are not in it. The bootstrap window is
   *  closed; joining goes through an invite (D8 step 1). Deliberately carries NOTHING about the
   *  existing org — not its name, not its size, not who owns it: this caller is unauthorized to
   *  the deployment, and a state name is not a reason to hand them a fact they cannot otherwise
   *  read. */
  'needs-invite',
  /** At least one membership exists. `org`/`team`/`role` below are the same values a resolved
   *  `Principal` carries (D3) — this is a read of that state, not a second construction of it. */
  'ready',
]);
export type OnboardingState = z.infer<typeof onboardingStateSchema>;

export const onboardingStatusResponseSchema = z.object({
  state: onboardingStateSchema,
  /** Present only when `state === 'ready'`. */
  org: orgSchema.optional(),
  team: teamSchema.optional(),
  role: roleSchema.optional(),
  /**
   * D8 step 2: "defaulted from the OIDC `hd`/email domain when present, editable." Present only
   * in the `'needs-org'` state — once an org exists there is nothing left to suggest a name for.
   * Absent when neither claim was available at sign-in; the wizard falls back to an empty field
   * rather than a guessed value.
   *
   * **Onboarding-routes unit note (2026-08-07): derived from the email domain only.** `hd` never
   * reaches this route today — `auth/oidc.ts`'s `OidcLoginResult` (the already-landed protocol
   * engine this unit does not own) extracts only `issuer`/`subject`/`email`/`name`/`role` from the
   * verified ID token, and neither `auth/types.ts`'s `userSchema` nor `identity-store.ts`'s
   * `findOrCreateUser` persists a `hd` claim anywhere a later request (this one) could read it
   * back from. Wiring `hd` through end to end is a real, additive gap — `oidc.ts` capturing
   * `claims.hd`, `routes.ts`'s callback passing it to `findOrCreateUser`, `userSchema` gaining an
   * optional `hd` column, `identity-store.ts` persisting/refreshing it — touching three files this
   * unit does not own (no unit in the fan-out's ownership map claims them either). Flagged for the
   * repair stage rather than done here.
   */
  suggestedOrgName: z.string().optional(),
  /**
   * "List what remains" (this unit's own task wording for D8 steps 2-4's resumability) — present
   * only when `state === 'ready'`: whether the org has at least one project registered to a team
   * yet (D8 step 4, D5's project→team mapping — owned by a sibling unit, `identity-store.ts`'s
   * already-implemented `listProjectTeams` read is what this is computed from). Computed on every
   * read, never stored — the same "no persisted step-completion flag" philosophy
   * `onboardingStateSchema`'s own doc comment argues for step 3 applies here too: whether a
   * project has been registered is a fact the identity store already has an authoritative answer
   * for, so storing a second copy of it would only be a way for the two to disagree.
   */
  hasProjects: z.boolean().optional(),
  /**
   * Present only in the `'needs-org'` state: whether this deployment requires the operator's
   * bootstrap code to claim it (`auth/bootstrap-claim.ts`, ADDED 2026-08-07 — see that module's
   * doc comment for why arriving first is not, on its own, permission to own a shell). A BOOLEAN,
   * never the code itself: the code lives in the server's boot log, and the whole point is that it
   * is the one fact the network cannot read. The wizard renders a second field when this is true.
   */
  bootstrapTokenRequired: z.boolean().optional(),
});
export type OnboardingStatusResponse = z.infer<typeof onboardingStatusResponseSchema>;

/**
 * `POST /auth/onboarding/org` — D8 step 1's bootstrap ("the first user to sign in becomes owner
 * of a new org") and step 2 ("name the organization … editable") as one call: the org, its default
 * team and the caller's `'owner'` membership are created atomically
 * (`IdentityStore.bootstrapFirstOrg`) — one write, because a session with no membership cannot
 * reach a *second* authenticated route to finish the job in (see `onboardingStateSchema`'s doc
 * comment), and because a crash between two writes would strand an org with no owner.
 *
 * Only `name` — no `slug` input. Deriving the slug from the name server-side (with `orgSchema`'s
 * slug shape, `slugSchema` in `auth/types.ts`) keeps the bootstrap to the one field D8 actually
 * asks the user for.
 *
 * **CORRECTED 2026-08-07: refused (409) once ANY org exists on the deployment — not merely once
 * THIS caller has a membership.** This comment previously read "refused when the caller already
 * has a membership anywhere — D8 describes ONE bootstrap per user", and the first implementation
 * of the route was built to match it. That is the wrong reading of D8 and the route has been
 * changed: step 1 says "the first user to sign in becomes owner of a new org; **subsequent users
 * need an invite**", phase 4's verification row says "invite required for the second user", and
 * D4 says "until the per-org split ships, hosted means single-org." A per-user gate satisfies none
 * of those — it lets every authenticated identity own its own org inside one process, one
 * filesystem and one shell, which is precisely what the spec's Risks section means by shipping
 * tenancy before phase 6. The gate is now `orgs.length > 0`, checked inside the identity store's
 * write lease, so two different first-time users racing cannot both win. There is consequently no
 * slug collision to disambiguate: no org has any slug at the only moment the write is allowed.
 */
export const createOnboardingOrgInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  /**
   * The operator's bootstrap code (`auth/bootstrap-claim.ts`, ADDED 2026-08-07). Optional on the
   * wire because two of the three claim modes do not want one (`open`, and — from the client's
   * point of view — a deployment that already answered `bootstrapTokenRequired: false`); the route
   * answers 403 when a code is required and this is absent or wrong. Deliberately NOT validated
   * for shape here: the `preset` mode lets an operator pick any string, and a schema that guessed
   * at its shape would reject a legitimate one at the wrong layer.
   */
  bootstrapToken: z.string().trim().max(400).optional(),
});
export type CreateOnboardingOrgInput = z.infer<typeof createOnboardingOrgInputSchema>;

export const createOnboardingOrgResponseSchema = z.object({
  org: orgSchema,
  team: teamSchema,
  role: roleSchema,
});
export type CreateOnboardingOrgResponse = z.infer<typeof createOnboardingOrgResponseSchema>;

/**
 * `PATCH /auth/onboarding/team` — D8 step 3, "the step only renames it." No `teamId` in the
 * body: the only team this route may touch is the caller's own resolved team (the same one
 * `session.ts#resolveIdentity` already picks), never one named by the client.
 */
export const renameOnboardingTeamInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
});
export type RenameOnboardingTeamInput = z.infer<typeof renameOnboardingTeamInputSchema>;

export const renameOnboardingTeamResponseSchema = z.object({ team: teamSchema });
export type RenameOnboardingTeamResponse = z.infer<typeof renameOnboardingTeamResponseSchema>;
