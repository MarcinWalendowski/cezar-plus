import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getHeadCommit, getRepoInfo, getRepoSummary } from './git.ts';

/**
 * getRepoInfo remote discovery: the forge seam (and so the GitHub tab) hangs
 * off `repo.remote`, so it must be found for HTTPS and SSH URLs alike, and for
 * repos whose only remote is NOT named `origin` (a plain `git remote get-url
 * origin` fails there). Genuinely remote-less repos still report no remote.
 */

function g(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

describe('getRepoInfo — remote discovery', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-git-'));
    g(dir, 'init', '-q', '-b', 'main');
    g(dir, '-c', 'user.email=t@test', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'init');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads an HTTPS origin remote', async () => {
    g(dir, 'remote', 'add', 'origin', 'https://github.com/acme/demo.git');
    const info = await getRepoInfo(dir);
    expect(info?.remote).toBe('https://github.com/acme/demo.git');
  });

  it('reads an SSH (scp-like) origin remote', async () => {
    g(dir, 'remote', 'add', 'origin', 'git@github.com:acme/demo.git');
    const info = await getRepoInfo(dir);
    expect(info?.remote).toBe('git@github.com:acme/demo.git');
  });

  it('falls back to the first configured remote when none is named origin', async () => {
    g(dir, 'remote', 'add', 'github', 'git@github.com:acme/demo.git');
    const info = await getRepoInfo(dir);
    expect(info?.remote).toBe('git@github.com:acme/demo.git');
  });

  it('prefers origin when several remotes exist', async () => {
    g(dir, 'remote', 'add', 'upstream', 'https://github.com/upstream/demo.git');
    g(dir, 'remote', 'add', 'origin', 'https://github.com/acme/demo.git');
    const info = await getRepoInfo(dir);
    expect(info?.remote).toBe('https://github.com/acme/demo.git');
  });

  it('reports no remote for a genuinely remote-less repo', async () => {
    const info = await getRepoInfo(dir);
    expect(info).not.toBeNull();
    expect(info?.remote).toBeUndefined();
  });

  it('pins the current commit as a full SHA', async () => {
    expect(await getHeadCommit(dir)).toBe(g(dir, 'rev-parse', 'HEAD').trim());
  });

  it('returns null outside a git repository', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'cez-nogit-'));
    try {
      expect(await getRepoInfo(bare)).toBeNull();
      expect(await getHeadCommit(bare)).toBeNull();
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

/**
 * `getRepoSummary` — the workspace git overview's two-spawn row
 * (`.ai/specs/2026-08-14-cross-project-git-overview.md`, D2). Verification table: "reports
 * staged / unstaged / untracked separately against a fixture repo with one of each" and "no
 * upstream → ahead/behind absent, not 0".
 */
describe('getRepoSummary', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-git-summary-'));
    g(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'tracked.txt'), 'a\n');
    g(dir, 'add', 'tracked.txt');
    g(dir, '-c', 'user.email=t@test', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports the branch and no ahead/behind when there is no upstream', async () => {
    const summary = await getRepoSummary(dir);
    expect(summary.branch).toBe('main');
    expect(summary.detached).toBeUndefined();
    expect(summary.upstream).toBeUndefined();
    expect(summary.ahead).toBeUndefined();
    expect(summary.behind).toBeUndefined();
  });

  it('reports staged, unstaged and untracked separately, one of each', async () => {
    writeFileSync(join(dir, 'staged.txt'), 'new\n');
    g(dir, 'add', 'staged.txt');
    appendFileSync(join(dir, 'tracked.txt'), 'b\n');
    writeFileSync(join(dir, 'untracked.txt'), 'new\n');

    const summary = await getRepoSummary(dir);
    expect(summary.dirty).toEqual({ staged: 1, unstaged: 1, untracked: 1 });
  });

  it('a clean tree reports all-zero dirty counts', async () => {
    const summary = await getRepoSummary(dir);
    expect(summary.dirty).toEqual({ staged: 0, unstaged: 0, untracked: 0 });
  });

  it('a file staged and then further modified counts in both staged and unstaged', async () => {
    writeFileSync(join(dir, 'tracked.txt'), 'staged-change\n');
    g(dir, 'add', 'tracked.txt');
    appendFileSync(join(dir, 'tracked.txt'), 'unstaged-change\n');

    const summary = await getRepoSummary(dir);
    expect(summary.dirty).toEqual({ staged: 1, unstaged: 1, untracked: 0 });
  });

  it('reports the last commit', async () => {
    const summary = await getRepoSummary(dir);
    expect(summary.head?.hash).toBe(g(dir, 'rev-parse', '--short', 'HEAD').trim());
    expect(summary.head?.subject).toBe('init');
    expect(summary.head?.author).toBe('t');
  });

  it('reports a detached HEAD, with no branch', async () => {
    const sha = g(dir, 'rev-parse', 'HEAD').trim();
    g(dir, 'checkout', '-q', '--detach', sha);
    const summary = await getRepoSummary(dir);
    expect(summary.detached).toBe(true);
    expect(summary.branch).toBeUndefined();
  });

  /** Corrected 2026-08-14: this asserted `branch` was ABSENT here, following the spec's first
   *  wording. An unborn branch reports its name — `git` prints `## No commits yet on main`, the
   *  pointer genuinely exists, and `head` being absent is what says "nothing committed yet".
   *  Absence of `branch` now means exactly one thing: a detached HEAD (asserted separately). */
  it('reports the branch name but no head on an unborn branch, without throwing', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'cez-git-unborn-'));
    try {
      g(empty, 'init', '-q', '-b', 'main');
      const summary = await getRepoSummary(empty);
      expect(summary.branch).toBe('main');
      expect(summary.detached).toBeUndefined();
      expect(summary.head).toBeUndefined();
      expect(summary.dirty).toEqual({ staged: 0, unstaged: 0, untracked: 0 });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('rejects for a non-git root', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'cez-git-summary-nogit-'));
    try {
      await expect(getRepoSummary(bare)).rejects.toThrow();
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  describe('against an upstream', () => {
    let remote: string;
    let clone: string;

    beforeEach(() => {
      remote = mkdtempSync(join(tmpdir(), 'cez-git-summary-remote-'));
      g(remote, 'init', '-q', '--bare');
      g(dir, 'remote', 'add', 'origin', remote);
      g(dir, 'push', '-q', '-u', 'origin', 'main');
      clone = '';
    });

    afterEach(() => {
      rmSync(remote, { recursive: true, force: true });
      if (clone) rmSync(clone, { recursive: true, force: true });
    });

    it('level with upstream reports explicit 0/0, not absent', async () => {
      const summary = await getRepoSummary(dir);
      expect(summary.upstream).toBe('origin/main');
      expect(summary.ahead).toBe(0);
      expect(summary.behind).toBe(0);
    });

    it('ahead of upstream', async () => {
      g(dir, '-c', 'user.email=t@test', '-c', 'user.name=t', 'commit', '-q', '-m', 'more', '--allow-empty');
      const summary = await getRepoSummary(dir);
      expect(summary.ahead).toBe(1);
      expect(summary.behind).toBe(0);
    });

    it('behind upstream', async () => {
      clone = mkdtempSync(join(tmpdir(), 'cez-git-summary-clone-'));
      g(tmpdir(), 'clone', '-q', remote, clone);
      g(clone, '-c', 'user.email=t@test', '-c', 'user.name=t', 'commit', '-q', '-m', 'remote-only', '--allow-empty');
      g(clone, 'push', '-q');
      g(dir, 'fetch', '-q');

      const summary = await getRepoSummary(dir);
      expect(summary.ahead).toBe(0);
      expect(summary.behind).toBe(1);
    });

    it('ahead and behind (diverged)', async () => {
      clone = mkdtempSync(join(tmpdir(), 'cez-git-summary-clone2-'));
      g(tmpdir(), 'clone', '-q', remote, clone);
      g(clone, '-c', 'user.email=t@test', '-c', 'user.name=t', 'commit', '-q', '-m', 'remote-only', '--allow-empty');
      g(clone, 'push', '-q');
      g(dir, '-c', 'user.email=t@test', '-c', 'user.name=t', 'commit', '-q', '-m', 'local-only', '--allow-empty');
      g(dir, 'fetch', '-q');

      const summary = await getRepoSummary(dir);
      expect(summary.ahead).toBe(1);
      expect(summary.behind).toBe(1);
    });

    it('a gone upstream leaves ahead/behind absent even though upstream is still named', async () => {
      // A bare repo refuses to delete its OWN current branch, so its symbolic HEAD is retargeted
      // first — `main` still exists as a ref at this point, so nothing else in this describe
      // block (which clones from `remote` while HEAD is untouched) is affected.
      g(remote, 'symbolic-ref', 'HEAD', 'refs/heads/unused');
      g(dir, 'push', '-q', 'origin', '--delete', 'main');
      const summary = await getRepoSummary(dir);
      expect(summary.upstream).toBe('origin/main');
      expect(summary.ahead).toBeUndefined();
      expect(summary.behind).toBeUndefined();
    });
  });
});
