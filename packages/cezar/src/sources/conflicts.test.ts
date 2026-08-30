import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SourceDocumentRef, SourceProvider } from './provider-types.ts';
import { FileSourceSink } from './sink.ts';
import { SourceStore } from './store.ts';
import { computeDocId } from './sync.ts';
import { resolveSourceConflict } from './conflicts.ts';
import { mirroredDocumentSchema } from './types.ts';

const dirs: string[] = [];

async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cezar-source-conflicts-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const connectionInput = {
  kind: 'notion',
  name: 'Conflict source',
  enabled: true,
  mode: 'mirror' as const,
  intervalSeconds: 900,
  collections: [{ externalId: 'db-1', collectionKind: 'database' as const, maxDepth: 3, splitOnHeading: 'h2' as const }],
  watchComments: false,
  maxDocuments: 5_000,
  maxBodyBytes: 524_288,
};

function ref(remoteVersion = 'v2'): SourceDocumentRef {
  return {
    externalId: 'doc-1',
    collectionExternalId: 'db-1',
    title: 'Current title',
    url: 'https://notion.so/doc-1',
    remoteVersion,
    docType: 'row',
    properties: {},
  };
}

function provider(options: {
  currentRef?: SourceDocumentRef;
  fetch?: (current: SourceDocumentRef) => Promise<Awaited<ReturnType<SourceProvider['fetchDocument']>>>;
  complete?: boolean;
} = {}): SourceProvider {
  const currentRef = options.currentRef ?? ref();
  return {
    kind: 'notion',
    capabilities: { list: true, fetch: true, poll: true, push: false, comments: false },
    detect: async () => ({ available: true }),
    detectCached: () => ({ available: true }),
    listCollections: async () => [{ externalId: 'db-1', collectionKind: 'database' }],
    listDocuments: async () => ({
      documents: [currentRef],
      nextPageCursor: null,
      complete: options.complete ?? true,
      truncated: false,
    }),
    fetchDocument: options.fetch ?? (async (current) => ({
      ...current,
      body: 'Current remote body.',
      lossy: [],
    })),
    pollChanges: async () => ({ changes: [], watermark: null, nextPageCursor: null, complete: true, truncated: false }),
    viewUrl: () => currentRef.url,
  };
}

async function setup() {
  const dir = await directory();
  const store = SourceStore.open(dir);
  const connection = store.create(connectionInput, 'conn-1');
  const sink = new FileSourceSink(dir, connection.id);
  const docId = computeDocId(connection, 'doc-1');
  const doc = mirroredDocumentSchema.parse({
    docId,
    title: 'Original title',
    source: {
      kind: connection.kind,
      connectionId: connection.id,
      externalId: 'doc-1',
      url: 'https://notion.so/doc-1',
      remoteVersion: 'v1',
      mirroredAt: '2026-08-30T00:00:00.000Z',
    },
    collectionExternalId: 'db-1',
    remoteVersionSeen: 'v1',
  });
  await sink.upsert(doc, 'Local body after edit.');
  const path = join(dir, 'sources', connection.id, `${docId}.md`);
  const original = readFileSync(path, 'utf8');
  writeFileSync(path, original.replace('Local body after edit.', 'Local body after second edit.'));
  await sink.quarantine(docId, 'stale-v2', 'Stale quarantined body.');
  return { dir, store, connection, sink, docId };
}

describe('resolveSourceConflict', () => {
  it('keep-local follows the current remote ref and preserves the edited body and its hash', async () => {
    const { store, connection, sink, docId } = await setup();
    const fetchDocument = vi.fn(async (current: SourceDocumentRef) => ({
      ...current,
      body: 'Newest remote body.',
      lossy: [],
    }));

    // The frontmatter still records the hash of the body as it was BEFORE the out-of-band
    // edit in `setup()`. `sink.read` recomputes the hash from the bytes on disk, so it can
    // never witness that staleness — only the stored meta can.
    const beforeMeta = await sink.readMeta(docId);
    const result = await resolveSourceConflict({
      connection,
      store,
      sink,
      provider: provider({ currentRef: ref('v3'), fetch: fetchDocument }),
      docId,
      action: 'keep-local',
    });

    expect(fetchDocument).toHaveBeenCalledWith(expect.objectContaining({ externalId: 'doc-1', remoteVersion: 'v3' }));
    expect(result.source.state).toBe('ok');
    expect(result.source.remoteVersion).toBe('v3');
    expect(result.remoteVersionSeen).toBe('v3');
    const after = await sink.read(docId);
    if (!after) throw new Error('resolved document body disappeared');
    expect(after.body).toBe('Local body after second edit.');
    expect(after.localVersion).toBe(createHash('sha256').update(after.body).digest('hex'));
    // keep-local preserves the body, so its hash is unchanged by definition; what the
    // resolution must do is refresh the STORED hash to match the edited bytes.
    expect(result.localVersion).toBe(after.localVersion);
    expect(result.localVersion).not.toBe(beforeMeta?.localVersion);
    const files = readdirSync(join(store.dataDir, 'sources', connection.id, 'conflicts'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(new RegExp(`^${docId}\\.remote-`));
  });

  it('take-remote archives the current local body before replacing it', async () => {
    const { store, connection, sink, docId } = await setup();
    const local = await sink.read(docId);
    expect(local).not.toBeNull();
    const localHash = createHash('sha256').update(local!.body).digest('hex');

    await resolveSourceConflict({
      connection,
      store,
      sink,
      provider: provider({ currentRef: ref('v4') }),
      docId,
      action: 'take-remote',
    });

    expect((await sink.read(docId))?.body).toBe('Current remote body.');
    const files = readdirSync(join(store.dataDir, 'sources', connection.id, 'conflicts'));
    expect(files).toContain(`${docId}.local-${localHash.slice(0, 8)}.md`);
    expect(readFileSync(join(store.dataDir, 'sources', connection.id, 'conflicts', `${docId}.local-${localHash.slice(0, 8)}.md`), 'utf8')).toBe(
      'Local body after second edit.',
    );
  });

  it('does not resolve when the current enumeration is incomplete', async () => {
    const { store, connection, sink, docId } = await setup();
    const fetchDocument = vi.fn(async (current: SourceDocumentRef) => ({ ...current, body: 'Should not be fetched.', lossy: [] }));

    await expect(resolveSourceConflict({
      connection,
      store,
      sink,
      provider: provider({ complete: false, fetch: fetchDocument }),
      docId,
      action: 'keep-local',
    })).rejects.toThrow('could not be enumerated completely');
    expect(fetchDocument).not.toHaveBeenCalled();
    expect((await sink.readMeta(docId))?.source.state).toBe('conflict');
  });
});
