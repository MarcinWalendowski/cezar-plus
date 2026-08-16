/**
 * The per-run manifest (Data Models, spec `.ai/specs/2026-08-16-provider-agnostic-platform-backup.md`):
 * the plaintext shape encrypted into `snapshots/<ts>.manifest.enc`, and what `newBlobKeys` diffs
 * two runs against to make backup incremental (git's model, without git — Architecture §2).
 *
 * `entries` carries one row per included file, keyed by `hmacKey` — the content-addressed
 * `blobs/<hmacKey>` remote key (`../backup/crypto.ts#storageKey`). Two entries with identical
 * file content share an `hmacKey`; the engine uploads that blob once, not once per entry.
 */

export interface ManifestEntry {
  /** Scope-prefixed logical restore path (`walk.ts#IncludeSetEntry.logicalPath`). */
  path: string;
  /** Hex SHA-256 of the plaintext (`crypto.ts#sha256Hex`) — the content hash, never used as a
   *  remote key directly. */
  sha256: string;
  /** Plaintext size in bytes. */
  size: number;
  /** The remote blob key: `crypto.ts#storageKey(masterKey, sha256)`. */
  hmacKey: string;
}

export interface ManifestRun {
  /** Count of new, distinct blobs this run uploaded. */
  uploaded: number;
  /** Count of entries whose blob content was already present (in the prior manifest, or
   *  deduped against another entry in the same run). */
  skipped: number;
  /** Total ciphertext bytes uploaded this run (blobs only). */
  bytes: number;
}

export interface Manifest {
  schemaVersion: 1;
  /** Stored ISO timestamp (D8) — never recomputed at read time. */
  createdAt: string;
  run: ManifestRun;
  entries: ManifestEntry[];
}

/** JSON-serializes a manifest to the bytes handed to `crypto.ts#encrypt`. */
export function serializeManifest(manifest: Manifest): Buffer {
  return Buffer.from(JSON.stringify(manifest), 'utf8');
}

/** Reverses `serializeManifest`. Throws on anything that isn't a well-formed manifest shape —
 *  callers (the engine) treat that as "no usable prior manifest", the same as a missing one. */
export function parseManifest(bytes: Uint8Array): Manifest {
  const text = (Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)).toString('utf8');
  const parsed = JSON.parse(text) as Partial<Manifest> | null;
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof parsed.createdAt !== 'string' ||
    !Array.isArray(parsed.entries) ||
    !parsed.run
  ) {
    throw new Error('malformed backup manifest');
  }
  return parsed as Manifest;
}

/**
 * The `hmacKey`s present in `nextEntries` but absent from `prev` — exactly the blobs this run
 * must upload (`prev: null` ⇒ every distinct blob in `nextEntries` is new, i.e. a first run).
 * Two `nextEntries` sharing an `hmacKey` (identical content at two paths) contribute one key, not
 * two — the engine's dedup within a single run falls out of this being a `Set`.
 */
export function newBlobKeys(prev: Manifest | null, nextEntries: readonly ManifestEntry[]): Set<string> {
  const prevKeys = new Set(prev?.entries.map((entry) => entry.hmacKey) ?? []);
  const result = new Set<string>();
  for (const entry of nextEntries) {
    if (!prevKeys.has(entry.hmacKey)) result.add(entry.hmacKey);
  }
  return result;
}
