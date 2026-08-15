import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTodo, onTodosChanged, readTodos, todoSchema, todosPath, todosWatchActive } from './todos.ts';

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
    const todo = await createTodo(dataDir, { summary: 'First task' });
    expect(todo.id).toBeTruthy();
    expect(todo.ts).toBeTruthy();
    expect(todo.summary).toBe('First task');
    expect(await readTodos(dataDir)).toEqual([todo]);
  });

  it('appends without disturbing an existing entry', async () => {
    const first = await createTodo(dataDir, { summary: 'First' });
    const second = await createTodo(dataDir, { summary: 'Second' });
    const items = await readTodos(dataDir);
    expect(items.map((t) => t.id).sort()).toEqual([first.id, second.id].sort());
  });

  it('two createTodo calls racing the same dataDir both survive — the write lease actually serializes them', async () => {
    const [a, b] = await Promise.all([
      createTodo(dataDir, { summary: 'Racer A' }),
      createTodo(dataDir, { summary: 'Racer B' }),
    ]);
    expect(a.id).not.toBe(b.id);
    const items = await readTodos(dataDir);
    // Both survive: neither write's read-modify-write cycle clobbered the other's.
    expect(items).toHaveLength(2);
    expect(items.map((t) => t.summary).sort()).toEqual(['Racer A', 'Racer B']);
  });

  it('twenty concurrent createTodo calls all survive', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => createTodo(dataDir, { summary: `Task ${i}` })),
    );
    const ids = new Set(results.map((t) => t.id));
    expect(ids.size).toBe(20); // every id unique — no two calls collided on the same object
    const items = await readTodos(dataDir);
    expect(items).toHaveLength(20);
  });
});
