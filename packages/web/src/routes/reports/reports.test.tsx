import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { ReportListItem, ReportStatus } from '@loki-labs/better-cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'

import { ReportsRoute } from './reports'

/**
 * `/p/:projectId/reports` — the triage queue (`.ai/specs/2026-08-19-reports-triage-approve-
 * dismiss.md`, Verification).
 *
 * The properties worth pinning at this layer are the ones the server cannot enforce: that the tab
 * badges keep showing the WHOLE queue while a tab filters it, that a dismissal cannot be sent
 * without a reason, that a reopen SAYS the task it orphaned is still on the board, and that the
 * page renders a "switched off" state rather than an empty queue when `CEZ_KB` is unset — an empty
 * list and a disabled feature look identical, and only one of them is worth waiting for.
 */

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

// ---- fixtures --------------------------------------------------------------------------------

const PENDING: ReportListItem = {
  key: 'report-2026-08-18-digest',
  docId: 'reports-aabbccdd0011',
  title: 'Daily digest still fires at 08:00',
  domain: 'beside',
  tags: ['user-report'],
  filedAt: '2026-08-18T21:04:00.000Z',
  status: 'pending',
}

const APPROVED: ReportListItem = {
  key: 'report-2026-08-17-share',
  docId: 'reports-ffeeddcc2233',
  title: 'Location share button does nothing',
  tags: ['user-report'],
  filedAt: '2026-08-17T09:00:00.000Z',
  status: 'approved',
  triage: {
    key: 'report-2026-08-17-share',
    keyKind: 'identifier',
    status: 'approved',
    at: '2026-08-18T10:00:00.000Z',
    todoId: 'todo-1',
    todoProjectId: 'proj',
  },
}

const DISMISSED: ReportListItem = {
  key: 'report-2026-08-16-typo',
  docId: 'reports-11223344aabb',
  title: 'Typo in the pricing page',
  tags: ['user-report'],
  filedAt: '2026-08-16T09:00:00.000Z',
  status: 'dismissed',
  triage: {
    key: 'report-2026-08-16-typo',
    keyKind: 'catalog-id',
    status: 'dismissed',
    at: '2026-08-18T11:00:00.000Z',
    reason: 'already fixed',
  },
}

/** Every count describes the WHOLE set regardless of the `status` filter — the server's contract,
 *  reproduced here so a badge that started counting the filtered page fails. */
const COUNTS = { pending: 1, approved: 1, dismissed: 1, total: 3 }

const health = (knowledge: boolean) => ({
  version: '0.0.0-test',
  repoRoot: '/repo',
  repo: { root: '/repo', branch: 'main' },
  forge: null,
  capabilities: { localHandoff: true, knowledge },
  defaultRunner: 'claude',
  checks: [{ name: 'claude', available: true }],
})

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

interface SentRequest {
  path: string
  method: string
  body?: unknown
}

/** Stateful stub in the house style (`inbox.test.tsx`): a triage POST really moves the report, so
 *  the invalidation refetch answers with the new status rather than the old one. */
function stubFetch(
  options: {
    knowledge?: boolean
    items?: ReportListItem[]
    overrides?: Record<string, () => Response | Promise<Response>>
  } = {},
): SentRequest[] {
  const sent: SentRequest[] = []
  let items = [...(options.items ?? [PENDING, APPROVED, DISMISSED])]
  const knowledge = options.knowledge ?? true

  const counts = () => ({
    pending: items.filter((i) => i.status === 'pending').length,
    approved: items.filter((i) => i.status === 'approved').length,
    dismissed: items.filter((i) => i.status === 'dismissed').length,
    total: items.length,
  })

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input)
      const method = init.method ?? 'GET'
      sent.push({ path, method, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) })
      const override = options.overrides?.[`${method} ${path}`]
      if (override) return override()

      if (method === 'GET' && path === '/api/v1/health') return jsonResponse(health(knowledge))
      if (method === 'GET' && path.startsWith('/api/v1/reports?')) {
        const status = new URL(path, 'http://x').searchParams.get('status') as ReportStatus | null
        return jsonResponse({
          enabled: true,
          items: status === null ? items : items.filter((i) => i.status === status),
          // Deliberately the WHOLE-set counts even on a filtered request.
          counts: counts(),
          truncated: false,
        })
      }
      if (method === 'GET' && path.startsWith('/api/v1/reports/')) {
        const key = decodeURIComponent(path.slice('/api/v1/reports/'.length))
        const item = items.find((i) => i.key === key)
        return jsonResponse({ enabled: true, item: item ?? null, body: `The body of ${key}.` })
      }
      if (method === 'POST' && path.endsWith('/approve')) {
        const key = decodeURIComponent(path.slice('/api/v1/reports/'.length, -'/approve'.length))
        items = items.map((i) => (i.key === key ? { ...i, status: 'approved' as const } : i))
        return jsonResponse({
          item: items.find((i) => i.key === key),
          todo: { id: 'todo-new', summary: 'x' },
          alreadyApproved: false,
        })
      }
      if (method === 'POST' && path.endsWith('/dismiss')) {
        const key = decodeURIComponent(path.slice('/api/v1/reports/'.length, -'/dismiss'.length))
        items = items.map((i) => (i.key === key ? { ...i, status: 'dismissed' as const } : i))
        return jsonResponse({ item: items.find((i) => i.key === key) })
      }
      if (method === 'POST' && path.endsWith('/reopen')) {
        const key = decodeURIComponent(path.slice('/api/v1/reports/'.length, -'/reopen'.length))
        items = items.map((i) => (i.key === key ? { ...i, status: 'pending' as const } : i))
        return jsonResponse({ item: items.find((i) => i.key === key), orphanedTodoId: 'todo-1' })
      }
      if (method === 'POST' && path === '/api/v1/reports/process-pending') {
        return jsonResponse({ outcomes: [{ key: PENDING.key, ok: true }], converted: 1, failed: 0 })
      }
      return jsonResponse({ error: 'not found' }, 404)
    }),
  )
  return sent
}

function renderReports(entry = '/reports') {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/reports" element={<ReportsRoute />} />
          <Route path="/p/:projectId/reports" element={<ReportsRoute />} />
          {/* Where "open document" is supposed to land. */}
          <Route path="/knowledge" element={<div data-slot="knowledge-probe" />} />
          <Route path="/p/:projectId/knowledge" element={<div data-slot="knowledge-probe" />} />
        </Routes>
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const cards = () => [...document.querySelectorAll<HTMLElement>('[data-slot="report-card"]')]
const tab = (status: ReportStatus) =>
  document.querySelector<HTMLElement>(`[data-slot="reports-tab"][data-status="${status}"]`)!
const action = (card: HTMLElement, name: string) =>
  card.querySelector<HTMLButtonElement>(`[data-action="${name}"]`)

// ---- the flag-off state -----------------------------------------------------------------------

describe('reports route — knowledge off', () => {
  it('says reports are OFF rather than showing an empty queue, and never asks for the list', async () => {
    const sent = stubFetch({ knowledge: false })
    renderReports()
    expect(await screen.findByText('Reports are off')).toBeTruthy()
    // "No reports yet" and "off" look the same to a user, and only one of them is worth waiting
    // for — so the page must not render the empty-queue copy here.
    expect(screen.queryByText('No reports yet')).toBeNull()
    expect(sent.some((r) => r.path.startsWith('/api/v1/reports'))).toBe(false)
  })

  it('NEGATIVE CONTROL: the same harness with knowledge ON reaches the queue', async () => {
    // Without this, the assertions above would also pass on a route that renders "off"
    // unconditionally, or on a fetch stub that answers nothing at all.
    stubFetch({ knowledge: true })
    renderReports()
    await waitFor(() => expect(cards()).toHaveLength(1))
    expect(screen.queryByText('Reports are off')).toBeNull()
  })
})

// ---- the queue --------------------------------------------------------------------------------

describe('reports route — the queue', () => {
  it('opens on Pending and shows the whole-set counts on every tab', async () => {
    stubFetch()
    renderReports()
    await waitFor(() => expect(cards()).toHaveLength(1))
    expect(cards()[0]!.dataset.reportKey).toBe(PENDING.key)

    // The badge on a tab you are NOT standing on is the assertion that matters: a count computed
    // from the rendered page would read 0 for both of these.
    for (const status of ['pending', 'approved', 'dismissed'] as const) {
      expect(tab(status).textContent, status).toContain(`(${COUNTS[status]})`)
    }
  })

  it('switching tabs asks the server for that status and renders its rows', async () => {
    const sent = stubFetch()
    renderReports()
    await waitFor(() => expect(cards()).toHaveLength(1))

    fireEvent.click(tab('dismissed'))
    await waitFor(() => expect(cards()[0]?.dataset.reportKey).toBe(DISMISSED.key))
    expect(sent.some((r) => r.path === '/api/v1/reports?status=dismissed')).toBe(true)
    // The recorded reason travels to the row — a dismissal with no visible reason is the thing the
    // required-reason rule exists to prevent.
    expect(cards()[0]!.textContent).toContain('already fixed')
    // …and the weaker key is surfaced, not assumed equal to a stable identifier.
    expect(cards()[0]!.querySelector('[data-slot="report-weak-key"]')).toBeTruthy()
  })

  it('a pending row offers Approve and Dismiss; a triaged row offers Reopen instead', async () => {
    stubFetch()
    renderReports()
    await waitFor(() => expect(cards()).toHaveLength(1))
    expect(action(cards()[0]!, 'report-approve')).toBeTruthy()
    expect(action(cards()[0]!, 'report-reopen')).toBeNull()

    fireEvent.click(tab('approved'))
    await waitFor(() => expect(cards()[0]?.dataset.status).toBe('approved'))
    expect(action(cards()[0]!, 'report-approve')).toBeNull()
    expect(action(cards()[0]!, 'report-reopen')).toBeTruthy()
  })

  it('expanding a row loads the report body and puts the key in the URL', async () => {
    stubFetch()
    renderReports()
    await waitFor(() => expect(cards()).toHaveLength(1))
    fireEvent.click(action(cards()[0]!, 'report-expand')!)
    expect(await screen.findByText(`The body of ${PENDING.key}.`)).toBeTruthy()
  })
})

// ---- triage -----------------------------------------------------------------------------------

describe('reports route — triage', () => {
  it('Approve posts to the approve route and the row leaves the pending tab', async () => {
    const sent = stubFetch()
    renderReports()
    await waitFor(() => expect(cards()).toHaveLength(1))

    fireEvent.click(action(cards()[0]!, 'report-approve')!)
    await waitFor(() => expect(cards()).toHaveLength(0))
    expect(
      sent.some((r) => r.method === 'POST' && r.path === `/api/v1/reports/${PENDING.key}/approve`),
    ).toBe(true)
    expect(await screen.findByText('Approved — filed as a task.')).toBeTruthy()
  })

  it('a dismissal cannot be sent without a reason', async () => {
    const sent = stubFetch()
    renderReports()
    await waitFor(() => expect(cards()).toHaveLength(1))

    fireEvent.click(action(cards()[0]!, 'report-dismiss-open')!)
    const confirm = await waitFor(() => action(cards()[0]!, 'report-dismiss-confirm')!)
    // Disabled on an empty reason, and on whitespace — a spaces-only "reason" is no reason, and the
    // server trims it to nothing and 400s.
    expect(confirm.disabled).toBe(true)
    const input = cards()[0]!.querySelector<HTMLInputElement>('[data-slot="report-dismiss-reason"]')!
    fireEvent.change(input, { target: { value: '   ' } })
    expect(action(cards()[0]!, 'report-dismiss-confirm')!.disabled).toBe(true)
    expect(sent.some((r) => r.method === 'POST' && r.path.endsWith('/dismiss'))).toBe(false)

    fireEvent.change(input, { target: { value: 'duplicate of #12' } })
    expect(action(cards()[0]!, 'report-dismiss-confirm')!.disabled).toBe(false)
    fireEvent.click(action(cards()[0]!, 'report-dismiss-confirm')!)
    await waitFor(() =>
      expect(sent.find((r) => r.method === 'POST' && r.path.endsWith('/dismiss'))?.body).toEqual({
        reason: 'duplicate of #12',
      }),
    )
  })

  it('Cancel closes the dismiss form and sends nothing', async () => {
    const sent = stubFetch()
    renderReports()
    await waitFor(() => expect(cards()).toHaveLength(1))
    fireEvent.click(action(cards()[0]!, 'report-dismiss-open')!)
    await waitFor(() => expect(action(cards()[0]!, 'report-dismiss-cancel')).toBeTruthy())
    fireEvent.click(action(cards()[0]!, 'report-dismiss-cancel')!)
    await waitFor(() => expect(action(cards()[0]!, 'report-dismiss-confirm')).toBeNull())
    expect(sent.some((r) => r.method === 'POST')).toBe(false)
  })

  it('Reopen says the task it created is still on the board', async () => {
    stubFetch()
    renderReports()
    await waitFor(() => expect(cards()).toHaveLength(1))
    fireEvent.click(tab('approved'))
    await waitFor(() => expect(cards()[0]?.dataset.status).toBe('approved'))

    fireEvent.click(action(cards()[0]!, 'report-reopen')!)
    // The orphan must be named. A user not told the task survived files a second one, which is the
    // duplicate the whole idempotency argument exists to avoid.
    expect(
      await screen.findByText('Back in the pending queue. The task it created is still on the board.'),
    ).toBeTruthy()
  })

  it('a failed triage call surfaces the server’s own words', async () => {
    stubFetch({
      overrides: {
        [`POST /api/v1/reports/${PENDING.key}/approve`]: () =>
          jsonResponse({ error: 'no such project: nowhere' }, 400),
      },
    })
    renderReports()
    await waitFor(() => expect(cards()).toHaveLength(1))
    fireEvent.click(action(cards()[0]!, 'report-approve')!)
    expect(await screen.findByText('no such project: nowhere')).toBeTruthy()
    // The row stays put: a refused approve must not look like one that worked.
    expect(cards()).toHaveLength(1)
  })

  it('Convert all pending reports both halves of the outcome', async () => {
    const sent = stubFetch()
    renderReports()
    await waitFor(() => expect(cards()).toHaveLength(1))
    fireEvent.click(document.querySelector<HTMLElement>('[data-action="reports-process-pending"]')!)
    expect(await screen.findByText('Converted 1 report.')).toBeTruthy()
    expect(
      sent.some((r) => r.method === 'POST' && r.path === '/api/v1/reports/process-pending'),
    ).toBe(true)
  })

  it('a partly-failed bulk convert says how many were dropped', async () => {
    stubFetch({
      overrides: {
        'POST /api/v1/reports/process-pending': () =>
          jsonResponse({
            outcomes: [
              { key: 'a', ok: true },
              { key: 'b', ok: false, error: 'no such project: nowhere' },
            ],
            converted: 1,
            failed: 1,
          }),
      },
    })
    renderReports()
    await waitFor(() => expect(cards()).toHaveLength(1))
    fireEvent.click(document.querySelector<HTMLElement>('[data-action="reports-process-pending"]')!)
    // Never "converted 1" alone: a batch that dropped work must say so.
    expect(await screen.findByText('Converted 1, 1 could not be converted.')).toBeTruthy()
  })

  it('the bulk convert is offered on the pending tab only', async () => {
    stubFetch()
    renderReports()
    await waitFor(() => expect(cards()).toHaveLength(1))
    expect(document.querySelector('[data-action="reports-process-pending"]')).toBeTruthy()
    fireEvent.click(tab('approved'))
    await waitFor(() => expect(cards()[0]?.dataset.status).toBe('approved'))
    // Nothing on this tab is pending, so a "convert all pending" button here would either do
    // nothing or convert rows the user is not looking at.
    expect(document.querySelector('[data-action="reports-process-pending"]')).toBeNull()
  })
})
