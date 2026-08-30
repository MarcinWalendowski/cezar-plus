import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SourceStore } from './store.ts';

const dirs: string[] = [];

async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cezar-source-comments-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const comment = (externalId: string, body = `Comment ${externalId}`) => ({
  externalId,
  author: 'user-1',
  body,
  createdAt: '2026-08-30T00:00:00.000Z',
  attachments: [{ type: 'image', downloadable: false }],
});

describe('SourceStore comment stream', () => {
  it('appends one row per connection and external comment id in stable sequence order', async () => {
    const store = SourceStore.open(await directory());
    expect(store.appendComments('conn-1', 'doc-1', [comment('c-1'), comment('c-1', 'duplicate')])).toHaveLength(1);
    expect(store.appendComments('conn-1', 'doc-1', [comment('c-1')])).toHaveLength(0);
    expect(store.appendComments('conn-2', 'doc-2', [comment('c-1')])).toHaveLength(1);

    expect(store.listComments('conn-1')).toEqual([
      expect.objectContaining({ seq: 1, connectionId: 'conn-1', id: 'c-1', docId: 'doc-1', body: 'Comment c-1' }),
    ]);
    expect(store.listComments('conn-2')).toEqual([
      expect.objectContaining({ seq: 2, connectionId: 'conn-2', id: 'c-1', docId: 'doc-2' }),
    ]);
  });

  it('compaction preserves every unique comment and blocks duplicates after compaction', async () => {
    const dir = await directory();
    const store = SourceStore.open(dir);
    store.appendComments('conn-1', 'doc-1', [comment('c-1')]);
    store.appendComments('conn-1', 'doc-1', [comment('c-2')]);
    const path = join(dir, 'source-comments.ndjson');
    const rows = readFileSync(path, 'utf8').trim().split('\n');
    writeFileSync(path, `${rows[0]}\n${rows[0]}\n${rows[1]}\n`);

    store.compactComments();

    expect(store.listComments('conn-1').map((item) => item.id)).toEqual(['c-1', 'c-2']);
    expect(store.appendComments('conn-1', 'doc-1', [comment('c-1')])).toHaveLength(0);
  });
});
