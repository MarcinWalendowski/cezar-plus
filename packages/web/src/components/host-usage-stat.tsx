import { CpuIcon, MemoryStickIcon } from 'lucide-react'

import { useHostMetrics } from '@/api/queries'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

/**
 * Live whole-HOST CPU%/memory% for a task-list header (spec
 * `.ai/specs/2026-08-19-host-machine-usage-in-dashboard.md`). Shared by every task view —
 * the per-project overview, the global `/tasks` page and `/workspace/tasks` — because the
 * machine-wide figure is not scoped to a project.
 *
 * Distinct from the per-run `cpu`/`memory` table columns, which are PER-PROCESS. The "Host"
 * label is load-bearing: without it the stat reads as just another run's numbers (owner
 * feedback 2026-08-19). Renders nothing until the first poll answers; CPU shows `—` for the
 * one interval before the sampler has two snapshots to diff.
 */
export function HostUsageStat({ className }: { className?: string }) {
  const metrics = useHostMetrics().data
  if (!metrics) return null
  const cpu = metrics.cpuPercent === null ? '—' : `${Math.round(metrics.cpuPercent)}%`
  const mem = `${Math.round(metrics.memoryPercent)}%`
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            data-slot="host-usage"
            className={`flex items-center gap-2 rounded-md border border-border bg-muted/40 px-2 py-1 text-[12.5px] text-muted-foreground tabular-nums ${className ?? ''}`}
          >
            <span className="font-medium text-foreground/70">Host</span>
            <span className="inline-flex items-center gap-1">
              <CpuIcon className="size-3.5" aria-hidden="true" />
              {cpu}
            </span>
            <span className="inline-flex items-center gap-1">
              <MemoryStickIcon className="size-3.5" aria-hidden="true" />
              {mem}
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent>
          Host machine · CPU {cpu} · memory {mem}
          {metrics.cpuCount ? ` (${metrics.cpuCount} CPU${metrics.cpuCount === 1 ? '' : 's'})` : ''}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
