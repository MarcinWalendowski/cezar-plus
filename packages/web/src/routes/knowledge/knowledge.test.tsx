import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { ProjectScopeProvider } from '@/api/project-scope-context'
import type {
  HealthResponse,
  KnowledgeDocument,
  KnowledgeDocumentResponse,
  KnowledgeDocumentsResponse,
  KnowledgeResponse,
  KnowledgeSearchResponse,
} from '@loki-labs/better-cezar-api-client'

import { KnowledgeRoute } from './knowledge'

/**
 * `knowledge.tsx` (skills-preview parity, `.ai/specs/2026-08-17-knowledge-skills-preview-
 * parity.md`). Phases-table acceptance: "list renders from the documents query, typing narrows
 * without any network call, zero-hit non-empty query flips to the BM25 fallback with the
 * 'Full-text matches' caption". Also proves every knowledge query key leads with `queryScope()`
 * and that no facet click ever re-fetches (facets are ANDed client-side against the catalog now,
 * not a server round trip).
 *
 * `/knowledge/:id` no longer routes to this component — it REDIRECTS to `/knowledge?doc=<id>`
 * (`routes.tsx`'s `KnowledgeDocRedirect`), covered in `routes.test.tsx`, not here. This file only
 * ever mounts `/knowledge`, selecting through `?doc=`.
 *
 * Paths, explained once rather than per test: with no `ProjectScopeProvider` mounted (the
 * default here, matching the house style in `github.test.tsx`), `getApiScope()` is `null` and
 * `client.ts`'s `unscoped()` deliberately collapses the `/p/default` spelling `hc` always builds
 * down to the unprefixed path, so requests land on plain `/api/v1/knowledge...`, not
 * `/api/v1/p/default/knowledge...`. The "scoped requests" test below mounts
 * `ProjectScopeProvider` with a REAL project id specifically to observe the prefixed spelling.
 */

beforeEach(() => {
  // virtua measures with a ResizeObserver; jsdom has none and never lays anything out — same
  // stub as `commit-list.test.tsx` / `thread-scroller.test.tsx` / `diff-virtualize.test.tsx`.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// ---- fixtures ----------------------------------------------------------------------------------

const BOOT = 'default'

const HEALTH_ON: HealthResponse = {
  version: '0.1.3',
  repoRoot: '/home/u/cezar',
  repo: { root: '/home/u/cezar', branch: 'main' },
  defaultRunner: 'claude',
  checks: [],
  forge: null,
  capabilities: {
    localHandoff: true,
    tokenMetrics: true,
    tokenUsageMetrics: true,
    costMetrics: true,
    followups: true,
    singleProject: false,
    automations: false,
    knowledge: true,
    sources: false,
    notes: false,
    workspaceViews: false,
    notify: false,
    accountUsage: false,
    skills: true,
  },
  projects: [{ id: BOOT, name: 'cezar' }],
  bootProject: BOOT,
}

const HEALTH_OFF: HealthResponse = {
  ...HEALTH_ON,
  capabilities: { ...HEALTH_ON.capabilities, knowledge: false },
}

const KNOWLEDGE_RESPONSE: KnowledgeResponse = {
  enabled: true,
  roots: [{ id: 'project', path: '/repo/.ai/cezar/knowledge', writable: true, indexed: true }],
  counts: { documents: 2, idCollisions: 0 },
  facets: {
    types: [
      { value: 'decision', count: 1 },
      { value: 'meeting', count: 1 },
    ],
    tags: [{ value: 'architecture', count: 1 }],
    statuses: [
      { value: 'current', count: 2 },
      { value: 'superseded', count: 0 },
    ],
    roots: [
      { value: 'project', count: 1 },
      { value: 'sources', count: 1 },
    ],
    domains: [{ value: 'platform', count: 1 }],
  },
  scan: { truncated: false, filesScanned: 2, bytesScanned: 200, skipped: 0 },
  formatVersion: 1,
}

const DOC_CURRENT_ID = 'project-aaa111aaa111'
const DOC_CONFLICT_ID = 'sources-bbb222bbb222'

const DOC_CURRENT_LIST = {
  id: DOC_CURRENT_ID,
  slug: 'product-capability-split',
  root: 'project',
  path: '/repo/.ai/cezar/knowledge/product-capability-split.md',
  title: 'Product capability split',
  type: 'decision' as const,
  tags: ['architecture'],
  domain: 'platform',
  status: 'current' as const,
  identifiers: ['SPEC-282'],
  updatedAt: '2026-08-06T11:55:00Z',
  hash: 'hash-current',
  bytes: 13047,
  headings: ['Problem', 'Solution'],
  excerpt: 'MCP servers attach per agent, so an actor could never scope a tool surface.',
  backlinkCount: 4,
}

const DOC_CONFLICT_LIST = {
  id: DOC_CONFLICT_ID,
  slug: 'mirrored-meeting-note',
  root: 'sources',
  path: '/repo/.ai/cezar/sources/meeting-note.md',
  title: 'Mirrored meeting note',
  type: 'meeting' as const,
  tags: [],
  status: 'current' as const,
  identifiers: [],
  updatedAt: '2026-08-06T11:50:00Z',
  hash: 'hash-conflict',
  bytes: 900,
  headings: [],
  excerpt: 'Notes from the sync.',
  backlinkCount: 0,
  source: {
    kind: 'notion',
    connectionId: 'conn_01J',
    externalId: '391b9863-7981-8152-bb4c-d2541a93787b',
    url: 'https://example.invalid/p/x',
    remoteVersion: '2026-08-06T11:40:00Z',
    origin: 'remote' as const,
    state: 'conflict' as const,
    mirroredAt: '2026-08-06T11:55:00Z',
    lossy: [],
  },
}

// Server order IS display order (`selection = catalog[0]?.id`, never re-sorted) — most recently
// updated first, matching what `GET /knowledge/documents` itself guarantees.
const CATALOG_RESPONSE: KnowledgeDocumentsResponse = {
  documents: [DOC_CURRENT_LIST, DOC_CONFLICT_LIST],
  total: 2,
  truncated: false,
}

const DOCUMENT_RESPONSE_CURRENT: KnowledgeDocumentResponse = {
  document: { ...DOC_CURRENT_LIST, links: [], body: '## Problem\n\nFull body text lives here.' },
}

const DOCUMENT_RESPONSE_CONFLICT: KnowledgeDocumentResponse = {
  document: { ...DOC_CONFLICT_LIST, links: [], body: 'Conflict document body.' },
}

/** Only reachable via the BM25 fallback — its title/excerpt deliberately share no words with the
 *  catalog fixtures above, so a query that matches it client-side-scores zero on the catalog. */
const DOC_BODY_ONLY: KnowledgeDocument = {
  id: 'project-ccc333ccc333',
  slug: 'ledger-reconciliation-notes',
  root: 'project',
  path: '/repo/.ai/cezar/knowledge/ledger-reconciliation-notes.md',
  title: 'Something else entirely',
  type: 'note',
  tags: [],
  status: 'current',
  identifiers: [],
  updatedAt: '2026-08-05T00:00:00Z',
  hash: 'hash-body-only',
  bytes: 400,
  headings: [],
  excerpt: 'A page about quarterly planning.',
  links: [],
  backlinkCount: 0,
}

const SEARCH_RESPONSE_LEDGER: KnowledgeSearchResponse = {
  query: 'ledger',
  total: 1,
  truncated: false,
  results: [DOC_BODY_ONLY],
}

const SEARCH_RESPONSE_CRED: KnowledgeSearchResponse = {
  query: 'cred',
  total: 1,
  truncated: false,
  results: [DOC_BODY_ONLY],
}

const SEARCH_RESPONSE_EMPTY: KnowledgeSearchResponse = { query: '', total: 0, truncated: false, results: [] }

/** A realistic long, ordinary-prose excerpt (300+ chars — the suite's other fixtures are all much
 *  shorter, which is exactly why the subsequence-tier bug this guards against never showed up in
 *  a component test before: `.ai/specs/2026-08-17-knowledge-skills-preview-parity.md`, "fixes
 *  after runtime E2E round 2"). "cred" is NOT a literal substring anywhere in it, but its letters
 *  occur in that order (c…loning, r…epository, r-e…pository, d…ependencies) — a subsequence
 *  `matchScore`'s bottom tier would have matched before `lib/knowledge.ts`'s fix. */
const LONG_EXCERPT =
  "The onboarding runbook walks a new teammate through cloning the repository, installing " +
  "dependencies with the workspace's package manager, wiring up the required environment " +
  'variables, and finally running the local development server before opening a pull ' +
  'request for review of the finished changes, once every automated check has passed cleanly.'

/** 12 tag buckets, ranked (count desc, `tag-01` highest) — the real corpus's Tag facet alone had
 *  ~400 buckets with no cap, which is what blew the list pane's height (fixes-after-runtime-E2E
 *  defect 1). 12 is enough to exercise the cap (8) without the fixture being unreadable. */
const MANY_TAG_BUCKETS = Array.from({ length: 12 }, (_, i) => ({
  value: `tag-${String(i + 1).padStart(2, '0')}`,
  count: 12 - i,
}))

// ---- fetch stub (house style: repo-git.test.tsx / github.test.tsx / skills.test.tsx) -----------

interface SentRequest {
  path: string
  method: string
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** `knowledgeBase`: the path prefix knowledge requests carry, `/knowledge` unscoped (the default
 *  here) or `/p/<id>/knowledge` under a mounted `ProjectScopeProvider`. */
function stubFetch(
  health: HealthResponse = HEALTH_ON,
  overrides: Record<string, () => Response | Promise<Response>> = {},
  knowledgeBase = '/knowledge',
): SentRequest[] {
  const sent: SentRequest[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input)
      const method = init.method ?? 'GET'
      sent.push({ path, method })

      const override = overrides[`${method} ${path}`]
      if (override) return override()

      if (method === 'GET' && path === '/api/v1/health') return jsonResponse(health)
      if (method === 'GET' && path === `/api/v1${knowledgeBase}`) return jsonResponse(KNOWLEDGE_RESPONSE)
      if (method === 'GET' && path === `/api/v1${knowledgeBase}/documents`) return jsonResponse(CATALOG_RESPONSE)
      if (method === 'GET' && path === `/api/v1${knowledgeBase}/${DOC_CURRENT_ID}`) {
        return jsonResponse(DOCUMENT_RESPONSE_CURRENT)
      }
      if (method === 'GET' && path === `/api/v1${knowledgeBase}/${DOC_CONFLICT_ID}`) {
        return jsonResponse(DOCUMENT_RESPONSE_CONFLICT)
      }
      if (method === 'GET' && path.startsWith(`/api/v1${knowledgeBase}/search`)) {
        const query = new URL(path, 'http://localhost').searchParams
        if (query.get('q') === 'ledger') return jsonResponse(SEARCH_RESPONSE_LEDGER)
        if (query.get('q') === 'cred') return jsonResponse(SEARCH_RESPONSE_CRED)
        return jsonResponse(SEARCH_RESPONSE_EMPTY)
      }
      return jsonResponse({})
    }),
  )
  return sent
}

function renderAt(entry: string, projectId: string | null = null) {
  const tree = (
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/knowledge" element={<KnowledgeRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
  render(projectId === null ? tree : <ProjectScopeProvider projectId={projectId}>{tree}</ProjectScopeProvider>)
}

/** Waits for the catalog to have rendered. */
function waitForCatalog() {
  return waitFor(() => {
    expect(rowFor(DOC_CURRENT_ID)).toBeTruthy()
  })
}

/** The rendered row for a given document id, or `null`. Title text alone is ambiguous once a
 *  document is both listed AND selected — the same title renders again as the detail pane's
 *  `<h1>` — so every list-content assertion below goes through this rather than `getByText`. */
function rowFor(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-slot="knowledge-row"][data-doc-id="${id}"]`)
}

// ---- tests --------------------------------------------------------------------------------------

describe('KnowledgeRoute: flag off', () => {
  it('renders the disabled state and never calls /knowledge or /knowledge/documents', async () => {
    const sent = stubFetch(HEALTH_OFF)
    renderAt('/knowledge')

    await screen.findByText('The knowledge base is off')
    expect(sent.some((request) => request.path.includes('/knowledge'))).toBe(false)
  })
})

describe('KnowledgeRoute: catalog list (always populated, skills-preview parity)', () => {
  it('cold-loads the full catalog and previews the most-recently-updated document', async () => {
    stubFetch()
    renderAt('/knowledge')

    await waitForCatalog()
    expect(rowFor(DOC_CONFLICT_ID)).toBeTruthy()
    // No `?doc=` in the URL — the fallback chain selects the catalog's own first entry.
    await screen.findByText('Full body text lives here.')
  })

  it('shows a conflict pill only for a document whose source.state is not ok', async () => {
    stubFetch()
    renderAt('/knowledge')
    await waitForCatalog()

    expect(screen.getAllByText('conflict')).toHaveLength(1)
  })

  it('clicking a type facet narrows the list CLIENT-SIDE — no new request', async () => {
    const sent = stubFetch()
    renderAt('/knowledge')
    await waitForCatalog()
    const beforeCount = sent.length

    fireEvent.click(screen.getByRole('button', { name: /decision/i }))

    expect(rowFor(DOC_CURRENT_ID)).toBeTruthy()
    expect(rowFor(DOC_CONFLICT_ID)).toBeNull()
    // Give any accidental effect a tick to fire, then assert nothing new went out.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(sent.length).toBe(beforeCount)
  })

  it('typing a query that still matches narrows instantly and never calls the server', async () => {
    const sent = stubFetch()
    renderAt('/knowledge')
    await waitForCatalog()

    fireEvent.change(screen.getByLabelText('Filter documents'), { target: { value: 'Product' } })

    expect(rowFor(DOC_CURRENT_ID)).toBeTruthy()
    expect(rowFor(DOC_CONFLICT_ID)).toBeNull()

    // Past the 250ms fallback-debounce window — still no /search call, since the client filter
    // never went to zero hits.
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(sent.some((request) => request.path.startsWith('/api/v1/knowledge/search'))).toBe(false)
  })

  it('a zero-hit query flips to the BM25 fallback, captioned "Full-text matches"', async () => {
    // The catalog's current doc carries a realistic LONG excerpt (`LONG_EXCERPT`) rather than the
    // suite's usual short fixture text — that length is load-bearing: "cred" is a subsequence but
    // NOT a substring of it, which is the exact shape that broke the fallback against the real
    // corpus (2026-08-17 runtime E2E round 2, "NECP denial" — a phrase buried only in two docs'
    // bodies returned a pile of unrelated docs and never fired `/knowledge/search`, because
    // `matchScore`'s bottom tier is a subsequence match and short fixtures never reproduce the
    // coincidence). If `lib/knowledge.ts`'s substring gate ever regresses, this goes red: the
    // catalog doc scores non-zero again, `zeroHits` never flips true, and the assertions below —
    // both rows gone AND the search request firing — fail together.
    const sent = stubFetch(HEALTH_ON, {
      'GET /api/v1/knowledge/documents': () =>
        jsonResponse({
          documents: [{ ...DOC_CURRENT_LIST, excerpt: LONG_EXCERPT }, DOC_CONFLICT_LIST],
          total: 2,
          truncated: false,
        } satisfies KnowledgeDocumentsResponse),
    })
    renderAt('/knowledge')
    await waitForCatalog()

    fireEvent.change(screen.getByLabelText('Filter documents'), { target: { value: 'cred' } })

    // Neither catalog doc contains "cred" as a literal substring — confirms the zero-hit
    // precondition under the fixed matcher.
    await waitFor(() => {
      expect(rowFor(DOC_CURRENT_ID)).toBeNull()
      expect(rowFor(DOC_CONFLICT_ID)).toBeNull()
    })

    await waitFor(
      () => {
        expect(
          sent.some((request) => request.path.startsWith('/api/v1/knowledge/search') && request.path.includes('q=cred')),
        ).toBe(true)
      },
      { timeout: 2000 },
    )

    await screen.findByText('Full-text matches')
    expect(rowFor(DOC_BODY_ONLY.id)).toBeTruthy()
  })

  it('an empty catalog (once loaded) reads as "No documents indexed yet."', async () => {
    stubFetch(HEALTH_ON, {
      'GET /api/v1/knowledge/documents': () => jsonResponse({ documents: [], total: 0, truncated: false }),
    })
    renderAt('/knowledge')
    await screen.findByText('No documents indexed yet.')
  })
})

describe('KnowledgeRoute: the list pane scrolls, not the page (fixes after runtime E2E, defects 2+3)', () => {
  it('the scroll region carries the exact overflow classes that keep the page from scrolling, and both the facets and every row render inside it', async () => {
    stubFetch()
    renderAt('/knowledge')
    await waitForCatalog()

    const scrollRegion = document.querySelector('[data-slot="knowledge-rows"]')
    if (!scrollRegion) throw new Error('the knowledge-rows scroll region did not render')

    // Brittle by design, and deliberately so: this is the exact class combination that broke
    // when the facet block sat OUTSIDE this container as its own unbounded `shrink-0` sibling —
    // the pane's `md:max-h-[...]` had nothing to clip against, so the whole PAGE scrolled and
    // the right preview pane scrolled away with it. Losing `min-h-0`, `flex-1`, or
    // `overflow-y-auto` here silently reintroduces that bug rather than throwing, so it needs a
    // structural assertion, not just a content one.
    const classes = scrollRegion.className
    expect(classes).toContain('min-h-0')
    expect(classes).toContain('flex-1')
    expect(classes).toContain('overflow-y-auto')

    // Facets and rows are both genuinely NESTED inside that one region (not just present
    // somewhere in the document) — this is what makes them "scroll away with the rows" rather
    // than sitting in an unbounded header above the scroll area.
    expect(scrollRegion.querySelector('[data-slot="knowledge-facet-type"]')).not.toBeNull()
    expect(scrollRegion.contains(rowFor(DOC_CURRENT_ID))).toBe(true)
    expect(scrollRegion.contains(rowFor(DOC_CONFLICT_ID))).toBe(true)

    // The filter input is the ONLY thing left outside it (skills.tsx's fixed-header rule) —
    // it must NOT be inside the scroll region, or every keystroke would re-scroll it into view.
    const filterInput = screen.getByLabelText('Filter documents')
    expect(scrollRegion.contains(filterInput)).toBe(false)
  })
})

describe('KnowledgeRoute: facet chip cap (fixes after runtime E2E, defect 1)', () => {
  it('caps a facet group at 8 chips ranked by count, with a "+N more" toggle that expands and collapses', async () => {
    stubFetch(HEALTH_ON, {
      'GET /api/v1/knowledge': () =>
        jsonResponse({
          ...KNOWLEDGE_RESPONSE,
          facets: { ...KNOWLEDGE_RESPONSE.facets, tags: MANY_TAG_BUCKETS },
        } satisfies KnowledgeResponse),
    })
    renderAt('/knowledge')
    await waitForCatalog()

    const tagGroup = document.querySelector('[data-slot="knowledge-facet-tag"]')
    if (!tagGroup) throw new Error('the Tag facet group did not render')
    const tags = within(tagGroup as HTMLElement)

    // Top 8 by count (tag-01..tag-08) are visible; the rest collapse behind the toggle, and
    // counts stay visible on the chips that do render.
    expect(tags.getByRole('button', { name: /tag-01 \(12\)/ })).toBeTruthy()
    expect(tags.getByRole('button', { name: /tag-08 \(5\)/ })).toBeTruthy()
    expect(tags.queryByRole('button', { name: /tag-09/ })).toBeNull()
    expect(tags.getByRole('button', { name: '+4 more' })).toBeTruthy()

    fireEvent.click(tags.getByRole('button', { name: '+4 more' }))

    expect(tags.getByRole('button', { name: /tag-12 \(1\)/ })).toBeTruthy()
    expect(tags.getByRole('button', { name: 'Show fewer' })).toBeTruthy()

    fireEvent.click(tags.getByRole('button', { name: 'Show fewer' }))

    expect(tags.queryByRole('button', { name: /tag-09/ })).toBeNull()
    expect(tags.getByRole('button', { name: '+4 more' })).toBeTruthy()
  })

  it('does not render a toggle when a group has 8 or fewer values', async () => {
    stubFetch()
    renderAt('/knowledge')
    await waitForCatalog()

    // KNOWLEDGE_RESPONSE's Type facet has 2 values — well under the cap.
    const typeGroup = document.querySelector('[data-slot="knowledge-facet-type"]')
    if (!typeGroup) throw new Error('the Type facet group did not render')
    expect(typeGroup.querySelector('[data-slot="knowledge-facet-toggle"]')).toBeNull()
  })
})

describe('KnowledgeRoute: selection (?doc=), never rewriting the URL', () => {
  it('clicking a row selects it and renders its body on the right', async () => {
    stubFetch()
    renderAt('/knowledge')
    await waitForCatalog()

    fireEvent.click(rowFor(DOC_CONFLICT_ID)!)

    await screen.findByText('Conflict document body.')
  })

  it('an explicit ?doc= in the URL wins over the catalog default', async () => {
    stubFetch()
    renderAt(`/knowledge?doc=${DOC_CONFLICT_ID}`)
    await waitForCatalog()
    await screen.findByText('Conflict document body.')
  })

  it('a stale ?doc= id falls back to the catalog default rather than blanking the pane', async () => {
    stubFetch()
    renderAt('/knowledge?doc=does-not-exist-anymore')
    await waitForCatalog()
    // Falls back to the catalog's own first entry (DOC_CURRENT) — never "Document not found",
    // because the fallback chain checks against the FULL catalog, not the filtered list.
    await screen.findByText('Full body text lives here.')
  })

  it('scopes every knowledge request to the active project (facets, catalog, document AND search)', async () => {
    const sent = stubFetch(HEALTH_ON, {}, '/p/acme-corp/knowledge')
    renderAt(`/knowledge?doc=${DOC_CURRENT_ID}`, 'acme-corp')
    await waitForCatalog()
    await screen.findByText('Full body text lives here.')

    fireEvent.change(screen.getByLabelText('Filter documents'), { target: { value: 'ledger' } })
    await waitFor(() => {
      expect(sent.some((request) => request.path.startsWith('/api/v1/p/acme-corp/knowledge/search'))).toBe(true)
    })

    const knowledgeRequests = sent.filter((request) => request.path.includes('/knowledge'))
    expect(knowledgeRequests.length).toBeGreaterThan(0)
    for (const request of knowledgeRequests) {
      expect(request.path.startsWith('/api/v1/p/acme-corp/knowledge')).toBe(true)
    }
  })
})

describe('KnowledgeRoute: detail pane', () => {
  it('lazy-loads the reader and renders the body of the selected document', async () => {
    stubFetch()
    renderAt(`/knowledge?doc=${DOC_CURRENT_ID}`)

    const article = await screen.findByRole('article')
    expect(article.getAttribute('data-slot')).toBe('knowledge-document')
    await screen.findByText('Full body text lives here.')
  })

  it('reports "Document not found" when the id resolves in the catalog but the detail fetch races it gone', async () => {
    // The id IS in the catalog (so the selection chain picks it, not a fallback) — this is
    // specifically the detail fetch coming back null underneath a selection that looked valid.
    stubFetch(HEALTH_ON, {
      'GET /api/v1/knowledge/documents': () =>
        jsonResponse({ documents: [DOC_CURRENT_LIST], total: 1, truncated: false } satisfies KnowledgeDocumentsResponse),
      [`GET /api/v1/knowledge/${DOC_CURRENT_ID}`]: () =>
        jsonResponse({ document: null } satisfies KnowledgeDocumentResponse),
    })
    renderAt(`/knowledge?doc=${DOC_CURRENT_ID}`)
    await screen.findByText('Product capability split')
    await screen.findByText('Document not found')
  })
})
