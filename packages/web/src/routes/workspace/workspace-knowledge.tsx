import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { ArrowLeftIcon, BookOpenIcon, SearchIcon, SearchXIcon, TriangleAlertIcon, XIcon } from 'lucide-react'

import {
  useHealth,
  useWorkspaceKnowledgeDocument,
  useWorkspaceKnowledgeDomains,
  useWorkspaceKnowledgeSearch,
} from '@/api/queries'
import type {
  WorkspaceKnowledgeDomain,
  WorkspaceKnowledgeProjectHealth,
  WorkspaceKnowledgeResult,
} from '@loki-labs/better-cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { workspaceViewsOffSubtitle } from '@/lib/capability-copy'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Link, scopeTo } from '@/lib/project-router'
import { cn } from '@/lib/utils'

/**
 * `/workspace/knowledge` — the cross-project knowledge landing view, rewritten to the Skills-
 * parity list + right-pane layout (`.ai/specs/2026-08-17-workspace-knowledge-speed-preview.md`,
 * Phase 2 — follow-up to `.ai/specs/2026-08-14-knowledge-domains-and-changelog.md` Phase 3, whose
 * doc comment this one supersedes below). Two owner complaints drove the rewrite: **(1)** a
 * search-result click navigated to a different PAGE (`/p/:projectId/knowledge?doc=…`), losing the
 * domain list and the search context — "everything should be on one page"; **(2)** the page took
 * ~5s to show anything, a full-page "Loading…" the whole time (fixed on the SERVER side, D1/D5's
 * `findBySlug`/memoized search index — see `knowledge-index.ts`/`store.ts` — this file's own half
 * of the fix is simply to never gate the shell behind that fetch in the first place).
 *
 * **Selection lives in `?project=<id>&doc=<id>` on THIS pathname, never a navigation.** A search
 * result or a domain's index-doc badge sets both params via an in-page `Link`; the right pane
 * fetches and renders the target through `useWorkspaceKnowledgeDocument` (a workspace-scoped read,
 * `getDocument()` on `WorkspaceKnowledgeIndex` — never the per-project `/p/:projectId/knowledge/:id`
 * route). `location.pathname` never changes on a row click — that IS the fix for complaint (1).
 * `DocumentReader` (`routes/knowledge/document.tsx`) is reused unmodified, lazy-loaded for the same
 * reason `knowledge.tsx` lazy-loads it: the ~140 KB markdown stack only pays for itself once a
 * document actually opens. Its `hrefForId` is bound to the CURRENTLY selected project — a
 * superseded-trail or "superseded by" target is always a document in the SAME project's store, so
 * this keeps every such link on-page too, never falling back to the old per-project navigation.
 * A secondary **"Open in `<project>` →"** link (`scopeTo`, the old per-project href) survives next
 * to the reader header — the old navigation, demoted from the only affordance to an escape hatch.
 *
 * **No full-page "Loading…".** The shell — header, domain list container, search box — renders on
 * the very first paint; only the domain LIST itself shows skeleton rows
 * (`DomainsSkeleton`) while `useWorkspaceKnowledgeDomains` is in flight. Before this rewrite the
 * whole page was gated behind `domainsQuery.data === undefined`, so the ~5s server-side cost (now
 * fixed) rendered as several seconds of a blank page with one line of text — exactly the
 * "incremental loading" the owner asked for, answered here by never hiding the shell rather than
 * by paginating a 727-byte response (see the spec's TLDR for why pagination was never the fix).
 *
 * **Two independent hazards this page still exists to avoid, both drawn straight from the spec
 * this file's Phase 3 predecessor introduced, unchanged by the rewrite:**
 *
 * 1. **A domain with documents but no index document must render, visibly, as one without an
 *    index** (`DomainRow`'s `indexDocId` branch below) — the server deliberately returns that row
 *    (D1: "a domain with entries but no index document is a real state the page must show
 *    honestly rather than hide"), so filtering it out here would undo exactly what the server went
 *    to the trouble of preserving.
 * 2. **`disabledReason` must reach the user, naming which of the two ANDed flags is off** (D6: "a
 *    single message cannot say which conjunct is false"). `DisabledState` below renders two
 *    genuinely different messages — `CEZ_KB=1` vs `CEZ_WORKSPACE_VIEWS=1` — not one generic "off"
 *    collapsing both, because a user who flips the wrong flag and restarts would otherwise see the
 *    identical blank page and have no way to tell what happened.
 *
 * **A failed project renders as a visible row carrying its reason, never filtered out** — the same
 * degradation contract `workspace-git.tsx`'s `ProjectRow` enforces, read here from the `domains()`
 * response's own `projects: WorkspaceKnowledgeProjectHealth[]` (`ProjectHealthBanner` below).
 *
 * **Scope trap (`workspace-knowledge.test.tsx`'s "the scope trap" describe block).** Mounted
 * OUTSIDE `ProjectScopeRoute`, same placement as `workspace-git.tsx`/`workspace-tasks.tsx`. This
 * file reads only `useWorkspaceKnowledgeDomains`, `useWorkspaceKnowledgeSearch` and (new in this
 * rewrite) `useWorkspaceKnowledgeDocument` — all three workspace-level, never a scope-led query or
 * client function. The test asserts an ALLOWLIST of the exact paths this page may request (not a
 * `/p/` blocklist alone — see `workspace-git.test.tsx`'s own doc comment for why a blocklist is not
 * sufficient on its own: an unscoped project-scoped call goes out with no `/p/` prefix at all).
 *
 * No push channel and no polling: see `useWorkspaceKnowledgeDomains`'s own doc comment in
 * `api/queries.ts` for why (the query client's "a stream justifies an interval" doctrine, and this
 * data has no stream yet).
 */
export function WorkspaceKnowledgeRoute() {
  const domainsQuery = useWorkspaceKnowledgeDomains()

  return (
    <div data-route="workspace-knowledge" className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 hidden h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-5 md:flex">
        <h1 className="text-base font-semibold">Knowledge</h1>
      </header>
      {domainsQuery.data?.disabledReason ? (
        <DisabledState reason={domainsQuery.data.disabledReason} />
      ) : (
        <WorkspaceKnowledgeShell
          domains={domainsQuery.data?.domains}
          projects={domainsQuery.data?.projects}
          domainsPending={domainsQuery.isPending}
        />
      )}
    </div>
  )
}

/** Names WHICH of the two ANDed capabilities is off, and the exact env var plus restart — the one
 *  thing a generic "disabled" message cannot do (D6). */
function DisabledState({ reason }: { reason: 'knowledge' | 'workspaceViews' }) {
  // Read here rather than threaded in: the two halves of the ANDed gate now need DIFFERENT kinds of
  // advice, and only the `workspaceViews` half depends on topology. `useHealth` is already cached
  // by every parent on this page, so this costs nothing.
  const health = useHealth()
  const copy =
    reason === 'knowledge'
      ? {
          title: 'The knowledge base is off',
          subtitle: 'Set CEZ_KB=1 and restart cezar to turn it on.',
        }
      : {
          title: 'The cross-project workspace view is off',
          subtitle: workspaceViewsOffSubtitle(health.data?.capabilities?.singleProject),
        }
  return (
    <div data-slot="workspace-knowledge-disabled" data-reason={reason} className="flex flex-1 flex-col p-3 md:p-5">
      <CenteredState icon={<BookOpenIcon />} tone="neutral" title={copy.title} subtitle={copy.subtitle} heading="h2" />
    </div>
  )
}

/** A route-relative selection href for THIS page — pathname never changes, only the two query
 *  params do. Every in-page link below (`SearchResultRow`, `DomainRow`'s index-doc jump, a
 *  superseded-trail entry inside the reader) goes through this one function. */
function selectionHref(project: string, doc: string): string {
  return `/workspace/knowledge?project=${encodeURIComponent(project)}&doc=${encodeURIComponent(doc)}`
}

const LazyDocumentReader = lazy(() =>
  import('../knowledge/document').then((module) => ({ default: module.DocumentReader })),
)

function WorkspaceKnowledgeShell({
  domains,
  projects,
  domainsPending,
}: {
  domains: readonly WorkspaceKnowledgeDomain[] | undefined
  projects: readonly WorkspaceKnowledgeProjectHealth[] | undefined
  domainsPending: boolean
}) {
  const [searchParams] = useSearchParams()
  const selectedProject = searchParams.get('project')
  const selectedDoc = searchParams.get('doc')
  const hasSelection = selectedProject !== null && selectedDoc !== null

  const [activeDomain, setActiveDomain] = useState<string>()
  const [qInput, setQInput] = useState('')
  const [q, setQ] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => setQ(qInput.trim()), 250)
    return () => clearTimeout(timer)
  }, [qInput])

  const projectNames = useMemo(() => new Map((projects ?? []).map((p) => [p.id, p.name])), [projects])
  const activeDomainRow = activeDomain ? domains?.find((d) => d.domain === activeDomain) : undefined

  return (
    <div data-slot="workspace-knowledge-section" className="flex min-h-full flex-1 items-stretch">
      {/* List pane. Below md it IS the page until a selection is in the URL — the Skills tab's
          two-surfaces-one-URL rule (`routes/knowledge/knowledge.tsx`, copied here). */}
      <section
        data-slot="workspace-knowledge-list"
        className={cn(
          'w-full flex-col border-border md:flex md:w-[320px] md:shrink-0 md:border-r',
          'md:sticky md:top-14 md:max-h-[calc(100dvh-(var(--spacing)*14))] md:overflow-y-auto',
          hasSelection ? 'hidden md:flex' : 'flex',
        )}
      >
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-3 md:p-5">
          <ProjectHealthBanner projects={projects ?? []} />

          {domainsPending ? (
            <DomainsSkeleton />
          ) : (domains ?? []).length === 0 ? (
            <CenteredState
              icon={<BookOpenIcon />}
              tone="neutral"
              title="No domains yet"
              subtitle="File a document with a `domain:` field in its front matter to see it here."
              heading="h2"
            />
          ) : (
            <ul data-testid="workspace-knowledge-domains" className="flex flex-col gap-2">
              {(domains ?? []).map((domain) => (
                <DomainRow
                  key={domain.domain}
                  domain={domain}
                  projectNames={projectNames}
                  active={domain.domain === activeDomain}
                  onSelect={() => setActiveDomain(domain.domain)}
                />
              ))}
            </ul>
          )}

          <SearchSection
            q={qInput}
            onQChange={setQInput}
            activeDomain={activeDomain}
            activeDomainIndexDocId={activeDomainRow?.indexDocId}
            onClearDomain={() => setActiveDomain(undefined)}
            searchQuery={q}
            selectedProject={selectedProject}
            selectedDoc={selectedDoc}
          />
        </div>
      </section>

      {/* Detail pane. Hidden below md until the URL carries a selection. */}
      <section
        data-slot="workspace-knowledge-detail"
        className={cn('min-w-0 flex-1 flex-col', hasSelection ? 'flex' : 'hidden md:flex')}
      >
        <div className="min-w-0 flex-1 px-4 py-4 md:px-7 md:py-5">
          <Link
            to="/workspace/knowledge"
            data-slot="workspace-knowledge-back"
            className="mb-3 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground md:hidden"
          >
            <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
            Back to the list
          </Link>

          <DetailPane project={selectedProject} doc={selectedDoc} />
        </div>
      </section>
    </div>
  )
}

/** Skeleton rows shaped like `DomainRow` — renders while `useWorkspaceKnowledgeDomains` is in
 *  flight, so the shell (header, this container, the search box below it) is on screen from the
 *  first paint instead of a full-page "Loading…" (the spec's own "no incremental loading" fix). */
function DomainsSkeleton() {
  return (
    <ul data-testid="workspace-knowledge-domains-skeleton" className="flex flex-col gap-2">
      {Array.from({ length: 4 }, (_, i) => (
        <li key={i} className="flex items-center gap-3 rounded-md border border-border bg-card p-3">
          <Skeleton className="size-4 shrink-0 rounded-full" />
          <Skeleton className="h-4 flex-1" />
        </li>
      ))}
    </ul>
  )
}

/** A failed project is a visible row carrying its reason, never a silently shorter list — the
 *  `workspace-git.tsx#ProjectRow` degradation contract, applied to this endpoint's own
 *  `projects: WorkspaceKnowledgeProjectHealth[]`. Renders nothing when every project answered ok,
 *  same as an empty list would. */
function ProjectHealthBanner({ projects }: { projects: readonly WorkspaceKnowledgeProjectHealth[] }) {
  const failed = projects.filter((p) => !p.ok)
  if (failed.length === 0) return null
  return (
    <ul data-testid="workspace-knowledge-project-health" className="flex flex-col gap-1.5">
      {failed.map((project) => (
        <li
          key={project.id}
          data-project-id={project.id}
          data-ok="false"
          className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2.5"
        >
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-sm font-medium">{project.name}</span>
            <span data-slot="workspace-knowledge-project-reason" className="text-xs text-destructive">
              {project.reason}
            </span>
          </div>
        </li>
      ))}
    </ul>
  )
}

function DomainRow({
  domain,
  projectNames,
  active,
  onSelect,
}: {
  domain: WorkspaceKnowledgeDomain
  projectNames: Map<string, string>
  active: boolean
  onSelect: () => void
}) {
  return (
    <li
      data-domain={domain.domain}
      data-has-index-doc={domain.indexDocId !== undefined}
      className={cn(
        'flex flex-col gap-1.5 rounded-md border border-border bg-card p-3 sm:flex-row sm:items-center sm:gap-3',
        active && 'border-primary/50 bg-accent/40',
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 flex-col gap-1.5 text-left sm:flex-row sm:items-center sm:gap-3"
      >
        <div className="flex min-w-0 items-center gap-2 sm:w-48 sm:shrink-0">
          <BookOpenIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium">{domain.domain}</span>
        </div>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-xs text-muted-foreground">
            {domain.docCount} {domain.docCount === 1 ? 'document' : 'documents'}
          </span>
          <span className="flex flex-wrap items-center gap-1">
            {domain.projects.map((id) => (
              <Badge key={id} variant="outline" className="text-[10px]">
                {projectNames.get(id) ?? id}
              </Badge>
            ))}
          </span>
          <span
            data-slot="workspace-knowledge-domain-index"
            className={cn('text-xs', domain.indexDocId ? 'text-foreground' : 'text-muted-foreground italic')}
          >
            {domain.indexDocId ? 'Index doc' : 'No index doc yet'}
          </span>
        </div>
      </button>
    </li>
  )
}

function SearchSection({
  q,
  onQChange,
  activeDomain,
  activeDomainIndexDocId,
  onClearDomain,
  searchQuery,
  selectedProject,
  selectedDoc,
}: {
  q: string
  onQChange: (value: string) => void
  activeDomain?: string
  activeDomainIndexDocId?: string
  onClearDomain: () => void
  searchQuery: string
  selectedProject: string | null
  selectedDoc: string | null
}) {
  const enabled = searchQuery !== '' || activeDomain !== undefined
  const search = useWorkspaceKnowledgeSearch({ q: searchQuery || undefined, domain: activeDomain }, enabled)
  const results = search.data?.results ?? []

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={q}
            onChange={(event) => onQChange(event.target.value)}
            placeholder="Search knowledge across every project…"
            aria-label="Search knowledge across every project"
            data-slot="workspace-knowledge-search-input"
            className="pl-8"
          />
        </div>
        {activeDomain && (
          <button
            type="button"
            onClick={onClearDomain}
            data-slot="workspace-knowledge-domain-filter"
            className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {activeDomain} <XIcon className="size-3" />
          </button>
        )}
      </div>

      {!enabled ? (
        <p className="text-xs text-muted-foreground">Type a query or pick a domain above to search.</p>
      ) : search.isPending ? (
        <p className="text-xs text-muted-foreground">Searching…</p>
      ) : results.length === 0 ? (
        <p className="text-xs text-muted-foreground">No documents match.</p>
      ) : (
        <ul data-testid="workspace-knowledge-search-results" className="flex flex-col gap-1">
          {results.map((result) => (
            <SearchResultRow
              key={`${result.project}-${result.document.id}`}
              result={result}
              isIndexDoc={result.document.id === activeDomainIndexDocId}
              active={result.project === selectedProject && result.document.id === selectedDoc}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function SearchResultRow({
  result,
  isIndexDoc,
  active,
}: {
  result: WorkspaceKnowledgeResult
  isIndexDoc: boolean
  active: boolean
}) {
  return (
    <li data-project-id={result.project} data-doc-id={result.document.id}>
      <Link
        to={selectionHref(result.project, result.document.id)}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'flex flex-wrap items-center gap-1.5 rounded-md px-2 py-1.5 text-left hover:bg-accent/60',
          active && 'bg-accent/60',
        )}
      >
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">{result.document.title}</span>
        {isIndexDoc && (
          <Badge data-slot="workspace-knowledge-index-doc-badge" variant="default" className="shrink-0 text-[10px] uppercase">
            Index doc
          </Badge>
        )}
        <Badge variant="outline" className="shrink-0 text-[10px] uppercase">
          {result.project}
        </Badge>
        {result.document.domain && (
          <Badge variant="outline" className="shrink-0 text-[10px] uppercase">
            {result.document.domain}
          </Badge>
        )}
      </Link>
    </li>
  )
}

function DetailPane({ project, doc }: { project: string | null; doc: string | null }) {
  if (project === null || doc === null) {
    return (
      <CenteredState
        icon={<BookOpenIcon />}
        tone="neutral"
        title="No document selected"
        subtitle="Pick a domain or a search result on the left to preview it here."
        heading="h2"
      />
    )
  }
  return <DocumentDetail project={project} doc={doc} />
}

function DocumentDetail({ project, doc }: { project: string; doc: string }) {
  const documentQuery = useWorkspaceKnowledgeDocument(project, doc)

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
    <div data-slot="workspace-knowledge-document" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="uppercase">
          {project}
        </Badge>
        <Link
          to={scopeTo(project, `/knowledge?doc=${encodeURIComponent(doc)}`)}
          data-slot="workspace-knowledge-open-in-project"
          className="text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          Open in {project} →
        </Link>
      </div>
      <Suspense fallback={<p className="flex-1 p-6 text-center text-[13px] text-soft-foreground">Loading document…</p>}>
        <LazyDocumentReader document={document} hrefForId={(id) => selectionHref(project, id)} />
      </Suspense>
    </div>
  )
}
