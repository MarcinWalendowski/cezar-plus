import { Suspense, lazy, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeftIcon, BookOpenIcon, SearchXIcon, TriangleAlertIcon } from 'lucide-react'
import { Virtualizer } from 'virtua'

import { queryScope, type KnowledgeDocumentList, type KnowledgeFacetBucket } from '@loki-labs/better-cezar-api-client'
import { searchKnowledge } from '@/api/client'
import { queryKeys, useHealth, useKnowledge, useKnowledgeDocument, useKnowledgeDocuments } from '@/api/queries'
import { subscribeTopic } from '@/api/ws'
import { CenteredState } from '@/components/centered-state'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { filterKnowledgeDocs } from '@/lib/knowledge'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'

import { KnowledgeLoading } from './knowledge-loading'

/**
 * `/p/:projectId/knowledge` (skills-preview parity, `.ai/specs/2026-08-17-knowledge-skills-
 * preview-parity.md`) — reworked to open and search the same way the Skills page does
 * (`routes/skills.tsx`): the full catalog sits in a fixed 320px left pane, an un-debounced
 * filter narrows it client-side as you type, selection lives in the URL as `?doc=<id>`, and the
 * selected document renders in an always-present right-side preview pane on md+. `/knowledge/:id`
 * (the old selection shape) now redirects here (`routes.tsx`'s `KnowledgeDocRedirect`) rather
 * than routing.
 *
 * **Copied from Skills, faithfully:** the two-pane layout and its sticky/scroll classes
 * (skills.tsx:104-115, 202-235), the `?doc=`-in-URL selection with the fallback chain — explicit
 * param if it still exists in the FULL catalog, else the catalog's own first entry (most
 * recently updated), never rewriting the URL (skills.tsx:94-99) — and the mobile
 * list⇄detail toggle with its "Back to the list" link.
 *
 * **Kept knowledge-specific, deliberately NOT copied from Skills:**
 *  - the facet rail (Type/Status/Root/Domain/Tag, fed by `GET /knowledge`'s `facets`), ANDed
 *    with the text filter, all client-side;
 *  - `DocumentReader` (`document.tsx`) as the detail pane, lazy-loaded for the same reason as
 *    before — the ~140 KB markdown stack only pays for itself once a document actually opens;
 *  - the body stays a per-selection fetch (`GET /knowledge/:id` via `useKnowledgeDocument`) —
 *    the catalog (`GET /knowledge/documents`) never carries bodies, 2,066 of them would be many
 *    MB;
 *  - server-side BM25 search (`GET /knowledge/search`) survives as a FALLBACK: when a non-empty
 *    query's client-side filter (after facets) finds zero hits, a debounced request runs and its
 *    results render under a "Full-text matches" caption — the catalog fields cannot see body
 *    text, so this is what keeps that search reachable;
 *  - the `knowledge` WS topic subscription, demand-driven like every other topic, refreshing the
 *    facets, the catalog AND the open document on any corpus change (the parent query key prefix
 *    matches all three, see `queryKeys.knowledgeDocuments`'s doc comment).
 *
 * Row list is the same two-tier rule as every other virtua consumer in this repo
 * (`task-git/commit-list.tsx`, `task-thread/thread-scroller.tsx`, `components/diff/diff-
 * view.tsx`): flat with `content-visibility: auto` up to {@link KNOWLEDGE_VIRTUALIZE_THRESHOLD}
 * rows, `virtua` (`Virtualizer`, no explicit `scrollRef` — the default is "the direct parent
 * element of virtualizer", per virtua's own prop doc) past it. Unconditional virtualization was
 * tried and reverted: jsdom lays nothing out, so virtua's window is empty under jsdom's
 * zero-height viewport (the same caveat `commit-list.test.tsx` documents), which would make the
 * list's content untestable below the real corpus's 2,066-row scale. Virtualized rows are plain
 * `<div>`s, not `<li>`s — virtua inserts its own positioned wrapper between the list and its
 * children, which would break a `<ul>`/`<li>` parent/child contract.
 *
 * **Fixed after the runtime E2E on the real 2,066-doc corpus (`.ai/specs/2026-08-17-knowledge-
 * skills-preview-parity.md`, "fixes after runtime E2E" note), three defects:**
 *  1. The Tag facet alone had ~400 buckets with no cap, so the group rendered ~400 chips.
 *     `FacetGroup` now ranks buckets by count desc (the store itself returns them alpha-sorted,
 *     `KnowledgeStore.getFacets`) and shows the top {@link FACET_VISIBLE_CAP}, with a "+N more" /
 *     "Show fewer" toggle chip.
 *  2. That unbounded facet block sat OUTSIDE the scrollable rows container (as a `shrink-0`
 *     sibling above it), so its real height blew past the pane's `md:max-h-[...]` and the whole
 *     PAGE scrolled instead of the list pane — the right preview pane scrolled away with it.
 *     Copied skills.tsx's structure exactly: the filter input is the only `shrink-0` header now;
 *     everything else — facets, the "Full-text matches" caption, the rows — lives inside the ONE
 *     `min-h-0 flex-1 overflow-y-auto` region below it (`data-slot="knowledge-rows"`, same slot
 *     name as before, now scoped to the merged region), same container skills.tsx:142-152 scrolls
 *     its rows in.
 *  3. Because the facets now precede the rows inside that single scroll parent rather than
 *     rendering in their own unbounded block, virtua needs to know how far down its rows actually
 *     start — `startMargin`, the same prop `commit-list.tsx`/`thread-scroller.tsx` use for
 *     "content before the virtualizer in the same scroller", measured here via a `ResizeObserver`
 *     on the facets block (`facetsRef`) rather than those two files' window-resize listener, since
 *     facet height also changes on expand/collapse and on data arriving, not just on resize.
 */

/** Rows past which the list pane switches from flat to virtua — same threshold value as
 *  `commit-list.tsx`'s `COMMIT_VIRTUALIZE_THRESHOLD`, the closest precedent for a row that is
 *  more than a single fixed-height line. */
const KNOWLEDGE_VIRTUALIZE_THRESHOLD = 150

const LazyDocumentReader = lazy(() =>
  import('./document').then((module) => ({ default: module.DocumentReader })),
)

/** Route-relative; `Link` (`@/lib/project-router`) scopes it to the active project on the way
 *  out. `?doc=`, not a path segment — the skills-preview parity selection shape. */
function hrefForId(id: string): string {
  return `/knowledge?doc=${encodeURIComponent(id)}`
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
  const [searchParams] = useSearchParams()
  const queryClient = useQueryClient()

  // Demand-driven: held only while this shell is mounted, like every other topic subscriber.
  useEffect(() => {
    return subscribeTopic('knowledge', () => {
      // The parent key ([queryScope(), 'knowledge']) prefix-matches BOTH the catalog key below
      // (`queryKeys.knowledgeDocuments`) and the inline fallback-search key, so one call
      // refreshes facets, the full catalog, the fallback search AND the open document.
      void queryClient.invalidateQueries({ queryKey: queryKeys.knowledge })
    })
  }, [queryClient])

  // The instant, un-debounced value drives the client-side filter every keystroke (skills-page
  // parity — "no debounce"); the debounced twin gates the BM25 fallback fetch below, so typing
  // that stays client-side matched never fires a request.
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 250)
    return () => clearTimeout(timer)
  }, [query])

  const [type, setType] = useState<string>()
  const [tag, setTag] = useState<string>()
  const [status, setStatus] = useState<string>()
  const [root, setRoot] = useState<string>()
  const [domain, setDomain] = useState<string>()

  const knowledgeQuery = useKnowledge()
  const facets = knowledgeQuery.data?.facets

  const catalogQuery = useKnowledgeDocuments()
  const catalog = catalogQuery.data?.documents ?? []

  const facetFiltered = useMemo(
    () =>
      catalog.filter(
        (document) =>
          (type === undefined || document.type === type) &&
          (status === undefined || document.status === status) &&
          (root === undefined || document.root === root) &&
          (tag === undefined || document.tags.includes(tag)) &&
          (domain === undefined || document.domain === domain),
      ),
    [catalog, type, status, root, tag, domain],
  )

  const textFiltered = useMemo(() => filterKnowledgeDocs(facetFiltered, query), [facetFiltered, query])
  // Evaluated against the DEBOUNCED query, so the fallback decision (and its fetch) settle
  // together — the plain `textFiltered` above is what actually renders while typing.
  const debouncedTextFiltered = useMemo(
    () => filterKnowledgeDocs(facetFiltered, debouncedQuery),
    [facetFiltered, debouncedQuery],
  )
  const zeroHits = debouncedQuery !== '' && debouncedTextFiltered.length === 0

  // `knowledgeSearchQuerySchema` (server) has no `domain` param — BM25 search predates the
  // domain facet — so `domain` is applied as an extra client-side pass over the fallback's own
  // results rather than sent on the wire.
  const fallbackParams = { q: debouncedQuery || undefined, type, tag, status, root, limit: 50 }
  const fallbackQuery = useQuery({
    queryKey: [queryScope(), 'knowledge', 'search', fallbackParams] as const,
    queryFn: ({ signal }) => searchKnowledge(fallbackParams, { signal }),
    enabled: zeroHits,
  })
  const fallbackResults = useMemo(() => {
    const results = fallbackQuery.data?.results ?? []
    return domain === undefined ? results : results.filter((document) => document.domain === domain)
  }, [fallbackQuery.data, domain])

  const shown = zeroHits ? fallbackResults : textFiltered
  const virtualized = shown.length > KNOWLEDGE_VIRTUALIZE_THRESHOLD

  // The facets block (plus the "Full-text matches" caption) renders BEFORE the rows inside the
  // same scroll parent virtua measures against — `startMargin` tells it how much of that
  // parent's scrollTop=0 is already spoken for. `ResizeObserver`, not the window-resize listener
  // `commit-list.tsx`/`thread-scroller.tsx` use for their (page-level, static-height) headers:
  // this block's own height changes on data arrival and on the "+N more" toggle, neither of
  // which fires a window resize.
  const facetsRef = useRef<HTMLDivElement | null>(null)
  const [facetsHeight, setFacetsHeight] = useState(0)
  useLayoutEffect(() => {
    const el = facetsRef.current
    if (!el) return
    const measure = () => setFacetsHeight(el.getBoundingClientRect().height)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const param = searchParams.get('doc')
  // Explicit choice if it still exists in the FULL catalog, else the catalog's own first entry
  // (most recently updated — the server already sorts it that way), never the currently
  // FILTERED list's first — the skills.tsx fallback chain, copied faithfully (skills.tsx:94-99):
  // a search query that matches nothing must not blank the detail pane. Fallback selection never
  // rewrites the URL.
  const selection = param !== null && catalog.some((document) => document.id === param) ? param : (catalog[0]?.id ?? null)

  return (
    <div data-slot="knowledge-section" className="flex min-h-full flex-1 items-stretch">
      {/* List pane. Below md it IS the page until a selection is in the URL — the Skills tab's
          two-surfaces-one-URL rule. */}
      <section
        data-slot="knowledge-list"
        className={cn(
          'w-full flex-col border-border md:flex md:w-[320px] md:shrink-0 md:border-r',
          'md:sticky md:top-14 md:max-h-[calc(100dvh-(var(--spacing)*14))]',
          param === null ? 'flex' : 'hidden md:flex',
        )}
      >
        {/* The ONLY `shrink-0` header — skills.tsx's rule (skills.tsx:117-140), so nothing above
            the scroll region below can ever grow past the pane's `md:max-h-[...]` and force the
            page itself to scroll. */}
        <div className="flex shrink-0 items-center gap-2 border-b border-border p-3 pb-2">
          <Input
            data-slot="knowledge-filter"
            placeholder="Filter documents…"
            aria-label="Filter documents"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-8 text-[13px]"
          />
        </div>

        {/* The ONE internal scroll region — facets scroll away with the rows, same container
            skills.tsx:142-152 scrolls its rows in. `facetsRef` measures its own rendered height so
            `<Virtualizer>` below knows how much of the scrollTop=0 origin it doesn't own
            (`startMargin`). */}
        <div
          data-slot="knowledge-rows"
          data-virtualized={virtualized}
          className="min-h-0 flex-1 overflow-y-auto px-3 pb-2"
        >
          <div ref={facetsRef} className="flex flex-col gap-3 pb-2">
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
              label="Domain"
              buckets={facets?.domains ?? []}
              active={domain}
              onToggle={(value) => setDomain((current) => (current === value ? undefined : value))}
            />
            <FacetGroup
              label="Tag"
              buckets={facets?.tags ?? []}
              active={tag}
              onToggle={(value) => setTag((current) => (current === value ? undefined : value))}
            />
            {zeroHits && shown.length > 0 && (
              <p className="text-[11px] font-semibold tracking-wide text-soft-foreground uppercase">
                Full-text matches
              </p>
            )}
          </div>

          {catalogQuery.isPending ? (
            <p className="px-2.5 py-2 text-[13px] text-soft-foreground">Loading…</p>
          ) : shown.length > 0 ? (
            virtualized ? (
              <Virtualizer startMargin={facetsHeight}>
                {shown.map((document) => (
                  <KnowledgeRow key={document.id} document={document} active={selection === document.id} />
                ))}
              </Virtualizer>
            ) : (
              shown.map((document) => (
                <div key={document.id} className="[content-visibility:auto]">
                  <KnowledgeRow document={document} active={selection === document.id} />
                </div>
              ))
            )
          ) : zeroHits && fallbackQuery.isPending ? (
            <p className="px-2.5 py-2 text-[13px] text-soft-foreground">Searching…</p>
          ) : (
            <p className="px-2.5 py-2 text-xs leading-relaxed text-soft-foreground">
              {catalog.length > 0 ? 'No documents match.' : 'No documents indexed yet.'}
            </p>
          )}
        </div>
      </section>

      {/* Detail pane. Hidden below md until the URL carries a selection. */}
      <section
        data-slot="knowledge-detail"
        className={cn('min-w-0 flex-1 flex-col', param === null ? 'hidden md:flex' : 'flex')}
      >
        <div className="min-w-0 flex-1 px-4 py-4 md:px-7 md:py-5">
          <Link
            to="/knowledge"
            data-slot="knowledge-back"
            className="mb-3 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground md:hidden"
          >
            <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
            Back to the list
          </Link>

          <DetailPane id={selection} catalogPending={catalogQuery.isPending} />
        </div>
      </section>
    </div>
  )
}

/** Chips beyond this many (ranked by count, see {@link FacetGroup}) collapse behind a "+N more"
 *  toggle. Without a cap a facet like Tag can carry hundreds of values (the real corpus's Tag
 *  group has ~400) and blow the list pane's height on its own — see the module doc comment's
 *  "fixes after runtime E2E" note, defect 1. */
const FACET_VISIBLE_CAP = 8

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
  const [expanded, setExpanded] = useState(false)
  if (buckets.length === 0) return null
  // `KnowledgeStore.getFacets` returns buckets alpha-sorted by value, not by count — rank here
  // so the cap below keeps the values that actually narrow the list, tie-broken alphabetically
  // for a stable order when counts match.
  const ranked = [...buckets].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
  const overflow = ranked.length > FACET_VISIBLE_CAP
  const visible = expanded ? ranked : ranked.slice(0, FACET_VISIBLE_CAP)
  return (
    <div data-slot={`knowledge-facet-${label.toLowerCase()}`} className="flex flex-col gap-1.5">
      <h3 className="text-[11px] font-semibold tracking-wide text-soft-foreground uppercase">{label}</h3>
      <div className="flex flex-wrap gap-1.5">
        {visible.map((bucket) => (
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
        {overflow && (
          <button
            type="button"
            data-slot="knowledge-facet-toggle"
            onClick={() => setExpanded((current) => !current)}
          >
            <Badge variant="outline" className="cursor-pointer text-soft-foreground">
              {expanded ? 'Show fewer' : `+${ranked.length - FACET_VISIBLE_CAP} more`}
            </Badge>
          </button>
        )}
      </div>
    </div>
  )
}

/** One row — SkillRow's shape (skills.tsx:240-277), copied with knowledge content: `BookOpenIcon`
 *  (matches the nav item) instead of `SparklesIcon`, prose title (no mono — knowledge titles are
 *  sentences, not identifiers), and the root/status/conflict badges the old `ResultRow` carried.
 *  A plain `<div>`, not an `<li>` — see the module doc comment on why virtua rules that out. */
function KnowledgeRow({ document, active }: { document: KnowledgeDocumentList; active: boolean }) {
  const conflict = document.source && document.source.state !== 'ok' ? document.source.state : undefined
  return (
    <Link
      to={hrefForId(document.id)}
      data-slot="knowledge-row"
      data-doc-id={document.id}
      data-status={document.status}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex flex-col gap-0.5 rounded-md px-2.5 py-2 transition-colors hover:bg-muted',
        active && 'bg-muted',
      )}
    >
      <span className="flex min-w-0 flex-wrap items-center gap-1.5">
        <BookOpenIcon aria-hidden="true" className="size-3.5 shrink-0 text-soft-foreground" />
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
      </span>
      {document.excerpt && <span className="line-clamp-2 pl-[22px] text-xs text-soft-foreground">{document.excerpt}</span>}
    </Link>
  )
}

function DetailPane({ id, catalogPending }: { id: string | null; catalogPending: boolean }) {
  const documentQuery = useKnowledgeDocument(id ?? '', id !== null)

  if (id === null) {
    if (catalogPending) {
      return <p className="flex-1 p-6 text-center text-[13px] text-soft-foreground">Loading…</p>
    }
    return (
      <CenteredState
        icon={<BookOpenIcon />}
        tone="neutral"
        title="No documents yet"
        subtitle="Documents appear here once the knowledge base is indexed."
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

  // `?.`, not a direct index: a query key that is a fresh literal every render can observably
  // report `isPending: false` on a render where `data` has not caught up yet, same reasoning the
  // old inline search query here used to carry.
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
    <Suspense
      fallback={<p className="flex-1 p-6 text-center text-[13px] text-soft-foreground">Loading document…</p>}
    >
      <LazyDocumentReader document={document} hrefForId={hrefForId} />
    </Suspense>
  )
}
