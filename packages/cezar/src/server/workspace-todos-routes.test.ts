import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import type { TodoItem } from '../todos.ts';
import { createWorkspaceTodosRoutes, type WorkspaceTodosRouteDeps } from './workspace-todos-routes.ts';
import { WorkspaceTodoIndex, type WorkspaceTodoProjectSource } from '../workspace/todo-index.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import type { ProjectApiEnv } from './server.ts';

/**
 * `GET /api/v1/workspace/todos` (D2 of `.ai/specs/2026-08-15-knowledge-grounded-task-fanout.md`,
 * Phase 1). `deps.todoIndex` is injected with a fake `WorkspaceTodoIndex` (the index itself is
 * covered by `../workspace/todo-index.test.ts`), so this file proves only the route layer: that
 * it is ungated (D7, added 2026-08-15) and that a live request reaches the injected index
 * unchanged.
 *
 * **D7 correction.** This route used to gate on `followups`+`workspaceViews`, mirroring
 * `./workspace-knowledge-routes.test.ts`'s AND-gate — measured wrong, because those two flags are
 * off on a default install and this board is becoming the composer's default fan-out surface, not
 * an optional side view. The suite below asserts the INVERSE of what it used to: the route must
 * answer with real data with all three flags UNSET, which is the default install and the
 * condition that actually matters — a reinstated gate turns these tests red.
 */

const ENV_KEYS = ['CEZ_FOLLOWUPS', 'CEZ_WORKSPACE_VIEWS', 'CEZ_SINGLE_PROJECT'] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/** The default install: none of the three flags set. */
function clearAll(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

function appWith(deps: WorkspaceTodosRouteDeps) {
  return new Hono<ProjectApiEnv>().route('/api/v1', createWorkspaceTodosRoutes(deps));
}

function fakeIndex(list?: WorkspaceTodoIndex['list']): WorkspaceTodoIndex {
  const index = new WorkspaceTodoIndex({
    listProjects: async () => [] as WorkspaceTodoProjectSource[],
  });
  if (list) index.list = list;
  return index;
}

describe('GET /api/v1/workspace/todos — D7: ungated, the default install must work', () => {
  it('all three flags unset (the default install) -> the index is called and its real result returned', async () => {
    clearAll();
    expect(process.env.CEZ_FOLLOWUPS).toBeUndefined();
    expect(process.env.CEZ_WORKSPACE_VIEWS).toBeUndefined();
    expect(process.env.CEZ_SINGLE_PROJECT).toBeUndefined();
    const todo: TodoItem = { id: 't1', summary: 'Ship it' };
    let called = false;
    const app = appWith({
      todoIndex: fakeIndex(async () => {
        called = true;
        return {
          todos: [{ project: 'billing', todo }],
          projects: [{ id: 'billing', name: 'billing', status: 'ok', ok: true, total: 1 }],
        };
      }),
    });
    const res = await apiRequest(app, '/api/v1/workspace/todos');
    expect(res.status).toBe(200);
    expect(called).toBe(true); // pins the precondition: not just a 200, the index actually ran
    expect(await res.json()).toEqual({
      todos: [{ project: 'billing', todo }],
      projects: [{ id: 'billing', name: 'billing', status: 'ok', ok: true, total: 1 }],
    });
  });

  it('CEZ_SINGLE_PROJECT=1 alone does not blank the board either', async () => {
    clearAll();
    process.env.CEZ_SINGLE_PROJECT = '1';
    let called = false;
    const app = appWith({
      todoIndex: fakeIndex(async () => {
        called = true;
        return { todos: [], projects: [{ id: 'boot', name: 'boot', status: 'ok', ok: true, total: 0 }] };
      }),
    });
    const res = await apiRequest(app, '/api/v1/workspace/todos');
    expect(res.status).toBe(200);
    expect(called).toBe(true);
  });

  it('the flags being ON changes nothing — the route never reads them at all', async () => {
    process.env.CEZ_FOLLOWUPS = '1';
    process.env.CEZ_WORKSPACE_VIEWS = '1';
    delete process.env.CEZ_SINGLE_PROJECT;
    let called = false;
    const app = appWith({
      todoIndex: fakeIndex(async () => {
        called = true;
        return { todos: [], projects: [] };
      }),
    });
    const res = await apiRequest(app, '/api/v1/workspace/todos');
    expect(res.status).toBe(200);
    expect(called).toBe(true);
  });
});

describe('GET /api/v1/workspace/todos — wire shape', () => {
  it('a project with no todos and a dead project both render in one response', async () => {
    clearAll();
    const app = appWith({
      todoIndex: fakeIndex(async () => ({
        todos: [],
        projects: [
          { id: 'quiet', name: 'quiet', status: 'ok', ok: true, total: 0 },
          { id: 'gone', name: 'gone', status: 'missing', ok: false, reason: 'project root is missing', total: 0 },
        ],
      })),
    });
    const res = await apiRequest(app, '/api/v1/workspace/todos');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      todos: [],
      projects: [
        { id: 'quiet', name: 'quiet', status: 'ok', ok: true, total: 0 },
        { id: 'gone', name: 'gone', status: 'missing', ok: false, reason: 'project root is missing', total: 0 },
      ],
    });
  });

  it('merges todos across several projects, each entry carrying its own project id', async () => {
    clearAll();
    const todoA: TodoItem = { id: 'ta', summary: 'A task' };
    const todoB: TodoItem = { id: 'tb', summary: 'B task' };
    const app = appWith({
      todoIndex: fakeIndex(async () => ({
        todos: [
          { project: 'a', todo: todoA },
          { project: 'b', todo: todoB },
        ],
        projects: [
          { id: 'a', name: 'a', status: 'ok', ok: true, total: 1 },
          { id: 'b', name: 'b', status: 'ok', ok: true, total: 1 },
        ],
      })),
    });
    const res = await apiRequest(app, '/api/v1/workspace/todos');
    const body = (await res.json()) as { todos: unknown[] };
    expect(body.todos).toEqual([
      { project: 'a', todo: todoA },
      { project: 'b', todo: todoB },
    ]);
  });
});
