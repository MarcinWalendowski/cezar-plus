import { z } from 'zod';

/**
 * **Phase 6/7 scaffold** (D4, spec `.ai/specs/2026-08-06-org-team-auth-onboarding.md`, "D10"
 * section). Schema only — the store (an `O_EXCL`-leased JSON file the way `auth/identity-store.ts`
 * and `sources/store.ts` already do it, per D7's house style) is Fill unit 1's to build. This file
 * exists now so unit 1 (which writes it) and unit 6 (`server-install --platform hetzner`, which
 * reads it to render systemd units and nginx vhosts) share one shape from the start rather than
 * converging on it after both are half-built.
 *
 * **Not the same mapping as `identity-store.ts`'s `project_teams`.** That table answers "which org
 * owns THIS PROJECT ROOT" (D4's "one root, one org" constraint) and already exists, tested, and —
 * per the phase-6 row — becomes the supervisor's to own exclusively (it just runs where
 * `identityDir()` already points, since the supervisor process IS what phase 1-5 called "the"
 * cezar process; no schema change needed there). This file answers a different question: "which
 * INFRASTRUCTURE realizes org X" — its unix user, its `CEZ_HOME`, its port, its hostname, and the
 * secret that lets `forwarded-principal.ts` authenticate requests routed to its process. One org
 * has exactly one `project_teams` row per registered project, and exactly one
 * `OrgProcessRecord` (unless/until a phase supports more than one process per org, which D4 does
 * not ask for).
 *
 * **Where this lives is deliberately unspecified here.** It is supervisor-owned state, so it
 * belongs under whatever `CEZ_HOME` the supervisor process itself runs with — analogous to
 * `identity/` in `paths.ts#identityDir()`, but that function must NOT be reused for it: a
 * directory named `identity` holding infrastructure secrets rather than identity rows would be a
 * false trail for the next reader, and every consumer of `identityDir()` today (`session.ts`'s
 * singleton, `auth/routes.ts`, `onboarding-routes.ts`) is landed code this scaffold pass does not
 * touch. Unit 1 adds one new `paths.ts`-style function (e.g. `orgProcessRegistryPath()`) rather
 * than overloading this one.
 */

export const orgProcessStatusSchema = z.enum(['active', 'deprovisioned']);
export type OrgProcessStatus = z.infer<typeof orgProcessStatusSchema>;

/** Matches every other timestamp in this codebase — `Date#toISOString()`, never a numeric epoch. */
const isoTimestamp = z.string().min(1);

/**
 * One organization's infrastructure, as provisioned by `server-install --platform hetzner
 * --domain <hostname>` (see the spec's "D10" section for why provisioning is an operator-run step
 * separate from `POST /auth/onboarding/org`, which only creates the identity-side `Org` row).
 */
export const orgProcessRecordSchema = z
  .object({
    /** `identity-store.ts` `Org#id` — the join key back to the org this infrastructure realizes.
     *  Not this file's to validate for existence; the CLI step that writes a record here is
     *  responsible for having resolved it against the supervisor's identity store first. */
    orgId: z.string().min(1),
    /** `identity-store.ts` `Org#slug`, mirrored here rather than re-joined on every read — this
     *  is what names the unix user / `CEZ_HOME` / systemd unit / nginx site, all of which must
     *  stay stable even if the org's display name (never its slug) is ever editable later. */
    orgSlug: z.string().min(1),
    /** The dedicated, no-login system account this org's systemd unit runs as (D4: "its own unix
     *  user"). Conventionally `cez-<orgSlug>`, but this schema does not enforce that naming — the
     *  provisioning step picks it and records what it actually created. */
    unixUser: z.string().min(1),
    /** Absolute path, owned by `unixUser` — the `Environment=CEZ_HOME=` value this org's
     *  systemd unit carries (D4: "its own CEZ_HOME"). Deliberately never equal to the
     *  supervisor's own home or to any other org's. */
    cezHome: z.string().min(1),
    /** The loopback port this org's `cezar serve` binds — MUST be passed with the strict-bind
     *  flag Fill unit 6 adds to `index.ts` (see the spec's D10 §"port must be a hard bind"), never
     *  the auto-picks-the-next-free-port default `pickPort` uses elsewhere, or this value silently
     *  stops matching what nginx's static `proxy_pass` was rendered with. */
    loopbackPort: z.number().int().positive().max(65535),
    /** The public hostname nginx routes to this org's process — a subdomain of the deployment's
     *  one base domain (D10's "single base domain, one supervisor login host" constraint; see that
     *  section for why a fully custom per-org domain is out of scope for phase 7). */
    hostname: z.string().min(1),
    /** A closed literal today on purpose — the day a second platform provisions per-org
     *  infrastructure this way, this becomes `z.enum([...])` alongside `PLATFORM_IDS`
     *  (`server-install/types.ts`) rather than a bare string nothing validates against that list. */
    platformId: z.literal('hetzner'),
    /**
     * The HMAC secret `forwarded-principal.ts` signs/verifies with for this org, and only this
     * org — see that file's own doc comment for why one secret per org (not one shared secret
     * for the whole deployment) is load-bearing rather than convenient. Plaintext by necessity:
     * the supervisor must recompute the identical HMAC on every request, so this cannot be hashed
     * the way a password would be. File-permission discipline carries the protection instead —
     * whatever store Fill unit 1 builds around this schema must write it at the same `0600`,
     * `O_EXCL`-staged posture `identity-store.ts` already uses for `identity.json`, which itself
     * holds session ids of comparable sensitivity.
     */
    supervisorSecret: z.string().min(32),
    status: orgProcessStatusSchema,
    createdAt: isoTimestamp,
  })
  /** `.passthrough()`, matching `auth/types.ts`'s on-disk schemas (not `forwarded-principal.ts`'s
   *  wire schema, which is `.strict()` for the opposite reason) — this IS on-disk state a later
   *  cezar version reads, so a field a newer writer adds must survive an older reader's
   *  round-trip untouched (BACKWARD_COMPATIBILITY.md §3/§9's rule, applied here ahead of time). */
  .passthrough();
export type OrgProcessRecord = z.infer<typeof orgProcessRecordSchema>;

export const orgProcessRegistrySchema = z
  .object({
    version: z.literal(1),
    orgs: z.array(orgProcessRecordSchema),
  })
  .passthrough();
export type OrgProcessRegistry = z.infer<typeof orgProcessRegistrySchema>;

/** A fresh registry before its first provisioned org — also what a missing registry file reads
 *  as, never an error, on the `identity-store.ts#emptyIdentitySnapshot` precedent. */
export function emptyOrgProcessRegistry(): OrgProcessRegistry {
  return { version: 1, orgs: [] };
}
