import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { closeSync, mkdirSync, openSync, statSync, unlinkSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * The global follow-up inbox (spec 007): `.ai/cezar/todos.json`, a flat JSON
 * array agents append to (via CEZ_TODOS_FILE). Agent entries are external
 * data — each one is zod-validated on read and malformed ones are skipped
 * with a warning, never fatal. Writes land atomically (tmp + rename, the
 * runs.json pattern).
 *
 * **Serialized with a cross-process `O_EXCL` write lease, not an in-process lock
 * (2026-08-15-knowledge-grounded-task-fanout.md, Phase 1).** Until now the only writer besides the
 * server was an agent SUBPROCESS appending via `CEZ_TODOS_FILE` (`FOLLOWUP_INSTRUCTIONS` in
 * `handoff.ts`) — a different OS process the server's old in-process `withLock` (a Promise-chain
 * mutex, live only in this Node process's memory) could never see. That was survivable while the
 * server itself never wrote past a delete/start. `createTodo` (below) is a second SERVER writer,
 * so two concurrent writers — the server and an agent, or two server requests — now race a
 * read-modify-write of the whole array in earnest. The same "open `wx`, stale-reclaim, retry with
 * backoff, else lease-timeout" idiom as `auth/identity-store.ts`'s `IdentityStore` closes that:
 * writes retry-and-block rather than `automations/store.ts`'s "one shot, else skip" — a lost
 * create is data loss in a way a skipped poll cycle is not.
 */

/** One citation a task-fan-out spec was grounded in — see the wire twin
 *  (`contract/src/skills.ts`'s `todoKnowledgeRefSchema`) for why the shape is title/slug/project
 *  only, never a document body. */
const todoKnowledgeRefSchema = z.object({
  project: z.string().min(1).max(64),
  slug: z.string().min(1).max(500),
  title: z.string().min(1).max(300),
});

export const todoSchema = z.object({
  id: z.string().min(1).optional(),
  ts: z.string().optional(),
  taskId: z.string().optional(),
  summary: z.string().min(1),
  action: z.string().optional(),
  prUrl: z.string().optional(),
  suggestedSkill: z.string().optional(),
  suggestedArgs: z.string().optional(),
  suggestedPrompt: z.string().optional(),
  /** Explicit intent; legacy entries infer it from an executable suggestion. */
  runnable: z.boolean().optional(),
  /** Set by the server when "▶ Run" turned this entry into a task. */
  startedTaskId: z.string().optional(),
  // ---- structured spec (2026-08-15-knowledge-grounded-task-fanout.md, D2/D4) -----------------
  // All five additive and optional — every existing todos.json entry (an agent's plain append)
  // carries none of them and still validates unchanged. Bounds mirror `createRunInputSchema`'s
  // own scale (`contract/src/runs.ts`), the closest sibling shape whose strings reach a spawned
  // process, rather than inventing new limits.
  /** Why this exists, what it extends. */
  context: z.string().max(20_000).optional(),
  /** The work itself. */
  whatToDo: z.string().max(100_000).optional(),
  /** Checkable statements. */
  acceptanceCriteria: z.array(z.string().min(1).max(500)).max(20).optional(),
  /** What grounded it. */
  knowledgeRefs: z.array(todoKnowledgeRefSchema).max(20).optional(),
  /** Which writer created it. */
  origin: z.enum(['agent', 'composer']).optional(),
});

export type TodoItem = z.infer<typeof todoSchema> & { id: string };

/** `POST /:projectId/todos`'s body, server-side: everything `createTodo` accepts from a caller —
 *  `id`/`ts` are assigned by `createTodo` itself, `taskId`/`startedTaskId` are agent-/server-only.
 *  Mirrors the wire twin's `createTodoInputSchema` (`contract/src/skills.ts`) field-for-field. */
export type CreateTodoInput = Omit<TodoItem, 'id' | 'ts' | 'taskId' | 'startedTaskId'>;

export function todosPath(dataDir: string): string {
  return join(dataDir, 'todos.json');
}

// ---- cross-process write lease (the `IdentityStore`/`AutomationStore` `O_EXCL` idiom) --------

const TODOS_LOCK_FILE = 'todos.lock';
/** Cap on the exponential backoff between lease retries — mirrors `identity-store.ts`'s own
 *  constant of the same name and role. */
const MAX_RETRY_DELAY_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

class TodosLease {
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

/** One non-blocking attempt at the write lease: open `wx` (fails if the lock file already
 *  exists), reclaim it if it has sat stale past `staleAfterMs` (a crashed writer), else give up.
 *  Same idiom as `automations/store.ts#acquireLease`/`sources/store.ts#acquireLease`. */
function acquireTodosLease(dataDir: string, staleAfterMs = 10 * 60_000): TodosLease | undefined {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, TODOS_LOCK_FILE);
  try {
    const fd = openSync(path, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return new TodosLease(path, fd);
  } catch {
    try {
      if (Date.now() - statSync(path).mtimeMs > staleAfterMs) {
        unlinkSync(path);
        return acquireTodosLease(dataDir, staleAfterMs);
      }
    } catch {
      // A contender released it first, or the directory is read-only.
    }
    return undefined;
  }
}

/** Retries `acquireTodosLease` with bounded exponential backoff until it succeeds or
 *  `lockTimeoutMs` elapses — "retry and block", not "skip": a create silently losing another
 *  writer's entry is not an acceptable failure mode for a user-facing action (identity-store.ts's
 *  own reasoning for the same choice). */
async function acquireTodosLeaseBlocking(dataDir: string, lockTimeoutMs = 5_000): Promise<TodosLease> {
  const deadline = Date.now() + lockTimeoutMs;
  let delay = 10;
  for (;;) {
    const lease = acquireTodosLease(dataDir);
    if (lease) return lease;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`todos.json write lease stayed held for over ${lockTimeoutMs}ms — another writer may be stuck`);
    }
    await sleep(Math.min(delay, remaining));
    delay = Math.min(delay * 2, MAX_RETRY_DELAY_MS);
  }
}

/** Takes the lease, runs `fn`, always releases — the one helper every write below goes through
 *  (the `IdentityStore.guardedWrite` precedent), so no call site can touch the file without it. */
async function withTodosLease<T>(dataDir: string, fn: () => Promise<T>): Promise<T> {
  const lease = await acquireTodosLeaseBlocking(dataDir);
  try {
    return await fn();
  } finally {
    lease.release();
  }
}

// ---- read / write -----------------------------------------------------------

/** Parse + validate the file. Broken JSON / non-array → []; bad entries are
 *  skipped with a warning; entries without an id get one assigned. */
async function readRaw(dataDir: string): Promise<{ items: TodoItem[]; needsRewrite: boolean }> {
  let raw: string;
  try {
    raw = await fs.readFile(todosPath(dataDir), 'utf8');
  } catch {
    return { items: [], needsRewrite: false }; // no file yet — empty inbox
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[cez] todos.json is not valid JSON — showing an empty inbox (${message})`);
    return { items: [], needsRewrite: false };
  }
  if (!Array.isArray(parsed)) {
    console.warn('[cez] todos.json is not a JSON array — showing an empty inbox');
    return { items: [], needsRewrite: false };
  }
  const items: TodoItem[] = [];
  let needsRewrite = false;
  for (const entry of parsed) {
    const result = todoSchema.safeParse(entry);
    if (!result.success) {
      console.warn(`[cez] skipped a malformed todos.json entry: ${result.error.issues.map((i) => i.message).join('; ')}`);
      continue;
    }
    if (!result.data.id) {
      // Agent entries arrive without ids — assign one so the GUI can address
      // the entry; the file is rewritten (under the lock) on this read.
      needsRewrite = true;
      items.push({ ...result.data, id: randomUUID() });
    } else {
      items.push({ ...result.data, id: result.data.id });
    }
  }
  return { items, needsRewrite };
}

async function writeAtomic(dataDir: string, items: TodoItem[]): Promise<void> {
  const file = todosPath(dataDir);
  const tmp = `${file}.tmp`;
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(items, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

/** Pure read, no lease: `readRaw` never writes, so there is nothing here for a lease to
 *  serialize against, and taking one unconditionally would mean every read — including the
 *  cross-project workspace board's read of a project that has never run cezar at all —
 *  `mkdirSync`s `.ai/cezar` into existence just by looking. "A read must not materialize state"
 *  (AGENTS.md). The lease is taken below, ONLY on the rare id-backfill write path. */
export async function readTodos(dataDir: string): Promise<TodoItem[]> {
  const { items, needsRewrite } = await readRaw(dataDir);
  if (needsRewrite) {
    // Re-check under the lease, fresh: another writer may have backfilled (or removed) the same
    // entries between the read above and the lease landing, and this write must never clobber
    // that. Best effort — an id backfill that loses this race just retries on the next read.
    await withTodosLease(dataDir, async () => {
      const fresh = await readRaw(dataDir);
      if (fresh.needsRewrite) await writeAtomic(dataDir, fresh.items);
    }).catch(() => undefined);
  }
  return items;
}

/** Check off (delete) an entry. False when the id isn't there. */
export async function removeTodo(dataDir: string, id: string): Promise<boolean> {
  return withTodosLease(dataDir, async () => {
    const { items } = await readRaw(dataDir);
    const next = items.filter((t) => t.id !== id);
    if (next.length === items.length) return false;
    await writeAtomic(dataDir, next);
    return true;
  });
}

/** `POST /:projectId/todos` (2026-08-15-knowledge-grounded-task-fanout.md, Phase 1): assigns
 *  `id`/`ts` and appends, under the same lease every other writer here takes — so a create
 *  racing a concurrent create, delete, start, or agent append never loses either side. */
export async function createTodo(dataDir: string, input: CreateTodoInput): Promise<TodoItem> {
  return withTodosLease(dataDir, async () => {
    const { items } = await readRaw(dataDir);
    const todo: TodoItem = { ...input, id: randomUUID(), ts: new Date().toISOString() };
    items.push(todo);
    await writeAtomic(dataDir, items);
    return todo;
  });
}

/** The task text "▶ Run" turns an entry into: the suggested prompt (or the summary when the
 *  entry carries none), plus the suggested args as a trailing line. The single server-side
 *  source for `POST /api/todos/:id/start`; the cockpit's prefill copy
 *  (`packages/web/src/routes/inbox.tsx`, #374) lives in another process and cannot import this, so
 *  the two are pinned to the shared cases in `test/fixtures/todo-task-text.json`. */
export function todoTaskText(
  todo: Pick<TodoItem, 'summary' | 'suggestedPrompt' | 'suggestedArgs'>,
): string {
  let task = (todo.suggestedPrompt ?? todo.summary).trim() || todo.summary;
  if (todo.suggestedArgs) task += `\n\nArguments: ${todo.suggestedArgs}`;
  return task;
}

/** Record that "▶ Run" turned the entry into task `taskId`. The entry stays
 *  in the file as an audit trail; the GUI hides started entries. First start wins: an entry
 *  that already carries a `startedTaskId` is left untouched and answers false, so the
 *  best-effort `todoId` bookkeeping on `POST /api/runs` (#374) can never overwrite the audit
 *  trail — the check shares this lease, so two concurrent launches cannot both claim the entry. */
export async function markStarted(dataDir: string, id: string, taskId: string): Promise<boolean> {
  return withTodosLease(dataDir, async () => {
    const { items } = await readRaw(dataDir);
    const item = items.find((t) => t.id === id);
    if (!item || item.startedTaskId) return false;
    item.startedTaskId = taskId;
    await writeAtomic(dataDir, items);
    return true;
  });
}

// ---- change notifications ----------------------------------------------------

/**
 * One live watch per `dataDir` (multi-project spec, step 2.3): each project's
 * inbox gets its own fs watcher + emitter, so project A's todos.json writes
 * never fire project B's subscribers. A watch lives exactly as long as it has
 * subscribers — created on the first `onTodosChanged(dataDir, …)`, torn down
 * (watcher closed, debounce cleared, map entry dropped) when the last one
 * unsubscribes, so a disposed project context stops burning an fd.
 */
interface TodosWatch {
  emitter: EventEmitter;
  /** Undefined when `fs.watch` degraded — subscribers exist but never fire
   *  (the Inbox updates on refresh only). */
  watcher: FSWatcher | undefined;
  /** Per-dataDir debounce for bursty writes (tmp + rename is two events). */
  timer: NodeJS.Timeout | undefined;
}

const watches = new Map<string, TodosWatch>();

/** Start watching `dataDir` for todos.json changes (agents write it from
 *  another process). Degrades to a watcher-less entry on error. */
function startWatch(dataDir: string): TodosWatch {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(100);
  const entry: TodosWatch = { emitter, watcher: undefined, timer: undefined };
  try {
    mkdirSync(dataDir, { recursive: true });
    const watcher = watch(dataDir, (_event, filename) => {
      if (filename && filename !== 'todos.json') return;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => emitter.emit('changed'), 300);
      entry.timer.unref?.();
    });
    watcher.on('error', () => undefined); // a dying watcher must not kill the server
    watcher.unref?.();
    entry.watcher = watcher;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[cez] todos watch unavailable — the Inbox updates on refresh only (${message})`);
  }
  watches.set(dataDir, entry);
  return entry;
}

/** Subscribe to `dataDir`'s inbox changes; the watch is created on the first
 *  subscription and torn down when the last subscriber leaves. Returns the
 *  unsubscribe function (idempotent — a stale double call can never tear down
 *  a watch that later subscribers re-created). */
export function onTodosChanged(dataDir: string, cb: () => void): () => void {
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
export function todosWatchActive(dataDir: string): boolean {
  return watches.has(dataDir);
}
