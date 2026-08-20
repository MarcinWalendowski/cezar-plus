import { formatDuration } from '@/lib/format'
import { useNow } from '@/lib/use-now'
import { cn } from '@/lib/utils'

/**
 * A ticking duration since an ISO instant — "how long has this been running", next to the
 * status pill (spec 2026-08-20-live-run-status-line-and-timer §Phase 1), on a workflow step's
 * rail row, and on a running tool card's chip (spec 2026-08-20-step-and-tool-call-durations).
 *
 * This is its own component for one structural reason: `useNow(1000)` re-renders whoever owns
 * it, once a second. Owned by the route or by `RunHeader`'s body it would re-render a 300-row
 * transcript 60×/minute for a clock nobody asked to be expensive. As a LEAF it re-renders one
 * `<time>` and nothing else, which is the whole design (spec risk R2, pinned by the design
 * guardian's `no-tick-in-thread-containers` rule).
 *
 * Renders nothing at all for a missing or unparseable `since` — an old record with no
 * `startedAt` shows an empty slot, never `NaN:0-3` (risk R6, the rule `shortAge` already follows).
 */
export function LiveDuration({
  since,
  className,
  label,
  title,
  format = formatDuration,
}: {
  /** ISO-8601 instant the clock counts from — `run.startedAt`. */
  since: string | undefined
  className?: string
  /** Accessible prefix for the bare number ("Running for"). */
  label?: string
  /** Hover text saying what interval the number measures. */
  title?: string
  /**
   * How the elapsed ms are spelled. Defaults to the `h:mm:ss` stopwatch; a tool chip passes
   * `formatToolDuration` so a call that is still running reads in the same units its finished
   * neighbours will — a card must not jump from `0:00` to `70ms` the moment it completes.
   */
  format?: (ms: number) => string
}) {
  const now = useNow(1000)
  if (!since) return null
  const start = new Date(since).getTime()
  if (Number.isNaN(start)) return null
  const elapsed = format(now - start)
  return (
    <time
      data-slot="live-duration"
      dateTime={since}
      title={title}
      aria-label={label ? `${label} ${elapsed}` : undefined}
      className={cn('tabular-nums', className)}
    >
      {elapsed}
    </time>
  )
}
