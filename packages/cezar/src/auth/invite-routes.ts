import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import {
  createInviteInputSchema,
  redeemInviteInputSchema,
  revokeInviteInputSchema,
  type CreateInviteResponse,
  type Invite as WireInvite,
  type ListOrgInvitesResponse,
  type RedeemInviteResponse,
  type RevokeInviteResponse,
} from '@loki-labs/better-cezar-contract';
import { jsonZodValidator } from '../server/validators.ts';
import { identityDir } from '../paths.ts';
import type { SessionResolver } from '../server/server.ts';
import { IdentityStore, IdentityStoreError } from './identity-store.ts';
import { hasOrgScope } from './principal.ts';
import { createRequireOrgAdmin, getOrgAdminPrincipal } from './require-org-admin.ts';
import { createRequireSignedIn, getSignedInUser } from './require-signed-in.ts';
import { sessionResolver } from './session.ts';
import type { Invite } from './types.ts';

/**
 * Phase 5b's invite HTTP surface (D8, D12; spec
 * `.ai/specs/2026-08-06-org-team-auth-onboarding.md`): `POST /auth/invites`,
 * `GET /auth/invites`, `POST /auth/invites/revoke`, `POST /auth/invites/redeem`.
 *
 * **Everything below the HTTP layer already exists and is untouched.** `identity-store.ts`'s
 * `createInvite`/`redeemInvite`/`revokeInvite`/`listOrgInvites` are fully implemented, tested for
 * single-use, expiry, org/team validation and the redeem-vs-membership-grant atomicity (including
 * the concurrent-redeem race) — see `identity-store.test.ts`'s "IdentityStore — invites" describe
 * block. This file is deliberately thin on top of that: HTTP verbs, status codes, D12's role gate,
 * and the one policy `packages/contract/src/invites.ts`'s own doc comment left open for whichever
 * unit builds this surface — token entropy and the default/bounds on `expiresInMs`.
 *
 * **Mount point.** A new, separate route family (own file, own `ServerDeps.inviteRoutes` field),
 * not folded into `./onboarding-routes.ts` — the same reasoning that file's own module doc comment
 * gives for why it isn't three more methods on `./routes.ts`'s `Hono`: this is a separate unit of
 * work, landed independently, and keeping it in its own file means this unit's diff touches no
 * file another 5b/5c/8 unit owns. `server.ts` mounts `deps.inviteRoutes` at the app root next to
 * `authRoutes`/`onboardingRoutes`, inside the SAME `app.use('/auth/*', originGuard)` region (D5's
 * amendment) — every path here falls under the already-reserved `auth` top-level segment, so no
 * new reservation is needed.
 *
 * **Token entropy — 256 bits, hex, matching `session.ts`'s `SESSION_ID_BYTES`.** Not
 * `bootstrap-claim.ts`/`org-claim-token.ts`'s 128-bit bar: those are chosen to be short enough to
 * retype off a terminal, because an operator reads them off `journalctl` and types them into a
 * browser. An invite token has no such ergonomic pressure — it travels as a link an inviter copies
 * and pastes — and redeeming one is at least as consequential as holding a session (it mints an
 * org membership, up to `owner`), so it gets the same security bar a session id gets, not the
 * shorter one a hand-typed code gets.
 *
 * **TTL bounds — undecided by the contract, decided here.** `createInviteInputSchema`'s own doc
 * comment: "the server-side min/max and the default when this is absent are that unit's call to
 * make and document where the route is implemented." Default 7 days (the common "org invite"
 * default — GitHub/Slack land in the same neighborhood); bounded `[15 minutes, 30 days]` — long
 * enough that a same-day invite never has to be re-issued, short enough that a forgotten one does
 * not sit valid indefinitely. Out-of-bounds is a 400, not a silent clamp: a caller who asked for a
 * specific window and got a different one without being told would be a worse surprise than a
 * clear rejection.
 *
 * **D12 role gate — `./require-org-admin.ts`'s shared `requireOrgAdmin`.** D12: "owner/admin gate
 * org administration: creating and revoking invites." That module (a separate unit of work,
 * 5b/5c/8's ownership map, "Role enforcement (D12)") is the generalized form of the one precedent
 * that predates it (`onboarding-routes.ts`'s inline `PATCH /auth/onboarding/team` check) — built as
 * middleware registered ahead of `jsonZodValidator` in each route's handler list, never a check
 * written inside the handler body downstream of it, which is the exact ordering the phase-6 repair
 * stage (`supervisor/server.ts`'s `requireAdmin`) had to fix once already (a non-admin getting 400,
 * leaking the body schema, instead of 403). `POST /auth/invites`, `GET /auth/invites` and
 * `POST /auth/invites/revoke` below all mount it as their first handler argument, and read the
 * principal back with `getOrgAdminPrincipal(c)` rather than re-resolving the cookie.
 *
 * **Revoke's org-scoping lives here, not in the store.** `IdentityStore#revokeInvite(id)` takes no
 * `orgId` — it is a bare id lookup, by design (mirrors `deleteSession`). Without a check at this
 * layer, an org-A admin who somehow learned org B's invite id (a leak elsewhere, not a guess — the
 * id is 256 bits of entropy) could revoke it, which is a real cross-org authorization violation
 * even though it grants no access. `POST /auth/invites/revoke` below confirms the id is present in
 * `listOrgInvites(principal.orgId)` — active OR already-inactive, so a genuinely-foreign id and an
 * id that is simply gone/expired/consumed in the CALLER'S OWN org both answer the same
 * `{revoked:false}`, and no oracle distinguishes "not yours" from "not found" or "already handled."
 *
 * **Constant-time comparison — the one D6/D12-adjacent requirement this file could not fully
 * deliver, flagged rather than silently dropped, mirroring `session.ts`'s own documented gap for
 * session ids exactly.** `IdentityStore#getInvite`/`redeemInvite`/`revokeInvite` look a supplied
 * token up with `Array.find`/`findIndex((row) => row.id === id)` — a plain, non-constant-time
 * string compare, same as `getSession`. `identity-store.ts` is explicitly out of this unit's
 * ownership (5b/5c/8 scaffold pass: "Reads: … identity-store.ts's already-implemented
 * `createInvite`/`redeemInvite`/`revokeInvite`/`getInvite`/`listOrgInvites` (unmodified)"), so the
 * fix — the same one `session.ts` already asks for on `getSession`: scan and compare every row with
 * `timingSafeEqual` instead of stopping at the first `===` match — is not made here. `INVITE_TOKEN_RE`
 * below rejects a malformed candidate before it reaches the store, which is `session.ts`'s own
 * "cheap format check, not a timing defense" — the shape is public, not secret. As with sessions,
 * the practical exposure is narrow: 256 bits of `randomBytes` entropy is a materially harder target
 * for a timing side-channel than the short, human-chosen secrets constant-time comparison is
 * normally deployed against — context for severity, not a reason this gap should stay open. Flagged
 * for Repair: extend `identity-store.ts#getInvite`/`redeemInvite`/`revokeInvite`'s lookups the same
 * way `session.ts` already asks for `getSession`.
 */

// ---- token minting -------------------------------------------------------------------------------

/** 256 bits, hex — see the module doc comment for why this bar and not `bootstrap-claim.ts`'s
 *  128-bit one. Injectable so a test can pin the value without reaching into `crypto`, mirroring
 *  `bootstrap-claim.ts`'s `MintToken`. */
export type MintInviteToken = () => string;

const INVITE_TOKEN_BYTES = 32;
/** Cheap format check only (see module doc's "Constant-time comparison" section) — fixed-length
 *  hex, mirroring `session.ts`'s `SESSION_ID_RE`. */
const INVITE_TOKEN_RE = /^[0-9a-f]{64}$/;

const defaultMintInviteToken: MintInviteToken = () => randomBytes(INVITE_TOKEN_BYTES).toString('hex');

/** `identity-store.ts#createInvite` throws `invite-id-taken` if a minted id happens to collide.
 *  At 256 bits that is not a realistic event — this cap exists only so a genuine RNG bug fails
 *  loudly instead of spinning forever, mirroring `session.ts`'s `MAX_ID_MINT_ATTEMPTS`. */
const MAX_ID_MINT_ATTEMPTS = 5;

const MIN_INVITE_TTL_MS = 15 * 60 * 1000;
const MAX_INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ---- deps: the testable seam --------------------------------------------------------------------

/** The subset of `IdentityStore` these routes touch — the same narrowing precedent
 *  `onboarding-routes.ts`'s `OnboardingIdentityStore` sets. */
export type InviteIdentityStore = Pick<
  IdentityStore,
  'createInvite' | 'listOrgInvites' | 'revokeInvite' | 'redeemInvite' | 'getSession' | 'getUserById'
>;

export interface InviteRouteDeps {
  /** D3's one resolver — threaded into `./require-org-admin.ts#createRequireOrgAdmin` for
   *  `POST /auth/invites`, `GET /auth/invites` and `POST /auth/invites/revoke`'s D12 gate.
   *  `POST /auth/invites/redeem` deliberately does NOT use this — see that route's own comment. */
  readonly sessionResolver: SessionResolver;
  readonly identityStore: InviteIdentityStore;
  readonly now?: () => Date;
  readonly mintToken?: MintInviteToken;
}

// ---- wire shaping ---------------------------------------------------------------------------------

/** Explicit field-by-field pick, not a passthrough spread — `types.ts#inviteSchema` is
 *  `.passthrough()` (D7), so reading a row straight off disk could otherwise leak a future column,
 *  the exact reasoning `onboarding-routes.ts`'s `toWireOrg`/`toWireTeam` already state. */
function toWireInvite(invite: Invite): WireInvite {
  return {
    id: invite.id,
    orgId: invite.orgId,
    teamId: invite.teamId,
    role: invite.role,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    consumedAt: invite.consumedAt,
    consumedByUserId: invite.consumedByUserId,
  };
}

// ---- the routes -----------------------------------------------------------------------------------

export function createInviteRoutes(deps: InviteRouteDeps): Hono {
  const now = deps.now ?? (() => new Date());
  const mintToken = deps.mintToken ?? defaultMintInviteToken;
  // Own instance (not the process-wide `requireOrgAdminSingleton`) so this factory stays testable
  // against a fake `SessionResolver` — the same shape `require-org-admin.test.ts`'s own `buildApp`
  // helper uses, and the same reason `createOnboardingRoutes` takes its resolver as a dep rather
  // than importing the singleton directly.
  const adminGate = createRequireOrgAdmin(deps.sessionResolver);
  // The LOWER bar, for redeem alone (`./require-signed-in.ts`) — registered as middleware for the
  // same reason `adminGate` is, and fixing the same ordering defect one bar down: this route used
  // to resolve the caller inside the handler, i.e. downstream of `jsonZodValidator`, so an
  // UNAUTHENTICATED stranger sending `{}` got a 400 naming the request schema instead of a 401.
  const signedInGate = createRequireSignedIn(deps.identityStore);

  return new Hono()
    // ---- POST /auth/invites: D12 admin action, org derived from the principal, never the body ----
    .post('/auth/invites', adminGate, jsonZodValidator(createInviteInputSchema), async (c) => {
      const principal = getOrgAdminPrincipal(c);
      if (!hasOrgScope(principal)) {
        // Defensive narrowing only (also what makes `principal.orgId` a `string` below to the
        // type checker) — `adminGate` here is always `createRequireOrgAdmin` (D13: `inviteRoutes`
        // stays unmounted in local mode, module doc comment), which only ever stashes a
        // `kind: 'session'` principal, and `resolvePrincipal` only builds that kind from an
        // already-resolved `SessionIdentity` whose `orgId`/`teamId` are non-null by construction
        // (`principal.ts`). Unreachable in practice; see `team-routes.ts`'s identical guard.
        return c.json({ error: 'no organization exists yet' }, 400);
      }
      const { role, teamId, expiresInMs } = c.req.valid('json');
      const ttlMs = expiresInMs ?? DEFAULT_INVITE_TTL_MS;
      if (ttlMs < MIN_INVITE_TTL_MS || ttlMs > MAX_INVITE_TTL_MS) {
        return c.json(
          { error: `expiresInMs must be between ${MIN_INVITE_TTL_MS} and ${MAX_INVITE_TTL_MS}` },
          400,
        );
      }
      const expiresAt = new Date(now().getTime() + ttlMs);
      for (let attempt = 0; attempt < MAX_ID_MINT_ATTEMPTS; attempt += 1) {
        try {
          const invite = await deps.identityStore.createInvite({
            id: mintToken(),
            orgId: principal.orgId,
            teamId,
            role,
            expiresAt,
          });
          const body: CreateInviteResponse = { invite: toWireInvite(invite) };
          return c.json(body, 201);
        } catch (error) {
          if (error instanceof IdentityStoreError) {
            if (error.code === 'invite-id-taken') continue; // 2^-256: due diligence, not expectation
            if (error.code === 'team-not-found' || error.code === 'team-org-mismatch') {
              return c.json({ error: 'teamId must name a team in your own organization' }, 400);
            }
            // `org-not-found` is unreachable: `principal.orgId` was resolved from a real
            // membership by the SAME resolver `requirePrincipal` trusts everywhere else.
          }
          throw error;
        }
      }
      throw new Error(`failed to mint a unique invite token after ${MAX_ID_MINT_ATTEMPTS} attempts`);
    })

    // ---- GET /auth/invites: every invite the caller's org has ever issued, org-scoped by the
    // resolved principal — never a body/query `orgId` (same structural argument
    // `renameOnboardingTeamInputSchema` already makes: the only org this can ever read is whichever
    // one `requirePrincipal`-equivalent resolution already put the caller in) --------------------
    .get('/auth/invites', adminGate, (c) => {
      const principal = getOrgAdminPrincipal(c);
      if (!hasOrgScope(principal)) {
        // Defensive narrowing only — see `POST /auth/invites`'s identical guard above.
        return c.json({ error: 'no organization exists yet' }, 400);
      }
      const invites = deps.identityStore.listOrgInvites(principal.orgId).map(toWireInvite);
      const body: ListOrgInvitesResponse = { invites };
      return c.json(body);
    })

    // ---- POST /auth/invites/revoke: body-addressed (the id IS the bearer secret — see
    // `contract/src/invites.ts`'s module doc for why not a path param), org-scoped here because the
    // store method itself is not (see this file's module doc comment) ------------------------------
    .post('/auth/invites/revoke', adminGate, jsonZodValidator(revokeInviteInputSchema), async (c) => {
      const principal = getOrgAdminPrincipal(c);
      if (!hasOrgScope(principal)) {
        // Defensive narrowing only — see `POST /auth/invites`'s identical guard above.
        return c.json({ error: 'no organization exists yet' }, 400);
      }
      const { id } = c.req.valid('json');
      const belongsToCallerOrg = deps.identityStore.listOrgInvites(principal.orgId).some((invite) => invite.id === id);
      if (!belongsToCallerOrg) {
        // Same observable outcome whether `id` names no invite anywhere, or names one that
        // belongs to a DIFFERENT org — no oracle distinguishes "not yours" from "not found".
        const body: RevokeInviteResponse = { revoked: false };
        return c.json(body);
      }
      const revoked = await deps.identityStore.revokeInvite(id);
      const body: RevokeInviteResponse = { revoked };
      return c.json(body);
    })

    // ---- POST /auth/invites/redeem: the one invite route NOT behind D12's gate — reachable by
    // any signed-in user with no membership yet, since there is no role to gate on before this
    // call grants the caller's first one (see `contract/src/invites.ts`'s own doc comment) --------
    .post('/auth/invites/redeem', signedInGate, jsonZodValidator(redeemInviteInputSchema), async (c) => {
      const user = getSignedInUser(c);
      const { token } = c.req.valid('json');
      if (!INVITE_TOKEN_RE.test(token)) {
        // Same answer a well-formed-but-unknown token gets — a malformed candidate must not be
        // distinguishable from a real one that simply does not exist.
        return c.json({ error: 'invite not found' }, 404);
      }
      try {
        const { invite, membership } = await deps.identityStore.redeemInvite({ id: token, userId: user.userId });
        const body: RedeemInviteResponse = { orgId: invite.orgId, teamId: invite.teamId, role: membership.role };
        return c.json(body, 201);
      } catch (error) {
        if (error instanceof IdentityStoreError) {
          if (error.code === 'invite-not-found') return c.json({ error: 'invite not found' }, 404);
          if (error.code === 'invite-already-consumed') return c.json({ error: 'this invite has already been used' }, 409);
          if (error.code === 'invite-expired') return c.json({ error: 'this invite has expired' }, 410);
          if (error.code === 'membership-exists') return c.json({ error: 'you are already a member of this organization' }, 409);
          // ADDED 2026-08-07 (5b/5c/8 repair stage). F4: `session.ts#resolveIdentity` pins a
          // signed-in user to `listMemberships(userId)[0]` and there is no active-org switcher, so
          // a membership in a SECOND org is inert. This used to answer 201 with the new org and
          // role — a grant the product could not deliver on any subsequent request — and burn the
          // single-use token doing it, so the org's owner could not even re-send it. The store now
          // refuses BEFORE writing, which is what leaves the invite unconsumed and still revocable.
          // The message names the constraint rather than the symptom, because the invitee cannot
          // act on "403": the only thing that works today is a second identity.
          if (error.code === 'user-already-member') {
            return c.json(
              {
                error:
                  'you already belong to another organization on this deployment, and cezar cannot switch between them yet — this invite has NOT been used up, so it can still be redeemed by an account with no organization',
              },
              409,
            );
          }
          if (error.code === 'user-not-found') {
            // Unreachable in practice: `resolveSignedInUser` already resolved a real `User` row
            // for this exact id — same "should never happen, fail closed" stance
            // `onboarding-routes.ts` takes for its own unreachable branches.
            return c.json({ error: 'your account could not be found' }, 500);
          }
        }
        throw error;
      }
    });
}

// ---- the real, process-lifetime wiring ------------------------------------------------------------

/** Opens its OWN `IdentityStore` at the same directory `./session.ts`/`./routes.ts`/
 *  `./onboarding-routes.ts` each open theirs — see `onboarding-routes.ts`'s own comment on why that
 *  is exactly as consistent as sharing one (no in-memory cache anywhere in this class). Reuses the
 *  module-scope `sessionResolver` singleton from `./session.ts` rather than threading it through a
 *  second time. */
function buildInviteRoutes(): Hono {
  const identityStore = IdentityStore.open(identityDir());
  return createInviteRoutes({ sessionResolver, identityStore });
}

/** What `src/index.ts`'s `serveCommand` dynamically imports and threads into `server.ts`'s
 *  `ServerDeps.inviteRoutes`, AND what `supervisor/index.ts`'s `startSupervisor` threads into
 *  `SupervisorAppDeps.inviteRoutes` — mounted at the app root beside `authRoutes`/
 *  `onboardingRoutes` on whichever process serves `/auth/*`: the single process (phases 1-5) or the
 *  supervisor (D10, phases 6-8). Both mounts matter and the second one was missing until the
 *  5b/5c/8 integration pass: nginx's per-org vhost sends every `/auth/` request to the supervisor,
 *  so invites mounted only by `serveCommand` were unreachable on the exact hosted deployment 5b
 *  exists to give a second member. Synchronous, like `onboardingRoutes` and for the same reason:
 *  nothing here has external config to resolve or a discovery call to make. */
export const inviteRoutes: Hono = buildInviteRoutes();
