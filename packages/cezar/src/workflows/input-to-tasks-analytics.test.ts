import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RunRecord } from '../runs/store.ts';
import { RunStore } from '../runs/store.ts';
import { localCliAuthor } from '../runs/task-author.ts';
import type { TodoItem } from '../todos.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';
import {
  INPUT_TO_TASKS_WORKFLOW,
  inputToTasksPlan,
  isBuiltInInputToTasksRun,
  type WorkflowDef,
} from './types.ts';

const modeCases = [
  { autoStart: false, dispatchMode: 'filed-only', stepCount: 2 },
  { autoStart: true, dispatchMode: 'filed-and-dispatched', stepCount: 3 },
] as const;

describe('input-to-tasks workflow analytics', () => {
  let root: string;
  let projectRootA: string;
  let projectRootB: string;
  let store: RunStore;
  let manager: RunManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-input-to-tasks-analytics-'));
    projectRootA = join(root, 'api');
    projectRootB = join(root, 'web');
    mkdirSync(join(root, '.ai', 'cezar'), { recursive: true });
    mkdirSync(join(projectRootA, '.ai', 'cezar'), { recursive: true });
    mkdirSync(join(projectRootB, '.ai', 'cezar'), { recursive: true });
    store = RunStore.open(join(root, '.ai', 'cezar'));
    manager = new RunManager(store, root, {
      semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 0 } }),
    });
  });

  afterEach(() => {
    manager.dispose();
    store.flush();
    rmSync(root, { recursive: true, force: true });
  });

  const projects = () => [
    { id: 'api', name: 'API', root: projectRootA, status: 'ok' as const },
    { id: 'web', name: 'Web', root: projectRootB, status: 'ok' as const },
  ];

  const todo = (runId: string, id: string, ts: string, mark: 'autostart' | 'started' | 'none'): TodoItem => ({
    id,
    ts,
    summary: `Task ${id}`,
    status: 'todo',
    author: {
      kind: 'agent',
      id: runId,
      via: 'cli-todo-add',
      at: ts,
      parentTaskId: runId,
      agentSessionId: `session-${runId}`,
      parentStepId: 'file',
    },
    ...(mark === 'autostart' ? { autostart: true } : {}),
    ...(mark === 'started' ? { startedTaskId: `started-${id}` } : {}),
  });

  const writeTodos = (runId: string, count: number, marks: boolean): void => {
    const byProject: TodoItem[][] = [[], []];
    for (let index = 0; index < count; index += 1) {
      const projectIndex = index === 2 ? 1 : 0;
      const mark = marks
        ? index === count - 1 && count > 1
          ? 'started'
          : 'autostart'
        : 'none';
      byProject[projectIndex]!.push(todo(runId, `todo-${runId}-${index}`, `2026-08-29T00:00:0${index}Z`, mark));
    }
    const roots = [projectRootA, projectRootB];
    for (let index = 0; index < roots.length; index += 1) {
      writeFileSync(join(roots[index]!, '.ai', 'cezar', 'todos.json'), `${JSON.stringify(byProject[index], null, 2)}\n`, 'utf8');
    }
  };

  const started = (autoStart: boolean): RunRecord => {
    const workflow = inputToTasksPlan(INPUT_TO_TASKS_WORKFLOW, autoStart);
    const run = manager.startRun(workflow, {
      author: localCliAuthor(),
      task: `input-to-tasks ${autoStart ? 'on' : 'off'}`,
      worktree: false,
      workspaceProjects: projects(),
      autoStart,
    });
    return run;
  };

  const settle = async (runId: string): Promise<void> => {
    const run = store.getRun(runId);
    for (const step of run?.steps ?? []) store.updateStep(runId, step.id, { status: 'done' });
    await (manager as unknown as { settleSuccess(id: string): Promise<void> }).settleSuccess(runId);
  };

  const metric = (runId: string, name: string): Array<Record<string, unknown>> =>
    store
      .readEvents(runId)
      .filter((event) => event.type === 'metric' && (event as { name?: unknown }).name === name)
      .map((event) => event as unknown as Record<string, unknown>);

  it.each(modeCases)('emits one shaped planned event for %s mode', ({ autoStart, dispatchMode, stepCount }) => {
    const run = started(autoStart);
    expect(metric(run.id, 'run.input_to_tasks.planned')).toEqual([
      expect.objectContaining({ runId: run.id, dispatchMode, stepCount }),
    ]);
    expect(store.getRun(run.id)?.workflowDef?.steps).toHaveLength(stepCount);
  });

  it.each(modeCases.flatMap((mode) => [
    { ...mode, count: 0, projectCount: 0, marked: 0 },
    { ...mode, count: 1, projectCount: 1, marked: mode.autoStart ? 1 : 0 },
    { ...mode, count: 3, projectCount: 2, marked: mode.autoStart ? 3 : 0 },
  ]))(
    'records the filed-only or filed-and-dispatched result for $count todo(s) in $dispatchMode mode',
    async ({ autoStart, dispatchMode, count, projectCount, marked }) => {
      const run = started(autoStart);
      writeTodos(run.id, count, autoStart);
      await settle(run.id);

      const completed = metric(run.id, 'run.input_to_tasks.completed');
      expect(completed).toEqual([
        expect.objectContaining({
          runId: run.id,
          dispatchMode,
          todoCount: count,
          projectCount,
          autostartMarked: marked,
        }),
      ]);
      expect(store.getRun(run.id)?.filedTodos?.items).toHaveLength(count);
      expect(isBuiltInInputToTasksRun(store.getRun(run.id)!)).toBe(true);
    },
  );

  it('uses the startedTaskId half of the marked predicate and keeps completion idempotent', async () => {
    const run = started(true);
    writeTodos(run.id, 3, true);
    await settle(run.id);
    await settle(run.id);

    const items = store.getRun(run.id)?.filedTodos?.items ?? [];
    expect(items.filter((item) => item.autostart === true || item.startedTaskId !== undefined)).toHaveLength(3);
    expect(metric(run.id, 'run.input_to_tasks.completed')).toHaveLength(1);
  });

  it.each(modeCases)('shapes and persists the catalog fallback for %s mode', async ({ autoStart, stepCount }) => {
    const run = store.createRun({
      author: localCliAuthor(),
      title: 'recovered input-to-tasks run',
      workflow: 'input-to-tasks',
      task: 'recover the plan',
      autoStart,
      workspaceProjects: projects(),
      steps: INPUT_TO_TASKS_WORKFLOW.steps.map((step) => ({
        id: step.id,
        name: step.name ?? step.id,
        kind: 'agent' as const,
      })),
    });
    expect(run.workflowDef).toBeUndefined();

    const revived = await (manager as unknown as {
      reviveWorkflow(record: RunRecord): Promise<WorkflowDef | null>;
    }).reviveWorkflow(run);
    expect(revived?.steps).toHaveLength(stepCount);
    expect(store.getRun(run.id)?.workflowDef?.steps).toHaveLength(stepCount);
    expect(isBuiltInInputToTasksRun(store.getRun(run.id)!)).toBe(true);
  });

  it.each([
    { name: 'spec-to-deploy', source: 'built-in' as const },
    { name: 'input-to-tasks', source: 'file' as const },
  ])('does not emit input-to-tasks metrics for $source:$name', async ({ name, source }) => {
    const definition: WorkflowDef = { ...INPUT_TO_TASKS_WORKFLOW, name, source };
    const run = manager.startRun(definition, {
      author: localCliAuthor(),
      task: 'custom workflow',
      worktree: false,
      workspaceProjects: projects(),
      autoStart: true,
    });
    await settle(run.id);
    expect(metric(run.id, 'run.input_to_tasks.planned')).toHaveLength(0);
    expect(metric(run.id, 'run.input_to_tasks.completed')).toHaveLength(0);
  });
});
