import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { ProjectScopeProvider } from '@/api/project-scope-context'
import type {
  HealthResponse,
  KnowledgeDocument,
  KnowledgeDocumentResponse,
  KnowledgeResponse,
  KnowledgeSearchResponse,
} from '@open-mercato/cezar-api-client'

import { KnowledgeRoute } from './knowledge'

/**
 * `knowledge.tsx` (W2.3). Phases-table acceptance for this package: "facets drive the query;
 * every knowledge query key leads with `queryScope()`; no raw `fetch('/api/` in the file". The
 * first two are exercised here by asserting on the REQUESTS the fetch stub actually receives
 * (the observable proxy for "the query key changed and a real fetch went out"), and the third is
 * a static grep the caller runs separately, not something a render assertion can prove.
 *
 * Paths, explained once rather than per test: with no `ProjectScopeProvider` mounted (the
 * default here, matching the house style in `github.test.tsx`), `getApiScope()` is `null` and
 * `client.ts`'s `unscoped()` deliberately collapses the `/p/default` spelling `hc` always builds
 * down to the unprefixed path, so requests land on plain `/api/v1/knowledge...`, not
 * `/api/v1/p/default/knowledge...`. The "scoped requests" test below mounts
 * `ProjectScopeProvider` with a REAL project id specifically to observe the prefixed spelling,
 * which is the genuinely meaningful way to check "every knowledge query key leads with
 * `queryScope()`": proving a request actually carries the active project, not just that it
 * happens to mention the word "default".
 */

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
      { value: 'note', count: 1 },
    ],
    tags: [{ value: 'architecture', count: 1 }],
    statuses: [
      { value: 'current', count: 1 },
      { value: 'superseded', count: 1 },
    ],
    roots: [
      { value: 'project', count: 1 },
      { value: 'sources', count: 1 },
    ],
    // The `domain` axis (`.ai/specs/2026-08-14-knowledge-domains-and-changelog.md` D1). Empty here
    // because neither fixture document is filed under one — which is itself the point: `domain` is
    // optional, and a document without it still indexes and still searches.
    domains: [],
  },
  scan: { truncated: false, filesScanned: 2, bytesScanned: 200, skipped: 0 },
  formatVersion: 1,
}

const DOC_CURRENT: KnowledgeDocument = {
  id: 'project-aaa111aaa111',
  slug: 'product-capability-split',
  root: 'project',
  path: '/repo/.ai/cezar/knowledge/product-capability-split.md',
  title: 'Product capability split',
  type: 'decision',
  tags: ['architecture'],
  status: 'current',
  identifiers: ['SPEC-282'],
  updatedAt: '2026-08-06T11:55:00Z',
  hash: 'hash-current',
  bytes: 13047,
  headings: ['Problem', 'Solution'],
  excerpt: 'MCP servers attach per agent, so an actor could never scope a tool surface.',
  links: [],
  backlinkCount: 4,
}

const DOC_CONFLICT: KnowledgeDocument = {
  id: 'sources-bbb222bbb222',
  slug: 'mirrored-meeting-note',
  root: 'sources',
  path: '/repo/.ai/cezar/sources/meeting-note.md',
  title: 'Mirrored meeting note',
  type: 'meeting',
  tags: [],
  status: 'current',
  identifiers: [],
  updatedAt: '2026-08-06T11:55:00Z',
  hash: 'hash-conflict',
  bytes: 900,
  headings: [],
  excerpt: 'Notes from the sync.',
  links: [],
  backlinkCount: 0,
  source: {
    kind: 'notion',
    connectionId: 'conn_01J',
    externalId: '391b9863-7981-8152-bb4c-d2541a93787b',
    url: 'https://example.invalid/p/x',
    remoteVersion: '2026-08-06T11:40:00Z',
    origin: 'remote',
    state: 'conflict',
    mirroredAt: '2026-08-06T11:55:00Z',
    lossy: [],
  },
}

const SEARCH_RESPONSE: KnowledgeSearchResponse = {
  query: '',
  total: 2,
  truncated: false,
  results: [DOC_CURRENT, DOC_CONFLICT],
}

const SEARCH_RESPONSE_TYPE_DECISION: KnowledgeSearchResponse = {
  query: '',
  total: 1,
  truncated: false,
  results: [DOC_CURRENT],
}

const SEARCH_RESPONSE_QUERY_SPEC: KnowledgeSearchResponse = {
  query: 'SPEC-282',
  total: 1,
  truncated: false,
  results: [DOC_CURRENT],
}

const DOCUMENT_RESPONSE: KnowledgeDocumentResponse = {
  document: { ...DOC_CURRENT, body: '## Problem\n\nFull body text lives here.' },
}

// ---- fetch stub (house style: repo-git.test.tsx / github.test.tsx) -----------------------------

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
      if (method === 'GET' && path === `/api/v1${knowledgeBase}/${DOC_CURRENT.id}`) {
        return jsonResponse(DOCUMENT_RESPONSE)
      }
      if (method === 'GET' && path.startsWith(`/api/v1${knowledgeBase}/search`)) {
        const query = new URL(path, 'http://localhost').searchParams
        if (query.get('type') === 'decision') return jsonResponse(SEARCH_RESPONSE_TYPE_DECISION)
        if (query.get('q') === 'SPEC-282') return jsonResponse(SEARCH_RESPONSE_QUERY_SPEC)
        return jsonResponse(SEARCH_RESPONSE)
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
          <Route path="/knowledge/:id" element={<KnowledgeRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
  render(projectId === null ? tree : <ProjectScopeProvider projectId={projectId}>{tree}</ProjectScopeProvider>)
}

/** Waits for the default search response to have rendered. */
function waitForResults() {
  return screen.findByText('Product capability split')
}

// ---- tests --------------------------------------------------------------------------------------

describe('KnowledgeRoute: flag off', () => {
  it('renders the disabled state and never calls /knowledge', async () => {
    const sent = stubFetch(HEALTH_OFF)
    renderAt('/knowledge')

    await screen.findByText('The knowledge base is off')
    expect(sent.some((request) => request.path.includes('/knowledge'))).toBe(false)
  })
})

describe('KnowledgeRoute: facet rail and result list', () => {
  it('renders facets, and a result row with root/status/identifiers/headings', async () => {
    stubFetch()
    renderAt('/knowledge')

    await waitForResults()

    expect(screen.getByText('Product capability split')).toBeTruthy()
    expect(screen.getByRole('button', { name: /decision/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /current/i })).toBeTruthy()
    expect(screen.getByText('SPEC-282')).toBeTruthy()
    expect(screen.getByText('Problem · Solution')).toBeTruthy()
  })

  it('shows a conflict pill only for a document whose source.state is not ok', async () => {
    stubFetch()
    renderAt('/knowledge')
    await waitForResults()

    const pills = screen.getAllByText('conflict')
    expect(pills).toHaveLength(1)
  })

  it('clicking a type facet sends a new request carrying that filter (facets drive the query)', async () => {
    const sent = stubFetch()
    renderAt('/knowledge')
    await waitForResults()

    fireEvent.click(screen.getByRole('button', { name: /decision/i }))

    await waitFor(() => {
      expect(
        sent.some((request) => request.path.startsWith('/api/v1/knowledge/search') && request.path.includes('type=decision')),
      ).toBe(true)
    })
  })

  it('typing in the search box sends a debounced request carrying q', async () => {
    const sent = stubFetch()
    renderAt('/knowledge')
    await waitForResults()

    fireEvent.change(screen.getByLabelText('Search knowledge'), { target: { value: 'SPEC-282' } })

    await waitFor(
      () => {
        expect(
          sent.some((request) => request.path.startsWith('/api/v1/knowledge/search') && request.path.includes('q=SPEC-282')),
        ).toBe(true)
      },
      { timeout: 2000 },
    )
  })

  it('scopes every knowledge request to the active project (facets, search AND the document)', async () => {
    const sent = stubFetch(HEALTH_ON, {}, '/p/acme-corp/knowledge')
    renderAt(`/knowledge/${DOC_CURRENT.id}`, 'acme-corp')
    await waitForResults()
    await screen.findByRole('article')

    const knowledgeRequests = sent.filter((request) => request.path.includes('/knowledge'))
    expect(knowledgeRequests.length).toBeGreaterThan(0)
    for (const request of knowledgeRequests) {
      expect(request.path.startsWith('/api/v1/p/acme-corp/knowledge')).toBe(true)
    }
  })
})

describe('KnowledgeRoute: detail pane', () => {
  it('shows a placeholder when nothing is selected', async () => {
    stubFetch()
    renderAt('/knowledge')
    await screen.findByText('Select a document')
  })

  it('lazy-loads the reader and renders the body once a document is selected', async () => {
    stubFetch()
    renderAt(`/knowledge/${DOC_CURRENT.id}`)

    const article = await screen.findByRole('article')
    expect(article.getAttribute('data-slot')).toBe('knowledge-document')
    await screen.findByText('Full body text lives here.')
  })

  it('reports "Document not found" for an id the server no longer has', async () => {
    stubFetch(HEALTH_ON, {
      'GET /api/v1/knowledge/unknown-id': () => jsonResponse({ document: null }),
    })
    renderAt('/knowledge/unknown-id')

    await screen.findByText('Document not found')
  })
})
