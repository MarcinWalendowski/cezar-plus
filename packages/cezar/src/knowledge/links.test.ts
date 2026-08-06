import { describe, expect, it } from 'vitest';
import {
  buildLinkGraph,
  extractWikilinkTargets,
  resolveDocumentLinks,
  resolveLinkTarget,
  type LinkableDocument,
} from './links.ts';

/**
 * `.ai/specs/2026-08-06-knowledge-base-mounts-search.md` ("Search and the link graph", C12).
 * An unresolved link is REPORTED, never dropped; an ambiguous one carries `candidates` rather
 * than silently picking one.
 */

function doc(overrides: Partial<LinkableDocument> & { id: string }): LinkableDocument {
  return {
    slug: overrides.id,
    path: `/repo/${overrides.id}.md`,
    body: '',
    ...overrides,
  };
}

describe('extractWikilinkTargets', () => {
  it('extracts targets in order of first appearance, trimmed', () => {
    const targets = extractWikilinkTargets('See [[spec-282]] and then [[ other-doc ]] again.');
    expect(targets).toEqual(['spec-282', 'other-doc']);
  });

  it('strips a `|Display text` suffix, keeping only the target', () => {
    const targets = extractWikilinkTargets('Read [[spec-282|the product split spec]] first.');
    expect(targets).toEqual(['spec-282']);
  });

  it('returns nothing for a body with no wikilinks', () => {
    expect(extractWikilinkTargets('Plain prose, no brackets here.')).toEqual([]);
  });
});

describe('resolveLinkTarget (three-tier, case insensitive)', () => {
  const docs: LinkableDocument[] = [
    doc({ id: 'specs-aaa111', slug: 'product-capability-split', path: '/repo/specs/SPEC-282.md', body: '' }),
    doc({ id: 'specs-bbb222', slug: 'scheduling-carve', path: '/repo/specs/scheduling-carve.md', body: '' }),
  ];

  it('resolves by exact id', () => {
    const result = resolveLinkTarget('specs-aaa111', docs);
    expect(result).toEqual({ target: 'specs-aaa111', resolved: true, id: 'specs-aaa111' });
  });

  it('resolves by exact slug, case insensitively', () => {
    const result = resolveLinkTarget('Product-Capability-Split', docs);
    expect(result).toEqual({
      target: 'Product-Capability-Split',
      resolved: true,
      id: 'specs-aaa111',
    });
  });

  it('resolves by filename stem when neither id nor slug matches', () => {
    const result = resolveLinkTarget('SPEC-282', docs);
    expect(result).toEqual({ target: 'SPEC-282', resolved: true, id: 'specs-aaa111' });
  });

  it('reports an unresolved link as {resolved:false}, never dropped (C12)', () => {
    const result = resolveLinkTarget('nothing-matches-this', docs);
    expect(result).toEqual({ target: 'nothing-matches-this', resolved: false });
  });

  it('reports more than one match at a tier as ambiguous, with candidates (C12)', () => {
    const ambiguousDocs: LinkableDocument[] = [
      doc({ id: 'project-aaa', slug: 'onboarding', path: '/repo/a/onboarding.md', body: '' }),
      doc({ id: 'sources-bbb', slug: 'onboarding', path: '/repo/b/onboarding.md', body: '' }),
    ];
    const result = resolveLinkTarget('onboarding', ambiguousDocs);
    expect(result.resolved).toBe(false);
    expect(result.reason).toBe('ambiguous');
    expect(result.candidates).toEqual(expect.arrayContaining(['project-aaa', 'sources-bbb']));
    expect(result.candidates).toHaveLength(2);
  });

  it('stops at the first tier that matches more than one, rather than falling through', () => {
    // Two docs share a slug (ambiguous at tier 2); a third has that same string as its id
    // (tier 1 would resolve cleanly if reached, but tier 2 already over-matched first).
    const docsWithTierClash: LinkableDocument[] = [
      doc({ id: 'x-one', slug: 'dup', path: '/repo/one.md', body: '' }),
      doc({ id: 'x-two', slug: 'dup', path: '/repo/two.md', body: '' }),
    ];
    const result = resolveLinkTarget('dup', docsWithTierClash);
    expect(result.resolved).toBe(false);
    expect(result.reason).toBe('ambiguous');
  });
});

describe('resolveDocumentLinks', () => {
  it('unions explicit frontmatter links with wikilinks extracted from the body, deduplicated', () => {
    const target = doc({ id: 'target-doc', slug: 'target-doc', path: '/repo/target-doc.md' });
    const source = doc({
      id: 'source-doc',
      slug: 'source-doc',
      path: '/repo/source-doc.md',
      body: 'See [[target-doc]] for details.',
      links: ['target-doc'], // same target named twice: explicit + wikilink
    });
    const resolved = resolveDocumentLinks(source, [source, target]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toEqual({ target: 'target-doc', resolved: true, id: 'target-doc' });
  });
});

describe('buildLinkGraph', () => {
  it('produces a reverse backlink index and a stable derived backlinkCount', () => {
    const a = doc({ id: 'doc-a', slug: 'doc-a', path: '/repo/doc-a.md', body: 'links to [[doc-c]]' });
    const b = doc({ id: 'doc-b', slug: 'doc-b', path: '/repo/doc-b.md', body: 'also links to [[doc-c]]' });
    const c = doc({ id: 'doc-c', slug: 'doc-c', path: '/repo/doc-c.md', body: 'no outbound links here' });
    const graph = buildLinkGraph([a, b, c]);

    expect(graph.backlinkCounts.get('doc-c')).toBe(2);
    expect(graph.backlinksByDoc.get('doc-c')).toEqual(expect.arrayContaining(['doc-a', 'doc-b']));
    expect(graph.backlinkCounts.get('doc-a')).toBe(0);
    expect(graph.linksByDoc.get('doc-a')).toEqual([{ target: 'doc-c', resolved: true, id: 'doc-c' }]);
  });

  it('an unresolved link contributes no backlink, but is still reported on the source document', () => {
    const a = doc({ id: 'doc-a', slug: 'doc-a', path: '/repo/doc-a.md', body: 'links to [[missing-doc]]' });
    const graph = buildLinkGraph([a]);
    expect(graph.linksByDoc.get('doc-a')).toEqual([{ target: 'missing-doc', resolved: false }]);
    expect(graph.backlinkCounts.get('doc-a')).toBe(0);
  });
});
