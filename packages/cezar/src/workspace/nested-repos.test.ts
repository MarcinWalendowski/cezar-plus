import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { enrichNestedRepos, MAX_REPOS, PRUNED_DIRS, scanNestedRepos } from './nested-repos.ts';

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
   *  never be added — it must not be offered at any depth.
   *
   *  `apps` IS offered, as a folder row: it is a plain immediate child with no discovered repo
   *  beneath it (2026-08-15 D1), and the worktree under it is exactly the thing that was not
   *  discovered. The assertion is on the worktrees' absence, which is what this control is about. */
  it('never offers a cezar task worktree', async () => {
    const root = tree();
    repo(root, 'chat');
    repo(root, '.ai', 'cezar', 'worktrees', 'run-1');
    plain(root, 'apps');
    repo(root, 'apps', '.ai', 'cezar', 'worktrees', 'run-2');

    expect(await relPaths(root)).toEqual(['apps', 'chat']);
    expect((await relPaths(root)).some((p) => p.includes('worktrees'))).toBe(false);
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

    // `apps` is a folder row (see the cezar-worktree control above); `.claude` is not, because a
    // dot-directory is tool state, never a project.
    expect(await relPaths(root)).toEqual(['apps', 'chat']);
    expect((await relPaths(root)).some((p) => p.includes('worktrees'))).toBe(false);
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

/**
 * The folder rows (`.ai/specs/2026-08-15-import-all-folders-as-projects.md`, D1/D3).
 *
 * The mutation each guard is written against is named on the test, because "a folder is offered"
 * and "a folder is offered ONLY when it is not a container" are two different features and only the
 * second one is the one that was decided.
 */
describe('scanNestedRepos — non-git folders', () => {
  it('offers a plain immediate child as its own row, marked as not a repo', async () => {
    const root = tree();
    repo(root, 'chat');
    plain(root, 'brand');

    const scan = await scanNestedRepos(root);

    expect(scan.repos.map((r) => `${r.relPath}:${String(r.isRepo)}`)).toEqual([
      'chat:true',
      'brand:false',
    ]);
    // The row is addable as-is: absolute path, and a name to register under.
    expect(scan.repos[1]).toMatchObject({ path: join(root, 'brand'), name: 'brand' });
    // `hasCommits` is a REPO fact. A folder row carrying one would be answering a question about
    // a repository that does not exist.
    expect(scan.repos[1]?.hasCommits).toBeUndefined();
  });

  /**
   * THE guard of this feature. Mutation: drop the "no discovered repo beneath it" filter and this
   * fails — `code` reappears as a sixth project that owns the five inside it.
   */
  it('does not offer a container folder that holds discovered repos', async () => {
    const root = tree();
    plain(root, 'code');
    repo(root, 'code', 'one');
    repo(root, 'code', 'two');
    plain(root, 'notes');

    expect(await relPaths(root)).toEqual(['code/one', 'code/two', 'notes']);
  });

  /** A container whose only repos were PRUNED away is not a container — nothing was discovered
   *  beneath it, so the row is honest about what the walk knows. */
  it('offers a folder whose only repos live in a pruned directory', async () => {
    const root = tree();
    plain(root, 'app');
    repo(root, 'app', 'node_modules', 'vendored-pkg');

    expect(await relPaths(root)).toEqual(['app']);
  });

  /** Mutation: apply `PRUNED_DIRS`/`WORKTREE_MARKERS` to repos only. Every one of these would then
   *  become a checkbox, pre-checked (D2), in a dialog that registers what is checked. */
  it('never offers a pruned directory, a dot-directory or a worktree as a folder row', async () => {
    const root = tree();
    // `.git` is skipped ON PURPOSE: creating it here would make the scanned folder itself a repo,
    // and the empty result would then be the `rootIsRepo` rule passing, not the prune list.
    for (const pruned of PRUNED_DIRS) if (pruned !== '.git') plain(root, pruned);
    plain(root, '.vscode');
    plain(root, '.claude', 'worktrees', 'sunny-riding-cat');
    plain(root, 'real-work');

    expect(await relPaths(root)).toEqual(['real-work']);
  });

  /**
   * NEGATIVE CONTROL 1, extended: inside a CHECKOUT there are no projects, only directories.
   *
   * Measured 2026-08-15 on the three real checkouts in this workspace — relaxing this rule offers
   * `domains`, `infra`, `packages`, `tools` for one of them and `src`, `test`, `docs` for another,
   * pre-checked, in a dialog that registers what is checked.
   */
  it('offers no folder rows for a repo that holds no other repos', async () => {
    const root = tree();
    mkdirSync(join(root, '.git'), { recursive: true });
    plain(root, 'src');
    plain(root, 'docs');

    expect(await relPaths(root)).toEqual([]);
  });

  /**
   * …and the other half, which is the feature's own motivating case: a workspace folder that
   * happens to be tracked (a directory of checkouts with a couple of doctrine files committed at
   * the top). The workspace this feature was built for is exactly that shape — ten nested repos
   * plus a handful of plain folders that had no way in before this spec.
   *
   * Mutation: gate folder rows on `rootIsRepo` alone and this fails — the feature then misses the
   * folder it was built for.
   */
  it('offers folder rows for a tracked workspace that holds nested repos', async () => {
    const root = tree();
    mkdirSync(join(root, '.git'), { recursive: true });
    repo(root, 'chat');
    repo(root, 'cezar');
    plain(root, 'brand');

    expect(await relPaths(root)).toEqual(['brand', 'cezar', 'chat']);
  });

  /** D3: repos fill the cap first. Mutation: interleave the two kinds, and a folder row displaces a
   *  repo — the row with the strongest evidence of being a unit of work loses to one without. */
  it('fills the cap with repos before folders, and reports the truncation', async () => {
    const root = tree();
    for (let i = 0; i < MAX_REPOS - 1; i += 1) repo(root, `repo-${String(i).padStart(2, '0')}`);
    for (const name of ['aaa-folder', 'bbb-folder', 'ccc-folder']) plain(root, name);

    const scan = await scanNestedRepos(root);

    expect(scan.repos).toHaveLength(MAX_REPOS);
    expect(scan.repos.filter((r) => r.isRepo)).toHaveLength(MAX_REPOS - 1);
    // Alphabetical among folders, so which one survives the cap does not depend on inode order.
    expect(scan.repos.at(-1)).toMatchObject({ relPath: 'aaa-folder', isRepo: false });
    expect(scan.truncated).toBe(true);
  });

  /** The corollary that makes D1's filter safe: a truncated REPO list leaves no folder budget, so
   *  the "no repo beneath" test is never evaluated against an incomplete list of repos. */
  it('offers no folder rows once the repo cap has bitten', async () => {
    const root = tree();
    for (let i = 0; i < MAX_REPOS + 1; i += 1) repo(root, `repo-${String(i).padStart(2, '0')}`);
    plain(root, 'zzz-folder');

    const scan = await scanNestedRepos(root);

    expect(scan.repos.every((r) => r.isRepo)).toBe(true);
    expect(scan.truncated).toBe(true);
  });
});

describe('enrichNestedRepos', () => {
  /** A folder row must not be handed to `getRepoInfo`, which walks UPWARD: run inside a plain
   *  directory under a repo it answers with the ANCESTOR's branch and remote, so the row would
   *  render a branch that is not its own. Asserted by the absence of every git-derived key. */
  it('spawns no git for a folder row and leaves it exactly as walked', async () => {
    const root = tree();
    const folder = { path: plain(root, 'brand'), relPath: 'brand', name: 'brand', isRepo: false };

    const [enriched] = await enrichNestedRepos([folder]);

    expect(enriched).toEqual(folder);
    expect(enriched && 'hasCommits' in enriched).toBe(false);
  });
});
