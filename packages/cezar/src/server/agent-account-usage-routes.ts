import { Hono } from 'hono';
import {
  agentAccountRouteId,
  type AccountUsageResponse,
  type AccountUsageRow,
} from '@loki-labs/better-cezar-contract';
import { probeClaudeAccount, probeClaudeUsage, probeCodexQuota } from '../core/agent-account-probe.ts';
import { PROFILE_CAPABLE_PROVIDERS } from '../core/agent-profiles.ts';
import {
  accountUsageKey,
  freshQuota,
  isLimited,
  loadAgentAccountUsage,
  mergeWriteAgentAccountUsage,
  usageEntry,
  type AgentAccountUsageStore,
} from '../workspace/agent-account-usage.ts';
import { loadAgentAccounts } from '../workspace/agent-accounts.ts';
import { listAgentProfiles, type ResolvedAgentProfile } from '../workspace/agent-profiles.ts';
import { resolveCapabilities } from './capabilities.ts';

/**
 * `GET /api/v1/workspace/agent-accounts/usage` — the sidebar panel's data
 * (`.ai/specs/2026-08-16-agent-account-usage-routing.md`, `CEZ_ACCOUNT_USAGE=1`).
 *
 * **Flag-off shape** follows `./notes-routes.ts`: 200 with a schema-valid `{enabled: false,
 * accounts: []}`, never 404 — a 404 in this family has to keep meaning "no such route". `enabled`
 * is what lets the cockpit tell a disabled feature from a machine with no accounts, since both
 * answer an empty list and the two empty states read completely differently.
 *
 * **This route never opens a project.** It reads the accounts file, the usage file, and the
 * ALREADY-BUILT contexts — `ids()` + `peek()`, never `context()`, which prunes worktrees and
 * resumes interrupted runs. Rendering a sidebar panel must not restart agents; the same rule
 * `workspace/run-index.ts` documents at length, for the same reason.
 *
 * **Probing is off the response path.** The handler answers from the stored snapshot immediately
 * and kicks a refresh only when that snapshot is stale, deduped so a polling panel cannot spawn a
 * CLI child per poll. The response therefore carries `takenAt` and the client drops what is too
 * old — the freshness claim is in the data, not in the fact that a request returned 200.
 */

export interface AgentAccountUsageRouteDeps {
  /** Live in-flight counts, keyed by `accountUsageKey`. Supplied by `server.ts` from the built
   *  contexts; a missing dep means "this build cannot see runs", which reads as zero rather than
   *  as an error — see `inflightFromRuns` for why disk is not an alternative. */
  inflight?: () => Record<string, number>;
  /** Read per request so a test that flips the flag mid-file is honoured. */
  env?: NodeJS.ProcessEnv;
  /** Injected in tests. Production probes the real CLIs. */
  probeQuota?: typeof probeCodexQuota;
  probeIdentity?: typeof probeClaudeAccount;
  probeUsage?: typeof probeClaudeUsage;
  /** Working directory handed to the short-lived codex child. Defaults to the server's cwd. */
  cwd?: string;
  now?: () => number;
}

const EMPTY: AccountUsageResponse = { enabled: false, accounts: [] };

/**
 * One refresh round at a time, process-wide.
 *
 * A promise rather than a boolean so a second caller arriving mid-round joins it instead of
 * starting a second one. Reset in `finally`, so a probe that throws — it should not, they all
 * swallow — cannot wedge refreshing off for the life of the process.
 */
let refreshInFlight: Promise<void> | undefined;

interface CachedIdentity {
  at: number;
  signedIn?: boolean;
  plan?: string;
  email?: string;
}

/**
 * Identity, cached IN PROCESS rather than in the usage file.
 *
 * In process because it is a probe result, not user state: it is re-derivable at any time and
 * belongs to this server's lifetime. Not in the file specifically because it carries the account's
 * email — that is the operator's identity, and there is no reason to write a second copy of it to
 * disk when `agent-accounts.json` already holds whatever label they chose.
 *
 * The TTL is long because the answer only changes when someone runs `claude auth login` —
 * `provider-auth.ts` makes the same argument for the same kind of fact.
 */
const identityCache = new Map<string, CachedIdentity>();
const IDENTITY_TTL_MS = 5 * 60_000;

/**
 * Is any account's snapshot old enough to be worth a probe round?
 *
 * A Claude account has TWO snapshots with different lifetimes — identity, cached in process for
 * `IDENTITY_TTL_MS` because it only changes on `claude auth login`, and a quota, which expires in
 * `QUOTA_STALE_AFTER_MS`. Either being stale is a reason to refresh. Asking about identity alone
 * (the shape this had while Claude reported no allowance) is the interesting failure: identity is
 * cached for longer, so the panel would refresh on the identity clock and the freshly-added usage
 * bar would expire and stay blank between rounds.
 */
function needsRefresh(
  profiles: readonly ResolvedAgentProfile[],
  store: AgentAccountUsageStore,
  now: number,
): boolean {
  return profiles.some((profile) => {
    const entry = usageEntry(store, accountUsageKey(profile.provider, profile.isDefault ? undefined : profile.id));
    if (freshQuota(entry.quota, now) === undefined) return true;
    if (profile.provider !== 'claude') return false;
    const cached = identityCache.get(profileRouteId(profile));
    return !cached || now - cached.at > IDENTITY_TTL_MS;
  });
}

function profileRouteId(profile: ResolvedAgentProfile): string {
  return agentAccountRouteId({ id: profile.id, provider: profile.provider, isDefault: profile.isDefault });
}

/**
 * Probe every account and write what came back.
 *
 * Both providers report a quota, from different surfaces: Codex over its app-server, Claude out of
 * `claude -p "/usage"` (see `core/agent-account-probe.ts`). Claude accounts are probed twice per
 * round — once for identity, once for usage — because the two facts live in different commands and
 * expire on different clocks. An account whose probe returns nothing has its stored quota LEFT
 * ALONE rather than cleared: `freshQuota` already expires it by age, and clearing on a single
 * failed probe would blank a bar every time the CLI was momentarily busy.
 */
async function refreshAccounts(
  profiles: readonly ResolvedAgentProfile[],
  deps: AgentAccountUsageRouteDeps,
  now: number,
): Promise<void> {
  const probeQuota = deps.probeQuota ?? probeCodexQuota;
  const probeIdentity = deps.probeIdentity ?? probeClaudeAccount;
  const probeUsage = deps.probeUsage ?? probeClaudeUsage;
  const cwd = deps.cwd ?? process.cwd();

  const quotas = profiles
    .filter((profile) => profile.provider === 'codex' || profile.provider === 'claude')
    .map(async (profile) => {
      const configDir = profile.isDefault ? undefined : profile.path;
      return {
        key: accountUsageKey(profile.provider, profile.isDefault ? undefined : profile.id),
        quota:
          profile.provider === 'codex'
            ? await probeQuota({ cwd, configDir })
            : await probeUsage({ configDir }),
      };
    });

  const identities = profiles
    .filter((profile) => profile.provider === 'claude')
    .map(async (profile) => {
      const identity = await probeIdentity({ configDir: profile.isDefault ? undefined : profile.path });
      // Absent stays absent: "could not ask" is not "signed out", so a failed probe must not
      // overwrite a good cached answer with a red one.
      if (!identity) return;
      const cached: CachedIdentity = { at: now, signedIn: identity.loggedIn };
      if (identity.plan) cached.plan = identity.plan;
      if (identity.email) cached.email = identity.email;
      identityCache.set(profileRouteId(profile), cached);
    });

  const [found] = await Promise.all([Promise.all(quotas), Promise.all(identities)]);
  const usable = found.filter((result) => result.quota !== undefined);
  if (usable.length === 0) return;
  await mergeWriteAgentAccountUsage((store) => {
    for (const { key, quota } of usable) {
      store.accounts[key] = { ...usageEntry(store, key), quota };
    }
    return store;
  });
}

export function createAgentAccountUsageRoutes(deps: AgentAccountUsageRouteDeps = {}) {
  return new Hono().get('/workspace/agent-accounts/usage', async (c) => {
    const env = deps.env ?? process.env;
    if (!resolveCapabilities(env).accountUsage) return c.json(EMPTY);

    const now = deps.now?.() ?? Date.now();
    const accountStore = await loadAgentAccounts();
    const profiles = listAgentProfiles(accountStore, PROFILE_CAPABLE_PROVIDERS, env);
    const usage = await loadAgentAccountUsage();

    if (!refreshInFlight && needsRefresh(profiles, usage, now)) {
      // Fire and forget, deduped, and NEVER awaited. The response below is the stored snapshot
      // either way — a 200 here says nothing about whether the refresh succeeded, which is why
      // every row carries its own `takenAt` and the client drops what is too old.
      //
      // Not awaiting is the load-bearing part: each probe spawns a CLI child with a multi-second
      // timeout, and this route is polled. Awaiting would put that timeout on every poll of a
      // panel whose whole job is to be glanceable.
      // The latch is cleared ONLY by the round that owns it. Clearing it unconditionally is the
      // obvious spelling and it is wrong: an older, abandoned round settling later would wipe the
      // latch a newer round had just set, and the next poll would start a second concurrent round —
      // exactly the CLI-child-per-poll this dedupe exists to prevent. Caught by the dedupe test,
      // which only fails once a prior round's completion lands inside a later one.
      const round: Promise<void> = refreshAccounts(profiles, deps, now).finally(() => {
        if (refreshInFlight === round) refreshInFlight = undefined;
      });
      refreshInFlight = round;
    }

    const inflight = deps.inflight?.() ?? {};

    const accounts: AccountUsageRow[] = profiles.map((profile) => {
      const accountId = profile.isDefault ? undefined : profile.id;
      const entry = usageEntry(usage, accountUsageKey(profile.provider, accountId));
      const routeId = agentAccountRouteId({
        id: profile.id,
        provider: profile.provider,
        isDefault: profile.isDefault,
      });
      const row: AccountUsageRow = {
        id: routeId,
        provider: profile.provider,
        label: profile.label,
        isDefault: profile.isDefault,
        inflight: inflight[accountUsageKey(profile.provider, accountId)] ?? 0,
        limited: isLimited(entry.limited, now),
      };
      if (row.limited && entry.limited?.until) row.limitedUntil = entry.limited.until;
      const quota = freshQuota(entry.quota, now);
      // Present ONLY when the provider actually reported allowance. Never derived, never zeroed.
      if (quota) row.quota = quota;
      const identity = identityCache.get(routeId);
      if (identity) {
        if (identity.signedIn !== undefined) row.signedIn = identity.signedIn;
        if (identity.plan) row.plan = identity.plan;
        if (identity.email) row.email = identity.email;
      }
      return row;
    });

    return c.json({ enabled: true, accounts } satisfies AccountUsageResponse);
  });
}

/** Test-only: drop the process-wide refresh latch and identity cache, so one test's pending round
 *  or cached answer cannot leak into the next. Never called in production, where a single latch
 *  and cache for the process is the point. */
export function resetAccountUsageRefreshForTests(): void {
  refreshInFlight = undefined;
  identityCache.clear();
}

/** Test-only: settle the round a GET kicked off, so a test can assert the SECOND read sees what
 *  the probes found. Production never waits on this — see the handler's comment for why. */
export function awaitAccountUsageRefreshForTests(): Promise<void> {
  return refreshInFlight ?? Promise.resolve();
}
