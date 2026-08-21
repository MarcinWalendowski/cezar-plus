import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { createQueryClient } from '@/api/query-client'
import { AppRoutes } from '@/routes'

/**
 * Project settings shows WHERE the project is (project-location.tsx): the registry's absolute
 * root, in the index card and in the desktop nav footer. Pinned through the real routes so the
 * two renderings are asserted where a user meets them — including the one that must NOT appear,
 * global settings, which describes no project at all.
 */

const ROOT = '/Users/me/code/demo-project'

let requests: Array<{ method: string; url: string; body?: unknown }> = []

/** Only the two routes this pane talks to answer — the open-target list and the launch itself.
 *  Everything else the routes fetch stays honestly pending. */
function serve(targets: Array<{ id: string; label: string; icon?: string }> = OPEN_TARGETS) {
  requests = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      // `/settings/<id>?project=<id>` mounts a scope provider, so project-scoped requests go out
      // as `/api/v1/p/<id>/…` (`.ai/specs/2026-08-21-one-settings-area.md`). Normalized here so
      // this file keeps asserting the SECTION's behaviour against one spelling; WHICH scope a
      // section addresses is pinned in `settings.test.tsx`, where it is the subject.
      const url = String(input).replace(/^\/api\/v1\/p\/[^/]+/, '/api/v1')
      const method = init?.method ?? 'GET'
      const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined
      requests.push({ method, url, body })
      const json = (payload: unknown) =>
        new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
      if (url === '/api/v1/open-targets') return json({ targets })
      if (url === '/api/v1/open-in') return json({ opened: true, path: ROOT })
      return new Promise<never>(() => {})
    }),
  )
}

const OPEN_TARGETS = [
  { id: 'finder', label: 'Finder', icon: 'folder' },
  { id: 'vscode', label: 'VS Code', icon: 'vscode' },
  // The agent CLIs the machine has: offered for a task worktree, never for the checkout.
  { id: 'cli:claude', label: 'Claude CLI', icon: 'claude' },
]

function seededClient() {
  const client = createQueryClient()
  client.setQueryData(queryKeys.health, {
    bootProject: 'boot',
    capabilities: { localHandoff: true, followups: true, singleProject: false, automations: false },
  })
  client.setQueryData(workspaceQueryKeys.projects, {
    projects: [
      {
        id: 'boot',
        name: 'demo-project',
        root: ROOT,
        addedAt: '2026-07-20T10:00:00.000Z',
        lastOpenedAt: '2026-07-20T10:00:00.000Z',
        source: 'local',
        status: 'ok',
      },
    ],
    bootProject: 'boot',
    projectsDir: '~/cezar/projects',
  })
  return client
}

function renderAt(entry: string) {
  render(
    <QueryClientProvider client={seededClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <AppRoutes />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => serve())

/** Radix opens on pointerdown. Returns the menu's target ids, in order. */
async function openWithMenu(): Promise<string[]> {
  const trigger = await waitFor(() => {
    const el = document.querySelector('[data-slot="project-location-open"]')
    expect(el).not.toBeNull()
    return el!
  })
  fireEvent.pointerDown(trigger)
  return waitFor(() => {
    const items = [...document.querySelectorAll('[data-target]')]
    expect(items.length).toBeGreaterThan(0)
    return items.map((el) => el.getAttribute('data-target')!)
  })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the project folder in settings', () => {
  it('the Project section names the absolute root, in full', async () => {
    // Was the project settings INDEX ("General"); it is a real registry section now, at
    // `/settings/project?project=<id>` (`.ai/specs/2026-08-21-one-settings-area.md`).
    renderAt('/settings/project?project=boot')
    const field = await waitFor(() => {
      const el = document.querySelector('[data-slot="project-location"][data-variant="field"]')
      expect(el).not.toBeNull()
      return el!
    })
    // The whole path, not an ellipsised head — this row exists to be read and pasted.
    expect(field.querySelector('[data-slot="project-location-path"]')?.textContent).toBe(ROOT)
  })

  it('every project section keeps the root in the nav footer', async () => {
    renderAt('/settings/worktrees?project=boot')
    const nav = await waitFor(() => {
      const el = document.querySelector('[data-slot="settings-nav"] [data-slot="project-location"]')
      expect(el).not.toBeNull()
      return el!
    })
    expect(nav.querySelector('[data-action="project-location-copy"]')?.textContent).toBe(ROOT)
  })

  it('copies the path to the clipboard', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    renderAt('/settings/project?project=boot')
    const copy = await screen.findByTitle('Copy the project folder path')

    fireEvent.click(copy)

    expect(writeText).toHaveBeenCalledWith(ROOT)
  })

  it('"Open with" lists the machine\'s apps, minus the agent CLIs', async () => {
    renderAt('/settings/project?project=boot')
    // `cli:claude` is detected and offered for a task worktree, but opening the CHECKOUT in an
    // agent CLI is exactly what worktrees exist to avoid — the server 400s it too.
    expect(await openWithMenu()).toEqual(['finder', 'vscode'])
  })

  it('a pick opens the project folder through the server — the path never travels', async () => {
    renderAt('/settings/project?project=boot')
    await openWithMenu()

    fireEvent.click(document.querySelector('[data-target="vscode"]')!)

    await waitFor(() => {
      expect(requests.find((r) => r.method === 'POST' && r.url === '/api/v1/open-in')).toBeDefined()
    })
    // The target and nothing else: the server resolves the folder from the scope it already has.
    expect(requests.find((r) => r.url === '/api/v1/open-in')?.body).toEqual({ target: 'vscode' })
  })

  it('hosted mode has no apps to offer, so no menu is rendered', async () => {
    serve([])
    renderAt('/settings/project?project=boot')
    await waitFor(() => {
      expect(document.querySelector('[data-slot="project-location"]')).not.toBeNull()
    })
    await waitFor(() => {
      expect(requests.some((r) => r.url === '/api/v1/open-targets')).toBe(true)
    })
    expect(document.querySelector('[data-slot="project-location-open"]')).toBeNull()
  })

  it('no selected project means no project folder — there is none to describe', async () => {
    // With *All projects* the nav footer names the MACHINE's file instead
    // (`.ai/specs/2026-08-21-one-settings-area.md`). It used to be the whole global settings AREA
    // that had no folder to show; now it is the absence of a `?project=`, which is the same fact
    // said as a field rather than as a place.
    renderAt('/settings/resources')
    const nav = await waitFor(() => {
      const el = document.querySelector('[data-slot="settings-nav"]')
      expect(el).not.toBeNull()
      return el!
    })
    expect(document.querySelector('[data-slot="project-location"]')).toBeNull()
    expect(nav.textContent).toContain('Stored in ~/.cezar')
  })
})
