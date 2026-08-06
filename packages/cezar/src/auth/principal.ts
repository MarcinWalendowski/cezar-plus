import type { Principal } from '../server/server.ts';

/**
 * Principal resolution (D3, `.ai/specs/2026-08-06-org-team-auth-onboarding.md`).
 *
 * D3 exists because of a same-day incident: `ProjectContexts.build()` activated the knowledge
 * and source stores, `createApp`'s hand-built `bootContext` did not, and the two paths silently
 * disagreed about which stores were live until the knowledge base was dead on the only project
 * the cockpit opens by default. Two ways to construct "what a request is allowed to do" would
 * drift the same way, so `CEZ_AUTH=none` and `CEZ_AUTH={oidc,google}` do not get two functions,
 * or a caller that special-cases "off" before ever reaching this module. Both modes call
 * `resolvePrincipal` and the function has exactly one `return`, building the same four fields
 * from whichever `identity` it was handed. The distinction between the modes lives entirely in
 * *what* they hand it: the implicit local identity below (auth off, no I/O — D1's "unset means
 * zero I/O" holds because this module reads no file to produce it), or an already-resolved
 * session (auth on).
 *
 * What "resolved" means for the session case is deliberately out of scope here: picking a user's
 * current org/team out of a possibly-multi-membership signed-in user, and turning a session
 * cookie into that in the first place, is Phase 3's `auth/session.ts` (D7's identity store, D9's
 * OIDC/Google flow) — a module that does not exist yet. This function's contract starts after
 * that decision has already been made; it only owns turning a decided identity into the
 * `Principal` shape every route and the WebSocket upgrade check (D6) both read.
 */

/** The `(org, team, role)` a signed-in user is acting as, once a session has already been
 *  resolved to a user and that user's active membership picked. Supplied by the caller — this
 *  module never looks it up. */
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
 */
export type ResolvePrincipalInput =
  | { readonly authProvider: 'none' }
  | { readonly authProvider: 'oidc' | 'google'; readonly identity: SessionIdentity };

/**
 * The implicit identity every request resolves to while `CEZ_AUTH` is unset (D1/D3) — a
 * synthetic local user in a default org/team, so the zero-config single-user product never has
 * to reason about "no principal". Fixed ids, never persisted: nothing under `CEZ_AUTH=none`
 * touches `<CEZ_HOME>/identity/*.json` (D7) to produce this value.
 *
 * `server.ts`'s `LOCAL_PRINCIPAL` is now the RESULT of calling `resolvePrincipal` below rather
 * than a second literal hand-kept in sync with this one — the earlier arrangement (two
 * byte-identical objects in two files, with nothing asserting they matched) was itself the
 * drift shape D3 exists to forbid, so it was closed rather than documented. `server.ts` imports
 * this module statically and that is safe both ways: this file's only import is
 * `import type { Principal }` back at `server.ts`, which TypeScript erases, so there is no
 * runtime cycle, and nothing here reads a file, so D1's "unset means zero I/O" still holds.
 */
const LOCAL_IDENTITY: SessionIdentity = {
  userId: 'local',
  orgId: 'local',
  teamId: 'local',
  role: 'owner',
};

/**
 * D3's one construction path. `authProvider === 'none'` always yields the implicit local
 * identity; `'oidc'`/`'google'` yields whatever `identity` the caller already resolved. Either
 * way the return is the same four-field object, so "off" and "on" cannot describe a `Principal`
 * as two different shapes: there is only one shape, and one place that builds it.
 */
export function resolvePrincipal(input: ResolvePrincipalInput): Principal {
  const identity = input.authProvider === 'none' ? LOCAL_IDENTITY : input.identity;
  return {
    kind: input.authProvider === 'none' ? 'local' : 'session',
    userId: identity.userId,
    orgId: identity.orgId,
    teamId: identity.teamId,
    role: identity.role,
  };
}
