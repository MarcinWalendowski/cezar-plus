import { getApiBaseUrl } from '@open-mercato/cezar-api-client'
import type {
  CreateOnboardingOrgInput,
  CreateOnboardingOrgResponse,
  Org,
  OnboardingStatusResponse,
  RenameOnboardingTeamInput,
  RenameOnboardingTeamResponse,
  Role,
  Team,
} from '@open-mercato/cezar-api-client'

import { ApiError } from '@/api/client'

/**
 * The hand-rolled client for the four onboarding-only calls this wizard makes.
 *
 * Deliberately NOT on the typed client (`cez` in `@/api/client`): `/auth/*` is a root-mounted
 * `Hono` app (`auth/routes.ts`), never chained into the `/api/v1` family builder, so it never
 * reaches `AppType` — `createCezarClient<AppType>()` has no way to type a path outside it. This
 * module is the same shape as `client.ts`'s own hand-written functions (`ApiError`, credentialed
 * fetch, `{error}` extraction), reused rather than duplicated, just pointed at `/auth/onboarding*`
 * instead of `/api/v1/...`.
 *
 * **What "not JSON" means, and why the signal is no longer called "auth-off".**
 *
 * **CORRECTED 2026-08-07 (D13 cockpit pass): the paragraph this replaces claimed `CEZ_AUTH`
 * unset ⇒ `/auth/*` is never registered, full stop — no longer true for most of that
 * population.** D13 (`.ai/specs/2026-08-06-org-team-auth-onboarding.md`, phase 9) mounts a real,
 * local `onboardingRoutes` for exactly the topology that old paragraph was written to describe —
 * the npm zero-config default, loopback bind, `CEZ_AUTH` unset (`src/index.ts`'s
 * `capabilities.localHandoff` branch) — so `GET /auth/onboarding` answers real JSON there now
 * (`needs-org` before a local org exists, `ready` after). No capability key gates any of this
 * either way (`BACKWARD_COMPATIBILITY.md` §2 — "capabilities gained no key for authentication",
 * and the Risks section names exactly that move as the one that broke the auth-off control once
 * already), so this module still has to read the signal off the response rather than a flag.
 *
 * What survives is narrower: a **hosted** deployment that also leaves `CEZ_AUTH` unset
 * (`CEZ_REMOTE=1` or a non-loopback bind, plus the operator's own explicit
 * `CEZ_ALLOW_UNAUTHENTICATED=1` — D9's bounded-audience escape hatch) still mounts nothing under
 * `/auth/*` at all — `src/index.ts`'s D13 branch is keyed on `capabilities.localHandoff`
 * specifically and falls through unmatched there. So a request to `/auth/onboarding` on THAT
 * topology still falls through to the SPA catch-all, which answers EVERY unmatched GET with the
 * built `index.html` (`server/static-ui.ts#resolveGetRequest`: only `/api/*` and the static asset
 * paths are `'passthrough'`) — `200 text/html`, never JSON.
 *
 * So "the body isn't JSON" no longer means "auth is off" (it can be off AND answer real JSON now,
 * in local mode) — it means **this deployment offers no org/onboarding surface to reach at all**,
 * which today describes exactly one topology: hosted, unauthenticated, no per-request identity of
 * any kind, local or session. `OnboardingProbe`'s `unavailable` kind (below) is named for that —
 * the old `auth-off` name was the deciding CONDITION's name, and the deciding condition moved out
 * from under it. The signal itself is unchanged: still derived from what the server actually
 * sent, never a flag this module reads.
 */

function authUrl(path: string): string {
  return `${getApiBaseUrl()}${path}`
}

/** Same contract as `client.ts#fetchOrThrow`: credentials always included (the session is a
 *  cookie, D6), and a request that never reached the server becomes an `ApiError` with status 0
 *  rather than a raw `TypeError` — one error type for every caller in this module. */
async function fetchAuth(path: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(authUrl(path), { ...init, credentials: 'include' })
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause
    throw new ApiError(0, `cannot reach the cezar server (${path})`, { cause })
  }
}

/** Whether a response is real JSON from a mounted route, rather than the SPA catch-all's
 *  `index.html` (`server/static-ui.ts#resolveGetRequest`: every unmatched GET answers `200
 *  text/html`). The one idiom every hand-rolled `/auth/*` probe in the cockpit reads this off —
 *  see this module's own doc comment above. Exported so a probe against a DIFFERENT `/auth/*`
 *  route family (`settings/account-api.ts`'s `GET /auth/me` check, D14) reuses it rather than
 *  writing a third copy — `teams-api.ts` already duplicated it once, deliberately, for a
 *  documented reason (a different Fill unit's file, under an ownership map that no longer
 *  applies); a third hand-rolled copy with no such reason would be the mistake
 *  `invite-routes.ts`'s own "these cannot drift" docblock names. */
export function isJsonResponse(res: Response): boolean {
  return (res.headers.get('content-type') ?? '').includes('application/json')
}

/** `undefined` on anything that doesn't parse — an error body is untrusted input (a proxy's HTML
 *  page is as likely as the server's own `{ error }`), same discipline as `client.ts#parseJson`. */
function parseJsonBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function errorMessageFrom(status: number, statusText: string, body: unknown): string {
  if (body && typeof body === 'object' && 'error' in body) {
    const error = (body as { error?: unknown }).error
    if (typeof error === 'string') return error
  }
  return `${status} ${statusText || 'request failed'}`.trim()
}

// ---- GET /auth/onboarding ---------------------------------------------------------------------

/**
 * The five states the wizard renders: `orgs.ts#onboardingStateSchema`'s three, plus the 401
 * `/auth/onboarding` answers for "no session at all" (mirroring `/auth/me`'s 401 contract), plus
 * `unavailable`, which exists only on this side of the wire (see the module doc comment above).
 *
 * **Renamed from `auth-off` 2026-08-07 (D13 cockpit pass).** D13 local mode never produces this
 * state — it answers `needs-org`/`ready` like an authenticated deployment does — so a kind named
 * for "auth is off" would be actively misleading about which deployments reach it. Only a hosted,
 * unauthenticated deployment (no `/auth/*` mounted at all) does now.
 */
export type OnboardingProbe =
  | { kind: 'unavailable' }
  | { kind: 'signed-out' }
  | { kind: 'needs-org'; suggestedOrgName?: string; bootstrapTokenRequired: boolean }
  /** Signed in, an org exists, and this user is not in it — D8 step 1's "subsequent users need an
   *  invite". Carries nothing about the org (the server sends nothing: see the contract). */
  | { kind: 'needs-invite' }
  | { kind: 'ready'; org: Org; team: Team; role: Role; hasProjects: boolean }

export async function probeOnboarding(signal?: AbortSignal): Promise<OnboardingProbe> {
  const res = await fetchAuth('/auth/onboarding', { method: 'GET', signal })
  if (!isJsonResponse(res)) {
    // The SPA shell, not `/auth/onboarding` — only reachable now on a hosted, unauthenticated
    // deployment (see the module doc comment: D13 mounts real JSON routes for the npm zero-config
    // default, so this branch no longer fires there). Drain the body (nothing in it is ours to
    // read) and report onboarding as unavailable rather than trying to interpret HTML as a state.
    await res.text().catch(() => undefined)
    return { kind: 'unavailable' }
  }
  const body = parseJsonBody(await res.text())
  if (res.status === 401) return { kind: 'signed-out' }
  if (!res.ok || body === undefined) {
    throw new ApiError(res.status, errorMessageFrom(res.status, res.statusText, body))
  }
  const status = body as OnboardingStatusResponse
  if (status.state === 'needs-invite') return { kind: 'needs-invite' }
  if (status.state === 'needs-org') {
    return {
      kind: 'needs-org',
      suggestedOrgName: status.suggestedOrgName,
      // Defaults to `true` — the SAFE default, not the convenient one. A server that omits the
      // field is either older than the bootstrap claim or answering something unexpected, and
      // rendering the code field in that case costs a user one visible input they can leave
      // blank; hiding it would make a required code look like a broken 403 with no way to comply.
      bootstrapTokenRequired: status.bootstrapTokenRequired ?? true,
    }
  }
  // `state === 'ready'`: the contract's own doc comment says org/team/role are "present only
  // when state === 'ready'" — every field is `.optional()` on the wire regardless, so a
  // response that names `ready` without them is the server disagreeing with its own contract,
  // which is worth a loud error rather than a silently undefined org three renders later.
  if (status.org === undefined || status.team === undefined || status.role === undefined) {
    throw new ApiError(res.status, 'the cezar server answered a ready onboarding status with no org/team/role')
  }
  // `hasProjects` was computed by the route and dropped here, so a resumed user with five
  // projects was greeted with "Add your first project" — fixed 2026-08-07 (repair stage), and it
  // is also what lets `/auth/callback` redirect EVERY sign-in here without detouring an
  // already-onboarded user (see `onboarding.tsx#fromProbe`). Absent reads as `false`, which lands
  // on the add-projects step — the same place the field's absence used to land, so an older
  // server degrades to exactly the previous behaviour rather than to a redirect loop.
  return {
    kind: 'ready',
    org: status.org,
    team: status.team,
    role: status.role,
    hasProjects: status.hasProjects ?? false,
  }
}

// ---- POST /auth/onboarding/org, PATCH /auth/onboarding/team ------------------------------------

async function sendJson<T>(path: string, method: string, json: unknown): Promise<T> {
  const res = await fetchAuth(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(json),
  })
  const body = parseJsonBody(await res.text())
  if (!res.ok) throw new ApiError(res.status, errorMessageFrom(res.status, res.statusText, body))
  if (body === undefined) {
    throw new ApiError(res.status, `the cezar server answered ${path} with a non-JSON body`)
  }
  return body as T
}

/** D8 step 1+2: creates the org, its default team AND the caller's owner membership in one atomic
 *  write. **CORRECTED 2026-08-07:** this said "409s when the caller already has a membership
 *  anywhere". It 409s once ANY org exists on the deployment — D8 step 1 is "the first user to sign
 *  in becomes owner of a new org; subsequent users need an invite", so a second user is refused
 *  outright rather than given an org of their own. The server's `{error}` string says so and is
 *  surfaced verbatim by `errorMessageFrom` above; see the contract's own doc comment. */
export function createOnboardingOrg(
  input: CreateOnboardingOrgInput,
): Promise<CreateOnboardingOrgResponse> {
  return sendJson('/auth/onboarding/org', 'POST', input)
}

/** D8 step 3: renames the caller's own already-created default team. No `teamId` in the body —
 *  the route resolves it from the session, never from client input. */
export function renameOnboardingTeam(
  input: RenameOnboardingTeamInput,
): Promise<RenameOnboardingTeamResponse> {
  return sendJson('/auth/onboarding/team', 'PATCH', input)
}
