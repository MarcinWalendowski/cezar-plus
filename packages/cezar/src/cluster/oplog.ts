import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ClusterOp } from '@loki-labs/cezar-plus-contract';
import { compactOps, salvageOps, type CompactOpsInput, type SalvagedOps } from './ops.ts';

/**
 * `.ai/cezar/cluster/ops.ndjson` — the append/read/compact half of the outbox (spec
 * `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, D5 · D13).
 *
 * **This file is a cache, and losing it is survivable by design.** The truth is the set of records
 * marked `pendingSince`; `cluster/ops.ts`'s `deriveTodoOps` re-derives everything this log holds. So
 * the append path may be fast and un-fsynced: a torn last line is dropped by per-entry salvage on
 * read, and the op it held comes back on the next derive. What must never happen is the inverse —
 * treating the log as authoritative and skipping the derive, which turns a lost tail into a lost
 * write.
 *
 * NDJSON, one op per line, `.passthrough()` on read so a newer node's op round-trips through an
 * older one verbatim (D13). Project-scoped: it lives beside the project's own `todos.json` in its
 * data dir, not in `~/.cezar`, because that is where the records it is derived from live.
 *
 * No cross-process lease here, deliberately — unlike `todos.ts`'s `withTodosLease`. A torn append or
 * a compaction racing an append can, at worst, drop a line or a just-appended op; both are survivable
 * by the same construction as the crash case above, so this file does not need the coordination its
 * source of truth (`todos.json`) does.
 */

export function opLogPath(dataDir: string): string {
  return join(dataDir, 'cluster', 'ops.ndjson');
}

function serializeOps(ops: readonly ClusterOp[]): string {
  return ops.map((op) => `${JSON.stringify(op)}\n`).join('');
}

function reportDrop(path: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`[cez] failed to write the cluster op log ${path} — ops are still derivable on next scan (${message})`);
}

/** Append-only, creating the directory on demand. A failure here is warned and swallowed: the ops
 *  are still derivable, so an unwritable log degrades the cockpit to a slower flush, never to a
 *  lost mutation. */
export async function appendOps(dataDir: string, ops: readonly ClusterOp[]): Promise<void> {
  if (ops.length === 0) return;
  const path = opLogPath(dataDir);
  try {
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await fs.appendFile(path, serializeOps(ops), { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    reportDrop(path, err);
  }
}

/** Per-entry salvage, and a missing file reads as empty — a node that has never flushed is not an
 *  error state. */
export async function readOps(dataDir: string): Promise<SalvagedOps> {
  const path = opLogPath(dataDir);
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch {
    return { ops: [], dropped: 0 };
  }

  const lines = raw.split('\n').filter((line) => line.trim() !== '');
  const entries: unknown[] = [];
  let parseFailures = 0;
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      parseFailures += 1;
    }
  }

  const salvaged = salvageOps(entries);
  const dropped = salvaged.dropped + parseFailures;
  if (dropped > 0) {
    console.warn(
      `[cez] dropped ${dropped} corrupt entr${dropped === 1 ? 'y' : 'ies'} from the cluster op log ${path} — every other entry survives`,
    );
  }
  return { ops: salvaged.ops, dropped };
}

/** tmp+rename rewrite of the whole log, so a crash mid-write leaves the previous log intact rather
 *  than a truncated one. Shared by `compactOpLog` and `truncateOpLog`. */
async function writeOpLogAtomic(dataDir: string, ops: readonly ClusterOp[]): Promise<void> {
  const path = opLogPath(dataDir);
  const tmp = `${path}.tmp`;
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await fs.writeFile(tmp, serializeOps(ops), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmp, path);
}

export interface CompactOpLogResult {
  kept: number;
  removed: number;
}

/** Rewrites the log through `compactOps`, tmp+rename so a crash mid-compaction leaves the previous
 *  log intact rather than a truncated one. */
export async function compactOpLog(dataDir: string, input: CompactOpsInput): Promise<CompactOpLogResult> {
  const { ops } = await readOps(dataDir);
  const compacted = compactOps(ops, input);
  await writeOpLogAtomic(dataDir, compacted);
  return { kept: compacted.length, removed: ops.length - compacted.length };
}

/** Used after a full re-derive, when the log is known to be strictly redundant. */
export async function truncateOpLog(dataDir: string): Promise<void> {
  await writeOpLogAtomic(dataDir, []);
}
