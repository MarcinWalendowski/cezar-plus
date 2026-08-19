import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { ReportListItem, ReportStatus, ReportsResponse } from '@loki-labs/better-cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'

import { WorkspaceReportsRoute } from './workspace-reports'

/**
 * `/workspace/reports` — the triage queue, moved here 2026-08-19 from `/p/:projectId/reports`
 * (`routes/reports/reports.test.tsx`, deleted — this file is its port plus the new coverage the
 * move itself needs). See `workspace-reports.tsx`'s own doc comment for the full "why": the
 * knowledge mount reports live in is declared once, by the operator, not per project, so the
 * project-scoped version rendered the SAME corpus once per registered project.
 *
 * Rendered directly (not through `AppRoutes`), the same convention as `workspace-tasks.test.tsx` /
 * `workspace-knowledge.test.tsx` — this route mounts OUTSIDE `ProjectScopeRoute` and needs no
 * `:projectId` param to resolve.
 *
 * Carried over from the project-scoped file: the tab badges keep showing the WHOLE queue while a
 * tab filters it, a dismissal cannot be sent without a reason, a reopen SAYS the task it orphaned
 * is still on the board, and the page renders a "switched off" state rather than an empty queue
 * when `CEZ_KB` is unset.
 *
 * New here: a row's `project`/`projects` fields (every row now carries both), the project filter
 * pill, and the "open document" link's canonical-project scoping — the three things that did not
 * exist before a report could belong to more than one project.
 */

interface SentRequest {
  path: string
  method: string
  body?: unknown
}

// ---- fixtures --------------------------------------------------------------------------------

const PENDING: ReportListItem = {
  key: 'report-2026-08-18-digest',
  docId: 'reports-aabbccdd0011',
  project: 'boot',
  projects: ['boot'],
  title: 'Daily digest still fires at 08:00',
  domain: 'beside',
  tags: ['user-report'],
  filedAt: '2026-08-18T21:04:00.000Z',
  status: 'pending',
  statusSource: 'default',
}

/** Resolved by THREE projects, and — the load-bearing detail — its canonical `project` ('shop')
 *  is neither the first entry of `projects` (alphabetical: api, boot, shop) nor an alphabetically
 *  first anything. Any code that read `projects[0]`, or sorted-first, instead of `project` itself
 *  would build the wrong "open document" link and this fixture is what would catch it. */
const APPROVED: ReportListItem = {
  key: 'report-2026-08-17-share',
  docId: 'reports-ffeeddcc2233',
  project: 'shop',
  projects: ['api', 'boot', 'shop'],
  title: 'Location share button does nothing',
  tags: ['user-report'],
  filedAt: '2026-08-17T09:00:00.000Z',
  status: 'approved',
  statusSource: 'triage',
  triage: {
    key: 'report-2026-08-17-share',
    keyKind: 'identifier',
    status: 'approved',
    at: '2026-08-18T10:00:00.000Z',
    todoId: 'todo-1',
    todoProjectId: 'shop',
  },
}

const DISMISSED: ReportListItem = {
  key: 'report-2026-08-16-typo',
  docId: 'reports-11223344aabb',
  project: 'api',
  projects: ['api'],
  title: 'Typo in the pricing page',
  tags: ['user-report'],
  filedAt: '2026-08-16T09:00:00.000Z',
  status: 'dismissed',
  statusSource: 'triage',
  triage: {
    key: 'report-2026-08-16-typo',
    keyKind: 'catalog-id',
    status: 'dismissed',
    at: '2026-08-18T11:00:00.000Z',
    reason: 'already fixed',
  },
}

/** Every count describes the WHOLE set regardless of the `status`/`project` filter — the server's
 *  contract, reproduced here so a badge (or the project picker) that started counting the
 *  filtered page fails. */
const COUNTS = { pending: 1, approved: 1, dismissed: 1, total: 3 }

/** `ReportsResponse.projects` — one row per project the fan-out considered, dead ones included.
 *  Deliberately NOT the same set as the fixtures' `project`/`projects` values above name (`api`,
 *  `boot`, `shop`) so the filter picker's options are a real, independently-sourced list. */
const PROJECTS_HEALTH: ReportsResponse['projects'] = [
  { id: 'boot', name: 'boot', status: 'ok', ok: true, total: 1 },
  { id: 'api', name: 'API', status: 'ok', ok: true, total: 2 },
  { id: 'shop', name: 'Shop', status: 'missing', ok: false, reason: 'checkout not found on disk', total: 0 },
]

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

/** Stateful stub in the house style (`inbox.test.tsx`): a triage POST really moves the report, so
 *  the invalidation refetch answers with the new status rather than the old one. */
function stubFetch(
  options: {
    knowledge?: boolean
    items?: ReportListItem[]
    projects?: ReportsResponse['projects']
    overrides?: Record<string, () => Response | Promise<Response>>
  } = {},
): SentRequest[] {
  const sent: SentRequest[] = []
  let items = [...(options.items ?? [PENDING, APPROVED, DISMISSED])]
  const knowledge = options.knowledge ?? true
  const projectsHealth = options.projects ?? PROJECTS_HEALTH

  const counts = () => ({
    pending: items.filter((i) => i.status === 'pending').length,
    approved: items.filter((i) => i.status === 'approved').length,
    dismissed: items.filter((i) => i.status === 'dismissed').length,
    total: items.length,
  })

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)
      const path = url.split('?')[0]!
      const method = init.method ?? 'GET'
      sent.push({ path: url, method, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) })
      const override = options.overrides?.[`${method} ${path}`]
      if (override) return override()

      if (method === 'GET' && path === '/api/v1/health') return jsonResponse(health(knowledge))
      if (method === 'GET' && path === '/api/v1/workspace/reports') {
        const params = new URL(url, 'http://workspace-reports.test').searchParams
        const status = params.get('status') as ReportStatus | null
        const project = params.get('project')
        let filtered = items
        if (status !== null) filtered = filtered.filter((i) => i.status === status)
        // A MEMBERSHIP test against `projects`, never equality against the canonical `project` —
        // the real contract's own point (a shared report stays visible under every project that
        // resolves it).
        if (project !== null) filtered = filtered.filter((i) => i.projects.includes(project))
        return jsonResponse({
          enabled: true,
          items: filtered,
          // Deliberately the WHOLE-set counts and the WHOLE project-health list even on a
          // filtered request.
          counts: counts(),
          truncated: false,
          projects: projectsHealth,
        })
      }
      if (method === 'GET' && path.startsWith('/api/v1/workspace/reports/')) {
        const key = decodeURIComponent(path.slice('/api/v1/workspace/reports/'.length))
        const item = items.find((i) => i.key === key)
        return jsonResponse({ enabled: true, item: item ?? null, body: `The body of ${key}.` })
      }
      if (method === 'POST' && path.endsWith('/approve')) {
        const key = decodeURIComponent(
          path.slice('/api/v1/workspace/reports/'.length, -'/approve'.length),
        )
        items = items.map((i) => (i.key === key ? { ...i, status: 'approved' as const } : i))
        return jsonResponse({
          item: items.find((i) => i.key === key),
          todo: { id: 'todo-new', summary: 'x' },
          alreadyApproved: false,
        })
      }
      if (method === 'POST' && path.endsWith('/dismiss')) {
        const key = decodeURIComponent(
          path.slice('/api/v1/workspace/reports/'.length, -'/dismiss'.length),
        )
        items = items.map((i) => (i.key === key ? { ...i, status: 'dismissed' as const } : i))
        return jsonResponse({ item: items.find((i) => i.key === key) })
      }
      if (method === 'POST' && path.endsWith('/reopen')) {
        const key = decodeURIComponent(
          path.slice('/api/v1/workspace/reports/'.length, -'/reopen'.length),
        )
        items = items.map((i) => (i.key === key ? { ...i, status: 'pending' as const } : i))
        return jsonResponse({ item: items.find((i) => i.key === key), orphanedTodoId: 'todo-1' })
      }
      if (method === 'POST' && path === '/api/v1/workspace/reports/process-pending') {
        return jsonResponse({ outcomes: [{ key: PENDING.key, ok: true }], converted: 1, failed: 0 })
      }
      return jsonResponse({ error: 'not found' }, 404)
    }),
  )
  return sent
}

function renderReports(entry = '/workspace/reports') {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/workspace/reports" element={<WorkspaceReportsRoute />} />
          {/* Where "open document" is supposed to land — a per-project scoped route, never the
              plain `/knowledge` the old project-scoped page could reach via the ambient scope. */}
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

// Radix's dropdown (the project filter pill) positions with floating-ui (ResizeObserver); jsdom
// ships neither (`project-filter.test.tsx`/`workspace-tasks.test.tsx` precedent).
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }))
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
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

// ---- the flag-off state -----------------------------------------------------------------------

describe('reports route — knowledge off', () => {
  it('says reports are OFF rather than showing an empty queue, and never asks for the list', async () => {
    const sent = stubFetch({ knowledge: false })
    renderReports()
    expect(await screen.findByText('Reports are off')).toBeTruthy()
    // "No reports yet" and "off" look the same to a user, and only one of them is worth waiting
    // for — so the page must not render the empty-queue copy here.
    expect(screen.queryByText('No reports yet')).toBeNull()
    expect(sent.some((r) => r.path.startsWith('/api/v1/workspace/reports'))).toBe(false)
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
    expect(sent.some((r) => r.path === '/api/v1/workspace/reports?status=dismissed')).toBe(true)
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

  /** The corpus this feature shipped against carries reports the previous tracker had already
   *  processed. Those read as `approved` with `statusSource: 'document'` — approved, but by nobody
   *  here, with no task on this board. The row has to say so, and it has to offer the action that
   *  actually helps. */
  it('a report handled before triage existed says so, and offers Approve rather than Reopen', async () => {
    const HANDLED: ReportListItem = {
      key: 'notion:396b9863',
      docId: 'reports-999888777666',
      project: 'boot',
      projects: ['boot'],
      title: 'Handled by the old tracker',
      tags: ['notion-report', 'status/processed'],
      status: 'approved',
      statusSource: 'document',
    }
    stubFetch({ items: [HANDLED] })
    renderReports()
    // The tabs only exist once health has resolved the capability, so wait for them rather than
    // clicking into a null.
    await waitFor(() => expect(tab('approved')).toBeTruthy())
    fireEvent.click(tab('approved'))
    await waitFor(() => expect(cards()).toHaveLength(1))

    expect(cards()[0]!.querySelector('[data-slot="report-prior-status"]')).toBeTruthy()
    // Reopen would delete a row that is not there, leaving the document's tag in charge — a button
    // that visibly does nothing. Approve files the task nobody ever filed.
    expect(action(cards()[0]!, 'report-reopen')).toBeNull()
    expect(action(cards()[0]!, 'report-approve')).toBeTruthy()

    // NEGATIVE CONTROL: the same row with a real triage row gets the opposite pair, so the two
    // assertions above are keyed on `statusSource` and not on something incidental.
    cleanup()
    stubFetch({ items: [{ ...HANDLED, statusSource: 'triage', triage: APPROVED.triage }] })
    renderReports()
    await waitFor(() => expect(tab('approved')).toBeTruthy())
    fireEvent.click(tab('approved'))
    await waitFor(() => expect(cards()).toHaveLength(1))
    expect(cards()[0]!.querySelector('[data-slot="report-prior-status"]')).toBeNull()
    expect(action(cards()[0]!, 'report-reopen')).toBeTruthy()
    expect(action(cards()[0]!, 'report-approve')).toBeNull()
  })

  it('expanding a row loads the report body and puts the key in the URL', async () => {
    stubFetch()
    renderReports()
    await waitFor(() => expect(cards()).toHaveLength(1))
    fireEvent.click(action(cards()[0]!, 'report-expand')!)
    expect(await screen.findByText(`The body of ${PENDING.key}.`)).toBeTruthy()
  })
})

// ---- the project column (new — a row can now belong to N projects) ----------------------------

describe('reports route — the project column', () => {
  it('a single-project report reads as owned by that project', async () => {
    stubFetch()
    renderReports()
    await waitFor(() => expect(cards()).toHaveLength(1))
    const badge = cards()[0]!.querySelector('[data-slot="report-project"]')!
    expect(badge.getAttribute('data-shared')).toBe('false')
    expect(badge.textContent).toContain('boot')
  })

  it('a report resolved by three projects reads as SHARED, never as three chips', async () => {
    stubFetch()
    renderReports()
    await waitFor(() => expect(cards()).toHaveLength(1))
    fireEvent.click(tab('approved'))
    await waitFor(() => expect(cards()[0]?.dataset.status).toBe('approved'))

    const badge = cards()[0]!.querySelector('[data-slot="report-project"]')!
    expect(badge.getAttribute('data-shared')).toBe('true')
    expect(badge.textContent).toContain('3 projects')
    // The whole bug this move fixes was a shared report reading as though ONE project owned it —
    // so the compact badge must not spell out the individual names as separate chips either.
    expect(cards()[0]!.querySelectorAll('[data-slot="report-project"]')).toHaveLength(1)
  })
})

// ---- the project filter (new) ------------------------------------------------------------------

describe('reports route — the project filter', () => {
  it('picking a project narrows the request without changing the badge counts', async () => {
    const sent = stubFetch()
    renderReports()
    await waitFor(() => expect(cards()).toHaveLength(1))
    const countsBefore = tab('pending').textContent

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Filter reports by project' }))
    const menu = await screen.findByRole('menu')
    const options = within(menu).getAllByRole('menuitemradio')
    fireEvent.click(options.find((o) => o.textContent?.startsWith('API'))!)

    await waitFor(() =>
      expect(sent.some((r) => r.method === 'GET' && r.path.includes('project=api'))).toBe(true),
    )
    // `counts` describes the WHOLE set regardless of the project filter — the same contract the
    // status tabs already rely on, extended to the new filter. `project` is part of the query
    // key, so picking one is a fresh TanStack key and the badge briefly has no count mid-flight
    // (the same gap a status-tab switch has) — wait for the filtered request to resolve before
    // comparing, rather than asserting on the mid-flight render.
    await waitFor(() => expect(tab('pending').textContent).toBe(countsBefore))
  })

  it('offers a dead project too, carrying its reason', async () => {
    stubFetch()
    renderReports()
    await waitFor(() => expect(cards()).toHaveLength(1))
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Filter reports by project' }))
    const menu = await screen.findByRole('menu')
    // `Shop` is `ok: false` in `PROJECTS_HEALTH` — it must still be offered, not silently dropped,
    // with its reason attached (`desc`, the same convention `PickerPill` uses elsewhere).
    const options = within(menu).getAllByRole('menuitemradio')
    const shopOption = options.find((o) => o.textContent?.startsWith('Shop'))
    expect(shopOption?.textContent).toContain('checkout not found on disk')
  })
})

// ---- the open-document link (new — must follow the CANONICAL project) -------------------------

describe('reports route — the open-document link', () => {
  it("scopes to the row's canonical `project`, not the first (or any) entry of `projects`", async () => {
    stubFetch()
    renderReports()
    await waitFor(() => expect(cards()).toHaveLength(1))
    const pendingLink = cards()[0]!.querySelector<HTMLAnchorElement>('[data-slot="report-doc-link"]')!
    expect(pendingLink.getAttribute('href')).toBe(`/p/boot/knowledge?doc=${encodeURIComponent(PENDING.docId)}`)

    fireEvent.click(tab('approved'))
    await waitFor(() => expect(cards()[0]?.dataset.status).toBe('approved'))
    const sharedLink = cards()[0]!.querySelector<HTMLAnchorElement>('[data-slot="report-doc-link"]')!
    // APPROVED's `project` is 'shop', while `projects` is `['api','boot','shop']` — alphabetically
    // FIRST is 'api', not 'shop'. A link built from `projects[0]` (or any sort order) rather than
    // the canonical `project` field would point at the wrong project's knowledge base.
    expect(sharedLink.getAttribute('href')).toBe(`/p/shop/knowledge?doc=${encodeURIComponent(APPROVED.docId)}`)
  })
})

// ---- triage -----------------------------------------------------------------------------------

describe('reports route — triage', () => {
  it('Approve posts to the approve route and the row leaves the pending tab, without a reload', async () => {
    const sent = stubFetch()
    renderReports()
    await waitFor(() => expect(cards()).toHaveLength(1))

    fireEvent.click(action(cards()[0]!, 'report-approve')!)
    await waitFor(() => expect(cards()).toHaveLength(0))
    expect(
      sent.some((r) => r.method === 'POST' && r.path === `/api/v1/workspace/reports/${PENDING.key}/approve`),
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
        [`POST /api/v1/workspace/reports/${PENDING.key}/approve`]: () =>
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
      sent.some((r) => r.method === 'POST' && r.path === '/api/v1/workspace/reports/process-pending'),
    ).toBe(true)
  })

  it('a partly-failed bulk convert says how many were dropped', async () => {
    stubFetch({
      overrides: {
        'POST /api/v1/workspace/reports/process-pending': () =>
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
