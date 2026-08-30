import { Hono } from 'hono';
import { z } from 'zod';
import {
  createSourceConnectionInputSchema,
  resolveSourceConflictInputSchema,
  updateSourceConnectionInputSchema,
  type AdoptSourceDocumentResponse,
  type SourceCollectionRef as SourceCollectionRefWire,
  type SourceCollectionsResponse,
  type SourceCommentsResponse,
  type SourceConnectionResponse,
  type SourceConnectionWire,
  type SourceDocumentResponse,
  type SourceDocumentsResponse,
  type SourceDocumentWire,
  type SourceLogResponse,
  type SourceProviderInfo,
  type SourceProvidersResponse,
  type SourceRemoteCollection,
  type SourceRemovedResponse,
  type SourceSyncKickResponse,
  type ResolveSourceConflictResponse,
  type SourceSyncState,
  type SourcesListResponse,
} from '@loki-labs/cezar-plus-contract';
import { jsonZodValidator, queryZodValidator } from './validators.ts';
import type { ProjectApiEnv } from './server.ts';
import { NOTION_SOURCE_KIND } from '../sources/notion/provider.ts';
import type { SourceAvailability, SourceProvider } from '../sources/provider-types.ts';
import { resolveSourceProvider, SOURCE_PROVIDERS } from '../sources/registry.ts';
import { FileSourceSink } from '../sources/sink.ts';
import type { SourceStore } from '../sources/store.ts';
import type { MirroredDocumentMeta, SourceCollectionRef, SourceConnection, SourceSink, SourceState } from '../sources/types.ts';
import { resolveSourceConflict } from '../sources/conflicts.ts';
import type { SourceRuntime } from '../sources/runtime.ts';

/**
 * The SOURCES family of `/api/v1` (F2, `CEZ_SOURCES=1`). See
 * `.ai/specs/2026-08-06-external-source-connectors-notion.md` ("API Contracts", 13 routes) and
 * `.ai/runs/2026-08-06-cezar-central-hub/PLAN.md` D19.
 *
 * Every handler reads its state from `c.get('project')` (`sourceStore`, `dataDir`) — never a
 * boot-time singleton — so the family behaves identically mounted unscoped, at `/p/default` or at
 * `/p/:projectId` (`route-parity.test.ts`). `FileSourceSink` (the "default, standalone"
 * implementation, `sink.ts`'s own header) is constructed per request, bound to `(dataDir,
 * connectionId)`. The runtime wraps it with the resident project's knowledge sink when
 * `CEZ_KB=1`, while non-resident projects use the standalone sink until their context exists.
 *
 * Chained into ONE family with an INFERRED return type, mounted into `v1` (project-scoped, mirrored
 * at the unscoped, `/p/:projectId` and `/p/default` spellings — `route-parity.test.ts`).
 */

export interface SourcesRouteDeps {
  runtime?: SourceRuntime;
  kick?: (projectId: string, connectionId: string) => { syncId: string; promise: Promise<unknown> };
  sink?: (projectId: string, dataDir: string, connectionId: string) => SourceSink;
  reschedule?: (projectId: string) => void;
}

const SOURCES_OFF = 'external sources are disabled, set CEZ_SOURCES=1 to enable them';
const UNKNOWN_CONNECTION = 'unknown source connection';
const UNKNOWN_DOCUMENT = 'document not found';

const EMPTY_SOURCES_LIST: SourcesListResponse = { connections: [] };
const EMPTY_SOURCE_PROVIDERS: SourceProvidersResponse = { providers: [] };
const EMPTY_SOURCE_COLLECTIONS: SourceCollectionsResponse = { collections: [] };
const EMPTY_SOURCE_DOCUMENTS: SourceDocumentsResponse = { documents: [] };
const EMPTY_SOURCE_DOCUMENT: SourceDocumentResponse = { document: null };
const EMPTY_SOURCE_COMMENTS: SourceCommentsResponse = { comments: [] };
const EMPTY_SOURCE_LOG: SourceLogResponse = { rows: [] };

const sourcesLogQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/** Presentation-only catalog info the `SourceProvider` seam deliberately does not carry (`kind`,
 *  `capabilities` and availability are DATA on the provider itself — Q3 — but a human label and a
 *  credential hint are a wire-only concern, so they live here rather than widening that seam for
 *  one route). A kind with no entry falls back to its own string as the label and no hint. */
const PROVIDER_CATALOG_INFO: Record<string, { label: string; credentialHint?: string }> = {
  [NOTION_SOURCE_KIND]: {
    label: 'Notion',
    credentialHint:
      'set CEZ_NOTION_TOKEN (falls back to NOTION_TOKEN, NOTION_API_KEY), then share the page or database with the integration',
  },
};

/**
 * One `SourceProvider` instance PER KIND, reused across requests for the lifetime of the process.
 * Availability is a property of `(kind, env)` — the Notion token is global, not per-connection — so
 * caching by kind is exactly what makes `detectCached()`'s stale-while-revalidate cache
 * (`notion/client.ts`, mirroring `forge`'s `detectGithubCached`) actually apply across GETs instead
 * of starting cold on every request. A provider resolved for a REAL connection (collections,
 * documents) is never read from this cache — those need the connection's own fields and are built
 * fresh via `resolveSourceProvider(connection)` at the call site.
 */
const kindProviderCache = new Map<string, SourceProvider>();

function providerForKind(kind: string): SourceProvider | null {
  const cached = kindProviderCache.get(kind);
  if (cached) return cached;
  const provider = resolveSourceProvider({ kind });
  if (provider) kindProviderCache.set(kind, provider);
  return provider;
}

/** Non-blocking when a probe has already warmed the cache; the very first call for a kind in this
 *  process awaits one real `detect()` (itself never-throwing — no token resolves instantly, a
 *  network error resolves to `{available:false, reason}`) because the wire's `availability` is
 *  REQUIRED, unlike `forgeInfoSchema`'s optional field, so there is no "not yet known" value to
 *  fall back to. */
async function resolveAvailability(kind: string): Promise<SourceAvailability> {
  const provider = providerForKind(kind);
  if (!provider) return { available: false, reason: `unknown source kind "${kind}"` };
  return provider.detectCached() ?? provider.detect();
}

function toStorageCollectionRef(ref: SourceCollectionRefWire): SourceCollectionRef {
  return {
    externalId: ref.externalId,
    collectionKind: ref.collectionKind,
    ...(ref.label ? { label: ref.label } : {}),
    maxDepth: ref.maxDepth ?? 3,
    splitOnHeading: ref.splitOnHeading ?? 'h2',
  };
}

function toConnectionWire(
  connection: SourceConnection,
  state: SourceState | undefined,
  availability: SourceAvailability,
): SourceConnectionWire {
  return {
    id: connection.id,
    revision: connection.revision,
    kind: connection.kind,
    name: connection.name,
    enabled: connection.enabled,
    mode: connection.mode,
    intervalSeconds: connection.intervalSeconds,
    collections: connection.collections.map((collection) => ({
      externalId: collection.externalId,
      collectionKind: collection.collectionKind,
      ...(collection.label ? { label: collection.label } : {}),
      maxDepth: collection.maxDepth,
      splitOnHeading: collection.splitOnHeading,
    })),
    watchComments: connection.watchComments,
    maxDocuments: connection.maxDocuments,
    maxBodyBytes: connection.maxBodyBytes,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
    // Every field below is a STORED value read off `source-state.json` (Q6/D8) — nothing here
    // reads the clock, so three identical GETs return three identical bodies (NC-6).
    syncState: state?.syncState ?? 'never-synced',
    ...(state?.syncStateAt ? { syncStateAt: state.syncStateAt } : {}),
    ...(state?.lastCompleteSweepAt ? { lastCompleteSweepAt: state.lastCompleteSweepAt } : {}),
    ...(state?.lastSuccessAt ? { lastSuccessAt: state.lastSuccessAt } : {}),
    ...(state?.nextDueAt ? { nextDueAt: state.nextDueAt } : {}),
    ...(state?.lastError?.message ? { lastErrorMessage: state.lastError.message } : {}),
    documentCount: state?.documentCount ?? 0,
    conflictCount: state?.conflictCount ?? 0,
    unresolvedComments: state?.unresolvedComments ?? 0,
    availability,
    // Q13: true only once every collection's enumeration has reached exhaustion at least once.
    complete: Boolean(state?.lastCompleteSweepAt),
  };
}

function toDocumentWire(meta: MirroredDocumentMeta, syncState: SourceSyncState, body?: string): SourceDocumentWire {
  return {
    docId: meta.docId,
    externalId: meta.source.externalId,
    title: meta.title,
    docType: meta.docType,
    url: meta.source.url,
    origin: meta.source.origin,
    state: meta.source.state,
    // STORED, never recomputed here (D8/Q6) — the sink wrote this at mirror time.
    mirroredAt: meta.source.mirroredAt,
    syncState,
    lossy: meta.source.lossy,
    properties: meta.properties,
    ...(body !== undefined ? { body } : {}),
  };
}

/** The connection's own `syncState` (Q6): a document does not carry a sync status of its own
 *  beyond `source.state` (ok/conflict/tombstoned/truncated) — "is the MIRROR fresh" is a
 *  connection-level fact, stored once and read here rather than re-derived per document. */
function connectionSyncState(store: SourceStore, connectionId: string): SourceSyncState {
  return store.state(connectionId)?.syncState ?? 'never-synced';
}

export function createSourcesRoutes(deps: SourcesRouteDeps = {}) {
  const sinkFor = (project: ProjectApiEnv['Variables']['project'], dataDir: string, connectionId: string): SourceSink =>
    deps.sink?.(project.id, dataDir, connectionId)
      ?? deps.runtime?.sink(project.id, dataDir, connectionId)
      ?? new FileSourceSink(dataDir, connectionId);
  const reschedule = (projectId: string): void => {
    deps.reschedule?.(projectId);
    void deps.runtime?.reschedule();
  };

  return new Hono<ProjectApiEnv>()
    // ---- connections -------------------------------------------------------------------------
    .get('/sources', async (c) => {
      const { sourceStore } = c.get('project');
      if (!sourceStore) return c.json(EMPTY_SOURCES_LIST);
      const connections = sourceStore.list();
      const wire = await Promise.all(
        connections.map(async (connection) => {
          const availability = await resolveAvailability(connection.kind);
          return toConnectionWire(connection, sourceStore.state(connection.id), availability);
        }),
      );
      const response: SourcesListResponse = { connections: wire };
      return c.json(response);
    })

    .get('/sources/providers', async (c) => {
      const { sourceStore } = c.get('project');
      if (!sourceStore) return c.json(EMPTY_SOURCE_PROVIDERS);
      const kinds = Object.keys(SOURCE_PROVIDERS);
      const providers = await Promise.all(
        kinds.map(async (kind) => {
          const provider = providerForKind(kind);
          const availability = await resolveAvailability(kind);
          const info = PROVIDER_CATALOG_INFO[kind] ?? { label: kind };
          const row: SourceProviderInfo = {
            kind,
            label: info.label,
            capabilities: provider?.capabilities ?? { list: false, fetch: false, poll: false, push: false, comments: false },
            availability,
            ...(info.credentialHint ? { credentialHint: info.credentialHint } : {}),
          };
          return row;
        }),
      );
      const response: SourceProvidersResponse = { providers };
      return c.json(response);
    })

    .post('/sources', jsonZodValidator(createSourceConnectionInputSchema), async (c) => {
      const { sourceStore } = c.get('project');
      if (!sourceStore) return c.json({ error: SOURCES_OFF }, 409);
      const input = c.req.valid('json');
      const connection = sourceStore.create({
        kind: input.kind,
        name: input.name,
        enabled: input.enabled ?? true,
        mode: input.mode ?? 'mirror',
        intervalSeconds: input.intervalSeconds ?? 900,
        collections: (input.collections ?? []).map(toStorageCollectionRef),
        watchComments: input.watchComments ?? false,
        maxDocuments: input.maxDocuments ?? 5_000,
        maxBodyBytes: input.maxBodyBytes ?? 524_288,
      });
      if (!connection.enabled || connection.mode === 'archived') {
        sourceStore.updateState(connection.id, {
          revision: connection.revision,
          syncState: 'paused',
          syncStateAt: connection.updatedAt,
        });
      }
      const availability = await resolveAvailability(connection.kind);
      const response: SourceConnectionResponse = {
        connection: toConnectionWire(connection, sourceStore.state(connection.id), availability),
      };
      reschedule(c.get('project').id);
      return c.json(response, 201);
    })

    .put('/sources/:connectionId', jsonZodValidator(updateSourceConnectionInputSchema), async (c) => {
      const { sourceStore } = c.get('project');
      if (!sourceStore) return c.json({ error: SOURCES_OFF }, 409);
      const connectionId = c.req.param('connectionId');
      const current = sourceStore.get(connectionId);
      if (!current) return c.json({ error: UNKNOWN_CONNECTION }, 404);
      const input = c.req.valid('json');
      let connection: SourceConnection;
      try {
        connection = sourceStore.update(connectionId, input.expectedRevision, {
          kind: input.kind,
          name: input.name,
          enabled: input.enabled ?? current.enabled,
          mode: input.mode ?? current.mode,
          intervalSeconds: input.intervalSeconds ?? current.intervalSeconds,
          collections: input.collections ? input.collections.map(toStorageCollectionRef) : current.collections,
          watchComments: input.watchComments ?? current.watchComments,
          maxDocuments: input.maxDocuments ?? current.maxDocuments,
          maxBodyBytes: input.maxBodyBytes ?? current.maxBodyBytes,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('not found')) return c.json({ error: message }, 404);
        return c.json({ error: message }, 409);
      }
      const availability = await resolveAvailability(connection.kind);
      const wasActive = current.enabled && current.mode !== 'archived';
      const isActive = connection.enabled && connection.mode !== 'archived';
      if (!isActive) {
        sourceStore.updateState(connection.id, {
          revision: connection.revision,
          syncState: 'paused',
          syncStateAt: connection.updatedAt,
        });
      } else if (!wasActive) {
        sourceStore.updateState(connection.id, { revision: connection.revision, nextDueAt: connection.updatedAt });
      }
      const response: SourceConnectionResponse = {
        connection: toConnectionWire(connection, sourceStore.state(connection.id), availability),
      };
      reschedule(c.get('project').id);
      return c.json(response);
    })

    .delete('/sources/:connectionId', (c) => {
      const { sourceStore } = c.get('project');
      if (!sourceStore) return c.json({ error: SOURCES_OFF }, 409);
      const removed = sourceStore.delete(c.req.param('connectionId'));
      if (!removed) return c.json({ error: UNKNOWN_CONNECTION }, 404);
      const response: SourceRemovedResponse = { removed: true };
      reschedule(c.get('project').id);
      return c.json(response);
    })

    // ---- per-connection reads ------------------------------------------------------------------
    .get('/sources/:connectionId/collections', async (c) => {
      const { sourceStore } = c.get('project');
      if (!sourceStore) return c.json(EMPTY_SOURCE_COLLECTIONS);
      const connection = sourceStore.get(c.req.param('connectionId'));
      if (!connection) return c.json({ error: UNKNOWN_CONNECTION }, 404);
      const response: SourceCollectionsResponse = {
        collections: connection.collections.map((collection): SourceRemoteCollection => ({
          externalId: collection.externalId,
          collectionKind: collection.collectionKind,
          ...(collection.label ? { label: collection.label } : {}),
        })),
      };
      return c.json(response);
    })

    .post('/sources/:connectionId/sync', async (c) => {
      const { sourceStore } = c.get('project');
      if (!sourceStore) return c.json({ error: SOURCES_OFF }, 409);
      const connection = sourceStore.get(c.req.param('connectionId'));
      if (!connection) return c.json({ error: UNKNOWN_CONNECTION }, 404);
      if (!connection.enabled) return c.json({ error: 'source connection is disabled' }, 409);
      if (connection.mode === 'archived') return c.json({ error: 'source connection is archived' }, 409);
      const kick = deps.kick ?? deps.runtime?.kick.bind(deps.runtime);
      if (!kick) return c.json({ error: 'source runtime is unavailable' }, 409);
      const provider = deps.runtime ? deps.runtime.provider(connection) : resolveSourceProvider(connection);
      if (!provider) return c.json({ error: `unknown source kind "${connection.kind}"` }, 409);
      const availability = provider.detectCached() ?? await provider.detect();
      if (!availability.available) return c.json({ error: availability.reason ?? 'source unavailable' }, 409);
      const { syncId } = kick(c.get('project').id, connection.id);
      const response: SourceSyncKickResponse = { syncId };
      return c.json(response, 202);
    })

    .get('/sources/:connectionId/documents', async (c) => {
      const { sourceStore, dataDir } = c.get('project');
      if (!sourceStore) return c.json(EMPTY_SOURCE_DOCUMENTS);
      const connectionId = c.req.param('connectionId');
      const connection = sourceStore.get(connectionId);
      if (!connection) return c.json({ error: UNKNOWN_CONNECTION }, 404);
      const sink = sinkFor(c.get('project'), dataDir, connectionId);
      const metas = await sink.list(connectionId);
      const syncState = connectionSyncState(sourceStore, connectionId);
      const response: SourceDocumentsResponse = {
        documents: metas.map((meta) => toDocumentWire(meta, syncState)),
      };
      return c.json(response);
    })

    .get('/sources/:connectionId/documents/:docId', async (c) => {
      const { sourceStore, dataDir } = c.get('project');
      if (!sourceStore) return c.json(EMPTY_SOURCE_DOCUMENT);
      const connectionId = c.req.param('connectionId');
      const connection = sourceStore.get(connectionId);
      if (!connection) return c.json({ error: UNKNOWN_CONNECTION }, 404);
      const docId = c.req.param('docId');
      const sink = sinkFor(c.get('project'), dataDir, connectionId);
      const meta = await sink.readMeta(docId);
      if (!meta) return c.json(EMPTY_SOURCE_DOCUMENT);
      const bodyResult = await sink.read(docId);
      const syncState = connectionSyncState(sourceStore, connectionId);
      const response: SourceDocumentResponse = {
        document: toDocumentWire(meta, syncState, bodyResult?.body),
      };
      return c.json(response);
    })

    .post('/sources/:connectionId/documents/:docId/adopt', async (c) => {
      const { sourceStore, dataDir } = c.get('project');
      if (!sourceStore) return c.json({ error: SOURCES_OFF }, 409);
      const connectionId = c.req.param('connectionId');
      const connection = sourceStore.get(connectionId);
      if (!connection) return c.json({ error: UNKNOWN_CONNECTION }, 404);
      const docId = c.req.param('docId');
      const sink = sinkFor(c.get('project'), dataDir, connectionId);
      const meta = await sink.readMeta(docId);
      if (!meta) return c.json({ error: UNKNOWN_DOCUMENT }, 404);
      const result = await sink.adopt(docId);
      // Q11: the durable adopted set is what stops the NEXT sweep re-mirroring this page as a
      // brand new document — a separate write from the file move above.
      sourceStore.adopt(connectionId, meta.source.externalId);
      // D15: required after a commit to the knowledge root, never best effort. A no-op standalone
      // (`FileSourceSink.notifyChanged`'s own doc comment) until `CEZ_KB=1` wires a real index.
      sink.notifyChanged(dataDir, [docId]);
      const response: AdoptSourceDocumentResponse = result;
      return c.json(response);
    })

    .post(
      '/sources/:connectionId/documents/:docId/resolve',
      jsonZodValidator(resolveSourceConflictInputSchema),
      async (c) => {
        const { sourceStore, dataDir } = c.get('project');
        if (!sourceStore) return c.json({ error: SOURCES_OFF }, 409);
        const connectionId = c.req.param('connectionId');
        const connection = sourceStore.get(connectionId);
        if (!connection) return c.json({ error: UNKNOWN_CONNECTION }, 404);
        const provider = deps.runtime ? deps.runtime.provider(connection) : resolveSourceProvider(connection);
        if (!provider) return c.json({ error: `unknown source kind "${connection.kind}"` }, 409);
        try {
          const meta = await resolveSourceConflict({
            connection,
            store: sourceStore,
            sink: sinkFor(c.get('project'), dataDir, connectionId),
            provider,
            docId: c.req.param('docId'),
            action: c.req.valid('json').action,
          });
          const response: ResolveSourceConflictResponse = {
            document: toDocumentWire(meta, connectionSyncState(sourceStore, connectionId)),
          };
          return c.json(response);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message === UNKNOWN_DOCUMENT) return c.json({ error: message }, 404);
          return c.json({ error: message }, 409);
        }
      },
    )

    .get('/sources/:connectionId/comments', (c) => {
      const { sourceStore } = c.get('project');
      if (!sourceStore) return c.json(EMPTY_SOURCE_COMMENTS);
      const connection = sourceStore.get(c.req.param('connectionId'));
      if (!connection) return c.json({ error: UNKNOWN_CONNECTION }, 404);
      const comments = sourceStore.listComments(c.req.param('connectionId')).map((comment) => ({
        id: comment.id,
        docId: comment.docId,
        externalId: comment.externalId,
        ...(comment.author !== undefined ? { author: comment.author } : {}),
        body: comment.body,
        createdAt: comment.createdAt,
        attachments: comment.attachments,
      }));
      const response: SourceCommentsResponse = { comments };
      return c.json(response);
    })

    .get('/sources/:connectionId/log', queryZodValidator(sourcesLogQuerySchema), (c) => {
      const { sourceStore } = c.get('project');
      if (!sourceStore) return c.json(EMPTY_SOURCE_LOG);
      const connectionId = c.req.param('connectionId');
      const connection = sourceStore.get(connectionId);
      if (!connection) return c.json({ error: UNKNOWN_CONNECTION }, 404);
      const query = c.req.valid('query');
      const limit = query.limit ?? 100;
      const parsedCursor = query.cursor !== undefined ? Number(query.cursor) : undefined;
      const cursor = parsedCursor !== undefined && Number.isFinite(parsedCursor) ? parsedCursor : undefined;
      const rows = sourceStore.logs({ connectionId, limit, ...(cursor !== undefined ? { cursor } : {}) });
      const nextCursor = rows.length === limit ? String(rows[rows.length - 1]!.seq) : undefined;
      const response: SourceLogResponse = {
        rows: rows.map((row) => ({
          seq: row.seq,
          ts: row.ts,
          connectionId: row.connectionId,
          event: row.event,
          ...(row.message !== undefined ? { message: row.message } : {}),
          ...(row.docId !== undefined ? { docId: row.docId } : {}),
        })),
        ...(nextCursor !== undefined ? { nextCursor } : {}),
      };
      return c.json(response);
    });
}
