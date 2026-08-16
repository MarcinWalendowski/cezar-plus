import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalBackupProvider } from './local.ts';
import type { BackupProvider, LocalProviderConfig } from '../provider-types.ts';

describe('createLocalBackupProvider', () => {
  let dir: string;
  let provider: BackupProvider;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-backup-local-'));
    const config: LocalProviderConfig = { kind: 'local', path: dir };
    provider = createLocalBackupProvider(config);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips exact bytes through put/get', async () => {
    const bytes = new Uint8Array([0, 1, 2, 255, 254, 10, 13]);
    await provider.put('object.bin', bytes);
    const back = await provider.get('object.bin');
    expect(back).not.toBeNull();
    expect(Array.from(back ?? [])).toEqual(Array.from(bytes));
  });

  it('supports a nested key, creating intermediate directories', async () => {
    const bytes = new TextEncoder().encode('nested content');
    await provider.put('blobs/ab/cd', bytes);
    const back = await provider.get('blobs/ab/cd');
    expect(back && new TextDecoder().decode(back)).toBe('nested content');
  });

  it('get of a missing key returns null, never throws', async () => {
    await expect(provider.get('missing.bin')).resolves.toBeNull();
  });

  it('head of a missing key returns null, never throws', async () => {
    await expect(provider.head('missing.bin')).resolves.toBeNull();
  });

  it('head reports the stored size for an existing key', async () => {
    const bytes = new TextEncoder().encode('twelve bytes');
    await provider.put('sized.bin', bytes);
    await expect(provider.head('sized.bin')).resolves.toEqual({ size: bytes.byteLength });
  });

  it('delete is idempotent — deleting a missing key does not throw', async () => {
    await expect(provider.delete('never-existed.bin')).resolves.toBeUndefined();
  });

  it('delete removes an existing key', async () => {
    await provider.put('to-remove.bin', new Uint8Array([1]));
    await provider.delete('to-remove.bin');
    await expect(provider.get('to-remove.bin')).resolves.toBeNull();
  });

  it('overwrite via put replaces the bytes', async () => {
    await provider.put('overwrite.bin', new TextEncoder().encode('first'));
    await provider.put('overwrite.bin', new TextEncoder().encode('second'));
    const back = await provider.get('overwrite.bin');
    expect(back && new TextDecoder().decode(back)).toBe('second');
  });

  it('put leaves no tmp sibling behind', async () => {
    await provider.put('clean.bin', new Uint8Array([9]));
    const keys = await provider.list('');
    expect(keys).toContain('clean.bin');
    expect(keys.some((key) => key.includes('.tmp-'))).toBe(false);
  });

  it('list(prefix) returns only keys under the prefix, as provider-relative POSIX paths', async () => {
    await provider.put('blobs/ab/cd', new Uint8Array([1]));
    await provider.put('blobs/ef/gh', new Uint8Array([2]));
    await provider.put('snapshots/latest.manifest.enc', new Uint8Array([3]));

    const blobKeys = await provider.list('blobs');
    expect([...blobKeys].sort()).toEqual(['blobs/ab/cd', 'blobs/ef/gh']);

    const snapshotKeys = await provider.list('snapshots');
    expect(snapshotKeys).toEqual(['snapshots/latest.manifest.enc']);
  });

  it('list returns [] when the prefix directory is absent', async () => {
    await expect(provider.list('does-not-exist')).resolves.toEqual([]);
  });
});
