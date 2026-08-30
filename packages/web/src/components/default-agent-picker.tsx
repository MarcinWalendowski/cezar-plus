import type { AgentProfile, ProviderStatusResponse, Runner } from '@loki-labs/cezar-plus-api-client'
import { AGENT_POOL_ALL, agentPoolId } from '@loki-labs/cezar-plus-api-client'
import { cn } from '@/lib/utils'
import { providerStatusFor } from '@/lib/provider-status'
import { RUNNERS } from '@/routes/new-task-form'

/**
 * "Which agent, and which of its logins" as ONE flat list (spec 2026-07-29-agent-profiles), plus
 * the pools that balance across them (spec 2026-08-16-agent-account-usage-routing, Phase C):
 *
 *     claude · Default
 *     claude · Klaudiusz
 *     claude · Balance across claude      ← pool, with CEZ_ACCOUNT_USAGE=1
 *     codex
 *     Balance across everything           ← pool, with CEZ_ACCOUNT_USAGE=1
 *
 * The same shape the composer's runner pill uses, and shared by BOTH settings scopes — the repo's
 * default and the machine-wide one are the same question asked about a different subject, so they
 * must not drift into two controls that look alike but behave differently.
 *
 * An agent with a single login stays a single row, which is why a machine with no extra accounts
 * sees exactly the segmented control it always saw.
 *
 * **Pools are rows here rather than a second control.** This function is the one builder all three
 * surfaces share, so a row added here reaches the composer and both settings scopes at once — and
 * more to the point, a pool cannot end up *selectable in one place and not another*, which is how a
 * routing choice quietly stops applying to half the runs.
 *
 * **A pool travels in the `account` slot** (`pool:claude`, `pool:*`) rather than a new field, for
 * the reason `contract/agent-route.ts` gives at length: the account id already flows through every
 * store, route and prop on this path, and a parallel field would have to be threaded through all of
 * them — with each consumer that missed it silently continuing to route to one login.
 */

export interface AgentPickerRow {
  runner: (typeof RUNNERS)[number]
  /** `null` is the discovered account — stored as absence, never the reserved `default` id.
   *  A `pool:` value is a route, not an account; see `contract/agent-route.ts`. */
  account: string | null
  label: string
  desc: string
  missing: boolean
  /** Pool rows only: `provider` balances this agent's logins, `all` balances every agent's.
   *  Absent on an ordinary account row — which is what lets the render gate an `all` row on ANY
   *  provider being connected rather than on its nominal runner's. */
  pool?: 'provider' | 'all'
}

/**
 * Build the rows once, so the caller's `checked` logic and the render agree by construction.
 *
 * `pools` is the `accountUsage` capability. Off, this returns byte-identical rows to before pools
 * existed — deliberately, because the balancer's inputs (dispatch cursor, limits, quota) are only
 * maintained while that flag is on, and offering a routing mode whose signals nobody is recording
 * would be a control that looks live and is not.
 */
export function agentPickerRows(
  profiles: readonly AgentProfile[],
  options: { pools?: boolean } = {},
): AgentPickerRow[] {
  const rows = RUNNERS.flatMap((runner) => {
    const logins = profiles.filter((p) => p.provider === runner.id)
    // One login is not a choice, so the agent is the row.
    if (logins.length < 2) {
      return [{ runner, account: null, label: runner.label, desc: runner.desc, missing: false }]
    }
    const accounts: AgentPickerRow[] = logins.map((login) => ({
      runner,
      account: login.isDefault ? null : login.id,
      label: `${runner.label} · ${login.label}`,
      // The folder, because the labels are cezar's invention and the folder is the account. A
      // folder the CLI has not written yet is called out rather than left looking fine: a run under
      // it fails on auth BY DESIGN — it must not quietly fall back to another login — so the place
      // to say so is where the choice is made.
      desc: login.exists ? login.configDir : `${login.configDir} — folder not created yet`,
      missing: !login.exists,
    }))
    // A pool of one is not a pool — it is the same login with a longer name, and it would make the
    // balancer look like it is doing something on a machine where it cannot.
    if (!options.pools) return accounts
    return [
      ...accounts,
      {
        runner,
        account: agentPoolId(runner.id),
        label: `${runner.label} · Balance across ${runner.label}`,
        desc: `spreads runs over this agent's ${logins.length} logins, skipping any that are rate limited`,
        missing: false,
        pool: 'provider' as const,
      },
    ]
  })

  // "Everything" needs at least two accounts to spread over, counted ACROSS providers — two
  // discovered logins (one claude, one codex) is a real choice even though neither provider has a
  // second account of its own, and it is the case that makes this row worth having on a
  // zero-config machine.
  if (!options.pools || profiles.length < 2) return rows
  return [
    ...rows,
    {
      // Nominal only: `pool:*` picks the provider at dispatch, so this is the runner the choice is
      // FILED under, not the one it runs on. The render gates this row on any provider being
      // connected — see `providerConnected` — because filing it under claude must not make it
      // unavailable on a machine where only codex is signed in.
      runner: RUNNERS[0]!,
      account: AGENT_POOL_ALL,
      label: 'Balance across everything',
      desc: `spreads runs over all ${profiles.length} accounts, skipping any that are rate limited`,
      missing: false,
      pool: 'all' as const,
    },
  ]
}

/** True once any agent has a second login — what turns the strip into a stacked list. */
export const hasAgentAccounts = (rows: readonly AgentPickerRow[]): boolean =>
  rows.length > RUNNERS.length

export function DefaultAgentPicker({
  rows,
  runner,
  accountFor,
  providerStatus,
  disabled = false,
  accountDisabled = false,
  onPick,
}: {
  rows: readonly AgentPickerRow[]
  runner: Runner
  /** The account currently in force for a runner, or null for the discovered one. */
  accountFor: (runner: Runner) => string | null
  providerStatus: {
    data?: ProviderStatusResponse
    isPending: boolean
    isError: boolean
  }
  disabled?: boolean
  /** Account rows only: the write target is not known yet (e.g. the project registry is loading). */
  accountDisabled?: boolean
  onPick: (runner: Runner, account: string | null, hasAccountChoice: boolean) => void
}) {
  const stacked = hasAgentAccounts(rows)
  return (
    <div
      role="radiogroup"
      aria-label="Default runner"
      data-slot="agents-runner"
      className={cn(
        'gap-0.5 rounded-md border border-border bg-card p-0.5',
        // Stacked once accounts are in play: `claude · Klaudiusz` beside its folder does not fit a
        // segmented strip, and the folder is the part that says WHICH login this is.
        stacked ? 'flex max-w-md flex-col' : 'inline-flex w-fit',
      )}
    >
      {rows.map((row) => {
        const provider = providerStatusFor(providerStatus.data, row.runner.id)
        const answered = !providerStatus.isPending && !providerStatus.isError
        const connectedFor = (id: Runner) => {
          const status = providerStatusFor(providerStatus.data, id)
          return status?.enabled === true && status.status === 'connected'
        }
        // "Balance across everything" is filed under one runner and runs on whichever the balancer
        // picks, so its gate is ANY connected provider. Gating it on its nominal runner would hide
        // the workspace-wide pool on a machine signed into codex and not claude — the setup it is
        // most useful on.
        const providerConnected =
          answered && (row.pool === 'all' ? RUNNERS.some((r) => connectedFor(r.id)) : connectedFor(row.runner.id))
        const providerReason = providerStatus.isPending
          ? 'Checking provider authentication…'
          : providerStatus.isError
            ? 'Provider authentication could not be verified.'
            : row.pool === 'all'
              ? providerConnected
                ? undefined
                : 'Connect at least one provider before selecting this.'
            : provider?.enabled === false
              ? 'This provider is disabled. Enable it above or choose another provider.'
            : providerConnected
              ? undefined
              : 'Connect this provider before selecting it.'
        const hasAccountChoice = rows.filter((other) => other.runner.id === row.runner.id).length > 1
        const checked = row.runner.id === runner && row.account === accountFor(row.runner.id)
        return (
          <button
            key={`${row.runner.id}:${row.account ?? ''}`}
            type="button"
            role="radio"
            aria-checked={checked}
            data-value={row.runner.id}
            data-account={row.account ?? ''}
            title={providerReason ?? row.desc}
            disabled={
              disabled || !providerConnected || (hasAccountChoice && accountDisabled)
            }
            onClick={() => onPick(row.runner.id, row.account, hasAccountChoice)}
            className={cn(
              'rounded-sm px-3 py-1.5 text-left font-mono text-[13px] font-medium transition-colors disabled:opacity-50',
              checked ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {row.label}
            {stacked ? (
              <span
                data-slot={row.missing ? 'agents-account-missing' : 'agents-account-dir'}
                data-runner={row.runner.id}
                className="ml-2 font-sans text-[11.5px] text-soft-foreground"
              >
                {row.desc}
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
