import { createHash } from 'node:crypto';
import type { SourcePropertyValue } from '@loki-labs/better-cezar-contract';
import type { SourceCollectionRef, SourceConnection } from '../types.ts';
import type {
  SourceAvailability,
  SourceCapabilities,
  SourceChange,
  SourceChangePage,
  SourceCollection,
  SourceCommentPage,
  SourceDocument,
  SourceDocumentPage,
  SourceDocumentRef,
  SourceKind,
  SourceListOptions,
  SourcePollOptions,
  SourceProvider,
  SourceProviderDeps,
  SourceWatermark,
} from '../provider-types.ts';
import { NotionClient, type NotionBlockNode, type NotionBlockObject, type NotionPageObject } from './client.ts';
import { listPageComments } from './comments.ts';
import { blocksToMarkdown, splitOnH2, type NotionSection } from './markdown.ts';

/**
 * The Notion `SourceProvider` adapter (F2, W2.2). See
 * `.ai/specs/2026-08-06-external-source-connectors-notion.md` phase "2.3" and
 * `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md` D1..D25. Pure composition over W1.4's
 * `client.ts` / `markdown.ts` / `comments.ts` — no HTTP call is issued directly by this file, and
 * no test here performs live network I/O (every `NotionSourceProvider` below is either constructed
 * with an injected `fetchImpl` or driven through `detect`/`pollChanges`'s own never-throw contract).
 *
 * **`capabilities.push` is `false`** (spec Q9: write-back is declared, unused in phase 1) —
 * `pushDocument` is simply not implemented, matching the interface's optional method.
 *
 * **Two collection kinds, two different costs.** `database` polling is cheap: `queryDatabase`
 * returns row metadata (title/properties/`last_edited_time`) with no body fetch, so
 * `remoteVersion` is Notion's own etag and the sweep's diff-before-fetch skip (spec step 5) is
 * fully effective. `page-tree` walking has no such cheap metadata call available on `client.ts` —
 * discovering child pages already means walking blocks, and Notion's block envelope carries no
 * reliable page-level `last_edited_time` this module can lean on — so a page-tree document's
 * `remoteVersion` here is a sha256 of its OWN rendered body instead of a server etag. This means
 * page-tree polling pays a body-fetch cost every enumeration, unlike `database` polling; the
 * corpus this is built for (five meeting notes plus one Knowledge page, per the spec's Research
 * section) is small enough that this is a deliberate, documented cost rather than a defect. A
 * cheap per-page metadata endpoint (`GET /v1/pages/:id`) on `client.ts` would remove it, and is
 * explicitly out of this file's scope (W1.4 owns `client.ts`).
 *
 * **Not implemented here, deliberately deferred:** the meeting-notes transcript/summary split and
 * citation-footnote rewriting (spec "Meeting notes, the motivating case") — that is a
 * document-authoring transform over already-mirrored bytes, which reads as sync-engine territory
 * (W4.4's `sync.ts`), not provider territory. This provider returns one page (or one H2 section)
 * per discovered document and nothing more.
 *
 * **`listCollections()` does not browse the remote for NEW collections.** `client.ts` exposes no
 * Notion search/discovery endpoint, so this method reflects the connection's OWN configured
 * `collections[]` rather than genuinely discovering ones the user hasn't added yet — a real gap
 * against the wire route's "browse the remote" framing, flagged in this package's implementation
 * report rather than worked around with an invented call.
 */

export const NOTION_SOURCE_KIND: SourceKind = 'notion';

export interface NotionSourceProviderOptions extends SourceProviderDeps {
  /** Explicit override; otherwise resolved from `env` (spec Q7: `CEZ_NOTION_TOKEN`, falling back
   *  to `NOTION_TOKEN`, `NOTION_API_KEY`). */
  token?: string;
  apiBase?: string;
  /** Injectable for tests — no live network in any test in this module. */
  fetchImpl?: typeof fetch;
  requestsPerSecond?: number;
  requestTimeoutMs?: number;
}

export class NotionSourceProvider implements SourceProvider {
  readonly kind = NOTION_SOURCE_KIND;
  readonly capabilities: SourceCapabilities = { list: true, fetch: true, poll: true, push: false, comments: true };

  private readonly client: NotionClient;

  constructor(
    private readonly connection: SourceConnection,
    options: NotionSourceProviderOptions = {},
  ) {
    this.client = new NotionClient({
      token: options.token,
      apiBase: options.apiBase,
      env: options.env,
      fetchImpl: options.fetchImpl,
      now: options.now,
      requestsPerSecond: options.requestsPerSecond,
      requestTimeoutMs: options.requestTimeoutMs,
    });
  }

  async detect(): Promise<SourceAvailability> {
    return this.client.detect();
  }

  detectCached(): SourceAvailability | null {
    return this.client.detectCached();
  }

  async listCollections(): Promise<SourceCollection[]> {
    return this.connection.collections.map((collection) => ({
      externalId: collection.externalId,
      collectionKind: collection.collectionKind,
      ...(collection.label ? { label: collection.label } : {}),
    }));
  }

  async listDocuments(opts: SourceListOptions): Promise<SourceDocumentPage> {
    const collection = this.findCollection(opts.collectionExternalId);
    if (!collection) return { documents: [], nextPageCursor: null, complete: true, truncated: false };
    return collection.collectionKind === 'database'
      ? this.listDatabaseDocuments(collection, opts)
      : this.listPageTreeDocuments(collection, opts);
  }

  async pollChanges(since: SourceWatermark | null, opts: SourcePollOptions): Promise<SourceChangePage> {
    const collection = this.findCollection(opts.collectionExternalId);
    if (!collection) return { changes: [], watermark: since, nextPageCursor: null, complete: true, truncated: false };
    return collection.collectionKind === 'database'
      ? this.pollDatabase(collection, since, opts)
      : this.pollPageTree(collection, since, opts);
  }

  /** Never throws (matches the forge/client convention): a fetch failure or an unresolvable
   *  section both come back `null` - the sweep just retries next tick. There is no richer error
   *  slot on this interface to carry a reason through. */
  async fetchDocument(ref: SourceDocumentRef): Promise<SourceDocument | null> {
    const collection = this.findCollection(ref.collectionExternalId);
    const splitOnHeading = collection?.splitOnHeading ?? 'h2';
    const maxBodyBytes = this.connection.maxBodyBytes;
    const pageId = basePageId(ref.externalId);
    const headingBlockId = sectionHeadingId(ref.externalId);

    const tree = await this.client.fetchBlockTree(pageId);
    if (tree.error) return null;

    if (splitOnHeading === 'none') {
      if (headingBlockId) return null; // a section ref can't exist when splitting is configured off
      const rendered = blocksToMarkdown(tree.nodes);
      return { ...ref, body: rendered.body, lossy: rendered.lossy };
    }

    const split = splitOnH2(pageId, tree.nodes, maxBodyBytes, ref.title);
    const section = split.sections.find((candidate) => candidate.externalId === ref.externalId);
    if (!section) return null;
    // An H2-bounded piece is a 'section' regardless of whether it came from a page-tree page or an
    // oversized database row - only the LEADING (unsplit-boundary) piece keeps ref's own docType,
    // since that one still represents the whole original document.
    const docType = section.headingBlockId ? 'section' : ref.docType;
    return { ...ref, title: section.title, docType, body: section.body, lossy: section.lossy };
  }

  async listComments(ref: SourceDocumentRef, since?: string): Promise<SourceCommentPage> {
    const result = await listPageComments(this.client, basePageId(ref.externalId));
    const comments = since ? result.comments.filter((comment) => comment.createdAt > since) : result.comments;
    return { comments, nextPageCursor: result.nextPageCursor, complete: result.complete, truncated: result.truncated };
  }

  viewUrl(ref: SourceDocumentRef): string | null {
    return notionUrl(basePageId(ref.externalId));
  }

  // ---- database collections ------------------------------------------------------------------

  private async listDatabaseDocuments(collection: SourceCollectionRef, opts: SourceListOptions): Promise<SourceDocumentPage> {
    const page = await this.client.queryDatabase(collection.externalId, { cursor: opts.cursor ?? null, callBudget: opts.callBudget });
    if (page.error) return { documents: [], nextPageCursor: page.nextPageCursor, complete: false, truncated: page.truncated };
    const documents = page.results.filter((row) => !row.archived).map((row) => toDocumentRef(row, collection));
    return { documents, nextPageCursor: page.nextPageCursor, complete: page.complete, truncated: page.truncated };
  }

  private async pollDatabase(
    collection: SourceCollectionRef,
    since: SourceWatermark | null,
    opts: SourcePollOptions,
  ): Promise<SourceChangePage> {
    const page = await this.client.queryDatabase(collection.externalId, { cursor: opts.cursor ?? null, callBudget: opts.callBudget });
    if (page.error) return { changes: [], watermark: since, nextPageCursor: page.nextPageCursor, complete: false, truncated: page.truncated };

    let watermark = since;
    const changes: SourceChange[] = [];
    for (const row of page.results) {
      if (!isAfterWatermark(row.last_edited_time, row.id, since)) continue;
      watermark = maxWatermark(watermark, { timestamp: row.last_edited_time, tieBreaker: row.id });
      changes.push(
        row.archived
          ? { type: 'tombstone', externalId: row.id, collectionExternalId: collection.externalId }
          : { type: 'upsert', doc: toDocumentRef(row, collection) },
      );
    }
    return { changes, watermark, nextPageCursor: page.nextPageCursor, complete: page.complete, truncated: page.truncated };
  }

  // ---- page-tree collections -------------------------------------------------------------------

  private async listPageTreeDocuments(collection: SourceCollectionRef, opts: SourceListOptions): Promise<SourceDocumentPage> {
    const callBudget = opts.callBudget ?? Number.POSITIVE_INFINITY;
    const walk = await this.walkPageTree(collection, callBudget);
    const documents = walk.pages.filter((found) => !found.archived).flatMap((found) => found.sections.map((section) => sectionToRef(section, collection, found.id)));
    return { documents, nextPageCursor: null, complete: walk.complete, truncated: walk.truncated };
  }

  private async pollPageTree(
    collection: SourceCollectionRef,
    since: SourceWatermark | null,
    opts: SourcePollOptions,
  ): Promise<SourceChangePage> {
    const callBudget = opts.callBudget ?? Number.POSITIVE_INFINITY;
    const walk = await this.walkPageTree(collection, callBudget);
    // No reliable per-page etag is available for a page-tree walk (this file's own header) - every
    // currently-reachable, non-archived document is reported as an upsert candidate. The sink's own
    // content-hash comparison (`FileSourceSink.upsert`) is what keeps re-upserting an unchanged page
    // cheap: a byte-identical write is a no-op, not a second Notion call.
    const changes: SourceChange[] = walk.pages.flatMap<SourceChange>((found) =>
      found.archived
        ? found.sections.map((section) => ({
            type: 'tombstone' as const,
            externalId: section.externalId,
            collectionExternalId: collection.externalId,
          }))
        : found.sections.map((section) => ({ type: 'upsert' as const, doc: sectionToRef(section, collection, found.id) })),
    );
    return { changes, watermark: since, nextPageCursor: null, complete: walk.complete, truncated: walk.truncated };
  }

  /**
   * Discovers every page reachable from `collection.externalId` (itself included) up to
   * `collection.maxDepth`, then renders each one (splitting on H2 when the connection's
   * `maxBodyBytes` and the collection's `splitOnHeading` call for it).
   *
   * ONE `fetchBlockTree` call per page does double duty: `child_page` blocks Notion nests under a
   * page - at ANY depth in that page's own content, not only at the top level - are exactly the
   * pages one level further down the tree, and `fetchBlockTree` already returns them as leaf nodes
   * (it deliberately never recurses INTO a `child_page`, this file's own header). Reading them back
   * out of the tree already fetched to render THIS page's body is what avoids a second,
   * `listBlockChildren`-only call purely to rediscover the same blocks.
   */
  private async walkPageTree(
    collection: SourceCollectionRef,
    callBudget: number,
  ): Promise<{ pages: DiscoveredPage[]; complete: boolean; truncated: boolean }> {
    const maxDepth = collection.maxDepth ?? 3;
    let callsUsed = 0;
    let complete = true;
    let truncated = false;
    const pages: DiscoveredPage[] = [];

    const visit = async (id: string, title: string, depth: number, archived: boolean): Promise<void> => {
      if (archived) {
        // An archived page tombstones as one unit - its children are moot, and Notion still
        // reports them if asked, which would resurrect documents the sweep just deleted.
        pages.push({ id, sections: [{ externalId: id, headingBlockId: null, title, body: '', lossy: [] }], archived: true });
        return;
      }
      if (callsUsed >= callBudget) {
        complete = false;
        truncated = true;
        return;
      }
      const tree = await this.client.fetchBlockTree(id, { callBudget: callBudget - callsUsed });
      callsUsed += tree.callsUsed;
      if (tree.error) {
        complete = false;
        return;
      }
      if (!tree.complete) {
        complete = false;
        truncated = true;
      }
      const sections =
        collection.splitOnHeading === 'none'
          ? [{ externalId: id, headingBlockId: null, title, ...blocksToMarkdown(tree.nodes) }]
          : splitOnH2(id, tree.nodes, this.connection.maxBodyBytes, title).sections;
      pages.push({ id, sections, archived: false });

      if (depth >= maxDepth) return; // an intentional depth limit, never a truncation
      for (const childPage of findChildPages(tree.nodes)) {
        await visit(childPage.id, childPageTitle(childPage), depth + 1, childPage.archived);
      }
    };

    await visit(collection.externalId, collection.label ?? 'Untitled', 0, false);
    return { pages, complete, truncated };
  }

  private findCollection(externalId: string): SourceCollectionRef | undefined {
    return this.connection.collections.find((collection) => collection.externalId === externalId);
  }
}

export function createNotionSourceProvider(connection: SourceConnection, deps: SourceProviderDeps = {}): SourceProvider {
  return new NotionSourceProvider(connection, deps);
}

// ---- one discovered page-tree page, pre-flattened into its H2 sections -----------------------

interface DiscoveredPage {
  id: string;
  sections: NotionSection[];
  archived: boolean;
}

function sectionToRef(section: NotionSection, collection: SourceCollectionRef, pageId: string): SourceDocumentRef {
  return {
    externalId: section.externalId,
    collectionExternalId: collection.externalId,
    title: section.title,
    url: notionUrl(pageId),
    remoteVersion: hashBody(section.body),
    docType: section.headingBlockId ? 'section' : 'page',
    properties: {},
  };
}

function toDocumentRef(row: NotionPageObject, collection: SourceCollectionRef): SourceDocumentRef {
  return {
    externalId: row.id,
    collectionExternalId: collection.externalId,
    title: extractTitle(row.properties),
    url: row.url ?? notionUrl(row.id),
    remoteVersion: row.last_edited_time,
    docType: 'row',
    properties: flattenProperties(row.properties),
  };
}

function notionUrl(pageId: string): string {
  return `https://www.notion.so/${pageId.replace(/-/g, '')}`;
}

/** Strips a trailing `#<headingBlockId>` off a section's `externalId`, recovering the real Notion
 *  page/block id every client.ts call needs (spec Q12: `<pageId>#<headingBlockId>`). */
function basePageId(externalId: string): string {
  const index = externalId.indexOf('#');
  return index === -1 ? externalId : externalId.slice(0, index);
}

function sectionHeadingId(externalId: string): string | null {
  const index = externalId.indexOf('#');
  return index === -1 ? null : externalId.slice(index + 1);
}

function hashBody(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

function isAfterWatermark(timestamp: string, id: string, watermark: SourceWatermark | null): boolean {
  if (!watermark) return true;
  if (timestamp !== watermark.timestamp) return timestamp > watermark.timestamp;
  return id > watermark.tieBreaker;
}

function maxWatermark(current: SourceWatermark | null, candidate: SourceWatermark): SourceWatermark {
  if (!current) return candidate;
  if (candidate.timestamp !== current.timestamp) return candidate.timestamp > current.timestamp ? candidate : current;
  return candidate.tieBreaker > current.tieBreaker ? candidate : current;
}

/** Recursively collects every `child_page` block anywhere in an already-fetched tree - not only at
 *  the top level, since Notion allows a sub-page nested inside a toggle, a column, or any other
 *  container block. */
function findChildPages(nodes: NotionBlockNode[]): NotionBlockObject[] {
  const out: NotionBlockObject[] = [];
  for (const node of nodes) {
    if (node.block.type === 'child_page') out.push(node.block);
    out.push(...findChildPages(node.children));
  }
  return out;
}

function childPageTitle(block: NotionBlockObject): string {
  const obj = (block as Record<string, unknown>).child_page;
  if (obj && typeof obj === 'object' && typeof (obj as Record<string, unknown>).title === 'string') {
    return (obj as Record<string, unknown>).title as string;
  }
  return 'Untitled';
}

// ---- Notion property flattening (queryDatabase rows only - block-level rich text is markdown.ts's
// job). `row.properties` is `Record<string, unknown>` (client.ts's `notionPageSchema` deliberately
// leaves it unparsed - see that file's header), so every read here is defensive and falls back to
// `null` rather than throwing on a property shape this module has no opinion about. ------------

function extractTitle(properties: Record<string, unknown>): string {
  for (const value of Object.values(properties)) {
    if (isRecord(value) && value.type === 'title') {
      const text = plainTextOfUnknown(value.title);
      if (text) return text;
    }
  }
  return 'Untitled';
}

function flattenProperties(properties: Record<string, unknown>): Record<string, SourcePropertyValue> {
  const out: Record<string, SourcePropertyValue> = {};
  for (const [key, raw] of Object.entries(properties)) out[key] = flattenPropertyValue(raw);
  return out;
}

function flattenPropertyValue(raw: unknown): SourcePropertyValue {
  if (!isRecord(raw) || typeof raw.type !== 'string') return null;
  switch (raw.type) {
    case 'title':
    case 'rich_text':
      return plainTextOfUnknown(raw[raw.type]) || null;
    case 'select':
    case 'status':
      return selectName(raw[raw.type]);
    case 'multi_select':
      return multiSelectNames(raw.multi_select);
    case 'people':
      return peopleIds(raw.people);
    case 'relation':
      return relationIds(raw.relation);
    case 'date': {
      const date = raw.date;
      return isRecord(date) && typeof date.start === 'string' ? date.start : null;
    }
    case 'checkbox':
      return typeof raw.checkbox === 'boolean' ? raw.checkbox : null;
    case 'number':
      return typeof raw.number === 'number' ? raw.number : null;
    case 'url':
    case 'email':
    case 'phone_number':
      return typeof raw[raw.type] === 'string' ? (raw[raw.type] as string) : null;
    case 'created_time':
    case 'last_edited_time':
      return typeof raw[raw.type] === 'string' ? (raw[raw.type] as string) : null;
    case 'formula':
      return flattenFormula(raw.formula);
    default:
      return null;
  }
}

function flattenFormula(formula: unknown): SourcePropertyValue {
  if (!isRecord(formula)) return null;
  if (typeof formula.string === 'string') return formula.string;
  if (typeof formula.number === 'number') return formula.number;
  if (typeof formula.boolean === 'boolean') return formula.boolean;
  if (isRecord(formula.date) && typeof formula.date.start === 'string') return formula.date.start;
  return null;
}

function selectName(value: unknown): string | null {
  return isRecord(value) && typeof value.name === 'string' ? value.name : null;
}

function multiSelectNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => (isRecord(item) && typeof item.name === 'string' ? item.name : undefined)).filter((name): name is string => Boolean(name));
}

function peopleIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => (isRecord(item) && typeof item.id === 'string' ? item.id : undefined)).filter((id): id is string => Boolean(id));
}

function relationIds(value: unknown): string[] {
  return peopleIds(value);
}

function plainTextOfUnknown(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.map((item) => (isRecord(item) && typeof item.plain_text === 'string' ? item.plain_text : '')).join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}
