import { Suspense, lazy, useEffect, useState } from 'react'
import { useParams } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { BookOpenIcon, SearchXIcon, TriangleAlertIcon } from 'lucide-react'

import { queryScope, type KnowledgeDocument, type KnowledgeFacetBucket } from '@open-mercato/cezar-api-client'
import { searchKnowledge } from '@/api/client'
import { queryKeys, useHealth, useKnowledge, useKnowledgeDocument } from '@/api/queries'
import { subscribeTopic } from '@/api/ws'
import { CenteredState } from '@/components/centered-state'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'

import { KnowledgeLoading } from './knowledge-loading'

/**
 * `/p/:projectId/knowledge` and `/p/:projectId/knowledge/:id` (F1, central-hub PLAN, package
 * table wave 2, `CEZ_KB=1`). Fills the placeholder the scaffold (W1.1) left in this file; see
 * `.ai/specs/2026-08-06-knowledge-base-mounts-search.md` "UI/UX (the cockpit surface)" for the
 * shell's contract, which this sticks to exactly:
 *
 *  - a **facet rail** (type, tag, status, root) built from `GET /knowledge`'s `facets`;
 *  - a **search box** that drives `GET /knowledge/search` (route 2);
 *  - a **result list** showing title, root, a status pill, a **conflict pill driven by
 *    `source.state`**, matched identifiers, and the hit's headings (so a human can reformulate
 *    after a cross-vocabulary miss, same reason the CLI's empty-result contract exists);
 *  - a **lazily loaded Markdown reader**, composed from the W1.10 leaf (`document.tsx`) rather
 *    than re-rendering Markdown here: `React.lazy` so the ~140 KB markdown stack it pulls in
 *    (`Markdown` from `task-thread/markdown`, the same weight `TaskThreadRoute` exists to keep
 *    out of the main bundle) loads only once a document is actually opened, not on every visit
 *    to `/knowledge`;
 *  - a subscription to the `knowledge` WebSocket topic, demand-driven like every other topic
 *    (`server/ws.ts:11`), held only while this shell is mounted.
 *
 * Editor (`editor.tsx`) and backlinks (`backlinks.tsx`) are deliberately NOT composed here: the
 * spec's shell bullet list above stops at the reader, and `editor.tsx`'s `onSave` would have
 * nowhere real to send a `PUT` yet: every knowledge mutator still answers a fixed 409 (D19),
 * and `client.ts` states outright that "mutator wrappers are deliberately NOT added yet" pending
 * the wave that gives each family a real success response. Wiring an editor against that would
 * be building a Save button that cannot save.
 *
 * `queryKeys.knowledgeSearch(query.q)` (`api/queries.ts`, W1.1-owned, not editable here) keys
 * the search query on `q` ALONE. A facet-only change (type/tag/status/root) would leave that
 * key unchanged, so TanStack Query would never re-fetch. Rather than reuse it, the search query
 * below is defined inline with every filter folded into the key, still `queryScope()`-led like
 * every other knowledge key. Flagged for the orchestrator rather than patched: `queries.ts` is
 * outside this package's ownership.
 */

const LazyDocumentReader = lazy(() =>
  import('./document').then((module) => ({ default: module.DocumentReader })),
)

/** Route-relative; `Link` (`@/lib/project-router`) scopes it to the active project on the way out. */
function hrefForId(id: string): string {
  return `/knowledge/${id}`
}

export function KnowledgeRoute() {
  const health = useHealth()
  const knowledgeAvailable = health.data?.capabilities?.knowledge === true
  const knowledgeOff = health.data !== undefined && !knowledgeAvailable

  // Not yet known whether the flag is even on. The same loading state the route would show
  // while fetching, so nothing flashes an "off" or "on" state and then corrects itself.
  if (health.isPending) return <KnowledgeLoading />

  return (
    <div data-route="knowledge" className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 hidden h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-5 md:flex">
        <h1 className="text-base font-semibold">Knowledge</h1>
        {!knowledgeOff && (
          <p className="text-[13px] text-soft-foreground">Specs, notes and mirrored sources, indexed in place.</p>
        )}
      </header>
      {knowledgeOff ? (
        <div className="flex flex-1 flex-col p-3 md:p-5">
          <CenteredState
            icon={<BookOpenIcon />}
            tone="neutral"
            title="The knowledge base is off"
            subtitle="Set CEZ_KB=1 and restart cezar to turn it on."
            heading="h2"
          />
        </div>
      ) : (
        <KnowledgeShell />
      )}
    </div>
  )
}

function KnowledgeShell() {
  const { id } = useParams<{ id?: string }>()
  const queryClient = useQueryClient()

  // Demand-driven: held only while this shell is mounted, like every other topic subscriber.
  useEffect(() => {
    return subscribeTopic('knowledge', () => {
      // The parent key ([queryScope(), 'knowledge']) prefix-matches the search key below too
      // (non-exact invalidation), so one call refreshes facets, the open document AND the
      // current search results.
      void queryClient.invalidateQueries({ queryKey: queryKeys.knowledge })
    })
  }, [queryClient])

  const [qInput, setQInput] = useState('')
  const [q, setQ] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => setQ(qInput.trim()), 250)
    return () => clearTimeout(timer)
  }, [qInput])

  const [type, setType] = useState<string>()
  const [tag, setTag] = useState<string>()
  const [status, setStatus] = useState<string>()
  const [root, setRoot] = useState<string>()

  const knowledgeQuery = useKnowledge()
  const facets = knowledgeQuery.data?.facets

  const searchParams = { q: q || undefined, type, tag, status, root, limit: 50 }
  const searchQuery = useQuery({
    queryKey: [queryScope(), 'knowledge', 'search', searchParams] as const,
    queryFn: ({ signal }) => searchKnowledge(searchParams, { signal }),
  })
  // Read through `data?.results ?? []` rather than branching on `isPending`/`isError` alone:
  // a query key that is a fresh object literal every render (needed so a facet-only change
  // still produces a real cache miss, see the doc block above) can observably report
  // `isPending: false` on a render where `data` has not caught up yet, and indexing straight
  // into `.results` there would crash the shell instead of degrading to "no results yet".
  const results = searchQuery.data?.results ?? []

  return (
    <div className="flex flex-1 overflow-hidden">
      <div
        className={cn(
          'flex w-full flex-col overflow-y-auto border-border md:w-[340px] md:shrink-0 md:border-r',
          id !== undefined && 'hidden md:flex',
        )}
      >
        <div className="flex flex-col gap-3 border-b border-border p-3 md:p-4">
          <Input
            type="search"
            value={qInput}
            onChange={(event) => setQInput(event.target.value)}
            placeholder="Search knowledge…"
            aria-label="Search knowledge"
            data-slot="knowledge-search-input"
          />
          <FacetGroup
            label="Type"
            buckets={facets?.types ?? []}
            active={type}
            onToggle={(value) => setType((current) => (current === value ? undefined : value))}
          />
          <FacetGroup
            label="Status"
            buckets={facets?.statuses ?? []}
            active={status}
            onToggle={(value) => setStatus((current) => (current === value ? undefined : value))}
          />
          <FacetGroup
            label="Root"
            buckets={facets?.roots ?? []}
            active={root}
            onToggle={(value) => setRoot((current) => (current === value ? undefined : value))}
          />
          <FacetGroup
            label="Tag"
            buckets={facets?.tags ?? []}
            active={tag}
            onToggle={(value) => setTag((current) => (current === value ? undefined : value))}
          />
        </div>

        <div className="flex-1 overflow-y-auto">
          {searchQuery.isPending ? (
            <p className="p-4 text-center text-[12px] text-soft-foreground">Searching…</p>
          ) : searchQuery.isError ? (
            <p className="p-4 text-center text-[12px] text-destructive">{searchQuery.error.message}</p>
          ) : results.length === 0 ? (
            <p className="p-4 text-center text-[12px] text-soft-foreground">No documents match.</p>
          ) : (
            <ul data-slot="knowledge-results" className="flex flex-col">
              {results.map((document) => (
                <ResultRow key={document.id} document={document} active={document.id === id} />
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className={cn('flex flex-1 flex-col overflow-y-auto', id === undefined && 'hidden md:flex')}>
        <DetailPane id={id} />
      </div>
    </div>
  )
}

function FacetGroup({
  label,
  buckets,
  active,
  onToggle,
}: {
  label: string
  buckets: readonly KnowledgeFacetBucket[]
  active?: string
  onToggle: (value: string) => void
}) {
  if (buckets.length === 0) return null
  return (
    <div data-slot={`knowledge-facet-${label.toLowerCase()}`} className="flex flex-col gap-1.5">
      <h3 className="text-[11px] font-semibold tracking-wide text-soft-foreground uppercase">{label}</h3>
      <div className="flex flex-wrap gap-1.5">
        {buckets.map((bucket) => (
          <button
            key={bucket.value}
            type="button"
            onClick={() => onToggle(bucket.value)}
            aria-pressed={active === bucket.value}
          >
            <Badge variant={active === bucket.value ? 'default' : 'outline'} className="cursor-pointer">
              {bucket.value} <span className="opacity-70">({bucket.count})</span>
            </Badge>
          </button>
        ))}
      </div>
    </div>
  )
}

function ResultRow({ document, active }: { document: KnowledgeDocument; active: boolean }) {
  const conflict = document.source && document.source.state !== 'ok' ? document.source.state : undefined
  return (
    <li data-slot="knowledge-result" data-status={document.status} data-active={active}>
      <Link
        to={hrefForId(document.id)}
        className={cn(
          'flex flex-col gap-1 border-b border-border px-3 py-2.5 text-left hover:bg-accent/60 md:px-4',
          active && 'bg-accent',
        )}
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">{document.title}</span>
          <Badge variant="outline" className="shrink-0 text-[10px] uppercase">
            {document.root}
          </Badge>
          <Badge
            variant={document.status === 'superseded' ? 'destructive' : document.status === 'draft' ? 'secondary' : 'outline'}
            className="shrink-0 text-[10px] uppercase"
          >
            {document.status}
          </Badge>
          {conflict && (
            <Badge data-slot="knowledge-conflict-pill" variant="destructive" className="shrink-0 text-[10px] uppercase">
              {conflict}
            </Badge>
          )}
        </div>
        {document.identifiers.length > 0 && (
          <p data-slot="knowledge-result-identifiers" className="truncate text-[11px] text-soft-foreground">
            {document.identifiers.join(', ')}
          </p>
        )}
        {document.headings.length > 0 && (
          <p data-slot="knowledge-result-headings" className="truncate text-[11px] text-soft-foreground">
            {document.headings.slice(0, 3).join(' · ')}
          </p>
        )}
      </Link>
    </li>
  )
}

function DetailPane({ id }: { id?: string }) {
  const documentQuery = useKnowledgeDocument(id ?? '', id !== undefined)

  if (id === undefined) {
    return (
      <CenteredState
        icon={<BookOpenIcon />}
        tone="neutral"
        title="Select a document"
        subtitle="Search or browse the facets on the left."
        heading="h2"
      />
    )
  }

  if (documentQuery.isPending) {
    return <p className="flex-1 p-6 text-center text-[13px] text-soft-foreground">Loading document…</p>
  }

  if (documentQuery.isError) {
    return (
      <CenteredState
        icon={<TriangleAlertIcon />}
        tone="danger"
        title="Could not load this document"
        subtitle={documentQuery.error.message}
        heading="h2"
      />
    )
  }

  // `?.`, not a direct index: same reasoning as the search results above (`results`).
  const document = documentQuery.data?.document
  if (!document) {
    return (
      <CenteredState
        icon={<SearchXIcon />}
        tone="neutral"
        title="Document not found"
        subtitle="It may have been removed, or a reindex changed its id."
        heading="h2"
      />
    )
  }

  return (
    <>
      <div className="border-b border-border p-3 md:hidden">
        <Link
          to="/knowledge"
          className="text-[12px] font-medium text-soft-foreground underline decoration-border underline-offset-2 hover:text-foreground"
        >
          ← Back to results
        </Link>
      </div>
      <Suspense
        fallback={<p className="flex-1 p-6 text-center text-[13px] text-soft-foreground">Loading document…</p>}
      >
        <LazyDocumentReader document={document} hrefForId={hrefForId} className="p-4 md:p-6" />
      </Suspense>
    </>
  )
}
