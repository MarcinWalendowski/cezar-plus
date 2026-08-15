import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type {
  FsBrowseResponse,
  GitPreflightResponse,
  ProjectListEntry,
  ProjectScanResponse,
} from '@open-mercato/cezar-api-client'
import { AddProjectDialog } from '@/components/add-project-dialog'

/**
 * The add-project folder browser (multi-project spec, step 4.2).
 *
 * Driven through a stubbed `fetch` rather than a mocked client: the request the dialog actually
 * puts on the wire (`?path=`, the POST body) is half of what this step is, and a mocked client
 * would assert the dialog's intent instead of its behavior.
 */

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function project(over: Partial<ProjectListEntry> = {}): ProjectListEntry {
  return {
    id: 'cezar',
    name: 'cezar',
    root: '/home/me/Projects/cezar',
    addedAt: '2026-07-01T00:00:00.000Z',
    lastOpenedAt: '2026-07-20T12:00:00.000Z',
    source: 'local',
    status: 'ok',
    ...over,
  }
}

/** The two listings every test browses: the root (`~`, no parent) and one level down. */
const HOME: FsBrowseResponse = {
  path: '/home/me',
  parent: null,
  dirs: [{ name: 'Projects', path: '/home/me/Projects', isRepo: false }],
  truncated: false,
}

const PROJECTS: FsBrowseResponse = {
  path: '/home/me/Projects',
  parent: '/home/me',
  dirs: [
    { name: 'cezar', path: '/home/me/Projects/cezar', isRepo: true },
    { name: 'notes', path: '/home/me/Projects/notes', isRepo: false },
  ],
  truncated: false,
}

type Answers = {
  /** Keyed by the `path` query value; `''` is the browse root. */
  browse?: Record<string, Response | (() => Response)>
  projects?: ProjectListEntry[]
  /** What `POST /api/v1/projects` answers. Receives the posted root. */
  register?: (root: string) => Response
  /** What `GET /api/v1/projects/scan?path=` answers, keyed by the scanned path (spec
   *  `.ai/specs/2026-08-14-nested-repos-as-projects.md`). A path with no entry answers 404, which
   *  is exactly what a folder holding no repos must look like to this dialog: no section at all. */
  scan?: Record<string, ProjectScanResponse>
}

const posted: { root: string }[] = []
/** Paths `POST /api/v1/projects/git-init` was called with — the assertion that a preview WROTE
 *  nothing is this list staying empty. */
const inited: string[] = []
/** Per-path preflight answers, mutable mid-test so a refusal can be introduced after the rows have
 *  rendered. */
const preflights: Record<string, GitPreflightResponse> = {}
let initAnswer: ((path: string) => Response) | null = null

function preflightOf(over: Partial<GitPreflightResponse> = {}): GitPreflightResponse {
  return {
    path: '/home/me/workspace/brand',
    alreadyRepo: false,
    hasCommits: false,
    insideRepo: false,
    trackedElsewhere: false,
    files: 12,
    bytes: 4096,
    sensitive: ['.env'],
    oversized: [],
    truncated: false,
    ...over,
  }
}

const setupButton = (repo: string) =>
  document.querySelector(`[data-slot="nested-row"][data-repo="${repo}"] [data-slot="setup-git"]`) as HTMLButtonElement

const scanCalls = () =>
  fetchMock.mock.calls.filter(([input]) => String(input).startsWith('/api/v1/projects/scan')).length

function serve({ browse = { '': json(HOME) }, projects = [], register, scan = {} }: Answers = {}): void {
  posted.length = 0
  inited.length = 0
  initAnswer = null
  for (const key of Object.keys(preflights)) delete preflights[key]
  fetchMock.mockImplementation(async (input, init) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/v1/projects/scan') {
      const answer = scan[url.searchParams.get('path') ?? '']
      return answer === undefined ? json({ error: 'no such directory' }, 404) : json(answer)
    }
    if (url.pathname === '/api/v1/projects/git-preflight') {
      const path = url.searchParams.get('path') ?? ''
      return json(preflights[path] ?? preflightOf({ path }))
    }
    if (url.pathname === '/api/v1/projects/git-init' && init?.method === 'POST') {
      const path = (JSON.parse(String(init.body)) as { path: string }).path
      if (initAnswer) return initAnswer(path)
      inited.push(path)
      return json({ path, branch: 'main', commit: 'a'.repeat(40), files: 12, ignored: ['.env'] })
    }
    if (url.pathname === '/api/v1/projects' && init?.method === 'POST') {
      const root = (JSON.parse(String(init.body)) as { root: string }).root
      posted.push({ root })
      return register ? register(root) : json({ project: project({ id: 'added', root }) })
    }
    if (url.pathname === '/api/v1/projects') return json({ projects, bootProject: 'cezar', projectsDir: '~/cezar/projects' })
    if (url.pathname === '/api/v1/fs/browse') {
      const answer = browse[url.searchParams.get('path') ?? '']
      if (answer === undefined) return json({ error: 'unexpected browse path' }, 500)
      return typeof answer === 'function' ? answer() : answer.clone()
    }
    return json({ error: `unexpected ${String(init?.method ?? 'GET')} ${url.pathname}` }, 404)
  })
}

/** Makes the post-registration navigation assertable. */
function LocationProbe() {
  return <span data-testid="location">{useLocation().pathname}</span>
}

function renderDialog() {
  const onOpenChange = vi.fn()
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/p/cezar/']}>
        <AddProjectDialog open onOpenChange={onOpenChange} />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { onOpenChange }
}

const rows = () => within(document.querySelector('[data-slot="fs-listing"]') as HTMLElement)
const breadcrumb = () => document.querySelector('[data-slot="fs-breadcrumb"]') as HTMLElement
const addButton = () => document.querySelector('[data-slot="add-project-confirm"]') as HTMLButtonElement
const target = () => document.querySelector('[data-slot="add-project-target"]') as HTMLElement
const nestedRows = () => [...document.querySelectorAll('[data-slot="nested-row"]')] as HTMLElement[]
const nestedToggle = (repo: string) =>
  document.querySelector(`[data-slot="nested-row"][data-repo="${repo}"] input`) as HTMLInputElement

describe('AddProjectDialog', () => {
  it('lists the browse root, badges git repos, and renders no "up" row when parent is null', async () => {
    serve({ browse: { '': json(HOME) } })
    renderDialog()
    await waitFor(() => expect(breadcrumb().textContent).toBe('/home/me'))
    expect(rows().getByText('Projects')).toBeTruthy()
    // parent === null AT the root: an "up" row there would only ever 400.
    expect(document.querySelector('[data-slot="fs-up"]')).toBeNull()
    // Nothing selected yet — the target is the folder being looked at.
    expect(target().textContent).toBe('/home/me')
  })

  it('navigates into a folder and back up, asking the server for each path', async () => {
    // Going back up asks for the parent by its ABSOLUTE path, not for the root sentinel — so
    // `/home/me` must be answerable both ways (`''` on first load, spelled out on the way back).
    serve({
      browse: { '': json(HOME), '/home/me': json(HOME), '/home/me/Projects': json(PROJECTS) },
    })
    renderDialog()
    await waitFor(() => expect(rows().getByText('Projects')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Open Projects' }))
    await waitFor(() => expect(breadcrumb().textContent).toBe('/home/me/Projects'))
    // The git repo is badged; the plain folder is not — and both are listed.
    expect(within(rows().getByText('cezar').closest('button') as HTMLElement).getByText('git')).toBeTruthy()
    expect(rows().getByText('notes')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Up one level/ }))
    await waitFor(() => expect(breadcrumb().textContent).toBe('/home/me'))
  })

  it('registers a selected NON-GIT folder and navigates to its scope', async () => {
    serve({
      browse: { '': json(PROJECTS) },
      register: (root) => json({ project: project({ id: 'notes', name: 'notes', root, status: 'not-git' }) }),
    })
    renderDialog()
    await waitFor(() => expect(rows().getByText('notes')).toBeTruthy())
    // A folder without `.git` is selectable and registerable — the spec's explicit requirement.
    fireEvent.click(rows().getByText('notes'))
    expect(target().textContent).toBe('/home/me/Projects/notes')
    fireEvent.click(addButton())
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/p/notes/'))
    expect(posted).toEqual([{ root: '/home/me/Projects/notes' }])
  })

  it('registers the folder currently being browsed when nothing is selected', async () => {
    serve({ browse: { '': json(PROJECTS) } })
    renderDialog()
    await waitFor(() => expect(target().textContent).toBe('/home/me/Projects'))
    fireEvent.click(addButton())
    await waitFor(() => expect(posted).toEqual([{ root: '/home/me/Projects' }]))
  })

  it('marks an already-registered folder and navigates to it when the server answers 409', async () => {
    serve({
      browse: { '': json(PROJECTS) },
      projects: [project({ id: 'cezar', root: '/home/me/Projects/cezar' })],
      // The registry dedupes by realpath and answers the EXISTING entry — not a dead end.
      register: (root) =>
        json({ project: project({ id: 'cezar', root }), error: 'already registered as cezar' }, 409),
    })
    renderDialog()
    await waitFor(() => expect(rows().getByText('cezar')).toBeTruthy())
    expect(within(rows().getByText('cezar').closest('button') as HTMLElement).getByText('already added')).toBeTruthy()
    fireEvent.click(rows().getByText('cezar'))
    fireEvent.click(addButton())
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/p/cezar/'))
    expect(document.querySelector('[data-slot="add-project-error"]')).toBeNull()
  })

  it('shows a register refusal verbatim and stays put', async () => {
    serve({
      browse: { '': json(HOME) },
      register: () => json({ error: 'not a project folder: ~ is your home directory or a cezar task worktree' }, 400),
    })
    const { onOpenChange } = renderDialog()
    await waitFor(() => expect(addButton().disabled).toBe(false))
    fireEvent.click(addButton())
    await waitFor(() =>
      expect(document.querySelector('[data-slot="add-project-error"]')?.textContent).toBe(
        'not a project folder: ~ is your home directory or a cezar task worktree',
      ),
    )
    expect(screen.getByTestId('location').textContent).toBe('/p/cezar/')
    expect(onOpenChange).not.toHaveBeenCalled()
    // Server messages quote unbreakable paths — they must wrap, not widen the grid column.
    expect(document.querySelector('[data-slot="add-project-error"]')?.className).toContain('break-words')
  })

  it('shows a browse failure instead of an empty listing', async () => {
    serve({ browse: { '': json({ error: 'path is outside the browsable root' }, 400) } })
    renderDialog()
    await waitFor(() =>
      expect(document.querySelector('[data-slot="fs-error"]')?.textContent).toBe(
        'path is outside the browsable root',
      ),
    )
    expect(document.querySelector('[data-slot="fs-listing"]')).toBeNull()
    // Same wrap-don't-widen contract as the register error.
    expect(document.querySelector('[data-slot="fs-error"]')?.className).toContain('break-words')
  })

  it('surfaces the truncated flag rather than showing a silently short list', async () => {
    serve({ browse: { '': json({ ...PROJECTS, truncated: true }) } })
    renderDialog()
    await waitFor(() => expect(document.querySelector('[data-slot="fs-truncated"]')).toBeTruthy())
  })

  it('keeps a long target path from widening the dialog (grid-blowout regression)', async () => {
    const DEEP: FsBrowseResponse = {
      path: '/home/me/projects/workspace/whisper/whisper-admin-with-a-very-long-name',
      parent: '/home/me',
      dirs: [{ name: 'docs', path: '/home/me/projects/workspace/whisper/whisper-admin-with-a-very-long-name/docs', isRepo: false }],
      truncated: false,
    }
    serve({ browse: { '': json(DEEP) } })
    renderDialog()
    await waitFor(() => expect(target().textContent).toBe(DEEP.path))
    // jsdom does no layout, so the guard is the class contract. DialogContent is a CSS grid,
    // and a grid item with visible overflow cannot shrink below its min-content: without
    // min-w-0 on the footer, the unbreakable mono path forces the grid column wider than the
    // card, and every row — the folder list included — renders past the dialog's right edge.
    const footer = document.querySelector('[data-slot="dialog-footer"]') as HTMLElement
    expect(footer.className).toContain('min-w-0')
    // …and the path itself must be the thing that gives way, by truncating.
    expect(target().className).toContain('truncate')
  })

  it('refetches the project registry after a successful add so the sidebar picks it up', async () => {
    serve({ browse: { '': json(PROJECTS) } })
    renderDialog()
    await waitFor(() => expect(addButton().disabled).toBe(false))
    const listCalls = () =>
      fetchMock.mock.calls.filter(
        ([input, init]) => String(input) === '/api/v1/projects' && init?.method !== 'POST',
      ).length
    const before = listCalls()
    fireEvent.click(addButton())
    await waitFor(() => expect(listCalls()).toBeGreaterThan(before))
  })
  /**
   * Nested repos (spec `.ai/specs/2026-08-14-nested-repos-as-projects.md`) — a folder full of
   * repositories offers one project per repo instead of registering as one.
   */
  describe('nested repos', () => {
    const WORKSPACE: FsBrowseResponse = {
      path: '/home/me/workspace',
      parent: null,
      dirs: [{ name: 'chat', path: '/home/me/workspace/chat', isRepo: true }],
      truncated: false,
    }

    const scanOf = (over: Partial<ProjectScanResponse> = {}): ProjectScanResponse => ({
      root: '/home/me/workspace',
      rootIsRepo: true,
      truncated: false,
      repos: [
        { path: '/home/me/workspace/chat', relPath: 'chat', name: 'chat', branch: 'main', forge: 'github', isRepo: true, hasCommits: true, registered: false },
        { path: '/home/me/workspace/cezar', relPath: 'cezar', name: 'cezar', isRepo: true, hasCommits: true, registered: false },
      ],
      ...over,
    })

    const renderScanned = async (scan: ProjectScanResponse): Promise<{ onOpenChange: ReturnType<typeof vi.fn> }> => {
      serve({ browse: { '': json(WORKSPACE) }, scan: { '/home/me/workspace': scan } })
      const rendered = renderDialog()
      await waitFor(() => expect(nestedRows().length).toBe(scan.repos.length + 1))
      return rendered
    }

    it('lists the folder plus each nested repo, and says how many will be added', async () => {
      await renderScanned(scanOf())
      expect(nestedRows().map((row) => row.getAttribute('data-repo'))).toEqual(['.', 'chat', 'cezar'])
      // Every row starts checked: the proposal is "add them all", and the button counts it.
      expect(nestedRows().every((row) => (row.querySelector('input') as HTMLInputElement).checked)).toBe(true)
      expect(addButton().textContent).toBe('Add 3 projects')
    })

    it('registers exactly the checked rows, one POST each, and navigates to the first', async () => {
      const { onOpenChange } = await renderScanned(scanOf())
      fireEvent.click(nestedToggle('cezar'))
      expect(addButton().textContent).toBe('Add 2 projects')

      fireEvent.click(addButton())

      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
      expect(posted.map((call) => call.root)).toEqual(['/home/me/workspace', '/home/me/workspace/chat'])
      expect(screen.getByTestId('location').textContent).toBe('/p/added/')
    })

    /** The folder itself is a row like any other: a container directory nobody wants as a project
     *  must be skippable without giving up its repos. */
    it('can skip the scanned folder and register only its repos', async () => {
      await renderScanned(scanOf())
      fireEvent.click(nestedToggle('.'))
      expect(addButton().textContent).toBe('Add 2 projects')

      fireEvent.click(addButton())

      await waitFor(() => expect(posted).toHaveLength(2))
      expect(posted.map((call) => call.root)).toEqual([
        '/home/me/workspace/chat',
        '/home/me/workspace/cezar',
      ])
    })

    it('never posts an already-registered repo, and does not let one be unchecked', async () => {
      await renderScanned(
        scanOf({
          repos: [
            { path: '/home/me/workspace/chat', relPath: 'chat', name: 'chat', isRepo: true, hasCommits: true, registered: true },
            { path: '/home/me/workspace/cezar', relPath: 'cezar', name: 'cezar', isRepo: true, hasCommits: true, registered: false },
          ],
        }),
      )
      const already = nestedToggle('chat')
      expect(already.checked).toBe(true)
      expect(already.disabled).toBe(true)
      expect(addButton().textContent).toBe('Add 2 projects')

      fireEvent.click(addButton())

      await waitFor(() => expect(posted).toHaveLength(2))
      expect(posted.map((call) => call.root)).not.toContain('/home/me/workspace/chat')
    })

    /** The cap has to be visible. A silently short list reads as "there is nothing else in there",
     *  which is the one wrong answer this feature must not give. */
    it('renders the truncation rather than only carrying the flag', async () => {
      await renderScanned(scanOf({ truncated: true }))
      expect(document.querySelector('[data-slot="nested-truncated"]')).not.toBeNull()

      cleanup()
      await renderScanned(scanOf())
      expect(document.querySelector('[data-slot="nested-truncated"]')).toBeNull()
    })

    /** A repo with nothing inside it, and a scan that fails outright, must both look the same to
     *  the user as the dialog did before this feature existed — no section, one POST. */
    it('shows no section at all for a git folder that holds no other projects', async () => {
      serve({ browse: { '': json(HOME) }, scan: { '/home/me': { root: '/home/me', rootIsRepo: true, repos: [], truncated: false } } })
      renderDialog()
      await waitFor(() => expect(addButton().disabled).toBe(false))
      expect(document.querySelector('[data-slot="nested-repos"]')).toBeNull()
      expect(addButton().textContent).toBe('Add project')

      fireEvent.click(addButton())
      await waitFor(() => expect(posted).toEqual([{ root: '/home/me' }]))
    })
  })

  /**
   * Non-git folders as projects, and the button that fixes them
   * (`.ai/specs/2026-08-15-import-all-folders-as-projects.md`, phases 2 and 4).
   */
  describe('folders without git', () => {
    const WORKSPACE: FsBrowseResponse = {
      path: '/home/me/workspace',
      parent: null,
      dirs: [{ name: 'chat', path: '/home/me/workspace/chat', isRepo: true }],
      truncated: false,
    }

    const MIXED: ProjectScanResponse = {
      root: '/home/me/workspace',
      rootIsRepo: false,
      truncated: false,
      repos: [
        { path: '/home/me/workspace/chat', relPath: 'chat', name: 'chat', branch: 'main', isRepo: true, hasCommits: true, registered: false },
        { path: '/home/me/workspace/brand', relPath: 'brand', name: 'brand', isRepo: false, registered: false },
        { path: '/home/me/workspace/fresh', relPath: 'fresh', name: 'fresh', isRepo: true, hasCommits: false, registered: false },
      ],
    }

    const renderMixed = async (over: Partial<ProjectScanResponse> = {}): Promise<void> => {
      serve({ browse: { '': json(WORKSPACE) }, scan: { '/home/me/workspace': { ...MIXED, ...over } } })
      renderDialog()
      await waitFor(() => expect(nestedRows().length).toBe((over.repos ?? MIXED.repos).length + 1))
    }

    /** THE guard on the copy. Mutation: replace the warning with a generic "no git" and this fails
     *  — the three things a non-git project actually costs are the reason the row is warned about
     *  at all, and `workflows/run.ts` says exactly this when such a project runs. */
    it('warns that a non-git row runs in place, one task at a time', async () => {
      await renderMixed()
      const warning = document.querySelector('[data-slot="nested-no-git-warning"]') as HTMLElement
      expect(warning.textContent).toContain('in place, one task at a time')
      expect(warning.textContent).toContain('parallel')
      expect(warning.textContent).toContain('worktree')
    })

    it('offers folders and repos alike, all checked, and counts every one on the button', async () => {
      await renderMixed()
      expect(nestedRows().map((row) => row.getAttribute('data-repo'))).toEqual(['.', 'chat', 'brand', 'fresh'])
      expect(nestedRows().every((row) => (row.querySelector('input') as HTMLInputElement).checked)).toBe(true)
      // The folder itself + 3 rows: a folder row is a project proposal exactly like a repo row.
      expect(addButton().textContent).toBe('Add 4 projects')

      fireEvent.click(addButton())
      await waitFor(() => expect(posted).toHaveLength(4))
      expect(posted.map((call) => call.root)).toContain('/home/me/workspace/brand')
    })

    /** A commitless repo is badged differently from a folder with no `.git` — same cost, different
     *  cause, and "no git" on a directory the user knows is a repo teaches them nothing. */
    it('badges a plain folder and a commitless repo differently, and offers both the button', async () => {
      await renderMixed()
      const badge = (repo: string) =>
        document.querySelector(`[data-slot="nested-row"][data-repo="${repo}"] [data-slot="no-git-badge"]`)
      expect(badge('brand')?.textContent).toBe('no git')
      expect(badge('fresh')?.textContent).toBe('no commits')
      expect(badge('chat')).toBeNull()
      expect(
        document.querySelector('[data-slot="nested-row"][data-repo="chat"] [data-slot="setup-git"]'),
      ).toBeNull()
      for (const repo of ['brand', 'fresh']) {
        expect(
          document.querySelector(`[data-slot="nested-row"][data-repo="${repo}"] [data-slot="setup-git"]`),
        ).not.toBeNull()
      }
    })

    it('previews what would be committed and what would be excluded before writing anything', async () => {
      await renderMixed()
      fireEvent.click(setupButton('brand'))

      await waitFor(() => expect(document.querySelector('[data-slot="setup-summary"]')).not.toBeNull())
      expect(document.querySelector('[data-slot="setup-summary"]')?.textContent).toContain('12 files')
      expect(document.querySelector('[data-slot="setup-excluded"]')?.textContent).toContain('.env')
      // Preflight is a READ: nothing has been written at the point the preview renders.
      expect(inited).toEqual([])

      fireEvent.click(document.querySelector('[data-slot="setup-confirm"]') as HTMLButtonElement)
      await waitFor(() => expect(inited).toEqual(['/home/me/workspace/brand']))
    })

    /** Mutation: auto-ignore the oversized file instead of refusing, and this fails. The refusal is
     *  a decision the user has to make, so the button must not be clickable past it. */
    it('refuses an oversized file instead of offering to commit it', async () => {
      await renderMixed()
      preflights['/home/me/workspace/brand'] = {
        ...preflightOf(),
        oversized: ['assets/render.mov (240.0 MB)'],
      }
      fireEvent.click(setupButton('brand'))

      await waitFor(() => expect(document.querySelector('[data-slot="setup-refusal"]')).not.toBeNull())
      expect(document.querySelector('[data-slot="setup-refusal"]')?.textContent).toContain('render.mov')
      expect((document.querySelector('[data-slot="setup-confirm"]') as HTMLButtonElement).disabled).toBe(true)
    })

    it('shows the server refusal verbatim when the write itself fails', async () => {
      await renderMixed()
      initAnswer = () => json({ error: 'this folder is inside an existing git repository' }, 400)
      fireEvent.click(setupButton('brand'))
      await waitFor(() =>
        expect((document.querySelector('[data-slot="setup-confirm"]') as HTMLButtonElement).disabled).toBe(false),
      )
      fireEvent.click(document.querySelector('[data-slot="setup-confirm"]') as HTMLButtonElement)

      await waitFor(() =>
        expect(document.querySelector('[data-slot="setup-error"]')?.textContent).toBe(
          'this folder is inside an existing git repository',
        ),
      )
    })

    /** The row the user just fixed has to stop saying it has no git — the dialog renders straight
     *  off the scan, so the scan is what must be re-asked. */
    it('re-scans after a successful setup so the fixed row loses its warning', async () => {
      await renderMixed()
      fireEvent.click(setupButton('brand'))
      await waitFor(() =>
        expect((document.querySelector('[data-slot="setup-confirm"]') as HTMLButtonElement).disabled).toBe(false),
      )

      const scansBefore = scanCalls()
      fireEvent.click(document.querySelector('[data-slot="setup-confirm"]') as HTMLButtonElement)

      await waitFor(() => expect(scanCalls()).toBeGreaterThan(scansBefore))
    })

    /** The scanned folder itself gets the same treatment: browsing INTO a non-git folder is how a
     *  user reaches one that has nothing inside it, and that is the row they need the button on. */
    it('offers the setup button on the scanned folder when it is the one without git', async () => {
      serve({
        browse: { '': json(HOME) },
        scan: { '/home/me': { root: '/home/me', rootIsRepo: false, repos: [], truncated: false } },
      })
      renderDialog()
      await waitFor(() => expect(document.querySelector('[data-slot="nested-repos"]')).not.toBeNull())
      expect(document.querySelector('[data-slot="nested-row"][data-repo="."] [data-slot="setup-git"]')).not.toBeNull()
      expect(document.querySelector('[data-slot="nested-no-git-warning"]')).not.toBeNull()
    })
  })
})
