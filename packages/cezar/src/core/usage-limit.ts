/**
 * Provider usage-limit detection (spec 2026-08-03-auto-resume-after-usage-limit).
 *
 * A subscription that runs out of its window does not fail like an agent bug does: the work is
 * fine, the account is simply closed until a KNOWN instant. That instant is the whole feature —
 * without it there is nothing to schedule, so this module answers exactly one question about a
 * terminal error string: "is this a usage limit, and when does it lift?".
 *
 * The evidence differs per backend, so the shapes are recognized in order of how exact they are:
 *
 *  1. Claude Code's machine-readable envelope, `Claude AI usage limit reached|<epoch>` — the CLI
 *     puts it in an `is_error` result frame, which reaches cezar verbatim as the run's `error`.
 *     Exact, no locale, no parsing of prose. This is the one that matters in practice.
 *  2. An explicit reset instant in the prose (`try again at 2026-08-03T18:00:00Z`) — how Codex and
 *     OpenCode phrase the same thing when they carry a timestamp at all.
 *  3. A NAMED calendar date, with or without a clock (`resets Aug 26, 11pm (UTC)`) — how Claude
 *     Code phrases a WEEKLY window, whose reset is days away rather than hours.
 *  4. A clock-only reset in prose (`resets 8:10pm (Europe/Warsaw)`) — how Claude Code phrases
 *     session windows in some interactive output.
 *  5. A relative delay (`try again in 42 minutes`, `retry-after: 3600`).
 *
 * **Tier 3 exists because tier 4 silently answered for it (spec
 * `2026-08-23-usage-limit-hold-account.md`).** `RESET_CLOCK_RE` steps over whatever sits between
 * the reset word and the clock, so `resets Aug 26, 11pm (UTC)` matched as "11pm", and the named
 * day was dropped: measured on `prod-host`, a weekly limit resetting Aug 26 was parked on
 * Aug 23 23:00, three days early. The run then wakes into a window that is still shut, fails
 * again, spends one of `MAX_AUTO_RESUMES`, and re-arms for the next night. So a message whose date
 * this module RECOGNIZES and cannot turn into an instant returns `null` rather than falling
 * through to the clock: no schedule beats a schedule that is wrong in the early direction.
 *
 * Nothing else counts. A limit message with no recoverable reset instant returns `null` on
 * purpose: guessing a window would turn one interruption into a retry loop against a provider
 * that is still refusing, and "we don't know when" is an honest answer the caller can surface.
 */

export interface UsageLimitHit {
  /** When the provider says the limit lifts. Never in the past — a stale instant clamps to now. */
  resetAt: Date;
  /** Which shape carried it — the lifecycle note quotes this so the schedule is auditable. */
  evidence: 'claude-marker' | 'timestamp' | 'named-date' | 'clock' | 'delay';
}

/**
 * The furthest ahead a reset may sit and still be believed. Claude's weekly window is the real
 * ceiling; anything beyond a week is a corrupt or unit-confused number, and parking a task on it
 * would be indistinguishable from losing the task.
 */
export const MAX_USAGE_LIMIT_WAIT_MS = 7 * 24 * 60 * 60_000;

/** Claude Code's own envelope. The suffix is Unix EPOCH SECONDS (ms tolerated — see below). */
const CLAUDE_MARKER_RE = /claude(?:\s+ai)?\s+usage\s+limit\s+reached\s*\|\s*(\d{9,16})/i;

/**
 * "This is a limit, not a crash." Deliberately narrow: it gates the two prose shapes below, and a
 * false positive there would schedule a resume on a timestamp that means something else entirely.
 */
const LIMIT_PHRASE_RE =
  /\b(?:usage|rate|session|weekly|hourly)[\s-]?limit\b|\brate[_-]?limit(?:_error|ed)?\b|\bquota\s+(?:exceeded|reached)\b|\bout\s+of\s+(?:credits|quota)\b/i;

/** `…try again at 2026-08-03T18:00:00Z`, `…resets at 2026-08-03 18:00`. */
const RESET_AT_RE =
  /(?:resets?|reset[s]?\s+at|try\s+again|retry|available\s+again|unlocks?)\b[^\n]{0,24}?\b(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?)/i;

/** Month names as a provider spells them: three letters, optionally spelled out (`Sep`, `Sept`,
 *  `September`). Index + 1 is the calendar month. */
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] as const;

/** `…resets Aug 26, 11pm (UTC)`, `…try again on 26 September 2026`. Matches the DATE only; the
 *  clock that usually follows it is read separately from the text right after this match, so the
 *  anchor's short skip window cannot push a long date's clock out of reach. Anchored on the same
 *  reset words as every other tier, so a date sitting in unrelated prose is not a schedule. */
const RESET_NAMED_DATE_RE = new RegExp(
  String.raw`(?:resets?|reset[s]?\s+at|try\s+again|retry|available\s+again|unlocks?)\b[^\n]{0,24}?\b(?:on\s+)?` +
    // `(?!\d)` on both day captures: without it `Mar 2024` reads as "Mar 20", which would turn a
    // year in unrelated prose into a schedule and shadow the delay tier behind it.
    String.raw`(?:(${MONTHS.join('|')})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?!\d)` +
    String.raw`|(\d{1,2})(?:st|nd|rd|th)?(?!\d)\s+(${MONTHS.join('|')})[a-z]*\.?)` +
    String.raw`(?:,?\s*(\d{4}))?`,
  'i',
);

/** The clock alone, with the SAME capture groups as `RESET_CLOCK_RE` so one reader serves both:
 *  1 hour, 2 minute, 3/4 meridiem, 5 timezone. Unanchored — its caller has already established
 *  that a reset instant is being described. */
const BARE_CLOCK_RE =
  /\b(?:at\s*)?(\d{1,2})(?:(?::(\d{2}))\s*([ap]\.?m\.?)?|\s*([ap]\.?m\.?))(?:\s*\(([^)]+)\))?/i;

/** `...resets 8:10pm (Europe/Warsaw)`, `...try again at 20:10`. */
const RESET_CLOCK_RE =
  /(?:resets?|reset[s]?\s+at|try\s+again|retry|available\s+again|unlocks?)\b[^\n]{0,24}?\b(?:at\s*)?(\d{1,2})(?:(?::(\d{2}))\s*([ap]\.?m\.?)?|\s*([ap]\.?m\.?))(?:\s*\(([^)]+)\))?/i;

/** `…try again in 42 minutes`, `…retry after 3600 seconds`, `retry-after: 3600`. */
const RESET_IN_RE =
  /(?:try\s+again|retry|resets?|available\s+again)\b[^\n]{0,16}?\b(?:in|after)\s+(\d{1,7})\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i;
const RETRY_AFTER_HEADER_RE = /\bretry[-_\s]?after\b\s*[:=]?\s*(\d{1,7})\b/i;

const UNIT_MS: Record<string, number> = {
  s: 1_000, sec: 1_000, secs: 1_000, second: 1_000, seconds: 1_000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
};

/**
 * Read a usage limit out of a terminal error message, or `null` when it is not one (or carries no
 * usable reset instant). `now` is injected so callers and tests share one clock.
 *
 * Never throws: this runs on the failure path of every run, where a second failure helps nobody.
 */
export function parseUsageLimit(message: string | undefined, now = Date.now()): UsageLimitHit | null {
  if (!message) return null;
  const marker = CLAUDE_MARKER_RE.exec(message);
  if (marker) {
    const raw = Number(marker[1]);
    // Epoch seconds is the documented unit; a value large enough to only make sense as
    // milliseconds is accepted rather than parked ~50,000 years out.
    const epochMs = raw >= 1e12 ? raw : raw * 1_000;
    return settle(epochMs, now, 'claude-marker');
  }
  if (!LIMIT_PHRASE_RE.test(message)) return null;

  const at = RESET_AT_RE.exec(message);
  if (at) {
    // A bare date, or `YYYY-MM-DD HH:MM` without a zone, is read in the host's local time — the
    // provider is talking to the person at this machine, and `Date.parse` would otherwise read the
    // space-separated form as UTC on some runtimes and local on others. A date with no time at all
    // needs the midnight spelled out for the same reason: the ECMAScript date-ONLY form is defined
    // as UTC, so `2026-08-03` alone would land up to a day away from the day the provider named.
    const stamp = at[1]!.includes('T') ? at[1]! : at[1]!.replace(' ', 'T');
    const parsed = Date.parse(stamp.includes('T') ? stamp : `${stamp}T00:00`);
    if (Number.isFinite(parsed)) return settle(parsed, now, 'timestamp');
  }

  const named = RESET_NAMED_DATE_RE.exec(message);
  if (named) {
    // Deliberately terminal: a recognized date that cannot be turned into an instant returns
    // null instead of falling through to the clock tier, which would answer with TODAY at that
    // clock and park a weekly limit days early. See the module docblock.
    const parsed = parseNamedDateReset(named, message, now);
    return parsed === null ? null : settle(parsed, now, 'named-date');
  }

  const clock = RESET_CLOCK_RE.exec(message);
  if (clock) {
    const parsed = parseClockReset(clock, now);
    if (parsed !== null) return settle(parsed, now, 'clock');
  }

  const relative = RESET_IN_RE.exec(message);
  if (relative) {
    const unit = UNIT_MS[relative[2]!.toLowerCase()];
    if (unit !== undefined) return settle(now + Number(relative[1]) * unit, now, 'delay');
  }
  const header = RETRY_AFTER_HEADER_RE.exec(message);
  if (header) return settle(now + Number(header[1]) * 1_000, now, 'delay');

  return null;
}

/** Hour/minute/zone out of a clock match — shared by the anchored `RESET_CLOCK_RE` and the bare
 *  `BARE_CLOCK_RE`, which carry the same capture groups on purpose. */
function readClock(match: RegExpExecArray): { hour: number; minute: number; timeZone: string | null } | null {
  const hourRaw = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  const meridiem = (match[3] ?? match[4])?.toLowerCase().replaceAll('.', '');
  if (!Number.isInteger(hourRaw) || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    return null;
  }
  let hour = hourRaw;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === 'am') hour = hour === 12 ? 0 : hour;
    else if (meridiem === 'pm') hour = hour === 12 ? 12 : hour + 12;
    else return null;
  } else if (hour < 0 || hour > 23) {
    return null;
  }
  return { hour, minute, timeZone: validTimeZone(match[5]?.trim()) };
}

function parseClockReset(match: RegExpExecArray, now: number): number | null {
  const clock = readClock(match);
  if (!clock) return null;
  if (clock.timeZone) return nextClockInTimeZone(clock.hour, clock.minute, clock.timeZone, now);
  return nextLocalClock(clock.hour, clock.minute, now);
}

/**
 * `resets Aug 26, 11pm (UTC)` → that exact instant.
 *
 * The clock is read from the text immediately AFTER the date rather than from the whole message,
 * so a long date (`on September 26, 2026, 11pm`) cannot push its own clock past the anchor's skip
 * window. A date with no clock behind it reads as local midnight on that day, the same answer a
 * date-only ISO reset already gives: the window is known to open sometime that day, and a resume
 * that is early re-arms itself while one that is late wastes the whole window.
 *
 * A missing year is resolved to the next occurrence, which is what makes a December limit naming
 * a January date land in the right year.
 */
function parseNamedDateReset(match: RegExpExecArray, message: string, now: number): number | null {
  const monthName = (match[1] ?? match[4] ?? '').slice(0, 3).toLowerCase();
  const month = MONTHS.indexOf(monthName as (typeof MONTHS)[number]) + 1;
  const day = Number(match[2] ?? match[3]);
  if (month < 1 || !Number.isInteger(day) || day < 1 || day > 31) return null;

  const tail = (message.slice(match.index + match[0].length).split('\n')[0] ?? '').slice(0, 32);
  const clockMatch = BARE_CLOCK_RE.exec(tail);
  const clock = clockMatch ? readClock(clockMatch) : { hour: 0, minute: 0, timeZone: null };
  if (!clock) return null;

  const explicitYear = match[5] === undefined ? undefined : Number(match[5]);
  const currentYear = clock.timeZone
    ? (zonedParts(now, clock.timeZone)?.year ?? new Date(now).getFullYear())
    : new Date(now).getFullYear();
  const years = explicitYear === undefined ? [currentYear, currentYear + 1] : [explicitYear];

  // The `currentYear` reading, kept whatever happens to it — see the return below.
  let thisYearsReading: number | null = null;
  for (const year of years) {
    // Feb 31 is a date this module recognized and cannot honor. Checked before building, because
    // both construction paths below roll such a value silently into the next month.
    if (new Date(Date.UTC(year, month - 1, day)).getUTCDate() !== day) return null;
    const at = clock.timeZone
      ? zonedWallTimeToUtc(year, month, day, clock.hour, clock.minute, clock.timeZone)
      : new Date(year, month - 1, day, clock.hour, clock.minute, 0, 0).getTime();
    if (at === null || !Number.isFinite(at)) return null;
    if (explicitYear !== undefined) return at;
    thisYearsReading ??= at;
    // A bare date means the NEXT occurrence, but only a believable one: rolling to next year is
    // right for `Jan 2` read on Dec 30, and wrong for `Aug 26` read on Aug 27 — that one is a
    // window that has already reopened, and next year's copy is a year out, which `settle` would
    // refuse outright. Anything the ceiling would refuse falls through to this year's reading,
    // where `settle` clamps the past to now: the same answer an elapsed epoch marker gets.
    if (at >= now && at - now <= MAX_USAGE_LIMIT_WAIT_MS) return at;
  }
  return thisYearsReading;
}

function nextLocalClock(hour: number, minute: number, now: number): number {
  const candidate = new Date(now);
  candidate.setHours(hour, minute, 0, 0);
  if (candidate.getTime() < now) candidate.setDate(candidate.getDate() + 1);
  return candidate.getTime();
}

function nextClockInTimeZone(hour: number, minute: number, timeZone: string, now: number): number | null {
  const today = zonedParts(now, timeZone);
  if (!today) return null;
  let candidate = zonedWallTimeToUtc(today.year, today.month, today.day, hour, minute, timeZone);
  if (candidate === null) return null;
  if (candidate < now) {
    const tomorrow = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
    candidate = zonedWallTimeToUtc(
      tomorrow.getUTCFullYear(),
      tomorrow.getUTCMonth() + 1,
      tomorrow.getUTCDate(),
      hour,
      minute,
      timeZone,
    );
  }
  return candidate;
}

function validTimeZone(candidate: string | undefined): string | null {
  if (!candidate) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date(0));
    return candidate;
  } catch {
    return null;
  }
}

function zonedWallTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number | null {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let candidate = wallAsUtc;
  for (let i = 0; i < 3; i += 1) {
    const offset = timeZoneOffsetMs(timeZone, candidate);
    if (offset === null) return null;
    const next = wallAsUtc - offset;
    if (Math.abs(next - candidate) < 1_000) return next;
    candidate = next;
  }
  return candidate;
}

function timeZoneOffsetMs(timeZone: string, utcMs: number): number | null {
  const parts = zonedParts(utcMs, timeZone);
  if (!parts) return null;
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - utcMs;
}

function zonedParts(
  utcMs: number,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number; second: number } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(utcMs));
    const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    return {
      year: value('year'),
      month: value('month'),
      day: value('day'),
      hour: value('hour'),
      minute: value('minute'),
      second: value('second'),
    };
  } catch {
    return null;
  }
}

/** Bound a candidate instant: past → now (the limit already lifted), absurd → not believed. */
function settle(epochMs: number, now: number, evidence: UsageLimitHit['evidence']): UsageLimitHit | null {
  if (!Number.isFinite(epochMs)) return null;
  if (epochMs - now > MAX_USAGE_LIMIT_WAIT_MS) return null;
  return { resetAt: new Date(Math.max(epochMs, now)), evidence };
}
