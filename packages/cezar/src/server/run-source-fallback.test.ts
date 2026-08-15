import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager, StartRunInput } from '../workflows/run.ts';
import type { WorkflowDef } from '../workflows/types.ts';
import { WORKFLOWS_DIR } from '../workflows/load.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';

/**
 * `POST /api/v1/runs` — "at most one of workflow/steps" (spec
 * 2026-08-15-composer-stops-forcing-choices, D3 + D4). Neither key present used to be a 400
 * ("provide either workflow or steps"); it now resolves to quick-task server-side, the same
 * resolution `POST /todos/:id/start` already had — the composer's "None" pill sends this body.
 * Both keys present is still rejected: the relaxation is at-most-one, not "either or neither".
 */
describe('POST /api/v1/runs — neither workflow nor steps resolves to quick-task (D3 + D4)', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  let capturedWorkflow: WorkflowDef | undefined;
  let capturedInput: StartRunInput | undefined;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-run-source-fallback-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    capturedWorkflow = undefined;
    capturedInput = undefined;
    const manager = {
      startRun: (workflow: WorkflowDef, input: StartRunInput) => {
        capturedWorkflow = workflow;
        capturedInput = input;
        return store.createRun({ title: 't', workflow: workflow.name, task: input.task, steps: [] });
      },
    } as unknown as RunManager;
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

  const post = (body: unknown) =>
    apiRequest(app, '/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('a body with neither workflow nor steps is a 201, not a 400', async () => {
    const res = await post({ task: 'whatever the server picks' });
    expect(res.status).toBe(201);
    expect(capturedWorkflow?.name).toBe('quick-task');
    expect(capturedInput?.task).toBe('whatever the server picks');
  });

  it('both workflow and steps present is still rejected — the relaxation is at-most-one, not any', async () => {
    const res = await post({
      task: 't',
      workflow: 'quick-task',
      steps: [{ id: 'work', prompt: '{{task}}' }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    // Matches the relaxed refine's message in both `packages/contract/src/runs.ts` and the
    // server's own duplicate schema — "either... not both" would be stale once the XOR became
    // "at most one".
    expect(body.error).toContain('not both');
    expect(capturedWorkflow).toBeUndefined();
    expect(capturedInput).toBeUndefined();
  });

  it('a named workflow that does not exist is still a 404 — the fallback only applies when nothing is named', async () => {
    const res = await post({ task: 't', workflow: 'no-such-workflow' });
    expect(res.status).toBe(404);
    expect(capturedWorkflow).toBeUndefined();
  });

  it("falls back to the BUILT-IN quick-task when the project has not overridden it", async () => {
    const res = await post({ task: 't' });
    expect(res.status).toBe(201);
    expect(capturedWorkflow?.name).toBe('quick-task');
    expect(capturedWorkflow?.source).toBe('built-in');
  });

  it("a project's own quick-task.yaml wins over the built-in — same precedence loadWorkflows always applies", async () => {
    const dir = join(repoRoot, WORKFLOWS_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'quick-task.yaml'),
      [
        'name: quick-task',
        'description: project override',
        'steps:',
        '  - id: task',
        '    name: Do the task, project override',
        '    prompt: "{{task}}"',
        '',
      ].join('\n'),
      'utf8',
    );
    const res = await post({ task: 't' });
    expect(res.status).toBe(201);
    expect(capturedWorkflow?.name).toBe('quick-task');
    expect(capturedWorkflow?.source).toBe('file');
    expect(capturedWorkflow?.description).toBe('project override');
  });
});
