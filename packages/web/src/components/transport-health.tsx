import type { TransportHealth as TransportHealthValue, TransportHealthStatus } from '@loki-labs/cezar-plus-api-client'

import { StatusDot, type StatusDotTone } from '@/components/status-dot'
import { cn } from '@/lib/utils'

/**
 * The health chip for one notification transport row (W4.9, `packages/web/src/routes/settings/
 * notifications-section.tsx`). See `.ai/specs/2026-08-06-pluggable-notification-transports.md`
 * "API Contracts" and "Observability".
 *
 * **Presentational and prop-driven only** — no data fetching, no clock. `health` is exactly the
 * `TransportHealth` shape `GET /workspace/notifications` answers: `status` is a persisted enum
 * WRITTEN by a transition, never recomputed here from `backoffUntil` against the clock (Q13, plan
 * D8/D20) — this component reads the stored enum and stored timestamps verbatim and never derives
 * a freshness value from them, which is what keeps three identical renders of the same `health`
 * object byte-identical (the same discipline `route-parity.test.ts` enforces server-side).
 */

const STATUS_PRESENTATION: Record<TransportHealthStatus, { label: string; tone: StatusDotTone }> = {
  ok: { label: 'Delivering', tone: 'success' },
  degraded: { label: 'Degraded', tone: 'danger' },
  unconfigured: { label: 'Not configured', tone: 'neutral' },
  disabled: { label: 'Disabled', tone: 'neutral' },
}

export interface TransportHealthProps {
  health: TransportHealthValue
  className?: string
}

export function TransportHealth({ health, className }: TransportHealthProps) {
  const presentation = STATUS_PRESENTATION[health.status]
  const { counters } = health

  return (
    <div data-slot="transport-health" data-status={health.status} className={cn('flex flex-col gap-1', className)}>
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <StatusDot tone={presentation.tone} />
        <span data-slot="transport-health-label">{presentation.label}</span>
        {health.consecutiveFailures > 0 ? (
          <span data-slot="transport-health-failures">
            · {health.consecutiveFailures} consecutive failure{health.consecutiveFailures === 1 ? '' : 's'}
          </span>
        ) : null}
      </div>

      {health.lastError ? (
        <p data-slot="transport-health-error" className="min-w-0 break-words text-[12px] text-danger">
          {health.lastError}
          {health.lastAttemptAt ? (
            <span className="text-soft-foreground"> · {health.lastAttemptAt}</span>
          ) : null}
        </p>
      ) : null}

      <p data-slot="transport-health-counters" className="text-[11px] text-soft-foreground">
        {counters.sent} sent · {counters.failed} failed
        {counters.dropped > 0 ? ` · ${counters.dropped} dropped` : ''}
        {counters.suppressed > 0 ? ` · ${counters.suppressed} suppressed` : ''}
        {health.lastSuccessAt ? ` · last delivered ${health.lastSuccessAt}` : ''}
      </p>
    </div>
  )
}
