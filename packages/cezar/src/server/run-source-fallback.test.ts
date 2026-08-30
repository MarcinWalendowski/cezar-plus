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
import { localCliAuthor } from '../runs/task-author.ts';

/**
 * `POST /api/v1/runs` — "at most one of workflow/steps" (spec
 * 2026-08-15-composer-stops-forcing-choices, D3 + D4). Neither key present used to be a 400
 * ("provide either workflow or steps"); it now resolves to the DEFAULT workflow server-side, the
 * same resolution `POST /todos/:id/start` already had — the composer's "None" pill sends this body.
 * The default floor is `spec-to-deploy` (owner decision 2026-08-19, spec
 * 2026-08-19-spec-to-deploy-default-workflow), moved off `quick-task` via `DEFAULT_WORKFLOW_NAME`.
 * Both keys present is still rejected: the relaxation is at-most-one, not "either or neither".
 */
describe('POST /api/v1/runs — neither workflow nor steps resolves to the default (D3 + D4)', () => {
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
        return store.createRun({ author: localCliAuthor(), title: 't', workflow: workflow.name, task: input.task, steps: [] });
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
    expect(capturedWorkflow?.name).toBe('spec-to-deploy');
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

  it("falls back to the BUILT-IN spec-to-deploy when the project has not overridden it", async () => {
    const res = await post({ task: 't' });
    expect(res.status).toBe(201);
    expect(capturedWorkflow?.name).toBe('spec-to-deploy');
    expect(capturedWorkflow?.source).toBe('built-in');
  });

  it("a project's own spec-to-deploy.yaml wins over the built-in — same precedence loadWorkflows always applies", async () => {
    const dir = join(repoRoot, WORKFLOWS_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'spec-to-deploy.yaml'),
      [
        'name: spec-to-deploy',
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
    expect(capturedWorkflow?.name).toBe('spec-to-deploy');
    expect(capturedWorkflow?.source).toBe('file');
    expect(capturedWorkflow?.description).toBe('project override');
  });

  /**
   * `spec-to-deploy-codex` (`.ai/specs/2026-08-24-codex-only-default-workflow.md`, V4): the
   * derived sibling reaches `POST /api/v1/runs` through the same `resolveRunWorkflow` name lookup
   * as every other catalog entry, with no route change.
   */
  it('a body naming spec-to-deploy-codex resolves to the derived workflow, every step pinned to codex', async () => {
    const res = await post({ task: 't', workflow: 'spec-to-deploy-codex' });
    expect(res.status).toBe(201);
    expect(capturedWorkflow?.name).toBe('spec-to-deploy-codex');
    for (const step of capturedWorkflow?.steps ?? []) {
      expect(step.runner, step.id).toBe('codex');
    }
  });

  it('a body naming a near-miss of spec-to-deploy-codex is still a 404', async () => {
    const res = await post({ task: 't', workflow: 'spec-to-deploy-codexx' });
    expect(res.status).toBe(404);
    expect(capturedWorkflow).toBeUndefined();
  });

  it('a body naming neither key still resolves to spec-to-deploy, unchanged by the new sibling existing', async () => {
    const res = await post({ task: 't' });
    expect(res.status).toBe(201);
    expect(capturedWorkflow?.name).toBe('spec-to-deploy');
  });

  /**
   * Composer review-step toggles (`.ai/specs/2026-08-30-composer-review-step-toggles.md`):
   * `reviewSameModel`/`reviewCrossModel` drop `review-spec-local`/`review-spec` from the resolved
   * workflow. Applied inside `resolveRunWorkflow`, so it reaches the frozen `workflowDef` this
   * route hands `manager.startRun` — the same choke point every other resolution branch above
   * goes through.
   */
  describe('review-step toggles', () => {
    it('an untouched body keeps both review steps — byte-identical to today', async () => {
      const res = await post({ task: 't' });
      expect(res.status).toBe(201);
      const ids = capturedWorkflow?.steps.map((s) => s.id) ?? [];
      expect(ids).toContain('review-spec-local');
      expect(ids).toContain('review-spec');
    });

    it('reviewSameModel: false drops only review-spec-local', async () => {
      const res = await post({ task: 't', reviewSameModel: false });
      expect(res.status).toBe(201);
      const ids = capturedWorkflow?.steps.map((s) => s.id) ?? [];
      expect(ids).not.toContain('review-spec-local');
      expect(ids).toContain('review-spec');
    });

    it('reviewCrossModel: false drops only review-spec', async () => {
      const res = await post({ task: 't', reviewCrossModel: false });
      expect(res.status).toBe(201);
      const ids = capturedWorkflow?.steps.map((s) => s.id) ?? [];
      expect(ids).toContain('review-spec-local');
      expect(ids).not.toContain('review-spec');
    });

    it('both false drops both, and spec is followed directly by implement', async () => {
      const res = await post({ task: 't', reviewSameModel: false, reviewCrossModel: false });
      expect(res.status).toBe(201);
      const ids = capturedWorkflow?.steps.map((s) => s.id) ?? [];
      expect(ids).not.toContain('review-spec-local');
      expect(ids).not.toContain('review-spec');
      expect(ids[ids.indexOf('spec') + 1]).toBe('implement');
    });

    it('applies the same way to the named spec-to-deploy-codex sibling', async () => {
      const res = await post({ task: 't', workflow: 'spec-to-deploy-codex', reviewSameModel: false });
      expect(res.status).toBe(201);
      expect(capturedWorkflow?.steps.map((s) => s.id)).not.toContain('review-spec-local');
      expect(capturedWorkflow?.steps.map((s) => s.id)).toContain('review-spec');
    });

    it('is a no-op on a workflow with neither step id', async () => {
      const res = await post({ task: 't', workflow: 'quick-task', reviewSameModel: false, reviewCrossModel: false });
      expect(res.status).toBe(201);
      expect(capturedWorkflow?.name).toBe('quick-task');
    });
  });
});
