import { useEffect, useMemo, useState } from 'react'
import { BookOpenIcon, SearchIcon, TriangleAlertIcon, XIcon } from 'lucide-react'

import { useWorkspaceKnowledgeDomains, useWorkspaceKnowledgeSearch } from '@/api/queries'
import type {
  WorkspaceKnowledgeDomain,
  WorkspaceKnowledgeProjectHealth,
  WorkspaceKnowledgeResult,
} from '@loki-labs/better-cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Link, scopeTo } from '@/lib/project-router'
import { cn } from '@/lib/utils'

/**
 * `/workspace/knowledge` — the cross-project knowledge landing view
 * (`.ai/specs/2026-08-14-knowledge-domains-and-changelog.md` Phase 3). **The landing view is the
 * domains list, not a search box** (D2, the spec's whole point): a domain document states current
 * state, so the page leads with "what domains exist and do they each have one", and search is
 * secondary, below it — the same subordination `workspace-git.tsx`'s ordering doc comment argues
 * for its own primary content.
 *
 * **Workspace-level, mounted OUTSIDE `ProjectScopeRoute`** — same placement, same scope trap, as
 * `workspace-git.tsx` and `workspace-tasks.tsx`. This file reads only `useWorkspaceKnowledgeDomains`
 * and `useWorkspaceKnowledgeSearch` — **never** a scope-led query or client function, verified by
 * `workspace-knowledge.test.tsx`'s request-log ALLOWLIST (the two workspace knowledge paths, not a
 * `/p/` blocklist — see `workspace-git.test.tsx`'s own doc comment for why a blocklist alone is not
 * sufficient: a project-scoped call made with no `ProjectScopeProvider` mounted goes out fully
 * UNSCOPED, e.g. `/api/v1/repo` with no `/p/` in it at all, and the server's own "no prefix"
 * convention silently answers with the boot project's data).
 *
 * **Two independent hazards this page exists to avoid, both drawn straight from the spec:**
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
 * **The index-document link, and a wire gap this page works around rather than papers over.**
 * `WorkspaceKnowledgeDomain` carries `indexDocId` but — unlike `WorkspaceKnowledgeResult`, which
 * wraps every document with the REGISTERED project it was found in — it carries no project for
 * that id. A `KnowledgeDocument.id` is opaque and per-project-store-scoped, and the per-project
 * reader lives at `/p/:projectId/knowledge/:id`, so a domain row cannot build a working href for
 * its own `indexDocId` with the data the `domains()` response actually supplies. Clicking a domain
 * row instead sets it as the active SEARCH filter (`activeDomain`); the search results for that
 * domain **do** carry `{project, document}` pairs, so the row whose `document.id === indexDocId`
 * gets a real, working link plus an "Index doc" badge (`SearchResultRow` below) — the same
 * information a direct href would have given, one click later. Flagged to the spec owner as a
 * follow-up: adding `indexDocProject` to `workspaceKnowledgeDomainSchema` would remove the detour.
 *
 * **A failed project renders as a visible row carrying its reason, never filtered out** — the same
 * degradation contract `workspace-git.tsx`'s `ProjectRow` enforces, read here from the `domains()`
 * response's own `projects: WorkspaceKnowledgeProjectHealth[]` (`ProjectHealthBanner` below).
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
      <div className="flex flex-1 flex-col">
        {domainsQuery.data === undefined ? (
          <p className="p-4 text-sm text-muted-foreground">Loading…</p>
        ) : domainsQuery.data.disabledReason ? (
          <DisabledState reason={domainsQuery.data.disabledReason} />
        ) : (
          <WorkspaceKnowledgeShell
            domains={domainsQuery.data.domains}
            projects={domainsQuery.data.projects}
          />
        )}
      </div>
    </div>
  )
}

/** Names WHICH of the two ANDed capabilities is off, and the exact env var plus restart — the one
 *  thing a generic "disabled" message cannot do (D6). */
function DisabledState({ reason }: { reason: 'knowledge' | 'workspaceViews' }) {
  const copy =
    reason === 'knowledge'
      ? {
          title: 'The knowledge base is off',
          subtitle: 'Set CEZ_KB=1 and restart cezar to turn it on.',
        }
      : {
          title: 'The cross-project workspace view is off',
          subtitle: 'Set CEZ_WORKSPACE_VIEWS=1 and restart cezar to turn it on.',
        }
  return (
    <div data-slot="workspace-knowledge-disabled" data-reason={reason} className="flex flex-1 flex-col p-3 md:p-5">
      <CenteredState icon={<BookOpenIcon />} tone="neutral" title={copy.title} subtitle={copy.subtitle} heading="h2" />
    </div>
  )
}

function WorkspaceKnowledgeShell({
  domains,
  projects,
}: {
  domains: readonly WorkspaceKnowledgeDomain[]
  projects: readonly WorkspaceKnowledgeProjectHealth[]
}) {
  const [activeDomain, setActiveDomain] = useState<string>()
  const [qInput, setQInput] = useState('')
  const [q, setQ] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => setQ(qInput.trim()), 250)
    return () => clearTimeout(timer)
  }, [qInput])

  const projectNames = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects])
  const activeDomainRow = activeDomain ? domains.find((d) => d.domain === activeDomain) : undefined

  return (
    <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-3 md:p-5">
      <ProjectHealthBanner projects={projects} />

      {domains.length === 0 ? (
        <CenteredState
          icon={<BookOpenIcon />}
          tone="neutral"
          title="No domains yet"
          subtitle="File a document with a `domain:` field in its front matter to see it here."
          heading="h2"
        />
      ) : (
        <ul data-testid="workspace-knowledge-domains" className="flex flex-col gap-2">
          {domains.map((domain) => (
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
      />
    </div>
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
}: {
  q: string
  onQChange: (value: string) => void
  activeDomain?: string
  activeDomainIndexDocId?: string
  onClearDomain: () => void
  searchQuery: string
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
              key={result.document.id}
              result={result}
              isIndexDoc={result.document.id === activeDomainIndexDocId}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function SearchResultRow({ result, isIndexDoc }: { result: WorkspaceKnowledgeResult; isIndexDoc: boolean }) {
  return (
    <li data-project-id={result.project} data-doc-id={result.document.id}>
      <Link
        to={scopeTo(result.project, `/knowledge/${result.document.id}`)}
        className="flex flex-wrap items-center gap-1.5 rounded-md px-2 py-1.5 text-left hover:bg-accent/60"
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
