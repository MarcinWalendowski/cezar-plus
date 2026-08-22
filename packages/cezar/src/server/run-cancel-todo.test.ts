import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore, type RunRecord } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import type { TodoItem } from '../todos.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';

/**
 * `POST /api/v1/runs/:id/cancel` (2026-08-22-run-cancel-restores-todo.md) — cancelling a run
 * un-hides the todo it was started from, by clearing its `startedTaskId`. `todos.test.ts` covers
 * `clearStartedTaskId` directly; this covers the route wiring: the todo lookup is by `startedTaskId`
 * (the run id), the write only happens when `cancelled` is actually `true`, and the response shape
 * (`{cancelled}`) and the 404/unknown-run behaviour are unchanged.
 */
describe('POST /api/v1/runs/:id/cancel — clears the linked todo', () => {
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let app: Hono;
  let cancel: ReturnType<typeof vi.fn>;

  const todosFile = () => join(dataDir, 'todos.json');

  const writeTodos = (todos: TodoItem[]) => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(todosFile(), JSON.stringify(todos, null, 2), 'utf8');
  };

  const readStoredTodos = (): TodoItem[] => JSON.parse(readFileSync(todosFile(), 'utf8'));

  const makeRun = (): RunRecord =>
    store.createRun({
      title: 'Task',
      workflow: 'quick-task',
      task: 'Do the thing',
      runner: 'claude',
      steps: [{ id: 'task', name: 'Task', kind: 'agent' }],
    });

  const cancelRoute = (id: string) => apiRequest(app, `/api/v1/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-run-cancel-todo-'));
    dataDir = join(repoRoot, '.ai/cezar');
    store = RunStore.open(dataDir);
    cancel = vi.fn();
    const manager = { cancel } as unknown as RunManager;
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

  it("cancelling a run started from a todo clears that todo's startedTaskId on disk", async () => {
    const run = makeRun();
    writeTodos([{ id: 't1', summary: 'Ship it', startedTaskId: run.id }]);
    cancel.mockReturnValue(true);

    const res = await cancelRoute(run.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cancelled: true });
    expect(cancel).toHaveBeenCalledWith(run.id);

    const [stored] = readStoredTodos();
    expect('startedTaskId' in (stored as object)).toBe(false);
    expect(stored?.id).toBe('t1');
    expect(stored?.summary).toBe('Ship it');
  });

  it('cancelling a run with no linked todo still 200s with {cancelled: true} and touches no todo file', async () => {
    const run = makeRun();
    cancel.mockReturnValue(true);

    const res = await cancelRoute(run.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cancelled: true });
    // No todos.json was ever written in this project, and clearing a non-existent link must not
    // create one.
    expect(existsSync(todosFile())).toBe(false);
  });

  it('a run that cannot be cancelled (cancelled: false) leaves a linked todo untouched', async () => {
    const run = makeRun();
    writeTodos([{ id: 't1', summary: 'Ship it', startedTaskId: run.id }]);
    cancel.mockReturnValue(false);

    const res = await cancelRoute(run.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cancelled: false });

    const [stored] = readStoredTodos();
    expect(stored?.startedTaskId).toBe(run.id);
  });

  it('404s an unknown run id, unchanged, and never calls cancel', async () => {
    const res = await cancelRoute('does-not-exist');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
    expect(cancel).not.toHaveBeenCalled();
  });
});
