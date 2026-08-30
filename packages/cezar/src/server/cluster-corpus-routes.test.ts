import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLUSTER_PROTOCOL, type StoredClusterNode } from '@loki-labs/cezar-plus-contract';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import {
  CLUSTER_NODE_ID_HEADER,
  CLUSTER_NODE_PRINCIPAL_HEADER,
  CLUSTER_NODE_SIGNATURE_HEADER,
  hashRequestBody,
  signNodeHttpPrincipal,
  type NodeHttpPrincipal,
} from '../cluster/node-auth.ts';
import { storeNodeSecret } from '../cluster/node-secrets.ts';
import { upsertNode } from '../cluster/peers.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

/**
 * The hub-side corpus HTTP routes (D8a, package 3b.2 of `.ai/runs/2026-08-22-multi-node-cezar-
 * cluster/PLAN.md`, handoff item 56 in `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`):
 * `GET /cluster/corpus`, `GET /cluster/corpus/*`, `POST /cluster/corpus/bodies` and
 * `POST /cluster/corpus/submit`.
 *
 * Built through the REAL `createApp` — not `createClusterRoutes` directly — because these routes
 * read the real D22 node-secrets store and the real corpus-store.ts filesystem state, and
 * `server.ts` wires `createClusterRoutes({ version: deps.version })` with no `env`/`lookupNodeSecret`
 * override, so a test that wants that exact wiring path has to go through `createApp` too (matching
 * `cluster-node-auth-wall.test.ts`, this directory). `CEZ_CLUSTER`, `CEZ_HOME` and
 * `CEZ_PROJECTS_DIR` are therefore pinned on the real `process.env`, restored in `afterEach`.
 *
 * `resolveCorpusRoot` (`cluster/corpus-store.ts`) resolves to `<CEZ_PROJECTS_DIR>/notion-export`
 * when that env var is set — `seedCorpus` below creates exactly that directory and populates it.
 */
describe('hub-side corpus HTTP routes', () => {
  const NODE_A = 'node-a-corpus';
  const SECRET_A = 'node-a-corpus-secret';
  const NODE_B = 'node-b-corpus';
  const SECRET_B = 'node-b-corpus-secret';

  let projectsDir: string;
  let home: string;
  let corpusRoot: string;
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;

  const savedCluster = process.env.CEZ_CLUSTER;
  const savedHome = process.env.CEZ_HOME;
  const savedProjectsDir = process.env.CEZ_PROJECTS_DIR;

  function writeFixture(relPath: string, content: string) {
    const abs = join(corpusRoot, relPath);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }

  /** A node with no stored `mirrorScope` — `scopeForNode`'s default, every scope, per the owner's
   *  2026-08-24 correction to D8a. */
  async function enrollDefaultScopeNode(nodeId: string, secret: string): Promise<void> {
    const node: StoredClusterNode = {
      nodeId,
      nodeName: nodeId,
      role: 'spoke',
      labels: [],
      acceptsDispatch: false,
      protocol: CLUSTER_PROTOCOL,
      version: '0.0.0-test',
    };
    await upsertNode(node, { env: process.env });
    await storeNodeSecret(nodeId, secret, { env: process.env });
  }

  /** A node whose roster row carries an explicit, narrower `mirrorScope` — the passthrough field
   *  `corpus-store.ts#scopeForNode` reads (`storedClusterNodeSchema` is `.passthrough()`, so this
   *  survives `upsertNode`'s own `.parse()` intact). */
  async function enrollScopedNode(nodeId: string, secret: string, mirrorScope: readonly string[]): Promise<void> {
    const node = {
      nodeId,
      nodeName: nodeId,
      role: 'spoke',
      labels: [],
      acceptsDispatch: false,
      protocol: CLUSTER_PROTOCOL,
      version: '0.0.0-test',
      mirrorScope,
    } as unknown as StoredClusterNode;
    await upsertNode(node, { env: process.env });
    await storeNodeSecret(nodeId, secret, { env: process.env });
  }

  function signedHeadersFor(nodeId: string, secret: string, method: string, path: string, bodyText: string): Record<string, string> {
    const principal: NodeHttpPrincipal = {
      nodeId,
      issuedAt: new Date().toISOString(),
      method,
      path,
      bodyHash: hashRequestBody(bodyText),
    };
    const signed = signNodeHttpPrincipal(principal, secret);
    return {
      [CLUSTER_NODE_ID_HEADER]: principal.nodeId,
      [CLUSTER_NODE_PRINCIPAL_HEADER]: signed.principal,
      [CLUSTER_NODE_SIGNATURE_HEADER]: signed.signature,
    };
  }

  function makeApp() {
    return createApp({
      repoRoot,
      store,
      manager,
      version: '0.0.0-test',
      providerAuth: connectedProviderAuth(),
    });
  }

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-corpus-routes-repo-'));
    projectsDir = mkdtempSync(join(tmpdir(), 'cez-corpus-routes-projects-'));
    home = mkdtempSync(join(tmpdir(), 'cez-corpus-routes-home-'));
    corpusRoot = join(projectsDir, 'notion-export');
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = {} as unknown as RunManager;

    process.env.CEZ_CLUSTER = '1';
    process.env.CEZ_HOME = home;
    process.env.CEZ_PROJECTS_DIR = projectsDir;
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(projectsDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    if (savedCluster === undefined) delete process.env.CEZ_CLUSTER;
    else process.env.CEZ_CLUSTER = savedCluster;
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
    if (savedProjectsDir === undefined) delete process.env.CEZ_PROJECTS_DIR;
    else process.env.CEZ_PROJECTS_DIR = savedProjectsDir;
  });

  // ---- no corpus configured on this hub: all four routes answer a NAMED 409 -------------------
  describe('no corpus root configured (CEZ_PROJECTS_DIR set, but notion-export never created)', () => {
    it('all four routes answer 409 with a stated reason, never CORPUS_PENDING\'s old text', async () => {
      await enrollDefaultScopeNode(NODE_A, SECRET_A);
      const app = makeApp();

      const manifestRes = await apiRequest(app, '/api/v1/cluster/corpus', {
        headers: signedHeadersFor(NODE_A, SECRET_A, 'GET', '/api/v1/cluster/corpus', ''),
      });
      expect(manifestRes.status).toBe(409);
      const manifestBody = (await manifestRes.json()) as { error: string };
      expect(manifestBody.error).toContain('no corpus root configured');
      expect(manifestBody.error).not.toContain('package 3b.2');

      const docRes = await apiRequest(app, '/api/v1/cluster/corpus/knowledge/x.md', {
        headers: signedHeadersFor(NODE_A, SECRET_A, 'GET', '/api/v1/cluster/corpus/knowledge/x.md', ''),
      });
      expect(docRes.status).toBe(409);

      const bodiesBodyText = JSON.stringify({ paths: ['knowledge/x.md'] });
      const bodiesRes = await apiRequest(app, '/api/v1/cluster/corpus/bodies', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...signedHeadersFor(NODE_A, SECRET_A, 'POST', '/api/v1/cluster/corpus/bodies', bodiesBodyText),
        },
        body: bodiesBodyText,
      });
      expect(bodiesRes.status).toBe(409);

      const submitBodyText = JSON.stringify({ path: 'knowledge/x.md', body: 'hi' });
      const submitRes = await apiRequest(app, '/api/v1/cluster/corpus/submit', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...signedHeadersFor(NODE_A, SECRET_A, 'POST', '/api/v1/cluster/corpus/submit', submitBodyText),
        },
        body: submitBodyText,
      });
      expect(submitRes.status).toBe(409);
    });
  });

  // ---- manifest: docs, tombstones, scope (Verification 16, 18) --------------------------------
  describe('GET /cluster/corpus — manifest', () => {
    beforeEach(() => {
      writeFixture('knowledge/decisions.md', 'a decision');
      writeFixture('domains/alpha.md', 'a domain doc');
      writeFixture('reports/report-1.md', 'a user report');
    });

    it('a default-scope node gets every doc, and `scope` names every default directory', async () => {
      await enrollDefaultScopeNode(NODE_A, SECRET_A);
      const res = await apiRequest(makeApp(), '/api/v1/cluster/corpus', {
        headers: signedHeadersFor(NODE_A, SECRET_A, 'GET', '/api/v1/cluster/corpus', ''),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { docs: Array<{ path: string }>; scope: string[] };
      const paths = body.docs.map((d) => d.path).sort();
      expect(paths).toEqual(['domains/alpha.md', 'knowledge/decisions.md', 'reports/report-1.md']);
      expect(body.scope).toContain('reports');
    });

    it('Verification 18: a node scoped away from reports/ gets no reports/ doc, AND `scope` says so — not-found and not-mirrored stay distinguishable', async () => {
      await enrollScopedNode(NODE_B, SECRET_B, ['knowledge', 'domains']);
      const res = await apiRequest(makeApp(), '/api/v1/cluster/corpus', {
        headers: signedHeadersFor(NODE_B, SECRET_B, 'GET', '/api/v1/cluster/corpus', ''),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { docs: Array<{ path: string }>; scope: string[] };
      const paths = body.docs.map((d) => d.path).sort();
      expect(paths).toEqual(['domains/alpha.md', 'knowledge/decisions.md']);
      // The scope array itself names what this node holds — the second assertion Verification 18
      // requires: without it, "no reports doc" is indistinguishable from "the hub has none".
      expect(body.scope).toEqual(['knowledge', 'domains']);
      expect(body.scope).not.toContain('reports');
    });

    it('the `scope` query parameter is a narrowing HINT only — asking for MORE than the grant is silently capped back to it, never widened', async () => {
      await enrollScopedNode(NODE_B, SECRET_B, ['knowledge']);
      const res = await apiRequest(makeApp(), '/api/v1/cluster/corpus?scope=knowledge,reports', {
        headers: signedHeadersFor(NODE_B, SECRET_B, 'GET', '/api/v1/cluster/corpus', ''),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { docs: Array<{ path: string }>; scope: string[] };
      expect(body.docs.map((d) => d.path)).toEqual(['knowledge/decisions.md']);
      expect(body.scope).toEqual(['knowledge']); // NOT ['knowledge','reports'] — the grant wins
    });

    it('`?since=` returns a changed doc, omits an unchanged one, and reports a deletion as an explicit tombstone (Verification 16)', async () => {
      await enrollDefaultScopeNode(NODE_A, SECRET_A);
      const app = makeApp();
      const headersFor = (path: string) => signedHeadersFor(NODE_A, SECRET_A, 'GET', path, '');

      const first = await apiRequest(app, '/api/v1/cluster/corpus', { headers: headersFor('/api/v1/cluster/corpus') });
      const firstBody = (await first.json()) as { corpusVersion: string };
      const v0 = firstBody.corpusVersion;

      // Change one doc, delete another.
      writeFixture('knowledge/decisions.md', 'a decision, revised');
      rmSync(join(corpusRoot, 'domains/alpha.md'));

      const delta = await apiRequest(app, `/api/v1/cluster/corpus?since=${v0}`, {
        headers: headersFor('/api/v1/cluster/corpus'),
      });
      expect(delta.status).toBe(200);
      const deltaBody = (await delta.json()) as {
        docs: Array<{ path: string; hash: string }>;
        tombstones: Array<{ path: string }>;
        corpusVersion: string;
      };
      // The changed doc is present; the untouched `reports/report-1.md` is NOT — an omission from
      // a delta must not be read as absence-diffing (module header of corpus-store.ts).
      expect(deltaBody.docs.map((d) => d.path)).toEqual(['knowledge/decisions.md']);
      // Deletion is an EXPLICIT tombstone, never inferred from `domains/alpha.md` merely missing
      // from `docs`.
      expect(deltaBody.tombstones.map((t) => t.path)).toEqual(['domains/alpha.md']);
      expect(deltaBody.corpusVersion).not.toBe(v0);

      // Negative control: a THIRD delta against the now-current version, with nothing further
      // changed, must be empty — proving the previous delta was not just "everything since v0"
      // relisted forever.
      const stillCurrent = await apiRequest(app, `/api/v1/cluster/corpus?since=${deltaBody.corpusVersion}`, {
        headers: headersFor('/api/v1/cluster/corpus'),
      });
      const stillCurrentBody = (await stillCurrent.json()) as { docs: unknown[]; tombstones: unknown[] };
      expect(stillCurrentBody.docs).toEqual([]);
      expect(stillCurrentBody.tombstones).toEqual([]);
    });
  });

  // ---- single document + batch: identical scope refusal, identical traversal refusal ----------
  describe('GET /cluster/corpus/* and POST /cluster/corpus/bodies', () => {
    beforeEach(() => {
      writeFixture('knowledge/decisions.md', 'a decision');
      writeFixture('reports/report-1.md', 'a user report');
    });

    it('floor: a real document round-trips with its actual hash and body, not merely a 200', async () => {
      await enrollDefaultScopeNode(NODE_A, SECRET_A);
      const path = '/api/v1/cluster/corpus/knowledge/decisions.md';
      const res = await apiRequest(makeApp(), path, { headers: signedHeadersFor(NODE_A, SECRET_A, 'GET', path, '') });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { path: string; hash: string; body: string };
      expect(body.path).toBe('knowledge/decisions.md');
      expect(body.body).toBe('a decision');
      expect(body.hash).toMatch(/^[0-9a-f]{64}$/); // sha256 hex, corpus-store.ts#hashContent
    });

    it('anti-drift: the SAME out-of-scope path is refused identically by both routes — 404 on the single route, folded into `missing` (not `docs`) on the batch route, on both a node scoped away from it AND identically to a genuinely absent path', async () => {
      await enrollScopedNode(NODE_B, SECRET_B, ['knowledge']);
      const app = makeApp();
      const outOfScope = 'reports/report-1.md';
      const absent = 'knowledge/does-not-exist.md';

      const singleOutOfScope = await apiRequest(app, `/api/v1/cluster/corpus/${outOfScope}`, {
        headers: signedHeadersFor(NODE_B, SECRET_B, 'GET', `/api/v1/cluster/corpus/${outOfScope}`, ''),
      });
      const singleAbsent = await apiRequest(app, `/api/v1/cluster/corpus/${absent}`, {
        headers: signedHeadersFor(NODE_B, SECRET_B, 'GET', `/api/v1/cluster/corpus/${absent}`, ''),
      });
      expect(singleOutOfScope.status).toBe(404);
      expect(singleAbsent.status).toBe(404);
      // Identical body too — an out-of-scope path must be indistinguishable from an absent one.
      expect(await singleOutOfScope.json()).toEqual(await singleAbsent.json());

      const bodiesBodyText = JSON.stringify({ paths: [outOfScope, absent, 'knowledge/decisions.md'] });
      const bodiesRes = await apiRequest(app, '/api/v1/cluster/corpus/bodies', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...signedHeadersFor(NODE_B, SECRET_B, 'POST', '/api/v1/cluster/corpus/bodies', bodiesBodyText),
        },
        body: bodiesBodyText,
      });
      expect(bodiesRes.status).toBe(200);
      const bodiesBody = (await bodiesRes.json()) as { docs: Array<{ path: string }>; missing: string[] };
      expect(bodiesBody.docs.map((d) => d.path)).toEqual(['knowledge/decisions.md']);
      // Both refused paths land in the SAME undistinguished list — neither route discloses which
      // of the two reasons applied, matching the single-document route's identical-body assertion
      // above.
      expect(bodiesBody.missing.sort()).toEqual([absent, outOfScope].sort());
    });

    it('traversal (../, absolute, backslash) is refused on the batch route — JSON body strings, no URL normalization to fight', async () => {
      // `paths` rides in the JSON body, not the URL, so these land in `isPathInScope` byte-for-byte
      // — no risk of `fetch`/`URL`'s own dot-segment normalization silently rewriting the attempt
      // before it ever reaches the route (which a literal `..` in a URL PATH would be subject to).
      await enrollDefaultScopeNode(NODE_A, SECRET_A);
      const app = makeApp();
      const traversalPaths = ['../etc/passwd', '/etc/passwd', 'knowledge\\..\\..\\etc\\passwd', 'C:/windows/win.ini'];

      const bodiesBodyText = JSON.stringify({ paths: traversalPaths });
      const bodiesRes = await apiRequest(app, '/api/v1/cluster/corpus/bodies', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...signedHeadersFor(NODE_A, SECRET_A, 'POST', '/api/v1/cluster/corpus/bodies', bodiesBodyText),
        },
        body: bodiesBodyText,
      });
      expect(bodiesRes.status).toBe(200);
      const bodiesBody = (await bodiesRes.json()) as { docs: unknown[]; missing: string[] };
      expect(bodiesBody.docs).toEqual([]);
      expect(bodiesBody.missing.sort()).toEqual([...traversalPaths].sort());
    });

    it('a "../"-style URL never reaches this route with a literal ".." at all — the fetch/URL layer already collapses it before Hono does, and the result is never a 200', async () => {
      // MEASURED while building this test, not assumed: the WHATWG URL spec's path-normalization
      // treats a LITERAL `..` segment AND its percent-encoded spellings (`%2e%2e`, `.%2e`, `%2e.`,
      // all case-insensitive) as equivalent double-dot segments, and — because http(s) is a
      // "special" scheme — a literal backslash is treated as an equivalent path separator too. So
      // `fetch`'s own `Request`/`URL` construction ALREADY resolves
      // `/api/v1/cluster/corpus/knowledge/../../etc/passwd` (and its percent-encoded or
      // backslash-spelled equivalents) down to `/api/v1/etc/passwd` before Hono's router ever
      // sees it — which matches no registered route and answers Hono's OWN plain-text 404, not
      // this route's JSON one. There is no way to get a literal `..` past that layer through a URL
      // path in this test harness (or any WHATWG-conformant HTTP client), so this route's own
      // `isPathInScope` traversal-refusal branch is not reachable via the URL transport at all —
      // it IS reachable, and IS exercised, via the batch and submit routes above/below, where the
      // path travels in a JSON body instead of a URL. What this test actually proves for the GET
      // route: whatever the URL layer resolves a traversal attempt DOWN TO, the result is never a
      // 200 with corpus content — either Hono's own router 404s on the resolved (unmatched) path,
      // or (if the resolved path happens to still match `/cluster/corpus/*`) this route's own
      // scope check 404s it.
      await enrollDefaultScopeNode(NODE_A, SECRET_A);
      const app = makeApp();
      const res = await apiRequest(app, '/api/v1/cluster/corpus/knowledge/../../etc/passwd', {
        headers: signedHeadersFor(NODE_A, SECRET_A, 'GET', '/api/v1/etc/passwd', ''),
      });
      expect(res.status).not.toBe(200);
      expect(res.status).toBe(404); // Hono's router-level 404 here — the URL never reaches this route at all
    });

    it('`truncated: true` when the batch exceeds the byte cap, and the caller loops to a complete mirror', async () => {
      // Two ~3MB docs: individually under `CLUSTER_CORPUS_BATCH_MAX_BYTES` (4,000,000), together
      // over it — `readDocs` always admits the first doc, then refuses to add a second that would
      // push the response over the cap (`corpus-store.ts#readDocs`'s own `usedBytes > 0` guard).
      const big = 'x'.repeat(3_000_000);
      writeFixture('knowledge/big-a.md', big);
      writeFixture('knowledge/big-b.md', big);
      await enrollDefaultScopeNode(NODE_A, SECRET_A);
      const app = makeApp();

      const firstBodyText = JSON.stringify({ paths: ['knowledge/big-a.md', 'knowledge/big-b.md'] });
      const firstRes = await apiRequest(app, '/api/v1/cluster/corpus/bodies', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...signedHeadersFor(NODE_A, SECRET_A, 'POST', '/api/v1/cluster/corpus/bodies', firstBodyText),
        },
        body: firstBodyText,
      });
      expect(firstRes.status).toBe(200);
      const firstResBody = (await firstRes.json()) as { docs: Array<{ path: string }>; truncated: boolean };
      expect(firstResBody.truncated).toBe(true);
      // Negative control: a test that only asserted `truncated === true` would pass even if the
      // remainder were silently dropped forever — assert the SECOND path is genuinely retrievable.
      expect(firstResBody.docs.map((d) => d.path)).toEqual(['knowledge/big-a.md']);

      const secondBodyText = JSON.stringify({ paths: ['knowledge/big-b.md'] });
      const secondRes = await apiRequest(app, '/api/v1/cluster/corpus/bodies', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...signedHeadersFor(NODE_A, SECRET_A, 'POST', '/api/v1/cluster/corpus/bodies', secondBodyText),
        },
        body: secondBodyText,
      });
      const secondResBody = (await secondRes.json()) as { docs: Array<{ path: string; body: string }>; truncated: boolean };
      expect(secondResBody.truncated).toBe(false);
      expect(secondResBody.docs.map((d) => d.path)).toEqual(['knowledge/big-b.md']);
      expect(secondResBody.docs[0]?.body).toBe(big); // the full 3MB body, not a partial read
    });
  });

  // ---- submit: the one write direction ---------------------------------------------------------
  describe('POST /cluster/corpus/submit', () => {
    beforeEach(() => {
      writeFixture('knowledge/decisions.md', 'the original body');
    });

    it('out-of-scope is refused with 200 {ok:false, reason:"out-of-scope"}, and nothing is written', async () => {
      await enrollScopedNode(NODE_B, SECRET_B, ['knowledge']);
      const bodyText = JSON.stringify({ path: 'reports/new.md', body: 'should not land' });
      const res = await apiRequest(makeApp(), '/api/v1/cluster/corpus/submit', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...signedHeadersFor(NODE_B, SECRET_B, 'POST', '/api/v1/cluster/corpus/submit', bodyText),
        },
        body: bodyText,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: false, reason: 'out-of-scope' });
      expect(existsSyncSafe(join(corpusRoot, 'reports/new.md'))).toBe(false);
    });

    it('traversal (../, absolute, backslash) is refused as out-of-scope on submit too, and nothing escapes the corpus root', async () => {
      // Same reasoning as the batch route's traversal test: `path` rides in the JSON body, not
      // the URL, so there is no `fetch`/`URL` dot-segment normalization to work around here.
      await enrollDefaultScopeNode(NODE_A, SECRET_A);
      const app = makeApp();
      const traversalPaths = ['../outside.md', '/etc/passwd', 'knowledge\\..\\..\\outside.md'];

      for (const path of traversalPaths) {
        const bodyText = JSON.stringify({ path, body: 'escape attempt' });
        const res = await apiRequest(app, '/api/v1/cluster/corpus/submit', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...signedHeadersFor(NODE_A, SECRET_A, 'POST', '/api/v1/cluster/corpus/submit', bodyText),
          },
          body: bodyText,
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: false, reason: 'out-of-scope' });
      }
      expect(existsSyncSafe(join(projectsDir, 'outside.md'))).toBe(false);
    });

    it('a baseVersion naming a document that does not exist yet is refused stale-base, not treated as a fresh create', async () => {
      await enrollDefaultScopeNode(NODE_A, SECRET_A);
      const bodyText = JSON.stringify({ path: 'knowledge/new.md', body: 'hi', baseVersion: 'some-hash-that-cannot-match' });
      const res = await apiRequest(makeApp(), '/api/v1/cluster/corpus/submit', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...signedHeadersFor(NODE_A, SECRET_A, 'POST', '/api/v1/cluster/corpus/submit', bodyText),
        },
        body: bodyText,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: false, reason: 'stale-base' });
    });

    it('a baseVersion that does not match the CURRENT hash is refused stale-base — the blind-overwrite case', async () => {
      await enrollDefaultScopeNode(NODE_A, SECRET_A);
      const bodyText = JSON.stringify({ path: 'knowledge/decisions.md', body: 'a blind overwrite', baseVersion: 'stale-hash' });
      const res = await apiRequest(makeApp(), '/api/v1/cluster/corpus/submit', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...signedHeadersFor(NODE_A, SECRET_A, 'POST', '/api/v1/cluster/corpus/submit', bodyText),
        },
        body: bodyText,
      });
      expect(await res.json()).toEqual({ ok: false, reason: 'stale-base' });
      // The ORIGINAL content survives — a refused submit must not partially land.
      expect(readFileSync(join(corpusRoot, 'knowledge/decisions.md'), 'utf8')).toBe('the original body');
    });

    it('a fresh write with no baseVersion succeeds, lands on disk, and round-trips through GET /cluster/corpus/*', async () => {
      await enrollDefaultScopeNode(NODE_A, SECRET_A);
      const app = makeApp();
      const bodyText = JSON.stringify({ path: 'knowledge/new-doc.md', body: 'brand new content' });
      const res = await apiRequest(app, '/api/v1/cluster/corpus/submit', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...signedHeadersFor(NODE_A, SECRET_A, 'POST', '/api/v1/cluster/corpus/submit', bodyText),
        },
        body: bodyText,
      });
      expect(res.status).toBe(200);
      const resBody = (await res.json()) as { ok: boolean; path: string; corpusVersion: string };
      expect(resBody).toMatchObject({ ok: true, path: 'knowledge/new-doc.md' });
      expect(typeof resBody.corpusVersion).toBe('string');
      expect(readFileSync(join(corpusRoot, 'knowledge/new-doc.md'), 'utf8')).toBe('brand new content');

      const getPath = '/api/v1/cluster/corpus/knowledge/new-doc.md';
      const getRes = await apiRequest(app, getPath, { headers: signedHeadersFor(NODE_A, SECRET_A, 'GET', getPath, '') });
      expect(getRes.status).toBe(200);
      expect(((await getRes.json()) as { body: string }).body).toBe('brand new content');
    });

    it('a correct baseVersion (read from a prior fetch) is accepted and updates the document', async () => {
      await enrollDefaultScopeNode(NODE_A, SECRET_A);
      const app = makeApp();
      const getPath = '/api/v1/cluster/corpus/knowledge/decisions.md';
      const priorRes = await apiRequest(app, getPath, { headers: signedHeadersFor(NODE_A, SECRET_A, 'GET', getPath, '') });
      const prior = (await priorRes.json()) as { hash: string };

      const bodyText = JSON.stringify({ path: 'knowledge/decisions.md', body: 'a legitimate update', baseVersion: prior.hash });
      const res = await apiRequest(app, '/api/v1/cluster/corpus/submit', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...signedHeadersFor(NODE_A, SECRET_A, 'POST', '/api/v1/cluster/corpus/submit', bodyText),
        },
        body: bodyText,
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
      expect(readFileSync(join(corpusRoot, 'knowledge/decisions.md'), 'utf8')).toBe('a legitimate update');
    });
  });
});

function existsSyncSafe(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}
