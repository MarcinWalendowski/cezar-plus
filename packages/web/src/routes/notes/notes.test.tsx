import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type {
  HealthResponse,
  NoteRecord,
  NotesListResponse,
} from '@open-mercato/cezar-api-client'

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
  render(
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
