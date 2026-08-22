import { Hono } from 'hono';
import type { Context, Next } from 'hono';
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
  type ClusterNodeRevokeResponse,
  type ClusterOverviewResponse,
  type ClusterPairing,
  type ClusterPairingProposal,
  type ClusterPairingsResponse,
  type ClusterRemoteRun,
  type ClusterSelf,
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
import { loadNodeIdentity } from '../cluster/node-identity.ts';
import { applyPairingAction, disableNode, readPeers, upsertNode } from '../cluster/peers.ts';
import { readRemoteRuns } from '../cluster/run-projection.ts';
import { loadServerState } from '../server-install/state.ts';

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
 */

export interface ClusterRouteDeps {
  /** This node's cezar version. Pinned into the rendered `npx` join command rather than `@latest`
   *  (D13: protocol skew is permanent, so a node should start life matched to the hub that minted
   *  it), and reported on `self`. `server.ts` passes `deps.version`. */
  version: string;
  /** Injected so a test can pin the flag without mutating `process.env`. */
  env?: NodeJS.ProcessEnv;
}

const CLUSTER_OFF =
  'clustering is disabled — set CEZ_CLUSTER=1 (and CEZ_CLUSTER_HUB=<url> to join one as a spoke) and restart cezar';
const NOT_A_HUB = 'this node is a spoke — enrollment, leases and allocation are hub-side only';
const NO_IDENTITY = 'this node has no cluster identity yet — run `cezar cluster join <code>` first';
const CORPUS_PENDING =
  'the corpus mirror is not available yet — the hub-side corpus sweep (plan 3b.2) has not landed; nothing is mirrored and nothing can be submitted';

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
       *  multi-node worse than one machine. */
      .post(
        '/cluster/allocate/:kind',
        paramZodValidator(clusterAllocateKindParamSchema),
        jsonZodValidator(clusterAllocateRequestSchema, { absent: {} }),
        async (c) => {
          const identity = await loadNodeIdentity({ env });
          const body: ClusterAllocateResponse = await allocate(
            c.req.valid('param').kind,
            identity?.nodeId ?? '',
            c.req.valid('json'),
            { env },
          );
          return c.json(body, 201);
        },
      )

      // ---- leases (D15b) ---------------------------------------------------------------------
      /** What is still a lease after D4/D9a: what guards a RESOURCE rather than a record. A claim
       *  is not here — the hub linearizes, so its acknowledgement IS the stamp. */
      .post(
        '/cluster/leases/:kind',
        paramZodValidator(clusterLeaseKindParamSchema),
        jsonZodValidator(clusterLeaseRequestSchema),
        async (c) => {
          const identity = await loadNodeIdentity({ env });
          const body: ClusterLeaseResponse = await acquireLease(
            c.req.valid('param').kind,
            identity?.nodeId ?? '',
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
          const identity = await loadNodeIdentity({ env });
          // `false` when this node is not the recorded holder: releasing someone else's lease is
          // the bug this return value exists to make visible, not a no-op to swallow.
          const released = await releaseLease(kind, id, identity?.nodeId ?? '', { env });
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
