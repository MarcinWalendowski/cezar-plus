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
 * The states that gate: `needs-org`, (D15) `ready` while the org owns NO project yet, and
 * (2026-08-19) `signed-out`.
 *
 * **WIDENED 2026-08-19 to include `signed-out`** — spec
 * `.ai/specs/2026-08-19-signed-out-cockpit-reauth.md`, from an owner report against
 * a hosted deployment: *"if I clear application/website data I'm still in cezar, but I can't see
 * any tasks, git, etc. I should be always enforced to relogin there."*
 *
 * Not gating it meant an unauthenticated visitor got the **whole cockpit** — sidebar, nav,
 * command palette, every tab — with every `/api/*` query 401ing behind it. A page that looks
 * signed in and shows nothing, with no way to sign in anywhere on it. (The shell itself is
 * static and unguarded: `GET /` answers `200 text/html` with no session, verified on the
 * production box.)
 *
 * **Why `signed-out` is not like the two states below it.** D15 excluded all three in one
 * sentence — *"neither may `signed-out` or `needs-invite`"* — but argued only `unavailable`,
 * whose hazard is real and specific: gating it would brick the hosted + `CEZ_AUTH` unset +
 * `CEZ_ALLOW_UNAUTHENTICATED=1` topology behind a wizard that deployment can never satisfy.
 * `signed-out` carries no such hazard, and the boot wiring is the proof. It requires
 * `/auth/onboarding` to answer a JSON **401**, which `src/index.ts` produces from exactly one of
 * its three branches — the `oidc`/`google` one, which sets `authRoutes` and `onboardingRoutes`
 * **together**. Local mode never 401s (D13 invariant 1, "no 401 in local mode, ever"); the
 * supervisor and hosted-unauthenticated branches mount no `/auth/*` at all and probe as
 * `unavailable`. So `signed-out` *implies* `/auth/login` is mounted: the gate it raises is
 * always satisfiable, which is the whole thing `unavailable` was excluded for lacking.
 *
 * `unavailable` and `needs-invite` still never gate, unchanged. `needs-invite` for the reason
 * D14 gave (that user HAS a session — an authorized-but-membership-less cockpit is a different
 * problem, and D8's invite-redemption screen is still unbuilt).
 *
 * **WIDENED 2026-08-07 by D15 — was `needs-org` alone.** D14 gated on the first organization, and
 * that turned out to be half a gate: after naming an org and accepting a workspace, a first-run
 * user landed in a cockpit already showing a project, its commit history and its branch, none of
 * which they had added ("I didn't add any project — why do I see data in commits and git tab?").
 * Onboarding is not complete until the org owns at least one project, so the surface stays gated
 * through the wizard's project step, not only its org step.
 *
 * ~~`unavailable`, `signed-out` and `needs-invite` must STILL never gate~~ **— corrected
 * 2026-08-19 for `signed-out`, which now gates (see the block above for why it never belonged in
 * this list).** The rest stands, for exactly the reasons D14 gave and D15's widening does not
 * touch: `unavailable` because that deployment (hosted + `CEZ_AUTH` unset +
 * `CEZ_ALLOW_UNAUTHENTICATED=1`, which mounts no `/auth/*` at all) can never satisfy the wizard
 * it would be bricked behind, and `needs-invite` because the probe already answered something
 * more specific than "this org has no project". `undefined` (still loading, or the query
 * errored) also reads as false: a slow or failed probe must not strand a returning user behind a
 * blank gate on every page load.
 *
 * The `ready` arm reads `hasProjects`, which `auth/onboarding-routes.ts` computes as
 * `listProjectTeams({ orgId }).length > 0` — projects **adopted into the org**, never "the
 * machine-wide registry is non-empty". D15 names that distinction load-bearing: the registry
 * predates the org and is shared across every org on the machine, so a registry read would let a
 * project belonging to nobody satisfy an org-scoped requirement.
 */
export function needsOnboardingGate(probe: OnboardingProbe | undefined): boolean {
  if (probe === undefined) return false
  if (probe.kind === 'signed-out') return true
  if (probe.kind === 'needs-org') return true
  return probe.kind === 'ready' && !probe.hasProjects
}
