import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClusterCorpusBody, ClusterCorpusDoc, ClusterCorpusManifestResponse } from '@loki-labs/cezar-plus-contract';
import { CLUSTER_CORPUS_BATCH_MAX_PATHS, CLUSTER_CORPUS_DEFAULT_SCOPE } from '@loki-labs/cezar-plus-contract';
import { afterEach, describe, expect, it } from 'vitest';
import { LINK_PRINCIPAL_MAX_AGE_MS } from '../../cluster/enrollment.ts';
import {
  CLUSTER_NODE_ID_HEADER,
  CLUSTER_NODE_PRINCIPAL_HEADER,
  CLUSTER_NODE_SIGNATURE_HEADER,
  hashRequestBody,
  verifyNodeHttpPrincipal,
} from '../../cluster/node-auth.ts';
import type { SourceChange, SourceDocumentRef } from '../provider-types.ts';
import { FileSourceSink } from '../sink.ts';
import { SourceStore } from '../store.ts';
import { computeDocId, runSourceSync } from '../sync.ts';
import { sourceConnectionSchema, type SourceConnection } from '../types.ts';
import { CEZAR_HUB_SOURCE_KIND, CezarHubSourceProvider, createCezarHubSourceProvider } from './provider.ts';

/**
 * `CezarHubSourceProvider` (F2's `SourceProvider` seam, D8a of
 * `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`; plan package **3b.1**). Every test here is
 * either a direct unit test of the provider (mirroring `notion/provider.test.ts`'s granularity), or
 * drives the REAL sweep (`runSourceSync`, `../sync.ts`, untouched by this package) with a REAL
 * `FileSourceSink` + `SourceStore` against a fake HTTP hub — the sweep-level tests are what prove
 * the seam's own promise: this provider needs nothing sweep-specific of its own to get tombstone,
 * quarantine and scope right. No live network I/O anywhere in this file.
 *
 * Verification 16/17/18 (spec "Verification" → "Automated") map to the three `describe` blocks
 * under "sweep-level (16/17/18)" below, each named with its number.
 */

const dirs: string[] = [];
async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cezar-hub-provider-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

const HUB_URL = 'https://hub.internal';
const AUTH = { hubUrl: HUB_URL, nodeId: 'node-1', secret: 's3cr3t' };

function doc(path: string, hash: string, size = 10): ClusterCorpusDoc {
  return { path, hash, size, mtime: '2026-08-22T00:00:00.000Z' };
}

function manifest(
  docs: ClusterCorpusDoc[],
  tombstones: { path: string; at: string }[] = [],
  overrides: Partial<Pick<ClusterCorpusManifestResponse, 'complete' | 'scope' | 'corpusVersion'>> = {},
): ClusterCorpusManifestResponse {
  return {
    corpusVersion: overrides.corpusVersion ?? 'v1',
    scope: overrides.scope ? [...overrides.scope] : [...CLUSTER_CORPUS_DEFAULT_SCOPE],
    docs,
    tombstones,
    complete: overrides.complete ?? true,
  };
}

interface HubFixture {
  manifest?: ClusterCorpusManifestResponse | ((url: URL) => ClusterCorpusManifestResponse);
  manifestStatus?: number;
  docs?: Record<string, string>;
  /** Per-path hash, keyed the same as `docs`. Defaults to whatever `manifest`'s own `docs[]` says
   *  for that path (when `manifest` is a static object) - the common case, and what keeps every
   *  EXISTING fixture below correct with zero changes: the manifest's `doc(path, hash)` and the
   *  body responses agree on `hash` automatically. Only needed explicitly when `manifest` is a
   *  per-URL function (the `since`-aware fixtures below), or when a test wants a deliberately
   *  MISMATCHED hash (the "stale prefetch is never trusted" negative control). */
  docHashes?: Record<string, string>;
  /** Overrides the synthesized `POST /corpus/bodies` response entirely - used by the `truncated`
   *  loop test, which needs the SAME chunk requested twice to answer differently each time. */
  bodiesResponse?: (paths: string[]) => { docs: ClusterCorpusBody[]; missing: string[]; truncated: boolean };
}

function upsertDocOf(changes: SourceChange[], externalId: string): SourceDocumentRef {
  const match = changes.find((c) => c.type === 'upsert' && c.doc.externalId === externalId);
  if (!match || match.type !== 'upsert') throw new Error(`no upsert change for "${externalId}"`);
  return match.doc;
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/** A fake hub: routes `GET /api/v1/cluster/corpus`, `GET /api/v1/cluster/corpus/*path` and `POST
 *  /api/v1/cluster/corpus/bodies` off the fixture above, and records every request (method + URL,
 *  and for POST the parsed `paths`) so a test can assert what the provider actually asked for
 *  (verification 18's "legible" half, and item 56's batching/diff-before-fetch assertions). */
function makeHubFetch(fixture: HubFixture): {
  fetchImpl: typeof fetch;
  requests: string[];
  batchRequests: Array<{ paths: string[] }>;
} {
  const requests: string[] = [];
  const batchRequests: Array<{ paths: string[] }> = [];
  const staticDocs: ClusterCorpusDoc[] = fixture.manifest && typeof fixture.manifest !== 'function' ? fixture.manifest.docs : [];
  const hashOf = (path: string): string => fixture.docHashes?.[path] ?? staticDocs.find((d) => d.path === path)?.hash ?? '';
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(urlOf(input));
    requests.push(url.toString());
    if (url.pathname === '/api/v1/cluster/corpus') {
      if (!fixture.manifest) return new Response('not configured', { status: 500 });
      const body = typeof fixture.manifest === 'function' ? fixture.manifest(url) : fixture.manifest;
      return new Response(JSON.stringify(body), {
        status: fixture.manifestStatus ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.pathname === '/api/v1/cluster/corpus/bodies') {
      const parsedBody = typeof init?.body === 'string' ? (JSON.parse(init.body) as { paths: string[] }) : { paths: [] };
      batchRequests.push({ paths: parsedBody.paths });
      if (fixture.bodiesResponse) {
        return new Response(JSON.stringify(fixture.bodiesResponse(parsedBody.paths)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      const docs: ClusterCorpusBody[] = [];
      const missing: string[] = [];
      for (const path of parsedBody.paths) {
        const body = fixture.docs?.[path];
        if (body === undefined) {
          missing.push(path);
          continue;
        }
        docs.push({ path, hash: hashOf(path), body });
      }
      return new Response(JSON.stringify({ docs, missing, truncated: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    const prefix = '/api/v1/cluster/corpus/';
    if (url.pathname.startsWith(prefix)) {
      const path = url.pathname
        .slice(prefix.length)
        .split('/')
        .map((segment) => decodeURIComponent(segment))
        .join('/');
      const body = fixture.docs?.[path];
      if (body === undefined) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
      return new Response(JSON.stringify({ path, hash: hashOf(path), body }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, requests, batchRequests };
}

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly bodyText: string;
}

/** A fetch stub that answers a fixed 200 and records every request's method, headers and body
 *  TEXT (not a re-derivation of what `request()` should have sent) - what the "node auth" tests
 *  below verify is the SENT request, using the real `verifyNodeHttpPrincipal`. */
function captureAuthFetch(responseBody: unknown = manifest([])): { fetchImpl: typeof fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    calls.push({
      url: urlOf(input),
      method: init?.method ?? 'GET',
      headers,
      bodyText: typeof init?.body === 'string' ? init.body : '',
    });
    return new Response(JSON.stringify(responseBody), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('capabilities and kind', () => {
  it('declares kind "cezar-hub" and every capability but comments', () => {
    const provider = new CezarHubSourceProvider(connectionFixture(), AUTH);
    expect(provider.kind).toBe(CEZAR_HUB_SOURCE_KIND);
    expect(provider.capabilities).toEqual({ list: true, fetch: true, poll: true, push: true, comments: false });
  });

  it('the registry factory constructs the same class', () => {
    // The registry only ever calls this through `SourceProviderFactory`, whose `deps` parameter is
    // typed `SourceProviderDeps` (`env`/`now` only) - `hubUrl`/`nodeId`/`secret`/`fetchImpl` reach
    // this provider via `deps.env` in that path (module header). Constructed here the same way.
    const provider = new CezarHubSourceProvider(connectionFixture(), {
      env: { CEZ_CLUSTER_HUB: HUB_URL, CEZ_CLUSTER_NODE_ID: 'node-1', CEZ_CLUSTER_SECRET: 's3cr3t' },
    });
    expect(provider.kind).toBe('cezar-hub');
  });
});

describe('detect / detectCached', () => {
  it('unavailable, with a stated reason, when no hub URL is configured', async () => {
    const provider = new CezarHubSourceProvider(connectionFixture(), { env: {} });
    const result = await provider.detect();
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/no cluster hub configured/i);
  });

  it('unavailable, with a stated reason, when a hub URL exists but this node has no credential', async () => {
    const provider = new CezarHubSourceProvider(connectionFixture(), { hubUrl: HUB_URL, env: {} });
    const result = await provider.detect();
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/no cluster credential/i);
  });

  it('available on a healthy manifest fetch', async () => {
    const { fetchImpl } = makeHubFetch({ manifest: manifest([doc('knowledge/a.md', 'h1')]) });
    const provider = new CezarHubSourceProvider(connectionFixture(), { ...AUTH, fetchImpl });
    expect(await provider.detect()).toEqual({ available: true });
  });

  it('unavailable on a non-2xx, never throws', async () => {
    const { fetchImpl } = makeHubFetch({ manifest: manifest([]), manifestStatus: 401 });
    const provider = new CezarHubSourceProvider(connectionFixture(), { ...AUTH, fetchImpl });
    const result = await provider.detect();
    expect(result).toEqual({ available: false, reason: 'the hub responded 401' });
  });

  it('detectCached serves the last probe and refreshes in the background, never blocking', async () => {
    const { fetchImpl } = makeHubFetch({ manifest: manifest([]) });
    const provider = new CezarHubSourceProvider(connectionFixture(), { ...AUTH, fetchImpl });
    expect(provider.detectCached()).toBeNull(); // before the first probe
    await provider.detect();
    expect(provider.detectCached()).toEqual({ available: true });
  });
});

describe('listCollections', () => {
  it('always reports exactly one collection, "corpus" - the manifest is already scoped server-side', async () => {
    const provider = new CezarHubSourceProvider(connectionFixture(), AUTH);
    const collections = await provider.listCollections();
    expect(collections).toEqual([{ externalId: 'corpus', collectionKind: 'database', label: 'cezar-hub corpus' }]);
  });
});

describe('pollChanges', () => {
  it('an unconfigured collectionExternalId is a no-op, reported complete (nothing to enumerate)', async () => {
    const provider = new CezarHubSourceProvider(connectionFixture(), AUTH);
    const page = await provider.pollChanges(null, { collectionExternalId: 'not-corpus' });
    expect(page).toEqual({ changes: [], watermark: null, nextPageCursor: null, complete: true, truncated: false });
  });

  it('a callBudget of 0 makes no request and reports truncated, not complete', async () => {
    const { fetchImpl, requests } = makeHubFetch({ manifest: manifest([doc('knowledge/a.md', 'h1')]) });
    const provider = new CezarHubSourceProvider(connectionFixture(), { ...AUTH, fetchImpl });
    const page = await provider.pollChanges(null, { collectionExternalId: 'corpus', callBudget: 0 });
    expect(page.complete).toBe(false);
    expect(page.truncated).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it('a request failure yields changes: [], complete: false, truncated: false - never an empty-corpus false positive', async () => {
    const provider = new CezarHubSourceProvider(connectionFixture(), {
      ...AUTH,
      fetchImpl: (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch,
    });
    const page = await provider.pollChanges(null, { collectionExternalId: 'corpus' });
    expect(page).toEqual({ changes: [], watermark: null, nextPageCursor: null, complete: false, truncated: false });
  });

  it('emits one upsert per manifest doc: externalId is the path, remoteVersion is the hash, docType "page"', async () => {
    const { fetchImpl } = makeHubFetch({ manifest: manifest([doc('knowledge/a.md', 'hash-a'), doc('domains/b.md', 'hash-b')]) });
    const provider = new CezarHubSourceProvider(connectionFixture(), { ...AUTH, fetchImpl });
    const page = await provider.pollChanges(null, { collectionExternalId: 'corpus' });
    expect(page.complete).toBe(true);
    expect(page.changes).toEqual([
      {
        type: 'upsert',
        doc: {
          externalId: 'knowledge/a.md',
          collectionExternalId: 'corpus',
          title: 'a',
          url: `${HUB_URL}/api/v1/cluster/corpus/knowledge/a.md`,
          remoteVersion: 'hash-a',
          docType: 'page',
          properties: {},
        },
      },
      {
        type: 'upsert',
        doc: {
          externalId: 'domains/b.md',
          collectionExternalId: 'corpus',
          title: 'b',
          url: `${HUB_URL}/api/v1/cluster/corpus/domains/b.md`,
          remoteVersion: 'hash-b',
          docType: 'page',
          properties: {},
        },
      },
    ]);
  });

  it('a manifest tombstone becomes exactly one {type:"tombstone"} change, keyed on its path', async () => {
    const { fetchImpl } = makeHubFetch({
      manifest: manifest([doc('knowledge/a.md', 'hash-a')], [{ path: 'knowledge/deleted.md', at: '2026-08-22T00:00:00.000Z' }]),
    });
    const provider = new CezarHubSourceProvider(connectionFixture(), { ...AUTH, fetchImpl });
    const page = await provider.pollChanges(null, { collectionExternalId: 'corpus' });
    expect(page.changes).toContainEqual({
      type: 'tombstone',
      externalId: 'knowledge/deleted.md',
      collectionExternalId: 'corpus',
    });
    expect(page.changes.filter((c) => c.type === 'tombstone')).toHaveLength(1);
  });

  it('complete: false on an otherwise successful response is a soft truncation (resume, no backoff), not a failure', async () => {
    const { fetchImpl } = makeHubFetch({ manifest: manifest([doc('knowledge/a.md', 'hash-a')], [], { complete: false }) });
    const provider = new CezarHubSourceProvider(connectionFixture(), { ...AUTH, fetchImpl });
    const page = await provider.pollChanges(null, { collectionExternalId: 'corpus' });
    expect(page.complete).toBe(false);
    expect(page.truncated).toBe(true); // distinguished from the HTTP-failure case above
    expect(page.changes).toHaveLength(1); // what it saw is still reported, not discarded
  });
});

describe('listDocuments', () => {
  it('lists every manifest doc, unfiltered by any watermark', async () => {
    const { fetchImpl } = makeHubFetch({ manifest: manifest([doc('knowledge/a.md', 'hash-a')]) });
    const provider = new CezarHubSourceProvider(connectionFixture(), { ...AUTH, fetchImpl });
    const page = await provider.listDocuments({ collectionExternalId: 'corpus' });
    expect(page.documents).toEqual([
      {
        externalId: 'knowledge/a.md',
        collectionExternalId: 'corpus',
        title: 'a',
        url: `${HUB_URL}/api/v1/cluster/corpus/knowledge/a.md`,
        remoteVersion: 'hash-a',
        docType: 'page',
        properties: {},
      },
    ]);
    expect(page.complete).toBe(true);
  });
});

describe('fetchDocument', () => {
  it('fetches the body for a ref discovered via pollChanges', async () => {
    const { fetchImpl } = makeHubFetch({
      manifest: manifest([doc('knowledge/a.md', 'hash-a')]),
      docs: { 'knowledge/a.md': 'Rendered body.' },
    });
    const provider = new CezarHubSourceProvider(connectionFixture(), { ...AUTH, fetchImpl });
    const page = await provider.pollChanges(null, { collectionExternalId: 'corpus' });
    const ref = page.changes[0]!.type === 'upsert' ? page.changes[0]!.doc : undefined;
    expect(ref).toBeDefined();
    const document = await provider.fetchDocument(ref!);
    expect(document).toEqual({ ...ref, body: 'Rendered body.', lossy: [] });
  });

  it('returns null (never throws) when the hub 404s', async () => {
    const { fetchImpl } = makeHubFetch({ manifest: manifest([]) });
    const provider = new CezarHubSourceProvider(connectionFixture(), { ...AUTH, fetchImpl });
    const result = await provider.fetchDocument({
      externalId: 'knowledge/missing.md',
      collectionExternalId: 'corpus',
      title: 'missing',
      url: 'x',
      remoteVersion: 'h',
      docType: 'page',
      properties: {},
    });
    expect(result).toBeNull();
  });

  it('returns null (never throws) on a malformed body - missing the required "body" field', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ path: 'knowledge/a.md' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const provider = new CezarHubSourceProvider(connectionFixture(), { ...AUTH, fetchImpl });
    const result = await provider.fetchDocument({
      externalId: 'knowledge/a.md',
      collectionExternalId: 'corpus',
      title: 'a',
      url: 'x',
      remoteVersion: 'h',
      docType: 'page',
      properties: {},
    });
    expect(result).toBeNull();
  });
});

describe('viewUrl', () => {
  it('builds the corpus doc-fetch URL, percent-encoding each path segment', () => {
    const provider = new CezarHubSourceProvider(connectionFixture(), AUTH);
    const url = provider.viewUrl({
      externalId: 'knowledge/a b.md',
      collectionExternalId: 'corpus',
      title: 'a b',
      url: 'x',
      remoteVersion: 'h',
      docType: 'page',
      properties: {},
    });
    expect(url).toBe(`${HUB_URL}/api/v1/cluster/corpus/knowledge/a%20b.md`);
  });

  it('null when no hub URL is configured', () => {
    const provider = new CezarHubSourceProvider(connectionFixture(), { env: {} });
    expect(
      provider.viewUrl({
        externalId: 'knowledge/a.md',
        collectionExternalId: 'corpus',
        title: 'a',
        url: 'x',
        remoteVersion: 'h',
        docType: 'page',
        properties: {},
      }),
    ).toBeNull();
  });
});

describe('auth wiring - the credential never rides real process.env', () => {
  it('explicit options win over env', async () => {
    const { fetchImpl, requests } = makeHubFetch({ manifest: manifest([]) });
    const provider = new CezarHubSourceProvider(connectionFixture(), {
      hubUrl: HUB_URL,
      nodeId: 'explicit-node',
      secret: 'explicit-secret',
      env: { CEZ_CLUSTER_HUB: 'https://wrong.internal', CEZ_CLUSTER_NODE_ID: 'wrong-node', CEZ_CLUSTER_SECRET: 'wrong-secret' },
      fetchImpl,
    });
    await provider.detect();
    expect(requests[0]).toMatch(new RegExp(`^${HUB_URL}/`));
  });

  it('an injected env bag (never real process.env) supplies nodeId/secret when options omit them', async () => {
    const { fetchImpl } = makeHubFetch({ manifest: manifest([]) });
    const provider = new CezarHubSourceProvider(connectionFixture(), {
      env: { CEZ_CLUSTER_HUB: HUB_URL, CEZ_CLUSTER_NODE_ID: 'node-from-env', CEZ_CLUSTER_SECRET: 'secret-from-env' },
      fetchImpl,
    });
    expect(await provider.detect()).toEqual({ available: true });
  });

  it('an env bag with none of the three names configured leaves the provider unauthenticated - no request is ever sent', async () => {
    const { fetchImpl, requests } = makeHubFetch({ manifest: manifest([]) });
    const provider = new CezarHubSourceProvider(connectionFixture(), { env: {}, fetchImpl });
    const result = await provider.detect();
    expect(result.available).toBe(false);
    expect(requests).toHaveLength(0);
  });
});

/**
 * D20's caller-side follow-up: `request()` used to send `Authorization: Bearer <secret>` +
 * `x-cezar-node-id` (module header's now-superseded proposal). It now signs with
 * `cluster/node-auth.ts#signNodeHttpPrincipal` instead. Every test here verifies the request that
 * was ACTUALLY captured by the fetch stub, using the real `verifyNodeHttpPrincipal` - never a
 * re-derivation with the same signing helper that produced the headers, which would only prove the
 * helper is deterministic with itself.
 */
describe('node auth (D20) - request-bound signed principal replaces the bearer header', () => {
  it('signs the manifest GET with a principal the real verifier accepts, over exactly what was sent', async () => {
    const { fetchImpl, calls } = captureAuthFetch();
    const provider = new CezarHubSourceProvider(connectionFixture(), { ...AUTH, fetchImpl });
    await provider.detect();

    // Floor: the request actually happened, before trusting anything about its headers.
    expect(calls).toHaveLength(1);
    const sent = calls[0]!;
    expect(sent.method).toBe('GET');

    const url = new URL(sent.url);
    const verdict = verifyNodeHttpPrincipal(
      { principal: sent.headers[CLUSTER_NODE_PRINCIPAL_HEADER], signature: sent.headers[CLUSTER_NODE_SIGNATURE_HEADER] },
      sent.headers[CLUSTER_NODE_ID_HEADER],
      AUTH.secret,
      { method: sent.method, path: url.pathname, bodyHash: hashRequestBody(sent.bodyText) },
    );
    expect(verdict).toEqual({ ok: true, nodeId: AUTH.nodeId });
  });

  it('sends no Authorization/bearer header at all - the superseded credential is gone, not merely alongside the new one', async () => {
    const { fetchImpl, calls } = captureAuthFetch();
    const provider = new CezarHubSourceProvider(connectionFixture(), { ...AUTH, fetchImpl });
    await provider.detect();

    const sent = calls[0]!;
    expect(sent.headers.authorization).toBeUndefined();
    expect(Object.values(sent.headers).some((value) => value.includes('Bearer'))).toBe(false);
    expect(sent.headers[CLUSTER_NODE_ID_HEADER]).toBe(AUTH.nodeId);
  });

  it('negative control: the same signed headers do not verify against a different path', async () => {
    const { fetchImpl, calls } = captureAuthFetch();
    const provider = new CezarHubSourceProvider(connectionFixture(), { ...AUTH, fetchImpl });
    await provider.detect();

    const sent = calls[0]!;
    const url = new URL(sent.url);
    const verdict = verifyNodeHttpPrincipal(
      { principal: sent.headers[CLUSTER_NODE_PRINCIPAL_HEADER], signature: sent.headers[CLUSTER_NODE_SIGNATURE_HEADER] },
      sent.headers[CLUSTER_NODE_ID_HEADER],
      AUTH.secret,
      { method: sent.method, path: `${url.pathname}/not-the-signed-path`, bodyHash: hashRequestBody(sent.bodyText) },
    );
    expect(verdict).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('negative control: the same signed headers do not verify against a different body', async () => {
    const { fetchImpl, calls } = captureAuthFetch();
    const provider = new CezarHubSourceProvider(connectionFixture(), { ...AUTH, fetchImpl });
    await provider.detect();

    const sent = calls[0]!;
    const url = new URL(sent.url);
    const verdict = verifyNodeHttpPrincipal(
      { principal: sent.headers[CLUSTER_NODE_PRINCIPAL_HEADER], signature: sent.headers[CLUSTER_NODE_SIGNATURE_HEADER] },
      sent.headers[CLUSTER_NODE_ID_HEADER],
      AUTH.secret,
      { method: sent.method, path: url.pathname, bodyHash: hashRequestBody('a body this request never carried') },
    );
    expect(verdict).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('negative control: the same signed headers do not verify once the freshness window has passed', async () => {
    const { fetchImpl, calls } = captureAuthFetch();
    const provider = new CezarHubSourceProvider(connectionFixture(), { ...AUTH, fetchImpl });
    await provider.detect();

    const sent = calls[0]!;
    const url = new URL(sent.url);
    const verdict = verifyNodeHttpPrincipal(
      { principal: sent.headers[CLUSTER_NODE_PRINCIPAL_HEADER], signature: sent.headers[CLUSTER_NODE_SIGNATURE_HEADER] },
      sent.headers[CLUSTER_NODE_ID_HEADER],
      AUTH.secret,
      { method: sent.method, path: url.pathname, bodyHash: hashRequestBody(sent.bodyText) },
      { now: () => new Date(Date.now() + LINK_PRINCIPAL_MAX_AGE_MS + 60_000) },
    );
    expect(verdict).toEqual({ ok: false, reason: 'stale-principal' });
  });

  it('refuses to sign - and sends no request - when this node has a nodeId but no secret on file', async () => {
    const { fetchImpl, calls } = captureAuthFetch();
    const provider = new CezarHubSourceProvider(connectionFixture(), { hubUrl: HUB_URL, nodeId: 'node-1', fetchImpl });

    const result = await provider.detect();
    expect(result).toEqual({ available: false, reason: 'no cluster credential for this node - it has not joined a cluster' });
    expect(calls).toHaveLength(0);
  });
});

// ---- sweep-level (16/17/18): the REAL runSourceSync, a REAL FileSourceSink + SourceStore, and a
// fake HTTP hub. Idiom copied from `../sync.test.ts`'s own `setup()`. ----------------------------

async function setup(overrides: Partial<SourceConnection> = {}) {
  const dir = await directory();
  const store = SourceStore.open(dir);
  const connection = store.create(
    {
      kind: CEZAR_HUB_SOURCE_KIND,
      name: 'prod-host',
      enabled: true,
      mode: 'mirror',
      intervalSeconds: 900,
      collections: [{ externalId: 'corpus', collectionKind: 'database', maxDepth: 3, splitOnHeading: 'h2' }],
      watchComments: false,
      maxDocuments: 5_000,
      maxBodyBytes: 524_288,
      ...overrides,
    },
    'conn-1',
  );
  const sink = new FileSourceSink(dir, 'conn-1');
  const mirrorRoot = join(dir, 'sources');
  const connectionDir = join(mirrorRoot, 'conn-1');
  return { dir, store, connection, sink, mirrorRoot, connectionDir };
}

describe('verification 16 - corpus sweep, tombstone half', () => {
  it('an explicit manifest tombstone deletes the mirrored copy; mere absence from a later manifest does not (negative control)', async () => {
    const { store, connection, sink, mirrorRoot, connectionDir } = await setup();
    const docId = computeDocId(connection, 'knowledge/a.md');

    // Tick 1: A is mirrored.
    const tick1 = makeHubFetch({ manifest: manifest([doc('knowledge/a.md', 'h1')]), docs: { 'knowledge/a.md': 'Body A.' } });
    const provider1 = new CezarHubSourceProvider(connection, { ...AUTH, fetchImpl: tick1.fetchImpl });
    await runSourceSync({ connection, store, sink, provider: provider1, mirrorRoot });
    expect(await sink.readMeta(docId)).not.toBeNull();

    // Tick 2: A simply does not appear in this manifest - no explicit tombstone signal. This is
    // EXACTLY the bug `../sync.ts`'s own docblock warns about: A's absence from one delta must
    // never be read as deletion.
    const tick2 = makeHubFetch({ manifest: manifest([]) });
    const provider2 = new CezarHubSourceProvider(connection, { ...AUTH, fetchImpl: tick2.fetchImpl });
    const result2 = await runSourceSync({ connection, store, sink, provider: provider2, mirrorRoot });
    expect(result2.complete).toBe(true);
    const stillThere = await sink.readMeta(docId);
    expect(stillThere).not.toBeNull(); // negative control: absence alone never tombstones
    expect(stillThere?.source.state).toBe('ok');

    // Tick 3: the hub now sends an EXPLICIT tombstone for the same path.
    const tick3 = makeHubFetch({ manifest: manifest([], [{ path: 'knowledge/a.md', at: '2026-08-22T01:00:00.000Z' }]) });
    const provider3 = new CezarHubSourceProvider(connection, { ...AUTH, fetchImpl: tick3.fetchImpl });
    const result3 = await runSourceSync({ connection, store, sink, provider: provider3, mirrorRoot });
    expect(result3.tombstoneCount).toBe(1);
    expect(await sink.readMeta(docId)).toBeNull(); // gone from the live mirror
    const deletedRaw = readFileSync(join(connectionDir, 'deleted', `${docId}.md`), 'utf8');
    expect(deletedRaw).toContain('state: tombstoned');
  });
});

describe('verification 17 - divergence is quarantined, never overwritten and never merged', () => {
  it('a local edit plus a newer remote hash quarantines the incoming body, leaving the local body byte-identical', async () => {
    const { store, connection, sink, mirrorRoot, connectionDir } = await setup();
    const path = 'domains/predicts.md';
    const docId = computeDocId(connection, path);

    const tick1 = makeHubFetch({ manifest: manifest([doc(path, 'h1')]), docs: { [path]: 'Original body.' } });
    const provider1 = new CezarHubSourceProvider(connection, { ...AUTH, fetchImpl: tick1.fetchImpl });
    await runSourceSync({ connection, store, sink, provider: provider1, mirrorRoot });

    // A human (or another process) edits the mirrored file directly, bypassing the sink.
    const localPath = join(connectionDir, `${docId}.md`);
    writeFileSync(localPath, readFileSync(localPath, 'utf8').replace('Original body.', 'Locally edited body.'));

    // The hub now reports a NEW hash for the same path - the remote genuinely changed too.
    const tick2 = makeHubFetch({ manifest: manifest([doc(path, 'h2')]), docs: { [path]: 'Incoming remote body.' } });
    const provider2 = new CezarHubSourceProvider(connection, { ...AUTH, fetchImpl: tick2.fetchImpl });
    const result2 = await runSourceSync({ connection, store, sink, provider: provider2, mirrorRoot });

    const read = await sink.read(docId);
    expect(read?.body).toBe('Locally edited body.'); // byte-identical to what was written locally - never overwritten, never merged

    const meta = await sink.readMeta(docId);
    expect(meta?.source.state).toBe('conflict'); // reported quarantined

    const conflictsDir = join(connectionDir, 'conflicts');
    const conflictFiles = readdirSync(conflictsDir);
    expect(conflictFiles).toHaveLength(1);
    expect(readFileSync(join(conflictsDir, conflictFiles[0]!), 'utf8')).toBe('Incoming remote body.');
    expect(result2.conflictCount).toBe(1);
  });
});

describe('verification 18 - mirror scope is honoured and legible', () => {
  // CORRECTED 2026-08-24 (owner, "everything should be on by default" - contract/src/cluster.ts's
  // own docblock on `CLUSTER_CORPUS_DEFAULT_SCOPE`): this used to assert the default EXCLUDED
  // reports/raw-input. It now includes every scope by default; the mechanism these two tests exist
  // to prove (legible, not just absent - "not found" vs "not mirrored" must stay distinguishable)
  // is unchanged, so they now exercise it via the default (all six) and an explicit narrowing.
  it('the default scope declares every scope, legibly, on every manifest request', async () => {
    const { store, connection, sink, mirrorRoot } = await setup();
    const hub = makeHubFetch({ manifest: manifest([doc('knowledge/a.md', 'h1')]) });
    const provider = new CezarHubSourceProvider(connection, { ...AUTH, fetchImpl: hub.fetchImpl });
    await runSourceSync({ connection, store, sink, provider, mirrorRoot });

    // Legible, not just absent - EVERY manifest request (the sweep's own `detect()` probe included)
    // DECLARES the scope it is asking for, so a reader of the wire traffic can already tell what a
    // node mirrors before any response arrives.
    const manifestRequests = hub.requests.filter((request) => new URL(request).pathname === '/api/v1/cluster/corpus');
    expect(manifestRequests.length).toBeGreaterThan(0);
    for (const request of manifestRequests) {
      const requestedScope = new URL(request).searchParams.get('scope')?.split(',');
      expect(requestedScope).toEqual([...CLUSTER_CORPUS_DEFAULT_SCOPE]);
      expect(requestedScope).toContain('reports');
      expect(requestedScope).toContain('raw-input');
    }
  });

  it('narrowing scope away from reports/ is a real, visible switch on the request, and nothing report-scoped lands in the mirror', async () => {
    const { store, connection, sink, mirrorRoot } = await setup();
    const narrowScope = CLUSTER_CORPUS_DEFAULT_SCOPE.filter((s) => s !== 'reports' && s !== 'raw-input');
    // A well-behaved hub (3b.2's job to build): it echoes back exactly the scope it was asked for
    // and returns no reports/ doc, because none was requested.
    const hub = makeHubFetch({ manifest: manifest([doc('knowledge/a.md', 'h1')]) });
    const provider = new CezarHubSourceProvider(connection, { ...AUTH, scope: narrowScope, fetchImpl: hub.fetchImpl });
    await runSourceSync({ connection, store, sink, provider, mirrorRoot });

    // Half 1: not found - nothing report-scoped is on disk.
    const mirrored = await sink.list('conn-1');
    expect(mirrored.some((entry) => entry.source.externalId.startsWith('reports/'))).toBe(false);

    // Half 2: legible, not just absent.
    const manifestRequests = hub.requests.filter((request) => new URL(request).pathname === '/api/v1/cluster/corpus');
    expect(manifestRequests.length).toBeGreaterThan(0);
    for (const request of manifestRequests) {
      const requestedScope = new URL(request).searchParams.get('scope')?.split(',');
      expect(requestedScope).toEqual(narrowScope);
      expect(requestedScope).not.toContain('reports');
      expect(requestedScope).not.toContain('raw-input');
    }
  });

  it('a manifest response missing the required "scope" field is rejected as malformed, never silently trusted', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ corpusVersion: 'v1', docs: [], tombstones: [], complete: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const provider = new CezarHubSourceProvider(connectionFixture(), { ...AUTH, fetchImpl });
    const page = await provider.pollChanges(null, { collectionExternalId: 'corpus' });
    expect(page).toEqual({ changes: [], watermark: null, nextPageCursor: null, complete: false, truncated: false });
  });
});

// ---- item 56 (2026-08-24): manifest coalescing, `since`, and batch body prefetch --------------
//
// A `since`-aware fake hub, used by several tests below: the manifest response depends on the
// `since` query param, matching the real contract's delta semantics (`docs[]` is the changed set
// once `since` is supplied). `docHashes` is passed explicitly throughout this section because
// `manifest` is a per-URL FUNCTION here, not a static object - `makeHubFetch` can only derive
// hashes from a static manifest (module comment on `HubFixture`).

describe('item 56 - manifest coalescing (detect + pollChanges share one fetch)', () => {
  it('a no-change sweep, on a provider instance that already ran once, issues exactly ONE HTTP request', async () => {
    const { store, connection, sink, mirrorRoot } = await setup();
    const hub = makeHubFetch({
      manifest: (url) =>
        url.searchParams.get('since') === 'v1'
          ? manifest([], [], { corpusVersion: 'v1' })
          : manifest([doc('knowledge/a.md', 'h1')], [], { corpusVersion: 'v1' }),
      docs: { 'knowledge/a.md': 'Body A.' },
      docHashes: { 'knowledge/a.md': 'h1' },
    });
    // ONE provider instance, reused across both ticks - see the module header's mechanism 2 on why
    // that is load-bearing: `detect()` has no `since` parameter of its own and can only match
    // `pollChanges()`'s key via `lastKnownCorpusVersion`, which is in-memory and does not survive a
    // fresh instance. `WorkspaceSourceScheduler`'s default resolver constructs a fresh provider every
    // tick (verified against `../scheduler.ts`), so this specific "exactly one" guarantee is proven
    // here for a persistent instance, not (yet) for today's production default - flagged in the
    // module header and the implementation report, not silently claimed as a closed production gap.
    const provider = new CezarHubSourceProvider(connection, { ...AUTH, fetchImpl: hub.fetchImpl });

    await runSourceSync({ connection, store, sink, provider, mirrorRoot });
    expect(await sink.readMeta(computeDocId(connection, 'knowledge/a.md'))).not.toBeNull();

    const requestsBeforeTick2 = hub.requests.length;
    const tick2 = await runSourceSync({ connection, store, sink, provider, mirrorRoot });
    const tick2Requests = hub.requests.slice(requestsBeforeTick2);

    // Negative control (module header / item 56 verification 1): counting REQUESTS, not diffs - a
    // provider that silently refetched every body and rewrote identical bytes would still show
    // `documentCount` unchanged, which is why this assertion is on `tick2Requests`, not on state.
    expect(tick2Requests).toHaveLength(1);
    expect(new URL(tick2Requests[0]!).pathname).toBe('/api/v1/cluster/corpus');
    expect(new URL(tick2Requests[0]!).searchParams.get('since')).toBe('v1');
    expect(tick2.complete).toBe(true);
  });

  it('concurrent detect() calls for the same manifest join one in-flight request, never two', async () => {
    const { fetchImpl, requests } = makeHubFetch({ manifest: manifest([doc('knowledge/a.md', 'h1')]) });
    const provider = new CezarHubSourceProvider(connectionFixture(), { ...AUTH, fetchImpl });
    await Promise.all([provider.detect(), provider.detect()]);
    expect(requests).toHaveLength(1);
  });
});

describe('item 56 - since carries the last known corpusVersion', () => {
  it('pollChanges sends the watermark\'s corpusVersion as ?since=, and none on the very first call', async () => {
    const hub = makeHubFetch({ manifest: manifest([]) });
    const provider = new CezarHubSourceProvider(connectionFixture(), { ...AUTH, fetchImpl: hub.fetchImpl });

    await provider.pollChanges(null, { collectionExternalId: 'corpus' });
    expect(new URL(hub.requests[0]!).searchParams.has('since')).toBe(false);

    const watermark = { timestamp: '', tieBreaker: '', corpusVersion: 'v7' };
    await provider.pollChanges(watermark, { collectionExternalId: 'corpus' });
    expect(new URL(hub.requests[1]!).searchParams.get('since')).toBe('v7');
  });

  it('a changed doc is batch-fetched; an unchanged doc from the prior tick is never named in the request', async () => {
    const { store, connection, sink, mirrorRoot } = await setup();
    const hub = makeHubFetch({
      manifest: (url) =>
        url.searchParams.get('since') === 'v1'
          ? manifest([doc('domains/c.md', 'hc')], [], { corpusVersion: 'v2' })
          : manifest([doc('knowledge/a.md', 'ha'), doc('knowledge/b.md', 'hb')], [], { corpusVersion: 'v1' }),
      docs: { 'knowledge/a.md': 'A body', 'knowledge/b.md': 'B body', 'domains/c.md': 'C body' },
      docHashes: { 'knowledge/a.md': 'ha', 'knowledge/b.md': 'hb', 'domains/c.md': 'hc' },
    });
    const provider = new CezarHubSourceProvider(connection, { ...AUTH, fetchImpl: hub.fetchImpl });

    await runSourceSync({ connection, store, sink, provider, mirrorRoot }); // tick 1: a.md + b.md mirrored
    const batchesBeforeTick2 = hub.batchRequests.length;
    await runSourceSync({ connection, store, sink, provider, mirrorRoot }); // tick 2: only c.md changed
    const tick2Batches = hub.batchRequests.slice(batchesBeforeTick2);

    expect(tick2Batches).toHaveLength(1);
    expect(tick2Batches[0]!.paths).toEqual(['domains/c.md']);
    expect(tick2Batches[0]!.paths).not.toContain('knowledge/a.md');
    expect(tick2Batches[0]!.paths).not.toContain('knowledge/b.md');
    expect(await sink.readMeta(computeDocId(connection, 'domains/c.md'))).not.toBeNull();
  });
});

describe('item 56 - body batching', () => {
  it('450 changed docs produce 3 batch requests of at most CLUSTER_CORPUS_BATCH_MAX_PATHS, never 450 single GETs', async () => {
    const docs = Array.from({ length: 450 }, (_, i) => doc(`knowledge/doc-${i}.md`, `h${i}`));
    const fixtureDocs = Object.fromEntries(docs.map((d) => [d.path, `body of ${d.path}`]));
    const fixtureHashes = Object.fromEntries(docs.map((d) => [d.path, d.hash]));
    const hub = makeHubFetch({ manifest: manifest(docs), docs: fixtureDocs, docHashes: fixtureHashes });
    const provider = new CezarHubSourceProvider(connectionFixture(), { ...AUTH, fetchImpl: hub.fetchImpl });

    await provider.pollChanges(null, { collectionExternalId: 'corpus' });

    expect(hub.batchRequests).toHaveLength(3);
    expect(hub.batchRequests[0]!.paths).toHaveLength(200);
    expect(hub.batchRequests[1]!.paths).toHaveLength(200);
    expect(hub.batchRequests[2]!.paths).toHaveLength(50);
    for (const batch of hub.batchRequests) expect(batch.paths.length).toBeLessThanOrEqual(CLUSTER_CORPUS_BATCH_MAX_PATHS);
    // Never one GET per document (the 235s-serial shape item 56 measures against): no single-doc
    // GET route was hit for any of these paths.
    const singleDocGets = hub.requests.filter((r) => new URL(r).pathname.startsWith('/api/v1/cluster/corpus/knowledge/doc-'));
    expect(singleDocGets).toHaveLength(0);
  });

  it('truncated: true on a batch response is not failure - the provider asks again for the remainder, and both docs end up cached', async () => {
    let call = 0;
    const hub = makeHubFetch({
      manifest: manifest([doc('knowledge/a.md', 'ha'), doc('knowledge/b.md', 'hb')]),
      // No `docs` fixture at all - the single-document GET route 404s for both paths, so if either
      // ends up served via that fallback (rather than the looped batch), the body would be wrong /
      // missing, which the assertions below would catch.
      bodiesResponse: (paths) => {
        call += 1;
        if (call === 1) return { docs: [{ path: 'knowledge/a.md', hash: 'ha', body: 'A body' }], missing: [], truncated: true };
        expect(paths).toEqual(['knowledge/b.md']); // the loop asks again for exactly what it didn't get
        return { docs: [{ path: 'knowledge/b.md', hash: 'hb', body: 'B body' }], missing: [], truncated: false };
      },
    });
    const provider = new CezarHubSourceProvider(connectionFixture(), { ...AUTH, fetchImpl: hub.fetchImpl });

    const page = await provider.pollChanges(null, { collectionExternalId: 'corpus' });
    expect(hub.batchRequests).toHaveLength(2); // the truncated retry, not a silently dropped tail

    const docA = await provider.fetchDocument(upsertDocOf(page.changes, 'knowledge/a.md'));
    const docB = await provider.fetchDocument(upsertDocOf(page.changes, 'knowledge/b.md'));
    expect(docA?.body).toBe('A body'); // completeness, not just "the response had truncated:true"
    expect(docB?.body).toBe('B body');
  });

  it('a batch body whose hash does not match the manifest is never trusted from cache - fetchDocument falls back to the per-document GET', async () => {
    const hub = makeHubFetch({
      manifest: manifest([doc('knowledge/a.md', 'ha')]),
      docs: { 'knowledge/a.md': 'Correct body.' },
      // The batch response claims a DIFFERENT hash than the manifest promised for this path.
      bodiesResponse: () => ({ docs: [{ path: 'knowledge/a.md', hash: 'stale-hash', body: 'Stale prefetched body.' }], missing: [], truncated: false }),
    });
    const provider = new CezarHubSourceProvider(connectionFixture(), { ...AUTH, fetchImpl: hub.fetchImpl });

    const page = await provider.pollChanges(null, { collectionExternalId: 'corpus' });
    const ref = page.changes[0]!.type === 'upsert' ? page.changes[0]!.doc : undefined;
    const document = await provider.fetchDocument(ref!);
    // Fell back to the single-document GET (which serves the CORRECT body from `fixture.docs`),
    // never the mismatched batch entry.
    expect(document?.body).toBe('Correct body.');
  });
});

function connectionFixture(overrides: Partial<SourceConnection> = {}): SourceConnection {
  return sourceConnectionSchema.parse({
    id: 'conn-1',
    revision: 1,
    kind: CEZAR_HUB_SOURCE_KIND,
    name: 'prod-host',
    enabled: true,
    mode: 'mirror',
    intervalSeconds: 900,
    collections: [{ externalId: 'corpus', collectionKind: 'database' }],
    watchComments: false,
    maxDocuments: 5_000,
    maxBodyBytes: 524_288,
    createdAt: '2026-08-22T00:00:00.000Z',
    updatedAt: '2026-08-22T00:00:00.000Z',
    ...overrides,
  });
}
