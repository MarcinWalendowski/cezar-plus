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

/**
 * The optional query (`.ai/specs/2026-08-25-split-active-backlog-tables.md`, verification
 * step 3). Unlike the suites above, these run against a REAL `WorkspaceTodoIndex` over an
 * injected `readTodos` — the point is that the validator, the index and the ordering agree over
 * HTTP, which a fake index would hide.
 */
describe('GET /api/v1/workspace/todos — the partitioned query', () => {
  function realIndex(todos: readonly TodoItem[]): WorkspaceTodoIndex {
    return new WorkspaceTodoIndex({
      listProjects: async () => [{ id: 'p', root: '/repo/p', status: 'ok', name: 'p' }],
      readTodos: async () => [...todos],
    });
  }

  function backlog(count: number): TodoItem[] {
    return Array.from({ length: count }, (_, i) => ({
      id: `t${String(i).padStart(3, '0')}`,
      summary: `row ${i % 5}`, // collisions on the sort key, so the tie-breaker is what decides
      status: 'todo' as const,
    }));
  }

  it('a partitioned request answers one ordered page plus the envelope', async () => {
    clearAll();
    const app = appWith({ todoIndex: realIndex(backlog(25)) });
    const res = await apiRequest(app, '/api/v1/workspace/todos?partition=backlog&sort=task&dir=asc&limit=5');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { todos: { todo: TodoItem }[]; page: Record<string, unknown> };
    expect(body.todos).toHaveLength(5);
    expect(body.page).toEqual({
      partition: 'backlog',
      sort: 'task',
      dir: 'asc',
      limit: 5,
      returned: 5,
      total: 25,
      partitionTotal: 25,
      hasMore: true,
    });
  });

  it('the two partitions are disjoint and together cover the visible board', async () => {
    clearAll();
    const todos: TodoItem[] = [
      { id: 'a', summary: 'a', status: 'in-progress' },
      { id: 'b', summary: 'b', status: 'blocked' },
      { id: 'c', summary: 'c', status: 'todo' },
      { id: 'd', summary: 'd' },
    ];
    const app = appWith({ todoIndex: realIndex(todos) });
    const ids = async (partition: string) => {
      const res = await apiRequest(app, `/api/v1/workspace/todos?partition=${partition}&limit=50`);
      const body = (await res.json()) as { todos: { todo: TodoItem }[] };
      return body.todos.map((entry) => entry.todo.id).sort();
    };
    expect(await ids('active')).toEqual(['a', 'b']);
    expect(await ids('backlog')).toEqual(['c', 'd']);
  });

  it('prefix property over HTTP: limit=20 then limit=30 — the second starts with the first, in order', async () => {
    clearAll();
    const app = appWith({ todoIndex: realIndex(backlog(60)) });
    const page = async (limit: number) => {
      const res = await apiRequest(app, `/api/v1/workspace/todos?partition=backlog&sort=task&dir=asc&limit=${limit}`);
      const body = (await res.json()) as { todos: { project: string; todo: TodoItem }[] };
      return body.todos.map((entry) => `${entry.project}:${entry.todo.id}`);
    };
    const first = await page(20);
    const second = await page(30);
    expect(first).toHaveLength(20);
    expect(second).toHaveLength(30);
    expect(second.slice(0, 20)).toEqual(first);
  });

  it('repeatable facets narrow the page, and a single value is accepted too', async () => {
    clearAll();
    const todos: TodoItem[] = [
      { id: 'x', summary: 'x', status: 'blocked', priority: 'high' },
      { id: 'y', summary: 'y', status: 'in-progress', priority: 'low' },
      { id: 'z', summary: 'z', status: 'blocked', priority: 'low' },
    ];
    const app = appWith({ todoIndex: realIndex(todos) });
    const ids = async (qs: string) => {
      const res = await apiRequest(app, `/api/v1/workspace/todos?partition=active&limit=50&${qs}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { todos: { todo: TodoItem }[] };
      return body.todos.map((entry) => entry.todo.id).sort();
    };
    expect(await ids('status=blocked')).toEqual(['x', 'z']);
    expect(await ids('priority=high&priority=low')).toEqual(['x', 'y', 'z']);
  });

  describe('invalid queries all answer 400 {error}, naming the field', () => {
    const cases: readonly { qs: string; field: string }[] = [
      { qs: 'partition=nope', field: 'partition' },
      { qs: 'partition=active&sort=nope', field: 'sort' },
      { qs: 'partition=active&dir=sideways', field: 'dir' },
      { qs: 'partition=active&view=elsewhere', field: 'view' },
      { qs: 'partition=active&limit=0', field: 'limit' },
      { qs: 'partition=active&limit=-1', field: 'limit' },
      { qs: 'partition=active&limit=abc', field: 'limit' },
      { qs: 'partition=active&limit=1001', field: 'limit' },
      { qs: `partition=active&q=${'x'.repeat(501)}`, field: 'q' },
    ];

    for (const { qs, field } of cases) {
      it(`?${qs.slice(0, 40)} -> 400 mentioning ${field}`, async () => {
        clearAll();
        const app = appWith({ todoIndex: realIndex(backlog(3)) });
        const res = await apiRequest(app, `/api/v1/workspace/todos?${qs}`);
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(Object.keys(body)).toEqual(['error']); // the one 400 shape this API answers (§2)
        expect(body.error).toContain(field);
      });
    }

    it('limit=1000 is accepted — the boundary is inclusive', async () => {
      clearAll();
      const app = appWith({ todoIndex: realIndex(backlog(3)) });
      const res = await apiRequest(app, '/api/v1/workspace/todos?partition=backlog&limit=1000');
      expect(res.status).toBe(200);
    });
  });

  it('unknown query keys are IGNORED, not rejected — no existing caller newly fails', async () => {
    clearAll();
    const app = appWith({ todoIndex: realIndex(backlog(3)) });
    const res = await apiRequest(app, '/api/v1/workspace/todos?partition=backlog&bogus=1&fsort=created-desc');
    expect(res.status).toBe(200);
  });

  it('a duplicated single-valued key collapses to the first rather than 400ing', async () => {
    clearAll();
    const app = appWith({ todoIndex: realIndex(backlog(3)) });
    const res = await apiRequest(app, '/api/v1/workspace/todos?partition=backlog&partition=active');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { page: { partition: string } };
    expect(body.page.partition).toBe('backlog');
  });

  it('LEGACY BYTE-IDENTITY: no params -> the pre-change payload exactly, with neither page nor counts', async () => {
    clearAll();
    // Every shape the partitioned path treats specially, so a filter leaking onto the legacy path
    // would be visible here rather than only in production.
    const todos: TodoItem[] = [
      { id: 'plain', summary: 'no status at all' },
      { id: 'done', summary: 'finished', status: 'done' },
      { id: 'archived', summary: 'shelved', status: 'todo', archivedAt: '2026-08-24T00:00:00.000Z' },
      { id: 'started', summary: 'already a run', status: 'todo', startedTaskId: 'task-1' },
      { id: 'gone', summary: 'deleted', status: 'todo', tombstone: { at: '2026-08-24T00:00:00.000Z' } },
    ];
    const app = appWith({ todoIndex: realIndex(todos) });
    const res = await apiRequest(app, '/api/v1/workspace/todos');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['projects', 'todos']);
    expect(body).toEqual({
      todos: todos.map((todo) => ({ project: 'p', todo })),
      projects: [{ id: 'p', name: 'p', status: 'ok', ok: true, total: 5 }],
    });
  });

  it('a view=archived request without a partition is still the legacy path', async () => {
    clearAll();
    const app = appWith({ todoIndex: realIndex(backlog(3)) });
    const res = await apiRequest(app, '/api/v1/workspace/todos?view=archived');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['projects', 'todos']);
    expect((body.todos as unknown[]).length).toBe(3);
  });
});
