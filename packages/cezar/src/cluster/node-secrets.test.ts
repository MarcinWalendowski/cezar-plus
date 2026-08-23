import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clusterHomeDir } from './node-identity.ts';
import { lookupNodeSecret, nodeSecretsPath, removeNodeSecret, storeNodeSecret } from './node-secrets.ts';

/**
 * `~/.cezar/cluster/node-secrets.json` — the hub-side store D22 of
 * `.ai/specs/2026-08-22-multi-node-cezar-cluster.md` builds (spec Verification 23, 26, 27). The
 * end-to-end proofs (23: value equals what `redeemEnrollmentCode` handed the spoke; 25: the
 * write-before-redeem ordering; 26: `disableNode` revoking a live signature) live beside the code
 * that calls this store — `enrollment.test.ts` and `peers.test.ts` — because they are proofs about
 * THOSE callers using this store correctly, not about this store in isolation. This file owns the
 * store's own contract: exact round-trip, newest-wins overwrite, corrupt-file and per-entry
 * salvage, and the file-mode floor (27).
 */
describe('cluster/node-secrets', () => {
  const originalHome = process.env.CEZ_HOME;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-node-secrets-'));
    process.env.CEZ_HOME = home;
    // Deliberately NOT pre-creating `cluster/` here (unlike some sibling test files) — this file's
    // own mode-bit assertions (27) need `storeNodeSecret` to be the one that creates it, so a
    // looser-mode directory from test setup can never masquerade as this store's own guarantee.
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('nodeSecretsPath lives under <CEZ_HOME>/cluster/node-secrets.json', () => {
    expect(nodeSecretsPath()).toBe(join(clusterHomeDir(), 'node-secrets.json'));
  });

  describe('storeNodeSecret / lookupNodeSecret', () => {
    it('round-trips the exact value — assert the value, not merely that the file exists (Verification 23)', async () => {
      await storeNodeSecret('node-a', 'the-exact-secret-value');
      expect(await lookupNodeSecret('node-a')).toBe('the-exact-secret-value');
    });

    it('an unknown node id is undefined, never a throw — including when the store has never been written', async () => {
      expect(await lookupNodeSecret('never-heard-of')).toBeUndefined();
      expect(existsSync(nodeSecretsPath())).toBe(false);
    });

    it('storing a second secret for the SAME node id replaces it — newest wins (D22)', async () => {
      await storeNodeSecret('node-a', 'first-secret');
      await storeNodeSecret('node-a', 'second-secret');
      expect(await lookupNodeSecret('node-a')).toBe('second-secret');
    });

    it('two different node ids each keep their own secret, independently', async () => {
      await storeNodeSecret('node-a', 'secret-a');
      await storeNodeSecret('node-b', 'secret-b');
      expect(await lookupNodeSecret('node-a')).toBe('secret-a');
      expect(await lookupNodeSecret('node-b')).toBe('secret-b');
    });

    it('is written PLAINTEXT — the raw value is readable straight off disk, by design (D22)', async () => {
      await storeNodeSecret('node-a', 'plain-as-day');
      const onDisk = JSON.parse(readFileSync(nodeSecretsPath(), 'utf8')) as { secrets: Record<string, string> };
      expect(onDisk.secrets['node-a']).toBe('plain-as-day');
    });
  });

  describe('removeNodeSecret', () => {
    it('removes a stored secret and returns true; a later lookup answers undefined', async () => {
      await storeNodeSecret('node-a', 'secret-a');
      expect(await removeNodeSecret('node-a')).toBe(true);
      expect(await lookupNodeSecret('node-a')).toBeUndefined();
    });

    it('returns false for a node with no stored secret — not an error', async () => {
      expect(await removeNodeSecret('never-stored')).toBe(false);
    });

    it('removing one node leaves every other node untouched', async () => {
      await storeNodeSecret('node-a', 'secret-a');
      await storeNodeSecret('node-b', 'secret-b');
      expect(await removeNodeSecret('node-a')).toBe(true);
      expect(await lookupNodeSecret('node-a')).toBeUndefined();
      expect(await lookupNodeSecret('node-b')).toBe('secret-b');
    });
  });

  describe('corruption — degrade, never throw', () => {
    it('a corrupt file degrades to "nothing stored" with one warning, never throws', async () => {
      mkdirSync(clusterHomeDir(), { recursive: true });
      writeFileSync(nodeSecretsPath(), '{ not json', 'utf8');
      const warnings: string[] = [];
      expect(await lookupNodeSecret('node-a', { warn: (m) => warnings.push(m) })).toBeUndefined();
      expect(warnings).toHaveLength(1);
    });

    it('a file with `secrets` not an object degrades to empty with one warning', async () => {
      mkdirSync(clusterHomeDir(), { recursive: true });
      writeFileSync(nodeSecretsPath(), JSON.stringify({ secrets: ['not', 'a', 'map'] }), 'utf8');
      const warnings: string[] = [];
      expect(await lookupNodeSecret('node-a', { warn: (m) => warnings.push(m) })).toBeUndefined();
      expect(warnings).toHaveLength(1);
    });

    it('per-entry salvage: a malformed VALUE for one node id is dropped, the rest of the store survives', async () => {
      mkdirSync(clusterHomeDir(), { recursive: true });
      writeFileSync(
        nodeSecretsPath(),
        JSON.stringify({ secrets: { 'node-good': 'a-real-secret', 'node-bad': 42 } }),
        'utf8',
      );
      const warnings: string[] = [];
      expect(await lookupNodeSecret('node-good', { warn: (m) => warnings.push(m) })).toBe('a-real-secret');
      expect(await lookupNodeSecret('node-bad', { warn: (m) => warnings.push(m) })).toBeUndefined();
    });
  });

  describe('file mode — Verification 27', () => {
    it('node-secrets.json is written 0600', async () => {
      await storeNodeSecret('node-a', 'secret-a');
      const mode = statSync(nodeSecretsPath()).mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it('the parent cluster/ directory is 0700, not world- or group-readable', async () => {
      await storeNodeSecret('node-a', 'secret-a');
      const mode = statSync(clusterHomeDir()).mode & 0o777;
      expect(mode).toBe(0o700);
    });

    /**
     * The case that actually happens, and the one the assertion above cannot see. Every other writer
     * of `clusterHomeDir()` — `ensureNodeIdentity`, `writeEnrollCodes`, the enroll-codes lock —
     * creates it with `mkdirSync(dir, { recursive: true })` and NO mode, and all of them run before
     * any node redeems a code. `mkdirSync` does not apply a mode to a directory that already exists,
     * so a store that relied on its `mode` option alone would leave the real directory at whatever
     * the umask gave the first writer. Storing into a FRESH home, as the test above does, is the one
     * ordering that never occurs in production.
     */
    it('tightens a cluster/ directory another writer already created with a looser mode', async () => {
      mkdirSync(clusterHomeDir(), { recursive: true, mode: 0o755 });
      // Floor: the loose mode really took, or this test proves nothing about tightening. (An
      // inherited umask can clear bits, so assert what we actually got rather than assuming 0755.)
      const before = statSync(clusterHomeDir()).mode & 0o777;
      expect(before & 0o077).not.toBe(0);

      await storeNodeSecret('node-a', 'secret-a');

      expect(statSync(clusterHomeDir()).mode & 0o777).toBe(0o700);
      expect(await lookupNodeSecret('node-a')).toBe('secret-a');
    });
  });
});
