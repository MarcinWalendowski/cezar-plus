import type { AccountQuota, AccountUsageRow } from '@loki-labs/better-cezar-api-client'
import { useAccountUsage } from '@/api/queries'
import { cn } from '@/lib/utils'

/**
 * The sidebar's per-account panel (`.ai/specs/2026-08-16-agent-account-usage-routing.md`).
 *
 * ## One rule, and it is the reason this file is worth reading
 *
 * **A quota bar renders only where the provider actually reported allowance.** Today that means
 * Codex and only Codex: `claude auth status --json` answers identity and a plan NAME
 * (`subscriptionType`) with no quantity anywhere, there is no other subcommand, and nothing on
 * disk. So a Claude row shows its plan, its in-flight count and whether it is limited — and
 * nothing shaped like a gauge.
 *
 * The temptation this resists is drawing *something* on the Claude rows for symmetry, from the
 * token spend cezar already measures. Spend is not allowance. A bar built from it would sit beside
 * the Codex bar, look identical, and mean something completely different — and it is the number a
 * user would act on. Two rows that look alike must mean alike.
 *
 * The server enforces the same rule (`quota` is optional and never synthesized); this is the
 * second half, because a client is free to render a missing value as zero and that is exactly the
 * mistake.
 */

/** Windows come back in the provider's order (primary first). "5h" reads better than "300m". */
function windowLabel(minutes: number): string {
  if (minutes % (60 * 24) === 0) {
    const days = minutes / (60 * 24)
    return days === 7 ? 'week' : days === 30 ? 'month' : `${days}d`
  }
  if (minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
}

/** `resetsAt` is UNIX seconds. Shown as a clock time, because "resets 15:22" is actionable and
 *  "resets in 2h" goes stale between renders of a polled panel. */
function resetLabel(resetsAt: number): string {
  return new Date(resetsAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function QuotaBars({ quota }: { quota: AccountQuota }) {
  return (
    <div data-slot="account-quota" className="mt-1 flex flex-col gap-1">
      {quota.windows.map((window) => {
        // Clamped for the BAR only — a provider may legitimately report an overage, and the
        // number beside it still says 104%. Clamping the text would hide the fact.
        const width = Math.max(0, Math.min(100, window.usedPercent))
        return (
          <div key={`${window.windowMinutes}:${window.resetsAt}`} className="flex items-center gap-1.5">
            <span className="w-8 shrink-0 text-[10px] text-soft-foreground">
              {windowLabel(window.windowMinutes)}
            </span>
            <span className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
              <span
                data-slot="quota-fill"
                data-percent={window.usedPercent}
                className={cn('block h-full rounded-full', width >= 90 ? 'bg-danger' : 'bg-accent')}
                style={{ width: `${width}%` }}
              />
            </span>
            <span className="shrink-0 tabular-nums text-[10px] text-soft-foreground">
              {Math.round(window.usedPercent)}%
            </span>
            <span className="shrink-0 text-[10px] text-soft-foreground">{resetLabel(window.resetsAt)}</span>
          </div>
        )
      })}
    </div>
  )
}

/** The one line of status a row gets when it has no quota to show. Order is by urgency. */
function statusText(account: AccountUsageRow): string {
  if (account.limited) {
    return account.limitedUntil
      ? `limited until ${new Date(account.limitedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : 'limited'
  }
  // `signedIn === undefined` means cezar could not ask — deliberately NOT rendered as signed out,
  // which would put a red state on a login that works fine.
  if (account.signedIn === false) return 'signed out'
  if (account.plan) return account.plan
  return ''
}

/**
 * Mounted ONLY when the `accountUsage` capability is on (see `app-shell.tsx`). The gate lives at
 * the mount site rather than in a prop here, so there is exactly one mechanism: a prop would have
 * meant this component still ran its hook — which both costs a poll the cockpit will not render
 * and forces a `QueryClientProvider` on the presentational shell, whose whole contract is that it
 * renders standalone.
 */
export function AccountUsagePanel() {
  const usage = useAccountUsage()
  const accounts = usage.data?.accounts ?? []
  // Nothing to say: the flag is off, the request has not landed, or this machine has no accounts
  // worth a panel. One login per provider is the zero-config state and is not news.
  if (!usage.data?.enabled || accounts.length === 0) return null

  return (
    <div
      data-slot="account-usage-panel"
      className="flex shrink-0 flex-col gap-1 border-t border-border px-2 py-1.5"
    >
      <p className="px-1 text-[10px] font-medium uppercase tracking-wide text-soft-foreground">Accounts</p>
      {accounts.map((account) => {
        const status = statusText(account)
        return (
          <div
            key={account.id}
            data-slot="account-usage-row"
            data-account={account.id}
            data-limited={account.limited ? 'true' : undefined}
            className="rounded-md px-1 py-1"
          >
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                {account.provider} · {account.label}
              </span>
              {account.inflight > 0 ? (
                <span
                  data-slot="account-inflight"
                  className="shrink-0 rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground"
                >
                  {account.inflight}
                </span>
              ) : null}
            </div>
            {status ? (
              <p
                data-slot="account-status"
                className={cn('truncate text-[10px]', account.limited ? 'text-danger' : 'text-soft-foreground')}
              >
                {status}
              </p>
            ) : null}
            {/* The rule, in one line: no quota, no bar. Never a zero-width bar, never a bar built
                from spend. A row whose provider says nothing about allowance says nothing. */}
            {account.quota ? <QuotaBars quota={account.quota} /> : null}
          </div>
        )
      })}
    </div>
  )
}
