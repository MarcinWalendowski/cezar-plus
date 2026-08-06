import { Link2OffIcon, LinkIcon } from 'lucide-react'

import type { KnowledgeLink } from '@open-mercato/cezar-api-client'
import { Badge } from '@/components/ui/badge'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'

/**
 * `routes/knowledge/backlinks.tsx` (W1.10, central-hub PLAN, package table wave 1): the link
 * graph panel — outbound (this document's own links) and inbound (documents that link here).
 * **Presentational and prop-driven only** — no data fetching, no import from the shell. See
 * `.ai/specs/2026-08-06-knowledge-base-mounts-search.md` "UI/UX" → Leaves: "inbound and outbound
 * links, with unresolved and ambiguous links rendered as BROKEN rather than omitted. A hidden
 * broken link is a lie about the graph."
 *
 * Outbound links come straight off the document (`KnowledgeDocument.links`, already resolved
 * server-side by `knowledge/links.ts`, W1.3) — `resolved: false` here is a real fact about the
 * graph, not a loading state, and every entry renders, resolved or not.
 *
 * Inbound links are a different shape: the spec's nine routes carry only `backlinkCount` (an
 * integer) across the wire, never the resolved list of who links in — no route here returns it.
 * So `inbound` is optional: when the caller has resolved the list some other way it renders in
 * full; when it has only the count, the panel says exactly that ("N documents link here") rather
 * than fabricating rows; when it has neither, it says the count is not available rather than
 * reading absence as zero.
 */

/** A document that links TO the one being viewed — the reverse of `KnowledgeLink`. */
export interface KnowledgeBacklinkEntry {
  id: string
  slug: string
  title: string
}

export interface BacklinksPanelProps {
  /** This document's own explicit `links[]` + `[[wikilinks]]`, already resolved server-side. */
  outbound: KnowledgeLink[]
  /** Documents that link to this one. `undefined` means "not supplied" (renders the count only,
   *  via `backlinkCount`) — distinct from `[]`, a KNOWN zero. */
  inbound?: KnowledgeBacklinkEntry[]
  /** `KnowledgeDocument.backlinkCount` — shown even when `inbound` itself was not fetched. */
  backlinkCount?: number
  /** Builds a route-relative href for a resolved link's id. Omit to render resolved targets as
   *  inert text — this leaf carries no route knowledge (that's `routes.tsx`'s concern). */
  hrefForId?: (id: string) => string
  className?: string
}

export function BacklinksPanel({ outbound, inbound, backlinkCount, hrefForId, className }: BacklinksPanelProps) {
  return (
    <div data-slot="knowledge-backlinks" className={cn('flex flex-col gap-4', className)}>
      <OutboundLinks links={outbound} hrefForId={hrefForId} />
      <InboundLinks entries={inbound} count={backlinkCount} hrefForId={hrefForId} />
    </div>
  )
}

function OutboundLinks({ links, hrefForId }: { links: KnowledgeLink[]; hrefForId?: (id: string) => string }) {
  return (
    <section data-slot="knowledge-outbound-links">
      <h3 className="text-[11px] font-semibold tracking-wide text-soft-foreground uppercase">Links out</h3>
      {links.length === 0 ? (
        <p className="mt-1 text-[12px] text-soft-foreground">This document links to nothing else.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1.5">
          {links.map((link, index) => (
            <li key={`${link.target}-${index}`}>
              <OutboundLinkRow link={link} hrefForId={hrefForId} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function OutboundLinkRow({ link, hrefForId }: { link: KnowledgeLink; hrefForId?: (id: string) => string }) {
  if (link.resolved && link.id) {
    const href = hrefForId?.(link.id)
    return (
      <div data-slot="knowledge-link" data-resolved="true" className="flex items-center gap-2 text-[13px]">
        <LinkIcon aria-hidden="true" className="size-3.5 shrink-0 text-soft-foreground" />
        {href ? (
          <Link to={href} className="min-w-0 truncate underline-offset-2 hover:underline">
            {link.target}
          </Link>
        ) : (
          <span className="min-w-0 truncate">{link.target}</span>
        )}
      </div>
    )
  }

  // Unresolved or ambiguous: rendered BROKEN, never omitted — "a hidden broken link is a lie
  // about the graph."
  const ambiguous = link.reason === 'ambiguous' && (link.candidates?.length ?? 0) > 0
  return (
    <div
      data-slot="knowledge-link"
      data-resolved="false"
      data-broken="true"
      data-reason={link.reason ?? 'unresolved'}
      className="flex flex-col gap-0.5 text-[13px]"
    >
      <div className="flex items-center gap-2 text-destructive">
        <Link2OffIcon aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate line-through decoration-destructive/60">{link.target}</span>
        <Badge variant="destructive" className="shrink-0 text-[10px]">
          {ambiguous ? 'ambiguous' : 'broken'}
        </Badge>
      </div>
      {ambiguous && (
        <p className="pl-5 text-[11px] text-soft-foreground">Could mean: {link.candidates!.join(', ')}</p>
      )}
    </div>
  )
}

function InboundLinks({
  entries,
  count,
  hrefForId,
}: {
  entries?: KnowledgeBacklinkEntry[]
  count?: number
  hrefForId?: (id: string) => string
}) {
  return (
    <section data-slot="knowledge-inbound-links">
      <h3 className="text-[11px] font-semibold tracking-wide text-soft-foreground uppercase">Links in</h3>
      {entries !== undefined ? (
        entries.length === 0 ? (
          <p className="mt-1 text-[12px] text-soft-foreground">No documents link here yet.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1.5">
            {entries.map((entry) => {
              const href = hrefForId?.(entry.id)
              return (
                <li
                  key={entry.id}
                  data-slot="knowledge-link"
                  data-resolved="true"
                  className="flex items-center gap-2 text-[13px]"
                >
                  <LinkIcon aria-hidden="true" className="size-3.5 shrink-0 text-soft-foreground" />
                  {href ? (
                    <Link to={href} className="min-w-0 truncate underline-offset-2 hover:underline">
                      {entry.title}
                    </Link>
                  ) : (
                    <span className="min-w-0 truncate">{entry.title}</span>
                  )}
                </li>
              )
            })}
          </ul>
        )
      ) : count !== undefined ? (
        <p className="mt-1 text-[12px] text-soft-foreground">
          {count} document{count === 1 ? '' : 's'} link here.
        </p>
      ) : (
        <p className="mt-1 text-[12px] text-soft-foreground">Backlink count not available.</p>
      )}
    </section>
  )
}
