import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type {
  ClusterCapacityEnforcement,
  ClusterEnrollResponse,
  ClusterNode,
  ClusterOverviewResponse,
  ClusterProtocol,
} from '@loki-labs/cezar-plus-api-client'
import { clusterQueuedReasonSchema } from '@loki-labs/cezar-plus-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { ClusterSection } from './cluster-section'

/**
 * Settings → Cluster (packages 1b.2 + 1b.3, `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`
 * "Phases → Phase 1b" + "Verification" 12a-12d). What this pins:
 *
 *  - the off state when `capabilities.cluster` is false, and that it never fetches the roster
 *    (`GET /api/v1/cluster` answers 409 while the flag is unset — `health.ts`'s own docblock —
 *    so racing it ahead of the capability read is not merely wasteful, it errors);
 *  - the empty roster state;
 *  - **12b** — a node last seen 40 minutes ago renders its age; a fresh reading renders none;
 *  - **12c** — `enforcement: 'none'` renders a stated limitation, distinct from `cgroup`/
 *    `process-tree`, which render neutrally with no such warning;
 *  - **12a** — Add node's rendered command matches the hub-rendered `npx … cluster join …` shape
 *    and never leaks an Access credential, even when one sits in the environment;
 *  - the node actions (accepts-dispatch toggle, revoke) round-trip through the roster refetch.
 */

let requests: Array<{ method: string; url: string; body?: unknown }> = []

const PROTOCOL: ClusterProtocol = { major: 1, minor: 0 }

function node(
  overrides: Partial<ClusterNode> & Pick<ClusterNode, 'nodeId' | 'nodeName' | 'role'>,
): ClusterNode {
  return {
    labels: [],
    acceptsDispatch: false,
    protocol: PROTOCOL,
    version: '0.10.0',
    ...overrides,
  }
}

function overview(over: Partial<ClusterOverviewResponse> = {}): ClusterOverviewResponse {
  return {
    nodes: [],
    pairings: [],
    proposals: [],
    link: { state: 'disabled' },
    ...over,
  }
}

function enrollResponse(over: Partial<ClusterEnrollResponse> = {}): ClusterEnrollResponse {
  return {
    codeId: 'code-1',
    code: 'cezj_opaque',
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    commands: {
      join: 'npx -y @loki-labs/cezar-plus@0.10.0 cluster join cezj_opaque',
      provision: 'npx -y @loki-labs/cezar-plus@0.10.0 server-install --platform hetzner --role worker',
    },
    ...over,
  }
}

function serve(
  opts: {
    clusterOn?: boolean
    overviewResponse?: ClusterOverviewResponse
    enroll?: ClusterEnrollResponse
    enrollStatus?: number
    revokeCode?: { revoked: boolean }
    revokeNode?: { revoked: boolean }
    patchStatus?: number
  } = {},
) {
  requests = []
  const clusterOn = opts.clusterOn ?? true
  const roster = opts.overviewResponse ?? overview()
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      let body: unknown
      if (typeof init?.body === 'string') {
        try {
          body = JSON.parse(init.body)
        } catch {
          body = init.body
        }
      }
      requests.push({ method, url, body })

      if (url === '/api/v1/health' && method === 'GET') {
        return json({ capabilities: { cluster: clusterOn } })
      }
      if (url === '/api/v1/cluster' && method === 'GET') {
        return json(roster)
      }
      if (url === '/api/v1/cluster/enroll' && method === 'POST') {
        if (opts.enrollStatus !== undefined) {
          return json({ error: 'admin required' }, opts.enrollStatus)
        }
        return json(opts.enroll ?? enrollResponse())
      }
      if (url.startsWith('/api/v1/cluster/enroll/') && method === 'DELETE') {
        return json(opts.revokeCode ?? { revoked: true })
      }
      if (url.match(/\/api\/v1\/cluster\/nodes\/[^/]+$/) && method === 'PATCH') {
        if (opts.patchStatus !== undefined) return json({ error: 'refused' }, opts.patchStatus)
        return json({ ok: true })
      }
      if (url.match(/\/api\/v1\/cluster\/nodes\/[^/]+$/) && method === 'DELETE') {
        return json(opts.revokeNode ?? { revoked: true })
      }
      return new Promise<never>(() => {})
    }),
  )
}

function renderSection() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <ClusterSection />
      <Toaster />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

const openAddNodeDialog = async () => {
  fireEvent.click(document.querySelector('[data-action="cluster-add-node"]')!)
  await waitFor(() => expect(document.querySelector('[data-slot="add-node-dialog"]')).not.toBeNull())
}

describe('the cluster section', () => {
  it('is off: capabilities.cluster=false renders the off state and never fetches the roster', async () => {
    serve({ clusterOn: false })
    renderSection()
    await waitFor(() => expect(screen.getByText('Clustering is off')).toBeTruthy())
    expect(requests.some((r) => r.url === '/api/v1/cluster')).toBe(false)
  })

  it('empty: no nodes renders the actionable empty state', async () => {
    serve({ overviewResponse: overview({ nodes: [] }) })
    renderSection()
    await waitFor(() => expect(screen.getByText('No nodes yet')).toBeTruthy())
  })

  it('renders a node row with its capacity, labels and repo drift', async () => {
    serve({
      overviewResponse: overview({
        nodes: [
          node({
            nodeId: 'n-worker',
            nodeName: 'worker-2',
            role: 'spoke',
            labels: ['linux', 'cgroup'],
            capacity: {
              maxParallel: 8,
              active: 3,
              maxHeavySteps: 2,
              heavyActive: 1,
              enforcement: 'cgroup',
            },
            capacityAt: new Date().toISOString(),
            repoDrift: [
              { projectKey: 'proj-1', headSha: 'abcdef1234', ahead: 2, behind: 0, dirty: 3, merging: false },
            ],
          }),
        ],
      }),
    })
    renderSection()

    await waitFor(() => expect(document.querySelector('[data-node-id="n-worker"]')).not.toBeNull())
    const row = document.querySelector('[data-node-id="n-worker"]')!

    expect(row.querySelector('[data-slot="cluster-node-capacity-parallel"]')?.textContent).toBe(
      '3/8 running',
    )
    expect(row.querySelector('[data-slot="cluster-node-capacity-heavy"]')?.textContent).toBe(
      '1/2 heavy',
    )
    expect(row.querySelector('[data-slot="cluster-node-labels"]')?.textContent).toContain('linux')
    expect(row.querySelector('[data-slot="cluster-node-repo-drift-row"]')?.textContent).toContain('dirty')
  })

  it('a node with no capacity reported yet renders that fact, never zeroes', async () => {
    serve({
      overviewResponse: overview({
        nodes: [node({ nodeId: 'n-fresh', nodeName: 'fresh-node', role: 'spoke' })],
      }),
    })
    renderSection()
    await waitFor(() =>
      expect(document.querySelector('[data-slot="cluster-node-capacity-unreported"]')).not.toBeNull(),
    )
    expect(document.querySelector('[data-slot="cluster-node-capacity-parallel"]')).toBeNull()
  })

  it('12b: a node last seen 40 minutes ago shows its age; a fresh reading shows no age badge', async () => {
    const now = Date.now()
    serve({
      overviewResponse: overview({
        nodes: [
          node({
            nodeId: 'n-stale',
            nodeName: 'stale-node',
            role: 'spoke',
            lastSeenAt: new Date(now - 40 * 60_000).toISOString(),
          }),
          node({
            nodeId: 'n-fresh',
            nodeName: 'fresh-node',
            role: 'spoke',
            lastSeenAt: new Date(now - 5_000).toISOString(),
          }),
        ],
      }),
    })
    renderSection()

    await waitFor(() => expect(document.querySelector('[data-node-id="n-stale"]')).not.toBeNull())

    const stale = document.querySelector('[data-node-id="n-stale"]')!
    const staleAge = stale.querySelector('[data-slot="cluster-node-presence-age"]')
    expect(staleAge).not.toBeNull()
    expect(staleAge?.textContent).toContain('40m ago')
    expect(stale.querySelector('[data-slot="cluster-node-presence"]')?.getAttribute('data-presence')).toBe(
      'asleep',
    )

    // Negative control: the fresh node must render NO age badge at all — otherwise this test
    // would pass even if the badge were always present regardless of staleness.
    const fresh = document.querySelector('[data-node-id="n-fresh"]')!
    expect(fresh.querySelector('[data-slot="cluster-node-presence-age"]')).toBeNull()
    expect(fresh.querySelector('[data-slot="cluster-node-presence"]')?.getAttribute('data-presence')).toBe(
      'online',
    )
  })

  it('12c: enforcement "none" renders a stated limitation; cgroup/process-tree do not', async () => {
    const withEnforcement = (id: string, enforcement: ClusterCapacityEnforcement) =>
      node({
        nodeId: id,
        nodeName: id,
        role: 'spoke',
        capacity: { maxParallel: 4, active: 0, heavyActive: 0, enforcement },
      })
    serve({
      overviewResponse: overview({
        nodes: [
          withEnforcement('n-cgroup', 'cgroup'),
          withEnforcement('n-process-tree', 'process-tree'),
          withEnforcement('n-none', 'none'),
        ],
      }),
    })
    renderSection()
    await waitFor(() => expect(document.querySelector('[data-node-id="n-none"]')).not.toBeNull())

    const cgroupRow = document.querySelector('[data-node-id="n-cgroup"]')!
    const processTreeRow = document.querySelector('[data-node-id="n-process-tree"]')!
    const noneRow = document.querySelector('[data-node-id="n-none"]')!

    expect(
      cgroupRow.querySelector('[data-slot="cluster-node-enforcement"]')?.getAttribute('data-enforcement'),
    ).toBe('cgroup')
    expect(cgroupRow.querySelector('[data-slot="cluster-node-enforcement-warning"]')).toBeNull()

    expect(
      processTreeRow
        .querySelector('[data-slot="cluster-node-enforcement"]')
        ?.getAttribute('data-enforcement'),
    ).toBe('process-tree')
    expect(processTreeRow.querySelector('[data-slot="cluster-node-enforcement-warning"]')).toBeNull()

    // The case that matters: `none` gets its own stated-limitation element. A test that only
    // checked the badge text would pass against code that renders nothing extra for `none`.
    expect(
      noneRow.querySelector('[data-slot="cluster-node-enforcement"]')?.getAttribute('data-enforcement'),
    ).toBe('none')
    const warning = noneRow.querySelector('[data-slot="cluster-node-enforcement-warning"]')
    expect(warning).not.toBeNull()
    expect(warning?.textContent).toContain('No resource ceiling is enforced')
  })

  it('12a: the minted command carries the code and no long-lived credential', async () => {
    vi.stubEnv('CF_ACCESS_CLIENT_ID', 'decoy-access-client-id')
    vi.stubEnv('CF_ACCESS_CLIENT_SECRET', 'decoy-access-client-secret')
    serve({
      enroll: enrollResponse({
        commands: {
          join: 'npx -y @loki-labs/cezar-plus@0.10.0 cluster join cezj_realcode',
          provision: 'npx -y @loki-labs/cezar-plus@0.10.0 server-install --platform hetzner --role worker',
        },
      }),
    })
    renderSection()
    await waitFor(() => expect(screen.getByText('No nodes yet')).toBeTruthy())

    await openAddNodeDialog()

    await waitFor(() =>
      expect(document.querySelector('[data-slot="cluster-join-command"]')?.textContent).toContain(
        'npx -y @loki-labs/cezar-plus@0.10.0 cluster join cezj_',
      ),
    )

    const dialogText = document.querySelector('[data-slot="add-node-dialog"]')?.textContent ?? ''
    // The second assertion is the one that matters (see module docblock): a test that only
    // checks the happy shape passes just as well against a command that leaks.
    expect(dialogText).not.toContain('decoy-access-client-id')
    expect(dialogText).not.toContain('decoy-access-client-secret')

    expect(requests.some((r) => r.url === '/api/v1/cluster/enroll' && r.method === 'POST')).toBe(true)
  })

  it('Add node: copies the command, counts the TTL down, and revokes before use', async () => {
    const clipboardWrite = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText: clipboardWrite } })

    serve({ enroll: enrollResponse({ expiresAt: new Date(Date.now() + 600_000).toISOString() }) })
    renderSection()
    await waitFor(() => expect(screen.getByText('No nodes yet')).toBeTruthy())
    await openAddNodeDialog()

    await waitFor(() => expect(document.querySelector('[data-slot="cluster-join-command"]')).not.toBeNull())
    await waitFor(() => expect(document.querySelector('[data-slot="cluster-code-ttl"]')).not.toBeNull())

    fireEvent.click(
      document.querySelector('[data-slot="add-node-dialog"] button[title="Copy"]')!,
    )
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledWith(expect.stringContaining('cluster join')))

    fireEvent.click(document.querySelector('[data-action="cluster-code-revoke"]')!)
    await waitFor(() =>
      expect(document.querySelector('[data-slot="cluster-code-status"]')?.textContent).toContain('Revoked.'),
    )
    expect(document.querySelector('[data-action="cluster-code-revoke"]')).toBeNull()
  })

  it('node actions: toggling accepts-dispatch and revoking a node re-fetch the roster', async () => {
    serve({
      overviewResponse: overview({
        nodes: [node({ nodeId: 'n-1', nodeName: 'worker-1', role: 'spoke', acceptsDispatch: false })],
      }),
    })
    renderSection()
    await waitFor(() => expect(document.querySelector('[data-node-id="n-1"]')).not.toBeNull())

    fireEvent.click(document.querySelector('[data-slot="cluster-node-accepts-dispatch"]')!)
    await waitFor(() =>
      expect(
        requests.some((r) => r.method === 'PATCH' && r.url === '/api/v1/cluster/nodes/n-1'),
      ).toBe(true),
    )

    fireEvent.click(document.querySelector('[data-action="cluster-node-revoke"]')!)
    await waitFor(() => expect(document.querySelector('[data-action="cluster-node-revoke-confirm"]')).not.toBeNull())
    fireEvent.click(document.querySelector('[data-action="cluster-node-revoke-confirm"]')!)

    await waitFor(() =>
      expect(
        requests.some((r) => r.method === 'DELETE' && r.url === '/api/v1/cluster/nodes/n-1'),
      ).toBe(true),
    )
  })

  it('the self node cannot toggle dispatch or be revoked from its own cockpit', async () => {
    serve({
      overviewResponse: overview({
        self: {
          nodeId: 'n-self',
          nodeName: 'hub',
          role: 'hub',
          labels: [],
          acceptsDispatch: true,
          protocol: PROTOCOL,
          version: '0.10.0',
        },
        nodes: [node({ nodeId: 'n-self', nodeName: 'hub', role: 'hub', acceptsDispatch: true })],
      }),
    })
    renderSection()
    await waitFor(() => expect(document.querySelector('[data-node-id="n-self"]')).not.toBeNull())

    const row = document.querySelector('[data-node-id="n-self"]')!
    expect(row.querySelector('[data-slot="cluster-node-presence"]')?.getAttribute('data-presence')).toBe(
      'self',
    )
    expect(row.querySelector('[data-slot="cluster-node-accepts-dispatch"]')?.getAttribute('disabled')).not.toBe(
      null,
    )
    expect(row.querySelector('[data-action="cluster-node-revoke"]')).toBeNull()
  })

  it('12d: every queued reason renders, as pairwise-distinct strings', async () => {
    serve()
    renderSection()
    await waitFor(() => expect(screen.getByText('No nodes yet')).toBeTruthy())

    fireEvent.click(document.querySelector('[data-slot="cluster-queued-reasons"] [data-slot="collapsible-trigger"]')!)

    const reasonEls = await waitFor(() => {
      const els = document.querySelectorAll('[data-slot="cluster-queued-reason"]')
      // Derived from the schema, NOT a literal. This was `4` and went stale the moment
      // `no-node-accepts-dispatch` landed (2026-08-24) — while the assertion below, which is
      // already schema-driven, would have caught a genuinely missing entry on its own. A literal
      // here bought no coverage the next line does not have, and cost a red in a package the
      // change never touched. The deliberate count-tripwire lives in `placement.test.ts`.
      expect(els.length).toBe(clusterQueuedReasonSchema.options.length)
      return els
    })
    const texts = [...reasonEls].map((el) => el.textContent ?? '')
    // Asserted pairwise-distinct rather than against a literal, so a fifth reason reusing an
    // existing string would fail this the same way a genuine collapse to "queued" would.
    expect(new Set(texts).size).toBe(texts.length)
    expect(clusterQueuedReasonSchema.options.every((key) => texts.some((t) => t.includes(key)))).toBe(
      true,
    )
  })
})
