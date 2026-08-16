import { parseAgentRoute, type AgentRoute } from '@loki-labs/better-cezar-contract';
import { PROFILE_CAPABLE_PROVIDERS } from '../core/agent-profiles.ts';
import type { ProviderId } from '../core/provider-auth.ts';
import {
  accountUsageKey,
  freshQuota,
  isLimited,
  loadAgentAccountUsage,
  mergeWriteAgentAccountUsage,
  recordDispatch,
  usageEntry,
  type AgentAccountUsageStore,
} from './agent-account-usage.ts';
import { loadAgentAccounts, selectionFor } from './agent-accounts.ts';
import { listAgentProfiles, type ResolvedAgentProfile } from './agent-profiles.ts';

/**
 * Which login a pool route resolves to (`.ai/specs/2026-08-16-agent-account-usage-routing.md`,
 * Phase C).
 *
 * ## The three signals, and why they are in this order
 *
 * 1. **Skip a limited account.** This is the feature. Routing around an exhausted login instead of
 *    failing on it is the whole reason a pool exists.
 * 2. **Fewest in-flight runs.** Exact, live, and needs no vendor API — it is the only signal that
 *    describes *right now* rather than the past.
 * 3. **Least recently dispatched.** Breaks the tie, and is what makes the spread even over a
 *    session rather than pinning every run to whichever account sorts first.
 *
 * Quota refines (2) and never replaces it: an account past `POOL_QUOTA_CEILING` sorts last. It is
 * applied ONLY when the snapshot is fresh, so a machine that has never probed — or one whose only
 * provider reports no allowance at all, which today is every Claude account — still balances
 * correctly on signals 2 and 3. A balancer that needed quota would not work for Claude, which is
 * where most of these accounts are.
 */

/**
 * Past this, a fresh quota sorts an account last within its in-flight tier.
 *
 * Not a hard exclusion, deliberately. At 100% the provider will reject the run, but cezar's
 * `usedPercent` can be minutes old and the window may have rolled; excluding outright would take a
 * working account out of rotation on the strength of a stale number. Sorting last achieves the same
 * thing whenever any alternative exists, and degrades to "use it anyway" when none does.
 */
export const POOL_QUOTA_CEILING = 95;

export interface PoolChoice {
  provider: ProviderId;
  /** `default` or a stored slug — what goes on `runs.agentProfile`. */
  accountId: string;
}

interface Ranked {
  profile: ResolvedAgentProfile;
  limited: boolean;
  overCeiling: boolean;
  inflight: number;
  lastDispatchMs: number;
}

/** Candidates for a route: one provider's logins, or every provider's. */
export function poolCandidates(
  route: AgentRoute,
  profiles: readonly ResolvedAgentProfile[],
): ResolvedAgentProfile[] {
  if (route.kind !== 'pool') return [];
  return route.provider ? profiles.filter((profile) => profile.provider === route.provider) : [...profiles];
}

/**
 * Pick one account from a pool. `undefined` only when there are no candidates at all.
 *
 * **Every candidate limited still returns one.** Returning nothing would mean the caller has to
 * invent a fallback, and the natural invention — "use the default account" — is the one answer that
 * ignores the limits entirely. Instead the limited accounts are ranked among themselves by the same
 * keys, so the choice is the least-recently-hammered one; the run then fails and re-arms the limit,
 * which is what would have happened anyway, without a silent detour onto a login the user did not
 * pick.
 */
export function selectPoolAccount(options: {
  candidates: readonly ResolvedAgentProfile[];
  store: AgentAccountUsageStore;
  /** Keyed by `accountUsageKey`. Absent entries are zero — an account nothing has run is empty. */
  inflight?: Record<string, number>;
  now?: number;
}): PoolChoice | undefined {
  const { candidates, store } = options;
  if (candidates.length === 0) return undefined;
  const now = options.now ?? Date.now();
  const inflight = options.inflight ?? {};

  const ranked: Ranked[] = candidates.map((profile) => {
    const key = accountUsageKey(profile.provider, profile.isDefault ? undefined : profile.id);
    const entry = usageEntry(store, key);
    const quota = freshQuota(entry.quota, now);
    return {
      profile,
      limited: isLimited(entry.limited, now),
      // `some`, not an average: a provider reports several windows (5h AND weekly) and being out of
      // ANY of them stops the account. Averaging would let a fresh 5h window hide an exhausted week.
      overCeiling: quota?.windows.some((window) => window.usedPercent >= POOL_QUOTA_CEILING) ?? false,
      inflight: inflight[key] ?? 0,
      // Never dispatched sorts FIRST (epoch 0) — an unused account is the best possible spread, and
      // it is also the zero-config first run, which must not always land on the same login.
      lastDispatchMs: dispatchedAt(entry.dispatch?.lastAt),
    };
  });

  const eligible = ranked.filter((row) => !row.limited);
  const pool = eligible.length > 0 ? eligible : ranked;
  const best = pool.reduce((a, b) => (compare(a, b) <= 0 ? a : b));
  return {
    provider: best.profile.provider,
    accountId: best.profile.isDefault ? 'default' : best.profile.id,
  };
}

/** Ordering key, lowest wins. Ties fall through to the next signal, never to array order. */
function compare(a: Ranked, b: Ranked): number {
  if (a.overCeiling !== b.overCeiling) return a.overCeiling ? 1 : -1;
  if (a.inflight !== b.inflight) return a.inflight - b.inflight;
  return a.lastDispatchMs - b.lastDispatchMs;
}

/** An unparseable or absent timestamp reads as "never dispatched" rather than "just now": the
 *  failure mode is one extra run on that account, not permanent exclusion from the rotation. */
function dispatchedAt(lastAt: string | undefined): number {
  if (!lastAt) return 0;
  const parsed = Date.parse(lastAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The whole dispatch-time decision: read the route, and if it is a pool, pick the login and record
 * the dispatch. `undefined` means "not a pool" — leave the existing resolution alone.
 *
 * Lives here rather than inside `RunManager` so the WIRING is testable, not only the ranking.
 * `selectPoolAccount` above is pure and easy to trust; the parts that actually go wrong are which
 * value gets parsed, whether the stored selection is consulted, and whether the cursor advances —
 * and none of those are reachable from a test that can only call the pure function.
 *
 * **Never throws.** A pool that cannot be resolved — no accounts, unreadable home — answers
 * `undefined` and the run falls through to the configured runner and the project's own selection.
 * That is what cezar did before pools existed, and it is a better failure than refusing to start.
 */
export async function resolvePoolForDispatch(options: {
  /** The task's own choice (`runs.agentProfile`), if it made one. */
  agentProfile: string | undefined;
  /** The provider whose stored selection to consult when the task chose nothing. */
  fallbackProvider: ProviderId;
  repoRoot: string;
  /** Workspace-wide, keyed by `accountUsageKey`. */
  inflight?: Record<string, number>;
  now?: number;
}): Promise<PoolChoice | undefined> {
  try {
    const [accounts, usage] = await Promise.all([loadAgentAccounts(), loadAgentAccountUsage()]);
    // The task's own choice first, then the project's stored selection — `selectProfile`'s order,
    // reused rather than restated. Reading only the task's choice was a real gap: a pool chosen in
    // Settings is stored as the project's selection and never appears on a run's input, so it would
    // have parsed as "no route", fallen through to `selectProfile`, found no account with that id,
    // and degraded to the discovered login. The setting would have looked applied and done nothing.
    const route = parseAgentRoute(
      options.agentProfile ?? selectionFor(accounts, options.repoRoot, options.fallbackProvider),
    );
    if (route.kind !== 'pool') return undefined;
    const chosen = selectPoolAccount({
      candidates: poolCandidates(route, listAgentProfiles(accounts, PROFILE_CAPABLE_PROVIDERS)),
      store: usage,
      ...(options.inflight ? { inflight: options.inflight } : {}),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    if (!chosen) return undefined;
    // The cursor advances HERE, at the choice, not when the run finishes. Advancing on completion
    // would let a burst of simultaneous dispatches all read the same least-recently-used account
    // and stack onto it — the exact thundering herd signal 3 exists to prevent.
    await mergeWriteAgentAccountUsage((store) =>
      recordDispatch(store, accountUsageKey(chosen.provider, chosen.accountId)),
    );
    return chosen;
  } catch {
    return undefined;
  }
}
