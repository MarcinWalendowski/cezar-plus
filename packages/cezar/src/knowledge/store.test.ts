import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileSourceSink } from '../sources/sink.ts';
import type { MirroredDocument } from '../sources/types.ts';
import { KnowledgeStore, type KnowledgeStoreOptions } from './store.ts';

async function tempDir(prefix: string): Promise<string> {
  const base = await realpath(tmpdir());
  const dir = await mkdtemp(join(base, prefix));
  dirs.push(dir);
  return dir;
}

const dirs: string[] = [];
const openStores: KnowledgeStore[] = [];
afterEach(async () => {
  for (const store of openStores.splice(0)) store.dispose();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function openStore(
  repoRoot: string,
  options: KnowledgeStoreOptions = {},
): Promise<{ store: KnowledgeStore; dataDir: string }> {
  const dataDir = join(repoRoot, '.ai/cezar');
  const store = KnowledgeStore.create(repoRoot, dataDir, options);
  openStores.push(store);
  await store.initialize();
  return { store, dataDir };
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('KnowledgeStore — snapshot and scan', () => {
  it('reports zero counts and no throw when nothing exists at all', async () => {
    const repoRoot = await tempDir('cez-kb-store-empty-');
    const { store } = await openStore(repoRoot);
    expect(store.getCounts()).toEqual({ documents: 0, idCollisions: 0 });
    expect(store.getRoots().find((r) => r.id === 'project')).toMatchObject({ writable: true, indexed: true, documentCount: 0 });
  });

  it('scan caps are reported in the store snapshot, never silently short', async () => {
    const repoRoot = await tempDir('cez-kb-store-caps-');
    const dataDir = join(repoRoot, '.ai/cezar/knowledge');
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, 'huge.md'), 'x'.repeat(50), 'utf8');
    const { store } = await openStore(repoRoot, { caps: { maxFileBytes: 10, maxFiles: 20_000, maxTotalBytes: 64 * 1_048_576 } });
    expect(store.getScan()).toMatchObject({ truncated: true, capHit: 'perFile', skipped: 1 });
  });
});

describe('KnowledgeStore — formatVersion mismatch (C11)', () => {
  it('discards a mismatched manifest/catalog and rebuilds, leaving no trace of the bogus entry', async () => {
    const repoRoot = await tempDir('cez-kb-store-fv-');
    const dataDir = join(repoRoot, '.ai/cezar');
    await mkdir(join(dataDir, 'knowledge-index'), { recursive: true });
    await writeFile(
      join(dataDir, 'knowledge-index/manifest.json'),
      JSON.stringify({ formatVersion: 0, roots: [], docs: {} }),
      'utf8',
    );
    await writeFile(
      join(dataDir, 'knowledge-index/catalog.ndjson'),
      `${JSON.stringify({
        id: 'project-bogus00000001',
        slug: 'bogus',
        root: 'project',
        path: '/does/not/exist.md',
        title: 'Bogus',
        type: 'note',
        tags: [],
        status: 'current',
        identifiers: [],
        updatedAt: new Date(0).toISOString(),
        hash: 'h',
        bytes: 1,
        headings: [],
        excerpt: '',
        links: [],
        backlinkCount: 0,
      })}\n`,
      'utf8',
    );

    const { store } = await openStore(repoRoot);
    expect(store.getDocument('project-bogus00000001')).toBeNull();
    expect(store.getCounts().documents).toBe(0);
  });
});

describe('KnowledgeStore — CRUD, containment and optimistic concurrency', () => {
  it('creates a document under the project root and returns it', async () => {
    const repoRoot = await tempDir('cez-kb-store-create-');
    const { store } = await openStore(repoRoot);
    const result = await store.createDocument({ scope: 'project', path: 'decisions/one.md', content: '# One\n\nBody.' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.document.root).toBe('project');
      expect(result.document.title).toBe('One');
      expect(result.document.body).toBe('\nBody.');
    }
  });

  it('refuses a path that escapes the writable root with 400, and writes nothing', async () => {
    const repoRoot = await tempDir('cez-kb-store-escape-');
    const { store } = await openStore(repoRoot);
    const result = await store.createDocument({ scope: 'project', path: '../../etc/evil.md', content: 'nope' });
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it('refuses to create at a path that already has a document, 409', async () => {
    const repoRoot = await tempDir('cez-kb-store-exists-');
    const { store } = await openStore(repoRoot);
    await store.createDocument({ scope: 'project', path: 'a.md', content: '# A' });
    const second = await store.createDocument({ scope: 'project', path: 'a.md', content: '# A again' });
    expect(second).toMatchObject({ ok: false, status: 409 });
  });

  it('a stale-version PUT is refused 409 and the bytes on disk are unchanged', async () => {
    const repoRoot = await tempDir('cez-kb-store-put-');
    const { store } = await openStore(repoRoot);
    const created = await store.createDocument({ scope: 'project', path: 'doc.md', content: '# Doc\n\noriginal' });
    if (!created.ok) throw new Error('setup failed');
    const path = created.document.path;
    const before = await readFile(path, 'utf8');

    const result = await store.updateDocument(created.document.id, { content: '# Doc\n\ntampered', version: 'not-the-real-hash' });
    expect(result).toMatchObject({ ok: false, status: 409 });

    const after = await readFile(path, 'utf8');
    expect(after).toBe(before);
  });

  it('a correctly-versioned PUT succeeds and re-indexes the new content', async () => {
    const repoRoot = await tempDir('cez-kb-store-put-ok-');
    const { store } = await openStore(repoRoot);
    const created = await store.createDocument({ scope: 'project', path: 'doc.md', content: '# Doc\n\noriginal' });
    if (!created.ok) throw new Error('setup failed');

    const result = await store.updateDocument(created.document.id, { content: '# Doc\n\nupdated', version: created.document.hash });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.document.body).toContain('updated');
  });

  it('deletes a document and it no longer appears in the store', async () => {
    const repoRoot = await tempDir('cez-kb-store-delete-');
    const { store } = await openStore(repoRoot);
    const created = await store.createDocument({ scope: 'project', path: 'doc.md', content: '# Doc' });
    if (!created.ok) throw new Error('setup failed');
    const result = await store.deleteDocument(created.document.id);
    expect(result).toEqual({ ok: true });
    expect(store.getDocument(created.document.id)).toBeNull();
  });
});

describe('KnowledgeStore — C17: the mirror wire', () => {
  it('a document dropped straight into the sources mirror root is indexed with root: "sources"', async () => {
    const repoRoot = await tempDir('cez-kb-store-mirror-');
    const dataDir = join(repoRoot, '.ai/cezar');
    await mkdir(join(dataDir, 'sources/x'), { recursive: true });
    await writeFile(join(dataDir, 'sources/x/y.md'), '# Mirrored\n\nFrom the sources mount.', 'utf8');

    const { store } = await openStore(repoRoot);
    const result = store.search('Mirrored');
    expect(result.results.some((d) => d.root === 'sources')).toBe(true);
  });
});

describe('KnowledgeStore — C19: both change triggers reindex, neither is the only path', () => {
  it('(a) the watcher alone indexes a file with NO notifyChanged call', async () => {
    const repoRoot = await tempDir('cez-kb-store-watch-');
    const dataDir = join(repoRoot, '.ai/cezar');
    await mkdir(join(dataDir, 'knowledge'), { recursive: true });
    const { store } = await openStore(repoRoot); // watchers ON by default

    expect(store.getDocument('project-doesnotmatter')).toBeNull();
    await writeFile(join(dataDir, 'knowledge/new-via-watch.md'), '# New via watch', 'utf8');
    // No notifyChanged call anywhere in this test — only the fs.watch trigger may pick this up.
    await waitMs(700);

    const found = store.search('New via watch');
    expect(found.results.length).toBeGreaterThan(0);
  });

  it('(b) notifyChanged alone indexes a file with the watcher DISABLED', async () => {
    const repoRoot = await tempDir('cez-kb-store-notify-');
    const dataDir = join(repoRoot, '.ai/cezar');
    await mkdir(join(dataDir, 'knowledge'), { recursive: true });
    const { store } = await openStore(repoRoot, { disableWatchers: true });

    await writeFile(join(dataDir, 'knowledge/new-via-notify.md'), '# New via notify', 'utf8');
    store.notifyChanged('project');
    await waitMs(500); // the debounce window, but there is no watcher to have fired it

    const found = store.search('New via notify');
    expect(found.results.length).toBeGreaterThan(0);
  });
});

describe('KnowledgeStore — C20: adoption sink', () => {
  it('adopt() moves the mirrored bytes into the project root, sets origin:local, and it is found by root:"project"', async () => {
    const repoRoot = await tempDir('cez-kb-store-adopt-');
    const { store, dataDir } = await openStore(repoRoot);

    const sink = new FileSourceSink(dataDir, 'conn1');
    const docId = '0123456789abcdef';
    const doc: MirroredDocument = {
      docId,
      title: 'Adopted Doc',
      source: {
        kind: 'notion',
        connectionId: 'conn1',
        externalId: 'ext-1',
        url: 'https://example.invalid/p/1',
        remoteVersion: '2026-08-06T00:00:00.000Z',
        origin: 'remote',
        state: 'ok',
        mirroredAt: new Date().toISOString(),
        lossy: [],
      },
      collectionExternalId: 'coll-1',
      docType: 'page',
      properties: {},
      unresolvedComments: 0,
    };
    await sink.upsert(doc, '# Adopted Doc\n\nMirrored body.');
    await store.reindexNow();
    expect(store.search('Adopted Doc').results.some((d) => d.root === 'sources')).toBe(true);

    const wrapped = store.createSourceSink(sink);
    await wrapped.adopt(docId);
    await store.reindexNow();

    const mirrorPathAfter = join(dataDir, 'sources/conn1', `${docId}.md`);
    await expect(readFile(mirrorPathAfter, 'utf8')).rejects.toThrow();

    const results = store.search('Adopted Doc').results;
    const adopted = results.find((d) => d.root === 'project');
    expect(adopted).toBeDefined();
    expect(adopted?.source?.origin).toBe('local');
    expect(adopted?.source?.adoptedAt).toBeTruthy();
  });
});
