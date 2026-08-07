import { randomBytes } from 'node:crypto';
import type { AuthProvider } from '@open-mercato/cezar-contract';
import { identityDir } from '../paths.ts';
import { resolveAuthProvider } from '../server/capabilities.ts';
import type { Principal, SessionResolver } from '../server/server.ts';
import { IdentityStore, IdentityStoreError } from './identity-store.ts';
import { resolvePrincipal, type SessionIdentity } from './principal.ts';

/**
 * Cookie sessions (D6, spec `.ai/specs/2026-08-06-org-team-auth-onboarding.md`) — mints, cookie-
 * encodes and resolves the session state `server.ts`'s `requirePrincipal` middleware and
 * `verifyWsUpgrade` both read through `sessionResolver` below, per D3's single-resolver rule.
 *
 * **Storage is `identity-store.ts`'s `sessions` table, not a file of our own.** `types.ts`'s
 * `sessionSchema` doc comment and `identity-store.ts`'s `createSession` doc comment both say
 * explicitly that THIS module mints the id and `identity-store.ts` "only persists what it is
 * given" — a second, parallel session store here would leave two disagreeing places answering
 * "does this session exist", which is exactly the two-paths-drift shape D3 exists to rule out.
 * `../auth/routes.ts` (a sibling unit, also landed) is built against exactly this shape: it calls
 * `identityStore.findOrCreateUser(...)` then `createSession(user.id)` — a bare user id, not a
 * pre-resolved principal — which is only possible because org/team/role are resolved HERE, fresh,
 * not supplied by the caller.
 *
 * **Org/team/role are resolved fresh on every read, never cached in the session row.** D7's
 * `sessions` table is deliberately thin (`id`, `userId`, `expiresAt`, `createdAt` — no org, team or
 * role), so a membership or role change takes effect on the user's very next request, not on their
 * next login. `resolveIdentity` below is what does that resolution, and `principal.ts`'s own doc
 * comment is explicit that this — "picking a user's current org/team out of a possibly-multi-
 * membership signed-in user" — is this file's job, not `identity-store.ts`'s or `principal.ts`'s.
 *
 * **Team selection policy (undocumented by the spec, decided here).** D5 is explicit that team is
 * "metadata on a project used for grouping and filtering, not a scope", and D7's data model has no
 * user-to-team relation at all (`memberships` carries `orgId`+`role` only). There is therefore no
 * stored "current team" for a signed-in user to read. Until Phase 4/5 (orgs/teams UI, project-team
 * mapping) exists, this file resolves a session's `teamId` as the resolved org's FIRST team —
 * always exactly the default team D8/`identity-store.ts#createOrg` creates atomically with the org,
 * since nothing before Phase 4 can add a second one. An org resolved with zero teams (should be
 * unreachable given that atomicity) fails the session closed rather than fabricating an id.
 *
 * **Membership selection policy (same status).** A user with more than one org membership (an
 * invite to a second org — D8's onboarding flow, not this file, is what grants those) has no
 * "active org" switcher yet either. This file picks the OLDEST membership deterministically
 * (`listMemberships` returns insertion order) rather than guessing from request context that
 * doesn't exist yet. Both of these are Phase 3 scope boundaries, not spec violations — Phase 4/5
 * owns replacing them with a real selection.
 *
 * **D8 onboarding gap.** A user who signs in with no existing org membership gets a real, valid
 * session for a real user row, but `resolveIdentity` returns `null` for them (no membership to
 * resolve), so every principal-gated read 401s until an org exists and grants them one.
 * `routes.ts`'s own doc comment names this explicitly and defers it to Phase 4 rather than papering
 * over it here.
 */

// ---- cookie shape -------------------------------------------------------------------------------

/** The cookie name the session lives under — read by `resolveFromCookieHeader` and written by
 *  `createSession`; `logoutCookie()` must clear the SAME name or a browser would keep both. */
export const SESSION_COOKIE_NAME = 'cez_session';

/** 256 bits of `randomBytes` entropy, hex-encoded — infeasible to guess, and fixed-length, which
 *  is what lets `SESSION_ID_RE` reject a malformed/tampered candidate before it ever reaches
 *  `identity-store.ts`. */
const SESSION_ID_BYTES = 32;
const SESSION_ID_RE = /^[0-9a-f]{64}$/;

/** No lifetime is specified by the spec's data model (D7 gives `sessions.expires_at` a column,
 *  not a duration). 30 days matches the "stay signed in" expectation of a locally-run dev tool a
 *  person opens most days. Callers may override per session. */
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** `identity-store.ts#createSession` throws this if a minted id happens to already exist. At 256
 *  bits of entropy that is not a realistic event — this cap exists only so a genuine bug (e.g. a
 *  broken RNG) fails loudly with a clear error instead of spinning forever. */
const MAX_ID_MINT_ATTEMPTS = 5;

export interface CreatedSession {
  readonly id: string;
  /** The full `Set-Cookie` header value (D6: `HttpOnly; Secure; SameSite=Lax`). */
  readonly cookie: string;
}

/** A minimal `Cookie:` header parser. Exists because D6's whole reason for the WS upgrade check
 *  to duplicate the HTTP one is that the raw upgrade request never passes through Hono
 *  (`server.ts:5304`), so there is no `c.req.header`/cookie helper available to reuse — this
 *  function is what makes `resolveFromCookieHeader` usable from both call sites off the same
 *  `string | undefined` the raw `IncomingMessage.headers.cookie` and Hono's
 *  `c.req.header('cookie')` both hand back. */
function parseCookieHeader(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    if (!name) continue;
    const rawValue = part.slice(separator + 1).trim();
    try {
      cookies.set(name, decodeURIComponent(rawValue));
    } catch {
      cookies.set(name, rawValue); // malformed percent-encoding: keep it raw rather than drop the whole header
    }
  }
  return cookies;
}

/**
 * The ONE reading of "which session id, if any, does this `Cookie:` header name" — D3's
 * single-construction rule applied to the input side of the resolver.
 *
 * **ADDED 2026-08-07 (repair stage), because there were two and they disagreed.** Phase 4's
 * `auth/onboarding-routes.ts#resolveSignedInUser` read the same cookie with `getCookie` from
 * `hono/cookie`, and its docblock claimed that was "the SAME way" this module reads it. On a
 * header carrying two `cez_session` values it is not: measured on this repo's hono, `getCookie`
 * returns the FIRST occurrence and `parseCookieHeader` below returns the LAST (`Map.set`
 * overwrites). Cookies are not origin-scoped — anything on a sibling subdomain can set
 * `cez_session` for the parent domain, and RFC 6265 §5.4 orders longer-`Path` cookies first — so
 * an attacker could deterministically make `POST /auth/onboarding/org` act as THEM (writing the
 * owner membership to their own user id) while `requirePrincipal`, `verifyWsUpgrade`, `/auth/me`
 * and `PATCH /auth/onboarding/team` all acted as the victim. `SESSION_ID_RE` is applied here too,
 * so a malformed candidate never reaches `identity-store.ts` from either caller.
 *
 * Returns `undefined` for "no usable session id in this header" — never a partially-validated
 * string a caller might still look up.
 */
export function readSessionIdFromCookieHeader(header: string | undefined): string | undefined {
  const candidate = parseCookieHeader(header).get(SESSION_COOKIE_NAME);
  if (!candidate || !SESSION_ID_RE.test(candidate)) return undefined;
  return candidate;
}

function serializeSessionCookie(id: string, ttlMs: number): string {
  const maxAgeSeconds = Math.max(0, Math.floor(ttlMs / 1000));
  return `${SESSION_COOKIE_NAME}=${id}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

/** The `Set-Cookie` value that clears the session cookie in the browser. On its own this is only
 *  half of "logout" — D6/this unit's task explicitly call out that logout must invalidate
 *  server-side too, which is `destroySession`; `../auth/routes.ts`'s `/auth/logout` calls both. */
export function logoutCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

// ---- session service ----------------------------------------------------------------------------

export interface SessionServiceOptions {
  /** Which provider `resolvePrincipal` is told a resolved session belongs to. Defaults to reading
   *  `CEZ_AUTH` the same way `server.ts`'s own `requirePrincipal` middleware and `verifyWsUpgrade`
   *  do (`resolveAuthProvider(process.env)`), since only one provider is ever configured at a time
   *  (D1) and `resolveFromCookieHeader` is never even called on the `'none'` branch (`server.ts`
   *  short-circuits to `LOCAL_PRINCIPAL` before reaching it). Injectable so tests do not have to
   *  mutate the shared `process.env.CEZ_AUTH` (one global per worker) to exercise the session
   *  branch. */
  authProvider?: () => AuthProvider;
  now?: () => Date;
}

/** Cookie-session mechanics over `identity-store.ts`: mint an id, persist+cookie-encode it,
 *  resolve a cookie header back to a `Principal` on every request. Takes its `IdentityStore`
 *  rather than opening one itself so tests can inject a temp-directory instance with a fake clock
 *  — see `session.test.ts`. */
export class SessionService {
  private readonly authProvider: () => AuthProvider;
  private readonly now: () => Date;

  static create(identityStore: IdentityStore, options: SessionServiceOptions = {}): SessionService {
    return new SessionService(identityStore, options);
  }

  private constructor(
    private readonly identityStore: IdentityStore,
    options: SessionServiceOptions,
  ) {
    this.authProvider = options.authProvider ?? (() => resolveAuthProvider(process.env));
    this.now = options.now ?? (() => new Date());
  }

  /** Mints a session for an already-created, already-authenticated user (`identity-store.ts
   *  #findOrCreateUser` is the caller's job, not this method's — see `types.ts`'s `sessionSchema`
   *  doc on why the store never invents the id itself) and returns the `Set-Cookie` value for it.
   *  Org/team/role are deliberately NOT resolved or baked in here — see the module doc comment;
   *  they are resolved fresh by `resolveFromCookieHeader` on every subsequent request instead. */
  async createSession(userId: string, ttlMs: number = DEFAULT_TTL_MS): Promise<CreatedSession> {
    const expiresAt = new Date(this.now().getTime() + ttlMs);
    for (let attempt = 0; attempt < MAX_ID_MINT_ATTEMPTS; attempt += 1) {
      const id = randomBytes(SESSION_ID_BYTES).toString('hex');
      try {
        await this.identityStore.createSession({ id, userId, expiresAt });
        return { id, cookie: serializeSessionCookie(id, ttlMs) };
      } catch (error) {
        // `identity-store.ts`'s own guarded write is the uniqueness check (D7) — this file does
        // not duplicate it, only reacts to it. Anything other than the id colliding (e.g.
        // `user-not-found`, because the caller passed a `userId` with no `User` row) is a real
        // error and must not be silently retried away.
        if (error instanceof IdentityStoreError && error.code === 'session-id-taken') continue;
        throw error;
      }
    }
    throw new Error(`failed to mint a unique session id after ${MAX_ID_MINT_ATTEMPTS} attempts`);
  }

  /** Server-side invalidation (D6: "logout invalidates server-side, not just client-side") —
   *  removes the row from `identity-store.ts` so a later `resolveFromCookieHeader` (this process
   *  or another one sharing the same `CEZ_HOME`) can never accept the id again, regardless of
   *  whether the caller also clears the client's cookie (`logoutCookie()`). Idempotent: `false`
   *  for an unknown or already-destroyed id, never an error. */
  async destroySession(sessionId: string): Promise<boolean> {
    return this.identityStore.deleteSession(sessionId);
  }

  /**
   * `null` for every failure mode — no cookie, malformed id, unknown id, expired session, a
   * signed-in user with no org membership yet (D8 onboarding not finished) — never throws,
   * matching `SessionResolver`'s own contract. Synchronous throughout: every `IdentityStore` read
   * method it calls is sync (only writes are async there — see that class's own doc comment on
   * why), which is what lets this satisfy `SessionResolver`'s sync signature (`verifyWsUpgrade`'s
   * callback has nowhere to `await`).
   *
   * **Constant-time comparison — the one D6 requirement this file could not fully deliver, and
   * exactly why, at the exact place it matters.** D6 asks for session ids to be "compared in
   * constant time". The lookup that actually decides whether `candidate` matches a stored id is
   * `identityStore.getSession(candidate)`, in `identity-store.ts` — a file this unit does not own
   * (it is `Array.find((row) => row.id === id)` internally, a plain, non-constant-time string
   * compare). `SESSION_ID_RE` below rejects a malformed candidate before it reaches that lookup,
   * which is a cheap format check, not a timing defense — the id's shape is public, not secret.
   * A layer added HERE that re-compares `candidate` against whatever `getSession` returns would be
   * theater, not a fix: by the time `.find` returns a row, that row's `id` is by construction
   * already `=== candidate`, so a second, "constant-time" comparison of the two can never observe
   * a mismatch and would protect nothing. The actual fix is a small, isolated change to
   * `IdentityStore.getSession` (scan `sessions` and compare every row with `timingSafeEqual`
   * instead of stopping at the first `===` match) — flagged in this unit's report as a divergence
   * for whoever owns that file, not made here. In practice the exposure is narrow: at 256 bits of
   * `randomBytes` entropy, a network-observable timing side-channel would need to defeat that
   * entropy AND be measurable through internet jitter, which is a materially harder attack than
   * the short-secret (HMAC/password) case constant-time comparison is normally deployed against —
   * context for severity, not a reason the gap should stay open.
   */
  resolveFromCookieHeader(cookieHeader: string | undefined): Principal | null {
    const candidate = readSessionIdFromCookieHeader(cookieHeader);
    if (!candidate) return null;
    const session = this.identityStore.getSession(candidate); // already expiry-checked (D6: on every read)
    if (!session) return null;
    const identity = this.resolveIdentity(session.userId);
    if (!identity) return null;
    const authProvider = this.authProvider();
    if (authProvider === 'none') return null; // defensive: never wired while CEZ_AUTH is unset
    return resolvePrincipal({ authProvider, identity });
  }

  /** See the module doc comment's "Membership/team selection policy" — the Phase 3 stand-in for a
   *  not-yet-built active-org/team selector. `null` when a signed-in user has no membership yet
   *  (mid-D8-onboarding) or, defensively, when their org somehow has no team at all. */
  private resolveIdentity(userId: string): SessionIdentity | null {
    const membership = this.identityStore.listMemberships(userId)[0];
    if (!membership) return null;
    const team = this.identityStore.listTeams(membership.orgId)[0];
    if (!team) return null;
    return { userId, orgId: membership.orgId, teamId: team.id, role: membership.role };
  }
}

// ---- the singleton the seam imports --------------------------------------------------------------

/** The real `IdentityStore`, rooted at `<CEZ_HOME>/identity` (D7). `IdentityStore.open` does no
 *  I/O (see its own doc comment), so importing this module is itself side-effect-free — nothing
 *  under `<CEZ_HOME>/identity` is touched until a real write happens, which is what keeps D7's
 *  "created lazily on first authenticated boot" true even though `src/index.ts` only reaches this
 *  module at all once `CEZ_AUTH` names a real provider (this module sits behind a runtime-only
 *  dynamic `import()` — see `index.ts`'s own comment on why — so `CEZ_AUTH` unset never imports
 *  it in the first place). `../auth/routes.ts` deliberately opens its OWN second `IdentityStore`
 *  instance at the same directory rather than reaching into this one — see that file's own
 *  comment on why that is exactly as consistent (no in-memory cache on either side). */
const identityStore = IdentityStore.open(identityDir());
const service = SessionService.create(identityStore);

/** What `src/index.ts`'s `serveCommand` dynamically imports and threads into
 *  `ServerDeps.sessionResolver` (`server.ts`) — the same instance `requirePrincipal` and
 *  `verifyWsUpgrade` both call, per D3. */
export const sessionResolver: SessionResolver = {
  resolveFromCookieHeader: (cookieHeader) => service.resolveFromCookieHeader(cookieHeader),
};

/** Convenience re-exports for `../auth/routes.ts` (the OIDC/Google callback and logout routes)
 *  bound to the same singleton `sessionResolver` reads from, so it does not need to reach past
 *  this module's boundary into `identityStore`/`service` directly. */
export function createSession(userId: string, ttlMs?: number): Promise<CreatedSession> {
  return service.createSession(userId, ttlMs);
}

export function destroySession(sessionId: string): Promise<boolean> {
  return service.destroySession(sessionId);
}
