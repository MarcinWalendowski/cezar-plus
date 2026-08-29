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
  offsetMs = 0,
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
  /**
   * Ms already banked by attempts closed BEFORE `since` (spec 2026-08-29-step-retry-timing) —
   * added on top of the live tick so a retried step's clock reads the cumulative total, not just
   * the open attempt. Defaults to `0`, so every existing caller renders byte-identical output.
   * Never rescues a missing/unparseable `since` — a step with banked attempts and no open one is
   * not live and never reaches this leaf.
   */
  offsetMs?: number
}) {
  const now = useNow(1000)
  if (!since) return null
  const start = new Date(since).getTime()
  if (Number.isNaN(start)) return null
  // The clamp wraps the LIVE term alone, not the sum: a browser clock behind the server must
  // never subtract from already-banked duration, which is what `offsetMs + (now - start)` did
  // before this existed (spec 2026-08-29-step-retry-timing, Phase 2 step 1).
  const elapsed = format(offsetMs + Math.max(0, now - start))
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
