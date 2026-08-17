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
} from '@loki-labs/better-cezar-api-client'

import { WorkspaceKnowledgeRoute } from './workspace-knowledge'

/**
 * `/workspace/knowledge` (`.ai/specs/2026-08-17-workspace-knowledge-speed-preview.md`, Phase 2 —
 * rewrite of `.ai/specs/2026-08-14-knowledge-domains-and-changelog.md` Phase 3's own test file).
 * Rendered directly (not through `AppRoutes`), same convention as `workspace-git.test.tsx` — this
 * route mounts OUTSIDE `ProjectScopeRoute` and needs no `:projectId` param to resolve.
 *
 * The domain-list/project-health/disabled-state coverage below is carried over from the Phase 3
 * predecessor's test file (those surfaces did not change shape). New in this rewrite: a
 * search-result click stays on `/workspace/knowledge` and sets `?project=&doc=` instead of
 * navigating to the per-project page (the owner's "everything on one page" complaint), the right
 * pane renders the selected document via `GET /workspace/knowledge/document`, the domains list
 * shows a skeleton rather than a full-page "Loading…" while its query is in flight, the mobile
 * list/detail toggle, and the widened-but-still-scoped request allowlist.
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

function domainRow(domain: string): HTMLElement {
  const row = domainsList().querySelector(`[data-domain="${domain}"]`)
  if (!row) throw new Error(`no row for domain ${domain}`)
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

describe('the landing view is the domains list, not a search box', () => {
  it('renders one row per domain on load, before any search has run', async () => {
    stubFetch()
    renderKnowledge()
    await screen.findByText('billing')
    await screen.findByText('auth')
    expect(screen.queryByTestId('workspace-knowledge-search-results')).toBeNull()
  })
})

describe('a domain with documents but no index document', () => {
  it('still renders, visibly marked as lacking one — never dropped', async () => {
    stubFetch()
    renderKnowledge()
    await screen.findByText('billing')

    const withIndex = domainRow('billing')
    expect(withIndex.getAttribute('data-has-index-doc')).toBe('true')
    expect(within(withIndex).getByText('Index doc')).toBeTruthy()

    const withoutIndex = domainRow('auth')
    expect(withoutIndex.getAttribute('data-has-index-doc')).toBe('false')
    expect(within(withoutIndex).getByText('No index doc yet')).toBeTruthy()

    // Both rows exist — the row lacking an index document is not filtered out of the list.
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

describe('no full-page "Loading…" — the domains section alone shows a skeleton', () => {
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

describe('the scope trap', () => {
  it('requests only the workspace-level knowledge surface — an allowlist, not a `/p/` blocklist', async () => {
    const sent = stubFetch()
    renderKnowledge()
    await screen.findByText('billing')
    fireEvent.click(within(domainRow('billing')).getByText('billing'))
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
    fireEvent.click(within(domainRow('billing')).getByText('billing'))

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
    fireEvent.click(within(domainRow('billing')).getByText('billing'))
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
    // The list is still on screen too — this was a param change, not a route change.
    expect(domainRow('billing')).toBeTruthy()
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
