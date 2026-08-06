import { HistoryIcon, TriangleAlertIcon } from 'lucide-react'

import type { KnowledgeDocument } from '@open-mercato/cezar-api-client'
import { Badge } from '@/components/ui/badge'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'
import { Markdown } from '@/routes/task-thread/markdown'

/**
 * `routes/knowledge/document.tsx` (W1.10, central-hub PLAN, package table wave 1): the knowledge
 * base reader. **Presentational and prop-driven only** — no data fetching, no import from the
 * cockpit shell (`knowledge.tsx`, W2.3 fills that in on its own schedule); the shell composes
 * this leaf once it exists. See
 * `.ai/specs/2026-08-06-knowledge-base-mounts-search.md` "UI/UX (the cockpit surface)" → Leaves.
 *
 * Two things the spec calls out by name, both satisfied here:
 *  - **A superseded banner** built from `status` + `supersededBy` + `supersededAt`, present
 *    exactly when `status === 'superseded'`, linking forward to the superseding document —
 *    "the point of marking a correction is telling the reader where to look next."
 *  - **A correction trail** when more than one supersede lead-in is present. The frontmatter
 *    only ever carries the LATEST `supersededBy`/`supersededAt` pair (the "Correction in place"
 *    apply algorithm, spec step 3, re-applying with a different `by` PREPENDS a second lead-in
 *    above the first rather than overwriting it) — the full history only exists as repeated
 *    `**Superseded <date> by <title> (<id>).** <note>` paragraphs at the top of the body, so
 *    recovering it means parsing the leading run of the body, which is exactly what
 *    {@link parseCorrectionTrail} does. The body itself is rendered unabridged below the banner —
 *    this never strips those paragraphs out, matching "leave every original byte below
 *    unchanged" (apply algorithm step 6): the trail is an additional structured summary, not a
 *    replacement for the text.
 *
 * Route knowledge (what a document id resolves to) belongs to `routes.tsx`, not this leaf — the
 * `hrefForId` prop is the same "caller supplies the href, the leaf only renders it" shape
 * `task-git/commit-list.tsx` already uses. Omitting it renders the target as plain, non-broken
 * text rather than inventing a route.
 */

export interface CorrectionTrailEntry {
  date: string
  byTitle: string
  byId: string
  note: string
}

/**
 * `**Superseded <date> by <by-title> (<by-id>).** <note>` — the exact template the apply
 * algorithm writes (spec "Correction in place: the supersede operation", step 5). `[^*]+?`
 * intentionally cannot cross into a second bold run, which is what keeps this from misreading an
 * ordinary bold sentence deeper in the body as a lead-in.
 */
const LEAD_IN_RE = /^\*\*Superseded ([^*]+?) by ([^*]+?) \(([^()]+)\)\.\*\*[ \t]*([\s\S]*)$/

/**
 * Parses the LEADING run of supersede lead-in paragraphs — stops at the first paragraph that
 * does not match, so nothing beyond that run is ever mistaken for a correction, and an ordinary
 * document (zero lead-ins) parses to `[]` with no special-casing needed at the call site.
 */
export function parseCorrectionTrail(body: string | undefined): CorrectionTrailEntry[] {
  if (!body) return []
  const trail: CorrectionTrailEntry[] = []
  for (const paragraph of body.split(/\n{2,}/)) {
    const match = LEAD_IN_RE.exec(paragraph.trim())
    if (!match) break
    const [, date, byTitle, byId, note] = match
    trail.push({
      date: (date ?? '').trim(),
      byTitle: (byTitle ?? '').trim(),
      byId: (byId ?? '').trim(),
      note: (note ?? '').trim(),
    })
  }
  return trail
}

export interface DocumentReaderProps {
  /** The full document, including `body` — only `GET /knowledge/:id` carries one; the caller
   *  decides when that fetch has happened. */
  document: KnowledgeDocument
  /** Builds a route-relative href for a document id (the superseding document, and each
   *  correction-trail entry's target). Omit to render those targets as inert text instead of a
   *  link — never a link to nowhere. */
  hrefForId?: (id: string) => string
  className?: string
}

export function DocumentReader({ document, hrefForId, className }: DocumentReaderProps) {
  const superseded = document.status === 'superseded'
  const trail = parseCorrectionTrail(document.body)

  return (
    <article
      data-slot="knowledge-document"
      data-status={document.status}
      className={cn('flex flex-col gap-4', className)}
    >
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="min-w-0 text-xl font-semibold break-words">{document.title}</h1>
          <Badge variant="outline" className="uppercase">
            {document.type}
          </Badge>
          <Badge
            variant={document.status === 'superseded' ? 'destructive' : document.status === 'draft' ? 'secondary' : 'outline'}
            className="uppercase"
          >
            {document.status}
          </Badge>
        </div>
        <p data-slot="knowledge-document-meta" className="text-[12px] text-soft-foreground">
          {document.root}/{document.slug} · updated {document.updatedAt}
          {document.project ? ` · ${document.project}` : ''}
        </p>
        {document.tags.length > 0 && (
          <ul className="flex flex-wrap gap-1">
            {document.tags.map((tag) => (
              <li key={tag}>
                <Badge variant="outline" className="text-[10px]">
                  {tag}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </header>

      {superseded && <SupersededBanner document={document} trail={trail} hrefForId={hrefForId} />}

      <div data-slot="knowledge-document-body" className="text-sm">
        {document.body !== undefined ? (
          <Markdown>{document.body}</Markdown>
        ) : (
          <p className="text-[13px] text-soft-foreground">This document has no content loaded.</p>
        )}
      </div>
    </article>
  )
}

function SupersededBanner({
  document,
  trail,
  hrefForId,
}: {
  document: KnowledgeDocument
  trail: CorrectionTrailEntry[]
  hrefForId?: (id: string) => string
}) {
  const target = document.supersededBy
  const href = target && hrefForId ? hrefForId(target) : undefined

  return (
    <div
      data-slot="knowledge-superseded-banner"
      className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-[13px]"
    >
      <div className="flex items-start gap-2">
        <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
        <p>
          Superseded{document.supersededAt ? ` ${document.supersededAt}` : ''}
          {target ? (
            <>
              {' by '}
              {href ? (
                <Link
                  to={href}
                  data-slot="knowledge-superseded-link"
                  className="font-semibold text-warning underline underline-offset-2 hover:no-underline"
                >
                  {target}
                </Link>
              ) : (
                <span data-slot="knowledge-superseded-link" className="font-semibold">
                  {target}
                </span>
              )}
            </>
          ) : null}
          . The point of marking a correction is telling you where to look next.
        </p>
      </div>

      {trail.length > 1 && (
        <ol
          data-slot="knowledge-correction-trail"
          className="flex flex-col gap-1.5 border-t border-warning/30 pt-2"
        >
          {trail.map((entry, index) => {
            const entryHref = hrefForId?.(entry.byId)
            return (
              <li
                key={`${entry.byId}-${index}`}
                data-slot="knowledge-correction-entry"
                className="flex items-start gap-2"
              >
                <HistoryIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-soft-foreground" />
                <span>
                  {entry.date} —{' '}
                  {entryHref ? (
                    <Link to={entryHref} className="underline underline-offset-2 hover:no-underline">
                      {entry.byTitle}
                    </Link>
                  ) : (
                    entry.byTitle
                  )}{' '}
                  <span className="text-soft-foreground">({entry.byId})</span>
                  {entry.note ? `: ${entry.note}` : ''}
                </span>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
