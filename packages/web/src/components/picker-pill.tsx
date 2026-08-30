import { ChevronDownIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import {
  AGENT_POOL_ALL,
  DEFAULT_AGENT_ACCOUNT_ID,
  agentPoolId,
  type LockableRunner,
  type Runner,
} from '@loki-labs/better-cezar-api-client'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { RUNNERS, effectiveLock } from '@/routes/new-task-form'

/**
 * The composer's single-choice pill, factored out of new-task.tsx (#401) so the follow-up
 * surface reuses the exact same runner/model control — one pill grammar, one place to change it.
 */

/** The mockup's `.chip`: a quiet bordered pill that darkens on hover. */
export const chipClass =
  'inline-flex h-[26px] items-center gap-1.5 rounded-full border border-border bg-card px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-55'

export const chevron = (
  <ChevronDownIcon aria-hidden="true" className="size-2.5 shrink-0 text-soft-foreground" />
)

/** A generic single-choice pill (runner / model / variants): DropdownMenu radio semantics,
 *  two-line items (label + quiet description), disabled state carries its reason as `title`. */
export function PickerPill({
  slot,
  ariaLabel,
  label,
  value,
  options,
  onPick,
  disabled = false,
  readOnly = false,
  hint,
  disabledHint,
  status,
}: {
  slot: string
  ariaLabel: string
  label: ReactNode
  value: string
  options: ReadonlyArray<{ value: string; label: string; desc?: string }>
  onPick: (value: string) => void
  disabled?: boolean
  /** Display the resolved value without presenting a selector. */
  readOnly?: boolean
  /** Hover explanation for the enabled pill — what the setting does (e.g. the ×1 variants pill). */
  hint?: string
  disabledHint?: string
  /** Quiet non-selectable catalog state, kept inside the menu's accessible reading order. */
  status?: string
}) {
  if (readOnly) {
    return (
      <span
        data-slot={slot}
        aria-label={ariaLabel}
        title={disabledHint ?? hint}
        className={`${chipClass} cursor-default hover:bg-card hover:text-muted-foreground`}
      >
        {label}
      </span>
    )
  }
  const trigger = (
    <button
      type="button"
      data-slot={slot}
      aria-label={ariaLabel}
      disabled={disabled}
      title={disabled ? disabledHint : hint}
      className={chipClass}
    >
      {label}
      {chevron}
    </button>
  )
  // Radix never opens a disabled trigger, but `disabled:pointer-events-none` would also kill
  // the explanatory title tooltip — so the disabled pill renders bare, in a plain span wrapper
  // that still receives hover.
  if (disabled) {
    return (
      <span title={disabledHint} className="inline-flex">
        {trigger}
      </span>
    )
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" data-testid={`${slot}-menu`}>
        <DropdownMenuRadioGroup value={value} onValueChange={onPick}>
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value} className="gap-2.5">
              <span className="flex min-w-0 flex-col">
                <span className="text-[12.5px] font-medium">{option.label}</span>
                {option.desc ? (
                  <span className="text-[11.5px] text-muted-foreground">{option.desc}</span>
                ) : null}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {status ? (
          <DropdownMenuItem disabled className="border-t border-border text-[11.5px] text-muted-foreground">
            {status}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * One agent account, as this pill needs to show it (spec 2026-07-29-agent-profiles).
 *
 * `id` is the reserved `default` for the DISCOVERED account — the one `agentHomePaths()` finds —
 * and a stored slug otherwise.
 */
export interface RunnerAccountChoice {
  provider: Runner
  id: string
  label: string
  /** The folder, as written. The labels are cezar's invention; the folder IS the account. */
  configDir: string
}

/**
 * How one row of the pill's menu is addressed: the agent, and which of its logins.
 *
 * The account half may itself contain a colon (`pool:claude`, `pool:*` — see
 * `contract/agent-route.ts`), so this pairing is only safe as long as it is split on the FIRST
 * colon. `parseChoiceValue` is that split, and it exists rather than an inline `.split(':')`
 * precisely because the inline version silently produced `picked === 'pool'` — a value that is
 * neither a pool nor an account, and which `selectProfile` would degrade to the default login
 * without a word.
 */
const choiceValue = (runner: Runner, account: string | null): string =>
  account === null ? runner : `${runner}:${account}`

export function parseChoiceValue(value: string): { runner: Runner; account: string | null } {
  const at = value.indexOf(':')
  if (at === -1) return { runner: value as Runner, account: null }
  return { runner: value.slice(0, at) as Runner, account: value.slice(at + 1) || null }
}

/**
 * The picker is a PREFERENCE, not a pin, and the menu has to say so.
 *
 * **CORRECTED 2026-08-30 (`.ai/specs/2026-08-29-global-provider-toggle.md`, P6): this is now the
 * UNLOCKED half of a pair.** While a global engine lock is set the provider half of this pick is
 * not advisory at all — it is overridden — so the menu renders {@link lockDisclosure} instead and
 * `RunnerPill` offers only the locked provider's rows. Saying "preference, not a pin" under a lock
 * would describe the model and account halves correctly and the provider half backwards, which is
 * the same mis-read todo `81ab4ebd` was filed about, one layer up. The original text follows
 * unchanged; it is what is true whenever `runnerLock` is null, which is the default.
 *
 * Two separate mechanisms make it advisory, and a person reading the pill can see neither:
 * a wildcard pool (`pool:*`) lets the balancer choose the PROVIDER at dispatch, over
 * `input.runner`; and `fallbackAcrossAccountsWhenLimited` — ON by default since spec
 * 2026-08-23-never-block-a-task, and widened by spec 2026-08-25-logged-out-account-fallback to
 * the same rescue when the account is simply logged out rather than out of quota — starts a task
 * on another agent rather than parking it behind a rate limit or refusing on a stale login.
 * Without this line the next person picks codex to dodge a Claude limit, watches it run on Claude
 * anyway, and files it as a bug (todo `81ab4ebd` is exactly that report).
 */
export const ADVISORY_NOTE =
  'Preference, not a pin — a rate-limited or logged-out agent is skipped for the next available one.'

/**
 * What the menu says INSTEAD of {@link ADVISORY_NOTE} while a global engine lock is set
 * (`.ai/specs/2026-08-29-global-provider-toggle.md`, D6/P6).
 *
 * It names all three halves on purpose, because only one of them is taken away: the provider is
 * fixed, the model is untouched, and the account is still the user's pick among THAT provider's
 * logins (D6a). A bare "locked to codex" would read as though the whole pill had gone read-only,
 * which is the reading that makes a person stop looking for the model row that is still there.
 *
 * A function rather than a constant because the provider is the useful half of the sentence — a
 * disclosure that does not say WHICH provider sends the reader back to the shell bar to find out.
 */
export const lockDisclosure = (runner: LockableRunner): string =>
  `Locked to ${runner} by the global engine setting — model and account stay yours to pick.`

/**
 * Which agent — and, when there is more than one login for it, which account — in ONE flat list:
 *
 *     claude · Default
 *     claude · Klaudiusz
 *     codex
 *
 * Not a runner group with an account group nested under it. Every row is a concrete thing that can
 * run this task, so what will happen is readable at a glance instead of assembled from two
 * selections. An agent with a single login stays a single row, which is why a machine with no extra
 * accounts sees exactly the list it always saw.
 *
 * The pill renders for a CHOICE: more than one runner, or more than one account for one runner. A
 * host with one agent and one login has neither, and the caller leaves it out.
 *
 * Three wire states, and the difference between the first two matters:
 *   - `account === null` — follow the repo's setting. What an untouched pill means, and it stays
 *     true if that setting changes before the task starts.
 *   - `'default'` — the discovered account, EXPLICITLY. Beats the repo setting server-side
 *     (`selectProfile`), which is what makes "claude · Default" mean it in a repo set to another
 *     account.
 *   - a stored id — that account.
 */
export function RunnerPill({
  runners,
  value,
  onPick,
  disabled = false,
  accounts = [],
  account = null,
  repoAccount,
  pools = false,
  advisory = false,
  lockedTo = null,
}: {
  runners: readonly Runner[]
  value: Runner
  /** `account` is `null` only while the repo's own choice is still the one in force. */
  onPick: (runner: Runner, account: string | null) => void
  disabled?: boolean
  /** Every login for every runner, discovered accounts included. Empty = the zero-config host. */
  accounts?: readonly RunnerAccountChoice[]
  /** The per-task override. */
  account?: string | null
  /** What the repo's setting resolves to per runner — the row that is selected until overridden. */
  repoAccount?: Partial<Record<Runner, string>>
  /** The `accountUsage` capability: offer the balancing pools too (spec 2026-08-16, Phase C). Off,
   *  the menu is byte-identical to before pools existed. */
  pools?: boolean
  /**
   * Say, inside the menu, that this pick is a PREFERENCE rather than a guarantee — see
   * `ADVISORY_NOTE`. On when `resources.fallbackAcrossAccountsWhenLimited` is on, which is the
   * default since spec 2026-08-23-never-block-a-task and, since spec
   * 2026-08-25-logged-out-account-fallback, also covers rerouting off a logged-out account, not
   * only a rate-limited one.
   */
  advisory?: boolean
  /**
   * The global engine lock (`.ai/specs/2026-08-29-global-provider-toggle.md`, D6). `null` — Auto —
   * is byte-for-byte the menu that existed before the lock did.
   *
   * Set, the pill is **displayed and fixed**: the provider rows narrow to this one, the
   * provider-spanning `balance · everything` row goes away, and the footer says why. Deliberately
   * NOT `disabled`: a disabled pill hides the reason behind a tooltip and takes the model and
   * account rows away with it, and those two are still the user's to pick (D6a).
   */
  lockedTo?: LockableRunner | null
}) {
  // A lock this host cannot honour is not a lock. `.ai/specs/2026-08-29-global-provider-toggle.md`
  // D3: the toggle overrides every SETTING, never AVAILABILITY — so when the locked provider is
  // not among the connected runners, the menu renders free, which is what will actually happen.
  // Rendering one unpickable row for a provider that cannot run would be a dead end with no exit.
  const lock = effectiveLock(lockedTo, runners)
  // Every read of the pill's own `value` below goes through this instead, so a caller that has not
  // yet resolved the lock still cannot render a label naming a provider the menu does not offer.
  // The caller's own resolution is what governs the REQUEST; this governs what is on the screen.
  const shown = lock ?? value
  const available = RUNNERS.filter((r) => (lock ? r.id === lock : runners.includes(r.id)))
  const options = available.flatMap((runner) => {
    const logins = accounts.filter((entry) => entry.provider === runner.id)
    // One login is not a choice, so it does not become a row of its own — the agent is the row.
    if (logins.length < 2) return [{ value: choiceValue(runner.id, null), label: runner.id, desc: runner.desc }]
    const rows = logins.map((login) => ({
      value: choiceValue(runner.id, login.id),
      label: `${runner.id} · ${login.label}`,
      // The folder, because the label is cezar's invention and the folder is the account.
      desc: login.configDir,
    }))
    // A pool of one is the same login with a longer name, so this needs the same ≥2 that made the
    // per-login rows appear at all.
    if (!pools) return rows
    return [
      ...rows,
      {
        value: choiceValue(runner.id, agentPoolId(runner.id)),
        label: `${runner.id} · balance`,
        desc: `spread over this agent's ${logins.length} logins, skipping rate-limited ones`,
      },
    ]
  })
  // "Everything" spans runners, so it is filed under the CURRENT one: the pill's value is a
  // `runner:account` pair and there is no runner-less spelling. Harmless because `pool:*` picks the
  // provider at dispatch — `taskBackend` takes the balancer's answer over `input.runner`. Needs two
  // accounts to spread over, counted across providers, so one claude + one codex qualifies.
  // Dropped under a lock: it is the one row that spans providers, and D5 narrows it to the locked
  // provider's own accounts at dispatch — so offering it would put a control on the screen whose
  // stated meaning ("all N accounts") the server has already overridden.
  if (pools && accounts.length > 1 && !lock) {
    options.push({
      value: choiceValue(shown, AGENT_POOL_ALL),
      label: 'balance · everything',
      desc: `spread over all ${accounts.length} accounts, skipping rate-limited ones`,
    })
  }

  // What is selected right now: the override if the user made one, else whatever the repo resolves
  // to, else the discovered account. Falls back to the plain runner row for an agent with one login
  // — and for an override naming an account that has since been deleted, which must not leave the
  // pill pointing at nothing.
  const selected = account ?? repoAccount?.[shown] ?? DEFAULT_AGENT_ACCOUNT_ID
  const value_ = options.some((option) => option.value === choiceValue(shown, selected))
    ? choiceValue(shown, selected)
    : choiceValue(shown, null)

  return (
    <PickerPill
      slot="runner-pill"
      ariaLabel="Runner"
      label={options.find((option) => option.value === value_)?.label ?? shown}
      value={value_}
      disabled={disabled}
      onPick={(next) => {
        const { runner, account: picked } = parseChoiceValue(next)
        onPick(runner, picked)
      }}
      options={options}
      // The lock beats the advisory line rather than joining it: under a lock the provider half is
      // not a preference at all, and two notes in one footer would leave the reader to work out
      // which sentence governs which half of the pick.
      status={lock ? lockDisclosure(lock) : advisory ? ADVISORY_NOTE : undefined}
    />
  )
}
