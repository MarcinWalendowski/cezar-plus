import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceGrantProject } from '@loki-labs/better-cezar-contract';
import {
  applyWorkspaceWorktrees,
  discardWorkspaceWorktrees,
  failureDetail,
  materializeWorkspaceWorktrees,
} from './workspace-worktrees.ts';

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
  // realpath: the worktree entry's root is now `git rev-parse --show-toplevel`, which answers
  // with the REAL path. On a platform whose tmpdir is a symlink (macOS `/var` → `/private/var`)
  // comparing against the un-resolved fixture path would fail for a reason unrelated to the rule.
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cez-wt-test-')));
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


/**
 * Sibling registry entries inside ONE git repo
 * (`.ai/specs/2026-08-20-workspace-run-worktree-isolation.md`, X1/X2/X6).
 *
 * The owner's registry has twelve projects in ten repos: `brand` and `chatbox` are
 * subdirectories of the `monorepo` checkout, registered as projects of their own. Every one of
 * them resolved to the same worktree path, and apply-back then fired three times over that one
 * tree concurrently — the winner removed it, and the losers' `git diff` failed in a cwd that no
 * longer existed, with empty stderr. That is the `failed on apply — kept worktree branch cez/…
 * (diff failed: )` line measured in runs `be31d9e9` and `ec6e8e06`, and the leftover
 * `workspaceWorktrees` entry pointing at a deleted directory on three finished runs.
 */
describe('materializeWorkspaceWorktrees — several registry entries in one repo', () => {
  /** A repo with two committed subdirectories, each registered as its own project. */
  function monorepo(): string {
    const repo = join(tmp, 'mono');
    initRepo(repo);
    for (const child of ['brand', 'chatbox']) {
      mkdirSync(join(repo, child), { recursive: true });
      writeFileSync(join(repo, child, 'c.txt'), `${child}\n`);
    }
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'children']);
    return repo;
  }

  /** Registry order deliberately puts a SUBDIRECTORY first: the entry that survives must be the
   *  one rooted at the repo root whatever order the registry happens to be in. */
  const entries = (repo: string) => [
    project(join(repo, 'brand'), 'brand'),
    project(repo, 'monorepo'),
    project(join(repo, 'chatbox'), 'chatbox'),
  ];

  it('collapses them to ONE worktree entry, rooted at the repo root', async () => {
    const repo = monorepo();
    const worktrees = await materializeWorkspaceWorktrees('12345678wxyz', entries(repo));
    // Three granted projects, one tree — and the root is the repo, not `…/brand`, so `git apply`
    // resolves the repo-root-relative patch paths against a cwd that can hold them.
    expect(worktrees).toHaveLength(1);
    expect(worktrees[0]!.root).toBe(repo);
    expect(existsSync(worktrees[0]!.worktreePath)).toBe(true);
  });

  it('names the collapsed siblings in a note rather than dropping them silently', async () => {
    const repo = monorepo();
    const notes: string[] = [];
    const worktrees = await materializeWorkspaceWorktrees('12345678wxyz', entries(repo), (m) =>
      notes.push(m),
    );
    // Twelve projects were granted; a transcript accounting for ten reads as a bug (X2).
    const collapse = notes.find((n) => n.includes('brand'));
    expect(collapse).toBeDefined();
    expect(collapse).toContain('monorepo');
    expect(collapse).toContain('chatbox');
    expect(collapse).toContain(worktrees[0]!.worktreePath);
  });

  it('applies back exactly once — never a phantom `failed (diff failed: )`', async () => {
    const repo = monorepo();
    const worktrees = await materializeWorkspaceWorktrees('12345678wxyz', entries(repo));
    // Work in the shared tree, in a sibling's subdirectory — the case the race used to lose.
    writeFileSync(join(worktrees[0]!.worktreePath, 'brand', 'c.txt'), 'BRAND CHANGED\n');

    const reports = await applyWorkspaceWorktrees(worktrees);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.outcome).toBe('applied');
    // The patch landed at the repo-root-relative path, not somewhere under `brand/brand`.
    expect(readFileSync(join(repo, 'brand', 'c.txt'), 'utf8')).toBe('BRAND CHANGED\n');
    expect(existsSync(worktrees[0]!.worktreePath)).toBe(false);
  });
});

describe('apply/discard failure reporting (X6 — a blank diagnostic is a defect)', () => {
  it('never returns an empty detail, whatever git wrote to its streams', () => {
    // `git diff` in a deleted cwd exits non-zero with NOTHING on either stream. That produced the
    // literal `(diff failed: )` a previous session spent an investigation failing to explain.
    expect(failureDetail({ ok: false, stdout: '', stderr: '' }, 'the worktree disappeared')).toBe(
      'the worktree disappeared',
    );
    expect(failureDetail({ ok: false, stdout: 'out', stderr: '' }, 'fallback')).toBe('out');
    expect(failureDetail({ ok: false, stdout: 'out', stderr: 'err' }, 'fallback')).toBe('err');
  });

  it('reports a non-empty detail when the worktree path is not a git worktree at all', async () => {
    const root = join(tmp, 'repo');
    initRepo(root);
    const bogus = join(tmp, 'not-a-worktree');
    mkdirSync(bogus, { recursive: true });
    const [report] = await applyWorkspaceWorktrees([
      { root, worktreePath: bogus, branch: 'cez/12345678', baseBranch: 'main' },
    ]);
    expect(report!.outcome).toBe('failed');
    expect(report!.detail?.replace('diff failed: ', '').trim()).not.toBe('');
  });
});

/**
 * Non-success endings (X3). Apply-back stays success-only (spec 2026-08-19, W7) — but cleanup was
 * success-only too, purely because `applyWorkspaceRun` was its single call site, so a failed or
 * cancelled workspace run left twelve full checkouts on disk forever.
 */
describe('discardWorkspaceWorktrees', () => {
  it('removes the directory and KEEPS the branch, with the work committed on it', async () => {
    const root = join(tmp, 'repo');
    initRepo(root);
    const [wt] = await materializeWorkspaceWorktrees('12345678wxyz', [project(root)]);
    writeFileSync(join(wt!.worktreePath, 'a.txt'), 'line1\nAGENT\n');
    writeFileSync(join(wt!.worktreePath, 'new.txt'), 'brand new\n');

    const [report] = await discardWorkspaceWorktrees([wt!]);
    expect(report!.outcome).toBe('discarded');
    // The gigabytes go...
    expect(existsSync(wt!.worktreePath)).toBe(false);
    // ...the bytes that make it recoverable stay, holding the autosaved work.
    expect(git(root, ['branch', '--list', 'cez/12345678'])).toContain('cez/12345678');
    expect(git(root, ['show', 'cez/12345678:new.txt'])).toBe('brand new');
    // And nothing was applied into the real checkout — that is what "success only" means.
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('line1\nline2\n');
  });

  it('fails CLOSED: an autosave that refuses keeps the directory rather than deleting the work', async () => {
    const root = join(tmp, 'repo');
    initRepo(root);
    const [wt] = await materializeWorkspaceWorktrees('12345678wxyz', [project(root)]);
    // Leftover conflict markers in a TRACKED file — `autosaveCommit` refuses, so the work is not
    // on the branch yet and the directory is the only copy of it.
    writeFileSync(join(wt!.worktreePath, 'a.txt'), '<<<<<<< ours\nx\n=======\ny\n>>>>>>> theirs\n');
    const [report] = await discardWorkspaceWorktrees([wt!]);
    expect(report!.outcome).toBe('kept');
    expect(report!.detail).toMatch(/autosave refused/);
    expect(existsSync(wt!.worktreePath)).toBe(true);
  });

  it('is a no-op on a worktree that is already gone', async () => {
    const root = join(tmp, 'repo');
    initRepo(root);
    const [report] = await discardWorkspaceWorktrees([
      { root, worktreePath: join(tmp, 'never-existed'), branch: 'cez/12345678', baseBranch: 'main' },
    ]);
    expect(report!.outcome).toBe('discarded');
  });
});
