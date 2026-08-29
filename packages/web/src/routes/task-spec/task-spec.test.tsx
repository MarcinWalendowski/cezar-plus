import { readFileSync } from 'node:fs'
import path from 'node:path'

import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { trackEvent } from '@/api/analytics'
import type { ApiRun, HealthResponse, SpecReviewEntry, SpecReviewFeedResponse } from '@loki-labs/better-cezar-api-client'

import { TaskSpecRoute, specFeedMode, specFeedSource, toFeedCards, type SpecFeedMode } from './task-spec'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

// ---- entry fixtures ----------------------------------------------------------------------

const specEntry = (seq: number, revision: number, text = `spec text v${revision}`): SpecReviewEntry => ({
  seq,
  at: '2026-08-29T00:00:00.000Z',
  stepId: 'spec',
  kind: 'spec',
  revision,
  specPath: '.ai/specs/x.md',
  source: 'recorded',
  text,
})

const reviewEntry = (
  seq: number,
  actor: 'agent' | 'human',
  verdict: 'pass' | 'revise',
  revision: number | undefined,
  report = 'looks fine',
): SpecReviewEntry => ({
  seq,
  at: '2026-08-29T00:00:00.000Z',
  stepId: 'review-spec',
  kind: 'review',
  ...(revision !== undefined ? { revision } : {}),
  actor,
  verdict,
  report,
})

// ---- toFeedCards (P3 tests 18, 18b, 18c, 18d, 20b) ---------------------------------------

describe('toFeedCards — the derivation rules (Solution → "The raw log does not alternate")', () => {
  it('18: a straightforward revised run renders four cards in order, newest spec expanded', () => {
    const entries = [
      specEntry(0, 1, 'v1 text'),
      reviewEntry(1, 'agent', 'revise', 1, 'FILE: x.md\nSECTION: intro\nCHANGE: tighten it'),
      specEntry(2, 2, 'v2 text'),
      reviewEntry(3, 'agent', 'pass', 2),
    ]
    const result = toFeedCards(entries)
    expect(result.layout).toBe('feed')
    expect(result.cards).toHaveLength(4)
    expect(result.cards.map((c) => c.kind)).toEqual(['spec', 'review', 'spec', 'review'])
    const [spec1, review1, spec2] = result.cards
    expect(spec1).toMatchObject({ kind: 'spec', defaultExpanded: false })
    expect(review1).toMatchObject({ kind: 'review' })
    if (review1?.kind === 'review') expect(review1.entry.report).toContain('FILE: x.md')
    expect(spec2).toMatchObject({ kind: 'spec', defaultExpanded: true })
  })

  it('18b: the human-gate sequence does not alternate on disk — a provisional agent pass is suppressed', () => {
    // Exactly the raw write order from Solution → "The raw log does not alternate": the agent
    // verdict block runs BEFORE the human gate, so a clean agent pass can sit immediately
    // before the human's send-back for the SAME revision.
    const entries = [
      specEntry(0, 1),
      reviewEntry(1, 'agent', 'pass', 1),
      reviewEntry(2, 'human', 'revise', 1, 'needs a data model section'),
      specEntry(3, 2),
      reviewEntry(4, 'agent', 'pass', 2),
    ]
    const result = toFeedCards(entries)
    expect(result.cards).toHaveLength(4)
    expect(result.cards.map((c) => c.kind)).toEqual(['spec', 'review', 'spec', 'review'])
    // The revision-1 agent pass (seq 1) never became a card — it was provisional.
    const reviewCards = result.cards.filter((c) => c.kind === 'review')
    expect(reviewCards.map((c) => (c.kind === 'review' ? c.entry.seq : null))).toEqual([2, 4])
    expect(reviewCards[0]).toMatchObject({ entry: { actor: 'human', verdict: 'revise' } })
    // The revision-2 agent pass (seq 4) DOES render — it is the final verdict, nothing follows it.
    expect(reviewCards[1]).toMatchObject({ entry: { actor: 'agent', verdict: 'pass', seq: 4 } })
  })

  it('18c: at the FIRST gate, a trailing agent pass is neutral while approval is pending', () => {
    const entries = [specEntry(0, 1), reviewEntry(1, 'agent', 'pass', 1)]
    const pending = { stepId: 'review-spec', requestedAt: '2026-08-29T00:00:00.000Z', approvals: [], minApprovers: 1 }

    const gated = toFeedCards(entries, pending)
    expect(gated.layout).toBe('feed')
    expect(gated.cards.map((c) => c.kind)).toEqual(['spec', 'awaiting'])

    // Once approval clears with no later revise, this is the SAME (entries, undefined) input as
    // test 17's fixture — the same pure function must settle on the same answer either way: the
    // "accepted" layout (spec + single-line note), never a distinct new card shape.
    const settled = toFeedCards(entries, undefined)
    expect(settled.layout).toBe('accepted')
    expect(settled.cards).toHaveLength(0)
  })

  it('18d: the awaiting state recurs at the SECOND gate too — not a revisions===1 special case', () => {
    const entries = [
      specEntry(0, 1),
      reviewEntry(1, 'agent', 'pass', 1),
      reviewEntry(2, 'human', 'revise', 1),
      specEntry(3, 2),
      reviewEntry(4, 'agent', 'pass', 2),
    ]
    const pending = { stepId: 'review-spec', requestedAt: '2026-08-29T00:00:00.000Z', approvals: [], minApprovers: 1 }
    const result = toFeedCards(entries, pending)
    expect(result.cards.map((c) => c.kind)).toEqual(['spec', 'review', 'spec', 'awaiting'])
    expect(result.cards[3]).toMatchObject({ kind: 'awaiting', revision: 2 })
  })

  // A gate on a step OTHER than review-spec (e.g. a later manual-deploy gate) must not be read
  // as "the spec review is still pending" — only `pendingApproval.stepId === 'review-spec'` may
  // trigger the awaiting-approval substitution.
  it('a pendingApproval on a different step does not suppress the final verdict', () => {
    const entries = [specEntry(0, 1), reviewEntry(1, 'agent', 'pass', 1)]
    const pending = { stepId: 'deploy', requestedAt: '2026-08-29T00:00:00.000Z', approvals: [], minApprovers: 1 }
    expect(toFeedCards(entries, pending).layout).toBe('accepted')
  })

  it('20b: an unmatched review (no spec captured at all) renders unlabelled, never dropped', () => {
    const entries = [reviewEntry(0, 'agent', 'revise', undefined, 'no spec was ever declared')]
    const result = toFeedCards(entries)
    expect(result.layout).toBe('feed')
    expect(result.cards).toHaveLength(1)
    const card = result.cards[0]!
    expect(card.kind).toBe('review')
    if (card.kind === 'review') {
      expect(card.entry.revision).toBeUndefined()
      expect(card.entry.report).toBe('no spec was ever declared')
    }
  })

  it('zero reviews renders the spec alone, no feed chrome', () => {
    const result = toFeedCards([specEntry(0, 1)])
    expect(result.layout).toBe('spec-only')
    expect(result.cards).toHaveLength(0)
    expect(result.latestSpec?.revision).toBe(1)
  })

  it('no entries at all renders the empty layout', () => {
    expect(toFeedCards([])).toEqual({ layout: 'empty', cards: [] })
  })
})

// ---- specFeedMode / specFeedSource — the analytics classifier (P3 test 21c) ----------------

describe('specFeedMode — exhaustive over every successful response shape', () => {
  it.each<[string, SpecReviewEntry[], SpecFeedMode]>([
    ['draft: a spec with no review yet', [specEntry(0, 1)], 'draft'],
    ['clean: a spec accepted first try', [specEntry(0, 1), reviewEntry(1, 'agent', 'pass', 1)], 'clean'],
    [
      'revised: any revise anywhere engages the loop',
      [specEntry(0, 1), reviewEntry(1, 'agent', 'revise', 1), specEntry(2, 2), reviewEntry(3, 'agent', 'pass', 2)],
      'revised',
    ],
    ['unmatched: a review with no spec entry at all', [reviewEntry(0, 'agent', 'revise', undefined)], 'unmatched'],
    ['empty: a successful response with nothing recorded', [], 'empty'],
  ])('%s', (_case, entries, expected) => {
    expect(specFeedMode(entries)).toBe(expected)
  })

  // The sixth assertion: the classifier's return type is a CLOSED union of exactly these five
  // strings — a switch with no `default` fallthrough only compiles if it is exhaustive, so a
  // sixth mode added without updating this switch fails typecheck, not just this test.
  it('is a closed five-value union (compile-time exhaustiveness)', () => {
    const assertExhaustive = (mode: SpecFeedMode): string => {
      switch (mode) {
        case 'draft':
        case 'clean':
        case 'revised':
        case 'unmatched':
        case 'empty':
          return mode
        default: {
          const neverMode: never = mode
          return neverMode
        }
      }
    }
    for (const mode of ['draft', 'clean', 'revised', 'unmatched', 'empty'] as const) {
      expect(assertExhaustive(mode)).toBe(mode)
    }
  })
})

describe('specFeedSource', () => {
  it('reads the recorded/worktree tag off any spec entry', () => {
    expect(specFeedSource([specEntry(0, 1)], 1)).toBe('recorded')
    expect(specFeedSource([{ ...specEntry(0, 1), source: 'worktree' }], 1)).toBe('worktree')
  })
  it('an unmatched-review-only response is always recorded — the worktree fallback never synthesises a bare review', () => {
    expect(specFeedSource([reviewEntry(0, 'agent', 'revise', undefined)], 0)).toBe('recorded')
  })
  it('no entries at all is "none"', () => {
    expect(specFeedSource([], 0)).toBe('none')
  })
})

// ---- the mounted route --------------------------------------------------------------------

const RUN: ApiRun = {
  id: 'r1',
  title: 'write the onboarding spec',
  titleSummary: 'Onboarding spec',
  workflow: 'spec-to-deploy',
  task: 'Write a spec for onboarding.',
  status: 'done',
  createdAt: '2026-08-29T08:00:00.000Z',
  tokensUsed: 0,
  archived: false,
  steps: [],
}

const HEALTH: HealthResponse = {
  version: '0.0.0-test',
  projects: [],
  bootProject: 'default',
  repoRoot: '/repo',
  repo: { root: '/repo', branch: 'main', remote: 'git@github.com:acme/demo.git' },
  checks: [],
  defaultRunner: 'claude',
  forge: { kind: 'github', available: true },
  capabilities: {
    cluster: false, localHandoff: true, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true,
    followups: false, singleProject: false, knowledge: false, sources: false, notes: false,
    workspaceViews: false, notify: false, accountUsage: false, autoAccounts: false, skills: true, automations: false,
  },
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

interface SentRequest {
  path: string
  method: string
  body: unknown
}

function stubFetch(
  run: ApiRun,
  spec: SpecReviewFeedResponse,
  overrides: Record<string, () => Response> = {},
): SentRequest[] {
  const sent: SentRequest[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input)
      const method = init.method ?? 'GET'
      const bodyText = typeof init.body === 'string' ? init.body : undefined
      sent.push({ path, method, body: bodyText ? JSON.parse(bodyText) : undefined })
      const override = overrides[`${method} ${path}`]
      if (override) return override()
      if (method === 'GET' && path === '/api/v1/runs/r1') return jsonResponse(run)
      if (method === 'GET' && path === '/api/v1/health') return jsonResponse(HEALTH)
      if (method === 'GET' && path === '/api/v1/runs/r1/spec') return jsonResponse(spec)
      if (method === 'POST' && path === '/api/v1/workspace/analytics/events') {
        return jsonResponse({ accepted: 1 }, 202)
      }
      return jsonResponse({ error: `unstubbed: ${method} ${path}` }, 404)
    }),
  )
  return sent
}

function renderSpecRoute(strict = false) {
  const tree = (
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/tasks/r1/spec']}>
        <Routes>
          <Route path="/tasks/:id/spec" element={<TaskSpecRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
  render(strict ? <StrictMode>{tree}</StrictMode> : tree)
}

describe('the Spec tab route', () => {
  it('P3 test 17: a clean first-pass accepts renders the spec plus a single-line note — no feed', async () => {
    stubFetch(RUN, {
      entries: [specEntry(0, 1, '# The onboarding spec'), reviewEntry(1, 'agent', 'pass', 1)],
      summary: { revisions: 1, reviews: 1, latestVerdict: 'pass' },
    })
    renderSpecRoute()

    await waitFor(() => expect(document.querySelector('[data-slot="spec-accepted-note"]')).not.toBeNull())
    expect(document.querySelector('[data-slot="spec-review-card"]')).toBeNull()
    expect(document.querySelector('[data-slot="spec-card"]')).toBeNull()
    expect(document.body.textContent).toContain('The onboarding spec')
  })

  it('P3 test 19: a human review card is visibly distinct from an agent one', async () => {
    stubFetch(RUN, {
      entries: [
        specEntry(0, 1),
        reviewEntry(1, 'human', 'revise', 1, 'add a rollout plan'),
        specEntry(2, 2),
        reviewEntry(3, 'agent', 'pass', 2),
      ],
      summary: { revisions: 2, reviews: 2, latestVerdict: 'pass' },
    })
    renderSpecRoute()

    await waitFor(() => expect(document.querySelectorAll('[data-slot="spec-review-card"]')).toHaveLength(2))
    const [human, agent] = [...document.querySelectorAll('[data-slot="spec-review-card"]')] as HTMLElement[]
    expect(human!.dataset.actor).toBe('human')
    expect(agent!.dataset.actor).toBe('agent')
    // Structurally AND visually distinguishable — not just a data attribute nobody paints.
    expect(human!.className).not.toBe(agent!.className)
    expect(document.body.textContent).toContain('add a rollout plan')
  })

  it('P3 test 20: an empty feed is an honest message, never a spinner or an error', async () => {
    stubFetch(RUN, { entries: [], summary: { revisions: 0, reviews: 0 } })
    renderSpecRoute()

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'No spec recorded for this task' })).toBeTruthy(),
    )
    expect(document.querySelector('[data-slot="spec-loading"]')).toBeNull()
    expect(document.querySelector('[data-tone="danger"]')).toBeNull()
  })

  it('P3 test 22: spec.feed_opened fires exactly once — survives a poll refetch, StrictMode, and loading/error render no POST', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const runningRun: ApiRun = { ...RUN, status: 'running' }
    const feed: SpecReviewFeedResponse = {
      entries: [
        specEntry(0, 1),
        reviewEntry(1, 'agent', 'revise', 1),
        specEntry(2, 2),
        reviewEntry(3, 'agent', 'pass', 2),
      ],
      summary: { revisions: 2, reviews: 2, latestVerdict: 'pass' },
    }
    const sent = stubFetch(runningRun, feed)
    renderSpecRoute(/* strict */ true)

    await vi.waitFor(() =>
      expect(sent.some((r) => r.method === 'POST' && r.path === '/api/v1/workspace/analytics/events')).toBe(true),
    )

    const postsAfterFirstLoad = () =>
      sent.filter((r) => r.method === 'POST' && r.path === '/api/v1/workspace/analytics/events')
    expect(postsAfterFirstLoad()).toHaveLength(1)
    expect(postsAfterFirstLoad()[0]!.body).toEqual({
      events: [
        {
          name: 'spec.feed_opened',
          props: {
            project: 'default',
            mode: 'revised',
            approvalPending: false,
            revisions: 2,
            reviews: 2,
            source: 'recorded',
          },
        },
      ],
    })

    // (a) the 5s poll refetches (this run is 'running', so useRunSpec polls) — still exactly one.
    await vi.advanceTimersByTimeAsync(5000)
    expect(postsAfterFirstLoad()).toHaveLength(1)

    // (b) StrictMode already double-invoked this component's effects on mount (above) — still one.
    // (c) is covered by the two loading/error tests below, which assert zero POSTs of their own.
  })

  it('P3 test 22c: the loading state sends no analytics POST', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<never>(() => {})))
    renderSpecRoute()
    expect(document.querySelector('[data-slot="spec-loading"]')).toBeTruthy
  })

  it('P3 test 22c: an error state sends no analytics POST', async () => {
    const sent = stubFetch(RUN, { entries: [], summary: { revisions: 0, reviews: 0 } }, {
      'GET /api/v1/runs/r1/spec': () => jsonResponse({ error: 'boom' }, 500),
    })
    renderSpecRoute()

    await waitFor(() => expect(screen.getByText('Could not load the spec')).toBeTruthy())
    expect(sent.some((r) => r.method === 'POST' && r.path === '/api/v1/workspace/analytics/events')).toBe(false)
  })

  it('renders normally when the analytics call itself rejects — trackEvent fails open', async () => {
    stubFetch(RUN, {
      entries: [specEntry(0, 1, '# Renders fine either way')],
      summary: { revisions: 1, reviews: 0 },
    }, {
      'POST /api/v1/workspace/analytics/events': () => {
        throw new Error('network is down')
      },
    })
    renderSpecRoute()

    await waitFor(() => expect(document.body.textContent).toContain('Renders fine either way'))
  })
})

// ---- P3 test 21b: the analytics wrapper owns no transport ----------------------------------

describe('api/analytics.ts', () => {
  it('contains zero occurrences of `fetch(` in its own source', () => {
    // `import.meta.dirname` (Node 20.11+) rather than `fileURLToPath(import.meta.url)` — the
    // latter is not reliably a `file:` URL under this file's (jsdom) Vitest environment, and
    // `process.cwd()` is not reliably the package root either (it differs between `vitest run`
    // from this package and the root `npm test`, which runs the whole workspace).
    const file = path.resolve(import.meta.dirname, '../../api/analytics.ts')
    const source = readFileSync(file, 'utf8')
    expect(source).not.toContain('fetch(')
  })

  it('trackEvent reaches the network through exactly one POST to the shared analytics route', async () => {
    const sent: SentRequest[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const path = String(input)
        const method = init.method ?? 'GET'
        const bodyText = typeof init.body === 'string' ? init.body : undefined
        sent.push({ path, method, body: bodyText ? JSON.parse(bodyText) : undefined })
        return jsonResponse({ accepted: 1 }, 202)
      }),
    )

    trackEvent('spec.feed_opened', { project: 'default', mode: 'draft' })
    await waitFor(() =>
      expect(sent.filter((r) => r.method === 'POST' && r.path === '/api/v1/workspace/analytics/events')).toHaveLength(1),
    )
    expect(sent[0]!.body).toEqual({
      events: [{ name: 'spec.feed_opened', props: { project: 'default', mode: 'draft' } }],
    })
  })

  it('never throws and never awaits — a rejecting transport is fully swallowed', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))))
    expect(() => trackEvent('spec.feed_opened', { project: 'default', mode: 'draft' })).not.toThrow()
    // Give the swallowed rejection a turn to surface as an unhandled rejection, if it were going to.
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
})
