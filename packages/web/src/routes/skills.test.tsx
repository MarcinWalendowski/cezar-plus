import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import type { Skill, WorkflowsResponse } from '@loki-labs/cezar-plus-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { AppRoutes } from '@/routes'

/**
 * `/skills` (R6 Step 1.4): the catalog + detail against fixture payloads, the #377
 * ordering/bold rendering, the #384 refresh contract (selection and scroll survive), and the
 * bookmarklet panel's protected link generation. The pure rules themselves are pinned in
 * lib/skills.test.ts and lib/bookmarklet.test.ts — this file asserts the SURFACE honors them.
 */

// ---- fixtures --------------------------------------------------------------------------------

const skill = (over: Partial<Skill> & Pick<Skill, 'name' | 'source'>): Skill => ({
  body: `# ${over.name}\n\nBody of ${over.name}.`,
  path: `.ai/skills/${over.name}.md`,
  ...over,
})

// Deliberately listed global-first: the SECTION must reorder project-first (#377).
const SKILLS: Skill[] = [
  skill({
    name: 'zebra-global',
    source: 'global',
    path: '/home/u/.agents/skills/zebra-global/SKILL.md',
    description: 'A global skill',
  }),
  skill({ name: 'om-fix', source: 'ai', description: 'Fix an issue end to end' }),
  skill({ name: 'om-review', source: 'cezar', path: '.ai/cezar/skills/om-review.md' }),
]

const WORKFLOWS: WorkflowsResponse = {
  workflows: [
    {
      name: 'fix-and-verify',
      source: 'file',
      steps: [{ id: 'fix', name: 'Fix', skill: 'om-fix' }],
    },
  ],
  issues: [],
}

let requests: Array<{ method: string; url: string; body?: unknown }> = []

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

function serve({
  skills = SKILLS,
  refreshed = SKILLS,
  importable = [],
  importableError = false,
  workspaceUiState = {},
  analytics = () => json({ accepted: 1 }, 202),
}: {
  skills?: Skill[]
  refreshed?: Skill[]
  importable?: { name: string; description?: string }[]
  /** `GET /skills/importable` answers 500 instead of `importable` — for the "an errored list is
   *  not a reachable surface" analytics case. */
  importableError?: boolean
  workspaceUiState?: Record<string, unknown>
  /** Overridable so a test can make the analytics POST reject without touching any other route
   *  (Analytics guard: a rejecting transport must not reach the checkbox state or the toast). */
  analytics?: () => Response
} = {}) {
  requests = []
  // The selection lives in the GLOBAL ui-state (`/api/v1/workspace/ui-state`), whose PUT answers the
  // MERGED state; the Manage panel relies on that echo to reconcile its optimistic write, so the
  // stub must merge and return rather than answer `{}`.
  let global: Record<string, unknown> = { ...workspaceUiState }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      // Bookmarklets is a `per-project` settings section, so `/settings/bookmarklets?project=boot`
      // mounts a scope provider and its reads go out as `/api/v1/p/boot/…`
      // (`.ai/specs/2026-08-21-one-settings-area.md`). Normalized so this file keeps matching one
      // spelling; WHICH scope a section addresses is pinned in `settings/settings.test.tsx`.
      const url = String(input).replace(/^\/api\/v1\/p\/[^/]+/, '/api/v1')
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      requests.push({ method, url, body })
      if (url === '/api/v1/skills' && method === 'GET') return json(skills)
      if (url === '/api/v1/skills/refresh' && method === 'POST') return json(refreshed)
      // Both the fast read and the ?wait=1 convergence read hit this endpoint.
      if (url.startsWith('/api/v1/skills/importable')) {
        return importableError ? json({ error: 'boom' }, 500) : json(importable)
      }
      if (url === '/api/v1/workflows') return json(WORKFLOWS)
      if (url === '/api/v1/launch-key') return json({ key: 'sekret' })
      if (url === '/api/v1/ui-state') return json({}) // per-repo prefs — unused by the panel
      if (url === '/api/v1/workspace/ui-state' && method === 'GET') return json(global)
      if (url === '/api/v1/workspace/ui-state' && method === 'PUT') {
        global = { ...global, ...(body as Record<string, unknown>) }
        return json(global)
      }
      if (url === '/api/v1/workspace/analytics/events' && method === 'POST') return analytics()
      return new Promise<never>(() => {})
    }),
  )
}

/** Analytics POSTs the panel/route sent, decoded — one request may batch several `events`. */
const analyticsEvents = () =>
  requests
    .filter((r) => r.method === 'POST' && r.url === '/api/v1/workspace/analytics/events')
    .flatMap((r) => (r.body as { events: { name: string; props: Record<string, unknown> }[] }).events)

/** Seeds the step-3.2 route gates — boot id (legacy redirect) + registry (known-check) — so a
 *  flat entry URL lands scoped immediately. The boot project mounts UNSCOPED, so the exact
 *  `/api/v1/*` paths this file's fetch stub matches stay byte-identical. */
function gateSeededClient() {
  const client = createQueryClient()
  client.setQueryData(queryKeys.health, { bootProject: 'boot' })
  client.setQueryData(workspaceQueryKeys.projects, {
    projects: [
      { id: 'boot', name: 'cezar', root: '/home/u/cezar', status: 'ok', addedAt: '2026-01-01T00:00:00Z', lastOpenedAt: '2026-01-01T00:00:00Z', source: 'local' },
    ],
    bootProject: 'boot',
    projectsDir: '~/cezar/projects',
  })
  return client
}

function renderAt(entry: string) {
  const client = gateSeededClient()
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <AppRoutes />
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return client
}

const rowNames = () =>
  [...document.querySelectorAll('[data-slot="skill-row"]')].map((el) => el.getAttribute('data-skill'))

const detail = () => document.querySelector('[data-slot="skills-detail"] [data-slot="skill-detail"]')

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

describe('the catalog list', () => {
  it('renders project-first with bold project rows and source tags (#377)', async () => {
    serve()
    renderAt('/skills')

    await waitFor(() => expect(rowNames()).toEqual(['om-fix', 'om-review', 'zebra-global']))
    const rows = [...document.querySelectorAll('[data-slot="skill-row"]')]
    expect(rows[0]?.getAttribute('data-project')).toBe('true')
    expect(rows[1]?.getAttribute('data-project')).toBe('true')
    expect(rows[2]?.hasAttribute('data-project')).toBe(false)
    // The tag says where each skill comes from.
    expect(rows[0]?.querySelector('[data-slot="skill-source"]')?.textContent).toBe('ai')
    expect(rows[2]?.querySelector('[data-slot="skill-source"]')?.textContent).toBe('global')
  })

  it('the first skill is the default selection: detail shows markdown body, path, used-by', async () => {
    serve()
    renderAt('/skills')

    await waitFor(() => expect(detail()).not.toBeNull())
    const pane = detail()!
    expect(pane.querySelector('h2')?.textContent).toBe('om-fix')
    expect(pane.querySelector('[data-slot="skill-path"]')?.textContent).toContain('.ai/skills/om-fix.md')
    // `# om-fix` became a real heading — the body renders as markdown, not a <pre> dump.
    await waitFor(() =>
      expect(pane.querySelector('[data-slot="skill-body"] h1')?.textContent).toBe('om-fix'),
    )
    expect(pane.querySelector('[data-slot="skill-used-by"]')?.textContent).toContain('fix-and-verify › Fix')
  })

  it('clicking a row selects it via the URL and swaps the detail', async () => {
    serve()
    renderAt('/skills')
    await waitFor(() => expect(rowNames()).toHaveLength(3))

    fireEvent.click(document.querySelector('[data-slot="skill-row"][data-skill="om-review"]')!)
    await waitFor(() => expect(detail()?.querySelector('h2')?.textContent).toBe('om-review'))
    expect(
      document
        .querySelector('[data-slot="skill-row"][data-skill="om-review"]')
        ?.getAttribute('aria-current'),
    ).toBe('page')
    // An unreferenced skill says so instead of showing an empty section.
    expect(detail()?.querySelector('[data-slot="skill-used-by"]')?.textContent).toContain(
      'Not referenced by any workflow yet',
    )
  })

  it('the filter narrows the rows but never hides the pinned bookmarklet entry', async () => {
    serve()
    renderAt('/skills')
    await waitFor(() => expect(rowNames()).toHaveLength(3))

    fireEvent.change(document.querySelector('[data-slot="skills-filter"]')!, {
      target: { value: 'review' },
    })
    expect(rowNames()).toEqual(['om-review'])
    expect(document.querySelector('[data-slot="bookmarklets-row"]')).not.toBeNull()
  })

  it('an empty catalog explains where skills come from, and the panel is the fallback surface', async () => {
    serve({ skills: [] })
    renderAt('/skills')

    // #374: the hint must mention every project discovery dir, not just `.ai/skills/`.
    await waitFor(() => {
      const text = document.querySelector('[data-slot="skill-rows"]')?.textContent ?? ''
      expect(text).toContain('.ai/skills/')
      expect(text).toContain('.ai/cezar/skills/')
      expect(text).toContain('.agents/skills/')
    })
    // No skills → the bookmarklet panel is the default detail (legacy fallback rule).
    await waitFor(() => expect(document.querySelector('[data-slot="bookmarklet-panel"]')).not.toBeNull())
  })
})

describe('refresh (#384: selection and scroll survive)', () => {
  it('POSTs /api/v1/skills/refresh, keeps the selected skill, the row container and its scroll', async () => {
    serve({ refreshed: [...SKILLS, skill({ name: 'team-new', source: 'team' })] })
    renderAt('/skills?skill=om-review')
    await waitFor(() => expect(rowNames()).toHaveLength(3))

    const rowsBefore = document.querySelector('[data-slot="skill-rows"]')!
    rowsBefore.scrollTop = 120

    fireEvent.click(document.querySelector('[data-slot="skills-refresh"]')!)
    await waitFor(() =>
      expect(requests.some((r) => r.method === 'POST' && r.url === '/api/v1/skills/refresh')).toBe(true),
    )
    // The refreshed catalog rendered (the new team skill is in the list)…
    await waitFor(() => expect(rowNames()).toEqual(['om-fix', 'om-review', 'team-new', 'zebra-global']))

    // …but the pane was updated IN PLACE: same scroll container, same scroll offset, same
    // selection — the legacy innerHTML rebuild lost all three.
    const rowsAfter = document.querySelector('[data-slot="skill-rows"]')!
    expect(rowsAfter).toBe(rowsBefore)
    expect(rowsAfter.scrollTop).toBe(120)
    expect(
      document
        .querySelector('[data-slot="skill-row"][data-skill="om-review"]')
        ?.getAttribute('aria-current'),
    ).toBe('page')
    expect(detail()?.querySelector('h2')?.textContent).toBe('om-review')
  })

  it('a refresh that drops the selected skill falls back to the first skill, never crashes', async () => {
    serve({ refreshed: SKILLS.filter((s) => s.name !== 'om-review') })
    renderAt('/skills?skill=om-review')
    await waitFor(() => expect(detail()?.querySelector('h2')?.textContent).toBe('om-review'))

    fireEvent.click(document.querySelector('[data-slot="skills-refresh"]')!)
    await waitFor(() => expect(detail()?.querySelector('h2')?.textContent).toBe('om-fix'))
  })
})

describe('the Manage skills panel (opt-out team skills)', () => {
  const IMPORTABLE = [
    { name: 'pr-create', description: 'Open a PR from the current branch' },
    { name: 'code-review', description: 'Review the diff for bugs' },
  ]

  const importRows = () =>
    [...document.querySelectorAll('[data-slot="import-row"]')].map((el) => el.getAttribute('data-skill'))

  // The panel's writes carry `importedSkills`; other providers (appearance, sidebar) write the
  // SAME global ui-state on mount, so select only the writes that touch our key.
  const lastPut = () =>
    requests
      .filter(
        (r) =>
          r.method === 'PUT' &&
          r.url === '/api/v1/workspace/ui-state' &&
          (r.body as { importedSkills?: unknown })?.importedSkills !== undefined,
      )
      .at(-1)?.body as { importedSkills: string[] } | undefined

  it('shows the pinned "Manage skills" entry only when a team repo has importable skills', async () => {
    serve({ importable: IMPORTABLE })
    renderAt('/skills')
    await waitFor(() => expect(document.querySelector('[data-slot="import-skills-row"]')).not.toBeNull())
  })

  it('hides the entry when there are no importable skills', async () => {
    serve({ importable: [] })
    renderAt('/skills')
    await waitFor(() => expect(rowNames()).toHaveLength(3))
    expect(document.querySelector('[data-slot="import-skills-row"]')).toBeNull()
  })

  it('enables every team skill by default (opt-out), and unchecking one curates it away', async () => {
    serve({ importable: IMPORTABLE }) // uiState {} → not curated → all on
    renderAt('/skills?skill=__import')
    await waitFor(() => expect(importRows()).toEqual(['pr-create', 'code-review']))

    const toggleOf = (name: string) =>
      document.querySelector<HTMLInputElement>(
        `[data-slot="import-row"][data-skill="${name}"] [data-slot="import-toggle"]`,
      )!
    // Opt-out default: nothing is curated yet, so both start checked.
    expect(toggleOf('pr-create').checked).toBe(true)
    expect(toggleOf('code-review').checked).toBe(true)

    fireEvent.click(toggleOf('pr-create'))

    // The first uncheck expands "all on" into an explicit remaining set — the other skill only.
    await waitFor(() => expect(lastPut()?.importedSkills).toEqual(['code-review']))
    // …and the row reflects it (server echo reconciled, not reverted).
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="import-row"][data-skill="pr-create"]')?.getAttribute('data-imported'),
      ).toBeNull(),
    )
    expect(
      document.querySelector('[data-slot="import-row"][data-skill="code-review"]')?.getAttribute('data-imported'),
    ).toBe('true')
  })

  it('honors an existing curated selection, and re-checking a skill adds it back', async () => {
    serve({ importable: IMPORTABLE, workspaceUiState: { importedSkills: ['code-review'] } })
    renderAt('/skills?skill=__import')
    // Curated present → only code-review is on; pr-create is off.
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="import-row"][data-skill="code-review"]')?.getAttribute('data-imported'),
      ).toBe('true'),
    )
    expect(
      document.querySelector('[data-slot="import-row"][data-skill="pr-create"]')?.getAttribute('data-imported'),
    ).toBeNull()

    fireEvent.click(
      document.querySelector('[data-slot="import-row"][data-skill="pr-create"] [data-slot="import-toggle"]')!,
    )
    await waitFor(() => expect(lastPut()?.importedSkills.sort()).toEqual(['code-review', 'pr-create']))
  })

  it('"Remove all" clears the team catalog, then "Enable all" restores it', async () => {
    serve({ importable: IMPORTABLE }) // default: all on
    renderAt('/skills?skill=__import')
    await waitFor(() => expect(importRows()).toHaveLength(2))

    const button = () => document.querySelector('[data-slot="import-all"]')!
    // Opt-out default (all on) → the action is Remove all.
    expect(button().textContent).toContain('Remove all')
    fireEvent.click(button())
    await waitFor(() => expect(lastPut()?.importedSkills).toEqual([]))

    // Everything off → the action flips to Enable all → clicking restores the full set.
    await waitFor(() => expect(button().textContent).toContain('Enable all'))
    fireEvent.click(button())
    await waitFor(() => expect(lastPut()?.importedSkills.sort()).toEqual(['code-review', 'pr-create']))
  })

  // The lost-update regression (review "Major"): two toggles fired before the first PUT resolves
  // must both survive. The write chain serializes the PUTs (the second is derived from the first
  // and sent only after it lands), and only the newest response reconciles the cache — so a slow
  // or out-of-order response can neither lose nor resurrect a selection.
  it('serializes overlapping toggles so both persist, even with a slow/reordered response', async () => {
    const puts: { body: { importedSkills: string[] }; release: () => void }[] = []
    // Start already curated-to-empty so both rows begin unchecked and the two clicks ADD skills
    // (the opt-out default would start them checked, which is exercised elsewhere).
    let state: Record<string, unknown> = { importedSkills: [] }
    const json = (payload: unknown) =>
      new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        if (url === '/api/v1/skills' && method === 'GET') return json(SKILLS)
        if (url.startsWith('/api/v1/skills/importable')) return json(IMPORTABLE)
        if (url === '/api/v1/workflows') return json(WORKFLOWS)
        if (url === '/api/v1/launch-key') return json({ key: 'sekret' })
        if (url === '/api/v1/ui-state') return json({}) // per-repo prefs — unused by the panel
        if (url === '/api/v1/workspace/ui-state' && method === 'GET') return json(state)
        if (url === '/api/v1/workspace/ui-state' && method === 'PUT') {
          const body = JSON.parse(String(init!.body)) as { importedSkills: string[] }
          // Defer the response so the test controls when (and in what order) it lands.
          return new Promise<Response>((resolve) => {
            puts.push({
              body,
              release: () => {
                state = { ...state, ...body }
                resolve(json(state))
              },
            })
          })
        }
        return new Promise<never>(() => {})
      }),
    )

    renderAt('/skills?skill=__import')
    await waitFor(() => expect(importRows()).toEqual(['pr-create', 'code-review']))

    // Two quick toggles before the first PUT resolves.
    fireEvent.click(
      document.querySelector('[data-slot="import-row"][data-skill="pr-create"] [data-slot="import-toggle"]')!,
    )
    fireEvent.click(
      document.querySelector('[data-slot="import-row"][data-skill="code-review"] [data-slot="import-toggle"]')!,
    )

    // Optimistic UI: both flip immediately because the second toggle read the first from the cache.
    await waitFor(() => {
      expect(
        document.querySelector('[data-slot="import-row"][data-skill="pr-create"]')?.getAttribute('data-imported'),
      ).toBe('true')
      expect(
        document.querySelector('[data-slot="import-row"][data-skill="code-review"]')?.getAttribute('data-imported'),
      ).toBe('true')
    })

    // Serialized: only the FIRST PUT is in flight; the second waits for it.
    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0]?.body.importedSkills).toEqual(['pr-create'])

    // Release the first → the chained second PUT fires, built on the first.
    await act(async () => {
      puts[0]!.release()
    })
    await waitFor(() => expect(puts).toHaveLength(2))
    expect(puts[1]?.body.importedSkills).toEqual(['pr-create', 'code-review'])

    await act(async () => {
      puts[1]!.release()
    })

    // Both selections persisted on the server, and neither toggle was lost.
    await waitFor(() => expect(state).toEqual({ importedSkills: ['pr-create', 'code-review'] }))
    expect(
      document.querySelector('[data-slot="import-row"][data-skill="pr-create"]')?.getAttribute('data-imported'),
    ).toBe('true')
    expect(
      document.querySelector('[data-slot="import-row"][data-skill="code-review"]')?.getAttribute('data-imported'),
    ).toBe('true')
  })

  describe('analytics (skills.manage_opened / skills.curation_changed)', () => {
    it('skills.manage_opened fires once, with the importable count, once the panel loads a non-empty list', async () => {
      serve({ importable: IMPORTABLE })
      renderAt('/skills?skill=__import')
      await waitFor(() => expect(importRows()).toHaveLength(2))
      await waitFor(() =>
        expect(analyticsEvents().filter((e) => e.name === 'skills.manage_opened')).toEqual([
          { name: 'skills.manage_opened', props: { importableCount: 2 } },
        ]),
      )
    })

    it('skills.manage_opened does not fire when the importable list is empty', async () => {
      serve({ importable: [] })
      renderAt('/skills?skill=__import')
      await waitFor(() =>
        expect(document.querySelector('[data-slot="skills-import-panel"]')?.textContent).toContain(
          'no team skills',
        ),
      )
      expect(analyticsEvents().some((e) => e.name === 'skills.manage_opened')).toBe(false)
    })

    it('skills.manage_opened does not fire when the importable request errors', async () => {
      serve({ importableError: true })
      renderAt('/skills?skill=__import')
      // The error branch (`importable.isError`) returns a bare CenteredState, not wrapped in the
      // panel's own `data-slot` — same shape as the catalog's own `skillsQuery.isError` early
      // return. `useImportableSkills` has no `retry: false` (query-client.ts's default retries a
      // 5xx once), so this needs a longer timeout than the default 1000ms.
      await waitFor(
        () => expect(document.body.textContent).toContain('Could not load importable skills'),
        { timeout: 5000 },
      )
      expect(analyticsEvents().some((e) => e.name === 'skills.manage_opened')).toBe(false)
    })

    it('skills.curation_changed fires only after the PUT resolves, with the action and the offered counts', async () => {
      serve({ importable: IMPORTABLE }) // opt-out default: both start enabled
      renderAt('/skills?skill=__import')
      await waitFor(() => expect(importRows()).toEqual(['pr-create', 'code-review']))

      fireEvent.click(
        document.querySelector('[data-slot="import-row"][data-skill="pr-create"] [data-slot="import-toggle"]')!,
      )
      await waitFor(() => expect(lastPut()?.importedSkills).toEqual(['code-review']))
      await waitFor(() =>
        expect(analyticsEvents().filter((e) => e.name === 'skills.curation_changed')).toEqual([
          { name: 'skills.curation_changed', props: { action: 'disable', selected: 1, total: 2 } },
        ]),
      )

      fireEvent.click(
        document.querySelector('[data-slot="import-row"][data-skill="pr-create"] [data-slot="import-toggle"]')!,
      )
      await waitFor(() => expect(lastPut()?.importedSkills.sort()).toEqual(['code-review', 'pr-create']))
      await waitFor(() =>
        expect(analyticsEvents().filter((e) => e.name === 'skills.curation_changed')).toHaveLength(2),
      )
      expect(analyticsEvents().filter((e) => e.name === 'skills.curation_changed')[1]).toEqual({
        name: 'skills.curation_changed',
        props: { action: 'enable', selected: 2, total: 2 },
      })
    })

    it('skills.curation_changed fires for "Remove all" / "Enable all" with the _all actions', async () => {
      serve({ importable: IMPORTABLE })
      renderAt('/skills?skill=__import')
      await waitFor(() => expect(importRows()).toHaveLength(2))

      fireEvent.click(document.querySelector('[data-slot="import-all"]')!)
      await waitFor(() => expect(lastPut()?.importedSkills).toEqual([]))
      await waitFor(() =>
        expect(analyticsEvents().filter((e) => e.name === 'skills.curation_changed')).toEqual([
          { name: 'skills.curation_changed', props: { action: 'disable_all', selected: 0, total: 2 } },
        ]),
      )

      fireEvent.click(document.querySelector('[data-slot="import-all"]')!)
      await waitFor(() => expect(lastPut()?.importedSkills.sort()).toEqual(['code-review', 'pr-create']))
      await waitFor(() =>
        expect(analyticsEvents().filter((e) => e.name === 'skills.curation_changed')).toHaveLength(2),
      )
      expect(analyticsEvents().filter((e) => e.name === 'skills.curation_changed')[1]).toEqual({
        name: 'skills.curation_changed',
        props: { action: 'enable_all', selected: 2, total: 2 },
      })
    })

    it('skills.curation_changed does not fire when the PUT rejects', async () => {
      serve({ importable: IMPORTABLE, analytics: () => json({ accepted: 1 }, 202) })
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input).replace(/^\/api\/v1\/p\/[^/]+/, '/api/v1')
          const method = init?.method ?? 'GET'
          const body = init?.body ? JSON.parse(String(init.body)) : undefined
          requests.push({ method, url, body })
          if (url === '/api/v1/skills' && method === 'GET') return json(SKILLS)
          if (url.startsWith('/api/v1/skills/importable')) return json(IMPORTABLE)
          if (url === '/api/v1/workflows') return json(WORKFLOWS)
          if (url === '/api/v1/launch-key') return json({ key: 'sekret' })
          if (url === '/api/v1/ui-state') return json({})
          if (url === '/api/v1/workspace/ui-state' && method === 'GET') return json({})
          if (url === '/api/v1/workspace/ui-state' && method === 'PUT') return json({ error: 'boom' }, 500)
          if (url === '/api/v1/workspace/analytics/events' && method === 'POST') return json({ accepted: 1 }, 202)
          return new Promise<never>(() => {})
        }),
      )
      renderAt('/skills?skill=__import')
      await waitFor(() => expect(importRows()).toHaveLength(2))

      fireEvent.click(
        document.querySelector('[data-slot="import-row"][data-skill="pr-create"] [data-slot="import-toggle"]')!,
      )
      // The rejected PUT surfaces the failure as a danger toast (persist()'s catch path) — waiting
      // for it is how the test knows the write chain has settled before checking for the event.
      await waitFor(() => expect(document.querySelector('[data-tone="danger"]')).not.toBeNull())
      expect(analyticsEvents().some((e) => e.name === 'skills.curation_changed')).toBe(false)
    })

    it('an analytics failure cannot reach the UI — the checkbox state and toast surface stay untouched', async () => {
      serve({
        importable: IMPORTABLE,
        analytics: () => {
          throw new Error('analytics endpoint unreachable')
        },
      })
      renderAt('/skills?skill=__import')
      await waitFor(() => expect(importRows()).toHaveLength(2))

      fireEvent.click(
        document.querySelector('[data-slot="import-row"][data-skill="pr-create"] [data-slot="import-toggle"]')!,
      )
      // The write still lands and the checkbox still reflects it — trackEvent's own rejection
      // (api/analytics.ts:17 swallows it) never reaches the toggle handler's try/catch.
      await waitFor(() => expect(lastPut()?.importedSkills).toEqual(['code-review']))
      await waitFor(() =>
        expect(
          document.querySelector('[data-slot="import-row"][data-skill="pr-create"]')?.getAttribute('data-imported'),
        ).toBeNull(),
      )
      expect(document.querySelectorAll('[data-tone="danger"]')).toHaveLength(0)
    })

    it('no repo or skill name is ever an analytics prop', async () => {
      serve({ importable: IMPORTABLE })
      renderAt('/skills?skill=__import')
      await waitFor(() => expect(importRows()).toHaveLength(2))

      fireEvent.click(
        document.querySelector('[data-slot="import-row"][data-skill="pr-create"] [data-slot="import-toggle"]')!,
      )
      await waitFor(() => expect(lastPut()?.importedSkills).toEqual(['code-review']))

      const events = analyticsEvents()
      expect(events.length).toBeGreaterThan(0)
      for (const event of events) {
        const serialized = JSON.stringify(event.props)
        expect(serialized).not.toContain('pr-create')
        expect(serialized).not.toContain('code-review')
        expect(Object.keys(event.props)).not.toContain('repo')
        expect(Object.keys(event.props)).not.toContain('skill')
      }
    })
  })
})

describe('the bookmarklet panel (spec 011)', () => {
  it('says it is loading rather than claiming there are no skills while the catalog is in flight', async () => {
    // The panel's empty state reads "(no skills yet …)". Rendering it against an unresolved
    // catalog would state that as fact on every cold load of the subpage — so the section
    // must gate on the pending query the way its sibling sections do.
    const json = (payload: unknown) =>
      new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === '/api/v1/launch-key') return json({ key: 'sekret' })
        if (url === '/api/v1/ui-state') return json({})
        return new Promise<never>(() => {}) // /api/v1/skills never settles
      }),
    )
    renderAt('/settings/bookmarklets?project=boot')

    await waitFor(() =>
      expect(document.querySelector('[data-slot="bookmarklets-loading"]')).not.toBeNull(),
    )
    expect(document.querySelector('[data-slot="bookmarklet-panel"]')).toBeNull()
    expect(document.body.textContent).not.toContain('no skills yet')
  })

  it('is a first-class Settings page that generates protected links and auto-arms per-skill links only', async () => {
    serve()
    renderAt('/settings/bookmarklets?project=boot')

    await waitFor(() => expect(document.querySelector('[data-slot="bookmarklet-panel"]')).not.toBeNull())
    // The key landed in the links (the panel is its one legitimate DOM use).
    await waitFor(() => {
      const generic = document.querySelector('[data-slot="bm-generic"] [data-slot="bm-link"]')
      expect(decodeURIComponent(generic?.getAttribute('href') ?? '')).toContain('auto=0&key=sekret&ref=')
    })
    const links = [...document.querySelectorAll('[data-slot="bm-list"] [data-slot="bm-link"]')]
    expect(links).toHaveLength(3) // one per skill, project-first like the catalog
    expect(links[0]?.textContent).toContain('/om-fix')
    for (const link of links) {
      expect(link.getAttribute('href')?.startsWith('javascript:')).toBe(true)
      expect(decodeURIComponent(link.getAttribute('href') ?? '')).toContain('auto=0&key=sekret')
    }

    // Auto-submit arms the per-skill links; the generic launcher stays prefill-only.
    fireEvent.click(document.querySelector('[data-slot="bm-auto"]')!)
    await waitFor(() => {
      const first = document.querySelector('[data-slot="bm-list"] [data-slot="bm-link"]')
      expect(decodeURIComponent(first?.getAttribute('href') ?? '')).toContain('auto=1&key=sekret')
    })
    const generic = document.querySelector('[data-slot="bm-generic"] [data-slot="bm-link"]')
    expect(decodeURIComponent(generic?.getAttribute('href') ?? '')).toContain('auto=0&key=sekret')
  })

  it('filters the per-skill rows and copies a link to the clipboard', async () => {
    serve()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    renderAt('/skills?skill=__bm')
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="bm-list"] [data-slot="bm-row"]')).toHaveLength(3),
    )

    fireEvent.change(document.querySelector('[data-slot="bm-filter"]')!, { target: { value: 'zebra' } })
    const rows = [...document.querySelectorAll('[data-slot="bm-list"] [data-slot="bm-row"]')]
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toContain('/zebra-global')

    fireEvent.click(rows[0]!.querySelector('[data-slot="bm-copy"]')!)
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    expect(String(writeText.mock.calls[0]?.[0])).toMatch(/^javascript:/)
  })

  it('a clicked drag-source link never navigates — it only explains the gesture', async () => {
    serve()
    renderAt('/skills?skill=__bm')
    await waitFor(() => expect(document.querySelector('[data-slot="bm-generic"] [data-slot="bm-link"]')).not.toBeNull())

    fireEvent.click(document.querySelector('[data-slot="bm-generic"] [data-slot="bm-link"]')!)
    await waitFor(() =>
      expect(document.querySelector('[data-slot="toaster"]')?.textContent).toContain(
        'Drag me to your bookmarks bar',
      ),
    )
  })
})
