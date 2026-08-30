import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import {
  CLUSTER_PROTOCOL,
  type ClusterActiveResponse,
  type ClusterActiveRun,
  type ClusterAllocateResponse,
  type ClusterCorpusBodiesResponse,
  type ClusterCorpusDocResponse,
  type ClusterCorpusManifestResponse,
  type ClusterCorpusSubmitResponse,
  type ClusterEnrollResponse,
  type ClusterEnrollRevokeResponse,
  type ClusterJoinResponse,
  type ClusterLeaseReleaseResponse,
  type ClusterLeaseResponse,
  type ClusterLinkHealth,
  type ClusterNode,
  type ClusterNodeId,
  type ClusterNodeRevokeResponse,
  type ClusterOp,
  type ClusterOverviewResponse,
  type ClusterPairingProposal,
  type ClusterPairingsResponse,
  type ClusterProjectKey,
  type ClusterRemoteRun,
  type ClusterSelf,
  type ClusterTodosAppendResponse,
  type ClusterTodosBackupResponse,
  type ClusterTodosSnapshotResponse,
  type StoredClusterNode,
  clusterAllocateKindParamSchema,
  clusterAllocateRequestSchema,
  clusterCodeIdParamSchema,
  clusterCorpusBodiesRequestSchema,
  clusterCorpusManifestQuerySchema,
  clusterCorpusPathParamSchema,
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
  type StoredClusterNodeIdentity,
  CLUSTER_CORPUS_DEFAULT_SCOPE,
} from '@loki-labs/cezar-plus-contract';
import { clusterEnabled } from './capabilities.ts';
import { jsonZodValidator, paramZodValidator, queryZodValidator } from './validators.ts';
import type { ProjectApiEnv } from './server.ts';
import { allocate } from '../cluster/allocate.ts';
import {
  createEnrollmentCode,
  redeemEnrollmentCode,
  revokeEnrollmentCode,
} from '../cluster/enrollment.ts';
import { applyOpAtHub } from '../cluster/hub-apply.ts';
import { createHubFrameRouter, type HubReplicationDeps } from '../cluster/hub-router.ts';
import { createHubDispatcher, type HubDispatcher } from '../cluster/hub-dispatch.ts';
import { createHubAutostartDispatch } from '../cluster/hub-autostart-dispatch.ts';
import {
  armClusterAutostart,
  createHubAutostartCluster,
  createSpokeAutostartCluster,
} from '../cluster/autostart-seam.ts';
import { DISPATCH_LOCAL } from '../todo-autostart.ts';
import type { HubOpOutcome } from '../cluster/hub-ops.ts';
import { createHubSeqAllocator } from '../cluster/hub-seq.ts';
import { acquireLease, releaseLease } from '../cluster/leases.ts';
import { ClusterLinkClient } from '../cluster/link-client.ts';
import { toNodeWire, toPairingWire } from '../cluster/wire.ts';
import { ClusterLinkServer, type UpgradeCapableServer } from '../cluster/link-server.ts';
import { createNodeAuthMiddleware, getAuthenticatedClusterNode } from '../cluster/node-auth.ts';
import {
  buildManifest,
  isPathInScope,
  readDoc,
  readDocs,
  resolveCorpusRoot,
  scopeForNode,
} from '../cluster/corpus-store.ts';
import { clusterModeFromEnv, loadNodeIdentity, nodeIdentityPath } from '../cluster/node-identity.ts';
import { lookupNodeSecret as lookupStoredNodeSecret } from '../cluster/node-secrets.ts';
import { createOpHistoryStore, OP_HISTORY_PRUNE_INTERVAL_MS } from '../cluster/op-history.ts';
import { startHubOutbox } from '../cluster/hub-outbox.ts';
import { createCorpusBroadcaster } from '../cluster/corpus-broadcast.ts';
import { setCorpusChangeListener } from '../cluster/corpus-change-bus.ts';
import { startCorpusMirrorRuntime } from '../cluster/corpus-mirror-runtime.ts';
import { startSpokeRuntime, type SpokeRuntimeHandle } from '../cluster/spoke-runtime.ts';
import { advertisedProjects, applyPairingAction, disableNode, readPeers, upsertNode } from '../cluster/peers.ts';
import type { ClusterHomeOptions } from '../cluster/node-identity.ts';
import { readRemoteRuns } from '../cluster/run-projection.ts';
import { loadServerState } from '../server-install/state.ts';
import { workspaceConfigPath } from '../paths.ts';
import { backupAndAppendTodosPreservingIds, backupTodos, readTodos, type TodoItem } from '../todos.ts';
import { loadWorkspaceConfig } from '../workspace/config.ts';
import { WorkspaceRunIndex, type WorkspaceRunProjectSource } from '../workspace/run-index.ts';
import type { RunManager } from '../workflows/run.ts';
import type { WorkspaceSemaphore } from '../workspace/semaphore.ts';

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
 * ## The corpus family (package 3b.2, D8a) — what is here and what is honestly not
 *
 * `GET /cluster/corpus` (manifest, `?since=`), `GET /cluster/corpus/*path` (one document),
 * `POST /cluster/corpus/bodies` (batch, S2 of the 2026-08-24 handoff item) and
 * `POST /cluster/corpus/submit` (the one write direction, D8/D8a) all read/write through
 * `../cluster/corpus-store.ts`, never re-deriving scope or path logic here — `isPathInScope` is
 * called from the single-document, batch AND submit handlers so the three cannot drift apart.
 * All four still answer the SAME stated 409 (a new message, not `CORPUS_PENDING`) when
 * `resolveCorpusRoot` finds no corpus configured on this hub — a route that pretends is worse than
 * one that says what is missing, same posture `sources-routes.ts` takes with `SYNC_ENGINE_PENDING`.
 *
 * `GET /cluster/corpus`'s `scope` query parameter is a narrowing HINT ONLY, never trusted as
 * authorization — see `node-auth.ts#signedNodeRequestHeaders`'s own doc for why the signature
 * cannot cover it and what that would otherwise let a captured header pair do. The entitled scope
 * always comes from `scopeForNode` reading this node's OWN roster row, freshly, per request.
 *
 * **`POST /cluster/corpus/submit` implements two of the four refusal reasons its response schema
 * declares — `out-of-scope` and `stale-base` — and leaves `too-large` and `read-only-path`
 * unreached, on purpose.** `too-large` is already unreachable through this schema: the request
 * body is capped at 1MB by `clusterCorpusSubmitRequestSchema` itself, so an oversized submission
 * 400s at the validator and never reaches this handler; a hub-side cap smaller than the wire cap
 * would be a new policy this package was not asked to invent. `read-only-path` has no policy
 * anywhere in the spec naming which corpus paths, if any, are read-only server-side — flagged for
 * whoever owns that decision rather than guessed at here. `stale-base` is optimistic concurrency
 * keyed on `readDoc`'s own `hash` (the same value the manifest and single-document routes already
 * hand out as `ClusterCorpusDoc.hash`/`ClusterCorpusBody.hash`) — a submitter who never fetched the
 * document, or whose `baseVersion` no longer matches, is refused rather than silently clobbering a
 * concurrent write.
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
 * **CORRECTED 2026-08-24 — `GET /cluster/active` is no longer permanently empty in production.**
 * This paragraph used to say the route's "locally-mirrored state" was real but permanently empty,
 * because its only feed was `run-projection.ts`'s `runs-remote.json`, whose writers (`applyRemoteRuns`,
 * `markNodeUnreachable`) have zero production callers. That projection is still dead — Milestone D
 * (weeks, ops-gated) is still what wires it — but it is no longer the route's only source: every
 * node now reports its own in-flight runs on its `presence` frame (`clusterNodeShape#active`), the
 * roster persists it (`peers.ts#markNodeSeen`), and the route unions the roster
 * (`clusterActiveRunsFromRoster`) with the still-dead projection (`mergeActiveRuns`) so the route
 * does not depend on Milestone D landing to answer anything. What is still true from the original
 * paragraph: this route — like `linkHealth()` below — reports what is true rather than fabricating
 * activity, and `asOf` (`clusterActiveResponseSchema`'s own doc) is `undefined` whenever no linked
 * roster node has ever reported, rather than a wall-clock-now that would paper over that gap.
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
/** All four corpus routes answer this 409 when `resolveCorpusRoot` finds nothing configured on
 *  this hub — the same shape the earlier `CORPUS_PENDING` scaffold answered while package 3b.2 was
 *  unwritten, with a new message: it is no longer "the route is unbuilt", it is "this hub has no
 *  corpus to serve". */
const CORPUS_ROOT_UNCONFIGURED =
  'this hub has no corpus root configured — nothing is mirrored and nothing can be submitted';
/** `GET /cluster/corpus/*path` and the `bodies` batch route answer this for both a genuinely
 *  missing document and one outside the asking node's mirror scope — deliberately the SAME
 *  refusal, so a caller can never learn which out-of-scope paths exist (mirrors
 *  `clusterCorpusBodiesResponseSchema.missing`'s own doc). */
const CORPUS_DOC_NOT_FOUND = 'no such document in the corpus mirror scope for this node';

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
 * How often the hub sweeps its own unanswered dispatches (`HubDispatcher#sweepUnanswered`).
 *
 * Deliberately well under `DEFAULT_DISPATCH_TIMEOUT_MS` (90s) rather than equal to it: the sweep
 * decides *when a record older than the timeout is noticed*, not what the timeout is, so a cadence
 * equal to the timeout would let a record sit up to 180s before being labelled. It is also NOT the
 * op-history cadence — that one prunes a durable file and is sized for a hub that restarts ~10x a
 * day; this one only walks a small in-memory map.
 */
const DISPATCH_SWEEP_INTERVAL_MS = 30_000;

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

/**
 * `asOf` for `GET /cluster/active` and `cez cluster active` (`clusterActiveResponseSchema`'s own
 * doc) — the most recent `StoredClusterNode#lastSeenAt` among this hub's LINKED (non-`disabledAt`)
 * roster nodes, or `undefined` if none of them has ever reported. Reads `lastSeenAt` and nothing
 * else — no wall clock — because `lastSeenAt` (stamped for real by `markNodeSeen` on every
 * presence heartbeat, `hub-router.ts`'s `presence` case) is the one signal this hub actually has
 * for "when did I last hear from this node"; a value derived from request time instead would make
 * that question impossible to ever answer honestly, which is the exact defect this function
 * replaces — both call sites used to hardcode `new Date().toISOString()` here.
 *
 * Exported for the same reason `clusterActiveRunsFrom` above is: `cez cluster active` in
 * `../index.ts` answers the same question from the same file, and two spellings of "when did we
 * last hear from the cluster" must not be free to disagree.
 */
export function clusterActiveAsOfFrom(nodes: readonly StoredClusterNode[]): string | undefined {
  let latest: string | undefined;
  for (const node of nodes) {
    if (node.disabledAt !== undefined || node.lastSeenAt === undefined) continue;
    if (latest === undefined || node.lastSeenAt > latest) latest = node.lastSeenAt;
  }
  return latest;
}

/**
 * The ROSTER half of `GET /cluster/active` (D-active, 2026-08-24) — each linked node's own
 * last-reported `presence.active` (`clusterNodeShape#active`'s own doc), read straight off the
 * roster row `markNodeSeen` stamped it onto. This exists because the module header's "`GET
 * /cluster/active`'s locally-mirrored state" paragraph is still true of the OTHER half:
 * `run-projection.ts`'s writers have zero production callers, so `clusterActiveRunsFrom` alone
 * always answers `[]`. The roster is the live path.
 *
 * **Skips a `disabledAt` node.** A revoked node's last-reported claim is not evidence that anything
 * is running now — the credential that would let it correct that claim has been pulled, unlike a
 * merely stale (but still linked) node, whose last-reported runs are kept below on purpose: this
 * route is deliberately not staleness-filtered.
 *
 * **Deliberately does NOT filter by `lastSeenAt` freshness.** A node's runs stay in the response
 * even when that node has gone quiet — per-run freshness is answered by the caller joining
 * `run.nodeId` to that node's `lastSeenAt` (already on the roster the cockpit holds), not by this
 * route silently dropping rows a caller might still want to see (e.g. "what was running when we
 * lost contact"). Do not "fix" a stale-looking row here by filtering it out.
 */
export function clusterActiveRunsFromRoster(nodes: readonly StoredClusterNode[]): ClusterActiveRun[] {
  const runs: ClusterActiveRun[] = [];
  for (const node of nodes) {
    if (node.disabledAt !== undefined) continue;
    for (const run of node.active ?? []) runs.push(run);
  }
  return runs;
}

/**
 * Unions the roster and projection sources for `GET /cluster/active`, deduped by `runId`.
 * **The roster entry wins a collision.** `presence.active` is a live heartbeat-cadence claim
 * (`markNodeSeen`, stamped on every presence beat); the projection (`readRemoteRuns`) is the older
 * path this module's header records as currently dead in production (zero writer callers) and a
 * future Milestone D might revive. Should both ever name the same run, the fresher source is the
 * one worth trusting, not whichever happened to merge first.
 */
export function mergeActiveRuns(
  roster: readonly ClusterActiveRun[],
  projection: readonly ClusterActiveRun[],
): ClusterActiveRun[] {
  const merged: ClusterActiveRun[] = [...roster];
  const seen = new Set(roster.map((run) => run.runId));
  for (const run of projection) {
    if (seen.has(run.runId)) continue;
    seen.add(run.runId);
    merged.push(run);
  }
  return merged;
}

/**
 * This node's OWN in-flight runs, read straight off disk (D-active, 2026-08-24) — the
 * `SpokeRuntimeDeps#listActiveRuns` default wired into `startSpokeRuntime` below, so
 * `presence.active` (`clusterNodeShape#active`'s own doc) and the roster half of
 * `GET /cluster/active` (`clusterActiveRunsFromRoster` above) actually carry something, rather
 * than a dependency this package declared and left permanently unwired.
 *
 * **Built on `WorkspaceRunIndex` (`workspace/run-index.ts`), never `RunStore`/`ProjectContexts`.**
 * That module's own header is explicit that it "never instantiates" a store — it is a read-only,
 * stat-cached parser over every registered project's `runs.json`. That is what makes this function
 * buildable AT ALL from inside this file: `ClusterRuntimeDeps` carries a PER-PROJECT
 * `resolveDispatchManager`, never a workspace-wide runs index or `sharedContexts` — those are
 * `server.ts`-local closures this package does not receive and must not reach for. A presence beat
 * that had to await a live `RunManager` for every registered project would also tie this beat's
 * latency to however many projects this node happens to have open; `WorkspaceRunIndex`'s
 * stat-then-maybe-reparse reads do not.
 *
 * **`run.project` is the LOCAL registry id; `ClusterActiveRun.projectKey` needs the CLUSTER key.**
 * The two are different identifier spaces (`clusterProjectAdvertSchema`'s own doc), so this joins
 * against `advertisedProjects()` — confirmed pairings only, by that function's own doc — to build
 * the map. A run in a project that is not (yet) paired keeps reporting, honestly, with no
 * `projectKey` at all, rather than being dropped or guessed at.
 *
 * `listProjects` is injectable for tests; the production default skips the per-project git probe
 * `workspace/projects.ts#listProjects()` pays for (branch, forge, health) because none of it is
 * read here — the same simplification `startClusterRuntime`'s corpus-mirror wiring above already
 * makes for the identical reason.
 */
export async function collectLocalActiveRuns(
  nodeId: ClusterNodeId,
  options?: ClusterHomeOptions & {
    listProjects?: () => Promise<readonly WorkspaceRunProjectSource[]>;
  },
): Promise<ClusterActiveRun[]> {
  const env = options?.env;
  const listProjectsFn =
    options?.listProjects ??
    (async (): Promise<WorkspaceRunProjectSource[]> => {
      const config = await loadWorkspaceConfig(workspaceConfigPath(env));
      return config.projects.map((project) => ({
        id: project.id,
        root: project.root,
        status: 'ok' as const,
        name: project.name,
      }));
    });

  const [{ runs }, adverts] = await Promise.all([
    new WorkspaceRunIndex({ listProjects: listProjectsFn }).list({ view: 'active' }),
    advertisedProjects({ env }),
  ]);

  const projectKeyById = new Map<string, ClusterProjectKey>();
  for (const advert of adverts) {
    if (advert.projectKey !== undefined) projectKeyById.set(advert.projectId, advert.projectKey);
  }

  return runs
    .filter((run) => IN_FLIGHT_STATUSES.has(run.status))
    .map((run) => {
      const projectKey = projectKeyById.get(run.project);
      return {
        runId: run.id,
        nodeId,
        ...(projectKey !== undefined ? { projectKey } : {}),
        summary: (run.titleSummary ?? run.title).slice(0, 500),
        ...(run.branch !== undefined ? { branch: run.branch.slice(0, 200) } : {}),
        paths: [],
        startedAt: run.startedAt ?? run.createdAt,
      };
    });
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
 * `clusterCorpusManifestQuerySchema` (contract) extended, locally, with a `scope` key the landed
 * contract schema does not declare and keeps `.strict()` against. `sources/cezar-hub/provider.ts
 * #fetchManifest` (already built, package 3b.1) sends `?scope=knowledge,domains,…` on every
 * request — `node-auth.ts#signedNodeRequestHeaders`'s own doc names this as a live counter-example
 * to "nothing security-relevant in the query string" and is explicit that the fix belongs here,
 * hub-side, not in the client: treat `scope` as a narrowing hint, never as authorization (the GET
 * handler below does exactly that — see its own doc). `.extend()` on a `.strict()` zod object
 * keeps rejecting any OTHER unknown key, so this is additive, not a widening of what the contract
 * schema tolerates generally.
 */
const corpusManifestQuerySchema = clusterCorpusManifestQuerySchema.extend({
  scope: z.string().max(500).optional(),
});

/**
 * `GET /cluster/corpus/*`'s wildcard tail — measured, not `c.req.param('*')`. A BARE trailing `*`
 * (unlike a NAMED wildcard, `:path{.+}`) creates no capture at all in this Hono version's
 * `RegExpRouter`: the compiled pattern for a trailing `*` is a non-capturing `(?:|/.*)`, so
 * `c.req.param('*')` is `undefined` on every request — measured directly against the installed
 * `hono` while wiring this in, after every request 404'd with `CORPUS_DOC_NOT_FOUND` even for a
 * document that plainly existed. The scaffold's own doc explains why the route cannot use
 * `:path{.+}` instead (`bc-route-inventory.test.ts`'s brace expansion), so the extraction has to
 * happen by hand: `c.req.path` is Hono's OWN already-decoded pathname (`getPath`, `utils/url.ts`,
 * one `decodeURI` pass) regardless of mount depth, so finding the literal `/cluster/corpus/`
 * marker and slicing after it works whether this router is mounted under `/api/v1` (`createApp`)
 * or bare (`createClusterRoutes` in a unit test) — never a hardcoded prefix length.
 */
function corpusWildcardTail(c: Context): string | undefined {
  const marker = '/cluster/corpus/';
  const idx = c.req.path.indexOf(marker);
  return idx === -1 ? undefined : c.req.path.slice(idx + marker.length);
}

/** `scope=knowledge,domains` → `['knowledge','domains']`. `undefined` (absent, empty, or only
 *  whitespace/commas) means "no hint" — the caller gets its full entitled scope. Never trusted as
 *  authorization on its own; see the manifest route's own doc. */
function parseScopeHint(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts : undefined;
}

/**
 * The requesting node's own roster row, read fresh on every corpus request — corpus scope is a
 * per-node GRANT (D8a S4 of the 2026-08-24 handoff item), never trusted from the request itself.
 * No `mirrorScope` field is declared on `StoredClusterNode` yet, so `scopeForNode` falls back to
 * its default (every scope, per the owner's 2026-08-24 correction to D8a) for every node today —
 * but `storedClusterNodeSchema` is `.passthrough()`, so a future per-node override already
 * survives this read intact with no change needed here.
 *
 * Returns `corpus-store.ts#scopeForNode`'s own narrow parameter shape rather than the full
 * `StoredClusterNode`, and casts to it once, here, rather than at every call site: `.passthrough()`
 * types every extra key as `unknown` via an index signature, which is NOT assignable to an
 * optional `readonly string[]` field even though the property may simply be absent — a real
 * TS2345 measured while wiring this in, not a stylistic cast.
 */
async function findRosterNodeScope(
  nodeId: ClusterNodeId,
  env: NodeJS.ProcessEnv,
): Promise<{ mirrorScope?: readonly string[] } | undefined> {
  const peers = await readPeers({ env });
  const node = peers.nodes.find((n) => n.nodeId === nodeId);
  return node as { mirrorScope?: readonly string[] } | undefined;
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

/**
 * D20's authenticated set, and the ONLY place it is named. Base paths relative to this router's
 * own mount point (`/cluster/...` — no `/api/v1`, matching every other path constant in this
 * file), one entry per family the module header's "D20" section names as node-authenticated:
 * the corpus mirror, and the todos snapshot/backup/append trio. `/cluster/allocate` and
 * `/cluster/leases` are hub-authenticated (`requireHub`) as well as node-authenticated — see the
 * "CORRECTED 2026-08-23 (D22)" note above for why both gates apply to them.
 *
 * Two callers read this array and NEITHER hand-lists paths of its own, which is what makes them
 * unable to disagree rather than merely consistent today:
 *  - `createClusterRoutes` below `.use()`s `requireNodeAuth` on every entry (`base` and
 *    `${base}/*`) in a loop over this exact array — the `.use()` targets are GENERATED from it,
 *    not separately written and kept in sync by hand.
 *  - `server.ts`'s cockpit auth wall calls `isNodeAuthenticatedClusterPath` (below) to decide
 *    which `/api/v1/cluster/*` requests it lets past for `requireNodeAuth` to authenticate
 *    instead of answering its own blanket 401. It does not duplicate the list or the matching
 *    rule — it calls the same function this file's own `.use()` loop is built from.
 *
 * Adding a node-authenticated route means adding its base path here, in this one place. Nowhere
 * else in this file or in `server.ts` may name one of these paths for either purpose.
 */
export const NODE_AUTHENTICATED_CLUSTER_BASE_PATHS = [
  '/cluster/corpus',
  '/cluster/todos',
  '/cluster/allocate',
  '/cluster/leases',
] as const;

/**
 * True for `relativePath` (e.g. `/cluster/todos/workspace-root`, spelled the way this file's own
 * `.use()` targets are — no `/api/v1` prefix) iff `requireNodeAuth` covers it: the base path
 * itself, or anything nested under it.
 *
 * Matches Hono's own `X` + `X/*` wildcard semantics exactly — verified against the installed
 * `hono@4.12.29` (a request to the bare base path, with no trailing segment, already reaches a
 * `${base}/*`-registered middleware; the pairing below is defensive redundancy, not a second
 * mechanism), never assumed: a `/`-bounded prefix test, so `/cluster/todos` matches but
 * `/cluster/todosomething` does not — a bare `startsWith(base)` would wrongly admit the latter.
 * `c.req.path` (what both this file and `server.ts`'s wall read) already excludes the query
 * string and already has `..` segments resolved by the WHATWG `URL` parser `@hono/node-server`
 * builds it from, so this needs no query-stripping or traversal-normalisation of its own — see
 * `server.ts`'s call site for the one thing it still has to do, which is strip `V1_PREFIX`.
 */
export function isNodeAuthenticatedClusterPath(relativePath: string): boolean {
  return NODE_AUTHENTICATED_CLUSTER_BASE_PATHS.some(
    (base) => relativePath === base || relativePath.startsWith(`${base}/`),
  );
}

/**
 * `/cluster/join` — the ONE cluster path whose credential is the request body rather than a node
 * signature or a cockpit session.
 *
 * **Why it needs its own set rather than joining `NODE_AUTHENTICATED_CLUSTER_BASE_PATHS`.** A node
 * that is joining does not have a node credential yet — acquiring one is the entire point of the
 * request — so `requireNodeAuth` can never authenticate it. What authenticates it is the join code
 * itself: single-use, TTL-bounded, stored only as a SHA-256 digest, and compared in constant time
 * (`enrollment.ts#matchesEnrollmentCode`). `redeemEnrollmentCode` answers `ok:false` with a named
 * reason for every code it does not recognise, and folds "never minted" into `code-expired` so a
 * redeemer cannot probe which codes exist.
 *
 * **FOUND 2026-08-24, on the production hub.** This path used to sit behind the cockpit wall
 * alongside `/cluster/enroll*`, under the reasoning that both are "operator actions taken at a
 * human's own browser". That is true of `enroll` and false of `join`: `join` is called by the
 * CLI **on the machine being added**, by `cluster/enrollment.ts#joinCluster`, which has no cockpit
 * session and no way to obtain one. So on every deployment that sets `CEZ_AUTH` — which is every
 * real one — the wall answered 401 before this handler ran and `cez cluster join <code>` could not
 * succeed against any hub, ever. It was measured against `prod-host` running `CEZ_AUTH=oidc`:
 * the CLI reported `access-rejected`, which named the wrong system entirely (Cloudflare Access was
 * not in the path at all — the 401 was cezar's own perimeter).
 *
 * The suite did not catch it because it asserted the MECHANISM, not the outcome:
 * `cluster-node-auth-wall.test.ts` pinned `POST /cluster/join` to the blanket 401 as a containment
 * check. Nothing anywhere asked whether a spoke could then still join.
 *
 * **Deliberately EXACT-match, not the `/`-bounded prefix rule above.** There is no legitimate
 * `/cluster/join/<something>`, so an exact test is the narrowest thing that works, and it keeps
 * `/cluster/enroll` (which MINTS codes and must stay session-only) and `GET /cluster` (the roster)
 * behind the wall. Widening this to a prefix, or adding `enroll` to it, would expose code minting
 * to anyone who can reach the host.
 */
export const CODE_AUTHENTICATED_CLUSTER_PATHS = ['/cluster/join'] as const;

/** True iff `relativePath` (no `/api/v1` prefix) is authenticated by a join code — exact match. */
export function isCodeAuthenticatedClusterPath(relativePath: string): boolean {
  return CODE_AUTHENTICATED_CLUSTER_PATHS.some((path) => relativePath === path);
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

  const app = new Hono<ProjectApiEnv>()
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
    .use('/cluster/leases/*', requireHub);

  // D20, GENERATED from `NODE_AUTHENTICATED_CLUSTER_BASE_PATHS` above — that array's own doc
  // explains why this loop is the ONLY place `requireNodeAuth` is `.use()`'d, and why
  // `server.ts`'s cockpit wall cannot drift from this set. Broken out of the fluent chain above
  // (rather than four more `.use()` lines) specifically so the registrations are generated,
  // not hand-copied from the array beside it.
  //
  // Registered after `requireCluster` (flag wins first: off answers 409, never a node-auth 401)
  // and after `requireHub` for `/cluster/allocate/*` and `/cluster/leases/*` — deliberately: a
  // request to a non-hub still gets `requireHub`'s 409 NOT_A_HUB rather than node-auth's 401,
  // the more specific fact of the two (unchanged from before this package). `.use()` returns
  // `this` and does not touch the chain's inferred route schema (unlike `.get()`/`.post()`/etc,
  // which is why the trap `requireHub`'s own doc warns about — a bare handler collapsing a
  // route's schema — does not apply to a loop of `.use()` calls).
  for (const base of NODE_AUTHENTICATED_CLUSTER_BASE_PATHS) {
    app.use(base, requireNodeAuth);
    app.use(`${base}/*`, requireNodeAuth);
  }

  return (
    app
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

      // ---- corpus (D8a, package 3b.2) ---------------------------------------------------------
      // Registered exact-before-wildcard so `/cluster/corpus` cannot be swallowed by the
      // one-document path below.
      /**
       * `GET /cluster/corpus?since=&scope=` — the manifest is a DIFF INPUT (S1 of the 2026-08-24
       * handoff item), not a file list: `hash` is what makes diff-before-fetch possible without
       * reading a single body, and `since` filters to what changed after that corpus version.
       * `docs`/`tombstones` are both explicit arrays straight from `buildManifest` — never
       * absence-diffed here (spec Verification 16).
       *
       * `scope` is validated by `corpusManifestQuerySchema` below (this file's own extension of
       * the contract's `.strict()` `clusterCorpusManifestQuerySchema`, tolerating the one extra
       * key the already-built spoke client sends — see that schema's own doc) but is honoured as a
       * NARROWING HINT ONLY: intersected against `scopeForNode`'s answer for the AUTHENTICATED
       * node, never unioned with it. `node-auth.ts#signedNodeRequestHeaders`'s own doc is explicit
       * that nothing in this family's query string may be security-relevant, because the request
       * signature never covers `url.search` — so a node asking for MORE than it is entitled to is
       * silently capped back to its grant here, not refused; only a node asking for less is
       * actually narrowed.
       */
      .get('/cluster/corpus', queryZodValidator(corpusManifestQuerySchema), async (c) => {
        const node = getAuthenticatedClusterNode(c);
        if (!node) return c.json({ error: NO_AUTHENTICATED_NODE_ON_GATED_ROUTE }, 500);
        const root = resolveCorpusRoot({ env });
        if (!root) return c.json({ error: CORPUS_ROOT_UNCONFIGURED }, 409);
        const { since, scope: scopeParam } = c.req.valid('query');
        const entitled = scopeForNode(await findRosterNodeScope(node.nodeId, env));
        const hint = parseScopeHint(scopeParam);
        const scope = hint ? entitled.filter((s) => hint.includes(s)) : entitled;
        // No reconstruction: `corpus-store.ts#CorpusManifest` is declared as `ClusterCorpusManifestResponse`
        // itself (a type alias, not merely a structural match), specifically so the two can never drift.
        const body: ClusterCorpusManifestResponse = await buildManifest(scope, since, { env });
        return c.json(body);
      })

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
       * route keeps the plain wildcard, and the tail is extracted with `corpusWildcardTail`
       * (below — NOT `c.req.param('*')`, which is `undefined` for a bare trailing `*` in this
       * Hono version's `RegExpRouter`; see that function's own doc) and parsed with
       * `clusterCorpusPathParamSchema` at the TOP of the handler below, by hand.
       *
       * A malformed path (fails the schema), an out-of-scope path, and a genuinely absent
       * document all answer the SAME `CORPUS_DOC_NOT_FOUND` 404 — "it parsed" is never "it is in
       * scope", and `reports/`/`raw-input/` staying distinguishable from "not mirrored" is a
       * `presence` concern (D8a S4), not something this route's 404 body may leak. `isPathInScope`
       * is the SAME function the batch route below uses, never a second copy of the rule.
       */
      .get('/cluster/corpus/*', async (c) => {
        const node = getAuthenticatedClusterNode(c);
        if (!node) return c.json({ error: NO_AUTHENTICATED_NODE_ON_GATED_ROUTE }, 500);
        const root = resolveCorpusRoot({ env });
        if (!root) return c.json({ error: CORPUS_ROOT_UNCONFIGURED }, 409);
        const parsed = clusterCorpusPathParamSchema.safeParse({ path: corpusWildcardTail(c) });
        if (!parsed.success) return c.json({ error: CORPUS_DOC_NOT_FOUND }, 404);
        const scope = scopeForNode(await findRosterNodeScope(node.nodeId, env));
        if (!isPathInScope(parsed.data.path, scope)) return c.json({ error: CORPUS_DOC_NOT_FOUND }, 404);
        const doc = await readDoc(parsed.data.path, scope, { env });
        if (!doc) return c.json({ error: CORPUS_DOC_NOT_FOUND }, 404);
        const body: ClusterCorpusDocResponse = { path: doc.path, hash: doc.hash, body: doc.body };
        return c.json(body);
      })

      /**
       * `POST /cluster/corpus/bodies` — S2/S3 of the 2026-08-24 handoff item: N document bodies in
       * one round trip, which is what turns a 2173-document first mirror from 235s of serial round
       * trips into ~1.2s of eleven (measured 2026-08-24, median RTT to the hub 108ms). Scope-checks
       * every requested path with the exact same `isPathInScope` the single-document route above
       * uses — a batch route carrying its own copy of that rule is how the two drift and one stops
       * refusing `reports/` (`clusterCorpusBodiesResponseSchema`'s own doc). An out-of-scope path
       * and a genuinely missing one both land in `missing`, undistinguished, for the same
       * disclosure reason as the single-document 404 above.
       */
      .post('/cluster/corpus/bodies', jsonZodValidator(clusterCorpusBodiesRequestSchema), async (c) => {
        const node = getAuthenticatedClusterNode(c);
        if (!node) return c.json({ error: NO_AUTHENTICATED_NODE_ON_GATED_ROUTE }, 500);
        const root = resolveCorpusRoot({ env });
        if (!root) return c.json({ error: CORPUS_ROOT_UNCONFIGURED }, 409);
        const { paths } = c.req.valid('json');
        const scope = scopeForNode(await findRosterNodeScope(node.nodeId, env));
        const inScope = paths.filter((p) => isPathInScope(p, scope));
        const outOfScope = paths.filter((p) => !isPathInScope(p, scope));
        const result = await readDocs(inScope, scope, { env });
        const body: ClusterCorpusBodiesResponse = {
          docs: result.docs,
          // Out-of-scope paths and paths `readDocs` itself could not find are folded into ONE
          // list, unlabelled — the same non-disclosure the single-document 404 above practices.
          missing: [...outOfScope, ...result.missing],
          truncated: result.truncated,
        };
        return c.json(body);
      })

      /**
       * `POST /cluster/corpus/submit` — the corpus's only write direction (D8, D8a). Implements
       * `out-of-scope` (via the same `isPathInScope` the two GET routes above use) and `stale-base`
       * (optimistic concurrency keyed on `readDoc`'s own `hash` — the same value the manifest and
       * single-document routes already hand out as `ClusterCorpusDoc.hash`/`ClusterCorpusBody.hash`,
       * so no second versioning scheme is invented here: a submitter who supplies a `baseVersion`
       * that does not match the document's current hash — including "no such document exists yet"
       * — is refused rather than silently clobbering a concurrent write). Does NOT implement
       * `too-large` (already unreachable: the request body is capped at 1MB by
       * `clusterCorpusSubmitRequestSchema` itself, so an oversized submission 400s at the validator
       * and never reaches this handler) or `read-only-path` (no policy anywhere in the spec names
       * which corpus paths, if any, are read-only server-side) — see the module header's corpus
       * section for the fuller note. Refusals answer 200 with `{ok:false,reason}`, matching
       * `POST /cluster/join`'s `code-expired` precedent elsewhere in this file: the body, not the
       * status, is what a caller branches on.
       *
       * The write itself is re-verified against the resolved corpus root (belt and suspenders,
       * same posture as `node-auth.ts#request`'s own credential re-check) rather than trusting
       * `isPathInScope` alone to have ruled out traversal.
       */
      .post('/cluster/corpus/submit', jsonZodValidator(clusterCorpusSubmitRequestSchema), async (c) => {
        const node = getAuthenticatedClusterNode(c);
        if (!node) return c.json({ error: NO_AUTHENTICATED_NODE_ON_GATED_ROUTE }, 500);
        const root = resolveCorpusRoot({ env });
        if (!root) return c.json({ error: CORPUS_ROOT_UNCONFIGURED }, 409);
        const { path, body: docBody, baseVersion } = c.req.valid('json');
        const scope = scopeForNode(await findRosterNodeScope(node.nodeId, env));
        if (!isPathInScope(path, scope)) {
          const refusal: ClusterCorpusSubmitResponse = { ok: false, reason: 'out-of-scope' };
          return c.json(refusal);
        }
        const existing = await readDoc(path, scope, { env });
        if (baseVersion !== undefined && existing?.hash !== baseVersion) {
          const refusal: ClusterCorpusSubmitResponse = { ok: false, reason: 'stale-base' };
          return c.json(refusal);
        }
        const resolvedRoot = resolve(root) + sep;
        const target = resolve(root, path);
        if (!target.startsWith(resolvedRoot)) {
          const refusal: ClusterCorpusSubmitResponse = { ok: false, reason: 'out-of-scope' };
          return c.json(refusal);
        }
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, docBody, 'utf8');
        const manifest = await buildManifest(scope, undefined, { env });
        const ok: ClusterCorpusSubmitResponse = { ok: true, path, corpusVersion: manifest.corpusVersion };
        return c.json(ok);
      })

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
       *  `clusterActiveRunsFrom` and `clusterActiveAsOfFrom` above; see their docs for the
       *  injection rule `summary` carries, for why `paths` is empty until package 4.3, and for why
       *  `asOf` is roster-derived rather than a request-time clock. */
      .get('/cluster/active', async (c) => {
        const [projectionRuns, peers] = await Promise.all([
          readRemoteRuns({ env }).then(clusterActiveRunsFrom),
          readPeers({ env }),
        ]);
        const runs = mergeActiveRuns(clusterActiveRunsFromRoster(peers.nodes), projectionRuns);
        const asOf = clusterActiveAsOfFrom(peers.nodes);
        const body: ClusterActiveResponse = { runs, ...(asOf !== undefined ? { asOf } : {}) };
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
  /**
   * The `http.Server` `ClusterLinkServer.attach()`es to when this node is the hub — the same
   * server `server/ws.ts`'s cockpit socket hub attaches to. **Required, not optional.** An optional
   * field here would let a caller forget it and get a hub that starts up looking healthy and is
   * silently unreachable over the link — exactly the class of failure the D20/D23/D24/D25
   * corrections in the spec spent this whole session finding, the hard way, by measuring a running
   * system rather than by a type catching it. `server/server.ts#startServer` is the only production
   * caller and passes the real listening server once it exists; `createApp` has none to give,
   * which is why this call lives in `startServer`, not `createApp` (package 1.5).
   */
  server: UpgradeCapableServer;
  /**
   * Milestone C: how the SPOKE branch's `startSpokeRuntime` resolves a dispatched project's
   * `repoRoot` to the live `RunManager` that will actually run the work — threaded straight
   * through to `SpokeRuntimeDeps#resolveDispatchManager`, whose own doc has the full argument for
   * why this is required rather than optional. `server/server.ts#startServer` is the only
   * production caller, wiring it off `sharedContexts` the same way `todoAutostartProject` is built
   * there (`:1621`). Irrelevant to the hub branch — a hub never calls `startSpokeRuntime` — but
   * required on this type regardless, for the same reason `server` above is: an optional field a
   * spoke-only caller forgets to set is a spoke that links up looking healthy and cannot run
   * anything dispatched to it.
   */
  resolveDispatchManager: (repoRoot: string) => Promise<RunManager | undefined>;
  /**
   * The directory this process booted with (`ServerDeps#repoRoot`) — folded into the corpus
   * mirror's project list by `corpusMirrorProjectDataDirs`, whose doc has the full argument for
   * why the registry alone is not enough.
   *
   * **Optional, and that is a deliberate exception to this interface's own "required, because its
   * absence is silent" rule** (see `server` and `resolveDispatchManager` above). It is optional
   * because the failure it guards is no longer silent: `corpus-mirror-runtime.ts#sweepOnce` warns
   * loudly, once, the first time it finds NOTHING to mirror — for any cause, including a caller
   * that forgets this field. An optional field whose absence is announced is a default; an
   * optional field whose absence is silent is the bug this whole item is about. Making it required
   * would also force a value on ten cluster tests that have no boot project and do not exercise
   * the mirror at all.
   */
  bootProjectRoot?: string;
  /**
   * D47: the shared workspace-wide `WorkspaceSemaphore` — threaded straight through to
   * `SpokeRuntimeDeps#semaphore`, whose own doc has the full argument for what it fixes. Optional
   * for the same "legacy callers and tests that build no managers" reason `ServerDeps#semaphore`
   * is optional (`server.ts:6857`'s own doc) — unlike `server`/`resolveDispatchManager` above,
   * its absence degrades to today's already-shipped behaviour (an omitted `liveCapacity`, which
   * `peers.ts#collectPresence` already defaults honestly) rather than to silent unreachability, so
   * making it required here would be a stricter rule than the rest of this file already keeps.
   */
  semaphore?: WorkspaceSemaphore;
  /**
   * Test-only timing knob — threaded straight through to `SpokeRuntimeDeps#heartbeatMs`, whose own
   * doc gives the production default (`DEFAULT_HEARTBEAT_MS`, 30_000, matching the hub's expected
   * presence cadence). Optional, same shape as `ClusterRouteDeps#now` above (a D20 test hook that
   * pins the clock): a production caller has no reason to override a cadence chosen to match the
   * hub, and an absent value here degrades to the exact same 30s beat this file has always shipped
   * — never to a wrong-but-plausible number a caller forgot to set, which is what would make this
   * required instead (the `server`/`resolveDispatchManager` reasoning above does not apply: their
   * absence makes a node look healthy while being silently unreachable/undispatchable; this field's
   * absence makes it beat at the same cadence it always has). Exists so
   * `cluster-link-activation.test.ts`'s Milestone C scenario can drive a real presence beat carrying
   * a real `WorkspaceSemaphore`'s load in milliseconds, not by waiting out a real 30s tick.
   */
  heartbeatMs?: number;
  /**
   * D-active (2026-08-24): a TEST OVERRIDE only — threaded straight through to
   * `SpokeRuntimeDeps#listActiveRuns`, whose own doc has the full argument. Production never sets
   * this field: `startClusterRuntime`'s spoke branch below wires the real default itself
   * (`collectLocalActiveRuns`, disk-backed, self-contained) at the point it calls
   * `startSpokeRuntime`, the same place `deps.semaphore`/`deps.resolveDispatchManager` are handed
   * through. Unlike those two, this one has no `server.ts` half to wire, because
   * `collectLocalActiveRuns` needs nothing `server.ts` alone holds (see its own doc for why
   * `WorkspaceRunIndex` makes that possible) — so leaving this optional and unset in production is
   * not a gap, it is the whole point of building the default here instead of asking every caller to
   * supply one.
   */
  listActiveRuns?: () => ClusterActiveRun[] | Promise<ClusterActiveRun[]>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Builds the `HubReplicationDeps` `startClusterRuntime`'s hub branch hands to
 * `createHubFrameRouter` — the wiring that makes Milestone B's `hub-apply.ts`/`hub-seq.ts`/
 * `op-history.ts` (~1,500 lines, fully tested, zero production callers before this function)
 * reachable outside a test file. Exported and unit-tested on its own, separate from the E2E in
 * `cluster-link-activation.test.ts` that proves this is actually the function `startClusterRuntime`
 * calls — see that file for why both are needed.
 *
 * `linkServer` is a GETTER, not the `ClusterLinkServer` instance itself, so this function can be
 * built and exercised (including its throw paths) without ever standing up a real link. The
 * production caller passes `() => linkServer`, closing over a `let` it assigns synchronously right
 * after this call returns — safe because `ClusterLinkServer` never invokes `onFrame` (the only path
 * that reaches `sendTo`/`connectedNodes`) before a real socket has authenticated and delivered a
 * frame, which is always later than this synchronous assignment (see `link-server.ts`: `onFrame` is
 * called only from `onMessage`, reachable only via `ws.on('message')` on a socket that only exists
 * after the `'connection'` listener fires, which only happens after `handleUpgrade` accepts the
 * auth). `identity` is accepted for parity with `HubFrameRouterDeps` and to name this hub in the
 * pairing-refusal message below; it plays no role in `resolveHubTodosRoot`, which loads its own
 * copy of the hub's identity from disk per call (it has to — it is also reachable from the HTTP
 * `/cluster/todos/*` family, which does not have this function's `identity` in scope).
 *
 * **`applyOp` resolves its dataDir PER OP, never once.** A `ClusterOp` carries its own
 * `scope`/`projectKey` and nothing anywhere validates that they agree with the frame's — a hub
 * accepting a single fixed `dataDir` closure would write project B's ops into project A's
 * `todos.json` the moment a frame's `projectKey` and an op's disagreed. The required mutation test
 * for this file is exactly that substitution; see the "REQUIRED mutation" note in the test.
 *
 * **Every unresolvable case THROWS, never returns `{accepted:false}`.** Per `hub-ops.ts`'s own
 * reject-vs-throw contract, a returned rejection is a DURABLE verdict — the spoke advances past it
 * and drops the op from its outbox forever. Neither case below is durable: an unconfirmed pairing
 * is confirmed by a human at any later time, and a corrupt `peers.json` degrades to an empty roster
 * (`peers.ts`), which is indistinguishable here from "genuinely unpaired" — treating either as a
 * permanent rejection would silently discard writes behind a transient or operator-fixable state. A
 * throw costs only a burned `hubSeq` (an unbounded counter, so log noise, not a failure) and leaves
 * the op owed in the spoke's outbox, which is the far better failure per `hub-router.ts`'s own
 * stated posture for this whole file.
 *
 * **The authorization gap this closes.** Nothing else on the link path checked that the AUTHORING
 * node (`op.nodeId`) is confirmed-paired with the project it is writing, while the HTTP
 * `/cluster/todos/*` family gates exactly that, both ways (D20/D21 — see `resolveHubTodosRoot`
 * above). Passing `op.nodeId` as `resolveHubTodosRoot`'s `callerNodeId` makes the link path match:
 * today the two already agree by construction (`deriveTodoOps` stamps `nodeId: input.nodeId`, the
 * authoring node's own), so this costs nothing for the honest case, but it is what stops a node
 * refused a project over HTTP from writing that project over the socket instead. A stronger
 * guard — refusing an op whose `op.nodeId` disagrees with the link's AUTHENTICATED identity — has to
 * live in `hub-router.ts`'s `ops` case, not here; this function only ever sees the op, not the
 * socket that carried it.
 */
export function buildHubReplication(
  identity: StoredClusterNodeIdentity,
  env: NodeJS.ProcessEnv,
  warn: (message: string) => void,
  linkServer: () => ClusterLinkServer | undefined,
): HubReplicationDeps {
  const allocator = createHubSeqAllocator({ env, warn });
  const opHistory = createOpHistoryStore({ env, warn });

  const applyOp = async (op: ClusterOp & { hubSeq: number }): Promise<HubOpOutcome> => {
    if (op.scope !== 'project' || !op.projectKey) {
      // No workspace-scoped todo store exists anywhere in the tree yet (module docblock of
      // `hub-apply.ts` names the same "never fabricate" posture for `entity`). Thrown, not
      // returned — see this function's own docblock.
      throw new Error(
        `cluster hub: no ${op.scope}-scoped store exists on this build — op ${op.opId} left unacknowledged`,
      );
    }
    // `op.nodeId` is the AUTHORING node, the same both-ways-confirmed gate the HTTP
    // /cluster/todos family applies (D20/D21, `resolveHubTodosRoot` above in this file).
    const root = await resolveHubTodosRoot(op.projectKey, op.nodeId, env);
    if (!root) {
      throw new Error(
        `cluster hub (${identity.nodeId}): project "${op.projectKey}" is not confirmed-paired with ` +
          `node "${op.nodeId}" on this hub — op ${op.opId} left unacknowledged; it stays in that ` +
          "node's outbox until the pairing is confirmed",
      );
    }
    return applyOpAtHub(todosDataDir(root), op);
  };

  return {
    allocate: (input) => allocator.allocate(input),
    applyOp,
    findAppliedOp: (opId) => opHistory.find(opId),
    recordAppliedOp: (opId, result) => opHistory.record(opId, result),
    // `false` = "not connected", which `hub-router.ts`'s `ops` case already handles correctly: it
    // warns and deliberately does NOT advance that node's watermark, so the frame is owed again on
    // the next batch. That is also the right answer for the pre-assignment window (this function
    // called before `linkServer()` has anything to return) — over-sending is free, under-sending
    // loses a write.
    sendTo: (nodeId, frame) => linkServer()?.send(nodeId, frame) ?? false,
    // B4 — connect-time replay's ONE production read. Deliberately the SAME two calls `applyOp`
    // above makes, in the same order: `resolveHubTodosRoot` (D20/D21's both-ways-confirmed pairing
    // gate) and then the project's todos. Not a second implementation of that gate that happens to
    // agree today — one rule, one call site, so a change to who may be replayed a project cannot
    // drift from who may write it. `undefined` here is that gate's REFUSAL and is passed through
    // unchanged; `hub-router.ts#readTodosFor` documents why it must stay distinguishable from `[]`.
    readTodosFor: async (projectKey, nodeId) => {
      const root = await resolveHubTodosRoot(projectKey, nodeId, env);
      if (!root) return undefined;
      return readTodos(todosDataDir(root));
    },
    connectedNodes: () => linkServer()?.connectedNodes() ?? [],
  };
}

/**
 * The ONE wiring line `server.ts` carries for this feature, beside the existing
 * `providerRuntimeAuth.watch` / `watchTodoAutostart` block. It lives here rather than in
 * `server.ts` so a package fills a body in a file it can be given, instead of editing the one file
 * twenty concurrent agents share (PLAN P3).
 *
 * **With `CEZ_CLUSTER` unset this returns immediately having armed nothing** — no timer, no socket,
 * no file under `~/.cezar/cluster` or `.ai/cezar/cluster` — which is the half of Verification 12
 * that neither a `capabilities` assertion nor a route probe can see.
 *
 * **With the flag on, this is package 1.5's activation: it arms the node link, hub or spoke.** It
 * deliberately does NOT arm the periodic full reconcile (`cluster/reconcile.ts#startPeriodicReconcile`)
 * or the run-projection observer (`cluster/run-projection.ts`, package 3.4) — both are later
 * increments. The reconcile timer in particular stays unarmed on purpose right now:
 * `reconcile.ts#PeriodicReconcileOptions.run`'s own docblock names its production caller as a
 * **non-dry-run** `reconcileAll`, which would perform the 110-row merge this whole design exists
 * for automatically and unattended on first link — the one thing spec P9 gates on the owner being
 * present. See `.ai/runs/2026-08-22-multi-node-cezar-cluster/PLAN.md` → "Found during
 * implementation" for the open decision; arming it is a separate, deliberate step, not something
 * that should ride in behind this one.
 *
 * **Hub vs spoke is decided from the PERSISTED identity (`loadNodeIdentity`), not from
 * `clusterModeFromEnv(env)` directly.** The identity on disk is what actually carries the
 * credential `ClusterLinkServer`/`ClusterLinkClient` sign and verify with, so it is the thing that
 * determines which branch runs and with what secret; `clusterModeFromEnv(env)` is consulted only as
 * a CROSS-CHECK against it. The two are written together at enrollment time
 * (`enrollment.ts#joinCluster` → `ensureNodeIdentity`) and should never disagree in normal
 * operation — a disagreement means the operator edited `CEZ_CLUSTER`/`CEZ_CLUSTER_HUB` without
 * re-enrolling, or vice versa, which is a real misconfiguration. It gets a NAMED warning and arms
 * nothing, the same "refuse rather than silently pick a side" posture D2 uses for an ambiguous
 * project pairing — proceeding on a guess would run the wrong protocol against the wrong secret.
 * **No identity on disk at all** is not that: it is the normal, honest starting state for a node
 * that has never enrolled (a spoke gets one from `cezar cluster join <code>`), so it warns once and
 * arms nothing without treating it as an error.
 *
 * `loadNodeIdentity` is the only asynchronous step this function takes. Once it resolves, every
 * remaining check and the hub/spoke construction are synchronous, so the returned disposer needs
 * exactly ONE `disposed` check — placed after that await, before anything is constructed — to
 * cancel correctly even when called while identity is still loading: a `stop()` that raced the load
 * must prevent the link from ever being armed, never leave a socket or a heartbeat timer behind for
 * the caller to leak.
 *
 * Returns the stop function, the disposal shape used throughout this codebase.
 */
/**
 * Every project this node should mirror the hub corpus into, as `<root>/.ai/cezar` `dataDir`
 * values — the workspace registry PLUS the boot project.
 *
 * **The boot project is the half that was missing, and its absence was silent** (measured on a
 * fresh node, 2026-08-24). `cezar serve --repo <dir>` makes `<dir>` the boot project, and a boot
 * project deliberately carries NO workspace-registry row: `server.ts#registerFolder`'s own
 * "Idempotent no-op" branch resolves it to the boot identity instead of appending a second row,
 * because two registry rows over one root open two `RunStore`s over one `runs.json` and the last
 * flush truncates the other's writes (`.ai/specs/2026-08-15-duplicate-project-context-wipes-runs.md`,
 * D3 `suppressBootRegistration`). That is correct — but it means a node whose ONLY project is the
 * one it booted with reads an EMPTY registry, mirrors nothing, and stays knowledge-blind forever
 * while reporting `armed`. Item 59's own note directly above the call site argued the list must not
 * gate on confirmed pairings precisely to avoid "the exact inert failure D8a exists to prevent";
 * the same inertness survived through the boot-project door.
 *
 * Deduped on `resolve()` because the boot root is very often ALSO a registered project (any node
 * that registered the directory before it was ever booted with `--repo` carries both), and one
 * `dataDir` swept twice in a pass is wasted work against the same `SourceStore`. `resolve` and not
 * `realpath`: this must stay synchronous-cheap and allocation-free per sweep, and two spellings
 * that differ only by symlink degrade to a duplicate sweep of the same idempotent store, never to
 * a wrong or lost document.
 *
 * The boot root is threaded in rather than re-derived here: `server.ts` owns `deps.repoRoot`, and
 * a second derivation of "what did this process boot with" is exactly the kind of one-concept-at-
 * two-points drift that goes stale on one side only.
 */
export async function corpusMirrorProjectDataDirs(options: {
  bootProjectRoot?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<readonly string[]> {
  const config = await loadWorkspaceConfig(workspaceConfigPath(options.env));
  const roots = config.projects.map((project) => project.root);
  if (options.bootProjectRoot) roots.push(options.bootProjectRoot);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const root of roots) {
    const dataDir = join(resolve(root), '.ai/cezar');
    if (seen.has(dataDir)) continue;
    seen.add(dataDir);
    out.push(dataDir);
  }
  return out;
}

export function startClusterRuntime(deps: ClusterRuntimeDeps): () => void {
  const env = deps.env ?? process.env;
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  if (!clusterEnabled(env)) return () => {};

  let disposed = false;
  let teardown: (() => void) | undefined;

  void (async () => {
    let identity: StoredClusterNodeIdentity | undefined;
    try {
      identity = await loadNodeIdentity({ env, warn });
    } catch (err) {
      warn(`cluster: could not load this node's identity — arming nothing: ${errorMessage(err)}`);
      return;
    }
    if (!identity) {
      warn(
        `CEZ_CLUSTER=1: this node has no cluster identity on disk yet (${nodeIdentityPath(env)} is ` +
          'absent) — a spoke gets one from `cezar cluster join <code>`; arming nothing until it does.',
      );
      return;
    }

    const mode = clusterModeFromEnv(env);
    if (!mode.enabled) return; // unreachable — `clusterEnabled` above reads the exact same env var

    if (identity.role === 'hub') {
      if (mode.role !== 'hub') {
        warn(
          `CEZ_CLUSTER: this node's identity says role "hub", but the environment says "${mode.role}" ` +
            '(CEZ_CLUSTER_HUB is set) — refusing to guess which is right; arming nothing until they agree.',
        );
        return;
      }
      if (disposed) return; // stop() ran while identity was loading — never arm a link it cannot reach

      // A forward declaration so `buildHubReplication`'s `sendTo`/`connectedNodes` can reach the
      // `ClusterLinkServer` instance whose OWN constructor needs the router that needs them. Safe —
      // see `buildHubReplication`'s docblock for the full argument — because `onFrame` cannot run
      // before a real socket has authenticated and delivered a message, which is always later than
      // this synchronous assignment.
      let linkServer: ClusterLinkServer | undefined;
      const replication = buildHubReplication(identity, env, warn, () => linkServer);

      // B2a: sweep op-history's durable per-opId verdict cache on its own timer, independent of the
      // instance `buildHubReplication` builds internally for `applyOp`/`findAppliedOp`/
      // `recordAppliedOp` — both point at the same `op-history.json` and neither holds in-memory
      // state beyond the file, so two instances are exactly as correct as one (op-history.ts's own
      // module docblock). See `OP_HISTORY_PRUNE_INTERVAL_MS`'s docblock for the cadence trade. One
      // immediate sweep on arm: at ~10 blue-green restarts/day this is the sweep that actually runs
      // in production; the interval is the backstop for a long-lived hub.
      const opHistory = createOpHistoryStore({ env, warn });
      const pruneOnce = (): void => {
        // `prune()` REJECTS on whole-file corruption (op-history.ts). Unhandled inside a timer
        // callback has no caller to receive it — an uncaught rejection there kills the process.
        void opHistory
          .prune()
          .then((removed) => {
            if (removed > 0) warn(`cluster hub: pruned ${removed} expired op-history verdict(s)`);
          })
          .catch((err: unknown) => {
            warn(`cluster hub: op-history prune failed, retrying next sweep: ${errorMessage(err)}`);
          });
      };
      pruneOnce();
      const pruneTimer = setInterval(pruneOnce, OP_HISTORY_PRUNE_INTERVAL_MS);
      // A CLI process must be able to exit with a hub link open; a maintenance sweep must never be
      // the thing holding the event loop alive — same reason as `spoke-runtime.ts`'s own timers.
      pruneTimer.unref?.();

      // **Milestone C activation.** The dispatcher is what turns a placement into a frame on the
      // wire and correlates the spoke's answer back. Constructed here, and NOT inside
      // `createHubFrameRouter`, because the router must be able to route a reply INTO it — so the
      // dispatcher has to exist first, and the router receives it as `dispatchCorrelation`.
      //
      // `() => linkServer` closes over the same forward-declared `let` `buildHubReplication` above
      // already does, and is safe for the identical reason documented there: nothing can call
      // `send` before a socket has authenticated and delivered a frame, which is strictly later
      // than the synchronous assignment three statements down.
      //
      // Constructing it has NO side effect (`HubDispatcher#sweepUnanswered`'s docblock: "nothing
      // here starts one itself"), so this line alone changes no behaviour — a hub with no dispatch
      // caller behaves exactly as it did before. What it DOES change is that a `freshness` reply
      // carrying `accepted`/`refused` now resolves the dispatch it answers, instead of being
      // observed and dropped (`hub-router.ts:617`, the `?? []` branch).
      const dispatcher: HubDispatcher = createHubDispatcher({
        hubNodeId: identity.nodeId,
        linkServer: () => linkServer,
        env,
        warn,
      });

      // A `'pending'` record inflates its target's `active` in every subsequent placement this hub
      // makes (`dispatch()`'s "placement hot-spot" adjustment), so a dispatch that is never
      // answered does not merely sit in a list — it makes its node look permanently busier than it
      // is, and eventually unplaceable. The sweep is what bounds that, by moving it to the named
      // terminal state `'unanswered'`.
      //
      // **This sweep LABELS; it does not re-dispatch.** Re-dispatching from here would convert a
      // lost accept into two live runs on two machines (spec item 10) — the sweep deliberately
      // stops at the label, and a fresh attempt can only come from the todo's next reconcile pass,
      // by which time an accepted run's own claim op has normally stamped `startedTaskId` and the
      // pass skips it. That residual window (spoke started, claim op still in the outbox, dispatch
      // already swept) is D41 and is NOT closed here.
      const dispatchSweepTimer = setInterval(() => {
        const swept = dispatcher.sweepUnanswered();
        for (const record of swept) {
          warn(
            `cluster hub: dispatch "${record.dispatchId}" for todo "${record.todoId}" to ` +
              `"${record.nodeId}" was never answered — marking unanswered (not re-dispatching)`,
          );
        }
      }, DISPATCH_SWEEP_INTERVAL_MS);
      // Same reason as `pruneTimer` above: a maintenance sweep must never hold the event loop open.
      dispatchSweepTimer.unref?.();

      linkServer = new ClusterLinkServer({
        identity,
        onFrame: createHubFrameRouter({
          identity,
          env,
          warn,
          replication,
          // Without this the hub sends dispatches and never learns their fate: `hub-router.ts`'s
          // `freshness` case falls through to `?? []` and the record stays `'pending'` until the
          // sweep above mislabels it `'unanswered'` — i.e. every accepted run would look lost.
          dispatchCorrelation: dispatcher,
        }),
        warn,
      });
      linkServer.attach(deps.server);

      // **This is the line that makes work distribute.** Everything above builds the machinery;
      // `todo-autostart.ts` is what actually turns an `autostart: true` todo into a run, and until
      // this arms, it has no placement to consult and starts everything locally — which is how a
      // fully built dispatch stack sat with zero production callers.
      let disarmAutostart: () => void = () => {};
      if (deps.semaphore) {
        disarmAutostart = armClusterAutostart(
          {
            // NOT `CLUSTERING_OFF` — see `createHubAutostartCluster`. A hub does not ask itself for
            // permission, but it must still read `startedTaskId`/`startedOn` off the record, which
            // `CLUSTERING_OFF` would skip on the first line. That read is the only thing that stops
            // a RESTARTED hub re-dispatching work a spoke is already running, because the
            // dispatcher's own duplicate guard is in-memory and does not survive the restart.
            cluster: createHubAutostartCluster(identity.nodeId),
            dispatch: createHubAutostartDispatch({
              dispatcher,
              identity,
              semaphore: deps.semaphore,
              connectedNodeIds: () => linkServer?.connectedNodes() ?? [],
              // The SAME allocator the inbound op path uses (`replication` is the object handed to
              // `createHubFrameRouter` just below), not a second counter over the same file: two
              // allocators would hand out the same number twice and silently retire each other's
              // records via the `hubSeq <= watermark` drop in `cluster/ops.ts`.
              allocateHubSeq: (input) => replication.allocate(input),
              env,
              warn,
            }),
          },
          warn,
        );
      } else {
        // Honest refusal rather than a fabricated capacity. `buildPlacementCandidates` measures
        // this hub's own headroom off the live semaphore; with none threaded through there is no
        // way to report it, and synthesising one would make the hub look either permanently idle
        // or permanently full. Autostart stays local-only on such a process.
        warn(
          'cluster hub: no workspace semaphore was threaded into startClusterRuntime, so this hub ' +
            'cannot measure its own capacity — arming the link but NOT placement; autostart todos ' +
            'will start locally rather than being distributed',
        );
      }

      /**
       * The hub half of the corpus push (spec item 57). On every completed reindex of this node's
       * corpus, tell connected spokes the version moved so they sweep NOW rather than at their next
       * interval — ~108ms measured, against a 60s floor.
       *
       * **Hooked to the reindex, not to `POST /cluster/corpus/submit`.** That route is only the
       * spoke->hub write path; a report drained by `cezar-reports-drain`, a `/cezar-sync` write, or
       * a plain editor save all reach disk without passing through it and would have pushed
       * nothing. `KnowledgeStore`'s `catalogGeneration++` is the one point every write path and both
       * change triggers converge on (its own comment says so), which is the only hook a future
       * writer cannot bypass.
       *
       * The frame carries no paths and no bodies, so a dropped one costs LATENCY ONLY and the
       * interval sweep still catches it. Nothing here may be used to justify lengthening that
       * interval.
       */
      /**
       * **The hub's own outbox (spec item 60) — the reason no work could run on a spoke.**
       *
       * The documented pipeline is "spoke outbox -> hub oplog -> hubSeq -> ack -> replica fan-out";
       * it BEGINS at a spoke, and `deriveTodoOps` had exactly two callers, both in
       * `spoke-runtime.ts`. So a todo created ON this hub never became an op, never got a `hubSeq`,
       * and `replay.ts` refuses to replay a row without one. Measured on production 2026-08-24:
       * 159 todos, `hubSeq` non-null on ZERO, and a paired spoke whose `todos.json` did not exist —
       * so every dispatch was answered "todo is not present locally for project".
       *
       * **Watermarks here are this outbox's own map, not the router's.** The router's are private,
       * in-memory, and re-seeded from each node's `hello` — its own docblock states the asymmetry
       * that makes that safe: *"over-sending costs bandwidth while under-sending loses a write"*. An
       * independent map inherits exactly those properties (starts empty, may re-send, the spoke
       * drops anything at or below its own watermark), so this is the established design rather
       * than a shortcut around it. In practice it does not even re-send: once a record is applied it
       * carries a `hubSeq` and clears `pendingSince`, so `selectOwed` stops returning it.
       */
      const hubOutboxWatermarks = new Map<ClusterNodeId, Map<ClusterProjectKey, number>>();
      const stopHubOutbox = startHubOutbox({
        identity,
        listProjects: async () => {
          const [peers, config] = await Promise.all([
            readPeers({ env, warn }),
            loadWorkspaceConfig(workspaceConfigPath(env)),
          ]);
          const byId = new Map(config.projects.map((project) => [project.id, project]));
          const projects: { projectKey: ClusterProjectKey; dataDir: string }[] = [];
          for (const pairing of peers.pairings) {
            // The hub's OWN side of the pairing, matching `resolveHubTodosRoot`'s `hubMember` gate.
            // A pairing this hub has not confirmed is not a project it may replicate out of.
            const hubMember = pairing.byNode[identity.nodeId];
            if (!hubMember?.confirmedAt) continue;
            const project = byId.get(hubMember.projectId);
            if (!project) continue;
            projects.push({ projectKey: pairing.projectKey, dataDir: todosDataDir(project.root) });
          }
          return projects;
        },
        // The SAME allocator the incoming spoke-`ops` path draws from, so both share one monotonic
        // counter per (scope, projectKey). A second allocator would hand out colliding `hubSeq`.
        allocateSeq: replication.allocate,
        connectedNodes: () => linkServer?.connectedNodes() ?? [],
        readWatermark: (nodeId, projectKey) => hubOutboxWatermarks.get(nodeId)?.get(projectKey) ?? 0,
        advanceWatermark: (nodeId, projectKey, hubSeq) => {
          let perNode = hubOutboxWatermarks.get(nodeId);
          if (!perNode) {
            perNode = new Map();
            hubOutboxWatermarks.set(nodeId, perNode);
          }
          // Monotonic: never move a watermark backwards, or an out-of-order advance would re-open a
          // window the receiver has already passed.
          if ((perNode.get(projectKey) ?? 0) < hubSeq) perNode.set(projectKey, hubSeq);
        },
        sendTo: (nodeId, frame) => linkServer?.send(nodeId, frame) ?? false,
        warn,
      });
      if (stopHubOutbox.status !== 'armed') {
        warn(`cluster hub: outbox not armed (${stopHubOutbox.status})${stopHubOutbox.reason ? `: ${stopHubOutbox.reason}` : ''}`);
      }

      const corpusBroadcaster = createCorpusBroadcaster({
        link: {
          connectedNodes: () => linkServer?.connectedNodes() ?? [],
          send: (nodeId, frame) => linkServer?.send(nodeId, frame) ?? false,
        },
        readCorpusVersion: async () => {
          const manifest = await buildManifest(CLUSTER_CORPUS_DEFAULT_SCOPE, undefined, { env });
          return manifest.corpusVersion;
        },
        warn,
      });
      const unregisterCorpusListener = setCorpusChangeListener(() => corpusBroadcaster.notifyChanged(), { warn });

      teardown = () => {
        clearInterval(pruneTimer);
        clearInterval(dispatchSweepTimer);
        disarmAutostart();
        unregisterCorpusListener();
        corpusBroadcaster.stop();
        stopHubOutbox();
        void linkServer?.close();
      };
      return;
    }

    // identity.role === 'spoke' — `clusterNodeRoleSchema` has no third value.
    const hubUrl = identity.hubUrl;
    if (!hubUrl) {
      warn(
        `cluster: this node's identity is a spoke with no hubUrl recorded (${nodeIdentityPath(env)} ` +
          'is corrupt or was hand-edited) — arming nothing.',
      );
      return;
    }
    if (mode.role !== 'spoke' || mode.hubUrl !== hubUrl) {
      const envSays = mode.role === 'spoke' ? `"${mode.hubUrl}"` : 'this node is the hub';
      warn(
        `CEZ_CLUSTER_HUB: this node was enrolled as a spoke of "${hubUrl}", but the environment says ` +
          `${envSays} — refusing to guess which is right; arming nothing until they agree.`,
      );
      return;
    }

    if (disposed) return; // stop() ran while identity was loading — never arm a link it cannot reach
    // D38 — the spoke's `hello` reports where it actually is, instead of the hardcoded `[]` that
    // made every reconnect replay the whole scope. LATE-BOUND, and not as a matter of taste: the
    // runtime holding these numbers does not exist yet on the next line, and it takes `linkClient`
    // as its own dependency, so this is a genuine cycle and a value passed here could only ever be
    // the empty one. Same shape as `buildHubReplication`'s `sendTo: (…) => linkServer()?.…` above.
    //
    // The `?? []` is a floor, NOT a window this code actually passes through — measured, because
    // the first version of this comment claimed it was. `start()` -> `dial()` -> `new WebSocket()`
    // returns synchronously and `sendHello` fires from `ws.on('open')` (`link-client.ts:274`),
    // which needs a network round trip; the assignment below runs synchronously two statements
    // later. So no `hello` is ever sent with `spokeRuntime` unassigned, and a test asserting an
    // empty first `hello` is observing "nothing applied yet", never "the runtime is unwired" —
    // two true statements producing identical bytes, only one of them a mechanism. Keep the
    // fallback anyway: it costs nothing and the ordering above is a property of another file.
    //
    // `[]` is also the correct answer after a process
    // restart: `spoke-runtime.ts` holds these in memory only, deliberately, so `[]` there means
    // "I genuinely do not know where I am", and a full replay is the right consequence. Nothing is
    // persisted here for exactly that reason — persisting would reassert a position across a
    // restart that the runtime cannot vouch for, turning a bounded over-send into a silent
    // under-send.
    let spokeRuntime: SpokeRuntimeHandle | undefined;
    const linkClient = new ClusterLinkClient({
      identity,
      hubUrl,
      version: deps.version,
      warn,
      watermarks: () => spokeRuntime?.watermarks() ?? [],
    });
    linkClient.start();

    /**
     * The corpus mirror (D8a, spec items 56/57/59). Armed here rather than inside
     * `startSpokeRuntime` because it needs the awaited `identity` this async branch already holds,
     * and because it is a PEER of the link rather than a child of it — it keeps sweeping on its own
     * 60s clock whether or not the socket is up, which is the whole point of the interval being a
     * floor rather than a consequence of a push.
     *
     * **`listProjects` reads every REGISTERED project, not only confirmed pairings** (item 59).
     * Gating on pairings would make the mirror inherit item 58's two-sided handshake — a fresh
     * worker would mirror NOTHING until a human confirmed on both machines, silently, which is the
     * exact inert failure D8a exists to prevent and is against "everything on by default". Pairing
     * grants WORK (todo replication, dispatch); mirroring a read-only corpus into a project this
     * node already has locally is not a work grant. The hub enforces scope on its own side either
     * way, so this widens nothing a node was not already granted.
     *
     * Re-read every sweep, never captured once: a project registered after boot mirrors with no
     * restart, matching `discoverOutboxProjects`'s own re-read-from-disk posture.
     */
    const corpusMirror = startCorpusMirrorRuntime({
      identity,
      listProjects: () => corpusMirrorProjectDataDirs({ bootProjectRoot: deps.bootProjectRoot, env }),
      warn,
    });
    if (corpusMirror.status !== 'armed') {
      warn(`cluster spoke: corpus mirror not armed (${corpusMirror.status})${corpusMirror.reason ? `: ${corpusMirror.reason}` : ''}`);
    }

    const stopHeartbeat = startSpokeRuntime({
      link: linkClient,
      env,
      warn,
      resolveDispatchManager: deps.resolveDispatchManager,
      semaphore: deps.semaphore,
      heartbeatMs: deps.heartbeatMs,
      // D-active: the real, disk-backed default — see `collectLocalActiveRuns`'s own doc for why
      // it can be built here (self-contained, `WorkspaceRunIndex`-based) rather than threaded from
      // `server.ts` the way `resolveDispatchManager`/`semaphore` are. `deps.listActiveRuns` stays a
      // test-only override (`ClusterRuntimeDeps#listActiveRuns`'s own doc); production never sets it.
      listActiveRuns: deps.listActiveRuns ?? (() => collectLocalActiveRuns(identity.nodeId, { env })),
      // The hub's `corpus-changed` hint sweeps NOW instead of at the next interval. The frame is
      // deliberately not forwarded: it is a hint, and the sweep is the authoritative read.
      onCorpusChanged: () => void corpusMirror.triggerSweep(),
    });
    spokeRuntime = stopHeartbeat;

    // **The spoke half of the same activation, and it is a GUARD rather than a feature.** Without
    // it this node runs `CLUSTERING_OFF`, under which `mayAutostartTodo` allows on its first line —
    // so a todo replicated down from the hub would be started locally by this node's own reconcile
    // pass AT THE SAME TIME as the hub dispatches it. Two agents, two worktrees, one todo. Note
    // that `todos.ts`'s `hub-unconfirmed` refusal does NOT prevent that: it withholds the STAMP,
    // and by the time it runs `startTodoRun` has already started the agent.
    const disarmAutostart = armClusterAutostart(
      {
        cluster: createSpokeAutostartCluster({
          nodeId: identity.nodeId,
          // `online` is the only state in which the hub can actually answer. `connecting` is not
          // reachable-yet, and treating it as reachable would send a claim into a socket that does
          // not exist.
          hubReachable: () => linkClient.health().state === 'online',
          // A worker self-starts nothing — see `createSpokeAutostartCluster#authoredHere` for why
          // this is a stated policy and not a missing implementation.
          authoredHere: () => false,
        }),
        // A worker never PLACES work; it executes what it is dispatched.
        dispatch: DISPATCH_LOCAL,
      },
      warn,
    );

    teardown = () => {
      stopHeartbeat();
      disarmAutostart();
      corpusMirror.dispose();
      void linkClient.stop();
    };
  })().catch((err: unknown) => {
    warn(`cluster: activation failed unexpectedly: ${errorMessage(err)}`);
  });

  return () => {
    if (disposed) return;
    disposed = true;
    teardown?.();
  };
}
