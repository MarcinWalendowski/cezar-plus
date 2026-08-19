import { ApiError } from '@/api/client'

/**
 * "This answer means I have no session" — and what to do about it.
 *
 * Spec: `.ai/specs/2026-08-19-signed-out-cockpit-reauth.md`. Two very different answers mean the
 * same thing to a user, and before this module the cockpit understood neither:
 *
 * - **cezar's own `401`.** `server.ts`'s `requirePrincipal` refuses every `/api/*` route without
 *   a session. The shell is static and unguarded, so the cockpit rendered in full with every
 *   query failing — a page that looks signed in and shows nothing.
 * - **An identity gate's cross-origin redirect.** `cockpit.example.com` sits behind a
 *   Cloudflare Access app that answers `302 → https://<team>.cloudflareaccess.com/…` for every
 *   path once the cookie is gone. `fetch` follows redirects by default, CORS rejects the
 *   off-origin response, and the `TypeError` became `ApiError(0, 'cannot reach the cezar
 *   server')` — the app blaming a server that was answering fine. `client.ts#fetchOrThrow` now
 *   asks for `redirect: 'manual'` so that bounce arrives as a fact (`identityGate`) instead of
 *   as a network failure.
 *
 * **The action is a document navigation, never a router push.** `/auth/login` 302s to the IdP,
 * and an edge gate can only act on a top-level navigation — the same discipline
 * `onboarding.tsx#SignInStep`'s `<a href>` and `account-panel.tsx`'s post-logout
 * `window.location.assign('/')` already apply. A client-side route change would leave the tab
 * exactly where it is.
 *
 * **Auto-redirect with no click is the owner's explicit choice** (2026-08-19, asked directly:
 * "I should be always enforced to relogin there"), made with the loop risk named — an IdP that
 * returns without minting a session would bounce `/ → /auth/login → / → …` forever. The guard
 * below bounds that without adding a click to the normal path.
 */

/** How long one auto-redirect suppresses the next. Long enough to cover a full IdP round trip
 *  (Access OTP + cezar's own OIDC callback), short enough that a user who really did just sign
 *  out and back in is never stuck looking at the button. */
const REAUTH_WINDOW_MS = 30_000

/** `sessionStorage`, not `localStorage`, and deliberately so: the guard must not outlive the tab,
 *  and clearing site data — the exact action that produced the bug report — wipes it, which is
 *  the right answer. That clear IS a first redirect, not a repeat of one. */
const REAUTH_STAMP_KEY = 'cezar:reauth-at'

/**
 * Whether this failure means "you have no session", as opposed to any other way a request can
 * fail.
 *
 * Deliberately narrow. A `403` is the server saying *you may not do this* — a real answer to an
 * authenticated caller, and redirecting it to sign in would loop them through an IdP that
 * cannot help. A `500`, a `404`, an offline `ApiError(0)` without `identityGate`, and a plain
 * `Error` are all failures the cockpit already reports honestly.
 *
 * **This cannot fire on the npm zero-config default**, which is what makes it safe to wire
 * globally: with `CEZ_AUTH` unset, `/api/*` resolves an implicit local principal and never 401s
 * (`server.ts`'s principal middleware), and the hand-rolled `/auth/*` probes turn their own 401
 * into a `signed-out` *result* rather than a thrown error. There is no local-mode path that
 * produces either input to this predicate.
 */
export function isSignedOutError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false
  return error.status === 401 || error.identityGate === true
}

/** Whether the one-shot guard is currently holding a redirect back — i.e. we already sent this
 *  tab to `/auth/login` within the window and it came back still signed out. The sign-in screen
 *  reads this to decide whether it is a waypoint (redirecting) or a destination (show the
 *  button), so a broken IdP produces a legible screen instead of a spinning browser. */
export function reauthSuppressed(): boolean {
  return withinWindow(readStamp())
}

/**
 * Send this tab to sign in.
 *
 * Idempotent within the window by construction: the first call stamps and navigates, and any
 * further call — from another failing query in the same batch, or from the sign-in screen after
 * the IdP handed us back with no session — returns without touching `location`. That is both the
 * loop guard and the reason a page full of queries all 401ing at once produces one navigation
 * rather than a dozen.
 */
export function forceReauth(): void {
  if (typeof window === 'undefined') return
  if (withinWindow(readStamp())) return
  writeStamp(Date.now())
  window.location.assign('/auth/login')
}

/** Test seam only: drop the stamp so a case starts from "never redirected". Not called by the
 *  app — a successful sign-in lands on a fresh document, and a fresh tab has no stamp. */
export function resetReauthGuard(): void {
  try {
    window.sessionStorage?.removeItem(REAUTH_STAMP_KEY)
  } catch {
    // Storage disabled (Safari private mode, a locked-down profile). Nothing to reset.
  }
}

/** Expires rather than latching. A stamp older than the window is as good as none — otherwise a
 *  single transient blip would strand the tab on the button for as long as it stayed open. */
function withinWindow(stamp: number | null): boolean {
  if (stamp === null) return false
  const age = Date.now() - stamp
  // A stamp from the future is a clock that moved (sleep/resume, NTP correction), not a recent
  // redirect. Treat it as expired: erring toward navigating keeps the owner's zero-click path.
  return age >= 0 && age < REAUTH_WINDOW_MS
}

/** Storage can throw (disabled cookies, private mode) or hold junk a previous version wrote.
 *  Either way the honest answer is "no stamp", which costs one redirect, never a wrong one. */
function readStamp(): number | null {
  try {
    const raw = window.sessionStorage?.getItem(REAUTH_STAMP_KEY)
    if (raw === null || raw === undefined) return null
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) ? parsed : null
  } catch {
    return null
  }
}

function writeStamp(at: number): void {
  try {
    window.sessionStorage?.setItem(REAUTH_STAMP_KEY, String(at))
  } catch {
    // Storage disabled: the redirect still happens, it just is not guarded. A tab that cannot
    // remember is no worse off than one that never stamped — and refusing to navigate here
    // would trade the owner's chosen behaviour for a guard that has nowhere to live.
  }
}
