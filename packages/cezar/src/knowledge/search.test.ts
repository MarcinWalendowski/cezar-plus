import { describe, expect, it } from 'vitest';
import { buildSearchIndex, extractIdentifiers, search, tokenize, type SearchableDocument } from './search.ts';

/**
 * `.ai/specs/2026-08-06-knowledge-base-mounts-search.md` ("Search and the link graph", Q5, C1,
 * C13) and `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md` D10.
 */

function makeDoc(overrides: Partial<SearchableDocument> & { id: string }): SearchableDocument {
  return {
    title: overrides.id,
    body: '',
    status: 'current',
    ...overrides,
  };
}

describe('tokenize', () => {
  it('lowercases and keeps a hyphenated identifier as one token', () => {
    expect(tokenize('See SPEC-282 for the reasoning.')).toEqual(['see', 'spec-282', 'for', 'the', 'reasoning']);
  });

  it('drops single-character fragments (minimum token length is 2)', () => {
    expect(tokenize('a b cd')).toEqual(['cd']);
  });
});

describe('extractIdentifiers', () => {
  it('matches an uppercase PREFIX-NNN shape, case sensitively', () => {
    expect(extractIdentifiers('Per SPEC-282 and RFC-9110, not spec-282.')).toEqual(['SPEC-282', 'RFC-9110']);
  });

  it('finds nothing in prose with no identifier-shaped token', () => {
    expect(extractIdentifiers('just ordinary words here')).toEqual([]);
  });
});

describe('search: exact-identifier pinning (C1)', () => {
  // Reproduces the measured real-corpus failure at unit-test scale: an identifier that is
  // cross-referenced across many documents collapses BM25's IDF for that term, so length
  // normalisation alone decides the ranking, and a handful of short passing mentions outrank
  // the long documents that are actually about it. Case is the load-bearing difference between
  // the two stages: the canonical (uppercase) mentions live only on the three real target docs,
  // while the noise docs cite it casually in lowercase — BM25's tokenizer is case-insensitive
  // (so all eleven score non-zero for the query), but the identifier regex is case-sensitive
  // (so only the three real docs are ever pinned).
  const FILLER =
    'lorem filler content about product architecture and capability boundaries and long term maintenance. ';
  const relevantIds = ['relevant-1', 'relevant-2', 'relevant-3'];
  const relevantDocs: SearchableDocument[] = relevantIds.map((id) =>
    makeDoc({
      id,
      title: 'Product Capability Split',
      body: `This document supersedes SPEC-282 and explains the reasoning in full. ${FILLER.repeat(40)}`,
    }),
  );
  const noiseDocs: SearchableDocument[] = Array.from({ length: 8 }, (_, i) =>
    makeDoc({
      id: `noise-${i + 1}`,
      title: 'Quick Note',
      body: 'quick heads up, check spec-282 before you merge this change today.',
    }),
  );
  const docs = [...relevantDocs, ...noiseDocs];

  it('pinning enabled: SPEC-282 returns exactly its 3 relevant documents in the top 5', () => {
    const { results } = search(docs, 'SPEC-282', { limit: 5 });
    const top3 = new Set(results.slice(0, 3).map((d) => d.id));
    expect(top3).toEqual(new Set(relevantIds));
  });

  it('pinning disabled: the same claim FAILS — none of the 3 relevant documents survive to the top 5', () => {
    // This is the negative control (C1): identical corpus and query, only the pin stage
    // removed. A test that passed either way would mean the pin is decorative.
    const { results } = search(docs, 'SPEC-282', { limit: 5, identifierPinning: false });
    const resultIds = new Set(results.map((d) => d.id));
    for (const id of relevantIds) expect(resultIds.has(id)).toBe(false);
  });

  it('both modes see the same total candidate count — pinning changes ORDER, not membership', () => {
    const withPin = search(docs, 'SPEC-282', { limit: 5 });
    const withoutPin = search(docs, 'SPEC-282', { limit: 5, identifierPinning: false });
    expect(withPin.total).toBe(11);
    expect(withoutPin.total).toBe(11);
  });
});

describe('search: identifier collisions (C13, Q7)', () => {
  it('two documents claiming one identifier both survive and both appear in an identifier search', () => {
    const docA = makeDoc({ id: 'doc-a', title: 'First doc', body: 'unrelated alpha content.', identifiers: ['TICKET-99'] });
    const docB = makeDoc({ id: 'doc-b', title: 'Second doc', body: 'unrelated beta content.', identifiers: ['TICKET-99'] });
    const docC = makeDoc({ id: 'doc-c', title: 'Third doc', body: 'no identifier at all.' });

    const { results } = search([docA, docB, docC], 'TICKET-99');
    const ids = results.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(['doc-a', 'doc-b']));
    expect(ids).not.toContain('doc-c');
  });
});

describe('search: superseded demotion, not suppression', () => {
  it('halves a superseded document\'s score rather than dropping it, and it still ranks below an equivalent current one', () => {
    const current = makeDoc({ id: 'doc-current', title: 'Onboarding flow', body: 'onboarding flow details here.', status: 'current' });
    const superseded = makeDoc({ id: 'doc-superseded', title: 'Onboarding flow', body: 'onboarding flow details here.', status: 'superseded' });
    const { results } = search([current, superseded], 'onboarding flow');
    expect(results.map((r) => r.id)).toEqual(['doc-current', 'doc-superseded']);
  });

  it('a superseded document that is the only hit is still returned', () => {
    const superseded = makeDoc({ id: 'doc-superseded', title: 'Old decision', body: 'a superseded decision about widgets.', status: 'superseded' });
    const { results, total } = search([superseded], 'widgets');
    expect(total).toBe(1);
    expect(results[0]?.id).toBe('doc-superseded');
  });
});

describe('search: filters', () => {
  const docs: SearchableDocument[] = [
    makeDoc({ id: 'note-1', title: 'note about widgets', body: 'widgets widgets widgets', type: 'note', tags: ['hardware'], root: 'project' }),
    makeDoc({ id: 'spec-1', title: 'spec about widgets', body: 'widgets widgets widgets', type: 'spec', tags: ['hardware'], root: 'specs' }),
    makeDoc({ id: 'spec-2', title: 'spec about widgets', body: 'widgets widgets widgets', type: 'spec', tags: ['software'], root: 'specs' }),
  ];

  it('narrows by type', () => {
    const { results } = search(docs, 'widgets', { type: 'spec' });
    expect(results.map((r) => r.id).sort()).toEqual(['spec-1', 'spec-2']);
  });

  it('narrows by tag', () => {
    const { results } = search(docs, 'widgets', { tag: 'software' });
    expect(results.map((r) => r.id)).toEqual(['spec-2']);
  });

  it('narrows by root', () => {
    const { results } = search(docs, 'widgets', { root: 'project' });
    expect(results.map((r) => r.id)).toEqual(['note-1']);
  });
});

describe('search: opts.index (SPEC "Workspace knowledge: kill the 5s load, preview in place")', () => {
  it('a shared index built over the same docs as the internal build is interchangeable — omitting it changes nothing', () => {
    const docs: SearchableDocument[] = [
      makeDoc({ id: 'note-1', title: 'note about widgets', body: 'widgets widgets widgets', type: 'note', tags: ['hardware'], root: 'project' }),
      makeDoc({ id: 'spec-1', title: 'spec about widgets', body: 'widgets widgets widgets', type: 'spec', tags: ['hardware'], root: 'specs' }),
      makeDoc({ id: 'spec-2', title: 'spec about widgets', body: 'widgets widgets widgets', type: 'spec', tags: ['software'], root: 'specs' }),
    ];
    const withoutIndex = search(docs, 'widgets', { type: 'spec' });
    const index = buildSearchIndex(docs);
    const withIndex = search(docs, 'widgets', { type: 'spec', index });
    expect(withIndex).toEqual(withoutIndex);
  });

  it('candidates strictly respect filters even though the shared index was built over a wider corpus', () => {
    // Two candidates (type: 'target'), symmetric except for which query term each one carries —
    // see the scoring test below for why that symmetry matters. 18 filler docs (type: 'filler')
    // exist ONLY to skew the corpus-wide term statistics; none of them may ever appear in a
    // `type: 'target'`-filtered result, no matter how well they'd score.
    const docX = makeDoc({ id: 'doc-x', title: 'x', type: 'target', body: 'alpha alpha alpha' });
    const docY = makeDoc({ id: 'doc-y', title: 'y', type: 'target', body: 'beta beta beta' });
    const filler = Array.from({ length: 18 }, (_, i) => makeDoc({ id: `filler-${i + 1}`, type: 'filler', body: 'alpha' }));
    const allDocs = [docX, docY, ...filler];
    const index = buildSearchIndex(allDocs);

    const { results, total } = search(allDocs, 'alpha beta', { type: 'target', index });
    expect(total).toBe(2);
    expect(new Set(results.map((r) => r.id))).toEqual(new Set(['doc-x', 'doc-y']));
  });

  it('IDF/avgLength come from the whole corpus, not the filtered subset — a filtered tie under a local index is not a tie under a shared one', () => {
    // Within the filtered pair alone, 'alpha' and 'beta' are equally rare (docFreq 1 each) — a
    // locally-built index scores docX (all 'alpha') and docY (all 'beta') identically, so the tie
    // is broken by id, docX first. Add 18 filler docs (excluded from the `target` filter, but
    // present in the SHARED index) that all carry 'alpha' — globally 'alpha' becomes common
    // (low IDF) while 'beta' stays rare (high IDF), which must flip the ranking once the shared,
    // corpus-wide index is used instead of a per-call rebuild over just the filtered pair.
    const docX = makeDoc({ id: 'doc-x', title: 'x', type: 'target', body: 'alpha alpha alpha' });
    const docY = makeDoc({ id: 'doc-y', title: 'y', type: 'target', body: 'beta beta beta' });
    const filler = Array.from({ length: 18 }, (_, i) => makeDoc({ id: `filler-${i + 1}`, type: 'filler', body: 'alpha' }));
    const allDocs = [docX, docY, ...filler];

    const local = search(allDocs, 'alpha beta', { type: 'target' });
    expect(local.results.map((r) => r.id)).toEqual(['doc-x', 'doc-y']);

    const index = buildSearchIndex(allDocs);
    const shared = search(allDocs, 'alpha beta', { type: 'target', index });
    expect(shared.results.map((r) => r.id)).toEqual(['doc-y', 'doc-x']);
  });

  it('two consecutive calls against the same shared index return byte-identical bodies (D8)', () => {
    const docs: SearchableDocument[] = Array.from({ length: 5 }, (_, i) =>
      makeDoc({ id: `doc-${i}`, title: 'apple orchard notes', body: 'apple orchard notes about seasonal fruit.' }),
    );
    const index = buildSearchIndex(docs);
    const first = search(docs, 'apple', { index });
    const second = search(docs, 'apple', { index });
    expect(second).toEqual(first);
  });
});

describe('search: pagination and empty query', () => {
  const docs: SearchableDocument[] = Array.from({ length: 5 }, (_, i) =>
    makeDoc({ id: `doc-${i}`, title: 'apple orchard notes', body: 'apple orchard notes about seasonal fruit.' }),
  );

  it('reports truncated when more results exist beyond the page', () => {
    const { results, total, truncated } = search(docs, 'apple', { limit: 2, offset: 0 });
    expect(results).toHaveLength(2);
    expect(total).toBe(5);
    expect(truncated).toBe(true);
  });

  it('reports truncated:false on the last page', () => {
    const { results, truncated } = search(docs, 'apple', { limit: 2, offset: 4 });
    expect(results).toHaveLength(1);
    expect(truncated).toBe(false);
  });

  it('an empty query returns no results rather than the whole catalog', () => {
    const { results, total } = search(docs, '   ');
    expect(results).toEqual([]);
    expect(total).toBe(0);
  });
});
