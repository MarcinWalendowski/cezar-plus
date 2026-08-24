import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { RunNodeCell, TaskNodeCell, useRunNodeRoster, type RunNodeRoster } from '@/components/task-node-cell'
import type { TaskNodeInfo } from '@/lib/task-node'

/**
 * The rendered half of "which worker is processing this?" — see `lib/task-node.test.ts` for the
 * resolution rules this cell paints. What is worth a DOM test here: the honesty rule that an
 * absent claim never reads as "local", and that self/known/unknown each carry their own marker so
 * a board can style or test by them (the same idiom `AuthorCell`'s own suite pins).
 */

afterEach(cleanup)

function renderCell(info: TaskNodeInfo | undefined) {
  render(<TaskNodeCell info={info} />)
  return document.querySelector('[data-slot="task-node"]') as HTMLElement
}

describe('TaskNodeCell', () => {
  it('renders an absent claim as a dash, never as "local" or a machine name', () => {
    const el = renderCell(undefined)
    expect(el.dataset.nodeKind).toBe('none')
    expect(el.textContent).toBe('—')
    // Negative half: none of the other kind markers leak onto the empty state.
    expect(el.dataset.nodeSource).toBeUndefined()
    expect(el.dataset.nodeId).toBeUndefined()
  })

  it('renders "this node" for a self claim, with the source and id on the element', () => {
    const el = renderCell({ source: 'started', kind: 'self', nodeId: 'hub-1' })
    expect(el.dataset.nodeKind).toBe('self')
    expect(el.dataset.nodeSource).toBe('started')
    expect(el.dataset.nodeId).toBe('hub-1')
    expect(el.textContent).toBe('this node')
  })

  it('renders a known node by name — negative half: NOT the raw id', () => {
    const el = renderCell({ source: 'started', kind: 'known', nodeId: 'spoke-2', name: 'Laptop' })
    expect(el.dataset.nodeKind).toBe('known')
    expect(el.textContent).toBe('Laptop')
    expect(el.textContent).not.toContain('spoke-2')
  })

  it('renders an unresolvable node with its id, never blank', () => {
    const el = renderCell({ source: 'started', kind: 'unknown', nodeId: 'ghost-9' })
    expect(el.dataset.nodeKind).toBe('unknown')
    expect(el.textContent).not.toBe('')
    expect(el.textContent).toContain('ghost-9')
  })

  it('a placement-only claim still marks its source as "placement" on the element', () => {
    const el = renderCell({ source: 'placement', kind: 'known', nodeId: 'spoke-2', name: 'Laptop' })
    expect(el.dataset.nodeSource).toBe('placement')
  })
})

// ---- runs: "which worker ran/is running this?" ---------------------------------------------------

function fakeRoster(overrides: Partial<RunNodeRoster> = {}): RunNodeRoster {
  return {
    clusterOn: true,
    resolve: () => undefined,
    freshness: () => undefined,
    ...overrides,
  }
}

describe('RunNodeCell', () => {
  it('renders the plain node cell when there is nothing stale to report', () => {
    const roster = fakeRoster({
      resolve: () => ({ source: 'started', kind: 'self', nodeId: 'hub-1' }),
      freshness: () => undefined,
    })
    render(<RunNodeCell roster={roster} runId="r_1" />)
    const cell = document.querySelector('[data-slot="task-node"]') as HTMLElement
    expect(cell.textContent).toBe('this node')
    expect(document.querySelector('[data-slot="run-node-stale"]')).toBeNull()
  })

  it('appends the staleness suffix for a run resolved to a stale known node — negative half above', () => {
    const roster = fakeRoster({
      resolve: () => ({ source: 'started', kind: 'known', nodeId: 'spoke-2', name: 'Laptop' }),
      freshness: () => ({ ageText: '15m' }),
    })
    render(<RunNodeCell roster={roster} runId="r_1" />)
    const cell = document.querySelector('[data-slot="task-node"]') as HTMLElement
    expect(cell.textContent).toBe('Laptop')
    const stale = document.querySelector('[data-slot="run-node-stale"]') as HTMLElement
    expect(stale.textContent).toBe('· 15m')
  })

  it('resolves by the runId it is given, passing it straight to the roster', () => {
    const seen: string[] = []
    const roster = fakeRoster({
      resolve: (runId) => {
        seen.push(runId)
        return undefined
      },
    })
    render(<RunNodeCell roster={roster} runId="r_42" />)
    expect(seen).toEqual(['r_42'])
  })
})

// ---- useRunNodeRoster: the hook wiring behind RunNodeCell -----------------------------------------

describe('useRunNodeRoster', () => {
  const CLUSTER_NODE = (overrides: { nodeId: string; nodeName: string; lastSeenAt?: string }) => ({
    role: 'spoke' as const,
    labels: [] as string[],
    acceptsDispatch: true,
    protocol: { major: 1, minor: 0 },
    version: '0.10.0',
    ...overrides,
  })
  const HUB = CLUSTER_NODE({ nodeId: 'hub-1', nodeName: 'Hub' })
  const SPOKE = CLUSTER_NODE({ nodeId: 'spoke-2', nodeName: 'Laptop' })

  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  /** `clusterOn = true` throughout — the off case (no fetch reaches `/cluster*` at all) is
   *  `lib/task-node.ts`'s `resolve`/`freshness` callers' own concern (every render call site
   *  gates on `.clusterOn` before calling either), not this hook's wiring. */
  function stubFetch(activeRuns: unknown[], selfNodeId = 'hub-1') {
    return vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/v1/health') {
        return jsonResponse({
          version: '0.0.0-test',
          repoRoot: '/repo',
          repo: { root: '/repo', branch: 'main' },
          forge: null,
          capabilities: { localHandoff: true, followups: true, cluster: true },
          defaultRunner: 'claude',
          checks: [],
        })
      }
      if (path === '/api/v1/cluster') {
        return jsonResponse({
          self: CLUSTER_NODE({ nodeId: selfNodeId, nodeName: 'Hub' }),
          nodes: [HUB, SPOKE],
          pairings: [],
          proposals: [],
          link: { state: 'disabled' },
        })
      }
      if (path === '/api/v1/cluster/active') {
        return jsonResponse({ runs: activeRuns })
      }
      throw new Error(`unstubbed fetch: ${path}`)
    })
  }

  function wrapper() {
    const client = createQueryClient()
    return function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>
    }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('joins a run against /cluster/active and attributes it to the OTHER node reporting it', async () => {
    vi.stubGlobal('fetch', stubFetch([{ runId: 'r_1', nodeId: 'spoke-2', summary: 's', paths: [] }]))
    const { result } = renderHook(() => useRunNodeRoster(Date.now()), { wrapper: wrapper() })

    await waitFor(() => expect(result.current.clusterOn).toBe(true))
    await waitFor(() => expect(result.current.resolve('r_1')?.kind).toBe('known'))
    expect(result.current.resolve('r_1')).toEqual({
      source: 'started',
      kind: 'known',
      nodeId: 'spoke-2',
      name: 'Laptop',
    })
  })

  it('negative half: a run NOT reported in /cluster/active resolves to self, not "unknown" or blank', async () => {
    vi.stubGlobal('fetch', stubFetch([]))
    const { result } = renderHook(() => useRunNodeRoster(Date.now()), { wrapper: wrapper() })

    await waitFor(() => expect(result.current.clusterOn).toBe(true))
    await waitFor(() => expect(result.current.resolve('r_1')?.kind).toBe('self'))
    expect(result.current.resolve('r_1')).toEqual({ source: 'started', kind: 'self', nodeId: 'hub-1' })
  })

  it('self vs other is keyed on the roster\'s OWN self id, not a hardcoded node — same runId, different self', async () => {
    vi.stubGlobal('fetch', stubFetch([{ runId: 'r_1', nodeId: 'spoke-2', summary: 's', paths: [] }], 'spoke-2'))
    const { result } = renderHook(() => useRunNodeRoster(Date.now()), { wrapper: wrapper() })

    await waitFor(() => expect(result.current.clusterOn).toBe(true))
    await waitFor(() => expect(result.current.resolve('r_1')?.kind).toBe('self'))
  })

  it('freshness reads the RESOLVED node\'s own lastSeenAt, not a hardcoded fresh answer', async () => {
    const now = Date.now()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input)
        if (path === '/api/v1/health') {
          return jsonResponse({
            version: '0.0.0-test',
            repoRoot: '/repo',
            repo: { root: '/repo', branch: 'main' },
            forge: null,
            capabilities: { localHandoff: true, followups: true, cluster: true },
            defaultRunner: 'claude',
            checks: [],
          })
        }
        if (path === '/api/v1/cluster') {
          return jsonResponse({
            self: CLUSTER_NODE({ nodeId: 'hub-1', nodeName: 'Hub' }),
            nodes: [HUB, { ...SPOKE, lastSeenAt: new Date(now - 15 * 60_000).toISOString() }],
            pairings: [],
            proposals: [],
            link: { state: 'disabled' },
          })
        }
        if (path === '/api/v1/cluster/active') {
          return jsonResponse({ runs: [{ runId: 'r_1', nodeId: 'spoke-2', summary: 's', paths: [] }] })
        }
        throw new Error(`unstubbed fetch: ${path}`)
      }),
    )
    const { result } = renderHook(() => useRunNodeRoster(now), { wrapper: wrapper() })

    await waitFor(() => expect(result.current.resolve('r_1')?.kind).toBe('known'))
    const info = result.current.resolve('r_1')
    expect(result.current.freshness(info)).toEqual({ ageText: '15m' })
  })
})
