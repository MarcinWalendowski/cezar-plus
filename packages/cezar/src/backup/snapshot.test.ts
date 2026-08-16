import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveMasterKey, decrypt } from './crypto.ts';
import { parseManifest } from './manifest.ts';
import { runBackup, runGc, getBackupStatus } from './snapshot.ts';

/**
 * Exercises the incremental core against the real `local` provider writing to a tmpdir (no S3,
 * no network — the self-serve smoke test the spec names). `home`/`remote` are two independent
 * tmpdirs; `CEZ_HOME` is pinned to `home` so `loadBackupConfig()`/`cezarHomeDir()` (which are not
 * dependency-injected) resolve there, per the module's own convention.
 */
describe('snapshot engine (local provider)', () => {
  let home: string;
  let remote: string;
  const originalHome = process.env.CEZ_HOME;
  const originalKey = process.env.CEZ_BACKUP_KEY;
  const noProjects = async () => [];

  function writeBackupConfig(overrides: { keepSnapshots?: number } = {}) {
    writeFileSync(
      join(home, 'backup.json'),
      JSON.stringify({
        schemaVersion: 1,
        enabled: true,
        intervalMinutes: 15,
        keepSnapshots: overrides.keepSnapshots ?? 30,
        provider: { kind: 'local', path: remote },
        encryption: { keyEnv: 'CEZ_BACKUP_KEY' },
        include: [],
      }),
    );
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-backup-snap-home-'));
    remote = mkdtempSync(join(tmpdir(), 'cez-backup-snap-remote-'));
    process.env.CEZ_HOME = home;
    process.env.CEZ_BACKUP_KEY = 'correct horse battery staple';
    writeBackupConfig();
    writeFileSync(join(home, 'config.json'), JSON.stringify({ hello: 'world' }));
    mkdirSync(join(home, 'identity'), { recursive: true });
    writeFileSync(join(home, 'identity', 'identity.json'), JSON.stringify({ org: 1 }));
    writeFileSync(join(home, 'notes.json'), JSON.stringify({ notes: [] }));
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = originalHome;
    if (originalKey === undefined) delete process.env.CEZ_BACKUP_KEY;
    else process.env.CEZ_BACKUP_KEY = originalKey;
    rmSync(home, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  });

  it('throws a clear error when no provider is configured', async () => {
    writeFileSync(
      join(home, 'backup.json'),
      JSON.stringify({ schemaVersion: 1, enabled: true, intervalMinutes: 15, keepSnapshots: 30, include: [] }),
    );
    await expect(runBackup({ listProjects: noProjects })).rejects.toThrow(/not configured/i);
  });

  describe('N2 incrementality', () => {
    it('first run uploads the fixture blobs plus a manifest', async () => {
      const first = await runBackup({ listProjects: noProjects });
      expect(first.uploaded).toBeGreaterThan(0);
      expect(first.snapshotId).toBeTruthy();
      expect(existsSync(join(remote, 'snapshots', `${first.snapshotId}.manifest.enc`))).toBe(true);
      expect(existsSync(join(remote, 'latest'))).toBe(true);
    });

    it('a second run with no change uploads zero new blobs', async () => {
      await runBackup({ listProjects: noProjects });
      const second = await runBackup({ listProjects: noProjects });
      expect(second.uploaded).toBe(0);
    });

    it('changing one file yields exactly one new blob and one new manifest; the old manifest is left untouched', async () => {
      const first = await runBackup({ listProjects: noProjects });
      const firstManifestPath = join(remote, 'snapshots', `${first.snapshotId}.manifest.enc`);
      const firstManifestBytesBefore = readFileSync(firstManifestPath);
      const latestBytesBefore = readFileSync(join(remote, 'latest'));

      writeFileSync(join(home, 'notes.json'), JSON.stringify({ notes: ['changed'] }));
      const second = await runBackup({ listProjects: noProjects });

      expect(second.uploaded).toBe(1);
      expect(second.snapshotId).not.toBe(first.snapshotId);
      // the old snapshot's manifest is never rewritten by a later run
      expect(readFileSync(firstManifestPath)).toEqual(firstManifestBytesBefore);
      // `latest` now points somewhere new
      expect(readFileSync(join(remote, 'latest'))).not.toEqual(latestBytesBefore);
      // a plain run never deletes anything — both snapshots remain (only `gc` prunes)
      expect(readdirSync(join(remote, 'snapshots'))).toHaveLength(2);
    });
  });

  describe('N4 zero-knowledge', () => {
    it('never writes a plaintext marker to any object the provider stores', async () => {
      const marker = 'ZKPROOF-MARKER-3f9a7c21';
      writeFileSync(join(home, 'notes.json'), JSON.stringify({ marker }));
      await runBackup({ listProjects: noProjects });

      const allBytes = readAllBytesRecursively(remote);
      expect(allBytes.includes(Buffer.from(marker, 'utf8'))).toBe(false);
    });

    it('aborts on a wrong key (keycheck) without writing new blobs', async () => {
      await runBackup({ listProjects: noProjects }); // establishes keyderiv + keycheck under the right key
      const blobsBefore = readdirSync(join(remote, 'blobs')).length;

      process.env.CEZ_BACKUP_KEY = 'a totally different passphrase';
      writeFileSync(join(home, 'notes.json'), JSON.stringify({ notes: ['would create a new blob'] }));

      await expect(runBackup({ listProjects: noProjects })).rejects.toThrow(/key mismatch/i);

      expect(readdirSync(join(remote, 'blobs'))).toHaveLength(blobsBefore);
    });
  });

  describe('gc', () => {
    it('respects keepSnapshots and prunes only blobs no surviving snapshot references', async () => {
      writeBackupConfig({ keepSnapshots: 2 });

      await runBackup({ listProjects: noProjects }); // snapshot 1: notes v1
      writeFileSync(join(home, 'notes.json'), JSON.stringify({ v: 2 }));
      await runBackup({ listProjects: noProjects }); // snapshot 2: notes v2
      writeFileSync(join(home, 'notes.json'), JSON.stringify({ v: 3 }));
      await runBackup({ listProjects: noProjects }); // snapshot 3: notes v3

      expect(readdirSync(join(remote, 'snapshots'))).toHaveLength(3);

      const result = await runGc({});

      expect(readdirSync(join(remote, 'snapshots'))).toHaveLength(2); // oldest pruned
      expect(result.prunedBlobs).toBe(1); // only notes-v1's blob is unreferenced by snapshots 2/3
      expect(result.freedBytes).toBeGreaterThan(0);

      // Every blob a surviving snapshot references must still be present on disk.
      const passphrase = process.env.CEZ_BACKUP_KEY!;
      const keyderiv = JSON.parse(readFileSync(join(remote, 'keyderiv'), 'utf8')) as { salt: string };
      const masterKey = deriveMasterKey(passphrase, Buffer.from(keyderiv.salt, 'base64'));
      for (const file of readdirSync(join(remote, 'snapshots'))) {
        const manifest = parseManifest(decrypt(masterKey, readFileSync(join(remote, 'snapshots', file))));
        for (const entry of manifest.entries) {
          expect(existsSync(join(remote, 'blobs', entry.hmacKey))).toBe(true);
        }
      }

      // gc is safe to re-run: nothing left to prune.
      const again = await runGc({});
      expect(again.prunedBlobs).toBe(0);
    });
  });

  describe('getBackupStatus', () => {
    it('never throws and reports a populated overview once a run has happened', async () => {
      await runBackup({ listProjects: noProjects });
      const status = await getBackupStatus({ listProjects: noProjects });
      expect(status.enabled).toBe(true);
      expect(status.provider).toEqual({ kind: 'local', label: remote });
      expect(status.lastRun).not.toBeNull();
      expect(status.snapshotCount).toBe(1);
      // 4 home files: config.json, identity/identity.json, notes.json, and backup.json itself
      // (the subsystem's own config is part of the corpus — see backup/paths.ts HOME_INCLUDE).
      expect(status.includeSummary).toEqual({ homeFiles: 4, projectCount: 0 });
    });

    it('degrades to nulls rather than throwing when unconfigured', async () => {
      writeFileSync(
        join(home, 'backup.json'),
        JSON.stringify({ schemaVersion: 1, enabled: false, intervalMinutes: 15, keepSnapshots: 30, include: [] }),
      );
      const status = await getBackupStatus({ listProjects: noProjects });
      expect(status.enabled).toBe(false);
      expect(status.provider).toBeNull();
      expect(status.lastRun).toBeNull();
      expect(status.snapshotCount).toBe(0);
    });
  });
});

function readAllBytesRecursively(dir: string): Buffer {
  const parts: Buffer[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) parts.push(readAllBytesRecursively(full));
    else if (entry.isFile()) parts.push(readFileSync(full));
  }
  return Buffer.concat(parts);
}
