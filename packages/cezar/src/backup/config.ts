import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { backupConfigPath } from '../paths.ts';
import { atomicWriteJsonSync } from '../workspace/config.ts';
import type { BackupProviderConfig } from './provider-types.ts';

/**
 * `~/.cezar/backup.json` — the backup subsystem's own tolerant, additive config (spec
 * `.ai/specs/2026-08-16-provider-agnostic-platform-backup.md`, Data Models). Its own file (not a key
 * in `config.json`), on the `notifications/config.ts` precedent: a cezar that never heard of backup
 * does not open it, so it cannot drop it. Every field `.default().catch()` degrades per-key, every
 * object is `.passthrough()` so a newer cezar's keys survive, and load never throws.
 *
 * **No secret is ever stored here.** The S3 access key/secret and the encryption passphrase live in
 * env; this file names the env VARS (`accessKeyEnv`/`secretKeyEnv`/`keyEnv`) — the
 * `notifications/secrets.ts` discipline. `resolveProviderConfig`/`resolveEncryptionKey` below read
 * `process.env` at use time and return `null` when a named var is unset (unresolvable is not an
 * error — the caller reports "not configured", it does not crash).
 */

const s3ProviderSchema = z
  .object({
    kind: z.literal('s3'),
    endpoint: z.string().default('').catch(''),
    bucket: z.string().default('').catch(''),
    region: z.string().default('auto').catch('auto'),
    prefix: z.string().default('cezar/').catch('cezar/'),
    accessKeyEnv: z.string().default('CEZ_BACKUP_S3_KEY').catch('CEZ_BACKUP_S3_KEY'),
    secretKeyEnv: z.string().default('CEZ_BACKUP_S3_SECRET').catch('CEZ_BACKUP_S3_SECRET'),
  })
  .passthrough();

const localProviderSchema = z
  .object({
    kind: z.literal('local'),
    path: z.string().default('').catch(''),
  })
  .passthrough();

/** A discriminated provider, salvaged per-kind: an unrecognised/broken provider block degrades the
 *  whole config to "no provider configured" (the run reports it) rather than throwing. */
const providerSchema = z.discriminatedUnion('kind', [s3ProviderSchema, localProviderSchema]);
export type BackupProviderSettings = z.infer<typeof providerSchema>;

const encryptionSchema = z
  .object({
    /** Name of the env var holding the passphrase. */
    keyEnv: z.string().default('CEZ_BACKUP_KEY').catch('CEZ_BACKUP_KEY'),
    /** Or an absolute path to a keyfile (takes precedence over `keyEnv` when present). */
    keyFile: z.string().optional().catch(undefined),
  })
  .passthrough();

const backupConfigSchema = z
  .object({
    schemaVersion: z.number().int().min(0).default(1).catch(1),
    enabled: z.boolean().default(false).catch(false),
    intervalMinutes: z.number().int().min(1).max(24 * 60).default(15).catch(15),
    keepSnapshots: z.number().int().min(1).max(10_000).default(30).catch(30),
    /** Absent/broken provider ⇒ `undefined`: "not configured yet", reported by `GET /backup`. */
    provider: providerSchema.optional().catch(undefined),
    encryption: encryptionSchema.prefault(() => ({})).catch(() => encryptionSchema.parse({})),
    /** Extra ABSOLUTE include paths beyond the standard corpus (e.g. a custom knowledge mount). */
    include: z.array(z.string()).default(() => []).catch(() => []),
  })
  .passthrough();
export type BackupConfig = z.infer<typeof backupConfigSchema>;

/** The zero-config default — what a missing file behaves like (`enabled:false`, no provider). */
export function defaultBackupConfig(): BackupConfig {
  return backupConfigSchema.parse({});
}

async function loadBackupConfigFrom(path: string): Promise<BackupConfig> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return defaultBackupConfig(); // missing — the zero-config default, silently
  }
  try {
    const parsed = backupConfigSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // malformed JSON — fall through to the warning + defaults
  }
  console.warn(`[cez] backup config ${path} is corrupt — ignoring it (backup stays off until it is fixed)`);
  return defaultBackupConfig();
}

/** Read on demand — never cached, never throws. A read-only home degrades to the default. */
export async function loadBackupConfig(): Promise<BackupConfig> {
  return loadBackupConfigFrom(backupConfigPath());
}

/** Read-modify-write merge: re-read, apply `mutator`, atomic-rename write. Path resolved ONCE. */
export async function mergeWriteBackupConfig(
  mutator: (config: BackupConfig) => BackupConfig | void,
): Promise<BackupConfig> {
  const path = backupConfigPath();
  const current = await loadBackupConfigFrom(path);
  const next = mutator(current) ?? current;
  atomicWriteJsonSync(path, next);
  return next;
}

/**
 * Resolve the provider settings into a `BackupProviderConfig` with secrets read from env, or `null`
 * when the provider is absent or a required secret/field is unset. Never throws, never persists a
 * secret.
 */
export function resolveProviderConfig(
  config: BackupConfig,
  env: NodeJS.ProcessEnv = process.env,
): BackupProviderConfig | null {
  const p = config.provider;
  if (!p) return null;
  if (p.kind === 'local') {
    if (!p.path) return null;
    return { kind: 'local', path: p.path };
  }
  const accessKeyId = env[p.accessKeyEnv]?.trim();
  const secretAccessKey = env[p.secretKeyEnv]?.trim();
  if (!p.endpoint || !p.bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    kind: 's3',
    endpoint: p.endpoint,
    bucket: p.bucket,
    region: p.region,
    prefix: p.prefix,
    accessKeyId,
    secretAccessKey,
  };
}

/**
 * Resolve the encryption passphrase from a keyfile (if named and readable) or the named env var, or
 * `null` when neither yields a value. The passphrase itself is never stored in the config file.
 */
export function resolveEncryptionKey(
  config: BackupConfig,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const { keyFile, keyEnv } = config.encryption;
  if (keyFile) {
    try {
      const fromFile = readFileSync(keyFile, 'utf8').trim();
      if (fromFile) return fromFile;
    } catch {
      // unreadable keyfile — fall through to the env var
    }
  }
  const fromEnv = env[keyEnv]?.trim();
  return fromEnv || null;
}
