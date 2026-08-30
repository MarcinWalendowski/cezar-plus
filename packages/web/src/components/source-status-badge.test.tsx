import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { SourceStatusBadge } from './source-status-badge'
import type { SourceSyncState } from '@loki-labs/cezar-plus-api-client'

// Explicit rather than relying on RTL's auto-cleanup, which only runs when vitest `globals` is on.
afterEach(cleanup)

function badgeOf(ui: React.ReactElement) {
  const { container } = render(ui)
  const badge = container.querySelector('[data-slot="source-status-badge"]')
  if (!badge) throw new Error('SourceStatusBadge did not render')
  return badge
}

const ALL_STATES: readonly SourceSyncState[] = [
  'never-synced',
  'ok',
  'stale',
  'error',
  'unavailable',
  'paused',
]

describe('SourceStatusBadge', () => {
  it('stamps data-sync-state with the exact value it was given', () => {
    for (const state of ALL_STATES) {
      const badge = badgeOf(<SourceStatusBadge syncState={state} />)
      expect(badge.getAttribute('data-sync-state')).toBe(state)
    }
  })

  // Spec: "never-synced, stale, error, unavailable and paused each render distinctly; a generic
  // grey pill for all five is how a revoked token gets mistaken for an idle connection." Every
  // one of the six states — including `ok` — must be tellable apart from every other by its
  // rendered label text, which is what a screen reader and a skim both actually see.
  it('renders every syncState with a distinct label', () => {
    const labels = ALL_STATES.map((state) => badgeOf(<SourceStatusBadge syncState={state} />).textContent)
    expect(new Set(labels).size).toBe(ALL_STATES.length)
  })

  it.each([
    { state: 'never-synced', tone: 'neutral' },
    { state: 'ok', tone: 'success' },
    { state: 'stale', tone: 'pending' },
    { state: 'error', tone: 'danger' },
    { state: 'unavailable', tone: 'violet' },
    { state: 'paused', tone: 'neutral' },
  ] as const satisfies readonly { state: SourceSyncState; tone: string }[])(
    '$state carries a $tone status dot',
    ({ state, tone }) => {
      const badge = badgeOf(<SourceStatusBadge syncState={state} />)
      const dot = badge.querySelector('[data-slot="status-dot"]')
      expect(dot?.getAttribute('data-tone')).toBe(tone)
    },
  )

  // The revoked-token case named directly in the spec: `unavailable` plus its reason must never
  // collapse into a badge indistinguishable from an ordinary idle connection.
  it('shows the unavailable reason string verbatim in the DOM, not only in a title attribute', () => {
    const badge = badgeOf(
      <SourceStatusBadge syncState="unavailable" reason="401 Unauthorized: token was revoked" />,
    )
    const reasonNode = badge.querySelector('[data-slot="source-status-reason"]')
    expect(reasonNode).not.toBeNull()
    expect(reasonNode?.textContent).toContain('401 Unauthorized: token was revoked')
    // Present as real text content, not merely as a hover-only title — grep-able and
    // screen-reader visible without a pointer.
    expect(badge.textContent).toContain('401 Unauthorized: token was revoked')
  })

  it('renders no reason node when none is given', () => {
    const badge = badgeOf(<SourceStatusBadge syncState="ok" />)
    expect(badge.querySelector('[data-slot="source-status-reason"]')).toBeNull()
  })

  it('an error reason (the sweep\'s own lastErrorMessage) is shown the same way', () => {
    const badge = badgeOf(<SourceStatusBadge syncState="error" reason="429: rate limited" />)
    expect(badge.querySelector('[data-slot="source-status-reason"]')?.textContent).toContain(
      '429: rate limited',
    )
  })
})
