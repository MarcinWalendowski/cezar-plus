import { z } from 'zod';
import { providerIdSchema, type ProviderId } from './workspace.ts';
import { DEFAULT_AGENT_ACCOUNT_ID } from './agent-profiles.ts';

/**
 * Where a task's agent runs — one specific login, or a pool cezar balances across
 * (`.ai/specs/2026-08-16-agent-account-usage-routing.md`, Phase C).
 *
 * ## Why a pool is a reserved ID rather than a new field
 *
 * The choice already travels as a single string in five places: `runs.agentProfile`, the project's
 * stored selection, `POST /api/v1/runs`, the settings write, and the picker's `account` prop. A
 * second field would have to be threaded through every one of them, and every consumer that read
 * only the old field would silently keep routing to one account — a bug that looks exactly like
 * the feature working.
 *
 * So a pool is spelled in the field that already exists, in a namespace nothing else can occupy:
 * `AGENT_ACCOUNT_ID_RE` is `/^[a-z0-9][a-z0-9-]{0,63}$/`, which **cannot contain a colon**, so no
 * stored account id can ever collide with `pool:…` — the same argument that makes `default` safe as
 * a reserved id. An older reader that does not know the prefix hands `pool:claude` to
 * `selectProfile`, which finds no account with that id and degrades to the discovered default. That
 * is the documented degrade for an unknown id and it is the right one here: one real login, not a
 * crash and not a random account.
 *
 * ## What a pool is NOT
 *
 * Not a property of a running run. `parseAgentRoute` resolves once, at dispatch, and the concrete
 * account goes to `runs.profileId` — so a run always says which login it actually used, resume
 * reads that same login, and the thread header keeps meaning what it means. A pool that stayed
 * unresolved on the record would make "which account spent this" unanswerable after the fact.
 */

/** The namespace. A colon is what makes it unforgeable by a stored id. */
export const AGENT_POOL_PREFIX = 'pool:';

/** Every provider — "Balance across everything". Deliberately `pool:*`: `*` is not a provider id,
 *  so `pool:<provider>` and `pool:*` parse by the same rule with no second spelling. */
export const AGENT_POOL_ALL = `${AGENT_POOL_PREFIX}*`;

/** A pool over one provider's logins — `pool:claude`. */
export function agentPoolId(provider: ProviderId): string {
  return `${AGENT_POOL_PREFIX}${provider}`;
}

export const agentRouteSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('account'),
    /** `default` for the discovered account, else a stored slug. */
    accountId: z.string(),
  }),
  z.object({
    kind: z.literal('pool'),
    /** Absent = every provider. A pool row therefore picks the PROVIDER too, which is why the
     *  route sits above the per-provider selection map rather than inside it. */
    provider: providerIdSchema.optional(),
  }),
]);
export type AgentRoute = z.infer<typeof agentRouteSchema>;

/**
 * Read a stored/wire string as a route.
 *
 * Total: anything that is not a `pool:` id is an account id, including `undefined` (→ `default`)
 * and including garbage — because that is what `selectProfile` already does with an unknown id, and
 * having the parser disagree with the resolver would create a second definition of "unknown".
 *
 * `pool:` followed by something that is not a provider id or `*` is an ACCOUNT, not a pool: a value
 * cezar did not write must not be honoured as a routing instruction it cannot execute. It then
 * degrades to the default account like any other unknown id.
 */
export function parseAgentRoute(value: string | null | undefined): AgentRoute {
  if (!value) return { kind: 'account', accountId: DEFAULT_AGENT_ACCOUNT_ID };
  if (!value.startsWith(AGENT_POOL_PREFIX)) return { kind: 'account', accountId: value };
  const rest = value.slice(AGENT_POOL_PREFIX.length);
  if (rest === '*') return { kind: 'pool' };
  const provider = providerIdSchema.safeParse(rest);
  return provider.success
    ? { kind: 'pool', provider: provider.data }
    : { kind: 'account', accountId: value };
}

/** The inverse. Round-trips every value `parseAgentRoute` accepts as a pool. */
export function formatAgentRoute(route: AgentRoute): string {
  if (route.kind === 'account') return route.accountId;
  return route.provider ? agentPoolId(route.provider) : AGENT_POOL_ALL;
}

/** True for a string that names a pool — the one check a caller needs before treating a value as an
 *  account id. Cheaper to read at a call site than `parseAgentRoute(x).kind === 'pool'`. */
export function isAgentPoolId(value: string | null | undefined): boolean {
  return parseAgentRoute(value).kind === 'pool';
}
