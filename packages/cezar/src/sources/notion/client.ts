import { z } from 'zod';

/**
 * `fetch` plus zod against `api.notion.com` (F2, W1.4). See
 * `.ai/specs/2026-08-06-external-source-connectors-notion.md` ("Notion's API, and the arithmetic
 * that decides the design") and `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md` (D7: no new
 * runtime dependency - native `fetch` only, same pairing already proven from a Cloudflare Worker
 * at `chat/domains/chatbots/worker/src/tools/report-issue.ts:76-77,361`).
 *
 * **The one correctness requirement everything here is arranged around is pagination.** A reader
 * that stops at page 1 does not error, it reports "nothing to do" - the recorded ~45-tick false
 * empty (spec TLDR). `complete` is `true` ONLY after Notion's `has_more` goes `false`; a stopped
 * enumeration (call budget spent, a request error) always reports `complete: false` and a resumable
 * `nextPageCursor`, never a silent truncation dressed up as completeness.
 *
 * **Not this module's job.** Persisting `pageCursor` / `backoffUntil` across ticks (W1.5's
 * `source-state.json`), interpreting `SourceChangePage` / building `MirroredDocument`s (W2.2's
 * `provider.ts`), and the sweep's retry/backoff schedule (W4.4's `sync.ts`) all live elsewhere.
 * This module reports what happened on ONE enumeration attempt and never retries or sleeps beyond
 * its own per-connection rate limiter.
 */

export const NOTION_VERSION = '2022-06-28';
export const DEFAULT_NOTION_API_BASE = 'https://api.notion.com';
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_REQUESTS_PER_SECOND = 2.5; // spec "Rate limiting, backoff and concurrency" - below
// Notion's ~3 req/s ceiling to leave headroom for the rest of the workspace's own traffic.
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DETECT_CACHE_MS = 60_000; // mirrors forge/github.ts's detectGithub(Cached) cache window

// ---- token + base URL resolution (Q7: environment only, never a schema field) ----------------

/** `CEZ_NOTION_TOKEN`, falling back to `NOTION_TOKEN` then `NOTION_API_KEY` (spec Q7). All three
 *  names match `SECRET_NAME_RE` (`core/secret-redaction.ts:28-29`), so a value that somehow reached
 *  a log line is redacted for free; none of the three lives in a schema, so `sources.json` /
 *  `source-state.json` can never carry it (NC-7, W1.5's job to assert on disk). */
export function resolveNotionToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.CEZ_NOTION_TOKEN || env.NOTION_TOKEN || env.NOTION_API_KEY;
  return value && value.length > 0 ? value : undefined;
}

/** `CEZ_NOTION_API_BASE`, defaulting to `https://api.notion.com` - overridable so the test suite
 *  can point every request at a local stub (no live network in any test). */
export function resolveNotionApiBase(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.CEZ_NOTION_API_BASE?.trim();
  return value && value.length > 0 ? value.replace(/\/+$/, '') : DEFAULT_NOTION_API_BASE;
}

// ---- raw Notion API shapes, validated at the boundary ------------------------------------------
// Permissive on purpose: a Notion block or page carries dozens of type-specific keys this module
// has no opinion about, so every schema below is `.passthrough()` and only pins the envelope
// fields the pagination/markdown/comments logic actually reads. An unrecognised block TYPE is
// handled by markdown.ts's catch-all (`lossy: ['unsupported']`), never rejected here.

const notionRichTextAnnotationsSchema = z
  .object({
    bold: z.boolean().default(false),
    italic: z.boolean().default(false),
    strikethrough: z.boolean().default(false),
    underline: z.boolean().default(false),
    code: z.boolean().default(false),
    color: z.string().default('default'),
  })
  .partial()
  .default({});

/** One rich-text span, as it appears inside any block's `rich_text` array (and inside a table
 *  cell). `mention` and `equation` spans still carry `plain_text` - Notion resolves both to their
 *  display text server-side - which is what lets markdown.ts preserve them as text (spec: "equation,
 *  mention: preserved as text, not as their rendered form"). */
export const notionRichTextSchema = z
  .object({
    type: z.string().optional(),
    plain_text: z.string().default(''),
    href: z.string().nullable().optional(),
    annotations: notionRichTextAnnotationsSchema,
  })
  .passthrough();
export type NotionRichText = z.infer<typeof notionRichTextSchema>;

/** One block, envelope-typed only. Every type-specific key (`paragraph`, `heading_1`, `image`, …)
 *  survives via `.passthrough()` and is read dynamically by markdown.ts, keyed off `type` itself. */
export const notionBlockSchema = z
  .object({
    object: z.literal('block').optional(),
    id: z.string(),
    type: z.string(),
    has_children: z.boolean().default(false),
    archived: z.boolean().default(false),
  })
  .passthrough();
export type NotionBlockObject = z.infer<typeof notionBlockSchema>;

/** One database row / page, envelope-typed only - `properties` stays `unknown` here; flattening a
 *  Notion property (select/date/multi_select/person/…) into the wire's `SourcePropertyValue` is
 *  W2.2's `provider.ts` concern, not this module's. */
export const notionPageSchema = z
  .object({
    object: z.literal('page').optional(),
    id: z.string(),
    url: z.string().optional(),
    last_edited_time: z.string(),
    archived: z.boolean().default(false),
    properties: z.record(z.string(), z.unknown()).default({}),
  })
  .passthrough();
export type NotionPageObject = z.infer<typeof notionPageSchema>;

const notionCommentAttachmentSchema = z.object({ type: z.string().default('unsupported') }).passthrough();

/** One comment, as `GET /v1/comments` returns it. `attachments` is NOT part of Notion's documented
 *  public Comments response today - kept optional/defaulted so a real response with no such key
 *  still parses, while a fixture (or a future API addition) can still exercise the "unreadable
 *  attachment" contract (spec Q17 / Edge Cases: "a comment with an unreadable image attachment
 *  produces `{type:'image', downloadable:false}` and is never dropped"). */
export const notionCommentSchema = z
  .object({
    object: z.literal('comment').optional(),
    id: z.string(),
    parent: z.record(z.string(), z.unknown()).optional(),
    discussion_id: z.string().optional(),
    created_time: z.string(),
    last_edited_time: z.string().optional(),
    created_by: z.object({ id: z.string() }).passthrough().optional(),
    rich_text: z.array(notionRichTextSchema).default([]),
    attachments: z.array(notionCommentAttachmentSchema).default([]),
  })
  .passthrough();
export type NotionRawComment = z.infer<typeof notionCommentSchema>;

const notionUserSchema = z.object({ object: z.literal('user').optional(), id: z.string() }).passthrough();

const notionQueryResponseSchema = z.object({
  object: z.literal('list').optional(),
  results: z.array(notionPageSchema),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
});

const notionBlockChildrenResponseSchema = z.object({
  object: z.literal('list').optional(),
  results: z.array(notionBlockSchema),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
});

const notionCommentsResponseSchema = z.object({
  object: z.literal('list').optional(),
  results: z.array(notionCommentSchema),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
});

// ---- request / pagination result shapes ---------------------------------------------------------

/** `status: 0` is this module's own sentinel for "never reached the network" (no token configured,
 *  or the `fetch` itself rejected) - never a real Notion HTTP status. */
export interface NotionApiError {
  status: number;
  message: string;
  /** Present only on a 429 that carried a `Retry-After` header. */
  retryAfterMs?: number;
}

export type NotionRequestResult<T> = { ok: true; data: T } | { ok: false; error: NotionApiError };

export interface NotionAvailability {
  available: boolean;
  reason?: string;
}

export interface NotionEnumerateOptions {
  /** Resume token from a prior `nextPageCursor`. Omitted or `null` starts from the beginning. */
  cursor?: string | null;
  /** Max HTTP calls this ONE enumeration may spend. Default unlimited - callers that must bound a
   *  tick (the sweep, W4.4) always pass one. */
  callBudget?: number;
  pageSize?: number;
}

/**
 * One exhaustive-or-bounded enumeration attempt. `complete` is the field the rest of the feature is
 * built around (spec "Pagination is a correctness requirement") - it is `true` if and only if
 * Notion's own `has_more` went `false` on the last page fetched here. Every other exit - the call
 * budget ran out (`truncated: true`), or a request failed (`error` set, `backoffHint` set on a 429)
 * - reports `complete: false` and a `nextPageCursor` that resumes exactly where this attempt
 * stopped, never re-emitting an already-seen page.
 */
export interface NotionEnumerationResult<T> {
  results: T[];
  complete: boolean;
  nextPageCursor: string | null;
  truncated: boolean;
  callsUsed: number;
  error?: NotionApiError;
  backoffHint?: { retryAfterMs?: number };
}

export interface NotionBlockNode {
  block: NotionBlockObject;
  children: NotionBlockNode[];
}

/** Same contract as `NotionEnumerationResult`, generalised to a whole block TREE: `complete` is
 *  `true` only when every `has_children` branch reached in the walk was itself fully enumerated. */
export interface NotionBlockTreeResult {
  nodes: NotionBlockNode[];
  complete: boolean;
  truncated: boolean;
  callsUsed: number;
  error?: NotionApiError;
  backoffHint?: { retryAfterMs?: number };
}

export interface NotionClientOptions {
  /** Explicit override; otherwise resolved from `env` via `resolveNotionToken`. */
  token?: string;
  /** Explicit override; otherwise resolved from `env` via `resolveNotionApiBase`. */
  apiBase?: string;
  /** Source for token/base-URL resolution when neither is given explicitly. Defaults to
   *  `process.env`; tests pass a plain object instead of mutating global env. */
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests - no live network in any test in this module. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Per-connection token-bucket rate, requests/second. Default 2.5 (spec: below Notion's ~3 req/s
   *  ceiling). Tests pass a high value so a multi-call case doesn't pay real wall-clock delay. */
  requestsPerSecond?: number;
  requestTimeoutMs?: number;
}

/** A friendly, never-thrown reason string - mirrors forge's "no gh, no remote, offline all return
 *  `{available:false, reason}`" (AGENTS.md). */
function describeError(error: NotionApiError): string {
  if (error.status === 401 || error.status === 403) {
    return `Notion token rejected (${error.status}) - check CEZ_NOTION_TOKEN`;
  }
  if (error.status === 429) return 'Notion API rate limited (429)';
  return error.message;
}

/** A simple token bucket: starts full (one burst up to the rate), refills continuously. Serializes
 *  a connection's own requests without a queue data structure - `take()` just waits its turn. */
class TokenBucket {
  private tokens: number;
  private lastRefillAt: number;

  constructor(
    private readonly ratePerSecond: number,
    private readonly now: () => number,
  ) {
    this.tokens = this.ratePerSecond;
    this.lastRefillAt = now();
  }

  async take(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = ((1 - this.tokens) / this.ratePerSecond) * 1000;
      await sleep(Math.max(waitMs, 1));
    }
  }

  private refill(): void {
    const now = this.now();
    const elapsedSeconds = (now - this.lastRefillAt) / 1000;
    if (elapsedSeconds <= 0) return;
    this.tokens = Math.min(this.ratePerSecond, this.tokens + elapsedSeconds * this.ratePerSecond);
    this.lastRefillAt = now;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toPage<T>(
  res: NotionRequestResult<{ results: T[]; has_more: boolean; next_cursor: string | null }>,
): NotionRequestResult<{ results: T[]; hasMore: boolean; nextCursor: string | null }> {
  if (!res.ok) return res;
  return { ok: true, data: { results: res.data.results, hasMore: res.data.has_more, nextCursor: res.data.next_cursor } };
}

/**
 * One Notion connection's HTTP client: auth, base URL, the pinned version header, the per-connection
 * rate limiter, and the three paginated read endpoints this feature needs (database query, block
 * children, comments). Never throws - every failure mode (no token, network error, 4xx, 5xx, a
 * response that fails its schema) resolves to `{ok: false, error}` or an availability/enumeration
 * result carrying `available: false` / `complete: false`, matching the forge driver's contract.
 */
export class NotionClient {
  private readonly token: string | undefined;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: () => number;
  private readonly requestTimeoutMs: number;
  private readonly bucket: TokenBucket;
  private availabilityCache: { at: number; result: NotionAvailability } | undefined;

  constructor(options: NotionClientOptions = {}) {
    const env = options.env ?? process.env;
    this.token = options.token ?? resolveNotionToken(env);
    this.apiBase = options.apiBase ?? resolveNotionApiBase(env);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.clock = options.now ?? Date.now;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.bucket = new TokenBucket(Math.max(0.1, options.requestsPerSecond ?? DEFAULT_REQUESTS_PER_SECOND), this.clock);
  }

  /** Probes the token against `GET /v1/users/me`. No token configured never touches the network.
   *  Never rejects - a 401/403, a network error, or an unreachable host all resolve to
   *  `{available:false, reason}` (spec Edge Cases: "No token" / "Revoked token"). */
  async detect(): Promise<NotionAvailability> {
    if (!this.token) {
      const result: NotionAvailability = {
        available: false,
        reason: 'no Notion token configured - set CEZ_NOTION_TOKEN (falls back to NOTION_TOKEN, NOTION_API_KEY)',
      };
      this.availabilityCache = { at: this.clock(), result };
      return result;
    }
    const res = await this.request('/v1/users/me', { method: 'GET' }, notionUserSchema);
    const result: NotionAvailability = res.ok ? { available: true } : { available: false, reason: describeError(res.error) };
    this.availabilityCache = { at: this.clock(), result };
    return result;
  }

  /** Non-blocking: serves the last-known probe (stale-while-revalidate) and fires a background
   *  refresh when the cache is stale, mirroring `forge/github.ts`'s `detectGithubCached` so a
   *  health/status read never pays a network round trip. `null` only before the first probe. */
  detectCached(): NotionAvailability | null {
    const cached = this.availabilityCache?.result ?? null;
    const fresh = this.availabilityCache !== undefined && this.clock() - this.availabilityCache.at < DETECT_CACHE_MS;
    if (!fresh) void this.detect().catch(() => {});
    return cached;
  }

  /** Enumerates `POST /v1/databases/:id/query` following `next_cursor` until `has_more` is `false`
   *  or `opts.callBudget` runs out. */
  async queryDatabase(databaseId: string, opts: NotionEnumerateOptions = {}): Promise<NotionEnumerationResult<NotionPageObject>> {
    return this.enumerate<NotionPageObject, NotionPageObject>(
      (cursor) =>
        this.request(
          `/v1/databases/${encodeURIComponent(databaseId)}/query`,
          {
            method: 'POST',
            body: JSON.stringify({
              page_size: opts.pageSize ?? DEFAULT_PAGE_SIZE,
              ...(cursor ? { start_cursor: cursor } : {}),
            }),
          },
          notionQueryResponseSchema,
        ).then(toPage),
      (raw) => raw,
      opts,
    );
  }

  /** Enumerates ONE level of `GET /v1/blocks/:id/children`. Recursing into `has_children` blocks is
   *  `fetchBlockTree`'s job - this method never recurses on its own. */
  async listBlockChildren(blockId: string, opts: NotionEnumerateOptions = {}): Promise<NotionEnumerationResult<NotionBlockObject>> {
    return this.enumerate<NotionBlockObject, NotionBlockObject>(
      (cursor) => {
        const params = new URLSearchParams({ page_size: String(opts.pageSize ?? DEFAULT_PAGE_SIZE) });
        if (cursor) params.set('start_cursor', cursor);
        return this.request(
          `/v1/blocks/${encodeURIComponent(blockId)}/children?${params.toString()}`,
          { method: 'GET' },
          notionBlockChildrenResponseSchema,
        ).then(toPage);
      },
      (raw) => raw,
      opts,
    );
  }

  /** Enumerates `GET /v1/comments?block_id=`. Raw shape only - normalisation (plain-text body,
   *  `downloadable: false` attachment marking) is `comments.ts`'s job. */
  async listComments(blockId: string, opts: NotionEnumerateOptions = {}): Promise<NotionEnumerationResult<NotionRawComment>> {
    return this.enumerate<NotionRawComment, NotionRawComment>(
      (cursor) => {
        const params = new URLSearchParams({ block_id: blockId, page_size: String(opts.pageSize ?? DEFAULT_PAGE_SIZE) });
        if (cursor) params.set('start_cursor', cursor);
        return this.request(`/v1/comments?${params.toString()}`, { method: 'GET' }, notionCommentsResponseSchema).then(toPage);
      },
      (raw) => raw,
      opts,
    );
  }

  /**
   * Recursively fetches a block and its full descendant tree, honouring ONE shared `callBudget`
   * across the whole walk (not per level) - a document with 40 nested list items must not spend 40x
   * the tick's budget just walking one page. `child_page` and `child_database` are never descended
   * into: a sub-page is a document of its own (page-tree collection walking, not block content), and
   * a linked database's rows are deliberately not mirrored (spec: "a link, not the rows").
   *
   * Resuming a PARTIALLY fetched tree across ticks is out of scope for phase 1 - a budget cutoff
   * mid-document means the whole document's body is re-fetched next time (the diff-before-fetch skip
   * in the sweep, W4.4, only applies once a document is unchanged). This is deliberately narrower
   * than the collection-level pagination `pageCursor` resumes: losing a partial document body to a
   * budget cutoff costs one re-fetch, never a false tombstone.
   */
  async fetchBlockTree(blockId: string, opts: NotionEnumerateOptions = {}): Promise<NotionBlockTreeResult> {
    const callBudget = opts.callBudget ?? Number.POSITIVE_INFINITY;
    let callsUsed = 0;
    let complete = true;
    let truncated = false;
    let error: NotionApiError | undefined;
    let backoffHint: { retryAfterMs?: number } | undefined;

    const walk = async (id: string): Promise<NotionBlockNode[]> => {
      if (error) return [];
      if (callsUsed >= callBudget) {
        complete = false;
        truncated = true;
        return [];
      }
      const page = await this.listBlockChildren(id, { pageSize: opts.pageSize, callBudget: callBudget - callsUsed });
      callsUsed += page.callsUsed;
      if (page.error) {
        complete = false;
        error = page.error;
        backoffHint = page.backoffHint;
      } else if (!page.complete) {
        complete = false;
        truncated = true;
      }
      const nodes: NotionBlockNode[] = [];
      for (const block of page.results) {
        const shouldRecurse = block.has_children && block.type !== 'child_page' && block.type !== 'child_database';
        const children = shouldRecurse ? await walk(block.id) : [];
        nodes.push({ block, children });
      }
      return nodes;
    };

    const nodes = await walk(blockId);
    return {
      nodes,
      complete,
      truncated,
      callsUsed,
      ...(error ? { error } : {}),
      ...(backoffHint ? { backoffHint } : {}),
    };
  }

  /**
   * Drives one endpoint's pagination to exhaustion or until `opts.callBudget` is spent. The two
   * outcomes that matter (spec NC-1 / NC-3 shape, exercised directly by `client.test.ts` here rather
   * than through the sweep that eventually consumes it):
   *
   * - budget spent, `has_more` still true → `{complete: false, truncated: true, nextPageCursor:
   *   <the next unread page>}`.
   * - a request fails (401/403/429/5xx/network) → `{complete: false, error, nextPageCursor:
   *   <unchanged - the SAME page is retried next attempt>}`, and on a 429, `backoffHint` is set.
   *
   * `has_more: false` is the ONLY path that returns `complete: true`.
   */
  private async enumerate<TRaw, T>(
    fetchPage: (
      cursor: string | null,
    ) => Promise<NotionRequestResult<{ results: TRaw[]; hasMore: boolean; nextCursor: string | null }>>,
    map: (raw: TRaw) => T,
    opts: NotionEnumerateOptions,
  ): Promise<NotionEnumerationResult<T>> {
    const callBudget = opts.callBudget ?? Number.POSITIVE_INFINITY;
    let cursor = opts.cursor ?? null;
    const results: T[] = [];
    let callsUsed = 0;

    while (callsUsed < callBudget) {
      const page = await fetchPage(cursor);
      callsUsed += 1;
      if (!page.ok) {
        const backoffHint = page.error.status === 429 ? { retryAfterMs: page.error.retryAfterMs } : undefined;
        return {
          results,
          complete: false,
          nextPageCursor: cursor,
          truncated: false,
          callsUsed,
          error: page.error,
          ...(backoffHint ? { backoffHint } : {}),
        };
      }
      results.push(...page.data.results.map(map));
      cursor = page.data.nextCursor;
      if (!page.data.hasMore) {
        return { results, complete: true, nextPageCursor: null, truncated: false, callsUsed };
      }
    }
    return { results, complete: false, nextPageCursor: cursor, truncated: true, callsUsed };
  }

  /** One HTTP call: auth header, the pinned `Notion-Version`, the rate limiter, a timeout, and zod
   *  validation of the parsed body. Never throws. */
  private async request<T>(
    path: string,
    init: { method: 'GET' | 'POST'; body?: string },
    schema: z.ZodType<T>,
  ): Promise<NotionRequestResult<T>> {
    if (!this.token) {
      return { ok: false, error: { status: 0, message: 'no Notion token configured - set CEZ_NOTION_TOKEN' } };
    }
    await this.bucket.take();
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.apiBase}${path}`, {
        method: init.method,
        body: init.body,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Notion-Version': NOTION_VERSION,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (err) {
      return { ok: false, error: { status: 0, message: err instanceof Error ? err.message : String(err) } };
    }
    if (!res.ok) {
      const retryAfterHeader = res.headers.get('retry-after');
      const retryAfterSeconds = retryAfterHeader != null ? Number(retryAfterHeader) : NaN;
      const retryAfterMs = Number.isFinite(retryAfterSeconds) ? Math.max(0, retryAfterSeconds) * 1000 : undefined;
      let message = `Notion API responded ${res.status}`;
      try {
        const body: unknown = await res.json();
        if (body && typeof body === 'object' && 'message' in body && typeof (body as { message?: unknown }).message === 'string') {
          message = (body as { message: string }).message;
        }
      } catch {
        // The error body wasn't JSON - keep the generic message.
      }
      return { ok: false, error: { status: res.status, message, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) } };
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return { ok: false, error: { status: res.status, message: 'Notion API returned invalid JSON' } };
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      return { ok: false, error: { status: res.status, message: `unexpected Notion API shape: ${parsed.error.message}` } };
    }
    return { ok: true, data: parsed.data };
  }
}
