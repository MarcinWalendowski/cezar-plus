import type { SourceLossyKind } from '@loki-labs/better-cezar-contract';
import { notionRichTextSchema, type NotionBlockNode, type NotionBlockObject, type NotionRichText } from './client.ts';

/**
 * Notion block tree → Markdown (F2, W1.4). See
 * `.ai/specs/2026-08-06-external-source-connectors-notion.md` ("Block to Markdown, and the honest
 * lossiness contract"). Pure - no network, no filesystem: everything here is a function of a
 * `NotionBlockNode[]` already fetched by `client.ts`'s `fetchBlockTree`.
 *
 * **Lossless** (no `lossy[]` entry): paragraphs, H1–H3, bulleted/numbered lists, to-dos, quotes,
 * dividers, fenced code with language, inline code/bold/italic/strikethrough/links, simple tables.
 * Underline has no lossless class of its own here - it renders as inline `<u>` HTML rather than
 * being silently dropped or added as a new, unlisted lossy kind.
 *
 * **Lossy**, every kind named once in `lossy[]` (a de-duplicated SET, never a per-occurrence
 * count) and NEVER dropped without a visible placeholder in the body: image/file/video/pdf/audio
 * (the signed URL expires in ~1h and is never stored - spec Q16), embed/bookmark (reduced to link
 * + title), synced_block (a reference to another block renders a pointer, never a duplicate of the
 * original's content), column_list (flattened into document order), toggle (heading + nested
 * content, collapse state lost), child_database (a link, not the rows - spec: mirroring nested rows
 * would silently double-count against `maxDocuments`), equation/mention (kept as their already-
 * resolved `plain_text`, not their rendered form), and `unsupported` - the catch-all for any block
 * type not named above (e.g. `callout`, `link_to_page`, `table_of_contents`), so a block type Notion
 * adds later is recorded rather than silently vanishing.
 */

export interface BlocksToMarkdownResult {
  body: string;
  lossy: SourceLossyKind[];
}

export function blocksToMarkdown(nodes: NotionBlockNode[]): BlocksToMarkdownResult {
  const lossy = new Set<SourceLossyKind>();
  const lines = renderNodes(nodes, 0, lossy);
  const body = `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
  return { body, lossy: [...lossy] };
}

/** One H2-bounded section of a split page - see `splitOnH2`. */
export interface NotionSection {
  /** `<pageId>` for the leading section (before the first H2, or the whole page when it wasn't
   *  split at all), `<pageId>#<headingBlockId>` otherwise - stable across a re-parse because it is
   *  keyed on Notion's own block id, never a computed position (spec Q12 / NC-5's identity rule,
   *  applied here to sections the same way it applies to whole documents). */
  externalId: string;
  headingBlockId: string | null;
  title: string;
  body: string;
  lossy: SourceLossyKind[];
}

export interface SplitOnH2Result {
  sections: NotionSection[];
  /** `false` means `sections` holds exactly one entry: the whole page, unsplit. */
  wasSplit: boolean;
}

/**
 * Splits a page's block tree on top-level `heading_2` boundaries when its rendered Markdown exceeds
 * `maxBodyBytes` - the 783 KB Knowledge page case (spec Research). Only ever consulted when the
 * whole-page render is over the cap; a page under the cap always comes back `wasSplit: false` with
 * one section. Whether an individual RESULTING section is still over the cap (and therefore the
 * PARENT should be marked `state: 'truncated'`) is the caller's call (W2.2) - this function only
 * performs the mechanical split.
 */
export function splitOnH2(pageId: string, nodes: NotionBlockNode[], maxBodyBytes: number, pageTitle = 'Untitled'): SplitOnH2Result {
  const whole = blocksToMarkdown(nodes);
  if (byteLength(whole.body) <= maxBodyBytes) {
    return { sections: [{ externalId: pageId, headingBlockId: null, title: pageTitle, body: whole.body, lossy: whole.lossy }], wasSplit: false };
  }

  const groups: Array<{ headingBlockId: string | null; title: string; nodes: NotionBlockNode[] }> = [
    { headingBlockId: null, title: pageTitle, nodes: [] },
  ];
  for (const node of nodes) {
    if (node.block.type === 'heading_2') {
      const title = plainTextOf(getRichText(node.block, 'heading_2')) || 'Untitled section';
      groups.push({ headingBlockId: node.block.id, title, nodes: [node] });
      continue;
    }
    groups[groups.length - 1]!.nodes.push(node);
  }

  const sections = groups
    .filter((group) => group.nodes.length > 0)
    .map((group): NotionSection => {
      const rendered = blocksToMarkdown(group.nodes);
      return {
        externalId: group.headingBlockId ? `${pageId}#${group.headingBlockId}` : pageId,
        headingBlockId: group.headingBlockId,
        title: group.title,
        body: rendered.body,
        lossy: rendered.lossy,
      };
    });

  return { sections, wasSplit: true };
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

// ---- block rendering ----------------------------------------------------------------------------

const INDENT = '  ';

function renderNodes(nodes: NotionBlockNode[], depth: number, lossy: Set<SourceLossyKind>): string[] {
  const out: string[] = [];
  let numberedIndex = 0;
  let prevWasNumbered = false;
  for (const node of nodes) {
    const isNumbered = node.block.type === 'numbered_list_item';
    numberedIndex = isNumbered ? (prevWasNumbered ? numberedIndex + 1 : 1) : 0;
    prevWasNumbered = isNumbered;
    out.push(...renderNode(node, depth, lossy, numberedIndex));
  }
  return out;
}

function renderNode(node: NotionBlockNode, depth: number, lossy: Set<SourceLossyKind>, numberedIndex: number): string[] {
  const { block, children } = node;
  const pad = INDENT.repeat(depth);

  switch (block.type) {
    case 'paragraph': {
      const text = renderRichText(getRichText(block, 'paragraph'), lossy);
      return [...(text ? [pad + text, ''] : []), ...renderNodes(children, depth, lossy)];
    }
    case 'heading_1':
    case 'heading_2':
    case 'heading_3': {
      const level = Number(block.type.slice(-1));
      const text = renderRichText(getRichText(block, block.type), lossy);
      return [pad + '#'.repeat(level) + ' ' + text, '', ...renderNodes(children, depth, lossy)];
    }
    case 'bulleted_list_item': {
      const text = renderRichText(getRichText(block, 'bulleted_list_item'), lossy);
      return [pad + '- ' + text, ...renderNodes(children, depth + 1, lossy)];
    }
    case 'numbered_list_item': {
      const text = renderRichText(getRichText(block, 'numbered_list_item'), lossy);
      return [pad + `${numberedIndex}. ` + text, ...renderNodes(children, depth + 1, lossy)];
    }
    case 'to_do': {
      const obj = getTypedObject(block, 'to_do');
      const checked = obj?.checked === true;
      const text = renderRichText(asRichTextArray(obj?.rich_text), lossy);
      return [pad + `- [${checked ? 'x' : ' '}] ` + text, ...renderNodes(children, depth + 1, lossy)];
    }
    case 'quote': {
      const text = renderRichText(getRichText(block, 'quote'), lossy);
      const quoted = (text || ' ').split('\n').map((line) => `${pad}> ${line}`);
      return [...quoted, '', ...renderNodes(children, depth, lossy)];
    }
    case 'divider':
      return [pad + '---', ''];
    case 'code': {
      const obj = getTypedObject(block, 'code');
      const rawLanguage = obj?.language;
      const language = typeof rawLanguage === 'string' ? rawLanguage : '';
      const text = plainTextOf(asRichTextArray(obj?.rich_text));
      return [pad + '```' + language, text, pad + '```', ''];
    }
    case 'table': {
      const rows = children.filter((child) => child.block.type === 'table_row');
      return [...renderTable(rows, lossy), ''];
    }
    case 'table_row':
      return []; // rendered by the parent `table` case; unreachable outside one
    case 'image':
    case 'file':
    case 'video':
    case 'pdf':
    case 'audio': {
      lossy.add(block.type as SourceLossyKind);
      return [pad + renderAttachmentPlaceholder(block, lossy), ''];
    }
    case 'embed':
    case 'bookmark': {
      lossy.add(block.type as SourceLossyKind);
      return [pad + renderLinkLike(block, lossy), ''];
    }
    case 'synced_block': {
      lossy.add('synced_block');
      const obj = getTypedObject(block, 'synced_block');
      // A reference (`synced_from` present) is a POINTER to another block, not a second copy of its
      // content - rendering it would mirror the same text across every page that references it.
      if (obj?.synced_from != null) return [pad + '*(synced content - see the original block)*', ''];
      return renderNodes(children, depth, lossy);
    }
    case 'column_list': {
      lossy.add('column_list');
      // Flattened into document order (spec): each column's children, in the array order Notion
      // returned them, with the column grouping itself discarded.
      const flattened = children.flatMap((column) => column.children);
      return renderNodes(flattened, depth, lossy);
    }
    case 'column':
      return renderNodes(children, depth, lossy); // reachable only if encountered outside a column_list
    case 'toggle': {
      lossy.add('toggle');
      const text = renderRichText(getRichText(block, 'toggle'), lossy);
      return [pad + `**${text}**`, '', ...renderNodes(children, depth, lossy)];
    }
    case 'child_database': {
      lossy.add('child_database');
      const obj = getTypedObject(block, 'child_database');
      const rawTitle = obj?.title;
      const title = typeof rawTitle === 'string' && rawTitle.length > 0 ? rawTitle : 'Untitled database';
      return [pad + `*[linked database: ${title} - rows not mirrored]*`, ''];
    }
    case 'equation': {
      lossy.add('equation');
      const obj = getTypedObject(block, 'equation');
      const rawExpression = obj?.expression;
      const expression = typeof rawExpression === 'string' ? rawExpression : '';
      return [pad + '`' + expression + '`', ''];
    }
    default:
      lossy.add('unsupported');
      return [pad + `*[unsupported block: ${block.type}]*`, ''];
  }
}

/**
 * Every row, including the first, is always shown - Markdown tables require a syntactic header
 * row, so the first row fills that slot regardless of Notion's own `has_column_header` (which this
 * function deliberately ignores): when Notion's table really has no header, row 1 renders bold
 * instead of plain, but no cell content is lost or duplicated either way.
 */
function renderTable(rows: NotionBlockNode[], lossy: Set<SourceLossyKind>): string[] {
  const rendered = rows.map((row) => {
    const obj = getTypedObject(row.block, 'table_row');
    const rawCells = obj?.cells;
    const cells = Array.isArray(rawCells) ? rawCells : [];
    return cells.map((cell) => renderRichText(asRichTextArray(cell), lossy).replace(/\|/g, '\\|'));
  });
  if (rendered.length === 0) return [];
  const width = Math.max(...rendered.map((row) => row.length));
  const pad = (row: string[]): string[] => [...row, ...Array<string>(Math.max(0, width - row.length)).fill('')];
  const lines = [`| ${pad(rendered[0]!).join(' | ')} |`, `| ${Array<string>(width).fill('---').join(' | ')} |`];
  for (const row of rendered.slice(1)) lines.push(`| ${pad(row).join(' | ')} |`);
  return lines;
}

function renderAttachmentPlaceholder(block: NotionBlockObject, lossy: Set<SourceLossyKind>): string {
  const obj = getTypedObject(block, block.type) ?? {};
  const caption = renderRichText(asRichTextArray(obj.caption), lossy);
  const label = `1 ${block.type} attachment not mirrored (block ${block.id})`;
  return caption ? `*[${label} - ${caption}]*` : `*[${label}]*`;
}

function renderLinkLike(block: NotionBlockObject, lossy: Set<SourceLossyKind>): string {
  const obj = getTypedObject(block, block.type) ?? {};
  const url = typeof obj.url === 'string' ? obj.url : '';
  const caption = renderRichText(asRichTextArray(obj.caption), lossy);
  const label = caption || url || block.type;
  return url ? `[${label}](${url})` : `*[${block.type}: no URL]*`;
}

// ---- rich text --------------------------------------------------------------------------------

function getTypedObject(block: NotionBlockObject, key: string): Record<string, unknown> | undefined {
  const raw = (block as Record<string, unknown>)[key];
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined;
}

function asRichTextArray(value: unknown): NotionRichText[] {
  if (!Array.isArray(value)) return [];
  const out: NotionRichText[] = [];
  for (const item of value) {
    const parsed = notionRichTextSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

function getRichText(block: NotionBlockObject, key: string): NotionRichText[] {
  return asRichTextArray(getTypedObject(block, key)?.rich_text);
}

function plainTextOf(items: NotionRichText[]): string {
  return items.map((item) => item.plain_text ?? '').join('');
}

function renderRichText(items: NotionRichText[], lossy: Set<SourceLossyKind>): string {
  return items.map((item) => renderRichTextItem(item, lossy)).join('');
}

function renderRichTextItem(item: NotionRichText, lossy: Set<SourceLossyKind>): string {
  if (item.type === 'mention') lossy.add('mention');
  if (item.type === 'equation') lossy.add('equation');
  let text = item.plain_text ?? '';
  const a = item.annotations ?? {};
  // Inline code wins outright: a backtick span doesn't nest cleanly with emphasis markup, and
  // Notion itself renders code as visually exclusive of bold/italic within one span.
  if (a.code) return '`' + text + '`';
  if (a.strikethrough) text = `~~${text}~~`;
  if (a.italic) text = `*${text}*`;
  if (a.bold) text = `**${text}**`;
  if (a.underline) text = `<u>${text}</u>`;
  if (item.href) text = `[${text}](${item.href})`;
  return text;
}
