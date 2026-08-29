import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LiveDuration } from '@/components/live-duration'

// spec 2026-08-29-step-retry-timing, Verification 2a — `LiveDuration` had no direct test before
// this file; a prop added without one is how the clock-skew defect below would have shipped
// unnoticed.

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-29T12:00:10.000Z'))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('LiveDuration offsetMs (spec 2026-08-29-step-retry-timing)', () => {
  it('with no offsetMs, renders byte-identical text to today — the default must not move an existing caller', () => {
    render(<LiveDuration since="2026-08-29T12:00:00.000Z" />)
    expect(screen.getByText('0:10')).not.toBeNull()
  })

  it('offsetMs 900_000 with since 10s ago renders 15:10, not 0:10', () => {
    render(<LiveDuration since="2026-08-29T12:00:00.000Z" offsetMs={900_000} />)
    expect(screen.getByText('15:10')).not.toBeNull()
  })

  it('the clock-skew case: since in the future with offsetMs renders the banked duration, unreduced', () => {
    // A browser clock behind the server's: `since` is 10s in the future relative to `now`.
    render(<LiveDuration since="2026-08-29T12:00:20.000Z" offsetMs={900_000} />)
    // Under `offsetMs + (now - start)` this would render less than 15:00 — a cumulative total
    // that shrinks as it ticks. The clamp must keep it pinned at the banked duration.
    expect(screen.getByText('15:00')).not.toBeNull()
  })

  it('an absent since still renders nothing, even with a non-zero offsetMs', () => {
    const { container } = render(<LiveDuration since={undefined} offsetMs={900_000} />)
    expect(container.innerHTML).toBe('')
  })

  it('an unparseable since still renders nothing, even with a non-zero offsetMs', () => {
    const { container } = render(<LiveDuration since="not-a-date" offsetMs={900_000} />)
    expect(container.innerHTML).toBe('')
  })
})
