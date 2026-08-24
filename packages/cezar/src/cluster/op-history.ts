import { closeSync, mkdirSync, openSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import { join } from 'node:path';
import { clusterAckResultSchema, type ClusterAckResult } from '@loki-labs/better-cezar-contract';
import { clusterHomeDir, type ClusterHomeOptions } from './node-identity.ts';
import { atomicWriteJsonSync } from '../workspace/config.ts';
import { assertCezarHomeWriteIsSandboxed } from '../paths.ts';

/**
 * The hub's durable per-`opId` verdict cache — `cluster/hub-ops.ts#HubOpsDeps`'s `findAppliedOp` /
 * `recordAppliedOp` (`.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, "What remains" →
 * Milestone B, D4 · D9a). `hub-ops.ts`'s own module docblock, "Idempotence", is the reason this
 * file exists: the contract's own doc says a dropped frame "costs a retransmit and never a gap",
 * so the SAME `ops` frame can arrive twice — once, acked, with the ack then lost in transit, and
 * again when the spoke's outbox retries after a timeout. Re-running `allocateSeq` + `applyOp` for
 * an already-resolved `opId` burns a second `hubSeq` for one op, and for a D9a claim op
 * specifically, the SECOND application sees the FIRST one's own effect already in place and
 * reports a false conflict — "someone else already claimed this," where the someone is itself.
 * `findAppliedOp`/`recordAppliedOp` are what let `applyOpsFrame` answer a replay from cache instead
 * of re-applying, and **must be backed by durable storage, not an in-memory `Map`** — the hub
 * blue-green deploys roughly ten times a day, so an in-process cache would silently stop working on
 * every deploy and reopen exactly the bug this file exists to close.
 *
 * **The interface actually implemented here is narrower than `hub-ops.ts`'s own `HubOpOutcome`
 * (`{ accepted; fields?; reason? }`).** `HubOpsDeps.findAppliedOp` / `recordAppliedOp`, read off the
 * type on disk, traffic in `ClusterAckResult` (`{ opId, hubSeq, accepted, fields?, reason? }` — the
 * contract's own wire ack shape, `contract/src/cluster.ts#clusterAckResultSchema`), not
 * `HubOpOutcome`. `find`/`record` below are typed to match that exactly, so a caller can hand this
 * store's methods straight to `HubOpsDeps` with no adapter — `deps.findAppliedOp = store.find` and
 * `deps.recordAppliedOp = store.record` both type-check as-is. Any retention/audit metadata this
 * file needs (below) is kept out of that public shape rather than added to it, specifically so this
 * stays a drop-in.
 *
 * ---
 *
 * ### Corruption — decided independently from `hub-seq.ts`, not copied
 *
 * `hub-seq.ts` (this store's closest sibling and the model for the lease/lock idiom below) fails
 * EVERY read and write closed the moment its store is untrustworthy, because for a monotonic
 * counter "empty" and "corrupt" read identically and a wrong read there means REUSING a `hubSeq`
 * that already names a real op. That exact hazard applies to `find()` here too, for the same
 * reason: a `find(opId)` that answers `undefined` for an entry it merely failed to parse is
 * indistinguishable from a genuinely fresh `opId`, and `applyOpsFrame` treats that answer as license
 * to allocate a new `hubSeq` and re-apply — the identical double-application / false-conflict bug.
 * So `find()` inherits `hub-seq.ts`'s two-tier fail-closed shape verbatim:
 *
 *  - **Whole-file corrupt** (unparseable JSON, or `entries` is not a plain object) poisons every
 *    key — `find()` throws for ANY `opId`, seen before or not, until the file is repaired.
 *  - **One poisoned entry** (parses, but `at` is not a real date or `result` fails
 *    `clusterAckResultSchema`) poisons only that `opId` — `find()` throws for that key alone; every
 *    other key keeps answering normally. A write that touches a *different* key preserves the
 *    poisoned entry byte-for-byte rather than healing it back to absent (which would read as "never
 *    recorded" on the next read and reopen the same hole).
 *
 * **Where this file DIVERGES on purpose: `record()` does not inherit that gate.** `hub-seq.ts`'s
 * `assertKeyReadable` runs before every write too, because `allocate()` has to READ the poisoned
 * counter's current value to compute the next one — there is no way to advance a number without
 * trusting the number it starts from. `record()` here has no such dependency: it is handed a
 * complete, already-decided `ClusterAckResult` and wholesale REPLACES whatever was stored for that
 * `opId`, poisoned or not. Refusing that write would only prolong a corruption with no correctness
 * benefit, and would remove the one path — short of hand-editing the file — that can ever un-poison
 * an entry. So a poisoned `opId` stays refused for `find()` (and therefore keeps `applyOpsFrame`
 * from ever fabricating a verdict for it) right up until a fresh `record()` for that same `opId`
 * overwrites it, at which point it reads normally again. Only whole-file corruption still refuses
 * `record()` — merging a new key into a file that cannot be parsed at all would silently discard
 * every OTHER entry in it, which is a much larger loss than leaving one key poisoned.
 *
 * `prune()` (below) gets its own, third answer for the same question — see "Retention".
 *
 * ### Retention — the constant, and the trade it is not allowed to get wrong
 *
 * An unbounded cache of every `opId` this hub has ever seen grows forever, so `prune()` drops
 * entries older than `OP_HISTORY_RETENTION_MS`. **Pruning too aggressively reintroduces the exact
 * bug this store exists to prevent**: if a legitimate retransmit for `opId` X arrives after X's
 * entry has been pruned, `find(X)` answers `undefined` — indistinguishable from "genuinely new" —
 * and `applyOpsFrame` re-applies it, which is precisely the double-application / false-conflict
 * failure the whole module (`hub-ops.ts`'s own docblock) is written to close. So the window has to
 * comfortably outlast any plausible legitimate retransmit gap, not merely the common case.
 *
 * The gap that matters is not "how long can a spoke stay offline" — an `opId` never sent before is
 * correctly treated as fresh no matter how long the wait, cache or no cache. The gap that matters is
 * narrower and nastier: a spoke can receive the hub's `ack` over the wire and then crash **before**
 * durably marking that op settled in its own outbox. On restart it has no memory of having been
 * acked, so it retransmits the same frame — and that restart can happen an arbitrarily long time
 * later, bounded by nothing today. Milestone B's own "What remains" table lists "outbox flush
 * scheduling" as a genuinely missing design, not a built-and-tunable backoff, so there is no
 * existing retry cadence to size this against; retention has to assume the worst case (a node down
 * for an extended stretch — a crashed process, a laptop closed for a trip) rather than a specific
 * expected backoff.
 *
 * 30 days. Matches this codebase's own precedent for a month-scale durability window
 * (`auth/session.ts#DEFAULT_TTL_MS`, `auth/invite-routes.ts#MAX_INVITE_TTL_MS`, both
 * `30 * 24 * 60 * 60 * 1000`) — comfortably wider than `notifications/outbox.ts#RETENTION_MS`'s
 * 7-day window for the nearest sibling concept (a delivery-retry record), because that outbox is
 * bounded by its OWN transport's bounded backoff and this store is not: nothing bounds how long a
 * disconnected spoke may legitimately still be trying to resend.
 *
 * A poisoned entry's age cannot be trusted (its `at` may itself be the corrupt part), so `prune()`
 * leaves a poisoned entry untouched — neither removed nor thrown on — rather than guessing at its
 * age or letting one bad entry abort a sweep that could otherwise clear every healthy expired one.
 * Whole-file corruption still refuses the whole `prune()` call, matching `find()`/`record()`.
 *
 * ### Crash ordering — `record()` relative to its caller, which cannot be changed
 *
 * `hub-ops.ts#applyOpsFrame` calls `deps.applyOp(...)` (mutating the hub's OWN entity store —
 * `todos.ts` etc., a file this module has no access to and does not own) and only THEN calls
 * `deps.recordAppliedOp(opId, result)` with the outcome — there is no other order it could be in,
 * since the verdict recorded here does not exist until `applyOp` returns it. This file cannot
 * change that; the only thing under its control is what happens if the process dies in the gap
 * between the two, and how narrow that gap is made.
 *
 * `record()` itself is a single atomic write (`atomicWriteJsonSync`'s tmp-then-rename, under the
 * lease below) — a crash mid-`record()` leaves the OLD file intact, never a torn one. So the actual
 * residual risk is entirely the window BETWEEN `applyOp` returning and `record()`'s write landing:
 *
 *  - **A crash in that window** (the order this caller actually uses) leaves the real entity store
 *    already mutated but this cache still missing the verdict. On replay, `find()` misses, the op is
 *    treated as fresh, and it is re-applied. For a plain field-set this is typically a harmless
 *    repeat of an idempotent write; for a D9a claim specifically, the SAME node's own second
 *    application meets its own first effect and gets back a false "already claimed" rejection. That
 *    is a functional bug, but a SAFE one: per D9a's own text, a lost/rejected claim just leaves the
 *    todo visibly pending, to be retried on the next pass — the exact failure shape D9a already
 *    prefers over its alternative.
 *  - **The opposite order — recording a verdict before the op is actually applied** — is not one
 *    this module's real caller uses, but is worth ruling out explicitly, because it is strictly
 *    worse: a crash in ITS gap would leave a durable, cached "resolved" verdict for an op that was
 *    NEVER actually applied to the entity store. Every future replay would then answer from cache
 *    and skip applying it forever — silent, permanent data loss with no retry path, not a safe,
 *    visible "stays pending."
 *
 * So the residual risk of the order this file is actually called in falls the SAFE way — toward a
 * spurious retry rather than toward silently losing a write — and that direction is a property of
 * the caller's ordering, not of anything tunable here. What this file owns is keeping its own half
 * of that gap (the `record()` write itself) as small and as atomic as one `rename(2)` allows.
 */

const OP_HISTORY_FILE = 'op-history.json';
const OP_HISTORY_LOCK_FILE = 'op-history.lock';
const MAX_RETRY_DELAY_MS = 200;
const DEFAULT_STALE_AFTER_MS = 10 * 60_000;
const DEFAULT_LEASE_TIMEOUT_MS = 5_000;

/** How long a resolved op's verdict is kept before `prune()` may drop it — see module docblock
 *  "Retention" for why 30 days and not `notifications/outbox.ts`'s 7. */
export const OP_HISTORY_RETENTION_MS = 30 * 24 * 60 * 60_000;

/**
 * The sweep cadence `server/cluster-routes.ts#startClusterRuntime`'s hub branch arms `prune()` on.
 * An entry can outlive `OP_HISTORY_RETENTION_MS` by at most this much (residency overshoot, not a
 * second retention window) — 24h costs 3.3% overshoot for one lock cycle/day, against 0.14% for an
 * hourly sweep at 24x the lock traffic on the same file `record()` needs on the hot path. See
 * `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`'s B2a recon for the full table. Additive: this
 * constant has no effect until something calls `prune()` on a timer.
 */
export const OP_HISTORY_PRUNE_INTERVAL_MS = 24 * 60 * 60_000;

export function opHistoryPath(env?: NodeJS.ProcessEnv): string {
  return join(clusterHomeDir(env), OP_HISTORY_FILE);
}

function resolveWarn(options?: ClusterHomeOptions): (message: string) => void {
  return options?.warn ?? ((message: string) => console.warn(message));
}

function resolveNow(options?: ClusterHomeOptions): () => Date {
  return options?.now ?? (() => new Date());
}

export interface OpHistoryStore {
  /** The durable verdict on file for `opId`, or `undefined` when genuinely never resolved. THROWS
   *  when the entry (or the whole store) is corrupt — see module docblock "Corruption": answering
   *  `undefined` for a corrupt entry would read exactly like "never applied" and let a caller
   *  re-derive a false verdict for an op this hub already decided. */
  find(opId: string): Promise<ClusterAckResult | undefined>;
  /** Persists `result` for `opId`, wholesale-replacing whatever was stored — including a poisoned
   *  entry (see module docblock "Corruption" for why that is safe here, unlike `hub-seq.ts`).
   *  THROWS only when the whole file is unparseable; never for an unrelated sibling entry. */
  record(opId: string, result: ClusterAckResult): Promise<void>;
  /** Drops every entry recorded more than `OP_HISTORY_RETENTION_MS` before `now` (default: the
   *  real clock, or `options.now`). Returns the count removed. A poisoned entry is left untouched
   *  — its age cannot be trusted — rather than removed or thrown on; whole-file corruption still
   *  throws, matching `find`/`record`. */
  prune(now?: Date): Promise<number>;
}

interface StoredEntry {
  readonly at: string;
  readonly result: ClusterAckResult;
}

function decodeEntry(value: unknown): StoredEntry | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const at = (value as { at?: unknown }).at;
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) return undefined;
  const parsed = clusterAckResultSchema.safeParse((value as { result?: unknown }).result);
  if (!parsed.success) return undefined;
  return { at, result: parsed.data };
}

interface OpHistoryFileState {
  /** The file exists but could not be parsed as `{ entries: {...} }` at all — every key is
   *  untrustworthy, not only the ones a caller happens to ask about. */
  wholeFileCorrupt: boolean;
  /** The `entries` object exactly as parsed, poisoned entries included verbatim — see module
   *  docblock "Corruption" for why a poisoned entry is never dropped on someone else's write. */
  raw: Record<string, unknown>;
  poisonedKeys: ReadonlySet<string>;
}

async function readOpHistoryFile(path: string, warn: (message: string) => void): Promise<OpHistoryFileState> {
  // `fs.promises.readFile`, not the sync form — deliberately, matching `hub-seq.ts#readHubSeqFile`.
  // This is the one genuine `await` in the read-modify-write cycle: it is what lets two concurrent
  // `record()` calls actually INTERLEAVE within one process rather than each running to completion
  // synchronously before the next begins (a function body with no internal `await` runs atomically
  // from Node's point of view, lock or no lock — a sync read here would make the concurrency
  // guarantee untestable in-process, not merely untested). The lock's own acquisition stays
  // synchronous (`openSync('wx', ...)`, below) because ITS atomicity has to come from the OS
  // primitive, not from the absence of an await point.
  let text: string;
  try {
    text = await fsPromises.readFile(path, 'utf8');
  } catch {
    return { wholeFileCorrupt: false, raw: {}, poisonedKeys: new Set() }; // no file yet — nothing recorded
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    warn(
      `[cez] cluster op-history store ${path} is not valid JSON — refusing to answer ANY lookup until it is repaired ` +
        `(an "empty" answer here would let the hub re-apply an already-resolved op)`,
    );
    return { wholeFileCorrupt: true, raw: {}, poisonedKeys: new Set() };
  }
  const entries = (parsed as { entries?: unknown } | null)?.entries;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    warn(`[cez] cluster op-history store ${path} has an unexpected shape — refusing to answer ANY lookup until it is repaired`);
    return { wholeFileCorrupt: true, raw: {}, poisonedKeys: new Set() };
  }
  const raw = entries as Record<string, unknown>;
  const poisonedKeys = new Set<string>();
  for (const [opId, value] of Object.entries(raw)) {
    if (!decodeEntry(value)) {
      poisonedKeys.add(opId);
      warn(
        `[cez] cluster op-history store ${path} — the entry for opId "${opId}" is unreadable; refusing to answer for it ` +
          `until it is repaired by hand or overwritten by a fresh record()`,
      );
    }
  }
  return { wholeFileCorrupt: false, raw, poisonedKeys };
}

// ---- cross-process write lease — the `todos.ts#acquireTodosLease` `O_EXCL` idiom, restated for
// this store rather than shared with any sibling (same reasoning as `hub-seq.ts`'s own dedicated
// lock: nothing about op-history shares state with enrollment, node secrets, or hub-seq) ----------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class OpHistoryLease {
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

/** One non-blocking attempt: open `wx` (fails if the lock file already exists), reclaim it if it
 *  has sat stale past `staleAfterMs` (a crashed writer), else give up. */
function acquireOpHistoryLease(dir: string, lockPath: string, staleAfterMs = DEFAULT_STALE_AFTER_MS): OpHistoryLease | undefined {
  assertCezarHomeWriteIsSandboxed(lockPath);
  mkdirSync(dir, { recursive: true });
  try {
    const fd = openSync(lockPath, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return new OpHistoryLease(lockPath, fd);
  } catch {
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > staleAfterMs) {
        unlinkSync(lockPath);
        return acquireOpHistoryLease(dir, lockPath, staleAfterMs);
      }
    } catch {
      // A contender released it first, or the directory is read-only.
    }
    return undefined;
  }
}

async function acquireOpHistoryLeaseBlocking(dir: string, lockPath: string, timeoutMs = DEFAULT_LEASE_TIMEOUT_MS): Promise<OpHistoryLease> {
  const deadline = Date.now() + timeoutMs;
  let delay = 10;
  for (;;) {
    const lease = acquireOpHistoryLease(dir, lockPath);
    if (lease) return lease;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`cluster op-history: write lease on ${lockPath} stayed held for over ${timeoutMs}ms — another writer may be stuck`);
    }
    await sleep(Math.min(delay, remaining));
    delay = Math.min(delay * 2, MAX_RETRY_DELAY_MS);
  }
}

async function withOpHistoryLease<T>(dir: string, lockPath: string, fn: () => Promise<T>): Promise<T> {
  const lease = await acquireOpHistoryLeaseBlocking(dir, lockPath);
  try {
    return await fn();
  } finally {
    lease.release();
  }
}

/** Builds a store bound to one `ClusterHomeOptions` bag (env, for tests; now, for the retention
 *  clock; warn, for the one-line degrade). Stateless across calls beyond the file itself — a fresh
 *  store built against the same home sees exactly what the last one wrote, which is what makes this
 *  safe across the hub's ~10x/day blue-green restart (see module docblock). */
export function createOpHistoryStore(options?: ClusterHomeOptions): OpHistoryStore {
  const warn = resolveWarn(options);
  const now = resolveNow(options);
  const dir = clusterHomeDir(options?.env);
  const path = opHistoryPath(options?.env);
  const lockPath = join(dir, OP_HISTORY_LOCK_FILE);

  return {
    async find(opId) {
      const state = await readOpHistoryFile(path, warn);
      if (state.wholeFileCorrupt) {
        throw new Error(
          `cluster op-history: ${path} is corrupt — refusing to answer any lookup (an "empty" answer would let the hub ` +
            `re-apply an already-resolved op); repair or remove the file by hand`,
        );
      }
      if (state.poisonedKeys.has(opId)) {
        throw new Error(
          `cluster op-history: the stored entry for opId "${opId}" in ${path} is unreadable — refusing to answer for it; ` +
            `repair it by hand, or record() a fresh verdict for it to overwrite the corruption`,
        );
      }
      return decodeEntry(state.raw[opId])?.result;
    },

    async record(opId, result) {
      if (result.opId !== opId) {
        throw new Error(`cluster op-history: record() called with opId "${opId}" but result.opId is "${result.opId}"`);
      }
      await withOpHistoryLease(dir, lockPath, async () => {
        const state = await readOpHistoryFile(path, warn);
        if (state.wholeFileCorrupt) {
          throw new Error(
            `cluster op-history: ${path} is corrupt — refusing to record a new verdict into an unparseable file ` +
              `(merging into it would silently discard every other entry); repair or remove the file by hand`,
          );
        }
        // Wholesale replacement of this one key — even if it was previously poisoned. See module
        // docblock "Corruption" for why that is safe here (this file requires no old value to
        // compute the new one) and is NOT `hub-seq.ts`'s stance for its counters (which do).
        const entry: StoredEntry = { at: now().toISOString(), result };
        const nextRaw = { ...state.raw, [opId]: entry };
        atomicWriteJsonSync(path, { entries: nextRaw });
      });
    },

    async prune(pruneAt) {
      const cutoff = (pruneAt ?? now()).getTime() - OP_HISTORY_RETENTION_MS;
      return withOpHistoryLease(dir, lockPath, async () => {
        const state = await readOpHistoryFile(path, warn);
        if (state.wholeFileCorrupt) {
          throw new Error(`cluster op-history: ${path} is corrupt — refusing to prune an unparseable file; repair or remove the file by hand`);
        }
        let removed = 0;
        const nextRaw: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(state.raw)) {
          if (state.poisonedKeys.has(key)) {
            // Cannot trust its age — leave it exactly where it is (module docblock "Retention").
            nextRaw[key] = value;
            continue;
          }
          const entry = decodeEntry(value)!;
          if (Date.parse(entry.at) < cutoff) {
            removed++;
            continue;
          }
          nextRaw[key] = value;
        }
        if (removed > 0) atomicWriteJsonSync(path, { entries: nextRaw });
        return removed;
      });
    },
  };
}
