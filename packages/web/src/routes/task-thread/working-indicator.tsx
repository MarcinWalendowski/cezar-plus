import { LoaderCircleIcon } from 'lucide-react'
import { clockLabel, elapsedSince, exactLabel, useNow } from './thread-time'

/**
 * Live "the agent is working" affordance for an active session. A running run
 * streams in bursts with quiet gaps between turns (thinking, tool setup), and
 * with nothing on screen the user cannot tell whether more output is coming.
 * This spinner + shimmering label sits at the tail of the thread for exactly
 * the `running` window, so the session never looks stalled when it is not.
 *
 * A live turn has no closing `TurnTime` yet, so the indicator carries the clock instead: how long
 * the current turn has been going (`since`) and when the agent last produced anything
 * (`lastActivityAt`) — a long silence reads as a long silence, not as a spinner that looks the
 * same at 5s and at 20m. Either stamp missing or unparseable drops just its part.
 */
export function WorkingIndicator({ since, lastActivityAt }: { since?: string; lastActivityAt?: string } = {}) {
  const now = useNow()
  const elapsed = elapsedSince(since, now)
  const quiet = elapsedSince(lastActivityAt, now)
  const lastClock = clockLabel(lastActivityAt)
  return (
    <div
      data-slot="working-indicator"
      // Wraps rather than overflows: with both stamps the line outgrows a 320px phone column.
      className="flex flex-wrap items-center gap-x-2 gap-y-0.5 py-1 text-[13px] text-soft-foreground"
    >
      <LoaderCircleIcon role="status" aria-label="Working" className="size-3.5 shrink-0 animate-spin" />
      <span className="shimmer font-medium">Working…</span>
      {elapsed !== undefined ? (
        <span data-slot="working-elapsed" title={`Started ${exactLabel(since)}`} className="font-mono text-xs tabular-nums">
          {elapsed}
        </span>
      ) : null}
      {quiet !== undefined && lastClock !== undefined ? (
        <span data-slot="working-last-activity" title={exactLabel(lastActivityAt)} className="text-xs">
          · last activity {lastClock} ({quiet} ago)
        </span>
      ) : null}
    </div>
  )
}
