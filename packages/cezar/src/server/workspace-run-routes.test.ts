import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { taskAuthorSchema } from '../runs/task-author.ts';
import { createWorkspaceRunRoutes, type WorkspaceRunRouteDeps } from './workspace-run-routes.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import type { ProjectApiEnv } from './server.ts';
import type { RunRecord } from '../runs/store.ts';
import type { StartRunInput } from '../workflows/run.ts';
import { INPUT_TO_TASKS_WORKFLOW } from '../workflows/types.ts';
import type { WorkflowDef } from '../workflows/types.ts';
import { buildWorkspaceGrant } from '../workspace/granted-roots.ts';

/**
 * `POST /api/v1/workspace/runs` (`.ai/specs/2026-08-15-cross-project-workspace-run.md`).
 *
 * The route layer only: the grant's own rules live in `../workspace/granted-roots.test.ts` and the
 * grant reaching the spawn lives in `../workflows/workspace-grant-wiring.test.ts`. What is
 * asserted here is the three decisions this route owns and nothing else owns — `worktree: false`,
 * the grant handed to `startRun`, and refusing rather than starting an empty workspace run — plus
 * that it stays ungated on a default install.
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

const WORKFLOW: WorkflowDef = {
  name: 'quick-task',
  source: 'built-in',
  steps: [{ id: 'work', prompt: '{{task}}' }],
};

const PROJECTS = [
  { id: 'monorepo', name: 'monorepo', root: '/w/monorepo', status: 'ok' as const },
  { id: 'cezar', name: 'cezar', root: '/w/monorepo/cezar', status: 'ok' as const },
  { id: 'gone', name: 'gone', root: '/w/gone', status: 'missing' as const },
];

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'ws-run-1',
    title: 't',
    workflow: 'quick-task',
    task: 't',
    status: 'queued',
    createdAt: '2026-08-16T00:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...overrides,
  } as RunRecord;
}

function harness(overrides: Partial<WorkspaceRunRouteDeps> = {}) {
  const started: Array<{ workflow: WorkflowDef; input: StartRunInput }> = [];
  const deps: WorkspaceRunRouteDeps = {
    bootProject: async () => 'cockpit-boot',
    bootRoot: '/w/boot',
    startRun: (workflow, input) => {
      started.push({ workflow, input });
      return record();
    },
    resolveWorkflow: async () => ({ workflow: WORKFLOW }),
    guard: async () => null,
    loadGrant: async () => buildWorkspaceGrant(PROJECTS),
    ...overrides,
  };
  const app = new Hono<ProjectApiEnv>().route('/api/v1', createWorkspaceRunRoutes(deps));
  return { app, started };
}

const post = (app: Hono<ProjectApiEnv>, body: unknown) =>
  apiRequest(app, '/api/v1/workspace/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /api/v1/workspace/runs', () => {
  it('starts exactly one run, in place, with the whole grant', async () => {
    const { app, started } = harness();
    const res = await post(app, { task: 'touch every project' });

    expect(res.status).toBe(201);
    expect(started).toHaveLength(1);
    // The two decisions this route owns and nothing else does.
    expect(started[0]!.input.worktree).toBe(false);
    expect(started[0]!.input.workspaceProjects).toEqual(PROJECTS);
    expect(started[0]!.input.task).toBe('touch every project');
  });

  it('records who asked, through the SAME helper POST /runs uses', async () => {
    // The two composer submits must never disagree about who started a task
    // (spec 2026-08-21-task-author-provenance) — only `via` distinguishes them.
    const { app, started } = harness();
    await apiRequest(app, '/api/v1/workspace/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ task: 'touch every project' }),
    });
    expect(started[0]!.input.author).toMatchObject({ kind: 'user', id: 'local', via: 'workspace-composer' });
    expect(taskAuthorSchema.safeParse(started[0]!.input.author).success).toBe(true);
  });

  it('a scripted workspace submit is `api`, not a person', async () => {
    const { app, started } = harness();
    await post(app, { task: 'touch every project' });
    expect(started[0]!.input.author).toMatchObject({ kind: 'api', via: 'workspace-composer' });
  });

  it('answers with the boot project and the deduped granted roots', async () => {
    const { app } = harness();
    const body = (await (await post(app, { task: 'x' })).json()) as {
      project: string;
      grantedRoots: string[];
      run: { id: string };
    };
    // `project` is what the client navigates to — a run lives in the boot project's `runs.json`.
    expect(body.project).toBe('cockpit-boot');
    expect(body.run.id).toBe('ws-run-1');
    // Deduped by containment, and the missing project contributes nothing: rendered, so a grant
    // that collapsed to one directory cannot look like one that reached everything.
    expect(body.grantedRoots).toEqual(['/w/monorepo']);
  });

  it('refuses rather than starting a run with nothing to work in', async () => {
    // Starting an agent in an empty scratch repo and calling it a workspace run is the exact "it
    // worked, and nothing happened" shape this spec exists to remove.
    const { app, started } = harness({
      loadGrant: async () => buildWorkspaceGrant([{ ...PROJECTS[2]! }]),
    });
    const res = await post(app, { task: 'x' });

    expect(res.status).toBe(409);
    expect(started).toHaveLength(0);
    expect(((await res.json()) as { error: string }).error).toContain('no registered project');
  });

  it('never accepts the three keys a workspace run fixes', async () => {
    // `worktree`/`variants`/`todoId` are omitted from the schema, so a client asking for them is a
    // 400 rather than a value the server silently ignores — the difference between "we heard you
    // and refused" and "we heard you and did something else".
    const { app, started } = harness();
    for (const extra of [{ worktree: true }, { variants: 3 }, { todoId: 'todo-1' }]) {
      const res = await post(app, { task: 'x', ...extra });
      expect(res.status).toBe(400);
    }
    expect(started).toHaveLength(0);
  });

  it('passes the caller-facing guards through with their own status codes', async () => {
    for (const [status, error] of [
      [409, 'models are locked'],
      [400, 'unknown claude account: gone'],
    ] as const) {
      const { app, started } = harness({ guard: async () => ({ error, status }) });
      const res = await post(app, { task: 'x' });
      expect(res.status).toBe(status);
      expect(((await res.json()) as { error: string }).error).toBe(error);
      // Guarded means NOT started — a 409 that still spawned an agent would be the worst of both.
      expect(started).toHaveLength(0);
    }
  });

  it('404s an unknown workflow, exactly as POST /runs does', async () => {
    const { app, started } = harness({
      resolveWorkflow: async () => ({ error: 'unknown workflow: nope', status: 404 }),
    });
    expect((await post(app, { task: 'x', workflow: 'nope' })).status).toBe(404);
    expect(started).toHaveLength(0);
  });

  it('is ungated: a default install with every flag unset still starts the run', async () => {
    // Same reasoning the route it replaces recorded: this is the composer's default submit path on
    // a multi-project workspace, and gating a main path on a flag nobody sets makes it fail as
    // silence. A reinstated capability check turns this red.
    for (const key of ENV_KEYS) delete process.env[key];
    const { app, started } = harness();
    expect((await post(app, { task: 'x' })).status).toBe(201);
    expect(started).toHaveLength(1);
  });
  /**
   * `.ai/specs/2026-08-25-workspace-scope-routes-tasks.md`, Phase 2/3 — the two things this route
   * gained. Both are invisible to every case above: `resolveWorkflow` is stubbed, so the workflow
   * NAME the route asks for is never inspected, and `autoStart` simply rides in the input object.
   */
  describe('input-to-tasks default and autoStart', () => {
    /** Records what the route asked `resolveWorkflow` for — the only place the default is visible. */
    const asking = (resolvedWorkflow: WorkflowDef = WORKFLOW) => {
      const asked: Array<Record<string, unknown>> = [];
      const h = harness({
        resolveWorkflow: async (_root: string, opts: Record<string, unknown>) => {
          asked.push(opts);
          return { workflow: resolvedWorkflow };
        },
      } as Partial<WorkspaceRunRouteDeps>);
      return { ...h, asked };
    };

    it('names input-to-tasks when the caller named no workflow', async () => {
      const { app, asked } = asking();
      expect((await post(app, { task: 'sweep the boards' })).status).toBe(201);
      expect(asked).toHaveLength(1);
      expect(asked[0]!.workflow).toBe('input-to-tasks');
    });

    it('is a DEFAULT, not a restriction: a named workflow still wins', async () => {
      // cezar is published, and rejecting a workflow name that worked yesterday is breaking
      // (`BACKWARD_COMPATIBILITY.md`). The composer offers one workflow here; the route does not.
      const { app, asked } = asking();
      expect((await post(app, { task: 'x', workflow: 'spec-to-deploy' })).status).toBe(201);
      expect(asked[0]!.workflow).toBe('spec-to-deploy');
    });

    it('injects no workflow name when the caller sent an inline chain', async () => {
      // `steps` IS the workflow. Defaulting a name alongside it would hand `resolveWorkflow` two
      // answers to the same question, and the automations/scripted callers that post inline chains
      // are exactly the ones with no composer to have picked for them.
      const { app, asked } = asking();
      const steps = [{ id: 'only', prompt: '{{task}}' }];
      expect((await post(app, { task: 'x', steps })).status).toBe(201);
      expect(asked[0]).not.toHaveProperty('workflow');
      expect(asked[0]!.steps).toEqual(steps);
    });

    it('passes autoStart through in both directions, and omits it when unasked', async () => {
      // Absent, `true` and `false` are three distinct answers: the record has to say what was
      // ASKED FOR, or the optional dispatch step doing nothing reads as a step that failed.
      for (const [body, expected] of [
        [{ task: 'x' }, undefined],
        [{ task: 'x', autoStart: true }, true],
        [{ task: 'x', autoStart: false }, false],
      ] as const) {
        const { app, started } = harness();
        expect((await post(app, body)).status).toBe(201);
        expect(started[0]!.input.autoStart).toBe(expected);
      }
    });

    it.each([
      [{ task: 'x' }, 2],
      [{ task: 'x', autoStart: false }, 2],
      [{ task: 'x', autoStart: true }, 3],
    ] as const)('freezes %j into the built-in workflow topology', async (body, stepCount) => {
      const { app, started } = asking(INPUT_TO_TASKS_WORKFLOW);
      expect((await post(app, body)).status).toBe(201);
      expect(started[0]!.workflow.steps).toHaveLength(stepCount);
      expect(started[0]!.workflow.steps.some((step) => step.id === 'dispatch')).toBe(stepCount === 3);
    });

    it('leaves a named non-built-in workflow and an inline chain untouched', async () => {
      const custom = { ...INPUT_TO_TASKS_WORKFLOW, name: 'spec-to-deploy' };
      const named = asking(custom);
      expect((await post(named.app, { task: 'x', workflow: 'spec-to-deploy', autoStart: false })).status).toBe(201);
      expect(named.started[0]!.workflow).toBe(custom);

      const inline = { ...WORKFLOW, name: 'inline' };
      const inlineRun = asking(inline);
      const steps = [{ id: 'only', prompt: '{{task}}' }];
      expect((await post(inlineRun.app, { task: 'x', steps, autoStart: false })).status).toBe(201);
      expect(inlineRun.started[0]!.workflow).toBe(inline);
    });

    it('rejects a non-boolean autoStart rather than coercing it', async () => {
      // The schema is `.strict()` and this is a new key on it — a string "true" from a hand-rolled
      // client must 400, not arrive as a truthy value nobody meant.
      const { app, started } = harness();
      expect((await post(app, { task: 'x', autoStart: 'true' })).status).toBe(400);
      expect(started).toHaveLength(0);
    });
  });

  /**
   * Composer review-step toggles (`.ai/specs/2026-08-30-composer-review-step-toggles.md`).
   * `workspaceRunStartInputSchema` inherits `reviewSameModel`/`reviewCrossModel` from
   * `createRunInputBaseSchema` by omission (no `.strict()` rejection), and this route must thread
   * both into `deps.resolveWorkflow` exactly like `workflow`/`steps` — the filtering itself lives
   * inside that injected function, so this only pins that the fields actually reach it.
   */
  it('threads reviewSameModel/reviewCrossModel into resolveWorkflow', async () => {
    let received: unknown;
    const { app, started } = harness({
      resolveWorkflow: async (_root, body) => {
        received = body;
        return { workflow: WORKFLOW };
      },
    });
    const res = await post(app, { task: 'x', reviewSameModel: false, reviewCrossModel: true });
    expect(res.status).toBe(201);
    expect(received).toMatchObject({ reviewSameModel: false, reviewCrossModel: true });
    expect(started).toHaveLength(1);
  });

  it('omits both keys from resolveWorkflow when the body never named them', async () => {
    let received: unknown;
    const { app } = harness({
      resolveWorkflow: async (_root, body) => {
        received = body;
        return { workflow: WORKFLOW };
      },
    });
    expect((await post(app, { task: 'x' })).status).toBe(201);
    expect(received).not.toHaveProperty('reviewSameModel');
    expect(received).not.toHaveProperty('reviewCrossModel');
  });
});
