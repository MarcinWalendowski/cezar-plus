import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentProfile } from '@loki-labs/cezar-plus-api-client'
import { agentPickerRows } from './default-agent-picker'
import { ADVISORY_NOTE, RunnerPill, lockDisclosure, parseChoiceValue } from './picker-pill'

/**
 * The two pool surfaces (`.ai/specs/2026-08-16-agent-account-usage-routing.md`, Phase C).
 *
 * Both are tested in one file because their ONLY contract is that they agree: settings and the
 * composer are the same routing question asked twice, and a pool offered in one and not the other
 * is a setting that silently stops applying to half the runs. The spec originally claimed
 * `agentPickerRows()` was shared with the composer — it is not, the composer builds its own list in
 * `RunnerPill`, which is exactly why this needs asserting rather than assuming.
 */

const profile = (provider: 'claude' | 'codex', id: string, isDefault = false): AgentProfile => ({
  id,
  provider,
  label: id,
  configDir: `~/.${provider}-${id}`,
  path: `/home/u/.${provider}-${id}`,
  isDefault,
  exists: true,
  looksValid: true,
  files: [],
})

const TWO_CLAUDE = [profile('claude', 'default', true), profile('claude', 'work')]
const ONE_EACH = [profile('claude', 'default', true), profile('codex', 'default', true)]

const poolValues = (rows: ReturnType<typeof agentPickerRows>) =>
  rows.filter((row) => row.pool).map((row) => row.account)

// Explicit, because this package runs vitest WITHOUT `globals`, so `@testing-library/react` never
// registers its own auto-cleanup: every `render` accumulates in one `document` for the whole file.
// The pill queries are document-wide (`screen.getByRole('button', { name: 'Runner' })`), so the
// second render of a pill in this file is what turns them into "found multiple elements".
afterEach(cleanup)

describe('settings rows — agentPickerRows', () => {
  it('offers no pools at all with the capability off', () => {
    // The flag maintains the dispatch cursor, the limit record and the quota snapshot. Offering a
    // routing mode whose signals nobody records is a control that looks live and is not.
    expect(poolValues(agentPickerRows(TWO_CLAUDE))).toEqual([])
    expect(poolValues(agentPickerRows(ONE_EACH))).toEqual([])
  })

  it('offers a per-agent pool once that agent has two logins', () => {
    expect(poolValues(agentPickerRows(TWO_CLAUDE, { pools: true }))).toContain('pool:claude')
  })

  it('offers no per-agent pool for an agent with one login', () => {
    // A pool of one is the same login with a longer name — and it would make the balancer look
    // like it is doing something on a machine where it cannot.
    expect(poolValues(agentPickerRows(ONE_EACH, { pools: true }))).not.toContain('pool:claude')
    expect(poolValues(agentPickerRows(ONE_EACH, { pools: true }))).not.toContain('pool:codex')
  })

  it('offers the everything pool for one claude + one codex', () => {
    // Counted ACROSS providers: neither has a second login of its own, and it is still a real
    // choice of two accounts. This is the zero-config machine, so it is the case that matters most.
    expect(poolValues(agentPickerRows(ONE_EACH, { pools: true }))).toEqual(['pool:*'])
  })

  it('offers no everything pool when there is only one account on the machine', () => {
    expect(poolValues(agentPickerRows([profile('claude', 'default', true)], { pools: true }))).toEqual([])
  })

  it('keeps the pool row out of the account rows it balances over', () => {
    const claude = agentPickerRows(TWO_CLAUDE, { pools: true }).filter((row) => row.runner.id === 'claude')
    // The accounts are still individually selectable — a pool is an addition, never a replacement.
    expect(claude.filter((row) => !row.pool).map((row) => row.account)).toEqual([null, 'work'])
    // `pool:*` is FILED under the first runner (it has no runner of its own), so it shows up in
    // claude's slice too. Nominal only — it picks the provider at dispatch.
    expect(claude.filter((row) => row.pool).map((row) => row.account)).toEqual(['pool:claude', 'pool:*'])
  })

  it('marks the everything row so the render can gate it on ANY provider', () => {
    const all = agentPickerRows(ONE_EACH, { pools: true }).find((row) => row.account === 'pool:*')
    expect(all?.pool).toBe('all')
  })
})

describe('composer rows — RunnerPill', () => {
  const openMenu = () => fireEvent.pointerDown(screen.getByRole('button', { name: 'Runner' }))
  const accounts = [
    { provider: 'claude' as const, id: 'default', label: 'Default', configDir: '~/.claude' },
    { provider: 'claude' as const, id: 'work', label: 'Work', configDir: '~/.claude-work' },
  ]

  it('offers the same pools the settings rows do', async () => {
    render(
      <RunnerPill runners={['claude']} value="claude" accounts={accounts} pools onPick={() => {}} />,
    )
    openMenu()
    const labels = (await screen.findAllByRole('menuitemradio')).map((item) => item.textContent)
    expect(labels.some((label) => label?.includes('balance'))).toBe(true)
  })

  it('offers none with the capability off', async () => {
    render(<RunnerPill runners={['claude']} value="claude" accounts={accounts} onPick={() => {}} />)
    openMenu()
    const labels = (await screen.findAllByRole('menuitemradio')).map((item) => item.textContent)
    expect(labels.some((label) => label?.includes('balance'))).toBe(false)
  })

  it('hands the caller the WHOLE pool id, colon and all', async () => {
    // THE test in this file. The pill addresses a row as `runner:account`, and a pool id contains
    // its own colon — so a `.split(':')` here yields `picked === 'pool'`, which is neither a pool
    // nor an account. `selectProfile` would degrade that to the discovered login without a word,
    // and every pooled run would quietly land on one account while the pill still read "balance".
    const onPick = vi.fn()
    render(<RunnerPill runners={['claude']} value="claude" accounts={accounts} pools onPick={onPick} />)
    openMenu()
    const balance = (await screen.findAllByRole('menuitemradio')).find((item) =>
      item.textContent?.includes('claude · balance'),
    )
    fireEvent.click(balance!)
    expect(onPick).toHaveBeenCalledWith('claude', 'pool:claude')
  })
})

/**
 * The picker says, in the menu, that it is a preference (`2026-08-23-never-block-a-task.md`).
 *
 * This is the UI half of todo `81ab4ebd` — "the per-task picker is documented as advisory whenever
 * a wildcard pool is configured (and the UI says so)". Recording the decision in the corpus or a
 * docblock satisfies neither half of that: the person who picks codex to dodge a Claude limit is
 * standing in front of this menu, and the disclosure has to be here or it does not reach them.
 */
describe('advisory disclosure — RunnerPill', () => {
  const openMenu = () => fireEvent.pointerDown(screen.getByRole('button', { name: 'Runner' }))
  const accounts = [
    { provider: 'claude' as const, id: 'default', label: 'Default', configDir: '~/.claude' },
    { provider: 'codex' as const, id: 'default', label: 'Default', configDir: '~/.codex' },
  ]

  it('says so inside the menu when the fallback is on', async () => {
    render(
      <RunnerPill runners={['claude', 'codex']} value="claude" accounts={accounts} advisory onPick={() => {}} />,
    )
    openMenu()
    expect(await screen.findByText(ADVISORY_NOTE)).not.toBeNull()
  })

  it('says nothing when the fallback is off — the pick really is a pin then', async () => {
    // The control, and it is the honest half: with the setting off an explicit pick IS a
    // requirement, so a menu that claimed otherwise would be the same lie in the other direction.
    render(
      <RunnerPill runners={['claude', 'codex']} value="claude" accounts={accounts} onPick={() => {}} />,
    )
    openMenu()
    await screen.findAllByRole('menuitemradio')
    expect(screen.queryByText(ADVISORY_NOTE)).toBeNull()
  })

  it('does not swallow a row — the note is a footer, not an option', async () => {
    // It rides `PickerPill`'s `status` slot, which renders a DISABLED menu item. If it ever became
    // a selectable row, picking it would call `onPick` with the note's text as a runner id.
    const onPick = vi.fn()
    render(
      <RunnerPill runners={['claude', 'codex']} value="claude" accounts={accounts} advisory onPick={onPick} />,
    )
    openMenu()
    const rows = await screen.findAllByRole('menuitemradio')
    // Two agents, two selectable rows — the note is not a third.
    expect(rows).toHaveLength(2)
    expect(rows.some((row) => row.textContent?.includes(ADVISORY_NOTE))).toBe(false)
    expect(onPick).not.toHaveBeenCalled()
  })
})

/**
 * The global engine lock, at the pill (`.ai/specs/2026-08-29-global-provider-toggle.md`, D6 / V5d).
 *
 * This is where the six Phase-3 surfaces get their menu behaviour from — the composer, the
 * follow-up composer, "Run on…", the Inbox quick-start, the GitHub hand-off and `EnginePills` all
 * render through `RunnerPill` — so the cases live here once rather than six times, and every
 * locked case is paired with the unlocked control that catches an implementation which simply
 * narrows the menu all the time.
 *
 * The bug this closes is the one the owner reported from production: Codex checked in the
 * composer, Codex on the shell bar, `anthropic/sonnet` in the run. Dispatch now honours the lock;
 * without this half the pill still renders as though the provider were the user's to pick.
 */
describe('engine lock — RunnerPill', () => {
  const openMenu = () => fireEvent.pointerDown(screen.getByRole('button', { name: 'Runner' }))
  const BOTH = ['claude', 'codex'] as const
  const oneEach = [
    { provider: 'claude' as const, id: 'default', label: 'Default', configDir: '~/.claude' },
    { provider: 'codex' as const, id: 'default', label: 'Default', configDir: '~/.codex' },
  ]
  const twoClaude = [
    { provider: 'claude' as const, id: 'default', label: 'Default', configDir: '~/.claude' },
    { provider: 'claude' as const, id: 'work', label: 'Work', configDir: '~/.claude-work' },
  ]

  it('offers the locked provider and no other', async () => {
    render(
      <RunnerPill runners={BOTH} value="claude" accounts={oneEach} lockedTo="codex" onPick={() => {}} />,
    )
    openMenu()
    const rows = await screen.findAllByRole('menuitemradio')
    expect(rows.map((row) => row.textContent)).toEqual([expect.stringContaining('codex')])
  })

  it('offers both, unlocked — the control', async () => {
    // Without this the assertion above passes against a pill that narrowed to one row for every
    // host, which is the same picker breakage in the other direction.
    render(<RunnerPill runners={BOTH} value="claude" accounts={oneEach} onPick={() => {}} />)
    openMenu()
    const rows = await screen.findAllByRole('menuitemradio')
    expect(rows).toHaveLength(2)
  })

  it('shows the locked provider on the pill even when the caller passes a stale value', async () => {
    // Defence in depth for the six call sites. Each resolves the lock itself for its REQUEST; if
    // one forgets, the label must still never name a provider the menu does not contain, because
    // that reads as "codex is selected" while every row says claude.
    render(
      <RunnerPill runners={BOTH} value="claude" accounts={oneEach} lockedTo="codex" onPick={() => {}} />,
    )
    expect(screen.getByRole('button', { name: 'Runner' }).textContent).toContain('codex')
  })

  it('keeps the locked provider\'s own account rows', async () => {
    // D6a: the provider is fixed, the ACCOUNT is not. A lock that collapsed claude's two logins
    // into one row would take away a choice the lock says nothing about.
    render(
      <RunnerPill runners={BOTH} value="claude" accounts={twoClaude} lockedTo="claude" onPick={() => {}} />,
    )
    openMenu()
    const rows = await screen.findAllByRole('menuitemradio')
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Default'),
      expect.stringContaining('Work'),
    ])
  })

  it('offers no foreign-provider account id under a lock', async () => {
    // The D6a case that fails silently: a codex account id sent for a claude run is not a login
    // the server can resolve, and the pool/account ladder has no reason to say so.
    render(
      <RunnerPill
        runners={BOTH}
        value="codex"
        accounts={[...twoClaude, { provider: 'codex' as const, id: 'work', label: 'Codex Work', configDir: '~/.codex-work' }]}
        lockedTo="claude"
        onPick={() => {}}
      />,
    )
    openMenu()
    const rows = await screen.findAllByRole('menuitemradio')
    expect(rows.some((row) => row.textContent?.includes('Codex Work'))).toBe(false)
  })

  it('drops the provider-spanning `balance · everything` row, and keeps the per-agent one', async () => {
    // `pool:*` picks the PROVIDER at dispatch, which is the one thing a lock overrides (D5), so
    // offering it would put a control on screen whose stated meaning the server has replaced.
    // `pool:claude` spreads over the locked provider's own logins and survives untouched.
    render(
      <RunnerPill runners={BOTH} value="claude" accounts={twoClaude} pools lockedTo="claude" onPick={() => {}} />,
    )
    openMenu()
    const labels = (await screen.findAllByRole('menuitemradio')).map((row) => row.textContent)
    expect(labels.some((label) => label?.includes('balance · everything'))).toBe(false)
    expect(labels.some((label) => label?.includes('claude · balance'))).toBe(true)
  })

  it('keeps the everything row unlocked — the control', async () => {
    render(
      <RunnerPill runners={BOTH} value="claude" accounts={twoClaude} pools onPick={() => {}} />,
    )
    openMenu()
    const labels = (await screen.findAllByRole('menuitemradio')).map((row) => row.textContent)
    expect(labels.some((label) => label?.includes('balance · everything'))).toBe(true)
  })

  it('says why, in place of the advisory line', async () => {
    // Both halves in one case on purpose: the lock note appearing is worth nothing if the advisory
    // sentence is still sitting underneath it saying the provider is a preference.
    render(
      <RunnerPill
        runners={BOTH}
        value="claude"
        accounts={oneEach}
        advisory
        lockedTo="codex"
        onPick={() => {}}
      />,
    )
    openMenu()
    expect(await screen.findByText(lockDisclosure('codex'))).not.toBeNull()
    expect(screen.queryByText(ADVISORY_NOTE)).toBeNull()
  })

  it('does not swallow a row — the lock note is a footer, not an option', async () => {
    // Same hazard as the advisory note's own case: a disclosure that renders as a selectable row
    // is a control the user can try to pick, and picking it would call `onPick` with its text.
    const onPick = vi.fn()
    render(
      <RunnerPill runners={BOTH} value="claude" accounts={oneEach} lockedTo="codex" onPick={onPick} />,
    )
    openMenu()
    const rows = await screen.findAllByRole('menuitemradio')
    expect(rows).toHaveLength(1)
    expect(rows.some((row) => row.textContent?.includes(lockDisclosure('codex')))).toBe(false)
    expect(onPick).not.toHaveBeenCalled()
  })

  it('is not a lock at all when the locked provider is not connected', async () => {
    // D3, at the pill: the toggle overrides every SETTING and never AVAILABILITY. `downgradePinned`
    // Runner still moves work off a locked provider whose accounts are all gone, so a menu holding
    // one unrunnable row would be a dead end that also contradicts what dispatch will do.
    render(
      <RunnerPill runners={['claude']} value="claude" accounts={oneEach} advisory lockedTo="codex" onPick={() => {}} />,
    )
    openMenu()
    const rows = await screen.findAllByRole('menuitemradio')
    expect(rows.map((row) => row.textContent)).toEqual([expect.stringContaining('claude')])
    expect(await screen.findByText(ADVISORY_NOTE)).not.toBeNull()
    expect(screen.queryByText(lockDisclosure('codex'))).toBeNull()
  })
})

describe('parseChoiceValue', () => {
  it('splits on the FIRST colon, so a pool id survives', () => {
    expect(parseChoiceValue('claude:pool:claude')).toEqual({ runner: 'claude', account: 'pool:claude' })
    expect(parseChoiceValue('claude:pool:*')).toEqual({ runner: 'claude', account: 'pool:*' })
  })

  it('still reads the ordinary shapes', () => {
    expect(parseChoiceValue('claude')).toEqual({ runner: 'claude', account: null })
    expect(parseChoiceValue('claude:work')).toEqual({ runner: 'claude', account: 'work' })
  })
})
