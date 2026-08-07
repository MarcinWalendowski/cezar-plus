import type { Principal, SessionResolver } from '../server/server.ts';
import { principalFromForwardedPayload, verifyForwardedPrincipal } from './forwarded-principal.ts';

/**
 * The ORG process's `SessionResolver` under `CEZ_AUTH=supervisor` (D10, spec
 * `.ai/specs/2026-08-06-org-team-auth-onboarding.md`) — the consumer half of
 * `./forwarded-principal.ts`'s contract.
 *
 * **ADDED 2026-08-07 at the phase 6/7 repair stage, because the channel had no consumer.** The
 * scaffold pass wrote and tested the whole sign/verify contract, `supervisor/auth-request.ts`
 * signed, `hetzner/nginx.ts` generated the `auth_request` + `proxy_set_header` wiring, and
 * `hetzner/systemd-unit.ts` wrote `Environment=CEZ_AUTH=supervisor` — and then nothing in any
 * running process ever called `verifyForwardedPrincipal`. `src/index.ts`'s resolver branch was
 * `if (gate.provider !== 'none')`, which `'supervisor'` enters, so an org process wired up
 * `auth/session.ts`'s COOKIE resolver against its own `<CEZ_HOME>/identity` — a directory D10
 * guarantees is empty on an org box, and which D10 says this process must never open. Every
 * request to every org host therefore 401'd, permanently, with all five gates green: the only
 * test covering the seam (`projects-api.test.ts`'s `CEZ_AUTH=supervisor` describe) injected a
 * hand-written cookie resolver, i.e. a faithful fake of the exact wiring that was missing.
 *
 * **Why this is its own module and not a branch inside `auth/session.ts`.** `auth/session.ts`
 * opens an `IdentityStore` at module scope. Importing it from an org process would create
 * `<org CEZ_HOME>/identity/`, which is precisely what D10 forbids ("the supervisor ... is the
 * only process that ever opens `<CEZ_HOME>/identity/*.json`"). `src/index.ts` reaches this module
 * through its own dynamic `import()`, in a branch that never touches `./auth/session.ts`,
 * `./auth/routes.ts` or `./auth/onboarding-routes.ts` at all.
 *
 * **Why the secret is read per call rather than captured at construction.** Same posture as
 * `server/server.ts`'s own `resolveAuthProvider(process.env)` reads: `CEZ_AUTH` and its siblings
 * are read per request in this codebase, and a resolver that froze the secret at import time
 * would silently keep verifying against a rotated-away value after a `systemctl reload` that did
 * not restart the process. Reading `process.env` is free; an HMAC is not the cost here.
 */

export interface ForwardedSessionResolverOptions {
  /** Defaults to `process.env.CEZ_SUPERVISOR_SECRET`, read on EVERY call (see the module doc). */
  secret?: string;
  now?: () => Date;
  maxAgeMs?: number;
}

/**
 * Builds the resolver. Every failure mode — no forwarded headers at all, an unset secret, a
 * forged or tampered signature, a stale `issuedAt` — answers `null`, which
 * `server/server.ts#requirePrincipal` turns into the same `401 {"error":"unauthenticated"}` an
 * anonymous request already gets. Fail closed, never a fallback to the local principal: that
 * fallback is exactly the "forgot a variable, exposed a shell" shape D1's boot refusal exists to
 * rule out.
 *
 * The `cookieHeader` parameter is accepted and deliberately IGNORED. Under D10 an org process has
 * no identity store to look a session id up in — the browser's `cez_session` cookie is meaningful
 * only to the supervisor, which is the process nginx's `auth_request` subrequest hands it to. An
 * org process that trusted a cookie would be a second, unaudited auth-termination surface on a
 * port every local uid can reach.
 */
export function createForwardedSessionResolver(options: ForwardedSessionResolverOptions = {}): SessionResolver {
  return {
    resolveFromCookieHeader(_cookieHeader, forwarded): Principal | null {
      if (!forwarded) return null;
      const secret = options.secret ?? process.env.CEZ_SUPERVISOR_SECRET;
      if (!secret) return null;
      const payload = verifyForwardedPrincipal(forwarded.principal, forwarded.signature, secret, {
        now: options.now,
        maxAgeMs: options.maxAgeMs,
      });
      return payload ? principalFromForwardedPayload(payload) : null;
    },
  };
}

/** The process-wide instance `src/index.ts` wires in — one per process, matching
 *  `auth/session.ts`'s own exported `sessionResolver` singleton so the two branches of the boot
 *  wiring have the same shape. */
export const forwardedSessionResolver: SessionResolver = createForwardedSessionResolver();

// ---- boot gate: CEZ_AUTH=supervisor without the secret is a misconfigured org process ----------

export interface SupervisorModeGate {
  readonly proceed: boolean;
  /** Printed on refusal; absent on the happy path. */
  readonly message?: string;
}

/**
 * `CEZ_AUTH=supervisor` with no `CEZ_SUPERVISOR_SECRET`/`CEZ_SUPERVISOR_PORT` cannot authenticate
 * ANY request and cannot reach the supervisor's root→org registry (D4) either — it would boot
 * green, serve 401 to every caller forever, and look exactly like a working deployment whose
 * users simply have not signed in yet. `hetzner.ts`'s own `verifyStep` cannot tell those apart
 * (an org host's success criterion is "an anonymous request gets 401"), so the refusal has to
 * happen here, at boot, where the difference is still visible.
 *
 * Pure and exported for the same reason `auth-boot-gate.ts` is its own module: `src/index.ts` is
 * the CLI entry, so importing it to test an inline check runs the CLI.
 */
export function resolveSupervisorModeGate(env: NodeJS.ProcessEnv): SupervisorModeGate {
  const missing = (['CEZ_SUPERVISOR_SECRET', 'CEZ_SUPERVISOR_PORT'] as const).filter((key) => !env[key]);
  if (missing.length === 0) return { proceed: true };
  return {
    proceed: false,
    message:
      `\ncezar refuses to boot: CEZ_AUTH=supervisor, but ${missing.join(' and ')} ` +
      `${missing.length === 1 ? 'is' : 'are'} unset.\n` +
      '  CEZ_AUTH=supervisor means "an org process behind the cezar supervisor" (D10): this process\n' +
      "  verifies the supervisor's HMAC-signed forwarded principal instead of terminating a login\n" +
      '  itself, and asks the supervisor for D4\'s root→org mapping. Without the shared secret and\n' +
      '  port it can do neither — it would answer 401 to every request, forever, while looking\n' +
      '  healthy. They belong in the unit\'s root-owned EnvironmentFile= (never Environment=), which\n' +
      '  `cezar server-install --platform hetzner --org-slug <slug>` writes for you.\n',
  };
}
