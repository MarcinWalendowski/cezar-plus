import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UpdateTodoResponse } from '@loki-labs/better-cezar-contract';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import type { TodoItem } from '../todos.ts';
import { clearProjectProbeCache, listProjects, registerProject } from '../workspace/projects.ts';
import { ProjectContexts } from './project-context.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';

/**
 * `PATCH /api/v1/todos/:id` (2026-08-17-filed-tasks-table-statuses.md) — the Filed table's
 * status/priority edits and its Archive/Restore action, all through one route. Covers the wire
 * shape (`updateTodoInputSchema`'s `.refine`'d "at least one key" body), the 404/persistence
 * behaviour, and — in a second describe block below — that the route is project-SCOPED: a PATCH
 * against project A must never reach project B's `todos.json`, even when the two happen to share
 * an id.
 */
describe('PATCH /api/v1/todos/:id', () => {
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let app: Hono;

  const writeTodos = (todos: TodoItem[]) => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'todos.json'), JSON.stringify(todos, null, 2), 'utf8');
  };

  const readStoredTodos = async (): Promise<TodoItem[]> =>
    JSON.parse(await fsPromises.readFile(join(dataDir, 'todos.json'), 'utf8'));

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-todos-patch-'));
    dataDir = join(repoRoot, '.ai/cezar');
    store = RunStore.open(dataDir);
    const manager = {} as unknown as RunManager; // this route never touches a run
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

  const patch = (id: string, body: unknown) =>
    apiRequest(app, `/api/v1/todos/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const updated = (res: Response): Promise<UpdateTodoResponse> => res.json() as Promise<UpdateTodoResponse>;

  // ---- happy path -----------------------------------------------------------------------------

  it('200s and persists a status change to disk', async () => {
    writeTodos([{ id: 't1', summary: 'Ship it' }]);
    const res = await patch('t1', { status: 'in-progress' });
    expect(res.status).toBe(200);
    const { todo } = await updated(res);
    expect(todo.status).toBe('in-progress');
    const stored = await readStoredTodos();
    expect(stored[0]?.status).toBe('in-progress');
  });

  it('200s and persists a priority change to disk', async () => {
    writeTodos([{ id: 't1', summary: 'Ship it' }]);
    const res = await patch('t1', { priority: 'high' });
    expect(res.status).toBe(200);
    const { todo } = await updated(res);
    expect(todo.priority).toBe('high');
    const stored = await readStoredTodos();
    expect(stored[0]?.priority).toBe('high');
  });

  it('archives — stamps an ISO archivedAt', async () => {
    writeTodos([{ id: 't1', summary: 'Ship it' }]);
    const res = await patch('t1', { archived: true });
    expect(res.status).toBe(200);
    const { todo } = await updated(res);
    expect(typeof todo.archivedAt).toBe('string');
    expect(Number.isNaN(Date.parse(todo.archivedAt as string))).toBe(false);
    const stored = await readStoredTodos();
    expect(typeof stored[0]?.archivedAt).toBe('string');
  });

  it('restores — removes the archivedAt KEY, not just its value', async () => {
    writeTodos([{ id: 't1', summary: 'Ship it', archivedAt: '2026-08-01T00:00:00.000Z' }]);
    const res = await patch('t1', { archived: false });
    expect(res.status).toBe(200);
    const { todo } = await updated(res);
    expect('archivedAt' in todo).toBe(false);
    const stored = await readStoredTodos();
    expect('archivedAt' in (stored[0] as object)).toBe(false);
  });

  it('combines status, priority and archive in one request', async () => {
    writeTodos([{ id: 't1', summary: 'Ship it' }]);
    const res = await patch('t1', { status: 'done', priority: 'low', archived: true });
    expect(res.status).toBe(200);
    const { todo } = await updated(res);
    expect(todo.status).toBe('done');
    expect(todo.priority).toBe('low');
    expect(typeof todo.archivedAt).toBe('string');
  });

  it('updates a legacy entry that carries none of the new fields, and leaves its old fields alone', async () => {
    writeTodos([
      { id: 't1', ts: '2026-07-01T00:00:00.000Z', summary: 'Rotate the key', action: 'Rotate it in the dashboard' },
    ]);
    const res = await patch('t1', { status: 'blocked' });
    expect(res.status).toBe(200);
    const { todo } = await updated(res);
    expect(todo.status).toBe('blocked');
    expect(todo.action).toBe('Rotate it in the dashboard');
  });

  // ---- validation -------------------------------------------------------------------------------

  it('400s an empty body — at least one key required', async () => {
    writeTodos([{ id: 't1', summary: 'Ship it' }]);
    const res = await patch('t1', {});
    expect(res.status).toBe(400);
  });

  it('400s a status outside the closed enum', async () => {
    writeTodos([{ id: 't1', summary: 'Ship it' }]);
    const res = await patch('t1', { status: 'archived' });
    expect(res.status).toBe(400);
  });

  it('400s a priority outside the closed enum', async () => {
    writeTodos([{ id: 't1', summary: 'Ship it' }]);
    const res = await patch('t1', { priority: 'urgent' });
    expect(res.status).toBe(400);
  });

  it('400s a non-boolean archived', async () => {
    writeTodos([{ id: 't1', summary: 'Ship it' }]);
    const res = await patch('t1', { archived: 'yes' });
    expect(res.status).toBe(400);
  });

  it('a rejected body never mutates the file', async () => {
    writeTodos([{ id: 't1', summary: 'Ship it' }]);
    await patch('t1', {});
    const stored = await readStoredTodos();
    expect(stored[0]).not.toHaveProperty('status');
  });

  // ---- 404 ----------------------------------------------------------------------------------------

  it('404s an unknown id', async () => {
    writeTodos([]);
    const res = await patch('nope', { status: 'done' });
    expect(res.status).toBe(404);
  });

  it('404s an unknown id and never writes, whatever the body carries', async () => {
    writeTodos([{ id: 't1', summary: 'Ship it' }]);
    const res = await patch('missing', { status: 'done', priority: 'high', archived: true });
    expect(res.status).toBe(404);
    const stored = await readStoredTodos();
    expect(stored).toHaveLength(1);
    expect(stored[0]).not.toHaveProperty('status');
  });
});

/**
 * The route is project-SCOPED (`/api/v1/p/:projectId/todos/:id`, beside GET/POST/DELETE/start):
 * a PATCH naming project A must resolve against A's OWN `dataDir` only, never B's — even when the
 * two projects happen to hold an entry under the same id, which the per-project `todos.json` id
 * space allows (ids are per-project UUIDs, not globally unique).
 */
describe('PATCH /api/v1/p/:projectId/todos/:id — cross-project scoping', () => {
  const savedHome = process.env.CEZ_HOME;
  let home: string;
  let repoRoot: string;
  let otherRoot: string;
  let store: RunStore;
  let contexts: ProjectContexts;
  let app: Hono;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'cez-todos-patch-home-'));
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-todos-patch-a-'));
    otherRoot = mkdtempSync(join(tmpdir(), 'cez-todos-patch-b-'));
    process.env.CEZ_HOME = home;
    for (const root of [repoRoot, otherRoot]) {
      mkdirSync(join(root, '.ai/cezar'), { recursive: true });
      writeFileSync(join(root, '.ai/cezar', 'config.json'), '{"skillsRepos": []}\n', 'utf8');
    }
    clearProjectProbeCache();
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    contexts = new ProjectContexts({ listProjects });
    await registerProject(repoRoot);
    app = createApp({
      repoRoot,
      store,
      manager: { isActive: () => false } as unknown as RunManager,
      version: '0.0.0-test',
      contexts,
    });
  });

  afterEach(() => {
    contexts.disposeAll();
    store.flush();
    for (const dir of [home, repoRoot, otherRoot]) rmSync(dir, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
  });

  it("a PATCH scoped to project B never touches project A's file, even on a colliding id", async () => {
    const other = await registerProject(otherRoot);
    const dataDirA = join(repoRoot, '.ai/cezar');
    const dataDirB = join(otherRoot, '.ai/cezar');
    writeFileSync(join(dataDirA, 'todos.json'), JSON.stringify([{ id: 'shared-id', summary: "A's task" }]), 'utf8');
    writeFileSync(join(dataDirB, 'todos.json'), JSON.stringify([{ id: 'shared-id', summary: "B's task" }]), 'utf8');

    const res = await apiRequest(app, `/api/v1/p/${other.id}/todos/shared-id`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    });
    expect(res.status).toBe(200);

    const storedA = JSON.parse(readFileSync(join(dataDirA, 'todos.json'), 'utf8')) as TodoItem[];
    const storedB = JSON.parse(readFileSync(join(dataDirB, 'todos.json'), 'utf8')) as TodoItem[];
    expect(storedA[0]?.status).toBeUndefined();
    expect(storedB[0]?.status).toBe('done');
  });
});
