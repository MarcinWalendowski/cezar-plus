import { z } from 'zod';

/**
 * Data models for org/team/user identity (D7, spec
 * `.ai/specs/2026-08-06-org-team-auth-onboarding.md` "Data Models"). The spec expresses these as
 * SQL because it states the constraints exactly; D7 corrects the STORAGE mechanism from SQLite to
 * JSON behind an `O_EXCL` lease (`node:sqlite` doesn't exist at cezar's `>=20` floor and
 * `better-sqlite3` is a native dependency this zero-install CLI cannot take on) while keeping the
 * exact same constraints — every `UNIQUE`/`PRIMARY KEY` in the SQL below is enforced by
 * `identity-store.ts`'s single guarded write helper, not by the storage engine.
 *
 * `.passthrough()` at every object layer, matching `automations/types.ts` and
 * `sources/types.ts`: this is on-disk state a later cezar version reads (BACKWARD_COMPATIBILITY.md
 * §3/§9), so a field a newer writer adds must survive an older reader's round-trip untouched.
 *
 * One table below (`inviteSchema`/`invites`) has no counterpart in the spec's SQL — see its own
 * doc comment for why this scaffold added it anyway (phase 4-5 scaffolding pass, spec unchanged).
 */

export const roleSchema = z.enum(['owner', 'admin', 'member']);
export type Role = z.infer<typeof roleSchema>;

/**
 * Shared by `orgs.slug` and `teams.slug`. DNS-label rules (lowercase alphanumeric, single interior
 * hyphens, 1-63 chars) even though only the org slug is presently spec'd to appear in a hostname
 * (D5: "nginx routes by hostname `acme.cezar.example.com`") — holding the team slug to the same
 * bar costs nothing today and avoids a second, looser slug shape existing beside it.
 */
export const slugSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, 'must be a lowercase, hyphen-safe slug (DNS label rules)');
export type Slug = z.infer<typeof slugSchema>;

/** Every timestamp in this store is `Date#toISOString()`, matching every other JSON store in the
 *  codebase (`RunRecord`, `AutomationDefinition`, ...) rather than a numeric epoch. */
const isoTimestamp = z.string().min(1);

export const orgSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().trim().min(1).max(200),
    slug: slugSchema,
    createdAt: isoTimestamp,
    /**
     * ADDED 2026-08-07 (5b/5c/8 scaffold pass, D11's crux — see `./org-claim-token.ts`'s module
     * doc comment for the full contract). A SHA-256 hex digest of this org's own bootstrap
     * ("claim") code, never the raw code itself — mirrors D7's own stance on the file as a whole
     * (0600, reasserted post-rename): a leak of `identity.json` must not also hand out every org's
     * live claim code.
     *
     * Optional, and absent for every org created the LEGACY way (the deployment's first-ever org,
     * self-served through `POST /auth/onboarding/org` with no `orgSlug` in the body — still
     * gated by the single, deployment-wide `./bootstrap-claim.ts` code, unchanged). Present only
     * for an org created by the admin-only `POST /internal/orgs` (D11), which mints one per org so
     * that org one's owner — who already saw the deployment-wide code to claim org one — cannot
     * also claim org two with it.
     */
    claimTokenHash: z.string().min(1).optional(),
  })
  .passthrough();
export type Org = z.infer<typeof orgSchema>;

export const teamSchema = z
  .object({
    id: z.string().min(1),
    orgId: z.string().min(1),
    name: z.string().trim().min(1).max(200),
    slug: slugSchema,
  })
  .passthrough();
export type Team = z.infer<typeof teamSchema>;

/**
 * `email`/`name` are deliberately unbounded-format free text, not `.email()`-validated: they are
 * IdP-supplied profile metadata, never the identity key (D7's whole point is that `(issuer,
 * subject)` is the key precisely because these can change or be absent), so re-validating their
 * shape here would risk a hard failure on a technically-odd but real value the IdP already
 * accepted. Length-capped only.
 */
export const userSchema = z
  .object({
    id: z.string().min(1),
    subject: z.string().min(1),
    issuer: z.string().min(1),
    email: z.string().trim().min(1).max(320).optional(),
    name: z.string().trim().min(1).max(200).optional(),
    createdAt: isoTimestamp,
  })
  .passthrough();
export type User = z.infer<typeof userSchema>;

/** No `id`/timestamp fields — the SQL model keys this on `(user_id, org_id)` alone and this store
 *  follows it exactly rather than inventing bookkeeping the data model doesn't ask for. */
export const membershipSchema = z
  .object({
    userId: z.string().min(1),
    orgId: z.string().min(1),
    role: roleSchema,
  })
  .passthrough();
export type Membership = z.infer<typeof membershipSchema>;

/**
 * `projectRoot` is the PRIMARY KEY, and it MUST be a realpath before it reaches this schema
 * (`identity-store.ts`'s `createProjectTeam` is the one place that calls `realpathSync` — see its
 * own comment) — a symlink and its target collapsing to two different keys is exactly the "two
 * processes over one `.ai/cezar`" data-loss D4 names, since `RunStore` still has no lease of its
 * own.
 */
export const projectTeamSchema = z
  .object({
    projectRoot: z.string().min(1),
    orgId: z.string().min(1),
    teamId: z.string().min(1),
  })
  .passthrough();
export type ProjectTeam = z.infer<typeof projectTeamSchema>;

/**
 * `id` is the session token itself (the value a `HttpOnly` cookie carries per D6) — deliberately
 * NOT store-generated like `Org`/`Team`/`User` ids, because the store has no business inventing
 * the cryptographically-random value that IS the credential; that randomness policy belongs to
 * whichever Phase 3 module mints it (`../auth/session.ts`), and `identity-store.ts` only persists
 * what it is given.
 */
export const sessionSchema = z
  .object({
    id: z.string().min(1),
    userId: z.string().min(1),
    expiresAt: isoTimestamp,
    createdAt: isoTimestamp,
  })
  .passthrough();
export type Session = z.infer<typeof sessionSchema>;

/**
 * A pending invite (D8: "the first user to sign in becomes owner of a new org; subsequent users
 * need an invite"). **Not in the spec's Data Models section** — that SQL block has six tables and
 * no `invites`, which is a genuine gap: D8 names the concept in prose but never says how a second
 * user is meant to acquire a membership before they have ever signed in (and so before a `User`
 * row, keyed on `(issuer, subject)`, can exist for them at all). This row is this scaffold's
 * minimal, additive answer, sized only to make `identity-store.ts`'s declared invite methods
 * well-typed — the actual creation/redemption POLICY (token entropy, default TTL, whether an
 * invite pre-assigns a team) is deliberately left to whichever unit implements those methods.
 *
 * `id` is the invite token itself, unguessable and single-use — the same "the id IS the
 * credential, the store never invents it" idiom `sessionSchema` above already uses, for the same
 * reason: a store that could mint its own bearer tokens would be a second place that policy (how
 * much entropy, what format) lives.
 */
export const inviteSchema = z
  .object({
    id: z.string().min(1),
    orgId: z.string().min(1),
    /** Optional: an invite may grant org membership without pre-assigning a team — D8 step 4
     *  ("add projects, assigned to that team") is where a team first matters, and nothing
     *  requires the inviter to have decided it up front. */
    teamId: z.string().min(1).optional(),
    role: roleSchema,
    createdAt: isoTimestamp,
    expiresAt: isoTimestamp,
    /** Both present together or both absent — set atomically by whatever redeems the invite, in
     *  the same guarded write that creates the resulting `Membership` (see `identity-store.ts`'s
     *  `redeemInvite` doc comment on why that atomicity matters). */
    consumedAt: isoTimestamp.optional(),
    consumedByUserId: z.string().min(1).optional(),
  })
  .passthrough();
export type Invite = z.infer<typeof inviteSchema>;

/** The whole on-disk snapshot (`identity.json`) as one object — see `identity-store.ts`'s module
 *  doc for why every table lives in one file behind one lease rather than six. `.passthrough()`
 *  here too, for the same forward-compat reason as every row schema above: `identity-store.ts`'s
 *  `readSnapshot` carries an unrecognized TOP-LEVEL key through untouched (it cannot lean on this
 *  schema's own array validation for that, because one bad row would then fail the whole array
 *  instead of just that row — see its own per-entry salvage comment), but the shape this infers is
 *  what makes that legal without an `as` cast. */
export const identitySnapshotSchema = z
  .object({
    version: z.literal(1),
    orgs: z.array(orgSchema),
    teams: z.array(teamSchema),
    users: z.array(userSchema),
    memberships: z.array(membershipSchema),
    projectTeams: z.array(projectTeamSchema),
    sessions: z.array(sessionSchema),
    /** See `inviteSchema`'s own doc comment for why this table exists at all despite having no
     *  entry in the spec's Data Models section. */
    invites: z.array(inviteSchema),
  })
  .passthrough();
export type IdentitySnapshot = z.infer<typeof identitySnapshotSchema>;

/** A fresh identity store before its first write — D7: "created lazily on first authenticated
 *  boot", so this is also what a missing `identity.json` reads as, never an error. */
export function emptyIdentitySnapshot(): IdentitySnapshot {
  return {
    version: 1,
    orgs: [],
    teams: [],
    users: [],
    memberships: [],
    projectTeams: [],
    sessions: [],
    invites: [],
  };
}
