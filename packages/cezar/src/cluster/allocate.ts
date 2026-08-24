import { closeSync, existsSync, mkdirSync, openSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  clusterAllocateResponseSchema,
  storedClusterAllocationSchema,
  type ClusterAllocateRequest,
  type ClusterAllocateResponse,
  type ClusterNodeId,
  type StoredClusterAllocation,
} from '@loki-labs/better-cezar-contract';
import { cezarHomeDir } from '../paths.ts';
import type { ClusterHomeOptions } from './node-identity.ts';

/**
 * The hub hands out and **records** scarce shared identities — spec numbers first (spec
 * `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, D19 rung 2; PLAN 4.2).
 *
 * **This is the one place where the cluster makes something WORSE if it is skipped, rather than just
 * not-better, and that is why it is on the ladder at all.** `next-spec` reads one disk and reserves
 * nothing: it unions `origin/main`, every ref and every worktree on disk, then hands back a number
 * and forgets it. Two sessions running it in the same minute get the same answer — which is how
 * SPEC-356 and SPEC-357 each came to name two different specs on 2026-08-03, on ONE machine. A
 * spoke's uncommitted worktree is invisible to it entirely, so multi-node makes the collision more
 * likely, not less.
 *
 * A hub allocator that actually hands out a number and writes it down is small, exact, and removes
 * the whole class. The property package 4.2 must assert is not "two calls differ" but **N concurrent
 * calls produce N distinct values, asserted across the whole set** — a pairwise check passes against
 * an allocator that repeats every third number.
 *
 * `kind` is a bounded string, never a literal union: the reasoning is `sources.ts`'s, and this type
 * is published in `@loki-labs/better-cezar-contract` where PLAN P8 forbids widening an enum.
 *
 * **Storage: one file per `kind`**, `<CEZ_HOME>/cluster/allocations/<kind>.json` — an append-only
 * ledger of `StoredClusterAllocation` events, `.passthrough()`, atomic tmp+rename at `0600`, corrupt
 * degrades to empty with one warning (`options.warn`), never fails the caller. Per-kind files are
 * what makes "generic over kind" safe rather than merely convenient: a kind gets its own counter *by
 * construction* — there is no shared file, no shared high-water mark, and therefore no way for an
 * unrecognised `kind` to silently draw from `spec-number`'s sequence or vice versa. `allocationsPath`
 * additionally rejects a `kind` that is not `[a-z0-9][a-z0-9-]{0,31}` — tighter than the wire schema
 * (`z.string().min(1).max(32)`), because here `kind` becomes a filename and the wire schema alone
 * would let a `..`-laden or slash-laden kind escape the allocations directory.
 *
 * **Reserving and recording are one operation**, inside a single cross-process `O_EXCL` write lease
 * per kind — the same "open `wx`, stale-reclaim, retry-with-backoff, else lease-timeout" idiom as
 * `todos.ts#withTodosLease` / `auth/identity-store.ts#IdentityStore` / `automations/store.ts` /
 * `sources/store.ts`, each of which keeps its own copy rather than sharing one, and this file follows
 * that same established convention. `nextSpecNumberFrom` is the pure decision function `allocate`
 * uses to pick the next value(s) once it holds the lease and has read the ledger.
 *
 * **The observed floor is recomputed on EVERY call, never seeded once.** This module has no
 * filesystem visibility into any project's own `.ai/specs/`, so `allocate`'s optional
 * `AllocateOptions.observe` callback is the seam a caller with disk access — the route handler, or
 * whatever eventually replaces `next-spec` — supplies to report what already exists on disk.
 * `observe` is invoked **inside the lease, on every single `allocate` call**, and unioned with the
 * ledger via `nextSpecNumberFrom` before a number is chosen. A one-time bootstrap seed was
 * considered and rejected: it is correct exactly until the next `git pull` lands a spec from outside
 * the allocator (a teammate's push, an older cezar, a hand-written spec), at which point the ledger
 * silently falls behind the filesystem and the allocator starts handing out numbers that already
 * name a spec — the same class of bug `next-spec` has today, just slower to notice. Absent `observe`,
 * `allocate` uses the ledger alone (every existing call site and test keeps working unchanged).
 *
 * **Crash behaviour, decided: a number handed out is burned, never reclaimed.** There is no
 * "release" or "cancel" call, on purpose. `ClusterAllocateRequest.reason` exists precisely so an
 * unused number is explicable later ("Recorded with the allocation, so a number handed out and never
 * used is explicable later" — the contract's own docblock), which only makes sense if numbers are
 * allowed to go unused rather than reclaimed. The alternative — a TTL-reclaimable reservation — would
 * reopen exactly the window D19 rung 2 exists to close: two callers racing to reclaim the same
 * "abandoned" number. A sparse, monotonic sequence with the occasional gap is cheap; a reused number
 * is the SPEC-356/357 bug again with extra steps.
 */

const ALLOCATIONS_KIND_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

function assertValidKind(kind: string): void {
  if (!ALLOCATIONS_KIND_PATTERN.test(kind)) {
    throw new Error(
      `cluster allocate: invalid kind "${kind}" — expected 1-32 lowercase letters, digits and "-", starting with a letter or digit`,
    );
  }
}

export function allocationsPath(kind: string, env?: NodeJS.ProcessEnv): string {
  assertValidKind(kind);
  return join(cezarHomeDir(env), 'cluster', 'allocations', `${kind}.json`);
}

/**
 * `ClusterHomeOptions` plus the one thing specific to this file: a way for a caller with filesystem
 * visibility (this module deliberately has none) to report what is OBSERVED on disk, fresh, on every
 * `allocate` call. See the module header for why a one-time seed was rejected. Defined here rather
 * than added to `ClusterHomeOptions` itself, which is the shared option bag every module in
 * `cluster/` takes — `observe` has no meaning for `leases.ts` or `peers.ts`, and this file owns only
 * `allocate.ts`.
 */
export interface AllocateOptions extends ClusterHomeOptions {
  observe?: () => number[] | Promise<number[]>;
}

// ---- cross-process write lease, one per kind (the `todos.ts#withTodosLease` idiom) -------------

/** Cap on the exponential backoff between lease retries — mirrors `todos.ts`'s own constant of the
 *  same name and role. */
const MAX_RETRY_DELAY_MS = 200;
const DEFAULT_STALE_AFTER_MS = 10 * 60_000;
const DEFAULT_LEASE_TIMEOUT_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class AllocationsLease {
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

/** One non-blocking attempt at the write lease: open `wx` (fails if the lock file already exists),
 *  reclaim it if it has sat stale past `staleAfterMs` (a crashed writer), else give up. */
function acquireAllocationsLease(lockPath: string, staleAfterMs = DEFAULT_STALE_AFTER_MS): AllocationsLease | undefined {
  mkdirSync(dirname(lockPath), { recursive: true });
  try {
    const fd = openSync(lockPath, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return new AllocationsLease(lockPath, fd);
  } catch {
    try {
      if (existsSync(lockPath) && Date.now() - statSync(lockPath).mtimeMs > staleAfterMs) {
        unlinkSync(lockPath);
        return acquireAllocationsLease(lockPath, staleAfterMs);
      }
    } catch {
      // A contender released it first, or the directory is read-only.
    }
    return undefined;
  }
}

/** Retries `acquireAllocationsLease` with bounded exponential backoff until it succeeds or
 *  `timeoutMs` elapses — "retry and block", not "skip": losing a reservation silently is exactly the
 *  failure mode this file exists to remove. */
async function acquireAllocationsLeaseBlocking(lockPath: string, timeoutMs = DEFAULT_LEASE_TIMEOUT_MS): Promise<AllocationsLease> {
  const deadline = Date.now() + timeoutMs;
  let delay = 10;
  for (;;) {
    const lease = acquireAllocationsLease(lockPath);
    if (lease) return lease;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`cluster allocate: write lease on ${lockPath} stayed held for over ${timeoutMs}ms — another writer may be stuck`);
    }
    await sleep(Math.min(delay, remaining));
    delay = Math.min(delay * 2, MAX_RETRY_DELAY_MS);
  }
}

async function withAllocationsLease<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const lease = await acquireAllocationsLeaseBlocking(lockPath);
  try {
    return await fn();
  } finally {
    lease.release();
  }
}

// ---- read / write the per-kind ledger -----------------------------------------------------------

/** Pure read + per-entry salvage: broken JSON / non-array degrades to `[]`; a malformed entry is
 *  skipped with one warning rather than evicting its siblings. Never throws. */
async function readAllocationsRaw(path: string, warn?: (message: string) => void): Promise<StoredClusterAllocation[]> {
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch {
    return []; // no file yet — nothing has ever been allocated under this kind
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warn?.(`[cez] cluster allocations file is not valid JSON — treating ${path} as empty (${message})`);
    return [];
  }
  if (!Array.isArray(parsed)) {
    warn?.(`[cez] cluster allocations file is not a JSON array — treating ${path} as empty`);
    return [];
  }
  const out: StoredClusterAllocation[] = [];
  for (const entry of parsed) {
    const result = storedClusterAllocationSchema.safeParse(entry);
    if (!result.success) {
      warn?.(`[cez] skipped a malformed cluster allocation entry: ${result.error.issues.map((i) => i.message).join('; ')}`);
      continue;
    }
    out.push(result.data);
  }
  return out;
}

async function writeAllocationsAtomic(path: string, allocations: readonly StoredClusterAllocation[]): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(allocations, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmp, path);
}

export async function readAllocations(kind: string, options?: ClusterHomeOptions): Promise<StoredClusterAllocation[]> {
  const path = allocationsPath(kind, options?.env);
  return readAllocationsRaw(path, options?.warn);
}

/**
 * Hands out `count` values and records them in the same `O_EXCL` lease that read the high-water
 * mark. Reserving and recording are one operation — an allocator that returns before it has written
 * is `next-spec` with extra steps.
 *
 * `options.observe`, if supplied, is called **once per `allocate` call, inside the lease**, and its
 * result is unioned with the ledger via `nextSpecNumberFrom` before any value is chosen — see the
 * module header for why this is recomputed every time rather than seeded once.
 */
export async function allocate(
  kind: string,
  byNodeId: ClusterNodeId,
  request: ClusterAllocateRequest,
  options?: AllocateOptions,
): Promise<ClusterAllocateResponse> {
  assertValidKind(kind);
  const path = allocationsPath(kind, options?.env);
  const lockPath = `${path}.lock`;
  const count = Math.min(Math.max(Math.trunc(request.count ?? 1), 1), 50);
  const now = options?.now?.() ?? new Date();

  return withAllocationsLease(lockPath, async () => {
    const existing = await readAllocationsRaw(path, options?.warn);
    const reserved = existing.flatMap((entry) => entry.values.map((value) => Number(value)).filter((n) => Number.isInteger(n)));
    const observed = options?.observe ? await options.observe() : [];

    const values: string[] = [];
    let pool: readonly number[] = reserved;
    for (let i = 0; i < count; i++) {
      const next = nextSpecNumberFrom({ reserved: pool, observed });
      values.push(String(next));
      pool = [...pool, next];
    }

    const response: ClusterAllocateResponse = {
      kind,
      values,
      allocatedAt: now.toISOString(),
      byNodeId,
      ...(request.projectKey !== undefined ? { projectKey: request.projectKey } : {}),
      ...(request.reason !== undefined ? { reason: request.reason } : {}),
    };
    // Validate against the wire shape before it is either returned or recorded, so a stored entry
    // can never drift from what this function actually serves.
    const stored = clusterAllocateResponseSchema.parse(response);
    await writeAllocationsAtomic(path, [...existing, stored]);
    return stored;
  });
}

/**
 * The next spec number, from the union of what the allocator has already RESERVED and what is
 * OBSERVED on disk. Both halves are needed and neither is sufficient: a number reserved a minute ago
 * has no file yet, and a spec written before the allocator existed has a file and no reservation.
 * Pure, so the union rule is testable without a filesystem.
 */
export function nextSpecNumberFrom(input: { reserved: readonly number[]; observed: readonly number[] }): number {
  let max = 0;
  for (const n of input.reserved) {
    if (Number.isFinite(n) && n > max) max = n;
  }
  for (const n of input.observed) {
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}
