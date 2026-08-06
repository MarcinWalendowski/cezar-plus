import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { FileSourceSink } from '../sources/sink.ts';
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
 * **Why the "on" cases go through a NON-boot project.** `server.ts`'s `bootContext` (the object
 * every unscoped `/api/v1/...` request AND the `default`/boot-id `/p/:projectId` spellings resolve
 * to) is built without a `sourceStore` field at all — unlike `ProjectContexts.build()`, which wires
 * it correctly under `CEZ_SOURCES=1` (`project-context.test.ts`'s own "central-hub activation"
 * suite proves that half). That gap is in `server.ts`, which this package does not own (plan D6),
 * so it is reported rather than patched here — see the implementation report. Routing every "flag
 * on" case through a project registered under its OWN id (never `default`, never the boot id) is
 * what keeps this suite green regardless of that gap AND is what a real second project already
 * exercises correctly today.
 */
describe('sources HTTP handlers (F2, CEZ_SOURCES)', () => {
  let bootRoot: string;
  let projectRoot: string;
  let bootStore: RunStore;

  beforeEach(() => {
    bootRoot = mkdtempSync(join(tmpdir(), 'cezar-sources-api-boot-'));
    projectRoot = mkdtempSync(join(tmpdir(), 'cezar-sources-api-proj-'));
    mkdirSync(join(bootRoot, '.ai/cezar'), { recursive: true });
    bootStore = RunStore.open(join(bootRoot, '.ai/cezar'));
  });

  afterEach(() => {
    bootStore.flush();
    rmSync(bootRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function app(env: NodeJS.ProcessEnv): ReturnType<typeof createApp> {
    const contexts = new ProjectContexts({
      listProjects: async () => [{ id: 'proj', root: projectRoot, status: 'not-git' as const }],
      env,
    });
    return createApp({ repoRoot: bootRoot, store: bootStore, manager: {} as RunManager, version: 'test', contexts });
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
        enabled: false,
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

    it('sync and resolve stay 409 even with the flag on — the sweep (plan W4.4) has not landed', async () => {
      const server = app(ON);
      const created = ((await (await apiRequest(server, `${base}/sources`, json({ kind: 'notion', name: 'A' }))).json()) as {
        connection: { id: string };
      }).connection;

      const sync = await apiRequest(server, `${base}/sources/${created.id}/sync`, { method: 'POST' });
      expect(sync.status).toBe(409);
      expect(((await sync.json()) as { error: string }).error).toMatch(/sync engine/i);

      const resolve = await apiRequest(
        server,
        `${base}/sources/${created.id}/documents/doc-1/resolve`,
        json({ action: 'keep-local' }),
      );
      expect(resolve.status).toBe(409);
      expect(((await resolve.json()) as { error: string }).error).toMatch(/conflict resolution/i);

      // A well-formed but unknown connection id still 404s before the "pending" answer — the
      // pending 409 is not used to paper over a bad id.
      const unknownSync = await apiRequest(server, `${base}/sources/nope/sync`, { method: 'POST' });
      expect(unknownSync.status).toBe(404);
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
