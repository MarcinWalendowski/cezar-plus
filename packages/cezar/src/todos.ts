import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { closeSync, mkdirSync, openSync, statSync, unlinkSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { clusterTodoFieldsSchema, type ClusterAckResult, type ClusterOp } from '@loki-labs/better-cezar-contract';
import { clusterModeFromEnv } from './cluster/node-identity.ts';
import { CLUSTER_META_TODO_FIELDS } from './cluster/ops.ts';
import { applyReplica, type ReplicaApplyResult } from './cluster/replica.ts';
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
  // ---- cluster (2026-08-22-multi-node-cezar-cluster.md, D4 · D5 · D6 · D13) ------------------
  /**
   * `pendingSince` · `pendingFields` · `hubSeq` · `tombstone` · `placement` · `startedOn`, spread
   * from the contract's `clusterTodoFieldsSchema` rather than restated here — **one definition of
   * one record.** `cluster/replica.ts` and `cluster/ops.ts` both read these fields off a `TodoItem`;
   * a second copy of the shape in this file would be free to drift from the one they validate
   * against, and the drift would only show up as a field silently not replicating.
   *
   * Additive and optional, like every group above: an entry carrying none of them still
   * validates unchanged, which is what keeps every raw agent append (`handoff.ts`'s
   * `FOLLOWUP_INSTRUCTIONS`) and every pre-cluster row readable. **Nothing writes any of them
   * unless clustering is on** — see `clusteringOn` below; with `CEZ_CLUSTER` unset this file
   * produces the same bytes it produced before the cluster existed.
   *
   * They are deliberately NOT `.catch`-defaulted, though the spec's data-model rule allows
   * either ("every field optional **or** `.catch`-defaulted"). A `.catch(undefined)` on
   * `tombstone` would turn a malformed delete marker into a **resurrected row**, which is worse
   * than this file's existing per-entry salvage — one entry skipped with a warning, which for a
   * tombstoned row reads as the deletion it was. Unknown *shapes* are already handled the other
   * way, by `.passthrough()`: see `storedTodoSchema`.
   */
  ...clusterTodoFieldsSchema.shape,
});

/**
 * What `readRaw` actually parses with (D13). `todoSchema` is a plain object and therefore STRIPS
 * keys it does not know — fine while this file was the only writer of the file, and wrong the
 * moment a newer node in the cluster writes a field this build has never heard of: the older node
 * would drop it on the next rewrite and silently truncate everyone's history. Passthrough keeps
 * it, verbatim, so a round-trip through an old reader is lossless.
 *
 * Kept separate from `todoSchema` rather than making `todoSchema` itself passthrough, because a
 * passthrough object infers an index signature (`& { [k: string]: unknown }`) — and `TodoItem`
 * carrying one would collapse `CreateTodoInput`'s `Omit<>` to a bare index signature, quietly
 * un-typing every field of the create path. The runtime gains the tolerance; the type does not
 * lose its shape. Same split as the contract's own `clusterOpSchema` / `storedClusterOpSchema`.
 */
export const storedTodoSchema = todoSchema.passthrough();

export type TodoItem = z.infer<typeof todoSchema> & { id: string };

/** A deleted row is a tombstone, never a removal (D6) — a bare removal loses to any concurrent
 *  patch and the row resurrects. Consumers that render a board (`readTodos` returns tombstoned
 *  rows, because the outbox derivation must be able to SEE the delete) filter on this. */
export function isTombstoned(todo: Pick<TodoItem, 'tombstone'>): boolean {
  return todo.tombstone !== undefined;
}

/** `POST /:projectId/todos`'s body, server-side: everything `createTodo` accepts from a caller —
 *  `id`/`ts` are assigned by `createTodo` itself, `taskId`/`startedTaskId` are agent-/server-only,
 *  `archivedAt` is stamped by `updateTodo`'s archive action, never client-supplied on create.
 *  Mirrors the wire twin's `createTodoInputSchema` (`contract/src/skills.ts`) field-for-field.
 *
 *  The five cluster transport/claim fields join that list for the same reason `author` is a
 *  separate argument: `pendingSince` and `pendingFields` are written by this file inside the
 *  lease (see `stampPending`), `hubSeq` by the hub's acknowledgement, `tombstone` is written by
 *  `removeTodo`, and `startedOn` is hub-confirmed only (D4/D9a) — a caller that could supply one
 *  could assert a claim the hub never granted, which is precisely the optimistic start the design
 *  forbids. `placement` is NOT omitted: "run this one on the box" is a legitimate thing for the
 *  filer to say. */
export type CreateTodoInput = Omit<
  TodoItem,
  | 'id'
  | 'ts'
  | 'taskId'
  | 'startedTaskId'
  | 'archivedAt'
  | 'author'
  | 'pendingSince'
  | 'pendingFields'
  | 'hubSeq'
  | 'tombstone'
  | 'startedOn'
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

// ---- the cluster's optimistic-write marker (spec 2026-08-22-multi-node-cezar-cluster, D4/D5) --

/**
 * Every option any writer in this file takes for the cluster. All optional, and **the default is
 * off**: with `CEZ_CLUSTER` unset nothing below stamps anything, no new key is written into
 * `todos.json`, and this file behaves exactly as it did before the cluster existed.
 *
 * `clustered` is resolved from `clusterModeFromEnv` — D1's single source of truth — and not from a
 * `CEZ_CLUSTER === '1'` check re-derived here, because a second signal is how the two drift. It is
 * deliberately NOT a hook a caller has to register: a stamp that has to be wired up is a stamp that
 * can be forgotten, and a forgotten one is a **lost write** under D4 (the hub is the only writer, so
 * an op that is never derived never lands anywhere). The explicit `clustered` override exists for
 * tests, which must be able to exercise both sides without mutating the process environment.
 */
export interface TodoClusterOptions {
  /** Overrides the env-derived answer. Tests pass it; production does not. */
  clustered?: boolean;
  now?: () => Date;
  /** Injected process environment, for tests. */
  env?: NodeJS.ProcessEnv;
}

function clusteringOn(options?: TodoClusterOptions): boolean {
  return options?.clustered ?? clusterModeFromEnv(options?.env).enabled;
}

function clusterNow(options?: TodoClusterOptions): string {
  return (options?.now ?? (() => new Date()))().toISOString();
}

/**
 * The optimistic-write marker, stamped **inside the same `O_EXCL` lease as the value it marks**
 * (D5) — that is the whole property: marker and value can never disagree, so the outbox is
 * re-derivable from the records themselves and a crash that loses `ops.ndjson`'s tail loses
 * nothing.
 *
 * An **existing** marker is preserved rather than refreshed. `pendingSince` answers "pending since
 * when", so a record edited five times while the link was down should still report the age of the
 * FIRST unsent edit — that is what makes a stuck outbox visible. It also keeps `deriveTodoOps`
 * deterministic: `cluster/ops.ts` carries `todo.pendingSince` through as the op's `ts`, so a
 * re-derive after a crash reproduces the same op rather than a fresh-looking one.
 *
 * `pendingFields` names WHICH keys are owed (2026-08-22 amendment — spec's Data Models section).
 * `pendingSince` alone can only say THAT a record is owed, never what changed, so a
 * derive-from-records outbox (D5) had nothing to narrow on and could only send the whole record —
 * the exact whole-record clobber D4 exists to prevent. `touchedFields` is what THIS write changed:
 *
 *  - **A fresh cycle** (`pendingSince` was not already set) starts `pendingFields` from exactly
 *    `touchedFields`, discarding whatever the array held before. That also self-heals a leftover:
 *    `applyReplica` (`cluster/replica.ts`) clears `pendingSince` on settle but was written before
 *    `pendingFields` existed and does not clear this array too, so a stale value can survive a
 *    settled cycle with nothing outstanding left to describe. Starting the next cycle fresh rather
 *    than unioning onto that leftover is what keeps it from drifting forever instead of costing
 *    one stale read.
 *  - **An outstanding cycle** (`pendingSince` already set) unions `touchedFields` into whatever is
 *    already owed — never replaces — so an edit to field B before field A's earlier edit has
 *    synced does not make A's edit un-owed.
 *
 * **Both branches drop `CLUSTER_META_TODO_FIELDS` (D36, 2026-08-23).** `pendingFields` names keys
 * an op will be expected to carry; a key `cluster/ops.ts` can never put on an op is not "owed", it
 * is unrepresentable, and recording it as owed is a `pendingSince` that can never clear. Note what
 * this does NOT change: `pendingSince` is still stamped even when every touched key is meta —
 * `removeTodo` touches only `tombstone`, and the marker is what makes `deriveTodoOps` emit the
 * tombstone op at all. The marker says THAT something is owed; the array says which CONTENT is.
 */
function stampPending(item: TodoItem, options: TodoClusterOptions | undefined, touchedFields: readonly string[]): void {
  if (!clusteringOn(options)) return;
  // D36 — a key that can never RIDE an op must never be recorded as OWED. `createTodo` and
  // `readRaw`'s id backfill both stamp `Object.keys(item)`, which includes `id`; `id` is in
  // `CLUSTER_META_TODO_FIELDS`, so `cluster/ops.ts#partitionTodoFields` puts it in neither
  // `op.fields` nor `op.clearedFields`, so D27's narrowing in `cluster/replica.ts` can never
  // resolve it, so `pendingSince` never clears and `deriveTodoOps` re-sends that record on every
  // flush tick forever (measured: ~17,280 ops/day with the cluster idle). Filtering here rather
  // than teaching the narrowing to skip meta keys is the fix at the SOURCE: the un-sendable key
  // never enters the record in the first place. The set is imported, never restated — one concept
  // enforced from two hand-kept lists is what produced D36.
  const owed = touchedFields.filter((field) => !CLUSTER_META_TODO_FIELDS.has(field));
  if (!item.pendingSince) {
    item.pendingSince = clusterNow(options);
    item.pendingFields = [...new Set(owed)];
  } else {
    // The union is filtered too, not just the incoming keys: a record already on disk from before
    // this fix carries `pendingFields: ['id']` and is stuck in exactly that loop, so the next local
    // edit — which takes this same lease and rewrites the record anyway — heals it in passing. The
    // other heal is receive-side (`cluster/replica.ts`), for a stuck record nobody edits again.
    item.pendingFields = [...new Set([...(item.pendingFields ?? []), ...owed])].filter(
      (field) => !CLUSTER_META_TODO_FIELDS.has(field),
    );
  }
}

// ---- read / write -----------------------------------------------------------

export interface TodoReadSnapshot {
  items: TodoItem[];
  /** A non-absence filesystem failure. Missing state is represented by an empty item list. */
  error?: Error;
}

type TodoFileRead =
  | { raw: string }
  | { absent: true }
  | { error: Error };

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isAbsentFileError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function readTodoFile(dataDir: string): Promise<TodoFileRead> {
  try {
    return { raw: await fs.readFile(todosPath(dataDir), 'utf8') };
  } catch (error) {
    return isAbsentFileError(error) ? { absent: true } : { error: asError(error) };
  }
}

function parseTodoFile(
  raw: string,
  options?: TodoClusterOptions,
): { items: TodoItem[]; needsRewrite: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[cez] todos.json is not valid JSON - showing an empty inbox (${message})`);
    return { items: [], needsRewrite: false };
  }
  if (!Array.isArray(parsed)) {
    console.warn('[cez] todos.json is not a JSON array - showing an empty inbox');
    return { items: [], needsRewrite: false };
  }
  const items: TodoItem[] = [];
  let needsRewrite = false;
  for (const entry of parsed) {
    const result = storedTodoSchema.safeParse(entry);
    if (!result.success) {
      console.warn(`[cez] skipped a malformed todos.json entry: ${result.error.issues.map((i) => i.message).join('; ')}`);
      continue;
    }
    if (!result.data.id) {
      needsRewrite = true;
      const healed = { ...result.data, id: randomUUID() } as TodoItem;
      stampPending(healed, options, Object.keys(healed));
      items.push(healed);
    } else {
      items.push({ ...result.data, id: result.data.id } as TodoItem);
    }
  }
  return { items, needsRewrite };
}

/** Read and parse todos without taking a lease, subscribing, creating a directory, or healing ids. */
export async function readTodosSnapshot(
  dataDir: string,
  options?: TodoClusterOptions,
): Promise<TodoReadSnapshot> {
  const file = await readTodoFile(dataDir);
  if ('error' in file) return { items: [], error: file.error };
  if ('absent' in file) return { items: [] };
  return { items: parseTodoFile(file.raw, options).items };
}

/** Parse + validate the file. Broken JSON / non-array -> []; bad entries are
 *  skipped with a warning; entries without an id get one assigned, and when clustering is on,
 *  the same pending marker a `createTodo` would have written (D5a). */
async function readRaw(
  dataDir: string,
  options?: TodoClusterOptions,
): Promise<{ items: TodoItem[]; needsRewrite: boolean }> {
  const file = await readTodoFile(dataDir);
  if ('error' in file || 'absent' in file) return { items: [], needsRewrite: false };
  return parseTodoFile(file.raw, options);
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
export async function readTodos(dataDir: string, options?: TodoClusterOptions): Promise<TodoItem[]> {
  const first = await readRaw(dataDir, options);
  if (!first.needsRewrite) return first.items;

  // Re-check under the lease, fresh: another writer may have backfilled (or removed) the same
  // entries between the read above and the lease landing, and this write must never clobber
  // that. Best effort — an id backfill that loses this race just retries on the next read.
  // The re-read is what gets written, never the array above: caching items across the lease
  // boundary is exactly how a snapshot taken before someone else's write gets written back over
  // it (a todo vanished from production's `todos.json` that way on 2026-08-22).
  //
  // **Corrected 2026-08-22 — this used to return the FIRST read's items, which are not what the
  // file kept.** `readRaw` mints a fresh `randomUUID()` for every id-less entry, so the two reads
  // assign two DIFFERENT ids to the same raw agent append: the caller was handed one id and the
  // file kept the other. Harmless while an id was only a GUI handle; not harmless once an id is an
  // entity id in a cluster, where a derived op carrying the id the caller saw would address a
  // record no other node has (D5a — "id assignment has to happen before an op is derived"). So the
  // healed read returns what was written. A failed lease falls back to the first read, which is
  // still the honest answer: nothing was written either.
  let healed = first.items;
  await withTodosLease(dataDir, async () => {
    const fresh = await readRaw(dataDir, options);
    if (fresh.needsRewrite) await writeAtomic(dataDir, fresh.items);
    healed = fresh.items;
  }).catch(() => undefined);
  return healed;
}

/**
 * Check off (delete) an entry. False when the id isn't there.
 *
 * **Clustered, this is a tombstone rather than a removal (D6).** A bare removal carries no marker,
 * so there is nothing for the outbox to derive from and the delete simply never leaves this node;
 * worse, a removal loses to any concurrent patch and the row resurrects. The row therefore stays in
 * the file carrying `tombstone: { at }` — which is what `cluster/ops.ts`'s `deriveTodoOps` reads to
 * emit `op: 'tombstone'` — and is compacted after the retention window, elsewhere. An already
 * tombstoned row answers false: from the caller's side it is already gone.
 *
 * `readTodos` still returns tombstoned rows, deliberately: the outbox derivation reads through it
 * (D5a) and must be able to see the delete. Board consumers filter with `isTombstoned`.
 */
export async function removeTodo(dataDir: string, id: string, options?: TodoClusterOptions): Promise<boolean> {
  return withTodosLease(dataDir, async () => {
    const { items } = await readRaw(dataDir, options);
    if (clusteringOn(options)) {
      const item = items.find((t) => t.id === id);
      if (!item || isTombstoned(item)) return false;
      item.tombstone = { at: clusterNow(options) };
      stampPending(item, options, ['tombstone']);
      await writeAtomic(dataDir, items);
      return true;
    }
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
  options?: TodoClusterOptions,
): Promise<TodoItem> {
  return withTodosLease(dataDir, async () => {
    const { items } = await readRaw(dataDir, options);
    const todo: TodoItem = { ...input, id: randomUUID(), ts: new Date().toISOString(), author };
    // Optimistic (D4): the local record is complete the moment it is written and the hub confirms
    // it afterwards. The marker rides in the SAME write as the value, under this lease. Every
    // present key is "touched" — the hub has never seen this id before.
    stampPending(todo, options, Object.keys(todo));
    items.push(todo);
    await writeAtomic(dataDir, items);
    return todo;
  });
}

/**
 * Insert `items` verbatim — id, `ts`, `author`, every field the caller already set — skipping
 * any id already present, under a SINGLE `withTodosLease`, the same lease every writer in this
 * file takes. No writer here previously exposed an insert that preserves an existing id
 * (`createTodo`, above, always mints a fresh one); its absence is what forced
 * `cluster/reconcile.ts`'s `appendLocalTodos` to re-implement this file's own `O_EXCL` lease
 * locally, and then call `readTodos` FROM INSIDE that lease — which deadlocks the moment the file
 * needs an id backfill (`readTodos` takes this same lease on that path, and a lease is not
 * reentrant) until the lease's 5s timeout, after which the throw was swallowed and the backfill
 * silently skipped. This primitive exists so reconcile, and any future caller copying a record
 * that already has an identity, never has to touch a lease directly.
 *
 * Reads with `readRaw`, not `readTodos`, for the same reason `applyHubReplica` does (see there):
 * `readTodos` takes this exact lease on its own id-backfill path, so calling it from in here would
 * be the same deadlock this function exists to remove. Whatever `readRaw` reports — including a
 * healed id for an unrelated raw agent append that predates this call — is what gets WRITTEN in
 * this same write, per `readTodos`'s 2026-08-22 correction: the healed read is what was written,
 * never a snapshot taken before someone else's write landed. Skipping that persistence here would
 * reproduce the exact bug this function exists to fix, just with the healed id assigned by this
 * call instead of `readTodos`'s.
 *
 * Idempotent by id: an id already present is skipped, so a retried reconcile pass (or any other
 * caller) never duplicates a row. Returns the items actually appended — never the skipped ones —
 * so a caller can tell "already there" from "written" instead of getting back `void`.
 */
export async function appendTodosPreservingIds(
  dataDir: string,
  items: readonly TodoItem[],
  options?: TodoClusterOptions,
): Promise<TodoItem[]> {
  if (items.length === 0) return [];
  return withTodosLease(dataDir, () => appendPreservingIdsUnderLease(dataDir, items, options));
}

/** The merge itself, factored out of `appendTodosPreservingIds` so `backupAndAppendTodosPreservingIds`
 *  below can share it — MUST be called from inside an already-held `withTodosLease`; it takes no
 *  lease of its own. See `appendTodosPreservingIds`'s own docblock for why it reads with `readRaw`,
 *  not `readTodos`, and why a heal is written even when nothing new landed. */
async function appendPreservingIdsUnderLease(
  dataDir: string,
  items: readonly TodoItem[],
  options?: TodoClusterOptions,
): Promise<TodoItem[]> {
  const { items: existing, needsRewrite } = await readRaw(dataDir, options);
  const existingIds = new Set(existing.map((t) => t.id));
  const appended: TodoItem[] = [];
  for (const item of items) {
    if (existingIds.has(item.id)) continue;
    existingIds.add(item.id);
    existing.push(item);
    appended.push(item);
  }
  // Write even when nothing new landed, if `readRaw` healed an unrelated entry: that heal is
  // only real once it is on disk (see `appendTodosPreservingIds`'s own docblock), and this is the
  // one lease-guarded write this call makes.
  if (needsRewrite || appended.length > 0) {
    await writeAtomic(dataDir, existing);
  }
  return appended;
}

/** Raw-bytes snapshot to `todos.json.bak` — `[]` when the file does not exist yet, matching
 *  `readTodos`'s own empty-inbox default. Shared by the standalone `backupTodos` (no lease of its
 *  own — a backup alone has nothing to serialize against) and `backupAndAppendTodosPreservingIds`
 *  below (called from INSIDE its lease, so the snapshot and the append it protects can never
 *  observe two different states of the file). */
async function writeTodosBackupRaw(dataDir: string): Promise<string> {
  const file = todosPath(dataDir);
  const backupFile = `${file}.bak`;
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    raw = '[]';
  }
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(backupFile, raw, 'utf8');
  return backupFile;
}

/** Standalone `todos.json.bak` snapshot, no lease — exported for
 *  `POST /cluster/todos/:projectKey/backup` (`server/cluster-routes.ts`, D21), which the reconcile
 *  transport's own contract calls before the FIRST mutation of a pass, whether or not this peer
 *  ends up receiving any adds (the zero-adds case has no append to ride along with — see
 *  `backupAndAppendTodosPreservingIds`'s own docblock for the route this is deliberately NOT
 *  shared with). */
export async function backupTodos(dataDir: string): Promise<string> {
  return writeTodosBackupRaw(dataDir);
}

/**
 * Backup-then-append under ONE lease — D21's amendment
 * (`.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, "D21", "AMENDED 2026-08-23"), and the whole
 * point of this function existing separately from `backupTodos` + `appendTodosPreservingIds`
 * composed by the caller. Composing those two as separate calls is two separate lease
 * acquisitions, which re-creates — and over a network WIDENS — a hazard already logged against
 * `cluster/reconcile.ts#reconcileProject`: the `.bak` written outside the lease that guards the
 * write it protects can be stale by a round trip's worth of concurrent local writes, not
 * microseconds, and a stale backup is worse than none because it is TRUSTED — restoring from it
 * would silently roll back a write the backup never saw.
 *
 * So `POST /cluster/todos/:projectKey/append` (`server/cluster-routes.ts`) calls this, and only
 * this: the backup is taken (fresh, whatever is on disk right now) and the append is merged, both
 * inside the SAME `withTodosLease` acquisition — nothing else can observe the file between the two
 * steps. The backup is idempotent (overwrites `todos.json.bak` with a fresher snapshot every time),
 * which is what "does not conflict with a preceding `/backup` call" means (D21's amendment,
 * verbatim) — this route's own backup simply wins, because it is the freshest.
 *
 * Returns the backup path alongside `appendTodosPreservingIds`'s own return (rows actually
 * appended, never the skipped ones) so a caller can report both.
 */
export async function backupAndAppendTodosPreservingIds(
  dataDir: string,
  items: readonly TodoItem[],
  options?: TodoClusterOptions,
): Promise<{ backupPath: string; appended: TodoItem[] }> {
  return withTodosLease(dataDir, async () => {
    const backupPath = await writeTodosBackupRaw(dataDir);
    const appended = await appendPreservingIdsUnderLease(dataDir, items, options);
    return { backupPath, appended };
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
  /**
   * Maintenance-only, added 2026-08-25 for `cezar todo start`
   * (`.ai/specs/2026-08-25-workspace-scope-routes-tasks.md`, Phase 2).
   *
   * `cezar todo add --start` could already set this AT CREATION, but nothing could set it on a todo
   * that already existed. The `input-to-tasks` workflow needs exactly that: its `file` step files
   * todos deliberately WITHOUT `--start`, so that filing and starting stay separately observable
   * and a failure to start cannot lose the filed work. Its `dispatch` step then flips the ones it
   * filed — which is a write to an existing row.
   *
   * Only ever set to `true` here. Clearing it is not offered: `markStarted` already stamps
   * `startedTaskId` when the cockpit picks the todo up, and that — not the absence of this flag —
   * is what stops it being started twice.
   */
  autostart?: true;
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
export async function updateTodo(
  dataDir: string,
  id: string,
  patch: UpdateTodoPatch,
  options?: TodoClusterOptions,
): Promise<TodoItem | undefined> {
  return withTodosLease(dataDir, async () => {
    const { items } = await readRaw(dataDir, options);
    const item = items.find((t) => t.id === id);
    if (!item) return undefined;
    const touched: string[] = [];
    if (patch.status !== undefined) {
      item.status = patch.status;
      touched.push('status');
    }
    if (patch.priority !== undefined) {
      item.priority = patch.priority;
      touched.push('priority');
    }
    if (patch.archived === true) {
      item.archivedAt = new Date().toISOString();
      touched.push('archivedAt');
    } else if (patch.archived === false) {
      delete item.archivedAt;
      touched.push('archivedAt');
    }
    if (patch.autostart === true) {
      item.autostart = true;
      touched.push('autostart');
    }
    if (patch.context !== undefined) {
      item.context = patch.context;
      touched.push('context');
    }
    if (patch.acceptanceCriteria !== undefined) {
      item.acceptanceCriteria = patch.acceptanceCriteria;
      touched.push('acceptanceCriteria');
    }
    if (patch.summary !== undefined) {
      item.summary = patch.summary;
      touched.push('summary');
    }
    // Optimistic (D4), in the same write as the change. Note what this cannot express: a patch that
    // DELETES a key (`archived: false` above) replicates as an op carrying only present fields, so
    // the removal itself does not travel. That gap lives in `cluster/ops.ts`'s derivation, not here
    // — `touched` still names `archivedAt` on a delete, honestly recording what changed even though
    // the derived op cannot carry the deletion.
    stampPending(item, options, touched);
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
 *  trail — the check shares this lease, so two concurrent launches cannot both claim the entry.
 *
 *  The boolean answer is kept as-is for every existing caller; `markStartedWithClaim` below is the
 *  same call with the hub's verdict and, on a refusal, the REASON — which a clustered cockpit has
 *  to render rather than skip silently (D15a). */
export async function markStarted(dataDir: string, id: string, taskId: string, options?: TodoStartOptions): Promise<boolean> {
  return (await markStartedWithClaim(dataDir, id, taskId, options)).started;
}

/** What the hub was asked. Carries no node identity: the hub knows which link the claim arrived on,
 *  and a node that could name its own `startedOn` could assert a claim it was never granted. */
export interface TodoStartClaim {
  dataDir: string;
  todoId: string;
  taskId: string;
}

/**
 * Ask the hub to apply this claim and wait for its verdict — `undefined` (or a throw) means the
 * hub did not answer, which is a REFUSAL here, never a fallthrough to starting anyway.
 *
 * `ClusterAckResult` is the contract's own acknowledgement shape, so this seam is the frame the
 * link already returns rather than a second one invented for this call site: `accepted: false`
 * comes back carrying the winner's `startedOn` in `fields`.
 */
export type TodoStartConfirmer = (claim: TodoStartClaim) => Promise<ClusterAckResult | undefined>;

export type TodoStartRefusal = 'not-found' | 'already-started' | 'hub-unconfirmed' | 'hub-refused';

export interface TodoStartClaimResult {
  started: boolean;
  /** The stored entry, on a start that happened. */
  todo?: TodoItem;
  reason?: TodoStartRefusal;
  /** Rendered as-is. D15a: "the refusal is a stated, rendered state — never a silent skip." */
  message?: string;
}

export interface TodoStartOptions extends TodoClusterOptions {
  /** Absent means the hub cannot be asked, which refuses exactly like an unreachable hub does —
   *  a start seam that is not wired up must not degrade into an optimistic start. */
  confirmStart?: TodoStartConfirmer;
  /** D15a row 1: a person clicked ▶ Run, or ran `cez run`, ON THIS HOST. That is a human asserting
   *  intent on the machine in front of them, and it proceeds with the link down — the local write
   *  is marked pending and the hub reconciles it. Default `false`, so the rule fails CLOSED: an
   *  autostart, which is the path that can double-start work nobody is watching, has to be granted
   *  the exemption explicitly rather than inherit it. */
  humanIntent?: boolean;
}

const HUB_UNCONFIRMED_MESSAGE = 'waiting for the hub to confirm the claim';

/** Never inside the lease: this is a network round-trip to the hub, and holding a cross-process
 *  `O_EXCL` lease across it would block every other writer of this file for the hub's timeout. */
async function askHubToConfirm(
  dataDir: string,
  id: string,
  taskId: string,
  options: TodoStartOptions | undefined,
): Promise<ClusterAckResult | undefined> {
  const confirm = options?.confirmStart;
  if (!confirm) return undefined;
  try {
    return (await confirm({ dataDir, todoId: id, taskId })) ?? undefined;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[cez] the hub did not confirm the start claim for todo ${id} — not starting (${message})`);
    return undefined;
  }
}

/**
 * `markStarted`, with the hub's verdict and a stated reason when it refuses.
 *
 * **Clustered, this is the one write that is never optimistic (D4/D9a).** Everything else in this
 * file writes locally and lets the hub confirm afterwards, because the cost of being corrected is a
 * value that changes under a reader. The cost here is a SECOND RUN of the same work on another
 * machine, spending the same subscription twice, with neither agent able to see the other — so the
 * claim goes to the hub first and the acknowledgement is the stamp. With the hub serializing
 * claims there is no second lease to disagree with the first; the exactly-once property is the
 * architecture, not a guard bolted over it.
 *
 * The order is: pre-check under the lease (cheap, and it skips a pointless round-trip for an entry
 * that is already started) → ask the hub with NO lease held → re-read and decide under the lease
 * again. The second read is authoritative and the first array is thrown away, never written back:
 * a snapshot taken before the round-trip is exactly the stale state that must not reach the file.
 */
export async function markStartedWithClaim(
  dataDir: string,
  id: string,
  taskId: string,
  options?: TodoStartOptions,
): Promise<TodoStartClaimResult> {
  const clustered = clusteringOn(options);

  if (clustered) {
    const pre = await withTodosLease(dataDir, async () => {
      const { items } = await readRaw(dataDir, options);
      const item = items.find((t) => t.id === id);
      if (!item) return { started: false, reason: 'not-found' as const };
      if (item.startedTaskId) return { started: false, reason: 'already-started' as const };
      return undefined;
    });
    if (pre) return pre;
  }

  const ack = clustered ? await askHubToConfirm(dataDir, id, taskId, options) : undefined;

  return withTodosLease(dataDir, async () => {
    const { items } = await readRaw(dataDir, options);
    const item = items.find((t) => t.id === id);
    if (!item) return { started: false, reason: 'not-found' };
    // First start wins, re-checked here rather than trusted from the pre-check: another writer —
    // or another node's replica push — may have claimed it during the round-trip.
    if (item.startedTaskId) return { started: false, reason: 'already-started' };

    const start = () => {
      item.startedTaskId = taskId;
      // Phase 2 autostart (`todo-autostart.ts`): the flag's only job was getting the entry to this
      // point, and leaving it `true` next to a `startedTaskId` would read as "still pending" to the
      // next reconcile pass. Deleted rather than set to `false` — same "absent, not falsy" contract
      // `archivedAt`/`seenAt` use elsewhere in this file. A no-op for the ordinary "▶ Run" path,
      // where the field was never set.
      delete item.autostart;
    };

    if (!clustered) {
      start();
      await writeAtomic(dataDir, items);
      return { started: true, todo: item };
    }

    if (ack && !ack.accepted) {
      // Another node won the claim. Record the winner so the board can say WHO, instead of a bare
      // refusal — `startedOn` is hub-confirmed here in the strictest sense: it is the hub's own
      // applied value, arriving in the hub's own acknowledgement.
      const winner = ack.fields?.startedOn;
      if (typeof winner === 'string' && winner) item.startedOn = winner;
      // Only when nothing else is outstanding. `cluster/ops.ts` drops a record whose `hubSeq` is at
      // or under the acked watermark, so writing this seq onto a record that still carries unsent
      // edits would silently retire them — a lost write, which is the one failure D5 exists to make
      // impossible.
      if (!item.pendingSince) item.hubSeq = ack.hubSeq;
      await writeAtomic(dataDir, items);
      return { started: false, reason: 'hub-refused', message: ack.reason ?? 'another node holds this claim' };
    }

    if (!ack) {
      if (!options?.humanIntent) {
        // Nothing is written. The absence is the point: the failure mode this refusal exists to
        // prevent is a second run, not an error, so a start that "half happened" would be worse
        // than either outcome.
        return { started: false, reason: 'hub-unconfirmed', message: HUB_UNCONFIRMED_MESSAGE };
      }
      // D15a row 1. Optimistic, and marked as such — the hub reconciles it when the link returns.
      // Computed BEFORE `start()`, which deletes `autostart` — the touched-field record has to
      // name it while it is still there to be deleted.
      const touched = item.autostart !== undefined ? ['startedTaskId', 'autostart'] : ['startedTaskId'];
      start();
      stampPending(item, options, touched);
      await writeAtomic(dataDir, items);
      return { started: true, todo: item };
    }

    start();
    if (typeof ack.fields?.startedOn === 'string' && ack.fields.startedOn) item.startedOn = ack.fields.startedOn;
    if (!item.pendingSince) item.hubSeq = ack.hubSeq;
    // Deliberately NOT stamped pending: the hub has already applied this claim, so there is nothing
    // for the outbox to owe. An existing marker from an EARLIER unsent edit is left exactly as it
    // is, for the same reason `hubSeq` is conditional above.
    await writeAtomic(dataDir, items);
    return { started: true, todo: item };
  });
}

/** The inverse of `markStarted`, for the cancel path (2026-08-22-run-cancel-restores-todo.md):
 *  "Started → cancelled" had no way back to the Filed board, since `markStarted` is the only
 *  writer of `startedTaskId` and never clears it. Keyed by `startedTaskId`, not `id` — the cancel
 *  route only ever has the run id, never the todo it was started from. Deletes the key rather than
 *  setting it `undefined`, the same "absent, not falsy" contract `archivedAt`/`autostart` use
 *  above. No-op (`undefined`) when no todo references the given run id — best-effort, mirroring
 *  `markStarted`'s own contract. */
export async function clearStartedTaskId(
  dataDir: string,
  taskId: string,
  options?: TodoClusterOptions,
): Promise<TodoItem | undefined> {
  return withTodosLease(dataDir, async () => {
    const { items } = await readRaw(dataDir, options);
    const item = items.find((t) => t.startedTaskId === taskId);
    if (!item) return undefined;
    delete item.startedTaskId;
    // `startedOn` is deliberately left alone. It is hub-confirmed state (D9a) and this file never
    // writes it on its own account; the hub releases the claim when it sees the cancel and pushes
    // that down. Clearing it here would be this node deciding a claim it was not granted — the same
    // move `markStartedWithClaim` refuses in the other direction.
    stampPending(item, options, ['startedTaskId']);
    await writeAtomic(dataDir, items);
    return item;
  });
}

// ---- the hub's replica push, applied through the store API (D7) --------------------------------

export interface ApplyHubReplicaInput {
  /** The hub's push, in hub order. */
  changes: readonly ClusterOp[];
  /** This node's own ops the hub has not acknowledged — what a correction is measured against. A
   *  local value the hub has not seen yet is not a correction; it has not been decided. */
  pending?: readonly ClusterOp[];
  /** The highest hub order already applied here. */
  appliedThroughHubSeq: number;
  now?: () => Date;
}

/**
 * Apply a hub replica push to this project's `todos.json` — **the only write-down path there is**
 * (D7). Foreign ops go through this store API, under the same `withTodosLease` every local writer
 * takes, never by writing the file: two consequences, both free. The existing `fs.watch` fires, so
 * the Tasks board and the WS topics update with no new read path anywhere; and a replicated write
 * can never interleave with a local one.
 *
 * The merge itself is `cluster/replica.ts`'s pure `applyReplica` — hub order, idempotent, per-field,
 * tombstones both directions. This function is the I/O half and nothing more: read fresh INSIDE the
 * lease, apply, write, return the corrections for the cockpit to render.
 */
export async function applyHubReplica(dataDir: string, input: ApplyHubReplicaInput): Promise<ReplicaApplyResult> {
  return withTodosLease(dataDir, async () => {
    // Read under the lease, never from a snapshot the caller took earlier: a reader that writes
    // back state it fetched before somebody else's write is the most believable way for a todo to
    // disappear with no error anywhere (one did, on production, 2026-08-22).
    //
    // `readRaw`, not `readTodos` — `readTodos` takes this same lease on the id-backfill path, and
    // taking a non-reentrant `O_EXCL` lease from inside itself deadlocks until the 5s timeout. The
    // heal happens anyway: `readRaw` assigns the ids and this write persists them.
    const { items } = await readRaw(dataDir);
    const result = applyReplica({
      local: items,
      pending: input.pending ?? [],
      changes: input.changes,
      appliedThroughHubSeq: input.appliedThroughHubSeq,
      ...(input.now ? { now: input.now } : {}),
    });
    await writeAtomic(dataDir, result.todos);
    return result;
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
