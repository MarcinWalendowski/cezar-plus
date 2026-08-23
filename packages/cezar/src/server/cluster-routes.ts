import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { join } from 'node:path';
import {
  CLUSTER_PROTOCOL,
  type ClusterActiveResponse,
  type ClusterActiveRun,
  type ClusterAllocateResponse,
  type ClusterEnrollResponse,
  type ClusterEnrollRevokeResponse,
  type ClusterJoinResponse,
  type ClusterLeaseReleaseResponse,
  type ClusterLeaseResponse,
  type ClusterLinkHealth,
  type ClusterNode,
  type ClusterNodeId,
  type ClusterNodeRevokeResponse,
  type ClusterOverviewResponse,
  type ClusterPairing,
  type ClusterPairingProposal,
  type ClusterPairingsResponse,
  type ClusterProjectKey,
  type ClusterRemoteRun,
  type ClusterSelf,
  type ClusterTodosAppendResponse,
  type ClusterTodosBackupResponse,
  type ClusterTodosSnapshotResponse,
  clusterAllocateKindParamSchema,
  clusterAllocateRequestSchema,
  clusterCodeIdParamSchema,
  clusterCorpusSubmitRequestSchema,
  clusterEnrollRequestSchema,
  clusterJoinRequestSchema,
  clusterLeaseIdParamSchema,
  clusterLeaseKindParamSchema,
  clusterLeaseRequestSchema,
  clusterNodeIdParamSchema,
  clusterNodePatchSchema,
  clusterPairingActionSchema,
  clusterProjectKeyParamSchema,
  clusterTodosAppendRequestSchema,
  type StoredClusterNode,
  type StoredClusterPairing,
} from '@loki-labs/better-cezar-contract';
import { clusterEnabled } from './capabilities.ts';
import { jsonZodValidator, paramZodValidator } from './validators.ts';
import type { ProjectApiEnv } from './server.ts';
import { allocate } from '../cluster/allocate.ts';
import {
  createEnrollmentCode,
  redeemEnrollmentCode,
  revokeEnrollmentCode,
} from '../cluster/enrollment.ts';
import { acquireLease, releaseLease } from '../cluster/leases.ts';
import { createNodeAuthMiddleware, getAuthenticatedClusterNode } from '../cluster/node-auth.ts';
import { loadNodeIdentity } from '../cluster/node-identity.ts';
import { lookupNodeSecret as lookupStoredNodeSecret } from '../cluster/node-secrets.ts';
import { applyPairingAction, disableNode, readPeers, upsertNode } from '../cluster/peers.ts';
import { readRemoteRuns } from '../cluster/run-projection.ts';
import { loadServerState } from '../server-install/state.ts';
import { workspaceConfigPath } from '../paths.ts';
import { backupAndAppendTodosPreservingIds, backupTodos, readTodos, type TodoItem } from '../todos.ts';
import { loadWorkspaceConfig } from '../workspace/config.ts';

/**
 * The CLUSTER family of `/api/v1` (`CEZ_CLUSTER=1`). See
 * `.ai/specs/2026-08-22-multi-node-cezar-cluster.md` ("API contracts", "HTTP invariants",
 * "Security and blast radius") and `.ai/runs/2026-08-22-multi-node-cezar-cluster/PLAN.md` P3, 1.0.
 *
 * Chained into ONE family with an INFERRED return type and mounted into `workspaceV1` in
 * `server.ts` — workspace-level and single-mount, like `notes`/`workspace-runs`/`notifications`,
 * because a cluster answers for the whole machine and has no project-scoped spelling. **A route
 * defined but not chained vanishes from `AppType`**, taking the typed api-client and the cockpit
 * with it, and nothing fails loudly when it happens; every route below is a link in the one chain
 * `createClusterRoutes` returns.
 *
 * Bodies and params are validated as MIDDLEWARE (`./validators.ts`), never inside a handler: Hono
 * only records a validated shape in the route type when validation happens as middleware, so
 * parsing inline is invisible to `hc` and to `contract-parity.cluster.test.ts`.
 *
 * ## Flag off is a 409 — decided during implementation, after two wrong answers
 *
 * `requireCluster` below answers **409 with a stated reason** for every route of the family while
 * `CEZ_CLUSTER` is unset. That is spec Verification 12 as it now reads, and it took two rejected
 * drafts to get there. Both are recorded in the spec and in `contract/src/cluster.ts`'s header; the
 * short version, because a reader here will otherwise re-derive one of them:
 *
 *  - **200 with `enabled: false`** (`sources.ts`'s contract) is wrong: that shape exists because the
 *    Sources section is ALWAYS rendered and needs a schema-valid body to draw "not configured"
 *    with. A cluster that is off has no nav item and no section, so a 200 would be inventing a
 *    reader. Which is why `clusterOverviewResponseSchema` carries no `enabled` field at all.
 *  - **404** (which the spec's item 12 and this file both said first) is wrong because **404
 *    already means something else here**: `DELETE /cluster/nodes/:nodeId` answers 404 for an
 *    unknown node id, exactly as `sources-routes.ts` does for `UNKNOWN_CONNECTION`. A flag-off 404
 *    would be indistinguishable from an unknown id on the same route, in a family whose whole
 *    premise is that a refusal names itself.
 *
 * `automations` is the closest precedent and it settles the shape: a feature with no settings
 * section at all when off, answering `409 AUTOMATIONS_OFF` for every route of its family.
 *
 * **One 404 does survive, and it is not this one:** the COCKPIT's `/settings/cluster` route, which
 * the settings registry's `capability: 'cluster'` gate drops along with the nav entry. Asserting
 * only the missing nav item would pass against a reachable orphan route, which is why item 12 asks
 * for both.
 *
 * The gate is registered against EXPLICIT paths — `/cluster` and `/cluster/*` — and never
 * `use('*')`, for the reason `requireAutomations` in `server.ts` already had to learn: `route()`
 * re-registers a sub-app's middleware under the mount prefix, so a `'*'` here would gate the whole
 * of `/api/v1`, `/health` included. The two-line pairing is what makes a path match both the
 * collection and everything under it.
 *
 * The gate reads `clusterEnabled(env)` — its own exact-`'1'` reader in `./capabilities.ts` — and
 * deliberately NOT `clusterModeFromEnv()` from `../cluster/node-identity.ts`: this middleware runs
 * on every request to a cluster path, including while the cluster modules are still unimplemented
 * stubs, and a gate that throws answers 500 where the spec requires a stated 409.
 *
 * ## The link is NOT a route in this file
 *
 * `GET /api/v1/cluster/link` is a WebSocket upgrade and is handled where `ws.ts` handles its own —
 * on the `http.Server`'s `upgrade` event, via `ClusterLinkServer.attach()` — never by Hono. That is
 * a security boundary, not a routing convenience (spec → "Security and blast radius", Verification
 * 13): `ws.ts`'s guard admits browser ORIGINS, a node has no origin, and a node-authenticated
 * socket must never gain cockpit topics. `authenticateLinkUpgrade` verifies a signed,
 * freshness-bounded principal against the enrolled node's HMAC secret and consults no Origin header
 * at all. With no listener attached (the flag off, or before package 1.3 lands), a GET to that path
 * falls through to Hono's own 404 — `serveCockpitShell` passes `/api/*` through rather than
 * answering the SPA shell — rather than through the 409 gate above, which only covers the Hono
 * routes below it. That asymmetry is deliberate and harmless: an unattached upgrade is genuinely a
 * path that does not exist, not a feature refusing to answer.
 *
 * ## What is honestly not here yet
 *
 * The corpus family (`GET /cluster/corpus`, `GET /cluster/corpus/*path`,
 * `POST /cluster/corpus/submit`) has no module to call: there is no `cluster/corpus.ts` among the
 * sixteen, and package **3b.2** is what writes both the hub-side sweep and these bodies. They
 * answer a stated 409 until then — the same posture `sources-routes.ts` takes with
 * `SYNC_ENGINE_PENDING`, and for the same reason: a route that pretends is worse than a route that
 * says which package it is waiting for.
 *
 * ## D20 — which routes authenticate the NODE, and which do not
 *
 * `requireCluster` and `requireHub` answer two questions — is clustering on, and is this node the
 * hub — and NEITHER says which node is asking. `node-auth.ts#createNodeAuthMiddleware` (a signed,
 * freshness-bounded, request-bound principal keyed on the enrollment secret, D17/D20) answers that
 * third one, gated the same way as the two above — `.use()` on explicit paths, never `use('*')` or
 * inline in a handler.
 *
 * It is registered on the routes that are genuinely reached over the network by a REMOTE node and
 * serve or accept content scoped to one: the corpus family (`GET /cluster/corpus`,
 * `GET /cluster/corpus/*`, `POST /cluster/corpus/submit` — D8a's mirror scope and the one write
 * path the corpus has), plus `/cluster/todos/*` (D21's snapshot/backup/append trio, below —
 * **LANDED 2026-08-23**; this paragraph used to say the family was pre-wired for a route that did
 * not exist yet, which described the state before this package. All three route bodies additionally
 * scope themselves to a CONFIRMED pairing with `getAuthenticatedClusterNode(c).nodeId` via
 * `resolveHubTodosRoot` — node-auth alone says WHICH node is asking, never which project it may
 * ask about).
 *
 * Everything else in this file is answered LOCALLY, by whichever machine's own cockpit or `cez`
 * process asks its own local server — `GET /cluster`, the pairings and node-management routes, and
 * `GET /cluster/active` all read this node's own locally-mirrored state, and `/cluster/enroll` is
 * an operator action taken at the hub's own cockpit. None of those is a node authenticating itself
 * to another node, so node-auth is not on them.
 *
 * `POST /cluster/join` is excluded on purpose and would be a lockout bug if it weren't: it is the
 * enrollment handshake ITSELF, and a joining node has no secret yet to sign with.
 *
 * **CORRECTED 2026-08-23 (this package) — `/cluster/allocate/:kind` and `/cluster/leases/*` are
 * now IN the authenticated set, alongside `requireHub`, not instead of it.** The paragraph below
 * explains why they were held back and is kept for that reasoning, which mostly still holds; only
 * its conclusion is overturned. The first half — "the HUB has no secret of its own" — is still
 * literally true (`StoredClusterNodeIdentity#secret` is still spoke-only) but turned out not to
 * matter: verified by `grep -arn "allocate/" "leases/"` across `packages/{cezar,web,api-client,
 * contract}/src` (the four `.ts` files this repo silently classifies as `data` and skips without
 * `-a` are not among the matches, checked separately) — there is no HTTP client for either route
 * anywhere in this repo. `cluster/account-grants.ts` imports `acquireLease`/`releaseLease` straight
 * from `cluster/leases.ts`, not over HTTP, and nothing calls `allocate` remotely either. So the
 * "strand the hub's own local reservations" worry describes a caller that does not exist; there is
 * nothing to strand. The second half is the actual fix in this package: both handlers now attribute
 * to `getAuthenticatedClusterNode(c).nodeId` — the caller `requireNodeAuth` (below) established —
 * never to `loadNodeIdentity({env})`, which was always this SERVER's own local identity regardless
 * of who asked. Original text, describing the state before this package:
 *
 * `/cluster/allocate/:kind` and `/cluster/leases/*` are left OUT of the authenticated set too, and
 * that is a judgement call rather than an oversight — recorded here because the reasoning does not
 * fit in a `.use()` line. Two things are true about them today: the HUB has no secret of its own
 * (`StoredClusterNodeIdentity#secret` is documented spoke-only), so gating them uniformly would
 * strand the hub's own local reservations with no way to authenticate to itself; and both handlers
 * currently attribute every allocation/lease to `loadNodeIdentity({env})` — THIS SERVER's own local
 * identity — rather than to whoever the caller actually is, so establishing an authenticated caller
 * here without also fixing that attribution would produce a route that looks secured but silently
 * ignores the identity it just verified. Fixing the attribution is a change to these routes'
 * bodies, which is out of this package's scope (`cluster-routes.ts` handler bodies belong to the
 * packages that wrote them); flagged for whoever owns that fix rather than guessed at here.
 *
 * **CORRECTED 2026-08-23 (D22).** This paragraph used to read *"`lookupSecret`
 * (`ClusterRouteDeps#lookupNodeSecret`) has no real implementation wired below … the default fails
 * closed (`unknown-node` for every node), which is the correct, honest behaviour until a package
 * builds that store."* That store now exists — `cluster/node-secrets.ts`, D22 — and the default
 * below reads from it (`{env}` resolved to this call's own `env`, never the process's), so an
 * enrolled node is admitted with NO override needed; a node the store has never heard of still
 * fails closed as `unknown-node`, which is the correct behaviour for THAT case and not a
 * regression from before. `ClusterRouteDeps#lookupNodeSecret` stays as an override hook for a test
 * that wants a fake store instead of touching the filesystem.
 */

export interface ClusterRouteDeps {
  /** This node's cezar version. Pinned into the rendered `npx` join command rather than `@latest`
   *  (D13: protocol skew is permanent, so a node should start life matched to the hub that minted
   *  it), and reported on `self`. `server.ts` passes `deps.version`. */
  version: string;
  /** Injected so a test can pin the flag without mutating `process.env`. */
  env?: NodeJS.ProcessEnv;
  /**
   * D20: resolves a claimed node id to its enrollment secret, for `node-auth.ts`'s signed-principal
   * check on the routes that need it (see the module header's "D20" section for which). Omitted,
   * this defaults to `cluster/node-secrets.ts#lookupNodeSecret` (D22) — the real hub-side store,
   * reading this call's own resolved `env` — so a node that redeemed a code is admitted with no
   * override at all; a node the store has never heard of still fails closed as `unknown-node`. A
   * test that wants a fake store instead of touching the filesystem supplies this directly.
   */
  lookupNodeSecret?: (nodeId: ClusterNodeId) => Promise<string | undefined>;
  /** D20 test hook: pins the clock `node-auth.ts`'s freshness check reads. */
  now?: () => Date;
}

/** The default `lookupNodeSecret` — D22's real store, `cluster/node-secrets.ts#lookupNodeSecret`,
 *  read against THIS call's own resolved `env` (never `process.env` directly, matching every other
 *  reader in this file). See `ClusterRouteDeps#lookupNodeSecret`'s own doc. */
function storedNodeSecretLookup(env: NodeJS.ProcessEnv): (nodeId: ClusterNodeId) => Promise<string | undefined> {
  return (nodeId) => lookupStoredNodeSecret(nodeId, { env });
}

const CLUSTER_OFF =
  'clustering is disabled — set CEZ_CLUSTER=1 (and CEZ_CLUSTER_HUB=<url> to join one as a spoke) and restart cezar';
const NOT_A_HUB = 'this node is a spoke — enrollment, leases and allocation are hub-side only';
const NO_IDENTITY = 'this node has no cluster identity yet — run `cezar cluster join <code>` first';
const CORPUS_PENDING =
  'the corpus mirror is not available yet — the hub-side corpus sweep (plan 3b.2) has not landed; nothing is mirrored and nothing can be submitted';

/**
 * D21/D20's closing rule, in one message: "an authenticated spoke asking for a project it is not
 * paired with gets the same refusal as a stranger" — so this never distinguishes "no such
 * pairing", "pairing proposed but not confirmed by the caller", "confirmed by the caller but not
 * by this hub" or "confirmed, but this hub's own local project has since been deregistered". Every
 * one of those is the same 404 to the caller; see `resolveHubTodosRoot`'s own doc for why.
 */
const TODOS_PROJECT_REFUSED = 'no confirmed pairing between this hub and the asking node for that project';
/** Reached only if `requireNodeAuth` let a request through with no identity attached — a wiring
 *  bug (the middleware not actually running ahead of this handler), never a caller mistake. Shared
 *  by every node-auth-gated handler in this file (todos trio, allocate, leases), not just todos —
 *  named for what it means rather than for its first caller. */
const NO_AUTHENTICATED_NODE_ON_GATED_ROUTE = 'internal: no authenticated cluster node on a node-auth-gated route';

/**
 * In flight, for `GET /cluster/active`. `server.ts` counts `queued`/`running`/`waiting` for its
 * capacity number and stops there; this list adds `review` deliberately, because the question it
 * answers is D19 rung 3's — "does another run already hold this project's paths" — and a
 * review-gated run still holds its branch and its worktree. Verification 6b's negative control is
 * about a **finished** run not blocking, which `done`/`failed`/`cancelled` covers.
 */
const IN_FLIGHT_STATUSES = new Set(['queued', 'running', 'waiting', 'review']);

/**
 * The projection → `ClusterActiveRun[]` map, exported because `cez cluster active` in
 * `../index.ts` answers the same question from the same file and two spellings of "what is in
 * flight" would eventually disagree — the CLI's answer is what an agent reads before it starts
 * work, and the route's is what the overlap refusal reads.
 *
 * `summary` is agent- or human-authored text that another agent will read, and therefore an
 * injection surface (D19's closing rule): a consumer frames it as an attributed report — *"run
 * `r_123` on `worker-2` reported: …"* — and never merges it into a system prompt, never lets it
 * grant a capability, name a tool or widen an allowlist. Bounded here; that is necessary and not
 * sufficient.
 *
 * `paths` is empty until package **4.3** records the touched set at dispatch. Empty means "no paths
 * have been reported for this run", never "this run touches nothing" — `placement.ts#overlappingRun`
 * reads it and will simply find no overlap to name until that lands.
 */
export function clusterActiveRunsFrom(remote: readonly ClusterRemoteRun[]): ClusterActiveRun[] {
  return remote
    .filter((run) => IN_FLIGHT_STATUSES.has(run.status))
    .map((run) => ({
      runId: run.id,
      nodeId: run.nodeId,
      ...(run.projectKey !== undefined ? { projectKey: run.projectKey } : {}),
      summary: (run.titleSummary ?? run.title).slice(0, 500),
      ...(run.branch !== undefined ? { branch: run.branch.slice(0, 200) } : {}),
      paths: [],
      startedAt: run.startedAt ?? run.createdAt,
    }));
}

/** Corpus-relative, always. `.strict()` on the wire means a stored row's `.passthrough()` extras
 *  must be dropped by an explicit mapping rather than spread through — the omission is the
 *  mechanism that keeps an unexpected on-disk key off the wire. */
function toNodeWire(node: StoredClusterNode): ClusterNode {
  return {
    nodeId: node.nodeId,
    nodeName: node.nodeName,
    role: node.role,
    labels: node.labels,
    acceptsDispatch: node.acceptsDispatch,
    protocol: node.protocol,
    version: node.version,
    ...(node.lastSeenAt !== undefined ? { lastSeenAt: node.lastSeenAt } : {}),
    ...(node.capacity !== undefined ? { capacity: node.capacity } : {}),
    ...(node.capacityAt !== undefined ? { capacityAt: node.capacityAt } : {}),
    ...(node.hostMetrics !== undefined ? { hostMetrics: node.hostMetrics } : {}),
    ...(node.repoDrift !== undefined ? { repoDrift: node.repoDrift } : {}),
    ...(node.corpus !== undefined ? { corpus: node.corpus } : {}),
    ...(node.disabledAt !== undefined ? { disabledAt: node.disabledAt } : {}),
  };
}

function toPairingWire(pairing: StoredClusterPairing): ClusterPairing {
  const byNode: ClusterPairing['byNode'] = {};
  for (const [nodeId, member] of Object.entries(pairing.byNode)) {
    byNode[nodeId] = {
      nodeId: member.nodeId,
      projectId: member.projectId,
      ...(member.confirmedAt !== undefined ? { confirmedAt: member.confirmedAt } : {}),
    };
  }
  return { projectKey: pairing.projectKey, byNode };
}

/**
 * Discovered before configured, the shape `notifications-routes.ts#discoverCockpitUrl` already
 * settled: `CEZ_CLUSTER_HUB` (a spoke knows its hub's URL because it was told one), then
 * `CEZ_COCKPIT_URL`, then the `server-install` domain, then the request's own origin. The last is a
 * loopback address on a laptop and therefore useless in a pasted command — which is why it is last
 * and why the rendered command is what an operator copies, not a URL they assemble.
 */
function hubUrlFor(c: Context, env: NodeJS.ProcessEnv): string {
  const configured = env.CEZ_CLUSTER_HUB?.trim() || env.CEZ_COCKPIT_URL?.trim();
  if (configured) return configured;
  const state = loadServerState();
  if (state.domain) return `https://${state.domain}`;
  return new URL(c.req.url).origin;
}

/** The link's own health. Package 1.3 replaces this with the live client/server state; until then
 *  it reports what is true — a link that has never been established. `disabled` is reserved for the
 *  flag being off, which no handler in this family can observe (the gate answers 409 first), so the
 *  honest value here is `offline`. */
function linkHealth(): ClusterLinkHealth {
  return { state: 'offline' };
}

/**
 * D21's scoping rule for the whole `/cluster/todos/*` family: resolves `.ai/cezar` under THIS
 * hub's own local project for `projectKey`, but only when the confirmed pairing runs BOTH ways —
 * the asking node has confirmed it (`pairing.byNode[callerNodeId]?.confirmedAt`) AND this hub has
 * confirmed it too (`pairing.byNode[<this hub's own nodeId>]?.confirmedAt`). `undefined` for
 * anything short of that — no pairing row, an unconfirmed proposal, confirmed only by the caller,
 * or confirmed but pointing at a project id this hub's own registry no longer has — every one of
 * those is refused identically by the caller, never distinguished (D20's closing rule: "an
 * authenticated spoke asking for a project it is not paired with gets the same refusal as a
 * stranger").
 *
 * Reads `readPeers`/`loadNodeIdentity` (already exported, general-purpose) rather than
 * `peers.ts`'s own private `confirmedProjectsForNode` — that helper answers "this node's own
 * confirmed projects", which happens to be the right query for a SPOKE advertising itself
 * (`advertisedProjects`), but here the caller is the REMOTE node and the local side is always this
 * hub's own identity, two different node ids in the same lookup — reusing it would mean exporting
 * it and re-deriving which id plays which role at the call site anyway.
 */
async function resolveHubTodosRoot(
  projectKey: ClusterProjectKey,
  callerNodeId: ClusterNodeId,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const [peers, identity] = await Promise.all([readPeers({ env }), loadNodeIdentity({ env })]);
  if (!identity) return undefined;
  const pairing = peers.pairings.find((p) => p.projectKey === projectKey);
  if (!pairing) return undefined;
  if (!pairing.byNode[callerNodeId]?.confirmedAt) return undefined;
  const hubMember = pairing.byNode[identity.nodeId];
  if (!hubMember?.confirmedAt) return undefined;
  const config = await loadWorkspaceConfig(workspaceConfigPath(env));
  const project = config.projects.find((p) => p.id === hubMember.projectId);
  return project?.root;
}

/** `.ai/cezar` under a project root — the same join every other reader of `todos.json` uses
 *  (`project-context.ts`, `todo-cli.ts`, `index.ts`). Not exported elsewhere as a helper, so
 *  repeated here rather than imported, matching how each of those three call sites already does. */
function todosDataDir(projectRoot: string): string {
  return join(projectRoot, '.ai/cezar');
}

export function createClusterRoutes(deps: ClusterRouteDeps) {
  const env = deps.env ?? process.env;

  /**
   * Spec Verification 12, and `requireAutomations`'s shape verbatim. Written as MIDDLEWARE rather
   * than a line in each handler so the family cannot drift: a route added to the chain below
   * inherits the gate from its path, where a per-handler check is one omission away from an
   * ungated endpoint.
   */
  const requireCluster = async (c: Context, next: Next) => {
    if (!clusterEnabled(env)) return c.json({ error: CLUSTER_OFF }, 409);
    await next();
  };

  /**
   * Hub-only routes. A spoke that has never joined has no identity at all, which is a different
   * refusal from "you are a spoke" and is rendered as one.
   *
   * Registered with `use()` on explicit paths below, never passed inline to `.post(…)`/`.delete(…)`
   * — the trap `server.ts` documents at its `bodyLimit` registration: a bare `MiddlewareHandler`
   * handed to a route method **collapses that route's schema**, so the route quietly loses its
   * params and body and goes missing from `AppType` with nothing failing. It cost `PUT
   * /workspace/ui-state` its body once; it cost this file `:codeId` before `tsc` caught it as
   * `string | undefined`, which is the same bug wearing a friendlier face.
   */
  const requireHub = async (c: Context, next: Next) => {
    const identity = await loadNodeIdentity({ env });
    if (!identity) return c.json({ error: NO_IDENTITY }, 409);
    if (identity.role !== 'hub') return c.json({ error: NOT_A_HUB }, 409);
    await next();
  };

  /**
   * D20. Which routes get this is decided and justified in the module header's "D20" section, not
   * here — this is only the gate. `node-auth.ts` owns the signature/freshness/binding check and
   * the named refusals; this file owns nothing but wiring it onto the right paths, same rule as
   * `requireCluster`/`requireHub` above.
   */
  const requireNodeAuth = createNodeAuthMiddleware({
    lookupSecret: deps.lookupNodeSecret ?? storedNodeSecretLookup(env),
    ...(deps.now ? { now: deps.now } : {}),
  });

  return (
    new Hono<ProjectApiEnv>()
      // The gate, on explicit paths — see the module header for why never `use('*')`, and why the
      // answer is 409 rather than the 404 an earlier draft of Verification 12 asked for.
      .use('/cluster', requireCluster)
      .use('/cluster/*', requireCluster)
      // Hub-only, same mechanism and same explicit-path rule. Method-agnostic, which none of these
      // paths minds — every route under them is hub-side by definition.
      .use('/cluster/enroll', requireHub)
      .use('/cluster/enroll/*', requireHub)
      .use('/cluster/join', requireHub)
      .use('/cluster/allocate/*', requireHub)
      .use('/cluster/leases/*', requireHub)
      // D20, after `requireCluster` so the flag wins first (off answers 409, never 401) — the
      // corpus family (real content, scoped per node, D8a) plus `/cluster/todos/*` (D21's
      // snapshot/backup/append trio — landed as this wildcard's own routes below, each further
      // scoped to a confirmed pairing).
      .use('/cluster/corpus', requireNodeAuth)
      .use('/cluster/corpus/*', requireNodeAuth)
      .use('/cluster/todos/*', requireNodeAuth)
      // D20, added by this package: `requireHub` establishes ONLY that this server is a hub, never
      // who is asking — `/cluster/allocate/:kind` and `/cluster/leases/*` need both, since they now
      // attribute the allocation/lease to the caller (see the two handlers below, and the module
      // header's D20 section for why this was held back before). Registered AFTER `requireHub`,
      // same cheap-gate-first ordering the corpus/todos block above already follows relative to
      // `requireCluster`: a request to a non-hub still gets `requireHub`'s 409 NOT_A_HUB rather than
      // node-auth's 401, which is the more specific fact of the two.
      .use('/cluster/allocate/*', requireNodeAuth)
      .use('/cluster/leases/*', requireNodeAuth)

      // ---- roster ---------------------------------------------------------------------------
      .get('/cluster', async (c) => {
        const identity = await loadNodeIdentity({ env });
        const peers = await readPeers({ env });
        const self: ClusterSelf | undefined = identity
          ? {
              nodeId: identity.nodeId,
              nodeName: identity.nodeName,
              role: identity.role,
              labels: identity.labels,
              acceptsDispatch: identity.acceptsDispatch,
              protocol: CLUSTER_PROTOCOL,
              version: deps.version,
              ...(identity.hubUrl !== undefined ? { hubUrl: identity.hubUrl } : {}),
            }
          : undefined;
        const body: ClusterOverviewResponse = {
          // No `enabled` field: the gate above answers 409 when the flag is off, so a body that
          // reaches a reader could only ever say `true`. See `clusterOverviewResponseSchema`'s own
          // note and this file's header.
          ...(self ? { self } : {}),
          nodes: peers.nodes.map(toNodeWire),
          pairings: peers.pairings.map(toPairingWire),
          // Proposals are computed hub-side from what each spoke advertised on `hello`
          // (`peers.ts#proposePairings`), so they arrive with the link (package 1.3) rather than
          // being re-derived per request from a roster that does not carry the adverts.
          proposals: [] as ClusterPairingProposal[],
          link: linkHealth(),
        };
        return c.json(body);
      })

      // ---- enrollment (hub) -----------------------------------------------------------------
      .post(
        '/cluster/enroll',
        jsonZodValidator(clusterEnrollRequestSchema, { absent: {} }),
        async (c) => {
          const input = c.req.valid('json');
          const { response } = await createEnrollmentCode(
            { ...input, hubUrl: hubUrlFor(c, env), hubVersion: deps.version },
            { env },
          );
          const body: ClusterEnrollResponse = response;
          return c.json(body, 201);
        },
      )

      .delete(
        '/cluster/enroll/:codeId',
        paramZodValidator(clusterCodeIdParamSchema),
        async (c) => {
          const { codeId } = c.req.valid('param');
          const revoked = await revokeEnrollmentCode(codeId, { env });
          const body: ClusterEnrollRevokeResponse = { revoked };
          return c.json(body);
        },
      )

      /**
       * The hub's redeem endpoint — what a joining spoke DIALS. `cezar cluster join <code>` runs
       * `enrollment.ts#joinCluster` on the spoke, which posts a `ClusterJoinRequest` here; this
       * handler answers with the per-node HMAC secret or with one of the five named reasons.
       *
       * Answers 200 either way, `ok` discriminating: a refusal is a value the CLI and the cockpit
       * both branch on, and an operator who cannot tell `access-rejected` from `code-expired`
       * re-mints codes to fix a credential problem. An HTTP status cannot carry that distinction,
       * so it is not asked to.
       */
      .post('/cluster/join', jsonZodValidator(clusterJoinRequestSchema), async (c) => {
        const body: ClusterJoinResponse = await redeemEnrollmentCode(c.req.valid('json'), { env });
        return c.json(body);
      })

      // ---- nodes ----------------------------------------------------------------------------
      .patch(
        '/cluster/nodes/:nodeId',
        paramZodValidator(clusterNodeIdParamSchema),
        jsonZodValidator(clusterNodePatchSchema),
        async (c) => {
          const { nodeId } = c.req.valid('param');
          const patch = c.req.valid('json');
          const peers = await readPeers({ env });
          const current = peers.nodes.find((node) => node.nodeId === nodeId);
          if (!current) return c.json({ error: 'unknown node' }, 404);
          // D11: the hub RECORDS `acceptsDispatch` and the spoke re-enforces it — a node refuses
          // work it has not opted into regardless of what is written here.
          const updated = await upsertNode(
            {
              ...current,
              ...(patch.nodeName !== undefined ? { nodeName: patch.nodeName } : {}),
              ...(patch.acceptsDispatch !== undefined
                ? { acceptsDispatch: patch.acceptsDispatch }
                : {}),
            },
            { env },
          );
          const body: ClusterNode = toNodeWire(updated);
          return c.json(body);
        },
      )

      /** The HUB half of a two-sided revoke. The spoke half — deleting its credential — is
       *  `cezar cluster revoke` / `enrollment.ts#leaveCluster`, and without it a revoked spoke
       *  keeps pushing ops (spec → "Security and blast radius" 5). */
      .delete(
        '/cluster/nodes/:nodeId',
        paramZodValidator(clusterNodeIdParamSchema),
        async (c) => {
          const revoked = await disableNode(c.req.valid('param').nodeId, { env });
          const body: ClusterNodeRevokeResponse = { revoked };
          return c.json(body);
        },
      )

      // ---- pairings (D2) --------------------------------------------------------------------
      .get('/cluster/pairings', async (c) => {
        const peers = await readPeers({ env });
        const body: ClusterPairingsResponse = {
          // As on `GET /cluster`: proposals are computed from the adverts the link carries.
          proposals: [] as ClusterPairingProposal[],
          pairings: peers.pairings.map(toPairingWire),
        };
        return c.json(body);
      })

      .post(
        '/cluster/pairings/:projectKey',
        paramZodValidator(clusterProjectKeyParamSchema),
        jsonZodValidator(clusterPairingActionSchema),
        async (c) => {
          const { projectKey } = c.req.valid('param');
          const pairing = await applyPairingAction(projectKey, c.req.valid('json'), { env });
          const peers = await readPeers({ env });
          const body: ClusterPairingsResponse = {
            proposals: [] as ClusterPairingProposal[],
            // `unpair` returns undefined; answering with the whole list rather than the one row
            // keeps confirm and unpair on one response shape the cockpit can re-render from.
            pairings: pairing
              ? peers.pairings.map(toPairingWire)
              : peers.pairings.filter((row) => row.projectKey !== projectKey).map(toPairingWire),
          };
          return c.json(body);
        },
      )

      // ---- corpus (D8a) — scaffold until package 3b.2 ----------------------------------------
      // Registered exact-before-wildcard so `/cluster/corpus` cannot be swallowed by the
      // one-document path below.
      .get('/cluster/corpus', (c) => c.json({ error: CORPUS_PENDING }, 409))

      /**
       * **The one param in this family that is NOT middleware-validated, deliberately.** Every
       * other path param goes through `paramZodValidator` so hono records the shape in the route
       * type; this one cannot, and the reason is a guard rather than an oversight.
       *
       * `clusterCorpusPathParamSchema` needs a NAMED param to bind to, which in hono means
       * `/cluster/corpus/:path{.+}` — and `bc-route-inventory.test.ts` brace-expands every
       * backticked path in `BACKWARD_COMPATIBILITY.md` §2, so the doc entry for that spelling
       * expands `{.+}` to `.+` and stops matching the registered route. The fix would be editing
       * that guard's `expandBraces`, which is relaxing an assertion to make a suite pass. So the
       * route keeps the plain wildcard and the inventory keeps matching.
       *
       * **Package 3b.2 therefore owns two checks this scaffold cannot do for it:** parse
       * `c.req.param('*')` with `clusterCorpusPathParamSchema` at the top of the handler, and then
       * refuse a path outside the asking node's mirror scope. A wildcard is the one segment a
       * caller composes freely, so "it parsed" is not "it is in scope" — `reports/` is off by
       * default because it is 196 files carrying phone numbers and chat ids.
       */
      .get('/cluster/corpus/*', (c) => c.json({ error: CORPUS_PENDING }, 409))

      .post(
        '/cluster/corpus/submit',
        jsonZodValidator(clusterCorpusSubmitRequestSchema),
        (c) => c.json({ error: CORPUS_PENDING }, 409),
      )

      // ---- todos snapshot, backup, append (D21) ----------------------------------------------
      /** `RemoteReconcileTransport#list` (`cluster/reconcile.ts`, run from `cluster/reconcile-
       *  transport.ts` on the SPOKE against this hub). Scoped by `resolveHubTodosRoot` — never by
       *  a header or a body field, only by the identity `requireNodeAuth` (D20) established. */
      .get(
        '/cluster/todos/:projectKey',
        paramZodValidator(clusterProjectKeyParamSchema),
        async (c) => {
          const { projectKey } = c.req.valid('param');
          const node = getAuthenticatedClusterNode(c);
          if (!node) return c.json({ error: NO_AUTHENTICATED_NODE_ON_GATED_ROUTE }, 500);
          const root = await resolveHubTodosRoot(projectKey, node.nodeId, env);
          if (!root) return c.json({ error: TODOS_PROJECT_REFUSED, reason: 'unpaired-project' }, 404);
          // No cast: `readTodos` parses with `storedTodoSchema`, so the runtime value ALREADY
          // carries any field a newer node wrote (D13), and `TodoItem` structurally satisfies
          // `ClusterTodosSnapshotResponse.todos`'s element type (`clusterTodoRecordSchema`, plain)
          // as-is — nothing here strips an extra field and nothing here rejects one, this route
          // serializes whatever `readTodos` actually returned, verbatim.
          //
          // `clusterTodoRecordSchema` is named on the response type on purpose, and the tolerance
          // lives one layer out: `contract-parity.cluster.test.ts` compares this route against
          // `z.infer<>` through Hono's `InferResponseType`, which disagrees with a passthrough
          // schema's inferred type in that specific deferred-generic comparison, so a passthrough
          // RESPONSE schema fails parity by construction (`contract/src/cluster.ts`'s
          // `clusterTodoRecordSchema` docblock, "AMENDED 2026-08-23", has the measured detail). The
          // split is therefore three-way rather than two — plain schema for the type and the parity
          // check, and a `stored*` passthrough twin (`storedClusterTodosSnapshotResponseSchema`)
          // that the SPOKE's transport parses the reply with (`cluster/reconcile-transport.ts`). The
          // contract names the fields it guarantees; the parse site is the one that must not reject
          // the rest, and it is the only place a rejection could actually happen — this route itself
          // never calls `.parse()` on its own response, so its `.strict()` response schema costs
          // nothing on the wire.
          const todos = await readTodos(todosDataDir(root));
          const body: ClusterTodosSnapshotResponse = { projectKey, todos };
          return c.json(body);
        },
      )

      /** `RemoteReconcileTransport#backup` — called before the FIRST mutation of a reconcile
       *  pass, whether or not this peer ends up receiving any adds (`/append` below takes its OWN
       *  backup for the case that does — D21's amendment; the two are not redundant, see
       *  `todos.ts#backupAndAppendTodosPreservingIds`'s own doc). */
      .post(
        '/cluster/todos/:projectKey/backup',
        paramZodValidator(clusterProjectKeyParamSchema),
        async (c) => {
          const { projectKey } = c.req.valid('param');
          const node = getAuthenticatedClusterNode(c);
          if (!node) return c.json({ error: NO_AUTHENTICATED_NODE_ON_GATED_ROUTE }, 500);
          const root = await resolveHubTodosRoot(projectKey, node.nodeId, env);
          if (!root) return c.json({ error: TODOS_PROJECT_REFUSED, reason: 'unpaired-project' }, 404);
          const path = await backupTodos(todosDataDir(root));
          const body: ClusterTodosBackupResponse = { path };
          return c.json(body);
        },
      )

      /** `RemoteReconcileTransport#apply` — appends rows verbatim (id/`ts`/`author` intact,
       *  reconcile never rewrites a field), idempotent by id. Backup-then-append under ONE lease
       *  (`todos.ts#backupAndAppendTodosPreservingIds`, D21's amendment) — never composed here from
       *  `backupTodos` + a separate append call, which would re-open the exact gap the amendment
       *  closes. */
      .post(
        '/cluster/todos/:projectKey/append',
        paramZodValidator(clusterProjectKeyParamSchema),
        jsonZodValidator(clusterTodosAppendRequestSchema),
        async (c) => {
          const { projectKey } = c.req.valid('param');
          const node = getAuthenticatedClusterNode(c);
          if (!node) return c.json({ error: NO_AUTHENTICATED_NODE_ON_GATED_ROUTE }, 500);
          const root = await resolveHubTodosRoot(projectKey, node.nodeId, env);
          if (!root) return c.json({ error: TODOS_PROJECT_REFUSED, reason: 'unpaired-project' }, 404);
          const { todos } = c.req.valid('json');
          // **CORRECTED 2026-08-23, before this shipped.** This read "The wire shape is
          // passthrough-by-design (`clusterTodoRecordSchema`'s own doc)", which was true of an
          // earlier draft and then survived the change that made that schema `.strict()` — so it
          // credited passthrough to the one schema that no longer had it, and made a real defect
          // (a row from a newer node 400ing here) read as intentional. The passthrough is
          // `storedClusterTodoRecordSchema`, the twin `clusterTodosAppendRequestSchema` (this
          // route's REQUEST validator, above) actually validates with — that is the one real
          // runtime gate on this data, so it is the one schema that must carry the tolerance
          // directly; `clusterTodoRecordSchema` stays plain for the TYPE and the contract-parity
          // check. Same split as `todoSchema`/`storedTodoSchema` and `clusterOpSchema`/
          // `storedClusterOpSchema`. Trusting the hub's own paired peer the same way `readRaw`
          // trusts this node's own disk.
          //
          // No cast either side: `todos`' element type (`StoredClusterTodoRecord`, from the
          // request validator above) structurally satisfies `backupAndAppendTodosPreservingIds`'
          // `TodoItem` parameter as-is, and its `TodoItem[]` return structurally satisfies
          // `ClusterTodosAppendResponse.appended`'s plain `clusterTodoRecordSchema` element type —
          // same reasoning as the GET handler above for why the plain RESPONSE schema costs
          // nothing on the wire (this route never `.parse()`s its own response either).
          const { backupPath, appended } = await backupAndAppendTodosPreservingIds(todosDataDir(root), todos);
          const body: ClusterTodosAppendResponse = { appended, backupPath };
          return c.json(body);
        },
      )

      // ---- what else is in flight (D19 rung 4) -----------------------------------------------
      /** Backs `cezar cluster active` — a read an agent can already make over the `Bash` + `cez`
       *  surface it has, with no MCP server involved. Both spellings share
       *  `clusterActiveRunsFrom` above; see its doc for the injection rule `summary` carries and
       *  for why `paths` is empty until package 4.3. */
      .get('/cluster/active', async (c) => {
        const runs = clusterActiveRunsFrom(await readRemoteRuns({ env }));
        const body: ClusterActiveResponse = { runs, asOf: new Date().toISOString() };
        return c.json(body);
      })

      // ---- the reserving allocator (D19 rung 2) ----------------------------------------------
      /** Unlike `tools/next-spec`, which reads one checkout and reserves NOTHING, this hands out
       *  and RECORDS in one lease. Skipping it is the single place this design would make
       *  multi-node worse than one machine.
       *
       *  Attributed to `getAuthenticatedClusterNode(c).nodeId` — the caller `requireNodeAuth`
       *  established above — not to `loadNodeIdentity({env})`, which is always THIS server's own
       *  local identity regardless of who asked. See the module header's D20 section (the
       *  "CORRECTED 2026-08-23 (this package)" paragraph) for why the earlier attribution was a
       *  bug and why gating this route without fixing it would have been worse than leaving it
       *  open. */
      .post(
        '/cluster/allocate/:kind',
        paramZodValidator(clusterAllocateKindParamSchema),
        jsonZodValidator(clusterAllocateRequestSchema, { absent: {} }),
        async (c) => {
          const node = getAuthenticatedClusterNode(c);
          if (!node) return c.json({ error: NO_AUTHENTICATED_NODE_ON_GATED_ROUTE }, 500);
          const body: ClusterAllocateResponse = await allocate(
            c.req.valid('param').kind,
            node.nodeId,
            c.req.valid('json'),
            { env },
          );
          return c.json(body, 201);
        },
      )

      // ---- leases (D15b) ---------------------------------------------------------------------
      /** What is still a lease after D4/D9a: what guards a RESOURCE rather than a record. A claim
       *  is not here — the hub linearizes, so its acknowledgement IS the stamp.
       *
       *  Same attribution fix as the allocator above: the holder is the AUTHENTICATED caller, not
       *  this server's own identity. */
      .post(
        '/cluster/leases/:kind',
        paramZodValidator(clusterLeaseKindParamSchema),
        jsonZodValidator(clusterLeaseRequestSchema),
        async (c) => {
          const node = getAuthenticatedClusterNode(c);
          if (!node) return c.json({ error: NO_AUTHENTICATED_NODE_ON_GATED_ROUTE }, 500);
          const body: ClusterLeaseResponse = await acquireLease(
            c.req.valid('param').kind,
            node.nodeId,
            c.req.valid('json'),
            { env },
          );
          return c.json(body);
        },
      )

      .delete(
        '/cluster/leases/:kind/:id',
        paramZodValidator(clusterLeaseIdParamSchema),
        async (c) => {
          const { kind, id } = c.req.valid('param');
          const node = getAuthenticatedClusterNode(c);
          if (!node) return c.json({ error: NO_AUTHENTICATED_NODE_ON_GATED_ROUTE }, 500);
          // `false` when this node is not the recorded holder: releasing someone else's lease is
          // the bug this return value exists to make visible, not a no-op to swallow.
          const released = await releaseLease(kind, id, node.nodeId, { env });
          const body: ClusterLeaseReleaseResponse = { released };
          return c.json(body);
        },
      )
  );
}

export interface ClusterRuntimeDeps {
  version: string;
  env?: NodeJS.ProcessEnv;
  warn?: (message: string) => void;
}

/**
 * The ONE wiring line `server.ts` carries for this feature, beside the existing
 * `providerRuntimeAuth.watch` / `watchTodoAutostart` block — the single place the link
 * (`cluster/link-{client,server}.ts`, package 1.3), the periodic full reconcile
 * (`cluster/reconcile.ts#startPeriodicReconcile`, package 2.4) and the run-projection observer
 * (`cluster/run-projection.ts`, package 3.4) get attached. It lives here rather than in `server.ts`
 * so those packages fill a body in a file they can be given, instead of each editing the one file
 * twenty concurrent agents share (PLAN P3).
 *
 * **With `CEZ_CLUSTER` unset this returns immediately having armed nothing** — no timer, no socket,
 * no file under `~/.cezar/cluster` or `.ai/cezar/cluster` — which is the half of Verification 12
 * that neither a `capabilities` assertion nor a route probe can see.
 *
 * Returns the stop function, the disposal shape used throughout this codebase.
 */
export function startClusterRuntime(deps: ClusterRuntimeDeps): () => void {
  const env = deps.env ?? process.env;
  if (!clusterEnabled(env)) return () => {};
  // Reached only with the flag on. Nothing is armed yet: the link, the reconcile timer and the run
  // projection are packages 1.3, 2.4 and 3.4 of
  // `.ai/runs/2026-08-22-multi-node-cezar-cluster/PLAN.md`. Said out loud rather than left as a
  // silent no-op, because a cluster that is enabled and inert looks exactly like one that is
  // working until somebody asks a second node a question.
  (deps.warn ?? console.warn)(
    'CEZ_CLUSTER=1: the cluster routes are served, but the node link and the periodic reconcile have not landed yet (plan packages 1.3 / 2.4) — no node will connect and nothing replicates.',
  );
  return () => {};
}
