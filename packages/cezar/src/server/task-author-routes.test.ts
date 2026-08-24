import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore, type RunRecord } from '../runs/store.ts';
import type { TodoItem } from '../todos.ts';
import type { RunManager, StartRunInput } from '../workflows/run.ts';
import type { WorkflowDef } from '../workflows/types.ts';
import { taskAuthorSchema, type TaskAuthor } from '../runs/task-author.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';

/**
 * WHO created a task, per creation route — spec
 * `.ai/specs/2026-08-21-task-author-provenance.md`, one case per row of its §Problem table.
 *
 * | Guard | Mutation that must turn it red |
 * |---|---|
 * | `POST /runs` from the cockpit is a `user`, from a script an `api` | derive the kind from the principal alone |
 * | An `author` in the REQUEST BODY changes nothing | read `author` off the body |
 * | ▶ Run credits the CLICKER, and leaves the todo's own author alone | inherit on the ▶ Run path too |
 * | Every variant of one submit carries the identical author | build the author inside `startVariants` |
 * | `PATCH /todos/:id` cannot rewrite an author | add `author` to `updateTodoInputSchema` |
 *
 * A capturing `startRun` stub is the whole harness (the `start-run.test.ts` pattern) — what is
 * under test is what the ROUTE decides, not what the manager then does with it.
 */

const BROWSER = { 'sec-fetch-site': 'same-origin' };

describe('the author each run-creation route stamps', () => {
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let app: Hono;
  let captured: StartRunInput[];

  const writeTodos = (items: unknown[]) => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'todos.json'), JSON.stringify(items, null, 2), 'utf8');
  };
  const readTodosFile = (): TodoItem[] =>
    JSON.parse(readFileSync(join(dataDir, 'todos.json'), 'utf8')) as TodoItem[];

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-author-'));
    dataDir = join(repoRoot, '.ai/cezar');
    store = RunStore.open(dataDir);
    captured = [];
    const manager = {
      startRun: (_workflow: WorkflowDef, input: StartRunInput) => {
        captured.push(input);
        return store.createRun({
          title: 't',
          workflow: '(planned)',
          task: input.task,
          author: input.author,
          steps: [],
        });
      },
      startVariants: (_workflow: WorkflowDef, input: StartRunInput, variants: number): RunRecord[] =>
        Array.from({ length: variants }, (_, i) => {
          captured.push(input);
          return store.createRun({
            title: 't',
            workflow: '(planned)',
            task: input.task,
            author: input.author,
            steps: [],
            variant: String.fromCharCode(65 + i),
          });
        }),
    } as unknown as RunManager;
    app = createApp({
      repoRoot,
      store,
      manager,
      version: '0.0.0-test',
      providerAuth: connectedProviderAuth(),
    });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const postRun = (body: unknown, headers: Record<string, string> = {}) =>
    apiRequest(app, '/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  const authorOfLast = (): TaskAuthor => {
    const author = captured.at(-1)?.author;
    expect(author).toBeDefined();
    return author as TaskAuthor;
  };

  it('POST /runs from the cockpit records a user, via composer', async () => {
    const res = await postRun({ task: 'do the thing' }, BROWSER);
    expect(res.status).toBe(201);
    expect(authorOfLast()).toMatchObject({ kind: 'user', id: 'local', via: 'composer' });
  });

  it('POST /runs from a script — no browser fetch metadata — records `api`', async () => {
    await postRun({ task: 'do the thing' });
    expect(authorOfLast()).toMatchObject({ kind: 'api', via: 'composer' });
  });

  it('the author is on the RECORD, not just the input, and it validates', async () => {
    await postRun({ task: 'do the thing' }, BROWSER);
    const run = store.listRuns()[0];
    expect(taskAuthorSchema.safeParse(run?.author).success).toBe(true);
    expect(run?.author?.via).toBe('composer');
  });

  it('an `author` in the request body is ignored — provenance you can set yourself is not provenance', async () => {
    const forged = {
      kind: 'agent',
      id: 'someone-elses-run',
      via: 'automation',
      at: '2000-01-01T00:00:00.000Z',
      parentTaskId: 'someone-elses-run',
      agentSessionId: 'forged',
    };
    const res = await postRun({ task: 'do the thing', author: forged }, BROWSER);
    // The body key is not part of `startRunSchema`, so it never reaches the handler; what matters
    // is the OUTCOME — the recorded author is the one the request itself proved.
    expect(res.status).toBe(201);
    expect(authorOfLast()).toMatchObject({ kind: 'user', id: 'local', via: 'composer' });
    expect(store.listRuns()[0]?.author?.id).not.toBe('someone-elses-run');
  });

  it('×3 variants all carry the IDENTICAL author — one submit, one actor', async () => {
    // Variants need a real git repo (each runs in its own worktree) or the route 400s — the
    // `start-run-todo.test.ts` setup, verbatim.
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repoRoot });
    git('init', '-q', '-b', 'main');
    git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');

    const res = await postRun({ task: 'compare', variants: 3 }, BROWSER);
    expect(res.status).toBe(201);
    expect(captured).toHaveLength(3);
    const authors = store.listRuns().map((run) => run.author);
    expect(authors).toHaveLength(3);
    expect(new Set(authors.map((a) => JSON.stringify(a))).size).toBe(1);
  });

  it("▶ Run credits the CLICKER, and leaves the filed todo's own author untouched", async () => {
    const filedByAgent = {
      kind: 'agent',
      id: 'run_parent',
      via: 'cli-todo-add',
      at: '2026-08-20T09:00:00.000Z',
      parentTaskId: 'run_parent',
      agentSessionId: 'sess_1',
    };
    writeTodos([{ id: 't1', summary: 'an agent filed this', author: filedByAgent }]);

    const res = await apiRequest(app, '/api/v1/todos/t1/start', {
      method: 'POST',
      headers: { ...BROWSER },
    });
    expect(res.status).toBe(201);
    // The RUN is the clicker's…
    expect(authorOfLast()).toMatchObject({ kind: 'user', id: 'local', via: 'todo-start' });
    // …and the TODO still says who filed it. `startedTaskId` joins the two records.
    const todo = readTodosFile().find((t) => t.id === 't1');
    expect(todo?.author).toEqual(filedByAgent);
    expect(todo?.startedTaskId).toBe(store.listRuns()[0]?.id);
  });

  it('a pre-2026-08-21 todo with no author still starts — the field is additive on the read path too', async () => {
    writeTodos([{ id: 't2', summary: 'filed before this shipped' }]);
    const res = await apiRequest(app, '/api/v1/todos/t2/start', { method: 'POST', headers: { ...BROWSER } });
    expect(res.status).toBe(201);
    expect(authorOfLast()).toMatchObject({ via: 'todo-start' });
  });
});

describe('POST /:projectId/todos stamps the author server-side', () => {
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let app: Hono;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-author-todo-'));
    dataDir = join(repoRoot, '.ai/cezar');
    mkdirSync(dataDir, { recursive: true });
    store = RunStore.open(dataDir);
    app = createApp({
      repoRoot,
      store,
      manager: {} as unknown as RunManager,
      version: '0.0.0-test',
      providerAuth: connectedProviderAuth(),
    });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const createTodoOverHttp = (body: unknown, headers: Record<string, string> = {}) =>
    apiRequest(app, '/api/v1/todos', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  it('records who filed it, via the create route', async () => {
    const res = await createTodoOverHttp({ summary: 'file this' }, BROWSER);
    expect(res.status).toBe(201);
    const { todo } = (await res.json()) as { todo: TodoItem };
    expect(todo.author).toMatchObject({ kind: 'user', id: 'local', via: 'todo-create-route' });
    expect(taskAuthorSchema.safeParse(todo.author).success).toBe(true);
  });

  it('an `author` in the body cannot forge one', async () => {
    const res = await createTodoOverHttp(
      {
        summary: 'file this',
        author: { kind: 'automation', id: 'not-me', via: 'automation', at: '2000-01-01T00:00:00.000Z' },
      },
      BROWSER,
    );
    expect(res.status).toBe(201);
    const { todo } = (await res.json()) as { todo: TodoItem };
    expect(todo.author?.id).not.toBe('not-me');
    expect(todo.author?.via).toBe('todo-create-route');
  });

  it('PATCH cannot rewrite an author after the fact', async () => {
    const created = await createTodoOverHttp({ summary: 'file this' }, BROWSER);
    const { todo } = (await created.json()) as { todo: TodoItem };
    const before = todo.author;

    const res = await apiRequest(app, `/api/v1/todos/${todo.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...BROWSER },
      body: JSON.stringify({
        status: 'in-progress',
        author: { kind: 'user', id: 'someone-else', via: 'composer', at: '2000-01-01T00:00:00.000Z' },
      }),
    });
    expect(res.status).toBe(200);
    const { todo: patched } = (await res.json()) as { todo: TodoItem };
    expect(patched.status).toBe('in-progress');
    expect(patched.author).toEqual(before);
  });
});
