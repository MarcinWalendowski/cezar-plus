import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import type { AutomationStore } from '../automations/store.ts';
import { KnowledgeStore } from '../knowledge/store.ts';
import { RunStore } from '../runs/store.ts';
import { FileSourceSink } from '../sources/sink.ts';
import type { MirroredDocument } from '../sources/types.ts';
import type { RunManager } from '../workflows/run.ts';
import { createKnowledgeRoutes } from './knowledge-routes.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import type { ProjectApiEnv, ProjectContext } from './server.ts';
import { localCliAuthor } from '../runs/task-author.ts';

/**
 * `knowledge-routes.ts` (W4.1). See `.ai/specs/2026-08-06-knowledge-base-mounts-search.md`
 * ("API Contracts") and its own Phases-table row for this package: "flag off shape for all nine
 * routes (GET 200 empty, mutators 409, no 404 anywhere); `source` survives to the wire on both the
 * document and the search result; a `PUT` to `origin: 'remote'` is 409; two consecutive GET bodies
 * byte identical; deterministic ordering." (C10, C21).
 *
 * A `createApp()` integration harness is not used here: this file mounts the KNOWLEDGE family
 * behind a fixed `c.get('project')`, which is exactly what the routes read (dispatch instruction:
 * "read state off `c.get('project')`, never a boot store"). That keeps the nine route shapes
 * testable without a workspace registry.
 *
 * **CORRECTED 2026-08-06.** This paragraph used to justify the choice differently — "the boot
 * project `createApp` seeds directly from `deps.{store,manager}` never carries a `knowledgeStore`
 * (only a project built through `ProjectContexts`/`project-context.ts`, W3.1, does)". That was
 * true, and it was a BUG, not a property to design a fixture around: `resolveProjectScope` serves
 * the boot context for unscoped requests, for `/p/default/`, and for the boot project's own id, so
 * with `CEZ_KB=1` the knowledge base was dead on the only project the cockpit shows by default.
 * Both paths now go through `activateOptionalStores` (`project-context.ts`). The integration
 * assertion this file declined to make lives in `boot-project-stores.test.ts`.
 */

// `realpath(tmpdir())` FIRST — on macOS `/tmp` is a symlink to `/private/tmp`, and
// `resolveWritablePath` (knowledge/paths.ts) realpaths every write target. An unresolved
// `repoRoot` would make `KnowledgeStore.createDocument`'s post-write `findByPath` compare an
// unresolved scan path against a resolved write path and never match (`store.test.ts` avoids the
// same trap the same way).
async function tempDir(prefix: string): Promise<string> {
  const base = await realpath(tmpdir());
  const dir = await mkdtemp(join(base, prefix));
  dirs.push(dir);
  return dir;
}

const dirs: string[] = [];
const openKnowledgeStores: KnowledgeStore[] = [];
const openRunStores: RunStore[] = [];

afterEach(async () => {
  for (const store of openKnowledgeStores.splice(0)) store.dispose();
  for (const store of openRunStores.splice(0)) store.flush();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function appWithProject(project: ProjectContext) {
  return new Hono<ProjectApiEnv>()
    .use('*', async (c, next) => {
      c.set('project', project);
      await next();
    })
    .route('/api/v1', createKnowledgeRoutes());
}

async function buildProject(options: { withKnowledge?: boolean } = {}): Promise<{
  project: ProjectContext;
  repoRoot: string;
  dataDir: string;
  runStore: RunStore;
  knowledgeStore?: KnowledgeStore;
}> {
  const repoRoot = await tempDir('cez-kb-api-');
  const dataDir = join(repoRoot, '.ai/cezar');
  await mkdir(dataDir, { recursive: true });
  const runStore = RunStore.open(dataDir);
  openRunStores.push(runStore);

  let knowledgeStore: KnowledgeStore | undefined;
  if (options.withKnowledge ?? true) {
    knowledgeStore = KnowledgeStore.create(repoRoot, dataDir, { disableWatchers: true });
    openKnowledgeStores.push(knowledgeStore);
    await knowledgeStore.initialize();
  }

  const project: ProjectContext = {
    id: 'proj',
    root: repoRoot,
    dataDir,
    store: runStore,
    manager: {} as RunManager,
    automationStore: {} as AutomationStore,
    knowledgeStore,
    launchKey: 'test-launch-key',
  };
  return { project, repoRoot, dataDir, runStore, knowledgeStore };
}

const GET_ROUTES_OFF = [
  ['/api/v1/knowledge', { enabled: false, roots: [], counts: { documents: 0, idCollisions: 0 }, facets: { types: [], tags: [], statuses: [], roots: [], domains: [] }, scan: { truncated: false, filesScanned: 0, bytesScanned: 0, skipped: 0 }, formatVersion: 0 }],
  ['/api/v1/knowledge/search', { query: '', total: 0, truncated: false, results: [] }],
  ['/api/v1/knowledge/search?q=anything', { query: 'anything', total: 0, truncated: false, results: [] }],
  ['/api/v1/knowledge/documents', { documents: [], total: 0, truncated: false }],
  ['/api/v1/knowledge/proposals', { proposals: [] }],
  ['/api/v1/knowledge/some-id', { document: null }],
] as const;

describe('knowledge routes — flag off (no knowledgeStore on the project context)', () => {
  it('every GET answers 200 with the schema-valid empty shape, never 404', async () => {
    const { project } = await buildProject({ withKnowledge: false });
    const app = appWithProject(project);
    for (const [path, expected] of GET_ROUTES_OFF) {
      const res = await apiRequest(app, path);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(expected);
    }
  });

  it('every mutator answers 409 naming the flag, never 404', async () => {
    const { project } = await buildProject({ withKnowledge: false });
    const app = appWithProject(project);
    const json = (body: unknown, method = 'POST'): RequestInit => ({
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    const create = await apiRequest(app, '/api/v1/knowledge', json({ scope: 'project', path: 'a.md', content: '# A' }));
    expect(create.status).toBe(409);
    expect(await create.json()).toMatchObject({ error: expect.stringContaining('CEZ_KB=1') });

    const put = await apiRequest(app, '/api/v1/knowledge/some-id', json({ content: 'x', version: 'v' }, 'PUT'));
    expect(put.status).toBe(409);

    const del = await apiRequest(app, '/api/v1/knowledge/some-id', { method: 'DELETE' });
    expect(del.status).toBe(409);

    const reindex = await apiRequest(app, '/api/v1/knowledge/reindex', { method: 'POST' });
    expect(reindex.status).toBe(409);

    const apply = await apiRequest(app, '/api/v1/knowledge/proposals/apply', json({ runId: 'r1', seq: [0] }));
    expect(apply.status).toBe(409);
  });
});

describe('knowledge routes — flag on: CRUD wired to the real KnowledgeStore', () => {
  it('GET /knowledge reports enabled:true and real root/counts', async () => {
    const { project } = await buildProject();
    const app = appWithProject(project);
    const res = await apiRequest(app, '/api/v1/knowledge');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enabled: boolean; roots: { id: string }[]; counts: { documents: number } };
    expect(body.enabled).toBe(true);
    expect(body.roots.map((r) => r.id)).toEqual(expect.arrayContaining(['project', 'workspace']));
    expect(body.counts.documents).toBe(0);
  });

  it('POST /knowledge creates a document (201), GET /knowledge/:id reads it back, PUT updates it, DELETE removes it', async () => {
    const { project } = await buildProject();
    const app = appWithProject(project);
    const json = (body: unknown, method = 'POST'): RequestInit => ({
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    const created = await apiRequest(app, '/api/v1/knowledge', json({ scope: 'project', path: 'a.md', content: '# A\n\nbody' }));
    expect(created.status).toBe(201);
    const { document } = (await created.json()) as { document: { id: string; hash: string } };
    expect(document.id).toBeTruthy();

    const fetched = await apiRequest(app, `/api/v1/knowledge/${document.id}`);
    expect(fetched.status).toBe(200);
    expect(((await fetched.json()) as { document: { title: string } }).document.title).toBe('A');

    const missing = await apiRequest(app, '/api/v1/knowledge/does-not-exist');
    expect(missing.status).toBe(404);

    const staleUpdate = await apiRequest(app, `/api/v1/knowledge/${document.id}`, json({ content: '# A\n\nnew', version: 'wrong' }, 'PUT'));
    expect(staleUpdate.status).toBe(409);

    const update = await apiRequest(app, `/api/v1/knowledge/${document.id}`, json({ content: '# A\n\nnew', version: document.hash }, 'PUT'));
    expect(update.status).toBe(200);

    const removed = await apiRequest(app, `/api/v1/knowledge/${document.id}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ removed: true });

    const goneMissing = await apiRequest(app, `/api/v1/knowledge/${document.id}`, { method: 'DELETE' });
    expect(goneMissing.status).toBe(404);
  });

  it('PUT/DELETE refuse a mirrored (origin:remote) document with 409 (adopt first)', async () => {
    const { project, dataDir } = await buildProject();
    const sink = new FileSourceSink(dataDir, 'conn1');
    const doc: MirroredDocument = {
      docId: 'mirroreddoc00001',
      title: 'Mirrored Doc',
      source: {
        kind: 'notion',
        connectionId: 'conn1',
        externalId: 'ext-1',
        url: 'https://example.invalid/p/1',
        remoteVersion: '2026-08-06T00:00:00.000Z',
        origin: 'remote',
        state: 'conflict',
        mirroredAt: new Date().toISOString(),
        lossy: [],
      },
      collectionExternalId: 'coll-1',
      docType: 'page',
      properties: {},
      unresolvedComments: 0,
    };
    await sink.upsert(doc, '# Mirrored Doc\n\nFrom the mirror.');
    await project.knowledgeStore!.reindexNow();

    const app = appWithProject(project);
    const searchRes = await apiRequest(app, '/api/v1/knowledge/search?q=Mirrored');
    const searchBody = (await searchRes.json()) as { results: { id: string; source?: { state: string } }[] };
    const found = searchBody.results.find((r) => r.source);
    expect(found).toBeDefined();
    // C21: `source` (including the conflict state) survives to the wire, on the search result.
    expect(found?.source).toMatchObject({ origin: 'remote', state: 'conflict' });

    const idRes = await apiRequest(app, `/api/v1/knowledge/${found!.id}`);
    const idBody = (await idRes.json()) as { document: { source?: { state: string } } };
    // C21: `source` also survives on `GET /knowledge/:id`.
    expect(idBody.document.source).toMatchObject({ origin: 'remote', state: 'conflict' });

    const json = (body: unknown, method = 'PUT'): RequestInit => ({
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const putRes = await apiRequest(app, `/api/v1/knowledge/${found!.id}`, json({ content: 'nope', version: 'irrelevant' }));
    expect(putRes.status).toBe(409);

    const delRes = await apiRequest(app, `/api/v1/knowledge/${found!.id}`, { method: 'DELETE' });
    expect(delRes.status).toBe(409);
  });

  it('POST /knowledge/reindex reports formatVersion and scan', async () => {
    const { project } = await buildProject();
    const app = appWithProject(project);
    const res = await apiRequest(app, '/api/v1/knowledge/reindex', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ formatVersion: expect.any(Number), scan: expect.any(Object) });
  });

  it('C10: two consecutive GET /knowledge and GET /knowledge/search bodies are byte identical', async () => {
    const { project } = await buildProject();
    const app = appWithProject(project);
    const first = await (await apiRequest(app, '/api/v1/knowledge')).text();
    const second = await (await apiRequest(app, '/api/v1/knowledge')).text();
    expect(first).toBe(second);

    const s1 = await (await apiRequest(app, '/api/v1/knowledge/search?q=whatever')).text();
    const s2 = await (await apiRequest(app, '/api/v1/knowledge/search?q=whatever')).text();
    expect(s1).toBe(s2);
  });

  it('deterministic ordering: repeated searches return results in the same order', async () => {
    const { project } = await buildProject();
    const app = appWithProject(project);
    const json = (body: unknown): RequestInit => ({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    await apiRequest(app, '/api/v1/knowledge', json({ scope: 'project', path: 'one.md', content: '# One\n\nshared term' }));
    await apiRequest(app, '/api/v1/knowledge', json({ scope: 'project', path: 'two.md', content: '# Two\n\nshared term' }));

    const first = (await (await apiRequest(app, '/api/v1/knowledge/search?q=shared')).json()) as { results: { id: string }[] };
    const second = (await (await apiRequest(app, '/api/v1/knowledge/search?q=shared')).json()) as { results: { id: string }[] };
    expect(first.results.map((r) => r.id)).toEqual(second.results.map((r) => r.id));
    expect(first.results.length).toBe(2);
  });
});

describe('GET /knowledge/documents — the browseable catalog (skills-preview parity)', () => {
  it('returns entries sorted updatedAt desc / id tie-break, carrying no body and no links', async () => {
    const { project } = await buildProject();
    const app = appWithProject(project);
    const json = (body: unknown): RequestInit => ({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    // Explicit frontmatter `updatedAt` (not mtime), so ordering is deterministic rather than
    // timing-dependent — `parse.ts` prefers frontmatter `updatedAt` over the file's mtime.
    await apiRequest(
      app,
      '/api/v1/knowledge',
      json({
        scope: 'project',
        path: 'older.md',
        content: '---\nupdatedAt: 2026-01-01T00:00:00.000Z\n---\n# Older\n\nolder body',
      }),
    );
    await apiRequest(
      app,
      '/api/v1/knowledge',
      json({
        scope: 'project',
        path: 'newer.md',
        content: '---\nupdatedAt: 2026-06-01T00:00:00.000Z\n---\n# Newer\n\nnewer body',
      }),
    );

    const res = await apiRequest(app, '/api/v1/knowledge/documents');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      documents: Array<Record<string, unknown>>;
      total: number;
      truncated: boolean;
    };

    expect(body.total).toBe(2);
    expect(body.truncated).toBe(false);
    expect(body.documents.map((d) => d.title)).toEqual(['Newer', 'Older']);
    for (const doc of body.documents) {
      expect(doc.body).toBeUndefined();
      expect(doc.links).toBeUndefined();
      expect(doc.title).toBeTruthy();
    }
  });

  it('tie-breaks equal updatedAt by id ascending', async () => {
    const { project } = await buildProject();
    const app = appWithProject(project);
    const json = (body: unknown): RequestInit => ({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const sameStamp = '2026-03-01T00:00:00.000Z';
    await apiRequest(app, '/api/v1/knowledge', json({ scope: 'project', path: 'b.md', content: `---\nupdatedAt: ${sameStamp}\n---\n# B\n\nbody` }));
    await apiRequest(app, '/api/v1/knowledge', json({ scope: 'project', path: 'a.md', content: `---\nupdatedAt: ${sameStamp}\n---\n# A\n\nbody` }));

    const res = await apiRequest(app, '/api/v1/knowledge/documents');
    const body = (await res.json()) as { documents: Array<{ id: string }> };
    expect(body.documents).toHaveLength(2);
    const [first, second] = body.documents;
    expect(first!.id.localeCompare(second!.id)).toBeLessThan(0);
  });

  it('truncated propagates from the store scan', async () => {
    const repoRoot = await tempDir('cez-kb-docs-trunc-');
    const dataDir = join(repoRoot, '.ai/cezar');
    await mkdir(dataDir, { recursive: true });
    const runStore = RunStore.open(dataDir);
    openRunStores.push(runStore);

    // A one-file cap forces `scan.truncated: true` once a second document exists — same cap
    // shape `KnowledgeStoreOptions.caps` (`catalog.ts`'s `ScanCaps`) the store exposes for tests.
    const knowledgeStore = KnowledgeStore.create(repoRoot, dataDir, {
      disableWatchers: true,
      caps: { maxFileBytes: 1_000_000, maxFiles: 1, maxTotalBytes: 10_000_000 },
    });
    openKnowledgeStores.push(knowledgeStore);
    await knowledgeStore.initialize();

    const project: ProjectContext = {
      id: 'proj',
      root: repoRoot,
      dataDir,
      store: runStore,
      manager: {} as RunManager,
      automationStore: {} as AutomationStore,
      knowledgeStore,
      launchKey: 'test-launch-key',
    };
    const app = appWithProject(project);
    const json = (body: unknown): RequestInit => ({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    await apiRequest(app, '/api/v1/knowledge', json({ scope: 'project', path: 'one.md', content: '# One\n\nbody' }));
    await apiRequest(app, '/api/v1/knowledge', json({ scope: 'project', path: 'two.md', content: '# Two\n\nbody' }));
    await knowledgeStore.reindexNow();

    const res = await apiRequest(app, '/api/v1/knowledge/documents');
    const body = (await res.json()) as { truncated: boolean };
    expect(body.truncated).toBe(true);
  });
});

describe('knowledge routes — proposals (routes 7/8)', () => {
  it('GET /knowledge/proposals reads valid NDJSON lines and drops a malformed trailing line', async () => {
    const { project, dataDir } = await buildProject();
    const runsDir = join(dataDir, 'runs');
    await mkdir(runsDir, { recursive: true });
    const lines = [
      JSON.stringify({ op: 'upsert', seq: 0, runId: 'run-1', createdAt: '2026-08-06T00:00:00.000Z', scope: 'project', path: 'a.md', body: '# A' }),
      'not even json',
    ].join('\n');
    await writeFile(join(runsDir, 'run-1.knowledge.ndjson'), `${lines}\n`, 'utf8');

    const app = appWithProject(project);
    const res = await apiRequest(app, '/api/v1/knowledge/proposals');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { proposals: { seq: number; runId: string }[] };
    expect(body.proposals).toHaveLength(1);
    expect(body.proposals[0]).toMatchObject({ seq: 0, runId: 'run-1' });
  });

  it('POST /knowledge/proposals/apply 404s an unknown run', async () => {
    const { project } = await buildProject();
    const app = appWithProject(project);
    const res = await apiRequest(app, '/api/v1/knowledge/proposals/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'no-such-run', seq: [0] }),
    });
    expect(res.status).toBe(404);
  });

  it('POST /knowledge/proposals/apply never fakes success: applied stays empty, refused carries a reason', async () => {
    const { project, dataDir, runStore } = await buildProject();
    const run = runStore.createRun({ author: localCliAuthor(), title: 'a run', workflow: 'w', task: 't', steps: [] });
    const runsDir = join(dataDir, 'runs');
    await mkdir(runsDir, { recursive: true });
    await writeFile(
      join(runsDir, `${run.id}.knowledge.ndjson`),
      `${JSON.stringify({ op: 'upsert', seq: 0, runId: run.id, createdAt: '2026-08-06T00:00:00.000Z', scope: 'project', path: 'a.md', body: '# A' })}\n`,
      'utf8',
    );

    const app = appWithProject(project);
    const res = await apiRequest(app, '/api/v1/knowledge/proposals/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: run.id, seq: [0, 1] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { applied: number[]; refused: { seq: number; reason: string }[] };
    expect(body.applied).toEqual([]);
    expect(body.refused).toEqual([
      { seq: 0, reason: expect.stringContaining('not implemented') },
      { seq: 1, reason: 'no such proposal' },
    ]);
  });
});
