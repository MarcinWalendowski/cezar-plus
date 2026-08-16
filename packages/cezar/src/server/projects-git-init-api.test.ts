import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GitInitResponse, GitPreflightResponse } from '@loki-labs/better-cezar-contract';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { clearProjectProbeCache } from '../workspace/projects.ts';
import { mergeWriteWorkspaceConfig } from '../workspace/config.ts';
import { MAX_FILE_BYTES } from '../workspace/git-init.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp, type ServerDeps } from './server.ts';

/**
 * `GET /api/v1/projects/git-preflight` and `POST /api/v1/projects/git-init` (spec
 * `.ai/specs/2026-08-15-import-all-folders-as-projects.md`, phase 3).
 *
 * Real git in real temp directories, never a stub. Every claim this feature makes is a claim about
 * what git ends up holding — that a `.env` is not in `git ls-files`, that `git worktree add`
 * produces a tree with the user's files IN it — and a fake git would answer those from the same
 * assumptions the code was written under.
 *
 * These are the first two routes in the codebase that WRITE to an operator-named path, so the
 * containment tests below are the load-bearing ones: the symlink case is the mutation-kill for
 * "check lexically only".
 */

describe('git setup routes', () => {
  const savedHome = process.env.CEZ_HOME;
  const savedUserHome = process.env.HOME;
  const savedSingleProject = process.env.CEZ_SINGLE_PROJECT;
  const savedDryRun = process.env.CEZ_DRY_RUN;
  let home: string;
  let repoRoot: string;
  let browseRoot: string;
  let store: RunStore;

  beforeEach(async () => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-gitinit-home-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-gitinit-boot-'));
    browseRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-gitinit-root-'));
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
    if (savedUserHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedUserHome;
    if (savedSingleProject === undefined) delete process.env.CEZ_SINGLE_PROJECT;
    else process.env.CEZ_SINGLE_PROJECT = savedSingleProject;
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  const makeApp = (over: Partial<ServerDeps> = {}) =>
    createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', ...over });

  const preflight = async (path: string): Promise<Response> =>
    apiRequest(makeApp(), `/api/v1/projects/git-preflight?path=${encodeURIComponent(path)}`);

  const setup = async (path: string): Promise<Response> =>
    apiRequest(makeApp(), '/api/v1/projects/git-init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    });

  /** A folder of ordinary work: one file to commit, one secret that must not be. */
  const folder = (name: string): string => {
    const dir = join(browseRoot, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'notes.md'), '# notes\n');
    writeFileSync(join(dir, '.env'), 'API_KEY=super-secret\n');
    return dir;
  };

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8' });

  it('previews what would be committed and what would be excluded, writing nothing', async () => {
    const dir = folder('brand');

    const res = await preflight(dir);

    expect(res.status).toBe(200);
    const body = (await res.json()) as GitPreflightResponse;
    expect(body).toMatchObject({ alreadyRepo: false, hasCommits: false, insideRepo: false, truncated: false });
    expect(body.files).toBe(1);
    expect(body.sensitive).toEqual(['.env']);
    expect(body.oversized).toEqual([]);
    // A READ. The preview must not be the thing that creates the repository.
    expect(existsSync(join(dir, '.git'))).toBe(false);
    expect(existsSync(join(dir, '.gitignore'))).toBe(false);
  });

  /**
   * THE guard on D5's first half. Mutation: skip the `.gitignore` write and this fails — the file
   * lands in `git ls-files`, i.e. in the commit, i.e. in history forever.
   */
  it('commits the folder without its secrets, ignores them, and names every exclusion', async () => {
    const dir = folder('brand');

    const res = await setup(dir);

    expect(res.status).toBe(200);
    const body = (await res.json()) as GitInitResponse;
    expect(body.branch).toBe('main');
    expect(body.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(body.ignored).toEqual(['.env']);

    const tracked = git(dir, 'ls-files').split('\n').filter(Boolean);
    expect(tracked).toContain('notes.md');
    expect(tracked).not.toContain('.env');
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toContain('/.env');
    // The secret is EXCLUDED, not deleted — cezar does not touch the user's files.
    expect(existsSync(join(dir, '.env'))).toBe(true);
    expect(git(dir, 'log', '--oneline').trim().split('\n')).toHaveLength(1);
  });

  /**
   * THE guard on D4, and the reason this endpoint is not `git init`.
   *
   * Mutation: commit nothing (init only). `git worktree add` still SUCCEEDS — git infers
   * `--orphan` — and hands back an empty directory, so the failure is invisible except right here.
   */
  it('leaves a repo whose worktrees contain the user files', async () => {
    const dir = folder('brand');
    await setup(dir);

    const wt = join(browseRoot, 'wt');
    git(dir, 'worktree', 'add', wt);

    expect(existsSync(join(wt, 'notes.md'))).toBe(true);
    expect(readFileSync(join(wt, 'notes.md'), 'utf8')).toBe('# notes\n');
  });

  /**
   * D5's second half. Mutation: auto-ignore the big file instead of refusing, and this fails —
   * which is the point. Dropping a 40 MB asset out of a project silently is a decision cezar does
   * not get to make on the user's behalf.
   */
  it('refuses an oversized file and writes nothing at all', async () => {
    const dir = folder('heavy');
    writeFileSync(join(dir, 'render.mov'), Buffer.alloc(MAX_FILE_BYTES + 1));

    const seen = (await (await preflight(dir)).json()) as GitPreflightResponse;
    expect(seen.oversized).toHaveLength(1);
    expect(seen.oversized[0]).toContain('render.mov');

    const res = await setup(dir);

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('render.mov');
    // Nothing at all: not a repo, not a `.gitignore`, not a half-done state to clean up.
    expect(existsSync(join(dir, '.git'))).toBe(false);
    expect(existsSync(join(dir, '.gitignore'))).toBe(false);
  });

  /** The repair case: a `.git` with no commit is exactly what a naive "Initialize git" button
   *  leaves behind, and it is what makes worktrees hand back an empty tree. */
  it('repairs a commitless repo without re-initializing it', async () => {
    const dir = folder('fresh');
    git(dir, 'init', '-b', 'main');
    const before = (await (await preflight(dir)).json()) as GitPreflightResponse;
    expect(before).toMatchObject({ alreadyRepo: true, hasCommits: false });

    expect((await setup(dir)).status).toBe(200);

    expect(git(dir, 'log', '--oneline').trim().split('\n')).toHaveLength(1);
    expect(git(dir, 'ls-files')).not.toContain('.env');
  });

  it('refuses a repo that already has commits', async () => {
    const dir = folder('done');
    git(dir, 'init', '-b', 'main');
    git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'first');

    const res = await setup(dir);

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('already a git repository');
  });

  /**
   * Two repos over one set of files is the refusal — each one's history would be a lie about the
   * other. Mutation: refuse on `insideRepo` instead and the test below this one fails, which is the
   * pair that keeps the rule where it was MEASURED to belong.
   */
  it('refuses a folder whose files the enclosing repository already tracks', async () => {
    const outer = folder('outer');
    git(outer, 'init', '-b', 'main');
    const inner = join(outer, 'inner');
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(inner, 'a.txt'), 'a\n');
    git(outer, 'add', '-A');
    git(outer, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'first');

    const seen = (await (await preflight(inner)).json()) as GitPreflightResponse;
    expect(seen).toMatchObject({ insideRepo: true, trackedElsewhere: true });
    const res = await setup(inner);

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('already tracks these files');
    expect(existsSync(join(inner, '.git'))).toBe(false);
  });

  /**
   * …and the case that made the rule what it is, measured on the workspace this feature was built
   * for: that folder is itself a git repo holding two doctrine files and ten independent
   * checkouts, and every non-git folder in it is gitignored there. Refusing "a repo inside a repo"
   * would have refused the button on every row it exists for.
   */
  it('sets up a folder the enclosing repository ignores, and says the new repo is independent', async () => {
    const outer = folder('workspace');
    git(outer, 'init', '-b', 'main');
    writeFileSync(join(outer, '.gitignore'), 'inner/\n');
    git(outer, 'add', '.gitignore');
    git(outer, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'doctrine');
    const inner = join(outer, 'inner');
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(inner, 'a.txt'), 'a\n');

    const seen = (await (await preflight(inner)).json()) as GitPreflightResponse;
    expect(seen).toMatchObject({ insideRepo: true, trackedElsewhere: false });

    expect((await setup(inner)).status).toBe(200);

    expect(git(inner, 'log', '--oneline').trim().split('\n')).toHaveLength(1);
    expect(git(inner, 'ls-files').trim()).toBe('a.txt');
    // Independent: the inner repo's commit is not the outer one's.
    expect(git(inner, 'rev-parse', 'HEAD')).not.toBe(git(outer, 'rev-parse', 'HEAD'));
  });

  /**
   * Containment, on BOTH routes — these are the first two that write to a path an operator names.
   *
   * The symlink case is the mutation-kill: a lexical-only check passes it (the spelling is inside
   * the root) and `git init` then runs wherever the link points. Judged after `realpath`, it dies.
   */
  it('refuses a path outside the browse root on both routes, including a symlink escape', async () => {
    const outside = mkdtempSync(join(realpathSync(tmpdir()), 'cez-gitinit-outside-'));
    writeFileSync(join(outside, 'private.txt'), 'not yours\n');
    symlinkSync(outside, join(browseRoot, 'escape'));
    try {
      for (const spelling of [outside, join(browseRoot, 'escape')]) {
        for (const res of [await preflight(spelling), await setup(spelling)]) {
          expect(res.status).toBe(400);
          const body = (await res.json()) as { error: string };
          expect(body.error).toBe('path is outside the browsable root');
          // The refusal must not become the layout oracle the narrowing exists to shut.
          expect(body.error).not.toContain(outside);
        }
      }
      // …and the escape target is untouched by either call.
      expect(existsSync(join(outside, '.git'))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  /** The second gate: `shouldRegisterProject`. `git init` + `git add -A` in a home directory is a
   *  worse outcome than registering one, and that guard already spells "not a project folder". */
  it('refuses the home directory on both routes', async () => {
    process.env.HOME = browseRoot;

    for (const res of [await preflight(browseRoot), await setup(browseRoot)]) {
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('not a project folder');
    }
    expect(existsSync(join(browseRoot, '.git'))).toBe(false);
  });

  it('refuses both routes with 409 under CEZ_SINGLE_PROJECT', async () => {
    const dir = folder('brand');
    process.env.CEZ_SINGLE_PROJECT = '1';

    for (const res of [await preflight(dir), await setup(dir)]) {
      expect(res.status).toBe(409);
    }
  });

  it('answers 404 for a folder inside the root that is not there', async () => {
    for (const res of [await preflight(join(browseRoot, 'nope')), await setup(join(browseRoot, 'nope'))]) {
      expect(res.status).toBe(404);
      expect((await res.json()) as { error: string }).toEqual({ error: 'no such directory' });
    }
  });

  /** An empty folder still ends with a commit. Without `--allow-empty` the commit fails, and what
   *  is left behind is precisely the commitless repo this endpoint exists to prevent. */
  it('commits even when there is nothing to commit', async () => {
    const dir = join(browseRoot, 'empty');
    mkdirSync(dir, { recursive: true });

    const res = await setup(dir);

    expect(res.status).toBe(200);
    expect(((await res.json()) as GitInitResponse).files).toBe(0);
    expect(git(dir, 'log', '--oneline').trim().split('\n')).toHaveLength(1);
  });
});
