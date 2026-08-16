import { describe, expect, it } from 'vitest';
import {
  KEY_CHECK_PLAINTEXT,
  SCRYPT_PARAMS,
  decrypt,
  deriveMasterKey,
  encrypt,
  generateSalt,
  makeKeyCheckToken,
  sha256Hex,
  storageKey,
  verifyKeyCheckToken,
} from './crypto.ts';

/**
 * N4 — zero-knowledge crypto. This is the unit-level half of N4 (Verification): every object the
 * snapshot engine ever hands a `BackupProvider` must be ciphertext that (a) round-trips exactly,
 * (b) never decrypts, or verifies, under the wrong key, and (c) fails closed — never garbage — on
 * a tampered or malformed frame. `sha256Hex` / `storageKey` cover the content-addressing half: the
 * remote blob key must not be recoverable from the plaintext hash alone (see `crypto.ts`'s module
 * doc for why it's an HMAC, not a bare hash).
 */

const PASSPHRASE = 'correct horse battery staple';
const OTHER_PASSPHRASE = 'a different passphrase entirely';

function testMasterKey(passphrase = PASSPHRASE): Buffer {
  return deriveMasterKey(passphrase, generateSalt());
}

describe('deriveMasterKey', () => {
  it('is deterministic given the same passphrase + salt', () => {
    const salt = generateSalt();
    const a = deriveMasterKey(PASSPHRASE, salt);
    const b = deriveMasterKey(PASSPHRASE, salt);
    expect(a.equals(b)).toBe(true);
  });

  it('differs when the salt differs', () => {
    const a = deriveMasterKey(PASSPHRASE, generateSalt());
    const b = deriveMasterKey(PASSPHRASE, generateSalt());
    expect(a.equals(b)).toBe(false);
  });

  it('differs when the passphrase differs', () => {
    const salt = generateSalt();
    const a = deriveMasterKey(PASSPHRASE, salt);
    const b = deriveMasterKey(OTHER_PASSPHRASE, salt);
    expect(a.equals(b)).toBe(false);
  });

  it('is 32 bytes (AES-256 key size)', () => {
    const key = testMasterKey();
    expect(key.length).toBe(32);
  });

  it('exports SCRYPT_PARAMS with N = 2**15', () => {
    expect(SCRYPT_PARAMS.N).toBe(2 ** 15);
    expect(SCRYPT_PARAMS).toEqual({ N: 32768, r: 8, p: 1 });
  });
});

describe('encrypt / decrypt round-trip', () => {
  const cases: Array<[name: string, plaintext: Buffer]> = [
    ['empty', Buffer.alloc(0)],
    ['single byte', Buffer.from([0x42])],
    ['short text', Buffer.from('hello, backup', 'utf8')],
    ['exactly one AES block (16 bytes)', Buffer.alloc(16, 7)],
    ['multi-block (>1 block)', Buffer.alloc(5000, 9)],
    ['large (~1 MiB)', randomLikeBuffer(1024 * 1024)],
  ];

  for (const [name, plaintext] of cases) {
    it(`is byte-identical for ${name} plaintext`, () => {
      const key = testMasterKey();
      const framed = encrypt(key, plaintext);
      const roundTripped = decrypt(key, framed);
      expect(roundTripped.equals(plaintext)).toBe(true);
    });
  }

  it('frames output as nonce(12) || ciphertext || authTag(16)', () => {
    const key = testMasterKey();
    const plaintext = Buffer.from('framing check', 'utf8');
    const framed = encrypt(key, plaintext);
    expect(framed.length).toBe(12 + plaintext.length + 16);
  });

  it('produces a different nonce (and framing) on each call for identical plaintext + key, and both decrypt back', () => {
    const key = testMasterKey();
    const plaintext = Buffer.from('same plaintext, twice', 'utf8');
    const framedA = encrypt(key, plaintext);
    const framedB = encrypt(key, plaintext);

    expect(framedA.equals(framedB)).toBe(false);
    const nonceA = framedA.subarray(0, 12);
    const nonceB = framedB.subarray(0, 12);
    expect(nonceA.equals(nonceB)).toBe(false);

    expect(decrypt(key, framedA).equals(plaintext)).toBe(true);
    expect(decrypt(key, framedB).equals(plaintext)).toBe(true);
  });
});

describe('decrypt failure modes (fail closed, never garbage)', () => {
  it('throws when decrypting with the wrong master key', () => {
    const rightKey = testMasterKey();
    const wrongKey = testMasterKey(OTHER_PASSPHRASE);
    const framed = encrypt(rightKey, Buffer.from('secret payload', 'utf8'));
    expect(() => decrypt(wrongKey, framed)).toThrow();
  });

  it('throws when a ciphertext byte is flipped', () => {
    const key = testMasterKey();
    const framed = encrypt(key, Buffer.from('tamper me if you can', 'utf8'));
    const tampered = Buffer.from(framed);
    // Byte 12 is the first ciphertext byte (right after the 12-byte nonce).
    tampered[12] = (tampered[12]! ^ 0xff) & 0xff;
    expect(() => decrypt(key, tampered)).toThrow();
  });

  it('throws when an auth tag byte is flipped', () => {
    const key = testMasterKey();
    const framed = encrypt(key, Buffer.from('tamper me if you can', 'utf8'));
    const tampered = Buffer.from(framed);
    const lastIndex = tampered.length - 1;
    tampered[lastIndex] = (tampered[lastIndex]! ^ 0xff) & 0xff;
    expect(() => decrypt(key, tampered)).toThrow();
  });

  it('throws on a truncated/malformed frame', () => {
    const key = testMasterKey();
    expect(() => decrypt(key, Buffer.alloc(0))).toThrow();
    expect(() => decrypt(key, Buffer.alloc(10))).toThrow(); // shorter than nonce+authTag
  });
});

describe('sha256Hex', () => {
  it('is a 64-char hex digest', () => {
    const digest = sha256Hex(Buffer.from('hello', 'utf8'));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic and content-sensitive', () => {
    const a = sha256Hex(Buffer.from('content A', 'utf8'));
    const b = sha256Hex(Buffer.from('content A', 'utf8'));
    const c = sha256Hex(Buffer.from('content B', 'utf8'));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('storageKey', () => {
  it('is stable for the same (masterKey, contentHash)', () => {
    const key = testMasterKey();
    const hash = sha256Hex(Buffer.from('some plaintext', 'utf8'));
    expect(storageKey(key, hash)).toBe(storageKey(key, hash));
  });

  it('differs across different content hashes under the same key', () => {
    const key = testMasterKey();
    const hashA = sha256Hex(Buffer.from('plaintext A', 'utf8'));
    const hashB = sha256Hex(Buffer.from('plaintext B', 'utf8'));
    expect(storageKey(key, hashA)).not.toBe(storageKey(key, hashB));
  });

  it('differs across different master keys for the same content hash', () => {
    const keyA = testMasterKey(PASSPHRASE);
    const keyB = testMasterKey(OTHER_PASSPHRASE);
    const hash = sha256Hex(Buffer.from('shared plaintext', 'utf8'));
    expect(storageKey(keyA, hash)).not.toBe(storageKey(keyB, hash));
  });
});

describe('key-check token', () => {
  it('verifies true under the right key', () => {
    const key = testMasterKey();
    const token = makeKeyCheckToken(key);
    expect(verifyKeyCheckToken(key, token)).toBe(true);
  });

  it('verifies false under the wrong key', () => {
    const rightKey = testMasterKey();
    const wrongKey = testMasterKey(OTHER_PASSPHRASE);
    const token = makeKeyCheckToken(rightKey);
    expect(verifyKeyCheckToken(wrongKey, token)).toBe(false);
  });

  it('never throws — a malformed token also just verifies false', () => {
    const key = testMasterKey();
    expect(() => verifyKeyCheckToken(key, Buffer.alloc(0))).not.toThrow();
    expect(verifyKeyCheckToken(key, Buffer.alloc(0))).toBe(false);
    expect(verifyKeyCheckToken(key, Buffer.from('not a real token'))).toBe(false);
  });

  it('makeKeyCheckToken encrypts exactly KEY_CHECK_PLAINTEXT', () => {
    const key = testMasterKey();
    const token = makeKeyCheckToken(key);
    expect(decrypt(key, token).equals(KEY_CHECK_PLAINTEXT)).toBe(true);
  });
});

/** A deterministic-enough large buffer for a size test — doesn't need real entropy, just needs to
 *  not be all-zero (which would make an accidental "still all zero" decrypt bug invisible). */
function randomLikeBuffer(size: number): Buffer {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = i % 256;
  return buf;
}
