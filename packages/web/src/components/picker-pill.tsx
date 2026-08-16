import { ChevronDownIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import {
  AGENT_POOL_ALL,
  DEFAULT_AGENT_ACCOUNT_ID,
  agentPoolId,
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
import { RUNNERS } from '@/routes/new-task-form'

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
}) {
  const available = RUNNERS.filter((r) => runners.includes(r.id))
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
  if (pools && accounts.length > 1) {
    options.push({
      value: choiceValue(value, AGENT_POOL_ALL),
      label: 'balance · everything',
      desc: `spread over all ${accounts.length} accounts, skipping rate-limited ones`,
    })
  }

  // What is selected right now: the override if the user made one, else whatever the repo resolves
  // to, else the discovered account. Falls back to the plain runner row for an agent with one login
  // — and for an override naming an account that has since been deleted, which must not leave the
  // pill pointing at nothing.
  const selected = account ?? repoAccount?.[value] ?? DEFAULT_AGENT_ACCOUNT_ID
  const value_ = options.some((option) => option.value === choiceValue(value, selected))
    ? choiceValue(value, selected)
    : choiceValue(value, null)

  return (
    <PickerPill
      slot="runner-pill"
      ariaLabel="Runner"
      label={options.find((option) => option.value === value_)?.label ?? value}
      value={value_}
      disabled={disabled}
      onPick={(next) => {
        const { runner, account: picked } = parseChoiceValue(next)
        onPick(runner, picked)
      }}
      options={options}
    />
  )
}
