import { backupEnabled } from '../server/capabilities.ts';
import { listProjects } from '../workspace/projects.ts';
import { getBackupStatus, listSnapshots, runBackup, runGc, verifyBackup } from './snapshot.ts';
import { runRestore } from './restore.ts';

/**
 * `cez backup {status|run|restore|verify|snapshots|gc}` (Phase 7,
 * `.ai/specs/2026-08-16-provider-agnostic-platform-backup.md`, Surfaces §5) — the terminal twin of
 * the Settings → Backup cockpit, built entirely on the already-landed engine (`snapshot.ts` /
 * `restore.ts`), which this file only calls and never modifies.
 *
 * Shape mirrors `workspace/projects-cli.ts`: a `{ log, error }` `io` seam so tests capture output
 * without touching the real console, an `env` override for hermetic tests, one dispatcher that
 * returns the process exit code, subcommand handlers below it.
 *
 * **Master-switch gate (N1).** `backupEnabled(env)` is checked before the subcommand switch, so a
 * flag-off invocation of ANY subcommand — including an unrecognised one — never reaches an engine
 * call: no credential read, no network, no `~/.cezar/backup.json` write. This is the same
 * flag-off guarantee the routes give (D19), just for the CLI surface.
 */

export interface BackupCommandIo {
  log: (line: string) => void;
  error: (line: string) => void;
}

const defaultIo: BackupCommandIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

const USAGE = `usage:
  cez backup [status]            show the backup overview (default)
  cez backup run                 run one incremental backup
  cez backup snapshots           list stored snapshots, newest first
  cez backup verify              check the encryption key + provider are usable
  cez backup restore [--snapshot <id>] [--force]
                                  restore a snapshot (latest, unless --snapshot names one)
  cez backup gc                  prune blobs no surviving snapshot references

  backups are off unless CEZ_BACKUP=1 is set`;

const DISABLED_MESSAGE = 'backups are disabled — set CEZ_BACKUP=1 to enable them';

/**
 * Run one `backup` subcommand. Returns the process exit code (0 ok, 1 for a disabled subsystem, a
 * usage error, or an operational failure the engine threw) so `src/index.ts` can assign it to
 * `process.exitCode` like every other command.
 */
export async function runBackupCommand(
  args: string[],
  opts: { defaultRoot: string; env?: NodeJS.ProcessEnv; io?: BackupCommandIo },
): Promise<number> {
  const io = opts.io ?? defaultIo;
  const env = opts.env ?? process.env;

  // N1: checked before the subcommand is even parsed, so every subcommand — known or not — is
  // refused before any engine call, matching the routes' flag-off guarantee.
  if (!backupEnabled(env)) {
    io.error(DISABLED_MESSAGE);
    return 1;
  }

  const [sub = 'status', ...rest] = args;
  switch (sub) {
    case 'status':
      return statusCommand(io);
    case 'run':
      return runCommand(io);
    case 'snapshots':
      return snapshotsCommand(io);
    case 'verify':
      return verifyCommand(io);
    case 'restore':
      return restoreCommand(rest, io);
    case 'gc':
      return gcCommand(io);
    default:
      io.error(`unknown backup subcommand: ${sub}\n`);
      io.error(USAGE);
      return 1;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** `getBackupStatus` never throws (degrades field-by-field — see its own doc comment), so no
 *  try/catch is needed here. */
async function statusCommand(io: BackupCommandIo): Promise<number> {
  const status = await getBackupStatus({ listProjects });
  io.log(`backups: ${status.enabled ? 'enabled' : 'disabled'}`);
  io.log(`provider: ${status.provider ? `${status.provider.kind} — ${status.provider.label}` : 'not configured'}`);
  io.log(
    status.lastRun
      ? `last run: ${status.lastRun.createdAt} — ${status.lastRun.uploaded} uploaded, ${status.lastRun.skipped} skipped, ${status.lastRun.bytes} bytes`
      : 'last run: never',
  );
  io.log(`snapshots: ${status.snapshotCount}`);
  io.log(
    status.includeSummary
      ? `include: ${status.includeSummary.homeFiles} home file(s), ${status.includeSummary.projectCount} project(s)`
      : 'include: unavailable',
  );
  return 0;
}

/** `runBackup` throws a clear operational error (not configured, already running, key mismatch) —
 *  caught here so the CLI never prints a raw stack trace (N1's routes get the same treatment via
 *  their own error handler; this is the CLI's). */
async function runCommand(io: BackupCommandIo): Promise<number> {
  try {
    const result = await runBackup({ listProjects });
    io.log(`snapshot ${result.snapshotId}: ${result.uploaded} uploaded, ${result.skipped} skipped, ${result.bytes} bytes`);
    return 0;
  } catch (err) {
    io.error(errorMessage(err));
    return 1;
  }
}

/** `listSnapshots` never throws (degrades to `[]` — see its own doc comment). */
async function snapshotsCommand(io: BackupCommandIo): Promise<number> {
  const snapshots = await listSnapshots();
  if (snapshots.length === 0) {
    io.log('no snapshots yet');
    return 0;
  }
  const idWidth = Math.max(...snapshots.map((s) => s.id.length));
  io.log('');
  for (const snap of snapshots) {
    io.log(`  ${snap.id.padEnd(idWidth)}  ${snap.createdAt}  ${formatBytes(snap.sizeBytes).padStart(9)}  ${snap.blobCount} blob(s)`);
  }
  io.log(`\n  ${snapshots.length} snapshot(s)\n`);
  return 0;
}

/** `verifyBackup` never throws (every failure degrades the relevant flag to `false` — see its own
 *  doc comment); verify's job is to fail LOUDLY, so a non-zero exit is the point, not an error path. */
async function verifyCommand(io: BackupCommandIo): Promise<number> {
  const result = await verifyBackup();
  io.log(`keyOk: ${result.keyOk}`);
  io.log(`providerOk: ${result.providerOk}`);
  io.log(`sampleRoundTrip: ${result.sampleRoundTrip}`);
  return result.keyOk && result.providerOk && result.sampleRoundTrip ? 0 : 1;
}

/** `runGc` throws the same "not configured"/"key mismatch" shape `runBackup` does. */
async function gcCommand(io: BackupCommandIo): Promise<number> {
  try {
    const result = await runGc({});
    io.log(`pruned ${result.prunedBlobs} blob(s), freed ${result.freedBytes} bytes`);
    return 0;
  } catch (err) {
    io.error(errorMessage(err));
    return 1;
  }
}

interface ParsedRestoreArgs {
  snapshotId?: string;
  force: boolean;
  error?: string;
}

/** Simple hand-rolled loop (D7: no new dependency) for `restore [--snapshot <id>] [--force]`. */
function parseRestoreArgs(args: string[]): ParsedRestoreArgs {
  let snapshotId: string | undefined;
  let force = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--snapshot') {
      i++;
      const value = args[i];
      if (!value) return { force, error: '--snapshot requires a value' };
      snapshotId = value;
    } else if (arg === '--force') {
      force = true;
    } else {
      return { force, error: `unknown restore argument: ${arg}` };
    }
  }
  return { snapshotId, force };
}

/**
 * `runRestore` throws on the fail-closed overwrite guard (N6) as well as on the same
 * not-configured/key-mismatch/no-backup-found shapes the other mutators do. Only the overwrite
 * guard gets the `--force` hint — matched on the engine's own message (mirrored verbatim by
 * `restore.test.ts`'s own `/refus.*overwrite/i` assertion) rather than guessed from `parsed.force`,
 * so a different failure (e.g. a wrong key) never prints a misleading hint.
 */
async function restoreCommand(args: string[], io: BackupCommandIo): Promise<number> {
  const parsed = parseRestoreArgs(args);
  if (parsed.error) {
    io.error(parsed.error);
    return 1;
  }
  try {
    const result = await runRestore({ snapshotId: parsed.snapshotId, force: parsed.force, listProjects });
    io.log(`restored ${result.restored}, staged ${result.staged}, applied ${result.applied}`);
    return 0;
  } catch (err) {
    const message = errorMessage(err);
    io.error(message);
    if (/refus.*overwrite/i.test(message)) io.error('pass --force to overwrite existing files');
    return 1;
  }
}
