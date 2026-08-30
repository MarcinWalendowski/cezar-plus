import type { AccountQuota, AccountQuotaWindow, AccountUsageRow } from '@loki-labs/cezar-plus-api-client'
import { useAccountUsage } from '@/api/queries'
import { cn } from '@/lib/utils'

/**
 * The sidebar's per-account panel (`.ai/specs/2026-08-16-agent-account-usage-routing.md`, windows
 * for Claude added by `2026-08-16-claude-usage-windows.md`).
 *
 * ## One rule, and it is the reason this file is worth reading
 *
 * **A quota bar renders only where the provider actually reported allowance**, and it renders only
 * what that provider said. Codex states a window length and an epoch reset; Claude states a name
 * and a human reset string, and omits the reset entirely on a window sitting at 0%. Neither gets
 * the other's fields filled in.
 *
 * The temptation this resists is drawing *something* for symmetry, from the token spend cezar
 * already measures. Spend is not allowance. A bar built from it would sit beside a real one, look
 * identical, and mean something completely different — and it is the number a user would act on.
 * Two rows that look alike must mean alike.
 *
 * The server enforces the same rule (`quota` is optional and never synthesized); this is the
 * second half, because a client is free to render a missing value as zero and that is exactly the
 * mistake.
 *
 * **CORRECTED 2026-08-16.** This block used to say the rule meant "Codex and only Codex … there is
 * no other subcommand, and nothing on disk". `claude -p "/usage" --output-format json` reports the
 * windows for 0 tokens, so Claude rows now draw bars too. The rule is unchanged; only its
 * consequence was wrong.
 */

/** Windows come back in the provider's order (primary first). "5h" reads better than "300m". */
function minutesLabel(minutes: number): string {
  if (minutes % (60 * 24) === 0) {
    const days = minutes / (60 * 24)
    return days === 7 ? 'week' : days === 30 ? 'month' : `${days}d`
  }
  if (minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
}

/**
 * The provider's own name for the window wins over a length derived from minutes.
 *
 * Not cosmetic: Claude's two weekly windows ("week", "week (Fable)") have the SAME length, so a
 * label computed from `windowMinutes` would render them identically and a user could not tell
 * which bar is the one about to stop them working.
 */
function windowLabel(window: AccountQuotaWindow): string {
  if (window.label) return window.label
  return window.windowMinutes === undefined ? '' : minutesLabel(window.windowMinutes)
}

/**
 * When the window refills, in whatever form its provider stated it.
 *
 * `resetsAt` is UNIX seconds and is shown as a clock time, because "resets 15:22" is actionable and
 * "resets in 2h" goes stale between renders of a polled panel. `resetsText` is already a clock time
 * in the user's own zone — the CLI rendered it there — so it is passed through untouched rather
 * than re-parsed into a date this code would have to guess the year of.
 */
function resetLabel(window: AccountQuotaWindow): string {
  if (window.resetsAt !== undefined) {
    return new Date(window.resetsAt * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  // Claude's string is "Aug 20 at 1am (Europe/Warsaw)" — the zone is the viewer's own, and in a
  // column this narrow it is the one part that carries no information.
  return window.resetsText?.replace(/\s*\([^)]*\)\s*$/, '') ?? ''
}

/**
 * The fill colour, graded so the COLOUR carries the reading and not only the width.
 *
 * **This function exists because the bar shipped invisible.** The fill was `bg-accent` against a
 * `bg-muted` track, and `--accent` in this codebase is a shadcn alias for `--muted` (a surface
 * token, not the brand accent — that is `--primary`). Fill and track were literally the same
 * colour, so every bar below 90% painted nothing onto an identical strip and 0%, 4% and 66% all
 * rendered as one flat grey line. Only the `>= 90` branch was ever visible, and no account had
 * been there, so the bug had no witness.
 *
 * Every token here is a sanctioned FILL token. `--pending` is amber-400 and the design guardian
 * bans `text-pending` for contrast reasons that do not apply to a fill; `bg-pending` is the
 * spelling that rule leaves open, so no raw hex is introduced.
 */
function fillTone(percent: number): string {
  if (percent >= 90) return 'bg-danger'
  if (percent >= 75) return 'bg-pending'
  return 'bg-success'
}

/** Shared with the Logins cards in Settings, so the two surfaces cannot drift into showing the
 *  same account's allowance two different ways. */
export function QuotaBars({ quota }: { quota: AccountQuota }) {
  return (
    <div data-slot="account-quota" className="mt-1 flex flex-col gap-1">
      {quota.windows.map((window, index) => {
        // Clamped for the BAR only — a provider may legitimately report an overage, and the
        // number beside it still says 104%. Clamping the text would hide the fact.
        const width = Math.max(0, Math.min(100, window.usedPercent))
        const reset = resetLabel(window)
        return (
          <div
            // Index-keyed on purpose: neither provider offers a stable per-window id, and the two
            // candidate keys both collide — Claude's weekly windows share a length AND a reset.
            key={`${windowLabel(window)}:${index}`}
            data-slot="quota-window"
            data-window={windowLabel(window)}
            className="flex items-center gap-1.5"
          >
            {/* Titled because it truncates: the sidebar cannot spare the ~80px "week (Fable)" needs
                without squeezing the bar itself down to a stub, and "week (Fa…" is exactly the part
                that identifies WHICH per-model window this is. */}
            <span className="w-16 shrink-0 truncate text-[10px] text-soft-foreground" title={windowLabel(window)}>
              {windowLabel(window)}
            </span>
            {/* h-1.5, not h-1: the track has no border, so its only way to read as a groove is to
                be tall enough for the fill inside it to have a shape. */}
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <span
                data-slot="quota-fill"
                data-percent={window.usedPercent}
                className={cn('block h-full rounded-full', fillTone(width))}
                style={{ width: `${width}%` }}
              />
            </span>
            <span className="shrink-0 tabular-nums text-[10px] text-soft-foreground">
              {Math.round(window.usedPercent)}%
            </span>
            {/* Absent on an idle Claude window, which states no reset at all. An empty node rather
                than a placeholder: "—" would read as a reset time that failed to load. */}
            {reset ? <span className="shrink-0 text-[10px] text-soft-foreground">{reset}</span> : null}
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
