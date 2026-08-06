import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { sourceConnectionSchema, type SourceConnection, type SourceConnectionInput } from '../types.ts';
import { NotionSourceProvider, NOTION_SOURCE_KIND } from './provider.ts';
import type { SourceDocumentRef } from '../provider-types.ts';

/**
 * `notion/provider.ts` - the `SourceProvider` adapter over W1.4's `client.ts` (F2, W2.2). See
 * `.ai/specs/2026-08-06-external-source-connectors-notion.md` phase "2.3" for the one REQUIRED
 * test ("a 401 yields changes: [] with complete: false"); everything else here exercises the
 * `database`/`page-tree` dispatch, watermark filtering, tombstoning and fetch/split behaviour this
 * file adds on top of that client. No test performs live network I/O - every provider below is
 * constructed with an explicit `fetchImpl` reading a queued in-memory `Response`.
 */

const fixturesDir = fileURLToPath(new URL('../notion/fixtures/', import.meta.url));

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(`${fixturesDir}${name}.json`, 'utf8'));
}

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

function queueFetch(...responses: Response[]): typeof fetch {
  let i = 0;
  return vi.fn(async () => {
    const res = responses[i];
    i += 1;
    if (!res) throw new Error(`unexpected extra fetch call (#${i})`);
    return res;
  }) as unknown as typeof fetch;
}

function connection(overrides: Partial<SourceConnectionInput> = {}): SourceConnection {
  return sourceConnectionSchema.parse({
    id: 'conn-1',
    revision: 1,
    kind: NOTION_SOURCE_KIND,
    name: 'Acme workspace',
    collections: [],
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  });
}

function provider(fetchImpl: typeof fetch, conn: SourceConnection): NotionSourceProvider {
  return new NotionSourceProvider(conn, { token: 'secret_test_token', apiBase: 'https://notion.test', fetchImpl, requestsPerSecond: 1000 });
}

const databaseConnection = connection({
  collections: [{ externalId: 'db-1', collectionKind: 'database', label: 'Docs', maxDepth: 3, splitOnHeading: 'h2' }],
});

describe('capabilities and kind', () => {
  it('declares push:false and every other capability true', () => {
    const p = provider(queueFetch(), databaseConnection);
    expect(p.kind).toBe('notion');
    expect(p.capabilities).toEqual({ list: true, fetch: true, poll: true, push: false, comments: true });
  });
});

describe('detect / detectCached', () => {
  it('delegates to the client - a 401 resolves {available:false}, never throws', async () => {
    const fetchImpl = queueFetch(jsonResponse(fixture('error-unauthorized-401'), { status: 401 }));
    const p = provider(fetchImpl, databaseConnection);
    await expect(p.detect()).resolves.toMatchObject({ available: false });
  });
});

describe('pollChanges - database collections', () => {
  it('REQUIRED (spec phase 2.3): a 401 yields changes: [] with complete: false - a revoked token is never an empty workspace', async () => {
    const fetchImpl = queueFetch(jsonResponse(fixture('error-unauthorized-401'), { status: 401 }));
    const p = provider(fetchImpl, databaseConnection);
    const result = await p.pollChanges(null, { collectionExternalId: 'db-1' });
    expect(result.changes).toEqual([]);
    expect(result.complete).toBe(false);
  });

  it('emits an upsert per row, title extracted and properties flattened, watermark advanced to the latest', async () => {
    const fetchImpl = queueFetch(jsonResponse(fixture('database-query-page-1')), jsonResponse(fixture('database-query-page-2')));
    const p = provider(fetchImpl, databaseConnection);
    const result = await p.pollChanges(null, { collectionExternalId: 'db-1' });

    expect(result.complete).toBe(true);
    expect(result.changes).toHaveLength(2);
    expect(result.changes[0]).toEqual({
      type: 'upsert',
      doc: {
        externalId: 'page-a',
        collectionExternalId: 'db-1',
        title: 'Document A',
        url: 'https://www.notion.so/page-a',
        remoteVersion: '2026-08-01T10:00:00.000Z',
        docType: 'row',
        properties: { Name: 'Document A' },
      },
    });
    expect(result.watermark).toEqual({ timestamp: '2026-08-02T10:00:00.000Z', tieBreaker: 'page-b' });
  });

  it('a watermark equal to a row\'s own (timestamp, id) excludes exactly that row, never a later one', async () => {
    const fetchImpl = queueFetch(jsonResponse(fixture('database-query-page-1')), jsonResponse(fixture('database-query-page-2')));
    const p = provider(fetchImpl, databaseConnection);
    const since = { timestamp: '2026-08-01T10:00:00.000Z', tieBreaker: 'page-a' };
    const result = await p.pollChanges(since, { collectionExternalId: 'db-1' });
    expect(result.changes.map((c) => (c.type === 'upsert' ? c.doc.externalId : c.externalId))).toEqual(['page-b']);
  });

  it('an archived row is reported as a tombstone, not an upsert', async () => {
    const archivedPage = {
      object: 'page',
      id: 'page-gone',
      url: 'https://www.notion.so/page-gone',
      last_edited_time: '2026-08-03T00:00:00.000Z',
      archived: true,
      properties: {},
    };
    const fetchImpl = queueFetch(jsonResponse({ object: 'list', results: [archivedPage], has_more: false, next_cursor: null }));
    const p = provider(fetchImpl, databaseConnection);
    const result = await p.pollChanges(null, { collectionExternalId: 'db-1' });
    expect(result.changes).toEqual([{ type: 'tombstone', externalId: 'page-gone', collectionExternalId: 'db-1' }]);
  });

  it('an unconfigured collectionExternalId is a no-op, reported complete (nothing to enumerate)', async () => {
    const p = provider(queueFetch(), databaseConnection);
    const result = await p.pollChanges(null, { collectionExternalId: 'not-configured' });
    expect(result).toEqual({ changes: [], watermark: null, nextPageCursor: null, complete: true, truncated: false });
  });
});

describe('listDocuments - database collections', () => {
  it('lists every non-archived row, unfiltered by any watermark', async () => {
    const fetchImpl = queueFetch(jsonResponse(fixture('database-query-page-1')), jsonResponse(fixture('database-query-page-2')));
    const p = provider(fetchImpl, databaseConnection);
    const page = await p.listDocuments({ collectionExternalId: 'db-1' });
    expect(page.documents.map((d) => d.externalId)).toEqual(['page-a', 'page-b']);
    expect(page.complete).toBe(true);
  });
});

describe('listCollections', () => {
  it('reflects the connection\'s own configured collections (client.ts has no discovery endpoint)', async () => {
    const withTwo = connection({
      collections: [
        { externalId: 'db-1', collectionKind: 'database', label: 'Docs' },
        { externalId: 'root-1', collectionKind: 'page-tree', label: 'Meeting Notes' },
      ],
    });
    const p = provider(queueFetch(), withTwo);
    await expect(p.listCollections()).resolves.toEqual([
      { externalId: 'db-1', collectionKind: 'database', label: 'Docs' },
      { externalId: 'root-1', collectionKind: 'page-tree', label: 'Meeting Notes' },
    ]);
  });
});

describe('fetchDocument', () => {
  it('renders the block tree to Markdown for a ref discovered via pollChanges/listDocuments', async () => {
    const fetchImpl = queueFetch(jsonResponse(fixture('block-children-page1')), jsonResponse(fixture('block-children-page2')));
    const p = provider(fetchImpl, databaseConnection);
    const ref: SourceDocumentRef = {
      externalId: 'page-a',
      collectionExternalId: 'db-1',
      title: 'Document A',
      url: 'https://www.notion.so/page-a',
      remoteVersion: '2026-08-01T10:00:00.000Z',
      docType: 'row',
      properties: {},
    };
    const doc = await p.fetchDocument(ref);
    expect(doc?.body).toContain('First paragraph.');
    expect(doc?.body).toContain('Second paragraph.');
    expect(doc?.lossy).toEqual([]);
    expect(doc?.title).toBe('Document A');
  });

  it('returns null (never throws) when the block tree fetch fails', async () => {
    const fetchImpl = queueFetch(jsonResponse(fixture('error-unauthorized-401'), { status: 401 }));
    const p = provider(fetchImpl, databaseConnection);
    const ref: SourceDocumentRef = {
      externalId: 'page-a',
      collectionExternalId: 'db-1',
      title: 'Document A',
      url: 'https://www.notion.so/page-a',
      remoteVersion: 'v1',
      docType: 'row',
      properties: {},
    };
    await expect(p.fetchDocument(ref)).resolves.toBeNull();
  });
});

describe('viewUrl', () => {
  it('builds a notion.so URL with dashes stripped, and strips a section suffix first', () => {
    const p = provider(queueFetch(), databaseConnection);
    const ref = (externalId: string): SourceDocumentRef => ({
      externalId,
      collectionExternalId: 'db-1',
      title: 't',
      url: 'unused',
      remoteVersion: 'v1',
      docType: 'row',
      properties: {},
    });
    expect(p.viewUrl(ref('aaaa-bbbb-cccc'))).toBe('https://www.notion.so/aaaabbbbcccc');
    // The base id itself has its dashes stripped too (a real Notion id is a dash-formatted UUID) -
    // only the `#headingBlockId` section suffix is stripped intact, before dash-stripping runs.
    expect(p.viewUrl(ref('aaaa-bbbb#heading-1'))).toBe('https://www.notion.so/aaaabbbb');
  });
});

describe('listComments', () => {
  it('normalises comments and marks their attachments downloadable:false, never dropping them', async () => {
    const fetchImpl = queueFetch(jsonResponse(fixture('comments-page1')));
    const p = provider(fetchImpl, databaseConnection);
    const ref: SourceDocumentRef = {
      externalId: 'page-a',
      collectionExternalId: 'db-1',
      title: 't',
      url: 'u',
      remoteVersion: 'v1',
      docType: 'row',
      properties: {},
    };
    const page = await p.listComments!(ref);
    expect(page.comments).toHaveLength(2);
    expect(page.comments[0]).toMatchObject({ body: 'Nice catch, see the attached screenshot.', attachments: [{ type: 'image', downloadable: false }] });
  });

  it('filters to comments created after `since`', async () => {
    const fetchImpl = queueFetch(jsonResponse(fixture('comments-page1')));
    const p = provider(fetchImpl, databaseConnection);
    const ref: SourceDocumentRef = { externalId: 'page-a', collectionExternalId: 'db-1', title: 't', url: 'u', remoteVersion: 'v1', docType: 'row', properties: {} };
    const page = await p.listComments!(ref, '2026-08-03T09:02:00.000Z');
    expect(page.comments.map((c) => c.externalId)).toEqual(['comment-2']);
  });
});

describe('pollChanges / listDocuments - page-tree collections', () => {
  const pageTreeConnection = connection({
    collections: [{ externalId: 'root-1', collectionKind: 'page-tree', label: 'Meeting Notes', maxDepth: 3, splitOnHeading: 'h2' }],
  });

  function block(id: string, type: string, extra: Record<string, unknown>, hasChildren = false): unknown {
    return { object: 'block', id, type, has_children: hasChildren, archived: false, [type]: extra };
  }

  it('discovers the root plus a nested child_page, rendering both as documents', async () => {
    const rootChildren = jsonResponse({
      object: 'list',
      results: [
        block('root-p1', 'paragraph', { rich_text: [{ type: 'text', plain_text: 'Root content.' }] }),
        { object: 'block', id: 'child-1', type: 'child_page', has_children: false, archived: false, child_page: { title: 'Kickoff Notes' } },
      ],
      has_more: false,
      next_cursor: null,
    });
    const childChildren = jsonResponse({
      object: 'list',
      results: [block('child-p1', 'paragraph', { rich_text: [{ type: 'text', plain_text: 'Kickoff body.' }] })],
      has_more: false,
      next_cursor: null,
    });
    const fetchImpl = queueFetch(rootChildren, childChildren);
    const p = provider(fetchImpl, pageTreeConnection);

    const page = await p.listDocuments({ collectionExternalId: 'root-1' });
    expect(page.complete).toBe(true);
    expect(page.documents.map((d) => d.externalId)).toEqual(['root-1', 'child-1']);
    expect(page.documents[1]).toMatchObject({ title: 'Kickoff Notes', docType: 'page' });
    expect(fetchImpl).toHaveBeenCalledTimes(2); // one fetchBlockTree call per page, not a second discovery pass
  });

  it('an archived child page is reported as a tombstone and is never walked further', async () => {
    const rootChildren = jsonResponse({
      object: 'list',
      results: [{ object: 'block', id: 'child-gone', type: 'child_page', has_children: true, archived: true, child_page: { title: 'Deleted Notes' } }],
      has_more: false,
      next_cursor: null,
    });
    const fetchImpl = queueFetch(rootChildren);
    const p = provider(fetchImpl, pageTreeConnection);

    const result = await p.pollChanges(null, { collectionExternalId: 'root-1' });
    const tombstones = result.changes.filter((c) => c.type === 'tombstone');
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]).toMatchObject({ externalId: 'child-gone' });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // archived - never fetched, never walked
  });

  it('a page-tree document\'s remoteVersion is a sha256 of its own rendered body (no server etag is available here)', async () => {
    const rootChildren = jsonResponse({
      object: 'list',
      results: [block('root-p1', 'paragraph', { rich_text: [{ type: 'text', plain_text: 'Unique root text.' }] })],
      has_more: false,
      next_cursor: null,
    });
    const fetchImpl = queueFetch(rootChildren);
    const p = provider(fetchImpl, pageTreeConnection);
    const page = await p.listDocuments({ collectionExternalId: 'root-1' });
    const expectedHash = createHash('sha256').update('Unique root text.\n', 'utf8').digest('hex');
    expect(page.documents[0]?.remoteVersion).toBe(expectedHash);
    expect(page.documents[0]?.remoteVersion).toHaveLength(64); // a sha256 hex digest, not a timestamp
  });

  it('an unconfigured collectionExternalId is a no-op for listDocuments too', async () => {
    const p = provider(queueFetch(), pageTreeConnection);
    const page = await p.listDocuments({ collectionExternalId: 'not-configured' });
    expect(page).toEqual({ documents: [], nextPageCursor: null, complete: true, truncated: false });
  });
});
