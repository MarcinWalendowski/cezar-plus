import { closeSync, mkdirSync, openSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import { join } from 'node:path';
import type { ClusterOpScope, ClusterProjectKey } from '@loki-labs/better-cezar-contract';
import { clusterHomeDir, type ClusterHomeOptions } from './node-identity.ts';
import { atomicWriteJsonSync } from '../workspace/config.ts';
import { assertCezarHomeWriteIsSandboxed } from '../paths.ts';

/**
 * The hub's own monotonic order — `hubSeq` (D4) of `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`
 * — allocated and persisted. Milestone B's own table (spec → "What remains", "Milestone B") lists
 * this as **the one genuinely missing design**, not missing wiring: `clusterHubSeqSchema` defines the
 * shape, `todos.ts` stores it, `replica.ts` sorts and dedupes by it, `reconcile.ts#classify` uses it
 * to tell "never seen the hub" from "seen and diverged" — and until this file, nothing anywhere
 * produced one. This file is that allocator: `HubSeqAllocator`, built by `createHubSeqAllocator`.
 *
 * **Keying: `scope` AND `projectKey` together, not `scope` alone.** Ordering is tracked per
 * `(scope, projectKey)` pair everywhere downstream — `clusterWatermarkSchema`'s
 * `appliedThroughHubSeq`/`ackedThroughHubSeq` are scoped the same way — so this allocator hands out
 * one independent monotonic sequence per pair, not one global counter shared by every project.
 * `scope: 'project'` with no `projectKey` is a caller error (there is no project to key the counter
 * by) and `allocate`/`current` throw rather than silently keying on an empty string, which would
 * merge every caller who forgot the field into one counter. `scope: 'workspace'` ignores any
 * `projectKey` a caller happens to pass: workspace-scoped ops apply to the node's workspace-wide
 * state (not to one project), so there is exactly one workspace counter, and treating a stray
 * `projectKey` as a further partition would let two workspace-scope callers that disagree about
 * `projectKey` silently draw from two different sequences for what is meant to be one order.
 *
 * **Persistence: one file, one lock, matching `leases.ts` rather than `allocate.ts`.** Both siblings
 * store many independently-keyed rows and both use the `O_EXCL` write-lease idiom
 * (`todos.ts#acquireTodosLease`'s own pattern, restated here) — the difference between them is what
 * they store per key. `allocate.ts` gives each `kind` its OWN file because a kind grows an
 * append-only ledger, and its `kind` is contract-validated to a filename-safe pattern
 * (`^[a-z0-9][a-z0-9-]{0,31}$`) specifically so it is safe to use as one. Neither is true here: a
 * `hubSeq` key holds a single integer that is simply overwritten, never a growing ledger, and
 * `ClusterProjectKey` (`z.string().min(1).max(64)`) carries no such filename-safety guarantee — using
 * it directly as a filename would require inventing a sanitisation scheme the contract does not
 * define. `leases.ts` already solved exactly this shape of problem (many `(kind, id)` keys, one
 * store, one lock) for its own rows, so this file follows it: `<clusterHomeDir>/hub-seq.json` holding
 * `{ counters: Record<string, number> }`, one dedicated `hub-seq.lock`.
 *
 * **Why a DEDICATED lock rather than `enrollment.ts`'s `withEnrollCodesLease`.** `node-secrets.ts`
 * and `peers.ts#disableNode` share that lease deliberately, because they mutate `node-secrets.json`
 * and `enroll-codes.json` in the same crash-safe ordering (D22) — the lease exists to serialize
 * writers of THOSE two files against each other. `hub-seq.json` shares no state with either: nothing
 * about enrollment reads or writes a `hubSeq` counter, and nothing about `hubSeq` allocation touches
 * a node secret or an enrollment code. There is therefore no "two locks racing over the same
 * resource" risk in giving this file its own lock — that risk only exists when two locks both guard
 * access to one piece of state, which is not the case here. And reusing the enroll-codes lease would
 * be actively worse than not sharing: enrollment is a rare, human-paced operation (minting or
 * redeeming a join code happens once per node, ever), while `hubSeq` allocation is expected to be a
 * HOT path — every op frame the hub applies, from every connected spoke, needs a range. Coupling the
 * two would make ordinary write throughput a function of enrollment activity and vice versa, for no
 * correctness benefit. `leases.ts` made the identical call for the identical reason (its own module
 * docblock: "Do not re-introduce a `claim` kind here" is the same "do not conflate unrelated locks"
 * principle from the other direction) — one dedicated lock per independent store is this directory's
 * established pattern, not one shared global lock.
 *
 * **Corruption: fail closed, and this is where this file MUST diverge from every sibling store.**
 * `node-secrets.ts`, `leases.ts` and `allocate.ts` all degrade a corrupt file to *empty* with one
 * warning, because for each of them "empty" is a safe, honest answer — no secrets stored, nothing
 * held, nothing allocated yet. For `hub-seq.json`, "empty" is NOT a safe answer for a key that was
 * previously written: it reads identically to "never allocated," so the next `allocate` call would
 * start back at 1 and hand out a number that already names a real op. That is the one failure mode
 * D4/D9a's whole design depends on never happening — two ops sharing one `hubSeq` makes
 * `replica.ts`'s dedupe silently drop a real change. So a corrupt store here REFUSES rather than
 * resets: a file that fails to parse, or whose `counters` field is not a plain object, poisons every
 * key (`allocate`/`current` throw for anything); a single entry whose value is not a non-negative
 * integer poisons only that key, and is preserved VERBATIM on every subsequent write of a sibling key
 * — dropping it instead (the per-entry "salvage" every sibling store performs) would silently heal it
 * back to "absent," which reads as 0 on the next read, which is exactly the reuse this file exists to
 * prevent. A poisoned key stays poisoned until a human repairs or removes the entry by hand.
 *
 * **`count: 0` is a no-op** (per the contract this file implements): it takes no lock, touches no
 * counter, and returns the empty range `{ from: base + 1, to: base }` — `to < from` is the signal
 * that nothing was reserved, matching an empty half-open-turned-inclusive slice. Do not read
 * `from`/`to` as a single reserved number in that case; nothing was reserved.
 */

const HUB_SEQ_FILE = 'hub-seq.json';
const HUB_SEQ_LOCK_FILE = 'hub-seq.lock';
const MAX_RETRY_DELAY_MS = 200;
const DEFAULT_STALE_AFTER_MS = 10 * 60_000;
const DEFAULT_LEASE_TIMEOUT_MS = 5_000;

export interface HubSeqAllocator {
  /** Reserves `count` consecutive numbers and returns the FIRST and LAST inclusive. Never returns a
   *  number twice, across restarts. `count: 0` is a no-op — see module docblock. */
  allocate(input: { scope: ClusterOpScope; projectKey?: ClusterProjectKey; count: number }): Promise<{ from: number; to: number }>;
  /** The highest number handed out so far for that key; 0 when none ever was. */
  current(input: { scope: ClusterOpScope; projectKey?: ClusterProjectKey }): Promise<number>;
}

export function hubSeqPath(env?: NodeJS.ProcessEnv): string {
  return join(clusterHomeDir(env), HUB_SEQ_FILE);
}

function resolveWarn(options?: ClusterHomeOptions): (message: string) => void {
  return options?.warn ?? ((message: string) => console.warn(message));
}

/** The counter key a `(scope, projectKey)` pair resolves to — see module docblock "Keying". Throws
 *  for `scope: 'project'` with no `projectKey`, which is a caller error, not a state to represent. */
function counterKey(input: { scope: ClusterOpScope; projectKey?: ClusterProjectKey }): string {
  if (input.scope === 'project') {
    if (!input.projectKey) {
      throw new Error(
        'cluster hub-seq: scope "project" requires a projectKey — there is no project to key the counter by',
      );
    }
    return `project:${input.projectKey}`;
  }
  return 'workspace';
}

interface HubSeqFileState {
  /** The file exists but could not be parsed as `{ counters: {...} }` at all — every key is
   *  untrustworthy, not only the ones a caller happens to ask about. */
  wholeFileCorrupt: boolean;
  /** The `counters` object exactly as parsed, poisoned entries included verbatim — see module
   *  docblock "Corruption" for why a poisoned entry is never dropped. */
  raw: Record<string, unknown>;
  poisonedKeys: ReadonlySet<string>;
}

async function readHubSeqFile(path: string, warn: (message: string) => void): Promise<HubSeqFileState> {
  // `fs.promises.readFile`, not the sync form — deliberately, matching `leases.ts#readLeasesFile`.
  // This is the one genuine `await` in the read-modify-write cycle: it is what lets two concurrent
  // `allocate` calls actually INTERLEAVE within one process rather than each running to completion
  // synchronously before the next begins (a function body with no internal `await` runs atomically
  // from Node's point of view, lock or no lock — a sync read here would make the concurrency
  // guarantee untestable in-process, not merely untested). The lock's own acquisition stays
  // synchronous (`openSync('wx', ...)`, below) because ITS atomicity has to come from the OS
  // primitive, not from the absence of an await point.
  let text: string;
  try {
    text = await fsPromises.readFile(path, 'utf8');
  } catch {
    return { wholeFileCorrupt: false, raw: {}, poisonedKeys: new Set() }; // no file yet — nothing allocated
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    warn(
      `[cez] cluster hub-seq store ${path} is not valid JSON — refusing to allocate or report ANY counter until it is repaired (never restarting a monotonic counter from 0)`,
    );
    return { wholeFileCorrupt: true, raw: {}, poisonedKeys: new Set() };
  }
  const counters = (parsed as { counters?: unknown } | null)?.counters;
  if (!counters || typeof counters !== 'object' || Array.isArray(counters)) {
    warn(
      `[cez] cluster hub-seq store ${path} has an unexpected shape — refusing to allocate or report ANY counter until it is repaired (never restarting a monotonic counter from 0)`,
    );
    return { wholeFileCorrupt: true, raw: {}, poisonedKeys: new Set() };
  }
  const raw = counters as Record<string, unknown>;
  const poisonedKeys = new Set<string>();
  for (const [key, value] of Object.entries(raw)) {
    if (!(typeof value === 'number' && Number.isInteger(value) && value >= 0)) {
      poisonedKeys.add(key);
      warn(
        `[cez] cluster hub-seq store ${path} — the counter for "${key}" is unreadable; refusing to allocate or report it (never restarting a monotonic counter from 0)`,
      );
    }
  }
  return { wholeFileCorrupt: false, raw, poisonedKeys };
}

/** Throws unless `key` can be trusted — see module docblock "Corruption". Called before EVERY read
 *  or write of a counter, so a poisoned or corrupt store fails closed rather than reusing a number. */
function assertKeyReadable(state: HubSeqFileState, key: string, path: string): void {
  if (state.wholeFileCorrupt) {
    throw new Error(
      `cluster hub-seq: ${path} is corrupt — refusing to allocate or report any counter (never restarting a monotonic counter from 0); repair or remove the file by hand`,
    );
  }
  if (state.poisonedKeys.has(key)) {
    throw new Error(
      `cluster hub-seq: the stored counter for "${key}" in ${path} is unreadable — refusing to allocate or report it (never restarting a monotonic counter from 0); repair or remove the entry by hand`,
    );
  }
}

function baseValue(state: HubSeqFileState, key: string): number {
  const value = state.raw[key];
  return typeof value === 'number' ? value : 0;
}

// ---- cross-process write lease — the `todos.ts#acquireTodosLease` `O_EXCL` idiom, restated for
// this store rather than shared with `enrollment.ts`'s (see module docblock) ----------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class HubSeqLease {
  private released = false;
  constructor(
    private readonly path: string,
    private readonly fd: number,
  ) {}
  release(): void {
    if (this.released) return;
    this.released = true;
    closeSync(this.fd);
    try {
      unlinkSync(this.path);
    } catch {
      // Already removed during shutdown cleanup.
    }
  }
}

/** One non-blocking attempt: open `wx` (fails if the lock file already exists), reclaim it if it has
 *  sat stale past `staleAfterMs` (a crashed writer), else give up. */
function acquireHubSeqLease(dir: string, lockPath: string, staleAfterMs = DEFAULT_STALE_AFTER_MS): HubSeqLease | undefined {
  assertCezarHomeWriteIsSandboxed(lockPath);
  mkdirSync(dir, { recursive: true });
  try {
    const fd = openSync(lockPath, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return new HubSeqLease(lockPath, fd);
  } catch {
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > staleAfterMs) {
        unlinkSync(lockPath);
        return acquireHubSeqLease(dir, lockPath, staleAfterMs);
      }
    } catch {
      // A contender released it first, or the directory is read-only.
    }
    return undefined;
  }
}

async function acquireHubSeqLeaseBlocking(dir: string, lockPath: string, timeoutMs = DEFAULT_LEASE_TIMEOUT_MS): Promise<HubSeqLease> {
  const deadline = Date.now() + timeoutMs;
  let delay = 10;
  for (;;) {
    const lease = acquireHubSeqLease(dir, lockPath);
    if (lease) return lease;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`cluster hub-seq: write lease on ${lockPath} stayed held for over ${timeoutMs}ms — another writer may be stuck`);
    }
    await sleep(Math.min(delay, remaining));
    delay = Math.min(delay * 2, MAX_RETRY_DELAY_MS);
  }
}

async function withHubSeqLease<T>(dir: string, lockPath: string, fn: () => Promise<T>): Promise<T> {
  const lease = await acquireHubSeqLeaseBlocking(dir, lockPath);
  try {
    return await fn();
  } finally {
    lease.release();
  }
}

/** Builds an allocator bound to one `ClusterHomeOptions` bag (env, for tests; warn, for the
 *  one-line degrade). Stateless across calls beyond the file itself — a fresh allocator built
 *  against the same home continues exactly where the last one left off, which is what makes this
 *  safe across the hub's ~10x/day blue-green restart (see module docblock). */
export function createHubSeqAllocator(options?: ClusterHomeOptions): HubSeqAllocator {
  const warn = resolveWarn(options);
  const dir = clusterHomeDir(options?.env);
  const path = hubSeqPath(options?.env);
  const lockPath = join(dir, HUB_SEQ_LOCK_FILE);

  return {
    async allocate(input) {
      const key = counterKey(input);
      if (!Number.isInteger(input.count) || input.count < 0) {
        throw new Error(`cluster hub-seq: count must be a non-negative integer, got ${input.count}`);
      }
      if (input.count === 0) {
        // No-op: no lock taken, no counter touched. See module docblock for the empty-range
        // convention (`to < from`) this returns.
        const state = await readHubSeqFile(path, warn);
        assertKeyReadable(state, key, path);
        const base = baseValue(state, key);
        return { from: base + 1, to: base };
      }
      return withHubSeqLease(dir, lockPath, async () => {
        const state = await readHubSeqFile(path, warn);
        assertKeyReadable(state, key, path);
        const base = baseValue(state, key);
        const to = base + input.count;
        const nextRaw = { ...state.raw, [key]: to };
        atomicWriteJsonSync(path, { counters: nextRaw });
        return { from: base + 1, to };
      });
    },
    async current(input) {
      const key = counterKey(input);
      const state = await readHubSeqFile(path, warn);
      assertKeyReadable(state, key, path);
      return baseValue(state, key);
    },
  };
}
