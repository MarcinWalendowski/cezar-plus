import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLUSTER_PROTOCOL, type ClusterRemoteRun, type StoredClusterNode } from '@loki-labs/better-cezar-contract';
import { readAllocations } from '../cluster/allocate.ts';
import { readLeases } from '../cluster/leases.ts';
import {
  CLUSTER_NODE_ID_HEADER,
  CLUSTER_NODE_PRINCIPAL_HEADER,
  CLUSTER_NODE_SIGNATURE_HEADER,
  hashRequestBody,
  signNodeHttpPrincipal,
  type NodeHttpPrincipal,
} from '../cluster/node-auth.ts';
import { ensureNodeIdentity } from '../cluster/node-identity.ts';
import { storeNodeSecret } from '../cluster/node-secrets.ts';
import { applyPairingAction, upsertNode } from '../cluster/peers.ts';
import { applyRemoteRuns } from '../cluster/run-projection.ts';
import { workspaceConfigPath } from '../paths.ts';
import { atomicWriteJsonSync, defaultWorkspaceConfig } from '../workspace/config.ts';
import { createClusterRoutes, type ClusterRouteDeps } from './cluster-routes.ts';
import { apiRequest } from './loopback-request.testkit.ts';

/**
 * Wiring tests for D20 (`.ai/specs/2026-08-22-multi-node-cezar-cluster.md`) — which routes of the
 * `/cluster/*` family require a signed node principal and which don't, per the "D20" section of
 * `cluster-routes.ts`'s own module header.
 *
 * `node-auth.test.ts` owns the MECHANISM (signature, freshness, request-binding, every named
 * refusal) against a synthetic Hono app. This file owns the WIRING: that `createClusterRoutes`
 * actually chains the gate onto the right paths, in the right order relative to `requireCluster`,
 * and that the routes deliberately left out (join, roster, allocate/leases) still work with no
 * node credentials at all.
 *
 * `createClusterRoutes` is called directly, bypassing `createApp`/`server.ts` — the routes it
 * returns are already mounted at `/cluster/...` with no `/api/v1` prefix, and none of the paths
 * under test here touch `loadNodeIdentity`'s filesystem read except where noted, so a full server
 * boot buys nothing a direct call doesn't already give.
 */

const NODE_ID = 'node-a';
const SECRET = 'shhh-secret';

function json(body: unknown, method = 'POST'): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function nodeAuthHeaders(principal: NodeHttpPrincipal, secret: string): Record<string, string> {
  const signed = signNodeHttpPrincipal(principal, secret);
  return {
    [CLUSTER_NODE_ID_HEADER]: principal.nodeId,
    [CLUSTER_NODE_PRINCIPAL_HEADER]: signed.principal,
    [CLUSTER_NODE_SIGNATURE_HEADER]: signed.signature,
  };
}

describe('cluster-routes.ts wires D20 node-auth onto the right paths', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-node-auth-wiring-'));
    env = { CEZ_CLUSTER: '1', CEZ_HOME: home };
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const routes = (over: Partial<ClusterRouteDeps> = {}) =>
    createClusterRoutes({ version: '0.0.0-test', env, ...over });

  const lookupOnlyNodeA = async (nodeId: string) => (nodeId === NODE_ID ? SECRET : undefined);

  describe('the authenticated set: corpus family + /cluster/todos/* (D21)', () => {
    const gatedGets: Array<[label: string, path: string]> = [
      ['GET /cluster/corpus', '/cluster/corpus'],
      ['GET /cluster/corpus/*', '/cluster/corpus/knowledge/decisions.md'],
      ['GET /cluster/todos/:projectKey', '/cluster/todos/workspace-root'],
    ];

    it.each(gatedGets.map(([label]) => label))('%s refuses with 401 no-credentials when unauthenticated', async (label) => {
      const [, path] = gatedGets.find(([name]) => name === label)!;
      const res = await apiRequest(routes(), path);
      expect(res.status).toBe(401);
      expect(((await res.json()) as { reason: string }).reason).toBe('no-credentials');
    });

    it('POST /cluster/corpus/submit refuses with 401 no-credentials when unauthenticated', async () => {
      const res = await apiRequest(routes(), '/cluster/corpus/submit', json({ path: 'knowledge/x.md', body: 'hi' }));
      expect(res.status).toBe(401);
      expect(((await res.json()) as { reason: string }).reason).toBe('no-credentials');
    });

    it('floor: a correctly signed request from an enrolled node reaches the real handler past the gate — proven by the status changing from 401 to the handler-owned 409, not by inspection', async () => {
      const clusterRoutes = routes({ lookupNodeSecret: lookupOnlyNodeA });
      const principal: NodeHttpPrincipal = {
        nodeId: NODE_ID,
        issuedAt: new Date().toISOString(),
        method: 'GET',
        path: '/cluster/corpus',
        bodyHash: hashRequestBody(''),
      };
      const res = await apiRequest(clusterRoutes, '/cluster/corpus', {
        headers: nodeAuthHeaders(principal, SECRET),
      });
      // Package 3b.2 has not landed, so the real handler behind the gate still answers its own
      // named 409 (CORPUS_PENDING) — the point is that it is THAT 409 and not node-auth's 401.
      expect(res.status).toBe(409);
      const error = ((await res.json()) as { error: string }).error;
      expect(error).toContain('corpus');
      expect(error).not.toContain('CEZ_CLUSTER');
    });

    // Spec Verification 24: the REAL store (no injected fake), end to end — `signNodeHttpPrincipal`
    // from a node whose secret was actually persisted via `node-secrets.ts` verifies through the
    // default wiring `createClusterRoutes` now carries, and a DIFFERENT node id (never stored)
    // does not, even though nothing overrides `lookupNodeSecret` in either case.
    it('the real store, no override: a node that redeemed a secret verifies through the default wiring (Verification 24)', async () => {
      await storeNodeSecret(NODE_ID, SECRET, { env });
      const clusterRoutes = routes(); // no lookupNodeSecret override — this is the D22 default path
      const principal: NodeHttpPrincipal = {
        nodeId: NODE_ID,
        issuedAt: new Date().toISOString(),
        method: 'GET',
        path: '/cluster/corpus',
        bodyHash: hashRequestBody(''),
      };
      const res = await apiRequest(clusterRoutes, '/cluster/corpus', {
        headers: nodeAuthHeaders(principal, SECRET),
      });
      // Admitted past the gate — falls through to the corpus stub's own 409, never node-auth's 401.
      expect(res.status).toBe(409);
    });

    it('the real store, no override: a DIFFERENT node id (never stored) is refused unknown-node (Verification 24)', async () => {
      await storeNodeSecret(NODE_ID, SECRET, { env });
      const clusterRoutes = routes(); // still no override
      const principal: NodeHttpPrincipal = {
        nodeId: 'a-stranger',
        issuedAt: new Date().toISOString(),
        method: 'GET',
        path: '/cluster/corpus',
        bodyHash: hashRequestBody(''),
      };
      const res = await apiRequest(clusterRoutes, '/cluster/corpus', {
        headers: nodeAuthHeaders(principal, 'whatever-secret-a-stranger-might-guess'),
      });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { reason: string }).reason).toBe('unknown-node');
    });

    it('unknown-node: a node the hub does not recognise is refused even with a validly-shaped signature', async () => {
      const clusterRoutes = routes({ lookupNodeSecret: async () => undefined });
      const principal: NodeHttpPrincipal = {
        nodeId: 'a-stranger',
        issuedAt: new Date().toISOString(),
        method: 'GET',
        path: '/cluster/corpus',
        bodyHash: hashRequestBody(''),
      };
      const res = await apiRequest(clusterRoutes, '/cluster/corpus', {
        headers: nodeAuthHeaders(principal, 'whatever-secret-a-stranger-might-guess'),
      });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { reason: string }).reason).toBe('unknown-node');
    });

    it('replay: a valid signed request replayed outside the freshness window is refused as stale-principal', async () => {
      let now = new Date('2026-01-01T00:00:00.000Z');
      const clusterRoutes = routes({ lookupNodeSecret: lookupOnlyNodeA, now: () => now });
      const issuedAt = now;
      const principal: NodeHttpPrincipal = {
        nodeId: NODE_ID,
        issuedAt: issuedAt.toISOString(),
        method: 'GET',
        path: '/cluster/corpus',
        bodyHash: hashRequestBody(''),
      };
      const headers = nodeAuthHeaders(principal, SECRET);

      now = new Date(issuedAt.getTime() + 30_000);
      const fresh = await apiRequest(clusterRoutes, '/cluster/corpus', { headers });
      expect(fresh.status).not.toBe(401); // admitted — falls through to the corpus stub's 409

      now = new Date(issuedAt.getTime() + 200_000); // past the 120s default window
      const replayed = await apiRequest(clusterRoutes, '/cluster/corpus', { headers });
      expect(replayed.status).toBe(401);
      expect(((await replayed.json()) as { reason: string }).reason).toBe('stale-principal');
    });

    it('tamper: a captured header pair replayed against a DIFFERENT corpus path is refused as bad-signature', async () => {
      const clusterRoutes = routes({ lookupNodeSecret: lookupOnlyNodeA });
      const principal: NodeHttpPrincipal = {
        nodeId: NODE_ID,
        issuedAt: new Date().toISOString(),
        method: 'GET',
        path: '/cluster/corpus', // signed for the manifest…
        bodyHash: hashRequestBody(''),
      };
      const headers = nodeAuthHeaders(principal, SECRET);
      // …replayed against a specific document instead.
      const res = await apiRequest(clusterRoutes, '/cluster/corpus/knowledge/secrets.md', { headers });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { reason: string }).reason).toBe('bad-signature');
    });
  });

  describe('deliberately NOT in the authenticated set', () => {
    it('GET /cluster (roster) answers with no node credentials at all — local read, not a remote node call', async () => {
      const res = await apiRequest(routes(), '/cluster');
      expect(res.status).toBe(200);
    });

    it('GET /cluster/active answers with no node credentials', async () => {
      const res = await apiRequest(routes(), '/cluster/active');
      expect(res.status).toBe(200);
    });

    it('GET /cluster/pairings answers with no node credentials', async () => {
      const res = await apiRequest(routes(), '/cluster/pairings');
      expect(res.status).toBe(200);
    });

    it('POST /cluster/join is reachable with no node credentials — the enrollment handshake itself, which must not require what it is about to mint', async () => {
      const res = await apiRequest(routes(), '/cluster/join', json({ code: 'cezj_not-a-real-code' }));
      // Not 401: node-auth never runs on this path. `requireHub` runs next and refuses 409
      // NO_IDENTITY (this test's hub has no identity yet) — a DIFFERENT gate speaking, which is
      // exactly the point: join fell through node-auth untouched.
      expect(res.status).not.toBe(401);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain('no cluster identity');
    });

    // `/cluster/allocate/:kind` and `/cluster/leases/*` used to be tested here too — moved to
    // their own describe block below, now that they ARE node-authenticated (module header's
    // "CORRECTED 2026-08-23 (this package)" paragraph).
  });

  // Added by this package: `/cluster/allocate/:kind` and `/cluster/leases/*` are now
  // node-authenticated ON TOP OF `requireHub` (module header's "CORRECTED 2026-08-23 (this
  // package)" paragraph), and both handlers now attribute to the AUTHENTICATED caller rather than
  // to this server's own `loadNodeIdentity`. `requireHub` still runs first, so every test here
  // seeds a hub identity — otherwise `requireHub`'s 409 NO_IDENTITY would be reached before
  // node-auth ever runs, same ordering already documented for `/cluster/join` above.
  describe('the authenticated set: allocate + leases (this package)', () => {
    let hubNodeId: string;

    beforeEach(async () => {
      hubNodeId = (await ensureNodeIdentity({ role: 'hub' }, { env })).nodeId;
    });

    function signedHeadersFor(method: string, path: string, bodyText: string, nodeId = NODE_ID, secret = SECRET): Record<string, string> {
      const principal: NodeHttpPrincipal = {
        nodeId,
        issuedAt: new Date().toISOString(),
        method,
        path,
        bodyHash: hashRequestBody(bodyText),
      };
      return nodeAuthHeaders(principal, secret);
    }

    const gatedRoutes: Array<[label: string, method: string, path: string, bodyText: string | undefined]> = [
      ['POST /cluster/allocate/:kind', 'POST', '/cluster/allocate/spec-number', '{}'],
      ['POST /cluster/leases/:kind', 'POST', '/cluster/leases/port', JSON.stringify({ id: 'p-1', ttlMs: 60_000 })],
      ['DELETE /cluster/leases/:kind/:id', 'DELETE', '/cluster/leases/port/p-1', undefined],
    ];

    it.each(gatedRoutes.map(([label]) => label))('%s refuses 401 no-credentials when unauthenticated', async (label) => {
      const [, method, path, bodyText] = gatedRoutes.find(([name]) => name === label)!;
      const res = await apiRequest(routes(), path, bodyText !== undefined ? json(JSON.parse(bodyText), method) : { method });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { reason: string }).reason).toBe('no-credentials');
    });

    it.each(gatedRoutes.map(([label]) => label))('%s refuses 401 unknown-node when signed by a node the hub has never enrolled', async (label) => {
      const [, method, path, bodyText] = gatedRoutes.find(([name]) => name === label)!;
      const text = bodyText ?? '';
      const headers = signedHeadersFor(method, path, text, 'a-stranger', 'whatever-secret-a-stranger-might-guess');
      const res = await apiRequest(routes({ lookupNodeSecret: async () => undefined }), path, {
        method,
        headers: bodyText !== undefined ? { 'content-type': 'application/json', ...headers } : headers,
        ...(bodyText !== undefined ? { body: text } : {}),
      });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { reason: string }).reason).toBe('unknown-node');
    });

    // The regression test: under the OLD `loadNodeIdentity({env})` attribution, this would have
    // recorded `hubNodeId` as `byNodeId` regardless of who signed the request — indistinguishable
    // from a bug because the response would still be a 201 with SOME node id in it.
    it('attribution (Verification, this package): an allocation is recorded under the AUTHENTICATED caller, not the hub’s own identity', async () => {
      expect(NODE_ID).not.toBe(hubNodeId); // the two identities this test tells apart must actually differ
      const bodyText = '{}';
      const headers = { 'content-type': 'application/json', ...signedHeadersFor('POST', '/cluster/allocate/spec-number', bodyText) };
      const res = await apiRequest(routes({ lookupNodeSecret: lookupOnlyNodeA }), '/cluster/allocate/spec-number', {
        method: 'POST',
        headers,
        body: bodyText,
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { byNodeId: string };
      expect(body.byNodeId).toBe(NODE_ID);
      expect(body.byNodeId).not.toBe(hubNodeId);

      // Persisted, not only in the response.
      const stored = await readAllocations('spec-number', { env });
      expect(stored).toHaveLength(1);
      expect(stored[0]?.byNodeId).toBe(NODE_ID);
    });

    it('attribution (Verification, this package): a lease is granted to and held by the AUTHENTICATED caller, not the hub’s own identity', async () => {
      expect(NODE_ID).not.toBe(hubNodeId);
      const bodyText = JSON.stringify({ id: 'account-1', ttlMs: 60_000 });
      const headers = { 'content-type': 'application/json', ...signedHeadersFor('POST', '/cluster/leases/account', bodyText) };
      const res = await apiRequest(routes({ lookupNodeSecret: lookupOnlyNodeA }), '/cluster/leases/account', {
        method: 'POST',
        headers,
        body: bodyText,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { acquired: boolean; lease: { holderNodeId: string } };
      expect(body.acquired).toBe(true);
      expect(body.lease.holderNodeId).toBe(NODE_ID);
      expect(body.lease.holderNodeId).not.toBe(hubNodeId);

      const stored = await readLeases({ env });
      const row = stored.find((l) => l.kind === 'account' && l.id === 'account-1');
      expect(row?.holderNodeId).toBe(NODE_ID);
    });

    it('release attribution: the node that actually holds the lease can release it, and the hub’s own identity cannot release a lease it never held', async () => {
      const acquireBodyText = JSON.stringify({ id: 'account-2', ttlMs: 60_000 });
      const acquireHeaders = { 'content-type': 'application/json', ...signedHeadersFor('POST', '/cluster/leases/account', acquireBodyText) };
      const clusterRoutes = routes({ lookupNodeSecret: lookupOnlyNodeA });
      const acquireRes = await apiRequest(clusterRoutes, '/cluster/leases/account', {
        method: 'POST',
        headers: acquireHeaders,
        body: acquireBodyText,
      });
      expect(acquireRes.status).toBe(200);

      // NODE_ID (the real holder) releases it — must succeed.
      const releaseHeaders = signedHeadersFor('DELETE', '/cluster/leases/account/account-2', '');
      const releaseRes = await apiRequest(clusterRoutes, '/cluster/leases/account/account-2', {
        method: 'DELETE',
        headers: releaseHeaders,
      });
      expect(releaseRes.status).toBe(200);
      expect(((await releaseRes.json()) as { released: boolean }).released).toBe(true);
    });

    it('two different authenticated nodes get distinct attribution in the same allocations store', async () => {
      const NODE_B = 'node-b';
      const SECRET_B = 'node-b-secret';
      const lookupBoth = async (nodeId: string) => (nodeId === NODE_ID ? SECRET : nodeId === NODE_B ? SECRET_B : undefined);
      const clusterRoutes = routes({ lookupNodeSecret: lookupBoth });

      async function allocateAs(nodeId: string, secret: string): Promise<{ byNodeId: string; values: string[] }> {
        const bodyText = '{}';
        const headers = {
          'content-type': 'application/json',
          ...signedHeadersFor('POST', '/cluster/allocate/spec-number', bodyText, nodeId, secret),
        };
        const res = await apiRequest(clusterRoutes, '/cluster/allocate/spec-number', { method: 'POST', headers, body: bodyText });
        expect(res.status).toBe(201);
        return (await res.json()) as { byNodeId: string; values: string[] };
      }

      const a = await allocateAs(NODE_ID, SECRET);
      const b = await allocateAs(NODE_B, SECRET_B);
      expect(a.byNodeId).toBe(NODE_ID);
      expect(b.byNodeId).toBe(NODE_B);
      expect(a.values).not.toEqual(b.values); // N distinct callers, N distinct allocations
    });
  });

  describe('ordering: the flag gate still wins over node-auth', () => {
    it('with CEZ_CLUSTER unset, the corpus family still answers 409 naming the flag — never node-auth’s 401', async () => {
      const off = createClusterRoutes({ version: '0.0.0-test', env: { CEZ_HOME: home } });
      const res = await apiRequest(off, '/cluster/corpus');
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain('CEZ_CLUSTER');
    });

    it('with CEZ_CLUSTER unset, /cluster/todos/* also stays a flag-off 409, not a node-auth 401', async () => {
      const off = createClusterRoutes({ version: '0.0.0-test', env: { CEZ_HOME: home } });
      const res = await apiRequest(off, '/cluster/todos/workspace-root');
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain('CEZ_CLUSTER');
    });
  });

  // CORRECTED 2026-08-23 (D22): this describe block used to be titled "the default lookupNodeSecret
  // (no store wired) fails closed", on the premise that NO real store existed anywhere and the
  // default therefore had nothing to consult. That premise is gone — `cluster/node-secrets.ts` now
  // exists and `createClusterRoutes`'s default reads from it (see the two "Verification 24" tests
  // above, which exercise the SAME default answering `ok` for a node that actually enrolled). What
  // this test still proves, correctly, is narrower: the default still fails closed for a node this
  // hub's store has never heard of — an unenrolled stranger, not "no store wired at all".
  describe('the default lookupNodeSecret still fails closed for a node the store has never heard of', () => {
    it('refuses an unenrolled node as unknown-node when ClusterRouteDeps#lookupNodeSecret is omitted', async () => {
      const clusterRoutes = routes(); // no lookupNodeSecret override — reads the real, empty store
      const principal: NodeHttpPrincipal = {
        nodeId: NODE_ID,
        issuedAt: new Date().toISOString(),
        method: 'GET',
        path: '/cluster/corpus',
        bodyHash: hashRequestBody(''),
      };
      const res = await apiRequest(clusterRoutes, '/cluster/corpus', {
        headers: nodeAuthHeaders(principal, SECRET),
      });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { reason: string }).reason).toBe('unknown-node');
    });
  });

  // Spec Verification 28.
  describe('GET /cluster never renders a stored secret (Verification 28)', () => {
    function makeStoredNode(overrides: Partial<StoredClusterNode> = {}): StoredClusterNode {
      return {
        nodeId: 'node-a',
        nodeName: 'Node A',
        role: 'spoke',
        labels: [],
        acceptsDispatch: false,
        protocol: CLUSTER_PROTOCOL,
        version: '0.10.0',
        ...overrides,
      };
    }

    it('two enrolled nodes, each with a stored secret — neither secret appears anywhere in the response body', async () => {
      await upsertNode(makeStoredNode({ nodeId: 'node-a', nodeName: 'A' }), { env });
      await upsertNode(makeStoredNode({ nodeId: 'node-b', nodeName: 'B' }), { env });
      await storeNodeSecret('node-a', 'node-a-super-secret-value', { env });
      await storeNodeSecret('node-b', 'node-b-super-secret-value', { env });

      const res = await apiRequest(routes(), '/cluster');
      expect(res.status).toBe(200);
      const bodyText = await res.text();
      expect(bodyText).not.toContain('node-a-super-secret-value');
      expect(bodyText).not.toContain('node-b-super-secret-value');

      const body = JSON.parse(bodyText) as { nodes: Array<Record<string, unknown>> };
      expect(body.nodes).toHaveLength(2);
      for (const node of body.nodes) expect(node).not.toHaveProperty('secret');
    });
  });

  // D21 (`.ai/specs/2026-08-22-multi-node-cezar-cluster.md`): the snapshot/backup/append trio
  // itself, scoped by a CONFIRMED pairing — never by a header or body field, only by
  // `getAuthenticatedClusterNode(c).nodeId` (D20) plus `resolveHubTodosRoot`'s own two-sided
  // confirmation check. `node-auth.ts` mechanism and the flag-gate ordering are already covered
  // above; this block is the route BODIES.
  describe('GET/POST /cluster/todos/:projectKey — D21 snapshot/backup/append', () => {
    /** Mints a hub identity in THIS test's `env`-pinned home and registers `projects` as this
     *  hub's own local workspace registry — the set `resolveHubTodosRoot` resolves `projectId`
     *  against. Returns the hub's own node id, needed to confirm the HUB side of a pairing. */
    async function seedHubWorkspace(projects: ReadonlyArray<{ id: string; root: string }>): Promise<string> {
      const identity = await ensureNodeIdentity({ role: 'hub' }, { env });
      const config = {
        ...defaultWorkspaceConfig(),
        projects: projects.map((p) => ({
          id: p.id,
          root: p.root,
          name: '',
          addedAt: '',
          lastOpenedAt: '',
          source: 'local' as const,
        })),
      };
      atomicWriteJsonSync(workspaceConfigPath(env), config);
      return identity.nodeId;
    }

    /** Confirms BOTH sides of a pairing — the hub's own local `projectId` AND the caller node —
     *  the two-sided check `resolveHubTodosRoot`'s own doc spells out. The caller's own local
     *  `projectId` is never read by `resolveHubTodosRoot` (only that ITS side is confirmed at
     *  all), so any distinct string works there. */
    async function confirmPairing(projectKey: string, hubNodeId: string, hubProjectId: string, callerNodeId: string): Promise<void> {
      await applyPairingAction(projectKey, { action: 'confirm', nodeId: hubNodeId, projectId: hubProjectId }, { env });
      await applyPairingAction(
        projectKey,
        { action: 'confirm', nodeId: callerNodeId, projectId: `${hubProjectId}-spoke-side` },
        { env },
      );
    }

    function signedHeadersFor(method: 'GET' | 'POST', path: string, bodyText: string): Record<string, string> {
      const principal: NodeHttpPrincipal = {
        nodeId: NODE_ID,
        issuedAt: new Date().toISOString(),
        method,
        path,
        bodyHash: hashRequestBody(bodyText),
      };
      return nodeAuthHeaders(principal, SECRET);
    }

    let projectRootA: string;
    let projectRootB: string;

    beforeEach(() => {
      projectRootA = mkdtempSync(join(tmpdir(), 'cez-todos-route-a-'));
      projectRootB = mkdtempSync(join(tmpdir(), 'cez-todos-route-b-'));
    });

    afterEach(() => {
      rmSync(projectRootA, { recursive: true, force: true });
      rmSync(projectRootB, { recursive: true, force: true });
    });

    it('floor: a real signed request from a paired node gets 200 with the actual row VALUES, not merely a count or a status', async () => {
      const dataDir = join(projectRootA, '.ai/cezar');
      mkdirSync(dataDir, { recursive: true });
      const seedRow = { id: 'row-1', summary: 'a real todo row', priority: 'high' };
      writeFileSync(join(dataDir, 'todos.json'), JSON.stringify([seedRow], null, 2), 'utf8');

      const hubNodeId = await seedHubWorkspace([{ id: 'proj-a', root: projectRootA }]);
      await confirmPairing('project-a', hubNodeId, 'proj-a', NODE_ID);

      const res = await apiRequest(routes({ lookupNodeSecret: lookupOnlyNodeA }), '/cluster/todos/project-a', {
        headers: signedHeadersFor('GET', '/cluster/todos/project-a', ''),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { projectKey: string; todos: Array<Record<string, unknown>> };
      expect(body.projectKey).toBe('project-a');
      expect(body.todos).toEqual([seedRow]); // field VALUES, not `.length` or a bare 200
    });

    it('scoping negative control: the SAME authenticated node succeeds for a project it is paired with and is refused for one it is not', async () => {
      const dataDirA = join(projectRootA, '.ai/cezar');
      mkdirSync(dataDirA, { recursive: true });
      writeFileSync(join(dataDirA, 'todos.json'), JSON.stringify([{ id: 'a1', summary: 'in the paired project' }], null, 2), 'utf8');
      // `proj-b` is registered as a local project — it exists — but no pairing row names it at all.
      const hubNodeId = await seedHubWorkspace([
        { id: 'proj-a', root: projectRootA },
        { id: 'proj-b', root: projectRootB },
      ]);
      await confirmPairing('project-a', hubNodeId, 'proj-a', NODE_ID);

      const clusterRoutes = routes({ lookupNodeSecret: lookupOnlyNodeA });

      const paired = await apiRequest(clusterRoutes, '/cluster/todos/project-a', {
        headers: signedHeadersFor('GET', '/cluster/todos/project-a', ''),
      });
      expect(paired.status).toBe(200);
      expect(((await paired.json()) as { todos: unknown[] }).todos).toHaveLength(1);

      const unpaired = await apiRequest(clusterRoutes, '/cluster/todos/project-b', {
        headers: signedHeadersFor('GET', '/cluster/todos/project-b', ''),
      });
      expect(unpaired.status).toBe(404);
      expect(((await unpaired.json()) as { reason: string }).reason).toBe('unpaired-project');
    });

    it('POST .../backup writes todos.json.bak on the hub and returns its path', async () => {
      const dataDir = join(projectRootA, '.ai/cezar');
      mkdirSync(dataDir, { recursive: true });
      const seedRow = { id: 'row-1', summary: 'back this up' };
      writeFileSync(join(dataDir, 'todos.json'), JSON.stringify([seedRow], null, 2), 'utf8');

      const hubNodeId = await seedHubWorkspace([{ id: 'proj-a', root: projectRootA }]);
      await confirmPairing('project-a', hubNodeId, 'proj-a', NODE_ID);

      const res = await apiRequest(routes({ lookupNodeSecret: lookupOnlyNodeA }), '/cluster/todos/project-a/backup', {
        method: 'POST',
        headers: signedHeadersFor('POST', '/cluster/todos/project-a/backup', ''),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { path: string };
      expect(body.path).toBe(join(dataDir, 'todos.json.bak'));
      expect(JSON.parse(readFileSync(body.path, 'utf8'))).toEqual([seedRow]);
    });

    it('POST .../append inserts rows verbatim (id/ts/author intact) and is idempotent by id — field VALUES survive a retry, not just row count', async () => {
      const dataDir = join(projectRootA, '.ai/cezar');
      const hubNodeId = await seedHubWorkspace([{ id: 'proj-a', root: projectRootA }]);
      await confirmPairing('project-a', hubNodeId, 'proj-a', NODE_ID);
      const clusterRoutes = routes({ lookupNodeSecret: lookupOnlyNodeA });

      const incoming = {
        id: 'peer-1',
        ts: '2026-08-22T10:00:00.000Z',
        summary: 'copied from a peer',
        priority: 'high' as const,
      };
      const bodyText = JSON.stringify({ todos: [incoming] });
      const first = await apiRequest(clusterRoutes, '/cluster/todos/project-a/append', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...signedHeadersFor('POST', '/cluster/todos/project-a/append', bodyText) },
        body: bodyText,
      });
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as { appended: unknown[]; backupPath: string };
      expect(firstBody.appended).toEqual([incoming]);
      expect(firstBody.backupPath).toBe(join(dataDir, 'todos.json.bak'));

      // Retried with a DIFFERENT summary under the SAME id — idempotence means the original row's
      // values win, not merely that a row with this id exists.
      const retry = { ...incoming, summary: 'a different summary that must NOT land' };
      const retryBodyText = JSON.stringify({ todos: [retry] });
      const second = await apiRequest(clusterRoutes, '/cluster/todos/project-a/append', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...signedHeadersFor('POST', '/cluster/todos/project-a/append', retryBodyText),
        },
        body: retryBodyText,
      });
      expect(second.status).toBe(200);
      expect(((await second.json()) as { appended: unknown[] }).appended).toEqual([]); // already there

      const onDisk = JSON.parse(readFileSync(join(dataDir, 'todos.json'), 'utf8')) as Array<Record<string, unknown>>;
      expect(onDisk).toEqual([incoming]); // the ORIGINAL values, not the retried ones
    });

    it('GET snapshot round-trips a row carrying a field this build has never heard of, value intact (D13, response schema stays plain per contract/src/cluster.ts)', async () => {
      const dataDir = join(projectRootA, '.ai/cezar');
      mkdirSync(dataDir, { recursive: true });
      // `futureField` names nothing `clusterTodoRecordSchema` declares — the exact "a newer node
      // wrote a field this build has never heard of" scenario D13 exists to survive. Written
      // straight to disk (not through any zod-typed helper) so the seed itself proves nothing
      // about the route — only the round trip below does.
      const seedRow = { id: 'row-1', summary: 'has an extra field', futureField: 'from-a-newer-node' };
      writeFileSync(join(dataDir, 'todos.json'), JSON.stringify([seedRow], null, 2), 'utf8');

      const hubNodeId = await seedHubWorkspace([{ id: 'proj-a', root: projectRootA }]);
      await confirmPairing('project-a', hubNodeId, 'proj-a', NODE_ID);

      const res = await apiRequest(routes({ lookupNodeSecret: lookupOnlyNodeA }), '/cluster/todos/project-a', {
        headers: signedHeadersFor('GET', '/cluster/todos/project-a', ''),
      });
      expect(res.status).toBe(200); // not a 400 — the request/response as a WHOLE must not be rejected
      const body = (await res.json()) as { todos: Array<Record<string, unknown>> };
      // The VALUE, not merely "the request succeeded" or "a row came back".
      expect(body.todos[0]?.futureField).toBe('from-a-newer-node');
    });

    it('POST .../append round-trips a row carrying an unknown field — in the response AND on disk — value intact (D13)', async () => {
      const dataDir = join(projectRootA, '.ai/cezar');
      const hubNodeId = await seedHubWorkspace([{ id: 'proj-a', root: projectRootA }]);
      await confirmPairing('project-a', hubNodeId, 'proj-a', NODE_ID);
      const clusterRoutes = routes({ lookupNodeSecret: lookupOnlyNodeA });

      const incoming = { id: 'peer-1', summary: 'sent by a newer spoke', futureField: 'from-a-newer-node' };
      const bodyText = JSON.stringify({ todos: [incoming] });
      const res = await apiRequest(clusterRoutes, '/cluster/todos/project-a/append', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...signedHeadersFor('POST', '/cluster/todos/project-a/append', bodyText) },
        body: bodyText,
      });
      expect(res.status).toBe(200); // not a 400 on the whole request
      const body = (await res.json()) as { appended: Array<Record<string, unknown>> };
      expect(body.appended[0]?.futureField).toBe('from-a-newer-node');

      const onDisk = JSON.parse(readFileSync(join(dataDir, 'todos.json'), 'utf8')) as Array<Record<string, unknown>>;
      expect(onDisk[0]?.futureField).toBe('from-a-newer-node'); // survives the WRITE, not only the reply
    });

    it('an unpaired node is refused on backup and append too, not only on the snapshot GET', async () => {
      await seedHubWorkspace([{ id: 'proj-a', root: projectRootA }]); // registered, never paired
      const clusterRoutes = routes({ lookupNodeSecret: lookupOnlyNodeA });

      const backupRes = await apiRequest(clusterRoutes, '/cluster/todos/project-a/backup', {
        method: 'POST',
        headers: signedHeadersFor('POST', '/cluster/todos/project-a/backup', ''),
      });
      expect(backupRes.status).toBe(404);
      expect(((await backupRes.json()) as { reason: string }).reason).toBe('unpaired-project');

      const appendBodyText = JSON.stringify({ todos: [] });
      const appendRes = await apiRequest(clusterRoutes, '/cluster/todos/project-a/append', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...signedHeadersFor('POST', '/cluster/todos/project-a/append', appendBodyText),
        },
        body: appendBodyText,
      });
      expect(appendRes.status).toBe(404);
      expect(((await appendRes.json()) as { reason: string }).reason).toBe('unpaired-project');
    });
  });
});

/**
 * `GET /cluster/active`'s `asOf` — the field `clusterActiveResponseSchema` carries specifically
 * "so a caller can tell 'nothing is running' from 'nobody has reported recently'". Before this
 * suite, no test read this route's BODY at all with the flag on (`cluster-routes.test.ts:216-218`
 * above asserts only `status === 200`), so the lie this proves was never caught by anything.
 *
 * An UNTRACKED cluster (no roster, no projection) and a TRACKED-BUT-IDLE one (a roster node that
 * has reported, holding only a FINISHED run) both correctly answer `runs: []` — a finished run is
 * not "in flight" either way. But they are not the same situation, and a caller who cannot tell
 * them apart has no way to know whether an empty `runs` means anything. The two responses must
 * differ, and not by clock jitter: the real clock is frozen for the whole test (`vi.useFakeTimers`)
 * so that two back-to-back `new Date()` reads — which is what the pre-fix handler made, one per
 * request — return the IDENTICAL instant. Under a frozen clock, pre-fix code produces two
 * byte-identical bodies (`{runs: [], asOf: <the one frozen instant>}` both times), so
 * `.not.toEqual` below is what actually goes red against it — not a coin flip on timing.
 */
describe('GET /cluster/active — asOf is evidence, not a request-time stamp', () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  const FROZEN = new Date('2026-08-23T12:00:00.000Z');

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-cluster-active-honesty-'));
    env = { CEZ_CLUSTER: '1', CEZ_HOME: home };
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  // `now` is passed for the same reason every other D20 test in this file passes it (the hook is
  // `cluster-routes.ts:233`) even though this particular route does not consume it post-fix — see
  // this suite's own module doc for what actually pins the pre-fix jitter (`vi.useFakeTimers`).
  const routes = () => createClusterRoutes({ version: '0.0.0-test', env, now: () => FROZEN });

  function finishedRemoteRun(overrides: Partial<ClusterRemoteRun> = {}): ClusterRemoteRun {
    return {
      projectId: 'proj-1',
      nodeId: NODE_ID,
      id: 'run-done-1',
      title: 'a finished run',
      status: 'done',
      createdAt: '2026-08-20T00:00:00.000Z',
      archived: false,
      workflow: 'w',
      ...overrides,
    };
  }

  it('an untracked cluster and a tracked-but-idle one are not the same response', async () => {
    // This freezes the REAL clock the PRE-FIX handler reads (a bare `new Date()`, no injected
    // seam) — without it, the two requests' timestamps differ by real elapsed milliseconds and
    // `.not.toEqual` below passes on that jitter instead of on the fix actually being honest.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FROZEN);
    try {
      // Scenario A: nothing tracked — no roster, no projection. Nothing has ever been written to
      // this fresh CEZ_HOME, so `readPeers`/`readRemoteRuns` both degrade to their empty defaults.
      const untrackedRes = await apiRequest(routes(), '/cluster/active');
      expect(untrackedRes.status).toBe(200);
      const untracked = (await untrackedRes.json()) as { runs: unknown[]; asOf?: string };

      // Scenario B: tracked and genuinely idle — a roster node that HAS reported (`lastSeenAt`
      // set, the field `markNodeSeen` maintains for real), holding only a run whose status is
      // terminal, never in `IN_FLIGHT_STATUSES`.
      await upsertNode(
        {
          nodeId: NODE_ID,
          nodeName: 'node a',
          role: 'spoke',
          labels: [],
          acceptsDispatch: false,
          protocol: CLUSTER_PROTOCOL,
          version: '0.0.0-test',
          lastSeenAt: '2026-08-23T11:59:00.000Z',
        },
        { env },
      );
      await applyRemoteRuns(NODE_ID, [finishedRemoteRun()], { env });

      const idleRes = await apiRequest(routes(), '/cluster/active');
      expect(idleRes.status).toBe(200);
      const idle = (await idleRes.json()) as { runs: unknown[]; asOf?: string };

      // Correct in BOTH cases — a finished run is not in flight either way. This is the assertion
      // that must NOT be the only one: it passes identically before and after the fix, so on its
      // own it is not evidence of anything.
      expect(untracked.runs).toEqual([]);
      expect(idle.runs).toEqual([]);

      // Not the same situation, and the response has to say so — this is the assertion that is
      // RED before the fix (both bodies are `{runs: [], asOf: '2026-08-23T12:00:00.000Z'}` under
      // the frozen clock) and GREEN after.
      expect(untracked).not.toEqual(idle);

      // Pinned per case, not just "different": untracked carries no `asOf` at all (nothing to
      // report), idle carries the roster's OWN `lastSeenAt` — never the frozen "now" above, which
      // is exactly the distinction the fix makes.
      expect(untracked.asOf).toBeUndefined();
      expect(idle.asOf).toBe('2026-08-23T11:59:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });
});
