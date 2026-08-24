import type { TodoItem } from '@loki-labs/better-cezar-api-client'
import { useHealth } from '@/api/queries'
import { useActiveClusterRuns, useClusterOverview } from '@/routes/settings/cluster-section'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  resolveRunNode,
  resolveTaskNode,
  runNodeFreshness,
  taskNodeLabel,
  taskNodeTitle,
  type RunNodeFreshness,
  type TaskNodeInfo,
} from '@/lib/task-node'

/**
 * "Which worker is processing this?" (`.ai/specs/2026-08-22-multi-node-cezar-cluster.md`) — the
 * roster-resolution half (`useTaskNodeRoster`) plus the rendered cell (`TaskNodeCell`). Mirrors
 * `author-cell.tsx`'s split: a dumb cell over an already-resolved value, mounting its OWN
 * `TooltipProvider` (the 2026-08-22 white-screen precedent — a bare Radix `Tooltip` throws with no
 * provider above it, and not every surface that renders a task opens one for the whole table).
 *
 * `useClusterOverview` is reused from `cluster-section.tsx` rather than a second fetch path — that
 * file's own module doc explains why the roster read is gated behind a CONFIRMED
 * `capabilities.cluster` read first (`GET /api/v1/cluster` 409s while clustering is off), and this
 * hook follows the identical ordering.
 *
 * `useRunNodeRoster`/`RunNodeCell` below (2026-08-24) are the RUN-side counterpart, added once the
 * runs surfaces needed the same answer for a run instead of a todo — see `lib/task-node.ts`'s
 * `resolveRunNode` for why a run's node has to be inferred rather than read off a field.
 */

export interface TaskNodeRoster {
  /** False on a single-node cockpit (or before the capability read settles) — callers must not
   *  render the node column/cell at all, rather than showing one that is always empty. */
  clusterOn: boolean
  resolve: (todo: Pick<TodoItem, 'startedOn' | 'placement'>) => TaskNodeInfo | undefined
}

export function useTaskNodeRoster(): TaskNodeRoster {
  const health = useHealth()
  const clusterOn = health.data?.capabilities?.cluster === true
  const overview = useClusterOverview(clusterOn)
  const nodes = overview.data?.nodes ?? []
  const selfNodeId = overview.data?.self?.nodeId
  return {
    clusterOn,
    resolve: (todo) => resolveTaskNode(todo, nodes, selfNodeId),
  }
}

/**
 * `info === undefined` is the honest "no node claim yet" state — a plain dash, never "local" or
 * "this machine": callers must not pass a guessed value here, only what `resolveTaskNode` (via
 * `useTaskNodeRoster().resolve`) actually found.
 */
export function TaskNodeCell({ info, className }: { info: TaskNodeInfo | undefined; className?: string }) {
  if (!info) {
    return (
      <span data-slot="task-node" data-node-kind="none" className={cn('text-soft-foreground', className)}>
        —
      </span>
    )
  }
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            data-slot="task-node"
            data-node-kind={info.kind}
            data-node-source={info.source}
            data-node-id={info.nodeId}
            className={cn(
              'inline-flex max-w-full min-w-0 items-center truncate text-[12.5px] text-muted-foreground',
              className,
            )}
          >
            {taskNodeLabel(info)}
          </span>
        </TooltipTrigger>
        <TooltipContent side="left">{taskNodeTitle(info)}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

// ---- runs: "which worker ran/is running this?" ---------------------------------------------------

export interface RunNodeRoster {
  /** False on a single-node cockpit (or before the capability read settles) — callers must not
   *  render the node column/cell at all, rather than showing one that is always empty. Same rule
   *  as `TaskNodeRoster.clusterOn`. */
  clusterOn: boolean
  resolve: (runId: string) => TaskNodeInfo | undefined
  /** Honesty rule: per-run freshness, not `ClusterActiveResponse.asOf` — see `runNodeFreshness`'s
   *  own doc for why `asOf` (the roster-WIDE most-recent reading) would make a stale node's run
   *  look current. Takes the already-resolved `TaskNodeInfo` rather than a bare id so a caller
   *  never has to resolve the same run twice. */
  freshness: (info: TaskNodeInfo | undefined) => RunNodeFreshness | undefined
}

/**
 * `now` is a parameter, not a `Date.now()` read inside this hook, so every caller ticks off the
 * SAME clock as the rest of its row (`useNow(30_000)`, already threaded through every surface that
 * renders a run's age) rather than a second, independently-drifting one.
 *
 * `useActiveClusterRuns` is reused from `cluster-section.tsx` for the same reason
 * `useClusterOverview` is above — one fetch path for `/cluster/active`, gated behind the same
 * confirmed `capabilities.cluster` read.
 */
export function useRunNodeRoster(now: number): RunNodeRoster {
  const health = useHealth()
  const clusterOn = health.data?.capabilities?.cluster === true
  const overview = useClusterOverview(clusterOn)
  const active = useActiveClusterRuns(clusterOn)
  const nodes = overview.data?.nodes ?? []
  const selfNodeId = overview.data?.self?.nodeId
  const activeRuns = active.data?.runs ?? []
  return {
    clusterOn,
    resolve: (runId) => resolveRunNode(runId, activeRuns, nodes, selfNodeId),
    freshness: (info) => runNodeFreshness(info, nodes, now),
  }
}

/**
 * `TaskNodeCell` plus the one thing a run's cell needs that a todo's never did: how stale the
 * resolved node's own presence is (`useRunNodeRoster().freshness`). Renders nothing beyond the
 * plain node cell when there is no staleness to report — `runNodeFreshness`'s own doc lists every
 * case that is (self, unknown, never-connected, or simply fresh).
 *
 * Callers gate the WHOLE cell on `roster.clusterOn` themselves (matching every other node-column
 * call site) rather than this component doing it internally, so a caller that also needs to gate
 * a `<Th>` header alongside it reads one flag, not two.
 */
export function RunNodeCell({ roster, runId, className }: { roster: RunNodeRoster; runId: string; className?: string }) {
  const info = roster.resolve(runId)
  const freshness = roster.freshness(info)
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1">
      <TaskNodeCell info={info} className={className} />
      {freshness ? (
        <span
          data-slot="run-node-stale"
          title={`No word from this node in ${freshness.ageText} — this run's status here may be out of date`}
          className="shrink-0 text-[11px] text-soft-foreground"
        >
          · {freshness.ageText}
        </span>
      ) : null}
    </span>
  )
}
