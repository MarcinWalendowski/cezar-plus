import { Suspense, lazy } from 'react'

/**
 * Global settings → Account (D14, spec `.ai/specs/2026-08-06-org-team-auth-onboarding.md`).
 * `POST /auth/logout` has existed since phase 3 with no caller anywhere in the cockpit — there was
 * no way to sign out of a cezar deployment from its own UI. Registered in `registry.tsx` under
 * `SETTINGS_SECTIONS` like every other global section, unconditionally: `visibleSettingsSections`'s
 * three gates (`hidden`, `scope`, `capability`) are all synchronous, decided from `useHealth()`'s
 * capabilities at render time, and `capabilitiesSchema` deliberately carries no `auth` key (D1's
 * Risks section; `capabilities.test.ts:213` enforces the absence) — so there is no synchronous
 * signal this registry entry could gate on even if it wanted to.
 *
 * **Visibility instead lives in the PANEL, as an async probe — `account-panel.tsx`'s own doc
 * comment has the mechanism.** In local mode `authRoutes` (login/callback/logout/me) stay
 * unmounted (D13: "there is nothing to log into and no second user to invite"), so the panel
 * renders nothing there — the section reads as absent even though its nav entry and route exist,
 * the same shape `teams-section.tsx` already accepted for the identical reason (see that file's
 * own doc comment on why a capability flag would be the wrong tool here). The alternative — a
 * synchronous nav-level gate — does not exist without the `auth` capability key D1's Risks section
 * forbids.
 *
 * **This file itself stays a plain, synchronous component — deliberately NOT the direct target of
 * `lazy()` at the registry level**, the same reasoning `teams-section.tsx` gives for its own
 * identical shape: `SettingsSectionRoute` renders every section's `component` with no `Suspense`
 * boundary of its own, so a `lazy()` component registered there directly would suspend with
 * nothing to catch it.
 */
const AccountPanel = lazy(() => import('./account-panel').then((m) => ({ default: m.AccountPanel })))

export function AccountSection() {
  return (
    <Suspense
      fallback={
        <p data-slot="account-loading" className="p-4 text-[13px] text-soft-foreground md:p-6">
          Loading…
        </p>
      }
    >
      <AccountPanel />
    </Suspense>
  )
}
