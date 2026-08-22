import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunRecord } from '../runs/store.ts';
import { ProjectContexts } from '../server/project-context.ts';
import { AUTONOMOUS_IMPLEMENTATION_WORKFLOW, type WorkflowDef } from '../workflows/types.ts';
import {
  AUTONOMOUS_DEFAULT_STEP_BUDGET,
  NoteContinuationTrigger,
  type NoteContinuationStartOptions,
} from './continuation.ts';
import { NoteStore } from './store.ts';
import { taskAuthorSchema } from '../runs/task-author.ts';

/**
 * The trigger half of PLAN D27 Phase 3 (`.ai/specs/2026-08-15-autonomous-implementation-
 * continuation.md`).
 *
 * | Guard | Mutation that must turn it red |
 * |---|---|
 * | A non-autonomous note's spec run reaching `done` starts no implementation run | drop the `autonomous` check |
 * | An autonomous note starts exactly ONE implementation run under a double trigger | take the claim after `startRun` |
 * | A failed spec run starts no implementation run | trigger on any terminal state, not only `done` |
 * | An autonomous continuation cannot start unbounded | skip the refuse-or-default budget logic |
 */

interface Started {
  workflow: string;
  task: string;
  options: NoteContinuationStartOptions;
}

describe('NoteContinuationTrigger', () => {
  let home: string;
  let projectRoot: string;
  let store: NoteStore;

  const seedAutonomousNote = async (autonomous: boolean): Promise<string> => {
    const note = await store.capture({ body: 'ship the widget', source: 'cockpit', autonomous });
    await store.update(note.id, {
      pass: {
        id: 'pass_1',
        startedAt: '2026-08-15T10:00:00.000Z',
        runner: 'claude',
        summary: '',
        proposals: [
          {
            id: 'p1',
            projectId: 'api',
            title: 'Widget',
            task: 'Spec the widget.',
            rationale: '',
            issues: [],
            decision: 'pending',
          },
        ],
        unassigned: [],
        fallback: false,
        truncated: false,
        consideredProjects: ['api'],
        boardDigestSize: 0,
      },
    });
    // What `approve.ts` would already have written for the spec leg by the time a spec run can
    // possibly reach `done`.
    await store.recordResultingTask(note.id, {
      proposalId: 'p1',
      projectId: 'api',
      runId: 'run_spec_1',
      kind: 'spec',
    });
    return note.id;
  };

  const specRun = (overrides: Partial<RunRecord> = {}): RunRecord =>
    ({
      id: 'run_spec_1',
      title: 'Spec the widget',
      workflow: 'note-to-spec',
      task: 'Spec the widget.',
      status: 'done',
      createdAt: '2026-08-15T10:00:00.000Z',
      tokensUsed: 0,
      archived: false,
      steps: [],
      ...overrides,
    }) as RunRecord;

  const makeTrigger = () => {
    const started: Started[] = [];
    let counter = 0;
    const trigger = new NoteContinuationTrigger({
      store,
      projectId: 'api',
      projectRoot,
      startRun: async (workflow: WorkflowDef, task: string, options: NoteContinuationStartOptions) => {
        started.push({ workflow: workflow.name, task, options });
        return { id: `run_impl_${++counter}` } as RunRecord;
      },
    });
    return { trigger, started };
  };

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-continuation-'));
    store = new NoteStore({ paths: { notes: join(home, 'notes.json'), log: join(home, 'notes-log.ndjson') } });
    projectRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-continuation-root-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('starts an implementation run for an autonomous note whose spec run reached done', async () => {
    const noteId = await seedAutonomousNote(true);
    const { trigger, started } = makeTrigger();

    await trigger.onRunSettled(specRun({ declaredSpecPath: '.ai/specs/2026-08-15-widget.md' }));

    expect(started).toHaveLength(1);
    expect(started[0]?.workflow).toBe(AUTONOMOUS_IMPLEMENTATION_WORKFLOW.name);
    expect(started[0]?.task).toBe('Implement the spec at .ai/specs/2026-08-15-widget.md.');
    expect(started[0]?.options.autonomous).toBe(true);

    const note = store.get(noteId);
    expect(note?.resultingTasks.map((row) => [row.kind, row.runId])).toEqual([
      ['spec', 'run_spec_1'],
      ['implementation', 'run_impl_1'],
    ]);
  });

  it('names the run instead of guessing a path when the spec run never declared one', async () => {
    await seedAutonomousNote(true);
    const { trigger, started } = makeTrigger();

    await trigger.onRunSettled(specRun()); // no declaredSpecPath

    expect(started).toHaveLength(1);
    expect(started[0]?.task).toContain('run_spec_1');
    expect(started[0]?.task).not.toContain('.ai/specs');
  });

  it('does not start when the note is not autonomous', async () => {
    await seedAutonomousNote(false);
    const { trigger, started } = makeTrigger();

    await trigger.onRunSettled(specRun());

    expect(started).toHaveLength(0);
  });

  it('does not start for a failed spec run', async () => {
    await seedAutonomousNote(true);
    const { trigger, started } = makeTrigger();

    await trigger.onRunSettled(specRun({ status: 'failed' }));

    expect(started).toHaveLength(0);
  });

  it('does not start for a run unrelated to any note', async () => {
    const { trigger, started } = makeTrigger();

    await trigger.onRunSettled(specRun({ id: 'run_unrelated' }));

    expect(started).toHaveLength(0);
  });

  /**
   * THE guard: both calls issued before either is awaited, which is what two overlapping `'run'`
   * events (a store event fired more than once while status stays `done`) would produce. Claiming
   * after `startRun` would let both see an unclaimed proposal and start two agent runs.
   */
  it('starts exactly one implementation run under a double trigger', async () => {
    await seedAutonomousNote(true);
    const { trigger, started } = makeTrigger();

    await Promise.all([trigger.onRunSettled(specRun()), trigger.onRunSettled(specRun())]);

    expect(started).toHaveLength(1);
  });

  it('releases the claim when starting the run throws, so a retry is not stuck', async () => {
    const noteId = await seedAutonomousNote(true);
    const trigger = new NoteContinuationTrigger({
      store,
      projectId: 'api',
      projectRoot,
      startRun: async () => {
        throw new Error('boom');
      },
    });

    await trigger.onRunSettled(specRun());

    const note = store.get(noteId);
    expect(note?.resultingTasks).toHaveLength(1); // only the spec leg
    const proposal = note?.pass?.proposals.find((p) => p.id === 'p1');
    expect(proposal?.implementationRunId).toBeUndefined();
  });

  // ---- the bound (PLAN D27 Phase 3's "trap") ---------------------------------------------------

  it('gives the implementation run its own step budget when the project configures none', async () => {
    await seedAutonomousNote(true);
    const { trigger, started } = makeTrigger();

    await trigger.onRunSettled(specRun());

    expect(started[0]?.options.stepBudgetOverride).toBe(AUTONOMOUS_DEFAULT_STEP_BUDGET);
  });

  it("defers to the project's own configured step budget instead of overriding it", async () => {
    mkdirSync(join(projectRoot, '.ai/cezar'), { recursive: true });
    writeFileSync(join(projectRoot, '.ai/cezar', 'config.json'), JSON.stringify({ stepBudget: 12 }));
    await seedAutonomousNote(true);
    const { trigger, started } = makeTrigger();

    await trigger.onRunSettled(specRun());

    // undefined here means "no per-run override" — `budgetSpent()` (`workflows/run.ts`) then reads
    // straight through to `config.stepBudget`, which is already 12.
    expect(started[0]?.options.stepBudgetOverride).toBeUndefined();
  });

  it('the implementation run is authored BY the spec run — parent task and session, not prose in a prompt', async () => {
    // Before this (spec 2026-08-21-task-author-provenance) the child's only trace of its parent
    // was the sentence "Implement the spec written by run <id>" inside its own prompt.
    await seedAutonomousNote(true);
    const { trigger, started } = makeTrigger();

    await trigger.onRunSettled(
      specRun({
        declaredSpecPath: '.ai/specs/2026-08-15-widget.md',
        steps: [
          { id: 'spec', name: 'spec', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0, sessionId: 'sess_spec' },
        ],
      }),
    );

    expect(started[0]?.options.author).toMatchObject({
      kind: 'agent',
      id: 'run_spec_1',
      via: 'note-continuation',
      parentTaskId: 'run_spec_1',
      agentSessionId: 'sess_spec',
      parentStepId: 'spec',
    });
    expect(taskAuthorSchema.safeParse(started[0]?.options.author).success).toBe(true);
  });

  it('a spec run whose steps carry no session id yields `system` that still names the parent', async () => {
    // The schema refuses an `agent` author it cannot fully name, so a half-true one is impossible
    // by construction — and an honest `system` still records which run caused this one.
    await seedAutonomousNote(true);
    const { trigger, started } = makeTrigger();

    await trigger.onRunSettled(specRun({ declaredSpecPath: '.ai/specs/2026-08-15-widget.md' }));

    expect(started[0]?.options.author).toMatchObject({ kind: 'system', parentTaskId: 'run_spec_1' });
    expect(taskAuthorSchema.safeParse(started[0]?.options.author).success).toBe(true);
  });
});

// ---- the triage/continuation path still builds no ProjectContext it was not already given -------
//
// Mirrors `processor.test.ts`'s own structural guard for the triage pass, plus a live behavioural
// companion: `NoteContinuationTrigger` is instantiated once per ALREADY-BUILT `ProjectContext`
// (`server.ts`'s wiring), never given a `ProjectContexts`/`listProjects` handle of its own, so
// there is no path from a settled run back to building a context that would not otherwise exist.

function transitiveImports(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const specifier = match[1] as string;
      queue.push(resolve(dirname(file), specifier));
    }
  }
  return seen;
}

describe('the continuation trigger never reaches ProjectContexts', () => {
  const graph = transitiveImports(new URL('./continuation.ts', import.meta.url).pathname);

  it('imports neither project-context.ts nor workflows/run.ts, at any depth', () => {
    const offenders = [...graph].filter(
      (file) => /server\/project-context\.ts$/.test(file) || /workflows\/run\.ts$/.test(file),
    );
    expect(offenders).toEqual([]);
  });

  it('the walker really does follow imports more than one level deep', () => {
    expect(graph.size).toBeGreaterThan(3);
    expect([...graph].some((file) => /workflows\/load\.ts$/.test(file))).toBe(true);
  });

  it('a settled run never grows contexts.ids(), even with a live ProjectContexts in scope', async () => {
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-continuation-noctx-'));
    const rootA = mkdtempSync(join(realpathSync(tmpdir()), 'cez-continuation-ctxa-'));
    const store = new NoteStore({ paths: { notes: join(home, 'notes.json'), log: join(home, 'notes-log.ndjson') } });
    const contexts = new ProjectContexts({
      listProjects: async () => [{ id: 'api', root: rootA, status: 'not-git' as const }],
    });
    try {
      // Simulate approval already having built this one project — the only context that can
      // possibly exist by the time its OWN spec run reaches `done`.
      const ctx = await contexts.context('api');
      expect(contexts.ids()).toEqual(['api']);

      const note = await store.capture({ body: 'ship it', source: 'cockpit', autonomous: true });
      await store.update(note.id, {
        pass: {
          id: 'pass_1',
          startedAt: '2026-08-15T10:00:00.000Z',
          runner: 'claude',
          summary: '',
          proposals: [
            { id: 'p1', projectId: 'api', title: 'Widget', task: 'Spec the widget.', rationale: '', issues: [], decision: 'pending' },
          ],
          unassigned: [],
          fallback: false,
          truncated: false,
          consideredProjects: ['api'],
          boardDigestSize: 0,
        },
      });
      await store.recordResultingTask(note.id, { proposalId: 'p1', projectId: 'api', runId: 'run_spec_1', kind: 'spec' });

      const trigger = new NoteContinuationTrigger({
        store,
        projectId: ctx.id,
        projectRoot: ctx.root,
        startRun: async () => ({ id: 'run_impl_1' }) as RunRecord,
      });
      await trigger.onRunSettled({
        id: 'run_spec_1',
        title: 'Spec the widget',
        workflow: 'note-to-spec',
        task: 'Spec the widget.',
        status: 'done',
        createdAt: '2026-08-15T10:00:00.000Z',
        tokensUsed: 0,
        archived: false,
        steps: [],
      } as RunRecord);

      // The whole point: an implementation run started, and NO project got lazily instantiated as
      // a side effect of that — `contexts.ids()` is exactly what it was before the trigger ran.
      expect(contexts.ids()).toEqual(['api']);
      expect(existsSync(join(rootA, '.ai/cezar'))).toBe(true); // built once, by the `context()` call above
    } finally {
      contexts.disposeAll();
      rmSync(home, { recursive: true, force: true });
      rmSync(rootA, { recursive: true, force: true });
    }
  });
});
