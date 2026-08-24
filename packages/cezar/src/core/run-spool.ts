import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';

/**
 * The run spool (P4 of `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`).
 *
 * This is the file layout that turns an agent run from something the server *owns* into something
 * the server merely *reads*, which is the single change the whole "a deploy mid-run leaves the run
 * alive and streaming" criterion rests on.
 *
 * Today `ClaudeCliRunner` spawns the CLI and consumes `readNdjson(child.stdout)` in-process, so
 * the server process IS the pipe's read end. Kill the server and the output has nowhere to go —
 * which is why simply moving the child to another cgroup makes things worse rather than better:
 * the process survives, gets EPIPE on its next write, and nothing recorded what it said. Relocating
 * the process without relocating the pipe is not a partial fix, it is a different bug.
 *
 * So the broker writes the backend's stdout to a FILE, and the server tails that file from a byte
 * offset it persists on the run record. A restart then costs nothing: the new server re-opens the
 * spool at the offset the old one had reached and replays exactly the bytes it had not yet
 * consumed. No gap, no duplicate — the two failure modes a naive "re-attach and hope" would have.
 *
 * Pure filesystem + schemas; no child processes here (see `run-broker.ts`) and no server wiring
 * (see `brokered-session.ts`).
 */

/** Bumped when the on-disk spool contract changes in a way a running broker/server pair cannot
 *  straddle. A server re-attaching to a spool with a different major refuses and falls back. */
export const BROKER_PROTOCOL = 2;
export const SPOOL_ORPHAN_GRACE_MS = 30 * 60_000;

export const spoolMetaSchema = z
  .object({
    schema: z.literal(1).catch(1),
    protocol: z.number().int().default(BROKER_PROTOCOL).catch(BROKER_PROTOCOL),
    runId: z.string().min(1),
    stepId: z.string().optional().catch(undefined),
    backend: z.string().min(1),
    /** The broker's own pid — the thing liveness is tested against. NOT the backend CLI's pid:
     *  the broker outlives nothing if it dies, and it is the broker that owns the spool. */
    pid: z.number().int().positive(),
    /** The backend CLI's pid, for resource telemetry (#348) and for a human reading the spool. */
    childPid: z.number().int().positive().optional().catch(undefined),
    argv: z.array(z.string()).default([]).catch([]),
    cwd: z.string().optional().catch(undefined),
    startedAt: z.string().optional().catch(undefined),
    /** Unique identity of this broker launch. Absent only on protocol-1 spools. */
    instanceId: z.string().min(1).optional().catch(undefined),
  })
  .passthrough();
export type SpoolMeta = z.infer<typeof spoolMetaSchema>;

export const spoolExitSchema = z
  .object({
    code: z.number().int().nullable().catch(null),
    signal: z.string().nullable().catch(null),
    exitedAt: z.string().optional().catch(undefined),
    brokerPid: z.number().int().positive().optional().catch(undefined),
    instanceId: z.string().min(1).optional().catch(undefined),
  })
  .passthrough();
export type SpoolExit = z.infer<typeof spoolExitSchema>;

export interface SpoolPaths {
  dir: string;
  meta: string;
  out: string;
  err: string;
  ctl: string;
  exit: string;
}

export function spoolPaths(spoolDir: string): SpoolPaths {
  return {
    dir: spoolDir,
    meta: join(spoolDir, 'meta.json'),
    out: join(spoolDir, 'out.ndjson'),
    err: join(spoolDir, 'err.log'),
    ctl: controlSocketPath(spoolDir),
    exit: join(spoolDir, 'exit.json'),
  };
}

/**
 * The longest `sun_path` a unix domain socket may have, minus the NUL: 108 bytes on Linux, and
 * the smallest of the platform values cezar runs on.
 */
export const UNIX_SOCKET_PATH_MAX = 107;

/**
 * Where the broker's control socket actually lives.
 *
 * **This is not defensive programming; it is a measured defect.** `bind(2)` copies `sun_path` into
 * a fixed 108-byte field, and libuv does not refuse an over-long path — it TRUNCATES it. Measured
 * on this box: a 110-character socket path binds successfully and reports no error, and the socket
 * file appears at the truncated path, not the one asked for. Both `listen` and `connect` truncate
 * identically, so control ops keep working and nothing looks wrong — until something reasons about
 * the path as a FILE. `rmSync(paths.ctl)` then deletes nothing, the stale socket outlives its
 * broker, and the next broker for that spool hits `EADDRINUSE` on a path it can see is empty. (A
 * 117-character path did exactly that in testing, colliding with a 110-character path's leftover.)
 *
 * A spool path gets long easily: `<project>/.ai/cezar/runs/<uuid>.spool/ctl.sock` is already ~98
 * characters from a short project root, and a task worktree or a nested checkout clears 107 without
 * anything unusual happening.
 *
 * So: keep the socket beside the spool while it fits — that is the discoverable, greppable layout
 * an operator expects — and fall back to a short, DETERMINISTIC path under the temp dir when it
 * does not. Deterministic matters more than pretty here: the broker and every future server derive
 * it from the same spool dir with no shared state, so a re-attach after a restart finds the same
 * socket without having to read anything.
 */
export function controlSocketPath(spoolDir: string, tmp: string = tmpdir()): string {
  const inSpool = join(spoolDir, 'ctl.sock');
  if (Buffer.byteLength(inSpool) <= UNIX_SOCKET_PATH_MAX) return inSpool;
  // Keyed on the RESOLVED directory so `./x` and `/abs/x` cannot produce two sockets for one spool.
  const name = `cez-ctl-${createHash('sha1').update(resolve(spoolDir)).digest('hex').slice(0, 16)}.sock`;
  // `/tmp` FIRST, and `os.tmpdir()` only as a fallback — which is the opposite of the usual
  // preference, for a measured reason. `TMPDIR` is routinely set to something long (cezar itself
  // gives every run a per-task temp dir, 81 characters on this box), and a "short" fallback built
  // on it can blow the same 107-byte budget the fallback exists to escape. `/tmp` is 4 characters
  // and exists on every platform cezar runs on. If it somehow does not, the tmpdir attempt is
  // still better than the spool path that already failed.
  for (const base of ['/tmp', tmp]) {
    const candidate = join(base, name);
    if (Buffer.byteLength(candidate) <= UNIX_SOCKET_PATH_MAX && existsSync(base)) return candidate;
  }
  return join(tmp, name);
}

/** `<dataDir>/runs/<runId>.spool/<instanceId>`: one directory per broker launch. */
export function spoolDirFor(runsDir: string, runId: string, instanceId: string): string {
  return join(legacySpoolDirFor(runsDir, runId), instanceId);
}

/** The protocol-1 flat spool path, retained only for recovery and migration. */
export function legacySpoolDirFor(runsDir: string, runId: string): string {
  return join(runsDir, `${runId}.spool`);
}

export function ensureSpoolDir(spoolDir: string): SpoolPaths {
  mkdirSync(spoolDir, { recursive: true, mode: 0o700 });
  const paths = spoolPaths(spoolDir);
  try {
    unlinkSync(paths.exit);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return paths;
}

export function writeSpoolMeta(spoolDir: string, meta: SpoolMeta): void {
  const paths = spoolPaths(spoolDir);
  const tmp = `${paths.meta}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, paths.meta);
}

/** Read the spool's identity, or null when it is missing/corrupt — both mean "cannot re-attach",
 *  and the caller's job on null is to fall back to the legacy interrupted-run path. */
export function readSpoolMeta(spoolDir: string): SpoolMeta | null {
  try {
    const parsed = spoolMetaSchema.safeParse(JSON.parse(readFileSync(spoolPaths(spoolDir).meta, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeSpoolExit(spoolDir: string, exit: SpoolExit): void {
  const paths = spoolPaths(spoolDir);
  const tmp = `${paths.exit}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(exit, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, paths.exit);
}

export function readSpoolExit(spoolDir: string): SpoolExit | null {
  try {
    const parsed = spoolExitSchema.safeParse(JSON.parse(readFileSync(spoolPaths(spoolDir).exit, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Liveness by signal 0 — delivers nothing, only asks "may I signal this pid?". EPERM means the
 *  process exists under another uid, which still counts as alive. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Whether an exit can be attributed to the broker described by meta. */
export function exitBelongsTo(
  meta: SpoolMeta | null,
  exit: SpoolExit,
  alive: (pid: number) => boolean = isPidAlive,
): boolean {
  if (!meta) return false;
  if (meta.instanceId && exit.instanceId) return meta.instanceId === exit.instanceId;
  if (exit.brokerPid !== undefined) return exit.brokerPid === meta.pid;
  if (meta.instanceId) return false;
  return !alive(meta.pid);
}

export interface SpoolReadResult {
  /** Complete lines only. A trailing partial line is deliberately NOT returned. */
  lines: string[];
  /** Offset to resume from — points just past the last complete line consumed. */
  nextOffset: number;
  /** Bytes present in the spool at read time (>= nextOffset when a partial line is buffered). */
  size: number;
}

/**
 * Read complete NDJSON lines from `offset`.
 *
 * The partial-line rule is the correctness core of re-attach. The broker appends whatever the
 * backend flushed, so a read can easily land mid-record — the JSON is half-written. Returning that
 * fragment would corrupt the stream; advancing the offset past it would LOSE the record. So the
 * offset advances only past bytes that end in a newline, and the fragment is re-read next time.
 * That is what makes "resume at `consumedOffset`" exact rather than approximate.
 *
 * An offset beyond EOF (a truncated or replaced spool) yields nothing and reports the real size,
 * so the caller can detect the anomaly and fall back rather than silently skipping output.
 */
export function readSpoolFrom(outPath: string, offset: number): SpoolReadResult {
  let size = 0;
  try {
    size = statSync(outPath).size;
  } catch {
    return { lines: [], nextOffset: offset, size: 0 };
  }
  const from = Math.max(0, offset);
  if (from >= size) return { lines: [], nextOffset: from, size };

  const length = size - from;
  const buf = Buffer.allocUnsafe(length);
  const fd = openSync(outPath, 'r');
  let read = 0;
  try {
    read = readSync(fd, buf, 0, length, from);
  } finally {
    closeSync(fd);
  }

  const text = buf.subarray(0, read).toString('utf8');
  const lastNewline = text.lastIndexOf('\n');
  if (lastNewline < 0) return { lines: [], nextOffset: from, size };

  const complete = text.slice(0, lastNewline);
  // Byte length, not character length: a multi-byte UTF-8 record would otherwise desynchronise
  // the offset from the file and every subsequent read would be shifted.
  const consumed = Buffer.byteLength(complete, 'utf8') + 1;
  const lines = complete.split('\n').filter((l) => l.length > 0);
  return { lines, nextOffset: from + consumed, size };
}

/** True when a spool looks re-attachable: its broker is alive and has not recorded its own exit. */
export function isSpoolLive(spoolDir: string): boolean {
  if (!existsSync(spoolDir)) return false;
  const meta = readSpoolMeta(spoolDir);
  if (!meta) return false;
  if (meta.protocol !== BROKER_PROTOCOL) return false;
  const exit = readSpoolExit(spoolDir);
  if (exit && exitBelongsTo(meta, exit)) return false;
  return isPidAlive(meta.pid);
}
