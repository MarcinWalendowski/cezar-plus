import { getApiBaseUrl } from '@loki-labs/better-cezar-api-client'

import { ApiError, NO_REDIRECT, throwIfIdentityGate } from '@/api/client'
import { isJsonResponse } from '@/routes/onboarding/onboarding-api'

/**
 * Settings → Account (D14, `.ai/specs/2026-08-06-org-team-auth-onboarding.md`) — `POST
 * /auth/logout` has existed since phase 3 with no caller anywhere in the cockpit: there was no way
 * to sign out of a cezar deployment from its own UI. This module is the two calls that section
 * needs: whether there is anything to sign out OF, and the sign-out itself.
 *
 * **Visibility is a probe against `/auth/*`, never a capability key.** `capabilitiesSchema`
 * deliberately carries no `auth` key (D1's Risks section; `capabilities.test.ts:213` enforces the
 * absence), and `account-section.tsx`'s own doc comment says why a capability flag would be the
 * wrong tool even if it existed: auth is a per-request signal (does THIS caller have a session to
 * end), not a deployment-wide flag. So this reads `GET /auth/me` the same
 * answered-with-JSON-or-not way `onboarding-api.ts#probeOnboarding` and `teams-api.ts#probeTeams`
 * already read their own `/auth/*` routes — `isJsonResponse` is imported from `onboarding-api.ts`
 * rather than copied a third time.
 *
 * **Why `/auth/me`, not `/auth/onboarding`.** `onboarding-gate.ts`'s probe answers real JSON in
 * BOTH local mode (D13 mounts `onboardingRoutes`/`teamRoutes` there) and an authenticated
 * deployment — it cannot tell them apart, and D13 says local mode mounts `authRoutes`
 * (login/callback/logout/me) NOWHERE: "there is nothing to log into and no second user to invite."
 * `GET /auth/me` is part of THAT family, so it answers JSON exactly when there is a session
 * surface to sign out of, and falls through to the SPA catch-all (non-JSON) in local mode and on a
 * hosted, unauthenticated deployment alike — the two topologies D14's own task text names as "the
 * section must be absent" and "must never gate", respectively.
 */

function authUrl(path: string): string {
  return `${getApiBaseUrl()}${path}`
}

/** `true` once `GET /auth/me` answers real JSON — signed in or not (even the signed-out `401`
 *  body is JSON): the question this probe answers is "is the login/logout surface mounted at
 *  all", not "is this caller currently signed in". A network failure degrades to `false` rather
 *  than throwing: this probe only ever decides whether a settings section renders, and a
 *  transient fetch error should not be read as "sign-in is unavailable" — the section simply
 *  waits for the next probe rather than surfacing an error card for a purely presentational
 *  check. */
export async function probeAccountAvailable(signal?: AbortSignal): Promise<boolean> {
  let res: Response
  try {
    res = await fetch(authUrl('/auth/me'), {
      method: 'GET',
      credentials: 'include',
      signal,
      ...NO_REDIRECT,
    })
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause
    return false
  }
  // Not folded into the `return false` above: an identity gate is not "this deployment has no
  // sign-in surface", it is "you are signed out of one". Reporting it as absence would hide the
  // very state this probe sits next to.
  throwIfIdentityGate(res, '/auth/me')
  const available = isJsonResponse(res)
  // Nothing in either body is ours to read here — drain it so the connection can be reused.
  await res.text().catch(() => undefined)
  return available
}

/** Same `{error}`-extraction discipline as `onboarding-api.ts#errorMessageFrom` / `teams-api.ts`'s
 *  own copy of it, inlined here rather than imported: this is the only caller in this file that
 *  needs it, so a shared cross-file helper would be one more import for one call site, not less
 *  duplication — unlike `isJsonResponse` above, which two other probes in this file's neighbourhood
 *  already read the identical way. Falls back to the raw body text (never silently swallowed) when
 *  it isn't JSON, or has no `.error` string — a proxy's HTML error page is as untrusted as any other
 *  input. */
function errorMessageFrom(status: number, statusText: string, text: string): string {
  try {
    const body = JSON.parse(text) as unknown
    if (body && typeof body === 'object' && 'error' in body) {
      const error = (body as { error?: unknown }).error
      if (typeof error === 'string') return error
    }
  } catch {
    // Not JSON — fall through to the raw text / generic message below.
  }
  return text || `${status} ${statusText || 'sign-out failed'}`.trim()
}

/** `POST /auth/logout` — server-side session invalidation plus the cookie clear
 *  (`auth/routes.ts`). No response payload read on success: a non-2xx is the only thing this
 *  caller needs to distinguish. */
export async function logout(signal?: AbortSignal): Promise<void> {
  let res: Response
  try {
    res = await fetch(authUrl('/auth/logout'), {
      method: 'POST',
      credentials: 'include',
      signal,
      ...NO_REDIRECT,
    })
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause
    throw new ApiError(0, 'cannot reach the cezar server (/auth/logout)', { cause })
  }
  throwIfIdentityGate(res, '/auth/logout')
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new ApiError(res.status, errorMessageFrom(res.status, res.statusText, text))
  }
  await res.text().catch(() => undefined)
}
