import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { WorkspaceKnowledgeDomainsResponse, WorkspaceKnowledgeResult, WorkspaceKnowledgeSearchResponse } from '@loki-labs/better-cezar-api-client'

import { WorkspaceKnowledgeRoute } from './workspace-knowledge'

/**
 * `/workspace/knowledge` (`.ai/specs/2026-08-14-knowledge-domains-and-changelog.md`, Phase 3).
 * Rendered directly (not through `AppRoutes`), same convention as `workspace-git.test.tsx` — this
 * route mounts OUTSIDE `ProjectScopeRoute` and needs no `:projectId` param to resolve.
 *
 * Rewritten from scratch against the component on disk after a duplicate-dispatch collision
 * overwrote the original file; this is not a byte-for-byte restore, but it covers the same four
 * hard requirements the spec assignment named (see each `describe` block below).
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

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Fetch stub in the house style (`workspace-git.test.tsx`): records every request with its query
 *  string stripped — matching what the request routing below keys on — and serves the fixtures,
 *  with per-test overrides. */
function stubFetch({
  domainsResponse = DOMAINS_RESPONSE,
  searchResponse = SEARCH_RESPONSE_BILLING,
}: {
  domainsResponse?: WorkspaceKnowledgeDomainsResponse
  searchResponse?: WorkspaceKnowledgeSearchResponse
} = {}): SentRequest[] {
  const sent: SentRequest[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)
      const path = url.split('?')[0]!
      const method = init.method ?? 'GET'
      sent.push({ path, method })
      if (method === 'GET' && path === '/api/v1/workspace/knowledge/domains') return jsonResponse(domainsResponse)
      if (method === 'GET' && path === '/api/v1/workspace/knowledge/search') return jsonResponse(searchResponse)
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

describe('the scope trap', () => {
  it('requests only the workspace-level knowledge surface — an allowlist, not a `/p/` blocklist', async () => {
    const sent = stubFetch()
    renderKnowledge()
    await screen.findByText('billing')
    const paths = new Set(sent.map((r) => r.path))
    const allowed = new Set(['/api/v1/health', '/api/v1/workspace/knowledge/domains', '/api/v1/workspace/knowledge/search'])
    for (const path of paths) expect(allowed.has(path)).toBe(true)
    // Sanity: the allowlist itself was exercised, so the loop above is not vacuously true.
    expect(paths.has('/api/v1/workspace/knowledge/domains')).toBe(true)
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

  it('clicking a domain with an index document surfaces it with an "Index doc" badge and a working link, while a non-index result in the same domain gets neither', async () => {
    stubFetch()
    renderKnowledge()
    await screen.findByText('billing')
    fireEvent.click(within(domainRow('billing')).getByText('billing'))

    const results = await screen.findByTestId('workspace-knowledge-search-results')
    await waitFor(() => expect(results.querySelector('[data-doc-id="shop-idx1"]')).not.toBeNull())

    const indexRow = results.querySelector('[data-doc-id="shop-idx1"]') as HTMLElement
    expect(within(indexRow).getByText('Index doc')).toBeTruthy()
    const link = within(indexRow).getByRole('link')
    expect(link.getAttribute('href')).toBe('/p/shop/knowledge/shop-idx1')

    const otherRow = results.querySelector('[data-doc-id="shop-other"]') as HTMLElement
    expect(within(otherRow).queryByText('Index doc')).toBeNull()
  })
})

describe('empty registry', () => {
  it('renders an honest empty state when the flags are on but no domains exist', async () => {
    stubFetch({ domainsResponse: { domains: [], projects: [] } })
    renderKnowledge()
    await screen.findByText('No domains yet')
  })
})
