import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { closeSync, mkdirSync, openSync, statSync, unlinkSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { taskAuthorSchema, type TaskAuthor } from './runs/task-author.ts';

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
  // ---- statuses, priority, archive (2026-08-17-filed-tasks-table-statuses.md) ----------------
  // Additive and optional, like the five below — see the wire twin (`contract/src/skills.ts`'s
  // `todoItemSchema`) for why. Absent `status` reads as `'todo'` in the Filed table, not written
  // here.
  status: z.enum(['todo', 'in-progress', 'blocked', 'done']).optional(),
  priority: z.enum(['high', 'medium', 'low']).optional(),
  /** Set by `updateTodo`'s `archived: true`; an archived entry leaves the Active board. */
  archivedAt: z.string().optional(),
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
  // ---- autostart (2026-08-19-file-tasks-from-a-running-task.md, Phase 2) ---------------------
  // Additive and optional, like the fields above: an entry with none of them still validates
  // unchanged. Set only by `cezar todo add --start` (`todo-cli.ts`); cleared by `markStarted` the
  // moment the entry becomes a run, so it is never true at the same time as `startedTaskId`.
  /** File this todo AS a run the moment the running cockpit notices it, instead of waiting for a
   *  person to click ▶ Run. See `todo-autostart.ts`. */
  autostart: z.boolean().optional(),
  // ---- author (2026-08-21-task-author-provenance.md, Phase 3) --------------------------------
  /**
   * Who filed this task — see the wire twin (`contract/src/skills.ts`'s `todoItemSchema`).
   *
   * Optional on the schema, REQUIRED by `createTodo`'s third argument below: that split is the
   * whole mechanism. It keeps every legacy entry — and every raw agent append, which bypasses
   * `createTodo` entirely (`handoff.ts`'s `FOLLOWUP_INSTRUCTIONS`) — valid and readable, while
   * making it impossible for a NEW code path to file a todo without naming who filed it.
   *
   * `origin` (above) is not this field and is not superseded by it: it names a writer CLASS with
   * no identity, no parent and no way to tell a person at the composer from a script posting to
   * the same route. It stays exactly as it is — removing a shipped field is a breaking change
   * with no benefit.
   */
  author: taskAuthorSchema.optional(),
});

export type TodoItem = z.infer<typeof todoSchema> & { id: string };

/** `POST /:projectId/todos`'s body, server-side: everything `createTodo` accepts from a caller —
 *  `id`/`ts` are assigned by `createTodo` itself, `taskId`/`startedTaskId` are agent-/server-only,
 *  `archivedAt` is stamped by `updateTodo`'s archive action, never client-supplied on create.
 *  Mirrors the wire twin's `createTodoInputSchema` (`contract/src/skills.ts`) field-for-field. */
export type CreateTodoInput = Omit<
  TodoItem,
  'id' | 'ts' | 'taskId' | 'startedTaskId' | 'archivedAt' | 'author'
>;

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
 *  racing a concurrent create, delete, start, or agent append never loses either side.
 *
 *  `author` is a SEPARATE, REQUIRED parameter rather than a key of `input`
 *  (2026-08-21-task-author-provenance) — that is what stops it ever being read off a request
 *  body. `input` is what a caller may specify; `author` is what the server decides about the
 *  caller. Build it with one of the constructors in `./runs/task-author.ts`. */
export async function createTodo(
  dataDir: string,
  input: CreateTodoInput,
  author: TaskAuthor,
): Promise<TodoItem> {
  return withTodosLease(dataDir, async () => {
    const { items } = await readRaw(dataDir);
    const todo: TodoItem = { ...input, id: randomUUID(), ts: new Date().toISOString(), author };
    items.push(todo);
    await writeAtomic(dataDir, items);
    return todo;
  });
}

/** `PATCH /:projectId/todos/:id`'s body, server-side — mirrors the wire twin's
 *  `updateTodoInputSchema` (`contract/src/skills.ts`) field-for-field, EXCEPT `context` and
 *  `acceptanceCriteria` below, which are maintenance-only additions with no wire-schema
 *  counterpart (added 2026-08-22 for one-off todo-consolidation scripts; never populated from
 *  an HTTP body). */
export type UpdateTodoPatch = {
  status?: TodoItem['status'];
  priority?: TodoItem['priority'];
  archived?: boolean;
  /** Maintenance-only: not settable via the wire schema / composer UI. */
  context?: TodoItem['context'];
  /** Maintenance-only: not settable via the wire schema / composer UI. */
  acceptanceCriteria?: TodoItem['acceptanceCriteria'];
  /**
   * Maintenance-only, and added 2026-08-22 for a specific reason worth keeping.
   *
   * A todo's summary is the only part of it the board renders, so it is what every later reader
   * scans — and when a todo turns out to be founded on a wrong diagnosis, the wrong diagnosis is
   * usually IN that line. Todo `c4cd4ab6` said "wait on liveness, then retry the step" from a
   * theory that measurement then disproved; correcting only `context` would have left the board
   * still advertising the theory. The workspace correction rule is explicit that a falsehood in a
   * heading must be fixed in the heading, so the maintenance path needs to be able to reach it.
   *
   * Still not on the wire schema: a summary is an entry's identity, and letting the composer UI
   * rewrite it in place would make the board's history unreadable.
   */
  summary?: TodoItem['summary'];
};

/**
 * `PATCH /:projectId/todos/:id` (2026-08-17-filed-tasks-table-statuses.md) — the Filed table's
 * status/priority edits and Archive/Restore, under the same lease every other writer here takes.
 * `undefined` for an unknown id (the route turns that into 404); the caller has already checked
 * `patch` carries at least one key (the wire schema's `.refine`).
 *
 * `archived: true` stamps `archivedAt` to now; `false` DELETES the key rather than writing an
 * explicit `undefined` — the `seenAt` precedent (`runs/store.ts`'s `setUnread`): every reader
 * keys on the field being ABSENT, and a written `undefined` would still leave the key present in
 * the in-memory item (`'archivedAt' in item` stays `true`) even though `JSON.stringify` drops it
 * on disk — an in-memory/on-disk split this avoids entirely.
 */
export async function updateTodo(dataDir: string, id: string, patch: UpdateTodoPatch): Promise<TodoItem | undefined> {
  return withTodosLease(dataDir, async () => {
    const { items } = await readRaw(dataDir);
    const item = items.find((t) => t.id === id);
    if (!item) return undefined;
    if (patch.status !== undefined) item.status = patch.status;
    if (patch.priority !== undefined) item.priority = patch.priority;
    if (patch.archived === true) item.archivedAt = new Date().toISOString();
    else if (patch.archived === false) delete item.archivedAt;
    if (patch.context !== undefined) item.context = patch.context;
    if (patch.acceptanceCriteria !== undefined) item.acceptanceCriteria = patch.acceptanceCriteria;
    if (patch.summary !== undefined) item.summary = patch.summary;
    await writeAtomic(dataDir, items);
    return item;
  });
}

/** One rendered section of the task text, or `undefined` when the entry carries nothing for it.
 *  Blank-but-present is the same as absent: a whitespace-only `context` must not leave a bare
 *  `## Context` heading pointing at nothing. */
function taskSection(heading: string, body: string | undefined): string | undefined {
  const trimmed = body?.trim();
  return trimmed ? `## ${heading}\n\n${trimmed}` : undefined;
}

/**
 * The task text "▶ Run" turns an entry into — the WHOLE filed entry, not its headline
 * (`.ai/specs/2026-08-19-tasks-page-and-start-grounding.md`, D2).
 *
 * Headline first (the suggested prompt, or the summary when the entry carries none) then the
 * suggested args, both byte-identical to what this produced before the structured fields existed;
 * then the spec the composer actually wrote, as markdown sections, each omitted when empty. A
 * legacy summary-only entry therefore produces exactly the string it always did.
 *
 * **Why the headline stays a bare first line.** `makeRunTitle` (`workflows/run.ts`) takes the
 * first line and truncates it at 80 characters, and `seedHandoffFile` writes the whole thing into
 * `## Goal`. Leading with a heading would make every run title `# something`; leading with the
 * summary keeps titles exactly as they are and gives a resumed run the full brief for free.
 *
 * **Corrected 2026-08-19.** This used to say the cockpit kept a copy in
 * `web/app/src/routes/inbox.tsx` that had to be pinned to the same fixture. It no longer does —
 * `inbox.tsx` POSTs to `/todos/:id/start` and builds no task text, and neither does the Filed
 * table's Start button. There is ONE builder, this one; `test/fixtures/todo-task-text.json` is
 * its contract, no longer a cross-process drift guard.
 *
 * `knowledgeRefs` are emitted as the three strings the composer persisted (title, project, slug)
 * and nothing more. That is not in tension with `knowledge/prompt.ts`'s Q12 rule against lifting
 * titles and slugs into a prompt: Q12 bounds text read out of MOUNTED DOCUMENTS this feature does
 * not own, whereas these are the citation as stored on the todo — the same strings the Filed
 * detail dialog already renders verbatim.
 */
export function todoTaskText(
  todo: Pick<
    TodoItem,
    | 'summary'
    | 'suggestedPrompt'
    | 'suggestedArgs'
    | 'context'
    | 'whatToDo'
    | 'acceptanceCriteria'
    | 'knowledgeRefs'
  >,
): string {
  let task = (todo.suggestedPrompt ?? todo.summary).trim() || todo.summary;
  if (todo.suggestedArgs) task += `\n\nArguments: ${todo.suggestedArgs}`;

  const criteria = (todo.acceptanceCriteria ?? []).map((line) => line.trim()).filter(Boolean);
  const refs = (todo.knowledgeRefs ?? []).filter((ref) => ref.title.trim() && ref.slug.trim());
  const sections = [
    taskSection('Context', todo.context),
    taskSection('What to do', todo.whatToDo),
    criteria.length ? `## Acceptance criteria\n\n${criteria.map((line) => `- [ ] ${line}`).join('\n')}` : undefined,
    refs.length
      ? `## Knowledge\n\n${refs.map((ref) => `- ${ref.title.trim()} (${ref.project}/${ref.slug.trim()})`).join('\n')}`
      : undefined,
  ].filter((section): section is string => section !== undefined);

  return sections.length ? `${task}\n\n${sections.join('\n\n')}` : task;
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
    // Phase 2 autostart (`todo-autostart.ts`): the flag's only job was getting the entry to this
    // point, and leaving it `true` next to a `startedTaskId` would read as "still pending" to the
    // next reconcile pass. Deleted rather than set to `false` — same "absent, not falsy" contract
    // `archivedAt`/`seenAt` use elsewhere in this file. A no-op for the ordinary "▶ Run" path,
    // where the field was never set.
    delete item.autostart;
    await writeAtomic(dataDir, items);
    return true;
  });
}

/** The inverse of `markStarted`, for the cancel path (2026-08-22-run-cancel-restores-todo.md):
 *  "Started → cancelled" had no way back to the Filed board, since `markStarted` is the only
 *  writer of `startedTaskId` and never clears it. Keyed by `startedTaskId`, not `id` — the cancel
 *  route only ever has the run id, never the todo it was started from. Deletes the key rather than
 *  setting it `undefined`, the same "absent, not falsy" contract `archivedAt`/`autostart` use
 *  above. No-op (`undefined`) when no todo references the given run id — best-effort, mirroring
 *  `markStarted`'s own contract. */
export async function clearStartedTaskId(dataDir: string, taskId: string): Promise<TodoItem | undefined> {
  return withTodosLease(dataDir, async () => {
    const { items } = await readRaw(dataDir);
    const item = items.find((t) => t.startedTaskId === taskId);
    if (!item) return undefined;
    delete item.startedTaskId;
    await writeAtomic(dataDir, items);
    return item;
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
