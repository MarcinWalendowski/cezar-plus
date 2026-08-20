import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { closeSync, mkdirSync, openSync, statSync, unlinkSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { RunStatus } from '@loki-labs/better-cezar-contract';

/**
 * Phase 1 of `.ai/specs/2026-08-20-reopen-finished-tasks-merge-audit.md` — the reopen inbox:
 * `<dataDir>/reopen-requests.json`, a flat JSON array naming runs to continue and the prompt to
 * open them with.
 *
 * **A reopen request is inert data.** Nothing in this file can start a process by itself; the
 * RUNNING cockpit is what reopens (`reopen-watch.ts`), through the project's own `RunManager`.
 * That is the same shape `todos.ts` + `todo-autostart.ts` already use for
 * `cezar todo add --start` (`.ai/specs/2026-08-19-file-tasks-from-a-running-task.md`), and it
 * exists for the same reason: production runs `CEZ_AUTH=oidc` behind Cloudflare Access, so
 * `POST /api/v1/p/:projectId/runs/:id/continue` 401s a headless caller on loopback, and a second
 * headless manager would fight the working-tree lease and could not stream the run.
 *
 * The file is deliberately NOT `runs.json`: that one is owned by `RunStore` with debounced atomic
 * saves (`runs/store.ts`), so an external writer would be clobbered on the next save. Its own
 * file, its own cross-process `O_EXCL` write lease — the `todos.ts` / `auth/identity-store.ts`
 * idiom — because the two writers here are genuinely different OS processes: `cezar runs reopen`
 * appends, the cockpit stamps `startedAt`/`error`.
 */

export const reopenRequestSchema = z.object({
  /** uuid — of the REQUEST, not the run. One run may be reopened more than once over time. */
  id: z.string().min(1),
  /** The run to continue. Must live in THIS dataDir's `runs.json`; a request naming anything else
   *  is stamped with `continueRun`'s own `not found` rather than silently dropped. */
  runId: z.string().min(1),
  /** Opening prompt for the resumed session. Empty/whitespace → the engine's own default
   *  `'Continue.'` (`workflows/run.ts`'s `continueRun`). Bounded like the HTTP route's `text`. */
  prompt: z.string().max(100_000).optional(),
  createdAt: z.string(),
  /** Free text for the audit trail: `'cli'`, or `cli:<runId>` when a running task filed it. */
  source: z.string().max(200).optional(),
  /** Stamped when the cockpit accepted the continuation. Presence = do not retry. The direct
   *  analogue of a todo's `startedTaskId` (`todos.ts`). */
  startedAt: z.string().optional(),
  /** Stamped once when `continueRun` REFUSED (`no agent session to resume`, `run is still
   *  active`, `not found`, …). Presence = do not retry; the row stays as the record of why. */
  error: z.string().max(2_000).optional(),
});

export type ReopenRequest = z.infer<typeof reopenRequestSchema>;

/** Everything a caller supplies; `id`/`createdAt` are assigned by `appendReopenRequests`. */
export type NewReopenRequest = Pick<ReopenRequest, 'runId'> & Partial<Pick<ReopenRequest, 'prompt' | 'source'>>;

export function reopenRequestsPath(dataDir: string): string {
  return join(dataDir, 'reopen-requests.json');
}

// ---- the Active-tab predicate, stated once ------------------------------------------------

/** The subset of a run record this module's selector reads. Structurally a slice of `RunRecord`
 *  (`runs/store.ts`) so both the CLI's on-disk rows and a live store's records satisfy it. */
export interface SelectableRun {
  status: RunStatus;
  archived?: boolean;
}

/**
 * "Every done task on the Active tab", as ONE exported function rather than a predicate re-typed
 * at each call site.
 *
 * Active/Archived is not a lifecycle filter: the board consults `archived` and NEVER `status`
 * (`packages/web/src/lib/task-groups.ts`'s `sortRuns`, and its server-side twin in
 * `workspace/run-index.ts`), so a `done` run stays on Active until a human archives it. The
 * Active-tab half of that is `archived !== true` — `!== true`, not `!archived`, because an absent
 * field and an explicit `false` must read alike, which is the same "absent, not falsy" contract
 * `archivedAt`/`seenAt` use elsewhere.
 */
export function selectDoneUnarchived<T extends SelectableRun>(runs: readonly T[]): T[] {
  return runs.filter((run) => run.status === 'done' && run.archived !== true);
}

// ---- cross-process write lease (the `todos.ts`/`IdentityStore` `O_EXCL` idiom) --------------

const REOPEN_LOCK_FILE = 'reopen-requests.lock';
/** Cap on the exponential backoff between lease retries — mirrors `todos.ts`'s constant of the
 *  same name and role. */
const MAX_RETRY_DELAY_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

class ReopenLease {
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
 *  stale past `staleAfterMs` (a crashed writer), else give up. */
function acquireReopenLease(dataDir: string, staleAfterMs = 10 * 60_000): ReopenLease | undefined {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, REOPEN_LOCK_FILE);
  try {
    const fd = openSync(path, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return new ReopenLease(path, fd);
  } catch {
    try {
      if (Date.now() - statSync(path).mtimeMs > staleAfterMs) {
        unlinkSync(path);
        return acquireReopenLease(dataDir, staleAfterMs);
      }
    } catch {
      // A contender released it first, or the directory is read-only.
    }
    return undefined;
  }
}

/** Retry-and-block, not skip: a lost append is a reopen that silently never happens, which is not
 *  an acceptable failure mode for a sweep whose whole point is completeness (`todos.ts`'s own
 *  reasoning for the same choice). */
async function acquireReopenLeaseBlocking(dataDir: string, lockTimeoutMs = 5_000): Promise<ReopenLease> {
  const deadline = Date.now() + lockTimeoutMs;
  let delay = 10;
  for (;;) {
    const lease = acquireReopenLease(dataDir);
    if (lease) return lease;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        `reopen-requests.json write lease stayed held for over ${lockTimeoutMs}ms — another writer may be stuck`,
      );
    }
    await sleep(Math.min(delay, remaining));
    delay = Math.min(delay * 2, MAX_RETRY_DELAY_MS);
  }
}

async function withReopenLease<T>(dataDir: string, fn: () => Promise<T>): Promise<T> {
  const lease = await acquireReopenLeaseBlocking(dataDir);
  try {
    return await fn();
  } finally {
    lease.release();
  }
}

// ---- read / write ---------------------------------------------------------------------------

/** Parse + validate. Broken JSON / non-array → `[]` with one warning; bad entries are skipped
 *  with a warning, never fatal — external data, the `readTodos` contract. */
async function readRaw(dataDir: string): Promise<ReopenRequest[]> {
  let raw: string;
  try {
    raw = await fs.readFile(reopenRequestsPath(dataDir), 'utf8');
  } catch {
    return []; // no file yet — an empty inbox, and reading NEVER creates one
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[cez] reopen-requests.json is not valid JSON — treating it as empty (${message})`);
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.warn('[cez] reopen-requests.json is not a JSON array — treating it as empty');
    return [];
  }
  const items: ReopenRequest[] = [];
  for (const entry of parsed) {
    const result = reopenRequestSchema.safeParse(entry);
    if (!result.success) {
      console.warn(
        `[cez] skipped a malformed reopen-requests.json entry: ${result.error.issues.map((i) => i.message).join('; ')}`,
      );
      continue;
    }
    items.push(result.data);
  }
  return items;
}

async function writeAtomic(dataDir: string, items: ReopenRequest[]): Promise<void> {
  const file = reopenRequestsPath(dataDir);
  const tmp = `${file}.tmp`;
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(items, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

/** Pure read, no lease and no `mkdir`: "a read must not materialize state" (AGENTS.md § Zero
 *  config). A project that has never been swept has no file, and looking at it must not create
 *  one — the cockpit's boot pass reads every project's inbox on startup. */
export async function readReopenRequests(dataDir: string): Promise<ReopenRequest[]> {
  return readRaw(dataDir);
}

/** Append requests, assigning `id`/`createdAt`. Returns what was written, in order. */
export async function appendReopenRequests(
  dataDir: string,
  requests: readonly NewReopenRequest[],
): Promise<ReopenRequest[]> {
  if (requests.length === 0) return [];
  return withReopenLease(dataDir, async () => {
    const items = await readRaw(dataDir);
    const created = requests.map((request): ReopenRequest => ({
      ...request,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    }));
    items.push(...created);
    await writeAtomic(dataDir, items);
    return created;
  });
}

/**
 * Stamp `startedAt` — the cockpit accepted the continuation. **First stamp wins**: a request that
 * already carries `startedAt` or `error` is left untouched and answers false, so two reconcile
 * passes racing the same row can never both continue it. The check shares the lease with the
 * write, which is what makes that true across processes and not merely within one.
 */
export async function markReopenStarted(dataDir: string, id: string): Promise<boolean> {
  return withReopenLease(dataDir, async () => {
    const items = await readRaw(dataDir);
    const item = items.find((r) => r.id === id);
    if (!item || item.startedAt || item.error) return false;
    item.startedAt = new Date().toISOString();
    await writeAtomic(dataDir, items);
    return true;
  });
}

/** Stamp `error` — `continueRun` refused. Terminal in exactly the same way `startedAt` is: the
 *  row stays in the file as the record of WHY, and is never retried. */
export async function markReopenFailed(dataDir: string, id: string, error: string): Promise<boolean> {
  return withReopenLease(dataDir, async () => {
    const items = await readRaw(dataDir);
    const item = items.find((r) => r.id === id);
    if (!item || item.startedAt || item.error) return false;
    item.error = error.slice(0, 2_000);
    await writeAtomic(dataDir, items);
    return true;
  });
}

/** The reconcile predicate, stated once: a request is acted on only while neither terminal stamp
 *  is present. Both stamps are terminal, so a request is acted on AT MOST ONCE no matter how many
 *  watch events or boot passes see it. */
export function isReopenPending(request: ReopenRequest): boolean {
  return !request.startedAt && !request.error;
}

// ---- change notifications --------------------------------------------------------------------

/** One live watch per `dataDir`, created on the first subscription and torn down when the last
 *  subscriber leaves — the `onTodosChanged` contract, field for field. */
interface ReopenWatch {
  emitter: EventEmitter;
  /** Undefined when `fs.watch` degraded: subscribers exist but never fire, and the next boot pass
   *  is what catches the missed change. */
  watcher: FSWatcher | undefined;
  timer: NodeJS.Timeout | undefined;
}

const watches = new Map<string, ReopenWatch>();

function startWatch(dataDir: string): ReopenWatch {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(100);
  const entry: ReopenWatch = { emitter, watcher: undefined, timer: undefined };
  try {
    mkdirSync(dataDir, { recursive: true });
    const watcher = watch(dataDir, (_event, filename) => {
      if (filename && filename !== 'reopen-requests.json') return;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => emitter.emit('changed'), 300);
      entry.timer.unref?.();
    });
    watcher.on('error', () => undefined); // a dying watcher must not kill the server
    watcher.unref?.();
    entry.watcher = watcher;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[cez] reopen-requests watch unavailable — requests apply on the next boot only (${message})`);
  }
  watches.set(dataDir, entry);
  return entry;
}

/** Subscribe to `dataDir`'s reopen inbox. Returns the idempotent unsubscribe. */
export function onReopenRequestsChanged(dataDir: string, cb: () => void): () => void {
  const entry = watches.get(dataDir) ?? startWatch(dataDir);
  entry.emitter.on('changed', cb);
  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    entry.emitter.off('changed', cb);
    if (entry.emitter.listenerCount('changed') > 0) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.watcher?.close();
    watches.delete(dataDir);
  };
}

/** Test hook: is a live watch registered for `dataDir`? */
export function reopenRequestsWatchActive(dataDir: string): boolean {
  return watches.has(dataDir);
}
