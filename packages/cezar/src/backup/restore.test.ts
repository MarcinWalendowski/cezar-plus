import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveMasterKey, encrypt } from './crypto.ts';
import { runBackup } from './snapshot.ts';
import { runRestore } from './restore.ts';

/**
 * Exercises `runRestore` against the real `local` provider (no S3, no network — the self-serve
 * smoke test the spec names), producing every fixture backup via the real `runBackup` so this is a
 * true round-trip through the engine's own wire format, not a hand-assembled one.
 *
 * Two independent "home" dirs and two independent project roots throughout: `home`/`projectSrc`
 * are what gets BACKED UP (also where `CEZ_HOME` points, since `loadBackupConfig()` — and hence
 * the provider/passphrase resolution `runRestore` needs to even start — always reads
 * `cezarHomeDir()`, independent of `runRestore`'s injected `homeDir`); `restoreHome`/`projectDst`
 * are the RESTORE target, injected via `runRestore`'s `homeDir`/`listProjects` deps. Restoring into
 * a fresh, independent location — rather than back onto the same paths — is both the cleanest way
 * to assert byte-identity without fighting the fail-closed overwrite guard, and the realistic
 * shape of the feature's own motivating scenario (recovering onto a NEW machine).
 */
describe('restore engine (local provider)', () => {
  let home: string;
  let remote: string;
  let projectSrc: string;
  let restoreHome: string;
  let projectDst: string;
  const originalHome = process.env.CEZ_HOME;
  const originalKey = process.env.CEZ_BACKUP_KEY;
  const PROJECT_ID = 'proj1';

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

  function writeHomeFixture() {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ hello: 'world' }));
    mkdirSync(join(home, 'identity'), { recursive: true });
    writeFileSync(join(home, 'identity', 'identity.json'), JSON.stringify({ org: 1 }));
    writeFileSync(join(home, 'notes.json'), JSON.stringify({ notes: ['original'] }));
  }

  function writeProjectFixture(root: string, content: string) {
    const kbDir = join(root, '.ai', 'cezar', 'knowledge');
    mkdirSync(kbDir, { recursive: true });
    writeFileSync(join(kbDir, 'doc1.md'), content);
  }

  const srcProjects = async () => [{ id: PROJECT_ID, root: projectSrc }];
  const dstProjects = async () => [{ id: PROJECT_ID, root: projectDst }];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-backup-restore-home-'));
    remote = mkdtempSync(join(tmpdir(), 'cez-backup-restore-remote-'));
    projectSrc = mkdtempSync(join(tmpdir(), 'cez-backup-restore-projsrc-'));
    restoreHome = mkdtempSync(join(tmpdir(), 'cez-backup-restore-dsthome-'));
    projectDst = mkdtempSync(join(tmpdir(), 'cez-backup-restore-projdst-'));
    process.env.CEZ_HOME = home;
    process.env.CEZ_BACKUP_KEY = 'correct horse battery staple';
    writeBackupConfig();
    writeHomeFixture();
    writeProjectFixture(projectSrc, '# doc1\ncontent v1\n');
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = originalHome;
    if (originalKey === undefined) delete process.env.CEZ_BACKUP_KEY;
    else process.env.CEZ_BACKUP_KEY = originalKey;
    for (const dir of [home, remote, projectSrc, restoreHome, projectDst]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('N3 round-trip', () => {
    it('restores home + project files byte-identical to the originals, onto a fresh location', async () => {
      await runBackup({ listProjects: srcProjects });

      const result = await runRestore({
        homeDir: restoreHome,
        listProjects: dstProjects,
      });

      expect(result.skippedProjects).toBe(0);
      expect(result.applied).toBe(true);
      expect(result.restored).toBe(result.staged);
      expect(result.restored).toBeGreaterThan(0);

      expect(readFileSync(join(restoreHome, 'config.json'), 'utf8')).toBe(
        readFileSync(join(home, 'config.json'), 'utf8'),
      );
      expect(readFileSync(join(restoreHome, 'identity', 'identity.json'), 'utf8')).toBe(
        readFileSync(join(home, 'identity', 'identity.json'), 'utf8'),
      );
      expect(readFileSync(join(restoreHome, 'notes.json'), 'utf8')).toBe(
        readFileSync(join(home, 'notes.json'), 'utf8'),
      );
      expect(readFileSync(join(restoreHome, 'backup.json'), 'utf8')).toBe(
        readFileSync(join(home, 'backup.json'), 'utf8'),
      );
      const restoredDoc = join(projectDst, '.ai', 'cezar', 'knowledge', 'doc1.md');
      expect(readFileSync(restoredDoc, 'utf8')).toBe(
        readFileSync(join(projectSrc, '.ai', 'cezar', 'knowledge', 'doc1.md'), 'utf8'),
      );
    });

    it('a project id matching no registered project is skipped and counted, not a failure', async () => {
      await runBackup({ listProjects: srcProjects });

      const result = await runRestore({
        homeDir: restoreHome,
        listProjects: async () => [], // the project isn't mounted on this machine
      });

      expect(result.skippedProjects).toBeGreaterThan(0);
      // home files still restore fine even though the project entry was skipped.
      expect(readFileSync(join(restoreHome, 'notes.json'), 'utf8')).toBe(
        readFileSync(join(home, 'notes.json'), 'utf8'),
      );
      expect(existsSync(join(projectDst, '.ai', 'cezar', 'knowledge', 'doc1.md'))).toBe(false);
    });
  });

  describe('N6 fail-closed overwrite guard', () => {
    it('refuses and writes nothing when a target already exists and force is unset', async () => {
      await runBackup({ listProjects: srcProjects });

      mkdirSync(restoreHome, { recursive: true });
      writeFileSync(join(restoreHome, 'notes.json'), 'PRE-EXISTING, MUST SURVIVE');

      await expect(
        runRestore({ homeDir: restoreHome, listProjects: dstProjects }),
      ).rejects.toThrow(/refus.*overwrite/i);

      // the pre-existing file is untouched...
      expect(readFileSync(join(restoreHome, 'notes.json'), 'utf8')).toBe('PRE-EXISTING, MUST SURVIVE');
      // ...and nothing else from the backup was written to the live tree either.
      expect(existsSync(join(restoreHome, 'config.json'))).toBe(false);
      expect(existsSync(join(projectDst, '.ai', 'cezar', 'knowledge', 'doc1.md'))).toBe(false);
    });

    it('force:true overwrites and reports applied', async () => {
      await runBackup({ listProjects: srcProjects });

      mkdirSync(restoreHome, { recursive: true });
      writeFileSync(join(restoreHome, 'notes.json'), 'PRE-EXISTING, WILL BE OVERWRITTEN');

      const result = await runRestore({
        homeDir: restoreHome,
        listProjects: dstProjects,
        force: true,
      });

      expect(result.applied).toBe(true);
      expect(readFileSync(join(restoreHome, 'notes.json'), 'utf8')).toBe(
        readFileSync(join(home, 'notes.json'), 'utf8'),
      );
    });
  });

  describe('N4 wrong key', () => {
    it('rejects with a key-mismatch error and writes nothing to the live tree', async () => {
      await runBackup({ listProjects: srcProjects }); // establishes keyderiv + keycheck under the right key

      process.env.CEZ_BACKUP_KEY = 'a totally different passphrase';

      await expect(
        runRestore({ homeDir: restoreHome, listProjects: dstProjects }),
      ).rejects.toThrow(/key mismatch/i);

      expect(existsSync(join(restoreHome, 'notes.json'))).toBe(false);
      expect(existsSync(join(projectDst, '.ai', 'cezar', 'knowledge', 'doc1.md'))).toBe(false);
    });
  });

  describe('point-in-time restore', () => {
    it('a specific snapshotId restores that snapshot, not the latest', async () => {
      const first = await runBackup({ listProjects: srcProjects }); // doc1 v1
      writeProjectFixture(projectSrc, '# doc1\ncontent v2\n');
      await runBackup({ listProjects: srcProjects }); // doc1 v2, now latest

      const result = await runRestore({
        homeDir: restoreHome,
        listProjects: dstProjects,
        snapshotId: first.snapshotId,
      });

      expect(result.applied).toBe(true);
      const restoredDoc = join(projectDst, '.ai', 'cezar', 'knowledge', 'doc1.md');
      expect(readFileSync(restoredDoc, 'utf8')).toBe('# doc1\ncontent v1\n');
    });
  });

  describe('sha256 verification', () => {
    it('rejects a tampered blob and never writes its content', async () => {
      await runBackup({ listProjects: srcProjects });

      // Re-encrypt DIFFERENT plaintext under the real master key and overwrite one blob with it —
      // valid ciphertext (decrypts cleanly, so this isn't caught by GCM's auth tag), but its
      // content no longer matches the sha256 the manifest recorded for that path.
      const keyderiv = JSON.parse(readFileSync(join(remote, 'keyderiv'), 'utf8')) as { salt: string };
      const masterKey = deriveMasterKey(process.env.CEZ_BACKUP_KEY!, Buffer.from(keyderiv.salt, 'base64'));
      const blobFiles = readdirSync(join(remote, 'blobs'));
      expect(blobFiles.length).toBeGreaterThan(0);
      const tamperedKey = blobFiles[0]!;
      writeFileSync(join(remote, 'blobs', tamperedKey), encrypt(masterKey, Buffer.from('TAMPERED CONTENT')));

      await expect(
        runRestore({ homeDir: restoreHome, listProjects: dstProjects }),
      ).rejects.toThrow(/sha256 mismatch/i);

      expect(existsSync(join(restoreHome, 'config.json'))).toBe(false);
      expect(existsSync(join(projectDst, '.ai', 'cezar', 'knowledge', 'doc1.md'))).toBe(false);
    });
  });
});
