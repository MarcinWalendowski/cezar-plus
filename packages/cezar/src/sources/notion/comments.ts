import type { SourceCommentAttachment } from '@open-mercato/cezar-contract';
import type { NotionApiError, NotionClient, NotionEnumerateOptions, NotionRawComment } from './client.ts';

/**
 * Per-page comment listing and normalisation (F2, W1.4). See
 * `.ai/specs/2026-08-06-external-source-connectors-notion.md` ("Comments", Q17, Edge Cases).
 *
 * Comments are mirrored to a SEPARATE append-only stream (`source-comments.ndjson`, W1.5), never
 * written into a document's body - an out-of-band reply would otherwise change the local bytes and
 * manufacture a conflict on a document nobody edited (spec Q17). This module owns only the
 * client.ts → normalised-shape step; the NDJSON stream, the per-tick cap, and the oldest-swept-first
 * ordering across documents are the sweep's job (W4.4).
 *
 * Attachments are never fetched in phase 1 (spec Q16): every attachment this module sees is
 * reported `downloadable: false` and kept, never dropped silently - the exact contract Edge Cases
 * states for "a comment with an unreadable image attachment".
 */

export interface NormalizedComment {
  externalId: string;
  /** The commenter's Notion user id - resolving it to a display name would cost a separate
   *  `/v1/users/:id` call this feature doesn't budget for, so the id is what's kept. */
  author?: string;
  body: string;
  createdAt: string;
  attachments: SourceCommentAttachment[];
}

export function normalizeComment(raw: NotionRawComment): NormalizedComment {
  return {
    externalId: raw.id,
    ...(raw.created_by?.id ? { author: raw.created_by.id } : {}),
    body: raw.rich_text.map((item) => item.plain_text ?? '').join(''),
    createdAt: raw.created_time,
    attachments: raw.attachments.map((attachment) => ({ type: attachment.type, downloadable: false })),
  };
}

export interface ListPageCommentsResult {
  comments: NormalizedComment[];
  complete: boolean;
  nextPageCursor: string | null;
  truncated: boolean;
  error?: NotionApiError;
  backoffHint?: { retryAfterMs?: number };
}

/** One page's worth (or the whole thread, until `opts.callBudget` runs out) of comments on
 *  `blockId`, normalised. Propagates `client.listComments`'s pagination contract unchanged -
 *  `complete`/`truncated`/`error`/`backoffHint` mean exactly what they mean there. */
export async function listPageComments(
  client: NotionClient,
  blockId: string,
  opts: NotionEnumerateOptions = {},
): Promise<ListPageCommentsResult> {
  const page = await client.listComments(blockId, opts);
  return {
    comments: page.results.map(normalizeComment),
    complete: page.complete,
    nextPageCursor: page.nextPageCursor,
    truncated: page.truncated,
    ...(page.error ? { error: page.error } : {}),
    ...(page.backoffHint ? { backoffHint: page.backoffHint } : {}),
  };
}
