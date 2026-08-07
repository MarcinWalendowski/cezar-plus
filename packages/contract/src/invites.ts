import { z } from 'zod';
import { roleSchema } from './orgs.ts';

/**
 * The INVITE family — the wire half of D8's "subsequent users need an invite" (spec
 * `.ai/specs/2026-08-06-org-team-auth-onboarding.md`), Phase 5b.
 *
 * **Why this file exists separately from `orgs.ts`, per that file's own doc comment.** `orgs.ts`'s
 * "Scope note" says the invite storage shape (`auth/types.ts#inviteSchema`) was phase 4/5
 * scaffolding with no decided wire contract, and explicitly hands ownership of that wire contract
 * to "whichever unit builds the actual invite HTTP surface". This IS that file, written ahead of
 * that unit (5b/5c/8 scaffold pass, ADDED 2026-08-07) so Fill unit 1 (invite store+HTTP) has a
 * frozen shape to build routes against rather than inventing one mid-implementation.
 *
 * **Storage is already complete and tested — `auth/identity-store.ts`'s `createInvite`/
 * `redeemInvite`/`revokeInvite`/`getInvite`/`listOrgInvites` — this file adds nothing to that
 * layer, only the CLOSED wire shapes over it**, same split `orgs.ts` draws for org/team/membership.
 *
 * **`id` (the invite TOKEN itself) rides on every shape here, deliberately.** `auth/types.ts`'s
 * `inviteSchema` doc comment: "the invite token itself, unguessable and single-use ... the store
 * never invents it." Every route this file describes is D12 role-gated to `owner`/`admin` of the
 * ISSUING org (never a bare member, never cross-org) — the same bar `PATCH /auth/onboarding/team`
 * already sets for org administration — so an admin who is trusted to create/revoke an invite is
 * equally trusted to read back and re-share the code they (or a co-admin) already issued. This is
 * a deliberate choice, not an oversight: the alternative (hide the token after creation) would mean
 * a lost invite link can only be revoked-and-recreated, which is strictly worse for no additional
 * safety once the whole family is behind the D12 gate.
 *
 * **Route paths are SUGGESTED, not frozen — only the SCHEMAS below are the seam.** Under the
 * already-reserved `auth` top-level segment (D5), mirroring `PATCH /auth/onboarding/team`'s own
 * placement: `POST /auth/invites` (create), `GET /auth/invites` (list, org-scoped to the caller's
 * own org exactly like `PATCH /auth/onboarding/team` — never a body/query `orgId`), `POST
 * /auth/invites/revoke` (body-addressed, NOT `DELETE /auth/invites/:id` — the id IS the bearer
 * secret, and a secret does not belong in a URL a proxy or access log might keep), `POST
 * /auth/invites/redeem` (also body-addressed, for the SAME reason, and reachable by any signed-in
 * user with no membership yet — not role-gated, since redeeming is the one invite action a brand
 * new member has to be able to do before D12's role even applies to them).
 */

/** One invite, as the wire answers it — see this file's own "id rides on every shape" note above
 *  for why the token is not hidden after creation. Field names mirror `auth/types.ts#inviteSchema`
 *  exactly, same "agreement by construction, not by shared import" discipline `orgs.ts` documents
 *  for its own entity shapes (Node-free rule 1: this file has no runtime import of the storage
 *  schema). */
export const inviteSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  teamId: z.string().optional(),
  role: roleSchema,
  createdAt: z.string(),
  expiresAt: z.string(),
  consumedAt: z.string().optional(),
  consumedByUserId: z.string().optional(),
});
export type Invite = z.infer<typeof inviteSchema>;

/**
 * `POST /auth/invites` — D12 admin action: create an invite to the CALLER'S OWN org (never a body
 * `orgId` — the same structural argument `renameOnboardingTeamInputSchema` makes in `orgs.ts`: the
 * org this can ever target is whichever one `requirePrincipal` already resolved the caller into,
 * so a client cannot smuggle a different org's invite in even by trying).
 *
 * `teamId`, when present, must belong to the caller's own org — Fill unit 1 enforces that the same
 * way `IdentityStore#createInvite`'s own doc comment already specifies (`team-not-found` /
 * `team-org-mismatch`).
 *
 * **`expiresInMs` bounds and the default TTL are DELIBERATELY UNDECIDED here** — `auth/types.ts`'s
 * `inviteSchema` doc comment already says this policy "is deliberately left to whichever unit
 * implements those methods" (Fill unit 1). The wire field exists so a client CAN ask for a shorter
 * or longer window; the server-side min/max and the default when this is absent are that unit's
 * call to make and document where the route is implemented, not this scaffold's.
 */
export const createInviteInputSchema = z.object({
  role: roleSchema,
  teamId: z.string().min(1).optional(),
  expiresInMs: z.number().int().positive().optional(),
});
export type CreateInviteInput = z.infer<typeof createInviteInputSchema>;

export const createInviteResponseSchema = z.object({ invite: inviteSchema });
export type CreateInviteResponse = z.infer<typeof createInviteResponseSchema>;

/** `GET /auth/invites` — every invite ever issued by the caller's org, consumed/expired included
 *  (mirrors `IdentityStore#listOrgInvites`'s own "an admin history view's job to filter, not this
 *  method's" stance) — never another org's, and never a body/query `orgId` for the same reason
 *  `createInviteInputSchema` above has none. */
export const listOrgInvitesResponseSchema = z.object({ invites: z.array(inviteSchema) });
export type ListOrgInvitesResponse = z.infer<typeof listOrgInvitesResponseSchema>;

/** `POST /auth/invites/revoke` — body-addressed (see this file's module doc comment on why not a
 *  path param). Idempotent, mirroring `IdentityStore#revokeInvite`: revoking an already-gone,
 *  -expired or -consumed invite is not an error. */
export const revokeInviteInputSchema = z.object({ id: z.string().min(1) });
export type RevokeInviteInput = z.infer<typeof revokeInviteInputSchema>;

export const revokeInviteResponseSchema = z.object({ revoked: z.boolean() });
export type RevokeInviteResponse = z.infer<typeof revokeInviteResponseSchema>;

/**
 * `POST /auth/invites/redeem` — the one invite route a signed-in user with NO membership yet must
 * be able to reach, so (unlike every other route in this file) it is NOT D12 role-gated: there is
 * no role to gate on until this call grants the caller's first membership. `token` is named
 * differently from `Invite.id` on the wire deliberately — from the REDEEMING user's point of view
 * this is a code they were handed, not a resource id they are addressing; it is the exact same
 * string as `Invite.id` underneath (`IdentityStore#redeemInvite`'s own `input.id` parameter).
 *
 * Response mirrors `createOnboardingOrgResponseSchema` (`orgs.ts`) on purpose — both are "a
 * signed-in user becomes a member of an org", just via two different doors (bootstrap vs invite),
 * and a client that already knows how to render one already knows how to render the other.
 */
export const redeemInviteInputSchema = z.object({ token: z.string().min(1) });
export type RedeemInviteInput = z.infer<typeof redeemInviteInputSchema>;

export const redeemInviteResponseSchema = z.object({
  orgId: z.string(),
  teamId: z.string().optional(),
  role: roleSchema,
});
export type RedeemInviteResponse = z.infer<typeof redeemInviteResponseSchema>;
