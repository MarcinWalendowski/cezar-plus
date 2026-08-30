import { mirroredDocumentSchema, type MirroredDocumentMeta, type SourceConnection, type SourceSink } from './types.ts';
import type { SourceDocumentRef, SourceProvider } from './provider-types.ts';
import type { SourceStore } from './store.ts';
import { computeDocId } from './sync.ts';

export interface ResolveSourceConflictOptions {
  connection: SourceConnection;
  store: SourceStore;
  sink: SourceSink;
  provider: SourceProvider;
  docId: string;
  action: 'keep-local' | 'take-remote';
  callBudget?: number;
  now?: () => Date;
}

export async function resolveSourceConflict(options: ResolveSourceConflictOptions): Promise<MirroredDocumentMeta> {
  const now = options.now ?? (() => new Date());
  const meta = await options.sink.readMeta(options.docId);
  if (!meta) throw new Error('document not found');
  if (meta.source.connectionId !== options.connection.id) throw new Error('document not found');
  if (meta.source.state !== 'conflict') throw new Error('document is not in conflict');
  if (computeDocId(options.connection, meta.source.externalId) !== options.docId) {
    throw new Error('document does not belong to this source connection');
  }

  const availability = await options.provider.detect();
  if (!availability.available) throw new Error(availability.reason ?? 'source unavailable');
  const ref = await enumerateCurrentRef(options.provider, options.connection, meta.source.externalId, options.callBudget);
  if (!ref) throw new Error('current remote document could not be enumerated completely');
  const remote = await options.provider.fetchDocument(ref);
  if (!remote) throw new Error('current remote document could not be fetched');

  const local = await options.sink.read(options.docId);
  if (!local) throw new Error('document body not found');
  if (options.action === 'take-remote') {
    if (!options.sink.backupLocal) throw new Error('source sink cannot back up local conflict content');
    await options.sink.backupLocal(options.docId, local.localVersion, local.body);
  }

  const document = mirroredDocumentSchema.parse({
    ...meta,
    title: remote.title,
    source: {
      ...meta.source,
      remoteVersion: remote.remoteVersion,
      url: options.provider.viewUrl(remote) ?? remote.url,
      state: 'ok',
      mirroredAt: now().toISOString(),
      lossy: remote.lossy,
    },
    collectionExternalId: remote.collectionExternalId,
    parentExternalId: remote.parentExternalId,
    docType: remote.docType,
    remoteVersionSeen: remote.remoteVersion,
    properties: remote.properties,
  });
  await options.sink.upsert(document, options.action === 'take-remote' ? remote.body : local.body);

  const metas = await options.sink.list(options.connection.id);
  options.store.updateState(options.connection.id, {
    documentCount: metas.length,
    conflictCount: metas.filter((item) => item.source.state === 'conflict').length,
    syncStateAt: now().toISOString(),
  });
  options.store.appendLog({
    connectionId: options.connection.id,
    event: 'conflict-resolved',
    docId: options.docId,
    message: options.action,
  });
  options.sink.notifyChanged(options.store.dataDir, [options.docId]);
  const updated = await options.sink.readMeta(options.docId);
  if (!updated) throw new Error('resolved document disappeared');
  return updated;
}

async function enumerateCurrentRef(
  provider: SourceProvider,
  connection: SourceConnection,
  externalId: string,
  callBudget = 25,
): Promise<SourceDocumentRef | null> {
  let remaining = callBudget;
  let found: SourceDocumentRef | null = null;
  for (const collection of connection.collections) {
    let cursor: string | null = null;
    do {
      if (remaining <= 0) return null;
      const page = await provider.listDocuments({
        collectionExternalId: collection.externalId,
        cursor,
        callBudget: remaining,
      });
      remaining -= page.callsUsed ?? remaining;
      const candidate = page.documents.find((document) => document.externalId === externalId);
      if (candidate) found = candidate;
      if (!page.complete && !page.nextPageCursor) return null;
      cursor = page.nextPageCursor;
      if (!page.complete && page.retryAfterMs !== undefined) return null;
    } while (cursor !== null);
  }
  return found;
}
