import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CreateTodoResponse } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import type { TodoItem } from '../todos.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';

/**
 * `POST /api/v1/todos` (2026-08-15-knowledge-grounded-task-fanout.md, Phase 1) — the create route
 * that did not exist before this spec: until now the only writer of `.ai/cezar/todos.json` was an
 * agent subprocess appending via `CEZ_TODOS_FILE`. Covers the wire shape of the structured spec
 * (context/whatToDo/acceptanceCriteria/knowledgeRefs/origin) and the concurrency risk the spec
 * calls out explicitly: two concurrent creates racing the read-modify-write of the whole
 * `todos.json` array must not lose either one.
 *
 * **`CEZ_FOLLOWUPS` is left UNSET throughout this suite (D7, added 2026-08-15).** That is the
 * default install, and it is the condition this route actually has to work under: D7 removed the
 * `followups` gate from this route specifically because it is becoming the composer's default
 * submit path, and a gate nobody sets makes a main path invisible. `beforeEach` deletes the var
 * rather than setting it, so a reinstated gate turns every test in this file red, not just a
 * dedicated one. `DELETE /todos/:id` (used only in the create-racing-a-delete case below) is a
 * DIFFERENT route, still gated on `followups` as before — that one test sets the flag locally.
 */
describe('POST /api/v1/todos', () => {
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let app: Hono;
  const savedFollowups = process.env.CEZ_FOLLOWUPS;

  beforeEach(() => {
    delete process.env.CEZ_FOLLOWUPS;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-todos-create-'));
    dataDir = join(repoRoot, '.ai/cezar');
    store = RunStore.open(dataDir);
    const manager = {} as unknown as RunManager; // this route never starts a run
    app = createApp({
      repoRoot,
      store,
      manager,
      version: '0.0.0-test',
      providerAuth: connectedProviderAuth(),
    });
  });

  afterEach(() => {
    if (savedFollowups === undefined) delete process.env.CEZ_FOLLOWUPS;
    else process.env.CEZ_FOLLOWUPS = savedFollowups;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const create = (body: unknown) =>
    apiRequest(app, '/api/v1/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const readStoredTodos = async (): Promise<TodoItem[]> =>
    JSON.parse(await fsPromises.readFile(join(dataDir, 'todos.json'), 'utf8'));

  const created = (res: Response): Promise<CreateTodoResponse> => res.json() as Promise<CreateTodoResponse>;

  // ---- shape ------------------------------------------------------------------------------------

  it('201s with the stored todo, server-assigning id and ts', async () => {
    const res = await create({ summary: 'Wire up billing webhook retries' });
    expect(res.status).toBe(201);
    const { todo } = await created(res);
    expect(todo.summary).toBe('Wire up billing webhook retries');
    expect(typeof todo.id).toBe('string');
    expect(todo.id.length).toBeGreaterThan(0);
    expect(typeof todo.ts).toBe('string');
  });

  it('round-trips the full structured spec — context, whatToDo, acceptanceCriteria, knowledgeRefs, origin', async () => {
    const res = await create({
      summary: 'Add retry backoff to the webhook sender',
      context: 'The webhook sender has no retry policy, so a flaky downstream drops events.',
      whatToDo: 'Add exponential backoff with jitter, capped at 5 attempts.',
      acceptanceCriteria: ['A failed POST is retried', 'The 5th failure gives up and logs'],
      knowledgeRefs: [{ project: 'billing', slug: 'webhook-retries', title: 'Webhook retry policy' }],
      origin: 'composer',
    });
    expect(res.status).toBe(201);
    const { todo } = await created(res);
    expect(todo.context).toBe('The webhook sender has no retry policy, so a flaky downstream drops events.');
    expect(todo.whatToDo).toBe('Add exponential backoff with jitter, capped at 5 attempts.');
    expect(todo.acceptanceCriteria).toEqual(['A failed POST is retried', 'The 5th failure gives up and logs']);
    expect(todo.knowledgeRefs).toEqual([{ project: 'billing', slug: 'webhook-retries', title: 'Webhook retry policy' }]);
    expect(todo.origin).toBe('composer');
  });

  it('persists the created todo to todos.json', async () => {
    const res = await create({ summary: 'Persisted entry' });
    const { todo } = await created(res);
    const stored = await readStoredTodos();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: todo.id, summary: 'Persisted entry' });
  });

  // ---- validation ---------------------------------------------------------------------------------

  it('400s a body with no summary', async () => {
    const res = await create({ context: 'no summary here' });
    expect(res.status).toBe(400);
    const stored = await readStoredTodos().catch(() => []);
    expect(stored).toHaveLength(0);
  });

  it('400s an unknown-shaped acceptanceCriteria (not an array of strings)', async () => {
    const res = await create({ summary: 'Bad shape', acceptanceCriteria: 'not an array' });
    expect(res.status).toBe(400);
  });

  // ---- D7: this is a main path, not gated on the follow-up inbox flag -------------------------

  it('201s with CEZ_FOLLOWUPS unset — the default install, and this route must work in it', async () => {
    expect(process.env.CEZ_FOLLOWUPS).toBeUndefined(); // pins the precondition, not just the outcome
    const res = await create({ summary: 'Should succeed on a default install' });
    expect(res.status).toBe(201);
    const stored = await readStoredTodos();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.summary).toBe('Should succeed on a default install');
  });

  it('201s with CEZ_FOLLOWUPS explicitly "0" too — off is off, not just unset', async () => {
    process.env.CEZ_FOLLOWUPS = '0';
    const res = await create({ summary: 'Still succeeds' });
    expect(res.status).toBe(201);
  });

  // ---- concurrency (the spec's own named risk) -------------------------------------------------

  it('two concurrent creates racing the same todos.json both survive', async () => {
    // Fired together, not awaited one at a time — this is what actually exercises the
    // read-modify-write race on the whole array, not two sequential, harmless writes.
    const [resA, resB] = await Promise.all([
      create({ summary: 'First concurrent task' }),
      create({ summary: 'Second concurrent task' }),
    ]);
    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);
    const [todoA, todoB] = await Promise.all([created(resA), created(resB)]);

    const stored = await readStoredTodos();
    expect(stored).toHaveLength(2);
    const ids = stored.map((t) => t.id);
    expect(ids).toContain(todoA.todo.id);
    expect(ids).toContain(todoB.todo.id);
    const summaries = stored.map((t) => t.summary).sort();
    expect(summaries).toEqual(['First concurrent task', 'Second concurrent task']);
  });

  it('ten concurrent creates all survive — no lost update under heavier contention', async () => {
    const requests = Array.from({ length: 10 }, (_, i) => create({ summary: `Task ${i}` }));
    const responses = await Promise.all(requests);
    for (const res of responses) expect(res.status).toBe(201);
    const stored = await readStoredTodos();
    expect(stored).toHaveLength(10);
    const summaries = new Set(stored.map((t) => t.summary));
    for (let i = 0; i < 10; i++) expect(summaries.has(`Task ${i}`)).toBe(true);
  });

  it('a create racing an in-flight delete never loses the surviving entry', async () => {
    // DELETE /todos/:id is a different route from POST /todos and is still gated on `followups`
    // (D7 only ungates POST /todos and GET /workspace/todos) — set it locally, just for this test.
    process.env.CEZ_FOLLOWUPS = '1';
    // Seed one entry, then race its deletion against a brand-new create.
    const seeded = await create({ summary: 'Seeded, about to be deleted' });
    const { todo: seededTodo } = await created(seeded);

    const [delRes, createRes] = await Promise.all([
      apiRequest(app, `/api/v1/todos/${seededTodo.id}`, { method: 'DELETE' }),
      create({ summary: 'Created during the race' }),
    ]);
    expect(delRes.status).toBe(200);
    expect(createRes.status).toBe(201);

    const stored = await readStoredTodos();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.summary).toBe('Created during the race');
  });
});
