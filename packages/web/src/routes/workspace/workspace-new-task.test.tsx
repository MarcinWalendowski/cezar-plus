import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { HealthResponse, NoteRecord, ProjectsResponse } from '@loki-labs/better-cezar-api-client'

import { WorkspaceNewTaskRoute } from './workspace-new-task'

/**
 * `/workspace/new` (Phase 1, `.ai/specs/2026-08-14-project-less-task-composer.md`). Rendered
 * directly (not through `AppRoutes`), same convention as the sibling `notes.test.tsx` and
 * `workspace-tasks.test.tsx` — this route mounts OUTSIDE `ProjectScopeRoute` and needs no
 * `:projectId` param to resolve.
 *
 * The scope-trap guard below is the one that matters most: it asserts on the SET of URLs
 * requested, because the failure mode is a successful request to the wrong project, not a throw
 * (spec Verification). It is duplicated for the D2 named-project menu path (below), because
 * rendering a project list is exactly where a scoped call would sneak in.
 */

beforeEach(() => {
  // The autonomous toggle's `Switch` primitive measures itself on mount via
  // `@radix-ui/react-use-size`, which needs `ResizeObserver` — jsdom ships neither it nor
  // floating-ui's positioning APIs (`project-filter.test.tsx`/`workspace-tasks.test.tsx` precedent).
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
  projects: [
    { id: 'default', name: 'cezar' },
    { id: 'shop', name: 'Shop' },
  ],
  bootProject: 'default',
}

const HEALTH_OFF: HealthResponse = {
  ...HEALTH_ON,
  capabilities: { ...HEALTH_ON.capabilities, notes: false },
}

const CREATED_NOTE: NoteRecord = {
  id: 'note_1',
  capturedAt: '2026-08-14T10:00:00.000Z',
  source: 'cockpit',
  body: 'Ship the exporter in api, and fix the retry backoff in web',
  status: 'raw',
  title: 'Ship the exporter',
  titleOrigin: 'auto',
  resultingTasks: [],
}

const PROCESSED_NOTE: NoteRecord = { ...CREATED_NOTE, status: 'processing' }

/** The workspace registry the D2 project menu reads. One `ok` project ("Shop", picked in the
 *  navigation tests) and one `missing` project ("Ghost", the disabled-row case) — the same two
 *  statuses `last-location.test.ts`'s fixture uses, kept minimal since the menu has no use for
 *  `not-git`. */
const PROJECTS_RESPONSE: ProjectsResponse = {
  bootProject: 'default',
  projectsDir: '/home/u/projects',
  projects: [
    {
      id: 'shop',
      name: 'Shop',
      root: '/home/u/shop',
      addedAt: '2026-08-01T00:00:00.000Z',
      lastOpenedAt: '2026-08-10T00:00:00.000Z',
      source: 'local',
      status: 'ok',
    },
    {
      id: 'gone',
      name: 'Ghost',
      root: '/home/u/gone',
      addedAt: '2026-08-01T00:00:00.000Z',
      lastOpenedAt: '2026-08-10T00:00:00.000Z',
      source: 'local',
      status: 'missing',
    },
  ],
}

interface SentRequest {
  path: string
  method: string
  body: string | undefined
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/**
 * The exact set of endpoints this page is allowed to touch — an ALLOWLIST, not a blocklist.
 *
 * The scope trap's real shape is not a `/p/<id>/…`-prefixed URL: with no `ProjectScopeProvider`
 * mounted (this page's actual situation), a project-scoped call goes out BARE and unscoped —
 * `/api/v1/repo`, no `/p/` in sight — and the server's own no-prefix convention silently answers
 * it with the boot project's data. A blocklist of named-in-advance surfaces (skills, workflows,
 * config, repo, runs, todos, …) only ever protects the endpoints someone thought to enumerate; an
 * endpoint added next month is never on that list, and the test stays green while the page reads
 * the wrong project. This allowlist inverts that: anything this page requests that is not named
 * here fails the test, so a future scoped call — with or without `/p/` — is caught by construction
 * rather than by remembering to update a list.
 */
function isAllowedRequestPath(path: string): boolean {
  if (path === '/api/v1/health') return true
  if (path === '/api/v1/projects') return true
  if (path === '/api/v1/workspace/notes') return true
  if (/^\/api\/v1\/workspace\/notes\/[^/]+\/process$/.test(path)) return true
  return false
}

function stubFetch(health: HealthResponse = HEALTH_ON, projects: ProjectsResponse = PROJECTS_RESPONSE): SentRequest[] {
  const sent: SentRequest[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input)
      const method = init.method ?? 'GET'
      sent.push({ path, method, body: typeof init.body === 'string' ? init.body : undefined })

      if (path === '/api/v1/health') return jsonResponse(health)
      if (method === 'GET' && path === '/api/v1/projects') return jsonResponse(projects)
      if (method === 'POST' && path === '/api/v1/workspace/notes') {
        return jsonResponse({ note: CREATED_NOTE }, 201)
      }
      if (method === 'POST' && path === '/api/v1/workspace/notes/note_1/process') {
        return jsonResponse({ note: PROCESSED_NOTE })
      }
      return jsonResponse({})
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

/** Waits past the health fetch — the composer stays on its "Loading…" shell until
 *  `useHealth().data` resolves, same gate `notes.tsx` and `workspace-tasks.tsx` use. */
async function composerReady(): Promise<HTMLTextAreaElement> {
  return (await screen.findByLabelText('New task')) as HTMLTextAreaElement
}

function renderComposer() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/workspace/new']}>
        <Routes>
          <Route path="/workspace/new" element={<WorkspaceNewTaskRoute />} />
          <Route path="/notes" element={<p>the notes review surface</p>} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('WorkspaceNewTaskRoute: flag off', () => {
  it('renders the disabled state, names the flag, and never asks for the notes family', async () => {
    const sent = stubFetch(HEALTH_OFF)
    renderComposer()

    await screen.findByText('The project-less composer is off')
    expect(screen.getByText(/CEZ_NOTES=1/)).toBeTruthy()
    expect(screen.getByText(/restart cezar/)).toBeTruthy()
    // The textarea must not exist at all — never a composer that accepts text it cannot process.
    expect(screen.queryByLabelText('New task')).toBeNull()
    expect(sent.some((request) => request.path.includes('/workspace/notes'))).toBe(false)
  })
})

describe('WorkspaceNewTaskRoute: default state', () => {
  it('shows Auto detect and renders no skill pill, template menu, or base-branch pill', async () => {
    stubFetch()
    renderComposer()

    const pill = await screen.findByLabelText('Target project')
    expect(pill.textContent).toBe('Auto detect')

    // Project-derived controls: none of them have meaning with no project selected (spec
    // "Solution" §3's table). Their absence is asserted by the exact aria-label the per-project
    // composer gives each one (`new-task.tsx`), so re-adding any of them turns this red.
    expect(screen.queryByLabelText('Choose a skill or workflow')).toBeNull()
    expect(screen.queryByLabelText('Insert a prompt template')).toBeNull()
    expect(screen.queryByLabelText('Base branch')).toBeNull()
  })
})

describe('WorkspaceNewTaskRoute: the project menu (D2)', () => {
  it('lists Auto detect first and checked, then every registered project in registry order', async () => {
    stubFetch()
    renderComposer()
    await composerReady()

    fireEvent.pointerDown(screen.getByLabelText('Target project'))
    const menu = await screen.findByTestId('target-pill-menu')
    const items = await within(menu).findAllByRole('menuitemradio')

    // Order AND default-checked in one assertion: dropping Auto detect from first position, or
    // making it non-default, turns this red either way.
    expect(items.map((item) => item.textContent)).toEqual(['Auto detect', 'Shop', 'Ghostfolder not found'])
    expect(items.map((item) => item.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false'])
  })

  it('disables a missing project with a visible reason, and selecting it does nothing', async () => {
    stubFetch()
    renderComposer()
    await composerReady()

    fireEvent.pointerDown(screen.getByLabelText('Target project'))
    const menu = await screen.findByTestId('target-pill-menu')
    const ghost = await within(menu).findByRole('menuitemradio', { name: /Ghost/ })

    expect(ghost.getAttribute('aria-disabled')).toBe('true')
    expect(within(ghost).getByText('folder not found')).toBeTruthy()

    fireEvent.click(ghost)

    // Radix refuses the select on a disabled item at the event-handler level, not just with CSS —
    // so this must be a true no-op: no navigation, and the pill still reads its resting label.
    expect(screen.getByTestId('location').textContent).toBe('/workspace/new')
    expect(screen.getByLabelText('Target project').textContent).toBe('Auto detect')
  })

  it('picking a named, ok-status project navigates to its prefilled composer and posts nothing', async () => {
    const sent = stubFetch()
    renderComposer()

    fireEvent.change(await composerReady(), { target: { value: 'Ship the exporter' } })
    fireEvent.pointerDown(screen.getByLabelText('Target project'))
    const menu = await screen.findByTestId('target-pill-menu')
    fireEvent.click(await within(menu).findByRole('menuitemradio', { name: 'Shop' }))

    // Same shape `newTaskPrefillHref` builds, scoped with `scopeTo` — `/p/shop/new?ref=<body>`.
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/p/shop/new?ref=Ship+the+exporter'),
    )
    // A navigation, not a submit (spec D2): if this creates a note first, it makes a
    // project-less note for a task the user just told it the project of.
    expect(sent.some((request) => request.method === 'POST')).toBe(false)
  })
})

describe('WorkspaceNewTaskRoute: the explainer', () => {
  it('is visible text, not a title attribute', async () => {
    stubFetch()
    renderComposer()
    await composerReady()

    // A `title`-only assertion must not pass this test: `getByText` fails on invisible text, it
    // never reads a `title` attribute.
    expect(
      screen.getByText(
        'cezar reads each detected project and writes a spec there. It stops at the spec — you review the proposals, then start the implementation yourself.',
      ),
    ).toBeTruthy()
  })

  it('renders the autonomous toggle, off by default (D27 Phase 4b — it now means something)', async () => {
    // D3 (2026-08-14) pulled the toggle because nothing consumed the field. Phase 4b restores it
    // now that `createNoteInputSchema.autonomous` and the continuation trigger both ship. Off by
    // default: starting unattended agents across repos is opt-in, never opt-out.
    stubFetch()
    renderComposer()
    await composerReady()

    const toggle = screen.getByRole('switch', { name: 'Continue automatically after the spec' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
  })

  it('swaps the explainer text with the toggle, and neither variant says "autonomous mode"', async () => {
    stubFetch()
    renderComposer()
    await composerReady()

    expect(screen.getByText(/It stops at the spec — you review the proposals/)).toBeTruthy()

    fireEvent.click(screen.getByRole('switch', { name: 'Continue automatically after the spec' }))

    const onCopy = await screen.findByText(/starts in the same repo, commits locally, and never pushes/)
    expect(onCopy.textContent).not.toContain('autonomous mode')
    // The two facts that matter most on a control like this: it never pushes, and a run can stop
    // incomplete on its own budget — Phase 4a's whole point was making that visible everywhere.
    expect(onCopy.textContent).toContain('never pushes')
    expect(onCopy.textContent).toContain('stop early on its step budget')
    expect(screen.queryByText(/It stops at the spec — you review the proposals/)).toBeNull()
  })
})

describe('WorkspaceNewTaskRoute: Auto-detect submit', () => {
  it('posts the note then processes it, in that order, with the typed text', async () => {
    const sent = stubFetch()
    renderComposer()

    const box = await composerReady()
    fireEvent.change(box, {
      target: { value: '  Ship the exporter in api, and fix the retry backoff in web  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }))

    await waitFor(() =>
      expect(sent.some((request) => request.path === '/api/v1/workspace/notes/note_1/process')).toBe(
        true,
      ),
    )
    const createIndex = sent.findIndex((request) => request.path === '/api/v1/workspace/notes')
    const processIndex = sent.findIndex(
      (request) => request.path === '/api/v1/workspace/notes/note_1/process',
    )
    expect(createIndex).toBeGreaterThanOrEqual(0)
    expect(processIndex).toBeGreaterThan(createIndex)

    const created = sent[createIndex]
    expect(JSON.parse(created?.body ?? '{}')).toEqual({
      body: 'Ship the exporter in api, and fix the retry backoff in web',
      source: 'cockpit',
      autonomous: false,
    })
  })

  it('lands on the review surface after processing starts', async () => {
    stubFetch()
    renderComposer()

    fireEvent.change(await composerReady(), { target: { value: 'Ship the exporter' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }))

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/notes'))
  })

  it('refuses to submit whitespace', async () => {
    const sent = stubFetch()
    renderComposer()

    fireEvent.change(await composerReady(), { target: { value: '   ' } })
    expect(screen.getByRole('button', { name: 'Start task' })).toHaveProperty('disabled', true)
    expect(sent.some((request) => request.method === 'POST')).toBe(false)
  })
})

describe('WorkspaceNewTaskRoute: the autonomous field on submit (D27 Phase 4b)', () => {
  it('toggle ON sends autonomous: true', async () => {
    // Guard: dropping the field from the payload must turn this red — a toggle that renders but
    // sends nothing is exactly the D3 failure mode this phase is undoing.
    const sent = stubFetch()
    renderComposer()

    fireEvent.change(await composerReady(), { target: { value: 'Ship the exporter' } })
    fireEvent.click(screen.getByRole('switch', { name: 'Continue automatically after the spec' }))
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }))

    await waitFor(() => expect(sent.some((r) => r.path === '/api/v1/workspace/notes')).toBe(true))
    const created = sent.find((r) => r.path === '/api/v1/workspace/notes')
    expect(JSON.parse(created?.body ?? '{}')).toEqual({
      body: 'Ship the exporter',
      source: 'cockpit',
      autonomous: true,
    })
  })

  it('toggle OFF (default) sends autonomous: false — the paired guard that matters most', async () => {
    // The dangerous direction, per the task: an implementation that always sends `true` would
    // pass the test above while doing the single most dangerous thing this control can do —
    // starting unattended agents across repos nobody opted into. Mutation: send `true`
    // unconditionally — must turn this red.
    const sent = stubFetch()
    renderComposer()

    fireEvent.change(await composerReady(), { target: { value: 'Ship the exporter' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }))

    await waitFor(() => expect(sent.some((r) => r.path === '/api/v1/workspace/notes')).toBe(true))
    const created = sent.find((r) => r.path === '/api/v1/workspace/notes')
    expect(JSON.parse(created?.body ?? '{}')).toEqual({
      body: 'Ship the exporter',
      source: 'cockpit',
      autonomous: false,
    })
  })
})

describe('WorkspaceNewTaskRoute: the scope trap', () => {
  it('touches only the workspace-level endpoints on the allowlist for an Auto-detect submit', async () => {
    const sent = stubFetch()
    renderComposer()

    fireEvent.change(await composerReady(), { target: { value: 'Ship the exporter' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }))
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/notes'))

    // Every request this run made must be on the allowlist — the inverse of a blocklist, so an
    // endpoint nobody thought to name is refused by default rather than let through.
    expect(sent.every((request) => isAllowedRequestPath(request.path))).toBe(true)
    // Sanity: it DID talk to the workspace-level notes surface, so the assertion above is not
    // vacuous (an empty request log would also pass it for the wrong reason).
    expect(sent.some((request) => request.path.startsWith('/api/v1/workspace/notes'))).toBe(true)
  })

  it('holds with the named-project menu open and a project picked — rendering the project list is exactly where a scoped call would sneak in', async () => {
    const sent = stubFetch()
    renderComposer()

    fireEvent.change(await composerReady(), { target: { value: 'Ship the exporter' } })
    fireEvent.pointerDown(screen.getByLabelText('Target project'))
    const menu = await screen.findByTestId('target-pill-menu')
    fireEvent.click(await within(menu).findByRole('menuitemradio', { name: 'Shop' }))
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/p/shop/new?ref=Ship+the+exporter'),
    )

    expect(sent.every((request) => isAllowedRequestPath(request.path))).toBe(true)
    // Sanity: the menu DID fetch the workspace-level registry, so the assertion above is not
    // vacuous by way of an empty request log.
    expect(sent.some((request) => request.path === '/api/v1/projects')).toBe(true)
  })
})

describe('WorkspaceNewTaskRoute: submit never bypasses approval', () => {
  it('a normal Auto-detect submit never calls approve — starting a run always costs the review-gate click on /notes', async () => {
    const sent = stubFetch()
    renderComposer()

    fireEvent.change(await composerReady(), { target: { value: 'Ship the exporter' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }))

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/notes'))
    expect(sent.some((request) => request.path.includes('/approve'))).toBe(false)
  })
})
