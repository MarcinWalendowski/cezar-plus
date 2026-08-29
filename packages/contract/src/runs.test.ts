import { describe, expect, it } from 'vitest';
import { runRecordSchema, testAttestationSchema } from './runs.ts';

describe('testAttestationSchema', () => {
  const legacy = {
    stepId: 'run-tests',
    treeSha: '1'.repeat(40),
    at: new Date().toISOString(),
  };

  it('keeps released single-tree attestations valid', () => {
    expect(testAttestationSchema.parse(legacy)).toEqual(legacy);
  });

  it('accepts per-project workspace trees', () => {
    expect(testAttestationSchema.parse({
      ...legacy,
      projects: [{
        root: '/projects/example',
        worktreePath: '/worktrees/example',
        treeSha: '2'.repeat(40),
        headSha: '3'.repeat(40),
      }],
    }).projects).toHaveLength(1);
  });
});

describe('runRecordSchema filed todo ledger', () => {
  const base = {
    id: 'run-1',
    title: 'route work',
    workflow: 'input-to-tasks',
    task: 'route work',
    status: 'done' as const,
    createdAt: '2026-08-29T00:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
  };

  it.each([
    { stepIds: ['context', 'file'], autoStart: undefined, count: 0, marks: [] },
    { stepIds: ['context', 'file'], autoStart: false, count: 1, marks: ['none'] },
    { stepIds: ['context', 'file'], autoStart: true, count: 3, marks: ['none', 'none', 'none'] },
    { stepIds: ['context', 'file', 'dispatch'], autoStart: undefined, count: 0, marks: [] },
    { stepIds: ['context', 'file', 'dispatch'], autoStart: false, count: 1, marks: ['autostart'] },
    { stepIds: ['context', 'file', 'dispatch'], autoStart: true, count: 3, marks: ['autostart', 'started', 'none'] },
  ] as const)('round-trips $stepIds with autoStart=$autoStart and $count filed todo(s)', ({ stepIds, autoStart, marks }) => {
    const items = marks.map((mark, index) => ({
      project: index === 2 ? 'project-b' : 'project-a',
      todoId: `todo-${index}`,
      summary: `Task ${index}`,
      ...(mark === 'autostart' ? { autostart: true as const } : {}),
      ...(mark === 'started' ? { startedTaskId: `run-${index}` } : {}),
    }));
    const input = {
      ...base,
      steps: stepIds.map((id) => ({ id, name: id, kind: 'agent' as const, status: 'done' as const, iterations: 1, tokensUsed: 0 })),
      ...(autoStart === undefined ? {} : { autoStart }),
      filedTodos: { items, at: base.createdAt },
    };
    const parsed = runRecordSchema.parse(input);
    expect(parsed).toEqual(input);
    expect('autoStart' in parsed).toBe(autoStart !== undefined);
  });

  it('accepts a legacy run without the new ledger', () => {
    expect(runRecordSchema.parse(base).filedTodos).toBeUndefined();
  });

  it('rejects an overlong summary and false autostart marker', () => {
    expect(() => runRecordSchema.parse({
      ...base,
      filedTodos: { at: base.createdAt, items: [{ project: 'p', todoId: 't', summary: 'x'.repeat(501) }] },
    })).toThrow();
    expect(() => runRecordSchema.parse({
      ...base,
      filedTodos: { at: base.createdAt, items: [{ project: 'p', todoId: 't', summary: 'x', autostart: false }] },
    })).toThrow();
  });
});
