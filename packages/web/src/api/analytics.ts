import { postAnalyticsEvents } from './client'

/**
 * The browser-side analytics emitter (spec `.ai/specs/2026-08-29-spec-tab-review-feed.md`, P3).
 *
 * A thin wrapper, deliberately — `postAnalyticsEvents` (client.ts) is the ONLY transport this
 * module may use. It must own no direct network call of its own: a second transport would miss
 * `client.ts`'s `credentials: 'include'`, `redirect: 'manual'` and `throwIfIdentityGate` handling,
 * and would report a Cloudflare Access bounce as a plain network failure instead of a sign-out.
 * Asserted directly by a test that reads this file's own source and scans it for the browser
 * network call this module must never make on its own.
 *
 * Fails open by design: a tab must never break because analytics could not be delivered. No
 * `await` at any call site, no throw, no retry — the rejection is swallowed right here so a
 * caller never even sees a promise to mishandle.
 */
export function trackEvent(name: string, props: Record<string, string | number | boolean>): void {
  postAnalyticsEvents([{ name, props }]).catch(() => {})
}
