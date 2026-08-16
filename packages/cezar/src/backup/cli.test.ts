import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runBackupCommand, type BackupCommandIo } from './cli.ts';

/**
 * `cez backup` CLI (Phase 7). Exercises `runBackupCommand` against the real `local` provider (no
 * S3, no network — the `snapshot.test.ts`/`restore.test.ts` self-serve-smoke-test convention),
 * with `CEZ_HOME` pinned to a tmpdir so nothing here ever touches a developer's real `~/.cezar`.
 *
 * Output is captured through an injected `io` (the `projects-cli.test.ts` idiom: an object with
 * `log`/`error` pushing into `out`/`err` arrays), which is what the CLI actually writes to when no
 * `io` is given — functionally the same as stubbing `console.log`/`console.error`, without
 * mutating global console state.
 */
describe('cez backup CLI', () => {
  let home: string;
  let remote: string;
  const originalHome = process.env.CEZ_HOME;
  const originalKey = process.env.CEZ_BACKUP_KEY;
  const originalFlag = process.env.CEZ_BACKUP;
  let io: BackupCommandIo & { out: string[]; err: string[] };

  function writeBackupConfig() {
    writeFileSync(
      join(home, 'backup.json'),
      JSON.stringify({
        schemaVersion: 1,
        enabled: true,
        intervalMinutes: 15,
        keepSnapshots: 30,
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

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-backup-cli-home-'));
    remote = mkdtempSync(join(tmpdir(), 'cez-backup-cli-remote-'));
    process.env.CEZ_HOME = home;
    process.env.CEZ_BACKUP_KEY = 'correct horse battery staple';
    writeBackupConfig();
    writeHomeFixture();
    const out: string[] = [];
    const err: string[] = [];
    io = { out, err, log: (l) => out.push(l), error: (l) => err.push(l) };
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = originalHome;
    if (originalKey === undefined) delete process.env.CEZ_BACKUP_KEY;
    else process.env.CEZ_BACKUP_KEY = originalKey;
    if (originalFlag === undefined) delete process.env.CEZ_BACKUP;
    else process.env.CEZ_BACKUP = originalFlag;
    rmSync(home, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  });

  const run = (...args: string[]): Promise<number> => runBackupCommand(args, { defaultRoot: home, io });

  describe('N1 flag-off inertness', () => {
    beforeEach(() => {
      delete process.env.CEZ_BACKUP;
    });

    it.each(['status', 'run', 'snapshots', 'verify', 'gc', 'restore'])(
      '"%s" returns 1 and prints the enable hint',
      async (sub) => {
        const code = await run(sub);
        expect(code).toBe(1);
        expect(io.err.some((l) => l.includes('CEZ_BACKUP=1'))).toBe(true);
      },
    );

    it('the default (no subcommand) also returns 1 with the enable hint', async () => {
      expect(await run()).toBe(1);
      expect(io.err.some((l) => l.includes('CEZ_BACKUP=1'))).toBe(true);
    });

    it('an unrecognised subcommand also returns 1 with the enable hint, not the usage error', async () => {
      expect(await run('bogus')).toBe(1);
      expect(io.err.some((l) => l.includes('CEZ_BACKUP=1'))).toBe(true);
      expect(io.err.some((l) => l.includes('unknown backup subcommand'))).toBe(false);
    });

    it('"run" while off makes no backup on disk — the provider directory stays empty', async () => {
      await run('run');
      expect(existsSync(remote) ? readdirSync(remote) : []).toHaveLength(0);
      expect(existsSync(join(remote, 'keyderiv'))).toBe(false);
      expect(existsSync(join(remote, 'latest'))).toBe(false);
    });
  });

  describe('flag on', () => {
    beforeEach(() => {
      process.env.CEZ_BACKUP = '1';
    });

    it('"run" uploads and reports non-zero counts', async () => {
      const code = await run('run');
      expect(code).toBe(0);
      expect(io.out.some((l) => /^snapshot .+: \d+ uploaded/.test(l))).toBe(true);
      expect(io.out.some((l) => / 0 uploaded/.test(l))).toBe(false);
    });

    it('a second "run" with no change reports "0 uploaded"', async () => {
      await run('run');
      io.out.length = 0;
      const code = await run('run');
      expect(code).toBe(0);
      expect(io.out.some((l) => l.includes('0 uploaded'))).toBe(true);
    });

    it('"snapshots" is empty before any run, then shows one row after "run"', async () => {
      expect(await run('snapshots')).toBe(0);
      expect(io.out).toContain('no snapshots yet');

      io.out.length = 0;
      await run('run');
      io.out.length = 0;
      expect(await run('snapshots')).toBe(0);
      expect(io.out.some((l) => l.includes('blob('))).toBe(true);
      expect(io.out.some((l) => /1 snapshot\(s\)/.test(l))).toBe(true);
    });

    it('"status" reports the provider and the last run once a backup exists', async () => {
      io.out.length = 0;
      expect(await run('status')).toBe(0);
      expect(io.out).toContain('backups: enabled');
      expect(io.out.some((l) => l.includes('local') && l.includes(remote))).toBe(true);
      expect(io.out).toContain('last run: never');

      await run('run');
      io.out.length = 0;
      expect(await run('status')).toBe(0);
      expect(io.out.some((l) => l.startsWith('last run:') && !l.includes('never'))).toBe(true);
    });

    it('"verify" returns 0 with all three flags true after a run', async () => {
      await run('run');
      io.out.length = 0;
      const code = await run('verify');
      expect(code).toBe(0);
      expect(io.out).toEqual(['keyOk: true', 'providerOk: true', 'sampleRoundTrip: true']);
    });

    it('"gc" runs and reports pruned/freed', async () => {
      await run('run');
      io.out.length = 0;
      const code = await run('gc');
      expect(code).toBe(0);
      expect(io.out.some((l) => /^pruned \d+ blob\(s\), freed \d+ bytes$/.test(l))).toBe(true);
    });

    it('an unknown subcommand returns 1 and prints usage', async () => {
      const code = await run('bogus');
      expect(code).toBe(1);
      expect(io.err.some((l) => l.includes('unknown backup subcommand: bogus'))).toBe(true);
    });

    describe('restore', () => {
      it('without --force refuses (targets already exist) and writes nothing', async () => {
        await run('run');
        io.out.length = 0;
        io.err.length = 0;

        const code = await run('restore');
        expect(code).toBe(1);
        expect(io.err.some((l) => /refus.*overwrite/i.test(l))).toBe(true);
        expect(io.err.some((l) => l.includes('--force'))).toBe(true);
        // untouched: still the original fixture content
        expect(readFileSync(join(home, 'notes.json'), 'utf8')).toBe(JSON.stringify({ notes: ['original'] }));
      });

      it('--force applies and restores the backed-up content over a locally-changed file', async () => {
        await run('run');
        const backedUp = readFileSync(join(home, 'notes.json'), 'utf8');

        // Simulate local drift/corruption after the backup was taken.
        writeFileSync(join(home, 'notes.json'), JSON.stringify({ notes: ['drifted'] }));
        expect(readFileSync(join(home, 'notes.json'), 'utf8')).not.toBe(backedUp);

        io.out.length = 0;
        const code = await run('restore', '--force');
        expect(code).toBe(0);
        expect(io.out.some((l) => /^restored \d+, staged \d+, applied true$/.test(l))).toBe(true);
        expect(readFileSync(join(home, 'notes.json'), 'utf8')).toBe(backedUp);
      });

      it('--snapshot <id> restores that point-in-time snapshot, not the latest', async () => {
        const first = await run('run');
        expect(first).toBe(0);
        const firstSnapshotLine = io.out.find((l) => l.startsWith('snapshot '));
        const firstId = firstSnapshotLine?.split(' ')[1]?.replace(/:$/, '');
        expect(firstId).toBeTruthy();

        writeFileSync(join(home, 'notes.json'), JSON.stringify({ notes: ['v2'] }));
        await run('run');

        io.out.length = 0;
        const code = await run('restore', '--snapshot', firstId!, '--force');
        expect(code).toBe(0);
        expect(readFileSync(join(home, 'notes.json'), 'utf8')).toBe(JSON.stringify({ notes: ['original'] }));
      });

      it('an unrecognised flag returns 1 without calling the engine', async () => {
        const code = await run('restore', '--bogus');
        expect(code).toBe(1);
        expect(io.err.some((l) => l.includes('unknown restore argument'))).toBe(true);
      });

      it('--snapshot with no value returns 1', async () => {
        const code = await run('restore', '--snapshot');
        expect(code).toBe(1);
        expect(io.err.some((l) => l.includes('--snapshot requires a value'))).toBe(true);
      });
    });
  });
});
