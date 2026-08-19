import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from './runs/store.ts';
import type { RunManager, StartRunInput } from './workflows/run.ts';
import type { WorkflowDef } from './workflows/types.ts';
import { readTodos, todosPath, type TodoItem } from './todos.ts';
import { reconcileAutostartTodos, watchTodoAutostart, type TodoAutostartProject } from './todo-autostart.ts';

/**
 * Phase 2 — `cezar todo add --start` (`.ai/specs/2026-08-19-file-tasks-from-a-running-task.md`).
 * `reconcileAutostartTodos`/`watchTodoAutostart` are the runtime hook that turns an
 * `autostart: true` todo into a run through the OWNING project's own manager, mirroring
 * `todos-start.test.ts`'s capturing-stub pattern for `RunManager` rather than spawning a real
 * agent.
 */

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

describe('reconcileAutostartTodos', () => {
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let started: StartRunInput[];
  let project: TodoAutostartProject;

  const writeTodos = (todos: TodoItem[]) => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(todosPath(dataDir), JSON.stringify(todos, null, 2), 'utf8');
  };

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-todo-autostart-'));
    dataDir = join(repoRoot, '.ai/cezar');
    store = RunStore.open(dataDir);
    started = [];
    const manager = {
      startRun: (_workflow: WorkflowDef, input: StartRunInput) => {
        started.push(input);
        return store.createRun({ title: 't', workflow: '(inbox)', task: input.task, steps: [] });
      },
    } as unknown as RunManager;
    project = { repoRoot, dataDir, manager };
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('starts an autostart todo and stamps startedTaskId + clears autostart on disk', async () => {
    writeTodos([{ id: 't1', summary: 'Ship it', autostart: true }]);
    await reconcileAutostartTodos(project);

    expect(started).toHaveLength(1);
    expect(started[0]?.task).toBe('Ship it');

    const [todo] = await readTodos(dataDir);
    expect(todo?.startedTaskId).toBeTruthy();
    expect(todo?.autostart).toBeUndefined();
  });

  it('ignores a todo with no autostart flag', async () => {
    writeTodos([{ id: 't1', summary: 'Just a backlog entry' }]);
    await reconcileAutostartTodos(project);
    expect(started).toHaveLength(0);
  });

  it('double-start guard: an already-started entry is never started twice', async () => {
    writeTodos([{ id: 't1', summary: 'Ship it', autostart: true, startedTaskId: 'run-already' }]);
    await reconcileAutostartTodos(project);
    expect(started).toHaveLength(0);
  });

  it('a failing todo does not block the rest of the file', async () => {
    writeTodos([
      { id: 'bad', summary: 'Boom', autostart: true, suggestedSkill: 'x'.repeat(5000) },
      { id: 'ok', summary: 'Fine', autostart: true },
    ]);
    // `resolveTodoWorkflow` never throws on an unknown skill (falls back to quick-task), so force a
    // failure a different way: make the manager itself throw for the first todo only.
    const manager = {
      startRun: (_workflow: WorkflowDef, input: StartRunInput) => {
        if (input.task === 'Boom') throw new Error('spawn failed');
        started.push(input);
        return store.createRun({ title: 't', workflow: '(inbox)', task: input.task, steps: [] });
      },
    } as unknown as RunManager;
    await reconcileAutostartTodos({ ...project, manager });
    expect(started).toHaveLength(1);
    expect(started[0]?.task).toBe('Fine');
  });

  it('two overlapping reconcile calls for the same project serialize — the todo starts exactly once', async () => {
    writeTodos([{ id: 't1', summary: 'Ship it', autostart: true }]);
    let calls = 0;
    const manager = {
      startRun: (_workflow: WorkflowDef, input: StartRunInput) => {
        calls += 1;
        return store.createRun({ title: 't', workflow: '(inbox)', task: input.task, steps: [] });
      },
    } as unknown as RunManager;
    const raced = { ...project, manager };
    // Neither call is awaited before the second fires — reconcileAutostartTodos' own per-dataDir
    // tail is what has to keep these from both reading the file before either's markStarted lands.
    await Promise.all([reconcileAutostartTodos(raced), reconcileAutostartTodos(raced)]);
    expect(calls).toBe(1);
  });
});

describe('watchTodoAutostart', () => {
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let started: StartRunInput[];
  const cleanups: Array<() => void> = [];

  const writeTodos = (todos: TodoItem[]) => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(todosPath(dataDir), JSON.stringify(todos, null, 2), 'utf8');
  };

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-todo-autostart-watch-'));
    dataDir = join(repoRoot, '.ai/cezar');
    store = RunStore.open(dataDir);
    started = [];
  });

  afterEach(() => {
    for (const off of cleanups.splice(0)) off();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const fakeProject = (): TodoAutostartProject => {
    const manager = {
      startRun: (_workflow: WorkflowDef, input: StartRunInput) => {
        started.push(input);
        return store.createRun({ title: 't', workflow: '(inbox)', task: input.task, steps: [] });
      },
    } as unknown as RunManager;
    return { repoRoot, dataDir, manager };
  };

  it('the boot pass starts an autostart todo already sitting in the file at subscribe time', async () => {
    writeTodos([{ id: 't1', summary: 'Already flagged', autostart: true }]);
    const stop = watchTodoAutostart(fakeProject());
    cleanups.push(stop);
    await waitFor(() => expect(started).toHaveLength(1));
  });

  it('a later write to todos.json is picked up live', async () => {
    writeTodos([]);
    const stop = watchTodoAutostart(fakeProject());
    cleanups.push(stop);
    await waitFor(() => expect(started).toHaveLength(0)); // settle the boot pass first
    await fs.writeFile(
      todosPath(dataDir),
      JSON.stringify([{ id: 't2', summary: 'Filed later', autostart: true }], null, 2),
    );
    await waitFor(() => expect(started).toHaveLength(1), 6000);
  });

  it('re-subscribing the same dataDir replaces the old watch rather than stacking a second one', async () => {
    writeTodos([]);
    const first = watchTodoAutostart(fakeProject());
    const second = watchTodoAutostart(fakeProject());
    cleanups.push(second);
    // The first subscription's own unsubscribe must be a safe no-op after being superseded.
    expect(() => first()).not.toThrow();
  });
});
