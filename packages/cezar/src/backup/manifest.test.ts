import { describe, expect, it } from 'vitest';
import { newBlobKeys, parseManifest, serializeManifest, type Manifest, type ManifestEntry } from './manifest.ts';

function entry(path: string, hmacKey: string): ManifestEntry {
  return { path, sha256: `sha-${hmacKey}`, size: 42, hmacKey };
}

function manifest(entries: ManifestEntry[]): Manifest {
  return { schemaVersion: 1, createdAt: '2026-08-16T12:00:00.000Z', run: { uploaded: 0, skipped: 0, bytes: 0 }, entries };
}

describe('serializeManifest / parseManifest', () => {
  it('round-trips a manifest byte-for-byte in content', () => {
    const original = manifest([entry('home/config.json', 'aaa'), entry('home/notes.json', 'bbb')]);
    const roundTripped = parseManifest(serializeManifest(original));
    expect(roundTripped).toEqual(original);
  });

  it('round-trips an empty manifest', () => {
    const original = manifest([]);
    expect(parseManifest(serializeManifest(original))).toEqual(original);
  });

  it('throws on a malformed manifest rather than returning garbage', () => {
    expect(() => parseManifest(Buffer.from('not json', 'utf8'))).toThrow();
    expect(() => parseManifest(Buffer.from(JSON.stringify({ hello: 'world' }), 'utf8'))).toThrow();
  });
});

describe('newBlobKeys', () => {
  it('prev=null: every distinct hmacKey in nextEntries is new (first run)', () => {
    const next = [entry('home/a', 'k1'), entry('home/b', 'k2'), entry('home/c', 'k2')];
    const result = newBlobKeys(null, next);
    expect(result).toEqual(new Set(['k1', 'k2']));
  });

  it('unchanged: nextEntries with the same hmacKeys as prev yields no new keys', () => {
    const prev = manifest([entry('home/a', 'k1'), entry('home/b', 'k2')]);
    const next = [entry('home/a', 'k1'), entry('home/b', 'k2')];
    expect(newBlobKeys(prev, next)).toEqual(new Set());
  });

  it('one-changed: only the changed entry’s hmacKey is new', () => {
    const prev = manifest([entry('home/a', 'k1'), entry('home/b', 'k2')]);
    const next = [entry('home/a', 'k1'), entry('home/b', 'k2-changed')];
    expect(newBlobKeys(prev, next)).toEqual(new Set(['k2-changed']));
  });

  it('a new entry sharing an existing hmacKey (identical content elsewhere) is not new', () => {
    const prev = manifest([entry('home/a', 'k1')]);
    const next = [entry('home/a', 'k1'), entry('home/a-copy', 'k1')];
    expect(newBlobKeys(prev, next)).toEqual(new Set());
  });
});
