import { useQuery } from '@tanstack/react-query'

import type { OnboardingProbe } from './onboarding-api'

/**
 * D14 (`.ai/specs/2026-08-06-org-team-auth-onboarding.md`) — the cockpit is gated on onboarding:
 * **no dashboard element renders before the first organization exists.** Until the probe answers
 * something other than `needs-org`, the onboarding wizard is the entire surface.
 *
 * This REVERSES D13's own repair-round-3 "decline" behaviour (`onboarding-decline.ts`, the
 * wizard's "Not now" button, and the Settings → Workspaces re-entry link) — those existed only to
 * make declining reversible, and the owner has decided the opposite: there is nothing to decline.
 *
 * One shared probe, read by BOTH halves of the gate:
 * - `routes.tsx#OnboardingEntryGate` navigates to `/onboarding` the moment it answers `needs-org`.
 * - `app-shell-container.tsx#AppShellContainer` suppresses the sidebar/nav/banner/command palette
 *   for exactly that same instant (`AppShell`'s `chromeless` prop).
 *
 * **Keyed on the PROBE's answer, never on a flag or `CEZ_AUTH` — D14's own text.** In particular,
 * the query below is unconditionally enabled, unlike the pre-D14 entry gate's own
 * `enabled: localHandoff` (an optimisation that assumed only the npm zero-config default needed
 * it). A hosted, authenticated deployment with no org yet must gate exactly the same way the local
 * default does — D14 does not name an exception for it, and the one topology that MUST NOT gate
 * (hosted, `CEZ_AUTH` unset, `CEZ_ALLOW_UNAUTHENTICATED=1` — no `/auth/*` mounted at all) is
 * excluded by the probe's own answer (`unavailable`), not by disabling the query.
 *
 * `['onboarding','entry-probe']` shares its `'onboarding'` prefix with `onboarding.tsx#
 * OnboardingRoute`'s own `['onboarding','status']` probe on purpose: that route's success
 * handlers already evict every `['onboarding', ...]`-keyed query the instant an org is created
 * (`removeQueries({queryKey:['onboarding']})`), so this gate's next read sees the eviction too —
 * chrome reappears once the org exists, with no separate wiring. The wizard's own step state
 * (`OnboardingRoute`'s local `wizard`) does not depend on this query at all past its first read, so
 * a live re-read here never resets wizard progress.
 */
export const ONBOARDING_ENTRY_PROBE_KEY = ['onboarding', 'entry-probe'] as const

export function useOnboardingEntryProbe() {
  return useQuery({
    queryKey: ONBOARDING_ENTRY_PROBE_KEY,
    queryFn: async ({ signal }) => {
      const { probeOnboarding } = await import('./onboarding-api')
      return probeOnboarding(signal)
    },
  })
}

/**
 * The ONE state that gates: `needs-org`. `unavailable`, `signed-out`, `needs-invite` and `ready`
 * must never gate — `unavailable` because that deployment can never satisfy the wizard it would be
 * bricked behind (D1's table), the other three because the probe already answered something more
 * specific than "no org exists for anyone to create". `undefined` (still loading, or the query
 * errored) also reads as false: a slow or failed probe must not strand a returning user behind a
 * blank gate on every page load.
 */
export function needsOrgGate(probe: OnboardingProbe | undefined): boolean {
  return probe?.kind === 'needs-org'
}
