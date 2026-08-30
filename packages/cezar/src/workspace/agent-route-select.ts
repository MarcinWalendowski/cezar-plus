import { parseAgentRoute, type AgentRoute } from '@loki-labs/cezar-plus-contract';
import { PROFILE_CAPABLE_PROVIDERS } from '../core/agent-profiles.ts';
import type { ProviderId } from '../core/provider-auth.ts';
import type { AccountTier } from './account-viability.ts';
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
 * ## The four signals, and why they are in this order
 *
 * 1. **Skip a limited account.** This is the feature. Routing around an exhausted login instead of
 *    failing on it is the whole reason a pool exists.
 * 2. **Lowest usage band.** `floor(worstUsedPercent / 10)` over the account's fresh quota — see
 *    `usageBand` for why a band and not the raw percent, and for the condition under which this
 *    key applies at all.
 *
 *    **NARROWED 2026-08-24 by `2026-08-24-second-codex-account-balancing.md` (D2): this signal is
 *    now applied WITHIN a provider, never across one.** As written it ranked a Claude percentage
 *    directly against a Codex percentage, which are fractions of two differently-sized allowances;
 *    under `pool:*` — this repo's own production setting — that is the normal comparison rather
 *    than a corner case, and it let a Codex account that reported 0% out-rank every Claude login on
 *    the machine. `bestOf` below picks each provider's winner on this signal and then chooses
 *    between the winners on signals 3 and 4 only. Signals 1, 3 and 4 are unchanged, and a
 *    single-provider pool (`pool:claude`, `pool:codex`) behaves exactly as it always has.
 * 3. **Fewest in-flight runs.** Exact, live, and needs no vendor API — it is the only signal that
 *    describes *right now* rather than the past.
 * 4. **Least recently dispatched.** Breaks the tie, and is what makes the spread even over a
 *    session rather than pinning every run to whichever account sorts first.
 *
 * **CORRECTED 2026-08-16.** Signal 2 did not exist; quota entered as a single boolean
 * `usedPercent >= POOL_QUOTA_CEILING` (95), and this block justified that with "a machine … whose
 * only provider reports no allowance at all, **which today is every Claude account**". That clause
 * was already false when it was written — `2026-08-16-claude-usage-windows.md` shipped Claude
 * windows the same morning — and it is the sentence that made quota look like a yes/no worth
 * having. As a binary it saw no difference between a login at 66% of its week and one at 9%, so
 * signals 3 and 4 round-robined the two and the gap never closed. The ceiling's hazard (routing
 * onto an account about to be rejected) is not weakened by its removal: a band avoids high usage
 * from 10% upward, where 95 avoided it only at 95.
 *
 * Quota still never *decides*. It is applied only when every compared candidate has a fresh
 * reading, so a machine that has never probed, or one running with `CEZ_ACCOUNT_USAGE` off,
 * balances exactly as it did before on signals 3 and 4.
 */

export interface PoolChoice {
  provider: ProviderId;
  /** `default` or a stored slug — what goes on `runs.agentProfile`. */
  accountId: string;
  /** `accountUsageKey` of every candidate excluded from THIS resolution as `disconnected`
   *  (`.ai/specs/2026-08-25-logged-out-account-fallback.md`, Phase 1). Absent/empty when nothing
   *  was excluded — `resolvePoolForDispatch`/`resolvePoolForProvider` are in `workspace/`, which
   *  has no store handle, so this is how the `run.account_fallback` metric's `skippedDisconnected`
   *  field reaches `RunManager` without the module doing any I/O of its own. */
  skippedDisconnected?: string[];
}

interface Ranked {
  profile: ResolvedAgentProfile;
  limited: boolean;
  /** `undefined` = unmeasured. NOT zero — see `usageBand`. */
  band: number | undefined;
  inflight: number;
  lastDispatchMs: number;
}

/**
 * How used an account is, in tens of a percent, or `undefined` when nothing fresh says.
 *
 * **Bands, not the raw percent, deliberately.** Raw percent is a near-unique key, so it would win
 * essentially every comparison and make in-flight unreachable in practice — every run would stack
 * onto the single least-used login until its own number caught up. It would also reorder the pool
 * on a value the panel re-polls every 15 seconds. A band says "materially more used" and leaves the
 * live signals to decide inside it.
 *
 * **The max across windows, not the average**, which is the rule the retired ceiling already used
 * and is unchanged: a provider reports several windows (5h AND weekly) and being out of ANY of them
 * stops the account, so an average would let a fresh session window hide an exhausted week. It is
 * also what makes this converge without a second mechanism — a burst on the fresher login raises
 * its *5h session* percentage quickly, climbs it a band, and hands work back.
 *
 * **A quota with no fresh windows left is unmeasured, not 0%.** `freshQuota` drops windows that
 * have rolled over and answers `undefined` once none remain, which is the live path here; the
 * empty-list arm below covers a caller that hands over an unfiltered quota, because `Math.max()` of
 * an empty list is `-Infinity` and would sort that account *better than every measured one* — the
 * most-favoured position, handed to the account we know the least about.
 */
function usageBand(quota: { windows: readonly { usedPercent: number }[] } | undefined): number | undefined {
  if (!quota || quota.windows.length === 0) return undefined;
  return Math.floor(Math.max(...quota.windows.map((window) => window.usedPercent)) / 10);
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
    return {
      profile,
      limited: isLimited(entry.limited, now),
      band: usageBand(freshQuota(entry.quota, now)),
      inflight: inflight[key] ?? 0,
      // Never dispatched sorts FIRST (epoch 0) — an unused account is the best possible spread, and
      // it is also the zero-config first run, which must not always land on the same login.
      lastDispatchMs: dispatchedAt(entry.dispatch?.lastAt),
    };
  });

  const eligible = ranked.filter((row) => !row.limited);
  const pool = eligible.length > 0 ? eligible : ranked;
  const best = bestOf(pool);
  return {
    provider: best.profile.provider,
    accountId: best.profile.isDefault ? 'default' : best.profile.id,
  };
}

/**
 * The winner of a candidate set, in two levels: each provider's own best, then the best of those
 * (`.ai/specs/2026-08-24-second-codex-account-balancing.md`, D2).
 *
 * ## Why the band is confined to one provider
 *
 * `floor(usedPercent / 10)` is a fraction of a subscription's own allowance, and two providers'
 * allowances are different sizes bought under different plans. Ranking a Claude Max week at 70%
 * directly against a Codex Plus week at 0% reads "0 is less used, send the work there", which is a
 * statement about two numbers and not about which login can better absorb a run.
 *
 * That comparison only became reachable when `pool:*` shipped — until then a pool was one
 * provider's logins and every band in a set measured the same thing. It is what this repo's own
 * production configuration uses (`defaults = {claude: "pool:*", codex: "pool:*"}`), so the
 * cross-provider case is the normal one here, not a corner.
 *
 * ## Why it is two levels rather than a smarter comparator
 *
 * The obvious spelling — "compare bands only when both rows are the same provider" — is
 * intransitive: with Claude A (band 0), Claude B (band 7) and an unmeasured Codex C, A beats B,
 * B ties C, C ties A, and the winner then depends on the order the array happens to be in. Every
 * comparison here is between rows that are alike, so each level stays a total order and the result
 * does not depend on input order.
 *
 * ## What the second level compares on
 *
 * In-flight and least-recently-dispatched — the two signals that are provider-independent by
 * construction. One counts runs, the other counts time. Neither claims anything about allowance,
 * which is the claim that could not be made honestly across a provider boundary.
 */
function bestOf(pool: readonly Ranked[]): Ranked {
  const byProvider = new Map<ProviderId, Ranked[]>();
  for (const row of pool) {
    const rows = byProvider.get(row.profile.provider);
    if (rows) rows.push(row);
    else byProvider.set(row.profile.provider, [row]);
  }
  const winners = [...byProvider.values()].map((rows) => {
    // Decided ONCE over the set about to be compared, never per pair, so the comparator stays a
    // total order (a per-pair rule would be intransitive the moment one candidate is unmeasured).
    //
    // A measured account and an unmeasured one are not comparable by usage, and the tempting
    // default — unmeasured sorts best — is the dangerous one: it would hand every run to whichever
    // login the probe happens to be failing on. Sorting it *worst* is no better, since a cockpit
    // that never probes at all would then have a stable arbitrary favourite. So a partially
    // measured provider simply balances the way it did before quota existed.
    const byBand = rows.every((row) => row.band !== undefined);
    return rows.reduce((a, b) => (compare(a, b, byBand) <= 0 ? a : b));
  });
  // `byBand: false` at this level is the D2 rule itself, not a degradation: see the doc above.
  return winners.reduce((a, b) => (compare(a, b, false) <= 0 ? a : b));
}

/** Ordering key, lowest wins. Ties fall through to the next signal, never to array order. */
function compare(a: Ranked, b: Ranked, byBand: boolean): number {
  if (byBand && a.band !== b.band) return (a.band ?? 0) - (b.band ?? 0);
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
  /** Classifies an account's credentials (`.ai/specs/2026-08-25-logged-out-account-fallback.md`,
   *  Phase 1). Defaulted to "everything connected", so the quota-only behaviour this had before
   *  credentials existed is bit-for-bit preserved when nothing is injected. A `disconnected`
   *  account never enters `selectPoolAccount`'s candidate set at all — never selected, never even
   *  the limited-but-least-bad fallback. */
  tier?: (profile: ResolvedAgentProfile) => AccountTier;
  /** When the workspace is locked to a provider (`.ai/specs/2026-08-29-global-provider-toggle.md`,
   *  D5), candidates are confined to it — the pool still balances ACCOUNTS, it just may no longer
   *  hop providers. Absent ⇒ today's wildcard behaviour. */
  lock?: ProviderId;
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
    const tierOf = options.tier ?? (() => 'runnable' as const);
    // `options.lock`, never `route.provider` — same narrowing rule as `resolvePoolForProvider`'s
    // own comment: a locked wildcard must not hop providers, and reading the route's own provider
    // instead of the lock would defeat the narrowing on a bare `pool:*`.
    const all = poolCandidates(
      options.lock ? { kind: 'pool', provider: options.lock } : route,
      listAgentProfiles(accounts, PROFILE_CAPABLE_PROVIDERS),
    );
    const skipped = all.filter((profile) => tierOf(profile) === 'disconnected');
    const candidates = all.filter((profile) => tierOf(profile) !== 'disconnected');
    const chosen = selectPoolAccount({
      candidates,
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
    return skipped.length > 0
      ? {
        ...chosen,
        skippedDisconnected: skipped.map((profile) =>
          accountUsageKey(profile.provider, profile.isDefault ? undefined : profile.id),
        ),
      }
      : chosen;
  } catch {
    return undefined;
  }
}

/**
 * The account for a provider a STEP pinned, when that provider's stored selection is a pool.
 *
 * `resolvePoolForDispatch` above answers for the RUN, once, at dispatch. A workflow step may then
 * override the provider — `spec-to-deploy` pins `runner: 'claude'` on `spec` and `review-spec` so
 * that "always opus" survives a codex run — and until this existed, that pin changed the provider
 * and nothing re-resolved the account. Resolution fell through to `selectProfile`, which cannot
 * parse a pool (`store.accounts.find(a => a.id === 'pool:*')` never matches) and degrades to the
 * provider's DEFAULT profile. So the step landed on `claude:default` however exhausted it was,
 * with a healthy `claude:secondary` sitting unused — measured in production on run `da0119ec`,
 * 2026-08-23. Spec: `.ai/specs/2026-08-23-step-runner-account-resolution.md`.
 *
 * **Forces the candidate set to `provider`, even on the wildcard `pool:*`.** The caller has already
 * pinned the provider; letting a wildcard cross back to another one would undo the very pin that
 * reached this function. That is deliberately narrower than `resolvePoolForDispatch`, which honours
 * the wildcard because the run made no such promise.
 *
 * **This does NOT decide todo `81ab4ebd`, and that is now true only when no global lock is set.**
 * CORRECTED 2026-08-29 (`.ai/specs/2026-08-29-global-provider-toggle.md`): under a `runnerLock`
 * that question IS decided — the lock narrows `resolvePoolForDispatch`'s own wildcard too (D5) —
 * but this function's own scope claim stands for the unlocked case, which is what the original
 * sentence below still describes. That question is whether a *run's* explicit runner
 * should constrain a wildcard pool, and it stays open. The narrowing here is scoped to a step whose
 * provider is already fixed by its own pin, which is a different claim.
 *
 * **`undefined` for a non-pool route**, meaning "leave the existing resolution alone" — an
 * explicitly stored account is already honoured by `selectProfile`, and overriding it here would be
 * a second, invisible routing rule. Never throws, matching its sibling: an unreadable home degrades
 * to the behaviour that predates this function.
 */
export async function resolvePoolForProvider(options: {
  /** The provider the step pinned. Candidates are confined to it. */
  provider: ProviderId;
  repoRoot: string;
  /** Workspace-wide, keyed by `accountUsageKey`. */
  inflight?: Record<string, number>;
  now?: number;
  /** See `resolvePoolForDispatch`'s twin option — same classifier, same default. */
  tier?: (profile: ResolvedAgentProfile) => AccountTier;
}): Promise<PoolChoice | undefined> {
  try {
    const [accounts, usage] = await Promise.all([loadAgentAccounts(), loadAgentAccountUsage()]);
    const route = parseAgentRoute(selectionFor(accounts, options.repoRoot, options.provider));
    if (route.kind !== 'pool') return undefined;
    const tierOf = options.tier ?? (() => 'runnable' as const);
    // `provider` from the caller, never `route.provider` — that is the narrowing, and reading it
    // off the route would reintroduce the wildcard's provider hop.
    const all = poolCandidates(
      { kind: 'pool', provider: options.provider },
      listAgentProfiles(accounts, PROFILE_CAPABLE_PROVIDERS),
    );
    const skipped = all.filter((profile) => tierOf(profile) === 'disconnected');
    const candidates = all.filter((profile) => tierOf(profile) !== 'disconnected');
    const chosen = selectPoolAccount({
      candidates,
      store: usage,
      ...(options.inflight ? { inflight: options.inflight } : {}),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    if (!chosen) return undefined;
    // A genuine SECOND dispatch, to a different provider than the run resolved, so the cursor
    // should move. The hazard is double-counting ONE dispatch; this is not that.
    await mergeWriteAgentAccountUsage((store) =>
      recordDispatch(store, accountUsageKey(chosen.provider, chosen.accountId)),
    );
    return skipped.length > 0
      ? {
        ...chosen,
        skippedDisconnected: skipped.map((profile) =>
          accountUsageKey(profile.provider, profile.isDefault ? undefined : profile.id),
        ),
      }
      : chosen;
  } catch {
    return undefined;
  }
}
