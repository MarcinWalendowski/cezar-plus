import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clusterTodoFieldsSchema, todoItemSchema, type ClusterAckResult, type ClusterOp } from '@loki-labs/better-cezar-contract';
import {
  applyHubReplica,
  clearStartedTaskId,
  createTodo,
  isTombstoned,
  markStarted,
  markStartedWithClaim,
  onTodosChanged,
  readTodos,
  removeTodo,
  todoSchema,
  todosPath,
  todosWatchActive,
  updateTodo,
  type TodoClusterOptions,
} from './todos.ts';
import { deriveTodoOps } from './cluster/ops.ts';
import { localCliAuthor } from './runs/task-author.ts';

/**
 * Per-dataDir todos watch (multi-project spec, step 2.3): each project's
 * `.ai/cezar` gets its own fs watcher + emitter, created on first
 * subscription and torn down when the last subscriber leaves — so with N
 * projects open, A's todos.json writes fire A's subscribers only.
 */

/** Poll until the assertion holds (the watch debounce is 300 ms). */
async function waitFor(assertion: () => void, timeoutMs = 4000, intervalMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      assertion();
      return;
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

describe('per-dataDir todos watch (step 2.3)', () => {
  let root: string;
  let dirA: string;
  let dirB: string;
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-todos-watch-'));
    dirA = join(root, 'project-a', '.ai/cezar');
    dirB = join(root, 'project-b', '.ai/cezar');
  });

  afterEach(() => {
    // Unsubscribe everything first so no watcher outlives its tmp dir.
    for (const off of cleanups.splice(0)) off();
    rmSync(root, { recursive: true, force: true });
  });

  const subscribe = (dataDir: string, cb: () => void) => {
    const off = onTodosChanged(dataDir, cb);
    cleanups.push(off);
    return off;
  };

  it('scopes events to the written dataDir — A fires, B stays silent', async () => {
    let a = 0;
    let b = 0;
    await fs.mkdir(dirA, { recursive: true });
    await fs.mkdir(dirB, { recursive: true });
    await fs.writeFile(todosPath(dirA), '[]');
    await fs.writeFile(todosPath(dirB), '[]');
    subscribe(dirA, () => a++);
    subscribe(dirB, () => b++);

    // macOS FSEvents can deliver the just-created files as backlog after watch() returns. Let
    // that registration noise clear before measuring the write whose project scope matters.
    await new Promise((resolve) => setTimeout(resolve, 400));
    a = 0;
    b = 0;
    await fs.writeFile(todosPath(dirA), JSON.stringify([{ id: 't1', summary: 'from A' }]));
    await waitFor(() => expect(a).toBeGreaterThan(0));
    // A full debounce window past A's delivery — a late cross-fire would land here.
    await new Promise((r) => setTimeout(r, 400));
    expect(b).toBe(0);
  });

  it('unsubscribe stops delivery to that callback while others keep receiving', async () => {
    let first = 0;
    let second = 0;
    const offFirst = subscribe(dirA, () => first++);
    subscribe(dirA, () => second++);

    offFirst();
    await fs.writeFile(todosPath(dirA), JSON.stringify([{ id: 't2', summary: 'still watched' }]));
    await waitFor(() => expect(second).toBeGreaterThan(0));
    expect(first).toBe(0);
  });

  it('tears the watch down with the last subscriber; a new subscription re-creates it', () => {
    const off1 = onTodosChanged(dirA, () => undefined);
    const off2 = onTodosChanged(dirA, () => undefined);
    expect(todosWatchActive(dirA)).toBe(true);

    off1();
    expect(todosWatchActive(dirA)).toBe(true); // one subscriber left — watch survives

    off2();
    expect(todosWatchActive(dirA)).toBe(false); // last one out closes the watcher

    const off3 = subscribe(dirA, () => undefined);
    expect(todosWatchActive(dirA)).toBe(true); // fresh subscription re-creates it
    off3();
    expect(todosWatchActive(dirA)).toBe(false);
  });

  it('a stale double-unsubscribe never tears down a re-created watch', () => {
    const off1 = onTodosChanged(dirA, () => undefined);
    off1();
    expect(todosWatchActive(dirA)).toBe(false);

    subscribe(dirA, () => undefined);
    off1(); // stale second call from the dead subscription — must be a no-op
    expect(todosWatchActive(dirA)).toBe(true);
  });
});

/**
 * `todoSchema`'s structured-spec extension (2026-08-15-knowledge-grounded-task-fanout.md, D2,
 * Phase 1): `context`, `whatToDo`, `acceptanceCriteria[]`, `knowledgeRefs[]`, `origin` — all
 * optional, additive-only. The load-bearing claim is that this did NOT change what already
 * validates: `FOLLOWUP_INSTRUCTIONS` (`handoff.ts`) has an agent append a plain
 * `{ts, taskId, summary, action?, prUrl?, suggestedSkill?, suggestedArgs?, suggestedPrompt?,
 * runnable?}` object with none of the five new keys, and that must keep parsing unchanged.
 */
describe('todoSchema (2026-08-15 structured spec, D2/Phase 1)', () => {
  it('a realistic pre-existing agent-appended entry still validates unchanged', () => {
    // A verbatim shape `FOLLOWUP_INSTRUCTIONS` asks an agent to append — written before this
    // spec existed, so it carries none of the five new fields.
    const legacyEntry = {
      ts: '2026-07-01T12:00:00.000Z',
      taskId: 'run-abc123',
      summary: 'Rotate the staging API key before it expires next week.',
      action: 'Rotate the key in the provider dashboard.',
      runnable: false,
    };
    const result = todoSchema.safeParse(legacyEntry);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.context).toBeUndefined();
      expect(result.data.whatToDo).toBeUndefined();
      expect(result.data.acceptanceCriteria).toBeUndefined();
      expect(result.data.knowledgeRefs).toBeUndefined();
      expect(result.data.origin).toBeUndefined();
    }
  });

  it('an even older entry — just a summary, nothing else — still validates', () => {
    expect(todoSchema.safeParse({ summary: 'Bare minimum, id backfilled on read.' }).success).toBe(true);
  });

  it('accepts the new fields when a composer-created entry carries them', () => {
    const result = todoSchema.safeParse({
      summary: 'Add retry backoff to the webhook sender',
      context: 'The webhook sender has no retry policy.',
      whatToDo: 'Add exponential backoff with jitter.',
      acceptanceCriteria: ['A failed POST is retried'],
      knowledgeRefs: [{ project: 'billing', slug: 'webhook-retries', title: 'Webhook retry policy' }],
      origin: 'composer',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an origin outside the closed enum', () => {
    expect(todoSchema.safeParse({ summary: 'x', origin: 'human' }).success).toBe(false);
  });

  it('rejects an acceptanceCriteria entry over the per-item cap', () => {
    const result = todoSchema.safeParse({ summary: 'x', acceptanceCriteria: ['a'.repeat(501)] });
    expect(result.success).toBe(false);
  });

  it('rejects more than 20 acceptanceCriteria items', () => {
    const result = todoSchema.safeParse({
      summary: 'x',
      acceptanceCriteria: Array.from({ length: 21 }, (_, i) => `criterion ${i}`),
    });
    expect(result.success).toBe(false);
  });
});

/**
 * `todoSchema`'s status/priority/archive extension (2026-08-17-filed-tasks-table-statuses.md):
 * three additive optional fields, same "legacy entries keep validating" discipline as D2/Phase 1
 * above — an agent's plain append carries none of them, and nothing here writes `status` for it
 * (absent reads as `'todo'` in the Filed table, not stamped on disk).
 */
describe('todoSchema (2026-08-17 status/priority/archive)', () => {
  it('accepts status, priority and archivedAt when present', () => {
    const result = todoSchema.safeParse({
      summary: 'Ship it',
      status: 'in-progress',
      priority: 'high',
      archivedAt: '2026-08-17T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('a legacy entry with none of the three still validates, all three undefined', () => {
    const result = todoSchema.safeParse({ summary: 'Bare minimum' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBeUndefined();
      expect(result.data.priority).toBeUndefined();
      expect(result.data.archivedAt).toBeUndefined();
    }
  });

  it('rejects a status outside the closed enum', () => {
    expect(todoSchema.safeParse({ summary: 'x', status: 'archived' }).success).toBe(false);
  });

  it('rejects a priority outside the closed enum', () => {
    expect(todoSchema.safeParse({ summary: 'x', priority: 'urgent' }).success).toBe(false);
  });
});

/**
 * The wire twin (`contract/src/skills.ts`'s `todoItemSchema`) and this server-side `todoSchema`
 * must carry the SAME field names — the Risk this spec names by name ("Two schema twins drift").
 * A value forgotten on one side is silent: the server would happily store a field the wire schema
 * never validates, or vice versa. This only checks the field-name SET, not per-field types
 * (`id` is optional here and required on the wire, by design — ids are backfilled on read), which
 * is exactly the granularity a name added to one side and not the other would fail.
 */
describe('todoSchema field-set parity with the contract twin (todoItemSchema)', () => {
  /**
   * **AMENDED 2026-08-22** (`.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, package 2.0). The
   * six cluster fields are on the ON-DISK schema and deliberately not (yet) on the wire twin —
   * `clusterTodoFieldsSchema`'s own docblock in the contract says the cockpit-facing shape "needs
   * that second extension", which is a different package's file. Asserting flat equality would
   * fail; deleting the assertion would drop the guard the Risk register names by name.
   *
   * So parity is asserted as a UNION — this schema's keys are exactly the wire twin's keys plus
   * the contract's own cluster field names — rather than as a hand-listed exemption. Two things
   * follow, both wanted. A name added to one side and not the other still fails, which is the whole
   * point of the check. And the assertion does not have to be edited again when the cockpit shape
   * IS extended with `placement`/`startedOn`: the union is the same set either way, where a
   * "these six are absent from the wire twin" exemption would have gone red on the day someone
   * did the right thing.
   *
   * **AMENDED AGAIN 2026-08-22, same day: `pendingFields` joined the on-disk five.** `pendingSince`
   * alone cannot say WHICH keys are owed — see `cluster/ops.ts`'s `todoContentFields` — so the
   * count below moved from five to six with it.
   */
  const CLUSTER_ONLY = Object.keys(clusterTodoFieldsSchema.shape);

  it('carries exactly the wire schema keys unioned with the contract cluster fields', () => {
    const expected = [...new Set([...Object.keys(todoItemSchema.shape), ...CLUSTER_ONLY])];
    expect(Object.keys(todoSchema.shape).sort()).toEqual(expected.sort());
  });

  it('the cluster field set is exactly the six the spec names — the floor under the union above', () => {
    expect([...CLUSTER_ONLY].sort()).toEqual([
      'hubSeq',
      'pendingFields',
      'pendingSince',
      'placement',
      'startedOn',
      'tombstone',
    ]);
  });
});

/**
 * `updateTodo` (2026-08-17-filed-tasks-table-statuses.md) — the primitive behind
 * `PATCH /:projectId/todos/:id`. `todos-patch.test.ts` covers the same behaviour through the HTTP
 * route; these exercise the primitive directly, the same split `createTodo`'s tests above use.
 */
describe('updateTodo', () => {
  let root: string;
  let dataDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-todos-update-'));
    dataDir = join(root, '.ai/cezar');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const seed = async (todo: object) => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'todos.json'), JSON.stringify([todo]), 'utf8');
  };

  it('sets status, round-tripped through disk', async () => {
    await seed({ id: 't1', summary: 'Ship it' });
    const result = await updateTodo(dataDir, 't1', { status: 'in-progress' });
    expect(result?.status).toBe('in-progress');
    const [stored] = await readTodos(dataDir);
    expect(stored?.status).toBe('in-progress');
  });

  it('sets priority', async () => {
    await seed({ id: 't1', summary: 'Ship it' });
    const result = await updateTodo(dataDir, 't1', { priority: 'medium' });
    expect(result?.priority).toBe('medium');
  });

  it('archive stamps an ISO archivedAt', async () => {
    await seed({ id: 't1', summary: 'Ship it' });
    const result = await updateTodo(dataDir, 't1', { archived: true });
    expect(typeof result?.archivedAt).toBe('string');
    expect(Number.isNaN(Date.parse(result?.archivedAt as string))).toBe(false);
  });

  it('restore removes the archivedAt KEY entirely — not a value, an absence', async () => {
    await seed({ id: 't1', summary: 'Ship it', archivedAt: '2026-08-01T00:00:00.000Z' });
    const result = await updateTodo(dataDir, 't1', { archived: false });
    expect(result).toBeDefined();
    expect('archivedAt' in (result as object)).toBe(false);
    const [stored] = await readTodos(dataDir);
    expect('archivedAt' in (stored as object)).toBe(false);
  });

  /**
   * The maintenance path a wrong-diagnosis correction needs (2026-08-22). The workspace rule is
   * that a falsehood in a HEADING gets fixed in the heading — for a todo that is `summary`, the
   * only field the board renders — so correcting `context` alone leaves the board still
   * advertising the disproved theory.
   */
  it('sets summary, so a todo founded on a wrong diagnosis can be corrected where readers see it', async () => {
    await seed({ id: 't1', summary: 'wait on liveness, then retry the step' });
    const result = await updateTodo(dataDir, 't1', { summary: 'the scope unit name collided — fixed' });
    expect(result?.summary).toBe('the scope unit name collided — fixed');
    const [stored] = await readTodos(dataDir);
    expect(stored?.summary).toBe('the scope unit name collided — fixed');
  });

  it('leaves summary alone when the patch does not carry it', async () => {
    await seed({ id: 't1', summary: 'Ship it' });
    const result = await updateTodo(dataDir, 't1', { status: 'done' });
    expect(result?.summary).toBe('Ship it');
  });

  it('returns undefined for an unknown id and writes nothing', async () => {
    await seed({ id: 't1', summary: 'Ship it' });
    const result = await updateTodo(dataDir, 'nope', { status: 'done' });
    expect(result).toBeUndefined();
    const items = await readTodos(dataDir);
    expect(items[0]?.status).toBeUndefined();
  });

  it('updates a legacy entry carrying none of the three fields, leaving its old fields untouched', async () => {
    await seed({ id: 't1', summary: 'Rotate the key', action: 'Rotate it in the dashboard' });
    const result = await updateTodo(dataDir, 't1', { status: 'blocked' });
    expect(result?.status).toBe('blocked');
    expect(result?.action).toBe('Rotate it in the dashboard');
  });

  it('a write blocked on a held lease waits, then applies once the lease frees', async () => {
    await seed({ id: 't1', summary: 'Ship it' });

    // Simulate an external writer already holding the lease — a REAL held lock file, not an
    // in-process ordering accident (the same reasoning IdentityStore's own lease test uses:
    // `identity-store.test.ts`, "the write lease actually serializes concurrent writers").
    const lockPath = join(dataDir, 'todos.lock');
    const fd = openSync(lockPath, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify({ pid: 999_999, startedAt: new Date().toISOString() }));

    const updatePromise = updateTodo(dataDir, 't1', { status: 'done' });
    let settled = false;
    void updatePromise.then(() => {
      settled = true;
    });

    // Several retry cycles' worth of time (backoff starts at 10ms, caps at 200ms) — long enough
    // to prove the write is actually WAITING on the lease, not failing fast or skipping silently.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(settled).toBe(false);

    closeSync(fd);
    unlinkSync(lockPath);

    const result = await updatePromise;
    expect(result?.status).toBe('done');
  }, 10_000);
});

/**
 * `clearStartedTaskId` (2026-08-22-run-cancel-restores-todo.md) — the inverse of `markStarted`,
 * called from the cancel route. Keyed by `startedTaskId`, not `id`: the cancel route only ever has
 * the run id, never the todo it was started from. `todos-patch.test.ts`-style route coverage lives
 * in `server/run-cancel-todo.test.ts`; these exercise the primitive directly.
 */
describe('clearStartedTaskId', () => {
  let root: string;
  let dataDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-todos-clear-started-'));
    dataDir = join(root, '.ai/cezar');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const seed = async (todo: object) => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'todos.json'), JSON.stringify([todo]), 'utf8');
  };

  it('finds the todo by startedTaskId — NOT by its own id — and deletes the KEY entirely', async () => {
    await seed({ id: 't1', summary: 'Ship it', startedTaskId: 'run-abc' });
    const result = await clearStartedTaskId(dataDir, 'run-abc');
    expect(result).toBeDefined();
    expect('startedTaskId' in (result as object)).toBe(false);
    const [stored] = await readTodos(dataDir);
    expect('startedTaskId' in (stored as object)).toBe(false);
  });

  it('returns undefined when no todo references the given run id, and writes nothing', async () => {
    await seed({ id: 't1', summary: 'Ship it', startedTaskId: 'run-abc' });
    const result = await clearStartedTaskId(dataDir, 'run-does-not-exist');
    expect(result).toBeUndefined();
    const [stored] = await readTodos(dataDir);
    expect(stored?.startedTaskId).toBe('run-abc');
  });

  it('a write blocked on a held lease waits, then applies once the lease frees', async () => {
    await seed({ id: 't1', summary: 'Ship it', startedTaskId: 'run-abc' });

    // Same real held lock file as `updateTodo`'s own lease test above, not an in-process
    // ordering accident.
    const lockPath = join(dataDir, 'todos.lock');
    const fd = openSync(lockPath, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify({ pid: 999_999, startedAt: new Date().toISOString() }));

    const clearPromise = clearStartedTaskId(dataDir, 'run-abc');
    let settled = false;
    void clearPromise.then(() => {
      settled = true;
    });

    // Several retry cycles' worth of time (backoff starts at 10ms, caps at 200ms) — long enough
    // to prove the write is actually WAITING on the lease, not failing fast or skipping silently.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(settled).toBe(false);

    closeSync(fd);
    unlinkSync(lockPath);

    const result = await clearPromise;
    expect(result && 'startedTaskId' in result).toBe(false);
  }, 10_000);
});

/**
 * `createTodo` (2026-08-15-knowledge-grounded-task-fanout.md, Phase 1) — the primitive behind
 * `POST /todos`, and the concurrency risk the spec calls out by name: until now the only writer
 * besides the server was an agent subprocess appending to the same file, and `todos.ts` does a
 * read-modify-write of the WHOLE array. `todos-create.test.ts` covers the same race through the
 * HTTP route; these exercise the primitive directly, without the server in between.
 */
describe('createTodo', () => {
  let root: string;
  let dataDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-todos-create-'));
    dataDir = join(root, '.ai/cezar');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('assigns id and ts, and appends to an empty inbox', async () => {
    const todo = await createTodo(dataDir, { summary: 'First task' }, localCliAuthor('cli-todo-add'));
    expect(todo.id).toBeTruthy();
    expect(todo.ts).toBeTruthy();
    expect(todo.summary).toBe('First task');
    expect(await readTodos(dataDir)).toEqual([todo]);
  });

  it('appends without disturbing an existing entry', async () => {
    const first = await createTodo(dataDir, { summary: 'First' }, localCliAuthor('cli-todo-add'));
    const second = await createTodo(dataDir, { summary: 'Second' }, localCliAuthor('cli-todo-add'));
    const items = await readTodos(dataDir);
    expect(items.map((t) => t.id).sort()).toEqual([first.id, second.id].sort());
  });

  it('two createTodo calls racing the same dataDir both survive — the write lease actually serializes them', async () => {
    const [a, b] = await Promise.all([
      createTodo(dataDir, { summary: 'Racer A' }, localCliAuthor('cli-todo-add')),
      createTodo(dataDir, { summary: 'Racer B' }, localCliAuthor('cli-todo-add')),
    ]);
    expect(a.id).not.toBe(b.id);
    const items = await readTodos(dataDir);
    // Both survive: neither write's read-modify-write cycle clobbered the other's.
    expect(items).toHaveLength(2);
    expect(items.map((t) => t.summary).sort()).toEqual(['Racer A', 'Racer B']);
  });

  it('twenty concurrent createTodo calls all survive', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => createTodo(dataDir, { summary: `Task ${i}` }, localCliAuthor('cli-todo-add'))),
    );
    const ids = new Set(results.map((t) => t.id));
    expect(ids.size).toBe(20); // every id unique — no two calls collided on the same object
    const items = await readTodos(dataDir);
    expect(items).toHaveLength(20);
  });
});

/**
 * The cluster's optimistic-write marker (`.ai/specs/2026-08-22-multi-node-cezar-cluster.md`,
 * D4 · D5 · D5a · D6 · D13 · D15a — plan package 2.0 + 2.3).
 *
 * Three of these are negative controls rather than features, and they are the ones worth reading
 * first: **clustering off writes the same bytes it always did**, **`markStarted` does not stamp
 * optimistically**, and **heal-on-read is idempotent**. Each of the three fails silently in
 * production if it regresses — a file that grew a key nobody expected, a second run of the same
 * work on another machine, a raw append re-stamped on every read — so each is asserted directly
 * rather than inferred from a feature test passing.
 */

/** Resolved through `clusterModeFromEnv`, the real path, rather than the `clustered` test override
 *  — a test that bypasses the resolution cannot notice the resolution breaking. */
const CLUSTER_OFF: TodoClusterOptions = { env: {} };
const CLUSTER_ON: TodoClusterOptions = { env: { CEZ_CLUSTER: '1' } };

const CLUSTER_KEYS = ['pendingSince', 'pendingFields', 'hubSeq', 'tombstone', 'placement', 'startedOn'] as const;

function ackAccepted(fields?: Record<string, unknown>): ClusterAckResult {
  return { opId: 'op-1', hubSeq: 7, accepted: true, ...(fields ? { fields } : {}) };
}

describe('cluster off — the file is byte-identical to what a pre-cluster cezar wrote', () => {
  let root: string;
  let dataDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-todos-cluster-off-'));
    dataDir = join(root, '.ai/cezar');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const raw = () => readFileSync(todosPath(dataDir), 'utf8');

  it('writes exactly the keys it wrote before, in the order it wrote them, with no trailing newline', async () => {
    const todo = await createTodo(dataDir, { summary: 'Ship it' }, localCliAuthor('cli-todo-add'), CLUSTER_OFF);
    await updateTodo(dataDir, todo.id, { status: 'done' }, CLUSTER_OFF);
    await markStarted(dataDir, todo.id, 'run-1', CLUSTER_OFF);

    // Reconstructed independently, key by key and in order — NOT re-serialized from what the file
    // happens to contain, which would agree with any extra key this change might have added.
    //
    // The order is not the order the writers assign in: every read re-emits the entry in `todoSchema`
    // shape order (zod rebuilds the object from the shape), and a key a writer adds afterwards is
    // appended — which is why `status` sits mid-record and `startedTaskId`, written by the last
    // pass, sits last. Pinning that exactly is the point: a cluster field written anywhere in this
    // sequence would land visibly inside these bytes.
    const expected = [
      { id: todo.id, ts: todo.ts, summary: 'Ship it', status: 'done', author: todo.author, startedTaskId: 'run-1' },
    ];
    expect(raw()).toBe(JSON.stringify(expected, null, 2));
    expect(raw().endsWith('\n')).toBe(false);
  });

  it('no cluster key appears anywhere in the bytes — not on create, update, start, cancel or delete', async () => {
    const todo = await createTodo(dataDir, { summary: 'Ship it' }, localCliAuthor('cli-todo-add'), CLUSTER_OFF);
    const other = await createTodo(dataDir, { summary: 'Keep me' }, localCliAuthor('cli-todo-add'), CLUSTER_OFF);
    await updateTodo(dataDir, todo.id, { priority: 'high' }, CLUSTER_OFF);
    await markStarted(dataDir, todo.id, 'run-1', CLUSTER_OFF);
    await clearStartedTaskId(dataDir, 'run-1', CLUSTER_OFF);
    await removeTodo(dataDir, other.id, CLUSTER_OFF);

    for (const key of CLUSTER_KEYS) expect(raw()).not.toContain(key);
  });

  it('delete still REMOVES the row, rather than tombstoning it', async () => {
    const todo = await createTodo(dataDir, { summary: 'Delete me' }, localCliAuthor('cli-todo-add'), CLUSTER_OFF);
    expect(await removeTodo(dataDir, todo.id, CLUSTER_OFF)).toBe(true);
    expect(await readTodos(dataDir, CLUSTER_OFF)).toEqual([]);
    expect(raw()).toBe('[]');
  });

  it('with no options at all and CEZ_CLUSTER unset — the production default — nothing is stamped', async () => {
    const previous = process.env.CEZ_CLUSTER;
    delete process.env.CEZ_CLUSTER;
    try {
      const todo = await createTodo(dataDir, { summary: 'Default path' }, localCliAuthor('cli-todo-add'));
      await updateTodo(dataDir, todo.id, { status: 'blocked' });
      for (const key of CLUSTER_KEYS) expect(raw()).not.toContain(key);
    } finally {
      if (previous === undefined) delete process.env.CEZ_CLUSTER;
      else process.env.CEZ_CLUSTER = previous;
    }
  });

  /**
   * The positive control the three assertions above need. Without it they would all pass against a
   * build that stamps nothing at all, anywhere — which is the cheapest way for "cluster off is
   * unchanged" to be true and worthless at the same time.
   */
  it('the same sequence WITH clustering on does write a marker — so the assertions above can fail', async () => {
    const todo = await createTodo(dataDir, { summary: 'Ship it' }, localCliAuthor('cli-todo-add'), CLUSTER_ON);
    expect(raw()).toContain('pendingSince');
    expect(typeof todo.pendingSince).toBe('string');
    expect(raw()).toContain('pendingFields');
  });
});

describe('pendingSince — the optimistic marker, written inside the existing lease (D4/D5)', () => {
  let root: string;
  let dataDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-todos-pending-'));
    dataDir = join(root, '.ai/cezar');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('createTodo stamps it, in the same write as the value', async () => {
    const todo = await createTodo(dataDir, { summary: 'New work' }, localCliAuthor('cli-todo-add'), CLUSTER_ON);
    const [stored] = await readTodos(dataDir, CLUSTER_ON);
    // The marker and the value land together or not at all — that is the whole of D5's crash-safety
    // claim, so it is asserted against the FILE, not against the returned object.
    expect(stored?.pendingSince).toBe(todo.pendingSince);
    expect(Number.isNaN(Date.parse(stored?.pendingSince as string))).toBe(false);
    // A create is new to the hub in its entirety — nothing to narrow against yet.
    expect(stored?.pendingFields).toEqual(expect.arrayContaining(['summary']));
  });

  it('updateTodo stamps an entry that had no marker', async () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(todosPath(dataDir), JSON.stringify([{ id: 't1', summary: 'Ship it' }]), 'utf8');
    const result = await updateTodo(dataDir, 't1', { status: 'done' }, CLUSTER_ON);
    expect(typeof result?.pendingSince).toBe('string');
    expect(result?.pendingFields).toEqual(['status']);
  });

  it('clearStartedTaskId stamps, so a cancel is a write the hub hears about', async () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(todosPath(dataDir), JSON.stringify([{ id: 't1', summary: 'Ship it', startedTaskId: 'run-9' }]), 'utf8');
    const result = await clearStartedTaskId(dataDir, 'run-9', CLUSTER_ON);
    expect(result?.startedTaskId).toBeUndefined();
    expect(typeof result?.pendingSince).toBe('string');
    expect(result?.pendingFields).toEqual(['startedTaskId']);
  });

  it('a second edit keeps the FIRST marker — "pending since when", not "last touched" — and UNIONS pendingFields', async () => {
    const todo = await createTodo(dataDir, { summary: 'Edit me' }, localCliAuthor('cli-todo-add'), {
      ...CLUSTER_ON,
      now: () => new Date('2026-08-22T10:00:00.000Z'),
    });
    const updated = await updateTodo(dataDir, todo.id, { status: 'done' }, {
      ...CLUSTER_ON,
      now: () => new Date('2026-08-22T18:00:00.000Z'),
    });
    // Eight hours of unsent backlog has to stay visible as eight hours. Refreshing the marker on
    // every edit would make a permanently-stuck outbox look permanently fresh.
    expect(updated?.pendingSince).toBe('2026-08-22T10:00:00.000Z');
    // The create's own fields are still owed — the update UNIONS 'status' in rather than replacing
    // the array the create wrote.
    expect(updated?.pendingFields).toEqual(expect.arrayContaining(['summary', 'status']));
  });

  it('the next edit after a settle starts pendingFields FRESH, not unioned onto a stale leftover — self-heals `applyReplica` not clearing this array', async () => {
    // `applyReplica` (cluster/replica.ts) clears `pendingSince` on settle but was written before
    // `pendingFields` existed, so it does not clear this array too — this is what that leftover
    // looks like on disk: no `pendingSince`, but a `pendingFields` from a cycle that already
    // settled. If the next edit UNIONED onto it, the stale 'summary' would ride forever.
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(todosPath(dataDir), JSON.stringify([{ id: 't1', summary: 'Ship it', pendingFields: ['summary'] }]), 'utf8');
    const result = await updateTodo(dataDir, 't1', { priority: 'high' }, CLUSTER_ON);
    expect(result?.pendingFields).toEqual(['priority']);
  });

  it('deriveTodoOps picks the marked records up — the marker is where cluster/ops.ts looks', async () => {
    const marked = await createTodo(dataDir, { summary: 'Send me' }, localCliAuthor('cli-todo-add'), CLUSTER_ON);
    const ops = deriveTodoOps({
      nodeId: 'node-a',
      projectKey: 'cezar',
      todos: await readTodos(dataDir, CLUSTER_ON),
      ackedThroughHubSeq: 0,
    });
    expect(ops.map((op) => op.entityId)).toEqual([marked.id]);
    expect(ops[0]?.op).toBe('upsert');
  });

  it('deriveTodoOps narrows the op to exactly what THIS edit touched, once the record has settled and been edited again', async () => {
    // A settled baseline: no pendingSince, so the hub already has `priority` — the create-time
    // whole-record cycle is over. The NEXT edit starts a fresh, narrow pendingFields cycle.
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(todosPath(dataDir), JSON.stringify([{ id: 't1', summary: 'Ship it', priority: 'low' }]), 'utf8');
    await updateTodo(dataDir, 't1', { status: 'done' }, CLUSTER_ON);
    const ops = deriveTodoOps({
      nodeId: 'node-a',
      projectKey: 'cezar',
      todos: await readTodos(dataDir, CLUSTER_ON),
      ackedThroughHubSeq: 0,
    });
    expect(ops).toHaveLength(1);
    // Only `status` travels — `summary` and `priority` were already at the hub and pendingFields
    // says so. Before this amendment this op would have carried all three.
    expect(ops[0]?.fields).toEqual({ status: 'done' });
  });
});

describe('removeTodo, clustered — a delete is a tombstone, never a removal (D6)', () => {
  let root: string;
  let dataDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-todos-tombstone-'));
    dataDir = join(root, '.ai/cezar');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps the row, marks it tombstoned, and marks it pending', async () => {
    const todo = await createTodo(dataDir, { summary: 'Delete me' }, localCliAuthor('cli-todo-add'), CLUSTER_ON);
    expect(await removeTodo(dataDir, todo.id, CLUSTER_ON)).toBe(true);

    const items = await readTodos(dataDir, CLUSTER_ON);
    expect(items).toHaveLength(1);
    expect(isTombstoned(items[0] as { tombstone?: { at: string } })).toBe(true);
    expect(typeof items[0]?.tombstone?.at).toBe('string');
    expect(typeof items[0]?.pendingSince).toBe('string');
    expect(items[0]?.pendingFields).toContain('tombstone');
  });

  it('derives a tombstone op, not an upsert — the delete is what travels', async () => {
    const todo = await createTodo(dataDir, { summary: 'Delete me' }, localCliAuthor('cli-todo-add'), CLUSTER_ON);
    await removeTodo(dataDir, todo.id, CLUSTER_ON);
    const ops = deriveTodoOps({
      nodeId: 'node-a',
      projectKey: 'cezar',
      todos: await readTodos(dataDir, CLUSTER_ON),
      ackedThroughHubSeq: 0,
    });
    expect(ops).toHaveLength(1);
    expect(ops[0]?.op).toBe('tombstone');
    expect(ops[0]?.entityId).toBe(todo.id);
  });

  it('a second delete answers false and does not move the tombstone timestamp', async () => {
    const todo = await createTodo(dataDir, { summary: 'Delete me' }, localCliAuthor('cli-todo-add'), CLUSTER_ON);
    await removeTodo(dataDir, todo.id, {
      ...CLUSTER_ON,
      now: () => new Date('2026-08-22T10:00:00.000Z'),
    });
    expect(
      await removeTodo(dataDir, todo.id, { ...CLUSTER_ON, now: () => new Date('2026-08-22T18:00:00.000Z') }),
    ).toBe(false);
    const [stored] = await readTodos(dataDir, CLUSTER_ON);
    expect(stored?.tombstone?.at).toBe('2026-08-22T10:00:00.000Z');
  });
});

describe('markStarted, clustered — the one write that waits for the hub (D4/D9a/D15a)', () => {
  let root: string;
  let dataDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-todos-claim-'));
    dataDir = join(root, '.ai/cezar');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(todosPath(dataDir), JSON.stringify([{ id: 't1', summary: 'Ship it', autostart: true }]), 'utf8');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const raw = () => readFileSync(todosPath(dataDir), 'utf8');

  /**
   * **The negative control.** The failure mode this rule exists to prevent is a SECOND RUN of the
   * same work on another machine — not an error — so the assertion has to be the absence of a
   * start, not the presence of a complaint. A hub that cannot be reached must leave the entry
   * exactly as it found it.
   */
  it('with the hub unreachable it does NOT mark the todo started, and writes nothing at all', async () => {
    const before = raw();
    const result = await markStartedWithClaim(dataDir, 't1', 'run-1', {
      ...CLUSTER_ON,
      confirmStart: async () => {
        throw new Error('link down');
      },
    });

    expect(result.started).toBe(false);
    expect(result.reason).toBe('hub-unconfirmed');
    expect(result.message).toContain('waiting for the hub');
    const [stored] = await readTodos(dataDir, CLUSTER_ON);
    expect(stored?.startedTaskId).toBeUndefined();
    expect(stored?.startedOn).toBeUndefined();
    // …and no half-write: not a marker, not a cleared `autostart`, nothing.
    expect(stored?.pendingSince).toBeUndefined();
    expect(stored?.autostart).toBe(true);
    expect(raw()).toBe(before);
  });

  it('an unwired confirmer refuses exactly like an unreachable one — a missing seam is not consent', async () => {
    const result = await markStartedWithClaim(dataDir, 't1', 'run-1', CLUSTER_ON);
    expect(result.started).toBe(false);
    expect(result.reason).toBe('hub-unconfirmed');
    expect((await readTodos(dataDir, CLUSTER_ON))[0]?.startedTaskId).toBeUndefined();
  });

  it('the boolean wrapper reports the refusal too, so an old caller cannot read it as a start', async () => {
    expect(await markStarted(dataDir, 't1', 'run-1', CLUSTER_ON)).toBe(false);
  });

  it("on the hub's acceptance it stamps startedTaskId, the hub's startedOn and hubSeq — and no pending marker", async () => {
    const result = await markStartedWithClaim(dataDir, 't1', 'run-1', {
      ...CLUSTER_ON,
      confirmStart: async () => ackAccepted({ startedOn: 'node-hel1' }),
    });

    expect(result.started).toBe(true);
    const [stored] = await readTodos(dataDir, CLUSTER_ON);
    expect(stored?.startedTaskId).toBe('run-1');
    expect(stored?.startedOn).toBe('node-hel1');
    expect(stored?.hubSeq).toBe(7);
    expect(stored?.autostart).toBeUndefined();
    // Nothing is owed to the outbox: the hub applied this claim itself.
    expect(stored?.pendingSince).toBeUndefined();
    expect(stored?.pendingFields).toBeUndefined();
    expect(
      deriveTodoOps({ nodeId: 'node-a', projectKey: 'cezar', todos: await readTodos(dataDir, CLUSTER_ON), ackedThroughHubSeq: 0 }),
    ).toEqual([]);
  });

  it('the claim is sent to the hub BEFORE anything is written locally', async () => {
    const observed: Array<string | undefined> = [];
    await markStartedWithClaim(dataDir, 't1', 'run-1', {
      ...CLUSTER_ON,
      confirmStart: async () => {
        // Read the file from inside the confirmer: if the local write had already happened, the
        // start would be optimistic no matter what the hub went on to say.
        observed.push((JSON.parse(raw()) as Array<{ startedTaskId?: string }>)[0]?.startedTaskId);
        return ackAccepted();
      },
    });
    expect(observed).toEqual([undefined]);
  });

  it('when another node won, it records the winner and refuses with the reason', async () => {
    const result = await markStartedWithClaim(dataDir, 't1', 'run-1', {
      ...CLUSTER_ON,
      confirmStart: async () => ({
        opId: 'op-2',
        hubSeq: 11,
        accepted: false,
        fields: { startedOn: 'node-mac' },
        reason: 'node-mac already holds this claim',
      }),
    });

    expect(result.started).toBe(false);
    expect(result.reason).toBe('hub-refused');
    expect(result.message).toContain('node-mac');
    const [stored] = await readTodos(dataDir, CLUSTER_ON);
    expect(stored?.startedTaskId).toBeUndefined();
    expect(stored?.startedOn).toBe('node-mac'); // who won is visible, not just that we lost
  });

  /** D15a row 1: a person clicking ▶ Run on this host is asserting intent on the machine in front
   *  of them, and that proceeds with the link down. The half that matters is that it is marked
   *  pending — an unmarked local start would never reach the hub at all. */
  it('a human start proceeds with the hub down, optimistically and marked as such', async () => {
    const result = await markStartedWithClaim(dataDir, 't1', 'run-1', {
      ...CLUSTER_ON,
      humanIntent: true,
      confirmStart: async () => undefined,
    });

    expect(result.started).toBe(true);
    const [stored] = await readTodos(dataDir, CLUSTER_ON);
    expect(stored?.startedTaskId).toBe('run-1');
    expect(typeof stored?.pendingSince).toBe('string');
    // Never claimed on this node's own say-so — `startedOn` is the hub's word, and the hub has not
    // spoken. Asserting this is what keeps the exemption from swallowing the rule.
    expect(stored?.startedOn).toBeUndefined();
    // Names BOTH keys `start()` touched — including `autostart`, which it DELETES (the fixture
    // seeds it `true`) — even though only `startedTaskId` can actually ride in the derived op's
    // `fields` (a deletion cannot travel; see `cluster/ops.ts`'s known gap).
    expect(stored?.pendingFields?.slice().sort()).toEqual(['autostart', 'startedTaskId']);
  });

  it('first start still wins: an already-started entry never reaches the hub', async () => {
    writeFileSync(todosPath(dataDir), JSON.stringify([{ id: 't1', summary: 'Ship it', startedTaskId: 'run-first' }]), 'utf8');
    let asked = 0;
    const result = await markStartedWithClaim(dataDir, 't1', 'run-second', {
      ...CLUSTER_ON,
      confirmStart: async () => {
        asked++;
        return ackAccepted();
      },
    });
    expect(result.started).toBe(false);
    expect(result.reason).toBe('already-started');
    expect(asked).toBe(0);
    expect((await readTodos(dataDir, CLUSTER_ON))[0]?.startedTaskId).toBe('run-first');
  });

  it('a claim that lands while the hub is answering loses — the re-read under the lease decides', async () => {
    const result = await markStartedWithClaim(dataDir, 't1', 'run-1', {
      ...CLUSTER_ON,
      confirmStart: async () => {
        // Another writer (a replica push, or this node's own second launch) claims it mid-flight.
        writeFileSync(
          todosPath(dataDir),
          JSON.stringify([{ id: 't1', summary: 'Ship it', startedTaskId: 'run-elsewhere' }]),
          'utf8',
        );
        return ackAccepted();
      },
    });

    expect(result.started).toBe(false);
    expect(result.reason).toBe('already-started');
    // The pre-round-trip snapshot is never written back over the newer state.
    expect((await readTodos(dataDir, CLUSTER_ON))[0]?.startedTaskId).toBe('run-elsewhere');
  });

  it('cluster off is unchanged: no confirmer is consulted and the entry starts', async () => {
    let asked = 0;
    const result = await markStartedWithClaim(dataDir, 't1', 'run-1', {
      ...CLUSTER_OFF,
      confirmStart: async () => {
        asked++;
        return ackAccepted();
      },
    });
    expect(result.started).toBe(true);
    expect(asked).toBe(0);
    const [stored] = await readTodos(dataDir, CLUSTER_OFF);
    expect(stored?.startedTaskId).toBe('run-1');
    expect(stored?.autostart).toBeUndefined();
  });
});

/**
 * Verification 15 — heal-on-read. `handoff.ts`'s `FOLLOWUP_INSTRUCTIONS` has an agent append a raw
 * object with no `id` and no marker, and `readRaw` already heals exactly that for ids. All three
 * clauses of the spec's item are here: stamped ONCE, a second read changes nothing, and the derived
 * op carries the id the FILE kept — which is the clause that catches the id the caller was handed
 * differing from the id on disk.
 */
describe('heal-on-read: a raw agent append is stamped once and only once (v15)', () => {
  let root: string;
  let dataDir: string;

  const RAW_APPEND = {
    ts: '2026-08-22T09:00:00.000Z',
    taskId: 'run-abc123',
    summary: 'Follow up on the flaky watch test',
    runnable: false,
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-todos-heal-'));
    dataDir = join(root, '.ai/cezar');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(todosPath(dataDir), JSON.stringify([RAW_APPEND]), 'utf8');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const raw = () => readFileSync(todosPath(dataDir), 'utf8');

  it('stamps id and marker once; a second read changes nothing; the derived op carries the id the file kept', async () => {
    const [healed] = await readTodos(dataDir, CLUSTER_ON);
    expect(healed?.id).toBeTruthy();
    expect(typeof healed?.pendingSince).toBe('string');
    // The whole entry is new to the hub — it never had an id before this read — so pendingFields
    // covers everything it carries, not a narrow patch.
    expect(healed?.pendingFields).toEqual(expect.arrayContaining(['summary', 'taskId', 'ts']));

    const afterFirstRead = raw();
    const onDisk = (JSON.parse(afterFirstRead) as Array<{ id: string; pendingSince?: string }>)[0];
    // The id the caller was handed IS the id the file kept. Two `readRaw` passes each mint a fresh
    // uuid, so this is a real hazard and not a formality.
    expect(onDisk?.id).toBe(healed?.id);
    expect(onDisk?.pendingSince).toBe(healed?.pendingSince);

    const second = await readTodos(dataDir, CLUSTER_ON);
    expect(raw()).toBe(afterFirstRead); // idempotent, to the byte
    expect(second[0]?.id).toBe(healed?.id);
    expect(second[0]?.pendingSince).toBe(healed?.pendingSince);
    expect(second[0]?.pendingFields).toEqual(healed?.pendingFields);

    const ops = deriveTodoOps({ nodeId: 'node-a', projectKey: 'cezar', todos: second, ackedThroughHubSeq: 0 });
    expect(ops).toHaveLength(1);
    expect(ops[0]?.entityId).toBe(onDisk?.id);
  });

  it('a writer reaching the same raw append heals it identically — the stamp is not read-path-only', async () => {
    await createTodo(dataDir, { summary: 'Second entry' }, localCliAuthor('cli-todo-add'), CLUSTER_ON);
    const items = await readTodos(dataDir, CLUSTER_ON);
    expect(items).toHaveLength(2);
    expect(typeof items[0]?.pendingSince).toBe('string');
    expect(items[0]?.summary).toBe(RAW_APPEND.summary);
  });

  it('cluster off heals the id and stamps NOTHING — the negative control for the stamp', async () => {
    const [healed] = await readTodos(dataDir, CLUSTER_OFF);
    expect(healed?.id).toBeTruthy();
    expect(healed?.pendingSince).toBeUndefined();
    expect(healed?.pendingFields).toBeUndefined();
    expect(raw()).not.toContain('pendingSince');
    expect(raw()).not.toContain('pendingFields');
    expect(
      deriveTodoOps({ nodeId: 'node-a', projectKey: 'cezar', todos: await readTodos(dataDir, CLUSTER_OFF), ackedThroughHubSeq: 0 }),
    ).toEqual([]);
  });
});

/**
 * D13 — an op, or a field, a node does not understand is stored and re-emitted, never dropped. The
 * box self-deploys ~10×/day and the Mac lags, so schema skew is permanent: without this the OLDEST
 * node in the cluster silently truncates everyone's history on its next rewrite.
 */
describe('unknown fields survive a read-modify-write (D13)', () => {
  let root: string;
  let dataDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-todos-unknown-'));
    dataDir = join(root, '.ai/cezar');
    mkdirSync(dataDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('a field a newer node wrote is still there after this build rewrites the file', async () => {
    writeFileSync(
      todosPath(dataDir),
      JSON.stringify([{ id: 't1', summary: 'Written by a newer node', fromTheFuture: { weight: 3 } }]),
      'utf8',
    );
    await updateTodo(dataDir, 't1', { status: 'done' }, CLUSTER_ON);
    const stored = (JSON.parse(readFileSync(todosPath(dataDir), 'utf8')) as Array<Record<string, unknown>>)[0];
    expect(stored?.fromTheFuture).toEqual({ weight: 3 });
    expect(stored?.status).toBe('done');
  });

  it('an unknown key inside `placement` survives too — passthrough at every object level', async () => {
    writeFileSync(
      todosPath(dataDir),
      JSON.stringify([{ id: 't1', summary: 'Pinned', placement: { node: 'node-hel1', tier: 'heavy' } }]),
      'utf8',
    );
    await updateTodo(dataDir, 't1', { priority: 'low' }, CLUSTER_ON);
    const stored = (JSON.parse(readFileSync(todosPath(dataDir), 'utf8')) as Array<Record<string, unknown>>)[0];
    expect(stored?.placement).toEqual({ node: 'node-hel1', tier: 'heavy' });
  });
});

/**
 * D7 — foreign ops are applied THROUGH the store API, under the existing lease, never by writing
 * the file. Two consequences, both free: the existing `fs.watch` fires so the board updates with no
 * new read path, and a replicated write can never interleave with a local one. The merge itself is
 * `cluster/replica.ts`'s, tested there; what is asserted here is the I/O half.
 */
describe('applyHubReplica — the hub write-down path', () => {
  let root: string;
  let dataDir: string;

  const op = (over: Partial<ClusterOp> & Pick<ClusterOp, 'entityId' | 'op'>): ClusterOp => ({
    opId: `op-${over.entityId}-${over.hubSeq ?? 0}`,
    nodeId: 'node-hub',
    ts: '2026-08-22T12:00:00.000Z',
    scope: 'project',
    projectKey: 'cezar',
    entity: 'todo',
    ...over,
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-todos-replica-'));
    dataDir = join(root, '.ai/cezar');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(todosPath(dataDir), JSON.stringify([{ id: 't1', summary: 'Ship it', pendingSince: '2026-08-22T09:00:00.000Z' }]), 'utf8');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('applies the hub order to the file and clears the marker the hub has now spoken for', async () => {
    const result = await applyHubReplica(dataDir, {
      changes: [op({ entityId: 't1', op: 'upsert', fields: { status: 'done' }, hubSeq: 4 })],
      appliedThroughHubSeq: 0,
    });

    expect(result.appliedThroughHubSeq).toBe(4);
    const [stored] = await readTodos(dataDir, CLUSTER_ON);
    expect(stored?.status).toBe('done');
    expect(stored?.hubSeq).toBe(4);
    expect(stored?.pendingSince).toBeUndefined();
  });

  it('a change at or below the watermark is skipped, not re-applied', async () => {
    const result = await applyHubReplica(dataDir, {
      changes: [op({ entityId: 't1', op: 'upsert', fields: { status: 'blocked' }, hubSeq: 2 })],
      appliedThroughHubSeq: 5,
    });
    expect(result.skipped).toBe(1);
    expect((await readTodos(dataDir, CLUSTER_ON))[0]?.status).toBeUndefined();
  });

  it('a hub tombstone lands as a tombstone, and the row stays', async () => {
    await applyHubReplica(dataDir, {
      changes: [op({ entityId: 't1', op: 'tombstone', hubSeq: 6 })],
      appliedThroughHubSeq: 0,
    });
    const items = await readTodos(dataDir, CLUSTER_ON);
    expect(items).toHaveLength(1);
    expect(isTombstoned(items[0] as { tombstone?: { at: string } })).toBe(true);
  });

  it('takes the same write lease every local writer takes — a held lease blocks it', async () => {
    // Hold the lease the way a crashed writer would, then release it after a beat: the apply must
    // WAIT rather than write past it. If it wrote the file directly, this would finish instantly
    // with the lease still held.
    const lockPath = join(dataDir, 'todos.lock');
    const fd = openSync(lockPath, 'wx', 0o600);
    let released = false;
    setTimeout(() => {
      released = true;
      closeSync(fd);
      unlinkSync(lockPath);
    }, 150);

    await applyHubReplica(dataDir, {
      changes: [op({ entityId: 't1', op: 'upsert', fields: { status: 'done' }, hubSeq: 3 })],
      appliedThroughHubSeq: 0,
    });
    expect(released).toBe(true);
    expect((await readTodos(dataDir, CLUSTER_ON))[0]?.status).toBe('done');
  });

  it('reports a correction when the hub disagreed with the optimistic local value', async () => {
    const result = await applyHubReplica(dataDir, {
      changes: [op({ entityId: 't1', op: 'upsert', fields: { status: 'blocked' }, hubSeq: 8 })],
      pending: [op({ entityId: 't1', op: 'upsert', fields: { status: 'done' }, hubSeq: undefined })],
      appliedThroughHubSeq: 0,
    });
    expect(result.corrections.map((c) => c.field)).toEqual(['status']);
    expect(result.corrections[0]?.hubValue).toBe('blocked');
  });
});
