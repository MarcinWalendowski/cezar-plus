import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { CheckIcon, FlagIcon, TriangleAlertIcon, Undo2Icon, WandSparklesIcon } from 'lucide-react'

import type { ReportListItem, ReportStatus } from '@loki-labs/better-cezar-api-client'
import {
  queryKeys,
  useApproveReport,
  useDismissReport,
  useHealth,
  useProcessPendingReports,
  useReopenReport,
  useReport,
  useReports,
} from '@/api/queries'
import { subscribeTopic } from '@/api/ws'
import { CenteredState } from '@/components/centered-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/toaster'
import { shortAge } from '@/lib/format'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'

/**
 * `/p/:projectId/reports` — the user-report triage queue
 * (`.ai/specs/2026-08-19-reports-triage-approve-dismiss.md`).
 *
 * **Why this surface exists.** Reports arrive as knowledge documents, and the Tasks board renders
 * `todos.json` — it never reads the knowledge base. So a report landing in the corpus is invisible
 * to the board that decides what gets worked on: it is filed, and nothing more happens. This page
 * is the missing act. Approve mints the todo (which is what puts it on the board), dismiss records
 * a reason, and neither touches the report document itself.
 *
 * **Gated on `capabilities.knowledge`, not a capability of its own.** Reports ride the knowledge
 * base, so `CEZ_KB=1` is exactly the condition under which they can exist. The route stays
 * reachable while off — off renders its own "switched off" state rather than a 404, the rule every
 * flag-gated route here follows.
 *
 * **Tabs are server-filtered, badges are not.** `GET /reports` returns `counts` over the WHOLE set
 * regardless of the `status` filter, so the badge on "Dismissed" is right while you are standing on
 * "Pending". A client-side count over the filtered page would say 0.
 *
 * Selection lives in the URL as `?report=<key>`, the skills/knowledge parity shape, so a triage
 * decision is linkable and the browser Back button works through the queue.
 */

const TABS: { status: ReportStatus; label: string }[] = [
  { status: 'pending', label: 'Pending' },
  { status: 'approved', label: 'Approved' },
  { status: 'dismissed', label: 'Dismissed' },
]

export function ReportsRoute() {
  const health = useHealth()
  const knowledgeAvailable = health.data?.capabilities.knowledge === true
  const reportsOff = health.data !== undefined && !knowledgeAvailable

  return (
    <div data-route="reports" className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 hidden h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-5 md:flex">
        <h1 className="text-base font-semibold">Reports</h1>
        <p className="text-[13px] text-soft-foreground">
          {reportsOff
            ? 'Reports ride on the knowledge base, which is off for this server.'
            : 'What users flagged from a live conversation. Approve one to put it on the board.'}
        </p>
      </header>

      <div className="flex flex-1 flex-col p-3 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-5 md:pb-5">
        {reportsOff ? (
          <CenteredState
            icon={<FlagIcon />}
            tone="neutral"
            title="Reports are off"
            subtitle="Reports are knowledge documents. Set CEZ_KB=1 and restart cezar to turn them on."
            heading="h2"
          />
        ) : health.isPending ? null : (
          <ReportsQueue />
        )}
      </div>
    </div>
  )
}

function ReportsQueue() {
  const [searchParams, setSearchParams] = useSearchParams()
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<ReportStatus>('pending')

  // Demand-driven, like every other topic subscriber: a report arriving in the corpus is a
  // knowledge change, so the `knowledge` topic is what announces it. Both prefixes are invalidated
  // — the queue AND the catalog — because a new report changes both.
  useEffect(() => {
    return subscribeTopic('knowledge', () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.reports })
      void queryClient.invalidateQueries({ queryKey: queryKeys.knowledge })
    })
  }, [queryClient])

  const reportsQuery = useReports({ status })
  const counts = reportsQuery.data?.counts
  const items = reportsQuery.data?.items ?? []

  const selected = searchParams.get('report')
  const selectReport = (key: string | null) => {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current)
        if (key === null) next.delete('report')
        else next.set('report', key)
        return next
      },
      { replace: true },
    )
  }

  const process = useProcessPendingReports()

  if (reportsQuery.isError) {
    return (
      <CenteredState
        icon={<TriangleAlertIcon />}
        tone="danger"
        title="Could not load the reports"
        subtitle={reportsQuery.error.message}
        heading="h2"
      />
    )
  }

  return (
    <div data-slot="reports-queue" className="mx-auto flex w-full max-w-3xl flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {TABS.map((tab) => (
          <button
            key={tab.status}
            type="button"
            data-slot="reports-tab"
            data-status={tab.status}
            aria-pressed={status === tab.status}
            onClick={() => {
              setStatus(tab.status)
              // A key selected in one tab is not in the next one's list; carrying it over would
              // leave an expanded row nothing can collapse.
              selectReport(null)
            }}
          >
            <Badge variant={status === tab.status ? 'default' : 'outline'} className="cursor-pointer">
              {tab.label}
              {counts ? <span className="opacity-70"> ({counts[tab.status]})</span> : null}
            </Badge>
          </button>
        ))}
        <span className="flex-1" />
        {status === 'pending' && items.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-action="reports-process-pending"
            title="Turn every pending report into a task"
            disabled={process.isPending}
            onClick={() =>
              process.mutate(undefined, {
                onSuccess: (result) => {
                  // Both halves, always: a batch that converted 8 and dropped 2 must not read as
                  // "8 converted" full stop.
                  toast(
                    result.failed > 0
                      ? `Converted ${result.converted}, ${result.failed} could not be converted.`
                      : `Converted ${result.converted} report${result.converted === 1 ? '' : 's'}.`,
                    { tone: result.failed > 0 ? 'danger' : 'default' },
                  )
                },
                onError: (error) => toast(error.message, { tone: 'danger' }),
              })
            }
          >
            <WandSparklesIcon aria-hidden="true" className="size-3" />
            Convert all pending
          </Button>
        ) : null}
      </div>

      {reportsQuery.isPending ? (
        <p className="px-1 py-2 text-[13px] text-soft-foreground">Loading…</p>
      ) : items.length === 0 ? (
        <CenteredState
          icon={<FlagIcon />}
          tone="neutral"
          title={
            status === 'pending'
              ? counts && counts.total > 0
                ? 'Nothing left to triage'
                : 'No reports yet'
              : `No ${status} reports`
          }
          subtitle={
            status === 'pending'
              ? 'Reports users flag from a conversation land here for approval.'
              : 'Switch tabs to see the rest of the queue.'
          }
          heading="h2"
        />
      ) : (
        <ul data-slot="reports-list" className="flex flex-col gap-2.5">
          {items.map((item) => (
            <ReportCard
              key={item.key}
              item={item}
              expanded={selected === item.key}
              onToggle={() => selectReport(selected === item.key ? null : item.key)}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function ReportCard({
  item,
  expanded,
  onToggle,
}: {
  item: ReportListItem
  expanded: boolean
  onToggle: () => void
}) {
  const approve = useApproveReport()
  const dismiss = useDismissReport()
  const reopen = useReopenReport()
  const detail = useReport(expanded ? item.key : null)

  // The reason is required by the server, so the form asks for it rather than letting a 400 do the
  // teaching. Opened on demand: most of the queue gets approved, not dismissed.
  const [dismissing, setDismissing] = useState(false)
  const [reason, setReason] = useState('')

  const busy = approve.isPending || dismiss.isPending || reopen.isPending
  const fail = (error: Error) => toast(error.message, { tone: 'danger' })

  return (
    <li
      data-slot="report-card"
      data-report-key={item.key}
      data-status={item.status}
      className="flex flex-col gap-2.5 rounded-lg border border-border bg-card p-4 shadow-xs"
    >
      <div className="flex items-start gap-3">
        <FlagIcon
          aria-hidden="true"
          className={cn('mt-[3px] size-3.5 shrink-0', item.status === 'pending' ? 'text-pending-strong' : 'text-soft-foreground')}
        />
        <div className="min-w-0 flex-1">
          <button
            type="button"
            data-action="report-expand"
            onClick={onToggle}
            aria-expanded={expanded}
            className="text-left text-sm leading-snug font-medium text-foreground hover:underline"
          >
            {item.title}
          </button>
          <div
            data-slot="report-meta"
            className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-soft-foreground"
          >
            {item.filedAt ? <span>{shortAge(item.filedAt)} ago</span> : null}
            {item.domain ? <span data-slot="report-domain">{item.domain}</span> : null}
            {/* The document is the record; this page only decides what happens next, so it always
                offers the way through to it. */}
            <Link
              to={`/knowledge?doc=${encodeURIComponent(item.docId)}`}
              data-slot="report-doc-link"
              className="text-muted-foreground underline decoration-border underline-offset-2 hover:text-foreground"
            >
              open document
            </Link>
            {item.triage?.reason ? (
              <span data-slot="report-reason">dismissed: {item.triage.reason}</span>
            ) : null}
            {item.triage?.auto ? <span data-slot="report-auto">converted automatically</span> : null}
            {item.statusSource === 'document' ? (
              // Said plainly, because "approved" here is NOT somebody's decision: the report
              // document itself says the tracker that filed it had already dealt with it. There is
              // no timestamp, no reason and no task to point at, and implying otherwise would
              // invent a person.
              <span data-slot="report-prior-status" title="From the report document's own status tag">
                already handled before triage existed
              </span>
            ) : null}
            {item.triage?.keyKind === 'catalog-id' ? (
              // An honest warning, not decoration: a catalog id can change on a reindex, so this
              // report's triage can be orphaned and the row would come back as pending.
              <span data-slot="report-weak-key" title="This report carries no stable identifier">
                unstable key
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 self-center">
          {/* Keyed on `statusSource`, not on `status`. A report the old tracker marked processed
              reads as approved but has NO triage row and NO task on this board — so Reopen would be
              a button that visibly does nothing (deleting a row that is not there leaves the
              document's own tag in charge), while Approve is the action that actually helps: it
              files the task nobody ever filed. */}
          {item.statusSource !== 'triage' ? (
            <>
              <Button
                type="button"
                variant="contrast"
                size="sm"
                data-action="report-approve"
                title="Turn this report into a task"
                disabled={busy}
                onClick={() =>
                  approve.mutate(
                    { key: item.key },
                    {
                      onSuccess: (result) => {
                        toast(
                          result.alreadyApproved
                            ? 'This report already had a task; opened that one.'
                            : 'Approved — filed as a task.',
                        )
                      },
                      onError: fail,
                    },
                  )
                }
              >
                <CheckIcon aria-hidden="true" className="size-3" />
                Approve
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-action="report-dismiss-open"
                title="Dismiss with a reason"
                disabled={busy}
                onClick={() => setDismissing(true)}
              >
                Dismiss
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-action="report-reopen"
              title="Return this report to the pending queue"
              disabled={busy}
              onClick={() =>
                reopen.mutate(
                  { key: item.key },
                  {
                    onSuccess: (result) => {
                      // Never silently: the task an earlier approve minted survives a reopen, and a
                      // user who is not told will file a second one.
                      toast(
                        result.orphanedTodoId
                          ? 'Back in the pending queue. The task it created is still on the board.'
                          : 'Back in the pending queue.',
                      )
                    },
                    onError: fail,
                  },
                )
              }
            >
              <Undo2Icon aria-hidden="true" className="size-3" />
              Reopen
            </Button>
          )}
        </div>
      </div>

      {dismissing ? (
        <form
          data-slot="report-dismiss-form"
          className="flex flex-wrap items-center gap-2 pl-[26px]"
          onSubmit={(event) => {
            event.preventDefault()
            const trimmed = reason.trim()
            if (!trimmed) return
            dismiss.mutate(
              { key: item.key, reason: trimmed },
              {
                onSuccess: () => {
                  setDismissing(false)
                  setReason('')
                },
                onError: fail,
              },
            )
          }}
        >
          <Input
            data-slot="report-dismiss-reason"
            aria-label="Why this report is being dismissed"
            placeholder="Why? (duplicate, already fixed, not a bug…)"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            // The same cap the server enforces, so an over-long reason is stopped at the keystroke
            // rather than by a 400.
            maxLength={500}
            className="h-8 flex-1 text-[13px]"
          />
          <Button
            type="submit"
            variant="contrast"
            size="sm"
            data-action="report-dismiss-confirm"
            disabled={busy || reason.trim() === ''}
          >
            Dismiss
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-action="report-dismiss-cancel"
            disabled={busy}
            onClick={() => {
              setDismissing(false)
              setReason('')
            }}
          >
            Cancel
          </Button>
        </form>
      ) : null}

      {expanded ? (
        <div data-slot="report-body" className="pl-[26px]">
          {detail.isPending ? (
            <p className="text-xs text-soft-foreground">Loading the report…</p>
          ) : detail.isError ? (
            <p className="text-xs text-danger">{detail.error.message}</p>
          ) : (
            // Plain preformatted text, not the markdown stack: a report body is what a user typed
            // into a chat, and rendering it as markdown would let their message restyle the page.
            <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2.5 text-xs whitespace-pre-wrap text-foreground">
              {detail.data?.body || 'This report has no body.'}
            </pre>
          )}
        </div>
      ) : null}
    </li>
  )
}
