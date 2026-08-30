import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectScanResponse } from '@loki-labs/cezar-plus-contract';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { clearProjectProbeCache, registerProject } from '../workspace/projects.ts';
import { mergeWriteWorkspaceConfig } from '../workspace/config.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp, type ServerDeps } from './server.ts';

/**
 * `GET /api/v1/projects/scan` (spec `.ai/specs/2026-08-14-nested-repos-as-projects.md`, phase 3) —
 * the read behind "add a folder, get one project per nested repo".
 *
 * The WALK's own rules (depth, prune, cap, worktrees) are covered by
 * `workspace/nested-repos.test.ts` against real trees. What this file owns is the three things that
 * only exist at the route: the browse-root containment it inherits from `fs/browse`, the
 * `registered` flag it computes from the registry, and the single-project refusal.
 */

describe('GET /api/v1/projects/scan', () => {
  const savedHome = process.env.CEZ_HOME;
  const savedSingleProject = process.env.CEZ_SINGLE_PROJECT;
  const savedDryRun = process.env.CEZ_DRY_RUN;
  let home: string;
  let repoRoot: string;
  /** The browse root every test narrows to — the workspace-shaped folder being scanned. */
  let browseRoot: string;
  let store: RunStore;

  beforeEach(async () => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-scan-home-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-scan-boot-'));
    browseRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-scan-root-'));
    process.env.CEZ_HOME = home;
    delete process.env.CEZ_SINGLE_PROJECT;
    process.env.CEZ_DRY_RUN = '1';
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    clearProjectProbeCache();
    await mergeWriteWorkspaceConfig((config) => {
      config.browseRoot = browseRoot;
    });
  });

  afterEach(() => {
    store.flush();
    for (const dir of [home, repoRoot, browseRoot]) rmSync(dir, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
    if (savedSingleProject === undefined) delete process.env.CEZ_SINGLE_PROJECT;
    else process.env.CEZ_SINGLE_PROJECT = savedSingleProject;
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  const makeApp = (over: Partial<ServerDeps> = {}) =>
    createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', ...over });

  const scan = async (path: string): Promise<Response> =>
    apiRequest(makeApp(), `/api/v1/projects/scan?path=${encodeURIComponent(path)}`);

  const repo = (...segments: string[]): string => {
    const dir = join(...segments);
    mkdirSync(join(dir, '.git'), { recursive: true });
    return dir;
  };

  it('answers each nested repo and each non-git folder, with the scanned folder reported separately', async () => {
    repo(browseRoot, 'chat');
    repo(browseRoot, 'cezar');
    // Offered too, since 2026-08-15 — as a row that says it has no git, not as a hidden one.
    mkdirSync(join(browseRoot, 'brand'), { recursive: true });

    const res = await scan(browseRoot);

    expect(res.status).toBe(200);
    const body = (await res.json()) as ProjectScanResponse;
    expect(body.root).toBe(realpathSync(browseRoot));
    expect(body.rootIsRepo).toBe(false);
    expect(body.truncated).toBe(false);
    expect(body.repos.map((r) => r.relPath).sort()).toEqual(['brand', 'cezar', 'chat']);
    expect(body.repos.every((r) => r.registered === false)).toBe(true);
    // `isRepo` is what the dialog's warning hangs off, so a hardcoded value on either side of it
    // is the mutation this pins: both spellings appear, on the right rows.
    const byRel = new Map(body.repos.map((r) => [r.relPath, r.isRepo]));
    expect(byRel.get('chat')).toBe(true);
    expect(byRel.get('brand')).toBe(false);
    // A `.git` directory with no commit in it is a repo with `hasCommits: false` — the walk's
    // fixtures here are bare `.git` dirs, which is exactly that shape.
    expect(body.repos.find((r) => r.relPath === 'chat')?.hasCommits).toBe(false);
    // …and a folder row answers nothing about commits at all.
    expect(body.repos.find((r) => r.relPath === 'brand')?.hasCommits).toBeUndefined();
  });

  it('reports rootIsRepo for a scanned folder that is itself a repo', async () => {
    mkdirSync(join(browseRoot, '.git'), { recursive: true });
    repo(browseRoot, 'chat');

    const body = (await (await scan(browseRoot)).json()) as ProjectScanResponse;

    expect(body.rootIsRepo).toBe(true);
    // …and the folder is still not one of the rows: the dialog already has it as its own target,
    // and returning it here would make one folder two proposals.
    expect(body.repos.map((r) => r.relPath)).toEqual(['chat']);
  });

  /** The flag that decides whether a row renders as an addable checkbox or as an existing project.
   *  Read off the REGISTRY, matched on the realpath key the registry stores. */
  it('marks a repo that is already a project as registered', async () => {
    const chat = repo(browseRoot, 'chat');
    repo(browseRoot, 'cezar');
    await registerProject(chat);

    const body = (await (await scan(browseRoot)).json()) as ProjectScanResponse;

    const byRel = new Map(body.repos.map((r) => [r.relPath, r.registered]));
    expect(byRel.get('chat')).toBe(true);
    // The negative half, in the same answer: a flag that is true for everything says nothing.
    expect(byRel.get('cezar')).toBe(false);
  });

  /** Containment, inherited from `browseDirectory` via the shared `resolveBrowsableDir` (D5). This
   *  route hands back directory STRUCTURE, so a permissive spelling here would walk straight around
   *  the browse-root narrowing that `fs/browse` exists to enforce. */
  it('refuses a folder outside the browse root, in both spellings, with no path echoed back', async () => {
    const outside = mkdtempSync(join(realpathSync(tmpdir()), 'cez-scan-outside-'));
    repo(outside, 'secret');
    try {
      for (const spelling of [outside, join(browseRoot, '..', '..', 'etc')]) {
        const res = await scan(spelling);
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toBe('path is outside the browsable root');
        // The refusal must not become the layout oracle the narrowing exists to shut.
        expect(body.error).not.toContain(outside);
        expect(body.error).not.toContain(browseRoot);
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('answers 404 for a folder inside the root that is not there', async () => {
    const res = await scan(join(browseRoot, 'nope'));
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toEqual({ error: 'no such directory' });
  });

  it('refuses with 409 under CEZ_SINGLE_PROJECT, like every other project-adding route', async () => {
    repo(browseRoot, 'chat');
    process.env.CEZ_SINGLE_PROJECT = '1';

    const res = await scan(browseRoot);

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('folder browsing');
  });

  /** The route READS. Nothing in the registry may change because someone looked at a folder — that
   *  is what makes the list a proposal rather than the six-row write nobody asked for. */
  it('registers nothing', async () => {
    repo(browseRoot, 'chat');
    repo(browseRoot, 'cezar');

    expect((await scan(browseRoot)).status).toBe(200);

    const listed = await apiRequest(makeApp(), '/api/v1/projects');
    expect(((await listed.json()) as { projects: unknown[] }).projects).toEqual([]);
  });
});
