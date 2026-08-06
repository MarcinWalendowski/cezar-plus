import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { NotionClient, type NotionRawComment } from './client.ts';
import { listPageComments, normalizeComment } from './comments.ts';

/**
 * `comments.ts` - per-page comment listing, normalisation, unreadable-attachment recording (F2,
 * W1.4/1.6). See `.ai/specs/2026-08-06-external-source-connectors-notion.md` step 1.6: "a comment
 * with an image attachment produces `{type:'image', downloadable:false}` and is never dropped."
 */

const fixturesDir = fileURLToPath(new URL('./fixtures/', import.meta.url));

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(`${fixturesDir}${name}.json`, 'utf8'));
}

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { 'content-type': 'application/json' } });
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

describe('normalizeComment', () => {
  it('joins rich_text into a plain body and marks every attachment downloadable:false without dropping it', () => {
    const raw: NotionRawComment = {
      id: 'comment-1',
      created_time: '2026-08-03T09:00:00.000Z',
      created_by: { id: 'user-1' },
      rich_text: [
        { plain_text: 'Nice catch, ', annotations: {} },
        { plain_text: 'see the screenshot.', annotations: {} },
      ],
      attachments: [{ type: 'image' }],
    };
    expect(normalizeComment(raw)).toEqual({
      externalId: 'comment-1',
      author: 'user-1',
      body: 'Nice catch, see the screenshot.',
      createdAt: '2026-08-03T09:00:00.000Z',
      attachments: [{ type: 'image', downloadable: false }],
    });
  });

  it('omits author when created_by is absent, rather than fabricating one', () => {
    const raw: NotionRawComment = { id: 'c2', created_time: '2026-08-03T09:00:00.000Z', rich_text: [], attachments: [] };
    expect(normalizeComment(raw).author).toBeUndefined();
  });

  it('a comment with no attachments normalises to an empty array, not an omitted field', () => {
    const raw: NotionRawComment = { id: 'c3', created_time: '2026-08-03T09:00:00.000Z', rich_text: [], attachments: [] };
    expect(normalizeComment(raw).attachments).toEqual([]);
  });
});

describe('listPageComments', () => {
  it('fetches and normalises a page of comments, never dropping an unreadable attachment', async () => {
    const fetchImpl = queueFetch(jsonResponse(fixture('comments-page1')));
    const client = new NotionClient({ token: 't', apiBase: 'https://notion.test', fetchImpl, requestsPerSecond: 1000 });
    const result = await listPageComments(client, 'block-1');
    expect(result.complete).toBe(true);
    expect(result.comments).toHaveLength(2);
    expect(result.comments[0]).toMatchObject({
      externalId: 'comment-1',
      body: 'Nice catch, see the attached screenshot.',
      attachments: [{ type: 'image', downloadable: false }],
    });
    expect(result.comments[1]).toMatchObject({ externalId: 'comment-2', attachments: [] });
  });

  it('propagates the pagination contract: a call-budget cutoff reports complete:false with a resumable cursor', async () => {
    const fetchImpl = queueFetch(
      jsonResponse({
        object: 'list',
        results: [{ object: 'comment', id: 'c1', created_time: '2026-08-03T09:00:00.000Z', rich_text: [] }],
        has_more: true,
        next_cursor: 'cursor-2',
      }),
    );
    const client = new NotionClient({ token: 't', apiBase: 'https://notion.test', fetchImpl, requestsPerSecond: 1000 });
    const result = await listPageComments(client, 'block-1', { callBudget: 1 });
    expect(result.complete).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.nextPageCursor).toBe('cursor-2');
  });

  it('a 401 mid-listing reports complete:false with an error, never throws', async () => {
    const fetchImpl = queueFetch(jsonResponse(fixture('error-unauthorized-401'), { status: 401 }));
    const client = new NotionClient({ token: 't', apiBase: 'https://notion.test', fetchImpl, requestsPerSecond: 1000 });
    const result = await listPageComments(client, 'block-1');
    expect(result.complete).toBe(false);
    expect(result.error?.status).toBe(401);
    expect(result.comments).toEqual([]);
  });
});
