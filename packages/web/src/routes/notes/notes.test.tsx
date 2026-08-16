import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type {
  HealthResponse,
  NoteRecord,
  NoteSummary,
  NotesListResponse,
} from '@loki-labs/better-cezar-api-client'

import { NotesRoute } from './notes'

/**
 * `/notes` — the capture inbox and its review gate (`.ai/specs/2026-08-14-note-to-spec-pipeline.md`).
 *
 * The two assertions that carry weight: **flag off never fetches the family** (so a gated server
 * is not asked a question it will answer emptily, which would paint "no notes yet" over "the
 * feature is off"), and **nothing starts a run without a click on a proposal a person can read**
 * — the review gate is the feature, so a render that quietly approves is the failure this file
 * exists to catch.
 */

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

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
    knowledge: false,
    sources: false,
    notes: true,
    workspaceViews: false,
    notify: false,
    skills: true,
  },
  projects: [{ id: 'default', name: 'cezar' }],
  bootProject: 'default',
}

const HEALTH_OFF: HealthResponse = {
  ...HEALTH_ON,
  capabilities: { ...HEALTH_ON.capabilities, notes: false },
}

const NOTE: NoteRecord = {
  id: 'note_1',
  capturedAt: '2026-08-14T10:00:00.000Z',
  source: 'cockpit',
  body: 'Ship the exporter in api, and fix the retry backoff in web',
  status: 'processed',
  title: 'Ship the exporter',
  titleOrigin: 'auto',
  resultingTasks: [],
  pass: {
    id: 'pass_1',
    startedAt: '2026-08-14T10:01:00.000Z',
    runner: 'claude',
    summary: 'Two separate pieces of work, in two projects.',
    proposals: [
      {
        id: 'p1',
        projectId: 'api',
        title: 'Add the CSV exporter',
        task: 'Write a spec for the CSV exporter.',
        rationale: 'Nothing on the board covers it.',
        issues: [],
        decision: 'pending',
      },
      {
        id: 'p2',
        projectId: 'web',
        title: 'Fix the retry backoff',
        task: 'Write a spec for the retry backoff fix.',
        rationale: 'Already tracked.',
        issues: [],
        decision: 'pending',
        duplicateOf: { projectId: 'web', title: 'Retry backoff', reason: 'run #12 covers it' },
      },
    ],
    unassigned: [],
    fallback: false,
    truncated: false,
    consideredProjects: ['api', 'web'],
    boardDigestSize: 2,
  },
}

const LIST: NotesListResponse = {
  notes: [
    {
      id: NOTE.id,
      capturedAt: NOTE.capturedAt,
      source: NOTE.source,
      status: NOTE.status,
      title: NOTE.title,
      titleOrigin: NOTE.titleOrigin,
      resultingTasks: [],
      excerpt: NOTE.body,
      proposalCount: 2,
      targetProjects: ['api', 'web'],
    },
  ],
  truncated: false,
}

interface SentRequest {
  path: string
  method: string
  body: string | undefined
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function stubFetch(health: HealthResponse = HEALTH_ON, list: NotesListResponse = LIST): SentRequest[] {
  const sent: SentRequest[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input)
      const method = init.method ?? 'GET'
      sent.push({ path, method, body: typeof init.body === 'string' ? init.body : undefined })

      if (path === '/api/v1/health') return jsonResponse(health)
      if (method === 'GET' && path.startsWith('/api/v1/workspace/notes/')) {
        return jsonResponse({ note: NOTE })
      }
      if (method === 'GET' && path.startsWith('/api/v1/workspace/notes')) return jsonResponse(list)
      if (method === 'POST' && path === '/api/v1/workspace/notes') {
        return jsonResponse({ note: NOTE }, 201)
      }
      if (method === 'POST' && path.endsWith('/approve')) {
        return jsonResponse({
          note: NOTE,
          created: [{ proposalId: 'p1', projectId: 'api', runId: 'run_1' }],
          rejected: [],
        })
      }
      return jsonResponse({})
    }),
  )
  return sent
}

function renderNotes() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/notes']}>
        <Routes>
          <Route path="/notes" element={<NotesRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('NotesRoute: flag off', () => {
  it('renders the disabled state and never asks for the notes list', async () => {
    const sent = stubFetch(HEALTH_OFF)
    renderNotes()

    await screen.findByText('The notes inbox is off')
    expect(sent.some((request) => request.path.includes('/workspace/notes'))).toBe(false)
  })
})

describe('NotesRoute: capture', () => {
  it('posts what was typed and clears the box', async () => {
    const sent = stubFetch(HEALTH_ON, { notes: [], truncated: false })
    renderNotes()

    await screen.findByText('No notes yet')
    const box = screen.getByLabelText('New note') as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: '  Ship the exporter  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Capture note' }))

    await waitFor(() => expect(box.value).toBe(''))
    const post = sent.find((request) => request.method === 'POST')
    // Trimmed, and stamped as a cockpit capture rather than left for the server to guess.
    expect(JSON.parse(post?.body ?? '{}')).toEqual({ body: 'Ship the exporter', source: 'cockpit' })
  })

  it('refuses to submit whitespace', async () => {
    const sent = stubFetch(HEALTH_ON, { notes: [], truncated: false })
    renderNotes()

    await screen.findByText('No notes yet')
    fireEvent.change(screen.getByLabelText('New note'), { target: { value: '   ' } })

    expect(screen.getByRole('button', { name: 'Capture note' })).toHaveProperty('disabled', true)
    expect(sent.some((request) => request.method === 'POST')).toBe(false)
  })
})

describe('NotesRoute: the review gate', () => {
  it('lists proposals with their target project, and approves only after a click', async () => {
    const sent = stubFetch()
    renderNotes()

    fireEvent.click(await screen.findByText('Ship the exporter'))

    await screen.findByText('Add the CSV exporter')
    expect(screen.getByText('Fix the retry backoff')).toBeTruthy()
    // Each row names the repository it targets — a proposal without its project is unreviewable.
    expect(screen.getAllByText('api').length).toBeGreaterThan(0)

    // NOTHING has been approved by merely opening the note. This is the guard: expanding a note
    // must never start an agent run in someone's repository.
    expect(sent.some((request) => request.path.includes('/approve'))).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: /Write the spec/ }))
    await waitFor(() =>
      expect(sent.some((request) => request.path.endsWith('/note_1/approve'))).toBe(true),
    )
    const approve = sent.find((request) => request.path.endsWith('/approve'))
    // The DUPLICATE row starts deselected, so one proposal is approved, not both — pre-selecting
    // a suspected duplicate is how a note silently creates the work it just warned about.
    expect(JSON.parse(approve?.body ?? '{}')).toEqual({
      passId: 'pass_1',
      proposals: [{ id: 'p1' }],
    })
  })

  it('links each started run to its own project, and offers a REVIEWABLE implementation step', async () => {
    stubFetch(HEALTH_ON, {
      notes: [
        {
          ...(LIST.notes[0] as NonNullable<(typeof LIST.notes)[0]>),
          resultingTasks: [
            { proposalId: 'p1', projectId: 'api', runId: 'run_7', createdAt: '2026-08-14T11:00:00.000Z', kind: 'spec' },
          ],
        },
      ],
      truncated: false,
    })
    renderNotes()

    fireEvent.click(await screen.findByText('Ship the exporter'))

    const specRun = (await screen.findByText('Spec run')) as HTMLAnchorElement
    // Scoped to the run's OWN project, not the active one — the note page is workspace-level and
    // each row points somewhere different.
    expect(specRun.getAttribute('href')).toBe('/p/api/tasks/run_7')

    const implement = screen.getByText('Start implementation') as HTMLAnchorElement
    const href = implement.getAttribute('href') ?? ''
    // A prefilled COMPOSER, never a start. Implementing must cost a deliberate second click in
    // the repository it will change.
    expect(href.startsWith('/p/api/new?ref=')).toBe(true)
    expect(decodeURIComponent(href.split('ref=')[1] ?? '')).toContain('run_7')
  })

  it('shows a suspected duplicate rather than hiding it', async () => {
    stubFetch()
    renderNotes()

    fireEvent.click(await screen.findByText('Ship the exporter'))

    await screen.findByText('looks like a duplicate')
    // The reason is shown too: "we think this is a duplicate" is only actionable with the reason.
    expect(screen.getByText(/run #12 covers it/)).toBeTruthy()
  })
})

describe('NotesRoute: resulting-run status (D27 Phase 4a)', () => {
  /**
   * `resultingTasks` itself carries no status — the row reads it live from the run, by explicit
   * project id (`getProjectRun`), since `/notes` is workspace-level and the row's project is
   * usually not whichever one the sidebar has active. These guard that a budget-stopped
   * implementation run does not read as finished from this list, the same defect class
   * `attention.test.ts` and `review-panel.test.tsx` guard on the thread surfaces.
   */
  const RESULTING_LIST: NotesListResponse = {
    notes: [
      {
        ...(LIST.notes[0] as NonNullable<(typeof LIST.notes)[0]>),
        resultingTasks: [
          { proposalId: 'p1', projectId: 'api', runId: 'run_7', createdAt: '2026-08-14T11:00:00.000Z', kind: 'implementation' },
        ],
      },
    ],
    truncated: false,
  }

  function stubFetchWithRun(runBody: unknown): SentRequest[] {
    const sent: SentRequest[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = String(input)
        const method = init.method ?? 'GET'
        sent.push({ path, method, body: typeof init.body === 'string' ? init.body : undefined })
        if (path === '/api/v1/health') return jsonResponse(HEALTH_ON)
        if (method === 'GET' && path.startsWith('/api/v1/workspace/notes/')) return jsonResponse({ note: NOTE })
        if (method === 'GET' && path.startsWith('/api/v1/workspace/notes')) return jsonResponse(RESULTING_LIST)
        if (method === 'GET' && path === '/api/v1/p/api/runs/run_7') return jsonResponse(runBody)
        return jsonResponse({})
      }),
    )
    return sent
  }

  it('a budget-stopped implementation run reads as stopped, not as a plain review', async () => {
    // Guard: the row must not present a budget-stopped run as "needs review" (which reads as
    // finished work waiting to be looked at). Mutation that must turn this red: remove the
    // `<ResultingRunStatus>` render from `ResultingRuns` in notes.tsx — confirmed red, then
    // reverted (see report).
    const sent = stubFetchWithRun({ id: 'run_7', status: 'review', stopReason: 'budget' })
    renderNotes()

    fireEvent.click(await screen.findByText('Ship the exporter'))
    await screen.findByText('Implementation run')

    await screen.findByText('budget stopped')
    expect(screen.queryByText('needs review')).toBeNull()
    expect(sent.some((r) => r.method === 'GET' && r.path === '/api/v1/p/api/runs/run_7')).toBe(true)
  })

  it('a plain review implementation run — no stopReason — reads as "needs review"', async () => {
    // The inverse fixture: same row, same project, but a run that actually finished and is
    // waiting on a human. Distinguishing this from the case above is the whole point.
    stubFetchWithRun({ id: 'run_7', status: 'review' })
    renderNotes()

    fireEvent.click(await screen.findByText('Ship the exporter'))
    await screen.findByText('Implementation run')

    await screen.findByText('needs review')
    expect(screen.queryByText('budget stopped')).toBeNull()
  })

  it('reads the run from its OWN project, not the workspace-level scope the page mounts under', async () => {
    // Guard: a request to the wrong project (or the implicit `queryScope()`/'default' scope)
    // must not be mistaken for the row's answer. Mutation that must turn this red: swap
    // `getProjectRun(projectId, id)` for the implicit-scope `getRun(id)` in `useProjectRun` (or
    // in `ResultingRunStatus`) — the stub below answers nothing for `/api/v1/p/default/runs/*`
    // or `/api/v1/runs/*`, so the badge would never appear. Confirmed red, then reverted.
    const sent = stubFetchWithRun({ id: 'run_7', status: 'done' })
    renderNotes()

    fireEvent.click(await screen.findByText('Ship the exporter'))
    await screen.findByText('Implementation run')

    await screen.findByText('done')
    expect(sent.some((r) => r.path.includes('/p/default/runs/') || r.path === '/api/v1/runs/run_7')).toBe(
      false,
    )
  })
})

describe('NotesRoute: polling', () => {
  /**
   * `.ai/specs/2026-08-14-note-to-spec-pipeline.md`, "Runtime E2E — EXECUTED 2026-08-15": the API
   * had a note at `processed` while the page kept showing `processing`, and only a manual reload
   * picked it up. These guard the fix — the list has to leave `processing` on its own, it has to
   * STOP polling the instant nothing is pending (an idle inbox must not run a timer forever), and
   * unmounting has to actually clear that timer.
   *
   * Real timers, deliberately. The poll rides a mocked `fetch` through two dependent React Query
   * hooks (`useHealth` gates `useWorkspaceNotes`'s `enabled`), and `vi.useFakeTimers()` here fights
   * that chain — a first response was observed being silently retried by the query client's own
   * retry policy, needing an actual elapsed backoff to surface, which fake time never advanced. A
   * few seconds of real `setTimeout`/`waitFor` against the real `NOTES_POLL_MS` (2s) is slower but
   * verifiably correct.
   */

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

  function processingList(): NotesListResponse {
    return {
      notes: [{ ...(LIST.notes[0] as NonNullable<(typeof LIST.notes)[0]>), status: 'processing' }],
      truncated: false,
    }
  }

  it(
    'a note that flips to processed on the server shows up on its own — no reload',
    async () => {
      let listCalls = 0
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
          const path = String(input)
          const method = init.method ?? 'GET'
          if (path === '/api/v1/health') return jsonResponse(HEALTH_ON)
          if (method === 'GET' && path.startsWith('/api/v1/workspace/notes')) {
            listCalls += 1
            // Only the first answer is still processing; the server has already moved on.
            return jsonResponse(listCalls === 1 ? processingList() : LIST)
          }
          return jsonResponse({})
        }),
      )

      renderNotes()
      await screen.findByText('processing')

      // No click, no reload — just the poll interval doing its job.
      await waitFor(() => expect(screen.getByText('processed')).toBeTruthy(), { timeout: 6000 })
      expect(listCalls).toBeGreaterThanOrEqual(2)
    },
    8000,
  )

  it(
    'stops polling the instant every note is terminal',
    async () => {
      let listCalls = 0
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
          const path = String(input)
          const method = init.method ?? 'GET'
          if (path === '/api/v1/health') return jsonResponse(HEALTH_ON)
          if (method === 'GET' && path.startsWith('/api/v1/workspace/notes')) {
            listCalls += 1
            return jsonResponse(listCalls === 1 ? processingList() : LIST)
          }
          return jsonResponse({})
        }),
      )

      renderNotes()
      await screen.findByText('processing')
      expect(listCalls).toBe(1)

      await waitFor(() => expect(screen.getByText('processed')).toBeTruthy(), { timeout: 6000 })
      const callsOnceTerminal = listCalls
      expect(callsOnceTerminal).toBeGreaterThanOrEqual(2)

      // Wait past another whole poll interval. If the stop condition were not actually wired to
      // note status (e.g. hard-coded `true`), this window picks up an extra request; it must not.
      await sleep(2800)
      expect(listCalls).toBe(callsOnceTerminal)
    },
    12000,
  )

  it(
    'unmounting the route clears the poll timer',
    async () => {
      let listCalls = 0
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
          const path = String(input)
          const method = init.method ?? 'GET'
          if (path === '/api/v1/health') return jsonResponse(HEALTH_ON)
          if (method === 'GET' && path.startsWith('/api/v1/workspace/notes')) {
            listCalls += 1
            // Stays pending forever — if the timer survives unmount, it keeps firing.
            return jsonResponse(processingList())
          }
          return jsonResponse({})
        }),
      )

      const { unmount } = renderNotes()
      await screen.findByText('processing')
      const callsAtMount = listCalls
      expect(callsAtMount).toBe(1)

      unmount()
      await sleep(2800)
      expect(listCalls).toBe(callsAtMount)
    },
    8000,
  )

  it(
    'does not stack a request on top of one already in flight',
    async () => {
      let listCalls = 0
      let resolveSecond: (() => void) | undefined
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
          const path = String(input)
          const method = init.method ?? 'GET'
          if (path === '/api/v1/health') return jsonResponse(HEALTH_ON)
          if (method === 'GET' && path.startsWith('/api/v1/workspace/notes')) {
            listCalls += 1
            if (listCalls === 2) {
              // Hangs until the test releases it, spanning several poll ticks.
              await new Promise<void>((resolve) => {
                resolveSecond = resolve
              })
            }
            return jsonResponse(processingList())
          }
          return jsonResponse({})
        }),
      )

      renderNotes()
      await screen.findByText('processing')
      expect(listCalls).toBe(1)

      // The second poll starts and hangs — wait past it plus one more tick. Neither tick that
      // lands while it is in flight may start a third request.
      await sleep(4800)
      expect(listCalls).toBe(2)

      resolveSecond?.()
      // Freed up: the next tick is allowed to fire again.
      await waitFor(() => expect(listCalls).toBe(3), { timeout: 4000 })
    },
    10000,
  )

  it(
    'a status outside the known terminal set is treated as pending, not terminal',
    async () => {
      // `'queued'` is not in today's `noteStatusSchema` enum (`raw`/`processing`/`processed`/
      // `failed`) — it stands in for a status added later that `hasPendingNote` has never heard
      // of. Cast at the fixture boundary since the real type cannot express this value; that gap
      // is exactly the scenario being guarded (`TERMINAL_NOTE_STATUSES` in `notes.tsx`).
      const unknownStatus = 'queued' as unknown as NoteSummary['status']
      let listCalls = 0
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
          const path = String(input)
          const method = init.method ?? 'GET'
          if (path === '/api/v1/health') return jsonResponse(HEALTH_ON)
          if (method === 'GET' && path.startsWith('/api/v1/workspace/notes')) {
            listCalls += 1
            return jsonResponse({
              notes: [
                {
                  ...(LIST.notes[0] as NonNullable<(typeof LIST.notes)[0]>),
                  status: unknownStatus,
                },
              ],
              truncated: false,
            })
          }
          return jsonResponse({})
        }),
      )

      renderNotes()
      await screen.findByText('queued')
      expect(listCalls).toBe(1)

      // An unrecognized status must not be mistaken for terminal — the list must keep polling it.
      await waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(2), { timeout: 4000 })
    },
    8000,
  )
})
