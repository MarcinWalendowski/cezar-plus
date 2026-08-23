import { describe, expect, it } from 'vitest';
import { MAX_USAGE_LIMIT_WAIT_MS, parseUsageLimit } from './usage-limit.ts';

/** A fixed clock — every expectation below is relative to it. */
const NOW = Date.parse('2026-08-03T12:00:00.000Z');

describe('parseUsageLimit', () => {
  it('reads Claude Code\'s own envelope, in epoch seconds', () => {
    const resetAt = Date.parse('2026-08-03T17:00:00.000Z');
    const hit = parseUsageLimit(
      `continue failed: Claude AI usage limit reached|${resetAt / 1_000}`,
      NOW,
    );
    expect(hit?.resetAt.toISOString()).toBe('2026-08-03T17:00:00.000Z');
    expect(hit?.evidence).toBe('claude-marker');
  });

  it('accepts the same marker in milliseconds rather than parking it ~50,000 years out', () => {
    const hit = parseUsageLimit(`Claude AI usage limit reached|${NOW + 3_600_000}`, NOW);
    expect(hit?.resetAt.toISOString()).toBe('2026-08-03T13:00:00.000Z');
  });

  it('reads an explicit reset instant out of prose', () => {
    const hit = parseUsageLimit(
      "You've hit your usage limit. Try again at 2026-08-03T15:30:00Z.",
      NOW,
    );
    expect(hit?.resetAt.toISOString()).toBe('2026-08-03T15:30:00.000Z');
    expect(hit?.evidence).toBe('timestamp');
  });

  it('reads a date-only reset as local midnight, the way the zoneless prose forms are read', () => {
    // The ECMAScript date-ONLY form is defined as UTC, so a bare `YYYY-MM-DD` reaching
    // `Date.parse` unchanged would land up to a day away from the day the provider named. The
    // zoneless prose forms are deliberately read on the host's clock — the provider is talking
    // to the person at this machine — and a bare date has to answer the same way.
    // Two days out, so the expectation is unambiguous (and un-clamped) in every host timezone.
    const hit = parseUsageLimit('Usage limit reached. Try again at 2026-08-05.', NOW);
    const midnight = new Date(2026, 7, 5, 0, 0, 0, 0);
    expect(hit?.resetAt.getTime()).toBe(midnight.getTime());
    expect(hit?.evidence).toBe('timestamp');
  });

  it('reads the WEEKLY limit shape — a named date and a clock — on the day it names', () => {
    // The exact string production returned (prod-host, run 76680e19, 2026-08-23). Before the
    // named-date tier this parsed as "11pm" alone and parked the run on TODAY at 23:00, three days
    // early, so it woke into a window that was still shut.
    const failedAt = Date.parse('2026-08-23T11:20:53.771Z');
    const hit = parseUsageLimit(
      'step "review-spec" failed: You\'ve hit your weekly limit · resets Aug 26, 11pm (UTC)',
      failedAt,
    );
    expect(hit?.resetAt.toISOString()).toBe('2026-08-26T23:00:00.000Z');
    expect(hit?.evidence).toBe('named-date');
  });

  it('reads the day-first spelling, and a month spelled out in full', () => {
    const hit = parseUsageLimit(
      'usage limit reached · try again on 5 September at 9:30am (UTC)',
      Date.parse('2026-09-01T12:00:00.000Z'),
    );
    expect(hit?.resetAt.toISOString()).toBe('2026-09-05T09:30:00.000Z');
    expect(hit?.evidence).toBe('named-date');
  });

  it('reads a named date with no clock as local midnight, like a date-only ISO reset', () => {
    const hit = parseUsageLimit('weekly limit reached · resets Aug 5', NOW);
    expect(hit?.resetAt.getTime()).toBe(new Date(2026, 7, 5, 0, 0, 0, 0).getTime());
    expect(hit?.evidence).toBe('named-date');
  });

  it('honors an explicit year, and rolls a bare one forward across new year', () => {
    expect(
      parseUsageLimit(
        'weekly limit · resets Jan 2, 11pm (UTC)',
        Date.parse('2026-12-30T12:00:00.000Z'),
      )?.resetAt.toISOString(),
    ).toBe('2027-01-02T23:00:00.000Z');
    expect(
      parseUsageLimit(
        'weekly limit · resets Aug 5 2026, 6pm (UTC)',
        NOW,
      )?.resetAt.toISOString(),
    ).toBe('2026-08-05T18:00:00.000Z');
  });

  it('clamps a named date that has already passed to now, rather than losing the schedule', () => {
    // "resets Aug 26" read on Aug 27 means the window already reopened. Rolling it to next year
    // would put it past the one-week ceiling and yield no schedule at all.
    const after = Date.parse('2026-08-27T09:00:00.000Z');
    const hit = parseUsageLimit('weekly limit reached · resets Aug 26, 11pm (UTC)', after);
    expect(hit?.resetAt.getTime()).toBe(after);
    expect(hit?.evidence).toBe('named-date');
  });

  it('is null for a date it recognizes and cannot honor — never the clock tier\'s nearer answer', () => {
    // The negative control for the bug: falling through here is what produced the three-day-early
    // schedule, so an impossible date must yield NO schedule rather than "today at 11pm".
    expect(parseUsageLimit('weekly limit · resets Feb 31, 11pm (UTC)', NOW)).toBeNull();
  });

  it('does not read a YEAR in passing prose as a day, and leaves the delay tier reachable', () => {
    // `Mar 2024` must not parse as "Mar 20". Without the day capture's `(?!\d)` this returned a
    // schedule months away and shadowed the retry-after that was actually stated.
    const hit = parseUsageLimit('usage limit; retry after 30 seconds, see the notes from Mar 2024', NOW)
    expect(hit?.evidence).toBe('delay');
    expect(hit?.resetAt.toISOString()).toBe('2026-08-03T12:00:30.000Z');
  });

  it('still falls through to the clock tier when the prose names no date at all', () => {
    // The new tier must not swallow the old one: "tomorrow" is not a month.
    const hit = parseUsageLimit(
      "You've hit your session limit · resets tomorrow at 8:10pm (Europe/Warsaw)",
      NOW,
    );
    expect(hit?.evidence).toBe('clock');
  });

  it('reads Claude Code session-limit prose with a clock and IANA timezone', () => {
    const hit = parseUsageLimit(
      "You've hit your session limit · resets 8:10pm (Europe/Warsaw)",
      NOW,
    );
    expect(hit?.resetAt.toISOString()).toBe('2026-08-03T18:10:00.000Z');
    expect(hit?.evidence).toBe('clock');
  });

  it('uses tomorrow when a clock-only reset already passed today in its named timezone', () => {
    const lateWarsawNight = Date.parse('2026-08-03T20:30:00.000Z');
    const hit = parseUsageLimit(
      "You've hit your session limit · resets 8:10pm (Europe/Warsaw)",
      lateWarsawNight,
    );
    expect(hit?.resetAt.toISOString()).toBe('2026-08-04T18:10:00.000Z');
  });

  it('reads a relative delay, and a bare retry-after', () => {
    expect(parseUsageLimit('rate limit exceeded — try again in 42 minutes', NOW)?.resetAt.toISOString())
      .toBe('2026-08-03T12:42:00.000Z');
    expect(parseUsageLimit('429 rate_limit_error; retry-after: 3600', NOW)?.resetAt.toISOString())
      .toBe('2026-08-03T13:00:00.000Z');
    expect(parseUsageLimit('usage limit reached, retry after 90 s', NOW)?.evidence).toBe('delay');
  });

  it('clamps an already-elapsed reset to now — the limit has lifted, resume as soon as allowed', () => {
    const hit = parseUsageLimit(`Claude AI usage limit reached|${(NOW - 60_000) / 1_000}`, NOW);
    expect(hit?.resetAt.getTime()).toBe(NOW);
  });

  it('refuses a reset further out than a week — a corrupt number must not swallow the task', () => {
    const beyond = (NOW + MAX_USAGE_LIMIT_WAIT_MS + 60_000) / 1_000;
    expect(parseUsageLimit(`Claude AI usage limit reached|${beyond}`, NOW)).toBeNull();
  });

  it('is null for anything that is not a usage limit', () => {
    expect(parseUsageLimit(undefined, NOW)).toBeNull();
    expect(parseUsageLimit('claude CLI exited with code 1 — ENOENT', NOW)).toBeNull();
    expect(parseUsageLimit('Failed to authenticate. API Error: 401', NOW)).toBeNull();
    // A timestamp with no limit phrase around it must never schedule a resume.
    expect(parseUsageLimit('build failed at 2026-08-03T15:30:00Z', NOW)).toBeNull();
  });

  it('is null for a limit with no recoverable instant — guessing would be a retry loop', () => {
    expect(parseUsageLimit('You have hit your usage limit. Upgrade to continue.', NOW)).toBeNull();
    expect(parseUsageLimit('429 {"type":"rate_limit_error"}', NOW)).toBeNull();
  });
});
