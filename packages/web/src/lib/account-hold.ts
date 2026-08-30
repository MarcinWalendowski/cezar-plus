import { runAccountKey, usageHoldAccountKey, type Runner, type RunRecord } from '@loki-labs/cezar-plus-api-client'

/**
 * Why a queued task is not starting (spec `2026-08-23-usage-limit-hold-account.md`).
 *
 * The engine refuses to start a task whose agent account is waiting out a provider usage limit.
 * That refusal is correct and deliberate, and until now it was also **silent**: the row said
 * `queued`, `#1 in queue` said it was next, and nothing anywhere said it would not move for
 * eleven hours. A person watching an idle cockpit with a free slot reads that as a broken queue,
 * which is exactly what happened on 2026-08-23 and what filed this spec.
 *
 * The keys are the engine's own (`@loki-labs/cezar-plus-contract`), not a second spelling. A
 * hold rendered from a differently-spelled key would simply never match, and would report "not
 * held" for a task the engine is holding — a wrong answer that looks like a right one.
 */

/** One account the workspace is waiting on, and the soonest moment it reopens. */
export interface AccountHoldRow {
  /** `provider:account`, the engine's `accountUsageKey`. */
  account: string
  /** Epoch ms of the earliest scheduled resume on this account. */
  until: number
  /** The run whose limit closed it — what a person clicks through to. */
  runId: string
}

/**
 * Which accounts are held right now, by account key.
 *
 * Mirrors the engine's `deadline` hold only (`RunManager.accountHolds`): a `failed` run carrying a
 * future `autoResumeAt`. The engine's second kind, `inFlight`, is deliberately not rendered — it
 * lasts as long as one resume turn and has no instant to show, so a row wearing it would flicker.
 *
 * Archived runs are excluded, matching `cancelAutoResume` semantics: archiving a task IS resigning
 * from it, and the engine drops its schedule.
 *
 * **Scoped to the runs it is given, while the engine's hold is workspace-wide.** Fed the
 * single-project list, it cannot see a limit that another project's run is holding, and that row
 * stays silent rather than wrong. The workspace board feeds it the whole aggregate, which is where
 * the cross-project answer is complete.
 */
export function usageLimitHolds(runs: readonly RunRecord[], now: number = Date.now()): Map<string, AccountHoldRow> {
  const holds = new Map<string, AccountHoldRow>()
  for (const run of runs) {
    if (run.archived || run.status !== 'failed' || !run.autoResumeAt) continue
    const until = Date.parse(run.autoResumeAt)
    if (!Number.isFinite(until) || until <= now) continue
    const account = usageHoldAccountKey(run, run.runner ?? 'claude')
    const existing = holds.get(account)
    if (!existing || until < existing.until) holds.set(account, { account, until, runId: run.id })
  }
  return holds
}

/**
 * The hold a queued run is sitting behind, sized for a status pill — or undefined when it is
 * queued for any of the ordinary reasons (a full slot cap, a repo lease, its turn).
 *
 * **Undefined when the run names no runner and the workspace default is unknown.** The account a
 * run will take is `runner` + `agentProfile`, and a run created without an explicit pick carries
 * no `runner` until the engine stamps one. Guessing `claude` there would print a confident
 * sentence about an account this task may never touch, so the row says nothing instead: silence is
 * recoverable, a wrong explanation is not.
 *
 * **Also undefined for a run dispatched through an account POOL**, which is the case the reporting
 * run was. A `pool:` route picks the PROVIDER as well as the login, and it resolves server-side at
 * dispatch (with a cursor side effect, so it cannot be re-asked here or anywhere else). The record
 * therefore says `codex` while the work goes to a claude account, and this function has no honest
 * way to know. The run's transcript names the account outright — that is the surface that answers
 * for a pooled run, and it is the one a person opens from the row.
 */
export function queueHold(
  run: Pick<RunRecord, 'status' | 'archived' | 'runner' | 'agentProfile'>,
  holds: ReadonlyMap<string, AccountHoldRow>,
  defaultRunner?: Runner,
  now: Date = new Date(),
): { label: string; title: string } | undefined {
  if (run.status !== 'queued' || run.archived) return undefined
  const runner = run.runner ?? defaultRunner
  if (!runner) return undefined
  const hold = holds.get(runAccountKey({ runner, agentProfile: run.agentProfile }, runner))
  if (!hold || hold.until <= now.getTime()) return undefined
  const at = new Date(hold.until)
  const sameDay = at.toDateString() === now.toDateString()
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(at)
  return {
    label: sameDay
      ? time
      : `${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(at)} ${time}`,
    title:
      `Held: the ${hold.account} agent account is waiting out a provider usage limit until ` +
      `${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'long' }).format(at)}. ` +
      `Nothing new starts on that account until then.`,
  }
}
