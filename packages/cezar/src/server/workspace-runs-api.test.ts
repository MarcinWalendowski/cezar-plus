import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { clearProjectProbeCache, listProjects, registerProject } from '../workspace/projects.ts';
import { ProjectContexts } from './project-context.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp, type ServerDeps } from './server.ts';
import type { WorkspaceRunsResponse } from '@open-mercato/cezar-contract';

/**
 * `GET /api/v1/workspace/runs` (W4.10). See
 * `.ai/specs/2026-08-06-workspace-notes-cross-project.md` ("Verification" -> "Negative controls,
 * feature A"). Owns the half of C1 that needs a live server (`contexts.ids()`), plus C4, C5, C6,
 * C8, C9. C2, C3, C7 and the rest of C1 live in `workspace/run-index.test.ts` (W1.11).
 */

function runJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'run-1',
    title: 'do the thing',
    workflow: 'quick-task',
    task: 'do the thing',
    status: 'done',
    createdAt: '2026-08-01T00:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...overrides,
  };
}

function writeRuns(root: string, runs: unknown[]): void {
  const dir = join(root, '.ai/cezar');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'runs.json'), JSON.stringify(runs));
}

describe('GET /api/v1/workspace/runs (W4.10)', () => {
  const savedHome = process.env.CEZ_HOME;
  const savedWorkspaceViews = process.env.CEZ_WORKSPACE_VIEWS;
  const savedSingleProject = process.env.CEZ_SINGLE_PROJECT;
  let home: string;
  let repoRoot: string;
  let store: RunStore;

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-wsruns-home-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-wsruns-boot-'));
    process.env.CEZ_HOME = home;
    process.env.CEZ_WORKSPACE_VIEWS = '1';
    delete process.env.CEZ_SINGLE_PROJECT;
    clearProjectProbeCache();
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
  });

  afterEach(() => {
    store.flush();
    rmSync(home, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
    if (savedWorkspaceViews === undefined) delete process.env.CEZ_WORKSPACE_VIEWS;
    else process.env.CEZ_WORKSPACE_VIEWS = savedWorkspaceViews;
    if (savedSingleProject === undefined) delete process.env.CEZ_SINGLE_PROJECT;
    else process.env.CEZ_SINGLE_PROJECT = savedSingleProject;
  });

  const makeApp = (over: Partial<ServerDeps> = {}) =>
    createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', ...over });

  it('C1 (the live-server half): a request to the aggregate builds no project context', async () => {
    const other = mkdtempSync(join(realpathSync(tmpdir()), 'cez-wsruns-other-'));
    try {
      const boot = await registerProject(repoRoot);
      await registerProject(other);
      writeRuns(repoRoot, [runJson({ id: 'boot-run' })]);
      writeRuns(other, [runJson({ id: 'other-run' })]);
      const contexts = new ProjectContexts({ listProjects });
      const app = makeApp({ bootProjectId: boot.id, contexts });
      expect(contexts.ids()).toEqual([]);
      const res = await apiRequest(app, '/api/v1/workspace/runs');
      expect(res.status).toBe(200);
      const body = (await res.json()) as WorkspaceRunsResponse;
      expect(body.runs.map((r) => r.id).sort()).toEqual(['boot-run', 'other-run']);
      // The whole point: reading the aggregate must not have opened either project's context.
      expect(contexts.ids()).toEqual([]);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('C4: absent `projects` filter returns every registered project (never none)', async () => {
    const other = mkdtempSync(join(realpathSync(tmpdir()), 'cez-wsruns-other2-'));
    try {
      const boot = await registerProject(repoRoot);
      const otherProject = await registerProject(other);
      writeRuns(repoRoot, [runJson({ id: 'boot-run' })]);
      writeRuns(other, [runJson({ id: 'other-run' })]);
      const app = makeApp({ bootProjectId: boot.id });
      const res = await apiRequest(app, '/api/v1/workspace/runs');
      expect(res.status).toBe(200);
      const body = (await res.json()) as WorkspaceRunsResponse;
      expect(body.runs.map((r) => r.id).sort()).toEqual(['boot-run', 'other-run']);
      expect(body.projects.map((p) => p.id).sort()).toEqual([boot.id, otherProject.id].sort());
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('C5: the boot project appears once, under its own registered slug — never `default`', async () => {
    const boot = await registerProject(repoRoot);
    writeRuns(repoRoot, [runJson({ id: 'boot-run' })]);
    const app = makeApp({ bootProjectId: boot.id });
    const res = await apiRequest(app, '/api/v1/workspace/runs');
    const body = (await res.json()) as WorkspaceRunsResponse;
    expect(body.bootProject).toBe(boot.id);
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]?.project).toBe(boot.id);
    expect(body.runs.some((r) => r.project === 'default')).toBe(false);
  });

  it('C6: one unreadable project degrades to `ok: false` without blanking the others', async () => {
    const healthy = mkdtempSync(join(realpathSync(tmpdir()), 'cez-wsruns-healthy-'));
    const corrupt = mkdtempSync(join(realpathSync(tmpdir()), 'cez-wsruns-corrupt-'));
    try {
      const boot = await registerProject(repoRoot);
      const healthyProject = await registerProject(healthy);
      await registerProject(corrupt);
      writeRuns(repoRoot, [runJson({ id: 'boot-run' })]);
      writeRuns(healthy, [runJson({ id: 'healthy-run' })]);
      mkdirSync(join(corrupt, '.ai/cezar'), { recursive: true });
      writeFileSync(join(corrupt, '.ai/cezar/runs.json'), 'not json at all {{{');
      const app = makeApp({ bootProjectId: boot.id });
      const res = await apiRequest(app, '/api/v1/workspace/runs');
      expect(res.status).toBe(200);
      const body = (await res.json()) as WorkspaceRunsResponse;
      expect(body.runs.map((r) => r.id).sort()).toEqual(['boot-run', 'healthy-run']);
      const byId = new Map(body.projects.map((p) => [p.id, p] as const));
      expect(byId.get(healthyProject.id)).toMatchObject({ ok: true });
      const corruptEntry = body.projects.find((p) => p.id !== boot.id && p.id !== healthyProject.id);
      expect(corruptEntry?.ok).toBe(false);
      expect(corruptEntry?.reason).toBeTruthy();
    } finally {
      rmSync(healthy, { recursive: true, force: true });
      rmSync(corrupt, { recursive: true, force: true });
    }
  });

  it('C8: the payload is a WorkspaceRunSummary, not a RunRecord — no task/steps/queuedMessages/workflowDef', async () => {
    const boot = await registerProject(repoRoot);
    writeRuns(repoRoot, [runJson({ id: 'boot-run', task: 'a task body nobody should see here' })]);
    const app = makeApp({ bootProjectId: boot.id });
    const res = await apiRequest(app, '/api/v1/workspace/runs');
    const text = await res.text();
    expect(text.length).toBeLessThan(512 * 1024);
    const body = JSON.parse(text) as Record<string, unknown>;
    const run = (body.runs as Record<string, unknown>[])[0]!;
    for (const forbidden of ['task', 'steps', 'queuedMessages', 'workflowDef']) {
      expect(Object.prototype.hasOwnProperty.call(run, forbidden)).toBe(false);
    }
  });

  describe('C9: gating in both directions, in the D19 shape', () => {
    it('unset ⇒ 200 with a schema-valid EMPTY payload, never 409 and never 404', async () => {
      delete process.env.CEZ_WORKSPACE_VIEWS;
      const boot = await registerProject(repoRoot);
      writeRuns(repoRoot, [runJson({ id: 'boot-run' })]);
      const app = makeApp({ bootProjectId: boot.id });
      const res = await apiRequest(app, '/api/v1/workspace/runs');
      expect(res.status).toBe(200);
      const body = (await res.json()) as WorkspaceRunsResponse;
      expect(body).toEqual({ runs: [], projects: [], truncated: false, bootProject: boot.id });
    });

    it("'1' ⇒ the real aggregate", async () => {
      process.env.CEZ_WORKSPACE_VIEWS = '1';
      const boot = await registerProject(repoRoot);
      writeRuns(repoRoot, [runJson({ id: 'boot-run' })]);
      const app = makeApp({ bootProjectId: boot.id });
      const res = await apiRequest(app, '/api/v1/workspace/runs');
      const body = (await res.json()) as WorkspaceRunsResponse;
      expect(body.runs).toHaveLength(1);
    });

    it("'true' is not '1' — stays off", async () => {
      process.env.CEZ_WORKSPACE_VIEWS = 'true';
      const boot = await registerProject(repoRoot);
      writeRuns(repoRoot, [runJson({ id: 'boot-run' })]);
      const app = makeApp({ bootProjectId: boot.id });
      const res = await apiRequest(app, '/api/v1/workspace/runs');
      expect(res.status).toBe(200);
      const body = (await res.json()) as WorkspaceRunsResponse;
      expect(body.runs).toEqual([]);
    });

    it('CEZ_SINGLE_PROJECT=1 takes the identical flag-off shape, even with CEZ_WORKSPACE_VIEWS=1', async () => {
      process.env.CEZ_WORKSPACE_VIEWS = '1';
      process.env.CEZ_SINGLE_PROJECT = '1';
      const boot = await registerProject(repoRoot);
      writeRuns(repoRoot, [runJson({ id: 'boot-run' })]);
      const app = makeApp({ bootProjectId: boot.id });
      const res = await apiRequest(app, '/api/v1/workspace/runs');
      expect(res.status).toBe(200);
      const body = (await res.json()) as WorkspaceRunsResponse;
      expect(body.runs).toEqual([]);
      expect(body.projects).toEqual([]);
    });
  });

  it('an unknown id in `projects` is dropped, never a 5xx and never a fallback to the boot project', async () => {
    const boot = await registerProject(repoRoot);
    writeRuns(repoRoot, [runJson({ id: 'boot-run' })]);
    const app = makeApp({ bootProjectId: boot.id });
    const res = await apiRequest(app, '/api/v1/workspace/runs?projects=ghost-project');
    expect(res.status).toBe(200);
    const body = (await res.json()) as WorkspaceRunsResponse;
    expect(body.runs).toEqual([]);
    expect(body.projects).toEqual([]);
  });

  it('more than 64 ids in `projects` is a 400, malformed-query-only, regardless of the flag', async () => {
    const boot = await registerProject(repoRoot);
    const app = makeApp({ bootProjectId: boot.id });
    const ids = Array.from({ length: 65 }, (_, i) => `p${i}`).join(',');
    const res = await apiRequest(app, `/api/v1/workspace/runs?projects=${ids}`);
    expect(res.status).toBe(400);
  });
});
