import { describe, expect, it } from 'vitest'

import { compactTokens, formatDuration, formatToolDuration, shortAge } from '@/lib/format'

describe('shortAge', () => {
  const now = Date.parse('2026-07-14T12:00:00.000Z')
  const ago = (ms: number) => new Date(now - ms).toISOString()

  it.each([
    [0, '0s'],
    [4_000, '4s'],
    [59_999, '59s'],
    [60_000, '1m'],
    [26 * 60_000, '26m'],
    [3_599_000, '59m'],
    [3_600_000, '1h'],
    [2 * 3_600_000, '2h'],
    [86_399_000, '23h'],
    [86_400_000, '1d'],
    [3 * 86_400_000, '3d'],
    [400 * 86_400_000, '400d'],
  ])('%d ms ago → %s', (ms, expected) => {
    expect(shortAge(ago(ms), now)).toBe(expected)
  })

  it('clamps a future timestamp to 0s rather than printing a negative age', () => {
    // The server stamps the time; the browser's clock may be behind it.
    expect(shortAge(new Date(now + 5_000).toISOString(), now)).toBe('0s')
  })

  it.each([undefined, '', 'not a date'])('renders nothing for %s', (iso) => {
    expect(shortAge(iso, now)).toBe('')
  })
})

describe('compactTokens', () => {
  it.each([
    [0, '0'],
    [1, '1'],
    [812, '812'],
    [999, '999'],
    [1_000, '1.0k'],
    [96_249, '96.2k'],
    // Truncated, not rounded: this must not read `1000.0k`.
    [999_999, '999.9k'],
    [1_000_000, '1.0M'],
    [1_449_999, '1.4M'],
  ])('%d → %s', (tokens, expected) => {
    expect(compactTokens(tokens)).toBe(expected)
  })

  it.each([-5, Number.NaN, Number.POSITIVE_INFINITY])('renders %s as 0', (tokens) => {
    expect(compactTokens(tokens)).toBe('0')
  })
})

describe('formatDuration', () => {
  it.each([
    [0, '0:00'],
    [999, '0:00'],
    [1_000, '0:01'],
    [59_000, '0:59'],
    [60_000, '1:00'],
    [64_000, '1:04'],
    [3_599_000, '59:59'],
    // The hour field appears only once there is one — a stopwatch, not a fixed-width clock.
    [3_600_000, '1:00:00'],
    [7_384_000, '2:03:04'],
    [90_000_000, '25:00:00'],
  ])('%d ms elapsed reads %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected)
  })

  it('clamps a negative elapsed to 0:00 rather than printing a negative clock', () => {
    // `startedAt` is stamped by the server; the browser's clock may sit behind it.
    expect(formatDuration(-5_000)).toBe('0:00')
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY])('renders %s as 0:00', (ms) => {
    expect(formatDuration(ms)).toBe('0:00')
  })
})

describe('formatToolDuration', () => {
  // The boundary table from spec 2026-08-20-step-and-tool-call-durations §Data models. It exists
  // because of a measurement, not a preference: replaying a real run's transcript, 98 of 100 tool
  // calls finished under one second (median 76ms), so a `m:ss` clock would have printed `0:00` on
  // nearly every card.
  it.each([
    [0, '0ms'],
    [1, '1ms'],
    [70, '70ms'],
    [940, '940ms'],
    [999, '999ms'],
    [1_000, '1.0s'],
    [1_449, '1.4s'],
    [1_500, '1.5s'],
    [10_610, '10.6s'],
    // Truncation, never rounding: 59_999ms is still 59 seconds, and printing `60.0s` for it
    // would be a minute that says it is not one.
    [59_949, '59.9s'],
    [59_999, '59.9s'],
    // Past a minute it hands off to formatDuration, so a long command reads in the same units
    // as the step and run clocks above it.
    [60_000, '1:00'],
    [64_000, '1:04'],
    [3_600_000, '1:00:00'],
  ])('%dms -> %s', (ms, expected) => {
    expect(formatToolDuration(ms)).toBe(expected)
  })

  it('clamps a negative elapsed to 0ms (the two frames stamped out of order)', () => {
    expect(formatToolDuration(-1)).toBe('0ms')
    expect(formatToolDuration(-5_000)).toBe('0ms')
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('renders %s as 0ms', (ms) => {
    expect(formatToolDuration(ms)).toBe('0ms')
  })

  it('never prints a bare number without a unit', () => {
    for (const ms of [0, 5, 999, 1_000, 59_000, 60_000, 7_200_000]) {
      expect(formatToolDuration(ms)).toMatch(/(?:ms|s|:)/)
    }
  })
})
