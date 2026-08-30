import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileSourceSink } from './sink.ts';
import { SourceStore } from './store.ts';
import { computeDocId, runSourceSync } from './sync.ts';
import { mirroredDocumentSchema, type MirroredDocument, type SourceConnection } from './types.ts';
import type {
  SourceAvailability,
  SourceCollection,
  SourceDocument,
  SourceDocumentRef,
  SourceProvider,
} from './provider-types.ts';

/**
 * `sync.ts`, the sweep (F2, W4.4). See
 * `.ai/specs/2026-08-06-external-source-connectors-notion.md` phase "3.1" and "Verification" for
 * the exact negative controls this file implements: NC-1 (pagination gate), NC-2 (revoked token
 * freezes the mirror), NC-3 (resumability re-emits nothing already seen), and NC-4 (conflict
 * quarantine, both directions). Every provider here is a hand-written stub, no live network I/O,
 * matching every other test file in this directory.
 */

const dirs: string[] = [];
async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cezar-sources-sync-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

function refFor(externalId: string, remoteVersion = `v-${externalId}`): SourceDocumentRef {
  return {
    externalId,
    collectionExternalId: 'db-1',
    title: `Doc ${externalId}`,
    url: `https://notion.so/${externalId}`,
    remoteVersion,
    docType: 'row',
    properties: {},
  };
}

interface StubProviderOptions {
  detect?: () => Promise<SourceAvailability>;
  collections?: SourceCollection[];
  comments?: boolean;
  listDocuments?: SourceProvider['listDocuments'];
  listComments?: SourceProvider['listComments'];
  pollChanges?: SourceProvider['pollChanges'];
  fetchDocument?: (ref: SourceDocumentRef) => Promise<SourceDocument | null>;
}

function makeProvider(options: StubProviderOptions = {}): SourceProvider {
  return {
    kind: 'notion',
    capabilities: {
      list: true,
      fetch: true,
      poll: true,
      push: false,
      comments: options.comments ?? false,
    },
    detect: options.detect ?? (async () => ({ available: true })),
    detectCached: () => ({ available: true }),
    listCollections: async () => options.collections ?? [{ externalId: 'db-1', collectionKind: 'database' }],
    listDocuments:
      options.listDocuments ??
      (async () => ({
        documents: [],
        nextPageCursor: null,
        complete: true,
        truncated: false,
      })),
    fetchDocument:
      options.fetchDocument ??
      (async (ref) => ({
        ...ref,
        body: `Body for ${ref.externalId}.`,
        lossy: [],
      })),
    pollChanges:
      options.pollChanges ??
      (async () => ({
        changes: [],
        watermark: null,
        nextPageCursor: null,
        complete: true,
        truncated: false,
      })),
    ...(options.listComments ? { listComments: options.listComments } : {}),
    viewUrl: (ref) => `https://notion.so/${ref.externalId}`,
  };
}

function makeMirroredDoc(docId: string, externalId: string, remoteVersion: string): MirroredDocument {
  return mirroredDocumentSchema.parse({
    docId,
    title: `Doc ${externalId}`,
    source: {
      kind: 'notion',
      connectionId: 'conn-1',
      externalId,
      url: `https://notion.so/${externalId}`,
      remoteVersion,
      mirroredAt: '2026-08-01T00:00:00.000Z',
    },
    collectionExternalId: 'db-1',
    remoteVersionSeen: remoteVersion,
  });
}

async function setup(overrides: Partial<SourceConnection> = {}) {
  const dir = await directory();
  const store = SourceStore.open(dir);
  const connection = store.create(
    {
      kind: 'notion',
      name: 'Acme workspace',
      enabled: true,
      mode: 'mirror',
      intervalSeconds: 900,
      collections: [
        {
          externalId: 'db-1',
          collectionKind: 'database',
          maxDepth: 3,
          splitOnHeading: 'h2',
        },
      ],
      watchComments: false,
      maxDocuments: 5_000,
      maxBodyBytes: 524_288,
      ...overrides,
    },
    'conn-1',
  );
  const sink = new FileSourceSink(dir, 'conn-1');
  const mirrorRoot = join(dir, 'sources');
  const connectionDir = join(mirrorRoot, 'conn-1');
  return { dir, store, connection, sink, mirrorRoot, connectionDir };
}

describe('runSourceSync', () => {
  it('NC-1: an incomplete poll writes what it saw, buffers a tombstone signal, and leaves the watermark unchanged', async () => {
    const { store, connection, sink, mirrorRoot } = await setup();
    // A prior complete sweep already recorded a watermark for this collection.
    store.updateState('conn-1', {
      watermarks: {
        'db-1': { timestamp: '2020-01-01T00:00:00.000Z', tieBreaker: 'seed' },
      },
    });
    const docIdB = computeDocId(connection, 'B');
    await sink.upsert(makeMirroredDoc(docIdB, 'B', 'v-B'), 'Body B.');
    const docIdC = computeDocId(connection, 'C');
    await sink.upsert(makeMirroredDoc(docIdC, 'C', 'v-C'), 'Body C.');

    const provider = makeProvider({
      // One page, budget-exhausted: an upsert for A AND an explicit (but not-yet-actionable)
      // tombstone signal for C both arrive on this same incomplete page.
      pollChanges: async () => ({
        changes: [
          { type: 'upsert', doc: refFor('A') },
          { type: 'tombstone', externalId: 'C', collectionExternalId: 'db-1' },
        ],
        watermark: { timestamp: '2026-08-05T00:00:00.000Z', tieBreaker: 'A' },
        nextPageCursor: 'page-2',
        complete: false,
        truncated: true,
      }),
    });

    const result = await runSourceSync({
      connection,
      store,
      sink,
      provider,
      mirrorRoot,
    });

    expect(result.complete).toBe(false);
    expect(result.syncState).toBe('ok'); // a budget cutoff is not an error
    expect(await sink.readMeta(computeDocId(connection, 'A'))).not.toBeNull(); // A was written
    expect(await sink.readMeta(docIdC)).not.toBeNull(); // C's tombstone signal was buffered, not acted on
    expect(await sink.readMeta(docIdB)).not.toBeNull();
    expect(store.state('conn-1')?.pageCursor).toEqual({
      collectionExternalId: 'db-1',
      cursor: 'page-2',
    });
    // The watermark is untouched: it only advances once THIS collection's own poll completes.
    expect(store.state('conn-1')?.watermarks['db-1']).toEqual({
      timestamp: '2020-01-01T00:00:00.000Z',
      tieBreaker: 'seed',
    });
    expect(store.state('conn-1')?.lastCompleteSweepAt).toBeUndefined();
  });

  it('NC-1 mutation proof: an otherwise-identical COMPLETE page acts on the same tombstone signal immediately', async () => {
    // Proves the completeness gate above is load-bearing, not decorative: the only difference from
    // the previous fixture is `complete: true`: the tombstone signal for C now DOES get acted on.
    // If the guard in `sync.ts` (`if (allComplete) { ... }`) were removed, the incomplete-page test
    // above would fail exactly the way this one succeeds.
    const { store, connection, sink, mirrorRoot } = await setup();
    const docIdC = computeDocId(connection, 'C');
    await sink.upsert(makeMirroredDoc(docIdC, 'C', 'v-C'), 'Body C.');

    const provider = makeProvider({
      pollChanges: async () => ({
        changes: [{ type: 'tombstone', externalId: 'C', collectionExternalId: 'db-1' }],
        watermark: null,
        nextPageCursor: null,
        complete: true,
        truncated: false,
      }),
    });

    const result = await runSourceSync({
      connection,
      store,
      sink,
      provider,
      mirrorRoot,
    });
    expect(result.complete).toBe(true);
    expect(await sink.readMeta(docIdC)).toBeNull();
  });

  it('NC-2: a revoked token freezes the mirror rather than emptying it', async () => {
    const { store, connection, sink, mirrorRoot } = await setup();
    for (const externalId of ['A', 'B', 'C']) {
      await sink.upsert(makeMirroredDoc(computeDocId(connection, externalId), externalId, 'v1'), `Body ${externalId}.`);
    }
    store.updateState('conn-1', { documentCount: 3, syncState: 'ok' });

    const tombstoneSpy = vi.spyOn(sink, 'tombstone');
    const provider = makeProvider({
      detect: async () => ({
        available: false,
        reason: 'Notion token rejected (401)',
      }),
    });

    const result = await runSourceSync({
      connection,
      store,
      sink,
      provider,
      mirrorRoot,
    });

    expect(result.syncState).toBe('unavailable');
    expect(result.reason).toBe('Notion token rejected (401)');
    expect(result.documentCount).toBe(3);
    expect(tombstoneSpy).not.toHaveBeenCalled();
    expect((await sink.list('conn-1')).length).toBe(3);
    expect(store.state('conn-1')?.tombstoneCount ?? 0).toBe(0);
  });

  it('NC-2 mutation proof: fails if unavailable were (wrongly) reported as an exhausted, empty enumeration', async () => {
    // Directly demonstrates why NC-2 must gate on `detect()`'s own result rather than trusting an
    // enumeration outcome: an unavailable-but-reported-complete-and-empty poll (the exact shape a
    // buggy provider might return for a 401) would, if reached, tombstone every seeded document.
    const { store, connection, sink, mirrorRoot } = await setup();
    for (const externalId of ['A', 'B', 'C']) {
      await sink.upsert(makeMirroredDoc(computeDocId(connection, externalId), externalId, 'v1'), `Body ${externalId}.`);
    }
    const provider = makeProvider({
      detect: async () => ({ available: true }), // MUTATION: a 401 masquerading as available
      pollChanges: async () => ({
        changes: [],
        watermark: null,
        nextPageCursor: null,
        complete: true,
        truncated: false,
      }),
    });
    // This provider never emits an explicit tombstone, so nothing gets deleted even under this
    // mutation, proving tombstoning is EXPLICIT-signal-gated, not "empty means gone" (the exact
    // false-empty failure mode NC-2 exists to rule out at the `detect()` boundary).
    await runSourceSync({ connection, store, sink, provider, mirrorRoot });
    expect((await sink.list('conn-1')).length).toBe(3);
  });

  it('NC-3: a second tick resumes from the persisted cursor and re-emits zero page-1 documents', async () => {
    const { store, connection, sink, mirrorRoot } = await setup();
    const upsertSpy = vi.spyOn(sink, 'upsert');
    const provider = makeProvider({
      pollChanges: async (_since, opts) => {
        if (opts.cursor === 'page-2') {
          return {
            changes: [{ type: 'upsert', doc: refFor('B') }],
            watermark: {
              timestamp: '2026-08-05T00:00:01.000Z',
              tieBreaker: 'B',
            },
            nextPageCursor: null,
            complete: true,
            truncated: false,
          };
        }
        return {
          changes: [{ type: 'upsert', doc: refFor('A') }],
          watermark: { timestamp: '2026-08-05T00:00:00.000Z', tieBreaker: 'A' },
          nextPageCursor: 'page-2',
          complete: false,
          truncated: true,
        };
      },
    });

    const first = await runSourceSync({
      connection,
      store,
      sink,
      provider,
      mirrorRoot,
    });
    expect(first.complete).toBe(false);
    expect(upsertSpy).toHaveBeenCalledTimes(1);
    expect(upsertSpy.mock.calls[0]![0].source.externalId).toBe('A');

    const second = await runSourceSync({
      connection,
      store,
      sink,
      provider,
      mirrorRoot,
    });
    expect(second.complete).toBe(true);
    expect(upsertSpy).toHaveBeenCalledTimes(2); // exactly one more call, B, never A again
    expect(upsertSpy.mock.calls[1]![0].source.externalId).toBe('B');
    expect(store.state('conn-1')?.pageCursor).toBeUndefined();
    expect(store.state('conn-1')?.lastCompleteSweepAt).toBeDefined();
  });

  it('NC-3 mutation proof: fails if pageCursor were not persisted', async () => {
    // Uses the SAME cursor-sensitive provider as the NC-3 test above (page 1 when `opts.cursor` is
    // absent, page 2's different document when it is `'page-2'`), so this cannot be satisfied by
    // `sink.upsert` call counts alone: diff-before-fetch already suppresses a second write of an
    // unchanged remoteVersion regardless of resumption, so a re-request of page 1 would look
    // upsert-silent too. What actually distinguishes "resumed" from "not persisted" is which cursor
    // sync.ts hands back to the provider on the second tick, so that is what this asserts on.
    const { store, connection, sink, mirrorRoot } = await setup();
    const cursorsRequested: Array<string | null | undefined> = [];
    const provider = makeProvider({
      pollChanges: async (_since, opts) => {
        cursorsRequested.push(opts.cursor);
        if (opts.cursor === 'page-2') {
          return {
            changes: [{ type: 'upsert', doc: refFor('B') }],
            watermark: {
              timestamp: '2026-08-05T00:00:01.000Z',
              tieBreaker: 'B',
            },
            nextPageCursor: null,
            complete: true,
            truncated: false,
          };
        }
        return {
          changes: [{ type: 'upsert', doc: refFor('A') }],
          watermark: { timestamp: '2026-08-05T00:00:00.000Z', tieBreaker: 'A' },
          nextPageCursor: 'page-2',
          complete: false,
          truncated: true,
        };
      },
    });

    await runSourceSync({ connection, store, sink, provider, mirrorRoot });
    // MUTATION: simulate the persistence write being dropped, exactly what "pageCursor were not
    // persisted" means, by erasing the cursor the tick above just stored before the next tick reads
    // it back.
    store.updateState('conn-1', { pageCursor: undefined });
    await runSourceSync({ connection, store, sink, provider, mirrorRoot });

    // Under this mutation both ticks request page 1 (`cursor` absent both times) instead of the
    // second tick requesting `'page-2'`, exactly the difference the real (unmutated) NC-3 test above
    // depends on to reach document B at all.
    expect(cursorsRequested).toEqual([null, null]);
  });

  it('NC-4: a local edit plus a newer remote version quarantines without touching the local body, and the watermark still advances', async () => {
    const { store, connection, sink, mirrorRoot, connectionDir } = await setup();
    const externalId = 'doc-1';
    const docId = computeDocId(connection, externalId);
    await sink.upsert(makeMirroredDoc(docId, externalId, 'v1'), 'Original body.');

    // Simulate a human editing the mirrored file directly, bypassing the sink.
    const path = join(connectionDir, `${docId}.md`);
    writeFileSync(path, readFileSync(path, 'utf8').replace('Original body.', 'Locally edited body.'));

    const provider = makeProvider({
      pollChanges: async () => ({
        changes: [{ type: 'upsert', doc: refFor(externalId, 'v2') }],
        watermark: {
          timestamp: '2026-08-05T00:00:00.000Z',
          tieBreaker: externalId,
        },
        nextPageCursor: null,
        complete: true,
        truncated: false,
      }),
      fetchDocument: async (ref) => ({
        ...ref,
        body: 'Incoming remote body.',
        lossy: [],
      }),
    });

    const result = await runSourceSync({
      connection,
      store,
      sink,
      provider,
      mirrorRoot,
    });

    const read = await sink.read(docId);
    expect(read?.body).toBe('Locally edited body.'); // byte-identical to what was written locally

    const meta = await sink.readMeta(docId);
    expect(meta?.source.state).toBe('conflict');

    const conflictsDir = join(connectionDir, 'conflicts');
    const conflictFiles = readdirSync(conflictsDir);
    expect(conflictFiles).toHaveLength(1);
    expect(readFileSync(join(conflictsDir, conflictFiles[0]!), 'utf8')).toBe('Incoming remote body.');

    expect(store.state('conn-1')?.watermarks['db-1']).toEqual({
      timestamp: '2026-08-05T00:00:00.000Z',
      tieBreaker: externalId,
    });
    expect(result.conflictCount).toBe(1);
  });

  it('NC-4 mutation proof (direction A): fails if the sink wrote the incoming body over the local file', async () => {
    const { store, connection, sink, mirrorRoot, connectionDir } = await setup();
    const externalId = 'doc-1';
    const docId = computeDocId(connection, externalId);
    await sink.upsert(makeMirroredDoc(docId, externalId, 'v1'), 'Original body.');
    const path = join(connectionDir, `${docId}.md`);
    writeFileSync(path, readFileSync(path, 'utf8').replace('Original body.', 'Locally edited body.'));

    const provider = makeProvider({
      pollChanges: async () => ({
        changes: [{ type: 'upsert', doc: refFor(externalId, 'v2') }],
        watermark: null,
        nextPageCursor: null,
        complete: true,
        truncated: false,
      }),
      fetchDocument: async (ref) => ({
        ...ref,
        body: 'Incoming remote body.',
        lossy: [],
      }),
    });

    await runSourceSync({ connection, store, sink, provider, mirrorRoot });
    expect((await sink.read(docId))?.body).not.toBe('Incoming remote body.');
  });

  it('NC-4 mutation proof (direction B): fails if the sweep returned early on a conflict instead of continuing', async () => {
    // Two documents in the same page: the first conflicts, the second is a clean upsert. A sweep
    // that returned early on the conflict would never see the second document at all.
    const { store, connection, sink, mirrorRoot, connectionDir } = await setup();
    const conflictId = computeDocId(connection, 'conflict-doc');
    await sink.upsert(makeMirroredDoc(conflictId, 'conflict-doc', 'v1'), 'Original body.');
    const path = join(connectionDir, `${conflictId}.md`);
    writeFileSync(path, readFileSync(path, 'utf8').replace('Original body.', 'Locally edited body.'));

    const provider = makeProvider({
      pollChanges: async () => ({
        changes: [
          { type: 'upsert', doc: refFor('conflict-doc', 'v2') },
          { type: 'upsert', doc: refFor('clean-doc', 'v1') },
        ],
        watermark: null,
        nextPageCursor: null,
        complete: true,
        truncated: false,
      }),
    });

    await runSourceSync({ connection, store, sink, provider, mirrorRoot });
    expect(await sink.readMeta(computeDocId(connection, 'clean-doc'))).not.toBeNull();
  });

  it('an unchanged remote version causes zero document fetches (diff-before-fetch)', async () => {
    const { store, connection, sink, mirrorRoot } = await setup();
    const externalId = 'doc-1';
    const docId = computeDocId(connection, externalId);
    await sink.upsert(makeMirroredDoc(docId, externalId, 'v1'), 'Body.');

    const fetchDocument = vi.fn(async (ref: SourceDocumentRef) => ({
      ...ref,
      body: 'Body.',
      lossy: [],
    }));
    const provider = makeProvider({
      pollChanges: async () => ({
        changes: [{ type: 'upsert', doc: refFor(externalId, 'v1') }],
        watermark: null,
        nextPageCursor: null,
        complete: true,
        truncated: false,
      }),
      fetchDocument,
    });

    await runSourceSync({ connection, store, sink, provider, mirrorRoot });
    expect(fetchDocument).not.toHaveBeenCalled();
  });

  it('a changed remote version does fetch and write', async () => {
    const { store, connection, sink, mirrorRoot } = await setup();
    const externalId = 'doc-1';
    const docId = computeDocId(connection, externalId);
    await sink.upsert(makeMirroredDoc(docId, externalId, 'v1'), 'Body.');

    const fetchDocument = vi.fn(async (ref: SourceDocumentRef) => ({
      ...ref,
      body: 'New body.',
      lossy: [],
    }));
    const provider = makeProvider({
      pollChanges: async () => ({
        changes: [{ type: 'upsert', doc: refFor(externalId, 'v2') }],
        watermark: null,
        nextPageCursor: null,
        complete: true,
        truncated: false,
      }),
      fetchDocument,
    });

    await runSourceSync({ connection, store, sink, provider, mirrorRoot });
    expect(fetchDocument).toHaveBeenCalledTimes(1);
    expect((await sink.read(docId))?.body).toBe('New body.');
  });

  it('uses one shared document request budget across collections and resumes before the next collection', async () => {
    const { store, connection, sink, mirrorRoot } = await setup({
      collections: [
        { externalId: 'db-1', collectionKind: 'database', maxDepth: 3, splitOnHeading: 'h2' },
        { externalId: 'db-2', collectionKind: 'database', maxDepth: 3, splitOnHeading: 'h2' },
      ],
    });
    const polled: string[] = [];
    const provider = makeProvider({
      collections: [
        { externalId: 'db-1', collectionKind: 'database' },
        { externalId: 'db-2', collectionKind: 'database' },
      ],
      pollChanges: async (_since, options) => {
        polled.push(options.collectionExternalId);
        return {
          changes: [],
          watermark: null,
          nextPageCursor: null,
          complete: true,
          truncated: false,
          callsUsed: 1,
        };
      },
    });

    const first = await runSourceSync({ store, connection, sink, provider, mirrorRoot, callBudget: 1 });
    expect(first.complete).toBe(false);
    expect(polled).toEqual(['db-1']);
    expect(store.state(connection.id)?.pageCursor).toEqual({ collectionExternalId: 'db-2', cursor: '' });

    const second = await runSourceSync({ store, connection, sink, provider, mirrorRoot, callBudget: 1 });
    expect(second.complete).toBe(true);
    expect(polled).toEqual(['db-1', 'db-2']);
    expect(store.state(connection.id)?.pageCursor).toBeUndefined();
  });

  it('comment pagination advances only on completion and never changes the document body hash', async () => {
    const { store, connection, sink, mirrorRoot } = await setup({ watchComments: true });
    const docId = computeDocId(connection, 'commented');
    await sink.upsert(makeMirroredDoc(docId, 'commented', 'v1'), 'Body stays byte-identical.');
    const before = await sink.read(docId);
    const provider = makeProvider({
      comments: true,
      pollChanges: async () => ({
        changes: [],
        watermark: null,
        nextPageCursor: null,
        complete: true,
        truncated: false,
        callsUsed: 1,
      }),
      listComments: async (_ref, _since, options) => {
        if (options?.cursor === 'page-2') {
          return {
            comments: [{ externalId: 'comment-2', body: 'Reply', createdAt: '2026-08-30T00:01:00.000Z', attachments: [] }],
            nextPageCursor: null,
            complete: true,
            truncated: false,
            callsUsed: 1,
          };
        }
        return {
          comments: [{ externalId: 'comment-1', body: 'First', createdAt: '2026-08-30T00:00:00.000Z', attachments: [] }],
          nextPageCursor: 'page-2',
          complete: false,
          truncated: true,
          callsUsed: 1,
        };
      },
    });

    await runSourceSync({ connection, store, sink, provider, mirrorRoot, callBudget: 2 });
    expect(store.state(connection.id)?.commentWatermarks[docId]).toBeUndefined();
    expect(store.state(connection.id)?.commentPageCursors[docId]).toBe('page-2');
    expect(store.listComments(connection.id).map((item) => item.id)).toEqual(['comment-1']);

    await runSourceSync({ connection, store, sink, provider, mirrorRoot, callBudget: 2 });
    expect(store.state(connection.id)?.commentWatermarks[docId]).toBe('2026-08-30T00:01:00.000Z');
    expect(store.state(connection.id)?.commentPageCursors[docId]).toBeUndefined();
    expect(store.listComments(connection.id).map((item) => item.id)).toEqual(['comment-1', 'comment-2']);
    expect((await sink.read(docId))?.localVersion).toBe(before?.localVersion);
  });

  it('uses one shared comment request budget across documents', async () => {
    const { store, connection, sink, mirrorRoot } = await setup({ watchComments: true });
    for (const externalId of ['A', 'B', 'C']) {
      await sink.upsert(makeMirroredDoc(computeDocId(connection, externalId), externalId, 'v1'), `Body ${externalId}.`);
    }
    const budgets: number[] = [];
    const provider = makeProvider({
      comments: true,
      pollChanges: async () => ({
        changes: [],
        watermark: null,
        nextPageCursor: null,
        complete: true,
        truncated: false,
        callsUsed: 1,
      }),
      listComments: async (_ref, _since, options) => {
        budgets.push(options?.callBudget ?? -1);
        return { comments: [], nextPageCursor: null, complete: true, truncated: false, callsUsed: 1 };
      },
    });

    await runSourceSync({ connection, store, sink, provider, mirrorRoot, callBudget: 4 });
    expect(budgets).toEqual([3, 2, 1]);
    expect(Object.keys(store.state(connection.id)?.commentSweepAt ?? {})).toHaveLength(3);
  });

  it('a disabled connection does not run', async () => {
    const { store, connection, sink, mirrorRoot } = await setup({
      enabled: false,
    });
    const result = await runSourceSync({
      connection,
      store,
      sink,
      provider: makeProvider(),
      mirrorRoot,
    });
    expect(result.ran).toBe(false);
  });

  it('an archived connection does not run', async () => {
    const { store, connection, sink, mirrorRoot } = await setup({
      mode: 'archived',
    });
    const result = await runSourceSync({
      connection,
      store,
      sink,
      provider: makeProvider(),
      mirrorRoot,
    });
    expect(result.ran).toBe(false);
  });

  it('a connection still backed off does not run', async () => {
    const { store, connection, sink, mirrorRoot } = await setup();
    store.updateState('conn-1', {
      backoffUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    const result = await runSourceSync({
      connection,
      store,
      sink,
      provider: makeProvider(),
      mirrorRoot,
    });
    expect(result.ran).toBe(false);
  });

  it('a held lease returns immediately without touching the mirror', async () => {
    const { store, connection, sink, mirrorRoot } = await setup();
    const lease = store.acquireLease();
    expect(lease).toBeDefined();
    const provider = makeProvider();
    const detect = vi.spyOn(provider, 'detect');
    const result = await runSourceSync({
      connection,
      store,
      sink,
      provider,
      mirrorRoot,
    });
    expect(result.ran).toBe(false);
    expect(detect).not.toHaveBeenCalled();
    lease!.release();
  });

  it('an enumeration error (not a budget cutoff) sets a backoff and syncState: error', async () => {
    const { store, connection, sink, mirrorRoot } = await setup();
    const provider = makeProvider({
      pollChanges: async () => ({
        changes: [],
        watermark: null,
        nextPageCursor: null,
        complete: false,
        truncated: false, // a real failure, not a budget cutoff
      }),
    });
    const result = await runSourceSync({
      connection,
      store,
      sink,
      provider,
      mirrorRoot,
    });
    expect(result.syncState).toBe('error');
    expect(store.state('conn-1')?.backoffUntil).toBeDefined();
  });

  it('never schedules a retry before a provider Retry-After lower bound', async () => {
    const { store, connection, sink, mirrorRoot } = await setup();
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const provider = makeProvider({
        pollChanges: async () => ({
          changes: [],
          watermark: null,
          nextPageCursor: null,
          complete: false,
          truncated: false,
          callsUsed: 1,
          retryAfterMs: 120_000,
        }),
      });
      await runSourceSync({ connection, store, sink, provider, mirrorRoot });
      const state = store.state(connection.id)!;
      expect(Date.parse(state.backoffUntil!) - Date.parse(state.lastError!.at)).toBe(120_000);
    } finally {
      random.mockRestore();
    }
  });

  it('a budget cutoff (truncated) sets no backoff', async () => {
    const { store, connection, sink, mirrorRoot } = await setup();
    const provider = makeProvider({
      pollChanges: async () => ({
        changes: [],
        watermark: null,
        nextPageCursor: 'page-2',
        complete: false,
        truncated: true,
      }),
    });
    const result = await runSourceSync({
      connection,
      store,
      sink,
      provider,
      mirrorRoot,
    });
    expect(result.syncState).toBe('ok');
    expect(store.state('conn-1')?.backoffUntil).toBeUndefined();
  });

  it('forwards notifyChanged with the changed docIds after a commit, required not best effort', async () => {
    const { store, connection, sink, mirrorRoot } = await setup();
    const notifyChanged = vi.spyOn(sink, 'notifyChanged');
    const provider = makeProvider({
      pollChanges: async () => ({
        changes: [{ type: 'upsert', doc: refFor('A') }],
        watermark: null,
        nextPageCursor: null,
        complete: true,
        truncated: false,
      }),
    });
    await runSourceSync({ connection, store, sink, provider, mirrorRoot });
    expect(notifyChanged).toHaveBeenCalledWith(mirrorRoot, [computeDocId(connection, 'A')]);
  });

  it('a docId collision between two different externalIds is a hard error naming both', async () => {
    // A genuine SHA-256 collision cannot be manufactured for real inputs, this simulates one by
    // writing a document under `ext-a`'s docId whose OWN frontmatter claims a different
    // externalId, exactly the state a real collision would produce.
    const { store, connection, sink, mirrorRoot } = await setup();
    const collidingDocId = computeDocId(connection, 'ext-a');
    await sink.upsert(makeMirroredDoc(collidingDocId, 'ext-b', 'v1'), 'Body.');

    const provider = makeProvider({
      pollChanges: async () => ({
        changes: [{ type: 'upsert', doc: refFor('ext-a') }],
        watermark: null,
        nextPageCursor: null,
        complete: true,
        truncated: false,
      }),
    });

    const result = await runSourceSync({
      connection,
      store,
      sink,
      provider,
      mirrorRoot,
    });
    expect(result.syncState).toBe('error');
    expect(result.reason).toContain('ext-a');
    expect(result.reason).toContain('ext-b');
  });
});
