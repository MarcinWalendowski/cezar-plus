import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { CheckIcon, FlagIcon, TriangleAlertIcon, Undo2Icon, UsersIcon, WandSparklesIcon } from 'lucide-react'

import type { ReportListItem, ReportStatus } from '@loki-labs/cezar-plus-api-client'
import {
  workspaceQueryKeys,
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
import { PickerPill } from '@/components/picker-pill'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/toaster'
import { shortAge } from '@/lib/format'
import { Link, scopeTo } from '@/lib/project-router'
import { cn } from '@/lib/utils'

/**
 * `/workspace/reports` — the user-report triage queue
 * (`.ai/specs/2026-08-19-reports-triage-approve-dismiss.md`, "Reports is a workspace tab"
 * amendment).
 *
 * **MOVED HERE 2026-08-19 from `/p/:projectId/reports` (`routes/reports/reports.tsx`, deleted).**
 * The project-scoped version's own doc comment used to justify having no `workspaceTo` with:
 * "triage is per-corpus (one project's reports, one project's todo inbox), and a cross-project
 * report queue would need a cross-project answer for where an approval files its task." That
 * reasoning was WRONG, measured on the production box: the knowledge mount that holds the
 * reports is declared in the OPERATOR's `~/.cezar/config.json`, not in any repo, so all 12
 * registered projects resolved the SAME 196 reports. The Reports item rendered inside every
 * project group — 12 identical queues over one corpus — and because triage was stored per
 * project, a decision made in one was invisible in the others: two triage stores existed on the
 * box and the second one re-answered questions the first had already answered. The fix is one
 * queue, one decision, at workspace scope — this file, reached only through `nav-items.ts`'s
 * `workspace: true` band item, never through a per-project sidebar group.
 *
 * **Mounted OUTSIDE `ProjectScopeRoute`** (`routes.tsx`), the same placement as
 * `workspace-knowledge.tsx` / `workspace-tasks.tsx` / `workspace-git.tsx`. This file reads only
 * `useReports`, `useReport` and the triage mutation hooks, all workspace-level
 * (`GET/POST /workspace/reports*`) — never a scope-led query or client function (the "scope
 * trap": with no `ProjectScopeRoute` above it, `queryScope()` would silently resolve to the boot
 * project's `'default'` sentinel).
 *
 * **A row belongs to N projects, not one.** `ReportListItem.project` is the canonical project its
 * document link resolves through (first in registry order); `.projects` is every project that
 * resolves the same document. `ReportProjectMeta` below renders the two differently on purpose:
 * one project reads as an owner, `projects.length > 1` reads as SHARED (a compact "N projects"
 * pill with a people icon and the full list on hover) — never as N separate chips, which would
 * just be noise, and never as a single chip, which is the exact bug this move exists to fix (a
 * shared report reading as though one project owned it).
 *
 * **The project filter is a single-select, unlike `ProjectFilter`** (the multi-select the Tasks
 * and Notes boards share). `ReportsQuery.project` is one id — a MEMBERSHIP test against a row's
 * `projects` array, not a comma-joined list — so this reuses `PickerPill` (the composer's
 * single-choice control) instead. Options come from the response's own `projects` health rows
 * (`ReportsResponse.projects`, one row per project the server's fan-out considered, dead ones
 * included with a reason) — the authoritative list, not the registry, because a project the
 * fan-out could not read still belongs in the picker with its reason visible. Selecting a project
 * changes `items`, never `counts` — the server describes the whole set there regardless of any
 * filter, the same contract the status tabs already rely on.
 *
 * **The "open document" link builds an explicit `/p/<project>/knowledge?doc=…` path**, via
 * `scopeTo` rather than the ambient scoped `Link`. Verified against `routes.tsx`: `knowledge` is
 * registered under `ProjectScopeRoute` as `<Route path="knowledge" element={<KnowledgeRoute />}
 * />`, so `/p/<project>/knowledge?doc=<id>` resolves. This page has no ambient project scope of
 * its own (`useActiveProjectId()` falls back to the URL's `/p/:id` prefix, which `/workspace/…`
 * never carries), so a plain `to="/knowledge?doc=…"` through the scope-aware `Link` would resolve
 * to the unscoped, unregistered `/knowledge` and 404. `scopeTo(item.project, …)` builds the
 * already-scoped path explicitly — the same pattern `workspace-knowledge.tsx`'s "Open in
 * `<project>` →" link uses — and the scoped `Link` leaves an already-`/p/…` target untouched
 * (`project-router.ts`'s `scopePathname`), so passing the pre-scoped path through it is safe.
 *
 * **Tabs are server-filtered, badges are not.** `GET /workspace/reports` returns `counts` over the
 * WHOLE set regardless of the `status` (or `project`) filter, so the badge on "Dismissed" is right
 * while you are standing on "Pending" filtered to one project.
 *
 * Selection lives in the URL as `?report=<key>`, the skills/knowledge parity shape, so a triage
 * decision is linkable and the browser Back button works through the queue.
 */

const TABS: { status: ReportStatus; label: string }[] = [
  { status: 'pending', label: 'Pending' },
  { status: 'approved', label: 'Approved' },
  { status: 'dismissed', label: 'Dismissed' },
]

export function WorkspaceReportsRoute() {
  const health = useHealth()
  const knowledgeAvailable = health.data?.capabilities.knowledge === true
  const reportsOff = health.data !== undefined && !knowledgeAvailable

  return (
    <div data-route="workspace-reports" className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 hidden h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-5 md:flex">
        <h1 className="text-base font-semibold">Reports</h1>
        <p className="text-[13px] text-soft-foreground">
          {reportsOff
            ? 'Reports ride on the knowledge base, which is off for this server.'
            : 'What users flagged from a live conversation, across every registered project. Approve one to put it on the board.'}
        </p>
      </header>

      <div className="flex flex-1 flex-col p-3 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-5 md:pb-5">
        {reportsOff ? (
          <CenteredState
            icon={<FlagIcon />}
            tone="neutral"
            title="Reports are off"
            subtitle="Reports are knowledge documents. Set CEZ_KB=1 and restart cezar-plus to turn them on."
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
  const [project, setProject] = useState<string | undefined>(undefined)

  // Demand-driven, like every other topic subscriber: a report arriving in the corpus is a
  // knowledge change, so the `knowledge` topic is what announces it. Both prefixes are
  // invalidated — the queue AND the workspace knowledge catalog (domains/search/document, the
  // `['workspace','knowledge']` prefix) — because a new report changes both, the same reasoning
  // `workspaceQueryKeys.reportsRoot`'s own doc comment gives for keeping the two prefixes
  // separate the rest of the time.
  useEffect(() => {
    return subscribeTopic('knowledge', () => {
      void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.reportsRoot })
      void queryClient.invalidateQueries({ queryKey: ['workspace', 'knowledge'] })
    })
  }, [queryClient])

  const reportsQuery = useReports({ status, project })
  const counts = reportsQuery.data?.counts
  const items = reportsQuery.data?.items ?? []
  // The authoritative project list for the filter — every project the fan-out considered, dead
  // ones included with a reason. Stays the WHOLE list across a project selection, same contract
  // as `counts` (the server never narrows this array to the current filter).
  const projectHealth = reportsQuery.data?.projects ?? []

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
        <ProjectFilterPill
          projects={projectHealth}
          selected={project}
          onChange={(next) => {
            setProject(next)
            selectReport(null)
          }}
        />
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

/** The single-select project filter (see the module doc comment for why this is `PickerPill`, not
 *  the multi-select `ProjectFilter` the Tasks/Notes boards share). `undefined` means "All
 *  projects", the same "absent means every project" contract `ProjectFilter` uses. A dead project
 *  (`!ok`) still gets an option — a reader who cannot triage a project's reports still deserves to
 *  know it exists and why it failed. */
function ProjectFilterPill({
  projects,
  selected,
  onChange,
}: {
  projects: ReadonlyArray<{ id: string; name: string; ok: boolean; reason?: string; total: number }>
  selected: string | undefined
  onChange: (next: string | undefined) => void
}) {
  const options = [
    { value: '__all__', label: 'All projects' },
    ...projects.map((project) => ({
      value: project.id,
      label: project.name,
      desc: project.ok ? `${project.total} report${project.total === 1 ? '' : 's'}` : project.reason,
    })),
  ]
  const selectedLabel = projects.find((project) => project.id === selected)?.name ?? 'All projects'
  return (
    <PickerPill
      slot="reports-project-filter"
      ariaLabel="Filter reports by project"
      label={selectedLabel}
      value={selected ?? '__all__'}
      options={options}
      onPick={(next) => onChange(next === '__all__' ? undefined : next)}
    />
  )
}

/** One project reads as an owner; more than one reads as SHARED, compactly — never as N separate
 *  chips (noise on a corpus one mount shares with a dozen projects) and never as a single chip
 *  (the exact bug this move fixes: a shared report implying one project owns it). */
function ReportProjectMeta({ item }: { item: ReportListItem }) {
  if (item.projects.length <= 1) {
    return (
      <Badge data-slot="report-project" data-shared="false" variant="outline" className="shrink-0 text-[10px] uppercase">
        {item.project}
      </Badge>
    )
  }
  return (
    <Badge
      data-slot="report-project"
      data-shared="true"
      variant="outline"
      title={`Resolved through every one of: ${item.projects.join(', ')}`}
      className="shrink-0 gap-1 text-[10px] uppercase"
    >
      <UsersIcon aria-hidden="true" className="size-2.5" />
      {item.projects.length} projects
    </Badge>
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
            <ReportProjectMeta item={item} />
            {item.filedAt ? <span>{shortAge(item.filedAt)} ago</span> : null}
            {item.domain ? <span data-slot="report-domain">{item.domain}</span> : null}
            {/* The document is the record; this page only decides what happens next, so it always
                offers the way through to it. Explicitly scoped to the row's CANONICAL project —
                see the module doc comment for why the ambient scoped `Link` cannot be trusted
                here. */}
            <Link
              to={scopeTo(item.project, `/knowledge?doc=${encodeURIComponent(item.docId)}`)}
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
