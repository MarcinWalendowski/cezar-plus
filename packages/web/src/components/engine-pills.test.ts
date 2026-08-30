import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { LockableRunner, Runner } from '@loki-labs/cezar-plus-api-client'

import { engineBody, engineRunBody, type EnginePick, type ResolvedEngine, useResolvedEngine } from './engine-pills'

/**
 * `engineBody` (#401) is the one place the create-run body rules live for the Inbox and the
 * GitHub tab. The rules are small; the reason they are worth pinning is the third case below —
 * the composer's `runnerCount > 1` rule gets it wrong, and this is the difference.
 */

const resolved = (over: Partial<ResolvedEngine> = {}): ResolvedEngine => ({
  runner: 'claude',
  runnerExplicit: false,
  model: '',
  runners: ['claude'],
  defaultRunner: 'claude',
  canRun: true,
  providerPending: false,
  providerError: false,
  accounts: [],
  account: null,
  lock: null,
  ...over,
})

/** One row of `GET /api/v1/workspace/agent-profiles`. Only the four fields the pills read matter
 *  here; the rest of the closed schema is pinned by the contract tests. */
const profile = (provider: Runner, id: string, label: string) => ({
  id,
  provider,
  label,
  configDir: `~/.${provider}-${id}`,
  path: `/home/u/.${provider}-${id}`,
  exists: true,
  looksValid: true,
  isDefault: id === 'default',
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

function stubResolverFetch({
  providers,
  providerStatus = 200,
  providerPending = false,
  bootDefault = 'claude',
  projectDefault = 'claude',
  profiles = [],
  selections = {},
  repoRoot = '/repo',
  runnerLock,
}: {
  providers: unknown
  providerStatus?: number
  providerPending?: boolean
  bootDefault?: Runner
  projectDefault?: Runner
  profiles?: ReturnType<typeof profile>[]
  selections?: Record<string, Partial<Record<Runner, string>>>
  repoRoot?: string
  /** The global engine lock on `GET /workspace/config`. Omitted by default — the shape this file
   *  served before the lock existed, and the shape an older server still sends. */
  runnerLock?: LockableRunner | null
}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input)
      if (path === '/api/v1/providers/status') {
        if (providerPending) return new Promise<Response>(() => {})
        return jsonResponse(providers, providerStatus)
      }
      if (path === '/api/v1/health') {
        return jsonResponse({
          defaultRunner: bootDefault,
          checks: [{ name: 'claude', available: true }],
        })
      }
      if (path === '/api/v1/config') {
        return jsonResponse({ defaultRunner: projectDefault, defaultModels: {}, modelsLocked: false })
      }
      if (path === '/api/v1/models?runner=codex') {
        return jsonResponse({ runner: 'codex', models: [], source: 'live', stale: false })
      }
      if (path.endsWith('/workspace/agent-profiles')) {
        return jsonResponse({
          editable: true,
          profiles,
          profileCapableProviders: ['claude', 'codex'],
          selections,
          defaults: {},
        })
      }
      if (path.endsWith('/repo')) return jsonResponse({ info: { root: repoRoot } })
      if (path.endsWith('/workspace/config'))
        return jsonResponse(runnerLock === undefined ? {} : { runnerLock })
      return jsonResponse({})
    }),
  )
}

function renderResolved(pick: EnginePick = { runner: null, model: null, account: null }) {
  const client = createQueryClient()
  return renderHook(() => useResolvedEngine(pick), {
    wrapper: ({ children }) =>
      createElement(QueryClientProvider, { client }, children),
  })
}

describe('useResolvedEngine provider status', () => {
  it('derives runnable choices from connected providers, not installation health', async () => {
    stubResolverFetch({
      providers: {
        providers: [
          { provider: 'claude', status: 'disconnected', enabled: true },
          { provider: 'codex', status: 'connected', enabled: true },
          { provider: 'opencode', status: 'not-installed', enabled: true },
        ],
      },
    })

    const { result } = renderResolved()
    await waitFor(() => expect(result.current.canRun).toBe(true))

    expect(result.current.runners).toEqual(['codex'])
    expect(result.current.runner).toBe('codex')
    expect(result.current.providerPending).toBe(false)
    expect(result.current.providerError).toBe(false)
  })

  it('cannot run while provider status is pending', async () => {
    stubResolverFetch({ providers: {}, providerPending: true })

    const { result } = renderResolved()
    await waitFor(() => expect(result.current.providerPending).toBe(true))

    expect(result.current.canRun).toBe(false)
  })

  it('cannot run when provider status verification fails', async () => {
    stubResolverFetch({
      providers: { error: 'verification failed' },
      providerStatus: 404,
    })

    const { result } = renderResolved()
    await waitFor(() => expect(result.current.providerError).toBe(true))

    expect(result.current.canRun).toBe(false)
    expect(result.current.runners).toEqual([])
  })

  it('cannot run when provider status succeeds with no connected provider', async () => {
    stubResolverFetch({
      providers: {
        providers: [
          { provider: 'claude', status: 'disconnected', enabled: true },
          { provider: 'codex', status: 'unknown', enabled: true },
          { provider: 'opencode', status: 'not-installed', enabled: true },
        ],
      },
    })

    const { result } = renderResolved()
    await waitFor(() => expect(result.current.providerPending).toBe(false))

    expect(result.current.canRun).toBe(false)
    expect(result.current.runners).toEqual([])
  })

  it('excludes a connected but disabled provider while retaining an enabled fallback', async () => {
    stubResolverFetch({
      providers: {
        providers: [
          { provider: 'claude', status: 'connected', enabled: false },
          { provider: 'codex', status: 'connected', enabled: true },
          { provider: 'opencode', status: 'not-installed', enabled: true },
        ],
      },
    })

    const { result } = renderResolved()
    await waitFor(() => expect(result.current.canRun).toBe(true))

    expect(result.current.runners).toEqual(['codex'])
    expect(result.current.runner).toBe('codex')
  })

  it('resolves an untouched pick from project config, never the boot health default', async () => {
    stubResolverFetch({
      bootDefault: 'codex',
      projectDefault: 'claude',
      providers: {
        providers: [
          { provider: 'claude', status: 'connected', enabled: true },
          { provider: 'codex', status: 'connected', enabled: true },
          { provider: 'opencode', status: 'not-installed', enabled: true },
        ],
      },
    })

    const { result } = renderResolved()
    await waitFor(() => expect(result.current.canRun).toBe(true))

    expect(result.current.runner).toBe('claude')
    expect(result.current.defaultRunner).toBe('claude')
  })
})

describe('engineBody', () => {
  it("auto ('') stays implicit rather than shipping an empty model", () => {
    expect(engineBody(resolved({ model: '' })).model).toBeUndefined()
  })

  it('a pinned model is sent', () => {
    expect(engineBody(resolved({ model: 'opus' })).model).toBe('opus')
  })

  it('omits a resolved native model when model selection is locked', () => {
    expect(engineBody(resolved({ model: 'opus', modelsLocked: true })).model).toBeUndefined()
  })

  it('omits the runner when it is already what the server would choose', () => {
    const body = engineBody(resolved({ runner: 'claude', defaultRunner: 'claude' }))
    expect(body.runner).toBeUndefined()
  })

  it('sends the runner when it differs from the default — a real pick', () => {
    const body = engineBody(
      resolved({ runner: 'codex', defaultRunner: 'claude', runners: ['claude', 'codex'] }),
    )
    expect(body.runner).toBe('codex')
  })

  it('always sends an explicit pick even when it equals the reported default', () => {
    const body = engineBody(
      resolved({ runner: 'codex', runnerExplicit: true, defaultRunner: 'codex' }),
    )
    expect(body.runner).toBe('codex')
  })

  /**
   * The case the composer's count rule gets wrong (#401 review). The host prefers codex, but
   * provider status says only claude is connected. `runnerCount` is 1, so the count rule would
   * omit the runner; the server would then resolve the omitted field straight back to codex.
   * Comparing against the authoritative project config default sends `claude` and settles it.
   */
  it('sends the runner when the host default is unavailable, even with one backend left', () => {
    const body = engineBody(
      resolved({ runner: 'claude', defaultRunner: 'codex', runners: ['claude'], model: 'opus' }),
    )
    expect(body.runner).toBe('claude')
    expect(body.model).toBe('opus')
  })

  it('collapses to the composer on a healthy single-backend host — nothing sent', () => {
    const body = engineBody(
      resolved({ runner: 'claude', defaultRunner: 'claude', runners: ['claude'], model: '' }),
    )
    expect(body).toEqual({ runner: undefined, model: undefined })
  })

  it.each<Runner>(['claude', 'codex', 'opencode', 'pi'])(
    'is symmetric for %s as the host default',
    (runner) => {
      expect(engineBody(resolved({ runner, defaultRunner: runner })).runner).toBeUndefined()
    },
  )
})

/**
 * The agent account on the wire (spec 2026-07-29-agent-profiles). The distinction these pin is the
 * one that is easy to lose: an untouched pill must not carry an `agentProfile` KEY at all — that is
 * what lets the run follow the project's selection, and it is a different request from naming the
 * discovered `'default'` account explicitly, which overrides that selection server-side.
 */
describe('engineRunBody', () => {
  it('puts no agentProfile key on the wire for an untouched pick', () => {
    const body = engineRunBody(resolved({ account: null }))
    // `in`, not `=== undefined`: `agentProfile: undefined` would type the key as always-present
    // and JSON.stringify would drop it — the mismatch contract-parity tests exist to catch.
    expect('agentProfile' in body).toBe(false)
  })

  it('sends a chosen account', () => {
    expect(engineRunBody(resolved({ account: 'klaudiusz' })).agentProfile).toBe('klaudiusz')
  })

  it("sends the discovered account when it was picked EXPLICITLY — 'default' is not 'untouched'", () => {
    const body = engineRunBody(resolved({ account: 'default' }))
    expect('agentProfile' in body).toBe(true)
    expect(body.agentProfile).toBe('default')
  })

  it('carries the runner/model rules through unchanged', () => {
    const body = engineRunBody(
      resolved({ runner: 'codex', defaultRunner: 'claude', model: 'gpt-future', account: 'work' }),
    )
    expect(body).toEqual({ runner: 'codex', model: 'gpt-future', agentProfile: 'work' })
  })
})

describe('useResolvedEngine agent accounts', () => {
  const TWO_CLAUDE_LOGINS = [
    profile('claude', 'default', 'Default'),
    profile('claude', 'klaudiusz', 'Klaudiusz'),
    profile('codex', 'default', 'Default'),
  ]

  it('resolves the accounts and the project selection the pill renders from', async () => {
    stubResolverFetch({
      providers: { providers: [{ provider: 'claude', status: 'connected', enabled: true }] },
      profiles: TWO_CLAUDE_LOGINS,
      selections: { '/repo': { claude: 'klaudiusz' } },
      repoRoot: '/repo',
    })

    const { result } = renderResolved()
    await waitFor(() => expect(result.current.accounts).toHaveLength(3))

    expect(result.current.accounts.map((a) => `${a.provider}:${a.id}`)).toEqual([
      'claude:default',
      'claude:klaudiusz',
      'codex:default',
    ])
    // The selection is keyed by the project's ROOT, which is what `useRepo` answers.
    expect(result.current.repoAccount).toEqual({ claude: 'klaudiusz' })
    // Untouched: the pill shows the project's row, but nothing rides the request.
    expect(result.current.account).toBeNull()
    expect('agentProfile' in engineRunBody(result.current)).toBe(false)
  })

  it('honours a pick belonging to the resolved runner', async () => {
    stubResolverFetch({
      providers: { providers: [{ provider: 'claude', status: 'connected', enabled: true }] },
      profiles: TWO_CLAUDE_LOGINS,
    })

    const { result } = renderResolved({ runner: 'claude', model: null, account: 'klaudiusz' })
    await waitFor(() => expect(result.current.account).toBe('klaudiusz'))

    expect(engineRunBody(result.current).agentProfile).toBe('klaudiusz')
  })

  /**
   * The rule that keeps a runner switch from silently billing the wrong subscription: the pick
   * still names the OLD runner's login, so it is dropped rather than sent. `klaudiusz` is a
   * claude login and the resolved runner is codex — no `agentProfile` reaches the wire.
   */
  it('drops an account belonging to another runner rather than sending it', async () => {
    stubResolverFetch({
      providers: {
        providers: [
          { provider: 'claude', status: 'connected', enabled: true },
          { provider: 'codex', status: 'connected', enabled: true },
        ],
      },
      profiles: TWO_CLAUDE_LOGINS,
    })

    const { result } = renderResolved({ runner: 'codex', model: null, account: 'klaudiusz' })
    await waitFor(() => expect(result.current.runner).toBe('codex'))

    expect(result.current.account).toBeNull()
    expect('agentProfile' in engineRunBody(result.current)).toBe(false)
  })

  it('drops an account that no longer exists', async () => {
    stubResolverFetch({
      providers: { providers: [{ provider: 'claude', status: 'connected', enabled: true }] },
      profiles: TWO_CLAUDE_LOGINS,
    })

    const { result } = renderResolved({ runner: 'claude', model: null, account: 'deleted-login' })
    await waitFor(() => expect(result.current.accounts).toHaveLength(3))

    expect(result.current.account).toBeNull()
  })

  it('is empty on a zero-config host, so nothing about the body changes', async () => {
    stubResolverFetch({
      providers: { providers: [{ provider: 'claude', status: 'connected', enabled: true }] },
      profiles: [],
    })

    const { result } = renderResolved()
    await waitFor(() => expect(result.current.canRun).toBe(true))

    expect(result.current.accounts).toEqual([])
    expect(engineRunBody(result.current)).toEqual(engineBody(result.current))
  })
})

/**
 * The global engine lock, at the shared resolver (`.ai/specs/2026-08-29-global-provider-toggle.md`,
 * D2 rank 5 / D6a, V5d).
 *
 * `useResolvedEngine` is what the Inbox quick-start and the GitHub hand-off both start runs
 * through, so these are the cases that keep those two surfaces honest without a suite each. They
 * assert the BODY as well as the resolved runner: the pill and the request agreeing is the whole
 * point, and the production report was a pill that said codex over a run that was claude.
 */
describe('useResolvedEngine engine lock', () => {
  const BOTH_CONNECTED = {
    providers: [
      { provider: 'claude', status: 'connected', enabled: true },
      { provider: 'codex', status: 'connected', enabled: true },
    ],
  }

  it('overrides an explicit pick, and sends the lock', async () => {
    stubResolverFetch({ providers: BOTH_CONNECTED, runnerLock: 'codex' })

    const { result } = renderResolved({ runner: 'claude', model: null, account: null })
    await waitFor(() => expect(result.current.lock).toBe('codex'))

    expect(result.current.runner).toBe('codex')
    expect(engineBody(result.current).runner).toBe('codex')
  })

  it('honours the pick on Auto — the control', async () => {
    // Without this the case above passes against a resolver that ignores the pick outright.
    stubResolverFetch({ providers: BOTH_CONNECTED, runnerLock: null })

    const { result } = renderResolved({ runner: 'claude', model: null, account: null })
    await waitFor(() => expect(result.current.canRun).toBe(true))

    expect(result.current.lock).toBeNull()
    expect(result.current.runner).toBe('claude')
  })

  it('sends the locked runner even when nothing was picked and it equals the project default', async () => {
    // `runnerOverride` omits a runner that IS the server's own default, which is right for an
    // untouched pill and wrong for a lock: omission means "you decide", and the pill is not
    // offering a decision any more. It reaches the same provider either way here — that is exactly
    // why it has to be asserted rather than assumed from a green run.
    stubResolverFetch({ providers: BOTH_CONNECTED, projectDefault: 'claude', runnerLock: 'claude' })

    const { result } = renderResolved()
    await waitFor(() => expect(result.current.lock).toBe('claude'))

    expect(result.current.runnerExplicit).toBe(true)
    expect(engineBody(result.current).runner).toBe('claude')
  })

  it('omits it on Auto with the same inputs — the control', async () => {
    stubResolverFetch({ providers: BOTH_CONNECTED, projectDefault: 'claude', runnerLock: null })

    const { result } = renderResolved()
    await waitFor(() => expect(result.current.canRun).toBe(true))

    expect(engineBody(result.current).runner).toBeUndefined()
  })

  it('drops a foreign provider\'s account id (D6a)', async () => {
    // An account id is provider-scoped, so carrying a codex login onto a claude-locked run names a
    // login that provider does not have. It fails as a routing miss several layers down, where
    // nothing left says the lock is why.
    stubResolverFetch({
      providers: BOTH_CONNECTED,
      profiles: [profile('claude', 'default', 'Default'), profile('codex', 'work', 'Codex Work')],
      runnerLock: 'claude',
    })

    const { result } = renderResolved({ runner: 'codex', model: null, account: 'work' })
    await waitFor(() => expect(result.current.runner).toBe('claude'))

    expect(result.current.account).toBeNull()
    expect('agentProfile' in engineRunBody(result.current)).toBe(false)
  })

  it('ignores a lock naming a provider this host cannot run (D3)', async () => {
    // Availability outranks the lock, server-side and here: `downgradePinnedRunner` still moves
    // work off a locked provider with no runnable account, so a picker fixed to it would promise
    // something dispatch will not do.
    stubResolverFetch({
      providers: { providers: [{ provider: 'claude', status: 'connected', enabled: true }] },
      runnerLock: 'codex',
    })

    const { result } = renderResolved()
    await waitFor(() => expect(result.current.canRun).toBe(true))

    expect(result.current.lock).toBeNull()
    expect(result.current.runner).toBe('claude')
  })
})
