import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { resolveAuthProvider } from '../server/capabilities.ts';
import { identityDir } from '../paths.ts';
import type { SessionResolver } from '../server/server.ts';
import {
  discoverOidcConfiguration,
  OidcClient,
  resolveOidcConfig,
  type OidcProvider,
} from './oidc.ts';
import { IdentityStore } from './identity-store.ts';
import {
  createSession,
  destroySession,
  logoutCookie,
  sessionResolver,
  SESSION_COOKIE_NAME,
  type CreatedSession,
} from './session.ts';
import type { User } from './types.ts';

/**
 * The auth HTTP surface (D1/D6/D9, spec `.ai/specs/2026-08-06-org-team-auth-onboarding.md`,
 * phase 3): `GET /auth/login`, `GET /auth/callback`, `POST /auth/logout`, `GET /auth/me`.
 *
 * **Mount point.** `server.ts` mounts `deps.authRoutes` at the app ROOT, before the SPA
 * catch-all, and only when `CEZ_AUTH !== 'none'` — see `src/index.ts`'s boot gate, which is the
 * ONLY place that imports this module (via a `const`-path `import()` so `CEZ_AUTH` unset never
 * even loads it, per D1's "unset means zero I/O"). D5: these are top-level paths, not
 * `/api/v1/...` — `versioned-surface.test.ts`'s stray-route guard only flags paths that start
 * with `/api/` and sit outside `/api/v1`, so a root-mounted `/auth/*` family is exempt from that
 * guard by construction; nothing in that suite needed to change for this file to exist.
 *
 * **Protocol vs. routes.** `./oidc.ts` (a separate, already-landed unit) is the whole protocol
 * engine: discovery, PKCE, the authorization URL, the code-for-tokens exchange, ID-token
 * verification and group->role claim mapping, all state-and-nonce bookkeeping included via
 * `OidcClient.startAuthorization`/`completeAuthorization`. `./session.ts` (backed by
 * `./identity-store.ts`, also separate, already-landed units) owns minting/resolving the cookie
 * session and resolving org/team/role FRESH on every read from `identity-store.ts`'s
 * `memberships`/`teams` tables — never baked into the session at creation time (see `session.ts`'s
 * own module doc comment). This file is deliberately thin: HTTP verbs, status codes, cookies, and
 * turning a successful `OidcClient` login into `identityStore.findOrCreateUser(...)` +
 * `createSession(user.id)`.
 *
 * **The D8 onboarding gap this file deliberately does NOT fill.** D8's step 1 says "the first
 * user to sign in becomes owner of a new org; subsequent users need an invite" — org/team
 * *creation* (`IdentityStore.createOrg`/`createMembership`) already exists (a sibling unit built
 * it), but nothing in this file calls it. A user who signs in with no existing membership gets a
 * real, valid session for a real user row, and every principal-gated read
 * (`GET /auth/me` here, `requirePrincipal`/`verifyWsUpgrade` in `server.ts`) answers
 * 401/unauthenticated for them until an org exists and grants them a membership —
 * `session.ts`'s own doc comment names this explicitly as an anticipated state ("a signed-in
 * user with no org membership yet (D8 onboarding not finished)"), not a bug this route is
 * expected to paper over. This task's own scope is four specific routes (login/callback/
 * logout/me); D8 step 1's "first user becomes owner" bootstrap and steps 2-4 (name the org,
 * accept/rename the default team, add projects) are onboarding UI/API surface with their own
 * product decisions (what counts as "the first user" under a race, how the org name is derived,
 * what happens for user two) that belong to whichever unit is assigned that work — flagged
 * prominently in this unit's report rather than decided unilaterally here.
 */

// ---- deps: the testable seam ------------------------------------------------------------------

/**
 * Everything `createAuthRoutes` needs, injected rather than imported directly inside the route
 * handlers — the real wiring (`buildAuthRoutes` below) supplies the actual `OidcClient` and the
 * `./session.ts` / `./identity-store.ts` singletons; `routes.test.ts` supplies fakes (or a real
 * temp-directory `IdentityStore`/`SessionService`) so the HTTP/cookie logic below is exercised
 * without a real network call or a write under the developer's own `<CEZ_HOME>/identity`.
 */
export interface AuthRouteDeps {
  /** Which provider `oidc` was built for. Not read by anything in THIS file today — org/team/
   *  role resolution now happens entirely inside `session.ts`/`identity-store.ts` — kept on the
   *  interface anyway because it is cheap, already-known context a future reader (or a future
   *  branch in this file) may need, and dropping it would be a second, silent contract change if
   *  it turns out to be needed again. */
  readonly provider: OidcProvider;
  readonly oidc: OidcClient;
  /** The SAME resolver `server.ts`'s `requirePrincipal` middleware and `verifyWsUpgrade` use
   *  (D3/D6) — `GET /auth/me` reads exactly what the rest of the app would authorize, not a
   *  second, possibly-drifted read of the cookie. */
  readonly sessionResolver: SessionResolver;
  /** `identity-store.ts#findOrCreateUser`, keyed on `(issuer, subject)` per `types.ts`'s
   *  `userSchema` doc — never email, which can be reassigned. Only the fields this route already
   *  has from a verified ID token are passed through. */
  findOrCreateUser(input: { issuer: string; subject: string; email?: string; name?: string }): Promise<{
    user: Pick<User, 'id'>;
    created: boolean;
  }>;
  createSession(userId: string, ttlMs?: number): Promise<CreatedSession>;
  destroySession(sessionId: string): Promise<boolean>;
  logoutCookie(): string;
  /** Server-side diagnostic for a failed exchange/verification or a provider-side error
   *  redirect — never sent to the client, which always gets the same generic
   *  `{error:'authentication failed'}` regardless of which check failed, so a caller cannot use
   *  the response to fingerprint what went wrong. Defaults to `console.error`; injectable so
   *  tests exercising the failure paths on purpose do not spam output. */
  log?(message: string): void;
}

// ---- binding `state` to the browser that started the flow ---------------------------------------

/**
 * The `state` parameter is single-use and unguessable in `oidc.ts`, but on its own it lives ONLY
 * in the server's in-process pending map — it is not bound to any particular browser, and that
 * is a login-CSRF / session-fixation hole rather than a theoretical one:
 *
 *   1. the attacker hits the deployment's own `GET /auth/login` and completes the flow at the IdP
 *      with THEIR account, stopping before the callback;
 *   2. they navigate the victim to the resulting `…/auth/callback?code=&state=`;
 *   3. `SameSite=Lax` permits a cookie-setting response to a cross-site top-level GET navigation,
 *      so the victim's browser is now pinned to the ATTACKER's identity, and everything the
 *      victim does next happens in the attacker's account.
 *
 * The exposure is capped today only by accident — a freshly-created user has no membership, so
 * `session.ts` resolves no principal and every route 401s anyway — and D8 phase 4 ("the first
 * user to sign in becomes owner of a new org") is precisely the change that uncaps it. So it is
 * closed now, while the flow is still four routes.
 *
 * The fix is the standard one: mirror `state` into a short-lived cookie on the redirect out, and
 * require the callback's `state` to equal the cookie the SAME browser sends back. The attacker
 * can hand the victim a URL but cannot write a cookie on the deployment's origin, so step 2 no
 * longer authenticates anyone. `SameSite=Lax` is required rather than `Strict` for exactly the
 * reason above — the callback arrives as a cross-site top-level navigation from the IdP, and a
 * `Strict` cookie would not be sent with it, breaking every legitimate login.
 *
 * Not `__Host-` prefixed: that prefix requires `Secure`, which browsers refuse to honour on a
 * plain-http origin, and D1's table explicitly supports `CEZ_AUTH=oidc` on a loopback deployment
 * for testing the flow. The `Secure` attribute is set regardless (the same choice `session.ts`
 * already makes for the session cookie itself), so a real hosted deployment gets the protection
 * and the loopback case degrades to "cookie ignored", not "cookie sent over cleartext".
 */
export const AUTH_STATE_COOKIE_NAME = 'cez_auth_state';

/** Ten minutes: long enough for a real interactive sign-in (including an MFA prompt), short
 *  enough that an abandoned `/auth/login` leaves nothing durable in the browser. It does not need
 *  to match `oidc.ts`'s own pending-entry TTL — whichever expires first ends the flow, and both
 *  ends failing closed is the intended behaviour. */
const AUTH_STATE_TTL_SECONDS = 600;

function authStateCookie(state: string): string {
  return `${AUTH_STATE_COOKIE_NAME}=${state}; Path=/; Max-Age=${AUTH_STATE_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

/** Cleared on every terminal outcome — success, mismatch, or a failed exchange — so a stale value
 *  can never be replayed against a later flow. */
function clearAuthStateCookie(): string {
  return `${AUTH_STATE_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

// ---- the routes ---------------------------------------------------------------------------------

export function createAuthRoutes(deps: AuthRouteDeps): Hono {
  const log = deps.log ?? ((message: string) => console.error(message));

  return new Hono()
    // ---- GET /auth/login: redirect to the provider ---------------------------------------------
    // No return-to target is accepted or stored: `OidcClient.startAuthorization` has no such
    // parameter (D9 doesn't ask for one, and this file cannot extend that class — it belongs to
    // a different unit), so every successful login lands on `/`. Phase 4's onboarding flow is
    // the natural place to add deep-linking once there is somewhere authenticated to deep-link
    // to.
    .get('/auth/login', (c) => {
      const { url, state } = deps.oidc.startAuthorization();
      // The cookie half of the state binding — see `AUTH_STATE_COOKIE_NAME` above for the
      // login-CSRF this closes. Set here, checked in `/auth/callback`, cleared there.
      c.header('set-cookie', authStateCookie(state));
      return c.redirect(url, 302);
    })

    // ---- GET /auth/callback: code exchange -> session cookie -> redirect -----------------------
    .get('/auth/callback', async (c) => {
      const providerError = c.req.query('error');
      if (providerError) {
        // The provider itself refused (user declined consent, misconfigured client, ...). No
        // `state` lookup happens on this path, so nothing is consumed and a retry from
        // `/auth/login` still works.
        const description = c.req.query('error_description');
        log(`oidc callback: provider returned error="${providerError}"${description ? ` (${description})` : ''}`);
        return c.json({ error: 'authentication failed' }, 400);
      }

      const code = c.req.query('code');
      const state = c.req.query('state');
      if (!code || !state) {
        return c.json({ error: 'missing code or state' }, 400);
      }

      // Does this `state` belong to THIS browser? Checked BEFORE `completeAuthorization`, and
      // deliberately without consuming the pending entry: a mismatch means this browser never
      // started this flow, so the browser that did must still be able to finish it. An attacker
      // who hands a victim a callback URL cannot also set a cookie on this origin, so this is
      // what stops step 2 of the fixation attack described above.
      const boundState = getCookie(c, AUTH_STATE_COOKIE_NAME);
      if (!boundState || boundState !== state) {
        log(
          `oidc callback rejected: state is not bound to this browser (${boundState ? 'cookie/query mismatch' : 'no state cookie'})`,
        );
        c.header('set-cookie', clearAuthStateCookie());
        return c.json({ error: 'authentication failed' }, 400);
      }

      // `OidcClient.completeAuthorization` is the sole authority on `state`: it looks the value
      // up in its own in-process pending map (seeded by `startAuthorization`, single-use the
      // moment it's read — see oidc.ts) and fails closed for anything it does not recognise,
      // including an unknown, expired, or already-consumed state. No session is ever minted on
      // this branch, which is exactly what a forged or replayed `state` must produce.
      const result = await deps.oidc.completeAuthorization({ state, code });
      if (!result.ok) {
        log(`oidc callback failed: ${result.reason}`);
        c.header('set-cookie', clearAuthStateCookie());
        return c.json({ error: 'authentication failed' }, 400);
      }

      const { user } = await deps.findOrCreateUser({
        issuer: result.issuer,
        subject: result.subject,
        email: result.email,
        name: result.name,
      });
      const created = await deps.createSession(user.id);
      c.header('set-cookie', created.cookie);
      c.header('set-cookie', clearAuthStateCookie(), { append: true });
      // **CORRECTED 2026-08-07 (repair stage): `/onboarding`, not `/`.** This redirected to the
      // cockpit root, and D8 was therefore unreachable end to end: a user with a valid session and
      // no membership landed on `/`, where `requirePrincipal` 401s every `/api/v1/*` call, so the
      // shell rendered with every panel erroring and no affordance pointing anywhere. Nothing else
      // in the cockpit links to `/onboarding` — `grep -rn "onboarding" packages/web/src` finds
      // only the route's own registration — so this redirect IS the seam. An already-onboarded
      // user is not detoured: `/onboarding` resolves `GET /auth/onboarding`, sees
      // `state: 'ready'` with `hasProjects`, and navigates straight to `/` (see
      // `onboarding.tsx#fromProbe`). The alternative — deciding here, by reading the user's
      // memberships — would put a second copy of the onboarding state machine in the login route.
      return c.redirect('/onboarding', 302);
    })

    // ---- POST /auth/logout: server-side invalidation + cookie clear ----------------------------
    .post('/auth/logout', async (c) => {
      // Idempotent by construction (`destroySession` is a no-op on an unknown/already-gone id —
      // see session.ts): logging out twice, or logging out with no session cookie at all, both
      // answer the same 200 rather than 401ing on "nothing to log out of".
      const sessionId = getCookie(c, SESSION_COOKIE_NAME);
      if (sessionId) await deps.destroySession(sessionId);
      c.header('set-cookie', deps.logoutCookie());
      return c.json({ ok: true });
    })

    // ---- GET /auth/me: read the current principal ------------------------------------------------
    .get('/auth/me', (c) => {
      // The SAME resolver `requirePrincipal`/`verifyWsUpgrade` call (D3/D6) — this route reports
      // exactly what the rest of the app would authorize, never a second read of the cookie that
      // could drift from it. `null` covers "no cookie" AND "signed in but no org membership yet"
      // (D8 onboarding not finished, see the module doc comment) identically — both are, from
      // this route's point of view, "nothing to report yet".
      const principal = deps.sessionResolver.resolveFromCookieHeader(c.req.header('cookie'));
      if (!principal) return c.json({ error: 'unauthenticated' }, 401);
      return c.json({ principal });
    });
}

// ---- the real, process-lifetime wiring ---------------------------------------------------------

/** Every route answering the SAME 500 with the SAME reason — used both when `CEZ_AUTH` names a
 *  provider but its config is incomplete/invalid, and (defensively) if this module is ever
 *  reached with `CEZ_AUTH=none`, which should not be reachable in practice (see `buildAuthRoutes`).
 *  Scoped to exactly the four `/auth/*` paths this file owns, rather than a catch-all `/*`, so a
 *  misconfigured deployment still serves its SPA shell at `/` instead of 500ing on every route. */
function misconfiguredRoutes(reason: string): Hono {
  const error = `auth is misconfigured: ${reason}`;
  return new Hono()
    .get('/auth/login', (c) => c.json({ error }, 500))
    .get('/auth/callback', (c) => c.json({ error }, 500))
    .post('/auth/logout', (c) => c.json({ error }, 500))
    .get('/auth/me', (c) => c.json({ error }, 500));
}

/**
 * The real, process-lifetime wiring. oidc.ts's own module doc comment is explicit that
 * `resolveOidcConfig` must run exactly once, at boot, and that one `OidcClient` instance is
 * meant to live for the process lifetime, built once from `resolveOidcConfig` +
 * `discoverOidcConfiguration` — never re-derived per request. `src/index.ts`'s boot gate is the
 * only caller of this module (a runtime-only `import()`, gated on
 * `resolveAuthProvider(process.env) !== 'none'`) and it `await`s the whole `Promise.all([...import(session), import(routes)])`
 * before ever calling `startServer` — so the top-level `await` below IS "at boot", not a lazy
 * first-request path.
 *
 * Never throws or rejects: a config or discovery failure degrades to `misconfiguredRoutes`
 * (every `/auth/*` route answering 500 with the exact reason) rather than crashing the dynamic
 * import. `index.ts`'s `Promise.all([...])` has no `try`/`catch` around it, and an unhandled
 * rejection there would crash the CLI with a raw stack trace instead of the clear, actionable
 * message this gives every caller of `/auth/*` instead — a worse failure mode than a server that
 * boots and answers 500 on the one family that cannot work. The reason is ALSO printed once here
 * (not only inside the 500 body), so an operator sees it in the boot log rather than only on the
 * first login attempt someone tries — the Risk item's "fail loudly ... rather than at first
 * login", achieved without needing `index.ts` (not this unit's file) to add its own handling.
 *
 * Opens its OWN `IdentityStore` rather than reaching into `session.ts`'s private instance:
 * `IdentityStore` keeps no in-memory cache and every read re-parses `identity.json` from disk
 * (see that class's own doc comment on why), so a second instance rooted at the same
 * `identityDir()` is exactly as consistent as sharing one — this is the same multi-reader shape
 * D4/D7 already require the store to tolerate across separate PROCESSES, let alone two instances
 * in the same one. `session.ts`'s own module doc comment confirms this is the intended split.
 */
async function buildAuthRoutes(): Promise<Hono> {
  const provider = resolveAuthProvider(process.env);
  if (provider === 'none') {
    // Defensive only: `index.ts` never imports this module unless `CEZ_AUTH` names a real
    // provider. A caller that reaches this module some other way (a test, a future misuse) gets
    // a loud, correct failure rather than routes that quietly pretend to be configured.
    const reason = 'CEZ_AUTH is "none" — this module should never have been imported';
    console.error(`auth routes: ${reason}`);
    return misconfiguredRoutes(reason);
  }
  if (provider === 'supervisor') {
    // ADDED 2026-08-07 (repair stage). `'supervisor'` names an ORG process that TRUSTS a
    // supervisor's forwarded principal, not a way to log in (D10) — and `src/index.ts`'s
    // supervisor branch deliberately never imports this module. Reaching it anyway means either
    // the supervisor's own unit was mis-set to `CEZ_AUTH=supervisor` (its own boot gate refuses
    // that now, `supervisor/index.ts`) or a caller imported this module directly. Before this
    // branch, `'supervisor'` fell into `resolveOidcConfig`'s GENERIC-OIDC path and, on a host
    // that happened to carry OIDC credentials, would have stood up a second, unintended login
    // surface against a store D10 says this process must never open.
    const reason = 'CEZ_AUTH is "supervisor" — this process trusts a forwarded principal (D10) and has no login flow of its own';
    console.error(`auth routes: ${reason}`);
    return misconfiguredRoutes(reason);
  }
  const configResult = resolveOidcConfig(provider, process.env);
  if (!configResult.ok) {
    console.error(`auth routes: ${configResult.reason}`);
    return misconfiguredRoutes(configResult.reason);
  }
  const discovery = await discoverOidcConfiguration(configResult.config.issuer);
  if (!discovery.ok) {
    console.error(`auth routes: ${discovery.reason}`);
    return misconfiguredRoutes(discovery.reason);
  }
  const oidc = new OidcClient(configResult.config, discovery.document);
  const identityStore = IdentityStore.open(identityDir());
  return createAuthRoutes({
    provider,
    oidc,
    sessionResolver,
    findOrCreateUser: (input) => identityStore.findOrCreateUser(input),
    createSession,
    destroySession,
    logoutCookie,
  });
}

/** What `src/index.ts`'s `serveCommand` dynamically imports and threads into `server.ts`'s
 *  `ServerDeps.authRoutes`, mounted at the app root (`if (deps.authRoutes) routed.route('/', deps.authRoutes)`). */
export const authRoutes: Hono = await buildAuthRoutes();
