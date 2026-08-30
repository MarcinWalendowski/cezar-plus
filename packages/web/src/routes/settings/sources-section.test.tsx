import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type {
  SourceConnectionWire,
  SourceProviderInfo,
  SourceProvidersResponse,
  SourcesListResponse,
} from '@loki-labs/cezar-plus-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { SourcesSection } from './sources-section'

const { trackMock } = vi.hoisted(() => ({ trackMock: vi.fn() }))
vi.mock('@/lib/analytics', () => ({ track: trackMock }))

/**
 * Settings → Sources (F2, `CEZ_SOURCES`, `.ai/specs/2026-08-06-external-source-connectors-
 * notion.md` "UI/UX"), narrowed to this package's own brief (configure, list, refresh, and show
 * a connection as stale or erroring). What this pins:
 *
 *  - the off state when `capabilities.sources` is false, and that it never fetches the list;
 *  - the connection list carries a distinct status badge per row, with the provider's/sweep's
 *    own reason verbatim in the DOM for `error`/`unavailable`, and a conflict count only when
 *    nonzero;
 *  - the provider picker: an unavailable provider is greyed WITH ITS EXACT REASON in the DOM,
 *    never hidden, and the only credential-shaped control on the page is a copyable hint — never
 *    a token input;
 *  - Sync and create use the typed mutations, invalidate the source list, and emit only the
 *    documented browser analytics properties;
 *  - the editor requires a configured collection and the browser exposes mirrored body,
 *    provenance, comments, adoption, and conflict actions.
 */

let requests: Array<{ method: string; url: string; body?: unknown }> = []

function connection(
  over: Partial<SourceConnectionWire> & Pick<SourceConnectionWire, 'id' | 'name'>,
): SourceConnectionWire {
  return {
    revision: 1,
    kind: 'notion',
    enabled: true,
    mode: 'mirror',
    intervalSeconds: 900,
    collections: [],
    watchComments: false,
    maxDocuments: 5000,
    maxBodyBytes: 524_288,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    syncState: 'ok',
    documentCount: 0,
    conflictCount: 0,
    unresolvedComments: 0,
    availability: { available: true },
    complete: true,
    ...over,
  }
}

function provider(
  over: Partial<SourceProviderInfo> & Pick<SourceProviderInfo, 'kind' | 'label'>,
): SourceProviderInfo {
  return {
    capabilities: { list: true, fetch: true, poll: true, push: false, comments: true },
    availability: { available: true },
    ...over,
  }
}

function serve(
  opts: {
    sourcesOn?: boolean
    connections?: SourceConnectionWire[]
    providers?: SourceProviderInfo[]
    documents?: unknown
    comments?: unknown
    document?: unknown
  } = {},
) {
  requests = []
  const sourcesOn = opts.sourcesOn ?? true
  let currentConnections = [...(opts.connections ?? [])]
  const sourcesResponse = (): SourcesListResponse => ({ connections: currentConnections })
  const providersResponse: SourceProvidersResponse = { providers: opts.providers ?? [] }
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const pathname = new URL(url, 'http://sources.test').pathname
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown
      requests.push({ method, url, ...(body === undefined ? {} : { body }) })
      if (pathname === '/api/v1/health' && method === 'GET') return json({ capabilities: { sources: sourcesOn } })
      if (pathname.endsWith('/sources') && method === 'GET') return json(sourcesResponse())
      if (pathname.endsWith('/sources/providers') && method === 'GET') return json(providersResponse)
      if (pathname.endsWith('/sources') && method === 'POST') {
        const input = body as Record<string, unknown>
        const created = connection({
          id: 'created',
          name: String(input.name),
          kind: String(input.kind),
          enabled: input.enabled !== false,
          mode: input.mode === 'archived' ? 'archived' : 'mirror',
          intervalSeconds: Number(input.intervalSeconds),
          collections: (input.collections ?? []) as SourceConnectionWire['collections'],
          watchComments: input.watchComments === true,
        })
        currentConnections = [...currentConnections, created]
        return json({ connection: created }, 201)
      }
      const connectionMatch = pathname.match(/\/sources\/([^/]+)$/)
      if (connectionMatch && method === 'PUT') {
        const id = decodeURIComponent(connectionMatch[1]!)
        const current = currentConnections.find((item) => item.id === id)
        if (!current) return json({ error: 'missing' }, 404)
        const input = body as Record<string, unknown>
        const updated = connection({
          ...current,
          name: typeof input.name === 'string' ? input.name : current.name,
          enabled: typeof input.enabled === 'boolean' ? input.enabled : current.enabled,
          mode: input.mode === 'archived' ? 'archived' : 'mirror',
          intervalSeconds: typeof input.intervalSeconds === 'number' ? input.intervalSeconds : current.intervalSeconds,
          collections: (input.collections ?? current.collections) as SourceConnectionWire['collections'],
          watchComments: typeof input.watchComments === 'boolean' ? input.watchComments : current.watchComments,
          revision: current.revision + 1,
        })
        currentConnections = currentConnections.map((item) => item.id === id ? updated : item)
        return json({ connection: updated })
      }
      if (connectionMatch && method === 'DELETE') {
        const id = decodeURIComponent(connectionMatch[1]!)
        currentConnections = currentConnections.filter((item) => item.id !== id)
        return json({ removed: true })
      }
      const syncMatch = pathname.match(/\/sources\/([^/]+)\/sync$/)
      if (syncMatch && method === 'POST') return json({ syncId: 'sync-1' }, 202)
      const documentsMatch = pathname.match(/\/sources\/([^/]+)\/documents$/)
      if (documentsMatch && method === 'GET') return json(opts.documents ?? { documents: [] })
      const commentsMatch = pathname.match(/\/sources\/([^/]+)\/comments$/)
      if (commentsMatch && method === 'GET') return json(opts.comments ?? { comments: [] })
      const documentMatch = pathname.match(/\/sources\/([^/]+)\/documents\/([^/]+)$/)
      if (documentMatch && method === 'GET') return json(opts.document ?? { document: null })
      const adoptMatch = pathname.match(/\/sources\/([^/]+)\/documents\/([^/]+)\/adopt$/)
      if (adoptMatch && method === 'POST') return json({ path: 'notes/adopted.md', adoptedAt: '2026-08-30T10:00:00.000Z' })
      const resolveMatch = pathname.match(/\/sources\/([^/]+)\/documents\/([^/]+)\/resolve$/)
      if (resolveMatch && method === 'POST') return json({ document: (opts.document as { document?: unknown } | undefined)?.document ?? null })
      return new Promise<never>(() => {})
    }),
  )
}

function renderSection() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <SourcesSection />
      <Toaster />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  act(() => resetToasts())
  trackMock.mockReset()
  cleanup()
  vi.unstubAllGlobals()
})

const openAddDialog = async () => {
  await waitFor(() => expect(screen.getByText('No sources yet')).toBeTruthy())
  fireEvent.click(document.querySelector('[data-action="sources-add-empty"]')!)
  await waitFor(() => expect(document.querySelector('[data-slot="source-add-dialog"]')).not.toBeNull())
}

describe('the sources section', () => {
  it('is off: capabilities.sources=false renders the off state and never fetches the list', async () => {
    serve({ sourcesOn: false })
    renderSection()
    await waitFor(() => expect(screen.getByText('External sources are off')).toBeTruthy())
    expect(requests.some((r) => r.url === '/api/v1/sources')).toBe(false)
  })

  it('empty: no connections renders the actionable empty state', async () => {
    serve({ connections: [] })
    renderSection()
    await waitFor(() => expect(screen.getByText('No sources yet')).toBeTruthy())
  })

  it('lists connections with a distinct status badge, verbatim reason, and counts', async () => {
    serve({
      connections: [
        connection({
          id: 'c-ok',
          name: 'Team knowledge',
          syncState: 'ok',
          documentCount: 42,
          nextDueAt: '2026-08-10T00:00:00.000Z',
        }),
        connection({
          id: 'c-err',
          name: 'Broken one',
          syncState: 'error',
          documentCount: 10,
          conflictCount: 2,
          lastErrorMessage: '429: rate limited',
        }),
        connection({
          id: 'c-unavail',
          name: 'Revoked',
          syncState: 'unavailable',
          documentCount: 7,
          availability: { available: false, reason: '401 Unauthorized: token was revoked' },
        }),
      ],
    })
    renderSection()

    await waitFor(() => expect(document.querySelector('[data-connection-id="c-ok"]')).not.toBeNull())

    const ok = document.querySelector('[data-connection-id="c-ok"]')!
    expect(ok.querySelector('[data-slot="source-status-badge"]')?.getAttribute('data-sync-state')).toBe('ok')
    expect(ok.querySelector('[data-slot="source-document-count"]')?.textContent).toBe('42')
    expect(ok.querySelector('[data-slot="source-conflict-count"]')).toBeNull()
    // A stored value rendered verbatim — never re-derived into a relative "in N days" on read.
    expect(ok.querySelector('[data-slot="source-next-due"]')?.textContent).toBe('2026-08-10T00:00:00.000Z')

    const err = document.querySelector('[data-connection-id="c-err"]')!
    expect(err.querySelector('[data-slot="source-status-badge"]')?.getAttribute('data-sync-state')).toBe('error')
    expect(err.querySelector('[data-slot="source-status-reason"]')?.textContent).toContain('429: rate limited')
    expect(err.querySelector('[data-slot="source-conflict-count"]')?.textContent).toBe('2')

    const unavail = document.querySelector('[data-connection-id="c-unavail"]')!
    expect(unavail.querySelector('[data-slot="source-status-badge"]')?.getAttribute('data-sync-state')).toBe(
      'unavailable',
    )
    expect(unavail.querySelector('[data-slot="source-status-reason"]')?.textContent).toContain(
      '401 Unauthorized: token was revoked',
    )
  })

  it('Sync now uses the typed mutation and records only the documented analytics properties', async () => {
    serve({ connections: [connection({ id: 'c1', name: 'Team knowledge' })] })
    renderSection()
    await waitFor(() => expect(document.querySelector('[data-action="source-sync"]')).not.toBeNull())

    fireEvent.click(document.querySelector('[data-action="source-sync"]')!)

    await waitFor(() => expect(requests.some((request) => request.method === 'POST' && request.url.endsWith('/sources/c1/sync'))).toBe(true))
    expect(document.querySelector('[data-slot="toast"]')).toBeNull()
    expect(trackMock).toHaveBeenCalledWith('source.sync_requested', {
      project: 'default',
      providerKind: 'notion',
      connectionId: 'c1',
    })
  })

  it('Add source: an unavailable provider is greyed with its exact reason in the DOM, never hidden', async () => {
    serve({
      connections: [],
      providers: [
        provider({ kind: 'notion', label: 'Notion', credentialHint: 'CEZ_NOTION_TOKEN' }),
        provider({
          kind: 'linear',
          label: 'Linear',
          availability: { available: false, reason: 'not implemented on this build' },
        }),
      ],
    })
    renderSection()
    await openAddDialog()

    const linearOption = document.querySelector('[data-slot="source-provider-option"][data-kind="linear"]')!
    expect(linearOption.getAttribute('data-available')).toBe('false')
    expect(linearOption.querySelector('[data-slot="source-provider-unavailable-reason"]')?.textContent).toBe(
      'not implemented on this build',
    )

    const notionOption = document.querySelector('[data-slot="source-provider-option"][data-kind="notion"]')!
    expect(notionOption.getAttribute('data-available')).toBe('true')
  })

  it('no token field anywhere: the only credential-shaped control is a copyable hint', async () => {
    serve({
      connections: [],
      providers: [provider({ kind: 'notion', label: 'Notion', credentialHint: 'CEZ_NOTION_TOKEN' })],
    })
    renderSection()
    await openAddDialog()

    const hint = document.querySelector('[data-slot="source-credential-hint"]')
    expect(hint?.tagName).toBe('BUTTON')
    expect(hint?.textContent).toBe('CEZ_NOTION_TOKEN')

    // The editor has configuration fields, but no credential input.
    const inputs = [...document.querySelectorAll('input')]
    expect(inputs.some((input) => input.type === 'password')).toBe(false)
    expect(inputs.map((input) => input.id)).toEqual(expect.arrayContaining(['source-name', 'source-collection-id']))
  })

  it('Create connection requires a collection, defaults enabled, and emits a privacy-safe event', async () => {
    serve({
      connections: [],
      providers: [provider({ kind: 'notion', label: 'Notion', credentialHint: 'CEZ_NOTION_TOKEN' })],
    })
    renderSection()
    await openAddDialog()

    const submit = () => document.querySelector('[data-action="source-create"]') as HTMLButtonElement
    expect(submit().disabled).toBe(true)

    fireEvent.click(document.querySelector('[data-slot="source-provider-option"][data-kind="notion"] button')!)
    expect(submit().disabled).toBe(true) // a provider alone is not enough — still no name

    fireEvent.change(document.getElementById('source-name')!, { target: { value: 'Team knowledge' } })
    expect(submit().disabled).toBe(true)

    fireEvent.change(document.getElementById('source-collection-id')!, { target: { value: 'db-1' } })
    expect(submit().disabled).toBe(false)

    fireEvent.click(submit())
    await waitFor(() => expect(requests.some((request) => request.method === 'POST' && request.url.endsWith('/sources'))).toBe(true))
    const create = requests.find((request) => request.method === 'POST' && request.url.endsWith('/sources'))
    expect(create?.body).toMatchObject({
      name: 'Team knowledge',
      enabled: true,
      collections: [{ externalId: 'db-1', collectionKind: 'page-tree' }],
    })
    expect(trackMock).toHaveBeenCalledWith('source.connection_created', {
      project: 'default',
      providerKind: 'notion',
      connectionId: 'created',
    })
  })

  it('edits and deletes a connection through confirmation-backed mutations', async () => {
    serve({
      connections: [connection({ id: 'c1', name: 'Team knowledge', collections: [{ externalId: 'db-1', collectionKind: 'database' }] })],
      // The dialog resolves its kind against the provider catalog, so Save stays disabled
      // until the catalog is served -- the same stub every other dialog test here uses.
      providers: [provider({ kind: 'notion', label: 'Notion', credentialHint: 'CEZ_NOTION_TOKEN' })],
    })
    renderSection()
    await waitFor(() => expect(document.querySelector('[data-connection-id="c1"]')).not.toBeNull())

    fireEvent.click(document.querySelector('[data-connection-id="c1"] [data-action="source-edit"]')!)
    await waitFor(() => expect(document.querySelector('[data-slot="source-add-dialog"]')).not.toBeNull())
    fireEvent.change(document.getElementById('source-name')!, { target: { value: 'Renamed knowledge' } })
    fireEvent.click(document.querySelector('[data-action="source-create"]')!)
    await waitFor(() => expect(requests.some((request) => request.method === 'PUT' && request.url.endsWith('/sources/c1'))).toBe(true))
    const update = requests.find((request) => request.method === 'PUT' && request.url.endsWith('/sources/c1'))
    expect(update?.body).toMatchObject({ name: 'Renamed knowledge', expectedRevision: 1 })

    fireEvent.click(document.querySelector('[data-connection-id="c1"] [data-action="source-delete"]')!)
    await waitFor(() => expect(document.querySelector('[data-slot="source-delete-dialog"]')).not.toBeNull())
    fireEvent.click(document.querySelector('[data-action="source-delete-confirm"]')!)
    await waitFor(() => expect(requests.some((request) => request.method === 'DELETE' && request.url.endsWith('/sources/c1'))).toBe(true))
  })

  it('shows configured collections and disables sync for disabled, archived, and unavailable rows', async () => {
    serve({
      connections: [
        connection({ id: 'disabled', name: 'Disabled', enabled: false }),
        connection({ id: 'archived', name: 'Archived', mode: 'archived' }),
        connection({ id: 'unavailable', name: 'Unavailable', availability: { available: false, reason: 'token missing' } }),
        connection({ id: 'configured', name: 'Configured', collections: [{ externalId: 'db-1', collectionKind: 'database', label: 'Docs' }] }),
      ],
    })
    renderSection()
    await waitFor(() => expect(document.querySelector('[data-connection-id="configured"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="source-configured-collections"]')?.textContent).toContain('Configured collections: Docs (database)')
    for (const id of ['disabled', 'archived', 'unavailable']) {
      expect(document.querySelector(`[data-connection-id="${id}"] [data-action="source-sync"]`)).toHaveProperty('disabled', true)
    }
  })

  it('browses body, provenance, comments, and conflict actions without exposing remote write controls', async () => {
    serve({
      connections: [connection({ id: 'c1', name: 'Team knowledge', conflictCount: 1, watchComments: true })],
      documents: {
        documents: [{
          docId: 'doc-1', externalId: 'page-1', title: 'Meeting notes', docType: 'page', url: 'https://notion.test/page-1',
          origin: 'remote', state: 'conflict', mirroredAt: '2026-08-30T09:00:00.000Z', syncState: 'ok', lossy: ['image'], properties: {},
        }],
      },
      document: {
        document: {
          docId: 'doc-1', externalId: 'page-1', title: 'Meeting notes', docType: 'page', url: 'https://notion.test/page-1',
          origin: 'remote', state: 'conflict', mirroredAt: '2026-08-30T09:00:00.000Z', syncState: 'ok', lossy: ['image'], properties: {}, body: '# Notes',
        },
      },
      comments: { comments: [{ id: 'comment-1', docId: 'doc-1', externalId: 'comment-1', author: 'Ada', body: 'Review this', createdAt: '2026-08-30T09:01:00.000Z', attachments: [] }] },
    })
    renderSection()
    await waitFor(() => expect(document.querySelector('[data-connection-id="c1"]')).not.toBeNull())
    fireEvent.click(document.querySelector('[data-connection-id="c1"] [data-action="source-browse"]')!)
    await waitFor(() => expect(document.querySelector('[data-slot="source-browser"]')).not.toBeNull())
    await waitFor(() => expect(document.querySelector('[data-action="source-document-select"]')).not.toBeNull())
    fireEvent.click(document.querySelector('[data-action="source-document-select"]')!)
    await waitFor(() => expect(document.querySelector('[data-slot="source-document-body"]')?.textContent).toBe('# Notes'))
    expect(document.querySelector('[data-slot="source-provenance"]')?.textContent).toContain('External IDpage-1')
    expect(document.querySelector('[data-slot="source-lossiness"]')?.textContent).toContain('image')
    await waitFor(() => expect(screen.getByText('Review this')).toBeTruthy())
    expect(document.querySelector('[data-action="source-conflict-keep-local"]')).not.toBeNull()
    expect(document.querySelector('[data-action="source-conflict-take-remote"]')).not.toBeNull()

    fireEvent.click(document.querySelector('[data-action="source-conflict-keep-local"]')!)
    await waitFor(() => expect(requests.some((request) => request.method === 'POST' && request.url.endsWith('/sources/c1/documents/doc-1/resolve'))).toBe(true))
    expect(trackMock).toHaveBeenCalledWith('source.conflict_resolved', {
      project: 'default',
      providerKind: 'notion',
      connectionId: 'c1',
      action: 'keep-local',
    })
  })

  it('adopts a remote document through the typed mutation and records its safe event', async () => {
    const remoteDocument = {
      docId: 'doc-1', externalId: 'page-1', title: 'Meeting notes', docType: 'page', url: 'https://notion.test/page-1',
      origin: 'remote', state: 'ok', mirroredAt: '2026-08-30T09:00:00.000Z', syncState: 'ok', lossy: [], properties: {}, body: '# Notes',
    }
    serve({
      connections: [connection({ id: 'c1', name: 'Team knowledge' })],
      documents: { documents: [remoteDocument] },
      document: { document: remoteDocument },
    })
    renderSection()
    await waitFor(() => expect(document.querySelector('[data-connection-id="c1"]')).not.toBeNull())
    fireEvent.click(document.querySelector('[data-connection-id="c1"] [data-action="source-browse"]')!)
    await waitFor(() => expect(document.querySelector('[data-slot="source-browser"]')).not.toBeNull())
    await waitFor(() => expect(document.querySelector('[data-action="source-document-select"]')).not.toBeNull())
    fireEvent.click(document.querySelector('[data-action="source-document-select"]')!)
    await waitFor(() => expect(document.querySelector('[data-action="source-adopt"]')).not.toBeNull())
    fireEvent.click(document.querySelector('[data-action="source-adopt"]')!)
    await waitFor(() => expect(requests.some((request) => request.method === 'POST' && request.url.endsWith('/sources/c1/documents/doc-1/adopt'))).toBe(true))
    expect(trackMock).toHaveBeenCalledWith('source.document_adopted', {
      project: 'default',
      providerKind: 'notion',
      connectionId: 'c1',
    })
  })
})
