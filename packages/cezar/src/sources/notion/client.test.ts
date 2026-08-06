import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { NOTION_VERSION, NotionClient, resolveNotionApiBase, resolveNotionToken, type NotionClientOptions } from './client.ts';

/**
 * `client.ts` - the fetch/zod/pagination mechanics. No test here performs live network I/O: every
 * `NotionClient` below is constructed with an explicit `fetchImpl` reading a queued in-memory
 * `Response`, never the real global `fetch`. See `.ai/specs/2026-08-06-external-source-connectors-notion.md`
 * step 1.4 for the exact test list this file implements.
 */

const fixturesDir = fileURLToPath(new URL('./fixtures/', import.meta.url));

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(`${fixturesDir}${name}.json`, 'utf8'));
}

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

/** Queues one `Response` per call; a call past the end of the queue throws loudly instead of
 *  silently returning `undefined`, so an unexpected extra HTTP call fails the test that triggered it. */
function queueFetch(...responses: Response[]): typeof fetch {
  let i = 0;
  return vi.fn(async () => {
    const res = responses[i];
    i += 1;
    if (!res) throw new Error(`unexpected extra fetch call (#${i})`);
    return res;
  }) as unknown as typeof fetch;
}

function client(fetchImpl: typeof fetch, extra: Partial<NotionClientOptions> = {}): NotionClient {
  return new NotionClient({
    token: 'secret_test_token',
    apiBase: 'https://notion.test',
    fetchImpl,
    requestsPerSecond: 1000, // fast tests - the rate limiter itself isn't under test here
    ...extra,
  });
}

describe('token + base URL resolution', () => {
  it('CEZ_NOTION_TOKEN wins, then NOTION_TOKEN, then NOTION_API_KEY', () => {
    expect(resolveNotionToken({ CEZ_NOTION_TOKEN: 'a', NOTION_TOKEN: 'b', NOTION_API_KEY: 'c' })).toBe('a');
    expect(resolveNotionToken({ NOTION_TOKEN: 'b', NOTION_API_KEY: 'c' })).toBe('b');
    expect(resolveNotionToken({ NOTION_API_KEY: 'c' })).toBe('c');
    expect(resolveNotionToken({})).toBeUndefined();
  });

  it('defaults CEZ_NOTION_API_BASE to https://api.notion.com and trims a trailing slash', () => {
    expect(resolveNotionApiBase({})).toBe('https://api.notion.com');
    expect(resolveNotionApiBase({ CEZ_NOTION_API_BASE: 'https://stub.test/' })).toBe('https://stub.test');
  });
});

describe('every request', () => {
  it('carries the pinned Notion-Version header and targets the configured base', async () => {
    const fetchImpl = queueFetch(jsonResponse(fixture('database-query-page-2')));
    await client(fetchImpl).queryDatabase('db-1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://notion.test/v1/databases/db-1/query');
    const headers = init.headers as Record<string, string>;
    expect(headers['Notion-Version']).toBe(NOTION_VERSION);
    expect(headers.Authorization).toBe('Bearer secret_test_token');
  });
});

describe('no token', () => {
  it('detect() resolves {available:false, reason} without ever touching the network, and never rejects', async () => {
    const fetchImpl = vi.fn();
    const result = await client(fetchImpl as unknown as typeof fetch, { token: undefined, env: {} }).detect();
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/CEZ_NOTION_TOKEN/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('detect()', () => {
  it('a 401 resolves {available:false, reason}, never throws', async () => {
    const fetchImpl = queueFetch(jsonResponse(fixture('error-unauthorized-401'), { status: 401 }));
    const result = await client(fetchImpl).detect();
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/token rejected/i);
  });

  it('a healthy token resolves {available:true}', async () => {
    const fetchImpl = queueFetch(jsonResponse({ object: 'user', id: 'bot-1' }));
    const result = await client(fetchImpl).detect();
    expect(result).toEqual({ available: true });
  });
});

describe('detectCached()', () => {
  it('returns null before any probe has ever run, without waiting on one', () => {
    // Zero queued responses on purpose: detectCached() still returns synchronously, and its own
    // fire-and-forget background revalidation (unawaited, `.catch`-guarded) never surfaces here.
    const c = client(queueFetch());
    expect(c.detectCached()).toBeNull();
  });

  it('once warm, serves the cached result WITHOUT itself making a further request', async () => {
    const fetchImpl = queueFetch(jsonResponse({ object: 'user', id: 'bot-1' }));
    const c = client(fetchImpl);
    await c.detect(); // warms the cache - the one queued response
    expect(c.detectCached()).toEqual({ available: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // reading the fresh cache spent no extra call
  });
});

describe('429 with Retry-After', () => {
  it('yields a backoff hint and complete:false', async () => {
    const fetchImpl = queueFetch(
      jsonResponse(fixture('error-rate-limited-429'), { status: 429, headers: { 'retry-after': '30' } }),
    );
    const result = await client(fetchImpl).queryDatabase('db-1');
    expect(result.complete).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.error?.status).toBe(429);
    expect(result.backoffHint?.retryAfterMs).toBe(30_000);
  });

  it('still signals a backoff (with no retryAfterMs) when Retry-After is absent', async () => {
    const fetchImpl = queueFetch(jsonResponse(fixture('error-rate-limited-429'), { status: 429 }));
    const result = await client(fetchImpl).queryDatabase('db-1');
    expect(result.complete).toBe(false);
    expect(result.backoffHint).toBeDefined();
    expect(result.backoffHint?.retryAfterMs).toBeUndefined();
  });
});

describe('pagination - the headline correctness requirement', () => {
  it('has_more:true with the call budget spent returns complete:false plus a non-null nextPageCursor, emitting only page 1', async () => {
    const fetchImpl = queueFetch(jsonResponse(fixture('database-query-page-1')));
    const result = await client(fetchImpl).queryDatabase('db-1', { callBudget: 1 });
    expect(result.complete).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.nextPageCursor).toBe('cursor-page-2');
    expect(result.results.map((r) => r.id)).toEqual(['page-a']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('an unbounded enumeration follows next_cursor to exhaustion and reports complete:true', async () => {
    const fetchImpl = queueFetch(jsonResponse(fixture('database-query-page-1')), jsonResponse(fixture('database-query-page-2')));
    const result = await client(fetchImpl).queryDatabase('db-1');
    expect(result.complete).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.nextPageCursor).toBeNull();
    expect(result.results.map((r) => r.id)).toEqual(['page-a', 'page-b']);
  });

  it('resuming from a persisted pageCursor re-emits zero page-1 documents (the NC-3 shape)', async () => {
    const tick1Fetch = queueFetch(jsonResponse(fixture('database-query-page-1')));
    const tick1 = await client(tick1Fetch).queryDatabase('db-1', { callBudget: 1 });
    expect(tick1.results.map((r) => r.id)).toEqual(['page-a']);

    const tick2Fetch = queueFetch(jsonResponse(fixture('database-query-page-2')));
    const tick2 = await client(tick2Fetch).queryDatabase('db-1', { cursor: tick1.nextPageCursor });
    expect(tick2.complete).toBe(true);
    expect(tick2.results.map((r) => r.id)).toEqual(['page-b']); // page 1 never re-fetched
  });

  it('a request failure mid-enumeration leaves the cursor unchanged, so a retry re-fetches the same page', async () => {
    const fetchImpl = queueFetch(jsonResponse(fixture('error-unauthorized-401'), { status: 401 }));
    const result = await client(fetchImpl).queryDatabase('db-1', { cursor: 'cursor-page-2' });
    expect(result.complete).toBe(false);
    expect(result.nextPageCursor).toBe('cursor-page-2');
    expect(result.error?.status).toBe(401);
  });

  it('the same pagination shape holds for block-children enumeration', async () => {
    const fetchImpl = queueFetch(jsonResponse(fixture('block-children-page1')));
    const result = await client(fetchImpl).listBlockChildren('page-a', { callBudget: 1 });
    expect(result.complete).toBe(false);
    expect(result.nextPageCursor).toBe('cursor-block-page-2');
    expect(result.results.map((b) => b.id)).toEqual(['block-1']);
  });

  it('block-children enumeration reaches exhaustion across two pages', async () => {
    const fetchImpl = queueFetch(jsonResponse(fixture('block-children-page1')), jsonResponse(fixture('block-children-page2')));
    const result = await client(fetchImpl).listBlockChildren('page-a');
    expect(result.complete).toBe(true);
    expect(result.results.map((b) => b.id)).toEqual(['block-1', 'block-2']);
  });
});

describe('fetchBlockTree', () => {
  it('recurses into has_children blocks under one shared call budget', async () => {
    const parentBlock = { object: 'block', id: 'parent-1', type: 'toggle', has_children: true, archived: false, toggle: { rich_text: [] } };
    const childBlock = { object: 'block', id: 'nested-1', type: 'paragraph', has_children: false, archived: false, paragraph: { rich_text: [] } };
    const fetchImpl = queueFetch(
      jsonResponse({ object: 'list', results: [parentBlock], has_more: false, next_cursor: null }),
      jsonResponse({ object: 'list', results: [childBlock], has_more: false, next_cursor: null }),
    );
    const result = await client(fetchImpl).fetchBlockTree('root');
    expect(result.complete).toBe(true);
    expect(result.callsUsed).toBe(2);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]?.block.id).toBe('parent-1');
    expect(result.nodes[0]?.children.map((n) => n.block.id)).toEqual(['nested-1']);
  });

  it('never recurses into child_page or child_database - a linked database is a link, not its rows', async () => {
    const linked = { object: 'block', id: 'db-1', type: 'child_database', has_children: true, archived: false, child_database: { title: 'Tasks' } };
    const fetchImpl = queueFetch(jsonResponse({ object: 'list', results: [linked], has_more: false, next_cursor: null }));
    const result = await client(fetchImpl).fetchBlockTree('root');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.nodes[0]?.children).toEqual([]);
  });

  it('an error partway through the walk marks the whole tree incomplete and stops descending further', async () => {
    const first = { object: 'block', id: 'p1', type: 'paragraph', has_children: false, archived: false, paragraph: { rich_text: [] } };
    const second = { object: 'block', id: 'toggle-1', type: 'toggle', has_children: true, archived: false, toggle: { rich_text: [] } };
    const fetchImpl = queueFetch(
      jsonResponse({ object: 'list', results: [first, second], has_more: false, next_cursor: null }),
      jsonResponse(fixture('error-unauthorized-401'), { status: 401 }),
    );
    const result = await client(fetchImpl).fetchBlockTree('root');
    expect(result.complete).toBe(false);
    expect(result.error?.status).toBe(401);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // the second toggle's children, then stop
  });
});
