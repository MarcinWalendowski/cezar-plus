import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceGrantProject } from '@loki-labs/better-cezar-contract';
import { applyWorkspaceWorktrees, materializeWorkspaceWorktrees } from './workspace-worktrees.ts';

/**
 * Per-project worktrees for a parallel workspace run
 * (`.ai/specs/2026-08-19-parallel-workspace-runs-worktrees.md`). These shell out to real git
 * against throwaway repos — the merge-back is the risky half and a mock would not exercise it.
 */

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@e',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@e',
    },
  }).trim();
}

function initRepo(root: string, file = 'a.txt', content = 'line1\nline2\n'): void {
  mkdirSync(root, { recursive: true });
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 't@e']);
  git(root, ['config', 'user.name', 'T']);
  writeFileSync(join(root, file), content);
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'init']);
}

const project = (root: string, id = 'p'): WorkspaceGrantProject => ({
  id,
  name: id,
  root,
  status: 'ok',
});

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cez-wt-test-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('materializeWorkspaceWorktrees', () => {
  it('creates one worktree per granted git project', async () => {
    const a = join(tmp, 'a');
    const b = join(tmp, 'b');
    initRepo(a);
    initRepo(b);
    const worktrees = await materializeWorkspaceWorktrees('12345678wxyz', [project(a, 'a'), project(b, 'b')]);
    expect(worktrees.map((w) => w.root).sort()).toEqual([a, b].sort());
    for (const w of worktrees) {
      expect(existsSync(w.worktreePath)).toBe(true);
      expect(w.branch).toBe('cez/12345678'); // first 8 chars of the run id
    }
  });

  it('skips a non-git granted directory (granted in place, no worktree)', async () => {
    const a = join(tmp, 'a');
    const plain = join(tmp, 'plain');
    initRepo(a);
    mkdirSync(plain, { recursive: true });
    const worktrees = await materializeWorkspaceWorktrees('12345678wxyz', [
      project(a, 'a'),
      project(plain, 'plain'),
    ]);
    expect(worktrees.map((w) => w.root)).toEqual([a]);
  });

  it('skips a missing project', async () => {
    const a = join(tmp, 'a');
    initRepo(a);
    const worktrees = await materializeWorkspaceWorktrees('12345678wxyz', [
      project(a, 'a'),
      { id: 'gone', name: 'gone', root: join(tmp, 'nope'), status: 'missing' },
    ]);
    expect(worktrees.map((w) => w.root)).toEqual([a]);
  });
});

describe('applyWorkspaceWorktrees', () => {
  it('lands the worktree diff in the real checkout, beside a pre-existing dirty file, then removes the worktree', async () => {
    const root = join(tmp, 'repo');
    initRepo(root);
    const [wt] = await materializeWorkspaceWorktrees('12345678wxyz', [project(root)]);
    expect(wt).toBeDefined();

    // The agent's work: change a tracked file and add a new one, in the worktree.
    writeFileSync(join(wt!.worktreePath, 'a.txt'), 'line1\nCHANGED\n');
    writeFileSync(join(wt!.worktreePath, 'new.txt'), 'brand new\n');

    // The user's own in-progress work in the real checkout — a different, untracked file.
    writeFileSync(join(root, 'user-wip.txt'), 'do not clobber\n');

    const [report] = await applyWorkspaceWorktrees([wt!]);
    expect(report!.outcome).toBe('applied');

    // Agent changes landed in the real tree...
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('line1\nCHANGED\n');
    expect(readFileSync(join(root, 'new.txt'), 'utf8')).toBe('brand new\n');
    // ...unstaged (nothing committed), beside the user's untouched WIP.
    expect(readFileSync(join(root, 'user-wip.txt'), 'utf8')).toBe('do not clobber\n');
    expect(git(root, ['rev-list', '--count', 'HEAD'])).toBe('1'); // still just the init commit
    // Worktree removed after the merge (W6).
    expect(existsSync(wt!.worktreePath)).toBe(false);
    expect(git(root, ['branch', '--list', 'cez/12345678'])).toBe('');
  });

  it('keeps the worktree branch on a conflicting apply and reports it', async () => {
    const root = join(tmp, 'repo');
    initRepo(root);
    const [wt] = await materializeWorkspaceWorktrees('12345678wxyz', [project(root)]);

    // The agent rewrites line2 in the worktree...
    writeFileSync(join(wt!.worktreePath, 'a.txt'), 'line1\nAGENT\n');
    // ...while the user rewrites the SAME line differently in the real checkout, uncommitted.
    writeFileSync(join(root, 'a.txt'), 'line1\nUSER\n');

    const [report] = await applyWorkspaceWorktrees([wt!]);
    expect(report!.outcome).toBe('conflict');
    // The branch survives as the recovery point.
    expect(existsSync(wt!.worktreePath)).toBe(true);
    expect(git(root, ['branch', '--list', 'cez/12345678'])).toContain('cez/12345678');
  });

  it('reports nothing and removes the worktree when the agent changed nothing', async () => {
    const root = join(tmp, 'repo');
    initRepo(root);
    const [wt] = await materializeWorkspaceWorktrees('12345678wxyz', [project(root)]);
    const [report] = await applyWorkspaceWorktrees([wt!]);
    expect(report!.outcome).toBe('nothing');
    expect(existsSync(wt!.worktreePath)).toBe(false);
  });
});
