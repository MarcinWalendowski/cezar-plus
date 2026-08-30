import { promises as fs } from 'node:fs';
import { closeSync, mkdirSync, openSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  storedClusterLeaseSchema,
  type ClusterLease,
  type ClusterLeaseKind,
  type ClusterLeaseRequest,
  type ClusterLeaseResponse,
  type ClusterNodeId,
  type StoredClusterLease,
} from '@loki-labs/cezar-plus-contract';
import { atomicWriteJsonSync } from '../workspace/config.ts';
import { clusterHomeDir, type ClusterHomeOptions } from './node-identity.ts';

/**
 * Hub-side leases with TTL and renew, for what genuinely guards a **resource** rather than a record
 * (spec `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, D14 · D15b; PLAN 3.1).
 *
 * **A claim is not a lease any more, and that removal is the point.** Under the superseded D4 a run
 * claim was a TTL lease, which meant a reclaimable lease had to be paired with a durable replicated
 * stamp so a blue-green hub restart could not hand the same claim to two nodes. D4/D9a collapsed the
 * two: the hub applies the claim op or it does not, and its acknowledgement IS the stamp. There is
 * no second holder to race and no window between acquiring and stamping — which was the window the
 * lease existed to close. Do not re-introduce a `claim` kind here.
 *
 * What is left is genuinely about a shared resource: an **account** grant (subscription spend, not
 * host capacity — the two are separate bounds and each refusal names which), **usage aggregation**,
 * a cluster-wide **limit hold**, and the **scheduler** ticks that create work or write shared state.
 *
 * **Persisted, because the hub restarts ~10 times a day** (D15b). Blue-green self-deploy is the
 * NORMAL operation of the hub, measured at ~5 s of outage and five restarts in 51 minutes on a busy
 * day. An in-memory table would be wiped ten times a day, and every wipe is a window in which a
 * spoke re-acquires a lease another node still holds. So leases live in a file store under the
 * `O_EXCL` idiom — the hub is one host, so a local lease is the right primitive there — and a
 * reconnecting spoke **re-asserts** what it holds, which the hub honours when it is the node already
 * recorded as holder.
 *
 * **What a lost store does and does not permit — read this before wiring a caller to it.** Test 10
 * of the spec's Verification section wipes the hub's lease store entirely (rm the file, restart the
 * hub) and requires that a second node still cannot start the SAME run. That guarantee does **not**
 * come from this module for the one case it used to matter for — todo claims are no longer a lease
 * at all (D4/D9a): the hub's linearized ack of the claim op IS the durable key, and it lives in the
 * replicated todo record, not here. So for claims, losing this file changes nothing, because this
 * file was never in that path.
 *
 * For what genuinely does live here (account grants, usage aggregation, limit holds, scheduler
 * ticks), a full store wipe is honestly **not** survivable as uninterrupted mutual exclusion: once
 * the file holding "who holds X" is gone, nothing on disk says X is held, so the next `acquireLease`
 * for X — from any node — is granted as a fresh, first-time acquisition. That is not a bug; it is
 * the structural consequence of the store being the only place the fact lived, and it is why nothing
 * in this design routes an unrecoverable action through a lease that can be wiped. What a wipe IS
 * survivable for: (1) it never wedges or throws — the module degrades to "unheld" and keeps working;
 * (2) `fencingToken` keeps increasing across a wipe (seeded from wall-clock time, not from the row a
 * wipe erases), so a caller that persists the token it was granted can always tell a pre-wipe grant
 * from a post-wipe one and refuse to act on the stale one; and (3) once a SECOND node has legitimately
 * re-acquired a wiped lease, the original holder's `reassertLeases` for it is refused, not silently
 * honoured — a stale holder can never talk its way back over a node that has already, correctly,
 * taken over. Callers that need survival across a wipe with no gap at all (there are none today) must
 * not use this module for that purpose.
 */

/** Renew well before expiry, or a GC pause becomes a lost lease. */
export const DEFAULT_LEASE_TTL_MS = 60_000;

export function leasesPath(env?: NodeJS.ProcessEnv): string {
  return join(clusterHomeDir(env), 'leases.json');
}

// ---- resolved per-call context -------------------------------------------------------------------

interface ResolvedContext {
  now: () => Date;
  warn: (message: string) => void;
  path: string;
  dir: string;
}

function resolveContext(options?: ClusterHomeOptions): ResolvedContext {
  const path = leasesPath(options?.env);
  return {
    now: options?.now ?? (() => new Date()),
    // The default is silent-but-safe: a store degrading to empty must never fail a boot (Data
    // models section), and this module has no logger of its own to reach for. A real caller wires
    // `warn` to its own logging; tests capture it to assert the degrade actually fired.
    warn: options?.warn ?? (() => {}),
    path,
    dir: dirname(path),
  };
}

function toClusterLease(row: StoredClusterLease): ClusterLease {
  return {
    kind: row.kind,
    id: row.id,
    holderNodeId: row.holderNodeId,
    acquiredAt: row.acquiredAt,
    expiresAt: row.expiresAt,
    fencingToken: row.fencingToken,
  };
}

function isLive(row: StoredClusterLease | undefined, nowMs: number): row is StoredClusterLease {
  return row !== undefined && new Date(row.expiresAt).getTime() > nowMs;
}

// ---- monotonic fencing tokens, independent of the store ------------------------------------------

/**
 * A single process-wide monotonic counter, seeded from wall-clock time. Deliberately NOT derived
 * from the row a wipe erases: the whole point of a fencing token is that it survives the amnesia
 * that makes everything else here unreliable. Wall-clock time already trends upward across a real
 * hub restart (real time passes during a restart); the counter is the tie-breaker for two grants
 * inside the same millisecond, which a fast test hits constantly and a real deploy almost never does.
 * One counter for every `(kind, id)` is trivially still monotonic for any one of them — no need to
 * key it.
 */
let fencingCounter = 0;

function nextFencingToken(now: Date): number {
  const candidate = now.getTime();
  fencingCounter = candidate > fencingCounter ? candidate : fencingCounter + 1;
  return fencingCounter;
}

// ---- the store itself: read salvages per-entry, write is atomic tmp+rename at 0600 ---------------

async function readLeasesFile(path: string, warn: (message: string) => void): Promise<StoredClusterLease[]> {
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch {
    return []; // no store yet — nothing is held
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warn(`[cez] cluster leases store at ${path} is not valid JSON — degrading to empty`);
    return [];
  }
  const candidate = parsed as { leases?: unknown };
  const arr = Array.isArray(candidate?.leases) ? candidate.leases : undefined;
  if (!arr) {
    warn(`[cez] cluster leases store at ${path} has an unexpected shape — degrading to empty`);
    return [];
  }
  const rows: StoredClusterLease[] = [];
  for (const entry of arr) {
    const result = storedClusterLeaseSchema.safeParse(entry);
    if (result.success) rows.push(result.data);
    else warn(`[cez] skipping a malformed cluster lease row in ${path}`);
  }
  return rows;
}

/** Atomic tmp+rename at `0600`, `0700` dir, sandboxed-write guard under vitest — the shared writer
 *  `workspace/config.ts` already owns, reused rather than re-implemented (the same reasoning
 *  `node-identity.ts#saveNodeIdentity` gives for itself: one place in the repo that knows how an
 *  atomic write happens). */
function writeLeasesFile(path: string, rows: StoredClusterLease[]): void {
  atomicWriteJsonSync(path, { leases: rows });
}

// ---- cross-process write lock guarding the store (the todos.ts `O_EXCL` idiom, generalized) ------

const LEASES_LOCK_FILE = 'leases.lock';
const MAX_RETRY_DELAY_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class LeasesFileLock {
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

/** One non-blocking attempt: open `wx` (fails if the lock file exists), reclaim it if it has sat
 *  stale past `staleAfterMs` (a crashed writer), else give up. Same idiom as `todos.ts`'s
 *  `acquireTodosLease` / `automations/store.ts` / `sources/store.ts`. */
function acquireLeasesFileLock(dir: string, staleAfterMs = 10 * 60_000): LeasesFileLock | undefined {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, LEASES_LOCK_FILE);
  try {
    const fd = openSync(path, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return new LeasesFileLock(path, fd);
  } catch {
    try {
      if (Date.now() - statSync(path).mtimeMs > staleAfterMs) {
        unlinkSync(path);
        return acquireLeasesFileLock(dir, staleAfterMs);
      }
    } catch {
      // A contender released it first, or the directory is read-only.
    }
    return undefined;
  }
}

async function acquireLeasesFileLockBlocking(dir: string, lockTimeoutMs = 5_000): Promise<LeasesFileLock> {
  const deadline = Date.now() + lockTimeoutMs;
  let delay = 10;
  for (;;) {
    const lock = acquireLeasesFileLock(dir);
    if (lock) return lock;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`cluster leases store lock stayed held for over ${lockTimeoutMs}ms — another writer may be stuck`);
    }
    await sleep(Math.min(delay, remaining));
    delay = Math.min(delay * 2, MAX_RETRY_DELAY_MS);
  }
}

async function withLeasesFileLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const lock = await acquireLeasesFileLockBlocking(dir);
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

// ---- public API -------------------------------------------------------------------------------

/**
 * Acquire or renew. A refusal names the current holder and its expiry, so a parked node can wait
 * rather than poll blindly. `fencingToken` is monotonic per `(kind, id)`: a holder that was slow and
 * comes back with a stale token loses to the node that took the lease while it was gone, and can
 * tell that it did.
 */
export async function acquireLease(
  kind: ClusterLeaseKind,
  nodeId: ClusterNodeId,
  request: ClusterLeaseRequest,
  options?: ClusterHomeOptions,
): Promise<ClusterLeaseResponse> {
  const { now, warn, path, dir } = resolveContext(options);
  return withLeasesFileLock(dir, async () => {
    const rows = await readLeasesFile(path, warn);
    const idx = rows.findIndex((row) => row.kind === kind && row.id === request.id);
    const existing = idx >= 0 ? rows[idx] : undefined;
    const nowDate = now();
    const nowMs = nowDate.getTime();
    const live = isLive(existing, nowMs);

    // A renewal: the caller proves it holds the current epoch by presenting the matching token.
    if (request.fencingToken !== undefined && live && existing.holderNodeId === nodeId && existing.fencingToken === request.fencingToken) {
      const renewed: StoredClusterLease = { ...existing, expiresAt: new Date(nowMs + request.ttlMs).toISOString() };
      rows[idx] = renewed;
      writeLeasesFile(path, rows);
      return { acquired: true, lease: toClusterLease(renewed) };
    }

    // The same holder re-acquiring its own still-live hold without presenting a token — a
    // convenience renewal, kept in the same epoch.
    if (request.fencingToken === undefined && live && existing.holderNodeId === nodeId) {
      const renewed: StoredClusterLease = { ...existing, expiresAt: new Date(nowMs + request.ttlMs).toISOString() };
      rows[idx] = renewed;
      writeLeasesFile(path, rows);
      return { acquired: true, lease: toClusterLease(renewed) };
    }

    // Currently and validly held by someone else: refuse, and name who — never silently queue.
    if (live && existing.holderNodeId !== nodeId) {
      return { acquired: false, heldBy: existing.holderNodeId, expiresAt: existing.expiresAt };
    }

    // Unheld: never claimed, expired past its TTL, or the store was wiped out from under it.
    // Every one of those degrades to the same outcome — a fresh grant, a new epoch — which is the
    // module's whole answer to "what does losing the store permit": never a hang, never a throw,
    // always a clean re-acquisition; see the module docblock for what that does and does not buy a
    // caller.
    const granted: StoredClusterLease = {
      kind,
      id: request.id,
      holderNodeId: nodeId,
      acquiredAt: nowDate.toISOString(),
      expiresAt: new Date(nowMs + request.ttlMs).toISOString(),
      fencingToken: nextFencingToken(nowDate),
    };
    if (idx >= 0) rows[idx] = granted;
    else rows.push(granted);
    writeLeasesFile(path, rows);
    return { acquired: true, lease: toClusterLease(granted) };
  });
}

/** `false` when this node is not the recorded holder — releasing someone else's lease is the bug
 *  this return value exists to make visible, not a no-op to be swallowed. */
export async function releaseLease(
  kind: ClusterLeaseKind,
  id: string,
  nodeId: ClusterNodeId,
  options?: ClusterHomeOptions,
): Promise<boolean> {
  const { warn, path, dir } = resolveContext(options);
  return withLeasesFileLock(dir, async () => {
    const rows = await readLeasesFile(path, warn);
    const idx = rows.findIndex((row) => row.kind === kind && row.id === id);
    const existing = idx >= 0 ? rows[idx] : undefined;
    if (!existing || existing.holderNodeId !== nodeId) return false;
    rows.splice(idx, 1);
    writeLeasesFile(path, rows);
    return true;
  });
}

/**
 * D15b: a reconnecting spoke re-asserts what it still holds, and the hub honours a re-assertion from
 * the node already recorded as holder. Returns the leases it granted back.
 *
 * Three outcomes per lease, and only one of them is a refusal:
 *  - the store still shows this node holding it live → an ordinary renewal, same epoch;
 *  - the store shows it unheld (expired, or the store was wiped) → honoured as a fresh grant, a new
 *    epoch — the self-healing half of "losing them is survivable";
 *  - the store shows a DIFFERENT node holding it live → refused. A node that reconnects after a wipe
 *    is not owed its old resource back if someone else legitimately re-acquired it in the gap; a
 *    stale holder silently overriding a live one is exactly the failure this property exists to rule
 *    out (the unit-level analogue of Verification 10 — see the module docblock).
 */
export async function reassertLeases(
  nodeId: ClusterNodeId,
  held: readonly ClusterLease[],
  options?: ClusterHomeOptions,
): Promise<ClusterLease[]> {
  const { now, warn, path, dir } = resolveContext(options);
  return withLeasesFileLock(dir, async () => {
    const rows = await readLeasesFile(path, warn);
    const nowDate = now();
    const nowMs = nowDate.getTime();
    const granted: ClusterLease[] = [];

    for (const claim of held) {
      const idx = rows.findIndex((row) => row.kind === claim.kind && row.id === claim.id);
      const existing = idx >= 0 ? rows[idx] : undefined;
      const live = isLive(existing, nowMs);

      if (live && existing.holderNodeId !== nodeId) {
        continue; // refused: a legitimate new holder wins over a stale reassertion
      }

      const ttlMs = Math.max(1, new Date(claim.expiresAt).getTime() - new Date(claim.acquiredAt).getTime()) || DEFAULT_LEASE_TTL_MS;

      if (live && existing.holderNodeId === nodeId) {
        // The store survived: an ordinary renewal, same epoch.
        const renewed: StoredClusterLease = { ...existing, expiresAt: new Date(nowMs + ttlMs).toISOString() };
        rows[idx] = renewed;
        granted.push(toClusterLease(renewed));
        continue;
      }

      // Unheld — nothing currently contradicts this node's claim, so it is honoured, but as a new
      // epoch: an honest re-assertion after amnesia is a fresh grant, never a continuation of the
      // epoch the store forgot.
      const row: StoredClusterLease = {
        kind: claim.kind,
        id: claim.id,
        holderNodeId: nodeId,
        acquiredAt: nowDate.toISOString(),
        expiresAt: new Date(nowMs + ttlMs).toISOString(),
        fencingToken: nextFencingToken(nowDate),
      };
      if (idx >= 0) rows[idx] = row;
      else rows.push(row);
      granted.push(toClusterLease(row));
    }

    writeLeasesFile(path, rows);
    return granted;
  });
}

export async function readLeases(options?: ClusterHomeOptions): Promise<StoredClusterLease[]> {
  const { warn, path } = resolveContext(options);
  return readLeasesFile(path, warn);
}

/** Sweeps expired rows. Returns how many, because "how many leases expired unheld" is a health
 *  number: a lease shorter than the job it guards duplicates work, and this is where that shows. */
export async function expireLeases(options?: ClusterHomeOptions): Promise<number> {
  const { now, warn, path, dir } = resolveContext(options);
  return withLeasesFileLock(dir, async () => {
    const rows = await readLeasesFile(path, warn);
    const nowMs = now().getTime();
    const live = rows.filter((row) => new Date(row.expiresAt).getTime() > nowMs);
    const expiredCount = rows.length - live.length;
    if (expiredCount > 0) writeLeasesFile(path, live);
    return expiredCount;
  });
}

/** Every lease a node holds. The input to a revoke, and to the presence row that shows what a node
 *  is holding while it is asleep. */
export async function leasesHeldBy(
  nodeId: ClusterNodeId,
  options?: ClusterHomeOptions,
): Promise<StoredClusterLease[]> {
  const { now, warn, path } = resolveContext(options);
  const rows = await readLeasesFile(path, warn);
  const nowMs = now().getTime();
  return rows.filter((row) => row.holderNodeId === nodeId && new Date(row.expiresAt).getTime() > nowMs);
}
