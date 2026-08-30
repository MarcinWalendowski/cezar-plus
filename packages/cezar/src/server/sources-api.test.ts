import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { FileSourceSink } from '../sources/sink.ts';
import type { SourceDocumentRef, SourceProvider } from '../sources/provider-types.ts';
import { SourceRuntime } from '../sources/runtime.ts';
import { SourceStore } from '../sources/store.ts';
import { mirroredDocumentSchema, type MirroredDocument } from '../sources/types.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { ProjectContexts } from './project-context.ts';
import { createApp } from './server.ts';

/**
 * `sources-routes.ts` (F2 HTTP handlers, W4.6). See
 * `.ai/specs/2026-08-06-external-source-connectors-notion.md` ("API Contracts", "Phase 4") and
 * `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md` D19.
 *
 * The tests inject the runtime-owned SourceStore into both the boot and lazy project contexts, the
 * same instance the scheduler uses. That keeps each route request and the workspace scheduler on
 * one durable source view.
 */
describe('sources HTTP handlers (F2, CEZ_SOURCES)', () => {
  let bootRoot: string;
  let projectRoot: string;
  let bootStore: RunStore;
  const runtimes: SourceRuntime[] = [];

  beforeEach(() => {
    bootRoot = mkdtempSync(join(tmpdir(), 'cezar-sources-api-boot-'));
    projectRoot = mkdtempSync(join(tmpdir(), 'cezar-sources-api-proj-'));
    mkdirSync(join(bootRoot, '.ai/cezar'), { recursive: true });
    bootStore = RunStore.open(join(bootRoot, '.ai/cezar'));
  });

  afterEach(() => {
    for (const runtime of runtimes.splice(0)) void runtime.stop();
    bootStore.flush();
    rmSync(bootRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function app(
    env: NodeJS.ProcessEnv,
    resolveProvider: () => SourceProvider = testProvider,
  ): ReturnType<typeof createApp> {
    const runtime = env.CEZ_SOURCES === '1'
      ? new SourceRuntime({
          listProjects: async () => [{ id: 'proj', root: projectRoot, status: 'not-git' as const }],
          bootProjectId: 'boot',
          bootRoot,
          env,
          resolveProvider,
        })
      : undefined;
    if (runtime) runtimes.push(runtime);
    const contexts = new ProjectContexts({
      listProjects: async () => [{ id: 'proj', root: projectRoot, status: 'not-git' as const }],
      env,
      sourceStore: runtime ? (projectId, root) => runtime.store(projectId, root)! : undefined,
    });
    return createApp({ repoRoot: bootRoot, store: bootStore, manager: {} as RunManager, version: 'test', contexts, sourceRuntime: runtime });
  }

  function testProvider(): SourceProvider {
    return {
      kind: 'notion',
      capabilities: { list: true, fetch: true, poll: true, push: false, comments: false },
      detect: async () => ({ available: true }),
      detectCached: () => ({ available: true }),
      listCollections: async () => [],
      listDocuments: async () => ({ documents: [], nextPageCursor: null, complete: true, truncated: false }),
      fetchDocument: async () => null,
      pollChanges: async () => ({ changes: [], watermark: null, nextPageCursor: null, complete: true, truncated: false }),
      viewUrl: () => null,
    };
  }

  const json = (body: unknown, method = 'POST'): RequestInit => ({
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  // ---- structural checks (D8, and "routes never read a boot-time singleton") -------------------

  it('never reads a boot-time singleton and never reads the clock (D8) — the routes read only c.get(\'project\')', () => {
    const path = fileURLToPath(new URL('./sources-routes.ts', import.meta.url));
    const source = readFileSync(path, 'utf8');
    expect(source).not.toMatch(/bootContext|bootStore/);
    expect(source).not.toMatch(/Date\.now\(\)|new Date\(\)/);
  });

  // ---- flag off: D19, NC-8 --------------------------------------------------------------------

  describe('CEZ_SOURCES unset', () => {
    const OFF: NodeJS.ProcessEnv = {};

    it('every GET answers 200 with an empty payload, every mutator answers 409, and nothing ever answers 404', async () => {
      const server = app(OFF);
      const gets: Array<[string, unknown]> = [
        ['/api/v1/sources', { connections: [] }],
        ['/api/v1/sources/providers', { providers: [] }],
        ['/api/v1/sources/conn-1/collections', { collections: [] }],
        ['/api/v1/sources/conn-1/documents', { documents: [] }],
        ['/api/v1/sources/conn-1/documents/doc-1', { document: null }],
        ['/api/v1/sources/conn-1/comments', { comments: [] }],
        ['/api/v1/sources/conn-1/log', { rows: [] }],
      ];
      for (const [path, expected] of gets) {
        const res = await apiRequest(server, path);
        expect(res.status, path).toBe(200);
        expect(await res.json(), path).toEqual(expected);
      }

      const mutators: Array<[string, RequestInit]> = [
        ['/api/v1/sources', json({ kind: 'notion', name: 'x' })],
        ['/api/v1/sources/conn-1', json({ kind: 'notion', name: 'x', expectedRevision: 1 }, 'PUT')],
        ['/api/v1/sources/conn-1', { method: 'DELETE' }],
        ['/api/v1/sources/conn-1/sync', { method: 'POST' }],
        ['/api/v1/sources/conn-1/documents/doc-1/adopt', { method: 'POST' }],
        ['/api/v1/sources/conn-1/documents/doc-1/resolve', json({ action: 'keep-local' })],
      ];
      for (const [path, init] of mutators) {
        const res = await apiRequest(server, path, init);
        expect(res.status, path).toBe(409);
        expect(res.status, path).not.toBe(404);
      }
    });

    it('the same empty/409 shape holds through the /p/:projectId spelling of a NON-boot project too', async () => {
      const res = await apiRequest(app(OFF), '/api/v1/p/proj/sources');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ connections: [] });
    });
  });

  // ---- flag on: connections CRUD, providers catalog, collections browse ------------------------

  describe('CEZ_SOURCES=1', () => {
    const ON: NodeJS.ProcessEnv = { CEZ_SOURCES: '1' };
    const base = '/api/v1/p/proj';

    it('creates a connection with server-applied defaults, a stored availability, and never-synced state', async () => {
      const server = app(ON);
      const res = await apiRequest(
        server,
        `${base}/sources`,
        json({ kind: 'notion', name: 'Team wiki', collections: [{ externalId: 'db-1', collectionKind: 'database' }] }),
      );
      expect(res.status).toBe(201);
      const { connection } = (await res.json()) as { connection: Record<string, unknown> };
      expect(connection).toMatchObject({
        kind: 'notion',
        name: 'Team wiki',
        revision: 1,
        enabled: true,
        mode: 'mirror',
        intervalSeconds: 900,
        syncState: 'never-synced',
        documentCount: 0,
        conflictCount: 0,
        unresolvedComments: 0,
        complete: false,
      });
      // No token configured in this process env: the wire's `availability` is a REQUIRED,
      // concrete value (unlike forge's optional field) rather than absent.
      expect(connection.availability).toEqual({
        available: false,
        reason: expect.stringContaining('CEZ_NOTION_TOKEN'),
      });
      expect((connection.collections as Array<Record<string, unknown>>)[0]).toMatchObject({
        externalId: 'db-1',
        collectionKind: 'database',
        maxDepth: 3,
        splitOnHeading: 'h2',
      });

      const listed = await (await apiRequest(server, `${base}/sources`)).json();
      expect((listed as { connections: unknown[] }).connections).toHaveLength(1);
    });

    it('PUT enforces optimistic concurrency and 404s an unknown id; DELETE tombstones and 404s a repeat', async () => {
      const server = app(ON);
      const created = ((await (await apiRequest(server, `${base}/sources`, json({ kind: 'notion', name: 'A' }))).json()) as {
        connection: { id: string; revision: number };
      }).connection;

      const stale = await apiRequest(
        server,
        `${base}/sources/${created.id}`,
        json({ kind: 'notion', name: 'B', expectedRevision: created.revision + 1 }, 'PUT'),
      );
      expect(stale.status).toBe(409);

      const fresh = await apiRequest(
        server,
        `${base}/sources/${created.id}`,
        json({ kind: 'notion', name: 'B', expectedRevision: created.revision }, 'PUT'),
      );
      expect(fresh.status).toBe(200);
      expect(((await fresh.json()) as { connection: { name: string; revision: number } }).connection).toMatchObject({
        name: 'B',
        revision: created.revision + 1,
      });

      const unknownPut = await apiRequest(server, `${base}/sources/nope`, json({ kind: 'notion', name: 'B', expectedRevision: 1 }, 'PUT'));
      expect(unknownPut.status).toBe(404);

      const deleted = await apiRequest(server, `${base}/sources/${created.id}`, { method: 'DELETE' });
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toEqual({ removed: true });

      const deletedAgain = await apiRequest(server, `${base}/sources/${created.id}`, { method: 'DELETE' });
      expect(deletedAgain.status).toBe(404);
    });

    it('persists paused state for disabled and archived connections, and makes re-enable immediately due', async () => {
      const server = app(ON);
      const created = ((await (await apiRequest(server, `${base}/sources`, json({ kind: 'notion', name: 'Stateful' }))).json()) as {
        connection: { id: string; revision: number };
      }).connection;

      const disabled = await apiRequest(
        server,
        `${base}/sources/${created.id}`,
        json({ kind: 'notion', name: 'Stateful', enabled: false, expectedRevision: created.revision }, 'PUT'),
      );
      expect(disabled.status).toBe(200);
      const disabledConnection = (await disabled.json() as { connection: Record<string, unknown> }).connection;
      expect(disabledConnection).toMatchObject({ enabled: false, syncState: 'paused' });
      expect(disabledConnection.syncStateAt).toBe(disabledConnection.updatedAt);

      const reenabled = await apiRequest(
        server,
        `${base}/sources/${created.id}`,
        json({ kind: 'notion', name: 'Stateful', enabled: true, expectedRevision: disabledConnection.revision }, 'PUT'),
      );
      expect(reenabled.status).toBe(200);
      const reenabledConnection = (await reenabled.json() as { connection: Record<string, unknown> }).connection;
      expect(reenabledConnection.nextDueAt).toBe(reenabledConnection.updatedAt);

      const archived = await apiRequest(
        server,
        `${base}/sources/${created.id}`,
        json({ kind: 'notion', name: 'Stateful', mode: 'archived', expectedRevision: reenabledConnection.revision }, 'PUT'),
      );
      expect(archived.status).toBe(200);
      expect((await archived.json() as { connection: Record<string, unknown> }).connection).toMatchObject({
        mode: 'archived',
        syncState: 'paused',
      });
    });

    it('creates disabled connections already paused', async () => {
      const response = await apiRequest(
        app(ON),
        `${base}/sources`,
        json({ kind: 'notion', name: 'Paused from birth', enabled: false }),
      );
      expect(response.status).toBe(201);
      expect((await response.json() as { connection: Record<string, unknown> }).connection).toMatchObject({
        enabled: false,
        syncState: 'paused',
      });
    });

    it('the providers catalog lists notion with capability data, a credential hint, and never a token field', async () => {
      const res = await apiRequest(app(ON), `${base}/sources/providers`);
      const { providers } = (await res.json()) as { providers: Array<Record<string, unknown>> };
      const notion = providers.find((p) => p.kind === 'notion');
      expect(notion).toMatchObject({
        capabilities: { list: true, fetch: true, poll: true, push: false, comments: true },
        availability: { available: false },
      });
      expect(String(notion?.credentialHint)).toContain('CEZ_NOTION_TOKEN');
      expect(JSON.stringify(notion)).not.toMatch(/"token"/i);
    });

    it('collections browse reflects the connection\'s own configured collections; unknown connection 404s', async () => {
      const server = app(ON);
      const created = ((await (await apiRequest(
        server,
        `${base}/sources`,
        json({ kind: 'notion', name: 'A', collections: [{ externalId: 'db-1', collectionKind: 'database', label: 'Tasks' }] }),
      )).json()) as { connection: { id: string } }).connection;

      const res = await apiRequest(server, `${base}/sources/${created.id}/collections`);
      expect(await res.json()).toEqual({ collections: [{ externalId: 'db-1', collectionKind: 'database', label: 'Tasks' }] });

      const unknown = await apiRequest(server, `${base}/sources/nope/collections`);
      expect(unknown.status).toBe(404);
    });

    it('comments route reads the durable per-connection comment stream', async () => {
      const server = app(ON);
      const created = ((await (await apiRequest(
        server,
        `${base}/sources`,
        json({ kind: 'notion', name: 'Comments', watchComments: true }),
      )).json()) as { connection: { id: string } }).connection;
      const sourceStore = runtimes.at(-1)!.store('proj', projectRoot)!;
      sourceStore.appendComments(created.id, 'doc-1', [{
        externalId: 'comment-1',
        author: 'user-1',
        body: 'Keep this separate from the document body.',
        createdAt: '2026-08-30T00:00:00.000Z',
        attachments: [{ type: 'image', downloadable: false }],
      }]);

      const response = await apiRequest(server, `${base}/sources/${created.id}/comments`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        comments: [{
          id: 'comment-1',
          docId: 'doc-1',
          externalId: 'comment-1',
          author: 'user-1',
          body: 'Keep this separate from the document body.',
          createdAt: '2026-08-30T00:00:00.000Z',
          attachments: [{ type: 'image', downloadable: false }],
        }],
      });
    });

    // ---- the headline control: a document GET carries STORED provenance, never computed --------

    it('a document GET carries the STORED mirroredAt and syncState, byte-identical across repeated requests', async () => {
      const server = app(ON);
      const created = ((await (await apiRequest(server, `${base}/sources`, json({ kind: 'notion', name: 'A' }))).json()) as {
        connection: { id: string };
      }).connection;

      const dataDir = join(projectRoot, '.ai/cezar');
      const sink = new FileSourceSink(dataDir, created.id);
      const doc: MirroredDocument = mirroredDocumentSchema.parse({
        docId: '0123456789abcdef',
        title: 'Sample Page',
        source: {
          kind: 'notion',
          connectionId: created.id,
          externalId: 'ext-1',
          url: 'https://notion.so/ext-1',
          remoteVersion: 'v1',
          mirroredAt: '2026-08-01T00:00:00.000Z',
        },
        collectionExternalId: 'db-1',
      });
      await sink.upsert(doc, 'Hello from Notion.');

      const bodies: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const res = await apiRequest(server, `${base}/sources/${created.id}/documents/${doc.docId}`);
        expect(res.status).toBe(200);
        bodies.push(await res.text());
      }
      expect(bodies[0]).toBe(bodies[1]);
      expect(bodies[1]).toBe(bodies[2]);
      const parsed = JSON.parse(bodies[0]!) as { document: Record<string, unknown> };
      expect(parsed.document).toMatchObject({
        docId: doc.docId,
        mirroredAt: '2026-08-01T00:00:00.000Z',
        syncState: 'never-synced',
        body: 'Hello from Notion.',
      });

      const list = await (await apiRequest(server, `${base}/sources/${created.id}/documents`)).json();
      expect((list as { documents: Array<Record<string, unknown>> }).documents[0]).not.toHaveProperty('body');
    });

    it('adopt moves the document out of the mirror into the knowledge root, and a repeat 404s', async () => {
      const server = app(ON);
      const created = ((await (await apiRequest(server, `${base}/sources`, json({ kind: 'notion', name: 'A' }))).json()) as {
        connection: { id: string };
      }).connection;

      const dataDir = join(projectRoot, '.ai/cezar');
      const sink = new FileSourceSink(dataDir, created.id);
      const doc: MirroredDocument = mirroredDocumentSchema.parse({
        docId: 'fedcba9876543210',
        title: 'Adopt me',
        source: {
          kind: 'notion',
          connectionId: created.id,
          externalId: 'ext-2',
          url: 'https://notion.so/ext-2',
          remoteVersion: 'v1',
          mirroredAt: '2026-08-01T00:00:00.000Z',
        },
        collectionExternalId: 'db-1',
      });
      await sink.upsert(doc, 'Body.');

      const res = await apiRequest(server, `${base}/sources/${created.id}/documents/${doc.docId}/adopt`, { method: 'POST' });
      expect(res.status).toBe(200);
      const { path, adoptedAt } = (await res.json()) as { path: string; adoptedAt: string };
      expect(path).toBe(join(dataDir, 'knowledge', `${doc.docId}.md`));
      expect(existsSync(path)).toBe(true);
      expect(adoptedAt).toBeTruthy();
      expect(existsSync(join(dataDir, 'sources', created.id, `${doc.docId}.md`))).toBe(false);

      // Gone from the mirror's own read path — never a fabricated 200 for a moved document.
      const gone = await apiRequest(server, `${base}/sources/${created.id}/documents/${doc.docId}`);
      expect(await gone.json()).toEqual({ document: null });

      const repeat = await apiRequest(server, `${base}/sources/${created.id}/documents/${doc.docId}/adopt`, { method: 'POST' });
      expect(repeat.status).toBe(404);
    });

    it('manual sync returns 202 and resolve rejects a non-conflict document', async () => {
      const server = app(ON);
      const created = ((await (await apiRequest(server, `${base}/sources`, json({ kind: 'notion', name: 'A' }))).json()) as {
        connection: { id: string; revision: number };
      }).connection;

      const sync = await apiRequest(server, `${base}/sources/${created.id}/sync`, { method: 'POST' });
      expect(sync.status).toBe(202);
      expect(((await sync.json()) as { syncId: string }).syncId).toBeTruthy();

      const resolve = await apiRequest(
        server,
        `${base}/sources/${created.id}/documents/doc-1/resolve`,
        json({ action: 'keep-local' }),
      );
      expect(resolve.status).toBe(409);
      expect(((await resolve.json()) as { error: string }).error).toMatch(/not in conflict/i);

      // A well-formed but unknown connection id still 404s before the "pending" answer — the
      // pending 409 is not used to paper over a bad id.
      const unknownSync = await apiRequest(server, `${base}/sources/nope/sync`, { method: 'POST' });
      expect(unknownSync.status).toBe(404);
    });

    it('resolves both conflict actions through the current remote ref and preserves displaced bytes', async () => {
      const currentRef: SourceDocumentRef = {
        externalId: 'doc-1',
        collectionExternalId: 'db-1',
        title: 'Current document',
        url: 'https://notion.so/doc-1',
        remoteVersion: 'v4',
        docType: 'row',
        properties: {},
      };
      const server = app(ON, () => ({
        ...testProvider(),
        listDocuments: async () => ({
          documents: [currentRef],
          nextPageCursor: null,
          complete: true,
          truncated: false,
          callsUsed: 1,
        }),
        fetchDocument: async (ref) => ({ ...ref, body: 'Current remote body.', lossy: [] }),
      }));
      const created = ((await (await apiRequest(
        server,
        `${base}/sources`,
        json({ kind: 'notion', name: 'Conflicts', collections: [{ externalId: 'db-1', collectionKind: 'database' }] }),
      )).json()) as { connection: { id: string } }).connection;
      const dataDir = join(projectRoot, '.ai/cezar');
      const sink = new FileSourceSink(dataDir, created.id);
      const docId = '0123456789abcdef';
      const doc: MirroredDocument = mirroredDocumentSchema.parse({
        docId,
        title: 'Original document',
        source: {
          kind: 'notion',
          connectionId: created.id,
          externalId: 'doc-1',
          url: currentRef.url,
          remoteVersion: 'v1',
          mirroredAt: '2026-08-30T00:00:00.000Z',
        },
        collectionExternalId: 'db-1',
        remoteVersionSeen: 'v1',
      });
      await sink.upsert(doc, 'Local keep body.');
      const path = join(dataDir, 'sources', created.id, `${docId}.md`);
      writeFileSync(path, readFileSync(path, 'utf8').replace('Local keep body.', 'Local keep body edited.'));
      await sink.quarantine(docId, 'stale-v2', 'Stale remote body.');

      const keep = await apiRequest(server, `${base}/sources/${created.id}/documents/${docId}/resolve`, json({ action: 'keep-local' }));
      expect(keep.status).toBe(200);
      expect((await sink.readMeta(docId))?.source.state).toBe('ok');
      expect((await sink.readMeta(docId))?.remoteVersionSeen).toBe('v4');
      expect((await sink.read(docId))?.body).toBe('Local keep body edited.');

      const resolved = await sink.readMeta(docId);
      if (!resolved) throw new Error('resolved document disappeared');
      await sink.upsert(resolved, 'Local take body edited.');
      await sink.quarantine(docId, 'stale-v3', 'Stale second remote body.');
      const take = await apiRequest(server, `${base}/sources/${created.id}/documents/${docId}/resolve`, json({ action: 'take-remote' }));
      expect(take.status).toBe(200);
      expect((await sink.read(docId))?.body).toBe('Current remote body.');
      const conflicts = readdirSync(join(dataDir, 'sources', created.id, 'conflicts'));
      expect(conflicts.some((name) => name.startsWith(`${docId}.local-`))).toBe(true);
      expect(conflicts.map((name) => readFileSync(join(dataDir, 'sources', created.id, 'conflicts', name), 'utf8'))).toContain(
        'Local take body edited.',
      );
    });

    it('the log route paginates by a numeric cursor, newest first', async () => {
      const dataDir = join(projectRoot, '.ai/cezar');
      const store = SourceStore.open(dataDir);
      const connection = store.create({
        kind: 'notion',
        name: 'A',
        enabled: false,
        mode: 'mirror',
        intervalSeconds: 900,
        collections: [],
        watchComments: false,
        maxDocuments: 5_000,
        maxBodyBytes: 524_288,
      });
      store.appendLog({ connectionId: connection.id, event: 'sweep-start' });
      store.appendLog({ connectionId: connection.id, event: 'sweep-ok', message: 'done' });
      store.appendLog({ connectionId: connection.id, event: 'sweep-start' });

      const server = app(ON);
      const first = await apiRequest(server, `${base}/sources/${connection.id}/log?limit=2`);
      const firstBody = (await first.json()) as { rows: Array<{ event: string }>; nextCursor?: string };
      expect(firstBody.rows).toHaveLength(2);
      expect(firstBody.rows[0]!.event).toBe('sweep-start'); // newest first
      expect(firstBody.nextCursor).toBeDefined();

      const second = await apiRequest(server, `${base}/sources/${connection.id}/log?limit=2&cursor=${firstBody.nextCursor}`);
      const secondBody = (await second.json()) as { rows: Array<{ event: string }> };
      expect(secondBody.rows).toHaveLength(1);
    });
  });
});
