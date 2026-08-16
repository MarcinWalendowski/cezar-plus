import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Client-side, zero-knowledge crypto for the backup subsystem (Architecture §3 "Encryption",
 * spec `.ai/specs/2026-08-16-provider-agnostic-platform-backup.md`). `node:crypto` only — no new
 * runtime dependency (D7). Every byte the snapshot engine ever hands a `BackupProvider`
 * (`./provider-types.ts`) is ciphertext produced here; the provider — and anyone who compromises
 * it — sees only that.
 *
 * Three primitives, one framing:
 *  - **KDF.** `deriveMasterKey` turns a user-held passphrase into a 32-byte AES-256 key via
 *    scrypt. `SCRYPT_PARAMS` (`N: 2**15, r: 8, p: 1`) is exported so the engine can persist it
 *    alongside the salt — the parameters are not secret, only the passphrase is, and a future
 *    tuning change must not silently break decryption of snapshots written under the old cost.
 *  - **AEAD.** `encrypt` / `decrypt` are AES-256-GCM with a fresh random 12-byte nonce per call,
 *    framed as `nonce(12) || ciphertext || authTag(16)` (the exact layout the Data Models section
 *    specifies for both `blobs/<hmacKey>` and `snapshots/<ts>.manifest.enc`). `decrypt` never
 *    returns garbage on a wrong key, a flipped bit, or a truncated buffer — it throws, so a caller
 *    can never mistake corrupted or forged bytes for real plaintext.
 *  - **Content addressing that doesn't leak content.** `storageKey` is
 *    `HMAC-SHA256(masterKey, sha256(plaintext))`, not the bare `sha256(plaintext)` — deriving the
 *    remote key from an HMAC keyed on the master key is what stops the provider correlating two
 *    users' (or two snapshots') blobs by content hash the way a bare-hash CAS would.
 *
 * **Key-check token.** `verify` (Risk: "key loss = unrecoverable backup") needs to catch a
 * wrong/lost key *before* a restore, without ever leaking whether a stored token decrypts under a
 * candidate key to anyone but the caller. `makeKeyCheckToken` encrypts a fixed known plaintext;
 * `verifyKeyCheckToken` tries to decrypt and byte-compares the result, returning `false` on *any*
 * failure (bad tag, wrong key, malformed input) rather than throwing — callers can treat it as a
 * plain boolean predicate, never a try/catch.
 */

/** scrypt cost parameters for `deriveMasterKey`. `N = 2**15` — exported so the engine can store it
 *  next to the salt (`Data Models` → config `encryption`), since a snapshot written under one cost
 *  must be re-derived under the same cost to decrypt, not today's default. */
export const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1 } as const;

const SALT_BYTES = 16;
const MASTER_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
/** scrypt's default `maxmem` (32 MiB) is too small for `N: 2**15` (needs `128 * N * r` ≈ 32 MiB
 *  itself, plus scrypt's own working set) — headroom well above what the params actually need. */
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

/** 16 cryptographically-random bytes for `deriveMasterKey`'s scrypt salt. One per configured
 *  passphrase, persisted in `~/.cezar/backup.json` (never secret — only the passphrase is). */
export function generateSalt(): Buffer {
  return randomBytes(SALT_BYTES);
}

/** Derives the 32-byte AES-256 master key from a user passphrase + salt via scrypt
 *  (`SCRYPT_PARAMS`). Deterministic: the same (passphrase, salt) always yields the same key, which
 *  is what lets a second machine reconstruct the key from the passphrase alone. */
export function deriveMasterKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, MASTER_KEY_BYTES, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    maxmem: SCRYPT_MAXMEM,
  });
}

/** AES-256-GCM-encrypts `plaintext` under `masterKey` with a fresh random nonce, framed as
 *  `nonce(12) || ciphertext || authTag(16)`. Two calls on identical input never produce identical
 *  output — that's the point of a fresh nonce, not a bug to dedupe away. */
export function encrypt(masterKey: Buffer, plaintext: Uint8Array): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', masterKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([nonce, ciphertext, authTag]);
}

/** Reverses `encrypt`. Throws — never returns garbage — on a truncated/malformed frame, a wrong
 *  `masterKey`, or a tampered ciphertext/tag (GCM's auth tag check fails closed on any of those). */
export function decrypt(masterKey: Buffer, framed: Uint8Array): Buffer {
  const buf = Buffer.isBuffer(framed) ? framed : Buffer.from(framed);
  const minLength = NONCE_BYTES + AUTH_TAG_BYTES;
  if (buf.length < minLength) {
    throw new Error(`malformed backup framing: expected at least ${minLength} bytes, got ${buf.length}`);
  }
  const nonce = buf.subarray(0, NONCE_BYTES);
  const authTag = buf.subarray(buf.length - AUTH_TAG_BYTES);
  const ciphertext = buf.subarray(NONCE_BYTES, buf.length - AUTH_TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', masterKey, nonce);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Hex SHA-256 of plaintext bytes — the content hash the manifest stores per entry, and the input
 *  to `storageKey`. Never used directly as a remote object key (see the module doc). */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The deduped remote blob key: `HMAC-SHA256(masterKey, plaintextSha256Hex)`, hex. Keying the HMAC
 *  on the master key (rather than hashing the content hash again) is what makes the key
 *  unrecoverable without the passphrase, so a provider that sees only `blobs/<storageKey>` can
 *  never test a guessed plaintext against it. */
export function storageKey(masterKey: Buffer, plaintextSha256Hex: string): string {
  return createHmac('sha256', masterKey).update(plaintextSha256Hex, 'utf8').digest('hex');
}

/** Fixed known plaintext for the key-check token (`Data Models` → remote `keycheck` object).
 *  Content is arbitrary — only that it's constant across every cezar version, so a token written
 *  today still verifies against tomorrow's build. */
export const KEY_CHECK_PLAINTEXT: Buffer = Buffer.from('cezar-backup-key-check-v1', 'utf8');

/** Encrypts `KEY_CHECK_PLAINTEXT` under `masterKey`. Written once on first configured run
 *  (`server/backup-routes.ts`'s engine), read by `verify` on every subsequent one. */
export function makeKeyCheckToken(masterKey: Buffer): Buffer {
  return encrypt(masterKey, KEY_CHECK_PLAINTEXT);
}

/** `true` iff `token` decrypts under `masterKey` to exactly `KEY_CHECK_PLAINTEXT`. Never throws —
 *  a bad tag, wrong key, or malformed token all just fall out as `false`, so `verify` can treat
 *  this as a plain predicate rather than wrapping every call in its own try/catch. */
export function verifyKeyCheckToken(masterKey: Buffer, token: Uint8Array): boolean {
  let decrypted: Buffer;
  try {
    decrypted = decrypt(masterKey, token);
  } catch {
    return false;
  }
  if (decrypted.length !== KEY_CHECK_PLAINTEXT.length) return false;
  return timingSafeEqual(decrypted, KEY_CHECK_PLAINTEXT);
}
