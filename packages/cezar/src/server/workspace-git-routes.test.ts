import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceGitResponse } from '@open-mercato/cezar-contract';
import { createWorkspaceGitRoutes, type WorkspaceGitRouteDeps } from './workspace-git-routes.ts';
import { WorkspaceGitIndex } from '../workspace/git-index.ts';
import type { ProjectApiEnv } from './server.ts';
import type { ProjectContext } from './project-context.ts';
import { clearProjectProbeCache, listProjects, registerProject } from '../workspace/projects.ts';
import { ProjectContexts } from './project-context.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp, type ServerDeps } from './server.ts';
import type { RunManager } from '../workflows/run.ts';
import { RunStore } from '../runs/store.ts';

/**
 * `GET /api/v1/workspace/git` — `.ai/specs/2026-08-14-cross-project-git-overview.md`, D1.
 *
 * Two layers, mirroring the runs family's own test split (`workspace-runs-api.test.ts` vs the
 * route-level coverage baked into that same file): the gating/wiring behaviour is exercised
 * directly against the Hono sub-app `createWorkspaceGitRoutes()` returns (fast, hermetic, no
 * `~/.cezar`), and one live-server case proves the mounted route builds no project context.
 */

// ---- route-level: direct sub-app, injected deps -------------------------------------------

/** A `gitIndex` that answers ONE real project row. Used in every flag-OFF test so the empty
 *  `projects: []` the test asserts can only be explained by the gate short-circuiting — never by
 *  coincidence (e.g. the default `gitIndex` reading a genuinely-empty ambient registry, which
 *  would make the assertion pass whether or not the gate actually ran). */
function nonEmptyGitIndex(): WorkspaceGitIndex {
  return new WorkspaceGitIndex({
    listProjects: async () => [{ id: 'shop', root: '/fake/shop', status: 'ok', name: 'Shop' }],
    getRepoSummary: async () => ({ branch: 'main', dirty: { staged: 0, unstaged: 0, untracked: 0 } }),
  });
}

function app(deps: WorkspaceGitRouteDeps = {}, bootRoot = '/fake/boot') {
  const routes = createWorkspaceGitRoutes(deps);
  return new Hono<ProjectApiEnv>()
    .use('*', async (c, next) => {
      c.set('project', { root: bootRoot } as ProjectContext);
      await next();
    })
    .route('/', routes);
}

describe('GET /api/v1/workspace/git — route level', () => {
  const savedFlag = process.env.CEZ_WORKSPACE_VIEWS;
  const savedSingle = process.env.CEZ_SINGLE_PROJECT;

  afterEach(() => {
    if (savedFlag === undefined) delete process.env.CEZ_WORKSPACE_VIEWS;
    else process.env.CEZ_WORKSPACE_VIEWS = savedFlag;
    if (savedSingle === undefined) delete process.env.CEZ_SINGLE_PROJECT;
    else process.env.CEZ_SINGLE_PROJECT = savedSingle;
  });

  it('flag off ⇒ 200 with a schema-valid empty payload, never 404, never the injected index’s real data', async () => {
    delete process.env.CEZ_WORKSPACE_VIEWS;
    const a = app({ gitIndex: nonEmptyGitIndex(), resolveBootProject: async () => 'boot-proj' });
    const res = await a.request('/workspace/git');
    expect(res.status).toBe(200);
    const body = (await res.json()) as WorkspaceGitResponse;
    expect(body).toEqual({ projects: [], bootProject: 'boot-proj' });
  });

  it('flag on ⇒ the real aggregate, read through the injected gitIndex', async () => {
    process.env.CEZ_WORKSPACE_VIEWS = '1';
    delete process.env.CEZ_SINGLE_PROJECT;
    const gitIndex = new WorkspaceGitIndex({
      listProjects: async () => [{ id: 'shop', root: '/fake/shop', status: 'ok', name: 'Shop' }],
      getRepoSummary: async () => ({
        branch: 'main',
        dirty: { staged: 0, unstaged: 0, untracked: 0 },
      }),
    });
    const a = app({ gitIndex, resolveBootProject: async () => 'boot-proj' });
    const res = await a.request('/workspace/git');
    expect(res.status).toBe(200);
    const body = (await res.json()) as WorkspaceGitResponse;
    expect(body.bootProject).toBe('boot-proj');
    expect(body.projects).toEqual([
      { id: 'shop', name: 'Shop', ok: true, branch: 'main', dirty: { staged: 0, unstaged: 0, untracked: 0 } },
    ]);
  });

  it('a failed project rides through as an ok:false row, not dropped or a 5xx', async () => {
    process.env.CEZ_WORKSPACE_VIEWS = '1';
    const gitIndex = new WorkspaceGitIndex({
      listProjects: async () => [{ id: 'gone', root: '/fake/gone', status: 'missing', name: 'Gone' }],
    });
    const a = app({ gitIndex, resolveBootProject: async () => 'boot-proj' });
    const res = await a.request('/workspace/git');
    expect(res.status).toBe(200);
    const body = (await res.json()) as WorkspaceGitResponse;
    expect(body.projects).toEqual([{ id: 'gone', name: 'Gone', ok: false, reason: 'root not found' }]);
  });

  it('CEZ_SINGLE_PROJECT=1 takes the identical flag-off shape, even with CEZ_WORKSPACE_VIEWS=1', async () => {
    process.env.CEZ_WORKSPACE_VIEWS = '1';
    process.env.CEZ_SINGLE_PROJECT = '1';
    const a = app({ gitIndex: nonEmptyGitIndex(), resolveBootProject: async () => 'boot-proj' });
    const res = await a.request('/workspace/git');
    expect(res.status).toBe(200);
    const body = (await res.json()) as WorkspaceGitResponse;
    expect(body).toEqual({ projects: [], bootProject: 'boot-proj' });
  });

  it("'true' is not '1' — stays off", async () => {
    process.env.CEZ_WORKSPACE_VIEWS = 'true';
    const a = app({ gitIndex: nonEmptyGitIndex(), resolveBootProject: async () => 'boot-proj' });
    const res = await a.request('/workspace/git');
    expect(res.status).toBe(200);
    const body = (await res.json()) as WorkspaceGitResponse;
    expect(body.projects).toEqual([]);
  });

  it('bootProject is resolved even when the flag is off', async () => {
    delete process.env.CEZ_WORKSPACE_VIEWS;
    let resolvedFor: string | undefined;
    const a = app({
      resolveBootProject: async (root) => {
        resolvedFor = root;
        return 'boot-proj';
      },
    });
    await a.request('/workspace/git');
    expect(resolvedFor).toBe('/fake/boot');
  });
});

// ---- live-server: the mounted route builds no project context -----------------------------

function g(dir: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

describe('GET /api/v1/workspace/git — mounted in the real app', () => {
  const savedHome = process.env.CEZ_HOME;
  const savedWorkspaceViews = process.env.CEZ_WORKSPACE_VIEWS;
  let home: string;
  let repoRoot: string;
  let store: RunStore;

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-wsgit-home-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-wsgit-boot-'));
    process.env.CEZ_HOME = home;
    process.env.CEZ_WORKSPACE_VIEWS = '1';
    delete process.env.CEZ_SINGLE_PROJECT;
    clearProjectProbeCache();
    g(repoRoot, 'init', '-q', '-b', 'main');
    writeFileSync(join(repoRoot, 'a.txt'), 'a\n');
    g(repoRoot, 'add', 'a.txt');
    g(repoRoot, '-c', 'user.email=t@test', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
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
  });

  const makeApp = (over: Partial<ServerDeps> = {}) =>
    createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', ...over });

  it('reads every registered project’s git state without building any project context', async () => {
    const other = mkdtempSync(join(realpathSync(tmpdir()), 'cez-wsgit-other-'));
    try {
      mkdirSync(other, { recursive: true });
      g(other, 'init', '-q', '-b', 'main');
      writeFileSync(join(other, 'b.txt'), 'b\n');
      g(other, 'add', 'b.txt');
      g(other, '-c', 'user.email=t@test', '-c', 'user.name=t', 'commit', '-q', '-m', 'other init');

      const boot = await registerProject(repoRoot);
      const otherProject = await registerProject(other);
      const contexts = new ProjectContexts({ listProjects });
      const app2 = makeApp({ bootProjectId: boot.id, contexts });
      expect(contexts.ids()).toEqual([]);

      const res = await apiRequest(app2, '/api/v1/workspace/git');
      expect(res.status).toBe(200);
      const body = (await res.json()) as WorkspaceGitResponse;
      const ids = body.projects.map((p) => p.id).sort();
      expect(ids).toEqual([boot.id, otherProject.id].sort());
      for (const project of body.projects) {
        expect(project.ok).toBe(true);
        expect(project.branch).toBe('main');
      }
      // The whole point: reading the aggregate must not have opened either project's context.
      expect(contexts.ids()).toEqual([]);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
