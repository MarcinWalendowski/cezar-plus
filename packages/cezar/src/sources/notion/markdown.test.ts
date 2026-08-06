import { describe, expect, it } from 'vitest';
import type { NotionBlockNode, NotionBlockObject, NotionRichText } from './client.ts';
import { blocksToMarkdown, splitOnH2 } from './markdown.ts';

/**
 * `markdown.ts` - pure block-tree-to-Markdown, no network. See
 * `.ai/specs/2026-08-06-external-source-connectors-notion.md` step 1.5 for the exact test list this
 * file implements, and the module's own doc comment for the lossless/lossy split.
 */

function rt(
  text: string,
  marks: Partial<{ bold: boolean; italic: boolean; strikethrough: boolean; code: boolean; underline: boolean; href: string }> = {},
): NotionRichText {
  const { href, ...annotations } = marks;
  return { type: 'text', plain_text: text, href: href ?? null, annotations };
}

function leaf(id: string, type: string, content: Record<string, unknown>): NotionBlockNode {
  return { block: { object: 'block', id, type, has_children: false, archived: false, [type]: content } as NotionBlockObject, children: [] };
}

function parent(id: string, type: string, content: Record<string, unknown>, children: NotionBlockNode[]): NotionBlockNode {
  return { block: { object: 'block', id, type, has_children: true, archived: false, [type]: content } as NotionBlockObject, children };
}

describe('blocksToMarkdown - golden round-trip', () => {
  it('renders every lossless block kind without adding a single lossy entry', () => {
    const nodes: NotionBlockNode[] = [
      leaf('h1', 'heading_1', { rich_text: [rt('Title')] }),
      leaf('h2', 'heading_2', { rich_text: [rt('Section')] }),
      leaf('h3', 'heading_3', { rich_text: [rt('Subsection')] }),
      leaf('p1', 'paragraph', { rich_text: [rt('Plain, '), rt('bold', { bold: true }), rt(' and '), rt('a link', { href: 'https://example.com' })] }),
      leaf('b1', 'bulleted_list_item', { rich_text: [rt('one')] }),
      leaf('b2', 'bulleted_list_item', { rich_text: [rt('two')] }),
      leaf('n1', 'numbered_list_item', { rich_text: [rt('first')] }),
      leaf('n2', 'numbered_list_item', { rich_text: [rt('second')] }),
      leaf('t1', 'to_do', { rich_text: [rt('done')], checked: true }),
      leaf('t2', 'to_do', { rich_text: [rt('not done')], checked: false }),
      leaf('q1', 'quote', { rich_text: [rt('a quote')] }),
      leaf('d1', 'divider', {}),
      leaf('c1', 'code', { rich_text: [rt('const x = 1;')], language: 'javascript' }),
      parent('tb1', 'table', { has_column_header: true }, [
        leaf('tr1', 'table_row', { cells: [[rt('Name')], [rt('Age')]] }),
        leaf('tr2', 'table_row', { cells: [[rt('Ada')], [rt('36')]] }),
      ]),
    ];

    const { body, lossy } = blocksToMarkdown(nodes);
    expect(lossy).toEqual([]);
    expect(body).toContain('# Title');
    expect(body).toContain('## Section');
    expect(body).toContain('### Subsection');
    expect(body).toContain('Plain, **bold** and [a link](https://example.com)');
    expect(body).toContain('- one');
    expect(body).toContain('- two');
    expect(body).toContain('1. first');
    expect(body).toContain('2. second');
    expect(body).toContain('- [x] done');
    expect(body).toContain('- [ ] not done');
    expect(body).toContain('> a quote');
    expect(body).toContain('---');
    expect(body).toContain('```javascript');
    expect(body).toContain('const x = 1;');
    expect(body).toContain('| Name | Age |');
    expect(body).toContain('| Ada | 36 |');
  });

  it('applies inline code, italic, strikethrough and underline marks', () => {
    const nodes: NotionBlockNode[] = [
      leaf('p1', 'paragraph', {
        rich_text: [
          rt('code', { code: true }),
          rt(' '),
          rt('em', { italic: true }),
          rt(' '),
          rt('gone', { strikethrough: true }),
          rt(' '),
          rt('under', { underline: true }),
        ],
      }),
    ];
    const { body, lossy } = blocksToMarkdown(nodes);
    expect(lossy).toEqual([]);
    expect(body).toContain('`code`');
    expect(body).toContain('*em*');
    expect(body).toContain('~~gone~~');
    expect(body).toContain('<u>under</u>');
  });

  it('renumbers a numbered-list run independent of the source labels', () => {
    const nodes: NotionBlockNode[] = [
      leaf('n1', 'numbered_list_item', { rich_text: [rt('a')] }),
      leaf('n2', 'numbered_list_item', { rich_text: [rt('b')] }),
      leaf('n3', 'numbered_list_item', { rich_text: [rt('c')] }),
    ];
    const { body } = blocksToMarkdown(nodes);
    expect(body).toContain('1. a');
    expect(body).toContain('2. b');
    expect(body).toContain('3. c');
  });
});

describe('blocksToMarkdown - the honest lossiness contract', () => {
  it('an image, a synced_block and a column_list yield lossy === [image, synced_block, column_list] and drop none of them silently', () => {
    const nodes: NotionBlockNode[] = [
      leaf('img1', 'image', { type: 'external', external: { url: 'https://example.com/x.png' }, caption: [rt('a screenshot')] }),
      parent('sync1', 'synced_block', { synced_from: null }, [leaf('sync1-p', 'paragraph', { rich_text: [rt('original synced content')] })]),
      parent('col1', 'column_list', {}, [
        parent('col1-a', 'column', {}, [leaf('col1-a-p', 'paragraph', { rich_text: [rt('left column')] })]),
        parent('col1-b', 'column', {}, [leaf('col1-b-p', 'paragraph', { rich_text: [rt('right column')] })]),
      ]),
    ];
    const { body, lossy } = blocksToMarkdown(nodes);
    expect(lossy).toEqual(['image', 'synced_block', 'column_list']);
    expect(body).toContain('attachment not mirrored (block img1)');
    expect(body).toContain('a screenshot');
    expect(body).toContain('original synced content');
    expect(body).toContain('left column');
    expect(body).toContain('right column');
  });

  it('a synced_block REFERENCE never duplicates the original content - only points at it', () => {
    const nodes: NotionBlockNode[] = [
      parent('ref1', 'synced_block', { synced_from: { block_id: 'sync1' } }, [
        leaf('ref1-p', 'paragraph', { rich_text: [rt('should not appear')] }),
      ]),
    ];
    const { body, lossy } = blocksToMarkdown(nodes);
    expect(lossy).toEqual(['synced_block']);
    expect(body).not.toContain('should not appear');
    expect(body).toContain('see the original block');
  });

  it('a block type outside the lossless AND named-lossy lists falls into the unsupported catch-all rather than vanishing', () => {
    const nodes: NotionBlockNode[] = [leaf('cal1', 'callout', { rich_text: [rt('heads up')] })];
    const { body, lossy } = blocksToMarkdown(nodes);
    expect(lossy).toEqual(['unsupported']);
    expect(body).toContain('unsupported block: callout');
  });

  it('mention and equation rich text is preserved as plain text and recorded as lossy', () => {
    const nodes: NotionBlockNode[] = [
      leaf('p1', 'paragraph', {
        rich_text: [
          { type: 'mention', plain_text: '@Some Page', href: null, annotations: {} },
          rt(' costs '),
          { type: 'equation', plain_text: 'x^2', href: null, annotations: {} },
        ],
      }),
    ];
    const { body, lossy } = blocksToMarkdown(nodes);
    expect([...lossy].sort()).toEqual(['equation', 'mention']);
    expect(body).toContain('@Some Page');
    expect(body).toContain('x^2');
  });

  it('embed and bookmark blocks reduce to a link plus title, never a bare drop', () => {
    const nodes: NotionBlockNode[] = [
      leaf('e1', 'embed', { url: 'https://example.com/video', caption: [] }),
      leaf('bk1', 'bookmark', { url: 'https://example.com/article', caption: [rt('An article')] }),
    ];
    const { body, lossy } = blocksToMarkdown(nodes);
    expect(lossy).toEqual(['embed', 'bookmark']);
    expect(body).toContain('https://example.com/video');
    expect(body).toContain('[An article](https://example.com/article)');
  });
});

describe('splitOnH2', () => {
  const heading = (id: string, title: string): NotionBlockNode => leaf(id, 'heading_2', { rich_text: [rt(title)] });
  const bigParagraph = (id: string): NotionBlockNode => leaf(id, 'paragraph', { rich_text: [rt('x'.repeat(200))] });

  function bigDocument(): NotionBlockNode[] {
    const nodes: NotionBlockNode[] = [bigParagraph('intro-p')];
    for (let i = 0; i < 30; i++) {
      nodes.push(heading(`h-${i}`, `Section ${i}`));
      nodes.push(bigParagraph(`p-${i}`));
    }
    return nodes;
  }

  it('does not split a page under maxBodyBytes', () => {
    const nodes = [leaf('p1', 'paragraph', { rich_text: [rt('short')] })];
    const result = splitOnH2('page-a', nodes, 1_000_000, 'A short page');
    expect(result.wasSplit).toBe(false);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]?.externalId).toBe('page-a');
    expect(result.sections[0]?.headingBlockId).toBeNull();
  });

  it('splits an oversized page on H2 into sections whose externalId is <pageId>#<headingBlockId>', () => {
    const result = splitOnH2('page-a', bigDocument(), 2_000, 'Big page');
    expect(result.wasSplit).toBe(true);
    const headingSections = result.sections.filter((s) => s.headingBlockId !== null);
    expect(headingSections.length).toBeGreaterThan(0);
    for (const section of headingSections) {
      expect(section.externalId).toBe(`page-a#${section.headingBlockId}`);
    }
    // The intro section (before the first H2) keeps the page's own id, no fragment.
    const intro = result.sections.find((s) => s.headingBlockId === null);
    expect(intro?.externalId).toBe('page-a');
  });

  it('section identity is stable across a re-parse of the same blocks', () => {
    const nodes = bigDocument();
    const first = splitOnH2('page-a', nodes, 2_000, 'Big page');
    const second = splitOnH2('page-a', nodes, 2_000, 'Big page');
    expect(second.sections.map((s) => s.externalId)).toEqual(first.sections.map((s) => s.externalId));
  });

  it('section externalId is keyed on the heading block id, not its position - shifting everything ahead of it changes nothing already assigned', () => {
    // Insert one extra heading ahead of the rest so every downstream section's POSITION shifts -
    // if externalId were index-based this would change every id; keyed on the block id, only the
    // new section's own id is new and the rest are byte-identical to the un-shifted run.
    const nodes = bigDocument();
    const shifted = [heading('h-extra', 'Extra'), bigParagraph('p-extra'), ...nodes];
    const before = splitOnH2('page-a', nodes, 2_000, 'Big page').sections.map((s) => s.externalId);
    const after = splitOnH2('page-a', shifted, 2_000, 'Big page').sections.map((s) => s.externalId);
    // Every id from the original run still appears, unchanged, in the shifted run.
    for (const id of before.filter((id) => id !== 'page-a')) {
      expect(after).toContain(id);
    }
  });
});
