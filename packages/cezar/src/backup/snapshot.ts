import { closeSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  BackupIncludeSummary,
  BackupOverviewResponse,
  BackupProviderSummary,
  BackupRunSummary,
  BackupSnapshot,
  BackupVerifyResponse,
} from '@loki-labs/better-cezar-contract';
import { cezarHomeDir } from '../paths.ts';
import {
  SCRYPT_PARAMS,
  decrypt,
  deriveMasterKey,
  encrypt,
  generateSalt,
  makeKeyCheckToken,
  sha256Hex,
  storageKey as computeStorageKey,
  verifyKeyCheckToken,
} from './crypto.ts';
import { loadBackupConfig, resolveEncryptionKey, resolveProviderConfig, type BackupConfig } from './config.ts';
import {
  newBlobKeys,
  parseManifest,
  serializeManifest,
  type Manifest,
  type ManifestEntry,
} from './manifest.ts';
import { resolveBackupProvider } from './registry.ts';
import type { BackupProvider } from './provider-types.ts';
import { collectIncludeSet } from './walk.ts';

/**
 * The snapshot engine (Architecture §2, spec `.ai/specs/2026-08-16-provider-agnostic-platform-backup.md`):
 * `runBackup` (the incremental core), `runGc` (unreferenced-blob pruning) and `getBackupStatus`
 * (the cockpit overview) — built entirely on the fixed `config.ts` / `crypto.ts` / `registry.ts` /
 * `walk.ts` / `manifest.ts` modules. Every remote read/write goes through a resolved
 * `BackupProvider`; every byte handed to it is ciphertext (N4).
 */

export interface BackupEngineDeps {
  /** Injected so tests never touch the real project registry — production callers pass
   *  `../workspace/projects.ts#listProjects`. Only `id`/`root` are read. */
  listProjects: () => Promise<ReadonlyArray<{ id: string; root: string }>>;
  /** Injectable clock for deterministic `createdAt` / snapshot ids in tests. */
  now?: () => Date;
}

export interface RunBackupResult {
  snapshotId: string;
  uploaded: number;
  skipped: number;
  bytes: number;
}

export interface RunGcResult {
  prunedBlobs: number;
  freedBytes: number;
}

const LEASE_FILENAME = 'backup.lock';
const KEYDERIV_KEY = 'keyderiv';
const KEYCHECK_KEY = 'keycheck';
const LATEST_KEY = 'latest';
const SNAPSHOTS_PREFIX = 'snapshots/';
const BLOBS_PREFIX = 'blobs/';

interface KeyDeriv {
  salt: string; // base64
  N: number;
  r: number;
  p: number;
}

interface LatestPointer {
  manifestKey: string;
}

/** `<ts>` — an ISO timestamp made filename-safe and still lexically sortable. */
function toSnapshotId(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

function manifestKeyFor(snapshotId: string): string {
  return `${SNAPSHOTS_PREFIX}${snapshotId}.manifest.enc`;
}

function snapshotIdFromManifestKey(manifestKey: string): string | null {
  const match = /^snapshots\/(.+)\.manifest\.enc$/.exec(manifestKey);
  return match ? match[1]! : null;
}

/**
 * Acquires the single-run `O_EXCL` lease (the `automations/store.ts#acquireLease` idiom, no
 * staleness reclaim here — a held lease just means "a backup is already running", and a scheduled
 * tick no-ops on it per the spec). Returns `undefined` when the lease is already held.
 */
function acquireBackupLease(homeDir: string, now: () => Date): { release(): void } | undefined {
  mkdirSync(homeDir, { recursive: true });
  const path = join(homeDir, LEASE_FILENAME);
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch {
    return undefined;
  }
  writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: now().toISOString() }));
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      closeSync(fd);
      try {
        unlinkSync(path);
      } catch {
        // Already removed.
      }
    },
  };
}

/** Resolves the configured provider + passphrase, or throws a clear "not configured" error. */
function requireProviderAndPassphrase(config: BackupConfig): { provider: BackupProvider; passphrase: string } {
  const providerConfig = resolveProviderConfig(config);
  const provider = providerConfig ? resolveBackupProvider(providerConfig) : null;
  if (!provider) {
    throw new Error('backup is not configured: no usable provider (check `~/.cezar/backup.json` and its secrets)');
  }
  const passphrase = resolveEncryptionKey(config);
  if (!passphrase) {
    throw new Error('backup is not configured: no encryption key (set the configured `encryption.keyEnv`/`keyFile`)');
  }
  return { provider, passphrase };
}

/**
 * Loads (or, on first run, creates) the persisted scrypt salt and derives the master key from it.
 * `keyderiv` is plaintext — the salt is not secret, only the passphrase is (Data Models).
 */
async function resolveMasterKey(provider: BackupProvider, passphrase: string): Promise<Buffer> {
  const existing = await provider.get(KEYDERIV_KEY);
  let salt: Buffer;
  if (existing) {
    const parsed = JSON.parse(Buffer.from(existing).toString('utf8')) as KeyDeriv;
    salt = Buffer.from(parsed.salt, 'base64');
  } else {
    salt = generateSalt();
    const record: KeyDeriv = { salt: salt.toString('base64'), N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p };
    await provider.put(KEYDERIV_KEY, Buffer.from(JSON.stringify(record), 'utf8'));
  }
  return deriveMasterKey(passphrase, salt);
}

/** Same as `resolveMasterKey`, but never writes and returns `null` instead of creating a salt —
 *  for read-only paths (`getBackupStatus`) that must not provision key material as a side effect
 *  of a GET. */
async function resolveMasterKeyReadOnly(provider: BackupProvider, passphrase: string): Promise<Buffer | null> {
  const existing = await provider.get(KEYDERIV_KEY);
  if (!existing) return null;
  const parsed = JSON.parse(Buffer.from(existing).toString('utf8')) as KeyDeriv;
  return deriveMasterKey(passphrase, Buffer.from(parsed.salt, 'base64'));
}

/** Verifies (or, if absent, provisions) the key-check token. Throws on a wrong/lost key — a
 *  mismatch must abort before anything else is written (Risk: "key loss = unrecoverable backup"). */
async function verifyOrProvisionKeyCheck(provider: BackupProvider, masterKey: Buffer): Promise<void> {
  const existing = await provider.get(KEYCHECK_KEY);
  if (existing) {
    if (!verifyKeyCheckToken(masterKey, existing)) {
      throw new Error('backup key mismatch: the configured passphrase does not match this backup’s stored key-check token');
    }
    return;
  }
  await provider.put(KEYCHECK_KEY, makeKeyCheckToken(masterKey));
}

/** Fetches and decrypts the manifest `latest` currently points at, or `null` when there is none
 *  yet, or when it cannot be read/decrypted (degrades to "treat as a first run" rather than
 *  throwing — matches the tolerant-degrade convention `config.ts` uses for a corrupt config). */
async function fetchLatestManifest(
  provider: BackupProvider,
  masterKey: Buffer,
): Promise<{ manifest: Manifest; manifestKey: string } | null> {
  try {
    const latestBytes = await provider.get(LATEST_KEY);
    if (!latestBytes) return null;
    const pointer = JSON.parse(decrypt(masterKey, latestBytes).toString('utf8')) as LatestPointer;
    const manifestBytes = await provider.get(pointer.manifestKey);
    if (!manifestBytes) return null;
    const manifest = parseManifest(decrypt(masterKey, manifestBytes));
    return { manifest, manifestKey: pointer.manifestKey };
  } catch {
    return null;
  }
}

/**
 * The incremental core (Architecture §2). Acquires the single-run lease, resolves the provider +
 * key, walks the include set, uploads only new/changed blobs (content-addressed dedup, both
 * against the prior manifest and within this run), and commits by writing the new manifest and
 * `latest` pointer LAST. A no-change run uploads zero blobs (N2).
 */
export async function runBackup(deps: BackupEngineDeps): Promise<RunBackupResult> {
  const now = deps.now ?? (() => new Date());
  const homeDir = cezarHomeDir();
  const lease = acquireBackupLease(homeDir, now);
  if (!lease) {
    throw new Error('a backup is already running');
  }
  try {
    const config = await loadBackupConfig();
    const { provider, passphrase } = requireProviderAndPassphrase(config);
    const masterKey = await resolveMasterKey(provider, passphrase);
    await verifyOrProvisionKeyCheck(provider, masterKey);

    const walked = await collectIncludeSet({
      homeDir,
      listProjects: deps.listProjects,
      extraIncludes: config.include,
    });

    const bytesByHmacKey = new Map<string, Buffer>();
    const nextEntries: ManifestEntry[] = [];
    for (const file of walked) {
      let bytes: Buffer;
      try {
        bytes = await readFile(file.absPath);
      } catch {
        continue; // vanished between walk and read (a writer's tmp+rename raced us) — skip it
      }
      const sha256 = sha256Hex(bytes);
      const hmacKey = computeStorageKey(masterKey, sha256);
      nextEntries.push({ path: file.logicalPath, sha256, size: bytes.length, hmacKey });
      if (!bytesByHmacKey.has(hmacKey)) bytesByHmacKey.set(hmacKey, bytes);
    }

    const prior = await fetchLatestManifest(provider, masterKey);
    const newKeys = newBlobKeys(prior?.manifest ?? null, nextEntries);

    let uploadedBytes = 0;
    for (const key of newKeys) {
      const plaintext = bytesByHmacKey.get(key);
      if (!plaintext) continue; // unreachable: every key in newKeys came from nextEntries above
      const ciphertext = encrypt(masterKey, plaintext);
      await provider.put(`${BLOBS_PREFIX}${key}`, ciphertext);
      uploadedBytes += ciphertext.length;
    }

    const uploaded = newKeys.size;
    const skipped = nextEntries.length - uploaded;
    const createdAt = now().toISOString();
    const snapshotId = toSnapshotId(now());
    const manifest: Manifest = {
      schemaVersion: 1,
      createdAt,
      run: { uploaded, skipped, bytes: uploadedBytes },
      entries: nextEntries,
    };
    const manifestKey = manifestKeyFor(snapshotId);
    await provider.put(manifestKey, encrypt(masterKey, serializeManifest(manifest)));
    const pointer: LatestPointer = { manifestKey };
    await provider.put(LATEST_KEY, encrypt(masterKey, Buffer.from(JSON.stringify(pointer), 'utf8')));

    return { snapshotId, uploaded, skipped, bytes: uploadedBytes };
  } finally {
    lease.release();
  }
}

/**
 * Prunes snapshots beyond `keepSnapshots` and every blob no surviving snapshot references
 * (Architecture §2). Verifies the key-check token before deleting anything: under a wrong key
 * every surviving manifest would fail to decrypt, which would make every blob look unreferenced —
 * `runGc` refuses rather than risk that (the same "a wrong key must never write" discipline
 * extended to "must never delete").
 */
export async function runGc(deps: Pick<BackupEngineDeps, 'now'>): Promise<RunGcResult> {
  const config = await loadBackupConfig();
  const { provider, passphrase } = requireProviderAndPassphrase(config);
  const masterKey = await resolveMasterKeyReadOnly(provider, passphrase);
  if (!masterKey) {
    return { prunedBlobs: 0, freedBytes: 0 }; // nothing has ever been backed up — nothing to gc
  }
  const keycheck = await provider.get(KEYCHECK_KEY);
  if (keycheck && !verifyKeyCheckToken(masterKey, keycheck)) {
    throw new Error('backup key mismatch: refusing to gc under a passphrase that does not match this backup');
  }

  const snapshotKeys = (await provider.list(SNAPSHOTS_PREFIX)).sort();
  const keep = Math.max(0, config.keepSnapshots);
  const toDelete = snapshotKeys.slice(0, Math.max(0, snapshotKeys.length - keep));
  const surviving = snapshotKeys.slice(snapshotKeys.length - keep);

  for (const key of toDelete) {
    await provider.delete(key);
  }

  const referenced = new Set<string>();
  for (const key of surviving) {
    const bytes = await provider.get(key);
    if (!bytes) continue;
    let manifest: Manifest;
    try {
      manifest = parseManifest(decrypt(masterKey, bytes));
    } catch {
      // A surviving manifest that won't decrypt under a verified key should never happen; refuse
      // to gc rather than compute a reference set that could be missing this manifest's blobs.
      throw new Error(`backup gc: could not read surviving manifest ${key} — refusing to prune blobs`);
    }
    for (const entry of manifest.entries) referenced.add(entry.hmacKey);
  }

  const blobKeys = await provider.list(BLOBS_PREFIX);
  let prunedBlobs = 0;
  let freedBytes = 0;
  for (const key of blobKeys) {
    const hmacKey = key.slice(BLOBS_PREFIX.length);
    if (referenced.has(hmacKey)) continue;
    const head = await provider.head(key);
    await provider.delete(key);
    prunedBlobs++;
    freedBytes += head?.size ?? 0;
  }

  return { prunedBlobs, freedBytes };
}

/**
 * The cockpit overview (`GET /api/v1/backup`). Must never throw — an unconfigured or
 * partially-configured backup degrades field-by-field rather than failing the request. `provider`
 * reflects `backup.json`'s own settings (no secrets needed to display kind/label); `lastRun` and
 * `snapshotCount` need a resolvable provider + key and fall back to `null`/`0` without one;
 * `includeSummary` is a local-only walk and is attempted regardless of provider configuration.
 */
export async function getBackupStatus(deps: BackupEngineDeps): Promise<BackupOverviewResponse> {
  const config = await loadBackupConfig();

  const providerSummary = summarizeProvider(config);

  let lastRun: BackupRunSummary | null = null;
  let snapshotCount = 0;
  try {
    const providerConfig = resolveProviderConfig(config);
    const provider = providerConfig ? resolveBackupProvider(providerConfig) : null;
    const passphrase = resolveEncryptionKey(config);
    if (provider && passphrase) {
      snapshotCount = (await provider.list(SNAPSHOTS_PREFIX)).length;
      const masterKey = await resolveMasterKeyReadOnly(provider, passphrase);
      if (masterKey) {
        const prior = await fetchLatestManifest(provider, masterKey);
        if (prior) {
          const snapshotId = snapshotIdFromManifestKey(prior.manifestKey) ?? prior.manifestKey;
          lastRun = {
            snapshotId,
            createdAt: prior.manifest.createdAt,
            uploaded: prior.manifest.run.uploaded,
            skipped: prior.manifest.run.skipped,
            bytes: prior.manifest.run.bytes,
          };
        }
      }
    }
  } catch {
    lastRun = null;
    snapshotCount = 0;
  }

  let includeSummary: BackupIncludeSummary | null = null;
  try {
    const walked = await collectIncludeSet({
      homeDir: cezarHomeDir(),
      listProjects: deps.listProjects,
      extraIncludes: config.include,
    });
    const homeFiles = walked.filter((entry) => entry.logicalPath.startsWith('home/')).length;
    const projectIds = new Set(
      walked
        .filter((entry) => entry.logicalPath.startsWith('project/'))
        .map((entry) => entry.logicalPath.split('/')[1]),
    );
    includeSummary = { homeFiles, projectCount: projectIds.size };
  } catch {
    includeSummary = null;
  }

  return {
    enabled: config.enabled,
    provider: providerSummary,
    lastRun,
    snapshotCount,
    includeSummary,
  };
}

function summarizeProvider(config: BackupConfig): BackupProviderSummary | null {
  const p = config.provider;
  if (!p) return null;
  if (p.kind === 'local') return { kind: 'local', label: p.path || '(unset path)' };
  return { kind: 's3', label: p.endpoint && p.bucket ? `${p.endpoint} / ${p.bucket}` : '(unset endpoint/bucket)' };
}

/** Remote key for the throwaway object `verifyBackup` writes and immediately deletes. */
const VERIFY_PROBE_KEY = 'verify-probe';

/**
 * `GET /api/v1/backup/snapshots` — every stored snapshot, newest first. Each snapshot's summary
 * comes entirely from its **stored** manifest (D8: `createdAt` is the manifest's own timestamp, the
 * counts are read from its entries — nothing is computed from the clock at request time). Needs a
 * resolvable provider + key to decrypt the manifests; degrades to `[]` (never throws) without one,
 * and skips an individual manifest that will not decrypt rather than failing the whole listing.
 *
 * `sizeBytes` is the snapshot's logical corpus size (the sum of its files' plaintext sizes);
 * `blobCount` is the number of distinct content blobs it references (deduped by `hmacKey`).
 */
export async function listSnapshots(): Promise<BackupSnapshot[]> {
  const config = await loadBackupConfig();
  const providerConfig = resolveProviderConfig(config);
  const provider = providerConfig ? resolveBackupProvider(providerConfig) : null;
  const passphrase = resolveEncryptionKey(config);
  if (!provider || !passphrase) return [];
  const masterKey = await resolveMasterKeyReadOnly(provider, passphrase);
  if (!masterKey) return [];

  const snapshots: BackupSnapshot[] = [];
  for (const key of await provider.list(SNAPSHOTS_PREFIX)) {
    const id = snapshotIdFromManifestKey(key);
    if (!id) continue;
    const bytes = await provider.get(key);
    if (!bytes) continue;
    let manifest: Manifest;
    try {
      manifest = parseManifest(decrypt(masterKey, bytes));
    } catch {
      continue; // an unreadable manifest is skipped, not fatal to the listing
    }
    const sizeBytes = manifest.entries.reduce((sum, entry) => sum + entry.size, 0);
    const blobCount = new Set(manifest.entries.map((entry) => entry.hmacKey)).size;
    snapshots.push({ id, createdAt: manifest.createdAt, sizeBytes, blobCount });
  }
  // Newest first — `id` is a lexically-sortable ISO-derived string.
  snapshots.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return snapshots;
}

/**
 * `POST /api/v1/backup/verify` — the pre-restore safety check (Architecture §3, "Key loss ⇒ no
 * restore"). Answers three independent questions without touching the corpus:
 *  - `providerOk`: the store is reachable (a `list` succeeds).
 *  - `keyOk`: the configured passphrase matches this backup's stored key-check token. When nothing
 *    has been backed up yet (no `keycheck`), a usable passphrase is reported `true` — there is no
 *    token to contradict it.
 *  - `sampleRoundTrip`: a throwaway object encrypts → `put` → `get` → decrypts back to the same
 *    bytes, then is deleted — proving the crypto + provider pipe end to end.
 * Never throws; any failure degrades the relevant flag to `false`.
 */
export async function verifyBackup(): Promise<BackupVerifyResponse> {
  const config = await loadBackupConfig();
  const providerConfig = resolveProviderConfig(config);
  const provider = providerConfig ? resolveBackupProvider(providerConfig) : null;
  const passphrase = resolveEncryptionKey(config);
  if (!provider || !passphrase) return { keyOk: false, providerOk: false, sampleRoundTrip: false };

  let providerOk = false;
  try {
    await provider.list(SNAPSHOTS_PREFIX);
    providerOk = true;
  } catch {
    return { keyOk: false, providerOk: false, sampleRoundTrip: false };
  }

  let keyOk = false;
  let masterKey: Buffer | null = null;
  try {
    masterKey = await resolveMasterKeyReadOnly(provider, passphrase);
    if (!masterKey) {
      // No `keyderiv` yet: derive a throwaway key so the round-trip below can still exercise the
      // pipe, and report the (uncontradicted) passphrase as usable.
      masterKey = deriveMasterKey(passphrase, generateSalt());
      keyOk = true;
    } else {
      const keycheck = await provider.get(KEYCHECK_KEY);
      keyOk = keycheck ? verifyKeyCheckToken(masterKey, keycheck) : true;
    }
  } catch {
    keyOk = false;
  }

  let sampleRoundTrip = false;
  if (masterKey) {
    const marker = Buffer.from(`verify-${process.pid}`, 'utf8');
    try {
      await provider.put(VERIFY_PROBE_KEY, encrypt(masterKey, marker));
      const got = await provider.get(VERIFY_PROBE_KEY);
      sampleRoundTrip = !!got && decrypt(masterKey, got).equals(marker);
    } catch {
      sampleRoundTrip = false;
    } finally {
      try {
        await provider.delete(VERIFY_PROBE_KEY);
      } catch {
        // best-effort cleanup — a leftover probe is overwritten on the next verify
      }
    }
  }

  return { keyOk, providerOk, sampleRoundTrip };
}
