import type { Principal } from '../server/server.ts';

/**
 * Principal resolution (D3, `.ai/specs/2026-08-06-org-team-auth-onboarding.md`).
 *
 * D3 exists because of a same-day incident: `ProjectContexts.build()` activated the knowledge
 * and source stores, `createApp`'s hand-built `bootContext` did not, and the two paths silently
 * disagreed about which stores were live until the knowledge base was dead on the only project
 * the cockpit opens by default. Two ways to construct "what a request is allowed to do" would
 * drift the same way, so `CEZ_AUTH=none` and `CEZ_AUTH={oidc,google,supervisor}` do not get two
 * functions, or a caller that special-cases "off" before ever reaching this module. Every mode
 * calls `resolvePrincipal` and the function has exactly one `return`, building the same four
 * fields from whichever `identity` it was handed. The distinction between the modes lives
 * entirely in *what* they hand it: the implicit local identity below (auth off, no I/O — D1's
 * "unset means zero I/O" holds because this module reads no file to produce it), or an
 * already-resolved session (auth on).
 *
 * What "resolved" means for the session case is deliberately out of scope here: picking a user's
 * current org/team out of a possibly-multi-membership signed-in user, and turning a session
 * cookie into that in the first place, is Phase 3's `auth/session.ts` (D7's identity store, D9's
 * OIDC/Google flow) for `oidc`/`google`, and — added phase 6/7 (D10) — verifying the supervisor's
 * signed, forwarded principal (`supervisor/forwarded-principal.ts#verifyForwardedPrincipal`) for
 * `supervisor`. This function's contract starts after that decision has already been made; it
 * only owns turning a decided identity into the `Principal` shape every route and the WebSocket
 * upgrade check (D6) both read.
 *
 * **D13 (phase 9): `kind` stops standing in for "has an org".** Before D13, `authProvider ===
 * 'none'` always meant "no real org" and `'oidc'/'google'/'supervisor'` always meant "a real
 * org" — so every call site that wanted to know "does this principal have an org" could get away
 * with asking `kind === 'session'` instead, and the two questions silently coincided. D13 breaks
 * the coincidence: a local user (auth still fully off) may now create a real org through the
 * onboarding wizard, so `resolvePrincipal` gains a third case — "auth off, WITH a resolved local
 * org identity" — that returns `kind: 'local'` (still, correctly: this request was never
 * authenticated) alongside REAL `orgId`/`teamId`. `kind` keeps meaning exactly what it always
 * meant, "was this request authenticated"; `hasOrgScope` below is the new, separate predicate for
 * "does this principal have an org", and is what every call site that used to read `kind` for
 * that second question must move to instead.
 */

/** The `(org, team, role)` a signed-in user is acting as, once a session has already been
 *  resolved to a user and that user's active membership picked. Supplied by the caller — this
 *  module never looks it up. Also reused, unchanged, for D13's local-org case (`auth/local-
 *  identity.ts#resolveLocalOrgIdentity`'s return shape): a resolved local org identity has the
 *  exact same four real, non-null fields a resolved session does — only `ResolvePrincipalInput`'s
 *  `authProvider` distinguishes which one produced it, never a second shape. */
export interface SessionIdentity {
  readonly userId: string;
  readonly orgId: string;
  readonly teamId: string;
  readonly role: 'owner' | 'admin' | 'member';
}

/**
 * `resolvePrincipal`'s only input. A discriminated union rather than `SessionIdentity | null`
 * on purpose: a bare `null` is ambiguous between "auth is off" (always resolves to the implicit
 * local identity) and "auth is on but this session did not resolve" (must never fall back to the
 * local identity — that fallback is exactly the "forgot to check something, granted owner
 * access" shape D1's boot refusal exists to rule out elsewhere). Requiring the literal
 * `authProvider: 'none'` to reach the local branch means a caller can never reach it by accident
 * while authenticating; the "session lookup failed" case is a caller-side 401 that never calls
 * this function at all, not a `null` passed in here.
 *
 * **`identity` on the `'none'` arm is D13's addition.** Optional, not a second arm keyed on a
 * different `authProvider` literal — a local deployment either has no resolved org yet (omit it,
 * the implicit `orgId: null, teamId: null` identity below) or has one (`auth/local-
 * identity.ts#resolveLocalOrgIdentity` found it, pass it) — but `authProvider` itself is still
 * `'none'` either way, because auth truly is off in both cases; only "does a local org exist"
 * differs, which is exactly the question `identity`'s presence answers.
 */
export type ResolvePrincipalInput =
  | { readonly authProvider: 'none'; readonly identity?: SessionIdentity }
  | { readonly authProvider: 'oidc' | 'google' | 'supervisor'; readonly identity: SessionIdentity };

/**
 * The implicit identity every request resolves to while `CEZ_AUTH` is unset and no local org has
 * been created yet (D1/D3, amended by D13) — a synthetic local user with NO org, so the
 * zero-config single-user product never has to reason about "no principal" at all (it always gets
 * one; `hasOrgScope` is what tells a caller whether that principal may act on an org). Fixed
 * `userId`, never persisted: nothing under `CEZ_AUTH=none` touches `<CEZ_HOME>/identity/*.json`
 * (D7) to produce THIS value — only the D13 local-org path below does, and only once the user
 * asks for it.
 *
 * **`orgId`/`teamId` are `null`, never the string `'local'` (D13 invariant 3).** Before D13 this
 * literal read `orgId: 'local', teamId: 'local'` — two strings that named no row in any store, and
 * every org-scoped call site's `kind === 'session'` guard meant that value was never actually read
 * as an id. D13 makes `orgId`/`teamId` real, so a phantom non-null placeholder would now be
 * indistinguishable from a real org's id to any caller that stopped checking `kind` and started
 * checking the value directly — exactly the failure `hasOrgScope` and this `null` together rule
 * out: `null` cannot collide with a real id, `'local'` could have.
 *
 * `server.ts`'s `LOCAL_PRINCIPAL` is now the RESULT of calling `resolvePrincipal` below rather
 * than a second literal hand-kept in sync with this one — the earlier arrangement (two
 * byte-identical objects in two files, with nothing asserting they matched) was itself the
 * drift shape D3 exists to forbid, so it was closed rather than documented. `server.ts` imports
 * this module statically and that is safe both ways: this file's only import is
 * `import type { Principal }` back at `server.ts`, which TypeScript erases, so there is no
 * runtime cycle, and nothing here reads a file, so D1's "unset means zero I/O" still holds.
 */
const LOCAL_IDENTITY: { readonly userId: string; readonly orgId: null; readonly teamId: null; readonly role: 'owner' } = {
  userId: 'local',
  orgId: null,
  teamId: null,
  role: 'owner',
};

/**
 * D3's one construction path — still exactly one `return`, still exactly one place that builds
 * the four-field `Principal` shape, D13's new case included. `authProvider === 'none'` yields
 * either the implicit no-org local identity (no `identity` supplied) or D13's resolved local-org
 * identity (`identity` supplied, real ids); `'oidc'`/`'google'`/`'supervisor'` all yield whatever
 * `identity` the caller already resolved. Either way the return is the same four-field object —
 * "off, no org", "off, with an org" and "on" cannot describe a `Principal` as three different
 * shapes, only as three different sources for the same one.
 */
export function resolvePrincipal(input: ResolvePrincipalInput): Principal {
  const identity: { userId: string; orgId: string | null; teamId: string | null; role: Principal['role'] } =
    input.authProvider === 'none' ? (input.identity ?? LOCAL_IDENTITY) : input.identity;
  return {
    kind: input.authProvider === 'none' ? 'local' : 'session',
    userId: identity.userId,
    orgId: identity.orgId,
    teamId: identity.teamId,
    role: identity.role,
  };
}

/**
 * D13's replacement for "`kind === 'session'` means has an org". A TYPE GUARD, not a bare
 * boolean-returning function: narrowing `principal.orgId`/`principal.teamId` from `string | null`
 * to `string` inside the `if (hasOrgScope(principal))` branch is the whole reason this exists as a
 * predicate rather than each of the five call sites re-deriving `principal.orgId !== null` (and
 * risking one of them checking only `orgId`, leaving `teamId` unnarrowed — the schema's own
 * `project_teams` PK needs both to be real together, never one without the other).
 *
 * **CORRECTED 2026-08-07 (adversarial review): the paragraph below is FALSE — the body checks
 * BOTH fields, not `orgId` alone.** `return principal.orgId !== null && principal.teamId !== null`
 * reads both, and that comparison is the actual guard. A reader who trusted the paragraph below
 * and wrote a caller (or a future edit to this function) against `orgId !== null` alone, on the
 * strength of "sufficient because `resolvePrincipal` only ever produces them as a matched pair",
 * would drop exactly the `teamId` half the FIRST paragraph above warns a caller not to drop — a
 * principal with a real `orgId` but a `null` `teamId` (unreachable through `resolvePrincipal`
 * today, but nothing in this function's own contract depends on that staying true forever) would
 * then satisfy the narrowed type while `teamId` went unchecked. The claim that checking `orgId`
 * alone is sufficient describes today's only caller of `resolvePrincipal`, not this function's own
 * implementation, and must not be read as documentation of the code below.
 *
 * The original text follows unchanged, and must not be read as describing the code below:
 *
 * `orgId !== null` is checked, not `teamId !== null` — sufficient because `resolvePrincipal`'s one
 * construction path (above) only ever produces `orgId`/`teamId` as a matched pair, both null or
 * both real; there is no `ResolvePrincipalInput` shape that hands one without the other. Narrowing
 * on the single field is what makes the return type usable as a type predicate at all (TypeScript
 * cannot express "these two independently-typed fields are both non-null" as one narrowed type
 * without restating the whole interface, which this signature does instead, explicitly).
 */
export function hasOrgScope(
  principal: Principal,
): principal is Principal & { readonly orgId: string; readonly teamId: string } {
  return principal.orgId !== null && principal.teamId !== null;
}
