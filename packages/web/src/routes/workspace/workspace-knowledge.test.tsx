import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type {
  KnowledgeDocument,
  WorkspaceKnowledgeDocumentResponse,
  WorkspaceKnowledgeDomainsResponse,
  WorkspaceKnowledgeResult,
  WorkspaceKnowledgeSearchResponse,
} from '@loki-labs/cezar-plus-api-client'

import { WorkspaceKnowledgeRoute } from './workspace-knowledge'

/**
 * `/workspace/knowledge` (`.ai/specs/2026-08-17-workspace-knowledge-speed-preview.md`, Phase 2 —
 * rewrite of `.ai/specs/2026-08-14-knowledge-domains-and-changelog.md` Phase 3's own test file —
 * and its "filters on top" amendment). Rendered directly (not through `AppRoutes`), same
 * convention as `workspace-git.test.tsx` — this route mounts OUTSIDE `ProjectScopeRoute` and needs
 * no `:projectId` param to resolve.
 *
 * The project-health/disabled-state coverage below is carried over from the Phase 3 predecessor's
 * test file (those surfaces did not change shape). Carried over from the original rewrite:
 * a search-result click stays on `/workspace/knowledge` and sets `?project=&doc=` instead of
 * navigating to the per-project page, the right pane renders the selected document via
 * `GET /workspace/knowledge/document`, and the widened-but-still-scoped request allowlist.
 *
 * **New in the amendment:** domains render as a compact chip row (not tall cards), so the
 * "domain with no index doc" test now checks the chip's `data-has-index-doc` attribute rather
 * than a caption (the caption moved to the pinned index-doc result row); the skeleton renders
 * chips, not cards; a layout describe block pins the structural DOM-order assertion (search input
 * above the chip row, outside the rows' scroll container); a chip-cap describe block covers the
 * "+N more" expander and the active-chip × clearing the filter; a pinned-index-doc-row describe
 * block covers the reorder.
 */

interface SentRequest {
  path: string
  method: string
}

function resultDoc(over: Partial<WorkspaceKnowledgeResult['document']> = {}): WorkspaceKnowledgeResult['document'] {
  return {
    id: 'shop-idx1',
    slug: 'billing',
    root: 'shop',
    path: '/abs/billing.md',
    title: 'Billing overview',
    type: 'reference',
    tags: [],
    status: 'current',
    identifiers: [],
    updatedAt: '2026-08-06T11:55:00Z',
    hash: 'deadbeef',
    bytes: 42,
    headings: [],
    excerpt: 'excerpt',
    links: [],
    backlinkCount: 0,
    ...over,
  }
}

/** The `/document` endpoint's own shape carries a `body` the search-result projection never does. */
function fullDocument(over: Partial<KnowledgeDocument> = {}): KnowledgeDocument {
  return { ...resultDoc(), body: 'Billing overview body content.', ...over }
}

const DOMAINS_RESPONSE: WorkspaceKnowledgeDomainsResponse = {
  domains: [
    { domain: 'billing', docCount: 3, projects: ['shop'], indexDocId: 'shop-idx1' },
    // No `indexDocId` — a domain with documents but no index document. The server deliberately
    // returns this row; the page must show it, never drop it (spec Verification table).
    { domain: 'auth', docCount: 1, projects: ['api'] },
  ],
  projects: [
    { id: 'shop', name: 'Shop', ok: true },
    { id: 'api', name: 'API', ok: true },
  ],
}

/** 10 domains, ranked by doc count desc — exercises the amendment's chip cap (top 8, "+2 more"). */
const DOMAINS_RESPONSE_MANY: WorkspaceKnowledgeDomainsResponse = {
  domains: Array.from({ length: 10 }, (_, i) => ({
    domain: `domain-${String(i).padStart(2, '0')}`,
    docCount: 10 - i,
    projects: ['shop'],
  })),
  projects: [{ id: 'shop', name: 'Shop', ok: true }],
}

const SEARCH_RESPONSE_BILLING: WorkspaceKnowledgeSearchResponse = {
  query: '',
  total: 2,
  truncated: false,
  results: [
    { project: 'shop', document: resultDoc({ id: 'shop-idx1', title: 'Billing overview', domain: 'billing' }) },
    {
      project: 'shop',
      document: resultDoc({ id: 'shop-other', slug: 'billing-edge-cases', title: 'Billing edge cases', domain: 'billing' }),
    },
  ],
  projects: [{ id: 'shop', name: 'Shop', ok: true }],
}

/** Same two documents as {@link SEARCH_RESPONSE_BILLING}, but the index doc (`shop-idx1`) is
 *  ranked SECOND by the server — proves the pinned-row reorder actually moves it, rather than
 *  merely happening to match an already-first result. */
const SEARCH_RESPONSE_BILLING_INDEX_DOC_RANKED_SECOND: WorkspaceKnowledgeSearchResponse = {
  ...SEARCH_RESPONSE_BILLING,
  results: [...SEARCH_RESPONSE_BILLING.results].reverse(),
}

const DOCUMENT_RESPONSES: Record<string, WorkspaceKnowledgeDocumentResponse> = {
  'shop:shop-idx1': { project: 'shop', document: fullDocument({ id: 'shop-idx1', title: 'Billing overview' }) },
  'shop:shop-other': {
    project: 'shop',
    document: fullDocument({ id: 'shop-other', slug: 'billing-edge-cases', title: 'Billing edge cases' }),
  },
  'shop:superseded-doc': {
    project: 'shop',
    document: fullDocument({
      id: 'superseded-doc',
      slug: 'old-billing-flow',
      title: 'Old billing flow',
      status: 'superseded',
      supersededBy: 'shop-idx1',
      supersededAt: '2026-08-06',
      body: 'The old body.',
    }),
  },
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Fetch stub in the house style (`workspace-git.test.tsx`): records every request's path and
 *  query PAIRS separately (the `/document` route is keyed by two query params, so a bare stripped
 *  path is not enough to route the stub), and serves the fixtures, with per-test overrides. */
function stubFetch({
  domainsResponse = DOMAINS_RESPONSE,
  searchResponse = SEARCH_RESPONSE_BILLING,
  documentResponses = DOCUMENT_RESPONSES,
  onDomainsRequest,
}: {
  domainsResponse?: WorkspaceKnowledgeDomainsResponse
  searchResponse?: WorkspaceKnowledgeSearchResponse
  documentResponses?: Record<string, WorkspaceKnowledgeDocumentResponse>
  /** Lets a test hold the domains response pending, to observe the skeleton state. */
  onDomainsRequest?: () => Promise<void> | void
} = {}): SentRequest[] {
  const sent: SentRequest[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), 'http://localhost')
      const path = url.pathname
      const method = init.method ?? 'GET'
      sent.push({ path, method })
      if (method === 'GET' && path === '/api/v1/workspace/knowledge/domains') {
        if (onDomainsRequest) await onDomainsRequest()
        return jsonResponse(domainsResponse)
      }
      if (method === 'GET' && path === '/api/v1/workspace/knowledge/search') return jsonResponse(searchResponse)
      if (method === 'GET' && path === '/api/v1/workspace/knowledge/document') {
        const project = url.searchParams.get('project') ?? ''
        const doc = url.searchParams.get('doc') ?? ''
        const response = documentResponses[`${project}:${doc}`]
        if (response) return jsonResponse(response)
        return jsonResponse({ error: 'no such document' }, 404)
      }
      return jsonResponse({ error: `unmocked ${method} ${url}` }, 404)
    }),
  )
  return sent
}

function LocationProbe() {
  const location = useLocation()
  return (
    <output data-testid="location">
      {location.pathname}
      {location.search}
    </output>
  )
}

function renderKnowledge(entry = '/workspace/knowledge') {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <WorkspaceKnowledgeRoute />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function domainsList(): HTMLElement {
  const el = document.querySelector('[data-testid="workspace-knowledge-domains"]')
  if (!el) throw new Error('the domains list has not rendered yet')
  return el as HTMLElement
}

function domainChip(domain: string): HTMLElement {
  const row = domainsList().querySelector(`[data-domain="${domain}"]`)
  if (!row) throw new Error(`no chip for domain ${domain}`)
  return row as HTMLElement
}

function locationText(): string {
  return screen.getByTestId('location').textContent ?? ''
}

/** jsdom applies no responsive class at all — see `workspace-tasks.test.tsx`'s own note. The
 *  list/detail panes are both literally in the DOM regardless of viewport, so the mobile toggle is
 *  asserted by reading the exact class TOKENS `cn()` produced, not by visibility. */
function classTokens(el: Element): string[] {
  return el.className.split(/\s+/).filter(Boolean)
}

describe('the landing view is the domains chip row, not a search box', () => {
  it('renders one chip per domain on load, before any search has run', async () => {
    stubFetch()
    renderKnowledge()
    await screen.findByText('billing')
    await screen.findByText('auth')
    expect(screen.queryByTestId('workspace-knowledge-search-results')).toBeNull()
  })
})

describe('a domain with documents but no index document', () => {
  it('still renders as a plain chip — never dropped from the row', async () => {
    stubFetch()
    renderKnowledge()
    await screen.findByText('billing')

    const withIndex = domainChip('billing')
    expect(withIndex.getAttribute('data-has-index-doc')).toBe('true')

    const withoutIndex = domainChip('auth')
    expect(withoutIndex.getAttribute('data-has-index-doc')).toBe('false')

    // Both chips exist — the domain lacking an index document is not filtered out of the row.
    expect(domainsList().querySelectorAll('[data-domain]')).toHaveLength(2)
  })
})

describe('a failed project', () => {
  it('renders as a visible row carrying its reason — never filtered out, never a footnote', async () => {
    stubFetch({
      domainsResponse: {
        ...DOMAINS_RESPONSE,
        projects: [
          { id: 'shop', name: 'Shop', ok: true },
          { id: 'api', name: 'API', ok: false, reason: 'root not found' },
        ],
      },
    })
    renderKnowledge()
    await screen.findByText('billing')
    const banner = document.querySelector('[data-testid="workspace-knowledge-project-health"]')
    if (!banner) throw new Error('the project health banner did not render')
    const row = banner.querySelector('[data-project-id="api"]')
    if (!row) throw new Error('no row for project api')
    expect(row.getAttribute('data-ok')).toBe('false')
    expect(within(row as HTMLElement).getByText('API')).toBeTruthy()
    expect(within(row as HTMLElement).getByText('root not found')).toBeTruthy()
  })

  it('renders no banner at all when every project answered ok — not a footnote, not an empty list either', async () => {
    stubFetch()
    renderKnowledge()
    await screen.findByText('billing')
    expect(screen.queryByTestId('workspace-knowledge-project-health')).toBeNull()
  })
})

describe('disabledReason reaches the user', () => {
  it('names CEZ_KB when the knowledge base itself is off', async () => {
    stubFetch({ domainsResponse: { domains: [], projects: [], disabledReason: 'knowledge' } })
    renderKnowledge()
    await screen.findByText('The knowledge base is off')
    expect(screen.getByText(/CEZ_KB=1/)).toBeTruthy()
    expect(screen.queryByTestId('workspace-knowledge-domains')).toBeNull()
  })

  it('names CEZ_WORKSPACE_VIEWS when only the cross-project view is off — a distinct message, not the same generic one', async () => {
    stubFetch({ domainsResponse: { domains: [], projects: [], disabledReason: 'workspaceViews' } })
    renderKnowledge()
    await screen.findByText('The cross-project workspace view is off')
    // `=0`, not `=1`: the flag inverted on 2026-08-16, and telling a user to SET a flag that is
    // already on by default is advice that cannot work — the same failure the single-project
    // branch of `workspaceViewsOffSubtitle` exists to avoid.
    expect(screen.getByText(/CEZ_WORKSPACE_VIEWS=0/)).toBeTruthy()
    expect(screen.queryByText('The knowledge base is off')).toBeNull()
    expect(screen.queryByTestId('workspace-knowledge-domains')).toBeNull()
  })
})

describe('no full-page "Loading…" — the chip row alone shows a skeleton', () => {
  it('renders the shell (header, search box) immediately, before the domains response has landed', async () => {
    let releaseDomains: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseDomains = resolve
    })
    stubFetch({ onDomainsRequest: () => gate })
    renderKnowledge()

    // The shell is up — search input present — while domains are still in flight.
    await screen.findByLabelText('Search knowledge across every project')
    expect(screen.queryByText('Loading…')).toBeNull()
    expect(screen.getByTestId('workspace-knowledge-domains-skeleton')).toBeTruthy()
    expect(screen.queryByTestId('workspace-knowledge-domains')).toBeNull()

    releaseDomains()
    await screen.findByText('billing')
    expect(screen.queryByTestId('workspace-knowledge-domains-skeleton')).toBeNull()
  })
})

describe('layout: search on top, results immediately visible (amendment)', () => {
  it('search input renders above the chip row, and outside the rows scroll container', async () => {
    stubFetch()
    renderKnowledge()
    await screen.findByText('billing')

    const input = screen.getByLabelText('Search knowledge across every project')
    const rows = document.querySelector('[data-slot="workspace-knowledge-rows"]')
    if (!rows) throw new Error('the rows scroll container did not render')

    // DOM order: the input precedes the rows container (and therefore the chip row inside it).
    const positionMask = input.compareDocumentPosition(rows)
    expect(Boolean(positionMask & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
    // The input is not nested inside the scrollable rows region at all.
    expect(rows.contains(input)).toBe(false)
    // The rows container is the one carrying the scroll classes — the same pin style
    // `knowledge.tsx`'s `knowledge-rows` container uses.
    expect(classTokens(rows)).toEqual(expect.arrayContaining(['overflow-y-auto', 'flex-1', 'min-h-0']))

    // The chip row lives inside the rows container, below the input.
    const chips = domainsList()
    expect(rows.contains(chips)).toBe(true)
  })

  it('the search input\'s own header is not the scrollable region', () => {
    stubFetch()
    renderKnowledge()
    const input = screen.getByLabelText('Search knowledge across every project')
    const header = input.closest('div.shrink-0')
    if (!header) throw new Error('search input header not found')
    expect(classTokens(header)).not.toContain('overflow-y-auto')
  })
})

describe('domain chip cap (amendment)', () => {
  it('shows the top 8 domains by doc count, with a "+2 more" expander for the rest', async () => {
    stubFetch({ domainsResponse: DOMAINS_RESPONSE_MANY })
    renderKnowledge()
    await screen.findByText('domain-00')

    const chips = domainsList().querySelectorAll('[data-domain]')
    expect(chips).toHaveLength(8)
    // Ranked by doc count desc — domain-00 (count 10) through domain-07 (count 3) are visible;
    // domain-08/09 (counts 2/1) are behind the toggle.
    expect(domainsList().querySelector('[data-domain="domain-07"]')).not.toBeNull()
    expect(domainsList().querySelector('[data-domain="domain-08"]')).toBeNull()
    expect(screen.getByText('+2 more')).toBeTruthy()
  })

  it('expanding the toggle reveals every domain and flips its own label', async () => {
    stubFetch({ domainsResponse: DOMAINS_RESPONSE_MANY })
    renderKnowledge()
    await screen.findByText('domain-00')

    fireEvent.click(screen.getByText('+2 more'))
    expect(domainsList().querySelectorAll('[data-domain]')).toHaveLength(10)
    expect(domainsList().querySelector('[data-domain="domain-09"]')).not.toBeNull()
    expect(screen.getByText('Show fewer')).toBeTruthy()
    expect(screen.queryByText('+2 more')).toBeNull()
  })
})

describe('the scope trap', () => {
  it('requests only the workspace-level knowledge surface — an allowlist, not a `/p/` blocklist', async () => {
    const sent = stubFetch()
    renderKnowledge()
    await screen.findByText('billing')
    fireEvent.click(domainChip('billing'))
    const results = await screen.findByTestId('workspace-knowledge-search-results')
    await waitFor(() => expect(results.querySelector('[data-doc-id="shop-idx1"]')).not.toBeNull())
    fireEvent.click(within(results.querySelector('[data-doc-id="shop-idx1"]') as HTMLElement).getByRole('link'))
    await screen.findByText('Billing overview body content.')

    const paths = new Set(sent.map((r) => r.path))
    const allowed = new Set([
      '/api/v1/health',
      '/api/v1/workspace/knowledge/domains',
      '/api/v1/workspace/knowledge/search',
      '/api/v1/workspace/knowledge/document',
    ])
    for (const path of paths) expect(allowed.has(path)).toBe(true)
    // The negative this test protects: no scope-led (`/api/v1/p/...`) request, ever.
    for (const path of paths) expect(path.startsWith('/api/v1/p/')).toBe(false)
    // Sanity: the allowlist itself was exercised, so the loops above are not vacuously true.
    expect(paths.has('/api/v1/workspace/knowledge/domains')).toBe(true)
    expect(paths.has('/api/v1/workspace/knowledge/document')).toBe(true)
  })
})

describe('search', () => {
  it('stays idle until a query is typed or a domain is picked — no request, no results list', async () => {
    const sent = stubFetch()
    renderKnowledge()
    await screen.findByText('billing')
    expect(screen.getByText('Type a query or pick a domain above to search.')).toBeTruthy()
    expect(screen.queryByTestId('workspace-knowledge-search-results')).toBeNull()
    expect(sent.some((r) => r.path === '/api/v1/workspace/knowledge/search')).toBe(false)
  })

  it('clicking a domain with an index document surfaces it with an "Index doc" badge, while a non-index result in the same domain gets neither', async () => {
    stubFetch()
    renderKnowledge()
    await screen.findByText('billing')
    fireEvent.click(domainChip('billing'))

    const results = await screen.findByTestId('workspace-knowledge-search-results')
    await waitFor(() => expect(results.querySelector('[data-doc-id="shop-idx1"]')).not.toBeNull())

    const indexRow = results.querySelector('[data-doc-id="shop-idx1"]') as HTMLElement
    expect(within(indexRow).getByText('Index doc')).toBeTruthy()

    const otherRow = results.querySelector('[data-doc-id="shop-other"]') as HTMLElement
    expect(within(otherRow).queryByText('Index doc')).toBeNull()
  })

  it('a row click keeps location.pathname on /workspace/knowledge and sets ?project&doc — never a navigation away', async () => {
    stubFetch()
    renderKnowledge()
    await screen.findByText('billing')
    fireEvent.click(domainChip('billing'))
    const results = await screen.findByTestId('workspace-knowledge-search-results')
    const indexRow = await waitFor(() => {
      const el = results.querySelector('[data-doc-id="shop-idx1"]')
      if (!el) throw new Error('row not rendered yet')
      return el as HTMLElement
    })
    const link = within(indexRow).getByRole('link')
    expect(link.getAttribute('href')).toBe('/workspace/knowledge?project=shop&doc=shop-idx1')

    fireEvent.click(link)
    await waitFor(() => expect(locationText()).toBe('/workspace/knowledge?project=shop&doc=shop-idx1'))
    // The chip row is still on screen too — this was a param change, not a route change.
    expect(domainChip('billing')).toBeTruthy()
  })

  it('clicking the active domain chip again clears the filter, back to the idle placeholder', async () => {
    stubFetch()
    renderKnowledge()
    await screen.findByText('billing')
    fireEvent.click(domainChip('billing'))
    await screen.findByTestId('workspace-knowledge-search-results')
    expect(domainChip('billing').getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(domainChip('billing'))
    expect(domainChip('billing').getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByText('Type a query or pick a domain above to search.')).toBeTruthy()
    expect(screen.queryByTestId('workspace-knowledge-search-results')).toBeNull()
  })
})

describe('pinned index-doc row (amendment)', () => {
  // The server now pins a browse-mode domain's own index document to the front of the FULL
  // result sequence BEFORE pagination (`WorkspaceKnowledgeIndex.search`, amendment follow-up) —
  // real-data evidence: alfredo's index doc never appeared in the first 20 (of 398) results
  // because a bulk import ties every doc on `updatedAt` and tie-breaks by id ascending, which
  // put the index doc many pages deep. So the REAL shape as of this fix is: it already arrives
  // first from the server. The client-side reorder below (`SearchResults`'s `orderedResults`)
  // stays as a defensive fallback — idempotent when the doc is already first, and still useful
  // for a response the client receives out of order for any other reason.
  it('marks the server-pinned index document data-pinned — the real shape now that the server itself puts it first', async () => {
    stubFetch() // SEARCH_RESPONSE_BILLING already returns shop-idx1 first, the server-pinned shape.
    renderKnowledge()
    await screen.findByText('billing')
    fireEvent.click(domainChip('billing'))

    const results = await screen.findByTestId('workspace-knowledge-search-results')
    await waitFor(() => expect(results.querySelectorAll('[data-doc-id]')).toHaveLength(2))

    const rows = results.querySelectorAll('li')
    expect(rows[0]?.getAttribute('data-doc-id')).toBe('shop-idx1')
    expect(rows[0]?.getAttribute('data-pinned')).toBe('true')
    expect(rows[1]?.getAttribute('data-doc-id')).toBe('shop-other')
    expect(rows[1]?.getAttribute('data-pinned')).toBe('false')
  })

  it('defensive fallback: still reorders it to the top if a response ever ranks it second', async () => {
    stubFetch({ searchResponse: SEARCH_RESPONSE_BILLING_INDEX_DOC_RANKED_SECOND })
    renderKnowledge()
    await screen.findByText('billing')
    fireEvent.click(domainChip('billing'))

    const results = await screen.findByTestId('workspace-knowledge-search-results')
    await waitFor(() => expect(results.querySelectorAll('[data-doc-id]')).toHaveLength(2))

    const rows = results.querySelectorAll('li')
    expect(rows[0]?.getAttribute('data-doc-id')).toBe('shop-idx1')
    expect(rows[0]?.getAttribute('data-pinned')).toBe('true')
    expect(rows[1]?.getAttribute('data-doc-id')).toBe('shop-other')
    expect(rows[1]?.getAttribute('data-pinned')).toBe('false')
  })

  it('pins nothing when no domain is active — a plain text search keeps server order', async () => {
    stubFetch()
    renderKnowledge()
    await screen.findByText('billing')

    const input = screen.getByLabelText('Search knowledge across every project')
    fireEvent.change(input, { target: { value: 'billing' } })

    const results = await screen.findByTestId('workspace-knowledge-search-results')
    await waitFor(() => expect(results.querySelectorAll('[data-doc-id]')).toHaveLength(2))
    for (const row of results.querySelectorAll('li')) expect(row.getAttribute('data-pinned')).toBe('false')
  })

  it('pins nothing for a domain with no index document', async () => {
    stubFetch({
      domainsResponse: {
        domains: [{ domain: 'auth', docCount: 1, projects: ['shop'] }],
        projects: [{ id: 'shop', name: 'Shop', ok: true }],
      },
      searchResponse: SEARCH_RESPONSE_BILLING,
    })
    renderKnowledge()
    await screen.findByText('auth')
    fireEvent.click(domainChip('auth'))

    const results = await screen.findByTestId('workspace-knowledge-search-results')
    await waitFor(() => expect(results.querySelectorAll('[data-doc-id]')).toHaveLength(2))
    for (const row of results.querySelectorAll('li')) expect(row.getAttribute('data-pinned')).toBe('false')
  })
})

describe('the right-pane document preview', () => {
  it('renders the selected document\'s title and body, fed by GET /workspace/knowledge/document', async () => {
    stubFetch()
    renderKnowledge('/workspace/knowledge?project=shop&doc=shop-idx1')
    await screen.findByText('Billing overview body content.')
    expect(screen.getAllByText('Billing overview').length).toBeGreaterThan(0)
  })

  it('shows a neutral empty state when nothing is selected yet', async () => {
    stubFetch()
    renderKnowledge()
    await screen.findByText('billing')
    expect(screen.getByText('No document selected')).toBeTruthy()
  })

  it('a superseded-trail link stays on-page, swapping the selection to the target document', async () => {
    stubFetch()
    renderKnowledge('/workspace/knowledge?project=shop&doc=superseded-doc')
    await screen.findByText('Old billing flow')
    const trailLink = screen.getByRole('link', { name: 'shop-idx1' })
    expect(trailLink.getAttribute('href')).toBe('/workspace/knowledge?project=shop&doc=shop-idx1')

    fireEvent.click(trailLink)
    await waitFor(() => expect(locationText()).toBe('/workspace/knowledge?project=shop&doc=shop-idx1'))
    await screen.findByText('Billing overview body content.')
  })

  it('"Open in <project>" links to the per-project page — the old navigation, demoted to an affordance', async () => {
    stubFetch()
    renderKnowledge('/workspace/knowledge?project=shop&doc=shop-idx1')
    await screen.findByText('Billing overview body content.')
    const openInLink = screen.getByText('Open in shop →')
    expect(openInLink.getAttribute('href')).toBe('/p/shop/knowledge?doc=shop-idx1')
  })

  it('an unregistered project or unknown doc id renders an error state, not a blank pane', async () => {
    stubFetch()
    renderKnowledge('/workspace/knowledge?project=shop&doc=no-such-doc')
    await screen.findByText('Could not load this document')
  })
})

describe('mobile list/detail toggle', () => {
  it('shows the list pane and hides the detail pane below md before a selection is made', async () => {
    stubFetch()
    renderKnowledge()
    await screen.findByText('billing')
    const list = document.querySelector('[data-slot="workspace-knowledge-list"]')
    const detail = document.querySelector('[data-slot="workspace-knowledge-detail"]')
    if (!list || !detail) throw new Error('panes did not render')
    expect(classTokens(list)).toContain('flex')
    expect(classTokens(list)).not.toContain('hidden')
    expect(classTokens(detail)).toContain('hidden')
  })

  it('hides the list pane and shows the detail pane below md once a selection is in the URL', async () => {
    stubFetch()
    renderKnowledge('/workspace/knowledge?project=shop&doc=shop-idx1')
    await screen.findByText('Billing overview body content.')
    const list = document.querySelector('[data-slot="workspace-knowledge-list"]')
    const detail = document.querySelector('[data-slot="workspace-knowledge-detail"]')
    if (!list || !detail) throw new Error('panes did not render')
    expect(classTokens(list)).toContain('hidden')
    expect(classTokens(detail)).toContain('flex')
    expect(classTokens(detail)).not.toContain('hidden')
  })

  it('the "Back to the list" link clears the selection, staying on /workspace/knowledge', async () => {
    stubFetch()
    renderKnowledge('/workspace/knowledge?project=shop&doc=shop-idx1')
    await screen.findByText('Billing overview body content.')
    const back = screen.getByText('Back to the list')
    expect(back.getAttribute('href')).toBe('/workspace/knowledge')
  })
})

describe('empty registry', () => {
  it('renders an honest empty state when the flags are on but no domains exist', async () => {
    stubFetch({ domainsResponse: { domains: [], projects: [] } })
    renderKnowledge()
    await screen.findByText('No domains yet')
  })
})
