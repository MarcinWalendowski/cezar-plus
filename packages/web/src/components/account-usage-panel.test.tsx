import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { AccountUsageResponse, AccountUsageRow } from '@loki-labs/cezar-plus-api-client'
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
  it('draws no bar on a row whose provider reported no allowance', async () => {
    // THE test. (Titled "draws no bar on a Claude row, which has no allowance to report" until
    // 2026-08-16, when `claude -p "/usage"` turned out to report windows after all — see
    // `2026-08-16-claude-usage-windows.md`. The rule it guards is unchanged and is not about
    // Claude: a row with no reported quota gets no bar, because a bar here could only have been
    // invented, most plausibly from the token spend cezar already measures. Spend is not allowance,
    // and the bar would be indistinguishable from the real one beside it.)
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

  it('labels a window by the provider’s own name, so two same-length windows stay distinct', async () => {
    // Claude's weekly windows have the SAME length and the SAME reset. A label computed from
    // `windowMinutes` renders both as "week", and a user cannot tell which bar is the one about to
    // stop them working. The all-models window is also the one whose "(all models)" qualifier is
    // dropped upstream, so "week" and "week (Fable)" are what arrive here.
    renderPanel({
      enabled: true,
      accounts: [
        {
          ...CLAUDE,
          quota: {
            takenAt: new Date().toISOString(),
            windows: [
              { usedPercent: 66, label: 'week', resetsText: 'Aug 20 at 1am (Europe/Warsaw)' },
              { usedPercent: 13, label: 'week (Fable)', resetsText: 'Aug 20 at 1am (Europe/Warsaw)' },
            ],
          },
        },
      ],
    })
    await waitFor(() => expect(bars()).toHaveLength(2))
    const labels = Array.from(document.querySelectorAll<HTMLElement>('[data-slot="quota-window"]')).map(
      (node) => node.dataset.window,
    )
    expect(labels).toEqual(['week', 'week (Fable)'])
    expect(new Set(labels).size).toBe(2)
  })

  it('renders a Claude reset string verbatim, minus the timezone it already applied', async () => {
    renderPanel({
      enabled: true,
      accounts: [
        {
          ...CLAUDE,
          quota: {
            takenAt: new Date().toISOString(),
            windows: [{ usedPercent: 66, label: 'week', resetsText: 'Aug 20 at 1am (Europe/Warsaw)' }],
          },
        },
      ],
    })
    await waitFor(() => expect(bars()).toHaveLength(1))
    expect(screen.getByText('Aug 20 at 1am')).toBeTruthy()
  })

  it('says nothing about a reset the provider did not state', async () => {
    // An idle Claude window is a bare `Current session: 0% used` — no reset clause at all. Passing
    // an absent value through the Codex path renders `new Date(NaN)`, i.e. the literal string
    // "Invalid Date" sitting where a time belongs.
    renderPanel({
      enabled: true,
      accounts: [
        {
          ...CLAUDE,
          quota: { takenAt: new Date().toISOString(), windows: [{ usedPercent: 0, label: 'session' }] },
        },
      ],
    })
    await waitFor(() => expect(bars()).toHaveLength(1))
    const window = document.querySelector<HTMLElement>('[data-slot="quota-window"]')
    expect(window?.textContent).toBe('session0%')
    expect(window?.textContent).not.toContain('Invalid')
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

/**
 * The fill colour, guarded because this bar shipped **invisible** and no test noticed.
 *
 * The fill was `bg-accent` on a `bg-muted` track, and `--accent` is a shadcn alias for `--muted`
 * in `styles/index.css` — a surface token, not the brand accent. Fill and track were the same
 * colour, so 0%, 4% and 66% all rendered as one flat grey line; only the `>= 90` danger branch was
 * ever visible, and no account had been there.
 *
 * **A "fill class ≠ track class" assertion would NOT have caught it** — `bg-accent` and `bg-muted`
 * are different strings that resolve to the same colour, and jsdom loads no stylesheet to tell them
 * apart. So these guard the class against an allowlist of tokens known to be *ink*, which is the
 * only form of the check that has the shipped bug on the wrong side of it.
 */
describe('the fill has to be visible against the track', () => {
  /** The three sanctioned fill tokens. Every other `bg-*` here is a surface. */
  const FILL_TOKENS = ['bg-success', 'bg-pending', 'bg-danger']

  const fillToken = (bar: HTMLElement) =>
    bar.className.split(/\s+/).find((cls) => cls.startsWith('bg-'))

  const withPercent = (usedPercent: number): AccountUsageResponse => ({
    enabled: true,
    accounts: [
      {
        ...CODEX,
        quota: {
          takenAt: new Date().toISOString(),
          windows: [{ usedPercent, windowMinutes: 300, resetsAt: future() }],
        },
      },
    ],
  })

  it('paints a barely-used window in a colour, never in a surface token', async () => {
    // 4% is the case the bug hid behind: a sliver of fill that has to be a different COLOUR from
    // the track, because at that width shape alone tells you nothing. Mutation: revert the fill to
    // `bg-accent` (or any surface token) and this goes red.
    renderPanel(withPercent(4))
    await waitFor(() => expect(bars()).toHaveLength(1))
    expect(FILL_TOKENS).toContain(fillToken(bars()[0]!))
    expect(bars()[0]!.className).not.toContain('bg-accent')
  })

  it('grades the colour by how used the window is', async () => {
    // Below 75 emerald, 75–89 amber, 90+ red — the colour carries the reading, so the bar means
    // something at a glance and not only when measured against its own track. Mutation: collapse
    // the three branches to one token and the distinctness assertion fails.
    const tones: (string | undefined)[] = []
    for (const percent of [40, 80, 95]) {
      renderPanel(withPercent(percent))
      await waitFor(() => expect(bars()).toHaveLength(1))
      tones.push(fillToken(bars()[0]!))
      cleanup()
    }
    expect(tones).toEqual(['bg-success', 'bg-pending', 'bg-danger'])
  })

  it('grades on the clamped width, so an overage is red rather than off the scale', async () => {
    renderPanel(withPercent(104))
    await waitFor(() => expect(bars()).toHaveLength(1))
    expect(fillToken(bars()[0]!)).toBe('bg-danger')
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
