/**
 * The cluster's transport is Cloudflare Tunnel only: the hub does not listen on a public port, it
 * binds `127.0.0.1` and is published through a tunnel, fronted by Cloudflare Access. Every
 * hub-bound request — the link's WS upgrade (`link-client.ts#ClusterLinkClient.dial()`) and every
 * reconcile HTTP call (`reconcile-transport.ts#createHttpReconcileTransport`) — crosses Access
 * before it ever reaches cezar. This file is the EDGE credential: extra headers that let this
 * machine through that outer door.
 *
 * **This is not, and must never be treated as, cezar's own node authentication.** That is D20
 * (`node-auth.ts`, `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`): a signed,
 * freshness-bounded, request-bound principal keyed on the per-node HMAC secret enrollment mints,
 * proving WHICH node is asking. The headers here prove something upstream and unrelated — that the
 * caller holds a credential Access's own policy admits, which today means "this is a machine we
 * trust enough to let it dial the hub at all," nothing more specific. The two are independent gates
 * IN SERIES, Access first and then D20, and neither substitutes for the other: a request carrying a
 * valid edge credential and no node credential is a stranger who got through the outer door: D20
 * still refuses it. A request carrying a valid node credential but no edge credential never reaches
 * the door in the first place. Cloudflare Access admits any principal holding the org's service
 * token, not a particular node, so trusting it as node identity would be exactly the mistake
 * `node-auth.ts`'s own docblock warns against for the perimeter it describes.
 *
 * **The two Cloudflare Access service-token header names are Cloudflare's, not invented here** —
 * confirmed 2026-08-23 against
 * https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/: `CF-Access-Client-Id`
 * and `CF-Access-Client-Secret`.
 *
 * **Fail closed, LOUDLY, on a half-configuration** — see `resolveEdgeAuthHeaders` below for the
 * reasoning. **Zero-config path preserved** — neither var set returns `undefined`, so a loopback or
 * same-host cluster (nothing in front of the hub to get past) needs nothing from this file at all,
 * and existing installs that have never heard of these two variables are unaffected byte-for-byte.
 */

const ACCESS_CLIENT_ID_VAR = 'CEZ_CLUSTER_ACCESS_CLIENT_ID';
const ACCESS_CLIENT_SECRET_VAR = 'CEZ_CLUSTER_ACCESS_CLIENT_SECRET';

/** The exact header names Cloudflare Access expects for a service token — see the module doc for
 *  where this was confirmed. Exported so a caller building a request by hand, or a test asserting
 *  on what actually reached the wire, never has to spell the string a second time. */
export const CLUSTER_ACCESS_CLIENT_ID_HEADER = 'CF-Access-Client-Id';
export const CLUSTER_ACCESS_CLIENT_SECRET_HEADER = 'CF-Access-Client-Secret';

/**
 * Thrown by `resolveEdgeAuthHeaders` when exactly one of the two env vars is set. Carries only
 * which var is MISSING and which is PRESENT — never either var's value — so a caller that logs
 * `.message` (or the error object itself) cannot leak the half-credential that was actually
 * supplied. See `secretNeverAppears` idiom in `edge-auth.test.ts`.
 */
export class ClusterEdgeAuthConfigError extends Error {
  constructor(
    readonly missingVar: typeof ACCESS_CLIENT_ID_VAR | typeof ACCESS_CLIENT_SECRET_VAR,
    readonly presentVar: typeof ACCESS_CLIENT_ID_VAR | typeof ACCESS_CLIENT_SECRET_VAR,
  ) {
    super(
      `cluster edge auth: ${presentVar} is set but ${missingVar} is not — a Cloudflare Access ` +
        'service token needs BOTH the client id and the client secret. Set both, or unset both to ' +
        'run this node with no edge credential at all.',
    );
    this.name = 'ClusterEdgeAuthConfigError';
  }
}

/**
 * Resolves the edge credential from the environment — `env` defaults to `process.env`, the same
 * `env ?? process.env` shape every sibling in this directory uses (`node-identity.ts#clusterModeFromEnv`).
 *
 * **Throws, deliberately, rather than warning-and-treating-as-absent, on a half-configuration.**
 * The only symptom of a silently-dropped half-credential would be Access answering every hub-bound
 * request with a 302/403 forever, surfacing several layers away as the link's endless
 * reconnect-with-backoff or a bare "HTTP 403" from reconcile — with nothing in either failure
 * naming a misconfigured environment variable as the cause. A `warn` path does not close that gap:
 * the callers this feeds (`ClusterLinkClientOptions.warn`, and `HttpReconcileTransportOptions`,
 * which has no warn channel at all today) make warning OPTIONAL and easy to miss in a noisy
 * startup log, so "warn and continue with no edge credential" is exactly the invisible failure this
 * guard exists to prevent. Throwing fails the boot (or the `cez cluster reconcile` invocation)
 * immediately, synchronously, with a message naming the missing variable — the one failure mode
 * that cannot be silently ignored.
 *
 * Returns `undefined` when NEITHER var is set — the zero-config path for a loopback or same-host
 * cluster with nothing in front of the hub to get past.
 */
export function resolveEdgeAuthHeaders(env?: NodeJS.ProcessEnv): Readonly<Record<string, string>> | undefined {
  const e = env ?? process.env;
  const id = e[ACCESS_CLIENT_ID_VAR]?.trim() || undefined;
  const secret = e[ACCESS_CLIENT_SECRET_VAR]?.trim() || undefined;

  if (!id && !secret) return undefined;
  if (!id) throw new ClusterEdgeAuthConfigError(ACCESS_CLIENT_ID_VAR, ACCESS_CLIENT_SECRET_VAR);
  if (!secret) throw new ClusterEdgeAuthConfigError(ACCESS_CLIENT_SECRET_VAR, ACCESS_CLIENT_ID_VAR);

  return {
    [CLUSTER_ACCESS_CLIENT_ID_HEADER]: id,
    [CLUSTER_ACCESS_CLIENT_SECRET_HEADER]: secret,
  };
}
