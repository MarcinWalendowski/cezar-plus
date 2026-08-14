import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { WorkspaceGitIndex, type WorkspaceGitProjectSource } from './git-index.ts';
import type { RepoSummary } from '../server/git.ts';

/**
 * `WorkspaceGitIndex` unit surface (`.ai/specs/2026-08-14-cross-project-git-overview.md`,
 * "Verification"). Everything here is hermetic: `listProjects` and `getRepoSummary` are both
 * injected fakes, so nothing touches `~/.cezar` or spawns a real `git` process — that coverage
 * lives in `../server/git.test.ts` for `getRepoSummary` itself.
 */

function source(overrides: Partial<WorkspaceGitProjectSource> = {}): WorkspaceGitProjectSource {
  return { id: 'proj', root: '/fake/proj', status: 'ok', name: 'proj', ...overrides };
}

function fakeSummary(overrides: Partial<RepoSummary> = {}): RepoSummary {
  return {
    branch: 'main',
    dirty: { staged: 0, unstaged: 0, untracked: 0 },
    head: { hash: 'abc1234', subject: 'init', author: 't', when: '2 days ago' },
    ...overrides,
  };
}

describe('git-index.ts — the structural import guard, with a floor', () => {
  it('imports server/git.ts, and never project-context.ts or workflows/run.ts', async () => {
    const src = await readFile(new URL('./git-index.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/from\s+['"][^'"]*project-context(\.ts)?['"]/);
    expect(src).not.toMatch(/from\s+['"][^'"]*workflows\/run(\.ts)?['"]/);
    // The floor: without this, the two negatives above would also pass on an empty file.
    expect(src).toMatch(/from\s+['"][^'"]*server\/git(\.ts)?['"]/);
  });
});

describe('WorkspaceGitIndex', () => {
  it('spreads a successful summary onto the row, ok:true, id/name from the source', async () => {
    const index = new WorkspaceGitIndex({
      listProjects: async () => [source({ id: 'shop', name: 'Shop' })],
      getRepoSummary: async () => fakeSummary({ branch: 'feature/x', ahead: 2 }),
    });
    const { projects } = await index.list();
    expect(projects).toEqual([
      {
        id: 'shop',
        name: 'Shop',
        ok: true,
        branch: 'feature/x',
        ahead: 2,
        dirty: { staged: 0, unstaged: 0, untracked: 0 },
        head: { hash: 'abc1234', subject: 'init', author: 't', when: '2 days ago' },
      },
    ]);
  });

  it('a project whose root is missing yields an ok:false row, without dropping the others, and never calls getRepoSummary for it', async () => {
    const calledFor: string[] = [];
    const index = new WorkspaceGitIndex({
      listProjects: async () => [source({ id: 'gone', status: 'missing' }), source({ id: 'ok-one' })],
      getRepoSummary: async (root) => {
        calledFor.push(root);
        return fakeSummary();
      },
    });
    const { projects } = await index.list();
    expect(projects.map((p) => p.id)).toEqual(['gone', 'ok-one']);
    expect(projects[0]).toMatchObject({ ok: false, reason: 'root not found' });
    expect(projects[1]).toMatchObject({ ok: true });
    expect(calledFor).toEqual(['/fake/proj']); // only the ok-one's root
  });

  it('a non-git root yields an ok:false row with reason "not a git repo", without calling getRepoSummary', async () => {
    let called = false;
    const index = new WorkspaceGitIndex({
      listProjects: async () => [source({ id: 'nogit', name: 'nogit', status: 'not-git' })],
      getRepoSummary: async () => {
        called = true;
        return fakeSummary();
      },
    });
    const { projects } = await index.list();
    expect(projects).toEqual([{ id: 'nogit', name: 'nogit', ok: false, reason: 'not a git repo' }]);
    expect(called).toBe(false);
  });

  it('a git failure (e.g. execFile stderr) yields an ok:false row carrying that reason', async () => {
    const index = new WorkspaceGitIndex({
      listProjects: async () => [source({ id: 'broken' })],
      getRepoSummary: async () => {
        const err = new Error('Command failed') as Error & { stderr?: string };
        err.stderr = 'fatal: not a git repository (or any of the parent directories): .git\n';
        throw err;
      },
    });
    const { projects } = await index.list();
    expect(projects[0]).toMatchObject({
      ok: false,
      reason: 'fatal: not a git repository (or any of the parent directories): .git',
    });
  });

  it('a project that exceeds the deadline yields ok:false, reason: "timed out" — a hung fake must hang the test, not the mutation', async () => {
    const index = new WorkspaceGitIndex({
      listProjects: async () => [source({ id: 'stuck', name: 'stuck' })],
      // Never resolves. If the deadline were removed, this test would hang forever instead of
      // failing — that IS the guard: `deadlineMs` below is what ends the row.
      getRepoSummary: () => new Promise(() => {}),
      deadlineMs: 20,
    });
    const { projects } = await index.list();
    expect(projects).toEqual([{ id: 'stuck', name: 'stuck', ok: false, reason: 'timed out' }]);
  });

  it('one project timing out does not block or fail a sibling that answers in time', async () => {
    const index = new WorkspaceGitIndex({
      listProjects: async () => [source({ id: 'stuck', root: '/fake/stuck' }), source({ id: 'fine', root: '/fake/fine' })],
      getRepoSummary: async (root) => (root === '/fake/stuck' ? new Promise(() => {}) : fakeSummary()),
      deadlineMs: 20,
      concurrency: 4,
    });
    const { projects } = await index.list();
    const byId = new Map(projects.map((p) => [p.id, p] as const));
    expect(byId.get('stuck')).toMatchObject({ ok: false, reason: 'timed out' });
    expect(byId.get('fine')).toMatchObject({ ok: true });
  });

  it('an unreadable registry degrades to projects: [] rather than throwing', async () => {
    const index = new WorkspaceGitIndex({
      listProjects: async () => {
        throw new Error('registry read failed');
      },
    });
    await expect(index.list()).resolves.toEqual({ projects: [] });
  });

  it('preserves registry order even when completion order is inverted', async () => {
    const index = new WorkspaceGitIndex({
      listProjects: async () => [source({ id: 'slow', root: '/fake/slow' }), source({ id: 'fast', root: '/fake/fast' })],
      // Listed first, finishes LAST — order in the result must still be registry order.
      getRepoSummary: async (root) => {
        await new Promise((resolve) => setTimeout(resolve, root === '/fake/slow' ? 30 : 5));
        return fakeSummary();
      },
      concurrency: 4,
    });
    const { projects } = await index.list();
    expect(projects.map((p) => p.id)).toEqual(['slow', 'fast']);
  });

  describe('concurrency cap (D3)', () => {
    it('caps at N summaries in flight at once — a real high-water mark, not a call count', async () => {
      const CAP = 4;
      const TOTAL = 10;
      let active = 0;
      let highWater = 0;
      const index = new WorkspaceGitIndex({
        listProjects: async () => Array.from({ length: TOTAL }, (_, i) => source({ id: `p${i}` })),
        concurrency: CAP,
        getRepoSummary: async () => {
          active++;
          highWater = Math.max(highWater, active);
          await new Promise((resolve) => setTimeout(resolve, 15));
          active--;
          return fakeSummary();
        },
      });
      const { projects } = await index.list();
      expect(projects).toHaveLength(TOTAL);
      // A call-count assertion (e.g. `calls === TOTAL`) would pass identically with the cap
      // deleted — only the HIGH-WATER MARK can tell 4-at-a-time from all-10-at-once.
      expect(highWater).toBe(CAP);
    });

    it('a cap larger than the project count runs everything at once (never over-throttled)', async () => {
      let active = 0;
      let highWater = 0;
      const index = new WorkspaceGitIndex({
        listProjects: async () => [source({ id: 'a' }), source({ id: 'b' })],
        concurrency: 4,
        getRepoSummary: async () => {
          active++;
          highWater = Math.max(highWater, active);
          await new Promise((resolve) => setTimeout(resolve, 10));
          active--;
          return fakeSummary();
        },
      });
      await index.list();
      expect(highWater).toBe(2);
    });
  });
});
