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
