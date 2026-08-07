import type { SessionResolver } from '../server/server.ts';
import { signForwardedPrincipal, type ForwardedPrincipalPayload, type SignedForwardedPrincipal } from './forwarded-principal.ts';
import type { OrgProcessRecord } from './org-process-registry.ts';

/**
 * `/internal/auth-check` (D10) — the decision nginx's `auth_request` directive asks for, on every
 * org vhost, before proxying to that org's own upstream. This module is the pure decision;
 * `./server.ts` wraps it as one route.
 *
 * **What this deliberately does, and does not, check.** D10's own text: "resolve the request's
 * session cookie via the existing `sessionResolver.resolveFromCookieHeader`, and on a resolved
 * `Principal`, sign it ... using THAT CALLER'S ORG'S secret". This function does exactly that — it
 * does not additionally cross-check the vhost's own hostname/org against the resolved principal,
 * because phase 7's nginx config (D10's ownership map, unit 4, not yet built) has not yet fixed
 * WHICH header would carry that hostname to this route (a bare `Host` on the `auth_request`
 * subrequest, an explicit `proxy_set_header`, or something else — nginx's default is to forward the
 * ORIGINAL request unchanged, but that is a contract unit 4 owns, not this one). Signing with the
 * CALLER's own org's secret is still safe without that cross-check: nginx forwards the signed
 * headers to whichever org's upstream the vhost is wired to, and that org's OWN process verifies
 * with ITS OWN secret (`verifyForwardedPrincipal`, D10's org-process side) — a caller signed for
 * org A can never pass verification at org B's process, because the two orgs' secrets differ. A
 * visitor with no membership in the vhost's own org is therefore refused at the ORG PROCESS, not
 * here, which is the same "verify at the boundary that actually enforces it" reasoning
 * `forwarded-principal.ts`'s own module doc already applies to why a signature exists at all.
 * `getActiveByHostname`-style routing (`org-registry-store.ts`) is a real, separate "hostname ->
 * org" capability this pass DOES build — for phase 7's nginx-config generation and operator
 * tooling — just not as an additional gate inside this specific decision.
 *
 * **`kind !== 'session'` is unreachable in practice, and refused anyway.** The supervisor always
 * runs with `CEZ_AUTH` naming a real provider (oidc/google — see `./index.ts`'s own boot gate), so
 * `sessionResolver.resolveFromCookieHeader` never produces the `'local'` kind
 * (`auth/session.ts#resolveFromCookieHeader`'s own defensive `authProvider === 'none'` branch).
 * Checked anyway, on this codebase's general "should never happen" stance — a `Principal` shape
 * `forwarded-principal.ts#forwardedPrincipalPayloadSchema` cannot express (there is no `kind`
 * field on the wire payload; `principalFromForwardedPayload` hardcodes `'session'`) must never be
 * signed and forwarded as if it were one.
 */

export interface AuthCheckDeps {
  readonly sessionResolver: Pick<SessionResolver, 'resolveFromCookieHeader'>;
  /** `OrgProcessRegistryStore#getActiveByOrgId`, injected rather than imported directly so this
   *  stays a pure function of its inputs — `./server.ts` supplies the real store. */
  getActiveOrgProcess(orgId: string): OrgProcessRecord | undefined;
  now?: () => Date;
}

export type AuthCheckResult =
  | { readonly ok: true; readonly headers: SignedForwardedPrincipal }
  | { readonly ok: false; readonly reason: 'unauthenticated' | 'org-has-no-active-process' };

export function resolveAuthCheck(cookieHeader: string | undefined, deps: AuthCheckDeps): AuthCheckResult {
  const principal = deps.sessionResolver.resolveFromCookieHeader(cookieHeader);
  if (!principal || principal.kind !== 'session') return { ok: false, reason: 'unauthenticated' };

  const record = deps.getActiveOrgProcess(principal.orgId);
  if (!record) return { ok: false, reason: 'org-has-no-active-process' };

  const payload: ForwardedPrincipalPayload = {
    userId: principal.userId,
    orgId: principal.orgId,
    teamId: principal.teamId,
    role: principal.role,
    issuedAt: (deps.now?.() ?? new Date()).toISOString(),
  };
  return { ok: true, headers: signForwardedPrincipal(payload, record.supervisorSecret) };
}
