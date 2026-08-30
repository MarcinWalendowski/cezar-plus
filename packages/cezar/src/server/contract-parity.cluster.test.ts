import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InferRequestType, InferResponseType } from 'hono/client';
import { hc } from 'hono/client';
import { describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import type { z } from 'zod';
import type {
  clusterActiveResponseSchema,
  clusterAllocateKindParamSchema,
  clusterAllocateRequestSchema,
  clusterCodeIdParamSchema,
  clusterAllocateResponseSchema,
  clusterEnrollRequestSchema,
  clusterEnrollResponseSchema,
  clusterEnrollRevokeResponseSchema,
  clusterJoinRequestSchema,
  clusterJoinResponseSchema,
  clusterLeaseIdParamSchema,
  clusterLeaseKindParamSchema,
  clusterLeaseReleaseResponseSchema,
  clusterLeaseRequestSchema,
  clusterLeaseResponseSchema,
  clusterNodeIdParamSchema,
  clusterNodeSchema,
  clusterNodePatchSchema,
  clusterNodeRevokeResponseSchema,
  clusterOverviewResponseSchema,
  clusterPairingActionSchema,
  clusterPairingsResponseSchema,
  clusterProjectKeyParamSchema,
  clusterTodosAppendRequestSchema,
  clusterTodosAppendResponseSchema,
  clusterTodosBackupResponseSchema,
  clusterTodosSnapshotResponseSchema,
} from '@loki-labs/cezar-plus-contract';
import type { AppType } from './app-type.ts';

/**
 * Same guard as `contract-parity.test.ts` and `contract-parity.workflows.test.ts`, for the CLUSTER
 * family (`.ai/specs/2026-08-22-multi-node-cezar-cluster.md` → "HTTP invariants": every shape a zod
 * schema in `packages/contract`, routes chained into a family builder so they reach `AppType`,
 * `contract-parity.cluster.test.ts` **both directions**).
 *
 * See `contract-parity.test.ts` for why every assertion is MUTUAL: one-way assignability passes on
 * genuine drift, in both directions, and has done so historically.
 *
 * **This file is also the check that the family is CHAINED.** A route defined but not chained into
 * the builder vanishes from `AppType` silently — the api-client and the cockpit simply cannot see
 * it, and nothing fails — so every `InferResponseType` below is doing two jobs: proving the shape
 * matches, and proving the route reached the type at all. A dropped `.route('/', clusterRoutes)` in
 * `server.ts` fails this file at `tsc`, which is the only place it would fail loudly.
 *
 * Compile-time; `npm run typecheck` enforces it. The `it()` keeps the file visible as a test.
 *
 * **Request bodies are asserted too, not only responses**, and that half is the one that catches a
 * validator declared inside a handler instead of as middleware: Hono only records a validated shape
 * in the route type when validation happens as middleware, so an inline `safeParse` leaves
 * `InferRequestType` as `unknown`/`{}` and the assertion below fails — which is exactly the failure
 * `POST /runs` accepting `{ totalNonsense: 12345 }` from `hc` used to be.
 *
 * `GET /cluster/corpus*` and `POST /cluster/corpus/submit` carry no RESPONSE assertion: they answer
 * a stated 409 until package 3b.2 lands their bodies, and asserting a 200 shape against a route
 * that never sends one would be a test that cannot fail. The submit REQUEST body is asserted,
 * because that half is real today.
 */
describe('src/contract cluster schemas match the cluster routes exactly', () => {
  const client = hc<AppType>('http://127.0.0.1');

  /** `true` only when the two types are assignable BOTH ways. */
  type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : 'route-is-wider') : 'schema-is-wider';
  type Exact<Schema, Route> = Mutual<Schema, Route>;
  type Assert<T extends true> = T;

  // ---- roster ------------------------------------------------------------------------------
  type Overview200 = InferResponseType<typeof client.api.v1.cluster.$get, 200>;

  // ---- enrollment --------------------------------------------------------------------------
  type Enroll201 = InferResponseType<typeof client.api.v1.cluster.enroll.$post, 201>;
  type EnrollBody = InferRequestType<typeof client.api.v1.cluster.enroll.$post>['json'];
  type EnrollRevoke200 = InferResponseType<
    (typeof client.api.v1.cluster.enroll)[':codeId']['$delete'],
    200
  >;
  type Join200 = InferResponseType<typeof client.api.v1.cluster.join.$post, 200>;
  type JoinBody = InferRequestType<typeof client.api.v1.cluster.join.$post>['json'];

  // ---- nodes -------------------------------------------------------------------------------
  type NodePatch200 = InferResponseType<(typeof client.api.v1.cluster.nodes)[':nodeId']['$patch'], 200>;
  type NodePatchBody = InferRequestType<
    (typeof client.api.v1.cluster.nodes)[':nodeId']['$patch']
  >['json'];
  type NodeRevoke200 = InferResponseType<
    (typeof client.api.v1.cluster.nodes)[':nodeId']['$delete'],
    200
  >;

  // ---- pairings ----------------------------------------------------------------------------
  type Pairings200 = InferResponseType<typeof client.api.v1.cluster.pairings.$get, 200>;
  type PairingAction200 = InferResponseType<
    (typeof client.api.v1.cluster.pairings)[':projectKey']['$post'],
    200
  >;
  type PairingActionBody = InferRequestType<
    (typeof client.api.v1.cluster.pairings)[':projectKey']['$post']
  >['json'];

  // ---- corpus (request half only — see the header) -------------------------------------------
  type CorpusSubmitBody = InferRequestType<typeof client.api.v1.cluster.corpus.submit.$post>['json'];

  // ---- todos snapshot, backup, append (D21) --------------------------------------------------
  type TodosSnapshot200 = InferResponseType<(typeof client.api.v1.cluster.todos)[':projectKey']['$get'], 200>;
  type TodosSnapshotParam = InferRequestType<
    (typeof client.api.v1.cluster.todos)[':projectKey']['$get']
  >['param'];
  type TodosBackup200 = InferResponseType<
    (typeof client.api.v1.cluster.todos)[':projectKey']['backup']['$post'],
    200
  >;
  type TodosBackupParam = InferRequestType<
    (typeof client.api.v1.cluster.todos)[':projectKey']['backup']['$post']
  >['param'];
  type TodosAppend200 = InferResponseType<
    (typeof client.api.v1.cluster.todos)[':projectKey']['append']['$post'],
    200
  >;
  type TodosAppendBody = InferRequestType<
    (typeof client.api.v1.cluster.todos)[':projectKey']['append']['$post']
  >['json'];
  type TodosAppendParam = InferRequestType<
    (typeof client.api.v1.cluster.todos)[':projectKey']['append']['$post']
  >['param'];

  // ---- active, allocate, leases ---------------------------------------------------------------
  type Active200 = InferResponseType<typeof client.api.v1.cluster.active.$get, 200>;
  type Allocate201 = InferResponseType<(typeof client.api.v1.cluster.allocate)[':kind']['$post'], 201>;
  type AllocateBody = InferRequestType<
    (typeof client.api.v1.cluster.allocate)[':kind']['$post']
  >['json'];
  type Lease200 = InferResponseType<(typeof client.api.v1.cluster.leases)[':kind']['$post'], 200>;
  type LeaseBody = InferRequestType<(typeof client.api.v1.cluster.leases)[':kind']['$post']>['json'];
  type LeaseRelease200 = InferResponseType<
    (typeof client.api.v1.cluster.leases)[':kind'][':id']['$delete'],
    200
  >;

  // ---- path params ----------------------------------------------------------------------------
  // The third half, which nothing else asserts: the contract's param schema and the route's path
  // segment must agree on the NAME and the SHAPE. Rename `codeId` to `enrollmentId` in
  // `packages/contract/src/cluster.ts` and leave `/cluster/enroll/:codeId` alone, and these fail.
  //
  // **MEASURED — what they do NOT catch: a missing `paramZodValidator`.** Deleting the middleware
  // from `DELETE /cluster/enroll/:codeId` and reading `c.req.param('codeId')` inside the handler
  // instead leaves `tsc --noEmit -p tsconfig.test.json` completely clean, because hono derives the
  // `param` shape from the path PATTERN, not from the validator — unlike `json`, where the shape
  // exists only if a validator declared it. So the body assertions above really are the
  // "validation must be middleware" guard and the param ones are not; the runtime case at the
  // bottom of this file is what covers that, by proving a bad param is refused with a 400.
  //
  // (Note for anyone re-checking this: `packages/cezar/tsconfig.json` EXCLUDES `*.test.ts`, so
  // running tsc against it makes every assertion in this file silently vacuous — a deliberately
  // wrong `Exact<{a: string}, Overview200>` passes. `tsconfig.test.json` is the one that enforces
  // it, and is what `npm run typecheck -w @loki-labs/cezar-plus` runs.)
  type EnrollRevokeParam = InferRequestType<
    (typeof client.api.v1.cluster.enroll)[':codeId']['$delete']
  >['param'];
  type NodePatchParam = InferRequestType<
    (typeof client.api.v1.cluster.nodes)[':nodeId']['$patch']
  >['param'];
  type NodeRevokeParam = InferRequestType<
    (typeof client.api.v1.cluster.nodes)[':nodeId']['$delete']
  >['param'];
  type PairingActionParam = InferRequestType<
    (typeof client.api.v1.cluster.pairings)[':projectKey']['$post']
  >['param'];
  type AllocateParam = InferRequestType<
    (typeof client.api.v1.cluster.allocate)[':kind']['$post']
  >['param'];
  type LeaseParam = InferRequestType<(typeof client.api.v1.cluster.leases)[':kind']['$post']>['param'];
  type LeaseReleaseParam = InferRequestType<
    (typeof client.api.v1.cluster.leases)[':kind'][':id']['$delete']
  >['param'];

  type _Checks = [
    Assert<Exact<z.infer<typeof clusterOverviewResponseSchema>, Overview200>>,
    Assert<Exact<z.infer<typeof clusterEnrollResponseSchema>, Enroll201>>,
    Assert<Exact<z.input<typeof clusterEnrollRequestSchema>, EnrollBody>>,
    Assert<Exact<z.infer<typeof clusterEnrollRevokeResponseSchema>, EnrollRevoke200>>,
    Assert<Exact<z.infer<typeof clusterJoinResponseSchema>, Join200>>,
    Assert<Exact<z.input<typeof clusterJoinRequestSchema>, JoinBody>>,
    Assert<Exact<z.infer<typeof clusterNodeSchema>, NodePatch200>>,
    Assert<Exact<z.input<typeof clusterNodePatchSchema>, NodePatchBody>>,
    Assert<Exact<z.infer<typeof clusterNodeRevokeResponseSchema>, NodeRevoke200>>,
    Assert<Exact<z.infer<typeof clusterPairingsResponseSchema>, Pairings200>>,
    Assert<Exact<z.infer<typeof clusterPairingsResponseSchema>, PairingAction200>>,
    Assert<Exact<z.input<typeof clusterPairingActionSchema>, PairingActionBody>>,
    Assert<Exact<z.infer<typeof clusterActiveResponseSchema>, Active200>>,
    Assert<Exact<z.infer<typeof clusterAllocateResponseSchema>, Allocate201>>,
    Assert<Exact<z.input<typeof clusterAllocateRequestSchema>, AllocateBody>>,
    Assert<Exact<z.infer<typeof clusterLeaseResponseSchema>, Lease200>>,
    Assert<Exact<z.input<typeof clusterLeaseRequestSchema>, LeaseBody>>,
    Assert<Exact<z.infer<typeof clusterLeaseReleaseResponseSchema>, LeaseRelease200>>,
    Assert<Exact<z.infer<typeof clusterTodosSnapshotResponseSchema>, TodosSnapshot200>>,
    Assert<Exact<z.infer<typeof clusterTodosBackupResponseSchema>, TodosBackup200>>,
    Assert<Exact<z.infer<typeof clusterTodosAppendResponseSchema>, TodosAppend200>>,
    Assert<Exact<z.input<typeof clusterTodosAppendRequestSchema>, TodosAppendBody>>,

    Assert<Exact<z.input<typeof clusterCodeIdParamSchema>, EnrollRevokeParam>>,
    Assert<Exact<z.input<typeof clusterNodeIdParamSchema>, NodePatchParam>>,
    Assert<Exact<z.input<typeof clusterNodeIdParamSchema>, NodeRevokeParam>>,
    Assert<Exact<z.input<typeof clusterProjectKeyParamSchema>, PairingActionParam>>,
    Assert<Exact<z.input<typeof clusterAllocateKindParamSchema>, AllocateParam>>,
    Assert<Exact<z.input<typeof clusterLeaseKindParamSchema>, LeaseParam>>,
    Assert<Exact<z.input<typeof clusterLeaseIdParamSchema>, LeaseReleaseParam>>,
    Assert<Exact<z.input<typeof clusterProjectKeyParamSchema>, TodosSnapshotParam>>,
    Assert<Exact<z.input<typeof clusterProjectKeyParamSchema>, TodosBackupParam>>,
    Assert<Exact<z.input<typeof clusterProjectKeyParamSchema>, TodosAppendParam>>,
  ];

  it('is enforced by tsc, not at runtime', () => {
    // Pins the comparator itself: a `Mutual` that degenerated to `true` would make every
    // assertion above vacuous, exactly the trap this file is meant to avoid.
    const wider: Mutual<{ a: string }, { a: string; b: number }> = 'schema-is-wider';
    const narrower: Mutual<{ a: string; b: number }, { a: string }> = 'route-is-wider';
    expect([wider, narrower]).toEqual(['schema-is-wider', 'route-is-wider']);
  });

  it('refuses a path param the schema rejects, which the compile-time half cannot see', async () => {
    // The runtime counterpart to the param block above. `clusterNodeIdSchema` is
    // `z.string().min(1).max(64)`, and `PATCH /cluster/nodes/:nodeId` is the one param route with
    // no hub gate in front of it, so the validator is reachable on a node with no identity.
    // Delete `paramZodValidator(clusterNodeIdParamSchema)` from that route and this goes 404
    // (`unknown node`) instead of 400 — the compile-time assertions stay green either way.
    const repoRoot = mkdtempSync(join(tmpdir(), 'cez-cluster-param-'));
    const saved = process.env.CEZ_CLUSTER;
    const savedHome = process.env.CEZ_HOME;
    const home = mkdtempSync(join(tmpdir(), 'cez-cluster-param-home-'));
    process.env.CEZ_CLUSTER = '1';
    process.env.CEZ_HOME = home;
    try {
      const app = createApp({
        repoRoot,
        store: RunStore.open(join(repoRoot, '.ai/cezar')),
        manager: {} as RunManager,
        version: '0.0.0-test',
      });
      const res = await apiRequest(app, `/api/v1/cluster/nodes/${'n'.repeat(65)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ acceptsDispatch: false }),
      });
      expect(res.status).toBe(400);

      // The floor: a WELL-FORMED id reaches the handler, so the 400 above is the validator
      // rejecting the value and not the route being unreachable for some unrelated reason.
      const ok = await apiRequest(app, '/api/v1/cluster/nodes/node_1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ acceptsDispatch: false }),
      });
      expect(ok.status).toBe(404);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      if (saved === undefined) delete process.env.CEZ_CLUSTER;
      else process.env.CEZ_CLUSTER = saved;
      if (savedHome === undefined) delete process.env.CEZ_HOME;
      else process.env.CEZ_HOME = savedHome;
    }
  });

  it('keeps the corpus submit body on the wire even while the route answers 409', () => {
    // The corpus family has no 200 to assert (package 3b.2), but its request body is real today
    // and must not drift; the compile-time check above covers it. This runtime case exists so the
    // omission is visible as a decision rather than looking like a forgotten route.
    const submitBodyIsTyped: Mutual<
      { path: string; body: string; baseVersion?: string; note?: string },
      CorpusSubmitBody
    > = true;
    expect(submitBodyIsTyped).toBe(true);
  });
});
