import { CheckIcon, ChevronDownIcon, ChevronRightIcon, FileTextIcon, HourglassIcon, TriangleAlertIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router'

import { trackEvent } from '@/api/analytics'
import { ApiError } from '@/api/client'
import { useReferenceProjectId, useRun, useRunSpec } from '@/api/queries'
import type {
  ApiRun,
  PendingApproval,
  SpecReviewEntry,
  SpecReviewFeedResponse,
} from '@loki-labs/cezar-plus-api-client'
import { CenteredState } from '@/components/centered-state'
import { cn } from '@/lib/utils'

import { GitTabLoadError, GitTabLoading } from '../task-git/git-tab-loading'
import { formatFileSize } from '../task-git/worktree-files'
import { isRunActive } from '../task-thread/run-actions'
import { RunHeader } from '../task-thread/run-header'
import { Markdown } from '../task-thread/markdown'

/**
 * `/tasks/:id/spec` — the spec/review feed (spec `.ai/specs/2026-08-29-spec-tab-review-feed.md`,
 * work package P3): the spec the `spec` step wrote, and — when the reviewer sent it back — the
 * whole argument in order, spec v1 → review 1 → spec v2 → review 2 → … → final verdict.
 *
 * Structured like `TaskFilesRoute`: a `useRun` guard, `RunHeader` with `tab="spec"`, then the
 * feed body. Unlike Files/Changes this route never 409s on a missing worktree — the recorded
 * side log outlives it, which is the main case the tab exists for (P2's route contract).
 */
export function TaskSpecRoute() {
  const { id } = useParams<{ id: string }>()
  const run = useRun(id)

  if (run.isPending) return <GitTabLoading tab="spec" />
  if (run.isError) return <GitTabLoadError tab="spec" error={run.error} />
  return <SpecView run={run.data} />
}

/** Spec entry, narrowed from the on-disk discriminated union — contract exports only the union
 *  (`SpecReviewEntry`), matching `runs.ts`'s own `specReviewEntrySchema`. */
type SpecEntry = Extract<SpecReviewEntry, { kind: 'spec' }>
/** Review entry, narrowed the same way. */
type ReviewEntry = Extract<SpecReviewEntry, { kind: 'review' }>

function SpecView({ run }: { run: ApiRun }) {
  const spec = useRunSpec(run.id, isRunActive(run.status))
  const projectId = useReferenceProjectId()
  // Fires `spec.feed_opened` once per mount, after the FIRST successful load — never on error,
  // never while loading, and never twice: neither the 5s poll nor StrictMode's double-invoked
  // effects can re-arm a ref that is already set (Verification P3 test 22).
  const fired = useRef(false)

  useEffect(() => {
    if (fired.current) return
    if (!spec.isSuccess) return
    fired.current = true
    const feed = spec.data
    const reviewEntries = feed.entries.filter((entry): entry is ReviewEntry => entry.kind === 'review')
    const specCount = feed.entries.length - reviewEntries.length
    const hasRevise = reviewEntries.some((entry) => entry.verdict === 'revise')
    const last = feed.entries[feed.entries.length - 1]
    const trailingAgentPass = last?.kind === 'review' && last.actor === 'agent' && last.verdict === 'pass'
    const approvalPending =
      trailingAgentPass === true &&
      run.pendingApproval !== undefined &&
      run.pendingApproval.stepId === 'review-spec'
    trackEvent('spec.feed_opened', {
      project: projectId ?? '',
      mode: specFeedMode(feed.entries),
      approvalPending,
      revisions: feed.summary.revisions,
      reviews: feed.summary.reviews,
      source: specFeedSource(feed.entries, specCount),
    })
    // `run.pendingApproval` deliberately excluded: it can change (approve/request-changes) after
    // the feed already loaded, and the event describes the moment the tab was OPENED, not every
    // state it passes through afterward.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec.isSuccess, spec.data, projectId])

  return (
    <div data-route="task-spec" className="flex min-h-full flex-col">
      <RunHeader run={run} tab="spec" />
      {spec.isPending ? (
        <p data-slot="spec-loading" className="px-4 py-6 text-center text-xs text-soft-foreground md:px-6">
          Loading the spec…
        </p>
      ) : spec.isError ? (
        <CenteredState
          icon={<TriangleAlertIcon />}
          tone={spec.error instanceof ApiError && spec.error.status === 404 ? 'neutral' : 'danger'}
          heading="h2"
          title={
            spec.error instanceof ApiError && spec.error.status === 404
              ? 'Task not found'
              : 'Could not load the spec'
          }
          subtitle={spec.error.message}
        />
      ) : (
        <SpecFeedView feed={spec.data} pendingApproval={run.pendingApproval} />
      )}
    </div>
  )
}

// ---- pure derivation ---------------------------------------------------------------------

export type SpecFeedMode = 'draft' | 'clean' | 'revised' | 'unmatched' | 'empty'

/** The analytics `mode` prop — exhaustive over every successful `/runs/:id/spec` response
 *  (spec "Phase 1 · P3" analytics table). Purely structural: `approvalPending` is a SEPARATE
 *  event prop precisely so a human-gated pass is never folded into `clean` here. */
export function specFeedMode(entries: SpecReviewEntry[]): SpecFeedMode {
  const specCount = entries.filter((entry) => entry.kind === 'spec').length
  const reviewCount = entries.length - specCount
  if (specCount === 0 && reviewCount === 0) return 'empty'
  // Zero specs but reviews exist: unmatched, regardless of verdict — checked before `revised`
  // because "unmatched" is explicitly gated on zero specs in the spec's partition table.
  if (specCount === 0) return 'unmatched'
  if (reviewCount === 0) return 'draft'
  const hasRevise = entries.some((entry) => entry.kind === 'review' && entry.verdict === 'revise')
  return hasRevise ? 'revised' : 'clean'
}

/** The analytics `source` prop: `recorded` and `worktree` never mix in one response (P2's
 *  resolution order returns one or the other), so any spec entry's own `source` field settles
 *  it; an unmatched-review-only response can only have come from the recorded log, since the
 *  worktree fallback always synthesises exactly one `spec` entry. */
export function specFeedSource(entries: SpecReviewEntry[], specCount: number): 'recorded' | 'worktree' | 'none' {
  if (entries.length === 0) return 'none'
  if (specCount === 0) return 'recorded'
  const spec = entries.find((entry): entry is SpecEntry => entry.kind === 'spec')
  return spec?.source ?? 'recorded'
}

export type SpecFeedLayout = 'empty' | 'spec-only' | 'accepted' | 'feed'

export type SpecFeedCard =
  | { kind: 'spec'; entry: SpecEntry; defaultExpanded: boolean }
  | { kind: 'review'; entry: ReviewEntry }
  /** The trailing agent `pass` while a human gate is still open — neither the accepted note nor
   *  a final-verdict card (Solution → "The raw log does not alternate", rule 3). */
  | { kind: 'awaiting'; revision?: number }

export interface SpecFeed {
  layout: SpecFeedLayout
  /** The newest spec entry, when one exists. `spec-only` and `accepted` render it directly;
   *  `feed` also carries it as the last `spec` card in `cards`. */
  latestSpec?: SpecEntry
  cards: SpecFeedCard[]
}

/**
 * Derive display cards from the raw log (spec "Solution → The raw log does not alternate" +
 * "Data models → Revision assignment"). The response's `entries` are NOT rendered one-to-one:
 *
 *  1. Group by `revision` — a `spec` entry starts a group, every `review` with that revision
 *     follows it in `seq` order; a `review` with no `revision` (unmatched) renders unlabelled.
 *  2. Suppress an `actor:'agent', verdict:'pass'` entry when a `verdict:'revise'` for the SAME
 *     revision follows it — that pass was provisional.
 *  3. A trailing (nothing-after-it) agent `pass` renders as the neutral "awaiting human
 *     approval" line, not a final-verdict card, whenever `pendingApproval` is set on the
 *     `review-spec` step — at every gate, not only the first.
 *  4. Zero reviews → the spec alone (`spec-only`), no feed chrome.
 *  5. Exactly one review, a clean final `pass` (not case 3) → `accepted`: the spec plus a
 *     single-line note, no cards, no feed — the owner's "if review was passed, don't show".
 *  6. Otherwise → the full ordered feed (`feed`).
 */
export function toFeedCards(entries: SpecReviewEntry[], pendingApproval?: PendingApproval): SpecFeed {
  const sorted = [...entries].sort((a, b) => a.seq - b.seq)
  if (sorted.length === 0) return { layout: 'empty', cards: [] }

  const specEntries = sorted.filter((entry): entry is SpecEntry => entry.kind === 'spec')
  const reviewEntries = sorted.filter((entry): entry is ReviewEntry => entry.kind === 'review')
  const latestSpec = specEntries.length > 0 ? specEntries[specEntries.length - 1] : undefined

  if (specEntries.length === 0) {
    // No draft was ever captured — every review here is unmatched by construction (Data models
    // → "Revision assignment"). Still rendered, never dropped: the objection is the useful part.
    return { layout: 'feed', cards: reviewEntries.map((entry) => ({ kind: 'review', entry })) }
  }

  if (reviewEntries.length === 0) {
    return { layout: 'spec-only', latestSpec, cards: [] }
  }

  const last = sorted[sorted.length - 1]!
  const trailingAgentPass = last.kind === 'review' && last.actor === 'agent' && last.verdict === 'pass'
  const awaitingApproval =
    trailingAgentPass && pendingApproval !== undefined && pendingApproval.stepId === 'review-spec'
  const hasRevise = reviewEntries.some((entry) => entry.verdict === 'revise')

  if (!awaitingApproval && !hasRevise && reviewEntries.length === 1 && reviewEntries[0]!.verdict === 'pass') {
    return { layout: 'accepted', latestSpec, cards: [] }
  }

  const groups = new Map<number, { spec?: SpecEntry; reviews: ReviewEntry[] }>()
  for (const entry of specEntries) groups.set(entry.revision, { spec: entry, reviews: [] })
  const unmatched: ReviewEntry[] = []
  for (const entry of reviewEntries) {
    if (entry.revision === undefined) {
      unmatched.push(entry)
      continue
    }
    const group = groups.get(entry.revision)
    if (group) group.reviews.push(entry)
    else groups.set(entry.revision, { reviews: [entry] })
  }

  const cards: SpecFeedCard[] = unmatched.map((entry) => ({ kind: 'review', entry }))
  for (const revision of [...groups.keys()].sort((a, b) => a - b)) {
    const group = groups.get(revision)!
    if (group.spec) {
      cards.push({ kind: 'spec', entry: group.spec, defaultExpanded: revision === latestSpec!.revision })
    }
    group.reviews.forEach((review, index) => {
      if (review === last && review.actor === 'agent' && review.verdict === 'pass' && awaitingApproval) {
        cards.push({ kind: 'awaiting', revision })
        return
      }
      if (review.actor === 'agent' && review.verdict === 'pass') {
        // Provisional: suppressed only if a LATER review in this same revision is a `revise`.
        const suppressed = group.reviews.slice(index + 1).some((r) => r.verdict === 'revise')
        if (suppressed) return
      }
      cards.push({ kind: 'review', entry: review })
    })
  }

  return { layout: 'feed', latestSpec, cards }
}

// ---- rendering ----------------------------------------------------------------------------

function SpecFeedView({ feed, pendingApproval }: { feed: SpecReviewFeedResponse; pendingApproval?: PendingApproval }) {
  const result = toFeedCards(feed.entries, pendingApproval)

  if (result.layout === 'empty') {
    return (
      <CenteredState
        icon={<FileTextIcon />}
        tone="neutral"
        heading="h2"
        title="No spec recorded for this task"
        subtitle="Nothing has written a spec yet, and there is no draft on disk to fall back to."
      />
    )
  }

  if (result.layout === 'spec-only' && result.latestSpec) {
    return (
      <div className="mx-auto w-full max-w-[var(--measure)] px-4 py-4 md:px-6">
        <SpecBody entry={result.latestSpec} />
      </div>
    )
  }

  if (result.layout === 'accepted' && result.latestSpec) {
    return (
      <div className="mx-auto w-full max-w-[var(--measure)] px-4 py-4 md:px-6">
        <p
          data-slot="spec-accepted-note"
          className="mb-3 flex items-center gap-1.5 text-[13px] text-muted-foreground"
        >
          <CheckIcon className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
          Reviewed — no changes requested.
        </p>
        <SpecBody entry={result.latestSpec} />
      </div>
    )
  }

  return (
    <div
      data-slot="spec-feed"
      className="mx-auto flex w-full max-w-[var(--measure)] flex-col gap-3 px-4 py-4 md:px-6"
    >
      {result.cards.map((card) => (
        <FeedCard key={cardKey(card)} card={card} />
      ))}
    </div>
  )
}

function cardKey(card: SpecFeedCard): string {
  if (card.kind === 'spec') return `spec-${card.entry.seq}`
  if (card.kind === 'review') return `review-${card.entry.seq}`
  return `awaiting-${card.revision ?? 'unmatched'}`
}

function FeedCard({ card }: { card: SpecFeedCard }) {
  if (card.kind === 'spec') return <SpecCard entry={card.entry} defaultExpanded={card.defaultExpanded} />
  if (card.kind === 'awaiting') {
    return (
      <div
        data-slot="spec-review-card"
        data-kind="awaiting"
        className="flex items-center gap-2 rounded-md border border-pending/30 bg-pending/10 px-3.5 py-2.5 text-[13px] text-muted-foreground"
      >
        <HourglassIcon className="size-3.5 shrink-0" aria-hidden="true" />
        agent review passed, awaiting human approval
      </div>
    )
  }
  return <ReviewCard entry={card.entry} />
}

/** A spec revision card — expanded by default only for the newest revision (Risk 5). A
 *  collapsed card renders its one-line header ONLY: `<Markdown>` (Streamdown) is never mounted
 *  until the card is opened, since a collapsed card that has already parsed and laid out a
 *  megabyte of markdown saves nothing (Risk 5's own wording). */
function SpecCard({ entry, defaultExpanded }: { entry: SpecEntry; defaultExpanded: boolean }) {
  const [open, setOpen] = useState(defaultExpanded)
  const size = entry.text !== undefined ? formatFileSize(entry.text.length) : undefined
  return (
    <section data-slot="spec-card" data-revision={entry.revision} className="rounded-md border border-border bg-card">
      <button
        type="button"
        data-slot="spec-card-toggle"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center gap-1.5 px-3.5 py-2.5 text-left text-[13px] font-medium hover:bg-muted"
      >
        {open ? (
          <ChevronDownIcon className="size-3.5 shrink-0 text-soft-foreground" aria-hidden="true" />
        ) : (
          <ChevronRightIcon className="size-3.5 shrink-0 text-soft-foreground" aria-hidden="true" />
        )}
        Spec, revision {entry.revision}
        {size ? ` · ${size}` : ''}
        {entry.truncated ? ' (truncated)' : ''}
      </button>
      {open ? (
        <div className="border-t border-border px-3.5 py-3">
          <SpecBody entry={entry} />
        </div>
      ) : null}
    </section>
  )
}

function SpecBody({ entry }: { entry: SpecEntry }) {
  if (entry.missing) {
    return (
      <p className="text-[13px] text-muted-foreground">
        {entry.rejected
          ? 'The declared spec path was refused — it points outside the worktree.'
          : 'No file was found at the declared spec path.'}
      </p>
    )
  }
  if (entry.text === undefined) return null
  return <Markdown>{entry.text}</Markdown>
}

/** A review card — always rendered expanded (Risk 5: reports are short and are the point).
 *  `data-actor` carries the human/agent distinction visually as well as structurally (P3 test
 *  19): a human's send-back and the agent's own verdict carry different authority and must
 *  never read the same. */
function ReviewCard({ entry }: { entry: ReviewEntry }) {
  const label = entry.verdict === 'pass' ? 'Reviewer approved' : 'Requested changes'
  return (
    <section
      data-slot="spec-review-card"
      data-actor={entry.actor}
      data-verdict={entry.verdict}
      className={cn(
        'rounded-md border px-3.5 py-2.5 text-[13px]',
        entry.actor === 'human'
          ? 'border-violet/30 bg-violet/10'
          : entry.verdict === 'revise'
            ? 'border-danger/20 bg-danger/10'
            : 'border-primary/20 bg-primary/10',
      )}
    >
      <p className="font-semibold">
        {label} <span className="font-normal text-muted-foreground">({entry.actor})</span>
      </p>
      {entry.revision === undefined ? (
        <p className="mt-1 text-muted-foreground">no draft was captured for this verdict</p>
      ) : null}
      <div className="mt-1.5">
        <Markdown>{entry.report}</Markdown>
      </div>
    </section>
  )
}
