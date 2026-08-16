import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { DEFAULT_AGENT_ACCOUNT_ID } from '@loki-labs/better-cezar-contract';
import type { ProviderId } from '../core/provider-auth.ts';
import { agentAccountUsagePath } from '../paths.ts';
import { atomicWriteJsonSync } from './config.ts';

/**
 * `~/.cezar/agent-account-usage.json` — what each agent account is doing, and how close it is to
 * its limit (spec `2026-08-16-agent-account-usage-routing.md`).
 *
 * ## The one rule this file exists to keep
 *
 * **Three different kinds of number live here, and they must never be averaged, summed, or
 * rendered alike.** `quota` is a fact a provider stated about remaining allowance. `dispatch` is a
 * count cezar kept. `limited` is an observation about a failure. A percentage invented from
 * tokens-we-spent would be the most believable wrong number in the cockpit, because it would look
 * exactly like a provider-stated one sitting next to it.
 *
 * **CORRECTED 2026-08-16 by `2026-08-16-claude-usage-windows.md`: the sentence that used to sit
 * here — "Only Codex reports the first … so a Claude account legitimately has NO quota" — was
 * false.** It was measured, but only across `claude auth status --json` and the files under
 * `~/.claude`; `claude -p "/usage" --output-format json` returns the same subscription windows
 * Claude Code's own `/usage` screen shows, for 0 tokens, and both providers now report a quota.
 * What survives is the rule the sentence was serving: a quota is present ONLY where a provider
 * stated one, and absence is rendered as absence.
 *
 * That is why `quota` is a separate optional field rather than a normalized "usage" number every
 * provider gets: the type makes the absence expressible, so a consumer has to decide what to do
 * about it instead of receiving a default that lies.
 *
 * ## House rules (copied from `agent-accounts.ts`, for the same reasons)
 *
 * every field optional/defaulted with `.catch`; `.passthrough()` at every level so a NEWER cezar's
 * keys survive an older one; per-entry salvage so one bad row never evicts the rest; atomic
 * tmp+rename at `0600`; a corrupt file degrades to empty with one warning, never a boot failure.
 *
 * ## What is NOT here
 *
 * **In-flight run counts.** They are derived from the run index at read time (`countInflight`), and
 * that is a correctness decision rather than a size one: a count persisted here would be
 * incremented at dispatch and decremented at completion, so every crash, SIGKILL and power cut
 * leaks a permanent phantom run. The account would then look busy forever and the balancer would
 * route away from it for good. A derived count is wrong for as long as it takes to re-read, which
 * is never.
 */

/** How long a quota snapshot stands before the UI must stop drawing it as current.
 *
 *  Five minutes against a 5-hour window is ~1.7% of the window, so the bar is never off by much —
 *  and an ABSENT bar is the honest failure, which is why staleness drops it rather than dimming it.
 *  A dimmed-but-present bar is still read as "this is my usage". */
export const QUOTA_STALE_AFTER_MS = 5 * 60_000;

/**
 * How long an account is presumed limited when the provider did not say when it recovers.
 *
 * Load-bearing, not a nicety. `limited` is otherwise cleared only by a subsequent SUCCESS on that
 * account — but the balancer skips limited accounts, so an unbounded entry is a deadlock: the
 * account is skipped, therefore never runs, therefore never succeeds, therefore stays skipped. The
 * bound guarantees the account becomes eligible again on its own, and the worst case is one failed
 * run that re-arms it.
 */
export const ASSUMED_LIMIT_COOLDOWN_MS = 60 * 60_000;

/**
 * One rate-limit window as the provider reported it.
 *
 * **`usedPercent` is the only required field**, because it is the only one both providers always
 * state. Everything else is optional and the optionality is load-bearing, not defensive — see
 * `2026-08-16-claude-usage-windows.md`:
 *
 * - `resetsAt` is UNIX **seconds** — Codex's own unit, kept rather than converted so a value can be
 *   compared against the wire without a mental step, and because a millisecond reading of it would
 *   be a date in 1970 rather than an error. Claude does not state one.
 * - `resetsText` is Claude's own localized string (`Aug 20 at 1am (Europe/Warsaw)`), passed through
 *   verbatim. Converting it to an epoch would mean inferring a year and re-deriving a timezone from
 *   a 12-hour clock, whose failure mode is a confidently wrong timestamp. Passing it through has no
 *   failure mode: the CLI already rendered it in the user's own zone.
 * - `windowMinutes` is Codex's; Claude says "session" / "week" without a length. Writing `300` for
 *   its documented 5-hour window would be cezar inventing a number the provider did not say.
 * - `label` is what Claude gives instead, and it does something `windowMinutes` cannot: **"week
 *   (all models)" and "week (Fable)" have the SAME length**, so a consumer keyed on minutes renders
 *   two different windows identically and collides on any key derived from it.
 */
const quotaWindowSchema = z
  .object({
    usedPercent: z.number().min(0).max(1000),
    label: z.string().max(64).optional().catch(undefined),
    windowMinutes: z.number().int().positive().optional().catch(undefined),
    resetsAt: z.number().int().nonnegative().optional().catch(undefined),
    resetsText: z.string().max(128).optional().catch(undefined),
  })
  .passthrough();

export type QuotaWindow = z.infer<typeof quotaWindowSchema>;

/** The last allowance snapshot for an account whose provider reports one. Never synthesized. */
const accountQuotaSchema = z
  .object({
    takenAt: z.string().max(64),
    planType: z.string().max(64).optional().catch(undefined),
    windows: z
      .array(z.unknown())
      .default(() => [])
      .catch(() => [])
      .transform((entries) =>
        entries.flatMap((entry) => {
          const parsed = quotaWindowSchema.safeParse(entry);
          return parsed.success ? [parsed.data] : [];
        }),
      ),
  })
  .passthrough();

export type AccountQuota = z.infer<typeof accountQuotaSchema>;

/** The fairness cursor: when this account last took a run, and how many it has taken. */
const accountDispatchSchema = z
  .object({
    lastAt: z.string().max(64),
    count: z.number().int().nonnegative().catch(0),
  })
  .passthrough();

export type AccountDispatch = z.infer<typeof accountDispatchSchema>;

/** An observed limit-hit. `until` is present only when the provider actually said so — an absent
 *  one falls back to `ASSUMED_LIMIT_COOLDOWN_MS` rather than lasting forever. */
const accountLimitedSchema = z
  .object({
    since: z.string().max(64),
    until: z.string().max(64).optional().catch(undefined),
    source: z.string().max(64).catch('unknown'),
  })
  .passthrough();

export type AccountLimited = z.infer<typeof accountLimitedSchema>;

const accountUsageEntrySchema = z
  .object({
    dispatch: accountDispatchSchema.optional().catch(undefined),
    limited: accountLimitedSchema.optional().catch(undefined),
    quota: accountQuotaSchema.optional().catch(undefined),
  })
  .passthrough();

export type AccountUsageEntry = z.infer<typeof accountUsageEntrySchema>;

const storeSchema = z
  .object({
    version: z.number().int().min(0).default(1).catch(1),
    accounts: z
      .record(z.string(), z.unknown())
      .default(() => ({}))
      .catch(() => ({}))
      .transform((raw) => {
        const out: Record<string, AccountUsageEntry> = {};
        for (const [key, value] of Object.entries(raw)) {
          const parsed = accountUsageEntrySchema.safeParse(value);
          if (parsed.success) out[key] = parsed.data;
        }
        return out;
      }),
  })
  .passthrough();

export type AgentAccountUsageStore = z.infer<typeof storeSchema>;

/**
 * The key everything in this file is stored under: **provider AND account id**, never the id alone.
 *
 * The discovered account is the reserved id `"default"` for EVERY provider (see
 * `DEFAULT_AGENT_ACCOUNT_ID`), so `"default"` on its own names Claude's discovered login and
 * Codex's discovered login at the same time. Keying on it alone would pool two different
 * subscriptions into one bucket: their in-flight counts would add up, one's rate-limit would
 * exclude the other from routing, and Codex's quota bar would be drawn against a Claude row.
 *
 * Stored accounts have unique ids and would survive the shorter key, which is exactly what makes
 * this worth stating — the bug would only ever appear on the zero-config setup, the one most
 * people run.
 */
export function accountUsageKey(provider: ProviderId, accountId?: string | null): string {
  return `${provider}:${accountId || DEFAULT_AGENT_ACCOUNT_ID}`;
}

/** The in-memory default — what a missing file behaves like, and the zero-config state. */
export function defaultAgentAccountUsageStore(): AgentAccountUsageStore {
  return storeSchema.parse({});
}

/**
 * Read the store on demand — never cached, never throws.
 *
 * Uncached for `agent-accounts.ts`'s reason and one more: this file is written by every cezar
 * process on the machine on every dispatch, so a snapshot here goes stale faster than anywhere
 * else in the workspace home. A missing file is the zero-config default, silently.
 */
export async function loadAgentAccountUsage(): Promise<AgentAccountUsageStore> {
  const path = agentAccountUsagePath();
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return defaultAgentAccountUsageStore();
  }
  try {
    const parsed = storeSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // malformed JSON — fall through to the warning + defaults
  }
  console.warn(`[cez] agent account usage ${path} is corrupt — ignoring it (routing falls back to listed order)`);
  return defaultAgentAccountUsageStore();
}

/**
 * Read-modify-write merge, the `mergeWriteAgentAccounts` bargain: re-read, mutate, atomic rename.
 *
 * Unlike the accounts file, a lost write here is survivable by design — it costs one dispatch's
 * fairness, not a user's configuration — so this NEVER throws. A read-only home degrades to
 * in-memory state for this process, which still balances correctly for as long as it lives.
 */
export async function mergeWriteAgentAccountUsage(
  mutator: (store: AgentAccountUsageStore) => AgentAccountUsageStore | void,
): Promise<AgentAccountUsageStore> {
  const current = await loadAgentAccountUsage();
  const next = mutator(current) ?? current;
  try {
    atomicWriteJsonSync(agentAccountUsagePath(), next);
  } catch {
    // read-only home, or a racing writer that won: the in-memory answer is still correct here
  }
  return next;
}

/** The entry for a key, or an empty one. Never `undefined`, so callers do not each invent a default. */
export function usageEntry(store: AgentAccountUsageStore, key: string): AccountUsageEntry {
  return store.accounts[key] ?? {};
}

/** Record that `key` just took a run. Pure — the caller wraps it in `mergeWriteAgentAccountUsage`. */
export function recordDispatch(
  store: AgentAccountUsageStore,
  key: string,
  now: Date = new Date(),
): AgentAccountUsageStore {
  const entry = usageEntry(store, key);
  store.accounts[key] = {
    ...entry,
    dispatch: { lastAt: now.toISOString(), count: (entry.dispatch?.count ?? 0) + 1 },
  };
  return store;
}

/**
 * Record that `key` hit its usage limit. Pure.
 *
 * `until` is passed through ONLY when the provider stated it. Guessing a reset time would produce
 * an account that comes back at a moment nothing observed, which is worse than the honest bounded
 * cooldown `isLimited` applies to an absent one.
 */
export function recordLimited(
  store: AgentAccountUsageStore,
  key: string,
  detail: { source: string; until?: string },
  now: Date = new Date(),
): AgentAccountUsageStore {
  const entry = usageEntry(store, key);
  const limited: AccountLimited = { since: now.toISOString(), source: detail.source };
  if (detail.until) limited.until = detail.until;
  store.accounts[key] = { ...entry, limited };
  return store;
}

/** Clear a limit after a successful run on that account. Pure. */
export function clearLimited(store: AgentAccountUsageStore, key: string): AgentAccountUsageStore {
  const entry = store.accounts[key];
  if (!entry?.limited) return store;
  const { limited: _dropped, ...rest } = entry;
  store.accounts[key] = rest;
  return store;
}

/**
 * Is this account still inside its limit window?
 *
 * A provider-stated `until` is authoritative. An absent one is bounded by
 * `ASSUMED_LIMIT_COOLDOWN_MS` — see that constant for why an unbounded answer deadlocks the
 * balancer. An unparseable date reads as NOT limited: the account is at worst tried and fails
 * again, whereas the other reading excludes a working login on the strength of a corrupt string.
 */
export function isLimited(limited: AccountLimited | undefined, now: number = Date.now()): boolean {
  if (!limited) return false;
  if (limited.until) {
    const until = Date.parse(limited.until);
    return Number.isFinite(until) ? now < until : false;
  }
  const since = Date.parse(limited.since);
  return Number.isFinite(since) ? now < since + ASSUMED_LIMIT_COOLDOWN_MS : false;
}

/**
 * The quota snapshot as far as it can still be trusted, or `undefined`.
 *
 * Two independent reasons to drop it, and both have to be applied or the number on screen outlives
 * the fact it describes:
 *
 * 1. **Age.** Past `QUOTA_STALE_AFTER_MS` the whole snapshot goes.
 * 2. **Window rollover.** A window whose `resetsAt` has passed has already refilled, so its
 *    `usedPercent` describes a window that no longer exists — that single window is dropped even
 *    when the snapshot is seconds old. A snapshot left with no live window returns `undefined`
 *    rather than an empty bar.
 *
 * Rule 2 is the one that is easy to miss: a fresh read of a rolled-over window is *recent* and
 * *wrong at the same time*, which no age check can catch.
 *
 * **Rule 2 applies only where `resetsAt` exists**, and the guard has to be written that way round.
 * A Claude window states a human reset string and no timestamp, so the obvious spelling
 * (`window.resetsAt * 1000 > now`) reads its absence as `NaN > now` — false — and silently drops
 * EVERY Claude window, leaving the snapshot empty and the panel bare. That failure looks exactly
 * like "this provider reports nothing", which is the state this whole feature exists to end. A
 * window with no stated reset is bounded by rule 1 alone; a 5-minute snapshot cannot outlive a
 * 5-hour window by enough to matter.
 */
export function freshQuota(quota: AccountQuota | undefined, now: number = Date.now()): AccountQuota | undefined {
  if (!quota) return undefined;
  const takenAt = Date.parse(quota.takenAt);
  if (!Number.isFinite(takenAt) || now - takenAt > QUOTA_STALE_AFTER_MS) return undefined;
  const windows = quota.windows.filter((window) => window.resetsAt === undefined || window.resetsAt * 1000 > now);
  if (windows.length === 0) return undefined;
  return { ...quota, windows };
}

/** One step's account attribution, as `countInflight` needs it — the shape `runs/store.ts` records
 *  on every step (`backend` + `profileId`), narrowed so the counter needs no run schema. */
export interface InflightStep {
  backend?: ProviderId | string;
  profileId?: string;
  status: string;
}

/**
 * How many runs each account is carrying right now, keyed by `accountUsageKey`.
 *
 * Derived on every read — see the module note for why this is never persisted. A step with no
 * `backend` is skipped rather than guessed: it predates backend affinity, and attributing it to a
 * provider would move a real count onto an account that may not have run it.
 */
/**
 * **SUPERSEDED 2026-08-16 for the in-flight count. Do not use it for that.**
 *
 * The production count is `RunManager.accountInflight()`, aggregated by
 * `WorkspaceSemaphore.accountInflight()`. Use those. This helper is kept only because deriving
 * counts from a list of records is a reasonable thing to want, and it is honest for a list you
 * already know is live.
 *
 * The original claim below — that a record's `status === 'running'` identifies a live run — is
 * **false on the server path**, and a crash test proved it. It reasoned from `readRunIndexFromDisk`,
 * which does reconcile a loaded `running` row to `failed` ("interrupted — cezar process exited").
 * But the server opens every store with `keepLive: true`, which skips exactly that reconciliation
 * so `recover()` can resume interrupted work — so after a SIGKILL the records come back still
 * saying `running`, and a count derived from them reports a phantom run **that never clears**,
 * because nothing will ever move that step again. Measured: one SIGKILL mid-run left the run's
 * first step reconciled to `failed` and its `continue-1` step `running`, and the panel read 1 on an
 * idle login. The balancer would have routed away from that account permanently.
 *
 * The replacement keys on the manager's in-memory `active` map, which a dead process cannot leave
 * behind. ~~Original note:~~ *"In-flight counts from the LIVE run stores — the only place this can
 * honestly be read … a disk read reports zero in-flight forever."*
 *
 * The one part that still holds: runs started by a DIFFERENT cezar process on the same machine are
 * not counted. A run is executed by the process that owns its `RunManager`, so this is always the
 * count of what THIS cockpit is doing.
 */
export function inflightFromRuns(
  runs: readonly { status: string; steps: readonly InflightStep[] }[],
): Record<string, number> {
  return countInflight(runs.filter((run) => run.status === 'running').flatMap((run) => run.steps));
}

export function countInflight(steps: readonly InflightStep[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const step of steps) {
    if (step.status !== 'running') continue;
    if (!step.backend) continue;
    const key = accountUsageKey(step.backend as ProviderId, step.profileId);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
