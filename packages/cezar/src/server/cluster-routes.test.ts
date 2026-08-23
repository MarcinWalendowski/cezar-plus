import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLUSTER_NODE_ID_HEADER,
  CLUSTER_NODE_PRINCIPAL_HEADER,
  CLUSTER_NODE_SIGNATURE_HEADER,
  hashRequestBody,
  signNodeHttpPrincipal,
  type NodeHttpPrincipal,
} from '../cluster/node-auth.ts';
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

  describe('the authenticated set: corpus family + the pre-wired /cluster/todos/*', () => {
    const gatedGets: Array<[label: string, path: string]> = [
      ['GET /cluster/corpus', '/cluster/corpus'],
      ['GET /cluster/corpus/*', '/cluster/corpus/knowledge/decisions.md'],
      ['GET /cluster/todos/:projectKey (pre-wired, D21 not yet landed)', '/cluster/todos/workspace-root'],
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

    it('POST /cluster/allocate/:kind answers with no node credentials (left out — see the module header)', async () => {
      const res = await apiRequest(routes(), '/cluster/allocate/spec-number', json({}));
      expect(res.status).not.toBe(401);
    });

    it('POST /cluster/leases/:kind answers with no node credentials (left out — see the module header)', async () => {
      const res = await apiRequest(routes(), '/cluster/leases/port', json({ id: 'p-1' }));
      expect(res.status).not.toBe(401);
    });
  });

  describe('ordering: the flag gate still wins over node-auth', () => {
    it('with CEZ_CLUSTER unset, the corpus family still answers 409 naming the flag — never node-auth’s 401', async () => {
      const off = createClusterRoutes({ version: '0.0.0-test', env: { CEZ_HOME: home } });
      const res = await apiRequest(off, '/cluster/corpus');
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain('CEZ_CLUSTER');
    });

    it('with CEZ_CLUSTER unset, the pre-wired /cluster/todos/* also stays a flag-off 409, not a node-auth 401', async () => {
      const off = createClusterRoutes({ version: '0.0.0-test', env: { CEZ_HOME: home } });
      const res = await apiRequest(off, '/cluster/todos/workspace-root');
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain('CEZ_CLUSTER');
    });
  });

  describe('the default lookupNodeSecret (no store wired) fails closed', () => {
    it('refuses every node as unknown-node when ClusterRouteDeps#lookupNodeSecret is omitted', async () => {
      const clusterRoutes = routes(); // no lookupNodeSecret override
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
});
