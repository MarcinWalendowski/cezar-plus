import { Suspense, lazy } from 'react'

/**
 * Global settings → Workspaces (UI label; D2/D12, spec
 * `.ai/specs/2026-08-06-org-team-auth-onboarding.md`, Phase 5c "team management: create/rename";
 * D13 phase 9 local mode). Registered in `registry.tsx` under `SETTINGS_SECTIONS` like every other
 * global section — there is no runtime-conditional nav item in this codebase (`registry.tsx`'s
 * `capability` gate only ever reads `useHealth()`'s capabilities, and D1's Risks section already
 * forbids adding an `auth` one — see `packages/contract/src/health.ts`'s own doc comment on
 * `authProviderSchema`). `id`/`component` stay `teams`/`TeamsSection` — D13's "rename no
 * identifier" rule; only the nav title and this pane's copy say "Workspace".
 *
 * **CORRECTED 2026-08-07 (D13 cockpit pass): the two paragraphs below described the zero-config
 * npm default as a deployment that "can never have" this feature. D13 changes exactly that
 * premise, for exactly that deployment.** With `CEZ_AUTH` unset AND a loopback bind
 * (`capabilities.localHandoff`, the npm default), the server now mounts a real, local `/auth/teams`
 * surface (`src/index.ts`'s D13 branch) once the user has onboarded — so `teams-panel.tsx`'s ONE
 * request on mount gets a real answer (a genuine, possibly-empty team list, or the local `no
 * organization exists yet` 400 before onboarding) instead of the SPA shell. The pane is NO LONGER
 * inert on that topology; it is exactly as functional as an authenticated deployment's. What the
 * two paragraphs below still correctly describe is narrower now: a **hosted, unauthenticated**
 * deployment (`CEZ_ALLOW_UNAUTHENTICATED=1`, D9) still mounts nothing under `/auth/*` at all, so
 * that one topology still shows this nav item for a feature it genuinely cannot have — see
 * `onboarding-api.ts`'s own module doc comment for the identical, now-narrower story on
 * `/onboarding`. Read everything below as describing THAT topology, not "the zero-config default."
 *
 * **CORRECTED 2026-08-07 (5b/5c/8 repair stage): this used to claim the section is "invisible and
 * inert with `CEZ_AUTH` unset ... delivered the same way `/onboarding` delivers it". Half of that
 * is false, and it is the half a reader would act on.** The analogy does not hold: `/onboarding`
 * has NO nav entry, so nothing renders there unless the URL is typed. Teams has one, and
 * `visibleSettingsSections` has exactly three gates (`hidden`, `scope`, `capability`) — none of
 * which can express "auth is on", by the deliberate design cited above. So on that one remaining
 * inert topology a user still sees a **Workspaces** item in global settings for a feature that
 * deployment can never have. Only the PANE is inert there.
 *
 * That is an accepted, named deviation rather than an oversight, and the alternative was worse:
 * the only signal available is a client-side probe, and gating the nav on one would either add a
 * fetch to the auth-off default (the cost this section is trying to avoid) or make the item appear
 * a frame late on every deployment that does have auth. Adding a `capabilities.auth` key is the one
 * move the spec's Risks section explicitly forbids — `capabilities.test.ts` fails if it is
 * re-added, on purpose. Recorded in the spec's Risks section and in CHANGELOG.md so it is a
 * decision a future session can revisit rather than a surprise it rediscovers.
 *
 * What IS inert (on that one remaining topology) is the pane: the ONE request `teams-panel.tsx`
 * makes on mount (`GET /auth/teams`) IS the probe, and a non-JSON answer (the SPA catch-all, when
 * `/auth/*` was never registered) renders a quiet, static explainer and issues no further request
 * — `teams-section.test.tsx`'s own describe block for that case is the negative control.
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
