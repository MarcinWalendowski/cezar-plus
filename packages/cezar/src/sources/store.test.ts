import { chmodSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SECRET_NAME_RE } from '../core/secret-redaction.ts';
import { SourceStore } from './store.ts';

const dirs: string[] = [];
const input = {
  kind: 'notion',
  name: 'Acme workspace',
  enabled: false,
  mode: 'mirror' as const,
  intervalSeconds: 900,
  collections: [],
  watchComments: false,
  maxDocuments: 5_000,
  maxBodyBytes: 524_288,
};

async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cezar-sources-'));
  dirs.push(dir);
  return dir;
}

/** Recursively collects every object key in a parsed value — used to prove NC-7's "no key
 *  matches SECRET_NAME_RE", which is a KEY check, not a value check (the schema has no `token`
 *  field at all, per spec Q7). */
function collectKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
  } else if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      out.push(key);
      collectKeys(v, out);
    }
  }
  return out;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('SourceStore', () => {
  it('writes connections atomically at private permissions and preserves unknown fields', async () => {
    const dir = await directory();
    const store = SourceStore.open(dir);
    const created = store.create(input, 'acme-notion');
    const path = join(dir, 'sources.json');
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    raw.future = { kept: true };
    raw.connections[0].futureField = true;
    writeFileSync(path, JSON.stringify(raw));

    // A "required-looking" new field added to the schema still parses an old file: an old
    // connection row (no `futureField` in the schema at all) round-trips through the store
    // unharmed, because `.passthrough()` at every layer keeps it rather than stripping it.
    const reopened = SourceStore.open(dir);
    expect(reopened.get('acme-notion')?.futureField).toBe(true);
    reopened.update('acme-notion', created.revision, { ...input, name: 'Renamed' });
    const persisted = JSON.parse(readFileSync(path, 'utf8'));
    expect(persisted.future).toEqual({ kept: true });
    expect(persisted.connections[0].futureField).toBe(true);
    await expect(stat(path).then((s) => s.mode & 0o777)).resolves.toBe(0o600);
  });

  it('rejects a connection id that fails PROJECT_ID_RE', async () => {
    const store = SourceStore.open(await directory());
    expect(() => store.create(input, 'Not_A-Valid-Id!')).toThrow();
    expect(() => store.create(input, '')).toThrow();
    expect(store.create(input, 'valid-id-2').id).toBe('valid-id-2');
  });

  it('salvages valid entries and malformed NDJSON log rows with one warning per file', async () => {
    const dir = await directory();
    const valid = SourceStore.open(dir).create(input, 'valid');
    writeFileSync(
      join(dir, 'sources.json'),
      JSON.stringify({ version: 1, connections: [valid, { id: 'broken' }] }),
    );
    writeFileSync(join(dir, 'source-log.ndjson'), '{bad json}\n{}\n');
    const warnings: string[] = [];
    const store = SourceStore.open(dir, { warn: (warning) => warnings.push(warning) });
    expect(store.list().map((item) => item.id)).toEqual(['valid']);
    expect(store.logs()).toEqual([]);
    expect(warnings).toHaveLength(2);
  });

  it('degrades a corrupt sources.json to an empty list plus one warning, never throws', async () => {
    const dir = await directory();
    writeFileSync(join(dir, 'sources.json'), '{not json');
    const warnings: string[] = [];
    expect(() => SourceStore.open(dir, { warn: (w) => warnings.push(w) })).not.toThrow();
    const store = SourceStore.open(dir, { warn: (w) => warnings.push(w) });
    expect(store.list()).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('enforces optimistic revisions and tombstones deleted ids', async () => {
    const store = SourceStore.open(await directory());
    store.create(input, 'one');
    expect(() => store.update('one', 9, input)).toThrow('revision conflict');
    expect(store.delete('one')).toBe(true);
    expect(() => store.create(input, 'one')).toThrow('unavailable');
  });

  it('holds an exclusive recoverable poll lease', async () => {
    const dir = await directory();
    const store = SourceStore.open(dir);
    const first = store.acquireLease();
    expect(first).toBeDefined();
    expect(store.acquireLease()).toBeUndefined();
    first?.release();
    expect(store.acquireLease()).toBeDefined();
    chmodSync(dir, 0o700);
  });

  it('reclaims a poll lease held longer than the stale window', async () => {
    const dir = await directory();
    const store = SourceStore.open(dir);
    const first = store.acquireLease(1_000);
    expect(first).toBeDefined();
    expect(store.acquireLease(1_000)).toBeUndefined();
    const lockPath = join(dir, 'sources-poll.lock');
    const past = new Date(Date.now() - 5_000);
    utimesSync(lockPath, past, past);
    const reclaimed = store.acquireLease(1_000);
    expect(reclaimed).toBeDefined();
  });

  it('never leaves a .tmp file after a connection write, a state write, or a log append', async () => {
    const dir = await directory();
    const store = SourceStore.open(dir);
    const created = store.create(input, 'one');
    store.update('one', created.revision, { ...input, name: 'Two' });
    store.updateState('one', { syncState: 'ok' });
    store.appendLog({ connectionId: 'one', event: 'sweep-complete' });
    store.delete('one');
    const entries = readdirSync(dir);
    expect(entries.some((name) => name.includes('.tmp'))).toBe(false);
  });

  it('tracks adopted and tombstoned external ids per connection, deduplicated', async () => {
    const store = SourceStore.open(await directory());
    store.create(input, 'one');
    expect(store.isAdopted('one', 'ext-1')).toBe(false);
    store.adopt('one', 'ext-1');
    store.adopt('one', 'ext-1'); // idempotent
    expect(store.isAdopted('one', 'ext-1')).toBe(true);
    expect(store.state('one')?.adoptedExternalIds).toEqual(['ext-1']);

    expect(store.isTombstonedExternal('one', 'ext-2')).toBe(false);
    store.tombstoneExternal('one', 'ext-2');
    expect(store.isTombstonedExternal('one', 'ext-2')).toBe(true);
    expect(store.state('one')?.tombstonedExternalIds).toEqual(['ext-2']);
  });

  it('persists syncState transitions as writes, never derived from the clock (D8)', async () => {
    const store = SourceStore.open(await directory(), { now: () => new Date('2026-08-06T00:00:00.000Z') });
    store.create(input, 'one');
    expect(store.state('one')).toBeUndefined();
    const updated = store.updateState('one', { syncState: 'unavailable', lastError: { at: '2026-08-06T00:00:00.000Z', message: 'revoked token' } });
    expect(updated.syncState).toBe('unavailable');
    expect(updated.syncStateAt).toBeUndefined(); // caller sets it explicitly; the store never infers one
    expect(store.state('one')?.syncState).toBe('unavailable');
  });

  it('compacts the log past 10,500 rows, keeping only the newest 10,000', async () => {
    const store = SourceStore.open(await directory());
    store.create(input, 'one');
    for (let i = 0; i < 10_501; i++) store.appendLog({ connectionId: 'one', event: 'tick' });
    store.maybeCompact();
    expect(store.logs({ limit: 100 }).length).toBe(100);
    // seq keeps climbing across compaction; the newest row is untouched.
    expect(store.logs({ limit: 1 })[0]?.seq).toBe(10_501);
  });

  it('recovers the sequence from the newest intact row, stepping over a torn trailing line', async () => {
    const dir = await directory();
    const first = SourceStore.open(dir);
    first.create(input, 'one');
    for (let i = 0; i < 3; i++) first.appendLog({ connectionId: 'one', event: 'tick' });

    // A crash mid-append leaves a half-written final line. Recovering the sequence must step
    // over it rather than restart at 0, which would reissue seq values that are already live.
    const log = join(dir, 'source-log.ndjson');
    writeFileSync(log, `${readFileSync(log, 'utf8')}{"seq":4,"connectionId":"one"`);

    const reopened = SourceStore.open(dir);
    expect(reopened.appendLog({ connectionId: 'one', event: 'tick' }).seq).toBe(4);
  });

  it('recovers the comment sequence from a row larger than the tail window', async () => {
    const dir = await directory();
    const store = SourceStore.open(dir);
    store.create(input, 'one');
    // A comment body is uncapped (unlike a log `message`), so one row can exceed the 64KiB first
    // read. The tail scan has to widen until it finds a complete line instead of falling through
    // to a zeroed sequence, which would reissue ids that are already on disk.
    const entry = {
      externalId: 'comment-1',
      body: 'x'.repeat(200_000),
      createdAt: '2026-08-30T00:00:00.000Z',
      attachments: [],
    };
    expect(store.appendComments('one', 'doc-1', [entry])[0]?.seq).toBe(1);

    const reopened = SourceStore.open(dir);
    const next = reopened.appendComments('one', 'doc-1', [{ ...entry, externalId: 'comment-2', body: 'short' }]);
    expect(next[0]?.seq).toBe(2);
  });

  it('NC-7 (store scope): no key in a serialized connection matches SECRET_NAME_RE', async () => {
    const store = SourceStore.open(await directory());
    store.create(input, 'one');
    const keys = collectKeys(store.list());
    for (const key of keys) expect(SECRET_NAME_RE.test(key)).toBe(false);
  });
});
