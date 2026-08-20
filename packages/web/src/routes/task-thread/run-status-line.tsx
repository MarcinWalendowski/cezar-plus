import { LoaderCircleIcon } from 'lucide-react'

import type { RunActivity, RunEvent } from '@loki-labs/better-cezar-api-client'
import { formatDuration } from '@/lib/format'
import { useNow } from '@/lib/use-now'
import { cn } from '@/lib/utils'

import { IDLE_TIMEOUT_MS, liveStatus } from './live-status'
import type { ThreadState } from './thread-state'

/**
 * Live "the agent is working" affordance for an active session — the CLI's status line
 * (spec 2026-08-20-live-run-status-line-and-timer). A running run streams in bursts with quiet
 * gaps between turns (thinking, tool setup), and the old fixed `Working…` was equally true for
 * all of them, which is exactly why it could not tell a healthy 40-minute step from a wedged one.
 *
 * Four fields, all derived by `liveStatus()`: what the agent is doing (the live item's own
 * title), the last line of whatever it is streaming right now, how long this item has taken,
 * and — past the threshold — how long it has been quiet. The silence is STATED, never diagnosed:
 * a liveness signal cannot distinguish work from noise, so this says `quiet 2:14`, never "stuck".
 *
 * Its OWN module, not a helper inside `thread-items.tsx`: it holds the 1s `useNow` tick, and the
 * design guardian's `no-tick-in-thread-containers` rule now covers `thread-items.tsx` too — a
 * tick in there would re-render whole tool cards, output blocks and all
 * (spec 2026-08-20-step-and-tool-call-durations §Phase 2).
 *
 * `data-slot="working-indicator"` survives the rename on purpose — it is the DOM handle other
 * suites use for "is this thread live", and that assertion is still exactly true.
 *
 * Owns the 1s tick itself (`useNow`) BECAUSE it is a leaf: the route must not hold it, or the
 * whole transcript would re-render 60×/minute for a clock (spec risk R2, pinned by the design
 * guardian's `no-tick-in-thread-containers` rule).
 */
export function RunStatusLine({
  state,
  events,
  activity,
}: {
  /** The reduced thread — its newest item is what the agent is doing. */
  state: ThreadState
  /** The same run's raw frames, for the two clocks (`item.started` ts, newest ts). */
  events: RunEvent[]
  /** `monitoring` suppresses the quiet escalation: that run is quiet by design. */
  activity?: RunActivity
}) {
  const now = useNow(1000)
  const status = liveStatus({ state, events, now, activity })
  const idleMinutes = Math.round(IDLE_TIMEOUT_MS / 60_000)
  return (
    <div
      data-slot="working-indicator"
      data-tone={status.tone}
      className="flex min-w-0 flex-col gap-0.5 py-1 text-[13px] text-soft-foreground"
    >
      <div className="flex min-w-0 items-center gap-2">
        <LoaderCircleIcon role="status" aria-label="Working" className="size-3.5 shrink-0 animate-spin" />
        {/* A subagent's item is real work and is shown, but never mislabelled as the main
            session's (spec risk R8 — the distinction the Agents dock already draws). */}
        {status.subagent ? (
          <span aria-hidden className="shrink-0 text-muted-foreground">
            &#8627;
          </span>
        ) : null}
        <span className="shimmer min-w-0 truncate font-medium">{status.headline}</span>
        {status.itemMs !== undefined ? (
          <span data-slot="status-item-clock" className="shrink-0 tabular-nums">
            {formatDuration(status.itemMs)}
          </span>
        ) : null}
        {status.tone === 'normal' ? null : (
          <span
            data-slot="status-quiet"
            title={`Nothing has been written for ${formatDuration(status.silentMs)}. A step is ended after ${idleMinutes} minutes with no output at all.`}
            className={cn(
              'shrink-0 tabular-nums',
              status.tone === 'stale' ? 'text-pending-strong' : undefined,
            )}
          >
            {status.tone === 'stale' ?
              `· no output for ${formatDuration(status.silentMs)}`
            : `· quiet ${formatDuration(status.silentMs)}`}
          </span>
        )}
      </div>
      {/* The streamed tail: one line, no markdown, clipped. The same content the tool card below
          already renders, so it exposes nothing new (risk R7). */}
      {status.detail ? (
        <div
          data-slot="status-detail"
          className="truncate pl-[22px] font-mono text-[11px] text-muted-foreground"
        >
          {status.detail}
        </div>
      ) : null}
    </div>
  )
}
