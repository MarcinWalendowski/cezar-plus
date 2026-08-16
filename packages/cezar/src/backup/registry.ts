import { createLocalBackupProvider } from './providers/local.ts';
import { createS3BackupProvider } from './providers/s3.ts';
import type { BackupProvider, BackupProviderConfig, BackupProviderFactory } from './provider-types.ts';

/**
 * `BACKUP_PROVIDERS` + `resolveBackupProvider` (Phase 2, `s3` added Phase 3) — mirrors
 * `SOURCE_PROVIDERS` / `resolveSourceProvider` (`../sources/registry.ts`). A second provider was
 * one new file plus one row below, with no change to this file's shape or to `provider-types.ts` —
 * exactly the seam the module doc promised.
 *
 * Unlike `SourceConnection`, `BackupProviderConfig` is a real discriminated union
 * (`S3ProviderConfig | LocalProviderConfig`), so each row narrows its own `config.kind` before
 * delegating to its factory rather than casting — `resolveBackupProvider` only ever calls the row
 * whose key equals `config.kind`, so the narrowing check inside a row is a defensive assertion,
 * never a real branch.
 */

export const BACKUP_PROVIDERS: Record<string, BackupProviderFactory> = {
  local: (config) => {
    if (config.kind !== 'local') {
      throw new Error(`local backup provider factory received a non-local config (kind="${config.kind}")`);
    }
    return createLocalBackupProvider(config);
  },
  s3: (config) => {
    if (config.kind !== 's3') {
      throw new Error(`s3 backup provider factory received a non-s3 config (kind="${config.kind}")`);
    }
    return createS3BackupProvider(config);
  },
};

/**
 * Looks `config.kind` up in `BACKUP_PROVIDERS` and constructs a bound provider. Returns `null` for
 * an unknown kind — never throws — mirroring `resolveSourceProvider`: a stale or mistyped `kind` in
 * `backup.json` degrades to "no provider available" rather than crashing the caller.
 */
export function resolveBackupProvider(config: BackupProviderConfig): BackupProvider | null {
  const factory = BACKUP_PROVIDERS[config.kind];
  if (!factory) return null;
  return factory(config);
}
