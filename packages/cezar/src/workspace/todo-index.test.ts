import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { TodoItem } from '../todos.ts';
import { WorkspaceTodoIndex, type WorkspaceTodoProjectSource } from './todo-index.ts';

/**
 * `WorkspaceTodoIndex` (D2 of `.ai/specs/2026-08-15-knowledge-grounded-task-fanout.md`, Phase 1)
 * — the read path behind `GET /api/v1/workspace/todos`. `./workspace-todos-routes.test.ts` covers
 * the route/capability-gate layer; this file covers the index's own per-project degradation and
 * the structural "never builds a project context" guard, mirroring `run-index.test.ts`'s own C2.
 */

function source(overrides: Partial<WorkspaceTodoProjectSource>): WorkspaceTodoProjectSource {
  const id = overrides.id ?? 'p';
  return { id, root: '/repo/p', status: 'ok', name: id, ...overrides };
}

describe('WorkspaceTodoIndex.list()', () => {
  it('empty registry -> empty todos and projects', async () => {
    const index = new WorkspaceTodoIndex({ listProjects: async () => [] });
    expect(await index.list()).toEqual({ todos: [], projects: [] });
  });

  it('a missing project is rendered with ok:false and never read from', async () => {
    let readCalled = false;
    const index = new WorkspaceTodoIndex({
      listProjects: async () => [source({ id: 'gone', root: '/repo/gone', status: 'missing' })],
      readTodos: async () => {
        readCalled = true;
        return [];
      },
    });
    const result = await index.list();
    expect(result.todos).toEqual([]);
    expect(result.projects).toEqual([
      { id: 'gone', name: 'gone', status: 'missing', ok: false, reason: 'project root is missing', total: 0 },
    ]);
    expect(readCalled).toBe(false);
  });

  it('an ok project with todos is stamped project-per-entry, and its health is ok:true with the right total', async () => {
    const todo: TodoItem = { id: 't1', summary: 'Do the thing' };
    const index = new WorkspaceTodoIndex({
      listProjects: async () => [source({ id: 'billing', root: '/repo/billing' })],
      readTodos: async (dataDir) => {
        expect(dataDir).toBe('/repo/billing/.ai/cezar');
        return [todo];
      },
    });
    const result = await index.list();
    expect(result.todos).toEqual([{ project: 'billing', todo }]);
    expect(result.projects).toEqual([{ id: 'billing', name: 'billing', status: 'ok', ok: true, total: 1 }]);
  });

  it('an empty inbox is ok:true, total 0 — indistinguishable from an unreadable one (readTodos never surfaces that distinction)', async () => {
    const index = new WorkspaceTodoIndex({
      listProjects: async () => [source({ id: 'quiet' })],
      readTodos: async () => [],
    });
    const result = await index.list();
    expect(result.projects).toEqual([{ id: 'quiet', name: 'quiet', status: 'ok', ok: true, total: 0 }]);
  });

  it('merges across several projects, each todo carrying its own project id', async () => {
    const index = new WorkspaceTodoIndex({
      listProjects: async () => [source({ id: 'a', root: '/repo/a' }), source({ id: 'b', root: '/repo/b' })],
      readTodos: async (dataDir) =>
        dataDir === '/repo/a/.ai/cezar'
          ? [{ id: 't-a', summary: 'A task' }]
          : [{ id: 't-b1', summary: 'B task 1' }, { id: 't-b2', summary: 'B task 2' }],
    });
    const result = await index.list();
    expect(result.todos).toEqual([
      { project: 'a', todo: { id: 't-a', summary: 'A task' } },
      { project: 'b', todo: { id: 't-b1', summary: 'B task 1' } },
      { project: 'b', todo: { id: 't-b2', summary: 'B task 2' } },
    ]);
    expect(result.projects.map((p) => p.total)).toEqual([1, 2]);
  });

  it('falls back to basename(root) when the registry name is blank', async () => {
    const index = new WorkspaceTodoIndex({
      listProjects: async () => [source({ id: 'x', root: '/repo/nameless-project', name: '' })],
      readTodos: async () => [],
    });
    const result = await index.list();
    expect(result.projects[0]?.name).toBe('nameless-project');
  });

  it('a rejected listProjects() degrades to an empty index rather than throwing', async () => {
    const index = new WorkspaceTodoIndex({
      listProjects: async () => {
        throw new Error('registry unreadable');
      },
    });
    await expect(index.list()).resolves.toEqual({ todos: [], projects: [] });
  });

  it('the default readTodos (unset in deps) is used when no override is supplied', async () => {
    // No `readTodos` override — exercises the constructor's own default (the real `readTodos()`
    // from `../todos.ts`) against a project root that has no `.ai/cezar` at all, which must
    // degrade to an empty inbox rather than throwing.
    const index = new WorkspaceTodoIndex({
      listProjects: async () => [source({ id: 'untouched', root: '/tmp/definitely-not-a-real-cezar-project-xyz' })],
    });
    const result = await index.list();
    expect(result.todos).toEqual([]);
    expect(result.projects).toEqual([{ id: 'untouched', name: 'untouched', status: 'ok', ok: true, total: 0 }]);
  });

  it('structural guard: never imports project-context.ts, runs/store.ts, or workflows/run.ts', async () => {
    const src = await readFile(new URL('./todo-index.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/from\s+['"][^'"]*project-context(\.ts)?['"]/);
    expect(src).not.toMatch(/from\s+['"][^'"]*runs\/store(\.ts)?['"]/);
    expect(src).not.toMatch(/from\s+['"][^'"]*workflows\/run(\.ts)?['"]/);
  });
});

/**
 * The partitioned read (`.ai/specs/2026-08-25-split-active-backlog-tables.md`, verification
 * step 2). `list()` without a `partition` is the legacy path and is covered by the suite above,
 * unchanged; everything below only runs when a partition is named.
 */
describe('WorkspaceTodoIndex.list({partition}) — the Active/Backlog split', () => {
  function board(todos: readonly TodoItem[]): WorkspaceTodoIndex {
    return new WorkspaceTodoIndex({
      listProjects: async () => [source({ id: 'p', root: '/repo/p' })],
      readTodos: async () => [...todos],
    });
  }

  const ROWS: TodoItem[] = [
    { id: 'a1', summary: 'in flight', status: 'in-progress' },
    { id: 'a2', summary: 'stuck', status: 'blocked' },
    { id: 'b1', summary: 'waiting', status: 'todo' },
    { id: 'b2', summary: 'legacy, no status at all' },
  ];

  it('Backlog is status todo INCLUDING absent; Active is everything else', async () => {
    const index = board(ROWS);
    const active = await index.list({ partition: 'active' });
    const backlog = await index.list({ partition: 'backlog' });
    // No row carries a `ts`, so every age key is unknown and the `project:id` tie-breaker alone
    // decides — ascending, regardless of the `desc` direction. That is rule (2) of the ordering
    // module, visible here rather than only in its own unit test.
    expect(active.todos.map((entry) => entry.todo.id)).toEqual(['a1', 'a2']);
    expect(backlog.todos.map((entry) => entry.todo.id)).toEqual(['b1', 'b2']);
  });

  it('done lands in Active on the Archived tab, and in neither partition on the Active tab', async () => {
    const index = board([...ROWS, { id: 'd1', summary: 'finished', status: 'done' }]);
    const activeTab = await index.list({ partition: 'active', view: 'active' });
    expect(activeTab.todos.map((entry) => entry.todo.id)).not.toContain('d1');
    const archivedTab = await index.list({ partition: 'active', view: 'archived' });
    expect(archivedTab.todos.map((entry) => entry.todo.id)).toEqual(['d1']);
  });

  it('an archived row leaves the Active tab whatever its status is', async () => {
    const index = board([
      { id: 'a1', summary: 'shelved', status: 'in-progress', archivedAt: '2026-08-24T00:00:00.000Z' },
    ]);
    expect((await index.list({ partition: 'active', view: 'active' })).todos).toEqual([]);
    expect((await index.list({ partition: 'active', view: 'archived' })).todos).toHaveLength(1);
  });

  it('startedTaskId and tombstoned rows are excluded — on BOTH views', async () => {
    const index = board([
      { id: 'ok', summary: 'visible', status: 'todo' },
      { id: 'started', summary: 'already a run', status: 'todo', startedTaskId: 'task-1' },
      { id: 'gone', summary: 'deleted', status: 'todo', tombstone: { at: '2026-08-24T00:00:00.000Z' } },
    ]);
    for (const view of ['active', 'archived'] as const) {
      const page = await index.list({ partition: 'backlog', view });
      expect(page.todos.map((entry) => entry.todo.id)).not.toContain('started');
      expect(page.todos.map((entry) => entry.todo.id)).not.toContain('gone');
    }
    expect((await index.list({ partition: 'backlog' })).todos.map((e) => e.todo.id)).toEqual(['ok']);
  });

  it('the LEGACY path still carries started and tombstoned rows — the §2 leak is deliberate, not an oversight', async () => {
    const index = board([
      { id: 'started', summary: 'already a run', startedTaskId: 'task-1' },
      { id: 'gone', summary: 'deleted', tombstone: { at: '2026-08-24T00:00:00.000Z' } },
    ]);
    const legacy = await index.list();
    expect(legacy.todos.map((entry) => entry.todo.id)).toEqual(['started', 'gone']);
    expect(legacy.page).toBeUndefined();
    expect(legacy.counts).toBeUndefined();
  });

  it('returned / total / partitionTotal / hasMore each answer a different question', async () => {
    const rows: TodoItem[] = Array.from({ length: 25 }, (_, i) => ({
      id: `t${String(i).padStart(2, '0')}`,
      summary: i < 10 ? 'alpha row' : 'beta row',
      status: 'todo',
    }));
    const page = await board(rows).list({ partition: 'backlog', limit: 4, q: 'alpha' });
    expect(page.page).toMatchObject({
      partition: 'backlog',
      sort: 'age',
      dir: 'desc',
      limit: 4,
      returned: 4,
      total: 10, // matched the search
      partitionTotal: 25, // in the partition before any search or facet
      hasMore: true,
    });
    expect(page.todos).toHaveLength(4);
  });

  it('hasMore is false when the page holds every match', async () => {
    const page = await board(ROWS).list({ partition: 'backlog', limit: 30 });
    expect(page.page?.hasMore).toBe(false);
    expect(page.page?.returned).toBe(2);
  });

  it('limit defaults to the Active initial row count when the caller omits it', async () => {
    const rows: TodoItem[] = Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, summary: 'row', status: 'todo' }));
    const page = await board(rows).list({ partition: 'backlog' });
    expect(page.page?.limit).toBe(20);
    expect(page.todos).toHaveLength(20);
  });

  it('the facets narrow the page, and each facet count EXCLUDES its own selection', async () => {
    const rows: TodoItem[] = [
      { id: 'h1', summary: 'one', status: 'blocked', priority: 'high' },
      { id: 'h2', summary: 'two', status: 'in-progress', priority: 'high' },
      { id: 'm1', summary: 'three', status: 'blocked', priority: 'medium' },
      { id: 'n1', summary: 'four', status: 'blocked' }, // no priority at all
    ];
    const page = await board(rows).list({ partition: 'active', priority: ['high'] });
    expect(page.todos.map((entry) => entry.todo.id).sort()).toEqual(['h1', 'h2']);
    // `priorities` is counted with the priority facet lifted, so unticking `high` shows what
    // would come back rather than a number that already assumes the tick. `n1` has no priority
    // and is therefore counted under no value at all.
    expect(page.counts?.priorities).toEqual({ high: 2, medium: 1 });
    // `statuses` is counted with the priority facet still applied — only its OWN facet is lifted.
    expect(page.counts?.statuses).toEqual({ blocked: 1, 'in-progress': 1 });
  });

  it('an absent value never matches a non-empty facet selection', async () => {
    const rows: TodoItem[] = [
      { id: 'with', summary: 'has one', status: 'blocked', priority: 'low' },
      { id: 'without', summary: 'has none', status: 'blocked' },
    ];
    const page = await board(rows).list({ partition: 'active', priority: ['low'] });
    expect(page.todos.map((entry) => entry.todo.id)).toEqual(['with']);
  });

  it('the search box reads summary, context and whatToDo, every token', async () => {
    const rows: TodoItem[] = [
      { id: 's', summary: 'needle in the summary', status: 'todo' },
      { id: 'c', summary: 'plain', status: 'todo', context: 'a needle in the context' },
      { id: 'w', summary: 'plain', status: 'todo', whatToDo: 'a NEEDLE in whatToDo' },
      { id: 'n', summary: 'nothing here', status: 'todo' },
    ];
    const index = board(rows);
    expect((await index.list({ partition: 'backlog', q: 'needle' })).todos.map((e) => e.todo.id).sort()).toEqual([
      'c',
      's',
      'w',
    ]);
    // Every token must match somewhere, not just one of them.
    expect((await index.list({ partition: 'backlog', q: 'needle summary' })).todos.map((e) => e.todo.id)).toEqual([
      's',
    ]);
  });

  it('sort and dir reach the ordering module', async () => {
    const rows: TodoItem[] = [
      { id: 'b', summary: 'beta', status: 'todo' },
      { id: 'a', summary: 'alpha', status: 'todo' },
      { id: 'c', summary: 'gamma', status: 'todo' },
    ];
    const index = board(rows);
    expect((await index.list({ partition: 'backlog', sort: 'task', dir: 'asc' })).todos.map((e) => e.todo.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect((await index.list({ partition: 'backlog', sort: 'task', dir: 'desc' })).todos.map((e) => e.todo.id)).toEqual([
      'c',
      'b',
      'a',
    ]);
  });

  it('prefix property over the index itself: limit=2 is the first two rows of limit=10', async () => {
    const rows: TodoItem[] = Array.from({ length: 10 }, (_, i) => ({
      id: `t${i}`,
      summary: `row ${i % 3}`, // deliberate collisions, so the tie-breaker is what decides
      status: 'todo',
    }));
    const index = board(rows);
    for (const sort of ['age', 'task', 'project', 'status', 'priority', 'author'] as const) {
      for (const dir of ['asc', 'desc'] as const) {
        const small = await index.list({ partition: 'backlog', sort, dir, limit: 2 });
        const large = await index.list({ partition: 'backlog', sort, dir, limit: 10 });
        expect(small.todos.map((e) => e.todo.id)).toEqual(large.todos.slice(0, 2).map((e) => e.todo.id));
      }
    }
  });

  it('project health rows are unaffected by paging — total is the project inbox, not the page', async () => {
    const rows: TodoItem[] = Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, summary: 'row', status: 'todo' }));
    const page = await board(rows).list({ partition: 'backlog', limit: 3 });
    expect(page.projects).toEqual([{ id: 'p', name: 'p', status: 'ok', ok: true, total: 12 }]);
  });
});
