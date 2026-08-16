/**
 * The backup provider seam — a tiny, byte-oriented object store the snapshot engine ships
 * ciphertext to (spec `.ai/specs/2026-08-16-provider-agnostic-platform-backup.md`). It mirrors the
 * `SourceProvider` registry (`../sources/provider-types.ts`) and the notification-transport
 * registry: `kind` is a **plain string, never a literal union**, so a second provider is one new
 * file plus one registry row, with no type change here.
 *
 * The engine only ever hands the provider **ciphertext** and opaque keys — the provider knows
 * nothing about encryption, manifests, or blobs. That is what keeps zero-knowledge a property of
 * the engine and not of any one backend.
 *
 * Two implementations: `providers/s3.ts` (S3-compatible: R2/S3/B2/MinIO, SigV4 via `node:crypto`)
 * and `providers/local.ts` (a filesystem path, atomic tmp+rename). No new runtime dependency — all
 * of it is `node:crypto` + native `fetch` (D7).
 */

/**
 * The store contract. All keys are provider-relative (the configured `prefix` is applied by the
 * engine before it calls these, so a provider stores exactly the key it is given). `bytes` are
 * always ciphertext. Reads answer `null` for a missing key rather than throwing — "not there" is a
 * normal answer the engine branches on (a first-ever run, a gc'd blob). `delete` is idempotent.
 */
export interface BackupProvider {
  /** Provider discriminator, e.g. `'s3'` or `'local'`. A plain string by design. */
  readonly kind: string;
  /** Store `bytes` at `key`, overwriting any existing object. Atomic where the backend allows it. */
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** Fetch the object at `key`, or `null` if it does not exist. */
  get(key: string): Promise<Uint8Array | null>;
  /** Cheap existence + size probe, or `null` if `key` does not exist. */
  head(key: string): Promise<BackupObjectHead | null>;
  /** Every key under `prefix` (provider-relative). Order is unspecified. */
  list(prefix: string): Promise<string[]>;
  /** Remove `key`. A no-op (not an error) when it does not exist. */
  delete(key: string): Promise<void>;
}

/** What `head` reports for an existing object. */
export interface BackupObjectHead {
  /** Object size in bytes (the stored ciphertext length). */
  size: number;
}

/** Resolved S3-compatible provider settings. The access key + secret are resolved from env by the
 *  engine (never stored in the config file) and handed in here already resolved. */
export interface S3ProviderConfig {
  kind: 's3';
  endpoint: string;
  bucket: string;
  region: string;
  /** Key prefix already includes any trailing slash normalization the engine wants. */
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** Resolved local-path provider settings. */
export interface LocalProviderConfig {
  kind: 'local';
  /** Absolute directory the objects are written under (created if missing). */
  path: string;
}

export type BackupProviderConfig = S3ProviderConfig | LocalProviderConfig;

/** A provider factory: `(resolvedConfig) => BackupProvider`. One per `kind` in the registry. */
export type BackupProviderFactory = (config: BackupProviderConfig) => BackupProvider;
