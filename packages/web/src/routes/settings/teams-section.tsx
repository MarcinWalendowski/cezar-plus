import { Suspense, lazy } from 'react'

/**
 * Global settings → Teams (D2/D12, spec `.ai/specs/2026-08-06-org-team-auth-onboarding.md`,
 * Phase 5c "team management: create/rename"). Registered in `registry.tsx` under `SETTINGS_SECTIONS`
 * like every other global section — there is no runtime-conditional nav item in this codebase
 * (`registry.tsx`'s `capability` gate only ever reads `useHealth()`'s capabilities, and D1's Risks
 * section already forbids adding an `auth` one — see `packages/contract/src/health.ts`'s own doc
 * comment on `authProviderSchema`).
 *
 * **CORRECTED 2026-08-07 (5b/5c/8 repair stage): this used to claim the section is "invisible and
 * inert with `CEZ_AUTH` unset ... delivered the same way `/onboarding` delivers it". Half of that
 * is false, and it is the half a reader would act on.** The analogy does not hold: `/onboarding`
 * has NO nav entry, so nothing renders there unless the URL is typed. Teams has one, and
 * `visibleSettingsSections` has exactly three gates (`hidden`, `scope`, `capability`) — none of
 * which can express "auth is on", by the deliberate design cited above. So on the zero-config npm
 * default a user sees a **Teams** item in global settings, labelled "Create and rename the teams
 * your projects are grouped under", for a feature that deployment can never have. Only the PANE is
 * inert.
 *
 * That is an accepted, named deviation rather than an oversight, and the alternative was worse:
 * the only signal available is a client-side probe, and gating the nav on one would either add a
 * fetch to the auth-off default (the cost this section is trying to avoid) or make the item appear
 * a frame late on every deployment that does have auth. Adding a `capabilities.auth` key is the one
 * move the spec's Risks section explicitly forbids — `capabilities.test.ts` fails if it is
 * re-added, on purpose. Recorded in the spec's Risks section and in CHANGELOG.md so it is a
 * decision a future session can revisit rather than a surprise it rediscovers.
 *
 * What IS inert is the pane: the ONE request `teams-panel.tsx` makes on mount (`GET /auth/teams`)
 * IS the probe, and a non-JSON answer (the SPA catch-all, when `/auth/*` was never registered)
 * renders a quiet, static explainer and issues no further request — `teams-section.test.tsx`'s
 * `describe('CEZ_AUTH unset — the surface is inert')` is the negative control for that half.
 *
 * **This file itself stays a plain, synchronous component — deliberately NOT the direct target of
 * `lazy()` at the registry level.** `SettingsSectionRoute` (`settings-shell.tsx`) renders every
 * section's `component` with no `Suspense` boundary of its own, so a `lazy()` component registered
 * there directly would suspend with nothing to catch it. This file supplies its OWN `Suspense`
 * around the actual heavy pane (`TeamsPanel` — the list/create/rename UI plus `teams-api.ts`),
 * which is what keeps that code, and its dynamic `import()`, out of the chunk `registry.tsx` (and
 * therefore the zero-config entry bundle) pays for. Phase 4's onboarding wizard shipped as a static
 * import and added 6.90 kB (2.02 kB gz) to that chunk for a page whose auth-off render is one
 * sentence — this section's own Risks-section citation for that regression is exactly why this file
 * exists rather than a plain `export { TeamsPanel as TeamsSection }`.
 */
const TeamsPanel = lazy(() => import('./teams-panel').then((m) => ({ default: m.TeamsPanel })))

export function TeamsSection() {
  return (
    <Suspense
      fallback={
        <p data-slot="teams-loading" className="p-4 text-[13px] text-soft-foreground md:p-6">
          Loading…
        </p>
      }
    >
      <TeamsPanel />
    </Suspense>
  )
}
