import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { TransportHealth as TransportHealthValue } from '@loki-labs/better-cezar-api-client'
import { TransportHealth } from './transport-health'

/**
 * `transport-health.tsx` (W4.9): a pure, prop-driven render of one transport's stored health.
 * No fetch, no clock — every case below feeds a plain `TransportHealth` object and asserts what
 * lands in the DOM, matching the leaf-component discipline the rest of this wave's cockpit
 * pieces already follow (`routes/knowledge/document.tsx`, `editor.tsx`).
 */

const COUNTERS = { sent: 0, failed: 0, dropped: 0, suppressed: 0, leaseReclaimed: 0, requeued: 0 }

function health(overrides: Partial<TransportHealthValue> = {}): TransportHealthValue {
  return { status: 'ok', consecutiveFailures: 0, counters: COUNTERS, ...overrides }
}

afterEach(() => cleanup())

describe('TransportHealth', () => {
  it('renders the ok chip with no error line', () => {
    render(<TransportHealth health={health({ status: 'ok' })} />)
    expect(screen.getByText('Delivering')).toBeTruthy()
    expect(document.querySelector('[data-slot="transport-health-error"]')).toBeNull()
  })

  it('renders degraded with the stored lastError and its stored timestamp, verbatim', () => {
    render(
      <TransportHealth
        health={health({
          status: 'degraded',
          consecutiveFailures: 5,
          lastError: '503 Service Unavailable',
          lastAttemptAt: '2026-08-06T02:14:00.000Z',
        })}
      />,
    )
    expect(screen.getByText('Degraded')).toBeTruthy()
    expect(screen.getByText('5 consecutive failures', { exact: false })).toBeTruthy()
    const error = document.querySelector('[data-slot="transport-health-error"]')
    expect(error?.textContent).toContain('503 Service Unavailable')
    expect(error?.textContent).toContain('2026-08-06T02:14:00.000Z')
  })

  it('renders unconfigured and disabled with distinct labels', () => {
    const { unmount } = render(<TransportHealth health={health({ status: 'unconfigured' })} />)
    expect(screen.getByText('Not configured')).toBeTruthy()
    unmount()

    render(<TransportHealth health={health({ status: 'disabled' })} />)
    expect(screen.getByText('Disabled')).toBeTruthy()
  })

  it('a single consecutive failure is singular, not plural', () => {
    render(<TransportHealth health={health({ status: 'degraded', consecutiveFailures: 1 })} />)
    expect(screen.getByText('1 consecutive failure', { exact: false })).toBeTruthy()
  })

  it('the counters line reports sent/failed always, and dropped/suppressed only when non-zero', () => {
    render(<TransportHealth health={health({ counters: { ...COUNTERS, sent: 12, failed: 2 } })} />)
    const counters = document.querySelector('[data-slot="transport-health-counters"]')
    expect(counters?.textContent).toContain('12 sent')
    expect(counters?.textContent).toContain('2 failed')
    expect(counters?.textContent).not.toContain('dropped')
    expect(counters?.textContent).not.toContain('suppressed')
  })

  it('dropped and suppressed counts appear once they are non-zero', () => {
    render(
      <TransportHealth
        health={health({ counters: { ...COUNTERS, sent: 12, failed: 2, dropped: 3, suppressed: 1 } })}
      />,
    )
    const counters = document.querySelector('[data-slot="transport-health-counters"]')
    expect(counters?.textContent).toContain('3 dropped')
    expect(counters?.textContent).toContain('1 suppressed')
  })

  it('renders the stored lastSuccessAt verbatim when present', () => {
    render(<TransportHealth health={health({ lastSuccessAt: '2026-08-01T09:00:00.000Z' })} />)
    expect(
      document.querySelector('[data-slot="transport-health-counters"]')?.textContent,
    ).toContain('2026-08-01T09:00:00.000Z')
  })

  it('rendering the same health object twice produces byte-identical output (no clock derivation)', () => {
    const snapshot = health({
      status: 'degraded',
      consecutiveFailures: 2,
      lastError: 'timeout',
      lastAttemptAt: '2026-08-06T00:00:00.000Z',
    })
    const first = render(<TransportHealth health={snapshot} />)
    const firstHtml = first.container.innerHTML
    cleanup()
    const second = render(<TransportHealth health={snapshot} />)
    expect(second.container.innerHTML).toBe(firstHtml)
  })

  it('exposes the status on data-status for styling/testing hooks', () => {
    render(<TransportHealth health={health({ status: 'degraded' })} />)
    expect(document.querySelector('[data-slot="transport-health"]')?.getAttribute('data-status')).toBe(
      'degraded',
    )
  })
})
