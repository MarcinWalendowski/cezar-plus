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
 * **Ownership note (2026-08-07).** This file was not named in phase 4/5's fan-out ownership map at
 * all (unit 3, "onboarding API routes", was the only unit that consumed it then). The 5b/5c/8
 * scaffold pass (same date) extended it directly for the same reason that unit did: it is where
 * `Org`/`Team` wire shapes already live, so a new field or a new admin-action pair belongs beside
 * its siblings rather than forking a second file that would have to stay in sync with this one's
 * entity definitions. See that scaffold pass's own ownership map (the spec's D11 addendum) for
 * which of ITS nine Fill units owns which addition below.
 *
 * **Scope note.** Four entities are wire types here: `Org`, `Team`, `Membership`, `ProjectTeam` —
 * the ones the onboarding and project-board surfaces answer over HTTP. `Invite` (D8: "subsequent
 * users need an invite") is deliberately NOT here, for the same reason it never was: it has its
 * own file, `./invites.ts` (5b/5c/8 scaffold pass), so a unit whose whole job is invites does not
 * have to touch this one and vice versa.
 */

// ---- entities -------------------------------------------------------------------------------

export const roleSchema = z.enum(['owner', 'admin', 'member']);
export type Role = z.infer<typeof roleSchema>;

/**
 * The slug shape every caller-supplied slug on this wire must satisfy — DNS-label rules,
 * character-for-character the same regex `packages/cezar/src/auth/types.ts#slugSchema` enforces in
 * the STORE. Restated rather than imported: this package is Node-free and has no import of the
 * runtime's types (see this file's own module doc comment), so the two agree by both being written
 * against the same rule, exactly as every other shape in this file does.
 *
 * **ADDED 2026-08-07 (5b/5c/8 repair stage), because "the wire is wider than the store" is a 500,
 * not a lenience.** `createTeamInputSchema.slug` and `createInternalOrgInputSchema.slug` were
 * `z.string().trim().min(1).max(63)` with no pattern, so `POST /auth/teams {"slug":"Not A Slug!"}`
 * (a D12-authorized admin, a perfectly ordinary typo) passed the route validator and then threw a
 * raw `ZodError` out of `identity-store.ts`'s `teamSchema.parse` — past `team-routes.ts`'s
 * `IdentityStoreError`-only catch — as an unhandled **500 Internal Server Error** with a stack
 * trace on stderr. `POST /internal/orgs {"slug":"Bad Slug!"}` did the same. 400 is the honest
 * answer, and putting the rule on the wire schema is what makes every route that ever validates a
 * slug inherit it rather than each remembering a `catch` arm. (Checked: the lease is released in a
 * `finally`, so the 500 wedged nothing — this was a contract defect, not a DoS.)
 *
 * Narrowing a request schema is normally forbidden here (BACKWARD_COMPATIBILITY.md's
 * "widen, never narrow"); both fields are new in this same unreleased change — neither exists in
 * `0.9.2`, the published version — so there is no caller to break, and the values it now rejects
 * are exactly the ones that used to 500.
 */
export const slugInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, 'must be a lowercase, hyphen-safe slug (DNS label rules)');

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
 * **CORRECTED 2026-08-07 (phases 5b/5c/8, D11): `IdentityStore.bootstrapFirstOrg` below is now
 * `IdentityStore.claimOrg`.** Renamed because it gained a second branch — D11's claim path for an
 * org the admin-only `POST /internal/orgs` already created — and a function called
 * `bootstrapFirstOrg` that sometimes creates nothing is a stale name. Everything in this docblock
 * (the atomic org+team+owner-membership write, the 409-once-any-org-exists gate) still describes
 * exactly `claimOrg`'s LEGACY branch (`orgSlug` absent below) unchanged; see the `orgSlug` field
 * further down for the branch this paragraph predates, and D4 says "until the per-org split ships,
 * hosted means single-org" further below is likewise scoped to that legacy branch only — a hosted
 * deployment can now hold more than one organization via the claim branch (spec D11).
 *
 * `POST /auth/onboarding/org` — D8 step 1's bootstrap ("the first user to sign in becomes owner
 * of a new org") and step 2 ("name the organization … editable") as one call: the org, its default
 * team and the caller's `'owner'` membership are created atomically
 * (`IdentityStore.claimOrg`'s legacy branch) — one write, because a session with no membership
 * cannot reach a *second* authenticated route to finish the job in (see `onboardingStateSchema`'s
 * doc comment), and because a crash between two writes would strand an org with no owner.
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
  /**
   * Required in the LEGACY branch (see `orgSlug` below), ignored in the D11 claim branch — a
   * pre-created org already has its own name. Relaxed from required to optional 2026-08-07 (5b/5c/8
   * scaffold pass): additive, BC-safe (every existing caller already sends it, so nothing that used
   * to be accepted is now rejected — AGENTS.md/BACKWARD_COMPATIBILITY.md's "widen the schema, never
   * narrow it" rule, applied to a REQUEST body rather than a response).
   */
  name: z.string().trim().min(1).max(200).optional(),
  /**
   * The operator's bootstrap code. In the LEGACY branch (`orgSlug` absent): the single,
   * deployment-wide code from `auth/bootstrap-claim.ts`, unchanged since phase 4 — optional on the
   * wire because two of its three modes do not want one (`open`, and a deployment that already
   * answered `bootstrapTokenRequired: false`). In the D11 claim branch (`orgSlug` present): THIS
   * ORG'S OWN code, verified against `Org.claimTokenHash` (`auth/types.ts`, `auth/org-claim-
   * token.ts#matchesOrgClaimToken`) — a completely different value from the deployment-wide one,
   * carried on the same wire field because from the caller's point of view it plays the same role
   * ("prove you're allowed to be first") either way. Deliberately NOT validated for shape: the
   * `preset` deployment-wide mode lets an operator pick any string, and a schema that guessed at
   * shape would reject a legitimate one at the wrong layer.
   */
  bootstrapToken: z.string().trim().max(400).optional(),
  /**
   * ADDED 2026-08-07 (5b/5c/8 scaffold pass, D11's crux). Present ⇒ CLAIM mode: the org named by
   * this slug already exists — created by the admin-only `POST /internal/orgs` (Fill unit 6,
   * installer-driven, D11) — and this call grants ONLY the caller's `owner` membership; the org,
   * its slug and its default team are untouched. Absent ⇒ LEGACY mode, unchanged from phase 4/5:
   * the caller creates the deployment's first-ever org from `name`, gated by the single
   * deployment-wide bootstrap code — still what a bare `cezar serve --auth oidc` with no supervisor
   * uses, since it has no `/internal/orgs` route to pre-create anything with (D11 is about a
   * SECOND org behind a supervisor, not about replacing this path — see the spec's D11 scaffold
   * note).
   *
   * **Why the SAME route grows a field instead of a new one.** D5 ("no new URL segment") already
   * argues against inventing route surface for what is, from the wire's point of view, one
   * operation ("a signed-in user becomes an org's owner") reached two different ways. The two
   * branches are mutually exclusive by convention (`orgSlug` present XOR `name` meaningful) —
   * `.refine()`d by whichever unit implements the route (Fill unit 7), not enforced here: this file
   * declares the wire shape, not the branch's own validation, the same split every other route in
   * this file already draws between "what the schema accepts" and "what the handler decides".
   *
   * **Where this cannot yet be resolved to a specific org's HOSTNAME, and why that's a body field
   * instead.** D11 literally reads "the first user to sign in **at that org's hostname**", but
   * `/auth/callback` always redirects to the LOGIN host (`auth/routes.ts:235`, a RELATIVE redirect)
   * and the org's own vhost gates `/` behind `auth_request`, which 401s a membership-less signed-in
   * user before the wizard's HTML ever loads (`hetzner/nginx.ts`) — so hostname-based routing is
   * not reachable against the landed D9/D10 topology without reopening that perimeter, a decision
   * this scaffold pass is explicitly not authorized to make on its own (see the spec's D11 scaffold
   * note). `orgSlug`, typed in by the user (told it out-of-band by the operator, the same way they
   * are told the code), is the pragmatic substitute: it preserves the security property D11 cares
   * about — org A's owner cannot claim org B without ALSO knowing org B's own code — at the cost of
   * the "walk up to your own subdomain" ergonomics, which remains open.
   */
  orgSlug: z.string().trim().min(1).max(63).optional(),
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

// ---- org creation (D11, admin-only) ------------------------------------------------------------
//
// ADDED 2026-08-07, 5b/5c/8 scaffold pass. `POST /internal/orgs` — the FIRST half of D11's split
// authority: "the org row — created by the installer through a new admin-only `POST
// /internal/orgs`, authenticated by `CEZ_SUPERVISOR_ADMIN_TOKEN`". Lives on the supervisor's
// `/internal/*` family (`supervisor/server.ts`), which BACKWARD_COMPATIBILITY.md §1 states in so
// many words is "explicitly NOT a protected surface" — this schema is still written to the same
// house style as everything else in this file (a consumer compiles against a shape, not
// `unknown`), it just isn't held to the same "additive-only" discipline the rest of this file is
// bound to.
//
// Fill unit 6 owns wiring this into `supervisor/server.ts`'s existing `/internal/orgs` route
// chain (today `GET`-only), inheriting `requireAdmin` (already `app.use`d on that path — 403
// before this schema's own validator ever runs, invariant 3) and reusing `IdentityStore#createOrg`
// AS-IS (already extended, this pass, with an optional `claimTokenHash` input — no store change
// left for that unit to make).

/**
 * `POST /internal/orgs` request body. `slug` is REQUIRED here (unlike `POST /auth/onboarding/org`,
 * which derives it server-side from a user-typed `name`) because the installer's `--org-slug` is
 * already the operator-chosen identifier the whole rest of the provisioning pipeline is keyed on
 * (`orgRegistrationCommand`, `server-install/platforms/hetzner.ts`) — deriving a SECOND slug from
 * `name` here would risk it disagreeing with the one already baked into the unix username, the
 * `CEZ_HOME` path and the systemd unit name.
 */
export const createInternalOrgInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  /** `slugInputSchema`, not a bare bounded string — see its own doc comment for the 500 that
   *  bought this regex. The installer derives this from `--org-slug`, so a malformed one is an
   *  operator typo that must fail as a 400 at the route, not as a stack trace from the store. */
  slug: slugInputSchema,
});
export type CreateInternalOrgInput = z.infer<typeof createInternalOrgInputSchema>;

/**
 * `bootstrapToken` is the RAW per-org claim code (`auth/org-claim-token.ts#mintOrgClaimToken`),
 * present exactly ONCE, in this response — the store keeps only its hash (`Org.claimTokenHash`,
 * `auth/types.ts`). The installer prints it for the operator to hand to that org's intended owner,
 * the same "shown once, never re-readable" idiom `CEZ_SUPERVISOR_SECRET` already follows one step
 * over in the SAME provisioning flow (`orgSystemdStep`'s own comment: "no value printed [to the
 * install log], none in argv" — for THAT secret; this one is printed by design, since an operator
 * with sudo on the box already holds the admin token that reaches this route, and the claim code
 * has to leave the machine to reach the actual owner).
 */
export const createInternalOrgResponseSchema = z.object({
  org: orgSchema,
  team: teamSchema,
  bootstrapToken: z.string(),
});
export type CreateInternalOrgResponse = z.infer<typeof createInternalOrgResponseSchema>;

// ---- team management (D2, Phase 5c) ------------------------------------------------------------
//
// ADDED 2026-08-07, 5b/5c/8 scaffold pass. Fill unit 3 (team CRUD store+HTTP) owns the routes;
// these are the wire shapes for the surfaces `PATCH /auth/onboarding/team` deliberately does NOT
// cover (D2's own 2026-08-07 amendment: that route only ever reaches the caller's OWN, first-
// created team — "the step only renames it" — so a second team named `engineering` or `marketing`
// can be created but never renamed by it, and can never be listed for a browser to pick from at
// all). All three routes below are D12 org-administration acts EXCEPT the list, which any signed-
// in member of the org may read (you don't need to be an admin to see which teams exist in order
// to file a project under one — only to create, rename or reassign).
//
// Suggested placement, same reasoning `invites.ts`'s own module doc comment gives: under the
// already-reserved `auth` segment (D5), alongside `/auth/onboarding/team` rather than replacing
// it — `GET /auth/teams`, `POST /auth/teams`, `PATCH /auth/teams/:teamId`. `PATCH
// /auth/onboarding/team` keeps its exact BACKWARD_COMPATIBILITY.md §2 contract untouched; these
// are additive siblings, not a replacement.

/** `GET /auth/teams` — every team in the caller's own org (never a body/query `orgId`, same
 *  structural argument as everywhere else in this file: the org is always the caller's resolved
 *  one). Read-only, open to any signed-in member — see this section's own module comment on why
 *  list is not D12-gated the way create/rename are. */
export const listTeamsResponseSchema = z.object({ teams: z.array(teamSchema) });
export type ListTeamsResponse = z.infer<typeof listTeamsResponseSchema>;

/** `POST /auth/teams` — D12 admin action: create a NEW team in the caller's own org.
 *  `IdentityStore#createTeam` already exists, guarded and tested, with zero HTTP caller today
 *  (spec D2's own 2026-08-07 amendment names this exact gap) — Fill unit 3 wires this straight to
 *  it. `slug`, unlike the onboarding org-name flow, is caller-supplied rather than derived: an
 *  admin creating `engineering`/`marketing` (D2's own examples) reasonably wants to pick the slug
 *  a project-team filter will show, not have one silently generated from a name they may rename
 *  later. */
export const createTeamInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  /** `slugInputSchema`, not a bare bounded string — see its own doc comment. This is the field a
   *  human types into the Settings → Teams pane, so it is the likeliest slug in the product to
   *  arrive with a space or a capital in it. */
  slug: slugInputSchema,
});
export type CreateTeamInput = z.infer<typeof createTeamInputSchema>;

export const createTeamResponseSchema = z.object({ team: teamSchema });
export type CreateTeamResponse = z.infer<typeof createTeamResponseSchema>;

/**
 * `PATCH /auth/teams/:teamId` — D12 admin action: rename ANY team in the caller's own org, unlike
 * `PATCH /auth/onboarding/team`'s "own resolved team only" reach. `IdentityStore#renameTeam`
 * already exists and is reused as-is; Fill unit 3's route handler is what must verify the named
 * `teamId` belongs to the caller's own org BEFORE calling it (`getTeamById(teamId).orgId ===
 * principal.orgId`, else 404 — the same "unknown-to-you reads as not-found, never as a different
 * org's team leaking through" posture `supervisor/server.ts`'s `GET /internal/teams/:teamId`
 * already established for the cross-process case, applied here to the in-process one).
 */
export const renameTeamInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
});
export type RenameTeamInput = z.infer<typeof renameTeamInputSchema>;

export const renameTeamResponseSchema = z.object({ team: teamSchema });
export type RenameTeamResponse = z.infer<typeof renameTeamResponseSchema>;

/**
 * `DELETE /auth/teams/:teamId` — D12 admin action: delete a team from the caller's own org.
 * **ADDED at Fill unit 3's own implementation pass (not in the scaffold's original three-route
 * list above)** — the unit's task explicitly asked for create/rename/reassign/**delete**, and
 * "delete" was the one CRUD verb the scaffold pass did not anticipate a wire shape for. Same
 * cross-org check as `PATCH` above (`getTeamById(teamId).orgId === principal.orgId`, else 404).
 *
 * Refused (409) if any project is still assigned to this team — `IdentityStore#deleteTeam`'s own
 * doc comment has the full reasoning for refuse-over-reassign; the caller must move every project
 * off this team first (`PATCH /api/v1/projects/:projectId`'s `teamId` field) and delete after.
 * `{ deleted: true, id }`, mirroring `removeProjectResponseSchema`'s own `{ removed: true, id }`
 * shape in `projects.ts` — same idiom, same file family's existing precedent.
 */
export const deleteTeamResponseSchema = z.object({ deleted: z.literal(true), id: z.string() });
export type DeleteTeamResponse = z.infer<typeof deleteTeamResponseSchema>;
