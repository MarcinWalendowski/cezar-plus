import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_REPOS, PRUNED_DIRS, scanNestedRepos } from './nested-repos.ts';

/**
 * The walk behind `GET /api/v1/projects/scan` (spec
 * `.ai/specs/2026-08-14-nested-repos-as-projects.md`, phase 2).
 *
 * Real directories in a temp tree rather than a mocked `fs`: every rule under test is about what is
 * ON DISK — a `.git` that is a file vs a directory, a symlink, a prune name — and a fake that
 * answers those from a fixture would be agreeing with itself. Nothing here spawns git; `branch` and
 * `forge` come from `enrichNestedRepos`, which is deliberately a separate function.
 */

const roots: string[] = [];

function tree(): string {
  const root = mkdtempSync(join(tmpdir(), 'cez-scan-'));
  roots.push(root);
  return root;
}

/** A repo is a directory with a `.git` ENTRY — that is the whole rule the walk applies. */
function repo(...segments: string[]): string {
  const dir = join(...segments);
  mkdirSync(join(dir, '.git'), { recursive: true });
  return dir;
}

/** The linked-worktree / submodule spelling: `.git` is a FILE pointing elsewhere. */
function repoWithGitFile(...segments: string[]): string {
  const dir = join(...segments);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n');
  return dir;
}

function plain(...segments: string[]): string {
  const dir = join(...segments);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const relPaths = async (root: string): Promise<string[]> =>
  (await scanNestedRepos(root)).repos.map((r) => r.relPath).sort();

afterEach(() => {
  roots.length = 0;
});

describe('scanNestedRepos', () => {
  it('finds each nested repo once, with its own name and relative path', async () => {
    const root = tree();
    repo(root, 'chat');
    repo(root, 'cezar');
    repoWithGitFile(root, 'bubble-trade');

    const scan = await scanNestedRepos(root);

    expect(scan.repos.map((r) => r.relPath).sort()).toEqual(['bubble-trade', 'cezar', 'chat'])
    expect(scan.repos.map((r) => r.name).sort()).toEqual(['bubble-trade', 'cezar', 'chat']);
    expect(scan.truncated).toBe(false);
    // Absolute paths, so the register call needs nothing rebuilt client-side.
    for (const found of scan.repos) expect(found.path).toBe(join(root, found.relPath));
    // No branch/forge from the WALK — that is `enrichNestedRepos`' job, and a walk that invented
    // them would be shelling out to git 25 times before the user has decided anything.
    expect(scan.repos.every((r) => r.branch === undefined && r.forge === undefined)).toBe(true);
  });

  it('never offers the scanned folder itself, even when it is a repo', async () => {
    const root = tree();
    mkdirSync(join(root, '.git'), { recursive: true });
    repo(root, 'chat');

    expect(await relPaths(root)).toEqual(['chat']);
  });

  /**
   * NEGATIVE CONTROL 1 (spec Verification): a plain directory inside a repo must not be offered.
   *
   * This is the control for `getRepoInfo`'s upward walk. `git rev-parse --show-toplevel` run inside
   * `brand/` answers with the OUTER repo, so a discovery keyed on that would report `brand` as a
   * repo — right branch, right remote, wrong repo, no error anywhere. Keyed on `.git`, it cannot.
   */
  it('does not offer a plain directory that merely sits inside a repo', async () => {
    const root = tree();
    mkdirSync(join(root, '.git'), { recursive: true });
    plain(root, 'brand');
    plain(root, 'brand', 'logos');

    expect(await relPaths(root)).toEqual([]);
  });

  /** NEGATIVE CONTROL 2: a repo inside a repo (submodule / vendored checkout) is part of the outer
   *  repo, not a sibling project — so the outer appears and the inner does not. */
  it('does not descend into a repo it already found', async () => {
    const root = tree();
    repo(root, 'chat');
    repo(root, 'chat', 'vendored');
    repo(root, 'chat', 'deep', 'nested');

    expect(await relPaths(root)).toEqual(['chat']);
  });

  /** NEGATIVE CONTROL 3: `registerFolder` refuses a cezar task worktree, so a row for one could
   *  never be added — it must not be offered at any depth. */
  it('never offers a cezar task worktree', async () => {
    const root = tree();
    repo(root, 'chat');
    repo(root, '.ai', 'cezar', 'worktrees', 'run-1');
    plain(root, 'apps');
    repo(root, 'apps', '.ai', 'cezar', 'worktrees', 'run-2');

    expect(await relPaths(root)).toEqual(['chat']);
  });

  /** NEGATIVE CONTROL 3b: Claude Code's agent worktrees. Unlike cezar's own, `registerFolder`
   *  does NOT refuse these, so nothing downstream catches them — and the dialog pre-checks every
   *  addable row. Measured on one real workspace folder: ten genuine repos and six of these, each a linked
   *  worktree of a repo already in the list. */
  it('never offers a Claude Code agent worktree', async () => {
    const root = tree();
    repo(root, 'chat');
    repoWithGitFile(root, '.claude', 'worktrees', 'sunny-riding-cat');
    repoWithGitFile(root, '.claude', 'worktrees', 'playful-rolling-dove');
    plain(root, 'apps');
    repoWithGitFile(root, 'apps', '.claude', 'worktrees', 'precious-hatching-bengio');

    expect(await relPaths(root)).toEqual(['chat']);
  });

  /** POSITIVE CONTROL for the pair above: the marker is `.claude/worktrees/`, not `.claude`. A
   *  repo that merely lives under a `.claude` directory is still a repo, so pruning the whole
   *  directory would be a wider rule than the reason for it. */
  it('still offers a repo under .claude that is not a worktree', async () => {
    const root = tree();
    repo(root, '.claude', 'skills-repo');

    expect(await relPaths(root)).toEqual(['.claude/skills-repo']);
  });

  /** NEGATIVE CONTROL 4: the cap is a real ceiling AND it says so. A silently short list reads as
   *  "there is nothing else in there". */
  it('caps the list and reports the truncation', async () => {
    const root = tree();
    for (let i = 0; i < MAX_REPOS + 1; i += 1) repo(root, `repo-${String(i).padStart(2, '0')}`);

    const scan = await scanNestedRepos(root);

    expect(scan.repos).toHaveLength(MAX_REPOS);
    expect(scan.truncated).toBe(true);
  });

  it('reports no truncation at exactly the cap', async () => {
    const root = tree();
    for (let i = 0; i < MAX_REPOS; i += 1) repo(root, `repo-${String(i).padStart(2, '0')}`);

    const scan = await scanNestedRepos(root);

    expect(scan.repos).toHaveLength(MAX_REPOS);
    expect(scan.truncated).toBe(false);
  });

  it('walks three levels down and stops', async () => {
    const root = tree();
    repo(root, 'a');
    repo(root, 'x', 'b');
    repo(root, 'x', 'y', 'c');
    repo(root, 'x', 'y', 'z', 'too-deep');

    expect(await relPaths(root)).toEqual(['a', 'x/b', 'x/y/c']);
  });

  it('never descends into a pruned directory', async () => {
    const root = tree();
    for (const pruned of PRUNED_DIRS) repo(root, pruned, 'inner');
    repo(root, 'real');

    expect(await relPaths(root)).toEqual(['real']);
  });

  it('is empty, not an error, for a folder with nothing in it', async () => {
    expect(await scanNestedRepos(tree())).toEqual({ repos: [], truncated: false });
  });

  it('degrades to an empty list for a folder that is not there', async () => {
    expect(await scanNestedRepos(join(tree(), 'gone'))).toEqual({ repos: [], truncated: false });
  });
});
