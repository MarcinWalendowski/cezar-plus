import { createHash, timingSafeEqual } from 'node:crypto';
import type { OrgProcessRecord } from './org-process-registry.ts';

/**
 * Who is calling the supervisor's `/internal/*` surface (D4/D10, spec
 * `.ai/specs/2026-08-06-org-team-auth-onboarding.md`).
 *
 * **ADDED 2026-08-07 at the phase 6/7 repair stage. Before it there was no check at all.**
 * `supervisor/registry-client.ts` had sent `Authorization: Bearer <CEZ_SUPERVISOR_SECRET>` on
 * every call since it was written, and documented at length the 401/403 contract it expected —
 * `supervisor/server.ts` read no `Authorization` header, and its own 27-test suite called every
 * route with no credential and asserted 200, so the suite DOCUMENTED the surface as open rather
 * than closing it. Six independent reviews reproduced the same chain against the real app:
 *
 *   DELETE /internal/project-teams/by-root?root=<org A's root>   -> 200 {"released":true}
 *   POST   /internal/project-teams {root: <A's>, orgId: <B>}     -> 201
 *
 * i.e. any caller could destroy D4's root→org claim and re-take it for another org, which D4's
 * own amendment 1 names as "not tenancy-shaped behaviour, it is data loss" — and, worse,
 * `POST /internal/org-processes` let a caller re-register an org with an attacker-chosen
 * `supervisorSecret`, which is the key that signs that org's forwarded principals.
 *
 * ## Two kinds of caller, deliberately not one
 *
 * - **`org`** — an org's own `cezar serve` process, authenticated by ITS OWN
 *   `CEZ_SUPERVISOR_SECRET` (`OrgProcessRecord#supervisorSecret`). The secret both authenticates
 *   the caller and ANSWERS "which org is this", so a caller can never claim to be a different org
 *   than the one whose secret it holds — which is why `requireCallerOrg` below refuses an
 *   `orgId` parameter that disagrees, rather than trusting it. Resolved by reverse lookup over
 *   every ACTIVE record; a secret matching no active org is not a caller.
 * - **`admin`** — the operator's own provisioning tooling (`server-install --platform hetzner`),
 *   authenticated by `CEZ_SUPERVISOR_ADMIN_TOKEN` from the supervisor's root-owned
 *   `EnvironmentFile=`. This exists because of a genuine bootstrap problem the registry client's
 *   own module doc named and could not solve: the installer's very FIRST
 *   `POST /internal/org-processes` for a new org is the call that creates that org's secret, so by
 *   definition it cannot hold one yet. An operator with sudo on the box can read the supervisor's
 *   `EnvironmentFile`; a remote attacker cannot.
 *
 * **Unset `CEZ_SUPERVISOR_ADMIN_TOKEN` closes the admin surface entirely** rather than opening it
 * — `resolveInternalCaller` compares against `undefined` by returning `null` before any compare,
 * so a supervisor provisioned without one simply has no admin caller. Fail closed is the whole
 * point of this module.
 *
 * ## Timing-safe, and length-independent
 *
 * Both compares hash each side with SHA-256 first and `timingSafeEqual`s the fixed-width digests.
 * Hashing is not for secrecy (the values are already high-entropy secrets); it is what makes the
 * comparison safe when the two strings differ in LENGTH — `timingSafeEqual` throws on a length
 * mismatch, and branching on `a.length !== b.length` first would leak the secret's length. The
 * same shape `forwarded-principal.ts#verifyForwardedPrincipal` uses, where the expected value has
 * a fixed length so it could take the simpler route; here it cannot.
 */

export type InternalCaller =
  | { readonly kind: 'admin' }
  /** An org process, identified by the org whose `supervisorSecret` it presented. */
  | { readonly kind: 'org'; readonly orgId: string };

/** `Bearer <token>` (case-insensitive scheme, per RFC 7235), or `undefined`. Never throws. */
export function bearerToken(authorizationHeader: string | undefined | null): string | undefined {
  if (!authorizationHeader) return undefined;
  const match = /^bearer[ \t]+(.+)$/i.exec(authorizationHeader.trim());
  const token = match?.[1]?.trim();
  return token ? token : undefined;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right);
}

export interface InternalAuthDeps {
  /** `process.env.CEZ_SUPERVISOR_ADMIN_TOKEN` in production. Absent ⇒ no admin caller exists. */
  readonly adminToken?: string;
  /** Every record the registry holds — filtered to `status === 'active'` here, so a deprovisioned
   *  org's secret stops authenticating the moment it is deprovisioned rather than whenever the
   *  caller next restarts. */
  listOrgProcesses(): readonly OrgProcessRecord[];
}

/**
 * `null` for "no recognised credential" — the caller answers 401. Deliberately does NOT
 * distinguish "no header" from "wrong secret" in its return value: both are the same answer to
 * the network, and a supervisor that told a prober which one it got would be an oracle for
 * whether a guessed secret belongs to a real org.
 */
export function resolveInternalCaller(
  authorizationHeader: string | undefined | null,
  deps: InternalAuthDeps,
): InternalCaller | null {
  const token = bearerToken(authorizationHeader);
  if (!token) return null;
  if (deps.adminToken && constantTimeEquals(token, deps.adminToken)) return { kind: 'admin' };
  for (const record of deps.listOrgProcesses()) {
    if (record.status !== 'active') continue;
    if (constantTimeEquals(token, record.supervisorSecret)) return { kind: 'org', orgId: record.orgId };
  }
  return null;
}

/**
 * The org-scoping check `registry-client.ts`'s own wire contract specifies: "the supervisor MUST
 * refuse (403) if that param does not equal the org the bearer secret resolved to, or one org
 * could enumerate another's full team list / project claims across the network boundary the
 * in-process call never had to cross".
 *
 * An `admin` caller passes any `orgId` — it is the operator's own tooling, which by construction
 * acts on every org on the box (it is the thing that provisions them).
 *
 * An `org` caller with an ABSENT `orgId` is refused too, not defaulted to its own: every route
 * that calls this takes `orgId` as a filter, and a missing filter means "every org". Defaulting
 * would be the friendlier choice and the wrong one — a client that forgot the parameter would
 * silently get the right answer here and the wrong one against any future unscoped route.
 */
export function callerMayUseOrgId(caller: InternalCaller, orgId: string | undefined): boolean {
  if (caller.kind === 'admin') return true;
  return orgId !== undefined && orgId === caller.orgId;
}
