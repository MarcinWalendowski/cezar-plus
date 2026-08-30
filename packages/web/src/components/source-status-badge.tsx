import { StatusDot, type StatusDotTone } from '@/components/status-dot'
import { cn } from '@/lib/utils'
import type { SourceSyncState } from '@loki-labs/cezar-plus-api-client'

/**
 * The shared status pill for a mirrored source connection's `syncState` (F2, `CEZ_SOURCES`,
 * `.ai/specs/2026-08-06-external-source-connectors-notion.md` "UI/UX").
 *
 * "`never-synced`, `stale`, `error`, `unavailable` and `paused` each render distinctly; a generic
 * grey pill for all five is how a revoked token gets mistaken for an idle connection." Shared
 * (not local to the Sources section) because the spec also says the Knowledge surface renders a
 * mirrored document's provenance with this same component, so the two surfaces cannot disagree
 * about what a given `syncState` looks like.
 *
 * `syncState` is a STORED value the caller already read off the wire (D8, D19) — this component
 * never derives anything from a clock or recomputes staleness itself, it only presents what it is
 * given, so it stays correct for three byte-identical GETs in a row.
 */

const PRESENTATION: Record<SourceSyncState, { label: string; tone: StatusDotTone }> = {
  'never-synced': { label: 'Never synced', tone: 'neutral' },
  ok: { label: 'Synced', tone: 'success' },
  stale: { label: 'Stale', tone: 'pending' },
  error: { label: 'Sync error', tone: 'danger' },
  unavailable: { label: 'Unavailable', tone: 'violet' },
  paused: { label: 'Paused', tone: 'neutral' },
}

export function SourceStatusBadge({
  syncState,
  reason,
  className,
}: {
  syncState: SourceSyncState
  /** The provider's own words for `unavailable` (never invented here), or the sweep's own
   *  `lastErrorMessage` for `error`. Rendered IN the DOM whenever the caller has one, never only
   *  in a `title` — a revoked token's reason must be readable at a glance, not on hover, or "you
   *  have no documents" and "cezar can no longer read your workspace" become one screen. */
  reason?: string
  className?: string
}) {
  const presentation = PRESENTATION[syncState]
  return (
    <span
      data-slot="source-status-badge"
      data-sync-state={syncState}
      className={cn('inline-flex min-w-0 items-center gap-1.5 text-[13px]', className)}
    >
      <StatusDot tone={presentation.tone} />
      <span className="font-medium whitespace-nowrap text-foreground">{presentation.label}</span>
      {reason ? (
        <span
          data-slot="source-status-reason"
          className="min-w-0 truncate text-soft-foreground"
          title={reason}
        >
          — {reason}
        </span>
      ) : null}
    </span>
  )
}
