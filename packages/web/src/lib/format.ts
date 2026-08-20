/**
 * Compact age — `4s` / `26m` / `2h` / `3d`, the sidebar's and table's age column.
 *
 * One unit, no rounding up, no "ago": at 7px-of-dot density the unit *is* the information. Ports
 * `shortAgo()` from the legacy UI (web/app.js) unchanged, so both cockpits read the same.
 *
 * `now` is a parameter rather than a `Date.now()` call so the tests are not racing the clock.
 * Returns '' for a missing or unparseable timestamp — an empty slot is honest; `NaNm` is not.
 */
export function shortAge(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  // Clamp: a clock skew between the server's timestamp and the browser must not print `-3s`.
  const seconds = Math.max(0, (now - then) / 1000)
  if (seconds < 60) return `${Math.floor(seconds)}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}

/**
 * Compact token count — `812` / `96.2k` / `1.4M`. Directional usage supplies the semantic
 * context around this deliberately unit-less number (`IN 96.2k · OUT 1.8k`).
 *
 * Truncates rather than rounds: `999_999` reads `999.9k`, never a `1000.0k` that is really 1M.
 */
export function compactTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0'
  if (tokens >= 1_000_000) return `${(Math.floor(tokens / 100_000) / 10).toFixed(1)}M`
  if (tokens >= 1_000) return `${(Math.floor(tokens / 100) / 10).toFixed(1)}k`
  return String(Math.floor(tokens))
}

/**
 * Elapsed clock — `0:00` / `1:04` / `2:03:04`. The running task's timer and the status line's
 * per-item clock, so both read the same and neither invents its own arithmetic.
 *
 * Deliberately NOT `shortAge`: that one answers "how stale is this row" at one unit of
 * precision, which is right for a table and useless for a clock you are watching tick. This one
 * is a stopwatch — seconds always, minutes always, the hour field only once there is one.
 *
 * Negative input clamps to `0:00` for the same reason `shortAge` clamps: the server stamps
 * `startedAt` and the browser's clock may sit behind it, and `-0:03` reads as a bug.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return '0:00'
  const total = Math.max(0, Math.floor(ms / 1000))
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  const pad = (value: number) => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
}

/**
 * Tool-scale elapsed — `0ms` / `70ms` / `999ms` / `1.0s` / `59.9s` / `1:00` / `1:00:00`.
 *
 * A second formatter exists because the measured distribution demands it: replaying a real
 * six-step run's transcript, 42 of 44 tool calls finished under one second (median 70ms). A
 * `m:ss` clock would print `0:00` on nearly every card and say nothing at all. So: milliseconds
 * below a second, one decimal of seconds below a minute, and above that it hands off to
 * `formatDuration` so a long command reads in the same units as the step and run clocks.
 *
 * Truncates rather than rounds, like `compactTokens`: `59_999` reads `59.9s`, never a `60.0s`
 * that is really a minute. Negative and non-finite clamp to `0ms` — clock skew between the
 * frame that opened a tool and the one that closed it must not print `-3ms`.
 */
export function formatToolDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0ms'
  if (ms < 1_000) return `${Math.floor(ms)}ms`
  if (ms < 60_000) return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`
  return formatDuration(ms)
}
