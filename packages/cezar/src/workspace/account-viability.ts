import { type AgentRoute, DEFAULT_AGENT_ACCOUNT_ID } from '@loki-labs/better-cezar-contract';
import { PROFILE_CAPABLE_PROVIDERS } from '../core/agent-profiles.ts';
import { PROVIDER_IDS, type ProviderAuthService, type ProviderId, type ProviderStatus } from '../core/provider-auth.ts';
import {
  accountUsageKey,
  isLimited,
  loadAgentAccountUsage,
  usageEntry,
  type AgentAccountUsageStore,
} from './agent-account-usage.ts';
import { loadAgentAccounts } from './agent-accounts.ts';
import { listAgentProfiles, type ResolvedAgentProfile } from './agent-profiles.ts';

/**
 * Whether dispatch may start on an account RIGHT NOW — `.ai/specs/2026-08-25-logged-out-account-
 * fallback.md`, Solution 1.
 *
 *  - `runnable` = connected and in quota. Dispatch may start here right now.
 *  - `waitable` = connected but out of quota. Dispatch may NOT start here, but the run may be HELD
 *    against it and released when the limit window opens.
 *  - `disconnected` = the account's own cache row says it is not connected, or this account has a
 *    recorded runtime rejection. Hard-ineligible. Never spawned, never held against, never
 *    returned by selection.
 */
export type AccountTier = 'runnable' | 'waitable' | 'disconnected';

/** The raw authentication answer for ONE account, read from cache only — never a live probe. */
export type AccountAuth = 'connected' | 'disconnected' | 'unknown';

/**
 * What `authOf` needs from `ProviderAuthService`, narrowed to exactly the three questions routing
 * asks — never the same read the acknowledgeable incident banner uses (`peekStatus`), because that
 * one carries the provider-wide runtime latch and would let a sibling account's rejection mark a
 * healthy default disconnected. See `authOf`'s own docblock for the full reasoning.
 */
export interface ViabilityContext {
  /** A per-account runtime rejection outranks any cache — keyed by `(provider, profileId)`, so it
   *  never spreads to a sibling. `profileId` is `undefined` for the discovered default. */
  rejected: (provider: ProviderId, profileId: string | undefined) => boolean;
  /** The cached default-profile row for `provider`, WITHOUT the provider-wide runtime latch. */
  peekDefaultRowRaw: (provider: ProviderId) => ProviderStatus | undefined;
  /** The cached row for one non-default account. Already latch-free by construction. */
  peekProfileStatus: (provider: ProviderId, profileId: string) => ProviderStatus | undefined;
}

/** The minimal account shape `authOf` needs — a `ResolvedAgentProfile` satisfies it structurally. */
export interface AccountIdentity {
  provider: ProviderId;
  id: string;
  isDefault: boolean;
}

/**
 * TWO caches answer for two different kinds of account, and reading the wrong one is how a
 * KNOWN-disconnected default silently becomes `unknown`, and therefore runnable.
 *
 * `status()` writes `this.completed` and `peekStatus()` reads it. `profileStatus()` writes
 * `completedProfiles` and `peekProfileStatus()` reads THAT. Nothing copies between them, and the
 * default account is probed by `status()`, not by `profileStatus()`. So `peekProfileStatus(provider,
 * 'default')` returns `undefined` for a default cezar has just probed and found logged out — reading
 * that as "no information" would run on it.
 *
 * BOTH reads are RAW. `peekStatus()` is NOT the default's read here, because it applies the
 * provider-WIDE runtime-failure latch: a secondary account's rejection writes that latch (the
 * banner has always been per provider), so routing through `peekStatus()` would classify a
 * perfectly healthy `claude:default` as `disconnected` the moment `claude:secondary` was refused —
 * exactly the inversion this function exists to prevent. Routing therefore reads the raw cached row
 * and overlays only the rejection recorded against THAT account.
 */
export function authOf(profile: AccountIdentity, ctx: ViabilityContext): AccountAuth {
  if (ctx.rejected(profile.provider, profile.isDefault ? undefined : profile.id)) return 'disconnected';
  const row = profile.isDefault
    ? ctx.peekDefaultRowRaw(profile.provider)
    : ctx.peekProfileStatus(profile.provider, profile.id);
  if (row === undefined) return 'unknown';
  return row.status === 'connected' ? 'connected' : 'disconnected';
}

function tierOf(profile: ResolvedAgentProfile, auth: AccountAuth, usage: AgentAccountUsageStore, now?: number): AccountTier {
  if (auth === 'disconnected') return 'disconnected';
  const key = accountUsageKey(profile.provider, profile.isDefault ? undefined : profile.id);
  return isLimited(usageEntry(usage, key).limited, now) ? 'waitable' : 'runnable';
}

/**
 * ONE agent dispatch this action will cause, described exactly as the picker that places it will
 * see it. A run with a mixed-provider workflow produces one per distinct pinned dispatch.
 */
export interface DispatchRequirement {
  /** The provider this dispatch is pinned to, when something pins it. `undefined` only when
   *  nothing does and the route alone decides (a provider-less `pool:*`). */
  provider: ProviderId | undefined;
  /** The route the corresponding picker will parse, from the SAME expression it reads. Carries
   *  the account id when there is one. */
  route: AgentRoute;
  /** May the pickers move this dispatch off `provider`/`route`?
   *  - `false` for sites whose pin is a capability (Terminal / Open-in-CLI): always.
   *  - for everything else, `fallbackAcrossAccountsWhenLimited` for an `account` route, and `true`
   *    for a `pool` route (pool resolution reads no setting). */
  reroutable: boolean;
}

export interface ViabilityInput {
  /** Every enabled profile-capable account — `listAgentProfiles(accounts, PROFILE_CAPABLE_PROVIDERS)`. */
  profiles: readonly ResolvedAgentProfile[];
  usage: AgentAccountUsageStore;
  /** `authOf` from above, bound to a real `ViabilityContext` — raw peeks + rejection overlay. */
  auth: (p: ResolvedAgentProfile) => AccountAuth;
  disabledProviders: readonly ProviderId[];
  /** Every default row `GET /providers/status` knows about, across all four `PROVIDER_IDS`, not
   *  only the profile-capable two. Used for `anyConnectedAnywhere` and nothing else. */
  providerRows: readonly ProviderStatus[];
  /** One per dispatch this action will cause. Never empty. */
  requirements: readonly DispatchRequirement[];
}

/**
 * The EXACT candidate set the picker for this requirement would build. Exported and tested on its
 * own, because it is the whole disagreement risk between the gate and dispatch.
 *
 * | `req.route`                    | `req.provider` | `reroutable` | Candidates                                    |
 * |---------------------------------|----------------|--------------|------------------------------------------------|
 * | `{kind:'pool'}` (`pool:*`)      | `undefined`    | any          | every enabled profile-capable account          |
 * | `{kind:'pool'}` (`pool:*`)      | set            | any          | `req.provider`'s accounts only                 |
 * | `{kind:'pool', provider: p}`   | `undefined`    | any          | `p`'s accounts only                            |
 * | `{kind:'pool', provider: p}`   | set            | any          | `req.provider`'s accounts only                 |
 * | `{kind:'account', accountId}`  | either         | `false`      | exactly one: the named account, or the pinned  |
 * |                                 |                |              | provider's default when the id names none      |
 * | `{kind:'account', accountId}`  | either         | `true`       | every enabled profile-capable account          |
 */
export function candidatesFor(
  req: DispatchRequirement,
  input: ViabilityInput,
): readonly ResolvedAgentProfile[] {
  const enabled = input.profiles.filter((p) => !input.disabledProviders.includes(p.provider));
  const route = req.route;
  if (route.kind === 'pool') {
    const provider = req.provider ?? route.provider;
    return provider ? enabled.filter((p) => p.provider === provider) : enabled;
  }
  if (req.reroutable) return enabled;
  const provider = req.provider;
  if (provider === undefined) return [];
  const named = enabled.find(
    (p) => p.provider === provider && !p.isDefault && p.id === route.accountId,
  );
  if (named) return [named];
  const fallbackDefault = enabled.find((p) => p.provider === provider && p.isDefault);
  return fallbackDefault ? [fallbackDefault] : [];
}

export interface RequirementViability {
  requirement: DispatchRequirement;
  runnable: ResolvedAgentProfile[];
  waitable: ResolvedAgentProfile[];
  /** Reported for messages, metrics and notes; never selected. */
  disconnected: ResolvedAgentProfile[];
  /** Dispatch can land THIS requirement: `runnable` or `waitable` is non-empty. */
  placeable: boolean;
}

export interface Viability {
  requirements: RequirementViability[];
  /** `requirements.every(r => r.placeable)`. EVERY dispatch must have somewhere to go. */
  placeable: boolean;
  /** The pinned providers of the requirements that are NOT placeable, in `PROVIDER_IDS` order. */
  blocked: readonly ProviderId[];
  /** Across every enabled `PROVIDER_IDS` default row in `providerRows`, plus every enabled
   *  registered account: is ANYTHING authorized at all? */
  anyConnectedAnywhere: boolean;
  /** Narrower: is any ENABLED, profile-capable (`claude`/`codex`) account connected anywhere? */
  anyEligibleConnected: boolean;
}

/**
 * The whole gate/dispatch decision, read-only. Reads the accounts store, the usage store and the
 * auth cache; NEVER calls `resolvePoolForDispatch`, never calls `recordDispatch`, and therefore
 * never advances the round-robin cursor.
 */
export function assessAccountViability(input: ViabilityInput): Viability {
  const requirements: RequirementViability[] = input.requirements.map((requirement) => {
    const candidates = candidatesFor(requirement, input);
    const runnable: ResolvedAgentProfile[] = [];
    const waitable: ResolvedAgentProfile[] = [];
    const disconnected: ResolvedAgentProfile[] = [];
    for (const profile of candidates) {
      const auth = input.auth(profile);
      const tier = tierOf(profile, auth, input.usage);
      if (tier === 'disconnected') disconnected.push(profile);
      else if (tier === 'waitable') waitable.push(profile);
      else runnable.push(profile);
    }
    return {
      requirement,
      runnable,
      waitable,
      disconnected,
      placeable: runnable.length > 0 || waitable.length > 0,
    };
  });

  const placeable = requirements.every((r) => r.placeable);
  const blockedProviders = new Set(
    requirements
      .filter((r) => !r.placeable && r.requirement.provider !== undefined)
      .map((r) => r.requirement.provider as ProviderId),
  );
  const blocked = PROVIDER_IDS.filter((provider) => blockedProviders.has(provider));

  const enabledProviders = new Set(PROVIDER_IDS.filter((p) => !input.disabledProviders.includes(p)));
  const anyEligibleConnected = input.profiles.some(
    (p) => enabledProviders.has(p.provider) && input.auth(p) === 'connected',
  );
  const anyConnectedAnywhere =
    anyEligibleConnected ||
    input.providerRows.some((row) => enabledProviders.has(row.provider) && row.status === 'connected');

  return { requirements, placeable, blocked, anyConnectedAnywhere, anyEligibleConnected };
}

/**
 * The two JSON reads plus the peek closure, so callers do not each reassemble it. `repoRoot` is
 * accepted for parity with the rest of the workspace-resolution family (`resolveProfileEnvForRoot`,
 * `resolvePoolForDispatch`); Phase 1 has no per-repo read of its own — `disabledProviders` is
 * host-wide config the caller already has, and every requirement is built by the call site, which
 * already knows the repo it is asking about.
 */
export async function loadViabilityInput(
  repoRoot: string,
  providerAuth: ProviderAuthService,
  opts: {
    requirements: readonly DispatchRequirement[];
    disabledProviders?: readonly ProviderId[];
    providerRows?: readonly ProviderStatus[];
  },
): Promise<ViabilityInput> {
  void repoRoot;
  const [accounts, usage] = await Promise.all([loadAgentAccounts(), loadAgentAccountUsage()]);
  const profiles = listAgentProfiles(accounts, PROFILE_CAPABLE_PROVIDERS);
  const ctx = viabilityContextFor(providerAuth);
  return {
    profiles,
    usage,
    auth: (p) => authOf(p, ctx),
    disabledProviders: opts.disabledProviders ?? [],
    providerRows: opts.providerRows ?? providerAuth.peekStatus()?.providers ?? [],
    requirements: opts.requirements,
  };
}

/**
 * The context every production reader needs, in one place, so the three wiring sites
 * (`index.ts:791`, `index.ts:1057`, `project-context.ts:439`) and `loadViabilityInput` above share
 * one construction rather than three that could drift.
 */
export function viabilityContextFor(providerAuth: ProviderAuthService): ViabilityContext {
  return {
    rejected: (provider, profileId) => providerAuth.isRuntimeRejected(provider, profileId),
    peekDefaultRowRaw: (provider) => providerAuth.peekDefaultRowRaw(provider),
    peekProfileStatus: (provider, profileId) => providerAuth.peekProfileStatus(provider, profileId),
  };
}

/**
 * The `accountAuth` seam `RunManager` takes: `(provider, profileId) => AccountAuth`, matched
 * against `authOf`'s implementation — "resolves the correct peek per account kind and applies the
 * `runtimeRejections` overlay" (Architecture). `profileId` absent means the discovered default.
 */
export function accountAuthFromService(
  providerAuth: ProviderAuthService,
): (provider: ProviderId, profileId: string | undefined) => AccountAuth {
  const ctx = viabilityContextFor(providerAuth);
  return (provider, profileId) =>
    authOf({ provider, id: profileId ?? DEFAULT_AGENT_ACCOUNT_ID, isDefault: profileId === undefined }, ctx);
}
