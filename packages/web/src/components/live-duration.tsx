import { formatDuration } from '@/lib/format'
import { useNow } from '@/lib/use-now'
import { cn } from '@/lib/utils'

/**
 * A ticking `h:mm:ss` since an ISO instant — "how long has this been running", next to the
 * status pill (spec 2026-08-20-live-run-status-line-and-timer §Phase 1).
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
}: {
  /** ISO-8601 instant the clock counts from — `run.startedAt`. */
  since: string | undefined
  className?: string
  /** Accessible prefix for the bare number ("Running for"). */
  label?: string
}) {
  const now = useNow(1000)
  if (!since) return null
  const start = new Date(since).getTime()
  if (Number.isNaN(start)) return null
  const elapsed = formatDuration(now - start)
  return (
    <time
      data-slot="live-duration"
      dateTime={since}
      aria-label={label ? `${label} ${elapsed}` : undefined}
      className={cn('tabular-nums', className)}
    >
      {elapsed}
    </time>
  )
}
