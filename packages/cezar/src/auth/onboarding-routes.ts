import { Hono, type Context, type Next } from 'hono';
import {
  createOnboardingOrgInputSchema,
  renameOnboardingTeamInputSchema,
  type CreateOnboardingOrgResponse,
  type OnboardingStatusResponse,
  type Org as WireOrg,
  type RenameOnboardingTeamResponse,
  type Team as WireTeam,
} from '@loki-labs/better-cezar-contract';
import { jsonZodValidator } from '../server/validators.ts';
import { identityDir } from '../paths.ts';
import type { SessionResolver } from '../server/server.ts';
import {
  bootstrapClaim,
  matchesBootstrapClaim,
  type BootstrapClaim,
} from './bootstrap-claim.ts';
import { IdentityStore, IdentityStoreError } from './identity-store.ts';
import { invalidateLocalOrgIdentityCache } from './local-identity.ts';
import { matchesOrgClaimToken } from './org-claim-token.ts';
import { hasOrgScope } from './principal.ts';
import { createRequireOrgAdmin, getOrgAdminPrincipal } from './require-org-admin.ts';
import { createRequireSignedIn, getSignedInUser, resolveSignedInUser } from './require-signed-in.ts';
import { sessionResolver } from './session.ts';
import type { Org, Team } from './types.ts';

/**
 * D8's onboarding HTTP surface (spec `.ai/specs/2026-08-06-org-team-auth-onboarding.md`, phases
 * 4-5): `GET /auth/onboarding`, `POST /auth/onboarding/org`, `PATCH /auth/onboarding/team`.
 *
 * **Mount point — same family as `./routes.ts`, same reasoning.** `server.ts` mounts
 * `deps.onboardingRoutes` at the app ROOT next to `deps.authRoutes`, only when `CEZ_AUTH` names a
 * provider, and this file's paths (`/auth/onboarding*`) all fall under the reserved `auth` segment
 * D5 already carved out — no new top-level reservation needed. Critically, that root mount is
 * INSIDE `app.use('/auth/*', originGuard)` (the #426 loopback-Host allowlist + same-origin write
 * guard D5's own amendment added): phase 3 originally mounted `/auth/*` OUTSIDE `app.use('/api/*',
 * originGuard)`, leaving `POST /auth/logout` as the only unguarded write in the whole app, closed
 * by registering the SAME guard handler on both `/api/*` and `/auth/*`. This file's two mutating
 * routes ride that fix for free by living under `/auth/*` too — see
 * `onboarding-routes.test.ts`'s "mount point" suite, which proves it rather than assuming it.
 *
 * **CORRECTED 2026-08-07 by D13: "only when `CEZ_AUTH` names a provider" above is no longer
 * true.** `server.ts` mounts `deps.onboardingRoutes` whenever the field is populated, and D13's
 * local-mode branch (`../local-mode-boot.ts#buildLocalModeRoutes`, gated on
 * `isLocalOrgModeActive`, never on `CEZ_AUTH` naming a provider) populates it on a loopback bind
 * with `CEZ_AUTH` unset too — the npm zero-config default. So `GET /auth/onboarding`,
 * `POST /auth/onboarding/org` and `PATCH /auth/onboarding/team` are mounted in BOTH cases D1's
 * table distinguishes: an authenticated deployment, and a local one that has never set `CEZ_AUTH`
 * at all. The reserved-segment and `originGuard` reasoning above holds unchanged in both cases —
 * only the mounting *condition* was wrong.
 *
 * **Why this can't just be three more routes on `./routes.ts`'s `Hono`.** `routes.ts`'s own
 * module doc comment names exactly this gap and defers it: "a user who signs in with no existing
 * membership gets a real, valid session... every principal-gated read answers 401/unauthenticated
 * for them until an org exists" — `GET /auth/onboarding` is precisely the route that has to
 * answer THAT user, so it structurally cannot sit behind `requirePrincipal`
 * (`app.use('/api/*', ...)`, `server.ts`) OR treat "no session resolved" as terminal the way
 * `./routes.ts`'s `/auth/me` does. It needs a level of detail `SessionResolver` deliberately
 * collapses away: `session.ts`'s own module doc says a signed-in user with no membership yet
 * resolves to `null`, the exact same `null` an absent/expired/malformed cookie produces. This
 * file is the one place that tells those two apart — by reading `identity-store.ts`'s
 * `getSession`/`getUserById` directly, the way `orgs.ts`'s own doc comment on
 * `onboardingStateSchema` anticipated.
 *
 * **Authorization is three different bars, on purpose, not an oversight.**
 *  - `GET /auth/onboarding` and `POST /auth/onboarding/org` require only a SIGNED-IN USER (a
 *    resolvable session, a real `User` row) — D8 step 1's whole premise is that this route serves
 *    someone who does not have an org yet, so it cannot require the full D3 `Principal`
 *    (`orgId`/`teamId`/`role`), which by construction does not exist for them.
 *  - `POST /auth/onboarding/org` adds the **bootstrap claim** on top of that (ADDED 2026-08-07,
 *    `./bootstrap-claim.ts`): a signed-in user is not automatically permitted to *own* the
 *    deployment. With `CEZ_AUTH=google` the issuer is pinned but the audience is the whole
 *    internet, so "first to arrive" would hand a stranger `role: 'owner'` and, through it, shell
 *    execution. That module's doc comment carries the reproduced chain and the three modes.
 *  - `PATCH /auth/onboarding/team` requires a fully resolved `Principal` **with `role` owner or
 *    admin** — enforced by `./require-org-admin.ts`'s shared `createRequireOrgAdmin` middleware,
 *    registered AHEAD of this route's `jsonZodValidator` (corrected 2026-08-07 at the 5b/5c/8
 *    integration pass; see the route's own comment for what the old in-handler ordering cost).
 *    It resolves through the SAME `sessionResolver` `server.ts`'s `requirePrincipal` and
 *    `verifyWsUpgrade` use (D3) — never a second, hand-rolled membership lookup. That is what
 *    makes "a member of org A cannot rename org B's team" true BY CONSTRUCTION rather than by a
 *    check this file remembers to add: the route takes no `orgId`/`teamId` in its body at all, and
 *    the only team it can ever touch is `principal.teamId`, which the shared resolver derived from
 *    the caller's OWN membership. See `onboarding-routes.test.ts`'s two-org negative test —
 *    including one where the request body tries to smuggle a different `orgId`/`teamId` and is
 *    ignored.
 */

// ---- deps: the testable seam --------------------------------------------------------------------

/** The subset of `IdentityStore` these routes touch — narrowed (not the whole class) so a test can
 *  hand in a fake without standing up every unrelated method, though in practice
 *  `onboarding-routes.test.ts` follows `./routes.test.ts`'s own precedent and uses a REAL,
 *  temp-directory `IdentityStore` throughout (no fakes for the store this file's whole job is to
 *  read/write correctly). */
export type OnboardingIdentityStore = Pick<
  IdentityStore,
  | 'getSession'
  | 'getUserById'
  | 'getOrgById'
  | 'getOrgBySlug'
  | 'getTeamById'
  | 'listOrgs'
  | 'listProjectTeams'
  | 'claimOrg'
  | 'renameTeam'
>;

export interface OnboardingRouteDeps {
  /** D3's one resolver — see the module doc comment on why `PATCH /auth/onboarding/team` uses
   *  this and the other two routes deliberately do not.
   *
   *  **D13 (phase 9 HTTP surface): also what `GET /auth/onboarding` reads for local mode.** In
   *  local mode this is `./local-gates.ts#localSessionResolver` — never `null`, `kind: 'local'` —
   *  wired by `src/index.ts` beside `localSignedInGate`/`localOrgAdminGate` below. Session mode's
   *  cookie-based resolver keeps being threaded here unchanged. */
  readonly sessionResolver: SessionResolver;
  readonly identityStore: OnboardingIdentityStore;
  /** Who is allowed to be the first user (`./bootstrap-claim.ts`). Injected rather than read from
   *  the module singleton so a test can exercise all three modes without mutating the shared
   *  `process.env` (one global per vitest worker, the same reason `SessionServiceOptions.
   *  authProvider` is injectable). Defaults to the process-lifetime claim.
   *
   *  **D13: local mode supplies a LITERAL `{ required: false, mode: 'open' }` here, never the
   *  imported `./bootstrap-claim.ts#bootstrapClaim` singleton.** That singleton is keyed on
   *  `resolveAuthProvider(env) === 'none'` — true for BOTH loopback (this file's local mode) and
   *  a hosted, `CEZ_ALLOW_UNAUTHENTICATED=1` deployment with no bind restriction. D13's own text
   *  is explicit that the waiver must be keyed on the BIND (`capabilities.localHandoff`), not on
   *  `CEZ_AUTH`, precisely so a future change to how these routes get mounted
   *  cannot silently waive the deployment-wide code for a hosted, exposed instance. Local
   *  mode's literal is constructed only inside the branch that has already checked
   *  `isLocalOrgModeActive` — see `../local-mode-boot.ts#buildLocalModeRoutes`, the function
   *  `src/index.ts` calls to do this wiring — never derived here from `CEZ_AUTH` again. */
  readonly bootstrapClaim?: BootstrapClaim;
  /**
   * D13's local-mode "signed in" gate (`./local-gates.ts#createRequireSignedInLocal`) —
   * substitutes for the internally-built `createRequireSignedIn(identityStore)` on
   * `POST /auth/onboarding/org` alone. Absent (every session-mode caller, and every pre-D13
   * test) keeps EXACTLY today's construction — this is D13's "one implementation, two injected
   * gates," not a second onboarding surface (see the module doc comment).
   */
  readonly localSignedInGate?: (c: Context, next: Next) => Response | Promise<Response | void>;
  /**
   * D13's local-mode "org admin" gate (`./local-gates.ts#createRequireOrgAdminLocal`) —
   * substitutes for the internally-built `createRequireOrgAdmin(sessionResolver)` on
   * `PATCH /auth/onboarding/team`. Cannot be expressed by swapping `sessionResolver` alone:
   * `createRequireOrgAdmin`'s own `kind !== 'session'` check would 401 every local request (see
   * `./local-gates.ts`'s module doc comment). Absent keeps today's cookie-based construction.
   */
  readonly localOrgAdminGate?: (c: Context, next: Next) => Response | Promise<Response | void>;
  /**
   * D13's project-adoption read (`.ai/specs/2026-08-06-org-team-auth-onboarding.md`: "Existing
   * projects are adopted, not stranded"). Called ONCE, inside `POST /auth/onboarding/org`'s
   * legacy branch, only when the caller is about to create the deployment's first-ever local org
   * — its result is passed straight to `IdentityStore#claimOrg`'s `projectRoots` input, so every
   * already-registered project is filed under the new default team in the SAME guarded write.
   * Absent in session mode: an OIDC/Google deployment's org isn't tied to one on-disk project
   * registry the way a `cezar serve` process is, so there is nothing here to adopt.
   */
  readonly listRegisteredProjectRoots?: () => Promise<string[]>;
}

// ---- wire shaping --------------------------------------------------------------------------------

/** `identity-store.ts`'s `Org`/`Team` are `.passthrough()` (D7: a newer cezar's extra column must
 *  survive an older one's round trip through `identity.json`) — reading one straight off disk can
 *  therefore carry a key this route's wire contract never promised. Picking the known fields by
 *  hand is what keeps `GET /auth/onboarding` from ever leaking whatever a future column adds,
 *  matching AGENTS.md's "the contract must describe EXACTLY what the route sends — no wider, no
 *  narrower." `POST /auth/onboarding/org`'s org/team are freshly `orgSchema.parse`d/`teamSchema.
 *  parse`d by `identity-store.ts#createOrg` and carry nothing extra either way, but shaping every
 *  response through the same two functions means there is exactly one place this could go wrong,
 *  not two. */
function toWireOrg(org: Org): WireOrg {
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    createdAt: org.createdAt,
  };
}

function toWireTeam(team: Team): WireTeam {
  return { id: team.id, orgId: team.orgId, name: team.name, slug: team.slug };
}

// ---- signed-in-but-maybe-orgless user resolution (the gap `SessionResolver` collapses) ----------
//
// **MOVED 2026-08-07 (5b/5c/8 repair stage) to `./require-signed-in.ts`, which now owns both the
// function and its middleware form.** It was module-private here, which is why `invite-routes.ts`
// shipped a byte-for-byte copy of it with a docblock asserting the two could not drift — an
// assertion nothing tested, and one a first-occurrence-cookie mutation left green. That module's
// own doc comment carries the full reasoning (and the second, ordering half: `POST
// /auth/onboarding/org` resolved the caller INSIDE its handler, downstream of `jsonZodValidator`,
// so an unauthenticated caller sending `{"name":123}` got 400 rather than 401).
//
// `GET /auth/onboarding` still calls the FUNCTION directly rather than the middleware: it needs the
// three-way branch (no session / signed in with no org / full principal) and answers 200 for the
// middle case, so a gate that 401s cannot express it.

// ---- D8 step 2: "defaulted from ... the email domain when present" ------------------------------

/** Domains that name a personal mailbox rather than an organization — suggesting "Gmail" as an org
 *  name would be actively wrong, not merely unhelpful, so these fall back to no suggestion at all
 *  (same as having no email on file). Deliberately small and un-configurable: D9 doesn't ask for
 *  this to be a setting, and AGENTS.md's zero-config rule argues against inventing one just to
 *  cover a cosmetic default. */
const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'icloud.com',
  'me.com',
  'proton.me',
  'protonmail.com',
]);

function orgNameFromEmailDomain(email: string): string | undefined {
  const at = email.lastIndexOf('@');
  if (at === -1) return undefined;
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  if (!domain || PERSONAL_EMAIL_DOMAINS.has(domain)) return undefined;
  const label = domain.split('.')[0];
  if (!label) return undefined;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// ---- D8 step 2: slug is server-derived, never a user-input field --------------------------------

/** Lowercase-hyphen, matching `auth/types.ts`'s `slugSchema` shape
 *  (`^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`, 1-63 chars) without importing it — `slugSchema` is
 *  `identity-store.ts`'s internal STORAGE validation, not something this file's wire-facing slug
 *  derivation needs a runtime dependency on; a plain regex here says the same thing and stays
 *  correct even if that internal schema changes shape for reasons unrelated to slug allocation. */
function slugFromName(name: string): string {
  let base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (base.length > 63) base = base.slice(0, 63).replace(/-+$/g, '');
  return base || 'org';
}

/**
 * **There is deliberately no slug-collision retry loop here.** An earlier draft of this route
 * wrapped `createOrg` in a bounded `acme` → `acme-2` → `acme-3` retry, because `createOrg`'s doc
 * comment says "a slug collision is an `IdentityStoreError('org-slug-taken', …)` the route
 * disambiguates (e.g. by suffixing)." That loop only ever had anything to do because the route
 * ALSO let a second user create a second org — the defect fixed below. Now that this route calls
 * `claimOrg`'s legacy branch, whose whole guard is `orgs.length > 0` (checked under the write
 * lease), a slug collision on the org being created is unreachable by construction: no org exists
 * with any slug at the only moment the write is permitted to proceed. Keeping the retry would have
 * been dead code that reads as a live guarantee — see `claimOrg`'s own doc comment, which makes the
 * same argument from the store's side.
 */

// ---- the routes -----------------------------------------------------------------------------------

export function createOnboardingRoutes(deps: OnboardingRouteDeps): Hono {
  const claim = deps.bootstrapClaim ?? bootstrapClaim;
  // Own instance built from THIS factory's injected resolver (not the process-wide
  // `requireOrgAdmin` singleton), so the one admin route below keeps reading the same identity
  // every other route in this file reads — the same shape `invite-routes.ts`/`team-routes.ts` use.
  //
  // D13: `deps.localOrgAdminGate` substitutes the WHOLE gate, not just its resolver — swapping
  // only `deps.sessionResolver` into `createRequireOrgAdmin` would still 401 every local request
  // (that function's own `kind !== 'session'` check), see `./local-gates.ts`'s module doc comment.
  const adminGate = deps.localOrgAdminGate ?? createRequireOrgAdmin(deps.sessionResolver);
  // The LOWER bar (`./require-signed-in.ts`), for `POST /auth/onboarding/org` alone — as middleware
  // so it runs ahead of `jsonZodValidator`, which is what turns an unauthenticated caller's
  // schema-violating body from a 400 (leaking the schema, and parsing a stranger's JSON first) into
  // a 401. `GET /auth/onboarding` deliberately does NOT mount it: see the note above.
  //
  // D13: `deps.localSignedInGate` substitutes the whole gate for local mode (resolves/creates the
  // local user instead of reading a cookie) — same `'signedInUser'` stash, so the handler below
  // needs no branch on which gate ran.
  const signedInGate = deps.localSignedInGate ?? createRequireSignedIn(deps.identityStore);
  // D13 FIX 7: local mode's own signal, read by the `org-already-bootstrapped` catch below to pick
  // an error message that names a route local mode actually mounts — `deps.localSignedInGate` is
  // present ONLY when `src/index.ts`'s local-mode branch built this `Hono` (see that field's own
  // doc comment on `OnboardingRouteDeps`), never in session mode.
  const isLocalMode = deps.localSignedInGate !== undefined;
  return (
    new Hono()
      // ---- GET /auth/onboarding: the resumable state machine (D8, "two states, not four";
      // D13 adds no new state, only a new SOURCE for the existing two — see below) --------------
      .get('/auth/onboarding', (c) => {
        // Try the shared D3 resolver FIRST — reuses org/team/role resolution instead of a second,
        // possibly-drifting read of the same membership. Everything this needs for the 'ready'
        // state is already ON the resolved principal. In local mode `deps.sessionResolver` is
        // `./local-gates.ts#localSessionResolver`, which never returns `null` — D13's point being
        // that a local caller is never "unauthenticated", only "not yet in an org".
        const principal = deps.sessionResolver.resolveFromCookieHeader(
          c.req.header('cookie'),
        );
        if (principal && hasOrgScope(principal)) {
          // Works for BOTH modes unchanged: `hasOrgScope` narrows `orgId`/`teamId` to `string`
          // regardless of whether they came from a resolved session or a resolved local org
          // (D13 — "kind keeps meaning exactly what it always meant... hasOrgScope is the new,
          // separate predicate for 'does this principal have an org'").
          const org = deps.identityStore.getOrgById(principal.orgId);
          const team = deps.identityStore.getTeamById(principal.teamId);
          if (!org || !team) {
            // Unreachable by construction (a resolved principal names a real org/team), same
            // fail-closed stance this file takes elsewhere rather than a response the schema
            // cannot describe.
            return c.json(
              { error: 'onboarding state is inconsistent' },
              500,
            );
          }
          const hasProjects =
            deps.identityStore.listProjectTeams({ orgId: org.id }).length > 0;
          const body: OnboardingStatusResponse = {
            state: 'ready',
            org: toWireOrg(org),
            team: toWireTeam(team),
            role: principal.role,
            hasProjects,
          };
          return c.json(body);
        }

        // D13: a resolved LOCAL principal with no org yet (`kind: 'local'`, `hasOrgScope` false
        // above). Local mode is single-org (`claimOrg`'s legacy-branch `orgs.length > 0` guard) —
        // there is no second local user who could ever need an invite, so `needs-org` is the ONLY
        // other state a local principal can be in. Never 401 here (D13 invariant 1: loopback is
        // already fully trusted, so there is no "who are you" question left to fail) and never
        // `needs-invite` (this deployment can never answer that state truthfully — see item (d) of
        // the phase-9 HTTP-surface task: "the response must not invite a second org it will
        // refuse"). No `suggestedOrgName`: there is no email claim to derive one from locally.
        //
        // **`principal.kind === 'local'`, not a bare `if (principal)` (FIX 8, repair pass).** The
        // first D13 draft read `if (principal)` here — ANY resolved principal without org scope,
        // regardless of `kind` — which silently replaced a deliberate fail-CLOSED 500 with a
        // fail-OPEN `needs-org, bootstrapTokenRequired: false` for a case D13 was never about. A
        // resolved SESSION principal with no org contradicts D3: `session.ts#resolveIdentity`
        // returns `null` for a signed-in user with no membership, never a `Principal` missing org
        // scope — this route's own `resolveSignedInUser` call below exists precisely because the
        // shared resolver collapses that case to `null` rather than handing back a partial
        // principal. So `principal && !hasOrgScope(principal)` can only genuinely happen for
        // `kind: 'local'` today, and this branch says so explicitly instead of trusting `if
        // (principal)` to mean the same thing.
        if (principal && principal.kind === 'local') {
          const body: OnboardingStatusResponse = {
            state: 'needs-org',
            bootstrapTokenRequired: false,
          };
          return c.json(body);
        }

        // Unreachable in practice (see the paragraph above) — but reachable in shape if a future
        // `SessionResolver` implementation ever resolved a non-local principal with no org, and the
        // stakes of getting that wrong are real: falling through to `needs-org,
        // bootstrapTokenRequired: false` would let such a caller create the deployment's first org
        // with NO bootstrap code, defeating D8 amendment 2's whole point. Fail closed, restoring
        // this route's original (pre-D13) stance for the case D13 never actually reaches.
        if (principal) {
          return c.json({ error: 'onboarding state is inconsistent' }, 500);
        }

        // Session mode from here on — `principal` was `null` (no/expired/invalid cookie). That
        // collapses "no session at all" and "signed in, no org yet" into the same `null`
        // (`session.ts`'s own doc comment names this) — the one distinction ONLY this route needs
        // to make, so it reads the cookie one level deeper than the shared resolver.
        const user = resolveSignedInUser(c, deps.identityStore);
        if (!user) return c.json({ error: 'unauthenticated' }, 401);

        // Which of the two membership-less states is this? The distinction is exactly
        // `claimOrg`'s legacy-branch guard (`orgs.length > 0`), read here so the wizard is told the
        // truth BEFORE it asks for an org name it will only be able to refuse — see
        // `onboardingStateSchema`'s 2026-08-07 correction. This is a read of the same fact the
        // store enforces under its write lease, never a second rule: a user who sees `needs-org` and
        // races another to POST still loses at the lease, and gets the 409.
        //
        // **D11 interaction (ADDED 2026-08-07, 5b/5c/8 scaffold pass → Fill unit 7, decided here):
        // this state machine is UNCHANGED by claim mode, deliberately.** Once org one exists, every
        // membership-less signed-in user reads `needs-invite` here — including someone who could, if
        // they typed `orgSlug`+the right per-org code into `POST /auth/onboarding/org` directly, claim
        // a SECOND org that already exists unclaimed. This route does not learn about that org, hint
        // at its slug, or add a fourth state for it: the whole point of a per-org claim code (D11's
        // crux, `./org-claim-token.ts`) is that knowing an org exists and can be claimed is itself
        // privileged information the operator hands out of band, the same channel that already carries
        // the code — exactly the "the one fact the network cannot read" property `bootstrapTokenRequired`
        // below already relies on for the deployment-wide code. A user who has that out-of-band
        // knowledge does not need this route to tell them anything; a user who doesn't must not be able
        // to learn it by polling this endpoint. The routing gap this leaves — there is no wizard screen
        // that invites a claim-mode caller to type `orgSlug` at all — is real and is the "claim-mode UX
        // is undesigned" gap the spec names; closing it is a UI decision for whichever unit builds that
        // screen, not a wire-contract change, since `packages/contract/src/orgs.ts`'s
        // `OnboardingStatusResponse` is this unit's `Reads`, not `Owns` (5b/5c/8 scaffold pass'
        // ownership map).
        if (deps.identityStore.listOrgs().length > 0) {
          const body: OnboardingStatusResponse = { state: 'needs-invite' };
          return c.json(body);
        }

        const body: OnboardingStatusResponse = {
          state: 'needs-org',
          suggestedOrgName: user.email
            ? orgNameFromEmailDomain(user.email)
            : undefined,
          bootstrapTokenRequired: claim.required,
        };
        return c.json(body);
      })

      // ---- POST /auth/onboarding/org: D8 steps 1 (bootstrap) + 2 (name it), plus D11's claim path --
      //
      // **CORRECTED 2026-08-07 (integration).** The first draft of this handler read
      // `listMemberships(user.userId).length > 0` and, if empty, did `createOrg` then a separate
      // `createMembership`. That is a PER-USER gate, and D8 step 1 is not a per-user rule: "the
      // first user to sign in becomes owner of a new org; **subsequent users need an invite**" —
      // deployment-wide, which phase 4's own verification row states as "invite required for the
      // second user", and which D4 requires anyway ("until the per-org split ships, hosted means
      // single-org": two orgs inside ONE process is a shared shell with two logins, the exact thing
      // the spec's Risks section names as the largest risk here). The per-user version let every
      // authenticated identity walk away owning its own org in the same process, and two *different*
      // users racing — each with zero memberships, so each passing its own check — was not closed by
      // `createMembership`'s recheck either, because they were writing two different membership rows.
      //
      // `IdentityStore#claimOrg`'s legacy branch replaces all three calls with one guarded write: it
      // checks `orgs.length > 0` on the snapshot re-read fresh UNDER the lease, and creates org +
      // default team + the `owner` membership in that same write. So the race is closed where D7 says
      // every uniqueness check belongs, and there is no longer a window in which an org exists with
      // no owner (the old two-call shape could die between `createOrg` and `createMembership` and
      // strand exactly that).
      //
      // **D11 claim mode (ADDED 2026-08-07, 5b/5c/8 scaffold pass → Fill unit 7, landed).** When the
      // body carries `orgSlug`, this is a claim on an org the admin-only `POST /internal/orgs`
      // already created (Fill unit 6) — a completely separate branch from the legacy bootstrap below,
      // gated by THAT org's own `Org.claimTokenHash` (`./org-claim-token.ts#matchesOrgClaimToken`),
      // never the deployment-wide `./bootstrap-claim.ts` code. `name`/the deployment-wide
      // `bootstrapToken` are meaningless here and ignored — `orgSlug` present means this branch
      // returns unconditionally, before either is read.
      //
      // **Why "no such org" and "wrong code" answer the identical 403.** Distinguishing them would
      // let an unauthenticated caller enumerate which org slugs exist on this deployment by binary-
      // searching which ones ever return anything other than "no organization matches" — exactly the
      // kind of oracle D9's bounded-audience reasoning (no fact the network can read that the operator
      // did not choose to hand out) argues against. A wrong code for a REAL org and a slug that names
      // no org at all are therefore, deliberately, the same response.
      .post(
        '/auth/onboarding/org',
        signedInGate,
        jsonZodValidator(createOnboardingOrgInputSchema),
        async (c) => {
          const user = getSignedInUser(c);

          const { name, orgSlug, bootstrapToken } = c.req.valid('json');

          if (orgSlug !== undefined) {
            // ---- D11 claim path: this org already exists, only the `owner` membership is new -------
            const org = deps.identityStore.getOrgBySlug(orgSlug);
            // `org.claimTokenHash` is absent for the deployment's first-ever org (created through the
            // legacy branch below, gated by the deployment-wide code instead) — treating that the same
            // as "wrong code" means this path can never be used to claim org one a second time, on top
            // of `claimOrg`'s own `org-already-claimed` guard.
            if (
              !org ||
              org.claimTokenHash === undefined ||
              !matchesOrgClaimToken(org.claimTokenHash, bootstrapToken)
            ) {
              return c.json(
                { error: 'no organization matches that slug and code' },
                403,
              );
            }
            try {
              const {
                org: claimedOrg,
                defaultTeam,
                membership,
              } = await deps.identityStore.claimOrg({
                userId: user.userId,
                orgId: org.id,
              });
              // FIX 4 (D13 repair pass): this branch used to return 201 WITHOUT invalidating
              // `./local-identity.ts`'s cache — only the legacy branch below did. Local mode never
              // legitimately reaches this branch today (a local org's `Org` row never gets a
              // `claimTokenHash`, so the guard above always 403s it first — see that guard's own
              // comment), but the cache is a general-purpose "does the local org's identity look
              // like THIS" slot, not a legacy-branch-only one, and `claimOrg` is `claimOrg`
              // regardless of which branch ran: any write that can change what
              // `resolveLocalOrgIdentity` returns must invalidate it, or the very next call sees a
              // process-lifetime-stale answer. A no-op in session mode and in every path that
              // reaches this branch today, exactly like the legacy branch's own call below.
              invalidateLocalOrgIdentityCache();
              const body: CreateOnboardingOrgResponse = {
                org: toWireOrg(claimedOrg),
                team: toWireTeam(defaultTeam),
                role: membership.role,
              };
              return c.json(body, 201);
            } catch (error) {
              if (error instanceof IdentityStoreError) {
                if (error.code === 'org-already-claimed') {
                  // The token was right, but someone else claimed this org first — a real race, not the
                  // "no such org" ambiguity above (the caller already proved they know a valid code).
                  return c.json(
                    { error: 'this organization already has an owner' },
                    409,
                  );
                }
                // ADDED 2026-08-07 (5b/5c/8 repair stage). The caller already belongs to an org, so
                // a second membership would be inert (F4 — `session.ts#resolveIdentity` pins to
                // `listMemberships(userId)[0]`) while permanently consuming this org's one-shot
                // claim code. `claimOrg` refuses BEFORE writing, so the code is still good; the
                // message has to say so, because the operator who hits this is typically the one
                // holding the code and their instinct on a bare 409 would be that they burnt it.
                if (error.code === 'user-already-member') {
                  return c.json(
                    {
                      error:
                        'you already belong to an organization on this deployment, and cezar cannot switch between them yet — this claim code has NOT been used up. Sign in as the account that should own this organization (a separate browser profile works) and claim it there.',
                    },
                    409,
                  );
                }
              }
              throw error;
            }
          }

          // ---- legacy path: the deployment's first-ever org, gated by the deployment-wide code ------
          // ADDED 2026-08-07 (repair stage). Being first is not, on its own, permission to own a
          // shell — see `./bootstrap-claim.ts`'s module doc comment for the reproduced 401→owner→
          // `spawn('bash')` chain this closes. Checked BEFORE the store write, so a wrong code leaves
          // nothing behind, and checked on EVERY request rather than once at boot, because the claim
          // is process state the route reads, not a fact about the caller.
          if (!matchesBootstrapClaim(claim, bootstrapToken)) {
            return c.json(
              {
                error:
                  'this deployment needs its bootstrap code to create the first organization — it is printed in the server log at startup',
              },
              403,
            );
          }
          // `name` is required in the only mode this branch implements — defensive only:
          // `createOnboardingOrgInputSchema` relaxed `name` to optional this pass to make room for the
          // `orgSlug` branch above, so a body with neither field reaches here rather than crashing on a
          // `string | undefined` where `claimOrg`'s legacy branch requires a `string`. Unreachable for
          // every caller this route has ever had.
          if (!name) {
            return c.json({ error: 'name is required' }, 400);
          }
          try {
            // D13 project adoption: `deps.listRegisteredProjectRoots` is only ever supplied in
            // local mode (see its own doc comment on `OnboardingRouteDeps`) — `undefined` in
            // session mode reads as "nothing to adopt", exactly like passing an empty list, so
            // `claimOrg`'s `projectRoots` input stays optional rather than every session-mode
            // caller having to pass `[]`. Read INSIDE the same `try`, right before the write it
            // feeds, so a failure to list projects surfaces as this route's own error handling
            // rather than a separate unhandled rejection.
            const projectRoots = await deps.listRegisteredProjectRoots?.();
            const { org, defaultTeam, membership } =
              await deps.identityStore.claimOrg({
                userId: user.userId,
                name,
                slug: slugFromName(name),
                projectRoots,
              });
            // D13: the local-org resolver's cache (`./local-identity.ts`) must not go on answering
            // "no local org" after this write creates one — invalidated here, in-process, the
            // instant the write that could change the answer succeeds. A no-op in session mode:
            // nothing populates that cache outside local mode (see its own module doc), so this
            // just resets an already-`'unknown'`/`'none'` slot back to `'unknown'`.
            invalidateLocalOrgIdentityCache();
            const body: CreateOnboardingOrgResponse = {
              org: toWireOrg(org),
              team: toWireTeam(defaultTeam),
              // Read off the row the store actually wrote, not the `'owner'` literal this route would
              // otherwise repeat — `claimOrg` hardcodes the role precisely so it is decided in one
              // place (its own doc comment), and re-stating it here would be a second copy to drift.
              role: membership.role,
            };
            return c.json(body, 201);
          } catch (error) {
            // **CORRECTED 2026-08-07 (repair stage): `membership-exists` was also caught here, and
            // could never arrive.** The legacy branch throws exactly two codes —
            // `org-already-bootstrapped` and `user-not-found` — and never calls `createMembership`, so
            // that arm was dead code reading as a live guarantee. That is the same defect this file's
            // own slug-retry comment (above) argues against, decided the opposite way 100 lines apart;
            // removing it is the consistent answer. A mutation deleting the surviving arm is killed by
            // `onboarding-routes.test.ts`'s "second user" case.
            if (
              error instanceof IdentityStoreError &&
              error.code === 'org-already-bootstrapped'
            ) {
              // The bootstrap window is closed. Nothing was written on this path, so there is no
              // orphaned org/team to clean up the way the old two-call shape could leave behind.
              //
              // **FIX 7 (D13 repair pass): local mode gets its own message.** The session-mode
              // wording below ("you need an invite") pointed a local caller at a route that does
              // not exist — `inviteRoutes` is deliberately never mounted locally (this file's own
              // module doc comment: "there is nothing to log into and no second user to invite").
              // Reachable in local mode too, not merely hypothetically: local mode is single-org
              // and single-owner by construction (D13's own "Out of scope" list — `claimOrg`'s
              // `orgs.length > 0` guard is exactly what refuses a second local org), so hitting this
              // branch locally means the caller ALREADY owns the org they just tried to create
              // again — a double-submitted wizard step, or a second tab racing the first — not that
              // a stranger got there first. The fix names the action that actually exists: nothing,
              // the caller already has what they were asking for.
              return c.json(
                {
                  error: isLocalMode
                    ? 'this workspace already has an organization — reload the page to continue'
                    : 'an organization already exists on this deployment — you need an invite to join it',
                },
                409,
              );
            }
            throw error;
          }
        },
      )

      // ---- PATCH /auth/onboarding/team: D8 step 3, "the step only renames it" ----------------------
      .patch(
        '/auth/onboarding/team',
        // ADDED 2026-08-07 (repair stage): the FIRST authorization decision in the codebase that
        // actually reads `principal.role`. Before this, `role` was carried on every principal,
        // constrained by a `CHECK (role IN (...))` in the store, mapped from IdP groups by
        // `oidc.ts` — and read by nothing but a response body, so `member` and `owner` were the same
        // thing. This route is not "onboarding-only" either: nothing scopes it to the `needs-org`
        // moment, so it is a permanent rename of the org's team. Renaming what the whole org sees is
        // an owner/admin act; `CEZ_OIDC_GROUP_ROLE_MAP` exists precisely so an operator can say who
        // is which, and until something consumes that distinction the map grants nothing real.
        //
        // **CORRECTED 2026-08-07 (5b/5c/8 integration pass): the check used to be the first two
        // statements INSIDE the handler, i.e. downstream of `jsonZodValidator`, and that ordering
        // was wrong in exactly the way `supervisor/server.ts`'s `requireAdmin` was already
        // corrected for once.** A `member` sending a malformed body got 400 — learning the request
        // schema parsed before learning they were never allowed to call the route at all — and an
        // unauthenticated caller with a malformed body got 400 rather than 401. Neither was a
        // bypass (a well-formed body was still refused), but authorization that runs after parsing
        // is one `.optional()` away from running after a side effect, which is why D12's own unit
        // generalized this check into `./require-org-admin.ts` in the first place. This route was
        // that module's stated precedent and was deliberately left on the inline form by the unit
        // that wrote it (a different file's ownership); it now uses the middleware it inspired, so
        // there is ONE construction of the D12 gate rather than a shared one plus the original.
        // `auth-admin-routes.test.ts` drives every `ADMIN_ONLY` route with a body that satisfies no
        // schema, which is what made the ordering observable — with a VALID body both orderings
        // answer 403 identically, and that is why the first version of that gate did not catch it.
        adminGate,
        jsonZodValidator(renameOnboardingTeamInputSchema),
        async (c) => {
          // The FULL D3 principal, not the lower `resolveSignedInUser` bar above — see the module doc
          // comment's "Authorization is two different bars" section. Resolved by `adminGate` and read
          // back here rather than resolving the same cookie twice. `principal.teamId` is the ONLY
          // team this handler can ever touch; the request body carries no id at all (`orgs.ts`'s own
          // doc comment on `renameOnboardingTeamInputSchema`), so a client cannot smuggle a different
          // org's team in even by trying.
          const principal = getOrgAdminPrincipal(c);
          if (!hasOrgScope(principal)) {
            // Defensive narrowing only (also what makes `principal.teamId` a `string` below,
            // rather than `string | null`, to the type checker) — `adminGate` (cookie-based OR
            // D13's local one) never stashes a principal without an org: `require-org-admin.ts`'s
            // own `kind !== 'session'` refusal for the cookie gate, `./local-gates.ts`'s own
            // `hasOrgScope` refusal for the local one. Unreachable in practice.
            return c.json({ error: 'no organization exists yet' }, 400);
          }

          const { name } = c.req.valid('json');
          try {
            const team = await deps.identityStore.renameTeam(
              principal.teamId,
              name,
            );
            const body: RenameOnboardingTeamResponse = {
              team: toWireTeam(team),
            };
            return c.json(body);
          } catch (error) {
            if (
              error instanceof IdentityStoreError &&
              error.code === 'team-not-found'
            ) {
              // CORRECTED 2026-08-07 (phase 5c landed): this used to say "unreachable today
              // (nothing deletes a team)". Something does now — `DELETE /auth/teams/:teamId`
              // (`./team-routes.ts`) — so a caller whose session was resolved against a team an
              // admin deleted a moment later reaches this branch for real. `deleteTeam` refuses
              // while the team still holds a project, which makes the window narrow, not closed.
              // Kept for the same reason every other "should never happen" branch in this file is:
              // a resolved principal that no longer resolves to a real row must fail closed, not
              // 500 with a stack trace.
              return c.json({ error: 'your team no longer exists' }, 404);
            }
            throw error;
          }
        },
      )
  );
}

// ---- the real, process-lifetime wiring ------------------------------------------------------------

/**
 * Opens its OWN `IdentityStore` at the same directory `./session.ts`/`./routes.ts` each open
 * theirs — exactly as consistent as sharing one, since none of the three keeps an in-memory cache
 * (see `identity-store.ts`'s own module doc on why: every read re-parses `identity.json`). Reuses
 * the module-scope `sessionResolver` singleton from `./session.ts` rather than requiring
 * `src/index.ts` to thread it through a second time — this module needs nothing `./session.ts`
 * doesn't already export, so, like `./routes.ts`'s `authRoutes`, it can build itself with a bare
 * `import('./auth/onboarding-routes.ts')` at the call site.
 */
function buildOnboardingRoutes(): Hono {
  const identityStore = IdentityStore.open(identityDir());
  return createOnboardingRoutes({ sessionResolver, identityStore });
}

/** What `src/index.ts`'s `serveCommand` dynamically imports and threads into `server.ts`'s
 *  `ServerDeps.onboardingRoutes`, mounted at the app root beside `deps.authRoutes`. Synchronous
 *  (unlike `authRoutes`, which awaits OIDC discovery) — this module has no external config to
 *  resolve or discovery call to make, so there is nothing to fail closed on at import time. */
export const onboardingRoutes: Hono = buildOnboardingRoutes();
