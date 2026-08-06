import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';
import { FileSourceSink } from './sink.ts';
import { mirroredDocumentSchema, type MirroredDocument } from './types.ts';

const dirs: string[] = [];

async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cezar-sources-sink-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function hashOf(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

function makeDoc(
  docId: string,
  opts: { externalId?: string; title?: string; connectionId?: string } = {},
): MirroredDocument {
  const { externalId = docId, title = 'Some Notion Page', connectionId = 'conn-1' } = opts;
  return mirroredDocumentSchema.parse({
    docId,
    title,
    source: {
      kind: 'notion',
      connectionId,
      externalId,
      url: `https://notion.so/${externalId}`,
      remoteVersion: 'v1',
      mirroredAt: '2026-08-01T00:00:00.000Z',
    },
    collectionExternalId: 'db-1',
  });
}

/** Writes a raw `.md` file directly, bypassing the sink — used to simulate a file an OLDER
 *  version of this schema wrote (an "old shape" fixture, for the forward-compatibility test). */
function writeRawDoc(dir: string, connectionId: string, docId: string, frontmatter: unknown, body: string): void {
  const path = join(dir, 'sources', connectionId, `${docId}.md`);
  mkdirSync(dirname(path), { recursive: true });
  const front = stringifyYaml(frontmatter).trimEnd();
  writeFileSync(path, `---\n${front}\n---\n\n${body}`);
}

function listAllFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true }) as string[];
}

describe('FileSourceSink', () => {
  it('round-trips a document body and metadata through upsert, readMeta and read', async () => {
    const dir = await directory();
    const sink = new FileSourceSink(dir, 'conn-1');
    const doc = makeDoc('0123456789abcdef');

    const first = await sink.upsert(doc, 'Hello world.');
    expect(first.changed).toBe(true);
    expect(first.localVersion).toBe(hashOf('Hello world.'));

    const meta = await sink.readMeta(doc.docId);
    expect(meta?.title).toBe(doc.title);
    expect(meta?.localVersion).toBe(first.localVersion);
    expect(meta?.source.origin).toBe('remote');

    const read = await sink.read(doc.docId);
    expect(read).toEqual({ body: 'Hello world.', localVersion: first.localVersion });

    // A byte-identical re-upsert is a true no-op: it does not report a change.
    const second = await sink.upsert(doc, 'Hello world.');
    expect(second.changed).toBe(false);
  });

  it('an unknown frontmatter key survives .passthrough(), and an old-shape file still parses', async () => {
    const dir = await directory();
    // No `docType`, `unresolvedComments`, `properties`, `remoteVersionSeen`, `localVersion`, or
    // `source.origin`/`source.state` — exactly what an OLDER writer, before those fields existed
    // or were populated, would have left on disk. Plus one key no current schema field names.
    writeRawDoc(
      dir,
      'conn-1',
      '0123456789abcdef',
      {
        docId: '0123456789abcdef',
        title: 'Old page',
        source: {
          kind: 'notion',
          connectionId: 'conn-1',
          externalId: 'ext-1',
          url: 'https://notion.so/ext-1',
          remoteVersion: 'v1',
          mirroredAt: '2026-08-01T00:00:00.000Z',
        },
        collectionExternalId: 'db-1',
        futureField: 'kept',
      },
      'Body text.',
    );

    const sink = new FileSourceSink(dir, 'conn-1');
    const meta = await sink.readMeta('0123456789abcdef');
    expect(meta?.futureField).toBe('kept');
    expect(meta?.docType).toBe('page');
    expect(meta?.unresolvedComments).toBe(0);
    expect(meta?.properties).toEqual({});
    expect(meta?.source.origin).toBe('remote');
    expect(meta?.source.state).toBe('ok');
  });

  it('readMeta and read return null for a document that does not exist', async () => {
    const sink = new FileSourceSink(await directory(), 'conn-1');
    expect(await sink.readMeta('0000000000000000')).toBeNull();
    expect(await sink.read('0000000000000000')).toBeNull();
  });

  it('NC-5: changing only the title performs zero file renames', async () => {
    const dir = await directory();
    const sink = new FileSourceSink(dir, 'conn-1');
    const doc = makeDoc('0123456789abcdef');
    await sink.upsert(doc, 'Body.');
    const before = readdirSync(join(dir, 'sources', 'conn-1')).sort();

    await sink.upsert({ ...doc, title: 'A completely renamed title' }, 'Body.');
    const after = readdirSync(join(dir, 'sources', 'conn-1')).sort();

    expect(after).toEqual(before);
    expect((await sink.readMeta(doc.docId))?.title).toBe('A completely renamed title');
  });

  it('NC-4 (sink scope): quarantine leaves the local body byte-identical and flips state to conflict', async () => {
    const dir = await directory();
    const sink = new FileSourceSink(dir, 'conn-1');
    const doc = makeDoc('0123456789abcdef');
    await sink.upsert(doc, 'Local edited body.');

    await sink.quarantine(doc.docId, '2026-08-05T00:00:00.000Z', 'Incoming remote body.');

    const read = await sink.read(doc.docId);
    expect(read?.body).toBe('Local edited body.');

    const meta = await sink.readMeta(doc.docId);
    expect(meta?.source.state).toBe('conflict');

    const conflictsDir = join(dir, 'sources', 'conn-1', 'conflicts');
    const files = readdirSync(conflictsDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(new RegExp(`^${doc.docId}\\.remote-[0-9a-f]{8}\\.md$`));
    expect(readFileSync(join(conflictsDir, files[0]!), 'utf8')).toBe('Incoming remote body.');
  });

  it('quarantine still writes the conflict artifact when there is no local file to mark', async () => {
    const dir = await directory();
    const sink = new FileSourceSink(dir, 'conn-1');
    await expect(sink.quarantine('0123456789abcdef', 'v2', 'Incoming.')).resolves.toBeUndefined();
    const conflictsDir = join(dir, 'sources', 'conn-1', 'conflicts');
    expect(readdirSync(conflictsDir)).toHaveLength(1);
  });

  it('tombstone moves the document to deleted/ with state flipped, and removes it from the mirror', async () => {
    const dir = await directory();
    const sink = new FileSourceSink(dir, 'conn-1');
    const doc = makeDoc('0123456789abcdef');
    await sink.upsert(doc, 'Body.');

    await sink.tombstone(doc.docId, '2026-08-06T00:00:00.000Z');

    expect(await sink.read(doc.docId)).toBeNull();
    const deletedRaw = readFileSync(join(dir, 'sources', 'conn-1', 'deleted', `${doc.docId}.md`), 'utf8');
    expect(deletedRaw).toContain('state: tombstoned');
    expect(deletedRaw).toContain('Body.');
  });

  it('adopt moves the file into knowledge/, flips origin to local with adoptedAt set, and creates no directory named adopted', async () => {
    const dir = await directory();
    const sink = new FileSourceSink(dir, 'conn-1', { now: () => new Date('2026-08-06T12:00:00.000Z') });
    const doc = makeDoc('0123456789abcdef');
    await sink.upsert(doc, 'Body.');

    const result = await sink.adopt(doc.docId);
    expect(result.adoptedAt).toBe('2026-08-06T12:00:00.000Z');
    expect(result.path).toBe(join(dir, 'knowledge', `${doc.docId}.md`));

    expect(await sink.read(doc.docId)).toBeNull();
    expect(readdirSync(join(dir, 'sources', 'conn-1'))).not.toContain(`${doc.docId}.md`);

    const knowledgeRaw = readFileSync(join(dir, 'knowledge', `${doc.docId}.md`), 'utf8');
    expect(knowledgeRaw).toContain('origin: local');
    expect(knowledgeRaw).toContain('adoptedAt: 2026-08-06T12:00:00.000Z');

    expect(existsSync(join(dir, 'sources', 'conn-1', 'adopted'))).toBe(false);
    expect(existsSync(join(dir, 'adopted'))).toBe(false);
    expect(existsSync(join(dir, 'sources', 'adopted'))).toBe(false);
  });

  it('adopt throws for a document that is not in the mirror', async () => {
    const sink = new FileSourceSink(await directory(), 'conn-1');
    await expect(sink.adopt('0000000000000000')).rejects.toThrow();
  });

  it('upsert refuses a document whose source.connectionId does not match the bound connection', async () => {
    const dir = await directory();
    const sink = new FileSourceSink(dir, 'conn-1');
    const doc = makeDoc('0123456789abcdef', { connectionId: 'conn-OTHER' });
    await expect(sink.upsert(doc, 'Body.')).rejects.toThrow();
  });

  it('list() returns only this connection\'s documents, and throws on a mismatched connectionId', async () => {
    const dir = await directory();
    const sink = new FileSourceSink(dir, 'conn-1');
    await sink.upsert(makeDoc('0123456789abcdef', { externalId: 'ext-1' }), 'Body 1.');
    await sink.upsert(makeDoc('fedcba9876543210', { externalId: 'ext-2' }), 'Body 2.');

    const docs = await sink.list('conn-1');
    expect(docs.map((d) => d.docId).sort()).toEqual(['0123456789abcdef', 'fedcba9876543210']);

    await expect(sink.list('conn-2')).rejects.toThrow();
  });

  it('list() on an empty or nonexistent mirror directory returns []', async () => {
    const sink = new FileSourceSink(await directory(), 'conn-1');
    expect(await sink.list('conn-1')).toEqual([]);
  });

  it('notifyChanged is a genuine no-op standalone', () => {
    const sink = new FileSourceSink('/does/not/exist', 'conn-1');
    expect(sink.notifyChanged('/some/root', ['a', 'b'])).toBeUndefined();
  });

  it('never leaves a .tmp artifact after upsert, quarantine, tombstone, or adopt', async () => {
    const dir = await directory();
    const sink = new FileSourceSink(dir, 'conn-1');
    const quarantined = makeDoc('0123456789abcdef', { externalId: 'ext-1' });
    await sink.upsert(quarantined, 'Body.');
    await sink.quarantine(quarantined.docId, 'v2', 'Incoming.');
    await sink.tombstone(quarantined.docId, '2026-08-06T00:00:00.000Z');

    const adopted = makeDoc('fedcba9876543210', { externalId: 'ext-2' });
    await sink.upsert(adopted, 'Body 2.');
    await sink.adopt(adopted.docId);

    expect(listAllFiles(dir).some((f) => f.includes('.tmp'))).toBe(false);
  });
});
