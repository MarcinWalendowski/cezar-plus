import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type {
  SourceConnectionWire,
  SourceProviderInfo,
  SourceProvidersResponse,
  SourcesListResponse,
} from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { SourcesSection } from './sources-section'

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
 *  - "Sync now" and "Create connection" fail LOUDLY (an honest toast naming what's missing)
 *    rather than silently doing nothing, because this package cannot add a real mutation to
 *    `client.ts`/`queries.ts` without touching files it does not own (see the section's module
 *    docblock for why).
 */

let requests: Array<{ method: string; url: string }> = []

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
  } = {},
) {
  requests = []
  const sourcesOn = opts.sourcesOn ?? true
  const sourcesResponse: SourcesListResponse = { connections: opts.connections ?? [] }
  const providersResponse: SourceProvidersResponse = { providers: opts.providers ?? [] }
  const json = (payload: unknown) =>
    new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      requests.push({ method, url })
      if (url === '/api/v1/health' && method === 'GET') return json({ capabilities: { sources: sourcesOn } })
      if (url === '/api/v1/sources' && method === 'GET') return json(sourcesResponse)
      if (url === '/api/v1/sources/providers' && method === 'GET') return json(providersResponse)
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

  it('Sync now fails LOUDLY through a toast rather than doing nothing silently', async () => {
    serve({ connections: [connection({ id: 'c1', name: 'Team knowledge' })] })
    renderSection()
    await waitFor(() => expect(document.querySelector('[data-action="source-sync"]')).not.toBeNull())

    fireEvent.click(document.querySelector('[data-action="source-sync"]')!)

    await waitFor(() => expect(document.querySelector('[data-slot="toast"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="toast"]')?.textContent).toContain('Refreshing this source')
    expect(document.querySelector('[data-slot="toast"]')?.getAttribute('data-tone')).toBe('danger')
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

    // Exactly one input in the whole dialog: the connection NAME field. No credential input.
    const inputs = [...document.querySelectorAll('input')]
    expect(inputs).toHaveLength(1)
    expect(inputs[0]?.id).toBe('source-name')
  })

  it('Create connection stays disabled until a provider is picked and named, then fails LOUDLY', async () => {
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
    expect(submit().disabled).toBe(false)

    fireEvent.click(submit())
    await waitFor(() => expect(document.querySelector('[data-slot="toast"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="toast"]')?.textContent).toContain('Adding a source')
  })
})
