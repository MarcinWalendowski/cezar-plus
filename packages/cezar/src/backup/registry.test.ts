import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BACKUP_PROVIDERS, resolveBackupProvider } from './registry.ts';
import type { BackupProviderConfig } from './provider-types.ts';

describe('resolveBackupProvider', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-backup-registry-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('registers `local` in BACKUP_PROVIDERS', () => {
    expect(BACKUP_PROVIDERS.local).toBeTypeOf('function');
  });

  it('resolves a `local` config to a working provider', async () => {
    const config: BackupProviderConfig = { kind: 'local', path: dir };
    const provider = resolveBackupProvider(config);

    expect(provider).not.toBeNull();
    expect(provider?.kind).toBe('local');

    await provider?.put('probe.txt', new TextEncoder().encode('hello'));
    const bytes = await provider?.get('probe.txt');
    expect(bytes && new TextDecoder().decode(bytes)).toBe('hello');
  });

  it('returns null for an unknown kind, never throws', () => {
    const config = { kind: 'nope' } as unknown as BackupProviderConfig;
    expect(resolveBackupProvider(config)).toBeNull();
  });
});
