import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { KnowledgeDocument, KnowledgeFacetBucket } from '@loki-labs/cezar-plus-contract';
import {
  WorkspaceKnowledgeIndex,
  type WorkspaceKnowledgeContexts,
  type WorkspaceKnowledgeProjectSource,
} from './knowledge-index.ts';
import type { KnowledgeStore } from '../knowledge/store.ts';

/**
 * `WorkspaceKnowledgeIndex` unit surface (`.ai/specs/2026-08-14-knowledge-domains-and-changelog.md`,
 * D5/D6, "Verification"). Hermetic: `listProjects`, `contexts.peek`, and `createStore` are all
 * injected fakes, so nothing touches `~/.cezar` or opens a real `KnowledgeStore` — that coverage
 * lives in `../knowledge/store.test.ts` for the store itself.
 */

function source(overrides: Partial<WorkspaceKnowledgeProjectSource> = {}): WorkspaceKnowledgeProjectSource {
  return {
    id: 'proj',
    root: '/fake/proj',
    status: 'ok',
    name: 'proj',
    ...overrides,
  };
}

function doc(overrides: Partial<KnowledgeDocument> = {}): KnowledgeDocument {
  return {
    id: 'd1',
    slug: 'doc',
    root: 'project',
    path: '/fake/proj/doc.md',
    title: 'Doc',
    type: 'note',
    tags: [],
    status: 'current',
    identifiers: [],
    updatedAt: '2026-01-01T00:00:00.000Z',
    hash: 'h',
    bytes: 1,
    headings: [],
    excerpt: '',
    links: [],
    backlinkCount: 0,
    ...overrides,
  };
}

/** A duck-typed `KnowledgeStore` — only `search`/`getFacets` are ever called by this index, the
 *  same reason `git-index.ts`'s own tests fake a bare function rather than a real subprocess.
 *  `KnowledgeStore` carries private fields, so a real instance is required by the type system;
 *  cast through `unknown`, matching this repo's own precedent for faking a class-shaped dep
 *  (`providers-api.test.ts`'s `as unknown as { store: RunStore }`). */
function fakeStore(
  overrides: {
    search?: (
      query: string,
      options?: unknown,
    ) => {
      query: string;
      total: number;
      truncated: boolean;
      results: KnowledgeDocument[];
    };
    getFacets?: () => {
      types: [];
      tags: [];
      statuses: [];
      roots: [];
      domains: KnowledgeFacetBucket[];
    };
    listDocuments?: () => KnowledgeDocument[];
    findBySlug?: (slug: string) => KnowledgeDocument[];
    getDocument?: (id: string) => KnowledgeDocument | null;
  } = {},
): KnowledgeStore {
  const search = overrides.search ?? ((query: string) => ({ query, total: 0, truncated: false, results: [] }));
  const getFacets = overrides.getFacets ?? (() => ({ types: [], tags: [], statuses: [], roots: [], domains: [] }));
  const listDocuments = overrides.listDocuments ?? (() => []);
  const findBySlug = overrides.findBySlug ?? (() => []);
  const getDocument = overrides.getDocument ?? (() => null);
  return { search, getFacets, listDocuments, findBySlug, getDocument } as unknown as KnowledgeStore;
}

function contextsWith(live: Record<string, KnowledgeStore | undefined>): WorkspaceKnowledgeContexts {
  return {
    peek: (projectId: string) => (projectId in live ? { knowledgeStore: live[projectId] } : undefined),
  };
}

const NO_LIVE_CONTEXTS: WorkspaceKnowledgeContexts = { peek: () => undefined };

describe('knowledge-index.ts — the structural import guard, with a floor', () => {
  it('imports knowledge/store.ts, and never project-context.ts or workflows/run.ts', async () => {
    const src = await readFile(new URL('./knowledge-index.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/from\s+['"][^'"]*project-context(\.ts)?['"]/);
    expect(src).not.toMatch(/from\s+['"][^'"]*workflows\/run(\.ts)?['"]/);
    // The floor: without this, the two negatives above would also pass on an empty file.
    expect(src).toMatch(/from\s+['"][^'"]*knowledge\/store(\.ts)?['"]/);
  });
});

describe('WorkspaceKnowledgeIndex.search — peek vs standalone', () => {
  it('a project with a live context is searched through THAT store, never a second one', async () => {
    let standaloneBuilds = 0;
    const live = fakeStore({
      search: (q) => ({
        query: q,
        total: 1,
        truncated: false,
        results: [doc({ id: 'live-doc' })],
      }),
    });
    const index = new WorkspaceKnowledgeIndex({
      listProjects: async () => [source({ id: 'p1' })],
      contexts: contextsWith({ p1: live }),
      createStore: async () => {
        standaloneBuilds++;
        return fakeStore();
      },
    });
    const result = await index.search('anything');
    expect(result.results).toEqual([{ project: 'p1', document: doc({ id: 'live-doc' }) }]);
    expect(standaloneBuilds).toBe(0);
  });

  it('a project with no live context (or a live context with no knowledgeStore) opens a standalone store', async () => {
    const calls: string[] = [];
    const index = new WorkspaceKnowledgeIndex({
      listProjects: async () => [source({ id: 'p1' }), source({ id: 'p2', root: '/fake/p2' })],
      // p1: a live context exists but carries no knowledgeStore (CEZ_KB was off when it built).
      contexts: contextsWith({ p1: undefined }),
      createStore: async (root) => {
        calls.push(root);
        return fakeStore();
      },
    });
    await index.search('q');
    expect(calls.sort()).toEqual(['/fake/p2', '/fake/proj']);
  });

  it('a standalone store is built once and REUSED on a later call, held on the index instance', async () => {
    let builds = 0;
    const index = new WorkspaceKnowledgeIndex({
      listProjects: async () => [source()],
      contexts: NO_LIVE_CONTEXTS,
      createStore: async () => {
        builds++;
        return fakeStore();
      },
    });
    await index.search('first');
    await index.search('second');
    expect(builds).toBe(1);
  });

  it('a project whose root is missing is an ok:false row, without calling createStore, and does not drop other projects', async () => {
    const calledFor: string[] = [];
    const index = new WorkspaceKnowledgeIndex({
      listProjects: async () => [source({ id: 'gone', status: 'missing' }), source({ id: 'fine', root: '/fake/fine' })],
      contexts: NO_LIVE_CONTEXTS,
      createStore: async (root) => {
        calledFor.push(root);
        return fakeStore({
          search: () => ({
            query: '',
            total: 1,
            truncated: false,
            results: [doc()],
          }),
        });
      },
    });
    // 'query' (not the single-char 'q' this suite otherwise uses as a placeholder) — a 1-char
    // string is below `TOKEN_RE`'s own 2-char minimum, so it tokenizes to nothing and this
    // must stay on the ranked path, not the browse fallback, to exercise what it says it does.
    const result = await index.search('query');
    expect(result.projects.map((p) => p.id)).toEqual(['gone', 'fine']);
    expect(result.projects[0]).toMatchObject({
      ok: false,
      reason: 'project root is missing',
    });
    expect(result.projects[1]).toMatchObject({ ok: true });
    expect(result.results).toHaveLength(1); // only "fine" contributed
    expect(calledFor).toEqual(['/fake/fine']);
  });

  it('a store that fails to build is an ok:false row carrying the failure reason, siblings unaffected', async () => {
    const index = new WorkspaceKnowledgeIndex({
      listProjects: async () => [source({ id: 'broken' }), source({ id: 'fine', root: '/fake/fine' })],
      contexts: NO_LIVE_CONTEXTS,
      createStore: async (root) => {
        if (root === '/fake/proj') throw new Error('disk full');
        return fakeStore({
          search: () => ({
            query: '',
            total: 1,
            truncated: false,
            results: [doc()],
          }),
        });
      },
    });
    const result = await index.search('query'); // see the sibling "root is missing" test for why not 'q'
    const byId = new Map(result.projects.map((p) => [p.id, p] as const));
    expect(byId.get('broken')).toMatchObject({
      ok: false,
      reason: 'disk full',
    });
    expect(byId.get('fine')).toMatchObject({ ok: true });
    expect(result.results).toHaveLength(1);
  });

  it('a project that exceeds the deadline yields ok:false, reason: "timed out" — a hung fake must hang the test, not the mutation', async () => {
    const index = new WorkspaceKnowledgeIndex({
      listProjects: async () => [source({ id: 'stuck', name: 'stuck' })],
      contexts: NO_LIVE_CONTEXTS,
      // Never resolves. If the deadline were removed, this test would hang forever instead of
      // failing — that IS the guard.
      createStore: () => new Promise(() => {}),
      deadlineMs: 20,
    });
    const result = await index.search('q');
    expect(result.projects).toEqual([{ id: 'stuck', name: 'stuck', ok: false, reason: 'timed out' }]);
  });

  it('applies the domain filter as a post-filter over each project\'s own results', async () => {
    const index = new WorkspaceKnowledgeIndex({
      listProjects: async () => [source()],
      contexts: NO_LIVE_CONTEXTS,
      createStore: async () =>
        fakeStore({
          search: () => ({
            query: '',
            total: 2,
            truncated: false,
            results: [doc({ id: 'd1', domain: 'billing' }), doc({ id: 'd2', domain: 'onboarding' })],
          }),
        }),
    });
    // 'query', not 'q' — this test is about the post-filter over a RANKED result, which the new
    // browse-fallback tests cover separately for an actually-empty query.
    const result = await index.search('query', { domain: 'billing' });
    expect(result.results.map((r) => r.document.id)).toEqual(['d1']);
  });

  it('the `projects` option restricts which registered projects are considered', async () => {
    const calledFor: string[] = [];
    const index = new WorkspaceKnowledgeIndex({
      listProjects: async () => [source({ id: 'a', root: '/fake/a' }), source({ id: 'b', root: '/fake/b' })],
      contexts: NO_LIVE_CONTEXTS,
      createStore: async (root) => {
        calledFor.push(root);
        return fakeStore();
      },
    });
    await index.search('q', { projects: ['a'] });
    expect(calledFor).toEqual(['/fake/a']);
  });

  it('round-robins each project\'s own already-ranked results rather than concatenating project-by-project', async () => {
    const index = new WorkspaceKnowledgeIndex({
      listProjects: async () => [source({ id: 'a', root: '/fake/a' }), source({ id: 'b', root: '/fake/b' })],
      contexts: NO_LIVE_CONTEXTS,
      createStore: async (root) => {
        const label = root === '/fake/a' ? 'a' : 'b';
        return fakeStore({
          search: () => ({
            query: '',
            total: 2,
            truncated: false,
            results: [doc({ id: `${label}1` }), doc({ id: `${label}2` })],
          }),
        });
      },
    });
    const result = await index.search('query', { limit: 100 });
    expect(result.results.map((r) => r.document.id)).toEqual(['a1', 'b1', 'a2', 'b2']);
  });

  it('limit/offset apply over the merged sequence, and truncated reports honestly', async () => {
    const index = new WorkspaceKnowledgeIndex({
      listProjects: async () => [source()],
      contexts: NO_LIVE_CONTEXTS,
      createStore: async () =>
        fakeStore({
          search: () => ({
            query: '',
            total: 3,
            truncated: false,
            results: [doc({ id: 'd1' }), doc({ id: 'd2' }), doc({ id: 'd3' })],
          }),
        }),
    });
    const page = await index.search('query', { limit: 2, offset: 1 });
    expect(page.results.map((r) => r.document.id)).toEqual(['d2', 'd3']);
    expect(page.total).toBe(3);
    expect(page.truncated).toBe(false);

    const first = await index.search('query', { limit: 1, offset: 0 });
    expect(first.truncated).toBe(true);
  });

  it('an unreadable registry degrades to zero projects rather than throwing', async () => {
    const index = new WorkspaceKnowledgeIndex({
      listProjects: async () => {
        throw new Error('registry read failed');
      },
      contexts: NO_LIVE_CONTEXTS,
    });
    await expect(index.search('q')).resolves.toEqual({
      query: 'q',
      total: 0,
      truncated: false,
      results: [],
      projects: [],
    });
  });

  describe('browse fallback — an empty query with a filter must not silently discard it (regression)', () => {
    it('a domain filter with NO query text returns that domain\'s documents, not "no results"', async () => {
      const index = new WorkspaceKnowledgeIndex({
        listProjects: async () => [source()],
        contexts: NO_LIVE_CONTEXTS,
        createStore: async () =>
          fakeStore({
            listDocuments: () => [doc({ id: 'd1', domain: 'billing' }), doc({ id: 'd2', domain: 'onboarding' })],
          }),
      });
      const result = await index.search('', { domain: 'billing' });
      expect(result.results.map((r) => r.document.id)).toEqual(['d1']);
    });

    it('a whitespace-only query with a domain filter behaves the same as an empty one', async () => {
      const index = new WorkspaceKnowledgeIndex({
        listProjects: async () => [source()],
        contexts: NO_LIVE_CONTEXTS,
        createStore: async () =>
          fakeStore({
            listDocuments: () => [doc({ id: 'd1', domain: 'billing' }), doc({ id: 'd2', domain: 'onboarding' })],
          }),
      });
      const result = await index.search('   ', { domain: 'billing' });
      expect(result.results.map((r) => r.document.id)).toEqual(['d1']);
    });

    it('an empty query with NO filter at all still returns empty — a browse is a filtered slice, not the whole corpus', async () => {
      const index = new WorkspaceKnowledgeIndex({
        listProjects: async () => [source()],
        contexts: NO_LIVE_CONTEXTS,
        createStore: async () =>
          fakeStore({
            listDocuments: () => [doc({ id: 'd1', domain: 'billing' }), doc({ id: 'd2', domain: 'onboarding' })],
          }),
      });
      const result = await index.search('');
      expect(result.results).toEqual([]);
    });

    it('a non-empty query still ranks through BM25 even alongside a filter — browse never wins when there IS a query', async () => {
      const index = new WorkspaceKnowledgeIndex({
        listProjects: async () => [source()],
        contexts: NO_LIVE_CONTEXTS,
        createStore: async () =>
          fakeStore({
            search: (q) => ({
              query: q,
              total: 2,
              truncated: false,
              // Deliberately NOT (root, path) order (listDocuments()'s order) and not an
              // updatedAt/id order either — a switch to either would visibly reorder this.
              results: [doc({ id: 'lower-rank', domain: 'billing' }), doc({ id: 'top-rank', domain: 'billing' })],
            }),
            listDocuments: () => {
              throw new Error('listDocuments() must not be called when a real query is present');
            },
          }),
      });
      const result = await index.search('invoice', { domain: 'billing' });
      expect(result.results.map((r) => r.document.id)).toEqual(['lower-rank', 'top-rank']);
    });
  });

  describe('browse mode pins the domain\'s own index document to page 1 (amendment, real-data defect)', () => {
    // 24 ordinary documents plus one whose `slug` equals the domain itself (the "index doc"),
    // ALL sharing one `updatedAt` — the real-corpus shape a bulk import produces (evidence:
    // GET /workspace/knowledge/search?domain=alfredo on the live local server ties every alfredo
    // doc on updatedAt 2026-08-17T07:45 and tie-breaks by id ascending; alfredo's own index doc,
    // notion-c99c754479a2, never appeared in page 1 of 398). `notion-99` sorts AFTER
    // `notion-01`..`notion-24` lexically, so `byUpdatedAtThenId` places it dead last — well past
    // any single page — reproducing the defect the client-side reorder alone could never fix
    // (nothing to move once the doc isn't even in the fetched page).
    function manyTiedDocs(): KnowledgeDocument[] {
      const ordinary = Array.from({ length: 24 }, (_, i) =>
        doc({ id: `notion-${String(i + 1).padStart(2, '0')}`, slug: `alfredo-doc-${i + 1}`, domain: 'alfredo' }),
      );
      const indexDoc = doc({ id: 'notion-99', slug: 'alfredo', domain: 'alfredo' });
      return [...ordinary, indexDoc];
    }

    it('page 1 carries the index document first, even though its id sorts outside the default 20-row page', async () => {
      const index = new WorkspaceKnowledgeIndex({
        listProjects: async () => [source()],
        contexts: NO_LIVE_CONTEXTS,
        createStore: async () => fakeStore({ listDocuments: manyTiedDocs }),
      });
      const result = await index.search('', { domain: 'alfredo' });
      expect(result.total).toBe(25);
      expect(result.results).toHaveLength(20);
      expect(result.results[0]!.document.id).toBe('notion-99');
      // The rest of the page keeps the original tie-break order (ascending id) with the pinned
      // doc's own slot simply removed — a reorder, not a reshuffle of everything else.
      expect(result.results.slice(1).map((r) => r.document.id)).toEqual(
        Array.from({ length: 19 }, (_, i) => `notion-${String(i + 1).padStart(2, '0')}`),
      );
    });

    it('ranked mode (real query text) never reorders — a text search ranks honestly', async () => {
      const index = new WorkspaceKnowledgeIndex({
        listProjects: async () => [source()],
        contexts: NO_LIVE_CONTEXTS,
        createStore: async () =>
          fakeStore({
            search: (q) => ({
              query: q,
              total: 2,
              truncated: false,
              // The index doc (slug === domain) ranked SECOND by BM25 — if the browse-mode pin
              // logic accidentally ran here too, it would move to the front. It must not.
              results: [
                doc({ id: 'better-match', slug: 'alfredo-onboarding', domain: 'alfredo' }),
                doc({ id: 'notion-99', slug: 'alfredo', domain: 'alfredo' }),
              ],
            }),
            listDocuments: () => {
              throw new Error('listDocuments() must not be called when a real query is present');
            },
          }),
      });
      const result = await index.search('onboarding', { domain: 'alfredo' });
      expect(result.results.map((r) => r.document.id)).toEqual(['better-match', 'notion-99']);
    });

    it('offset > 0 stays deterministic — two identical requests return byte-identical pages (D8)', async () => {
      const index = new WorkspaceKnowledgeIndex({
        listProjects: async () => [source()],
        contexts: NO_LIVE_CONTEXTS,
        createStore: async () => fakeStore({ listDocuments: manyTiedDocs }),
      });
      const first = await index.search('', { domain: 'alfredo', offset: 20, limit: 20 });
      const second = await index.search('', { domain: 'alfredo', offset: 20, limit: 20 });
      expect(first).toEqual(second);
      // Page 2 (offset 20 of 25) — the pinned doc already left its old slot for the front of page
      // 1, so it never reappears here; this page is exactly what tie-break order left behind.
      expect(first.results.map((r) => r.document.id)).toEqual(['notion-20', 'notion-21', 'notion-22', 'notion-23', 'notion-24']);
    });
  });

  describe('concurrency cap (D6)', () => {
    it('caps at N standalone builds in flight at once — a real high-water mark, not a call count', async () => {
      const CAP = 4;
      const TOTAL = 10;
      let active = 0;
      let highWater = 0;
      const index = new WorkspaceKnowledgeIndex({
        listProjects: async () => Array.from({ length: TOTAL }, (_, i) => source({ id: `p${i}`, root: `/fake/p${i}` })),
        contexts: NO_LIVE_CONTEXTS,
        concurrency: CAP,
        createStore: async () => {
          active++;
          highWater = Math.max(highWater, active);
          await new Promise((resolve) => setTimeout(resolve, 15));
          active--;
          return fakeStore();
        },
      });
      const result = await index.search('q');
      expect(result.projects).toHaveLength(TOTAL);
      // A call-count assertion (e.g. `calls === TOTAL`) would pass identically with the cap
      // deleted — only the HIGH-WATER MARK can tell 4-at-a-time from all-10-at-once.
      expect(highWater).toBe(CAP);
    });

    it('a cap larger than the project count runs everything at once (never over-throttled)', async () => {
      let active = 0;
      let highWater = 0;
      const index = new WorkspaceKnowledgeIndex({
        listProjects: async () => [source({ id: 'a', root: '/fake/a' }), source({ id: 'b', root: '/fake/b' })],
        contexts: NO_LIVE_CONTEXTS,
        concurrency: 4,
        createStore: async () => {
          active++;
          highWater = Math.max(highWater, active);
          await new Promise((resolve) => setTimeout(resolve, 10));
          active--;
          return fakeStore();
        },
      });
      await index.search('q');
      expect(highWater).toBe(2);
    });
  });
});

describe('WorkspaceKnowledgeIndex.domains', () => {
  it('unions docCount and contributing projects across the workspace for the same domain value', async () => {
    const index = new WorkspaceKnowledgeIndex({
      listProjects: async () => [source({ id: 'a', root: '/fake/a' }), source({ id: 'b', root: '/fake/b' })],
      contexts: NO_LIVE_CONTEXTS,
      createStore: async (root) =>
        fakeStore({
          getFacets: () => ({
            types: [],
            tags: [],
            statuses: [],
            roots: [],
            domains:
              root === '/fake/a'
                ? [{ value: 'billing', count: 2 }]
                : [
                    { value: 'billing', count: 1 },
                    { value: 'onboarding', count: 1 },
                  ],
          }),
        }),
    });
    const result = await index.domains();
    const byDomain = new Map(result.domains.map((d) => [d.domain, d] as const));
    expect(byDomain.get('billing')).toMatchObject({
      docCount: 3,
      projects: ['a', 'b'],
    });
    expect(byDomain.get('onboarding')).toMatchObject({
      docCount: 1,
      projects: ['b'],
    });
  });

  it('a domain with documents but NO index document is still listed, indexDocId absent — never dropped', async () => {
    const index = new WorkspaceKnowledgeIndex({
      listProjects: async () => [source()],
      contexts: NO_LIVE_CONTEXTS,
      createStore: async () =>
        fakeStore({
          getFacets: () => ({
            types: [],
            tags: [],
            statuses: [],
            roots: [],
            domains: [{ value: 'billing', count: 2 }],
          }),
          // No document's slug is "billing" — no index doc exists for this domain.
          findBySlug: () => [],
        }),
    });
    const result = await index.domains();
    expect(result.domains).toEqual([
      {
        domain: 'billing',
        docCount: 2,
        projects: ['proj'],
        indexDocId: undefined,
      },
    ]);
  });

  it('resolves indexDocId to the document whose slug equals the domain id, when one exists', async () => {
    const index = new WorkspaceKnowledgeIndex({
      listProjects: async () => [source()],
      contexts: NO_LIVE_CONTEXTS,
      createStore: async () =>
        fakeStore({
          getFacets: () => ({
            types: [],
            tags: [],
            statuses: [],
            roots: [],
            domains: [{ value: 'billing', count: 2 }],
          }),
          findBySlug: (slug) => (slug === 'billing' ? [doc({ id: 'idx-doc', slug: 'billing' })] : []),
        }),
    });
    const result = await index.domains();
    expect(result.domains).toEqual([
      {
        domain: 'billing',
        docCount: 2,
        projects: ['proj'],
        indexDocId: 'idx-doc',
      },
    ]);
  });

  it('picks the first of a slug collision, in the order findBySlug itself returns', async () => {
    const index = new WorkspaceKnowledgeIndex({
      listProjects: async () => [source()],
      contexts: NO_LIVE_CONTEXTS,
      createStore: async () =>
        fakeStore({
          getFacets: () => ({
            types: [],
            tags: [],
            statuses: [],
            roots: [],
            domains: [{ value: 'billing', count: 2 }],
          }),
          findBySlug: (slug) =>
            slug === 'billing' ? [doc({ id: 'first', slug: 'billing' }), doc({ id: 'second', slug: 'billing' })] : [],
        }),
    });
    const result = await index.domains();
    expect(result.domains[0]).toMatchObject({ indexDocId: 'first' });
  });

  it('never calls store.search() — findIndexDocId is now an exact findBySlug lookup', async () => {
    let searchCalled = false;
    const index = new WorkspaceKnowledgeIndex({
      listProjects: async () => [source()],
      contexts: NO_LIVE_CONTEXTS,
      createStore: async () =>
        fakeStore({
          getFacets: () => ({
            types: [],
            tags: [],
            statuses: [],
            roots: [],
            domains: [{ value: 'billing', count: 2 }],
          }),
          search: () => {
            searchCalled = true;
            return { query: '', total: 0, truncated: false, results: [] };
          },
          findBySlug: (slug) => (slug === 'billing' ? [doc({ id: 'idx-doc', slug: 'billing' })] : []),
        }),
    });
    const result = await index.domains();
    expect(searchCalled).toBe(false);
    expect(result.domains[0]).toMatchObject({ indexDocId: 'idx-doc' });
  });

  it('a project whose store fails to build is an ok:false row; every other project\'s domains still return', async () => {
    const index = new WorkspaceKnowledgeIndex({
      listProjects: async () => [source({ id: 'broken' }), source({ id: 'fine', root: '/fake/fine' })],
      contexts: NO_LIVE_CONTEXTS,
      createStore: async (root) => {
        if (root === '/fake/proj') throw new Error('boom');
        return fakeStore({
          getFacets: () => ({
            types: [],
            tags: [],
            statuses: [],
            roots: [],
            domains: [{ value: 'billing', count: 1 }],
          }),
        });
      },
    });
    const result = await index.domains();
    const byId = new Map(result.projects.map((p) => [p.id, p] as const));
    expect(byId.get('broken')).toMatchObject({ ok: false, reason: 'boom' });
    expect(byId.get('fine')).toMatchObject({ ok: true });
    expect(result.domains).toEqual([
      {
        domain: 'billing',
        docCount: 1,
        projects: ['fine'],
        indexDocId: undefined,
      },
    ]);
  });
});

describe('WorkspaceKnowledgeIndex.changelog (D3)', () => {
  it('projects to documents carrying changeType only, dropping every document without one', async () => {
    const index = new WorkspaceKnowledgeIndex({
      listProjects: async () => [source()],
      contexts: NO_LIVE_CONTEXTS,
      createStore: async () =>
        fakeStore({
          listDocuments: () => [doc({ id: 'd1', changeType: 'Fixed' }), doc({ id: 'd2' })],
        }),
    });
    const result = await index.changelog();
    expect(result.entries.map((e) => e.document.id)).toEqual(['d1']);
  });

  it('goes through listDocuments(), never search() — changeType/domain are frontmatter, not searchable', async () => {
    let searchCalled = false;
    const index = new WorkspaceKnowledgeIndex({
      listProjects: async () => [source()],
      contexts: NO_LIVE_CONTEXTS,
      createStore: async () =>
        fakeStore({
          search: () => {
            searchCalled = true;
            return { query: '', total: 0, truncated: false, results: [] };
          },
          listDocuments: () => [doc({ id: 'd1', changeType: 'Fixed' })],
        }),
    });
    const result = await index.changelog();
    expect(result.entries.map((e) => e.document.id)).toEqual(['d1']);
    expect(searchCalled).toBe(false);
  });

  it('applies the domain filter per project, like search', async () => {
    const index = new WorkspaceKnowledgeIndex({
      listProjects: async () => [source()],
      contexts: NO_LIVE_CONTEXTS,
      createStore: async () =>
        fakeStore({
          listDocuments: () => [
            doc({ id: 'd1', changeType: 'Fixed', domain: 'billing' }),
            doc({ id: 'd2', changeType: 'Added', domain: 'onboarding' }),
          ],
        }),
    });
    const result = await index.changelog({ domain: 'billing' });
    expect(result.entries.map((e) => e.document.id)).toEqual(['d1']);
  });

  it('sorts by updatedAt descending, not scan/registry order', async () => {
    const index = new WorkspaceKnowledgeIndex({
      listProjects: async () => [source()],
      contexts: NO_LIVE_CONTEXTS,
      createStore: async () =>
        fakeStore({
          listDocuments: () => [
            doc({
              id: 'old',
              changeType: 'Fixed',
              updatedAt: '2026-01-01T00:00:00.000Z',
            }),
            doc({
              id: 'new',
              changeType: 'Added',
              updatedAt: '2026-06-01T00:00:00.000Z',
            }),
            doc({
              id: 'mid',
              changeType: 'Changed',
              updatedAt: '2026-03-01T00:00:00.000Z',
            }),
          ],
        }),
    });
    const result = await index.changelog();
    expect(result.entries.map((e) => e.document.id)).toEqual(['new', 'mid', 'old']);
  });

  it('breaks a same-date tie deterministically on id — registry/merge order disagrees with id order here, so only the tie-break makes this pass', async () => {
    const SAME = '2026-01-01T00:00:00.000Z';
    const index = new WorkspaceKnowledgeIndex({
      listProjects: async () => [source({ id: 'b', root: '/fake/b' }), source({ id: 'a', root: '/fake/a' })],
      contexts: NO_LIVE_CONTEXTS,
      createStore: async (root) =>
        fakeStore({
          listDocuments: () =>
            root === '/fake/b'
              ? [doc({ id: 'z-doc', changeType: 'Fixed', updatedAt: SAME })]
              : [doc({ id: 'a-doc', changeType: 'Added', updatedAt: SAME })],
        }),
    });
    const result = await index.changelog();
    // Registry/merge order is [b, a] -> [z-doc, a-doc]; the id tie-break reorders to [a-doc, z-doc].
    expect(result.entries.map((e) => e.document.id)).toEqual(['a-doc', 'z-doc']);
  });

  it('limit truncates the merged, sorted list', async () => {
    const index = new WorkspaceKnowledgeIndex({
      listProjects: async () => [source()],
      contexts: NO_LIVE_CONTEXTS,
      createStore: async () =>
        fakeStore({
          listDocuments: () => [
            doc({
              id: 'd1',
              changeType: 'Fixed',
              updatedAt: '2026-03-01T00:00:00.000Z',
            }),
            doc({
              id: 'd2',
              changeType: 'Added',
              updatedAt: '2026-02-01T00:00:00.000Z',
            }),
            doc({
              id: 'd3',
              changeType: 'Changed',
              updatedAt: '2026-01-01T00:00:00.000Z',
            }),
          ],
        }),
    });
    const result = await index.changelog({ limit: 2 });
    expect(result.entries.map((e) => e.document.id)).toEqual(['d1', 'd2']);
  });

  it('a project whose root is missing is an ok:false row; every other project still returns changelog entries', async () => {
    const index = new WorkspaceKnowledgeIndex({
      listProjects: async () => [source({ id: 'gone', status: 'missing' }), source({ id: 'fine', root: '/fake/fine' })],
      contexts: NO_LIVE_CONTEXTS,
      createStore: async () =>
        fakeStore({
          listDocuments: () => [doc({ id: 'd1', changeType: 'Fixed' })],
        }),
    });
    const result = await index.changelog();
    expect(result.projects.map((p) => p.id)).toEqual(['gone', 'fine']);
    expect(result.projects[0]).toMatchObject({
      ok: false,
      reason: 'project root is missing',
    });
    expect(result.entries.map((e) => e.document.id)).toEqual(['d1']);
  });

  describe('since — "filtered to nothing" must be distinguishable from "nothing exists"', () => {
    it('filters normally when some entries survive it, no flag set', async () => {
      const index = new WorkspaceKnowledgeIndex({
        listProjects: async () => [source()],
        contexts: NO_LIVE_CONTEXTS,
        createStore: async () =>
          fakeStore({
            listDocuments: () => [
              doc({
                id: 'old',
                changeType: 'Fixed',
                updatedAt: '2026-01-01T00:00:00.000Z',
              }),
              doc({
                id: 'new',
                changeType: 'Added',
                updatedAt: '2026-06-01T00:00:00.000Z',
              }),
            ],
          }),
      });
      const result = await index.changelog({
        since: '2026-03-01T00:00:00.000Z',
      });
      expect(result.entries.map((e) => e.document.id)).toEqual(['new']);
      expect(result.sinceExcludedAll).toBeUndefined();
    });

    it('a since that excludes every entry sets sinceExcludedAll — the "over-narrow filter" case', async () => {
      const index = new WorkspaceKnowledgeIndex({
        listProjects: async () => [source()],
        contexts: NO_LIVE_CONTEXTS,
        createStore: async () =>
          fakeStore({
            listDocuments: () => [
              doc({
                id: 'old',
                changeType: 'Fixed',
                updatedAt: '2026-01-01T00:00:00.000Z',
              }),
            ],
          }),
      });
      const result = await index.changelog({
        since: '2027-01-01T00:00:00.000Z',
      });
      expect(result.entries).toEqual([]);
      expect(result.sinceExcludedAll).toBe(true);
    });

    it('a genuinely empty corpus never sets sinceExcludedAll, with or without since — the "nothing exists" case', async () => {
      const index = new WorkspaceKnowledgeIndex({
        listProjects: async () => [source()],
        contexts: NO_LIVE_CONTEXTS,
        createStore: async () => fakeStore({ listDocuments: () => [] }),
      });
      const withSince = await index.changelog({
        since: '2026-01-01T00:00:00.000Z',
      });
      expect(withSince.entries).toEqual([]);
      expect(withSince.sinceExcludedAll).toBeUndefined();

      const withoutSince = await index.changelog();
      expect(withoutSince.entries).toEqual([]);
      expect(withoutSince.sinceExcludedAll).toBeUndefined();
    });

    it('no since param at all never sets sinceExcludedAll even though entries exist', async () => {
      const index = new WorkspaceKnowledgeIndex({
        listProjects: async () => [source()],
        contexts: NO_LIVE_CONTEXTS,
        createStore: async () =>
          fakeStore({
            listDocuments: () => [doc({ id: 'd1', changeType: 'Fixed' })],
          }),
      });
      const result = await index.changelog();
      expect(result.entries).toHaveLength(1);
      expect(result.sinceExcludedAll).toBeUndefined();
    });
  });
});

describe('WorkspaceKnowledgeIndex.getDocument (SPEC "Workspace knowledge: kill the 5s load, preview in place")', () => {
  it('a project with a live context is read through THAT store, never a second one', async () => {
    let standaloneBuilds = 0;
    const live = fakeStore({ getDocument: (id) => (id === 'd1' ? doc({ id: 'd1' }) : null) });
    const index = new WorkspaceKnowledgeIndex({
      listProjects: async () => [source({ id: 'p1' })],
      contexts: contextsWith({ p1: live }),
      createStore: async () => {
        standaloneBuilds++;
        return fakeStore();
      },
    });
    const result = await index.getDocument('p1', 'd1');
    expect(result).toEqual({ ok: true, document: doc({ id: 'd1' }) });
    expect(standaloneBuilds).toBe(0);
  });

  it('a project with no live context opens a standalone store, through the same resolveStore machinery search() uses', async () => {
    const calls: string[] = [];
    const index = new WorkspaceKnowledgeIndex({
      listProjects: async () => [source({ id: 'p1' })],
      contexts: NO_LIVE_CONTEXTS,
      createStore: async (root) => {
        calls.push(root);
        return fakeStore({ getDocument: (id) => (id === 'd1' ? doc({ id: 'd1' }) : null) });
      },
    });
    const result = await index.getDocument('p1', 'd1');
    expect(result).toEqual({ ok: true, document: doc({ id: 'd1' }) });
    expect(calls).toEqual(['/fake/proj']);
  });

  it('an unregistered project id is {ok: false}, without calling createStore', async () => {
    let builds = 0;
    const index = new WorkspaceKnowledgeIndex({
      listProjects: async () => [source({ id: 'p1' })],
      contexts: NO_LIVE_CONTEXTS,
      createStore: async () => {
        builds++;
        return fakeStore();
      },
    });
    const result = await index.getDocument('no-such-project', 'd1');
    expect(result).toEqual({ ok: false });
    expect(builds).toBe(0);
  });

  it('a project whose root is missing is {ok: false}, without calling createStore', async () => {
    const index = new WorkspaceKnowledgeIndex({
      listProjects: async () => [source({ id: 'gone', status: 'missing' })],
      contexts: NO_LIVE_CONTEXTS,
      createStore: async () => fakeStore(),
    });
    const result = await index.getDocument('gone', 'd1');
    expect(result).toEqual({ ok: false });
  });

  it('an unknown doc id within a resolved project is {ok: false}', async () => {
    const index = new WorkspaceKnowledgeIndex({
      listProjects: async () => [source({ id: 'p1' })],
      contexts: NO_LIVE_CONTEXTS,
      createStore: async () => fakeStore({ getDocument: () => null }),
    });
    const result = await index.getDocument('p1', 'no-such-doc');
    expect(result).toEqual({ ok: false });
  });

  it('a store that fails to build is {ok: false} — the same 404/error path a tripped deadline takes everywhere else in this index', async () => {
    const index = new WorkspaceKnowledgeIndex({
      listProjects: async () => [source({ id: 'p1' })],
      contexts: NO_LIVE_CONTEXTS,
      createStore: async () => {
        throw new Error('disk full');
      },
    });
    const result = await index.getDocument('p1', 'd1');
    expect(result).toEqual({ ok: false });
  });

  it('a standalone store built by getDocument is cached and reused by a later search()', async () => {
    let builds = 0;
    const index = new WorkspaceKnowledgeIndex({
      listProjects: async () => [source({ id: 'p1' })],
      contexts: NO_LIVE_CONTEXTS,
      createStore: async () => {
        builds++;
        return fakeStore({ getDocument: (id) => (id === 'd1' ? doc({ id: 'd1' }) : null) });
      },
    });
    await index.getDocument('p1', 'd1');
    await index.search('q', { projects: ['p1'] });
    expect(builds).toBe(1);
  });
});
