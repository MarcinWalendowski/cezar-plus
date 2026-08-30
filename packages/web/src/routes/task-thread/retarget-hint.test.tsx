import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type {
  ApiRun,
  HealthResponse,
  ProviderStatusResponse,
  StepState,
} from '@loki-labs/better-cezar-api-client'
import { resetToasts, Toaster } from '@/components/ui/toaster'
import { Link } from '@/lib/project-router'

import { RetargetHint } from './retarget-hint'
import { RetargetMenuButton } from './retarget-menu'

/**
 * "Run on…" — moving a PARKED task to another engine
 * (spec `.ai/specs/2026-08-23-retarget-task-to-another-engine.md`, Phase 5).
 *
 * The contract pinned here is the one a person is most likely to be burnt by: **an untouched pill
 * is not sent.** Somebody who opens this to change the runner must not silently also re-pin the
 * model they never looked at, because the server reads an omitted field as "keep what the run
 * has" and a present one as a deliberate choice. The two are indistinguishable from the UI and
 * only the request body can tell them apart.
 *
 * Fixtures are shared in shape with `follow-up-engine.test.tsx`, deliberately: the two controls
 * are built from the same pills and must keep answering the same way.
 */

beforeAll(() => {
  // Radix scrolls the active item into view; jsdom has neither.
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
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
  resetToasts()
  vi.unstubAllGlobals()
})

const HEALTH_MULTI: HealthResponse = {
  version: '0.1.5',
  projects: [],
  bootProject: 'default',
  repoRoot: '/repo',
  repo: { root: '/repo', branch: 'main' },
  defaultRunner: 'claude',
  checks: [
    { name: 'claude', available: true },
    { name: 'codex', available: true },
    { name: 'git', available: true },
  ],
  forge: null,
  // `followups` became a required capability in #471 (merged from main): irrelevant to the
  // Continue pills these tests drive, but the shape must be whole.
  capabilities: { cluster: false, localHandoff: true, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: true, singleProject: false, knowledge: false, sources: false, notes: false, workspaceViews: false, notify: false, accountUsage: false, autoAccounts: false, skills: true, automations: false },
}

type Recorded = { method: string; url: string; body?: unknown }
let requests: Recorded[]

const providersForHealth = (health: HealthResponse): ProviderStatusResponse => ({
  providers: (['claude', 'codex', 'opencode'] as const).map((provider) => ({
    provider,
    status: health.checks.some((check) => check.name === provider && check.available)
      ? 'connected' as const
      : 'not-installed' as const,
    enabled: true,
  })),
})

function serve(
  health: HealthResponse = HEALTH_MULTI,
  defaultModels: Record<string, string> = {},
  providerStatus: ProviderStatusResponse | { error: string } = providersForHealth(health),
  providerStatusCode = 200,
  modelsLocked = false,
  /** The global engine lock on `GET /workspace/config`
   *  (`.ai/specs/2026-08-29-global-provider-toggle.md`). `undefined` omits the key, which is the
   *  shape this file served before the lock existed. */
  runnerLock: 'claude' | 'codex' | null | undefined = undefined,
) {
  requests = []
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input)
      const method = init.method ?? 'GET'
      const body = init.body ? (JSON.parse(String(init.body)) as unknown) : undefined
      requests.push({ method, url, body })
      if (url === '/api/v1/health') return json(health)
      if (url === '/api/v1/providers/status') return json(providerStatus, providerStatusCode)
      if (url === '/api/v1/models?runner=codex') return json({ runner: 'codex', models: [{ id: 'gpt-future', label: 'gpt-future', description: 'Newest' }], source: 'live', stale: false })
      if (url === '/api/v1/config' && method === 'GET')
        return json({
          baseBranch: null,
          defaultRunner: 'claude',
          systemPrompt: null,
          defaultModels,
          modelsLocked,
          maxParallel: 1,
          memoryLimitMb: null,
        })
      if (url === '/api/v1/workspace/config' && method === 'GET')
        return json(runnerLock === undefined ? {} : { runnerLock })
      if (url === '/api/v1/runs' && method === 'GET') return json([])
      if (url.endsWith('/agent') && method === 'POST') return json({ run: {} })
      return json({}, 200)
    }),
  )
}

const step = (extra: Partial<StepState> = {}): StepState => ({
  id: 'task',
  name: 'Do the task',
  kind: 'agent',
  status: 'done',
  iterations: 1,
  tokensUsed: 0,
  ...extra,
})

const makeRun = (extra: Partial<ApiRun> = {}): ApiRun => ({
  id: 'r1',
  title: 'do the thing',
  workflow: 'quick-task',
  task: 'do the thing',
  status: 'done',
  createdAt: '2026-07-16T00:00:00.000Z',
  tokensUsed: 0,
  archived: false,
  runner: 'claude',
  steps: [step({ sessionId: 'sess-1' })],
  ...extra,
})


const posted = () => requests.filter((r) => r.method === 'POST' && r.url.endsWith('/agent'))
// `data-slot` / `data-action`, the convention every other suite in this directory uses — there
// are no `data-testid`s in this codebase.
const hint = () => document.querySelector('[data-slot="retarget-hint"]')
const runButton = () => document.querySelector('[data-action="retarget-run"]') as HTMLButtonElement | null
/** Wait for the button to be ENABLED, not merely present. It renders disabled while provider
 *  status is still loading, and `fireEvent.click` on a disabled button is a silent no-op — the
 *  test then fails on "no request was made" rather than on anything it meant to assert. */
async function clickRun(): Promise<void> {
  await waitFor(() => {
    const button = runButton()
    expect(button).toBeTruthy()
    expect(button!.disabled).toBe(false)
  })
  fireEvent.click(runButton()!)
}

function renderHint(record: ApiRun) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/']}>
        <RetargetHint run={record} />
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const QUEUED = makeRun({ status: 'queued', steps: [] })
const SCHEDULED = makeRun({ status: 'failed', autoResumeAt: '2026-08-26T23:00:30.000Z' })

describe('RetargetHint — visibility', () => {
  it('renders for a queued task', async () => {
    serve()
    renderHint(QUEUED)
    await waitFor(() => expect(hint()).toBeTruthy())
  })

  it('renders for a SCHEDULED task, and says the limit is why', async () => {
    serve()
    renderHint(SCHEDULED)
    await waitFor(() => expect(hint()).toBeTruthy())
    expect(hint()?.textContent).toContain('usage limit')
  })

  it('renders nothing for a plain finished run — Continue already covers it', () => {
    serve()
    renderHint(makeRun({ status: 'done' }))
    expect(hint()).toBeNull()
  })

  it('renders nothing while the run is going', () => {
    serve()
    renderHint(makeRun({ status: 'running' }))
    expect(hint()).toBeNull()
  })
})

describe('RetargetHint — what it posts', () => {
  it('posts NOTHING extra when no pill was touched', async () => {
    serve()
    renderHint(QUEUED)
    await clickRun()
    await waitFor(() => expect(posted()).toHaveLength(1))
    // An empty body, not `{runner:'claude', model:'…'}`. Sending the run's current engine back to
    // the server would be indistinguishable from a deliberate pin, and would defeat the model
    // ladder on the server side for a user who only meant to press the button.
    expect(posted()[0]?.body).toEqual({})
  })

  it('sends the runner the user picked, and still no model', async () => {
    serve()
    renderHint(QUEUED)
    // Radix: `pointerDown` opens it and the items are `menuitemradio`, not `option` — the same
    // interaction `follow-up-engine.test.tsx` uses against these identical pills.
    fireEvent.pointerDown(await screen.findByRole('button', { name: 'Runner' }))
    const options = await screen.findAllByRole('menuitemradio')
    fireEvent.click(options.find((o) => o.textContent?.includes('codex')) as HTMLElement)
    await clickRun()
    await waitFor(() => expect(posted()).toHaveLength(1))
    expect(posted()[0]?.body).toEqual({ runner: 'codex' })
  })

  it('surfaces the server\'s own words when the move is refused', async () => {
    serve()
    // The race a person actually hits: a slot frees while the hint is open.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        const method = init.method ?? 'GET'
        requests.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined })
        const json = (payload: unknown, status = 200) =>
          new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
        if (url === '/api/v1/health') return json(HEALTH_MULTI)
        if (url === '/api/v1/providers/status') return json(providersForHealth(HEALTH_MULTI))
        if (url === '/api/v1/config') return json({ baseBranch: null, defaultRunner: 'claude', systemPrompt: null, defaultModels: {}, modelsLocked: false, maxParallel: 1, memoryLimitMb: null })
        if (url === '/api/v1/runs' && method === 'GET') return json([])
        if (url.endsWith('/agent') && method === 'POST') {
          return json({ error: 'cannot move a running run to another engine' }, 409)
        }
        return json({}, 200)
      }),
    )
    renderHint(QUEUED)
    await clickRun()
    expect(await screen.findByText(/cannot move a running run/)).toBeTruthy()
  })
})

/**
 * The header / mobile shortcut (`retarget-menu.tsx`), which is the SECOND placement of the same
 * action. What is worth pinning is not that it renders — it is the two ways the two placements
 * could silently disagree:
 *
 *   1. **When** a task is movable. Both read `runActionFlags.retarget`; a copy of the rule in the
 *      header would drift the first time the rule changed.
 *   2. **What** gets sent. The shortcut must send the engine ALONE — a click on "codex" says
 *      nothing about which codex model, and a model sent here would pin one the user never chose,
 *      defeating the server-side ladder that exists for exactly this case.
 */
function renderMenu(record: ApiRun) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/']}>
        <RetargetMenuButton run={record} />
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const menuButton = () => document.querySelector('[data-slot="retarget-menu"]') as HTMLButtonElement | null

async function openMenu(): Promise<void> {
  await waitFor(() => {
    expect(menuButton()).toBeTruthy()
    expect(menuButton()!.disabled).toBe(false)
  })
  fireEvent.pointerDown(menuButton()!)
}

describe('RetargetMenuButton — the header shortcut', () => {
  it('renders for the same states the dock hint does, and for no others', async () => {
    serve()
    renderMenu(QUEUED)
    await waitFor(() => expect(menuButton()).toBeTruthy())
    cleanup()

    serve()
    renderMenu(SCHEDULED)
    await waitFor(() => expect(menuButton()).toBeTruthy())
    cleanup()

    serve()
    renderMenu(makeRun({ status: 'running' }))
    expect(menuButton()).toBeNull()
    cleanup()

    serve()
    renderMenu(makeRun({ status: 'done' }))
    expect(menuButton()).toBeNull()
  })

  it('moves the task on one click and sends the ENGINE ALONE — no model', async () => {
    serve()
    renderMenu(QUEUED)
    await openMenu()
    const items = await screen.findAllByRole('menuitem')
    fireEvent.click(items.find((i) => i.getAttribute('data-runner') === 'codex') as HTMLElement)
    await waitFor(() => expect(posted()).toHaveLength(1))
    expect(posted()[0]?.body).toEqual({ runner: 'codex' })
  })

  it('shows the engine the task is already on, disabled rather than hidden', async () => {
    serve()
    renderMenu(QUEUED) // runner: 'claude'
    await openMenu()
    const items = await screen.findAllByRole('menuitem')
    const current = items.find((i) => i.getAttribute('data-runner') === 'claude')
    expect(current).toBeTruthy()
    expect(current?.getAttribute('data-disabled')).not.toBeNull()
    expect(current?.textContent).toContain('current')
  })

  it("surfaces the server's own refusal, same as the dock hint", async () => {
    serve()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input)
        const method = init.method ?? 'GET'
        requests.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined })
        const json = (payload: unknown, status = 200) =>
          new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
        if (url === '/api/v1/health') return json(HEALTH_MULTI)
        if (url === '/api/v1/providers/status') return json(providersForHealth(HEALTH_MULTI))
        if (url === '/api/v1/config') return json({ baseBranch: null, defaultRunner: 'claude', systemPrompt: null, defaultModels: {}, modelsLocked: false, maxParallel: 1, memoryLimitMb: null })
        if (url === '/api/v1/runs' && method === 'GET') return json([])
        if (url.endsWith('/agent') && method === 'POST') return json({ error: 'cannot retarget a running run' }, 409)
        return json({}, 200)
      }),
    )
    renderMenu(QUEUED)
    await openMenu()
    const items = await screen.findAllByRole('menuitem')
    fireEvent.click(items.find((i) => i.getAttribute('data-runner') === 'codex') as HTMLElement)
    expect(await screen.findByText(/cannot retarget a running run/)).toBeTruthy()
  })
})

/**
 * The global engine lock at "Run on…" (`.ai/specs/2026-08-29-global-provider-toggle.md`, D2
 * rank 4).
 *
 * This menu is the one surface whose entire content is a list of providers, so a lock that did not
 * reach it would leave the clearest possible contradiction on screen: an item reading "Run on
 * claude" that posts `{runner:'claude'}` and produces a codex run. It is a second renderer of the
 * same `useRetargetAction` the pills use, which is why the narrowing lives in the hook.
 */
describe('RetargetMenuButton under a global engine lock', () => {
  it('offers only the locked provider, and says why', async () => {
    serve(HEALTH_MULTI, {}, providersForHealth(HEALTH_MULTI), 200, false, 'codex')
    renderMenu(QUEUED) // runner: 'claude'
    await openMenu()
    const items = await screen.findAllByRole('menuitem')
    expect(items.map((i) => i.getAttribute('data-runner')).filter(Boolean)).toEqual(['codex'])
    expect(
      document.querySelector('[data-slot="retarget-menu-lock-note"]')?.textContent,
    ).toContain('Locked to codex')
  })

  it('offers both on Auto, with no note — the control', async () => {
    serve(HEALTH_MULTI, {}, providersForHealth(HEALTH_MULTI), 200, false, null)
    renderMenu(QUEUED)
    await openMenu()
    const items = await screen.findAllByRole('menuitem')
    expect(items.map((i) => i.getAttribute('data-runner')).filter(Boolean)).toEqual(['claude', 'codex'])
    expect(document.querySelector('[data-slot="retarget-menu-lock-note"]')).toBeNull()
  })

  it('leaves the task nowhere to go when it is already on the locked provider', async () => {
    // Honest rather than tidy: the single row is the disabled "(current)" one, and the note is what
    // separates that from a menu that looks broken. Hiding the button instead would take away the
    // only place this state is explained.
    serve(HEALTH_MULTI, {}, providersForHealth(HEALTH_MULTI), 200, false, 'claude')
    renderMenu(QUEUED) // runner: 'claude'
    await openMenu()
    const items = await screen.findAllByRole('menuitem')
    const rows = items.filter((i) => i.getAttribute('data-runner') !== null)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.getAttribute('data-disabled')).not.toBeNull()
  })
})
