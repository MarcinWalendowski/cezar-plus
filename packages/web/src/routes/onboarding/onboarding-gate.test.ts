import { describe, expect, it } from 'vitest'

import type { OnboardingProbe } from './onboarding-api'
import { needsOnboardingGate } from './onboarding-gate'

/**
 * `.ai/specs/2026-08-19-signed-out-cockpit-reauth.md`, test 1 — and the whole `OnboardingProbe`
 * union enumerated, because every state this predicate does NOT gate is load-bearing for a
 * different reason and each has its own way of being wrong.
 *
 * The union is spelled out row by row rather than tested through the shell, so that adding a
 * sixth `kind` fails the exhaustiveness check below instead of quietly defaulting to "does not
 * gate" — which is exactly how `signed-out` came to serve an entire cockpit to a signed-out
 * visitor for twelve days.
 */

const ORG = { id: 'org-1', name: 'Acme', slug: 'acme', createdAt: '2026-08-07T00:00:00.000Z' }
const TEAM = { id: 'team-1', orgId: 'org-1', name: 'General', slug: 'general' }

const READY = (hasProjects: boolean): OnboardingProbe => ({
  kind: 'ready',
  org: ORG,
  team: TEAM,
  role: 'owner',
  hasProjects,
})

describe('needsOnboardingGate', () => {
  /**
   * The 2026-08-19 fix. `signed-out` means `/auth/onboarding` answered a JSON 401, which only the
   * `oidc`/`google` boot branch produces — and that branch always mounts `/auth/login` too. So
   * the gate is always satisfiable here, unlike `unavailable` below.
   */
  it('gates on signed-out — the cockpit must not render to a caller with no session', () => {
    expect(needsOnboardingGate({ kind: 'signed-out' })).toBe(true)
  })

  it('gates on needs-org (D14)', () => {
    expect(needsOnboardingGate({ kind: 'needs-org', bootstrapTokenRequired: false })).toBe(true)
  })

  it('gates on ready with no project yet (D15)', () => {
    expect(needsOnboardingGate(READY(false))).toBe(true)
  })

  /**
   * THE constraint D14 spells out explicitly and D15 restates: hosted + `CEZ_AUTH` unset +
   * `CEZ_ALLOW_UNAUTHENTICATED=1` mounts no `/auth/*` at all, so `/auth/onboarding` falls through
   * to the SPA catch-all and probes as `unavailable`. Gating it would brick that deployment
   * behind a wizard it can never satisfy — the hazard `signed-out` was wrongly lumped in with,
   * and does not share.
   */
  it('never gates on unavailable — bricking that topology is the failure mode', () => {
    expect(needsOnboardingGate({ kind: 'unavailable' })).toBe(false)
  })

  /** Still does not gate, unchanged by the 2026-08-19 widening: that user HAS a session, so the
   *  wizard has nothing to offer them (D8's invite-redemption screen is unbuilt). */
  it('never gates on needs-invite', () => {
    expect(needsOnboardingGate({ kind: 'needs-invite' })).toBe(false)
  })

  it('does not gate on a finished onboarding', () => {
    expect(needsOnboardingGate(READY(true))).toBe(false)
  })

  /** A slow or failed probe must not strand a returning user behind a blank gate on every page
   *  load — `undefined` covers both "still loading" and "the query errored". */
  it('does not gate while the probe has not answered', () => {
    expect(needsOnboardingGate(undefined)).toBe(false)
  })

  /**
   * Exhaustiveness, asserted rather than assumed. `PROBE_KINDS` is typed as every `kind` in the
   * union, so adding a sixth state to `OnboardingProbe` without deciding whether it gates is a
   * TYPE error here — the failure mode that produced this spec was precisely a state nobody
   * decided about being carried along by a default.
   */
  it('covers every probe kind', () => {
    const PROBE_KINDS: Record<OnboardingProbe['kind'], boolean> = {
      'signed-out': true,
      'needs-org': true,
      unavailable: false,
      'needs-invite': false,
      ready: true, // gates while `hasProjects` is false — both arms tested above
    }
    expect(Object.keys(PROBE_KINDS)).toHaveLength(5)
  })
})
