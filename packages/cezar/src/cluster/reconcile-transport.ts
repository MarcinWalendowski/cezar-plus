import {
  clusterTodosBackupResponseSchema,
  storedClusterTodosAppendResponseSchema,
  storedClusterTodosSnapshotResponseSchema,
  type ClusterNodeId,
  type ClusterProjectKey,
  type StoredClusterTodoRecord,
} from '@loki-labs/better-cezar-contract';
import { signedNodeRequestHeaders } from './node-auth.ts';
import type { ClusterHomeOptions } from './node-identity.ts';
import { readPeers } from './peers.ts';
import type { RemoteReconcileTransport } from './reconcile.ts';
import type { TodoItem } from '../todos.ts';

/**
 * D21 (`.ai/specs/2026-08-22-multi-node-cezar-cluster.md`): the HTTP `RemoteReconcileTransport`,
 * run FROM the spoke AGAINST the hub — the direction E2 needs and the only one addressable at all
 * (a spoke has no inbound address, Problem §7). Every request is signed with
 * `node-auth.ts#signedNodeRequestHeaders` (D20); there is no unsigned fallback and none should ever
 * be added — an unsigned request to a node-authenticated route is refused `no-credentials` by
 * construction (`node-auth.ts`), so a fallback could only ever be dead code that looks like a
 * feature.
 *
 * `listProjects` is the one method that does NOT dial the hub: "every project THIS node has
 * confirmed paired with the peer" is this node's own local pairing store
 * (`cluster/peers.ts#readPeers`), not a round trip — the hub has nothing to answer that a spoke
 * does not already hold, and a spoke only ever pairs with its one hub in this design (D21: "a hub
 * reconciling against a spoke is out of scope, and stays out" — there is exactly one HTTP peer a
 * spoke can address at all).
 */

export interface HttpReconcileTransportOptions {
  /** This node's own identity — never re-derived from `loadNodeIdentity()` inside this file, so a
   *  test (or a future multi-hub caller) can hand it a synthetic one without touching the
   *  filesystem. `cluster/reconcile.ts#ReconcileOptions.peerNodeId` names WHICH peer a caller built
   *  this transport for; this is the CALLER's own identity, not the peer's. */
  readonly nodeId: ClusterNodeId;
  readonly secret: string;
  readonly hubUrl: string;
  /** Read by `listProjects` via `peers.ts#readPeers` — the injected env every sibling
   *  `ClusterHomeOptions` consumer takes, for the same testability reason. */
  readonly env?: NodeJS.ProcessEnv;
  /** Test hook: pins the clock `signedNodeRequestHeaders` reads when minting `issuedAt`. */
  readonly now?: () => number;
  /** Test hook: a fake `fetch` instead of the real global — matches
   *  `kb-submit-signing.test.ts`'s "real local HTTP server" idiom being preferred where possible,
   *  but some tests (dry-run wiring at the `reconcile.ts` level) want a transport with no network
   *  at all. Defaults to `globalThis.fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Every request this transport sends: three signed headers, plus `content-type` for a POST (which
 * always carries a body here, `''` for backup and a real JSON object for append) but never for a
 * GET (D20's own `signedNodeRequestHeaders` doc: "`''` for a bodyless request (every GET/DELETE in
 * this family)"). `bodyText` is always the EXACT string sent as the body — `signedNodeRequestHeaders`
 * defaults an omitted one to `''` internally either way, so the two are equivalent for the
 * signature; the distinction here is only about which headers a GET should carry.
 */
function signedFetchInit(options: HttpReconcileTransportOptions, method: 'GET' | 'POST', url: URL, bodyText: string): RequestInit {
  const signed = signedNodeRequestHeaders({
    nodeId: options.nodeId,
    secret: options.secret,
    method,
    url,
    bodyText,
    ...(options.now ? { now: options.now } : {}),
  });
  return {
    method,
    headers: method === 'GET' ? signed.headers : { 'content-type': 'application/json', ...signed.headers },
    body: method === 'GET' ? undefined : signed.body,
  };
}

/** Turns a non-2xx response into a message worth reading — the hub's own stated `reason` when it
 *  has one (`node-auth.ts`'s four named refusals, or `cluster-routes.ts`'s `unpaired-project`),
 *  a bare status otherwise. Never swallowed: `reconcile.ts#reconcileAll` catches per-project and
 *  logs whatever this throws, so the message is the whole of what an operator sees. */
async function describeFailure(route: string, res: Response): Promise<string> {
  const payload = (await res.json().catch(() => null)) as { error?: unknown; reason?: unknown } | null;
  const reason = payload && typeof payload.reason === 'string' ? ` (${payload.reason})` : '';
  const detail = payload && typeof payload.error === 'string' ? `: ${payload.error}` : '';
  return `${route} refused — HTTP ${res.status}${reason}${detail}`;
}

export function createHttpReconcileTransport(options: HttpReconcileTransportOptions): RemoteReconcileTransport {
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async listProjects(): Promise<ClusterProjectKey[]> {
      const peers = await readPeers({ env: options.env } satisfies ClusterHomeOptions);
      return peers.pairings
        .filter((pairing) => pairing.byNode[options.nodeId]?.confirmedAt)
        .map((pairing) => pairing.projectKey);
    },

    async list(projectKey: ClusterProjectKey): Promise<TodoItem[]> {
      const url = new URL(`/api/v1/cluster/todos/${encodeURIComponent(projectKey)}`, options.hubUrl);
      const res = await fetchImpl(url, signedFetchInit(options, 'GET', url, ''));
      if (!res.ok) throw new Error(await describeFailure(`GET /cluster/todos/${projectKey}`, res));
      const payload = storedClusterTodosSnapshotResponseSchema.parse(await res.json());
      return payload.todos.map(asTodoItem);
    },

    async backup(projectKey: ClusterProjectKey): Promise<string> {
      const url = new URL(`/api/v1/cluster/todos/${encodeURIComponent(projectKey)}/backup`, options.hubUrl);
      const res = await fetchImpl(url, signedFetchInit(options, 'POST', url, ''));
      if (!res.ok) throw new Error(await describeFailure(`POST /cluster/todos/${projectKey}/backup`, res));
      const payload = clusterTodosBackupResponseSchema.parse(await res.json());
      return payload.path;
    },

    async apply(projectKey: ClusterProjectKey, adds: readonly TodoItem[]): Promise<void> {
      if (adds.length === 0) return;
      const bodyText = JSON.stringify({ todos: adds });
      const url = new URL(`/api/v1/cluster/todos/${encodeURIComponent(projectKey)}/append`, options.hubUrl);
      const res = await fetchImpl(url, signedFetchInit(options, 'POST', url, bodyText));
      if (!res.ok) throw new Error(await describeFailure(`POST /cluster/todos/${projectKey}/append`, res));
      // Validated for shape (a malformed 200 is still a bug worth catching), but the parsed value
      // itself is not needed: `appendTodosPreservingIds`' idempotence already makes a retried
      // `apply` safe, and this method's own contract returns nothing.
      storedClusterTodosAppendResponseSchema.parse(await res.json());
    },
  };
}

/**
 * **CORRECTED 2026-08-23, before this shipped.** This docblock described the wire record as
 * "`clusterTodoRecordSchema`, `.strict()` … see its doc for why it is NOT `.passthrough()`" — an
 * argument for a design that was removed the same day, left sitting on the function that converts
 * the wire shape. `.strict()` REJECTS unknown keys rather than stripping them, so one field a newer
 * node wrote failed the entire snapshot response and 400'd `/append` — on the one path whose whole
 * purpose is a lossless cross-node backfill, and which `todos.ts#storedTodoSchema` was written for.
 *
 * **AMENDED 2026-08-23, same day.** The parsed wire record here is `StoredClusterTodoRecord`
 * (`storedClusterTodoRecordSchema`'s inferred type — this function is only ever called with what
 * `storedClusterTodosSnapshotResponseSchema`/`storedClusterTodosAppendResponseSchema` actually
 * parsed, both built on the stored twin; see `clusterTodoRecordSchema`'s own docblock in
 * `contract/src/cluster.ts` for why the RESPONSE schemas the parity check touches stay plain while
 * these two stored siblings carry the passthrough tolerance instead). `TodoItem` is additive-
 * optional over the same fields and its runtime values already carry extras (`readRaw` parses with
 * `storedTodoSchema`), so this stays a type-level relabel rather than a real conversion. Reconcile
 * trusts the HUB the same way it trusts this node's own disk.
 *
 * **No cast at all, checked rather than assumed.** `StoredClusterTodoRecord` carries a
 * `[k: string]: unknown` index signature `TodoItem` does not have (`TodoItem` is the PLAIN
 * `todoSchema`'s own infer — `todos.ts` keeps the same plain/stored split for the identical
 * reason this file does), so the two are nominally different shapes. But TS's excess-property
 * check only fires on a fresh object LITERAL, not on returning an already-typed variable, and
 * every field `TodoItem` requires is present and compatibly typed on `StoredClusterTodoRecord` —
 * so a plain `return record;` typechecks with no cast whatsoever. Verified directly: `tsc --noEmit
 * -p packages/cezar` stays green with the function body reduced to exactly `return record;`.
 */
function asTodoItem(record: StoredClusterTodoRecord): TodoItem {
  return record;
}
