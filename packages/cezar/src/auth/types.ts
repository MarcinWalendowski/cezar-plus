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
  })
  .passthrough();
export type IdentitySnapshot = z.infer<typeof identitySnapshotSchema>;

/** A fresh identity store before its first write — D7: "created lazily on first authenticated
 *  boot", so this is also what a missing `identity.json` reads as, never an error. */
export function emptyIdentitySnapshot(): IdentitySnapshot {
  return { version: 1, orgs: [], teams: [], users: [], memberships: [], projectTeams: [], sessions: [] };
}
