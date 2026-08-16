import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { AccountUsageResponse, AccountUsageRow } from '@loki-labs/better-cezar-api-client'
import { AccountUsagePanel } from './account-usage-panel'

/**
 * The sidebar account panel (`.ai/specs/2026-08-16-agent-account-usage-routing.md`).
 *
 * The first describe block is why this file exists. Everything else is ordinary rendering; that
 * one asserts a bar is drawn ONLY where a provider reported allowance, which is the difference
 * between a usage meter and a decoration that looks exactly like one.
 */

afterEach(cleanup)

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

function stubFetch(body: AccountUsageResponse): string[] {
  const sent: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      sent.push(String(input))
      return jsonResponse(body)
    }),
  )
  return sent
}

const future = () => Math.floor(Date.now() / 1000) + 3600

const CLAUDE: AccountUsageRow = {
  id: 'default:claude',
  provider: 'claude',
  label: 'Default',
  isDefault: true,
  inflight: 0,
  limited: false,
  signedIn: true,
  plan: 'max',
}

const CODEX: AccountUsageRow = {
  id: 'default:codex',
  provider: 'codex',
  label: 'Default',
  isDefault: true,
  inflight: 0,
  limited: false,
  quota: {
    takenAt: new Date().toISOString(),
    planType: 'pro',
    windows: [{ usedPercent: 43, windowMinutes: 300, resetsAt: future() }],
  },
}

function renderPanel(body: AccountUsageResponse) {
  const sent = stubFetch(body)
  render(
    <QueryClientProvider client={createQueryClient()}>
      <AccountUsagePanel />
    </QueryClientProvider>,
  )
  return sent
}

function bars(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-slot="quota-fill"]'))
}

function row(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-account="${id}"]`)
}

describe('a bar means allowance, and only allowance', () => {
  it('draws no bar on a Claude row, which has no allowance to report', async () => {
    // THE test. `claude auth status --json` answers identity and a plan NAME with no quantity
    // anywhere — so a bar here could only have been invented, most plausibly from the token spend
    // cezar already measures. Spend is not allowance, and the bar would be indistinguishable from
    // the Codex one beside it.
    renderPanel({ enabled: true, accounts: [CLAUDE, CODEX] })
    await waitFor(() => expect(row('default:codex')).not.toBeNull())

    expect(row('default:claude')?.querySelector('[data-slot="account-quota"]')).toBeNull()
    expect(row('default:codex')?.querySelector('[data-slot="account-quota"]')).not.toBeNull()
  })

  it('draws exactly one bar per reported window and none for anything else', async () => {
    renderPanel({
      enabled: true,
      accounts: [
        CLAUDE,
        {
          ...CODEX,
          quota: {
            takenAt: new Date().toISOString(),
            windows: [
              { usedPercent: 43, windowMinutes: 300, resetsAt: future() },
              { usedPercent: 7, windowMinutes: 10_080, resetsAt: future() },
            ],
          },
        },
      ],
    })
    await waitFor(() => expect(bars()).toHaveLength(2))
    // Two accounts, three rows' worth of numbers on screen, and still exactly two bars.
    expect(bars().map((bar) => bar.dataset.percent)).toEqual(['43', '7'])
  })

  it('renders nothing at all for a row whose quota is absent, not a zero-width bar', async () => {
    // A 0% bar is a claim ("nothing used"), and it is the claim a client makes by accident when
    // it renders a missing value through the same code path as a present one.
    renderPanel({ enabled: true, accounts: [CLAUDE] })
    await waitFor(() => expect(row('default:claude')).not.toBeNull())
    expect(bars()).toHaveLength(0)
  })

  it('shows an overage honestly instead of clamping the number', async () => {
    // The bar clamps at 100% because a bar cannot be longer than itself; the number must not.
    renderPanel({
      enabled: true,
      accounts: [
        {
          ...CODEX,
          quota: { takenAt: new Date().toISOString(), windows: [{ usedPercent: 104, windowMinutes: 300, resetsAt: future() }] },
        },
      ],
    })
    await waitFor(() => expect(bars()).toHaveLength(1))
    expect(bars()[0]?.style.width).toBe('100%')
    expect(screen.getByText('104%')).toBeTruthy()
  })
})

describe('status line', () => {
  it('names the plan when there is nothing more urgent to say', async () => {
    renderPanel({ enabled: true, accounts: [CLAUDE] })
    expect(await screen.findByText('max')).toBeTruthy()
  })

  it('says nothing about sign-in when cezar could not ask', async () => {
    // Absent `signedIn` is "could not ask", not "signed out" — rendering it as signed out puts a
    // red state on a login that works.
    const { signedIn: _dropped, ...unknown } = CLAUDE
    renderPanel({ enabled: true, accounts: [unknown] })
    await waitFor(() => expect(row('default:claude')).not.toBeNull())
    expect(screen.queryByText('signed out')).toBeNull()
    expect(screen.getByText('max')).toBeTruthy()
  })

  it('says signed out when the CLI said so', async () => {
    renderPanel({ enabled: true, accounts: [{ ...CLAUDE, signedIn: false, plan: undefined }] })
    expect(await screen.findByText('signed out')).toBeTruthy()
  })

  it('names a recovery time only when it was given one', async () => {
    renderPanel({
      enabled: true,
      accounts: [
        { ...CLAUDE, limited: true },
        { ...CODEX, limited: true, limitedUntil: '2026-08-16T18:40:00.000Z', quota: undefined },
      ],
    })
    await waitFor(() => expect(row('default:codex')).not.toBeNull())
    expect(row('default:claude')?.textContent).toContain('limited')
    expect(row('default:claude')?.textContent).not.toContain('until')
    expect(row('default:codex')?.textContent).toContain('until')
  })

  it('marks a limited row for the sidebar to style', async () => {
    renderPanel({ enabled: true, accounts: [{ ...CLAUDE, limited: true }] })
    await waitFor(() => expect(row('default:claude')?.dataset.limited).toBe('true'))
  })
})

describe('in-flight', () => {
  it('shows a count only when something is running', async () => {
    renderPanel({ enabled: true, accounts: [CLAUDE, { ...CODEX, inflight: 2 }] })
    await waitFor(() => expect(row('default:codex')).not.toBeNull())
    expect(row('default:claude')?.querySelector('[data-slot="account-inflight"]')).toBeNull()
    expect(row('default:codex')?.querySelector('[data-slot="account-inflight"]')?.textContent).toBe('2')
  })
})

describe('when there is nothing to show', () => {
  it('renders nothing with the capability off', async () => {
    renderPanel({ enabled: false, accounts: [] })
    await waitFor(() => expect(document.querySelector('[data-slot="account-usage-panel"]')).toBeNull())
  })

  it('renders nothing when the machine has no accounts', async () => {
    renderPanel({ enabled: true, accounts: [] })
    await waitFor(() => expect(document.querySelector('[data-slot="account-usage-panel"]')).toBeNull())
  })

  it('asks the workspace endpoint exactly once per mount', async () => {
    // The capability gate is the panel's MOUNT (app-shell.test.tsx owns that guard), so once this
    // component exists it always asks — this pins WHAT it asks for, since a scope-prefixed path
    // would answer for one project instead of the machine.
    const sent = renderPanel({ enabled: true, accounts: [CLAUDE] })
    await waitFor(() => expect(row('default:claude')).not.toBeNull())
    expect(sent).toEqual(['/api/v1/workspace/agent-accounts/usage'])
  })
})
