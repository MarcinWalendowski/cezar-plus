import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { KnowledgeDocument } from '@loki-labs/cezar-plus-contract';
import {
  WorkspaceReportsIndex,
  isReportDocument,
  reportTriageKeyFor,
  type WorkspaceReportsContexts,
  type WorkspaceReportsProjectSource,
} from './reports-index.ts';
import type { KnowledgeStore } from '../knowledge/store.ts';

/**
 * `WorkspaceReportsIndex` (`.ai/specs/2026-08-19-reports-triage-approve-dismiss.md`, "Reports is a
 * workspace tab" amendment). Hermetic: `listProjects`, `contexts.peek` and `createStore` are all
 * injected fakes, so nothing touches `~/.cezar` or opens a real `KnowledgeStore` — that coverage
 * lives in `../knowledge/store.test.ts`.
 *
 * **The assertion this file exists for is the DEDUPE.** One operator-declared knowledge mount is
 * resolved by every registered project, so a naive fan-out answers the same report once per
 * project: 196 × 12 = 2352 rows on the deployment that motivated the change. The dedupe test below
 * is written so that removing the merge FAILS it (see its own comment for the mutation that was
 * actually run against it) — a test asserting only "the row is present" would pass on the bug.
 */

const TAGS = ['user-report'] as const;

function source(overrides: Partial<WorkspaceReportsProjectSource> = {}): WorkspaceReportsProjectSource {
  return { id: 'proj', root: '/fake/proj', status: 'ok', name: 'proj', ...overrides };
}

function doc(overrides: Partial<KnowledgeDocument> = {}): KnowledgeDocument {
  return {
    id: 'd1',
    slug: 'doc',
    root: 'reports',
    path: '/fake/mount/doc.md',
    title: 'Doc',
    type: 'note',
    tags: ['user-report'],
    status: 'current',
    identifiers: [],
    updatedAt: '2026-08-19T00:00:00.000Z',
    hash: 'h',
    bytes: 1,
    headings: [],
    excerpt: '',
    links: [],
    backlinkCount: 0,
    ...overrides,
  };
}

/** A duck-typed `KnowledgeStore` — only `listDocuments`/`getDocument` are ever called by this
 *  index. `KnowledgeStore` carries private fields, so cast through `unknown`, matching this repo's
 *  precedent for faking a class-shaped dep. */
function fakeStore(
  overrides: {
    listDocuments?: () => KnowledgeDocument[];
    getDocument?: (id: string) => KnowledgeDocument | null;
  } = {},
): KnowledgeStore {
  const listDocuments = overrides.listDocuments ?? (() => []);
  const getDocument = overrides.getDocument ?? (() => null);
  return { listDocuments, getDocument } as unknown as KnowledgeStore;
}

function contextsWith(live: Record<string, KnowledgeStore | undefined>): WorkspaceReportsContexts {
  return { peek: (projectId: string) => (projectId in live ? { knowledgeStore: live[projectId] } : undefined) };
}

const NO_LIVE_CONTEXTS: WorkspaceReportsContexts = { peek: () => undefined };

describe('reports-index.ts — the structural import guard, with a floor', () => {
  it('imports knowledge/store.ts, and never project-context.ts or workflows/run.ts', async () => {
    const src = await readFile(new URL('./reports-index.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/from\s+['"][^'"]*project-context(\.ts)?['"]/);
    expect(src).not.toMatch(/from\s+['"][^'"]*workflows\/run(\.ts)?['"]/);
    // The floor: without this, the two negatives above would also pass on an empty file.
    expect(src).toMatch(/from\s+['"][^'"]*knowledge\/store(\.ts)?['"]/);
  });
});

describe('WorkspaceReportsIndex.list — the cross-project dedupe', () => {
  it('one document resolved by three projects is ONE row naming all three', async () => {
    // The real shape on the box: one operator-declared mount, so every project's store lists the
    // SAME document — same catalog id, same provenance identifier.
    const shared = doc({ id: 'reports-abc123', identifiers: ['notion:9f2c'], title: 'Login is broken' });
    const index = new WorkspaceReportsIndex({
      // Registry order deliberately does NOT match sorted order — see the `project` assertion below.
      listProjects: async () => [source({ id: 'chat' }), source({ id: 'apex' }), source({ id: 'cezar' })],
      contexts: contextsWith({
        apex: fakeStore({ listDocuments: () => [shared] }),
        chat: fakeStore({ listDocuments: () => [shared] }),
        cezar: fakeStore({ listDocuments: () => [shared] }),
      }),
    });

    const { rows, projects } = await index.list({ tags: TAGS });

    // MUTATION-TESTED: with the `merge()` dedupe removed (rows pushed unconditionally), this line
    // reads 3 and the test fails. Asserting only `rows[0].projects` would pass on that mutation,
    // because the first row is correct either way — the count is the assertion that bites.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.projects).toEqual(['apex', 'cezar', 'chat']);
    expect(rows[0]!.key).toBe('notion:9f2c');
    // Canonical project is REGISTRY order, not sorted order — otherwise `cezar` would win here and
    // the two would be indistinguishable in this fixture, which is why the registry deliberately
    // lists `chat` first while the sorted `projects` starts with `apex`.
    expect(rows[0]!.project).toBe('chat');

    // Health rows report each project's OWN pre-dedupe count, so they sum to more than the deduped
    // total. That is not double counting to be fixed — it is the fact the page exists to show.
    expect(projects.map((p) => [p.id, p.total])).toEqual([
      ['chat', 1],
      ['apex', 1],
      ['cezar', 1],
    ]);
  });

  it('genuinely different reports in different projects stay separate rows', async () => {
    // The negative control for the test above: dedupe must key on the report, not collapse every
    // project's queue into one row. Without this, a `merge()` that returned only the first row of
    // the whole fan-out would still pass the dedupe assertion.
    const index = new WorkspaceReportsIndex({
      listProjects: async () => [source({ id: 'a' }), source({ id: 'b' })],
      contexts: contextsWith({
        a: fakeStore({ listDocuments: () => [doc({ id: 'da', identifiers: ['local:report:1'] })] }),
        b: fakeStore({ listDocuments: () => [doc({ id: 'db', identifiers: ['local:report:2'] })] }),
      }),
    });
    const { rows } = await index.list({ tags: TAGS });
    expect(rows.map((r) => [r.key, r.projects])).toEqual([
      ['local:report:1', ['a']],
      ['local:report:2', ['b']],
    ]);
  });

  it('only tagged documents count as reports', async () => {
    const index = new WorkspaceReportsIndex({
      listProjects: async () => [source({ id: 'a' })],
      contexts: contextsWith({
        a: fakeStore({
          listDocuments: () => [
            doc({ id: 'report', identifiers: ['r1'] }),
            doc({ id: 'plain', identifiers: ['n1'], tags: ['note'] }),
          ],
        }),
      }),
    });
    const { rows } = await index.list({ tags: TAGS });
    expect(rows.map((r) => r.key)).toEqual(['r1']);
  });

  it('a document with no identifier falls back to the catalog id, and says so', async () => {
    const index = new WorkspaceReportsIndex({
      listProjects: async () => [source({ id: 'a' })],
      contexts: contextsWith({ a: fakeStore({ listDocuments: () => [doc({ id: 'reports-xyz' })] }) }),
    });
    const { rows } = await index.list({ tags: TAGS });
    expect(rows[0]).toMatchObject({ key: 'reports-xyz', keyKind: 'catalog-id' });
  });
});

describe('WorkspaceReportsIndex.list — per-project health', () => {
  it('a missing project is an ok:false ROW, never a dropped one', async () => {
    const index = new WorkspaceReportsIndex({
      listProjects: async () => [source({ id: 'gone', status: 'missing' }), source({ id: 'live' })],
      contexts: contextsWith({ live: fakeStore({ listDocuments: () => [doc({ identifiers: ['r1'] })] }) }),
      createStore: async () => {
        throw new Error('a missing project must never be opened');
      },
    });
    const { rows, projects } = await index.list({ tags: TAGS });
    expect(rows).toHaveLength(1);
    // The dedupe is exactly what makes a silently dropped project invisible: eleven other projects
    // would still carry the same documents, so the queue would look completely healthy. The row is
    // the only thing that can say otherwise.
    expect(projects.find((p) => p.id === 'gone')).toMatchObject({
      ok: false,
      reason: 'project root is missing',
      total: 0,
    });
  });

  it('a store that fails to build is an ok:false row carrying the failure', async () => {
    const index = new WorkspaceReportsIndex({
      listProjects: async () => [source({ id: 'broken' })],
      contexts: NO_LIVE_CONTEXTS,
      createStore: async () => {
        throw new Error('catalog is corrupt');
      },
    });
    const { rows, projects } = await index.list({ tags: TAGS });
    expect(rows).toEqual([]);
    expect(projects[0]).toMatchObject({ id: 'broken', ok: false, reason: 'catalog is corrupt' });
  });

  it('a project that trips the deadline is a row, not a hang', async () => {
    const index = new WorkspaceReportsIndex({
      listProjects: async () => [source({ id: 'slow' })],
      contexts: NO_LIVE_CONTEXTS,
      deadlineMs: 5,
      createStore: () => new Promise(() => {}), // never settles
    });
    const { projects } = await index.list({ tags: TAGS });
    expect(projects[0]).toMatchObject({ id: 'slow', ok: false, reason: 'timed out' });
  });

  it('a rejected registry lookup degrades to an empty index rather than throwing', async () => {
    const index = new WorkspaceReportsIndex({
      listProjects: async () => {
        throw new Error('no registry');
      },
      contexts: NO_LIVE_CONTEXTS,
    });
    await expect(index.list({ tags: TAGS })).resolves.toEqual({
      rows: [],
      projects: [],
      body: expect.any(Function),
    });
  });
});

describe('WorkspaceReportsIndex — peek vs standalone', () => {
  it('a project with a live context is read through THAT store, never a second one', async () => {
    let standaloneBuilds = 0;
    const index = new WorkspaceReportsIndex({
      listProjects: async () => [source({ id: 'p1' })],
      contexts: contextsWith({ p1: fakeStore({ listDocuments: () => [doc({ identifiers: ['live'] })] }) }),
      createStore: async () => {
        standaloneBuilds++;
        return fakeStore();
      },
    });
    const { rows } = await index.list({ tags: TAGS });
    expect(rows.map((r) => r.key)).toEqual(['live']);
    expect(standaloneBuilds).toBe(0);
  });

  it('a standalone store is built ONCE per project and reused across calls', async () => {
    let builds = 0;
    const index = new WorkspaceReportsIndex({
      listProjects: async () => [source({ id: 'p1' })],
      contexts: NO_LIVE_CONTEXTS,
      createStore: async () => {
        builds++;
        return fakeStore({ listDocuments: () => [doc({ identifiers: ['r1'] })] });
      },
    });
    await index.list({ tags: TAGS });
    await index.list({ tags: TAGS });
    await index.find('r1', { tags: TAGS });
    expect(builds).toBe(1);
  });

  /**
   * The regression that shipped to production on 2026-08-19 and was caught there.
   *
   * `resolveStore` used to cache the SETTLED store, assigned after `withDeadline` resolved — so a
   * build slower than the deadline had its result discarded even though `withDeadline` leaves the
   * underlying promise running on purpose. Nothing was cached, so the next request started a
   * SECOND full build, which missed the deadline too. A project too slow to make the deadline once
   * could therefore never make it: permanent `ok:false`, a fresh corpus scan burned per request.
   * Measured on the box as 12 projects over one 2081-file mount answering 5 then 10 of 12, at 15s
   * and 9.7s.
   *
   * `builds === 1` is the load-bearing half. Without it this passes on the bug: the second call
   * would eventually go green anyway once a rebuild happened to beat the deadline, so asserting
   * only "the second call succeeds" would not have caught this.
   */
  it('a build that misses the deadline is ADOPTED, not rebuilt, and succeeds next call', async () => {
    let builds = 0;
    let release!: (store: KnowledgeStore) => void;
    const index = new WorkspaceReportsIndex({
      listProjects: async () => [source({ id: 'slow' })],
      contexts: NO_LIVE_CONTEXTS,
      deadlineMs: 5,
      createStore: () => {
        builds++;
        return new Promise<KnowledgeStore>((r) => {
          release = r;
        });
      },
    });

    const first = await index.list({ tags: TAGS });
    expect(first.projects[0]).toMatchObject({ id: 'slow', ok: false, reason: 'timed out' });
    expect(first.rows).toHaveLength(0);

    // The build lands late — exactly the case the old code threw away.
    release(fakeStore({ listDocuments: () => [doc({ identifiers: ['r1'] })] }));
    await Promise.resolve();

    const second = await index.list({ tags: TAGS });
    expect(second.projects[0]).toMatchObject({ id: 'slow', ok: true, total: 1 });
    expect(second.rows.map((r) => r.key)).toEqual(['r1']);
    expect(builds).toBe(1);
  });

  it('a REJECTED build is evicted so the next call retries it', async () => {
    let builds = 0;
    const index = new WorkspaceReportsIndex({
      listProjects: async () => [source({ id: 'flaky' })],
      contexts: NO_LIVE_CONTEXTS,
      createStore: async () => {
        builds++;
        if (builds === 1) throw new Error('root briefly unreadable');
        return fakeStore({ listDocuments: () => [doc({ identifiers: ['r1'] })] });
      },
    });

    const first = await index.list({ tags: TAGS });
    expect(first.projects[0]).toMatchObject({ ok: false, reason: 'root briefly unreadable' });

    // A cached rejection would make this the same failure forever, and `builds` would stay 1.
    const second = await index.list({ tags: TAGS });
    expect(second.projects[0]).toMatchObject({ ok: true, total: 1 });
    expect(builds).toBe(2);
  });

  it('never resolves more than `concurrency` projects at once', async () => {
    let inflight = 0;
    let peak = 0;
    const index = new WorkspaceReportsIndex({
      listProjects: async () => Array.from({ length: 10 }, (_, i) => source({ id: `p${i}`, root: `/fake/p${i}` })),
      contexts: NO_LIVE_CONTEXTS,
      concurrency: 3,
      createStore: async () => {
        inflight++;
        peak = Math.max(peak, inflight);
        await new Promise((r) => setTimeout(r, 5));
        inflight--;
        return fakeStore();
      },
    });
    await index.list({ tags: TAGS });
    expect(peak).toBeLessThanOrEqual(3);
    // The floor: a `peak` of 0 or 1 would satisfy the cap while meaning the fan-out never ran
    // concurrently at all, which would make the assertion above vacuous.
    expect(peak).toBeGreaterThan(1);
  });
});

describe('WorkspaceReportsIndex — bodies and find()', () => {
  it('the body comes from the CANONICAL project store, and one fan-out serves every body', async () => {
    let canonicalReads = 0;
    const shared = doc({ id: 'reports-abc', identifiers: ['notion:1'] });
    const index = new WorkspaceReportsIndex({
      listProjects: async () => [source({ id: 'first' }), source({ id: 'second' })],
      contexts: contextsWith({
        first: fakeStore({
          listDocuments: () => [shared],
          getDocument: (id) => {
            canonicalReads++;
            return id === 'reports-abc' ? { ...shared, body: 'canonical body' } : null;
          },
        }),
        // The same document, a different body — if `body()` resolved through whichever store
        // answered first rather than through the canonical one, this is what would leak out.
        second: fakeStore({
          listDocuments: () => [shared],
          getDocument: () => ({ ...shared, body: 'WRONG STORE' }),
        }),
      }),
    });

    const listed = await index.list({ tags: TAGS });
    expect(listed.body('notion:1')).toBe('canonical body');
    expect(canonicalReads).toBe(1);
    // A key this result does not carry is '' — never a throw, and never another store's document.
    expect(listed.body('nope')).toBe('');
  });

  it('find() answers undefined for a key that matches no report, which is what 404s', async () => {
    const index = new WorkspaceReportsIndex({
      listProjects: async () => [source({ id: 'a' })],
      contexts: contextsWith({ a: fakeStore({ listDocuments: () => [doc({ identifiers: ['r1'] })] }) }),
    });
    await expect(index.find('r1', { tags: TAGS })).resolves.toMatchObject({ row: { key: 'r1' } });
    await expect(index.find('not-a-report', { tags: TAGS })).resolves.toBeUndefined();
  });
});

describe('reportTriageKeyFor / isReportDocument', () => {
  it('prefers the provenance identifier, and reports which kind of key it returned', () => {
    expect(reportTriageKeyFor(doc({ id: 'cat-1', identifiers: ['notion:abc'] }))).toEqual({
      key: 'notion:abc',
      keyKind: 'identifier',
    });
    expect(reportTriageKeyFor(doc({ id: 'cat-1', identifiers: [] }))).toEqual({
      key: 'cat-1',
      keyKind: 'catalog-id',
    });
  });

  it('a document is a report iff it carries one of the configured tags', () => {
    expect(isReportDocument(doc({ tags: ['user-report'] }), TAGS)).toBe(true);
    expect(isReportDocument(doc({ tags: ['notion-report'] }), TAGS)).toBe(false);
    expect(isReportDocument(doc({ tags: ['notion-report'] }), ['user-report', 'notion-report'])).toBe(true);
    expect(isReportDocument(doc({ tags: [] }), TAGS)).toBe(false);
    // An empty tag list is the documented opt-out, not a default — nothing is a report.
    expect(isReportDocument(doc({ tags: ['user-report'] }), [])).toBe(false);
  });
});
